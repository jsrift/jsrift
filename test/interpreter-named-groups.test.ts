import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { createInterpreter, InterpreterRefusal } from '../src/analysis/evaluator/interpreter.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * A named capture group is a key the program chose, and `__proto__` or
 * `constructor` are keys the object model does not answer on any value: a
 * groups object carrying one is a refusal at the match, the same as a
 * literal `{ __proto__: ... }`, never a groups object with the key dropped.
 * Ordinary names read as V8 reads them.
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

describe('named capture groups', () => {
  it('reads an ordinary group as V8 does', () => {
    const body = "var m = /(?<word>[a-z]+)-(?<num>\\d+)/.exec('abc-12'); return [m.groups.word, m.groups.num, Object.keys(m.groups), 'word' in m.groups, JSON.stringify(m.groups)];";
    expect(interpret(body)).toEqual(v8(body));
  });

  it('hands the groups object to a replace callback', () => {
    const body = "return 'abc'.replace(/(?<mid>b)/, function () { var g = arguments[arguments.length - 1]; return '[' + g.mid + ']'; });";
    expect(interpret(body)).toEqual(v8(body));
  });

  const blocked: [string, string][] = [
    ['read through __proto__', "return /(?<__proto__>[a-z]+)/.exec('abc').groups.__proto__;"],
    ['read through constructor', "return /(?<constructor>[a-z]+)/.exec('abc').groups.constructor;"],
    ['serialised', "return JSON.stringify(/(?<__proto__>[a-z]+)/.exec('abc').groups);"],
    ['enumerated', "return Object.keys(/(?<__proto__>[a-z]+)/.exec('abc').groups);"],
    ['handed to a replace callback', "return 'abc'.replace(/(?<__proto__>b)/, function () { return Object.keys(arguments[arguments.length - 1]).join(); });"],
  ];

  for (const [title, body] of blocked) {
    it(`refuses a group named __proto__ or constructor ${title}`, () => {
      expect(v8(body)).toBeDefined();
      expect(() => interpret(body)).toThrow(InterpreterRefusal);
    });
  }

  it('refuses to hand such a match out as data', () => {
    expect(() => script("var m = /(?<__proto__>[a-z]+)/.exec('abc');", 'm')).toThrow(InterpreterRefusal);
  });
});

describe('programs matching named groups, end to end', () => {
  const sources = [
    "var m = /(?<__proto__>[a-z]+)/.exec('abc'); log(JSON.stringify(m.groups), m.groups.__proto__);",
    "log(Object.keys(/(?<constructor>[a-z]+)/.exec('abc').groups).join());",
    "log('abc'.replace(/(?<__proto__>b)/, function () { return Object.keys(arguments[arguments.length - 1]).join(); }));",
    "var m = /(?<word>[a-z]+)/.exec('abc'); log(m.groups.word);",
  ];

  for (const source of sources) {
    for (const preset of PRESETS) {
      it(`keeps the program's behaviour at ${preset}: ${source.slice(0, 40)}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});
