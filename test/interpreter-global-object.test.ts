import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { createInterpreter, InterpreterRefusal } from '../src/analysis/evaluator/interpreter.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * The sandbox global answers the questions a polyfill prologue asks of it
 * - `hasOwnProperty.call(g, 'atob')` is true for a builtin and for a
 * top-level `var`, false for a top-level `let` - and refuses the ones whose
 * answer belongs to the host, such as its JSON. The function `Function('return
 * this')` builds is a sloppy function: called on an object it returns that
 * object, bare it returns the global, and on a primitive or through `new` it
 * produces a wrapper or an instance the model does not have. Each answer is
 * V8's, from the V8 the test runs on, or a refusal.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function interpret(body: string): unknown {
  const statements = parse(`var __result = (function () {\n${body}\n})();`, { sourceType: 'script' }).program.body;
  return createInterpreter(statements, {}).read('__result');
}

function v8(body: string): unknown {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, vm.createContext({}));
}

function script(source: string, name: string): unknown {
  return createInterpreter(parse(source, { sourceType: 'script' }).program.body, {}).read(name);
}

function trace(code: string): string {
  const lines: string[] = [];
  const log = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === 'string' ? JSON.stringify(a) : String(a))).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout: 2_000 });
  } catch (error) {
    lines.push(`THROWN ${(error as Error).name}`);
  }
  return lines.join('\n');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

describe('own-property questions put to the global object', () => {
  it('owns its builtins', () => {
    const body = "var g = Function('return this')(); return [Object.prototype.hasOwnProperty.call(g, 'parseInt'), Object.prototype.hasOwnProperty.call(g, 'String'), 'parseInt' in g];";
    expect(interpret(body)).toEqual(v8(body));
  });

  it('owns a top-level var and not a top-level let', () => {
    const source = "var q = 1; let z = 2; var g = Function('return this')(); var own = [Object.prototype.hasOwnProperty.call(g, 'q'), Object.prototype.hasOwnProperty.call(g, 'z')];";
    expect(vm.runInNewContext(`${source} own`, vm.createContext({}))).toEqual([true, false]);
    expect(script(source, 'own')).toEqual([true, false]);
  });

  it('takes the builtin branch of a polyfill prologue', () => {
    const body = "var g = Function('return this')(); var enc = Object.prototype.hasOwnProperty.call(g, 'encodeURIComponent') ? g.encodeURIComponent : function () { return 'shim'; }; return enc('a b');";
    expect(interpret(body)).toEqual(v8(body));
  });

  it('refuses to serialise the global object', () => {
    expect(() => interpret("return JSON.stringify(Function('return this')());")).toThrow(InterpreterRefusal);
    expect(() => interpret("return JSON.stringify({ g: Function('return this')() });")).toThrow(InterpreterRefusal);
  });
});

describe('the function the global-object idiom builds', () => {
  const cases: [string, string][] = [
    ['returns its receiver through call', "var o = {}; return Function('return this').call(o) === o;"],
    ['returns its receiver as a method', "var o = {}; o.g = Function('return this'); return o.g() === o;"],
    ['returns its receiver through apply', "var o = { k: 3 }; return Function('return this').apply(o, []).k;"],
    ['returns the global when called bare', "return Function('return this')() === Function('return this')();"],
    ['returns the global through call with no receiver', "return Function('return this').call(undefined) === Function('return this')();"],
  ];

  for (const [title, body] of cases) {
    it(title, () => {
      expect(interpret(body)).toEqual(v8(body));
    });
  }

  it('refuses a primitive receiver, which V8 boxes', () => {
    expect(() => interpret("return Function('return this').call('s');")).toThrow(InterpreterRefusal);
  });

  it('refuses construction, which V8 answers with an instance', () => {
    expect(typeof v8("return new (Function('return this'))();")).toBe('object');
    expect(() => interpret("return new (Function('return this'))();")).toThrow(InterpreterRefusal);
    expect(() => interpret("try { return new (Function('return this'))(); } catch (e) { return e.name; }")).toThrow(InterpreterRefusal);
  });
});

describe('programs asking the global object, end to end', () => {
  const sources = [
    "var g = Function('return this')(); log(Object.prototype.hasOwnProperty.call(g, 'parseInt'));",
    "var g = Function('return this')(); var enc = Object.prototype.hasOwnProperty.call(g, 'encodeURIComponent') ? g.encodeURIComponent : function () { return 'shim'; }; log(enc('a b'));",
    "var o = { k: 'v' }; log(Function('return this').call(o).k);",
    "var o = { g: Function('return this') }; log(o.g() === o);",
  ];

  for (const source of sources) {
    for (const preset of PRESETS) {
      it(`keeps the program's behaviour at ${preset}: ${source.slice(0, 40)}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});
