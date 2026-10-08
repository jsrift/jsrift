import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import {
  createInterpreter,
  InterpreterRefusal,
  UnsupportedSyntaxError,
} from '../src/analysis/evaluator/interpreter.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The interpreter's vocabulary, closed on the language side the way the
 * builtin tables are closed on the library side.
 *
 * Round five closed the builtins: every key is V8-exact or a named refusal.
 * This round applies the same rule to syntax. The vocabulary is the list of
 * node types and operators in `checkVocabulary` (interpreter.ts); everything
 * else refuses when the interpreter is built, before a single node runs, so a
 * `class` in a branch the probes never take still refuses. Inside the
 * vocabulary the semantics are exact, and each shape below was reproduced as
 * the interpreter silently computing a value V8 does not:
 *
 *   X1  an assignment evaluated its value before its target reference, so
 *       `a[i++] = i` stored 0 and `o[k] = (k = 'b', 1)` wrote under 'b';
 *   X2  `typeof x` in x's temporal dead zone answered 'undefined';
 *   X3  a sloppy-mode write to a named function expression's own name threw
 *       the TypeError only strict code throws;
 *   X4  a function declaration in a block was block-scoped where sloppy code
 *       also var-hoists it (Annex B.3.3);
 *   X5  four error messages worded by the model were marked as V8's;
 *   X6  a concise method constructed, `instanceof` ignored a bound function's
 *       target and a non-object `prototype`, `Object.create` dropped its
 *       descriptors, an error's assigned `name` did not enumerate, and an
 *       array's own `join` was not consulted by its `toString`.
 *
 * Every expected value is computed by the V8 this test runs on. The decoders
 * in the last block are gated on the same shapes and run through the whole
 * pipeline at every preset; input and output execute in a realm holding only
 * `log`, and their traces must match.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`;
  return String(value);
}

/** Run in a realm holding nothing but `log`, and record everything observable. */
function execute(code: string, timeout = 2_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

/** Deobfuscate and prove the output does what the input does. */
async function expectSameBehaviour(source: string, options: DeobfuscateOptions = {}): Promise<string> {
  const result = await deobfuscate(source, { preset: 'balanced', ...options });
  const before = execute(source);
  const after = execute(result.code);
  expect(after).toBe(before);
  return result.code;
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programPath(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source, {});
  let found: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  if (!found) throw new Error('no Program path');
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], options: Parameters<typeof resolveConfig>[0] = {}) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
}

/** Run a function body in the interpreter, as a sloppy script, and hand back what it returns. */
function interpret(body: string, options: { strict?: boolean; module?: boolean } = {}): unknown {
  const source = `var __result = (function () {\n${body}\n})();`;
  const statements = parse(source, { sourceType: 'script' }).program.body;
  return createInterpreter(statements, { source, ...options }).read('__result');
}

/** The same body, run by the V8 this test runs on, in a bare realm. */
function v8(body: string): unknown {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, vm.createContext({}));
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item === undefined ? '<undefined>' : typeof item === 'number' && !Number.isFinite(item) ? String(item) : item,
  );
}

/** V8's answer as data: `undefined` inside arrays survives the comparison as a marker. */
function expectSameAsV8(body: string): void {
  let expected: unknown;
  try {
    expected = v8(body);
  } catch (error) {
    throw new Error(`the probe must not throw under V8, and it did: ${(error as Error).message}\n${body}`);
  }
  const actual = interpret(body);
  expect(actual, `${body}\n  interpreter: ${show(actual)}\n  V8:          ${show(expected)}`).toEqual(expected);
}

/** V8 computes a value for the body; the interpreter refuses it. */
function expectRefusal(body: string): void {
  let error: unknown;
  try {
    v8(body);
  } catch (caught) {
    error = caught;
  }
  expect(error, `the probe must not throw under V8, and it did:\n${body}`).toBeUndefined();
  expect(() => interpret(body), body).toThrow(InterpreterRefusal);
}

/** The expression's value, or the name and message of what it throws. */
const attempt = (expression: string): string =>
  `(function () { try { return ${expression}; } catch (e) { return e.name + ': ' + e.message; } })()`;

// ---------------------------------------------------------------------------
// X1. Assignment evaluates the target reference first
// ---------------------------------------------------------------------------

describe('assignment order', () => {
  it('evaluates the target reference, then the value (the RC4 swap idiom)', () => {
    expectSameAsV8("var o = []; var a = {}; a[(o.push('f'), 'k')] = (o.push('g'), 1); return o;");
    expectSameAsV8("var k = 'a'; var o = {}; o[k] = (k = 'b', 1); return [o.a, o.b, k];");
    expectSameAsV8('var i = 0; var a = []; a[i++] = i; return [a[0], a.length, i];');
    expectSameAsV8('var i = 0; var a = []; a[i] = i++; return [a[0], a[1], i];');
    expectSameAsV8('var a = [7, 8, 9]; var i = 0; a[i++] = a[i]; return [a, i];');
    expectSameAsV8('var o = {}; var p = o; o.p = (o = { q: 1 }, 5); return [p.p, o.p, o.q];');
    expectSameAsV8("var log = []; var a = {}, b = {}; a[(log.push(1), 'x')] = b[(log.push(2), 'y')] = (log.push(3), 0); return [log, a.x, b.y];");
    expectSameAsV8('var s = [0, 1, 2, 3]; var i = 1, j = 2; var t = s[i]; s[i] = s[j]; s[j] = t; return s;');
    expectSameAsV8('var s = [0, 1, 2, 3]; var i = 1, j = 2; [s[i], s[j]] = [s[j], s[i]]; return s;');
    expectSameAsV8('var i = 0; var a = [10]; a[i++] += i; return [a[0], i];');
    expectSameAsV8("var k = 'a'; var o = {}; o[k] ||= (k = 'b', 1); return [o.a, o.b];");
    expectSameAsV8('var x = 0; x = (x = 2, 1); return x;');
    expect(interpret('var i = 0; var a = []; a[i++] = i; return a[0];')).toBe(1);
  });

  it('reaches the TypeError for a missing base only after the value ran', () => {
    expectSameAsV8("var o = []; try { var a = null; a[(o.push('k'), 'x')] = (o.push('v'), 1); } catch (e) { o.push(e.name); } return o;");
    expectSameAsV8("var o = []; try { null.x = (o.push('v'), 1); } catch (e) { o.push(e.name); } return o;");
    expectSameAsV8("var o = []; var u; try { u[(o.push('k'), 0)] = (o.push('v'), 1); } catch (e) { o.push(e.name); } return o;");
    expectSameAsV8("'use strict'; var o = []; try { undeclaredZ = (o.push('v'), 1); } catch (e) { o.push(e.name); } return o;");
  });

  it('evaluates the loop target of for...in per iteration, before the write', () => {
    expectSameAsV8("var o = { a: 1 }; var t = {}; var k = 'q'; for (t[(k = 'z', 'p')] in o) {} return [t.p, t.z, k];");
  });
});

// ---------------------------------------------------------------------------
// X2. The temporal dead zone
// ---------------------------------------------------------------------------

describe('the temporal dead zone', () => {
  it('throws on typeof, on a compound assignment and on an update, catchably', () => {
    expectSameAsV8("try { typeof x; return 'no'; } catch (e) { return e.name + ': ' + e.message; } let x;");
    expectSameAsV8("try { { typeof y; let y = 1; } return 'no'; } catch (e) { return e.name + ': ' + e.message; }");
    expectSameAsV8("try { z += 1; return 'no'; } catch (e) { return e.name + ': ' + e.message; } let z;");
    expectSameAsV8("try { w++; return 'no'; } catch (e) { return e.name + ': ' + e.message; } let w;");
    expectSameAsV8("try { q ||= 1; return 'no'; } catch (e) { return e.name + ': ' + e.message; } let q;");
    expectSameAsV8("try { u = 2; return 'no'; } catch (e) { return e.name + ': ' + e.message; } let u;");
    expectSameAsV8("try { c; return 'no'; } catch (e) { return e.name + ': ' + e.message; } const c = 1;");
    expectSameAsV8("function f() { return typeof y; } try { f(); return 'no'; } catch (e) { return e.name; } let y = 1;");
    expectSameAsV8("let a = (function () { try { return typeof a; } catch (e) { return e.name; } })(); return a;");
    expectSameAsV8("switch (1) { case 0: let s = 1; case 1: try { return typeof s; } catch (e) { return e.name; } }");
    expectSameAsV8("try { for (let i = (typeof i, 0); i < 1; i++) {} return 'no'; } catch (e) { return e.name; }");
    expect(() => interpret('typeof x; let x;')).toThrow(/Cannot access 'x' before initialization/);
  });

  it('still answers undefined for an undeclared name, and the type once initialised', () => {
    expectSameAsV8('return [typeof neverDeclaredAnywhere, (function () { let v = 1; return typeof v; })()];');
    expect(interpret('return typeof neverDeclaredAnywhere;')).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// X3. A named function expression's own name
// ---------------------------------------------------------------------------

describe('a write to a named function expression’s name', () => {
  it('is silently ignored by sloppy code and a TypeError in strict code', () => {
    expectSameAsV8('return (function f() { f = 1; return typeof f; })();');
    expectSameAsV8("return (function f() { 'use strict'; try { f = 1; return typeof f; } catch (e) { return e.name + ': ' + e.message; } })();");
    expectSameAsV8('return (function f() { var r = f++; return [typeof f, r]; })();');
    expectSameAsV8("return (function f() { 'use strict'; try { f++; return 'no'; } catch (e) { return e.name + ': ' + e.message; } })();");
    expectSameAsV8('return (function f() { var r = (f ||= 1); return [typeof f, typeof r]; })();');
    expectSameAsV8('return (function f() { var r = (f ??= 1); return [typeof f, typeof r]; })();');
    expectSameAsV8('return (function f() { var f = 1; return typeof f; })();');
    expectSameAsV8('return (function f() { return (function () { f = 2; return typeof f; })(); })();');
    expect(interpret('return (function f() { f = 1; return typeof f; })();')).toBe('function');
  });

  it('leaves a const a TypeError whatever the mode', () => {
    expectSameAsV8("const c = 1; try { c = 2; return 'no'; } catch (e) { return e.name + ': ' + e.message; }");
    expectSameAsV8("const c = 1; try { c++; return 'no'; } catch (e) { return e.name + ': ' + e.message; }");
  });
});

// ---------------------------------------------------------------------------
// X4. Function declarations in blocks
// ---------------------------------------------------------------------------

describe('a function declaration in a block', () => {
  it('is refused in sloppy code, where Annex B also var-hoists it', () => {
    for (const body of [
      "if (true) { function f() { return 1; } } return typeof f;",
      "{ function g() { return 1; } } return typeof g;",
      'if (true) function h() {} return typeof h;',
      'l: function k() {} return typeof k;',
      'switch (1) { case 1: function s() {} } return typeof s;',
      "try { throw 1; } catch (e) { function c() {} } return typeof c;",
      "while (false) { function w() {} } return typeof w;",
      'var f = 0; { function f() { return 1; } } return f ? 1 : 0;',
    ]) {
      expectRefusal(body);
      expect(() => interpret(body), body).toThrow(UnsupportedSyntaxError);
      expect(() => interpret(body), body).toThrow(/Annex B/);
    }
  });

  it('is a plain block-scoped binding in strict code', () => {
    expectSameAsV8("'use strict'; { function g() { return 1; } } return typeof g;");
    expectSameAsV8("'use strict'; var r = []; { function g() { return 1; } r.push(g()); } return r;");
    expectSameAsV8("'use strict'; switch (1) { case 1: function s() { return 2; } return s(); }");
    expect(interpret("'use strict'; { function g() { return 1; } } return typeof g;")).toBe('undefined');
  });

  it('is unaffected at the top of a function or program body', () => {
    expectSameAsV8('return [typeof f, f()]; function f() { return 1; }');
    const statements = parse('function top() { return 1; } var _0xr = top();', { sourceType: 'script' }).program.body;
    expect(createInterpreter(statements).read('_0xr')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// X5. Error messages: V8's, or refused
// ---------------------------------------------------------------------------

describe('an error message the interpreter worded', () => {
  it('reads exactly where it is V8’s', () => {
    expectSameAsV8(`return [${attempt('new (Math.max)()')}, (function () { var m = Math.max; return ${attempt('new m()')}; })(), (function () { var o = { a: () => 1 }; return ${attempt('new o.a()')}; })(), (function () { var a = () => 1; return ${attempt('new a()')}; })(), ${attempt('new (() => 1)()')}, ${attempt('new Math.max()')}];`);
    expectSameAsV8(`return [${attempt("String.prototype.trim.call(null)")}, ${attempt("String.prototype.charAt.call(undefined, 0)")}, ${attempt("String.prototype.split.call(null, '')")}, ${attempt("String.prototype.indexOf.call(undefined, 'a')")}];`);
    expectSameAsV8(`return [${attempt('String.fromCodePoint(1.5)')}, ${attempt('String.fromCodePoint(-1)')}, ${attempt('String.fromCodePoint(1114112)')}, ${attempt("String.fromCodePoint('1.5')")}, String.fromCodePoint(97, '98')];`);
    expectSameAsV8(`return [${attempt('(1)()')}, ${attempt('(0x10)()')}, (function () { var f = 1; return ${attempt('f()')}; })(), (function () { var o = {}; return ${attempt('o.m()')}; })()];`);
    expectSameAsV8(`function P() {} P.prototype = 5; var Q = function () {}; Q.prototype = 'abc'; return [${attempt('({}) instanceof P')}, ${attempt('({}) instanceof Q')}, ${attempt('({}) instanceof parseInt')}, ${attempt('({}) instanceof (() => 1)')}, ${attempt('1 instanceof (() => 1)')}];`);
    expect(interpret("var m = Math.max; try { new m(); } catch (e) { return e.message; }")).toBe('m is not a constructor');
  });

  it('refuses to be read where V8 renders source text the model does not keep', () => {
    expectRefusal("try { var { a } = null; } catch (e) { return e.message; }");
    expectRefusal("try { (function ({ a }) {})(); } catch (e) { return e.message; }");
    expectRefusal("try { var {} = undefined; } catch (e) { return e.message; }");
    expectRefusal("try { 'abc'(); } catch (e) { return e.message; }");
    expectRefusal("var a = { b: { c: 1 } }; try { new a.b.c(); } catch (e) { return e.message; }");
    expectRefusal("var o = { m() {} }; try { new o['m'](); } catch (e) { return e.message; }");
    expectRefusal("try { new (5)(); } catch (e) { return e.message; }");
    expectRefusal("var o = {}; var k = 'm'; try { o[k](); } catch (e) { return e.message; }");
    // The name is exact either way, and the throw is caught either way.
    expectSameAsV8("try { var { a } = null; } catch (e) { return e.name; }");
    expectSameAsV8("try { 'abc'(); return 'no'; } catch (e) { return e instanceof TypeError; }");
  });

  it('is a refusal, not a catchable throw, where the interpreter merely ran out of room', () => {
    // V8 compiles a 5000-character source and matches a long subject; the
    // interpreter's caps on both are guards on the host regex engine, and a
    // program that catches them would go on computing with a value V8 never
    // produces.
    expectRefusal("try { new RegExp('a'.repeat(5000)); return 'ok'; } catch (e) { return 'caught'; }");
    const source = "var __result = (function () { try { return /x/.test('a'.repeat(20)) ? 'yes' : 'no'; } catch (e) { return 'caught'; } })();";
    const statements = parse(source, { sourceType: 'script' }).program.body;
    expect(() => createInterpreter(statements, { source, maxRegexInput: 10 })).toThrow(InterpreterRefusal);
    expect(createInterpreter(statements, { source, maxRegexInput: 100 }).read('__result')).toBe('no');
  });

  it('keeps a user error exact and its stack refused', () => {
    expectSameAsV8("try { throw new Error('x'); } catch (e) { return [e.message, e.name, String(e)]; }");
    expectSameAsV8("try { throw new TypeError('y'); } catch (e) { return e.name + ': ' + e.message; }");
    expectRefusal("try { throw new Error('x'); } catch (e) { return typeof e.stack; }");
    expectRefusal('try { null.x; } catch (e) { return typeof e.stack; }');
  });
});

// ---------------------------------------------------------------------------
// X6. Shapes outside the vocabulary refuse rather than answer wrongly
// ---------------------------------------------------------------------------

describe('a concise method', () => {
  it('has no [[Construct]] and no prototype', () => {
    expectSameAsV8(`var o = { m() {} }; var m = o.m; return [${attempt('new o.m()')}, ${attempt('new m()')}, o.m.prototype, 'prototype' in o.m, o.m.hasOwnProperty('prototype'), typeof o.m, o.m.name, o.m.length];`);
    expectSameAsV8("var o = { v: 3, m(a) { return [this.v, arguments.length, a]; } }; return o.m(1, 2);");
    expectSameAsV8("var o = { ['c' + 'k']() { return 1; } }; return [o.ck(), o.ck.name, o.ck.prototype];");
    expect(interpret("var o = { m() {} }; try { new o.m(); return 'constructed'; } catch (e) { return e.message; }")).toBe(
      'o.m is not a constructor',
    );
  });
});

describe('instanceof', () => {
  it('follows a bound function to its target', () => {
    expectSameAsV8('function P() {} var B = P.bind(null); return [new P() instanceof B, new P() instanceof P.bind(null).bind(null), ({}) instanceof B];');
    expectSameAsV8('var B = Array.bind(null); return [[] instanceof B, ({}) instanceof B, [] instanceof Object.bind(null)];');
    expect(interpret('function P() {} return new P() instanceof P.bind(null);')).toBe(true);
  });

  it('throws V8’s TypeError for a non-object prototype, after answering a primitive left', () => {
    expectSameAsV8(`function P() {} P.prototype = null; var Q = function () {}; Q.prototype = true; return [${attempt('({}) instanceof P')}, ${attempt('({}) instanceof Q')}, ${attempt('[] instanceof P')}, 1 instanceof P, 'a' instanceof Q, null instanceof P, ${attempt('({}) instanceof Math.max')}];`);
  });

  it('answers the builtin constructors by kind', () => {
    expectSameAsV8("return [({}) instanceof String, 'a' instanceof String, [] instanceof String, ({}) instanceof Number, 5 instanceof Number, true instanceof Boolean, new TypeError('m') instanceof TypeError, new TypeError('m') instanceof RangeError, new Error('m') instanceof TypeError, new TypeError('m') instanceof Error];");
    expectSameAsV8('function P() {} P.prototype = [1]; var Q = function () {}; Q.prototype = function () {}; return [({}) instanceof P, [] instanceof P, ({}) instanceof Q, (function () {}) instanceof Q];');
    expectSameAsV8('function P() {} P.prototype = Object.create(null); var o = Object.create(P.prototype); return [o instanceof P, ({}) instanceof P];');
  });

  it('refuses a user function whose prototype is a builtin', () => {
    expectRefusal('function P() {} P.prototype = Object.prototype; return [] instanceof P;');
    expectRefusal('function P() {} P.prototype = Array.prototype; return [] instanceof P;');
    expectRefusal('function P() {} P.prototype = RegExp.prototype; return /x/ instanceof P;');
    expectRefusal('return TypeError.prototype === Error.prototype;');
  });
});

describe('Object.create', () => {
  it('refuses property descriptors rather than dropping them', () => {
    expectRefusal('return Object.create({}, { v: { value: 1 } }).v;');
    expectRefusal('return Object.keys(Object.create(null, { v: { value: 1, enumerable: true } }));');
    expectRefusal('return Object.create({}, { g: { get: function () { return 7; } } }).g;');
    expectSameAsV8('return Object.keys(Object.create({}, undefined));');
    expect(() => interpret('return Object.create({}, null);')).toThrow(InterpreterRefusal);
  });
});

describe('an error’s own properties', () => {
  it('are refused to enumeration once the program has created one', () => {
    expectRefusal("var e = new Error('m'); e.name = 'X'; return Object.keys(e);");
    expectRefusal("var e = new Error('m'); e.name = 'X'; return JSON.stringify(e);");
    expectRefusal("var e = new Error('m'); e.name = 'X'; return e.propertyIsEnumerable('name');");
    expectRefusal("var e = new Error('m'); e.name = 'X'; var k = []; for (var x in e) k.push(x); return k;");
    expectRefusal("var e = new Error('m'); e.name = 'X'; return Object.keys(Object.assign({}, e));");
    expectRefusal("var e = new Error('m'); e.name = 'X'; return Object.keys({ ...e });");
    expectRefusal("var e = new Error('m'); delete e.message; e.message = 'n'; return Object.keys(e);");
    expectRefusal("var e = new Error(); e.message = 'n'; return Object.keys(e);");
  });

  it('enumerate exactly otherwise: nothing, and the constructor’s own message stays hidden', () => {
    expectSameAsV8("var e = new Error('m'); e.message = 'z'; return [Object.keys(e), JSON.stringify(e), e.propertyIsEnumerable('message')];");
    expectSameAsV8("return [Object.keys(new Error('m')), Object.keys(new Error()), JSON.stringify(new TypeError('t'))];");
    expectSameAsV8("var e = new Error('m'); e.name = 'X'; delete e.name; return [Object.keys(e), e.name];");
    expectSameAsV8("var e = new Error('m'); e.name = 'X'; return [e.hasOwnProperty('name'), e.hasOwnProperty('message'), 'name' in e, e.name, String(e)];");
  });
});

describe('an array with its own join', () => {
  it('is refused where Array.prototype.toString would call it', () => {
    expectRefusal("var a = [1, 2]; a.join = function () { return 'x'; }; return String(a);");
    expectRefusal("var a = [1, 2]; a.join = function () { return 'x'; }; return a.toString();");
    expectRefusal("var a = [1, 2]; a.join = function () { return 'x'; }; return '' + a;");
    expectRefusal("var a = [1, 2]; a.join = function () { return 'x'; }; return String([0, a]);");
    expectRefusal("var a = [1, 2]; a.join = function () { return 'x'; }; return [0, a].join('-');");
    expectRefusal('var a = [1, 2]; a.join = 5; return String(a);');
    expectRefusal("var a = [1, 2]; a['join'] = function () { return 'x'; }; return `${a}`;");
  });

  it('still joins through Array.prototype.join, and again once the own join is gone', () => {
    expectSameAsV8("var a = [1, 2]; a.join = function () { return 'x'; }; return [Array.prototype.join.call(a), a.length];");
    expectSameAsV8("var a = [1, 2]; a.join = function () { return 'x'; }; delete a.join; return String(a);");
    expectSameAsV8("return (function () { arguments.join = function () { return 'j'; }; return String(arguments); })(1);");
  });
});

// ---------------------------------------------------------------------------
// The vocabulary is checked at construction, over the whole slice
// ---------------------------------------------------------------------------

describe('the vocabulary check', () => {
  const outside: Record<string, string> = {
    'a class': 'class A {}',
    'a class expression': 'var A = class {};',
    'a getter': 'var o = { get x() { return 1; } };',
    'a setter': 'var o = { set x(v) {} };',
    'a generator': 'function* g() {}',
    'a generator expression': 'var g = function* () {};',
    'an async function': 'async function a() {}',
    'an async arrow': 'var a = async () => 1;',
    'an async method': 'var o = { async m() {} };',
    'a with statement': 'with ({}) {}',
    'a tagged template': 'var t = String.raw`x`;',
    'new.target': 'var n = new.target;',
    'a BigInt literal': 'var b = 1n;',
    'a dynamic import': "var p = import('x');",
    'a yield': 'function* g() { yield 1; }',
    'an await': 'async function a() { await 1; }',
    'a labelled function': 'l: function f() {}',
    'a function in an if arm': 'if (x) function f() {}',
    'a function in a block': '{ function f() {} }',
    'a function in a case': 'switch (x) { case 1: function f() {} }',
    'a using declaration': 'using r = x;',
  };

  for (const [what, construct] of Object.entries(outside)) {
    it(`refuses ${what} at construction, in a branch nothing runs`, () => {
      const source = `var _0xt = [1];\nfunction _0xd(_0xi) { if (_0xi === -1) { ${construct} } return _0xt[_0xi]; }`;
      const statements = parse(source, {
        sourceType: 'script',
        plugins: ['explicitResourceManagement'],
        errorRecovery: true,
      }).program.body;
      expect(() => createInterpreter(statements), what).toThrow(UnsupportedSyntaxError);
      expect(() => createInterpreter(statements), what).toThrow(InterpreterRefusal);
    });
  }

  it('is a refusal, in kind and in wording', () => {
    expect(new UnsupportedSyntaxError('ClassDeclaration', 3)).toBeInstanceOf(InterpreterRefusal);
    expect(new UnsupportedSyntaxError('ClassDeclaration', 3).message).toBe(
      'Refusing to evaluate: unsupported syntax for the interpreter: ClassDeclaration (line 3)',
    );
  });

  it('refuses the operators outside the vocabulary', () => {
    // A pipeline is parsed only with its plugin; a `throw` expression likewise.
    const pipeline = parse('var _0xr = 1 |> f(%);', {
      sourceType: 'script',
      plugins: [['pipelineOperator', { proposal: 'hack', topicToken: '%' }]],
    }).program.body;
    expect(() => createInterpreter(pipeline)).toThrow(UnsupportedSyntaxError);
    const throwing = parse('var _0xr = function () { return x || throw 1; };', {
      sourceType: 'script',
      plugins: ['throwExpressions'],
    }).program.body;
    expect(() => createInterpreter(throwing)).toThrow(UnsupportedSyntaxError);
  });

  it('is what the dispatcher turns into a refusal of the decoder', () => {
    // The native tier reads the table lookup and never sees the class; the
    // interpreter refuses at construction, so the match cannot be checked.
    const source = `
      var _0xt = ['alpha', 'beta', 'gamma'];
      function _0xd(_0xi) { if (_0xi === -1) { class Never {} } return _0xt[_0xi]; }
      log(_0xd(1), _0xd(2));
    `;
    const nativeOnly = build(source, ['_0xd'], { techniques: { stringDecoding: { tiers: ['native'] } } });
    expect(nativeOnly.decoder?.decode([1])).toBe('beta');
    const { decoder, notes } = build(source, ['_0xd']);
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('cannot be checked'))).toBe(true);
    expect(notes.some((note) => note.message.includes('ClassDeclaration'))).toBe(true);
  });

  it('walks the type-level wrappers to their operand and nothing else', () => {
    const statements = parse(
      "var __result = (function () { var a: number[] = [1, 2]; a.push(a.shift() as number); return [(a as any)!.length, (<string[]>a)[0], (a satisfies number[])[1]]; })();",
      { sourceType: 'script', plugins: ['typescript'] },
    ).program.body;
    expect(createInterpreter(statements).read('__result')).toEqual([2, 2, 1]);
  });
});

// ---------------------------------------------------------------------------
// The same shapes gating a decoder, end to end
// ---------------------------------------------------------------------------

/**
 * Each initialiser computes 1 under V8 and computed 0 (or nothing) under the
 * interpreter before this round. The decoder subtracts one from the index
 * when the value is falsy, and the native tier reads that subtraction as
 * unconditional - so the native reading is `t[i - 1]`, the program prints
 * `t[i]`, and only an interpreter that either computes 1 or refuses keeps
 * the wrong strings out of the output.
 */
const GATES: Record<string, string> = {
  'assignment order: a[f()] = g()': "var _0xs = (function () { var o = []; var a = {}; a[(o.push('f'), 'k')] = (o.push('g'), 1); return o.join() === 'f,g' ? 1 : 0; })();",
  'assignment order: o[k] = (k = "b", 1)': "var _0xs = (function () { var k = 'a'; var o = {}; o[k] = (k = 'b', 1); return o.a === 1 ? 1 : 0; })();",
  'assignment order: a[i++] = i': 'var _0xs = (function () { var i = 0; var a = []; a[i++] = i; return a[0]; })();',
  'typeof in the dead zone': 'var _0xs = (function () { try { typeof x; return 0; } catch (e) { return 1; } let x; })();',
  'a compound assignment in the dead zone': 'var _0xs = (function () { try { z += 1; return 0; } catch (e) { return 1; } let z; })();',
  'a concise method constructed': 'var _0xs = (function () { var o = { m() {} }; try { new o.m(); return 0; } catch (e) { return 1; } })();',
  'instanceof a bound function': 'var _0xs = (function () { function P() {} var B = P.bind(null); return new P() instanceof B ? 1 : 0; })();',
  'instanceof a non-object prototype': 'var _0xs = (function () { function P() {} P.prototype = 5; try { ({}) instanceof P; return 0; } catch (e) { return 1; } })();',
  'Object.create descriptors': 'var _0xs = Object.create({}, { v: { value: 1 } }).v;',
  'an assigned error name enumerating': "var _0xs = (function () { var e = new Error('m'); e.name = 'X'; return Object.keys(e).length; })();",
  'an own join': "var _0xs = (function () { var a = [0]; a.join = function () { return '1'; }; return +String(a); })();",
  'a sloppy write to a named function expression’s name': 'var _0xs = (function f() { try { f = 0; return 1; } catch (e) { return 0; } })();',
  'the wording of a destructuring TypeError': "var _0xs = (function () { try { var { a } = null; } catch (e) { return e.message === \"Cannot destructure property 'a' of 'null' as it is null.\" ? 1 : 0; } })();",
  'the wording of new on a builtin held in a variable': "var _0xs = (function () { var m = Math.max; try { new m(); } catch (e) { return e.message === 'm is not a constructor' ? 1 : 0; } })();",
  'the wording of new on an arrow held in a property': "var _0xs = (function () { var o = { a: () => 1 }; try { new o.a(); } catch (e) { return e.message === 'o.a is not a constructor' ? 1 : 0; } })();",
  'the wording of a string method on null': "var _0xs = (function () { try { String.prototype.trim.call(null); } catch (e) { return e.message === 'String.prototype.trim called on null or undefined' ? 1 : 0; } })();",
  'the wording of a string literal called': "var _0xs = (function () { try { 'abc'(); } catch (e) { return e.message === '\"abc\" is not a function' ? 1 : 0; } })();",
  'a fractional code point': 'var _0xs = (function () { try { String.fromCodePoint(1.5); return 0; } catch (e) { return 1; } })();',
  // Annex B assigns the block's function to the function-scoped `f` when
  // the declaration is evaluated; the reference stays bound, so the slicer
  // lets it through.
  'a function declaration in a block': 'var _0xs = (function () { var f = 0; { function f() { return 1; } } return f ? 1 : 0; })();',
};

describe('a decoder gated on each shape', () => {
  const gated = (init: string): string => `
    var _0xt = ['alpha', 'beta', 'gamma'];
    ${init}
    function _0xd(_0xi) { if (!_0xs) _0xi = _0xi - 0x1; return _0xt[_0xi]; }
    log(_0xd(1), _0xd(2));
  `;

  for (const [what, init] of Object.entries(GATES)) {
    it(`decodes or refuses, but never inlines the native reading, for ${what}`, async () => {
      // The realm this runs in computes 1, so the program prints `t[1], t[2]`.
      expect(execute(gated(init))).toBe('"beta" "gamma"');
      // Native alone reads the gated subtraction as unconditional.
      const nativeOnly = build(gated(init), ['_0xd'], {
        techniques: { stringDecoding: { tiers: ['native'] } },
      });
      expect(nativeOnly.decoder?.decode([1])).toBe('alpha');

      const { decoder, notes } = build(gated(init), ['_0xd']);
      if (decoder) {
        // The interpreter computed what V8 computes, contradicted the native
        // reading, and its own answer was taken.
        expect(decoder.tier).toBe('interpreter');
        expect(decoder.decode([1])).toBe('beta');
        expect(notes.some((note) => note.severity === 'error' && note.message.includes('disagree'))).toBe(true);
      } else {
        // The interpreter refused the slice, and with it the native reading.
        expect(notes.some((note) => note.message.includes('cannot be checked'))).toBe(true);
      }

      for (const preset of PRESETS) {
        // The table may stay (refused) or go (inlined); the wrong string may
        // not be printed either way.
        const code = await expectSameBehaviour(gated(init), { preset });
        expect(code).not.toContain("log('alpha'");
      }
    });
  }
});
