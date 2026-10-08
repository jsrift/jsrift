import _traverse, { type Binding, type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { stripTypeWrappers } from '../util/ast.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

export interface SliceResult {
  /** Statements to evaluate, outermost scope first, then in original order. */
  statements: t.Statement[];
  /** Bindings the slice defines, at any of the scopes it drew from. */
  definedNames: Set<string>;
  /** Names referenced but not defined by the slice; must be host globals. */
  freeNames: Set<string>;
  /**
   * Paths that were included *from the owning scope*, so callers can remove them
   * once inlining is done.
   *
   * Deliberately not every path in `statements`: a declaration borrowed from an
   * enclosing scope (see `pullOuterDeclaration`) is evaluated but never deleted,
   * because the slice proves nothing about who else reads it.
   */
  sources: NodePath[];
  /**
   * A name the slice evaluates that some *other* code in the same scope can
   * change, in a way the slice does not reproduce.
   *
   * The mutator search below takes every sibling it can recognise, and a
   * rotation wrapper it takes is part of the value. This field is for the ones
   * it cannot take: `evaluating this would produce a table in the wrong order`,
   * which is the failure that yields real-looking strings at every call site
   * and no way for a reader to tell. Callers must refuse rather than evaluate.
   */
  unmodelledMutation?: string;
  /** What the code outside the slice does to `unmodelledMutation`; set with it. */
  unmodelledMutationKind?: UnmodelledMutationKind;
}

/**
 * How a name the slice needs is changed by something the slice does not run.
 *
 *  - `shuffle`: a `push(shift())` rotation the slice could not take.
 *  - `assignment`: a bare assignment or update it could not take - inside a
 *    compound statement that hoists a binding, leaves by `return`/`break`, or
 *    is over budget; in a `for` head; in a sibling function.
 *  - `member`: a write through a member, a `delete`, a method call, or a
 *    hand-off to a call - `_0xo.v = 1`, `_0xo.push(1)`, `_0xr.test(s)`,
 *    `Object.defineProperty(_0xo, ...)` - on a name that is not the table. The
 *    table's own audit lives in `strings.discover`, so writes to it are not
 *    reported here.
 *  - `order`: a mutator the slice DID take, textually after a use of the
 *    decoder. The slice runs every mutator before any read, so that use
 *    would be decoded with a value it never sees.
 *  - `escape`: a reference the slice cannot account for - the value handed
 *    on inside a literal, picked as a branch of a conditional, spread,
 *    yielded, read through a member and passed along - to a name whose
 *    identity matters. Nothing above recognises it, and the code it reaches
 *    may do any of the above.
 */
export type UnmodelledMutationKind = 'shuffle' | 'assignment' | 'member' | 'order' | 'escape';

/**
 * A statement list the slicer can schedule.
 *
 * Every JavaScript binding that is not a parameter is declared in a `Program`
 * body or a `BlockStatement` body, so those two are the only shapes that need
 * handling; a function is reached through its body block.
 */
export type SliceScope = NodePath<t.Program> | NodePath<t.BlockStatement>;

/**
 * Globals a string decoder may legitimately reach for. Anything outside this set
 * appearing in `freeNames` means the slice is not self-contained and the caller
 * should refuse to evaluate it.
 */
const ALLOWED_GLOBALS = new Set([
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Math',
  'JSON',
  'RegExp',
  'Date',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'decodeURIComponent',
  'encodeURIComponent',
  'decodeURI',
  'encodeURI',
  'unescape',
  'escape',
  'atob',
  'btoa',
  'undefined',
  'NaN',
  'Infinity',
  'Error',
  'TypeError',
  // Function-local, not a route to the host. Babel reports it as a global
  // because no binding declares it.
  'arguments',
]);

/**
 * A rotation wrapper is a few hundred bytes. Anything larger that merely
 * mentions the decoder is the program itself, not decoder machinery.
 */
const MAX_MUTATOR_NODES = 400;

/**
 * How far out of the owning scope a slice may reach for a declaration.
 *
 * A decoder nested in a module factory needs one or two levels; a name that is
 * only reachable ten scopes out is not decoder machinery, and walking further
 * only buys pathological inputs a longer analysis.
 */
const MAX_ENCLOSING_LEVELS = 16;

/**
 * One schedulable unit within a scope.
 *
 * Statements are not the right granularity. Minified obfuscator output routinely
 * fuses the rotation wrapper and the entire program into a single comma
 * expression, so a statement-level slicer either takes both or neither.
 * Splitting sequence expressions into their parts is what makes the slice small.
 */
interface Unit {
  /** The unit rendered as a standalone statement, for the evaluated program. */
  statement: t.Statement;
  /** Where it came from, for later removal. */
  path: NodePath;
}

/** One scope's worth of schedulable units, plus the bookkeeping the walk needs. */
interface Level {
  scope: SliceScope;
  units: Unit[];
  /** name -> unit indexes that bind it, at this scope only. */
  declaredBy: Map<string, number[]>;
  included: Set<number>;
  /** Free variables of a unit, computed on demand - it is the expensive part. */
  references: Map<number, Set<string>>;
  /** How each unit reaches the names outside it, computed on demand; see `UnitScan`. */
  scans: Map<number, UnitScan>;
  /** The same for the container unit with the next level in cut out, keyed by that level's node. */
  containerScans: Map<t.Node, UnitScan>;
  /** Which units can mutate which names; see `MutatorIndex`. */
  mutators: MutatorIndex;
  /**
   * The unit that lexically contains the next level in, or -1.
   *
   * It is never a candidate for anything: it *is* the enclosing IIFE, and taking
   * it would put the whole module back inside the sandbox the slice exists to
   * stay out of.
   */
  container: number;
  /** The next level in, when this is an enclosing one. */
  inner?: SliceScope;
}

/**
 * Where a `roots` array came from, so the slicer can start at the right scope.
 *
 * `buildDecoder` takes `roots: readonly string[]` and hands that same array
 * straight through to `sliceForEvaluation`, so the array's own identity is a
 * free, exact channel for the one fact the name cannot carry: *which* scope
 * these names are declared in. It has to be identity rather than the names
 * themselves, because two sibling modules in one bundle routinely declare the
 * same `_0x1234` over completely different tables.
 *
 * A `WeakMap` so a tag never outlives the analysis that made it, and losing the
 * tag is not a correctness problem - `locateScope` finds the scope again, and
 * refuses when the answer is ambiguous.
 *
 * The same channel carries the one name the caller audits itself: the table.
 * `arrayIsImmutable` and `tableIsStable` in `strings.discover` judge every
 * reference to it outside the machinery, with a message that names the
 * reference, so a member write to the table is theirs to refuse and not
 * `unmodelledMutation`'s. No tag, no exemption - a direct caller gets the
 * stricter answer.
 */
const tagOfRoots = new WeakMap<readonly string[], { scope: SliceScope; table?: string }>();

/**
 * Record which scope a candidate's root names are declared in, and which of
 * them - if any - is the table the caller audits for writes on its own.
 */
export function declareSliceScope(
  roots: readonly string[],
  scope: SliceScope,
  table?: string,
): void {
  tagOfRoots.set(roots, { scope, table });
}

/** The `Program` or `BlockStatement` whose body holds `path`'s declarations. */
export function asSliceScope(path: NodePath | null | undefined): SliceScope | undefined {
  if (!path || path.removed) return undefined;
  if (path.isProgram()) return path;
  if (path.isBlockStatement()) return path;
  if (path.isFunction()) {
    const body = (path as NodePath<t.Function>).get('body');
    return body.isBlockStatement() ? body : undefined;
  }
  return undefined;
}

/**
 * Extract the minimal set of code needed to evaluate `roots`.
 *
 * This is the load-bearing safety property of the whole engine. The original
 * tool called `eval()` on the entire input file, which meant deobfuscating a
 * hostile script executed it - in the user's browser, with full DOM access - and
 * forced a pile of hacks to stop unrelated parts of the file from throwing.
 *
 * Instead the slicer takes the dependency closure of the decoder: the statements
 * that declare it, everything those transitively reference, and any sibling unit
 * that *mutates* a name in the closure. That last category is not optional -
 * obfuscator.io's rotation wrapper declares nothing and is pure side effect, but
 * the array is in the wrong order without it.
 *
 * The closure is taken **relative to the scope the decoder is declared in**, not
 * relative to the program. Every bundler on earth - webpack, Next.js, Vite -
 * wraps a module body in a function, and a program-relative slicer simply cannot
 * see a string array one level down; it proposes nothing and the file comes out
 * untouched. Declarations borrowed from an enclosing scope are handled by
 * `pullOuterDeclaration`, under much stricter rules than sibling ones.
 *
 * The result is typically a few hundred bytes out of a four megabyte file, and
 * contains no DOM access, no network calls and no user code.
 */
export function sliceForEvaluation(
  root: NodePath<t.Program> | SliceScope,
  roots: readonly string[],
  scans?: StatementScanCache,
): SliceResult {
  const scope = resolveScope(root, roots);
  if (!scope) return emptySlice();
  return sliceScope(scope, roots, scans, tagOfRoots.get(roots)?.table);
}

/**
 * What one rotation scan learns about a statement, kept for the next candidate.
 *
 * `unmodelledMutation` asks, for every statement outside the slice, whether it
 * shuffles an array and which of the slice's names it mentions. Both are facts
 * about the statement alone, and a discovery round asks them once per
 * candidate: with hundreds of top-level tables that walked the whole program
 * hundreds of times, and was the largest single cost in `strings.discover`.
 * The cache is the caller's, created per round, because that is exactly how
 * long the tree it describes stays the same - the next pass rewrites it.
 */
export class StatementScanCache {
  /**
   * Statements actually walked through any cache, cumulative for the process.
   *
   * The linearity witness for `strings.discover`: with the cache each round
   * walks a statement once, so N concatenated programs cost N times one
   * program's scans, and a regression to the per-candidate walk shows as N²
   * here where a wall-clock ratio showed as a flake under load. Read as a
   * delta around one awaited `deobfuscate` call; never reset, so a reader
   * needs no cooperation from the engine.
   */
  static scansPerformed = 0;

  private readonly scans = new Map<t.Node, StatementScan>();
  private readonly parts = new Map<t.Node, LevelParts>();

  scan(statement: t.Node): StatementScan {
    let scan = this.scans.get(statement);
    if (!scan) {
      StatementScanCache.scansPerformed++;
      scan = scanStatement(statement);
      this.scans.set(statement, scan);
    }
    return scan;
  }

  /**
   * The parts of a level that every candidate in the scope shares: its unit
   * list, which unit declares which name, each unit's free variables, and
   * which units could mutate which names. Only `included` and `container` are
   * the candidate's own. Rebuilding the shared parts per candidate was one
   * quadratic term in discovery; asking every sibling unit per candidate
   * whether it mutates the slice was the other, and `mutators` is what turns
   * that question into a lookup.
   */
  levelParts(scope: SliceScope): LevelParts {
    let parts = this.parts.get(scope.node);
    if (!parts) {
      parts = buildLevelParts(scope, this);
      this.parts.set(scope.node, parts);
    }
    return parts;
  }

  /**
   * Drop everything the round learned. The cache outlives the round in the
   * options each adopted decoder was built with - `buildDecoder` keeps them
   * for its reporter - and what it holds is a scan of every unit that names
   * a needed name at every level a slice drew from, which for a program of
   * thousands of units is hundreds of megabytes kept for a tree that no
   * longer exists.
   */
  release(): void {
    this.scans.clear();
    this.parts.clear();
  }
}

interface LevelParts {
  units: Unit[];
  declaredBy: Map<string, number[]>;
  references: Map<number, Set<string>>;
  scans: Map<number, UnitScan>;
  containerScans: Map<t.Node, UnitScan>;
  mutators: MutatorIndex;
}

function buildLevelParts(scope: SliceScope, scans: StatementScanCache | undefined): LevelParts {
  const units = scopeUnits(scope);
  return {
    units,
    declaredBy: indexDeclarations(units),
    references: new Map(),
    scans: new Map(),
    containerScans: new Map(),
    mutators: new MutatorIndex(units, scans),
  };
}

/**
 * Every unit of a scope that could be taken as a mutator, keyed by the closure
 * name that would make it one, plus the same for units that shuffle an array.
 *
 * Which names a unit assigns, hands to an IIFE, or calls `push`/`shift` on are
 * facts about the unit alone. The mutator search used to establish them per
 * candidate: for each of a scope's hundreds of tables, every sibling unit was
 * walked twice - a node count and a mutation scan - so a scope with N tables
 * and N rotation wrappers did N² subtree walks and found each wrapper's names
 * N times over. Measured on 256 default obfuscator.io programs concatenated:
 * 3.7 s in `strings.discover` to decode nothing, at 2-4x per doubling. With
 * the facts indexed once per round, the search for one candidate touches only
 * the units that name something the slice needs.
 *
 * `byName` answers `isMutator` exactly: a unit is in the list for `name` when
 * the old `isMutator(unit, { name })` would have been true, so the intersection
 * with `needed` is the old answer without the walk. `shufflersByName` is the
 * same index for `unmodelledMutation`, built from the rotation scan - on
 * demand, because that scan walks a statement whole (a folded program
 * initialisation is the statement it exists for) and only the owning scope of
 * a slice ever asks; an enclosing level's module IIFE is never scanned for it.
 */
class MutatorIndex {
  readonly byName = new Map<string, number[]>();
  private indexes: ScanIndexes | undefined;

  constructor(
    private readonly units: readonly Unit[],
    private readonly scans: StatementScanCache | undefined,
  ) {
    for (let index = 0; index < units.length; index++) {
      for (const name of mutatorNames(units[index]!)) addIndex(this.byName, name, index);
    }
  }

  shufflersByName(): ReadonlyMap<string, number[]> {
    return this.scanIndexes().shufflers;
  }

  /**
   * The same index for an ASSIGNMENT rather than a shuffle: every unit that
   * assigns or updates a bare name anywhere inside it, by that name - the
   * exact name, not every name the unit mentions, because an assignment names
   * its target where a shuffle through an IIFE parameter does not.
   */
  writersByName(): ReadonlyMap<string, number[]> {
    return this.scanIndexes().writers;
  }

  /** And for a write that goes THROUGH a name rather than to it; see `StatementScan.touches`. */
  touchersByName(): ReadonlyMap<string, number[]> {
    return this.scanIndexes().touchers;
  }

  /**
   * Every unit that could reference `name`, ascending: the ones whose scan
   * spelled it, plus every unit the scan gave up on part-way, which may spell
   * anything. A superset of the units whose FREE variables include the name
   * - a same-named local is spelled too - and the reason it is worth having
   * is what the exact answer costs: `referencesOf` rebuilds the unit as a
   * program and crawls its scopes, and the escape audit used to pay that for
   * every unit of every level per name it needed, 18,028 times on the 448 KB
   * fixture, to learn that almost none of them mention the name at all. The
   * scan is one structural walk per unit per round, already paid for by the
   * mutator nets, and this index reads it back by name.
   */
  mentionersOf(name: string): readonly number[] {
    const { mentions, truncated } = this.scanIndexes();
    const spelled = mentions.get(name);
    if (truncated.length === 0) return spelled ?? NO_UNITS;
    if (!spelled) return truncated;
    return mergeAscending(spelled, truncated);
  }

  /** Whether the unit's scan spelled any of `names`, or gave up before it could say. */
  mentionsAny(index: number, names: ReadonlySet<string>): boolean {
    const scan = this.scanIndexes().scans[index]!;
    if (scan.truncated) return true;
    for (const name of names) if (scan.names.has(name)) return true;
    return false;
  }

  /** What the unit's rotations are of; see `StatementScan.rotated`. */
  rotatedBy(index: number): ReadonlySet<string> | null {
    const scan = this.scanIndexes().scans[index]!;
    return scan.truncated ? null : scan.rotated;
  }

  private scanIndexes(): ScanIndexes {
    if (this.indexes) return this.indexes;
    const indexes: ScanIndexes = {
      shufflers: new Map(),
      writers: new Map(),
      touchers: new Map(),
      mentions: new Map(),
      truncated: [],
      scans: [],
    };
    for (let index = 0; index < this.units.length; index++) {
      const statement = this.units[index]!.statement;
      const scan = this.scans ? this.scans.scan(statement) : scanStatement(statement);
      indexes.scans.push(scan);
      if (scan.truncated) indexes.truncated.push(index);
      for (const name of scan.names) addIndex(indexes.mentions, name, index);
      for (const name of scan.writes) addIndex(indexes.writers, name, index);
      for (const name of scan.touches) addIndex(indexes.touchers, name, index);
      if (!scan.shuffles) continue;
      for (const name of scan.names) addIndex(indexes.shufflers, name, index);
    }
    this.indexes = indexes;
    return indexes;
  }
}

interface ScanIndexes {
  shufflers: Map<string, number[]>;
  writers: Map<string, number[]>;
  touchers: Map<string, number[]>;
  /** name -> units whose scan spelled it, ascending. */
  mentions: Map<string, number[]>;
  /** Units whose scan ran out of budget, ascending; they may spell anything. */
  truncated: number[];
  /** Each unit's scan, by index. */
  scans: StatementScan[];
}

const NO_UNITS: readonly number[] = [];

/** The union of two ascending unit lists, ascending and without repeats. */
function mergeAscending(a: readonly number[], b: readonly number[]): number[] {
  const merged: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i]! <= b[j]!) ? a[i++]! : b[j++]!;
    if (merged[merged.length - 1] !== next) merged.push(next);
  }
  return merged;
}

function addIndex(map: Map<string, number[]>, name: string, index: number): void {
  const list = map.get(name);
  if (list) list.push(index);
  else map.set(name, [index]);
}

interface StatementScan {
  shuffles: boolean;
  /**
   * What the statement's `push(shift())` rotations are of, as names outside
   * the statement: the rotated local followed back through `var list = fn()`
   * and `var list = fn`, and an IIFE's parameter through to the argument it
   * is called with. `null` when a rotation's subject cannot be followed to
   * such a name, which a reader must take as any name the statement mentions.
   */
  rotated: ReadonlySet<string> | null;
  /** Every identifier name the statement mentions, within the scan budget. */
  names: ReadonlySet<string>;
  /**
   * The budget ran out with nodes unvisited, so `names`, `writes` and
   * `touches` are what the first million nodes said and nothing about the
   * rest. A reader that needs "does not mention" rather than "mentions" must
   * treat such a statement as mentioning anything.
   */
  truncated: boolean;
  /**
   * Every name the statement assigns as a BARE identifier - assigned, updated,
   * or iterated into by a `for-in`/`for-of` head, destructuring included -
   * anywhere inside it, nested functions too. Same walk, same budget as
   * `names`.
   */
  writes: ReadonlySet<string>;
  /**
   * Every name the statement could change THROUGH: the root of a member it
   * assigns, updates or deletes, the receiver of any method it calls, and any
   * bare name it hands to a call. `_0xo.v = 1`, `_0xo[0] = 1`, `delete
   * _0xo.v`, `_0xr.test(s)` (which moves `lastIndex`), `_0xo.__proto__ = p`,
   * `Object.defineProperty(_0xo, ...)`. Which methods and callees actually
   * mutate is not a fact a scan of one statement can establish - `test` is
   * not on any list of mutators and still changes what the next read sees -
   * so every one of them counts, and `unmodelledMutation` decides whether
   * the name is one whose identity matters.
   */
  touches: ReadonlySet<string>;
}

/** True when the slice can be evaluated without reaching outside the sandbox. */
export function isSelfContained(slice: SliceResult): boolean {
  return slice.freeNames.size === 0;
}

function emptySlice(): SliceResult {
  return {
    statements: [],
    definedNames: new Set(),
    freeNames: new Set(),
    sources: [],
  };
}

// ---------------------------------------------------------------------------
// Choosing the scope to slice from
// ---------------------------------------------------------------------------

/**
 * Which scope's statement list this slice starts from.
 *
 * The tag left by discovery is preferred and is the only answer that survives
 * name collisions between modules. Everything else is a fallback for callers
 * that slice a program directly: the top level first, so a program-level decoder
 * behaves exactly as it always has, and only then a search of the nested scopes.
 */
function resolveScope(
  root: NodePath<t.Program> | SliceScope,
  roots: readonly string[],
): SliceScope | undefined {
  const tagged = tagOfRoots.get(roots)?.scope;
  if (tagged && !tagged.removed && isWithin(tagged, root)) return tagged;
  if (!root.isProgram()) return root;
  if (roots.length === 0) return root;
  if (declaresAtTopLevel(root, roots[0]!)) return root;
  return locateScope(root, roots);
}

/** Whether `inner` is `outer` or sits inside it. */
function isWithin(inner: NodePath, outer: NodePath): boolean {
  for (let current: NodePath | null = inner; current; current = current.parentPath) {
    if (current.node === outer.node) return true;
  }
  return false;
}

function declaresAtTopLevel(program: NodePath<t.Program>, name: string): boolean {
  return indexDeclarations(scopeUnits(program)).has(name);
}

/**
 * Find the nested scope that declares `roots`, or refuse.
 *
 * Refusing on ambiguity is the whole point. Two sibling modules that both
 * declare `_0x1234` give two equally good answers, and picking either one
 * decodes half the file against the wrong table - the exact failure mode that is
 * worse than leaving the file alone. In the pipeline the tag above means this
 * never has to guess; this exists so a direct caller still gets a sound answer.
 */
function locateScope(
  program: NodePath<t.Program>,
  roots: readonly string[],
): SliceScope | undefined {
  const primary = roots[0]!;
  const matches: SliceScope[] = [];

  program.traverse({
    BlockStatement(path) {
      const declared = indexDeclarations(scopeUnits(path));
      if (!declared.has(primary)) return;
      matches.push(path);
    },
  });

  if (matches.length <= 1) return matches[0];
  const complete = matches.filter((scope) => {
    const declared = indexDeclarations(scopeUnits(scope));
    return roots.every((name) => declared.has(name) || scope.scope.getBinding(name) !== undefined);
  });
  return complete.length === 1 ? complete[0] : undefined;
}

// ---------------------------------------------------------------------------
// The slice itself
// ---------------------------------------------------------------------------

function sliceScope(
  scope: SliceScope,
  roots: readonly string[],
  scans: StatementScanCache | undefined,
  table: string | undefined,
): SliceResult {
  const levels = buildLevels(scope, scans);
  const owner = levels[0]!;

  const needed = new Set<string>();
  /**
   * Names still to resolve, each with the level whose unit read it: a unit
   * sees the declarations of its own level and outward, never those of a
   * level inside it. A program-level helper the decoder reaches reads the
   * program's `tn`, not the `const tn` of the block the decoder sits in,
   * and resolved from the block that shadow was taken - with the live
   * declarations beside it, as machinery.
   */
  const queue: { name: string; from: number }[] = roots.map((name) => ({ name, from: 0 }));
  /** Every (level, name) already resolved; a name is taken once per level that read it. */
  const taken = new Set<string>();

  /** Resolve a name to the innermost scope, from the reading level outward, that declares it, and take it. */
  const take = (name: string, from: number): void => {
    for (let depth = from; depth < levels.length; depth++) {
      const level = levels[depth]!;
      const indexes = level.declaredBy.get(name);
      if (!indexes) continue;
      // The innermost declaration wins whether or not it is ultimately taken:
      // an outer binding of the same name is shadowed and is not the answer.
      // Nor is it the answer when the reader does not see it at all: a
      // parameter or a `catch` binding between the two scopes is no unit of
      // any level, so the name is undeclared here and declared out there,
      // and the slice would evaluate the outer value while the decoder reads
      // the parameter. Left free, the self-containment gate refuses it.
      if (depth > from && levels[from]!.scope.scope.getBinding(name) !== level.scope.scope.getBinding(name)) return;
      if (depth > 0 && !pullOuterDeclaration(level, name, indexes)) return;
      for (const index of indexes) {
        if (index === level.container || level.included.has(index)) continue;
        level.included.add(index);
        for (const reference of referencesOf(level, index)) queue.push({ name: reference, from: depth });
      }
      return;
    }
  };

  const drain = (): void => {
    while (queue.length > 0) {
      const { name, from } = queue.pop()!;
      needed.add(name);
      const key = `${from} ${name}`;
      if (taken.has(key)) continue;
      taken.add(key);
      take(name, from);
    }
  };

  drain();

  // Sibling units that mutate the closure. Only in the owning scope: a mutator
  // one level out would have to be evaluated *and* protected from inlining, and
  // `sources` - the only channel this has to the passes that do that - cannot
  // carry a path the pruner must not delete. `outerMutation` below turns that
  // case into a refusal instead of a silent wrong answer.
  //
  // `needed` grows while it is walked - a Set iterator visits entries added
  // during iteration - so a name a mutator pulls in has its own mutators taken
  // by the same loop, and the loop ends at the same fixpoint the sweep over
  // every sibling unit used to reach.
  for (const name of needed) {
    const indexes = owner.mutators.byName.get(name);
    if (!indexes) continue;
    for (const index of indexes) {
      if (owner.included.has(index) || index === owner.container) continue;
      owner.included.add(index);
      for (const reference of referencesOf(owner, index)) queue.push({ name: reference, from: 0 });
    }
    drain();
  }

  const borrowedUnsafely = outerMutation(levels, needed);
  const result = assemble(levels, borrowedUnsafely ? 1 : levels.length);
  const unmodelled =
    unmodelledMutation(levels, needed, table) ??
    escapingReference(levels, needed, table) ??
    mutatorAfterUse(levels, needed, roots);
  if (unmodelled) {
    result.unmodelledMutation = unmodelled.name;
    result.unmodelledMutationKind = unmodelled.kind;
  }
  return result;
}

interface UnmodelledMutation {
  name: string;
  kind: UnmodelledMutationKind;
}

/**
 * A reference to a name the slice needs, in code the slice does not run,
 * that the slice cannot account for.
 *
 * The nets in `unmodelledMutation` name the changes a scan of one statement
 * can see: a rotation, a bare assignment, a write through a member, a
 * hand-off to a call. They are an open list. `_0xset([_0xo])`, `_0xset({o:
 * _0xo})`, `_0xset(true ? _0xo : 0)`, `_0xset(_0xo || 0)`, `_0xset(_0xo.c)`,
 * `_0xget().v = 1`, `_0xset\`${_0xo}\``, `_0xset(...[_0xo])`, `yield _0xo`,
 * `var _0xa = _0xo; _0xa.v = 1` all hand the object to code that sets `v`,
 * none is on the list, and each came out inlined with the offset the program
 * had replaced - at every preset, with no diagnostic. Every round of adding
 * shapes to the list finds the shapes next to them.
 *
 * So the rule is written closed. For every name the slice needs whose
 * identity matters - not a primitive, which nothing can change through, and
 * not the table, which `arrayIsImmutable` and `tableIsStable` judge with a
 * message that names the reference - ANY reference in a unit the slice did
 * not take is a refusal, with two exemptions, each proved at the site:
 *
 *  (a) the name is the callee of a call, and it holds a function the slice
 *      took and nothing outside the slice reassigns. Calling a function
 *      cannot change the binding, and the body that runs is in the model.
 *      `_0x113c54(0x1a3)` at every call site; `function _0x47eb76(a) {
 *      return _0x2348(a); }` hoisted above the rotation wrapper.
 *  (b) the name is captured whole - the initialiser of a declarator, or the
 *      right side of a bare `alias = name` whose value goes nowhere else -
 *      and every reference to the alias is itself exempt, by this same rule,
 *      so the alias is inside the model. `var _0x113c54 = _0x2348;` opens
 *      every obfuscator.io build; a `stringArrayWrappersType: 'variable'`
 *      build repeats it inside every function.
 *
 * Anything else - a literal argument, a conditional, a logical, a tagged
 * template, a spread, a yield, a member read, `new`, `typeof` - refuses.
 * What the code it reaches does with the value is not the question; that it
 * reaches code the slice does not run is.
 *
 * Judged at every level the slice drew from, the container unit included
 * with the next level in cut out of it: `var m = (_0xo.v = 1, (function ()
 * { ... })())` writes through a borrowed name from inside the statement that
 * holds the module. A unit the slice took is the model and is not judged.
 */
function escapingReference(
  levels: readonly Level[],
  needed: ReadonlySet<string>,
  table: string | undefined,
): UnmodelledMutation | undefined {
  const owner = levels[0]!;
  const writers = owner.mutators.writersByName();
  for (const name of needed) {
    if (name === table) continue;
    const depth = declaringLevel(levels, name);
    if (depth === -1) continue;
    if (declaredAsPrimitive(levels, name, writers.get(name) ?? [])) continue;
    const callable = holdsTakenFunction(levels, name, depth, writers.get(name) ?? []);
    const found = firstEscape(levels, name, depth, callable);
    if (found) return { name, kind: found };
  }
  return undefined;
}

/** The innermost level whose units declare `name`, or -1. */
function declaringLevel(levels: readonly Level[], name: string): number {
  for (let depth = 0; depth < levels.length; depth++) {
    if (levels[depth]!.declaredBy.has(name)) return depth;
  }
  return -1;
}

/**
 * Whether `name` holds a function the slice took, and nothing the slice did
 * not take reassigns it - the proof exemption (a) needs.
 *
 * Every declaring unit must be in the slice and must bind the name to a
 * function written out - a declaration, or a declarator or bare assignment
 * whose value is a function expression - because that is the value whose
 * body is in the model. An initialiser that merely evaluates to a function
 * (`(function () { return function () {...}; })()`) is not proved here, and a
 * call through such a name refuses. A write inside the value itself is part
 * of it: obfuscator.io's decoder replaces its own binding on first call, and
 * that runs code the slice has. A write in any other unit the slice took is
 * modelled and ordered by `mutatorAfterUse`; one it did not take is the
 * assignment net's refusal before this is ever asked. A borrowed name was
 * proved constant outside its declaration by `pullOuterDeclaration`.
 */
function holdsTakenFunction(
  levels: readonly Level[],
  name: string,
  depth: number,
  writers: readonly number[],
): boolean {
  const level = levels[depth]!;
  const indexes = level.declaredBy.get(name) ?? [];
  if (!indexes.every((index) => level.included.has(index))) return false;
  let bound = false;
  for (const index of indexes) {
    const node = level.units[index]!.statement;
    if (t.isFunctionDeclaration(node)) {
      bound = true;
    } else if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (!t.isIdentifier(declarator.id, { name }) || !declarator.init) continue;
        if (!isFunctionLiteral(declarator.init)) return false;
        bound = true;
      }
    } else if (
      t.isExpressionStatement(node) &&
      t.isAssignmentExpression(node.expression) &&
      t.isIdentifier(node.expression.left, { name })
    ) {
      if (!isFunctionLiteral(node.expression.right)) return false;
      bound = true;
    } else {
      return false;
    }
  }
  if (!bound) return false;
  return depth > 0 || writers.every((index) => level.included.has(index));
}

function isFunctionLiteral(node: t.Node): boolean {
  const bare = stripTypeWrappers(node);
  return t.isFunctionExpression(bare) || t.isArrowFunctionExpression(bare);
}

/**
 * The first reference to `name`, or to anything it is captured into, that
 * neither exemption covers - by level, then by unit, so the diagnostic is
 * the same on every run. `member` when the reference could change the value
 * in place, `escape` for the rest.
 *
 * A unit the slice took is the model and is not judged, but the aliases it
 * declares are followed like any other unit's: `var _0xs = 1, _0xa = _0xo;`
 * is taken for `_0xs` and captures `_0xo` into `_0xa` on the way, and
 * `_0xa.v = 1` in the next statement writes through the name the slice
 * reads `_0xo.v` by. Skipped whole, the capture was never seen and the
 * program's `beta` came out as `alpha`.
 *
 * Only units that could spell the name are visited - `mentionersOf` reads
 * that off the round's scans - and each of those is read through its unit
 * scan, which is exact: a same-named local inside the unit is a different
 * slot and reaches no outer entry.
 */
function firstEscape(
  levels: readonly Level[],
  name: string,
  depth: number,
  callable: boolean,
): UnmodelledMutationKind | undefined {
  const seen = new Set([name]);
  const queue: [string, number][] = [[name, depth]];
  let first: { depth: number; index: number; kind: UnmodelledMutationKind } | undefined;
  const follow = (use: OuterUse): void => {
    for (const alias of use.aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      // An alias declared nowhere is a global, visible everywhere.
      const declared = declaringLevel(levels, alias);
      queue.push([alias, declared === -1 ? levels.length - 1 : declared]);
    }
  };
  while (queue.length > 0) {
    const [current, bound] = queue.shift()!;
    for (let level = 0; level <= bound; level++) {
      const parts = levels[level]!;
      for (const index of unitsNaming(parts, current)) {
        // The scan is the exact test: a same-named local inside the unit is a
        // different slot and reaches no entry here.
        const container = index === parts.container;
        const use = (container ? containerScanOf(parts) : unitScanOf(parts, index)).outer.get(current);
        if (!use) continue;
        follow(use);
        if (parts.included.has(index)) continue;
        let kind: UnmodelledMutationKind | undefined;
        if (use.escapes) kind = use.touches ? 'member' : 'escape';
        else if (use.called && !callable) kind = 'escape';
        if (!kind) continue;
        if (!first || level < first.depth || (level === first.depth && index < first.index)) {
          first = { depth: level, index, kind };
        }
      }
    }
  }
  return first?.kind;
}

/**
 * The units of a level that could reference or declare `name`, ascending: the
 * mention index, the declarers, and the container - whose scan is taken with
 * the inner level cut out, so the index, built from the whole statement, may
 * both over- and under-state what it says about the name. It is always
 * visited.
 */
function unitsNaming(level: Level, name: string): readonly number[] {
  let units = level.mutators.mentionersOf(name);
  const declarers = level.declaredBy.get(name);
  if (declarers) units = mergeAscending(units, declarers);
  if (level.container !== -1 && !units.includes(level.container)) {
    units = mergeAscending(units, [level.container]);
  }
  return units;
}

/**
 * A mutator the slice took that runs AFTER something outside the slice has
 * already used the decoder.
 *
 * The slice is evaluated as a program: every unit it took, in order, and only
 * then is the decoder called. That models a rotation wrapper and an offset set
 * once at load, and nothing else - `log(_0xd(0)); _0xn = 1; log(_0xd(0));`
 * prints `alpha` then `beta`, and the slice, having run `_0xn = 1` before
 * either call, inlines `beta` at both. Both tiers agree, every preset, no
 * diagnostic. Order is not something the slice can reproduce for a call site
 * it does not evaluate, so a call site that can run before a taken mutator is
 * a refusal, not a modelling question.
 *
 * A mutator, here, is any unit the slice took that changes a needed name when
 * it runs - not only the ones the mutator search took it FOR. `var _0xs =
 * (_0xn = 1, 5)` and `var _0xs = _0xn++` are in the slice because `_0xs` is
 * needed, and set `_0xn` on the way; `var _0xs = 1` and `var _0xt = [...]` give
 * a name its value where they stand, and a call ahead of them reads
 * `undefined` or throws. Each of those was inlined with the value from after
 * the unit. A function declaration is hoisted and gives nothing a value by
 * running; everything else that writes, initialises, rotates or touches a
 * needed name is ordered.
 *
 * "Can run before" is judged textually at the level's unit granularity,
 * because that is the granularity the slice takes mutators at: a unit before
 * the last taken mutator that USES a root - or uses anything that leads to a
 * root, through as many declarations and captures as it takes, so that
 * `main()` before the mutator counts when `function main() { _0xd(0) }` is
 * after it - has a use the slice would decode with a value it never sees.
 * Units the slice took are its own machinery and exempt; the rotation wrapper
 * calls the decoder from inside, and that call is part of the value.
 *
 * A use is any reference but a capture into a name of the level, which is
 * followed by that name instead. obfuscator.io opens every build with `var
 * _0x113c54 = _0x2348;`, one statement ahead of the rotation wrapper: that
 * holds the decoder, it does not run it, and the calls through the alias all
 * come later. Refusing it would refuse every build there is. A capture IS a
 * use when a later mutator rewrites the captured name itself: `var _0xa =
 * _0xd; _0xd = function () {...}; _0xa(0)` calls the function the alias kept,
 * and the slice has only the one that replaced it.
 *
 * Only the unit's own function declaration, and a function it captures at
 * its top into a name of the level, are deferred - by the name that holds
 * them, which `reaches` follows. `function _0x47eb76() { return _0x349f(...);
 * }` is how a `stringArrayWrappersType: 'function'` build opens, hoisted
 * above the wrapper, and it runs nothing until `_0x47eb76(...)` does. A
 * function anywhere else - nested in a block, an IIFE, a callback, a method
 * of a literal - may run where it stands and is read as if it does: `{
 * function _0xmain() { _0xd(0) } _0xmain(); }` runs the decoder inside the
 * block, and a declaration deferred by name would be followed to nothing,
 * because the block's name is not the level's.
 *
 * Asked at every level. An enclosing level's machinery is reached through
 * the container: by name, when the container is a function declaration or a
 * function captured at its top - `main()` ahead of `var _0xs = 1` runs the
 * module before the offset exists - and where it stands otherwise, so that
 * a borrowed initialiser textually after a module IIFE is a use ahead of it.
 */
function mutatorAfterUse(
  levels: readonly Level[],
  needed: ReadonlySet<string>,
  roots: readonly string[],
): UnmodelledMutation | undefined {
  const writers = levels[0]!.mutators.writersByName();
  // What a touch can change: nothing, for a primitive. The table is included
  // - inside the slice its audit no longer sees a method called on it.
  const touchable = new Set<string>();
  for (const name of needed) {
    if (declaringLevel(levels, name) === -1) continue;
    if (!declaredAsPrimitive(levels, name, writers.get(name) ?? [])) touchable.add(name);
  }
  for (let depth = 0; depth < levels.length; depth++) {
    const level = levels[depth]!;
    if (level.included.size === 0) continue;
    const entry = depth === 0 ? { roots } : containerEntry(level);
    const found = orderedUse(level, needed, touchable, entry);
    if (found) return found;
  }
  return undefined;
}

/** How a level's machinery comes to run: through these names, or where `inPlace` stands. */
interface Entry {
  roots: readonly string[];
  inPlace?: number;
}

/**
 * How the container of an enclosing level runs the level within it.
 *
 * The outermost function between the two scopes decides. The container's own
 * function declaration, or a function it captures at its top into a name of
 * the level, runs when that name is called: the name is the root. Anything
 * else - an IIFE, a callback, a method, no function at all - is read as
 * running where the container stands, which is the conservative reading for
 * a callback too: run at once, a borrowed initialiser after the container is
 * too late; run later, it is not, and refusing covers both.
 */
function containerEntry(level: Level): Entry {
  const container = level.units[level.container];
  if (!container || !level.inner) return { roots: [] };
  let outermost: NodePath | undefined;
  for (let current: NodePath | null = level.inner; current; current = current.parentPath) {
    if (current.isFunction()) outermost = current;
    // The container itself may be the function declaration.
    if (current.node === container.path.node) break;
  }
  if (outermost && isDeferredAtTop(outermost, container.path.node)) {
    const roots: string[] = [];
    for (const [name, indexes] of level.declaredBy) {
      if (indexes.includes(level.container)) roots.push(name);
    }
    return { roots };
  }
  return { roots: [], inPlace: level.container };
}

/**
 * Whether a function runs only by the name a unit binds it to: the unit's
 * own declaration, or an expression captured by a declarator or bare
 * assignment that is the unit's top-level statement.
 */
function isDeferredAtTop(fn: NodePath, unit: t.Node): boolean {
  if (fn.isFunctionDeclaration()) return fn.node === unit;
  const parent = fn.parentPath;
  if (!parent) return false;
  if (parent.isVariableDeclarator() && parent.node.init === fn.node && t.isIdentifier(parent.node.id)) {
    return parent.parentPath?.node === unit;
  }
  if (
    parent.isAssignmentExpression() &&
    parent.node.operator === '=' &&
    parent.node.right === fn.node &&
    t.isIdentifier(parent.node.left)
  ) {
    if (parent.node === unit) return true;
    const statement = parent.parentPath;
    return statement !== null && statement.isExpressionStatement() && statement.node === unit;
  }
  return false;
}

function orderedUse(
  level: Level,
  needed: ReadonlySet<string>,
  touchable: ReadonlySet<string>,
  entry: Entry,
): UnmodelledMutation | undefined {
  const changed = (index: number): Set<string> => changedNames(level, index, needed, touchable);
  const mutators: number[] = [];
  for (const index of level.included) {
    if (index !== level.container && changed(index).size > 0) mutators.push(index);
  }
  if (mutators.length === 0) return undefined;
  const last = Math.max(...mutators);
  // Blame the first mutator the use runs ahead of, by the first needed name
  // it changes: the same answer on every run.
  const blame = (index: number): UnmodelledMutation => {
    const mutator = Math.min(...mutators.filter((m) => m > index));
    for (const name of needed) {
      if (changed(mutator).has(name)) return { name, kind: 'order' };
    }
    throw new Error('a taken mutator changes no needed name');
  };
  if (entry.inPlace !== undefined && entry.inPlace < last) return blame(entry.inPlace);

  const before: number[] = [];
  for (let index = 0; index < last; index++) {
    if (!level.included.has(index) && index !== level.container) before.push(index);
  }
  // The usual layout - table, wrapper, decoder, program - has nothing here,
  // and the closure below costs a scan of every unit that names a root; not
  // paid unless there is a unit it could indict.
  if (before.length === 0 || entry.roots.length === 0) return undefined;

  // Every name that can lead to a root, transitively through the level's own
  // declarations and captures: `var api = { f() { return _0xd(0); } }` makes
  // `api` one, and `_0xg = _0xd` inside any unit makes `_0xg` one - a unit the
  // slice took included. `var _0xs = 1, _0xa = _0xd;` is taken for `_0xs`,
  // and `_0xa(0)` ahead of the mutator is a use of the decoder; grown from
  // outside units only, `_0xa` never joined the set and both calls came out
  // with the value from after the mutator.
  const reaches = new Set(entry.roots);
  const outside = (index: number): boolean => !level.included.has(index) && index !== level.container;
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, indexes] of level.declaredBy) {
      if (reaches.has(name)) continue;
      if (indexes.some((index) => outside(index) && mentionsAny(level, index, reaches))) {
        reaches.add(name);
        grew = true;
      }
    }
    for (let index = 0; index < level.units.length; index++) {
      if (index === level.container || !mentionsAny(level, index, reaches)) continue;
      const scan = unitScanOf(level, index);
      for (const [name, use] of scan.outer) {
        if (!reaches.has(name)) continue;
        for (const alias of use.aliases) {
          if (reaches.has(alias)) continue;
          reaches.add(alias);
          grew = true;
        }
      }
    }
  }

  for (const index of before) {
    if (!mentionsAny(level, index, reaches)) continue;
    const scan = unitScanOf(level, index);
    for (const name of reaches) {
      const use = scan.outer.get(name);
      if (!use) continue;
      if (use.usedNow) return blame(index);
      if (!use.capturedNow) continue;
      // The alias keeps the value this name held when the capture ran; a
      // later mutator that rebinds the name leaves the alias with a value
      // the slice never produces.
      for (const mutator of mutators) {
        if (mutator <= index) continue;
        const effects = unitScanOf(level, mutator).runtime;
        if (effects.writes.has(name) || effects.initialised.has(name)) return blame(index);
      }
    }
  }
  return undefined;
}

/**
 * The needed names running a unit changes: the ones the mutator search took
 * it for, plus what its own effects say - a bare write, an initialiser, a
 * touch on a name whose value can be changed through, a rotation of anything
 * it names.
 */
function changedNames(
  level: Level,
  index: number,
  needed: ReadonlySet<string>,
  touchable: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>();
  for (const name of needed) {
    if (level.mutators.byName.get(name)?.includes(index)) names.add(name);
  }
  const { outer, runtime } = unitScanOf(level, index);
  for (const name of runtime.writes) if (needed.has(name)) names.add(name);
  for (const name of runtime.initialised) if (needed.has(name)) names.add(name);
  for (const name of runtime.touches) if (touchable.has(name)) names.add(name);
  if (runtime.shuffles) {
    for (const name of outer.keys()) if (needed.has(name)) names.add(name);
  }
  return names;
}

/**
 * Whether the unit references or declares any of `names`. The statement scan
 * rules most units out without a walk; the unit scan, kept for the round,
 * answers exactly for the rest - a same-named local inside the unit is a
 * different slot and is not among its outer names.
 */
function mentionsAny(level: Level, index: number, names: ReadonlySet<string>): boolean {
  for (const name of names) {
    if (level.declaredBy.get(name)?.includes(index)) return true;
  }
  if (!level.mutators.mentionsAny(index, names)) return false;
  const { outer } = unitScanOf(level, index);
  for (const name of names) {
    if (outer.has(name)) return true;
  }
  return false;
}

/** The unit's scan, computed once per round; see `scanUnit`. */
function unitScanOf(level: Level, index: number): UnitScan {
  let scan = level.scans.get(index);
  if (!scan) {
    scan = scanUnit(level.units[index]!);
    level.scans.set(index, scan);
  }
  return scan;
}

/**
 * The container's scan with the level inside it cut out, so that what the
 * container does around the module is judged and what the module does is
 * left to the module's own levels.
 */
function containerScanOf(level: Level): UnitScan {
  const inner = level.inner!;
  let scan = level.containerScans.get(inner.node);
  if (!scan) {
    scan = scanUnit(level.units[level.container]!, inner.node);
    level.containerScans.set(inner.node, scan);
  }
  return scan;
}

// ---------------------------------------------------------------------------
// What one unit does with the names outside it
// ---------------------------------------------------------------------------

/**
 * Every name a unit reaches outside its own nested scopes - its free names,
 * and the names its own top-level declarations bind, which are names of the
 * level - with how it reaches each, plus what running it changes.
 *
 * One scope-aware walk per unit per round, cached beside the free-variable
 * set, because three questions want it for every sibling of every candidate:
 * whether a reference is one the closed rule exempts, whether a unit uses a
 * root before a mutator, and which names a taken unit changes when it runs.
 * A same-named local inside the unit is a different name; Babel's scope
 * analysis on a throwaway program says which is which, as in `freeVariables`.
 *
 * A capture into a local - `var _0x7 = _0x2348;` inside a function - is
 * followed inside the walk: the local's own references are counted as the
 * captured name's, so a member write through the local is a write through
 * the name. A capture into a name of the level is reported as an alias, for
 * the level-wide audit to follow across units; a `var` hoisted out of a
 * nested block is both.
 *
 * "Now" is what runs when the unit runs: everything outside a function that
 * is deferred by name - the unit's own function declaration, or a function
 * captured at the unit's top into a name of the level. A function anywhere
 * else is read as running where it stands.
 */
interface UnitScan {
  outer: Map<string, OuterUse>;
  runtime: RuntimeEffects;
}

interface OuterUse {
  /** Referenced in a position that is neither a direct call nor a capture, anywhere in the unit. */
  escapes: boolean;
  /** ...and in one that can change the value in place: a member write, a `delete`, a method receiver, a call argument, a `with`. */
  touches: boolean;
  /** Referenced as the callee of a call, anywhere in the unit. */
  called: boolean;
  /** Referenced other than by a capture into a name of the level, in code that runs with the unit. */
  usedNow: boolean;
  /** Captured into a name of the level, in code that runs with the unit. */
  capturedNow: boolean;
  /** Names of the level the value is captured into. */
  aliases: Set<string>;
}

interface RuntimeEffects {
  /** Names of the level assigned or updated as bare identifiers when the unit runs. */
  writes: Set<string>;
  /** Names of the level a declarator with an initialiser, or a lexical declaration, gives a value when the unit runs. */
  initialised: Set<string>;
  /** Names of the level touched through - see `OuterUse.touches` - when the unit runs. */
  touches: Set<string>;
  /** Whether a `push(shift())` runs with the unit. */
  shuffles: boolean;
}

/** One name's record while the walk runs; bindings inside the unit have one too, so a local alias can be folded into what it aliases. */
interface Slot {
  name: string;
  /** A name of the level or beyond, rather than a binding inside the unit. */
  outer: boolean;
  escapes: boolean;
  touches: boolean;
  touchesNow: boolean;
  called: boolean;
  usedNow: boolean;
  capturedNow: boolean;
  /** Slots this slot's value is captured into. */
  aliases: Set<Slot>;
}

type Role =
  | { kind: 'binding' }
  | { kind: 'call' }
  | { kind: 'capture'; alias: NodePath<t.Identifier> }
  | { kind: 'write' }
  | { kind: 'update' }
  | { kind: 'touch' }
  | { kind: 'escape' };

/**
 * Walked in place, on the tree's own paths and scopes, rather than as a clone
 * rebuilt into a throwaway program: the clone cost a copy and a scope crawl
 * of every unit that names a needed name, once per round, and for a module
 * IIFE holding the level it cut out that was a copy of the whole module. A
 * binding is inside the unit when its scope sits under the unit's own path;
 * anything else - a name of the level, of an enclosing level, a global - is
 * outer. `skip` is the node of the level inside a container unit, passed over
 * whole so the container is judged and the module left to its own levels.
 * The root is handled by hand, because `path.traverse` visits descendants
 * only and a unit that IS a function declaration is deferred from its root.
 */
function scanUnit(unit: Unit, skip?: t.Node): UnitScan {
  const root = unit.path;
  const slots = new Map<Binding | string, Slot>();
  const deferred = new Set<t.Node>();
  let depth = 0;
  const runtime: RuntimeEffects = {
    writes: new Set(),
    initialised: new Set(),
    touches: new Set(),
    shuffles: false,
  };

  const insideMemo = new Map<Scope, boolean>();
  const inside = (scope: Scope): boolean => {
    let answer = insideMemo.get(scope);
    if (answer === undefined) {
      answer = false;
      for (let current: NodePath | null = scope.path; current; current = current.parentPath) {
        if (current.node === root.node) {
          answer = true;
          break;
        }
      }
      insideMemo.set(scope, answer);
    }
    return answer;
  };

  const slotOf = (name: string, scope: Scope): Slot => {
    const binding = scope.getBinding(name);
    const key = binding ?? name;
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        name,
        outer: !binding || !inside(binding.scope),
        escapes: false,
        touches: false,
        touchesNow: false,
        called: false,
        usedNow: false,
        capturedNow: false,
        aliases: new Set(),
      };
      slots.set(key, slot);
    }
    return slot;
  };

  const enterFunction = (path: NodePath<t.Function>): void => {
    if (isDeferredAtTop(path, root.node)) {
      deferred.add(path.node);
      depth++;
    }
  };
  const onDeclarator = (path: NodePath<t.VariableDeclarator>): void => {
    if (depth > 0) return;
    const declaration = path.parentPath;
    const lexical = declaration.isVariableDeclaration() && declaration.node.kind !== 'var';
    if (!path.node.init && !lexical) return;
    for (const name of Object.keys(t.getBindingIdentifiers(path.node.id))) {
      if (slotOf(name, path.scope).outer) runtime.initialised.add(name);
    }
  };
  const onClass = (path: NodePath<t.ClassDeclaration>): void => {
    if (depth > 0 || !path.node.id) return;
    const name = path.node.id.name;
    if (slotOf(name, path.scope).outer) runtime.initialised.add(name);
  };
  const onCall = (path: NodePath<t.CallExpression>): void => {
    if (depth > 0) return;
    const node = path.node;
    if (isMethodCall(node, 'push') && node.arguments.length === 1 && isMethodCall(node.arguments[0], 'shift')) {
      runtime.shuffles = true;
    }
  };
  const onIdentifier = (path: NodePath<t.Identifier>): void => {
    const role = roleOf(path);
    if (role.kind === 'binding') return;
    if (role.kind !== 'write' && role.kind !== 'update' && !path.isReferencedIdentifier()) return;
    const slot = slotOf(path.node.name, path.scope);
    const now = depth === 0;
    switch (role.kind) {
      case 'call':
        slot.called = true;
        if (now) slot.usedNow = true;
        break;
      case 'capture': {
        const alias = slotOf(role.alias.node.name, role.alias.scope);
        if (alias === slot) break;
        slot.aliases.add(alias);
        if (alias.outer && now) slot.capturedNow = true;
        break;
      }
      case 'write':
        if (now && slot.outer) runtime.writes.add(slot.name);
        break;
      case 'update':
        slot.escapes = true;
        if (now) slot.usedNow = true;
        if (now && slot.outer) runtime.writes.add(slot.name);
        break;
      case 'touch':
        slot.escapes = true;
        slot.touches = true;
        if (now) {
          slot.usedNow = true;
          slot.touchesNow = true;
        }
        break;
      case 'escape':
        slot.escapes = true;
        if (now) slot.usedNow = true;
        break;
      default:
        break;
    }
  };
  const onJsxIdentifier = (path: NodePath<t.JSXIdentifier>): void => {
    // `<_0xd />` and `<_0xd.x />` read the binding; `<div>` is a tag, and
    // an attribute name or a namespace is no reference at all.
    const parent = path.parentPath;
    const element = parent.isJSXOpeningElement() || parent.isJSXClosingElement();
    const rooted = parent.isJSXMemberExpression() && parent.node.object === path.node;
    if (!rooted && !(element && parent.node.name === path.node)) return;
    if (!rooted && /^[a-z]/.test(path.node.name)) return;
    const slot = slotOf(path.node.name, path.scope);
    slot.escapes = true;
    if (depth === 0) slot.usedNow = true;
  };

  // The root: a function declaration, a class, or - split out of a comma
  // sequence - a bare call, identifier or function expression.
  if (root.isFunction()) enterFunction(root);
  else if (root.isClassDeclaration()) onClass(root);
  else if (root.isCallExpression()) onCall(root);
  else if (root.isIdentifier()) onIdentifier(root);
  else if (root.isJSXIdentifier()) onJsxIdentifier(root);

  root.traverse({
    enter(path) {
      if (path.node === skip) path.skip();
    },
    Function: {
      enter: enterFunction,
      exit(path) {
        if (deferred.has(path.node)) depth--;
      },
    },
    VariableDeclarator: onDeclarator,
    ClassDeclaration: onClass,
    CallExpression: onCall,
    Identifier: onIdentifier,
    JSXIdentifier: onJsxIdentifier,
  });

  // An alias's references inside this unit are the name's own, through as
  // many captures as it takes; an alias that is a name of the level is also
  // reported, for the audit to follow into the other units.
  const outer = new Map<string, OuterUse>();
  for (const slot of slots.values()) {
    if (!slot.outer) continue;
    const use: OuterUse = {
      escapes: slot.escapes,
      touches: slot.touches,
      called: slot.called,
      usedNow: slot.usedNow,
      capturedNow: slot.capturedNow,
      aliases: new Set(),
    };
    let touchesNow = slot.touchesNow;
    const seen = new Set<Slot>([slot]);
    const queue = [...slot.aliases];
    while (queue.length > 0) {
      const alias = queue.shift()!;
      if (seen.has(alias)) continue;
      seen.add(alias);
      if (alias.outer) use.aliases.add(alias.name);
      use.escapes ||= alias.escapes;
      use.touches ||= alias.touches;
      use.called ||= alias.called;
      use.usedNow ||= alias.usedNow;
      use.capturedNow ||= alias.capturedNow;
      touchesNow ||= alias.touchesNow;
      queue.push(...alias.aliases);
    }
    outer.set(slot.name, use);
    if (touchesNow) runtime.touches.add(slot.name);
  }
  return { outer, runtime };
}

/**
 * What position an identifier is in, looking up from it: through the type
 * wrappers that erase at run time, up the member chain it roots, up any
 * destructuring pattern it sits in, to the node that consumes the result.
 */
function roleOf(path: NodePath<t.Identifier>): Role {
  let top: NodePath = climbTypeWrappers(path);
  let member = false;
  while (
    top.parentPath &&
    (top.parentPath.isMemberExpression() || top.parentPath.isOptionalMemberExpression()) &&
    top.parentPath.node.object === top.node
  ) {
    top = climbTypeWrappers(top.parentPath);
    member = true;
  }
  let pattern = false;
  for (;;) {
    const parent = top.parentPath;
    if (!parent) break;
    if (parent.isArrayPattern() || parent.isRestElement()) {
      top = parent;
    } else if (parent.isAssignmentPattern() && parent.node.left === top.node) {
      top = parent;
    } else if (parent.isObjectProperty() && parent.node.value === top.node && parent.parentPath?.isObjectPattern()) {
      top = parent.parentPath;
    } else {
      break;
    }
    pattern = true;
  }
  const parent = top.parentPath;
  if (!parent) return { kind: 'escape' };

  if (parent.isVariableDeclarator()) {
    if (parent.node.id === top.node) return { kind: 'binding' };
    if (!member && !pattern && t.isIdentifier(parent.node.id)) {
      return { kind: 'capture', alias: parent.get('id') as NodePath<t.Identifier> };
    }
    return { kind: 'escape' };
  }
  if (parent.isAssignmentExpression()) {
    if (parent.node.left === top.node) {
      if (member) return { kind: 'touch' };
      return pattern || parent.node.operator === '=' ? { kind: 'write' } : { kind: 'update' };
    }
    if (!member && !pattern && parent.node.operator === '=' && t.isIdentifier(parent.node.left) && valueDiscarded(parent)) {
      return { kind: 'capture', alias: parent.get('left') as NodePath<t.Identifier> };
    }
    return { kind: 'escape' };
  }
  if ((parent.isForInStatement() || parent.isForOfStatement()) && parent.node.left === top.node) {
    return member ? { kind: 'touch' } : { kind: 'write' };
  }
  if (parent.isCatchClause() || (parent.isFunction() && parent.node.params.includes(top.node as t.Identifier))) {
    return { kind: 'binding' };
  }
  if (pattern) return { kind: 'escape' };
  if (member) {
    if (parent.isUpdateExpression()) return { kind: 'touch' };
    if (parent.isUnaryExpression() && parent.node.operator === 'delete') return { kind: 'touch' };
    if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.callee === top.node) {
      return { kind: 'touch' };
    }
    return { kind: 'escape' };
  }
  if (
    parent.isFunctionDeclaration() ||
    parent.isFunctionExpression() ||
    parent.isClassDeclaration() ||
    parent.isClassExpression()
  ) {
    if ((parent.node as t.FunctionDeclaration).id === top.node) return { kind: 'binding' };
  }
  if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.callee === top.node) {
    return { kind: 'call' };
  }
  if (parent.isNewExpression() && parent.node.callee === top.node) return { kind: 'escape' };
  if (parent.isCallExpression() || parent.isOptionalCallExpression() || parent.isNewExpression()) {
    return { kind: 'touch' };
  }
  if (parent.isSpreadElement() && parent.parentPath) {
    const call = parent.parentPath;
    if (call.isCallExpression() || call.isOptionalCallExpression() || call.isNewExpression()) return { kind: 'touch' };
  }
  if (parent.isWithStatement() && parent.node.object === top.node) return { kind: 'touch' };
  if (parent.isUpdateExpression()) return { kind: 'update' };
  return { kind: 'escape' };
}

function climbTypeWrappers(path: NodePath): NodePath {
  let current = path;
  while (
    current.parentPath &&
    isTypeWrapper(current.parentPath.node) &&
    (current.parentPath.node as { expression: t.Node }).expression === current.node
  ) {
    current = current.parentPath;
  }
  return current;
}

function isTypeWrapper(node: t.Node): boolean {
  switch (node.type) {
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'TSSatisfiesExpression':
    case 'TSInstantiationExpression':
    case 'TypeCastExpression':
      return true;
    default:
      return false;
  }
}

/**
 * Whether an assignment's value goes nowhere: it is a statement of its own,
 * an operand of a comma sequence other than the last, or a `for` head's
 * initialiser or update. `x = a = N` and `f(a = N)` hand the value on.
 */
function valueDiscarded(assignment: NodePath): boolean {
  let current: NodePath = assignment;
  for (;;) {
    const parent = current.parentPath;
    if (!parent) return false;
    if (parent.isExpressionStatement()) return true;
    if (parent.isSequenceExpression()) {
      const expressions = parent.node.expressions;
      if (expressions[expressions.length - 1] !== current.node) return true;
      current = parent;
      continue;
    }
    if (parent.isForStatement()) return parent.node.init === current.node || parent.node.update === current.node;
    return false;
  }
}

/**
 * A sibling that reorders one of the slice's tables and that `isMutator` could
 * not take.
 *
 * `isMutator` recognises the rotation wrapper in the shape obfuscator.io emits
 * it: an expression *statement* whose expression is an IIFE. A post-pass that
 * folds a whole program initialisation into one `for (a, b, c; ...);` head leaves
 * the very same wrapper as the second operand of a comma sequence, where it is
 * not a statement and the statement-granular slicer cannot take it - so the
 * slice comes out looking clean while missing the 184 rotations the table
 * actually gets. Measured on the 448 KB fixture: index 152 decodes to
 * `'0|1|5|2|7|4|3|6'` with the rotation missed and `'responseText'` with it
 * applied, and nothing downstream can tell the two apart.
 *
 * The search is for the shuffle itself rather than for a wrapper shape, because
 * what makes the answer wrong is the `push(shift())`, however it is spelled.
 * Each statement is scanned for both facts at once - does it shuffle, what does
 * it name - and the names are indexed per round, so a program with hundreds of
 * candidates is walked once for this and not once per candidate.
 *
 * Only names the slice DECLARES can be its tables. `needed` also holds every
 * builtin the slice reads - `referencesOf` keeps them so that a shadowing
 * declaration is found - and a shuffler that merely shares `parseInt` with
 * the slice cannot reach a table of it. Matching those refused every table in
 * two concatenated obfuscator.io programs: each program's own rotation wrapper
 * is taken as a mutator, and the other program's, which touches none of this
 * program's names, was flagged for the `parseInt` inside it.
 *
 * The second net is for a plain ASSIGNMENT the mutator search could not take:
 * a `for (var i ...) { _0xn = 1 }` that hoists a binding the pruner would delete
 * with it, a compound statement over the node budget or one that `return`s,
 * a sibling function that assigns the offset. Each of those leaves the slice
 * agreeing with itself - both tiers see `_0xn = 0` - on a program that runs
 * with `_0xn = 1`, and the output prints strings from the slot next door;
 * nothing else in the pipeline audits a name that is not the table. An
 * assignment names its target, so this arm is keyed on the exact name written
 * rather than on every name the unit mentions.
 *
 * The third is the same question asked of a write THROUGH a name: `_0xo.v =
 * 1` before `var _0xs = _0xo.v`, `_0xo.push(1)`, `delete _0xo.v`,
 * `_0xr.test(s)` before a read of `_0xr.lastIndex`, `Object.defineProperty(
 * _0xo, ...)`, `_0xo.__proto__ = _0xp`. None of them is a unit the search
 * takes, and with none of them in the slice both tiers read the object as
 * declared. Keyed on the root name, with two exemptions that are exact rather
 * than convenient. The table is `arrayIsImmutable`'s and `tableIsStable`'s:
 * they judge every reference to it and name the offending one, and refusing
 * it here first would only replace their message with a vaguer one. A name
 * declared to a primitive cannot be changed through: `_0xn.x = 1` on a number
 * is a no-op or a `TypeError`, never a new value for `_0xn`, and a bare
 * reassignment of it is the second net's.
 */
function unmodelledMutation(
  levels: readonly Level[],
  needed: ReadonlySet<string>,
  table: string | undefined,
): UnmodelledMutation | undefined {
  const owner = levels[0]!;
  const declared = (name: string): boolean => levels.some((level) => level.declaredBy.has(name));
  const shufflers = owner.mutators.shufflersByName();
  const writers = owner.mutators.writersByName();
  const touchers = owner.mutators.touchersByName();
  const nets: [ReadonlyMap<string, number[]>, UnmodelledMutationKind][] = [
    [shufflers, 'shuffle'],
    [writers, 'assignment'],
    [touchers, 'member'],
  ];
  const touchable = (name: string): boolean =>
    name !== table && !declaredAsPrimitive(levels, name, writers.get(name) ?? []);
  // A unit that shuffles and mentions a needed name is a shuffler of it unless
  // every rotation in it is of a table of its own: a name the slice does not
  // need, declared at this level as a table - an array, or a function that
  // holds one - by a unit that does not mention the slice's table, so it
  // cannot hand that table back under another name. The rotation wrapper of
  // the layer beneath a stacked build is exactly that unit: it rotates its
  // own table, whose function spells its entries in calls to the decoder
  // above, and names that decoder in the aliases it reads with.
  const rotatesElsewhere = (index: number): boolean => {
    const rotated = owner.mutators.rotatedBy(index);
    if (!rotated || rotated.size === 0) return false;
    for (const subject of rotated) {
      if (needed.has(subject)) return false;
      const declaring = owner.declaredBy.get(subject);
      if (!declaring || declaring.length !== 1 || declaring[0] === index) return false;
      if (!declaresATable(owner.units[declaring[0]!]!.statement, subject)) return false;
      if (table === undefined ? owner.mutators.mentionsAny(declaring[0]!, needed) : owner.mutators.mentionsAny(declaring[0]!, new Set([table]))) {
        return false;
      }
    }
    return true;
  };
  const unitsTouching = (name: string): number[] => [
    ...(shufflers.get(name) ?? []).filter((index) => !rotatesElsewhere(index)),
    ...(writers.get(name) ?? []),
    ...(touchable(name) ? (touchers.get(name) ?? []) : []),
  ];
  let first = -1;
  for (const name of needed) {
    if (!declared(name)) continue;
    for (const index of unitsTouching(name)) {
      if (owner.included.has(index) || index === owner.container) continue;
      if (first === -1 || index < first) first = index;
    }
  }
  if (first === -1) return undefined;
  // `needed` is in discovery order, so the root is named before any name the
  // closure pulled in and the diagnostic is the same on every run. A unit
  // that does more than one thing to a name is reported by the gravest: a
  // rotation wrapper assigns inside itself too, and the rotation is the fact.
  for (const [net, kind] of nets) {
    for (const name of needed) {
      if (!declared(name)) continue;
      if (kind === 'member' && !touchable(name)) continue;
      if (kind === 'shuffle' && rotatesElsewhere(first)) continue;
      if (net.get(name)?.includes(first)) return { name, kind };
    }
  }
  return undefined;
}

/**
 * Whether a statement declares `name` as a table: an array literal, or a
 * function - declared, or held by the name - whose body holds one.
 */
function declaresATable(statement: t.Statement, name: string): boolean {
  if (t.isFunctionDeclaration(statement)) {
    return statement.id?.name === name && holdsAnArrayLiteral(statement.body);
  }
  if (!t.isVariableDeclaration(statement)) return false;
  for (const declarator of statement.declarations) {
    if (!t.isIdentifier(declarator.id, { name }) || !declarator.init) continue;
    const init = declarator.init;
    if (t.isArrayExpression(init)) return true;
    return (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) && holdsAnArrayLiteral(init.body);
  }
  return false;
}

function holdsAnArrayLiteral(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (current) => {
    if (t.isArrayExpression(current) && current.elements.length > 0) found = true;
  });
  return found;
}

/**
 * Whether `name` only ever holds a value with no identity - a literal, or
 * arithmetic over literals - so that nothing reached through the name can be
 * the name's next value. Every declaration the slice can see must say so, and
 * so must every unit of the owning scope that assigns the name: a taken
 * `_0xn = 1` keeps it primitive, a taken `_0xn = _0xo` does not, and a writer
 * the slice did not take is the assignment net's refusal whatever it assigns.
 */
function declaredAsPrimitive(
  levels: readonly Level[],
  name: string,
  writers: readonly number[],
): boolean {
  const owner = levels[0]!;
  const primitiveWrite = (index: number): boolean => {
    if (!owner.included.has(index)) return false;
    const node = owner.units[index]!.statement;
    if (!t.isExpressionStatement(node)) return false;
    const expression = node.expression;
    if (t.isUpdateExpression(expression)) return t.isIdentifier(expression.argument, { name });
    if (!t.isAssignmentExpression(expression) || !t.isIdentifier(expression.left, { name })) return false;
    return isPrimitiveConstant(expression.right);
  };
  if (!writers.every(primitiveWrite)) return false;

  for (const level of levels) {
    const indexes = level.declaredBy.get(name);
    if (!indexes) continue;
    return indexes.every((index) => {
      const node = level.units[index]!.statement;
      if (!t.isVariableDeclaration(node)) return false;
      return node.declarations.every((declarator) => {
        if (!t.isIdentifier(declarator.id) || declarator.id.name !== name) return true;
        return !declarator.init || isPrimitiveConstant(declarator.init);
      });
    });
  }
  return false;
}

function isPrimitiveConstant(node: t.Node): boolean {
  const bare = stripTypeWrappers(node);
  if (t.isNumericLiteral(bare) || t.isStringLiteral(bare) || t.isBooleanLiteral(bare)) return true;
  if (t.isNullLiteral(bare) || t.isBigIntLiteral(bare)) return true;
  if (t.isTemplateLiteral(bare)) return bare.expressions.length === 0;
  if (t.isUnaryExpression(bare)) {
    return ['-', '+', '!', '~', 'typeof', 'void'].includes(bare.operator) && isPrimitiveConstant(bare.argument);
  }
  if (t.isBinaryExpression(bare)) {
    return t.isExpression(bare.left) && isPrimitiveConstant(bare.left) && isPrimitiveConstant(bare.right);
  }
  return false;
}

/**
 * Whether a statement shuffles an array, and every name it mentions.
 *
 * Deliberately *not* subject to the node budget the mutator search uses. The
 * statement that matters here is precisely the enormous one: a whole program
 * initialisation folded into a single `for (...91 expressions...; test; update);`
 * head, with the rotation wrapper as one operand somewhere in the middle.
 * Skipping it for being large is how the missed rotation stays invisible. One
 * walk of it is a few milliseconds; a wrong table is permanent.
 *
 * A hard cap still exists so an adversarial input cannot dictate the running
 * time. Exhausting it means "no shuffle in the first million nodes", which is
 * reported as no finding - `tableIsStable` in `strings.discover` is the
 * reference-level net behind this one.
 */
function scanStatement(root: t.Node): StatementScan {
  let shuffles = false;
  const names = new Set<string>();
  const writes = new Set<string>();
  const touches = new Set<string>();
  // For `rotated`: the rotated locals, what each declared name of the
  // statement is initialised from (`null` once a name is declared twice), and
  // an IIFE's parameters against the identifiers it is called with.
  const subjects: (string | null)[] = [];
  const inits = new Map<string, t.Node | null>();
  const bound = iifeArguments(root);

  const stack: t.Node[] = [root];
  let budget = MAX_ROTATION_SCAN_NODES;
  // One dispatch on the type tag per node, not one `t.isX` per question: this
  // walk visits every node of a folded program initialisation, and almost
  // none of them is an identifier, a call or a write.
  while (stack.length > 0 && budget > 0) {
    budget--;
    const node = stack.pop()!;
    switch (node.type) {
      case 'Identifier':
        names.add(node.name);
        break;
      case 'VariableDeclarator':
        if (t.isIdentifier(node.id)) inits.set(node.id.name, inits.has(node.id.name) ? null : (node.init ?? null));
        break;
      // `<_0xd />`, `</_0xd>` and `<_0xo.C />` read a binding through a
      // JSXIdentifier, which is not an Identifier: spelled only there, a
      // unit was absent from `mentionersOf` and the escape audit never
      // opened it, so `render(<_0xa />)` decoded where `render(_0xa)`
      // refused. Tags and attribute names are added too; a mention is a
      // superset the exact unit scan narrows, never a finding.
      case 'JSXIdentifier':
        names.add(node.name);
        break;
      case 'CallExpression':
        if (isMethodCall(node, 'push') && node.arguments.length === 1 && isMethodCall(node.arguments[0], 'shift')) {
          shuffles = true;
          const receiver = (stripTypeWrappers(node) as t.CallExpression).callee as t.MemberExpression;
          subjects.push(t.isIdentifier(receiver.object) ? receiver.object.name : null);
        }
        for (const name of touchedRoots(node)) touches.add(name);
        break;
      case 'OptionalCallExpression':
      case 'NewExpression':
      case 'UnaryExpression':
      case 'WithStatement':
        for (const name of touchedRoots(node)) touches.add(name);
        break;
      case 'AssignmentExpression':
      case 'UpdateExpression':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const targets = assignmentTargets(node);
        for (const name of targets.bare) writes.add(name);
        for (const name of targets.through) touches.add(name);
        break;
      }
      default:
        break;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }

  const truncated = stack.length > 0;
  return { shuffles, rotated: truncated ? null : rotationSubjects(subjects, inits, bound), names, writes, touches, truncated };
}

/**
 * The names outside a statement its rotations are of, or `null` when one
 * rotated local cannot be followed there: through `var list = fn()` and
 * `var list = fn` to `fn`, and through an IIFE's parameter to the argument
 * it is called with. A name declared nowhere in the statement is such a name.
 */
function rotationSubjects(
  subjects: readonly (string | null)[],
  inits: ReadonlyMap<string, t.Node | null>,
  bound: ReadonlyMap<string, string | null>,
): ReadonlySet<string> | null {
  const resolved = new Set<string>();
  for (const subject of subjects) {
    let name = subject;
    for (let hop = 0; name !== null && hop < MAX_ALIAS_HOPS; hop++) {
      if (bound.has(name)) {
        name = bound.get(name) ?? null;
        continue;
      }
      if (!inits.has(name)) break;
      const init = inits.get(name);
      const read = t.isCallExpression(init) && init.arguments.length === 0 ? init.callee : init;
      name = t.isIdentifier(read) ? read.name : null;
      if (name !== null && !bound.has(name) && !inits.has(name)) break;
      if (hop === MAX_ALIAS_HOPS - 1) name = null;
    }
    if (name === null) return null;
    resolved.add(name);
  }
  return resolved;
}

const MAX_ALIAS_HOPS = 8;

/**
 * An IIFE statement's parameters, each against the identifier it is called
 * with - `null` for an argument of any other shape, or a missing one. Empty
 * for any other statement.
 */
function iifeArguments(root: t.Node): ReadonlyMap<string, string | null> {
  const bound = new Map<string, string | null>();
  if (!t.isExpressionStatement(root)) return bound;
  let expression: t.Node = root.expression;
  while (t.isUnaryExpression(expression) || t.isParenthesizedExpression(expression)) {
    expression = t.isUnaryExpression(expression) ? expression.argument : expression.expression;
  }
  if (!t.isCallExpression(expression)) return bound;
  const callee = stripTypeWrappers(expression.callee);
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return bound;
  callee.params.forEach((param, index) => {
    if (!t.isIdentifier(param)) return;
    const argument = expression.arguments[index];
    bound.set(param.name, t.isIdentifier(argument) ? argument.name : null);
  });
  return bound;
}

/** Ceiling on one rotation scan; a real program initialisation is far smaller. */
const MAX_ROTATION_SCAN_NODES = 1_000_000;

/**
 * `x.method(...)`, looked at as the runtime sees it: a TypeScript decoder spells
 * the rotation `a.push(a.shift() as string)`, and the `as` is a node between
 * the `push` and the `shift` that is not there once the types are erased.
 * Testing the wrapper instead of its operand read that as no rotation at all,
 * and a table decoded at rotation zero maps every call site to a real string
 * from the wrong slot.
 */
function isMethodCall(node: t.Node | null | undefined, method: string): boolean {
  const call = node ? stripTypeWrappers(node) : node;
  if (!t.isCallExpression(call)) return false;
  const callee = call.callee;
  if (!t.isMemberExpression(callee)) return false;
  return memberName(callee) === method;
}

/** The property name of a member spelled `.name` or `['name']`; a computed key is `undefined`. */
function memberName(member: t.MemberExpression): string | undefined {
  if (member.computed) {
    return t.isStringLiteral(member.property) ? member.property.value : undefined;
  }
  return t.isIdentifier(member.property) ? member.property.name : undefined;
}

/**
 * Whether anything outside the owning scope reorders a borrowed binding.
 *
 * obfuscator.io's rotation wrapper is a sibling of the array and pure side
 * effect: with it the table is in one order, without it another, and nothing in
 * the declaration says which. When such a wrapper sits in an enclosing scope the
 * only sound answers are "evaluate it too" or "refuse", and evaluating it is not
 * available (see the comment on the owner-scope mutator loop). So: refuse, by
 * dropping the borrowed declarations and letting the free-variable check say so.
 */
function outerMutation(levels: readonly Level[], needed: ReadonlySet<string>): boolean {
  for (let depth = 1; depth < levels.length; depth++) {
    const level = levels[depth]!;
    if (level.included.size === 0) continue;
    const borrowed = new Set<string>();
    for (const [name, indexes] of level.declaredBy) {
      if (indexes.some((index) => level.included.has(index))) borrowed.add(name);
    }
    if (borrowed.size === 0) continue;

    for (const name of borrowed) {
      for (const index of level.mutators.byName.get(name) ?? []) {
        if (level.included.has(index) || index === level.container) continue;
        return true;
      }
    }
  }
  return false;
}

/** Collect the chosen units into a result, taking `depth` levels of scope. */
function assemble(levels: readonly Level[], depth: number): SliceResult {
  const statements: t.Statement[] = [];
  const sources: NodePath[] = [];
  const definedNames = new Set<string>();

  // Outermost first: a borrowed `var` has to be in scope before the machinery
  // that reads it runs.
  for (let index = Math.min(depth, levels.length) - 1; index >= 0; index--) {
    const level = levels[index]!;
    const ordered = [...level.included].sort((a, b) => a - b);
    for (const unit of ordered) {
      statements.push(t.cloneNode(level.units[unit]!.statement, true, true));
      if (index === 0) sources.push(level.units[unit]!.path);
    }
    for (const [name, indexes] of level.declaredBy) {
      if (indexes.some((i) => level.included.has(i))) definedNames.add(name);
    }
  }

  return { statements, definedNames, freeNames: freeVariables(statements), sources };
}

/**
 * Whether a declaration from an enclosing scope may be evaluated as part of the
 * slice.
 *
 * A sibling declaration is fair game: the slice already owns its whole scope and
 * anything that writes to it is a mutator the slice can take as well. An
 * *enclosing* binding is not, because the rest of the program can see it too. The
 * rule is that the binding must be effectively constant - every write to it lives
 * inside the very declaration being copied, which is what obfuscator.io's
 * self-replacing accessor (`_0xarr = function () { return _0xd; }`) looks like -
 * and anything else is left free so that the self-containment gate refuses it.
 */
function pullOuterDeclaration(
  level: Level,
  name: string,
  indexes: readonly number[],
): boolean {
  const binding = level.scope.scope.getBinding(name);
  // No binding means an implicit global assigned somewhere out of sight. At the
  // top level the slicer treats `_0xa = [...]` as decoder machinery, because for
  // a rotated array it usually is; borrowed from an enclosing scope there is
  // nothing to tie the write to the read, so it is not ours to evaluate.
  if (!binding) return false;
  if (binding.constant) return true;

  const owners = indexes.map((index) => level.units[index]!.path.node);
  return binding.constantViolations.every((violation) => isInsideNodes(violation, owners));
}

function isInsideNodes(path: NodePath, nodes: readonly t.Node[]): boolean {
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    if (nodes.includes(current.node)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** The owning scope, then each enclosing statement list out to the program. */
function buildLevels(scope: SliceScope, scans: StatementScanCache | undefined): Level[] {
  const levels: Level[] = [makeLevel(scope, undefined, scans)];

  let inner: SliceScope = scope;
  for (
    let current: NodePath | null = scope.parentPath;
    current && levels.length < MAX_ENCLOSING_LEVELS;
    current = current.parentPath
  ) {
    const outer = current.isProgram() || current.isBlockStatement() ? current : undefined;
    if (!outer) continue;
    levels.push(makeLevel(outer, inner, scans));
    inner = outer;
  }

  return levels;
}

function makeLevel(
  scope: SliceScope,
  inner: SliceScope | undefined,
  scans: StatementScanCache | undefined,
): Level {
  const parts = scans ? scans.levelParts(scope) : buildLevelParts(scope, undefined);
  return {
    scope,
    units: parts.units,
    declaredBy: parts.declaredBy,
    included: new Set(),
    references: parts.references,
    scans: parts.scans,
    containerScans: parts.containerScans,
    mutators: parts.mutators,
    container: inner ? containerIndexOf(parts.units, inner) : -1,
    inner,
  };
}

/** Which unit of `units` lexically contains `inner`. */
function containerIndexOf(units: readonly Unit[], inner: SliceScope): number {
  const byNode = new Map<t.Node, number>();
  for (let index = 0; index < units.length; index++) byNode.set(units[index]!.path.node, index);

  for (let current: NodePath | null = inner; current; current = current.parentPath) {
    const index = byNode.get(current.node);
    if (index !== undefined) return index;
  }
  return -1;
}

/**
 * A unit's dependencies are its *free* variables, not every identifier it
 * contains. Counting a decoder's own parameters and locals as dependencies would
 * let a same-named binding elsewhere drag unrelated code - and its DOM access -
 * into the slice, which then fails the self-containment gate.
 */
function referencesOf(level: Level, index: number): Set<string> {
  let cached = level.references.get(index);
  if (!cached) {
    cached = freeVariables([level.units[index]!.statement], { includeBuiltins: true });
    level.references.set(index, cached);
  }
  return cached;
}

/**
 * Split a scope's comma expressions so each operand is schedulable on its own.
 *
 * Splitting must recurse. `a, (b, c)` parses as a sequence whose second operand
 * is another sequence, and repeatedly re-obfuscated code nests exactly that way:
 * each new layer wraps the previous layer's rotation wrapper in another comma.
 * Stopping at one level fuses every layer but the outermost back together.
 */
function scopeUnits(scope: SliceScope): Unit[] {
  const units: Unit[] = [];

  const addExpression = (path: NodePath<t.Expression>): void => {
    if (path.isSequenceExpression()) {
      for (const part of path.get('expressions')) addExpression(part);
      return;
    }
    units.push({ statement: t.expressionStatement(path.node), path });
  };

  for (const statementPath of statementPathsOf(scope)) {
    if (
      statementPath.isExpressionStatement() &&
      t.isSequenceExpression(statementPath.node.expression)
    ) {
      addExpression(statementPath.get('expression') as NodePath<t.Expression>);
      continue;
    }
    units.push({ statement: statementPath.node, path: statementPath });
  }

  return units;
}

/**
 * The statement list of a scope.
 *
 * `Program` and `BlockStatement` both carry `body: Statement[]`, but the union
 * of their `get` overloads is not iterable to the compiler, so the shared shape
 * is asserted once here rather than at every call site.
 */
export function statementPathsOf(scope: SliceScope): NodePath<t.Statement>[] {
  return (scope as NodePath<t.Program>).get('body');
}

/**
 * Names the slice reads but never binds.
 *
 * This must be a real scope analysis, not a walk that collects every identifier:
 * a decoder's own parameters and inner `const`s are identifiers too, and
 * counting them as free references makes every genuine decoder look
 * un-evaluatable. Babel already computes this correctly, so the slice is rebuilt
 * as a throwaway program and the program scope's globals are read off it.
 */
function freeVariables(
  statements: readonly t.Statement[],
  options: { includeBuiltins?: boolean } = {},
): Set<string> {
  const free = new Set<string>();
  const file = t.file(
    t.program(
      statements.map((s) => t.cloneNode(s, true, true)),
      [],
      'script',
    ),
  );

  traverse(file, {
    Program(path) {
      for (const name of Object.keys(path.scope.globals)) {
        if (options.includeBuiltins || !ALLOWED_GLOBALS.has(name)) free.add(name);
      }
      path.stop();
    },
  });

  return free;
}

function indexDeclarations(units: readonly Unit[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const add = (name: string, position: number) => {
    const list = index.get(name);
    if (list) list.push(position);
    else index.set(name, [position]);
  };

  for (let position = 0; position < units.length; position++) {
    const node = units[position]!.statement;

    if (t.isFunctionDeclaration(node) && node.id) {
      add(node.id.name, position);
    } else if (t.isClassDeclaration(node) && node.id) {
      add(node.id.name, position);
    } else if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        for (const name of Object.keys(t.getOuterBindingIdentifiers(declarator.id))) {
          add(name, position);
        }
      }
    } else if (t.isExpressionStatement(node)) {
      // `_0xdb56 = [...]` with no declaration keyword.
      const expression = node.expression;
      if (t.isAssignmentExpression(expression) && t.isIdentifier(expression.left)) {
        add(expression.left.name, position);
      }
    }
  }
  return index;
}

/**
 * The closure names a unit would be included for, because it *mutates* them
 * rather than merely reads them: the unit is a mutator of a slice exactly when
 * one of these is in the slice's `needed` set.
 *
 * Three signals have to line up, because the alternative is catastrophic: the
 * whole program is usually an IIFE that mentions the decoder thousands of times,
 * and pulling it in would put the entire user script inside the sandbox.
 *
 *  1. it is an immediately-invoked function expression, or an assignment to a
 *     name in the closure - a plain `console.log(decode(1))` call site is not;
 *  2. it actually references a name in the closure;
 *  3. either the closure name is passed in as an *argument* - the shape
 *     obfuscator.io emits, `(function (arr, key) {...})(getArray(), 0x6e0de)` -
 *     or the unit is small enough to be decoder machinery rather than a program.
 *
 * The same two shapes are recognised one statement down. `{ _0xn = 1; }`, `if
 * (true) _0xn = 1;` and `outer: { _0xn = 1; break outer; }` change what the
 * decoder reads next exactly as the bare `_0xn = 1;` does, and a search that
 * only saw the bare spelling left them out of the slice: both tiers then agreed
 * on `_0xn = 0` and the output printed the string from the slot next door, at
 * every preset, with no diagnostic. A compound statement is taken whole, for
 * the assignments and IIFEs its nested statements hold, under the same node
 * budget as a closure-style wrapper, and only when it hoists nothing into the
 * scope - a unit the slice takes is one the pruner deletes, and `for (var i ...)
 * { _0xn = 1 }` deleted would take `i` with it. What this cannot take,
 * `unmodelledMutation` refuses.
 *
 * Nor when the compound leaves the statement list it sits in. `if (true) {
 * _0xn = 1; return 'early'; }` is a unit that writes the offset AND ends the
 * function; taken, the slice evaluates it as a program-level statement whose
 * `return` completion the interpreter discards, builds the decoder with the
 * post-write offset, and the pruner deletes the `return` with the rest of the
 * machinery - the function then runs on to a call it never reached, and the
 * output prints `beta` for a program that prints `early`. The same for a
 * `break` or `continue` aimed past the compound's own loops and labels, and
 * for `await`/`yield`, which no program-level evaluation reproduces. A
 * `throw` stays: it ends the slice's run as it ends the program's.
 *
 * Deliberately NOT every statement that writes. `_0xt[0] = 'z';` and
 * `_0xt.push('w');` are writes to the TABLE, and `arrayIsImmutable` and
 * `tableIsStable` in `strings.discover` refuse a table with one of those
 * beside it - a refusal that taking the statement would exempt, since anything
 * in the slice is by definition part of the decoder's value. The slice's model
 * is that its mutators run before any read does; that is true of a rotation
 * wrapper and of an offset set once at load, and it is not a fact this search
 * can establish about an arbitrary write to the table itself.
 */
function mutatorNames(unit: Unit): ReadonlySet<string> {
  const node = unit.statement;
  if (t.isExpressionStatement(node)) return expressionMutatorNames(node);
  if (!isCompoundStatement(node) || hoistsBinding(node)) return NO_NAMES;
  if (exceedsNodeBudget(node, MAX_MUTATOR_NODES) || leavesStatement(node)) return NO_NAMES;
  const names = new Set<string>();
  const visit = (statement: t.Statement): void => {
    if (t.isExpressionStatement(statement)) {
      for (const name of expressionMutatorNames(statement)) names.add(name);
    } else if (isCompoundStatement(statement)) {
      for (const nested of nestedStatements(statement)) visit(nested);
    }
  };
  visit(node);
  return names;
}

function expressionMutatorNames(node: t.ExpressionStatement): ReadonlySet<string> {
  const expression = unwrap(node.expression);

  if (t.isAssignmentExpression(expression)) {
    return t.isIdentifier(expression.left) ? new Set([expression.left.name]) : NO_NAMES;
  }
  // `_0xn++;` is `_0xn += 1;`, and that spelling was always taken.
  if (t.isUpdateExpression(expression)) {
    return t.isIdentifier(expression.argument) ? new Set([expression.argument.name]) : NO_NAMES;
  }

  if (!t.isCallExpression(expression)) return NO_NAMES;
  const callee = unwrap(expression.callee as t.Expression);
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return NO_NAMES;

  const names = new Set<string>();
  for (const argument of expression.arguments) {
    const handed = handedOverValue(argument);
    if (handed !== undefined) names.add(handed);
  }

  // Closure-style wrapper: it takes no handoff, so it must be visibly mutating a
  // closure name from inside. Merely *reading* one is what every call site in the
  // program does, and the program itself is usually an IIFE too.
  if (!exceedsNodeBudget(node, MAX_MUTATOR_NODES)) {
    for (const name of mutatedClosureNames(node)) names.add(name);
  }
  return names;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** A statement that contains statements: the shapes a write can hide inside. */
function isCompoundStatement(node: t.Node): node is CompoundStatement {
  return (
    t.isBlockStatement(node) ||
    t.isIfStatement(node) ||
    t.isLabeledStatement(node) ||
    t.isLoop(node) ||
    t.isTryStatement(node) ||
    t.isSwitchStatement(node)
  );
}

type CompoundStatement =
  | t.BlockStatement
  | t.IfStatement
  | t.LabeledStatement
  | t.Loop
  | t.TryStatement
  | t.SwitchStatement;

/** The statements directly inside a compound one; a `for` head is an expression and is not among them. */
function nestedStatements(node: CompoundStatement): t.Statement[] {
  switch (node.type) {
    case 'BlockStatement':
      return node.body;
    case 'IfStatement':
      return node.alternate ? [node.consequent, node.alternate] : [node.consequent];
    case 'LabeledStatement':
      return [node.body];
    case 'TryStatement':
      return [
        node.block,
        ...(node.handler ? [node.handler.body] : []),
        ...(node.finalizer ? [node.finalizer] : []),
      ];
    case 'SwitchStatement':
      return node.cases.flatMap((c) => c.consequent);
    default:
      return [node.body];
  }
}

/**
 * Whether a compound statement declares anything into the scope around it: a
 * `var` at any block depth, or a function declaration, which Annex B hoists out
 * of a sloppy block. A `let`, `const` or `class` stays inside the block and a
 * nested function body is its own scope, so neither counts.
 */
function hoistsBinding(root: t.Node): boolean {
  const stack: t.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (t.isFunctionDeclaration(node)) return true;
    if (t.isVariableDeclaration(node) && node.kind === 'var') return true;
    if (t.isFunction(node)) continue;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return false;
}

/**
 * Whether a compound statement can complete other than by running off its
 * end: a `return`, a `break`/`continue` whose target is outside it, an
 * `await` or `yield`. Nested functions are their own completion boundary and
 * are not entered. A `break` or `continue` is aimed inside when its label is
 * one the compound declares around it, or, unlabelled, when a loop (or for
 * `break`, a `switch`) of the compound's own encloses it.
 */
function leavesStatement(root: t.Node): boolean {
  const walk = (node: t.Node, labels: readonly string[], loops: number, breakable: number): boolean => {
    if (t.isFunction(node)) return false;
    if (t.isReturnStatement(node) || t.isAwaitExpression(node) || t.isYieldExpression(node)) return true;
    if (t.isForOfStatement(node) && node.await) return true;
    if (t.isBreakStatement(node)) {
      return node.label ? !labels.includes(node.label.name) : breakable === 0;
    }
    if (t.isContinueStatement(node)) {
      return node.label ? !labels.includes(node.label.name) : loops === 0;
    }
    const inner = t.isLabeledStatement(node) ? [...labels, node.label.name] : labels;
    const loop = t.isLoop(node) ? 1 : 0;
    const guard = loop || t.isSwitchStatement(node) ? 1 : 0;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as t.Node).type === 'string') {
            if (walk(item as t.Node, inner, loops + loop, breakable + guard)) return true;
          }
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        if (walk(child as t.Node, inner, loops + loop, breakable + guard)) return true;
      }
    }
    return false;
  };
  return walk(root, [], 0, 0);
}

/**
 * Whether a subtree has more than `budget` nodes, without counting the rest.
 *
 * The question every size heuristic here actually asks is "is this bigger than a
 * few hundred nodes", and the answer for a module IIFE is known after four
 * hundred of its ninety thousand. Counting all of them is what makes a
 * scope-relative search unusable rather than linear: the check runs once per
 * sibling statement per candidate, so on a bundle the same enormous statement is
 * re-measured dozens of times.
 */
export function exceedsNodeBudget(node: t.Node, budget: number): boolean {
  let seen = 0;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object' || typeof (current as t.Node).type !== 'string') {
      continue;
    }
    if (++seen > budget) return true;
    for (const key of t.VISITOR_KEYS[(current as t.Node).type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

const MUTATING_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'reverse',
  'sort',
  'fill',
  'copyWithin',
]);

/** Every name a unit writes to - assigned, updated, or called with a mutating method - by root. */
function mutatedClosureNames(node: t.Node): Set<string> {
  const names = new Set<string>();

  const visit = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    const current = value as t.Node;
    if (typeof current.type !== 'string') return;

    for (const name of writtenRoots(current)) names.add(name);

    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      visit((current as unknown as Record<string, unknown>)[key]);
    }
  };

  visit(node);
  return names;
}

/**
 * The root names one node writes, looking at that node alone: the target of an
 * assignment or update, the head of a `for-in`/`for-of` that assigns rather
 * than declares, or the receiver of a mutating method call. A destructuring
 * target writes every name it binds, and `[_0xt[0]] = ['z']` writes `_0xt`.
 */
function writtenRoots(node: t.Node): string[] {
  const targets = assignmentTargets(node);
  if (targets.bare.length > 0 || targets.through.length > 0) {
    return [...targets.bare, ...targets.through];
  }
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    const callee = node.callee;
    const method = t.isIdentifier(callee.property) && !callee.computed ? callee.property.name : undefined;
    const name = rootName(callee.object);
    if (method !== undefined && MUTATING_METHODS.has(method) && name !== undefined) return [name];
  }
  return [];
}

/**
 * The names a node could change through a member, other than by assigning
 * one: the operand of `delete`, the receiver of any method call, any bare
 * name handed to a call or a constructor (spread included), and the object of
 * a `with`. See `StatementScan.touches` for why every method and every callee
 * counts.
 */
function touchedRoots(node: t.Node): readonly string[] {
  if (t.isUnaryExpression(node) && node.operator === 'delete') {
    const name = rootName(node.argument);
    return name === undefined ? NO_ROOTS : [name];
  }
  if (t.isWithStatement(node)) {
    const name = rootName(node.object);
    return name === undefined ? NO_ROOTS : [name];
  }
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node) && !t.isNewExpression(node)) {
    return NO_ROOTS;
  }
  let names: string[] | undefined;
  const callee = stripTypeWrappers(node.callee);
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const name = rootName(callee.object);
    if (name !== undefined) names = [name];
  }
  for (const argument of node.arguments) {
    const value = stripTypeWrappers(t.isSpreadElement(argument) ? argument.argument : argument);
    if (t.isIdentifier(value)) (names ??= []).push(value.name);
  }
  return names ?? NO_ROOTS;
}

const NO_ROOTS: readonly string[] = [];

/** The written side of an assignment, an update, or an assigning `for-in`/`for-of` head. */
function assignmentTarget(node: t.Node): t.Node | undefined {
  if (t.isAssignmentExpression(node)) return node.left;
  if (t.isUpdateExpression(node)) return node.argument;
  if ((t.isForInStatement(node) || t.isForOfStatement(node)) && !t.isVariableDeclaration(node.left)) {
    return node.left;
  }
  return undefined;
}

/**
 * What one node assigns, by how the name is reached: `bare` is written as
 * itself - `[_0xn] = [1]` writes `_0xn` - and `through` is the root of a
 * member - `_0xt[0] = 'z'` writes through `_0xt`. The two are different
 * questions downstream: a bare write is a new value for the name, a write
 * through it is a change to the value it already holds.
 */
function assignmentTargets(node: t.Node): { bare: string[]; through: string[] } {
  const bare: string[] = [];
  const through: string[] = [];
  const collect = (target: t.Node | null | undefined): void => {
    if (!target) return;
    const stripped = stripTypeWrappers(target);
    if (t.isArrayPattern(stripped)) {
      for (const element of stripped.elements) collect(element);
    } else if (t.isObjectPattern(stripped)) {
      for (const property of stripped.properties) {
        collect(t.isRestElement(property) ? property.argument : property.value);
      }
    } else if (t.isAssignmentPattern(stripped)) {
      collect(stripped.left);
    } else if (t.isRestElement(stripped)) {
      collect(stripped.argument);
    } else if (t.isIdentifier(stripped)) {
      bare.push(stripped.name);
    } else {
      const name = rootName(stripped);
      if (name !== undefined) through.push(name);
    }
  };
  collect(assignmentTarget(node));
  return { bare, through };
}

/** The identifier at the base of a member chain, through any type wrappers. */
function rootName(expression: t.Node): string | undefined {
  let current: t.Node = stripTypeWrappers(expression);
  while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
    current = stripTypeWrappers(current.object);
  }
  return t.isIdentifier(current) ? current.name : undefined;
}

/**
 * The closure name an argument hands to the callee *itself*, which is how a
 * rotation wrapper gets something to mutate.
 *
 * The shape has to be the array or decoder by name - `f(getArray(), 0x6e0de)` -
 * not merely an expression that reads from it. The program IIFE in a minified
 * bundle is routinely invoked as `f(window, window[strings[0]])`, and treating
 * that read as a handoff would pull the entire program into the slice.
 */
function handedOverValue(argument: t.Node): string | undefined {
  const node = t.isExpression(argument) ? unwrap(argument) : argument;
  if (t.isIdentifier(node)) return node.name;
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    return t.isIdentifier(callee) ? callee.name : undefined;
  }
  return undefined;
}

/** Strip the `!`/`void`/`+` prefixes obfuscators put in front of an IIFE. */
function unwrap(node: t.Expression): t.Expression {
  let current = node;
  while (t.isUnaryExpression(current) && ['!', 'void', '+', '-', '~'].includes(current.operator)) {
    current = current.argument;
  }
  return current;
}
