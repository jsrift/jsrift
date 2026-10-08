import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

/**
 * Four copies of the same program, each produced by feeding the previous one
 * back through obfuscator.io. Every layer adds its own string table, its own
 * accessor and its own rotation wrapper - and crucially, each table's *contents*
 * are calls into the layer beneath it, so the layers can only be peeled in order.
 *
 * The oracle is execution: whatever comes out must still print "Hello, World!".
 * That catches a class of failure no structural assertion can - output that
 * looks plausible but decoded to the wrong strings.
 */
const LAYERS = [1, 2, 3, 4] as const;
const EXPECTED_OUTPUT = 'Hello, World!';

const layerFixture = (layer: number) => thirdPartyFixture(`layered/layer${layer}.js`);

function fixture(layer: number): string {
  return layerFixture(layer).read();
}

function run(code: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsrift-'));
  const file = join(dir, `${label}.js`);
  writeFileSync(file, code);
  return execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 20_000 }).trim();
}

describe.skipIf(LAYERS.some((layer) => !layerFixture(layer).present))('stacked obfuscation layers', () => {
  it.each(LAYERS)('layer%i still behaves identically after deobfuscation', async (layer) => {
    const source = fixture(layer);
    expect(run(source, `input${layer}`)).toBe(EXPECTED_OUTPUT);

    const { code, metadata } = await deobfuscate(source, { preset: 'aggressive' });

    expect(metadata.stats.verified).toBe(true);
    expect(run(code, `output${layer}`)).toBe(EXPECTED_OUTPUT);
  });

  it.each(LAYERS)('layer%i recovers the original string literals', async (layer) => {
    const { code } = await deobfuscate(fixture(layer), { preset: 'aggressive' });
    expect(code).toContain('Hello, ');
    expect(code).toContain('World');
    expect(code).toContain('log');
  });

  it.each(LAYERS)('layer%i leaves no string-table machinery behind', async (layer) => {
    const { code } = await deobfuscate(fixture(layer), { preset: 'aggressive' });

    // Every layer's accessor, table and rotation wrapper must be gone. If any
    // survives, a layer was not peeled.
    expect(code).not.toMatch(/parseInt\(/);
    expect(code).not.toMatch(/\bshift\b/);
    expect(code).not.toMatch(/while\s*\(\s*!!\s*\[\s*\]\s*\)/);
  });

  it('reduces every layer depth to the same program', async () => {
    const outputs = await Promise.all(
      LAYERS.map(async (layer) => {
        const { code } = await deobfuscate(fixture(layer), { preset: 'aggressive' });
        return code.replace(/\s+/g, ' ').trim();
      }),
    );

    // The layers are the same source obfuscated N times, so full recovery must
    // converge on one result regardless of depth.
    for (const output of outputs) {
      expect(output).toBe(outputs[0]);
    }
  });

  it('reports the stacked string tables it found', async () => {
    const { metadata } = await deobfuscate(fixture(4), { preset: 'aggressive' });
    const arrays = metadata.detections.filter((d) => d.kind === 'string-array');
    expect(arrays.length).toBeGreaterThan(0);
    expect(metadata.strings.length).toBeGreaterThan(0);
  });
});
