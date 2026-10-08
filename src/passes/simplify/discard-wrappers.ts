import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import {
  insideWith,
  isVarScopedFunctionDeclaration,
  shadowedByBlockFunction,
  type BlockFunctionMemo,
} from '../../util/ast.js';
import { removeStatement, wouldBecomeDirective } from './proxy-functions.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Flatten calls to a wrapper that swallows every argument it is handed.
 *
 * ```js
 * function w() { w = function () {}; }
 * w(a[i] = 1, b.k++, send(x));
 * ```
 *
 * `w` declares no parameters and its body computes nothing, so the call is a
 * comma sequence wearing a callee: the arguments are evaluated left to right and
 * the results thrown away. The 4 MB fixture calls one such wrapper 1,753 times
 * with 13,906 arguments, every one of them an assignment or a call - which is
 * the point of the construct. Hiding real work inside an argument list puts it
 * where nothing statement-level can reach it: a register write buried in
 * `w(r[8] += ..., r[10] += ...)` is invisible to every pass that reasons about
 * statements, and there are twenty-five of them per switch case.
 *
 * Rewriting the call as `(a[i] = 1, b.k++, send(x))` hands it to
 * `simplify.sequences`, which turns it into three statements. The output gets
 * *longer* - the fixture doubles in line count - and that is the trade: the
 * program stops being an expression and starts being code.
 *
 * This is the exact dual of `simplify.proxy-functions` next door, which is why
 * it is a separate pass rather than another branch there. That pass is a
 * β-reducer whose safety story is "an argument that is DROPPED must have nothing
 * to lose", and it refuses this shape at four independent gates - the loudest
 * being that with zero parameters *every* argument is surplus and so must be
 * side-effect free. Here the arguments are impure, and that is precisely why
 * they are kept, in order, as a sequence. Making one pass hold both invariants
 * means inverting three of them inside the file whose comments say an
 * unanticipated shape must fail closed.
 *
 * Deliberately not attempted:
 *
 * - *A call in value position.* The wrapper yields `undefined`; a
 *   `SequenceExpression` yields its last operand, so `x = w(a, b)` would become
 *   `x = (a, b)` and assign `b` where the original assigned `undefined`. The
 *   pass hooks `ExpressionStatement` so that this is structurally impossible
 *   rather than a check that can be got wrong. The faithful rewrite would be
 *   `void (a, b)`, which is unconditionally right; it stays out because it is
 *   untested and all 1,753 real call sites are already statement position.
 * - *`w(...xs)`.* Two reasons, both fatal. `SpreadElement` is not a legal
 *   sequence operand, so `(...xs)` does not parse; and the call runs the whole
 *   iterator protocol on `xs` - `Symbol.iterator`, repeated `next()`, reads of
 *   `done` and `value` - which a hostile or proxied iterable can observe.
 *   `[...xs]` reproduces that faithfully and allocates an array nobody can see,
 *   so it *is* the sound rewrite; it is not shipped because no call site in the
 *   corpus needs it and an untested rewrite is worse than a refusal.
 * - *Deleting the declaration.* The rewrite is safe with it in place; deletion
 *   is the step that breaks `eval('typeof w')` or a reference this analysis
 *   never saw. `clean.unused` runs later in the same fixpoint block under its
 *   own rules.
 * - *Dropping arguments.* Every one of the 13,906 is side-effecting, so there is
 *   no dead-argument elimination on offer. This pass is a pure flatten.
 * - *Checking argument purity.* It is the one thing that needs no guard.
 *   `w(a, b, c)` evaluates a, b, c left to right and discards; `(a, b, c)`
 *   evaluates a, b, c left to right and discards all but the last, which the
 *   enclosing `ExpressionStatement` then discards too. Getters, coercions,
 *   `++`, `delete`, a throw mid-list, an `await` inside an argument - all fire
 *   in identical order with identical values. Nothing is dropped, reordered,
 *   duplicated or made conditional.
 *
 * Known, accepted and not guarded: `Function.prototype.toString` drift. With
 * every call gone the self-erasing assignment never runs, so a late observer
 * would read the original body rather than `function () {}`. `.name` and
 * `.length` are unchanged; only `toString` and object identity differ, and both
 * are only reachable through a value reference that R1 below already forbids.
 */
export const unwrapDiscardedArgumentsPass: Pass = {
  id: 'simplify.discard-wrappers',
  title: 'Unwrap argument-discarding wrappers',
  stage: 'simplify',
  technique: 'functionUnwrapping',
  visitor: (ctx) => {
    // Per traversal: what each var scope hoists is fixed for as long as no
    // declaration is added, and a rewrite here turns a call into a sequence.
    const blockFunctions: BlockFunctionMemo = new Map();
    return {
      // A scope owner is entered before its body is walked, so a binding is always
      // proven before any call site inside it is reached.
      Scopable: (path: NodePath<t.Scopable>) => approveScope(path, ctx, blockFunctions),
      ExpressionStatement: (path: NodePath<t.ExpressionStatement>) => rewriteStatement(path, ctx),
      Program: { exit: () => discloseEvalRisk(ctx) },
    };
  },
};

const APPROVED_KEY = 'simplify.discard-wrappers:approved';
const EVAL_HOSTS_KEY = 'simplify.discard-wrappers:eval-hosts';
const EVAL_RISK_KEY = 'simplify.discard-wrappers:eval-risk';

/**
 * Wrappers a direct `eval` could reassign, by declaration node.
 *
 * Approval of such a binding is the risk `refuseOnDirectEval` exists to buy
 * off, and the presets that leave it off do so on the assumption that no
 * mainstream obfuscator's string code rewrites a proxy wrapper. An assumption
 * a run relies on is one the run has to state: without this note the only
 * record of it was the option's doc comment, and a reader of the output had
 * nothing to tell them their file was one where it held.
 *
 * What is stated is what was DONE, not what was proved. Approval is not a
 * rewrite - every call site of an approved wrapper can still sit under the
 * eval host and be refused by the site rule - and it is not once: a crawl in
 * `clean.unused` changes the reference count, the next round re-proves the
 * binding, and a counter bumped at approval said "Unwrapped 1" on a file where
 * nothing was unwrapped and said it twice where one call was. So `approved`
 * only makes a binding eligible; the note counts bindings whose call site was
 * actually rewritten, each once for the whole run.
 */
interface EvalRisk {
  approved: Set<t.Node>;
  disclosed: Set<t.Node>;
  /** Rewritten under the risk this traversal and not yet in a note. */
  pending: number;
}

function evalRisk(ctx: PassContext): EvalRisk {
  let risk = ctx.shared.get(EVAL_RISK_KEY) as EvalRisk | undefined;
  if (!risk) {
    risk = { approved: new Set(), disclosed: new Set(), pending: 0 };
    ctx.shared.set(EVAL_RISK_KEY, risk);
  }
  return risk;
}

/** A call site of `binding` was just rewritten; count it if the eval risk applies. */
function recordRewrite(binding: Binding, ctx: PassContext): void {
  const risk = evalRisk(ctx);
  const declaration = binding.path.node;
  if (!risk.approved.has(declaration) || risk.disclosed.has(declaration)) return;
  risk.disclosed.add(declaration);
  risk.pending++;
}

function discloseEvalRisk(ctx: PassContext): void {
  const risk = evalRisk(ctx);
  if (risk.pending === 0) return;
  const n = risk.pending;
  ctx.note(
    'warning',
    `Unwrapped ${n} argument-discarding wrapper${n === 1 ? '' : 's'} that a direct eval can ` +
      'reach: if that eval reassigns one at run time, the rewritten call sites no longer call ' +
      'the replacement. Set functionUnwrapping.refuseOnDirectEval to refuse them instead.',
  );
  risk.pending = 0;
}

/**
 * Declarations proven to discard their arguments, with the reference count that
 * held at the time.
 *
 * Kept across fixpoint iterations because re-proving a binding costs a walk of
 * the scope that owns it. The count is the invalidation: rewriting a call site
 * mutates the statement in place and so leaves Babel's reference list untouched,
 * which means a *changed* count is exactly the signal that some other pass
 * introduced a use this proof never saw.
 */
type Approvals = Map<t.Node, number>;

function approvals(ctx: PassContext): Approvals {
  let map = ctx.shared.get(APPROVED_KEY) as Approvals | undefined;
  if (!map) {
    map = new Map<t.Node, number>();
    ctx.shared.set(APPROVED_KEY, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function approveScope(
  path: NodePath<t.Scopable>,
  ctx: PassContext,
  blockFunctions: BlockFunctionMemo,
): void {
  if (path.scope.path !== path) return;
  if (ctx.isExhausted()) return;

  for (const name of Object.keys(path.scope.bindings)) {
    const binding = path.scope.bindings[name];
    if (!binding) continue;
    const declaration = binding.path.node;
    if (approvals(ctx).get(declaration) === binding.referencePaths.length) continue;
    if (!isDiscardingWrapper(binding, ctx, blockFunctions)) continue;
    approvals(ctx).set(declaration, binding.referencePaths.length);
  }
}

function isDiscardingWrapper(
  binding: Binding,
  ctx: PassContext,
  blockFunctions: BlockFunctionMemo,
): boolean {
  // B2: only a function declaration. It is initialised on scope entry, so no
  // call site can observe a TDZ throw or a not-yet-assigned `undefined`, which
  // is not true of `var w = function () {}` from source position alone.
  if (binding.kind !== 'hoisted') return false;
  const declaration = binding.path;
  if (!declaration.isFunctionDeclaration()) return false;
  const fn = declaration.node;
  const name = binding.identifier.name;

  // B4: an async wrapper returns a promise and resumes on another tick; a
  // generator's body does not run on call at all.
  if (fn.async || fn.generator) return false;
  // D1: the cheap outer filter. D3 below is the test that actually matters.
  if (fn.params.length !== 0) return false;

  if (!declaredAtScopeTop(binding)) return false;
  if (!isDiscardingBody(fn, name)) return false;
  // B5: inside `with (o) { ... }` the callee is looked up on `o` first, so the
  // reference may never reach this binding.
  if (insideWith(declaration)) return false;

  // R1: every use is a direct call. One condition rules out `w` as a callback,
  // `w.call` / `w.apply` / `w.bind`, `Reflect.apply(w, ...)`, `new w()`, `w?.()`,
  // a tagged template, `[w]`, `x = w`, `typeof w`, `'k' in w` and any export of
  // the name. It has teeth on the fixture: two wrappers match the body shape
  // exactly and are refused here because all 22 of their references are the RHS
  // of an `in` opaque predicate, which reads the function as a value.
  for (const reference of binding.referencePaths) {
    if (insideWith(reference)) return false;
    const parent = reference.parentPath;
    if (!parent?.isCallExpression()) return false;
    if (parent.node.callee !== reference.node) return false;
    // R4: assert rather than assume that the use resolves to this binding.
    if (reference.scope.getBinding(name) !== binding) return false;
    // R4 again, for the writer no scope table lists: a sloppy `{ function w()
    // {...} }` between this call and the declaration assigns the var-scoped `w`
    // when its block runs. `function w() {} { function w(a) { log(a); } }
    // w(log('arg'))` came out as `log('arg')` and lost the second line.
    if (shadowedByBlockFunction(name, reference.scope, binding, blockFunctions)) return false;
  }

  // R2: nothing writes the name except its own declaration and the one
  // self-assignment the body is allowed to make, matched by node identity so
  // that a second writer of the same *shape* is still caught.
  const selfAssignment = selfAssignmentOf(fn);
  for (const violation of binding.constantViolations) {
    if (violation.node === declaration.node) continue;
    if (selfAssignment && violation.node === selfAssignment) continue;
    return false;
  }

  // Nothing to gain from the walk below when no call site is in a position this
  // pass would rewrite, which is every fixpoint round after the first.
  if (!binding.referencePaths.some((ref) => ref.parentPath?.parentPath?.isExpressionStatement())) {
    return false;
  }

  const facts = stringCodeFacts(ctx);
  // R5: code compiled in GLOBAL scope reassigns a program-scope wrapper by
  // name. `Function('w = function (a) { ... }')()`, an indirect `eval`, an
  // aliased one, `setTimeout` handed a literal - a program-scope `function w`
  // is a property of the global object and all of them can overwrite it, while
  // `constantViolations` stays empty and every gate above still passes. The
  // rewrite then drops arguments the replacement would have read.
  //
  // The site rule below cannot stand in for this one. It is about a `var` a
  // direct `eval` INJECTS into a scope between the call and this binding, and
  // its host set is built from direct-`eval` calls alone - global string code
  // contributes none, because it injects nothing here: it overwrites what is
  // already there. On a program whose only string code is global, that set is
  // empty and every call site passes.
  if (facts.global && binding.scope.path.isProgram()) return false;

  // A direct `eval` that can reach this binding can reassign it in exactly the
  // same way. `underEvalHost` answers only the injection question, so a call
  // site outside the injection host is still rewritten; that gap is what
  // `refuseOnDirectEval` closes, and its value per preset lives in
  // `src/config/presets.ts`. Where the flag is off the binding goes through and
  // the run says so - see `discloseEvalRisk` - because a preset that takes this
  // risk is making an assumption about the file, and the file is the one place
  // that assumption can be wrong.
  if (facts.reaches(binding.scope)) {
    if (ctx.config.techniqueOptions.functionUnwrapping.refuseOnDirectEval) return false;
    if (!referencesAreComplete(binding, name)) return false;
    evalRisk(ctx).approved.add(declaration.node);
    return true;
  }

  // Re-proved with no eval in reach - the round that deleted it - so a rewrite
  // from here on is not one the note describes.
  evalRisk(ctx).approved.delete(declaration.node);
  return referencesAreComplete(binding, name);
}

/**
 * R3/R4: confirm the reference list against the tree it describes.
 *
 * Babel's cached `referencePaths` can lag another pass's rewrites, and a
 * reference the analysis never saw is precisely a value use that R1 never got
 * to veto. A reference can only appear inside the scope that owns the binding,
 * which makes that scope's subtree an exact search space rather than a
 * heuristic one - and this only runs for a binding that has already passed
 * every cheap guard, so it is one walk per wrapper for the whole run.
 */
function referencesAreComplete(binding: Binding, name: string): boolean {
  const known = new Set<t.Node>(binding.referencePaths.map((reference) => reference.node));
  const owner = binding.scope.path;
  if (owner.removed || !owner.node) return false;

  let complete = true;
  owner.traverse({
    ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
      if (path.node.name !== name || known.has(path.node)) return;
      // A shadowing declaration further in makes this somebody else's name.
      if (path.scope.getBinding(name) !== binding) return;
      complete = false;
      path.stop();
    },
  });
  return complete;
}

/**
 * B3: the declaration sits directly in the body of the scope that owns it.
 *
 * This is what rules out an Annex B block-level function declaration -
 * `if (c) { function w() {} }` - where the hoisted `var` holds `undefined`
 * until control reaches the block, so a call above it would throw rather than
 * discard.
 */
function declaredAtScopeTop(binding: Binding): boolean {
  const declaration = binding.path;
  if (!declaration.isFunctionDeclaration()) return false;
  // An export is called by code this file cannot see, which R1 would otherwise
  // never get to veto.
  if (declaration.parentPath?.isExportDeclaration()) return false;
  return isVarScopedFunctionDeclaration(declaration);
}

/**
 * D2: every value the binding can ever hold discards its arguments.
 *
 * Not the same claim as "the body is a no-op". Call order is not statically
 * known, so `function w() { w = function (a) { log(a) } }` has to be refused:
 * the first call discards and every later one does not. Only two bodies are
 * accepted - nothing at all, and the self-erasing assignment whose replacement
 * is itself argument-discarding.
 */
function isDiscardingBody(fn: t.FunctionDeclaration, name: string): boolean {
  const body = fn.body;
  if (body.directives.length > 0) return false;
  if (body.body.length > 1) return false;
  if (body.body.length === 1) {
    const replacement = selfAssignmentOf(fn);
    if (!replacement) return false;
    const value = replacement.right;
    if (!isEmptyFunction(value)) return false;
    if (t.isIdentifier(replacement.left) && replacement.left.name !== name) return false;
  }
  // D3/D4/D5 over the whole subtree, the self-assignment's replacement included.
  return !usesCallerState(fn);
}

/** The `w = function () {}` an empty-but-for-one-statement body is allowed to be. */
function selfAssignmentOf(fn: t.FunctionDeclaration): t.AssignmentExpression | undefined {
  const [only] = fn.body.body;
  if (!t.isExpressionStatement(only)) return undefined;
  const assignment = only.expression;
  if (!t.isAssignmentExpression(assignment) || assignment.operator !== '=') return undefined;
  if (!t.isIdentifier(assignment.left)) return undefined;
  if (assignment.left.name !== (fn.id?.name ?? '')) return undefined;
  return assignment;
}

function isEmptyFunction(node: t.Node): boolean {
  if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
  if (node.async || node.generator) return false;
  if (node.params.length !== 0) return false;
  const body = node.body;
  return t.isBlockStatement(body) && body.body.length === 0 && body.directives.length === 0;
}

/**
 * D3/D4/D5: whether anything in the subtree can reach the caller's state.
 *
 * `arguments` is the dangerous one and the reason this is a scan for the *name*
 * rather than a parameter check: `function w() { send(arguments) }` declares no
 * parameters and reads every one of them, and an arrow nested in the body
 * inherits the same object. The rest - `this`, `new.target`, `super`, `yield`,
 * `await`, `debugger` - cannot occur in a body D2 accepts, and are checked
 * anyway because D2 is the part somebody will widen later.
 */
function usesCallerState(fn: t.Node): boolean {
  let found = false;
  const walk = (node: t.Node): void => {
    if (found) return;
    switch (node.type) {
      case 'Identifier':
        if (node.name === 'arguments') found = true;
        return;
      case 'ThisExpression':
      case 'MetaProperty':
      case 'Super':
      case 'YieldExpression':
      case 'AwaitExpression':
      case 'DebuggerStatement':
        found = true;
        return;
      default:
        break;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) walk(item);
      } else if (isNode(child)) {
        walk(child);
      }
    }
  };
  walk(fn);
  return found;
}

// ---------------------------------------------------------------------------
// Direct eval
// ---------------------------------------------------------------------------

/**
 * Var scopes a direct `eval` can inject a `var` into, recomputed once per
 * fixpoint round. A call site anywhere beneath one of these may be resolving
 * its callee against a binding that only exists at run time.
 *
 * This is the question `analysis/string-code.ts` deliberately does not answer.
 * That module answers whether string code can ADDRESS a binding - read it or
 * write it by name - which is a fact about the binding. Injection is a fact
 * about a *position*: it asks where a `var` the eval declares would land, and
 * which call sites sit under it. Nothing in the shared facts distinguishes the
 * nearest var scope from the rest of the chain, so the walk stays here.
 *
 * Shadowing is deliberately not modelled: a local binding named `eval` would
 * make the call an *indirect* eval, which can only reach global scope and is
 * therefore harmless here. Treating every `eval(...)` as direct over-approximates
 * in the refusing direction, and costs one raw structural scan - no Babel paths
 * - on the overwhelmingly common file that contains no `eval` at all.
 */
function evalHosts(ctx: PassContext): ReadonlySet<t.Node> {
  const cached = ctx.shared.get(EVAL_HOSTS_KEY) as
    | { iteration: number; value: ReadonlySet<t.Node> }
    | undefined;
  if (cached && cached.iteration === ctx.iteration) return cached.value;

  const value = containsEvalCall(ctx.ast) ? collectEvalHosts(ctx) : NO_HOSTS;
  ctx.shared.set(EVAL_HOSTS_KEY, { iteration: ctx.iteration, value });
  return value;
}

const NO_HOSTS: ReadonlySet<t.Node> = new Set();

function containsEvalCall(root: t.Node): boolean {
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
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'eval' })) return true;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

function collectEvalHosts(ctx: PassContext): ReadonlySet<t.Node> {
  const hosts = new Set<t.Node>();
  traverse(ctx.ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (!t.isIdentifier(path.node.callee, { name: 'eval' })) return;
      for (let up: NodePath | null = path.parentPath; up; up = up.parentPath) {
        // The nearest var scope is where an injected `var` lands, so the walk
        // stops at the first one rather than recording the whole chain.
        if (up.isFunction() || up.isProgram()) {
          hosts.add(up.node);
          return;
        }
      }
    },
  });
  return hosts;
}

/** Whether a rewrite here could be resolving a callee `eval` invented at run time. */
function underEvalHost(path: NodePath, hosts: ReadonlySet<t.Node>): boolean {
  if (hosts.size === 0) return false;
  for (let up: NodePath | null = path; up; up = up.parentPath) {
    if ((up.isFunction() || up.isProgram()) && hosts.has(up.node)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

function rewriteStatement(path: NodePath<t.ExpressionStatement>, ctx: PassContext): void {
  const call = path.node.expression;
  // C2 restated at the site: an `OptionalCallExpression` or `NewExpression` is
  // not this, and R1 has already refused any binding that is reached that way.
  if (!t.isCallExpression(call)) return;
  if (!t.isIdentifier(call.callee)) return;

  const binding = path.scope.getBinding(call.callee.name);
  if (!binding) return;
  if (approvals(ctx).get(binding.path.node) !== binding.referencePaths.length) return;

  const args: t.Expression[] = [];
  for (const argument of call.arguments) {
    // C1: a spread is refused, for the two reasons in the header.
    if (!t.isExpression(argument)) return;
    args.push(argument);
  }

  if (underEvalHost(path, evalHosts(ctx))) return;

  if (args.length === 0) {
    if (dropStatement(path, ctx)) recordRewrite(binding, ctx);
    return;
  }

  const replacement = args.length === 1 ? singleArgument(args[0]!, path) : t.sequenceExpression(args);
  t.inherits(replacement, call);
  // The call node is discarded whole, so its comments only exist on the
  // replacement; the arguments keep their own and are printed once.
  // Assigning rather than calling `replaceWith` is what lets `simplify.sequences`
  // - the next `ExpressionStatement` handler in this same traversal - see the
  // sequence and turn it into statements without a second round.
  path.node.expression = replacement;
  ctx.report('proxy-functions', 'argument-discarding wrapper', 0.95, 1);
  ctx.markChanged(args.length);
  recordRewrite(binding, ctx);
}

/**
 * A one-argument call becomes the argument itself rather than a one-operand
 * sequence, which does not exist in the grammar.
 *
 * The one hazard is a directive: `w('use strict');` would become
 * `'use strict';`, and at the top of a function body that switches the whole
 * function into strict mode. `void` keeps the statement inert.
 */
function singleArgument(argument: t.Expression, path: NodePath<t.ExpressionStatement>): t.Expression {
  const expression = path.get('expression');
  return wouldBecomeDirective(argument, expression)
    ? t.unaryExpression('void', argument)
    : argument;
}

/**
 * A call with no arguments does nothing at all: the callee read cannot throw
 * (B2) and the body computes nothing.
 */
function dropStatement(path: NodePath<t.ExpressionStatement>, ctx: PassContext): boolean {
  if (Array.isArray(path.container)) {
    if (!removeStatement(path)) return false;
  } else {
    // `if (c) w();` and `label: w();` have no statement list to shrink, and
    // removing the path there either throws or leaves a malformed parent.
    path.replaceWith(t.emptyStatement());
  }
  ctx.report('proxy-functions', 'argument-discarding wrapper', 0.95, 1);
  ctx.markChanged();
  return true;
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}
