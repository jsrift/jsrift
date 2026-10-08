import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { createInterpreter, InterpreterRefusal } from '../src/analysis/evaluator/interpreter.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * `undefined`, `NaN` and `Infinity` are non-writable, non-configurable data
 * properties of the global object. A sloppy write to one is dropped, a
 * strict one is a TypeError, and a top-level `let`, `class` or function
 * declaration of the name is an early error for the whole script; a
 * function's own `var undefined` shadows it like any local. Every answer
 * here is read from the V8 the test runs on, and the interpreter gives the
 * same one or refuses.
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

describe('writes to undefined, NaN and Infinity', () => {
  const sloppy: [string, string][] = [
    ['a plain assignment to undefined', 'undefined = 5; var r = undefined; return [r, typeof r];'],
    ['a plain assignment to NaN', 'NaN = 7; return NaN;'],
    ['a plain assignment to Infinity', 'Infinity = 1; return Infinity;'],
    ['a compound assignment to undefined', 'undefined += 1; return undefined;'],
    ['an update of NaN', 'NaN++; return NaN;'],
    ['a destructuring write to Infinity', '[Infinity] = [3]; return Infinity;'],
    ['a function-scoped var of the name', 'var undefined = 5; return undefined;'],
    ['a function-scoped let of the name', 'let undefined = 3; return undefined;'],
  ];

  for (const [title, body] of sloppy) {
    it(`reads what V8 reads after ${title}`, () => {
      expect(interpret(body)).toEqual(v8(body));
    });
  }

  it('drops a top-level var of the name and its initialiser', () => {
    expect(script('var undefined = 5;', 'undefined')).toBe(undefined);
    expect(script('var NaN = 5; var r = NaN;', 'r')).toBeNaN();
  });

  const strict: [string, string][] = [
    ['undefined', "'use strict'; try { undefined = 5; } catch (e) { return [e.name, e instanceof TypeError]; } return 'no throw';"],
    ['NaN', "'use strict'; try { NaN = 5; } catch (e) { return [e.name, e instanceof TypeError]; } return 'no throw';"],
    ['Infinity', "'use strict'; try { Infinity += 1; } catch (e) { return [e.name, e instanceof TypeError]; } return 'no throw';"],
  ];

  for (const [name, body] of strict) {
    it(`throws the TypeError V8 throws for a strict write to ${name}`, () => {
      expect(v8(body)).toEqual(['TypeError', true]);
      expect(interpret(body)).toEqual(['TypeError', true]);
    });
  }

  it('refuses a top-level declaration that V8 rejects as an early error', () => {
    for (const source of ['function undefined() {}', 'let NaN = 1;', 'const Infinity = 1;']) {
      let thrown: unknown;
      try {
        new vm.Script(source).runInNewContext({});
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).name).toBe('SyntaxError');
      expect(() => script(source, 'undefined')).toThrow(InterpreterRefusal);
    }
  });
});

describe('a program that writes to undefined, end to end', () => {
  const sources = [
    "undefined = 5; var r = undefined; log(typeof r, r === void 0);",
    "NaN = 7; Infinity = 1; log(NaN !== NaN, Infinity > 1e308);",
    "'use strict'; try { undefined = 5; } catch (e) { log(e.name); } log(typeof undefined);",
    "function f() { var undefined = 'local'; return undefined; } log(f(), typeof undefined);",
  ];

  for (const source of sources) {
    for (const preset of PRESETS) {
      it(`keeps the program's behaviour at ${preset}: ${source.slice(0, 40)}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});
