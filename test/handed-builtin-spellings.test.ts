import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * Spellings one step past the ones the host-write index, the folders and
 * the printer read first: a key folded into a write in the round that reads
 * it, a directive behind a loose string, a hoisted function coerced in a
 * declaration prefix, the global object through a literal's constructor
 * chain, a bound function picked by an array method, an array index made
 * with an operator other than `+`. Each parsed, ran and printed a different
 * trace from its input at some preset.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

const DECODER = `var T = ['\\xfc\\x6e\\xef', 'plain'];
function dec(i) { var s = T[i], o = ''; for (var k = 0; k < s.length; k++) o += String.fromCharCode(s.charCodeAt(k) + 1); return o; }`;

function trace(code: string): string {
  const lines: string[] = [];
  try {
    vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  } catch (error) {
    lines.push(`THROWN ${error instanceof Error ? error.name : String(error)}`);
  }
  return lines.join(' | ');
}

function sameTrace(title: string, source: string): void {
  for (const preset of PRESETS) {
    it(`${title} (${preset})`, async () => {
      const { code } = await deobfuscate(source, { preset: preset as DeobfuscateOptions['preset'] });
      expect(trace(code)).toBe(trace(source));
    });
  }
}

describe('a write whose key the same round folds', () => {
  sameTrace('spelled with String.fromCharCode', "function g(c) { return 'Z'; } String[String.fromCharCode(102,114,111,109,67,104,97,114,67,111,100,101)] = g; log(String.fromCharCode(65));");
  sameTrace('spelled by split and join', "function g(c) { return 'Z'; } String['from,Char,Code'.split(',').join('')] = g; log(String.fromCharCode(65));");
  sameTrace('on a prototype', "String.prototype[String.fromCharCode(99,104,97,114,67,111,100,101,65,116)] = function () { return 0; }; log('a'.charCodeAt(0));");
});

describe('a directive behind a loose string', () => {
  sameTrace('after a value statement and another string', 'function f() { 1; "a"; "use strict"; return this; } log(f() === undefined);');
  sameTrace('after a parenthesised string', 'function f() { ("a"); "use strict"; return this; } log(f() === undefined);');
});

describe('a hoisted function coerced in a declaration prefix', () => {
  sameTrace('as valueOf', "function main(){ var o = { valueOf: f }, y = +o, T = ['alpha','beta']; function f(){ if (!T) return 1; return 2; } return y; } log(main());");
  sameTrace('as toString through an alias', "function main(){ var g = f, o = { toString: g }, h = {}, y = h[o], T = ['alpha','beta']; function f(){ if (!T) return 'unset'; return typeof T; } return y; } log(main());");
});

describe('the global object through a constructor chain', () => {
  sameTrace('of an array literal', `${DECODER} var g = [].constructor.constructor('return this')(); g.String.fromCharCode = function () { return 'X'; }; log(dec(0), dec(1));`);
  sameTrace('of Object', `${DECODER} var g = Object.constructor('return this')(); g.String.fromCharCode = function () { return 'X'; }; log(dec(0), dec(1));`);
  sameTrace('of an object literal', `${DECODER} var g = ({}).constructor.constructor('return this')(); g.String.fromCharCode = function () { return 'X'; }; log(dec(0), dec(1));`);
});

describe('a bound function picked by an array method', () => {
  sameTrace('by pop', `${DECODER} function f(K){ K.fromCharCode = function(){ return 'X'; }; } [f.bind(null)].pop()(String); log(dec(0), dec(1));`);
  sameTrace('by at', `${DECODER} function f(K){ K.fromCharCode = function(){ return 'X'; }; } [f.bind(null)].at(-1)(String); log(dec(0), dec(1));`);
  sameTrace('bound through Function.prototype.bind.call', `${DECODER} function f(K){ K.fromCharCode = function(){ return 'X'; }; } [Function.prototype.bind.call(f, null)][0](String); log(dec(0), dec(1));`);
});

describe('an array index made with an operator other than +', () => {
  sameTrace('minus', `${DECODER} var H = [Math, String]; var j = 2; H[j - 1].fromCharCode = function(){ return 'X'; }; log(dec(0), dec(1));`);
  sameTrace('times and plus', `${DECODER} var H = [Math, String]; var i = 0; H[i * 1 + 1].fromCharCode = function(){ return 'X'; }; log(dec(0), dec(1));`);
  sameTrace('bitwise or', `${DECODER} var H = [Math, String]; var i = 0; H[i | 1].fromCharCode = function(){ return 'X'; }; log(dec(0), dec(1));`);
  sameTrace('postfix increment', `${DECODER} var H = [Math, String]; var i = 1; H[i++].fromCharCode = function(){ return 'X'; }; log(dec(0), dec(1));`);
});

describe('a function whose text the program reads from outside it', () => {
  it('is reported as a guard this output will not run past, at every preset', async () => {
    const source = "function helper(){ return 'ok'; } var self = '' + helper; if (self.indexOf(String.fromCharCode(10)) !== -1) { while (true) {} } log(helper());";
    for (const preset of PRESETS) {
      const result = await deobfuscate(source, { preset: preset as DeobfuscateOptions['preset'] });
      const errors = result.metadata.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
      expect(errors.some((m) => m.includes('this output will not run'))).toBe(true);
    }
  });
});
