import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';

type LoopPath = NodePath<
  t.ForStatement | t.WhileStatement | t.DoWhileStatement | t.ForInStatement | t.ForOfStatement
>;

/**
 * Loop shapes are the one place where an "obviously equivalent" rewrite usually
 * is not, because `continue` re-enters the header. Every rule here either leaves
 * the header alone or proves no `continue` can observe the difference.
 */
export const recoverLoopsPass: Pass = {
  id: 'structure.loops',
  title: 'Restore idiomatic loop forms',
  stage: 'structure',
  technique: 'statementRecovery',
  visitor: (ctx) => ({
    ForStatement(path) {
      ensureBlockBody(path, ctx);
      normalizeUpdate(path, ctx);
      liftUpdateWork(path, ctx);
      forToWhile(path, ctx);
    },
    WhileStatement(path) {
      ensureBlockBody(path, ctx);
    },
    ForInStatement(path) {
      ensureBlockBody(path, ctx);
    },
    ForOfStatement(path) {
      ensureBlockBody(path, ctx);
    },
    DoWhileStatement(path) {
      ensureBlockBody(path, ctx);
      unwrapRunOnce(path, ctx);
    },
  }),
};

/** A single-statement loop body reads as a block once anything else changes. */
function ensureBlockBody(path: LoopPath, ctx: PassContext): boolean {
  const body = path.node.body;
  if (t.isBlockStatement(body)) return true;
  // A declaration as a bare loop body only happens in sloppy-mode legacy code,
  // where wrapping it in a block would change where the binding lands.
  if (t.isDeclaration(body)) return false;
  const block = t.blockStatement([body]);
  block.loc = body.loc;
  path.node.body = block;
  ctx.markChanged();
  return true;
}

/**
 * `for (...; ...; ++i)` -> `for (...; ...; i++)`. The update expression's value is
 * discarded, so the two forms are indistinguishable here.
 */
function normalizeUpdate(path: NodePath<t.ForStatement>, ctx: PassContext): void {
  const update = path.node.update;
  if (!update) return;
  const parts = t.isSequenceExpression(update) ? update.expressions : [update];
  let changed = 0;
  for (const part of parts) {
    if (t.isUpdateExpression(part) && part.prefix) {
      part.prefix = false;
      changed++;
    }
  }
  if (changed > 0) ctx.markChanged(changed);
}

/**
 * Pull real work out of a comma-separated `for` update and into the end of the
 * body, leaving only the loop counter in the header.
 *
 * Only a *prefix* of the sequence can move, because the surviving tail still has
 * to run after it. Any `continue` would skip the moved expressions, so the
 * presence of one is a hard bail-out.
 */
function liftUpdateWork(path: NodePath<t.ForStatement>, ctx: PassContext): void {
  const update = path.node.update;
  if (!t.isSequenceExpression(update)) return;
  const body = path.node.body;
  if (!t.isBlockStatement(body)) return;

  const parts = update.expressions;
  let split = parts.length;
  while (split > 0 && isCounterUpdate(parts[split - 1]!)) split--;
  if (split === 0) return;

  const moving = parts.slice(0, split);
  // Splitting a pure `i++, j--` header makes it worse, not better; only do this
  // when the header is hiding a call.
  if (!moving.some(containsCall)) return;
  if (containsContinue(path)) return;

  for (const expression of moving) {
    const statement = t.expressionStatement(expression);
    statement.loc = expression.loc;
    body.body.push(statement);
  }

  const remaining = parts.slice(split);
  path.node.update =
    remaining.length === 0
      ? null
      : remaining.length === 1
        ? remaining[0]!
        : t.sequenceExpression(remaining);
  ctx.markChanged(moving.length);
}

/** `for (;;) {}` -> `while (true) {}`, `for (; t;) {}` -> `while (t) {}`. */
function forToWhile(path: NodePath<t.ForStatement>, ctx: PassContext): void {
  const node = path.node;
  if (node.init || node.update) return;
  const test = node.test ?? t.booleanLiteral(true);
  path.replaceWith(t.inherits(t.whileStatement(test, node.body), node));
  ctx.markChanged();
}

/**
 * `do { ... } while (false)` is a block that ran once, which is how obfuscators
 * smuggle a `break` into straight-line code. Without a `break` or `continue` it
 * is just a block, and saying so is strictly clearer.
 */
function unwrapRunOnce(path: NodePath<t.DoWhileStatement>, ctx: PassContext): void {
  if (!isLiteralFalse(path.node.test)) return;
  if (path.parentPath.isLabeledStatement()) return;
  const body = path.node.body;
  if (!t.isBlockStatement(body)) return;
  if (containsJump(path)) return;
  path.replaceWith(t.inherits(body, path.node));
  ctx.markChanged();
}

function isLiteralFalse(node: t.Expression): boolean {
  if (t.isBooleanLiteral(node)) return node.value === false;
  if (t.isNumericLiteral(node)) return node.value === 0;
  if (t.isUnaryExpression(node) && node.operator === '!') {
    return t.isNumericLiteral(node.argument) && node.argument.value !== 0;
  }
  return false;
}

/** `i++` / `i += 1`: an update that belongs in the loop header. */
function isCounterUpdate(node: t.Expression): boolean {
  if (t.isUpdateExpression(node)) return t.isIdentifier(node.argument);
  if (!t.isAssignmentExpression(node)) return false;
  if (node.operator !== '+=' && node.operator !== '-=') return false;
  return t.isIdentifier(node.left) && !containsCall(node.right);
}

function containsCall(node: t.Node): boolean {
  let found = false;
  const stack: unknown[] = [node];
  while (stack.length > 0 && !found) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const child = current as t.Node;
    if (typeof child.type !== 'string') continue;
    if (t.isCallExpression(child) || t.isNewExpression(child) || t.isOptionalCallExpression(child)) {
      found = true;
      break;
    }
    for (const key of t.VISITOR_KEYS[child.type] ?? []) {
      const value = (child as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return found;
}

/** Deliberately counts jumps belonging to nested loops too - this is a bail-out. */
function containsContinue(path: LoopPath): boolean {
  let found = false;
  path.traverse({
    ContinueStatement() {
      found = true;
    },
  });
  return found;
}

function containsJump(path: LoopPath): boolean {
  let found = false;
  path.traverse({
    ContinueStatement() {
      found = true;
    },
    BreakStatement() {
      found = true;
    },
  });
  return found;
}
