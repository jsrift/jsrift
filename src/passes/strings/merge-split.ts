import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { foldStringConcat } from '../../analysis/string-array.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';

/**
 * Reassemble the fragments obfuscator.io's `splitStrings` option leaves behind.
 *
 * That option chops every literal into fixed-length pieces - four characters is
 * the common setting, and the setting the real fixture uses - and rebuilds them
 * with `+` at runtime, so the string array holds `"werC"`, `"lass"`, `"tSiz"`
 * rather than `lowerClass` and `fontSize`. Nothing downstream can recognise a
 * property name, a URL or a jQuery selector until those are rejoined.
 *
 * A visitor, because the work is entirely node-local: one `+`, two literal
 * operands, one literal out.
 */
export const mergeSplitStringsPass: Pass = {
  id: 'strings.merge-split',
  title: 'Reassemble split string concatenations',
  stage: 'strings',
  technique: 'stringDecoding',
  visitor: (ctx) => ({
    // `exit` folds left-nested chains in one traversal: by the time
    // `("a" + "b") + "c"` is examined, its left operand is already `"ab"`.
    BinaryExpression: { exit: (path: NodePath<t.BinaryExpression>) => merge(path, ctx) },
  }),
};

function merge(path: NodePath<t.BinaryExpression>, ctx: PassContext): void {
  // `("a" + "b");` as a statement folds to `"a b";`, which at the top of a
  // function body is a *directive*, not an expression. Leaving the `+` alone
  // costs nothing; changing a function's strict-mode status costs everything.
  if (path.parentPath.isExpressionStatement()) return;

  const merged = foldStringConcat(path.node);
  if (!merged) return;

  path.replaceWith(t.inherits(merged, path.node));
  ctx.markChanged();
}
