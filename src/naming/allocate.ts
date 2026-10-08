import type { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { invocation, isMember, pickedByLiteral, propertyKey } from '../analysis/evaluator/callee.js';
import { isReadableName, looksGeneratedName, stripTypeWrappers } from '../util/ast.js';
import {
  compareStrings,
  isGlobalObjectPropertyName,
  isReservedName,
  type NameKind,
  type Tier,
} from './dictionary.js';
import type { NameCandidate } from './evidence.js';

export interface RankedName {
  name: string;
  kind: NameKind;
  /** Best (lowest) tier among the candidates that produced this name. */
  tier: Tier;
  /** Noisy-OR combination of every candidate for this name, 0..1. */
  combined: number;
  maxSingle: number;
  minRuleId: string;
  minAnchor: number;
  reason: string;
}

/** Repeat firings of the same rule are damped so one weak rule cannot outvote a strong one. */
const REPEAT_WEIGHT = 0.25;

/**
 * Collapse a binding's candidates into a ranked, deduplicated name list.
 *
 * Both comparators are total orders over values that never depend on hash or
 * insertion order, which is what makes the whole layer reproducible. String
 * comparison goes through `compareStrings` rather than `localeCompare` for the
 * same reason: collation is a property of the machine, not of the input.
 */
export function rankCandidates(candidates: readonly NameCandidate[]): RankedName[] {
  const groups = new Map<string, NameCandidate[]>();
  for (const candidate of candidates) {
    const bucket = groups.get(candidate.name);
    if (bucket) bucket.push(candidate);
    else groups.set(candidate.name, [candidate]);
  }

  const ranked: RankedName[] = [];
  for (const [name, items] of groups) {
    const ordered = [...items].sort(
      (a, b) =>
        compareStrings(a.ruleId, b.ruleId) ||
        a.anchor - b.anchor ||
        b.confidence - a.confidence ||
        a.hops - b.hops,
    );
    const firings = new Map<string, number>();
    let product = 1;
    let maxSingle = 0;
    let tier: Tier = 3;
    let minRuleId = ordered[0]!.ruleId;
    let minAnchor = ordered[0]!.anchor;
    let best = ordered[0]!;

    for (const candidate of ordered) {
      const seen = firings.get(candidate.ruleId) ?? 0;
      firings.set(candidate.ruleId, seen + 1);
      const weight = seen === 0 ? 1 : REPEAT_WEIGHT;
      product *= 1 - weight * candidate.confidence;
      if (candidate.confidence > maxSingle) {
        maxSingle = candidate.confidence;
        best = candidate;
      }
      if (candidate.tier < tier) tier = candidate.tier;
      if (candidate.ruleId < minRuleId) minRuleId = candidate.ruleId;
      if (candidate.anchor < minAnchor) minAnchor = candidate.anchor;
    }

    ranked.push({
      name,
      kind: best.kind,
      tier,
      combined: 1 - product,
      maxSingle,
      minRuleId,
      minAnchor,
      reason: `${best.ruleId}: ${best.reason}`,
    });
  }

  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.combined - a.combined ||
      b.maxSingle - a.maxSingle ||
      compareStrings(a.minRuleId, b.minRuleId) ||
      a.minAnchor - b.minAnchor ||
      compareStrings(a.name, b.name),
  );
  return ranked;
}

/**
 * §5.3: tiers 0-2 clear a low bar; a tier-3 guess has to be much stronger.
 *
 * Note what the `Math.max` means for a caller that asks for *less*: the floors
 * are minima, so a `minConfidence` below 0.35 buys nothing. The aggressive
 * preset's 0.3 is therefore exactly 0.35 - measurably so: 0.0, 0.3 and 0.35 all
 * produce byte-identical output on every fixture. Whether that preset should be
 * able to reach lower is a question about `config/presets.ts` and these two
 * constants together, not something to fix by loosening one of them here.
 */
export function meetsThreshold(ranked: RankedName, minConfidence: number): boolean {
  const floor = ranked.tier === 3 ? Math.max(0.55, minConfidence) : Math.max(0.35, minConfidence);
  return ranked.combined >= floor;
}

// ---------------------------------------------------------------------------
// Freeze analysis
// ---------------------------------------------------------------------------

export type FreezeHazard = 'lexical' | 'global' | null;

/**
 * Scopes where renaming is unsound because a name can be reached by string.
 *
 * A direct `eval` sees every binding visible at its call site, so the whole
 * scope chain above it is unsafe, and code it introduces can shadow anything
 * below it, so its descendants are unsafe too. That is `'lexical'`.
 *
 * `Function(src)`, indirect `eval` and `setTimeout('src')` compile their source
 * in *global* scope, so they see no local binding - but "global scope" is not
 * only the host's own names. In a script the program-scope `var`s and function
 * declarations are properties of the global object, and the program-scope
 * `let`/`const`/`class` are the global lexical environment; string code reads
 * all of them by name. `'global'` therefore freezes program scope, and only
 * program scope. (In a *module* nothing at program scope is reachable that way,
 * so the freeze is pure over-approximation there; `ScopeFreezer` is not told
 * which it is, and refusing costs coverage where guessing would cost soundness.)
 */
export class ScopeFreezer {
  /** Scopes whose own bindings are visible at a hazard site. */
  private readonly visible = new Set<number>();
  /** Hazard scopes: everything nested inside one is unsafe too. */
  private readonly roots = new Set<number>();
  private globalOnly = false;

  addHazard(scope: Scope, kind: Exclude<FreezeHazard, null>): void {
    if (kind === 'global') {
      this.globalOnly = true;
      return;
    }
    this.roots.add(scope.uid);
    let current: Scope | undefined = scope;
    while (current) {
      this.visible.add(current.uid);
      current = current.parent;
    }
  }

  /**
   * Whether nothing was frozen at all.
   *
   * `globalOnly` counts: it is the only record a `'global'` hazard leaves, and
   * the caller turns this into the "some scopes were left unrenamed" warning.
   * Reading `roots` alone reported a whole frozen program scope as untouched.
   */
  get empty(): boolean {
    return this.roots.size === 0 && !this.globalOnly;
  }

  isFrozen(scope: Scope): boolean {
    if (this.globalOnly && !scope.parent) return true;
    // The scope's own bindings are in view at the hazard site ...
    if (this.visible.has(scope.uid)) return true;
    // ... or the scope is nested inside the hazard, where injected code can shadow.
    let current: Scope | undefined = scope;
    while (current) {
      if (this.roots.has(current.uid)) return true;
      current = current.parent;
    }
    return false;
  }
}

/**
 * Classify the constructs that make names reachable by string.
 *
 * Only a *direct* `eval(...)` - that exact spelling - is lexical. Every other
 * construct here compiles in global scope and so returns `'global'`, which
 * freezes program scope; see `ScopeFreezer` for why that is not a no-op. The
 * earlier reading, that `Function('return x')` pins "only the global names,
 * which are never renamed anyway", was wrong in both halves: the string names a
 * program-scope binding, and program-scope bindings are renamed routinely.
 *
 * The receiver is deliberately not proved: `x.Function(s)` and `x.setTimeout(s)`
 * are classified as the global ones without checking that `x` is the global
 * object. A freeze that fires when it need not costs coverage on one file; a
 * hazard that is missed renames a binding that string code still addresses by
 * its old name, which is the failure that produces working, wrong output.
 *
 * `eval?.(src)` is NOT direct, and the difference is not a judgement call. The
 * direct-eval branch exists only in the runtime semantics of
 * `CallExpression : CoverCallExpressionAndAsyncArrowHead`; `OptionalChain :
 * ?. Arguments` goes straight to EvaluateCall and never reaches it. Measured on
 * node 24: `function f() { var x = 41; return eval?.('x + 1'); }` throws
 * `x is not defined`, and `eval.call(null, 'x + 1')` throws the same. Both are
 * `'global'`. Calling them `'lexical'` would not be "safely conservative" - it
 * would freeze local scopes on a claim about the language that is false.
 *
 * `.constructor` in callee position is the widest rule here and it is also the
 * one the classifier could not be asked about at all before, because an
 * optional call is not a `CallExpression`. `(function(){}).constructor` IS
 * `Function`; `[].constructor.constructor` is `Function` two hops from an array
 * literal; an obfuscator writes the second as `[]["constructor"]["constructor"]`
 * and property normalisation turns that into the dot form matched here. The
 * receiver is not proved for it either, so `new node.constructor()` - the
 * ordinary cloning idiom - freezes program scope on a file with no string code
 * in it. That is the cost, stated because it is real: what is measured is only
 * that no callee-position `.constructor` occurs in any of the five fixture
 * inputs, so on those the rule buys the shapes above and changes no output.
 *
 * The routes a call can take to its callee are the ones
 * `analysis/evaluator/callee.ts`'s `invocation` sees through, and no other
 * list: `f.call(thisArg, ...)`, `f.apply(thisArg, [ ... ])`, the call of an
 * `f.bind(...)` result, `Function.prototype.call.call(f, ...)`, a sequence, an
 * `await`, each arm of a conditional or a logical, and - through
 * `pickedByLiteral` - a literal in callee position, `[f][0]`, `({ F: f }).F`.
 * `Reflect.apply(f, ...)` and `Reflect.construct(f, ...)` are read here, since the
 * receiver is not proved for them either. Every route hands on the argument
 * list the target actually receives, so the timer arm still reads the body it
 * would have read and `Function.prototype.constructor.call(null, src)`
 * resolves to `Function(src)`. A route never lands in a direct position, which
 * is why `eval.call(null, s)` and `(0, eval)(s)` come out `'global'` and not
 * `'lexical'`; `new` stays `new` through a route - a bound function's
 * [[Construct]] is its target's, and a sequence is only its last operand - so
 * `eval` reached that way is correctly not a hazard at all. A vector a route
 * cannot reconstruct - a spread, or an `.apply` list that is not an array
 * literal - keeps the hazard and reports no source, which is the blunt answer
 * rather than the empty one: `eval.apply(null, argv)` compiles whatever `argv`
 * holds. Arms that classify differently - `(c ? eval : Function)(s)` - are the
 * same blunt answer, since which source is compiled is not known.
 *
 * One residue, needing a value flow rather than a shape: `var e = eval; e(src)`,
 * caught instead by `recordFreeIdentifier`, the only place `eval` in a
 * non-callee position is visible.
 *
 * The timers are graded on their first argument in three steps. A readable
 * string - a literal, or `s` declared once, never reassigned, initialised with
 * one or with another such `s`, see {@link readStaticString} - is a source
 * this analysis holds, so the hazard names the bindings that text names. A
 * string it cannot read but can prove the argument MAY be
 * ({@link buildsAString}: a `+`, a template, a conditional or a logical with
 * such an arm, a sequence ending in one, an assignment storing one, or up to
 * {@link MAX_ALIAS_HOPS} hops to any of those through a name's initialisers
 * and writes) is the hazard with NO source, because `var s = 'log(' + f() +
 * ')'; setTimeout(s, 0)` renamed the program-scope bindings that text
 * addresses and the output threw where the input ran. Everything else is a
 * callback as far as anything here can tell and is not a hazard -
 * deliberately, and the cost of the alternative is measured on
 * `buildsAString`.
 */
export function freezeHazardKind(path: NodePath): FreezeHazard {
  return freezeHazardSite(path)?.kind ?? null;
}

/**
 * The hazard, plus the arguments it compiles and how it compiles them.
 *
 * `analysis/string-code.ts` needs the second half to answer the *narrower*
 * question - which names the compiled source can address, rather than merely
 * that some source exists - and it must not restate the shape rules to get it.
 * Everything about which argument holds the code lives in `classifyCallee`,
 * beside the rule that recognised the callee: `eval` and the timers compile
 * their first argument as a whole program, and `Function`/`.constructor`
 * compile *all* of theirs, the last as a body and the ones before it as the
 * parameter list - which is code too, because a parameter default can reference
 * an outer name.
 */
export function freezeHazardSite(path: NodePath): FreezeHazardSite | null {
  // Reached only through the exported symbol: `analyzeProgram` visits
  // `WithStatement` itself. Kept so the classifier is complete on its own.
  if (path.isWithStatement()) return { kind: 'lexical' };
  const scope = path.scope;
  if (path.isCallExpression()) {
    return classifyCallee(path.node.callee, path.node.arguments, 'call', scope);
  }
  if (path.isNewExpression()) {
    return classifyCallee(path.node.callee, path.node.arguments, 'new', scope);
  }
  if (path.isOptionalCallExpression()) {
    return classifyCallee(path.node.callee, path.node.arguments, 'indirect', scope);
  }
  return null;
}

/** A classified hazard together with the arguments that become code. */
export interface FreezeHazardSite {
  kind: Exclude<FreezeHazard, null>;
  /**
   * How {@link code} is compiled: `'program'` for the one argument `eval` and
   * the timers take, `'function'` for the parameter-list-then-body argument
   * vector of `Function`. Absent when the shape names no argument at all, which
   * is `with` and nothing else.
   */
  shape?: 'program' | 'function';
  /** The argument nodes that become code, in the order the shape reads them. */
  code?: readonly t.Node[];
}

/**
 * How the callee was reached, which is the whole of what separates the two
 * hazards for `eval`.
 *
 * `'call'` is the one spelling that can be direct. `'new'` is a position where
 * `eval` is not a hazard at all - `eval` is not a constructor, so `new eval(s)`
 * throws before it compiles anything. `'indirect'` covers an optional call and
 * anything reached through `.call`/`.apply`.
 */
type CalleePosition = 'call' | 'new' | 'indirect';

function classifyCallee(
  callee: t.Node,
  args: readonly t.Node[],
  position: CalleePosition,
  scope: Scope,
): FreezeHazardSite | null {
  const spelled = stripTypeWrappers(callee);
  // A direct `eval` reports no source: the lexical arm freezes SCOPES, and
  // narrowing it by name would need a per-scope name set nothing asks for.
  if (position === 'call' && t.isIdentifier(spelled, { name: 'eval' })) return { kind: 'lexical' };

  const reflected = reflectRoute(spelled, args);
  if (reflected) {
    return inexactly(classifyCallee(reflected.callee, reflected.args, reflected.position, scope), reflected.exact);
  }

  const routed = routedCall(spelled, args);
  if (!routed) return null;
  const arrived: CalleePosition = position === 'new' ? 'new' : 'indirect';
  const sites: FreezeHazardSite[] = [];
  for (const arm of routed.fns) {
    const target = pickedByLiteral(arm);
    const site = target ? classifySpelled(target, routed.args, arrived, scope) : null;
    if (site) sites.push(site);
  }
  const [first] = sites;
  if (!first) return null;
  const agreed = sites.every(
    (site) =>
      site.kind === first.kind &&
      site.shape === first.shape &&
      site.code?.length === first.code?.length &&
      (site.code ?? []).every((node, index) => node === first.code?.[index]),
  );
  return inexactly(agreed ? first : { kind: first.kind }, routed.exact);
}

/** The rules, asked of a callee as spelled once every route to it is seen through. */
function classifySpelled(
  target: t.Node,
  args: readonly t.Node[],
  position: CalleePosition,
  scope: Scope,
): FreezeHazardSite | null {
  const bare = t.isIdentifier(target) ? target.name : undefined;
  const program = { shape: 'program', code: args.slice(0, 1) } as const;

  // `window.eval(s)`, `(0, eval)(s)`, `eval.call(null, s)`: indirect eval, global, not lexical.
  if (bare === 'eval' || isNamedMember(target, 'eval')) {
    return position === 'new' ? null : { kind: 'global', ...program };
  }
  if (bare === 'Function' || isNamedMember(target, 'Function') || isNamedMember(target, 'constructor')) {
    return { kind: 'global', shape: 'function', code: args };
  }

  const timer =
    bare === 'setTimeout' ||
    bare === 'setInterval' ||
    isNamedMember(target, 'setTimeout') ||
    isNamedMember(target, 'setInterval');
  if (timer) {
    if (readStaticString(args[0], scope) !== undefined) return { kind: 'global', ...program };
    // Unreadable, but the shape can still prove this may not be a callback, and
    // then it is a program compiled in global scope whose text nothing here
    // has: the hazard with no source, rather than the empty name set an
    // unwritten source would otherwise reduce to.
    return buildsAString(args[0], scope) ? { kind: 'global' } : null;
  }

  return null;
}

/**
 * A site reached through a vector this analysis could not reconstruct is a
 * source it cannot read: the hazard stays, the claim about what the text says
 * goes. `analysis/string-code.ts` reads a site with no `code` as the blunt
 * "every program-scope name", the only safe answer for a vector that may hold
 * anything.
 */
function inexactly(site: FreezeHazardSite | null, exact: boolean): FreezeHazardSite | null {
  return !site || exact ? site : { kind: site.kind };
}

/**
 * Whether this argument can evaluate to a string the analysis cannot read,
 * proved from shape alone.
 *
 * `+` yields a string, a number or a bigint and never a function, so
 * `setTimeout('log(' + name + ')', 0)` is code even though its text is not
 * there to read; a template literal is always a string. A conditional or a
 * logical is whichever arm runs, so it can be a string as soon as one arm is
 * one - `_0x88 || '_0x4a2b()'` and `_0x77 > 2 ? 'other()' : '_0x4a2b()'` both
 * put the code in the file as a literal and were still read as callbacks,
 * because the arm was never looked at. A sequence is its last operand and an
 * assignment is what it stored, so `(_0x77, '_0x4a2b()')` and `_0x88 =
 * '_0x4a2b()'` are the literal too; `s += x` is `s + x` whatever `x` is.
 *
 * A name is followed into every place the file stores a value under it: each
 * of its declarators, a parameter's default, and every write to the name
 * itself. The value at the call is any one of those, so ONE that builds a
 * string is what proves "may be": requiring every site to would leave `var s
 * = cb; if (c) s = 'log(' + x + ')'` renamed, and that is the missed-hazard
 * direction. Three shapes each cost a thrown output before the arm read them
 * all. `var s; if (c) s = '_0x4a2b()'; setTimeout(s, 0)` is the literal one
 * statement after the declarator, and `binding.constant` alone read it as a
 * callback. `var s; var s = '_0x4a2b()'` stores it in a SECOND declarator,
 * which Babel files under `constantViolations` as a `VariableDeclarator` and
 * not as an assignment, so a test for assignments alone never saw it - and
 * `binding.path` is the first declarator, the one with no initialiser. And
 * `function f(s) { s = '_0x4a2b()'; setTimeout(s, 0) }` writes a PARAMETER,
 * whose `binding.path` is the parameter itself and not a declarator, so a
 * declarator test refused to read its writes at all. A write through a
 * pattern stores a piece of its right side, not the right side, so only a
 * write to the bare name is graded; the same holds of a parameter default
 * inside a pattern, whose `binding.path` is the whole pattern.
 *
 * Each of those sites is followed with {@link MAX_ALIAS_HOPS} as the bound
 * {@link readStaticString} uses, for the same reason it uses one: `var a =
 * 'log(' + x + ')'; var s = a; setTimeout(s, 0)` is the concatenation two
 * names away, and one hop read it as a callback.
 *
 * Deliberately not proving the other direction. Asking "is this a function?"
 * and freezing on every answer of no takes in every parameter, and a
 * `requestAnimationFrame` polyfill is `function (callback) { return
 * setTimeout(callback, ...) }` - measured on the 4.1 MB `obfuscated2.js` at
 * 'balanced': 757 901 bytes fully decoded becomes 2 474 515 with the rc4
 * string array, its decoder and its rotation wrapper left in place, because a
 * global hazard with no source is exactly what tells the strings passes they
 * cannot prove which table the program reads. Excusing an unbound identifier
 * does not buy that back; the polyfill's argument is bound. So the residue
 * stays open and is the same one `readStaticString` leaves: a parameter's
 * argument, a call result, a member read, a value out of a decoded array, a
 * `for (s in o)` key, and a chain longer than the bound, all read as no
 * hazard. `setTimeout(_0xarr[0], 0)` is the member read: a callback array is
 * ordinary code, and nothing about the read says the element is not a
 * function.
 */
function buildsAString(node: t.Node | undefined, scope?: Scope, hops = MAX_ALIAS_HOPS): boolean {
  if (!node) return false;
  if (t.isStringLiteral(node) || t.isTemplateLiteral(node)) return true;
  if (t.isBinaryExpression(node) && node.operator === '+') return true;
  if (t.isConditionalExpression(node)) {
    return (
      buildsAString(node.consequent, scope, hops) || buildsAString(node.alternate, scope, hops)
    );
  }
  if (t.isLogicalExpression(node)) {
    return buildsAString(node.left, scope, hops) || buildsAString(node.right, scope, hops);
  }
  if (t.isSequenceExpression(node)) {
    return buildsAString(node.expressions[node.expressions.length - 1], scope, hops);
  }
  if (t.isAssignmentExpression(node)) return assignsAString(node, scope, hops);
  if (t.isIdentifier(node) && scope && hops > 0) {
    const binding = scope.getBinding(node.name);
    if (!binding) return false;
    // Each site is read in its own scope, where the value's names resolve.
    for (const site of [binding.path, ...binding.constantViolations]) {
      if (site.isVariableDeclarator()) {
        if (buildsAString(site.node.init ?? undefined, site.scope, hops - 1)) return true;
      } else if (site.isAssignmentPattern() && t.isIdentifier(site.node.left)) {
        if (buildsAString(site.node.right, site.scope, hops - 1)) return true;
      } else if (site.isAssignmentExpression() && t.isIdentifier(site.node.left)) {
        if (assignsAString(site.node, site.scope, hops - 1)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether an assignment's own value can be a string, by operator.
 *
 * `=` is its right side. `+=` is a `+` and gets the `+` answer whatever the
 * operands are. `||=`, `&&=` and `??=` are the logical expression they abbreviate
 * and take either side. The arithmetic and bitwise compounds yield numbers or
 * bigints and never a string, so they name nothing.
 */
function assignsAString(node: t.AssignmentExpression, scope?: Scope, hops?: number): boolean {
  switch (node.operator) {
    case '=':
      return buildsAString(node.right, scope, hops);
    case '+=':
      return true;
    case '||=':
    case '&&=':
    case '??=':
      return buildsAString(node.left, scope, hops) || buildsAString(node.right, scope, hops);
    default:
      return false;
  }
}

/** A call that reaches another callee, with the arguments that callee sees. */
interface ForwardedCall {
  callee: t.Node;
  args: readonly t.Node[];
  position: CalleePosition;
  /**
   * Whether {@link args} is the vector the target actually receives. False for
   * a list this analysis cannot reconstruct - a spread, a hole, or an `.apply`
   * list that is not written out - and the caller then keeps the hazard while
   * discarding the source, because a vector that may hold anything can compile
   * anything.
   */
  exact: boolean;
}

/**
 * What a call invokes once every route to it is seen through - the callees
 * `invocation` names, each still to be classified by spelling - with the
 * vector the target receives. A `.call` or `.apply` whose receiver argument
 * is itself spread is a route `invocation` declines to reconstruct; the
 * target is still the receiver, called with a vector nothing here can read.
 */
function routedCall(
  callee: t.Node,
  args: readonly t.Node[],
): { fns: readonly t.Node[]; args: readonly t.Node[]; exact: boolean } | undefined {
  const routed = invocation(callee, undefined, args, 0);
  if (routed) return { fns: routed.fns, args: routed.args, exact: !hasSpread(routed.args) };
  if (isMember(callee) && (propertyKey(callee) === 'call' || propertyKey(callee) === 'apply')) {
    return { fns: [callee.object], args: [], exact: false };
  }
  return undefined;
}

/**
 * `Reflect.apply(f, thisArg, [ ... ])` and `Reflect.construct(f, [ ... ])`, with
 * `Reflect` however it was reached: the target is the first argument, and
 * `construct` lands it in `'new'`, where `eval` is correctly not a hazard.
 */
function reflectRoute(callee: t.Node, args: readonly t.Node[]): ForwardedCall | undefined {
  if (!isMember(callee) || !isReflect(callee.object)) return undefined;
  const target = args[0];
  if (!target || t.isSpreadElement(target)) return undefined;
  if (isNamedMember(callee, 'apply')) {
    return { callee: target, position: 'indirect', ...readArgumentArray(args[2]) };
  }
  if (isNamedMember(callee, 'construct')) {
    return { callee: target, position: 'new', ...readArgumentArray(args[1]) };
  }
  return undefined;
}

/** An `.apply`-style argument list, readable only when it is written out. */
function readArgumentArray(list: t.Node | undefined): { args: readonly t.Node[]; exact: boolean } {
  if (!t.isArrayExpression(list)) return { args: [], exact: false };
  const elements = list.elements.filter((element): element is t.Expression =>
    t.isExpression(element),
  );
  return { args: elements, exact: elements.length === list.elements.length };
}

function hasSpread(args: readonly t.Node[]): boolean {
  return args.some((arg) => t.isSpreadElement(arg));
}

/** `Reflect`, however it was reached; the receiver is not proved, as above. */
function isReflect(node: t.Node): boolean {
  return t.isIdentifier(node, { name: 'Reflect' }) || isNamedMember(node, 'Reflect');
}

/** `<anything>.name`, written with a dot - optional chaining included. */
function isNamedMember(node: t.Node, name: string): boolean {
  if (t.isMemberExpression(node)) return !node.computed && t.isIdentifier(node.property, { name });
  if (t.isOptionalMemberExpression(node)) {
    return !node.computed && t.isIdentifier(node.property, { name });
  }
  return false;
}

/**
 * The source string this expression denotes, read without executing anything,
 * or `undefined` when nothing in the tree fixes its value.
 *
 * Three shapes, and the boundary is deliberate. A string literal and a template
 * with no substitutions ARE the string, written out. An identifier is followed
 * only when the binding is a declarator initialised with one of those two, or
 * with another such identifier, and never reassigned - `binding.constant` is
 * Babel's own "no `constantViolations`", so a `var s = 'a'; s = elsewhere();`
 * reads as unknown rather than as `'a'`. The chain is what makes the read
 * exact: a constant declarator holds its initialiser's value or, read before
 * the initialiser runs, `undefined` - never a different string - so the text
 * at the end of the chain is the text the site compiles, or the site compiles
 * no text at all.
 *
 * The chain is bounded by {@link MAX_ALIAS_HOPS} and follows each
 * declarator's own scope, where its initialiser's names resolve. The bound is
 * the termination proof: `var a = b; var b = a;` is two constant declarators
 * that go round for ever, and there is no visited set. It used to be one hop,
 * on the argument that a chain buys nothing the fixtures write; `var _0x11 =
 * '_0x4a2b()'; var _0x22 = _0x11; setTimeout(_0x22, 0)` is the shape that
 * argument missed, and it renamed `_0x4a2b` under a timer body that spells it
 * - the output threw where the input ran.
 *
 * Everything else - a concatenation, a template with a substitution, a
 * parameter, a member read, a call, a value out of a decoded array, a chain
 * longer than the bound - is not readable, and the callers treat unreadable as
 * "could be any code at all".
 */
export function readStaticString(
  node: t.Node | undefined,
  scope?: Scope,
  hops = MAX_ALIAS_HOPS,
): string | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  if (t.isIdentifier(node) && scope && hops > 0) {
    const binding = scope.getBinding(node.name);
    if (!binding || !binding.constant) return undefined;
    const declarator = binding.path;
    if (!declarator.isVariableDeclarator()) return undefined;
    return readStaticString(declarator.node.init ?? undefined, declarator.scope, hops - 1);
  }
  return undefined;
}

/**
 * How many `var s = t` edges {@link readStaticString} and {@link buildsAString}
 * follow from a timer or constructor argument before reading it as unknown.
 *
 * Four: the executed shapes are two and three hops, and the bound is also what
 * keeps a site's cost fixed, because `buildsAString` fans out into every
 * initialiser and write of every name it meets. Past it the two readers give
 * their unknown answers, which are not the same. `readStaticString` reads
 * unknown, and for `Function` and `eval` an unread source is the blunt freeze
 * of every program-scope name - over-cautious, never wrong. A timer falls
 * through to `buildsAString`, which walks the same chain to the same bound
 * and reads no hazard: the residue it already carries for a parameter's
 * argument, one chain deeper, so a fifth alias of a timer string is renamed
 * under. A visited set would take that residue to zero on a straight chain at
 * the price of walking the whole alias graph from every timer in the file;
 * nothing measured writes the chain that would pay for it.
 */
const MAX_ALIAS_HOPS = 4;

// ---------------------------------------------------------------------------
// Rename legality and application
// ---------------------------------------------------------------------------

export interface AllocatorOptions {
  typescript: boolean;
  /** Refuse names that appear as string literals anywhere in the program. */
  strictStringGuard: boolean;
  strings: ReadonlySet<string>;
  /** Free identifier -> the scope uids its references sit inside. */
  freeGlobalScopes: ReadonlyMap<string, ReadonlySet<number>>;
  /** Binding identifiers that are properties of the global object. */
  globalProperties: ReadonlySet<t.Identifier>;
  /**
   * Whether the file reads a property of that name off the global object -
   * `window.<name>`, `g.<name>` through an alias, any spelled key once the
   * object has escaped - so that a program-scope binding given the name
   * would be what the read finds.
   */
  readsGlobalProperty: (name: string) => boolean;
  /**
   * Scope uid -> the names Annex B.3.3 declares as a var in that scope or in
   * one below it, from sloppy block-level functions; no scope table lists that
   * var, so `hasBinding` cannot see it.
   */
  annexBNames: ReadonlyMap<number, ReadonlySet<string>>;
}

const MAX_SUFFIX = 24;

export class RenameAllocator {
  private readonly claimed = new Map<number, Set<string>>();

  constructor(private readonly options: AllocatorOptions) {}

  /**
   * Prove that rebinding `binding` to `newName` cannot change what any
   * identifier in the program resolves to.
   */
  canRename(binding: Binding, newName: string): boolean {
    if (newName === binding.identifier.name) return false;
    if (isReservedName(newName, this.options.typescript)) return false;
    if (this.options.strictStringGuard && this.options.strings.has(newName)) return false;
    // Never emit a name our own recogniser would call generated.
    //
    // Rules derive names from evidence in the file, and in an obfuscated file
    // that evidence is sometimes itself generated: `e.QSL7mX(...)` names its
    // result `qsl7mX`. Emitting that breaks the fixed point - the next run sees
    // a generated-looking binding, renames it to `qsl7mX2`, and the run after
    // that shuffles the suffixes again. Every emitted name passes through here,
    // so this is the one place that can guarantee it never happens.
    //
    // The `_2` a digit-ending base takes is ours, not the file's, and it is not
    // alphanumeric, so `looksGeneratedName` scores such a name 0 and waves it
    // through. Strip it first, or the separator becomes a way for a name this
    // guard exists to stop to be emitted as `bQe5r7_2`. `bQe5r7` is the example
    // because it is the real one: across the five fixtures at 'balanced' this
    // guard fires on obfuscated3.js alone, and `bQe5r7` is the only base it
    // stops there that ends in a digit, so it is the only one that can arrive
    // here wearing the separator at all. Every other base it stops
    // (`qsl7mX`, `kLc9Gk`, `w4lpHy`, ...) ends in a letter and takes a bare `2`,
    // which `looksGeneratedName` scores directly.
    //
    // KNOWN GAP, not fixable from here: `generatedScore` returns 0 for anything
    // matching `/^[a-z][a-z0-9]*$/` (`util/ast.ts`, the LOWER_WORD early-out),
    // and every name our rules produce goes through `toCamel`, so it always
    // starts lowercase. An all-lowercase generated key therefore scores 0 here
    // however obviously generated it is: `g1hfhi2p`, the camel-cased form of a
    // decoded property key in obfuscated3.js, scores 4 once the early-out is
    // taken away and 0 with it, so for a name of that shape the early-out is
    // the whole of what lets it through.
    //
    // The gap is only that wide, though. `gjy7gi1` scores 3 without the
    // early-out and `gockq4i` 2, both under GENERATED_THRESHOLD, so removing it
    // would stop neither - a lowercase name this guard misses is not by itself
    // evidence of this gap, and only names that would reach the threshold are.
    // Both are emitted bindings in that file's output, so a reader can find
    // them and check; an earlier version of this comment cited a name that
    // appears nowhere in it, which is a claim no reader can test.
    //
    // Nor is one rule responsible. D02 to D07 all name a binding after a
    // property or method name the *file* chose - a destructured key, a
    // `this.k` store, an `o.k` store, an object-literal key, a `.k` read, a
    // `.getK()` result - and all six reach `toCamel`, so any of them can emit a
    // lowercase generated key. Which of them actually does so on a given file
    // is a fact about that file: the enumeration that used to stand here listed
    // one rule that now fires nowhere in the whole run and another whose names
    // the early-out does not mask at all. It went stale by exactly the
    // mechanism the paragraph below describes, so it is gone rather than
    // recounted - what makes this a gap in the guard rather than a bug in one
    // rule is the shared `toCamel`, and that is readable in `evidence.ts`
    // without measuring anything.
    //
    // No count is given either. It would be a fraction of obfuscated3.js's
    // applied renames, which moves with any pass upstream of naming rather than
    // with anything this guard does, so a number written here goes stale on a
    // change it says nothing about - as the one that used to be here had.
    //
    // Closing it means changing that early-out, which also drives
    // `isObfuscatedName` and so decides which bindings are targets at all: a
    // different file's change, with its own measurement. Re-deriving the scorer
    // here instead would put the rule in two places, which is exactly what this
    // comment says not to do.
    if (looksGeneratedName(newName.replace(/_[0-9]+$/, ''))) return false;
    if (extendsCurrentName(binding.identifier.name, newName)) return false;

    const declScope = binding.scope;
    // Walks the whole chain, so this rejects same-scope collisions, shadowed
    // outer bindings and standard globals in one check.
    if (declScope.hasBinding(newName, false)) return false;
    if (this.claimedIn(declScope).has(newName)) return false;
    // A `var` is a binding of its function declared wherever its declarator
    // sits, and every scope from there up to the function binds over it: a
    // `let` of the name in the same block is `Identifier has already been
    // declared`, and a catch parameter of the name is what the declarator
    // then assigns to (B.3.5). Neither is on the chain above `declScope`.
    if (binding.kind === 'var') {
      for (let scope: Scope | undefined = binding.path.scope; scope && scope !== declScope; scope = scope.parent) {
        if (scope.hasOwnBinding(newName)) return false;
        if (this.claimedIn(scope).has(newName)) return false;
      }
    }
    // A sloppy block-level function is also a var of `declScope` or of a
    // scope below it, assigned when its block runs: `var q = new W(); if (c)
    // { function socket() {} }` renamed `q` to `socket` handed `q`'s reads
    // the block function.
    if (this.options.annexBNames.get(declScope.uid)?.has(newName)) return false;
    // `hasBinding`'s idea of a global is a fixed list of ES builtins, so it says
    // nothing about `document`, `storage`, `require` or an application global
    // from another <script>. Those show up instead as identifiers this file
    // reads and never binds; taking one as a name inside a scope that reads it
    // captures the read, and the file then talks to itself instead of the host.
    if (this.options.freeGlobalScopes.get(newName)?.has(declScope.uid)) return false;
    // A script's top-level `var` shares a namespace with the Window object's own
    // properties, several of which are accessors: `var name = ['a','b']` at
    // program scope writes through `window.name`'s setter and reads back the
    // string "a,b". Nothing in the file reveals this, so it takes a list.
    if (this.options.globalProperties.has(binding.identifier)) {
      if (isGlobalObjectPropertyName(newName)) return false;
      // ... and with the file's own reads of it: `var _0x4a68 = 1; log(window.count)`
      // renamed `_0x4a68` to `count`, and the read of a host's `count` then
      // found the file's. The read direction refuses a binding of the name
      // (`isRenameable`); this is the write direction of the same guard.
      if (this.options.readsGlobalProperty(newName)) return false;
    }

    // Capture: a reference must not pass through an intervening binding of
    // `newName` on its way out to the declaring scope.
    for (const reference of [...binding.referencePaths, ...binding.constantViolations]) {
      let scope: Scope | undefined = reference.scope;
      while (scope && scope !== declScope) {
        if (scope.hasOwnBinding(newName)) return false;
        if (this.claimedIn(scope).has(newName)) return false;
        scope = scope.parent;
      }
      if (!scope) return false;
    }

    return true;
  }

  /**
   * `name`, `name2`, `name3`, ... - never a hash, so reruns agree.
   *
   * A base that already ends in a digit takes an underscore first. Appending a
   * bare decimal to `uint16` produces `uint162`, and after two dozen collisions
   * `uint1624`, which reads as a width rather than as the 24th `uint16`; the
   * same fusion turned parameter 10's second copy into `arg102`. `uint16_2` and
   * `arg10_2` cannot be misread, and the separator appears nowhere else, so
   * `isSettledSpelling` can still recognise the suffix as one.
   */
  *suffixes(name: string): Generator<string> {
    yield name;
    const separator = /[0-9]$/.test(name) ? '_' : '';
    for (let index = 2; index <= MAX_SUFFIX; index++) yield `${name}${separator}${index}`;
  }

  /**
   * Rewrite every occurrence in place.
   *
   * `scope.rename()` re-crawls the enclosing block per call, which measures at
   * ~76 ms per binding on a 470 KB file. Rewriting the nodes the binding
   * already points at is O(references) and needs no traversal at all.
   */
  apply(binding: Binding, newName: string): void {
    const oldName = binding.identifier.name;

    for (const reference of binding.referencePaths) rewriteReference(reference, newName);

    for (const violation of binding.constantViolations) {
      // `getOuterBindingIdentifiers`, not `getBindingIdentifiers`: the latter
      // descends into a FunctionDeclaration's `params`, which belong to the
      // function's *own* scope. `function f(f) { return f * 2 }` written over a
      // same-named `var` is a constant violation of that var, and the blunt read
      // renamed the parameter too - a different binding, whose references this
      // loop never visits, so its body was left pointing at a name that no
      // longer exists. The outer form descends only into the declaration's `id`.
      const identifiers = violation.getOuterBindingIdentifiers(true)[oldName];
      if (identifiers) for (const identifier of identifiers) identifier.name = newName;
    }

    binding.identifier.name = newName;

    const scope = binding.scope;
    scope.removeOwnBinding(oldName);
    scope.bindings[newName] = binding;
    this.claimedIn(scope).add(newName);
  }

  private claimedIn(scope: Scope): Set<string> {
    let names = this.claimed.get(scope.uid);
    if (!names) {
      names = new Set();
      this.claimed.set(scope.uid, names);
    }
    return names;
  }
}

/**
 * The signature of an evidence rule eating its own output.
 *
 * Several rules in `evidence.ts` build a name as `<source> <noun>` where
 * `source` is `world.displayName` of an identifier in the evidence. When that
 * identifier resolves to the binding being named, `source` is the binding's own
 * current name, so the suggestion is that name with one more camel word glued
 * on - and the next run reads the longer name back out of `displayName` and
 * glues the same word on again. `x = JSON.parse(x)` walked `data` to `dataData`
 * to `dataDataData`; `x = x.getContext('2d')` did the same with `Ctx`.
 *
 * Each of those rules now refuses the self-reference at the point where it can
 * still choose a sensible fallback, which is where the fix belongs. This is the
 * backstop for the next rule of that shape, because the shape is recognisable
 * from the two names alone without knowing which rule produced them - and a
 * rename that only appends to the name the binding already has is not worth
 * doing in any case.
 *
 * Three things the test is deliberately made of:
 *
 *   * `isReadableName` on the *current* name. `displayName` hands back an
 *     unsettled binding's existing name only when it passes that predicate, so a
 *     name it refuses can never be the `source` a rule appends to, and a rename
 *     away from it must not be blocked. Called without the program's
 *     `NameScheme`, which is not reachable from here; the scheme only ever adds
 *     names to the obfuscated set, so this admits every name `displayName` would
 *     report and some it would not - it errs towards refusing a rename, never
 *     towards letting the loop run.
 *   * The remainder must start a new camel word. `i` -> `index` extends the
 *     current name as a string but is a real rename, not a rule re-reading
 *     itself; `data` -> `dataData` is the loop.
 *   * The allocator's own numeric suffix is stripped before comparing, so
 *     `dataData2` is refused for the same reason `dataData` is. Without that the
 *     collision path would hand the loop a way around this check.
 */
function extendsCurrentName(current: string, newName: string): boolean {
  if (!isReadableName(current)) return false;
  const base = newName.replace(/_?[0-9]+$/, '');
  if (base.length <= current.length || !base.startsWith(current)) return false;
  return /^[A-Z]/.test(base.slice(current.length));
}

function rewriteReference(reference: NodePath, newName: string): void {
  const node = reference.node;
  if (t.isIdentifier(node) || t.isJSXIdentifier(node)) node.name = newName;

  // `{ x }` must become `{ x: newName }` or the property key silently changes.
  const parent = reference.parent;
  if (t.isObjectProperty(parent) && parent.shorthand && parent.value === node) {
    parent.shorthand = false;
    const extra = parent.extra as { shorthand?: boolean } | undefined;
    if (extra) extra.shorthand = false;
  }
}

/**
 * Positions where a rename needs more than substituting the identifier text.
 * Anything listed here is declined rather than half-rewritten.
 */
export function hasUnrewritableReference(binding: Binding): boolean {
  for (const reference of binding.referencePaths) {
    const node = reference.node;
    if (!t.isIdentifier(node) && !t.isJSXIdentifier(node)) return true;
    const parent = reference.parentPath;
    if (!parent) return true;
    if (parent.isExportSpecifier() || parent.isExportDefaultDeclaration()) return true;
    // `<Foo.Bar/>`: only the root object is a binding, and Babel reports it as a
    // JSXIdentifier inside a JSXMemberExpression, which we can rewrite; but a
    // JSXNamespacedName is not a binding reference at all.
    if (parent.isJSXNamespacedName()) return true;
  }
  return false;
}

/** §6.4: a component that stops being PascalCase silently becomes a host element. */
export function violatesJsxConstraint(
  currentName: string,
  newName: string,
  isJsx: boolean,
  isComponent = false,
): boolean {
  if (!isJsx) return false;
  if (newName.includes('-')) return true;
  // `isComponent` covers the case the name alone cannot: a component that has not
  // been restored to JSX yet is still `_jsx(_0x1234, ...)`, so its current name is
  // not PascalCase and the capitalisation rule below never fires. Renaming it to
  // `fn1` is not incorrect - `finalize.jsx` then refuses to emit `<fn1>` - but the
  // file silently loses its JSX restoration, which is the whole point.
  if (isComponent && !/^[A-Z]/.test(newName)) return true;
  return /^[A-Z]/.test(currentName) && !/^[A-Z]/.test(newName);
}

/** jsx-runtime callees whose first argument names the component being created. */
const JSX_FACTORIES = new Set(['_jsx', '_jsxs', '_jsxDEV', 'jsx', 'jsxs', 'jsxDEV']);

/**
 * True when a binding is used as the component argument of a JSX runtime call.
 *
 * Matching on the callee's name is acceptable here precisely because these names
 * come from the React JSX transform rather than from an obfuscator, so unlike
 * decoder detection they are stable rather than randomised.
 *
 * The `createElement` arm matches any receiver, so `document.createElement(tag)`
 * with a variable tag counts too. Left as it is: the only effect is to force
 * PascalCase and, failing that, decline the rename, so the cost is one unrenamed
 * binding in a JSX file. Narrowing it to `React.createElement` would miss the
 * aliased receivers the transform actually emits, which costs the restoration
 * this exists to protect.
 */
export function isJsxComponentBinding(binding: Binding): boolean {
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    if (!parent?.isCallExpression()) continue;
    if (parent.node.arguments[0] !== reference.node) continue;

    const callee = parent.node.callee;
    if (t.isIdentifier(callee) && JSX_FACTORIES.has(callee.name)) return true;
    if (
      t.isMemberExpression(callee) &&
      !callee.computed &&
      t.isIdentifier(callee.property) &&
      callee.property.name === 'createElement'
    ) {
      return true;
    }
  }
  return false;
}
