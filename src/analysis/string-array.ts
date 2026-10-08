import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { StringSource } from '../pipeline/context.js';
import {
  holdsDeclaredValue,
  isPureContext,
  oversizeStringTable,
  shadowedByBlockFunction,
  staticNumber,
  staticString,
  staticStringTable,
  type BlockFunctionMemo,
  type NameAddressing,
  type TreeOrder,
} from '../util/ast.js';
import { parameterValue } from './parameters.js';
import {
  isPositionalForwarder,
  recogniseEncoding,
  recogniseStringArray,
  type EncodingRecognition,
} from './evaluator/native.js';
import {
  asSliceScope,
  declareSliceScope,
  exceedsNodeBudget,
  statementPathsOf,
  type SliceScope,
} from './slice.js';

/**
 * Structural discovery of string arrays, decoders, aliases and wrappers.
 *
 * The string array is found without the user naming it, and without keying on
 * identifier names - obfuscators randomise those on every build. Recognition is
 * shape only: an array whose every element is a string, a function that returns
 * one, a short function that forwards to another with the index adjusted.
 *
 * Discovery is deliberately generous and verification is deliberately strict.
 * Proposing a candidate costs one call to `buildDecoder`, which validates
 * against real call sites and refuses on its own; proposing too *few* candidates
 * means the headline feature of the tool silently does nothing.
 */

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface StringSourceCandidate {
  /** Names to hand `buildDecoder` as slice roots, most specific first. */
  roots: string[];
  /**
   * The scope the slice starts from: where the decoder (or, with no decoder, the
   * array) is declared. `Program` for a classic top-level build, the module
   * factory's body for anything a bundler produced.
   */
  scope: SliceScope;
  /**
   * Identity of that scope, so two modules that both call their table `_0x1234`
   * stay two candidates. Names cannot do this job; bindings can, and this is the
   * cheapest stable stand-in for one.
   */
  scopeId: string;
  /** The binding holding (or returning) the array of strings. */
  arrayName: string;
  /** The function call sites go through, when there is one. */
  decoderName?: string;
  kind: 'array-index' | 'wrapper-call';
  /** Number of entries in the array literal. */
  size: number;
  /** True when a `push(shift())` rotation wrapper mutates the array at load. */
  rotated: boolean;
  /** What the decoder does to each element, when a decoder was found. */
  encoding: EncodingRecognition | null;
  /** Higher is more likely to be a genuine string source. */
  score: number;
}

/**
 * Arrays shorter than this are not proposed for the direct-read shape: two
 * strings is the smallest thing that can meaningfully be called a table, and
 * a `['x']` read as `a[0]` is a literal that happens to live in brackets.
 *
 * Behind a decoder the bound is one. A program with a single string in it
 * comes out of obfuscator.io as `function n() { var r = ['x8kgjNO']; n =
 * function () { return r; }; return n(); }` with the full rc4 decoder beside
 * it, and most generated programs that decode nothing at every preset are
 * exactly that file: not a candidate, so not a refusal, so not a line in the
 * report. What makes a one-entry array a table is the decoder
 * that reads it, and `findDecoderFor` is the test for that; the size alone
 * only says whether the bare `a[0]` shape is worth an audit.
 */
const MIN_ARRAY_ENTRIES = 2;
const MIN_DECODED_ENTRIES = 1;

/**
 * Parameter ceiling on a function proposed as a decoder.
 *
 * obfuscator.io's decoder takes an index and at most a key and a mode flag, but
 * that is a fact about one generator, not about decoders: the Cloudflare
 * post-pass hoists every *local* of a function into its parameter list, so the
 * same decoder is written
 * `function Y(W, c, d, F) { return W = W - 152, d = i(), F = d[W], F }` - one
 * real argument and three locals spelled as parameters. A ceiling of 3 never
 * proposes that function, leaving such a file's only string table undiscovered.
 *
 * Widening the proposal costs nothing in correctness: `buildDecoder` proves or
 * refuses every candidate against real call sites, and a call site that passes
 * one argument leaves the rest `undefined` in the evaluator exactly as it does
 * at run time.
 */
const MAX_DECODER_PARAMS = 8;

/** Guard on the recursive shape walks below; obfuscated ASTs are deep. */
const MAX_WALK_NODES = 20_000;

/**
 * How many scopes out from a string array literal to treat as candidates.
 *
 * Two is the working number: the array's own statement list covers
 * `var _0xa = [...]`, and one more covers the accessor shape
 * `function _0xarr() { var _0xd = [...]; }` where the *binding* that matters is
 * the accessor's, a scope further out. The rest is headroom for a build that
 * wraps either in a block.
 */
const MAX_ARRAY_ANCESTOR_SCOPES = 4;

/**
 * Reference count above which an array is treated as read directly rather than
 * through a hidden decoder. A real decoder-mediated table is touched by the
 * decoder and the rotation wrapper and nothing else.
 */
const MAX_REFERENCES_FOR_NESTED_DECODER = 8;

/** A decoder is a few dozen nodes. Anything larger is a function that uses one. */
const MAX_NESTED_DECODER_NODES = 400;

/**
 * Find every plausible string source, in every scope of the program.
 *
 * Every scope, not just the top level. webpack, Next.js, Vite and every
 * hand-rolled `;(function(){ ... })();` wrapper put the whole module body inside
 * a function, so a top-level-only search decodes nothing at all on the single
 * most common shape of real bundled JavaScript.
 *
 * The search is one traversal. Array literals announce themselves, so rather
 * than walking every scope looking for a table, the walk collects tables once and
 * keeps the handful of scopes that contain one. Cost is proportional to the file,
 * not to the file times its scope count.
 */
export function findStringSourceCandidates(
  program: NodePath<t.Program>,
  skipped?: OversizeTable[],
): StringSourceCandidate[] {
  const candidates: StringSourceCandidate[] = [];
  for (const scope of candidateScopes(program, skipped)) collectInScope(scope, candidates);
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * A `split` table the scan refused for its size. Reported to the caller,
 * which has the context to say so; the scan itself must stay a pure walk.
 */
export interface OversizeTable {
  entries: number;
  loc: t.SourceLocation | null | undefined;
}

/**
 * Scopes whose own statement list declares something array-shaped.
 *
 * Deliberately not `program.traverse`. Babel builds and caches a `NodePath` for
 * every node it visits, which on a ten-megabyte bundle costs whole seconds - and
 * this scan runs again after every peeled layer, on every fixpoint iteration, so
 * that cost is paid ten times over. A raw node walk answers the only question
 * being asked here (which statement lists contain a string-array literal) an
 * order of magnitude faster, and the handful of scopes that qualify are then
 * turned into paths by descending the child keys the walk recorded.
 */
function candidateScopes(program: NodePath<t.Program>, skipped?: OversizeTable[]): SliceScope[] {
  interface Hit {
    node: t.Node;
    /** Child keys and indexes from the program down to this scope. */
    trail: (string | number)[];
  }

  const hits = new Map<t.Node, Hit>();
  hits.set(program.node, { node: program.node, trail: [] });

  // Enclosing statement lists, innermost last. Frames hold a *length* into the
  // live trail rather than a copy of it, so entering a block stays O(1).
  const frames: { node: t.Node; depth: number }[] = [{ node: program.node, depth: 0 }];
  const trail: (string | number)[] = [];

  const record = (): void => {
    const first = Math.max(0, frames.length - MAX_ARRAY_ANCESTOR_SCOPES);
    for (let index = frames.length - 1; index >= first; index--) {
      const frame = frames[index]!;
      if (hits.has(frame.node)) continue;
      hits.set(frame.node, { node: frame.node, trail: trail.slice(0, frame.depth) });
    }
  };

  const visit = (node: t.Node): void => {
    const opensScope = node.type === 'BlockStatement';
    if (opensScope) frames.push({ node, depth: trail.length });

    // `CallExpression` is here for the `'a;b;c'.split(';')` spelling of the same
    // table: no `ArrayExpression` exists anywhere in such a file, so without it
    // this walk records no scope at all and discovery never starts.
    if (node.type === 'ArrayExpression' || node.type === 'CallExpression') {
      const size = staticStringTable(node)?.length ?? 0;
      if (size >= MIN_DECODED_ENTRIES) record();
      else if (skipped && node.type === 'CallExpression') {
        const entries = oversizeStringTable(node);
        if (entries !== undefined) skipped.push({ entries, loc: node.loc });
      }
    }

    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index++) {
          const item = child[index];
          if (!isNode(item)) continue;
          trail.push(key, index);
          visit(item);
          trail.length -= 2;
        }
      } else if (isNode(child)) {
        trail.push(key);
        visit(child);
        trail.length -= 1;
      }
    }

    if (opensScope) frames.pop();
  };

  visit(program.node);

  // Every scope that holds a table, in tree order; `findStringSourceCandidates`
  // ranks the candidates by score afterwards. There is no cap: a bundle really
  // does have one table per module, thousands of them, and a cap of 512 here
  // handed the rest to `strings.inline`'s layer loop one batch at a time - a
  // 2,048-module concatenation decoded 1,530 of them and then ran out of
  // layers, with nothing in the report saying so. Each scope is examined once,
  // so the scan stays linear in the file without one.
  const ordered = [...hits.values()];

  const scopes: SliceScope[] = [];
  const lists: PathLists = new Map();
  for (const hit of ordered) {
    const scope = descend(program, hit.trail, lists);
    // The trail is only a shortcut to a path Babel would have built anyway, so a
    // mismatch means the shortcut was wrong and the scope is simply skipped.
    if (scope && scope.node === hit.node) scopes.push(scope);
  }
  return scopes;
}

/** Statement lists already turned into paths during one scan, by node and key. */
type PathLists = Map<t.Node, Map<string, NodePath[]>>;

/** Follow recorded child keys from the program down to one node's path. */
function descend(
  program: NodePath<t.Program>,
  trail: readonly (string | number)[],
  lists: PathLists,
): SliceScope | undefined {
  let path: NodePath = program;
  for (let index = 0; index < trail.length; index++) {
    const key = trail[index];
    if (typeof key !== 'string') return undefined;
    const next = childrenOf(path, key, lists);
    if (Array.isArray(next)) {
      const position = trail[++index];
      if (typeof position !== 'number') return undefined;
      const child = next[position];
      if (!child?.node) return undefined;
      path = child;
    } else {
      if (!next?.node) return undefined;
      path = next;
    }
  }
  return path.isProgram() || path.isBlockStatement() ? path : undefined;
}

/**
 * `path.get(key)`, remembering list-valued answers for the scan.
 *
 * Babel builds a path for every element of a list on each `get`, and the first
 * step of every trail is the program body: 2,048 module scopes in a 5 MB
 * concatenation meant 2,048 rebuilds of an 8,000-path list - 7 s of a 17 s
 * discovery - for a list that does not change between hits.
 */
function childrenOf(path: NodePath, key: string, lists: PathLists): NodePath | NodePath[] {
  const remembered = lists.get(path.node)?.get(key);
  if (remembered) return remembered;
  const got = path.get(key as never) as NodePath | NodePath[];
  if (Array.isArray(got)) {
    let byKey = lists.get(path.node);
    if (!byKey) {
      byKey = new Map();
      lists.set(path.node, byKey);
    }
    byKey.set(key, got);
  }
  return got;
}

function collectInScope(scope: SliceScope, out: StringSourceCandidate[]): void {
  const statements = scopeUnits(scope).map((unit) => unit.statement);
  const arrays = recogniseStringArray(statements);
  const mentions = arrays.length > 0 ? indexFunctionMentions(statements) : undefined;
  if (arrays.length === 0) return;
  const rotated = statements.some(containsRotationShuffle);

  for (const array of arrays) {
    if (array.values.length < MIN_DECODED_ENTRIES) continue;

    const decoders = findDecoderFor(scope, mentions!, array.name);
    for (const decoder of decoders) {
      out.push(
        candidate({
          roots: [decoder.name, array.name],
          // The slice starts where the *decoder* lives. When that is a scope
          // inside the array's, the array is borrowed from the enclosing one.
          scope: decoder.scope,
          arrayName: array.name,
          decoderName: decoder.name,
          kind: 'wrapper-call',
          size: array.values.length,
          rotated,
          encoding: recogniseEncoding(decoder.fn),
          score: array.values.length * 2 + decoder.references,
        }),
      );
    }

    // A function that merely *returns* the array cannot be indexed at a call
    // site, so there is no direct-read shape to propose for it.
    if (array.viaFunction) continue;
    if (array.values.length < MIN_ARRAY_ENTRIES) continue;

    // A plain array reached through a decoder is often *also* read directly in
    // the same file, and the two shapes decode differently - the decoder applies
    // an index offset that a bare `A[3]` does not. Proposing both costs one more
    // validation and is the difference between covering the file and covering
    // most of it.
    out.push(
      candidate({
        roots: [array.name],
        scope,
        arrayName: array.name,
        kind: 'array-index',
        size: array.values.length,
        rotated,
        encoding: null,
        score: decoders.length > 0 ? array.values.length - 1 : array.values.length,
      }),
    );
  }
}

/**
 * Finish a candidate: stamp its scope identity and tag its roots for the
 * slicer, naming the table so the slicer leaves writes through it to the
 * reference audit in `strings.discover` that judges every use of it.
 */
function candidate(
  fields: Omit<StringSourceCandidate, 'scopeId'>,
): StringSourceCandidate {
  declareSliceScope(fields.roots, fields.scope, fields.arrayName);
  return { ...fields, scopeId: scopeId(fields.scope) };
}

const scopeIds = new WeakMap<t.Node, number>();
let nextScopeId = 0;

/**
 * A stable per-node identity for a scope.
 *
 * Source positions would be cheaper but they are not reliable here: a scope the
 * pipeline rebuilt has none, and two rebuilt scopes would then collide into one
 * candidate. A `WeakMap` counter is exact and costs nothing to keep.
 */
function scopeId(scope: SliceScope): string {
  let id = scopeIds.get(scope.node);
  if (id === undefined) {
    id = nextScopeId++;
    scopeIds.set(scope.node, id);
  }
  return `s${id}`;
}

interface Unit {
  statement: t.Statement;
  /** The path the statement came from, for exempting it from reference audits. */
  path: NodePath;
}

/**
 * Split a scope's comma expressions into schedulable parts.
 *
 * Mirrors `sliceForEvaluation`, and for the same reason: real obfuscator.io
 * output fuses the rotation wrapper and the whole three-megabyte program into a
 * single `SequenceExpression`, so anything working at statement granularity sees
 * one enormous statement and no rotation wrapper at all.
 */
function scopeUnits(scope: SliceScope): Unit[] {
  const units: Unit[] = [];
  for (const statementPath of statementPathsOf(scope)) {
    const node = statementPath.node;
    if (t.isExpressionStatement(node) && t.isSequenceExpression(node.expression)) {
      const sequence = statementPath.get('expression') as NodePath<t.SequenceExpression>;
      for (const part of sequence.get('expressions')) {
        units.push({ statement: t.expressionStatement(part.node), path: part });
      }
      continue;
    }
    units.push({ statement: node, path: statementPath });
  }
  return units;
}

interface DecoderRecognition {
  name: string;
  fn: t.Function;
  /** How many places reference it; the real decoder is referenced constantly. */
  references: number;
  /** The scope the decoder is declared in, which is where its slice starts. */
  scope: SliceScope;
}

/**
 * The functions call sites reach the array through.
 *
 * Shape only: a function of one to eight parameters, declared as a statement
 * of the array's own scope, whose body reads the array - or a local it is
 * read into, `var e = T()` - at an index a parameter computes. Every such
 * function is a decoder of its own: a build with `stringArrayEncoding` set to
 * several encodings emits one decoder per encoding over one table, plain,
 * base64 and rc4 side by side, and proposing the most-called of them alone
 * left the other two encoded. When none reads the array that way, the
 * mention the program calls the most stands in, as it always did, since a
 * helper that closes over the array without indexing it is not a decoder.
 */
function findDecoderFor(
  scope: SliceScope,
  mentions: FunctionMentions,
  arrayName: string,
): DecoderRecognition[] {
  const found: DecoderRecognition[] = [];
  for (const { name, fn } of mentions.functionsMentioning(arrayName)) {
    if (name === arrayName) continue;
    found.push({
      name,
      fn,
      references: scope.scope.getBinding(name)?.references ?? 0,
      scope,
    });
  }
  found.sort((a, b) => b.references - a.references);
  const readers = found.filter(({ fn }) => indexesByParameter(fn, arrayName));
  if (readers.length > 0) return readers;
  if (found.length > 0) return [found[0]!];
  const nested = findNestedDecoderFor(scope, arrayName);
  return nested ? [nested] : [];
}

/**
 * Whether a function reads `arrayName` - or a local it reads the array into,
 * `var e = T()` or `var e = T` - at an index that mentions a parameter of the
 * function or of one nested in it: obfuscator.io's decoder reads `e[f]` in
 * the function it replaces itself with, whose `f` is that function's own.
 */
function indexesByParameter(fn: t.Function, arrayName: string): boolean {
  const params = new Set<string>();
  const holders = new Set([arrayName]);
  const addParams = (target: t.Function): void => {
    for (const param of target.params) for (const name of Object.keys(t.getBindingIdentifiers(param))) params.add(name);
  };
  addParams(fn);
  // Holders and parameters first: the walk is not in source order, and the
  // read of `e[f]` sits after `var e = T()` in the text, not in the walk.
  walk(fn.body, (node) => {
    if (t.isFunction(node)) addParams(node);
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && node.init) {
      const init = node.init;
      const read = t.isCallExpression(init) && init.arguments.length === 0 ? init.callee : init;
      if (t.isIdentifier(read) && holders.has(read.name)) holders.add(node.id.name);
    }
    return true;
  });
  let found = false;
  walk(fn.body, (node) => {
    if (found) return false;
    if (
      t.isMemberExpression(node) &&
      node.computed &&
      t.isIdentifier(node.object) &&
      holders.has(node.object.name) &&
      mentionsAny(node.property, params)
    ) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function mentionsAny(root: t.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  walk(root, (node) => {
    if (found) return false;
    if (t.isIdentifier(node) && names.has(node.name)) found = true;
    return !found;
  });
  return found;
}

/**
 * Which function-shaped statements in a scope mention which names.
 *
 * `findDecoderFor` used to walk every function body in the scope once per
 * array, asking whether it mentions that array's name. A scope with hundreds
 * of tables - `stringArrayWrappersCount`, or obfuscated files concatenated -
 * therefore walked every body hundreds of times, and this was the largest
 * cost left in candidate discovery once the scans around it were shared. One
 * walk per body records every name it mentions; each array then asks the map.
 */
interface FunctionMentions {
  functionsMentioning(name: string): readonly { name: string; fn: t.Function }[];
}

function indexFunctionMentions(statements: readonly t.Statement[]): FunctionMentions {
  const byName = new Map<string, { name: string; fn: t.Function }[]>();

  const index = (name: string, fn: t.Function | undefined): void => {
    if (!fn) return;
    if (fn.params.length === 0 || fn.params.length > MAX_DECODER_PARAMS) return;
    const entry = { name, fn };
    const seen = new Set<string>();
    walk(fn.body, (node) => {
      if (t.isIdentifier(node) && !seen.has(node.name)) {
        seen.add(node.name);
        let list = byName.get(node.name);
        if (!list) {
          list = [];
          byName.set(node.name, list);
        }
        list.push(entry);
      }
      return true;
    });
  };

  for (const statement of statements) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      index(statement.id.name, statement);
    } else if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        if (t.isIdentifier(declarator.id)) index(declarator.id.name, functionOf(declarator.init));
      }
    }
  }

  return { functionsMentioning: (name) => byName.get(name) ?? [] };
}

/**
 * A decoder declared *inside* the scope that holds the array.
 *
 * `var _0xa = [...]` at module level with `function _0xdec(i) { return _0xa[i]; }`
 * one scope down is perfectly ordinary, and the statement scan above cannot see
 * it. Rather than walking every nested function, this walks the array binding's
 * own references - there are only ever a handful - which is both cheaper and
 * exact about which binding it followed.
 *
 * It runs only when the statement scan found nothing, so a file that already
 * resolves its decoder is unaffected, and it declines outright once the array
 * has more than a handful of references: a table read directly at two thousand
 * call sites has no hidden decoder, and searching for one there would invent
 * candidates that only exist to be thrown away.
 */
function findNestedDecoderFor(
  scope: SliceScope,
  arrayName: string,
): DecoderRecognition | undefined {
  const binding = scope.scope.getBinding(arrayName);
  if (!binding) return undefined;
  if (binding.referencePaths.length > MAX_REFERENCES_FOR_NESTED_DECODER) return undefined;

  const found = new Map<t.Node, DecoderRecognition>();
  for (const reference of binding.referencePaths) {
    if (reference.removed) continue;
    const fn = reference.getFunctionParent();
    if (!fn || found.has(fn.node)) continue;
    if (fn.node.params.length === 0 || fn.node.params.length > MAX_DECODER_PARAMS) continue;
    if (exceedsNodeBudget(fn.node, MAX_NESTED_DECODER_NODES)) continue;

    const owner = namedFunctionOwner(fn);
    if (!owner || owner.name === arrayName) continue;
    found.set(fn.node, {
      name: owner.name,
      fn: fn.node,
      references: owner.scope.scope.getBinding(owner.name)?.references ?? 0,
      scope: owner.scope,
    });
  }

  return [...found.values()].sort((a, b) => b.references - a.references)[0];
}

/** The name a function is bound to, and the statement list that binds it. */
function namedFunctionOwner(
  fn: NodePath<t.Function>,
): { name: string; scope: SliceScope } | undefined {
  if (fn.isFunctionDeclaration() && fn.node.id) {
    const scope = asSliceScope(fn.parentPath);
    return scope ? { name: fn.node.id.name, scope } : undefined;
  }
  const declarator = fn.parentPath;
  if (!declarator?.isVariableDeclarator() || !t.isIdentifier(declarator.node.id)) return undefined;
  const scope = asSliceScope(declarator.parentPath?.parentPath);
  return scope ? { name: declarator.node.id.name, scope } : undefined;
}

function functionOf(node: t.Node | null | undefined): t.Function | undefined {
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return node;
  return undefined;
}

/** `X.push(X.shift())` anywhere inside - the string-array rotation signature. */
function containsRotationShuffle(node: t.Node): boolean {
  let found = false;
  walk(node, (current) => {
    if (found) return false;
    if (
      t.isCallExpression(current) &&
      isMemberCall(current, 'push') &&
      current.arguments.length === 1 &&
      isMemberCall(current.arguments[0], 'shift')
    ) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function isMemberCall(node: t.Node | null | undefined, method: string): boolean {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  if (!t.isMemberExpression(callee)) return false;
  const name = callee.computed ? staticString(callee.property) : identifierName(callee.property);
  return name === method;
}

function identifierName(node: t.Node): string | undefined {
  return t.isIdentifier(node) ? node.name : undefined;
}

/** Bounded structural walk; `visit` returns false to prune the subtree. */
function walk(root: t.Node, visit: (node: t.Node) => boolean): void {
  let budget = MAX_WALK_NODES;
  const stack: t.Node[] = [root];
  while (stack.length > 0 && budget-- > 0) {
    const node = stack.pop()!;
    if (!visit(node)) continue;
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

// ---------------------------------------------------------------------------
// Reference safety
// ---------------------------------------------------------------------------

interface ForwarderWalk {
  /** Bindings that provably denote the same value: the root and its aliases. */
  bindings: Binding[];
  /** References that are not merely another link in the alias chain. */
  external: NodePath[];
  /** Alias links past {@link MAX_ALIAS_DEPTH}, which the walk did not follow. */
  unfollowed: NodePath[];
}

/**
 * Follow `var b = a; var c = b;` up to {@link MAX_ALIAS_DEPTH} links and
 * collect the references that are real uses rather than further forwarding.
 *
 * Bindings rather than names, because a function-local `var _0x273d8a = _0x123b`
 * is the shape real obfuscator.io output uses in *every* function, and a
 * name-keyed version would confuse it with an unrelated local of the same name
 * in a sibling scope.
 *
 * Bounded by the same depth the call-site index resolves an alias read to,
 * because the two have to agree: this walk used to run to a fixed point while
 * `resolveIdentityAlias` stopped four links out, so a table read only through
 * a five-link alias had two inlinable reads by this count and no sample from
 * the index, and was left encoded with nothing said. A link past the bound
 * is reported rather than followed, so the same table is refused with the
 * link named.
 */
function walkForwarders(root: Binding, exempt: ReadonlySet<t.Node>): ForwarderWalk {
  const walk: ForwarderWalk = { bindings: [], external: [], unfollowed: [] };
  const seen = new Set<Binding>();
  const queue: { binding: Binding; depth: number }[] = [{ binding: root, depth: 0 }];

  while (queue.length > 0) {
    const { binding, depth } = queue.pop()!;
    if (seen.has(binding)) continue;
    seen.add(binding);
    walk.bindings.push(binding);

    for (const reference of binding.referencePaths) {
      if (reference.removed || isInsideAny(reference, exempt)) continue;

      const declarator = forwardingDeclarator(reference);
      if (!declarator) {
        walk.external.push(reference);
        continue;
      }

      const id = declarator.node.id as t.Identifier;
      const next = declarator.scope.getBinding(id.name);
      // An alias that is itself reassigned is not an alias: it may denote
      // something else by the time a call site runs.
      if (!next || !next.constant) {
        walk.external.push(reference);
        continue;
      }
      if (depth >= MAX_ALIAS_DEPTH) {
        walk.unfollowed.push(reference);
        continue;
      }
      queue.push({ binding: next, depth: depth + 1 });
    }
  }

  return walk;
}

/** `var b = <reference>` - the reference forwards the whole value onward. */
function forwardingDeclarator(
  reference: NodePath,
): NodePath<t.VariableDeclarator> | undefined {
  const parent = reference.parentPath;
  if (!parent?.isVariableDeclarator()) return undefined;
  if (parent.node.init !== reference.node) return undefined;
  if (!t.isIdentifier(parent.node.id)) return undefined;
  return parent;
}

/**
 * The nodes of a source's machinery that its reference audits exempt.
 *
 * A unit the slice took is the model: what it does to the table at load is in
 * the decoded values. A declaration statement is a unit only by the accident
 * of the obfuscator's `simplify`, which merges adjacent `var`s - `var _0xt =
 * [...], _0xa = _0xt;` is the table's declarator and an alias beside it, and
 * the alias is a name the rest of the program reverses the table through,
 * out of the model's sight; taken whole, the statement hid the alias, and
 * `_0xa.reverse(); log(_0xt[0])` came out as the literal from before the
 * reverse, at every preset. The same for a capture beside a needed offset
 * (`var _0xn = 0, _0xa = _0xt;`), a function beside either that touches the
 * table when it is later called, and the table function's alias beside its
 * own declarator. So of a declaration statement only the declarators of the
 * source's roots - the table, the decoder - are machinery; every other
 * declarator is judged as a statement of its own would be. Every other unit
 * is exempt whole, as before: the rotation wrapper and a self-replacing table
 * function run entirely inside the model.
 */
export function machineryOf(
  declarations: readonly NodePath[],
  roots: readonly string[],
): Set<t.Node> {
  const machinery = new Set<t.Node>();
  for (const path of declarations) {
    if (path.removed || !path.node) continue;
    const node = path.node;
    if (!t.isVariableDeclaration(node)) {
      machinery.add(node);
      continue;
    }
    for (const declarator of node.declarations) {
      const bound = t.getBindingIdentifiers(declarator.id);
      if (roots.some((root) => root in bound)) machinery.add(declarator);
    }
  }
  return machinery;
}

export interface ArrayReferenceAudit {
  /** References of the form `A[<statically known number>]`, which are inlinable. */
  inlinable: number;
  /** Reads that are not inlinable but that provably cannot mutate the array. */
  opaqueReads: number;
  /** Human-readable descriptions of references that make inlining unsound. */
  unsafe: string[];
}

/**
 * Decide whether a plain string array can be treated as an immutable table.
 *
 * Replacing `A[3]` with its value is only meaning-preserving if nothing ever
 * changes `A`, and "nothing ever changes A" is not something a shape check on
 * the declaration can establish - it is a property of every reference in the
 * program. `A['push']('x')` and `A[i] = y` are both single references that
 * invalidate every other inlining decision, so one of them is enough to refuse
 * the whole candidate.
 *
 * `anchor` is the path the name is resolved from, and it has to be a path rather
 * than the program: two modules in one bundle may each declare `_0x1234`, and
 * auditing the wrong one of them either clears an array that is mutated or
 * refuses one that is not.
 */
export function auditArrayReferences(
  anchor: NodePath,
  name: string,
  exempt: ReadonlySet<t.Node>,
): ArrayReferenceAudit {
  const audit: ArrayReferenceAudit = { inlinable: 0, opaqueReads: 0, unsafe: [] };
  const binding = anchor.scope.getBinding(name);
  if (!binding) {
    audit.unsafe.push(`${name} has no binding in the scope it was found in`);
    return audit;
  }

  const walk = walkForwarders(binding, exempt);

  // Reassignment is checked without the exemption the other clauses get. The
  // slicer treats `_0xa = [...]` as decoder machinery because for a *rotated*
  // array it usually is, but for a table read directly at call sites any
  // rebinding at all means the decoded values are not the values that run.
  for (const alias of walk.bindings) {
    for (const violation of alias.constantViolations) {
      audit.unsafe.push(`${alias.identifier.name} is reassigned at line ${lineOf(violation)}`);
    }
  }
  for (const link of walk.unfollowed) {
    audit.unsafe.push(
      `${name} is aliased more than ${MAX_ALIAS_DEPTH} links deep at line ${lineOf(link)}, ` +
        `past where its references are followed`,
    );
  }

  for (const reference of walk.external) {
    const parent = reference.parentPath;
    if (!parent?.isMemberExpression() || parent.node.object !== reference.node) {
      // A test of the value is a read of it: `if (!A)`, `typeof A`, `A === x`,
      // `A ? a : b`, and `A && ...` where the result is itself tested or
      // discarded. Nothing there can reach the array's contents.
      if (isTestedOnly(reference)) {
        audit.opaqueReads++;
        continue;
      }
      audit.unsafe.push(`${name} escapes as a value at line ${lineOf(reference)}`);
      continue;
    }

    const member = parent as NodePath<t.MemberExpression>;
    if (!isPureContext(member)) {
      audit.unsafe.push(`${name} is written through at line ${lineOf(member)}`);
      continue;
    }

    const key = member.node.computed
      ? (staticNumber(member.node.property) ?? staticString(member.node.property))
      : identifierName(member.node.property);

    if (typeof key === 'number') {
      audit.inlinable++;
      continue;
    }

    // `A.length` cannot mutate; `A['push']()` can, and an unresolved computed key
    // might be either, so a call through one is a refusal.
    const calledAsMethod = member.parentPath?.isCallExpression()
      ? member.parentPath.node.callee === member.node
      : false;
    if (!calledAsMethod && (key === 'length' || member.node.computed)) {
      audit.opaqueReads++;
      continue;
    }
    audit.unsafe.push(`${name}${describeKey(member.node)} at line ${lineOf(member)} may mutate it`);
  }

  return audit;
}

/**
 * Whether a reference's value goes nowhere but a test: the operand of `!`,
 * `typeof` or `void`, an equality against something, the test of a branch or
 * loop or conditional, or an operand of `&&`/`||`/`??` whose own value is
 * tested or discarded in turn. Every one of these reads the value as a whole
 * - its truthiness, its type, its identity - and none can index it, call a
 * method on it or hand it on.
 */
function isTestedOnly(reference: NodePath): boolean {
  let current: NodePath = reference;
  for (let depth = 0; depth < 8; depth++) {
    const parent = current.parentPath;
    if (!parent) return false;
    if (parent.isUnaryExpression()) {
      const operator = parent.node.operator;
      return operator === '!' || operator === 'typeof' || operator === 'void';
    }
    if (parent.isBinaryExpression()) {
      const operator = parent.node.operator;
      return operator === '===' || operator === '!==' || operator === '==' || operator === '!=';
    }
    if (parent.isConditionalExpression()) return parent.node.test === current.node;
    if (parent.isIfStatement() || parent.isWhileStatement() || parent.isDoWhileStatement()) {
      return parent.node.test === current.node;
    }
    if (parent.isForStatement()) return parent.node.test === current.node;
    if (parent.isExpressionStatement()) return true;
    if (parent.isLogicalExpression()) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function describeKey(node: t.MemberExpression): string {
  if (!node.computed) return `.${identifierName(node.property) ?? '?'}`;
  const key = staticString(node.property) ?? staticNumber(node.property);
  return key === undefined ? '[?]' : `[${JSON.stringify(key)}]`;
}

function lineOf(path: NodePath): number {
  return path.node.loc?.start.line ?? 0;
}

export function isInsideAny(path: NodePath, nodes: ReadonlySet<t.Node>): boolean {
  if (nodes.size === 0) return false;
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    if (nodes.has(current.node)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Alias and wrapper resolution
// ---------------------------------------------------------------------------

/**
 * What an identifier at a call site ultimately denotes.
 *
 * `wrapper` is the indirection obfuscator.io calls a "string array wrapper":
 * `function w(a, b, c) { return dec(c - 0xf4, b); }`. The index arithmetic is
 * kept as an AST expression rather than a scraped constant, because the shape
 * varies (`c - 0xf4`, `-0x2 + c`, `c ^ 0x1f`) and only evaluating it is correct.
 */
export type DecoderEntry =
  | { kind: 'source'; source: StringSource }
  | {
      kind: 'wrapper';
      name: string;
      params: readonly string[];
      args: readonly t.Expression[];
      target: DecoderEntry;
    };

/**
 * What places a link of an alias or wrapper chain in time - the string-code
 * facts and the tree's numbering that `holdsDeclaredValue` reads. See
 * {@link DecoderIndex} for what the index asks of them.
 */
export interface ChainPlacement {
  strings: NameAddressing;
  order?: TreeOrder;
}

/**
 * Resolves identifiers to decoders, scope-correctly and to a fixed point.
 *
 * Real obfuscator.io output never calls the decoder by its own name: every
 * function opens with `var _0x273d8a = _0x123b, _0x10de82 = _0x123b;` and calls
 * those. Resolution therefore has to run per call site through Babel's scope
 * chain - a flat name set would rewrite a *shadowing* local with the same name,
 * which is exactly the class of bug that produces silently wrong output.
 *
 * Every link of a chain is a READ made at some moment: `var d = dec` reads
 * `dec` when the declarator runs, `const w = () => dec(0)` reads `dec` when
 * the body runs, which is no earlier than the arrow exists. A name resolved
 * to its initialiser is only that initialiser once the declarator has run -
 * before it a `let` or `const` throws and a `var` holds `undefined` - and
 * the chain is only a chain if each link holds when the read it stands for
 * is made. `const S = () => R(0)` written after `try { log(S()) } catch (e)
 * { log('early', e.name) }` prints `early ReferenceError`; with `S` taken
 * for a wrapper at that site it printed the table's first entry. The index
 * asks `holdsDeclaredValue` of every link it follows, so a wrapper whose
 * body reads a decoder that may not exist yet is not a wrapper. The CALL
 * SITE's own read of the chain's first name is the caller's question, asked
 * of the site - the index caches per binding, and a site is not a binding.
 */
export class DecoderIndex {
  private readonly roots = new Map<Binding, StringSource>();
  private readonly cache = new Map<Binding, DecoderEntry | null>();
  private readonly resolving = new Set<Binding>();
  /**
   * What each var scope hoists a sloppy block function for; see `resolve`.
   * Kept for the index's lifetime, which is one round of one pass: the
   * inlining that reads the index replaces calls with literals and declares
   * nothing, and the pruning only deletes.
   */
  private readonly blockFunctions: BlockFunctionMemo = new Map();

  /** Names proven to forward to a decoder, for reporting and for pruning. */
  readonly aliasNames = new Set<string>();
  readonly wrapperNames = new Set<string>();

  constructor(
    program: NodePath<t.Program>,
    sources: readonly StringSource[],
    private readonly placement: ChainPlacement,
  ) {
    for (const source of sources) {
      const own = bindingFor(program, source, source.name);
      // The decoder itself is routinely non-constant: obfuscator.io's decoder
      // replaces its own binding on first call. An *alias* that is reassigned
      // is a different matter - it may denote something else by the time a call
      // site runs - so aliases are only trusted when nothing rebinds them.
      if (own) this.roots.set(own, source);
      for (const alias of source.aliases) {
        const binding = bindingFor(program, source, alias);
        if (!binding) continue;
        if (!binding.constant && !parameterValue(binding)) continue;
        // Discovery listed the alias by NAME from the program's `var b = a`
        // links; the read of `a` that gives `b` its value is a link like any
        // other. One that cannot be placed is left to `derive`, which refuses
        // it the same way - and so keeps `const b = a; const a = dec` the
        // throw it is, where a root would have let the pruning delete it.
        const value = forwarderValue(binding);
        if (
          value &&
          t.isIdentifier(value.init) &&
          !this.holdsAt(value.init.name, value.init, value.scope)
        ) {
          continue;
        }
        this.roots.set(binding, source);
      }
    }
  }

  /** Whether `name`, read at `at` from `scope`, is what its declaration made it. */
  holdsAt(name: string, at: t.Node, scope: NodePath['scope']): boolean {
    return holdsDeclaredValue(name, at, scope, this.placement.strings, this.placement.order);
  }

  get isEmpty(): boolean {
    return this.roots.size === 0;
  }

  /** Resolve `name` as seen from `path`, or `undefined` if it is not a decoder. */
  resolve(path: NodePath, name: string): DecoderEntry | undefined {
    const binding = this.bindingFrom(path.scope, name);
    if (!binding) return undefined;
    return this.resolveBinding(binding) ?? undefined;
  }

  /**
   * The binding `name` denotes at a read made from `scope` - Babel's answer,
   * unless a sloppy block-level `function name` on the way up can stand in
   * for it. `function dec(i) { return A[i]; } { function dec() { return
   * 'shadow'; } } dec(0)` calls the block's function once the block has run,
   * and Babel, which scopes that declaration to the block, lists the call on
   * the decoder: `dec(0)` came out as the table's first entry at every
   * preset. The same question at every link of an alias or wrapper chain,
   * because each link is a read made from somewhere.
   */
  private bindingFrom(scope: NodePath['scope'], name: string): Binding | undefined {
    const binding = scope.getBinding(name);
    if (!binding) return undefined;
    if (shadowedByBlockFunction(name, scope, binding, this.blockFunctions)) return undefined;
    return binding;
  }

  resolveBinding(binding: Binding): DecoderEntry | null {
    const root = this.roots.get(binding);
    if (root) return { kind: 'source', source: root };

    const cached = this.cache.get(binding);
    if (cached !== undefined) return cached;

    // `var a = b, b = a` and self-calling wrappers must terminate.
    if (this.resolving.has(binding)) return null;
    this.resolving.add(binding);
    let entry: DecoderEntry | null = null;
    try {
      entry = this.derive(binding);
    } finally {
      this.resolving.delete(binding);
    }
    this.cache.set(binding, entry);
    return entry;
  }

  private derive(binding: Binding): DecoderEntry | null {
    const path = binding.path;

    if (binding.constant && path.isFunctionDeclaration() && path.node.id) {
      return this.deriveWrapper(path.node.id.name, path.node, path.scope);
    }

    const value = forwarderValue(binding);
    if (!value) return null;

    if (t.isIdentifier(value.init)) {
      // The read is the initialiser itself, made when the declarator - or
      // the parameter's assignment - runs.
      if (!this.holdsAt(value.init.name, value.init, value.scope)) return null;
      const next = this.bindingFrom(value.scope, value.init.name);
      const resolved = next ? this.resolveBinding(next) : null;
      if (resolved) this.aliasNames.add(value.name);
      return resolved;
    }
    const fn = functionOf(value.init);
    return fn ? this.deriveWrapper(value.name, fn, value.scope) : null;
  }

  /** `function w(a, b, c) { return dec(c - 0xf4, b); }` and its arrow spelling. */
  private deriveWrapper(
    name: string,
    fn: t.Function,
    outerScope: NodePath['scope'],
  ): DecoderEntry | null {
    const params: string[] = [];
    for (const param of fn.params) {
      if (!t.isIdentifier(param)) return null;
      params.push(param.name);
    }

    const call = returnedCall(fn);
    if (!call || !t.isIdentifier(call.callee)) return null;
    // A parameter shadowing the decoder name resolves to the parameter here,
    // which is not a decoder, so the wrapper is correctly refused.
    if (params.includes(call.callee.name)) return null;
    // The body's read of the decoder is placed by the wrapper, since nothing
    // in a body runs before the function it belongs to exists. For a
    // declaration `outerScope` is the function's own scope, so the climb
    // asks its callers; for an expression it is the declarator's, where the
    // function's own place is the evidence.
    if (!this.holdsAt(call.callee.name, fn, outerScope)) return null;

    const calleeBinding = this.bindingFrom(outerScope, call.callee.name);
    if (!calleeBinding) return null;
    const target = this.resolveBinding(calleeBinding);
    if (!target) return null;

    const args: t.Expression[] = [];
    for (const argument of call.arguments) {
      if (!t.isExpression(argument) || !isArithmeticOver(argument, params)) return null;
      args.push(argument);
    }
    if (args.length === 0) return null;

    this.wrapperNames.add(name);
    return { kind: 'wrapper', name, params, args, target };
  }
}

function bindingName(path: NodePath<t.VariableDeclarator>): string {
  return t.isIdentifier(path.node.id) ? path.node.id.name : '';
}

/**
 * Follow `var b = a;` / `b = a` identity aliases from a call site to the name
 * they ultimately denote, stopping at the first one `accept` recognises.
 *
 * Discovery needs this before any decoder exists: a candidate is only adopted
 * once it has been validated against real literal-argument call sites, and in a
 * file where every call is written through an alias - `cL(1147)`, never
 * `Y(1147)` - there are no such sites to find under the decoder's own name. The
 * resolution is scope-correct because it starts from the call site's own scope,
 * so a local of the same name in a sibling function cannot contribute
 * arguments this decoder never receives.
 *
 * Follows at most {@link MAX_ALIAS_DEPTH} links - the same bound the
 * reference audit walks out to, so a read the audit counts is a read this
 * can sample; see `walkForwarders`.
 */
export function resolveIdentityAlias(
  path: NodePath,
  name: string,
  accept: (candidate: string) => boolean,
): string | undefined {
  let scope: NodePath['scope'] | undefined = path.scope;
  let current = name;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    const binding: Binding | undefined = scope?.getBinding(current);
    if (!binding) return undefined;
    const value = forwarderValue(binding);
    if (!value || !t.isIdentifier(value.init)) return undefined;
    if (accept(value.init.name)) return value.init.name;
    current = value.init.name;
    scope = value.scope;
  }
  return undefined;
}

/**
 * Alias links followed from a read to the table it denotes, and from the
 * table out to its reads. Chains are one or two links in real output; the
 * bound stops a cycle (`var a = b; var b = a` is two constant bindings) and
 * is shared by both walks so that they refuse the same chain, with a note,
 * rather than one of them counting a read the other never sampled.
 */
export const MAX_ALIAS_DEPTH = 8;

/** What a name is bound to for the whole of its scope, in either spelling. */
interface ForwarderValue {
  name: string;
  init: t.Expression;
  /** Scope to resolve the value's own free names from. */
  scope: NodePath['scope'];
}

/**
 * The value behind a name that forwards to a decoder.
 *
 * `var cu = cL;` is obfuscator.io's own alias spelling. Cloudflare's post-pass
 * writes the same thing as `cu = cL` with `cu` in
 * the parameter list, which is where 232 of the fixture's decoder aliases live;
 * `parameterValue` is what makes the two equivalent, and it refuses unless the
 * caller's value is provably never read.
 *
 * A binding that is *reassigned* is refused in both spellings: whichever
 * decoder it names today, it may name something else by the time a call site
 * runs.
 */
function forwarderValue(binding: Binding): ForwarderValue | undefined {
  const path = binding.path;
  if (binding.constant && path.isVariableDeclarator()) {
    const init = path.node.init;
    return init ? { name: bindingName(path), init, scope: path.scope } : undefined;
  }
  const value = parameterValue(binding);
  if (!value) return undefined;
  return { name: binding.identifier.name, init: value.init, scope: value.path.scope };
}

/**
 * The binding a source's name denotes, resolved from where the source was found.
 *
 * A decoder inside a module factory has no program-level binding at all, so
 * asking the program scope for one returns nothing and the whole index comes out
 * empty - every call site then resolves to no decoder and nothing is inlined.
 * Resolving from the source's own declarations instead is both correct for
 * nested scopes and, for a top-level source, exactly the same binding it always
 * was. The program is the fallback for a source whose declarations have since
 * been removed.
 */
function bindingFor(
  program: NodePath<t.Program>,
  source: StringSource,
  name: string,
): Binding | undefined {
  const machinery = new Set(
    source.declarations.filter((path) => !path.removed && path.node).map((path) => path.node),
  );
  let fallback: Binding | undefined;

  for (const declaration of source.declarations) {
    if (declaration.removed || !declaration.node) continue;
    // Resolved from *outside* the declaration, not from its own scope. A decoder
    // that shadows its own name - `function G(e, U) { var G = e + '-' + U; ... }`,
    // a real shape - has a binding for `G` inside its body that is a string, not
    // the decoder, and asking the declaration's own scope answers with that
    // shadow. Every call site in the program then resolves to a decoder that was
    // never registered, and the file comes out with the table decoded and not one
    // reference replaced.
    const binding = (declaration.parentPath ?? declaration).scope.getBinding(name);
    if (!binding) continue;
    // A binding the source's own machinery declares is the wanted one; any other
    // same-named binding is only a fallback for aliases, which are declared
    // outside the machinery by definition.
    if (isInsideAny(binding.path, machinery)) return binding;
    fallback ??= binding;
  }

  return fallback ?? program.scope.getBinding(name);
}

/** The single call a forwarder returns, in block or concise-arrow form. */
function returnedCall(fn: t.Function): t.CallExpression | undefined {
  const body = fn.body;
  if (t.isCallExpression(body)) return body;
  if (!t.isBlockStatement(body)) return undefined;
  const statements = body.body;
  if (statements.length !== 1) return undefined;
  const only = statements[0];
  if (!t.isReturnStatement(only) || !t.isCallExpression(only.argument)) return undefined;
  return only.argument;
}

/**
 * Whether an expression is pure arithmetic over the wrapper's own parameters.
 *
 * Anything else - a member access, a call, a name from an enclosing scope -
 * means the argument's value is not determined by the call site alone, and a
 * decoder argument that cannot be determined is one that must not be guessed.
 */
function isArithmeticOver(node: t.Expression, params: readonly string[]): boolean {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) return true;
  if (t.isIdentifier(node)) return params.includes(node.name);
  if (t.isParenthesizedExpression(node)) return isArithmeticOver(node.expression, params);
  if (t.isUnaryExpression(node)) {
    return UNARY_OPERATORS.has(node.operator) && isArithmeticOver(node.argument, params);
  }
  if (t.isBinaryExpression(node)) {
    if (!BINARY_OPERATORS.has(node.operator)) return false;
    if (!t.isExpression(node.left)) return false;
    return isArithmeticOver(node.left, params) && isArithmeticOver(node.right, params);
  }
  return false;
}

const UNARY_OPERATORS = new Set(['-', '+', '~']);
const BINARY_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>']);

/** Decode through any depth of wrapper indirection down to the real decoder. */
export function decodeThrough(
  entry: DecoderEntry,
  args: readonly (string | number)[],
  depth = 0,
): string | undefined {
  if (entry.kind === 'source') return entry.source.decode(args);
  if (depth > 8) return undefined;

  const environment = new Map<string, string | number>();
  for (let i = 0; i < entry.params.length; i++) {
    const value = args[i];
    if (value !== undefined) environment.set(entry.params[i]!, value);
  }

  const mapped: (string | number)[] = [];
  for (const argument of entry.args) {
    const value = evaluateArithmetic(argument, environment);
    if (value === undefined) return undefined;
    mapped.push(value);
  }
  return decodeThrough(entry.target, mapped, depth + 1);
}

/** The `StringSource` an entry bottoms out at, for reporting and pruning. */
export function baseSourceOf(entry: DecoderEntry): StringSource {
  let current = entry;
  while (current.kind === 'wrapper') current = current.target;
  return current.source;
}

/**
 * Evaluate the wrapper's index arithmetic.
 *
 * Deliberately not a general interpreter: the grammar accepted here is exactly
 * the one `isArithmeticOver` admits, so there is no path from a call site's
 * arguments to anything but numbers and strings.
 */
export function evaluateArithmetic(
  node: t.Expression,
  environment: ReadonlyMap<string, string | number>,
): string | number | undefined {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return environment.get(node.name);
  if (t.isParenthesizedExpression(node)) return evaluateArithmetic(node.expression, environment);

  if (t.isUnaryExpression(node)) {
    const value = evaluateArithmetic(node.argument as t.Expression, environment);
    if (typeof value !== 'number') return undefined;
    switch (node.operator) {
      case '-':
        return -value;
      case '+':
        return value;
      case '~':
        return ~value;
      default:
        return undefined;
    }
  }

  if (t.isBinaryExpression(node)) {
    if (!t.isExpression(node.left)) return undefined;
    const left = evaluateArithmetic(node.left, environment);
    const right = evaluateArithmetic(node.right, environment);
    if (left === undefined || right === undefined) return undefined;
    if (node.operator === '+') {
      if (typeof left === 'string' || typeof right === 'string') return `${left}${right}`;
      return left + right;
    }
    // Every operator below coerces to number in JavaScript, so a string operand
    // is not "unknown" - it is NaN, and has to be reported as NaN.
    //
    // This matters because `stringArrayWrappers` permutes arguments: a wrapper
    // like `w(a, b, c, d) => decode(c - 0x85, a)` is called as
    // `w(-407, -390, 'DR5h', -415)`, putting the RC4 key into a numeric slot the
    // decoder never reads. Returning `undefined` there would abandon the whole
    // call site; returning NaN evaluates the arithmetic exactly as the engine
    // would and lets the slot the decoder *does* read resolve normally.
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    switch (node.operator) {
      case '-':
        return leftNumber - rightNumber;
      case '*':
        return leftNumber * rightNumber;
      case '/':
        return leftNumber / rightNumber;
      case '%':
        return leftNumber % rightNumber;
      case '&':
        return leftNumber & rightNumber;
      case '|':
        return leftNumber | rightNumber;
      case '^':
        return leftNumber ^ rightNumber;
      case '<<':
        return leftNumber << rightNumber;
      case '>>':
        return leftNumber >> rightNumber;
      case '>>>':
        return leftNumber >>> rightNumber;
      default:
        return undefined;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Split-string reassembly
// ---------------------------------------------------------------------------

/**
 * Ceiling on a merged literal. `splitStrings` fragments are four characters
 * long, so a legitimate merge is small; an unbounded one lets adversarial input
 * dictate memory use through a chain of `+`.
 */
export const MAX_MERGED_STRING = 32_768;

/**
 * Fold `"wer" + "Class"` into one literal, or return undefined.
 *
 * Only string *literals* qualify. `'a' + b` where `b` is a string-valued
 * variable looks foldable and is not: `+` on anything else coerces, and
 * constant-folding coercion belongs to the simplify stage where the scope
 * analysis to prove the operand's type actually lives.
 */
export function foldStringConcat(node: t.BinaryExpression): t.StringLiteral | undefined {
  if (node.operator !== '+') return undefined;
  const left = node.left;
  const right = node.right;
  if (!t.isStringLiteral(left) || !t.isStringLiteral(right)) return undefined;
  if (left.value.length + right.value.length > MAX_MERGED_STRING) return undefined;
  return t.stringLiteral(left.value + right.value);
}

// ---------------------------------------------------------------------------
// Constant pools
// ---------------------------------------------------------------------------

/**
 * Unbudgeted structural walk; `visit` returns false to prune the subtree.
 *
 * `walk` above caps itself at 20 000 nodes because its callers ask a local
 * question about a decoder-sized subtree. The scans below ask a *whole-program*
 * question - is there a pool anywhere, is there a blob anywhere - and a cap
 * there is not a safety valve, it is a silent wrong answer: the pool this was
 * written for sits at line 5 029 of a 7 400-line file, comfortably past node
 * twenty thousand, and a budgeted walk simply never reaches it.
 */
function walkAll(root: t.Node, visit: (node: t.Node) => boolean): void {
  const stack: t.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!visit(node)) continue;
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

/**
 * A value a constant pool can hold. Deliberately not `string`: a pool that mixes
 * `255`, `!0` and `null` in with its property names is the whole point of the
 * shape, and flattening any of those to text would be a silent miscompile.
 */
export type ConstantPoolValue = string | number | boolean | null;

export interface ConstantPoolCandidate {
  name: string;
  /** The `pool = [...]` declarator. */
  declarator: NodePath<t.VariableDeclarator>;
  /** Exact values, index-aligned with the literal. */
  values: readonly ConstantPoolValue[];
  scopeId: string;
}

/**
 * Entries below this and the array is a tuple, not a table.
 *
 * A protector's pool holds every constant in the program; the ones seen in the
 * wild run to hundreds of entries. Twelve is low enough not to miss a small
 * module and high enough that ordinary `['GET', 200, null]`-style tuples stay
 * out of it.
 */
const MIN_POOL_ENTRIES = 12;

/**
 * A pool entry longer than this is left where it is.
 *
 * Purely a size decision, not a safety one: inlining a two-kilobyte string into
 * three hundred call sites is a correct transformation that makes the output
 * worse. The reads that stay behind keep the pool alive, which is exactly right
 * - nothing claims to have removed it.
 */
const MAX_INLINED_POOL_STRING = 256;

/**
 * Find arrays that are used as constant pools.
 *
 * The discriminator is *heterogeneity*. An array whose entries are all strings
 * is a string array and belongs to `findStringSourceCandidates`, which knows how
 * to look for the decoder that goes with it; an array whose entries are all
 * numbers is a data table - a CRC polynomial set, a lookup curve - and inlining
 * one would be sound but pointless. An array that mixes property names with
 * bit masks, sentinels and hash seeds is neither of those things: it is a
 * protector's pool, holding every constant the program was written with so that
 * no literal survives anywhere in the source.
 *
 * Nothing here keys on a name, and nothing here decides that inlining is safe -
 * that is `auditArrayReferences`' job and the caller's, because it is a property
 * of every reference in the program rather than of the declaration.
 */
export function findConstantPoolCandidates(
  program: NodePath<t.Program>,
  scan: PackedShapeScan = scanPackedShapes(program),
): ConstantPoolCandidate[] {
  // The pre-scan is a raw node walk so that an ordinary file pays for one cheap
  // pass rather than a Babel traversal: building a path for every node of a
  // four-megabyte bundle costs whole seconds, and this runs on every fixpoint
  // iteration and again for every peeled layer. Callers that want both scans
  // share one walk by passing it in.
  if (!scan.pool) return [];

  const candidates: ConstantPoolCandidate[] = [];
  program.traverse({
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!t.isArrayExpression(init) || !t.isIdentifier(path.node.id)) return;
      const values = poolValues(init);
      if (!values) return;
      candidates.push({
        name: path.node.id.name,
        declarator: path,
        values,
        scopeId: scopeId(nearestSliceScope(path) ?? program),
      });
    },
  });
  return candidates;
}


/** The pool's values, or undefined when the array is not a pool. */
function poolValues(node: t.ArrayExpression): ConstantPoolValue[] | undefined {
  if (node.elements.length < MIN_POOL_ENTRIES) return undefined;
  const values: ConstantPoolValue[] = [];
  let strings = 0;
  for (const element of node.elements) {
    const value = constantPoolValueOf(element);
    if (value === undefined) return undefined;
    if (typeof value.value === 'string') strings++;
    values.push(value.value);
  }
  // Heterogeneous or nothing: see `findConstantPoolCandidates`.
  if (strings === 0 || strings === values.length) return undefined;
  return values;
}

/**
 * One pool element as an exact value, or undefined when it is not a constant.
 *
 * Wrapped in an object so that `null` - a perfectly ordinary pool entry - is
 * distinguishable from "this is not a constant".
 */
export function constantPoolValueOf(
  node: t.Node | null | undefined,
): { value: ConstantPoolValue } | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return { value: node.value };
  if (t.isNumericLiteral(node)) return { value: node.value };
  if (t.isBooleanLiteral(node)) return { value: node.value };
  if (t.isNullLiteral(node)) return { value: null };
  if (t.isUnaryExpression(node) && t.isNumericLiteral(node.argument)) {
    // `!0` / `!1` are how a minifier spells the booleans, and `-1` is a literal
    // with a sign. Everything else through `!` or `-` is not a constant that can
    // be reproduced without evaluating something.
    if (node.operator === '-') return { value: -node.argument.value };
    if (node.operator === '!') return { value: !node.argument.value };
  }
  return undefined;
}

/**
 * The literal node for a pool value.
 *
 * The exactness matters more than it looks: `pool[25]` holding `!1` must become
 * `false` and not `"false"`, and `pool[3]` holding `255` must become `255` and
 * not `"255"`. Every path below produces a node of the value's own type, and
 * `undefined` is returned rather than guessed for anything that cannot be
 * written as a literal.
 */
export function constantPoolNode(value: ConstantPoolValue): t.Expression | undefined {
  if (value === null) return t.nullLiteral();
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (typeof value === 'string') {
    return value.length > MAX_INLINED_POOL_STRING ? undefined : t.stringLiteral(value);
  }
  if (!Number.isFinite(value)) return undefined;
  // Babel's validator refuses a negative `NumericLiteral`, and `-0` has to keep
  // its sign, so both go out as an explicit negation.
  if (value < 0 || Object.is(value, -0)) {
    return t.unaryExpression('-', t.numericLiteral(Math.abs(value)));
  }
  return t.numericLiteral(value);
}

/** The statement list a path's declarations live in, for scope identity. */
function nearestSliceScope(path: NodePath): SliceScope | undefined {
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    if (current.isProgram() || current.isBlockStatement()) return current;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Blob decoders
// ---------------------------------------------------------------------------

export interface BlobDecoderCandidate {
  /** Names to hand `sliceForEvaluation`, most specific first. */
  roots: string[];
  scope: SliceScope;
  scopeId: string;
  /** The binding call sites actually name. */
  accessorName: string;
  /** True when `accessorName` only forwards to the real accessor. */
  viaForwarder: boolean;
}

/**
 * Find every `acc(start, length) -> unpack(BLOB.slice(start, start + length))`
 * in the program, plus the guarded forwarders that stand in front of them.
 *
 * This is the shape no string-array recogniser can see. There is no array: the
 * table is one long encoded string, its entries overlap, and a call site names a
 * byte range rather than an index. Recognition is therefore structural in a
 * different place - a two-parameter function whose parameters are used as a
 * *span* over a long string literal - and the actual proof that it decodes
 * anything is left to `recogniseBlobDecoder`, which reads the unpacking loop.
 */
export function findBlobDecoderCandidates(
  program: NodePath<t.Program>,
  scan: PackedShapeScan = scanPackedShapes(program),
): BlobDecoderCandidate[] {
  // Both halves have to be present somewhere in the file before it is worth
  // building paths for anything: a long blob to cut up, and a long distinct
  // alphabet indexed with `indexOf` to unpack it with.
  if (!scan.blob) return [];

  interface NamedFunction {
    name: string;
    scope: SliceScope;
    node: t.Function;
  }

  // Keyed by node, never by name. This family emits one accessor per nested
  // scope and a dozen of them are called `U` or `V`; a name-keyed collection
  // would keep one of each set and silently drop the rest, which is most of the
  // file.
  const accessors: NamedFunction[] = [];
  const accessorNodes = new Set<t.Node>();
  const functions: NamedFunction[] = [];

  program.traverse({
    Function(path) {
      const owner = namedFunctionOwner(path);
      if (!owner) return;
      const entry: NamedFunction = { name: owner.name, scope: owner.scope, node: path.node };
      functions.push(entry);
      if (path.node.params.length === 2 && slicesASpan(path.node)) {
        accessors.push(entry);
        accessorNodes.add(path.node);
      }
    },
  });
  if (accessors.length === 0) return [];

  const candidates: BlobDecoderCandidate[] = [];
  const seen = new Set<string>();
  const propose = (
    entry: NamedFunction,
    accessorName: string,
    viaForwarder: boolean,
  ): void => {
    const roots = [entry.name];
    const key = `${scopeId(entry.scope)}:${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    declareSliceScope(roots, entry.scope);
    candidates.push({
      roots,
      scope: entry.scope,
      scopeId: scopeId(entry.scope),
      accessorName,
      viaForwarder,
    });
  };

  for (const accessor of accessors) propose(accessor, accessor.name, false);

  for (const fn of functions) {
    if (accessorNodes.has(fn.node)) continue;
    for (const accessor of accessors) {
      if (accessor.name === fn.name) continue;
      if (!isPositionalForwarder(fn.node, accessor.name)) continue;
      // The forwarder has to be able to *see* the accessor it names, or it is
      // forwarding to a different function that happens to share the name.
      const binding = fn.scope.scope.getBinding(accessor.name);
      if (!binding) continue;
      const declaration = binding.path.node;
      const denotes =
        declaration === accessor.node ||
        (t.isVariableDeclarator(declaration) && declaration.init === accessor.node);
      if (!denotes) continue;
      propose(fn, accessor.name, true);
      break;
    }
  }

  return candidates;
}

/** `text.slice(p0, p0 + p1)` / `text.substr(p0, p1)` over a long string. */
function slicesASpan(fn: t.Function): boolean {
  const start = t.isIdentifier(fn.params[0]) ? fn.params[0].name : undefined;
  const span = t.isIdentifier(fn.params[1]) ? fn.params[1].name : undefined;
  if (!start || !span) return false;

  let found = false;
  walkAll(fn.body, (node) => {
    if (found) return false;
    if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return true;
    const method = node.callee.computed
      ? staticString(node.callee.property)
      : identifierName(node.callee.property);
    if (method !== 'slice' && method !== 'substring' && method !== 'substr') return true;
    const first = node.arguments[0];
    const second = node.arguments[1];
    if (!t.isIdentifier(first, { name: start }) || !second) return true;
    if (t.isIdentifier(second, { name: span })) found = true;
    else if (
      t.isBinaryExpression(second) &&
      second.operator === '+' &&
      ((t.isIdentifier(second.left, { name: start }) &&
        t.isIdentifier(second.right, { name: span })) ||
        (t.isIdentifier(second.left, { name: span }) &&
          t.isIdentifier(second.right, { name: start })))
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

/** Mirrors the thresholds the native recogniser enforces. */
const MIN_BLOB_CHARS = 64;
const MIN_ALPHABET_CHARS = 32;

/** Whether a program contains either of the two shapes above, at all. */
export interface PackedShapeScan {
  /** A heterogeneous array literal big enough to be a constant pool. */
  pool: boolean;
  /** A long blob *and* a long distinct alphabet indexed with `indexOf`. */
  blob: boolean;
}

/**
 * One raw walk answering both "is there a pool here" and "is there a packed blob
 * here".
 *
 * Both questions are whole-program, both are asked on every fixpoint iteration
 * and again for every peeled layer, and neither can be answered by looking at
 * part of the tree - so the thing to economise is the number of walks, not what
 * each one does. Combining them halves the cost for every file that has neither,
 * which is every file this feature is not for.
 */
export function scanPackedShapes(program: NodePath<t.Program>): PackedShapeScan {
  let pool = false;
  let blobText = false;
  let alphabet = false;

  walkAll(program.node, (node) => {
    if (pool && blobText && alphabet) return false;

    if (!pool && t.isArrayExpression(node) && poolValues(node)) {
      pool = true;
      return true;
    }
    if (t.isStringLiteral(node)) {
      if (node.value.length >= MIN_BLOB_CHARS) blobText = true;
      return true;
    }
    if (
      !alphabet &&
      t.isMemberExpression(node) &&
      t.isStringLiteral(node.object) &&
      node.object.value.length >= MIN_ALPHABET_CHARS &&
      new Set(node.object.value).size === node.object.value.length
    ) {
      const key = node.computed ? staticString(node.property) : identifierName(node.property);
      if (key === 'indexOf') alphabet = true;
    }
    return true;
  });

  return { pool, blob: blobText && alphabet };
}
