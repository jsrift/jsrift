import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult, PresetName } from '../src/types.js';

/**
 * A string table the engine walks away from without a word.
 *
 * Round thirteen's fuzz counted 326 conservative trials that ended with a
 * table fingerprinted, nothing decoded and no `strings.*` line explaining it
 * (117 at the other two presets). Replayed with every severity recorded, 88 of
 * them had NO note at all, and every one of the 88 was the same file: a
 * program with a single string, whose table is `['x8kgjNO']` behind a full
 * rc4 decoder - not a candidate below the two-entry floor, so not a refusal,
 * so not a line. The rest carried a deferral that named the wrong reason and
 * promised a retry the run never made.
 *
 * Each case below is executed, not only inspected: a note is worth having
 * only beside output that still runs the way the input did.
 */

const ALL: readonly PresetName[] = ['conservative', 'balanced', 'aggressive'];

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(' | ');
}

function strings(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics
    .filter((d) => d.source.startsWith('strings.'))
    .map((d) => d.message);
}

describe('a one-entry table behind a decoder is a table', () => {
  const PLAIN = `
    var A = ['only'];
    function dec(i) { return A[i]; }
    log(dec(0));
  `;
  const THUNK = `
    function A() { var a = ['x8kgjNO']; A = function () { return a; }; return A(); }
    function dec(i) { i = i - 0x88; var t = A(); return t[i]; }
    log(dec(0x88));
  `;
  const SPLIT = `
    var A = ['on' + 'ly'];
    function dec(i) { return A[i]; }
    function w(a, b) { return dec(b - 0x10); }
    log(w(1, 0x10));
  `;

  it.each([
    ['a plain array', PLAIN, "log('only')"],
    ['a self-replacing thunk with an index offset', THUNK, "log('x8kgjNO')"],
    ['a split entry read through a wrapper', SPLIT, "log('only')"],
  ])('decodes %s at every preset', async (_name, source, literal) => {
    // Before the floor was lowered for the decoder-mediated shape every one of
    // these came out as it went in, at every preset, and the report said
    // nothing: `strings` empty, no `strings.*` line, the fingerprint alone
    // saying a decoder was there.
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset });
      expect(execute(result.code)).toBe(execute(source));
      expect(result.code).toContain(literal);
      expect(result.code).not.toContain('dec(');
      expect(result.metadata.strings).toHaveLength(1);
    }
  });

  it('does not propose a one-entry array read directly', async () => {
    // The floor stays where it was for the bare `a[0]` shape: a `['x']` in
    // ordinary code is a literal that happens to live in brackets, and nothing
    // about a decoder-less one-entry array says it is a table.
    const source = `var a = ['x'];\nlog(a[0]);\n`;
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset });
      expect(execute(result.code)).toBe('x');
      expect(result.metadata.strings).toHaveLength(0);
      expect(result.metadata.detections.some((d) => d.kind === 'string-array')).toBe(false);
    }
  });
});

describe('a deferral names the reason the evaluator gave', () => {
  it('quotes the host write whose key runs through a call this round cannot read', async () => {
    // What stops the decoder is a `globalThis[...]
    // = ...` whose key is a call to `w` - two statements, so not a forwarder
    // any index reads - and may spell the `decodeURIComponent` the decoder
    // reads. The evaluator says exactly that; the deferral used to replace it
    // with "never with a literal argument", which was false, and to promise
    // a retry the run does not make once nothing else changes.
    const source = `
      var A = ['%61lpha', 'beta', 'gamma'];
      function dec(i) { return decodeURIComponent(A[i]); }
      function w(i) { var s = dec(i - 1); return s; }
      globalThis['dec' + w(2) + 'URIComponent'] = function (s) { return s; };
      log(dec(0), dec(2));
    `;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(execute(result.code)).toBe(execute(source));
    expect(result.metadata.strings).toHaveLength(0);
    const deferred = strings(result).filter((m) => m.startsWith('Deferred dec:'));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatch(/^Deferred dec: the key of `globalThis\[...\] = ...` at line \d+ is computed by a call to w/);
    expect(deferred[0]).toContain('left as written if none changes that');
    expect(deferred[0]).not.toContain('it will be put up again');
    expect(deferred[0]).not.toContain('never with a literal argument');
  });

  it('reads a key that runs through a forwarder of the decoder, and adopts', async () => {
    // The same write with `w` a one-line forwarder: the key is a call the
    // decoder's own tier spells, `'dec' + 'beta' + 'URIComponent'`, which
    // names nothing the decoder reads, so the candidate is adopted - at
    // conservative, since before the write runs the decoder is the one every
    // tier proved - and no deferral is ever said.
    const source = `
      var A = ['%61lpha', 'beta', 'gamma'];
      function dec(i) { return decodeURIComponent(A[i]); }
      function w(i) { return dec(i - 1); }
      globalThis['dec' + w(2) + 'URIComponent'] = function (s) { return s; };
      log(w(1), w(3));
    `;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(execute(result.code)).toBe('alpha gamma');
    expect(execute(result.code)).toBe(execute(source));
    expect(result.code).toContain("'alpha'");
    expect(result.code).toContain("'gamma'");
    expect(result.code).toContain('decbetaURIComponent');
    expect(result.code).not.toMatch(/\bw\(/);
    expect(result.metadata.strings.length).toBeGreaterThanOrEqual(2);
    expect(strings(result).some((m) => m.startsWith('Deferred dec:'))).toBe(false);
    expect(strings(result).some((m) => m.startsWith('Refusing'))).toBe(false);
  });

  it('says where the decoder is called when no call carries a literal', async () => {
    const source = `
      var A = ['alpha', 'beta', 'gamma'];
      function dec(i) { return A[i]; }
      function show(k) { log(dec(k)); }
      show(0); show(2);
    `;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(execute(result.code)).toBe(execute(source));
    const deferred = strings(result).filter((m) => m.startsWith('Deferred dec:'));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatch(
      /^Deferred dec: it is called at line \d+, and no reference to it carries a literal argument or index/,
    );
    expect(deferred[0]).not.toContain('it will be put up again');
  });
});

describe('a table the scan never materialises is still a line', () => {
  it('says the fingerprint saw a shape when an entry is computed, at conservative', async () => {
    // The first entry is an object-map read,
    // which the conservative preset never turns into a literal, so there is
    // no array of string literals to propose - and `prepare.detect` has
    // already reported a decoder shape, so a report with nothing from the
    // string stage claims a table and says nothing about it.
    const source = `
      var m = { k: 'alpha' };
      var A = [m.k, 'beta', 'gamma'];
      function dec(i) { i = i - 0x88; return A[i]; }
      var d = dec;
      log(d(0x88), d(0x89));
    `;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(execute(result.code)).toBe(execute(source));
    expect(result.metadata.detections.some((d) => d.kind === 'string-array-wrapper')).toBe(true);
    expect(result.metadata.strings).toHaveLength(0);
    const seen = strings(result).filter((m) => m.startsWith('The fingerprint saw a string-array shape'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('no array of string literals was found to propose');
  });
});

describe('a site the decoder answers nothing for is counted', () => {
  it('reports an index outside the table and leaves the site as written', async () => {
    // One bad site among ten good ones: the tiers prove the decoder on the
    // pool and adopt it, and the inliner then meets a site it has no string
    // for. That site stays, the survey keeps the machinery for it, and the
    // count says why the site is still there - once, not once per round.
    const source = `
      var A = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
      function dec(i) { return A[i]; }
      log(dec(0), dec(1), dec(2), dec(3), dec(4), dec(5), dec(6), dec(7), dec(8), dec(9), dec(12));
    `;
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset });
      expect(execute(result.code)).toBe(execute(source));
      expect(result.code).toContain("'a9'");
      expect(result.code).toContain('dec(12)');
      expect(result.metadata.strings).toHaveLength(10);
      const counted = strings(result).filter((m) =>
        /^1 decoder reference\(s\) decoded to no string/.test(m),
      );
      expect(counted).toHaveLength(1);
    }
  });
});

describe('a standing verdict is said once per run', () => {
  it('names an unreadable source once at balanced, not once per round', async () => {
    // The object map is there to make the run take a second round - the
    // strings stage runs again on the tree the simplify stage changed - and a
    // second round meets the same frozen table and used to say so again. It
    // sits in a function of its own because a program-scope map is frozen by
    // the same `Function(s)` and would change nothing.
    const source = `
      var A = ['alpha', 'beta', 'gamma'];
      function dec(i) { return A[i]; }
      function boot(s) { Function(s)(); }
      boot('log(1)');
      function pick() { var o = { p: 'q' }; return o.p; }
      log(dec(0), pick());
      log(dec(1));
    `;
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(execute(result.code)).toBe(execute(source));
    expect(result.metadata.stats.iterations).toBeGreaterThan(1);
    const left = strings(result).filter((m) => m.startsWith('Left every reference to dec encoded'));
    const kept = strings(result).filter((m) => m.startsWith('Kept the string-array machinery:'));
    expect(left).toHaveLength(1);
    expect(kept).toHaveLength(1);
  });
});
