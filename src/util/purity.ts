import type { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';

import { insideWith, isInitialisedBinding, isUnboundUndefined, staticString } from './ast.js';

/**
 * "Can evaluating this expression hand control to code the program wrote, and
 * can skipping it be noticed" - asked at three strengths, in one place.
 *
 * Eleven predicates across five files answer some version of it -
 * `analysis/parameters.ts` (`cannotInvoke`), `clean/unused.ts` and
 * `simplify/proxy-functions.ts` (four each), `simplify/fold-constants.ts`
 * (`isSideEffectFree`) and `structure/conditionals.ts` (`isDiscardableValue`) -
 * and four rounds of fixing them one at a time each closed a defect and each
 * then found the same defect in another copy. The two predicates that have never
 * recurred are the two that exist once (`insideWith`, `freezeHazardKind`), so
 * this is that shape applied to the largest remaining cluster.
 *
 * ## The three strengths, and who wants which
 *
 * They are nested - `isSideEffectFree` ⊂ `!canInvokeUserCode` - and they are
 * deliberately not collapsed into one predicate, because the callers really do
 * ask three different things and flattening them would either lose real
 * removals or admit unsound ones.
 *
 *  - {@link canInvokeUserCode} - CONTROL TRANSFER. True when evaluating the node
 *    could reach a function the program wrote: a call, `new`, `await`, `yield`,
 *    a property read (getter), a computed key (ToPropertyKey → ToPrimitive), a
 *    coercing operator on an operand not provably primitive, a destructuring
 *    target (getter, then the iterator protocol), a free identifier (a global
 *    property read, so a getter), an assignment to a free name (a setter), a
 *    tagged template, spread (iterator), `delete` (a proxy trap), and any name
 *    at all inside a `with`. It says nothing about THROWS or about WRITES: `x =
 *    1` into a bound name and a read of `x` inside its own TDZ both answer
 *    "cannot invoke", and both are observable. Wanted by a caller asking "may
 *    this expression be MOVED across other code" - `analysis/parameters.ts`
 *    deciding whether a parameter default can be hoisted past a body that might
 *    read the parameter.
 *
 *  - {@link isPrimitiveValued} - a TYPE claim, not a purity claim: this producer
 *    can never yield an object, so ToPrimitive on it cannot run `valueOf` or
 *    `toString`. It is the lemma the other two use for every coercing operator,
 *    and it is exported because callers that build their own coercion rule need
 *    the same lemma rather than a second one.
 *
 *  - {@link isSideEffectFree} - OBSERVABILITY. No user code, no throw, no write.
 *    This is the only one strong enough for a REMOVAL, which is what
 *    `clean/unused.ts`, `simplify/proxy-functions.ts` and
 *    `simplify/fold-constants.ts` do with their copies.
 *
 * ## What this is NOT
 *
 * `isPureContext` in `./ast.ts` answers a DIFFERENT question - whether a
 * position is a read or a write - and must stay separate. "Is this expression
 * safe to evaluate" and "is this slot being assigned to" have no answer in
 * common; merging them would make one of the two silently wrong at every site.
 *
 * ## The originals, and every way they diverged
 *
 * Read before changing anything here. Each divergence below is labelled REAL (a
 * requirement of the strength that caller asks at, preserved by the layering) or
 * ACCIDENT (a coarser or narrower approximation of the same question, unified
 * here). Nothing was resolved by "pick the strictest".
 *
 *  1. TDZ. `unused`/`proxy` require a lexical binding to be initialised;
 *     `cannotInvoke` accepts any bound name. REAL: a TDZ read throws but runs no
 *     program code, so it belongs to the observability strength, not the
 *     control-transfer one. Preserved exactly - the check is on the `observable`
 *     arm only.
 *  2. Assignment. `cannotInvoke` alone accepts `x = v` into a bound name. REAL,
 *     and for the same reason: a binding write invokes nothing and is plainly
 *     observable. Accepted at `invoke`, refused at `observable`.
 *  3. Coercing operators. `cannotInvoke` refuses `-`/`+`/`~` and every binary
 *     but `===`/`!==` outright, with no primitive proof, so it refuses `-n` for
 *     `var n = 2` where the other two accept it. ACCIDENT: it is the same rule
 *     approximated by dropping its premise. Unified on the proof, which makes
 *     that caller more permissive - a real behaviour change to measure when the
 *     site migrates, not a silent one.
 *  4. Shape coverage. `proxy` has no `TemplateLiteral`, `ObjectExpression` or
 *     `SequenceExpression` arm; `cannotInvoke` accepts only an expression-free
 *     template and a non-computed object literal; `unused` proves each template
 *     substitution and each computed key individually. ACCIDENT throughout -
 *     three different subsets of one sound rule. Unified on the per-element
 *     proof, i.e. the most permissive of the three, since a missing arm is a
 *     refusal and refusals are not requirements.
 *  5. `{ a: b }`. `unused` refuses any object property whose value `isPatternLike`,
 *     which is true of a bare `Identifier`, so it refuses the commonest object
 *     literal there is. ACCIDENT: the intent was to refuse a destructuring
 *     TARGET, and `t.isExpression` is that test - `{ a = 1 }` and `{ a: [b] }`
 *     still refuse, `{ a: b }` no longer does.
 *  6. `with`. No copy checks it, though all four scope-taking copies resolve
 *     names through `scope.getBinding`. REAL HAZARD, newly closed here; see
 *     "Name resolution" below.
 *  7. `fold-constants.ts`'s copy accepts what its own `constantOf` folded, plus
 *     the inert literals and literal aggregates. Its accepted set is a subset of
 *     this module's, so it can migrate without losing a fold - but only the
 *     purity question migrates; `constantOf` is a folder, not an oracle.
 *  8. `PrivateName`. `proxy` guards it explicitly, `unused` gets there through
 *     its `in` refusal. ACCIDENT, both kept - `#x in o` is refused twice.
 *  9. `structure/conditionals.ts`'s `isDiscardableValue` takes NO SCOPE, so it
 *     cannot ask any of the three questions here - it accepts the name
 *     `undefined` unconditionally and a `BigIntLiteral` as a placeholder value.
 *     Not a divergence to resolve in this module: migrating it means first
 *     giving it a scope at its call site.
 *
 * ## Name resolution
 *
 * Inside `with (o) { ... }` an identifier is looked up on `o` at run time, so the
 * binding Babel reports is only a fallback and every `getBinding` answer below
 * is a guess. `with` changes exactly one thing - how a NAME resolves - so the
 * refusal is placed on the arms that resolve a name rather than blanket over the
 * node: `1` is still a literal inside a `with`.
 *
 * The hazard is precise when the caller passes `options.path`, because
 * `insideWith` can then walk the node's own ancestors. Without a path it is
 * derived from `scope.path`, which catches every `with` whose body is a block
 * (the body block is itself a scope) and, for the one remaining shape - an
 * unblocked body, `with (o) x = 1;`, where the node's scope is the `with`'s own
 * ancestor - falls back to scanning that scope's subtree for such a statement.
 * That scan is cached per scope node and refuses the whole scope when it hits,
 * which is an over-refusal confined to files that contain an unblocked `with`.
 * It assumes no pass INTRODUCES a `with`, which none does.
 *
 * ## Builtins: one assumption, opted into by name
 *
 * A `CallExpression` is refused by default and that refusal is the right one:
 * `o.m()` reads a property - a getter - and then calls whatever it found, and on
 * a string receiver the method comes off `String.prototype`, which is writable.
 *
 * {@link PurityOptions.assumeNativeBuiltins} lets a caller say it is already
 * treating the intrinsics as the ones the specification defines. That is not a
 * new licence invented here; it is the position the rest of the engine holds and
 * acts on:
 *
 *  - `analysis/parameters.ts` names it - "the closed-world assumption the whole
 *    engine already makes" - and hoists parameter writes on the strength of it;
 *  - `util/ast.ts`'s `staticStringTable` evaluates `'a;b'.split(';')` with THIS
 *    process's `split` and hands the entries to the string-array recovery, which
 *    then rewrites every read of that table and deletes it;
 *  - `analysis/evaluator/builtins.ts` freezes its builtin table and resolves
 *    every member through it, so interpreted code that assigns to
 *    `String.prototype.split` is executed as though it had not - the interpreter
 *    tier, the most faithful executor this engine has, does not model poisoning
 *    at all;
 *  - `analysis/evaluator/native.ts` recognises a decoder from its shape and runs
 *    a native implementation of the published algorithm, never checking whether
 *    the program replaced the methods it recognised.
 *
 * It stays an option, and off by default, because it is not free and the price
 * is asymmetric. A program that really has replaced `split` with a delegating
 * wrapper loses that wrapper's side effect when a call to it is deleted -
 * measured, on `String.prototype.split = function (s) { log('POISON'); return
 * real.call(this, s); }`, as a trace of `POISON | b | a` becoming `b | a`. A
 * caller is entitled to the option only where it is ALREADY relying on the same
 * builtin's native behaviour in the same expression, so that switching the
 * option off would not make the rewrite sound - it would only make the engine
 * hold two positions about one call. Anything weaker than that is a caller
 * buying output with someone else's soundness.
 *
 * ## BigInt
 *
 * A BigInt is a primitive and calls no `valueOf`, but arithmetic mixing it with
 * a Number throws a TypeError, and `+b` and `b >>> 1` throw on any BigInt at
 * all. A throw is as observable as a call: `var b = 1n; var dead = b + 1;` threw
 * before and reached the next statement after. So `BigIntLiteral` is absent from
 * {@link isPrimitiveValued} and a BigInt initialiser is refused by
 * `isPrimitiveBinding`. Those two leaves are what makes the composite claims
 * ("every `BinaryExpression` yields a primitive", "every `UpdateExpression`
 * yields a primitive") safe: a BigInt cannot get INTO a subtree that is both
 * primitive-valued and side-effect-free, because it is refused at every leaf
 * that could introduce one.
 */

/**
 * Beyond this nesting depth every answer is the refusal. A stack guard, not a
 * semantic rule: the recursion is proportional to expression nesting, and input
 * nesting is attacker-controlled.
 */
const MAX_PURITY_DEPTH = 256;

/**
 * Operators that run ToNumber on their operand. ToNumber on an object calls its
 * `valueOf` (then its `toString`), which is a method the program wrote.
 */
const COERCING_UNARY = new Set(['-', '+', '~']);

/**
 * The global object's value properties that are neither writable nor
 * configurable, minus `undefined`, which `util/ast.ts` owns.
 *
 * A free identifier is a property read on the global object, and a getter
 * installed there is user code - which is why every other free name is refused.
 * These cannot be redefined as accessors and cannot be missing, so reading one
 * runs nothing and throws nothing. `fold-constants.ts` already relies on exactly
 * this for `NaN` and `Infinity`; accepting them here is therefore a widening of
 * `unused`/`proxy` (which accept only `undefined`), adopted so that copy can
 * migrate without losing folds.
 */
const IMMUTABLE_GLOBAL_VALUES = new Set(['NaN', 'Infinity']);

/**
 * The methods a call may be accepted to under
 * {@link PurityOptions.assumeNativeBuiltins}.
 *
 * Membership takes two things, and both are narrow deliberately.
 *
 * The engine has to be assuming this method is the native one somewhere else
 * ALREADY, so that accepting it here adds no assumption to the engine - only
 * `split` qualifies today, evaluated by `util/ast.ts`'s `staticStringTable` and
 * by `analysis/dispatcher.ts`'s `resolveOrderEntries`.
 *
 * And the method has to be TOTAL on the operands this module can prove: with a
 * string receiver and primitive arguments, `String.prototype.split` is a pure
 * function of its inputs. It runs `GetMethod(separator, @@split)`, which on a
 * primitive separator finds nothing to call unless something installed a
 * `Symbol.split` - which is the assumption, not a hole in it - and its
 * conversions (ToString on the separator, ToUint32 on the limit) cannot throw on
 * a primitive, because no leaf reaching them can be a Symbol or a BigInt (see
 * the module header).
 *
 * Neither half holds for String methods in general: `repeat` throws a RangeError
 * on a negative count, `replace` calls a replacer function, `match` dispatches
 * through `@@match` on its argument. So nothing joins this set without both.
 */
const NATIVE_STRING_METHODS = new Set(['split']);

export interface PurityOptions {
  /**
   * The node's own path, when the caller has one. Only name resolution needs
   * it, and only inside a `with`; see "Name resolution" above for what the
   * scope-derived fallback can and cannot see.
   */
  readonly path?: NodePath | null;

  /**
   * Assume the intrinsics are the ones the specification defines - the
   * closed-world assumption this engine already makes about builtins.
   *
   * With it, a call to one of {@link NATIVE_STRING_METHODS} on a string receiver
   * with primitive arguments is accepted; without it, every call is refused.
   * Nothing else about the walk changes, and no other node type is affected.
   * See "Builtins" in the module header for who already relies on this and for
   * what a caller has to be doing to be entitled to it.
   */
  readonly assumeNativeBuiltins?: boolean;
}

/** Everything the walk needs that does not change as it descends. */
interface Query {
  readonly scope: Scope;
  /** A name here may resolve through an object environment instead of a binding. */
  readonly nameHazard: boolean;
  /** {@link PurityOptions.assumeNativeBuiltins}, as asked for by this caller. */
  readonly builtins: boolean;
}

/**
 * Whether evaluating this node can transfer control to code the program wrote.
 *
 * The core question, and the weakest of the three: it models neither throws nor
 * writes, so `x = 1` into a bound name and a read inside a `let`'s TDZ both
 * answer `false` here. A caller that must preserve those wants
 * {@link isSideEffectFree}.
 */
export function canInvokeUserCode(node: t.Node, scope: Scope, options?: PurityOptions): boolean {
  return !walk(node, query(scope, options), 'invoke', 0);
}

/**
 * Whether evaluating this node can be OBSERVED at all: it runs no user code,
 * throws nothing and writes nothing. The strength a removal needs.
 */
export function isSideEffectFree(node: t.Node, scope: Scope, options?: PurityOptions): boolean {
  return walk(node, query(scope, options), 'observable', 0);
}

/**
 * Whether this expression's value can only ever be a primitive.
 *
 * A TYPE question, not a purity one, and the one that decides whether
 * ToPrimitive can reach user code: `-x`, `x + y` and `` `${x}` `` call
 * `valueOf`/`toString` only when an operand is an OBJECT. Every producer
 * accepted below yields a primitive whatever its own operands are - `typeof` a
 * string, `!` a boolean, `-` a number, a comparison a boolean, a template a
 * string - so the proof is about the shape of the producer. Whether those
 * operands themselves coerce is the other two predicates' question.
 *
 * `RegExpLiteral`, `ObjectExpression`, `ArrayExpression` and the function forms
 * are deliberately absent: they are objects, and `Object.prototype.valueOf` is
 * writable, so even a fresh `{}` can reach a method the program installed.
 * `BigIntLiteral` is absent for the separate reason given in the module header.
 */
export function isPrimitiveValued(node: t.Node, scope: Scope, options?: PurityOptions): boolean {
  return primitive(node, query(scope, options), 0);
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

function query(scope: Scope, options?: PurityOptions): Query {
  return {
    scope,
    nameHazard: nameResolutionHazard(scope, options?.path),
    builtins: options?.assumeNativeBuiltins === true,
  };
}

function nameResolutionHazard(scope: Scope, path: NodePath | null | undefined): boolean {
  if (path) return insideWith(path);
  const anchor = scope.path;
  if (!anchor) return false;
  // A blocked `with` body is a scope of its own, so climbing from the scope's
  // own path finds it. Only an unblocked body can hide one below the anchor.
  if (insideWith(anchor)) return true;
  // Typed non-nullable, but a removed path really does carry a null node.
  const root: t.Node | null | undefined = anchor.node;
  return root ? containsUnblockedWith(root) : false;
}

const UNBLOCKED_WITH = new WeakMap<t.Node, boolean>();

/**
 * Whether this subtree contains a `with` whose body is not a block.
 *
 * Cached because the anchor is usually the Program and the answer is usually
 * `false`; a structural walk rather than a Babel traversal for the same reason
 * `countNodes` in `./ast.ts` is one.
 */
function containsUnblockedWith(root: t.Node): boolean {
  const cached = UNBLOCKED_WITH.get(root);
  if (cached !== undefined) return cached;
  let found = false;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object' || typeof (current as t.Node).type !== 'string') {
      continue;
    }
    const node = current as t.Node;
    if (node.type === 'WithStatement' && !t.isBlockStatement(node.body)) {
      found = true;
      break;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  UNBLOCKED_WITH.set(root, found);
  return found;
}

/**
 * Reading a free name is a property read on the global object, so it reaches
 * whatever getter is installed there - the same hazard `o.gx` is refused for,
 * spelled without the dot. Browser anti-tamper code installs accessors on
 * `window` routinely, and `document` is one on `Window.prototype`. The three
 * immutable value properties are the exception, and the only one.
 */
function isImmutableGlobalRead(node: t.Identifier, scope: Scope): boolean {
  if (isUnboundUndefined(node, scope)) return true;
  return IMMUTABLE_GLOBAL_VALUES.has(node.name) && scope.getBinding(node.name) === undefined;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * `invoke` answers "no control transfer"; `observable` additionally answers "no
 * throw and no write". Every arm that differs is documented at the arm, and
 * `observable` is stronger at every one of them, so `isSideEffectFree` implies
 * `!canInvokeUserCode` by construction.
 */
type Strength = 'invoke' | 'observable';

/** True when the node is SAFE at this strength. */
function walk(node: t.Node, q: Query, strength: Strength, depth: number): boolean {
  if (depth > MAX_PURITY_DEPTH) return false;
  const next = depth + 1;

  switch (node.type) {
    // Inert: no operand, no coercion, no name. Creating a closure or a regexp
    // allocates but runs nothing - a function body does not execute here, and a
    // default parameter value is evaluated at call time.
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
    case 'ThisExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;

    case 'Identifier':
      return readableName(node, q, strength);

    // Statement forms exist for the caller that asks about a whole statement
    // ("may this be hoisted past that"). A declaration BINDS, which is a write,
    // so only the control-transfer strength accepts one.
    case 'EmptyStatement':
    case 'FunctionDeclaration':
      return strength === 'invoke';
    case 'ExpressionStatement':
      return walk(node.expression, q, strength, next);
    case 'VariableDeclaration':
      if (strength !== 'invoke') return false;
      return node.declarations.every((declarator) => {
        // The TARGET is the half that is easy to miss: `var { x } = o` runs a
        // getter and `var [x] = o` runs the iterator protocol, and neither call
        // appears anywhere in `o`. Only a bare name binds without evaluating.
        if (!t.isIdentifier(declarator.id)) return false;
        return !declarator.init || walk(declarator.init, q, strength, next);
      });

    case 'UnaryExpression':
      // `delete` reaches a proxy trap and can throw on a non-configurable
      // property; `throw` (the expression form) transfers control by definition.
      if (node.operator === 'delete' || node.operator === 'throw') return false;
      // `-o` runs ToNumber, which calls `o.valueOf()`. Dropping or moving the
      // operand drops that call, so the operand has to be something no `valueOf`
      // can hang off. `!`, `typeof` and `void` convert without asking the value.
      //
      // `typeof` is NOT exempted on a free name. It is true that `typeof
      // undeclared` is the one read that does not throw, but the read still
      // happens, and on the global object a getter answers it.
      if (COERCING_UNARY.has(node.operator) && !primitive(node.argument, q, next)) return false;
      return walk(node.argument, q, strength, next);

    case 'UpdateExpression':
      // `x++` writes, so `observable` refuses it outright. `invoke` could in
      // principle accept an increment of a bound name holding a primitive - but
      // the primitive proof requires the binding be constant, and a binding you
      // can increment is not, so the precise rule and the blanket refusal accept
      // the same empty set. Refusing plainly is the honest spelling.
      return false;

    case 'BinaryExpression':
      // `in` and `instanceof` dispatch through `Symbol.hasInstance` and the
      // proxy `has` trap.
      if (node.operator === 'in' || node.operator === 'instanceof') return false;
      if (t.isPrivateName(node.left)) return false;
      // Only `===` and `!==` compare without converting. Everything else -
      // arithmetic, relational, `==` - runs ToPrimitive on an operand, and on an
      // object that is a call to `valueOf`/`toString`.
      if (node.operator !== '===' && node.operator !== '!==') {
        if (!primitive(node.left, q, next)) return false;
        if (!primitive(node.right, q, next)) return false;
      }
      return walk(node.left, q, strength, next) && walk(node.right, q, strength, next);

    case 'LogicalExpression':
      return walk(node.left, q, strength, next) && walk(node.right, q, strength, next);

    case 'ConditionalExpression':
      return (
        walk(node.test, q, strength, next) &&
        walk(node.consequent, q, strength, next) &&
        walk(node.alternate, q, strength, next)
      );

    case 'SequenceExpression':
      return node.expressions.every((expression) => walk(expression, q, strength, next));

    case 'TemplateLiteral':
      // `${o}` runs ToString, which calls `o.toString()` - the same hazard as
      // `-o`, spelled without an operator.
      return node.expressions.every(
        (expression) =>
          primitive(expression, q, next) && walk(expression, q, strength, next),
      );

    case 'ArrayExpression':
      // A hole evaluates nothing. A `SpreadElement` is not an `Expression`, and
      // it runs the iterator protocol.
      return node.elements.every(
        (element) =>
          element === null || (t.isExpression(element) && walk(element, q, strength, next)),
      );

    case 'ObjectExpression':
      return node.properties.every((property) => {
        // Defining an accessor does not run it, so a non-computed `get`/`set`
        // method is as inert as a value.
        if (t.isObjectMethod(property)) return !property.computed;
        // The remaining alternative is `SpreadElement`, which runs `ownKeys` and
        // then every enumerable getter of the source.
        if (!t.isObjectProperty(property)) return false;
        if (property.computed) {
          // A computed key runs ToPropertyKey, which is ToPrimitive under
          // another name: `{ [o]: 1 }` calls `o.toString()`.
          if (!primitive(property.key, q, next)) return false;
          if (!walk(property.key, q, strength, next)) return false;
        }
        // A non-expression value means this literal is really a destructuring
        // pattern - `({ a: [b] } = src)` - whose targets run getters.
        return t.isExpression(property.value) && walk(property.value, q, strength, next);
      });

    case 'AssignmentExpression':
      // A write to a plain binding invokes nothing, which is all the `invoke`
      // strength asks. `o.k = v` reaches a setter, and so does `k = v` when `k`
      // is free - that is a write to a global property. A compound assignment
      // (`x += y`) coerces the old value as well.
      if (strength !== 'invoke') return false;
      return (
        node.operator === '=' &&
        t.isIdentifier(node.left) &&
        !q.nameHazard &&
        q.scope.getBinding(node.left.name) !== undefined &&
        walk(node.right, q, strength, next)
      );

    case 'CallExpression':
      // A call reaches anything at all, which is why it is refused unless the
      // caller has opted into the closed-world assumption AND this is a call the
      // module can prove total under it. Both strengths get the same answer:
      // a native `split` on a string transfers no control, throws nothing and
      // writes nothing, which is everything `observable` asks for beyond what
      // `invoke` does.
      return q.builtins && nativeMethodCall(node, q, strength, next);

    /*
     * Explicit refusals, so the hazard is stated where a reader looks for it
     * rather than left to the `default`:
     *   - a property read runs a getter, and on `null`/`undefined` it throws;
     *   - `new` and a tagged template reach anything at all, and so does an
     *     optional call, which is a call with a null check in front of it;
     *   - `await` and `yield` hand control to whatever is queued;
     *   - spread runs the iterator protocol;
     *   - a class body evaluates `extends`, computed keys, static blocks and
     *     decorators, and a pattern is a destructuring target.
     */
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
    case 'TaggedTemplateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'SpreadElement':
    case 'ClassExpression':
    case 'ClassDeclaration':
    case 'ObjectPattern':
    case 'ArrayPattern':
    case 'AssignmentPattern':
    case 'RestElement':
      return false;

    default:
      return false;
  }
}

/**
 * Whether reading this name runs nothing, and - at `observable` - throws
 * nothing.
 *
 * The `with` test comes first because an object environment answers the name
 * before any binding does, which makes every `getBinding` result below it a
 * guess rather than an answer.
 */
function readableName(node: t.Identifier, q: Query, strength: Strength): boolean {
  if (q.nameHazard) return false;
  const binding = q.scope.getBinding(node.name);
  if (binding) {
    // A bound name resolves to a binding and evaluates nothing; whether that
    // read can THROW is the TDZ question, and only `observable` asks it.
    return strength === 'invoke' || isInitialisedBinding(node, q.scope);
  }
  return isImmutableGlobalRead(node, q.scope);
}

/**
 * `<string>.split(<primitive>)`, and for now nothing else.
 *
 * Four proofs, and dropping any one of them reaches code the program wrote:
 *
 *  - the METHOD is named literally, because a computed key runs ToPropertyKey on
 *    its own expression, which is ToPrimitive under another name;
 *  - it is in {@link NATIVE_STRING_METHODS}, which is where the closed-world
 *    assumption is spent and where the argument for spending it is written down;
 *  - the RECEIVER is a string, not merely a primitive. Which prototype the
 *    method is resolved on is decided by the receiver's TYPE: `(5).split` is
 *    `undefined`, and calling `undefined` throws a TypeError, which `observable`
 *    must not drop;
 *  - every ARGUMENT is a primitive and is itself safe, because ToString on an
 *    object calls `valueOf`, and because only an object separator can carry a
 *    `@@split` method to dispatch to.
 *
 * The receiver and the arguments are also walked at the caller's strength, so a
 * `split` on something that is a string but not free of effects - `` `${x++}` ``
 * - is still refused.
 */
function nativeMethodCall(
  node: t.CallExpression,
  q: Query,
  strength: Strength,
  depth: number,
): boolean {
  const callee = node.callee;
  if (!t.isMemberExpression(callee)) return false;
  const method = callee.computed
    ? staticString(callee.property)
    : t.isIdentifier(callee.property)
      ? callee.property.name
      : undefined;
  if (method === undefined || !NATIVE_STRING_METHODS.has(method)) return false;

  const object = callee.object;
  if (!t.isExpression(object)) return false;
  if (!stringValued(object, q, depth)) return false;
  if (!walk(object, q, strength, depth)) return false;

  for (const argument of node.arguments) {
    // A `SpreadElement` runs the iterator protocol and is not an expression.
    if (!t.isExpression(argument)) return false;
    if (!primitive(argument, q, depth)) return false;
    if (!walk(argument, q, strength, depth)) return false;
  }
  return true;
}

/**
 * Whether this expression can only ever produce a string.
 *
 * The narrower cousin of {@link isPrimitiveValued}, and it has to exist because
 * "primitive" does not say which prototype a member is resolved on. Only the
 * shapes whose result is a string whatever their operands hold are accepted:
 * a literal, a template - always a string, however its substitutions convert -
 * and a `+` with one string side, which forces string concatenation as long as
 * the other side is a primitive rather than an object with its own `valueOf`.
 */
function stringValued(node: t.Node, q: Query, depth: number): boolean {
  if (depth > MAX_PURITY_DEPTH) return false;
  const next = depth + 1;

  switch (node.type) {
    case 'StringLiteral':
    case 'TemplateLiteral':
      return true;

    case 'BinaryExpression': {
      if (node.operator !== '+' || !t.isExpression(node.left)) return false;
      return (
        (stringValued(node.left, q, next) && primitive(node.right, q, next)) ||
        (stringValued(node.right, q, next) && primitive(node.left, q, next))
      );
    }

    default:
      return false;
  }
}

/** See {@link isPrimitiveValued}; this is its recursion. */
function primitive(node: t.Node, q: Query, depth: number): boolean {
  if (depth > MAX_PURITY_DEPTH) return false;
  const next = depth + 1;

  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    // Every unary yields a primitive (`typeof` a string, `!` a boolean, the
    // arithmetic three a number or a BigInt), every update yields a number or a
    // BigInt, every binary yields a number, string, boolean or BigInt, and every
    // template yields a string - whatever their operands are. The BigInt cases
    // are safe here only because no leaf that could produce one is accepted; see
    // the module header.
    case 'UnaryExpression':
    case 'UpdateExpression':
    case 'BinaryExpression':
    case 'TemplateLiteral':
      return true;

    case 'Identifier':
      if (q.nameHazard) return false;
      return isPrimitiveBinding(node, q.scope) || isImmutableGlobalRead(node, q.scope);

    // These three yield one of their operands rather than a value of their own,
    // so the proof has to cover every branch that can be the result.
    case 'LogicalExpression':
      return primitive(node.left, q, next) && primitive(node.right, q, next);
    case 'ConditionalExpression':
      return primitive(node.consequent, q, next) && primitive(node.alternate, q, next);
    case 'SequenceExpression': {
      const last = node.expressions[node.expressions.length - 1];
      return last !== undefined && primitive(last, q, next);
    }

    default:
      return false;
  }
}

/**
 * Whether this name can only ever hold a primitive.
 *
 * The narrowest proof that still covers what obfuscated code emits, `var _0x1 =
 * 0x2` read as `-_0x1`: a binding nothing assigns to holds its literal
 * initialiser, or `undefined` before the declarator runs, and neither has a
 * `valueOf` to call. A `param` or `module` binding takes its value from a caller
 * or another module, a function or class binding holds an object, and a free
 * name is a property of the global object - none of those can be proved here. A
 * destructuring target is refused with them, because `var { constructor: c } =
 * 'abc'` binds a literal's constructor, which is a function. A BigInt
 * initialiser is refused with them, for the reason in the module header.
 */
function isPrimitiveBinding(node: t.Identifier, scope: Scope): boolean {
  const binding = scope.getBinding(node.name);
  if (!binding) return false;
  if (binding.kind !== 'var' && binding.kind !== 'let' && binding.kind !== 'const') return false;
  // Any later write can store an object, whatever the initialiser was.
  if (!binding.constant) return false;
  const declarator = binding.path;
  if (!declarator.isVariableDeclarator() || !t.isIdentifier(declarator.node.id)) return false;
  const init = declarator.node.init;
  return (
    t.isStringLiteral(init) ||
    t.isNumericLiteral(init) ||
    t.isBooleanLiteral(init) ||
    t.isNullLiteral(init)
  );
}
