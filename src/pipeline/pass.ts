import type { Visitor } from '@babel/traverse';
import type { TechniqueId } from '../types.js';
import type { PassContext } from './context.js';

/**
 * Pipeline stages, in execution order.
 *
 * The ordering encodes hard dependencies: you cannot infer a meaningful variable
 * name before the strings that describe it have been decoded, and you cannot
 * decode strings before an `eval` packer has been unwrapped to expose them.
 */
export const STAGE_ORDER = [
  /** Normalise the AST and fingerprint the obfuscator. Never mutates semantics. */
  'prepare',
  /** Expose hidden source: eval packers, webpack chunk maps, module wrappers. */
  'unpack',
  /** Discover string arrays and decoders, then inline every decoded literal. */
  'strings',
  /** Fold constants, inline proxies and object alias maps, normalise properties. */
  'simplify',
  /** Rebuild real control flow from dispatcher state machines. */
  'structure',
  /** Delete injected filler, unreachable branches, tamper checks, unused bindings. */
  'clean',
  /** Assign human-meaningful, scope-safe identifiers. */
  'rename',
  /** Last-mile readability work that must see the final tree. */
  'finalize',
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

/**
 * Stages that participate in the fixpoint loop.
 *
 * These feed each other: unflattening a dispatcher exposes constant branches,
 * folding those exposes dead bindings, and deleting dead bindings can expose
 * another dispatcher. They repeat as a block until the tree stops changing or
 * the iteration/time budget runs out.
 *
 * `strings` is in the loop because obfuscation stacks. Code that has been run
 * through an obfuscator repeatedly has one string table per layer, and each
 * table's *contents* are calls into the layer beneath it. Decoding the outer
 * layer turns the next table into plain literals, which only then becomes
 * discoverable. One pass recovers one layer; the loop recovers all of them.
 *
 * `prepare` and `unpack` stay outside, and that has a consequence worth knowing
 * before adding a pass to either: `prepare` normalises the AST *before* `unpack`
 * exists to hand it a new one. A packer payload is parsed into the tree after
 * the only stage that would have normalised it has finished, so a `prepare`
 * normalisation that must also hold for recovered code has to be re-run from
 * inside the loop. `strings.normalize-literals` is that re-run, and it is not a
 * special case: any future `prepare` pass whose output the rest of the pipeline
 * relies on has the same hole under it.
 */
export const ITERATIVE_STAGES: ReadonlySet<Stage> = new Set([
  'strings',
  'simplify',
  'structure',
  'clean',
]);

export interface Pass {
  /** Stable dot-namespaced id, e.g. `strings.inline`. Used by `disablePasses`. */
  id: string;
  /** One line describing what the pass does, surfaced in the report and UI. */
  title: string;
  stage: Stage;
  /**
   * The user-facing toggle that gates this pass. `'core'` passes always run:
   * they are structural prerequisites, not opinionated transformations.
   */
  technique: TechniqueId | 'core';

  /**
   * Node-driven work. Visitors from every pass in a stage are exploded and
   * merged into a *single* traversal, so adding passes costs almost nothing:
   * the tree is walked once per stage rather than once per pass.
   */
  visitor?: (ctx: PassContext) => Visitor<unknown>;

  /**
   * Whole-program work that cannot be expressed as a visitor: anything needing
   * a global analysis pass first, its own traversal order, or async evaluation.
   * Runs after the merged visitor traversal for its stage.
   */
  run?: (ctx: PassContext) => void | Promise<void>;

  /**
   * When false the pass runs only on the first fixpoint iteration. Use for
   * expensive one-shot analyses that cannot produce new work on a re-run.
   */
  repeatable?: boolean;

  /** Skip the pass entirely unless the predicate holds - cheap early-out. */
  when?: (ctx: PassContext) => boolean;
}

/** Registry helper that keeps pass ids unique and stage order authoritative. */
export function orderPasses(passes: readonly Pass[]): Pass[] {
  const seen = new Set<string>();
  for (const pass of passes) {
    if (seen.has(pass.id)) throw new Error(`Duplicate pass id: ${pass.id}`);
    seen.add(pass.id);
  }
  const stageIndex = new Map(STAGE_ORDER.map((stage, index) => [stage, index]));
  return [...passes].sort((a, b) => {
    const delta = (stageIndex.get(a.stage) ?? 0) - (stageIndex.get(b.stage) ?? 0);
    return delta !== 0 ? delta : 0; // stable: registration order wins inside a stage
  });
}
