import type * as t from '@babel/types';
import type { PassContext } from '../../pipeline/context.js';
import type { Diagnostic } from '../../types.js';

/**
 * Refusal bookkeeping shared by the two structure dispatchers.
 *
 * `structure.control-flow` records every refusal and `structure.register-vm`
 * withdraws its own, so the pair needs one map and one set of evidence strings.
 * They live here rather than in either pass because the reporting also runs the
 * other direction - control-flow asks register-vm *why* it refused - and two
 * passes importing each other is a cycle waiting to be tripped over by whoever
 * adds the next top-level constant.
 */

/** Evidence for an order-array `switch` dispatcher that could not be proven. */
export const REFUSAL_EVIDENCE = 'switch dispatcher (not recovered)';

/**
 * The register VM reports through the same `DetectionKind` and is separated
 * from the flattened `switch` purely by this string.
 *
 * `PipelineContext.report` dedupes on `(kind, evidence)`, so a distinct
 * evidence string already earns its own separately-counted row in the report
 * and the UI; minting a `DetectionKind` would edit two hand-maintained lists to
 * say what the evidence line already says.
 */
export const REGISTER_VM_EVIDENCE = 'register-VM dispatcher (not recovered)';

const REFUSALS_KEY = 'structure.control-flow:refused';

/**
 * Loops reported as unrecoverable, mapped to the diagnostic that said so, both
 * to report each refusal once and to take it back if a later iteration recovers
 * the same loop.
 *
 * Keyed by evidence first because the two machines refuse for unrelated reasons
 * and a withdrawal must only ever cancel its own kind of refusal.
 */
function refusals(ctx: PassContext, evidence: string): Map<t.Node, Diagnostic> {
  let byEvidence = ctx.shared.get(REFUSALS_KEY) as
    | Map<string, Map<t.Node, Diagnostic>>
    | undefined;
  if (!byEvidence) {
    byEvidence = new Map<string, Map<t.Node, Diagnostic>>();
    ctx.shared.set(REFUSALS_KEY, byEvidence);
  }
  let seen = byEvidence.get(evidence);
  if (!seen) {
    seen = new Map<t.Node, Diagnostic>();
    byEvidence.set(evidence, seen);
  }
  return seen;
}

export function recordRefusal(
  ctx: PassContext,
  node: t.Node,
  evidence: string,
  confidence: number,
  message: string,
): void {
  const seen = refusals(ctx, evidence);
  if (seen.has(node)) return;
  ctx.report('control-flow-flattening', evidence, confidence, 1);
  ctx.note('warning', message, node.loc);
  // The note the context just recorded, kept so it can be taken back.
  const diagnostic = ctx.diagnostics[ctx.diagnostics.length - 1];
  if (diagnostic) seen.set(node, diagnostic);
}

/**
 * Erase an earlier round's refusal of `node`, now that it has been recovered.
 *
 * `structure.register-vm` linearises loops `structure.control-flow` reports,
 * and a refusal that is never withdrawn makes a recovered dispatcher look, in
 * the report, exactly like one the engine gave up on.
 */
export function withdrawRefusal(ctx: PassContext, node: t.Node, evidence: string): void {
  const seen = refusals(ctx, evidence);
  const diagnostic = seen.get(node);
  if (!diagnostic) return;
  seen.delete(node);

  const at = ctx.diagnostics.indexOf(diagnostic);
  if (at !== -1) ctx.diagnostics.splice(at, 1);

  const index = ctx.detections.findIndex(
    (d) => d.kind === 'control-flow-flattening' && d.evidence === evidence,
  );
  const detection = index === -1 ? undefined : ctx.detections[index];
  if (!detection) return;
  detection.count = (detection.count ?? 1) - 1;
  if (detection.count <= 0) ctx.detections.splice(index, 1);
}
