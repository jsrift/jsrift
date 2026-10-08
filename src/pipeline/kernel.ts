import _traverse, { visitors as babelVisitors, type Visitor } from '@babel/traverse';
import type { PassReport } from '../types.js';
import type { PipelineContext } from './context.js';
import { ITERATIVE_STAGES, STAGE_ORDER, type Pass, type Stage } from './pass.js';

// @babel/traverse ships both CJS and ESM shapes depending on the bundler.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

type Phase = 'enter' | 'exit';
type Handler = (...args: unknown[]) => void;
type ExplodedVisitor = Record<string, { enter?: Handler[]; exit?: Handler[] }>;

interface PassRuntime {
  pass: Pass;
  durationMs: number;
  bailout?: string;
  /** Set when the pass threw; it is skipped for the remainder of the run. */
  disabled: boolean;
}

export interface KernelResult {
  reports: PassReport[];
  iterations: number;
  truncated: boolean;
}

/**
 * Runs the pass pipeline over a single AST.
 *
 * Two properties matter here and drive the whole design:
 *
 * 1. **One traversal per stage, not per pass.** Every visitor-shaped pass in a
 *    stage is exploded and merged into a single visitor object, so the cost of
 *    the pass set is the cost of walking the tree once per stage. This is what
 *    keeps a 400k-node file tractable.
 *
 * 2. **A failing pass can never corrupt the output.** Each handler is wrapped;
 *    the first throw disables that pass for the rest of the run and is recorded
 *    as a bailout rather than propagated. The engine degrades, it does not fail.
 */
export class Kernel {
  private readonly runtimes: PassRuntime[];

  constructor(
    private readonly passes: readonly Pass[],
    private readonly ctx: PipelineContext,
  ) {
    this.runtimes = passes.map((pass) => ({ pass, durationMs: 0, disabled: false }));
  }

  async run(onStage?: (stage: Stage, iteration: number) => void): Promise<KernelResult> {
    const { maxIterations } = this.ctx.config.performance;

    // Partition the stage list into [prologue][loop][epilogue] by the span of
    // iterative stages. Taking the whole span rather than filtering keeps a
    // non-iterative stage that sits between two iterative ones inside the loop,
    // where it belongs - filtering would silently drop it from the run entirely.
    const first = STAGE_ORDER.findIndex((s) => ITERATIVE_STAGES.has(s));
    const last = STAGE_ORDER.reduce((acc, s, i) => (ITERATIVE_STAGES.has(s) ? i : acc), -1);
    const hasLoop = first !== -1;
    const before = hasLoop ? STAGE_ORDER.slice(0, first) : STAGE_ORDER;
    const iterativeStages = hasLoop ? STAGE_ORDER.slice(first, last + 1) : [];
    const after = hasLoop ? STAGE_ORDER.slice(last + 1) : [];

    let truncated = false;
    for (const stage of before) {
      onStage?.(stage, 0);
      await this.runStage(stage);
      if (this.ctx.isExhausted()) truncated = true;
    }

    let iterations = 0;
    if (!truncated) {
      // The change counter as it stood when each stage last *started*. If it has
      // not moved since, the tree this stage is about to walk is the identical
      // tree it already walked and found nothing in, so the walk cannot find
      // anything now either and is skipped.
      //
      // The mark has to be taken before the stage runs, not after. A stage sees
      // its own output on the next round and routinely needs to: linearising an
      // outer dispatcher is what brings an inner one into a provable scope, so
      // `structure` recovers the nested case only on the round after it made the
      // change. Marking afterwards hides a stage's own changes from its own
      // guard and loses that second round - which is exactly what
      // `control-flow.test.ts > withdraws a refusal once a later round recovers
      // the same dispatcher` pins down.
      //
      // This saves most of the proving round, because a file converges stage by
      // stage rather than all at once: on `lightly-obfuscated.js` the last
      // change of the whole run happens in `simplify` on the fourth round, so
      // the two stages after it are provably idle before the fifth round starts.
      //
      // Soundness rests on the same contract the round-level check below relies
      // on - "every mutating pass must call markChanged" - read at stage
      // granularity instead of round granularity.
      const changesWhenLastStarted = new Map<Stage, number>();
      // And the scope build it last started on. A quiet round is weaker than
      // a fixpoint in one way a second `deobfuscate()` used to expose: Babel's
      // scope tables are built on a crawl, every proof that reads
      // `referencePaths` reads them as of that crawl, and a stage skipped on
      // the strength of the change counter, or run before the tables caught
      // up with the last change, judged the tree on older tables than it now
      // has. Measured, that gap was 2.5% of `obfuscated3.js` at `balanced`
      // and 3.9% at `aggressive`, in whole dead decoder bodies. So each round
      // opens on tables that describe the tree (a crawl, when the tree moved
      // since the last one: half a second on the 757 KB fixture, against the
      // full extra round that re-running the behind stages after the quiet
      // round cost - a quarter of the run on `obfuscated4.js`), and a stage
      // is due when either the tree or the tables moved since it last
      // started. On a quiet round every stage has then run on the tables as
      // they stand with nothing changed since, which is the fixpoint.
      const revisionWhenLastStarted = new Map<Stage, number>();
      // Changes as they stood when `unpack` last ran. It is a prologue stage,
      // and opened wrappers once, before the loop spelled out the ones a
      // decoded table or a folded concatenation held; a quiet round runs it
      // over the moved tree and goes on only if that opened something.
      let changesWhenUnpacked = this.ctx.totalChanges;
      for (let i = 0; ; i++) {
        // The loop runs while a round changes something. `maxIterations` is
        // the caller's ceiling on that, and the default is high enough that
        // only the time budget bounds an ordinary file: layers stack, each
        // takes about two rounds to peel, and a four-deep obfuscator.io build
        // needs nine. A cap that ends a run still changing is said, and the
        // result carries `truncated`, since the output is not what the loop
        // would have reached.
        if (i >= maxIterations) {
          if (i > 0) {
            this.ctx.currentPass = 'pipeline';
            this.ctx.note(
              'warning',
              `Stopped after ${i} fixpoint round(s) at performance.maxIterations while the tree was ` +
                `still changing; the output is not settled. Raise the cap to let the run finish.`,
            );
            truncated = true;
          }
          break;
        }
        this.ctx.iteration = i;
        iterations = i + 1;
        if (this.ctx.scopeStale()) this.ctx.rebuildProgramScope();
        const changesBefore = this.ctx.totalChanges;
        for (const stage of iterativeStages) {
          if (
            changesWhenLastStarted.get(stage) === this.ctx.totalChanges &&
            revisionWhenLastStarted.get(stage) === this.ctx.scopeRevision
          ) {
            continue;
          }
          changesWhenLastStarted.set(stage, this.ctx.totalChanges);
          revisionWhenLastStarted.set(stage, this.ctx.scopeRevision);
          onStage?.(stage, i);
          await this.runStage(stage);
        }
        if (this.ctx.isExhausted()) {
          truncated = true;
          break;
        }
        if (this.ctx.totalChanges !== changesBefore) continue;
        if (this.ctx.totalChanges === changesWhenUnpacked) break;
        changesWhenUnpacked = this.ctx.totalChanges;
        onStage?.('unpack', i);
        await this.runStage('unpack');
        if (this.ctx.isExhausted()) {
          truncated = true;
          break;
        }
        if (this.ctx.totalChanges === changesBefore) break;
      }
    }

    this.ctx.iteration = 0;
    for (const stage of after) {
      onStage?.(stage, 0);
      await this.runStage(stage);
      // Same rule as the prologue. `runStage` stops at the budget and skips a
      // stage that starts past it, so a `rename` cut mid-walk and a `finalize`
      // never entered both used to come back as `truncated: false` - measured
      // on a 205,640-line input at the default budget: one run lost all 16,680
      // renames and said so, the next lost `finalize` entirely and did not.
      if (this.ctx.isExhausted()) truncated = true;
    }

    return { reports: this.buildReports(), iterations, truncated };
  }

  private activeFor(stage: Stage): PassRuntime[] {
    return this.runtimes.filter((rt) => {
      if (rt.disabled || rt.pass.stage !== stage) return false;
      if (this.ctx.iteration > 0 && rt.pass.repeatable === false) return false;
      if (this.ctx.config.disabledPasses.has(rt.pass.id)) return false;
      if (rt.pass.technique !== 'core' && !this.ctx.config.techniques[rt.pass.technique]) return false;
      if (rt.pass.when && !this.guard(rt, () => rt.pass.when!(this.ctx))) return false;
      return true;
    });
  }

  private async runStage(stage: Stage): Promise<void> {
    // Before the budget check, not after: the hop is what lets a pending abort
    // land, and checking first would read the signal one stage stale.
    await this.ctx.yieldToHost();
    if (this.ctx.isExhausted()) return;
    const active = this.activeFor(stage);
    if (active.length === 0) return;

    const visitorPasses = active.filter((rt) => rt.pass.visitor);
    if (visitorPasses.length > 0) {
      const merged = this.mergeStageVisitors(visitorPasses);
      if (merged) {
        const started = now();
        try {
          traverse(this.ctx.ast, merged);
        } catch (error) {
          // A throw that escapes the per-handler guard means the traversal
          // itself is unsound; record it against the stage and move on.
          this.ctx.currentPass = `stage:${stage}`;
          this.ctx.note('error', `Stage traversal aborted: ${describe(error)}`);
        }
        const elapsed = now() - started;
        // Attribute traversal cost proportionally; per-handler timing would cost
        // more than it reveals at 400k nodes.
        for (const rt of visitorPasses) rt.durationMs += elapsed / visitorPasses.length;
      }
    }

    for (const rt of active) {
      if (!rt.pass.run || rt.disabled) continue;
      if (this.ctx.isExhausted()) return;
      const started = now();
      this.ctx.currentPass = rt.pass.id;
      try {
        await rt.pass.run(this.ctx);
      } catch (error) {
        this.disable(rt, error);
      }
      rt.durationMs += now() - started;
    }
    this.ctx.currentPass = 'pipeline';
  }

  /**
   * Explode each pass's visitor (resolving Babel aliases like `Function` and
   * shorthand handlers), then concatenate handlers per node type and phase.
   * Each handler is wrapped so the active pass id is correct for attribution and
   * so a throw disables only that pass.
   */
  private mergeStageVisitors(runtimes: readonly PassRuntime[]): Visitor<unknown> | undefined {
    const merged: ExplodedVisitor = {};
    let any = false;

    for (const rt of runtimes) {
      let exploded: ExplodedVisitor;
      try {
        const raw = rt.pass.visitor!(this.ctx) as unknown as Record<string, unknown>;
        exploded = babelVisitors.explode(raw as never) as unknown as ExplodedVisitor;
      } catch (error) {
        this.disable(rt, error);
        continue;
      }

      for (const [nodeType, handlers] of Object.entries(exploded)) {
        if (!handlers || typeof handlers !== 'object') continue;
        const slot = (merged[nodeType] ??= {});
        for (const phase of ['enter', 'exit'] as Phase[]) {
          const fns = handlers[phase];
          if (!Array.isArray(fns) || fns.length === 0) continue;
          (slot[phase] ??= []).push(...fns.map((fn) => this.wrap(rt, fn)));
          any = true;
        }
      }
    }

    return any ? (merged as unknown as Visitor<unknown>) : undefined;
  }

  private wrap(rt: PassRuntime, fn: Handler): Handler {
    const ctx = this.ctx;
    return function wrapped(this: unknown, ...args: unknown[]) {
      if (rt.disabled) return;
      const previous = ctx.currentPass;
      ctx.currentPass = rt.pass.id;
      try {
        fn.apply(this, args);
      } catch (error) {
        rt.disabled = true;
        rt.bailout = describe(error);
        ctx.note('warning', `Pass disabled after error: ${rt.bailout}`);
      } finally {
        ctx.currentPass = previous;
      }
    };
  }

  private guard(rt: PassRuntime, fn: () => boolean): boolean {
    try {
      return fn();
    } catch (error) {
      this.disable(rt, error);
      return false;
    }
  }

  private disable(rt: PassRuntime, error: unknown): void {
    rt.disabled = true;
    rt.bailout = describe(error);
    this.ctx.currentPass = rt.pass.id;
    this.ctx.note('warning', `Pass disabled after error: ${rt.bailout}`);
    this.ctx.currentPass = 'pipeline';
  }

  private buildReports(): PassReport[] {
    return this.runtimes
      .map((rt) => ({
        id: rt.pass.id,
        technique: rt.pass.technique,
        changes: this.ctx.changesByPass.get(rt.pass.id) ?? 0,
        durationMs: Math.round(rt.durationMs * 100) / 100,
        bailout: rt.bailout,
      }))
      .filter((r) => r.changes > 0 || r.bailout !== undefined || r.durationMs >= 1);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
