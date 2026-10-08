import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * A fold that runs a builtin in place makes the same claim a decoder does -
 * that the builtin is the one every tier would run - and the program can
 * have replaced it by name, through a hand-off, or on its prototype. Each
 * case here folded to the builtin's answer at every preset while the
 * program prints the replacement's; the fold now asks the same write index
 * the decoder builder asks, and leaves the call as written.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  return lines.join(' | ');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

describe('simplify.fold-constants beside a write to a builtin', () => {
  const cases: [string, string][] = [
    [
      'assigned by name',
      "function g(c) { return 'Z'; } String.fromCharCode = g; function dec(i) { return String.fromCharCode(i); } log(dec(65));",
    ],
    [
      'assigned through a hand-off of String',
      "function g(c) { return 'Z'; } (function (K) { K.fromCharCode = g; })(String); log(String.fromCharCode(65));",
    ],
    [
      'assigned through a helper that takes the builtin last',
      "function w(tag, K) { K.fromCharCode = function () { return tag; }; } w('x', String); log(String.fromCharCode(65));",
    ],
    ['a global function reassigned', "parseInt = function () { return 7; }; log(parseInt('42'));"],
    ['a prototype method replaced', "String.prototype.charCodeAt = function () { return 0; }; log('a'.charCodeAt(0));"],
    ['an array method replaced', "Array.prototype.join = function () { return 'joined'; }; log([1, 2].join('-'));"],
    ['a number method replaced', "Number.prototype.toString = function () { return 'n'; }; log((255).toString(16));"],
    [
      'a prototype method replaced by reflection',
      "Object.defineProperty(String.prototype, 'toUpperCase', { value: function () { return 'low'; } }); log('a'.toUpperCase());",
    ],
    ['a block function hoisted over the name', "{ function String() {} } String.fromCharCode = function () { return 'Q'; }; log(String.fromCharCode(65));"],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`leaves the call as written: ${title}, ${preset}`, async () => {
        const expected = trace(source);
        const code = await output(source, preset);
        expect(trace(code)).toBe(expected);
      });
    }
  }

  it('still folds when the writes are to something else', async () => {
    const source = "Math.clamp = function (a) { return a; }; String.prototype.shout = function () { return this + '!'; }; log(String.fromCharCode(65), parseInt('42'), 'a'.charCodeAt(0));";
    for (const preset of PRESETS) {
      const code = await output(source, preset);
      expect(code).toContain("'A'");
      expect(code).toContain('42');
      expect(code).toContain('97');
      expect(trace(code)).toBe(trace(source));
    }
  });

  it('says which write kept the fold from happening', async () => {
    const source = "function g(c) { return 'Z'; } String.fromCharCode = g; log(String.fromCharCode(65));";
    const result = await deobfuscate(source, { preset: 'balanced' });
    const messages = result.metadata.diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.startsWith('Left String.fromCharCode(...) as written: the program assigns to'))).toBe(true);
    expect(messages.filter((m) => m.startsWith('Left String.fromCharCode(...) as written')).length).toBe(1);
  });
});
