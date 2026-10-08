import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { discoverStringSources, discoverStringsPass, hasUndiscoveredSource, programPathOf } from '../src/passes/strings/discover.js';
import { runPass } from './helpers.js';

/**
 * A decoder that is called, and never with a literal argument, is refused:
 * there is no site to prove it on. That refusal used to be remembered like
 * every other, in `strings.discover`'s `seen`, and it is the one refusal
 * that is not a verdict on the candidate. The argument is only not a literal
 * *yet* - `b(U.c)` with `U = l; l.c = 0x12b` is a site the object-map pass
 * exposes in the same round, and the rotation IIFE proxied through the same
 * map comes out beside it - so the round after is exactly when the candidate
 * becomes provable, with the rotation in its slice. Remembered, the file's
 * strings stayed encoded; before that, adopted on nothing, they were decoded
 * against the unrotated table, which is the divergence this program is the
 * reduction of (round ten, m5.json#1219: `fn:nm` printed for `2nm`).
 *
 * Every case runs input and output in a fresh realm with only `log` and
 * compares the traces.
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

/**
 * The table getter, the index-shift decoder, and a rotation IIFE whose every
 * operation - the call, the apply, `push`, `shift` - goes through an object
 * map, as does the one call site's argument. Rotation stops when `b(0x128)`
 * reads `'3'`, two shifts in, so `b(0x12b)` is `'2'`: the unrotated reading
 * is `'fn:'`.
 */
const PROXIED_ROTATION = `
  function a() {
    var z = ['1', '2', '3', 'fn:'];
    a = function () { return z; };
    return a();
  }
  function b(P) {
    P = P - 296;
    var U = a(), w = U[P];
    return w;
  }
  var w = { push: 'push', shift: 'shift', call: function (q) { return q(); }, apply: function (q, M) { return q(M); } };
  (function (z, U) {
    var k = {};
    k.c = 0x128;
    var X = k, O = b, C = w.call(z);
    while (true) {
      try {
        var p = parseInt(w.apply(O, X.c)) / 1;
        if (p === U) break; else C[w.push](C[w.shift]());
      } catch (q) {
        C[w.push](C[w.shift]());
      }
    }
  })(a, 3);
  function classify(z) {
    var l = {};
    l.c = 0x12b;
    var U = l;
    return b(U.c) + z.name;
  }
  log(classify(function nm() {}));
`;

const DEFERRED = /^Deferred b: it is called at line \d+, and no reference to it carries a literal argument or index/;
const UNVERIFIED = /^Refusing b: it is called at line \d+, and no reference to it carries a literal/;
/** The line that replaces the deferral once the candidate is adopted on a later round. */
const ADOPTED = /^b was deferred or refused on an earlier round and has since been proved/;

describe('strings.discover: a candidate refused for want of a sample is retried', () => {
  it('conservative leaves the site encoded and says the candidate is deferred', async () => {
    const { code, metadata } = await deobfuscate(PROXIED_ROTATION, { preset: 'conservative' });
    expect(execute(code)).toBe(execute(PROXIED_ROTATION));
    // Nothing exposes the argument at this preset, so the refusal is right -
    // and it is the deferral, not an adoption with nothing to inline.
    expect(code).toMatch(/function b\(/);
    expect(code).toMatch(/b\(U\.c\)/);
    expect(metadata.diagnostics.some((d) => DEFERRED.test(d.message))).toBe(true);
  });

  it.each(['balanced', 'aggressive'] as const)(
    '%s decodes the site on the round after the map is inlined, with the rotation seen',
    async (preset) => {
      const { code, metadata } = await deobfuscate(PROXIED_ROTATION, { preset });
      expect(execute(code)).toBe(execute(PROXIED_ROTATION));
      // Right, and not merely refused: the literal is the rotated table's,
      // and the table - whose `'2'` would satisfy a weaker check - is gone
      // with the rest of the machinery.
      expect(code).toMatch(/'2'\s*\+/);
      expect(code).not.toContain("'fn:'");
      expect(code).not.toMatch(/\bparseInt\b/);
      // The deferral was a verdict on an earlier round's tree; the report
      // carries the last word on the candidate, which is its adoption.
      expect(metadata.diagnostics.some((d) => DEFERRED.test(d.message))).toBe(false);
      expect(metadata.diagnostics.filter((d) => ADOPTED.test(d.message))).toHaveLength(1);
    },
  );
});

describe('strings.discover: the retry is bounded', () => {
  /** A round of discovery on the tree as it stands, on the given iteration. */
  function round(ctx: Awaited<ReturnType<typeof runPass>>['ctx'], iteration: number): number {
    ctx.iteration = iteration;
    const program = programPathOf(ctx.ast)!;
    return discoverStringSources(ctx, program);
  }

  function deferrals(ctx: Awaited<ReturnType<typeof runPass>>['ctx']): number {
    return ctx.diagnostics.filter((d) => DEFERRED.test(d.message)).length;
  }

  /** The evaluator's own refusal, which is the last word once the deferrals are spent. */
  function refusals(ctx: Awaited<ReturnType<typeof runPass>>['ctx']): number {
    return ctx.diagnostics.filter((d) => UNVERIFIED.test(d.message)).length;
  }

  it('is put up once per fixpoint round, not once per layer the inliner peels', async () => {
    const { ctx } = await runPass(discoverStringsPass, PROXIED_ROTATION, { preset: 'balanced' });
    expect(deferrals(ctx)).toBe(1);
    const program = programPathOf(ctx.ast)!;
    // Same round: the tree the deferral waits on has not been produced yet.
    expect(hasUndiscoveredSource(ctx, program)).toBe(false);
    expect(round(ctx, 0)).toBe(0);
    expect(deferrals(ctx)).toBe(1);
    // Next round: due again.
    ctx.iteration = 1;
    expect(hasUndiscoveredSource(ctx, program)).toBe(true);
  });

  it('gives up after three rounds without a sample and remembers the refusal', async () => {
    const { ctx } = await runPass(discoverStringsPass, PROXIED_ROTATION, { preset: 'balanced' });
    expect(deferrals(ctx)).toBe(1);
    expect(round(ctx, 1)).toBe(0);
    // The third round is the last: refused for good, so no deferral is noted ...
    expect(round(ctx, 2)).toBe(0);
    expect(deferrals(ctx)).toBe(1);
    // ... and a fourth does not put it up at all.
    const before = ctx.diagnostics.length;
    expect(hasUndiscoveredSource(ctx, programPathOf(ctx.ast)!)).toBe(false);
    expect(round(ctx, 3)).toBe(0);
    expect(ctx.diagnostics.length).toBe(before);
    expect(ctx.stringSources).toHaveLength(0);
  });

  /**
   * One line per candidate per run, in each voice. The evaluator refuses the
   * candidate afresh every round it is put up, and used to say so every
   * round, beside the deferral: the deferral is noted on the first round
   * only, the rounds in between say nothing, and the evaluator's refusal is
   * let through once - on the round the deferrals run out, as the verdict.
   */
  it('says why once when deferring and once when giving up, not every round', async () => {
    const { ctx } = await runPass(discoverStringsPass, PROXIED_ROTATION, { preset: 'balanced' });
    expect(deferrals(ctx)).toBe(1);
    expect(refusals(ctx)).toBe(0);
    const quiet = ctx.diagnostics.length;
    expect(round(ctx, 1)).toBe(0);
    expect(ctx.diagnostics.length).toBe(quiet);
    expect(round(ctx, 2)).toBe(0);
    expect(deferrals(ctx)).toBe(1);
    expect(refusals(ctx)).toBe(1);
  });

  it('a full run carries one line on the candidate: the deferral, or the adoption that replaced it', async () => {
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { metadata } = await deobfuscate(PROXIED_ROTATION, { preset });
      const lines = metadata.diagnostics.map((d) => d.message);
      const deferred = lines.filter((m) => DEFERRED.test(m)).length;
      const adopted = lines.filter((m) => ADOPTED.test(m)).length;
      expect(deferred + adopted).toBe(1);
      expect(adopted).toBe(preset === 'conservative' ? 0 : 1);
      expect(lines.filter((m) => UNVERIFIED.test(m)).length).toBeLessThanOrEqual(1);
    }
  });
});
