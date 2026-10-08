import { describe, expect, it } from 'vitest';
import { deobfuscate, resolveConfig } from '../src/index.js';

/**
 * The interpreter stops on `steps > maxSteps` and `Date.now() > deadline`,
 * and both compare false against NaN and never true against Infinity, so a
 * budget that is not a finite number is no budget at all: a decoder that
 * loops runs to completion in the host with nothing to stop it. Those values
 * are refused at the option check, before a single decoder is read.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

const LOOPING_DECODER = [
  "var table = ['alpha', 'beta'];",
  'function dec(i) { var n = 0; for (var k = 0; k < 2e9; k++) n = (n + k) | 0; return table[i]; }',
  'log(dec(0), dec(1));',
].join('\n');

describe('sandbox budgets that bound nothing', () => {
  it.each([
    ['maxSteps as NaN', { sandbox: { maxSteps: Number.NaN } }, /sandbox\.maxSteps must be a finite number; received NaN/],
    ['maxSteps as Infinity', { sandbox: { maxSteps: Infinity } }, /sandbox\.maxSteps must be a finite number; received Infinity/],
    ['timeoutMs as NaN', { sandbox: { timeoutMs: Number('x') } }, /sandbox\.timeoutMs must be a finite number; received NaN/],
    ['timeoutMs as -Infinity', { sandbox: { timeoutMs: -Infinity } }, /sandbox\.timeoutMs must be a finite number; received -Infinity/],
  ])('rejects %s', (_label, options, message) => {
    expect(() => resolveConfig(options)).toThrow(TypeError);
    expect(() => resolveConfig(options)).toThrow(message);
  });

  it('still accepts a finite budget of either size', () => {
    expect(resolveConfig({ sandbox: { maxSteps: 1, timeoutMs: 1 } }).sandbox.maxSteps).toBe(1);
    expect(resolveConfig({ sandbox: { maxSteps: 1e12, timeoutMs: 0 } }).sandbox.maxSteps).toBe(1e12);
  });

  for (const preset of PRESETS) {
    it(`refuses the run before a looping decoder is read, ${preset}`, async () => {
      await expect(
        deobfuscate(LOOPING_DECODER, {
          preset,
          sandbox: { maxSteps: Number.NaN, timeoutMs: Number.NaN },
          performance: { timeBudgetMs: 3_000 },
        }),
      ).rejects.toThrow(/sandbox\.maxSteps must be a finite number/);
    });
  }
});
