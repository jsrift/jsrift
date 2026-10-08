import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { freezeHazardSite } from '../naming/allocate.js';
import type { PassContext } from '../pipeline/context.js';
import { invalidateStringCodeFacts } from './string-code.js';

/**
 * A rewrite has just put the node at `path` where it is. If that position is
 * one the classifier reads as source, the facts memoised for this iteration
 * describe a tree that no longer exists, and every later pass that asks them
 * - the prune that deletes the decoder, the map pass that deletes a map once
 * its reads are gone - would be deleting a name a string still spells.
 *
 * The classifier grades a timer on its argument as WRITTEN: `setTimeout(dec(0),
 * 0)` is a call result, a callback as far as anything can tell, so it is no
 * hazard and the facts say so. The strings pass then replaces `dec(0)` with
 * `'log(dec(2))'`, and the same call is a readable program that names the
 * decoder - read by the prune in the same stage through the same memoised
 * facts. Executed: `var A = ['log(dec(2))', 'beta', 'gamma']; function dec(i)
 * { return A[i]; } setTimeout(dec(0), 0); log(dec(1))` printed `beta` and
 * then `gamma`, and came out as `setTimeout('log(dec(2))', 0); log('beta')`
 * with `dec` deleted, which prints `beta` and throws `ReferenceError` from
 * the timer - at every preset, conservative included. The same through a
 * name the timer reads (`var s = dec(0); setTimeout(s, 0)`), through an
 * `.apply` vector, to a map whose read a fold turned into the literal that
 * names it, and to a `g['eval'](src)` the property pass spells out.
 *
 * The cure `analysis/string-code.ts` names for a pass that introduces string
 * code is {@link invalidateStringCodeFacts} at the rewrite, and this is the
 * test for whether a rewrite did: the rest of the tree is untouched, so only
 * the path from the new node up to a construct that compiles it can have
 * changed the answer. That path is walked through the shapes the classifier
 * itself reads through - an `.apply` array, an arm, a `+`, a sequence, and a
 * name whose reads feed such an argument - and the construct at the top is
 * asked through the classifier, never a second list of names. Only the
 * position is examined, so an ordinary `f(dec(0))` or `o[dec(0)]` costs a few
 * type checks per site and recomputes nothing.
 */
export function refreshStringCodeFacts(ctx: PassContext, path: NodePath): void {
  if (landsAsStringCode(path, MAX_READ_HOPS)) invalidateStringCodeFacts(ctx);
}

/**
 * Whether the node at `path` sits where a construct compiles it, or feeds a
 * name that does.
 *
 * A call is the stop, callee and argument alike: a member spelled out may
 * have become the `eval` of an indirect call, a literal in argument position
 * may have become a source, and the classifier's answer for the call is the
 * answer either way. Anything else - a member key, an object value, a return
 * - is a position no construct compiles.
 */
function landsAsStringCode(path: NodePath, hops: number): boolean {
  let current: NodePath = path;
  for (;;) {
    const parent = current.parentPath;
    if (!parent || !current.node) return false;
    const node = current.node;
    if (parent.isCallExpression() || parent.isNewExpression() || parent.isOptionalCallExpression()) {
      return freezeHazardSite(parent) !== null;
    }
    if (
      parent.isArrayExpression() ||
      parent.isLogicalExpression() ||
      parent.isBinaryExpression({ operator: '+' }) ||
      (parent.isConditionalExpression() && parent.node.test !== node) ||
      (parent.isSequenceExpression() &&
        parent.node.expressions[parent.node.expressions.length - 1] === node)
    ) {
      current = parent;
      continue;
    }
    if (parent.isVariableDeclarator() && parent.node.init === node && t.isIdentifier(parent.node.id)) {
      return feedsStringCode(parent.scope.getBinding(parent.node.id.name), hops);
    }
    if (
      parent.isAssignmentExpression() &&
      parent.node.right === node &&
      t.isIdentifier(parent.node.left)
    ) {
      return feedsStringCode(parent.scope.getBinding(parent.node.left.name), hops);
    }
    return false;
  }
}

/** Whether any read of this binding sits where a construct compiles it. */
function feedsStringCode(binding: Binding | undefined, hops: number): boolean {
  if (!binding || hops === 0) return false;
  for (const reference of binding.referencePaths) {
    if (reference.removed || !reference.node) continue;
    if (landsAsStringCode(reference, hops - 1)) return true;
  }
  return false;
}

/**
 * Alias edges followed from the rewritten node to a construct's argument. The
 * classifier reads a timer's argument through the same number of `var s = t`
 * hops, so a chain this does not follow is one it would not read either.
 */
const MAX_READ_HOPS = 4;
