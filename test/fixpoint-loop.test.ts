import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * The fixpoint loop runs while a round changes something.
 *
 * `performance.maxIterations` is a ceiling and nothing else: a run it cuts
 * short is said to be, at warning severity, and carries `truncated`. Every
 * round opens on scope tables that describe the tree, a stage is due when the
 * tree or the tables moved since it last started, and a quiet round runs the
 * prologue's `unpack` over the moved tree - so a second `deobfuscate()` over
 * the output has nothing left to do.
 */
const STACKED = readFileSync(new URL('./fixtures/stacked-calls-transform-cff.js', import.meta.url), 'utf8');

const CAP_WARNING = /Stopped after (\d+) fixpoint round\(s\) at performance\.maxIterations while the tree was still changing/;

describe('the iteration cap', () => {
  it('a run it cuts short says so and carries truncated', async () => {
    const result = await deobfuscate(STACKED, { preset: 'balanced', performance: { maxIterations: 2 } });
    expect(result.metadata.stats.iterations).toBe(2);
    expect(result.metadata.stats.truncated).toBe(true);
    const warning = result.metadata.diagnostics.find((d) => CAP_WARNING.test(d.message));
    expect(warning?.severity).toBe('warning');
    expect(warning!.message.match(CAP_WARNING)![1]).toBe('2');
    // Cut short is what it says: two rounds peel at most one of the three layers.
    expect(result.code.length).toBeGreaterThan(4_000);
  }, 60_000);

  it('the default runs the stacked build to its quiet round, past the old cap of six', async () => {
    const result = await deobfuscate(STACKED, { preset: 'balanced' });
    expect(result.metadata.stats.iterations).toBeGreaterThanOrEqual(6);
    expect(result.metadata.stats.truncated).toBe(false);
    expect(result.metadata.diagnostics.some((d) => CAP_WARNING.test(d.message))).toBe(false);
    expect(result.code).not.toMatch(/\.push\([\w$]+\.shift\(\)\)/);
  }, 60_000);

  it('a cap the run never reaches is not reported', async () => {
    const result = await deobfuscate(`var a = 1; log(a);`, { preset: 'balanced', performance: { maxIterations: 3 } });
    expect(result.metadata.stats.truncated).toBe(false);
    expect(result.metadata.diagnostics.some((d) => CAP_WARNING.test(d.message))).toBe(false);
  });

  it('zero is a run without the loop, and not a truncated one', async () => {
    const result = await deobfuscate(`var a = 1; log(a);`, { preset: 'balanced', performance: { maxIterations: 0 } });
    expect(result.metadata.stats.iterations).toBe(0);
    expect(result.metadata.stats.truncated).toBe(false);
  });
});

describe('the quiet round runs unpack over the moved tree', () => {
  /**
   * `unpack` ran in the prologue and saw a call whose argument is a
   * concatenation; `simplify.fold-constants` spells it out on the first
   * round, and the quiet round's `unpack` opens it.
   */
  const LATE_WRAPPER = `
    var f = Function('return 4' + '0 + 2;');
    log(f());
  `;

  it.each(['balanced', 'aggressive'] as PresetName[])('%s opens a wrapper the loop spelled out', async (preset) => {
    const result = await deobfuscate(LATE_WRAPPER, { preset });
    expect(result.code).not.toContain('Function(');
    // Opened, and the body folded by the round that followed.
    expect(result.code).toContain('return 42');
    expect(result.metadata.stats.truncated).toBe(false);
    expect(result.metadata.passes.find((p) => p.id === 'unpack.function-constructor')?.changes).toBe(1);
  });

  it('a wrapper the strings stage spells out of a table is opened in the same stage', async () => {
    const source = `
      var _0xa = ['return 40 + 2;', 'alpha', 'beta'];
      function _0xd(i) { return _0xa[i]; }
      var f = Function(_0xd(0));
      log(f(), _0xd(1), _0xd(2));
    `;
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.code).not.toContain('Function(');
    expect(result.code).toContain('return 42');
    expect(result.code).toContain("'alpha'");
    expect(result.metadata.stats.truncated).toBe(false);
  });
});

describe('a second run over the output changes nothing', () => {
  const R = (name: string): string =>
    fileURLToPath(new URL(`../../../${name}`, import.meta.url));
  // `obfuscated5.js` at balanced and aggressive runs for over a minute each
  // way and crosses the time budget on a loaded machine, which no assertion
  // about a settled tree survives; those two cells are measured by hand.
  const CELLS: Array<[string, string, PresetName[]]> = [
    ['lightly-obfuscated.js', R('fixtures/lightly-obfuscated.js'), ['conservative', 'balanced', 'aggressive']],
    ['obfuscated3.js', R('fixtures/obfuscated3.js'), ['conservative', 'balanced', 'aggressive']],
    ['obfuscated5.js', R('obfuscated5.js'), ['conservative']],
  ];

  for (const [name, file, presets] of CELLS) {
    // A sample kept outside the repository is measured only where it is on disk.
    const cell = existsSync(file) ? it : it.skip;
    for (const preset of presets) {
      cell(`${name} at ${preset}`, async () => {
        const source = readFileSync(file, 'utf8');
        const first = await deobfuscate(source, { preset });
        expect(first.metadata.stats.truncated).toBe(false);
        const second = await deobfuscate(first.code, { preset });
        expect(second.metadata.stats.totalChanges).toBe(0);
        expect(second.code).toBe(first.code);
      }, 900_000);
    }
  }
});
