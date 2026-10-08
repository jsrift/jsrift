import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { createInterpreter } from '../src/analysis/evaluator/interpreter.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * StringPad returns the receiver before it allocates anything: when the
 * target length is not above the receiver's, and again when the filler is
 * empty. The filler is converted only once the target is known to be
 * longer, and the length check comes after both. Every answer is V8's,
 * read from the V8 the test runs on.
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

describe('padStart and padEnd', () => {
  const cases: [string, string][] = [
    ['an empty filler over a huge target is the receiver', "return ['a'.padStart(1073741824, ''), 'a'.padEnd(1e10, '')];"],
    ['a target below the length is the receiver', "return ['abc'.padStart(1, 'x'), 'abc'.padEnd(-5, 'x'), 'abc'.padStart(3)];"],
    ['a target below the length never converts the filler', "return 'abc'.padStart(1, { toString: function () { throw new Error('ran'); } });"],
    ['a filler over a huge target is a RangeError', "try { return 'a'.padStart(1073741824, 'x'); } catch (e) { return e.name; }"],
    ['a filler is repeated and truncated', "return ['ab'.padStart(7, 'xyz'), 'ab'.padEnd(7, 'xyz'), 'ab'.padStart(5)];"],
    ['a nullish target is the receiver', "return ['ab'.padStart(undefined, 'x'), 'ab'.padStart(NaN, 'x')];"],
  ];

  for (const [title, body] of cases) {
    it(title, () => {
      expect(interpret(body)).toEqual(v8(body));
    });
  }
});

describe('a program padding with an empty filler, end to end', () => {
  const sources = [
    "log('a'.padStart(1073741824, ''));",
    "var f = ''; log('ab'.padEnd(1e10, f), 'ab'.padStart(1, 'z'));",
    "try { log('a'.padStart(1073741824, 'x')); } catch (e) { log(e.name); }",
  ];

  for (const source of sources) {
    for (const preset of PRESETS) {
      it(`keeps the program's behaviour at ${preset}: ${source.slice(0, 40)}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});
