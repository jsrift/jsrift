import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * A bare block that ends in a `return` ends the list it stands in. What
 * follows it is unreachable in the round the loop sees the shape, not only
 * after `finalize` flattens the braces, so one run settles it and a second
 * run has nothing left to do.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  return lines.join(' | ');
}

const SOURCE = `
function f(e) {
  { log(e); return e + 1; }
  var a;
  var b;
}
log(f(1));
`;

describe('a block that ends in a terminator', () => {
  for (const preset of PRESETS) {
    it(`is settled in one run at ${preset}`, async () => {
      const first = await deobfuscate(SOURCE, { preset });
      expect(trace(first.code)).toBe(trace(SOURCE));
      expect(first.code).not.toMatch(/return[^;]*;\s*var a;\s*var b;/);
      const second = await deobfuscate(first.code, { preset });
      expect(second.metadata.stats.totalChanges).toBe(0);
      expect(second.code).toBe(first.code);
    });
  }
});
