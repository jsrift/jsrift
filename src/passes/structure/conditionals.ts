import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { countNodes, hasLeadingComment, insideWith, isUnboundUndefined } from '../../util/ast.js';

/**
 * Node count above which a ternary branch stops being easier to read than the
 * `if`/`else` it stands for. Small ternaries (`return a ? 1 : 2`) are left alone.
 */
const LARGE_BRANCH_NODES = 20;

export const recoverConditionalsPass: Pass = {
  id: 'structure.conditionals',
  title: 'Restore if/else from expression forms',
  stage: 'structure',
  technique: 'statementRecovery',
  visitor: (ctx) => ({
    ExpressionStatement(path) {
      recoverStatement(path, ctx);
    },
    ReturnStatement(path) {
      splitLargeReturnTernary(path, ctx);
    },
    IfStatement: {
      // Runs on exit so that any `if` this pass just synthesised inside the
      // consequent has already been created and can be collapsed in one go.
      exit(path) {
        braceDanglingConsequent(path, ctx);
        collapseNestedIf(path, ctx);
      },
    },
  }),
};

/**
 * Write down the braces the printer is going to add anyway.
 *
 * `if (a) if (b) x(); else y();` binds the `else` to the inner `if`, so an
 * outer `if` that has an `else` of its own cannot be printed without bracing
 * its consequent - the generator inserts those braces itself, from
 * `node.alternate && isIfStatement(getLastStatement(node.consequent))`. The
 * tree it prints from still says "bare statement", and the two disagree until
 * the output is parsed again.
 *
 * That disagreement is not cosmetic, because "is this in a statement list" is
 * the question a pass asks before it may insert a sibling.
 * `simplify/sequences.ts` refuses `if (a, b)` in exactly this position for that
 * reason, and on `lightly-obfuscated.js` at `balanced` one such `if` survived
 * the whole run: the engine converged with it unhoisted, printed the braces,
 * and a second run - reading the same program, now with a statement list around
 * it - hoisted it and emitted 164 characters the first run could not. Measured
 * with a probe over the settled tree: `hoistable=0 notList=5` at the end of run
 * one, `hoistable=1 notList=4` after the reparse.
 *
 * The condition mirrors the generator's exactly rather than bracing every bare
 * consequent, so the braces themselves cost nothing: they are the ones the
 * printer was going to emit at that position anyway. What moves the output is
 * the work they unblock, and it moves it to the run that should have done it.
 * Measured with only the call to this function reverted, the same +164 appears
 * on four of the fifteen preset/fixture pairs - `lightly-obfuscated.js` and
 * `obfuscated2.js`, each at 'balanced' and at 'aggressive' - and on every one
 * the first run now emits what the second used to.
 */
function braceDanglingConsequent(path: NodePath<t.IfStatement>, ctx: PassContext): void {
  const node = path.node;
  if (!node.alternate) return;
  const consequent = node.consequent;
  if (t.isBlockStatement(consequent)) return;
  if (!t.isIfStatement(lastStatementOf(consequent))) return;

  const block = t.blockStatement([consequent]);
  block.loc = consequent.loc;
  node.consequent = block;
  ctx.markChanged();
}

/**
 * The statement a dangling `else` would attach to, following the same `body`
 * chain `@babel/generator` walks: a `while`, `for` or label carries its
 * consequent through to the statement inside it.
 */
function lastStatementOf(statement: t.Statement): t.Statement {
  let current = statement;
  for (let depth = 0; depth < MAX_DANGLING_DEPTH; depth++) {
    const body = (current as { body?: unknown }).body;
    if (!body || Array.isArray(body) || !t.isStatement(body as t.Node)) return current;
    current = body as t.Statement;
  }
  return current;
}

/**
 * Nesting followed before giving up. A chain this long cannot occur in parsed
 * code without a statement in between, and stopping early only means the block
 * is left to the printer, which is where it is today.
 */
const MAX_DANGLING_DEPTH = 64;

/**
 * `a && b()` / `a || b()` / `a ? b() : c()` used purely for their side effects.
 *
 * Only an `ExpressionStatement` qualifies: it is the one position where the
 * value of the expression is guaranteed to be discarded, which is what makes
 * the rewrite to a statement equivalent.
 */
function recoverStatement(path: NodePath<t.ExpressionStatement>, ctx: PassContext): void {
  const expression = path.node.expression;

  if (t.isLogicalExpression(expression)) {
    // `&&` and `||` branch on the truthiness of their left operand, which is
    // exactly what the `if` test below reads. `??` branches on nullishness, and
    // no test over the same operand stands in for it: `0`, `''`, `false` and
    // `NaN` are falsy yet defined, so `a ?? b()` leaves `b()` unevaluated where
    // `if (!a) b()` runs it and `if (a) b()` skips it for `null`/`undefined`.
    if (expression.operator !== '&&' && expression.operator !== '||') return;
    if (!isStatementWorthy(expression.right)) return;
    const test = expression.operator === '&&' ? expression.left : negate(expression.left);
    const replacement = t.ifStatement(test, blockOf(expression.right));
    path.replaceWith(t.inherits(replacement, path.node));
    ctx.markChanged();
    return;
  }

  if (!t.isConditionalExpression(expression)) return;
  const { test, consequent, alternate } = expression;
  if (!isStatementWorthy(consequent) && !isStatementWorthy(alternate)) return;

  const consequentIsFiller = isDiscardableValue(consequent, path);
  const alternateIsFiller = isDiscardableValue(alternate, path);
  if (consequentIsFiller && alternateIsFiller) return;

  let replacement: t.IfStatement;
  if (alternateIsFiller) {
    replacement = t.ifStatement(test, blockOf(consequent));
  } else if (consequentIsFiller) {
    replacement = t.ifStatement(negate(test), blockOf(alternate));
  } else {
    replacement = t.ifStatement(test, blockOf(consequent), blockOf(alternate));
  }
  path.replaceWith(t.inherits(replacement, path.node));
  ctx.markChanged();
}

/**
 * `return a ? b : c` is already idiomatic, so it only becomes an `if` chain when
 * a branch is big enough that the ternary is hiding structure rather than
 * expressing it. Nested ternaries unroll into `else if` rather than nesting.
 */
function splitLargeReturnTernary(path: NodePath<t.ReturnStatement>, ctx: PassContext): void {
  const argument = path.node.argument;
  if (!t.isConditionalExpression(argument)) return;
  const widest = Math.max(countNodes(argument.consequent), countNodes(argument.alternate));
  if (widest <= LARGE_BRANCH_NODES) return;
  path.replaceWith(t.inherits(returnChain(argument), path.node));
  ctx.markChanged();
}

function returnChain(node: t.ConditionalExpression): t.IfStatement {
  const alternate = t.isConditionalExpression(node.alternate)
    ? returnChain(node.alternate)
    : t.blockStatement([t.returnStatement(node.alternate)]);
  return t.ifStatement(node.test, t.blockStatement([t.returnStatement(node.consequent)]), alternate);
}

/** `if (a) { if (b) { ... } }` -> `if (a && b) { ... }`, but only without an `else`. */
function collapseNestedIf(path: NodePath<t.IfStatement>, ctx: PassContext): void {
  const node = path.node;
  if (node.alternate) return;
  const inner = onlyIfStatement(node.consequent);
  if (!inner || inner.alternate) return;
  // A comment on the inner `if` documents *that* condition; merging the tests
  // would silently reattach it to the combined one.
  if (hasLeadingComment(inner)) return;

  const merged = t.logicalExpression('&&', node.test, inner.test);
  merged.loc = node.test.loc;
  node.test = merged;
  node.consequent = inner.consequent;
  ctx.markChanged();
}

function onlyIfStatement(statement: t.Statement): t.IfStatement | undefined {
  if (t.isIfStatement(statement)) return statement;
  if (!t.isBlockStatement(statement)) return undefined;
  if (statement.directives.length > 0 || statement.body.length !== 1) return undefined;
  const first = statement.body[0];
  return first && t.isIfStatement(first) ? first : undefined;
}

/**
 * The branch as a block. A comma sequence becomes one statement per operand
 * here rather than a round later, since each nesting level of an obfuscated
 * `a && (b, c && (d, ...))` otherwise costs the whole pipeline a further round.
 * The sequence's own comments have nowhere to go once it is gone, so such a
 * sequence stays whole.
 */
function blockOf(expression: t.Expression): t.BlockStatement {
  const expressions =
    t.isSequenceExpression(expression) && !hasComments(expression) ? expression.expressions : [expression];
  return t.blockStatement(
    expressions.map((operand) => {
      const statement = t.expressionStatement(operand);
      statement.loc = operand.loc;
      return statement;
    }),
  );
}

function hasComments(node: t.Node): boolean {
  return Boolean(node.leadingComments?.length || node.trailingComments?.length || node.innerComments?.length);
}

/**
 * Whether the expression is worth promoting to a statement of its own. Guard
 * expressions like `a && b.c` compute a value nobody reads; turning those into
 * an `if` adds structure without adding meaning.
 */
function isStatementWorthy(node: t.Expression): boolean {
  switch (node.type) {
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'TaggedTemplateExpression':
    case 'SequenceExpression':
      return true;
    case 'UnaryExpression':
      return node.operator === 'delete';
    case 'LogicalExpression':
      return isStatementWorthy(node.right);
    case 'ConditionalExpression':
      return isStatementWorthy(node.consequent) || isStatementWorthy(node.alternate);
    default:
      return false;
  }
}

/**
 * A branch that only produces a placeholder value, e.g. `x ? run() : void 0`.
 *
 * "Discardable" is a claim about *evaluation*, not just about the value: the
 * branch is dropped, so whatever it would have done has to be nothing. Every
 * literal here qualifies by construction; the bare name `undefined` only does
 * where reading it does nothing, which is why this needs the position and not
 * just the node. Two repros: a read of a `let undefined` before its declaration
 * throws a `ReferenceError`, and inside `with (o)` a read of `undefined` runs
 * `o`'s getter. Both effects vanished from the output when the branch that
 * carried them was deleted as filler.
 */
function isDiscardableValue(node: t.Expression, at: NodePath): boolean {
  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
      return true;
    case 'Identifier':
      return isUnboundUndefined(node, at.scope) && !insideWith(at);
    case 'UnaryExpression':
      return node.operator === 'void' && isDiscardableValue(node.argument, at);
    default:
      return false;
  }
}

/**
 * Negation for test position, where only truthiness is observed.
 *
 * Relational operators are deliberately *not* flipped: `!(a < b)` is not
 * `a >= b` when either side is `NaN`.
 */
function negate(node: t.Expression): t.Expression {
  if (t.isUnaryExpression(node) && node.operator === '!') return node.argument;
  if (t.isBooleanLiteral(node)) return t.inherits(t.booleanLiteral(!node.value), node);
  if (t.isBinaryExpression(node)) {
    const flipped = EQUALITY_INVERSE[node.operator];
    if (flipped) {
      const inverted = t.binaryExpression(flipped, node.left as t.Expression, node.right);
      return t.inherits(inverted, node);
    }
  }
  return t.unaryExpression('!', node);
}

const EQUALITY_INVERSE: Partial<Record<string, '==' | '!=' | '===' | '!=='>> = {
  '==': '!=',
  '!=': '==',
  '===': '!==',
  '!==': '===',
};
