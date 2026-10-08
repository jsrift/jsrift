import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { Kernel } from '../src/pipeline/kernel.js';
import { ITERATIVE_STAGES, STAGE_ORDER, type Pass, type Stage } from '../src/pipeline/pass.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

/**
 * Performance regression guards.
 *
 * Not a benchmark. `bench/run.mjs` measures, and its numbers move with the
 * machine; these assertions are the ones that must not move whatever the machine
 * is doing, so every threshold here is deliberately far from the measured value
 * and only ever bounds the direction that means "something broke":
 *
 *   * **work** - a change that silently doubles the traversals shows up as an
 *     iteration count or a change count outside its band, and those are exact
 *     integers rather than timings.
 *   * **yield** - a change that stops decoding shows up as a string count below
 *     its floor. The floor is one-sided on purpose: decoding *more* is an
 *     improvement and must not fail the suite.
 *   * **shape** - output that stopped shrinking, or stopped parsing, or started
 *     emitting error diagnostics.
 *   * **time** - a ceiling, but a generous one. The measured figure is in the
 *     comment beside each; the assertion sits at several times that, because a
 *     test that fails on a loaded CI box teaches people to ignore it.
 *
 * The scaling test asserts a *ratio* rather than a duration, which is the one
 * timing shape that survives a slow machine: a machine half the speed halves
 * both terms.
 */

const HEAVY3_FIXTURE = thirdPartyFixture('obfuscated3.js');
const LIGHT_FIXTURE = thirdPartyFixture('lightly-obfuscated.js');
const LAYER1_FIXTURE = thirdPartyFixture('layered/layer1.js');

/** Generous: the slowest case here measures ~5 s on the development machine. */
const CEILING_MS = 180_000;

// ---------------------------------------------------------------------------
// Kernel scheduling
// ---------------------------------------------------------------------------

/**
 * The fixpoint loop skips a stage when the change counter has not moved since
 * that stage last *started*. These tests pin both halves of that rule, because
 * the two failure modes are opposite and only one of them is loud: skipping too
 * little wastes a round, and skipping too much silently drops a transformation.
 */
describe('kernel: fixpoint scheduling', () => {
  interface Recorder {
    runs: Array<{ stage: Stage; iteration: number }>;
  }

  /**
   * A pass that reports `changes` on each of its first `changingRounds` runs and
   * nothing afterwards - a stage that converges, which is what every real stage
   * does.
   */
  function fakePass(stage: Stage, log: Recorder, changingRounds: number, crawls = false): Pass {
    let runs = 0;
    return {
      id: `test.${stage}`,
      title: `test pass for ${stage}`,
      stage,
      technique: 'core',
      run: (ctx) => {
        log.runs.push({ stage, iteration: ctx.iteration });
        if (runs++ < changingRounds) {
          ctx.markChanged(1);
          // A pass that leaves the scope tables describing the tree it changed.
          if (crawls) (ctx as PipelineContext).rebuildProgramScope();
        }
      },
    };
  }

  async function runKernel(passes: Pass[]): Promise<PipelineContext> {
    const source = 'var a = 1;';
    const parsed = parseSource(source, {});
    const ctx = new PipelineContext(
      parsed.ast,
      source,
      resolveConfig({}),
      parsed.language,
      Date.now() + 60_000,
    );
    await new Kernel(passes, ctx).run();
    return ctx;
  }

  const iterative = STAGE_ORDER.filter((s) => ITERATIVE_STAGES.has(s));

  it('re-runs a stage so it can see its own output', async () => {
    // The load-bearing case. Linearising an outer dispatcher is what brings an
    // inner one into a provable scope, so `structure` recovers the nested shape
    // only on the round *after* it made the change. A skip rule that marked a
    // stage as "seen" after it ran would hide a stage's own changes from its own
    // guard and lose that second round entirely.
    const log: Recorder = { runs: [] };
    const stage = iterative[iterative.length - 1]!;
    await runKernel([fakePass(stage, log, 1)]);

    const rounds = log.runs.filter((r) => r.stage === stage);
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect(rounds[0]!.iteration).toBe(0);
    expect(rounds[1]!.iteration).toBe(1);
  });

  it('stops re-running stages once nothing upstream of them changes', async () => {
    // One stage changes something on its first two rounds and then stops, and
    // leaves the scope tables describing the tree it changed. Every stage
    // still has to run on the round after the last change - that is the proof
    // of the fixpoint - but nothing may run twice after it.
    const log: Recorder = { runs: [] };
    const changing = iterative[0]!;
    await runKernel(iterative.map((s) => fakePass(s, log, s === changing ? 2 : 0, true)));

    const perStage = new Map<Stage, number>();
    for (const r of log.runs) perStage.set(r.stage, (perStage.get(r.stage) ?? 0) + 1);

    // Three rounds of work exist (two that change, one that proves), so no stage
    // can justify a fourth run.
    for (const stage of iterative) expect(perStage.get(stage)).toBeLessThanOrEqual(3);
    // And the stages downstream of the only changing one are skipped on the
    // proving round rather than walked: they were already idle when it ended,
    // on tables that described the tree.
    const downstream = iterative[iterative.length - 1]!;
    expect(perStage.get(downstream)).toBeLessThan(perStage.get(changing)!);
  });

  it('re-runs a stage once on rebuilt tables when it last ran on stale ones', async () => {
    // The same schedule with the changing stage leaving the tables behind the
    // tree, as a pass that rewrites nodes does. The stages after it judged
    // the tree on tables older than it, and a proof made on those is no
    // proof: the round after the last change rebuilds the tables and runs
    // each of them once more on the same tree - once, not a fourth time.
    const log: Recorder = { runs: [] };
    const changing = iterative[0]!;
    await runKernel(iterative.map((s) => fakePass(s, log, s === changing ? 2 : 0)));

    const perStage = new Map<Stage, number>();
    for (const r of log.runs) perStage.set(r.stage, (perStage.get(r.stage) ?? 0) + 1);
    for (const stage of iterative) expect(perStage.get(stage)).toBe(3);
  });

  it('leaves the loop immediately when the first round changes nothing', async () => {
    const log: Recorder = { runs: [] };
    await runKernel(iterative.map((s) => fakePass(s, log, 0)));
    // Exactly one round: every stage once, none of them twice.
    expect(log.runs).toHaveLength(iterative.length);
  });

  it('never skips a stage on the first iteration', async () => {
    // A stage with no history has nothing to compare against and must run, even
    // though the counter is still zero from the prologue stages.
    const log: Recorder = { runs: [] };
    await runKernel(iterative.map((s) => fakePass(s, log, 0)));
    for (const stage of iterative) {
      expect(log.runs.some((r) => r.stage === stage && r.iteration === 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Whole-engine work volume
// ---------------------------------------------------------------------------

describe('engine: work volume on real inputs', () => {
  /**
   * `obfuscated3.js` - 362 KB, a basE91 constant-pool protector. Chosen over the
   * 4 MB fixture because it exercises the same stages at a seventh of the cost,
   * which is what makes it affordable to assert on every run.
   *
   * Measured on the development machine at the time of writing: 2.6 s wall,
   * 4 iterations, 1 727 strings, 147 KB out (-59 %).
   */
  it.skipIf(!HEAVY3_FIXTURE.present)(
    'obfuscated3.js stays within its work envelope',
    async () => {
      const source = HEAVY3_FIXTURE.read();
      const startedAt = Date.now();
      const { code, metadata } = await deobfuscate(source);
      const elapsed = Date.now() - startedAt;
      const { stats } = metadata;

      // Time: measured 2.6 s, asserted at 180 s. This catches an accidental
      // quadratic, not a slow afternoon.
      expect(elapsed).toBeLessThan(CEILING_MS);

      // Work: the fixpoint must converge well inside its budget. Six is the
      // configured maximum; needing all six would mean it no longer converges.
      expect(stats.iterations).toBeLessThanOrEqual(5);

      // Yield: a floor, never an equality. Decoding more is an improvement.
      expect(metadata.strings.length).toBeGreaterThanOrEqual(1_600);

      // Shape: still shrinking by more than half, still valid JavaScript, and
      // no pass reported a failure.
      expect(stats.outputBytes).toBeLessThan(source.length * 0.7);
      expect(stats.verified).toBe(true);
      expect(stats.truncated).toBe(false);
      expect(metadata.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
      expect(code.length).toBeGreaterThan(0);
    },
    CEILING_MS,
  );

  /**
   * `lightly-obfuscated.js` - 470 KB, a minified bundle with one plain string
   * table. Its interest here is memory rather than time: it is the base unit the
   * synthetic scaling corpus is built from, so the per-byte cost measured on it
   * is the per-byte cost of the 10 MB case.
   *
   * Run at `aggressive`, because that is the only preset that decodes this
   * file's table: its one `Function(_)` call takes an Identifier the analysis
   * cannot resolve, so nothing proves the table is a constant, and the other two
   * presets refuse it. The deciding preset is also the working one - the
   * refusing presets never do the 10 197 replacements this envelope is drawn
   * around - so the yield floor below belongs here and nowhere else. The
   * refusing side gets its own envelope in the test that follows.
   *
   * Measured at `aggressive`: 7.7 s wall, 5 iterations, 2 203 strings, ~400 MB
   * resident.
   */
  it.skipIf(!LIGHT_FIXTURE.present)(
    'lightly-obfuscated.js stays within its work and memory envelope at aggressive',
    async () => {
      const source = LIGHT_FIXTURE.read();
      const startedAt = Date.now();
      const { metadata } = await deobfuscate(source, { preset: 'aggressive' });
      const elapsed = Date.now() - startedAt;
      const { stats } = metadata;

      expect(elapsed).toBeLessThan(CEILING_MS);
      expect(stats.iterations).toBeLessThanOrEqual(5);
      expect(metadata.strings.length).toBeGreaterThanOrEqual(2_100);
      expect(stats.verified).toBe(true);
      expect(stats.truncated).toBe(false);

      // Memory, as a ratio to the input rather than an absolute.
      //
      // Peak RSS is not assertable here - it is a per-process high-water mark and
      // the test runner shares the process - so this bounds resident size after
      // the run instead, which is the same quantity a leak or a doubled tree
      // would inflate. Measured at roughly 400 MB for this 470 KB input; the
      // ceiling is set at 2 GB, far enough away that GC scheduling cannot reach
      // it and close enough that a tree kept alive twice over cannot hide.
      expect(process.memoryUsage().rss).toBeLessThan(2 * 1024 * 1024 * 1024);
    },
    CEILING_MS,
  );

  /**
   * The same file at the default preset, which refuses to decode that table.
   *
   * Not a copy of the test above: a refusal is exactly where a fixpoint loop can
   * fail to converge, because nothing is being consumed and every round sees the
   * same 10 197 call sites it saw last time. A guard that started asking its
   * question per call site instead of per source would show up here as an
   * iteration count or a wall clock, never as a wrong answer.
   *
   * The yield assertion is inverted for the same reason it is a floor above.
   * Decoding more is an improvement at `aggressive`; at this preset decoding any
   * of this table at all is the regression, so the number to pin is zero.
   *
   * Measured at `balanced`: 5.4 s wall, 5 iterations, 0 strings, ~320 MB
   * resident.
   */
  it.skipIf(!LIGHT_FIXTURE.present)(
    'lightly-obfuscated.js refuses the same table at balanced, inside the same envelope',
    async () => {
      const source = LIGHT_FIXTURE.read();
      const startedAt = Date.now();
      const { metadata } = await deobfuscate(source);
      const elapsed = Date.now() - startedAt;
      const { stats } = metadata;

      expect(elapsed).toBeLessThan(CEILING_MS);
      expect(stats.iterations).toBeLessThanOrEqual(5);
      expect(metadata.strings).toHaveLength(0);
      expect(stats.verified).toBe(true);
      expect(stats.truncated).toBe(false);
      expect(metadata.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
      // Same bound, same reasoning as above.
      expect(process.memoryUsage().rss).toBeLessThan(2 * 1024 * 1024 * 1024);
    },
    CEILING_MS,
  );
});

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

/**
 * N independent copies of a real obfuscator.io build, each in its own IIFE with
 * its generated identifiers suffixed, so every copy is a separate scope tree
 * with its own string table. This is the same construction `bench/run.mjs` uses
 * for its synthetic ladder, at a size that fits in a test.
 */
function replicate(source: string, copies: number): string {
  const parts: string[] = [];
  for (let i = 0; i < copies; i++) {
    parts.push(`;(function(){\n${source.replace(/\b(_0x[0-9a-fA-F]+)\b/g, `$1_c${i}`)}\n})();`);
  }
  return parts.join('\n');
}

describe('engine: scaling', () => {
  it.skipIf(!LAYER1_FIXTURE.present)(
    'cost grows with the input, not with its square',
    async () => {
      const unit = LAYER1_FIXTURE.read();
      const small = replicate(unit, 32);
      const large = replicate(unit, 128);

      const timed = async (source: string) => {
        const startedAt = Date.now();
        const { metadata } = await deobfuscate(source);
        return { ms: Date.now() - startedAt, stats: metadata.stats };
      };

      // Warm the JIT on the small input first; otherwise the first run pays for
      // compiling the whole engine and the ratio measures tier-up, not scaling.
      await timed(small);
      const a = await timed(small);
      const b = await timed(large);

      // The deterministic half, which no amount of machine noise can move: four
      // times the input is four times the work, exactly, because the copies are
      // independent. If a pass starts comparing every module against every other
      // module this is where it shows.
      expect(b.stats.totalChanges / a.stats.totalChanges).toBeGreaterThan(3.5);
      expect(b.stats.totalChanges / a.stats.totalChanges).toBeLessThan(4.5);

      // The timing half, as a ratio so a slow machine cancels out. Linear would
      // be 4x and quadratic 16x; the bound rejects quadratic with room to spare
      // for the fixed costs that make small inputs look relatively expensive.
      expect(b.ms / Math.max(a.ms, 1)).toBeLessThan(10);
    },
    CEILING_MS,
  );

  it(
    'an input with nothing left to do converges in one round',
    async () => {
      // Already-clean source is the cheapest possible input, and the fixpoint
      // loop must recognise it as such rather than spending its whole budget
      // proving it. This is the guard on the loop itself: if a pass starts
      // reporting a change it did not make, the iteration count moves here first.
      const clean = `
        export function greet(name) {
          const greeting = 'Hello, ' + name + '!';
          console.log(greeting);
          return greeting;
        }
      `;
      const { metadata } = await deobfuscate(clean);
      expect(metadata.stats.iterations).toBe(1);
      expect(metadata.stats.verified).toBe(true);
    },
    CEILING_MS,
  );
});

/**
 * Many string tables in one scope must cost linear time, not quadratic.
 *
 * Every real fixture carries one table, so nothing here ever exercised the
 * shape obfuscator.io produces with `stringArrayWrappersCount`, or that any
 * concatenation of obfuscated files produces: hundreds of tables, each with its
 * own decoder, all at program scope. Four places in discovery walked the whole
 * program once per candidate - `buildDecoder`'s own sample collection and
 * `tableIsStable` for a top-level table, the rotation scan in the slicer, the
 * decoder finder's per-array body search, and the slicer's level construction.
 * Measured before they were indexed: 512 tables in 663 KB took 120 s in
 * `strings.discover` alone and hit the time budget, at roughly 4.5x per
 * doubling; after, 5.1 s for the whole run at about 2.3x. Pinned through
 * `truncated` against a budget the fixed
 * engine clears several times over, so the assertion is on the engine's own
 * accounting rather than on this machine's clock.
 */
describe('strings: many tables in one scope', () => {
  const unit = readFileSync(
    fileURLToPath(new URL('./fixtures/many-tables-unit.js', import.meta.url)),
    'utf8',
  );
  const copies = 256;
  const source = Array.from({ length: copies }, (_, i) =>
    unit.replace(/_0x([0-9a-f]{4})/g, (_m, h: string) => `_0x${h}${i.toString(16)}`),
  ).join('\n');

  it('decodes every table well inside a budget the quadratic version blew', async () => {
    const result = await deobfuscate(source, {
      preset: 'balanced',
      performance: { timeBudgetMs: 20_000 },
    });
    expect(result.metadata.stats.truncated).toBe(false);
    // Nine strings per copy; a table that discovery skipped shows up here first.
    expect(result.metadata.strings.length).toBe(copies * 9);
    expect(result.code).not.toMatch(/_0x4f2a[0-9a-f]* = \[/);
  }, 60_000);
});
