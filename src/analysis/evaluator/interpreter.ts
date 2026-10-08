/**
 * A hand-written AST interpreter over a whitelisted JavaScript subset.
 *
 * This is the `interpreter` tier of the evaluator, and it is the reason the
 * engine can decode a hostile file safely. The alternatives all leak:
 *
 * - `eval()` on the input runs the attacker's whole program in the user's page.
 * - Shadowing globals inside `new Function` (see `sandbox.ts`) is defeated by
 *   `({}).constructor.constructor('return this')()`, which walks back to the real
 *   global object through a value the program already holds.
 * - A sandboxed iframe is a genuine boundary but cannot be created inside a
 *   Worker, which would drag a 4 MB job back onto the UI thread.
 *
 * An interpreter has nothing to escape *from*. The program is data being walked;
 * the only values it can produce are the ones `builtins.ts` defines; and because
 * the step counter belongs to the interpreter, `while (1) {}` terminates.
 *
 * The subset is chosen to cover string-array decoders exhaustively - closures,
 * labelled control flow, `try`/`finally`, `switch`, `arguments`, bitwise
 * arithmetic and the string/array library - which in practice is every decoder
 * `javascript-obfuscator` and its descendants have ever emitted. It is written
 * down once, as `checkVocabulary` below, and checked over the whole slice
 * before any of it runs: inside it the semantics are V8's, outside it the
 * answer is a refusal.
 */

import _generate from '@babel/generator';
import { VISITOR_KEYS } from '@babel/types';
import type * as t from '@babel/types';
import {
  BoundFunction,
  Callable,
  describeError,
  evalFunction,
  externalize,
  getMember,
  globalEntries,
  GlobalObject,
  hasProperty,
  instanceOf,
  internalize,
  InterpArguments,
  InterpDate,
  InterpError,
  InterpObject,
  InterpRegExp,
  InterpreterRefusal,
  isReference,
  modelledKey,
  NativeFunction,
  deleteMember,
  ownEnumerableKeys,
  setMember,
  ThrowSignal,
  toBoolean,
  toInteger,
  toNumber,
  toPrimitive,
  toPropertyKey,
  toStringValue,
  looseEquals,
  typeOf,
  type Host,
  type ValueSlot,
} from './builtins.js';

const generate = ((_generate as unknown as { default?: typeof _generate }).default ??
  _generate) as typeof _generate;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Where the machine was when a budget ran out, for the dispatcher to judge
 * against what the native recogniser read.
 *
 * A budget is spent by a loop, and a loop the recogniser read is the one
 * place its exhaustion says nothing worse than "too much work": the
 * rotation loop of obfuscated2.js outruns any sensible budget and the match
 * over it is right. The same budget spent in a recursion, in a callback a
 * builtin invoked, or in a function the recogniser never read is where a
 * crash or a hang the output would erase begins - `(function r(n) { return
 * r(n + 1) + 1 })(0)` in the rotation IIFE throws a RangeError the input
 * keeps and the pruned output lost. So the site is recorded with the error
 * rather than argued from the budget alone.
 */
export interface ExhaustionSite {
  /** The loops running when the budget ran out, outermost first. */
  readonly loops: readonly t.Loop[];
  /** Every function entered while one of those loops was running, in order of first entry. */
  readonly entered: readonly t.Function[];
  /** A function entered while a frame of it was already running under those loops: a recursion. */
  readonly recursed: t.Function | undefined;
  /** A function a builtin invoked under those loops: a callback. */
  readonly callback: t.Function | undefined;
}

/**
 * A resource guard fired. These are deliberately *not* catchable by interpreted
 * `try`/`catch`: a decoder that could swallow the step limit could re-enter the
 * loop that exhausted it and hang the thread anyway.
 */
export class InterpreterLimitError extends Error {
  /** Where the budget ran out; set on a step or time budget only. */
  site: ExhaustionSite | undefined;
}

export class StepLimitExceeded extends InterpreterLimitError {
  constructor(limit: number) {
    super(`Interpreter exceeded its step budget (${limit} steps)`);
    this.name = 'StepLimitExceeded';
  }
}

export class TimeLimitExceeded extends InterpreterLimitError {
  constructor(ms: number) {
    super(`Interpreter exceeded its time budget (${ms} ms)`);
    this.name = 'TimeLimitExceeded';
  }
}

export class CallDepthExceeded extends InterpreterLimitError {
  constructor(limit: number) {
    super(`Interpreter exceeded its call depth limit (${limit} frames)`);
    this.name = 'CallDepthExceeded';
  }
}

export class MemoryLimitExceeded extends InterpreterLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryLimitExceeded';
  }
}

/**
 * The program used syntax outside the vocabulary (see `checkVocabulary`).
 *
 * A refusal, not a fall-through: a construct the interpreter does not walk is
 * one it cannot compute, and the dispatcher treats every refusal raised while
 * a slice is built as a verdict on the slice. It is raised before anything
 * runs, so a `class` in a branch the probes never reach still refuses.
 */
export class UnsupportedSyntaxError extends InterpreterRefusal {
  constructor(
    readonly nodeType: string,
    readonly line?: number,
  ) {
    super(`unsupported syntax for the interpreter: ${nodeType}${line ? ` (line ${line})` : ''}`);
    this.name = 'UnsupportedSyntaxError';
  }
}

/** An interpreted `throw` that reached the boundary. */
export class InterpreterRuntimeError extends Error {
  constructor(
    message: string,
    /** The thrown value, externalized. */
    readonly value: unknown,
  ) {
    super(message);
    this.name = 'InterpreterRuntimeError';
  }
}

function isFatal(error: unknown): boolean {
  return (
    error instanceof InterpreterLimitError ||
    error instanceof UnsupportedSyntaxError ||
    error instanceof InterpreterRefusal
  );
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/** Sentinel for a `let`/`const` binding that is hoisted but not yet initialized. */
const TDZ = Symbol('uninitialized');

class Binding implements ValueSlot {
  /** Made by a sloppy-mode assignment to an undeclared name: the one kind `delete` removes. */
  implicit = false;
  /** A `let`, `const` or `class`: at the top level, no property of the global object. */
  lexical = false;
  /**
   * An immutable binding that sloppy code may write to without effect: the
   * name of a named function expression, which is created with
   * CreateImmutableBinding(name, false). A `const` is the strict kind - a
   * write is a TypeError whatever the writer's mode - so it stays false.
   */
  silent = false;
  /**
   * A non-writable, non-configurable data property of the global object -
   * `undefined`, `NaN`, `Infinity`. Silent like the name above, but a strict
   * write is the property's TypeError rather than a constant's, and a
   * top-level declaration of the name is an early error for the script.
   */
  fixed = false;

  constructor(
    public value: unknown,
    public mutable: boolean,
  ) {}
}

const FIXED_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);

/**
 * A `this` the model cannot produce, held in place of one until it is read.
 *
 * Sloppy-mode code sees the global object for a bare call and a wrapper object
 * for a primitive receiver; neither exists here. Binding a sentinel rather than
 * refusing at the call keeps the refusal exact: V8 only produces those values
 * when `this` is evaluated, and a decoder called with no receiver that never
 * mentions `this` is not touched by them.
 */
class UnmodelledThis {
  constructor(readonly reason: string) {}
}

const GLOBAL_THIS = new UnmodelledThis(
  "'this' is the global object here - at the top level of a script, or in a sloppy-mode function called without a receiver - and the interpreter has no global object",
);

/** What a sloppy-mode function binds for `thisArg`. Strict functions bind it as given. */
function sloppyThis(thisArg: unknown): unknown {
  if (thisArg === undefined || thisArg === null) return GLOBAL_THIS;
  const type = typeof thisArg;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return new UnmodelledThis(
      `a sloppy-mode function called on the ${type} ${JSON.stringify(thisArg)} sees it boxed into a wrapper object, which the interpreter does not have`,
    );
  }
  return thisArg;
}

class Environment {
  /** Created lazily: most block scopes declare nothing. */
  bindings: Map<string, Binding> | null = null;
  hasThis = false;
  thisValue: unknown = undefined;
  /** Strict-mode code: inherited lexically, set by a directive or the program. */
  strict: boolean;

  constructor(readonly parent: Environment | null) {
    this.strict = parent !== null && parent.strict;
  }

  declare(name: string, value: unknown, mutable: boolean): Binding {
    const binding = new Binding(value, mutable);
    (this.bindings ??= new Map()).set(name, binding);
    return binding;
  }

  own(name: string): Binding | undefined {
    return this.bindings?.get(name);
  }

  lookup(name: string): Binding | null {
    for (let env: Environment | null = this; env !== null; env = env.parent) {
      const binding = env.bindings?.get(name);
      if (binding !== undefined) return binding;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

type FunctionNode =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod;

/** Generator settings chosen to land as close to obfuscator output as possible. */
const REGENERATE: Parameters<typeof generate>[1] = {
  compact: true,
  comments: false,
  // `extra.raw` still wins for literals the parser produced, so `'\x61'` stays
  // `'\x61'`; this only decides the quoting of literals a pass rebuilt.
  jsescOption: { quotes: 'single' },
};

/**
 * What `Function.prototype.toString` reports for interpreted functions.
 *
 * Exactness matters here in a way it does not for most of the interpreter. A
 * self-defending decoder reads its own text and changes what it computes based
 * on what it finds, so this class is ordered by fidelity and says out loud when
 * it has to settle for less:
 *
 * 1. Slice the original program text with the node's own `start`/`end`. This is
 *    byte-for-byte what V8 would return, because it is literally the same bytes.
 * 2. Regenerate the node with the printer. Semantically equivalent and, for the
 *    compact output every obfuscator emits, usually identical - but "usually"
 *    is the reason step 2 files a diagnostic.
 *
 * Results are cached per AST node: a closure created a million times inside a
 * loop stringifies to the same text every time.
 */
class FunctionSource {
  private readonly cache = new WeakMap<object, string>();
  /**
   * Deduplicated, in first-occurrence order, and handed out as the same array
   * so a caller can poll it after every decode without an allocation: a
   * decoder that first stringifies itself on the 40th call is reported by the
   * poll after the 40th call.
   */
  private readonly messages: string[] = [];
  private readonly seen = new Set<string>();
  /**
   * Characters left to spend on source text, across every function.
   *
   * Nested functions each carry their children's text, so a deeply nested
   * program can ask for quadratically more text than it contains. Everything
   * else in this interpreter is bounded, and this has to be too.
   */
  private budget: number;

  constructor(
    private readonly text: string | null,
    budget: number,
  ) {
    this.budget = budget;
  }

  /** The `toString` text for `node`, computed once per node. */
  textFor(node: FunctionNode, name: string): string {
    const cached = this.cache.get(node);
    if (cached !== undefined) return cached;
    const produced = this.produce(node, name);
    this.budget -= produced.length;
    this.cache.set(node, produced);
    return produced;
  }

  diagnostics(): readonly string[] {
    return this.messages;
  }

  private produce(node: FunctionNode, name: string): string {
    if (this.budget <= 0) {
      this.note(
        `Exhausted the budget for function source text; Function.prototype.toString falls back ` +
          `to the [native code] form from here on. A decoder that inspects its own text will ` +
          `decode incorrectly.`,
      );
      return `function ${name}() { [native code] }`;
    }

    const exact = this.sliceOriginal(node);
    if (exact !== null) return exact;

    let regenerated: string | null = null;
    try {
      const printed = generate(node, REGENERATE).code;
      if (printed.length > 0) regenerated = printed;
    } catch {
      /* Fall through to the placeholder. */
    }

    const label = name === '' ? 'an anonymous function' : `'${name}'`;
    if (regenerated === null) {
      this.note(
        `Could not produce source text for ${label}; Function.prototype.toString will report ` +
          `the [native code] form. A decoder that inspects its own text will decode incorrectly.`,
      );
      return `function ${name}() { [native code] }`;
    }

    this.note(
      this.text === null
        ? `No original source was supplied to the interpreter, so Function.prototype.toString ` +
            `reports regenerated source rather than the program's own bytes. A decoder that ` +
            `hashes, measures or pattern-matches its own text may decode incorrectly.`
        : `Source offsets for ${label} are missing or do not match the supplied source, so ` +
            `Function.prototype.toString reports regenerated source for it.`,
    );
    return regenerated;
  }

  /**
   * The node's own bytes, or `null` when they cannot be confirmed as its bytes.
   *
   * Offsets survive parsing but not `t.cloneNode`, and a pass that rebuilt the
   * node leaves stale ones behind, so a slice is only trusted when it still
   * looks like the construct it claims to be. Guessing here would be worse than
   * regenerating: a wrong slice is silently wrong plaintext.
   */
  private sliceOriginal(node: FunctionNode): string | null {
    const text = this.text;
    if (text === null) return null;
    const { start, end } = node;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (start < 0 || end <= start || end > text.length) return null;

    const slice = text.slice(start, end);
    return plausibleFunctionText(node, slice) ? slice : null;
  }

  private note(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.messages.push(message);
  }
}

/** A cheap shape check that the offsets still point at this kind of function. */
function plausibleFunctionText(node: FunctionNode, text: string): boolean {
  if (node.type === 'ArrowFunctionExpression') return text.includes('=>');
  if (node.type === 'ObjectMethod') return text.endsWith('}');
  return /^(?:async\s+)?function\b/.test(text);
}

class InterpFunction extends Callable {
  /** Strict by a `'use strict'` directive of its own or of any enclosing code. */
  readonly strict: boolean;
  /**
   * A concise method (`{ m() {} }`): binds `this` and `arguments` like a
   * function expression, but has no [[Construct]] and no `prototype` - `new
   * o.m()` is a TypeError and `o.m.prototype` is `undefined`, as for an arrow.
   */
  readonly isMethod: boolean;

  constructor(
    readonly node: FunctionNode,
    readonly env: Environment,
    readonly isArrow: boolean,
    readonly name: string,
    private readonly sources: FunctionSource,
  ) {
    super();
    // An async function returns a promise and a generator an iterator; run as
    // a plain function either would return its body's value instead. The
    // vocabulary check refuses both before anything runs; this is the guard
    // for a node minted after it.
    if (node.async || node.generator) {
      throw new UnsupportedSyntaxError(node.async ? 'AsyncFunction' : 'GeneratorFunction', node.loc?.start.line);
    }
    this.isMethod = node.type === 'ObjectMethod';
    this.strict = env.strict || hasUseStrict(node);
  }

  override get autoPrototype(): boolean {
    return !this.isArrow && !this.isMethod;
  }

  override get sourceText(): string {
    return this.sources.textFor(this.node, this.name);
  }

  get arity(): number {
    let count = 0;
    for (const param of this.node.params) {
      if (param.type === 'AssignmentPattern' || param.type === 'RestElement') break;
      count++;
    }
    return count;
  }

  /** A parameter at that position, a rest parameter, or `arguments` in the body can read it. */
  override canSeeArgument(index: number): boolean {
    const params = this.node.params;
    if (params.length > index) return true;
    if (params.some((param) => param.type === 'RestElement')) return true;
    return !this.isArrow && usesArguments(this.node);
  }
}

/**
 * A `'use strict'` directive: only the exact spelling counts (`'use\x20strict'`
 * does not), and only in the directive prologue, which is where Babel keeps
 * `directives` - a string statement after real code is an expression.
 */
function hasUseStrict(node: FunctionNode): boolean {
  if (node.body.type !== 'BlockStatement') return false;
  return node.body.directives.some(isUseStrict);
}

export function isUseStrict(directive: t.Directive): boolean {
  const raw = directive.value.extra?.raw;
  if (typeof raw === 'string') return raw === "'use strict'" || raw === '"use strict"';
  // A directive rebuilt without its raw text: the cooked value is all there is.
  return directive.value.value === 'use strict';
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

const RETURN = 1;
const BREAK = 2;
const CONTINUE = 3;

interface Completion {
  readonly type: 1 | 2 | 3;
  readonly value: unknown;
  readonly label: string | null;
  /** The statement that produced it, for the report when it reaches somewhere it cannot go. */
  readonly node: t.Statement;
}

/** `null` is the normal completion; allocation only happens for abrupt ones. */
type Result = Completion | null;

/** What a loop should do with a completion coming out of its body. */
const LOOP_CONTINUE = 0;
const LOOP_BREAK = 1;
const LOOP_PROPAGATE = 2;

// ---------------------------------------------------------------------------
// Hoisting
// ---------------------------------------------------------------------------

interface HoistPlan {
  readonly functions: t.FunctionDeclaration[];
  readonly lexical: string[];
  readonly vars: string[];
}

/** Plans are pure functions of the AST, so they are computed once per node. */
const hoistPlans = new WeakMap<object, HoistPlan>();
const argumentsUse = new WeakMap<object, boolean>();

function collectPatternNames(pattern: t.Node, out: string[]): void {
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      return;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') collectPatternNames(property.argument, out);
        else collectPatternNames(property.value, out);
      }
      return;
    case 'ArrayPattern':
      for (const element of pattern.elements) if (element) collectPatternNames(element, out);
      return;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out);
      return;
    case 'RestElement':
      collectPatternNames(pattern.argument, out);
      return;
    default:
      return;
  }
}

/** `var` names below `node`, not crossing into a nested function. */
function collectVarNames(node: t.Node | null | undefined, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case 'VariableDeclaration':
      if (node.kind === 'var') {
        for (const declarator of node.declarations) collectPatternNames(declarator.id, out);
      }
      return;
    case 'BlockStatement':
    case 'Program':
      for (const statement of node.body) collectVarNames(statement, out);
      return;
    case 'IfStatement':
      collectVarNames(node.consequent, out);
      collectVarNames(node.alternate, out);
      return;
    case 'ForStatement':
      collectVarNames(node.init, out);
      collectVarNames(node.body, out);
      return;
    case 'ForInStatement':
    case 'ForOfStatement':
      collectVarNames(node.left, out);
      collectVarNames(node.body, out);
      return;
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'LabeledStatement':
      collectVarNames(node.body, out);
      return;
    case 'TryStatement':
      collectVarNames(node.block, out);
      if (node.handler) collectVarNames(node.handler.body, out);
      collectVarNames(node.finalizer, out);
      return;
    case 'SwitchStatement':
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) collectVarNames(statement, out);
      }
      return;
    default:
      return;
  }
}

function buildPlan(statements: readonly t.Statement[], functionScope: boolean): HoistPlan {
  const functions: t.FunctionDeclaration[] = [];
  const lexical: string[] = [];
  const vars: string[] = [];

  for (const statement of statements) {
    if (statement.type === 'FunctionDeclaration' && statement.id) functions.push(statement);
    else if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations) collectPatternNames(declarator.id, lexical);
    }
    if (functionScope) collectVarNames(statement, vars);
  }
  return { functions, lexical, vars };
}

/** True when a non-arrow function body mentions `arguments`. */
function usesArguments(node: FunctionNode): boolean {
  const cached = argumentsUse.get(node);
  if (cached !== undefined) return cached;

  let found = false;
  const visit = (current: unknown): void => {
    if (found || !current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const candidate = current as t.Node;
    if (typeof candidate.type !== 'string') return;
    if (candidate.type === 'Identifier' && candidate.name === 'arguments') {
      found = true;
      return;
    }
    if (
      candidate.type === 'FunctionDeclaration' ||
      candidate.type === 'FunctionExpression' ||
      candidate.type === 'ObjectMethod' ||
      candidate.type === 'ClassMethod'
    ) {
      return;
    }
    for (const key of Object.keys(candidate)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      visit((candidate as unknown as Record<string, unknown>)[key]);
    }
  };

  visit(node.body);
  for (const param of node.params) visit(param);
  argumentsUse.set(node, found);
  return found;
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Every construct the interpreter walks, checked over the whole slice before
 * any of it runs. `checkVocabulary` is the language half of the closed
 * whitelist `builtins.ts` describes: each case below is a node type the
 * evaluator computes exactly, the operator sets are the operators it computes,
 * and the `default` branch is the refusal. Anything not named here - a class,
 * an accessor, a generator, `async`, `with`, a tagged template, `new.target`,
 * a BigInt, a private name, a pipeline - has semantics the walk does not model,
 * and answering it with a plausible value is exactly the wrong output this
 * tier exists to prevent.
 *
 * The check is static and runs at construction so that a refusal does not
 * depend on which branch the probes happened to take: a decoder whose `else`
 * arm holds a `class` is refused whether or not sample index 3 reaches it.
 *
 * One rule needs the statement's position and the code's strictness. A
 * function declaration is a plain hoisted binding at the top of a function or
 * program body, and a plain block-scoped one inside a block or `case` in
 * strict code; in sloppy code a declaration inside a block, a `case`, an `if`
 * arm or a label is Annex B.3.3's dual binding - block-scoped and var-hoisted
 * at once, assigned when the declaration is evaluated - which is not modelled.
 */
const UNARY_OPERATORS = new Set(['-', '+', '!', '~', 'typeof', 'void', 'delete']);
const BINARY_OPERATORS = new Set([
  '+', '-', '*', '/', '%', '**',
  '==', '!=', '===', '!==', '<', '>', '<=', '>=',
  '&', '|', '^', '<<', '>>', '>>>',
  'in', 'instanceof',
]);
const LOGICAL_OPERATORS = new Set(['&&', '||', '??']);
const ASSIGNMENT_OPERATORS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=',
  '<<=', '>>=', '>>>=', '&=', '|=', '^=',
  '&&=', '||=', '??=',
]);
const DECLARATION_KINDS = new Set(['var', 'let', 'const']);

/** Type-level children: erased at run time, so they are not walked. */
const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'returnType', 'predicate']);

/** Where a statement sits, for the function-declaration rule. */
type Position = 'top' | 'block' | 'other';

function refuseSyntax(node: t.Node, what: string = node.type): never {
  throw new UnsupportedSyntaxError(what, node.loc?.start.line);
}

function checkVocabulary(statements: readonly t.Statement[], strict: boolean): void {
  for (const statement of statements) checkNode(statement, strict, 'top');
}

function checkNode(node: t.Node, strict: boolean, position: Position): void {
  switch (node.type) {
    // -- Statements
    case 'FunctionDeclaration':
      if (position !== 'top' && !(position === 'block' && strict)) {
        refuseSyntax(node, 'FunctionDeclaration in a block (Annex B)');
      }
      checkFunction(node, strict);
      return;
    case 'VariableDeclaration':
      if (!DECLARATION_KINDS.has(node.kind)) refuseSyntax(node, `VariableDeclaration:${node.kind}`);
      break;
    case 'ForOfStatement':
      if (node.await) refuseSyntax(node, 'ForAwaitStatement');
      break;
    case 'BlockStatement':
      for (const directive of node.directives) checkNode(directive, strict, 'other');
      for (const statement of node.body) checkNode(statement, strict, 'block');
      return;
    case 'SwitchCase':
      if (node.test) checkNode(node.test, strict, 'other');
      for (const statement of node.consequent) checkNode(statement, strict, 'block');
      return;
    case 'ExpressionStatement':
    case 'EmptyStatement':
    case 'DebuggerStatement':
    case 'IfStatement':
    case 'ReturnStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ThrowStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'SwitchStatement':
    case 'TryStatement':
    case 'CatchClause':
    case 'LabeledStatement':
    case 'VariableDeclarator':
    case 'Directive':
    case 'DirectiveLiteral':
      break;

    // -- Functions
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      checkFunction(node, strict);
      return;
    case 'ObjectMethod':
      if (node.kind !== 'method') refuseSyntax(node, `ObjectMethod:${node.kind}`);
      checkNode(node.key, strict, 'other');
      checkFunction(node, strict);
      return;

    // -- Expressions
    case 'UnaryExpression':
      if (!UNARY_OPERATORS.has(node.operator)) refuseSyntax(node, `UnaryExpression:${node.operator}`);
      break;
    case 'BinaryExpression':
      if (!BINARY_OPERATORS.has(node.operator)) refuseSyntax(node, `BinaryExpression:${node.operator}`);
      break;
    case 'LogicalExpression':
      if (!LOGICAL_OPERATORS.has(node.operator)) refuseSyntax(node, `LogicalExpression:${node.operator}`);
      break;
    case 'AssignmentExpression':
      if (!ASSIGNMENT_OPERATORS.has(node.operator)) refuseSyntax(node, `AssignmentExpression:${node.operator}`);
      break;
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'RegExpLiteral':
    case 'TemplateLiteral':
    case 'TemplateElement':
    case 'Identifier':
    case 'ThisExpression':
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'ObjectProperty':
    case 'SpreadElement':
    case 'UpdateExpression':
    case 'ConditionalExpression':
    case 'SequenceExpression':
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
    case 'ParenthesizedExpression':
      break;

    // -- Type-level wrappers, erased to their operand
    case 'TypeCastExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'TSSatisfiesExpression':
    case 'TSInstantiationExpression':
      checkNode(node.expression, strict, 'other');
      return;

    // -- Patterns
    case 'ObjectPattern':
    case 'ArrayPattern':
    case 'AssignmentPattern':
    case 'RestElement':
      break;

    default:
      refuseSyntax(node);
  }
  checkChildren(node, strict);
}

function checkFunction(node: FunctionNode, strict: boolean): void {
  if (node.async || node.generator) refuseSyntax(node, node.async ? 'AsyncFunction' : 'GeneratorFunction');
  const inner = strict || hasUseStrict(node);
  for (const param of node.params) checkNode(param, inner, 'other');
  if (node.body.type === 'BlockStatement') {
    for (const directive of node.body.directives) checkNode(directive, inner, 'other');
    for (const statement of node.body.body) checkNode(statement, inner, 'top');
  } else {
    checkNode(node.body, inner, 'other');
  }
}

function checkChildren(node: t.Node, strict: boolean): void {
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    if (TYPE_KEYS.has(key)) continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) if (item) checkNode(item as t.Node, strict, 'other');
    } else if (child && typeof (child as t.Node).type === 'string') {
      checkNode(child as t.Node, strict, 'other');
    }
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InterpreterOptions {
  /**
   * The original program text the statements were parsed from.
   *
   * Supplying it is what lets `Function.prototype.toString` return a function's
   * own bytes instead of a reprint of its AST, which is the difference between
   * decoding and hanging for a `selfDefending` decoder. It is only used when a
   * node's `start`/`end` still point into this text; see `FunctionSource`.
   */
  source?: string;
  /**
   * Whether the statements are strict-mode code: a module, or a script with a
   * `'use strict'` prologue. The prologue is a property of the `Program`, not
   * of the statements cut from it, so the caller has to say. Decides what
   * `this` is in a bare call, whether an assignment to an undeclared name
   * creates it or throws, and whether `arguments` aliases the parameters.
   * Sloppy by default, as a script is.
   */
  strict?: boolean;
  /**
   * Whether the statements are a module. Only a module binds `undefined` as
   * its top-level `this`; a script's is the global object whether or not it
   * is strict, and the interpreter has no global object to bind. Implies
   * `strict`.
   */
  module?: boolean;
  /** Node evaluations allowed per top-level entry (`run`, `read`, `call`). */
  maxSteps?: number;
  /** Wall-clock budget per top-level entry. */
  timeoutMs?: number;
  maxCallDepth?: number;
  /** Longest single string the program may produce. */
  maxStringLength?: number;
  /** Total string length one entry may allocate; stops a decompression bomb. */
  maxTotalStringLength?: number;
  maxArrayLength?: number;
  /** Longest subject a host regex may be run against. */
  maxRegexInput?: number;
}

interface ResolvedOptions {
  maxSteps: number;
  timeoutMs: number;
  maxCallDepth: number;
  maxStringLength: number;
  maxTotalStringLength: number;
  maxArrayLength: number;
  maxRegexInput: number;
}

const DEFAULTS: ResolvedOptions = {
  maxSteps: 20_000_000,
  timeoutMs: 5_000,
  maxCallDepth: 512,
  maxStringLength: 16_000_000,
  maxTotalStringLength: 128_000_000,
  maxArrayLength: 10_000_000,
  maxRegexInput: 1_000_000,
};

export interface Interpreter {
  /** Read a top-level binding as plain host data. */
  read(name: string): unknown;
  /** Invoke a top-level function; arguments and result cross as plain data. */
  call(name: string, args: readonly unknown[]): unknown;
  /** True when the name is bound at the top level. */
  has(name: string): boolean;
  /** True when the binding holds something callable. */
  isCallable(name: string): boolean;
  /** Total node evaluations since construction, across every entry. */
  steps(): number;
  /**
   * Fidelity compromises made while running, deduplicated, in the order they
   * were first made.
   *
   * Currently only one thing lands here, and it is the one worth shouting
   * about: a function whose `toString` could not be answered from the original
   * bytes. Empty means every function stringified to its own source. The
   * array only grows and is the same object on every call, so polling it
   * after each evaluation costs a length comparison.
   */
  diagnostics(): readonly string[];
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

class Machine implements Host {
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxRegexInput: number;

  private readonly options: ResolvedOptions;
  private readonly global = new Environment(null);
  private readonly functionSource: FunctionSource;

  /** Steps left in the current entry; counts down so the deadline mask is cheap. */
  private remaining = 0;
  private totalSteps = 0;
  private deadline = 0;
  private depth = 0;
  private stringBudget = 0;
  /** The loops running now, outermost first; see `ExhaustionSite`. */
  private readonly loops: t.Loop[] = [];
  /** Functions entered while a loop was running, first entry first; dropped when the last loop exits. */
  private readonly entered = new Set<t.Function>();
  /** Frames of each function running now, for the recursion witness. */
  private readonly running = new Map<t.Function, number>();
  private recursed: t.Function | undefined;
  private callback: t.Function | undefined;

  constructor(statements: readonly t.Statement[], options: InterpreterOptions) {
    this.options = { ...DEFAULTS, ...options };
    this.maxStringLength = this.options.maxStringLength;
    this.maxArrayLength = this.options.maxArrayLength;
    this.maxRegexInput = this.options.maxRegexInput;
    // Built before anything is hoisted: hoisting mints functions, and a function
    // has to know how to stringify itself from the moment it exists.
    this.functionSource = new FunctionSource(options.source ?? null, this.maxStringLength);

    this.global.hasThis = true;
    this.global.strict = (options.strict ?? false) || (options.module ?? false);
    this.global.thisValue = options.module ? undefined : GLOBAL_THIS;
    for (const [name, value] of globalEntries()) {
      const binding = this.global.declare(name, value, !FIXED_GLOBALS.has(name));
      if (!binding.mutable) binding.silent = binding.fixed = true;
    }

    // Before anything runs, and over the whole slice: see `checkVocabulary`.
    checkVocabulary(statements, this.global.strict);

    this.enter();
    try {
      this.hoist(statements, this.global, true);
      const completion = this.execStatements(statements, this.global);
      // A `return`, `break` or `continue` at the top level is not a program: it
      // is a statement cut loose from the function or loop that gave it a
      // meaning, and evaluating the slice around it as if it were not there
      // is the slicer's mistake carried through to a string. Running on would
      // hand back a top-level environment that stopped being built partway.
      if (completion !== null) {
        const line = completion.node.loc?.start.line;
        throw new InterpreterRefusal(
          `the slice's top level ends in a \`${describeCompletion(completion)}\` statement` +
            `${line ? ` (line ${line})` : ''}, which only means something inside the function ` +
            `or loop it was taken from`,
        );
      }
    } catch (error) {
      throw this.toHostError(error);
    } finally {
      this.leave();
    }
  }

  // -- Host ---------------------------------------------------------------

  /** `Host.call`: the builtin table re-entering interpreted code. */
  call(callee: unknown, thisArg: unknown, args: readonly unknown[]): unknown {
    return this.invoke(callee, thisArg, args, true);
  }

  isCallable(value: unknown): boolean {
    return value instanceof Callable;
  }

  trackString(value: string): string {
    if (value.length > this.maxStringLength) {
      throw new MemoryLimitExceeded(
        `Interpreter produced a string of ${value.length} characters (limit ${this.maxStringLength})`,
      );
    }
    this.stringBudget -= value.length;
    if (this.stringBudget < 0) {
      throw new MemoryLimitExceeded(
        `Interpreter exceeded its string allocation budget (${this.options.maxTotalStringLength} characters)`,
      );
    }
    return value;
  }

  checkArrayLength(length: number): void {
    if (length > this.maxArrayLength) {
      throw new MemoryLimitExceeded(
        `Interpreter exceeded its array length limit (${this.maxArrayLength})`,
      );
    }
  }

  tick(cost: number): void {
    this.remaining -= cost;
    if (this.remaining < 0) throw this.exhausted(new StepLimitExceeded(this.options.maxSteps));
  }

  /** Stamp a budget error with where the machine was; see `ExhaustionSite`. */
  private exhausted(error: InterpreterLimitError): InterpreterLimitError {
    error.site = {
      loops: [...this.loops],
      entered: [...this.entered],
      recursed: this.recursed,
      callback: this.callback,
    };
    return error;
  }

  private enterLoop(node: t.Loop): void {
    this.loops.push(node);
  }

  private leaveLoop(): void {
    this.loops.pop();
    // What ran under a loop that has finished is finished with it; what is
    // remembered is only ever under a loop still running.
    if (this.loops.length === 0) {
      this.entered.clear();
      this.recursed = undefined;
      this.callback = undefined;
    }
  }

  throwError(name: string, message: string, exact = true): never {
    const error = new InterpError(name, name, message);
    error.exactMessage = exact;
    throw new ThrowSignal(error);
  }

  private sandboxGlobal: GlobalObject | undefined;

  /**
   * `Host.globalObject`: the sandbox global over this machine's top level.
   * A read answers a builtin or a binding the slice declares at its top
   * level; a name bound nowhere here may still be bound in the program,
   * whose value the sandbox does not have, so it is refused rather than
   * read as `undefined`. A write to a bound name assigns it, so `g.atob =
   * polyfill` is what the next bare `atob(e)` calls; to an unbound name it
   * makes the global, the way a script's `g.x = 1` makes a bare `x` resolve.
   */
  globalObject(): GlobalObject {
    return (this.sandboxGlobal ??= new GlobalObject({
      read: (name) => {
        const binding = this.global.own(name);
        if (binding === undefined) {
          throw new InterpreterRefusal(
            `the global object's '${name}' is not in the sandbox: the slice does not declare it, and the program may`,
          );
        }
        if (binding.lexical) {
          throw new InterpreterRefusal(`'${name}' is a top-level lexical binding, which is no property of the global object`);
        }
        return binding.value;
      },
      has: (name) => {
        const binding = this.global.own(name);
        if (binding === undefined) {
          throw new InterpreterRefusal(
            `whether the global object has '${name}' is not known to the sandbox: the slice does not declare it, and the program may`,
          );
        }
        return !binding.lexical;
      },
      write: (name, value) => {
        const binding = this.global.own(name);
        if (binding === undefined) {
          this.global.declare(name, value, true).implicit = true;
          return;
        }
        if (binding.lexical || !binding.mutable) {
          throw new InterpreterRefusal(`writing '${name}' through the global object over a top-level lexical binding is not modelled`);
        }
        binding.value = value;
      },
    }));
  }

  // -- Public API ---------------------------------------------------------

  read(name: string): unknown {
    const binding = this.global.lookup(name);
    if (binding === null || binding.value === TDZ) return undefined;
    return externalize(binding.value);
  }

  has(name: string): boolean {
    return this.global.lookup(name) !== null;
  }

  isCallableBinding(name: string): boolean {
    const binding = this.global.lookup(name);
    return binding !== null && binding.value instanceof Callable;
  }

  steps(): number {
    return this.totalSteps;
  }

  diagnostics(): readonly string[] {
    return this.functionSource.diagnostics();
  }

  callExported(name: string, args: readonly unknown[]): unknown {
    const binding = this.global.lookup(name);
    if (binding === null) throw new ReferenceError(`${name} is not defined in the evaluated slice`);
    if (!(binding.value instanceof Callable)) {
      throw new TypeError(`${name} is not a function in the evaluated slice`);
    }
    const internal = args.map((arg) => internalize(arg));
    this.enter();
    try {
      return externalize(this.invoke(binding.value, undefined, internal));
    } catch (error) {
      throw this.toHostError(error);
    } finally {
      this.leave();
    }
  }

  private toHostError(error: unknown): unknown {
    if (error instanceof ThrowSignal) {
      // A diagnostic for the host, not a value for the program: an inexact
      // message is still the best description of what was thrown.
      return new InterpreterRuntimeError(describeError(error.value), externalize(error.value));
    }
    return error;
  }

  // -- Budgets ------------------------------------------------------------

  private enter(): void {
    this.remaining = this.options.maxSteps;
    this.stringBudget = this.options.maxTotalStringLength;
    this.deadline = Date.now() + this.options.timeoutMs;
    this.depth = 0;
  }

  private leave(): void {
    this.totalSteps += this.options.maxSteps - this.remaining;
  }

  /**
   * One node evaluation. The wall clock is only sampled every 1024 steps -
   * `Date.now()` on every node costs more than the interpretation itself.
   */
  private step(): void {
    if (--this.remaining < 0) throw this.exhausted(new StepLimitExceeded(this.options.maxSteps));
    if ((this.remaining & 0x3ff) === 0 && Date.now() > this.deadline) {
      throw this.exhausted(new TimeLimitExceeded(this.options.timeoutMs));
    }
  }

  // -- Scopes -------------------------------------------------------------

  private plan(key: object, statements: readonly t.Statement[], functionScope: boolean): HoistPlan {
    let plan = hoistPlans.get(key);
    if (plan === undefined) {
      plan = buildPlan(statements, functionScope);
      hoistPlans.set(key, plan);
    }
    return plan;
  }

  private hoist(statements: readonly t.Statement[], env: Environment, functionScope: boolean): void {
    const plan = this.plan(statements, statements, functionScope);
    if (functionScope) {
      // A `var` never clobbers a parameter of the same name.
      for (const name of plan.vars) if (env.own(name) === undefined) env.declare(name, undefined, true);
    }
    for (const name of plan.lexical) {
      this.refuseFixedRedeclaration(env, name);
      env.declare(name, TDZ, true).lexical = true;
    }
    for (const declaration of plan.functions) {
      // A function declaration named like a parameter writes the parameter's
      // own binding - the one a mapped `arguments` object aliases - rather
      // than minting a second one it can no longer see.
      const name = declaration.id!.name;
      const existing = env.own(name);
      this.refuseFixedRedeclaration(env, name);
      const fn = this.makeFunction(declaration, env);
      if (existing !== undefined) {
        existing.value = fn;
        existing.mutable = true;
      } else {
        env.declare(name, fn, true);
      }
    }
  }

  /**
   * A top-level `let`, `const`, `class` or function declaration of
   * `undefined`, `NaN` or `Infinity` is an early error for the whole script
   * (GlobalDeclarationInstantiation over a restricted global property), so
   * nothing in the slice runs. A `var` of the name is a no-op there, and a
   * function's own declaration shadows it like any local.
   */
  private refuseFixedRedeclaration(env: Environment, name: string): void {
    if (env.own(name)?.fixed) {
      throw new InterpreterRefusal(
        `declaring '${name}' at the top level redeclares a non-configurable property of the global object, which V8 rejects before the script runs`,
      );
    }
  }

  // -- Statements ---------------------------------------------------------

  private execStatements(statements: readonly t.Statement[], env: Environment): Result {
    for (const statement of statements) {
      const completion = this.execStatement(statement, env, null);
      if (completion !== null) return completion;
    }
    return null;
  }

  private execStatement(node: t.Statement, env: Environment, label: string | null): Result {
    this.step();

    switch (node.type) {
      case 'ExpressionStatement':
        this.evalExpression(node.expression, env);
        return null;

      case 'VariableDeclaration':
        this.execVariableDeclaration(node, env);
        return null;

      case 'FunctionDeclaration':
        // Already bound by hoisting.
        return null;

      case 'EmptyStatement':
      case 'DebuggerStatement':
        return null;

      case 'BlockStatement': {
        const blockEnv = new Environment(env);
        this.hoist(node.body, blockEnv, false);
        return this.execStatements(node.body, blockEnv);
      }

      case 'IfStatement':
        if (toBoolean(this.evalExpression(node.test, env))) {
          return this.execStatement(node.consequent, env, null);
        }
        return node.alternate ? this.execStatement(node.alternate, env, null) : null;

      case 'ReturnStatement':
        return {
          type: RETURN,
          value: node.argument ? this.evalExpression(node.argument, env) : undefined,
          label: null,
          node,
        };

      case 'BreakStatement':
        return { type: BREAK, value: undefined, label: node.label ? node.label.name : null, node };

      case 'ContinueStatement':
        return { type: CONTINUE, value: undefined, label: node.label ? node.label.name : null, node };

      case 'ThrowStatement':
        throw new ThrowSignal(this.evalExpression(node.argument, env));

      case 'WhileStatement':
        return this.execWhile(node, env, label);

      case 'DoWhileStatement':
        return this.execDoWhile(node, env, label);

      case 'ForStatement':
        return this.execFor(node, env, label);

      case 'ForOfStatement':
        return this.execForOf(node, env, label);

      case 'ForInStatement':
        return this.execForIn(node, env, label);

      case 'SwitchStatement':
        return this.execSwitch(node, env, label);

      case 'TryStatement':
        return this.execTry(node, env);

      case 'LabeledStatement': {
        const name = node.label.name;
        const completion = this.execStatement(node.body, env, name);
        if (completion !== null && completion.type === BREAK && completion.label === name) return null;
        return completion;
      }

      default:
        throw new UnsupportedSyntaxError(node.type, node.loc?.start.line);
    }
  }

  private execVariableDeclaration(node: t.VariableDeclaration, env: Environment): void {
    for (const declarator of node.declarations) {
      const value = declarator.init
        ? declarator.id.type === 'Identifier'
          ? this.evalNamed(declarator.init, env, declarator.id.name)
          : this.evalExpression(declarator.init, env)
        : undefined;
      if (node.kind === 'var') {
        // `var x;` must not reset a value the same scope already holds.
        if (declarator.init) this.assignPattern(declarator.id, value, env);
      } else {
        this.initializePattern(declarator.id, value, env, node.kind === 'const');
      }
    }
  }

  private execWhile(node: t.WhileStatement, env: Environment, label: string | null): Result {
    this.enterLoop(node);
    try {
      while (toBoolean(this.evalExpression(node.test, env))) {
        this.step();
        const completion = this.execStatement(node.body, env, null);
        const action = classifyLoopCompletion(completion, label);
        if (action === LOOP_BREAK) break;
        if (action === LOOP_PROPAGATE) return completion;
      }
      return null;
    } finally {
      this.leaveLoop();
    }
  }

  private execDoWhile(node: t.DoWhileStatement, env: Environment, label: string | null): Result {
    this.enterLoop(node);
    try {
      do {
        this.step();
        const completion = this.execStatement(node.body, env, null);
        const action = classifyLoopCompletion(completion, label);
        if (action === LOOP_BREAK) break;
        if (action === LOOP_PROPAGATE) return completion;
      } while (toBoolean(this.evalExpression(node.test, env)));
      return null;
    } finally {
      this.leaveLoop();
    }
  }

  private execFor(node: t.ForStatement, env: Environment, label: string | null): Result {
    this.enterLoop(node);
    try {
      return this.runFor(node, env, label);
    } finally {
      this.leaveLoop();
    }
  }

  private runFor(node: t.ForStatement, env: Environment, label: string | null): Result {
    const loopEnv = new Environment(env);
    let perIteration: string[] = [];

    if (node.init) {
      if (node.init.type === 'VariableDeclaration') {
        if (node.init.kind === 'var') {
          this.execVariableDeclaration(node.init, loopEnv);
        } else {
          const names: string[] = [];
          for (const declarator of node.init.declarations) collectPatternNames(declarator.id, names);
          for (const name of names) loopEnv.declare(name, TDZ, true);
          this.execVariableDeclaration(node.init, loopEnv);
          // `let` in a `for` head is copied per iteration, so a closure created
          // in the body captures that iteration's value rather than the last.
          // A `const` is not copied (CreatePerIterationEnvironment takes only
          // the `let` names): it stays the one immutable binding the head
          // made, and the first `j++` is a TypeError, as it is in V8. Copying
          // it too used to mint a mutable one per iteration and let the loop
          // run to completion.
          if (node.init.kind === 'let') perIteration = names;
        }
      } else {
        this.evalExpression(node.init, loopEnv);
      }
    }

    let current = perIteration.length > 0 ? copyLoopEnv(env, loopEnv, perIteration) : loopEnv;

    for (;;) {
      this.step();
      if (node.test && !toBoolean(this.evalExpression(node.test, current))) break;

      const completion = this.execStatement(node.body, current, null);
      const action = classifyLoopCompletion(completion, label);
      if (action === LOOP_BREAK) break;
      if (action === LOOP_PROPAGATE) return completion;

      if (perIteration.length > 0) current = copyLoopEnv(env, current, perIteration);
      if (node.update) this.evalExpression(node.update, current);
    }
    return null;
  }

  private execForOf(node: t.ForOfStatement, env: Environment, label: string | null): Result {
    if (node.await) throw new UnsupportedSyntaxError('ForAwaitStatement', node.loc?.start.line);
    this.enterLoop(node);
    try {
      return this.runForOf(node, env, label);
    } finally {
      this.leaveLoop();
    }
  }

  private runForOf(node: t.ForOfStatement, env: Environment, label: string | null): Result {
    const iterable = this.evalExpression(node.right, env);

    const consume = (value: unknown): Result | typeof BREAK_SENTINEL => {
      const iterationEnv = new Environment(env);
      this.bindLoopTarget(node.left, value, iterationEnv);
      const completion = this.execStatement(node.body, iterationEnv, null);
      const action = classifyLoopCompletion(completion, label);
      if (action === LOOP_BREAK) return BREAK_SENTINEL;
      if (action === LOOP_PROPAGATE) return completion;
      return null;
    };

    if (typeof iterable === 'string') {
      for (const character of iterable) {
        this.step();
        const outcome = consume(character);
        if (outcome === BREAK_SENTINEL) return null;
        if (outcome !== null) return outcome;
      }
      return null;
    }
    if (Array.isArray(iterable)) {
      for (let index = 0; index < iterable.length; index++) {
        this.step();
        const outcome = consume(iterable[index]);
        if (outcome === BREAK_SENTINEL) return null;
        if (outcome !== null) return outcome;
      }
      return null;
    }
    if (iterable instanceof InterpArguments) {
      // `Array.prototype.values` over an array-like: `length` and each index are
      // read afresh on every step, so a body that writes them is seen.
      for (let index = 0; ; index++) {
        this.step();
        if (index >= Math.max(0, toInteger(getMember(this, iterable, 'length')))) return null;
        const outcome = consume(getMember(this, iterable, index));
        if (outcome === BREAK_SENTINEL) return null;
        if (outcome !== null) return outcome;
      }
    }
    return this.throwError('TypeError', `${toStringValue(iterable)} is not iterable`, false);
  }

  private execForIn(node: t.ForInStatement, env: Environment, label: string | null): Result {
    const target = this.evalExpression(node.right, env);
    if (target === null || target === undefined) return null;

    this.enterLoop(node);
    try {
      for (const key of forInKeys(this, target)) {
        this.step();
        // Deleted before its turn: skipped, as EnumerateObjectProperties skips it.
        if (typeof target === 'object' && !hasProperty(this, target, key)) continue;
        const iterationEnv = new Environment(env);
        this.bindLoopTarget(node.left, key, iterationEnv);
        const completion = this.execStatement(node.body, iterationEnv, null);
        const action = classifyLoopCompletion(completion, label);
        if (action === LOOP_BREAK) break;
        if (action === LOOP_PROPAGATE) return completion;
      }
      return null;
    } finally {
      this.leaveLoop();
    }
  }

  private bindLoopTarget(left: t.Node, value: unknown, env: Environment): void {
    if (left.type === 'VariableDeclaration') {
      const declarator = left.declarations[0];
      if (!declarator) return;
      if (left.kind === 'var') this.assignPattern(declarator.id, value, env);
      else {
        const names: string[] = [];
        collectPatternNames(declarator.id, names);
        for (const name of names) env.declare(name, TDZ, true);
        this.initializePattern(declarator.id, value, env, left.kind === 'const');
      }
      return;
    }
    this.assignPattern(left as t.LVal, value, env);
  }

  private execSwitch(node: t.SwitchStatement, env: Environment, label: string | null): Result {
    const discriminant = this.evalExpression(node.discriminant, env);
    const switchEnv = new Environment(env);

    let flattened = switchBodies.get(node);
    if (flattened === undefined) {
      flattened = node.cases.flatMap((switchCase) => switchCase.consequent);
      switchBodies.set(node, flattened);
    }
    const plan = this.plan(node, flattened, false);
    for (const name of plan.lexical) switchEnv.declare(name, TDZ, true);
    for (const declaration of plan.functions) {
      switchEnv.declare(declaration.id!.name, this.makeFunction(declaration, switchEnv), true);
    }

    let start = -1;
    for (let index = 0; index < node.cases.length; index++) {
      const test = node.cases[index]!.test;
      if (test && this.evalExpression(test, switchEnv) === discriminant) {
        start = index;
        break;
      }
    }
    if (start < 0) start = node.cases.findIndex((switchCase) => switchCase.test === null);
    if (start < 0) return null;

    // Fallthrough: once a case matches, every following case body runs until a
    // `break` (or any other abrupt completion) says otherwise.
    for (let index = start; index < node.cases.length; index++) {
      const completion = this.execStatements(node.cases[index]!.consequent, switchEnv);
      if (completion !== null) {
        if (completion.type === BREAK && (completion.label === null || completion.label === label)) {
          return null;
        }
        return completion;
      }
    }
    return null;
  }

  private execTry(node: t.TryStatement, env: Environment): Result {
    let completion: Result = null;
    let pending: unknown = NOTHING;

    try {
      completion = this.execStatement(node.block, env, null);
    } catch (error) {
      if (isFatal(error) || !(error instanceof ThrowSignal)) throw error;
      if (node.handler) {
        const catchEnv = new Environment(env);
        if (node.handler.param) {
          const names: string[] = [];
          collectPatternNames(node.handler.param, names);
          for (const name of names) catchEnv.declare(name, TDZ, true);
          this.initializePattern(node.handler.param as t.LVal, error.value, catchEnv, false);
        }
        try {
          completion = this.execStatement(node.handler.body, catchEnv, null);
        } catch (inner) {
          if (isFatal(inner)) throw inner;
          pending = inner;
        }
      } else {
        pending = error;
      }
    }

    if (node.finalizer) {
      // An abrupt completion from `finally` replaces whatever the body produced,
      // including a pending throw. That ordering is the whole point of the test.
      const finallyCompletion = this.execStatement(node.finalizer, env, null);
      if (finallyCompletion !== null) return finallyCompletion;
    }
    if (pending !== NOTHING) throw pending;
    return completion;
  }

  // -- Bindings -----------------------------------------------------------

  /** Initialize a hoisted `let`/`const` binding in the current scope. */
  private initializePattern(
    pattern: t.LVal | t.Node,
    value: unknown,
    env: Environment,
    isConst: boolean,
  ): void {
    switch (pattern.type) {
      case 'Identifier': {
        const binding = env.own(pattern.name) ?? env.declare(pattern.name, undefined, true);
        binding.value = value;
        binding.mutable = !isConst;
        return;
      }
      case 'ObjectPattern':
        this.destructureObject(pattern, value, env, (target, item) =>
          this.initializePattern(target, item, env, isConst),
        );
        return;
      case 'ArrayPattern':
        this.destructureArray(pattern, value, (target, item) =>
          this.initializePattern(target, item, env, isConst),
        );
        return;
      case 'AssignmentPattern':
        this.initializePattern(
          pattern.left,
          value === undefined ? this.evalDefault(pattern, env) : value,
          env,
          isConst,
        );
        return;
      case 'RestElement':
        this.initializePattern(pattern.argument, value, env, isConst);
        return;
      default:
        throw new UnsupportedSyntaxError(pattern.type, pattern.loc?.start.line);
    }
  }

  /** A pattern's default, named after the identifier it initialises when it is an anonymous function. */
  private evalDefault(pattern: t.AssignmentPattern, env: Environment): unknown {
    return pattern.left.type === 'Identifier'
      ? this.evalNamed(pattern.right, env, pattern.left.name)
      : this.evalExpression(pattern.right, env);
  }

  /**
   * Assign through the scope chain. An unknown name is a new global in sloppy
   * code and a ReferenceError in strict code.
   */
  private assignPattern(pattern: t.LVal | t.Node, value: unknown, env: Environment): void {
    switch (pattern.type) {
      case 'Identifier': {
        const binding = env.lookup(pattern.name);
        if (binding === null) {
          if (env.strict) this.throwError('ReferenceError', `${pattern.name} is not defined`);
          this.global.declare(pattern.name, value, true).implicit = true;
          return;
        }
        this.writeBinding(binding, pattern.name, value, env);
        return;
      }
      case 'MemberExpression': {
        const object = this.evalExpression(pattern.object as t.Expression, env);
        setMember(this, object, this.memberKey(pattern, env), value, env.strict);
        return;
      }
      case 'ObjectPattern':
        this.destructureObject(pattern, value, env, (target, item) =>
          this.assignPattern(target, item, env),
        );
        return;
      case 'ArrayPattern':
        this.destructureArray(pattern, value, (target, item) => this.assignPattern(target, item, env));
        return;
      case 'AssignmentPattern':
        this.assignPattern(pattern.left, value === undefined ? this.evalDefault(pattern, env) : value, env);
        return;
      case 'RestElement':
        this.assignPattern(pattern.argument, value, env);
        return;
      default:
        throw new UnsupportedSyntaxError(pattern.type, pattern.loc?.start.line);
    }
  }

  private destructureObject(
    pattern: t.ObjectPattern,
    value: unknown,
    env: Environment,
    bind: (target: t.Node, item: unknown) => void,
  ): void {
    if (value === null || value === undefined) {
      // V8 names the first property and prints the source text of the value
      // (`Cannot destructure property 'a' of 'o.x' as it is undefined.`),
      // which the model does not carry; only the name is exact.
      this.throwError('TypeError', `Cannot destructure '${toStringValue(value)}' as it is ${toStringValue(value)}.`, false);
    }
    const taken = new Set<string>();
    for (const property of pattern.properties) {
      this.step();
      if (property.type === 'RestElement') {
        const rest = new InterpObject(null);
        for (const key of ownEnumerableKeys(this, value)) {
          if (!taken.has(key)) rest.props.set(key, getMember(this, value, key));
        }
        bind(property.argument, rest);
        continue;
      }
      const key = property.computed
        ? toPropertyKey(this.evalExpression(property.key as t.Expression, env))
        : propertyName(property.key);
      taken.add(key);
      bind(property.value, getMember(this, value, key));
    }
  }

  private destructureArray(
    pattern: t.ArrayPattern,
    value: unknown,
    bind: (target: t.Node, item: unknown) => void,
  ): void {
    const items = this.toIterableArray(value);
    for (let index = 0; index < pattern.elements.length; index++) {
      this.step();
      const element = pattern.elements[index];
      if (!element) continue;
      if (element.type === 'RestElement') {
        bind(element.argument, items.slice(index));
        return;
      }
      bind(element, items[index]);
    }
  }

  private toIterableArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    // The string iterator yields code points, not code units: `[...'😀']` is one element.
    if (typeof value === 'string') return [...value];
    if (value instanceof InterpArguments) {
      // `arguments[Symbol.iterator]` is `Array.prototype.values`: `length`, then each index.
      const length = Math.max(0, toInteger(getMember(this, value, 'length')));
      this.checkArrayLength(length);
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) items.push(getMember(this, value, i));
      return items;
    }
    return this.throwError('TypeError', `${toStringValue(value)} is not iterable`, false);
  }

  // -- Expressions --------------------------------------------------------

  private evalExpression(node: t.Expression | t.PrivateName | t.V8IntrinsicIdentifier, env: Environment): unknown {
    this.step();

    switch (node.type) {
      case 'NumericLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
        return node.value;

      case 'NullLiteral':
        return null;

      case 'Identifier': {
        const binding = env.lookup(node.name);
        if (binding === null) {
          return this.throwError('ReferenceError', `${node.name} is not defined`);
        }
        if (binding.value === TDZ) {
          return this.throwError('ReferenceError', `Cannot access '${node.name}' before initialization`);
        }
        return binding.value;
      }

      case 'ThisExpression': {
        for (let scope: Environment | null = env; scope !== null; scope = scope.parent) {
          if (!scope.hasThis) continue;
          const value = scope.thisValue;
          // The global object, at the top of a script or in a sloppy call
          // with no receiver, is the sandbox's: `(function () { return this;
          // })()` is the global-object idiom with its `Function` opened.
          if (value === GLOBAL_THIS) return this.globalObject();
          if (value instanceof UnmodelledThis) throw new InterpreterRefusal(value.reason);
          return value;
        }
        return undefined;
      }

      case 'RegExpLiteral':
        try {
          return new InterpRegExp(node.pattern, node.flags);
        } catch (error) {
          if (error instanceof InterpreterRefusal) throw error;
          return this.throwError('SyntaxError', error instanceof Error ? error.message : 'Invalid regular expression');
        }

      case 'TemplateLiteral': {
        let out = node.quasis[0]?.value.cooked ?? '';
        for (let index = 0; index < node.expressions.length; index++) {
          out += toStringValue(this.evalExpression(node.expressions[index] as t.Expression, env));
          out += node.quasis[index + 1]?.value.cooked ?? '';
        }
        return this.trackString(out);
      }

      case 'ArrayExpression': {
        const items: unknown[] = [];
        for (const element of node.elements) {
          if (element === null) {
            items.length += 1;
            continue;
          }
          if (element.type === 'SpreadElement') {
            const spread = this.toIterableArray(this.evalExpression(element.argument, env));
            this.checkArrayLength(items.length + spread.length);
            for (const item of spread) items.push(item);
            continue;
          }
          items.push(this.evalExpression(element, env));
        }
        this.checkArrayLength(items.length);
        return items;
      }

      case 'ObjectExpression': {
        const object = new InterpObject(null);
        for (const property of node.properties) {
          this.step();
          if (property.type === 'SpreadElement') {
            const source = this.evalExpression(property.argument, env);
            if (source === null || source === undefined) continue;
            for (const key of ownEnumerableKeys(this, source)) {
              object.props.set(key, getMember(this, source, key));
            }
            continue;
          }
          if (property.type === 'ObjectMethod') {
            if (property.kind !== 'method') {
              throw new UnsupportedSyntaxError(`ObjectMethod:${property.kind}`, property.loc?.start.line);
            }
            const key = property.computed
              ? modelledKey(this.evalExpression(property.key as t.Expression, env))
              : modelledKey(propertyName(property.key));
            object.props.set(key, new InterpFunction(property, env, false, key, this.functionSource));
            continue;
          }
          // `__proto__: value` - spelled plainly, not computed, not shorthand -
          // sets the prototype rather than a property. A plain object or
          // `null` is modelled; a primitive is ignored, as it is in V8; a
          // function or array as the prototype has no place in a chain of
          // plain objects here.
          if (!property.computed && !property.shorthand && propertyName(property.key) === '__proto__') {
            const proto = this.evalExpression(property.value as t.Expression, env);
            if (proto === null) {
              object.proto = null;
              object.bare = true;
            } else if (proto instanceof InterpObject) {
              if (proto.builtin !== null) {
                throw new InterpreterRefusal(`an object literal whose __proto__ is ${proto.builtin} is not modelled`);
              }
              object.proto = proto;
              object.bare = false;
            } else if (typeof proto === 'object' || proto instanceof Callable) {
              throw new InterpreterRefusal(
                'an object literal whose __proto__ is a function, array or other non-plain value is not modelled',
              );
            }
            continue;
          }
          const key = property.computed
            ? modelledKey(this.evalExpression(property.key as t.Expression, env))
            : modelledKey(propertyName(property.key));
          object.props.set(key, this.evalNamed(property.value as t.Expression, env, key));
        }
        return object;
      }

      case 'FunctionExpression': {
        const name = node.id?.name ?? '';
        if (node.id) {
          // A named function expression can call itself; the binding lives in a
          // scope of its own so the outer scope never sees it.
          const scope = new Environment(env);
          const fn = new InterpFunction(node, scope, false, name, this.functionSource);
          scope.declare(name, fn, false).silent = true;
          return fn;
        }
        return new InterpFunction(node, env, false, name, this.functionSource);
      }

      case 'ArrowFunctionExpression':
        return new InterpFunction(node, env, true, '', this.functionSource);

      case 'UnaryExpression':
        return this.evalUnary(node, env);

      case 'UpdateExpression':
        return this.evalUpdate(node, env);

      case 'BinaryExpression': {
        if (node.operator === 'in') {
          const left = this.evalExpression(node.left as t.Expression, env);
          return hasProperty(this, this.evalExpression(node.right, env), left);
        }
        if (node.operator === 'instanceof') {
          return instanceOf(
            this,
            this.evalExpression(node.left as t.Expression, env),
            this.evalExpression(node.right, env),
          );
        }
        return this.binary(
          node.operator,
          this.evalExpression(node.left as t.Expression, env),
          this.evalExpression(node.right, env),
        );
      }

      case 'LogicalExpression': {
        const left = this.evalExpression(node.left, env);
        switch (node.operator) {
          case '&&':
            return toBoolean(left) ? this.evalExpression(node.right, env) : left;
          case '||':
            return toBoolean(left) ? left : this.evalExpression(node.right, env);
          default:
            return left === null || left === undefined ? this.evalExpression(node.right, env) : left;
        }
      }

      case 'ConditionalExpression':
        return toBoolean(this.evalExpression(node.test, env))
          ? this.evalExpression(node.consequent, env)
          : this.evalExpression(node.alternate, env);

      case 'SequenceExpression': {
        let last: unknown;
        for (const expression of node.expressions) last = this.evalExpression(expression, env);
        return last;
      }

      case 'AssignmentExpression':
        return this.evalAssignment(node, env);

      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const value = this.evalMember(node, env);
        return value === CHAIN_SHORT ? undefined : value;
      }

      case 'CallExpression':
      case 'OptionalCallExpression': {
        const value = this.evalCall(node, env);
        return value === CHAIN_SHORT ? undefined : value;
      }

      case 'NewExpression':
        return this.evalNew(node, env);

      case 'ParenthesizedExpression':
        return this.evalExpression(node.expression, env);

      // Type-level wrappers: `x as T`, `x!`, `<T>x`, `x satisfies T`, `f<T>`
      // and Flow's `(x: T)`. All erase to their operand at run time, and a
      // decoder written in TypeScript carries them on exactly the calls the
      // recognisers key on - `a.push(a.shift() as string)`.
      case 'TypeCastExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TSSatisfiesExpression':
      case 'TSInstantiationExpression':
        return this.evalExpression(node.expression, env);

      default:
        throw new UnsupportedSyntaxError(node.type, node.loc?.start.line);
    }
  }

  private memberKey(node: t.MemberExpression | t.OptionalMemberExpression, env: Environment): unknown {
    if (node.computed) return this.evalExpression(node.property as t.Expression, env);
    return propertyName(node.property);
  }

  /**
   * A member read, or one link of an optional chain.
   *
   * An optional chain is one expression: the first `?.` link to find a nullish
   * base ends the whole of it with `undefined`, and the links after it are
   * not evaluated at all - `o?.[k()].x` on a null `o` never calls `k`. Babel
   * marks every link after the first `?.` as an Optional* node, but only the
   * `?.` links themselves carry `optional: true`; the others are plain reads
   * that happen to sit in a chain, and a plain read on an undefined base is a
   * TypeError there as anywhere. So `o?.f.x` on `o = {}` throws at `.x`, and
   * only the `optional` flag, never the node type, decides a short-circuit.
   *
   * The short-circuit travels outward as `CHAIN_SHORT`: each link passes it
   * on untouched, and the outermost expression turns it into `undefined`, or
   * into `true` under `delete`. It never escapes: only this method and
   * `evalCall` produce it, only `evalChainLink` relays it, and every caller
   * of the three checks for it before using the value.
   */
  private evalMember(node: t.MemberExpression | t.OptionalMemberExpression, env: Environment): unknown {
    const object = this.evalChainBase(node, env);
    if (object === CHAIN_SHORT) return CHAIN_SHORT;
    if (node.type === 'OptionalMemberExpression' && node.optional && (object === null || object === undefined)) {
      return CHAIN_SHORT;
    }
    return getMember(this, object, this.memberKey(node, env));
  }

  /**
   * The object a member or call link reads from. Inside a chain the base is
   * the previous link and the short-circuit passes through it; a plain member
   * expression starts no chain, so its object is an ordinary expression - the
   * parser already ends a chain at a parenthesis by making the link outside
   * it a plain one, which is why `(o?.f).x` throws on a null `o`.
   */
  private evalChainBase(link: t.MemberExpression | t.OptionalMemberExpression, env: Environment): unknown {
    return link.type === 'OptionalMemberExpression'
      ? this.evalChainLink(link.object, env)
      : this.evalExpression(link.object as t.Expression, env);
  }

  /**
   * An inner link of an optional chain, or the chain's base. A `!` sits
   * inside the chain (`o?.a!.b` is one chain) and erases; anything that is
   * not a link is the base, evaluated as it stands. The links skip
   * `evalExpression` so the sentinel can come back through them, and pay
   * their step here instead.
   */
  private evalChainLink(node: t.Expression, env: Environment): unknown {
    switch (node.type) {
      case 'OptionalMemberExpression':
        this.step();
        return this.evalMember(node, env);
      case 'OptionalCallExpression':
        this.step();
        return this.evalCall(node, env);
      case 'TSNonNullExpression':
        this.step();
        return this.evalChainLink(node.expression, env);
      default:
        return this.evalExpression(node, env);
    }
  }

  /**
   * NamedEvaluation: an anonymous function or arrow in a position that names it
   * - `var f = function () {}`, `f = () => {}`, `{ f: function () {} }`, a
   * default `(f = function () {})` - gets that name, through parentheses and
   * type-level wrappers. Anything else is evaluated as it stands: `var f = (0,
   * function () {})` and `var f = g || function () {}` stay nameless.
   */
  private evalNamed(node: t.Expression, env: Environment, name: string): unknown {
    let inner: t.Expression = node;
    while (
      inner.type === 'ParenthesizedExpression' ||
      inner.type === 'TSAsExpression' ||
      inner.type === 'TSNonNullExpression' ||
      inner.type === 'TSTypeAssertion' ||
      inner.type === 'TSSatisfiesExpression' ||
      inner.type === 'TSInstantiationExpression' ||
      inner.type === 'TypeCastExpression'
    ) {
      inner = inner.expression;
    }
    if (inner.type === 'FunctionExpression' && !inner.id) {
      this.step();
      return new InterpFunction(inner, env, false, name, this.functionSource);
    }
    if (inner.type === 'ArrowFunctionExpression') {
      this.step();
      return new InterpFunction(inner, env, true, name, this.functionSource);
    }
    return this.evalExpression(node, env);
  }

  private evalUnary(node: t.UnaryExpression, env: Environment): unknown {
    if (node.operator === 'typeof' && node.argument.type === 'Identifier') {
      // `typeof undeclared` is the one read that must not throw. A `let` in
      // its temporal dead zone is declared, and `typeof` reads it like any
      // other reference: the ReferenceError stands.
      const binding = env.lookup(node.argument.name);
      if (binding === null) return 'undefined';
      if (binding.value === TDZ) {
        return this.throwError('ReferenceError', `Cannot access '${node.argument.name}' before initialization`);
      }
      return typeOf(binding.value);
    }
    if (node.operator === 'delete') {
      const target = node.argument;
      if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
        // A chain cut short is not a reference, and `delete` of a non-reference
        // is `true`; a plain link on an undefined base is the usual TypeError.
        const object = this.evalChainBase(target, env);
        if (object === CHAIN_SHORT) return true;
        if (target.type === 'OptionalMemberExpression' && target.optional && (object === null || object === undefined)) {
          return true;
        }
        return deleteMember(this, object, this.memberKey(target, env), env.strict);
      }
      if (target.type === 'Identifier') {
        // A declared binding is not configurable and `delete` says `false`;
        // a global the program made by assigning to an undeclared name is,
        // and goes. An unbound name is `true` - there was nothing to remove.
        // (Strict code cannot spell this: it is an early SyntaxError.)
        const binding = env.lookup(target.name);
        if (binding === null) return true;
        if (!binding.implicit) return false;
        this.global.bindings?.delete(target.name);
        return true;
      }
      // `delete f()`, `delete 1`: the operand is evaluated and the answer is true.
      this.evalExpression(target, env);
      return true;
    }

    const value = this.evalExpression(node.argument, env);
    switch (node.operator) {
      case '-':
        return -toNumber(value);
      case '+':
        return toNumber(value);
      case '!':
        return !toBoolean(value);
      case '~':
        return ~toNumber(value);
      case 'typeof':
        return typeOf(value);
      case 'void':
        return undefined;
      default:
        throw new UnsupportedSyntaxError(`UnaryExpression:${node.operator}`, node.loc?.start.line);
    }
  }

  private evalUpdate(node: t.UpdateExpression, env: Environment): unknown {
    const delta = node.operator === '++' ? 1 : -1;
    const target = node.argument;

    if (target.type === 'Identifier') {
      const binding = this.readBinding(target.name, env);
      const before = toNumber(binding.value);
      const after = before + delta;
      this.writeBinding(binding, target.name, after, env);
      return node.prefix ? after : before;
    }

    if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
      const object = this.evalExpression(target.object as t.Expression, env);
      const key = this.memberKey(target, env);
      const before = toNumber(getMember(this, object, key));
      const after = before + delta;
      setMember(this, object, key, after, env.strict);
      return node.prefix ? after : before;
    }

    throw new UnsupportedSyntaxError(`UpdateExpression:${target.type}`, node.loc?.start.line);
  }

  /**
   * A binding read for a write that goes back to it: an unbound name is a
   * ReferenceError, and so is a `let` whose declaration has not run - the
   * temporal dead zone throws on the read half of `x += 1` and `x++` as it
   * does on a plain `x`.
   */
  private readBinding(name: string, env: Environment): Binding {
    const binding = env.lookup(name);
    if (binding === null) return this.throwError('ReferenceError', `${name} is not defined`);
    if (binding.value === TDZ) {
      return this.throwError('ReferenceError', `Cannot access '${name}' before initialization`);
    }
    return binding;
  }

  /**
   * SetMutableBinding on a binding that exists. A `const` throws on any write;
   * the name of a named function expression throws only from strict code and
   * is silently left alone by sloppy code - the two kinds of immutable binding
   * the spec distinguishes by the strictness of the binding itself. The
   * global's read-only properties behave as the second kind, with the
   * property's TypeError, whose wording names the host's global object.
   */
  private writeBinding(binding: Binding, name: string, value: unknown, env: Environment): void {
    if (binding.value === TDZ) {
      // Reached by a plain `x = ...` in the dead zone: there was no read half.
      this.throwError('ReferenceError', `Cannot access '${name}' before initialization`);
    }
    if (!binding.mutable) {
      if (binding.silent && !env.strict) return;
      if (binding.fixed) this.throwError('TypeError', `Cannot assign to read only property '${name}' of object`, false);
      this.throwError('TypeError', 'Assignment to constant variable.');
    }
    binding.value = value;
  }

  private evalAssignment(node: t.AssignmentExpression, env: Environment): unknown {
    const operator = node.operator;

    if (operator === '=') {
      // The target reference is evaluated before the value (ES2023 §13.15.2):
      // `a[i++] = i` stores the incremented `i`, `o[k] = (k = 'b', 1)` writes
      // under the original `k`, and `a[f()] = g()` runs `f` first. The RC4
      // swap `s[i] = s[j]; s[j] = t` depends on this order being exact.
      if (node.left.type === 'MemberExpression') {
        const object = this.evalExpression(node.left.object as t.Expression, env);
        const key = this.memberKey(node.left, env);
        const value = this.evalExpression(node.right, env);
        setMember(this, object, key, value, env.strict);
        return value;
      }
      const value =
        node.left.type === 'Identifier'
          ? this.evalNamed(node.right, env, node.left.name)
          : this.evalExpression(node.right, env);
      this.assignPattern(node.left, value, env);
      return value;
    }

    // Logical assignment short-circuits: the right side is not evaluated, and
    // the target is not written, when the test already decides the result.
    const logical = operator === '&&=' || operator === '||=' || operator === '??=';
    const binaryOperator = operator.slice(0, -1);

    if (node.left.type === 'Identifier') {
      const name = node.left.name;
      const binding = this.readBinding(name, env);
      const current = binding.value;
      if (logical && !shouldApplyLogical(operator, current)) return current;
      const value = logical
        ? this.evalNamed(node.right, env, name)
        : this.binary(binaryOperator, current, this.evalExpression(node.right, env));
      this.writeBinding(binding, name, value, env);
      return value;
    }

    if (node.left.type === 'MemberExpression') {
      const object = this.evalExpression(node.left.object as t.Expression, env);
      const key = this.memberKey(node.left, env);
      const current = getMember(this, object, key);
      if (logical && !shouldApplyLogical(operator, current)) return current;
      const value = logical
        ? this.evalExpression(node.right, env)
        : this.binary(binaryOperator, current, this.evalExpression(node.right, env));
      setMember(this, object, key, value, env.strict);
      return value;
    }

    throw new UnsupportedSyntaxError(`AssignmentExpression:${node.left.type}`, node.loc?.start.line);
  }

  private evalArguments(
    nodes: readonly (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
    env: Environment,
  ): unknown[] {
    const args: unknown[] = [];
    for (const argument of nodes) {
      if (argument.type === 'SpreadElement') {
        for (const item of this.toIterableArray(this.evalExpression(argument.argument, env))) {
          args.push(item);
        }
        continue;
      }
      if (argument.type === 'ArgumentPlaceholder') {
        throw new UnsupportedSyntaxError('ArgumentPlaceholder', argument.loc?.start.line);
      }
      args.push(this.evalExpression(argument, env));
    }
    return args;
  }

  /** A call, or one link of an optional chain; `CHAIN_SHORT` is explained on `evalMember`. */
  private evalCall(node: t.CallExpression | t.OptionalCallExpression, env: Environment): unknown {
    const callee = node.callee;

    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
      const object = this.evalChainBase(callee, env);
      if (object === CHAIN_SHORT) return CHAIN_SHORT;
      if (callee.type === 'OptionalMemberExpression' && callee.optional && (object === null || object === undefined)) {
        return CHAIN_SHORT;
      }
      const key = this.memberKey(callee, env);
      const fn = getMember(this, object, key);
      if (node.optional && (fn === null || fn === undefined)) return CHAIN_SHORT;
      const args = this.evalArguments(node.arguments, env);
      if (!(fn instanceof Callable)) {
        const exact = callee.object.type === 'Identifier' && !callee.computed && callee.property.type === 'Identifier';
        return this.throwError('TypeError', `${describeCallee(callee, key)} is not a function`, exact);
      }
      return this.invoke(fn, object, args);
    }

    if (callee.type === 'Super' || callee.type === 'V8IntrinsicIdentifier') {
      throw new UnsupportedSyntaxError(callee.type, node.loc?.start.line);
    }

    // `o?.f()()`: the callee of a chain's call is the link before it.
    const fn = node.type === 'OptionalCallExpression' ? this.evalChainLink(callee, env) : this.evalExpression(callee, env);
    if (fn === CHAIN_SHORT) return CHAIN_SHORT;
    if (node.optional && (fn === null || fn === undefined)) return CHAIN_SHORT;
    // A direct eval sees the caller's scope and `this`; the builtin models
    // the indirect one, whose `this` is the global object, and nothing else.
    if (fn === evalFunction && callee.type === 'Identifier') {
      throw new InterpreterRefusal('a direct eval compiles source in the scope of its caller, which the interpreter does not model');
    }
    const args = this.evalArguments(node.arguments, env);
    if (!(fn instanceof Callable)) {
      // V8 prints a name or a number literal as written; a string literal it
      // quotes (`"abc" is not a function`), and the rest it renders from
      // source, so only the first two are copied.
      const named = callee.type === 'Identifier' || callee.type === 'NumericLiteral';
      const name = callee.type === 'Identifier' ? callee.name : toStringValue(fn);
      return this.throwError('TypeError', `${name} is not a function`, named);
    }
    return this.invoke(fn, undefined, args);
  }

  /** `X is not a constructor`, worded as V8 words it, or inexact where V8 prints source the model does not keep. */
  private notAConstructor(callee: t.Expression, fallback: string): never {
    const written = describeWritten(callee);
    return this.throwError('TypeError', `${written ?? fallback} is not a constructor`, written !== null);
  }

  private evalNew(node: t.NewExpression, env: Environment): unknown {
    const callee = node.callee;
    if (callee.type === 'Super') {
      throw new UnsupportedSyntaxError(callee.type, node.loc?.start.line);
    }
    const target = this.evalExpression(callee, env);
    const args = this.evalArguments(node.arguments, env);

    if (target instanceof NativeFunction) {
      if (!target.construct) return this.notAConstructor(callee, target.name);
      return target.construct(this, undefined, args);
    }
    if (target instanceof BoundFunction) {
      throw new InterpreterRefusal('constructing through a bound function is not modelled');
    }
    if (target instanceof InterpFunction) {
      // An arrow and a concise method have no [[Construct]].
      if (target.isArrow || target.isMethod) return this.notAConstructor(callee, '(intermediate value)');
      const prototype = getMember(this, target, 'prototype');
      // OrdinaryCreateFromConstructor: a non-object `prototype` means
      // `Object.prototype`; an array or function there is a chain of plain
      // objects cannot carry.
      if (prototype instanceof InterpObject && prototype.builtin !== null) {
        throw new InterpreterRefusal(`constructing an instance whose prototype is ${prototype.builtin} is not modelled`);
      }
      if (prototype !== null && typeof prototype === 'object' && !(prototype instanceof InterpObject)) {
        throw new InterpreterRefusal('constructing an instance whose prototype is an array, regexp, error, date or arguments object is not modelled');
      }
      if (prototype instanceof Callable) {
        throw new InterpreterRefusal('constructing an instance whose prototype is a function is not modelled');
      }
      const instance = new InterpObject(prototype instanceof InterpObject ? prototype : null);
      const result = this.invoke(target, instance, args);
      // [[Construct]] keeps any object the body returns - an arguments
      // object, a regexp, a date, an error, the global - and the instance
      // only for a primitive.
      return isReference(result) || result instanceof Callable ? result : instance;
    }
    return this.throwError('TypeError', `${toStringValue(target)} is not a constructor`, false);
  }

  // -- Operators ----------------------------------------------------------

  private binary(operator: string, left: unknown, right: unknown): unknown {
    switch (operator) {
      case '+': {
        const l = toPrimitive(left, 'default');
        const r = toPrimitive(right, 'default');
        if (typeof l === 'string' || typeof r === 'string') {
          return this.trackString(toStringValue(l) + toStringValue(r));
        }
        return toNumber(l) + toNumber(r);
      }
      case '-':
        return toNumber(left) - toNumber(right);
      case '*':
        return toNumber(left) * toNumber(right);
      case '/':
        return toNumber(left) / toNumber(right);
      case '%':
        return toNumber(left) % toNumber(right);
      case '**':
        return toNumber(left) ** toNumber(right);
      case '==':
        return looseEquals(left, right);
      case '!=':
        return !looseEquals(left, right);
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const l = toPrimitive(left, 'number');
        const r = toPrimitive(right, 'number');
        if (typeof l === 'string' && typeof r === 'string') {
          switch (operator) {
            case '<':
              return l < r;
            case '>':
              return l > r;
            case '<=':
              return l <= r;
            default:
              return l >= r;
          }
        }
        const ln = toNumber(l);
        const rn = toNumber(r);
        switch (operator) {
          case '<':
            return ln < rn;
          case '>':
            return ln > rn;
          case '<=':
            return ln <= rn;
          default:
            return ln >= rn;
        }
      }
      case '&':
        return toNumber(left) & toNumber(right);
      case '|':
        return toNumber(left) | toNumber(right);
      case '^':
        return toNumber(left) ^ toNumber(right);
      case '<<':
        return toNumber(left) << toNumber(right);
      case '>>':
        return toNumber(left) >> toNumber(right);
      case '>>>':
        return toNumber(left) >>> toNumber(right);
      default:
        throw new UnsupportedSyntaxError(`BinaryExpression:${operator}`);
    }
  }

  // -- Invocation ---------------------------------------------------------

  /** `fromHost` marks a call a builtin makes - a callback; see `ExhaustionSite`. */
  private invoke(fn: unknown, thisArg: unknown, args: readonly unknown[], fromHost = false): unknown {
    if (fn instanceof InterpFunction) return this.callInterpreted(fn, thisArg, args, fromHost);
    if (fn instanceof NativeFunction) return fn.impl(this, thisArg, args);
    if (fn instanceof BoundFunction) {
      return this.invoke(fn.target, fn.boundThis, [...fn.boundArgs, ...args], fromHost);
    }
    return this.throwError('TypeError', `${toStringValue(fn)} is not a function`, false);
  }

  private callInterpreted(fn: InterpFunction, thisArg: unknown, args: readonly unknown[], fromHost: boolean): unknown {
    if (++this.depth > this.options.maxCallDepth) {
      this.depth--;
      throw new CallDepthExceeded(this.options.maxCallDepth);
    }
    // The frame is counted by its node, not its closure: two closures of one
    // function expression re-entering each other are the recursion a budget
    // is asked about as much as one function calling itself.
    const node = fn.node;
    const frames = this.running.get(node) ?? 0;
    this.running.set(node, frames + 1);
    if (this.loops.length > 0) {
      this.entered.add(node);
      if (frames > 0) this.recursed ??= node;
      if (fromHost) this.callback ??= node;
    }
    try {
      const env = new Environment(fn.env);
      env.strict = fn.strict;
      if (!fn.isArrow) {
        env.hasThis = true;
        env.thisValue = fn.strict ? thisArg : sloppyThis(thisArg);
      }
      this.bindParameters(fn, args, env);
      // Declared after the parameters and before the body's `var`s, so a
      // parameter named `arguments` wins, a bare `var arguments;` does not
      // clear it, and a function declaration of that name (hoisted below)
      // replaces it - the order FunctionDeclarationInstantiation fixes.
      if (!fn.isArrow && usesArguments(fn.node) && env.own('arguments') === undefined) {
        env.declare('arguments', this.makeArguments(fn, args, env), true);
      }

      const body = fn.node.body;
      if (body.type !== 'BlockStatement') return this.evalExpression(body, env);

      this.hoist(body.body, env, true);
      const completion = this.execStatements(body.body, env);
      return completion !== null && completion.type === RETURN ? completion.value : undefined;
    } finally {
      this.depth--;
      if (frames === 0) this.running.delete(node);
      else this.running.set(node, frames);
    }
  }

  private bindParameters(fn: InterpFunction, args: readonly unknown[], env: Environment): void {
    const params = fn.node.params;
    for (let index = 0; index < params.length; index++) {
      const param = params[index]!;
      if (param.type === 'RestElement') {
        this.initializePattern(param.argument, args.slice(index), env, false);
        return;
      }
      this.initializePattern(param, args[index], env, false);
    }
  }

  /**
   * The `arguments` object for a call. Mapped - each index slot *is* the
   * parameter's binding - for a sloppy function with a simple parameter list,
   * so writes through either name show through the other. The mapping is
   * built the way CreateMappedArgumentsObject builds it: from the last
   * parameter back, a name mapped once is not mapped again, so with
   * `function (a, a)` only index 1 aliases `a`.
   */
  private makeArguments(fn: InterpFunction, args: readonly unknown[], env: Environment): InterpArguments {
    const params = fn.node.params;
    const slots: (ValueSlot | undefined)[] = args.map((value) => ({ value }));
    const simple = params.every((param) => param.type === 'Identifier');
    if (!fn.strict && simple) {
      const mapped = new Set<string>();
      for (let index = params.length - 1; index >= 0; index--) {
        const name = (params[index] as t.Identifier).name;
        if (mapped.has(name)) continue;
        mapped.add(name);
        if (index < args.length) slots[index] = env.own(name)!;
      }
    }
    return new InterpArguments(slots, fn, fn.strict);
  }

  private makeFunction(node: t.FunctionDeclaration, env: Environment): InterpFunction {
    return new InterpFunction(node, env, false, node.id?.name ?? '', this.functionSource);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOTHING = Symbol('nothing');
const BREAK_SENTINEL = Symbol('break');
/** An optional chain cut short at a nullish base; see `Machine.evalMember`. */
const CHAIN_SHORT = Symbol('chain-short');
const switchBodies = new WeakMap<t.SwitchStatement, t.Statement[]>();

function describeCompletion(completion: Completion): string {
  const keyword = completion.type === RETURN ? 'return' : completion.type === BREAK ? 'break' : 'continue';
  return completion.label === null ? keyword : `${keyword} ${completion.label}`;
}

/**
 * The keys `for...in` visits: own enumerable keys, then each prototype's, a
 * name only once. Arrays, functions, strings and `arguments` objects inherit
 * nothing enumerable, so their own keys are the whole list.
 */
function forInKeys(host: Host, target: unknown): string[] {
  if (!(target instanceof InterpObject)) return ownEnumerableKeys(host, target);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let object: InterpObject | null = target; object !== null; object = object.proto) {
    for (const key of ownEnumerableKeys(host, object)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function classifyLoopCompletion(completion: Result, label: string | null): 0 | 1 | 2 {
  if (completion === null) return LOOP_CONTINUE;
  if (completion.type === CONTINUE && (completion.label === null || completion.label === label)) {
    return LOOP_CONTINUE;
  }
  if (completion.type === BREAK && (completion.label === null || completion.label === label)) {
    return LOOP_BREAK;
  }
  return LOOP_PROPAGATE;
}

/** Fresh bindings for the next iteration of a `for (let ...)` loop. */
function copyLoopEnv(parent: Environment, source: Environment, names: readonly string[]): Environment {
  const next = new Environment(parent);
  for (const name of names) {
    const binding = source.own(name);
    next.declare(name, binding ? binding.value : undefined, true);
  }
  return next;
}

function propertyName(node: t.Node): string {
  switch (node.type) {
    case 'Identifier':
      return node.name;
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      return String(node.value);
    default:
      throw new UnsupportedSyntaxError(`PropertyKey:${node.type}`, node.loc?.start.line);
  }
}

function describeCallee(
  callee: t.MemberExpression | t.OptionalMemberExpression,
  key: unknown,
): string {
  const object = callee.object.type === 'Identifier' ? callee.object.name : '(intermediate value)';
  // V8 prints the link as written: `o?.b is not a function`.
  const link = callee.type === 'OptionalMemberExpression' && callee.optional ? '?.' : '.';
  return `${object}${link}${toPropertyKey(key)}`;
}

/**
 * A callee as V8 prints it in `... is not a constructor`: a name, or `o.m` for
 * a plain member of a name. Anything else V8 renders from the source text
 * (`a.b.c`, `(intermediate value).prototype.x`, `o[k]`), which is `null` here
 * so the message is marked inexact.
 */
function describeWritten(callee: t.Expression): string | null {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'ArrowFunctionExpression' || callee.type === 'FunctionExpression') return '(intermediate value)';
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier'
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

function shouldApplyLogical(operator: string, current: unknown): boolean {
  if (operator === '&&=') return toBoolean(current);
  if (operator === '||=') return !toBoolean(current);
  return current === null || current === undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute a slice once to build its top-level environment, then hand back a
 * handle for reading bindings and calling functions.
 *
 * Running the slice at construction time is what makes a string-array decoder
 * work at all: the array literal is built *and* the rotation IIFE has run by the
 * time the caller asks for anything, so `call('_0x1a2b', [0x1f4])` sees the array
 * in its final order. Each subsequent entry gets a fresh step and time budget, so
 * one pathological decode call cannot starve the next.
 */
export function createInterpreter(
  statements: readonly t.Statement[],
  options: InterpreterOptions = {},
): Interpreter {
  const machine = new Machine(statements, options);
  return {
    read: (name) => machine.read(name),
    call: (name, args) => machine.callExported(name, args),
    has: (name) => machine.has(name),
    isCallable: (name) => machine.isCallableBinding(name),
    steps: () => machine.steps(),
    diagnostics: () => machine.diagnostics(),
  };
}

export { InterpArguments, InterpDate, InterpError, InterpObject, InterpRegExp, InterpreterRefusal };
