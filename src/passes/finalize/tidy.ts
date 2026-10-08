import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';

/**
 * The last cosmetic pass over a settled tree.
 *
 * Everything here is a rewrite whose equivalence can be argued from the
 * language spec alone - no assumptions about what the obfuscator meant, no
 * "this is probably fine". By the time this runs the reader is about to read
 * the output, so a rule that is only *usually* right would be indistinguishable
 * from source the author actually wrote.
 */
export const tidyOutputPass: Pass = {
  id: 'finalize.tidy',
  title: 'Final readability tidy-up',
  stage: 'finalize',
  technique: 'statementRecovery',
  visitor: (ctx) => ({
    IfStatement(path) {
      collapseElseIf(path, ctx);
    },
    BlockStatement(path) {
      if (dropTrailingReturns(path, ctx)) return;
      unwrapRedundantBlock(path, ctx);
    },
    UnaryExpression: {
      // On exit: simplifying the inner `!` first turns `!!(a === b)` into
      // `!(a !== b)` and then into `a === b`, which a single enter-order visit
      // would stop halfway through.
      exit(path) {
        simplifyNegation(path, ctx);
      },
    },
    EmptyStatement(path) {
      removeEmptyStatement(path, ctx);
    },
  }),
};

/** `else { if (x) ... }` -> `else if (x) ...`. */
function collapseElseIf(path: NodePath<t.IfStatement>, ctx: PassContext): void {
  const alternate = path.node.alternate;
  if (!t.isBlockStatement(alternate)) return;
  if (alternate.directives.length > 0 || alternate.body.length !== 1) return;

  const inner = alternate.body[0];
  if (!inner || !t.isIfStatement(inner)) return;
  // A comment attached to the `else` block itself has nowhere to go once the
  // braces are gone; a comment on the inner `if` moves with it and is safe.
  if (hasOwnComments(alternate)) return;

  path.node.alternate = inner;
  ctx.markChanged();
}

/**
 * `{ ... }` sitting in a statement list for no reason.
 *
 * The block only means something when it scopes a declaration, so anything
 * `let`/`const`/`class`/`function`-shaped pins it. `var` does not: it is
 * function-scoped and behaves identically either side of the braces.
 */
function unwrapRedundantBlock(path: NodePath<t.BlockStatement>, ctx: PassContext): void {
  const parent = path.parent;
  if (!t.isBlockStatement(parent) && !t.isProgram(parent) && !t.isStaticBlock(parent)) return;

  const node = path.node;
  if (node.directives.length > 0) return;
  if (node.body.some(declaresBlockScoped)) return;
  // Hoisting a string expression into the prologue position would re-promote it
  // to a directive on the next parse - `"use strict"` is not a comment.
  if (path.key === 0 && startsWithStringExpression(node)) return;

  if (node.body.length === 0) {
    if (hasOwnComments(node)) return;
    path.remove();
  } else {
    path.replaceWithMultiple([...node.body]);
  }
  ctx.markChanged();
}

function declaresBlockScoped(statement: t.Statement): boolean {
  if (t.isVariableDeclaration(statement)) return statement.kind !== 'var';
  return (
    t.isFunctionDeclaration(statement) ||
    t.isClassDeclaration(statement) ||
    // TypeScript declarations are block-scoped in type space and invisible to
    // Babel's scope tracker, so they can only be judged syntactically.
    t.isTSEnumDeclaration(statement) ||
    t.isTSModuleDeclaration(statement) ||
    t.isTSInterfaceDeclaration(statement) ||
    t.isTSTypeAliasDeclaration(statement) ||
    t.isTSDeclareFunction(statement) ||
    t.isTSImportEqualsDeclaration(statement)
  );
}

function startsWithStringExpression(block: t.BlockStatement): boolean {
  const first = block.body[0];
  return t.isExpressionStatement(first) && t.isStringLiteral(first.expression);
}

/**
 * Drop the `return;` a minifier leaves at the end of a function body.
 *
 * Every trailing one goes in a single visit rather than one per run: peeling
 * them off one at a time would make the pass non-idempotent for the (rare)
 * `{ ...; return; return; }` shape.
 */
function dropTrailingReturns(path: NodePath<t.BlockStatement>, ctx: PassContext): boolean {
  if (!path.parentPath?.isFunction()) return false;

  const statements = path.get('body');
  let removed = 0;
  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index];
    if (!statement || !statement.isReturnStatement() || statement.node.argument) break;
    if (hasOwnComments(statement.node)) break;
    statement.remove();
    removed++;
  }

  if (removed === 0) return false;
  ctx.markChanged(removed);
  return true;
}

/**
 * `!(a === b)` -> `a !== b`, and `!!x` -> `x` where only truthiness is read.
 *
 * The equality rewrite is unconditional because `!=` is *defined* as the
 * negation of `==`. Relational operators are deliberately not included: `!(a <
 * b)` is not `a >= b` when either operand is `NaN`.
 */
function simplifyNegation(path: NodePath<t.UnaryExpression>, ctx: PassContext): void {
  const node = path.node;
  if (node.operator !== '!') return;
  const argument = node.argument;

  if (t.isBinaryExpression(argument)) {
    const inverse = EQUALITY_INVERSE[argument.operator];
    // `left` is only a PrivateName for `#x in obj`, which is not invertible.
    if (!inverse || t.isPrivateName(argument.left)) return;
    const flipped = t.binaryExpression(inverse, argument.left, argument.right);
    path.replaceWith(t.inherits(flipped, node));
    ctx.markChanged();
    return;
  }

  if (!t.isUnaryExpression(argument) || argument.operator !== '!') return;
  if (!isTruthinessOnly(path)) return;
  // `replaceWith` carries the comments across; the inner node keeps its own
  // `loc`, which is the more accurate mapping of the two.
  path.replaceWith(argument.argument);
  ctx.markChanged();
}

const EQUALITY_INVERSE: Partial<Record<string, '==' | '!=' | '===' | '!=='>> = {
  '==': '!=',
  '!=': '==',
  '===': '!==',
  '!==': '===',
};

/**
 * True when the value at this position is consumed as a condition and nothing
 * else, so an explicit boolean coercion adds nothing.
 *
 * `&&` and `||` *propagate an operand's value* rather than a boolean, so an
 * operand only qualifies when the whole logical expression does - `const ok =
 * !!x || y` is not `const ok = x || y`. `??` never qualifies: it distinguishes
 * `null`/`undefined` from `false`, which is exactly what `!!` erases.
 */
function isTruthinessOnly(path: NodePath): boolean {
  const parentPath = path.parentPath;
  if (!parentPath) return false;
  const parent = parentPath.node;
  const node = path.node;

  if (
    t.isIfStatement(parent) ||
    t.isWhileStatement(parent) ||
    t.isDoWhileStatement(parent) ||
    t.isForStatement(parent) ||
    t.isConditionalExpression(parent)
  ) {
    return parent.test === node;
  }
  if (t.isUnaryExpression(parent)) return parent.operator === '!';
  if (t.isLogicalExpression(parent) && parent.operator !== '??') {
    return isTruthinessOnly(parentPath);
  }
  return false;
}

/** A stray `;`, but not the one that *is* the body of `if (x);` or `for (;;);`. */
function removeEmptyStatement(path: NodePath<t.EmptyStatement>, ctx: PassContext): void {
  if (!Array.isArray(path.container)) return;
  if (hasOwnComments(path.node)) return;
  path.remove();
  ctx.markChanged();
}

/**
 * Whether deleting this node would delete a comment with it. Babel attaches a
 * trailing comment to the node before it as well as the node after, so this is
 * deliberately generous: keeping an unnecessary `;` costs a character, losing a
 * comment costs the reader the only prose in the file.
 */
function hasOwnComments(node: t.Node): boolean {
  return (
    (node.leadingComments?.length ?? 0) > 0 ||
    (node.innerComments?.length ?? 0) > 0 ||
    (node.trailingComments?.length ?? 0) > 0
  );
}
