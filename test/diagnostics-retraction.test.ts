import { describe, expect, it } from 'vitest';
import { obfuscate } from 'javascript-obfuscator';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { PipelineContext } from '../src/pipeline/context.js';

/**
 * A verdict about one thing is one entry, and the report carries the last.
 *
 * The fixpoint loop judges the same candidate on several rounds, and each
 * round's verdict is about that round's tree. Three shapes used to leave a
 * line the output no longer bore out: a decoder refused for a statement in
 * its way and adopted two rounds later once the statement was rewritten; a
 * table kept for references a later round inlined; a source left encoded
 * for string code a later round read.
 */
describe('PipelineContext: keyed notes', () => {
  function context(): PipelineContext {
    const parsed = parseSource('var a = 1;', {});
    return new PipelineContext(parsed.ast, 'var a = 1;', resolveConfig({}), parsed.language, Date.now() + 1000);
  }

  it('a later note under the same key replaces the earlier one in place', () => {
    const ctx = context();
    ctx.note('info', 'first');
    ctx.note('warning', 'kept: 5 references', undefined, 'k');
    ctx.note('info', 'last');
    ctx.note('warning', 'kept: 2 references', undefined, 'k');
    expect(ctx.diagnostics.map((d) => d.message)).toEqual(['first', 'kept: 2 references', 'last']);
  });

  it('retract withdraws the standing note, and is a no-op for a key never noted', () => {
    const ctx = context();
    ctx.note('warning', 'standing', undefined, 'k');
    ctx.note('info', 'other');
    ctx.retract('k');
    ctx.retract('never');
    expect(ctx.diagnostics.map((d) => d.message)).toEqual(['other']);
    // A note under the key after a retraction is a fresh entry.
    ctx.note('info', 'again', undefined, 'k');
    expect(ctx.diagnostics.map((d) => d.message)).toEqual(['other', 'again']);
  });

  it('a note without a key is never replaced', () => {
    const ctx = context();
    ctx.note('info', 'same text');
    ctx.note('info', 'same text');
    expect(ctx.diagnostics).toHaveLength(2);
  });
});

/** `stringArrayCallsTransform`: every decoder call goes through a proxy of a storage map. */
function callsTransform(source: string, layers: number): string {
  let current = source;
  for (let layer = 1; layer <= layers; layer++) {
    current = obfuscate(current, {
      stringArray: true,
      stringArrayThreshold: 1,
      stringArrayCallsTransform: true,
      stringArrayCallsTransformThreshold: 1,
      seed: 20260920 + layer,
    }).getObfuscatedCode();
  }
  return current;
}

const MODERN = `class Vessel { #mask = 170; constructor(hex) { this.hex = hex; } *unmask() { for (const ch of this.hex.match(/../g)) yield (parseInt(ch, 16) ^ this.#mask).toString(16).padStart(2, '0'); } static from(h) { return new Vessel(h); } } const v = Vessel.from('d3cbed8acf'); const out = [...v.unmask()].map(x => x.toUpperCase()).join(':'); const tag = (s, ...a) => s.raw.join('|') + a.length; log(out, tag\`a\${1}b\${2}\`, typeof Vessel, JSON.stringify({ k: [1, 'two', null] }));`;

describe('the strings stage: the last verdict on a candidate is the one reported', () => {
  it('a table kept for references a later round inlined is not reported as kept', async () => {
    const { code, metadata } = await deobfuscate(callsTransform(MODERN, 2), { preset: 'balanced' });
    expect(code).not.toMatch(/\.push\([\w$]+\.shift\(\)\)/);
    expect(code).not.toMatch(/\b_0x[0-9a-f]+\((0x)?[0-9a-f]+\)/);
    expect(metadata.diagnostics.some((d) => /^Kept the string-array machinery/.test(d.message))).toBe(false);
  }, 60_000);

  it('the machinery deletions of a run are one line with the total', async () => {
    const { metadata } = await deobfuscate(callsTransform(MODERN, 2), { preset: 'balanced' });
    const removed = metadata.diagnostics.filter((d) => /^Removed \d+ declaration\(s\) of string-array machinery/.test(d.message));
    expect(removed).toHaveLength(1);
  }, 60_000);

  it('a source left encoded for string code a later round read is not reported as left', async () => {
    // The wrapper's source is a call to the decoder on round one, so nothing
    // proves what it spells and every site of the table is left; the round
    // after it is spelled out, the settling round opens it, and the sites go.
    const source = `
      var _0xa = ['return 40 + 2;', 'alpha', 'beta'];
      function _0xd(i) { return _0xa[i]; }
      var f = Function(_0xd(0));
      log(f(), _0xd(1), _0xd(2));
    `;
    const { code, metadata } = await deobfuscate(source, { preset: 'balanced' });
    expect(code).toContain("'alpha'");
    expect(metadata.diagnostics.some((d) => /^Left every reference to _0xd encoded/.test(d.message))).toBe(false);
  });
});
