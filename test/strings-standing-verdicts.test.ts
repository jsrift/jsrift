import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * The strings stage's verdicts stand per subject, not per round. A table kept
 * for a reason a later round removes, a count of sites left as-is that a
 * later round lowers: each is one line in the report, the last round's, and
 * withdrawn when the output no longer bears it out.
 *
 * Every case runs input and output in a fresh realm with only `log` and
 * compares the traces.
 */
const ALL: PresetName[] = ['conservative', 'balanced', 'aggressive'];

function execute(code: string): string {
  const out: string[] = [];
  try {
    vm.runInNewContext(code, vm.createContext({ log: (...a: unknown[]) => out.push(a.map(String).join(' ')) }), {
      timeout: 5_000,
    });
  } catch (error) {
    out.push(`THROWN ${(error as Error).name}`);
  }
  return out.join('\n');
}

const KEPT = /^Kept the string-array machinery/;
const REMOVED = /^Removed \d+ declaration\(s\) of string-array machinery/;
const NON_CONSTANT = /^(\d+) decoder call site\(s\) had non-constant arguments/;

describe('strings.prune-decoders: the reason the machinery is kept', () => {
  it.each(['balanced', 'aggressive'] as const)(
    '%s withdraws the string-code reason once the source is read and the machinery removed',
    async (preset) => {
      // The join folds on the first round; the wrapper is then a source that
      // spells nothing the table answers to, and the machinery goes.
      const source = `
        var A = ['alpha', 'beta', 'gamma'];
        function dec(i) { return A[i]; }
        Function(['lo', 'g("compiled")'].join(''))();
        log(dec(0), dec(1));
      `;
      const { code, metadata } = await deobfuscate(source, { preset });
      expect(execute(code)).toBe(execute(source));
      expect(code).not.toMatch(/function dec\b/);
      const lines = metadata.diagnostics.map((d) => d.message);
      expect(lines.some((m) => REMOVED.test(m))).toBe(true);
      expect(lines.some((m) => KEPT.test(m))).toBe(false);
    },
  );

  it.each(['balanced', 'aggressive'] as const)(
    '%s withdraws the hoisting reason once the outside use is deleted',
    async (preset) => {
      const source = `
        var A = ['alpha', 'beta', 'gamma'];
        { function dec(i) { return A[i]; } log(dec(0)); }
        if (false) { log(dec(1)); }
        log(A.length);
      `;
      const { code, metadata } = await deobfuscate(source, { preset });
      expect(execute(code)).toBe(execute(source));
      expect(code).not.toMatch(/function dec\b/);
      const lines = metadata.diagnostics.map((d) => d.message);
      expect(lines.some((m) => REMOVED.test(m))).toBe(true);
      expect(lines.some((m) => KEPT.test(m))).toBe(false);
    },
  );

  it.each(ALL)('%s states the hoisting reason once when the outside use stays', async (preset) => {
    // The map gives the run a second round; the second round meets the same use.
    const source = `
      var A = ['alpha', 'beta', 'gamma'];
      { function dec(i) { return A[i]; } log(dec(0)); }
      var o = { p: 'q' }; log(o.p);
      log(dec(1));
    `;
    const { code, metadata } = await deobfuscate(source, { preset });
    expect(execute(code)).toBe(execute(source));
    expect(code).toMatch(/function dec\b/);
    const kept = metadata.diagnostics.filter((d) => KEPT.test(d.message) && /block-level declaration/.test(d.message));
    expect(kept).toHaveLength(1);
  });
});

describe('strings.inline: the count of sites left as-is', () => {
  const SOURCE = `
    var A = ['alpha', 'beta', 'gamma', 'delta'];
    function dec(i) { return A[i]; }
    function f(i, j) { var U = { c: 0, d: 1 }; return dec(U.c) + dec(U.d) + dec(i) + dec(j) + dec(i + 1); }
    log(f(2, 3), dec(0));
  `;

  it.each(ALL)('%s is one line, with the last round\'s count', async (preset) => {
    const { code, metadata } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    const counts = metadata.diagnostics
      .map((d) => NON_CONSTANT.exec(d.message))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    expect(counts).toHaveLength(1);
    const remaining = (code.match(/\bdec\(/g) ?? []).length - 1;
    expect(counts[0]).toBe(remaining);
  });

  it.each(['balanced', 'aggressive'] as const)('%s withdraws the line once every site is a literal', async (preset) => {
    const source = `
      var A = ['alpha', 'beta', 'gamma'];
      function dec(i) { return A[i]; }
      function f() { var U = { c: 0, d: 1 }; return dec(U.c) + dec(U.d); }
      log(f(), dec(2));
    `;
    const { code, metadata } = await deobfuscate(source, { preset });
    expect(execute(code)).toBe(execute(source));
    expect(code).not.toMatch(/\bdec\(/);
    expect(metadata.diagnostics.some((d) => NON_CONSTANT.test(d.message))).toBe(false);
  });
});
