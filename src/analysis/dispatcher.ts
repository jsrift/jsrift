import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  insideWith,
  isPureContext,
  isUnboundUndefined,
  shadowedByBlockFunction,
  staticNumber,
  staticString,
  type BlockFunctionMemo,
} from '../util/ast.js';
import { isSideEffectFree } from '../util/purity.js';
import { eachNode } from './evaluator/native.js';
import { parameterFirstWrite, usesArgumentsOrEval } from './parameters.js';
import type { StringCodeFacts } from './string-code.js';

/**
 * Recognition of the `switch` dispatcher state machine that
 * `controlFlowFlattening` emits:
 *
 * ```js
 * var order = '3|0|4|1|2'.split('|'), state = 0;
 * while (true) {
 *   switch (order[state++]) {
 *     case '0': ...; continue;
 *     ...
 *   }
 *   break;
 * }
 * ```
 *
 * The order array is the real execution order of the blocks, so recovery is a
 * concatenation of the case bodies in that order. Getting the order wrong
 * produces a program that still parses and usually still runs while computing
 * something different, so every rule here is written to refuse rather than
 * approximate: this module answers "is this provably that shape", not "does
 * this look a bit like it".
 */

/** A `switch` case label. Strings in real output; numbers are allowed for symmetry. */
export type StateKey = string | number;

type LoopPath = NodePath<t.WhileStatement | t.ForStatement>;

/**
 * Where one of the dispatcher's two bindings gets the value the analysis read.
 *
 * `var order = '...'.split('|')` is the classic spelling. Two more are provable
 * and both occur in real output: the same declarator sitting in the loop's own
 * `for` head, and -- where a post-pass has hoisted every local into the parameter
 * list -- a plain assignment to a parameter. What they have in common is the only
 * thing that matters: exactly one write, whose value is in place before the first
 * dispatch reads it.
 */
interface ValueSite {
  /** The node that must be the binding's only write, besides `state++`. */
  write: t.Node;
  /** The value expression itself. Always `initPath.node`. */
  init: t.Expression;
  /**
   * `init`'s own path.
   *
   * Carried rather than reconstructed from the loop, because both questions
   * asked of `init` -- what it evaluates to, and whether deleting it can be
   * observed -- resolve names, and only the value's own position answers those.
   * The loop is the right anchor for two of the three spellings and the wrong
   * one for the third: `parameterFirstWrite` proves a write that lives in the
   * function body, which can sit in a nested block with its own bindings, so a
   * lookup anchored at the loop would be asking about a different scope.
   */
  initPath: NodePath<t.Expression>;
  /** Set when the write is a declaration that outlives the loop. */
  declarator?: NodePath<t.VariableDeclarator>;
  /** True when the write lives in this loop's `for` head and dies with it. */
  inHead: boolean;
}

export interface DispatcherCase {
  key: StateKey;
  /** Case body with the trailing dispatcher `continue` already stripped. */
  body: t.Statement[];
}

export interface Dispatcher {
  loop: LoopPath;
  /** Binding name of the order array, e.g. `_0x44f37d`. */
  orderName: string;
  /** Binding name of the state counter, e.g. `_0x48e990`. */
  stateName: string;
  /** Case labels in execution order, read from the order array. */
  order: StateKey[];
  /** Case bodies, keyed by {@link keyId}. */
  cases: Map<string, DispatcherCase>;
  /**
   * Declarators to delete once the loop is gone. Only ones that outlive the
   * loop appear: a declarator in the `for` head is removed with the head.
   */
  retire: NodePath<t.VariableDeclarator>[];
  /**
   * The `for` head rewritten as statements, to run before the linearised body.
   * Empty for a `while` loop and for a head that held nothing but the
   * dispatcher's own bookkeeping.
   */
  prelude: t.Statement[];
}

export interface DispatcherOptions {
  /** Refuse a dispatcher with more states than this. */
  maxStates: number;
  /** Allow the order array to be reached through constant bindings. */
  aggressive: boolean;
  /**
   * What string code in this program can address by name, from
   * `analysis/string-code.ts`.
   *
   * Not a configuration knob: every proof in this file is a statement about a
   * binding's `referencePaths` and `constantViolations`, and a direct `eval`
   * reads and writes by NAME without appearing in either list. Absent, the
   * answer is the conservative one - assume string code reaches everything, and
   * refuse - because a caller that cannot say has not established anything, and
   * the failure of the other default is a rewrite that runs and computes
   * something else. See {@link addressableByStringCode}.
   */
  stringCode?: StringCodeFacts;
  /**
   * Whole-program answers every candidate of one run of the pass shares.
   * Created by the caller per run, so a memo lives exactly as long as the tree
   * it describes; absent, each candidate computes them afresh.
   */
  round?: DispatcherRound;
}

/**
 * What `analyzeDispatcher` learns about the program as a whole, kept for the
 * next candidate of the same run and no longer.
 *
 * Not longer, because the tree the answers describe is the tree of ONE
 * fixpoint round. The memo used to be a module-level map keyed on the program
 * node, on the claim that a later pass can only delete a `split` replacement
 * and never introduce one - and proxy inlining introduces one: the key in
 * `String.prototype[k()] = ...` becomes the literal `split` on a later round,
 * after the dispatchers that read it had been judged against a remembered
 * `false`. Measured: the input printed `C B A` and the output `A B C`, with
 * `verified: true`. Within one run only deletions happen, and a stale `true`
 * is the conservative answer, so a run is the right lifetime.
 */
export class DispatcherRound {
  /** Whether the program installs its own `split`; unset until first asked. */
  splitReplaced?: boolean;
}

export type DispatcherResult =
  /** Provably a dispatcher, and safe to linearise. */
  | { kind: 'dispatcher'; value: Dispatcher }
  /** Not this shape at all. Silent - most `while (true)` loops land here. */
  | { kind: 'reject'; reason: string }
  /** This shape, but the rewrite is not provably equivalent. Worth a diagnostic. */
  | { kind: 'bail'; reason: string };

/** How far to follow constant bindings when resolving the order array. */
const MAX_RESOLVE_DEPTH = 4;

/**
 * Cheap structural pre-filter, safe to run on every loop in the program.
 * A `true` here means "worth doing scope analysis on", not "is a dispatcher".
 */
export function looksLikeDispatcher(node: t.WhileStatement | t.ForStatement): boolean {
  if (!isUnconditionalLoop(node, 'unverified')) return false;
  const body = node.body;
  if (!t.isBlockStatement(body) || body.body.length !== 2) return false;
  return t.isSwitchStatement(body.body[0]);
}

export function analyzeDispatcher(
  loop: NodePath<t.WhileStatement | t.ForStatement>,
  options: DispatcherOptions,
): DispatcherResult {
  const shape = readShape(loop);
  if (shape.kind !== 'ok') return shape;
  const { switchNode, orderName, stateName, update, orderRef } = shape;

  // A label on the loop means `continue outer` / `break outer` elsewhere can
  // target it, and the linearised form has nothing left to target.
  if (loop.parentPath.isLabeledStatement()) {
    return bail('the dispatcher loop carries a label');
  }
  // Inside `with (o) { ... }` both dispatcher names are looked up on `o` first, at
  // run time, so `loop.scope.getBinding` below answers about a binding the
  // program may never consult and every proof built on it describes the wrong
  // storage. The refusal is the whole construct rather than an arm of it,
  // because unlike a purity walk - where `1` is still a literal inside a `with`
  // - there is no part of this proof that is not about those two names: which
  // node writes the counter, that nothing else reads the array, and what the
  // array holds.
  //
  // Not hypothetical. `with (o) { var order = '1|0'.split('|'), state = 0; ... }`
  // called with an `o` carrying an `order` accessor printed `a | b` before and
  // `b | a` after, at the default preset - the recovered order reversed, from
  // code that parses and runs.
  if (insideWith(loop)) {
    return bail('the dispatcher is inside a `with`, where both its names resolve on the object');
  }
  // Linearising hoists the `for` head ahead of the block bodies, which for a
  // `let` or `const` head would move a loop-scoped binding into the enclosing
  // scope - a different name resolution for every later use of that name.
  const head = loopInit(loop)?.node;
  if (t.isVariableDeclaration(head) && head.kind !== 'var') {
    return bail(`the dispatcher's for head declares a ${head.kind}, which is scoped to the loop`);
  }
  if (orderName === stateName) {
    return bail('the order array and the state counter are the same binding');
  }

  const stateBinding = loop.scope.getBinding(stateName);
  const orderBinding = loop.scope.getBinding(orderName);
  if (!stateBinding || !orderBinding) {
    return bail('the order array or state counter is not a resolvable local binding');
  }
  // Every proof below is a statement about these two bindings' reference and
  // violation lists: that the counter is written only by `state++`, that the
  // array is written once, that neither is read anywhere but the dispatch. A
  // direct `eval` reads and writes by NAME and appears in neither list, so under
  // one those lists describe a program that is not the one running.
  //
  // Not hypothetical, and not confined to the aggressive arms: at the default
  // preset, `var order = ['1','0'], state = 0; eval('order = ["0","1"]');` above
  // the loop printed `a | b` before and `b | a` after, with the declaration
  // deleted and the `eval` left behind writing a global nothing reads.
  //
  // The `param` spelling was already covered from the other end -
  // `parameterFirstWrite` and the `for`-head shortcut both refuse a function
  // whose body contains a direct `eval` call, through `usesArgumentsOrEval` -
  // and this is the same refusal for the `var` spelling, asked of the shared
  // fact rather than of a syntactic scan, which is what also brings the
  // global-scope forms (`Function(src)`, indirect `eval`) inside it.
  const addressed = stringCodeRefusal(options, stateBinding, orderBinding);
  if (addressed) return bail(addressed);

  const stateSite = valueSiteOf(stateBinding, loop, 'state counter', [update]);
  if ('reason' in stateSite) return bail(stateSite.reason);
  if (staticNumber(stateSite.init) !== 0) {
    return bail('the state counter does not start at 0');
  }
  // The whole recovery rests on the counter advancing by exactly one per
  // iteration and on nothing else steering it.
  if (!isOnlyWriteOf(stateBinding, stateSite.write, update)) {
    return bail('the state counter is written outside the dispatcher increment');
  }
  if (stateBinding.referencePaths.some((ref) => ref.node !== update.argument)) {
    return bail('the state counter is read outside the dispatcher increment');
  }

  const orderSite = valueSiteOf(orderBinding, loop, 'order array');
  if ('reason' in orderSite) return bail(orderSite.reason);
  if (!isOnlyWriteOf(orderBinding, orderSite.write)) {
    return bail('the order array is reassigned');
  }
  if (
    orderBinding.referencePaths.length !== 1 ||
    orderBinding.referencePaths[0]?.node !== orderRef
  ) {
    return bail('the order array is used outside the dispatcher');
  }

  // The one thing the closed-world assumption about `split` costs, and the only
  // guard that could ever have reached it. `resolveOrderEntries` computes the
  // order by running THIS process's `split` on the literal that spells it, so a
  // program that replaced `String.prototype.split` gets an order this engine
  // computed and the program never had - recovered as straight-line code that
  // reads correct and runs its cases in a different sequence, with `verified:
  // true` and no diagnostic. Refusing the shape would refuse every dispatcher
  // the obfuscator emits; refusing it only when the file actually replaces the
  // intrinsic costs nothing on a file that does not, which is all of them
  // except the ones written to poison this.
  if (usesSplit(orderSite.init) && replacesSplit(orderSite.initPath, options.round)) {
    return bail('the program replaces `split`, so the order array it spells cannot be read');
  }

  const order = resolveOrderEntries(orderSite.init, orderSite.initPath, options, 0);
  if (!order) return bail('the order array is not statically resolvable');
  if (order.length === 0) return bail('the order array is empty');
  if (order.length > options.maxStates || switchNode.cases.length > options.maxStates) {
    return bail(`the dispatcher exceeds maxStates (${options.maxStates})`);
  }

  const seen = new Set<string>();
  for (const key of order) {
    const id = keyId(key);
    // Emitting a body twice would duplicate its declarations and its cost, and
    // the two visits can have different continuations.
    if (seen.has(id)) return bail(`state ${id} is entered more than once`);
    seen.add(id);
  }

  const cases = readCases(switchNode, orderName, stateName);
  if ('reason' in cases) return bail(cases.reason);

  for (const key of order) {
    if (!cases.value.has(keyId(key)))
      return bail(`the order array names a missing state ${keyId(key)}`);
  }
  for (const id of cases.value.keys()) {
    // An unreferenced case is unreachable, but dropping it would silently move
    // any declaration it hoists, so refuse rather than guess.
    if (!seen.has(id)) return bail(`state ${id} is never entered`);
  }

  // Both bindings are proven to be read only by the dispatcher, so once the
  // loop is gone nothing can observe the WRITES -- but *building* the order
  // array is a separate observable act, and that is the shared oracle's
  // question, asked at the only strength a removal may use.
  //
  // `assumeNativeBuiltins` is what lets the oracle accept `'3|0|4'.split('|')`,
  // and this caller is entitled to it because it has ALREADY spent that exact
  // assumption on that exact call: `resolveOrderEntries` computed the order a
  // few lines above by running THIS process's `split` on the literals that spell it,
  // the whole rewrite -- which case body goes where -- rests on the result. A
  // pass that trusts a builtin enough to reorder a function around what it
  // returns, and then refuses to delete the call because that same builtin might
  // have been replaced, is holding two positions about one expression. Switching
  // the option off would not make anything here sound; it would only make the
  // refusal disagree with the recovery it is part of.
  //
  // The cost of the assumption is real and is one thing, not two. Under a
  // `String.prototype.split` that returns a DIFFERENT array the recovered order
  // is wrong -- the residual `dispatcher-order-array-hazards.test.ts` pins, and
  // it belongs to the read, not to this decision. Under one that logs and then
  // delegates, the order is right and deleting the call drops the log. Both are
  // the same program: one that replaced an intrinsic. Refusing here bought the
  // second case only, at the price of the incoherence, and could not buy the
  // first at any price.
  //
  // The oracle is also WIDER here than the private predicate this replaced,
  // which had no arm for a name and none for a unary: an order array reached
  // through a constant binding under `aggressiveDispatchers`, and one holding an
  // element written `-0` or `+1`, are now retired where they were kept. Every
  // direction of this changes what is DELETED, never what is linearised.
  const orderIsInert = isSideEffectFree(orderSite.init, orderSite.initPath.scope, {
    path: orderSite.initPath,
    assumeNativeBuiltins: true,
  });
  const retired = new Set<t.Node>([stateSite.write]);
  if (orderIsInert) retired.add(orderSite.write);

  const retire: NodePath<t.VariableDeclarator>[] = [];
  if (!stateSite.inHead && stateSite.declarator) retire.push(stateSite.declarator);
  if (orderIsInert && !orderSite.inHead && orderSite.declarator) retire.push(orderSite.declarator);

  return {
    kind: 'dispatcher',
    value: {
      loop,
      orderName,
      stateName,
      order,
      cases: cases.value,
      retire,
      prelude: preludeOf(loop, retired),
    },
  };
}

/**
 * Prove where a dispatcher binding's value comes from, in each spelling that
 * admits a proof.
 *
 * The caller separately proves that this binding is read *only* by the
 * dispatcher and written *only* here (plus `state++`). What is left for this
 * function is the other half: that the write has already happened by the time
 * the first dispatch reads it.
 */
function valueSiteOf(
  binding: Binding,
  loop: LoopPath,
  role: string,
  accountedFor: readonly t.Node[] = [],
): ValueSite | { reason: string } {
  const path = binding.path;

  if (path.isVariableDeclarator()) {
    // `isExpression()` is both halves of the check: a declarator with no
    // initialiser binds `undefined`, and the narrowing is what lets the path be
    // handed on as the value's own.
    const initPath = path.get('init');
    if (!initPath.isExpression()) {
      return { reason: `the ${role} is not declared by an initialised variable declarator` };
    }
    const init = initPath.node;
    if (isInLoopHead(path, loop)) {
      // `let`/`const` in a `for` head are scoped to the loop and re-bound per
      // iteration; hoisting such a declaration out changes what the name means
      // everywhere else in the function.
      if (binding.kind !== 'var') {
        return { reason: `the ${role} is a ${binding.kind} declared in the dispatcher's own for head` };
      }
      // The head runs once, immediately before the first dispatch, so there is
      // nothing left to prove about ordering.
      return { write: path.node, init, initPath, declarator: path, inHead: true };
    }
    if (binding.kind !== 'var' && binding.kind !== 'let') {
      return { reason: `the ${role} is a ${binding.kind} binding` };
    }
    // `var` hoists, so a declaration textually after the loop would leave the
    // binding `undefined` when the loop first reads it.
    if (!declarationPrecedes(path, loop)) {
      return { reason: `the ${role} is declared after the dispatcher` };
    }
    return { write: path.node, init, initPath, declarator: path, inHead: false };
  }

  // A parameter used as a local. Two proofs are available and the local one is
  // tried first because it is both cheaper and stronger: an assignment in this
  // loop's own `for` head runs once, immediately before the first dispatch, and
  // the caller has already proven that the only read of this binding is inside
  // the loop -- so whatever the caller passed cannot be observed. Failing that,
  // `parameterValue` proves the general case from the top of the function.
  //
  // "The only read is inside the loop" is a statement about
  // `binding.referencePaths`, and there are two ways to read a parameter that
  // put nothing in that list: in sloppy mode `arguments[i]` aliases a simple
  // parameter, and a direct `eval` can name any binding in scope. Under either
  // one the caller's proof is answering the wrong question -- and retiring the
  // head assignment would then change what `arguments[i]` yields -- so the
  // shortcut is refused for exactly the functions `parameterFirstWrite` refuses
  // below, and for the same reason.
  if (binding.kind === 'param') {
    const head = headAssignmentTo(binding, loop);
    const owner = binding.scope.path;
    if (head && owner.isFunction() && !usesArgumentsOrEval(owner.node)) {
      return { write: head.node, init: head.node.right, initPath: head.get('right'), inHead: true };
    }
    // The state counter is written twice -- `state = 0` and the `state++` in
    // the discriminant -- and the caller proves the second one is the only
    // other write and the only read, so it is handed over as accounted for.
    const general = parameterFirstWrite(binding, accountedFor);
    if (general) {
      return {
        write: general.path.node,
        init: general.init,
        initPath: general.path.get('right'),
        inHead: false,
      };
    }
    return { reason: `the ${role} is a parameter whose value is not provably set before the loop` };
  }

  return { reason: `the ${role} is not declared by a variable declarator` };
}

/**
 * The single `name = value` in this loop's own `for` head, when that is where
 * the binding is set.
 *
 * Only assignments in the head count. One anywhere else needs the general
 * argument in `analysis/parameters.ts`, which proves that nothing runs before
 * it and that every read follows it; here neither has to be proven, because the
 * head is the last thing evaluated before the first dispatch and the caller has
 * shown the dispatcher is the only reader -- provided the reference list that
 * claim rests on is complete, which the `usesArgumentsOrEval` gate at the call
 * site is what establishes. That gate is coarse in the direction of refusing:
 * a strict-mode function, where `arguments` does not alias, and one that only
 * reads `arguments.length` are both provable and both declined. It is the same
 * trade `parameterFirstWrite` already makes, and it costs nothing on any of the
 * five fixtures.
 */
function headAssignmentTo(
  binding: Binding,
  loop: LoopPath,
): NodePath<t.AssignmentExpression> | undefined {
  let found: NodePath<t.AssignmentExpression> | undefined;
  for (const violation of binding.constantViolations) {
    if (!violation.isAssignmentExpression()) continue;
    if (violation.node.operator !== '=') continue;
    if (!t.isIdentifier(violation.node.left, { name: binding.identifier.name })) continue;
    if (!isInLoopHead(violation, loop)) continue;
    // Two writes in one head is not a single value.
    if (found) return undefined;
    found = violation;
  }
  return found;
}

/**
 * Whether the only writes Babel records for `binding` are the expected ones.
 *
 * A `var` declared inside a nested block is registered by both the block scope
 * and the function scope, so its own declarator shows up as a "violation" even
 * though nothing writes it twice. A genuine redeclaration is a *different*
 * declarator node and is still caught.
 */
function isOnlyWriteOf(binding: Binding, ...expected: readonly t.Node[]): boolean {
  return binding.constantViolations.every((violation) => expected.includes(violation.node));
}

/** Stable map key that keeps `'0'` and `0` distinct, as `switch` does. */
export function keyId(key: StateKey): string {
  return typeof key === 'string' ? `s:${key}` : `n:${key}`;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

interface Shape {
  kind: 'ok';
  switchNode: t.SwitchStatement;
  orderName: string;
  stateName: string;
  /** The `state++` node, used to prove it is the only write. */
  update: t.UpdateExpression;
  /** The `order` identifier node, used to prove it is the only read. */
  orderRef: t.Identifier;
}

function readShape(
  loop: NodePath<t.WhileStatement | t.ForStatement>,
): Shape | { kind: 'reject'; reason: string } {
  // The load-bearing ask: unlike `looksLikeDispatcher` this one licenses the
  // rewrite, so it resolves names against the loop's real position.
  if (!isUnconditionalLoop(loop.node, loop)) return reject('the loop is conditional');
  const body = loop.node.body;
  if (!t.isBlockStatement(body) || body.directives.length > 0) {
    return reject('the loop body is not a plain block');
  }
  if (body.body.length !== 2) return reject('the loop body is not exactly a switch and a break');
  const [head, tail] = body.body;
  if (!t.isSwitchStatement(head)) return reject('the loop body does not open with a switch');
  // The trailing break is the only exit; without it the shape is a different
  // machine and the case bodies do not mean what this analysis assumes.
  if (!t.isBreakStatement(tail) || tail.label) {
    return reject('the loop body does not close with an unlabelled break');
  }

  const discriminant = head.discriminant;
  if (!t.isMemberExpression(discriminant) || !discriminant.computed) {
    return reject('the switch discriminant is not a computed member expression');
  }
  if (!t.isIdentifier(discriminant.object))
    return reject('the discriminant object is not an identifier');
  const property = discriminant.property;
  if (!t.isUpdateExpression(property) || property.operator !== '++' || property.prefix) {
    return reject('the discriminant index is not a postfix increment');
  }
  if (!t.isIdentifier(property.argument))
    return reject('the discriminant index is not an identifier');

  return {
    kind: 'ok',
    switchNode: head,
    orderName: discriminant.object.name,
    stateName: property.argument.name,
    update: property,
    orderRef: discriminant.object,
  };
}

/**
 * Whether the loop runs until something inside it jumps out.
 *
 * A `for` head is *not* required to be empty, and the asymmetry with
 * `structure.register-vm` - which refuses `init` and `update` outright - is
 * deliberate rather than an oversight. That pass traces a machine whose switch
 * key is an arithmetic sum over a register file, so an `init` seeds registers
 * the trace has no way to apply and an `update` mutates them between every
 * block: reading only `test` there would trace a machine that starts in a state
 * it is never in. Here nothing is simulated. The order array *names* the block
 * sequence, the counter is proven to be written only by `state++` and read only
 * there, and an `init` is simply code that runs once before the first dispatch -
 * which the linearised form reproduces exactly by hoisting it ahead of the
 * concatenated bodies (see `preludeOf`).
 *
 * `update` stays refused for the same reason it is refused there: it runs after
 * every block, and straight-line code has nowhere to put it.
 *
 * This is not a hypothetical shape. Cloudflare's post-pass writes every one of
 * the 43 dispatchers in the managed-challenge fixture as
 * `for (order = '...'.split('|'), state = 0; !![];)`, so an empty-head rule would
 * exclude all of them without ever looking.
 */
function isUnconditionalLoop(
  node: t.WhileStatement | t.ForStatement,
  evidence: NameEvidence,
): boolean {
  if (t.isForStatement(node)) {
    if (node.update) return false;
    return !node.test || isAlwaysTruthy(node.test, evidence);
  }
  return isAlwaysTruthy(node.test, evidence);
}

/** The `for` head's initialiser, when this loop is a `for` that has one. */
function loopInit(
  loop: LoopPath,
): NodePath<t.VariableDeclaration | t.Expression> | undefined {
  if (!loop.isForStatement()) return undefined;
  const init = loop.get('init');
  return init.node ? (init as NodePath<t.VariableDeclaration | t.Expression>) : undefined;
}

/** Whether `path` sits inside `loop`'s own `for` head rather than its body. */
function isInLoopHead(path: NodePath, loop: LoopPath): boolean {
  const head = loopInit(loop);
  if (!head) return false;
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    if (current.node === head.node) return true;
    if (current.node === loop.node) return false;
  }
  return false;
}

/** Top-level operands of a comma expression, in evaluation order. */
function sequenceParts(node: t.Expression): t.Expression[] {
  return t.isSequenceExpression(node) ? node.expressions.flatMap(sequenceParts) : [node];
}

/**
 * The `for` head, rewritten as statements to run before the linearised body.
 *
 * Everything the head did still has to happen, once, in the same order - except
 * the writes the dispatcher itself owned, which `retired` names and which have
 * just been proven unobservable now that the loop reading them is gone.
 */
function preludeOf(loop: LoopPath, retired: ReadonlySet<t.Node>): t.Statement[] {
  const head = loopInit(loop)?.node;
  if (!head) return [];

  if (t.isVariableDeclaration(head)) {
    const kept = head.declarations.filter((declarator) => !retired.has(declarator));
    return kept.length === 0 ? [] : [t.variableDeclaration(head.kind, kept)];
  }

  const kept = sequenceParts(head).filter((part) => !retired.has(part));
  if (kept.length === 0) return [];
  return [t.expressionStatement(kept.length === 1 ? kept[0]! : t.sequenceExpression(kept))];
}

/**
 * What is available for resolving a free name in a loop test.
 *
 * Only one of the two entry points has any. `analyzeDispatcher` reaches these
 * predicates through `readShape`, which holds the loop's `NodePath`.
 * `looksLikeDispatcher` is handed a bare node by `structure/control-flow.ts` -
 * once per loop during candidate collection, once more from its whole-file
 * `containsDispatcherShape` scan - and has no path to give, so it passes
 * `'unverified'`, which means "assume the name resolves the ordinary way".
 *
 * That assumption is safe in the pre-filter and *only* there, because of what
 * the pre-filter's answer buys: a `true` buys the loop a full
 * `analyzeDispatcher`, which re-asks this question against the real path and
 * rejects if the name is not what it looked like; a `true` never authorises a
 * rewrite by itself. Refusing instead when
 * nothing is available would be the worse error, because an evidence-free
 * refusal is indistinguishable from a proven one and would drop dispatchers
 * that are provable a moment later.
 */
type NameEvidence = NodePath | 'unverified';

function isAlwaysTruthy(node: t.Expression, evidence: NameEvidence): boolean {
  switch (node.type) {
    case 'BooleanLiteral':
      return node.value;
    case 'NumericLiteral':
      return node.value !== 0;
    case 'StringLiteral':
      return node.value.length > 0;
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;
    case 'UnaryExpression':
      return node.operator === '!' && isAlwaysFalsy(node.argument, evidence);
    default:
      return false;
  }
}

function isAlwaysFalsy(node: t.Expression, evidence: NameEvidence): boolean {
  switch (node.type) {
    case 'BooleanLiteral':
      return !node.value;
    case 'NumericLiteral':
      return node.value === 0;
    case 'StringLiteral':
      return node.value.length === 0;
    case 'NullLiteral':
      return true;
    case 'Identifier':
      // `undefined` is a bindable name, not a keyword, so `while (!undefined)`
      // is an unconditional loop only where nothing has bound it. Under
      // `function f(undefined)` or `let undefined = 1` the same source is a
      // loop that never runs, and linearising it emits every case body of a
      // machine the program never entered - which is what a repro showed:
      // a silent program started printing its whole dispatch order.
      //
      // `insideWith` is the second half of the same question and is only
      // reached once the first half has said yes, which is to say only when the
      // node is literally a free `undefined`. `with ({undefined: 1}) { ... }`
      // rebinds the name with no binding anywhere for a scope to report.
      if (evidence === 'unverified') return node.name === 'undefined';
      return isUnboundUndefined(node, evidence.scope) && !insideWith(evidence);
    case 'UnaryExpression':
      if (node.operator === '!') return isAlwaysTruthy(node.argument, evidence);
      return node.operator === 'void' && t.isLiteral(node.argument);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The order array
// ---------------------------------------------------------------------------

/** Whether reading this initialiser goes through a `.split(...)` call at all. */
function usesSplit(node: t.Node): boolean {
  let found = false;
  eachNode(node, (current) => {
    if (found || !t.isCallExpression(current)) return;
    const callee = current.callee;
    if (t.isMemberExpression(callee) && isNamedMember(callee, 'split')) found = true;
  });
  return found;
}

/**
 * Whether this program installs its own `split`.
 *
 * Four shapes: an assignment to any member named `split`, an assignment to
 * `String.prototype` wholesale, an assignment to a member of `String.prototype`
 * whose key is COMPUTED and unreadable, and a `defineProperty`/`defineProperties`
 * whose key is the readable string `split`. The receiver is not proved for the
 * first - `x.split = f` on an unrelated object refuses a dispatcher it did not
 * have to, which costs one file its recovery, while a missed replacement is
 * wrong output on every dispatcher in the file.
 *
 * The third is the poisoned spelling of the first: `String.prototype[_0xk()] =
 * f` where `_0xk` reads a table this analysis cannot, so the key never becomes
 * a literal on any round and the first shape never matches. Recovered anyway,
 * the dispatcher printed `A B C` for a program that prints `C B A`, marked
 * `verified`. No bundle assigns a computed, unreadable key on `String.prototype`
 * - a polyfill spells the name it installs - so counting every one costs
 * nothing real. A computed key that IS readable is the first shape and is
 * matched by name, so `String.prototype['trim'] = f` still refuses nothing.
 *
 * The residue is a key the analysis cannot read: `Object.defineProperty(String
 * .prototype, k, d)`. Counting that would refuse the `defineProperty` every
 * transpiled bundle carries, which is a cost paid by every file to cover one
 * nobody has written. A key that becomes readable on a later round is not a
 * residue: the memo is the caller's `DispatcherRound`, and the next run asks
 * again.
 */
function replacesSplit(at: NodePath, round: DispatcherRound | undefined): boolean {
  if (round?.splitReplaced !== undefined) return round.splitReplaced;
  const program = at.scope.getProgramParent().path.node;

  let replaced = false;
  eachNode(program, (node) => {
    if (replaced) return;
    if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left)) {
      if (isNamedMember(node.left, 'split')) replaced = true;
      else if (isStringPrototype(node.left)) replaced = true;
      else if (
        node.left.computed &&
        staticString(node.left.property) === undefined &&
        t.isMemberExpression(node.left.object) &&
        isStringPrototype(node.left.object)
      ) {
        replaced = true;
      }
    } else if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
      if (isNamedMember(node.callee, 'defineProperty')) {
        const key = node.arguments[1];
        if (t.isStringLiteral(key, { value: 'split' })) replaced = true;
      } else if (isNamedMember(node.callee, 'defineProperties')) {
        const map = node.arguments[1];
        if (t.isObjectExpression(map) && map.properties.some(isSplitKey)) replaced = true;
      }
    }
  });
  if (round) round.splitReplaced = replaced;
  return replaced;
}

/** `String.prototype`, spelled with a dot or as `String['prototype']`. */
function isStringPrototype(node: t.MemberExpression): boolean {
  return isNamedMember(node, 'prototype') && t.isIdentifier(node.object, { name: 'String' });
}

function isSplitKey(property: t.ObjectExpression['properties'][number]): boolean {
  if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return false;
  return property.computed
    ? t.isStringLiteral(property.key, { value: 'split' })
    : t.isIdentifier(property.key, { name: 'split' }) ||
        t.isStringLiteral(property.key, { value: 'split' });
}

function resolveOrderEntries(
  node: t.Node,
  at: NodePath,
  options: DispatcherOptions,
  depth: number,
): StateKey[] | undefined {
  if (depth > MAX_RESOLVE_DEPTH) return undefined;

  if (t.isArrayExpression(node)) {
    const entries: StateKey[] = [];
    for (const element of node.elements) {
      if (!element) return undefined;
      if (t.isStringLiteral(element)) {
        entries.push(element.value);
        continue;
      }
      const numeric = t.isExpression(element) ? staticNumber(element) : undefined;
      if (numeric === undefined) return undefined;
      entries.push(numeric);
    }
    return entries;
  }

  // `'3|0|4'.split('|')`, evaluated below with THIS process's `split`: the
  // engine's closed-world assumption about intrinsics, spent on the one call the
  // whole recovery depends on. Refusing here instead would not be the cautious
  // option, it would be the pass -- the order string IS the recovery, and every
  // dispatcher the obfuscator emits spells it this way.
  //
  // Spending it here is what entitles `analyzeDispatcher` to spend it again on
  // the same call, through the oracle's `assumeNativeBuiltins`, when it decides
  // the declaration can go; the argument is written out at that call site. The
  // one thing the assumption costs is stated there too and is pinned by
  // `dispatcher-order-array-hazards.test.ts`: a `split` that returns a different
  // array makes the order below wrong, and no guard on the DELETION could have
  // helped with that.
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    if (!t.isMemberExpression(callee) || !isNamedMember(callee, 'split')) return undefined;
    if (node.arguments.length !== 1) return undefined;
    const separator = t.isExpression(node.arguments[0])
      ? resolveStaticString(node.arguments[0], at, options, depth + 1)
      : undefined;
    if (separator === undefined || separator.length === 0) return undefined;
    const subject = t.isExpression(callee.object)
      ? resolveStaticString(callee.object, at, options, depth + 1)
      : undefined;
    if (subject === undefined) return undefined;
    return subject.split(separator);
  }

  // A computed order array reached through a constant binding. Only followed
  // under `aggressiveDispatchers`, and only while it stays statically resolvable.
  if (options.aggressive && t.isIdentifier(node)) {
    const init = constantInitialiser(node.name, at, options);
    if (!init) return undefined;
    return resolveOrderEntries(init.node, init.path, options, depth + 1);
  }

  return undefined;
}

function resolveStaticString(
  node: t.Expression,
  at: NodePath,
  options: DispatcherOptions,
  depth: number,
): string | undefined {
  if (depth > MAX_RESOLVE_DEPTH) return undefined;

  const literal = staticString(node);
  if (literal !== undefined) return literal;

  // Split strings arrive as `'1|0|' + '2|4|' + '3'`; folding them here keeps the
  // pass working even when constant folding has not caught up yet.
  if (t.isBinaryExpression(node) && node.operator === '+' && t.isExpression(node.left)) {
    const left = resolveStaticString(node.left, at, options, depth + 1);
    if (left === undefined) return undefined;
    const right = resolveStaticString(node.right, at, options, depth + 1);
    return right === undefined ? undefined : left + right;
  }

  if (options.aggressive && t.isIdentifier(node)) {
    const init = constantInitialiser(node.name, at, options);
    if (!init || !t.isExpression(init.node)) return undefined;
    return resolveStaticString(init.node, init.path, options, depth + 1);
  }

  // `order = alias.hVmQB.split('|')`: obfuscator.io routes the order string
  // through the same property-alias map it uses for every other constant.
  // `simplify.object-maps` normally inlines that read before this pass ever
  // sees it, but it only does so once it can prove the whole map safe - so
  // when it refuses, or is switched off, the dispatcher is left looking
  // unresolvable even though the string is sitting in a literal one hop away.
  if (options.aggressive && t.isMemberExpression(node)) {
    const value = constantMapEntry(node, at, options);
    if (!value) return undefined;
    return resolveStaticString(value.node, value.path, options, depth + 1);
  }

  return undefined;
}

/**
 * Whether string code can reach this binding by name, and so whether Babel's
 * account of who writes it is an account of the running program.
 *
 * `binding.constant` and `binding.referencePaths` are built from the references
 * Babel can SEE. A direct `eval` names a binding in source it compiles at run
 * time, so it writes one without leaving a `constantViolation` behind and reads
 * one without leaving a reference; `Function(src)` and the other global-scope
 * forms do the same to a program-scope binding. Every claim this file makes
 * about either of the dispatcher's names, and every hop the aggressive arms take
 * through a "constant" binding, is exactly such an account.
 *
 * Absent facts mean the caller has established nothing, which is not the same as
 * having established that there is no string code - so it reads as the hazard.
 */
function addressableByStringCode(binding: Binding, options: DispatcherOptions): boolean {
  return options.stringCode ? options.stringCode.addresses(binding) : true;
}

/**
 * The same question for the dispatcher's own two bindings, worded for the
 * diagnostic, or nothing when neither is reachable.
 *
 * The two hazards are not the same fact and a reader chasing a refusal needs to
 * know which one fired, so `reaches` - a direct `eval` with this scope on its
 * chain - is asked before the composite: a `Function(src)` reaching a
 * program-scope binding is a different thing to look for in the file.
 */
function stringCodeRefusal(
  options: DispatcherOptions,
  ...bindings: readonly Binding[]
): string | undefined {
  const facts = options.stringCode;
  const subject = 'the order array or the state counter';
  if (!facts) return `string code was not ruled out for ${subject}`;
  for (const binding of bindings) {
    if (facts.reaches(binding.scope)) return `a direct eval can address ${subject} by name`;
    if (facts.addresses(binding)) {
      return `string code compiled in global scope can address ${subject} by name`;
    }
  }
  return undefined;
}

/**
 * The initialiser of a never-reassigned local binding, or nothing.
 *
 * "Never reassigned" is Babel's `constant`, which is why the string-code fact is
 * asked here as well: `var src = ['1','0']; eval('src = ["0","1"]');` leaves the
 * binding constant as far as scope analysis is concerned, and following it to
 * the literal recovered the order of a machine the program never runs - measured
 * at stock `aggressive` as `a | b` before and `b | a` after, with the `eval`
 * left in place doing nothing.
 *
 * `analyzeDispatcher` has already refused a loop inside a `with`, so the read
 * site is clear. The DECLARATION site is a second position and needs its own
 * check: `with (o) { var src = ['1','0']; }` initialises `o.src` rather than the
 * hoisted binding whenever `o` carries that key, so the binding still reads
 * `undefined` here and the literal Babel points at was never stored.
 */
function constantInitialiser(
  name: string,
  at: NodePath,
  options: DispatcherOptions,
): { node: t.Node; path: NodePath } | undefined {
  const binding = at.scope.getBinding(name);
  if (!binding || !binding.constant) return undefined;
  if (addressableByStringCode(binding, options)) return undefined;
  const declarator = binding.path;
  if (!declarator.isVariableDeclarator() || !declarator.node.init) return undefined;
  if (insideWith(declarator)) return undefined;
  return { node: declarator.node.init, path: declarator };
}

/**
 * The value behind `map.key`, when the object it names is provably a fixed table.
 *
 * "Provably" is the whole point, and it is three separate facts:
 *
 * - the binding is never reassigned and holds an object literal of plain,
 *   non-computed, non-shorthand data properties, so no getter and no `__proto__`
 *   entry can run code or move the lookup onto a prototype;
 * - *every* reference to it is a static-key member read, so the object never
 *   escapes into something that could write to it, and nothing ever deletes,
 *   assigns or enumerates a key;
 * - each of those reads names its key with a literal, so no key expression can
 *   run code between the declaration and this lookup.
 *
 * Together those mean the property still holds exactly what the literal put
 * there. Any one of them missing and this returns nothing.
 *
 * A fourth is about position rather than shape, and it closes the chain by
 * induction: every anchor this resolver is ever handed is outside a `with`. The
 * first is the order array's own initialiser, which `analyzeDispatcher` refuses
 * under a `with` outright; each later one is a declarator, and both this and
 * `constantInitialiser` refuse a declarator under a `with` - where `var m = {...}`
 * stores into the object instead of the binding, leaving the literal Babel
 * points at somewhere the program never reads.
 *
 * And a fifth, shared with `constantInitialiser` and for the same reason: the
 * first two facts are both readings of a reference list that string code does
 * not appear in. `var m = { k: '1|0' }; eval('m = { k: "0|1" }');` satisfies
 * every shape test above and resolved to the wrong string.
 */
function constantMapEntry(
  node: t.MemberExpression,
  at: NodePath,
  options: DispatcherOptions,
): { node: t.Expression; path: NodePath } | undefined {
  if (!t.isIdentifier(node.object)) return undefined;
  const key = staticMemberKey(node);
  if (key === undefined || key === '__proto__') return undefined;

  const binding = at.scope.getBinding(node.object.name);
  if (!binding || !binding.constant) return undefined;
  if (addressableByStringCode(binding, options)) return undefined;
  const declarator = binding.path;
  if (!declarator.isVariableDeclarator()) return undefined;
  if (insideWith(declarator)) return undefined;
  const init = declarator.node.init;
  if (!t.isObjectExpression(init)) return undefined;

  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    if (!parent?.isMemberExpression() || parent.node.object !== reference.node) return undefined;
    if (!isPureContext(parent)) return undefined;
    if (staticMemberKey(parent.node) === undefined) return undefined;
  }

  let found: t.Expression | undefined;
  for (const property of init.properties) {
    if (!t.isObjectProperty(property) || property.computed || property.shorthand) return undefined;
    const name = t.isIdentifier(property.key) ? property.key.name : staticString(property.key);
    if (name === undefined || name === '__proto__') return undefined;
    if (name !== key) continue;
    // A duplicate key is last-write-wins, and reading it wrong is worse than
    // not reading it at all.
    if (found) return undefined;
    if (!t.isExpression(property.value)) return undefined;
    found = property.value;
  }

  return found ? { node: found, path: declarator } : undefined;
}

/** A member key written as a literal: `m.k` or `m['k']`, never `m[expr]`. */
function staticMemberKey(node: t.MemberExpression): string | undefined {
  if (!node.computed) return t.isIdentifier(node.property) ? node.property.name : undefined;
  return t.isExpression(node.property) ? staticString(node.property) : undefined;
}

function isNamedMember(node: t.MemberExpression, name: string): boolean {
  if (node.computed) return t.isStringLiteral(node.property, { value: name });
  return t.isIdentifier(node.property, { name });
}

/**
 * Whether `declaration` is guaranteed to have run by the time `loop` is
 * reached. Only the same-statement-list case is provable cheaply, which is the
 * only case the obfuscator emits.
 */
function declarationPrecedes(declaration: NodePath, loop: NodePath): boolean {
  const statement = declaration.getStatementParent();
  if (!statement || typeof statement.key !== 'number') return false;
  const container = statement.parentPath;
  if (!container) return false;

  let current: NodePath | null = loop;
  while (current && current.parentPath !== container) current = current.parentPath;
  if (!current || typeof current.key !== 'number') return false;
  if (current.listKey !== statement.listKey) return false;
  return statement.key < current.key;
}

// ---------------------------------------------------------------------------
// Case bodies
// ---------------------------------------------------------------------------

function readCases(
  switchNode: t.SwitchStatement,
  orderName: string,
  stateName: string,
): { value: Map<string, DispatcherCase> } | { reason: string } {
  const cases = new Map<string, DispatcherCase>();
  const stateNames = new Set([orderName, stateName]);

  for (let index = 0; index < switchNode.cases.length; index++) {
    const kase = switchNode.cases[index]!;

    if (!kase.test) {
      // `default` is only the machine's terminator when it is last and empty:
      // anywhere else it would absorb an unknown state or fall through.
      if (index !== switchNode.cases.length - 1)
        return { reason: 'the switch has a non-final default' };
      if (!isTerminatorDefault(kase.consequent)) {
        return { reason: 'the switch has a default that is not just the terminator' };
      }
      continue;
    }

    const key = literalKey(kase.test);
    if (key === undefined) return { reason: 'a case label is not a literal' };
    const id = keyId(key);
    if (cases.has(id)) return { reason: `duplicate case label ${id}` };

    const body = readCaseBody(kase.consequent, stateNames);
    if ('reason' in body) return { reason: `case ${id}: ${body.reason}` };
    cases.set(id, { key, body: body.value });
  }

  return { value: cases };
}

function isTerminatorDefault(consequent: t.Statement[]): boolean {
  if (consequent.length === 0) return true;
  if (consequent.length !== 1) return false;
  const only = consequent[0]!;
  return t.isBreakStatement(only) && !only.label;
}

function readCaseBody(
  consequent: t.Statement[],
  stateNames: ReadonlySet<string>,
): { value: t.Statement[] } | { reason: string } {
  if (consequent.length === 0) return { reason: 'the body is empty and falls through' };

  for (const statement of consequent) {
    // All cases share one block scope today; linearising moves them into the
    // enclosing block, where a `let` could collide or change TDZ.
    if (t.isVariableDeclaration(statement) && statement.kind !== 'var') {
      return { reason: `the body declares a block-scoped ${statement.kind}` };
    }
    if (t.isClassDeclaration(statement)) return { reason: 'the body declares a class' };
    // A function declared in a case is a lexical name of the switch and, in
    // sloppy code, a var Annex B.3.3 assigns when the case RUNS; spliced into
    // a function body it is bound on entry, and `log(typeof f)` in the case
    // dispatched before it prints `function` where the program printed
    // `undefined`. obfuscator.io never flattens a block that declares one.
    if (t.isFunctionDeclaration(statement)) return { reason: 'the body declares a function' };
  }

  const jumps: JumpReport = {
    outerLabel: false,
    switchBreaks: 0,
    dispatcherContinues: 0,
    sawEval: false,
  };
  for (const statement of consequent) {
    scanJumps(statement, { loopDepth: 0, breakableDepth: 0, labels: new Set() }, jumps);
  }
  if (jumps.outerLabel) return { reason: 'a jump targets a label outside the dispatcher' };
  if (jumps.switchBreaks > 0)
    return { reason: 'a break escapes the switch into code after the loop' };
  if (jumps.sawEval) return { reason: 'a direct eval could reach the dispatcher state' };
  if (consequent.some((statement) => mentionsName(statement, stateNames))) {
    return { reason: 'the body reads or writes the dispatcher state' };
  }

  const last = consequent[consequent.length - 1]!;

  if (t.isContinueStatement(last) && !last.label) {
    // Any earlier dispatcher `continue` would skip the rest of this body, which
    // linearisation cannot express.
    if (jumps.dispatcherContinues !== 1) {
      return { reason: 'the body continues the dispatcher before its end' };
    }
    return { value: consequent.slice(0, -1) };
  }

  if (jumps.dispatcherContinues > 0)
    return { reason: 'the body continues the dispatcher before its end' };
  if (t.isReturnStatement(last) || t.isThrowStatement(last)) return { value: consequent };

  return { reason: 'the body neither continues nor terminates, so it falls through' };
}

interface JumpContext {
  /** Nested loops inside the case body; an unlabelled `continue` binds to these. */
  loopDepth: number;
  /** Nested loops or switches; an unlabelled `break` binds to these. */
  breakableDepth: number;
  labels: Set<string>;
}

interface JumpReport {
  outerLabel: boolean;
  switchBreaks: number;
  dispatcherContinues: number;
  sawEval: boolean;
}

function scanJumps(node: t.Node, context: JumpContext, out: JumpReport): void {
  // A jump cannot cross a function boundary, and a nested function's own labels
  // are its business.
  if (t.isFunction(node)) return;

  switch (node.type) {
    case 'ContinueStatement':
      if (node.label) {
        if (!context.labels.has(node.label.name)) out.outerLabel = true;
      } else if (context.loopDepth === 0) {
        out.dispatcherContinues++;
      }
      return;

    case 'BreakStatement':
      if (node.label) {
        if (!context.labels.has(node.label.name)) out.outerLabel = true;
      } else if (context.breakableDepth === 0) {
        out.switchBreaks++;
      }
      return;

    case 'LabeledStatement': {
      const labels = new Set(context.labels);
      labels.add(node.label.name);
      scanJumps(node.body, { ...context, labels }, out);
      return;
    }

    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      scanChildren(
        node,
        {
          ...context,
          loopDepth: context.loopDepth + 1,
          breakableDepth: context.breakableDepth + 1,
        },
        out,
      );
      return;

    case 'SwitchStatement':
      scanJumps(node.discriminant, context, out);
      for (const kase of node.cases) {
        scanChildren(kase, { ...context, breakableDepth: context.breakableDepth + 1 }, out);
      }
      return;

    case 'CallExpression':
      if (t.isIdentifier(node.callee, { name: 'eval' })) out.sawEval = true;
      break;

    default:
      break;
  }

  scanChildren(node, context, out);
}

function scanChildren(node: t.Node, context: JumpContext, out: JumpReport): void {
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (isNode(item)) scanJumps(item, context, out);
      }
    } else if (isNode(child)) {
      scanJumps(child, context, out);
    }
  }
}

/**
 * Whether any of `names` appears as a variable anywhere under `node`.
 *
 * The scope checks above already prove the order array and counter are touched
 * only by the dispatcher, but they trust Babel's binding tables, which earlier
 * passes can leave stale. This is the local, scope-free confirmation over the
 * exact code the rewrite moves. It over-approximates on purpose - a shadowed
 * name costs a bail-out, a missed one would corrupt the recovered order.
 */
function mentionsName(node: t.Node, names: ReadonlySet<string>): boolean {
  if (t.isIdentifier(node)) return names.has(node.name);
  if (t.isPrivateName(node)) return false;

  const fixed = fixedNameKey(node);
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    if (key === fixed) continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      if (child.some((item) => isNode(item) && mentionsName(item, names))) return true;
    } else if (isNode(child) && mentionsName(child, names)) {
      return true;
    }
  }
  return false;
}

/**
 * The child key holding a fixed name rather than a variable reference, so that
 * `state.i`, `{ i: 1 }` and `i: while (...)` are not mistaken for uses of `i`.
 */
function fixedNameKey(node: t.Node): string | undefined {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    return node.computed ? undefined : 'property';
  }
  if (
    t.isObjectProperty(node) ||
    t.isObjectMethod(node) ||
    t.isClassMethod(node) ||
    t.isClassProperty(node)
  ) {
    return node.computed ? undefined : 'key';
  }
  if (t.isLabeledStatement(node) || t.isBreakStatement(node) || t.isContinueStatement(node)) {
    return 'label';
  }
  return undefined;
}

function literalKey(node: t.Expression): StateKey | undefined {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value;
  return undefined;
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function reject(reason: string): { kind: 'reject'; reason: string } {
  return { kind: 'reject', reason };
}

function bail(reason: string): { kind: 'bail'; reason: string } {
  return { kind: 'bail', reason };
}

// ---------------------------------------------------------------------------
// The register-VM dispatcher
// ---------------------------------------------------------------------------

/**
 * A second, unrelated machine that also drives a `switch` from a loop:
 *
 * ```js
 * function f(r) {
 *   while (sum(r) !== -177) {
 *     switch (sum(r)) {
 *       case -198:
 *       case r[27] - 10:
 *         r[8] += r[52] + 700;
 *         r[10] += r[89] - 1153;
 *         break;
 *     }
 *   }
 * }
 * ```
 *
 * The state is not an index into an order array; it is the *sum* of a register
 * vector, and each case moves that sum by adding register-dependent deltas. The
 * case labels are register reads too, so the jump table is genuinely dynamic:
 * the construct is a bytecode interpreter whose bytecode lives in the registers.
 *
 * Nothing in `analyzeDispatcher` applies. It proves an order array driving a
 * monotonic counter, and pointing it at this shape makes it `reject` inside
 * `readShape` - silently, which is exactly how 67 of these came to be invisible
 * to the entire engine. The gate below widens; the proof never does.
 */
export interface RegisterVm {
  switchNode: t.SwitchStatement;
  /** The function that reduces the register file to the switch key. */
  keyName: string;
  /**
   * The expression the register file is read from.
   *
   * A plain identifier in the 51 dispatchers whose file is a parameter, and a
   * computed heap path - `o.a.b[k(r[49] + 863818, ...)][k(...)]` - in the other 16.
   * Recognition takes both, because leaving the second kind unnamed is how all
   * 67 came to be invisible; recovery takes only the first.
   */
  register: t.Expression;
  /**
   * The sum the loop halts on, when the halt condition is a literal.
   *
   * 9 of the fixture's 67 machines compare against a register read instead -
   * a halt condition that moves. They are still register VMs and are still
   * worth naming, so recognition takes them; recovery, which has to know when
   * the trace has finished, does not.
   */
  exitSum: number | undefined;
}

/**
 * Cheap structural pre-filter, safe to run on every loop in the program, and
 * deliberately free of scope lookups so the pre-scan can use it on bare nodes.
 * A `true` means "worth resolving the key function", not "is a register VM".
 */
export function looksLikeRegisterVm(node: t.Node): boolean {
  return readRegisterVm(node) !== undefined;
}

export function readRegisterVm(node: t.Node): RegisterVm | undefined {
  if (!t.isWhileStatement(node) && !t.isForStatement(node)) return undefined;
  const test = node.test;
  // `!==` and `!=` agree on two numbers, and the halt sum is always one.
  if (!test || !t.isBinaryExpression(test)) return undefined;
  if (test.operator !== '!==' && test.operator !== '!=') return undefined;
  if (!t.isExpression(test.left)) return undefined;

  const guard = readKeyCall(test.left);
  if (!guard) return undefined;

  const body = node.body;
  // One statement, not two: this loop leaves through its own test rather than a
  // trailing `break`, which is the other half of why `looksLikeDispatcher`
  // refuses the shape.
  if (!t.isBlockStatement(body) || body.body.length !== 1) return undefined;
  if (body.directives.length > 0) return undefined;
  const switchNode = body.body[0];
  if (!t.isSwitchStatement(switchNode)) return undefined;

  const dispatch = readKeyCall(switchNode.discriminant);
  if (!dispatch) return undefined;
  // Loop test and dispatch must read the same register file through the same
  // reducer, or they are two machines sharing a syntax.
  if (dispatch.keyName !== guard.keyName) return undefined;
  if (!sameExpression(dispatch.register, guard.register, 0)) return undefined;

  return {
    switchNode,
    keyName: guard.keyName,
    register: guard.register,
    exitSum: staticNumber(test.right),
  };
}

/** `sum(<register file>)` - a one-argument call through a named function. */
function readKeyCall(node: t.Node): { keyName: string; register: t.Expression } | undefined {
  if (!t.isCallExpression(node)) return undefined;
  if (!t.isIdentifier(node.callee)) return undefined;
  if (node.arguments.length !== 1) return undefined;
  const argument = node.arguments[0];
  if (!t.isExpression(argument)) return undefined;
  return { keyName: node.callee.name, register: argument };
}

/** How deep two key expressions are compared before the match is abandoned. */
const MAX_KEY_DEPTH = 32;

/**
 * Structural equality over two expressions, ignoring positions and comments.
 *
 * The loop test and the switch discriminant have to be reading the *same*
 * register file, and on the dispatchers whose file is a computed heap path
 * "the same" cannot be answered by comparing two names. Driven off
 * `NODE_FIELDS` rather than a hand-written case list so that a shape nobody
 * anticipated compares unequal - which refuses - instead of comparing equal on
 * the fields somebody remembered to check.
 */
function sameExpression(a: t.Node, b: t.Node, depth: number): boolean {
  if (depth > MAX_KEY_DEPTH) return false;
  if (a.type !== b.type) return false;

  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  for (const field of Object.keys(t.NODE_FIELDS[a.type] ?? {})) {
    if (!sameField(left[field], right[field], depth)) return false;
  }
  return true;
}

function sameField(a: unknown, b: unknown, depth: number): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameField(item, b[index], depth + 1));
  }
  if (isNode(a) && isNode(b)) return sameExpression(a, b, depth + 1);
  // `null` and `undefined` both spell "this optional field is absent".
  return (a ?? null) === (b ?? null);
}

/**
 * Whether `name` resolves to a reduction of an array to the sum of its elements.
 *
 * Recognising the reducer is what turns "a loop shaped like a register VM" into
 * "a register VM": the entire recovery rests on the switch key being a pure
 * function of the register values, and this is the only place that is checked
 * rather than assumed. It also keeps the detection honest, since an
 * unrecognised key function is then reported as nothing at all rather than as a
 * machine that cannot actually be named.
 */
export function resolvesToSumReducer(
  at: NodePath,
  name: string,
  blockFunctions?: BlockFunctionMemo,
): boolean {
  const binding = at.scope.getBinding(name);
  if (!binding) return false;
  // A reassigned name is not the inspected function by the time it is called.
  if (binding.constantViolations.some((violation) => violation.node !== binding.path.node)) {
    return false;
  }

  // A sloppy `{ function name() {} }` on the way from `at` to the declaration
  // assigns the var-scoped name when its block runs, and no violation list
  // records it. The memo is the caller's traversal's: asked for every loop of
  // a 4 MB file, the walk behind it would otherwise repeat per loop.
  if (shadowedByBlockFunction(name, at.scope, binding, blockFunctions)) return false;

  const declaration = binding.path;
  if (declaration.isFunctionDeclaration()) return isSumReducer(declaration.node);
  if (!declaration.isVariableDeclarator()) return false;
  const init = declaration.node.init;
  if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) return isSumReducer(init);
  return false;
}

/** `function (a) { for (var s = 0, i = 0; i < a.length; i++) s += a[i]; return s; }` */
export function isSumReducer(fn: t.Function): boolean {
  if (fn.async || fn.generator) return false;
  if (fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return false;
  const source = fn.params[0].name;
  const body = fn.body;
  if (!t.isBlockStatement(body) || body.directives.length > 0) return false;

  // Accumulator and cursor may be declared above the loop or in its head; both
  // spellings are the same machine.
  const zeroed = new Set<string>();
  let index = 0;
  for (; index < body.body.length; index++) {
    const statement = body.body[index]!;
    if (!t.isVariableDeclaration(statement)) break;
    if (!collectZeroed(statement, zeroed)) return false;
  }
  if (body.body.length !== index + 2) return false;

  const loop = body.body[index];
  const tail = body.body[index + 1];
  if (!t.isForStatement(loop)) return false;
  if (!t.isReturnStatement(tail) || !t.isIdentifier(tail.argument)) return false;
  const total = tail.argument.name;

  if (loop.init) {
    if (!t.isVariableDeclaration(loop.init)) return false;
    if (!collectZeroed(loop.init, zeroed)) return false;
  }
  if (!zeroed.has(total)) return false;

  const test = loop.test;
  if (!t.isBinaryExpression(test) || test.operator !== '<') return false;
  if (!t.isIdentifier(test.left)) return false;
  const cursor = test.left.name;
  if (cursor === total || !zeroed.has(cursor)) return false;
  if (!t.isMemberExpression(test.right) || test.right.computed) return false;
  if (!t.isIdentifier(test.right.object, { name: source })) return false;
  if (!t.isIdentifier(test.right.property, { name: 'length' })) return false;

  const update = loop.update;
  if (!t.isUpdateExpression(update) || update.operator !== '++') return false;
  if (!t.isIdentifier(update.argument, { name: cursor })) return false;

  const inner = t.isBlockStatement(loop.body) ? loop.body.body : [loop.body];
  if (inner.length !== 1 || !t.isExpressionStatement(inner[0])) return false;
  const add = (inner[0] as t.ExpressionStatement).expression;
  if (!t.isAssignmentExpression(add) || add.operator !== '+=') return false;
  if (!t.isIdentifier(add.left, { name: total })) return false;
  if (!t.isMemberExpression(add.right) || !add.right.computed) return false;
  if (!t.isIdentifier(add.right.object, { name: source })) return false;
  return t.isIdentifier(add.right.property, { name: cursor });
}

function collectZeroed(declaration: t.VariableDeclaration, into: Set<string>): boolean {
  for (const declarator of declaration.declarations) {
    if (!t.isIdentifier(declarator.id)) return false;
    if (staticNumber(declarator.init) !== 0) return false;
    into.add(declarator.id.name);
  }
  return true;
}

/**
 * Jump analysis over a statement list, exported for the register-VM pass.
 *
 * Linearising a case body has the same precondition whichever machine produced
 * it - no jump may escape the construct being removed - so the scanner that
 * proves it is shared rather than written twice.
 */
export function scanCaseJumps(statements: readonly t.Statement[]): JumpReport {
  const jumps: JumpReport = {
    outerLabel: false,
    switchBreaks: 0,
    dispatcherContinues: 0,
    sawEval: false,
  };
  for (const statement of statements) {
    scanJumps(statement, { loopDepth: 0, breakableDepth: 0, labels: new Set() }, jumps);
  }
  return jumps;
}

export type { JumpReport };
