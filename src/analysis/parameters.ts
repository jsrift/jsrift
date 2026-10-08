import type { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { insideWith } from '../util/ast.js';
import { canInvokeUserCode } from '../util/purity.js';

/**
 * Parameters used as locals.
 *
 * A post-pass that runs on top of obfuscator.io - Cloudflare's managed
 * challenge is the one this was written against - hoists every `var` in a
 * function into that function's *parameter list* and assigns it with a comma
 * sequence at the top of the body:
 *
 * ```js
 * function h(c, d, map, dec, order, state) {
 *   dec = (map = { W: 283, c: 1896 }, cL);
 *   for (order = dec(map.W).split('|'), state = 0; !![];) { ... }
 * }
 * ```
 *
 * The 448 KB fixture this exists for has **fifteen** `VariableDeclarator`s in
 * the whole file and 2,193 assignments to parameters. Every recogniser in the
 * engine that establishes a binding's value - the alias-map inliner, the
 * decoder-alias index, the dispatcher analysis - asked for a
 * `VariableDeclarator` and therefore saw a file with nothing in it.
 *
 * A parameter is *not* a local, and the difference is the whole risk: it also
 * receives a value from the caller. `function f(i) { return i = i - 152, ... }`
 * is a real decoder in that same file, and treating `i` as though the caller's
 * value did not exist would decode every string at the wrong index. So the
 * equivalence has to be earned, and {@link parameterValue} refuses unless it is.
 *
 * ## What is proven
 *
 * `p = V` in function `F` makes `p` equivalent to `const p = V` for every read
 * in `F` when, and only when, no read can observe the value the caller passed.
 * The proof has four parts:
 *
 * 1. **One write.** `p` is assigned exactly once, by a plain `=` whose target is
 *    the bare identifier, in `F`'s own body rather than in a nested function.
 *    Anything else - `+=`, a destructuring target, `p++`, a second assignment -
 *    and there is no single value to speak of.
 * 2. **The write does not read.** `V` does not mention `p`. This is the gate
 *    `i = i - 152` fails, and it is not a technicality: that shape is the
 *    single most common thing a parameter assignment does in obfuscated code.
 * 3. **The write always runs, first.** The assignment sits on `F`'s
 *    *unconditional entry prefix*: the walk from the top of the body down to it
 *    passes only through evaluation steps that are guaranteed to happen, in
 *    order. Anything that could branch around it - an `if`, a loop body, the
 *    right operand of `&&`, a `try` block, a `return` above it - ends the
 *    proof. Code *is* allowed to run before it; see below for why that is safe.
 * 4. **Every read is after it.** Every reference to `p` follows the assignment
 *    in evaluation order. A reference inside a nested *function expression*
 *    qualifies when the expression itself follows the assignment, because a
 *    closure cannot be invoked before it is created. A reference inside a
 *    nested *function declaration* is not ordered by its position at all -
 *    those are hoisted - and is handled separately below.
 *
 * ## Why (3) does not have to forbid calls
 *
 * The obligation is that the caller's value is never *read*, and there are only
 * four ways to read a parameter. Naming it needs a reference, and (4) puts every
 * reference after the write - including one inside a closure, which cannot be
 * invoked before it exists. `arguments` aliases a simple parameter in sloppy
 * mode and a direct `eval` can name anything in scope, so a function using
 * either is refused outright rather than reasoned about. That leaves legacy
 * `Function.prototype.arguments` introspection, which is the closed-world
 * assumption the whole engine already makes - the same one that lets the
 * alias-map inliner trust an object literal and the evaluator trust
 * `String.prototype.split`.
 *
 * So an arbitrary call before the assignment is harmless: it has no way to
 * reach `p`. What it must not do is *skip* the assignment, which is what (3)
 * checks and why a preceding `return`, `if` or loop still ends the proof.
 *
 * ## The one place calls do matter
 *
 * A nested function *declaration* is hoisted, so one written below the
 * assignment can still be called from above it, and a reference inside it is
 * not ordered by its position. Two exits from that, and the analysis takes
 * whichever applies:
 *
 * - no reference is inside a hoisted declaration, in which case ordering by
 *   position is complete; or
 * - nothing evaluated before the assignment can invoke anything - no call, no
 *   `new`, no property read that might reach a getter, no `await` handing
 *   control to the microtask queue. A hoisted function that is never called
 *   cannot read anything.
 *
 * The second is what the 448 KB fixture's 232 decoder aliases need: they are
 * written `cL = Y` as the very first operand of the program's initialisation
 * sequence, with two hundred references spread across sibling function
 * declarations. Nothing whatsoever runs before that write.
 */

/** The single assignment that gives a parameter its value. */
export interface ParameterValue {
  /** The `p = V` expression. */
  path: NodePath<t.AssignmentExpression>;
  /** `V`, the value every read of the parameter sees. */
  init: t.Expression;
}

/** Depth cap on the climb to the owning function. Real bodies are far shallower. */
const MAX_CLIMB = 128;

/** What the climb from the assignment to the top of the body established. */
interface EntryPrefix {
  /** The assignment is reached, unconditionally, on every call. */
  reached: boolean;
  /** Nothing evaluated before it can invoke code, so no hoisted function ran. */
  quiet: boolean;
}

/**
 * The value a parameter holds for its whole body, when that is provable.
 *
 * Returns nothing - never a guess - whenever any part of the argument above
 * fails. See the module comment for what is being proven and why each gate is
 * load-bearing.
 */
export function parameterValue(binding: Binding): ParameterValue | undefined {
  return parameterFirstWrite(binding, []);
}

/**
 * The parameter's *first* value, where the caller has separately accounted for
 * the other writes.
 *
 * The dispatcher analysis needs exactly this and cannot use
 * {@link parameterValue}: its state counter is written twice, by `state = 0`
 * and by the `state++` in the switch discriminant, and it has already proven
 * that the second one is the only other write and the only read. What it still
 * needs proven is that `state = 0` happens first and that the caller's value is
 * never seen - which is everything below except the single-write rule.
 *
 * `alsoWritten` is not a licence to ignore writes: each one must itself be
 * proven to follow the initialising assignment, or the "first" in the name is
 * false.
 */
export function parameterFirstWrite(
  binding: Binding,
  alsoWritten: readonly t.Node[],
): ParameterValue | undefined {
  if (binding.kind !== 'param') return undefined;

  const declaration = binding.path;
  // A destructured or defaulted parameter is not a plain slot: `{a}` and
  // `a = 1` both put code between the caller's value and the binding.
  if (!declaration.isIdentifier() || declaration.listKey !== 'params') return undefined;

  const owner = declaration.parentPath;
  if (!owner?.isFunction()) return undefined;

  // (1) Exactly one write the caller has not vouched for, and it is a plain
  // assignment to the bare name.
  const others = binding.constantViolations.filter((v) => !alsoWritten.includes(v.node));
  if (others.length !== 1) return undefined;
  const write = others[0]!;
  if (!write.isAssignmentExpression() || write.node.operator !== '=') return undefined;
  if (!t.isIdentifier(write.node.left, { name: binding.identifier.name })) return undefined;
  if (write.getFunctionParent()?.node !== owner.node) return undefined;
  if (insideWith(write)) return undefined;

  // `arguments` aliases a simple parameter in sloppy mode, and a direct `eval`
  // can read any binding in scope. Either one reads `p` without a
  // reference Babel would have recorded, so the reference-order proof below
  // would be answering the wrong question.
  if (usesArgumentsOrEval(owner.node)) return undefined;

  // (2) `i = i - 152` reads the caller's value; there is nothing to prove there
  // because the claim is simply false.
  for (const reference of binding.referencePaths) {
    if (isWithin(reference, write.node)) return undefined;
  }

  // (3) The assignment is reached unconditionally on every call.
  const prefix = entryPrefix(write, owner);
  if (!prefix.reached) return undefined;

  // (4) Every read follows it, and so does every write the caller vouched for.
  for (const reference of binding.referencePaths) {
    if (insideWith(reference)) return undefined;
    if (insideHoistedFunction(reference, owner)) {
      // Position says nothing about a hoisted function; only the fact that
      // nothing before the write could have called it does.
      if (!prefix.quiet) return undefined;
      continue;
    }
    if (!follows(reference, write)) return undefined;
  }
  for (const violation of binding.constantViolations) {
    if (violation === write) continue;
    if (insideHoistedFunction(violation, owner)) {
      if (!prefix.quiet) return undefined;
      continue;
    }
    if (!follows(violation, write)) return undefined;
  }

  return { path: write, init: write.node.right };
}

/** Whether `path` lies inside the subtree rooted at `node`. */
function isWithin(path: NodePath, node: t.Node): boolean {
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    if (current.node === node) return true;
  }
  return false;
}

/**
 * A reference inside a function *declaration* nested in the owner.
 *
 * Declarations are hoisted to the top of the body, so one written after the
 * assignment can still be called from a statement before it. A function
 * *expression* has no such hole: it does not exist until its own evaluation, so
 * `follows` deciding that its position is after the assignment also decides
 * that every call to it is.
 */
function insideHoistedFunction(reference: NodePath, owner: NodePath): boolean {
  for (let current: NodePath | null = reference; current; current = current.parentPath) {
    if (current.node === owner.node) return false;
    if (current.isFunctionDeclaration()) return true;
  }
  return false;
}

/**
 * Climb from the assignment to the top of `owner`'s body, checking each link.
 *
 * Climbing rather than walking down: every link from a node to its parent is
 * matched against a whitelist of "this child is evaluated, always". A link not
 * on the list - an `if` branch, a loop body, the right operand of `&&`, a `try`
 * block, a nested function - ends the proof. Along the way the climb also
 * records whether anything evaluated *before* the assignment could invoke code,
 * which is what decides whether a hoisted function's references can be trusted.
 */
function entryPrefix(path: NodePath, owner: NodePath): EntryPrefix {
  const fail: EntryPrefix = { reached: false, quiet: false };
  let quiet = true;
  let current: NodePath = path;

  for (let depth = 0; depth < MAX_CLIMB; depth++) {
    const parent: NodePath | null = current.parentPath;
    if (!parent) return fail;

    // An expression-bodied arrow: the body is the whole function.
    if (parent.node === owner.node) {
      return current.key === 'body' ? { reached: true, quiet } : fail;
    }

    if (parent.isBlockStatement() && parent.parentPath?.node === owner.node) {
      // The function body. Every statement above this one has to complete
      // normally, so that control actually arrives here.
      if (current.listKey !== 'body' || typeof current.key !== 'number') return fail;
      const statements = parent.node.body;
      for (let index = 0; index < current.key; index++) {
        const statement = statements[index]!;
        if (!completesNormally(statement)) return fail;
        if (quiet && canInvokeUserCode(statement, owner.scope)) quiet = false;
      }
      return { reached: true, quiet };
    }

    const step = stepIsUnconditional(current, parent, owner.scope);
    if (!step.ok) return fail;
    if (!step.quiet) quiet = false;
    current = parent;
  }
  return fail;
}

interface Step {
  /** Reaching `parent` guarantees reaching `current`. */
  ok: boolean;
  /** Nothing evaluated between the two can invoke code. */
  quiet: boolean;
}

const BLOCKED: Step = { ok: false, quiet: false };
const CLEAR: Step = { ok: true, quiet: true };

function stepIsUnconditional(current: NodePath, parent: NodePath, scope: Scope): Step {
  const node = parent.node;

  if (t.isExpressionStatement(node)) {
    return current.node === node.expression ? CLEAR : BLOCKED;
  }
  // `return <here>` and `throw <here>` evaluate their operand as soon as the
  // statement is reached.
  if (t.isReturnStatement(node) || t.isThrowStatement(node)) {
    return current.node === node.argument ? CLEAR : BLOCKED;
  }
  if (t.isVariableDeclarator(node)) {
    return current.node === node.init ? CLEAR : BLOCKED;
  }

  // Earlier declarators and earlier comma operands always evaluate, in order.
  if (t.isVariableDeclaration(node)) {
    if (current.listKey !== 'declarations' || typeof current.key !== 'number') return BLOCKED;
    // Whole declarators, not just their initialisers: an earlier `var { x } = o`
    // runs a getter that is nowhere in `o`. That target check is part of the
    // shared oracle's `VariableDeclaration` arm, and a `VariableDeclarator` on
    // its own is not a node type the oracle answers for, so the earlier
    // declarators are wrapped back into a declaration to ask about them. The
    // wrapper is a throwaway: it is never attached to the tree and the
    // declarators are not modified.
    return {
      ok: true,
      quiet: !canInvokeUserCode(
        t.variableDeclaration(node.kind, node.declarations.slice(0, current.key)),
        scope,
      ),
    };
  }
  if (t.isSequenceExpression(node)) {
    if (current.listKey !== 'expressions' || typeof current.key !== 'number') return BLOCKED;
    return { ok: true, quiet: allQuiet(node.expressions.slice(0, current.key), scope) };
  }

  // `a = <here>`: the target is resolved first, and only a bare identifier
  // target resolves without evaluating anything.
  if (t.isAssignmentExpression(node)) {
    const ok = node.operator === '=' && current.node === node.right && t.isIdentifier(node.left);
    return ok ? CLEAR : BLOCKED;
  }

  // `for (<here>; ...; ...)` runs exactly once, before anything else in the loop.
  if (t.isForStatement(node)) {
    return current.node === node.init ? CLEAR : BLOCKED;
  }

  // Operands that are always evaluated first, with nothing before them.
  if (t.isLogicalExpression(node) || t.isBinaryExpression(node)) {
    return current.node === node.left ? CLEAR : BLOCKED;
  }
  if (t.isConditionalExpression(node)) {
    return current.node === node.test ? CLEAR : BLOCKED;
  }

  return BLOCKED;
}

function allQuiet(nodes: readonly (t.Node | null | undefined)[], scope: Scope): boolean {
  return nodes.every((node) => !node || !canInvokeUserCode(node, scope));
}

/**
 * Whether this statement is guaranteed to hand control to the next one.
 *
 * Only the two forms that always fall through, plus the two that do not execute
 * in statement order at all. Everything else - `if`, `return`, a loop, a `try`,
 * a labelled block - either can skip what follows or needs an analysis this
 * does not do, and ends the proof.
 */
function completesNormally(node: t.Statement): boolean {
  return (
    t.isExpressionStatement(node) ||
    t.isVariableDeclaration(node) ||
    // Hoisted: nothing of it runs in statement order.
    t.isFunctionDeclaration(node) ||
    t.isEmptyStatement(node)
  );
}

/**
 * Whether `later` is evaluated after `earlier`.
 *
 * Both are inside the same function, so the comparison is positional: climb to
 * the node where their ancestries diverge and rank the two branches by the
 * order Babel's visitor keys put them in, which for every node type is the
 * order the operands are evaluated in (`init`, `test`, `update`, `body` for a
 * `for`; `left` then `right`; `callee` then `arguments`).
 */
function follows(later: NodePath, earlier: NodePath): boolean {
  const laterChain = ancestry(later);
  const earlierChain = ancestry(earlier);
  if (laterChain.length === 0 || earlierChain.length === 0) return false;
  if (laterChain[0] !== earlierChain[0]) return false;

  let index = 1;
  while (
    index < laterChain.length &&
    index < earlierChain.length &&
    laterChain[index] === earlierChain[index]
  ) {
    index++;
  }
  // One contains the other; "after" is not a meaningful answer.
  if (index >= laterChain.length || index >= earlierChain.length) return false;

  const a = laterChain[index]!;
  const b = earlierChain[index]!;
  const parent = laterChain[index - 1]!;
  const rankA = rankOf(parent, a);
  const rankB = rankOf(parent, b);
  if (rankA === undefined || rankB === undefined) return false;
  if (rankA[0] !== rankB[0]) return rankA[0] > rankB[0];
  return rankA[1] > rankB[1];
}

function ancestry(path: NodePath): NodePath[] {
  const chain: NodePath[] = [];
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    chain.push(current);
    if (chain.length > MAX_CLIMB) return [];
  }
  return chain.reverse();
}

/** `[visitor-key index, list index]` of a child within its parent. */
function rankOf(parent: NodePath, child: NodePath): [number, number] | undefined {
  const keys = t.VISITOR_KEYS[parent.node.type];
  if (!keys) return undefined;
  const key = child.listKey ?? child.key;
  if (typeof key !== 'string') return undefined;
  const position = keys.indexOf(key);
  if (position < 0) return undefined;
  return [position, typeof child.key === 'number' ? child.key : 0];
}

/**
 * Whether the function reads its parameters other than by name.
 *
 * `arguments` aliases simple parameters in sloppy mode, so `arguments[0]` reads
 * the caller's value even after `p = V` - and writes through it. A direct
 * `eval` can name any binding in scope at a point the reference walk knows
 * nothing about. The scan stops at a nested non-arrow function, which has its
 * own `arguments`, but not at an arrow, which does not.
 *
 * Exported because every proof that reads a parameter's value off
 * `binding.referencePaths` needs it, not only the one below: neither of those
 * two spellings produces a reference, so a reference list gathered inside such
 * a function is not an enumeration of the reads.
 */
export function usesArgumentsOrEval(fn: t.Function): boolean {
  let found = false;
  const visit = (node: t.Node, isRoot: boolean): void => {
    if (found) return;
    if (!isRoot && (t.isFunctionExpression(node) || t.isFunctionDeclaration(node))) {
      // A nested `function` rebinds `arguments`, but a direct `eval` inside it
      // still sees this scope through the chain, so keep looking for that.
      scanForEval(node, () => {
        found = true;
      });
      return;
    }
    if (t.isIdentifier(node, { name: 'arguments' })) {
      found = true;
      return;
    }
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'eval' })) {
      found = true;
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) visit(item, false);
      } else if (isNode(child)) {
        visit(child, false);
      }
    }
  };
  visit(fn, true);
  return found;
}

function scanForEval(root: t.Node, report: () => void): void {
  const stack: t.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'eval' })) {
      report();
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) stack.push(item);
      } else if (isNode(child)) {
        stack.push(child);
      }
    }
  }
}

function isNode(value: unknown): value is t.Node {
  return typeof value === 'object' && value !== null && typeof (value as t.Node).type === 'string';
}
