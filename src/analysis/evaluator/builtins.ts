/**
 * The value model and the entire library surface an interpreted program can reach.
 *
 * Two invariants define this file, and the interpreter's security rests on them:
 *
 * 1. Every value an interpreted program can hold is a JS primitive, a plain array
 *    the interpreter allocated, or an instance of one of the classes declared
 *    here. None of them exposes a host object, so there is nothing to escape *to*.
 *
 * 2. Property access is a function (`getMember`), never a real `obj[key]` against
 *    a host object. A key that is not in a table is refused, and the handful
 *    that lead out of the model - `constructor` above all - are refused on
 *    any touch. That is what turns `({}).constructor.constructor('return
 *    this')()` into a refusal instead of a full realm escape - the classic
 *    break of every "shadow the globals" sandbox, including the one in
 *    `sandbox.ts`.
 *
 * Every builtin is written as a pure function of an explicit `Host`, so the whole
 * table is built once at module load and shared by every interpreter instance;
 * per-instance state (the step and allocation budgets) arrives through `host`.
 * Builtins are frozen so one evaluation cannot poison the next.
 *
 * What the table does *not* contain is a stand-in for anything the program's
 * real run decides: the clock, the time zone, `Math.random`, the locale's
 * collation. Those raise `InterpreterRefusal` instead, because a value the
 * build machine invents for them is a value the running program never sees.
 *
 * ## The whitelist
 *
 * The interpreter exists to check the native tier on string-array decoders,
 * and their vocabulary is small: the table index, the string and array
 * library below, `parseInt`, `Number`, `Math`, bit arithmetic, loops,
 * closures, base64 and RC4 loops, the occasional `arguments`. Everything it
 * computes is either V8-exact or refused, and the way that stays true as V8
 * grows is that the list is CLOSED: the tables in this file are the whole of
 * what the model knows, and a read, write, `in`, `delete`, enumeration or
 * conversion that reaches past them is refused rather than answered
 * `undefined` - because `undefined` is a claim that V8 has nothing there, and
 * for `Array.prototype.flat` or `Math.f16round` it is false. Only
 * `Object.prototype`'s key set is treated as known in full (see
 * `OBJECT_PROTO_UNMODELLED`), so that a plain object's missing key is the
 * exact `undefined` a decoder's cache lookup needs.
 *
 * What is in the list, by table, is what `whitelist()` at the end of this
 * file returns; `test/evaluator-whitelist.test.ts` walks every entry and
 * proves it against the V8 it runs on, or proves it refuses. The language
 * side of the same list - the node types and operators the interpreter
 * walks - is `checkVocabulary` in `interpreter.ts`, whose `default` is the
 * refusal, checked over the whole slice before any of it runs;
 * `test/evaluator-vocabulary.test.ts` walks that. The rules the tables
 * follow:
 *
 *  - a builtin object (`Math`, `JSON`, every `X.prototype`) answers its table
 *    and `Object.prototype`'s four modelled methods; any other key is refused;
 *    nothing writes, deletes, enumerates or converts one (`Array.prototype`
 *    is an array, `String.prototype` a String wrapper - exotic objects the
 *    model does not have);
 *  - a builtin function (a constructor or method) answers its own table,
 *    `name`, `length`, `call`/`apply`/`bind`/`toString`; anything else is
 *    refused; nothing writes or deletes one;
 *  - a value with a builtin prototype - a string, number, boolean, array,
 *    regexp, error, date - answers its own properties, its prototype's table
 *    and `Object.prototype`'s modelled methods; anything else is refused;
 *  - a plain object, a user function or an `arguments` object answers its
 *    own properties, its chain, and `Object.prototype` in full: the modelled
 *    four, a refusal for `isPrototypeOf`/`toLocaleString`, the blocked six,
 *    and the exact `undefined` for everything else;
 *  - `Function.prototype`'s `arguments` and `caller` are refused on any touch;
 *  - no wrapper objects: `new String(x)`, `Object('x')` and
 *    `Object.prototype.valueOf.call(1)` are refused;
 *  - a conversion that would run user code - an own or inherited `toString`,
 *    `valueOf` or `toJSON` - is refused, as is a `JSON.stringify` replacer;
 *  - a value only the run supplies - the clock, `Math.random`, the locale,
 *    the time zone, an error's `stack` - is refused.
 */

import { isGlobalThisSource } from './global-object.js';
import { readRegexCost, regexWork, type RegexCost } from './regex-cost.js';

// ---------------------------------------------------------------------------
// Value model
// ---------------------------------------------------------------------------

/** A plain object. Keys live in a `Map`, so there is no host prototype at all. */
export class InterpObject {
  readonly props = new Map<string, unknown>();
  frozen = false;
  /**
   * The name of the builtin this object stands for - `'Math'`,
   * `'Array.prototype'` - or null for an object the program made. A builtin's
   * table is the whole of what the model knows about it: a key that is not in
   * it may well be on V8's object (`Array.prototype.flat`, `Math.f16round`,
   * whatever the next release adds), so a miss is refused rather than answered
   * `undefined`, and nothing enumerates, writes or converts it.
   */
  builtin: string | null = null;
  /**
   * True when the chain ends nowhere: `Object.create(null)`, `{ __proto__: null }`,
   * a match's `groups`. Every other chain ends at `Object.prototype`, which is
   * not a link in any object's `proto` - `objectProto` is consulted once the walk
   * is over - so this is what distinguishes an object that has no `toString`
   * from one that inherits it.
   */
  bare = false;

  constructor(public proto: InterpObject | null = null) {}
}

/**
 * The bindings of the interpreter's top level, as the sandbox global object
 * reads and writes them. `read` answers a builtin or a binding the slice
 * declares, and refuses a name the slice does not carry: the program may
 * bind it, and its value is not in the sandbox. A top-level `let` or `const`
 * is refused too - it is no property of the global object.
 */
export interface GlobalBindings {
  read(name: string): unknown;
  has(name: string): boolean;
  write(name: string, value: unknown): void;
}

/**
 * The sandbox's global object: what the global-object idiom evaluates to
 * (`Function('return this')()`, `(0, eval)('this')`; see `global-object.ts`).
 * Its properties are the top-level bindings - the allowlisted builtins and
 * whatever the slice declares - so a polyfill assigned onto it (`g.atob ||
 * (g.atob = ...)`) is what a later bare `atob(e)` resolves to, exactly as in a
 * script. It converts to nothing (`[object Window]` or `[object global]` is
 * the host's), enumerates nothing, and never crosses to the host.
 */
export class GlobalObject {
  constructor(readonly bindings: GlobalBindings) {}
}

/** The last object on a prototype chain: where `bare` is decided. */
function chainEnd(object: InterpObject): InterpObject {
  let end = object;
  while (end.proto !== null) end = end.proto;
  return end;
}

/** A box an `arguments` object reads an argument through. A parameter's binding is one. */
export interface ValueSlot {
  value: unknown;
}

/**
 * An `arguments` object. Not an array - `Array.isArray` says no, and none of
 * `Array.prototype` is on it - but array-like: the initial arguments are
 * indices, `length` and `callee` are own, and `Object.prototype` is the
 * prototype. In a sloppy function with a simple parameter list the index slots
 * *are* the parameter bindings, so `arguments[0] = 2` writes the parameter and
 * `a = 2` shows through `arguments[0]`, exactly as V8 maps them; a strict or
 * non-simple function gets copies.
 */
export class InterpArguments {
  /**
   * The initial arguments, by index. A slot deleted with `delete arguments[i]`
   * becomes `undefined`; a later write to that index is an ordinary property
   * in `own`, no longer mapped.
   */
  readonly slots: (ValueSlot | undefined)[];
  /** Every other own property in insertion order: `length`, `callee`, then whatever the program adds. */
  readonly own = new Map<string, unknown>();
  /** The own properties that do not enumerate. `delete` takes a key out; a re-add is enumerable. */
  readonly hidden = new Set<string>(['length', 'callee']);

  constructor(
    slots: (ValueSlot | undefined)[],
    readonly callee: Callable,
    /** A strict arguments object throws on `callee`, the way V8's poison-pill accessor does. */
    readonly strict: boolean,
  ) {
    this.slots = slots;
    this.own.set('length', slots.length);
    this.own.set('callee', callee);
  }
}

/** Internal carrier for an interpreted `throw`. Never escapes the evaluator. */
export class ThrowSignal extends Error {
  constructor(readonly value: unknown) {
    super('interpreted throw');
    this.name = 'ThrowSignal';
  }
}

/** Throw an interpreted error from a conversion that has no `Host` to hand it to. */
function throwInterpreted(name: string, message: string, exact = true): never {
  const error = new InterpError(name, name, message);
  error.exactMessage = exact;
  throw new ThrowSignal(error);
}

/** Base of everything `typeof` reports as `'function'`. */
export abstract class Callable {
  private ownProps: Map<string, unknown> | null = null;
  frozen = false;
  /**
   * `name` and `length` are own, non-writable, configurable: a `delete` takes
   * one off, after which `Function.prototype`'s `''` and `0` show through -
   * and, being non-writable there too, still block a write.
   */
  nameDeleted = false;
  lengthDeleted = false;

  abstract readonly name: string;
  abstract readonly arity: number;

  /** True when reading `.prototype` should lazily mint one (user functions). */
  get autoPrototype(): boolean {
    return false;
  }

  /**
   * The text `Function.prototype.toString` reports for this function, or `null`
   * when there is none to report and the `[native code]` form should be used.
   *
   * This is not cosmetic. `javascript-obfuscator`'s `selfDefending` option welds
   * a guard into the string decoder that matches a regular expression against
   * one of its own inner functions' source text; when the match fails the
   * decoder diverts into a loop that never terminates. A function that does not
   * stringify to its own source therefore does not merely print oddly - it
   * decodes to the wrong plaintext, or does not return at all. Interpreted
   * functions override this; builtins keep `null`, because `[native code]` *is*
   * the faithful answer for them.
   */
  get sourceText(): string | null {
    return null;
  }

  /**
   * Whether a call could observe its `index`-th argument. A builtin can (the
   * variadic ones use every argument they are given), so the base answer is
   * yes; an interpreted function answers from its parameter list.
   */
  canSeeArgument(_index: number): boolean {
    return true;
  }

  get props(): Map<string, unknown> {
    return (this.ownProps ??= new Map<string, unknown>());
  }

  get hasProps(): boolean {
    return this.ownProps !== null;
  }
}

export type NativeImpl = (host: Host, thisArg: unknown, args: readonly unknown[]) => unknown;

export class NativeFunction extends Callable {
  constructor(
    readonly name: string,
    readonly arity: number,
    readonly impl: NativeImpl,
    /** Present only for the handful of builtins reachable through `new`. */
    readonly construct?: NativeImpl,
  ) {
    super();
  }
}

export class BoundFunction extends Callable {
  constructor(
    readonly target: Callable,
    readonly boundThis: unknown,
    readonly boundArgs: readonly unknown[],
  ) {
    super();
  }

  get name(): string {
    return `bound ${this.target.name}`;
  }

  get arity(): number {
    return Math.max(0, this.target.arity - this.boundArgs.length);
  }

  override canSeeArgument(index: number): boolean {
    return this.target.canSeeArgument(index + this.boundArgs.length);
  }
}

/**
 * A regular expression. The host `RegExp` inside is only ever applied to strings
 * the interpreter owns, and is never handed out.
 */
export class InterpRegExp {
  readonly regex: RegExp;
  /**
   * Kept as written - `re.lastIndex = '3'` reads back `'3'` - and handed to
   * the host regex, which applies ToLength as V8 does, whenever a method
   * runs; see `withHostRegExp`.
   */
  lastIndex: unknown = 0;
  private costRead: RegexCost | string | undefined;

  constructor(source: string, flags: string) {
    this.regex = new RegExp(source, flags);
    // A match under `d` carries an `indices` array the model does not build.
    if (flags.includes('d')) refuse('a regular expression with the d (hasIndices) flag is not modelled');
  }

  /** The backtracking bound of the pattern, or why it has none; read once. */
  get cost(): RegexCost | string {
    return (this.costRead ??= readRegexCost(this.regex.source, this.regex.flags));
  }

  /**
   * `source` and `flags` are read back from the host object rather than kept as
   * given: V8 escapes an unescaped `/` and a line terminator in the source
   * (`new RegExp('/').source` is `\/`), spells the empty pattern `(?:)`, and
   * orders the flags canonically (`'ig'` reads back as `'gi'`). The host is V8,
   * so its answer is the answer.
   */
  get source(): string {
    return this.regex.source;
  }

  get flags(): string {
    return this.regex.flags;
  }
}

/**
 * An error. `name` and `message` hold whatever the program put there, not its
 * string form - `e.name = 5` reads back as the number 5 - and are converted
 * only when the error is; `protoName` is what `name` falls back to once its
 * own value is deleted.
 */
export class InterpError {
  /**
   * Whether `message` is the text V8 would have produced. An error the
   * program made, or one whose message this table copies from V8 exactly,
   * is; an error the model raises with words of its own - a rendering of a
   * callee it cannot reproduce, a host-specific `atob` message - is not,
   * and reading its `message` refuses rather than handing out prose V8 never
   * wrote. `name`, `instanceof` and `hasOwnProperty` stay exact either way.
   */
  exactMessage = true;
  /**
   * Own properties the program created by assignment - `name` when it was
   * inherited, `message` after a delete or on an error made without one.
   * The constructor's own `message` is non-enumerable and stays so when
   * reassigned; a property the program creates is enumerable, so `Object.keys`
   * and `JSON.stringify` would list it. Enumerating such an error is refused.
   */
  readonly enumerable = new Set<string>();

  constructor(
    /** The constructor's name: `Error.prototype.name` for the chain this error is on. */
    readonly protoName: string,
    public name: unknown,
    public message: unknown,
    /** `new Error()` inherits `message`; `new Error('')` owns it. Only `hasOwnProperty` can tell. */
    public ownMessage = true,
    /** `name` is inherited until the program assigns it. */
    public ownName = false,
  ) {}
}

/** A `Date`, as a time value. Only its UTC face is readable; see `dateProto`. */
export class InterpDate {
  constructor(readonly time: number) {}
}

/**
 * The interpreter has reached something it can only get wrong.
 *
 * Two shapes land here. A value that differs between the machine decoding the
 * file and the one that will run it - the clock, the time zone, entropy, the
 * host locale's collation - has no build-time answer at all; pinning one, as
 * an earlier version did with a frozen clock and a seeded PRNG, produced
 * strings a real run never computes. And a conversion that would have to run
 * user code (an object carrying its own `toString` or `valueOf`) is one the
 * host-free conversions below cannot perform, and substituting the default
 * `[object Object]` is a different program. In both cases the tier's contract
 * leaves one correct answer: none.
 *
 * Like the resource guards, this escapes interpreted `try`/`catch`. A decoder
 * that could swallow it would carry on computing with the value it never got.
 */
export class InterpreterRefusal extends Error {
  constructor(reason: string) {
    super(`Refusing to evaluate: ${reason}`);
    this.name = 'InterpreterRefusal';
  }
}

function refuse(reason: string): never {
  throw new InterpreterRefusal(reason);
}

/**
 * Services the interpreter provides to the library: dispatching a call back into
 * interpreted code, and the resource guards.
 */
export interface Host {
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  /** Longest subject a host regex may be applied to; see `applyRegex`. */
  readonly maxRegexInput: number;

  call(callee: unknown, thisArg: unknown, args: readonly unknown[]): unknown;
  isCallable(value: unknown): boolean;
  /** Charge a produced string against the allocation budget. */
  trackString(value: string): string;
  checkArrayLength(length: number): void;
  /** Charge work done inside a native loop against the step budget. */
  tick(cost: number): void;
  /** Throw an interpreted error; `exact` false marks a message V8 words differently. See `InterpError.exactMessage`. */
  throwError(name: string, message: string, exact?: boolean): never;
  /** The sandbox global object, one per interpreter; see `GlobalObject`. */
  globalObject(): GlobalObject;
}

// ---------------------------------------------------------------------------
// Property keys
// ---------------------------------------------------------------------------

/**
 * Keys outside the object model, on every value.
 *
 * `constructor` is the whole ballgame: it is the only route from a value the
 * program already holds back to a function factory, and `Function` is not in
 * the table. The rest are `Object.prototype`'s accessors onto the prototype
 * machinery, which the model does not have either. Any touch - read, write,
 * `in`, `delete`, a literal that defines one - is a refusal rather than an
 * answer: an earlier table resolved them to `undefined`, and `[].constructor
 * === Array` came out `false`, `({}).constructor.constructor(...)` came out a
 * *catchable* TypeError, and a `try { "".__proto__.constructor.name } catch {}`
 * probe recorded nothing where the real run records `'String'`. A refusal
 * closes the escape as tightly - no `Function` is reachable because none is
 * produced - and, unlike `undefined`, it is never the wrong value.
 */
const BLOCKED_KEYS = new Set([
  'constructor',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/** The key as a string, refusing the ones the model does not answer. */
export function modelledKey(key: unknown): string {
  const k = toPropertyKey(key);
  if (BLOCKED_KEYS.has(k)) {
    refuse(
      k === 'constructor'
        ? "the 'constructor' property leads from any value back to Function, which the interpreter's object model does not contain"
        : `the '${k}' accessor of Object.prototype is outside the interpreter's object model`,
    );
  }
  return k;
}

/**
 * `constructor` read on a function: `Function`, the one link of the chain
 * the model does answer, because what it leads to compiles nothing -
 * `functionConstructor` builds the global-object idiom and refuses every
 * other source. Read on anything else it stays blocked: `[].constructor`
 * and `''.constructor` are the same question as the blocked keys, an own
 * `constructor` of a plain object is a property the program wrote, and the
 * idiom is spelled on a function literal alone.
 */
function isConstructorOfFunction(object: unknown, key: unknown): boolean {
  return object instanceof Callable && toPropertyKey(key) === 'constructor';
}

export function toPropertyKey(key: unknown): string {
  return typeof key === 'string' ? key : toStringValue(key);
}

/** Largest array index: 2^32 - 2. V8 orders and stores keys above it as plain strings. */
const MAX_INDEX = 4294967294;

/** The array index a key denotes, or -1 when it is not a canonical index. */
function toIndex(key: unknown): number {
  if (typeof key === 'number') return Number.isInteger(key) && key >= 0 && key <= MAX_INDEX ? key : -1;
  if (typeof key !== 'string') return -1;
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n <= MAX_INDEX && String(n) === key ? n : -1;
}

/**
 * OrdinaryOwnPropertyKeys order: array indices ascending, then the rest in
 * insertion order. `Object.keys({ b: 1, 2: 1, a: 1, 1: 1 })` is `1, 2, b, a`,
 * and a decoder that joins the keys of its table object depends on it.
 */
function orderKeys(keys: readonly string[]): string[] {
  let indices: number[] | null = null;
  for (const key of keys) {
    if (toIndex(key) >= 0) (indices ??= []).push(Number(key));
  }
  if (indices === null) return keys.slice();
  indices.sort((a, b) => a - b);
  const ordered = indices.map(String);
  for (const key of keys) if (toIndex(key) < 0) ordered.push(key);
  return ordered;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export function typeOf(value: unknown): string {
  if (value === null) return 'object';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (value instanceof Callable) return 'function';
  return 'object';
}

export function toBoolean(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  return true;
}

export function toNumber(value: unknown): number {
  switch (typeof value) {
    case 'number':
      return value;
    case 'string':
      return value.trim() === '' ? 0 : Number(value);
    case 'boolean':
      return value ? 1 : 0;
  }
  if (value === null) return 0;
  if (value === undefined) return Number.NaN;
  if (value instanceof InterpDate) return value.time;
  // OrdinaryToPrimitive with hint number: `valueOf` first, which for everything
  // built here returns the object itself, then `toString`. So an array goes
  // through its join - `+[undefined]` is 0 and `+[true]` is NaN, exactly as
  // the string forms `''` and `'true'` say - and an object is NaN.
  if (hasUserConversion(value, 'valueOf')) refuse(userConversion(value, 'valueOf'));
  return Number(toStringValue(value));
}

/**
 * The string form of a plain object: `Object.prototype.toString`'s tag when
 * the chain reaches it. A chain that ends nowhere has no `toString`, so
 * OrdinaryToPrimitive goes on to `valueOf` - a user one is the program's to
 * run, not this table's - and with neither it is a TypeError.
 */
function plainObjectToString(value: InterpObject): string {
  if (value.builtin !== null) {
    if (!isOrdinaryBuiltin(value)) refuse(builtinConversion(value));
    return `[object ${classTag(value)}]`;
  }
  if (chainEnd(value).bare) {
    if (hasUserConversion(value, 'valueOf')) refuse(userConversion(value, 'valueOf'));
    throwInterpreted('TypeError', 'Cannot convert object to primitive value');
  }
  return '[object Object]';
}

/**
 * `Math` and `JSON` are ordinary objects and convert as any object does; the
 * builtin prototypes are not. `Array.prototype` is itself an array,
 * `String.prototype` a String wrapper of `''`, `Number.prototype` a
 * Number(0), `Error.prototype` stringifies to `'Error'` - none of which the
 * model keeps, so converting one is refused.
 */
function builtinConversion(value: InterpObject): string {
  return `converting ${value.builtin} to a primitive depends on the exotic object V8 makes it, which the model does not keep`;
}

/** `Math`, `JSON` and `Object.prototype` are ordinary objects; the other prototypes are not. */
function isOrdinaryBuiltin(value: InterpObject): boolean {
  return value === mathNamespace || value === jsonNamespace || value === objectProto;
}

/**
 * Whether a value carries its own `toString`/`valueOf`, on itself or on a
 * prototype it was created from. The frozen builtin prototypes are not in any
 * object's chain, so a hit is always something the program put there.
 */
function hasUserConversion(value: unknown, method: 'toString' | 'valueOf'): boolean {
  if (value instanceof InterpObject) {
    if (value.builtin !== null) return false;
    for (let o: InterpObject | null = value; o !== null; o = o.proto) if (o.props.has(method)) return true;
    return false;
  }
  if (Array.isArray(value)) return ownKey(value, method);
  if (value instanceof Callable) return value.hasProps && value.props.has(method);
  return false;
}

function userConversion(value: unknown, method: 'toString' | 'valueOf' | 'join'): string {
  const kind = Array.isArray(value) ? 'an array' : value instanceof Callable ? 'a function' : 'an object';
  return `converting ${kind} that defines its own ${method}() would run user code the conversion does not model`;
}

export function toInteger(value: unknown): number {
  const n = toNumber(value);
  if (Number.isNaN(n)) return 0;
  return Math.trunc(n);
}

/**
 * The arrays currently being joined. `Array.prototype.join` stringifies an
 * array that is already on this stack as `''` - V8 keeps the same stack to
 * end a cycle - and nothing else is cut short: a list nested a hundred deep
 * joins all the way down, as it does there.
 */
const joining = new Set<unknown[]>();

export function toStringValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  // With hint string, `toString` is consulted first and every builtin one
  // returns a primitive, so a user `valueOf` is never reached; a user
  // `toString` is, and is the program's, not this table's.
  if (hasUserConversion(value, 'toString')) refuse(userConversion(value, 'toString'));
  if (Array.isArray(value)) {
    // `Array.prototype.toString` calls the receiver's own `join` when it has
    // one - user code, or a non-callable that turns the result into
    // `[object Array]` - so an array carrying one is not joined here.
    if (ownKey(value, 'join')) refuse(userConversion(value, 'join'));
    if (joining.has(value)) return '';
    joining.add(value);
    try {
      let out = '';
      for (let i = 0; i < value.length; i++) {
        if (i > 0) out += ',';
        const item = value[i];
        if (item !== null && item !== undefined) out += toStringValue(item);
      }
      return out;
    } finally {
      joining.delete(value);
    }
  }
  if (value instanceof Callable) {
    // Every coercion of a function funnels through here - `'' + fn`, `String(fn)`,
    // `fn.toString()`, a template hole and `[fn].join('')` all land on this line -
    // so `sourceText` only has to be honoured once.
    if (value instanceof BoundFunction) return 'function () { [native code] }';
    return value.sourceText ?? `function ${value.name}() { [native code] }`;
  }
  if (value instanceof InterpRegExp) return value.regex.toString();
  if (value instanceof InterpError) return errorToString(value);
  if (value instanceof InterpDate) return refuse(LOCAL_TIME);
  if (value instanceof InterpObject) return plainObjectToString(value);
  return `[object ${classTag(value)}]`;
}

/** The message the program may read: V8's, or a refusal for one the model worded itself. */
function errorMessage(error: InterpError): unknown {
  if (!error.exactMessage) {
    refuse(`the message V8 gives this ${error.protoName} is not reproduced by the model, only its name`);
  }
  return error.message;
}

/** The error as a host-side diagnostic shows it: name and message as they are, exact or not. */
export function describeError(value: unknown): string {
  if (!(value instanceof InterpError)) return toStringValue(value);
  const name = value.ownName ? String(value.name) : value.protoName;
  const message = value.message === undefined ? '' : String(value.message);
  return message === '' ? name : name === '' ? message : `${name}: ${message}`;
}

/**
 * Error.prototype.toString (ES2023 §20.5.3.4): an absent `name` reads
 * `'Error'`, an absent `message` `''`, and the two are joined by `': '` only
 * when both are non-empty. Each is ToString'd as read, so `e.name = 5` prints
 * as `5: ...`.
 */
function errorToString(error: InterpError): string {
  const name = error.name === undefined ? 'Error' : toStringValue(error.name);
  const message = error.message === undefined ? '' : toStringValue(errorMessage(error));
  if (name === '') return message;
  if (message === '') return name;
  return `${name}: ${message}`;
}

/** The `Object.prototype.toString` tag of a value: what the run's `[object X]` says. */
function classTag(value: unknown): string {
  if (value === null) return 'Null';
  if (value === undefined) return 'Undefined';
  if (value instanceof GlobalObject) refuse(GLOBAL_CONVERSION);
  if (Array.isArray(value)) return 'Array';
  if (value instanceof Callable) return 'Function';
  if (value instanceof InterpRegExp) return 'RegExp';
  if (value instanceof InterpDate) return 'Date';
  if (value instanceof InterpError) return 'Error';
  if (value instanceof InterpArguments) return 'Arguments';
  if (value instanceof InterpObject && value.builtin !== null) {
    // `Array.prototype` tags as `Array`, `String.prototype` as `String`: the
    // exotic objects again, and the same refusal.
    if (!isOrdinaryBuiltin(value)) refuse(builtinConversion(value));
    return value === objectProto ? 'Object' : value.builtin;
  }
  switch (typeof value) {
    case 'string':
      return 'String';
    case 'number':
      return 'Number';
    case 'boolean':
      return 'Boolean';
    default:
      return 'Object';
  }
}

/**
 * ToPrimitive for `+`, `==` and the relational operators. Only a `Date` prefers
 * the string form under the default hint; everything else built here has a
 * `valueOf` that returns the object itself, so the string form is the answer -
 * unless the program supplied a `valueOf` of its own, which is not modelled.
 */
export function toPrimitive(value: unknown, hint: 'number' | 'string' | 'default'): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (value instanceof InterpDate) return hint === 'number' ? value.time : refuse(LOCAL_TIME);
  if (hint !== 'string' && hasUserConversion(value, 'valueOf')) {
    refuse(userConversion(value, 'valueOf'));
  }
  return toStringValue(value);
}

/**
 * The prototype chain of a plain object reaches `Object.prototype` unless it
 * was made not to. Arrays, functions, regexps, errors, dates and `arguments`
 * objects always do.
 */
function inheritsObjectProto(value: unknown): boolean {
  return !(value instanceof InterpObject) || !chainEnd(value).bare;
}

/**
 * `Method X called on incompatible receiver Y`: V8 renders a primitive
 * receiver as its string and an object by kind (`#<Object>`, `[object
 * Array]`, a function's source) and, for `test`, names `exec` for an object.
 * Only the primitive case is copied.
 */
function incompatibleReceiver(host: Host, method: string, receiver: unknown): never {
  const primitive = !isReference(receiver) && !(receiver instanceof Callable);
  return host.throwError(
    'TypeError',
    `Method ${method} called on incompatible receiver ${primitive ? toStringValue(receiver) : '#<Object>'}`,
    primitive,
  );
}

/**
 * `Date`'s local-time face is the host's time zone, which the machine that runs
 * the program need not share; only the UTC face is a fact about the value.
 */
const LOCAL_TIME = 'the local-time form of a Date depends on the time zone the program runs in';
const GLOBAL_CONVERSION = "the global object's string form is the host's ('[object Window]', '[object global]'), which the sandbox does not have";

export function strictEquals(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * IsLooselyEqual (ES2023 §7.2.14). Two objects are equal only when they are
 * the same object - `[] == []` is false without either side converting - and
 * an object meets a primitive through ToPrimitive with no hint. Among
 * primitives, a boolean becomes a number first, and a string meets a number
 * as a number.
 */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const aObject = isReference(a) || a instanceof Callable;
  const bObject = isReference(b) || b instanceof Callable;
  if (aObject && bObject) return false;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (aObject) return looseEquals(toPrimitive(a, 'default'), b);
  if (bObject) return looseEquals(a, toPrimitive(b, 'default'));
  // Two primitives of one type were decided by `===` above (`NaN` included).
  if (typeof a === typeof b) return false;
  if (typeof a === 'boolean') return looseEquals(a ? 1 : 0, b);
  if (typeof b === 'boolean') return looseEquals(a, b ? 1 : 0);
  return toNumber(a) === toNumber(b);
}

export function isReference(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Array.isArray(value) ||
      value instanceof InterpObject ||
      value instanceof GlobalObject ||
      value instanceof InterpRegExp ||
      value instanceof InterpError ||
      value instanceof InterpDate ||
      value instanceof InterpArguments)
  );
}

/**
 * InstanceofOperator (ES2023 §13.10.2) without `Symbol.hasInstance`, which
 * nothing here can define: a bound function defers to its target, and
 * OrdinaryHasInstance reads the constructor's `prototype` and walks the
 * left's chain for it. The builtin constructors are answered by kind, since
 * their prototypes are the only objects of their kind the model has.
 */
export function instanceOf(host: Host, left: unknown, right: unknown): boolean {
  if (right instanceof BoundFunction) return instanceOf(host, left, right.target);
  if (right === arrayConstructor) return Array.isArray(left);
  if (right === objectConstructor) {
    return (isReference(left) || left instanceof Callable) && inheritsObjectProto(left);
  }
  if (right === regExpConstructor) return left instanceof InterpRegExp;
  if (right === dateConstructor) return left instanceof InterpDate;
  // No wrapper objects exist here, so nothing has a String, Number or
  // Boolean prototype on its chain.
  if (right === stringConstructor || right === numberConstructor || right === booleanConstructor) return false;
  if (right instanceof NativeFunction && errorConstructors.has(right)) {
    // By the chain the error was made on, not by its `name`: a TypeError
    // renamed 'RangeError' is still no RangeError.
    if (!(left instanceof InterpError)) return false;
    return right === errorConstructor || left.protoName === right.name;
  }
  if (right instanceof Callable) {
    // OrdinaryHasInstance answers a primitive left before it reads `prototype`.
    if (!isReference(left) && !(left instanceof Callable)) return false;
    const proto = right instanceof NativeFunction ? right.props.get('prototype') : getMember(host, right, 'prototype');
    if (!isReference(proto) && !(proto instanceof Callable)) {
      // A primitive there is V8's TypeError, and it names the primitive.
      return host.throwError('TypeError', `Function has non-object prototype '${toStringValue(proto)}' in instanceof check`);
    }
    if (proto instanceof InterpObject && proto.builtin !== null) {
      // `P.prototype = Array.prototype`: the left's chain runs through the
      // exotic prototypes the model keeps only as tables.
      refuse(`instanceof against a function whose prototype is ${proto.builtin} is not modelled`);
    }
    // A plain object is found by walking a plain object's chain. An array,
    // function or other non-plain prototype is on no chain the model can
    // build, and a non-plain left has only builtins on its own.
    if (!(left instanceof InterpObject) || !(proto instanceof InterpObject)) return false;
    for (let p = left.proto; p !== null; p = p.proto) if (p === proto) return true;
    return false;
  }
  if (!isReference(right)) return host.throwError('TypeError', "Right-hand side of 'instanceof' is not an object");
  return host.throwError('TypeError', "Right-hand side of 'instanceof' is not callable");
}

// ---------------------------------------------------------------------------
// The closed tables
// ---------------------------------------------------------------------------

/**
 * Every key V8's `Object.prototype` carries. This is the one builtin whose
 * key set the model treats as known in full - it has not changed since
 * `__proto__` was standardised, and any addition would land on every object
 * in the language - so a key outside it that reaches `Object.prototype` is an
 * exact `undefined`. Four of the twelve are answered (`hasOwnProperty`,
 * `toString`, `valueOf`, `propertyIsEnumerable`), six are refused on any
 * touch by `BLOCKED_KEYS`, and the last two are refused here.
 */
const OBJECT_PROTO_UNMODELLED = new Set(['isPrototypeOf', 'toLocaleString']);

/**
 * `Function.prototype` in full: `apply`, `bind`, `call` and `toString` are
 * answered; `arguments` and `caller` - accessors that throw on a strict
 * function and read `null` on a sloppy one, and own on the sloppy one - are
 * refused on any touch; `length`, `name` and `constructor` are handled
 * before the table is reached.
 */
const FUNCTION_PROTO_UNMODELLED = new Set(['arguments', 'caller']);

function refuseUnlisted(where: string, k: string): never {
  return refuse(`${where}.${k} is outside the interpreter's builtin whitelist`);
}

/**
 * A key no builtin has ever carried or could: every builtin property is
 * named by an IdentifierName, so an index, `'-1'`, `'1.5'` or `'a b'` that
 * is not own is an exact `undefined` on any table - the read a decoder makes
 * with a stray negative index.
 */
function couldBeBuiltinKey(k: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(k);
}

/**
 * A read that ended at `Object.prototype`: the value, or the exact
 * `undefined` for a key it never had.
 */
function fromObjectProto(k: string): unknown {
  const found = objectProto.props.get(k);
  if (found !== undefined) return found;
  if (OBJECT_PROTO_UNMODELLED.has(k)) refuseUnlisted('Object.prototype', k);
  return undefined;
}

function inObjectProto(k: string): boolean {
  if (objectProto.props.has(k)) return true;
  if (OBJECT_PROTO_UNMODELLED.has(k)) refuseUnlisted('Object.prototype', k);
  return false;
}

/**
 * A read that fell through to one of the other builtin tables. A hit is the
 * answer, through `Object.prototype` if need be; a miss is refused, because
 * V8's `Array.prototype` - or `Math`, or `String.prototype` - carries keys
 * this table does not list, and `undefined` would claim to know it does not.
 */
function fromBuiltinProto(table: InterpObject, k: string): unknown {
  const found = table.props.get(k);
  if (found !== undefined) return found;
  const inherited = objectProto.props.get(k);
  if (inherited !== undefined) return inherited;
  if (!couldBeBuiltinKey(k)) return undefined;
  return refuseUnlisted(table.builtin!, k);
}

function inBuiltinProto(table: InterpObject, k: string): boolean {
  if (table.props.has(k) || objectProto.props.has(k)) return true;
  if (!couldBeBuiltinKey(k)) return false;
  return refuseUnlisted(table.builtin!, k);
}

/** A read on a builtin function - a constructor or a method - that its own table did not answer. */
function fromBuiltinFunction(fn: NativeFunction, k: string): unknown {
  const inherited = functionProto.props.get(k) ?? objectProto.props.get(k);
  if (inherited !== undefined) return inherited;
  if (!couldBeBuiltinKey(k)) return undefined;
  return refuseUnlisted(fn.name, k);
}

/** `key in value`. */
export function hasProperty(host: Host, value: unknown, key: unknown): boolean {
  if (!isReference(value) && !(value instanceof Callable)) {
    return host.throwError(
      'TypeError',
      `Cannot use 'in' operator to search for '${toPropertyKey(key)}' in ${toStringValue(value)}`,
    );
  }
  if (isConstructorOfFunction(value, key)) return true;
  if (value instanceof GlobalObject) return value.bindings.has(modelledKey(key));
  const k = modelledKey(key);
  if (hasOwnProperty(value, k)) return true;
  // A hole: no index is inherited, `Array.prototype` being an empty array.
  if (Array.isArray(value)) return inBuiltinProto(arrayProto, k);
  if (value instanceof InterpObject) {
    if (value === objectProto) return false;
    if (value.builtin !== null) return inBuiltinProto(value, k);
    for (let o: InterpObject | null = value.proto; o !== null; o = o.proto) if (o.props.has(k)) return true;
    return !chainEnd(value).bare && inObjectProto(k);
  }
  if (value instanceof Callable) {
    if (FUNCTION_PROTO_UNMODELLED.has(k)) refuseUnlisted('Function.prototype', k);
    // `Function.prototype` has its own `name` and `length`: still `in` after a delete.
    if (k === 'name' || k === 'length' || functionProto.props.has(k)) return true;
    return value instanceof NativeFunction ? inBuiltinProto(functionProto, k) : inObjectProto(k);
  }
  if (value instanceof InterpRegExp) return REGEXP_ACCESSORS.has(k) || inBuiltinProto(regExpProto, k);
  if (value instanceof InterpError) return k === 'name' || k === 'message' || inBuiltinProto(errorProto, k);
  if (value instanceof InterpDate) return inBuiltinProto(dateProto, k);
  return inObjectProto(k);
}

/** The own-property test behind `hasOwnProperty`, `in` and the arguments/hole rules. */
function hasOwnProperty(value: unknown, k: string): boolean {
  // The global's own properties are its bindings - the builtins and the
  // slice's top-level `var`s and functions, never a `let` - and a name it
  // does not have is one the program may, which `bindings.has` refuses.
  if (value instanceof GlobalObject) return value.bindings.has(k);
  if (Array.isArray(value)) return k === 'length' || ownKey(value, k);
  if (value instanceof InterpObject) {
    if (value.props.has(k)) return true;
    // A builtin's own keys beyond its table are V8's to know.
    if (value.builtin !== null) {
      if (value === objectProto) return inObjectProto(k);
      return couldBeBuiltinKey(k) ? refuseUnlisted(value.builtin, k) : false;
    }
    return false;
  }
  if (value instanceof Callable) {
    if (FUNCTION_PROTO_UNMODELLED.has(k)) refuseUnlisted('Function.prototype', k);
    if (k === 'name') return !value.nameDeleted;
    if (k === 'length') return !value.lengthDeleted;
    if (k === 'prototype') return value.autoPrototype || value.props.has(k);
    if (value.hasProps && value.props.has(k)) return true;
    return value instanceof NativeFunction && couldBeBuiltinKey(k) ? refuseUnlisted(value.name, k) : false;
  }
  if (value instanceof InterpArguments) {
    const index = toIndex(k);
    if (index >= 0 && index < value.slots.length && value.slots[index] !== undefined) return true;
    return value.own.has(k);
  }
  if (typeof value === 'string') {
    const index = toIndex(k);
    if (index >= 0) return index < value.length;
    return k === 'length';
  }
  if (value instanceof InterpRegExp) return k === 'lastIndex';
  if (value instanceof InterpError) {
    return k === 'stack' || (k === 'message' && value.ownMessage) || (k === 'name' && value.ownName);
  }
  return false;
}

/** Accessors `RegExp.prototype` answers from the instance: `'source' in /x/` is true, own it is not. */
const REGEXP_ACCESSORS = new Set([
  'source',
  'flags',
  'global',
  'ignoreCase',
  'multiline',
  'dotAll',
  'unicode',
  'unicodeSets',
  'sticky',
  'hasIndices',
]);

function ownKey(target: unknown[], key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

export function getMember(host: Host, object: unknown, key: unknown): unknown {
  if (object === null || object === undefined) {
    host.throwError(
      'TypeError',
      `Cannot read properties of ${object === null ? 'null' : 'undefined'} (reading '${toPropertyKey(key)}')`,
    );
  }

  if (isConstructorOfFunction(object, key)) return functionConstructor;
  if (object instanceof GlobalObject) return object.bindings.read(modelledKey(key));

  if (typeof object === 'string') {
    const index = toIndex(key);
    if (index >= 0) return index < object.length ? object.charAt(index) : undefined;
    const k = modelledKey(key);
    if (k === 'length') return object.length;
    return fromBuiltinProto(stringProto, k);
  }

  if (Array.isArray(object)) {
    const index = toIndex(key);
    if (index >= 0) return object[index];
    const k = modelledKey(key);
    if (k === 'length') return object.length;
    // Non-index own properties: `match()` results carry `index` and `input`.
    if (ownKey(object, k)) return (object as unknown as Record<string, unknown>)[k];
    return fromBuiltinProto(arrayProto, k);
  }

  if (object instanceof InterpObject) {
    const k = modelledKey(key);
    if (object.builtin !== null) {
      return object === objectProto ? fromObjectProto(k) : fromBuiltinProto(object, k);
    }
    let last = object;
    for (let o: InterpObject | null = object; o !== null; o = o.proto) {
      const found = o.props.get(k);
      if (found !== undefined || o.props.has(k)) return found;
      last = o;
    }
    return last.bare ? undefined : fromObjectProto(k);
  }

  if (object instanceof Callable) {
    const k = modelledKey(key);
    if (FUNCTION_PROTO_UNMODELLED.has(k)) refuseUnlisted('Function.prototype', k);
    // `name` and `length` are own until deleted; then `Function.prototype`'s
    // `''` and `0` show through unless the program wrote its own.
    if (k === 'name') return object.nameDeleted ? '' : object.name;
    if (k === 'length') return object.lengthDeleted ? 0 : object.arity;
    if (k === 'prototype' && object.autoPrototype && !object.props.has('prototype')) {
      // Minted on first touch: a user function's `prototype` is an own data
      // property from birth, whatever the program later stores in it.
      const proto = new InterpObject(null);
      object.props.set('prototype', proto);
      return proto;
    }
    if (object.hasProps && object.props.has(k)) {
      // Every error constructor shares one prototype table here, where V8
      // gives each its own object below `Error.prototype`; handing out the
      // shared one would make `TypeError.prototype === Error.prototype`.
      if (k === 'prototype' && object !== errorConstructor && errorConstructors.has(object as NativeFunction)) {
        refuse(`${object.name}.prototype is not modelled apart from Error.prototype`);
      }
      return object.props.get(k);
    }
    if (object instanceof NativeFunction) return fromBuiltinFunction(object, k);
    return functionProto.props.get(k) ?? fromObjectProto(k);
  }

  if (object instanceof InterpArguments) {
    const index = toIndex(key);
    if (index >= 0 && index < object.slots.length) {
      const slot = object.slots[index];
      if (slot !== undefined) return slot.value;
    }
    const k = modelledKey(key);
    if (k === 'callee' && object.strict && object.own.has('callee')) {
      return host.throwError(
        'TypeError',
        "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them",
      );
    }
    if (object.own.has(k)) return object.own.get(k);
    return fromObjectProto(k);
  }

  if (typeof object === 'number') return fromBuiltinProto(numberProto, modelledKey(key));

  if (typeof object === 'boolean') return fromBuiltinProto(booleanProto, modelledKey(key));

  if (object instanceof InterpRegExp) {
    const k = modelledKey(key);
    if (k === 'lastIndex') return object.lastIndex;
    if (REGEXP_ACCESSORS.has(k)) {
      // The host regexp answers every flag accessor, including the ones this
      // table never spelled out (`sticky`, `dotAll`, `hasIndices`, ...).
      return (object.regex as unknown as Record<string, unknown>)[k];
    }
    return fromBuiltinProto(regExpProto, k);
  }

  if (object instanceof InterpError) {
    const k = modelledKey(key);
    if (k === 'name') return object.ownName ? object.name : object.protoName;
    if (k === 'message') return errorMessage(object);
    // V8's `stack` is the message followed by the frames of the real call,
    // which no model of the program reproduces.
    if (k === 'stack') refuseUnlisted('Error.prototype', k);
    return fromBuiltinProto(errorProto, k);
  }

  if (object instanceof InterpDate) return fromBuiltinProto(dateProto, modelledKey(key));

  return undefined;
}

/**
 * A write the target does not take: a frozen object, a non-writable `name`,
 * a primitive receiver. Sloppy code moves on as if it had happened; strict
 * code gets the TypeError V8 raises. The interpreter says which it is.
 */
function rejectWrite(host: Host, strict: boolean, message: string, exact = true): void {
  if (strict) host.throwError('TypeError', message, exact);
}

/** How V8 names the object of a failed `delete`; a function is rendered as its source, which is not copied. */
function describeReceiver(object: unknown): string | null {
  if (Array.isArray(object)) return '[object Array]';
  if (typeof object === 'string') return '[object String]';
  if (object instanceof InterpRegExp) return '[object RegExp]';
  if (object instanceof Callable) return null;
  return '#<Object>';
}

/**
 * `object[key] = value`. Nothing here writes a builtin: `Math.foo = 1` would
 * take on V8 and `String.prototype.split = f` would change every later
 * split, and the model keeps neither - a program that reaches for one is
 * refused rather than run as though it had not.
 */
export function setMember(host: Host, object: unknown, key: unknown, value: unknown, strict = false): unknown {
  if (object === null || object === undefined) {
    host.throwError(
      'TypeError',
      `Cannot set properties of ${object === null ? 'null' : 'undefined'} (setting '${toPropertyKey(key)}')`,
    );
  }

  if (object instanceof GlobalObject) {
    object.bindings.write(modelledKey(key), value);
    return value;
  }

  if (Array.isArray(object)) {
    const index = toIndex(key);
    if (index >= 0) {
      host.checkArrayLength(index + 1);
      object[index] = value;
      return value;
    }
    const k = modelledKey(key);
    if (k === 'length') {
      // ArraySetLength: ToUint32 and ToNumber must agree, or it is a RangeError.
      const numeric = toNumber(value);
      const length = numeric >>> 0;
      if (length !== numeric) host.throwError('RangeError', 'Invalid array length');
      host.checkArrayLength(length);
      object.length = length;
      return value;
    }
    (object as unknown as Record<string, unknown>)[k] = value;
    return value;
  }

  if (object instanceof InterpObject) {
    const k = modelledKey(key);
    if (object.builtin !== null) refuse(builtinWrite(object.builtin, k));
    if (object.frozen) {
      if (object.props.has(k)) {
        rejectWrite(host, strict, `Cannot assign to read only property '${k}' of object '#<Object>'`);
      } else {
        rejectWrite(host, strict, `Cannot add property ${k}, object is not extensible`);
      }
      return value;
    }
    // OrdinarySet: an inherited non-writable property - one a frozen
    // prototype holds - stops the write before an own property is made.
    if (!object.props.has(k)) {
      for (let o = object.proto; o !== null; o = o.proto) {
        if (o.frozen && o.props.has(k)) {
          rejectWrite(host, strict, `Cannot assign to read only property '${k}' of object '#<Object>'`);
          return value;
        }
      }
    }
    object.props.set(k, value);
    return value;
  }

  if (object instanceof Callable) {
    const k = modelledKey(key);
    if (object instanceof NativeFunction) refuse(builtinWrite(object.name, k));
    if (FUNCTION_PROTO_UNMODELLED.has(k)) refuseUnlisted('Function.prototype', k);
    // V8 renders the function's source text in these messages; the words are its own.
    if (object.frozen) {
      if (hasOwnProperty(object, k)) rejectWrite(host, strict, `Cannot assign to read only property '${k}' of function`, false);
      else rejectWrite(host, strict, `Cannot add property ${k}, object is not extensible`);
      return value;
    }
    if (k === 'name' || k === 'length') {
      rejectWrite(host, strict, `Cannot assign to read only property '${k}' of function`, false);
      return value;
    }
    object.props.set(k, value);
    return value;
  }

  if (object instanceof InterpArguments) {
    const index = toIndex(key);
    if (index >= 0 && index < object.slots.length) {
      const slot = object.slots[index];
      if (slot !== undefined) {
        slot.value = value;
        return value;
      }
    }
    const k = modelledKey(key);
    if (k === 'callee' && object.strict && object.own.has('callee')) {
      return host.throwError(
        'TypeError',
        "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them",
      );
    }
    object.own.set(k, value);
    return value;
  }

  if (object instanceof InterpRegExp) {
    const k = modelledKey(key);
    if (k === 'lastIndex') {
      // ToLength happens when the regex runs; an object there would run its
      // own `valueOf`, so only a primitive is kept.
      if (isReference(value) || value instanceof Callable) {
        refuse('a RegExp lastIndex that is an object would be converted through its own valueOf');
      }
      object.lastIndex = value;
      return value;
    }
    // V8 takes any other key as a new own property; the model has nowhere to keep it.
    return refuse(builtinWrite('a RegExp', k));
  }

  if (object instanceof InterpError) {
    const k = modelledKey(key);
    if (k === 'name') {
      if (!object.ownName) object.enumerable.add('name');
      object.name = value;
      object.ownName = true;
      return value;
    }
    if (k === 'message') {
      if (!object.ownMessage) object.enumerable.add('message');
      object.message = value;
      object.ownMessage = true;
      object.exactMessage = true;
      return value;
    }
    return refuse(builtinWrite('an Error', k));
  }

  if (object instanceof InterpDate) return refuse(builtinWrite('a Date', modelledKey(key)));

  // A primitive takes no property: sloppy code discards the write, strict code throws.
  const k = modelledKey(key);
  rejectWrite(host, strict, `Cannot create property '${k}' on ${typeof object} '${toStringValue(object)}'`);
  return value;
}

function builtinWrite(where: string, k: string): string {
  return `writing ${where}.${k} would change what every later use of it computes, which the model does not follow`;
}

/**
 * `delete object[key]`, with the answer V8 gives: `true` for a configurable
 * or absent property, and for a non-configurable one `false` in sloppy code
 * and a TypeError in strict code.
 */
export function deleteMember(host: Host, object: unknown, key: unknown, strict = false): boolean {
  if (object === null || object === undefined) {
    return host.throwError('TypeError', 'Cannot convert undefined or null to object');
  }
  if (object instanceof GlobalObject) refuse('deleting a property of the global object is not modelled');
  const k = modelledKey(key);
  const nonConfigurable = (): boolean => {
    const receiver = describeReceiver(object);
    rejectWrite(host, strict, `Cannot delete property '${k}' of ${receiver ?? 'function'}`, receiver !== null);
    return false;
  };

  if (Array.isArray(object)) {
    const index = toIndex(k);
    if (index >= 0) {
      delete object[index];
      return true;
    }
    if (k === 'length') return nonConfigurable();
    delete (object as unknown as Record<string, unknown>)[k];
    return true;
  }
  if (object instanceof InterpObject) {
    if (object.builtin !== null) refuse(builtinWrite(object.builtin, k));
    if (object.frozen && object.props.has(k)) return nonConfigurable();
    object.props.delete(k);
    return true;
  }
  if (object instanceof Callable) {
    if (object instanceof NativeFunction) refuse(builtinWrite(object.name, k));
    if (FUNCTION_PROTO_UNMODELLED.has(k)) refuseUnlisted('Function.prototype', k);
    if (object.frozen && hasOwnProperty(object, k)) return nonConfigurable();
    if (k === 'prototype' && object.autoPrototype) return nonConfigurable();
    if (k === 'name') object.nameDeleted = true;
    if (k === 'length') object.lengthDeleted = true;
    if (object.hasProps) object.props.delete(k);
    return true;
  }
  if (object instanceof InterpArguments) {
    // A strict arguments object's `callee` is the non-configurable poison pill.
    if (k === 'callee' && object.strict && object.own.has('callee')) return nonConfigurable();
    const index = toIndex(k);
    if (index >= 0 && index < object.slots.length) object.slots[index] = undefined;
    object.own.delete(k);
    object.hidden.delete(k);
    return true;
  }
  if (object instanceof InterpRegExp) return k === 'lastIndex' ? nonConfigurable() : true;
  if (object instanceof InterpError) {
    if (k === 'stack') refuseUnlisted('Error.prototype', k);
    if (k === 'name') {
      object.ownName = false;
      object.name = object.protoName;
    } else if (k === 'message') {
      object.ownMessage = false;
      object.message = '';
      object.exactMessage = true;
    }
    object.enumerable.delete(k);
    return true;
  }
  if (typeof object === 'string') {
    const index = toIndex(k);
    return (index >= 0 && index < object.length) || k === 'length' ? nonConfigurable() : true;
  }
  return true;
}

/**
 * Enumerable own keys in OrdinaryOwnPropertyKeys order - what `for...in`
 * walks on the object itself and `Object.keys` returns.
 *
 * Arrays and `arguments` objects are asked as V8 asks them: a hole is not a
 * key, `length` is never one, and a match result's `index`/`input`/`groups`
 * follow the indices. Null and undefined are a TypeError, not an empty list.
 */
export function ownEnumerableKeys(host: Host, value: unknown): string[] {
  if (value === null || value === undefined) {
    return host.throwError('TypeError', 'Cannot convert undefined or null to object');
  }
  if (Array.isArray(value)) return Object.keys(value);
  if (value instanceof GlobalObject) refuse(builtinReflection('the global object'));
  if (value instanceof InterpObject) {
    if (value.builtin !== null) refuse(builtinReflection(value.builtin));
    return orderKeys([...value.props.keys()]);
  }
  if (value instanceof Callable) {
    if (value instanceof NativeFunction) refuse(builtinReflection(value.name));
    return value.hasProps ? orderKeys([...value.props.keys()].filter((key) => key !== 'prototype')) : [];
  }
  if (value instanceof InterpArguments) {
    return argumentsKeys(value).filter((key) => !value.hidden.has(key));
  }
  if (typeof value === 'string') {
    const keys: string[] = [];
    for (let i = 0; i < value.length; i++) keys.push(String(i));
    return keys;
  }
  if (value instanceof InterpError && value.enumerable.size > 0) {
    refuse('enumerating an error the program has assigned properties to is not modelled');
  }
  return [];
}

/**
 * Reflection over a builtin - its keys, its entries, a spread or `for...in`
 * of it, its JSON - enumerates the model's table where V8 enumerates its own.
 * The two never agree (every builtin property is non-enumerable there, so
 * `Object.keys(Math)` is `[]`, and `getOwnPropertyNames(JSON)` grows with the
 * release), and a decoder has no business asking.
 */
function builtinReflection(name: string): string {
  return `enumerating ${name} would list the interpreter's model of it rather than the properties V8 gives it`;
}

/** Every own key of an `arguments` object, enumerable or not, in V8's order. */
function argumentsKeys(value: InterpArguments): string[] {
  const keys: string[] = [];
  for (let i = 0; i < value.slots.length; i++) if (value.slots[i] !== undefined) keys.push(String(i));
  for (const key of value.own.keys()) keys.push(key);
  return orderKeys(keys);
}

/**
 * Own keys as `Object.getOwnPropertyNames` lists them: the enumerable ones plus
 * an array's or string's `length`, an `arguments` object's `length` and
 * `callee`, a regexp's `lastIndex`. Functions and errors are refused: V8's
 * list for a function depends on its strictness and kind (`arguments` and
 * `caller` appear on a sloppy one), and an error's is in the order `name` and
 * `message` were assigned, which the model does not keep.
 */
function ownPropertyNames(host: Host, value: unknown): string[] {
  if (value === null || value === undefined) {
    return host.throwError('TypeError', 'Cannot convert undefined or null to object');
  }
  if (Array.isArray(value)) return Object.getOwnPropertyNames(value);
  if (value instanceof InterpArguments) return argumentsKeys(value);
  if (typeof value === 'string') return [...ownEnumerableKeys(host, value), 'length'];
  if (value instanceof InterpRegExp) return ['lastIndex'];
  if (value instanceof Callable) {
    return refuse("Object.getOwnPropertyNames of a function lists 'arguments' and 'caller' by the function's strictness, which the model does not report");
  }
  if (value instanceof InterpError) {
    return refuse('Object.getOwnPropertyNames of an error lists its keys in assignment order, which the model does not keep');
  }
  return ownEnumerableKeys(host, value);
}

// ---------------------------------------------------------------------------
// Table construction helpers
// ---------------------------------------------------------------------------

function nat(name: string, arity: number, impl: NativeImpl, construct?: NativeImpl): NativeFunction {
  const fn = new NativeFunction(name, arity, impl, construct);
  fn.frozen = true;
  return fn;
}

/** A builtin object, named for its refusals: a prototype table or a namespace. */
function frozenObject(name: string, entries: Record<string, unknown>): InterpObject {
  const object = new InterpObject(null);
  for (const [key, value] of Object.entries(entries)) object.props.set(key, value);
  object.frozen = true;
  object.builtin = name;
  return object;
}

function requireString(host: Host, value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) {
    // RequireObjectCoercible's wording names the method, not the value.
    host.throwError('TypeError', `String.prototype.${what} called on null or undefined`);
  }
  return toStringValue(value);
}

/**
 * StringPad, in its order: the receiver comes back untouched when the target
 * is not longer than it, then again when the filler - converted only now -
 * is empty, and only a fill that would happen is measured against the
 * length limit.
 */
function stringPad(host: Host, self: unknown, a: readonly unknown[], what: 'padStart' | 'padEnd'): string {
  const text = requireString(host, self, what);
  const target = toInteger(a[0]);
  if (target <= text.length) return text;
  const filler = a[1] === undefined ? ' ' : toStringValue(a[1]);
  if (filler === '') return text;
  if (target >= V8_MAX_STRING_LENGTH) host.throwError('RangeError', 'Invalid string length');
  host.tick(target - text.length);
  return host.trackString(what === 'padStart' ? text.padStart(target, filler) : text.padEnd(target, filler));
}

/** The receiver of `String.prototype.toString`/`valueOf`: a string primitive, or a TypeError. */
function thisString(host: Host, value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  return host.throwError('TypeError', `String.prototype.${what} requires that 'this' be a String`);
}

function thisNumber(host: Host, value: unknown, what: string): number {
  if (typeof value === 'number') return value;
  return host.throwError('TypeError', `Number.prototype.${what} requires that 'this' be a Number`);
}

function thisBoolean(host: Host, value: unknown, what: string): boolean {
  if (typeof value === 'boolean') return value;
  return host.throwError('TypeError', `Boolean.prototype.${what} requires that 'this' be a Boolean`);
}

function requireArray(host: Host, value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) {
    return host.throwError('TypeError', 'Cannot convert undefined or null to object');
  }
  if (value instanceof InterpArguments) {
    return refuse(`Array.prototype.${what} applied to an arguments object would write through it, which the model does not do`);
  }
  // V8 runs the method generically over ToObject(receiver): `push.call({})`
  // writes `0` and `length` onto the object, `push.call(5)` onto a wrapper.
  return refuse(`Array.prototype.${what} applied to a value that is not an array is run generically by V8, which the model does not do`);
}

/**
 * The `this` of a generic, non-mutating `Array.prototype` method: an array, or
 * an `arguments` object read through its `length` and indices the way
 * `Array.prototype.slice.call(arguments)` reads it. Every read goes back to the
 * object, so a callback that writes a mapped parameter mid-loop is seen by
 * the next iteration, as V8 sees it.
 */
type ArrayLike = readonly unknown[] | InterpArguments;

function arrayLike(host: Host, value: unknown, what: string): ArrayLike {
  if (Array.isArray(value) || value instanceof InterpArguments) return value;
  if (value === null || value === undefined) {
    return host.throwError('TypeError', 'Cannot convert undefined or null to object');
  }
  return refuse(`Array.prototype.${what} applied to a value that is not an array or an arguments object is run generically by V8, which the model does not do`);
}

function lengthOf(items: ArrayLike): number {
  if (Array.isArray(items)) return items.length;
  const length = toInteger((items as InterpArguments).own.get('length'));
  return Math.max(0, Math.min(length, Number.MAX_SAFE_INTEGER));
}

/** `index in items`: a hole is skipped by the callback methods. */
function hasIndex(items: ArrayLike, index: number): boolean {
  return Array.isArray(items) ? index in items : hasOwnProperty(items, String(index));
}

function at(host: Host, items: ArrayLike, index: number): unknown {
  return Array.isArray(items) ? items[index] : getMember(host, items, index);
}

/** A dense snapshot for the host methods that read every element once. */
function toList(host: Host, items: ArrayLike): unknown[] {
  if (Array.isArray(items)) return items as unknown[];
  const length = lengthOf(items);
  host.checkArrayLength(length);
  const list: unknown[] = new Array<unknown>(length);
  for (let i = 0; i < length; i++) if (hasIndex(items, i)) list[i] = at(host, items, i);
  return list;
}

function optionalInteger(value: unknown, fallback: number): number {
  return value === undefined ? fallback : toInteger(value);
}

// ---------------------------------------------------------------------------
// Regular expressions
// ---------------------------------------------------------------------------

/**
 * Host regex engines have no step budget. The subject is capped, and the
 * pattern's backtracking over it is bounded before the host runs it; see
 * `regex-cost.ts`. Both are guards, not program-visible throws: V8 would run
 * the match, so a catchable error here is a behaviour the program never has.
 */
function boundedSubject(host: Host, subject: string): string {
  if (subject.length > host.maxRegexInput) {
    refuse(`a regular expression subject of ${subject.length} characters exceeds the interpreter's limit of ${host.maxRegexInput}`);
  }
  return subject;
}

function boundedBacktracking(value: InterpRegExp, subject: string): void {
  const cost = value.cost;
  if (typeof cost === 'string') refuse(`the backtracking of ${toStringValue(value)} is not bounded: it has ${cost}`);
  if (!Number.isFinite(regexWork(cost, subject))) {
    refuse(`${toStringValue(value)} could backtrack past the interpreter's budget on a subject of ${subject.length} characters`);
  }
}

/**
 * Run a host method over the program's regex and `subject` with `lastIndex`
 * carried across. V8's own builtins read and write the regex's `lastIndex` -
 * a global `replace` leaves it 0, a sticky `exec` advances it, `search` puts
 * it back - and running the host's builtin on the host regex reproduces every
 * one of those rules, provided the model's copy and the host's agree going in
 * and coming out.
 */
function withHostRegExp<T>(host: Host, value: InterpRegExp, subject: string, run: (regex: RegExp) => T): T {
  boundedSubject(host, subject);
  boundedBacktracking(value, subject);
  value.regex.lastIndex = value.lastIndex as number;
  try {
    return run(value.regex);
  } finally {
    value.lastIndex = value.regex.lastIndex;
  }
}

/**
 * The regex `match` and `search` run: the argument itself, or `new
 * RegExp(argument)` - not escaped, so `'abc'.search('.')` is 0 as it is
 * there, and an absent argument is the empty pattern.
 */
function regExpArgument(host: Host, value: unknown): InterpRegExp {
  if (value instanceof InterpRegExp) return value;
  return constructRegExp(host, [value === undefined ? '' : toStringValue(value)]);
}

/** A `RegExp` where `includes`, `startsWith` and `endsWith` take a string is V8's TypeError. */
function notRegExp(host: Host, value: unknown, what: string): string {
  if (value instanceof InterpRegExp) {
    host.throwError('TypeError', `First argument to String.prototype.${what} must not be a regular expression`);
  }
  return toStringValue(value);
}

/**
 * A match result: an array of captures carrying `index`, `input` and `groups`
 * - the last an own property whether or not the pattern names any group, so
 * that `'groups' in m` and `Object.keys(m)` read as they do on the real one.
 * Named groups arrive on a prototype-less object, as V8 makes it; a group
 * named for a blocked key is that key on any value, and is refused where the
 * object is made rather than dropped from it.
 */
function matchToArray(match: RegExpExecArray): unknown[] {
  const result: unknown[] = [];
  for (let i = 0; i < match.length; i++) result.push(match[i]);
  const withProps = result as unknown as Record<string, unknown>;
  withProps['index'] = match.index;
  withProps['input'] = match.input;
  withProps['groups'] = match.groups === undefined ? undefined : groupsObject(match.groups);
  return result;
}

function groupsObject(groups: Record<string, unknown>): InterpObject {
  const object = new InterpObject(null);
  object.bare = true;
  for (const [name, value] of Object.entries(groups)) object.props.set(modelledKey(name), value);
  return object;
}

function replaceWith(
  host: Host,
  subject: string,
  pattern: unknown,
  replacement: unknown,
  all: boolean,
): string {
  boundedSubject(host, subject);
  let replacer: string | ((...args: unknown[]) => string);
  if (host.isCallable(replacement)) {
    replacer = (...args: unknown[]): string => {
      host.tick(4);
      // The host passes (match, ...captures, offset, subject) and, for a
      // pattern with named groups, its own groups object last. That object
      // is rebuilt as the prototype-less one V8 hands the callback; nothing
      // host-owned crosses.
      const last = args[args.length - 1];
      if (typeof last === 'object' && last !== null) {
        args[args.length - 1] = groupsObject(last as Record<string, unknown>);
      }
      return toStringValue(host.call(replacement, undefined, args));
    };
  } else {
    replacer = toStringValue(replacement);
  }

  if (pattern instanceof InterpRegExp) {
    if (all && !pattern.flags.includes('g')) {
      host.throwError('TypeError', 'String.prototype.replaceAll called with a non-global RegExp argument');
    }
    return host.trackString(withHostRegExp(host, pattern, subject, (regex) => subject.replace(regex, replacer as never)));
  }
  const needle = toStringValue(pattern);
  return host.trackString(
    all ? subject.replaceAll(needle, replacer as never) : subject.replace(needle, replacer as never),
  );
}

// ---------------------------------------------------------------------------
// base64 - implemented here rather than delegating to the host
// ---------------------------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Binary-safe `btoa`: input is a byte string (each code unit 0..255), output is
 * ASCII base64. Deliberately not `globalThis.btoa` - that is a host function and
 * this file's whole point is that no host function is reachable.
 */
export function encodeBase64(host: Host, input: string): string {
  const out: string[] = [];
  for (let i = 0; i < input.length; i += 3) {
    const b0 = input.charCodeAt(i);
    const b1 = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < input.length ? input.charCodeAt(i + 2) : 0;
    if (b0 > 0xff || b1 > 0xff || b2 > 0xff) {
      host.throwError('InvalidCharacterError', 'btoa: input contains a code point above 255', false);
    }
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out.push(
      BASE64[(triple >> 18) & 0x3f]!,
      BASE64[(triple >> 12) & 0x3f]!,
      i + 1 < input.length ? BASE64[(triple >> 6) & 0x3f]! : '=',
      i + 2 < input.length ? BASE64[triple & 0x3f]! : '=',
    );
    host.tick(1);
  }
  return host.trackString(out.join(''));
}

/** Binary-safe `atob`, following the WHATWG "forgiving-base64 decode" steps. */
export function decodeBase64(host: Host, raw: string): string {
  let input = raw.replace(/[\t\n\f\r ]/g, '');
  if (input.length % 4 === 0) input = input.replace(/={1,2}$/, '');
  if (input.length % 4 === 1) {
    host.throwError('InvalidCharacterError', 'atob: input length is not valid base64', false);
  }
  if (/[^+/0-9A-Za-z]/.test(input)) {
    host.throwError('InvalidCharacterError', 'atob: input contains a non-base64 character', false);
  }

  const out: string[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    buffer = (buffer << 6) | BASE64.indexOf(input.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(String.fromCharCode((buffer >> bits) & 0xff));
    }
    host.tick(1);
  }
  return host.trackString(out.join(''));
}

// ---------------------------------------------------------------------------
// String.prototype
// ---------------------------------------------------------------------------

/**
 * V8's own longest string, 2^29 - 24 code units on 64-bit builds: a result
 * that long is its RangeError. The model's ceiling (`maxStringLength`) is
 * lower and is a resource limit, uncatchable, not a program error.
 */
const V8_MAX_STRING_LENGTH = 2 ** 29 - 24;

const stringProto = frozenObject('String.prototype', {
  charAt: nat('charAt', 1, (h, self, a) => requireString(h, self, 'charAt').charAt(toInteger(a[0]))),
  charCodeAt: nat('charCodeAt', 1, (h, self, a) => {
    const value = requireString(h, self, 'charCodeAt').charCodeAt(toInteger(a[0]));
    return value;
  }),
  codePointAt: nat('codePointAt', 1, (h, self, a) =>
    requireString(h, self, 'codePointAt').codePointAt(toInteger(a[0])),
  ),
  at: nat('at', 1, (h, self, a) => requireString(h, self, 'at').at(toInteger(a[0]))),
  indexOf: nat('indexOf', 1, (h, self, a) =>
    requireString(h, self, 'indexOf').indexOf(toStringValue(a[0]), optionalInteger(a[1], 0)),
  ),
  lastIndexOf: nat('lastIndexOf', 1, (h, self, a) =>
    requireString(h, self, 'lastIndexOf').lastIndexOf(
      toStringValue(a[0]),
      a[1] === undefined ? Infinity : toNumber(a[1]),
    ),
  ),
  includes: nat('includes', 1, (h, self, a) =>
    requireString(h, self, 'includes').includes(notRegExp(h, a[0], 'includes'), optionalInteger(a[1], 0)),
  ),
  startsWith: nat('startsWith', 1, (h, self, a) =>
    requireString(h, self, 'startsWith').startsWith(notRegExp(h, a[0], 'startsWith'), optionalInteger(a[1], 0)),
  ),
  endsWith: nat('endsWith', 1, (h, self, a) =>
    requireString(h, self, 'endsWith').endsWith(
      notRegExp(h, a[0], 'endsWith'),
      a[1] === undefined ? undefined : toInteger(a[1]),
    ),
  ),
  slice: nat('slice', 2, (h, self, a) =>
    requireString(h, self, 'slice').slice(
      optionalInteger(a[0], 0),
      a[1] === undefined ? undefined : toInteger(a[1]),
    ),
  ),
  substring: nat('substring', 2, (h, self, a) =>
    requireString(h, self, 'substring').substring(
      optionalInteger(a[0], 0),
      a[1] === undefined ? undefined : toInteger(a[1]),
    ),
  ),
  substr: nat('substr', 2, (h, self, a) => {
    const text = requireString(h, self, 'substr');
    const start = optionalInteger(a[0], 0);
    const from = start < 0 ? Math.max(text.length + start, 0) : Math.min(start, text.length);
    const length = a[1] === undefined ? text.length - from : toInteger(a[1]);
    return text.slice(from, from + Math.max(0, length));
  }),
  concat: nat('concat', 1, (h, self, a) => {
    let out = requireString(h, self, 'concat');
    for (const part of a) out += toStringValue(part);
    return h.trackString(out);
  }),
  repeat: nat('repeat', 1, (h, self, a) => {
    const text = requireString(h, self, 'repeat');
    const count = toInteger(a[0]);
    if (count < 0 || count === Infinity) h.throwError('RangeError', `Invalid count value: ${count}`);
    if (text.length * count >= V8_MAX_STRING_LENGTH) h.throwError('RangeError', 'Invalid string length');
    h.tick(count);
    return h.trackString(text.repeat(count));
  }),
  padStart: nat('padStart', 1, (h, self, a) => stringPad(h, self, a, 'padStart')),
  padEnd: nat('padEnd', 1, (h, self, a) => stringPad(h, self, a, 'padEnd')),
  trim: nat('trim', 0, (h, self) => requireString(h, self, 'trim').trim()),
  trimStart: nat('trimStart', 0, (h, self) => requireString(h, self, 'trimStart').trimStart()),
  trimEnd: nat('trimEnd', 0, (h, self) => requireString(h, self, 'trimEnd').trimEnd()),
  toLowerCase: nat('toLowerCase', 0, (h, self) => requireString(h, self, 'toLowerCase').toLowerCase()),
  toUpperCase: nat('toUpperCase', 0, (h, self) => requireString(h, self, 'toUpperCase').toUpperCase()),
  // `thisStringValue`: a string, or a TypeError - never a coercion.
  toString: nat('toString', 0, (h, self) => thisString(h, self, 'toString')),
  valueOf: nat('valueOf', 0, (h, self) => thisString(h, self, 'valueOf')),
  normalize: nat('normalize', 0, (h, self, a) => {
    const text = requireString(h, self, 'normalize');
    // ES2023 §22.1.3.15: an absent form is NFC; anything else is validated
    // after ToString, and a bad one is a RangeError. Dropping the argument
    // silently normalised `'NFD'` requests to NFC, and the difference is the
    // string's length.
    const form = a[0] === undefined ? 'NFC' : toStringValue(a[0]);
    if (form !== 'NFC' && form !== 'NFD' && form !== 'NFKC' && form !== 'NFKD') {
      h.throwError('RangeError', 'The normalization form should be one of NFC, NFD, NFKC, NFKD.');
    }
    return h.trackString(text.normalize(form));
  }),
  split: nat('split', 2, (h, self, a) => {
    const text = boundedSubject(h, requireString(h, self, 'split'));
    const limit = a[1] === undefined ? undefined : toInteger(a[1]);
    if (a[0] === undefined) return limit === 0 ? [] : [text];
    // A regex separator is split with a fresh sticky copy, as the spec's
    // @@split makes one, so the program's `lastIndex` is neither read nor written.
    if (a[0] instanceof InterpRegExp) boundedBacktracking(a[0], text);
    const separator = a[0] instanceof InterpRegExp ? a[0].regex : toStringValue(a[0]);
    const parts = text.split(separator as never, limit);
    h.tick(parts.length);
    return parts as unknown[];
  }),
  replace: nat('replace', 2, (h, self, a) =>
    replaceWith(h, requireString(h, self, 'replace'), a[0], a[1], false),
  ),
  replaceAll: nat('replaceAll', 2, (h, self, a) =>
    replaceWith(h, requireString(h, self, 'replaceAll'), a[0], a[1], true),
  ),
  match: nat('match', 1, (h, self, a) => {
    const text = requireString(h, self, 'match');
    const pattern = regExpArgument(h, a[0]);
    return withHostRegExp(h, pattern, text, (regex) => {
      const found = text.match(regex);
      if (found === null) return null;
      return regex.global ? (found as unknown[]) : matchToArray(found as RegExpExecArray);
    });
  }),
  search: nat('search', 1, (h, self, a) => {
    const text = requireString(h, self, 'search');
    return withHostRegExp(h, regExpArgument(h, a[0]), text, (regex) => text.search(regex));
  }),
  // Collation is the host locale's ICU tables: `'a'.localeCompare('A')` is -1
  // under a typical Node and depends on the browser and its language elsewhere.
  // A code-unit compare stood here once and sorted `['a', 'A', 'b']` the other
  // way round from every real run.
  localeCompare: nat('localeCompare', 1, (h, self) => {
    requireString(h, self, 'localeCompare');
    return refuse('String.prototype.localeCompare orders by the collation of the locale the program runs in');
  }),
});

// ---------------------------------------------------------------------------
// Array.prototype
// ---------------------------------------------------------------------------

/**
 * The callback of an `Array.prototype` method, or V8's TypeError for a
 * non-callable: `number 1 is not a function`, `string "x" is not a
 * function`, `object null is not a function`, a bare `object` for any other
 * object and `undefined` for none.
 */
function callbackFor(host: Host, value: unknown, _method: string): unknown {
  if (!host.isCallable(value)) host.throwError('TypeError', `${describeNonCallable(value)} is not a function`);
  return value;
}

function describeNonCallable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'object null';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  return 'object';
}

const arrayProto = frozenObject('Array.prototype', {
  push: nat('push', 1, (h, self, a) => {
    const items = requireArray(h, self, 'push');
    h.checkArrayLength(items.length + a.length);
    for (const item of a) items.push(item);
    return items.length;
  }),
  pop: nat('pop', 0, (h, self) => requireArray(h, self, 'pop').pop()),
  shift: nat('shift', 0, (h, self) => requireArray(h, self, 'shift').shift()),
  unshift: nat('unshift', 1, (h, self, a) => {
    const items = requireArray(h, self, 'unshift');
    h.checkArrayLength(items.length + a.length);
    return items.unshift(...a);
  }),
  slice: nat('slice', 2, (h, self, a) =>
    toList(h, arrayLike(h, self, 'slice')).slice(
      a[0] === undefined ? undefined : toInteger(a[0]),
      a[1] === undefined ? undefined : toInteger(a[1]),
    ),
  ),
  splice: nat('splice', 2, (h, self, a) => {
    const items = requireArray(h, self, 'splice');
    if (a.length === 0) return [];
    if (a.length === 1) return items.splice(toInteger(a[0]));
    h.checkArrayLength(items.length + a.length);
    return items.splice(toInteger(a[0]), toInteger(a[1]), ...a.slice(2));
  }),
  concat: nat('concat', 1, (h, self, a) => {
    // The host spreads exactly what IsConcatSpreadable says: arrays, and not
    // an `arguments` object, which lands as one element. Holes stay holes.
    const items = arrayLike(h, self, 'concat');
    const out = (Array.isArray(items) ? items : [items]).concat(...a);
    h.checkArrayLength(out.length);
    return out;
  }),
  join: nat('join', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'join');
    const length = lengthOf(items);
    const separator = a[0] === undefined ? ',' : toStringValue(a[0]);
    h.tick(length);
    // On the cycle stack for the duration, as `toStringValue` puts an array
    // it joins: an element that leads back here prints as `''`.
    const cyclic = Array.isArray(items) && !joining.has(items);
    if (cyclic) joining.add(items as unknown[]);
    try {
      let out = '';
      for (let i = 0; i < length; i++) {
        if (i > 0) out += separator;
        const item = at(h, items, i);
        if (item !== null && item !== undefined) out += toStringValue(item);
      }
      return h.trackString(out);
    } finally {
      if (cyclic) joining.delete(items as unknown[]);
    }
  }),
  reverse: nat('reverse', 0, (h, self) => requireArray(h, self, 'reverse').reverse()),
  indexOf: nat('indexOf', 1, (h, self, a) => {
    const items = toList(h, arrayLike(h, self, 'indexOf'));
    h.tick(items.length);
    return items.indexOf(a[0], optionalInteger(a[1], 0));
  }),
  lastIndexOf: nat('lastIndexOf', 1, (h, self, a) => {
    const items = toList(h, arrayLike(h, self, 'lastIndexOf'));
    h.tick(items.length);
    // ES2023 §23.1.3.20: the search starts at `len - 1` only when `fromIndex`
    // is *absent*; a present one - even an explicit `undefined` - goes through
    // ToIntegerOrInfinity, so `[x].lastIndexOf(x, undefined)` searches from 0.
    return a.length < 2 ? items.lastIndexOf(a[0]) : items.lastIndexOf(a[0], toNumber(a[1]));
  }),
  includes: nat('includes', 1, (h, self, a) => {
    const items = toList(h, arrayLike(h, self, 'includes'));
    h.tick(items.length);
    return items.includes(a[0], optionalInteger(a[1], 0));
  }),
  fill: nat('fill', 1, (h, self, a) => {
    const items = requireArray(h, self, 'fill');
    h.tick(items.length);
    return items.fill(
      a[0],
      a[1] === undefined ? undefined : toInteger(a[1]),
      a[2] === undefined ? undefined : toInteger(a[2]),
    );
  }),
  // The callback methods skip holes - `[1, , 3].map(f)` calls `f` twice and
  // leaves the hole in place - where `find`/`findIndex` visit every index.
  // `length` is read once, before the loop, as the spec reads it.
  forEach: nat('forEach', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'forEach');
    const callback = callbackFor(h, a[0], 'forEach');
    const length = lengthOf(items);
    for (let i = 0; i < length; i++) {
      h.tick(2);
      if (hasIndex(items, i)) h.call(callback, a[1], [at(h, items, i), i, self]);
    }
    return undefined;
  }),
  map: nat('map', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'map');
    const callback = callbackFor(h, a[0], 'map');
    const length = lengthOf(items);
    h.checkArrayLength(length);
    const out: unknown[] = new Array(length);
    for (let i = 0; i < length; i++) {
      h.tick(2);
      if (hasIndex(items, i)) out[i] = h.call(callback, a[1], [at(h, items, i), i, self]);
    }
    return out;
  }),
  filter: nat('filter', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'filter');
    const callback = callbackFor(h, a[0], 'filter');
    const length = lengthOf(items);
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      h.tick(2);
      if (!hasIndex(items, i)) continue;
      const item = at(h, items, i);
      if (toBoolean(h.call(callback, a[1], [item, i, self]))) out.push(item);
    }
    return out;
  }),
  reduce: nat('reduce', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'reduce');
    const callback = callbackFor(h, a[0], 'reduce');
    const length = lengthOf(items);
    let index = 0;
    let accumulator: unknown;
    if (a.length >= 2) accumulator = a[1];
    else {
      while (index < length && !hasIndex(items, index)) index++;
      if (index >= length) h.throwError('TypeError', 'Reduce of empty array with no initial value');
      accumulator = at(h, items, index++);
    }
    for (; index < length; index++) {
      h.tick(2);
      if (!hasIndex(items, index)) continue;
      accumulator = h.call(callback, undefined, [accumulator, at(h, items, index), index, self]);
    }
    return accumulator;
  }),
  reduceRight: nat('reduceRight', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'reduceRight');
    const callback = callbackFor(h, a[0], 'reduceRight');
    let index = lengthOf(items) - 1;
    let accumulator: unknown;
    if (a.length >= 2) accumulator = a[1];
    else {
      while (index >= 0 && !hasIndex(items, index)) index--;
      if (index < 0) h.throwError('TypeError', 'Reduce of empty array with no initial value');
      accumulator = at(h, items, index--);
    }
    for (; index >= 0; index--) {
      h.tick(2);
      if (!hasIndex(items, index)) continue;
      accumulator = h.call(callback, undefined, [accumulator, at(h, items, index), index, self]);
    }
    return accumulator;
  }),
  some: nat('some', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'some');
    const callback = callbackFor(h, a[0], 'some');
    const length = lengthOf(items);
    for (let i = 0; i < length; i++) {
      h.tick(2);
      if (hasIndex(items, i) && toBoolean(h.call(callback, a[1], [at(h, items, i), i, self]))) return true;
    }
    return false;
  }),
  every: nat('every', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'every');
    const callback = callbackFor(h, a[0], 'every');
    const length = lengthOf(items);
    for (let i = 0; i < length; i++) {
      h.tick(2);
      if (hasIndex(items, i) && !toBoolean(h.call(callback, a[1], [at(h, items, i), i, self]))) return false;
    }
    return true;
  }),
  find: nat('find', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'find');
    const callback = callbackFor(h, a[0], 'find');
    const length = lengthOf(items);
    for (let i = 0; i < length; i++) {
      h.tick(2);
      const item = at(h, items, i);
      if (toBoolean(h.call(callback, a[1], [item, i, self]))) return item;
    }
    return undefined;
  }),
  findIndex: nat('findIndex', 1, (h, self, a) => {
    const items = arrayLike(h, self, 'findIndex');
    const callback = callbackFor(h, a[0], 'findIndex');
    const length = lengthOf(items);
    for (let i = 0; i < length; i++) {
      h.tick(2);
      if (toBoolean(h.call(callback, a[1], [at(h, items, i), i, self]))) return i;
    }
    return -1;
  }),
  sort: nat('sort', 1, (h, self, a) => {
    const items = requireArray(h, self, 'sort');
    const comparator = a[0];
    h.tick(items.length * 4);
    if (comparator === undefined) {
      items.sort((x, y) => {
        if (x === undefined) return y === undefined ? 0 : 1;
        if (y === undefined) return -1;
        const sx = toStringValue(x);
        const sy = toStringValue(y);
        return sx < sy ? -1 : sx > sy ? 1 : 0;
      });
      return items;
    }
    if (!h.isCallable(comparator)) {
      const primitive = !isReference(comparator);
      h.throwError(
        'TypeError',
        `The comparison function must be either a function or undefined: ${primitive ? toStringValue(comparator) : '#<Object>'}`,
        primitive || comparator instanceof InterpObject,
      );
    }
    items.sort((x, y) => {
      h.tick(2);
      const result = toNumber(h.call(comparator, undefined, [x, y]));
      return Number.isNaN(result) ? 0 : result;
    });
    return items;
  }),
  toString: nat('toString', 0, (h, self) => {
    // `Array.prototype.toString` calls `this.join` when that is callable and
    // is `Object.prototype.toString` otherwise; an `arguments` object has no
    // `join`, so it reads `[object Arguments]`.
    if (Array.isArray(self)) return toStringValue(self);
    if (self === null || self === undefined) {
      return h.throwError('TypeError', 'Cannot convert undefined or null to object');
    }
    const join = getMember(h, self, 'join');
    return h.isCallable(join) ? h.call(join, self, []) : `[object ${classTag(self)}]`;
  }),
});

// ---------------------------------------------------------------------------
// Remaining prototypes
// ---------------------------------------------------------------------------

/**
 * `thisNumberValue` first, then the host's own formatting: the radix, digit
 * and precision rules are V8's, and a bad argument is its RangeError.
 */
const numberProto = frozenObject('Number.prototype', {
  toString: nat('toString', 1, (h, self, a) => {
    const n = thisNumber(h, self, 'toString');
    const radix = a[0] === undefined ? 10 : toInteger(a[0]);
    if (radix < 2 || radix > 36) h.throwError('RangeError', 'toString() radix argument must be between 2 and 36');
    return n.toString(radix);
  }),
  toFixed: nat('toFixed', 1, (h, self, a) => {
    const n = thisNumber(h, self, 'toFixed');
    const digits = optionalInteger(a[0], 0);
    if (digits < 0 || digits > 100) h.throwError('RangeError', 'toFixed() digits argument must be between 0 and 100');
    return n.toFixed(digits);
  }),
  toPrecision: nat('toPrecision', 1, (h, self, a) => {
    const n = thisNumber(h, self, 'toPrecision');
    if (a[0] === undefined) return String(n);
    const precision = toInteger(a[0]);
    if (!Number.isFinite(n)) return String(n);
    if (precision < 1 || precision > 100) h.throwError('RangeError', 'toPrecision() argument must be between 1 and 100');
    return n.toPrecision(precision);
  }),
  toExponential: nat('toExponential', 1, (h, self, a) => {
    const n = thisNumber(h, self, 'toExponential');
    const digits = a[0] === undefined ? undefined : toInteger(a[0]);
    if (!Number.isFinite(n)) return String(n);
    if (digits !== undefined && (digits < 0 || digits > 100)) {
      h.throwError('RangeError', 'toExponential() argument must be between 0 and 100');
    }
    return n.toExponential(digits);
  }),
  valueOf: nat('valueOf', 0, (h, self) => thisNumber(h, self, 'valueOf')),
});

const booleanProto = frozenObject('Boolean.prototype', {
  toString: nat('toString', 0, (h, self) => (thisBoolean(h, self, 'toString') ? 'true' : 'false')),
  valueOf: nat('valueOf', 0, (h, self) => thisBoolean(h, self, 'valueOf')),
});

const objectProto = frozenObject('Object.prototype', {
  hasOwnProperty: nat('hasOwnProperty', 1, (h, self, a) => {
    if (self === null || self === undefined) {
      return h.throwError('TypeError', 'Cannot convert undefined or null to object');
    }
    return hasOwnProperty(self, modelledKey(a[0]));
  }),
  // The class tag, never the value's own `toString`: `Object.prototype
  // .toString.call([])` is `[object Array]`, and `.call({ toString() {} })`
  // is `[object Object]` without running anything.
  toString: nat('toString', 0, (h, self) => `[object ${classTag(self)}]`),
  valueOf: nat('valueOf', 0, (h, self) => {
    // ToObject: a primitive receiver comes back as its wrapper object, which
    // the model does not have.
    if (self === null || self === undefined) {
      return h.throwError('TypeError', 'Cannot convert undefined or null to object');
    }
    if (!isReference(self) && !(self instanceof Callable)) {
      refuse(`Object.prototype.valueOf on the ${typeof self} ${JSON.stringify(self)} returns a wrapper object, which the interpreter does not have`);
    }
    return self;
  }),
  propertyIsEnumerable: nat('propertyIsEnumerable', 1, (h, self, a) =>
    ownEnumerableKeys(h, self).includes(modelledKey(a[0])),
  ),
});

/**
 * CreateListFromArrayLike: what `apply` makes of an argument list. Every index
 * up to `length` is Got, so the list is dense - `Array.apply(null, Array(3))`
 * is three `undefined`s, not three holes - and the callee's `arguments`
 * object has every index in it.
 */
function listFromArrayLike(host: Host, value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return Array.from(value);
  if (value instanceof InterpArguments) return Array.from(toList(host, value));
  if (!isReference(value) && !(value instanceof Callable)) {
    return host.throwError('TypeError', 'CreateListFromArrayLike called on non-object');
  }
  const length = Math.max(0, toInteger(getMember(host, value, 'length')));
  host.checkArrayLength(length);
  const list: unknown[] = [];
  for (let i = 0; i < length; i++) list.push(getMember(host, value, i));
  return list;
}

const functionProto = frozenObject('Function.prototype', {
  call: nat('call', 1, (h, self, a) => h.call(self, a[0], a.slice(1))),
  apply: nat('apply', 2, (h, self, a) => h.call(self, a[0], listFromArrayLike(h, a[1]))),
  bind: nat('bind', 1, (h, self, a) => {
    if (!(self instanceof Callable)) return h.throwError('TypeError', 'Bind must be called on a function');
    return new BoundFunction(self, a[0], a.slice(1));
  }),
  toString: nat('toString', 0, (h, self) => {
    if (!(self instanceof Callable)) {
      return h.throwError('TypeError', "Function.prototype.toString requires that 'this' be a Function");
    }
    return toStringValue(self);
  }),
});

const regExpProto = frozenObject('RegExp.prototype', {
  test: nat('test', 1, (h, self, a) => {
    if (!(self instanceof InterpRegExp)) return incompatibleReceiver(h, 'RegExp.prototype.test', self);
    const subject = toStringValue(a[0]);
    return withHostRegExp(h, self, subject, (regex) => regex.test(subject));
  }),
  exec: nat('exec', 1, (h, self, a) => {
    if (!(self instanceof InterpRegExp)) return incompatibleReceiver(h, 'RegExp.prototype.exec', self);
    const subject = toStringValue(a[0]);
    return withHostRegExp(h, self, subject, (regex) => {
      const match = regex.exec(subject);
      return match === null ? null : matchToArray(match);
    });
  }),
  toString: nat('toString', 0, (h, self) => {
    // On anything else V8 reads `source` and `flags` off the receiver and
    // prints `/undefined/undefined`; nothing a decoder computes with.
    if (!(self instanceof InterpRegExp)) refuse('RegExp.prototype.toString on a non-RegExp receiver is not modelled');
    return toStringValue(self);
  }),
});

const errorProto = frozenObject('Error.prototype', {
  // Generic over any object, as the spec's is: it Gets `name` and `message`
  // from the receiver, so a plain object with both prints like an error.
  toString: nat('toString', 0, (h, self) => {
    if (self instanceof InterpError) return errorToString(self);
    if (!isReference(self) && !(self instanceof Callable)) return incompatibleReceiver(h, 'Error.prototype.toString', self);
    const name = getMember(h, self, 'name');
    const message = getMember(h, self, 'message');
    return errorToString(new InterpError('Error', name, message));
  }),
});

/**
 * A `Date` is a time value plus two ways of reading it, and only one of them is
 * a fact about the value. The UTC face (`getTime`, `toISOString`) is; the
 * local face (`getFullYear` ... `getSeconds`, `getTimezoneOffset`, `toString`) is
 * the host's time zone applied to it, which the run that matters need not
 * share. An earlier table answered the local getters with UTC arithmetic; a
 * decoder keyed on `getHours()` then decoded to a different string in every
 * zone but one.
 */
function localGetter(name: string): NativeFunction {
  return nat(name, 0, () => refuse(LOCAL_TIME));
}

function thisTimeValue(host: Host, value: unknown): number {
  if (value instanceof InterpDate) return value.time;
  return host.throwError('TypeError', 'this is not a Date object.');
}

const dateProto = frozenObject('Date.prototype', {
  getTime: nat('getTime', 0, (h, self) => thisTimeValue(h, self)),
  valueOf: nat('valueOf', 0, (h, self) => thisTimeValue(h, self)),
  getTimezoneOffset: localGetter('getTimezoneOffset'),
  getFullYear: localGetter('getFullYear'),
  getMonth: localGetter('getMonth'),
  getDate: localGetter('getDate'),
  getHours: localGetter('getHours'),
  getMinutes: localGetter('getMinutes'),
  getSeconds: localGetter('getSeconds'),
  toISOString: nat('toISOString', 0, (h, self) => {
    if (!(self instanceof InterpDate)) return incompatibleReceiver(h, 'Date.prototype.toISOString', self);
    if (Number.isNaN(self.time)) return h.throwError('RangeError', 'Invalid time value');
    return new Date(self.time).toISOString();
  }),
  toString: localGetter('toString'),
});

/**
 * The subset of the Date Time String Format (ES2023 §21.4.1.32) whose time
 * value is fixed by the spec: date-only forms are UTC, and a date-time is
 * pinned by an explicit `Z` or offset. A date-time with no offset is local
 * time, and any other spelling is whatever the host's fallback parser makes
 * of it - both are refused rather than parsed here.
 */
const FIXED_DATE_STRING =
  /^(?:[+-]\d{6}|\d{4})(?:-\d{2}(?:-\d{2})?)?(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function parseDateString(text: string): number {
  if (!FIXED_DATE_STRING.test(text)) {
    refuse(`parsing the date string ${JSON.stringify(text)} depends on the time zone or the host's date parser`);
  }
  return Date.parse(text);
}

// ---------------------------------------------------------------------------
// Constructors and namespaces
// ---------------------------------------------------------------------------

/**
 * `String(x)`, `Number(x)` and `Boolean(x)` convert; `new String(x)` makes a
 * wrapper object - `typeof` 'object', `==` but not `===` its primitive - and
 * the model has no such thing, so the constructor forms are refused.
 */
function noWrapper(name: string): NativeImpl {
  return () => refuse(`new ${name}() makes a wrapper object, which the interpreter's value model does not have`);
}

const stringConstructor = nat(
  'String',
  1,
  (h, _self, a) => (a.length === 0 ? '' : h.trackString(toStringValue(a[0]))),
  noWrapper('String'),
);
stringConstructor.props.set('prototype', stringProto);
stringConstructor.props.set(
  'fromCharCode',
  nat('fromCharCode', 1, (h, _self, a) => {
    h.tick(a.length);
    let out = '';
    for (const code of a) out += String.fromCharCode(toInteger(code));
    return h.trackString(out);
  }),
);
stringConstructor.props.set(
  'fromCodePoint',
  nat('fromCodePoint', 1, (h, _self, a) => {
    h.tick(a.length);
    let out = '';
    for (const code of a) {
      // The host applies the spec's checks - an integer in range - and its
      // RangeError names the number as given (`Invalid code point 1.5`); the
      // host is V8, so the wording is V8's.
      try {
        out += String.fromCodePoint(toNumber(code));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        h.throwError('RangeError', error.message);
      }
    }
    return h.trackString(out);
  }),
);
stringConstructor.props.set(
  'raw',
  nat('raw', 1, (h, _self, a) => {
    // ES2023 §22.1.2.4: the `raw` property of the first argument, read as an
    // array-like, with the remaining arguments spliced between its entries.
    if (a[0] === null || a[0] === undefined) {
      return h.throwError('TypeError', 'Cannot convert undefined or null to object');
    }
    const raw = getMember(h, a[0], 'raw');
    if (raw === null || raw === undefined) {
      return h.throwError('TypeError', 'Cannot convert undefined or null to object');
    }
    const length = Math.max(0, toInteger(getMember(h, raw, 'length')));
    let out = '';
    for (let i = 0; i < length; i++) {
      h.tick(1);
      out += toStringValue(getMember(h, raw, i));
      if (i + 1 < length && i + 1 < a.length) out += toStringValue(a[i + 1]);
    }
    return h.trackString(out);
  }),
);

const numberConstructor = nat(
  'Number',
  1,
  (_h, _self, a) => (a.length === 0 ? 0 : toNumber(a[0])),
  noWrapper('Number'),
);
const parseIntFn = nat('parseInt', 2, (_h, _self, a) =>
  Number.parseInt(toStringValue(a[0]), a[1] === undefined ? undefined : toInteger(a[1])),
);
const parseFloatFn = nat('parseFloat', 1, (_h, _self, a) => Number.parseFloat(toStringValue(a[0])));
numberConstructor.props.set('prototype', numberProto);
numberConstructor.props.set('parseInt', parseIntFn);
numberConstructor.props.set('parseFloat', parseFloatFn);
numberConstructor.props.set('isInteger', nat('isInteger', 1, (_h, _s, a) => Number.isInteger(a[0])));
numberConstructor.props.set('isFinite', nat('isFinite', 1, (_h, _s, a) => Number.isFinite(a[0])));
numberConstructor.props.set('isNaN', nat('isNaN', 1, (_h, _s, a) => Number.isNaN(a[0])));
numberConstructor.props.set(
  'isSafeInteger',
  nat('isSafeInteger', 1, (_h, _s, a) => Number.isSafeInteger(a[0])),
);
numberConstructor.props.set('MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER);
numberConstructor.props.set('MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER);
numberConstructor.props.set('MAX_VALUE', Number.MAX_VALUE);
numberConstructor.props.set('MIN_VALUE', Number.MIN_VALUE);
numberConstructor.props.set('EPSILON', Number.EPSILON);
numberConstructor.props.set('POSITIVE_INFINITY', Number.POSITIVE_INFINITY);
numberConstructor.props.set('NEGATIVE_INFINITY', Number.NEGATIVE_INFINITY);
numberConstructor.props.set('NaN', Number.NaN);

const booleanConstructor = nat(
  'Boolean',
  1,
  (_h, _self, a) => toBoolean(a[0]),
  noWrapper('Boolean'),
);
booleanConstructor.props.set('prototype', booleanProto);

function constructArray(host: Host, args: readonly unknown[]): unknown[] {
  if (args.length === 1 && typeof args[0] === 'number') {
    const length = args[0];
    if (!Number.isInteger(length) || length < 0) {
      host.throwError('RangeError', 'Invalid array length');
    }
    host.checkArrayLength(length);
    return new Array<unknown>(length);
  }
  return args.slice();
}

const arrayConstructor = nat(
  'Array',
  1,
  (h, _self, a) => constructArray(h, a),
  (h, _self, a) => constructArray(h, a),
);
arrayConstructor.props.set('prototype', arrayProto);
// `Array.prototype` is itself an array exotic object.
arrayConstructor.props.set('isArray', nat('isArray', 1, (_h, _s, a) => Array.isArray(a[0]) || a[0] === arrayProto));
arrayConstructor.props.set(
  'of',
  nat('of', 0, (_h, _s, a) => a.slice()),
);
arrayConstructor.props.set(
  'from',
  nat('from', 1, (h, _s, a) => {
    const source = a[0];
    let items: unknown[];
    // An iterable source is walked, so the result is dense: `Array.from([1, , 3])`
    // has `1 in` it. An array-like is read by index.
    if (Array.isArray(source)) {
      items = [];
      for (let i = 0; i < source.length; i++) items.push(source[i]);
    } else if (typeof source === 'string') items = [...source];
    else if (source instanceof InterpArguments) {
      items = [];
      const length = lengthOf(source);
      h.checkArrayLength(length);
      for (let i = 0; i < length; i++) items.push(getMember(h, source, i));
    } else if (source instanceof InterpObject) {
      // An array-like, read through Get: `length` and each index may be inherited.
      const length = Math.max(0, toInteger(getMember(h, source, 'length')));
      h.checkArrayLength(length);
      items = [];
      for (let i = 0; i < length; i++) items.push(getMember(h, source, i));
    } else if (source === null || source === undefined) {
      return h.throwError(
        'TypeError',
        `${source === null ? 'object null' : 'undefined'} is not iterable (cannot read property Symbol(Symbol.iterator))`,
      );
    } else {
      // A function, regexp, error or date is an array-like of length 0 to V8
      // - `Array.from(/x/)` is `[]` - while a number or boolean is a
      // TypeError. Neither is a shape a decoder needs; both are refused.
      return refuse('Array.from of a value that is neither an array, a string, an arguments object nor a plain object is not modelled');
    }
    if (a[1] === undefined) return items;
    if (!h.isCallable(a[1])) return h.throwError('TypeError', `${describeNonCallable(a[1])} is not a function`);
    return items.map((item, index) => {
      h.tick(2);
      return h.call(a[1], a[2], [item, index]);
    });
  }),
);

/** `Object(x)`: a new object for nothing, the object itself for an object, a wrapper - refused - for a primitive. */
const toObject: NativeImpl = (_h, _self, a) => {
  if (a[0] === undefined || a[0] === null) return new InterpObject(null);
  if (isReference(a[0]) || a[0] instanceof Callable) return a[0];
  return refuse(`Object(${JSON.stringify(a[0])}) makes a wrapper object, which the interpreter's value model does not have`);
};

const objectConstructor = nat('Object', 1, toObject, toObject);
objectConstructor.props.set('prototype', objectProto);
objectConstructor.props.set(
  'keys',
  nat('keys', 1, (h, _s, a) => {
    const keys = ownEnumerableKeys(h, a[0]);
    h.tick(keys.length);
    return keys as unknown[];
  }),
);
objectConstructor.props.set(
  'values',
  nat('values', 1, (h, _s, a) =>
    ownEnumerableKeys(h, a[0]).map((key) => {
      h.tick(1);
      return getMember(h, a[0], key);
    }),
  ),
);
objectConstructor.props.set(
  'entries',
  nat('entries', 1, (h, _s, a) =>
    ownEnumerableKeys(h, a[0]).map((key) => {
      h.tick(1);
      return [key, getMember(h, a[0], key)];
    }),
  ),
);
objectConstructor.props.set(
  'assign',
  nat('assign', 2, (h, _s, a) => {
    // ToObject(target): a TypeError for nothing, a wrapper - refused - for a primitive.
    if (a[0] === null || a[0] === undefined) h.throwError('TypeError', 'Cannot convert undefined or null to object');
    const target = toObject(h, undefined, [a[0]]);
    for (let i = 1; i < a.length; i++) {
      // A null or undefined source is skipped, not a TypeError.
      if (a[i] === null || a[i] === undefined) continue;
      for (const key of ownEnumerableKeys(h, a[i])) {
        h.tick(1);
        // [[Set]] with `throw` true: a target that will not take the write is
        // a TypeError whatever the caller's strictness.
        setMember(h, target, key, getMember(h, a[i], key), true);
      }
    }
    return target;
  }),
);
objectConstructor.props.set(
  'fromEntries',
  nat('fromEntries', 1, (h, _s, a) => {
    // The iterable is an array of arrays here: any other iterable - a
    // string, an arguments object, a Map - is a shape the model does not walk.
    if (!Array.isArray(a[0])) refuse('Object.fromEntries over anything but an array of pairs is not modelled');
    const object = new InterpObject(null);
    for (const entry of a[0]) {
      h.tick(1);
      if (!Array.isArray(entry)) {
        return h.throwError('TypeError', `Iterator value ${toStringValue(entry)} is not an entry object`);
      }
      object.props.set(modelledKey(entry[0]), entry[1]);
    }
    return object;
  }),
);
objectConstructor.props.set(
  'getOwnPropertyNames',
  nat('getOwnPropertyNames', 1, (h, _s, a) => ownPropertyNames(h, a[0]) as unknown[]),
);
objectConstructor.props.set(
  'freeze',
  nat('freeze', 1, (_h, _s, a) => {
    const target = a[0];
    if (target instanceof InterpObject || target instanceof Callable) {
      // A builtin is already immutable here; V8's is not, and freezing it
      // would only matter to a program that then writes it, which is refused.
      target.frozen = true;
      return target;
    }
    if (isReference(target)) {
      // A frozen array rejects `push`, an index write and a `length` write in
      // ways the host array underneath does not, so the model stops here.
      refuse('Object.freeze of an array, arguments object, regexp, error or date is not modelled');
    }
    return target;
  }),
);
objectConstructor.props.set(
  'create',
  nat('create', 2, (h, _s, a) => {
    // The second argument is a set of property descriptors - accessors,
    // non-writable and non-enumerable slots - that the model has no
    // properties for; `null` there is V8's TypeError, and is refused with the rest.
    if (a[1] !== undefined) refuse('Object.create with property descriptors is not modelled');
    const proto = a[0];
    if (proto === null) {
      const object = new InterpObject(null);
      object.bare = true;
      return object;
    }
    if (!(proto instanceof InterpObject)) {
      // A primitive is V8's TypeError. An array, function or regexp as a
      // prototype is legal there and has no place in a chain of plain objects
      // here, so it is refused rather than mistyped.
      if (!isReference(proto) && !(proto instanceof Callable)) {
        h.throwError('TypeError', `Object prototype may only be an Object or null: ${toStringValue(proto)}`);
      }
      refuse('Object.create with an array, function, regexp, error or date as the prototype is not modelled');
    }
    // `Object.create(Array.prototype)` inherits an exotic prototype's methods
    // onto a plain object, which then answers `push` with a TypeError here
    // and with a write there.
    if (proto.builtin !== null) refuse(`Object.create(${proto.builtin}) is not modelled`);
    return new InterpObject(proto);
  }),
);

function constructRegExp(host: Host, args: readonly unknown[]): InterpRegExp {
  const pattern = args[0];
  // `new RegExp(undefined)` is the empty pattern; `new RegExp(null)` is `/null/`.
  const source = pattern instanceof InterpRegExp ? pattern.source : pattern === undefined ? '' : toStringValue(pattern);
  const flags =
    args[1] === undefined
      ? pattern instanceof InterpRegExp
        ? pattern.flags
        : ''
      : toStringValue(args[1]);
  // V8 compiles a source of any length; the cap is a guard on host regex
  // compilation, so it refuses rather than throwing what the program could catch.
  if (source.length > 4096) refuse(`a regular expression source of ${source.length} characters exceeds the interpreter's limit of 4096`);
  try {
    return new InterpRegExp(source, flags);
  } catch (error) {
    if (error instanceof InterpreterRefusal) throw error;
    // The host is V8: its wording for the bad pattern or flag is the wording.
    return host.throwError('SyntaxError', error instanceof Error ? error.message : 'Invalid regular expression');
  }
}

const regExpConstructor = nat(
  'RegExp',
  2,
  // Called rather than constructed, `RegExp(re)` with no flags hands back
  // the very same object (ES2023 §22.2.4.1 step 2).
  (h, _self, a) => (a[0] instanceof InterpRegExp && a[1] === undefined ? a[0] : constructRegExp(h, a)),
  (h, _self, a) => constructRegExp(h, a),
);
regExpConstructor.props.set('prototype', regExpProto);

const CLOCK = 'the current time is a property of the run, not of the program';

const dateConstructor = nat(
  'Date',
  7,
  () => refuse(CLOCK),
  (_h, _self, a) => {
    if (a.length === 0) return refuse(CLOCK);
    if (a.length === 1) {
      const value = a[0];
      if (value instanceof InterpDate) return new InterpDate(value.time);
      const primitive = toPrimitive(value, 'default');
      const time = typeof primitive === 'string' ? parseDateString(primitive) : toNumber(primitive);
      // TimeClip: `new Date(1.5).getTime()` is 1, and out-of-range is NaN.
      return new InterpDate(new Date(time).getTime());
    }
    // `new Date(y, m, ...)` is local time.
    return refuse(LOCAL_TIME);
  },
);
dateConstructor.props.set('prototype', dateProto);
dateConstructor.props.set('now', nat('now', 0, () => refuse(CLOCK)));
dateConstructor.props.set(
  'parse',
  nat('parse', 1, (_h, _s, a) => parseDateString(toStringValue(a[0]))),
);
dateConstructor.props.set(
  'UTC',
  nat('UTC', 7, (_h, _s, a) => {
    // The host does the year mapping, the truncation and the NaN propagation.
    const parts = a.map((part) => toNumber(part));
    return parts.length === 0 ? Number.NaN : Date.UTC(parts[0]!, ...parts.slice(1));
  }),
);

function makeErrorConstructor(name: string): NativeFunction {
  const impl: NativeImpl = (_h, _self, a) => {
    // `new Error(message, { cause })` installs an own `cause`, which the
    // model has no slot for.
    if (a.length > 1) refuse(`${name} with an options argument is not modelled`);
    return new InterpError(name, name, a[0] === undefined ? '' : toStringValue(a[0]), a[0] !== undefined);
  };
  const constructor = nat(name, 1, impl, impl);
  constructor.props.set('prototype', errorProto);
  return constructor;
}

const errorConstructor = makeErrorConstructor('Error');
const typeErrorConstructor = makeErrorConstructor('TypeError');
const rangeErrorConstructor = makeErrorConstructor('RangeError');
const syntaxErrorConstructor = makeErrorConstructor('SyntaxError');
const referenceErrorConstructor = makeErrorConstructor('ReferenceError');
const uriErrorConstructor = makeErrorConstructor('URIError');
const evalErrorConstructor = makeErrorConstructor('EvalError');

const errorConstructors = new Set<NativeFunction>([
  errorConstructor,
  typeErrorConstructor,
  rangeErrorConstructor,
  syntaxErrorConstructor,
  referenceErrorConstructor,
  uriErrorConstructor,
  evalErrorConstructor,
]);

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

const MATH_UNARY = [
  'abs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'sign',
  'sqrt',
  'cbrt',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'fround',
  'clz32',
] as const;

const mathEntries: Record<string, unknown> = {
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  PI: Math.PI,
  SQRT1_2: Math.SQRT1_2,
  SQRT2: Math.SQRT2,
  min: nat('min', 2, (_h, _s, a) => Math.min(...a.map(toNumber))),
  max: nat('max', 2, (_h, _s, a) => Math.max(...a.map(toNumber))),
  pow: nat('pow', 2, (_h, _s, a) => Math.pow(toNumber(a[0]), toNumber(a[1]))),
  atan2: nat('atan2', 2, (_h, _s, a) => Math.atan2(toNumber(a[0]), toNumber(a[1]))),
  hypot: nat('hypot', 2, (_h, _s, a) => Math.hypot(...a.map(toNumber))),
  imul: nat('imul', 2, (_h, _s, a) => Math.imul(toInteger(a[0]), toInteger(a[1]))),
  // A seeded PRNG stood here once so that two runs agreed with each other.
  // They did; neither agreed with the program, whose draw is different every
  // time it runs - a string that depends on it has no build-time value.
  random: nat('random', 0, () => refuse('Math.random() draws a value the program itself cannot predict')),
};
for (const name of MATH_UNARY) {
  mathEntries[name] = nat(name, 1, (_h, _s, a) => Math[name](toNumber(a[0])));
}
const mathNamespace = frozenObject('Math', mathEntries);

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Host JSON output -> interpreter values. Nothing host-owned survives the trip.
 * A `"__proto__"` or `"constructor"` key parses to an own property in V8; the
 * model has no such property, so the text is refused rather than the key dropped.
 */
function fromHostJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromHostJson);
  const object = new InterpObject(null);
  for (const [key, item] of Object.entries(value)) object.props.set(modelledKey(key), fromHostJson(item));
  return object;
}

/** Thrown by `toHostJson` on a cycle; only `JSON.stringify` catches it. */
const CYCLE = Symbol('cycle');

/**
 * Interpreter values -> plain data host `JSON.stringify` understands.
 *
 * SerializeJSONProperty calls a `toJSON` it finds on the value first, own or
 * inherited, and what that returns is the program's business - so a value
 * carrying one is refused, as a user `toString` is. A `Date`'s own `toJSON`
 * is `toISOString`, or `null` for an invalid time.
 */
function toHostJson(host: Host, value: unknown, seen: Set<unknown>, depth: number): unknown {
  if (depth > 200) refuse('JSON.stringify of a value nested more than 200 levels deep is not modelled');
  if (value === null || typeof value !== 'object') {
    return value instanceof Callable ? undefined : value;
  }
  // Its enumerable properties are the host's to list, not this table's.
  if (value instanceof GlobalObject) refuse(builtinReflection('the global object'));
  if (seen.has(value)) throw CYCLE;
  if (hasUserProperty(value, 'toJSON')) {
    refuse('JSON.stringify of a value that defines its own toJSON() would run user code the serialisation does not model');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toHostJson(host, item, seen, depth + 1) ?? null);
    if (value instanceof InterpObject || value instanceof InterpArguments) {
      const out: Record<string, unknown> = {};
      for (const key of ownEnumerableKeys(host, value)) {
        const converted = toHostJson(host, getMember(host, value, key), seen, depth + 1);
        if (converted !== undefined) out[key] = converted;
      }
      return out;
    }
    if (value instanceof InterpDate) return Number.isNaN(value.time) ? null : new Date(value.time).toISOString();
    if (value instanceof InterpRegExp) return {};
    if (value instanceof InterpError) {
      // Nothing enumerable on a pristine error; a property the program
      // created is, and asking for the keys is what refuses it.
      ownEnumerableKeys(host, value);
      return {};
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

/** Whether the program put `key` on the value or on a prototype it made for it. */
function hasUserProperty(value: unknown, key: string): boolean {
  if (value instanceof InterpObject) {
    for (let o: InterpObject | null = value; o !== null; o = o.proto) if (o.props.has(key)) return true;
    return false;
  }
  if (Array.isArray(value)) return ownKey(value, key);
  if (value instanceof InterpArguments) return value.own.has(key);
  return false;
}

/**
 * InternalizeJSONProperty: the reviver walk, bottom-up, in own-key order, with
 * the holder as `this` and a returned `undefined` deleting the property.
 *
 * V8 passes a third argument - a context object carrying the value's source
 * text - that an older engine does not, and the text is not recoverable from
 * the host's parse. A reviver that can see it (a third parameter, a rest
 * parameter, `arguments`, a bound or native function) is refused; any other
 * interpreted function cannot observe the difference, and gets the two
 * arguments it declared.
 */
function revive(host: Host, holder: InterpObject | unknown[], key: string, reviver: unknown): unknown {
  const value = getMember(host, holder, key);
  if (Array.isArray(value)) {
    const length = value.length;
    for (let i = 0; i < length; i++) {
      host.tick(1);
      const element = revive(host, value, String(i), reviver);
      if (element === undefined) delete value[i];
      else value[i] = element;
    }
  } else if (value instanceof InterpObject) {
    for (const own of ownEnumerableKeys(host, value)) {
      host.tick(1);
      const element = revive(host, value, own, reviver);
      if (element === undefined) value.props.delete(own);
      else value.props.set(own, element);
    }
  }
  return host.call(reviver, holder, [key, value]);
}

const jsonNamespace = frozenObject('JSON', {
  parse: nat('parse', 2, (h, _s, a) => {
    const text = toStringValue(a[0]);
    h.tick(text.length >> 3);
    let parsed: unknown;
    try {
      parsed = fromHostJson(JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof InterpreterRefusal) throw error;
      return h.throwError('SyntaxError', error instanceof Error ? error.message : 'Invalid JSON');
    }
    if (!(a[1] instanceof Callable)) return parsed;
    if (a[1].canSeeArgument(2)) {
      refuse(
        "a JSON.parse reviver that can read a third argument would see V8's source-text context, which the model does not carry",
      );
    }
    const root = new InterpObject(null);
    root.props.set('', parsed);
    return revive(h, root, '', a[1]);
  }),
  stringify: nat('stringify', 3, (h, _s, a) => {
    // A replacer function is user code run per property; a replacer array
    // is a key whitelist. V8 ignores anything else in that position.
    if (h.isCallable(a[1]) || Array.isArray(a[1])) {
      refuse('JSON.stringify with a replacer is not modelled');
    }
    let plain: unknown;
    try {
      plain = toHostJson(h, a[0], new Set(), 0);
    } catch (error) {
      if (error !== CYCLE) throw error;
      // V8 goes on to name the object and the property that close the circle.
      return h.throwError('TypeError', 'Converting circular structure to JSON', false);
    }
    // Only a number or a string shapes the gap; an object in that position
    // would be read through a wrapper and anything else is ignored.
    const space = typeof a[2] === 'number' ? toInteger(a[2]) : typeof a[2] === 'string' ? a[2] : undefined;
    const out = JSON.stringify(plain, undefined, space);
    return out === undefined ? undefined : h.trackString(out);
  }),
});

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function uriFunction(name: string, impl: (input: string) => string): NativeFunction {
  return nat(name, 1, (h, _s, a) => {
    // Converted outside the `try`: a refusal raised by the conversion must not
    // come out the other side as a catchable URIError.
    const input = toStringValue(a[0]);
    let output: string;
    try {
      output = impl(input);
    } catch {
      return h.throwError('URIError', 'URI malformed');
    }
    return h.trackString(output);
  });
}

// ---------------------------------------------------------------------------
// The global table
// ---------------------------------------------------------------------------

/**
 * `Function` and an indirect `eval`, which compile one thing: the global-object
 * idiom. `Function('return this')()`, nested as obfuscator.io 0.x nests it,
 * and `(0, eval)('this')` evaluate to the sandbox global (`GlobalObject`);
 * any other source is a refusal, since running it is what this interpreter
 * exists not to do. The function `Function` builds is V8's `anonymous` of
 * length 0; a direct `eval` is refused by the interpreter before it gets
 * here, since the idiom's `this` there is the caller's.
 */
const FUNCTION_SOURCE_REFUSED =
  "the Function constructor compiles source the interpreter does not run; only the global-object idiom, `Function('return this')()`, is modelled";
const EVAL_SOURCE_REFUSED =
  "an indirect eval compiles source the interpreter does not run; only the global-object idiom, `(0, eval)('this')`, is modelled";

function compileIdiom(_host: Host, _thisArg: unknown, args: readonly unknown[]): unknown {
  const body = args.length === 0 ? '' : toStringValue(args[args.length - 1]);
  if (!isGlobalThisSource(body, 'function')) refuse(FUNCTION_SOURCE_REFUSED);
  return nat('anonymous', 0, idiomThis, () =>
    refuse("constructing the function `Function('return this')` builds binds a fresh instance where the idiom reads the global, which is not modelled"),
  );
}

/**
 * What the sloppy function `Function('return this')` returns: its receiver
 * when it has one, the global when it has none, and for a primitive receiver
 * the wrapper object the model does not have.
 */
function idiomThis(host: Host, thisArg: unknown): unknown {
  if (thisArg === undefined || thisArg === null) return host.globalObject();
  if (isReference(thisArg) || thisArg instanceof Callable) return thisArg;
  return refuse(
    `the function \`Function('return this')\` builds, called on the ${typeof thisArg} ${JSON.stringify(thisArg)}, sees it boxed into a wrapper object, which the interpreter does not have`,
  );
}

const functionConstructor = nat('Function', 1, compileIdiom, compileIdiom);
functionConstructor.props.set('prototype', functionProto);

export const evalFunction = nat('eval', 1, (host, _thisArg, args) => {
  const source = args[0];
  if (typeof source !== 'string') return source;
  if (!isGlobalThisSource(source, 'program')) refuse(EVAL_SOURCE_REFUSED);
  return host.globalObject();
});

/**
 * Every name an interpreted program can resolve without declaring it.
 *
 * The table is exhaustive by construction: `globalThis`, `window`, `self`,
 * `global`, `document`, `fetch`, `XMLHttpRequest`, `WebSocket`, `require`,
 * `process`, `import`, `Proxy`, `Reflect`, `WebAssembly` and the timers are
 * absent, so they resolve to a ReferenceError rather than to anything at
 * all. `Function` and `eval` are present and compile only the global-object
 * idiom; see `compileIdiom`.
 */
const GLOBALS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['String', stringConstructor],
  ['Number', numberConstructor],
  ['Boolean', booleanConstructor],
  ['Array', arrayConstructor],
  ['Object', objectConstructor],
  ['RegExp', regExpConstructor],
  ['Date', dateConstructor],
  ['Math', mathNamespace],
  ['JSON', jsonNamespace],
  ['Error', errorConstructor],
  ['TypeError', typeErrorConstructor],
  ['RangeError', rangeErrorConstructor],
  ['SyntaxError', syntaxErrorConstructor],
  ['ReferenceError', referenceErrorConstructor],
  ['URIError', uriErrorConstructor],
  ['EvalError', evalErrorConstructor],
  ['parseInt', parseIntFn],
  ['parseFloat', parseFloatFn],
  ['isNaN', nat('isNaN', 1, (_h, _s, a) => Number.isNaN(toNumber(a[0])))],
  ['isFinite', nat('isFinite', 1, (_h, _s, a) => Number.isFinite(toNumber(a[0])))],
  ['atob', nat('atob', 1, (h, _s, a) => decodeBase64(h, toStringValue(a[0])))],
  ['btoa', nat('btoa', 1, (h, _s, a) => encodeBase64(h, toStringValue(a[0])))],
  ['encodeURIComponent', uriFunction('encodeURIComponent', encodeURIComponent)],
  ['decodeURIComponent', uriFunction('decodeURIComponent', decodeURIComponent)],
  ['encodeURI', uriFunction('encodeURI', encodeURI)],
  ['decodeURI', uriFunction('decodeURI', decodeURI)],
  ['escape', uriFunction('escape', escape)],
  ['unescape', uriFunction('unescape', unescape)],
  ['Function', functionConstructor],
  ['eval', evalFunction],
]);

/** The names a slice may reference for free. Mirrors `GLOBALS`. */
export function globalNames(): string[] {
  return [...GLOBALS.keys()];
}

export function globalEntries(): Iterable<readonly [string, unknown]> {
  return GLOBALS;
}

// ---------------------------------------------------------------------------
// Crossing the boundary
// ---------------------------------------------------------------------------

/**
 * Convert an interpreter value into plain host data.
 *
 * Every container is rebuilt, so a caller that mutates the result cannot reach
 * back into the interpreter's heap. Functions become `undefined`: handing one out
 * would hand out a live closure over interpreter state.
 */
export function externalize(value: unknown, seen = new Map<unknown, unknown>(), depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value instanceof Callable ? undefined : value;
  }
  // The sandbox global is the interpreter's realm; like a function, it is not data.
  if (value instanceof GlobalObject) return undefined;
  if (depth > 100) return undefined;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(externalize(item, seen, depth + 1));
    // A match result's `index`, `input` and `groups`, and whatever the
    // program hung on the array, go with it.
    for (const key of Object.keys(value)) {
      if (toIndex(key) < 0) (copy as unknown as Record<string, unknown>)[key] = externalize((value as unknown as Record<string, unknown>)[key], seen, depth + 1);
    }
    return copy;
  }
  if (value instanceof InterpObject) {
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, item] of value.props) copy[key] = externalize(item, seen, depth + 1);
    return copy;
  }
  if (value instanceof InterpArguments) {
    // Its enumerable face: the indices and whatever the program added.
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (let i = 0; i < value.slots.length; i++) {
      const slot = value.slots[i];
      if (slot !== undefined) copy[i] = externalize(slot.value, seen, depth + 1);
    }
    for (const [key, item] of value.own) {
      if (!value.hidden.has(key)) copy[key] = externalize(item, seen, depth + 1);
    }
    return copy;
  }
  if (value instanceof InterpRegExp) return new RegExp(value.source, value.flags);
  if (value instanceof InterpDate) return new Date(value.time);
  if (value instanceof InterpError) {
    // As the program would print it: `name`/`message` converted with the
    // rule `Error.prototype.toString` uses, a refusal on a user `toString`
    // included - a value that cannot be converted cannot be handed out either.
    const error = new Error(value.message === undefined ? '' : String(value.message));
    error.name = value.ownName ? String(value.name) : value.protoName;
    return error;
  }
  return undefined;
}

/**
 * Convert host data into interpreter values. Callables are rejected outright -
 * accepting one would let a caller inject a host function into the interpreted
 * heap, which is the escape hatch in reverse.
 */
export function internalize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') {
      throw new TypeError('Cannot pass a host function into the interpreter');
    }
    if (typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError(`Cannot pass a ${typeof value} into the interpreter`);
    }
    return value;
  }
  if (depth > 100) throw new RangeError('Argument nests too deeply for the interpreter');

  if (Array.isArray(value)) return value.map((item) => internalize(item, depth + 1));
  if (value instanceof RegExp) return new InterpRegExp(value.source, value.flags);
  if (value instanceof Date) return new InterpDate(value.getTime());
  const object = new InterpObject(null);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (BLOCKED_KEYS.has(key)) throw new TypeError(`Cannot pass a '${key}' property into the interpreter`);
    object.props.set(key, internalize(item, depth + 1));
  }
  return object;
}

// ---------------------------------------------------------------------------
// The whitelist, as data
// ---------------------------------------------------------------------------

/**
 * Every table the interpreter answers from, by the name its refusals use,
 * with the keys it holds. Read straight off the tables, so it cannot drift
 * from them: an entry that gains a key here has gained it in the model, and
 * `test/evaluator-whitelist.test.ts` fails until that key has a V8 probe.
 */
export function whitelist(): ReadonlyMap<string, readonly string[]> {
  const tables = new Map<string, readonly string[]>();
  tables.set('globals', [...GLOBALS.keys()]);
  for (const table of [
    stringProto,
    arrayProto,
    numberProto,
    booleanProto,
    objectProto,
    functionProto,
    regExpProto,
    errorProto,
    dateProto,
    mathNamespace,
    jsonNamespace,
  ]) {
    tables.set(table.builtin!, [...table.props.keys()]);
  }
  for (const constructor of [
    stringConstructor,
    numberConstructor,
    booleanConstructor,
    arrayConstructor,
    objectConstructor,
    regExpConstructor,
    dateConstructor,
  ]) {
    tables.set(constructor.name, [...constructor.props.keys()].filter((key) => key !== 'prototype'));
  }
  tables.set('RegExp accessors', [...REGEXP_ACCESSORS]);
  return tables;
}

export { arrayProto, functionProto, objectProto, stringProto };
