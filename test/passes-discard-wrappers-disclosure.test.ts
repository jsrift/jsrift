import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * The eval-risk note is the only record that a run took the unsound default
 * `functionUnwrapping.refuseOnDirectEval: false` buys - so it has to count what
 * was actually rewritten. It used to count approvals: it said "Unwrapped 1"
 * over a file where the one call site sat under the eval host and was never
 * touched, and it said it twice when `clean.unused`'s crawl made the next round
 * re-prove the same binding.
 */

function disclosures(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics
    .filter((d) => d.source === 'simplify.discard-wrappers' && /Unwrapped \d+/.test(d.message))
    .map((d) => d.message);
}

describe('simplify.discard-wrappers: the eval-risk note counts rewrites', () => {
  it('says nothing when the approved wrapper was never rewritten', async () => {
    const source = `
      function w() {}
      function log(x) { console.log(x); }
      eval("1");
      w(log('arg'));
    `;
    const result = await deobfuscate(source, { preset: 'balanced' });
    // The call sits under the eval host, so the site rule refuses the rewrite.
    expect(result.code).toContain("w(log('arg'))");
    expect(disclosures(result)).toEqual([]);
  });

  it('discloses one rewritten wrapper exactly once across fixpoint rounds', async () => {
    const source = `
      function w() {}
      function log(x) { console.log(x); }
      function host() { eval("1"); w(log('inside')); }
      host();
      w(log('arg'));
    `;
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.metadata.stats.iterations).toBeGreaterThan(1);
    expect(result.code).not.toContain("w(log('arg'))");
    expect(result.code).toContain("w(log('inside'))");
    const notes = disclosures(result);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Unwrapped 1 argument-discarding wrapper /);
  });

  it('is silent where refuseOnDirectEval refuses the binding outright', async () => {
    const source = `
      function w() {}
      function log(x) { console.log(x); }
      function host() { eval("1"); w(log('inside')); }
      host();
      w(log('arg'));
    `;
    const result = await deobfuscate(source, {
      preset: 'balanced',
      techniques: { functionUnwrapping: { refuseOnDirectEval: true } },
    });
    expect(result.code).toContain("w(log('arg'))");
    expect(disclosures(result)).toEqual([]);
  });
});
