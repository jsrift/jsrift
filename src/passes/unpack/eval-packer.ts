import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { parseSource } from '../../frontend/language.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { staticNumber, staticString } from '../../util/ast.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Set in `ctx.shared` once a layer has been spliced in.
 *
 * After unpacking, the tree contains code that never appeared in `ctx.source`,
 * so the cheap source-text hints the other unpack passes use to skip a traversal
 * would miss a bundle that was hiding inside a packer. This is the flag that
 * tells them to look anyway.
 */
export const EVAL_PACKER_UNPACKED = 'unpack.eval-packer:unpacked';

/** Packers stack two or three deep in the wild; this is runaway protection only. */
const MAX_LAYERS = 12;
const MAX_KEYWORDS = 65_536;
const MAX_PAYLOAD_CHARS = 8_000_000;
/** Keyword substitutions performed between time-budget checks. */
const BUDGET_STRIDE = 128;

/**
 * Every packer emits `eval(function(p,a,c,k,e,d){...}(...))` verbatim. Testing the
 * raw text for that shape costs one linear scan and saves a full traversal of a
 * multi-megabyte file that contains no packer at all.
 */
const PACKER_HINT = /\beval\s*\(\s*\(?\s*function\s*\(/;

/**
 * Unwrap Dean Edwards `eval` packers, statically.
 *
 * The packer is a substitution cipher with a published algorithm, so there is no
 * reason to run it: the base-N encoder `e(c)` is re-implemented here and the
 * same keyword substitution replayed over the payload. Nothing from the input
 * executes, which matters because a packed payload is exactly the shape hostile
 * code arrives in.
 *
 * A `run` pass rather than a visitor: unpacking is layered (a payload commonly
 * contains another packer), and resolving those layers on the small recovered
 * program is far cheaper than re-walking the whole file once per layer.
 */
export const evalPackerPass: Pass = {
  id: 'unpack.eval-packer',
  title: 'Unwrap eval-based packers',
  stage: 'unpack',
  technique: 'moduleUnwrapping',
  run: (ctx) => {
    reportLegacyFamilies(ctx);
    if (!PACKER_HINT.test(ctx.source)) return;

    const state = { layers: 0 };
    unpackFile(ctx.ast, ctx, 0, state);
    if (state.layers === 0) return;

    refreshScope(ctx.ast);
    ctx.shared.set(EVAL_PACKER_UNPACKED, state.layers);
    ctx.note('info', `Unwrapped ${state.layers} eval-packer layer(s).`);
  },
};

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

interface Packer {
  payload: string;
  base: number;
  count: number;
  keywords: string[];
  encode: (index: number) => string;
  /** Whether the substitution regex is wrapped in `\b...\b`. */
  wordBoundary: boolean;
}

/** Structural evidence gathered from the unpacker body in one pass. */
interface BodyMarks {
  fromCharCode: boolean;
  toStringRadix: boolean;
  replace: boolean;
  regexp: boolean;
  loop: boolean;
  numbers: Set<number>;
  wordBoundary: boolean;
}

function matchPacker(statement: t.ExpressionStatement): Packer | undefined {
  const outer = statement.expression;
  if (!t.isCallExpression(outer) || !isEvalCallee(outer.callee)) return undefined;
  if (outer.arguments.length !== 1) return undefined;

  const inner = outer.arguments[0];
  if (!t.isCallExpression(inner) || inner.arguments.length < 4) return undefined;

  const unpacker = inner.callee;
  if (!t.isFunctionExpression(unpacker) && !t.isArrowFunctionExpression(unpacker)) return undefined;
  // `p, a, c, k, e, d` -- the arity is the most stable part of the signature,
  // since minifiers rename the parameters but never change how many there are.
  if (unpacker.params.length !== 6 || !unpacker.params.every((param) => t.isIdentifier(param))) {
    return undefined;
  }

  const payload = staticString(inner.arguments[0]);
  const base = staticNumber(inner.arguments[1]);
  const count = staticNumber(inner.arguments[2]);
  const keywords = keywordList(inner.arguments[3]);
  if (payload === undefined || base === undefined || count === undefined || !keywords) {
    return undefined;
  }
  if (!Number.isInteger(base) || base < 2 || base > 95) return undefined;
  if (!Number.isInteger(count) || count < 0 || count > MAX_KEYWORDS) return undefined;
  if (payload.length > MAX_PAYLOAD_CHARS) return undefined;

  const marks = scanBody(unpacker.body);
  // A six-parameter function whose body neither builds a regex nor replaces
  // anything in a loop is some other function that happens to take six values.
  if (!marks.replace || !marks.regexp || !marks.loop) return undefined;

  const encode = encoderFor(marks, base);
  if (!encode) return undefined;

  return { payload, base, count, keywords, encode, wordBoundary: marks.wordBoundary };
}

function isEvalCallee(callee: t.Node): boolean {
  if (t.isIdentifier(callee, { name: 'eval' })) return true;
  // `window.eval(...)` / `globalThis.eval(...)` are the same shape to match.
  return (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property, { name: 'eval' })
  );
}

/** `'a|b|c'.split('|')`, or the already-expanded array form. */
function keywordList(node: t.Node | undefined): string[] | undefined {
  if (!node) return undefined;

  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.property, { name: 'split' }) &&
    node.arguments.length === 1
  ) {
    const source = staticString(node.callee.object);
    const separator = staticString(node.arguments[0]);
    if (source === undefined || !separator) return undefined;
    return source.split(separator);
  }

  if (t.isArrayExpression(node)) {
    const words: string[] = [];
    for (const element of node.elements) {
      // A hole means "no keyword for this slot", which the packer's `if (k[c])`
      // guard treats exactly like an empty string.
      if (element === null) {
        words.push('');
        continue;
      }
      const value = staticString(element);
      if (value === undefined) return undefined;
      words.push(value);
    }
    return words;
  }

  return undefined;
}

/**
 * Collect the handful of markers that identify which `e(c)` encoder was emitted.
 *
 * A plain structural walk rather than a Babel traversal: the unpacker body is
 * small and this runs before the node is known to be a packer at all.
 */
function scanBody(root: t.Node): BodyMarks {
  const marks: BodyMarks = {
    fromCharCode: false,
    toStringRadix: false,
    replace: false,
    regexp: false,
    loop: false,
    numbers: new Set<number>(),
    wordBoundary: false,
  };

  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object' || typeof (current as t.Node).type !== 'string') {
      continue;
    }
    const node = current as t.Node;

    if (t.isNumericLiteral(node)) marks.numbers.add(node.value);
    // The source text is `'\\b'`, i.e. a two-character string value.
    if (t.isStringLiteral(node) && node.value.includes('\\b')) marks.wordBoundary = true;
    if (t.isNewExpression(node) && t.isIdentifier(node.callee, { name: 'RegExp' })) {
      marks.regexp = true;
    }
    if (t.isRegExpLiteral(node)) marks.regexp = true;
    if (t.isWhileStatement(node) || t.isDoWhileStatement(node) || t.isForStatement(node)) {
      marks.loop = true;
    }
    if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
      if (node.property.name === 'fromCharCode') marks.fromCharCode = true;
      if (node.property.name === 'replace') marks.replace = true;
    }
    if (
      t.isCallExpression(node) &&
      t.isMemberExpression(node.callee) &&
      !node.callee.computed &&
      t.isIdentifier(node.callee.property, { name: 'toString' }) &&
      node.arguments.length === 1
    ) {
      marks.toStringRadix = true;
    }

    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }

  return marks;
}

/**
 * Pick the encoder the unpacker body describes.
 *
 * Order matters: the base-62 encoder contains a `toString(36)` call in its
 * else-branch, so the `String.fromCharCode` tests have to come first or every
 * base-62 packer would be mistaken for a base-36 one.
 */
function encoderFor(marks: BodyMarks, base: number): ((index: number) => string) | undefined {
  if (marks.fromCharCode && marks.numbers.has(161)) {
    return (index) => encodeShifted(index, base, 161);
  }
  if (marks.fromCharCode && marks.numbers.has(29)) {
    return (index) => encodeAlnum(index, base);
  }
  if (marks.toStringRadix) return (index) => index.toString(base);
  // `e = function (c) { return c }` -- decimal tokens, no transformation at all.
  if (base <= 10) return (index) => String(index);
  return undefined;
}

/** `encode62`: digits `0-9a-zA-Z`, generalised to any base up to 62. */
function encodeAlnum(value: number, base: number): string {
  const head = value < base ? '' : encodeAlnum(Math.floor(value / base), base);
  const digit = value % base;
  return head + (digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36));
}

/** `encode95`: one high-Latin character per digit, so tokens are never `\w`. */
function encodeShifted(value: number, base: number, offset: number): string {
  const head = value < base ? '' : encodeShifted(Math.floor(value / base), base, offset);
  return head + String.fromCharCode((value % base) + offset);
}

// ---------------------------------------------------------------------------
// Inversion
// ---------------------------------------------------------------------------

interface UnpackState {
  layers: number;
}

function unpackFile(file: t.File, ctx: PassContext, depth: number, state: UnpackState): void {
  const targets: Array<{ path: NodePath<t.ExpressionStatement>; packer: Packer }> = [];
  traverse(file, {
    ExpressionStatement(path) {
      const packer = matchPacker(path.node);
      if (!packer) return;
      targets.push({ path, packer });
      // The unpacker body is about to be discarded; nothing inside it is a
      // separate layer, and descending would only find its own machinery.
      path.skip();
    },
  });
  if (targets.length === 0) return;

  // Checked only once there is something to unwrap, so a file that happens to
  // be exactly MAX_LAYERS deep finishes without a spurious warning.
  if (depth >= MAX_LAYERS) {
    ctx.note('warning', `Stopped unpacking after ${MAX_LAYERS} nested packer layers.`);
    return;
  }

  // Last to first, so replacing one target never shifts the container index of
  // another one that has not been processed yet.
  for (let index = targets.length - 1; index >= 0; index--) {
    if (ctx.isExhausted()) return;
    const target = targets[index]!;
    expand(target.path, target.packer, ctx, depth, state);
  }
}

function expand(
  path: NodePath<t.ExpressionStatement>,
  packer: Packer,
  ctx: PassContext,
  depth: number,
  state: UnpackState,
): void {
  // The shape is recorded whether or not it opens; once per packer, since the
  // stage meets a refused one again on the quiet round.
  if (firstMeeting(ctx, path.node)) {
    ctx.report('eval-packer', `base-${packer.base} packer, ${packer.keywords.length} keywords`, 1, 1);
  }

  // Statements can only replace a statement. In any other position -- an
  // initialiser, an argument, a bodiless `if` -- splicing a program in would
  // change what the surrounding expression evaluates to.
  if (!Array.isArray(path.container)) {
    ctx.note(
      'warning',
      'Packer found outside a statement list; left in place.',
      path.node.loc,
      siteKey(ctx, evalPackerPass.id, path.node),
    );
    return;
  }

  const code = substitute(packer, ctx);
  if (code === undefined) return;

  const parsed = (() => {
    try {
      return parseSource(code, { language: ctx.language });
    } catch {
      return undefined;
    }
  })();
  if (!parsed || parsed.recovered) {
    ctx.note(
      'warning',
      'Unpacked payload is not valid JavaScript; the packer was left in place.',
      path.node.loc,
      siteKey(ctx, evalPackerPass.id, path.node),
    );
    return;
  }

  // Resolve nested layers on the recovered program while it is still small,
  // rather than re-walking the whole host file once per layer.
  unpackFile(parsed.ast, ctx, depth + 1, state);

  if (parsed.ast.program.directives.some((directive) => directive.value.value === 'use strict')) {
    ctx.note(
      'info',
      "Unpacked payload was strict-mode code; 'use strict' no longer applies in its new position.",
    );
  }
  const statements = adoptProgram(parsed.ast.program);

  releaseSite(ctx, evalPackerPass.id, path.node);
  if (statements.length === 0) {
    path.remove();
  } else {
    path.replaceWithMultiple(statements);
  }

  state.layers++;
  ctx.markChanged();
}

/**
 * Whether the stage meets this call for the first time in the run. The stage
 * runs in the prologue and again on the quiet round, over the same tree, and
 * a wrapper it met before - opened or refused - is one packed shape in the
 * detections, not one per round. Keyed on the node, because a call spliced
 * in from a string carries no position, and a node's identity outlives every
 * round the tree keeps it in.
 */
export function firstMeeting(ctx: PassContext, node: t.Node): boolean {
  const sites = meetings(ctx);
  if (sites.met.has(node)) return false;
  sites.met.add(node);
  return true;
}

/** A standing line per call the stage refuses: a refusal made twice is one verdict, the current one. */
export function siteKey(ctx: PassContext, pass: string, node: t.Node): string {
  const sites = meetings(ctx);
  let id = sites.ids.get(node);
  if (id === undefined) {
    id = ++sites.next;
    sites.ids.set(node, id);
  }
  return `${pass}:refused:${id}`;
}

/** Withdraw the standing line for a call the stage now opens, if it ever refused it. */
export function releaseSite(ctx: PassContext, pass: string, node: t.Node): void {
  const id = meetings(ctx).ids.get(node);
  if (id !== undefined) ctx.retract(`${pass}:refused:${id}`);
}

interface Meetings {
  met: WeakSet<t.Node>;
  ids: WeakMap<t.Node, number>;
  next: number;
}

function meetings(ctx: PassContext): Meetings {
  const existing = ctx.shared.get(MEETINGS) as Meetings | undefined;
  if (existing) return existing;
  const created: Meetings = { met: new WeakSet(), ids: new WeakMap(), next: 0 };
  ctx.shared.set(MEETINGS, created);
  return created;
}

const MEETINGS = 'unpack:meetings';

/**
 * Replay the packer's own substitution.
 *
 * It has to be **one simultaneous pass**, and that is the whole of this
 * function. Substituting one keyword at a time - in either direction - is
 * wrong, because a keyword may be spelled exactly like another token, and a
 * separate pass for that token then rewrites text the first pass just produced.
 *
 * The published payload `'0 1(2){3 2+4}5(1(6))'` over
 * `function|add|x|return|1|log|41` is the minimal case. Token `4` stands for the
 * keyword `1`, and token `1` stands for `add`. Replace descending and `4`
 * becomes `1`, which the later `1` pass then turns into `add`, so
 * `return x + 1` is emitted as `return x + add`. It parses, it runs, and it
 * computes something else entirely - the failure mode this tool exists to avoid.
 *
 * What the packer actually does is build a token→keyword table and then run
 * `p.replace(/\b\w+\b/g, m => d[m])` **once**. A single left-to-right scan never
 * re-examines what it has already written, so every token is expanded exactly
 * once. That is reproduced here with one alternation over the real token set,
 * longest first so a token can never be matched as the prefix of a longer one.
 */
function substitute(packer: Packer, ctx: PassContext): string | undefined {
  const table = new Map<string, string>();
  let steps = 0;

  // Descending, so that if two indices somehow encode to the same token the
  // lower one wins - which is the order the packer's own `d[...] = k[c]` leaves.
  for (let index = packer.count - 1; index >= 0; index--) {
    if (++steps % BUDGET_STRIDE === 0 && ctx.isExhausted()) {
      ctx.note('warning', 'Time budget exhausted mid-unpack; the packer was left in place.');
      return undefined;
    }
    // The packer guards with `if (k[c])`, and writes `d[token] = k[c] || token`,
    // so an empty slot leaves its token standing.
    const word = packer.keywords[index];
    if (!word) continue;

    const token = packer.encode(index);
    if (!token) continue;
    table.set(token, word);
  }

  if (table.size === 0) return packer.payload;

  const tokens = [...table.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const alternation = tokens.map(escapeRegExp).join('|');
  const pattern = packer.wordBoundary ? `\\b(?:${alternation})\\b` : `(?:${alternation})`;

  // A replacer function, not a replacement string: `$&` and friends inside a
  // keyword would otherwise be read as replacement patterns.
  const out = packer.payload.replace(
    new RegExp(pattern, 'g'),
    (match) => table.get(match) ?? match,
  );

  return out;
}

/**
 * Take the body of a freshly parsed program so it can be spliced into another
 * file. Shared with `unpack.webpack-modules`, which faces the same problem when
 * it unwraps a dev-build `eval` module.
 *
 * Two things need care. A directive prologue is not in `program.body`, and once
 * the code is spliced mid-file it is not in prologue position any more, so
 * directives are re-emitted as ordinary statements (the caller reports the lost
 * strictness). And every position in the recovered tree indexes the payload
 * string rather than the host file, so keeping them would produce confidently
 * wrong source mappings.
 */
export function adoptProgram(program: t.Program): t.Statement[] {
  const directives = program.directives.map((directive) =>
    t.expressionStatement(t.stringLiteral(directive.value.value)),
  );
  const statements = [...directives, ...program.body];
  stripLocations(statements);
  return statements;
}

/**
 * Rebuild program-scope bindings after a pass has restructured the tree.
 *
 * Babel does not register declarations that arrive via `insertBefore` or
 * `replaceWithMultiple`, and the cached program scope outlives the traversal
 * that created it, so without this every later pass would resolve the
 * newly introduced names as globals.
 */
export function refreshScope(ast: t.File): void {
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
      path.stop();
    },
  });
}

export function stripLocations(nodes: readonly t.Node[]): void {
  const stack: unknown[] = [...nodes];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object' || typeof (current as t.Node).type !== 'string') {
      continue;
    }
    const node = current as t.Node;
    node.start = null;
    node.end = null;
    node.loc = null;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Legacy charset families
// ---------------------------------------------------------------------------

/**
 * JSFuck, AAencode and JJencode all build a source string out of coercions and
 * hand it to `Function`. Recovering it means *running* the construction, and
 * this engine never executes its input, so these are reported and left alone --
 * a reader who knows what they are looking at is better served than one staring
 * at a wall of `[]+!![]`.
 *
 * They are reported under `eval-packer` because that is the detection kind for
 * "the whole program is hidden behind an eval-equivalent wrapper"; the family
 * name is carried in the evidence string.
 */
function reportLegacyFamilies(ctx: PassContext): void {
  const { source } = ctx;

  // Keyed: the stage runs again on a quiet round, and the family is the same.
  if (isJsFuck(source)) {
    ctx.report('eval-packer', 'jsfuck: source restricted to []()!+', 1);
    ctx.note('warning', 'JSFuck-encoded source; decoding it requires executing the payload.', undefined, LEGACY_NOTE);
  }
  if (isAaEncode(source)) {
    ctx.report('eval-packer', 'aaencode: kaomoji identifier alphabet', 0.95);
    ctx.note('warning', 'AAencode-encoded source; decoding it requires executing the payload.', undefined, LEGACY_NOTE);
  }
  if (isJjEncode(source)) {
    ctx.report('eval-packer', 'jjencode: single-symbol coercion table', 0.9);
    ctx.note('warning', 'JJencode-encoded source; decoding it requires executing the payload.', undefined, LEGACY_NOTE);
  }
}

const LEGACY_NOTE = 'unpack.eval-packer:legacy-family';

/** Every character of a JSFuck program comes from `[]()!+` plus whitespace. */
const JSFUCK_ALPHABET = '[]()!+ \t\r\n;\uFEFF';

function isJsFuck(source: string): boolean {
  if (source.length < 64) return false;
  let bang = false;
  let plus = false;
  let bracket = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    // Ordinary code fails here within the first few characters, which is what
    // makes the whole-file scan affordable.
    if (!JSFUCK_ALPHABET.includes(char)) return false;
    if (char === '!') bang = true;
    else if (char === '+') plus = true;
    else if (char === '[') bracket = true;
  }
  return bang && plus && bracket;
}

/**
 * The kaomoji AAencode builds its alphabet from, written as escapes so the file
 * stays ASCII: half-width katakana "no" face, then the "(o^_^o)" digit.
 */
const AAENCODE_SIGNATURE = '\uFF9F\u03C9\uFF9F\uFF89';
const AAENCODE_FACE = '(\uFF9F\u0414\uFF9F)';

function isAaEncode(source: string): boolean {
  if (source.includes(AAENCODE_SIGNATURE)) return true;
  return source.includes(AAENCODE_FACE) && source.includes('^_^o');
}

/**
 * `$=~[]; $={___:++$, $$$$:(![]+"")[$], ...}` -- keyed on the shape, because the
 * holder variable is configurable and is not always `$`.
 */
const JJENCODE_SEED = /(?:^|[;\s({])[$_A-Za-z][$\w]*\s*=\s*~\s*\[\s*\]\s*[;,]/;
const JJENCODE_COERCION = /\(\s*!\s*\[\s*\]\s*\+\s*""\s*\)/;

function isJjEncode(source: string): boolean {
  return JJENCODE_SEED.test(source) && JJENCODE_COERCION.test(source);
}
