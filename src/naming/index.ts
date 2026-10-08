import { Scope, type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts, type StringCodeFacts } from '../analysis/string-code.js';
import type { PassContext } from '../pipeline/context.js';
import {
  EMPTY_NAME_SCHEME,
  detectNameScheme,
  isReadableName,
  isVarScopedFunctionDeclaration,
  staticNumber,
  type NameScheme,
} from '../util/ast.js';
import {
  RenameAllocator,
  ScopeFreezer,
  hasUnrewritableReference,
  freezeHazardKind,
  meetsThreshold,
  rankCandidates,
  isJsxComponentBinding,
  violatesJsxConstraint,
} from './allocate.js';
import {
  GLOBAL_OBJECT_NAMES,
  compareStrings,
  identFromString,
  isReservedName,
  toCamel,
} from './dictionary.js';
import {
  collectFacts,
  functionReturnsStringArray,
  inferCandidates,
  writesTo,
  type BindingFacts,
  type NameCandidate,
  type NamingWorld,
} from './evidence.js';

export type { NameCandidate, BindingFacts, NamingWorld } from './evidence.js';
export type { RankedName } from './allocate.js';

export interface InferNamesOptions {
  /** Minimum combined confidence (0..1) before a name is applied. */
  minConfidence?: number;
  /** Rename bindings whose current name already reads like a human wrote it. */
  renameReadable?: boolean;
  renameParameters?: boolean;
  /** Rename keys of provably-local object literals (§5.5 safety proof). */
  renameProperties?: boolean;
  /** Import bindings carry tree-shaking meaning; off by default. */
  renameImports?: boolean;
  /** Leave a binding alone when no rule fires, rather than emitting `str1`. */
  keepUnknown?: boolean;
  /** Refuse target names that appear as string literals anywhere in the file. */
  strictStringGuard?: boolean;
  /**
   * Whether a read of the global object under a key nothing resolves is
   * taken to be of a host property, so that program-scope `var`s and
   * functions may still be renamed beside it; off, every one of them keeps
   * its name while such a read's result is used. See `resolveGlobalAliases`.
   */
  assumeHostProperties?: boolean;
  propagationRounds?: number;
  hints?: Record<string, string>;
  typescript?: boolean;
  jsx?: boolean;
  sourceType?: 'script' | 'module';
}

export interface InferredRename {
  from: string;
  to: string;
  reason: string;
  confidence: number;
}

export interface InferNamesResult {
  renames: InferredRename[];
  /** Bindings that had an accepted name but could not be safely rebound. */
  declined: number;
  /**
   * True when `eval`, `with` or string code cost this run some coverage.
   *
   * Both halves count, and they are now different objects: a scope frozen by
   * `ScopeFreezer`, and a binding refused because `analysis/string-code.ts` says
   * code compiled from a string can address it. Reading only the freezer would
   * report full coverage on a file whose whole program scope was left alone.
   */
  frozen: boolean;
  /**
   * Whether the program reads the text of an error it caught; see
   * `recordCaughtErrorRead`. V8 spells binding names into that text. The
   * names the guarded code can spell are kept, and a caller that renamed
   * anything still owes a disclosure for a failure deeper than the pin
   * follows.
   */
  errorTextRead: boolean;
  /**
   * Whether the program reads a `.name` off a value this run could not
   * follow - the result of a call on one of its own values, code compiled
   * from a string that can spell `name` - while renaming a function or
   * class, or a binding whose spelling an anonymous one takes; see
   * `classifyCallRead`. The read may see the new spelling, and a
   * caller owes a disclosure.
   */
  unfollowedNameRead: boolean;
  /**
   * How many program-scope bindings were refused because the global object
   * reached code this run cannot follow, which can then read any of them
   * by name; see `resolveGlobalAliases`. A caller owes one note.
   */
  globalEscapeRefusals: number;
  /**
   * The line of the first read of the global object under a key this run
   * could not resolve whose result is used, when a program-scope property
   * was renamed beside it on the assumption that the read is of a host
   * property; see `resolveGlobalAliases`. A caller owes a warning.
   */
  assumedHostPropertyRead: { line: number | undefined } | undefined;
  /**
   * Whether the guarded code calls something the pin did not follow - a
   * callee it cannot resolve, or one deeper than `ERROR_CALL_DEPTH` - so
   * that error text from there may embed a renamed name; see `pinErrorText`.
   * Or whether a caught error was let go of on the mainstream assumption
   * rather than followed - stored as an element under a key nothing
   * resolves and read back under another; see `readsErrorText` - with
   * nothing pinned for it. A caller that renamed anything owes a
   * disclosure at every preset.
   */
  errorTextUnfollowed: boolean;
}

type Settings = InferNamesOptions &
  Required<
    Pick<
      InferNamesOptions,
      | 'minConfidence'
      | 'renameReadable'
      | 'renameParameters'
      | 'renameProperties'
      | 'renameImports'
      | 'keepUnknown'
      | 'strictStringGuard'
      | 'assumeHostProperties'
      | 'propagationRounds'
    >
  >;

const DEFAULTS: Settings = {
  minConfidence: 0.35,
  renameReadable: false,
  renameParameters: true,
  renameProperties: false,
  renameImports: false,
  keepUnknown: true,
  strictStringGuard: false,
  assumeHostProperties: true,
  propagationRounds: 3,
};

interface ProgramAnalysis {
  strings: Set<string>;
  stringCounts: Map<string, number>;
  stringArrayIdentifiers: Set<t.Identifier>;
  globalAliasIdentifiers: Set<t.Identifier>;
  /**
   * Bindings that hold a `this` the call site chooses, and so may hold the
   * global object; they contribute what is read through them and nothing
   * else. See `resolveGlobalAliases`.
   */
  maybeGlobalAliasIdentifiers: Set<t.Identifier>;
  /**
   * The aliases that keep their names: `var g = window` and the window
   * parameter of a wrapping IIFE, the `d` of `!function (d) { ... }(window)`.
   * An alias found any other way - through a chain, `this`, a holder, a
   * named function's parameter - is followed like these and renamed like
   * any other binding, since its name says nothing about the window.
   */
  namedAliasIdentifiers: Set<t.Identifier>;
  /**
   * Every spelling of the global object the traversal saw - a global name
   * read free, a `this` that is or may be it - each followed to what it
   * flows into once the tree is whole; see `resolveGlobalAliases`.
   */
  globalSpellings: GlobalSpelling[];
  /** Property name -> every member read of it through a spelling of the global object. */
  globalMemberReads: Map<string, NodePath[]>;
  /**
   * `g[k](...)` with `k` unresolved and `g` the global object: a call of
   * whichever program-scope function `k` names, so a caller of every one
   * of them; see `holdersOf`. Only the calls: a read that goes elsewhere is
   * the contract `selectGlobal` documents.
   */
  globalUnresolvedCalls: NodePath[];
  /**
   * Every string spelled inside a key read off the global object that
   * nothing resolves whole; a program-scope name containing one keeps its
   * own. See `resolveGlobalAliases`.
   */
  globalKeyFragments: KeyFragment[];
  /**
   * Reads of the global object under a key nothing resolves whose result
   * is used - called, `new`ed, read as a member - taken to be of host
   * properties; a caller that renamed a program-scope property owes a
   * disclosure. See `resolveGlobalAliases`.
   */
  globalOpaqueReads: NodePath[];
  /**
   * Every read of the global object under a key nothing resolves, used or
   * not, for the line a disclosure names when a program-scope property was
   * renamed into a spelling the key's pieces cover; see `inferNames`.
   */
  globalUnresolvedReads: NodePath[];
  /** Property name -> every pattern taking it off a spelling of the global object, with the target it lands in; see `followFree`. */
  globalPatternReads: Map<string, Array<{ at: NodePath; into: t.Node }>>;
  /**
   * Whether the global object certainly reached a place the walk cannot
   * follow, in a script; see `resolveGlobalAliases`. Code there can read a
   * program-scope `var` or function by any name this file spells as a key.
   */
  globalObjectEscaped: boolean;
  /**
   * Whether the global object's own keys are certainly enumerated - a
   * `for-in`, `Object.keys` - so that every program-scope name is observed.
   */
  globalObjectEnumerated: boolean;
  /** Program-scope bindings refused on either ground; see `isRenameable`. */
  globalEscapeRefusals: number;
  /** Every property name the file spells as a static member or pattern key. */
  memberKeys: Set<string>;
  reflectiveIdentifiers: Set<t.Identifier>;
  /**
   * Whether some `.name` is read off a value no binding names; see
   * `classifyNameRead`. Answered after the walk by freezing every observable
   * name in the program, since the read may reach any of them.
   */
  unknownValueNameRead: boolean;
  /**
   * Whether some `.name` is read off a parameter whose callers this file
   * cannot enumerate, so that it may be any function the program let go of;
   * see `classifyRootRead` and `resolveNameReads`.
   */
  escapedValueNameRead: boolean;
  /**
   * Parameters of rejection handlers - `.catch(e => ...)`, `.then(_, e => ...)`.
   * They hold thrown values, as a catch parameter does, and are left as one.
   */
  rejectionParams: Set<Binding>;
  /**
   * The `.name` reads the traversal found, resolved once it is over; see
   * `queueNameRead`. What the global object holds - `globalThis.h = f` - is
   * known only then, and a read through it (`globalThis.h.name`) may sit
   * anywhere in the file relative to the store.
   */
  nameReadQueue: NameRead[];
  /** `function f({ name }) {}`: a `.name` read of a parameter, with no object to classify; see `resolveNameReads`. */
  paramNameReads: Array<{ fn: NodePath<t.Function>; property: 'name' | 'opaque' }>;
  /**
   * Whether some `.name` is read off what a call of one of this file's own
   * values hands back - `o.get().name`, `arr.pop().name` - which may be a
   * value let go of elsewhere; see `classifyCallRead`.
   */
  callResultNameRead: boolean;
  /**
   * Whether some `.name` read stops at a value this pass does not follow -
   * the result of a call on one of this file's own values, code compiled
   * from a string that can spell `name`, a nesting of elements deeper than
   * `ELEMENT_DEPTH` - so that a spelling renamed here may still be read
   * back there. Disclosed rather than pinned; see `classifyCallRead`.
   */
  unfollowedNameRead: boolean;
  /** Function node -> its path, for a callee spelled as a literal; see `functionPathOf`. */
  functionPaths: Map<t.Node, NodePath<t.Function>>;
  /** Object literal node -> its path; see `literalPathOf`. */
  literalPaths: Map<t.Node, NodePath<t.ObjectExpression>>;
  /** Class node -> its path; see `classMembers`. */
  classPaths: Map<t.Node, NodePath<t.Class>>;
  /** Class node -> the `this.k = v` stores in its body, by side; see `classMembers`. */
  classStores: Map<t.Node, Array<{ selector: Selector; isStatic: boolean; node: t.Expression; at: NodePath }>>;
  /** Binding -> the bindings its value flows into; see `aliasesOf`. */
  aliasedBy: Map<Binding, Binding[]> | undefined;
  /** Object literal node -> the `this` expressions inside its methods; see `thisWithin`. */
  thisMembers: Map<t.Node, NodePath<t.ThisExpression>[]>;
  /** Function node -> every place it can be called from; see `holdersOf`. */
  holders: Map<t.Node, { holders: Holder[][]; complete: boolean }>;
  /**
   * Call node -> the functions whose holders include a position at it, with
   * the position; the walk of a value handed to a call nothing resolves -
   * `q[0](v)`, `f(v)` with `f` a callback's parameter - asks here what the
   * walks of the functions found; see `holdersOf` and `calleeFunctions`.
   */
  calleeTargets: Map<t.Node, Array<{ fn: NodePath<t.Function>; position: HolderPosition }>>;
  /**
   * Binding -> steps -> what its references do with the value they hold
   * there, and the generation of global aliases it was answered under; see
   * `bindingReached`. Shared by every walk of every kind.
   */
  flowReached: Map<Binding, Map<string, { reached: Reached; generation: number }>>;
  /** Binding -> how many step lists two or more deep it has been asked under; see `Flow.drain`. */
  flowFanout: Map<Binding, number>;
  /** Binding -> every function the object it holds runs on its own when used; see `accessorsOf`. */
  accessors: Map<Binding, NodePath<t.Function>[]>;
  /** Free name -> steps -> what its references do with the value held there; see `freeReached`. */
  flowFree: Map<string, Map<string, Reached>>;
  /** Binding -> what a call of it runs; see `collectBindingCallees`. */
  callees: Map<Binding, { result: 'known' | 'foreign' | 'unresolved'; functions: NodePath<t.Function>[] }>;
  /** Call node -> what it runs, and under which alias set; see `resolveCallee`. */
  calleeResolutions: Map<t.Node, { resolution: CalleeResolution; generation: number }>;
  /** Bumped by `resolveGlobalAliases` at every alias found. */
  aliasGeneration: number;
  /** Catch clauses and rejection handlers met, answered once the tree is whole; see `recordCaughtErrorRead`. */
  errorReadQueue: NodePath[];
  /** Class node -> every `this` in its body, instance side then static; see `thisInClass`. */
  classThisMembers: Map<t.Node, [NodePath<t.ThisExpression>[], NodePath<t.ThisExpression>[]]>;
  /** Function node -> every `this` in its own body; see `thisPathsIn`. */
  functionThis: Map<t.Node, NodePath<t.ThisExpression>[]>;
  /** Function node -> every `arguments` in its own body; see `argumentsReferencesIn`. */
  functionArguments: Map<t.Node, NodePath[]>;
  /** The tree, for what its program scope holds; see `selectGlobal`. */
  program: NodePath<t.Program>;
  /**
   * Whether a constructor reached through the object model (`x.constructor`,
   * `arguments.callee`, `new.target`, ...) is itself used as a value, so that
   * `escapedValueNameRead` reaches every class and function after all; see
   * `recordConstructorEscape`.
   */
  constructorEscapes: boolean;
  /** Whether a caught error's text is read; see `recordCaughtErrorRead`. */
  errorTextRead: boolean;
  /**
   * Bindings whose spelling a caught error's text can carry; see
   * `pinErrorText`. Refused outright, at every preset.
   */
  errorTextIdentifiers: Set<t.Identifier>;
  /** Function or class node -> how many levels of calls below it were followed; see `pinErrorText`. */
  errorTextWalked: Map<t.Node, number>;
  /**
   * Whether some call the guarded code makes was not followed to a
   * function - a callee the walk cannot resolve, or one past
   * `ERROR_CALL_DEPTH` - so that a failure there may spell a renamed name;
   * see `pinErrorText`. Or whether a caught error was let go of on the
   * mainstream assumption rather than followed; see `readsErrorText`.
   * Disclosed at every preset that renamed anything.
   */
  errorTextUnfollowed: boolean;
  /**
   * Whether the error walk holds to the mainstream assumption the balanced
   * and aggressive presets rename under (`assumeHostProperties`): an element
   * held under a key nothing resolves is not read back under another; see
   * `readsErrorText`.
   */
  assumesHostProperties: boolean;
  /** Binding -> what the program stores into it through its references; see `memberStoresOf`. */
  memberStores: Map<Binding, MemberStore[]>;
  /** Binding -> its initialiser and every `=` to it; see `bindingSources`. */
  bindingSources: Map<Binding, BindingSource[]>;
  /** Node -> whether `this` there is the class; see `thisIsClass`. */
  thisOwners: Map<t.Node, boolean>;
  /**
   * Holder (a literal node, or a binding) -> selector -> what it holds
   * there, one table per rank of reading; see `selectFrom` and `selectGlobal`.
   */
  selections: Map<t.Node | Binding, Map<Selector, StoredValue[]>>;
  wideSelections: Map<t.Node | Binding, Map<Selector, StoredValue[]>>;
  /** Names this file reads without binding them; see `recordFreeIdentifier`. */
  freeNames: Set<string>;
  /** Free name -> every scope uid one of its references sits inside. */
  freeGlobalScopes: Map<string, Set<number>>;
  /** Free name -> every reference of it; see `followFree`. */
  freeReferences: Map<string, NodePath[]>;
  /** Property names this file reads or writes on the global object by dot. */
  globalObjectMembers: Set<string>;
  /** Loops that some `break` inside them actually exits; see `breakTargetLoop`. */
  breakingLoops: Set<t.Node>;
  hasDebugger: boolean;
  freezer: ScopeFreezer;
  /** Where code compiled from a string can still reach a name. */
  stringCode: StringCodeFacts;
  /**
   * Whether a program-scope binding is one of the things global-scope code sees.
   *
   * Read off the same field `analysis/string-code.ts` reads - the parser's
   * resolved `sourceType` - rather than off `InferNamesOptions.sourceType`,
   * because this and the fact's own global arm have to agree about one program.
   * A caller that passes the option is describing the same tree; a caller that
   * omits it gets the default `'script'`, and that default disagreeing with the
   * tree would leave the two halves of the guard below reading different files.
   */
  programScopeIsGlobal: boolean;
  /** Bindings refused because string code can address them; see `frozen`. */
  stringCodeRefusals: number;
  /** Ids of sloppy-mode block-level function declarations; see `recordAnnexBFunction`. */
  annexBFunctions: Set<t.Identifier>;
  /** Name -> the block-level functions declared under it, for a call the scope tables do not resolve. */
  annexBByName: Map<string, NodePath<t.FunctionDeclaration>[]>;
  /**
   * Scope uid -> the names Annex B declares as a var in that scope or in one
   * below it, from those functions. A binding of such a name in such a scope
   * may own references that actually resolve to the var.
   */
  annexBNames: Map<number, Set<string>>;
  bindings: Binding[];
  /** Generated-name conventions learned from this program's own binding names. */
  scheme: NameScheme;
}

/**
 * Infer human-meaningful names for every binding in `program` and apply them.
 *
 * Runs last in the pipeline by design: the evidence that names
 * `document.getElementById('canvas')` simply does not exist until string
 * decoding and property normalisation have run.
 *
 * `program.scope` must describe the tree as it is now. Everything below reads
 * `binding.referencePaths` and `constantViolations`, and a stale list makes the
 * renamer *miss* a reference - it rewrites the declaration and leaves a use
 * behind, which is the silent miscompile this layer exists to avoid. The crawl
 * that guarantees it used to sit here, unconditionally, and was the single
 * most expensive line in the pass: Babel's `Binding.reference` is O(N) per
 * reference, so one name read 100k times cost 3-6 s per crawl (the pass fell
 * from 3.9 s to 0.46 s on such a file), and the tables were already current
 * on every run. It is now the pipeline's, taken through
 * `PassContext.crawlProgramScope` only when a pass has changed the tree since
 * the last crawl, which is how `rename.identifiers` enters here. A caller
 * outside the pipeline is under the same contract and has to meet it the same
 * way: crawl when the tree has changed since the tables were built. A fresh
 * `traverse()` does NOT do that for it. Babel keeps one `Scope` per node and
 * crawls it when it is first created, so only the first traversal of an AST
 * builds the tables; every later one hands back the cached scope, with
 * whatever `referencePaths` it had. Measured: parse, traverse to the program,
 * append a second `log(top)`, traverse again - the second program path is the
 * same object as the first and `top` still lists one reference until
 * `scope.crawl()` is called, after which it lists two.
 */
export function inferNames(
  program: NodePath<t.Program>,
  options: InferNamesOptions = {},
): InferNamesResult {
  const settings = { ...DEFAULTS, ...options };
  const typescript = options.typescript ?? false;
  const jsx = options.jsx ?? false;
  const isScript = (options.sourceType ?? 'script') === 'script';

  const analysis = analyzeProgram(program, settings.renameProperties, settings.assumeHostProperties);

  const settled = new Map<t.Identifier, string>();
  /** Identifiers this run may rename; see `displayName`. Set below. */
  let renameTargets: Set<t.Identifier> | undefined;
  const world: NamingWorld = {
    typescript,
    jsx,
    hasDebugger: analysis.hasDebugger,
    strings: analysis.strings,
    stringArrayIdentifiers: analysis.stringArrayIdentifiers,
    globalAliasIdentifiers: analysis.namedAliasIdentifiers,
    breakingLoops: analysis.breakingLoops,
    functionProbes: new Map(),
    functionUses: new Map(),
    hints: compileHints(settings.hints ?? {}),
    displayName(scope, name) {
      const binding = scope.getBinding(name);
      if (!binding) return undefined;
      const chosen = settled.get(binding.identifier);
      if (chosen) return chosen;
      const current = binding.identifier.name;
      // A rename target with nothing settled is heading for a typed fallback,
      // so its current name is not the name the output will carry and copying
      // it produces a name derived from a spelling this run deletes. Measured
      // at 'aggressive' on `function f(a) { var s = 0; for (var e of a) s += e;
      // return s; }` written with `_0x` names: `_0x2` passes `isReadableName`
      // (four characters, one letter, too few hex digits for the obfuscated
      // pattern), so F03 named the element after it at 0.704 - under the
      // preset's floor, so the element fell through to `val1`. Run two read
      // `arg1`, F03 declined, and the element became `item`. Asking whether the
      // binding is a target answers the question `isReadableName` was standing
      // in for, and answers it the same way on both runs.
      if (renameTargets?.has(binding.identifier)) return undefined;
      return isReadableName(current, analysis.scheme) ? current : undefined;
    },
  };

  const targets = analysis.bindings
    .filter((binding) => isRenameable(binding, analysis, settings, isScript))
    .sort(targetOrder());
  // Filled here rather than captured above because `isRenameable` needs the
  // analysis this world is being built for. Nothing reads `displayName` until
  // `collectFacts` below, which runs after this line.
  renameTargets = new Set(targets.map((binding) => binding.identifier));

  const facts = new Map<Binding, BindingFacts>();
  for (const binding of targets) facts.set(binding, collectFacts(binding, world));

  const candidates = new Map<Binding, NameCandidate[]>();
  const seenKeys = new Map<Binding, Set<string>>();
  const rounds = Math.max(1, settings.propagationRounds);
  for (let round = 0; round < rounds; round++) {
    // A round reads only `facts` (fixed) and `world`, whose only mutable part is
    // `settled`. A round that adds no candidate and moves no settled name leaves
    // the next round's inputs bit-identical to its own, so every remaining round
    // is provably a no-op. Detecting that is exact, not a heuristic cut-off.
    let changed = false;
    for (const binding of targets) {
      const bindingFacts = facts.get(binding)!;
      const produced = inferCandidates(bindingFacts, world);
      const bucket = candidates.get(binding) ?? [];
      const keys = seenKeys.get(binding) ?? new Set<string>();
      for (const candidate of produced) {
        const key = `${candidate.ruleId}|${candidate.name}|${candidate.anchor}|${candidate.hops}`;
        if (keys.has(key)) continue;
        keys.add(key);
        bucket.push(candidate);
        changed = true;
      }
      candidates.set(binding, bucket);
      seenKeys.set(binding, keys);

      // `ranked[0]`, not the first entry anywhere in the list that clears the
      // bar: the applier below stops at the first entry that does not, so a name
      // further down is one this binding will never be given. Searching further
      // here made `world.displayName` advertise names that were never applied,
      // and other bindings then borrowed them.
      const ranked = rankCandidates(bucket);
      const head = ranked[0];
      const winner = head && meetsThreshold(head, settings.minConfidence) ? head : undefined;
      if (winner && settled.get(binding.identifier) !== winner.name) {
        settled.set(binding.identifier, winner.name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const globalProperties = new Set<t.Identifier>();
  for (const binding of targets) {
    if (isGlobalObjectProperty(binding, isScript)) globalProperties.add(binding.identifier);
  }

  const allocator = new RenameAllocator({
    typescript,
    strictStringGuard: settings.strictStringGuard,
    strings: analysis.strings,
    freeGlobalScopes: analysis.freeGlobalScopes,
    globalProperties,
    // A key spelled in pieces refuses the name a binding has, not one it
    // is given: `dec(...) + 'y'` beside every host read of an undecoded
    // obfuscator.io file would refuse `getStringArray` for the `y`, and the
    // suffix generator would then hand out `getStringArray2`, which the
    // same key names as readily.
    readsGlobalProperty: (name) =>
      analysis.globalObjectMembers.has(name) ||
      (analysis.globalObjectEscaped && analysis.memberKeys.has(name)) ||
      spelledInPart(name, analysis, true),
    annexBNames: analysis.annexBNames,
  });
  const renames: InferredRename[] = [];
  let declined = 0;
  /** Whether a spelling some function or class carries as its `.name` was changed. */
  let renamedObservable = false;
  /** Whether a program-scope property of the global object was renamed. */
  let renamedGlobalProperty = false;
  /**
   * Whether one was renamed into a spelling the pieces of an unresolved
   * key cover - `map` beside `g[dec(0) + 'p']`. The allocator refuses only
   * a key spelled whole (see there); a read of the host's `map`, if that
   * is what the key names, now finds the file's own, and this is said.
   */
  let renamedIntoPiece = false;
  const fallbackCounters = new Map<number, Map<string, number>>();

  for (const binding of targets) {
    const bindingFacts = facts.get(binding)!;
    const ranked = rankCandidates(candidates.get(binding) ?? []);
    const from = binding.identifier.name;
    const jsxComponent = jsx && isJsxComponentBinding(binding);
    let applied = false;

    for (const entry of ranked) {
      if (!meetsThreshold(entry, settings.minConfidence)) break;
      const target = enforceHardConstraints(entry.name, bindingFacts);
      if (!target) continue;
      // A rule that re-derives the name the binding already has is agreement:
      // the binding is already correctly named, so it is *settled*, not
      // unnamed. Treating it as a rename failure sends it to the typed-fallback
      // branch below, which renames `items` to `arr1` - and the next run's rules
      // rename it straight back, so deobfuscating our own output never
      // converges. Agreement must end the search for this binding entirely.
      if (isSettledSpelling(from, target)) {
        applied = true;
        break;
      }
      if (violatesJsxConstraint(from, target, jsx, jsxComponent)) continue;
      for (const attempt of allocator.suffixes(target)) {
        if (!allocator.canRename(binding, attempt)) continue;
        allocator.apply(binding, attempt);
        settled.set(binding.identifier, attempt);
        renames.push({
          from,
          to: attempt,
          reason: entry.reason,
          confidence: round3(entry.combined),
        });
        if (carriesObservableName(binding)) renamedObservable = true;
        if (globalProperties.has(binding.identifier)) {
          renamedGlobalProperty = true;
          if (spelledInPart(attempt, analysis)) renamedIntoPiece = true;
        }
        applied = true;
        break;
      }
      if (applied) break;
    }

    if (applied) continue;
    if (settings.keepUnknown) {
      if (ranked.length > 0 && meetsThreshold(ranked[0]!, settings.minConfidence)) declined++;
      continue;
    }

    // Already carrying a name from this same typed-fallback family. The number
    // is a *position* - how many `val`s this scope had handed out before this
    // one - so it is not a property of the binding and cannot be re-derived: a
    // single binding that becomes a fallback target on the second run shifts
    // every later number by one, and each shifted name collides with the
    // binding that currently holds it, so the whole tail moves to the `_2`
    // spelling and back again on the run after.
    //
    // Measured with only these two lines and the counter's skip reverted:
    // `obfuscated4.js` at 'aggressive' goes 3 017 433 -> 2 989 371 -> 2 987 549
    // characters and is still moving on the third run, 773 renames of which
    // every one is this shape - `num2 -> num1_2`, `num1 -> num2`,
    // `arg3 -> arg1_2`, `arg1 -> arg3`, scope after scope.
    //
    // This is the same rule the ranked branch above applies to a rule-derived
    // name, asked of the base instead of the numbered name: `val64` is a
    // spelling of `val` exactly as `re4` is one of `re`. Nothing a reader can
    // use distinguishes `val64` from `val65`, so agreement on the *family* is
    // agreement.
    //
    // Deliberately before `nextFallbackName`, so a settled binding does not
    // consume a counter value either. Consuming it would keep the numbering
    // dense but make the count depend on the same shifting set of bindings this
    // guard exists to stop reading.
    const family = fallbackBase(bindingFacts);
    if (isSettledSpelling(from, family)) continue;

    const fallback = nextFallbackName(bindingFacts, fallbackCounters, (name) =>
      binding.scope.hasBinding(name, false),
    );
    let placed = false;
    for (const attempt of allocator.suffixes(fallback)) {
      // The binding already has the name we would give it. `canRename` rejects a
      // no-op rename, and without this guard the suffix generator treats that
      // rejection as a collision and moves to `arg12` - which the next run
      // renames back to `arg1`, forever. Deobfuscating our own output has to be
      // stable, so agreement must terminate the search, not advance it.
      if (attempt === from) break;
      if (!allocator.canRename(binding, attempt)) continue;
      if (violatesJsxConstraint(from, attempt, jsx, jsxComponent)) continue;
      allocator.apply(binding, attempt);
      settled.set(binding.identifier, attempt);
      renames.push({ from, to: attempt, reason: 'I12: typed fallback, no rule fired', confidence: 0.1 });
      if (carriesObservableName(binding)) renamedObservable = true;
      if (globalProperties.has(binding.identifier)) {
        renamedGlobalProperty = true;
        if (spelledInPart(attempt, analysis)) renamedIntoPiece = true;
      }
      placed = true;
      break;
    }
    if (!placed) declined++;
  }

  if (settings.renameProperties) {
    renames.push(...renameObjectProperties(analysis, targets, facts, typescript));
  }

  return {
    renames,
    declined,
    frozen: !analysis.freezer.empty || analysis.stringCodeRefusals > 0,
    errorTextRead: analysis.errorTextRead,
    errorTextUnfollowed: analysis.errorTextUnfollowed,
    unfollowedNameRead: analysis.unfollowedNameRead && renamedObservable,
    globalEscapeRefusals: analysis.globalEscapeRefusals,
    assumedHostPropertyRead:
      renamedGlobalProperty && analysis.globalOpaqueReads.length > 0
        ? { line: analysis.globalOpaqueReads[0]!.node.loc?.start.line }
        : renamedIntoPiece
          ? { line: analysis.globalUnresolvedReads[0]?.node.loc?.start.line }
          : undefined,
  };
}

/**
 * Whether the binding's spelling is some function's or class's `.name`: a
 * declaration, the own name of a named expression, or a variable, parameter
 * or pattern target that an anonymous function or class takes its name from
 * - the same sources `observableValues` reads as named evaluation.
 */
function carriesObservableName(binding: Binding): boolean {
  const declaration = binding.path;
  if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration()) return true;
  if (namesOwnExpression(binding)) return true;
  const takesName = (value: t.Expression | null | undefined): boolean => {
    if (!value) return false;
    const inner = unwrapTransparent(value);
    return (
      (t.isFunctionExpression(inner) && !inner.id) ||
      t.isArrowFunctionExpression(inner) ||
      (t.isClassExpression(inner) && !inner.id)
    );
  };
  if (declaration.isVariableDeclarator()) {
    const { id, init } = declaration.node;
    if (t.isIdentifier(id) ? takesName(init) : takesName(defaultValueOf(id, binding.identifier))) return true;
  } else if (binding.kind === 'param' && takesName(defaultValueOf(declaration.node, binding.identifier))) {
    return true;
  }
  for (const violation of binding.constantViolations) {
    const node = violation.node;
    if (!t.isAssignmentExpression(node) || !NAMING_ASSIGNMENTS.has(node.operator)) continue;
    if (t.isIdentifier(node.left) && takesName(node.right)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Whole-program analysis (one traversal)
// ---------------------------------------------------------------------------

function analyzeProgram(program: NodePath<t.Program>, countStrings: boolean, assumesHostProperties: boolean): ProgramAnalysis {
  const analysis: ProgramAnalysis = {
    strings: new Set(),
    stringCounts: new Map(),
    stringArrayIdentifiers: new Set(),
    globalAliasIdentifiers: new Set(),
    maybeGlobalAliasIdentifiers: new Set(),
    namedAliasIdentifiers: new Set(),
    globalSpellings: [],
    globalMemberReads: new Map(),
    globalUnresolvedCalls: [],
    globalKeyFragments: [],
    globalOpaqueReads: [],
    globalUnresolvedReads: [],
    globalPatternReads: new Map(),
    globalObjectEscaped: false,
    globalObjectEnumerated: false,
    globalEscapeRefusals: 0,
    memberKeys: new Set(),
    reflectiveIdentifiers: new Set(),
    unknownValueNameRead: false,
    escapedValueNameRead: false,
    rejectionParams: new Set(),
    nameReadQueue: [],
    paramNameReads: [],
    callResultNameRead: false,
    unfollowedNameRead: false,
    functionPaths: new Map(),
    literalPaths: new Map(),
    classPaths: new Map(),
    classStores: new Map(),
    aliasedBy: undefined,
    thisMembers: new Map(),
    holders: new Map(),
    calleeTargets: new Map(),
    flowReached: new Map(),
    flowFanout: new Map(),
    flowFree: new Map(),
    accessors: new Map(),
    callees: new Map(),
    calleeResolutions: new Map(),
    aliasGeneration: 0,
    errorReadQueue: [],
    classThisMembers: new Map(),
    functionThis: new Map(),
    functionArguments: new Map(),
    program,
    constructorEscapes: false,
    errorTextRead: false,
    errorTextIdentifiers: new Set(),
    errorTextWalked: new Map(),
    errorTextUnfollowed: false,
    assumesHostProperties,
    memberStores: new Map(),
    bindingSources: new Map(),
    thisOwners: new Map(),
    selections: new Map(),
    wideSelections: new Map(),
    // Babel's crawl has already worked out which identifiers this file reads
    // without binding them; reuse that rather than deriving it again.
    freeNames: new Set(Object.keys(program.scope.globals)),
    freeGlobalScopes: new Map(),
    freeReferences: new Map(),
    globalObjectMembers: new Set(),
    breakingLoops: new Set(),
    hasDebugger: false,
    freezer: new ScopeFreezer(),
    stringCode: stringCodeOf(program),
    programScopeIsGlobal: program.node.sourceType !== 'module',
    stringCodeRefusals: 0,
    annexBFunctions: new Set(),
    annexBByName: new Map(),
    annexBNames: new Map(),
    bindings: [],
    scheme: EMPTY_NAME_SCHEME,
  };

  const seen = new Set<Binding>();
  const harvest = (scope: Scope): void => {
    for (const name of Object.keys(scope.bindings)) {
      const binding = scope.bindings[name];
      if (binding && !seen.has(binding)) {
        seen.add(binding);
        analysis.bindings.push(binding);
      }
    }
  };
  harvest(program.scope);

  // `stringCounts` exists only for the §5.5 property proof, which every preset
  // leaves off; counting on every run costs a Map write per string literal and
  // retains one entry per distinct string for nothing.
  const addString = countStrings
    ? (value: string): void => {
        analysis.strings.add(value);
        analysis.stringCounts.set(value, (analysis.stringCounts.get(value) ?? 0) + 1);
      }
    : (value: string): void => {
        analysis.strings.add(value);
      };

  program.traverse({
    Scopable(path) {
      if (path.scope.path === path) harvest(path.scope);
    },
    StringLiteral(path) {
      addString(path.node.value);
    },
    TemplateElement(path) {
      addString(path.node.value.cooked ?? path.node.value.raw);
    },
    DebuggerStatement() {
      analysis.hasDebugger = true;
    },
    BreakStatement(path) {
      const loop = breakTargetLoop(path);
      if (loop) analysis.breakingLoops.add(loop.node);
    },
    WithStatement(path) {
      analysis.freezer.addHazard(path.scope, 'lexical');
    },
    NewExpression(path) {
      recordLexicalHazard(path, analysis);
    },
    CallExpression(path) {
      recordLexicalHazard(path, analysis);
      recordRejectionHandler(path, analysis);
      recordConstructorEscape(path, analysis);
      recordBuiltinRead(path, analysis);
    },
    OptionalCallExpression(path) {
      recordConstructorEscape(path, analysis);
    },
    ThisExpression(path) {
      recordConstructorEscape(path, analysis);
      recordThisSpelling(path, analysis);
    },
    MetaProperty(path) {
      recordConstructorEscape(path, analysis);
    },
    VariableDeclarator(path) {
      recordStringArray(path, analysis);
    },
    CatchClause(path) {
      recordCaughtErrorRead(path, analysis);
    },
    // `const { name } = f` reads `f.name` without a member expression anywhere.
    ObjectPattern(path) {
      for (const property of path.node.properties) {
        if (!t.isObjectProperty(property)) continue;
        const key = patternKeyOf(property);
        if (key !== null) analysis.memberKeys.add(key);
      }
      recordPatternReflection(path, analysis);
    },
    // Kept for every function and object literal, since a callee or holder
    // met as a node is resolved through its path; searching for one from a
    // call site outwards walked the whole wrapper of obfuscated2.js once per
    // proxy function in its map.
    Function(path) {
      analysis.functionPaths.set(path.node, path);
    },
    ObjectExpression(path) {
      analysis.literalPaths.set(path.node, path);
    },
    Class(path) {
      analysis.classPaths.set(path.node, path);
    },
    FunctionDeclaration(path) {
      if (!path.node.id) return;
      recordAnnexBFunction(path, analysis);
      if (!functionReturnsStringArray(path.node)) return;
      const binding = path.scope.parent?.getBinding(path.node.id.name) ?? path.scope.getBinding(path.node.id.name);
      if (binding) analysis.stringArrayIdentifiers.add(binding.identifier);
    },
    MemberExpression(path) {
      recordMemberKey(path.node, analysis);
      recordReflection(path, analysis);
      recordConstructorEscape(path, analysis);
    },
    // `f?.name` reads the same string as `f.name`, from a node of another type.
    OptionalMemberExpression(path) {
      recordMemberKey(path.node, analysis);
      recordReflection(path, analysis);
      recordConstructorEscape(path, analysis);
    },
    // `Identifier`/`JSXIdentifier` rather than the `ReferencedIdentifier` virtual
    // type: the virtual type makes Babel run its reference check on every one of
    // the program's identifiers, which measured at +15% of this pass on
    // lightly-obfuscated.js. A set lookup on the name rejects all but the few
    // hundred that could matter, and the reference check then runs on those.
    Identifier(path) {
      recordFreeIdentifier(path, analysis);
    },
    JSXIdentifier(path) {
      recordFreeIdentifier(path, analysis);
    },
  });

  resolveGlobalAliases(analysis);
  // What the global walk asked of functions' holders it asked before every
  // read through the global object was known (`globalMemberReads`), so the
  // few answers it kept are dropped for the walks that follow.
  analysis.holders.clear();
  analysis.calleeTargets.clear();
  analysis.flowReached.clear();
  analysis.flowFanout.clear();
  analysis.flowFree.clear();
  // A caught error is followed to where its text is read, through calls
  // and holders the step above completes.
  drainErrorReads(analysis);
  // Every `.name` read, against the walk of every function and class.
  resolveNameReads(analysis);

  // Code compiled from a string in global scope sees no local, but a local
  // handed to it is read there: `Function('v', 'return v.name')(_0xh)`
  // printed `fn1` at aggressive. The fact reads such a source when it can,
  // and every name it spells is in its set - a property name included, which
  // is what makes `name` askable; a source it cannot read spells anything.
  // In a module the set is not consulted by name, so any such source may.
  const { stringCode } = analysis;
  if (stringCode.global && (!analysis.programScopeIsGlobal || stringCode.addressesName('name', program.scope))) {
    analysis.unfollowedNameRead = true;
  }

  // Learned after the walk, because it is evidence about the whole population
  // of binding names rather than about any one of them.
  analysis.scheme = detectNameScheme(analysis.bindings.map((binding) => binding.identifier.name));

  return analysis;
}

/**
 * The program's string-code facts.
 *
 * `stringCodeFacts` is written against a `PassContext` because it memoises on
 * `ctx.shared`, keyed by `ctx.iteration`, so that every pass asking in one
 * fixpoint round shares a single traversal. It reads three of that interface's
 * members, and this entry point has none of them: `inferNames` takes a
 * `NodePath<t.Program>` and its own options object, and `naming.test.ts` calls
 * it with no pipeline at all. So the fact is computed here against a one-shot
 * cache, which is the same computation with the sharing turned off.
 *
 * The cost is one raw walk of the tree - and, only for a file that mentions
 * `eval`, `Function`, a timer or `constructor` anywhere, one traversal. This
 * pass is `repeatable: false`, so it is paid once per run. Threading the
 * pipeline's cached answer in through `InferNamesOptions` would save that walk
 * and change nothing else; it is one line in `passes/rename/identifiers.ts`.
 *
 * The `Pick` documents the cast rather than enforcing it: the assertion erases
 * the difference, so a member read added inside `stringCodeFacts` later will
 * not be a type error here. It will be a `TypeError` on the first file that
 * reaches this line, which is the failure this shape is chosen for - a missing
 * member is `undefined` and throws, not a quietly different answer.
 *
 * `program.parent` is the `File` in every path that reaches here, because
 * Babel's own `traverse` will only start at a `File` or a `Program` and both
 * callers hand it the file. The wrapper is for a `Program` path built some
 * other way, and it is a wrapper rather than a refusal because refusing would
 * mean answering "no string code" about a tree nobody looked at.
 */
function stringCodeOf(program: NodePath<t.Program>): StringCodeFacts {
  const file = t.isFile(program.parent) ? program.parent : t.file(program.node);
  const context: Pick<PassContext, 'ast' | 'shared' | 'iteration'> = {
    ast: file,
    shared: new Map(),
    iteration: 0,
  };
  return stringCodeFacts(context as PassContext);
}

/**
 * The half of the freeze analysis the shared fact deliberately does not answer.
 *
 * `analysis/string-code.ts` answers ADDRESSING: which names code compiled from
 * a string can spell. That is the whole of the `'global'` hazard, and this
 * visitor therefore drops every `'global'` kind on the floor - not because it
 * does not matter, but because {@link stringCodeRefuses} now reads a better
 * answer to it out of the shared fact.
 *
 * `'lexical'` has a second half that no addressing question covers. A direct
 * `eval` can DECLARE a binding, and a free reference in a scope nested *below*
 * the call site then resolves to it - so renaming an unrelated binding into
 * that name captures the reference. The set that has to be frozen for that is
 * "every scope inside the one holding the `eval`", which needs the hazard's
 * SITE; the shared fact exposes the scopes an `eval` can read (`reaches`) and
 * not the scope it sits in, and the two are not recoverable from each other -
 * program scope is on every chain, so "some ancestor is reachable" is true of
 * every scope in a file with one `eval` in it. `ScopeFreezer` holds that set,
 * so `ScopeFreezer` stays, and it is now fed nothing but the hazard it is the
 * only answer to.
 *
 * Only a direct `eval(...)` and a `with` are lexical; `with` has its own visitor.
 */
function recordLexicalHazard(path: NodePath, analysis: ProgramAnalysis): void {
  if (freezeHazardKind(path) === 'lexical') analysis.freezer.addHazard(path.scope, 'lexical');
}

/**
 * A `function` declared in a block, a `switch` case or a label, in sloppy code.
 *
 * Annex B.3.3 gives such a declaration a second binding: a `var` of the same
 * name in the enclosing function or script, assigned the function when the
 * block is evaluated. Babel scopes the declaration to the block, so that var
 * exists nowhere in its scope tables - a call after the block resolves to
 * nothing, or to an outer binding that happens to share the name - and
 * `binding.referencePaths` lists none of it. The renamer rewrites exactly that
 * list, so `{ function _0x1234() {} } _0x1234()` came out with the declaration
 * renamed and the call still spelling `_0x1234`: a ReferenceError, and in the
 * polyfill idiom `if (!x) { function x() {} }` one at the first call.
 *
 * Both bindings are recorded, because the hazard runs both ways. The function's
 * own id is refused a rename in `isRenameable`; so is any binding in the var
 * scope that carries the same name, since `var f = 1; { function f() {} }` makes
 * `f` the function after the block, and renaming the var alone leaves `typeof f`
 * reading a number. Renaming the outside references instead would need the
 * spec's own conditions - no conflicting `let`, no same-named parameter, every
 * same-named block function sharing one var - and Babel links none of it, so a
 * refusal is the whole of what is provable.
 *
 * The name is recorded for every scope from the var scope UP to the program,
 * not for the var scope alone. Babel, knowing no var, resolves a post-block
 * reference to whatever binding of that name it can find above - a catch
 * parameter, an outer function's parameter, a program-level `let` - and lists
 * the reference on that binding. Renaming the outer binding rewrites the
 * reference with it, and the reference then really does address the outer
 * binding, where at runtime it addressed the var: `catch (e) { function w() {
 * { function e() {} } return e(); } }` came out calling the caught string. A
 * SIBLING var scope is not on the walk and stays renameable; its bindings are
 * not visible from the block, so nothing inside resolves to them.
 *
 * Strictness is read from the enclosing code, which is what `isInStrictMode`
 * answers from a declaration's parent: a `'use strict'` inside the function's
 * own body does not stop the hoisting. Modules and class bodies are strict
 * throughout, so nothing is refused there.
 */
function recordAnnexBFunction(
  path: NodePath<t.FunctionDeclaration>,
  analysis: ProgramAnalysis,
): void {
  const id = path.node.id;
  const parent = path.parentPath;
  if (!id || !parent) return;
  if (isVarScopedFunctionDeclaration(path) || path.isInStrictMode()) return;
  analysis.annexBFunctions.add(id);
  const declared = analysis.annexBByName.get(id.name);
  if (declared) declared.push(path);
  else analysis.annexBByName.set(id.name, [path]);
  // From the PARENT's scope: a declaration's own `path.scope` is the function it
  // declares, whose function parent is itself.
  const outer = parent.scope;
  const varScope = outer.getFunctionParent() ?? outer.getProgramParent();
  for (let scope: Scope | undefined = varScope; scope; scope = scope.parent) {
    let names = analysis.annexBNames.get(scope.uid);
    if (!names) {
      names = new Set();
      analysis.annexBNames.set(scope.uid, names);
    }
    names.add(id.name);
  }
}

function recordStringArray(path: NodePath<t.VariableDeclarator>, analysis: ProgramAnalysis): void {
  const init = path.node.init;
  if (!t.isArrayExpression(init) || init.elements.length < 8) return;
  if (!init.elements.every((element) => t.isStringLiteral(element))) return;
  if (!t.isIdentifier(path.node.id)) return;
  const binding = path.scope.getBinding(path.node.id.name);
  if (binding) analysis.stringArrayIdentifiers.add(binding.identifier);
}

/**
 * The loop a `break` leaves, or null when it leaves something else.
 *
 * F07 reads this as "assigned in a loop that then breaks", i.e. a search. The
 * old test asked only whether a `break` sat somewhere inside the loop with no
 * nearer loop between them - which is true of every `break` in a `switch`, and
 * a `break` in a `switch` ends the switch, not the loop. Every
 * `while (true) { switch (state) { ... break; } }` dispatcher therefore looked
 * like a search, and the rule named the state variable, its string decoder and
 * its loop counters `found`.
 *
 * Computed once per `break` here rather than per assignment inside a per-binding
 * walk: the old form re-walked each enclosing loop's whole subtree, and on
 * obfuscated4.js visited more nodes than the program contains.
 */
function breakTargetLoop(path: NodePath<t.BreakStatement>): NodePath | null {
  const label = path.node.label;
  if (!label) {
    // An unlabelled `break` leaves the nearest loop *or* switch, whichever is
    // nearer. Only a loop counts.
    const target = path.findParent((parent) => parent.isLoop() || parent.isSwitchStatement());
    if (!target?.isLoop()) return null;
    return isTrailingBreak(path, target) ? null : target;
  }
  // `break outer;` leaves the statement carrying that label, wherever it is -
  // including out of a nested loop, which the old nearest-loop test could not see.
  const labeled = path.findParent(
    (parent) => parent.isLabeledStatement() && parent.node.label.name === label.name,
  );
  if (!labeled?.isLabeledStatement()) return null;
  const body = labeled.get('body');
  if (!body.isLoop()) return null;
  return isTrailingBreak(path, body) ? null : body;
}

/**
 * A `break` written as the last statement of the loop's own body.
 *
 * `for (...; true;) { switch (order[i++]) { ... } break; }` is the obfuscator's
 * statement-shuffler: the loop runs its switch once and leaves. Nothing is
 * searched for, and a binding written inside it is not a `found`. A search
 * leaves from a *condition* - `if (match) break;` - and that break is not the
 * last statement of the body, it is the last statement of the `if`.
 */
function isTrailingBreak(path: NodePath<t.BreakStatement>, loop: NodePath): boolean {
  const body = loop.get('body');
  if (Array.isArray(body) || !body.isBlockStatement()) return false;
  const statements = body.node.body;
  return statements[statements.length - 1] === path.node;
}

/**
 * `C.name` / `C.toString()` on a class or function reads the identifier text itself.
 *
 * Which object the read lands on decides what has to stay spelled as it is.
 *
 * A plain identifier holds whatever its binding can hold, and
 * `resolveNameReads` walks exactly that. `(a || b).name` and its
 * conditional and sequence cousins are the same question asked of each leaf.
 *
 * The other shapes reach a constructor through the language's own object
 * model rather than through anything the program stored, and that puts every
 * class and function in the program within reach of the read: `super.name`
 * (the parent class), `x.constructor.name` and `x.prototype.constructor.name`
 * (whichever class made `x`), `x.__proto__.name` and
 * `Object.getPrototypeOf(x).name` (the parent class again), `this.name` in a
 * static method or block (the class itself, or a subclass), `arguments.callee`
 * and `.caller`. None of them says which one, so all of them are frozen -
 * the flag, and the loop at the end of `analyzeProgram`. `super.name` inside
 * `class Dog extends Animal` is `"Animal"`, and Animal was renamed with no
 * `Animal.name` anywhere in the file to say it had been read.
 *
 * A parameter is the third kind of object. Its binding holds what the callers
 * pass, so `v.name` inside `function classify(v) { return v instanceof
 * Function ? 'fn:' + v.name : ... }` reads whichever function was passed -
 * the aggressive preset printed `fn:val1` for `fn:nm` on exactly
 * this shape - and the walk of every function therefore reaches the read
 * from each call site's argument. Freezing the whole program instead was the obvious
 * rule and is the wrong one: `obfuscated2.js` reads `['name']` off an IIFE
 * parameter that holds a record, and the whole program includes
 * `getStringArray`. Only when the callers cannot be enumerated does the read
 * widen, to every function the program let go of (`resolveNameReads`), or to
 * everything if a constructor reached through the object model is among them
 * (`recordConstructorEscape`).
 *
 * A free identifier is read as `.name` of what this file stores under that
 * name - `GLOBAL_HOOK = _0x2222; GLOBAL_HOOK.name` - through
 * `holderItems`, since the store and the read may come in either
 * order. A free name this file never writes is another script's variable,
 * and what that script holds is that script's: `obfuscated2.js` reads
 * `['name']` off exactly such a global. That one of our functions might have
 * been handed to that script and published back under the name is the
 * unknown-code boundary this walk stops at everywhere (`o.fn.name`,
 * `arr[i].name`), and here it is two steps past it. The names whose `.name`
 * is known text are not read at all: the global object's `name` is the
 * window's, and the ES builtins' constructors are named by the language.
 *
 * Not a catch parameter. It holds a thrown value, and nothing in this walk can
 * see a `throw`; `catch (e) { if (e.name === 'AbortError') ... }` is in most
 * real programs and throwing a function is in none of them. That is the
 * balanced contract - correct under what real code does - not a proof, and
 * it is the one place this visitor knowingly leaves a `.name` read on a
 * binding it cannot resolve.
 *
 * `o.fn.name` and `arr[i].name` are reads of a value the program put
 * somewhere, and where the somewhere is a literal this file can see whole
 * they are followed to it (`storedValues`). `this.name` in an instance
 * method is a value that arrived through the object model, and stays
 * uncovered. `toString` is on the same footing on every shape but the
 * identifier: it is called on nearly every kind of value, and the text it
 * reads off a function is the source, which every pass upstream of this one
 * has already rewritten.
 *
 * A plain `=` to `.name` reads nothing: on a function the property is not
 * writable, so the assignment fails or throws exactly the same whatever the
 * function is called.
 */
function recordReflection(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  analysis: ProgramAnalysis,
): void {
  const property = reflectedProperty(path.node);
  if (property === null) return;
  if (isPlainAssignmentTarget(path)) return;
  queueNameRead(analysis, path.node.object, path, property);
}

/**
 * `Reflect.get(C, k)` and `Object.getOwnPropertyDescriptor(C, k).value` are
 * `C[k]` spelled as a call: a read of `.name` when `k` is that string, of a
 * key nothing resolves when it is undecoded - `Reflect.get(_0x1, _d(0))`
 * with `_d` refused printed `val1` for the class at aggressive.
 */
function recordBuiltinRead(path: NodePath<t.CallExpression>, analysis: ProgramAnalysis): void {
  const { callee } = path.node;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object) || path.scope.getBinding(callee.object.name)) return;
  const method = memberKey(callee);
  const reads =
    (callee.object.name === 'Reflect' && (method === 'get' || method === 'getOwnPropertyDescriptor')) ||
    (callee.object.name === 'Object' && method === 'getOwnPropertyDescriptor');
  if (!reads) return;
  const [target, key] = path.node.arguments;
  if (!target || !t.isExpression(target) || !key || !t.isExpression(key)) return;
  const spelled = t.isStringLiteral(key) ? key.value : t.isTemplateLiteral(key) && key.expressions.length === 0 ? key.quasis[0]?.value.cooked : undefined;
  let property: 'name' | 'opaque' | undefined;
  if (spelled !== undefined) property = spelled === 'name' ? 'name' : undefined;
  else if (staticNumber(key) === undefined) property = 'opaque';
  if (property) queueNameRead(analysis, target, path, property);
}

/** One `.name` read, held until the traversal is over; see `nameReadQueue`. */
interface NameRead {
  object: t.Expression | t.Super;
  at: NodePath;
  property: 'name' | 'toString' | 'opaque';
}

function queueNameRead(analysis: ProgramAnalysis, object: t.Expression | t.Super, at: NodePath, property: 'name' | 'toString' | 'opaque'): void {
  analysis.nameReadQueue.push({ object, at, property });
}

/** Every static key the file reads or writes by member is a name the escaped global object can be asked for. */
function recordMemberKey(node: t.MemberExpression | t.OptionalMemberExpression, analysis: ProgramAnalysis): void {
  const key = memberKey(node);
  if (key !== null) analysis.memberKeys.add(key);
}

/**
 * The reflected property a member read spells, if it is one this pass tracks.
 *
 * `_0x68f7[p_s(0x86, 'd4x)')]` with the decoder refused is the third kind:
 * a computed read whose key nothing here resolves. With the string array
 * undecoded - common under `stringArrayCallsTransform` - this is what
 * `_0x68f7.name` looks like, and the key often is `'name'`. So it is read as
 * `.name`, whatever it turns out to be: an unresolved key is a missing proof,
 * and the refusal is the correct answer to one. Refusing only the typed
 * fallback, on the argument that a rule which fired had evidence the key was
 * something else, left rule-derived renames firing under `this[k]` in a
 * static method, which the argument never covered, and printed `fn4` for a
 * class whose spelling that read returned. A numeric key is an element read, not a
 * property, and is left to the walk's `elements` mode.
 */
function reflectedProperty(
  node: t.MemberExpression | t.OptionalMemberExpression,
): 'name' | 'toString' | 'opaque' | null {
  const property = memberKey(node);
  if (property === 'name' || property === 'toString') return property;
  if (property !== null || !node.computed) return null;
  return staticNumber(node.property) === undefined ? 'opaque' : null;
}

/** A value this file stores where a member reads, with the path its identifiers resolve from. */
interface StoredValue {
  node: t.Expression;
  at: NodePath;
  /** The elements of the value rather than the value itself: `[...rest][i]`. */
  elements: boolean;
  /**
   * Found among what a builtin was handed, as the builtin's result: one
   * selection off the result is modelled, a second is not; see `selectFrom`.
   */
  viaBuiltin?: boolean;
  /**
   * The value is what a promise settles to - found under an `await`,
   * directly or through a `Promise` combinator that settles to its
   * arguments' values - so a call of an async function is read as what
   * it returns; see `classifyCallRead`.
   */
  awaited?: boolean;
  /**
   * An element of what `Promise.allSettled` settles to: a `{ status, value }`
   * record around the value, which `.value` takes off again; see `selectFrom`.
   */
  wrapped?: boolean;
  /**
   * Set when the value is a part of a parameter - `vs[0]`, `vs.k`, `vs[i].k`
   * - which this file holds nowhere: what it is comes from the callers, and
   * `node` is then the parameter's own identifier, standing in until the
   * read reaches the callers. See `selectFrom`.
   */
  part?: ParamPart;
}

/** A parameter and the selectors applied to it, outermost first. */
interface ParamPart {
  param: Binding;
  select: Selector[];
}

/**
 * The elements of a value found. A part of a parameter is one selection
 * longer - `[*]`, any element - for the callers to apply; anything else is
 * the value in the walk's second mode. A value already in that mode is the
 * elements of each element, which a caller resolves through `selectOff`
 * first: a boolean cannot say "two deep", and reading it as one deep read
 * `.name` off the rows of `[[f], [g]]` instead of off `f` and `g`.
 */
function elementsOf(value: StoredValue): StoredValue {
  if (value.part) {
    const { param, select } = value.part;
    return { node: value.node, at: value.at, elements: false, part: { param, select: [...select, null] } };
  }
  return { node: value.node, at: value.at, elements: true };
}

/**
 * What a member read selects: a property by name, an element by index, or -
 * a computed key nothing here resolves - anything the holder has.
 */
type Selector = string | number | null;

function memberSelector(node: t.MemberExpression | t.OptionalMemberExpression): Selector {
  const key = memberKey(node);
  if (key !== null) return key;
  // A private name is a key no computed read can spell.
  if (t.isPrivateName(node.property)) return `#${node.property.id.name}`;
  const index = node.computed ? staticNumber(node.property) : undefined;
  return index === undefined ? null : index;
}

/** Whether a store under `stored` can be read back by `read`; an unresolved key on either side may. */
function selectorsMeet(stored: Selector, read: Selector): boolean {
  return stored === null || read === null || String(stored) === String(read);
}

/**
 * The values `member` can read, for a holder this file can see whole.
 *
 * The holder is followed exactly as `sourcesOf` follows a
 * binding's value - its initialiser, every `=` to it, every alias - and then
 * the selected property or element is taken off each literal found: a
 * property of an object literal by key (a spread's are those of what it
 * spreads; a computed key nobody resolves matches every read, and a read
 * nobody resolves matches every key), an element of an array literal by
 * index. Stores made afterwards through the binding count too: `kinds.Circle
 * = Circle`, `kinds[k] = v`, `list.push(f)`. A member holder is the same
 * question asked one step earlier, so `a.b.c` is `.c` of whatever `a.b` holds,
 * and a member found as a value is resolved here rather than handed back:
 * `var o = { k: o.k }` would otherwise be handed back to the caller, which
 * would ask this again, without end.
 *
 * Nothing else is opened. A call's result, `this`, a free name are values
 * that came from somewhere this file cannot see, and a method's `.name` is
 * its key, which no binding spells. A parameter is opened one step later:
 * what it holds under a selector is the callers' to say, and comes back as
 * a part of it (`StoredValue.part`). Following an alias that turns out not to
 * hold the object costs a rename, never correctness, which is why the walk
 * unions over every source rather than proving one. What ends it is the
 * visited map, keyed by binding *and* selector: `t = t[k]` asks `.k` of `t`
 * from inside `.k` of `t`, and the selectors are drawn from the syntax, so
 * the pairs are finite even where the aliases are circular.
 */
function storedValues(
  member: t.MemberExpression | t.OptionalMemberExpression,
  at: NodePath,
  analysis: ProgramAnalysis,
  wide: boolean,
  within?: Selection,
): StoredValue[] {
  return selectValues(member.object, at, memberSelector(member), analysis, wide, within);
}

/** The values `holder[selector]` can read, for a holder given as an expression; see `storedValues`. */
function selectValues(
  holder: t.Expression | t.Super,
  at: NodePath,
  selector: Selector,
  analysis: ProgramAnalysis,
  wide: boolean,
  within?: Selection,
): StoredValue[] {
  const selection: Selection = {
    found: [],
    visited: within?.visited ?? new Map(),
    cuts: 0,
    peel: within?.peel ?? 0,
    wide,
    analysis,
  };
  for (const leaf of valueLeaves(holder)) {
    if (!t.isSuper(leaf)) selectFrom({ node: leaf, at, elements: false }, selector, selection);
  }
  // A cut met while resolving a member on behalf of an outer resolution is
  // the outer one's too; see `selecting`.
  if (within) within.cuts += selection.cuts;
  return distinct(selection.found);
}

/** The values `value[selector]` can read, for a value already found - its elements' when it is in that mode. */
function selectOff(value: StoredValue, selector: Selector, analysis: ProgramAnalysis, wide: boolean): StoredValue[] {
  const selection: Selection = { found: [], visited: new Map(), cuts: 0, peel: 0, wide, analysis };
  for (const leaf of valueLeaves(value.node)) {
    if (!t.isSuper(leaf)) selectFrom({ ...value, node: leaf }, selector, selection);
  }
  return distinct(selection.found);
}

/**
 * Each value once. A pair already answered whole is answered again on every
 * ask within one resolution (see `selectFrom`), because the frame in
 * progress may be one that has to hold the answer; a holder of sixty-four
 * properties that all read one table of two thousand values then hands back
 * sixty-four copies of it, and the next level multiplies again. Measured on
 * obfuscated2.js before its strings are decoded: 145 840 values for one
 * `_0x5d0bfa[k]`, and `selectFrom` run 712 000 times where 14 000 was the
 * whole pass.
 */
function distinct(values: StoredValue[]): StoredValue[] {
  if (values.length < 2) return values;
  const seen = new Map<t.Node, Set<string>>();
  const out: StoredValue[] = [];
  for (const value of values) {
    const part = value.part;
    const key = `${value.elements ? 'e' : 'v'}|${part ? part.select.map(String).join('.') : ''}`;
    const owner = part ? part.param.identifier : value.node;
    let keys = seen.get(owner);
    if (!keys) {
      keys = new Set();
      seen.set(owner, keys);
    }
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(value);
  }
  return out;
}

/** One resolution in progress: what it has found, and the (holder, selector) pairs it has asked. */
interface Selection {
  found: StoredValue[];
  /** By binding, literal or class node, or the global object's stand-in; see `asking`. */
  visited: Map<Binding | t.Node, Set<Selector>>;
  /** How many times the walk has met a pair already in progress; see `selectFrom`. */
  cuts: number;
  /** How many levels of elements are being opened at once; see `ELEMENT_DEPTH`. */
  peel: number;
  /** Whether the reading is a `.name` outright, which the global object answers whole; see `selectGlobal`. */
  wide: boolean;
  analysis: ProgramAnalysis;
}

/**
 * How many levels of elements one selection may open - `vs[*][*][*][*]` -
 * before the rest is given up as unseen. `var a = [...a]` names its own
 * elements as its elements, and each level opened finds the same spread
 * again; nothing in real code nests functions four arrays deep, so what
 * reaches the cap is that cycle, and it is disclosed rather than followed.
 */
const ELEMENT_DEPTH = 4;

/**
 * What a holder holds under a selector is a fact about the tree, so it is
 * computed once and kept in `analysis.selections` - except when the walk
 * that computed it met a pair already in progress. That pair's values are
 * still being collected one frame up and are left out of this result, which
 * is complete only as a part of the outer one; kept, it would answer a later
 * read of the inner pair alone with the cycle's values missing. The outer
 * frame sees the same cut through `cuts` and declines to keep its own.
 *
 * A fact about the tree and the rank of the reading: the global object
 * answers a `.name` read whole and an undecoded key with nothing (see
 * `selectGlobal`), so a resolution that passed through it holds less under
 * the one than under the other, and is kept in the table of its rank. Not
 * kept at all would be the other honest choice, and it is the expensive
 * one: every host read in an undecoded obfuscator.io file is a `window[k]`,
 * and a holder whose resolution meets one - the decoder of obfuscated2.js,
 * reassigned 4 900 times - would be enumerated again at every call site
 * that reads a key off its parameter.
 */
function selecting(
  holder: t.Node | Binding,
  selector: Selector,
  selection: Selection,
  compute: () => void,
): void {
  const table = selectionsOf(selection);
  const kept = table.get(holder)?.get(selector);
  if (kept) {
    // Not spread: a string table read by index is a holder of a hundred
    // thousand values, and that many arguments is a stack overflow.
    for (const value of kept) selection.found.push(value);
    return;
  }
  if (!asking(holder, selector, selection)) return;
  const start = selection.found.length;
  const cuts = selection.cuts;
  compute();
  if (selection.cuts !== cuts) return;
  let bySelector = table.get(holder);
  if (!bySelector) {
    bySelector = new Map();
    table.set(holder, bySelector);
  }
  bySelector.set(selector, distinct(selection.found.slice(start)));
}

function selectionsOf(selection: Selection): Map<t.Node | Binding, Map<Selector, StoredValue[]>> {
  return selection.wide ? selection.analysis.wideSelections : selection.analysis.selections;
}

/**
 * Whether this resolution may ask `holder` for `selector`: a pair already
 * asked and not yet answered is the one in progress up the stack - `t.self`
 * from inside `.self` of `t`, a getter reading its own key off `this` - and
 * the second ask is the cycle, cut rather than followed.
 */
function asking(holder: Binding | t.Node, selector: Selector, selection: Selection): boolean {
  const asked = selection.visited.get(holder);
  if (asked?.has(selector)) {
    selection.cuts++;
    return false;
  }
  if (asked) asked.add(selector);
  else selection.visited.set(holder, new Set([selector]));
  return true;
}

/** A store made through a reference: `x.k = v`, `x[i] = v`, or an element pushed in. */
interface MemberStore {
  /** The key or index stored under; null when nothing resolves it, or for a pushed element. */
  selector: Selector;
  /** Whether the value is an element rather than a property, so a string key never reads it. */
  element: boolean;
  /** `Object.assign(x, node)`: every own property of `node` is stored, under its own key. */
  spread?: boolean;
  node: t.Expression;
  at: NodePath;
}

/**
 * Everything the program stores into `binding`'s value through its own
 * references, computed once: a holder read by many members would otherwise
 * have its whole reference list walked for each of them, and on
 * obfuscated4.js - where most reads sit under a handful of module-scope
 * objects - that took the pass from 1.1 s to 11 s.
 */
function memberStoresOf(binding: Binding, analysis: ProgramAnalysis): MemberStore[] {
  const cached = analysis.memberStores.get(binding);
  if (cached) return cached;
  const stores: MemberStore[] = [];
  for (const reference of binding.referencePaths) {
    const outer = reference.parentPath;
    if (!outer?.isMemberExpression() && !outer?.isOptionalMemberExpression()) continue;
    if (outer.node.object !== reference.node) continue;
    const store = outer.parentPath;
    if (store?.isAssignmentExpression() && store.node.left === outer.node) {
      if (!NAMING_ASSIGNMENTS.has(store.node.operator)) continue;
      const selector = memberSelector(outer.node);
      stores.push({ selector, element: false, node: store.node.right, at: store.get('right') });
      continue;
    }
    // `list.push(f)`: an element, at an index nothing here tracks.
    for (const node of storedThrough(reference)) stores.push({ selector: null, element: true, node, at: reference });
  }
  // `Object.assign(x, a, b)`: the own properties of `a` and `b`, under their
  // keys. `Object.defineProperty(x, 'k', { value: f })` and
  // `Object.defineProperties(x, { k: { value: f } })`: `f` under `k`, or
  // what a `get` returns. `m.set('k', f)`, `s.add(f)`: an element the
  // collection hands back by key or by iteration.
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    const call = parent?.isMemberExpression() && parent.node.object === reference.node ? parent.parentPath : parent;
    if (!call?.isCallExpression()) continue;
    const callee = call.node.callee;
    if (!t.isMemberExpression(callee)) continue;
    const method = memberKey(callee);
    if (callee.object === reference.node) {
      if (call.node.callee !== callee) continue;
      if (method === 'set' && call.node.arguments.length >= 2) {
        const [key, value] = call.node.arguments;
        if (t.isExpression(value)) stores.push({ selector: argumentSelector(key), element: false, node: value, at: call });
      } else if (method === 'add' && t.isExpression(call.node.arguments[0])) {
        stores.push({ selector: null, element: true, node: call.node.arguments[0], at: call });
      }
      continue;
    }
    if (call.node.arguments[0] !== reference.node) continue;
    const builtin = t.isIdentifier(callee.object) && !reference.scope.getBinding(callee.object.name) ? callee.object.name : undefined;
    if (builtin !== 'Object' && !(builtin === 'Reflect' && method === 'defineProperty')) continue;
    if (method === 'assign') {
      for (const source of call.node.arguments.slice(1)) {
        const value = t.isSpreadElement(source) ? source.argument : source;
        if (t.isExpression(value)) stores.push({ selector: null, element: false, spread: true, node: value, at: call });
      }
    } else if (method === 'defineProperty') {
      const [, key, descriptor] = call.node.arguments;
      for (const value of descriptorValues(descriptor, call, analysis)) {
        stores.push({ selector: argumentSelector(key), element: false, node: value.node, at: value.at });
      }
    } else if (method === 'defineProperties') {
      for (const entry of descriptorsOf(call.node.arguments[1], call, analysis)) {
        for (const value of descriptorValues(entry.descriptor, entry.at, analysis)) {
          stores.push({ selector: entry.selector, element: false, node: value.node, at: value.at });
        }
      }
    }
  }
  analysis.memberStores.set(binding, stores);
  return stores;
}

/**
 * What a property descriptor literal defines the property as: its `value`,
 * or what its `get` returns. A descriptor that is no literal defines
 * something out of sight.
 */
function descriptorValues(descriptor: t.Node | undefined, at: NodePath, analysis: ProgramAnalysis): StoredValue[] {
  const values: StoredValue[] = [];
  if (!descriptor || !t.isExpression(descriptor)) return values;
  if (!t.isObjectExpression(descriptor)) {
    // `var d = { value: f }; Object.defineProperty(o, 'k', d)`: read off what the local holds.
    for (const value of selectValues(descriptor, at, 'value', analysis, true)) values.push(value);
    for (const getter of selectValues(descriptor, at, 'get', analysis, true)) {
      if (getter.part || getter.elements || !t.isFunction(getter.node)) continue;
      const fn = functionPathOf(getter.node, getter.at, analysis);
      if (fn) for (const returned of returnedValues(fn)) values.push({ node: returned, at: fn, elements: false });
    }
    return values;
  }
  for (const property of descriptor.properties) {
    if (t.isObjectProperty(property) && staticKeyOf(property) === 'value' && t.isExpression(property.value)) {
      values.push({ node: property.value, at, elements: false });
    } else if (t.isObjectMethod(property) && property.kind === 'method' && !property.computed && t.isIdentifier(property.key, { name: 'get' })) {
      const getter = functionPathOf(property, at, analysis);
      if (getter) for (const returned of returnedValues(getter)) values.push({ node: returned, at: getter, elements: false });
    } else if (t.isObjectProperty(property) && staticKeyOf(property) === 'get' && t.isFunction(property.value)) {
      const getter = functionPathOf(property.value, at, analysis);
      if (getter) for (const returned of returnedValues(getter)) values.push({ node: returned, at: getter, elements: false });
    }
  }
  return values;
}

/**
 * The binding and every binding its value flows into, transitively: `var p
 * = o`, `p = o`, `(function (q) { q.k = f })(o)`. A store made through any
 * of them is a store into the one object. The edges are the ones
 * `aliasesOf` walks, read once for the whole program on first use.
 */
function aliasesOf(binding: Binding, analysis: ProgramAnalysis): Binding[] {
  if (!analysis.aliasedBy) {
    const aliasedBy = new Map<Binding, Binding[]>();
    for (const source of analysis.bindings) {
      for (const reference of source.referencePaths) {
        const target = referencePosition(reference).aliasTo;
        if (!target || target === source) continue;
        const list = aliasedBy.get(source);
        if (list) list.push(target);
        else aliasedBy.set(source, [target]);
      }
    }
    analysis.aliasedBy = aliasedBy;
  }
  const found = [binding];
  const seen = new Set(found);
  for (let i = 0; i < found.length; i++) {
    for (const alias of analysis.aliasedBy.get(found[i]!) ?? []) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      found.push(alias);
    }
  }
  return found;
}

/**
 * The class `new C(...)` constructs, when it is in sight: a class expression,
 * or a fixed binding to a declaration or one.
 */
function constructedClass(node: t.NewExpression, at: NodePath, analysis: ProgramAnalysis): NodePath<t.Class> | undefined {
  const [callee] = valueLeaves(node.callee);
  if (!callee || t.isSuper(callee)) return undefined;
  if (t.isClassExpression(callee)) return analysis.classPaths.get(callee);
  if (!t.isIdentifier(callee)) return undefined;
  const binding = throughAliases(at.scope.getBinding(callee.name));
  if (!binding || writesTo(binding).length > 0) return undefined;
  if (binding.path.isClassDeclaration()) return binding.path;
  if (!binding.path.isVariableDeclarator()) return undefined;
  const init = binding.path.node.init;
  return t.isClassExpression(init) ? analysis.classPaths.get(init) : undefined;
}

/**
 * The function `new F(...)` runs, when it is one of this file's and its
 * binding is never written again: a declaration, or a variable initialised
 * with a function expression.
 */
function constructedFunction(node: t.NewExpression, at: NodePath, analysis: ProgramAnalysis): Binding | undefined {
  const [callee] = valueLeaves(node.callee);
  if (!callee || !t.isIdentifier(callee)) return undefined;
  const binding = throughAliases(at.scope.getBinding(callee.name));
  if (!binding || writesTo(binding).length > 0) return undefined;
  if (binding.path.isFunctionDeclaration()) return binding;
  if (binding.path.isVariableDeclarator() && t.isFunctionExpression(binding.path.node.init)) return binding;
  return undefined;
}

/** The binding `var D = C` stands for, through a chain of such aliases never written again; the binding itself when it is no alias. */
function throughAliases(binding: Binding | undefined): Binding | undefined {
  for (let hop = 0; binding && hop < ALIAS_HOPS; hop++) {
    if (writesTo(binding).length > 0 || !binding.path.isVariableDeclarator()) break;
    const { init } = binding.path.node;
    const source = t.isIdentifier(init) ? binding.path.scope.getBinding(init.name) : undefined;
    if (!source || source === binding) break;
    binding = source;
  }
  return binding;
}

/** How many `var D = C` an alias is followed through; see `throughAliases`. */
const ALIAS_HOPS = 4;

/**
 * What an instance of an ES5 constructor holds under `selector`: every
 * `this.k = v` in the constructor's own body (a nested plain function's
 * `this` is its own) and every `F.prototype.k = v` beside it - the ES5
 * spelling of `classMembers`.
 */
function functionInstanceMembers(constructor: Binding, selector: Selector, analysis: ProgramAnalysis): StoredValue[] {
  const members: StoredValue[] = [];
  const declaration = constructor.path;
  const body = declaration.isFunctionDeclaration()
    ? declaration
    : declaration.isVariableDeclarator() && t.isFunction(declaration.node.init)
      ? functionPathOf(declaration.node.init, declaration, analysis)
      : undefined;
  body?.traverse({
    Function(inner) {
      if (!inner.isArrowFunctionExpression()) inner.skip();
    },
    Class(inner) {
      inner.skip();
    },
    ThisExpression(path) {
      const member = path.parentPath;
      // `Object.defineProperty(this, 'k', { value: v })`: stored by a builtin.
      if (member.isCallExpression() && member.node.arguments[0] === path.node) {
        const { callee } = member.node;
        if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: 'Object' }) || member.scope.getBinding('Object')) return;
        const [, key, descriptor] = member.node.arguments;
        if (memberKey(callee) !== 'defineProperty' || !selectorsMeet(argumentSelector(key), selector)) return;
        for (const value of descriptorValues(descriptor, member, analysis)) members.push(value);
        return;
      }
      if (!member.isMemberExpression() || member.node.object !== path.node) return;
      const store = member.parentPath;
      if (!store.isAssignmentExpression({ operator: '=' }) || store.node.left !== member.node) return;
      if (selectorsMeet(memberSelector(member.node), selector)) members.push({ node: store.node.right, at: store.get('right'), elements: false });
    },
  });
  for (const reference of constructor.referencePaths) {
    const prototype = reference.parentPath;
    if (!prototype?.isMemberExpression() || prototype.node.object !== reference.node) continue;
    // `C[k].m = ...` with `k` undecoded may be the prototype; see `prototypeFunctionsOf`.
    const key = memberSelector(prototype.node);
    if (key !== 'prototype' && key !== null) continue;
    const method = prototype.parentPath;
    if (!method.isMemberExpression() || method.node.object !== prototype.node) continue;
    const store = method.parentPath;
    if (!store.isAssignmentExpression({ operator: '=' }) || store.node.left !== method.node) continue;
    if (selectorsMeet(memberSelector(method.node), selector)) members.push({ node: store.node.right, at: store.get('right'), elements: false });
  }
  return members;
}

/** Methods a use of an object runs without spelling a call: coercion, `JSON.stringify`, iteration. */
const IMPLICIT_METHODS: ReadonlySet<string> = new Set(['toString', 'valueOf', 'toJSON']);

/**
 * The functions an object runs on its own when it is used: a literal's
 * getters, setters, `toString`, `valueOf`, `toJSON` and `Symbol.*` methods;
 * those of a class it is an instance of; the traps of a `Proxy` handler,
 * and the accessors of the proxy's target; what `Object.defineProperty`
 * and `defineProperties` installed on it; and, through `__proto__`,
 * `Object.create` and `setPrototypeOf`, those of what it inherits from.
 * `JSON.stringify(o)` runs every getter, `{ ...o }` and `Object.assign`
 * too, `` `${o}` `` runs `toString`, `[...o]` runs `Symbol.iterator`, and
 * `o.x = v` a setter: a use of the object that is no direct read of a
 * plain data property runs code, and the error text it may throw spells
 * the names that code references. With `kind`, the getters or setters
 * under `selector` alone.
 */
function accessorsOf(object: t.Expression | t.Super, at: NodePath, analysis: ProgramAnalysis, kind?: 'get' | 'set', selector: Selector = null): NodePath<t.Function>[] {
  // Every accessor of a local, asked once: a try block references its locals many times over.
  const memoised = !kind && t.isIdentifier(object) ? at.scope.getBinding(object.name) : undefined;
  const kept = memoised && analysis.accessors.get(memoised);
  if (kept) return kept;
  const found: NodePath<t.Function>[] = [];
  if (memoised) analysis.accessors.set(memoised, found);
  const seen = new Set<t.Node>();
  const add = (fn: NodePath<t.Function> | undefined): void => {
    if (fn && !seen.has(fn.node)) {
      seen.add(fn.node);
      found.push(fn);
    }
  };
  const wanted = (key: t.Node, computed: boolean, own: 'get' | 'set' | 'method'): boolean => {
    if (kind) {
      const spelled: Selector = !computed ? (t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null) : t.isStringLiteral(key) ? key.value : (staticNumber(key) ?? null);
      return own === kind && selectorsMeet(spelled, selector);
    }
    if (own !== 'method') return true;
    if (computed) return t.isMemberExpression(key) && t.isIdentifier(key.object, { name: 'Symbol' });
    return t.isIdentifier(key) ? IMPLICIT_METHODS.has(key.name) : t.isStringLiteral(key) && IMPLICIT_METHODS.has(key.value);
  };
  const pending: Array<{ node: t.Expression | t.Super; at: NodePath }> = [{ node: object, at }];
  const fromLiteral = (literal: NodePath<t.ObjectExpression>): void => {
    for (const property of literal.node.properties) {
      if (t.isObjectMethod(property)) {
        if (wanted(property.key, property.computed, property.kind)) add(functionPathOf(property, literal, analysis));
      } else if (t.isObjectProperty(property) && t.isFunction(property.value)) {
        if (wanted(property.key, property.computed, 'method')) add(functionPathOf(property.value, literal, analysis));
      } else if (t.isObjectProperty(property) && t.isExpression(property.value)) {
        if (wanted(property.key, property.computed, 'method')) {
          // `{ toJSON }`, `{ toJSON: f }`: the method spelled by a name.
          const named: NodePath<t.Function>[] = [];
          collectCallees(property.value, literal, analysis, named, 0);
          for (const fn of named) add(fn);
        } else if (!kind) {
          // `JSON.stringify({ inner: h })` runs `h.toJSON` too: what the literal holds is used with it.
          pending.push({ node: property.value, at: literal });
        }
      }
    }
  };
  /** `h.toJSON = function () {...}`, `Object.assign(h, { toJSON })`, `defineProperty(h, 'toJSON', { value })`: a method written onto the local after the fact. */
  const fromStores = (binding: Binding): void => {
    for (const store of memberStoresOf(binding, analysis)) {
      if (store.spread) {
        for (const literal of objectLiteralsOf(store.node, store.at, analysis)) fromLiteral(literal);
      } else if (!kind && !store.element && typeof store.selector === 'string' && IMPLICIT_METHODS.has(store.selector)) {
        const written: NodePath<t.Function>[] = [];
        collectCallees(store.node, store.at, analysis, written, 0);
        for (const fn of written) add(fn);
      }
    }
  };
  const fromDescriptor = (descriptor: t.Node | undefined, near: NodePath): void => {
    if (!t.isObjectExpression(descriptor)) return;
    for (const property of descriptor.properties) {
      const own = t.isObjectMethod(property) || t.isObjectProperty(property) ? propertySelector(property) : undefined;
      if (own !== 'get' && own !== 'set') continue;
      if (kind && own !== kind) continue;
      const fn = t.isObjectMethod(property) ? property : t.isObjectProperty(property) && t.isFunction(property.value) ? property.value : undefined;
      if (fn) add(functionPathOf(fn, near, analysis));
    }
  };
  const bindings = new Set<Binding>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const leaf of valueLeaves(current.node)) {
      if (t.isObjectExpression(leaf)) {
        const literal = literalPathOf(leaf, current.at, analysis);
        if (literal) fromLiteral(literal);
        for (const property of leaf.properties) {
          if (t.isObjectProperty(property) && !property.computed && staticKeyOf(property) === '__proto__' && t.isExpression(property.value)) pending.push({ node: property.value, at: current.at });
        }
      } else if (t.isArrayExpression(leaf)) {
        // `JSON.stringify([h])` runs `h.toJSON`: the elements are used with the array.
        if (!kind) for (const element of leaf.elements) if (element && !t.isSpreadElement(element)) pending.push({ node: element, at: current.at });
      } else if (t.isNewExpression(leaf)) {
        const [head] = valueLeaves(leaf.callee);
        if (t.isIdentifier(head, { name: 'Proxy' }) && !current.at.scope.getBinding('Proxy')) {
          // A trap runs on any use; the target's own accessors behind it.
          const [target, handler] = leaf.arguments;
          if (handler && t.isExpression(handler)) for (const literal of objectLiteralsOf(handler, current.at, analysis)) for (const property of literal.node.properties) {
            const fn = t.isObjectMethod(property) ? property : t.isObjectProperty(property) && t.isFunction(property.value) ? property.value : undefined;
            if (fn) add(functionPathOf(fn, literal, analysis));
          }
          if (target && t.isExpression(target)) pending.push({ node: target, at: current.at });
          continue;
        }
        for (const method of classMethodsOf(leaf, current.at, kind ? selector : null, analysis, kind ?? 'get')) add(method);
        if (!kind) {
          for (const method of classMethodsOf(leaf, current.at, null, analysis, 'set')) add(method);
          for (const name of IMPLICIT_METHODS) for (const method of classMethodsOf(leaf, current.at, name, analysis, 'method')) add(method);
        }
      } else if (t.isCallExpression(leaf)) {
        // `Object.create(p)`, `Object.setPrototypeOf(o, p)`: what is inherited.
        const { callee } = leaf;
        if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: 'Object' }) || current.at.scope.getBinding('Object')) continue;
        const method = memberKey(callee);
        const inherited = method === 'create' ? leaf.arguments[0] : method === 'setPrototypeOf' ? leaf.arguments[1] : undefined;
        if (inherited && t.isExpression(inherited)) pending.push({ node: inherited, at: current.at });
        // `Object.freeze(o)`, `seal`, `setPrototypeOf(o, p)` hand `o` back.
        const returned = method === 'setPrototypeOf' || method === 'freeze' || method === 'seal' || method === 'preventExtensions' ? leaf.arguments[0] : undefined;
        if (returned && t.isExpression(returned)) pending.push({ node: returned, at: current.at });
      } else if (t.isIdentifier(leaf)) {
        const binding = current.at.scope.getBinding(leaf.name);
        if (!binding || bindings.has(binding)) continue;
        bindings.add(binding);
        for (const source of sourcesOf(binding, analysis)) if (!source.elements) pending.push({ node: source.node, at: source.at });
        fromStores(binding);
        for (const reference of binding.referencePaths) {
          const use = reference.parentPath;
          // `Object.defineProperty(o, k, { get })`, `defineProperties(o, { k: { get } })`, `setPrototypeOf(o, p)`, `o.__proto__ = p`.
          if (use?.isCallExpression() && use.node.arguments[0] === reference.node && t.isMemberExpression(use.node.callee) && t.isIdentifier(use.node.callee.object)) {
            const { name } = use.node.callee.object;
            const method = memberKey(use.node.callee);
            if (use.scope.getBinding(name)) continue;
            const [, second, third] = use.node.arguments;
            if (method === 'defineProperty' && (name === 'Object' || name === 'Reflect')) {
              if (!kind || selectorsMeet(argumentSelector(second), selector)) fromDescriptor(third, use);
            } else if (method === 'defineProperties' && name === 'Object' && t.isObjectExpression(second)) {
              for (const property of second.properties) {
                if (t.isObjectProperty(property) && (!kind || selectorsMeet(propertySelector(property), selector))) fromDescriptor(property.value, use);
              }
            } else if (method === 'setPrototypeOf' && (name === 'Object' || name === 'Reflect') && second && t.isExpression(second)) {
              pending.push({ node: second, at: use });
            }
          } else if (use?.isMemberExpression() && use.node.object === reference.node && memberKey(use.node) === '__proto__') {
            const store = use.parentPath;
            if (store.isAssignmentExpression({ operator: '=' }) && store.node.left === use.node) pending.push({ node: store.node.right, at: store });
          }
        }
      }
    }
  }
  return found;
}

/**
 * The methods `object.selector(...)` can run - or, by `kind`, the getters
 * `object.selector` runs and the setters `object.selector = ...` runs - when
 * `object` is `new C()` for a class in sight, its instance side; `C`
 * itself, its static side; or a local holding one of those, followed
 * through its sources and every alias of it: `var c = new C(); var d = c;
 * d.x` ran the getter with `d` unopened. A parent class in sight adds its
 * own.
 */
function classMethodsOf(
  object: t.Expression | t.Super,
  at: NodePath,
  selector: Selector,
  analysis: ProgramAnalysis,
  kind: 'method' | 'get' | 'set' = 'method',
): NodePath<t.Function>[] {
  const methods: NodePath<t.Function>[] = [];
  const found: Array<{ cls: NodePath<t.Class> | undefined; isStatic: boolean }> = [];
  const seen = new Set<Binding>();
  const pending: Array<{ node: t.Expression | t.Super; at: NodePath }> = [{ node: object, at }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const leaf of valueLeaves(current.node)) {
      if (t.isSuper(leaf)) {
        // `super.m(...)`: a method of the parent class, on the side this member is on.
        const owner = thisOwner(current.at, analysis);
        if (owner.kind !== 'class') continue;
        const parent = owner.cls.node.superClass;
        const declared = t.isIdentifier(parent) ? constructedClass(t.newExpression(parent, []), owner.cls, analysis) : t.isClassExpression(parent) ? analysis.classPaths.get(parent) : undefined;
        found.push({ cls: declared, isStatic: owner.isStatic });
        continue;
      }
      if (t.isThisExpression(leaf)) {
        // `this.m(...)` inside a class body: a method of the class, on the instance or the static side.
        const owner = thisOwner(current.at, analysis);
        if (owner.kind === 'class') found.push({ cls: owner.cls, isStatic: owner.isStatic });
        continue;
      }
      if (t.isNewExpression(leaf)) found.push({ cls: constructedClass(leaf, current.at, analysis), isStatic: false });
      else if (t.isClassExpression(leaf)) found.push({ cls: analysis.classPaths.get(leaf), isStatic: true });
      else if (t.isIdentifier(leaf)) {
        found.push({ cls: constructedClass(t.newExpression(leaf, []), current.at, analysis), isStatic: true });
        const binding = current.at.scope.getBinding(leaf.name);
        if (!binding || seen.has(binding) || !binding.path.isVariableDeclarator()) continue;
        seen.add(binding);
        for (const source of sourcesOf(binding, analysis)) {
          if (!source.elements) pending.push({ node: source.node, at: source.at });
        }
      }
    }
  }
  for (let { cls, isStatic } of found) {
    for (let depth = 0; cls && depth < CALLEE_DEPTH; depth++) {
      for (const member of cls.node.body.body) {
        if (!t.isClassMethod(member) || member.kind !== kind || member.static !== isStatic) continue;
        if (!selectorsMeet(propertySelector(member), selector)) continue;
        const path = functionPathOf(member, cls, analysis);
        if (path) methods.push(path);
      }
      const parent = cls.node.superClass;
      cls = t.isIdentifier(parent) ? constructedClass(t.newExpression(parent, []), cls, analysis) : undefined;
    }
  }
  return methods;
}

/**
 * What a class holds under `selector`, on its static side or on an
 * instance: a field's value, what a getter returns, and every `this.k = v`
 * in its body on that side - the constructor's for an instance, a static
 * method's for the class. A parent class is opened the same way, and one
 * that is not in sight is disclosed, since it may hold anything.
 */
function classMembers(
  cls: NodePath<t.Class>,
  selector: Selector,
  isStatic: boolean,
  selection: Selection,
): StoredValue[] {
  const { analysis } = selection;
  const members: StoredValue[] = [];
  for (const member of cls.node.body.body) {
    if (t.isClassProperty(member)) {
      if (member.static !== isStatic || !member.value || !selectorsMeet(propertySelector(member), selector)) continue;
      members.push({ node: member.value, at: cls, elements: false });
    } else if (t.isClassMethod(member) && member.kind === 'get') {
      if (member.static !== isStatic || !selectorsMeet(propertySelector(member), selector)) continue;
      const getter = functionPathOf(member, cls, analysis);
      if (!getter) continue;
      for (const returned of returnedValues(getter)) members.push({ node: returned, at: getter, elements: false });
    }
  }
  for (const store of classStoresOf(cls, analysis)) {
    if (store.isStatic === isStatic && selectorsMeet(store.selector, selector)) {
      members.push({ node: store.node, at: store.at, elements: false });
    }
  }
  const parent = cls.node.superClass;
  if (parent) {
    const found = t.isClassExpression(parent) ? analysis.classPaths.get(parent) : undefined;
    const declared =
      t.isIdentifier(parent) ? constructedClass(t.newExpression(parent, []), cls, analysis) : found;
    if (declared && declared !== cls) for (const member of classMembers(declared, selector, isStatic, selection)) members.push(member);
  }
  return members;
}

/** Every `this.k = v` in a class body, by side, walked once per class. */
function classStoresOf(
  cls: NodePath<t.Class>,
  analysis: ProgramAnalysis,
): Array<{ selector: Selector; isStatic: boolean; node: t.Expression; at: NodePath }> {
  const known = analysis.classStores.get(cls.node);
  if (known) return known;
  const stores: Array<{ selector: Selector; isStatic: boolean; node: t.Expression; at: NodePath }> = [];
  cls.get('body').traverse({
    Class(inner) {
      inner.skip();
    },
    ThisExpression(path) {
      const member = path.parentPath;
      if (!member.isMemberExpression() || member.node.object !== path.node) return;
      const store = member.parentPath;
      if (!store.isAssignmentExpression({ operator: '=' }) || store.node.left !== member.node) return;
      // A `this` inside a plain function nested in a method is that function's.
      const owner = path.getFunctionParent();
      let fn: NodePath | null = owner;
      while (fn && fn.isArrowFunctionExpression()) fn = fn.getFunctionParent();
      if (!fn || !(fn.isClassMethod() || fn.isClassPrivateMethod() || fn.isClassProperty())) return;
      stores.push({ selector: memberSelector(member.node), isStatic: thisIsClass(path, analysis), node: store.node.right, at: store.get('right') });
    },
  });
  // `constructor(private cb)`: `this.cb = cb`, spelled as a parameter.
  for (const member of cls.get('body').get('body')) {
    if (!member.isClassMethod({ kind: 'constructor' })) continue;
    for (const param of member.get('params')) {
      const id = param.isTSParameterProperty() ? parameterPropertyId(param.node) : undefined;
      if (id) stores.push({ selector: id.name, isStatic: false, node: id, at: param });
    }
  }
  analysis.classStores.set(cls.node, stores);
  return stores;
}

/** The name a parameter property declares, when it is a plain one; a pattern under a default is not. */
function parameterPropertyId(property: t.TSParameterProperty): t.Identifier | undefined {
  const { parameter } = property;
  if (t.isIdentifier(parameter)) return parameter;
  return t.isIdentifier(parameter.left) ? parameter.left : undefined;
}

function selectFrom(holder: StoredValue, selector: Selector, selection: Selection): void {
  const { node, at } = holder;
  if (holder.wrapped) {
    if (selector === 'value' || selector === null) selection.found.push({ ...holder, wrapped: false, viaBuiltin: false });
    return;
  }
  // `Object.entries(o)[0][1]`, `Object.getOwnPropertyDescriptors(o).k.value`:
  // a builtin's result opened twice. What it holds one level down is one of
  // its arguments or a member of one; what those hold under a further key
  // is the builtin's own shape, which is not modelled, and disclosed.
  // A part of a parameter, selected again: `vs[0].k` is the `.k` of whatever
  // the callers pass at `[0]`, and the callers are asked once, with the whole
  // path. Not through the cache, which is keyed by binding and one selector.
  if (holder.part) {
    const { param, select } = holder.part;
    const path = holder.elements ? [...select, null, selector] : [...select, selector];
    if (compoundsUnknowns(path, selection.wide)) return;
    selection.found.push({ node, at, elements: false, part: { param, select: path } });
    return;
  }
  // The elements of the holder, each selected in turn: `for (const row of
  // vs) row[0]` is `[0]` of every element of `vs`. An element is anything
  // the holder has (`null` selects it all; on an array that is the elements,
  // and an object is not iterable), and each may be a spread's elements again.
  if (holder.elements) {
    if (selection.peel >= ELEMENT_DEPTH) {
      selection.cuts++;
      return;
    }
    const each: Selection = { ...selection, found: [], cuts: 0, peel: selection.peel + 1 };
    selectFrom({ node, at, elements: false }, null, each);
    selection.cuts += each.cuts;
    selection.peel++;
    for (const element of each.found) selectFrom(element, selector, selection);
    selection.peel--;
    return;
  }
  if (t.isObjectExpression(node)) {
    selecting(node, selector, selection, () => {
      for (const property of node.properties) {
        if (t.isSpreadElement(property)) {
          for (const leaf of valueLeaves(property.argument)) {
            selectFrom({ node: leaf, at, elements: false }, selector, selection);
          }
        } else if (t.isObjectProperty(property) && !property.computed && !property.shorthand && staticKeyOf(property) === '__proto__') {
          // `{ __proto__: o }`: what `o` holds is read through the literal.
          for (const leaf of valueLeaves(property.value as t.Expression)) {
            if (!t.isSuper(leaf)) selectFrom({ node: leaf, at, elements: false }, selector, selection);
          }
        } else if (t.isObjectProperty(property) && propertyMatches(property, selector)) {
          if (t.isExpression(property.value)) emit(property.value, at, false, selection);
        } else if (t.isObjectMethod(property) && property.kind === 'get' && selectorsMeet(propertySelector(property), selector)) {
          // `{ get f() { return _0xh } }`: reading `.f` runs the getter, and
          // the value is what it returns, resolved in its own scope.
          const getter = functionPathOf(property, at, selection.analysis);
          if (getter) for (const returned of returnedValues(getter)) emit(returned, getter, false, selection);
        }
      }
    });
  } else if (t.isArrayExpression(node)) {
    // `.length`, `.map`: a name no element answers to.
    if (typeof selector === 'string') return;
    selecting(node, selector, selection, () => {
      node.elements.forEach((element, index) => {
        if (!element) return;
        if (t.isSpreadElement(element)) emit(element.argument, at, true, selection);
        else if (selector === null || selector === index) emit(element, at, false, selection);
      });
    });
  } else if (t.isIdentifier(node) || t.isThisExpression(node)) {
    const binding = t.isIdentifier(node) ? at.scope.getBinding(node.name) : undefined;
    if (!binding) {
      // `globalThis.h`, `window.h`: the global object, which this file can
      // see two kinds of property of. `this.h` is what `this` is there.
      if (t.isIdentifier(node)) {
        if (GLOBAL_OBJECT_NAMES.has(node.name)) selectGlobal(selector, selection);
        else if (node.name === 'arguments') selectArguments(at, selector, selection);
        return;
      }
      const owner = thisOwner(at, selection.analysis);
      if (owner.kind === 'global') selectGlobal(selector, selection);
      else if (owner.kind === 'maybeGlobal') {
        // A receiver the call site chooses, and the global object among
        // its choices; only a name spelled out is looked for there.
        if (typeof selector === 'string') selectGlobal(selector, selection);
      } else if (owner.kind === 'value') selectFrom(owner.value, selector, selection);
      else if (owner.kind === 'class') {
        // `this.v` in a method: a field, a getter, or what the constructor
        // stored there - `this.v = v` from its parameter, read at `new C(...)`.
        // On the resolution's `visited` map under the class, as the global
        // object is: `this.a = this.b; this.b = this.a` asks each of the
        // other without end.
        if (!asking(owner.cls.node, selector, selection)) return;
        for (const member of classMembers(owner.cls, selector, owner.isStatic, selection)) emit(member.node, member.at, false, selection);
      }
      return;
    }
    // A pair already answered whole is answered again, whether or not this
    // resolution has asked it: `t.self.self` asks `.self` of `t` from
    // inside `.self` of `t`, and only the second ask of a pair still in
    // progress is a cycle. `selecting` keeps nothing for a pair that was cut.
    // Asked as what the binding's promise settles to (`const [a] = await p`
    // with `p = Promise.all(...)`), the answer is the sources' under that
    // reading, and not the table's.
    const kept = holder.awaited ? undefined : selectionsOf(selection).get(binding)?.get(selector);
    if (kept) {
      for (const value of kept) selection.found.push(value);
      return;
    }
    const compute = (): void => {
      // A parameter holds what its callers pass, which no source here shows:
      // the part is handed back as itself, for the callers to
      // read off each call site's argument. Its default and any `=` to it
      // are sources like any other binding's.
      if (binding.kind === 'param' && paramOwner(binding)) {
        selection.found.push({
          node: binding.identifier,
          at: binding.path,
          elements: false,
          part: { param: binding, select: [selector] },
        });
      }
      for (const source of sourcesOf(binding, selection.analysis)) {
        selectFrom(holder.awaited ? { ...source, awaited: true } : source, selector, selection);
      }
      // A class declaration is its own value: `C.f` is a static field, a
      // static getter, or a `this.f = ...` in a static method.
      if (binding.path.isClassDeclaration()) {
        for (const member of classMembers(binding.path, selector, true, selection)) emit(member.node, member.at, false, selection);
      }
      // Stores made through the binding, and through every alias of it:
      // `var p = o; p.k = f` is read back as `o.k`.
      for (const holder of aliasesOf(binding, selection.analysis)) {
        for (const store of memberStoresOf(holder, selection.analysis)) {
          if (store.element ? typeof selector === 'string' : !selectorsMeet(store.selector, selector)) continue;
          if (store.spread) selectFrom({ node: store.node, at: store.at, elements: false }, selector, selection);
          else emit(store.node, store.at, false, selection);
        }
      }
    };
    if (!holder.awaited) selecting(binding, selector, selection, compute);
    else if (asking(binding, selector, selection)) compute();
  } else if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    for (const inner of storedValues(node, at, selection.analysis, selection.wide, selection)) {
      selectFrom(inner, selector, selection);
    }
  } else if (t.isAwaitExpression(node)) {
    // `(await p()).k`, `const { k } = await p()`: a property of what the promise settles to.
    for (const leaf of valueLeaves(node.argument)) {
      if (!t.isSuper(leaf)) selectFrom({ node: leaf, at, elements: holder.elements, awaited: true }, selector, selection);
    }
  } else if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    // A property of what a call returned: `make().fn`, `pick()[0]`, `const
    // { k } = make()`, a row of `for (const row of pick())`. Not followed to
    // the callee's returns - `naming-reflection-members` pins that a
    // property of a call result pins nothing - but a `.name` read past it
    // is disclosed when the call is of a value of this file's, as the read
    // of the result itself is `classifyCallRead`'s. A builtin returns
    // nothing of its own: `Object.assign({}, { k: f }).k`, `Object.values(o)[0]`
    // and `Object.entries(o)` hand back an argument or what it holds, so
    // the selection is made off each argument and off everything in it;
    // `list.filter(f)[0]` is an element of the receiver. Under a key that may itself be `name` the unknowns
    // compound to nothing; see `selectGlobal`.
    const { analysis } = selection;
    // `Array.from(arguments)[0]`, `[].slice.call(arguments)[0]`,
    // `Object.values(o)[i]`: an array a builtin made of what it was handed,
    // whose elements are the argument's own - read under any key, since
    // the builtin adds no unknown of its own.
    const copied = copiedElements(node, at);
    if (copied && typeof selector !== 'string') {
      for (const leaf of valueLeaves(copied.node)) {
        if (!t.isSuper(leaf)) selectFrom({ node: leaf, at, elements: false }, copied.keyed ? null : selector, selection);
      }
      return;
    }
    if (!selection.wide) return;
    const { callee } = node;
    if (t.isV8IntrinsicIdentifier(callee)) return;
    if (foreignRoot(callee, at, analysis)) {
      const bag: Selection = { ...selection, found: [], cuts: 0 };
      // `m.values()`, `s.entries()`: what the receiver was given - stored
      // since, or built in: `new Map([[k, v]])` hands `values()` each `v`,
      // `keys()` each `k`, anything else the pairs - under `get`'s key or all
      // of it. The receiver is a local, through the wrappers a value passes
      // unchanged, or the collection built in place: `new Set([f]).values()`.
      // `it.next()` hands an element back in a record its `.value` opens.
      if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
        const method = memberKey(callee);
        if (method === 'next' && node.arguments.length === 0) {
          const inner: Selection = { ...selection, found: [], cuts: 0 };
          for (const leaf of valueLeaves(callee.object)) {
            if (!t.isSuper(leaf)) selectFrom({ node: leaf, at, elements: false }, null, inner);
          }
          selection.cuts += inner.cuts;
          for (const element of inner.found) selectFrom({ ...element, wrapped: true }, selector, selection);
          return;
        }
        const asked = method === 'get' ? argumentSelector(node.arguments[0]) : null;
        const side = method === 'values' || method === 'get' ? 1 : method === 'keys' ? 0 : null;
        const built: StoredValue[] = [];
        const receivers: Binding[] = [];
        if (!(asked === null && typeof selector === 'string')) {
          for (const leaf of receiverLeaves(callee.object)) {
            if (t.isNewExpression(leaf)) built.push({ node: leaf, at, elements: false });
            else if (t.isIdentifier(leaf)) {
              const receiver = at.scope.getBinding(leaf.name);
              if (receiver) receivers.push(receiver);
            }
          }
        }
        for (const receiver of receivers) {
          for (const holder of collectionBindings(receiver, analysis)) {
            for (const store of memberStoresOf(holder, analysis)) {
              if (store.spread || !selectorsMeet(store.selector, asked)) continue;
              if (asked === null) emit(store.node, store.at, false, bag);
              else selectFrom({ node: store.node, at: store.at, elements: false }, selector, bag);
            }
          }
          for (const source of sourcesOf(receiver, analysis)) {
            if (!source.elements && t.isNewExpression(source.node)) built.push(source);
          }
        }
        for (const source of built) {
          if (!t.isNewExpression(source.node)) continue;
          // `new Map(Object.entries(o))`: the pairs are `o`'s own properties, under their keys.
          const entries = entriesArgument(source.node, source.at);
          if (entries) {
            if (side === 0) continue;
            const inner: Selection = { ...bag, found: [], cuts: 0 };
            for (const leaf of valueLeaves(entries)) {
              if (!t.isSuper(leaf)) selectFrom({ node: leaf, at: source.at, elements: false }, asked, inner);
            }
            bag.cuts += inner.cuts;
            for (const value of inner.found) {
              if (asked === null) bag.found.push(value);
              else selectFrom(value, selector, bag);
            }
            continue;
          }
          for (const each of collectionContents(source.node, source.at) ?? []) {
            const contents: Selection = { ...bag, found: [], cuts: 0 };
            selectFrom(each, null, contents);
            bag.cuts += contents.cuts;
            for (const element of contents.found) {
              if (side !== null && t.isArrayExpression(element.node)) {
                const half = element.node.elements[side];
                if (!half || t.isSpreadElement(half)) continue;
                if (asked !== null && !selectorsMeet(asked, argumentSelector(element.node.elements[0] ?? undefined))) continue;
                if (asked === null) emit(half, element.at, false, bag);
                else selectFrom({ node: half, at: element.at, elements: false }, selector, bag);
              } else if (asked === null) bag.found.push(element);
            }
          }
        }
      }
      // A builtin whose result is shaped from its arguments by name:
      // `Object.fromEntries([[k, v]])` holds each `v` under its `k`;
      // `Object.defineProperty(o, k, { value: v })` and `defineProperties`
      // hand `o` back with `v` under `k`.
      const shaped = shapedBuiltinResult(node, at, selector, analysis);
      if (shaped) {
        for (const value of shaped) emit(value.node, value.at, false, selection);
        return;
      }
      for (const argument of node.arguments) {
        const value = t.isSpreadElement(argument) ? argument.argument : argument;
        if (!t.isExpression(value)) continue;
        for (const leaf of valueLeaves(value)) {
          if (t.isSuper(leaf) || foreignValue(leaf, at, analysis)) continue;
          selectFrom({ node: leaf, at, elements: false }, selector, bag);
          selectFrom({ node: leaf, at, elements: false }, null, bag);
        }
      }
      selection.cuts += bag.cuts;
      // `await Promise.all([p()])` settles to what each element settles to;
      // `allSettled` to a record around each.
      const settled = holder.awaited && settlesToArguments(node, at);
      const wrapped = settled && memberKey(node.callee as t.MemberExpression) === 'allSettled';
      for (const found of bag.found) selection.found.push({ ...found, viaBuiltin: true, awaited: settled || found.awaited, wrapped });
      return;
    }
    if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && !t.isSuper(callee.object)) {
      const key = memberKey(callee);
      if (key !== null && SUBSET_RESULTS.has(key) && typeof selector !== 'string') {
        for (const leaf of valueLeaves(callee.object)) {
          if (!t.isSuper(leaf)) selectFrom({ node: leaf, at, elements: false }, null, selection);
        }
        if (provenArray(callee.object, at, analysis)) return;
      }
    }
  } else if (t.isNewExpression(node)) {
    // `new Set([f])`, `new Map(entries)`, `new Array(f, g)`: a collection
    // built by a builtin from what it was handed, which is what it holds.
    const collected = collectionContents(node, at);
    if (collected) {
      if (typeof selector !== 'string') for (const each of collected) selectFrom(each, null, selection);
      return;
    }
    // `new C().f`: a field or getter of the instance, or a `this.f = ...`
    // in the class body; `C.f` is the static side, read off `C` itself.
    const cls = constructedClass(node, at, selection.analysis);
    const constructor = cls ? undefined : constructedFunction(node, at, selection.analysis);
    if (cls) {
      for (const member of classMembers(cls, selector, false, selection)) emit(member.node, member.at, false, selection);
    } else if (constructor) {
      // `new C().v` with `function C(v) { this.v = v }`: what the
      // constructor stored there, and what sits on its prototype.
      for (const member of functionInstanceMembers(constructor, selector, selection.analysis)) emit(member.node, member.at, false, selection);
    }
  } else if (t.isClassExpression(node)) {
    const cls = selection.analysis.classPaths.get(node);
    if (cls) for (const member of classMembers(cls, selector, true, selection)) emit(member.node, member.at, false, selection);
  }
}

/**
 * What the global object holds under a selector, as far as this file can
 * see: every value it stored there under that name - `globalThis.h = f`,
 * and `h = f` with `h` unbound, which `globalStoresOf` reads - and,
 * in a script, the program-scope `var` or function of that name, which is
 * that property. `o.m(globalThis.h)` with `globalThis.h = function _0x96d6()
 * {}` beside it, the method reading `.name`, printed `fn:val1` at
 * aggressive once the method was inlined. A key nothing resolves selects any
 * of them - for a `.name` read outright. Under a key that may itself be
 * `name` it selects nothing: `window[k1][k2]` with both undecoded is what
 * every host read in an obfuscator.io file looks like before its strings
 * are decoded, and the two unknowns compounded would freeze every top-level
 * binding, the string array's function among them, for a read that spells
 * none of them. That is the same line `classifyRootRead` draws, and
 * the reason `selecting` keeps one table per rank. Not cached here: the
 * global object has no node or binding to key on - but it is on the
 * resolution's `visited` map under a stand-in, since `window.a = window.a
 * || {}` asks `.a` of the global object from inside `.a` of the global
 * object, and that is the cycle `selectFrom` cuts for a binding.
 */
function selectGlobal(selector: Selector, selection: Selection): void {
  if (typeof selector === 'number') return;
  const { analysis } = selection;
  if (selector === null && !selection.wide) return;
  if (!asking(GLOBAL_HOLDER, selector, selection)) return;
  for (const store of globalStoresOf(selector, analysis)) emit(store.node, store.at, false, selection);
  if (!analysis.programScopeIsGlobal) return;
  const scope = analysis.program.scope;
  const bindings = selector === null ? Object.values(scope.bindings) : [scope.getOwnBinding(selector)];
  for (const binding of bindings) {
    if (!binding || !isGlobalObjectProperty(binding, true)) continue;
    selection.found.push({ node: binding.identifier, at: scope.path, elements: false });
  }
}

/**
 * The values this file stores on the global object under `name` - every
 * name, under null: `globalThis.h = f`, `this.h = f` at the top of a
 * script, `g.h = f` with `g` an alias, `h = f` with `h` bound nowhere,
 * `Object.defineProperty(globalThis, 'h', { value: f })` - read off the
 * positions the global walk recorded (`globalMemberReads`, writes among
 * them) and the free references of the name.
 */
function globalStoresOf(name: string | null, analysis: ProgramAnalysis): Array<{ node: t.Expression; at: NodePath }> {
  const stores: Array<{ node: t.Expression; at: NodePath }> = [];
  const members = name === null ? [...analysis.globalMemberReads.values()].flat() : (analysis.globalMemberReads.get(name) ?? []);
  const references = name === null ? [...analysis.freeReferences.values()].flat() : (analysis.freeReferences.get(name) ?? []);
  for (const at of [...members, ...references]) {
    const parent = at.parentPath;
    if (parent?.isAssignmentExpression({ operator: '=' }) && parent.node.left === at.node) {
      stores.push({ node: parent.node.right, at: parent });
    } else if (at.isCallExpression()) {
      // `defineProperty(g, k, d)`, `defineProperties(g, { k: d })`: the descriptors' values.
      const { callee, arguments: args } = at.node;
      if (!t.isMemberExpression(callee)) continue;
      const method = memberKey(callee);
      const descriptors: t.Node[] = [];
      if (method === 'defineProperty' && args[2]) {
        if (name === null || argumentSelector(args[1]) === name) descriptors.push(args[2]);
      } else if (method === 'defineProperties' && t.isObjectExpression(args[1])) {
        for (const property of args[1].properties) {
          if (t.isObjectProperty(property) && (name === null || staticKeyOf(property) === name)) descriptors.push(property.value);
        }
      }
      for (const descriptor of descriptors) for (const value of descriptorValues(descriptor, at, analysis)) if (!value.part && !value.elements) stores.push({ node: value.node, at: value.at });
    }
  }
  return stores;
}

/**
 * `arguments[i]`: the parameter at that position of the nearest function
 * that is no arrow, handed back as a part of it for the callers to answer
 * (`classifyRootRead`), whether or not the function declares it -
 * `function f() { arguments[0].name }` read `f(fn)`'s argument and
 * printed `fn:val1` at aggressive. Under a key nothing resolves, every
 * declared parameter; an argument past the declared list is out of sight,
 * and a `.name` read of it widens as an unseen caller's would.
 */
function selectArguments(at: NodePath, selector: Selector, selection: Selection): void {
  if (typeof selector === 'string') return;
  let fn = at.getFunctionParent();
  while (fn && fn.isArrowFunctionExpression()) fn = fn.getFunctionParent();
  if (!fn) return;
  const { params } = fn.node;
  const indices = selector === null ? params.map((_, index) => index) : [selector];
  for (const index of indices) {
    const param = params[index];
    if (!t.isIdentifier(param)) continue;
    const binding = fn.scope.getOwnBinding(param.name);
    if (!binding) continue;
    selection.found.push({ node: binding.identifier, at: binding.path, elements: false, part: { param: binding, select: [] } });
  }
}

/**
 * Whether a value handed to a builtin is another script's - `foreignRoot`
 * - rather than a collection a builtin built from this file's values:
 * `new Set([f])` outright, a local holding one, or a method called on such
 * a local (`m.values()`), whose result holds what the local was given.
 */
function foreignValue(node: t.Node, at: NodePath, analysis: ProgramAnalysis): boolean {
  if (!foreignRoot(node, at, analysis)) return false;
  let root: t.Node = node;
  if (t.isCallExpression(root) && t.isMemberExpression(root.callee)) root = root.callee.object;
  if (t.isNewExpression(root)) return collectionContents(root, at) === undefined;
  if (!t.isIdentifier(root)) return true;
  const binding = at.scope.getBinding(root.name);
  if (!binding || !binding.path.isVariableDeclarator()) return true;
  const sources = sourcesOf(binding, analysis);
  return sources.length === 0 || !sources.every((source) => !source.elements && t.isNewExpression(source.node) && collectionContents(source.node, source.at) !== undefined);
}

/** Builtin constructors of collections, and whether each argument is an iterable of the contents or one of them. */
const COLLECTION_CONSTRUCTORS: ReadonlyMap<string, 'iterable' | 'each'> = new Map([
  ['Set', 'iterable'],
  ['WeakSet', 'iterable'],
  ['Map', 'iterable'],
  ['WeakMap', 'iterable'],
  ['Array', 'each'],
]);

/**
 * What `new Set(list)`, `new Map(entries)` or `new Array(a, b)` holds, as
 * values whose elements are the contents; undefined for anything else.
 */
function collectionContents(node: t.NewExpression, at: NodePath): StoredValue[] | undefined {
  const [callee] = valueLeaves(node.callee);
  if (!callee || !t.isIdentifier(callee) || at.scope.getBinding(callee.name)) return undefined;
  const shape = COLLECTION_CONSTRUCTORS.get(callee.name);
  if (!shape) return undefined;
  const contents: StoredValue[] = [];
  if (shape === 'iterable') {
    const [iterable] = node.arguments;
    if (iterable && t.isExpression(iterable)) contents.push({ node: iterable, at, elements: false });
  } else {
    for (const argument of node.arguments) {
      if (t.isSpreadElement(argument)) contents.push({ node: argument.argument, at, elements: false });
      else if (t.isExpression(argument)) contents.push({ node: t.arrayExpression([argument]), at, elements: false });
    }
  }
  return contents;
}

/**
 * The value whose elements a builtin's result copies: `Array.from(x)`,
 * `Array.prototype.slice.call(x)` and `[].slice.call(x)`, in order; the
 * property values of `x` for `Object.values(x)`, which `keyed` says, since
 * an index into them selects by a key nothing here orders. Undefined for
 * every other call.
 */
function copiedElements(call: t.CallExpression | t.OptionalCallExpression, at: NodePath): { node: t.Expression; keyed: boolean } | undefined {
  const { callee } = call;
  if (!t.isMemberExpression(callee)) return undefined;
  const method = memberKey(callee);
  const [first] = call.arguments;
  if (!first || !t.isExpression(first)) return undefined;
  if (t.isIdentifier(callee.object) && !at.scope.getBinding(callee.object.name)) {
    if (callee.object.name === 'Array' && method === 'from') return { node: first, keyed: false };
    if (callee.object.name === 'Object' && method === 'values') return { node: first, keyed: true };
    return undefined;
  }
  if (method !== 'call' || !t.isMemberExpression(callee.object) || memberKey(callee.object) !== 'slice') return undefined;
  const receiver = callee.object.object;
  const ownPrototype = t.isMemberExpression(receiver) && t.isIdentifier(receiver.object, { name: 'Array' }) && memberKey(receiver) === 'prototype' && !at.scope.getBinding('Array');
  if (!t.isArrayExpression(receiver) && !ownPrototype) return undefined;
  // `slice.call(x, 1)`: the elements from an offset, which an index into the result no longer names.
  return { node: first, keyed: call.arguments.length > 1 };
}

/**
 * What a builtin's result holds under `selector`, for the builtins that
 * shape it from their arguments by key; undefined for every other call.
 */
function shapedBuiltinResult(call: t.CallExpression | t.OptionalCallExpression, at: NodePath, selector: Selector, analysis: ProgramAnalysis): StoredValue[] | undefined {
  const { callee } = call;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: 'Object' }) || at.scope.getBinding('Object')) return undefined;
  const method = memberKey(callee);
  if (method === 'fromEntries') {
    if (typeof selector === 'number') return [];
    const [entries] = call.arguments;
    if (!entries || !t.isExpression(entries)) return undefined;
    const values: StoredValue[] = [];
    for (const entry of selectValues(entries, at, null, analysis, true)) {
      if (entry.part || entry.elements || !t.isArrayExpression(entry.node)) continue;
      {
      }
      const [key, value] = entry.node.elements;
      if (value && t.isExpression(value) && selectorsMeet(selector, argumentSelector(key ?? undefined))) values.push({ node: value, at: entry.at, elements: false });
    }
    return values;
  }
  if (method !== 'defineProperty' && method !== 'defineProperties') return undefined;
  const [target] = call.arguments;
  if (!target || !t.isExpression(target)) return undefined;
  const values = selectValues(target, at, selector, analysis, true);
  if (method === 'defineProperty') {
    const [, key, descriptor] = call.arguments;
    if (selectorsMeet(selector, argumentSelector(key))) values.push(...descriptorValues(descriptor, at, analysis));
  } else {
    for (const entry of descriptorsOf(call.arguments[1], at, analysis)) {
      if (selectorsMeet(selector, entry.selector)) values.push(...descriptorValues(entry.descriptor, entry.at, analysis));
    }
  }
  return values;
}

/**
 * The descriptors `Object.defineProperties` is handed, each with the key
 * it defines: the properties of a literal, or - `var ds = { k: { value: f
 * } }; Object.defineProperties(o, ds)` - what a local holds, whose keys
 * the resolution does not carry and so are any read's.
 */
function descriptorsOf(descriptors: t.Node | undefined, at: NodePath, analysis: ProgramAnalysis): Array<{ selector: Selector; descriptor: t.Node; at: NodePath }> {
  if (!descriptors || !t.isExpression(descriptors)) return [];
  if (t.isObjectExpression(descriptors)) {
    const entries: Array<{ selector: Selector; descriptor: t.Node; at: NodePath }> = [];
    for (const property of descriptors.properties) {
      if (t.isObjectProperty(property)) entries.push({ selector: propertySelector(property), descriptor: property.value, at });
    }
    return entries;
  }
  return selectValues(descriptors, at, null, analysis, true)
    .filter((value) => !value.part && !value.elements)
    .map((value) => ({ selector: null, descriptor: value.node, at: value.at }));
}

/** The `o` of `new Map(Object.entries(o))`; undefined for any other collection. */
function entriesArgument(collection: t.NewExpression, at: NodePath): t.Expression | undefined {
  const [callee] = valueLeaves(collection.callee);
  if (!t.isIdentifier(callee, { name: 'Map' }) || at.scope.getBinding('Map')) return undefined;
  const [entries] = collection.arguments;
  if (!entries || !t.isCallExpression(entries) || !t.isMemberExpression(entries.callee)) return undefined;
  if (!t.isIdentifier(entries.callee.object, { name: 'Object' }) || memberKey(entries.callee) !== 'entries' || at.scope.getBinding('Object')) return undefined;
  const [object] = entries.arguments;
  return object && t.isExpression(object) ? object : undefined;
}

/** The leaves a receiver spells, through `await` as well as the wrappers `valueLeaves` opens. */
function receiverLeaves(object: t.Expression | t.Super): (t.Expression | t.Super)[] {
  const leaves: (t.Expression | t.Super)[] = [];
  for (const leaf of valueLeaves(object)) {
    if (t.isAwaitExpression(leaf)) leaves.push(...receiverLeaves(leaf.argument));
    else leaves.push(leaf);
  }
  return leaves;
}

/**
 * The bindings whose stores a collection's method reads: the receiver,
 * every binding its value flows into, and - `var m2 = m` - the one it was
 * given, with that one's aliases. Only the forward edges were followed,
 * and `m2.get('k')` read nothing of `m.set('k', f)`.
 */
function collectionBindings(receiver: Binding, analysis: ProgramAnalysis): Binding[] {
  const found = new Set(aliasesOf(receiver, analysis));
  for (const source of sourcesOf(receiver, analysis)) {
    if (source.elements || !t.isIdentifier(source.node)) continue;
    const given = source.at.scope.getBinding(source.node.name);
    if (given) for (const alias of aliasesOf(given, analysis)) found.add(alias);
  }
  return [...found];
}

/** The global object's stand-in on a resolution's `visited` map; see `selectGlobal`. */
const GLOBAL_HOLDER = {} as Binding;

type ThisOwner =
  | { kind: 'global' }
  | { kind: 'maybeGlobal' }
  | { kind: 'value'; value: StoredValue }
  /** Inside a class member: the class on the static side, an instance otherwise. */
  | { kind: 'class'; cls: NodePath<t.Class>; isStatic: boolean }
  | { kind: 'unknown' };

/**
 * What `this` is at `at`, as far as the syntax says. At a script's top
 * level, and in any arrow nested there, it is the global object; a module's
 * is undefined. In a method of an object literal it is the literal - the
 * binding that holds it when the literal initialises one, so that stores
 * made through the binding count too. In a plain sloppy function it is the
 * caller's to choose, and a plain call chooses the global object: `(function
 * () { this.h = function _0x96d6() {} })()` publishes `_0x96d6` exactly as
 * `globalThis.h = ...` does, so the global object is among what it may be. A
 * strict function's is undefined on that call, and a class's is the class
 * or an instance, which `thisIsClass` and the object model answer for.
 */
function thisOwner(at: NodePath, analysis: ProgramAnalysis): ThisOwner {
  if (!analysis.programScopeIsGlobal) return { kind: 'unknown' };
  let plain = false;
  for (let path: NodePath | null = at; path; path = path.parentPath) {
    if (path.isClassMethod() || path.isClassPrivateMethod() || path.isClassProperty() || path.isClassPrivateProperty()) {
      const cls = path.parentPath.parentPath;
      if (plain || !cls?.isClass()) return { kind: 'unknown' };
      return { kind: 'class', cls, isStatic: thisIsClass(at, analysis) };
    }
    if (path.isClass()) return { kind: 'unknown' };
    if (path.isObjectMethod()) {
      if (plain) return { kind: 'unknown' };
      const literal = path.parentPath;
      if (!literal.isObjectExpression()) return { kind: 'unknown' };
      const declarator = literal.parentPath;
      const id = declarator.isVariableDeclarator() && declarator.node.init === literal.node ? declarator.node.id : null;
      const node = t.isIdentifier(id) ? id : literal.node;
      return { kind: 'value', value: { node, at: literal, elements: false } };
    }
    if (path.isFunction() && !path.isArrowFunctionExpression()) {
      if (isStrict(path.node.body)) return { kind: 'unknown' };
      plain = true;
    }
    if (path.isProgram() && isStrict(path.node)) return plain ? { kind: 'unknown' } : { kind: 'global' };
  }
  return plain ? { kind: 'maybeGlobal' } : { kind: 'global' };
}

function isStrict(body: t.Node): boolean {
  return (
    (t.isBlockStatement(body) || t.isProgram(body)) &&
    body.directives.some((directive) => directive.value.value === 'use strict')
  );
}

/** Record a value found; a member is resolved in place, everything else is handed back as it is. */
function emit(value: t.Expression, at: NodePath, elements: boolean, selection: Selection): void {
  for (const leaf of valueLeaves(value)) {
    if (t.isSuper(leaf)) continue;
    if (t.isMemberExpression(leaf) || t.isOptionalMemberExpression(leaf)) {
      for (const inner of storedValues(leaf, at, selection.analysis, selection.wide, selection)) {
        if (!elements) selection.found.push(inner);
        else if (inner.elements) {
          for (const each of selectOff(inner, null, selection.analysis, selection.wide)) selection.found.push(each);
        } else selection.found.push(elementsOf(inner));
      }
    } else {
      selection.found.push({ node: leaf, at, elements });
    }
  }
}

/** A value a binding is given, with the path its identifiers resolve from; `elements` for the iterable of a `for-of` head. */
interface BindingSource {
  node: t.Expression;
  at: NodePath;
  elements: boolean;
}

/**
 * Every value a binding is given, each resolved in the scope it sits in:
 * a declarator's initialiser, a parameter's default, every `=` (and
 * `||=`, `&&=`, `??=`) to it, the iterable of a `for-of` it is the head of
 * - as `elements`. A pattern is opened one level: `var { k } = o` gives
 * `k` the member `o.k`, and `var [a] = [x]` gives `a` the element written
 * there. Each source is one leaf through `||`, `??`, `?:` and `,`. Kept
 * per binding.
 */
function sourcesOf(binding: Binding, analysis: ProgramAnalysis): BindingSource[] {
  const cached = analysis.bindingSources.get(binding);
  if (cached) return cached;
  const sources: BindingSource[] = [];
  const add = (node: t.Expression | null | undefined, at: NodePath, elements = false): void => {
    if (!node) return;
    for (const leaf of valueLeaves(node)) if (!t.isSuper(leaf)) sources.push({ node: leaf, at, elements });
  };
  const declaration = binding.path;
  if (declaration.isVariableDeclarator()) {
    const { id, init } = declaration.node;
    if (init) {
      const at = declaration.get('init') as NodePath;
      if (t.isIdentifier(id)) add(init, at);
      else add(projectPattern(id, binding.identifier.name, init), at);
    } else {
      const loop = declaration.parentPath?.parentPath;
      if (loop?.isForOfStatement() && t.isIdentifier(id)) add(loop.node.right, loop, true);
    }
    add(defaultValueOf(id, binding.identifier), declaration);
  } else if (binding.kind === 'param') {
    add(defaultValueOf(declaration.node, binding.identifier), declaration);
  }
  for (const violation of binding.constantViolations) {
    if (violation.isForOfStatement()) {
      if (t.isIdentifier(violation.node.left)) add(violation.node.right, violation, true);
      continue;
    }
    if (!violation.isAssignmentExpression() || !NAMING_ASSIGNMENTS.has(violation.node.operator)) continue;
    const { left, right } = violation.node;
    const at = violation.get('right');
    if (t.isIdentifier(left)) add(right, at);
    else if (violation.node.operator === '=') add(projectPattern(left, binding.identifier.name, right), at);
  }
  analysis.bindingSources.set(binding, sources);
  return sources;
}

/**
 * What `name` receives when `pattern` is matched against `value`: the
 * property or element of a literal written there, or a member spelled for
 * it off any other value - a node of the walk's own making, resolved in
 * the value's scope. Nothing for a rest, which holds a fresh object.
 */
function projectPattern(pattern: t.Node, name: string, value: t.Expression): t.Expression | undefined {
  if (t.isAssignmentPattern(pattern)) return projectPattern(pattern.left, name, value);
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (!t.isObjectProperty(property)) continue;
      const key = patternKeyOf(property);
      if (key === null) continue;
      let selected: t.Expression | undefined;
      if (t.isObjectExpression(value)) selected = objectLiteralValue(value, key) ?? undefined;
      else selected = t.memberExpression(value, t.stringLiteral(key), true);
      if (!selected) continue;
      const target = t.isAssignmentPattern(property.value) ? property.value.left : property.value;
      if (t.isIdentifier(target, { name })) return selected;
      const deeper = projectPattern(target, name, selected);
      if (deeper) return deeper;
    }
    return undefined;
  }
  if (t.isArrayPattern(pattern)) {
    for (const [index, element] of pattern.elements.entries()) {
      if (!element || t.isRestElement(element)) continue;
      let selected: t.Expression | undefined;
      if (t.isArrayExpression(value)) {
        if (value.elements.slice(0, index + 1).some((each) => !each || t.isSpreadElement(each))) return undefined;
        selected = value.elements[index] as t.Expression | undefined;
      } else selected = t.memberExpression(value, t.numericLiteral(index), true);
      if (!selected) continue;
      const target = t.isAssignmentPattern(element) ? element.left : element;
      if (t.isIdentifier(target, { name })) return selected;
      const deeper = projectPattern(target, name, selected);
      if (deeper) return deeper;
    }
  }
  return undefined;
}

/** The value an object literal holds under `key`; null when a spread or computed key may hold it, undefined when nothing does. */
function objectLiteralValue(object: t.ObjectExpression, key: string): t.Expression | undefined | null {
  let value: t.Expression | undefined | null;
  for (const property of object.properties) {
    if (!t.isObjectProperty(property)) return null;
    const own = staticKeyOf(property);
    if (own === undefined) return null;
    if (own !== key) continue;
    if (!t.isExpression(property.value)) return null;
    value = property.value;
  }
  return value;
}

/** Whether an object literal's property is one `selector` can read; a computed key nobody resolves is. */
function propertyMatches(property: t.ObjectProperty, selector: Selector): boolean {
  if (selector === null) return true;
  const { key } = property;
  let stored: Selector;
  if (property.computed) {
    if (t.isStringLiteral(key)) stored = key.value;
    else if (t.isNumericLiteral(key)) stored = key.value;
    else return staticNumber(key) === undefined || staticNumber(key) === Number(selector);
  } else if (t.isIdentifier(key)) stored = key.name;
  else if (t.isStringLiteral(key)) stored = key.value;
  else if (t.isNumericLiteral(key)) stored = key.value;
  else return false;
  return String(stored) === String(selector);
}

/** The function a parameter binding belongs to and its index there; undefined for a binding that is no such thing. */
function paramOwner(binding: Binding): { fn: NodePath<t.Function>; index: number } | undefined {
  const fn = binding.path.parentPath;
  const index = binding.path.key;
  if (!fn?.isFunction() || typeof index !== 'number' || binding.path.listKey !== 'params') return undefined;
  return { fn, index };
}

/**
 * How many selectors a part of a parameter may carry under a reading that
 * is itself a key nothing resolves: `v[i].k` read as `[k2]` is followed,
 * `v[i][j][l]` is not. That is the compounding of unknowns `selectGlobal`
 * refuses for `window[k1][k2]`, refused here for the same reason and one
 * more: every call through an undecoded key of an obfuscator.io proxy map is
 * a call of every method in it, and each such part read at each such site
 * is one more part, deeper by one, without end before `SELECT_DEPTH` -
 * ninety thousand readings on obfuscated2.js. A `.name` read outright is
 * followed to `SELECT_DEPTH` whatever the path.
 */
const OPAQUE_SELECT_DEPTH = 2;

function compoundsUnknowns(select: Selector[], wide: boolean): boolean {
  return !wide && select.length > OPAQUE_SELECT_DEPTH;
}

// ---------------------------------------------------------------------------
// Value flow: one walk for the global object, a caught error, our own functions
// ---------------------------------------------------------------------------

/**
 * The wrappers a builtin puts around a value, as steps from a holder down
 * to it: a promise that settles to it or rejects with it, a `WeakRef` that
 * derefs to it, an object whose prototype it is - through which a read of
 * any key the object lacks reaches it.
 */
const SETTLE: unique symbol = Symbol('settle');
const REJECT: unique symbol = Symbol('reject');
const DEREF: unique symbol = Symbol('deref');
const PROTO: unique symbol = Symbol('proto');
/** A `Map`'s entry: the key follows, and iteration hands out `[key, value]` pairs where an array hands out elements. */
const ENTRY: unique symbol = Symbol('entry');
/** A function bound with arguments: `f.bind(r, a)`, whose `.name` is `"bound "` and the value's, and whose calls are the value's with `a` first. */
const BOUND: unique symbol = Symbol('bound');

type Wrap = typeof SETTLE | typeof REJECT | typeof DEREF | typeof PROTO | typeof ENTRY | typeof BOUND;

/** One step from a holder down to the value it holds: a selector, or a wrapper. */
type Step = Selector | Wrap;

function isWrap(step: Step | undefined): step is Wrap {
  return typeof step === 'symbol';
}

/** Whether the first step selects an element: an index, or a key nothing resolves, of an array or collection. */
function isElementStep(step: Step | undefined): step is number | null {
  return step === null || typeof step === 'number';
}

/**
 * How the value came to where it is, for a `.name` read of it: as itself
 * (0); inside what a fixed function returned, by a call spelled with its
 * name - `pick()[0]`, `var w = pick(); w.k` - where a member or pattern
 * selection is disclosed rather than followed, and an iteration opens the
 * result once (1), after which a second opening is disclosed too (3); or
 * through a call the reader does not resolve to its function - `o.get()`,
 * `q[0]()`, a reassigned local called - after which every read is
 * disclosed (2). The contract `naming-reflection-members` and
 * `naming-unfollowed-reads` pin: what a call hands back is the one value
 * the reflection walk leaves at its boundary, said rather than pinned, and
 * the elements of it are opened one level. Only the reflection walk
 * carries the tag; the others follow every return whole, and their
 * answers are kept apart.
 */
type Past = 0 | 1 | 2 | 3;

/**
 * A binding whose references hold the value under `steps` - none when the
 * binding is the value; with `instances`, a constructor whose every
 * instance holds it; or, as a string, a property of the global object that
 * nothing in this file binds, read wherever the name is spelled free. See
 * `Flow`.
 */
interface FlowItem {
  target: Binding | string;
  steps: readonly Step[];
  instances?: boolean;
  past?: Past;
}

/** A member access of the value: the member path (or the call or pattern standing for one), the key, and its node when computed. */
interface FlowRead {
  at: NodePath;
  selector: Selector;
  key: t.Node | undefined;
  /** For a pattern: the target the property lands in, for a reader that follows the property on; see `resolveGlobalAliases`. */
  into?: t.Node;
  /** `'k' in x`, `x.hasOwnProperty('k')`: asks after the key without reading the value under it. */
  probe?: boolean;
  /** Reached past a call result; see `Past`. */
  past?: Past;
  /** `x.k = v`: the key written, which names a property of the value without reading one. */
  write?: boolean;
}

/** A call the walk could not resolve to a function, with the argument the value sits in; see `Flow.unresolved`. */
interface FlowCall {
  call: NodePath<CallLike>;
  index: number;
  steps: readonly Step[];
  /** `f.apply(r, list)` with `f` unresolved: the index is into the list; -1 is the receiver. */
  applied: t.Expression | undefined;
}

/**
 * What one item's references do with the value: where it is read, called,
 * coerced, enumerated, lost, and which bindings it flows on into. A binding
 * item's is computed once and kept (`bindingReached`), since an
 * obfuscator.io proxy map is asked this once per method it holds, over
 * thousands of references; the expressions reached from a binding are
 * followed inside its own answer, so that `map[k](...)` sites found through
 * the map are one array shared by every method of it - a reading applied
 * to the array is applied once for all of them (`calleeTargets`).
 */
interface Reached {
  reads: FlowRead[];
  /** Call positions of the value itself. */
  calls: Holder[];
  /** Bindings the value flows on into. */
  next: FlowItem[];
  /** Where the walk lost the value: handed to what it cannot resolve, stored on what is no local, returned to callers out of sight. */
  escapes: NodePath[];
  /** Handed to another script's function: the boundary the walk stops at, which only a function's callers are lost to. */
  foreign: NodePath[];
  /** Calls whose callee did not resolve at the time; see `Flow.unresolved`. */
  unresolved: FlowCall[];
  /** Coerced to a string or number: a template, `+`, `String()`, `==`, `toString()`. */
  coerced: NodePath[];
  /** The value's own keys enumerated. */
  enumerated: boolean;
  /** A binding written again, or reachable by its name without a reference: uses this list does not show. */
  unlisted: boolean;
  /** Whether a bound of the walk's own - depth, items, fan-out - cut it short here; disclosed by the reflection walk. */
  bounded: boolean;
  /** Whether the value is returned from a function; a `.name` read that widens reaches it there. */
  returned: boolean;
  /** Whether the walk stopped following the value out of a call result (see `Past`): where it went from there is out of sight. */
  cut: boolean;
  /**
   * Whether the walk took the mainstream assumption here - an element held
   * under a key nothing resolves, read under another, is not the value -
   * and left the read unfollowed; see `FlowWalk.assumes`. Disclosed by the
   * error walk.
   */
  assumed: boolean;
}

function emptyReached(): Reached {
  return { reads: [], calls: [], next: [], escapes: [], foreign: [], unresolved: [], coerced: [], enumerated: false, unlisted: false, bounded: false, returned: false, cut: false, assumed: false };
}

/** One answer being computed: where it goes, and the expressions it has already followed. */
interface FlowWalk {
  analysis: ProgramAnalysis;
  out: Reached;
  /** Expression items followed, by node and steps: `function f() { return f() }` returns to its own call without end. */
  seen: Set<string>;
  /** How the value came to be here, for the reflection walk alone; see `Past`. */
  past: Past | undefined;
  /**
   * Whether an element held under a key nothing resolves is taken not to be
   * read back under another - two unknowns compounded, which
   * `compoundsUnknowns` refuses for a selection - and the read is left
   * unfollowed, marked `Reached.assumed`. The error walk's at balanced and
   * aggressive (`readsErrorText`); every other walk follows it, since a
   * function's callers and the global object's readers are found there.
   */
  assumes: boolean;
}

/** The same answer, followed on under another tag; see `Past`. */
function withPast(walk: FlowWalk, past: Past): FlowWalk {
  return walk.past === undefined || walk.past === past ? walk : { analysis: walk.analysis, out: walk.out, seen: walk.seen, past, assumes: walk.assumes };
}

/**
 * The walk to go on with once an element is taken out of a call result -
 * by an iteration, a spread, a callback, an element method - leaving the
 * value under `rest`; none when that is one opening too many, which is
 * filed as a read the reflection walk discloses. See `Past`.
 */
function opened(at: NodePath, rest: readonly Step[], walk: FlowWalk): FlowWalk | undefined {
  if (walk.past === 1) return withPast(walk, rest.some((step) => !isWrap(step)) ? 3 : 0);
  if (walk.past !== 3) return walk;
  walk.out.reads.push({ at, selector: null, key: undefined, past: 3 });
  walk.out.cut = true;
  return undefined;
}

/** The key a step list is memoised under. */
function stepsKey(steps: readonly Step[], instances?: boolean, past?: Past, assumes = false): string {
  let key = (instances ? 'new' : '') + (past === undefined ? '' : `p${past}`) + (assumes ? '~a' : '');
  for (const step of steps) {
    key +=
      step === SETTLE ? '~s' : step === REJECT ? '~r' : step === DEREF ? '~d' : step === PROTO ? '~p' : step === ENTRY ? '~e' : step === BOUND ? '~b' : step === null ? '[*]' : typeof step === 'number' ? `[${step}]` : `.${step}`;
  }
  return key;
}

/**
 * One walk of a value through the program: the positions its spellings
 * sit in, the bindings it moves into, the holders it is stored in and read
 * back out of, the parameters it is handed to, the call sites its function
 * returns it to - until it is read, called, coerced, or lost.
 *
 * Three questions are asked of the one walk. The global object
 * (`resolveGlobalAliases`): every member read through any spelling of it
 * is a use of a program-scope name, and where it is lost, code there can
 * read any of them. A caught error (`readsErrorText`): a read of its text
 * or a coercion spells the binding names V8 put there, and where it is
 * lost the text may be read out of sight. One of this file's own
 * functions (`holdersOf`): every position it can be called from is where a
 * `.name` read on its parameters is answered, and where it is lost the
 * callers are out of sight. Each used to have a walk of its own, and each
 * covered a different subset of the spellings a value passes through; a
 * spelling one missed was a program-scope function renamed under a read,
 * an error text with a new name in it, a parameter's `.name` read that no
 * call site answered.
 *
 * The walk is over binding items, each answered once for the whole program
 * (`bindingReached`) and shared between walks and kinds, since what a
 * reference does with a value is a fact about the tree and not about who
 * asks; the expressions a walk starts from are its own. Items carry a
 * rank, for the global walk alone: a `this` the call site chooses is a
 * weaker spelling than the name written out, and an item is walked again
 * when a stronger rank reaches it. A call the walk could not resolve is
 * kept on `unresolved`, because a callee that is a value read off the
 * global object resolves once its root is known to be an alias - which the
 * global walk itself discovers, and so retries them; every other walk
 * counts them as lost.
 */
class Flow {
  private readonly seen = new Map<string, number>();
  private readonly pending: Array<{ item: FlowItem; rank: number }> = [];
  /** The walk's own expressions, per rank: one answer each, followed once each. */
  private readonly walks = new Map<number, FlowWalk>();
  /** How much of each answer has been queued on; see `settle`. */
  private readonly settled = new Map<Reached, { next: number; unresolved: number }>();
  /** Every binding item's answer this walk went through, with the strongest rank it was reached at. */
  readonly segments = new Map<Reached, number>();
  readonly unresolved: Array<{ call: FlowCall; rank: number }> = [];

  /** Given as 0, the walk tags what it reaches past a call result; see `Past`. `assumes` is `FlowWalk.assumes`. */
  constructor(readonly analysis: ProgramAnalysis, private readonly past?: Past, private readonly assumes = false) {}

  /** The walk's own answer at a rank, for expressions followed into it directly. */
  walkAt(rank = 0): FlowWalk {
    let walk = this.walks.get(rank);
    if (!walk) {
      walk = { analysis: this.analysis, out: emptyReached(), seen: new Set(), past: this.past, assumes: this.assumes };
      this.walks.set(rank, walk);
    }
    return walk;
  }

  /** Follows an expression that is the value (no steps) or holds it, as the walk's own. */
  start(path: NodePath, steps: readonly Step[], rank = 0): void {
    const walk = this.walkAt(rank);
    holderExpression(path, steps, walk);
    this.settle(walk.out, rank);
  }

  /** The value itself, at every reference of a binding; a named function or class expression also at its own node. */
  startBinding(binding: Binding, rank = 0): void {
    this.add({ target: binding, steps: [] }, rank);
    if (namesOwnExpression(binding)) this.start(binding.path, [], rank);
  }

  add(item: FlowItem, rank = 0): void {
    this.pending.push({ item: item.past === undefined && this.past !== undefined ? { ...item, past: this.past } : item, rank });
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Queues what an answer flows on into, and keeps its unresolved calls, past what was queued before. */
  settle(reached: Reached, rank: number): void {
    let cursor = this.settled.get(reached);
    if (!cursor) {
      cursor = { next: 0, unresolved: 0 };
      this.settled.set(reached, cursor);
    }
    for (; cursor.next < reached.next.length; cursor.next++) this.pending.push({ item: reached.next[cursor.next]!, rank });
    for (; cursor.unresolved < reached.unresolved.length; cursor.unresolved++) this.unresolved.push({ call: reached.unresolved[cursor.unresolved]!, rank });
  }

  /**
   * Walks every queued item; `onItem` sees each binding item once per rank
   * it is reached at. Two budgets keep a cyclic object graph from being
   * enumerated path by path: a walk that has gone through `FLOW_ITEMS`
   * items, and a binding asked under `FLOW_FANOUT` step lists two or more
   * deep, are where the value is lost. Measured on obfuscated2.js, a
   * library whose instances hold each other: 508 100 items and 17 million
   * positions for 45 functions' holders, against 22 items on
   * obfuscated3.js - every path through the graph up to the depth bound,
   * and the callers each path found were the same few.
   */
  drain(onItem?: (item: FlowItem, reached: Reached, rank: number) => void): void {
    const { analysis } = this;
    while (this.pending.length > 0) {
      const { item, rank } = this.pending.pop()!;
      const { target } = item;
      const key = `${typeof target === 'string' ? `${target}!` : `${target.identifier.start ?? ''}:${target.identifier.name}@${target.scope.uid}`}|${stepsKey(item.steps, item.instances, item.past, this.assumes)}`;
      const walked = this.seen.get(key);
      if (walked !== undefined && walked >= rank) continue;
      const lostAt = typeof target === 'string' ? analysis.program : target.path;
      if (this.seen.size >= FLOW_ITEMS) {
        const own = this.walkAt(rank).out;
        own.escapes.push(lostAt);
        own.bounded = true;
        this.pending.length = 0;
        return;
      }
      if (item.steps.length >= 2 && walked === undefined && typeof target !== 'string') {
        const deep = (analysis.flowFanout.get(target) ?? 0) + 1;
        analysis.flowFanout.set(target, deep);
        if (deep > FLOW_FANOUT) {
          const own = this.walkAt(rank).out;
          own.escapes.push(lostAt);
          own.bounded = true;
          continue;
        }
      }
      this.seen.set(key, rank);
      const reached = typeof target === 'string' ? freeReached(target, item.steps, item.past, this.analysis, this.assumes) : bindingReached(target, item.steps, item.instances ?? false, item.past, this.analysis, this.assumes);
      this.segments.set(reached, Math.max(this.segments.get(reached) ?? 0, rank));
      // Reached at a stronger rank, an answer's cursor already stands at
      // its end; every item it flows into is queued again under the new rank.
      if (walked !== undefined) {
        for (const next of reached.next) this.pending.push({ item: next, rank });
      } else this.settle(reached, rank);
      onItem?.(item, reached, rank);
    }
  }

  /** Every answer the walk holds, own first, with its rank. */
  *reached(): Generator<[Reached, number]> {
    for (const [rank, walk] of this.walks) yield [walk.out, rank];
    for (const [segment, rank] of this.segments) yield [segment, rank];
  }

  /** Whether the value was lost anywhere the walk went; a foreign callee is the boundary and counts only when asked. */
  lost(foreign = false): boolean {
    for (const [reached] of this.reached()) {
      if (reached.escapes.length > 0 || reached.unresolved.length > 0 || reached.unlisted) return true;
      if (foreign && reached.foreign.length > 0) return true;
    }
    return false;
  }
}

/**
 * What a binding's references do with the value they hold under `steps`,
 * kept per binding and steps. A kept answer with a call unresolved is
 * asked again once an alias of the global object has been found since,
 * exactly as `resolveCallee` keeps its own; one met in progress - a
 * reference reaching its own item through a cycle - is answered as it
 * stands.
 */
function bindingReached(binding: Binding, steps: readonly Step[], instances: boolean, past: Past | undefined, analysis: ProgramAnalysis, assumes = false): Reached {
  let byKey = analysis.flowReached.get(binding);
  if (!byKey) {
    byKey = new Map();
    analysis.flowReached.set(binding, byKey);
  }
  const key = stepsKey(steps, instances, past, assumes);
  const kept = byKey.get(key);
  if (kept && (kept.reached.unresolved.length === 0 || kept.generation === analysis.aliasGeneration)) return kept.reached;
  const reached = emptyReached();
  byKey.set(key, { reached, generation: analysis.aliasGeneration });
  const walk: FlowWalk = { analysis, out: reached, seen: new Set(), past, assumes };
  if (steps.length > FLOW_DEPTH) {
    reached.escapes.push(binding.path);
    reached.bounded = true;
  } else if (instances) instanceReached(binding, steps, walk);
  else followBinding(binding, steps, walk);
  return reached;
}

/**
 * The references of a binding, each followed as the value (no steps) or as
 * a holder of it. As the value: a binding written again, or reachable by
 * its name without a reference, has uses this list does not show; a
 * program-scope `var` is read through the global object under its name -
 * `globalThis._0xf(fn)`, and `g[k](fn)` with `k` undecoded may be any of
 * them. As a holder: `this.k` inside the methods of a literal the binding
 * holds is a read through it, and so is `this.k` in the static members of
 * a class it names. Under a key nothing resolves every reference of an
 * obfuscator.io proxy map is a call of every method in it - three hundred
 * methods over three thousand sites names every argument in the file as a
 * value of every parameter, at a cost that says nothing - so past
 * `UNRESOLVED_SITES` such sites the readers are out of sight, as they
 * were before they were enumerated.
 */
function followBinding(binding: Binding, steps: readonly Step[], walk: FlowWalk): void {
  const { analysis, out } = walk;
  if (steps.length === 0) {
    if (writesTo(binding).length > 0 || reachedByName(binding, analysis)) out.unlisted = true;
    if (isGlobalObjectProperty(binding, analysis.programScopeIsGlobal)) out.next.push({ target: binding.identifier.name, steps, past: walk.past });
  } else {
    if (!isWrap(steps[0]) && !(walk.assumes && steps[0] === null)) {
      let unresolved = 0;
      for (const reference of binding.referencePaths) {
        const member = reference.parentPath;
        if (!member || !(member.isMemberExpression() || member.isOptionalMemberExpression()) || member.node.object !== reference.node) continue;
        if (memberSelector(member.node) === null && ++unresolved > UNRESOLVED_SITES) {
          out.escapes.push(member);
          return;
        }
      }
    }
    for (const literal of literalSourcesOf(binding, analysis)) {
      for (const self of thisWithin(literal, analysis)) followExpression(self, steps, walk);
    }
    // `var w = m; w.set(k, v)`: the object `m` holds is the one stored
    // into, and `m.get(k)` reads it back - through `m`, and whatever `m`
    // was given by in turn. A parameter's object is the callers'.
    for (const item of sourceHolders(binding, steps, walk)) out.next.push(item);
    if (binding.kind === 'param') for (const item of parameterHolders(binding, binding.path, steps, walk)) out.next.push(item);
    const cls = classOfBinding(binding, analysis);
    if (cls) for (const self of thisInClass(cls, true, analysis)) followExpression(self, steps, walk);
  }
  for (const reference of binding.referencePaths) followExpression(reference, steps, walk);
}

/**
 * What the references of a property of the global object do with the value
 * they hold under `steps`, kept per name and steps; see `followFree`.
 */
function freeReached(name: string, steps: readonly Step[], past: Past | undefined, analysis: ProgramAnalysis, assumes = false): Reached {
  let byKey = analysis.flowFree.get(name);
  if (!byKey) {
    byKey = new Map();
    analysis.flowFree.set(name, byKey);
  }
  const key = stepsKey(steps, false, past, assumes);
  const kept = byKey.get(key);
  if (kept) return kept;
  const reached = emptyReached();
  byKey.set(key, reached);
  const walk: FlowWalk = { analysis, out: reached, seen: new Set(), past, assumes };
  if (steps.length > FLOW_DEPTH) reached.escapes.push(analysis.program);
  else followFree(name, steps, walk);
  return reached;
}

/**
 * A property of the global object under `name` - a program-scope `var` or
 * function of a script, or a value this file stores there, `globalThis.h =
 * f` - is read wherever the name is spelled free (`h(...)`), through any
 * spelling of the object (`window.h`, `g.h` with `g` an alias, `const { h }
 * = globalThis`; `globalMemberReads` and `globalPatternReads`, complete once
 * `resolveGlobalAliases` has run), and by `g[k](...)` with `k` undecoded,
 * which may call any of them. A read `g[k]` that goes elsewhere is the
 * contract `selectGlobal` documents. A value stored there is published to
 * every script on the page, and `holderItems` files the store as an
 * escape; a program-scope declaration is the file's own, with the reads in
 * sight taken to be all of them.
 */
function followFree(name: string, steps: readonly Step[], walk: FlowWalk): void {
  const { analysis } = walk;
  for (const reference of analysis.freeReferences.get(name) ?? []) followExpression(reference, steps, walk);
  for (const read of analysis.globalMemberReads.get(name) ?? []) followExpression(read, steps, walk);
  for (const { at, into } of analysis.globalPatternReads.get(name) ?? []) destructure(into, at, steps, walk);
  if (steps.length === 0) for (const call of analysis.globalUnresolvedCalls) followExpression(call, steps, walk);
}

/**
 * The holders a binding's own sources name - `var w = m`, `w = o.k`, `var
 * self = this` - each holding the same object under the same steps; a
 * literal or collection built in place is the binding's own.
 */
function sourceHolders(binding: Binding, steps: readonly Step[], walk: FlowWalk): FlowItem[] {
  const items: FlowItem[] = [];
  if (!binding.path.isVariableDeclarator() && binding.constantViolations.length === 0) return items;
  for (const source of sourcesOf(binding, walk.analysis)) {
    if (source.elements) continue;
    if (t.isIdentifier(source.node) || t.isThisExpression(source.node) || t.isMemberExpression(source.node) || t.isOptionalMemberExpression(source.node)) {
      for (const item of holderItems(source.node, source.at, steps, walk)) items.push(item);
    }
  }
  return items;
}

/**
 * The object literals a binding holds: its initialiser and every `=` to
 * it, opened one level; `this` inside their methods is the binding's value.
 */
function literalSourcesOf(binding: Binding, analysis: ProgramAnalysis): NodePath<t.ObjectExpression>[] {
  const literals: NodePath<t.ObjectExpression>[] = [];
  if (!binding.path.isVariableDeclarator() && binding.constantViolations.length === 0) return literals;
  for (const source of sourcesOf(binding, analysis)) {
    if (source.elements || !t.isObjectExpression(source.node)) continue;
    const literal = literalPathOf(source.node, source.at, analysis);
    if (literal) literals.push(literal);
  }
  return literals;
}

/** Every `this` inside the methods of a literal that is the literal - `this.k`, `var self = this`, `const { k } = this`; walked once per literal. */
function thisWithin(literal: NodePath<t.ObjectExpression>, analysis: ProgramAnalysis): NodePath<t.ThisExpression>[] {
  let paths = analysis.thisMembers.get(literal.node);
  if (!paths) {
    const found: NodePath<t.ThisExpression>[] = [];
    literal.traverse({
      ThisExpression(path) {
        const owner = thisOwner(path, analysis);
        if (owner.kind !== 'value') return;
        const { node } = owner.value;
        const declarator = literal.parentPath;
        if (node !== literal.node && !(t.isIdentifier(node) && declarator?.isVariableDeclarator() && declarator.node.id === node)) return;
        found.push(path);
      },
    });
    paths = found;
    analysis.thisMembers.set(literal.node, paths);
  }
  return paths;
}

/** Every `super` inside a class body's static members, where it spells the parent class itself. */
function superInStatic(cls: NodePath<t.Class>, analysis: ProgramAnalysis): NodePath[] {
  const found: NodePath[] = [];
  cls.get('body').traverse({
    Class(inner) {
      inner.skip();
    },
    Super(path) {
      if (thisIsClass(path, analysis)) found.push(path);
    },
  });
  return found;
}

/** Every `this` inside a class body on one side of it: the class's in a static member or block, an instance's otherwise; walked once per class. */
function thisInClass(cls: NodePath<t.Class>, isStatic: boolean, analysis: ProgramAnalysis): NodePath<t.ThisExpression>[] {
  let sides = analysis.classThisMembers.get(cls.node);
  if (!sides) {
    const found: [NodePath<t.ThisExpression>[], NodePath<t.ThisExpression>[]] = [[], []];
    cls.get('body').traverse({
      Class(inner) {
        inner.skip();
      },
      ThisExpression(path) {
        // A `this` inside a plain function nested in a member is that function's.
        let fn: NodePath | null = path.getFunctionParent();
        while (fn && fn.isArrowFunctionExpression()) fn = fn.getFunctionParent();
        if (fn && !(fn.isClassMethod() || fn.isClassPrivateMethod() || fn.isClassProperty() || fn.isClassPrivateProperty())) return;
        found[thisIsClass(path, analysis) ? 1 : 0].push(path);
      },
    });
    sides = found;
    analysis.classThisMembers.set(cls.node, sides);
  }
  return sides[isStatic ? 1 : 0];
}

/** The class a binding names: a declaration, its own name inside a class expression, or a variable initialised with one and never written again. */
function classOfBinding(binding: Binding, analysis: ProgramAnalysis): NodePath<t.Class> | undefined {
  const declaration = binding.path;
  if (declaration.isClassDeclaration() || declaration.isClassExpression()) return declaration;
  if (declaration.isVariableDeclarator() && t.isClassExpression(declaration.node.init) && writesTo(binding).length === 0) {
    return analysis.classPaths.get(declaration.node.init);
  }
  return undefined;
}

/**
 * The function a binding names as an ES5 constructor: a declaration, its
 * own name inside a function expression, or a variable initialised with
 * one, never written again.
 */
function functionOfBinding(binding: Binding, analysis: ProgramAnalysis): NodePath<t.Function> | undefined {
  if (writesTo(binding).length > 0) return undefined;
  const declaration = binding.path;
  if (declaration.isFunctionDeclaration() || declaration.isFunctionExpression()) return declaration;
  if (declaration.isVariableDeclarator() && t.isFunctionExpression(declaration.node.init)) return functionPathOf(declaration.node.init, declaration, analysis);
  return undefined;
}

/**
 * Where every instance of a constructor is read under `steps`: `new C(...)`
 * sites, each an expression holding the value; `this.k` inside the
 * constructor's body, its class's instance members, and every function on
 * its `prototype`; `C.prototype.k` outright; and the instances of every
 * class or ES5 constructor that extends it - `class D extends C`,
 * `D.prototype = Object.create(C.prototype)`, `C.call(this)` inside `D`.
 * The prototype itself handed anywhere else, or the constructor let go
 * of, holds readers out of sight.
 */
function instanceReached(constructor: Binding, steps: readonly Step[], walk: FlowWalk): void {
  const { analysis, out } = walk;
  const cls = classOfBinding(constructor, analysis);
  const fn = cls ? undefined : functionOfBinding(constructor, analysis);
  if (cls) {
    for (const self of thisInClass(cls, false, analysis)) followExpression(self, steps, walk);
    for (const body of prototypeFunctionsOf(constructor, analysis)) {
      for (const self of thisPathsIn(body, analysis)) followExpression(self, steps, walk);
    }
  } else if (fn) {
    for (const body of [fn, ...prototypeFunctionsOf(constructor, analysis)]) {
      for (const self of thisPathsIn(body, analysis)) followExpression(self, steps, walk);
    }
  } else {
    // `var D = C`: the instances of the alias are the constructor's.
    const aliased = throughAliases(constructor);
    if (!aliased || aliased === constructor) return void out.escapes.push(constructor.path);
    out.next.push({ target: aliased, steps, instances: true, past: walk.past });
  }
  for (const reference of constructor.referencePaths) {
    const parent = reference.parentPath;
    if (!parent) continue;
    if (parent.isNewExpression() && parent.node.callee === reference.node) {
      followExpression(parent, steps, walk);
      continue;
    }
    // `Reflect.construct(C, args)` is `new C(...args)`; see `builtinResult`.
    if (parent.isCallExpression() && parent.node.arguments[0] === reference.node && reflectConstruct(parent)) {
      followExpression(parent, steps, walk);
      continue;
    }
    if (parent.isClass() && parent.node.superClass === reference.node) {
      const derived = classBinding(parent);
      if (derived) out.next.push({ target: derived, steps, instances: true, past: walk.past });
      else out.escapes.push(parent);
      continue;
    }
    if (parent.isMemberExpression() && parent.node.object === reference.node) {
      const key = memberKey(parent.node);
      const use = parent.parentPath;
      if (key === 'prototype') {
        // `C.prototype.k` reads or stores; `D.prototype = Object.create(C.prototype)` is the ES5 subclass.
        if ((use.isMemberExpression() || use.isOptionalMemberExpression()) && use.node.object === parent.node) {
          followExpression(parent, steps, walk);
          continue;
        }
        const derived = prototypeCreatedFrom(parent);
        if (derived) out.next.push({ target: derived, steps, instances: true, past: walk.past });
        else if (!(use.isAssignmentExpression() && use.node.left === parent.node)) out.escapes.push(parent);
        continue;
      }
      if ((key === 'call' || key === 'apply') && use.isCallExpression() && use.node.callee === parent.node) {
        const [receiver] = use.node.arguments;
        if (receiver && t.isExpression(receiver)) for (const item of holderItems(receiver, use, steps, walk)) out.next.push(item);
        continue;
      }
      // A static read is the constructor's own property, not an instance's.
      continue;
    }
    const position = referencePosition(reference);
    if (position.aliasTo) out.next.push({ target: position.aliasTo, steps, instances: true, past: walk.past });
    else if (position.escapes) out.escapes.push(reference);
  }
}

/**
 * The functions stored on `C.prototype`: `C.prototype.m = function () {...}`,
 * the methods of `C.prototype = {...}`, what `defineProperty`, `defineProperties`
 * and `assign` put there, and the same through an alias of the prototype
 * (`var p = C.prototype; p.m = ...`). A value spelled by a name or read off a
 * holder - `Object.assign(C.prototype, { m })`, `C.prototype.m = P[k]` - is
 * the functions it can be. `C[k]` with `k` undecoded may be `C.prototype`,
 * which is how obfuscator.io spells it, and is read as it.
 */
function prototypeFunctionsOf(constructor: Binding, analysis: ProgramAnalysis): NodePath<t.Function>[] {
  const functions: NodePath<t.Function>[] = [];
  const add = (value: t.Node | undefined, at: NodePath): void => {
    if (!value) return;
    if (t.isFunction(value)) {
      const fn = functionPathOf(value, at, analysis);
      if (fn) functions.push(fn);
    } else if (t.isExpression(value)) collectCallees(value, at, analysis, functions, 0);
  };
  const methodsOf = (literal: t.Node | undefined, at: NodePath): void => {
    if (!t.isObjectExpression(literal)) return;
    for (const property of literal.properties) {
      if (t.isObjectMethod(property)) add(property, at);
      else if (t.isObjectProperty(property)) add(property.value, at);
    }
  };
  const stored = (prototype: NodePath): void => {
    const use = prototype.parentPath;
    if (!use) return;
    if (use.isMemberExpression() && use.node.object === prototype.node) {
      const store = use.parentPath;
      if (store.isAssignmentExpression({ operator: '=' }) && store.node.left === use.node) add(store.node.right, store.get('right'));
    } else if (use.isAssignmentExpression({ operator: '=' }) && use.node.left === prototype.node) {
      methodsOf(use.node.right, use.get('right'));
    } else if (use.isVariableDeclarator() && use.node.init === prototype.node && t.isIdentifier(use.node.id)) {
      const alias = use.scope.getBinding(use.node.id.name);
      if (alias) for (const store of memberStoresOf(alias, analysis)) {
        if (store.spread) methodsOf(store.node, store.at);
        else if (!store.element) add(store.node, store.at);
      }
    } else if (use.isCallExpression() && use.node.arguments[0] === prototype.node) {
      // `Object.defineProperty(C.prototype, 'k', { get() {...} })`, `defineProperties(C.prototype, {...})`, `assign(C.prototype, {...})`.
      const { callee } = use.node;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object) || use.scope.getBinding(callee.object.name)) return;
      const method = memberKey(callee);
      const [, second, third] = use.node.arguments;
      if (method === 'defineProperty' && (callee.object.name === 'Object' || callee.object.name === 'Reflect')) {
        methodsOf(third, use);
      } else if (callee.object.name === 'Object' && method === 'defineProperties' && t.isObjectExpression(second)) {
        for (const property of second.properties) if (t.isObjectProperty(property)) methodsOf(property.value, use);
      } else if (callee.object.name === 'Object' && method === 'assign') {
        for (const argument of use.node.arguments.slice(1)) {
          if (t.isObjectExpression(argument)) methodsOf(argument, use);
          else if (t.isExpression(argument)) for (const literal of objectLiteralsOf(argument, use, analysis)) methodsOf(literal.node, literal);
        }
      }
    }
  };
  for (const reference of constructor.referencePaths) {
    const prototype = reference.parentPath;
    if (!prototype?.isMemberExpression() || prototype.node.object !== reference.node) continue;
    const key = memberSelector(prototype.node);
    if (key === 'prototype' || key === null) stored(prototype);
  }
  return functions;
}

/** Every `this` in a function's own body; a nested plain function's is its own. Walked once per function. */
function thisPathsIn(fn: NodePath<t.Function>, analysis: ProgramAnalysis): NodePath<t.ThisExpression>[] {
  let paths = analysis.functionThis.get(fn.node);
  if (!paths) {
    const found: NodePath<t.ThisExpression>[] = [];
    fn.get('body').traverse({
      Function(inner) {
        if (!inner.isArrowFunctionExpression()) inner.skip();
      },
      Class(inner) {
        inner.skip();
      },
      ThisExpression(path) {
        found.push(path);
      },
    });
    paths = found;
    analysis.functionThis.set(fn.node, paths);
  }
  return paths;
}

/** The constructor `D` of `D.prototype = Object.create(<prototype>)`, given the argument's path. */
function prototypeCreatedFrom(prototype: NodePath): Binding | undefined {
  const create = prototype.parentPath;
  if (!create?.isCallExpression() || create.node.arguments[0] !== prototype.node) return undefined;
  const { callee } = create.node;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: 'Object' }) || memberKey(callee) !== 'create') return undefined;
  if (create.scope.getBinding('Object')) return undefined;
  const store = create.parentPath;
  if (!store?.isAssignmentExpression({ operator: '=' }) || store.node.right !== create.node) return undefined;
  const { left } = store.node;
  if (!t.isMemberExpression(left) || memberKey(left) !== 'prototype' || !t.isIdentifier(left.object)) return undefined;
  return store.scope.getBinding(left.object.name);
}

/**
 * The items that hold the value once it is stored into `object` under
 * `steps`: a local, through its binding; `this`, through what `this` is
 * there - the instances of a class or of an ES5 constructor under `new`,
 * the class itself, the literal whose method this is; `C.prototype`,
 * through the instances of `C`; `a.b`, through `a` one step deeper. A
 * literal written in place is covered by whatever holds the literal. A
 * parameter's object is the callers', the global object is read by any
 * spelling, and anything else is out of sight: the value is lost there.
 */
function holderItems(object: t.Expression | t.Super, at: NodePath, steps: readonly Step[], walk: FlowWalk): FlowItem[] {
  const { analysis, out } = walk;
  const items: FlowItem[] = [];
  /**
   * `globalThis.k = v`, `this.k = v` at the top of a script, `g.k = v` with
   * `g` an alias: published to every script on the page, and read in this
   * one wherever `k` is spelled free or read off the object.
   */
  const global = (): void => {
    const [key] = steps;
    if (typeof key === 'string') items.push({ target: key, steps: steps.slice(1), past: walk.past });
    out.escapes.push(at);
  };
  for (const leaf of valueLeaves(object)) {
    if (t.isIdentifier(leaf)) {
      const binding = at.scope.getBinding(leaf.name);
      if (!binding) {
        if (GLOBAL_OBJECT_NAMES.has(leaf.name)) global();
        else out.escapes.push(at);
      } else if (analysis.globalAliasIdentifiers.has(binding.identifier) || analysis.maybeGlobalAliasIdentifiers.has(binding.identifier)) global();
      else items.push({ target: binding, steps, past: walk.past });
    } else if (t.isThisExpression(leaf)) {
      const owner = thisOwner(at, analysis);
      if (owner.kind === 'global') global();
      else if (owner.kind === 'class') {
        const binding = classBinding(owner.cls);
        if (binding) items.push({ target: binding, steps, instances: !owner.isStatic, past: walk.past });
        else if (!owner.isStatic && instancesInPlace(owner.cls).length > 0) for (const instance of instancesInPlace(owner.cls)) followExpression(instance, steps, walk);
        else out.escapes.push(at);
      } else if (owner.kind === 'value') {
        const literal = owner.value.node;
        const binding = t.isIdentifier(literal) ? owner.value.at.scope.getBinding(literal.name) : undefined;
        if (binding) items.push({ target: binding, steps, past: walk.past });
        else out.escapes.push(at);
      } else if (owner.kind === 'maybeGlobal') {
        // `function C() { this.k = v }`: an instance of `C` under `new`,
        // the global object under a plain call. With no constructor to file
        // it under and no plain call in sight, a walk that assumes takes
        // `this` for a method's receiver, lost - obfuscated5.js stores its
        // VM's register file on `this.h` from a method under two undecoded
        // keys, and every other `this.h` in the file was the global `h`
        // otherwise; every other walk publishes it.
        const constructor = constructorOf(at, analysis);
        if (constructor) items.push({ target: constructor, steps, instances: true, past: walk.past });
        if (!constructor && walk.assumes && !plainlyCalled(at, analysis, new Map())) out.escapes.push(at);
        else if (!constructor || plainlyCalled(at, analysis, new Map())) global();
      } else out.escapes.push(at);
    } else if (t.isMemberExpression(leaf) || t.isOptionalMemberExpression(leaf)) {
      if (t.isSuper(leaf.object)) {
        out.escapes.push(at);
        continue;
      }
      if (memberKey(leaf) === 'prototype' && t.isIdentifier(leaf.object)) {
        const constructor = at.scope.getBinding(leaf.object.name);
        if (constructor) items.push({ target: constructor, steps, instances: true, past: walk.past });
        else out.escapes.push(at);
        continue;
      }
      // `o.__proto__ = v`: `o` inherits every property of the value.
      const under: Step = memberKey(leaf) === '__proto__' ? PROTO : memberSelector(leaf);
      for (const item of holderItems(leaf.object, at, [under, ...steps], walk)) items.push(item);
    } else if (t.isCallExpression(leaf) && (t.isMemberExpression(leaf.callee) || t.isOptionalMemberExpression(leaf.callee)) && !t.isSuper(leaf.callee.object) && CHAINED_MUTATORS.has(memberKey(leaf.callee) ?? '')) {
      // `m.set(a, 1).set(k, v)`: the second store is into what the first hands back, which is `m`.
      for (const item of holderItems(leaf.callee.object, at, steps, walk)) items.push(item);
    } else if (t.isObjectExpression(leaf) || t.isArrayExpression(leaf) || t.isNewExpression(leaf) || t.isCallExpression(leaf)) {
      // A literal or collection built in place: what holds it holds the value, and is followed from the result.
    } else out.escapes.push(at);
  }
  return items;
}

/**
 * `function (p) { p.k = v }`: the object stored into is the callers' - the
 * argument at the parameter's index of every call in sight, or the element
 * of a holder whose method runs the function with them. Callers out of
 * sight hold it where the walk cannot follow.
 */
function parameterHolders(param: Binding, at: NodePath, steps: readonly Step[], walk: FlowWalk): FlowItem[] {
  const { analysis, out } = walk;
  const items: FlowItem[] = [];
  const owner = writesTo(param).length === 0 ? paramOwner(param) : undefined;
  if (!owner || !t.isIdentifier(owner.fn.node.params[owner.index])) {
    out.escapes.push(at);
    return items;
  }
  const { holders, complete } = holdersOf(owner.fn, analysis);
  if (!complete) out.escapes.push(at);
  for (const { position } of holders.flat()) {
    let object: t.Node | null | undefined;
    if (position.kind === 'call') object = argumentAt(position.call.node, owner.index + position.offset);
    else if (position.kind === 'arguments') object = position.open ? null : argumentIn(position.arguments, owner.index);
    else if (position.elementParams.includes(owner.index)) {
      if (position.method === 'then' || position.method === 'catch' || position.method === 'finally') out.escapes.push(position.call);
      else for (const item of holderItems(position.receiver, position.call, [null, ...steps], walk)) items.push(item);
      continue;
    } else continue;
    if (object === undefined) continue;
    if (object === null || !t.isExpression(object)) out.escapes.push(position.call);
    else for (const item of holderItems(object, position.call, steps, walk)) items.push(item);
  }
  return items;
}

/** Methods of a `Map` or `Set` that hand their receiver back, so that stores chain. */
const CHAINED_MUTATORS: ReadonlySet<string> = new Set(['set', 'add']);

/** The binding of the plain function `at` sits in, when it names a fixed function this file declares. */
function constructorOf(at: NodePath, analysis: ProgramAnalysis): Binding | undefined {
  let fn: NodePath<t.Function> | null = at.getFunctionParent();
  while (fn && fn.isArrowFunctionExpression()) fn = fn.getFunctionParent();
  if (!fn) return undefined;
  let binding: Binding | undefined;
  if (fn.isFunctionDeclaration()) {
    const id = fn.node.id;
    binding = id ? (fn.scope.parent?.getBinding(id.name) ?? fn.scope.getBinding(id.name)) : undefined;
  } else if (fn.isFunctionExpression()) {
    binding = literalBinding(fn) ?? (fn.node.id ? fn.scope.getBinding(fn.node.id.name) : undefined);
  }
  // `C.prototype.m = function () { this.k = v }`, a method of `C.prototype = { ... }` or of what `Object.assign(C.prototype, { ... })` copies: `this` is an instance of `C`.
  if (!binding && (fn.isFunctionExpression() || fn.isObjectMethod())) binding = prototypeOwnerOf(fn);
  return binding && functionOfBinding(binding, analysis) ? binding : undefined;
}

/** The constructor whose `prototype` a function is stored on; see `constructorOf`. */
function prototypeOwnerOf(fn: NodePath<t.Function>): Binding | undefined {
  let holder: NodePath | null = fn.parentPath;
  if (holder?.isObjectProperty() && holder.node.value === fn.node) holder = holder.parentPath;
  else if (fn.isObjectMethod()) holder = fn.parentPath;
  if (!holder) return undefined;
  let prototype: t.Node | undefined;
  if (holder.isObjectExpression()) {
    const use = holder.parentPath;
    if (use.isAssignmentExpression({ operator: '=' }) && use.node.right === holder.node) prototype = use.node.left;
    else if (use.isCallExpression() && use.node.arguments.includes(holder.node) && use.node.arguments[0] !== holder.node) {
      const { callee } = use.node;
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'Object' }) && memberKey(callee) === 'assign' && !use.scope.getBinding('Object')) prototype = use.node.arguments[0];
    }
  } else if (holder.isAssignmentExpression({ operator: '=' }) && holder.node.right === fn.node && t.isMemberExpression(holder.node.left)) {
    prototype = holder.node.left.object;
  }
  if (!t.isMemberExpression(prototype) || memberKey(prototype) !== 'prototype' || !t.isIdentifier(prototype.object)) return undefined;
  return fn.scope.getBinding(prototype.object.name);
}

/** The functions a call runs, with the offset its arguments start at in their parameters; or why it did not resolve. */
function calleeFunctions(call: NodePath<CallLike>, analysis: ProgramAnalysis): { functions: NodePath<t.Function>[]; offset: number } | 'foreign' | 'unresolved' {
  let known: { functions: NodePath<t.Function>[]; offset: number } | 'foreign' | 'unresolved' = 'unresolved';
  const cls = call.isNewExpression() ? constructedClass(call.node, call, analysis) : undefined;
  if (cls) {
    // `new C(...)` runs the constructor; a class without one drops the
    // arguments, and one whose parent is out of sight hands them there.
    const constructor = classConstructor(cls.node);
    if (!constructor) return { functions: [], offset: 0 };
    const path = constructor === 'unresolved' ? undefined : functionPathOf(constructor, cls, analysis);
    if (path) known = { functions: [path], offset: 0 };
  } else {
    const resolved = resolveCallee(call, analysis);
    known = resolved.kind === 'known' ? { functions: resolved.functions, offset: resolved.offset } : resolved.kind;
  }
  // What the walks of this file's functions found called here - through a
  // callee nothing resolves, one rooted in a builtin's result, `new Map([['r',
  // f]]).get('r')(...)`, or a name declared twice, where the resolver reads
  // one declarator and the walk of the other reaches the call; see
  // `calleeTargets`.
  const found = analysis.calleeTargets.get(call.node);
  if (!found) return known;
  const functions = typeof known === 'string' ? [] : [...known.functions];
  let offset = typeof known === 'string' ? 0 : known.offset;
  for (const { fn, position } of found) {
    if (position.kind !== 'call' || functions.includes(fn)) continue;
    functions.push(fn);
    offset = position.offset;
  }
  return functions.length > 0 ? { functions, offset } : known;
}

/**
 * How many steps deep a holder of the value may sit before the walk gives
 * it up as lost. `list.push(list)`, `var a = [...a]`, a `Map` stored in
 * itself: each round through such a cycle wraps the value once more, and
 * the steps are what tell the items apart. Nothing in real code holds a
 * function six holders deep; what reaches the bound is the cycle, and
 * the value is disclosed as lost rather than followed.
 */
const FLOW_DEPTH = 6;

/** How many items one walk goes through before the value is lost; see `Flow.drain`. */
const FLOW_ITEMS = 4096;

/** How many step lists two or more deep one binding is asked under, over every walk; see `Flow.drain`. */
const FLOW_FANOUT = 32;

/**
 * Follows an expression that is the value (no steps) or holds it, once per
 * walk: where it goes from its position. See `Flow` for the whole; this is
 * the position table, and a position not on it is where the value is lost.
 */
function followExpression(start: NodePath, steps: readonly Step[], walk: FlowWalk): void {
  const { out } = walk;
  if (steps.length > FLOW_DEPTH) {
    out.escapes.push(start);
    out.bounded = true;
    return;
  }
  const key = `${start.node.start ?? ''}-${start.node.end ?? ''}:${start.node.type}|${stepsKey(steps, false, walk.past)}`;
  if (walk.seen.has(key)) return;
  walk.seen.add(key);
  // Inside a call result, the value stays one only through the wrappers
  // below and into a binding; anywhere else it is a value like any other.
  const on = walk.past === 1 ? withPast(walk, 0) : walk;
  const taken = (rest: readonly Step[]): FlowWalk | undefined => opened(path, rest, walk);
  let path = start;
  for (;;) {
    const parent = path.parentPath;
    if (!parent) return void out.escapes.push(path);
    const node = path.node;
    const outer = parent.node;

    if (t.isCallExpression(outer) || t.isOptionalCallExpression(outer) || t.isNewExpression(outer)) {
      if (outer.callee === node) {
        if (steps.length === 0) out.calls.push({ path, position: { kind: 'call', call: parent as NodePath<CallLike>, offset: 0 } });
        return;
      }
      const index = outer.arguments.indexOf(node as t.Expression);
      if (index >= 0) argumentPosition(parent as NodePath<CallLike>, index, steps, false, on);
      return;
    }
    if (t.isSpreadElement(outer)) {
      const through = taken(steps.slice(1));
      if (through) spreadPosition(parent as NodePath<t.SpreadElement>, steps, through);
      return;
    }
    if (t.isMemberExpression(outer) || t.isOptionalMemberExpression(outer)) {
      if (outer.object === node) memberPosition(parent as NodePath<t.MemberExpression | t.OptionalMemberExpression>, steps, walk);
      return;
    }
    if (t.isTaggedTemplateExpression(outer)) return;
    if (t.isTemplateLiteral(outer)) {
      if (steps.length === 0 || isElementStep(steps[0])) coercedPosition(parent, steps, walk);
      return;
    }
    if (t.isBinaryExpression(outer)) {
      if (outer.operator === 'in') {
        if (outer.right === node && steps.length === 0) out.reads.push({ at: parent, selector: argumentSelector(outer.left), key: outer.left, probe: true });
        return;
      }
      if (outer.operator === '===' || outer.operator === '!==' || outer.operator === 'instanceof') return;
      if (steps.length === 0 || isElementStep(steps[0])) coercedPosition(parent, steps, walk);
      return;
    }
    if (t.isUnaryExpression(outer)) {
      if ((outer.operator === '+' || outer.operator === '-' || outer.operator === '~') && steps.length === 0) coercedPosition(parent, steps, walk);
      return;
    }
    if (t.isUpdateExpression(outer)) return;
    if (
      t.isIfStatement(outer) ||
      t.isWhileStatement(outer) ||
      t.isDoWhileStatement(outer) ||
      t.isForStatement(outer) ||
      t.isSwitchStatement(outer) ||
      t.isSwitchCase(outer) ||
      t.isExpressionStatement(outer)
    ) {
      return;
    }
    if (t.isForOfStatement(outer)) {
      if (outer.right !== node) return;
      const through = taken(steps.slice(1));
      if (through) iteratedPosition(parent as NodePath<t.ForOfStatement>, steps, through);
      return;
    }
    if (t.isForInStatement(outer)) {
      if (outer.right === node && steps.length === 0) out.enumerated = true;
      return;
    }
    if (t.isConditionalExpression(outer)) {
      if (outer.test === node) return;
      path = parent;
      continue;
    }
    if (t.isLogicalExpression(outer) || t.isParenthesizedExpression(outer)) {
      path = parent;
      continue;
    }
    if (t.isAwaitExpression(outer)) {
      // What the promise settles to; a rejection throws here; a value that is no promise awaits as itself.
      if (steps[0] === REJECT) return thrownPosition(parent, steps.slice(1), on);
      if (steps[0] === SETTLE) steps = steps.slice(1);
      path = parent;
      continue;
    }
    if (t.isSequenceExpression(outer)) {
      if (outer.expressions[outer.expressions.length - 1] !== node) return;
      path = parent;
      continue;
    }
    if (t.isTSAsExpression(outer) || t.isTSSatisfiesExpression(outer) || t.isTSNonNullExpression(outer) || t.isTSTypeAssertion(outer)) {
      path = parent;
      continue;
    }
    if (t.isVariableDeclarator(outer)) {
      if (outer.init === node) destructure(outer.id, parent, steps, walk);
      return;
    }
    if (t.isAssignmentPattern(outer)) {
      if (outer.right !== node) return;
      // A parameter property's default is the parameter's and the instance's; see `destructure`.
      const property = parent.parentPath;
      if (property?.isTSParameterProperty()) destructure(property.node, property, steps, walk);
      else destructure(outer.left, parent, steps, walk);
      return;
    }
    if (t.isAssignmentExpression(outer)) {
      if (outer.right !== node) return;
      const { left } = outer;
      if (t.isIdentifier(left)) {
        if (!NAMING_ASSIGNMENTS.has(outer.operator)) {
          if (outer.operator === '+=') coercedPosition(parent, steps, walk);
          return;
        }
        const target = parent.scope.getBinding(left.name);
        if (target) out.next.push({ target, steps, past: walk.past });
        else {
          // `h = v` with `h` bound nowhere: a property of the global object, published; see `holderItems`.
          out.next.push({ target: left.name, steps, past: walk.past });
          out.escapes.push(parent);
        }
        return;
      }
      if (outer.operator !== '=') return;
      destructure(left, parent, steps, walk);
      return;
    }
    if (t.isObjectProperty(outer)) {
      if (outer.value !== node) return;
      const literal = parent.parentPath;
      if (!literal?.isObjectExpression()) return void out.escapes.push(parent);
      // `{ __proto__: v }`: the literal inherits every property of `v`.
      const under: Step = staticKeyOf(outer) === '__proto__' && !outer.computed && !outer.shorthand ? PROTO : propertySelector(outer);
      holderExpression(literal, [under, ...steps], on);
      return;
    }
    if (t.isClassProperty(outer) || t.isClassPrivateProperty(outer)) {
      if (outer.value !== node) return;
      const cls = parent.parentPath?.parentPath;
      const binding = cls?.isClass() ? classBinding(cls) : undefined;
      if (!binding) return void out.escapes.push(parent);
      const under = t.isClassPrivateProperty(outer) ? `#${outer.key.id.name}` : propertySelector(outer);
      out.next.push({ target: binding, steps: [under, ...steps], instances: !outer.static, past: on.past });
      return;
    }
    if (t.isArrayExpression(outer)) {
      const index = outer.elements.indexOf(node as t.Expression);
      const shifted = outer.elements.slice(0, index).some((element) => t.isSpreadElement(element));
      holderExpression(parent, [shifted ? null : index, ...steps], on);
      return;
    }
    if (t.isReturnStatement(outer)) return returnedPosition(parent.getFunctionParent(), steps, on);
    if (t.isArrowFunctionExpression(outer) && outer.body === node) return returnedPosition(parent as NodePath<t.Function>, steps, on);
    if (t.isYieldExpression(outer)) return yieldedPosition(parent as NodePath<t.YieldExpression>, steps, on);
    if (t.isThrowStatement(outer)) return thrownPosition(parent, steps, on);
    if (t.isClass(outer) && outer.superClass === node) {
      const derived = parent as NodePath<t.Class>;
      if (steps.length === 0) extendedPosition(derived, on);
      else {
        // The derived class inherits the static side: `B.f` reads `A.f` through the prototype chain, `super.f` in a static member outright.
        const binding = classBinding(derived);
        if (binding) out.next.push({ target: binding, steps: [PROTO, ...steps], past: on.past });
        else out.escapes.push(derived);
        for (const self of superInStatic(derived, walk.analysis)) followExpression(self, steps, on);
      }
      return;
    }
    return void out.escapes.push(parent);
  }
}

/**
 * The value, or an element of a holder of it, coerced to a string or a
 * number: a template, `+`, `String()`, `toString()`. A caught error's text
 * is read this way, and a function's source - its name with it.
 */
function coercedPosition(at: NodePath, steps: readonly Step[], walk: FlowWalk): void {
  const { out } = walk;
  out.coerced.push(at);
  if (steps.length === 0) out.reads.push({ at, selector: 'toString', key: undefined, past: walk.past });
}

/**
 * The value is a class extended by `derived`: `new derived(...)` runs its
 * constructor with the derived class's own arguments when that class has no
 * constructor, and with the arguments of each `super(...)` call when it has
 * one - each a call position of the value.
 */
function extendedPosition(derived: NodePath<t.Class>, walk: FlowWalk): void {
  const { out } = walk;
  const binding = classBinding(derived);
  if (!binding) return void out.escapes.push(derived);
  const own = derived.node.body.body.find((member): member is t.ClassMethod => t.isClassMethod(member) && member.kind === 'constructor');
  if (!own) return void out.next.push({ target: binding, steps: [], past: walk.past });
  derived.get('body').traverse({
    Class(inner) {
      inner.skip();
    },
    CallExpression(call) {
      if (!t.isSuper(call.node.callee)) return;
      out.calls.push({ path: call, position: { kind: 'call', call, offset: 0 } });
      // `constructor(...a) { super(...a) }` passes its arguments through as no constructor at all would.
      if (passesArgumentsThrough(own, call.node)) out.next.push({ target: binding, steps: [], past: walk.past });
    },
  });
}

/** `new (class { ... })()`: the instances of a class nothing binds are the results of the `new` written around it. */
function instancesInPlace(cls: NodePath<t.Class>): NodePath[] {
  const parent = cls.parentPath;
  return parent?.isNewExpression() && parent.node.callee === cls.node ? [parent] : [];
}

/** Whether a `super(...)` call hands the constructor's own parameters on unchanged, in order. */
function passesArgumentsThrough(constructor: t.ClassMethod, call: t.CallExpression): boolean {
  const { params } = constructor;
  const { arguments: args } = call;
  if (args.length === 1 && t.isSpreadElement(args[0]) && t.isIdentifier(args[0].argument, { name: 'arguments' })) return true;
  if (params.length !== args.length) return false;
  return params.every((param, index) => {
    const argument = args[index]!;
    if (t.isRestElement(param)) return t.isSpreadElement(argument) && t.isIdentifier(param.argument) && t.isIdentifier(argument.argument, { name: param.argument.name });
    return t.isIdentifier(param) && t.isIdentifier(argument, { name: param.name });
  });
}

/**
 * A literal or a call result holding the value under `steps`: followed
 * from its own position, and - a literal - read by `this.k` inside its
 * own methods.
 */
function holderExpression(holder: NodePath, steps: readonly Step[], walk: FlowWalk): void {
  if (holder.isObjectExpression() && typeof steps[0] === 'string') {
    for (const self of thisWithin(holder, walk.analysis)) followExpression(self, steps, walk);
  }
  followExpression(holder, steps, walk);
}

/**
 * The value at argument `index` of a call. A builtin spelled by its free
 * name returns nothing of its own - what it hands back is an argument, a
 * wrapper of one, a copy of one's elements - and `builtinArgument` says
 * which. A method of a value this file holds stores the argument into it
 * (`q.push(v)`, `m.set(k, v)`), or runs it with the elements (`q.map(f)`);
 * see `methodArgument`. A function this file can see whole receives it in
 * a parameter, in `this` when it is the receiver of `.call`/`.apply`, in
 * the executor's `resolve` and `reject` of a `new Promise`. A callee that
 * is another script's is the boundary, and one the walk cannot resolve is
 * where the value is lost - kept on `unresolved` for the global walk to
 * retry.
 */
function argumentPosition(call: NodePath<CallLike>, index: number, steps: readonly Step[], spread: boolean, walk: FlowWalk): void {
  const { analysis, out } = walk;
  const { arguments: args, callee } = call.node;
  for (let i = 0; i < index; i++) if (t.isSpreadElement(args[i])) return void out.escapes.push(call);
  if (builtinArgument(call, index, steps, spread, walk)) return;
  // `resolve(v)` inside `new Promise((resolve, reject) => ...)`: the promise settles to it; `reject(v)` rejects with it.
  const executor = t.isIdentifier(callee) ? promiseExecutorOf(callee, call, analysis) : undefined;
  if (executor) {
    if (index === 0 && !spread) followExpression(executor.promise, [executor.index === 0 ? SETTLE : REJECT, ...steps], walk);
    return;
  }
  const resolved = calleeFunctions(call, analysis);
  // A method of a value this file holds that no function of this file's
  // answers for: `q.push(v)` stores, `q.forEach(v)` runs; `r.add(v)` with
  // `add` on `r`'s prototype is a call of it, and asked first.
  if (typeof resolved === 'string' && (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && !t.isSuper(callee.object)) {
    if (methodArgument(callee.object, memberKey(callee), memberSelector(callee), index, steps, spread, call as NodePath<t.CallExpression | t.OptionalCallExpression>, walk)) return;
  }
  if (resolved === 'foreign') return void out.foreign.push(call);
  if (resolved === 'unresolved') {
    // `f.bind(r, a)(v)`, `Reflect.apply(f, r, [v])`: a function found called here with a list spelled elsewhere; see `calleeTargets`.
    let found = false;
    for (const { fn, position } of analysis.calleeTargets.get(call.node) ?? []) {
      if (position.kind !== 'arguments' || spread) continue;
      const at = position.arguments.indexOf(args[index] as t.Expression);
      if (at < 0) continue;
      found = true;
      intoParameter(fn, at, steps, walk);
    }
    if (!found) out.unresolved.push({ call, index, steps, applied: undefined });
    return;
  }
  if (resolved.functions.length > RESOLVED_CALLEES) return void out.escapes.push(call);
  // `f.apply(r, list)`: the list's elements are the arguments.
  const applied = (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && memberKey(callee) === 'apply';
  for (const fn of resolved.functions) {
    if (index < resolved.offset) receiverOf(fn, steps, walk);
    else if (applied) {
      if (index === 1 && !spread && isElementStep(steps[0])) spreadIntoParameters(fn, 0, steps, walk);
      else if (index === 1) out.escapes.push(call);
    } else if (spread) spreadIntoParameters(fn, index - resolved.offset, steps, walk);
    else intoParameter(fn, index - resolved.offset, steps, walk);
  }
}

/** `new Promise(executor)`: the promise, and which of the executor's two parameters `callee` names. */
function promiseExecutorOf(callee: t.Identifier, at: NodePath, analysis: ProgramAnalysis): { promise: NodePath; index: number } | undefined {
  const binding = at.scope.getBinding(callee.name);
  if (!binding || binding.kind !== 'param' || writesTo(binding).length > 0) return undefined;
  const owner = paramOwner(binding);
  if (!owner || owner.index > 1 || !t.isIdentifier(owner.fn.node.params[owner.index])) return undefined;
  const promise = owner.fn.parentPath;
  if (!promise.isNewExpression() || promise.node.arguments[0] !== owner.fn.node) return undefined;
  const [head] = valueLeaves(promise.node.callee);
  if (!t.isIdentifier(head, { name: 'Promise' }) || promise.scope.getBinding('Promise')) return undefined;
  void analysis;
  return { promise, index: owner.index };
}

/** `f(...list)` with the value among the list's elements: the arguments from `index` on. */
function spreadIntoParameters(fn: NodePath<t.Function>, index: number, steps: readonly Step[], walk: FlowWalk): void {
  const [first, ...rest] = steps;
  if (typeof first === 'number') return intoParameter(fn, index + first, rest, walk);
  if (first !== null) return void walk.out.escapes.push(fn);
  const count = Math.max(fn.node.params.length, index + 1);
  for (let i = index; i < count; i++) intoParameter(fn, i, rest, walk);
}

/**
 * The value handed to parameter `index` of `fn`: the binding it declares,
 * taken apart by its pattern, the elements of its rest - and every
 * `arguments[i]` inside the function, which reads it whether or not the
 * function declares it.
 */
function intoParameter(fn: NodePath<t.Function>, index: number, steps: readonly Step[], walk: FlowWalk): void {
  for (let i = 0; i <= index; i++) {
    const param = fn.node.params[i];
    if (!param) break;
    if (t.isRestElement(param)) {
      destructure(param.argument, fn, [index - i, ...steps], walk);
      break;
    }
    if (i === index) destructure(param, fn, steps, walk);
  }
  if (!fn.isArrowFunctionExpression()) {
    for (const reference of argumentsReferencesIn(fn, walk.analysis)) followExpression(reference, [index, ...steps], walk);
  }
}

/** Every `arguments` spelled in a function's own body; a nested plain function's is its own. Walked once per function. */
function argumentsReferencesIn(fn: NodePath<t.Function>, analysis: ProgramAnalysis): NodePath[] {
  let references = analysis.functionArguments.get(fn.node);
  if (!references) {
    const found: NodePath[] = [];
    fn.get('body').traverse({
      Function(inner) {
        if (!inner.isArrowFunctionExpression()) inner.skip();
      },
      Class(inner) {
        inner.skip();
      },
      Identifier(path) {
        if (path.node.name === 'arguments' && path.isReferencedIdentifier() && !path.scope.getBinding('arguments')) found.push(path);
      },
    });
    references = found;
    analysis.functionArguments.set(fn.node, references);
  }
  return references;
}

/** `this` inside a function called with the value as its receiver. */
function receiverOf(fn: NodePath<t.Function>, steps: readonly Step[], walk: FlowWalk): void {
  if (fn.isArrowFunctionExpression()) return;
  for (const path of thisPathsIn(fn, walk.analysis)) followExpression(path, steps, walk);
}

/**
 * A pattern matched against the value (no steps) or a holder of it: each
 * key the pattern takes off the value is a read of it, and the target
 * holds that property - of the global object, another spelling of it when
 * the key names one, which the reader of `reads` follows through `into`.
 * Off a holder, the property that meets the first step holds the rest; a
 * rest element holds them all; an array pattern takes elements, and off a
 * holder read by key - a `Map` - the `[key, value]` pairs. `[o.k] = ...`
 * stores into a holder.
 */
function destructure(pattern: t.Node, at: NodePath, steps: readonly Step[], walk: FlowWalk): void {
  const { out } = walk;
  if (t.isAssignmentPattern(pattern)) return destructure(pattern.left, at, steps, walk);
  // `constructor(private cb)`: the parameter, and `this.cb = cb` on the instance.
  if (t.isTSParameterProperty(pattern)) {
    destructure(pattern.parameter, at, steps, walk);
    const id = parameterPropertyId(pattern);
    if (id) destructure(t.memberExpression(t.thisExpression(), t.identifier(id.name)), at, steps, walk);
    return;
  }
  if (t.isIdentifier(pattern)) {
    const binding = at.scope.getBinding(pattern.name);
    if (binding) out.next.push({ target: binding, steps, past: walk.past });
    else {
      // A name this file does not bind: a property of the global object, published; see `holderItems`.
      out.next.push({ target: pattern.name, steps, past: walk.past });
      out.escapes.push(at);
    }
    return;
  }
  if (t.isRestElement(pattern)) return destructure(pattern.argument, at, steps, walk);
  if (t.isMemberExpression(pattern) || t.isOptionalMemberExpression(pattern)) {
    const on = walk.past === 1 ? withPast(walk, 0) : walk;
    for (const item of holderItems(pattern, at, steps, on)) out.next.push(item);
    // `o.k = v` with `set k(x)` on `o`: the setter runs with the value.
    if (!t.isSuper(pattern.object)) for (const setter of accessorsOf(pattern.object, at, walk.analysis, 'set', memberSelector(pattern))) intoParameter(setter, 0, steps, on);
    return;
  }
  // A pattern selects out of a call result; see `Past`.
  if ((walk.past === 1 || walk.past === 3) && steps.length > 0) {
    out.reads.push({ at, selector: null, key: undefined, past: walk.past });
    out.cut = true;
    return;
  }
  // A read through an object created from the value reaches it for every key it lacks.
  while (steps[0] === PROTO) steps = steps.slice(1);
  const [first, ...rest] = steps;
  if (t.isObjectPattern(pattern)) {
    if (isWrap(first)) return;
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        if (first === undefined) out.enumerated = true;
        else destructure(property.argument, at, steps, walk);
        continue;
      }
      const key = patternKeyOf(property);
      if (first === undefined) {
        out.reads.push({ at, selector: key, key: property.computed ? property.key : undefined, into: property.value });
      } else if (selectorsMeet(first, key)) {
        destructure(property.value, at, rest, walk);
      }
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    // A `Map` hands out `[key, value]` pairs; an array its elements; an object nothing.
    const each = first === ENTRY ? [1, ...rest.slice(1)] : undefined;
    if (!each && !isElementStep(first)) return;
    pattern.elements.forEach((element, index) => {
      if (!element) return;
      if (t.isRestElement(element)) {
        if (each) return destructure(element.argument, at, [null, ...each], walk);
        if (typeof first === 'number' && first < index) return;
        destructure(element.argument, at, [typeof first === 'number' ? first - index : null, ...rest], walk);
      } else if (each) {
        destructure(element, at, each, walk);
      } else if (isElementStep(first) && selectorsMeet(first, index)) {
        destructure(element, at, rest, walk);
      }
    });
  }
}

/**
 * `for (const x of holder)`: each element, or each `[key, value]` pair of a
 * holder read by key; `for await` settles each first.
 */
function iteratedPosition(loop: NodePath<t.ForOfStatement>, steps: readonly Step[], walk: FlowWalk): void {
  const [first, ...rest] = steps;
  const { left } = loop.node;
  const each = t.isVariableDeclaration(left) ? left.declarations[0]?.id : left;
  if (!each) return;
  let inner: readonly Step[];
  if (first === ENTRY) inner = [1, ...rest.slice(1)];
  else if (isElementStep(first)) inner = rest;
  else return;
  if (loop.node.await && inner[0] === SETTLE) inner = inner.slice(1);
  destructure(each, loop, inner, walk);
}

/**
 * `[...holder]`, `{ ...holder }`, `f(...holder)`: the elements copied into
 * a literal, the own properties into one, the elements handed on as
 * arguments. Spreading the value itself iterates it and keeps nothing.
 */
function spreadPosition(spread: NodePath<t.SpreadElement>, steps: readonly Step[], walk: FlowWalk): void {
  let [first, ...rest] = steps;
  const container = spread.parentPath;
  const outer = container.node;
  // A `Map` spreads to its `[key, value]` pairs.
  if (first === ENTRY && !t.isObjectExpression(outer)) {
    first = null;
    rest = [1, ...rest.slice(1)];
  }
  if (first === undefined || isWrap(first)) return;
  if (t.isArrayExpression(outer)) {
    if (typeof first === 'string') return;
    const index = outer.elements.indexOf(spread.node);
    const preceding = outer.elements.slice(0, index);
    // The elements land after the plain ones before the spread; a spread before them shifts them out of count.
    const shifted = preceding.some((element) => !element || t.isSpreadElement(element));
    holderExpression(container, [shifted || first === null ? null : first + index, ...rest], walk);
    return;
  }
  if (t.isObjectExpression(outer)) return holderExpression(container, steps, walk);
  if (t.isCallExpression(outer) || t.isOptionalCallExpression(outer) || t.isNewExpression(outer)) {
    if (typeof first === 'string') return;
    argumentPosition(container as NodePath<CallLike>, outer.arguments.indexOf(spread.node), steps, true, walk);
  }
}

/**
 * The value, or a holder of it, as the object of a member expression. The
 * value itself: a read of it under the key - a probe, `hasOwnProperty`,
 * as much as `.k`; called as `.valueOf()` it is handed back, as
 * `.call`/`.apply`/`.bind` it is called with the arguments spelled there,
 * as `.toString()` coerced. A holder: the property that meets the first
 * step holds the rest, and its methods hand elements to a callback, back
 * as a result, or on inside a copy (`holderMethod`); a promise's `then`
 * hands what it settles to, a `WeakRef`'s `deref` what it holds. A method
 * held off a holder of elements takes them out of sight.
 */
function memberPosition(member: NodePath<t.MemberExpression | t.OptionalMemberExpression>, steps: readonly Step[], walk: FlowWalk): void {
  const { out } = walk;
  const outer = member.node;
  const key = memberKey(outer);
  const selector = memberSelector(outer);
  let call = member.parentPath;
  let called = (call.isCallExpression() || call.isOptionalCallExpression()) && call.node.callee === outer ? (call as NodePath<t.CallExpression | t.OptionalCallExpression>) : undefined;
  // `m.get.call(m, k)` on a holder is `m.get(k)`, its arguments one on; see `argumentsOf`.
  if (!called && steps.length > 0 && call.isMemberExpression() && call.node.object === outer && memberKey(call.node) === 'call') {
    const through = call.parentPath;
    if (through.isCallExpression() && through.node.callee === call.node) {
      called = through;
      call = through;
    }
  }
  // A read of any key an object created from the value lacks reaches the value.
  while (steps[0] === PROTO) {
    if (key === '__proto__') return followExpression(member, steps.slice(1), walk);
    steps = steps.slice(1);
  }
  const [first, ...rest] = steps;
  if (first === undefined) {
    if (called) {
      if (key !== null && PROPERTY_PROBES.has(key)) {
        out.reads.push({ at: call, selector: argumentSelector(called.node.arguments[0]), key: called.node.arguments[0], probe: true });
        return;
      }
      if (key === 'valueOf') return followExpression(call, [], walk);
      if (key === 'toString' || key === 'toLocaleString') return coercedPosition(call, [], walk);
      if (key === 'call') return void out.calls.push({ path: member, position: { kind: 'call', call: called, offset: 1 } });
      if (key === 'apply') return appliedPosition(called, member, walk);
      if (key === 'bind') return boundPosition(called, member, walk);
    }
    out.reads.push({ at: member, selector, key: outer.computed ? outer.property : undefined, past: walk.past, write: isPlainAssignmentTarget(member) });
    return;
  }
  if (first === BOUND) {
    // `f.bind(r, a).name` is `"bound "` and the value's; called any other way, the value is called with `a` first and the rest out of sight.
    if (!called) out.reads.push({ at: member, selector, key: outer.computed ? outer.property : undefined, past: walk.past });
    else out.escapes.push(call);
    return;
  }
  if (first === SETTLE || first === REJECT) {
    if (!called) return;
    const [onFulfilled, onRejected] = called.node.arguments;
    // `p.then(a, b)`, `p.catch(b)`: the settled value to `a`, the rejection to `b`; `finally` passes the promise on.
    const handler = key === 'then' ? (first === SETTLE ? onFulfilled : onRejected) : key === 'catch' && first === REJECT ? onFulfilled : undefined;
    if (handler && !t.isSpreadElement(handler)) handToCallback(handler, called, 0, rest, walk);
    else if (key === 'then' || key === 'catch' || key === 'finally') followExpression(call, steps, walk);
    return;
  }
  if (first === DEREF) {
    if (called && key === 'deref') followExpression(call, rest, walk);
    return;
  }
  if (first === ENTRY) {
    // A `Map` holds the value under a key: `get` hands it back, the
    // iteration methods the pairs or the values; see `holderMethod`.
    if (called && key !== null) holderMethod(called, key, steps, walk);
    else if (called && selector === null) holderMethod(called, null, steps, walk);
    return;
  }
  if (called) {
    // `h.get(k)`, `h.has(k)` on a holder read by key: the property under `k`; `h.get()` is a method of `h`'s own.
    if ((key === 'get' || key === 'has') && called.node.arguments.length > argumentsOf(called)) {
      if (key === 'get' && selectorsMeet(first, argumentSelector(called.node.arguments[argumentsOf(called)]))) followExpression(call, rest, walk);
      return;
    }
    if (key === null) {
      // `q[k](...)` with `k` undecoded: the element called, and a method
      // of the holder handing elements to the callback (`holderMethod`).
      if (first === null && selector === null && walk.assumes) return void (out.assumed = true);
      if (selectorsMeet(first, selector)) followExpression(member, rest, walk);
      if (selector === null) holderMethod(called, null, steps, walk);
      return;
    }
    if (typeof first === 'string' && first === key) return followExpression(member, rest, walk);
    // Held under a key nothing resolves, the value may be this very property, called.
    if (first === null) followExpression(member, rest, walk);
    holderMethod(called, key, steps, walk);
    return;
  }
  // A member selects out of a call result; see `Past`.
  if (walk.past === 1 || walk.past === 3) {
    if (selectorsMeet(first, selector)) {
      out.reads.push({ at: member, selector: null, key: undefined, past: walk.past });
      out.cut = true;
    }
    return;
  }
  // `q[k] = v; q[j]`: two keys nothing resolves, compounded; see `FlowWalk.assumes`. The store itself reads nothing back.
  if (first === null && selector === null && walk.assumes && !isPlainAssignmentTarget(member)) return void (out.assumed = true);
  if (selectorsMeet(first, selector)) return followExpression(member, rest, walk);
  // `var m = q.map`: a method held, and the elements with it, out of sight.
  if (typeof selector === 'string' && isElementStep(first) && !HOLDER_OWN_PROPERTIES.has(selector)) out.escapes.push(member);
}

/** Where a method call's own arguments start: one on when it is spelled `x.m.call(x, ...)`. */
function argumentsOf(call: NodePath<t.CallExpression | t.OptionalCallExpression>): number {
  const { callee } = call.node;
  return (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && memberKey(callee) === 'call' && t.isMemberExpression(callee.object) ? 1 : 0;
}

/** Properties of an array or collection that hand back no element. */
const HOLDER_OWN_PROPERTIES: ReadonlySet<string> = new Set(['length', 'size']);

/**
 * A method called on a holder of the value: `forEach` and its kin hand
 * each element to the callback (a `Map`'s `forEach` the value); `find`,
 * `pop`, `at` hand one back; `filter`, `slice`, `values`, `flat` hand a
 * copy back holding them all; `entries` the `[key, value]` pairs; `next`
 * on an iterator a record whose `.value` is one; `map` and `flatMap` hand
 * back what the callback returns, which `returnedPosition` files. `push`,
 * `indexOf`, `join` and the rest answer about the holder or store into it
 * and hand nothing back. A method none of the tables names takes the
 * elements out of sight.
 */
function holderMethod(call: NodePath<t.CallExpression | t.OptionalCallExpression>, method: string | null, steps: readonly Step[], walk: FlowWalk, callbackAt = argumentsOf(call)): void {
  const { out } = walk;
  const [first, ...rest] = steps;
  const callback = call.node.arguments[callbackAt];
  if (first === ENTRY) {
    const [key, ...value] = rest;
    switch (method) {
      case 'get':
        if (selectorsMeet(key as Selector, argumentSelector(callback))) followExpression(call, value, walk);
        return;
      case 'forEach': {
        const through = opened(call, value, walk);
        if (!through) return;
        if (callback && !t.isSpreadElement(callback)) handToCallback(callback, call, 0, value, through);
        else if (callback) out.escapes.push(call);
        return;
      }
      case 'values':
        return followExpression(call, [null, ...value], walk);
      case 'entries':
        return followExpression(call, [null, 1, ...value], walk);
      case 'set':
        // `m.set(k, v)` hands `m` back, so that stores chain.
        return followExpression(call, steps, walk);
      case 'keys':
      case 'has':
      case 'delete':
      case 'clear':
        return;
      case null: {
        // `m[k](...)` with `k` undecoded: `get`, handing the value back, or
        // `forEach`, handing it to the callback - obfuscator.io spells both so.
        if (selectorsMeet(key as Selector, argumentSelector(callback))) followExpression(call, value, walk);
        const through = opened(call, value, walk);
        if (through && callback && !t.isSpreadElement(callback) && t.isFunction(callback)) handToCallback(callback, call, 0, value, through);
        return;
      }
      default:
        out.escapes.push(call);
        return;
    }
  }
  const elementParams = method === null ? [0, 1] : ELEMENT_CALLBACKS.get(method);
  if (elementParams) {
    const through = opened(call, rest, walk);
    if (!through) return;
    if (callback && !t.isSpreadElement(callback)) {
      for (const index of elementParams) handToCallback(callback, call, index, rest, through);
    } else if (callback) out.escapes.push(call);
  }
  if (method === null) return;
  if (ELEMENT_RESULTS.has(method)) {
    const through = opened(call, rest, walk);
    if (through) followExpression(call, rest, through);
    return;
  }
  switch (method) {
    case 'entries':
      return followExpression(call, [null, 1, ...rest], walk);
    case 'add':
      return followExpression(call, steps, walk);
    case 'keys':
    case 'map':
    case 'flatMap':
    case 'set':
    case 'fill':
    case 'forEach':
      return;
    case 'next':
      if (first === null) followExpression(call, ['value', ...rest], walk);
      return;
    case 'flat': {
      const flattened = isElementStep(rest[0]) ? rest.slice(1) : rest;
      return followExpression(call, [null, ...flattened], walk);
    }
    case 'sort':
    case 'splice':
      return followExpression(call, [null, ...rest], walk);
    default:
      break;
  }
  if (SUBSET_RESULTS.has(method)) return followExpression(call, [null, ...rest], walk);
  if (elementParams || HOLDER_OWN_METHODS.has(method)) return;
  out.escapes.push(call);
}

/**
 * The value handed to parameter `index` of a callback: a function written
 * in place, one spelled by a name this file binds, a method of a local -
 * or one the walk cannot see, which takes the value out of sight.
 */
function handToCallback(callback: t.Expression | t.ArgumentPlaceholder, call: NodePath, index: number, steps: readonly Step[], walk: FlowWalk): void {
  const { analysis, out } = walk;
  if (!t.isExpression(callback)) return void out.escapes.push(call);
  const functions: NodePath<t.Function>[] = [];
  const found = collectCallees(callback, call, analysis, functions, 0);
  if (found === 'unresolved') {
    // A callback the walk of a function found itself handed here; see `calleeTargets`.
    for (const { fn, position } of analysis.calleeTargets.get(call.node) ?? []) {
      if (position.kind === 'callback' && position.elementParams.includes(index) && !functions.includes(fn)) functions.push(fn);
    }
    if (functions.length === 0) return void out.escapes.push(call);
  }
  if (functions.length > RESOLVED_CALLEES) return void out.escapes.push(call);
  for (const fn of functions) intoParameter(fn, index, steps, walk);
}

/**
 * `f.apply(r, list)`: a call of `f` with the list's elements, when the list
 * is written out in this file; with `arguments`, a call with whatever the
 * enclosing function's callers pass, which its own holders answer; with
 * anything else, an array nobody here can open.
 */
function appliedPosition(call: NodePath<t.CallExpression | t.OptionalCallExpression>, member: NodePath, walk: FlowWalk): void {
  const { out } = walk;
  const list = call.node.arguments[1];
  const written = writtenArray(list, call);
  if (written) return void out.calls.push({ path: member, position: { kind: 'arguments', call, arguments: written } });
  if (t.isIdentifier(list, { name: 'arguments' }) && !call.scope.getBinding('arguments')) {
    let owner: NodePath<t.Function> | null = call.getFunctionParent();
    while (owner && owner.isArrowFunctionExpression()) owner = owner.getFunctionParent();
    if (owner) return forwardedCalls(owner, walk);
  }
  out.escapes.push(call);
}

/**
 * `function w() { return f.apply(null, arguments) }`, `f(...arguments)`:
 * every call of `w` is a call of `f` with the same arguments. The callers
 * of `w` are asked for, and each is filed as a call of `f`.
 */
function forwardedCalls(owner: NodePath<t.Function>, walk: FlowWalk): void {
  const { holders, complete } = holdersOf(owner, walk.analysis);
  if (!complete) walk.out.escapes.push(owner);
  for (const holder of holders.flat()) walk.out.calls.push(holder);
}

/**
 * `f.bind(r, a)`: a function that calls `f` with `a` first and whatever
 * comes later. Called outright the two lists are one; through `.call` or
 * `.apply` the second call's arguments follow; held with nothing bound the
 * function is `f` under a new name; held with something bound, the bound
 * arguments are the first parameters' wherever it goes and the rest are
 * out of sight.
 */
function boundPosition(bind: NodePath<t.CallExpression | t.OptionalCallExpression>, member: NodePath, walk: FlowWalk): void {
  const { out } = walk;
  const bound = bind.node.arguments.slice(1);
  const invoked = bind.parentPath;
  if ((invoked.isCallExpression() || invoked.isOptionalCallExpression()) && invoked.node.callee === bind.node) {
    out.calls.push({ path: member, position: { kind: 'arguments', call: invoked, arguments: [...bound, ...invoked.node.arguments] } });
    return;
  }
  if (bound.length === 0) return followExpression(bind, [], walk);
  // Held with something bound: its `.name` is still the value's.
  followExpression(bind, [BOUND], walk);
  if ((invoked.isMemberExpression() || invoked.isOptionalMemberExpression()) && invoked.node.object === bind.node) {
    const through = memberKey(invoked.node);
    const outerCall = invoked.parentPath;
    if ((through === 'call' || through === 'apply') && outerCall.isCallExpression() && outerCall.node.callee === invoked.node) {
      const tail = through === 'call' ? outerCall.node.arguments.slice(1) : writtenArray(outerCall.node.arguments[1], outerCall);
      if (tail) out.calls.push({ path: member, position: { kind: 'arguments', call: outerCall, arguments: [...bound, ...tail] } });
      else out.escapes.push(outerCall);
      return;
    }
  }
  out.calls.push({ path: member, position: { kind: 'arguments', call: bind, arguments: bound, open: true } });
}

/**
 * The value returned from `fn`: the result of every call of it, where the
 * callers are in sight; a promise of it from an async function; what a
 * callback's return becomes - an element of `map`'s result, the fold of
 * `reduce`, the next link of a `then` chain - and, from a getter, the
 * value at every read of its key on whatever holds the getter.
 */
function returnedPosition(fn: NodePath<t.Function> | null, steps: readonly Step[], walk: FlowWalk): void {
  const { analysis, out } = walk;
  out.returned = true;
  if (!fn) return void out.escapes.push(analysis.program);
  if (fn.node.generator) {
    // `return v` from a generator is the `.value` of its last `next()`: out of a call result the walk does not open, and lost to the rest; see `opened`.
    out.escapes.push(fn);
    out.reads.push({ at: fn, selector: null, key: undefined, past: walk.past });
    out.cut = true;
    return;
  }
  const settled: readonly Step[] = fn.node.async ? [SETTLE, ...steps] : steps;
  // `Object.defineProperty(o, 'k', { get() { return v } })`, `{ get: function () { return v } }`: read at `o.k`.
  const described = descriptorGetter(fn);
  if (described) {
    for (const item of holderItems(described.target, described.call, [described.key, ...settled], walk)) out.next.push(item);
    return followExpression(described.call, [described.key, ...settled], walk);
  }
  if ((fn.isObjectMethod() || fn.isClassMethod()) && fn.node.kind !== 'method' && fn.node.kind !== 'constructor') {
    if (fn.node.kind !== 'get') return;
    const key = propertySelector(fn.node);
    const owner = fn.parentPath;
    if (owner.isObjectExpression()) return holderExpression(owner, [key, ...settled], walk);
    const cls = owner.parentPath;
    const binding = cls?.isClass() ? classBinding(cls) : undefined;
    if (binding) out.next.push({ target: binding, steps: [key, ...settled], instances: !(fn.isClassMethod() && fn.node.static), past: walk.past });
    else if (cls?.isClass() && !(fn.isClassMethod() && fn.node.static)) for (const instance of instancesInPlace(cls)) followExpression(instance, [key, ...settled], walk);
    else out.escapes.push(fn);
    return;
  }
  const { holders, complete } = holdersOf(fn, analysis);
  if (!complete) out.escapes.push(fn);
  // What a call hands back is tagged for the reflection walk; see `Past`.
  const past = (call: NodePath<CallLike>): FlowWalk => {
    if (walk.past === undefined || walk.past === 2) return walk;
    if (!directCall(call)) return withPast(walk, 2);
    return withPast(walk, settled.some((step) => !isWrap(step)) ? 1 : 0);
  };
  for (const { position } of holders.flat()) {
    if (position.kind === 'call') {
      followExpression(position.call, settled, past(position.call));
    } else if (position.kind === 'arguments') {
      if (!position.open) followExpression(position.call, settled, past(position.call as NodePath<CallLike>));
    } else {
      const { method } = position;
      if (method === 'map' || method === 'from') followExpression(position.call, [null, ...settled], walk);
      else if (method === 'flatMap') {
        const [inner, ...deeper] = settled;
        followExpression(position.call, [null, ...(isElementStep(inner) ? deeper : settled)], walk);
      } else if (method === 'reduce' || method === 'reduceRight') followExpression(position.call, settled, walk);
      else if (method === 'then' || method === 'catch' || method === 'finally') followExpression(position.call, [SETTLE, ...steps], walk);
      else if (method === null) out.escapes.push(position.call);
    }
  }
}

/** The object and key a function is the `get` of a descriptor for - a method or a property named `get` of a literal `descriptorOwner` places. */
function descriptorGetter(fn: NodePath<t.Function>): ReturnType<typeof descriptorOwner> {
  let property: NodePath | null = fn;
  if (fn.isFunctionExpression() || fn.isArrowFunctionExpression()) property = fn.parentPath;
  if (!property?.isObjectMethod() && !property?.isObjectProperty()) return undefined;
  if (propertySelector(property.node) !== 'get') return undefined;
  const literal = property.parentPath;
  return literal.isObjectExpression() ? descriptorOwner(literal) : undefined;
}

/**
 * The object and key a descriptor literal describes: the third argument of
 * `Object.defineProperty(o, k, d)` and `Reflect.defineProperty`, a property
 * of the second of `Object.defineProperties(o, { k: d })` and of
 * `Object.create(p, { k: d })`, whose result is the object.
 */
function descriptorOwner(descriptor: NodePath<t.ObjectExpression>): { target: t.Expression; key: Selector; call: NodePath<t.CallExpression> } | undefined {
  let call = descriptor.parentPath;
  let key: Selector;
  if (call.isObjectProperty() && call.node.value === descriptor.node && call.parentPath.isObjectExpression()) {
    key = propertySelector(call.node);
    call = call.parentPath.parentPath;
  } else if (call.isCallExpression() && call.node.arguments[2] === descriptor.node) {
    key = argumentSelector(call.node.arguments[1]);
  } else return undefined;
  if (!call.isCallExpression()) return undefined;
  const { callee } = call.node;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object) || call.scope.getBinding(callee.object.name)) return undefined;
  const method = memberKey(callee);
  const single = call.node.arguments[2] === descriptor.node;
  const defines = single ? method === 'defineProperty' && (callee.object.name === 'Object' || callee.object.name === 'Reflect') : callee.object.name === 'Object' && (method === 'defineProperties' || method === 'create');
  const [target] = call.node.arguments;
  if (!defines || !target || !t.isExpression(target)) return undefined;
  return { target: method === 'create' ? call.node : target, key, call };
}

/**
 * Whether a call spells its callee outright - a function written in place,
 * or the name of a fixed function this file declares - as against a call
 * through a member, an element, a bound or reassigned local; see `Past`.
 */
function directCall(call: NodePath<CallLike>): boolean {
  const [callee] = valueLeaves(call.node.callee as t.Expression);
  if (!callee) return false;
  if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) return true;
  return t.isIdentifier(callee) && knownFunction(callee.name, call.scope) !== undefined;
}

/** `yield v` in a generator: an element of what every call of it returns; `yield* vs` their elements. */
function yieldedPosition(yielded: NodePath<t.YieldExpression>, steps: readonly Step[], walk: FlowWalk): void {
  const { analysis, out } = walk;
  const fn = yielded.getFunctionParent();
  if (!fn || !fn.node.generator) return void out.escapes.push(yielded);
  let element: readonly Step[];
  if (yielded.node.delegate) {
    const [first, ...rest] = steps;
    if (!isElementStep(first)) return;
    element = [null, ...rest];
  } else element = [null, ...steps];
  // An async generator hands each element out settled: `for await` takes the wrapper off.
  if (fn.node.async) element = [null, SETTLE, ...element.slice(1)];
  const { holders, complete } = holdersOf(fn, analysis);
  if (!complete) out.escapes.push(fn);
  for (const { position } of holders.flat()) {
    if (position.kind === 'call' || (position.kind === 'arguments' && !position.open)) followExpression(position.call, element, walk);
    else out.escapes.push(position.call);
  }
}

/**
 * `throw v`, or a promise rejecting with it, awaited: caught by the nearest
 * enclosing `try` of the same function, whose parameter then holds it.
 * With none, thrown to the callers: a `try` around a call in sight catches
 * it, and from a function called at the top of the program it reaches no
 * code of this file's; an async function rejects its promise with it. From
 * a callback of `then` the chain rejects with it. Callers out of sight
 * may catch it, and it is lost there.
 */
function thrownPosition(at: NodePath, steps: readonly Step[], walk: FlowWalk, depth = 0): void {
  const { analysis, out } = walk;
  const catcher = enclosingCatch(at);
  if (catcher) {
    const { param } = catcher.node;
    if (param) destructure(param, catcher, steps, walk);
    return;
  }
  const fn = at.getFunctionParent();
  if (!fn) return;
  if (depth >= ERROR_CALL_DEPTH) return void out.escapes.push(at);
  const { holders, complete } = holdersOf(fn, analysis);
  if (!complete) out.escapes.push(at);
  for (const { position } of holders.flat()) {
    if (position.kind === 'callback') {
      if (position.method === 'then' || position.method === 'catch' || position.method === 'finally') followExpression(position.call, [REJECT, ...steps], walk);
      else out.escapes.push(position.call);
      continue;
    }
    if (fn.node.async) followExpression(position.call, [REJECT, ...steps], walk);
    else thrownPosition(position.call, steps, walk, depth + 1);
  }
}

/** The catch clause that receives a throw at `at`: the `try` block it sits in, within one function; from a handler or finalizer, the next `try` out. */
function enclosingCatch(at: NodePath): NodePath<t.CatchClause> | undefined {
  for (let path: NodePath | null = at; path; path = path.parentPath) {
    if (path.isFunction()) return undefined;
    const parent = path.parentPath;
    if (!parent?.isTryStatement() || parent.node.block !== path.node) continue;
    const handler = parent.get('handler');
    if (handler.isCatchClause()) return handler;
  }
  return undefined;
}

/**
 * The value as an argument of a builtin spelled by its free name -
 * outright, through `.call` and `.apply`, `Reflect.apply`, and `new` for
 * a constructor; whether the call was one. `Object(x)`, `new Proxy(x, h)`,
 * `freeze`, `seal`, `preventExtensions`, `Promise.resolve` hand `x` back,
 * wrapped or not; `Object.create(x)` and `setPrototypeOf` an object that
 * inherits it; `Reflect.get(x, k)` a member of it, and `defineProperty(x,
 * k, d)` `x` with `d.value` under `k`; `Array.from`, `Object.values`,
 * `entries`, `fromEntries`, `Promise.all`, `groupBy` and the collection
 * constructors a copy of the elements or properties of a holder, arranged
 * as each does; `Object.keys` and its kin enumerate the value's keys and
 * hand nothing of it back; `String(x)` coerces it; `Error(m, { cause })`
 * holds the cause. `Array.prototype.m.call(x, ...)` is `x.m(...)`.
 */
function builtinArgument(call: NodePath<CallLike>, index: number, steps: readonly Step[], spread: boolean, walk: FlowWalk): boolean {
  const [leaf] = valueLeaves(call.node.callee as t.Expression);
  if (!leaf || t.isSuper(leaf)) return false;
  let callee: t.Expression | t.Super = leaf;
  let at = index;
  if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && !call.isNewExpression()) {
    const link = memberKey(callee);
    // `Reflect.apply(f, r, list)` is the static, not `Reflect` called through `.apply`.
    const isStatic = t.isIdentifier(callee.object, { name: 'Reflect' }) && !call.scope.getBinding('Reflect');
    if ((link === 'call' || link === 'apply') && !isStatic) {
      if (t.isSuper(callee.object)) return false;
      const target = callee.object;
      // `Array.prototype.m.call(x, ...)`, `[].m.call(x, ...)`: `x.m(...)`.
      if (t.isMemberExpression(target) && !t.isSuper(target.object)) {
        const method = memberKey(target);
        const receiver = target.object;
        const isPrototype = t.isMemberExpression(receiver) && t.isIdentifier(receiver.object, { name: 'Array' }) && memberKey(receiver) === 'prototype' && !call.scope.getBinding('Array');
        if (method !== null && (isPrototype || t.isArrayExpression(receiver))) {
          if (link !== 'call') return false;
          if (at === 0) {
            holderMethod(call as NodePath<t.CallExpression>, method, steps, walk, 1);
            return true;
          }
          const [held] = call.node.arguments;
          if (held && t.isExpression(held)) return methodArgument(held, method, method, at - 1, steps, spread, call as NodePath<t.CallExpression>, walk);
          return false;
        }
      }
      if (link === 'call') {
        if (at === 0) return false;
        at--;
      } else {
        // `B.apply(r, [a, b])`: a holder in the list is an argument by its index.
        if (at !== 1 || spread || typeof steps[0] !== 'number') return false;
        at = steps[0];
        steps = steps.slice(1);
      }
      callee = target;
    }
  }
  return builtinResult(callee, call, at, steps, spread, walk);
}

/** The core of `builtinArgument`, with the builtin's callee and the argument's index in its own list. */
function builtinResult(callee: t.Expression | t.Super, call: NodePath<CallLike>, at: number, steps: readonly Step[], spread: boolean, walk: FlowWalk): boolean {
  const { analysis, out } = walk;
  const { node } = call;
  const [first, ...rest] = steps;
  const wrapped = isWrap(first);
  const isNew = t.isNewExpression(node);
  const result = (held: readonly Step[]): void => followExpression(call, held, walk);
  const read = (key: t.Node | undefined, probe = false): void => {
    if (steps.length === 0) out.reads.push({ at: call, selector: argumentSelector(key), key, probe });
  };
  /** The value stored into `target` under `held`, and into what the call hands back. */
  const store = (target: t.Node | undefined, held: readonly Step[]): void => {
    result(held);
    if (target && t.isExpression(target)) for (const item of holderItems(target, call, held, walk)) out.next.push(item);
  };
  const elements = (): readonly Step[] | undefined => (isElementStep(first) && !spread ? rest : undefined);
  if (t.isIdentifier(callee)) {
    const binding = call.scope.getBinding(callee.name);
    if (binding) {
      // `var all = Promise.all; all.call(Promise, list)`: the builtin under a local's name.
      if (binding.kind === 'param' || writesTo(binding).length > 0) return false;
      const [source, ...others] = sourcesOf(binding, analysis);
      if (!source || others.length > 0 || source.elements || t.isIdentifier(source.node) || !foreignRoot(source.node, source.at, analysis)) return false;
      return builtinResult(source.node, call, at, steps, spread, walk);
    }
    switch (callee.name) {
      case 'Object':
        if (at === 0) result(steps);
        return true;
      case 'Proxy':
        if (!isNew) return false;
        if (at === 0) result(steps);
        return true;
      case 'WeakRef':
        if (!isNew) return false;
        if (at === 0) result([DEREF, ...steps]);
        return true;
      case 'Error':
      case 'TypeError':
      case 'RangeError':
      case 'SyntaxError':
      case 'ReferenceError':
      case 'EvalError':
      case 'URIError':
        // `new Error(m, { cause: e })` holds `e` under `cause`; `new Error(e)` spells its text.
        if (at === 0 && steps.length === 0) out.coerced.push(call);
        else if (at === 1 && first === 'cause') result(steps);
        return true;
      case 'AggregateError':
        if (at === 0 && isElementStep(first)) result(['errors', ...steps]);
        else if (at === 1 && steps.length === 0) out.coerced.push(call);
        return true;
      case 'String':
      case 'Number':
      case 'BigInt':
        if (steps.length === 0) out.coerced.push(call);
        return true;
      case 'Boolean':
      case 'Symbol':
        return true;
      case 'Set':
      case 'WeakSet':
        if (!isNew) return false;
        if (at === 0 && isElementStep(first)) result([null, ...rest]);
        else if (at === 0 && first === ENTRY) result([null, 1, ...rest.slice(1)]);
        return true;
      case 'Map':
      case 'WeakMap':
        if (!isNew) return false;
        if (at === 0 && first === ENTRY) result(steps);
        else if (at === 0 && isElementStep(first)) {
          if (rest[0] === 1 || rest[0] === null) result([ENTRY, null, ...rest.slice(1)]);
          else if (rest[0] === 0) out.escapes.push(call);
        }
        return true;
      case 'Array':
        result(spread ? [null, ...rest] : [at, ...steps]);
        return true;
      case 'Promise':
        // `new Promise(executor)`: the executor's `resolve` and `reject`; see `promiseExecutorOf`.
        return isNew;
      case 'Function':
      case 'eval':
      case 'JSON':
      case 'Date':
      case 'RegExp':
        return false;
      default:
        return false;
    }
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false;
  if (!t.isIdentifier(callee.object) || call.scope.getBinding(callee.object.name)) return false;
  const method = memberKey(callee);
  if (method === null) return false;
  const { name } = callee.object;
  if (name === 'Object') {
    const [target, second, third] = node.arguments;
    switch (method) {
      case 'freeze':
      case 'seal':
      case 'preventExtensions':
        if (at === 0) result(steps);
        if (at === 0 && steps.length === 0 && method !== 'preventExtensions') out.enumerated = true;
        return true;
      case 'setPrototypeOf':
        if (at === 0) result(steps);
        else if (at === 1) store(target, [PROTO, ...steps]);
        return true;
      case 'create':
        if (at === 0) result([PROTO, ...steps]);
        else if (at === 1 && typeof first === 'string' && rest[0] === 'value') result([first, ...rest.slice(1)]);
        else if (at === 1 && !wrapped && steps.length > 0) out.escapes.push(call);
        return true;
      case 'defineProperty':
        if (at === 0) {
          result(steps);
          read(second);
        } else if (at === 2 && first === 'value') store(target, [argumentSelector(second), ...rest]);
        else if (at === 2 && (first === 'get' || first === 'set')) out.escapes.push(call);
        return true;
      case 'defineProperties':
        if (at === 0) {
          result(steps);
          if (steps.length === 0 && t.isObjectExpression(second)) {
            for (const property of second.properties) {
              if (t.isObjectProperty(property)) out.reads.push({ at: call, selector: propertySelector(property), key: property.computed ? property.key : undefined });
            }
          }
        } else if (at === 1 && !wrapped && steps.length > 0) {
          if (rest[0] === 'value') store(target, [first as Selector, ...rest.slice(1)]);
          else out.escapes.push(call);
        }
        return true;
      case 'assign':
        if (at === 0) result(steps);
        else if (steps.length > 0 && !wrapped) store(target, steps);
        if (steps.length === 0) out.enumerated = true;
        return true;
      case 'keys':
      case 'getOwnPropertyNames':
      case 'getOwnPropertySymbols':
        if (at === 0 && steps.length === 0) out.enumerated = true;
        return true;
      case 'values':
        if (at === 0 && steps.length === 0) out.enumerated = true;
        else if (at === 0 && !wrapped) result([null, ...rest]);
        return true;
      case 'entries':
        if (at === 0 && steps.length === 0) out.enumerated = true;
        else if (at === 0 && !wrapped) result([null, 1, ...rest]);
        return true;
      case 'fromEntries': {
        if (at === 0 && first === ENTRY) {
          result(rest);
          return true;
        }
        const pairs = elements();
        if (at === 0 && pairs) {
          if (pairs[0] === 1 || pairs[0] === null) result([null, ...pairs.slice(1)]);
          else if (pairs[0] === 0) out.escapes.push(call);
        }
        return true;
      }
      case 'getOwnPropertyDescriptors':
        if (at === 0 && steps.length === 0) out.enumerated = true;
        else if (at === 0 && !wrapped) result([first as Selector, 'value', ...rest]);
        return true;
      case 'getOwnPropertyDescriptor':
        if (at === 0 && steps.length === 0) read(second);
        else if (at === 0 && !wrapped && selectorsMeet(first as Selector, argumentSelector(second))) result(['value', ...rest]);
        return true;
      case 'getPrototypeOf':
        if (at === 0 && steps.length === 0) out.reads.push({ at: call, selector: '__proto__', key: undefined });
        else if (at === 0 && first === PROTO) result(rest);
        return true;
      case 'hasOwn':
        if (at === 0) read(second, true);
        return true;
      case 'groupBy': {
        const each = elements();
        if (at === 0 && each) {
          if (second && !t.isSpreadElement(second)) handToCallback(second, call, 0, each, walk);
          result([null, null, ...each]);
        }
        return true;
      }
      default:
        void third;
        return true;
    }
  }
  if (name === 'Reflect') {
    const [target, second, third] = node.arguments;
    switch (method) {
      case 'get':
      case 'getOwnPropertyDescriptor':
        if (at === 0 && steps.length === 0) read(second);
        else if (at === 0 && !wrapped && selectorsMeet(first as Selector, argumentSelector(second))) result(method === 'get' ? rest : ['value', ...rest]);
        return true;
      case 'has':
        if (at === 0) read(second, true);
        return true;
      case 'ownKeys':
        if (at === 0 && steps.length === 0) out.enumerated = true;
        return true;
      case 'getPrototypeOf':
        if (at === 0 && steps.length === 0) out.reads.push({ at: call, selector: '__proto__', key: undefined });
        else if (at === 0 && first === PROTO) result(rest);
        return true;
      case 'setPrototypeOf':
        if (at === 1 && target && t.isExpression(target)) for (const item of holderItems(target, call, [PROTO, ...steps], walk)) out.next.push(item);
        return true;
      case 'defineProperty':
        if (at === 0) read(second);
        else if (at === 2 && first === 'value' && target && t.isExpression(target)) {
          for (const item of holderItems(target, call, [argumentSelector(second), ...rest], walk)) out.next.push(item);
        } else if (at === 2 && (first === 'get' || first === 'set')) out.escapes.push(call);
        return true;
      case 'set':
        // `Reflect.set(o, k, v)` is `o[k] = v`.
        if (at === 0) read(second);
        else if (at === 2 && target && t.isExpression(target)) for (const item of holderItems(target, call, [argumentSelector(second), ...steps], walk)) out.next.push(item);
        return true;
      case 'apply': {
        // `Reflect.apply(f, r, [a, b])`: `f.apply(r, [a, b])` spelled as a static.
        if (!target || !t.isExpression(target)) return true;
        if (at === 0 && steps.length === 0) {
          const written = writtenArray(third, call);
          if (written) out.calls.push({ path: call, position: { kind: 'arguments', call, arguments: written } });
          else out.escapes.push(call);
        } else if (at === 1) appliedTo(target, -1, steps, call, walk);
        else if (at === 2 && typeof first === 'number') appliedTo(target, first, rest, call, walk);
        else if (at === 2) out.escapes.push(call);
        return true;
      }
      case 'construct':
        // `Reflect.construct(C, [a, b])` is `new C(a, b)`: the list's elements are the constructor's arguments.
        if (at === 1 && typeof first === 'number' && target && t.isExpression(target)) appliedTo(target, first, rest, call, walk);
        else if (at === 1) out.escapes.push(call);
        return true;
      default:
        return true;
    }
  }
  if (name === 'Array') {
    switch (method) {
      case 'from': {
        // The mapper is run with each element of the iterable.
        if (at === 1 && steps.length === 0 && node.arguments[0] && t.isExpression(node.arguments[0])) {
          out.calls.push({ path: call.get('arguments.1') as NodePath, position: { kind: 'callback', call, receiver: node.arguments[0], elementParams: [0], method: 'from' } });
          return true;
        }
        const each = first === ENTRY ? [1, ...rest.slice(1)] : elements();
        if (at === 0 && each) {
          const mapper = node.arguments[1];
          if (mapper && !t.isSpreadElement(mapper)) handToCallback(mapper, call, 0, each, walk);
          else result([first === ENTRY ? null : (first as Selector), ...each]);
        }
        return true;
      }
      case 'of':
        result(spread ? [null, ...rest] : [at, ...steps]);
        return true;
      default:
        return true;
    }
  }
  if (name === 'Promise') {
    if (isNew) return false;
    switch (method) {
      case 'resolve':
        if (at === 0) result(first === SETTLE || first === REJECT ? steps : [SETTLE, ...steps]);
        return true;
      case 'reject':
        if (at === 0) result([REJECT, ...steps]);
        return true;
      case 'all':
      case 'race':
      case 'any':
      case 'allSettled': {
        if (at !== 0 || !isElementStep(first)) return true;
        const settled = rest[0] === SETTLE ? rest.slice(1) : rest;
        if (rest[0] === REJECT) result([REJECT, ...rest.slice(1)]);
        else if (method === 'all') result([SETTLE, first, ...settled]);
        else if (method === 'allSettled') result([SETTLE, first, 'value', ...settled]);
        else result([SETTLE, ...settled]);
        return true;
      }
      default:
        return true;
    }
  }
  if (name === 'Map' && method === 'groupBy') {
    const each = elements();
    if (at === 0 && each) {
      const [, callback] = node.arguments;
      if (callback && !t.isSpreadElement(callback)) handToCallback(callback, call, 0, each, walk);
      result([null, null, ...each]);
    }
    return true;
  }
  if (name === 'String') {
    if (steps.length === 0) out.coerced.push(call);
    return true;
  }
  if (name === 'JSON' || name === 'Math' || name === 'Number' || name === 'Symbol' || name === 'Date' || name === 'console') return true;
  void analysis;
  return false;
}

/** `Reflect.apply(f, r, list)` with the value at `index` of the list, or as the receiver at -1: handed to what `f` runs. */
function appliedTo(callee: t.Expression, index: number, steps: readonly Step[], call: NodePath<CallLike>, walk: FlowWalk): void {
  const { analysis, out } = walk;
  if (index === 0 && builtinResult(valueLeaves(callee)[0] ?? callee, call, 0, steps, false, walk)) return;
  const functions: NodePath<t.Function>[] = [];
  const found = collectCallees(callee, call, analysis, functions, 0);
  if (found === 'unresolved') return void out.unresolved.push({ call, index, steps, applied: callee });
  if (found === 'foreign') return void out.foreign.push(call);
  if (functions.length > RESOLVED_CALLEES) return void out.escapes.push(call);
  for (const fn of functions) {
    if (index < 0) receiverOf(fn, steps, walk);
    else intoParameter(fn, index, steps, walk);
  }
}

/**
 * The value as an argument of a method called on a receiver this file
 * holds; whether the method took it. `q.push(v)`, `m.set(k, v)`,
 * `s.add(v)`, `[...].with(i, v)` store it into the receiver, and into the
 * collection the call hands back; `q.forEach(v)` and its kin run it with
 * the receiver's elements, which is a call position of it, and `p.then(v)`
 * runs it with what `p` settles to. With the method's name undecoded -
 * `q[k](v)` on a local - the call may be any of those: the value is in
 * the holder, and may be a callback handed the elements. A method of a
 * local this file wrote is resolved as a callee like any other.
 */
function methodArgument(receiver: t.Expression, method: string | null, selector: Selector, index: number, steps: readonly Step[], spread: boolean, call: NodePath<t.CallExpression | t.OptionalCallExpression>, walk: FlowWalk): boolean {
  const { analysis, out } = walk;
  const stored = (under: Step, key?: Selector): boolean => {
    const held: readonly Step[] = key === undefined ? [under, ...steps] : [under, key, ...steps];
    for (const item of holderItems(receiver, call, held, walk)) out.next.push(item);
    followExpression(call, held, walk);
    return true;
  };
  if (spread) return false;
  if (method === 'set' && index === 1) return stored(ENTRY, argumentSelector(call.node.arguments[0]));
  if (method === 'add' && index === 0) return stored(null);
  if (method === 'with' && index === 1) return stored(argumentSelector(call.node.arguments[0]));
  if (method === 'concat') {
    // `q.concat(list)` spreads an array argument into the copy it hands back,
    // and takes anything else as one element; which it is, the walk cannot say.
    const [first, ...rest] = steps;
    if (isElementStep(first)) followExpression(call, [null, ...rest], walk);
    followExpression(call, [null, ...steps], walk);
    return true;
  }
  const from = method === null ? undefined : ARRAY_STORES.get(method);
  if (from !== undefined && index >= from) return stored(null);
  if (steps.length === 0 && index === 0) {
    const elementParams = method === null ? undefined : ELEMENT_CALLBACKS.get(method);
    if (elementParams) {
      out.calls.push({ path: call.get('arguments.0') as NodePath, position: { kind: 'callback', call, receiver, elementParams, method } });
      return true;
    }
    if (method === 'then' || method === 'catch' || method === 'finally') {
      out.calls.push({ path: call.get('arguments.0') as NodePath, position: { kind: 'callback', call, receiver, elementParams: [0], method } });
      return true;
    }
  }
  if (method === null && selector === null && localHolder(receiver, call, analysis)) {
    // `q[k](v)` with `k` undecoded: stored, or handed the elements - taken
    // to be an array's method, and for a `.name` read still the unknown
    // callee it is (`classifyRootRead` widens).
    stored(null);
    if (steps.length === 0 && index <= 1) {
      out.calls.push({ path: call.get(`arguments.${index}`) as NodePath, position: { kind: 'callback', call, receiver, elementParams: [0, 1], method, assumed: !provenArray(receiver, call, analysis) } });
    }
    return false;
  }
  return false;
}

/** Whether a receiver is a value this file holds: a local, `this`, a member chain rooted in one, a literal in place. */
function localHolder(receiver: t.Expression, at: NodePath, analysis: ProgramAnalysis): boolean {
  return valueLeaves(receiver).every((leaf) => {
    let root: t.Node = leaf;
    while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) root = root.object;
    if (t.isThisExpression(root) || t.isObjectExpression(root) || t.isArrayExpression(root)) return true;
    if (!t.isIdentifier(root)) return false;
    const binding = at.scope.getBinding(root.name);
    if (!binding) return false;
    return !analysis.globalAliasIdentifiers.has(binding.identifier) && !analysis.maybeGlobalAliasIdentifiers.has(binding.identifier);
  });
}

/** One place a function can be called from, with how it is used there; see `holdersOf`. */
interface Holder {
  path: NodePath;
  position: HolderPosition;
}

/**
 * Every position through which `fn` can be called, found by `Flow` from
 * the function as a value: its own call sites, those of every binding it
 * moves into, of every holder it is stored in and read back out of, of
 * every parameter of a known callee it is handed to, of every instance of
 * a class or ES5 constructor whose method it is. Not `complete` when the
 * walk lost it somewhere: handed to a callee it cannot resolve or to
 * another script's, stored on something that is no local, held by a
 * binding that is written again or can be reached by its name without a
 * reference (`reachedByName`): `g.eval('_0xf')(function _0x96d6() {})`
 * calls `_0xf` with nothing in its reference list, and the literal was
 * renamed out from under its `.name` read.
 *
 * The holders found are returned either way. A caller that resolves them
 * and widens for the rest is exact about what it can see; one that only
 * widened would lose the argument of a visible call to a known callee.
 *
 * Handed back in segments: the walk's own, then one array per binding the
 * function was reached through. A segment reached through a local under
 * one key - `map[k](...)` for every `k` undecoded - is the array kept for
 * that (local, key), shared by every method of the local, so that a
 * reading applied to the segment's call sites is applied once for all of
 * them; see `calleeTargets`.
 */
function holdersOf(fn: NodePath<t.Function>, analysis: ProgramAnalysis): { holders: Holder[][]; complete: boolean } {
  const memo = analysis.holders.get(fn.node);
  if (memo) return memo;
  // A call resolved on the way here may ask for this function's holders
  // again; met in progress, it is answered as unknown - which is also the
  // answer kept for a function whose callers are out of sight from the start.
  const unknown = { holders: [] as Holder[][], complete: false };
  analysis.holders.set(fn.node, unknown);
  const flow = new Flow(analysis);
  if (fn.isFunctionDeclaration()) {
    const id = fn.node.id;
    const binding = id && (fn.scope.parent?.getBinding(id.name) ?? fn.scope.getBinding(id.name));
    if (!binding) return unknown;
    flow.add({ target: binding, steps: [] });
    // A block-level function in sloppy code is also a var of the enclosing
    // function or script, called by a name no scope table lists.
    if (id && analysis.annexBFunctions.has(id)) for (const reference of annexBReferences(fn, binding, analysis)) flow.start(reference, []);
  } else if (fn.isFunctionExpression() || fn.isArrowFunctionExpression()) {
    flow.start(fn, []);
    // A named expression can call itself by that name from inside.
    const id = fn.isFunctionExpression() ? fn.node.id : null;
    const own = id && fn.scope.getBinding(id.name);
    if (own) flow.add({ target: own, steps: [] });
  } else if (fn.isObjectMethod()) {
    if (fn.node.kind !== 'method') return unknown;
    flow.start(fn.parentPath, [propertySelector(fn.node)]);
  } else if (fn.isClassMethod() || fn.isClassPrivateMethod()) {
    const owner = fn.parentPath.parentPath;
    if (!owner?.isClass()) return unknown;
    const binding = classBinding(owner);
    const key = fn.isClassPrivateMethod() ? `#${fn.node.key.id.name}` : propertySelector(fn.node);
    if (fn.isClassMethod() && fn.node.kind === 'constructor') {
      // `new C(...)` is the constructor's call; a subclass's passes through.
      if (binding) flow.add({ target: binding, steps: [] });
      else for (const instance of instancesInPlace(owner)) flow.start(instance.get('callee') as NodePath, []);
    } else if (fn.node.kind === 'method') {
      if (binding) flow.add({ target: binding, steps: [key], instances: !fn.node.static });
      else if (!fn.node.static) for (const instance of instancesInPlace(owner)) flow.start(instance, [key]);
      else return unknown;
    } else return unknown;
    // `this.m(...)` inside the class body reaches the method through the instance, or the class.
    for (const self of thisInClass(owner, fn.node.static, analysis)) flow.start(self, [key]);
  } else return unknown;
  flow.drain();
  const holders: Holder[][] = [];
  for (const [reached] of flow.reached()) holders.push(reached.calls);
  const result = { holders, complete: !flow.lost(true) };
  analysis.holders.set(fn.node, result);
  for (const segment of holders) {
    for (const { position } of segment) {
      const targets = analysis.calleeTargets.get(position.call.node);
      const target = { fn, position };
      if (targets) targets.push(target);
      else analysis.calleeTargets.set(position.call.node, [target]);
    }
  }
  return result;
}

/**
 * `window.foo` - a property of the global object, named in this same file.
 *
 * In a script a program-scope `var`/`function` *is* such a property, so this is
 * a use of the binding that `binding.referencePaths` does not contain: nothing
 * about `window._0x4a68` mentions `_0x4a68` as an identifier. Renaming on the
 * strength of the reference list alone left the property read addressing a name
 * the file no longer declares.
 *
 * The global object has more spellings than its own names, and each is
 * followed by `Flow` to wherever the value goes once the whole tree has
 * been seen, since an alias may be declared below the read. `this` at the
 * top of a script is it, and so is `this` in a sloppy function called
 * plainly, which is how `(function () { this._0x4a68(...) })()` reaches a
 * program-scope function; `thisOwner` says which. An alias - `var g =
 * globalThis`, an alias of that, the `d` of `!function (d) { ... }(window)`
 * or of `(function (d) { ... }).call(this, this)`, the `root` a UMD wrapper
 * hands its factory, a parameter defaulted to it, `typeof globalThis !==
 * 'undefined' ? globalThis : this` - is read through its references. A
 * pattern taking it apart reads each key. A local that stores it in a
 * property or element is a holder, and `o.g` is the global object again;
 * so is `window.window` or `globalThis.self`, which `member` follows on.
 *
 * Wherever the walk lost the value - an argument to a callee it cannot
 * resolve, a `return` to callers out of sight, a store into something
 * that is no local - the global object has escaped into code that can
 * read a program-scope property by any name; but a static read spells its
 * key, so `globalObjectEscaped` refuses exactly the program-scope names
 * the file spells as a member or pattern key (`memberKeys`; a string key
 * is `strings`' already, and a computed one is the contract `selectGlobal`
 * documents). Where the object's own keys are enumerated - a `for-in`,
 * `Object.keys`, a spread - every name is observed, and
 * `globalObjectEnumerated` refuses them all. Only a spelling that
 * certainly is the global object counts for either. `this` in a sloppy
 * function is the caller's to choose, and in mainstream code that
 * function is a method or a constructor, so it and its aliases contribute
 * their member reads and nothing more - the lowest of the three ranks
 * `Flow` walks at. A callee that is another script's - a free name, a
 * value read off the global object - is the unknown-code boundary the
 * whole pass stops at: `$(window)` hands jQuery the window, and what
 * jQuery does with it is jQuery's. A callee unresolved on one round may
 * resolve on the next once its root is known to be an alias, so rounds
 * run until one settles nothing, and what is still unresolved then has
 * escaped.
 */
function resolveGlobalAliases(analysis: ProgramAnalysis): void {
  const MAYBE = 0;
  const EXPORT = 1;
  const GLOBAL = 2;
  const flow = new Flow(analysis);
  const plain = new Map<t.Node, boolean>();
  /**
   * Reads already recorded, by the ranks that reached them. What a read
   * discloses is the rank's - only GLOBAL says a top-level name may be read
   * under an unresolved key - so a segment reached at two ranks is recorded
   * at each; the positions it adds to the tables (`listed`) are added once.
   */
  const recorded = new Map<t.Node, Set<number>>();
  const listed = new Set<t.Node>();

  const escape = (rank: number): void => {
    if (rank === GLOBAL && analysis.programScopeIsGlobal) analysis.globalObjectEscaped = true;
  };
  const enumerate = (rank: number): void => {
    if (rank === GLOBAL && analysis.programScopeIsGlobal) analysis.globalObjectEnumerated = true;
  };

  /**
   * A read of the global object under `selector`, spelled at `read` - a
   * member, a `Reflect.get` call, a pattern key. A key spelled whole pins
   * the program-scope binding of that name. A key nothing resolves is
   * taken to read a host property (`selectGlobal` documents the choice),
   * with two guards on the assumption: every program-scope name that
   * contains a string spelled inside the key keeps its own
   * (`globalKeyFragments`), since `g[dec(0) + '2b3c']` with `dec` refused
   * printed a `TypeError` at balanced for the function `_0x1a2b3c`; and a
   * read whose result is used is disclosed (`globalOpaqueReads`), so that
   * a rename made under the assumption is said to be one. The names such
   * a key spells whole beside a part out of sight - `map` for `(g.K ||
   * 'm') + 'ap'` - are pinned in both directions, as a key resolved is.
   */
  const member = (read: FlowRead, rank: number): void => {
    let { selector } = read;
    const { at, key } = read;
    if (typeof selector === 'number') return;
    let spelled: KeyStrings = NOTHING_SPELLED;
    if (selector === null && key) {
      spelled = keyStrings(key, at.scope, analysis);
      if (spelled.complete && spelled.whole.length === 1) selector = spelled.whole[0]!;
    }
    // A pattern's reads share one position, so each is listed as it comes.
    const unlisted = read.into !== undefined || !listed.has(at.node);
    if (selector === null) {
      if (rank === EXPORT || !key) return;
      if (unlisted) {
        listed.add(at.node);
        for (const part of spelled.parts) analysis.globalKeyFragments.push(part);
        for (const text of spelled.whole) analysis.globalKeyFragments.push({ text, where: 'whole' });
      }
      const outer = at.parentPath;
      if (!outer || read.into) return;
      if (rank === GLOBAL) {
        analysis.globalUnresolvedReads.push(at);
        if (resultUsed(at)) analysis.globalOpaqueReads.push(at);
      }
      if (unlisted && (outer.isCallExpression() || outer.isNewExpression()) && outer.node.callee === at.node) analysis.globalUnresolvedCalls.push(at);
      return;
    }
    analysis.globalObjectMembers.add(selector);
    if (read.into) {
      const patterns = analysis.globalPatternReads.get(selector);
      const pattern = { at, into: read.into };
      if (patterns) patterns.push(pattern);
      else analysis.globalPatternReads.set(selector, [pattern]);
    } else if (!read.probe && unlisted) {
      listed.add(at.node);
      let reads = analysis.globalMemberReads.get(selector);
      if (!reads) {
        reads = [];
        analysis.globalMemberReads.set(selector, reads);
      }
      reads.push(at);
    }
    // `window.window`, `globalThis.self`, `const { self } = window`: the global object again.
    if (GLOBAL_OBJECT_NAMES.has(selector) && rank !== EXPORT && !read.probe) {
      if (read.into) {
        const walk = flow.walkAt(rank);
        destructure(read.into, at, [], walk);
        flow.settle(walk.out, rank);
      } else flow.start(at, [], rank);
    }
  };

  const consume = (reached: Reached, rank: number): void => {
    for (const read of reached.reads) {
      if (!read.into) {
        let ranks = recorded.get(read.at.node);
        if (ranks?.has(rank)) continue;
        if (!ranks) recorded.set(read.at.node, (ranks = new Set()));
        ranks.add(rank);
      }
      member(read, rank);
    }
    if (reached.escapes.length > 0) escape(rank);
    if (reached.enumerated) enumerate(rank);
  };
  const alias = (binding: Binding, rank: number): void => {
    analysis.aliasGeneration++;
    if (rank === MAYBE) analysis.maybeGlobalAliasIdentifiers.add(binding.identifier);
    else analysis.globalAliasIdentifiers.add(binding.identifier);
  };

  for (const spelling of analysis.globalSpellings) {
    const rank = spelling.kind === 'maybe' ? (plainlyCalled(spelling.path, analysis, plain) ? GLOBAL : MAYBE) : spelling.kind === 'export' ? EXPORT : GLOBAL;
    // `var g = window` and the window parameter of a wrapping IIFE keep
    // their names (`namedAliasIdentifiers`): the two spellings that say
    // what the alias is.
    if (rank !== MAYBE && spelling.path.isIdentifier() && GLOBAL_OBJECT_NAMES.has(spelling.path.node.name)) {
      const named = namedAliasOf(spelling.path, analysis);
      if (named) analysis.namedAliasIdentifiers.add(named.identifier);
    }
    flow.start(spelling.path, [], rank);
  }
  analysis.globalSpellings.length = 0;

  const seen = new Set<Reached>();
  for (;;) {
    flow.drain((item, reached, rank) => {
      if (item.steps.length === 0 && !item.instances && typeof item.target !== 'string') alias(item.target, rank);
      consume(reached, rank);
    });
    for (const [reached, rank] of flow.reached()) {
      if (seen.has(reached)) continue;
      seen.add(reached);
      consume(reached, rank);
    }
    // A member read that is the global object again started a walk of its own.
    if (flow.hasPending()) continue;
    // A callee unresolved on one round may resolve on the next.
    let settled = true;
    for (let i = flow.unresolved.length - 1; i >= 0; i--) {
      const { call, rank } = flow.unresolved[i]!;
      const walk = flow.walkAt(rank);
      const retried = retryCall(call, walk);
      if (!retried) continue;
      flow.unresolved.splice(i, 1);
      flow.settle(walk.out, rank);
      settled = false;
    }
    if (settled && !flow.hasPending()) break;
  }
  for (const { rank } of flow.unresolved) escape(rank);
  // Own segments were consumed above once per round; the last round's additions too.
  for (const [reached, rank] of flow.reached()) if (!seen.has(reached)) consume(reached, rank);
}

/**
 * The alias a spelled global name is given in one of the two spellings
 * that keep their names: `var g = window` outright, and the parameter of
 * a wrapping IIFE - `!function (d) { ... }(window)` - at the argument's own
 * index, with nothing spread before it.
 */
function namedAliasOf(spelling: NodePath<t.Identifier>, analysis: ProgramAnalysis): Binding | undefined {
  const parent = spelling.parentPath;
  if (!parent) return undefined;
  const outer = parent.node;
  if (t.isVariableDeclarator(outer) && outer.init === spelling.node && t.isIdentifier(outer.id)) return parent.scope.getBinding(outer.id.name);
  if (!t.isCallExpression(outer) || !t.isFunction(outer.callee)) return undefined;
  const index = outer.arguments.indexOf(spelling.node);
  if (index < 0 || outer.arguments.slice(0, index).some((argument) => t.isSpreadElement(argument))) return undefined;
  const fn = functionPathOf(outer.callee, parent, analysis);
  const param = outer.callee.params[index];
  return fn && t.isIdentifier(param) ? fn.scope.getOwnBinding(param.name) : undefined;
}

/**
 * Asks a call unresolved on an earlier round again; true when it resolved
 * - to functions, whose parameters now hold the value, or to another
 * script's, which is the boundary.
 */
function retryCall(unresolved: FlowCall, walk: FlowWalk): boolean {
  const { call, index, steps, applied } = unresolved;
  const { analysis, out } = walk;
  const before = out.unresolved.length;
  if (applied) appliedTo(applied, index, steps, call, walk);
  else {
    const resolved = calleeFunctions(call, analysis);
    if (resolved === 'unresolved') return false;
    if (resolved === 'foreign') {
      out.foreign.push(call);
      return true;
    }
    if (resolved.functions.length > RESOLVED_CALLEES) out.escapes.push(call);
    else for (const fn of resolved.functions) {
      if (index < resolved.offset) receiverOf(fn, steps, walk);
      else intoParameter(fn, index - resolved.offset, steps, walk);
    }
  }
  if (out.unresolved.length > before) {
    out.unresolved.splice(before);
    return false;
  }
  return true;
}

/**
 * `catch (e) { ... e.message ... }`: the program reads text V8 built from a
 * binding name.
 *
 * `Cannot access 'before' before initialization`, `_0x1a1a is not a function`,
 * `Cannot destructure property 'a' of 'o' as it is undefined`, `x is not
 * iterable` - the engine spells the failing reference into the message, the
 * stack repeats it, and `toString` is the two joined. The text is not a
 * property of any binding this layer can see: it is a property of the
 * *failure*, produced at run time from whatever the failing reference is
 * spelled. But the failing reference is one of a small, visible set - it sits
 * in the `try` block the catch belongs to, or in a function that block calls
 * - and the only way to keep its text is to keep its spelling. So every
 * binding referenced in that block keeps its name (`pinErrorText`), at every
 * preset: disclosing the drift is not enough, since a `JSON.parse` rule
 * renamed a TDZ read to `data` with nothing but a warning to say so.
 *
 * The pin is by *reference*, not by failure shape. Which reference V8 will
 * spell is decided by which value is wrong at run time, and it renders the
 * call-site text for more errors than a list here would stay honest about:
 * TDZ on a read or a write, a call or `new` of a non-function (`o.f()` spells
 * `o`), a spread or `for-of` of a non-iterable, a destructuring of `null`. A
 * refusal for a reference that could never fail costs a rename, never
 * correctness. Calls are followed to `ERROR_CALL_DEPTH`; a failure deeper
 * than that, or in a call the walk cannot resolve, is what `errorTextRead`
 * still discloses.
 *
 * Whether the text is read is `Flow`'s to say (`readsErrorText`): off the
 * parameter itself, off a pattern that takes it apart, off any alias or
 * holder or parameter the error moves into, through coercion - `String(e)`,
 * `` `${e}` ``, `e + ''` - and through a computed key nothing here resolves,
 * since `e[k]` with `k` undecoded may be `e.message`. A rejection handler -
 * the function handed to `.catch(...)` or as the second argument of `.then(...)`
 * - is the same read in the promise spelling, and the handlers earlier in its
 * chain are its `try` (`pinRejectedChain`). Where the walk loses the error -
 * handed to a callee it cannot resolve, stored on what is no local - the
 * text may be read out of sight: the chain is pinned as for a read, and the
 * loss is disclosed at every preset that renamed anything.
 *
 * Queued during the traversal and answered after it, because the walk asks
 * what calls run and where functions are called from, and both are complete
 * only once the whole tree - and the global object's aliases - are known.
 */
function recordCaughtErrorRead(path: NodePath<t.CatchClause>, analysis: ProgramAnalysis): void {
  if (path.node.param) analysis.errorReadQueue.push(path);
}

function recordRejectionHandler(path: NodePath<t.CallExpression>, analysis: ProgramAnalysis): void {
  const callee = path.node.callee;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
  const method = memberKey(callee);
  const index = method === 'catch' ? 0 : method === 'then' ? 1 : -1;
  if (index < 0) return;
  const argument = path.get('arguments')[index];
  if (!argument) return;
  // `.catch(show)` with `function show(err) { log(err.message) }`: the
  // handler spelled by name.
  const handler = argument.isFunctionExpression() || argument.isArrowFunctionExpression() ? argument : argument.isIdentifier() ? knownFunction(argument.node.name, argument.scope) : undefined;
  if (!handler) return;
  const param = handler.node.params[0];
  if (!param) return;
  // Remembered whether or not its text is read: `.catch(e => e.name)` is the
  // catch-parameter case in the promise spelling, and `classifyRootRead` leaves
  // it alone on the same grounds.
  const unwrapped = t.isAssignmentPattern(param) ? param.left : param;
  if (t.isIdentifier(unwrapped)) {
    const binding = handler.scope.getOwnBinding(unwrapped.name);
    if (binding) analysis.rejectionParams.add(binding);
  }
  analysis.errorReadQueue.push(path);
}

/** Answers every queued catch clause and rejection handler; see `recordCaughtErrorRead`. */
function drainErrorReads(analysis: ProgramAnalysis): void {
  for (const path of analysis.errorReadQueue) {
    if (path.isCatchClause()) {
      const { param } = path.node;
      if (!param || !readsErrorText(param, path, analysis)) continue;
      analysis.errorTextRead = true;
      const statement = path.parentPath;
      if (statement.isTryStatement()) pinErrorText(statement.get('block'), analysis);
    } else if (path.isCallExpression()) {
      const callee = path.node.callee as t.MemberExpression | t.OptionalMemberExpression;
      const argument = path.get('arguments')[memberKey(callee) === 'catch' ? 0 : 1]!;
      const handler = argument.isFunction() ? argument : argument.isIdentifier() ? knownFunction(argument.node.name, argument.scope) : undefined;
      const param = handler?.node.params[0];
      if (!handler || !param || !readsErrorText(param, handler, analysis)) continue;
      analysis.errorTextRead = true;
      pinRejectedChain(path, analysis);
    }
  }
  analysis.errorReadQueue.length = 0;
}

/** Properties of a caught error whose text embeds the failing binding's name. */
const ERROR_TEXT_MEMBERS: ReadonlySet<string> = new Set(['message', 'stack', 'toString']);

/**
 * Whether the text of the error `param` holds is read anywhere it goes;
 * see `recordCaughtErrorRead`. Lost - to a callee the walk cannot resolve,
 * a store on what is no local - it is taken to be read, and the loss is
 * disclosed (`errorTextUnfollowed`). A store into a local holder is no
 * read, and what is read back out of the holder is followed: `errors[0]
 * .message`, `errors.find(Boolean).message`. Stored under a key nothing
 * resolves and read back under another - `R[k] = e ... R[j]`, the register
 * file of a VM's dispatch loop, whose elements are then coerced, called,
 * handed everywhere - is the compounding of two unknowns; at balanced and
 * aggressive the elements are taken not to be the error (`FlowWalk.assumes`)
 * and the assumption is disclosed once, and with `assumeHostProperties`
 * off they are followed, which pins.
 */
function readsErrorText(param: t.Node, at: NodePath, analysis: ProgramAnalysis): boolean {
  const assumes = analysis.assumesHostProperties;
  const flow = new Flow(analysis, undefined, assumes);
  const walk = flow.walkAt(0);
  destructure(param, at, [], walk);
  flow.settle(walk.out, 0);
  // The segments of a local holding the error as an element under a key
  // nothing resolves: what leaves them by a key spelled out is read as the
  // error; the holder itself lost is the assumption.
  const held = new Set<Reached>();
  flow.drain((item, reached) => {
    if (assumes && item.steps[0] === null && typeof item.target !== 'string') held.add(reached);
  });
  let read = false;
  let lost = false;
  let assumed = false;
  for (const [reached] of flow.reached()) {
    if (reached.coerced.length > 0) read = true;
    for (const { selector, key, probe } of reached.reads) {
      if (probe) continue;
      if (selector === null ? key !== undefined && staticNumber(key) === undefined : typeof selector === 'string' && ERROR_TEXT_MEMBERS.has(selector)) read = true;
    }
    if (held.has(reached)) {
      if (reached.unresolved.some((call) => call.steps.length === 0)) lost = true;
      else if (reached.escapes.length > 0 || reached.unresolved.length > 0) assumed = true;
    } else if (reached.escapes.length > 0 || reached.unresolved.length > 0) lost = true;
    if (reached.assumed) assumed = true;
  }
  if (lost || assumed) analysis.errorTextUnfollowed = true;
  return read || lost;
}

// ---------------------------------------------------------------------------
// Reflection: every `.name` read, answered by the walk of every function and class
// ---------------------------------------------------------------------------

/**
 * A value whose `.name` a rename here would change, and the identifier
 * that spells it: a function or class declaration; a named function or
 * class expression, by its own id; an anonymous function, class or arrow
 * that takes a binding's name by named evaluation - a declarator's
 * initialiser, `x = ...`, `x ||= ...`, a default in a parameter or a pattern.
 * A method of a literal or a class is named by its key, which no binding
 * spells.
 */
interface Observable {
  identifier: t.Identifier;
  /** The binding whose every reference is the value: a declaration, the own name of a named expression. */
  binding?: Binding;
  /** The value's own node, for an expression. */
  value?: NodePath;
}

function observableValues(analysis: ProgramAnalysis): Observable[] {
  const found: Observable[] = [];
  const anonymous = (value: t.Expression | null | undefined): NodePath | undefined => {
    if (!value) return undefined;
    const inner = unwrapTransparent(value);
    if ((t.isFunctionExpression(inner) && !inner.id) || t.isArrowFunctionExpression(inner)) return analysis.functionPaths.get(inner);
    if (t.isClassExpression(inner) && !inner.id) return analysis.classPaths.get(inner);
    return undefined;
  };
  for (const binding of analysis.bindings) {
    const declaration = binding.path;
    if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration() || namesOwnExpression(binding)) {
      found.push({ identifier: binding.identifier, binding });
      continue;
    }
    const { identifier } = binding;
    if (declaration.isVariableDeclarator()) {
      const { id, init } = declaration.node;
      const value = t.isIdentifier(id) ? anonymous(init) : anonymous(defaultValueOf(id, identifier));
      if (value) found.push({ identifier, value });
    } else if (binding.kind === 'param') {
      const value = anonymous(defaultValueOf(declaration.node, identifier));
      if (value) found.push({ identifier, value });
    }
    for (const violation of binding.constantViolations) {
      const node = violation.node;
      if (!t.isAssignmentExpression(node) || !NAMING_ASSIGNMENTS.has(node.operator) || !t.isIdentifier(node.left)) continue;
      const value = anonymous(node.right);
      if (value) found.push({ identifier, value });
    }
  }
  return found;
}

/**
 * Freezes the spelling of every function or class whose `.name` the program
 * reads, by walking each such value to every position it reaches; see
 * `Flow`. A read of `.name`, of `toString` or through a coercion, or under
 * a key nothing resolves - which with the string array undecoded is what
 * `.name` looks like, and often is - pins
 * the value's spelling at every preset. A read reached past a call result
 * is the contract `naming-reflection-members` holds (see `Past`): the
 * value is renamed and the read disclosed.
 *
 * What the walk cannot follow the value into - a callee it cannot resolve,
 * another script's function, a store on what is no local, a binding
 * reachable by name - is where the value is let go of, and a `.name` read
 * off something that arrived from out of sight (`classifyNameRead`) may be
 * of any such value: every one of them is frozen. A read off a constructor
 * reached through the object model may be of any value at all.
 *
 * Every value is walked, not only those a read is rooted in: the read's
 * object says where the value came *from*, which is the question the walk
 * answers going forward, and the memo `bindingReached` keeps makes the
 * second value stored in a holder cost the holder nothing.
 */
function resolveNameReads(analysis: ProgramAnalysis): void {
  for (const read of analysis.nameReadQueue) classifyNameRead(read.object, read.at, read.property, analysis);
  analysis.nameReadQueue.length = 0;
  for (const { fn, property } of analysis.paramNameReads) {
    if (!holdersOf(fn, analysis).complete && property === 'name') analysis.escapedValueNameRead = true;
  }
  analysis.paramNameReads.length = 0;

  const values = observableValues(analysis);
  const lost: Observable[] = [];
  const unfollowed: Observable[] = [];
  for (const observable of values) {
    const flow = new Flow(analysis, 0);
    if (observable.binding) flow.startBinding(observable.binding);
    if (observable.value) flow.start(observable.value, []);
    flow.drain();
    let read = false;
    let disclosed = false;
    let returned = false;
    let cut = false;
    for (const [reached] of flow.reached()) {
      if (reached.bounded) disclosed = true;
      if (reached.returned) returned = true;
      if (reached.cut) cut = true;
      for (const { selector, key, probe, past, write } of reached.reads) {
        // A function's `name` is not writable: `f.name = 'x'` reads nothing.
        if (probe || write) continue;
        // Selected out of a call result; see `Past`.
        if (selector === null && key === undefined) {
          disclosed = true;
          continue;
        }
        if (selector !== 'name' && selector !== 'toString' && !(selector === null && staticNumber(key!) === undefined)) continue;
        if (past === 2) disclosed = true;
        else read = true;
      }
    }
    if (read) analysis.reflectiveIdentifiers.add(observable.identifier);
    if (disclosed) analysis.unfollowedNameRead = true;
    // A read that widens reaches a value let go of anywhere, a return included; a
    // value returned and followed to its reads is not one the walk left behind.
    if (flow.lost(true) || cut) unfollowed.push(observable);
    if (flow.lost(true) || cut || returned) lost.push(observable);
  }
  if (analysis.unknownValueNameRead) {
    for (const observable of values) analysis.reflectiveIdentifiers.add(observable.identifier);
  } else if (analysis.escapedValueNameRead) {
    for (const observable of lost) analysis.reflectiveIdentifiers.add(observable.identifier);
  }
  // A read off what a call of this file's own hands back, with a value the walk left behind somewhere: the value may be what came back.
  if (analysis.callResultNameRead && unfollowed.length > 0) analysis.unfollowedNameRead = true;
}

/**
 * Where the value a `.name` read is off came from, when it is out of
 * sight. A parameter of a function whose callers the walk cannot enumerate
 * holds whatever they pass, which may be any value the program let go of:
 * the read widens to every such value (`escapedValueNameRead`) - for a
 * `.name` outright; a key nothing resolves does not widen, since the key
 * really being `name` *and* the argument arriving from out of sight is two
 * unknowns compounded, and refusing on both cost every escaped function in
 * obfuscated2.js. `arguments`, a member off such a parameter, and what a
 * parameter returns when called are the same. A constructor reached
 * through the object model - `x.constructor`, `Object.getPrototypeOf(x)` -
 * may be any class (`unknownValueNameRead`). The result of a call on one of
 * this file's own values that is not a fixed function - `o.get()`, a
 * reassigned local, `fn.bind(x)()` - is disclosed rather than widened
 * (`callResultNameRead`), and only where some value was let go of, since
 * otherwise the walk has followed every value to whatever such a call
 * hands back; a builtin's result is one of its arguments, which are
 * classified in its place; a free root is another script's value.
 */
function classifyNameRead(object: t.Expression | t.Super, at: NodePath, property: 'name' | 'toString' | 'opaque', analysis: ProgramAnalysis): void {
  if (property === 'toString') return;
  for (const leaf of valueLeaves(object)) {
    if (t.isAwaitExpression(leaf)) {
      classifyNameRead(leaf.argument, at, property, analysis);
    } else if (t.isIdentifier(leaf)) {
      classifyRootRead(leaf, at, property, analysis);
    } else if (t.isMemberExpression(leaf) || t.isOptionalMemberExpression(leaf)) {
      if (denotesConstructor(leaf, at, analysis)) {
        analysis.unknownValueNameRead = true;
        continue;
      }
      let root: t.Node = leaf;
      while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) root = root.object;
      if (t.isIdentifier(root)) classifyRootRead(root, at, property, analysis);
      else if (t.isCallExpression(root) || t.isOptionalCallExpression(root)) classifyCallRead(root, at, property, analysis);
    } else if (t.isCallExpression(leaf) || t.isOptionalCallExpression(leaf)) {
      if (denotesConstructor(leaf, at, analysis)) analysis.unknownValueNameRead = true;
      else classifyCallRead(leaf, at, property, analysis);
    } else if ((t.isFunctionExpression(leaf) || t.isClassExpression(leaf)) && leaf.id) {
      analysis.reflectiveIdentifiers.add(leaf.id);
    } else if (denotesConstructor(leaf, at, analysis)) {
      analysis.unknownValueNameRead = true;
    }
  }
}

/** A `.name` read rooted in a name: a parameter or `arguments` of a function whose callers are out of sight widens; see `classifyNameRead`. */
function classifyRootRead(root: t.Identifier, at: NodePath, property: 'name' | 'opaque', analysis: ProgramAnalysis): void {
  const binding = at.scope.getBinding(root.name);
  let reader: NodePath<t.Function> | null | undefined;
  if (binding) {
    if (binding.kind !== 'param' || analysis.rejectionParams.has(binding)) return;
    reader = paramOwner(binding)?.fn;
  } else if (root.name === 'arguments') {
    reader = at.getFunctionParent();
    while (reader && reader.isArrowFunctionExpression()) reader = reader.getFunctionParent();
  }
  // The reader's holders are asked for under both readings, so that its call sites are known to the walk of every value (`calleeTargets`).
  if (reader && !holdersOf(reader, analysis).complete && property === 'name') analysis.escapedValueNameRead = true;
}

/** A `.name` read off what a call returned; see `classifyNameRead`. */
function classifyCallRead(call: t.CallExpression | t.OptionalCallExpression, at: NodePath, property: 'name' | 'opaque', analysis: ProgramAnalysis): void {
  if (t.isV8IntrinsicIdentifier(call.callee)) return;
  for (const callee of valueLeaves(call.callee)) {
    if (t.isSuper(callee)) continue;
    // A builtin returns nothing of its own: what it hands back is an argument, an element of one, a member of one.
    if (foreignRoot(callee, at, analysis)) {
      for (const argument of call.arguments) {
        if (t.isExpression(argument)) classifyNameRead(argument, at, property, analysis);
        else if (t.isSpreadElement(argument)) classifyNameRead(argument.argument, at, property, analysis);
      }
      continue;
    }
    if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      const key = memberKey(callee);
      if (key === 'bind' && !t.isSuper(callee.object)) {
        // `f.bind(x).name` is `"bound " + f.name`: the same spelling, read whole.
        classifyNameRead(callee.object, at, property, analysis);
      } else if (key !== null && ELEMENT_RESULTS.has(key) && !t.isSuper(callee.object)) {
        // `list.find(f)`, `list.pop()`: an element of the receiver, proven for an array this file wrote out.
        classifyNameRead(callee.object, at, property, analysis);
        if (property === 'name' && !provenArray(callee.object, at, analysis)) analysis.callResultNameRead = true;
      } else if (property === 'name' && rootedInThisFile(callee, at)) analysis.callResultNameRead = true;
      continue;
    }
    if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) continue;
    if (!t.isIdentifier(callee) || knownFunction(callee.name, at.scope)) continue;
    const binding = at.scope.getBinding(callee.name);
    if (!binding || property !== 'name') continue;
    if (binding.kind === 'param') {
      if (!analysis.rejectionParams.has(binding)) analysis.escapedValueNameRead = true;
    } else analysis.callResultNameRead = true;
  }
}

/** The selector a property or method of a literal or class sits under; null for a computed key nothing resolves. */
function propertySelector(
  property: t.ObjectProperty | t.ObjectMethod | t.ClassProperty | t.ClassMethod,
): Selector {
  const { key } = property;
  if (!property.computed) {
    if (t.isIdentifier(key)) return key.name;
    if (t.isStringLiteral(key)) return key.value;
    if (t.isNumericLiteral(key)) return key.value;
    return null;
  }
  if (t.isStringLiteral(key)) return key.value;
  const index = staticNumber(key);
  return index === undefined ? null : index;
}

/** The local binding a literal initialises or is assigned to, if it is one. */
function literalBinding(literal: NodePath): Binding | undefined {
  const parent = literal.parentPath;
  if (!parent) return undefined;
  const outer = parent.node;
  if (t.isVariableDeclarator(outer) && outer.init === literal.node && t.isIdentifier(outer.id)) {
    return parent.scope.getBinding(outer.id.name);
  }
  if (t.isAssignmentExpression(outer) && outer.operator === '=' && outer.right === literal.node && t.isIdentifier(outer.left)) {
    return parent.scope.getBinding(outer.left.name);
  }
  return undefined;
}

/** The binding a class is known by: its own id, or the variable a class expression initialises. */
function classBinding(cls: NodePath): Binding | undefined {
  if (cls.isClassDeclaration()) {
    const id = cls.node.id;
    return id ? (cls.scope.parent?.getBinding(id.name) ?? cls.scope.getBinding(id.name)) : undefined;
  }
  return literalBinding(cls);
}

/** How many `o[k](...)` sites with `k` unresolved a local's methods are followed to; see `followBinding`. */
const UNRESOLVED_SITES = 64;

/** How many functions a call may resolve to before the argument handed to it is out of sight. */
const RESOLVED_CALLEES = 8;

/**
 * The references of a block-level function's name past its block, which
 * resolve to the Annex B var no scope table lists - or to a binding above
 * the block, where Babel files them. Walked from the var scope, which is
 * where the var lives; a same-named binding nested below it shadows the var
 * inside its own scope, and its references are not the function's.
 */
function annexBReferences(fn: NodePath<t.FunctionDeclaration>, own: Binding, analysis: ProgramAnalysis): NodePath[] {
  const name = fn.node.id!.name;
  const outer = fn.parentPath.scope;
  const varScope = outer.getFunctionParent() ?? outer.getProgramParent();
  const references: NodePath[] = [];
  // Spelled free anywhere, or bound to a same-named binding of the var scope
  // or of one above it, which the var shadows inside its function; a binding
  // below the var scope is a shadow of the var. Read off the tables rather
  // than by walking the scope: the scope is the whole program of a 3 MB
  // file, once per function asked for.
  for (const reference of analysis.freeReferences.get(name) ?? []) {
    if (isWithin(reference.scope, varScope)) references.push(reference);
  }
  for (let scope: Scope | undefined = varScope; scope; scope = scope.parent) {
    const binding = scope.getOwnBinding(name);
    if (!binding || binding === own) continue;
    for (const reference of binding.referencePaths) if (isWithin(reference.scope, varScope)) references.push(reference);
  }
  return references;
}

function isWithin(scope: Scope, ancestor: Scope): boolean {
  for (let current: Scope | undefined = scope; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

/**
 * Whether the binding can be reached by spelling its name, so that its
 * reference list is not the whole of its uses: a name string code can
 * address; a property of the global object this file reads back through
 * the global object, or spells as a string, since `globalThis[k](...)` with
 * `k` any string this file holds calls it (`g.eval('_0xf')` reached `_0xf`
 * exactly that way, with nothing in its reference list); and a block-level
 * function in sloppy code whose name is used past its block, where the use
 * resolves to a var no scope table lists - or to a binding above the block,
 * which Babel then files it under. A local binding is none of these: no
 * string reaches it but string code, and a string that merely spells its
 * name - `'M'` beside a `function M` - is why `isRenameable` refuses it a
 * new spelling, not a way to call it. Read as one, it widened every `.name`
 * read on `lightly-obfuscated.js` from a one-letter helper's parameter.
 */
function reachedByName(binding: Binding, analysis: ProgramAnalysis): boolean {
  const name = binding.identifier.name;
  if (analysis.stringCode.addresses(binding)) return true;
  if (!isGlobalObjectProperty(binding, analysis.programScopeIsGlobal)) return false;
  if (analysis.globalObjectEnumerated || (analysis.globalObjectEscaped && analysis.memberKeys.has(name))) return true;
  return analysis.strings.has(name) || spelledInPart(name, analysis);
}

/**
 * Whether a key read off the global object spells a part of the name - or,
 * with `whole`, the name entire, as one arm of `g[h.K || '_0x1a2b3c']`
 * does; see `resolveGlobalAliases`.
 */
function spelledInPart(name: string, analysis: ProgramAnalysis, whole = false): boolean {
  for (const { text, where } of analysis.globalKeyFragments) {
    if (where === 'whole') {
      if (name === text) return true;
    } else if (whole) continue;
    else if (where === 'prefix' ? name.startsWith(text) : where === 'suffix' ? name.endsWith(text) : name.includes(text)) return true;
  }
  return false;
}

type CallLike = t.CallExpression | t.OptionalCallExpression | t.NewExpression;

/** A position a function is called from; see `holdersOf` and `Flow`. */
type HolderPosition =
  | { kind: 'call'; call: NodePath<CallLike>; offset: number }
  /** Called with an argument list spelled elsewhere: `f.apply(r, [a, b])`, `f.bind(r, a)(b)`; `open` past a bound prefix. */
  | { kind: 'arguments'; call: NodePath; arguments: Array<t.Expression | t.SpreadElement | t.ArgumentPlaceholder>; open?: boolean }
  /**
   * Handed to a method of a holder that runs it with the holder's contents:
   * an array's elements in `elementParams`, what a promise settles to for
   * `then`; `method` null for a key nothing resolves, and `assumed` when
   * the receiver is only taken to be an array.
   */
  | { kind: 'callback'; call: NodePath; receiver: t.Expression; elementParams: readonly number[]; method: string | null; assumed?: boolean };

/**
 * Array methods that call their callback with the receiver's elements, and
 * which of the callback's parameters those land in.
 */
const ELEMENT_CALLBACKS: ReadonlyMap<string, readonly number[]> = new Map([
  ['forEach', [0]],
  ['map', [0]],
  ['filter', [0]],
  ['find', [0]],
  ['findLast', [0]],
  ['findIndex', [0]],
  ['findLastIndex', [0]],
  ['some', [0]],
  ['every', [0]],
  ['flatMap', [0]],
  ['reduce', [1]],
  ['reduceRight', [1]],
  ['sort', [0, 1]],
]);

/**
 * The elements of an array written out in this file, for `f.apply(r, list)`:
 * a literal, or a local initialised with one and never written to again;
 * with no list, nothing. Undefined for an array nobody here can open.
 */
function writtenArray(list: t.Node | undefined, at: NodePath, depth = 0): Array<t.Expression | t.SpreadElement> | undefined {
  if (list === undefined) return [];
  let array: t.Node = list;
  if (t.isIdentifier(list)) {
    const binding = at.scope.getBinding(list.name);
    if (!binding || !binding.path.isVariableDeclarator() || !binding.path.node.init) return undefined;
    if (writesTo(binding).length > 0 || memberStoresOfReferences(binding)) return undefined;
    array = binding.path.node.init;
  }
  if (!t.isArrayExpression(array)) return undefined;
  const elements: Array<t.Expression | t.SpreadElement> = [];
  for (const element of array.elements) {
    if (element === null) return undefined;
    // `[a, ...more]` with `more` written out: its elements in place.
    if (t.isSpreadElement(element)) {
      const spread = depth < 2 ? writtenArray(element.argument, at, depth + 1) : undefined;
      if (!spread) return undefined;
      elements.push(...spread);
    } else elements.push(element);
  }
  return elements;
}

/** Whether any reference of the binding stores into what it holds: `x.push(...)`, `x[i] = ...`, `x.k = ...`. */
function memberStoresOfReferences(binding: Binding): boolean {
  return binding.referencePaths.some((reference) => {
    if (storedThrough(reference).length > 0) return true;
    const member = reference.parentPath;
    if (!member?.isMemberExpression() || member.node.object !== reference.node) return false;
    const store = member.parentPath;
    return store.isAssignmentExpression() && store.node.left === member.node;
  });
}

/** The argument at `index`; undefined past the end, null when a spread hides it. */
function argumentAt(call: CallLike, index: number): t.Expression | null | undefined {
  return argumentIn(call.arguments, index);
}

function argumentIn(list: CallLike['arguments'], index: number): t.Expression | null | undefined {
  for (let i = 0; i <= index; i++) {
    const argument = list[i];
    if (argument === undefined) return undefined;
    if (t.isSpreadElement(argument) || t.isArgumentPlaceholder(argument)) return null;
    if (i === index) return t.isJSXNamespacedName(argument) ? null : argument;
  }
  return undefined;
}

/** `x.k = ...` writes; every other position of a member expression reads it. */
function isPlainAssignmentTarget(path: NodePath): boolean {
  const parent = path.parentPath;
  return (
    parent !== null &&
    parent.isAssignmentExpression({ operator: '=' }) &&
    parent.node.left === path.node
  );
}

/**
 * `const { name } = Animal` is `Animal.name` with no member expression for the
 * visitor above to see; so is `({ name } = Animal)`, and `for (const { name }
 * of list)` is `.name` read off each element.
 *
 * The value being taken apart is found from the pattern's position, and then
 * classified exactly as a member's object would be. A pattern in a parameter
 * list is a `.name` read on a parameter, whatever surrounds it. A pattern
 * nested in another (`const [{ name }] = ...`) reads a component of the value,
 * which is `arr[i].name` in a spelling `storedValues` does not see, and stays
 * uncovered; a `for-in` destructures a string key, which has no `name`; a
 * catch parameter is left as the member visitor leaves it.
 */
function recordPatternReflection(path: NodePath<t.ObjectPattern>, analysis: ProgramAnalysis): void {
  const property = patternReadsName(path.node);
  if (!property) return;
  const parent = path.parentPath;
  if (parent.isVariableDeclarator()) {
    if (parent.node.id !== path.node) return;
    if (parent.node.init) {
      queueNameRead(analysis, parent.node.init, path, property);
      return;
    }
    const loop = parent.parentPath?.parentPath;
    if (loop?.isForOfStatement()) queueNameRead(analysis, loop.node.right, path, property);
    return;
  }
  if (parent.isAssignmentExpression({ operator: '=' }) && parent.node.left === path.node) {
    queueNameRead(analysis, parent.node.right, path, property);
    return;
  }
  if (parent.isForOfStatement() && parent.node.left === path.node) {
    queueNameRead(analysis, parent.node.right, path, property);
    return;
  }
  // A pattern, or a defaulted pattern, directly under a function can only be
  // one of its parameters: read at the call sites, which the walk answers.
  const param = parent.isAssignmentPattern() ? parent : path;
  const owner = param.parentPath;
  if (owner?.isFunction() && typeof param.key === 'number') analysis.paramNameReads.push({ fn: owner, property });
}

/**
 * Whether an object pattern takes a `name` property, however it spells the
 * key - or a key nothing resolves, `const { [k]: n } = C`, which may be it.
 */
function patternReadsName(pattern: t.ObjectPattern): 'name' | 'opaque' | null {
  let opaque = false;
  for (const property of pattern.properties) {
    if (!t.isObjectProperty(property)) continue;
    const key = patternKeyOf(property);
    if (key === 'name') return 'name';
    if (key === null && property.computed && staticNumber(property.key) === undefined) opaque = true;
  }
  return opaque ? 'opaque' : null;
}

/** The property a non-computed or string-keyed member access names. */
function memberKey(node: t.MemberExpression | t.OptionalMemberExpression): string | null {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  // The pipeline normalises `x['name']` to `x.name` before this pass runs; the
  // bracket form only reaches here when the pass is run on its own.
  if (node.computed && t.isStringLiteral(node.property)) return node.property.value;
  return null;
}

/** The expressions `node` can evaluate to, through `||`, `??`, `?:`, `,` and TS casts. */
function valueLeaves(node: t.Expression | t.Super): (t.Expression | t.Super)[] {
  const leaves: (t.Expression | t.Super)[] = [];
  const pending: (t.Expression | t.Super)[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (t.isLogicalExpression(current)) {
      pending.push(current.left, current.right);
    } else if (t.isConditionalExpression(current)) {
      pending.push(current.consequent, current.alternate);
    } else if (t.isSequenceExpression(current)) {
      pending.push(current.expressions[current.expressions.length - 1]!);
    } else if (
      t.isParenthesizedExpression(current) ||
      t.isTSAsExpression(current) ||
      t.isTSSatisfiesExpression(current) ||
      t.isTSNonNullExpression(current) ||
      t.isTSTypeAssertion(current)
    ) {
      pending.push(current.expression);
    } else leaves.push(current);
  }
  return leaves;
}

/** Properties and calls that yield a constructor for any object at all. */
const CONSTRUCTOR_MEMBERS = new Set(['constructor', '__proto__', 'callee', 'caller']);

/**
 * Whether `object` reaches a function or class through the object model, so
 * that its `.name` may be any class or function in the program.
 */
function denotesConstructor(
  object: t.Expression | t.Super,
  at: NodePath,
  analysis: ProgramAnalysis,
): boolean {
  // A member first: it is what nearly every object of an undecoded read is,
  // and each type test here goes through the bundle's re-export getter.
  if (t.isMemberExpression(object) || t.isOptionalMemberExpression(object)) {
    const key = memberKey(object);
    return key !== null && CONSTRUCTOR_MEMBERS.has(key);
  }
  if (t.isThisExpression(object)) return thisIsClass(at, analysis);
  if (t.isSuper(object)) return true;
  // `new.target` is the constructor `new` was applied to: this function, or
  // any class that extends it.
  if (t.isMetaProperty(object)) {
    return object.meta.name === 'new' && object.property.name === 'target';
  }
  if (t.isCallExpression(object) || t.isOptionalCallExpression(object)) {
    // `Object?.getPrototypeOf(x)` parses its callee as an optional member.
    const callee = object.callee;
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false;
    if (!t.isIdentifier(callee.object)) return false;
    if (memberKey(callee) !== 'getPrototypeOf') return false;
    const receiver = callee.object.name;
    return (receiver === 'Object' || receiver === 'Reflect') && !at.scope.getBinding(receiver);
  }
  return false;
}

/**
 * Whether `this` at `at` is the class: a static method, field initialiser or
 * block. The walk starts at `at` itself rather than its parent, because it is
 * asked of a scope's own path, which may itself be the static block.
 *
 * Every node walked over remembers the answer, so the next `this` in the same
 * method stops at its first ancestor already visited. Asked once per `.name`
 * read this was a walk nobody noticed; asked of every `this[k]` whose key is
 * undecoded it was 110 ms of obfuscated4.js, most of it climbing the same
 * methods again.
 */
function thisIsClass(at: NodePath, analysis: ProgramAnalysis): boolean {
  const walked: t.Node[] = [];
  let answer = false;
  for (let path: NodePath | null = at; path; path = path.parentPath) {
    const known = analysis.thisOwners.get(path.node);
    if (known !== undefined) {
      answer = known;
      break;
    }
    walked.push(path.node);
    if (path.isStaticBlock()) {
      answer = true;
      break;
    }
    if (
      path.isClassMethod() ||
      path.isClassPrivateMethod() ||
      path.isClassProperty() ||
      path.isClassPrivateProperty()
    ) {
      answer = path.node.static;
      break;
    }
    // Any other function is its own `this`; an arrow's is its enclosing one.
    if (path.isFunction() && !path.isArrowFunctionExpression()) break;
  }
  for (const node of walked) analysis.thisOwners.set(node, answer);
  return answer;
}

/**
 * A constructor reached through the object model, used as a value.
 *
 * `x.constructor.name` is a read the `.name` arm handles; `classify(x.constructor)`
 * hands the class to a parameter, and if `.name` is read on any parameter it
 * can now be read on this class. The same for `this` in a static method,
 * `new.target`, `arguments.callee` and `Object.getPrototypeOf(x)`. The test is
 * the position, not the shape alone: `x.constructor === Array` compares and
 * lets nothing go, and that comparison is in most real programs.
 *
 * A value that flows into a binding (`var C = x.constructor`) is not counted
 * here; the walk from that binding sees the same expression as a source and
 * `classifyNameRead` reports it.
 */
function recordConstructorEscape(path: NodePath, analysis: ProgramAnalysis): void {
  if (analysis.constructorEscapes) return;
  const node = path.node;
  if (!t.isExpression(node)) return;
  // Cheapest test first. For `this` that is the position - nearly every one
  // is `this.x`, which the parent check rejects before `thisIsClass` has to
  // walk up to the method; for a member or call it is the key, which rejects
  // all but `.constructor` and its kin before the position walk starts.
  if (t.isThisExpression(node)) {
    if (referencePosition(path).escapes && thisIsClass(path, analysis)) analysis.constructorEscapes = true;
    return;
  }
  if (denotesConstructor(node, path, analysis) && referencePosition(path).escapes) {
    analysis.constructorEscapes = true;
  }
}

interface ReferencePosition {
  escapes: boolean;
  /** The binding this position moves the value into, when it is an alias. */
  aliasTo?: Binding;
}

const USES_ONLY: ReferencePosition = { escapes: false };
const ESCAPES: ReferencePosition = { escapes: true };

/**
 * What a reference's position does with the value; see `aliasesOf` and `resultUsed`.
 *
 * Walks outwards through the wrappers that pass a value along unchanged -
 * parentheses, casts, the arms of `?:`, `||`, `??`, `&&`, the last expression
 * of a `,` - and answers for the position the wrapper sits in. Anything not
 * listed escapes: the list is of positions known to keep the value, and a
 * new syntax is unsafe until it is on it.
 */
function referencePosition(reference: NodePath): ReferencePosition {
  let path = reference;
  for (;;) {
    const parent = path.parentPath;
    if (!parent) return ESCAPES;
    const node = path.node;
    const outer = parent.node;

    if (t.isCallExpression(outer) || t.isOptionalCallExpression(outer) || t.isNewExpression(outer)) {
      if (outer.callee === node) return USES_ONLY;
      return knownCalleeParameter(parent, node) ?? ESCAPES;
    }
    if (t.isTaggedTemplateExpression(outer)) return outer.tag === node ? USES_ONLY : ESCAPES;
    if (t.isMemberExpression(outer) || t.isOptionalMemberExpression(outer)) {
      if (outer.object !== node) return USES_ONLY;
      return memberKey(outer) === 'bind' ? ESCAPES : USES_ONLY;
    }
    if (t.isUnaryExpression(outer) || t.isUpdateExpression(outer) || t.isBinaryExpression(outer)) {
      return USES_ONLY;
    }
    if (
      t.isIfStatement(outer) ||
      t.isWhileStatement(outer) ||
      t.isDoWhileStatement(outer) ||
      t.isForStatement(outer) ||
      t.isSwitchStatement(outer) ||
      t.isSwitchCase(outer) ||
      t.isExpressionStatement(outer)
    ) {
      // A `for` uses its init and update for effect and its test for truth;
      // a `switch` and its cases compare. None of them keeps the value.
      return USES_ONLY;
    }
    if (t.isForInStatement(outer)) return outer.right === node ? USES_ONLY : ESCAPES;
    if (t.isConditionalExpression(outer)) {
      if (outer.test === node) return USES_ONLY;
      path = parent;
      continue;
    }
    if (t.isLogicalExpression(outer) || t.isParenthesizedExpression(outer)) {
      path = parent;
      continue;
    }
    if (t.isSequenceExpression(outer)) {
      if (outer.expressions[outer.expressions.length - 1] !== node) return USES_ONLY;
      path = parent;
      continue;
    }
    if (
      t.isTSAsExpression(outer) ||
      t.isTSSatisfiesExpression(outer) ||
      t.isTSNonNullExpression(outer) ||
      t.isTSTypeAssertion(outer)
    ) {
      path = parent;
      continue;
    }
    if (t.isVariableDeclarator(outer)) {
      if (outer.init !== node) return USES_ONLY;
      // A pattern takes the value apart; the whole is kept nowhere.
      if (!t.isIdentifier(outer.id)) return USES_ONLY;
      return aliasTo(parent.scope.getBinding(outer.id.name));
    }
    if (t.isAssignmentExpression(outer)) {
      if (outer.right !== node) return USES_ONLY;
      if (t.isIdentifier(outer.left)) {
        // A name this file does not bind is a global, and a store to a global
        // is the value let go of.
        const target = parent.scope.getBinding(outer.left.name);
        return target ? aliasTo(target) : ESCAPES;
      }
      return t.isPattern(outer.left) ? USES_ONLY : ESCAPES;
    }
    return ESCAPES;
  }
}

function aliasTo(binding: Binding | undefined): ReferencePosition {
  return binding ? { escapes: false, aliasTo: binding } : ESCAPES;
}

/**
 * Whether the binding is the own name of a function or class expression, so
 * that its path *is* the value and sits in a position of its own: Babel
 * registers `function f() {}` as a `local` binding of `f` inside `f`, with
 * the expression as the binding's path.
 */
function namesOwnExpression(binding: Binding): boolean {
  const declaration = binding.path;
  return (
    (declaration.isFunctionExpression() || declaration.isClassExpression()) &&
    declaration.node.id === binding.identifier
  );
}

/**
 * `(function (p) { ... })(f)` and `g(f)` where `g` is a function this file can
 * see whole: the argument flows into the parameter and nowhere else. Only a
 * plain identifier parameter at the argument's own index, with nothing spread
 * before it to shift the count, and only a callee that is a function literal
 * or a binding that is never reassigned - `g = other; g(f)` calls something
 * else.
 */
function knownCalleeParameter(call: NodePath, argument: t.Node): ReferencePosition | undefined {
  const outer = call.node;
  if (!t.isCallExpression(outer) && !t.isOptionalCallExpression(outer) && !t.isNewExpression(outer)) {
    return undefined;
  }
  const index = outer.arguments.indexOf(argument as t.Expression);
  if (index < 0) return undefined;
  for (let i = 0; i <= index; i++) if (t.isSpreadElement(outer.arguments[i])) return undefined;

  const callee = knownCallee(call);
  if (!callee) return undefined;
  const param = callee.node.params[index];
  if (!t.isIdentifier(param)) return undefined;
  const target = callee.scope.getOwnBinding(param.name);
  return target ? { escapes: false, aliasTo: target } : undefined;
}

/** The function a call's callee is, when the callee is a literal or a fixed binding to one. */
function knownCallee(call: NodePath): NodePath<t.Function> | undefined {
  const calleePath = call.get('callee');
  if (Array.isArray(calleePath)) return undefined;
  if (calleePath.isFunctionExpression() || calleePath.isArrowFunctionExpression()) return calleePath;
  return calleePath.isIdentifier() ? knownFunction(calleePath.node.name, calleePath.scope) : undefined;
}

/** The function a name is a fixed binding to, from `scope`; see `knownCallee`. */
function knownFunction(name: string, scope: Scope): NodePath<t.Function> | undefined {
  const binding = scope.getBinding(name);
  if (!binding || writesTo(binding).length > 0) return undefined;
  const declaration = binding.path;
  if (declaration.isFunctionDeclaration()) return declaration;
  if (!declaration.isVariableDeclarator()) return undefined;
  const init = declaration.get('init');
  return init.isFunctionExpression() || init.isArrowFunctionExpression() ? init : undefined;
}

/** The `Promise` combinators, whose promise settles to what their arguments' promises settle to. */
const PROMISE_COMBINATORS: ReadonlySet<string> = new Set(['all', 'race', 'any', 'allSettled', 'resolve']);

/**
 * Whether the call is `Promise.all(...)` or a sibling, spelled by the free
 * name - outright, or through `.call`, whose receiver is then among the
 * arguments and is skipped there as any foreign value is.
 */
function settlesToArguments(call: t.CallExpression | t.OptionalCallExpression, at: NodePath): boolean {
  let { callee } = call;
  if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && memberKey(callee) === 'call') callee = callee.object;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false;
  if (!t.isIdentifier(callee.object, { name: 'Promise' }) || at.scope.getBinding('Promise')) return false;
  const key = memberKey(callee);
  return key !== null && PROMISE_COMBINATORS.has(key);
}

/** Array methods whose result is an element of the receiver. */
const ELEMENT_RESULTS: ReadonlySet<string> = new Set(['find', 'findLast', 'pop', 'shift', 'at']);

/** Array methods whose result holds elements of the receiver. */
const SUBSET_RESULTS: ReadonlySet<string> = new Set([
  'filter',
  'slice',
  'concat',
  'reverse',
  'sort',
  'flat',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
  'values',
]);

/**
 * Whether an expression is an array this file wrote out: a literal, or a
 * local whose every source is one and whose members are only ever stored
 * to by element - so that `.find`, `.filter` and the rest are the array's
 * own methods, and what they hand back is among its elements.
 */
function provenArray(node: t.Expression | t.Super, at: NodePath, analysis: ProgramAnalysis): boolean {
  const seen = new Set<Binding>();
  const pending: Array<{ node: t.Expression | t.Super; at: NodePath }> = [{ node, at }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const leaf of valueLeaves(current.node)) {
      if (t.isArrayExpression(leaf)) continue;
      if (!t.isIdentifier(leaf)) return false;
      const binding = current.at.scope.getBinding(leaf.name);
      if (!binding || binding.kind === 'param' || seen.has(binding)) return false;
      seen.add(binding);
      const sources = sourcesOf(binding, analysis);
      if (sources.length === 0) return false;
      for (const source of sources) {
        if (source.elements) return false;
        pending.push({ node: source.node, at: source.at });
      }
      for (const store of memberStoresOf(binding, analysis)) if (!store.element) return false;
    }
  }
  return true;
}

/**
 * Whether a callee's leftmost object is a value of this file's - a binding,
 * `this`, an object or array written out - rather than a free name or a
 * literal, whose methods return nothing of ours.
 */
function rootedInThisFile(callee: t.Node, at: NodePath): boolean {
  let root: t.Node = callee;
  for (;;) {
    if (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) root = root.object;
    else if (t.isCallExpression(root) || t.isOptionalCallExpression(root) || t.isNewExpression(root)) root = root.callee;
    else if (
      t.isParenthesizedExpression(root) ||
      t.isTSNonNullExpression(root) ||
      t.isTSAsExpression(root) ||
      t.isTSSatisfiesExpression(root) ||
      t.isTSTypeAssertion(root)
    ) {
      root = root.expression;
    } else if (t.isAwaitExpression(root)) root = root.argument;
    else break;
  }
  if (t.isIdentifier(root)) return at.scope.getBinding(root.name) !== undefined;
  if (t.isThisExpression(root) || t.isObjectExpression(root) || t.isArrayExpression(root)) return true;
  return t.isFunction(root) || t.isClass(root);
}

/**
 * The path of a function the walk holds only as a node: a callee spelled as
 * a literal, `(function () { ... })()`. Every path exists already, since the
 * whole tree was traversed before any read is resolved, and Babel hands back
 * the same object for the same node; it is looked for from `near` outwards,
 * so the subtree walked is usually the member expression the read sits in.
 */
function functionPathOf(
  node: t.Function,
  near: NodePath,
  analysis: ProgramAnalysis,
): NodePath<t.Function> | undefined {
  const known = analysis.functionPaths.get(node);
  if (known) return known;
  let found: NodePath<t.Function> | undefined;
  let searched: t.Node | undefined;
  for (let root: NodePath | null = near; root && !found; root = root.parentPath) {
    if (root.node === node) {
      found = root as NodePath<t.Function>;
      break;
    }
    root.traverse({
      enter(path) {
        // The subtree the round before this one searched.
        if (path.node === searched) path.skip();
      },
      Function(path) {
        if (path.node !== node) return;
        found = path;
        path.stop();
      },
    });
    searched = root.node;
  }
  if (found) analysis.functionPaths.set(node, found);
  return found;
}

/** The expressions a function can return: its `return` arguments, or an arrow's expression body. */
function returnedValues(fn: NodePath<t.Function>): t.Expression[] {
  const body = fn.node.body;
  if (t.isExpression(body)) return [body];
  const returned: t.Expression[] = [];
  for (const node of ownStatements(body)) {
    if (t.isReturnStatement(node) && node.argument) returned.push(node.argument);
  }
  return returned;
}

/** Every node of a function body that runs as that function's own; a nested function's or class's are its own. */
function* ownStatements(body: t.Node): Generator<t.Node> {
  const pending: t.Node[] = [body];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (t.isFunction(node) || t.isClass(node)) continue;
    yield node;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, t.Node | t.Node[] | null | undefined>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item) pending.push(item);
      } else if (child) {
        pending.push(child);
      }
    }
  }
}

/** Assignments whose anonymous right-hand side takes the left-hand name. */
const NAMING_ASSIGNMENTS: ReadonlySet<string> = new Set(['=', '||=', '&&=', '??=']);

/** Array methods that store their arguments, and the index the stored ones start at. */
const ARRAY_STORES: ReadonlyMap<string, number> = new Map([
  ['push', 0],
  ['unshift', 0],
  ['fill', 0],
  ['splice', 2],
]);

/**
 * The values a reference stores *into* the thing it names: the arguments of
 * `x.push(...)`, the right side of `x[i] = ...`. A dotted store (`x.k = f`) is
 * not included: a `for-of` does not reach it, and `x.k.name` is read by key
 * in `selectFrom`.
 */
function storedThrough(reference: NodePath): t.Expression[] {
  const member = reference.parent;
  if (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) return [];
  if (member.object !== reference.node) return [];
  const outer = reference.parentPath?.parent;
  if ((t.isCallExpression(outer) || t.isOptionalCallExpression(outer)) && outer.callee === member) {
    const key = memberKey(member);
    // `s.add(f)`: an element; `m.set(k, f)`: iterated as the pair `[k, f]`,
    // handed to `forEach` and `values` as `f` - both are kept, so that each
    // reading finds its own and the other pins a name that is read anyway.
    if (key === 'add' && t.isExpression(outer.arguments[0])) return [outer.arguments[0]];
    if (key === 'set' && outer.arguments.length >= 2 && t.isExpression(outer.arguments[0]) && t.isExpression(outer.arguments[1])) {
      return [outer.arguments[1], t.arrayExpression([outer.arguments[0], outer.arguments[1]])];
    }
    const from = key === null ? undefined : ARRAY_STORES.get(key);
    if (from === undefined) return [];
    const stored: t.Expression[] = [];
    for (const argument of outer.arguments.slice(from)) {
      if (t.isSpreadElement(argument)) stored.push(argument.argument);
      else if (t.isExpression(argument)) stored.push(argument);
    }
    return stored;
  }
  if (
    member.computed &&
    t.isAssignmentExpression(outer) &&
    outer.left === member &&
    NAMING_ASSIGNMENTS.has(outer.operator)
  ) {
    return [outer.right];
  }
  return [];
}

/** The expression under the wrappers named evaluation looks through. */
function unwrapTransparent(node: t.Expression): t.Expression {
  let current = node;
  while (
    t.isParenthesizedExpression(current) ||
    t.isTSAsExpression(current) ||
    t.isTSSatisfiesExpression(current) ||
    t.isTSNonNullExpression(current) ||
    t.isTSTypeAssertion(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The default `target` takes inside `pattern`, if it has one. */
function defaultValueOf(pattern: t.Node | null | undefined, target: t.Identifier): t.Expression | undefined {
  if (!pattern) return undefined;
  if (t.isAssignmentPattern(pattern)) {
    return pattern.left === target ? pattern.right : defaultValueOf(pattern.left, target);
  }
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      const found = defaultValueOf(t.isRestElement(property) ? property.argument : property.value, target);
      if (found) return found;
    }
    return undefined;
  }
  if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      const found = defaultValueOf(element, target);
      if (found) return found;
    }
    return undefined;
  }
  if (t.isRestElement(pattern)) return defaultValueOf(pattern.argument, target);
  return undefined;
}

/**
 * Where this file reads a name it never binds - another `<script>`'s variable,
 * a host global, a bundler injection.
 *
 * `Scope.hasBinding` cannot answer this: its non-binding fallback is a fixed
 * list of ES builtins, so `document`, `storage`, `require`, `process` and every
 * application global read as unbound to it, and a rename onto one of those
 * names looks legal. Recording the scope chain above each free reference turns
 * the question into a set lookup: rebinding a name inside a scope that contains
 * a free read of it captures the read, and only then.
 *
 * `eval` used to get a second look here, because this was the only visitor that
 * saw it in a non-callee position, and it was the whole of what carried two
 * shapes: `var e = eval; e(src)`, and - accidentally - `eval?.(src)`, whose
 * callee is a bare `eval` that the direct-eval test standing here rejected,
 * because an `OptionalCallExpression` is not a `CallExpression`. Both are now
 * the shared fact's, which covers them from the other end and covers them
 * better: `scanRaw`'s `aliasedEval` finds the alias without needing `program.scope` to
 * be crawled, the optional call is *classified* rather than caught by the
 * spelling of its callee, and its source is read, so a readable one no longer
 * has to freeze every program-scope name. It also stops agreeing with this
 * function about `new eval(src)`, where the fact is right and this function was not:
 * `eval` is not a constructor, so that call throws before it compiles anything
 * and freezes nothing.
 *
 * That leaves this function doing one job, which is the job its name describes.
 */
function recordFreeIdentifier(
  path: NodePath<t.Identifier | t.JSXIdentifier>,
  analysis: ProgramAnalysis,
): void {
  const name = path.node.name;
  if (!analysis.freeNames.has(name)) return;
  // `map = 1`, `map++`: a write creates the global as surely as a read finds it.
  const written = (path.parentPath?.isAssignmentExpression() && path.parentPath.node.left === path.node) || path.parentPath?.isUpdateExpression();
  if (!path.isReferencedIdentifier() && !written) return;
  // The same name can be free at one reference and bound at another.
  if (path.scope.hasBinding(name, { noGlobals: true })) return;
  if (!path.isIdentifier()) return;
  const references = analysis.freeReferences.get(name);
  if (references) references.push(path);
  else analysis.freeReferences.set(name, [path]);
  if (GLOBAL_OBJECT_NAMES.has(name)) {
    analysis.globalSpellings.push({ path, kind: name === 'exports' || name === 'module' ? 'export' : 'global' });
  } else if (name === 'Function' || name === 'eval') {
    // `Function('return this')()` and `eval('this')` hand back the global
    // object from code this pass does not read; what a compiled source
    // returns is taken to be it.
    const call = path.parentPath;
    if (!call || !(call.isCallExpression() || call.isNewExpression()) || call.node.callee !== path.node) return;
    if (name === 'eval') {
      analysis.globalSpellings.push({ path: call, kind: 'global' });
      return;
    }
    const result = call.parentPath;
    if (result?.isCallExpression() && result.node.callee === call.node) {
      analysis.globalSpellings.push({ path: result, kind: 'global' });
    }
  }

  let scopes = analysis.freeGlobalScopes.get(name);
  if (!scopes) {
    scopes = new Set();
    analysis.freeGlobalScopes.set(name, scopes);
  }
  let scope: Scope | undefined = path.scope;
  // Once a scope is recorded so is every scope above it, so the walk can stop.
  while (scope && !scopes.has(scope.uid)) {
    scopes.add(scope.uid);
    scope = scope.parent;
  }
}

/**
 * A spelling of the global object: a global name read free, or a `this`
 * that is or may be it. `exports` and `module` are spelled the same for the
 * publishing rule's sake (`escapesToGlobal`) and are not the global object,
 * so they alias and are read through but never trip the backstop.
 */
interface GlobalSpelling {
  path: NodePath;
  kind: 'global' | 'export' | 'maybe';
}

function recordThisSpelling(path: NodePath<t.ThisExpression>, analysis: ProgramAnalysis): void {
  const owner = thisOwner(path, analysis).kind;
  if (owner === 'global') analysis.globalSpellings.push({ path, kind: 'global' });
  else if (owner === 'maybeGlobal') analysis.globalSpellings.push({ path, kind: 'maybe' });
}

/**
 * Whether a `this` the call site chooses is certainly the global object
 * somewhere: its sloppy function is called plainly - `f()`, `(function () {
 * ... })()` - at some holder, where `this` is the global object. A function
 * only ever `new`ed or called as a method keeps the benefit of the doubt.
 */
function plainlyCalled(at: NodePath, analysis: ProgramAnalysis, memo: Map<t.Node, boolean>): boolean {
  const fn = at.getFunctionParent();
  let owner: NodePath<t.Function> | null = fn;
  while (owner && owner.isArrowFunctionExpression()) owner = owner.getFunctionParent();
  if (!owner) return false;
  const known = memo.get(owner.node);
  if (known !== undefined) return known;
  // `f()`, not `o.f()`: a method call binds `this` to its receiver.
  const answer = holdersOf(owner, analysis).holders.some((segment) =>
    segment.some(({ position }) => {
      if (position.kind !== 'call' || position.offset !== 0 || t.isNewExpression(position.call.node)) return false;
      const { callee } = position.call.node;
      return !t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee);
    }),
  );
  memo.set(owner.node, answer);
  return answer;
}

/** Methods that answer whether the receiver has a property, by its name. */
const PROPERTY_PROBES: ReadonlySet<string> = new Set(['hasOwnProperty', 'propertyIsEnumerable']);

/** How many bindings a key expression is followed through for its strings. */
const FRAGMENT_DEPTH = 8;

/** How many spellings a key is followed to whole before it is read as spelled in part only. */
const KEY_SPELLINGS = 16;

/** Where a fragment sits in the key it is a part of; see `keyStrings`. */
type FragmentPlace = 'prefix' | 'suffix' | 'inner' | 'whole';

/** A string spelled inside a key nothing resolves whole, and where in the key it sits. */
interface KeyFragment {
  text: string;
  where: FragmentPlace;
}

/** The strings a key expression spells: whole, and in parts; see `keyStrings`. */
interface KeyStrings {
  /** Every string the key spells whole, at most `KEY_SPELLINGS` of them. */
  whole: string[];
  /** False where some part, or some arm, is no literal: `dec(0)`, the `g.K` of `g.K || 'm'`. */
  complete: boolean;
  /** Every string spelled inside the key, with its place. */
  parts: KeyFragment[];
}

const NOTHING_SPELLED: KeyStrings = { whole: [], complete: false, parts: [] };

/** The string methods that map a key's spellings one to one, each on the whole and on every part. */
const STRING_MAPS: ReadonlyMap<string, (text: string, args: (string | number)[]) => string> = new Map([
  ['toString', (text) => text],
  ['valueOf', (text) => text],
  ['trim', (text) => text.trim()],
  ['trimStart', (text) => text.trimStart()],
  ['trimEnd', (text) => text.trimEnd()],
  ['toLowerCase', (text) => text.toLowerCase()],
  ['toUpperCase', (text) => text.toUpperCase()],
  ['slice', (text, [from, to]) => text.slice(from as number, to as number | undefined)],
  ['substring', (text, [from, to]) => text.substring(from as number, to as number | undefined)],
  ['substr', (text, [from, length]) => text.substr(from as number, length as number | undefined)],
]);

/** Free functions that decode a literal to a string, computed here as the engine would. */
const STRING_DECODERS: ReadonlyMap<string, (text: string) => string> = new Map([
  ['decodeURIComponent', decodeURIComponent],
  ['decodeURI', decodeURI],
  ['unescape', unescape],
  ['atob', (text) => atob(text)],
]);

/**
 * Every string a key expression spells - whole, and in parts with where
 * each sits - in one reading: a literal; a template, tagged by `String.raw`
 * or not; a `+` of parts; `.concat`, `String.prototype.concat.call`, an
 * array literal's `.join` (reversed or not); a string method that maps the
 * text - `trim`, `toLowerCase`, `slice`, `toString`; a free decoder of a
 * literal - `decodeURIComponent('%5F...')`, `String.fromCharCode(95)`; the
 * arms of `||`, `??` and `?:`; a local initialised with any of those and
 * appended to by `+=`; a member opened one step (`memberSpellings`); what a
 * function in sight returns; a class's static field and a literal's getter
 * through the member. A part no literal stands in for - `dec(0x1c32)`,
 * `arguments[0]`, the `g.K` of `g.K || 'm'` - spells nothing whole, and
 * says so: `complete` with one spelling is the key resolved; more than one,
 * or one beside a part out of sight, the names the key may be, each pinned
 * whole, and the parts pinned by their place.
 *
 * The place is what keeps the parts from freezing everything: an
 * obfuscator.io proxy map holds `dec(0x5411, '@m8w') + 'n'` for every host
 * name it spells in pieces, and read as a bare fragment the `'n'` would pin
 * every top-level name with an `n` in it; as a suffix it pins the names
 * that end in one. A member met on the way under a key nothing resolves
 * selects any of the holder's values, and only one spelled whole is a name
 * the key may be: the same proxy map read as `cfg[dec(0x816) + 'h']` is a
 * thousand such values, and their pieces read as fragments pinned `_0x4a68`
 * in obfuscated2.js for a `'8'` some unrelated entry ends in.
 */
function keyStrings(
  node: t.Node,
  scope: Scope,
  analysis: ProgramAnalysis,
  seen = new Set<Binding>(),
  depth = 0,
  where: FragmentPlace = 'whole',
  frames: readonly KeyFrame[] = [],
): KeyStrings {
  const at = (own: FragmentPlace): FragmentPlace => {
    if (where === 'whole') return own;
    if (own === 'whole') return where;
    return own === where ? own : 'inner';
  };
  const literal = (text: string): KeyStrings => ({ whole: [text], complete: true, parts: text === '' ? [] : [{ text, where }] });
  const spelled = (whole: string[], complete: boolean, parts: KeyFragment[]): KeyStrings => (whole.length > KEY_SPELLINGS ? { whole: [], complete: false, parts } : { whole, complete, parts });
  const cross = (left: KeyStrings, right: KeyStrings): KeyStrings => {
    const whole: string[] = [];
    for (const head of left.whole) for (const tail of right.whole) whole.push(head + tail);
    return spelled(whole, left.complete && right.complete, [...left.parts, ...right.parts]);
  };
  const either = (left: KeyStrings, right: KeyStrings): KeyStrings => spelled([...new Set([...left.whole, ...right.whole])], left.complete && right.complete, [...left.parts, ...right.parts]);
  const recurse = (part: t.Node, place: FragmentPlace = where, deeper = 0, from: Scope = scope, inside: readonly KeyFrame[] = frames): KeyStrings =>
    keyStrings(part, from, analysis, seen, depth + deeper, place, inside);
  /** The argument handed to parameter `index` of `fn`: by the call being read through, or the one it is called in place by. */
  const handedTo = (fn: NodePath<t.Function>, index: number | undefined): { node: t.Expression; scope: Scope } | undefined => {
    if (index === undefined) return undefined;
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]!;
      if (frame.fn !== fn) continue;
      const argument = frame.args[index];
      return argument && t.isExpression(argument) ? { node: argument, scope: frame.scope } : undefined;
    }
    return argumentInPlace(fn, index);
  };
  /** What a parameter spelled here was handed, when its function is one being read through or called in place. */
  const parameterValue = (name: string): { node: t.Expression; scope: Scope } | undefined => {
    const binding = scope.getBinding(name);
    if (!binding || binding.kind !== 'param' || writesTo(binding).length > 0) return undefined;
    const owner = paramOwner(binding);
    return owner && t.isIdentifier(owner.fn.node.params[owner.index]) ? handedTo(owner.fn, owner.index) : undefined;
  };
  /** The operands of a concatenation in order, each placed by its position; a separator between them. */
  const chain = (parts: t.Node[], separator?: KeyStrings): KeyStrings => {
    let result = literal('');
    parts.forEach((part, index) => {
      const own: FragmentPlace = parts.length === 1 ? 'whole' : index === 0 ? 'prefix' : index === parts.length - 1 ? 'suffix' : 'inner';
      if (index > 0 && separator) result = cross(result, separator);
      result = cross(result, recurse(part, separator && separator.whole[0] !== '' ? 'inner' : at(own)));
    });
    return result;
  };
  const map = (inner: KeyStrings, transform: (text: string) => string): KeyStrings => {
    try {
      return spelled(inner.whole.map(transform), inner.complete, inner.parts.map((part) => ({ text: transform(part.text), where: part.where })).filter((part) => part.text !== ''));
    } catch {
      return NOTHING_SPELLED;
    }
  };
  const literalArguments = (args: t.Node[]): (string | number)[] | undefined => {
    const values: (string | number)[] = [];
    for (const argument of args) {
      if (t.isStringLiteral(argument)) values.push(argument.value);
      else if (t.isNumericLiteral(argument)) values.push(argument.value);
      else {
        const number = staticNumber(argument);
        if (number === undefined) return undefined;
        values.push(number);
      }
    }
    return values;
  };
  const free = (name: string): boolean => !scope.getBinding(name);

  if (t.isStringLiteral(node)) return literal(node.value);
  if (t.isTemplateLiteral(node)) return chain(templateParts(node));
  if (t.isTaggedTemplateExpression(node)) {
    const { tag } = node;
    if (!t.isMemberExpression(tag) || !t.isIdentifier(tag.object, { name: 'String' }) || memberKey(tag) !== 'raw' || !free('String')) return NOTHING_SPELLED;
    return chain(templateParts(node.quasi, true));
  }
  if (t.isBinaryExpression(node)) {
    if (node.operator !== '+') return NOTHING_SPELLED;
    const parts: t.Node[] = [];
    const flatten = (part: t.Node): void => {
      if (t.isBinaryExpression(part) && part.operator === '+') {
        flatten(part.left);
        flatten(part.right);
      } else parts.push(part);
    };
    flatten(node);
    return chain(parts);
  }
  if (t.isLogicalExpression(node)) return either(recurse(node.left), recurse(node.right));
  if (t.isConditionalExpression(node)) return either(recurse(node.consequent), recurse(node.alternate));
  if (t.isSequenceExpression(node)) {
    const last = node.expressions[node.expressions.length - 1];
    return last ? recurse(last) : NOTHING_SPELLED;
  }
  if (t.isParenthesizedExpression(node) || t.isTSAsExpression(node) || t.isTSNonNullExpression(node)) return recurse(node.expression);
  if (t.isAssignmentExpression(node)) {
    // `g[k += '2b3c']`: what the assignment leaves in `k`, which is what it spells here.
    if (node.operator === '=' || NAMING_ASSIGNMENTS.has(node.operator)) return recurse(node.right);
    if (node.operator === '+=') return chain([node.left, node.right]);
    return NOTHING_SPELLED;
  }
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const { callee } = node;
    const args = node.arguments;
    if (args.some((argument) => t.isSpreadElement(argument))) return NOTHING_SPELLED;
    let fn: NodePath<t.Function> | undefined;
    if (t.isIdentifier(callee)) {
      if (callee.name === 'String' && free('String') && args[0]) return recurse(args[0]);
      const decoder = STRING_DECODERS.get(callee.name);
      if (decoder && free(callee.name) && args.length === 1 && args[0]) return map(recurse(args[0]), decoder);
      // `g[key()]` with `key` a function in sight: what it returns.
      fn = knownFunction(callee.name, scope);
    } else if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
      fn = analysis.functionPaths.get(callee);
    }
    if (fn) {
      if (depth >= FRAGMENT_DEPTH) return NOTHING_SPELLED;
      const inside = [...frames, { fn, args, scope }];
      let returned: KeyStrings = { whole: [], complete: true, parts: [] };
      for (const value of returnedValues(fn)) returned = either(returned, recurse(value, where, 1, fn.scope, inside));
      return returned.whole.length === 0 && returned.parts.length === 0 ? NOTHING_SPELLED : returned;
    }
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return NOTHING_SPELLED;
    const method = memberKey(callee);
    const receiver = callee.object;
    if (t.isIdentifier(receiver, { name: 'String' }) && free('String') && method === 'fromCharCode') {
      const codes = literalArguments(args);
      return codes && codes.every((code) => typeof code === 'number') ? literal(String.fromCharCode(...(codes as number[]))) : NOTHING_SPELLED;
    }
    // `String.prototype.concat.call(a, b)`, `''.concat.call(a, b)`: `a.concat(b)`.
    if (method === 'call' && t.isMemberExpression(receiver) && memberKey(receiver) === 'concat' && args[0]) {
      return chain(args as t.Node[]);
    }
    if (t.isSuper(receiver)) return NOTHING_SPELLED;
    if (method === 'concat') return chain([receiver, ...args]);
    if (method === 'join') {
      const elements = arrayElements(receiver);
      if (!elements || args.length > 1) return NOTHING_SPELLED;
      const separator = args[0] ? recurse(args[0], 'inner') : literal(',');
      return chain(elements, separator);
    }
    const transform = method === null ? undefined : STRING_MAPS.get(method);
    if (transform) {
      const values = literalArguments(args);
      return values ? map(recurse(receiver), (text) => transform(text, values)) : NOTHING_SPELLED;
    }
    return NOTHING_SPELLED;
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (depth >= FRAGMENT_DEPTH) return NOTHING_SPELLED;
    // `arguments[0]` inside a function read through or called in place: the call's own argument.
    const own = t.isIdentifier(node.object, { name: 'arguments' }) && !scope.getBinding('arguments') ? functionOfScope(scope) : undefined;
    const handed = own ? handedTo(own, staticNumber(node.property)) : undefined;
    if (handed) return recurse(handed.node, where, 1, handed.scope);
    let selector = memberSelector(node);
    // `t[i]` with `i` a parameter handed a literal: that element.
    if (selector === null && node.computed && t.isIdentifier(node.property)) {
      const index = parameterValue(node.property.name);
      if (index) selector = argumentSelector(index.node);
    }
    // `['ma', 'p'][1]`: an element of an array written in place.
    if (t.isArrayExpression(node.object)) {
      if (typeof selector !== 'number') return NOTHING_SPELLED;
      const element = node.object.elements[selector];
      return element && !t.isSpreadElement(element) ? recurse(element) : NOTHING_SPELLED;
    }
    let found: KeyStrings = { whole: [], complete: selector !== null, parts: [] };
    for (const { node: value, at: source } of memberSpellings(node, scope, analysis, selector)) {
      const inner = recurse(value, where, 1, source.scope);
      // Under a key nothing resolves, any of the holder's values: only one spelled whole is a name the key may be.
      found = selector !== null ? either(found, inner) : spelled([], false, [...found.parts, ...inner.whole.map((text) => ({ text, where: 'whole' as const }))]);
    }
    return found.whole.length === 0 && found.parts.length === 0 ? NOTHING_SPELLED : found;
  }
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name);
    if (!binding || seen.has(binding) || depth >= FRAGMENT_DEPTH) return NOTHING_SPELLED;
    if (binding.kind === 'param') {
      // A parameter of a function read through or called in place: the call's argument at its index.
      const handed = parameterValue(node.name);
      return handed ? recurse(handed.node, where, 1, handed.scope) : NOTHING_SPELLED;
    }
    if (!binding.path.isVariableDeclarator()) return NOTHING_SPELLED;
    // `k += '...'` appends to whatever was there, which is then a prefix; any other write spells what nothing here composes.
    const appended: NodePath[] = [];
    for (const write of writesTo(binding)) {
      const assignment = write.node;
      if (!t.isAssignmentExpression(assignment) || !t.isIdentifier(assignment.left)) return NOTHING_SPELLED;
      if (assignment.operator === '+=') appended.push(write);
      else if (!NAMING_ASSIGNMENTS.has(assignment.operator)) return NOTHING_SPELLED;
    }
    // Along the path only: `k + k` spells `k` twice.
    seen.add(binding);
    let result: KeyStrings = { whole: [], complete: true, parts: [] };
    const placed = appended.length > 0 ? at('prefix') : where;
    for (const source of sourcesOf(binding, analysis)) {
      result = source.elements ? NOTHING_SPELLED : either(result, recurse(source.node, placed, 1, source.at.scope));
    }
    for (const write of appended) {
      const assignment = write.node as t.AssignmentExpression;
      result = cross(result, recurse(assignment.right, at('suffix'), 1, write.scope));
    }
    seen.delete(binding);
    return result.whole.length === 0 && result.parts.length === 0 ? NOTHING_SPELLED : result;
  }
  return NOTHING_SPELLED;
}

/** A call `keyStrings` reads a function's returns through: the function, the call's arguments, and the scope they are spelled in. */
interface KeyFrame {
  fn: NodePath<t.Function>;
  args: readonly t.Node[];
  scope: Scope;
}

/** The argument at `index` of the call `fn` is called in place by - `(function (a) { ... })(x)` - with the scope it resolves in. */
function argumentInPlace(fn: NodePath<t.Function>, index: number): { node: t.Expression; scope: Scope } | undefined {
  const call = fn.parentPath;
  if (!call?.isCallExpression() || call.node.callee !== fn.node) return undefined;
  const argument = call.node.arguments[index];
  if (!argument || !t.isExpression(argument) || call.node.arguments.slice(0, index).some((each) => t.isSpreadElement(each))) return undefined;
  return { node: argument, scope: call.scope };
}

/** The function whose `arguments` a scope reads: the nearest one that is no arrow. */
function functionOfScope(scope: Scope): NodePath<t.Function> | undefined {
  let fn: NodePath | null = scope.path;
  while (fn && !(fn.isFunction() && !fn.isArrowFunctionExpression())) fn = fn.parentPath;
  return fn?.isFunction() ? fn : undefined;
}

/** A template's quasis and expressions in order, the quasis as string literals; raw text for `String.raw`. */
function templateParts(template: t.TemplateLiteral, raw = false): t.Node[] {
  const parts: t.Node[] = [];
  template.quasis.forEach((quasi, index) => {
    const text = raw ? quasi.value.raw : (quasi.value.cooked ?? quasi.value.raw);
    if (text !== '') parts.push(t.stringLiteral(text));
    const expression = template.expressions[index];
    if (expression) parts.push(expression);
  });
  return parts;
}

/** The elements of an array written out, or of one written out and reversed; nothing for a hole, a spread, or anything else. */
function arrayElements(node: t.Expression | t.Super): t.Node[] | undefined {
  let reversed = false;
  let array: t.Node = node;
  if (t.isCallExpression(array) && t.isMemberExpression(array.callee) && memberKey(array.callee) === 'reverse' && array.arguments.length === 0) {
    reversed = true;
    array = array.callee.object;
  }
  if (!t.isArrayExpression(array)) return undefined;
  const elements: t.Node[] = [];
  for (const element of array.elements) {
    if (!element || t.isSpreadElement(element)) return undefined;
    elements.push(element);
  }
  return reversed ? elements.reverse() : elements;
}

/**
 * What a member met in a key can be, one step in: the element or property
 * a literal source of the holder has under the key, and a store made
 * through the holder or an alias of it under that key. One step, and not
 * `selectValues`: that opens a member found as a value again, through a
 * key nothing resolves as readily as through one spelled, so `parts[0]`
 * holding `cfg[dec(0x816) + 'A']` came back as every value of the proxy
 * map `cfg` - a thousand `dec(...) + 'x'` strings whose pieces, read as
 * fragments, pinned `_0x4a68` in obfuscated2.js for a `'8'` some unrelated
 * entry ends in. A member found here is `keyStrings`' to open, which
 * takes a key nothing resolves as selecting a value out of sight.
 */
function memberSpellings(
  node: t.MemberExpression | t.OptionalMemberExpression,
  scope: Scope,
  analysis: ProgramAnalysis,
  selector: Selector = memberSelector(node),
): Array<{ node: t.Expression; at: NodePath }> {
  const found: Array<{ node: t.Expression; at: NodePath }> = [];
  const selection: Selection = { found: [], visited: new Map(), cuts: 0, peel: 0, wide: false, analysis };
  // The holder: a local's sources, or - `o.a.b` - what the inner member is.
  const sources: StoredValue[] = [];
  let holder: Binding | undefined;
  if (t.isIdentifier(node.object)) {
    holder = scope.getBinding(node.object.name);
    if (!holder) return found;
    for (const source of sourcesOf(holder, selection.analysis)) if (!source.elements) sources.push(source);
  } else if (t.isMemberExpression(node.object) || t.isOptionalMemberExpression(node.object)) {
    for (const inner of memberSpellings(node.object, scope, analysis)) sources.push({ node: inner.node, at: inner.at, elements: false });
    // `o.a.b = v`: a store spelled through the same members from a local.
    for (const store of chainStoresOf(node, selector, scope, analysis)) found.push(store);
  }
  for (const source of sources) {
    if (t.isArrayExpression(source.node)) {
      if (typeof selector === 'string') continue;
      source.node.elements.forEach((element, index) => {
        if (element && !t.isSpreadElement(element) && (selector === null || selector === index)) found.push({ node: element, at: source.at });
      });
    } else if (t.isObjectExpression(source.node)) {
      for (const property of source.node.properties) {
        if (t.isObjectProperty(property) && t.isExpression(property.value) && propertyMatches(property, selector)) {
          found.push({ node: property.value, at: source.at });
        } else if (t.isObjectMethod(property) && property.kind === 'get' && selectorsMeet(propertySelector(property), selector)) {
          // `{ get k() { return ... } }`: reading `.k` runs the getter.
          const getter = functionPathOf(property, source.at, analysis);
          if (getter) for (const returned of returnedValues(getter)) found.push({ node: returned, at: getter });
        }
      }
    } else if (t.isNewExpression(source.node)) {
      // `new C().k` with `C.prototype.k = ...`, or a field of a class in sight.
      const cls = constructedClass(source.node, source.at, analysis);
      const constructor = cls ? undefined : constructedFunction(source.node, source.at, analysis);
      const members = cls ? classMembers(cls, selector, false, selection) : constructor ? functionInstanceMembers(constructor, selector, analysis) : [];
      for (const member of members) if (!member.part && !member.elements) found.push({ node: member.node, at: member.at });
    }
  }
  if (holder) {
    for (const alias of aliasesOf(holder, analysis)) {
      for (const store of memberStoresOf(alias, analysis)) {
        if (store.spread || (store.element ? typeof selector === 'string' : !selectorsMeet(store.selector, selector))) continue;
        found.push({ node: store.node, at: store.at });
      }
    }
    // `class K { static k = ... }`: the class's own field.
    const cls = classOfBinding(holder, analysis);
    if (cls) for (const member of classMembers(cls, selector, true, selection)) if (!member.elements) found.push({ node: member.node, at: member.at });
  }
  return found;
}

/** The values stored under the spelling of a member chain - `o.a.b = v` for a read `o.a.b` - through the root local and its aliases. */
function chainStoresOf(node: t.MemberExpression | t.OptionalMemberExpression, selector: Selector, scope: Scope, analysis: ProgramAnalysis): Array<{ node: t.Expression; at: NodePath }> {
  const found: Array<{ node: t.Expression; at: NodePath }> = [];
  const selectors: Selector[] = [selector];
  let object: t.Expression = node.object;
  while (t.isMemberExpression(object) || t.isOptionalMemberExpression(object)) {
    selectors.unshift(memberSelector(object));
    object = object.object;
  }
  if (!t.isIdentifier(object)) return found;
  const root = scope.getBinding(object.name);
  if (!root) return found;
  for (const alias of aliasesOf(root, analysis)) {
    for (const reference of alias.referencePaths) {
      let path: NodePath = reference;
      for (const step of selectors) {
        const parent: NodePath | null = path.parentPath;
        if (!parent || !(parent.isMemberExpression() || parent.isOptionalMemberExpression()) || parent.node.object !== path.node || !selectorsMeet(memberSelector(parent.node), step)) {
          path = reference;
          break;
        }
        path = parent;
      }
      if (path === reference) continue;
      const store = path.parentPath;
      if (store?.isAssignmentExpression() && store.node.left === path.node && NAMING_ASSIGNMENTS.has(store.node.operator)) {
        found.push({ node: store.node.right, at: store.get('right') as NodePath });
      }
    }
  }
  return found;
}

/**
 * Whether a read's result is used as a value the program goes on with -
 * called, `new`ed, read as a member, or held in a local that is - rather
 * than tested for, which is how a host property is probed. See
 * `resolveGlobalAliases`.
 */
function resultUsed(read: NodePath): boolean {
  const outer = read.parentPath;
  if (!outer) return false;
  // Read for nothing: a bare statement, `void`, `delete`. Called, stored, compared, coerced, returned, tested with `typeof`: used.
  if (outer.isExpressionStatement()) return false;
  if (outer.isUnaryExpression() && (outer.node.operator === 'void' || outer.node.operator === 'delete')) return false;
  return true;
}

/** The key an argument spells: a string or number literal, or nothing anyone here resolves. */
function argumentSelector(node: t.Node | undefined): Selector {
  if (!node) return null;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  const index = staticNumber(node);
  return index === undefined ? null : index;
}

/**
 * Methods of a holder of elements that hand none of them anywhere: they
 * answer a question about the array, or store into it. Everything else -
 * `slice`, `at`, `pop`, `sort` without its callback - is followed nowhere
 * and is an escape; see `holderMethod`.
 */
const HOLDER_OWN_METHODS: ReadonlySet<string> = new Set([
  'indexOf',
  'lastIndexOf',
  'includes',
  'has',
  'join',
  'push',
  'unshift',
  'delete',
  'clear',
  'toString',
]);

/** What a call runs, for a walk that hands an argument to a parameter. */
type CalleeResolution =
  | { kind: 'known'; functions: NodePath<t.Function>[]; offset: number }
  | { kind: 'foreign' }
  | { kind: 'unresolved' };

/** How many bindings a callee may be resolved through before it is given up. */
const CALLEE_DEPTH = 4;

/**
 * The functions a call can run, when every one of them is in sight: a
 * literal, a fixed binding to one, a method of a local literal, a parameter
 * whose every caller passes one of those - or the constructor of a class;
 * `f.call(...)` and `f.apply(...)` are those of `f` with the arguments shifted.
 * `foreign` is a callee that is another script's - a free name, a value read
 * off the global object or returned by one - which is the unknown-code
 * boundary; `unresolved` is a value of this file's the walk cannot follow.
 */
function resolveCallee(call: NodePath<CallLike>, analysis: ProgramAnalysis): CalleeResolution {
  // Asked of every argument of every call an obfuscator.io proxy map is
  // called through, for every method in the map. A callee resolved is a
  // fact about the call; one unresolved may resolve once an alias of the
  // global object is found (`foreignRoot`), so that answer is kept only
  // until the next alias.
  const memo = analysis.calleeResolutions.get(call.node);
  if (memo && (memo.resolution.kind !== 'unresolved' || memo.generation === analysis.aliasGeneration)) {
    return memo.resolution;
  }
  const resolution = computeCallee(call, analysis);
  analysis.calleeResolutions.set(call.node, { resolution, generation: analysis.aliasGeneration });
  return resolution;
}

function computeCallee(call: NodePath<CallLike>, analysis: ProgramAnalysis): CalleeResolution {
  const callee = call.get('callee') as NodePath;
  let target = callee;
  let offset = 0;
  if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) {
    const key = memberKey(callee.node);
    if (key === 'call' || key === 'apply' || key === 'bind') {
      target = callee.get('object') as NodePath;
      offset = 1;
    } else if (key === null && !callee.node.computed) {
      return { kind: 'unresolved' };
    } else if (key === null && staticNumber(callee.node.property) === undefined) {
      // `fn[k](recv, ...)` with `k` undecoded, on a function: `call`, `apply`
      // or `bind`, all of which take the receiver first - or a property no
      // function has, which throws. On anything else it is a method.
      const object = callee.get('object') as NodePath;
      const own: NodePath<t.Function>[] = [];
      const found = collectCallees(object.node, object, analysis, own, 0);
      if (found === 'unresolved') return { kind: 'unresolved' };
      if (own.length > 0) return { kind: 'known', functions: own, offset: 1 };
    }
  }
  const functions: NodePath<t.Function>[] = [];
  const found = collectCallees(target.node, target, analysis, functions, 0);
  if (found === 'unresolved') return { kind: 'unresolved' };
  if (functions.length === 0) return { kind: 'foreign' };
  return { kind: 'known', functions, offset };
}

/**
 * Collects into `functions` what `node` can be when called; `'unresolved'`
 * for a value of this file's it cannot follow, `'foreign'` when nothing
 * found is this file's.
 */
function collectCallees(
  node: t.Node,
  at: NodePath,
  analysis: ProgramAnalysis,
  functions: NodePath<t.Function>[],
  depth: number,
): 'known' | 'foreign' | 'unresolved' {
  let foreign = true;
  for (const leaf of valueLeaves(node as t.Expression)) {
    if (t.isFunctionExpression(leaf) || t.isArrowFunctionExpression(leaf) || t.isObjectMethod(leaf)) {
      const path = functionPathOf(leaf, at, analysis);
      if (!path) return 'unresolved';
      functions.push(path);
      foreign = false;
    } else if (t.isClassExpression(leaf)) {
      const constructor = classConstructor(leaf);
      if (constructor === 'unresolved') return 'unresolved';
      if (constructor) {
        const path = functionPathOf(constructor, at, analysis);
        if (!path) return 'unresolved';
        functions.push(path);
      }
      foreign = false;
    } else if (t.isIdentifier(leaf)) {
      const binding = at.scope.getBinding(leaf.name);
      if (!binding) {
        // A name no scope table binds may be the Annex B var of a
        // block-level function in sloppy code, called past its block.
        for (const declared of annexBCallees(leaf.name, at, analysis)) {
          functions.push(declared);
          foreign = false;
        }
        continue;
      }
      const result = collectBindingCallees(binding, analysis, functions, depth);
      if (result === 'unresolved') return 'unresolved';
      if (result === 'known') foreign = false;
    } else if (t.isMemberExpression(leaf) || t.isOptionalMemberExpression(leaf)) {
      // `Object.create(p).m(...)` runs the `m` the object inherits from `p`.
      const created = createdFrom(leaf.object, at);
      const object = created ?? leaf.object;
      if (foreignRoot(created ? object : leaf, at, analysis)) continue;
      if (depth >= CALLEE_DEPTH) return 'unresolved';
      const selector = memberSelector(leaf);
      const values = selectValues(object, at, selector, analysis, false);
      // `{ m(v) {...} }`: a method is no property value, and is found on the literal itself.
      const methods: NodePath<t.Function>[] = [];
      for (const literal of objectLiteralsOf(object, at, analysis)) {
        for (const property of literal.node.properties) {
          if (!t.isObjectMethod(property) || property.kind !== 'method') continue;
          if (!selectorsMeet(propertySelector(property), selector)) continue;
          const path = functionPathOf(property, literal, analysis);
          if (!path) return 'unresolved';
          methods.push(path);
        }
      }
      // `new C().m(...)`, `C.m(...)`: a method of the class, on the instance or static side.
      for (const method of classMethodsOf(object, at, selector, analysis)) methods.push(method);
      if (values.length === 0 && methods.length === 0) return 'unresolved';
      for (const value of values) {
        if (value.part || value.elements) return 'unresolved';
        const result = collectCallees(value.node, value.at, analysis, functions, depth + 1);
        if (result === 'unresolved') return 'unresolved';
        if (result === 'known') foreign = false;
      }
      if (methods.length > 0) {
        for (const method of methods) functions.push(method);
        foreign = false;
      }
    } else if (t.isCallExpression(leaf) || t.isOptionalCallExpression(leaf)) {
      // `(function () { ... return function (a) {...} })()(g)`: what the
      // callee's own callee returns. A callee that rewrites itself -
      // `_0x123b = function (...) {...}` inside `function _0x123b`, which is
      // obfuscator.io's string decoder and its array getter - returns strings
      // and arrays, and is taken to return no function: its returns are read
      // off a cache keyed on `arguments`, which nothing here opens, and the
      // alternative was every proxy map holding a decoded string beside its
      // functions refusing the whole program scope of obfuscated2.js.
      if (foreignRoot(leaf, at, analysis)) continue;
      if (depth >= CALLEE_DEPTH) return 'unresolved';
      // `f.bind(r)` with nothing bound is `f` under a new name: the same
      // function, its parameters in the same places. Bound arguments shift
      // them, which no list of functions can say; see `boundPosition`.
      const bound = boundFunction(leaf);
      if (bound) {
        const result = collectCallees(bound, at, analysis, functions, depth + 1);
        if (result === 'unresolved') return 'unresolved';
        if (result === 'known') foreign = false;
        continue;
      }
      const inner: NodePath<t.Function>[] = [];
      const result = collectCallees(leaf.callee, at, analysis, inner, depth + 1);
      if (result === 'unresolved') {
        if (!rewritesItself(leaf.callee, at)) return 'unresolved';
        continue;
      }
      for (const fn of inner) {
        if (fn.node.async || fn.node.generator) return 'unresolved';
        for (const returned of returnedValues(fn)) {
          const found = collectCallees(returned, fn, analysis, functions, depth + 1);
          if (found === 'unresolved') return 'unresolved';
          if (found === 'known') foreign = false;
        }
      }
    } else if (t.isNewExpression(leaf)) {
      if (!foreignRoot(leaf, at, analysis)) return 'unresolved';
    } else if (
      t.isObjectExpression(leaf) ||
      t.isArrayExpression(leaf) ||
      t.isLiteral(leaf) ||
      t.isTemplateLiteral(leaf) ||
      t.isBinaryExpression(leaf) ||
      t.isUnaryExpression(leaf) ||
      t.isUpdateExpression(leaf)
    ) {
      // Not callable: a call of it throws before anything is handed over.
      // A reused obfuscator variable holds an array in one statement and a
      // builtin in the next, and only the builtin can be what the call runs;
      // an obfuscator.io proxy map holds `decode(i) + 'x'` strings beside
      // its functions, and `map[k](a, b)` runs one of the functions.
      continue;
    } else {
      return 'unresolved';
    }
  }
  return foreign ? 'foreign' : 'known';
}

function collectBindingCallees(
  binding: Binding,
  analysis: ProgramAnalysis,
  functions: NodePath<t.Function>[],
  depth: number,
): 'known' | 'foreign' | 'unresolved' {
  // Asked of every call site an obfuscator.io proxy map is called through,
  // once per parameter of every function in the map; the answer is a fact
  // about the binding. A binding met again while its answer is being
  // computed is a cycle, and unresolved.
  const memo = analysis.callees.get(binding);
  if (memo) {
    if (memo.result === 'known') for (const fn of memo.functions) functions.push(fn);
    return memo.result;
  }
  analysis.callees.set(binding, { result: 'unresolved', functions: [] });
  const found: NodePath<t.Function>[] = [];
  const result = computeBindingCallees(binding, analysis, found, depth);
  analysis.callees.set(binding, { result, functions: found });
  if (result === 'known') for (const fn of found) functions.push(fn);
  return result;
}

function computeBindingCallees(
  binding: Binding,
  analysis: ProgramAnalysis,
  functions: NodePath<t.Function>[],
  depth: number,
): 'known' | 'foreign' | 'unresolved' {
  const declaration = binding.path;
  if (declaration.isFunctionDeclaration()) {
    if (writesTo(binding).length > 0) return 'unresolved';
    functions.push(declaration);
    return 'known';
  }
  if (declaration.isClassDeclaration()) {
    if (writesTo(binding).length > 0) return 'unresolved';
    const constructor = classConstructor(declaration.node);
    if (constructor === 'unresolved') return 'unresolved';
    if (constructor) {
      const path = functionPathOf(constructor, declaration, analysis);
      if (!path) return 'unresolved';
      functions.push(path);
    }
    return 'known';
  }
  if (depth >= CALLEE_DEPTH) return 'unresolved';
  if (binding.kind === 'param') {
    const owner = paramOwner(binding);
    if (!owner) return 'unresolved';
    const { holders, complete } = holdersOf(owner.fn, analysis);
    if (!complete) return 'unresolved';
    let foreign = true;
    for (const { position } of holders.flat()) {
      if (position.kind !== 'call') return 'unresolved';
      const argument = argumentAt(position.call.node, owner.index + position.offset);
      if (argument === null) return 'unresolved';
      if (argument === undefined) continue;
      const result = collectCallees(argument, position.call, analysis, functions, depth + 1);
      if (result === 'unresolved') return 'unresolved';
      if (result === 'known') foreign = false;
    }
    return foreign ? 'foreign' : 'known';
  }
  // A variable is what every source gives it, its initialiser and each `=`
  // to it; `bindingSources` reads both and is memoised across the pass.
  const sources = sourcesOf(binding, analysis);
  if (sources.length === 0) return 'unresolved';
  let foreign = true;
  for (const source of sources) {
    if (source.elements) return 'unresolved';
    const result = collectCallees(source.node, source.at, analysis, functions, depth + 1);
    if (result === 'unresolved') return 'unresolved';
    if (result === 'known') foreign = false;
  }
  return foreign ? 'foreign' : 'known';
}

/**
 * The object literals an expression can be: the literal itself, or those a
 * local it names was initialised with or assigned, through aliases. The
 * literal's methods are read off it, since `selectValues` hands back
 * property values and a method is none.
 */
function objectLiteralsOf(node: t.Expression | t.Super, at: NodePath, analysis: ProgramAnalysis): NodePath<t.ObjectExpression>[] {
  const literals: NodePath<t.ObjectExpression>[] = [];
  const seen = new Set<Binding>();
  const pending: Array<{ node: t.Expression | t.Super; at: NodePath }> = [{ node, at }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const leaf of valueLeaves(current.node)) {
      if (t.isObjectExpression(leaf)) {
        const path = literalPathOf(leaf, current.at, analysis);
        if (path) literals.push(path);
      } else if (t.isIdentifier(leaf)) {
        const binding = current.at.scope.getBinding(leaf.name);
        if (!binding || seen.has(binding)) continue;
        seen.add(binding);
        const sources = sourcesOf(binding, analysis);
        for (const source of sources) if (!source.elements) pending.push({ node: source.node, at: source.at });
      }
    }
  }
  return literals;
}

/**
 * The path of an object literal held as a node, looked for from `near`
 * outwards as `functionPathOf` does and kept once found: an obfuscator.io
 * proxy map declared at the top of the wrapper is asked for from every one
 * of its thousands of call sites, and the search from each is the wrapper.
 */
function literalPathOf(
  node: t.ObjectExpression,
  near: NodePath,
  analysis: ProgramAnalysis,
): NodePath<t.ObjectExpression> | undefined {
  const known = analysis.literalPaths.get(node);
  if (known) return known;
  let found: NodePath<t.ObjectExpression> | undefined;
  let searched: t.Node | undefined;
  for (let root: NodePath | null = near; root && !found; root = root.parentPath) {
    if (root.node === node) {
      found = root as NodePath<t.ObjectExpression>;
      break;
    }
    root.traverse({
      enter(path) {
        if (path.node === searched) path.skip();
      },
      ObjectExpression(path) {
        if (path.node !== node) return;
        found = path;
        path.stop();
      },
    });
    searched = root.node;
  }
  if (found) analysis.literalPaths.set(node, found);
  return found;
}

/** The block-level functions a free name at `at` may call: those whose var scope holds `at`. */
function annexBCallees(name: string, at: NodePath, analysis: ProgramAnalysis): NodePath<t.FunctionDeclaration>[] {
  const declared = analysis.annexBByName.get(name);
  if (!declared) return [];
  return declared.filter((fn) => {
    const outer = fn.parentPath.scope;
    const varScope = outer.getFunctionParent() ?? outer.getProgramParent();
    return isWithin(at.scope, varScope);
  });
}

/** Whether a call is `Reflect.construct(...)` with `Reflect` free. */
function reflectConstruct(call: NodePath<t.CallExpression>): boolean {
  const { callee } = call.node;
  return t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'Reflect' }) && memberKey(callee) === 'construct' && !call.scope.getBinding('Reflect');
}

/** The `f` of `f.bind(r)` with nothing bound; see `collectCallees`. */
function boundFunction(call: t.CallExpression | t.OptionalCallExpression): t.Expression | undefined {
  const { callee } = call;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return undefined;
  if (memberKey(callee) !== 'bind' || t.isSuper(callee.object)) return undefined;
  const [receiver, ...bound] = call.arguments;
  return bound.length === 0 && !t.isSpreadElement(receiver) ? callee.object : undefined;
}

/** The `p` of `Object.create(p)`, an object inheriting every property of `p`; see `collectCallees`. */
function createdFrom(node: t.Expression | t.Super, at: NodePath): t.Expression | undefined {
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const { callee } = node;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: 'Object' }) || memberKey(callee) !== 'create') return undefined;
  if (at.scope.getBinding('Object')) return undefined;
  const [prototype] = node.arguments;
  return t.isExpression(prototype) ? prototype : undefined;
}

/**
 * Whether a callee is a function declaration that assigns itself a new
 * function from inside its own body, which is how obfuscator.io's decoder
 * and array getter replace themselves on first call; a local that merely
 * holds one (`var d = _0x123b`) counts as it.
 */
function rewritesItself(callee: t.Expression | t.V8IntrinsicIdentifier, at: NodePath): boolean {
  if (!t.isIdentifier(callee)) return false;
  let binding = at.scope.getBinding(callee.name);
  for (let hops = 0; binding && hops < CALLEE_DEPTH; hops++) {
    const declaration = binding.path;
    if (declaration.isFunctionDeclaration()) {
      return writesTo(binding).every(
        (write) => write.isAssignmentExpression() && t.isFunction(write.node.right) && write.isDescendant(declaration),
      );
    }
    if (!declaration.isVariableDeclarator() || writesTo(binding).length > 0) return false;
    const init = declaration.node.init;
    if (!t.isIdentifier(init)) return false;
    binding = declaration.scope.getBinding(init.name);
  }
  return false;
}

/**
 * The constructor a class runs: its own, or none for a base class without
 * one (the arguments are dropped); `'unresolved'` when it inherits one from
 * a parent this does not open.
 */
function classConstructor(node: t.Class): t.Function | undefined | 'unresolved' {
  for (const member of node.body.body) {
    if (t.isClassMethod(member) && member.kind === 'constructor') return member;
  }
  return node.superClass ? 'unresolved' : undefined;
}

/**
 * Whether a member or call chain starts from a value that is not this
 * file's: a free name, the global object under any of its spellings, a
 * literal, or a local whose every source is one of those. `window.jQuery(window)`
 * hands the window to another script, which is the boundary the walk stops
 * at; so does `getOwnPropertyDescriptor(window, k)` called through a local
 * that held `Object.getOwnPropertyDescriptor`.
 */
function foreignRoot(node: t.Node, at: NodePath, analysis: ProgramAnalysis, depth = 0): boolean {
  if (depth > CALLEE_DEPTH) return false;
  let root: t.Node = node;
  for (;;) {
    if (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) root = root.object;
    else if (t.isCallExpression(root) || t.isOptionalCallExpression(root) || t.isNewExpression(root)) root = root.callee;
    else if (t.isParenthesizedExpression(root) || t.isTSNonNullExpression(root) || t.isTSAsExpression(root)) {
      root = root.expression;
    } else if (t.isAwaitExpression(root)) root = root.argument;
    else break;
  }
  if (t.isLiteral(root) || t.isTemplateLiteral(root)) return true;
  // `(0, m).get(k)`, `(c ? m : n).get(k)`: each leaf is a root of its own.
  if (t.isSequenceExpression(root) || t.isLogicalExpression(root) || t.isConditionalExpression(root)) {
    return valueLeaves(root).every((leaf) => !t.isSuper(leaf) && foreignRoot(leaf, at, analysis, depth + 1));
  }
  if (!t.isIdentifier(root)) return false;
  const binding = at.scope.getBinding(root.name);
  if (!binding) return true;
  const { identifier } = binding;
  if (analysis.globalAliasIdentifiers.has(identifier) || analysis.maybeGlobalAliasIdentifiers.has(identifier)) return true;
  if (binding.kind === 'param' || !binding.path.isVariableDeclarator()) return false;
  const sources = sourcesOf(binding, analysis);
  if (sources.length === 0) return false;
  return sources.every((source) => !source.elements && foreignRoot(source.node, source.at, analysis, depth + 1));
}

/** How many levels of calls below the guarded code `pinErrorText` follows. */
const ERROR_CALL_DEPTH = 4;

/**
 * Keep the spelling of every binding `region` references, and of every
 * binding referenced by what it calls, transitively: a program or local
 * function, a method of a local literal, a class's constructor or method,
 * a function it merely holds and hands on - each resolved as `resolveCallee`
 * resolves a callee - to `ERROR_CALL_DEPTH` levels below the region; see
 * `recordCaughtErrorRead`. One level used to be the whole of it, and a TDZ
 * read two calls deep, or in a method the guarded code called, printed
 * `Cannot access 'data' before initialization` at balanced with no word
 * said. A callee is walked once at a given depth however many tries reach
 * it, and again only when reached with more levels left below it.
 *
 * A call the walk cannot resolve to a function - a parameter, a value
 * from out of sight, a method of an instance - or one that sits at the
 * bound is `errorTextUnfollowed`: a failure there would spell a name the
 * pin never saw, and the caller discloses it. A free callee is another
 * script's, which spells no name of this file's.
 */
function pinErrorText(region: NodePath, analysis: ProgramAnalysis): void {
  const pending: Array<{ path: NodePath; depth: number }> = [{ path: region, depth: 0 }];
  while (pending.length > 0) {
    const { path, depth } = pending.pop()!;
    const remaining = ERROR_CALL_DEPTH - depth;
    const walked = analysis.errorTextWalked.get(path.node);
    if (walked !== undefined && walked >= remaining) continue;
    analysis.errorTextWalked.set(path.node, remaining);
    const callees: NodePath[] = [];
    pinReferencedNames(path, analysis, callees);
    if (remaining === 0) {
      if (callees.length > 0) analysis.errorTextUnfollowed = true;
      continue;
    }
    for (const callee of callees) pending.push({ path: callee, depth: depth + 1 });
  }
}

/**
 * Pins every name `region` references, collecting into `callees` what it
 * runs: the functions each call resolves to, and the function or class
 * values it holds without calling, since whoever receives one may call it.
 */
function pinReferencedNames(region: NodePath, analysis: ProgramAnalysis, callees: NodePath[]): void {
  const seen = new Set<t.Node>();
  const pin = (binding: Binding | undefined): void => {
    if (binding) analysis.errorTextIdentifiers.add(binding.identifier);
  };
  const follow = (callee: NodePath | undefined): void => {
    if (callee && !seen.has(callee.node)) {
      seen.add(callee.node);
      callees.push(callee);
    }
  };
  const pinReference = (path: NodePath<t.Identifier | t.JSXIdentifier>): void => {
    if (!path.isReferencedIdentifier()) return;
    const binding = path.scope.getBinding(path.node.name);
    pin(binding);
    if (!binding) return;
    // `JSON.stringify(o)`, `{ ...o }`, a template, `o.x`: a use of a local object runs its getters, coercions and traps; see `accessorsOf`.
    if (path.isIdentifier()) for (const accessor of accessorsOf(path.node, path, analysis)) follow(accessor);
    // A function held, not called: `list.map(_0xa)`, `run(_0xa)`.
    if (path.parentPath?.isCallExpression({ callee: path.node })) return;
    const value = binding.path;
    if (value.isFunctionDeclaration() || value.isClassDeclaration()) follow(value);
    else if (value.isVariableDeclarator()) {
      const init = value.get('init');
      if (init.isFunction() || init.isClass()) follow(init);
    }
  };
  // A write is not a reference in Babel's sense, and a write before the
  // declaration is a TDZ failure that spells the name exactly as a read does.
  const pinWrites = (target: t.Node, scope: Scope): void => {
    for (const id of Object.values(t.getBindingIdentifiers(target))) pin(scope.getBinding(id.name));
  };
  const collect = (call: NodePath<CallLike>): void => {
    if (t.isV8IntrinsicIdentifier(call.node.callee)) return;
    // `new C()` runs the constructor and the field initialisers; the class
    // is walked whole, as the one function it is.
    if (call.isNewExpression()) {
      const cls = constructedClass(call.node, call, analysis);
      if (cls) return follow(cls);
    }
    const resolved = resolveCallee(call, analysis);
    if (resolved.kind === 'unresolved') analysis.errorTextUnfollowed = true;
    else if (resolved.kind === 'known') for (const fn of resolved.functions) follow(fn);
  };
  // `o.x` with `{ get x() { return _0x3ebf } }`, `new C().x` with `get x()`
  // in the class: the read runs the getter, which is a call like any other;
  // `o.x = v` runs the setter, and `const { x } = o` the getter, with no
  // member spelled.
  const accessors = (object: t.Expression | t.Super, at: NodePath, selector: Selector, kind: 'get' | 'set'): void => {
    if (typeof selector === 'number' || t.isSuper(object)) return;
    for (const accessor of accessorsOf(object, at, analysis, kind, selector)) follow(accessor);
  };
  const getters = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): void => {
    if (isPlainAssignmentTarget(path)) return;
    accessors(path.node.object, path, memberSelector(path.node), 'get');
  };
  const patternGetters = (pattern: t.Node, source: t.Expression | null | undefined, at: NodePath): void => {
    if (!source || !t.isObjectPattern(pattern)) return;
    for (const property of pattern.properties) {
      if (t.isObjectProperty(property)) accessors(source, at, patternKeyOf(property), 'get');
    }
  };
  region.traverse({
    Identifier: pinReference,
    JSXIdentifier: pinReference,
    MemberExpression: getters,
    OptionalMemberExpression: getters,
    VariableDeclarator(path) {
      patternGetters(path.node.id, path.node.init, path);
    },
    AssignmentExpression(path) {
      pinWrites(path.node.left, path.scope);
      const { left } = path.node;
      if (t.isMemberExpression(left) || t.isOptionalMemberExpression(left)) accessors(left.object, path, memberSelector(left), 'set');
      else patternGetters(left, path.node.right, path);
    },
    UpdateExpression(path) {
      pinWrites(path.node.argument, path.scope);
    },
    ForXStatement(path) {
      if (!t.isVariableDeclaration(path.node.left)) pinWrites(path.node.left, path.scope);
    },
    CallExpression: collect,
    OptionalCallExpression: collect,
    NewExpression: collect,
  });
}

/**
 * The function or class a call runs, when it is a literal or a fixed binding
 * to one: `knownCallee`, plus `new C()` for a class, whose constructor and
 * field initialisers run.
 */
function calledFunction(call: NodePath): NodePath | undefined {
  const known = knownCallee(call);
  if (known) return known;
  const callee = call.get('callee');
  if (Array.isArray(callee) || !callee.isIdentifier()) return undefined;
  const binding = callee.scope.getBinding(callee.node.name);
  if (!binding || writesTo(binding).length > 0) return undefined;
  const declaration = binding.path;
  if (declaration.isClassDeclaration()) return declaration;
  if (!declaration.isVariableDeclarator()) return undefined;
  const init = declaration.get('init');
  return init.isClassExpression() ? init : undefined;
}

/**
 * `p.then(f).catch(h)`: what `h` catches from is every handler earlier in the
 * chain, and at its head the executor of a `new Promise`, or the body of an
 * async function this file declares. Each of those is the `try` of this
 * catch, and is pinned as one. A chain rooted in a name (`promise.catch(h)`)
 * stops there: what that promise runs is not visible from here.
 */
function pinRejectedChain(handlerCall: NodePath<t.CallExpression>, analysis: ProgramAnalysis): void {
  let link: NodePath = handlerCall;
  for (;;) {
    const callee = memberCallee(link);
    if (!callee) return;
    // `get` on a union of member paths falls back to the untyped overload.
    const receiver = callee.get('object') as NodePath;
    if (receiver.isNewExpression()) {
      const head = receiver.get('callee');
      if (head.isIdentifier({ name: 'Promise' }) && !head.scope.getBinding('Promise')) {
        pinFunctionArguments(receiver, analysis);
      }
      return;
    }
    if (!receiver.isCallExpression() && !receiver.isOptionalCallExpression()) return;
    if (memberCallee(receiver)) {
      pinFunctionArguments(receiver, analysis);
      link = receiver;
      continue;
    }
    const head = calledFunction(receiver);
    if (head) pinErrorText(head, analysis);
    return;
  }
}

/** A call's callee when it is a member: `x.then(...)`, `x?.catch(...)`. */
function memberCallee(
  call: NodePath,
): NodePath<t.MemberExpression> | NodePath<t.OptionalMemberExpression> | undefined {
  const callee = call.get('callee');
  if (Array.isArray(callee)) return undefined;
  if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) return callee;
  return undefined;
}

function pinFunctionArguments(call: NodePath<CallLike>, analysis: ProgramAnalysis): void {
  for (const argument of call.get('arguments')) {
    if (argument.isFunction()) pinErrorText(argument, analysis);
  }
}

/** The key of a non-computed `{ k: v }` or a `{ 'k': v }` pattern property. */
function patternKeyOf(property: t.ObjectProperty): string | null {
  if (!property.computed && t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function isRenameable(
  binding: Binding,
  analysis: ProgramAnalysis,
  settings: Settings,
  isScript: boolean,
): boolean {
  const name = binding.identifier.name;
  if (name.length === 0) return false;
  if (analysis.freezer.isFrozen(binding.scope)) return false;
  if (stringCodeRefuses(binding, analysis)) {
    analysis.stringCodeRefusals++;
    return false;
  }
  if (analysis.reflectiveIdentifiers.has(binding.identifier)) return false;
  // A caught error's text spells this name; see `recordCaughtErrorRead`.
  if (analysis.errorTextIdentifiers.has(binding.identifier)) return false;
  if (analysis.namedAliasIdentifiers.has(binding.identifier)) return false;
  // A block-level function in sloppy code is also a var of the enclosing
  // function or script that no scope table here records, so neither it nor a
  // same-named binding in that scope - or in any scope above it, which is
  // where Babel resolves the var's references to - has a complete reference
  // list.
  if (analysis.annexBFunctions.has(binding.identifier)) return false;
  if (analysis.annexBNames.get(binding.scope.uid)?.has(name)) return false;

  // A name that also exists as a string literal may be reached by that string:
  // `obj[name]`, or a DI token such as `register('svc', ['_0x4a68'], f)`. Too
  // cheap to skip.
  //
  // It does *not* cover string code that names the binding, which was the third
  // example this comment used to give. `Function('return _0x4a68')` puts
  // `"return _0x4a68"` in `strings`, not `"_0x4a68"`; that hazard is
  // `stringCodeRefuses`'s, and the two guards are independent - neither stands
  // in for the other. Nor does it reliably cover `globalThis['_0x4a68']`, because
  // property normalisation has already rewritten that to `globalThis._0x4a68`
  // by the time this pass runs and deleted the string it would key on; the
  // surviving dot form is caught by `resolveGlobalAliases` instead.
  if (analysis.strings.has(name)) return false;

  if (binding.kind === 'module' && !settings.renameImports) return false;
  if (binding.kind === 'param' && !settings.renameParameters) return false;
  if (!settings.renameReadable && isReadableName(name, analysis.scheme)) return false;
  if (hasUnrewritableReference(binding)) return false;
  if (isExported(binding)) return false;
  if (escapesToGlobal(binding, analysis)) return false;
  if (isShorthandPatternBinding(binding)) return false;

  // In a script, top-level `var`/`function` declarations become properties of
  // the global object, so a readable one may be called from outside the file.
  if (isScript && binding.scope.path.isProgram() && isReadableName(name, analysis.scheme)) {
    if (binding.kind === 'var' || binding.kind === 'hoisted') return false;
  }
  // ... and this same file may read one of them back as `window.<name>`, which is
  // a use of the binding that never appears in `referencePaths` - or hand the
  // global object itself to code that reads whichever it likes; see
  // `resolveGlobalAliases`.
  if (isGlobalObjectProperty(binding, isScript)) {
    if (analysis.globalObjectEnumerated || (analysis.globalObjectEscaped && analysis.memberKeys.has(name))) {
      analysis.globalEscapeRefusals++;
      return false;
    }
    if (analysis.globalObjectMembers.has(name)) return false;
    // ... or through a key it spells only in part; and where the reading of
    // an unresolved key as a host property is not assumed, through any.
    if (spelledInPart(name, analysis)) return false;
    if (!settings.assumeHostProperties && analysis.globalOpaqueReads.length > 0) return false;
  }

  return true;
}

/**
 * Whether code compiled from a string makes renaming this binding unsound.
 *
 * Two directions, and only one of them is a question about the name the binding
 * currently has.
 *
 *   * READ - the string spells the name the binding HAS, so a rename leaves it
 *     addressing a name the program no longer declares. That is exactly
 *     {@link StringCodeFacts.addresses}, and the per-name form is the right one
 *     for this pass for the reason that interface gives: it renames one binding
 *     at a time and resolves no chain of names through a scope, so a name the
 *     string cannot spell is a name the string cannot notice.
 *   * WRITE - the string spells the name the binding is about to be GIVEN.
 *     `Function('X = 1')()` beside a script's program-scope `var Z` renamed to
 *     `X` lets the string clobber Z. Nothing in the tree warns of it: `X` is
 *     minted here from evidence and appears nowhere in the program, so neither
 *     `strings` nor `freeGlobalScopes` - the two lists the allocator checks a
 *     target name against - can contain it.
 *
 * No other consumer of the shared fact has the second direction: the strings
 * and dispatcher passes delete and inline, they never mint a name. And the fact
 * has no "can this source spell N" predicate to ask it with - `addresses` takes
 * a binding, so the only name it can be asked about is one a binding already
 * has. So the global arm is NOT narrowed by name here. Under global-scope
 * string code a script's program scope is refused whole, which is what
 * `ScopeFreezer`'s `'global'` hazard did before this migration, and taking the
 * read narrowing alone would open the write direction while looking like a
 * strict improvement.
 *
 * The arm's price on the corpus is 0 bytes, which is a fact about the corpus
 * and not about the arm. Dropping it and keeping `addresses` alone leaves all
 * four script fixtures - `lightly-obfuscated.js`, `obfuscated2.js`,
 * `obfuscated4.js`, `obfuscated5.js` - byte-identical at 'balanced' and
 * 'aggressive' with the same rename counts, and `obfuscated3.js` is a module,
 * where the arm cannot apply at all. So nothing here exercises the difference;
 * a file that did would pay for it, and what would then recover the bytes
 * soundly is a `spells(name)` predicate on `StringCodeFacts` - both directions,
 * one name set, one place.
 *
 * `lightly-obfuscated.js` is 0 for a stronger reason than the other three, and
 * no predicate would buy that file a byte: its one global-scope construct has a
 * source built at run time - `Function(_)` at line 7258, where `_` is a regex
 * match against the page - so the fact's name set is the blunt `null` and
 * neither arm can narrow anything there.
 *
 * `StringCodeFacts.spells` exists now, and it is NOT enough to narrow this
 * arm: a source does not have to spell a name to expose one. `var g = (0,
 * eval)('this'); log(g._0x1a2b3c.get('k'))` hands the program the global
 * object itself, and every program-scope binding is then read through `g`
 * under a name that appears nowhere in the compiled source. A per-name arm
 * renamed `_0x1a2b3c` to `map` there, and the read through `g` threw. What a
 * narrowing has to establish is what such code RETURNS, not what it spells.
 *
 * What the migration does buy at program scope is the two narrowings that are
 * not about names. A MODULE's program scope is a module environment record that
 * global code has no path to, so it is no longer frozen at all. And the shapes
 * the old `CallExpression`/`NewExpression` visitor pair could not classify are
 * classified now - an `OptionalCallExpression` is neither, which is how
 * `Function?.(src)` was renaming through a live hazard.
 */
function stringCodeRefuses(binding: Binding, analysis: ProgramAnalysis): boolean {
  if (analysis.stringCode.addresses(binding)) return true;
  return (
    analysis.stringCode.global &&
    analysis.programScopeIsGlobal &&
    binding.scope.path.isProgram()
  );
}

/**
 * Whether the binding is a property of the global object.
 *
 * True for exactly one shape: a program-scope `var` or function declaration in
 * a *script*. Program-scope `let`/`const`/`class` go in the global lexical
 * environment instead and are properties of nothing, and in a module nothing at
 * program scope is.
 */
function isGlobalObjectProperty(binding: Binding, isScript: boolean): boolean {
  if (!isScript || !binding.scope.path.isProgram()) return false;
  return binding.kind === 'var' || binding.kind === 'hoisted';
}

function isExported(binding: Binding): boolean {
  const parent = binding.path.parentPath;
  if (parent?.isExportNamedDeclaration() || parent?.isExportDefaultDeclaration()) return true;
  const grandparent = parent?.parentPath;
  if (grandparent?.isExportNamedDeclaration() || grandparent?.isExportDefaultDeclaration()) return true;
  for (const reference of binding.referencePaths) {
    const referenceParent = reference.parentPath;
    if (referenceParent?.isExportSpecifier() || referenceParent?.isExportDefaultDeclaration()) {
      return true;
    }
  }
  return false;
}

/**
 * `window.setserver = f` publishes `f` under a name the HTML calls.
 *
 * The object does not have to be literally `window`: the fixture exposes its API
 * through `!function(d){ d.setserver = ... }(window)`, so the window parameter
 * of such a wrapper counts too. Only that spelling and `var g = window`
 * (`namedAliasIdentifiers`): this is a policy about what a published value
 * is called, not a guard, and an alias found through a chain or a `this`
 * keeps the policy where it was. What such a store does to a `.name` read
 * of the value is `globalStoresOf`'s, which follows every alias.
 */
function escapesToGlobal(binding: Binding, analysis: ProgramAnalysis): boolean {
  for (const reference of binding.referencePaths) {
    const parent = reference.parent;
    if (!t.isAssignmentExpression(parent) || parent.right !== reference.node) continue;
    if (!t.isMemberExpression(parent.left)) continue;
    const object = parent.left.object;
    if (!t.isIdentifier(object)) continue;
    const objectBinding = reference.scope.getBinding(object.name);
    if (!objectBinding) {
      if (GLOBAL_OBJECT_NAMES.has(object.name)) return true;
      continue;
    }
    if (analysis.namedAliasIdentifiers.has(objectBinding.identifier)) return true;
  }
  return false;
}

/** `const { foo } = o` - the key is already the name; rewriting it adds nothing. */
function isShorthandPatternBinding(binding: Binding): boolean {
  const target = binding.identifier;
  let found = false;
  const inspect = (pattern: t.Node | null | undefined): void => {
    if (found || !pattern) return;
    if (t.isObjectPattern(pattern)) {
      for (const property of pattern.properties) {
        if (t.isRestElement(property)) {
          inspect(property.argument);
          continue;
        }
        if (!t.isObjectProperty(property)) continue;
        const value: t.Node = t.isAssignmentPattern(property.value)
          ? property.value.left
          : property.value;
        if (value === target && property.shorthand) found = true;
        else inspect(value);
      }
      return;
    }
    if (t.isArrayPattern(pattern)) {
      for (const element of pattern.elements) inspect(element);
      return;
    }
    if (t.isAssignmentPattern(pattern)) inspect(pattern.left);
    if (t.isRestElement(pattern)) inspect(pattern.argument);
  };

  const path = binding.path;
  if (path.isVariableDeclarator()) inspect(path.node.id);
  else if (binding.kind === 'param') inspect(path.node as t.Node);
  return found;
}

/**
 * Outer scopes first, then source position - and then two tie-breaks that make
 * this a *total* order rather than a partial one.
 *
 * They are load-bearing on a control-flow-recovered file. The structure passes
 * rebuild declarations, and a synthesised node has no `.start`, so on
 * obfuscated4.js every rename target scores 0 on position and almost every
 * adjacent pair ties. What decided the order was then the order the array
 * happened to arrive in - `Object.keys(scope.bindings)` - and that order feeds
 * both `settled` and the allocator's per-scope suffix claiming, so it picks
 * which binding gets `found` and which gets `found2`. Comparing scope uid and
 * then name leaves nothing tied: two bindings in one scope cannot share a name.
 *
 * The depth cache matters because the comparator runs O(n log n) times and each
 * `depthOf` walks a scope chain; it lives inside one sort so nothing is carried
 * between runs.
 */
function targetOrder(): (a: Binding, b: Binding) => number {
  const depths = new Map<number, number>();
  const depthOf = (scope: Scope): number => {
    const cached = depths.get(scope.uid);
    if (cached !== undefined) return cached;
    let depth = 0;
    let current: Scope | undefined = scope;
    while (current?.parent) {
      depth++;
      current = current.parent;
    }
    depths.set(scope.uid, depth);
    return depth;
  };

  return (a, b) =>
    depthOf(a.scope) - depthOf(b.scope) ||
    (a.identifier.start ?? 0) - (b.identifier.start ?? 0) ||
    a.scope.uid - b.scope.uid ||
    compareStrings(a.identifier.name, b.identifier.name);
}

/** Casing rules that a rule's raw suggestion is not allowed to violate. */
function enforceHardConstraints(name: string, facts: BindingFacts): string | undefined {
  let result = name;
  if (facts.jsx || facts.returnsJsx) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }
  if (facts.callsHooks && facts.functionPath && !/^use[A-Z]/.test(result) && !facts.returnsJsx) {
    result = `use${result.charAt(0).toUpperCase()}${result.slice(1)}`;
  }
  return result.length > 0 ? result : undefined;
}

function compileHints(hints: Record<string, string>): NamingWorld['hints'] {
  return Object.keys(hints)
    .sort()
    .map((source) => {
      let regex: RegExp | null = null;
      if (/[\\^$.*+?()[\]{}|]/.test(source)) {
        try {
          regex = new RegExp(source);
        } catch {
          regex = null;
        }
      }
      return { source, regex, name: hints[source] ?? source };
    });
}

/**
 * The next unused `<base><n>` for this scope.
 *
 * `taken` skips numbers a binding already holds, which is what keeps the guard
 * above from being paid for twice. A settled `val64` no longer consumes the
 * counter, so without the skip the next binding that does need a `val` would be
 * offered `val1`, find it occupied, and be given `val1_2` - a spelling that says
 * "second `val1`" about a binding that is neither. Skipping hands it the first
 * genuinely free number instead.
 *
 * The scan is bounded because `taken` is asked about a scope chain and an
 * adversarial file can bind every candidate; exhausting the bound falls through
 * to a name the allocator will reject on its own, which is a decline, not a
 * wrong rename.
 */
function nextFallbackName(
  facts: BindingFacts,
  counters: Map<number, Map<string, number>>,
  taken: (name: string) => boolean,
): string {
  const base = fallbackBase(facts);
  const scopeId = facts.binding.scope.uid;
  let perScope = counters.get(scopeId);
  if (!perScope) {
    perScope = new Map();
    counters.set(scopeId, perScope);
  }
  let next = (perScope.get(base) ?? 0) + 1;
  for (let skipped = 0; skipped < MAX_FALLBACK_SKIP && taken(`${base}${next}`); skipped++) next++;
  perScope.set(base, next);
  return `${base}${next}`;
}

/** Occupied fallback numbers stepped over before giving up on a dense name. */
const MAX_FALLBACK_SKIP = 512;

function fallbackBase(facts: BindingFacts): string {
  // A class is not a function to a reader: `new cls1(hex)` says what `new
  // fn1(hex)` does not, and every `new` in the file points at one of these.
  if (facts.declKind === 'class') return 'cls';
  if (facts.functionPath || facts.usedAsCallee > 0) return 'fn';
  const shape = facts.shapes[0];
  if (t.isStringLiteral(shape)) return 'str';
  // `staticNumber` rather than `isNumericLiteral`, because the question is what
  // kind of value the binding holds and a parser never produces a negative
  // NumericLiteral: `-1` is a UnaryExpression over `1`. Reading only the literal
  // node type named `x = -1` `arg52` and `x = 1` `num12`, which is a distinction
  // about spelling.
  if (staticNumber(shape) !== undefined) return 'num';
  if (t.isBooleanLiteral(shape)) return 'bool';
  if (t.isArrayExpression(shape)) return 'arr';
  if (t.isObjectExpression(shape)) return 'obj';
  if (facts.members.size > 0) return 'obj';
  if (facts.declKind === 'param') return 'arg';
  return 'val';
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Whether a binding already carries the name a rule just derived.
 *
 * The allocator's disambiguating suffix counts as the same name. Without that,
 * a scope holding `re2`, `re3` and `re4` - all of which the RegExp rule wants to
 * call `re` - renames each to the lowest free suffix, so every run shifts them
 * down by one and the output never settles. Nothing a reader can use changes
 * when `re4` becomes `re3`, and a tool whose output keeps moving cannot be
 * diffed across versions or trusted to have finished.
 *
 * Both spellings `RenameAllocator.suffixes` can produce count: the bare decimal
 * and, for a base ending in a digit, the underscored one.
 */
function isSettledSpelling(from: string, target: string): boolean {
  if (from === target) return true;
  if (!from.startsWith(target) || from.length === target.length) return false;
  return /^_?[0-9]+$/.test(from.slice(target.length));
}

// ---------------------------------------------------------------------------
// Property renaming (§5.5)
// ---------------------------------------------------------------------------

const UNSAFE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
]);

/**
 * Rename the keys of an object literal, but only when every one of the six
 * conditions in §5.5 holds. Anything less and the object could be enumerated,
 * spread or indexed by a computed key, and renaming would be silently wrong.
 */
function renameObjectProperties(
  analysis: ProgramAnalysis,
  targets: readonly Binding[],
  facts: ReadonlyMap<Binding, BindingFacts>,
  typescript: boolean,
): InferredRename[] {
  const renames: InferredRename[] = [];

  for (const binding of targets) {
    const bindingFacts = facts.get(binding);
    if (!bindingFacts || bindingFacts.escapeReason) continue;
    if (!binding.path.isVariableDeclarator()) continue;
    if (writesTo(binding).length > 0) continue;

    const object = binding.path.node.init;
    if (!t.isObjectExpression(object) || object.properties.length === 0) continue;
    if (!object.properties.every((property) => t.isObjectProperty(property) && !property.computed)) {
      continue;
    }

    const accesses = collectStaticAccesses(binding);
    if (!accesses) continue;

    // The literal's own keys, which the collision check below has to avoid: a
    // name minted for one property is not free just because nothing reads it.
    // `{ _0xqw: fn, add: 'poison' }` renamed the first key to `add` and produced
    // a literal with two `add`s, where the second silently wins.
    const ownKeys = new Map<string, number>();
    for (const property of object.properties) {
      if (!t.isObjectProperty(property)) continue;
      const key = staticKeyOf(property);
      if (key !== undefined) ownKeys.set(key, (ownKeys.get(key) ?? 0) + 1);
    }

    const claimed = new Set<string>();
    for (const property of object.properties) {
      if (!t.isObjectProperty(property)) continue;
      const oldKey = staticKeyOf(property);
      if (!oldKey || UNSAFE_KEYS.has(oldKey)) continue;
      // A key written twice: every read sees the last one, so renaming the first
      // moves a value that nothing was reading onto a name that everything is.
      if ((ownKeys.get(oldKey) ?? 0) > 1) continue;

      const uses = accesses.get(oldKey);
      if (!uses || uses.length === 0) continue;

      const literalUses =
        (t.isStringLiteral(property.key) ? 1 : 0) +
        uses.filter((access) => access.computed).length;
      if ((analysis.stringCounts.get(oldKey) ?? 0) > literalUses) continue;

      const suggestion = suggestPropertyName(property.value);
      if (!suggestion || suggestion === oldKey) continue;
      if (isReservedName(suggestion, typescript)) continue;

      const taken = (candidate: string): boolean =>
        claimed.has(candidate) || accesses.has(candidate) || ownKeys.has(candidate);
      // Same separator rule as `RenameAllocator.suffixes`, for the same reason.
      const separator = /[0-9]$/.test(suggestion) ? '_' : '';
      let target = suggestion;
      for (let index = 2; taken(target); index++) {
        target = `${suggestion}${separator}${index}`;
        if (index > 24) break;
      }
      if (taken(target)) continue;
      claimed.add(target);

      property.key = t.identifier(target);
      property.computed = false;
      for (const access of uses) {
        access.property = t.identifier(target);
        access.computed = false;
      }
      renames.push({
        from: `${binding.identifier.name}.${oldKey}`,
        to: target,
        reason: 'I07: local object literal with provably static keys',
        confidence: 0.88,
      });
    }
  }

  return renames;
}

/** The key of `{ k: v }` or `{ 'k': v }`; undefined for anything else. */
function staticKeyOf(property: t.ObjectProperty): string | undefined {
  if (t.isIdentifier(property.key) && !property.computed) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return undefined;
}

/** Every reference must be `O.<static key>`; anything else fails the §5.5 proof. */
function collectStaticAccesses(binding: Binding): Map<string, t.MemberExpression[]> | null {
  const accesses = new Map<string, t.MemberExpression[]>();
  for (const reference of binding.referencePaths) {
    const parent = reference.parent;
    if (!t.isMemberExpression(parent) || parent.object !== reference.node) return null;
    let key: string | undefined;
    if (!parent.computed && t.isIdentifier(parent.property)) key = parent.property.name;
    else if (parent.computed && t.isStringLiteral(parent.property)) key = parent.property.value;
    if (!key) return null;
    // A write to `O.k` is fine, but `delete O[x]` or `O` in any other position is not.
    const grandparent = reference.parentPath?.parentPath;
    if (grandparent?.isUnaryExpression() && grandparent.node.operator === 'delete') return null;
    const bucket = accesses.get(key);
    if (bucket) bucket.push(parent);
    else accesses.set(key, [parent]);
  }
  return accesses;
}

function suggestPropertyName(value: t.Node): string | undefined {
  if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
    const operation = binaryOperationName(value);
    if (operation) return operation;
    return undefined;
  }
  if (t.isStringLiteral(value)) {
    const ident = identFromString(value.value.slice(0, 24));
    return ident ? toCamel(ident) : undefined;
  }
  return undefined;
}

function binaryOperationName(fn: t.Function): string | undefined {
  if (fn.params.length !== 2) return undefined;
  const [first, second] = fn.params;
  if (!t.isIdentifier(first) || !t.isIdentifier(second)) return undefined;
  const body = fn.body;
  let expression: t.Expression | null | undefined;
  if (t.isBlockStatement(body)) {
    const only = body.body[0];
    if (body.body.length !== 1 || !t.isReturnStatement(only)) return undefined;
    expression = only.argument;
  } else {
    expression = body;
  }
  if (!expression) return undefined;
  if (!t.isBinaryExpression(expression) && !t.isLogicalExpression(expression)) return undefined;
  const { left, right, operator } = expression;
  const straight =
    t.isIdentifier(left, { name: first.name }) && t.isIdentifier(right, { name: second.name });
  const flipped =
    t.isIdentifier(left, { name: second.name }) && t.isIdentifier(right, { name: first.name });
  if (!straight && !flipped) return undefined;
  return OPERATION_NAMES.get(operator);
}

const OPERATION_NAMES: ReadonlyMap<string, string> = new Map([
  ['-', 'subtract'],
  ['+', 'add'],
  ['*', 'multiply'],
  ['/', 'divide'],
  ['%', 'mod'],
  ['===', 'equals'],
  ['!==', 'notEquals'],
  ['==', 'looseEquals'],
  ['!=', 'looseNotEquals'],
  ['<', 'lessThan'],
  ['>', 'greaterThan'],
  ['<=', 'atMost'],
  ['>=', 'atLeast'],
  ['|', 'bitOr'],
  ['&', 'bitAnd'],
  ['^', 'bitXor'],
  ['<<', 'shiftLeft'],
  ['>>', 'shiftRight'],
  ['&&', 'and'],
  ['||', 'or'],
]);
