import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * A name the slice needs is resolved from the level whose unit read it. A
 * program-level helper the decoder calls reads the program's binding of a
 * name, never the `const` of the block the decoder sits in, however the two
 * are spelled; resolved from the block, the shadow was evaluated in the
 * helper's place, and the live declarations beside it were taken for the
 * decoder's machinery.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  return lines.join(' | ');
}

const SOURCE = `
var tn = 'outer';
function helper(word) { return tn + ':' + word; }
var T = ['alpha', 'beta'];
if (T) {
  const tn = 'inner';
  const other = tn.length;
  function dec(i) { return helper(T[i]); }
  log(dec(0), dec(1), tn, other);
}
`;

describe('a decoder inside a block that shadows a name its helper reads', () => {
  for (const preset of PRESETS) {
    it(`prints what the program prints at ${preset}`, async () => {
      const { code } = await deobfuscate(SOURCE, { preset });
      expect(trace(code)).toBe(trace(SOURCE));
      expect(trace(code)).toBe('outer:alpha outer:beta inner 5');
    });
  }

  it('keeps the block declarations the decoder does not use', async () => {
    const { code } = await deobfuscate(SOURCE, { preset: 'balanced' });
    expect(code).toContain("'inner'");
  });
});
