import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MAX_ALIAS_DEPTH } from '../src/analysis/string-array.js';
import { deobfuscate } from '../src/index.js';

/**
 * A table read only through a chain of `var b = a` aliases. The reference
 * audit followed such a chain to a fixed point while the call-site index
 * stopped four links out, so a five-link chain had two inlinable reads by
 * the audit's count and no sample for a decoder to be proved on: refused,
 * with only the run's generic "none produced a usable decoder" to show for
 * it, where the September engine inlined both reads (round eleven,
 * chk/r1/adj/3e-five-hop-alias.js). The two walks now share one bound, and a
 * chain past it is refused by the audit with the link named.
 *
 * Every case runs input and output in a fresh realm with only `log`.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(', ');
}

/** `var a0 = [...]; var a1 = a0; ... var aN = aN-1; log(aN[0x1], aN[0x2]);` */
function chained(links: number): string {
  const lines = [`var a0 = ['alpha', 'beta', 'gamma'];`];
  for (let k = 1; k <= links; k++) lines.push(`var a${k} = a${k - 1};`);
  lines.push(`log(a${links}[0x1], a${links}[0x2]);`);
  return lines.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

describe('strings.discover: a table read through an alias chain', () => {
  it.each([1, 4, 5, MAX_ALIAS_DEPTH])('is inlined through %i link(s) at every preset', async (links) => {
    const source = chained(links);
    for (const preset of PRESETS) {
      const { code } = await deobfuscate(source, { preset });
      expect(execute(code), preset).toBe(execute(source));
      // The literals at the call site, not merely in the table, which is left
      // in place only when the reads were not inlined; and no computed read of
      // any name, since the renamer gives the aliases names the pattern `a\d+`
      // would not catch.
      expect(code, preset).toContain(`log('beta', 'gamma')`);
      expect(code, preset).not.toMatch(/\w+\[(0x)?[12]\]/);
    }
  });

  it('is refused past the bound, with the link named, at every preset', async () => {
    const source = chained(MAX_ALIAS_DEPTH + 1);
    const deep = new RegExp(
      `^Refusing to inline a0: 1 reference\\(s\\) could change the array before it is read ` +
        `\\(a0 is aliased more than ${MAX_ALIAS_DEPTH} links deep at line ${MAX_ALIAS_DEPTH + 2}, ` +
        `past where its references are followed\\)`,
    );
    for (const preset of PRESETS) {
      const { code, metadata } = await deobfuscate(source, { preset });
      expect(execute(code), preset).toBe(execute(source));
      // Left as reads of the table, under whatever name the renamer gives it.
      expect(code, preset).toMatch(/log\(\w+\[(0x)?1\], \w+\[(0x)?2\]\)/);
      expect(metadata.diagnostics.some((d) => deep.test(d.message)), preset).toBe(true);
    }
  });

  it('says so when the audit clears a table the index found no read of', async () => {
    // A `var` in a bare block is the block's candidate and the function's
    // binding: its reads sit outside the scope the index samples, and the
    // audit, which follows the binding, counts every one of them.
    const source = `
      function f() {
        { var t = ['alpha', 'beta', 'gamma']; }
        log(t[0x1], t[0x2]);
      }
      f();
    `;
    for (const preset of PRESETS) {
      const { code, metadata } = await deobfuscate(source, { preset });
      expect(execute(code), preset).toBe(execute(source));
      expect(
        metadata.diagnostics.some((d) =>
          /^Left t as written: its reference audit passes, but no read of it with a constant index was collected/.test(
            d.message,
          ),
        ),
        preset,
      ).toBe(true);
    }
  });
});
