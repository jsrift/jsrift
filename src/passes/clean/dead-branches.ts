import type { NodePath, Scope, Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts, type StringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { hasLeadingComment, hoistedVarNames, holdsDeclaredValue, insideWith, TreeOrder } from '../../util/ast.js';

/** Ceiling on the size of a test handed to Babel's constant evaluator. */
const MAX_TEST_NODES = 64;

/**
 * The two ways a test that Babel proves constant can still not be constant.
 *
 * Both are facts about what can happen to a NAME between its declaration and
 * the branch that reads it, and Babel's evaluator sees neither: it resolves an
 * identifier through the binding the scope reports and folds when that binding
 * is `constant`, which means only "nothing in the TREE reassigns it".
 */
interface Guards {
  /**
   * Whether a `with` has been entered anywhere in this traversal.
   *
   * Only a gate, exactly as `clean/unused.ts` uses its own: it keeps the
   * per-test `insideWith` ancestor walk off the overwhelming majority of files,
   * which contain no `with` at all. Reading it as "there is a `with`
   * somewhere, so stop folding" would be the wrong guard and is not what it
   * does - the refusal in {@link constantTruthiness} also requires the test to
   * *be* inside a `with` body.
   *
   * A flag filled in during the same traversal that reads it is sound here
   * because Babel enters a node before any of its descendants: a test inside a
   * `with` body is only reached after that `with`'s handler has run. Tests
   * reached before it are, by that same ordering, not inside one.
   */
  sawWith: boolean;
  /**
   * Whether code compiled from a string can write a binding a test reads.
   *
   * Unlike `sawWith` this is whole-program and known before the traversal
   * starts, because `analysis/string-code.ts` computes it once per fixpoint
   * iteration and hands the same answer to every pass that asks. `facts.empty`
   * is what keeps it free: a file with no string code in it never reaches the
   * per-binding question at all.
   */
  facts: StringCodeFacts;
  /** The tree numbered as it stands, for the timing proof; per traversal, which moves no statement. */
  order: TreeOrder;
}

export const removeDeadBranchesPass: Pass = {
  id: 'clean.dead-branches',
  title: 'Remove constant and unreachable branches',
  stage: 'clean',
  technique: 'deadCodeRemoval',
  visitor: (ctx) => {
    // Read once. The resolved config cannot change during a run, and this
    // three-deep lookup would otherwise repeat for every branch and every block
    // in the program, on every pass of the fixpoint loop.
    const options = ctx.config.techniqueOptions.deadCodeRemoval;
    const { keepCommented } = options;

    const visitor: Visitor<unknown> = {
      EmptyStatement(path) {
        // A bare `;` is only removable where a statement is optional. As an `if`
        // consequent or a loop body it is load-bearing syntax.
        if (!path.inList) return;
        path.remove();
        ctx.markChanged();
      },
      Program: {
        exit(path) {
          pruneUnreachable(path, 'body', keepCommented, ctx);
        },
      },
      SwitchCase: {
        exit(path) {
          pruneUnreachable(path, 'consequent', keepCommented, ctx);
        },
      },
      BlockStatement: {
        exit(path) {
          pruneUnreachable(path, 'body', keepCommented, ctx);
          dropEmptyBlock(path, keepCommented, ctx);
        },
      },
    };

    // With constant folding switched off these three handlers would return on
    // their first line, but registering them at all is not free: Babel decides
    // whether a node needs a `NodePath` from the visitor's key set, so an
    // unused handler still costs a path per node of that type.
    if (options.removeConstantBranches) {
      // Built here rather than at module scope because both fields describe one
      // traversal of one tree: `sawWith` is filled in as it runs, and the string
      // -code facts are re-asked every fixpoint iteration so that a hazard an
      // earlier stage deleted stops costing anything on the next round.
      const guards: Guards = { sawWith: false, facts: stringCodeFacts(ctx), order: new TreeOrder(ctx.ast) };
      // Registered beside the three handlers that consult it, and only when they
      // exist: by the note above, a visitor key costs a `NodePath` per node of
      // that type, which for `WithStatement` is zero on a file without one.
      visitor.WithStatement = () => {
        guards.sawWith = true;
      };
      visitor.IfStatement = (path) => foldConstantIf(path, keepCommented, ctx, guards);
      visitor.WhileStatement = (path) => dropNeverEnteredWhile(path, keepCommented, ctx, guards);
      visitor.ForStatement = (path) => dropNeverEnteredFor(path, keepCommented, ctx, guards);
    }
    return visitor;
  },
};

// ---------------------------------------------------------------------------
// Constant branches
// ---------------------------------------------------------------------------

function foldConstantIf(
  path: NodePath<t.IfStatement>,
  keepCommented: boolean,
  ctx: PassContext,
  guards: Guards,
): void {
  const truthy = constantTruthiness(path.get('test'), path.scope, guards);
  if (truthy === undefined) return;

  const kept = truthy ? path.node.consequent : path.node.alternate;
  const dropped = truthy ? path.node.alternate : path.node.consequent;
  if (keepCommented && dropped && carriesComment(dropped)) return;

  const hoisted = dropped ? hoistedFrom(path, dropped) : [];
  if (!hoisted) return;
  replaceStatement(path, kept ?? undefined, hoisted, ctx);
}

/** `while (false) { ... }` never runs its body, so only the hoisting survives. */
function dropNeverEnteredWhile(
  path: NodePath<t.WhileStatement>,
  keepCommented: boolean,
  ctx: PassContext,
  guards: Guards,
): void {
  if (constantTruthiness(path.get('test'), path.scope, guards) !== false) return;
  if (keepCommented && carriesComment(path.node.body)) return;
  const hoisted = hoistedFrom(path, path.node.body);
  if (!hoisted) return;
  replaceStatement(path, undefined, hoisted, ctx);
}

/** Same, except a `for` still runs its initialiser exactly once. */
function dropNeverEnteredFor(
  path: NodePath<t.ForStatement>,
  keepCommented: boolean,
  ctx: PassContext,
  guards: Guards,
): void {
  const init = path.node.init;
  // Hoisting a `let` initialiser out of the header would widen its scope.
  if (t.isVariableDeclaration(init) && init.kind !== 'var') return;
  if (constantTruthiness(path.get('test') as NodePath, path.scope, guards) !== false) return;
  if (keepCommented && carriesComment(path.node.body)) return;

  const survivor = init
    ? t.isVariableDeclaration(init)
      ? init
      : t.expressionStatement(init)
    : undefined;
  const hoisted = hoistedFrom(path, path.node.body);
  if (!hoisted) return;
  replaceStatement(path, survivor, hoisted, ctx);
}

/**
 * Constant truthiness of a test, or `undefined` when it cannot be proven.
 *
 * Purity is checked separately from evaluation: an expression can fold to a
 * constant and still have to run (`(log(), 1)`), and deleting the branch would
 * delete the effect with it.
 */
function constantTruthiness(
  testPath: NodePath,
  scope: Scope,
  guards: Guards,
): boolean | undefined {
  const node = testPath.node;
  if (!node || !looksStaticallyKnown(node)) return undefined;

  // Both refusals below are about the same blind spot from two directions:
  // `evaluateTruthy` and `scope.isPure` each resolve a name through the binding
  // the scope reports, and each treats that binding's value as the value the
  // test reads. Neither is reached unless the test names something, so the walk
  // that finds out is shared, and both gates are skipped outright on a file
  // that has neither a `with` nor any string code - which is nearly every file.
  if (guards.sawWith || !guards.facts.empty) {
    const names = namesRead(node);
    // Inside `with (o) { ... }` the binding is only the fallback: the name is
    // looked up on `o` first, at run time. `evaluateTruthy` therefore answers
    // for a variable the test may never read, and `scope.isPure` calls an
    // identifier pure when reading it can run a getter on `o`. Measured, not
    // hypothesised: `const flag = true; function g(o) { with (o) { if (flag)
    // a(); else b(); } }` called as `g({flag: false})` was folded to `a()` in a
    // program that runs `b()`.
    //
    // The refusal is narrowed twice so it stays the width of the hazard. It
    // needs the test to be inside a `with` *body* - a `with` elsewhere in the
    // file changes nothing here - and it needs the test to mention a name at
    // all, since an object environment intercepts nothing else.
    if (guards.sawWith && (names === undefined || names.size > 0) && insideWith(testPath)) {
      return undefined;
    }
    // The other direction: the binding is the right one, and its value is not.
    // `binding.constant` means "nothing in the TREE reassigns this", and a
    // write from code compiled out of a string is in no tree. Executed, not
    // hypothesised: `var flag = true; function g(s) { eval(s); if (flag)
    // log('a'); else log('b'); } g('flag = false');` printed "b" and came out
    // printing "a", and the same with `Function('flag = false')()` in place of
    // the `eval`.
    if (!guards.facts.empty && writableByStringCode(names, scope, guards.facts)) return undefined;
  }

  const truthy = testPath.evaluateTruthy();
  if (truthy === undefined) return undefined;
  if (!scope.isPure(node, true)) return undefined;
  // `evaluateTruthy` reads a name through its declarator's initialiser,
  // whatever the time: `if (!T)` in a function the prefix of `T`'s own
  // scope calls - through a getter or a `valueOf` it coerces - reads
  // `undefined`, and folded on the initialiser the test is wrong at every
  // preset. The proof the folders make is asked here too.
  const names = namesRead(node);
  if (names === undefined) return undefined;
  for (const name of names) {
    const binding = scope.getBinding(name);
    if (!binding || !binding.path.isVariableDeclarator() || !binding.path.node.init) continue;
    if (!holdsDeclaredValue(name, node, scope, guards.facts, guards.order)) return undefined;
  }
  return truthy;
}

/**
 * Whether string code could have written any name this test reads.
 *
 * Asked per binding rather than per file, which is what keeps the refusal off
 * the tests that string code cannot touch: a local in a function no direct
 * `eval` sits inside stays foldable in a program that calls `Function(src)`
 * elsewhere, and so does every test built only out of literals.
 */
function writableByStringCode(
  names: ReadonlySet<string> | undefined,
  scope: Scope,
  facts: StringCodeFacts,
): boolean {
  // The walk gave up before it had seen the whole test, so which names it reads
  // is unknown. That is a refusal, not a licence.
  if (names === undefined) return true;
  for (const name of names) {
    const binding = scope.getBinding(name);
    // Nothing bound it. `evaluateTruthy` folds exactly three free names -
    // `undefined`, `NaN` and `Infinity` - and deopts on every other unbound
    // one, and all three are non-writable, non-configurable properties of the
    // global object, so string code cannot change what a read of them yields
    // either. (What it CAN do is shadow them, and that is `insideWith`'s half
    // of the question, above.)
    if (!binding) continue;
    // A `const` is the one binding kind string code cannot write: `eval('x =
    // 1')` against one throws a TypeError rather than assigning, and folding a
    // branch does not move or delete the `eval` call, so that throw happens in
    // the output exactly where it happened in the input.
    if (binding.kind === 'const') continue;
    if (facts.addresses(binding)) return true;
  }
  return false;
}

/**
 * The names a test that {@link looksStaticallyKnown} accepted reads, or
 * `undefined` when the walk ran out of budget before it had seen all of them.
 *
 * Every identifier in an accepted test is a reference to a binding resolvable
 * from the test's own scope: the pre-filter admits only literals, operators and
 * identifiers, so there is no member property, no object key and no nested
 * function scope for a name to hide in.
 *
 * Walked separately rather than folded into `looksStaticallyKnown` because it
 * is reached only on a file that contains a `with` or string code; paying for
 * it in the hot pre-filter would cost every test in the program to serve those.
 */
function namesRead(node: t.Node): Set<string> | undefined {
  const names = new Set<string>();
  let budget = MAX_TEST_NODES;
  const stack: t.Node[] = [node];
  while (stack.length > 0) {
    if (budget-- <= 0) return undefined;
    const current = stack.pop()!;
    if (current.type === 'Identifier') {
      names.add(current.name);
      continue;
    }
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const value = (current as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') stack.push(item as t.Node);
      } else if (value && typeof value === 'object') {
        stack.push(value as t.Node);
      }
    }
  }
  return names;
}

/**
 * Cheap pre-filter so the evaluator is never invoked on the hundreds of
 * thousands of tests in a large bundle that obviously read runtime state.
 */
function looksStaticallyKnown(node: t.Node): boolean {
  let budget = MAX_TEST_NODES;
  const stack: t.Node[] = [node];
  while (stack.length > 0) {
    if (budget-- <= 0) return false;
    const current = stack.pop()!;
    switch (current.type) {
      case 'NumericLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'BigIntLiteral':
      case 'Identifier':
        continue;
      case 'UnaryExpression':
        if (current.operator === 'delete' || current.operator === 'throw') return false;
        stack.push(current.argument);
        continue;
      case 'BinaryExpression':
        // `in` and `instanceof` can throw, so folding them away is not safe.
        if (current.operator === 'in' || current.operator === 'instanceof') return false;
        stack.push(current.left, current.right);
        continue;
      case 'LogicalExpression':
        stack.push(current.left, current.right);
        continue;
      case 'ConditionalExpression':
        stack.push(current.test, current.consequent, current.alternate);
        continue;
      case 'SequenceExpression':
        stack.push(...current.expressions);
        continue;
      case 'ArrayExpression':
        if (current.elements.length > 0) return false;
        continue;
      case 'ObjectExpression':
        if (current.properties.length > 0) return false;
        continue;
      case 'TemplateLiteral':
        if (current.expressions.length > 0) return false;
        continue;
      default:
        return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Unreachable statements
// ---------------------------------------------------------------------------

/**
 * Everything after an unconditional `return` / `throw` / `break` / `continue` in
 * the same statement list is unreachable - but not invisible. The block did run
 * up to the terminator, so `var` names declared after it were already hoisted
 * and its function declarations were already bound and callable.
 */
function pruneUnreachable(
  path: NodePath<t.Program | t.BlockStatement | t.SwitchCase>,
  key: 'body' | 'consequent',
  keepCommented: boolean,
  ctx: PassContext,
): void {
  const statements = (path.node as unknown as Record<string, t.Statement[] | undefined>)[key];
  if (!statements) return;

  const terminator = statements.findIndex(isTerminator);
  if (terminator < 0 || terminator === statements.length - 1) return;

  let end = statements.length;
  if (keepCommented) {
    for (let i = terminator + 1; i < statements.length; i++) {
      if (hasLeadingComment(statements[i]!)) {
        end = i;
        break;
      }
    }
  }

  // Function declarations stay: they are reachable through hoisting even though
  // their position is not. So does a `let`, `const` or `class` written directly
  // in the list: it binds its name for the whole block, and a read above the
  // terminator is in its temporal dead zone - `let x = 1; function h() {
  // log(x); return; let x = 2; }` throws, and with the declaration deleted it
  // printed `1`. Only the rest of the range is genuinely removable.
  const removable = statements.slice(terminator + 1, end).filter((s) => !staysWhereItIs(s));
  if (removable.length === 0) return;

  // Decided before anything is removed: the decision reads the scopes as they
  // stand, and a removal edits them.
  const declarations = hoistedFrom(path, ...removable);
  if (!declarations) return;

  const statementPaths = path.get(key as never) as unknown as NodePath<t.Statement>[];
  for (let i = end - 1; i > terminator; i--) {
    if (staysWhereItIs(statements[i]!)) continue;
    statementPaths[i]!.remove();
  }

  if (declarations.length > 0) statementPaths[terminator]!.insertBefore(declarations);
  ctx.markChanged(removable.length);
}

/** A statement whose binding outlives its unreachable position; see `pruneUnreachable`. */
function staysWhereItIs(node: t.Statement): boolean {
  if (t.isFunctionDeclaration(node)) return node.id !== null;
  if (t.isClassDeclaration(node)) return true;
  return t.isVariableDeclaration(node) && node.kind !== 'var';
}

/**
 * A statement control never runs past. A bare block whose last statement is
 * one ends the same way: nothing after it in the list runs, whether or not
 * `finalize` later flattens the braces away - and it does, which is how
 * `{ ...; return x; } var a; var b;` reached the output and only a second
 * run pruned it.
 */
function isTerminator(node: t.Statement): boolean {
  switch (node.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;
    case 'BlockStatement': {
      const last = node.body[node.body.length - 1];
      return last !== undefined && isTerminator(last);
    }
    default:
      return false;
  }
}

function dropEmptyBlock(
  path: NodePath<t.BlockStatement>,
  keepCommented: boolean,
  ctx: PassContext,
): void {
  const node = path.node;
  if (node.body.length > 0 || node.directives.length > 0) return;
  // `inList` is what keeps the fixture's load-bearing empty `catch {}` alive: a
  // catch body, a loop body and an `if` branch are all single-slot children, not
  // members of a statement list.
  if (!path.inList) return;
  if (keepCommented && carriesComment(node)) return;
  path.remove();
  ctx.markChanged();
}

// ---------------------------------------------------------------------------
// Hoisting and replacement
// ---------------------------------------------------------------------------

/**
 * The `var` and function names a removed region contributed to its enclosing
 * function scope, as a single value-less declaration - or `undefined` when
 * that cannot be decided, which refuses the removal.
 *
 * A function declared inside a branch that never executed is only ever
 * `undefined` at runtime, so a bare `var` is the honest reconstruction of what
 * the enclosing scope could observe - where Annex B gives it a var at all.
 * Which block functions do is `hoistedVarNames`'s decision, shared with
 * `clean/injected-code.ts`: a strict function, a generator, or one blocked by a
 * same-named `let` or parameter never had one, and `var log;` written for it
 * made `return log('x')` throw where the input ran.
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

/**
 * Whether a kept block's contents can be spliced into the parent statement list.
 * Lexical declarations lose their block scope if they are, so those keep it.
 */
function canFlatten(kept: t.Statement): kept is t.BlockStatement {
  if (!t.isBlockStatement(kept) || kept.directives.length > 0) return false;
  return !kept.body.some(
    (statement) =>
      t.isFunctionDeclaration(statement) ||
      t.isClassDeclaration(statement) ||
      (t.isVariableDeclaration(statement) && statement.kind !== 'var'),
  );
}

/** True when deleting this subtree would silently delete a human's comment. */
function carriesComment(node: t.Statement): boolean {
  if (hasLeadingComment(node)) return true;
  if (Array.isArray(node.innerComments) && node.innerComments.length > 0) return true;
  return t.isBlockStatement(node) && node.body.some(hasLeadingComment);
}
