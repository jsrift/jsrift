import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import { createInterpreter, InterpreterRefusal } from '../src/analysis/evaluator/interpreter.js';
import { recogniseNativeDecoder } from '../src/analysis/evaluator/native.js';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The interpreter computing what V8 computes, or nothing.
 *
 * Every shape here was reproduced as the interpreter silently producing a
 * value V8 does not - `[].constructor === Array` false, `f.name` empty, a
 * hole that is `in` its array, `Object.keys` in insertion order - and the
 * cross-check then "confirming" a native match on the strength of a wrong
 * number. The expected values are not written down: each is computed by the
 * V8 this test runs on, and the interpreter either matches it or refuses. The
 * decoders in the second half are gated on the same shapes and run through
 * the whole pipeline at every preset; input and output execute in a realm
 * holding only `log`, and their traces must match.
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

function build(
  source: string,
  roots: string[],
  options: Parameters<typeof resolveConfig>[0] = {},
  samples?: readonly (readonly (string | number)[])[],
) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
    samples,
  });
  return { decoder, notes };
}

/** Run a function body in the interpreter, as a sloppy script, and hand back what it returns. */
function interpret(body: string, strict = false): unknown {
  const statements = parse(`var __result = (function () {\n${body}\n})();`, {
    sourceType: 'script',
  }).program.body;
  return createInterpreter(statements, { strict }).read('__result');
}

/** The same body, run by the V8 this test runs on, in a bare realm. */
function v8(body: string): unknown {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, vm.createContext({}));
}

/** V8's answer as data: `undefined` inside arrays survives the comparison as a marker. */
function expectSameAsV8(body: string): void {
  expect(interpret(body)).toEqual(v8(body));
}

/** The name of what V8 throws for the body, or null when it returns: its errors are another realm's. */
function v8Failure(body: string): string | null {
  try {
    v8(body);
    return null;
  } catch (error) {
    return (error as Error).name;
  }
}

// ---------------------------------------------------------------------------
// Direct probes: V8's answer, or a refusal
// ---------------------------------------------------------------------------

describe('own-key order', () => {
  it('lists array indices first, ascending, then the rest in insertion order', () => {
    expectSameAsV8(
      "return [Object.keys({ b: 1, 2: 1, a: 1, 1: 1, 4294967295: 1, 4294967294: 1, '01': 1, '-1': 1 }), " +
        'Object.entries({ b: 1, 2: 1, a: 1, 1: 1 }), Object.values({ b: 1, 2: 1, a: 1, 1: 1 }), ' +
        "JSON.stringify({ b: 1, 2: 1, a: 1, 1: 1 }), Object.keys(Object.assign({}, { z: 1, 3: 1 })), Object.keys({ ...{ q: 1, 0: 1 } })];",
    );
    expect(interpret("return Object.keys({ b: 1, 2: 1, a: 1, 1: 1 }).join();")).toBe('1,2,b,a');
  });

  it('walks for...in over the object, then its prototypes, a name once', () => {
    expectSameAsV8(`
      var seen = [];
      for (var k in { b: 1, 2: 1, a: 1, 1: 1 }) seen.push(k);
      var o = Object.create({ 2: 1, a: 1, shadowed: 1 }); o.b = 1; o[1] = 1; o.shadowed = 2;
      for (var k2 in o) seen.push(k2);
      function f() {} f.x = 1; f.prototype.y = 2;
      for (var k3 in f) seen.push(k3);
      var a = [1, , 3]; a.x = 1;
      for (var k4 in a) seen.push(k4);
      for (var k5 in 'ab') seen.push(k5);
      var d = { p: 1, q: 2, r: 3 };
      for (var k6 in d) { seen.push(k6); delete d.r; }
      return seen;
    `);
  });

  it('orders a function’s own keys the same way', () => {
    expectSameAsV8('function f() {} f.b = 1; f[1] = 1; f.a = 1; f[0] = 1; return Object.keys(f);');
  });
});

describe('this', () => {
  it('binds the sandbox global object at the top level of a script', () => {
    // The realm V8 runs this in binds its context global; the interpreter
    // binds its sandbox global, an object of its own that answers the
    // builtins and the slice's own top-level names, and refuses a property it
    // does not carry rather than reading `undefined` for something the
    // program may well have.
    expect(vm.runInNewContext('typeof this', vm.createContext({}))).toBe('object');
    expect(createInterpreter(parse('var t = typeof this;').program.body).read('t')).toBe('object');
    expect(createInterpreter(parse('var t = this === undefined;').program.body).read('t')).toBe(false);
    expect(createInterpreter(parse('var t = this.String === String;').program.body).read('t')).toBe(true);
    expect(createInterpreter(parse('var v = 1; var t = this.v;').program.body).read('t')).toBe(1);
    expect(() => createInterpreter(parse('var t = this.document;').program.body)).toThrow(/not in the sandbox/);
    expect(() => createInterpreter(parse('var t = this.process;').program.body)).toThrow(InterpreterRefusal);
    // Not data: the object never crosses to the host.
    expect(createInterpreter(parse('var t = this;').program.body).read('t')).toBeUndefined();
    expect(createInterpreter(parse('var t = 1;').program.body).read('t')).toBe(1);
  });

  it('is still the global object at the top level of a strict script, and undefined only in a module', () => {
    // The probe is the top level itself, not a function inside it: a
    // `'use strict'` script binds the global object there like any script.
    // Only a module binds undefined.
    expect(vm.runInNewContext("'use strict'; typeof this", vm.createContext({}))).toBe('object');
    expect(createInterpreter(parse("'use strict'; var t = typeof this;").program.body, { strict: true }).read('t')).toBe('object');
    expect(createInterpreter(parse('var t = typeof this;').program.body, { module: true }).read('t')).toBe('undefined');
  });

  it('binds the sandbox global object in a sloppy-mode call without a receiver', () => {
    for (const body of [
      'return (function () { return this === undefined; })();',
      'return (function () { return typeof this; }).call(null);',
      'return (function () { return typeof this; }).apply(undefined, []);',
      'return (function () { return typeof this; }).bind(null)();',
      'return [1].map(function () { return typeof this; })[0];',
      'var o = { m: function () { return typeof this; } }; var m = o.m; return m();',
      'return (function () { return (() => typeof this)(); })();',
      'return (function () { return this.String === String; })();',
      'return (function () { return this; })() === (function () { return this; }).call(null);',
    ]) {
      expectSameAsV8(body);
    }
    // A host property is not in the sandbox, and is refused rather than read as undefined.
    expect(() => interpret('return (function () { return this.process; })();')).toThrow(InterpreterRefusal);
    expect(v8('return (function () { return this.process; })();')).toBeUndefined();
  });

  it('refuses a sloppy-mode call on a primitive, which sees a wrapper object', () => {
    for (const body of [
      "return (function () { return typeof this; }).call(1);",
      "return (function () { return this.length; }).call('ab');",
      "return [1].map(function () { return this; }, true)[0];",
    ]) {
      expect(() => interpret(body), body).toThrow(/boxed into a wrapper object/);
    }
    expect(v8("return (function () { return typeof this; }).call(1);")).toBe('object');
  });

  it('binds the receiver as given in strict code, primitive or missing', () => {
    expectSameAsV8("return (function () { 'use strict'; return typeof this; }).call(1);");
    expectSameAsV8("return (function () { 'use strict'; return this; })();");
    expectSameAsV8("return (function () { 'use strict'; return (function () { return this; })(); })();");
    expectSameAsV8("'use strict'; return [(function () { return this; })(), (function () { return this; }).call('s')];");
    expect(interpret("return (function () { 'use strict'; return typeof this; }).call(1);")).toBe('number');
  });

  it('only honours the exact directive, in the prologue', () => {
    // `'use\x20strict'` is not a directive, nor is a string after real code:
    // both functions are sloppy and see the global object.
    expectSameAsV8("return (function () { 'use\\x20strict'; return typeof this; })();");
    expectSameAsV8("return (function () { var x = 1; 'use strict'; return typeof this; })();");
    expect(interpret("return (function () { 'use\\x20strict'; return typeof this; })();")).toBe('object');
    expectSameAsV8("return (function () { 'other'; 'use strict'; return this; })();");
    expect(interpret("return (function () { 'other'; 'use strict'; return this; })();")).toBeUndefined();
  });

  it('still binds an object receiver and a constructed instance in sloppy code', () => {
    expectSameAsV8(
      'var o = { n: 5, get: function () { return this.n; } }; function P() { this.v = 1; } return [o.get(), new P().v];',
    );
  });

  it('throws a ReferenceError for an assignment to an undeclared name only in strict code', () => {
    expectSameAsV8(
      "try { (function () { 'use strict'; undeclaredName = 1; })(); return 'created'; } catch (e) { return e.name; }",
    );
    expect(interpret("(function () { anotherName = 2; })(); return anotherName;")).toBe(2);
  });
});

describe('arguments', () => {
  it('is not an array', () => {
    expectSameAsV8(
      "return (function () { return [Array.isArray(arguments), typeof arguments, arguments instanceof Array, arguments instanceof Object, Object.prototype.toString.call(arguments), '' + arguments, typeof arguments.slice, typeof arguments.length, arguments.length]; })(1, 2);",
    );
  });

  it('carries callee in sloppy code and poisons it in strict code', () => {
    expectSameAsV8('return (function f() { return arguments.callee === f && arguments.callee.length; })();');
    expectSameAsV8(
      "return (function f() { 'use strict'; try { return arguments.callee; } catch (e) { return e.name + ': ' + e.message; } })();",
    );
    expectSameAsV8(
      "return (function f() { 'use strict'; try { arguments.callee = 1; } catch (e) { return e.name; } })();",
    );
    expectSameAsV8('return (function () { return [delete arguments.callee, "callee" in arguments]; })();');
  });

  it('aliases the parameters of a sloppy function with a simple parameter list, both ways', () => {
    expectSameAsV8('return (function (a) { arguments[0] = 2; return a; })(1);');
    expectSameAsV8('return (function (a) { a = 2; return arguments[0]; })(1);');
    expectSameAsV8('return (function (a) { arguments[0] = 2; return a; })();');
    expectSameAsV8('return (function (a, b) { b = 5; arguments[0] = 9; return [a, b, arguments[0], arguments[1], arguments.length]; })(1, 2);');
    expectSameAsV8('return (function (a) { delete arguments[0]; arguments[0] = 5; return [a, arguments[0], arguments.length, 0 in arguments]; })(1);');
    expectSameAsV8('return (function (a) { delete arguments[0]; a = 3; return arguments[0]; })(1);');
    expectSameAsV8('return (function (a) { arguments.length = 0; arguments[0] = 4; return a; })(1);');
  });

  it('maps a repeated parameter name once, from the last position', () => {
    expectSameAsV8('return (function (a, a) { arguments[0] = 9; arguments[1] = 8; return a; })(1, 2);');
    expectSameAsV8('return (function (a, a) { a = 7; return [arguments[0], arguments[1]]; })(1, 2);');
  });

  it('does not alias in strict code or with a non-simple parameter list', () => {
    expectSameAsV8("return (function (a) { 'use strict'; arguments[0] = 2; return a; })(1);");
    expectSameAsV8('return (function (a = 0) { arguments[0] = 2; return a; })(1);');
    expectSameAsV8('return (function (a, ...r) { arguments[0] = 2; return a; })(1);');
    expectSameAsV8('return (function ([a]) { arguments[0] = [2]; return a; })([1]);');
  });

  it('has own length and callee, enumerates its indices, and takes extra properties', () => {
    expectSameAsV8(
      "return (function (a) { arguments.x = 1; arguments[3] = 5; return [Object.keys(arguments), Object.getOwnPropertyNames(arguments), arguments.length, 'length' in arguments, arguments.hasOwnProperty('callee'), arguments.propertyIsEnumerable('length'), JSON.stringify(arguments)]; })(1, 2);",
    );
    expectSameAsV8("return (function () { var k = []; for (var i in arguments) k.push(i); return k; })(7, 8);");
  });

  it('spreads, converts and applies like the array-like it is', () => {
    expectSameAsV8('return (function () { return [...arguments]; })(1, 2);');
    expectSameAsV8('return (function () { return Array.from(arguments); })(1, 2);');
    expectSameAsV8('return (function () { return Math.max.apply(null, arguments); })(1, 2);');
    expectSameAsV8('return (function () { var [x, y] = arguments; return [x, y]; })(1, 2);');
    expectSameAsV8('return (function () { return Array.prototype.slice.call(arguments, 1); })(1, 2, 3);');
    expectSameAsV8('return (function () { return Array.prototype.join.call(arguments, "-"); })(1, 2, 3);');
    expectSameAsV8('return (function () { return Array.prototype.indexOf.call(arguments, 2); })(1, 2, 3);');
    expectSameAsV8('return (function () { return Array.prototype.concat.call(arguments, [1]).length; })(7, 8);');
    expectSameAsV8('return (function () { return Array.prototype.toString.call(arguments); })(7, 8);');
    expectSameAsV8(
      'return (function (a) { return Array.prototype.map.call(arguments, function (v, i, all) { if (i === 0) all[1] = 10; return v * 2 + (all === arguments ? 1 : 0); }); })(1, 2);',
    );
    expectSameAsV8('return (function () { return Array.prototype.reduce.call(arguments, function (s, v) { return s + v; }); })(1, 2, 3);');
  });

  it('iterates under for...of, reading length and each index as it goes', () => {
    expectSameAsV8('return (function () { var out = []; for (var v of arguments) out.push(v); return out; })(1, 2, 3);');
    expectSameAsV8(
      'return (function (a) { var out = []; for (var v of arguments) { out.push(v); if (out.length === 1) { arguments[1] = 9; arguments.length = 2; } } return out; })(1, 2, 3);',
    );
  });

  it('crosses the boundary as its enumerable face', () => {
    const statements = parse('var _0xa = (function (a) { arguments.x = 1; return arguments; })(7, 8);', {
      sourceType: 'script',
    }).program.body;
    expect(createInterpreter(statements).read('_0xa')).toEqual({ 0: 7, 1: 8, x: 1 });
  });

  it('refuses a mutating Array.prototype method applied to it', () => {
    expect(() => interpret('return (function () { return Array.prototype.push.call(arguments, 1); })(0);')).toThrow(
      InterpreterRefusal,
    );
    expect(() => interpret('return (function () { return Array.prototype.reverse.call(arguments); })(0, 1);')).toThrow(
      InterpreterRefusal,
    );
  });

  it('survives a bare var of the same name and yields to a parameter or function of it', () => {
    expectSameAsV8('return (function () { var arguments; return typeof arguments; })();');
    expectSameAsV8('return (function () { var arguments = 1; return arguments; })();');
    expectSameAsV8('return (function (arguments) { return arguments; })(5);');
    expectSameAsV8('return (function () { function arguments() {} return typeof arguments; })();');
  });

  it('applies any array-like, as CreateListFromArrayLike does', () => {
    expectSameAsV8("return (function () { return Array.prototype.slice.call(arguments); }).apply(null, { length: 2, 0: 'a', 1: 'b' });");
    expectSameAsV8("return (function () { return [arguments.length, 0 in arguments]; }).apply(null, { length: 2, 1: 'b' });");
    expectSameAsV8("try { (function () {}).apply(null, 'ab'); } catch (e) { return e.name + ': ' + e.message; }");
  });
});

describe('holes', () => {
  it('are not in the array, not own, not keys, and are skipped by the callback methods', () => {
    expectSameAsV8(`
      var a = [1, 2, 3]; delete a[1];
      var seen = [];
      a.forEach(function (v, i) { seen.push(i); });
      var m = [1, , 3].map(function (v, i) { seen.push('m' + i); return v; });
      [1, , 3].filter(function (v, i) { seen.push('f' + i); return true; });
      [1, , 3].some(function (v, i) { seen.push('s' + i); return false; });
      [1, , 3].every(function (v, i) { seen.push('e' + i); return true; });
      [1, , 3].reduce(function (acc, v, i) { seen.push('r' + i); return acc; }, 0);
      [1, , 3].reduceRight(function (acc, v, i) { seen.push('rr' + i); return acc; }, 0);
      [1, , 3].find(function (v, i) { seen.push('fi' + i); return false; });
      [1, , 3].findIndex(function (v, i) { seen.push('fx' + i); return false; });
      return [1 in a, a.length, Object.keys(a), a.hasOwnProperty(1), a.propertyIsEnumerable(1), seen, 1 in m, m.length,
              Object.values([1, , 3]), Object.entries([1, , 3]), Object.keys(Object.assign({}, [1, , 3])),
              1 in Array.from([1, , 3]), 1 in [1, , 3].concat([4]), 1 in [1, , 3].slice(), JSON.stringify([1, , 3]),
              String([1, , 3]), [...[1, , 3]], [1, , 3].indexOf(undefined), [1, , 3].includes(undefined),
              [, 1].reduce(function (s, v) { return s + v; }), [3, , 1].sort(), Object.keys([3, , 1].sort())];
    `);
    expectSameAsV8("try { return [, ,].reduce(function (a, b) { return a + b; }); } catch (e) { return e.name + ': ' + e.message; }");
  });

  it('cannot be made of length, which is not configurable', () => {
    expectSameAsV8('var a = [1, 2]; return [delete a.length, a.length, delete a[0], 0 in a, delete a.x];');
  });
});

describe('getOwnPropertyNames', () => {
  it('lists length on arrays and strings, and a match result’s index, input and groups', () => {
    expectSameAsV8(
      "return [Object.getOwnPropertyNames([1]), Object.getOwnPropertyNames('ab'), Object.getOwnPropertyNames(5), Object.getOwnPropertyNames('a'.match(/a/)), Object.getOwnPropertyNames('aa'.match(/a/g)), Object.keys('a'.match(/a/)), 'groups' in 'a'.match(/a/), 'a'.match(/(?<x>a)/).groups.x, Object.getOwnPropertyNames({ b: 1, 2: 1, a: 1, 1: 1 }), Object.getOwnPropertyNames(/x/), Object.getOwnPropertyNames(new Date(0)), Object.keys(/x/g), Object.keys(new Error('m'))];",
    );
    expectSameAsV8("try { return Object.getOwnPropertyNames(undefined); } catch (e) { return e.name + ': ' + e.message; }");
    expectSameAsV8("try { return Object.keys(null); } catch (e) { return e.name + ': ' + e.message; }");
  });

  it('refuses a function or an error, whose lists the model does not keep', () => {
    expect(() => interpret('return Object.getOwnPropertyNames(function () {});')).toThrow(InterpreterRefusal);
    expect(() => interpret("return Object.getOwnPropertyNames(new Error('m'));")).toThrow(InterpreterRefusal);
  });
});

describe('function names', () => {
  it('follow NamedEvaluation exactly', () => {
    expectSameAsV8(`
      var f = function () {}; let g = () => {}; const h = function () {}; var i = (function () {});
      var j = (0, function () {}); var k = true ? function () {} : 0; var l = function () {} || 0;
      var m; m = function () {}; var o = { p: function () {}, ['q']: () => {}, 5: function () {}, r() {} };
      var n = { z: {} }; n.z.w = function () {}; var [d = function () {}] = []; var { e = function () {} } = {};
      function dflt(x = function () {}) { return x.name; }
      var c1; c1 ||= function () {}; var c2; c2 ??= function () {};
      var key = 'kk'; var comp = { [key]: function () {}, [1 + 1]: function () {} };
      function P() {} P.prototype.meth = function () {};
      var re; [re = function () {}] = [];
      var g2 = f;
      return [f.name, g.name, h.name, i.name, j.name, k.name, l.name, m.name, o.p.name, o.q.name, o[5].name, o.r.name,
              n.z.w.name, d.name, e.name, dflt(), (function () {}).name, (function nm() {}).name, f.bind().name,
              (function () {}).bind().name, c1.name, c2.name, comp.kk.name, comp[2].name, P.prototype.meth.name,
              re.name, g2.name, f.length, 'name' in f, f.hasOwnProperty('name'), Object.keys(f)];
    `);
    expect(interpret('var f = function () {}; return f.name;')).toBe('f');
  });
});

describe('JSON.parse with a reviver', () => {
  it('walks bottom-up in own-key order with the holder as this, deleting on undefined', () => {
    expectSameAsV8(
      "return JSON.parse('{\"a\":[1,{\"b\":2}],\"c\":3}', function (k, v) { return typeof v === 'number' ? v * 10 : v; });",
    );
    expectSameAsV8(
      "var calls = []; JSON.parse('{\"a\":[1,2],\"2\":true,\"1\":false}', function (k, v) { calls.push(k + ':' + typeof v + ':' + Object.keys(this).join('|')); return v; }); return calls;",
    );
    expectSameAsV8(
      "var r = JSON.parse('{\"a\":1,\"b\":2,\"c\":[1,2,3]}', function (k, v) { return k === 'a' || k === '1' ? undefined : v; }); return [r, r.c.length, 1 in r.c, Object.keys(r.c)];",
    );
    expectSameAsV8("return JSON.parse('1', function (k, v) { return undefined; });");
    expectSameAsV8("return JSON.parse('{\"a\":{\"b\":1},\"c\":2}', function (k, v) { if (k === 'a') { this.c = 99; } return v; });");
    expectSameAsV8("return JSON.parse('{\"a\":1}', function (k, v) { return k === '' ? Object.keys(this) : v; });");
    expectSameAsV8("return JSON.parse('{\"a\":1}', (k, v) => (typeof v === 'number' ? v + 1 : v));");
    expectSameAsV8("return JSON.parse('{\"a\":1}', 5);");
    expect(interpret("return JSON.parse('0', function (k, v) { return 1; });")).toBe(1);
  });

  it('refuses a reviver that could see the source-text context V8 passes third', () => {
    // Node passes `{ source }` as a third argument; an interpreted two-parameter
    // function cannot tell, so it runs. Anything that could look is refused.
    expect(vm.runInNewContext("JSON.parse('1', function (k, v, c) { return c.source; })", vm.createContext({}))).toBe('1');
    for (const reviver of [
      'function (k, v, c) { return v; }',
      'function (k, v) { return arguments.length; }',
      'function (...rest) { return rest[1]; }',
      'String',
      'Array',
      '(function (extra, k, v, c) { return v; }).bind(null, 1)',
      '(function (k, v, c) { return v; }).bind(null)',
    ]) {
      expect(() => interpret(`return JSON.parse('[1]', ${reviver});`), reviver).toThrow(/source-text context/);
    }
    // Bound arguments that push the context past every parameter put it out of reach.
    expect(interpret("return JSON.parse('[2]', (function (k, v) { return v; }).bind(null));")).toEqual([2]);
    expect(interpret("return JSON.parse('[3]', (function (extra, k, v) { return v; }).bind(null, 1));")).toEqual([3]);
  });
});

describe('RegExp', () => {
  it('reports source and flags as the host does', () => {
    expectSameAsV8(
      "return [new RegExp('/').source, new RegExp('a/b').source, new RegExp('[/]').source, new RegExp('\\\\/').source, new RegExp('\\n').source, new RegExp('').source, String(new RegExp('/')), new RegExp('', 'ig').flags, new RegExp('a', 'ig').toString(), /\\//.source, new RegExp(/a\\/b/).source, '' + /a/gi, new RegExp('/').source.length];",
    );
    expectSameAsV8(
      "var r = /a/gimsuy; return [r.global, r.ignoreCase, r.multiline, r.dotAll, r.unicode, r.sticky, r.hasIndices, r.flags, r.source, 'source' in r, r.hasOwnProperty('source'), r.hasOwnProperty('lastIndex'), 'sticky' in r, Object.keys(r)];",
    );
    expect(interpret("return new RegExp('/').source;")).toBe('\\/');
  });
});

describe('an object with no prototype', () => {
  it('has nothing inherited and cannot become a primitive', () => {
    expectSameAsV8(
      "var o = Object.create(null); o.x = 1; var c = Object.create(o); return [typeof o.toString, 'toString' in o, o instanceof Object, typeof o.hasOwnProperty, c.x, typeof c.toString, c instanceof Object, 'x' in c, typeof c.hasOwnProperty, JSON.stringify(o), JSON.stringify({ a: o }), Object.prototype.toString.call(o), typeof Object.create({}).toString];",
    );
    for (const conversion of ["'' + o", 'String(o)', '+o', '`${o}`', "o == 'x'", '({})[o]']) {
      expectSameAsV8(`var o = Object.create(null); try { return String(${conversion}); } catch (e) { return e.name + ': ' + e.message; }`);
    }
    expect(interpret('return typeof Object.create(null).toString;')).toBe('undefined');
  });
});

describe('constructor', () => {
  it('is refused on every value but a function, where it is Function, which compiles only the idiom', () => {
    // V8 says `[].constructor === Array`; the table used to say `undefined`
    // and hence `false`. On a function the answer is exact - `Function`,
    // whose only source is `return this` - and everywhere else the property
    // is refused rather than answered wrongly.
    expect(v8('return [].constructor === Array;')).toBe(true);
    for (const receiver of ['[]', '({})', "''", '(5)', '/x/', 'Math', '(function () {}).prototype']) {
      expect(() => interpret(`return ${receiver}.constructor;`), receiver).toThrow(InterpreterRefusal);
    }
    for (const receiver of ['[]', '({})', "''", '(5)', '/x/', 'Object', 'Math', '(function () {}).prototype', 'function () {}']) {
      expect(() => interpret(`return (${receiver})['constructor'] = 1;`), receiver).toThrow(InterpreterRefusal);
    }
    for (const receiver of ['[]', '({})', '/x/', 'Math', '(function () {}).prototype']) {
      expect(() => interpret(`return 'constructor' in ${receiver};`), receiver).toThrow(InterpreterRefusal);
      expect(() => interpret(`return ${receiver}.hasOwnProperty('constructor');`), receiver).toThrow(InterpreterRefusal);
    }
    expectSameAsV8("return [Object.constructor === Function, (function () {}).constructor === Function, 'constructor' in Object, 'constructor' in function () {}, Math.round.constructor === Function];");
    expect(() => interpret("return (function () {}).constructor('return 1')();")).toThrow(InterpreterRefusal);
    expect(() => interpret("try { return ''.__proto__.constructor.name; } catch (e) { return 'caught'; }")).toThrow(
      InterpreterRefusal,
    );
  });
});

describe('Object.prototype.toString', () => {
  it('reports the class tag, never a value’s own toString', () => {
    expectSameAsV8(
      "var t = Object.prototype.toString; return [t.call([]), t.call(null), t.call(undefined), t.call(function () {}), t.call(/x/), t.call(new Date(0)), t.call(new Error('e')), t.call('s'), t.call(1), t.call(true), t.call({ toString: function () { return 'x'; } }), t.call(Math), t.call(JSON), ({}).toString(), [].hasOwnProperty('length'), ''.hasOwnProperty('length'), (5).hasOwnProperty('x'), [].valueOf().length];",
    );
  });
});

describe('optional chains', () => {
  // Babel marks every link after the first `?.` as an Optional* node and only
  // the `?.` link itself `optional: true`; the interpreter used to short-circuit
  // on the node type, so `o?.f.x` with `o = {}` gave undefined where V8 throws
  // on `.x`. The whole chain yields undefined only when an optional link's base
  // is nullish; a plain link on an undefined base throws, as anywhere else.
  it('short-circuit the whole chain at a nullish optional base, and nowhere else', () => {
    for (const body of [
      'var o = {}; return o?.f.x;',
      'var o = {}; return o?.a.b.c;',
      'var o = { a: {} }; return o?.a.b.c;',
      'var o = { f: function () {} }; return o?.f().x.y;',
      'var o = {}; return o?.a.b();',
      'var o; return o.a?.b;',
      'var o = {}; return (o?.f).x;',
      'var o = {}; return (o?.f)();',
      'var o = {}; var k = "f"; return o?.[k].x;',
      'var o = { f: 1 }; return o?.f();',
      'var o = { a: { b: 1 } }; return o?.a.b();',
    ]) {
      expect(v8Failure(body), body).toBe('TypeError');
      expect(() => interpret(body), body).toThrow(/^TypeError: /);
    }
    expect(() => interpret('var o = {}; return o?.f.x;')).toThrow("Cannot read properties of undefined (reading 'x')");
    expect(() => interpret('var o = {}; return o?.a.b.c;')).toThrow("Cannot read properties of undefined (reading 'b')");
    expect(() => interpret('var o = {}; return delete o?.a.b;')).toThrow(/^TypeError: /);
    expect(v8Failure('var o = {}; return delete o?.a.b;')).toBe('TypeError');

    for (const body of [
      'var o; return o?.f.x;',
      'var o = null; return o?.a.b.c;',
      'var o; return o?.f().x.y;',
      'var o = null; return o?.a.b();',
      'var o = {}; return o.a?.b;',
      'var o = {}; return o?.a?.b.c;',
      'var o = { a: {} }; return o?.a?.b?.c.d;',
      'var o = null; return (o?.f)?.x;',
      'var o = {}; return o.f?.();',
      'var o = {}; return o?.f?.();',
      'var f; return f?.();',
      'var o = { f: function () { return null; } }; return o?.f()?.x.y;',
      'var o; return delete o?.a.b;',
      'var o = { a: { b: 1 } }; delete o?.a.b; return "b" in o.a;',
      'var o = {}; return delete o?.a;',
      'var o = { a: { b: 1 } }; return [o?.a.b, o?.["a"].b, o?.a?.["b"], o.a?.b];',
      'var n = 0; var o = { f: function () { n++; return {}; } }; o?.f().x; return n;',
      'var n = 0; var o = null; function k() { n++; return "x"; } o?.[k()].y; return n;',
      'var o = { f: function () { return this === o ? 1 : 0; } }; return [o?.f(), o.f?.(), o?.f?.()];',
    ]) {
      expectSameAsV8(body);
    }
    expect(interpret('var o = {}; return o?.a?.b.c;')).toBeUndefined();
    expect(interpret('var o; return delete o?.a.b;')).toBe(true);
  });

  it('report the callee as V8 spells it, with the question mark', () => {
    expectSameAsV8("var o = {}; try { o?.b(); } catch (e) { return e.message; }");
    expectSameAsV8("var o = { b: 1 }; try { o?.b(); } catch (e) { return e.message; }");
    expect(interpret("var o = {}; try { o?.b(); } catch (e) { return e.message; }")).toBe('o?.b is not a function');
    // `o?.a.b` V8 prints from source, which the model does not keep: refused.
    expect(() => interpret("var o = { a: {} }; try { o?.a.b(); } catch (e) { return e.message; }")).toThrow(
      InterpreterRefusal,
    );
  });

  it('continue through a TypeScript non-null assertion', () => {
    const chain = (body: string): unknown => {
      const statements = parse(`var __result = (function () {\n${body}\n})();`, {
        sourceType: 'script',
        plugins: ['typescript'],
      }).program.body;
      return createInterpreter(statements).read('__result');
    };
    // `o?.a!.b` is one chain: `!` erases and the `.b` link is still covered by `?.`.
    expect(chain('var o = null; return o?.a!.b;')).toBeUndefined();
    expect(() => chain('var o = {}; return o?.a!.b;')).toThrow("Cannot read properties of undefined (reading 'b')");
    expect(chain('var o = { a: { b: 2 } }; return o?.a!.b;')).toBe(2);
  });
});

describe('const in a for head', () => {
  // CreatePerIterationEnvironment copies only `let` bindings; a `const` stays
  // where the head declared it, immutable, so the first `j++` is a TypeError.
  // The interpreter used to copy it as mutable and let the loop complete.
  it('is immutable: the update throws, and so does an assignment in the body', () => {
    for (const body of [
      'var n = 0; for (const j = 0; j < 2; j++) { n++; } return n;',
      'var n = 0; for (const j = 0; j < 2; ) { n++; j = 1; } return n;',
      'for (const j = 0; ; j += 1) {} return 0;',
      'for (const j = 0, k = 1; j < 1; k++) {} return 0;',
      'for (const [j] = [0]; j < 1; j++) {} return 0;',
    ]) {
      expect(v8Failure(body), body).toBe('TypeError');
      expect(() => interpret(body), body).toThrow('Assignment to constant variable.');
    }
    expectSameAsV8('var n = 0; try { for (const j = 0; j < 2; j++) { n++; } } catch (e) { return [n, e.name, e.message]; }');
    expectSameAsV8('var n = 0; try { for (const j = 0; j < 2; ) { n++; j = 1; } } catch (e) { return [n, e.name]; }');
  });

  it('still runs a loop that never writes it, and a closure sees the one binding', () => {
    expectSameAsV8('var n = 0; for (const j = 0; j < 1; ) { n++; break; } return n;');
    expectSameAsV8('var out = []; for (const j = 5; out.length < 3; out.push(j)) {} return out;');
    expectSameAsV8('var fs = []; var i = 0; for (const j = 0; i < 2; i++) { fs.push(function () { return j + i; }); } return fs.map(function (f) { return f(); });');
    // `let` is still copied: each closure keeps its own iteration's value.
    expectSameAsV8('var fs = []; for (let j = 0; j < 2; j++) { fs.push(function () { return j; }); } return fs.map(function (f) { return f(); });');
    expectSameAsV8('var fs = []; for (let j = 0; j < 2; j++) { fs.push(function () { return j; }); j += 0; } return fs.map(function (f) { return f(); });');
    expectSameAsV8('var out = []; for (const j = 0; ; ) { out.push(j); if (out.length > 1) break; } return out;');
    expectSameAsV8('var out = []; for (const v of [1, 2]) out.push(v); for (const k in { a: 1 }) out.push(k); return out;');
  });
});

// ---------------------------------------------------------------------------
// The same shapes gating a decoder, end to end
// ---------------------------------------------------------------------------

/**
 * Each initialiser computes 1 under V8 and computed 0 under the old table.
 * The decoder subtracts one from the index when the value is falsy, and the
 * native tier reads that subtraction as unconditional - so the native reading
 * is `t[i - 1]`, the program prints `t[i]`, and only an interpreter that
 * either computes 1 or refuses keeps the wrong strings out of the output.
 */
const GATES: Record<string, string> = {
  'the order of Object.keys': "var _0xs = Object.keys({ b: 1, 2: 1, a: 1, 1: 1 }).join() === '1,2,b,a' ? 1 : 0;",
  'this at the top level': "var _0xs = typeof this === 'object' ? 1 : 0;",
  'this in a sloppy call': 'var _0xs = (function () { return this === undefined ? 0 : 1; })();',
  'this boxed by a sloppy call': "var _0xs = (function () { return typeof this === 'object' ? 1 : 0; }).call(1);",
  'arguments.callee': "var _0xs = (function () { return typeof arguments.callee === 'function' ? 1 : 0; })();",
  'Array.isArray(arguments)': 'var _0xs = (function () { return Array.isArray(arguments) ? 0 : 1; })();',
  'arguments aliasing a parameter': 'var _0xs = (function (a) { arguments[0] = 1; return a; })(0);',
  'a hole being in its array': 'var _0xs = (function () { var a = [0, 0, 0]; delete a[1]; return 1 in a ? 0 : 1; })();',
  'getOwnPropertyNames of an array': 'var _0xs = Object.getOwnPropertyNames([1]).length - 1;',
  'the name of a function expression': "var _0xf = function () {}; var _0xs = _0xf.name === '_0xf' ? 1 : 0;",
  'a JSON.parse reviver': "var _0xs = JSON.parse('0', function (k, v) { return 1; });",
  'the source of a RegExp': "var _0xs = new RegExp('/').source.length - 1;",
  'toString on a prototype-less object': "var _0xs = typeof Object.create(null).toString === 'undefined' ? 1 : 0;",
  '[].constructor': 'var _0xs = [].constructor === Array ? 1 : 0;',
  'a plain link on an undefined base inside an optional chain':
    'var _0xs = (function () { var o = {}; try { o?.f.x; return 0; } catch (e) { return 1; } })();',
  'a call through an optional chain': 'var _0xs = (function () { var o = {}; try { o?.a.b(); return 0; } catch (e) { return 1; } })();',
  'a delete through an optional chain':
    'var _0xs = (function () { var o = {}; try { delete o?.a.b; return 0; } catch (e) { return 1; } })();',
  'a const in a for head': 'var _0xs = (function () { try { for (const j = 0; j < 2; j++) {} return 0; } catch (e) { return 1; } })();',
  'an assignment to a const in a for head':
    'var _0xs = (function () { try { for (const j = 0; j < 2; ) { j = 1; } return 0; } catch (e) { return 1; } })();',
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

// ---------------------------------------------------------------------------
// A completion at the top of a slice
// ---------------------------------------------------------------------------

describe('a return, break or continue at the top level of a slice', () => {
  it('fails the evaluation with the statement named, instead of stopping quietly', () => {
    const returning = parse('var _0xt = [1];\nreturn _0xt;\nvar _0xu = 2;', {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
    }).program.body;
    expect(() => createInterpreter(returning)).toThrow(InterpreterRefusal);
    expect(() => createInterpreter(returning)).toThrow(/`return` statement \(line 2\)/);

    const breaking = [t.variableDeclaration('var', [t.variableDeclarator(t.identifier('_0xt'), t.numericLiteral(1))]), t.breakStatement(t.identifier('outer'))];
    expect(() => createInterpreter(breaking)).toThrow(/`break outer` statement/);

    const continuing = [t.continueStatement()];
    expect(() => createInterpreter(continuing)).toThrow(/`continue` statement/);
  });

  it('is the verdict the dispatcher already maps to a refusal', () => {
    // No slice reaches the interpreter with a bare completion today - the
    // slicer refuses a compound statement that leaves by `return` before the
    // interpreter sees it - so this guards the day one does. The dispatcher
    // treats every non-budget throw from construction as a verdict on the
    // slice, which the construction-failure cases in evaluator-fidelity prove.
    const statements = parse('var _0xt = [1];\nreturn;', {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
    }).program.body;
    let thrown: unknown;
    try {
      createInterpreter(statements);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InterpreterRefusal);
    expect((thrown as Error).message).toMatch(/^Refusing to evaluate: the slice's top level ends in a `return` statement \(line 2\)/);
  });
});

// ---------------------------------------------------------------------------
// Fidelity notes after every batch
// ---------------------------------------------------------------------------

describe('a decoder that stringifies itself late', () => {
  const source = `
    var _0xt = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    function _0xd(_0xi) { if (_0xi > 5) { var _0xs = '' + _0xd; if (!_0xs.length) return ''; } return _0xt[_0xi * 0x1]; }
    log(_0xd(0), _0xd(1), _0xd(2), _0xd(3), _0xd(4), _0xd(5), _0xd(6), _0xd(7));
  `;
  const fidelity = (notes: { message: string }[]) =>
    notes.filter((note) => note.message.startsWith('Interpreter fidelity for _0xd:'));

  it('is reported when a validation sample past the probes reaches the stringification', () => {
    // The four probes are indices 0-3 and never stringify; sample 6 does,
    // during validation, and the note has to follow it out.
    const { decoder, notes } = build(source, ['_0xd']);
    expect(decoder?.tier).toBe('interpreter');
    expect(fidelity(notes)).toHaveLength(1);
    expect(fidelity(notes)[0]?.message).toContain('regenerated source');
  });

  it('is reported when only an inline-time decode reaches it', () => {
    const { decoder, notes } = build(source, ['_0xd'], {}, [[0], [1]]);
    expect(decoder?.tier).toBe('interpreter');
    expect(fidelity(notes)).toHaveLength(0);
    expect(decoder?.decode([2])).toBe('gamma');
    expect(fidelity(notes)).toHaveLength(0);
    expect(decoder?.decode([6])).toBe('eta');
    expect(fidelity(notes)).toHaveLength(1);
    expect(decoder?.decode([7])).toBe('theta');
    expect(fidelity(notes)).toHaveLength(1);
  });

  it('is reported when the cross-check is what reaches it', () => {
    // A plain table lookup the native tier takes - the probe's early
    // `return ''` would be a return that is not the element, so the probe
    // moves the index by nothing instead - and the interpreter mirrors it
    // over up to sixteen samples, of which the seventh stringifies.
    const plain = source
      .replace("if (!_0xs.length) return '';", 'if (!_0xs.length) _0xi = _0xi - 0x0;')
      .replace('_0xt[_0xi * 0x1]', '_0xt[_0xi]');
    const { decoder, notes } = build(plain, ['_0xd'], {}, [[0], [1], [2], [3], [6]]);
    expect(decoder?.tier).toBe('native');
    expect(fidelity(notes)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The disagreement report names the value
// ---------------------------------------------------------------------------

describe('the disagreement report', () => {
  it('says "produced undefined" for an undefined result, and never "interpreter undefined"', () => {
    // The accessor blanks its third entry before handing the table over; the
    // native tier reads the literal past that to 'c'.
    const source = `
      function _0xa() { var _0xo = ['a', 'b', 'c']; _0xo[2] = void 0; _0xa = function () { return _0xo; }; return _0xa(); }
      function _0xd(_0xi) { var _0xv = _0xa()[_0xi]; return _0xv; }
      log(_0xd(0), _0xd(2));
    `;
    const { notes } = build(source, ['_0xd']);
    const disagreement = notes.find((note) => note.message.includes('disagree'));
    expect(disagreement?.message).toContain('native produced "c", the interpreter produced undefined');
    expect(notes.every((note) => !note.message.includes('interpreter undefined'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The native tier is not what changed
// ---------------------------------------------------------------------------

describe('the native tier', () => {
  it('still refuses the gated decoders on its own terms only where it always did', () => {
    // Sanity: a plain decoder is still recognised, so the refusals above are
    // the interpreter's and not a recogniser regression.
    const program = programPath("var _0xt = ['alpha', 'beta']; function _0xd(_0xi) { return _0xt[_0xi]; }");
    expect(recogniseNativeDecoder(sliceForEvaluation(program, ['_0xd']), ['_0xd'])?.decode([1])).toBe('beta');
  });
});
