import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * A getter of an object literal that reads the key it answers for off `this`
 * asks the literal for that key from inside the answer. The resolution of a
 * literal's key is one frame that must not re-enter itself, as a binding's
 * already does not: a read that meets the pair in progress is a cut, and the
 * pass goes on to rename everything the cycle does not reach.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  try {
    vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  } catch (error) {
    const err = error as Error;
    lines.push(`THROWN ${err.name}: ${err.message}`);
  }
  return lines.join(' | ');
}

describe('an object-literal getter reading its own key', () => {
  const cases: [string, string][] = [
    [
      'through this, one level down',
      'var h = { inner: { flag: true, get x() { return this.flag ? this.y : this.x; }, y() { return 1; } } }; function _0xf() { return 2; } log(h.inner.x(_0xf));',
    ],
    [
      'through the holder by name',
      'var o = { flag: false, get x() { return this.flag ? o.x : this.y; }, y() { return 3; } }; function _0xf() { return 4; } log(o.x(_0xf));',
    ],
    [
      'two getters reading each other',
      'var o = { get a() { return this.b; }, get b() { return this.a; }, run() { return 5; } }; function _0xf() { return 6; } log(o.run(_0xf));',
    ],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`${title}, ${preset}`, async () => {
        const result = await deobfuscate(source, { preset: preset as DeobfuscateOptions['preset'] });
        const disabled = result.metadata.diagnostics.filter((d) => /Pass disabled/.test(d.message));
        expect(disabled).toEqual([]);
        expect(trace(result.code)).toBe(trace(source));
      });
    }
  }
});
