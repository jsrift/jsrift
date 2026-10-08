import _traverse, { type Binding, type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts, type StringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import {
  blockFunctionHoisting,
  blockFunctionOutsideUse,
  countNodes,
  holdsDeclaredValue,
  insideWith,
  shadowedByBlockFunction,
  TreeOrder,
  type BlockFunctionMemo,
} from '../../util/ast.js';
import { isSideEffectFree } from '../../util/purity.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

type ProxyFunction = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;

/**
 * A function reduced to "substitute the arguments into this expression".
 *
 * Everything needed to judge a *particular* call site is precomputed, because
 * the same template is tested against every site and every test is about how
 * the arguments line up with the body.
 */
export interface InlineTemplate {
  params: readonly string[];
  /** The returned expression. Never mutated: each expansion rebuilds a copy. */
  body: t.Expression;
  /** Node count of `body`, compared against `functionUnwrapping.maxInlineSize`. */
  size: number;
  /** Parameters the body never mentions, whose arguments the expansion drops. */
  unused: ReadonlySet<string>;
  /** False when the body reads its parameters in an order other than declared. */
  inOrder: boolean;
  /**
   * Parameters appearing as a call or `new` callee. The wrapper invokes them
   * with no receiver; splicing `obj.method` into that slot silently supplies one.
   */
  callees: ReadonlySet<string>;
  /**
   * The body can skip an operand (`&&`, `||`, `?:`) that the call already
   * evaluated eagerly, so expansion is only sound when the arguments are pure.
   */
  lazy: boolean;
}

interface Candidate {
  name: string;
  binding: Binding;
  /** The `FunctionDeclaration` or `VariableDeclarator` that introduces the name. */
  declaration: NodePath;
  template: InlineTemplate;
  /** The references the analysis cleared for expansion: every one it could place after the declarator. */
  calls: NodePath[];
  /** Every reference the binding lists, cleared or not; only a fully expanded name loses its declaration. */
  total: number;
  inlined: number;
  /**
   * A reference the analysis never saw - created by an earlier pass after Babel
   * last crawled the scope. The expansion is still correct; deleting the
   * declaration would not be.
   */
  unexpected: boolean;
}

/**
 * Inline the forwarding functions obfuscators insert between a call and the
 * operation it stands for: `function _0x1(a, b) { return a + b; }` turned every
 * `x + y` in the program into `_0x1(x, y)`, and the fixture's storage objects
 * hold 1,300 more of the same shape.
 *
 * This is a `run` pass because approval is a whole-binding question - "is this
 * name *only* ever called?" cannot be answered from one call site - and because
 * expansion must happen bottom-up, so a proxy call nested inside another
 * proxy's arguments is finished before the enclosing one copies it.
 */
export const inlineProxyFunctionsPass: Pass = {
  id: 'simplify.proxy-functions',
  title: 'Inline proxy and wrapper functions',
  stage: 'simplify',
  technique: 'functionUnwrapping',
  run: (ctx) => {
    const { maxInlineSize, inlineSingleUse } = ctx.config.techniqueOptions.functionUnwrapping;
    // One traversal for the whole program rather than a question every binding
    // has to answer for itself - which is the reason this pass asked nothing
    // until now, and the reason the fact is shared instead of restated here.
    const facts = stringCodeFacts(ctx);
    // Per run, like `facts`: an expansion copies an expression into a call
    // site and never adds a declaration, so what each var scope hoists is fixed
    // for the length of the traversal.
    const blockFunctions: BlockFunctionMemo = new Map();
    // And the tree's order for the placing proof, numbered on the first
    // candidate that asks: an expansion moves arguments into a copy of the
    // body at the call site, never a statement past another.
    const order = new TreeOrder(ctx.ast);

    const candidates: Candidate[] = [];
    const byBinding = new Map<Binding, Candidate>();
    /** Call nodes cleared for expansion, and the callee identifiers behind them. */
    const approvedCalls = new WeakMap<t.CallExpression, Candidate>();
    const approvedRefs = new WeakSet<t.Node>();

    traverse(ctx.ast, {
      // A binding is always registered before anything that could reference it:
      // its scope owner is entered before the scope body is walked.
      Scopable(path) {
        if (path.scope.path !== path) return;
        if (ctx.isExhausted()) {
          path.stop();
          return;
        }
        for (const name of Object.keys(path.scope.bindings)) {
          const binding = path.scope.bindings[name];
          if (!binding) continue;
          const candidate = readCandidate(binding, maxInlineSize, inlineSingleUse, facts, blockFunctions, order);
          if (!candidate) continue;
          for (const reference of candidate.calls) {
            approvedRefs.add(reference.node);
            approvedCalls.set(reference.parent as t.CallExpression, candidate);
          }
          candidates.push(candidate);
          byBinding.set(binding, candidate);
        }
      },

      CallExpression: {
        // On exit, so an inner proxy call is already an expression by the time
        // the outer expansion copies it into place.
        exit(path: NodePath<t.CallExpression>) {
          const candidate = approvedCalls.get(path.node);
          if (!candidate) return;
          const expanded = expandCall(candidate.template, path.node, path.scope);
          if (!expanded) return;
          if (wouldBecomeDirective(expanded, path)) return;
          path.replaceWith(expanded);
          candidate.binding.dereference();
          candidate.inlined++;
          ctx.markChanged();
          if (ctx.isExhausted()) path.stop();
        },
      },
    });

    // Only a binding whose every known call was expanded can have its
    // declaration deleted, so that is the only place a missed reference would
    // do damage - and the only place worth looking for one.
    const removable = candidates.filter((c) => c.inlined > 0 && c.inlined === c.total);
    if (removable.length > 0) flagStaleReferences(removable, approvedRefs, byBinding);

    let inlined = 0;
    let removed = 0;
    for (const candidate of candidates) {
      inlined += candidate.inlined;
      if (candidate.inlined === 0) continue;
      if (candidate.unexpected || candidate.inlined !== candidate.total) continue;
      // A sloppy block-level declaration is also a var of the enclosing
      // function or script, and the search above walked only the block. Its
      // calls inside the block were expanded soundly - inside, the name is the
      // block binding - but `{ function bf() { return 'inner'; } log(bf()); }
      // try { log(bf()); } catch (e) {}` still calls `bf` through the var, and
      // deleting the declaration turned the second call into a ReferenceError.
      if (
        candidate.declaration.isFunctionDeclaration() &&
        blockFunctionOutsideUse(candidate.declaration)
      ) {
        continue;
      }
      if (removeDeclaration(candidate.declaration)) {
        removed++;
        ctx.markChanged();
      }
    }

    if (inlined > 0) {
      ctx.report('proxy-functions', 'single-return forwarding wrapper', 0.9, inlined);
      ctx.note('info', `Inlined ${inlined} proxy call(s); removed ${removed} wrapper(s).`);
    }
  },
};

/**
 * Pin down candidates that still carry a reference the analysis never saw.
 *
 * Babel's cached reference list can lag behind another pass's rewrites, so a
 * use of the name that was not approved has to keep the declaration alive.
 * Asking that question of every identifier in the program is the expensive way
 * to answer it: a visitor keyed on `Identifier` makes Babel build a `NodePath`
 * for every identifier node - 31% of the nodes in the 9.7 MB benchmark, and ones
 * it would otherwise skip outright, since an identifier has no children to
 * descend into. That single handler costs ~30% of this pass's runtime, to answer
 * a question that matters to a couple of dozen bindings.
 *
 * So it is deferred to those bindings. A reference can only appear inside the
 * scope that owns the binding, which makes the owning scope's subtree an exact
 * search space rather than a heuristic one, and candidates declared in the same
 * scope share one walk. In the worst case - every candidate declared at program
 * level - this is the one traversal it replaced; in the common case it is a
 * handful of function bodies, and when nothing was inlined it is nothing at all.
 *
 * Deferring it also means looking at the finished tree rather than at each node
 * as the expansion passes it. The only references the expansion itself removes
 * are the approved callees and arguments it dropped as provably side-effect
 * free, so the one behavioural difference is that an unseen reference inside
 * such a dropped argument no longer pins the declaration - correctly, because
 * by then it is not in the program either.
 */
function flagStaleReferences(
  removable: readonly Candidate[],
  approvedRefs: WeakSet<t.Node>,
  byBinding: ReadonlyMap<Binding, Candidate>,
): void {
  const byScope = new Map<NodePath, Set<string>>();
  for (const candidate of removable) {
    const owner = candidate.binding.scope.path;
    let names = byScope.get(owner);
    if (!names) byScope.set(owner, (names = new Set()));
    names.add(candidate.name);
  }

  // Fold a group into an outer group that already contains it, so the scopes
  // actually walked are disjoint. Without this, wrappers at two nesting levels
  // would walk the inner one twice and the total could exceed the single
  // program traversal this is meant to be cheaper than.
  const outermost = new Map<NodePath, Set<string>>();
  for (const [owner, names] of byScope) {
    let root = owner;
    for (let above = owner.parentPath; above; above = above.parentPath) {
      if (byScope.has(above)) root = above;
    }
    const group = outermost.get(root) ?? new Set<string>();
    for (const name of names) group.add(name);
    outermost.set(root, group);
  }

  for (const [owner, names] of outermost) {
    // An earlier expansion can have deleted the scope this binding lived in.
    if (owner.removed || !owner.node) continue;
    owner.traverse({
      ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
        const { name } = path.node;
        if (!names.has(name) || approvedRefs.has(path.node)) return;
        const candidate = byBinding.get(path.scope.getBinding(name) as Binding);
        if (candidate) candidate.unexpected = true;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function readCandidate(
  binding: Binding,
  maxInlineSize: number,
  inlineSingleUse: boolean,
  facts: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
): Candidate | undefined {
  switch (binding.kind) {
    case 'hoisted':
    case 'var':
    case 'let':
    case 'const':
      break;
    default:
      // `param` and `module` bindings are not declarations this pass may delete.
      return undefined;
  }
  // A reassigned name is not the function inspected here by the time it is called.
  if (isReassigned(binding)) return undefined;
  if (binding.referencePaths.length === 0) return undefined;

  // Code compiled from a string reaches this binding by its NAME, and does it
  // through neither list this analysis reads. `eval('w = function (a) { ... }')`
  // is a write `constantViolations` never records, so the template below would
  // describe a function the call site no longer holds; `Function('return w')`
  // and `setTimeout('w(1)', 0)` are reads `referencePaths` never records, so
  // `inlined === total` can be true with a live use of the name still in the
  // program and the declaration deleted out from under it.
  //
  // Both halves are one question - can string code address this name? - and
  // they are asked together because the answer disqualifies the same thing
  // either way: the value this pass resolves the name to.
  if (facts.addresses(binding)) return undefined;

  const declaration = binding.path;
  const fn = proxyFunctionOf(declaration);
  if (!fn) return undefined;
  // `if (x) function w() {}` is registered in the scope around the `if`, so a
  // call made before the `if` ran is on the reference list and reaches no
  // function; a second `function w` in the block is the list's, not this
  // one's. Neither list says what these call sites call.
  if (declaration.isFunctionDeclaration() && blockFunctionHoisting(declaration) === 'unknown') {
    return undefined;
  }

  const template = readTemplate(fn);
  if (!template) return undefined;

  const calls: NodePath[] = [];
  for (const reference of binding.referencePaths) {
    // Inside `with (o) { ... }` the callee is resolved against `o` first, so this
    // reference may never reach the proxy at all and expanding it would inline
    // the wrong body.
    if (insideWith(reference)) return undefined;
    // A sloppy `{ function w() {...} }` on the way from this call up to the
    // declaration assigns the var-scoped `w` when its block runs, and
    // `isReassigned` cannot see it: Babel scopes the block's declaration to
    // the block. `function a() { return 'outer'; } { function a() { return
    // 'inner'; } } log(a())` expanded to `log('outer')`; the program prints
    // `inner`. Per reference, because each call has its own chain of scopes.
    if (shadowedByBlockFunction(binding.identifier.name, reference.scope, binding, blockFunctions)) {
      return undefined;
    }
    const parent = reference.parentPath;
    // Anything other than a direct call reads the function *as a value*, and the
    // value is precisely what expansion destroys. `new f()`, `f?.()`, ``f`x` ``
    // and `[f]` all land here.
    if (!parent?.isCallExpression()) return undefined;
    if (parent.node.callee !== reference.node) return undefined;
    // A call from ahead of the declarator is a throw the program makes - a
    // `let` or `const` is in its dead zone, a `var` is still `undefined` -
    // and the expansion would print the value instead: `try { log(m(x)) }
    // catch (e) { log(e.name) } const m = (a) => a + 1` printed `4` where
    // the program prints `ReferenceError`. A hoisted `function` is callable
    // from entry and passes by kind. A call inside a hoisted function or a
    // callback is placed by ITS callers, and the predicate climbs to them; one
    // it cannot place is left as written, where it stays the throw it is, and
    // keeps the declaration for the calls that were expanded.
    if (
      !reference.isIdentifier() ||
      !holdsDeclaredValue(reference.node.name, reference.node, reference.scope, facts, order)
    ) {
      continue;
    }
    calls.push(reference);
  }
  if (calls.length === 0) return undefined;

  // `inlineSingleUse` waives the size limit exactly where expansion cannot grow
  // the program: with one call site the body moves rather than multiplies.
  const single = binding.referencePaths.length === 1;
  if (template.size > maxInlineSize && !(inlineSingleUse && single)) return undefined;

  return {
    name: binding.identifier.name,
    binding,
    declaration,
    template,
    calls,
    total: binding.referencePaths.length,
    inlined: 0,
    unexpected: false,
  };
}

/**
 * Whether anything ever assigns to this name after it is declared.
 *
 * Not the same question as `binding.constant`. Babel records a `var` or function
 * declaration that sits inside a loop as a constant violation *of itself*,
 * because its initialiser re-runs on every iteration. That is not a
 * reassignment: it re-installs the declaration this analysis already inspected,
 * so the binding still only ever holds that value. The distinction is load
 * bearing - every control-flow storage object in the 4 MB fixture is declared
 * inside `while (true) { switch ... }`, and treating the loop as a reassignment
 * refuses all 150 of them.
 */
export function isReassigned(binding: Binding): boolean {
  return binding.constantViolations.some((violation) => violation.node !== binding.path.node);
}

function proxyFunctionOf(declaration: NodePath): ProxyFunction | undefined {
  if (declaration.isFunctionDeclaration()) return declaration.node;
  if (!declaration.isVariableDeclarator() || !t.isIdentifier(declaration.node.id)) return undefined;
  const init = declaration.node.init;
  if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) return init;
  return undefined;
}

/**
 * Read a function as a substitution template, or refuse.
 *
 * Exported because an object alias map's function-valued entries are exactly
 * the same shape, reached through a property instead of a binding.
 */
export function readTemplate(fn: ProxyFunction): InlineTemplate | undefined {
  if (fn.async || fn.generator) return undefined;

  const params: string[] = [];
  for (const param of fn.params) {
    // Rest, default and destructuring parameters all compute something at call
    // time that no substitution reproduces.
    if (!t.isIdentifier(param)) return undefined;
    // `function (a, a) {}` is legal in sloppy mode and the second wins.
    if (params.includes(param.name)) return undefined;
    params.push(param.name);
  }

  const body = returnedExpression(fn);
  if (!body) return undefined;

  const scan: Scan = { order: [], counts: new Map(), callees: new Set(), lazy: false };
  if (!scanBody(body, new Set(params), scan)) return undefined;
  // A parameter read twice would duplicate its argument, and with it whatever
  // that argument does.
  for (const count of scan.counts.values()) if (count > 1) return undefined;

  let previous = -1;
  let inOrder = true;
  for (const name of scan.order) {
    const index = params.indexOf(name);
    if (index < previous) {
      inOrder = false;
      break;
    }
    previous = index;
  }

  return {
    params,
    body,
    size: countNodes(body),
    unused: new Set(params.filter((name) => !scan.counts.has(name))),
    inOrder,
    callees: scan.callees,
    lazy: scan.lazy,
  };
}

/** The single expression a one-line function returns, if that is all it does. */
function returnedExpression(fn: ProxyFunction): t.Expression | undefined {
  if (!t.isBlockStatement(fn.body)) return fn.body;
  if (fn.body.body.length !== 1) return undefined;
  const [only] = fn.body.body;
  if (!t.isReturnStatement(only) || !only.argument) return undefined;
  return only.argument;
}

interface Scan {
  /** Parameter reads in evaluation order, which is how argument order is checked. */
  order: string[];
  counts: Map<string, number>;
  callees: Set<string>;
  lazy: boolean;
}

/**
 * Validate the body against a whitelist and record how it uses its parameters.
 *
 * The whitelist is the safety mechanism: `this`, `arguments`, `await`, nested
 * functions, template literals and free variables are all rejected simply by
 * not appearing, so a shape nobody anticipated fails closed.
 */
function scanBody(node: t.Node, params: ReadonlySet<string>, scan: Scan): boolean {
  switch (node.type) {
    case 'Identifier': {
      // A free identifier would have to resolve to the same thing at every call
      // site; proving that is a different and much larger analysis.
      if (!params.has(node.name)) return false;
      scan.order.push(node.name);
      scan.counts.set(node.name, (scan.counts.get(node.name) ?? 0) + 1);
      return true;
    }

    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
      return true;

    case 'UnaryExpression':
      // `delete a` needs a reference rather than a value, so substituting into
      // it changes what gets deleted.
      if (node.operator === 'delete') return false;
      return scanBody(node.argument, params, scan);

    case 'BinaryExpression':
      if (t.isPrivateName(node.left)) return false;
      return scanBody(node.left, params, scan) && scanBody(node.right, params, scan);

    case 'LogicalExpression':
      scan.lazy = true;
      return scanBody(node.left, params, scan) && scanBody(node.right, params, scan);

    case 'ConditionalExpression':
      scan.lazy = true;
      return (
        scanBody(node.test, params, scan) &&
        scanBody(node.consequent, params, scan) &&
        scanBody(node.alternate, params, scan)
      );

    case 'MemberExpression':
      if (!scanBody(node.object, params, scan)) return false;
      if (node.computed) return scanBody(node.property, params, scan);
      // A static key is a name, not a read of a parameter.
      return t.isIdentifier(node.property);

    case 'CallExpression':
    case 'NewExpression': {
      const callee = node.callee;
      if (!t.isExpression(callee)) return false;
      if (t.isIdentifier(callee) && params.has(callee.name)) scan.callees.add(callee.name);
      if (!scanBody(callee, params, scan)) return false;
      for (const argument of node.arguments) {
        // A spread reads an iterator, which is observable and not substitutable.
        if (!t.isExpression(argument)) return false;
        if (!scanBody(argument, params, scan)) return false;
      }
      return true;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * β-reduce one call against a template, or refuse.
 *
 * Exported for the object-map pass, whose `_0xmap.key(a, b)` sites reduce
 * identically once the key has been resolved to its wrapper.
 *
 * There is no string-code refusal here, and that is not an omission. The hazard
 * `analysis/string-code.ts` answers is about the *binding* a name resolves to,
 * and a call node plus a scope does not name one: the callee's binding is what
 * both callers hold and neither passes. So the refusal lives at their approval
 * step - `readCandidate` above, `collectReads` in `object-maps.ts` - and this
 * function only refuses what it can see from here.
 */
export function expandCall(
  template: InlineTemplate,
  call: t.CallExpression,
  scope: Scope,
): t.Expression | undefined {
  // Inside `with (o) { ... }` a name is looked up on `o` first, at run time. What
  // that breaks here is the expansion itself, not the purity test: the template
  // body is SPLICED INTO the call site, so every name in it that was not a
  // parameter stops resolving where it was written and starts resolving on `o`.
  // No oracle over the arguments can see that - the hazard is in the body being
  // moved - which is why the refusal is a statement about the call site.
  //
  // Both of today's callers already refuse before this point, on the reference's
  // own path (`readCandidate` here, `collectReads` in `object-maps.ts`), so
  // this is the refusal restated where the expansion actually happens rather
  // than a hole either of them leaves. It is also weaker than theirs: `scope` is
  // the nearest enclosing scope, which is the `with` body itself only when that
  // body is a block, so a braceless `with (o) f(x);` is caught by them and not
  // by this line.
  if (insideWith(scope.path)) return undefined;

  const args: t.Expression[] = [];
  for (const argument of call.arguments) {
    // A spread makes the argument-to-parameter mapping unknowable.
    if (!t.isExpression(argument)) return undefined;
    args.push(argument);
  }

  // Reordering an argument, or making one conditional, is only invisible when
  // evaluating it is invisible too.
  const requirePure = !template.inOrder || template.lazy;

  const substitutions = new Map<string, t.Expression>();
  for (let index = 0; index < template.params.length; index++) {
    const name = template.params[index]!;
    const argument = args[index];

    if (template.unused.has(name)) {
      // The expansion drops this argument, so it must have nothing to lose.
      if (argument && !isSideEffectFree(argument, scope)) return undefined;
      continue;
    }
    // Fewer arguments than parameters: the body reads `undefined`, and writing
    // that out is a guess about intent this pass refuses to make.
    if (!argument) return undefined;
    if (requirePure && !isSideEffectFree(argument, scope)) return undefined;
    // `function f(a, b) { return a(b); }` called as `f(obj.m, x)`: the wrapper
    // invoked `m` with no receiver, whereas `obj.m(x)` passes `obj`.
    if (template.callees.has(name) && isMemberLike(argument)) return undefined;
    // The same slot, and the one argument whose meaning depends on the syntax
    // around it rather than on its value. In `f(eval, s)` the wrapper's `a(b)`
    // is an INDIRECT eval - the callee is not spelled `eval`, so the source
    // compiles in global scope. Substituted in, `eval(s)` is the direct form and
    // reads the caller's locals. Expanding here would therefore also create a
    // hazard the shared string-code fact has already been computed without.
    if (template.callees.has(name) && t.isIdentifier(argument, { name: 'eval' })) return undefined;
    substitutions.set(name, argument);
  }

  // Surplus arguments are evaluated by the call and dropped by the expansion.
  for (let index = template.params.length; index < args.length; index++) {
    if (!isSideEffectFree(args[index]!, scope)) return undefined;
  }

  return t.inherits(substitute(template.body, substitutions), call);
}

function isMemberLike(node: t.Expression): boolean {
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

/**
 * Directives that mean something. `'use strict'` is the only one in the
 * language; `'use asm'` is an engine hint, included because it costs nothing.
 * Every other lone string statement is inert whether it is a directive or not.
 */
const SEMANTIC_DIRECTIVES = new Set(['use strict', 'use asm']);

/**
 * Whether splicing this expression into the call's place would create a
 * directive that changes what the surrounding code means.
 *
 * `w('use strict');` is a discarded call. `'use strict';` in the same position
 * is a directive prologue entry, and at the top of a function body it switches
 * that function into strict mode - assignments to undeclared names start
 * throwing, `this` stops being coerced and `arguments` stops aliasing the
 * parameters. Leaving the call unexpanded is the only rewrite that is not a
 * behaviour change.
 *
 * The check is on the *value* rather than on the position, because a statement
 * that is second in a body today is first once dead-code removal deletes the
 * one above it, and a later pass has no way to know a literal used to be a call.
 *
 * Exported for the object-map and string-inlining passes, whose literal
 * replacements reach an expression statement by exactly the same route.
 */
export function wouldBecomeDirective(replacement: t.Expression, path: NodePath): boolean {
  if (!t.isStringLiteral(replacement) || !SEMANTIC_DIRECTIVES.has(replacement.value)) return false;
  return Boolean(path.parentPath?.isExpressionStatement());
}

/** The value-side of {@link wouldBecomeDirective}, for callers holding a string. */
export function isSemanticDirective(value: string): boolean {
  return SEMANTIC_DIRECTIVES.has(value);
}

/**
 * Rebuild the template with arguments in place of parameters.
 *
 * Rebuilding from AST builders rather than splicing text is what keeps
 * precedence correct: inlining `a + b` into `2 * f(x, y)` yields a
 * `BinaryExpression` inside a `BinaryExpression`, and parenthesising it is the
 * generator's job rather than this pass's.
 *
 * The template is copied because it is expanded once per call site; the
 * arguments are *moved* rather than copied, because each is used at most once
 * and because a copy would strand every binding whose reference list points at
 * the original node - the next pass would then no longer see its own call sites.
 */
function substitute(node: t.Expression, args: ReadonlyMap<string, t.Expression>): t.Expression {
  switch (node.type) {
    case 'Identifier':
      return args.get(node.name) ?? t.cloneNode(node, true);

    case 'UnaryExpression':
      return t.unaryExpression(node.operator, substitute(node.argument, args), node.prefix);

    case 'BinaryExpression':
      return t.binaryExpression(
        node.operator,
        substitute(node.left as t.Expression, args),
        substitute(node.right, args),
      );

    case 'LogicalExpression':
      return t.logicalExpression(
        node.operator,
        substitute(node.left, args),
        substitute(node.right, args),
      );

    case 'ConditionalExpression':
      return t.conditionalExpression(
        substitute(node.test, args),
        substitute(node.consequent, args),
        substitute(node.alternate, args),
      );

    case 'MemberExpression': {
      const property = node.computed
        ? substitute(node.property as t.Expression, args)
        : t.cloneNode(node.property, true);
      return t.memberExpression(
        substitute(node.object as t.Expression, args),
        property,
        node.computed,
      );
    }

    case 'CallExpression':
      return t.callExpression(
        substitute(node.callee as t.Expression, args),
        node.arguments.map((argument) => substitute(argument as t.Expression, args)),
      );

    case 'NewExpression':
      return t.newExpression(
        substitute(node.callee as t.Expression, args),
        node.arguments.map((argument) => substitute(argument as t.Expression, args)),
      );

    default:
      // Unreachable for a scanned body; cloning keeps it honest if it is not.
      return t.cloneNode(node, true);
  }
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Delete a declaration whose every use has been expanded away.
 *
 * Exported so the object-map pass can retire its own alias declarators with the
 * same rules about `for` heads and multi-declarator statements.
 */
export function removeDeclaration(path: NodePath): boolean {
  if (path.removed || !path.node) return false;
  if (isExported(path)) return false;

  if (path.isVariableDeclarator()) {
    const declaration = path.parentPath;
    if (!declaration.isVariableDeclaration()) return false;
    // `for (var f = ...;;)` and `for (var f in o)` own their declaration; removing
    // it would leave the loop head malformed.
    const owner = declaration.parentPath;
    if (owner.isForStatement() || owner.isForXStatement()) return false;
    if (declaration.node.declarations.length > 1) {
      path.remove();
      return true;
    }
    return removeStatement(declaration);
  }

  return removeStatement(path);
}

/**
 * Remove a statement, handing any comment above it to the statement below.
 *
 * A comment describes the code that follows it, so dropping it with the
 * statement would silently delete something a human wrote about code that is
 * still there.
 */
export function removeStatement(path: NodePath): boolean {
  // A bare `if (x) function f() {}` has no statement list to shrink.
  if (!Array.isArray(path.container)) return false;
  if (path.node.leadingComments?.length) {
    const next = path.getSibling((path.key as number) + 1);
    if (next.node) t.inheritLeadingComments(next.node, path.node);
  }
  path.remove();
  return true;
}

function isExported(path: NodePath): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  if (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) return true;
  return Boolean(parent.parentPath?.isExportNamedDeclaration());
}
