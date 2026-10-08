import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts, type StringCodeFacts } from '../../analysis/string-code.js';
import { refreshStringCodeFacts } from '../../analysis/string-code-sites.js';
import { builtinWritten } from '../../analysis/evaluator/index.js';
import { StatementScanCache } from '../../analysis/slice.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import {
  holdsDeclaredValue,
  insideWith,
  isPureContext,
  shadowedByBlockFunction,
  staticString,
  TreeOrder,
  type BlockFunctionMemo,
} from '../../util/ast.js';
import { isSideEffectFree } from '../../util/purity.js';

type Primitive = string | number | boolean | null | undefined;

/**
 * A value the evaluator can carry. Arrays mostly exist only *between* the links
 * of a method chain - `'a,b'.split(',').join('-')` has to hold one to reach the
 * result - and `literalFor` cannot spell one, so a chain that ends on an array
 * is left as it was written. `foldSpreads` is the single exception, and it
 * writes the elements into a literal that already exists rather than
 * materialising an array of its own.
 */
type Value = Primitive | Value[];

/**
 * A resolved compile-time value. The wrapper exists so that "resolved to
 * `undefined`" is distinguishable from "could not resolve".
 */
interface Constant {
  value: Primitive;
}

interface Resolved {
  value: Value;
}

/**
 * Where a name is resolved, and what can rewrite that name from outside the
 * tree. Every resolver below takes one.
 *
 * This is the same migration this file has already been through once, one step
 * further along. The resolvers used to take a bare `Scope`; they took a
 * `NodePath` because a scope cannot answer `with (o) { ... }` - inside that body
 * every name is looked up on the object first, at run time, and no binding
 * exists for the scope to report, so a helper holding only a scope can never
 * call `insideWith`, and seven of them folded reads the object environment
 * intercepts. The scope is still there, at `site.path.scope`; what the path
 * added is POSITION.
 *
 * A position does not answer the other half. Every proof in this file is an
 * account of `binding.referencePaths` and `binding.constantViolations`, and
 * both are SYNTACTIC ENUMERATIONS of the tree: `eval('T = [9, 2]')` writes `T`
 * without appearing in either list, so a table this file proved "written
 * nowhere else" is rewritten between the declarator and the read. That is not a
 * variant of the `with` question - `with` intercepts a name at a POSITION,
 * string code writes it at a TIME - but it lands in the same place, on a name
 * this pass resolves to a value, so it travels with the position.
 * `site.strings` is the shared answer from `analysis/string-code.ts`, computed
 * once per fixpoint iteration for the whole program and asked here as a
 * property read or a set lookup.
 *
 * The position is re-based exactly twice, at the two points where the names
 * being resolved stop belonging to the caller's position: `resolveWrapperCall`
 * re-bases to the wrapper's own path, because a wrapper body's free names mean
 * what they meant where it was written, and `resolveFrozenTable` re-bases to
 * the declarator's, for the same reason about the table's elements. Those two
 * are why guarding the visitor entry points would not have been enough - the
 * `with` a wrapper body sits in is one its call site need not be in, and
 * `foldCall` passes its own guard there. The facts do not re-base: they are a
 * statement about the program, not about a place in it.
 *
 * `site.path` is an ANCESTOR of the node being resolved rather than that node's
 * own path, and for a substituted wrapper body it is the position of a node
 * that is not in the tree at all. That is sound for this question and only this
 * one: a `with` is a statement, so every node inside an expression is inside
 * exactly the `with` statements the position it hangs from is inside.
 */
interface Site {
  /** The position the names being resolved are read from. */
  readonly path: NodePath;
  /** What code compiled from a string can reach in this program. */
  readonly strings: StringCodeFacts;
  /**
   * Which var scopes hoist which sloppy block-level functions, remembered for
   * the traversal - the third writer of a name that neither list above shows,
   * asked by the two resolvers that trust a binding's declaration.
   */
  readonly blockFunctions: BlockFunctionMemo;
  /**
   * The tree numbered as it stands, for the ordering proof the two resolvers
   * that trust a declarator's VALUE make - `holdsDeclaredValue` says why an
   * offset is not that. Per traversal, like the memo, and for the same
   * reason: nothing this visitor does moves a statement.
   */
  readonly order: TreeOrder | undefined;
  /**
   * The node whose place stands for every read made from this site, when
   * that is not the read itself: a re-based site resolves a wrapper body
   * that is not in the tree, and the wrapper is where that body runs from.
   */
  readonly at: t.Node | undefined;
  /** The program's writes to the builtins a fold would run; see {@link WriteJudge}. */
  readonly writes: WriteJudge;
}

/** The site a visitor handler starts from. */
function siteOf(
  path: NodePath,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder | undefined,
  writes: WriteJudge,
): Site {
  return { path, strings, blockFunctions, order, at: undefined, writes };
}

/** The same program at a different position - {@link Site}'s two re-bases. */
function rebase(site: Site, path: NodePath): Site {
  return { path, strings: site.strings, blockFunctions: site.blockFunctions, order: site.order, at: path.node, writes: site.writes };
}

/** The three global value properties a bare name can denote without a binding. */
const VALUE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);

/**
 * Ceiling on any string this pass is willing to materialise. Obfuscated input is
 * adversarial: `'x'.repeat(1e9)` and long `+` chains are cheap to write and
 * would otherwise let the input dictate this pass's memory use.
 */
const MAX_FOLDED_STRING = 32_768;
const MAX_STATIC_CALL_ARGS = 1_024;
/** The same ceiling for the array a chain passes through, e.g. `split('')`. */
const MAX_FOLDED_ELEMENTS = 8_192;
/**
 * Ceiling on an array literal this pass is willing to *write*, which is a
 * tighter question than what it is willing to carry: every element becomes a
 * node in the output. The real vectors this exists for are 75 to 99 long.
 */
const MAX_FOLDED_ARRAY = 4_096;
/** Chains are two or three links in practice; the cap bounds the recursion. */
const MAX_CHAIN_DEPTH = 16;

const FOLDABLE_BINARY = new Set([
  '+', '-', '*', '/', '%', '**',
  '==', '!=', '===', '!==', '<', '<=', '>', '>=',
  '<<', '>>', '>>>', '&', '|', '^',
]);

const GLOBAL_FUNCTIONS = new Set(['parseInt', 'parseFloat', 'Number', 'String', 'Boolean']);
const STRING_STATICS = new Set(['fromCharCode', 'fromCodePoint']);

/**
 * String methods that are pure and locale-independent. `toLocaleUpperCase` and
 * friends are deliberately absent: their result depends on the host locale, so
 * folding them at build time is not meaning-preserving. So are `match`, `search`
 * and `matchAll`, which take a regex - an object with mutable `lastIndex` state
 * that a fold would erase.
 */
const STRING_METHODS = new Set([
  'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes',
  'indexOf', 'lastIndexOf', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll',
  'slice', 'split', 'startsWith', 'substr', 'substring', 'toLowerCase', 'toUpperCase',
  'trim', 'trimEnd', 'trimStart',
]);

/** String methods whose output length is driven by a numeric argument. */
const LENGTH_DRIVEN_METHODS = new Set(['padEnd', 'padStart', 'repeat']);

const NUMBER_METHODS = new Set(['toExponential', 'toFixed', 'toPrecision', 'toString']);

/**
 * Array methods that are pure on a value the evaluator built itself.
 *
 * `reverse` mutates its receiver, which is only sound here because the receiver
 * is either an array literal - a fresh array on every evaluation, so nobody can
 * observe the mutation - or a value this evaluator just synthesised. `sort` is
 * absent because it takes a comparator, and `flat`/`flatMap`/`map` because they
 * either take a callback or need a depth argument to bound their output.
 */
const ARRAY_METHODS = new Set([
  'at', 'concat', 'includes', 'indexOf', 'join', 'lastIndexOf', 'reverse', 'slice',
  'toString',
]);

/**
 * Array members that cannot change the receiver, used to decide whether a
 * *source* array in the program is still the array its literal describes.
 *
 * Wider than `ARRAY_METHODS` in one direction: this list answers "does the
 * program mutate the table" rather than "can the evaluator run it", so a `flat`
 * the evaluator refuses still proves nothing was written. `reverse` is on that
 * list and not this one - the evaluator only ever reverses a copy it built
 * itself, whereas `T.reverse()` in the source reorders the real table.
 *
 * Narrower in another, and this is the part that is easy to get wrong. Every
 * callback-taking method on `Array.prototype` hands the callback *the receiver
 * itself* as a trailing argument, so it offers a write to the table through a
 * name that is not the table's:
 *
 * ```js
 * var T = [1, 2, 3];
 * T.forEach(function (v, i, a) { a[0] = 9; });   // T is now [9, 2, 3]
 * ```
 *
 * `map`, `filter`, `find`, `findIndex`, `findLast`, `findLastIndex`, `some`,
 * `every` and `flatMap` pass it in the same position, and `reduce` and
 * `reduceRight` one slot further along. Each of them is therefore a way to prove
 * a table frozen that the program then rewrites - a fold, on by default, to a
 * value the running program never holds. Deciding that a particular callback
 * leaves the receiver alone is a real analysis and there is not one here, so a
 * table any of them touches is simply not frozen.
 *
 * `flat` stays: it takes a depth, not a callback, and never exposes the
 * receiver. So do `entries`, `keys` and `values`, whose iterators yield
 * elements and hand out nothing that points at the array.
 */
const NON_MUTATING_ARRAY_MEMBERS = new Set([
  'at', 'concat', 'entries', 'flat', 'includes', 'indexOf', 'join', 'keys',
  'lastIndexOf', 'length', 'slice', 'toString', 'values',
]);

export const foldConstantsPass: Pass = {
  id: 'simplify.fold-constants',
  title: 'Fold constant expressions',
  stage: 'simplify',
  technique: 'literalSimplification',
  visitor: (ctx) => {
    // One question for the whole program, asked once for the whole traversal,
    // exactly as `clean/dead-branches` asks it: it is a fact about the tree
    // rather than about any one fold, and it is re-asked on the next fixpoint
    // iteration so that a hazard an earlier stage deleted stops costing
    // anything.
    //
    // Asking it per fold instead would cost a map lookup and buy nothing. The
    // two passes that could move string code to a new site inside this stage -
    // `simplify/proxy-functions` expanding a wrapper whose body is a direct
    // `eval`, and `simplify/object-maps` - are `run` passes, and those execute
    // after the merged visitor traversal this handler belongs to. The one
    // same-traversal rewrite that can turn an unclassified construct into a
    // classified one is `simplify/properties` folding `x['eval']` to `x.eval`,
    // and a per-fold call would read the same cached answer for it: the cure
    // named by `stringCodeFacts` is `invalidateStringCodeFacts` at that
    // rewrite, not a weaker cache or a more frequent question here.
    const strings = stringCodeFacts(ctx);
    // Also per traversal, and for the same reason: nothing this visitor does
    // adds a declaration, so what each var scope hoists is fixed for its length.
    const blockFunctions: BlockFunctionMemo = new Map();
    // And the tree's order, numbered on the first fold that asks: the same
    // traversal replaces expressions in place and moves no statement, so
    // what it numbers stays in order for its length.
    const order = new TreeOrder(ctx.ast);
    const writes = writeJudge(ctx);
    return {
      // Every handler runs on `exit` so the innermost operands are already
      // folded: `0x1 * 0x2 + 0x3` collapses to `5` in a single traversal.
      NumericLiteral: {
        exit: (path: NodePath<t.NumericLiteral>) => normalizeNumericForm(path, ctx),
      },
      UnaryExpression: {
        exit: (path: NodePath<t.UnaryExpression>) => foldUnary(path, ctx, strings, blockFunctions, order, writes),
      },
      BinaryExpression: {
        exit: (path: NodePath<t.BinaryExpression>) => foldBinary(path, ctx, strings, blockFunctions, order, writes),
      },
      LogicalExpression: {
        exit: (path: NodePath<t.LogicalExpression>) => foldLogical(path, ctx, strings, blockFunctions, order, writes),
      },
      ConditionalExpression: {
        exit: (path: NodePath<t.ConditionalExpression>) =>
          foldConditional(path, ctx, strings, blockFunctions, order, writes),
      },
      CallExpression: {
        exit: (path: NodePath<t.CallExpression>) => foldCall(path, ctx, strings, blockFunctions, order, writes),
      },
      ArrayExpression: {
        exit: (path: NodePath<t.ArrayExpression>) => foldSpreads(path, ctx, strings, blockFunctions, order, writes),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// String code
// ---------------------------------------------------------------------------

/**
 * Whether code compiled from a string can address this binding by its name.
 *
 * Named as `analysis/dispatcher.ts` names it, because it is the same question
 * asked for the same reason: every proof this file makes about a name is an
 * account of the lists Babel can SEE. `resolveFrozenTable` proves a table is
 * "written nowhere after its declarator" out of `constantViolations`, and
 * `resolveWrapperCall` proves a wrapper "is still the function inspected here"
 * out of the same list; `eval('T = [9, 2]')` and `Function('add = ...')()` write
 * both without leaving an entry in either, and `Function('return T')` reads one
 * without leaving a reference.
 *
 * The per-name question is the right one HERE, where it is the wrong one for a
 * pass that resolves a chain of names and rewrites a site spelling only the
 * last link (see {@link StringCodeFacts.addressesAnyOwnBinding}). This
 * evaluator has no such chain: it never follows an alias, because the only
 * shapes it will follow a name to are an array literal (`resolveFrozenTable`)
 * and a function (`resolveWrapperCall`), and it asks this question again at
 * every hop - `part(0, 2)` asks about `part`, and the `T` inside its body asks
 * about `T`, at the wrapper's own position.
 *
 * Refusing here does not always cost output, which is worth knowing before
 * reading a byte count as a loss. On `obfuscated4.js` - one direct `eval`,
 * three `Function` constructors - this refusal keeps 90-element entry vectors
 * written as `[...part(0, 8), -9, ...]` instead of splicing them out, and the
 * file comes out 13,684 bytes SMALLER at `balanced` and 13,592 at `aggressive`
 * than with the question unasked. The machines are still lifted:
 * `structure/register-vm` reads those vectors through the entry point below,
 * which is not on this path.
 */
function addressableByStringCode(binding: Binding, site: Site): boolean {
  return site.strings.addresses(binding);
}

/**
 * Whether string code can put a BINDING in front of an unbound global name here
 * - the half of the question that has no binding to ask about.
 *
 * `undefined`, `NaN` and `Infinity` are foldable at all because they are
 * non-writable, non-configurable properties of the global object, so nothing
 * can assign to them: `Function('undefined = 5')()` and `(0, eval)('var
 * undefined = 5')` both leave the value alone (measured on node 24, not
 * argued), and a global `function undefined(){}` throws rather than redefining.
 * What is left is the one construct that can introduce a NEW binding the read
 * resolves to first: a sloppy direct `eval`, whose `var` lands in the enclosing
 * function's variable environment. `eval('var undefined = 5')` inside a
 * function makes `typeof undefined` `'number'` there.
 *
 * That is the capture half {@link StringCodeFacts} documents as `ScopeFreezer`'s
 * rather than its own, so it is composed here instead of asked. The composition
 * is `reaches` over the position's ancestor scopes - and it collapses:
 * `reaches` is true for every scope from an `eval` call site UP to the program,
 * the program is on every such chain, and the program is an ancestor of every
 * position, so any direct `eval` anywhere answers true for every site in the
 * file. The walk is therefore not written; `directEval` is the same answer for
 * one property read. The precision that costs is real - an `eval` in a sibling
 * function cannot bind anything this position resolves to - and it is not
 * recoverable from `reaches`, which reports scopes below a call site and not
 * the variable environment its `var` lands in.
 */
function evalCanShadowHere(site: Site): boolean {
  return site.strings.directEval;
}

/**
 * Whether string code can make one of the global FUNCTIONS this pass runs mean
 * something else here.
 *
 * Two ways, and unlike the three value globals above, both are open. A direct
 * `eval` can declare `var parseInt = function () { return 99; }` in the
 * enclosing scope, exactly as in {@link evalCanShadowHere}; and `parseInt`,
 * `String` and the rest are ORDINARY writable properties of the global object,
 * so any global-scope construct can replace one - `Function('parseInt =
 * function () { return 99 }')()` makes `parseInt('12')` answer 99 - needing no
 * binding to do it. The union of the two is `!empty`.
 *
 * Deliberately NOT the per-name {@link StringCodeFacts.addresses}, and the
 * reason is that a builtin is not a program-scope binding: the name narrowing
 * that module applies is about names the PROGRAM declares, and the module
 * narrowing beside it - a module's top level is invisible to global code - does
 * not apply either, because `parseInt` is a property of the global object
 * whatever the program's source type is. The public API is keyed on a
 * `Binding`, and an unbound builtin has none to hand it.
 *
 * What this does NOT close, and what nothing in the engine closes: a write to
 * the same builtin from code that IS in the tree. `parseInt = f;` at the top of
 * a file leaves no binding either, and this pass folds `parseInt('12')`
 * underneath it today exactly as it did before. That is the closed-world
 * assumption about builtins the engine makes everywhere - `analysis/evaluator`
 * runs a native `split`, `foldSpreads` below walks a native array iterator -
 * and it is held identically for visible and invisible writes.
 *
 * This is the one refusal in this file that costs output on the fixture set,
 * and the whole of it is 244 bytes in one cell: `obfuscated3.js` at
 * `conservative`, where four `String.fromCharCode(112, 108, ...)` calls stay as
 * they are instead of folding to `'app.example.com'`, because the file carries
 * `Function` constructors. A `spells(name)` predicate on `StringCodeFacts` -
 * "can any global-scope source in this program write this name" - is what would
 * buy those back soundly, and it is the same predicate the per-name arm above
 * already has internally but cannot answer for a name with no binding.
 */
function builtinRebindableByStringCode(site: Site): boolean {
  return !site.strings.empty;
}

/**
 * The fourth writer of a builtin, and the one the scope, `with` and string
 * code never show: the program itself, by assignment. `String.fromCharCode =
 * g` by name, `K.fromCharCode = g` through a hand-off of `String`, `Object
 * .defineProperty(String.prototype, ...)` by reflection - the decoder builder
 * refuses a slice that reads any of them, and a fold that runs the same
 * builtin in place is the same slice with one statement.
 */
interface WriteJudge {
  /**
   * Why `call` - which reads the builtins named in `outside`, and calls
   * whatever it calls on a value - must not be folded; `undefined` when
   * nothing the program writes reaches it.
   */
  refusal(call: t.CallExpression, outside: readonly string[], site: Site): string | undefined;
  /** A fold changed the spelling of a write: the next question reads the tree again. */
  rewrote(path: NodePath): void;
}

/**
 * The index behind the judge is built on the first question of a traversal
 * and kept for its length: nothing this visitor does adds or moves a write.
 */
function writeJudge(ctx: PassContext): WriteJudge {
  let scans: StatementScanCache | undefined;
  return {
    rewrote: (path) => {
      if (scans !== undefined && underWrite(path)) scans = undefined;
    },
    refusal: (call, outside, site) => {
      const program = site.path.scope.getProgramParent().path as NodePath<t.Program>;
      scans ??= new StatementScanCache();
      const reason = builtinWritten(program, [t.expressionStatement(call)], outside, ctx.config, scans, (severity, message) =>
        ctx.note(severity, message, undefined, message),
      );
      if (reason !== undefined) {
        const message = `Left ${spellCallee(call)}(...) as written: ${reason}.`;
        ctx.note('info', message, call.loc, message);
      }
      return reason;
    },
  };
}

/** For the entry point without a context; see {@link STRING_CODE_NOT_ASKED}, whose caveat is this one's. */
const WRITES_NOT_ASKED: WriteJudge = { refusal: () => undefined, rewrote: () => {} };

/**
 * Whether a node is part of what a write is made on or under: the left of an
 * assignment, or an argument of a call on `Object` or `Reflect`. A key folded
 * there - `String[String.fromCharCode(...)] = g` to `String.fromCharCode = g` -
 * is a write the index read under another spelling.
 */
function underWrite(path: NodePath): boolean {
  let current: NodePath | null = path;
  for (let depth = 0; current && depth < 8; depth++, current = current.parentPath) {
    const parent: NodePath | null = current.parentPath;
    if (!parent) return false;
    if (parent.isAssignmentExpression() && parent.node.left === current.node) return true;
    if (parent.isUpdateExpression()) return true;
    if (parent.isCallExpression() || parent.isNewExpression()) {
      const callee = parent.node.callee;
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && (callee.object.name === 'Object' || callee.object.name === 'Reflect')) return true;
    }
    if (parent.isStatement()) return false;
  }
  return false;
}

function spellCallee(call: t.CallExpression): string {
  const callee = call.callee;
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee)) {
    const key = memberKey(callee);
    const object = t.isIdentifier(callee.object) ? callee.object.name : t.isStringLiteral(callee.object) ? 'a string' : t.isNumericLiteral(callee.object) ? 'a number' : t.isArrayExpression(callee.object) ? 'an array' : 'a value';
    return key === undefined ? `${object}[...]` : `${object}.${key}`;
  }
  return 'a call';
}

/**
 * What {@link resolveNumericVector} assumes when its caller does not ask: that
 * the program contains no string code.
 *
 * `analysis/dispatcher.ts` meets the same absent argument and reads it as the
 * HAZARD, which is the right default for a proof and the one this file would
 * take if the choice were local. It is not. The only caller in `src` is
 * `structure/register-vm.ts`, and refusing here would not make that pass sound:
 * the three claims it makes either side of this call - `constantViolations`
 * names no reassignment of the dispatcher, every `referencePath` is a direct
 * call, the one entry vector is the whole answer - are accounts of the same two
 * syntactic lists and are unasked in exactly the same way. A refusal here would
 * delete that pass's recoveries and leave the hazard it is aimed at reachable
 * through three other doors.
 *
 * That pass holds a `PassContext`, so the repair is one argument at its call
 * site - `resolveNumericVector(argument, stringCodeFacts(ctx))` - made where
 * the other three claims can be repaired in the same edit. Until then this
 * constant is a description of the caller that is there, not a default the
 * engine chose: nothing on the pass's own path reaches it, because every fold
 * the visitor starts carries the real facts.
 *
 * The price of the other choice is measured rather than guessed: with this
 * constant set to the hazard, 5 tests fail - `register-vm.test.ts`'s "reads the
 * entry vector through a frozen table and a pure slice helper", whose fixture
 * compiles no string at all, and the four `register-vm-equivalence` cases over
 * `obfuscated4.js`. What the repair itself would cost on that fixture is a
 * question for the file that makes it: `obfuscated4.js` holds both hazards (one
 * direct `eval`, three `Function` constructors), so the facts there are not
 * empty and some of those lifts may be refusals rather than recoveries. That is
 * a measurement to take beside the other three claims, not here.
 */
const STRING_CODE_NOT_ASKED: StringCodeFacts = {
  global: false,
  directEval: false,
  empty: true,
  reaches: () => false,
  addresses: () => false,
  addressesName: () => false,
  addressesAnyOwnBinding: () => false,
  spells: () => false,
  unreadGlobalSource: undefined,
};

/**
 * Drop a numeric literal's original spelling so the generator re-prints it in
 * decimal - but only when decimal is no longer than what the author wrote, so
 * `1e21` and `.5` keep their compact forms while `0x1f` becomes `31`.
 */
function normalizeNumericForm(path: NodePath<t.NumericLiteral>, ctx: PassContext): void {
  const raw = path.node.extra?.['raw'];
  if (typeof raw !== 'string') return;
  if (t.isTSLiteralType(path.parent)) return;
  const decimal = String(path.node.value);
  if (decimal === raw || decimal.length > raw.length) return;
  path.node.extra = undefined;
  ctx.markChanged();
}

function foldUnary(
  path: NodePath<t.UnaryExpression>,
  ctx: PassContext,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
  writes: WriteJudge,
): void {
  // `-1` is already the canonical spelling of a negative literal; re-emitting it
  // would report a change on every fixpoint iteration and never terminate.
  if (path.node.operator === '-' && t.isNumericLiteral(path.node.argument)) return;
  const site = siteOf(path, strings, blockFunctions, order, writes);
  const constant = evaluateUnary(path.node, site);
  if (constant) replaceWithConstant(site, constant.value, ctx);
}

function foldBinary(
  path: NodePath<t.BinaryExpression>,
  ctx: PassContext,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
  writes: WriteJudge,
): void {
  const { node } = path;
  if (!FOLDABLE_BINARY.has(node.operator)) return;
  const site = siteOf(path, strings, blockFunctions, order, writes);
  const left = constantOf(node.left, site);
  const right = constantOf(node.right, site);
  if (!left || !right) return;
  if (
    node.operator === '+' &&
    typeof left.value === 'string' &&
    typeof right.value === 'string' &&
    left.value.length + right.value.length > MAX_FOLDED_STRING
  ) {
    return;
  }
  replaceWithConstant(site, applyBinary(node.operator, left.value, right.value), ctx);
}

function foldLogical(
  path: NodePath<t.LogicalExpression>,
  ctx: PassContext,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
  writes: WriteJudge,
): void {
  const { node } = path;
  const site = siteOf(path, strings, blockFunctions, order, writes);

  if (node.operator === '??') {
    const left = constantOf(node.left, site);
    if (left) {
      keepBranch(path, left.value === null || left.value === undefined ? node.right : node.left, ctx);
      return;
    }
    // Array, object and function literals are never nullish, so `?? right` is dead.
    if (isNeverNullish(node.left)) keepBranch(path, node.left, ctx);
    return;
  }

  const truthy = staticTruthiness(node.left, site);
  if (truthy === undefined) return;
  const takesRight = node.operator === '&&' ? truthy : !truthy;
  keepBranch(path, takesRight ? node.right : node.left, ctx);
}

function foldConditional(
  path: NodePath<t.ConditionalExpression>,
  ctx: PassContext,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
  writes: WriteJudge,
): void {
  const truthy = staticTruthiness(path.node.test, siteOf(path, strings, blockFunctions, order, writes));
  if (truthy === undefined) return;
  keepBranch(path, truthy ? path.node.consequent : path.node.alternate, ctx);
}

/**
 * Fold a call whose whole chain is decidable, e.g. the reversed-domain idiom
 * `'moc.elpmaxe.ppa'.split('').reverse().join('')` -> `'app.example.com'`.
 *
 * Refused outright inside a `with` body. Four of the resolvers below follow a
 * name to something - a binding, a wrapper, a table, a built-in - and inside
 * `with (o) { ... }` every name is looked up on `o` first, at run time, so the
 * thing this pass proved constant may not be the one the call reaches.
 *
 * Each of those four now carries its own position and makes its own refusal;
 * this outer one is the coarser claim and is kept deliberately. It costs a
 * chain that consults no name at all - `'a,b'.split(',').join('-')` inside a
 * `with` is decidable and is given up here - and it buys the property that a
 * resolver added below inherits a refusal instead of a hazard.
 *
 * Only a *primitive* result is written back. The array in the middle of that
 * chain is real to the evaluator and never to the output: emitting it would
 * turn one short literal into twelve, and the next link folds it away anyway.
 * That also makes the pass idempotent for free - a lone `'ab'.split('')` is
 * left exactly as written, so there is nothing for a second run to revisit.
 */
function foldCall(
  path: NodePath<t.CallExpression>,
  ctx: PassContext,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
  writes: WriteJudge,
): void {
  if (insideWith(path)) return;
  const site = siteOf(path, strings, blockFunctions, order, writes);
  const resolved = resolveCall(path.node, site, 0);
  if (!resolved || Array.isArray(resolved.value)) return;
  replaceWithConstant(site, resolved.value, ctx);
}

/**
 * Splice a spread of a statically known array into the literal that holds it:
 * `[...T.slice(0, 3), 9]` -> `[1, 2, 3, 9]`.
 *
 * This is the one place the pass writes an array out, and it is deliberately
 * the only one. A standalone `'a,b'.split(',')` stays as it is written, because
 * materialising it turns one short literal into twelve and the next link of the
 * chain folds it away anyway - but a spread has no next link. The elements it
 * contributes are already destined for the enclosing literal, so writing them
 * there shortens the program instead of lengthening it, and it is what turns an
 * argument nobody can read into an array literal every later pass can.
 *
 * Equivalent under the same assumption every fold in this file already makes:
 * that the built-ins are the built-ins. Spreading a plain array walks
 * `Array.prototype[Symbol.iterator]`, which yields exactly the elements the
 * literal describes; a program that has replaced the array iterator has already
 * invalidated `slice`, `join` and everything else folded here.
 */
function foldSpreads(
  path: NodePath<t.ArrayExpression>,
  ctx: PassContext,
  strings: StringCodeFacts,
  blockFunctions: BlockFunctionMemo,
  order: TreeOrder,
  writes: WriteJudge,
): void {
  const { elements } = path.node;
  if (!elements.some((element) => t.isSpreadElement(element))) return;
  if (insideWith(path)) return;
  const site = siteOf(path, strings, blockFunctions, order, writes);

  const folded: Array<t.Expression | t.SpreadElement | null> = [];
  let changed = false;
  for (const element of elements) {
    if (!t.isSpreadElement(element)) {
      folded.push(element);
      continue;
    }
    const spliced = spreadElements(element.argument, site);
    if (!spliced) {
      folded.push(element);
      continue;
    }
    // The cap is on the result, so a hostile `[...a, ...a, ...a]` cannot buy
    // more output than one fold's worth.
    if (folded.length + spliced.length > MAX_FOLDED_ARRAY) return;
    folded.push(...spliced);
    changed = true;
  }
  if (!changed) return;

  path.node.elements = folded;
  ctx.markChanged(folded.length);
}

/**
 * The numbers an array literal stands for, spreads included, or nothing when
 * any part of it is not decidable.
 *
 * Exported for `structure.register-vm`, whose entry vectors are written in
 * exactly the shape this file's frozen-table resolver exists for:
 * `f([...part(0, 8), -9, 799, ...part(13, 17)])`. That pass needs the *value*
 * rather than a rewrite, and it needs it whether or not `foldSpreads` has
 * already run over the same literal - depending on another pass having folded
 * first would make its recoveries an accident of pass order.
 *
 * Reusing this resolver rather than `analysis/evaluator` is deliberate, and the
 * reason is the proof rather than the arithmetic: the evaluator's slice check
 * asks whether a decoder reaches outside the sandbox, which is a different
 * question from whether the table it reads is *frozen*. `resolveFrozenTable`
 * and `resolveWrapperCall` above are what establish that the table is never
 * written and that the helper is a single pure returned expression, and those
 * are exactly the two things a wrong answer here would turn into a confident
 * wrong trace.
 *
 * `strings` is the same fact the pass hands every fold, and this entry point
 * cannot take it from a `PassContext` because it has none. Its caller has one.
 * See {@link STRING_CODE_NOT_ASKED} for what the default means and what it
 * leaves open. `order` is the tree's numbering for the ordering proof, which
 * a caller working on an unpacked or re-sequenced tree has to supply, since
 * the offsets there no longer say what runs before what.
 */
export function resolveNumericVector(
  path: NodePath<t.ArrayExpression>,
  strings: StringCodeFacts = STRING_CODE_NOT_ASKED,
  order?: TreeOrder,
): number[] | undefined {
  // A `with` block can make any of these names a property lookup instead, which
  // is the one thing `scope.getBinding` cannot see.
  if (insideWith(path)) return undefined;
  // A fresh memo: one vector resolves a handful of names, and this entry point
  // has no traversal to share one across. The order is the caller's to share,
  // and to leave out where source offsets still tell the truth.
  const site = siteOf(path, strings, new Map(), order, WRITES_NOT_ASKED);
  const { node } = path;
  if (node.elements.length > MAX_FOLDED_ARRAY) return undefined;
  const numbers: number[] = [];
  const push = (value: Value): boolean => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    numbers.push(value);
    return numbers.length <= MAX_FOLDED_ARRAY;
  };

  for (const element of node.elements) {
    // A hole reads as `undefined`, which is not a register value.
    if (!element) return undefined;
    if (t.isSpreadElement(element)) {
      const spread = resolveValue(element.argument, site, 0);
      if (!spread || !Array.isArray(spread.value)) return undefined;
      for (const value of spread.value) if (!push(value)) return undefined;
      continue;
    }
    const resolved = resolveValue(element, site, 0);
    if (!resolved || !push(resolved.value)) return undefined;
  }
  return numbers;
}

/** The literals a spread argument stands for, or nothing if it is not decidable. */
function spreadElements(node: t.Expression, site: Site): t.Expression[] | undefined {
  const resolved = resolveValue(node, site, 0);
  if (!resolved || !Array.isArray(resolved.value)) return undefined;
  if (resolved.value.length > MAX_FOLDED_ARRAY) return undefined;

  const literals: t.Expression[] = [];
  for (const value of resolved.value) {
    // A nested array has no literal form here: writing `[[1], 2]` back would be
    // correct but is a shape this pass has never had to produce.
    if (Array.isArray(value)) return undefined;
    const literal = literalFor(value, site);
    if (!literal) return undefined;
    literals.push(literal);
  }
  return literals;
}

/**
 * Evaluate a call, recursing through its receiver.
 *
 * Nothing here can run user code: the callee must be an unshadowed built-in
 * from one of the whitelists, and every receiver and argument must bottom out
 * in a syntactic literal. A member read on anything else could be a getter, and
 * a getter has to actually run.
 */
function resolveCall(node: t.CallExpression, site: Site, depth: number): Resolved | undefined {
  if (depth > MAX_CHAIN_DEPTH) return undefined;
  const callee = node.callee;

  if (t.isIdentifier(callee)) {
    // "Unshadowed" is a claim about the binding AND about the position: inside
    // `with (o) { ... }` an `o.parseInt` is what this call reaches, and it leaves
    // no binding for the scope to report. It is also a claim about TIME, which
    // is the third thing neither of those sees - string code both declares and
    // assigns these names, and does it without a binding.
    if (GLOBAL_FUNCTIONS.has(callee.name) && !site.path.scope.getBinding(callee.name)) {
      if (insideWith(site.path)) return undefined;
      if (builtinRebindableByStringCode(site)) return undefined;
      if (shadowedByBlockFunction(callee.name, site.path.scope, undefined, site.blockFunctions)) return undefined;
      const args = constantArguments(node.arguments, site);
      if (!args || site.writes.refusal(node, [callee.name], site) !== undefined) return undefined;
      return invokeGlobal(callee.name, args);
    }
    return resolveWrapperCall(node, callee, site, depth);
  }

  if (!t.isMemberExpression(callee)) return undefined;
  const method = memberKey(callee);
  if (method === undefined) return undefined;
  const receiverNode = callee.object;

  // Same four questions about the name `String`, in the same order.
  if (
    t.isIdentifier(receiverNode) &&
    receiverNode.name === 'String' &&
    STRING_STATICS.has(method) &&
    !site.path.scope.getBinding('String') &&
    !insideWith(site.path) &&
    !builtinRebindableByStringCode(site) &&
    !shadowedByBlockFunction('String', site.path.scope, undefined, site.blockFunctions)
  ) {
    const args = constantArguments(node.arguments, site);
    if (!args || args.length > MAX_STATIC_CALL_ARGS) return undefined;
    const codes: number[] = [];
    for (const arg of args) {
      if (typeof arg !== 'number') return undefined;
      codes.push(arg);
    }
    if (site.writes.refusal(node, ['String'], site) !== undefined) return undefined;
    return guardSize(
      evaluateSafely(() =>
        method === 'fromCharCode' ? String.fromCharCode(...codes) : String.fromCodePoint(...codes),
      ),
    );
  }

  const receiver = resolveValue(receiverNode, site, depth + 1);
  if (!receiver) return undefined;
  const target = receiver.value;

  if (Array.isArray(target)) {
    if (!ARRAY_METHODS.has(method)) return undefined;
    const args = resolveArguments(node.arguments, site, depth + 1);
    if (!args || site.writes.refusal(node, [], site) !== undefined) return undefined;
    return guardSize(evaluateSafely(() => invokeMethod(target, method, args)));
  }

  const isString = typeof target === 'string' && STRING_METHODS.has(method);
  const isNumber = typeof target === 'number' && NUMBER_METHODS.has(method);
  if (!isString && !isNumber) return undefined;

  const args = constantArguments(node.arguments, site);
  if (!args) return undefined;
  if (
    LENGTH_DRIVEN_METHODS.has(method) &&
    args.some((arg) => typeof arg === 'number' && arg > MAX_FOLDED_STRING)
  ) {
    return undefined;
  }
  // A method of a literal is a prototype's, and the program may have written it.
  if (site.writes.refusal(node, [], site) !== undefined) return undefined;
  return guardSize(evaluateSafely(() => invokeMethod(target, method, args)));
}

/**
 * Resolve any expression the chain evaluator may meet as a receiver: a literal,
 * an array literal, or another call.
 */
function resolveValue(
  node: t.Node | null | undefined,
  site: Site,
  depth: number,
): Resolved | undefined {
  if (!node || depth > MAX_CHAIN_DEPTH) return undefined;
  const primitive = constantOf(node, site);
  if (primitive) return primitive;
  if (t.isArrayExpression(node)) return resolveArrayLiteral(node, site, depth);
  if (t.isCallExpression(node)) return resolveCall(node, site, depth);
  if (t.isIdentifier(node)) return resolveFrozenTable(node, site, depth);
  if (t.isBinaryExpression(node)) return resolveBinary(node, site, depth);
  return undefined;
}

/**
 * Arithmetic reached from inside the evaluator rather than from the visitor.
 *
 * `foldBinary` handles every operator expression the traversal walks past, but
 * a wrapper body is substituted and resolved without ever being in the tree, so
 * `part(1, 3)` would otherwise be decidable while `part(1, 3).length + 1` was
 * not. Same operators, same size guard, same refusal on anything non-primitive.
 */
function resolveBinary(
  node: t.BinaryExpression,
  site: Site,
  depth: number,
): Resolved | undefined {
  if (!FOLDABLE_BINARY.has(node.operator)) return undefined;
  if (t.isPrivateName(node.left)) return undefined;
  const left = resolveValue(node.left, site, depth + 1);
  const right = left && resolveValue(node.right, site, depth + 1);
  if (!left || !right) return undefined;
  if (Array.isArray(left.value) || Array.isArray(right.value)) return undefined;
  if (
    node.operator === '+' &&
    typeof left.value === 'string' &&
    typeof right.value === 'string' &&
    left.value.length + right.value.length > MAX_FOLDED_STRING
  ) {
    return undefined;
  }
  return guardSize({ value: applyBinary(node.operator, left.value, right.value) as Value });
}

/**
 * Fold a call to a local one-line wrapper by substituting its arguments.
 *
 * The obfuscated fixture does not slice its constant table in the open. Every
 * one of its 1,585 slices goes through the same forwarder:
 *
 * ```js
 * function slice(a, b) { return T.slice(a, b); }
 * ```
 *
 * `simplify.proxy-functions` is the pass that normally opens a forwarder, and
 * it refuses this one - correctly, on its own terms. Its templates may only
 * mention their parameters, because a free name "would have to resolve to the
 * same thing at every call site" and proving that is a different analysis. That
 * analysis is exactly what `resolveFrozenTable` below does, and it does it here,
 * so the free name is not an obstacle to *this* pass: the wrapper is not
 * inlined, it is evaluated, and only a value ever comes back.
 *
 * Nothing runs. The body has to be a single returned expression that this same
 * evaluator can decide once its parameters are literals - which means the
 * whitelists still gate every operation, `this` and `arguments` are unreachable
 * (neither has a substitution and neither resolves), and a wrapper that touched
 * anything outside them simply fails to resolve. Arity must match exactly:
 * fewer arguments than parameters means the body reads `undefined`, and writing
 * that out is a guess about intent.
 */
function resolveWrapperCall(
  node: t.CallExpression,
  callee: t.Identifier,
  site: Site,
  depth: number,
): Resolved | undefined {
  if (depth >= MAX_CHAIN_DEPTH) return undefined;
  const binding = site.path.scope.getBinding(callee.name);
  if (!binding) return undefined;
  // A reassigned name is not the function that was inspected here - and
  // `constantViolations` is an enumeration of the tree, so the reassignment has
  // to be IN it. `eval('add = function () { return 101; };')` leaves the list
  // empty and the template below describes a function the call no longer
  // reaches: `add(1, 1)` folded to `2` where the program answers `101`.
  if (addressableByStringCode(binding, site)) return undefined;
  if (binding.constantViolations.some((v) => v.node !== binding.path.node)) return undefined;
  // The third writer that list does not enumerate, and it is in the tree: a
  // sloppy `{ function add() {...} }` between here and the declaration assigns
  // the var-scoped `add` when its block runs, and Babel scopes it to the block.
  // `function a() { return 'outer'; } { function a() { return 'inner'; } }
  // log(a())` folded to `log('outer')` at every preset; the program prints
  // `inner`.
  if (shadowedByBlockFunction(callee.name, site.path.scope, binding, site.blockFunctions)) return undefined;
  // And the fourth, which is about TIME rather than about which binding the
  // name reaches: the declarator has to have run. Before it a `let` or
  // `const` throws and a `var` holds `undefined`, so the call is the throw the
  // program makes - `try { log(m()) } catch (e) { log(e.name) } const m = ()
  // => 'm'` prints `ReferenceError`, and folded to `log('m')` it printed `m`.
  // A hoisted `function` is exempt by kind. Asked at the callee's own
  // place - or, from a re-based site, at the wrapper whose body this call is
  // in, since the body runs no earlier than the wrapper is reached: a call
  // inside a hoisted function or a callback is placed by whoever calls THAT,
  // which is the climb the predicate makes.
  if (!holdsDeclaredValue(callee.name, site.at ?? callee, site.path.scope, site.strings, site.order)) {
    return undefined;
  }

  const fnPath = wrapperFunction(binding.path);
  if (!fnPath) return undefined;
  // Two positions, two refusals, and they are genuinely independent. The call
  // site decides whether `callee.name` reaches this binding at all. The
  // wrapper's OWN position decides what its body's free names mean, and that is
  // a `with` the call site need not be in:
  //
  //     var T = [1, 2, 3];
  //     function g(o) {
  //       with (o) { var w = function (a, b) { return T.slice(a, b).join('-'); }; }
  //       return w(0, 2);          // `T` is `o.T` when the body runs
  //     }
  //     g({ T: [9, 8, 7] });       // '9-8', folded to '1-2'
  //
  // That second refusal is why this could not be a guard on the four visitor
  // entry points: `foldCall` is outside the `with` on `w(0, 2)` and passes.
  if (insideWith(site.path) || insideWith(fnPath)) return undefined;
  const fn = fnPath.node as t.Function;
  if (fn.async || fn.generator) return undefined;

  const names: string[] = [];
  for (const param of fn.params) {
    if (!t.isIdentifier(param) || names.includes(param.name)) return undefined;
    names.push(param.name);
  }
  if (node.arguments.length !== names.length) return undefined;

  const returned = returnedExpression(fn);
  if (!returned) return undefined;

  const args = constantArguments(node.arguments, site);
  if (!args) return undefined;

  const substitutions = new Map<string, t.Expression>();
  for (let index = 0; index < names.length; index++) {
    const literal = literalFor(args[index], site);
    if (!literal) return undefined;
    substitutions.set(names[index]!, literal);
  }

  const body = substituteParams(returned, substitutions);
  if (!body) return undefined;
  // Resolved at the wrapper's own position, not the caller's: its free names
  // mean what they meant where the wrapper was written, and `fnPath.scope` is
  // that position's scope. The string-code facts travel unchanged - they
  // describe the program, and the wrapper is in the same program.
  return resolveValue(body, rebase(site, fnPath), depth + 1);
}

function wrapperFunction(declaration: NodePath): NodePath | undefined {
  if (declaration.isFunctionDeclaration()) return declaration;
  if (!declaration.isVariableDeclarator() || !t.isIdentifier(declaration.node.id)) return undefined;
  const init = declaration.get('init');
  if (Array.isArray(init)) return undefined;
  return init.isFunctionExpression() || init.isArrowFunctionExpression() ? init : undefined;
}

/** The single expression a one-line function returns, if that is all it does. */
function returnedExpression(fn: t.Function): t.Expression | undefined {
  if (!t.isBlockStatement(fn.body)) return fn.body;
  if (fn.body.body.length !== 1 || fn.body.directives.length > 0) return undefined;
  const [only] = fn.body.body;
  if (!t.isReturnStatement(only) || !only.argument) return undefined;
  return only.argument;
}

/**
 * Rebuild a wrapper body with its arguments in place of its parameters.
 *
 * Only the shapes `resolveValue` can consume are rebuilt, and anything else
 * refuses - so this is a second gate on the body rather than a best-effort
 * copy. The one position that must not be substituted is a static member key:
 * `T.a` names a property, not a read of a parameter called `a`.
 */
function substituteParams(
  node: t.Node,
  args: ReadonlyMap<string, t.Expression>,
): t.Expression | undefined {
  switch (node.type) {
    case 'Identifier':
      return args.get(node.name) ?? t.cloneNode(node, true);

    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return t.cloneNode(node, true);

    case 'UnaryExpression': {
      const argument = substituteParams(node.argument, args);
      return argument && t.unaryExpression(node.operator, argument, node.prefix);
    }

    case 'BinaryExpression': {
      if (t.isPrivateName(node.left)) return undefined;
      const left = substituteParams(node.left, args);
      const right = left && substituteParams(node.right, args);
      return right && t.binaryExpression(node.operator, left, right);
    }

    case 'MemberExpression': {
      const object = substituteParams(node.object, args);
      if (!object) return undefined;
      if (!node.computed) {
        if (!t.isIdentifier(node.property)) return undefined;
        return t.memberExpression(object, t.cloneNode(node.property, true), false);
      }
      const property = substituteParams(node.property, args);
      return property && t.memberExpression(object, property, true);
    }

    case 'CallExpression': {
      if (!t.isExpression(node.callee)) return undefined;
      const callee = substituteParams(node.callee, args);
      if (!callee) return undefined;
      const rebuilt: t.Expression[] = [];
      for (const argument of node.arguments) {
        const substituted = substituteParams(argument, args);
        if (!substituted) return undefined;
        rebuilt.push(substituted);
      }
      return t.callExpression(callee, rebuilt);
    }

    case 'ArrayExpression': {
      const elements: t.Expression[] = [];
      for (const element of node.elements) {
        if (!element) return undefined;
        const substituted = substituteParams(element, args);
        if (!substituted) return undefined;
        elements.push(substituted);
      }
      return t.arrayExpression(elements);
    }

    default:
      return undefined;
  }
}

/**
 * The one identifier this pass will follow to its binding: a constant table.
 *
 * Everywhere else the rule stands - resolving a name is the inlining passes'
 * job, and folding a read here would be wrong the moment a later assignment
 * invalidated it. A frozen numeric table is the case where that objection has
 * no purchase, and it is worth the carve-out because the obfuscated fixture
 * routes 1,585 slices through one:
 *
 * ```js
 * var T = [373, 872, -925, ...];        // 115 literals, written nowhere else
 * function slice(a, b) { return T.slice(a, b); }
 * f([...slice(0, 8), -9, ...]);          // an entry vector, one hop from concrete
 * ```
 *
 * Four separate facts make the read safe, and any one missing refuses:
 *
 * - the binding is never written after its declarator, so the name always
 *   denotes that array;
 * - every element is a syntactic literal, so the array's *contents* are the
 *   text and nothing computes them;
 * - every reference is a member read the program cannot mutate through - no
 *   bare use that could alias the array, and no call of a method that reorders
 *   or resizes it;
 * - no code compiled from a string can address the name. The first and third
 *   facts are read out of `constantViolations` and `referencePaths`, which
 *   enumerate what is IN the tree; `eval('T = [9, 2]')` is a write to `T` that
 *   appears in neither, and the two lists go on saying the table is frozen.
 *
 * Together those mean the table still holds exactly what the literal put there,
 * at every point in the program, which is a far stronger claim than `const`.
 */
function resolveFrozenTable(
  node: t.Identifier,
  site: Site,
  depth: number,
): Resolved | undefined {
  const binding = site.path.scope.getBinding(node.name);
  if (!binding || binding.constantViolations.length > 0) return undefined;

  const declarator = binding.path;
  if (!declarator.isVariableDeclarator() || !t.isIdentifier(declarator.node.id)) return undefined;
  const init = declarator.node.init;
  if (!t.isArrayExpression(init)) return undefined;
  if (init.elements.length > MAX_FOLDED_ELEMENTS) return undefined;
  // The same two positions `resolveWrapperCall` refuses on, and asked here only
  // once the shape above has already matched, so the climb is rare. The read
  // site decides whether `node.name` reaches this binding; the declarator's own
  // position decides what its element expressions mean.
  if (insideWith(site.path) || insideWith(declarator)) return undefined;
  // Asked in the same place and for the same reason as the two above, and it is
  // the fourth fact in the list: string code writes this name without entering
  // either list the loop below and the check above read.
  if (addressableByStringCode(binding, site)) return undefined;
  // And the fifth: a sloppy block-level `function T` between the read and the
  // declarator makes `T` the function once its block has run, with no entry
  // in `constantViolations`. `var T = ['x', 'y']; { function T() {} }
  // log(T.slice(0, 1).join(''))` folded to `log('x')`; the program throws.
  if (shadowedByBlockFunction(node.name, site.path.scope, binding, site.blockFunctions)) return undefined;
  // And the sixth, `resolveWrapperCall`'s fourth: "frozen" describes the
  // table from its declarator on, and before that a `const` throws and a
  // `var` is `undefined`. `try { log(T.slice(0, 1).join('')) } catch (e) {
  // log(e.name) } var T = [1, 2]` prints `TypeError`; folded, it printed `1`.
  if (!holdsDeclaredValue(node.name, site.at ?? node, site.path.scope, site.strings, site.order)) {
    return undefined;
  }

  for (const reference of binding.referencePaths) {
    if (!isFrozenTableRead(reference)) return undefined;
  }
  // Resolved at the declarator's position, not the reader's: the elements mean
  // whatever they meant where they were written.
  return resolveArrayLiteral(init, rebase(site, declarator), depth + 1);
}

/**
 * Whether one use of a table binding provably leaves the array as it found it.
 *
 * A bare reference is refused outright: `var u = T` or `f(T)` hands the array
 * to code this pass cannot see, and `u[0] = 9` mutates the same object without
 * ever mentioning `T`. What is left is a member access, which mutates only when
 * it is the target of a write - `isPureContext` answers that - or when it is
 * *called* and names a method that reorders or resizes. A member that is read
 * rather than called cannot mutate whatever key it uses, so a computed index is
 * fine there and only a called member needs its key pinned down.
 */
function isFrozenTableRead(reference: NodePath): boolean {
  const member = reference.parentPath;
  // `[...T]`, `f(...T)` and `{ ...T }` all copy the elements out and hand back
  // nothing that points at the array, so they cannot be the write that spoils it.
  if (member?.isSpreadElement()) return true;
  if (!member?.isMemberExpression()) return false;
  if (member.node.object !== reference.node) return false;
  if (!isPureContext(member)) return false;

  const call = member.parentPath;
  const isCalled = Boolean(call?.isCallExpression() && call.node.callee === member.node);
  if (!isCalled) return true;

  const key = memberKey(member.node);
  return key !== undefined && NON_MUTATING_ARRAY_MEMBERS.has(key);
}

/** `[1, 2, 3]` - every element present and constant; a hole or a spread is a bail-out. */
function resolveArrayLiteral(
  node: t.ArrayExpression,
  site: Site,
  depth: number,
): Resolved | undefined {
  if (node.elements.length > MAX_FOLDED_ELEMENTS) return undefined;
  const values: Value[] = [];
  for (const element of node.elements) {
    if (!element || t.isSpreadElement(element)) return undefined;
    const resolved = resolveValue(element, site, depth + 1);
    if (!resolved) return undefined;
    values.push(resolved.value);
  }
  return { value: values };
}

/** Arguments for an array method, which may themselves be arrays (`concat`). */
function resolveArguments(
  args: t.CallExpression['arguments'],
  site: Site,
  depth: number,
): Value[] | undefined {
  if (args.length > MAX_STATIC_CALL_ARGS) return undefined;
  const values: Value[] = [];
  for (const arg of args) {
    const resolved = resolveValue(arg, site, depth);
    if (!resolved) return undefined;
    values.push(resolved.value);
  }
  return values;
}

/** Refuse a result whose size the input, rather than this pass, chose. */
function guardSize(result: Resolved | undefined): Resolved | undefined {
  if (!result) return undefined;
  const { value } = result;
  if (typeof value === 'string' && value.length > MAX_FOLDED_STRING) return undefined;
  if (Array.isArray(value) && value.length > MAX_FOLDED_ELEMENTS) return undefined;
  return result;
}

// ---------------------------------------------------------------------------
// Static evaluation
// ---------------------------------------------------------------------------

/**
 * Resolve a node to a primitive, or `undefined` when it is not provably constant.
 *
 * Only syntactic literals and the three unshadowed value globals qualify. It
 * deliberately does not follow identifiers to their bindings - that is the
 * inlining passes' job, and doing it here would fold reads that a later
 * reassignment invalidates.
 */
function constantOf(node: t.Node | null | undefined, site: Site): Constant | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return { value: node.value };
    case 'NullLiteral':
      return { value: null };
    case 'TemplateLiteral': {
      const text = staticString(node);
      return text === undefined ? undefined : { value: text };
    }
    case 'Identifier': {
      // The three names are non-writable, non-configurable properties of the
      // global object, so with nothing bound the read is the value - and cannot
      // reach a getter either. Both premises are about a name, and a `with`
      // body breaks both: the lookup hits the object first, at run time, and it
      // leaves no binding behind for `getBinding` to report. `getBinding`
      // answers a different question, not a weaker version of this one.
      //
      // The same premises say a direct `eval` breaks them a third way, by
      // DECLARING the name: `eval('var undefined = 5')` in the enclosing scope
      // is the one construct that gets in front of a property nothing can
      // assign to. See {@link evalCanShadowHere}.
      //
      // Asked in this order because it is the only order that is free. The name
      // test is a set lookup on every identifier the pass meets, and the
      // string-code test a property read on a fact already computed;
      // `insideWith` walks to the root and is reached by three names.
      if (!VALUE_GLOBALS.has(node.name)) return undefined;
      if (evalCanShadowHere(site)) return undefined;
      if (site.path.scope.getBinding(node.name)) return undefined;
      if (insideWith(site.path)) return undefined;
      if (node.name === 'undefined') return { value: undefined };
      if (node.name === 'NaN') return { value: Number.NaN };
      return { value: Number.POSITIVE_INFINITY };
    }
    case 'UnaryExpression':
      return evaluateUnary(node, site);
    default:
      return undefined;
  }
}

function evaluateUnary(node: t.UnaryExpression, site: Site): Constant | undefined {
  switch (node.operator) {
    case 'typeof': {
      const typeName = staticTypeOf(node.argument, site);
      return typeName === undefined ? undefined : { value: typeName };
    }
    case '!': {
      const truthy = staticTruthiness(node.argument, site);
      return truthy === undefined ? undefined : { value: !truthy };
    }
    case 'void':
      // The purity oracle asks the `with` question too, and answers it exactly
      // when it is handed a position; without one it falls back to the scope's
      // own path and over-refuses whole scopes containing an unblocked `with`.
      // Now that there is a position to hand it, it gets one.
      return isSideEffectFree(node.argument, site.path.scope, { path: site.path })
        ? { value: undefined }
        : undefined;
    case '-':
    case '+':
    case '~': {
      const operand = constantOf(node.argument, site);
      if (!operand) return undefined;
      const numeric = Number(operand.value);
      if (node.operator === '-') return { value: -numeric };
      if (node.operator === '+') return { value: numeric };
      return { value: ~numeric };
    }
    default:
      return undefined;
  }
}

function staticTypeOf(node: t.Node, site: Site): string | undefined {
  const constant = constantOf(node, site);
  if (constant) return constant.value === null ? 'object' : typeof constant.value;
  if (t.isIdentifier(node)) {
    const held = objectHeldBy(node, site);
    if (held) return t.isFunction(held) || t.isClass(held) ? 'function' : 'object';
  }
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return 'function';
  if (t.isRegExpLiteral(node)) return 'object';
  if (t.isArrayExpression(node) || t.isObjectExpression(node)) {
    return isSideEffectFree(node, site.path.scope, { path: site.path }) ? 'object' : undefined;
  }
  return undefined;
}

/**
 * The object a name holds at this site - the array, object, function, class
 * or regex it was declared with and nothing reassigns - or nothing. An
 * object is truthy and its `typeof` is fixed, so `if (!T)` on a string table,
 * `typeof T === 'object'` and `T ? a : b` fold, and the table they kept
 * alive goes with the machinery. The same four things that make a
 * declarator's value trustworthy elsewhere in this file are asked: a read
 * the declaration holds at, a name string code cannot address, no sloppy
 * block function on the way, and no `with` around either end.
 */
function objectHeldBy(node: t.Identifier, site: Site): t.Node | undefined {
  const binding = site.path.scope.getBinding(node.name);
  if (!binding || binding.constantViolations.length > 0) return undefined;
  if (binding.kind === 'param' || binding.kind === 'module' || binding.kind === 'unknown') return undefined;
  const declared = binding.path;
  let held: t.Node | null | undefined;
  // A destructured declarator gives the name a piece of its initialiser, not the whole.
  if (declared.isVariableDeclarator()) held = t.isIdentifier(declared.node.id) ? declared.node.init : undefined;
  else if (declared.isFunctionDeclaration() || declared.isClassDeclaration()) held = declared.node;
  if (!held || !isObjectLiteral(held)) return undefined;
  if (insideWith(site.path) || insideWith(declared)) return undefined;
  if (addressableByStringCode(binding, site)) return undefined;
  if (shadowedByBlockFunction(node.name, site.path.scope, binding, site.blockFunctions)) return undefined;
  if (!holdsDeclaredValue(node.name, site.at ?? node, site.path.scope, site.strings, site.order)) return undefined;
  return held;
}

function isObjectLiteral(node: t.Node): boolean {
  return (
    t.isArrayExpression(node) ||
    t.isObjectExpression(node) ||
    t.isFunction(node) ||
    t.isClass(node) ||
    t.isRegExpLiteral(node)
  );
}

/** Truthiness of a node that can be evaluated without running anything. */
function staticTruthiness(node: t.Node, site: Site): boolean | undefined {
  const constant = constantOf(node, site);
  if (constant) return Boolean(constant.value);
  if (t.isIdentifier(node) && objectHeldBy(node, site)) return true;
  // Every object is truthy, so `![]` and `!{}` are decidable - provided building
  // the object itself cannot run user code.
  if (
    t.isArrayExpression(node) ||
    t.isObjectExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isRegExpLiteral(node)
  ) {
    return isSideEffectFree(node, site.path.scope, { path: site.path }) ? true : undefined;
  }
  return undefined;
}

/**
 * Whether this expression's value can never be `null` or `undefined`.
 *
 * A TYPE question, and the only thing `a ?? b` needs in order to drop `b`: the
 * `??` rewrite KEEPS `a`, so `a` is still evaluated afterwards and its purity is
 * nobody's business, while `b` was never going to be evaluated at all.
 *
 * Every shape here constructs a fresh object, and no object is nullish. The
 * primitives are absent because {@link constantOf} answers for them first, at
 * the one call site, with the actual value.
 */
function isNeverNullish(node: t.Node): boolean {
  return (
    t.isArrayExpression(node) ||
    t.isObjectExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isRegExpLiteral(node)
  );
}

/**
 * Both operands are already primitives, so the host's own operators implement
 * exactly the specified semantics; the `any` casts only silence TS's operand
 * checks, which cannot express "whatever JavaScript does with these two".
 */
function applyBinary(operator: string, left: Primitive, right: Primitive): unknown {
  const l = left as never;
  const r = right as never;
  switch (operator) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return l / r;
    case '%': return l % r;
    case '**': return l ** r;
    case '==': return l == r;
    case '!=': return l != r;
    case '===': return l === r;
    case '!==': return l !== r;
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
    case '<<': return l << r;
    case '>>': return l >> r;
    case '>>>': return l >>> r;
    case '&': return l & r;
    case '|': return l | r;
    case '^': return l ^ r;
    default: return undefined;
  }
}

/**
 * These five never throw on primitive arguments, so the only failure mode is an
 * arity not modelled here - reported as "no constant", never as a value.
 */
function invokeGlobal(name: string, args: readonly Primitive[]): Constant | undefined {
  switch (name) {
    case 'parseInt': {
      if (args.length < 1 || args.length > 2) return undefined;
      const radix = args[1];
      if (radix !== undefined && typeof radix !== 'number') return undefined;
      return { value: Number.parseInt(String(args[0]), radix) };
    }
    case 'parseFloat':
      return args.length === 1 ? { value: Number.parseFloat(String(args[0])) } : undefined;
    case 'Number':
      if (args.length > 1) return undefined;
      return { value: args.length === 0 ? 0 : Number(args[0]) };
    case 'String':
      return args.length === 1 ? { value: String(args[0]) } : undefined;
    case 'Boolean':
      if (args.length > 1) return undefined;
      return { value: args.length === 0 ? false : Boolean(args[0]) };
    default:
      return undefined;
  }
}

function invokeMethod(receiver: string | number | Value[], method: string, args: readonly Value[]): unknown {
  const fn = (receiver as unknown as Record<string, unknown>)[method];
  // `method` comes from a whitelist of built-ins, so this only ever reaches a
  // prototype method; a non-callable would throw into `evaluateSafely`.
  return (fn as (this: typeof receiver, ...rest: Value[]) => unknown).apply(receiver, [...args]);
}

/** Built-ins throw (RangeError on a bad radix, a bad repeat count, ...); that is a bail-out. */
function evaluateSafely(compute: () => unknown): Resolved | undefined {
  try {
    return { value: compute() as Value };
  } catch {
    return undefined;
  }
}

function constantArguments(
  args: t.CallExpression['arguments'],
  site: Site,
): Primitive[] | undefined {
  const values: Primitive[] = [];
  for (const arg of args) {
    const constant = constantOf(arg, site);
    if (!constant) return undefined;
    values.push(constant.value);
  }
  return values;
}

function memberKey(member: t.MemberExpression): string | undefined {
  if (!member.computed) return t.isIdentifier(member.property) ? member.property.name : undefined;
  return staticString(member.property);
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/**
 * Build the literal for a value, or refuse when no literal can express it.
 *
 * `NaN` and `±Infinity` have no literal form, and `-0` would print as `0` and
 * silently change `1 / x` from `-Infinity` to `Infinity`. Negative numbers are
 * emitted as a unary expression because that is what the grammar actually has.
 *
 * This is the WRITE side of the `undefined` question and the only place in
 * `src` that spells that name, so it needs the whole site for a reason no audit
 * of the readers reaches: guarding every read still leaves a fold whose RESULT
 * is `undefined` emitting a name the object environment answers, or the one a
 * direct `eval` declared.
 */
function literalFor(value: unknown, site: Site): t.Expression | undefined {
  switch (typeof value) {
    case 'string':
      if (value.length > MAX_FOLDED_STRING) return undefined;
      // A lone surrogate is a legal JavaScript string but not legal UTF-8, and
      // the generator prints it raw: writing the result to a file would replace
      // it with U+FFFD and silently change the value. `'😀'.split('')` produces
      // exactly that, so it is a real case rather than a theoretical one.
      return hasLoneSurrogate(value) ? undefined : t.stringLiteral(value);
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) return undefined;
      return value < 0 ? t.unaryExpression('-', t.numericLiteral(-value)) : t.numericLiteral(value);
    case 'boolean':
      return t.booleanLiteral(value);
    case 'undefined': {
      // `undefined` is an ordinary name in three ways, and a binding is only
      // the first. Inside a `with` body it is a property lookup on the object:
      // `with ({ undefined: 5 }) { LOG(void 0) }` prints `undefined`, and the
      // fold to `LOG(undefined)` prints `5`. And a direct `eval` DECLARES it:
      // `eval('var undefined = 5')` in this function makes the emitted name
      // read 5, so `var x = void 0` folded to `var x = undefined` puts 5 in
      // `x`. That is the reason this side needs the question at all - guarding
      // every read of the name still leaves a fold whose RESULT is `undefined`
      // spelling it out where the string code can answer.
      //
      // `void 0` is a spelling nothing can intercept, and it is deliberately
      // NOT emitted in its place. With `constantOf` refusing the name and
      // `foldCall`/`foldSpreads` refusing outright, the only fold that reaches
      // this arm inside a `with` is `void <side-effect-free>` - overwhelmingly
      // `void 0` itself, which would be replaced by a node equal to the one
      // already there and report a change on every fixpoint iteration. The
      // refusal gives up rewriting `void [1, 2]` inside a `with` and keeps the
      // pass terminating.
      if (site.path.scope.getBinding('undefined') || insideWith(site.path)) return undefined;
      if (evalCanShadowHere(site)) return undefined;
      return t.identifier('undefined');
    }
    case 'object':
      return value === null ? t.nullLiteral() : undefined;
    default:
      return undefined;
  }
}

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function replaceWithConstant(site: Site, value: unknown, ctx: PassContext): void {
  const replacement = literalFor(value, site);
  if (!replacement) return;
  const { path } = site;
  // A lone string statement is a directive: folding `'use' + ' strict';` into
  // `'use strict';` would switch the enclosing body into strict mode.
  if (t.isStringLiteral(replacement) && t.isExpressionStatement(path.parent)) return;
  path.replaceWith(t.inherits(replacement, path.node));
  ctx.markChanged();
  site.writes.rewrote(path);
  // `['log(dec(2))'].join('')` as a timer's argument is a call result until
  // this fold and a program after it, and the run passes of this stage delete
  // the declarations they inlined by what the facts say a string can reach.
  if (t.isStringLiteral(replacement)) refreshStringCodeFacts(ctx, path);
}

function keepBranch(path: NodePath, kept: t.Expression, ctx: PassContext): void {
  path.replaceWith(kept);
  ctx.markChanged();
}
