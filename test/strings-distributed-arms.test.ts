import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * A decoder argument that is a conditional of literals, `dec(p ? 0xce :
 * 0xcf)`, is two sites behind one test. The inliner puts the test outside
 * the call and a literal in each arm; the pool a candidate is proved on holds
 * the arms as the sites they are, so a decoder called only that way is still
 * proved on something. Each arm is placed by the site's own proof, inlined in
 * the round the site is met, and counted once.
 *
 * Every case runs input and output in a fresh realm with only `log`.
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

const TABLE = `var A = ['alpha', 'beta', 'gamma', 'delta'];\nfunction dec(i) { return A[i]; }\n`;

describe('strings.inline: a conditional of literals as the decoder argument', () => {
  const ALIASED = `${TABLE}
    function f(p) { var d = dec; return d(p ? 0 : 1) + '|' + d(p ? 2 : 3); }
    log(f(true), f(false), dec(0));
  `;

  /** A call with one numeric literal argument: a decoder site left as written, under whatever name the run gives it. */
  const LITERAL_CALL = /\b\w+\(\d+\)/;

  it.each(ALL)('%s inlines every arm in the round the site is met', async (preset) => {
    const { code } = await deobfuscate(ALIASED, { preset, performance: { maxIterations: 1 } });
    expect(execute(code)).toBe(execute(ALIASED));
    expect(code).toMatch(/\? 'alpha' : 'beta'/);
    expect(code).toMatch(/\? 'gamma' : 'delta'/);
    expect(code).not.toMatch(LITERAL_CALL);
  });

  it.each(ALL)('%s reports no unplaced reference for an arm', async (preset) => {
    const { code, metadata } = await deobfuscate(ALIASED, { preset });
    expect(execute(code)).toBe(execute(ALIASED));
    expect(code).not.toMatch(LITERAL_CALL);
    expect(metadata.strings.length).toBeGreaterThanOrEqual(5);
    expect(metadata.diagnostics.some((d) => /could not be placed/.test(d.message))).toBe(false);
  });

  it.each(ALL)('%s counts an arm outside the table once', async (preset) => {
    const source = `${TABLE}
      function f(p) { return dec(p ? 0 : 9); }
      log(f(true), f(false), dec(1));
    `;
    const { code, metadata } = await deobfuscate(source, { preset });
    expect(execute(code)).toBe(execute(source));
    expect(code).toMatch(/\? 'alpha' : \w+\(9\)/);
    const counted = metadata.diagnostics.filter((d) =>
      /^1 decoder reference\(s\) decoded to no string/.test(d.message),
    );
    expect(counted).toHaveLength(1);
  });

  it.each(ALL)('%s proves a decoder on the arms when no call carries a plain literal', async (preset) => {
    const source = `${TABLE}
      function f(p, q) { return dec(p ? 0 : 1) + dec(q ? 2 : p ? 3 : 0); }
      log(f(true, false), f(false, true), f(false, false));
    `;
    const { code, metadata } = await deobfuscate(source, { preset });
    expect(execute(code)).toBe(execute(source));
    expect(code).not.toMatch(LITERAL_CALL);
    expect(code).toMatch(/\? 'gamma' : \w+ \? 'delta' : 'alpha'/);
    expect(metadata.diagnostics.some((d) => /^Deferred dec\b/.test(d.message))).toBe(false);
  });
});
