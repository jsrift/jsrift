import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { recoverConditionalsPass } from '../src/passes/structure/conditionals.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { expectEquivalent, runPass } from './helpers.js';

/**
 * A guard whose branch is a comma sequence - `a && (b(), c())`, the shape
 * every nesting level of an obfuscated conditional takes - recovers to an
 * `if` whose block holds one statement per operand, in the operands' order,
 * and runs as the guard ran at every preset. A sequence carrying a comment
 * stays whole, so the comment is kept where it was written.
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

describe('structure.conditionals over a comma-sequence branch', () => {
  it('gives the branch one statement per operand, in order', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a && (b(), c(), d = 1);');
    expectEquivalent(code, 'if (a) { b(); c(); d = 1; }');
  });

  it('unrolls a nested guard in a single application', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a && (b(), c && (d(), e()));');
    expectEquivalent(code, 'if (a) { b(); if (c) { d(); e(); } }');
  });

  it('keeps a commented sequence whole', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a && (/* both */ b(), c());');
    expect(code).toContain('/* both */');
    expectEquivalent(code, 'if (a) { /* both */b(), c(); }');
  });

  const cases: [string, string][] = [
    ['an && guard', "var n = 0; function b() { log('b', n); } function c() { n++; log('c', n); } var a = 1; a && (b(), c()); log(n);"],
    ['an || guard', "var n = 0; function b() { log('b', n); } function c() { n++; log('c', n); } var a = 0; a || (b(), c()); log(n);"],
    ['a ternary in statement position', "var n = 0; function b() { log('b'); } function c() { log('c'); } var a = 1; a ? (b(), c(), n = 2) : (c(), b()); log(n);"],
    ['nested guards', "var s = ''; var a = 1, c = 1, e = 0; a && (s += 'b', c && (s += 'd', e && (s += 'f'), s += 'g'), s += 'h'); log(s);"],
    ['a sequence that throws part way', "var s = ''; var a = 1; try { a && (s += 'b', undefinedFn(), s += 'c'); } catch (e) { s += 'x'; } log(s);"],
  ];
  for (const [name, source] of cases) {
    for (const preset of PRESETS) {
      it(`runs ${name} as written at ${preset}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});
