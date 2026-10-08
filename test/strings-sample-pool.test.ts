import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * Which call sites `strings.discover` hands `buildDecoder` to prove a
 * candidate on.
 *
 * The cross-check between the native and interpreter tiers can only compare
 * the sites it is given, and the index in `passes/strings/discover.ts` used
 * to give it the first thirty-two distinct sites in file order. A native
 * reading that is wrong at one site - a piecewise index offset the offset
 * recogniser folds in unconditionally - was confirmed on thirty-two sites
 * ahead of that one and inlined, at every preset, conservative included.
 * The pool is now every distinct site of the scope, its head spread across
 * the argument range, and the cross-check compares every site of it up to a
 * budget of its own, choosing by what the native reading looks like past
 * that.
 *
 * Every case runs input and output in a fresh realm with only `log` and
 * compares the traces; the disagreement is asserted in the notes so a case
 * that passed because the native tier stopped recognising the decoder - no
 * reading to be wrong - fails here rather than reading as caught.
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

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

/**
 * A base64 decoder whose index offset is piecewise: `i = i + 1` runs outside
 * `[lo, hi]`, so the native reading - which applies it everywhere - is one
 * element off inside the region and right everywhere else - or, with no
 * region, a plain offset the native reading gets right. Followed by one call
 * per element, in index order, which is file order.
 */
function piecewiseOffsetProgram(
  texts: readonly string[],
  region: { lo: number; hi: number } | null,
  sites: number,
): string {
  const encoded = texts.map((text) =>
    JSON.stringify(Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '')),
  );
  const calls = Array.from({ length: sites }, (_, k) => `log(_0xdec(0x${(0x7a + k).toString(16)}));`);
  const offset = region ? `if (_0x1 < ${region.lo} || _0x1 > ${region.hi}) { _0x1 = _0x1 + 1; }` : '';
  return `
    var _0xarr = [${encoded.join(', ')}];
    function _0xdec(_0x1) {
      _0x1 = _0x1 - 0x7a;
      ${offset}
      var _0x2 = _0xarr[_0x1];
      var _0x3 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      var _0x4 = '', _0x5 = '';
      for (var _0x6 = 0, _0x7, _0x8, _0x9 = 0; _0x8 = _0x2['charAt'](_0x9++); ~_0x8 && (_0x7 = _0x6 % 4 ? _0x7 * 64 + _0x8 : _0x8, _0x6++ % 4) ? _0x4 += String['fromCharCode'](255 & _0x7 >> (-2 * _0x6 & 6)) : 0) {
        _0x8 = _0x3['indexOf'](_0x8);
      }
      for (var _0xa = 0, _0xb = _0x4['length']; _0xa < _0xb; _0xa++) {
        _0x5 += '%' + ('00' + _0x4['charCodeAt'](_0xa)['toString'](16))['slice'](-2);
      }
      return decodeURIComponent(_0x5);
    }
    ${calls.join('\n')}
  `;
}

function texts(count: number, special: Record<number, string> = {}): string[] {
  return Array.from({ length: count }, (_, i) => special[i] ?? `s${i}`);
}

async function expectSameBehaviour(source: string, expected: string): Promise<DeobfuscateResult[]> {
  const before = execute(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  const results: DeobfuscateResult[] = [];
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset });
    const after = execute(result.code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
      );
    }
    results.push(result);
  }
  return results;
}

function expectDisagreementNoted(results: readonly DeobfuscateResult[], native: string, interpreted: string): void {
  for (const result of results) {
    const noted = result.metadata.diagnostics.some(
      (d) =>
        d.severity === 'error' &&
        d.message.includes(`native produced ${JSON.stringify(native)}`) &&
        d.message.includes(`the interpreter produced ${JSON.stringify(interpreted)}`),
    );
    expect(noted, `the tiers must be seen to disagree; got:\n${result.metadata.diagnostics.map((d) => d.message).join('\n')}`).toBe(true);
  }
}

/** What the program prints: element k + 1 outside the region, element k inside it or without one. */
function trace(all: readonly string[], region: { lo: number; hi: number } | null, sites: number): string {
  return Array.from({ length: sites }, (_, k) =>
    region && (k < region.lo || k > region.hi) ? all[k + 1]! : all[k]!,
  ).join(', ');
}

describe('the sites a candidate is proved on reach past the first thirty-two of the file', () => {
  it('a wrong reading whose native string is non-ASCII, at the thirty-sixth site', async () => {
    // The one site a byte-mode misread shows on. Thirty-two ASCII sites ahead
    // of it confirmed the native reading and inlined 'ünï' where the program
    // prints 's35'.
    const all = texts(41, { 36: 'ünï' });
    const source = piecewiseOffsetProgram(all, { lo: 35, hi: 35 }, 40);
    const results = await expectSameBehaviour(source, trace(all, { lo: 35, hi: 35 }, 40));
    expectDisagreementNoted(results, 'ünï', 's35');
  });

  it('a wrong reading whose native string carries a percent sign', async () => {
    const all = texts(41, { 36: 'a%b' });
    const source = piecewiseOffsetProgram(all, { lo: 35, hi: 35 }, 40);
    const results = await expectSameBehaviour(source, trace(all, { lo: 35, hi: 35 }, 40));
    expectDisagreementNoted(results, 'a%b', 's35');
  });

  it('a wrong reading at the last site, every string ASCII', async () => {
    // Nothing about the native string tells; the site is reached because the
    // extremes of the argument range are always among the sites checked.
    const all = texts(41);
    const source = piecewiseOffsetProgram(all, { lo: 39, hi: 39 }, 40);
    const results = await expectSameBehaviour(source, trace(all, { lo: 39, hi: 39 }, 40));
    expectDisagreementNoted(results, 's40', 's39');
  });

  it('a sound decoder with more sites than the pool head is still inlined natively', async () => {
    // The control: a larger pool is more evidence, not a stricter verdict.
    const all = texts(41);
    const source = piecewiseOffsetProgram(all, null, 40);
    const results = await expectSameBehaviour(source, trace(all, null, 40));
    for (const result of results) {
      expect(result.code).toContain("log('s39')");
      expect(result.code).not.toContain('_0xdec(');
      expect(result.metadata.diagnostics.some((d) => d.message.includes('disagree'))).toBe(false);
    }
  });
});

describe('the pool is every distinct site of the scope, not the first few hundred', () => {
  // The pool used to stop at 256 sites in file order, and the cross-check can
  // only choose among what it is handed: a reading wrong at the 290th site
  // was proved on the 256 ahead of it and inlined at every preset.

  it('a wrong reading whose native string is non-ASCII, at the 290th site', async () => {
    const all = texts(301, { 291: 'ünï' });
    const source = piecewiseOffsetProgram(all, { lo: 290, hi: 290 }, 300);
    const results = await expectSameBehaviour(source, trace(all, { lo: 290, hi: 290 }, 300));
    expectDisagreementNoted(results, 'ünï', 's290');
  });

  it('a wrong reading at the 300th site, every string ASCII', async () => {
    // Only the extremes of the argument range reach it, and the extremes are
    // of the whole pool, not of its first 256 sites.
    const all = texts(301);
    const source = piecewiseOffsetProgram(all, { lo: 299, hi: 299 }, 300);
    const results = await expectSameBehaviour(source, trace(all, { lo: 299, hi: 299 }, 300));
    expectDisagreementNoted(results, 's300', 's299');
  });

  it('a wrong reading at a site nothing singles out, every string ASCII', async () => {
    // Site fifty of a hundred: not an extreme, not a range pick, and no
    // non-ASCII character to make it telling. It is caught only because the
    // cross-check compares every site the pool holds.
    const all = texts(101);
    const source = piecewiseOffsetProgram(all, { lo: 50, hi: 50 }, 100);
    const results = await expectSameBehaviour(source, trace(all, { lo: 50, hi: 50 }, 100));
    expectDisagreementNoted(results, 's51', 's50');
  });

  it('a sound decoder with three hundred sites is inlined natively, with no disagreement', async () => {
    const all = texts(301);
    const source = piecewiseOffsetProgram(all, null, 300);
    const results = await expectSameBehaviour(source, trace(all, null, 300));
    for (const result of results) {
      expect(result.code).toContain("log('s299')");
      expect(result.code).not.toContain('_0xdec(');
      expect(result.metadata.diagnostics.some((d) => d.message.includes('disagree'))).toBe(false);
    }
  });
});
