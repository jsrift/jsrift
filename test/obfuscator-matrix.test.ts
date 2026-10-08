import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { obfuscate, type ObfuscatorOptions } from 'javascript-obfuscator';
import { deobfuscate } from '../src/index.js';

/**
 * The contract this file enforces: for every option javascript-obfuscator
 * exposes, deobfuscating its output must produce a program that *behaves
 * identically to the original*.
 *
 * Behavioural equivalence, not structural similarity, is the right assertion.
 * A structural check passes on output that decoded to the wrong strings; running
 * the program does not. Each case therefore executes three things - the original
 * source, the obfuscated form, and the output - and requires all three to agree.
 */

const PROGRAMS: Record<string, string> = {
  greeting: `
    function greet(name) { return 'Hello, ' + name + '!'; }
    console.log(greet('World'));
  `,
  controlFlow: `
    function classify(n) {
      if (n < 0) return 'negative';
      switch (n % 3) {
        case 0: return 'triple';
        case 1: return 'one-over';
        default: return 'two-over';
      }
    }
    for (var i = -1; i < 5; i++) console.log(i + ':' + classify(i));
  `,
  closures: `
    function counter(start) {
      var n = start;
      return { inc: function () { return ++n; }, get: function () { return n; } };
    }
    var c = counter(10);
    c.inc(); c.inc();
    console.log(c.get());
  `,
  objectsAndArrays: `
    var config = { name: 'widget', sizes: [1, 2, 3], nested: { depth: 2 } };
    var total = config.sizes.reduce(function (a, b) { return a + b; }, 0);
    console.log(config.name + '/' + total + '/' + config.nested.depth);
  `,
  exceptions: `
    function risky(x) {
      try {
        if (x === 0) throw new Error('zero not allowed');
        return 100 / x;
      } catch (e) {
        return e.message;
      } finally {
        void 0;
      }
    }
    console.log(risky(4) + ' | ' + risky(0));
  `,
  stringWork: `
    var parts = 'alpha,beta,gamma'.split(',');
    var out = parts.map(function (p) { return p.toUpperCase(); }).join('-');
    console.log(out + ' ' + /^[A-Z-]+$/.test(out));
  `,
};

/** One entry per javascript-obfuscator option this engine claims to invert. */
const OPTION_CASES: Array<{ name: string; options: ObfuscatorOptions }> = [
  { name: 'stringArray only', options: { stringArray: true, stringArrayThreshold: 1 } },
  {
    name: 'stringArray + base64',
    options: { stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 1 },
  },
  {
    name: 'stringArray + rc4',
    options: { stringArray: true, stringArrayEncoding: ['rc4'], stringArrayThreshold: 1 },
  },
  {
    name: 'stringArray + rotate + shuffle',
    options: {
      stringArray: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
    },
  },
  {
    name: 'stringArrayIndexShift',
    options: { stringArray: true, stringArrayIndexShift: true, stringArrayThreshold: 1 },
  },
  {
    name: 'stringArrayWrappers (variable)',
    options: {
      stringArray: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: 'variable',
      stringArrayWrappersChainedCalls: true,
      stringArrayThreshold: 1,
    },
  },
  {
    name: 'stringArrayWrappers (function)',
    options: {
      stringArray: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: 'function',
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersChainedCalls: true,
      stringArrayThreshold: 1,
    },
  },
  { name: 'splitStrings', options: { splitStrings: true, splitStringsChunkLength: 3 } },
  { name: 'numbersToExpressions', options: { numbersToExpressions: true } },
  { name: 'controlFlowFlattening', options: { controlFlowFlattening: true, controlFlowFlatteningThreshold: 1 } },
  { name: 'deadCodeInjection', options: { deadCodeInjection: true, deadCodeInjectionThreshold: 1, stringArray: true, stringArrayThreshold: 1 } },
  { name: 'transformObjectKeys', options: { transformObjectKeys: true } },
  { name: 'unicodeEscapeSequence', options: { unicodeEscapeSequence: true } },
  { name: 'simplify', options: { simplify: true } },
  { name: 'selfDefending', options: { selfDefending: true, compact: true } },
  { name: 'debugProtection', options: { debugProtection: true } },
  { name: 'disableConsoleOutput off + mangled names', options: { identifierNamesGenerator: 'mangled' } },
  { name: 'dictionary identifier names', options: { identifierNamesGenerator: 'dictionary', identifiersDictionary: ['alpha', 'beta', 'gamma', 'delta'] } },
  {
    name: 'everything (max options)',
    options: {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.6,
      numbersToExpressions: true,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 4,
      stringArray: true,
      stringArrayEncoding: ['rc4'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 2,
      stringArrayWrappersChainedCalls: true,
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersType: 'function',
      stringArrayThreshold: 1,
      transformObjectKeys: true,
      unicodeEscapeSequence: true,
      selfDefending: true,
    },
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'jsrift-matrix-'));
let counter = 0;

function run(code: string): string {
  const file = join(scratch, `case-${counter++}.js`);
  writeFileSync(file, code);
  return execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 20_000 }).trim();
}

describe('javascript-obfuscator option matrix', () => {
  for (const [programName, source] of Object.entries(PROGRAMS)) {
    describe(programName, () => {
      const expected = run(source);

      for (const { name, options } of OPTION_CASES) {
        it(`survives ${name}`, async () => {
          const obfuscated = obfuscate(source, {
            ...options,
            // Keep runs reproducible across CI and machines.
            seed: 20260904,
          }).getObfuscatedCode();

          // Sanity: the obfuscated form must itself still be correct, otherwise
          // a failure below would be the obfuscator's fault, not the engine's.
          expect(run(obfuscated)).toBe(expected);

          const { code, metadata } = await deobfuscate(obfuscated, { preset: 'aggressive' });

          expect(metadata.stats.verified).toBe(true);
          expect(run(code)).toBe(expected);
        });
      }
    });
  }
});

describe('repeated obfuscation', () => {
  it('peels an arbitrary number of stacked layers', async () => {
    const source = PROGRAMS.greeting!;
    const expected = run(source);

    let current = source;
    for (let layer = 0; layer < 4; layer++) {
      current = obfuscate(current, {
        compact: true,
        stringArray: true,
        stringArrayEncoding: ['rc4'],
        stringArrayRotate: true,
        stringArrayThreshold: 1,
        seed: 1000 + layer,
      }).getObfuscatedCode();
    }
    expect(run(current)).toBe(expected);

    const { code, metadata } = await deobfuscate(current, { preset: 'aggressive' });
    expect(metadata.stats.verified).toBe(true);
    expect(run(code)).toBe(expected);
  });
});
