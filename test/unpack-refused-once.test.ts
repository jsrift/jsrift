import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * The unpack stage runs in the prologue and again on the quiet round, over
 * the tree the loop has moved. A wrapper it refused both times is one
 * verdict and one packed shape: the refusal is a standing line per site,
 * and the shape is counted the first time the site is met.
 *
 * Every case runs input and output in a fresh realm with only `log`.
 */
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

const PRESETS: PresetName[] = ['balanced', 'aggressive'];

describe('unpack.function-constructor: a wrapper refused on every round', () => {
  // The concatenation folds on the first round, so the loop runs a second,
  // quiet round, and that round runs the stage again over the same wrapper.
  const STRICT_HOST = `'use strict'; var s = 'a' + 'b'; var f = Function('return 1'); log(f(), s);`;

  it.each(PRESETS)('%s says so once and counts the shape once', async (preset) => {
    const result = await deobfuscate(STRICT_HOST, { preset });
    expect(execute(result.code)).toBe(execute(STRICT_HOST));
    expect(result.metadata.stats.iterations).toBeGreaterThan(1);
    expect(result.code).toContain("Function('return 1')");
    const refusals = result.metadata.diagnostics.filter((d) =>
      /^Function-constructor call sits in strict code/.test(d.message),
    );
    expect(refusals).toHaveLength(1);
    const detections = result.metadata.detections.filter((d) => d.evidence.startsWith('Function constructor'));
    expect(detections).toHaveLength(1);
    expect(detections[0]!.count).toBe(1);
  });
});

describe('unpack.eval-packer: a packer refused on every round', () => {
  const UNPACKER = String.raw`function(p,a,c,k,e,d){e=function(c){return c.toString(a)};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\b'+e(c)+'\b','g'),k[c])}}return p}`;
  // A statement position that is not a list: the packer is matched and left.
  const BRANCH_HOST = `var s = 'a' + 'b'; if (s) eval(${UNPACKER}('0(1)',10,2,'log|s'.split('|'),0,{})); log(s);`;

  it.each(PRESETS)('%s says so once and counts the shape once', async (preset) => {
    const result = await deobfuscate(BRANCH_HOST, { preset });
    expect(execute(result.code)).toBe(execute(BRANCH_HOST));
    expect(result.metadata.stats.iterations).toBeGreaterThan(1);
    const refusals = result.metadata.diagnostics.filter((d) =>
      /^Packer found outside a statement list/.test(d.message),
    );
    expect(refusals).toHaveLength(1);
    const detections = result.metadata.detections.filter((d) => /^base-\d+ packer/.test(d.evidence));
    expect(detections).toHaveLength(1);
    expect(detections[0]!.count).toBe(1);
  });
});
