import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * Three layers of obfuscator.io's `stringArrayCallsTransform` under
 * control-flow flattening, two function wrappers per layer, rotated and
 * shuffled (the probe's `modern` program, seeds 20260921..3).
 *
 * Control-flow flattening routes every decoder call through a proxy of the
 * storage object, `m[k](dec, 0x1b3)` with `k` decoded by the layer beneath,
 * so the third layer's decoder is handed to a proxy in every one of its uses
 * until the second layer's strings are inlined and the proxies with them.
 * The slicer reports that as a statement it cannot model, and the refusal
 * used to be final: the 154 KB input came out at 21 KB with one decoder
 * deferred for good. Deferred while the tree keeps moving, and with the loop
 * running while a round changes something, it comes out at a few hundred
 * bytes - and the report carries no verdict from the rounds that refused.
 */
const FIXTURE = readFileSync(new URL('./fixtures/stacked-calls-transform-cff.js', import.meta.url), 'utf8');

/** The program the fixture obfuscates; its trace is the oracle. */
const PROGRAM = `class Vessel { #mask = 170; constructor(hex) { this.hex = hex; } *unmask() { for (const ch of this.hex.match(/../g)) yield (parseInt(ch, 16) ^ this.#mask).toString(16).padStart(2, '0'); } static from(h) { return new Vessel(h); } } const v = Vessel.from('d3cbed8acf'); const out = [...v.unmask()].map(x => x.toUpperCase()).join(':'); const tag = (s, ...a) => s.raw.join('|') + a.length; log(out, tag\`a\${1}b\${2}\`, typeof Vessel, JSON.stringify({ k: [1, 'two', null] }));`;

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

const EXPECTED = execute(PROGRAM);

describe('a callsTransform + CFF build stacked three deep', () => {
  it('the fixture runs as the program it obfuscates', () => {
    expect(EXPECTED).toMatch(/^79:61:47:20:65 /);
    expect(execute(FIXTURE)).toBe(EXPECTED);
  });

  it.each(['balanced', 'aggressive'] as PresetName[])('%s decodes every layer and prunes every table', async (preset) => {
    const result = await deobfuscate(FIXTURE, { preset });
    expect(execute(result.code)).toBe(EXPECTED);
    expect(result.metadata.stats.verified).toBe(true);
    expect(result.metadata.stats.truncated).toBe(false);
    // Coverage, in bytes order: no encoded call, no table, no rotation.
    expect(result.code).not.toMatch(/\b_0x[0-9a-f]+\((0x)?[0-9a-f]+/);
    expect(result.code).not.toMatch(/\.push\([\w$]+\.shift\(\)\)/);
    expect(result.code).not.toMatch(/\[\s*'[^']*',\s*'[^']*',\s*'[^']*'/);
    expect(result.code.length).toBeLessThan(1_200);
    // Six rounds, which the default cap of six used to hit exactly; the loop
    // now stops on the quiet round after the last change.
    expect(result.metadata.stats.iterations).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('conservative runs identically too', async () => {
    const result = await deobfuscate(FIXTURE, { preset: 'conservative' });
    expect(execute(result.code)).toBe(EXPECTED);
    expect(result.metadata.stats.verified).toBe(true);
  }, 60_000);

  it('the report carries no verdict from a round the run has since overturned', async () => {
    const result = await deobfuscate(FIXTURE, { preset: 'balanced' });
    const lines = result.metadata.diagnostics.map((d) => d.message);
    // No decoder is left deferred or refused: every one was adopted.
    expect(lines.some((m) => /^Deferred _0x/.test(m))).toBe(false);
    expect(lines.some((m) => /^Refusing (to evaluate )?_0x/.test(m))).toBe(false);
    expect(lines.some((m) => /a write through a member, a delete or a method call the slice cannot include/.test(m))).toBe(false);
    // Nor a machinery verdict the output no longer bears out.
    expect(lines.some((m) => /^Kept the string-array machinery/.test(m))).toBe(false);
    // Each decoder that stood refused is adopted and said to be, once.
    const adopted = lines.filter((m) => /was deferred or refused on an earlier round and has since been proved/.test(m));
    expect(adopted.length).toBeGreaterThan(0);
    expect(new Set(adopted).size).toBe(adopted.length);
  }, 60_000);
});
