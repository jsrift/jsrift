import vm from 'node:vm';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { foldNumbersPass } from '../src/passes/prepare/fold-numbers.js';
import { runPass } from './helpers.js';

/**
 * A folded negative has to come out as the grammar's own shape - `-` over a
 * non-negative literal - never as a NumericLiteral whose `value` is negative.
 *
 * The parser never produces the latter, and the generator prints it as the
 * bare digits with a sign in front, without the parentheses a UnaryExpression
 * gets where the position needs them. Every shape below is a position that
 * needs them: the left operand of `**` (`-3 ** x` is a SyntaxError), the object
 * of a member access (`-3 .toFixed(x)` parses as `-(3 .toFixed(x))` and runs),
 * and an outer `-` that a later fold exposes (`--3` is a prefix decrement). The
 * middle one is the worst outcome the engine has: it parses, it runs, it is
 * reported verified, and it computes a different value.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

const CASES: { source: string; expected: string }[] = [
  { source: 'var x = 5; log((1 - 4) ** x);', expected: '-243' },
  { source: 'var x = 2; log((~2).toFixed(x));', expected: '-3.00' },
  { source: 'var x = 16; log((0.1 - 0.2)["toString"](x));', expected: '-0.1999999999999a' },
  { source: 'var x = 5; log((~2)[x]);', expected: 'undefined' },
  { source: 'log((1 - 4)?.toString());', expected: '-3' },
  { source: 'var n = 1; log(-((1 - 4) || n));', expected: '3' },
  { source: 'log((2 - 5) ** 2, (-0x1 * 0x3).toString(2));', expected: '9 -11' },
];

function negativeLiterals(code: string): number {
  let count = 0;
  t.traverseFast(parseSource(code, {}).ast, (node) => {
    if (t.isNumericLiteral(node) && node.value < 0) count++;
  });
  return count;
}

describe('prepare.fold-numbers: a negative result is `-` over a literal, never a negative literal', () => {
  it('keeps every shape behaviourally identical when run in isolation', async () => {
    for (const { source, expected } of CASES) {
      expect(execute(source), `fixture ${source}`).toBe(expected);
      const { code } = await runPass(foldNumbersPass, source);
      expect(execute(code), `after fold-numbers: ${code}`).toBe(expected);
    }
  });

  it('never leaves a negative-valued NumericLiteral in the tree', async () => {
    const { code, ctx } = await runPass(foldNumbersPass, CASES.map((c) => c.source).join('\n'));
    expect(ctx.totalChanges).toBeGreaterThan(0);
    // The printed output re-parses as unary minus, so the tree is inspected
    // through the printer only indirectly: the parenthesised spellings are the
    // proof that the generator saw a UnaryExpression.
    expect(code).toContain('(-3) ** x');
    expect(code).toContain('(-3).toFixed(x)');
    expect(code).toContain('(-3)[x]');
    expect(negativeLiterals(code)).toBe(0);
  });

  it('holds through the whole pipeline at conservative, the preset that promises identity', async () => {
    for (const { source, expected } of CASES) {
      const result = await deobfuscate(source, { preset: 'conservative' });
      expect(result.metadata.stats.verified, `verified: ${result.code}`).toBe(true);
      expect(execute(result.code), `conservative output: ${result.code}`).toBe(expected);
    }
  });

  it('still folds an outer operator through the negative it just produced', async () => {
    const { code } = await runPass(foldNumbersPass, 'x = -(1 - 5); y = ~(1 - 5); z = -(-5);');
    expect(code.replace(/\s+/g, ' ').trim()).toBe('x = 4; y = 3; z = 5;');
  });
});
