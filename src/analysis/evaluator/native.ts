import _generate from '@babel/generator';
import * as t from '@babel/types';
import { staticStringTable } from '../../util/ast.js';
import { exceedsNodeBudget, type SliceResult } from '../slice.js';
import { globalNames } from './builtins.js';
import { invocation } from './callee.js';
import { GLOBAL_OBJECT_FALLBACKS, isGlobalObjectRead } from './global-object.js';
import { createInterpreter } from './interpreter.js';
import { MAX_REGEX_WORK, readRegexCost, regexWork } from './regex-cost.js';

const generate = ((_generate as unknown as { default?: typeof _generate }).default ??
  _generate) as typeof _generate;

/**
 * Tier 1: recognise a known decoder algorithm from the AST and run a native
 * implementation of it.
 *
 * Nothing here executes or interprets the input. A recogniser reads the shape of
 * the decoder - node kinds, operator sequences, constant values - decides which
 * published algorithm it is, and hands back a closure over that implementation.
 * That is roughly three orders of magnitude faster than stepping an interpreter,
 * and it is safe against hostile input by construction.
 *
 * The one rule every recogniser obeys: **return null rather than guess**. A
 * decoder this tier refuses falls through to the interpreter tier, which is slow
 * but general. A decoder it handles *wrongly* produces plausible-looking
 * garbage that no user can detect, which is the worst outcome this tool has.
 * So recognition keys on structure and constants only - never on identifier
 * names, which obfuscators randomise on every run.
 */

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type NativeAlgorithm =
  | 'plain'
  | 'base64'
  | 'rc4'
  | 'xor'
  | 'caesar'
  | 'rot'
  /**
   * A run of characters cut out of one long encoded blob and unpacked through a
   * custom alphabet, `basE91`-style. Call sites pass an offset and a length
   * rather than a table index, so there is no array of strings anywhere.
   */
  | 'bit-pack';

export interface NativeDecoder {
  /** How call sites reach it: `A[3]` versus `_0x123b(0x2bd3)`. */
  kind: 'array-index' | 'wrapper-call';
  algorithm: NativeAlgorithm;
  /** Binding name call sites use. */
  name: string;
  /** Constant subtracted from the raw index, e.g. obfuscator.io's `- 0x1a4`. */
  offset: number;
  /** Left-rotations the rotation IIFE would have applied to the array. */
  rotation: number;
  /** The string array after rotation, in decode order. */
  values: readonly string[];
  /** Human-readable justification, surfaced as diagnostic evidence. */
  evidence: string;
  /**
   * What the recogniser read, for the caller's `unmodelledLoop` and its
   * judgement of where a budget went: the subtrees every loop of which the
   * shape accounts for (the decoder's own function, the blob unpacker), the
   * loop statements it accounts for on their own without vouching for
   * anything nested in them (the rotation loop, whose checksum it solved as
   * arithmetic), and the functions it read as callees without vouching for
   * their loops (the accessor and its replacement, the forwarders).
   */
  modelled: ModelledCode;
  /** The rotation loop's checksum solved as arithmetic, when that is where `rotation` came from. */
  solvedRotation?: SolvedRotation;
  decode(args: readonly (string | number)[]): string | undefined;
}

/**
 * What the arithmetic solution of a rotation loop rests on, for a caller
 * that runs the slice with the loop stood in for by its solution: every
 * turn of `while (!![]) { try { ... } catch { x.push(x.shift()) } }` decodes
 * one string per checksum term, and the turns to the solution are a budget
 * the interpreter is not given - obfuscated2.js takes 478 of them over 11
 * terms of rc4, the chained-wrapper builds hundreds over a dozen.
 */
export interface SolvedRotation {
  loop: t.Loop;
  shifts: number;
  /** The decoder's own arguments the checksum evaluates at the solution, forwarders resolved. */
  terms: readonly (readonly (string | number)[])[];
  /** The loop's `x.push(x.shift())`, which run `shifts` times is what the loop does to the table. */
  shuffle: t.CallExpression;
}

export interface ModelledCode {
  subtrees: readonly t.Node[];
  loops: readonly t.Node[];
  /**
   * Functions the shape calls and read as straight-line: a frame of one
   * under a modelled loop is the shape's, a frame of anything else under a
   * modelled subtree is not - a recursion, a callback, a helper the
   * recogniser never opened - and a budget spent there is not the loop's.
   */
  callees: readonly t.Function[];
}

const NOTHING_MODELLED: ModelledCode = { subtrees: [], loops: [], callees: [] };

// ---------------------------------------------------------------------------
// Pure algorithm implementations
//
// Exported individually because they are the part most worth unit-testing in
// isolation: a bug here is a wrong string, not a missed decode.
// ---------------------------------------------------------------------------

export const STANDARD_BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 to bytes under an arbitrary 64-character alphabet.
 *
 * Returns bytes rather than a string because the two encoders that matter here
 * disagree on what happens next: obfuscator.io UTF-8 decodes them, a plain
 * `atob` shim treats each byte as a code unit.
 */
export function base64ToBytes(input: string, alphabet: string): Uint8Array | undefined {
  if (alphabet.length < 64) return undefined;
  const lookup = new Map<string, number>();
  for (let i = 0; i < 64; i++) lookup.set(alphabet[i]!, i);

  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of input) {
    const value = lookup.get(char);
    if (value === undefined) {
      // `=` padding and stray whitespace are skipped; anything else means the
      // payload does not belong to this alphabet.
      if (char === '=' || char === '\n' || char === '\r' || char === ' ') continue;
      return undefined;
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Strict UTF-8 decode, matching what `decodeURIComponent('%xx%xx...')` does in the
 * generated decoders - including throwing (here: returning undefined) on an
 * invalid sequence, which is the signal that a rotation guess was wrong.
 */
export function bytesToUtf8(bytes: Uint8Array): string | undefined {
  let result = '';
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i]!;
    let codePoint: number;
    let width: number;

    if (first < 0x80) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      width = 4;
    } else {
      return undefined;
    }

    if (i + width > bytes.length) return undefined;
    for (let k = 1; k < width; k++) {
      const continuation = bytes[i + k]!;
      if ((continuation & 0xc0) !== 0x80) return undefined;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    // Reject overlong forms, surrogates and out-of-range code points, all of
    // which decodeURIComponent also rejects.
    if (width === 3 && (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff))) {
      return undefined;
    }
    if (width === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff)) return undefined;

    result += String.fromCodePoint(codePoint);
    i += width;
  }
  return result;
}

/** Each byte becomes one code unit, which is what a bare `atob` yields. */
export function bytesToLatin1(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]!);
  return result;
}

/**
 * RC4 exactly as obfuscator.io emits it: 256-byte KSA keyed by the char codes of
 * `key`, then PRGA XORed against the char codes of `data`.
 *
 * `data` is the *UTF-8 decoded* payload, not raw bytes - the generated decoder
 * runs its base64 output through `decodeURIComponent` before the cipher, and
 * feeding it bytes instead silently corrupts every non-ASCII string.
 */
export function rc4(data: string, key: string): string {
  if (key.length === 0) return data;

  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i++) state[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key.charCodeAt(i % key.length)) % 256;
    const swap = state[i]!;
    state[i] = state[j]!;
    state[j] = swap;
  }

  let a = 0;
  let b = 0;
  let result = '';
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) % 256;
    b = (b + state[a]!) % 256;
    const swap = state[a]!;
    state[a] = state[b]!;
    state[b] = swap;
    result += String.fromCharCode(data.charCodeAt(k) ^ state[(state[a]! + state[b]!) % 256]!);
  }
  return result;
}

/** Repeating-key XOR over char codes. */
export function xorWithKey(data: string, key: string): string {
  if (key.length === 0) return data;
  let result = '';
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

/** Single-constant XOR over char codes. */
export function xorWithCode(data: string, code: number): string {
  let result = '';
  for (let i = 0; i < data.length; i++) result += String.fromCharCode(data.charCodeAt(i) ^ code);
  return result;
}

/** Unconditional char-code shift - the naive "Caesar" an obfuscator emits. */
export function shiftChars(data: string, delta: number): string {
  let result = '';
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode((data.charCodeAt(i) + delta) & 0xffff);
  }
  return result;
}

/** ROT-n over ASCII letters only, leaving every other character untouched. */
export function rotateLetters(data: string, shift: number): string {
  const amount = ((shift % 26) + 26) % 26;
  let result = '';
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code >= 65 && code <= 90) result += String.fromCharCode(((code - 65 + amount) % 26) + 65);
    else if (code >= 97 && code <= 122)
      result += String.fromCharCode(((code - 97 + amount) % 26) + 97);
    else result += data[i];
  }
  return result;
}

/** `by` applications of `push(shift())`: element `i` becomes original `i + by`. */
export function rotateArray<T>(values: readonly T[], by: number): T[] {
  const length = values.length;
  if (length === 0) return [];
  const shift = ((by % length) + length) % length;
  const result = new Array<T>(length);
  for (let i = 0; i < length; i++) result[i] = values[(i + shift) % length]!;
  return result;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Iterative subtree walk; avoids Babel traversal overhead on small slices. */
export function eachNode(root: t.Node, visit: (node: t.Node) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    visit(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
}

/**
 * A TypeScript (or Flow) wrapper that erases to its operand at run time:
 * `x as T`, `x!`, `<T>x`, `x satisfies T`, `f<T>`, `(x: T)`.
 */
function isTypeWrapper(
  node: t.Node,
): node is
  | t.TSAsExpression
  | t.TSNonNullExpression
  | t.TSTypeAssertion
  | t.TSSatisfiesExpression
  | t.TSInstantiationExpression
  | t.TypeCastExpression {
  switch (node.type) {
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'TSSatisfiesExpression':
    case 'TSInstantiationExpression':
    case 'TypeCastExpression':
      return true;
    default:
      return false;
  }
}

/**
 * Strip type-level wrappers out of a slice, in place, so every recogniser sees
 * the program the runtime sees.
 *
 * Every test below is a shape test on node kinds, and a wrapper is a node kind:
 * `a['push'](a['shift']() as string)` is a `push` call whose argument is a
 * `TSAsExpression`, not a `shift` call, so the rotation loop it belongs to is
 * simply not there - and a table decoded at rotation zero maps every call site
 * to a real string from the wrong slot. Erasing once up front is both cheaper
 * and safer than teaching each of several dozen shape tests to look through
 * a wrapper, because a test that forgets is a wrong answer, not a refusal.
 *
 * The statements are the slice's own deep clones, never the program's tree.
 */
export function eraseTypeWrappers(statements: readonly t.Statement[]): void {
  const unwrap = (node: t.Node): t.Node => {
    let current = node;
    while (isTypeWrapper(current)) current = current.expression;
    return current;
  };

  const stack: t.Node[] = [...statements];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const record = node as unknown as Record<string, unknown>;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = record[key];
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index++) {
          const item = child[index] as t.Node | null;
          if (!item || typeof item.type !== 'string') continue;
          const bare = unwrap(item);
          child[index] = bare;
          stack.push(bare);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        const bare = unwrap(child as t.Node);
        record[key] = bare;
        stack.push(bare);
      }
    }
  }
}

/**
 * Fold a subtree whose every leaf is a numeric literal.
 *
 * Recognition keys on constants - `% 256`, an index offset, a rotation target -
 * and `numbersToExpressions` rewrites every one of them as arithmetic
 * (`0x35 * -0x67 + -0x1325 + 0x2993` for `283`). `prepare.fold-numbers` normally
 * collapses those before any analysis runs, but a recogniser that only accepts a
 * bare literal silently fails whenever it is called on an unfolded tree - from a
 * test, from another pass, or from a pipeline configured without that pass. So
 * every constant read below goes through here rather than through a type check.
 */
export function constantNumber(node: t.Node | null | undefined): number | undefined {
  if (!node) return undefined;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isParenthesizedExpression(node)) return constantNumber(node.expression);

  if (t.isUnaryExpression(node)) {
    const argument = constantNumber(node.argument);
    if (argument === undefined) return undefined;
    switch (node.operator) {
      case '-':
        return -argument;
      case '+':
        return argument;
      case '~':
        return ~argument;
      default:
        return undefined;
    }
  }

  if (t.isBinaryExpression(node)) {
    if (!t.isExpression(node.left)) return undefined;
    const left = constantNumber(node.left);
    if (left === undefined) return undefined;
    const right = constantNumber(node.right);
    if (right === undefined) return undefined;
    const value = applyNumericOperator(node.operator, left, right);
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  }

  return undefined;
}

function applyNumericOperator(operator: string, left: number, right: number): number | undefined {
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return left / right;
    case '%':
      return left % right;
    case '**':
      return left ** right;
    case '&':
      return left & right;
    case '|':
      return left | right;
    case '^':
      return left ^ right;
    case '<<':
      return left << right;
    case '>>':
      return left >> right;
    case '>>>':
      return left >>> right;
    default:
      return undefined;
  }
}

/** The name of a member's property, whether written `.x` or `['x']`. */
function propertyName(node: t.MemberExpression): string | undefined {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (node.computed && t.isStringLiteral(node.property)) return node.property.value;
  return undefined;
}

function isMemberCall(node: t.Node, name: string): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    propertyName(node.callee) === name
  );
}

function functionOf(node: t.Node | null | undefined): t.Function | undefined {
  if (!node) return undefined;
  if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    return node;
  }
  return undefined;
}

function paramName(fn: t.Function, index: number): string | undefined {
  const param = fn.params[index];
  return param && t.isIdentifier(param) ? param.name : undefined;
}

/**
 * obfuscator.io decoders overwrite themselves on first call:
 * `function d(a,b){ ...; d = function(x,y){ /* the real body *\/ }; return d(a,b); }`
 * Everything worth recognising lives in the replacement, so follow it.
 */
function unwrapSelfReplacing(fn: t.Function, name: string): t.Function {
  const chain = selfReplacements(fn, name);
  return chain[chain.length - 1]!;
}

/** `fn` and each function it hands its own name to in turn, first to last. */
function selfReplacements(fn: t.Function, name: string): t.Function[] {
  const chain = [fn];
  let current = fn;
  for (let depth = 0; depth < 4; depth++) {
    let replacement: t.Function | undefined;
    eachNode(current.body, (node) => {
      if (replacement) return;
      if (!t.isAssignmentExpression(node) || node.operator !== '=') return;
      if (!t.isIdentifier(node.left, { name })) return;
      replacement = functionOf(node.right);
    });
    if (!replacement || replacement === current) break;
    chain.push(replacement);
    current = replacement;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Argument forwarders (obfuscator.io's "string array wrappers")
// ---------------------------------------------------------------------------

/**
 * A function that exists only to call another one with rearranged arguments:
 * `function w(a, b, c, d) { return dec(b - -0xf5, c); }`.
 *
 * `stringArrayWrappersType: 'function'` emits these by the dozen, with up to
 * five parameters, in a permuted order, each index adjusted by its own constant,
 * and - with `stringArrayWrappersChainedCalls` - forwarding to *another* wrapper
 * rather than straight to the decoder. Crucially the rotation IIFE declares its
 * own private pair of them and drives the checksum entirely through those, so a
 * recogniser that cannot see through a wrapper cannot solve the rotation and
 * therefore cannot decode a single string.
 */
export interface ArgumentForwarder {
  name: string;
  params: readonly string[];
  /** The name it forwards to: another forwarder, or the decoder itself. */
  callee: string;
  /** Argument expressions, kept as AST because the arithmetic varies per call. */
  args: readonly t.Expression[];
  /** The function itself, so a caller can prove a binding really denotes this one. */
  fn: t.Function;
}

/** obfuscator.io caps wrapper parameters at five; allow a little headroom. */
const MAX_FORWARDER_PARAMS = 8;

/** Chained wrappers nest a handful deep at most; the cap only stops a cycle. */
const MAX_FORWARDER_DEPTH = 8;

/**
 * Every argument forwarder declared anywhere inside `roots`, by name.
 *
 * The search is deep rather than top-level because the wrappers that matter most
 * are *not* top-level: the rotation IIFE declares its own inside its body, and
 * every obfuscated function declares a few more of its own.
 *
 * A name declared twice with two different bodies is dropped rather than
 * resolved: with no scope information here, guessing which one a call site meant
 * would silently produce arguments the program never passes.
 */
export function collectArgumentForwarders(
  roots: readonly t.Node[],
): Map<string, ArgumentForwarder> {
  const found = new Map<string, ArgumentForwarder>();
  const ambiguous = new Set<string>();

  const consider = (name: string, fn: t.Function | undefined): void => {
    if (!fn) return;
    const forwarder = asForwarder(name, fn);
    if (!forwarder) return;
    const existing = found.get(name);
    if (existing && existing.fn !== fn) {
      ambiguous.add(name);
      return;
    }
    found.set(name, forwarder);
  };

  for (const root of roots) {
    eachNode(root, (node) => {
      if (t.isFunctionDeclaration(node) && node.id) {
        consider(node.id.name, node);
      } else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
        consider(node.id.name, functionOf(node.init));
      }
    });
  }

  for (const name of ambiguous) found.delete(name);
  return found;
}

function asForwarder(name: string, fn: t.Function): ArgumentForwarder | null {
  if (fn.params.length === 0 || fn.params.length > MAX_FORWARDER_PARAMS) return null;

  const params: string[] = [];
  for (const param of fn.params) {
    if (!t.isIdentifier(param)) return null;
    params.push(param.name);
  }

  const call = forwardedCall(fn);
  if (!call || !t.isIdentifier(call.callee)) return null;
  // Forwarding to itself is a recursive decoder, not a wrapper; forwarding to a
  // parameter means the target is chosen by the caller and is not knowable here.
  if (call.callee.name === name || params.includes(call.callee.name)) return null;

  const args: t.Expression[] = [];
  for (const argument of call.arguments) {
    if (!t.isExpression(argument) || !isArithmeticOverParams(argument, params)) return null;
    args.push(argument);
  }
  if (args.length === 0) return null;

  return { name, params, callee: call.callee.name, args, fn };
}

/**
 * The single call a forwarder returns.
 *
 * Sibling function *declarations* are skipped rather than disqualifying: they
 * are hoisted and cannot run, and obfuscator.io routinely parks another wrapper
 * next to the return statement inside the same body.
 */
function forwardedCall(fn: t.Function): t.CallExpression | undefined {
  const body = fn.body;
  if (t.isCallExpression(body)) return body;
  if (!t.isBlockStatement(body)) return undefined;

  let call: t.CallExpression | undefined;
  for (const statement of body.body) {
    if (t.isFunctionDeclaration(statement)) continue;
    if (call) return undefined;
    if (!t.isReturnStatement(statement) || !t.isCallExpression(statement.argument)) {
      return undefined;
    }
    call = statement.argument;
  }
  return call;
}

/**
 * Whether an expression is pure arithmetic over the forwarder's own parameters.
 *
 * Anything else - a member access, a call, a name from an enclosing scope -
 * means the argument is not determined by the call site alone, and an argument
 * that cannot be determined is one that must not be guessed.
 */
function isArithmeticOverParams(node: t.Expression, params: readonly string[]): boolean {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) return true;
  if (t.isIdentifier(node)) return params.includes(node.name);
  if (t.isParenthesizedExpression(node)) return isArithmeticOverParams(node.expression, params);
  if (t.isUnaryExpression(node)) {
    return FORWARDER_UNARY.has(node.operator) && isArithmeticOverParams(node.argument, params);
  }
  if (t.isBinaryExpression(node)) {
    if (!FORWARDER_BINARY.has(node.operator)) return false;
    if (!t.isExpression(node.left)) return false;
    return isArithmeticOverParams(node.left, params) && isArithmeticOverParams(node.right, params);
  }
  return false;
}

const FORWARDER_UNARY = new Set(['-', '+', '~']);
const FORWARDER_BINARY = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>']);

/** Evaluate one forwarded argument against the values bound to the parameters. */
function evaluateForwardedArgument(
  node: t.Expression,
  environment: ReadonlyMap<string, string | number>,
): string | number | undefined {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return environment.get(node.name);
  if (t.isParenthesizedExpression(node)) {
    return evaluateForwardedArgument(node.expression, environment);
  }

  if (t.isUnaryExpression(node)) {
    const value = evaluateForwardedArgument(node.argument as t.Expression, environment);
    if (value === undefined) return undefined;
    const numeric = Number(value);
    switch (node.operator) {
      case '-':
        return -numeric;
      case '+':
        return numeric;
      case '~':
        return ~numeric;
      default:
        return undefined;
    }
  }

  if (t.isBinaryExpression(node)) {
    if (!t.isExpression(node.left)) return undefined;
    const left = evaluateForwardedArgument(node.left, environment);
    const right = evaluateForwardedArgument(node.right, environment);
    if (left === undefined || right === undefined) return undefined;
    // `+` is the one operator that means two different things here: the index
    // arithmetic obfuscator.io emits, and string concatenation of an RC4 key.
    if (node.operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
      return `${left}${right}`;
    }
    // Everything else coerces, exactly as the program would. `'BvqA' - 0x85` is
    // NaN, not "unknown": a wrapper routinely computes an argument the decoder
    // never reads, and refusing on it would drop a decodable call site.
    return applyNumericOperator(node.operator, Number(left), Number(right));
  }

  return undefined;
}

/**
 * Follow a chain of forwarders to the call the decoder actually receives.
 *
 * `stop` decides where the chain ends - normally "this name is the decoder".
 * Returns undefined rather than a best guess whenever a link is missing or an
 * argument does not evaluate, because a wrong index is a wrong string.
 */
export function resolveForwardedCall(
  name: string,
  args: readonly (string | number)[],
  forwarders: ReadonlyMap<string, ArgumentForwarder>,
  stop: (name: string) => boolean,
): { name: string; args: (string | number)[] } | undefined {
  let currentName = name;
  let currentArgs: (string | number)[] = [...args];

  for (let depth = 0; depth <= MAX_FORWARDER_DEPTH; depth++) {
    if (stop(currentName)) return { name: currentName, args: currentArgs };

    const forwarder = forwarders.get(currentName);
    if (!forwarder) return undefined;

    const environment = new Map<string, string | number>();
    for (let index = 0; index < forwarder.params.length; index++) {
      const value = currentArgs[index];
      if (value !== undefined) environment.set(forwarder.params[index]!, value);
    }

    const mapped: (string | number)[] = [];
    for (const argument of forwarder.args) {
      const value = evaluateForwardedArgument(argument, environment);
      if (value === undefined) return undefined;
      mapped.push(value);
    }

    currentName = forwarder.callee;
    currentArgs = mapped;
  }

  return undefined;
}

/**
 * The entries of a string table written in either spelling.
 *
 * `staticStringTable` is shared with the candidate scan in `string-array.ts` so
 * that "a table" means one thing across the engine: an array of string
 * literals, or the `'a;b;c'.split(';')` form the Cloudflare post-pass rewrites
 * every such array into.
 */
function tableValues(node: t.Node): string[] | undefined {
  const values = staticStringTable(node);
  return values && values.length > 0 ? values : undefined;
}

// ---------------------------------------------------------------------------
// Recogniser (h): a table computed at load
// ---------------------------------------------------------------------------

/*
 * `var T = (function (c, q) { ... shuffle by q ... return k.join('').split('%')
 * ...; })('...', 6120338)` - the table of several older tools, read everywhere as
 * `T[0]`: a call of a function literal, or of a function declared beside it,
 * over literal arguments alone. Its body runs on nothing but its own locals
 * and the allowlisted builtins, so the call is a total, pure computation over
 * literals, and the interpreter is exact on it: what it returns is the
 * table, at every preset. The result is remembered by the call's own text -
 * the tree moves between rounds, and a node is no key to what it once said.
 */

/** Budget for one table computation: the shufflers seen run in tens of thousands of steps. */
const COMPUTED_TABLE_STEPS = 4_000_000;
const COMPUTED_TABLE_MS = 500;
/** A call longer than this is a program, not a table. */
const MAX_COMPUTED_TABLE_SOURCE = 65_536;
const MAX_COMPUTED_TABLE_NODES = 4_000;
/** Remembered computations, by text; emptied past the bound rather than grown. */
const computedTables = new Map<string, string[] | null>();
const MAX_COMPUTED_TABLES = 256;

function computedTableValues(init: t.Node, statements: readonly t.Statement[]): string[] | undefined {
  if (!t.isCallExpression(init) || !init.arguments.every(isLiteralArgument)) return undefined;
  // A shuffler is a few hundred nodes; a module factory called at once is
  // not a table, and is not walked to find that out.
  if (exceedsNodeBudget(init, MAX_COMPUTED_TABLE_NODES)) return undefined;
  let fn = functionOf(init.callee);
  let declaration: t.FunctionDeclaration | undefined;
  if (!fn && t.isIdentifier(init.callee)) {
    const name = init.callee.name;
    const declared = statements.filter((statement): statement is t.FunctionDeclaration => t.isFunctionDeclaration(statement) && statement.id?.name === name);
    // Two declarations of the name: which runs is hoisting's to say, not this reader's.
    if (declared.length !== 1) return undefined;
    declaration = declared[0]!;
    fn = declaration;
  }
  if (!fn || fn.async || fn.generator) return undefined;
  if (t.isBlockStatement(fn.body) && !returnsAValue(fn.body)) return undefined;
  if (!readsOnlyBuiltins(fn)) return undefined;

  const callText = compactText(init);
  const declarationText = declaration ? compactText(declaration) : '';
  if (callText === undefined || declarationText === undefined) return undefined;
  const key = `${declarationText}\n${callText}`;
  if (key.length > MAX_COMPUTED_TABLE_SOURCE) return undefined;
  const remembered = computedTables.get(key);
  if (remembered !== undefined) return remembered ?? undefined;
  if (computedTables.size >= MAX_COMPUTED_TABLES) computedTables.clear();

  const computed = computeTable(init, declaration);
  computedTables.set(key, computed ?? null);
  return computed;
}

/** The interpreter's answer for the call, or nothing: a refusal, a throw, a budget, a value that is no table. */
function computeTable(init: t.CallExpression, declaration: t.FunctionDeclaration | undefined): string[] | undefined {
  const program: t.Statement[] = [];
  if (declaration) program.push(t.cloneNode(declaration, true, true));
  program.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(COMPUTED_TABLE_NAME), t.cloneNode(init, true, true))]));
  let value: unknown;
  try {
    value = createInterpreter(program, { maxSteps: COMPUTED_TABLE_STEPS, timeoutMs: COMPUTED_TABLE_MS }).read(COMPUTED_TABLE_NAME);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    values.push(entry);
  }
  return values;
}

const COMPUTED_TABLE_NAME = '__table';

function isLiteralArgument(node: t.Node): boolean {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return node.expressions.length === 0;
  if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+')) return t.isNumericLiteral(node.argument);
  return false;
}

/**
 * Whether every name the function reads that it does not bind is one of the
 * interpreter's builtins: cheap, and what keeps a module factory or a helper
 * over the program's own names from being run to its first free reference.
 * Names bound anywhere in the function count as its own, which reads a
 * shadowed builtin as bound - the interpreter then runs the program's binding.
 */
function readsOnlyBuiltins(fn: t.Function): boolean {
  const bound = new Set<string>();
  const read = new Set<string>();
  for (const param of fn.params) for (const name of Object.keys(t.getBindingIdentifiers(param))) bound.add(name);
  const stack: { node: t.Node; parent: t.Node | undefined }[] = [{ node: fn.body, parent: fn }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (t.isFunctionDeclaration(node) || t.isVariableDeclarator(node) || t.isClassDeclaration(node) || t.isCatchClause(node)) {
      for (const name of Object.keys(t.getBindingIdentifiers(node))) bound.add(name);
    }
    if (t.isFunction(node)) {
      for (const param of node.params) for (const name of Object.keys(t.getBindingIdentifiers(param))) bound.add(name);
      if ((t.isFunctionExpression(node) || t.isFunctionDeclaration(node)) && node.id) bound.add(node.id.name);
    }
    if (t.isIdentifier(node) && parent !== undefined) {
      const property =
        (t.isMemberExpression(parent) && parent.property === node && !parent.computed) ||
        (t.isOptionalMemberExpression(parent) && parent.property === node && !parent.computed) ||
        ((t.isObjectProperty(parent) || t.isObjectMethod(parent)) && parent.key === node && !parent.computed) ||
        (t.isLabeledStatement(parent) && parent.label === node) ||
        (t.isBreakStatement(parent) || t.isContinueStatement(parent));
      if (!property) read.add(node.name);
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push({ node: item as t.Node, parent: node });
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push({ node: child as t.Node, parent: node });
      }
    }
  }
  for (const name of read) if (!bound.has(name) && !INTERPRETER_GLOBALS.has(name) && name !== 'arguments') return false;
  return true;
}

const INTERPRETER_GLOBALS: ReadonlySet<string> = new Set(globalNames());

function compactText(node: t.Node): string | undefined {
  try {
    return generate(node, { compact: true, comments: false }).code;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Recogniser (a): the string array
// ---------------------------------------------------------------------------

export interface StringArrayRecognition {
  /** Binding the array is reached through. */
  name: string;
  /** True when `name` is a function returning the array, not the array itself. */
  viaFunction: boolean;
  values: string[];
  /** The accessor the values were read out of, when `viaFunction`. */
  fn?: t.Function;
}

/**
 * Find the string array, in any of the three shapes obfuscators emit it:
 * a plain `var A = [...]`, a function returning a literal, or the self-replacing
 * accessor `function A(){ const x = [...]; A = () => x; return A(); }`.
 */
export function recogniseStringArray(
  statements: readonly t.Statement[],
): StringArrayRecognition[] {
  const found: StringArrayRecognition[] = [];

  const fromFunction = (name: string, fn: t.Function): void => {
    let values: string[] | undefined;
    eachNode(fn.body, (node) => {
      if (values) return;
      if (node.type !== 'ArrayExpression' && node.type !== 'CallExpression') return;
      values = tableValues(node);
    });
    if (values) found.push({ name, viaFunction: true, values, fn });
  };

  for (const statement of statements) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      fromFunction(statement.id.name, statement);
      continue;
    }

    if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        if (!t.isIdentifier(declarator.id)) continue;
        const name = declarator.id.name;
        if (declarator.init) {
          const values = tableValues(declarator.init) ?? computedTableValues(declarator.init, statements);
          if (values) {
            found.push({ name, viaFunction: false, values });
            continue;
          }
        }
        const fn = functionOf(declarator.init);
        if (fn) fromFunction(name, fn);
      }
      continue;
    }

    if (t.isExpressionStatement(statement)) {
      const expression = statement.expression;
      if (t.isAssignmentExpression(expression) && t.isIdentifier(expression.left)) {
        const values = tableValues(expression.right);
        if (values) found.push({ name: expression.left.name, viaFunction: false, values });
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Recogniser (a, continued): the index offset
// ---------------------------------------------------------------------------

/**
 * The constant folded into every call site's index. obfuscator.io writes
 * `index = index - 0x1a4` at the top of the decoder; some builds inline it as
 * `array[index - 0x1a4]` instead.
 */
export function recogniseIndexOffset(fn: t.Function): number {
  const { fromAssignment, fromIndexing } = indexOffsetParts(fn);
  return fromAssignment ?? fromIndexing ?? 0;
}

/**
 * Whether the first parameter is moved by an assignment and then indexed
 * past by a constant too - `i = i - 0x100; t[i - 1]`. The offset reads the
 * assignment alone, so the index it stands for is off by the second one;
 * the plain arm's `indexesByParameter` catches that, and the cipher arms,
 * whose bodies index their own state, refuse the shape outright.
 */
function movedTwice(fn: t.Function): boolean {
  const { fromAssignment, fromIndexing } = indexOffsetParts(fn);
  return fromAssignment !== undefined && fromIndexing !== undefined;
}

function indexOffsetParts(fn: t.Function): { fromAssignment?: number; fromIndexing?: number } {
  const param = paramName(fn, 0);
  if (!param) return {};

  let fromAssignment: number | undefined;
  let fromIndexing: number | undefined;

  eachNode(fn.body, (node) => {
    if (t.isAssignmentExpression(node) && t.isIdentifier(node.left, { name: param })) {
      if (node.operator === '-=') {
        const amount = constantNumber(node.right);
        if (amount !== undefined) fromAssignment = (fromAssignment ?? 0) + amount;
        return;
      }
      if (node.operator === '+=') {
        const amount = constantNumber(node.right);
        if (amount !== undefined) fromAssignment = (fromAssignment ?? 0) - amount;
        return;
      }
      if (
        node.operator === '=' &&
        t.isBinaryExpression(node.right) &&
        t.isIdentifier(node.right.left, { name: param })
      ) {
        const amount = constantNumber(node.right.right);
        if (amount === undefined) return;
        if (node.right.operator === '-') fromAssignment = (fromAssignment ?? 0) + amount;
        else if (node.right.operator === '+') fromAssignment = (fromAssignment ?? 0) - amount;
      }
      return;
    }

    if (
      t.isMemberExpression(node) &&
      node.computed &&
      t.isBinaryExpression(node.property) &&
      t.isIdentifier(node.property.left, { name: param })
    ) {
      const amount = constantNumber(node.property.right);
      if (amount === undefined) return;
      if (node.property.operator === '-') fromIndexing = amount;
      else if (node.property.operator === '+') fromIndexing = -amount;
    }
  });

  return { fromAssignment, fromIndexing };
}

// ---------------------------------------------------------------------------
// Recogniser (c, d, e): the encoding applied to each array element
// ---------------------------------------------------------------------------

export interface EncodingRecognition {
  algorithm: NativeAlgorithm;
  /** Present when the payload is base64 before anything else happens. */
  base64?: { alphabet: string; byteMode: 'utf8' | 'latin1'; viaAtob: boolean };
  /**
   * The percent-decoding builtin a plain lookup returns its element through:
   * `return decodeURIComponent(t[i])`. Only the plain lookup has a place for
   * it; the base64 family reads the same call as its byte mode, and a cipher
   * body calling one has a step the shape does not place.
   */
  percent?: PercentDecoder;
  /** Key baked into the decoder body. */
  key?: string;
  /** Call-site argument supplying the key, e.g. `_0x123b(0x2bd3, '@m8w')`. */
  keyArgIndex?: number;
  /** Shift or XOR constant for the single-constant variants. */
  amount?: number;
  /** True when `selfDefending` wove a source-text tamper probe into the decoder. */
  selfSourceGuard?: boolean;
  evidence: string;
}

// ---------------------------------------------------------------------------
// Recogniser (e, part one): selfDefending woven into the decoder
// ---------------------------------------------------------------------------

/**
 * With `selfDefending` on, obfuscator.io does not merely *add* a tamper check -
 * it threads one through the base64 helper itself:
 *
 * ```js
 * var self = '' + helper;                                  // the helper's own text
 * var beautified = ('' + function () { return 0; }).indexOf('\n') !== -1;
 * ...
 * out += beautified || self.charCodeAt(k + 10) - 10 !== 0
 *   ? String.fromCharCode(255 & acc >> (-2 * n & 6))       // the real base64 step
 *   : n;                                                   // a loop counter
 * ```
 *
 * The value of that test is not knowable from an AST - it depends on the exact
 * bytes the function was printed as - so the honest question is not "which
 * branch runs?" but "does it matter?".
 *
 * It does not, and that is decidable: only one arm of the conditional is a
 * character expression at all. The other appends a loop counter, which cannot
 * be part of any decoding - it is the corruption the trap inflicts, not a second
 * encoding. So the algorithm is unambiguous whichever way the probe lands, and
 * the strings produced are the ones the *untampered* program produces, which
 * is exactly what a deobfuscator is being asked for.
 *
 * The one shape that must be refused is a probe guarding a choice between two
 * genuine character transforms: there the source text really would select the
 * algorithm, and picking one would be a guess.
 */
function analyseSelfSourceGuards(fn: t.Function): { found: boolean; ambiguous: boolean } {
  const sourceTexts = new Set<string>();
  const functionBindings = new Set<string>();

  // Pass one: which identifiers hold a function, and which hold a function's
  // *source text*. Two passes because `var self = '' + helper` can be written
  // before or after the helper it stringifies.
  eachNode(fn.body, (node) => {
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
    if (functionOf(node.init)) functionBindings.add(node.id.name);
  });
  for (let round = 0; round < 3; round++) {
    const before = sourceTexts.size;
    eachNode(fn.body, (node) => {
      if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id) || !node.init) return;
      if (stringifiesFunction(node.init, functionBindings, sourceTexts)) {
        sourceTexts.add(node.id.name);
      }
    });
    if (sourceTexts.size === before) break;
  }

  let found = false;
  let ambiguous = false;
  eachNode(fn.body, (node) => {
    if (!t.isConditionalExpression(node)) return;
    if (!containsSelfSourceProbe(node.test, functionBindings, sourceTexts)) return;
    found = true;
    // Both arms building characters means the probe really does choose an
    // algorithm, and there is no way to say which.
    if (buildsCharacters(node.consequent) && buildsCharacters(node.alternate)) ambiguous = true;
  });

  // A probe that guards nothing at all - `('' + f).indexOf('\n') === -1 && trap()`
  // - is the plain selfDefending call, which cannot change a decoded value.
  if (!found) {
    eachNode(fn.body, (node) => {
      if (found) return;
      if (containsSelfSourceProbe(node, functionBindings, sourceTexts)) found = true;
    });
  }

  return { found, ambiguous };
}

/** `'' + f`, `f + ''`, `f.toString()`, `String(f)` - however the source is taken. */
function stringifiesFunction(
  node: t.Node,
  functionBindings: ReadonlySet<string>,
  sourceTexts: ReadonlySet<string>,
): boolean {
  const isFunctionish = (side: t.Node): boolean =>
    functionOf(side) !== undefined ||
    (t.isIdentifier(side) && (functionBindings.has(side.name) || sourceTexts.has(side.name)));

  if (t.isBinaryExpression(node) && node.operator === '+') {
    return (t.isExpression(node.left) && isFunctionish(node.left)) || isFunctionish(node.right);
  }
  if (t.isCallExpression(node)) {
    if (t.isIdentifier(node.callee, { name: 'String' })) {
      const first = node.arguments[0];
      return first !== undefined && isFunctionish(first);
    }
    if (t.isMemberExpression(node.callee) && propertyName(node.callee) === 'toString') {
      return isFunctionish(node.callee.object);
    }
  }
  return false;
}

/** A read of a function's own source text anywhere inside `root`. */
function containsSelfSourceProbe(
  root: t.Node,
  functionBindings: ReadonlySet<string>,
  sourceTexts: ReadonlySet<string>,
): boolean {
  let probe = false;
  eachNode(root, (node) => {
    if (probe || !t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
    const method = propertyName(node.callee);
    if (!method || !SOURCE_PROBE_METHODS.has(method)) return;
    const receiver = node.callee.object;
    if (
      stringifiesFunction(receiver, functionBindings, sourceTexts) ||
      (t.isIdentifier(receiver) && sourceTexts.has(receiver.name))
    ) {
      probe = true;
    }
  });
  return probe;
}

const SOURCE_PROBE_METHODS = new Set([
  'indexOf',
  'lastIndexOf',
  'charCodeAt',
  'charAt',
  'search',
  'match',
  'includes',
  'test',
]);

/** Whether an expression can contribute a character to a decoded string. */
function buildsCharacters(node: t.Node): boolean {
  let characters = false;
  eachNode(node, (current) => {
    if (characters) return;
    if (t.isStringLiteral(current) && current.value.length > 0) characters = true;
    else if (t.isCallExpression(current) && t.isMemberExpression(current.callee)) {
      const method = propertyName(current.callee);
      if (method && CHARACTER_PRODUCERS.has(method)) characters = true;
    }
  });
  return characters;
}

const CHARACTER_PRODUCERS = new Set([
  'fromCharCode',
  'fromCodePoint',
  'charAt',
  'slice',
  'substr',
  'substring',
  'concat',
  'repeat',
  'padStart',
  'padEnd',
  'toLowerCase',
  'toUpperCase',
]);

/**
 * A base64 alphabet literal: exactly 64 distinct characters (plus an optional
 * `=` pad), overwhelmingly alphanumeric, no whitespace. Tight enough that prose
 * does not match, loose enough for base64url and the shuffled alphabets custom
 * obfuscators emit.
 */
function isBase64Alphabet(text: string): boolean {
  if (text.length < 64 || text.length > 65) return false;
  if (WHITESPACE.test(text)) return false;
  const seen = new Set<string>();
  let alphanumeric = 0;
  for (let i = 0; i < 64; i++) {
    const char = text[i]!;
    if (seen.has(char)) return false;
    seen.add(char);
    if (ALPHANUMERIC.test(char)) alphanumeric++;
  }
  return alphanumeric >= 60;
}

const WHITESPACE = /\s/;
const ALPHANUMERIC = /[0-9a-z]/i;

export type PercentDecoder = 'decodeURIComponent' | 'decodeURI' | 'unescape';

/**
 * The three builtins that turn `%xx` escapes back into characters. They are
 * not one function: `unescape` takes each escape as a code unit and
 * `decodeURI` leaves the reserved set encoded, so which one is called is
 * part of the shape, and the native reading calls the same one.
 */
const PERCENT_DECODERS: ReadonlySet<string> = new Set<PercentDecoder>([
  'decodeURIComponent',
  'decodeURI',
  'unescape',
]);

interface BodyFacts {
  strings: string[];
  numbers: Set<number>;
  members: Set<string>;
  callees: Set<string>;
  /** Every call whose callee is a bare name, nested functions included. */
  calls: t.CallExpression[];
  xors: t.BinaryExpression[];
  fromCharCodeArgs: t.Expression[];
  moduloCount: number;
  /** Identifiers bound to a string literal anywhere in the body. */
  stringBindings: Map<string, string>;
  /** How often each identifier is mentioned. */
  mentions: Map<string, number>;
}

function collectBodyFacts(fn: t.Function): BodyFacts {
  const facts: BodyFacts = {
    strings: [],
    numbers: new Set(),
    members: new Set(),
    callees: new Set(),
    calls: [],
    xors: [],
    fromCharCodeArgs: [],
    moduloCount: 0,
    stringBindings: new Map(),
    mentions: new Map(),
  };

  eachNode(fn.body, (node) => {
    if (t.isStringLiteral(node)) {
      facts.strings.push(node.value);
      return;
    }
    if (t.isNumericLiteral(node)) {
      facts.numbers.add(node.value);
      return;
    }
    if (t.isIdentifier(node)) {
      facts.mentions.set(node.name, (facts.mentions.get(node.name) ?? 0) + 1);
      return;
    }
    if (t.isMemberExpression(node)) {
      const name = propertyName(node);
      if (name) facts.members.add(name);
      return;
    }
    if (t.isCallExpression(node)) {
      if (t.isIdentifier(node.callee)) {
        facts.callees.add(node.callee.name);
        facts.calls.push(node);
      }
      if (isMemberCall(node, 'fromCharCode')) {
        for (const argument of node.arguments) {
          if (t.isExpression(argument)) facts.fromCharCodeArgs.push(argument);
        }
      }
      return;
    }
    if (t.isBinaryExpression(node)) {
      // A fully-constant subtree contributes its *value*, not its leaves: with
      // `numbersToExpressions` on, the 26 and 122 that identify a ROT-n decoder
      // exist only as the result of some arithmetic, never as a literal.
      const folded = constantNumber(node);
      if (folded !== undefined) facts.numbers.add(folded);
      if (node.operator === '^') facts.xors.push(node);
      else if (node.operator === '%' && constantNumber(node.right) === 256) facts.moduloCount++;
      return;
    }
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && t.isStringLiteral(node.init)) {
      facts.stringBindings.set(node.id.name, node.init.value);
    }
  });

  return facts;
}

/** Resolve the operand a XOR is keyed by, if it is a `<something>.charCodeAt(i)`. */
function xorKeySource(
  operand: t.Node,
  facts: BodyFacts,
  fn: t.Function,
): Pick<EncodingRecognition, 'key' | 'keyArgIndex'> | undefined {
  if (!isMemberCall(operand, 'charCodeAt')) return undefined;
  const receiver = (operand.callee as t.MemberExpression).object;
  if (t.isStringLiteral(receiver)) return { key: receiver.value };
  if (!t.isIdentifier(receiver)) return undefined;

  const bound = facts.stringBindings.get(receiver.name);
  if (bound !== undefined) return { key: bound };
  for (let index = 0; index < fn.params.length; index++) {
    if (paramName(fn, index) === receiver.name) return { keyArgIndex: index };
  }
  return undefined;
}

/**
 * Classify the transform the decoder applies to a raw array element.
 *
 * Every branch is gated on constants and operator shapes that the algorithm
 * cannot be written without - 256 and a XOR for RC4, a 64-character alphabet for
 * base64, `26` plus a letter bound for ROT-n. When none of them hold the result
 * is a plain lookup rather than an invented transform.
 */
export function recogniseEncoding(fn: t.Function): EncodingRecognition | null {
  const facts = collectBodyFacts(fn);

  // (e) selfDefending threads a source-text probe through the decoder. Refuse
  // only when that probe genuinely selects between two encodings; otherwise
  // record it and carry on - see `analyseSelfSourceGuards`.
  const guard = analyseSelfSourceGuards(fn);
  if (guard.ambiguous) return null;
  const selfSource = guard.found ? { selfSourceGuard: true as const } : {};
  const note = guard.found ? ', past a self-source tamper probe' : '';

  const alphabet = facts.strings.find(isBase64Alphabet);
  const atobCalled = facts.callees.has('atob') || facts.members.has('atob');
  // The byte mode is the `decodeURIComponent` the base64 family applies to
  // the `%xx` string it builds from its bytes, and it is that call only
  // when its argument is built from `%` escapes: one over anything else is a
  // step the shape does not place, and reading it as the byte mode had a
  // cipher's output run through it after the fact, unaccounted.
  const percentCalls = facts.calls.filter((call) => PERCENT_DECODERS.has((call.callee as t.Identifier).name));
  const utf8 =
    percentCalls.length > 0 &&
    percentCalls.every(
      (call) => t.isIdentifier(call.callee, { name: 'decodeURIComponent' }) && decodesBuiltEscapes(fn, call),
    );
  const base64 =
    alphabet !== undefined || atobCalled
      ? {
          alphabet: alphabet ? alphabet.slice(0, 64) : STANDARD_BASE64_ALPHABET,
          byteMode: (utf8 ? 'utf8' : 'latin1') as 'utf8' | 'latin1',
          // `atob` is the base64 the recogniser took only where no alphabet
          // loop was; beside one it is a second decode the shape lacks.
          viaAtob: alphabet === undefined && atobCalled,
        }
      : undefined;

  // A percent decoder called outside the base64 family is a step of its own,
  // and the only shape with a place for it is the plain lookup's `return
  // decodeURIComponent(t[i])`. Read as "index lookup", `function b(P) {
  // return decodeURIComponent(U[P]) }` handed back the raw `%C3%BCn%C3%AF`
  // where the program prints `ünï` - the call was in `MODELLED_CALLEES`, so
  // it was accounted for by name and by nothing else. So the step is a fact
  // here, and every cipher below refuses a body that has it, since where the
  // step sits relative to the cipher is not something the facts say.
  let percent: PercentDecoder | undefined;
  if (!base64 && percentCalls.length > 0) {
    const only = percentCalls[0]!;
    if (percentCalls.length !== 1 || !returnsElementThrough(fn, only)) return null;
    percent = (only.callee as t.Identifier).name as PercentDecoder;
  }

  // (d) RC4: the 256-entry permutation is unmistakable - two `% 256` reductions
  // (the KSA and the PRGA), plus a XOR feeding fromCharCode. The base64 wrapper
  // is the usual packaging but is not part of the cipher, so it stays optional.
  if (facts.moduloCount >= 2 && facts.xors.length > 0 && facts.members.has('fromCharCode')) {
    if (percent) return null;
    if (!isStockRc4(fn, facts)) return null;
    const key = rc4KeySource(fn, facts);
    if (!key) return null;
    return {
      algorithm: 'rc4',
      ...(base64 ? { base64 } : {}),
      ...key,
      ...selfSource,
      evidence: `rc4 (256-entry KSA/PRGA${base64 ? ' over base64' : ''})${note}`,
    };
  }

  // (e) XOR: a `^` whose operands are a payload char code and either a key's
  // char code or a constant.
  for (const xor of facts.xors) {
    const constant = constantNumber(xor.right) ?? constantNumber(xor.left);
    const keyed = xorKeySource(xor.right, facts, fn) ?? xorKeySource(xor.left, facts, fn);
    if (keyed) {
      if (percent) return null;
      return {
        algorithm: 'xor',
        ...(base64 ? { base64 } : {}),
        ...keyed,
        ...selfSource,
        evidence: `repeating-key xor over char codes${note}`,
      };
    }
    const payloadSide =
      isMemberCall(xor.left, 'charCodeAt') || isMemberCall(xor.right, 'charCodeAt');
    if (constant !== undefined && payloadSide) {
      if (percent) return null;
      return {
        algorithm: 'xor',
        ...(base64 ? { base64 } : {}),
        amount: constant,
        ...selfSource,
        evidence: `constant xor (0x${constant.toString(16)})${note}`,
      };
    }
  }

  // An unattributed XOR or 256-modulus means there is a cipher here that went
  // unnamed. Refuse, rather than reporting the layer that *was* recognised and
  // handing back ciphertext dressed as plaintext.
  if (facts.xors.length > 0 || facts.moduloCount > 0) return null;

  // (e) ROT-n over letters: recognised by the wrap-around constants, which a
  // plain char shift never has. The shift is the constant the body adds to
  // a character code - see `rotShift` - never a literal that merely falls in
  // the range, such as the index offset.
  if (facts.numbers.has(26) && (facts.numbers.has(90) || facts.numbers.has(122))) {
    const shift = rotShift(fn);
    if (shift !== undefined) {
      if (percent) return null;
      return {
        algorithm: 'rot',
        ...(base64 ? { base64 } : {}),
        amount: shift,
        ...selfSource,
        evidence: `rot${shift} over ascii letters${note}`,
      };
    }
  }

  // (e) Caesar: `String.fromCharCode(x.charCodeAt(i) ± n)`.
  for (const argument of facts.fromCharCodeArgs) {
    if (!t.isBinaryExpression(argument)) continue;
    if (argument.operator !== '+' && argument.operator !== '-') continue;
    if (!isMemberCall(argument.left, 'charCodeAt')) continue;
    const amount = constantNumber(argument.right);
    if (amount === undefined || amount === 0) continue;
    if (percent) return null;
    const delta = argument.operator === '-' ? -amount : amount;
    return {
      algorithm: 'caesar',
      ...(base64 ? { base64 } : {}),
      amount: delta,
      ...selfSource,
      evidence: `char shift (${delta > 0 ? '+' : ''}${delta})${note}`,
    };
  }

  // (c) base64 with nothing layered on top.
  if (base64) {
    const custom = base64.alphabet !== STANDARD_BASE64_ALPHABET;
    return {
      algorithm: 'base64',
      base64,
      ...selfSource,
      evidence: `base64 (${custom ? 'custom' : 'standard'} alphabet, ${base64.byteMode})${note}`,
    };
  }

  // (a) A bare lookup. Only claim this when the body rewrites nothing at all:
  // any string-transforming method means there *is* an algorithm here that went
  // unidentified.
  for (const member of facts.members) {
    if (TRANSFORM_MEMBERS.has(member)) return null;
  }
  // And when what it returns is the element it looked up. The facts above
  // are all about what the body does *not* do; `return 'x'` beside an
  // unused `t[i]` does none of it either, and reads as a lookup of `t[i]`.
  if (!percent && !returnsElementThrough(fn)) return null;
  return {
    algorithm: 'plain',
    ...(percent ? { percent } : {}),
    ...selfSource,
    evidence: `index lookup${percent ? ` through ${percent}` : ''}${note}`,
  };
}

/**
 * Whether `call`'s argument is a string the body builds out of `%` escapes:
 * the argument itself spells a `'%'`, or it is a local the body accumulates
 * one into - `s += '%' + ('00' + code.toString(16)).slice(-2)`, the shape
 * every base64 decoder that goes through `decodeURIComponent` writes.
 */
function decodesBuiltEscapes(fn: t.Function, call: t.CallExpression): boolean {
  const argument = call.arguments[0];
  if (!argument || call.arguments.length !== 1) return false;
  const spellsPercent = (node: t.Node): boolean => {
    let found = false;
    eachNode(node, (current) => {
      if (t.isStringLiteral(current) && current.value.includes('%')) found = true;
    });
    return found;
  };
  if (!t.isIdentifier(argument)) return spellsPercent(argument);
  let built = false;
  eachNode(fn.body, (node) => {
    if (built) return;
    if (t.isAssignmentExpression(node) && t.isIdentifier(node.left, { name: argument.name })) {
      built = spellsPercent(node.right);
    } else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id, { name: argument.name }) && node.init) {
      built = spellsPercent(node.init);
    }
  });
  return built;
}

/**
 * Whether every `return` of this body hands back the element the table read
 * produced - through `call`, when one is given, and bare otherwise - with
 * only single-assignment locals between: `var e = t[i]; return e`, `return
 * decodeURIComponent(t[i])`, `var d = t[i], r = f(d); return r`. A local
 * written twice is not followed, since which write the return sees is not a
 * shape question. The element read is any computed subscript; that each one
 * is `t[i ± c]` is `indexesByParameter`'s check.
 */
function returnsElementThrough(fn: t.Function, call?: t.CallExpression): boolean {
  const once = singleAssignmentLocals(fn);
  const resolve = (node: t.Node): t.Node => {
    let current = node;
    for (let depth = 0; depth < 8 && t.isIdentifier(current); depth++) {
      const init = once.get(current.name);
      if (!init) break;
      current = init;
    }
    return current;
  };
  const isElementRead = (node: t.Node): boolean =>
    t.isMemberExpression(node) && node.computed && !t.isStringLiteral(node.property);
  // An element read, or a choice between element reads: `v.length ? v : v`,
  // `cache[i] || t[i]`, which is the memo obfuscator.io writes.
  const yieldsElement = (node: t.Node, depth = 0): boolean => {
    const resolved = resolve(node);
    if (isElementRead(resolved)) return true;
    if (depth > 4) return false;
    if (t.isConditionalExpression(resolved)) {
      return yieldsElement(resolved.consequent, depth + 1) && yieldsElement(resolved.alternate, depth + 1);
    }
    if (t.isLogicalExpression(resolved)) {
      return yieldsElement(resolved.left, depth + 1) && yieldsElement(resolved.right, depth + 1);
    }
    return false;
  };

  if (call) {
    if (call.arguments.length !== 1 || !t.isExpression(call.arguments[0])) return false;
    if (!isElementRead(resolve(call.arguments[0]))) return false;
  }
  const returned: t.Node[] = [];
  if (t.isBlockStatement(fn.body)) {
    for (const statement of ownReturnStatements(fn.body)) {
      if (!statement.argument) return false;
      returned.push(statement.argument);
    }
  } else {
    returned.push(fn.body);
  }
  if (returned.length === 0) return false;
  for (const value of returned) {
    if (call ? resolve(value) !== call : !yieldsElement(value)) return false;
  }
  return true;
}

/** Locals the body declares once with an initialiser and never writes again, by name. */
function singleAssignmentLocals(fn: t.Function): Map<string, t.Expression> {
  const inits = new Map<string, t.Expression>();
  const written = new Set<string>();
  const declared = new Set<string>();
  for (const param of fn.params) {
    for (const name of Object.keys(t.getBindingIdentifiers(param))) written.add(name);
  }
  eachNode(fn.body, (node) => {
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      if (declared.has(node.id.name) || !node.init) written.add(node.id.name);
      else inits.set(node.id.name, node.init);
      declared.add(node.id.name);
    } else if (t.isAssignmentExpression(node)) {
      for (const name of Object.keys(t.getBindingIdentifiers(node.left))) written.add(name);
    } else if (t.isUpdateExpression(node) && t.isIdentifier(node.argument)) {
      written.add(node.argument.name);
    } else if (t.isFunction(node) || t.isClass(node) || t.isCatchClause(node)) {
      // A name bound any other way - a nested function's own name or
      // parameters, a `catch` binding - is not a local holding one value.
      for (const name of Object.keys(t.getBindingIdentifiers(node))) written.add(name);
    }
  });
  for (const name of written) inits.delete(name);
  return inits;
}

/**
 * Methods that rewrite a string. Seeing any of them in a decoder body otherwise
 * classified as a plain lookup means the classification is wrong.
 */
const TRANSFORM_MEMBERS = new Set([
  'atob',
  'btoa',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'fromCharCode',
  'fromCodePoint',
  'join',
  'map',
  'match',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'reverse',
  'slice',
  'split',
  'substr',
  'substring',
  'toLowerCase',
  'toUpperCase',
]);

/**
 * Where RC4's key comes from. obfuscator.io passes it per call site as the
 * second argument; a few variants bake a single literal into the body.
 */
function rc4KeySource(
  fn: t.Function,
  facts: BodyFacts,
): Pick<EncodingRecognition, 'key' | 'keyArgIndex'> | undefined {
  const second = paramName(fn, 1);
  // Mentioned more than once means it is used, not just declared.
  if (second && (facts.mentions.get(second) ?? 0) > 0) return { keyArgIndex: 1 };

  const candidates = facts.strings.filter(
    (value) => value.length > 0 && value.length <= 32 && !isBase64Alphabet(value),
  );
  if (candidates.length === 1) return { key: candidates[0]! };
  return undefined;
}

/**
 * The shift of a ROT-n body: the one constant in (0, 26) it adds to, or
 * subtracts from, a character code - `c.charCodeAt(0) + 13`, `(c.charCodeAt(0)
 * - base + 13) % 26`, `c.charCodeAt(0) - 5` for a shift of 21. Two different
 * ones, or none, is no shift to read.
 */
function rotShift(fn: t.Function): number | undefined {
  const shifts = new Set<number>();
  const readsCharCode = (node: t.Node): boolean =>
    isMemberCall(node, 'charCodeAt') ||
    (t.isBinaryExpression(node) && (node.operator === '+' || node.operator === '-') && readsCharCode(node.left));
  eachNode(fn.body, (node) => {
    if (!t.isBinaryExpression(node) || (node.operator !== '+' && node.operator !== '-')) return;
    let amount = constantNumber(node.right);
    let code = node.left;
    if (amount === undefined && node.operator === '+') {
      amount = constantNumber(node.left);
      code = node.right;
    }
    if (amount === undefined || amount <= 0 || amount >= 26 || !readsCharCode(code)) return;
    shifts.add(node.operator === '+' ? amount : 26 - amount);
  });
  return shifts.size === 1 ? [...shifts][0] : undefined;
}

/**
 * Whether the body is the stock cipher and nothing else: the key schedule
 * `j = (j + s[i] + k.charCodeAt(i % k.length)) % 256`, the generator's `i = (i
 * + 1) % 256` and `j = (j + s[i]) % 256`, each followed by the swap `x = s[i];
 * s[i] = s[j]; s[j] = x`, and the keystream byte `s[(s[i] + s[j]) % 256]`,
 * with no other reduction by 256 anywhere. A term added to the schedule, a
 * stride of two, a missing swap - each is a cipher of its own that `rc4`
 * does not compute.
 */
function isStockRc4(fn: t.Function, facts: BodyFacts): boolean {
  if (facts.moduloCount !== 4) return false;
  // Each block as its run of expressions, a comma-joined statement - the
  // spelling obfuscator.io compacts a loop body to - contributing one per
  // operand; any other statement breaks the run.
  const blocks: (t.Expression | null)[][] = [];
  eachNode(fn.body, (node) => {
    if (!t.isBlockStatement(node)) return;
    const steps: (t.Expression | null)[] = [];
    for (const statement of node.body) {
      if (!t.isExpressionStatement(statement)) steps.push(null);
      else if (t.isSequenceExpression(statement.expression)) steps.push(...statement.expression.expressions);
      else steps.push(statement.expression);
    }
    blocks.push(steps);
  });

  const name = (node: t.Node | null | undefined): string | undefined => (t.isIdentifier(node) ? node.name : undefined);
  /** `s[i]` as its two names. */
  const element = (node: t.Node): [string, string] | undefined => {
    if (!t.isMemberExpression(node) || !node.computed) return undefined;
    const object = name(node.object);
    const index = name(node.property);
    return object !== undefined && index !== undefined ? [object, index] : undefined;
  };
  const terms = (node: t.Expression): t.Expression[] =>
    t.isBinaryExpression(node) && node.operator === '+' ? [...terms(node.left as t.Expression), node.right] : [node];
  /** The operand of a `% 256`, reduced as a sum. */
  const reduced = (node: t.Node): t.Expression[] | undefined =>
    t.isBinaryExpression(node) && node.operator === '%' && constantNumber(node.right) === 256
      ? terms(node.left as t.Expression)
      : undefined;
  /** `target = (...) % 256` at `block[at]`, as [target, terms]. */
  const reduction = (block: (t.Expression | null)[], at: number): [string, t.Expression[]] | undefined => {
    const step = block[at];
    if (!step || !t.isAssignmentExpression(step, { operator: '=' })) return undefined;
    const target = name(step.left);
    const sum = reduced(step.right);
    return target !== undefined && sum !== undefined ? [target, sum] : undefined;
  };
  /** `k.charCodeAt(i % k.length)` as [k, i]. */
  const keyByte = (node: t.Node): [string, string] | undefined => {
    if (!isMemberCall(node, 'charCodeAt') || node.arguments.length !== 1) return undefined;
    const receiver = name((node.callee as t.MemberExpression).object);
    const argument = node.arguments[0]!;
    if (receiver === undefined || !t.isBinaryExpression(argument, { operator: '%' })) return undefined;
    const index = name(argument.left);
    const length = argument.right;
    if (index === undefined || !t.isMemberExpression(length) || propertyName(length) !== 'length') return undefined;
    return name(length.object) === receiver ? [receiver, index] : undefined;
  };
  const isElement = (node: t.Node, s: string, index: string): boolean => {
    const found = element(node);
    return found !== undefined && found[0] === s && found[1] === index;
  };
  /** `x = s[i]; s[i] = s[j]; s[j] = x;` from `block[at]`. */
  const swapAt = (block: (t.Expression | null)[], at: number, s: string, i: string, j: string): boolean => {
    const assignments = block
      .slice(at, at + 3)
      .map((step) => (step && t.isAssignmentExpression(step, { operator: '=' }) ? step : undefined));
    const [first, second, third] = assignments;
    if (!first || !second || !third) return false;
    const temp = name(first.left);
    return (
      temp !== undefined &&
      isElement(first.right, s, i) &&
      isElement(second.left, s, i) &&
      isElement(second.right, s, j) &&
      isElement(third.left, s, j) &&
      name(third.right) === temp
    );
  };

  // The schedule binds every name; it must occur once.
  let names: { s: string; i: string; j: string } | undefined;
  for (const block of blocks) {
    for (let at = 0; at < block.length; at++) {
      const found = reduction(block, at);
      if (!found) continue;
      const [target, sum] = found;
      if (sum.length !== 3 || name(sum[0]) !== target) continue;
      const state = element(sum[1]!);
      const key = keyByte(sum[2]!);
      if (!state || !key || key[1] !== state[1]) continue;
      if (names !== undefined) return false;
      names = { s: state[0], i: state[1], j: target };
      if (!swapAt(block, at + 1, names.s, names.i, names.j)) return false;
    }
  }
  if (names === undefined) return false;
  const { s, i, j } = names;

  let stride = false;
  let generator = false;
  for (const block of blocks) {
    for (let at = 0; at < block.length; at++) {
      const found = reduction(block, at);
      if (!found) continue;
      const [target, sum] = found;
      if (sum.length !== 2) continue;
      if (target === i && name(sum[0]) === i && constantNumber(sum[1]) === 1) stride = true;
      else if (target === j && name(sum[0]) === j && isElement(sum[1]!, s, i)) {
        generator = swapAt(block, at + 1, s, i, j);
      }
    }
  }
  if (!stride || !generator) return false;

  return facts.xors.some((xor) =>
    [xor.left, xor.right].some((side) => {
      if (!t.isMemberExpression(side) || !side.computed || name(side.object) !== s) return false;
      const sum = reduced(side.property);
      return sum !== undefined && sum.length === 2 && isElement(sum[0]!, s, i) && isElement(sum[1]!, s, j);
    }),
  );
}

// ---------------------------------------------------------------------------
// Recogniser (b): the rotation loop
// ---------------------------------------------------------------------------

export interface RotationPuzzle {
  checksum: t.Expression;
  target: number;
  /** Names that stand for the decoder inside the IIFE. */
  decoderNames: Set<string>;
  /** Locals declared in the loop body, to be inlined into the checksum. */
  locals: Map<string, t.Expression>;
  /** Wrapper functions the checksum calls instead of calling the decoder. */
  forwarders: Map<string, ArgumentForwarder>;
  /** The loop statement the shuffle runs in, for `NativeDecoder.modelled`. */
  loop: t.Loop;
  /**
   * Whether the loop body is the puzzle and nothing else - declarations in
   * the checksum's grammar, the comparison that breaks or shuffles, the
   * try/catch around them - so that the shuffle run to the solution is all
   * the loop does; see `loopIsOnlyThePuzzle`.
   */
  exact: boolean;
}

/**
 * Locate the `while(!![]){try{ ...checksum... }catch{ push(shift()) }}` loop and
 * extract the arithmetic it is solving for.
 *
 * This loop is never run. Running it means executing attacker-controlled code
 * that is *designed* to spin forever if anything about the array is off; instead
 * the checksum expression is read out of the AST and solved as arithmetic.
 */
export function recogniseRotationPuzzle(
  statements: readonly t.Statement[],
  decoderNames: ReadonlySet<string>,
): RotationPuzzle | null {
  for (const { call, fn, loop } of findRotationLoops(statements)) {
    if (!loop) continue;
    const locals = new Map<string, t.Expression>();
    const names = new Set(decoderNames);
    eachNode(fn.body, (node) => {
      if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id) || !node.init) return;
      locals.set(node.id.name, node.init);
      if (t.isIdentifier(node.init) && names.has(node.init.name)) names.add(node.id.name);
    });

    // The IIFE's checksum parameter is bound to a literal at the call site.
    const targets = new Map<string, number>();
    for (let index = 0; index < fn.params.length; index++) {
      const name = paramName(fn, index);
      const value = constantNumber(call.arguments[index] as t.Node | undefined);
      if (name && value !== undefined) targets.set(name, value);
    }

    // Wrappers the checksum can reach: the IIFE's own private ones first, then
    // any declared alongside it in the slice. The IIFE's win on a name clash
    // because that is what the scope chain would do.
    const forwarders = collectArgumentForwarders(statements);
    for (const [name, forwarder] of collectArgumentForwarders([fn.body])) {
      forwarders.set(name, forwarder);
    }

    const puzzle = extractComparison(fn, locals, targets);
    if (puzzle) {
      const context = { decoderNames: names, locals, forwarders, targets };
      return { ...puzzle, decoderNames: names, locals, forwarders, loop, exact: loopIsOnlyThePuzzle(loop, context) };
    }
  }
  return null;
}

/** `f(...)`, `!f(...)`, `void f(...)` and `(a, f(...))` all appear in the wild. */
function unwrapCall(expression: t.Expression): t.CallExpression | null {
  let current: t.Expression = expression;
  for (let depth = 0; depth < 4; depth++) {
    if (t.isCallExpression(current)) return current;
    if (t.isUnaryExpression(current)) current = current.argument;
    else if (t.isSequenceExpression(current) && current.expressions.length > 0) {
      current = current.expressions[current.expressions.length - 1]!;
    } else return null;
  }
  return null;
}

function extractComparison(
  fn: t.Function,
  locals: ReadonlyMap<string, t.Expression>,
  targets: ReadonlyMap<string, number>,
): { checksum: t.Expression; target: number } | null {
  let result: { checksum: t.Expression; target: number } | null = null;
  eachNode(fn.body, (node) => {
    if (result || !t.isIfStatement(node)) return;
    const test = node.test;
    if (!t.isBinaryExpression(test) || (test.operator !== '===' && test.operator !== '==')) return;

    const resolveTarget = (side: t.Node): number | undefined => {
      const literal = constantNumber(side);
      if (literal !== undefined) return literal;
      return t.isIdentifier(side) ? targets.get(side.name) : undefined;
    };

    const leftTarget = resolveTarget(test.left);
    const rightTarget = resolveTarget(test.right);
    if (leftTarget !== undefined && rightTarget === undefined && t.isExpression(test.right)) {
      result = { checksum: inlineLocals(test.right, locals), target: leftTarget };
    } else if (rightTarget !== undefined && leftTarget === undefined && t.isExpression(test.left)) {
      result = { checksum: inlineLocals(test.left, locals), target: rightTarget };
    }
  });
  return result;
}

/** Follow `const a = <expr>` chains so the checksum is one self-contained tree. */
function inlineLocals(
  expression: t.Expression,
  locals: ReadonlyMap<string, t.Expression>,
  depth = 0,
): t.Expression {
  if (depth > 8) return expression;
  if (t.isIdentifier(expression)) {
    const bound = locals.get(expression.name);
    return bound ? inlineLocals(bound, locals, depth + 1) : expression;
  }
  return expression;
}

/** What the loop-body test reads the checksum against; see `loopIsOnlyThePuzzle`. */
interface PuzzleShape {
  decoderNames: ReadonlySet<string>;
  locals: ReadonlyMap<string, t.Expression>;
  forwarders: ReadonlyMap<string, ArgumentForwarder>;
  /** The IIFE parameters bound to a literal at the call, the checksum's target among them. */
  targets: ReadonlyMap<string, number>;
}

/**
 * Whether the loop's body is the puzzle and nothing else, so that the
 * shuffle run to the solution is the whole of what the loop does. The
 * comparison is read from anywhere in the IIFE, and the solution is right
 * wherever it sits; what a caller standing the loop in for its solution
 * needs is that no other statement turns with it - a call the recogniser
 * did not read on every turn is dropped with the loop, and the crash or
 * the hang the program meets there would leave with it. The test the loop
 * runs on is a literal truth, its body is try/catch around declarations in
 * the checksum's grammar, the comparison breaking or shuffling, and
 * shuffles; the catch is shuffles alone.
 */
function loopIsOnlyThePuzzle(loop: t.Loop, shape: PuzzleShape): boolean {
  if (t.isWhileStatement(loop) || t.isDoWhileStatement(loop)) {
    if (!isTruthyLiteral(loop.test)) return false;
  } else if (t.isForStatement(loop)) {
    if (loop.init || loop.update || (loop.test && !isTruthyLiteral(loop.test))) return false;
  } else {
    return false;
  }
  let shuffles = 0;
  const isTarget = (side: t.Node): boolean =>
    constantNumber(side) !== undefined || (t.isIdentifier(side) && shape.targets.has(side.name));
  const ok = (statement: t.Statement): boolean => {
    if (t.isBlockStatement(statement)) return statement.body.every(ok);
    if (t.isTryStatement(statement)) {
      if (statement.finalizer || !statement.block.body.every(ok)) return false;
      return statement.handler === null || statement.handler === undefined || statement.handler.body.body.every(ok);
    }
    if (t.isVariableDeclaration(statement)) {
      return statement.declarations.every(
        (declarator) => t.isIdentifier(declarator.id) && (!declarator.init || isChecksumGrammar(declarator.init, shape)),
      );
    }
    if (t.isExpressionStatement(statement)) {
      if (!isShuffle(statement.expression)) return false;
      shuffles++;
      return true;
    }
    if (t.isBreakStatement(statement)) return !statement.label;
    if (t.isIfStatement(statement)) {
      const test = statement.test;
      if (!t.isBinaryExpression(test) || (test.operator !== '===' && test.operator !== '==')) return false;
      const compared =
        (isTarget(test.left) && isChecksumGrammar(test.right, shape)) ||
        (isTarget(test.right) && t.isExpression(test.left) && isChecksumGrammar(test.left, shape));
      if (!compared) return false;
      return ok(statement.consequent) && (!statement.alternate || ok(statement.alternate));
    }
    return false;
  };
  const body = t.isBlockStatement(loop.body) ? loop.body.body : [loop.body];
  return body.every(ok) && shuffles > 0;
}

/** The grammar `evaluateChecksum` reads: literals, `+ - * / %`, `parseInt` and its kin, and calls that reach the decoder. */
function isChecksumGrammar(node: t.Node, shape: PuzzleShape, depth = 0): boolean {
  if (depth > 64) return false;
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) return true;
  if (t.isIdentifier(node)) {
    const bound = shape.locals.get(node.name);
    return bound !== undefined && isChecksumGrammar(bound, shape, depth + 1);
  }
  if (t.isUnaryExpression(node)) {
    return (node.operator === '-' || node.operator === '+') && isChecksumGrammar(node.argument, shape, depth + 1);
  }
  if (t.isBinaryExpression(node)) {
    const arithmetic = node.operator === '+' || node.operator === '-' || node.operator === '*' || node.operator === '/' || node.operator === '%';
    return arithmetic && t.isExpression(node.left) && isChecksumGrammar(node.left, shape, depth + 1) && isChecksumGrammar(node.right, shape, depth + 1);
  }
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    if (!t.isIdentifier(callee)) return false;
    if (!node.arguments.every((argument) => t.isExpression(argument) && isChecksumGrammar(argument, shape, depth + 1))) return false;
    if (callee.name === 'parseInt' || callee.name === 'Number' || callee.name === 'parseFloat') return true;
    return shape.decoderNames.has(resolveAlias(callee.name, shape.locals, shape.decoderNames)) || shape.forwarders.has(callee.name);
  }
  return false;
}

/** `x.push(x.shift())` over one and the same `x`. */
function isShuffle(node: t.Node): boolean {
  if (!isMemberCall(node, 'push') || node.arguments.length !== 1) return false;
  const shifted = node.arguments[0]!;
  if (!isMemberCall(shifted, 'shift') || shifted.arguments.length !== 0) return false;
  const pushed = (node.callee as t.MemberExpression).object;
  const from = (shifted.callee as t.MemberExpression).object;
  return t.isNodesEquivalent(pushed, from);
}

/** `true`, `!![]`, `!0`, a non-zero number: a test that is true without running anything. */
function isTruthyLiteral(test: t.Expression): boolean {
  if (t.isBooleanLiteral(test)) return test.value;
  if (t.isNumericLiteral(test)) return test.value !== 0;
  if (t.isUnaryExpression(test, { operator: '!' })) {
    const inner = test.argument;
    if (t.isNumericLiteral(inner)) return inner.value === 0;
    return t.isUnaryExpression(inner, { operator: '!' }) && (t.isArrayExpression(inner.argument) || t.isObjectExpression(inner.argument));
  }
  return false;
}

interface ChecksumContext {
  decoderNames: ReadonlySet<string>;
  locals: ReadonlyMap<string, t.Expression>;
  forwarders: ReadonlyMap<string, ArgumentForwarder>;
  decode(args: readonly (string | number)[]): string | undefined;
}

/**
 * Evaluate the checksum arithmetic for a candidate array rotation.
 *
 * Deliberately tiny: numbers, the four arithmetic operators, `parseInt`/`Number`
 * and calls that reach the decoder. Anything else returns undefined, which fails
 * the rotation search rather than producing an unjustifiable number.
 */
function evaluateChecksum(
  node: t.Node,
  context: ChecksumContext,
  depth = 0,
): number | string | undefined {
  if (depth > 64) return undefined;
  const recurse = (child: t.Node): number | string | undefined =>
    evaluateChecksum(child, context, depth + 1);

  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;

  if (t.isIdentifier(node)) {
    const bound = context.locals.get(node.name);
    return bound ? recurse(bound) : undefined;
  }

  if (t.isUnaryExpression(node)) {
    const value = recurse(node.argument);
    if (value === undefined) return undefined;
    if (node.operator === '-') return -Number(value);
    if (node.operator === '+') return Number(value);
    return undefined;
  }

  if (t.isBinaryExpression(node)) {
    if (!t.isExpression(node.left)) return undefined;
    const left = recurse(node.left);
    const right = recurse(node.right);
    if (left === undefined || right === undefined) return undefined;
    const a = Number(left);
    const b = Number(right);
    switch (node.operator) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      case '%':
        return a % b;
      default:
        return undefined;
    }
  }

  if (t.isCallExpression(node)) {
    const callee = node.callee;
    if (!t.isIdentifier(callee)) return undefined;

    if (callee.name === 'parseInt' || callee.name === 'Number' || callee.name === 'parseFloat') {
      const first = node.arguments[0];
      if (!first || !t.isExpression(first)) return undefined;
      const value = recurse(first);
      if (value === undefined) return undefined;
      if (callee.name === 'Number') return Number(value);
      if (callee.name === 'parseFloat') return parseFloat(String(value));
      const radix = node.arguments[1] ? constantNumber(node.arguments[1] as t.Node) : undefined;
      return parseInt(String(value), radix);
    }

    const args: (string | number)[] = [];
    for (const argument of node.arguments) {
      if (!t.isExpression(argument)) return undefined;
      const value = recurse(argument);
      if (value === undefined) return undefined;
      args.push(value);
    }

    const isDecoder = (name: string): boolean =>
      context.decoderNames.has(resolveAlias(name, context.locals, context.decoderNames));

    if (isDecoder(callee.name)) return context.decode(args);

    // Not the decoder itself: with `stringArrayWrappersType: 'function'` the
    // rotation IIFE declares its own wrappers and drives the entire checksum
    // through them, so following the chain is not an optimisation - it is the
    // difference between solving the rotation and decoding nothing at all.
    const forwarded = resolveForwardedCall(callee.name, args, context.forwarders, isDecoder);
    return forwarded ? context.decode(forwarded.args) : undefined;
  }

  return undefined;
}

function resolveAlias(
  name: string,
  locals: ReadonlyMap<string, t.Expression>,
  decoderNames: ReadonlySet<string>,
  depth = 0,
): string {
  if (depth > 8 || decoderNames.has(name)) return name;
  const bound = locals.get(name);
  if (bound && t.isIdentifier(bound)) return resolveAlias(bound.name, locals, decoderNames, depth + 1);
  return name;
}

/**
 * Solve the rotation by brute force over the array length.
 *
 * The loop the obfuscator emits does exactly this at runtime; doing it as
 * arithmetic costs one checksum evaluation per candidate - microseconds for a
 * thousand-element array - and cannot hang.
 */
export function solveRotation(
  puzzle: RotationPuzzle,
  values: readonly string[],
  makeDecode: (rotation: number) => (args: readonly (string | number)[]) => string | undefined,
): number | null {
  // A rotated view per candidate, not a rotated copy: a two-thousand-entry
  // table tried at every rotation is four million element copies otherwise.
  for (let rotation = 0; rotation < values.length; rotation++) {
    const decode = makeDecode(rotation);
    let result: number | string | undefined;
    try {
      result = evaluateChecksum(puzzle.checksum, {
        decoderNames: puzzle.decoderNames,
        locals: puzzle.locals,
        forwarders: puzzle.forwarders,
        decode,
      });
    } catch {
      continue;
    }
    if (typeof result === 'number' && result === puzzle.target) return rotation;
  }
  return null;
}

/** The decoder arguments the checksum evaluates, in evaluation order, under `decode`. */
function checksumTerms(
  puzzle: RotationPuzzle,
  decode: (args: readonly (string | number)[]) => string | undefined,
): readonly (readonly (string | number)[])[] {
  const terms: (readonly (string | number)[])[] = [];
  try {
    evaluateChecksum(puzzle.checksum, {
      decoderNames: puzzle.decoderNames,
      locals: puzzle.locals,
      forwarders: puzzle.forwarders,
      decode: (args) => {
        terms.push([...args]);
        return decode(args);
      },
    });
  } catch {
    // The solution evaluated without a throw; the terms up to one are kept.
  }
  return terms;
}

/** The `x.push(x.shift())` a rotation loop turns on. */
function findShuffle(loop: t.Loop): t.CallExpression | undefined {
  let found: t.CallExpression | undefined;
  eachNode(loop, (node) => {
    if (found === undefined && isMemberCall(node, 'push') && node.arguments.length === 1 && isMemberCall(node.arguments[0]!, 'shift')) {
      found = node;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Recogniser (g): the obfuscator.io 0.x template
// ---------------------------------------------------------------------------

/*
 * The decoder obfuscator.io emitted up to 0.18 - `var d = function (a, b) {
 * a = a - 0; var c = T[a]; if (d.X === undefined) { (function () { ... global
 * object ... atob polyfill ... }()); d.Y = function (e) { ... }; d.Z = {}; d.X =
 * true; } ... }` - differs from the current one in three pieces, each read
 * here so that the native tier takes the shape and the interpreter can
 * confirm it, as the two do on a current build:
 *
 *  - a prologue IIFE that reaches the realm's global object by the idiom
 *    (see `global-object.ts`) and polyfills `atob` on it if absent. Under
 *    every tier the builtin is present, so the polyfill is dead code, and
 *    the facts of the decoder body are read with the prologue left out;
 *  - a rotation that is a fixed count, `while (--e) T.push(T.shift())` over
 *    `c(++b)` with `b` the IIFE's literal argument, rather than a checksum
 *    loop - called directly, or from the `getCookie` of the `selfDefending`
 *    cookie machinery, which runs it only when a formatting pattern matches
 *    the compact print of its own `removeCookie`;
 *  - with `selfDefending`, a state object inside the decoder that tests a
 *    formatting pattern against the compact print of one of its own
 *    methods and, on a match, does nothing; on a mismatch it never returns.
 *    Its invocation is excised from the slice when the shape is the
 *    template's and the pattern matches, for every tier at once, so a
 *    decoder is not judged on a reprint; the shape is exported for the
 *    pass that removes the same guard from the output.
 */

/** The `selfDefending` state object of the 0.x decoder: what to excise, and what defines it. */
export interface StateObjectGuard {
  /** `new e(d)[m]()`: the invocation, a no-op once the pattern matches. */
  invocation: t.ExpressionStatement;
  /** The block the invocation and its definitions sit in. */
  block: t.Statement[];
  /** `var e = function (f) { this[...] = ...; }` and `e.prototype[...] = function ...`. */
  definitions: t.Statement[];
}

/**
 * Every state-object guard in `statements`, at any depth. The shape is read
 * whole and the no-op verified - the constructor holds two pattern
 * halves, a probed method returning a literal and the `[1, 0, 0]` counter;
 * the invoked method tests the joined pattern against the probed method's
 * text and decrements a counter slot by the verdict; the next method
 * returns on a `-1` and recurses forever otherwise - so an invocation is
 * reported only when the match holds on the compact print, where the
 * program returns at once.
 */
export function findStateObjectGuards(statements: readonly t.Statement[]): StateObjectGuard[] {
  const found: StateObjectGuard[] = [];
  const visit = (block: t.Statement[]): void => {
    for (const statement of block) {
      const guard = stateObjectGuardAt(block, statement);
      if (guard) found.push(guard);
    }
  };
  // The list itself, not a copy of it: a guard at the top of the slice is
  // excised from the array the caller holds.
  eachNode(t.blockStatement(statements as t.Statement[]), (node) => {
    if (t.isBlockStatement(node)) visit(node.body);
    else if (t.isProgram(node)) visit(node.body);
    else if (t.isSwitchCase(node)) visit(node.consequent);
  });
  return found;
}

/** Remove every state-object invocation from `statements` in place; the guards removed. */
export function exciseStateObjectGuards(statements: t.Statement[]): StateObjectGuard[] {
  const guards = findStateObjectGuards(statements);
  for (const guard of guards) {
    const index = guard.block.indexOf(guard.invocation);
    if (index >= 0) guard.block.splice(index, 1);
  }
  return guards;
}

function stateObjectGuardAt(block: t.Statement[], statement: t.Statement): StateObjectGuard | undefined {
  // `new e(d)[m]();`
  if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) return undefined;
  const call = statement.expression;
  if (call.arguments.length !== 0 || !t.isMemberExpression(call.callee)) return undefined;
  const method = propertyName(call.callee);
  const made = call.callee.object;
  if (method === undefined || !t.isNewExpression(made) || !t.isIdentifier(made.callee)) return undefined;
  if (made.arguments.length !== 1 || !t.isIdentifier(made.arguments[0])) return undefined;
  const name = made.callee.name;

  // `var e = function (f) { this.k1 = f; this.k2 = [1, 0, 0]; this.k3 = function () { return '...'; }; this.k4 = '...'; this.k5 = '...'; }`
  const constructorStatement = block.find(
    (own): own is t.VariableDeclaration =>
      t.isVariableDeclaration(own) &&
      own.declarations.some((declarator) => t.isIdentifier(declarator.id, { name }) && functionOf(declarator.init) !== undefined),
  );
  if (!constructorStatement) return undefined;
  const constructor = functionOf(constructorStatement.declarations.find((declarator) => t.isIdentifier(declarator.id, { name }))!.init)!;
  if (constructor.params.length !== 1 || !t.isBlockStatement(constructor.body)) return undefined;
  const fields = new Map<string, t.Expression>();
  for (const own of constructor.body.body) {
    const written = t.isExpressionStatement(own) && t.isAssignmentExpression(own.expression) && own.expression.operator === '=' ? own.expression : undefined;
    if (!written || !t.isMemberExpression(written.left) || !t.isThisExpression(written.left.object)) return undefined;
    const key = propertyName(written.left);
    if (key === undefined) return undefined;
    fields.set(key, written.right);
  }

  // `e.prototype.m = function () { ... }`, for every method of the object.
  const methods = new Map<string, t.Function>();
  const definitions: t.Statement[] = [constructorStatement];
  for (const own of block) {
    if (!t.isExpressionStatement(own) || !t.isAssignmentExpression(own.expression) || own.expression.operator !== '=') continue;
    const target = own.expression.left;
    if (!t.isMemberExpression(target) || !t.isMemberExpression(target.object)) continue;
    if (!t.isIdentifier(target.object.object, { name }) || propertyName(target.object) !== 'prototype') continue;
    const key = propertyName(target);
    const fn = functionOf(own.expression.right);
    if (key === undefined || !fn) continue;
    methods.set(key, fn);
    definitions.push(own);
  }
  const probe = methods.get(method);
  if (!probe) return undefined;
  const verdict = readProbeMethod(probe);
  if (!verdict) return undefined;
  const next = methods.get(verdict.next);
  if (!next || !isReturnOnMinusOne(next)) return undefined;

  // The pattern halves, the probed method and the counter, as the constructor set them.
  const left = fields.get(verdict.patternLeft);
  const right = fields.get(verdict.patternRight);
  const probed = fields.get(verdict.probed);
  const counter = fields.get(verdict.counter);
  if (!left || !right || !probed || !counter) return undefined;
  if (!t.isStringLiteral(left) || !t.isStringLiteral(right)) return undefined;
  const probedFn = functionOf(probed);
  if (!probedFn || !t.isBlockStatement(probedFn.body) || !t.isArrayExpression(counter)) return undefined;
  const slots = counter.elements.map((element) => (element && t.isNumericLiteral(element) ? element.value : Number.NaN));
  if (slots.length < 2 || slots[verdict.matchSlot] !== 0 || !slots.every((slot) => Number.isFinite(slot))) return undefined;
  if (!formattingPatternMatches(left.value + right.value, probedFn)) return undefined;
  return { invocation: statement, block, definitions };
}

/**
 * `var f = new RegExp(this.a + this.b); var g = f.test(this.c.toString()) ?
 * --this.d[1] : --this.d[0]; return this.m2(g);` - the keys read, and which
 * counter slot a match decrements.
 */
function readProbeMethod(fn: t.Function): { patternLeft: string; patternRight: string; probed: string; counter: string; matchSlot: number; next: string } | undefined {
  if (!t.isBlockStatement(fn.body) || fn.body.body.length !== 3) return undefined;
  const [first, second, third] = fn.body.body;
  // `var f = new RegExp(this.a + this.b)`
  if (!t.isVariableDeclaration(first) || first.declarations.length !== 1) return undefined;
  const regexDeclarator = first.declarations[0]!;
  if (!t.isIdentifier(regexDeclarator.id) || !t.isNewExpression(regexDeclarator.init)) return undefined;
  if (!t.isIdentifier(regexDeclarator.init.callee, { name: 'RegExp' }) || regexDeclarator.init.arguments.length !== 1) return undefined;
  const joined = regexDeclarator.init.arguments[0]!;
  if (!t.isBinaryExpression(joined) || joined.operator !== '+') return undefined;
  const patternLeft = thisKey(joined.left);
  const patternRight = thisKey(joined.right);
  if (patternLeft === undefined || patternRight === undefined) return undefined;
  // `var g = f.test(this.c.toString()) ? --this.d[1] : --this.d[0]`
  if (!t.isVariableDeclaration(second) || second.declarations.length !== 1) return undefined;
  const verdictDeclarator = second.declarations[0]!;
  if (!t.isIdentifier(verdictDeclarator.id) || !t.isConditionalExpression(verdictDeclarator.init)) return undefined;
  const test = verdictDeclarator.init.test;
  if (!isMemberCall(test, 'test') || test.arguments.length !== 1) return undefined;
  if (!t.isIdentifier((test.callee as t.MemberExpression).object, { name: regexDeclarator.id.name })) return undefined;
  const subject = test.arguments[0]!;
  if (!isMemberCall(subject, 'toString') || subject.arguments.length !== 0) return undefined;
  const probed = thisKey((subject.callee as t.MemberExpression).object);
  if (probed === undefined) return undefined;
  const match = counterDecrement(verdictDeclarator.init.consequent);
  const miss = counterDecrement(verdictDeclarator.init.alternate);
  if (!match || !miss || match.counter !== miss.counter || match.slot === miss.slot) return undefined;
  // `return this.m2(g)`
  if (!t.isReturnStatement(third) || !t.isCallExpression(third.argument)) return undefined;
  const nextCall = third.argument;
  if (nextCall.arguments.length !== 1 || !t.isIdentifier(nextCall.arguments[0], { name: verdictDeclarator.id.name })) return undefined;
  if (!t.isMemberExpression(nextCall.callee) || !t.isThisExpression(nextCall.callee.object)) return undefined;
  const next = propertyName(nextCall.callee);
  if (next === undefined) return undefined;
  return { patternLeft, patternRight, probed, counter: match.counter, matchSlot: match.slot, next };
}

/** `this.k` as its key. */
function thisKey(node: t.Node): string | undefined {
  return t.isMemberExpression(node) && t.isThisExpression(node.object) ? propertyName(node) : undefined;
}

/** `--this.d[n]`: the counter's key and the slot. */
function counterDecrement(node: t.Node): { counter: string; slot: number } | undefined {
  if (!t.isUpdateExpression(node) || node.operator !== '--' || !node.prefix) return undefined;
  const slotRead = node.argument;
  if (!t.isMemberExpression(slotRead) || !slotRead.computed || !t.isNumericLiteral(slotRead.property)) return undefined;
  const counter = thisKey(slotRead.object);
  return counter === undefined ? undefined : { counter, slot: slotRead.property.value };
}

/** `function (f) { if (!Boolean(~f)) { return f; } return this.m3(...); }`: returns on `-1`, since `~-1` is `0`. */
function isReturnOnMinusOne(fn: t.Function): boolean {
  if (!t.isBlockStatement(fn.body) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return false;
  const param = fn.params[0].name;
  const [first] = fn.body.body;
  if (!t.isIfStatement(first) || first.alternate) return false;
  const test = first.test;
  if (!t.isUnaryExpression(test, { operator: '!' }) || !t.isCallExpression(test.argument)) return false;
  const coerced = test.argument;
  if (!t.isIdentifier(coerced.callee, { name: 'Boolean' }) || coerced.arguments.length !== 1) return false;
  const inverted = coerced.arguments[0]!;
  if (!t.isUnaryExpression(inverted, { operator: '~' }) || !t.isIdentifier(inverted.argument, { name: param })) return false;
  const arm = t.isBlockStatement(first.consequent) ? first.consequent.body[0] : first.consequent;
  return t.isReturnStatement(arm) && t.isIdentifier(arm.argument, { name: param });
}

/** Longest pattern and subject the formatting-probe check is made on; the template's are a fraction of either. */
const MAX_PROBE_PATTERN = 256;
const MAX_PROBE_SUBJECT = 2048;

/**
 * Whether the formatting pattern matches the compact print of `fn` - the
 * text `Function.prototype.toString` gives it in the build the obfuscator
 * emitted, which is the text every tier stands on. A pattern that does not
 * compile is no match; one whose backtracking has no bound over the print
 * (the `(((.+)+)+)+$` trap of the self-defending guard) is `undefined`, and
 * the caller leaves the guard as written rather than pick a branch.
 */
function formattingPatternMatches(pattern: string, fn: t.Function): boolean | undefined {
  if (pattern.length > MAX_PROBE_PATTERN) return false;
  const text = compactSource(fn);
  if (text === undefined || text.length > MAX_PROBE_SUBJECT) return false;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return false;
  }
  const cost = readRegexCost(regex.source, regex.flags);
  if (typeof cost === 'string' || regexWork(cost, text) > MAX_REGEX_WORK) return undefined;
  return regex.test(text);
}

function compactSource(fn: t.Function): string | undefined {
  try {
    const printed = generate(fn, { compact: true, comments: false }).code;
    return printed.length > 0 ? printed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The prologue IIFE of the 0.x decoder, when `fn` holds one: `(function ()
 * { var e = function () { var h; try { h = Function('return this')(); }
 * catch (i) { h = window; } return h; }; var f = e(); var g = 'ABC...';
 * f.atob || (f.atob = function (h) { ... }); }())`. Every statement of it is
 * one of those four shapes, and the polyfilled name is `atob` or `btoa` -
 * a builtin every tier holds, so the write never runs.
 */
export function findGlobalObjectPrologue(fn: t.Function): t.ExpressionStatement | undefined {
  let found: t.ExpressionStatement | undefined;
  eachNode(fn.body, (node) => {
    if (found || !t.isExpressionStatement(node)) return;
    const call = unwrapCall(node.expression);
    const iife = call ? functionOf(call.callee) : undefined;
    if (!call || !iife || call.arguments.length !== 0 || !t.isBlockStatement(iife.body)) return;
    if (isGlobalObjectPrologue(iife.body.body)) found = node;
  });
  return found;
}

function isGlobalObjectPrologue(statements: readonly t.Statement[]): boolean {
  let getter: string | undefined;
  let holder: string | undefined;
  let polyfills = 0;
  for (const statement of statements) {
    if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        if (!t.isIdentifier(declarator.id) || !declarator.init) return false;
        const init = declarator.init;
        if (getter === undefined && functionOf(init) && returnsGlobalObject(functionOf(init)!)) {
          getter = declarator.id.name;
        } else if (getter !== undefined && holder === undefined && t.isCallExpression(init) && t.isIdentifier(init.callee, { name: getter }) && init.arguments.length === 0) {
          holder = declarator.id.name;
        } else if (t.isStringLiteral(init) && isBase64Alphabet(init.value)) {
          continue;
        } else {
          return false;
        }
      }
      continue;
    }
    if (holder !== undefined && isGuardedPolyfill(statement, holder)) {
      polyfills++;
      continue;
    }
    return false;
  }
  return holder !== undefined && polyfills > 0;
}

/** `function () { var h; try { h = <idiom>; } catch (i) { h = window; } return h; }` */
function returnsGlobalObject(fn: t.Function): boolean {
  if (!t.isBlockStatement(fn.body) || fn.params.length !== 0) return false;
  const body = fn.body.body;
  if (body.length !== 3) return false;
  const [declared, tried, returned] = body;
  if (!t.isVariableDeclaration(declared) || declared.declarations.length !== 1) return false;
  const local = declared.declarations[0]!;
  if (!t.isIdentifier(local.id) || local.init) return false;
  const name = local.id.name;
  const assigns = (statement: t.Statement | undefined, value: (node: t.Expression) => boolean): boolean =>
    statement !== undefined &&
    t.isExpressionStatement(statement) &&
    t.isAssignmentExpression(statement.expression) &&
    statement.expression.operator === '=' &&
    t.isIdentifier(statement.expression.left, { name }) &&
    value(statement.expression.right);
  if (!t.isTryStatement(tried) || !tried.handler || tried.finalizer) return false;
  if (tried.block.body.length !== 1 || !assigns(tried.block.body[0], (node) => isGlobalObjectRead(node))) return false;
  const handler = tried.handler.body.body;
  if (handler.length !== 1 || !assigns(handler[0], (node) => t.isIdentifier(node) && GLOBAL_OBJECT_FALLBACKS.has(node.name))) return false;
  return t.isReturnStatement(returned) && t.isIdentifier(returned.argument, { name });
}

/** `f.atob || (f.atob = function ...)`, `f.atob = f.atob || function ...`, `if (!f.atob) f.atob = function ...`. */
function isGuardedPolyfill(statement: t.Statement, holder: string): boolean {
  const property = (node: t.Node): string | undefined =>
    t.isMemberExpression(node) && t.isIdentifier(node.object, { name: holder }) ? propertyName(node) : undefined;
  const polyfilled = (node: t.Node): string | undefined => {
    if (!t.isAssignmentExpression(node) || node.operator !== '=') return undefined;
    const key = property(node.left);
    if (key === undefined || !POLYFILLED_BUILTINS.has(key)) return undefined;
    const value = node.right;
    if (functionOf(value)) return key;
    // `f.atob = f.atob || function ...`
    if (t.isLogicalExpression(value) && value.operator === '||' && property(value.left) === key && functionOf(value.right)) return key;
    return undefined;
  };
  if (t.isExpressionStatement(statement)) {
    const expression = statement.expression;
    if (t.isLogicalExpression(expression) && expression.operator === '||') {
      const key = property(expression.left);
      return key !== undefined && polyfilled(expression.right) === key;
    }
    if (t.isAssignmentExpression(expression)) {
      const key = polyfilled(expression);
      return key !== undefined && t.isLogicalExpression(expression.right);
    }
    return false;
  }
  if (t.isIfStatement(statement) && !statement.alternate) {
    const test = statement.test;
    if (!t.isUnaryExpression(test, { operator: '!' })) return false;
    const key = property(test.argument);
    const arm = t.isBlockStatement(statement.consequent) ? statement.consequent.body[0] : statement.consequent;
    const write = arm && t.isExpressionStatement(arm) ? arm.expression : undefined;
    return key !== undefined && write !== undefined && polyfilled(write) === key && (t.isBlockStatement(statement.consequent) ? statement.consequent.body.length === 1 : true);
  }
  return false;
}

/** The builtins the template polyfills, which every tier's realm holds. */
const POLYFILLED_BUILTINS: ReadonlySet<string> = new Set(['atob', 'btoa']);

/** A deep copy of `fn` with `statement` cut out of whichever block holds it. */
function withoutStatement(fn: t.Function, statement: t.Statement): t.Function {
  const copy = t.cloneNode(fn, true, true);
  const original = new Map<t.Node, t.Node>();
  // The clone and the original walk in the same order; the statement's twin is the node at its position.
  const originals: t.Node[] = [];
  eachNode(fn, (node) => originals.push(node));
  let index = 0;
  eachNode(copy, (node) => {
    original.set(node, originals[index++]!);
  });
  eachNode(copy, (node) => {
    if (!t.isBlockStatement(node)) return;
    const at = node.body.findIndex((own) => original.get(own) === statement);
    if (at >= 0) node.body.splice(at, 1);
  });
  return copy;
}

/** The 0.x rotation: a fixed count of `push(shift())` over the table. */
export interface FixedRotation {
  shifts: number;
  /** The IIFE the rotation runs in: read whole, machinery of the template. */
  fn: t.Function;
  loop: t.Loop;
}

/**
 * `(function (a, b) { var c = function (e) { while (--e) { a.push(a.shift());
 * } }; c(++b); }(T, 0x1a0))`: the count is the literal, since `while (--e)`
 * over `b + 1` shifts `b` times. The call may sit in the `selfDefending`
 * cookie machinery instead - `d()` builds an object whose `getCookie` calls
 * `n(c, b)` over `var n = function (o, p) { o(++p); }`, and runs it only
 * when a formatting pattern matches its own `removeCookie`'s text - which
 * is read for the branch it takes on the compact print.
 */
export function recogniseFixedRotation(statements: readonly t.Statement[], arrayName: string): FixedRotation | null {
  for (const { call, fn, loop } of findRotationLoops(statements)) {
    if (loop || !t.isBlockStatement(fn.body)) continue;
    const table = paramName(fn, 0);
    const count = paramName(fn, 1);
    if (!table || !count || fn.params.length !== 2) continue;
    if (call.arguments.length !== 2 || !t.isIdentifier(call.arguments[0], { name: arrayName })) continue;
    const literal = constantNumber(call.arguments[1] as t.Node);
    if (literal === undefined || !Number.isInteger(literal)) continue;
    const shuffler = findShuffler(fn.body.body, table);
    if (!shuffler) continue;
    const entry = rotationEntry(fn.body.body, shuffler.name, count, literal);
    if (entry === undefined || entry < 1) continue;
    return { shifts: entry - 1, fn, loop: shuffler.loop };
  }
  return null;
}

/** `var c = function (e) { while (--e) { a.push(a.shift()); } }`, in a block. */
function findShuffler(block: readonly t.Statement[], table: string): { name: string; loop: t.Loop } | undefined {
  for (const statement of block) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      const fn = functionOf(declarator.init);
      if (!fn || !t.isIdentifier(declarator.id) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) continue;
      if (!t.isBlockStatement(fn.body) || fn.body.body.length !== 1) continue;
      const loop = fn.body.body[0]!;
      if (!t.isWhileStatement(loop)) continue;
      const test = loop.test;
      if (!t.isUpdateExpression(test) || test.operator !== '--' || !test.prefix || !t.isIdentifier(test.argument, { name: fn.params[0].name })) continue;
      const body = t.isBlockStatement(loop.body) ? loop.body.body : [loop.body];
      if (body.length !== 1 || !t.isExpressionStatement(body[0]!) || !isShuffleOf(body[0]!.expression, table)) continue;
      return { name: declarator.id.name, loop };
    }
  }
  return undefined;
}

/** `a.push(a.shift())` over the name. */
function isShuffleOf(node: t.Node, table: string): boolean {
  if (!isMemberCall(node, 'push') || node.arguments.length !== 1) return false;
  const shifted = node.arguments[0]!;
  if (!isMemberCall(shifted, 'shift') || shifted.arguments.length !== 0) return false;
  return t.isIdentifier((node.callee as t.MemberExpression).object, { name: table }) && t.isIdentifier((shifted.callee as t.MemberExpression).object, { name: table });
}

/**
 * The argument the shuffler is entered with, as a number, when the call is
 * a statement of the IIFE's own body or of the cookie machinery's
 * `getCookie` on the branch the compact print takes; `undefined` for a call
 * anywhere else, or none.
 */
function rotationEntry(block: readonly t.Statement[], shuffler: string, count: string, literal: number): number | undefined {
  const argument = (node: t.Node): number | undefined => {
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isIdentifier(node, { name: count })) return literal;
    if (t.isUpdateExpression(node) && node.prefix && t.isIdentifier(node.argument, { name: count })) return node.operator === '++' ? literal + 1 : literal - 1;
    if (t.isBinaryExpression(node) && (node.operator === '+' || node.operator === '-') && t.isIdentifier(node.left, { name: count }) && t.isNumericLiteral(node.right)) {
      return node.operator === '+' ? literal + node.right.value : literal - node.right.value;
    }
    return undefined;
  };
  /** `c(++b)` as a statement of `own`. */
  const directCall = (own: readonly t.Statement[]): number | undefined => {
    for (const statement of own) {
      if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) continue;
      const call = statement.expression;
      if (t.isIdentifier(call.callee, { name: shuffler }) && call.arguments.length === 1) return argument(call.arguments[0]!);
    }
    return undefined;
  };
  const direct = directCall(block);
  if (direct !== undefined) return direct;

  // The cookie machinery: `var d = function () { ... }; d();`
  for (const statement of block) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      const machinery = functionOf(declarator.init);
      if (!machinery || !t.isIdentifier(declarator.id) || !t.isBlockStatement(machinery.body) || machinery.params.length !== 0) continue;
      const name = declarator.id.name;
      const invoked = block.some(
        (own) => t.isExpressionStatement(own) && t.isCallExpression(own.expression) && t.isIdentifier(own.expression.callee, { name }) && own.expression.arguments.length === 0,
      );
      if (!invoked) continue;
      const entry = cookieEntry(machinery.body.body, shuffler, count, literal, argument);
      if (entry !== undefined) return entry;
    }
  }
  return undefined;
}

/**
 * Inside the machinery: `var e = { ..., removeCookie: function () { return
 * '...'; }, getCookie: function (i, j) { ...; var n = function (o, p) { o(++p);
 * }; n(c, b); ... } }; var f = function () { var i = new RegExp('...'); return
 * i.test(e.removeCookie.toString()); }; e.updateCookie = f; var h =
 * e.updateCookie(); if (!h) { ... } else if (h) { ... e.getCookie(...) ... } else {
 * ... }`. The rotation is entered when the pattern matches `removeCookie`'s
 * compact print, and it does on the build the obfuscator emitted.
 */
function cookieEntry(
  body: readonly t.Statement[],
  shuffler: string,
  count: string,
  literal: number,
  argument: (node: t.Node) => number | undefined,
): number | undefined {
  // The object literal holding the methods.
  let holder: string | undefined;
  let literalObject: t.ObjectExpression | undefined;
  for (const statement of body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      if (t.isIdentifier(declarator.id) && t.isObjectExpression(declarator.init)) {
        holder = declarator.id.name;
        literalObject = declarator.init;
      }
    }
  }
  if (!holder || !literalObject) return undefined;
  const methods = new Map<string, t.Function>();
  for (const property of literalObject.properties) {
    if (t.isObjectMethod(property)) {
      const key = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : undefined;
      if (key !== undefined) methods.set(key, property);
    } else if (t.isObjectProperty(property) && !property.computed) {
      const key = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : undefined;
      const fn = functionOf(property.value);
      if (key !== undefined && fn) methods.set(key, fn);
    }
  }

  // Which method enters the rotation, and with what.
  let entered: { method: string; value: number } | undefined;
  for (const [key, fn] of methods) {
    if (!t.isBlockStatement(fn.body)) continue;
    for (const statement of fn.body.body) {
      if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) continue;
      const call = statement.expression;
      if (!t.isIdentifier(call.callee)) continue;
      if (call.callee.name === shuffler && call.arguments.length === 1) {
        const value = argument(call.arguments[0]!);
        if (value !== undefined) entered = { method: key, value };
        continue;
      }
      // `n(c, b)` over `var n = function (o, p) { o(++p); }` declared beside it.
      if (call.arguments.length !== 2 || !t.isIdentifier(call.arguments[0], { name: shuffler })) continue;
      const forwarderName = call.callee.name;
      const forwarder = fn.body.body.find(
        (own): own is t.VariableDeclaration =>
          t.isVariableDeclaration(own) && own.declarations.some((declarator) => t.isIdentifier(declarator.id, { name: forwarderName })),
      );
      const forwarderFn = forwarder ? functionOf(forwarder.declarations.find((declarator) => t.isIdentifier(declarator.id, { name: forwarderName }))!.init) : undefined;
      if (!forwarderFn || forwarderFn.params.length !== 2 || !t.isIdentifier(forwarderFn.params[0]) || !t.isIdentifier(forwarderFn.params[1])) continue;
      if (!t.isBlockStatement(forwarderFn.body) || forwarderFn.body.body.length !== 1) continue;
      const inner = forwarderFn.body.body[0]!;
      if (!t.isExpressionStatement(inner) || !t.isCallExpression(inner.expression)) continue;
      const innerCall = inner.expression;
      if (!t.isIdentifier(innerCall.callee, { name: forwarderFn.params[0].name }) || innerCall.arguments.length !== 1) continue;
      const passed = innerCall.arguments[0]!;
      const second = forwarderFn.params[1].name;
      let value: number | undefined;
      if (t.isUpdateExpression(passed) && passed.prefix && t.isIdentifier(passed.argument, { name: second })) {
        value = passed.operator === '++' ? 1 : -1;
      } else if (t.isIdentifier(passed, { name: second })) {
        value = 0;
      }
      const given = argument(call.arguments[1]!);
      if (value === undefined || given === undefined) continue;
      entered = { method: key, value: given + value };
    }
  }
  if (!entered) return undefined;

  // `var f = function () { var i = new RegExp('...'); return i.test(e.removeCookie.toString()); }; e.updateCookie = f; var h = e.updateCookie();`
  let probe: { pattern: string; probed: string } | undefined;
  for (const statement of body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      const fn = functionOf(declarator.init);
      if (!fn || !t.isBlockStatement(fn.body) || fn.body.body.length !== 2) continue;
      const [declared, returned] = fn.body.body;
      if (!t.isVariableDeclaration(declared) || declared.declarations.length !== 1 || !t.isReturnStatement(returned)) continue;
      const regexDeclarator = declared.declarations[0]!;
      if (!t.isIdentifier(regexDeclarator.id) || !t.isNewExpression(regexDeclarator.init) || !t.isIdentifier(regexDeclarator.init.callee, { name: 'RegExp' })) continue;
      const patternNode = regexDeclarator.init.arguments[0];
      if (!patternNode || !t.isStringLiteral(patternNode) || regexDeclarator.init.arguments.length !== 1) continue;
      const test = returned.argument;
      if (!test || !isMemberCall(test, 'test') || test.arguments.length !== 1) continue;
      if (!t.isIdentifier((test.callee as t.MemberExpression).object, { name: regexDeclarator.id.name })) continue;
      const subject = test.arguments[0]!;
      if (!isMemberCall(subject, 'toString') || subject.arguments.length !== 0) continue;
      const method = (subject.callee as t.MemberExpression).object;
      if (!t.isMemberExpression(method) || !t.isIdentifier(method.object, { name: holder })) continue;
      const probed = propertyName(method);
      if (probed === undefined) continue;
      probe = { pattern: patternNode.value, probed };
    }
  }
  if (!probe) return undefined;
  const probedFn = methods.get(probe.probed);
  if (!probedFn) return undefined;
  const matches = formattingPatternMatches(probe.pattern, probedFn);
  if (matches === undefined) return undefined;

  // The branch taken: `if (!h) { ... } else if (h) { ... } else { ... }`, with the entering method called in one arm.
  for (const statement of body) {
    if (!t.isIfStatement(statement)) continue;
    const arms: { taken: boolean; body: t.Statement }[] = [];
    let current: t.Statement | null | undefined = statement;
    while (current && t.isIfStatement(current)) {
      const truthy = isNegationOf(current.test) ? false : t.isIdentifier(current.test) ? true : undefined;
      if (truthy === undefined) return undefined;
      arms.push({ taken: matches === truthy, body: current.consequent });
      current = current.alternate;
    }
    if (current) arms.push({ taken: false, body: current });
    const taken = arms.find((arm) => arm.taken);
    if (!taken) return undefined;
    let enters = false;
    eachNode(taken.body, (node) => {
      if (isMemberCall(node, entered!.method) && t.isIdentifier((node.callee as t.MemberExpression).object, { name: holder })) enters = true;
    });
    // The other arms must not enter it either way: the count is the taken arm's alone.
    return enters ? entered.value : undefined;
  }
  return undefined;
}

function isNegationOf(test: t.Expression): boolean {
  return t.isUnaryExpression(test, { operator: '!' }) && t.isIdentifier(test.argument);
}

// ---------------------------------------------------------------------------
// The tier entry point
// ---------------------------------------------------------------------------

/**
 * Recognise the decoder in an evaluation slice, or return null.
 *
 * `roots` are the names the caller cares about; when several candidates match the
 * one the caller named wins, because a slice can legitimately contain more than
 * one array (split string arrays, or a nested module's own decoder).
 */
export function recogniseNativeDecoder(
  slice: SliceResult,
  roots: readonly string[],
): NativeDecoder | null {
  const statements = slice.statements;
  const rootSet = new Set(roots);
  eraseTypeWrappers(statements);

  // A name the slice defines twice has one definition that runs and one that
  // does not, and which is which is decided by hoisting, not by reading order:
  // a later `function` wins the whole scope, a later `var` wins from the point
  // it executes. Every recogniser below takes the first spelling it meets, so
  // on `function d(i) { return t[i]; } ... function d() { return [...]; }` it
  // decodes call sites against the declaration the program never calls. This
  // is what concatenating independently obfuscated files produces whenever
  // their hexadecimal names collide.
  const contested = multiplyDefined(statements);
  if (roots.some((root) => contested.has(root))) return null;

  // A packed blob first: it is the one family with no array of strings anywhere,
  // so every recogniser below would return null for it, and its own shape test
  // (a two-parameter span over a long literal, unpacked through a long distinct
  // alphabet whose parameters are mutually consistent) is far too specific to
  // fire on anything else.
  const blob = recogniseBlobDecoder(statements, roots);
  if (blob) return contested.has(blob.name) ? null : blob;

  const arrays = recogniseStringArray(statements);
  if (arrays.length === 0) return null;
  const array =
    arrays.find((candidate) => rootSet.has(candidate.name)) ??
    arrays.reduce((best, candidate) => (candidate.values.length > best.values.length ? candidate : best));
  if (contested.has(array.name)) return null;

  const wrapper = findWrapper(statements, array.name, rootSet);
  if (wrapper && contested.has(wrapper.name)) return null;

  const rotated = hasRotationLoop(statements);

  if (!wrapper) {
    // (a) The array is indexed directly at call sites. With no decoder to drive
    // the checksum there is nothing to solve a rotation against, so a rotation
    // loop here is an outright refusal.
    if (rotated) return null;
    return assembleDecoder(array.name, 'array-index', array.values, 0, 0, {
      algorithm: 'plain',
      evidence: 'direct array index',
    });
  }

  const replaced = unwrapSelfReplacing(wrapper.fn, wrapper.name);
  // The 0.x prologue is dead code under every tier's realm (see recogniser
  // g), and its alphabet and `Function` call would read as a second base64
  // and an unaccounted callee; the facts are read off the body without it.
  const prologue = findGlobalObjectPrologue(replaced);
  const body = prologue ? withoutStatement(replaced, prologue) : replaced;
  // (c) Every recogniser below reads FACTS off the body - strings, callees,
  // members, xors - and none of them asks whether control can reach the
  // `return` those facts describe. `function d(i) { throw new Error('boom');
  // return t[i]; }` therefore decodes, and the output runs cleanly where the
  // input threw on the first call, with `verified: true` and no diagnostic. The
  // interpreter tier gets this right for free because it runs the body; this is
  // the cheapest thing that gets it right without running anything.
  if (!returnIsReachable(body)) return null;
  const offset = recogniseIndexOffset(body);
  const encoding = recogniseEncoding(body);
  if (!encoding) return null;
  // (c) Those facts know a call by its callee's name, so a call made any other
  // way is a transform no fact describes. `return call(decodeURIComponent, s)`
  // through `function call(f, x) { return f(x); }` is the UTF-8 step handed to
  // a helper; read without it the body is "base64, latin1", and every
  // non-ASCII string comes out as mojibake with the evidence to match. A callee
  // the recognisers did not account for is not a near miss - the structural
  // match is not a match. And a name is only the builtin while the slice does
  // not bind it: `var decodeURIComponent = function (s) { return unescape(s); }`
  // beside the decoder reads as the UTF-8 step and runs as the latin1 one.
  // Asked after the encoding is known, since what accounts for a builtin is
  // the shape that read it and not its name.
  if (!callsAreAccountedFor(body, new Set([array.name, wrapper.name]), slice.definedNames, encoding)) {
    return null;
  }
  // A method call is a call too. The plain lookup already refuses any
  // string-rewriting method; each cipher is built from a few, and one outside
  // that few - a `toUpperCase` in a helper the body declares - is a layer the
  // classification does not have.
  if (!methodsAreAccountedFor(body, encoding)) return null;
  // (a) "Index lookup" is a claim about the index as much as the table, and
  // `recogniseEncoding` only looked at the table side: with nothing rewriting
  // the string it said `plain`, and `t[i + k]` decoded as `t[i]` whatever `k`
  // was - a getter, a class's static, `new Date()` arithmetic. Every other
  // algorithm has its own shape gate; this is the plain lookup's.
  if (encoding.algorithm === 'plain' && !indexesByParameter(body, offset)) return null;
  if (encoding.algorithm !== 'plain' && movedTwice(body)) return null;

  const makeDecode = (rotation: number) => makeElementDecoder(array.values, offset, encoding, rotation);

  // (b) An unsolved rotation is not a rotation of zero. If the loop is there and
  // where it lands cannot be computed, refuse: shipping the unrotated array maps
  // every call site to a real-looking but wrong string.
  let rotation = 0;
  let solvedRotation: SolvedRotation | undefined;
  // The accessor is read for its table and the forwarders for their
  // arithmetic, neither for a loop: they are the shape's callees, not its
  // subtrees, so a loop inside one is still nobody's.
  const callees: t.Function[] = array.fn ? selfReplacements(array.fn, array.name) : [];
  const modelled: ModelledCode = { subtrees: [wrapper.fn], loops: [], callees };
  if (rotated) {
    const puzzle = recogniseRotationPuzzle(statements, new Set([wrapper.name, array.name]));
    if (puzzle) {
      const solved = solveRotation(puzzle, array.values, makeDecode);
      if (solved === null) return null;
      rotation = solved;
      modelled.loops = [puzzle.loop];
      for (const forwarder of puzzle.forwarders.values()) callees.push(forwarder.fn);
      const shuffle = findShuffle(puzzle.loop);
      if (shuffle && puzzle.exact) {
        solvedRotation = { loop: puzzle.loop, shifts: solved, terms: checksumTerms(puzzle, makeDecode(solved)), shuffle };
      }
    } else {
      // Not a checksum: the 0.x count, read whole (recogniser g), or nothing.
      const fixed = recogniseFixedRotation(statements, array.name);
      if (!fixed) return null;
      rotation = fixed.shifts;
      modelled.loops = [fixed.loop];
      modelled.subtrees = [wrapper.fn, fixed.fn];
    }
  }

  return assembleDecoder(wrapper.name, 'wrapper-call', array.values, offset, rotation, encoding, modelled, solvedRotation);
}

/**
 * The first loop in `statements` the recogniser did not read; see
 * `NativeDecoder.modelled`. Every loop under a modelled subtree is the
 * shape's; a modelled loop is, but a loop nested inside one is judged on its
 * own, since the checksum was solved as arithmetic over the loop's
 * straight-line body and not by running whatever else the body holds.
 */
export function unmodelledLoop(
  statements: readonly t.Statement[],
  modelled: ModelledCode,
): t.Statement | undefined {
  const subtrees = new Set(modelled.subtrees);
  const loops = new Set(modelled.loops);
  const stack: t.Node[] = [...statements].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (subtrees.has(node)) continue;
    if (t.isLoop(node) && !loops.has(node)) return node;
    for (const key of [...(t.VISITOR_KEYS[node.type] ?? [])].reverse()) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (let index = child.length - 1; index >= 0; index--) {
          const item = child[index] as t.Node | null;
          if (item && typeof item.type === 'string') stack.push(item);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return undefined;
}

/**
 * Whether every index this body computes is its first parameter, moved only
 * by the offset `recogniseIndexOffset` read off it.
 *
 * Two things have to hold for `t[i]` to mean what the plain decoder claims:
 * `i` is never written except by a constant, and every computed index is `i`
 * or `i ± c` such that the writes and the `c` together move it by exactly
 * the recognised offset. Either one alone is hollow - `t[i + n]` fails the
 * second, `i = f(i); return t[i]` the first - and both are shapes the
 * recognisers otherwise read straight past. Summing the two is what catches
 * `i = i - 0x10; return t[i - 0x10]`, where the offset recogniser took the
 * assignment and stopped. A `['name']` subscript is a property, not an
 * index, and is left alone.
 */
function indexesByParameter(fn: t.Function, offset: number): boolean {
  const param = paramName(fn, 0);
  if (!param) return false;

  /** How far `expression` moves `param` down, or undefined when it is not `param ± constant`. */
  const subtracted = (expression: t.Node): number | undefined => {
    if (t.isIdentifier(expression, { name: param })) return 0;
    if (!t.isBinaryExpression(expression) || !t.isIdentifier(expression.left, { name: param })) {
      return undefined;
    }
    const amount = constantNumber(expression.right);
    if (amount === undefined) return undefined;
    if (expression.operator === '-') return amount;
    if (expression.operator === '+') return -amount;
    return undefined;
  };

  let moved = 0;
  let plain = true;
  eachNode(fn.body, (node) => {
    if (!plain) return;
    if (t.isAssignmentExpression(node) && t.isIdentifier(node.left, { name: param })) {
      const amount =
        node.operator === '=' ? subtracted(node.right) : constantNumber(node.right);
      if (amount === undefined || (node.operator !== '=' && node.operator !== '-=' && node.operator !== '+=')) {
        plain = false;
        return;
      }
      moved += node.operator === '+=' ? -amount : amount;
    } else if (t.isUpdateExpression(node) && t.isIdentifier(node.argument, { name: param })) {
      plain = false;
    }
  });
  if (!plain) return false;

  eachNode(fn.body, (node) => {
    if (!plain || !t.isMemberExpression(node) || !node.computed) return;
    if (t.isStringLiteral(node.property)) return;
    const amount = subtracted(node.property);
    if (amount === undefined || moved + amount !== offset) plain = false;
  });
  return plain;
}

/**
 * Whether every call this body makes is one the recognisers read.
 *
 * `collectBodyFacts` knows a call by its callee's name, and a method by the
 * name it is spelled with. `decodeURIComponent` and `atob` are the byte-mode
 * evidence - as long as they are the builtins, which they are only while
 * nothing in the slice declares the name; the table accessor and the decoder
 * itself are `accounted` by the caller; a function the body declares - the
 * base64 helper the rc4 one calls - was walked along with everything else;
 * and a `selfDefending` build calls the decoder back through a parameter of
 * its tamper probe, so a parameter of a function nested in the body is a name
 * the body binds too. A callee bound *outside* the body, whatever it does, is
 * a call no fact describes.
 *
 * Neither is a call made by any route but its name. `f?.()` the facts never
 * visit, so `decodeURIComponent?.(s)` reads as no UTF-8 step and
 * `s?.['toUpperCase']()` as no method; a route `invocation` sees through
 * - `f.call(...)`, `f.apply(...)`, `f.bind(...)()`, `Reflect.apply(f, ...)`, a
 * sequence or a conditional in callee position - invokes something the
 * facts read as a method named `call` or as no call at all; `o[k](...)` has
 * no method name to read; and a callee that is itself an expression has no
 * name at all. A builtin spelled as somebody's method -
 * `o.decodeURIComponent(s)` - is not the builtin either: the only objects
 * that hold it are the ones outside the slice's allowlist.
 *
 * The same goes for a builtin the body holds rather than calls: passed as an
 * argument, it is invoked by a route no fact reads, and a body that declares
 * a name of its own over one has the facts reading the wrong function.
 *
 * A builtin is accounted for by the shape that read it, not by its name:
 * `decodeURIComponent` is the base64 family's byte mode or the plain
 * lookup's percent step, `atob` the base64 the recogniser took for the
 * loop, and each is a call the encoding explains only when the encoding
 * says so. `Boolean` is the one exception, being the coercion the
 * `selfDefending` probe wraps its counter in: it yields a boolean, and no
 * boolean is part of a string.
 */
function callsAreAccountedFor(
  fn: t.Function,
  accounted: ReadonlySet<string>,
  sliceDefined: ReadonlySet<string>,
  encoding: EncodingRecognition,
): boolean {
  const explained = new Set<string>(['Boolean']);
  if (encoding.base64?.byteMode === 'utf8') explained.add('decodeURIComponent');
  if (encoding.base64?.viaAtob) explained.add('atob');
  if (encoding.percent) explained.add(encoding.percent);
  /** Names the body binds to something callable: its functions, nested parameters. */
  const bound = new Set<string>();
  /** Every name the body binds, the decoder's own parameters included. */
  const declared = new Set<string>();
  const callees: t.Identifier[] = [];
  /** Identifiers that name something rather than read it: callees, receivers, keys. */
  const named = new Set<t.Node>();
  /** A call reached by a route the facts do not read. */
  let routed = false;

  for (const param of fn.params) {
    for (const name of Object.keys(t.getBindingIdentifiers(param))) declared.add(name);
  }
  eachNode(fn.body, (node) => {
    if (t.isFunctionDeclaration(node) && node.id) bound.add(node.id.name);
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && functionOf(node.init)) {
      bound.add(node.id.name);
    }
    if (t.isFunction(node)) {
      for (const param of node.params) {
        for (const name of Object.keys(t.getBindingIdentifiers(param))) {
          bound.add(name);
          declared.add(name);
        }
      }
    }
    if (t.isDeclaration(node) || t.isCatchClause(node)) {
      for (const name of Object.keys(t.getBindingIdentifiers(node))) declared.add(name);
    }
    if (t.isOptionalCallExpression(node)) {
      routed = true;
    } else if (t.isCallExpression(node) || t.isNewExpression(node)) {
      const callee = node.callee;
      // A call `invocation` sees through to anything but its spelled
      // callee is a route the facts do not read.
      const invoked = invocation(callee, undefined, node.arguments, 0);
      if (!invoked || invoked.fns.length !== 1 || invoked.fns[0] !== callee) routed = true;
      if (t.isIdentifier(callee)) {
        named.add(callee);
        if (t.isCallExpression(node)) callees.push(callee);
      } else if (t.isCallExpression(node)) {
        if (t.isMemberExpression(callee)) {
          // A `bind` not called at once hands the receiver on to a call elsewhere.
          const method = propertyName(callee);
          if (method === undefined || method === 'bind' || MODELLED_CALLEES.has(method)) routed = true;
        } else if (!functionOf(callee)) {
          routed = true;
        }
      }
    } else if (t.isMemberExpression(node)) {
      if (t.isIdentifier(node.object)) named.add(node.object);
      if (!node.computed) named.add(node.property);
    } else if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && !node.computed) {
      named.add(node.key);
    }
  });
  if (routed) return false;

  for (const callee of callees) {
    const name = callee.name;
    if (explained.has(name)) {
      if (sliceDefined.has(name)) return false;
      continue;
    }
    if (accounted.has(name) || bound.has(name)) continue;
    return false;
  }
  for (const name of CALLABLE_GLOBALS) if (declared.has(name)) return false;

  let held = false;
  eachNode(fn.body, (node) => {
    if (held || !t.isIdentifier(node) || named.has(node)) return;
    if (CALLABLE_GLOBALS.has(node.name)) held = true;
  });
  return !held;
}

/**
 * Builtins a decoder body may call by name, whichever shape it has: the
 * byte-mode and percent-step evidence `recogniseEncoding` reads, and the
 * coercion the `selfDefending` probe wraps its counter in. Spelled as a
 * method they are somebody else's, never the builtin.
 */
const MODELLED_CALLEES = new Set(['decodeURIComponent', 'decodeURI', 'unescape', 'atob', 'Boolean']);

/**
 * The callable part of the slice's global allowlist: what a body could hand
 * to a helper instead of calling. `Math` and `JSON` are only ever receivers,
 * and `undefined` is only ever compared, so they are not here.
 */
const CALLABLE_GLOBALS = new Set([
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'RegExp',
  'Date',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'decodeURIComponent',
  'encodeURIComponent',
  'decodeURI',
  'encodeURI',
  'unescape',
  'escape',
  'atob',
  'btoa',
  'Error',
  'TypeError',
]);

/**
 * Whether every string-rewriting method the body calls is one the recognised
 * algorithm is written with.
 *
 * The plain lookup was settled in `recogniseEncoding`, which refuses it on any
 * such method. The ciphers are all spelled out of the same handful - the
 * alphabet loop's `charAt` and `fromCharCode`, the percent-encoding's
 * `charCodeAt` and `slice`, an `atob` in place of the loop - and a ROT adds
 * the `replace` it is written as. Anything else in `TRANSFORM_MEMBERS` is a
 * rewrite the classification did not name, whichever helper it sits in.
 */
function methodsAreAccountedFor(fn: t.Function, encoding: EncodingRecognition): boolean {
  if (encoding.algorithm === 'plain') return true;
  const written = encoding.algorithm === 'rot' ? ROT_METHODS : CIPHER_METHODS;
  let unexplained = false;
  eachNode(fn.body, (node) => {
    if (unexplained || !t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
    const method = propertyName(node.callee);
    if (method && TRANSFORM_MEMBERS.has(method) && !written.has(method)) unexplained = true;
  });
  return !unexplained;
}

const CIPHER_METHODS = new Set(['atob', 'charAt', 'charCodeAt', 'fromCharCode', 'slice']);
const ROT_METHODS = new Set([...CIPHER_METHODS, 'replace']);

/**
 * Whether control can get from the top of this body to a `return` at all.
 *
 * Only the two unconditional shapes, walked over the body's own statement list
 * the way `findSliceTrap` walks a slice's: a `throw` and a loop with no exit,
 * either of which planted ahead of the return makes the decoder a tripwire
 * rather than a decoder. Anything conditional is left alone - a `throw`
 * inside an `if` is ordinary defensive code and refusing it would cost real
 * decoders - and so is a body whose `return` sits under one, which reads as
 * reachable here and is exactly what the recognisers already assume. A bare
 * block is not conditional: `{ throw x; }` runs exactly as `throw x;` does,
 * and so does a `do { ... } while (true)`, which is the same trap as `while
 * (true)` with the test written after the body.
 *
 * And whether there is a `return` to get to. A walk that meets neither a
 * trap nor a `return` has fallen off the end of a body that returns
 * `undefined` on every call, and the facts read off such a body are the
 * facts of a decoder with the `return` cut out: `function b(c) { c = c -
 * 0x128; var e = a(); }` moved its parameter by the recognised offset,
 * indexed nothing, rewrote nothing, and was "index lookup, index offset
 * 296" - with the interpreter out of budget on the loop beside it, the
 * match stood unchecked at balanced and the file's hang was deleted with
 * the machinery. A `return` under an `if` or in a `try` counts, since the
 * walk above does not look there; one inside a nested function is that
 * function's.
 */
function returnIsReachable(fn: t.Function): boolean {
  if (!t.isBlockStatement(fn.body)) return true;
  return findSliceTrap(fn.body.body) === undefined && returnsAValue(fn.body);
}

/** Whether `body` holds a `return` with a value that is its own function's, at any depth short of a nested function. */
function returnsAValue(body: t.BlockStatement): boolean {
  const stack: t.Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (t.isReturnStatement(node)) {
      if (node.argument) return true;
      continue;
    }
    if (t.isFunction(node)) continue;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return false;
}

/** A statement the slice cannot run past, and what it is. */
export interface SliceTrap {
  statement: t.Statement;
  what: 'a loop with no exit' | 'an unconditional throw';
}

/**
 * The first trap on the straight-line path through the slice's own
 * statements: the walk `returnIsReachable` makes over a decoder body, made
 * over the statements the tiers run before any decoder is called, and into
 * the body of every function those statements call on the spot.
 *
 * The rotation IIFE is where such a trap sits in a real file. obfuscator.io's
 * carries a `break` and is no trap; a slice whose IIFE is `while (!![]) { try
 * {} catch (g) {} }` or `throw new Error('tamper')` never gets as far as a
 * decoder, and neither must the output: the interpreter runs out of budget
 * or refuses on it, and what stood after that was the native reading, with
 * the machinery - and the program's hang or throw - pruned. A `throw` inside
 * a `try` is caught and is not one; a loop with no exit inside one still
 * never ends.
 */
export function findSliceTrap(statements: readonly t.Statement[]): SliceTrap | undefined {
  return trapIn(statements, false);
}

function trapIn(statements: readonly t.Statement[], caught: boolean): SliceTrap | undefined {
  for (const statement of statements) {
    if (t.isReturnStatement(statement)) return undefined;
    if (t.isThrowStatement(statement) && !caught) return { statement, what: 'an unconditional throw' };
    if (isInescapableLoop(statement)) return { statement, what: 'a loop with no exit' };
    let inner: SliceTrap | undefined;
    if (t.isBlockStatement(statement)) {
      inner = trapIn(statement.body, caught);
    } else if (t.isTryStatement(statement)) {
      inner =
        trapIn(statement.block.body, caught || statement.handler !== null) ??
        (statement.finalizer ? trapIn(statement.finalizer.body, caught) : undefined);
    } else if (t.isExpressionStatement(statement)) {
      for (const fn of calledOnTheSpot(statement.expression)) {
        if (t.isBlockStatement(fn.body)) inner ??= trapIn(fn.body.body, false);
      }
    } else if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        if (!declarator.init) continue;
        for (const fn of calledOnTheSpot(declarator.init)) {
          if (t.isBlockStatement(fn.body)) inner ??= trapIn(fn.body.body, false);
        }
      }
    }
    if (inner) return inner;
  }
  return undefined;
}

/** The function expressions `expression` calls as it is evaluated: `(function () {...})()`, `!function () {...}()`, `(a(), (() => {...})())`. */
function calledOnTheSpot(expression: t.Expression): t.Function[] {
  const found: t.Function[] = [];
  const visit = (node: t.Expression, depth: number): void => {
    if (depth > 4) return;
    if (t.isSequenceExpression(node)) {
      for (const part of node.expressions) visit(part, depth + 1);
    } else if (t.isUnaryExpression(node)) {
      visit(node.argument, depth + 1);
    } else if (t.isCallExpression(node)) {
      const fn = functionOf(node.callee);
      if (fn) found.push(fn);
    }
  };
  visit(expression, 0);
  return found;
}

/** A `while (true)` / `do ... while (true)` / `for (;;)` with nothing inside it that could leave. */
function isInescapableLoop(statement: t.Statement): boolean {
  let body: t.Statement | undefined;
  if (t.isWhileStatement(statement) || t.isDoWhileStatement(statement)) {
    if (isAlwaysTruthy(statement.test)) body = statement.body;
  } else if (t.isForStatement(statement)) {
    if (!statement.test || isAlwaysTruthy(statement.test)) body = statement.body;
  }
  if (!body) return false;

  // Any exit at all, at any depth, counts - a `break` belonging to a nested
  // loop, or a `return` inside a nested function, reads as an exit here, which
  // errs towards accepting the decoder rather than refusing a real one.
  let escapes = false;
  eachNode(body, (node) => {
    if (t.isBreakStatement(node) || t.isReturnStatement(node) || t.isThrowStatement(node)) {
      escapes = true;
    }
  });
  return !escapes;
}

/** The loop conditions an obfuscator writes for "forever": `true`, `1`, `!![]`. */
function isAlwaysTruthy(test: t.Expression): boolean {
  if (t.isBooleanLiteral(test)) return test.value;
  if (t.isNumericLiteral(test)) return test.value !== 0;
  if (t.isStringLiteral(test)) return test.value.length > 0;
  if (t.isUnaryExpression(test, { operator: '!' }) && t.isUnaryExpression(test.argument, { operator: '!' })) {
    const inner = test.argument.argument;
    return t.isArrayExpression(inner) || t.isObjectExpression(inner);
  }
  return false;
}

/**
 * True when the slice contains the self-shuffling `push(shift())` loop.
 *
 * Checked separately from solving it, because "there is a rotation but its
 * checksum could not be read" and "there is no rotation" must lead to opposite
 * decisions.
 */
function hasRotationLoop(statements: readonly t.Statement[]): boolean {
  return findRotationLoops(statements).length > 0;
}

/**
 * Top-level IIFEs that shuffle an array with `push(shift())`. The marker is the
 * shuffle itself rather than the `while(!![])` wrapper, because the loop
 * condition is written half a dozen different ways across obfuscator versions
 * while the shuffle never changes.
 */
function findRotationLoops(
  statements: readonly t.Statement[],
): { call: t.CallExpression; fn: t.Function; loop: t.Loop | undefined }[] {
  const loops: { call: t.CallExpression; fn: t.Function; loop: t.Loop | undefined }[] = [];
  for (const statement of statements) {
    if (!t.isExpressionStatement(statement)) continue;
    const call = unwrapCall(statement.expression);
    const fn = call ? functionOf(call.callee) : undefined;
    if (!call || !fn || !shuffles(fn.body)) continue;

    // The loop the shuffle runs in is a statement of the IIFE's own body in
    // every build seen; a shuffle anywhere else - in a helper the IIFE
    // declares - is a rotation this recogniser cannot place, and is kept
    // here so that it is refused rather than read as none.
    const loop = t.isBlockStatement(fn.body)
      ? fn.body.body.find((own): own is t.Loop => t.isLoop(own) && shuffles(own))
      : undefined;
    loops.push({ call, fn, loop });
  }
  return loops;
}

/** Whether `root` holds an `x.push(x.shift())`. */
function shuffles(root: t.Node): boolean {
  let found = false;
  eachNode(root, (node) => {
    if (
      isMemberCall(node, 'push') &&
      node.arguments.length === 1 &&
      isMemberCall(node.arguments[0]!, 'shift')
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * Names given more than one definition by the slice's own statements - two
 * declarations, or a declaration and a top-level reassignment. A definition
 * nested inside a function body is not counted: the self-replacing
 * `d = function () { ... }` obfuscator.io writes inside `d` is the shape
 * `unwrapSelfReplacing` follows, not a second `d`.
 */
function multiplyDefined(statements: readonly t.Statement[]): Set<string> {
  const seen = new Set<string>();
  const contested = new Set<string>();
  const define = (name: string): void => {
    if (seen.has(name)) contested.add(name);
    seen.add(name);
  };

  for (const statement of statements) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      define(statement.id.name);
    } else if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        // A bare `var x;` defines nothing; the assignment that follows it does.
        if (t.isIdentifier(declarator.id) && declarator.init) define(declarator.id.name);
      }
    } else if (t.isExpressionStatement(statement)) {
      const expression = statement.expression;
      if (t.isAssignmentExpression(expression) && t.isIdentifier(expression.left)) {
        define(expression.left.name);
      }
    }
  }
  return contested;
}

interface WrapperRecognition {
  name: string;
  fn: t.Function;
}

/** The function call sites go through, as opposed to the array accessor itself. */
function findWrapper(
  statements: readonly t.Statement[],
  arrayName: string,
  roots: ReadonlySet<string>,
): WrapperRecognition | null {
  const candidates: WrapperRecognition[] = [];

  const consider = (name: string, fn: t.Function | undefined): void => {
    if (!fn || name === arrayName || fn.params.length === 0) return;
    let touchesArray = false;
    eachNode(fn.body, (node) => {
      if (t.isIdentifier(node, { name: arrayName })) touchesArray = true;
    });
    if (touchesArray) candidates.push({ name, fn });
  };

  for (const statement of statements) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      consider(statement.id.name, statement);
    } else if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        if (t.isIdentifier(declarator.id)) consider(declarator.id.name, functionOf(declarator.init));
      }
    }
  }

  return candidates.find((candidate) => roots.has(candidate.name)) ?? candidates[0] ?? null;
}

/**
 * Compose the recognised offset and encoding into one element decoder, over
 * the table as `rotation` left-rotations of `push(shift())` leave it: what
 * `rotateArray` would put at a slot, read without making the array.
 */
function makeElementDecoder(
  values: readonly string[],
  offset: number,
  encoding: EncodingRecognition,
  rotation = 0,
): (args: readonly (string | number)[]) => string | undefined {
  const length = values.length;
  const shift = length === 0 ? 0 : ((rotation % length) + length) % length;
  return (args) => {
    const raw = args[0];
    const index = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(index)) return undefined;

    const slot = index - offset;
    if (!Number.isInteger(slot) || slot < 0 || slot >= length) return undefined;
    const element = values[(slot + shift) % length];
    if (element === undefined) return undefined;

    let text = element;
    if (encoding.base64) {
      const bytes = base64ToBytes(text, encoding.base64.alphabet);
      if (!bytes) return undefined;
      const decoded =
        encoding.base64.byteMode === 'utf8' ? bytesToUtf8(bytes) : bytesToLatin1(bytes);
      if (decoded === undefined) return undefined;
      text = decoded;
    }

    switch (encoding.algorithm) {
      case 'plain':
        return encoding.percent ? percentDecode(text, encoding.percent) : text;
      case 'base64':
        return text;
      case 'rc4': {
        const key = resolveKey(encoding, args);
        return key === undefined ? undefined : rc4(text, key);
      }
      case 'xor': {
        if (encoding.amount !== undefined) return xorWithCode(text, encoding.amount);
        const key = resolveKey(encoding, args);
        return key === undefined ? undefined : xorWithKey(text, key);
      }
      case 'caesar':
        return shiftChars(text, encoding.amount ?? 0);
      case 'rot':
        return rotateLetters(text, encoding.amount ?? 0);
      default:
        return undefined;
    }
  };
}

/**
 * The host's own percent decoder over a table entry. Nothing of the input
 * runs here - the entry is a string literal - and the builtin is the exact
 * function the program calls, malformed escapes included: `decodeURIComponent`
 * and `decodeURI` throw on those, which is a call site with no string.
 */
function percentDecode(text: string, through: PercentDecoder): string | undefined {
  try {
    switch (through) {
      case 'decodeURIComponent':
        return decodeURIComponent(text);
      case 'decodeURI':
        return decodeURI(text);
      case 'unescape':
        return unescape(text);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function resolveKey(
  encoding: EncodingRecognition,
  args: readonly (string | number)[],
): string | undefined {
  if (encoding.key !== undefined) return encoding.key;
  if (encoding.keyArgIndex === undefined) return undefined;
  const value = args[encoding.keyArgIndex];
  return typeof value === 'string' ? value : undefined;
}

function assembleDecoder(
  name: string,
  kind: NativeDecoder['kind'],
  values: readonly string[],
  offset: number,
  rotation: number,
  encoding: EncodingRecognition,
  modelled: ModelledCode = NOTHING_MODELLED,
  solvedRotation?: SolvedRotation,
): NativeDecoder {
  const rotated = rotation === 0 ? [...values] : rotateArray(values, rotation);
  const parts = [encoding.evidence];
  if (offset !== 0) parts.push(`index offset ${offset}`);
  if (rotation !== 0) parts.push(`rotation ${rotation}`);

  return {
    kind,
    algorithm: encoding.algorithm,
    name,
    offset,
    rotation,
    values: rotated,
    evidence: parts.join(', '),
    modelled,
    ...(solvedRotation ? { solvedRotation } : {}),
    decode: makeElementDecoder(rotated, offset, encoding),
  };
}

// ---------------------------------------------------------------------------
// Recogniser (f): a bit-packed blob and the accessor that cuts it up
// ---------------------------------------------------------------------------

/**
 * The knobs of a `basE91`-family unpacker, read off the decoder's own AST.
 *
 * Nothing here is hard-coded to basE91. The published constants (radix 91, a
 * 13/14-bit split at 88) are what a stock build emits, but a protector is free
 * to retune them, and every one of them is a numeric literal sitting in the loop
 * already being read. Extracting them and then *checking they are mutually
 * consistent* is both more general than matching the published numbers
 * and a much stronger guard: a coincidental `indexOf` loop will not produce a
 * radix equal to its alphabet length, a byte mask equal to `2**shift - 1` and a
 * drain guard equal to `shift - 1` all at once.
 */
export interface BitPackParams {
  /** Multiplier applied to the second symbol of each pair. `91` in basE91. */
  radix: number;
  /** Mask applied to the pair before the width test. `8191` in basE91. */
  mask: number;
  /** Width test threshold. `88` in basE91. */
  threshold: number;
  /** Bits contributed when `(pair & mask) > threshold`. `13` in basE91. */
  bitsWhenAbove: number;
  /** Bits contributed otherwise. `14` in basE91. */
  bitsWhenBelow: number;
  /** Mask applied to each emitted byte. `255`. */
  byteMask: number;
  /** Bits drained per emitted byte. `8`. */
  shift: number;
  /** The drain loop runs while the accumulator holds more than this many bits. `7`. */
  keep: number;
}

export interface BitPackRecognition {
  /** The custom alphabet the payload is written in. */
  charset: string;
  params: BitPackParams;
  /** How the emitted bytes become a string. */
  byteMode: 'utf8' | 'latin1';
  evidence: string;
}

/**
 * Shortest alphabet treated as credible.
 *
 * Long enough that no ordinary `'abc'.indexOf(x)` can reach it, and comfortably
 * below the 91 a stock build uses so a retuned alphabet still matches.
 */
const MIN_BITPACK_CHARSET = 32;

/** Shortest blob worth treating as a string table. */
const MIN_BLOB_LENGTH = 64;

/**
 * Read the unpacking parameters out of a decoder body, or return null.
 *
 * The scan is deliberately expression-level rather than statement-level. The
 * protector this recogniser exists for injects a `debugger` before the first
 * statement of every body and drops whole domain-lock IIFEs between the loop's
 * own statements, so any recogniser that matched the statement *sequence* would
 * be defeated by noise that does not change what the loop computes. The
 * sub-expressions it computes with - the alphabet lookup, the radix multiply,
 * the width conditional, the drain loop - survive that intact, so those are what
 * recognition keys on, and the consistency checks at the end are what keep the
 * looser matching honest.
 */
export function recogniseBitPackDecoder(fn: t.Function): BitPackRecognition | null {
  let charset: string | undefined;
  let ambiguous = false;
  let mask: number | undefined;
  let threshold: number | undefined;
  let bitsWhenAbove: number | undefined;
  let bitsWhenBelow: number | undefined;
  let byteMask: number | undefined;
  let shift: number | undefined;
  let keepFromDoWhile: number | undefined;
  let keepFromWhile: number | undefined;
  const multipliers = new Set<number>();

  eachNode(fn.body, (node) => {
    // `<alphabet>['indexOf'](text[i])` - the alphabet is the receiver, so it is
    // found without caring what the argument looks like.
    if (
      t.isMemberExpression(node) &&
      propertyName(node) === 'indexOf' &&
      t.isStringLiteral(node.object)
    ) {
      const value = node.object.value;
      if (value.length >= MIN_BITPACK_CHARSET && new Set(value).size === value.length) {
        if (charset !== undefined && charset !== value) ambiguous = true;
        charset = value;
      }
      return;
    }

    // `pair * <radix>`, in either operand order.
    if (t.isBinaryExpression(node) && node.operator === '*') {
      const left = t.isExpression(node.left) ? constantNumber(node.left) : undefined;
      const right = constantNumber(node.right);
      if (left !== undefined && right === undefined) multipliers.add(left);
      else if (right !== undefined && left === undefined) multipliers.add(right);
      return;
    }

    // `(pair & <mask>) > <threshold> ? <above> : <below>`
    if (t.isConditionalExpression(node)) {
      const test = node.test;
      if (!t.isBinaryExpression(test) || test.operator !== '>') return;
      if (!t.isBinaryExpression(test.left) || test.left.operator !== '&') return;
      const maskValue = constantNumber(test.left.right);
      const thresholdValue = constantNumber(test.right);
      const above = constantNumber(node.consequent);
      const below = constantNumber(node.alternate);
      if (
        maskValue === undefined ||
        thresholdValue === undefined ||
        above === undefined ||
        below === undefined
      ) {
        return;
      }
      // A second, different width conditional means this is not the loop being
      // recognised.
      if (mask !== undefined && (mask !== maskValue || threshold !== thresholdValue)) {
        ambiguous = true;
        return;
      }
      mask = maskValue;
      threshold = thresholdValue;
      bitsWhenAbove = above;
      bitsWhenBelow = below;
      return;
    }

    // `out['push'](accumulator & <byteMask>)`
    if (isMemberCall(node, 'push') && node.arguments.length === 1) {
      const only = node.arguments[0];
      if (t.isBinaryExpression(only) && only.operator === '&') {
        const value = constantNumber(only.right);
        if (value !== undefined) {
          if (byteMask !== undefined && byteMask !== value) ambiguous = true;
          byteMask = value;
        }
      }
      return;
    }

    // `accumulator >>= <shift>`
    if (t.isAssignmentExpression(node) && node.operator === '>>=') {
      const value = constantNumber(node.right);
      if (value !== undefined) {
        if (shift !== undefined && shift !== value) ambiguous = true;
        shift = value;
      }
      return;
    }

    // `do { ... } while (bits > <keep>)`. The drain loop is written as a
    // do-while in every build seen so far, so that reading is preferred and a
    // plain `while` is only a fallback; taking whichever comparison the walk
    // happened to reach first would make the answer depend on traversal order.
    if (t.isDoWhileStatement(node) || t.isWhileStatement(node)) {
      const test = node.test;
      if (t.isBinaryExpression(test) && test.operator === '>') {
        const value = constantNumber(test.right);
        if (value !== undefined) {
          if (t.isDoWhileStatement(node)) {
            if (keepFromDoWhile === undefined) keepFromDoWhile = value;
          } else if (keepFromWhile === undefined) {
            keepFromWhile = value;
          }
        }
      }
    }
  });

  if (ambiguous || charset === undefined) return null;
  const keep = keepFromDoWhile ?? keepFromWhile;
  if (
    mask === undefined ||
    threshold === undefined ||
    bitsWhenAbove === undefined ||
    bitsWhenBelow === undefined ||
    byteMask === undefined ||
    shift === undefined ||
    keep === undefined
  ) {
    return null;
  }
  if (!multipliers.has(charset.length)) return null;

  const params: BitPackParams = {
    radix: charset.length,
    mask,
    threshold,
    bitsWhenAbove,
    bitsWhenBelow,
    byteMask,
    shift,
    keep,
  };
  if (!isCoherentBitPack(params)) return null;

  return {
    charset,
    params,
    byteMode: byteModeOf(fn),
    evidence:
      'bit-packed alphabet of ' +
      `${charset.length} symbols (radix ${params.radix}, ` +
      `${params.bitsWhenAbove}/${params.bitsWhenBelow}-bit pairs)`,
  };
}

/**
 * Whether the extracted numbers describe a scheme that can actually work.
 *
 * This is what makes loose expression matching safe. Every relation below is
 * forced by the algorithm - the drain loop empties whole bytes, so its mask must
 * be `2**shift - 1` and its guard `shift - 1`; a pair carries either `k` or
 * `k + 1` bits; the radix is how many symbols the alphabet has. A loop that
 * merely resembles one of these will not satisfy all of them, and refusing is
 * always cheaper than a file full of confident mojibake.
 */
function isCoherentBitPack(p: BitPackParams): boolean {
  if (!Number.isInteger(p.radix) || p.radix < MIN_BITPACK_CHARSET) return false;
  if (!Number.isInteger(p.shift) || p.shift < 1 || p.shift > 16) return false;
  if (p.byteMask !== (1 << p.shift) - 1) return false;
  if (p.keep !== p.shift - 1) return false;
  if (!Number.isInteger(p.bitsWhenAbove) || !Number.isInteger(p.bitsWhenBelow)) return false;
  if (p.bitsWhenBelow !== p.bitsWhenAbove + 1) return false;
  if (p.bitsWhenAbove < p.shift || p.bitsWhenBelow > 30) return false;
  if (!Number.isInteger(p.mask) || !Number.isInteger(p.threshold)) return false;
  // The width test asks whether the pair fits in the *narrow* width, so the mask
  // is exactly that many low bits. In basE91 that is `2**13 - 1`, which is
  // deliberately narrower than a pair can be (`91*91 - 1` is 8 280) - the point
  // of the test is that the top of the range is what does not fit.
  if (p.mask !== (1 << p.bitsWhenAbove) - 1) return false;
  if (p.threshold < 1 || p.threshold >= p.mask) return false;
  return true;
}

/**
 * Whether the emitted bytes are UTF-8 or one code unit each.
 *
 * The two readings are not symmetric, and the asymmetry decides the default.
 * Reading a UTF-8 payload as Latin-1 always "works" and always produces
 * mojibake - the silent wrong answer this whole file exists to avoid. Reading a
 * Latin-1 payload as UTF-8 fails loudly: `bytesToUtf8` is strict, so the call
 * site returns `undefined` and is left encoded. UTF-8 is therefore the default,
 * and Latin-1 needs positive evidence before it is chosen.
 *
 * "Positive evidence" is deliberately narrow. A `String.fromCharCode(112, 108,
 * 97, ...)` whose arguments are all numeric literals is not a byte-array
 * conversion at all - it is a string constant spelled out to keep it away from
 * a grep, and this protector hides its locked domain that way inside the very
 * loop being recognised. Only a `fromCharCode` over something computed - an
 * element, a spread, an `apply` - is evidence about the byte sink.
 */
function byteModeOf(fn: t.Function): 'utf8' | 'latin1' {
  let sawFromCharCode = false;
  let sawUtf8 = false;

  const isCharCodeConversion = (node: t.CallExpression): boolean => {
    if (node.arguments.length === 0) return false;
    return node.arguments.some((argument) => !t.isNumericLiteral(argument));
  };

  eachNode(fn.body, (node) => {
    if (t.isIdentifier(node, { name: 'TextDecoder' })) sawUtf8 = true;
    if (t.isStringLiteral(node)) {
      if (/^utf-?8$/i.test(node.value)) sawUtf8 = true;
      if (node.value === 'fromCodePoint') sawUtf8 = true;
    }
    if (t.isMemberExpression(node) && propertyName(node) === 'fromCodePoint') sawUtf8 = true;
    if (t.isCallExpression(node)) {
      // `String.fromCharCode(...)` and `String.fromCharCode.apply(null, bytes)`.
      const direct = isMemberCall(node, 'fromCharCode') ? node : undefined;
      const applied =
        isMemberCall(node, 'apply') &&
        t.isMemberExpression(node.callee) &&
        t.isMemberExpression(node.callee.object) &&
        propertyName(node.callee.object) === 'fromCharCode'
          ? node
          : undefined;
      if (applied) sawFromCharCode = true;
      else if (direct && isCharCodeConversion(direct)) sawFromCharCode = true;
    }
  });

  if (sawUtf8) return 'utf8';
  return sawFromCharCode ? 'latin1' : 'utf8';
}

/**
 * Unpack one run of the blob: a transcription of the loop the recogniser just
 * read, parameterised by what it read.
 *
 * Characters outside the alphabet are skipped exactly as `indexOf(...) === -1`
 * skips them in the original, so a payload carrying padding or newlines decodes
 * identically.
 */
export function decodeBitPacked(text: string, recognition: BitPackRecognition): string | undefined {
  const { charset, params } = recognition;
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  let pending = -1;

  for (let i = 0; i < text.length; i++) {
    const symbol = charset.indexOf(text[i]!);
    if (symbol === -1) continue;
    if (pending < 0) {
      pending = symbol;
      continue;
    }
    pending += symbol * params.radix;
    accumulator |= pending << bits;
    bits += (pending & params.mask) > params.threshold ? params.bitsWhenAbove : params.bitsWhenBelow;
    do {
      bytes.push(accumulator & params.byteMask);
      accumulator >>= params.shift;
      bits -= params.shift;
    } while (bits > params.keep);
    pending = -1;
  }
  if (pending > -1) bytes.push((accumulator | (pending << bits)) & params.byteMask);

  const buffer = Uint8Array.from(bytes);
  return recognition.byteMode === 'utf8' ? bytesToUtf8(buffer) : bytesToLatin1(buffer);
}

/** An accessor that cuts a run out of a blob and unpacks it. */
export interface BlobAccessorRecognition {
  /** Binding name of the accessor itself. */
  name: string;
  /** Binding name of the blob, for reporting. */
  blobName: string;
  blob: string;
  decoder: BitPackRecognition;
  /** True when the second argument is an end offset rather than a length. */
  lengthIsEnd: boolean;
  /** The accessor and the unpacker it hands the run to: what the recognition read. */
  read: readonly t.Function[];
}

/**
 * Find `function acc(start, length) { return unpack(BLOB.slice(start, start + length)) }`.
 *
 * The two halves are recognised separately and only accepted together: a blob
 * with no unpacker is a long string, and an unpacker with no blob is a utility.
 * Together they are a string table whose "index" is a byte range, which is what
 * makes this family invisible to every string-array recogniser above - there is
 * no array, and the entries overlap.
 */
export function recogniseBlobAccessors(
  statements: readonly t.Statement[],
): Map<string, BlobAccessorRecognition> {
  const functions = new Map<string, t.Function>();
  const blobs = new Map<string, string>();
  indexSliceDeclarations(statements, functions, blobs);

  const found = new Map<string, BlobAccessorRecognition>();
  for (const [name, fn] of functions) {
    const accessor = asBlobAccessor(name, fn, functions, blobs);
    if (accessor) found.set(name, accessor);
  }
  return found;
}

/** Function and long-string-literal declarations of a statement list. */
function indexSliceDeclarations(
  statements: readonly t.Statement[],
  functions: Map<string, t.Function>,
  blobs: Map<string, string>,
): void {
  const consider = (name: string, init: t.Node | null | undefined): void => {
    const fn = functionOf(init);
    if (fn) {
      functions.set(name, fn);
      return;
    }
    if (t.isStringLiteral(init) && init.value.length >= MIN_BLOB_LENGTH) blobs.set(name, init.value);
  };

  for (const statement of statements) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      functions.set(statement.id.name, statement);
      continue;
    }
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      if (t.isIdentifier(declarator.id)) consider(declarator.id.name, declarator.init);
    }
  }
}

interface SliceMatch {
  blobName: string;
  blob: string;
  lengthIsEnd: boolean;
  consumer: t.Node;
}

function asBlobAccessor(
  name: string,
  fn: t.Function,
  functions: ReadonlyMap<string, t.Function>,
  blobs: ReadonlyMap<string, string>,
): BlobAccessorRecognition | null {
  if (fn.params.length !== 2) return null;
  const start = paramName(fn, 0);
  const span = paramName(fn, 1);
  if (!start || !span) return null;

  let match: SliceMatch | undefined;
  let ambiguous = false;

  eachNode(fn.body, (node) => {
    if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
    const method = propertyName(node.callee);
    if (method !== 'slice' && method !== 'substring' && method !== 'substr') return;

    const object = node.callee.object;
    let blobName: string | undefined;
    let blob: string | undefined;
    if (t.isIdentifier(object)) {
      blobName = object.name;
      blob = blobs.get(object.name);
    } else if (t.isStringLiteral(object) && object.value.length >= MIN_BLOB_LENGTH) {
      blobName = '<inline>';
      blob = object.value;
    }
    if (blob === undefined || blobName === undefined) return;

    const first = node.arguments[0];
    const second = node.arguments[1];
    if (!t.isIdentifier(first, { name: start }) || !second) return;

    // `slice(start, start + length)` versus `substr(start, length)`: the same
    // table read written two ways, and reading one as the other would decode
    // every entry at the wrong length.
    let lengthIsEnd: boolean;
    if (t.isIdentifier(second, { name: span })) {
      lengthIsEnd = method !== 'substr';
    } else if (isSumOfParams(second, start, span)) {
      lengthIsEnd = false;
    } else {
      return;
    }

    if (match) ambiguous = true;
    match = { blobName, blob, lengthIsEnd, consumer: node };
  });

  if (ambiguous || !match) return null;

  const unpacker = consumerOf(fn, match.consumer, functions);
  if (!unpacker) return null;
  const decoder = recogniseBitPackDecoder(unpacker);
  if (!decoder) return null;

  return {
    name,
    blobName: match.blobName,
    blob: match.blob,
    decoder,
    lengthIsEnd: match.lengthIsEnd,
    read: [fn, unpacker],
  };
}

/** `start + length` in either operand order. */
function isSumOfParams(node: t.Node, start: string, span: string): boolean {
  if (!t.isBinaryExpression(node) || node.operator !== '+') return false;
  const { left, right } = node;
  return (
    (t.isIdentifier(left, { name: start }) && t.isIdentifier(right, { name: span })) ||
    (t.isIdentifier(left, { name: span }) && t.isIdentifier(right, { name: start }))
  );
}

/**
 * The function the extracted run is handed to.
 *
 * Written as an immediately-invoked function expression in some builds and as a
 * named helper in others; both are the same shape once resolved, so both are
 * followed.
 */
function consumerOf(
  fn: t.Function,
  sliceCall: t.Node,
  functions: ReadonlyMap<string, t.Function>,
): t.Function | undefined {
  let found: t.Function | undefined;
  eachNode(fn.body, (node) => {
    if (found || !t.isCallExpression(node)) return;
    if (!node.arguments.some((argument) => argument === sliceCall)) return;
    const direct = functionOf(node.callee);
    if (direct) {
      found = direct;
      return;
    }
    if (t.isIdentifier(node.callee)) found = functions.get(node.callee.name);
  });
  return found;
}

/**
 * Whether `fn` does nothing but hand its arguments to `target` and return the
 * result, however much guard code surrounds that.
 *
 * The protector wraps every entry point in a self-integrity check:
 * `if (hash(target) === <constant>) return target(a, b); else while (true) {}`.
 * The hash arm cannot be evaluated and does not need to be: the only way the
 * function can *finish* is by returning the forwarded call, and that is exactly
 * what the two conditions below establish - one return, forwarding the parameters
 * in order, and no path that completes any other way.
 */
export function isPositionalForwarder(fn: t.Function, target: string): boolean {
  if (!t.isBlockStatement(fn.body)) return false;
  const params: string[] = [];
  for (const param of fn.params) {
    if (!t.isIdentifier(param)) return false;
    params.push(param.name);
  }
  if (params.length === 0) return false;
  // A parameter shadowing the target means the call goes somewhere else.
  if (params.includes(target)) return false;

  const returns = ownReturnStatements(fn.body);
  if (returns.length !== 1) return false;
  const call = returns[0]!.argument;
  if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: target })) return false;
  if (call.arguments.length !== params.length) return false;
  for (let i = 0; i < params.length; i++) {
    if (!t.isIdentifier(call.arguments[i], { name: params[i]! })) return false;
  }
  return alwaysExits(fn.body.body);
}

/** Walk a subtree without descending into nested functions. */
function walkOwnBody(node: t.Node, visit: (node: t.Node) => boolean): void {
  if (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  ) {
    return;
  }
  if (!visit(node)) return;
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && typeof (item as t.Node).type === 'string') {
          walkOwnBody(item as t.Node, visit);
        }
      }
    } else if (child && typeof child === 'object' && typeof (child as t.Node).type === 'string') {
      walkOwnBody(child as t.Node, visit);
    }
  }
}

/** Return statements belonging to `fn` itself, not to a function nested in it. */
function ownReturnStatements(body: t.BlockStatement): t.ReturnStatement[] {
  const found: t.ReturnStatement[] = [];
  walkOwnBody(body, (node) => {
    if (t.isReturnStatement(node)) found.push(node);
    return true;
  });
  return found;
}

/**
 * Whether a statement list cannot fall off its end.
 *
 * Conservative by construction: it says yes only for the shapes that provably
 * terminate a body - return, throw, an unconditional infinite loop, and an `if`
 * whose two arms both do one of those.
 */
function alwaysExits(statements: readonly t.Statement[]): boolean {
  for (const statement of statements) {
    if (t.isReturnStatement(statement) || t.isThrowStatement(statement)) return true;
    if (t.isBlockStatement(statement) && alwaysExits(statement.body)) return true;
    if (isInfiniteLoop(statement)) return true;
    if (t.isIfStatement(statement) && statement.alternate) {
      const consequent = t.isBlockStatement(statement.consequent)
        ? alwaysExits(statement.consequent.body)
        : alwaysExits([statement.consequent]);
      const alternate = t.isBlockStatement(statement.alternate)
        ? alwaysExits(statement.alternate.body)
        : alwaysExits([statement.alternate]);
      if (consequent && alternate) return true;
    }
  }
  return false;
}

/** `while (true) {}` / `while (1) {}` / `for (;;) {}` with no way out. */
function isInfiniteLoop(statement: t.Statement): boolean {
  let body: t.Statement | undefined;
  if (t.isWhileStatement(statement)) {
    const test = statement.test;
    const truthy =
      t.isBooleanLiteral(test, { value: true }) || (constantNumber(test) ?? 0) !== 0;
    if (!truthy) return false;
    body = statement.body;
  } else if (t.isForStatement(statement) && !statement.test) {
    body = statement.body;
  }
  if (!body) return false;

  let escapes = false;
  walkOwnBody(body, (node) => {
    if (escapes) return false;
    if (t.isReturnStatement(node) || t.isBreakStatement(node) || t.isThrowStatement(node)) {
      escapes = true;
      return false;
    }
    return true;
  });
  return !escapes;
}

/**
 * Turn a recognised blob accessor into the decoder the pipeline consumes.
 *
 * `name` is the binding call sites actually use, which need not be the
 * accessor's: a guarded forwarder in front of it can be the only name the rest
 * of the program ever sees.
 */
export function blobDecoderFor(
  name: string,
  accessor: BlobAccessorRecognition,
  forwarder?: t.Function,
): NativeDecoder {
  const { blob, decoder, lengthIsEnd } = accessor;
  return {
    kind: 'wrapper-call',
    algorithm: 'bit-pack',
    name,
    offset: 0,
    rotation: 0,
    values: [],
    evidence:
      `${decoder.evidence} over a ${blob.length}-character blob` +
      (accessor.blobName === '<inline>' ? '' : ` (${accessor.blobName})`),
    modelled: { subtrees: forwarder ? [...accessor.read, forwarder] : accessor.read, loops: [], callees: [] },
    decode: (args) => {
      if (args.length < 2) return undefined;
      const start = Number(args[0]);
      const span = Number(args[1]);
      if (!Number.isInteger(start) || !Number.isInteger(span)) return undefined;
      // A negative argument indexes from the end in `slice`, which is not a
      // shape any packer emits; refusing is cheaper than modelling it.
      if (start < 0 || span < 0) return undefined;
      // Otherwise the read is `slice`'s, clamping and all. A span that overruns
      // the blob is not an error in the program being read - it reads to the end
      // - and answering `undefined` there would disagree with the interpreter
      // tier about a call site that has a perfectly definite value.
      return decodeBitPacked(blob.slice(start, lengthIsEnd ? span : start + span), decoder);
    },
  };
}

/**
 * The blob accessor a statement list offers under one of `roots`, directly or
 * through a guarded forwarder.
 */
export function recogniseBlobDecoder(
  statements: readonly t.Statement[],
  roots: readonly string[],
): NativeDecoder | null {
  const accessors = recogniseBlobAccessors(statements);
  if (accessors.size === 0) return null;

  for (const root of roots) {
    const direct = accessors.get(root);
    if (direct) return blobDecoderFor(root, direct);
  }

  // A forwarder is followed only when the caller asked about it by name:
  // resolving in the other direction would let any function that happens to call
  // the accessor be mistaken for an alias of it.
  const functions = new Map<string, t.Function>();
  indexSliceDeclarations(statements, functions, new Map());
  for (const root of roots) {
    const fn = functions.get(root);
    if (!fn) continue;
    for (const [target, accessor] of accessors) {
      if (target !== root && isPositionalForwarder(fn, target)) {
        return blobDecoderFor(root, accessor, fn);
      }
    }
  }

  // Nothing the caller named; fall back to the only accessor in the slice, and
  // refuse when there is more than one to choose between.
  if (accessors.size === 1) {
    const only = [...accessors.values()][0]!;
    return blobDecoderFor(only.name, only);
  }
  return null;
}

/**
 * Whether a decoder's output on real call sites is good enough to trust.
 *
 * The same bar `buildDecoder` applies before adopting a tier, exported so that a
 * caller which recognised a decoder directly cannot accidentally hold it to a
 * lower one.
 */
export function validateAgainstSamples(
  decode: (args: readonly (string | number)[]) => string | undefined,
  samples: readonly (readonly (string | number)[])[],
): { ok: true } | { ok: false; reason: string } {
  if (samples.length === 0) return { ok: false, reason: 'no call site to validate against' };

  let decoded = 0;
  let printable = 0;
  let characters = 0;
  let control = 0;
  for (const args of samples) {
    let value: string | undefined;
    try {
      value = decode(args);
    } catch (error) {
      return { ok: false, reason: `threw on (${args.join(', ')}): ${String(error)}` };
    }
    if (typeof value !== 'string') continue;
    if (decode(args) !== value) {
      return { ok: false, reason: `not stable across two calls for (${args.join(', ')})` };
    }
    decoded++;
    if (isPlausibleDecodedString(value)) printable++;
    characters += value.length;
    control += controlCharacters(value);
  }

  if (decoded === 0) return { ok: false, reason: 'no sample call site decoded to a string' };
  if (decoded * 2 < samples.length) {
    return { ok: false, reason: `only ${decoded}/${samples.length} call sites decoded` };
  }
  if (printable * 2 < decoded) {
    return { ok: false, reason: `${decoded - printable}/${decoded} results were not plausible text` };
  }
  // Text has next to no control characters; a table of bytes has one in
  // four, and short entries hide that from the per-string test above.
  if (control * 20 > characters) {
    return { ok: false, reason: `${control}/${characters} decoded characters were control characters` };
  }
  return { ok: true };
}

/** Control characters are the tell-tale of a wrong alphabet or a wrong span. */
export function isPlausibleDecodedString(value: string): boolean {
  if (value.length === 0) return false;
  return controlCharacters(value) * 4 <= value.length;
}

/** C0 and C1 controls but the whitespace text uses, DEL, the replacement character and a lone surrogate. */
function controlCharacters(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) count++;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else count++;
    } else if (code >= 0xdc00 && code <= 0xdfff) count++;
  }
  return count;
}
