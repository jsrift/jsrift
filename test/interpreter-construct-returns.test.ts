import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { createInterpreter } from '../src/analysis/evaluator/interpreter.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * [[Construct]] hands back whatever object the body returns and the fresh
 * instance only for a primitive or nothing. An `arguments` object, a
 * regexp, a date, an error and the global object are objects: `new F()`
 * over `return arguments` is the arguments object, with its `length`. Each
 * answer is the V8 one, read from the V8 the test runs on.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function interpret(body: string): unknown {
  const statements = parse(`var __result = (function () {\n${body}\n})();`, { sourceType: 'script' }).program.body;
  return createInterpreter(statements, {}).read('__result');
}

function v8(body: string): unknown {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, vm.createContext({}));
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

describe('what new F() evaluates to when the body returns an object', () => {
  const cases: [string, string][] = [
    ['an arguments object', 'function F() { return arguments; } var a = new F(1, 2); return [a.length, a[0], a[1]];'],
    ['a regexp', "function G() { return /ab/g; } var r = new G(); return [r.source, r.flags, r.test('xab')];"],
    ['a date', 'function D() { return new Date(0); } return new D().getTime();'],
    ['an error', "function E() { return new Error('m'); } var e = new E(); return [e.message, e instanceof Error];"],
    ['the global object', "function H() { return Function('return this')(); } return typeof new H().parseInt;"],
    ['a plain object', 'function P() { return { k: 1 }; } return new P().k;'],
    ['an array', 'function A() { return [4, 5]; } return new A().length;'],
    ['a function', 'function Q() { return function () { return 9; }; } return new Q()();'],
    ['a primitive, which yields the instance', "function S() { this.x = 1; return 5; } var s = new S(); return [typeof s, s.x];"],
    ['nothing, which yields the instance', "function N() { this.x = 2; } return new N().x;"],
  ];

  for (const [title, body] of cases) {
    it(`returns ${title}`, () => {
      expect(interpret(body)).toEqual(v8(body));
    });
  }
});

describe('a program constructing through such a return, end to end', () => {
  const sources = [
    'function F() { return arguments; } log(new F(1, 2).length);',
    "function G() { return /ab/; } log(new G().source);",
    'function D() { return new Date(0); } log(new D().getTime());',
    "function E() { return new Error('m'); } log(new E().message);",
  ];

  for (const source of sources) {
    for (const preset of PRESETS) {
      it(`keeps the program's behaviour at ${preset}: ${source.slice(0, 40)}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});
