import _traverse, { type Binding, type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { parseSource } from '../frontend/language.js';
import { freezeHazardSite, readStaticString, type FreezeHazardSite } from '../naming/allocate.js';
import type { PassContext } from '../pipeline/context.js';
import { isGlobalThisSource } from './evaluator/global-object.js';

const EMPTY_NAMES: ReadonlySet<string> = new Set();

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Bound once: the bundle reaches `@babel/types` through esbuild's `__toESM`
 * namespace, where every member read is a getter, and the raw walks below
 * ask for the visitor keys of every node in the tree once a round.
 */
const VISITOR_KEYS: typeof t.VISITOR_KEYS = t.VISITOR_KEYS;

/**
 * Whether string code can still reach a name after we have rewritten, folded or
 * deleted it.
 *
 * The classifier for the *shapes* is `naming/allocate.ts`'s `freezeHazardKind`,
 * imported rather than restated. What this module adds is the answer: the shapes
 * have to be found, the direct-`eval` sites turned into a set of scopes, and the
 * result cached, because a pass that has to run its own traversal to ask cannot
 * afford to ask and therefore does not. Six passes that resolve a name to a
 * value or delete a declaration by name currently do not ask at all.
 *
 * Two hazards, and they are not the same fact:
 *
 *   * `'global'` - `Function(src)`, indirect `eval`, `setTimeout('src')`. The
 *     source compiles in *global* scope, so it sees no local binding. That is
 *     not the same as seeing nothing: in a script the program-scope `var`s and
 *     function declarations are properties of the global object and the
 *     program-scope `let`/`const`/`class` are the global lexical environment,
 *     and string code reads all of them by name. So it freezes program scope,
 *     and only program scope - and within program scope, only the names the
 *     source can actually spell, when the source can be read at all. Both
 *     narrowings are below: {@link Facts.programScopeIsGlobal} and
 *     {@link globalSourceNames}.
 *   * `'lexical'` - a direct `eval(...)`. It sees every binding visible at its
 *     call site, so every scope up its chain is reachable, for reads *and*
 *     writes.
 *
 * What this module does NOT answer, deliberately:
 *
 *   * `with (o) { ... }`. A name under a `with` is resolved on `o` at run time.
 *     That is a hazard about *position*, and it is `util/ast.ts`'s `insideWith`;
 *     nothing here stands in for it. `freezeHazardKind` classifies a
 *     `WithStatement` as `'lexical'` so the classifier is complete on its own,
 *     and this module never hands it one, because a `with` makes no name
 *     reachable by *string*.
 *   * The capture half of renaming. `ScopeFreezer` freezes the scopes *below* a
 *     direct `eval` as well, because injected code can declare a binding that a
 *     deeper free reference then resolves to - so renaming an unrelated binding
 *     into that name captures the reference. That is a rename hazard, not an
 *     addressing one, and {@link StringCodeFacts.addresses} is the addressing
 *     question: eval'd code runs at the `eval` site and cannot see a binding
 *     declared in a scope nested below it. This module is therefore not a
 *     replacement for `ScopeFreezer`, and a caller that renames needs both.
 */
export interface StringCodeFacts {
  /** A construct that compiles a string in global scope exists in this program. */
  readonly global: boolean;
  /** A direct `eval(...)` call exists in this program. */
  readonly directEval: boolean;
  /** Neither hazard was found; every query below answers `false`. */
  readonly empty: boolean;

  /**
   * Whether a direct `eval` can read and write this scope's own bindings.
   *
   * True for every scope on the chain from an `eval` call site up to the
   * program, and false for a scope nested below one - see the note on capture
   * above for why that asymmetry is the right one for this question.
   */
  reaches(scope: Scope): boolean;

  /**
   * Whether string code can address this binding by its name.
   *
   * The composite the passes want: a program-scope binding is addressable when
   * global-scope string code exists that can spell its name, and any binding is
   * addressable when a direct `eval` can reach the scope that declares it.
   *
   * "Can spell its name" is the part that is not a shape test. When every
   * global-scope construct in the program has a source this analysis can read,
   * the union of the names those sources mention is the whole of what they can
   * reach, and a program-scope binding outside that union is not addressable by
   * any of them. One unreadable source anywhere puts the answer back to "every
   * program-scope name", because an unread string can say anything.
   */
  addresses(binding: Binding): boolean;

  /**
   * {@link addresses}, for the binding Babel keeps nowhere: the `var` Annex
   * B.3.3 gives a sloppy block-level function in the function or program scope
   * around its block. `{ function helper() {} } Function('return helper()')()`
   * at the top of a script reads that var by name, and no binding of `helper`
   * lists the read - the block's binding is not at program scope, and there is
   * no other. Asked by name and by the scope the var lands in, which is what
   * `util/ast.ts`'s `blockFunctionHoisting` establishes.
   */
  addressesName(name: string, scope: Scope): boolean;

  /**
   * Whether a global-scope construct's source can spell `name` - the global
   * arm alone, with no binding in the question.
   *
   * {@link addressesName} answers for a BINDING, and so asks two things the
   * global arm does not bear on: whether program scope is global at all
   * (false in a module, whose top level no global code can see) and whether
   * a direct `eval` reaches the scope. A builtin is neither: `String` is a
   * property of the global object in a module and in a script alike, and
   * what `Function('return this')()` can do to it is decided by what the
   * source says and by nothing about the tree around it. So the evaluator
   * asks this of the names its slice takes for builtins, and a readable
   * source that spells none of them frees the decoder beside it - in an ESM
   * bundle with a webpack `Function('return this')()` shim as much as in a
   * script. One unreadable source anywhere is every name, as in
   * {@link addresses}. A facts object written by hand with `global` false
   * answers false: there is no source to ask.
   */
  spells(name: string): boolean;

  /**
   * Whether string code can address ANY of this scope's own bindings, without
   * saying which one.
   *
   * The weaker per-name {@link addresses} is the right question for a pass that
   * deletes or renames ONE binding: nothing else in the program changes, so a
   * name the string cannot spell is a name the string cannot notice. It is the
   * WRONG question for a pass that resolves a value through a CHAIN of names in
   * one scope and then rewrites a site that spells only the last link.
   * `var A = [...]; function dec(i) { return A[i]; } var alias = dec;` with
   * `Function('alias = function () { return "X" }')()` beside it: the source
   * spells neither `A` nor `dec`, so `addresses` is false for both, and
   * inlining `alias(0)` to a literal is still wrong, and deleting `alias` still
   * breaks a `Function('return alias(0)')` that reads it back.
   *
   * Asking about the whole scope closes that without the pass having to
   * enumerate a chain it discovers in stages - which is the version that would
   * be unsound the first time a link was found after the question was asked.
   * Only bindings the scope OWNS count, so a decoder nested inside an IIFE is
   * not refused because some unrelated program-scope name appears in a source.
   */
  addressesAnyOwnBinding(scope: Scope): boolean;

  /**
   * The construct that put the answer back to "every program-scope name", as a
   * phrase a diagnostic can quote - `Function(...) at line 8123` - or `undefined`
   * when every global-scope source in the program was read.
   *
   * A pass that refuses because of this fact otherwise leaves the reader with a
   * whole file's worth of missing output and no way to find the one line that
   * caused it. There is exactly one such line in `lightly-obfuscated.js`.
   */
  readonly unreadGlobalSource: string | undefined;
}

const CACHE_KEY = 'analysis.string-code';

interface CacheEntry {
  iteration: number;
  facts: StringCodeFacts;
}

/**
 * The program's string-code facts, computed once per fixpoint iteration.
 *
 * The cache is keyed on `ctx.iteration` and is NOT accumulated across
 * iterations, which is deliberate in both directions. Recomputing describes the
 * tree as it is now: when the pipeline has deleted the only `Function(src)` in
 * the file, the output contains no string code and freezing its program scope
 * would be a refusal with nothing behind it. Remembering, on the other hand,
 * would keep `unpack`'s payload frozen forever on every packed file, since
 * opening a `Function` wrapper is exactly the deletion of a hazard.
 *
 * The residue is inside one iteration: a pass that *introduces* string code
 * after this has been computed leaves every later pass in that iteration
 * reading a stale answer. Only one shape can do it - expanding a wrapper whose
 * body is a direct `eval`, which moves the `eval` to a new site - and the cure
 * is {@link invalidateStringCodeFacts} at that rewrite, not a weaker cache
 * here. Deletions in the other direction are safe: they leave the answer more
 * conservative than the tree warrants.
 */
export function stringCodeFacts(ctx: PassContext): StringCodeFacts {
  const cached = ctx.shared.get(CACHE_KEY) as CacheEntry | undefined;
  if (cached && cached.iteration === ctx.iteration) return cached.facts;
  const facts = compute(ctx);
  ctx.shared.set(CACHE_KEY, { iteration: ctx.iteration, facts });
  return facts;
}

/** Drop the cached answer, for a pass that has just moved or introduced code. */
export function invalidateStringCodeFacts(ctx: PassContext): void {
  ctx.shared.delete(CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

class Facts implements StringCodeFacts {
  directEval = false;
  global = false;
  /** Path nodes of the scopes a direct `eval` can read and write. */
  private readonly visible = new Set<t.Node>();
  /**
   * Names the global-scope constructs found so far can spell, or `null` once
   * one of them turned out to have a source this analysis cannot read.
   *
   * `null` is the blunt answer and it is absorbing: a single unreadable source
   * makes every program-scope name reachable again, however many readable ones
   * sit beside it.
   */
  private globalNames: Set<string> | null = new Set();
  unreadGlobalSource: string | undefined;
  /** Parsed sources, so a hazard repeated across fixpoint rounds is read once. */
  private readonly parsed = new Map<string, ReadonlySet<string> | null>();
  /** Sources read so far, against {@link SOURCE_BUDGET}. */
  private sourcesRead = 0;

  /**
   * @param programScopeIsGlobal Whether a binding at program scope is one of the
   * things global-scope code can see. True for a script, where a top-level
   * `var` or function declaration is a property of the global object and a
   * top-level `let`/`const`/`class` is in the global lexical environment. FALSE
   * for a module, whose top level is a module environment record that global
   * code has no path to at all. Measured on node 24 rather than argued: in an
   * `.mjs` with `var top = 1; function fn() {}; let lex = 3` at the top,
   * `Function('return typeof top')()`, `...typeof fn` and `...typeof lex` all
   * answer `'undefined'`, and the same three in a script answer `'number'`,
   * `'function'` and `'number'`.
   */
  constructor(
    private readonly programScopeIsGlobal: boolean,
    unreadableGlobal = false,
  ) {
    if (unreadableGlobal) {
      this.global = true;
      this.globalNames = null;
      // `var e = eval; e(src)`: `scanRaw` found the alias, and an alias has no
      // call site to read a source from - the shape test never saw the call.
      this.unreadGlobalSource = '`eval` used as a value';
    }
  }

  get empty(): boolean {
    return !this.directEval && !this.global;
  }

  record(path: NodePath): void {
    const site = freezeHazardSite(path);
    if (site === null) return;
    if (site.kind === 'global') {
      this.global = true;
      this.recordGlobalSource(path, site);
      return;
    }
    this.directEval = true;
    // Every scope above a recorded one is recorded too, so the first hit ends
    // the walk - which is what keeps a file full of `eval` calls linear.
    for (let scope: Scope | undefined = path.scope; scope; scope = scope.parent) {
      if (this.visible.has(scope.path.node)) break;
      this.visible.add(scope.path.node);
    }
  }

  private recordGlobalSource(path: NodePath, site: FreezeHazardSite): void {
    if (this.globalNames === null) return;
    const names = globalSourceNames(path, site, this.parsed, () => ++this.sourcesRead);
    if (names === null) {
      this.globalNames = null;
      this.unreadGlobalSource = describeSite(path);
      return;
    }
    for (const name of names) this.globalNames.add(name);
  }

  reaches(scope: Scope): boolean {
    if (this.visible.size === 0) return false;
    return this.visible.has(scope.path.node);
  }

  addresses(binding: Binding): boolean {
    return this.addressesName(binding.identifier.name, binding.scope);
  }

  addressesName(name: string, scope: Scope): boolean {
    if (this.globalArmApplies(scope)) {
      if (this.globalNames === null || this.globalNames.has(name)) return true;
    }
    return this.reaches(scope);
  }

  spells(name: string): boolean {
    return this.global && (this.globalNames === null || this.globalNames.has(name));
  }

  addressesAnyOwnBinding(scope: Scope): boolean {
    if (this.reaches(scope)) return true;
    if (!this.globalArmApplies(scope)) return false;
    if (this.globalNames === null) return true;
    // Names, not bindings, is the cheaper direction: the set is small (it is one
    // parsed source's identifiers) and `hasOwnBinding` is a map lookup, while
    // the scope's binding table on a large program is thousands of entries.
    for (const name of this.globalNames) if (scope.hasOwnBinding(name)) return true;
    return false;
  }

  private globalArmApplies(scope: Scope): boolean {
    return this.global && this.programScopeIsGlobal && scope.path.isProgram();
  }
}

const EMPTY: StringCodeFacts = new Facts(true);

function compute(ctx: PassContext): StringCodeFacts {
  const scan = scanRaw(ctx.ast);
  if (!scan.candidate) return EMPTY;

  // `program.sourceType` is what the parser resolved, including through
  // `'unambiguous'`, so it is the same answer `frontend/language.ts` reports.
  const facts = new Facts(ctx.ast.program.sourceType !== 'module', scan.aliasedEval);
  // All three types have children, so Babel builds a `NodePath` for them
  // whether or not this visitor names them: naming them costs nothing beyond
  // the walk itself. A childless type - `Identifier` above all - would cost a
  // path per node, which is why the `eval` inventory is taken by `scanRaw`
  // instead, on raw nodes.
  traverse(ctx.ast, {
    CallExpression(path) {
      facts.record(path);
    },
    NewExpression(path) {
      facts.record(path);
    },
    OptionalCallExpression(path) {
      facts.record(path);
    },
  });
  return facts;
}

// ---------------------------------------------------------------------------
// Reading a global-scope source
// ---------------------------------------------------------------------------

/**
 * How many distinct sources one program may have read before the answer is
 * blunt for the rest.
 *
 * Real files carry a handful of these - one in `lightly-obfuscated.js`, one in
 * `obfuscated3.js`, none in `obfuscated2.js`. A generated file with thousands
 * of `Function('...')` calls would otherwise pay a parse per call per fixpoint
 * round, and the cap turns that into a bounded cost with a conservative answer.
 * Repeats are free: the memo is keyed on the source text, so the cap counts
 * sources, not call sites.
 */
const SOURCE_BUDGET = 64;

/**
 * The names a global-scope construct's source can address, or `null` when the
 * source cannot be read or cannot be bounded.
 *
 * **Parsed, not scanned.** The alternative was to scan the string for
 * identifier-shaped tokens, which over-approximates and so is also safe, and it
 * was rejected for three reasons that all cost real output. A scan cannot tell
 * `o.name` from a reference to `name`, and cannot tell either from the word
 * `name` inside a string literal in the source - so on any source longer than a
 * few tokens it degenerates towards "every word in the file". A scan has no
 * position, so it cannot refuse on the two shapes that make a name set
 * meaningless (below) and would have to refuse on their spelling instead. And
 * the engine already parses exactly this text, for exactly this kind of source,
 * in `unpack/function-constructor.ts` - a second, weaker model of the same
 * string is a second thing to keep right. Parsing is not executing: nothing
 * here runs the source, and the ENGINE RULE against `eval`/`new Function` on
 * input is untouched.
 *
 * Refused - the answer is `null`, which restores the blunt freeze - when:
 *
 *   * any argument is not a readable string (`readStaticString`), which is the
 *     concatenation, the template with a substitution and the string built out
 *     of a decoded array;
 *   * the text is not valid JavaScript, or the `Function` arguments do not
 *     describe one function. The same `parsed.recovered` and single-function
 *     checks `unpack/function-constructor.ts` makes, for the same reason: a
 *     tree that does not describe what the constructor builds says nothing;
 *   * the source contains a COMPUTED member access. `globalThis[k]`,
 *     `window['_0x' + 'db56']` and `this[k]` all address a global by a name
 *     that never appears as an identifier, so no name set drawn from the text
 *     could bound them;
 *   * the source contains a `with`, which resolves its body's names against an
 *     object at run time;
 *   * the source itself mentions one of `CANDIDATE_NAMES`, meaning it can
 *     compile a further string this analysis is not holding.
 *
 * Otherwise the answer is EVERY identifier name in the parsed source, including
 * the ones a scan would have been blamed for: a non-computed property name and
 * an object-literal key are both counted. That is not an oversight about
 * `o.name`. In a sloppy `Function` body `this` IS the global object, so
 * `this.top = 1` writes the program-scope `top` under a name that occurs only
 * in property position, and this analysis cannot in general prove that the
 * object of a member expression is not the global object. Counting the name
 * costs precision on `o.name`; not counting it is the wrong answer on
 * `this.name`, and the rule stays one sentence.
 *
 * The boundary this does NOT cross: a source that calls a function declared in
 * the tree, or loads another file, can run code this set does not mention. That
 * is not a hole opened here - the tree's own code can do both, and the engine
 * models neither. What `addresses` answers is which names THIS STRING can
 * spell; a callee in the tree is analysed as the tree.
 */
function globalSourceNames(
  path: NodePath,
  site: FreezeHazardSite,
  memo: Map<string, ReadonlySet<string> | null>,
  charge: () => number,
): ReadonlySet<string> | null {
  if (!site.shape || !site.code) return null;

  const parts: string[] = [];
  for (const node of site.code) {
    const text = readSourceText(node, path.scope);
    if (text === undefined) return null;
    parts.push(text);
  }

  // `Function('return this')()` and `(0, eval)('this')`, nested to any
  // depth: a source that evaluates `this` and nothing else spells no name,
  // whatever the tree then does with the object it gets back. Read by the
  // generic walk below it would spell `constructor`, which is a candidate
  // name, and be the blunt answer.
  if (isGlobalThisSource(parts[parts.length - 1] ?? '', site.shape)) return EMPTY_NAMES;

  // `eval()` and `Function()` with no arguments compile an empty program and an
  // empty body: readable, and they name nothing.
  const text =
    site.shape === 'program'
      ? (parts[0] ?? '')
      : `(function (${parts.slice(0, -1).join(',')}) {\n${parts[parts.length - 1] ?? ''}\n})`;

  // The shape has exactly two values, so a one-character tag separates the
  // two key spaces with no delimiter to escape: a source string may contain
  // any character at all, including whatever the delimiter would have been.
  const key = (site.shape === 'program' ? 'p' : 'f') + text;
  const remembered = memo.get(key);
  if (remembered !== undefined) return remembered;
  if (charge() > SOURCE_BUDGET) return null;

  const names = readSourceNames(text, site.shape);
  memo.set(key, names);
  return names;
}

/**
 * A source argument as `readStaticString` reads it, through a `+` of such
 * parts: obfuscator.io 0.x spells the global-object idiom as three string
 * literals joined, `'return\x20(function()\x20' + '{}.constructor(...)' + ');'`,
 * and unread it was the blunt freeze of every program-scope name.
 */
function readSourceText(node: t.Node | undefined, scope: Scope, depth = 0): string | undefined {
  if (!node) return undefined;
  if (depth < 32 && t.isBinaryExpression(node) && node.operator === '+' && t.isExpression(node.left)) {
    const left = readSourceText(node.left, scope, depth + 1);
    if (left === undefined) return undefined;
    const right = readSourceText(node.right, scope, depth + 1);
    return right === undefined ? undefined : left + right;
  }
  return readStaticString(node, scope);
}

/**
 * The construct at this path, spelled the way a reader will find it.
 *
 * Only the callee is reproduced, and only in the shapes the classifier
 * recognises, because that is all a reader needs to locate the line - the
 * arguments are elided rather than generated so that a 40 KB source string
 * cannot end up inside a diagnostic.
 */
function describeSite(path: NodePath): string {
  const node = path.node;
  const callee =
    t.isCallExpression(node) || t.isNewExpression(node) || t.isOptionalCallExpression(node)
      ? spellCallee(node.callee)
      : undefined;
  const line = node.loc?.start.line;
  const where = line === undefined ? '' : ` at line ${line}`;
  return `\`${callee ?? 'the call'}(...)\`${where}`;
}

/** `Function`, `window.eval`, `[].constructor.constructor`; `undefined` past that. */
function spellCallee(node: t.Node, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (node.computed || !t.isIdentifier(node.property)) return undefined;
    const object = spellCallee(node.object, depth + 1);
    return object === undefined ? undefined : `${object}.${node.property.name}`;
  }
  if (t.isArrayExpression(node) && node.elements.length === 0) return '[]';
  if (t.isSequenceExpression(node)) {
    const last = node.expressions[node.expressions.length - 1];
    const inner = last ? spellCallee(last, depth + 1) : undefined;
    return inner === undefined ? undefined : `(0, ${inner})`;
  }
  return undefined;
}

function readSourceNames(text: string, shape: 'program' | 'function'): ReadonlySet<string> | null {
  const parsed = (() => {
    try {
      // Pinned to `js`: a JavaScript engine compiles this string, not a
      // TypeScript one. `parseSource` still falls back through the rest of the
      // ladder, so the language it reports is checked rather than assumed -
      // a text that only parses as TypeScript is one the host would reject,
      // and reading names out of a tree no engine would build proves nothing.
      return parseSource(text, { language: 'js', sourceType: 'script' });
    } catch {
      return undefined;
    }
  })();
  if (!parsed || parsed.recovered || parsed.language !== 'js') return null;

  let root: t.Node = parsed.ast.program;
  if (shape === 'function') {
    const body = parsed.ast.program.body;
    const statement = body.length === 1 ? body[0] : undefined;
    if (!statement || !t.isExpressionStatement(statement)) return null;
    if (!t.isFunctionExpression(statement.expression)) return null;
    root = statement.expression;
  }

  const names = new Set<string>();
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

    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      if (node.computed) return null;
    } else if (node.type === 'WithStatement') {
      return null;
    } else if (node.type === 'Identifier') {
      if (CANDIDATE_NAMES.has(node.name)) return null;
      names.add(node.name);
    }

    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return names;
}

/**
 * Names that must occur somewhere before any hazard shape can exist.
 *
 * Every arm of `freezeHazardKind` bottoms out in one of these spelled as an
 * identifier - as a bare callee, or as the property of a dotted one. A `.call`
 * or `.apply` forwards to a receiver that still has to be one of them, so
 * neither belongs here. A computed member (`x['eval']`) is not classified at
 * all, so it needs no gate either; `simplify/properties` rewrites the ones that
 * can be into the dot form, and this runs again on the tree it produced.
 */
const CANDIDATE_NAMES = new Set(['eval', 'Function', 'setTimeout', 'setInterval', 'constructor']);

interface RawScan {
  /** Some `CANDIDATE_NAMES` identifier occurs; without one there is no traversal. */
  candidate: boolean;
  /**
   * An `eval` identifier occurs somewhere other than a call's own callee.
   *
   * `var e = eval; e(src)` is the shape, and no test on the call site can see
   * it - the callee there is a local name. `naming/index.ts` answers it from
   * this end too, in `recordFreeIdentifier`; `clean/unused.ts` reads
   * `program.scope.globals`, which is precise about boundness but needs a
   * crawl. This is the cheap version, and it is coarser in two ways it is worth
   * being explicit about: a program that binds the name itself (`var eval = 1`,
   * illegal in strict mode) still counts, and so does a user object's own
   * `.eval` method read as a value. Both freeze program scope for nothing. The
   * miss in the other direction is the one that produces working, wrong output,
   * and the object-literal and class keys - where the name is definitionally
   * not a reference - are the one exclusion cheap enough to be worth making.
   */
  aliasedEval: boolean;
}

/**
 * One walk over raw nodes: no `NodePath`, no scope, no allocation per node.
 *
 * This is the gate. A file with none of `CANDIDATE_NAMES` in it - the common
 * case - pays this and nothing else, which is what makes the facts cheap enough
 * for every pass to ask for them. The node's kind is read off `type` rather
 * than asked of `t.isX`: seven of those a node, each a getter in the bundle,
 * were most of what the walk cost on obfuscated2.js.
 */
function scanRaw(root: t.Node): RawScan {
  let candidate = false;
  const evalNames: t.Identifier[] = [];
  /** `eval` identifiers in a position that is not a reference to the real one. */
  const excluded = new Set<t.Node>();

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

    const type = node.type;
    if (type === 'Identifier') {
      if (CANDIDATE_NAMES.has(node.name)) candidate = true;
      if (node.name === 'eval') evalNames.push(node);
    } else if (type === 'CallExpression' || type === 'NewExpression' || type === 'OptionalCallExpression') {
      // A direct callee is already classified by `freezeHazardKind`; counting it
      // here as well would report every `eval('x')` as an aliased one too. So
      // is the indirect `(0, eval)(x)` it classifies: the name there is the
      // call's, and its source is read. `o.eval(x)` stays counted, since the
      // property read as a value, `var e = window.eval`, is the same shape.
      const callee = node.callee;
      if (callee.type === 'Identifier' && callee.name === 'eval') excluded.add(callee);
      else if (callee.type === 'SequenceExpression') {
        const last = callee.expressions[callee.expressions.length - 1];
        if (last && last.type === 'Identifier' && last.name === 'eval') excluded.add(last);
      }
    } else if (isNamedMemberOwner(node) && !node.computed) {
      excluded.add(node.key);
    }

    for (const key of VISITOR_KEYS[type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }

  const aliasedEval = evalNames.some((identifier) => !excluded.has(identifier));
  return { candidate, aliasedEval };
}

/** A node whose `key` names a property rather than referring to a binding. */
function isNamedMemberOwner(
  node: t.Node,
): node is t.ObjectProperty | t.ObjectMethod | t.ClassMethod | t.ClassProperty {
  const type = node.type;
  return type === 'ObjectProperty' || type === 'ObjectMethod' || type === 'ClassMethod' || type === 'ClassProperty';
}
