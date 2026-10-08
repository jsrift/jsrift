import { orderPasses, type Pass } from '../pipeline/pass.js';

import { detectPass } from './prepare/detect.js';
import { foldNumbersPass } from './prepare/fold-numbers.js';
import { normalizeLiteralsPass, renormalizeLiteralsPass } from './prepare/normalize-literals.js';

import { evalPackerPass } from './unpack/eval-packer.js';
import { functionConstructorPass } from './unpack/function-constructor.js';
import { webpackModulesPass } from './unpack/webpack-modules.js';

import { discoverStringsPass } from './strings/discover.js';
import { inlineStringsPass } from './strings/inline.js';
import { mergeSplitStringsPass } from './strings/merge-split.js';
import { pruneDecodersPass } from './strings/prune-decoders.js';

import { unwrapDiscardedArgumentsPass } from './simplify/discard-wrappers.js';
import { foldConstantsPass } from './simplify/fold-constants.js';
import { inlineObjectMapsPass } from './simplify/object-maps.js';
import { inlineProxyFunctionsPass } from './simplify/proxy-functions.js';
import { normalizePropertiesPass } from './simplify/properties.js';
import { expandSequencesPass } from './simplify/sequences.js';

import { unflattenControlFlowPass } from './structure/control-flow.js';
import { recoverConditionalsPass } from './structure/conditionals.js';
import { recoverLoopsPass } from './structure/loops.js';
import { unflattenRegisterVmPass } from './structure/register-vm.js';

import { removeAntiTamperPass, removeReprintGuardsPass } from './clean/anti-tamper.js';
import { removeDeadBranchesPass } from './clean/dead-branches.js';
import { removeDeadExpressionsPass } from './clean/dead-expressions.js';
import { removeInjectedCodePass } from './clean/injected-code.js';
import { removeUnusedPass } from './clean/unused.js';

import { renameIdentifiersPass } from './rename/identifiers.js';

import { restoreJsxPass } from './finalize/jsx.js';
import { tidyOutputPass } from './finalize/tidy.js';

/**
 * The complete pass set, in the order they are registered within their stage.
 *
 * Ordering inside a stage decides execution order for the standalone `run`
 * passes outright, and for the visitor-shaped ones - merged into a single
 * traversal - it decides the order their handlers run on each node.
 *
 * The visitor passes are order-independent in *outcome*: the stage repeats to a
 * fixpoint, so whatever one pass exposes another eventually sees. They are not
 * order-independent in *round count*, and one pair here is deliberately placed.
 * `simplify.discard-wrappers` rewrites an `ExpressionStatement` in place into a
 * comma sequence and `simplify.sequences` turns that sequence into statements;
 * registered in this order they converge in a single traversal, and reversed
 * they cost an extra fixpoint round over the whole program.
 */
const PASSES: readonly Pass[] = [
  // prepare - analysis and lossless normalisation only.
  // Number folding precedes detection: `numbersToExpressions` hides the very
  // constants that decoder recognition keys on.
  foldNumbersPass,
  detectPass,
  normalizeLiteralsPass,

  // unpack - reveal source hidden behind a packer or bundler
  functionConstructorPass,
  evalPackerPass,
  webpackModulesPass,

  // strings - the heart of the tool: turn encoded references back into literals.
  // Re-normalisation leads. `prepare` ran before `unpack`, so a packer payload
  // reaches the loop still spelled in `\xNN` escapes and backticks, and every
  // recogniser below expects the plain form. Leading matters twice over: this is
  // a visitor and the three passes after it are `run` passes, which the kernel
  // executes after the stage's merged visitor traversal, so all three see a
  // normalised tree. `strings.merge-split` is the visitor it shares that
  // traversal with - which is why running every round costs handler calls
  // rather than a walk.
  renormalizeLiteralsPass,
  discoverStringsPass,
  inlineStringsPass,
  pruneDecodersPass,
  mergeSplitStringsPass,

  // simplify - collapse the noise that inlining exposes
  foldConstantsPass,
  normalizePropertiesPass,
  inlineObjectMapsPass,
  inlineProxyFunctionsPass,
  unwrapDiscardedArgumentsPass,
  expandSequencesPass,

  // structure - rebuild real control flow.
  // Recovery before reporting: a register VM the first pass linearises is gone
  // by the time the second looks for one to refuse.
  unflattenRegisterVmPass,
  unflattenControlFlowPass,
  recoverConditionalsPass,
  recoverLoopsPass,

  // clean - delete what the obfuscator added. The reprint guards go at every
  // preset: a guard that hangs on reprinted text hangs on every output.
  removeDeadBranchesPass,
  removeInjectedCodePass,
  removeReprintGuardsPass,
  removeAntiTamperPass,
  removeUnusedPass,
  removeDeadExpressionsPass,

  // rename - the readability payoff
  renameIdentifiersPass,

  // finalize - last-mile work that needs the settled tree
  restoreJsxPass,
  tidyOutputPass,
];

export function buildPassList(): Pass[] {
  return orderPasses(PASSES);
}

/** Pass metadata for UIs that want to show or toggle individual passes. */
export function listPasses(): Array<Pick<Pass, 'id' | 'title' | 'stage' | 'technique'>> {
  return buildPassList().map(({ id, title, stage, technique }) => ({
    id,
    title,
    stage,
    technique,
  }));
}
