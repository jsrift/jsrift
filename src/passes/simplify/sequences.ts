import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';

/**
 * Comma sequences are only expanded where the hoisted expressions provably keep
 * their evaluation order relative to everything around them. That rules out:
 *
 * - a `switch` discriminant - `switch (b = o[k], b[p])` evaluates the assignment
 *   *as part of* choosing a case, and lifting it above the `switch` reorders it
 *   against any expression the discriminant is compared with;
 * - a `for` update or init, which run once per iteration / once before the loop,
 *   not at the point the statement appears;
 * - an operand of `&&`, `||`, `??` or a ternary branch, which may never run;
 * - argument lists and any other nested expression position.
 *
 * There is no partial credit here: guessing wrong produces code that looks
 * plausible and behaves differently, which is the one failure mode a reader
 * cannot detect.
 */
export const expandSequencesPass: Pass = {
  id: 'simplify.sequences',
  title: 'Expand comma sequences into statements',
  stage: 'simplify',
  technique: 'statementRecovery',
  visitor: (ctx) => ({
    ExpressionStatement: (path: NodePath<t.ExpressionStatement>) => expandStatement(path, ctx),
    ReturnStatement: (path: NodePath<t.ReturnStatement>) => expandCompletion(path, ctx),
    ThrowStatement: (path: NodePath<t.ThrowStatement>) => expandCompletion(path, ctx),
    IfStatement: (path: NodePath<t.IfStatement>) => hoistIfTest(path, ctx),
    ArrowFunctionExpression: (path: NodePath<t.ArrowFunctionExpression>) => expandArrowBody(path, ctx),
  }),
};

/** `a(), b(), c();` -> three statements. */
function expandStatement(path: NodePath<t.ExpressionStatement>, ctx: PassContext): void {
  const { expression } = path.node;
  if (!t.isSequenceExpression(expression)) return;
  replaceStatement(path, statementsFor(expression.expressions), ctx);
}

/**
 * `return a, b, c;` -> `a; b; return c;`
 *
 * Sound unconditionally: the leading expressions already run, in this order,
 * immediately before the returned value is computed.
 */
function expandCompletion(
  path: NodePath<t.ReturnStatement | t.ThrowStatement>,
  ctx: PassContext,
): void {
  const { argument } = path.node;
  if (!t.isSequenceExpression(argument)) return;
  const { leading, last } = splitSequence(argument);
  if (!last || leading.length === 0) return;

  const completion = t.isReturnStatement(path.node)
    ? t.returnStatement(last)
    : t.throwStatement(last);
  t.inherits(completion, path.node);
  // The replacement machinery reattaches the original statement's comments to
  // the new list; keeping the copy `inherits` made would print them twice.
  t.removeComments(completion);
  replaceStatement(path, [...statementsFor(leading), completion], ctx);
}

/** `if (a, b) ...` -> `a; if (b) ...`, only from a real statement list. */
function hoistIfTest(path: NodePath<t.IfStatement>, ctx: PassContext): void {
  const { test } = path.node;
  if (!t.isSequenceExpression(test)) return;
  // Inside an `else if` chain or a bodiless loop the `if` has no siblings to be
  // inserted before, and synthesising a block there would restructure the chain.
  if (!inStatementList(path)) return;

  const { leading, last } = splitSequence(test);
  if (!last || leading.length === 0) return;

  path.node.test = last;
  path.insertBefore(statementsFor(leading));
  ctx.markChanged();
}

/** `() => (a(), b)` -> `() => { a(); return b; }`. */
function expandArrowBody(path: NodePath<t.ArrowFunctionExpression>, ctx: PassContext): void {
  const body = path.node.body;
  if (!t.isSequenceExpression(body)) return;
  const { leading, last } = splitSequence(body);
  if (!last) return;

  const block = t.blockStatement([...statementsFor(leading), t.returnStatement(last)]);
  path.node.body = t.inherits(block, body);
  ctx.markChanged();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitSequence(sequence: t.SequenceExpression): {
  leading: t.Expression[];
  last: t.Expression | undefined;
} {
  const { expressions } = sequence;
  return {
    leading: expressions.slice(0, -1),
    last: expressions[expressions.length - 1],
  };
}

/**
 * Wrap each expression in a statement, moving any attached comments across so
 * they are not printed twice - the expression stays in the tree, so `t.inherits`
 * alone would leave a copy behind on both nodes.
 */
function statementsFor(expressions: readonly t.Expression[]): t.Statement[] {
  return expressions.map((expression) => {
    const statement = t.inherits(t.expressionStatement(expression), expression);
    t.removeComments(expression);
    return statement;
  });
}

/** True when the path sits in a statement array, so siblings can be inserted. */
function inStatementList(path: NodePath): boolean {
  return Array.isArray(path.container);
}

function replaceStatement(
  path: NodePath<t.Statement>,
  statements: t.Statement[],
  ctx: PassContext,
): void {
  if (statements.length === 0) return;
  if (inStatementList(path)) {
    path.replaceWithMultiple(statements);
  } else {
    // `if (x) a, b;` has nowhere to put siblings. A block is the only correct
    // rewrite, and is safe because nothing produced here is a declaration.
    path.replaceWith(t.blockStatement(statements));
  }
  ctx.markChanged();
}
