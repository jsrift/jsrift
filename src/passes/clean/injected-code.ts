import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { hasLeadingComment, hoistedVarNames, insideWith, isUnboundUndefined } from '../../util/ast.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/** Sentinel for "this node is not a compile-time constant". `undefined` is a value. */
const NOT_CONSTANT = Symbol('not-constant');
type Constant = string | number | boolean | null | undefined;
type Folded = Constant | typeof NOT_CONSTANT;

/** Depth cap on the operand folding walk; real guards are two or three levels. */
const MAX_FOLD_DEPTH = 12;

/**
 * Remove obfuscator.io's `deadCodeInjection`.
 *
 * The transform clones a block from elsewhere in the program and hides it behind
 * a guard that compares two junk constants - `if (dec(3) === dec(4))`, which is
 * opaque until the string array has been decoded and is a plain literal
 * comparison afterwards. That is why this runs in the fixpoint loop and not
 * before the `strings` stage.
 *
 * It is deliberately narrower than `clean.dead-branches`: only a comparison of
 * two literals qualifies, which is what makes the `dead-code-injection`
 * fingerprint it reports meaningful rather than a restatement of "a constant
 * was folded".
 */
export const removeInjectedCodePass: Pass = {
  id: 'clean.injected-code',
  title: 'Remove obfuscator dead-code injection',
  stage: 'clean',
  technique: 'deadCodeRemoval',
  run: (ctx) => {
    // Deliberately not gated on `removeConstantBranches`: that option is about
    // branches in the user's own code, whereas this shape is filler the
    // obfuscator added and the technique flag already governs whether it goes.
    traverse(ctx.ast, {
      IfStatement(path) {
        foldInjectedGuard(path, ctx);
      },
      SwitchStatement(path) {
        foldInjectedSwitch(path, ctx);
      },
    });
  },
};

// ---------------------------------------------------------------------------
// The `if` form
// ---------------------------------------------------------------------------

function foldInjectedGuard(path: NodePath<t.IfStatement>, ctx: PassContext): void {
  const verdict = constantComparison(path.node.test, path);
  if (verdict === undefined) return;

  const kept = verdict ? path.node.consequent : path.node.alternate;
  const dropped = verdict ? path.node.alternate : path.node.consequent;
  if (dropped && ctx.config.techniqueOptions.deadCodeRemoval.keepCommented && carriesComment(dropped)) {
    return;
  }

  const hoisted = dropped ? hoistedFrom(path, dropped) : [];
  if (!hoisted) return;

  const operator = (path.node.test as t.BinaryExpression).operator;
  ctx.report('dead-code-injection', `constant guard (${operator} between literals)`, 0.9, 1);
  replaceStatement(path, kept ?? undefined, hoisted, ctx);
}

/**
 * `true` / `false` when both operands are literals, otherwise `undefined`.
 *
 * Never guesses: an operand that reads a variable, or a loose comparison across
 * two types, leaves the guard alone. Half the emitted sites are `a === b` with
 * different operands and half are `a !== a` with identical ones - both are false,
 * so the operator is not a signal and the values have to be evaluated.
 */
function constantComparison(test: t.Node, at: NodePath): boolean | undefined {
  if (!t.isBinaryExpression(test)) return undefined;
  const operator = test.operator;
  if (operator !== '===' && operator !== '!==' && operator !== '==' && operator !== '!=') {
    return undefined;
  }

  const left = foldConstant(test.left as t.Node, at);
  if (left === NOT_CONSTANT) return undefined;
  const right = foldConstant(test.right, at);
  if (right === NOT_CONSTANT) return undefined;

  // `==` across two types needs the coercion table; only the cases where it
  // provably agrees with `===` are folded.
  const loose = operator === '==' || operator === '!=';
  if (loose && typeof left !== typeof right) return undefined;

  const equal = left === right;
  return operator === '===' || operator === '==' ? equal : !equal;
}

/**
 * Compile-time value of a node, or `NOT_CONSTANT`.
 *
 * `at` is the statement being folded, needed for exactly one node type - the
 * name `undefined`, whose value depends on where it is read - and threaded
 * rather than defaulted so no caller can forget it. Every operand of a guard
 * shares the statement's position, so one path answers for the whole walk.
 */
function foldConstant(node: t.Node | null | undefined, at: NodePath, depth = 0): Folded {
  if (!node || depth > MAX_FOLD_DEPTH) return NOT_CONSTANT;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'Identifier':
      // The one identifier this folder accepts, and only where the name really
      // denotes the value: `function f(undefined) { if (undefined === void 0) }`
      // is a guard that is *false* at run time, and folding it to `true` keeps
      // the branch the program does not take and deletes the one it does.
      // `with ({undefined: 1}) { ... }` does the same with no binding anywhere to
      // find, which is why both halves are asked. Ordered so the ancestor walk
      // is reached only once the node is known to be a free `undefined`.
      return isUnboundUndefined(node, at.scope) && !insideWith(at)
        ? undefined
        : NOT_CONSTANT;
    case 'TemplateLiteral': {
      if (node.expressions.length > 0 || node.quasis.length !== 1) return NOT_CONSTANT;
      const quasi = node.quasis[0];
      return quasi ? (quasi.value.cooked ?? quasi.value.raw) : NOT_CONSTANT;
    }
    case 'UnaryExpression': {
      const argument = foldConstant(node.argument, at, depth + 1);
      if (argument === NOT_CONSTANT) return NOT_CONSTANT;
      switch (node.operator) {
        case '-':
          return typeof argument === 'number' ? -argument : NOT_CONSTANT;
        case '+':
          return typeof argument === 'number' ? argument : NOT_CONSTANT;
        case '!':
          return !argument;
        case 'void':
          return undefined;
        default:
          return NOT_CONSTANT;
      }
    }
    case 'BinaryExpression': {
      // `splitStrings` reassembles values with `+`, so a guard operand is often a
      // concatenation chain rather than a single literal.
      if (node.operator !== '+') return NOT_CONSTANT;
      const left = foldConstant(node.left as t.Node, at, depth + 1);
      if (left === NOT_CONSTANT) return NOT_CONSTANT;
      const right = foldConstant(node.right, at, depth + 1);
      if (right === NOT_CONSTANT) return NOT_CONSTANT;
      if (typeof left === 'string' && typeof right === 'string') return left + right;
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      return NOT_CONSTANT;
    }
    default:
      return NOT_CONSTANT;
  }
}

// ---------------------------------------------------------------------------
// The `switch` form
// ---------------------------------------------------------------------------

/**
 * `switch ('KsQ') { case 'KsQ': real(); break; case 'wRt': garbage(); break; }`
 *
 * Only folded when the whole dispatch is decidable: a literal discriminant, every
 * case test a literal, and a selected case that ends where it says it does. A
 * case that falls through into the next one is refused outright.
 */
function foldInjectedSwitch(path: NodePath<t.SwitchStatement>, ctx: PassContext): void {
  const discriminant = foldConstant(path.node.discriminant, path);
  if (discriminant === NOT_CONSTANT) return;

  let selected = -1;
  let fallback = -1;
  for (let index = 0; index < path.node.cases.length; index++) {
    const test = path.node.cases[index]?.test;
    if (!test) {
      if (fallback >= 0) return;
      fallback = index;
      continue;
    }
    const value = foldConstant(test, path);
    if (value === NOT_CONSTANT) return;
    if (selected < 0 && value === discriminant) selected = index;
  }

  const chosen = selected >= 0 ? selected : fallback;
  const cases = path.node.cases;
  const kept = chosen >= 0 ? cases[chosen] : undefined;
  if (chosen >= 0 && !kept) return;

  const body = kept ? withoutTrailingBreak(kept, chosen === cases.length - 1) : [];
  if (body === undefined) return;

  const options = ctx.config.techniqueOptions.deadCodeRemoval;
  const dropped = cases.filter((_, index) => index !== chosen);
  if (options.keepCommented && dropped.some((entry) => entry.consequent.some(carriesComment))) {
    return;
  }
  // Every case shares the switch's one scope, so a `let`, `const` or `class`
  // in a case that is never entered still binds for the case that is, and a
  // read there is in its dead zone: `switch (1) { case 1: log(x); break; case
  // 2: let x = 2; }` throws, and with case 2 gone it read the outer `x`.
  if (dropped.some((entry) => entry.consequent.some(isLexicalDeclaration))) return;
  // A `function` in that case is the same binding with the opposite value: it
  // is instantiated when the switch is ENTERED, whichever case runs, so
  // `switch (1) { case 0: function f() {} break; case 1: log(typeof f); }`
  // prints `function`. The bare `var f` that `hoistedFrom` writes for it is
  // the Annex B var, which the unrun case never assigned - right for a read
  // outside the switch, which is all that var can reach, and wrong for one
  // inside it, which read `undefined` from the var and, in strict code,
  // nothing at all. So the fold is refused while anything in the surviving
  // switch can still read the block binding: a reference the scope lists, or
  // string code that can reach the scope by name.
  if (dropped.some((entry) => entry.consequent.some((node) => readInsideSwitch(node, path, dropped, ctx)))) {
    return;
  }

  const hoisted = hoistedFrom(path, ...dropped);
  if (!hoisted) return;

  ctx.report('dead-code-injection', 'constant switch dispatch', 0.9, 1);
  const survivor = body.length > 0 ? t.blockStatement(body) : undefined;
  replaceStatement(path, survivor, hoisted, ctx);
}

function isLexicalDeclaration(node: t.Statement): boolean {
  if (t.isClassDeclaration(node)) return true;
  return t.isVariableDeclaration(node) && node.kind !== 'var';
}

/**
 * Whether a function declared in a dropped case is read from the part of the
 * switch that survives. A reference inside a dropped case goes with it. The
 * binding is the switch scope's own, and one it does not own - a second
 * declaration of the name registered on the first - is a refusal.
 */
function readInsideSwitch(
  node: t.Statement,
  path: NodePath<t.SwitchStatement>,
  dropped: readonly t.SwitchCase[],
  ctx: PassContext,
): boolean {
  if (!t.isFunctionDeclaration(node)) return false;
  if (!node.id) return true;
  const binding = path.scope.getOwnBinding(node.id.name);
  if (!binding || binding.path.node !== node) return true;
  const inDropped = (reference: NodePath): boolean =>
    dropped.some((entry) => reference.findParent((p) => p.node === entry) !== null);
  if (binding.referencePaths.some((reference) => !inDropped(reference))) return true;
  return stringCodeFacts(ctx).reaches(path.scope);
}

/**
 * The statements a case actually runs, or `undefined` when splicing them out of
 * the switch would change where control goes.
 *
 * A `break` inside a case binds to the switch. Once the switch is gone the same
 * `break` would bind to an enclosing loop instead, so only a single trailing
 * one, which is dropped, is tolerated.
 */
function withoutTrailingBreak(entry: t.SwitchCase, isLast: boolean): t.Statement[] | undefined {
  const statements = [...entry.consequent];
  const last = statements[statements.length - 1];

  if (t.isBreakStatement(last)) {
    if (last.label) return undefined;
    statements.pop();
  } else if (!isLast) {
    // Without a terminator control falls through into the next case, which is
    // one of the cases about to be deleted. An empty case falls through too.
    const terminates =
      t.isReturnStatement(last) || t.isThrowStatement(last) || t.isContinueStatement(last);
    if (!terminates) return undefined;
  }

  if (statements.some((statement) => containsSwitchBreak(statement))) return undefined;
  return statements;
}

/**
 * Whether a statement contains a `break` that the enclosing switch owns. Loops
 * and nested switches capture their own, so the walk does not descend into them.
 */
function containsSwitchBreak(root: t.Statement): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    if (t.isBreakStatement(node)) return true;
    // A labelled statement can be the target of a `break label` from anywhere
    // below, so treat the whole construct as opaque rather than reasoning about it.
    if (t.isLabeledStatement(node)) return true;
    if (t.isFunction(node) || t.isClass(node)) continue;
    if (t.isLoop(node) || t.isSwitchStatement(node)) continue;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hoisting and replacement
// ---------------------------------------------------------------------------

/**
 * The `var` and function names a deleted region contributed to its enclosing
 * function scope, as one value-less declaration - or `undefined` when that
 * cannot be decided, which refuses the fold.
 *
 * This is the hazard that makes naive dead-code removal wrong: a `var` inside a
 * branch that never ran is still a declared binding, and an injected clone is
 * full of them. Re-declaring the names keeps the observable binding set intact;
 * a function declared in a branch that never executed was only ever `undefined`,
 * so a bare `var` is the honest reconstruction of it too - where Annex B gave
 * it a var. `hoistedVarNames` decides which did, the same way for
 * `clean/dead-branches.ts`; a strict function or a same-named `let` beside the
 * guard means no var, and one written anyway is a SyntaxError or a call that
 * throws.
 */
function hoistedFrom(anchor: NodePath, ...dropped: t.Node[]): t.Statement[] | undefined {
  const names = hoistedVarNames(anchor, new Set(dropped));
  if (!names) return undefined;
  if (names.length === 0) return [];
  return [
    t.variableDeclaration(
      'var',
      names.map((name) => t.variableDeclarator(t.identifier(name))),
    ),
  ];
}

function replaceStatement(
  path: NodePath<t.Statement>,
  kept: t.Statement | undefined,
  hoisted: t.Statement[],
  ctx: PassContext,
): void {
  const parts = [...hoisted];
  if (kept) {
    if (canFlatten(kept)) parts.push(...kept.body);
    else parts.push(kept);
  }

  if (parts.length === 0) {
    path.remove();
  } else if (parts.length === 1) {
    const only = parts[0]!;
    t.inheritLeadingComments(only, path.node);
    t.inheritTrailingComments(only, path.node);
    path.replaceWith(only);
  } else if (path.inList) {
    path.replaceWithMultiple(parts);
  } else {
    path.replaceWith(t.blockStatement(parts));
  }
  ctx.markChanged();
}

/** Splicing a block's contents into the parent list costs lexical declarations their scope. */
function canFlatten(kept: t.Statement): kept is t.BlockStatement {
  if (!t.isBlockStatement(kept) || kept.directives.length > 0) return false;
  return !kept.body.some(
    (statement) =>
      t.isFunctionDeclaration(statement) ||
      t.isClassDeclaration(statement) ||
      (t.isVariableDeclaration(statement) && statement.kind !== 'var'),
  );
}

function carriesComment(node: t.Statement): boolean {
  if (hasLeadingComment(node)) return true;
  if (Array.isArray(node.innerComments) && node.innerComments.length > 0) return true;
  return t.isBlockStatement(node) && node.body.some(hasLeadingComment);
}
