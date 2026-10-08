import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Pass } from '../../pipeline/pass.js';
import { hasLeadingComment } from '../../util/ast.js';
import { isSideEffectFree } from '../../util/purity.js';
import { isSemanticDirective } from '../simplify/proxy-functions.js';

/**
 * Delete a statement that evaluates a value and does nothing with it.
 *
 * `'string1';` is what a dead `var c = i(k.d, k.e)` leaves once the name is
 * dropped for want of a reader and the proxy call it held is expanded to the
 * literal it forwarded: the statement was kept for the call's effects, and
 * the literal has none. A literal, a bound name, a member read of one - an
 * expression `isSideEffectFree` vouches for - is a no-op as a statement,
 * under every preset: nothing runs, nothing throws, nothing is written.
 *
 * Two things are not no-ops and stay. A string statement in a prologue
 * position is a directive, and `'use strict'` there means something; every
 * other string is inert, but it is only removed off the prologue's head,
 * where dropping it cannot move a directive up. And a statement a human
 * annotated keeps its comment by keeping its place.
 */
export const removeDeadExpressionsPass: Pass = {
  id: 'clean.dead-expressions',
  title: 'Remove statements that evaluate to nothing',
  stage: 'clean',
  technique: 'core',
  visitor: (ctx) => ({
    ExpressionStatement(path) {
      const expression = path.node.expression;
      // The shapes named above and nothing else: asking the purity oracle
      // about every call and assignment statement of a program cost two
      // seconds a run on the 757 KB fixture, for statements it never clears.
      if (!isValueShape(expression) || hasLeadingComment(path.node)) return;
      if (t.isStringLiteral(expression) && directiveHead(path)) return;
      if (!isSideEffectFree(expression, path.scope)) return;
      path.remove();
      ctx.markChanged();
    },
  }),
};

/** A literal, a name, a member read, or `void 0`: what a statement can be and do nothing. */
function isValueShape(node: t.Expression): boolean {
  if (t.isLiteral(node) || t.isIdentifier(node) || t.isMemberExpression(node)) return true;
  return t.isUnaryExpression(node, { operator: 'void' }) && t.isNumericLiteral(node.argument);
}

/**
 * Whether a string statement leads its body's prologue, where the parser
 * reads it as a directive, and a semantic directive sits in the same
 * prologue - its own, or one after it, which removing this would not move.
 */
function directiveHead(path: NodePath<t.ExpressionStatement>): boolean {
  const container = path.container;
  if (!Array.isArray(container) || typeof path.key !== 'number') return false;
  const parent = path.parentPath;
  if (!parent?.isProgram() && !(parent?.isBlockStatement() && parent.parentPath?.isFunction())) {
    return false;
  }
  for (let index = 0; index <= path.key; index++) {
    const statement = container[index];
    if (!t.isExpressionStatement(statement) || !t.isStringLiteral(statement.expression)) return false;
  }
  for (let index = path.key; index < container.length; index++) {
    const statement = container[index];
    if (!t.isExpressionStatement(statement) || !t.isStringLiteral(statement.expression)) break;
    if (isSemanticDirective(statement.expression.value)) return true;
  }
  return false;
}
