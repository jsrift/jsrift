import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { obfuscate } from 'javascript-obfuscator';
import { StatementScanCache } from '../src/analysis/slice.js';
import { deobfuscate } from '../src/index.js';

/**
 * Concatenated obfuscator.io programs, each with its own rotated table.
 *
 * Two things went wrong on this shape and neither showed on the many-tables
 * fixture, which has no rotation wrapper. First, every table was refused: the
 * slice's `needed` set holds the builtins the decoder reads, and the *other*
 * program's `push(shift())` wrapper mentions `parseInt` too, so
 * `unmodelledMutation` blamed a rotation that never touches this table. Two
 * default builds pasted together decoded nothing. Second, the mutator search
 * walked every sibling unit twice per candidate, so N tables beside N wrappers
 * cost N² subtree walks - 61 s in `strings.discover` on 512 programs, to
 * decode nothing.
 */

const PROGRAM = `
  function greet(name) { return 'Hello, ' + name + '!'; }
  var cfg = { title: 'widget', sizes: [1, 2, 3], nested: { depth: 2 } };
  function classify(n) { if (n < 0) return 'negative'; switch (n % 3) { case 0: return 'triple'; case 1: return 'one-over'; default: return 'two-over'; } }
  console.log(greet('World'), cfg.title, classify(4));
`;

/** `renameGlobals`, so two builds pasted together share no top-level name and the input itself runs. */
function build(seed: number): string {
  return obfuscate(PROGRAM, {
    seed,
    renameGlobals: true,
    stringArray: true,
    stringArrayRotate: true,
    stringArrayThreshold: 1,
  }).getObfuscatedCode();
}

/** N independent copies of one build, every `_0x...` name suffixed per copy so nothing collides. */
function copies(unit: string, count: number): string {
  return Array.from({ length: count }, (_, i) =>
    unit.replace(/_0x([0-9a-f]{4,6})/g, (_m, h: string) => `_0x${h}${i.toString(16)}`),
  ).join('\n');
}

function execute(code: string): string {
  const out: string[] = [];
  const sandbox: Record<string, unknown> = { console: { log: (...a: unknown[]) => out.push(a.join(' ')) } };
  sandbox['globalThis'] = sandbox;
  vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 10_000 });
  return out.join('\n');
}

describe('strings: rotated tables from concatenated programs', () => {
  it('decodes both tables of two default builds pasted together', async () => {
    const source = `${build(20260904)}\n${build(20260905)}`;
    const expected = execute(source);
    const one = await deobfuscate(build(20260904), { preset: 'balanced' });
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(one.metadata.strings.length).toBeGreaterThan(0);
    expect(result.metadata.strings.length).toBe(one.metadata.strings.length * 2);
    expect(result.metadata.diagnostics.some((d) => /rotation the slice cannot include/.test(d.message))).toBe(false);
    expect(execute(result.code)).toBe(expected);
  });

  it('costs linear work in the number of programs', async () => {
    const unit = build(20260904);
    const perCopy = (await deobfuscate(unit, { preset: 'balanced' })).metadata.strings.length;
    expect(perCopy).toBeGreaterThan(0);

    const small = copies(unit, 64);
    const large = copies(unit, 256);
    // Work is counted, not timed: the rotation scan is the search that went
    // quadratic, and `StatementScanCache` counts every statement it walks. A
    // wall-clock ratio measured 4.93 against a bound of 8 and flaked under
    // load; the count is the same on every machine.
    const once = async (source: string) => {
      const before = StatementScanCache.scansPerformed;
      const result = await deobfuscate(source, { preset: 'balanced', performance: { timeBudgetMs: 120_000 } });
      return { scans: StatementScanCache.scansPerformed - before, result };
    };
    const a = await once(small);
    const b = await once(large);

    // Every table decoded, four times the tables four times the changes.
    expect(a.result.metadata.strings.length).toBe(64 * perCopy);
    expect(b.result.metadata.strings.length).toBe(256 * perCopy);
    expect(b.result.metadata.stats.truncated).toBe(false);
    const changes = b.result.metadata.stats.totalChanges / a.result.metadata.stats.totalChanges;
    expect(changes).toBeGreaterThan(3.5);
    expect(changes).toBeLessThan(4.5);
    // Linear is 4x: each program's handful of statements scanned once per
    // round. The per-candidate walk this replaced scans every sibling once per
    // table, which is 16x over two doublings.
    expect(a.scans).toBeGreaterThan(0);
    expect(b.scans / a.scans).toBeGreaterThan(3.5);
    expect(b.scans / a.scans).toBeLessThan(4.5);
    expect(execute(b.result.code)).toBe(execute(large));
  }, 180_000);
});
