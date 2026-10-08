import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * `stats.verified` is one bit, and three things set it false: the output did
 * not re-parse, the re-parse ran out of stack, or nobody asked for it.
 * `stats.verification` says which, so a reader that paints "did not re-parse"
 * paints it only when that is what happened.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

const SOURCE = "var _0x1 = ['alpha', 'beta']; function d(i) { return _0x1[i]; } log(d(0) + '-' + d(1));";

function trace(code: string): string {
  const lines: string[] = [];
  vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  return lines.join(' | ');
}

describe('stats.verification', () => {
  for (const preset of PRESETS) {
    it(`is 'ok' when the output re-parsed, ${preset}`, async () => {
      const result = await deobfuscate(SOURCE, { preset });
      expect(result.metadata.stats.verification).toBe('ok');
      expect(result.metadata.stats.verified).toBe(true);
      expect(trace(result.code)).toBe(trace(SOURCE));
    });

    it(`is 'skipped', not a failure, when verification is off, ${preset}`, async () => {
      const checked = await deobfuscate(SOURCE, { preset });
      const result = await deobfuscate(SOURCE, { preset, performance: { verifyOutput: false } });
      expect(result.metadata.stats.verification).toBe('skipped');
      expect(result.metadata.stats.verified).toBe(false);
      expect(result.metadata.diagnostics.filter((d) => /re-parse|verified/.test(d.message))).toEqual([]);
      expect(result.code).toBe(checked.code);
      expect(trace(result.code)).toBe(trace(SOURCE));
    });
  }

  it("is 'invalid' when the output does not re-parse under the pinned sourceType", async () => {
    const result = await deobfuscate("import x from 'y'; log(x);", { sourceType: 'script' });
    expect(result.metadata.stats.verification).toBe('invalid');
    expect(result.metadata.stats.verified).toBe(false);
    expect(
      result.metadata.diagnostics.some((d) => d.severity === 'error' && d.message.startsWith('Generated output did not re-parse')),
    ).toBe(true);
  });
});
