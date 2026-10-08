import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { foldNumbersPass } from '../src/passes/prepare/fold-numbers.js';
import { expectEquivalent, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const FIXTURE = thirdPartyFixture('obfuscated3.js');

async function fold(source: string): Promise<{ code: string; changes: number }> {
  const { code, changes } = await runPass(foldNumbersPass, source);
  return { code, changes };
}

/**
 * Run the pass over its own output and report what the second run did.
 *
 * This is the property the pass has to have: the generator prints
 * `t.numericLiteral(-1)` as `-1`, which re-parses as a UnaryExpression over `1`,
 * so folding that shape replaces a node with its own spelling. The tree never
 * settles, `markChanged` fires on every negative literal in the file on every
 * run, and a loop driven by the change count would never terminate.
 */
async function twice(source: string): Promise<{ first: number; second: number; stable: boolean }> {
  const once = await fold(source);
  const again = await fold(once.code);
  return { first: once.changes, second: again.changes, stable: once.code === again.code };
}

describe('prepare.fold-numbers', () => {
  it('folds the arithmetic obfuscator.io writes constants as', async () => {
    expectEquivalent(
      (await fold('var n = -0x3a3 + -0x1 * -0x25a2 + -0x209a;')).code,
      'var n = 357;',
    );
    expectEquivalent((await fold('x = 1 - 5;')).code, 'x = -4;');
    expectEquivalent((await fold('x = ~5;')).code, 'x = -6;');
    expectEquivalent((await fold('x = +1;')).code, 'x = 1;');
    // A negative literal the pass produced is still an operand, so an outer
    // operator folds through it rather than stopping at it.
    expectEquivalent((await fold('x = -(1 - 5);')).code, 'x = 4;');
    expectEquivalent((await fold('x = -(-5);')).code, 'x = 5;');
    expectEquivalent((await fold('x = ~(1 - 5);')).code, 'x = 3;');
  });

  it('reaches a fixpoint: a second run over its own output reports no changes', async () => {
    for (const source of [
      'x = -1;',
      'x = -0x1;',
      'x = -1e21;',
      'x = 1 - 5;',
      'x = ~5;',
      'x = +1;',
      'x = -(1 - 5);',
      'x = f(-1, -2, -3);',
      'x = { a: -1, b: [-2, -3] };',
      'for (var i = -1; i > -10; i--) x[-1] = -2;',
    ]) {
      const { second, stable } = await twice(source);
      expect(second, `${source} still reports changes on a second run`).toBe(0);
      expect(stable, `${source} is not stable`).toBe(true);
    }
  });

  it('leaves a negative literal exactly as written', async () => {
    // The no-op is not free either: folding these rewrites `-1e21` to the
    // longer `-1e+21`, and `-0x1` to `-1`, in `prepare`, where re-spelling a
    // literal is not this pass's job. `simplify.fold-constants` does that, and
    // declines when decimal is the longer form.
    const cases = ['x = -1;', 'x = -0x1;', 'x = -1e21;', 'x = -0.5;'];
    for (const source of cases) {
      const { code, changes } = await fold(source);
      expect(changes, `${source} reported a change`).toBe(0);
      expect(code.trim()).toBe(source);
    }
  });

  it('still reports a change when it makes one', async () => {
    // The fixpoint fix must not be a blanket early-out: the counter has to keep
    // meaning something, or the metric is broken in the other direction.
    expect((await fold('x = 1 - 5;')).changes).toBe(1);
    expect((await fold('x = 0x1 * 0x2 + 0x3;')).changes).toBeGreaterThan(0);
    expect((await fold('x = -1;')).changes).toBe(0);
  });

  it.skipIf(!FIXTURE.present)('reports nothing on a real file it has already folded', async () => {
    // Pass-level, on the engine's own output, which is where the phantom
    // changes actually showed up: the aggressive run of a fixture is full of
    // negative literals precisely because folding produced them.
    const source = FIXTURE.read();
    const { code } = await deobfuscate(source, { preset: 'aggressive' });

    let negatives = 0;
    t.traverseFast(parseSource(code, {}).ast, (node) => {
      if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) {
        negatives++;
      }
    });
    // Not vacuous: if the output held no negative literals this would pass on
    // an empty premise, which is the shape of the bug it is guarding. Measured
    // at 62 on this fixture, and at 14,444 on the aggressive output of
    // obfuscated4.js - without the fixpoint rule every one of them is a phantom
    // change on every run.
    expect(negatives).toBeGreaterThanOrEqual(50);

    const { second, stable } = await twice(code);
    expect(second).toBe(0);
    expect(stable).toBe(true);
  }, 120_000);
});
