import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Pass } from '../../pipeline/pass.js';
import {
  holdsDeclaredValue,
  insideWith,
  isPureContext,
  staticNumber,
  staticString,
  TreeOrder,
} from '../../util/ast.js';
import { parameterValue } from '../../analysis/parameters.js';
import { stringCodeFacts, type StringCodeFacts } from '../../analysis/string-code.js';
import { refreshStringCodeFacts } from '../../analysis/string-code-sites.js';
import {
  expandCall,
  isReassigned,
  readTemplate,
  removeDeclaration,
  removeStatement,
  wouldBecomeDirective,
  type InlineTemplate,
} from './proxy-functions.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * `{ '__proto__': v }` sets a prototype rather than defining a property, so a
 * map carrying that key is not the flat lookup table this pass assumes.
 */
const FORBIDDEN_KEY = '__proto__';

type MapEntry =
  | { kind: 'literal'; value: t.Expression }
  | { kind: 'wrapper'; template: InlineTemplate };

interface Read {
  candidate: MapCandidate;
  entry: MapEntry;
  /** The key this read names, so a key that loses every read can be dropped. */
  key: string;
  /** The binding the read went through: the map itself, or one of its aliases. */
  binding: Binding;
}

/** One `X['k'] = v;` statement of an exploded map, paired with the key it sets. */
interface Builder {
  key: string;
  path: NodePath<t.ExpressionStatement>;
}

/**
 * Where a map's object literal is written.
 *
 * `var X = { ... }` is one spelling. `X = { ... }` with `X` in the enclosing
 * function's parameter list is the other, and it is the *only* one in a file
 * that has been through Cloudflare's post-pass: all 204 of the numeric index
 * maps in the 448 KB fixture are written that way, so requiring `binding.path`
 * to be a `VariableDeclarator` finds none of them. `parameterValue` is what
 * makes the second spelling equivalent to the first.
 */
interface MapSite {
  /** The declarator, when there is one; the exploded-map reader needs it. */
  declarator?: NodePath<t.VariableDeclarator>;
  /** The assignment, for a parameter used as a local. */
  assignment?: NodePath<t.AssignmentExpression>;
  /** The object literal itself, which both spellings share. */
  init: t.ObjectExpression;
}

interface MapCandidate {
  name: string;
  site: MapSite;
  entries: Map<string, MapEntry>;
  /** `X['k'] = v;` statements that build an exploded map, removed with it. */
  builders: Builder[];
  /** `var Y = X;` declarators that forward to this map. */
  aliases: NodePath<t.VariableDeclarator>[];
  reads: number;
  rewritten: number;
  /** Reads approved per key, against which {@link rewrittenByKey} is compared. */
  readsByKey: Map<string, number>;
  rewrittenByKey: Map<string, number>;
  /** A use of the map the analysis never saw; the declaration has to stay. */
  unexpected: boolean;
}

/**
 * Inline the property-alias maps obfuscator.io emits.
 *
 * Two shapes, one mechanism. `stringArrayCallsTransform` and the control-flow
 * storage object put every constant and every operator behind a key:
 *
 * ```js
 * var _0x47 = { 'vksOM': 'getElementById', 'SwUka': function (a, b) { return a + b; } };
 * document[_0x47['vksOM']](id);      // -> document['getElementById'](id)
 * _0x47['SwUka'](left, right);       // -> left + right
 * ```
 *
 * `transformObjectKeys` then explodes the literal into an assignment run
 * (`var X = {}; X['k'] = v; ...; var Y = X;`) so that a matcher looking only for
 * `ObjectExpression` finds none of the 150 maps in the 4 MB fixture. Both forms
 * are read here, because the second is only a different spelling of the first.
 */
export const inlineObjectMapsPass: Pass = {
  id: 'simplify.object-maps',
  title: 'Inline object property-alias maps',
  stage: 'simplify',
  technique: 'functionUnwrapping',
  run: (ctx) => {
    // Computed once for the program; every binding this pass proves then asks
    // the same object, so consulting it costs a map lookup rather than the walk
    // that kept the question out of this file.
    const facts = stringCodeFacts(ctx);
    // The tree's order for the placing proof, numbered on the first read that
    // asks: a rewrite here puts a literal where a read was and moves no
    // statement.
    const order = new TreeOrder(ctx.ast);
    const candidates: MapCandidate[] = [];
    const byBinding = new Map<Binding, MapCandidate>();
    const names = new Set<string>();
    /** Member reads cleared for rewriting, and the identifiers underneath them. */
    const approvedReads = new WeakMap<t.MemberExpression, Read>();
    const approvedRefs = new WeakSet<t.Node>();

    traverse(ctx.ast, {
      // Scope owners are entered before their bodies, so a map is always
      // registered before the code that reads it is visited.
      Scopable(path) {
        if (path.scope.path !== path) return;
        if (ctx.isExhausted()) {
          path.stop();
          return;
        }
        for (const name of Object.keys(path.scope.bindings)) {
          const binding = path.scope.bindings[name];
          if (!binding) continue;
          const candidate = readCandidate(
            binding,
            approvedReads,
            approvedRefs,
            byBinding,
            names,
            facts,
            order,
          );
          if (candidate) candidates.push(candidate);
        }
      },

      // Babel's cached reference list can lag behind another pass's rewrites, so
      // an unapproved use of the name pins the map in place instead of being
      // silently ignored.
      ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
        const { name } = path.node;
        if (!names.has(name) || approvedRefs.has(path.node)) return;
        const candidate = byBinding.get(path.scope.getBinding(name) as Binding);
        if (candidate) candidate.unexpected = true;
      },

      MemberExpression: {
        exit(path: NodePath<t.MemberExpression>) {
          const read = approvedReads.get(path.node);
          // A wrapper is reduced at its call site, one level up.
          if (!read || read.entry.kind !== 'literal') return;
          if (wouldBecomeDirective(read.entry.value, path)) return;
          path.replaceWith(t.inherits(t.cloneNode(read.entry.value, true), path.node));
          recordRewrite(read);
          ctx.markChanged();
          refreshStringCodeFacts(ctx, path);
          if (ctx.isExhausted()) path.stop();
        },
      },

      CallExpression: {
        // Exit order means a map read nested in these arguments is already a
        // plain expression by the time it is copied into the expansion.
        exit(path: NodePath<t.CallExpression>) {
          const callee = path.node.callee;
          if (!t.isMemberExpression(callee)) return;
          const read = approvedReads.get(callee);
          if (!read || read.entry.kind !== 'wrapper') return;
          const expanded = expandCall(read.entry.template, path.node, path.scope);
          // An argument that cannot be moved leaves this site alone, which in
          // turn keeps the whole map alive.
          if (!expanded) return;
          if (wouldBecomeDirective(expanded, path)) return;
          path.replaceWith(expanded);
          recordRewrite(read);
          ctx.markChanged();
          refreshStringCodeFacts(ctx, path);
          if (ctx.isExhausted()) path.stop();
        },
      },
    });

    // The proof above was made against the facts as the traversal began. A
    // value it copied into a timer's argument is a program now, and a map
    // that program names is a use the walk never saw - the same use as any
    // other, and it keeps the declaration the same way.
    const current = stringCodeFacts(ctx);
    if (current !== facts) {
      for (const [binding, candidate] of byBinding) {
        if (current.addresses(binding)) candidate.unexpected = true;
      }
    }

    let rewritten = 0;
    let removed = 0;
    let pruned = 0;
    for (const candidate of candidates) {
      rewritten += candidate.rewritten;
      // A map every reference of which was accounted for cannot be observed in
      // any other way, so entries nothing reads are invisible and go too. Doing
      // it even when nothing was inlined is what shrinks the maps whose only
      // surviving reads are ones `expandCall` refuses.
      if (candidate.unexpected) continue;
      if (candidate.rewritten === candidate.reads) {
        if (retire(candidate)) {
          removed++;
          ctx.markChanged();
        }
        continue;
      }
      const dropped = pruneUnreadEntries(candidate);
      if (dropped > 0) {
        pruned += dropped;
        ctx.markChanged(dropped);
      }
    }

    if (rewritten > 0 || pruned > 0) {
      ctx.report('object-key-map', 'constant property-alias map', 0.9, rewritten);
      const tail = pruned > 0 ? ` Dropped ${pruned} unread entr(y/ies).` : '';
      ctx.note(
        'info',
        `Inlined ${rewritten} alias-map read(s); removed ${removed} map(s).${tail}`,
      );
    }
  },
};

function recordRewrite(read: Read): void {
  read.binding.dereference();
  read.candidate.rewritten++;
  const byKey = read.candidate.rewrittenByKey;
  byKey.set(read.key, (byKey.get(read.key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function readCandidate(
  binding: Binding,
  approvedReads: WeakMap<t.MemberExpression, Read>,
  approvedRefs: WeakSet<t.Node>,
  byBinding: Map<Binding, MapCandidate>,
  names: Set<string>,
  facts: StringCodeFacts,
  order: TreeOrder,
): MapCandidate | undefined {
  if (binding.referencePaths.length === 0) return undefined;

  const site = mapSiteOf(binding);
  if (!site) return undefined;
  const init = site.init;

  const candidate: MapCandidate = {
    name: binding.identifier.name,
    site,
    entries: new Map(),
    builders: [],
    aliases: [],
    reads: 0,
    rewritten: 0,
    readsByKey: new Map(),
    rewrittenByKey: new Map(),
    unexpected: false,
  };

  const builderMembers = new Set<t.MemberExpression>();
  if (init.properties.length > 0) {
    if (!readLiteralEntries(init, candidate.entries)) return undefined;
    // A literal extended by property writes before any read - `const m = {
    // a: fn }; m.RLGat = 'Hello World!'; const alias = m;` is how the
    // control-flow storage object comes out of a partial `transformObjectKeys`
    // - is the same table spelled in two places. Only a declaration of its
    // own can be followed by such a run; any other spelling has no run to read.
    if (
      site.declarator &&
      standsAlone(site.declarator) &&
      !readExplodedEntries(candidate, site.declarator, builderMembers)
    ) {
      return undefined;
    }
  } else if (site.declarator) {
    if (!readExplodedEntries(candidate, site.declarator, builderMembers)) return undefined;
  } else {
    // `X = {}` followed by `X['k'] = v` is readable in principle, but the run
    // has to start immediately after the *statement* that holds the assignment,
    // and an assignment can sit anywhere in a comma sequence. Not worth
    // guessing at: an empty literal with no readable run is simply refused.
    return undefined;
  }
  if (candidate.entries.size === 0) return undefined;

  const pending: Array<{ path: NodePath<t.MemberExpression>; read: Read }> = [];
  const state: Walk = {
    candidate,
    builderMembers,
    matchedBuilders: 0,
    pending,
    approvedRefs,
    facts,
    order,
  };
  if (!collectReads(binding, state, new Set())) return undefined;
  // Every recognised builder statement must be accounted for by a real
  // reference; otherwise the `X` matched textually is some other binding.
  if (state.matchedBuilders !== builderMembers.size) return undefined;
  if (pending.length === 0) return undefined;

  candidate.reads = pending.length;
  for (const { path, read } of pending) {
    approvedReads.set(path.node, read);
    candidate.readsByKey.set(read.key, (candidate.readsByKey.get(read.key) ?? 0) + 1);
  }
  byBinding.set(binding, candidate);
  names.add(candidate.name);
  for (const alias of candidate.aliases) {
    if (!t.isIdentifier(alias.node.id)) continue;
    const aliasBinding = alias.scope.getBinding(alias.node.id.name);
    if (!aliasBinding) continue;
    byBinding.set(aliasBinding, candidate);
    names.add(alias.node.id.name);
  }
  return candidate;
}

/**
 * The object literal a binding holds for the whole of its scope, or nothing.
 *
 * Both spellings have to prove the same thing - that every read of the name
 * sees this literal - and they prove it differently. A `var`/`let`/`const`
 * proves it by never being reassigned; a parameter proves it through
 * `parameterValue`, which additionally has to rule out the caller's value ever
 * being seen.
 */
function mapSiteOf(binding: Binding): MapSite | undefined {
  const path = binding.path;

  if (binding.kind === 'var' || binding.kind === 'let' || binding.kind === 'const') {
    if (isReassigned(binding)) return undefined;
    if (!path.isVariableDeclarator() || !t.isIdentifier(path.node.id)) return undefined;
    const init = path.node.init;
    return t.isObjectExpression(init) ? { declarator: path, init } : undefined;
  }

  if (binding.kind === 'param') {
    const value = parameterValue(binding);
    if (!value || !t.isObjectExpression(value.init)) return undefined;
    return { assignment: value.path, init: value.init };
  }

  return undefined;
}

/** `var X = { 'k': 'v', 'f': function (a, b) { return a + b; } };` */
function readLiteralEntries(init: t.ObjectExpression, entries: Map<string, MapEntry>): boolean {
  for (const property of init.properties) {
    // A spread, a getter, a method or a computed key all make the map's
    // contents something other than a fixed table of constants.
    if (!t.isObjectProperty(property) || property.computed || property.shorthand) return false;
    const key = propertyKey(property.key);
    if (key === undefined || key === FORBIDDEN_KEY) return false;
    if (entries.has(key)) return false;
    const entry = readEntry(property.value);
    if (!entry) return false;
    entries.set(key, entry);
  }
  return true;
}

/**
 * `var X = {}; X['k'] = v; ...` - the `transformObjectKeys` spelling.
 *
 * The run must be contiguous and start immediately after the declaration: a
 * statement in between could read the half-built object, and folding the
 * assignments into a literal would then change what it observed.
 */
function readExplodedEntries(
  candidate: MapCandidate,
  declarator: NodePath<t.VariableDeclarator>,
  builderMembers: Set<t.MemberExpression>,
): boolean {
  const declaration = declarator.parentPath;
  if (!declaration.isVariableDeclaration()) return false;
  if (declaration.node.declarations.length !== 1) return false;
  if (!Array.isArray(declaration.container) || typeof declaration.key !== 'number') return false;

  const container = declaration.container as t.Node[];
  for (let index = declaration.key + 1; index < container.length; index++) {
    const statement = declaration.getSibling(index);
    // Beautifiers leave stray `;` between the assignments; they read nothing.
    if (statement.isEmptyStatement()) continue;
    if (!statement.isExpressionStatement()) break;
    const expression = statement.node.expression;
    if (!t.isAssignmentExpression(expression) || expression.operator !== '=') break;
    const target = expression.left;
    if (!t.isMemberExpression(target)) break;
    if (!t.isIdentifier(target.object, { name: candidate.name })) break;

    const key = memberKey(target);
    if (key === undefined || key === FORBIDDEN_KEY) break;
    const entry = readEntry(expression.right);
    if (!entry) break;
    // A repeated key is last-write-wins here and in a literal, but only if the
    // order is preserved - and a duplicate means the shape was misread anyway.
    if (candidate.entries.has(key)) return false;

    candidate.entries.set(key, entry);
    candidate.builders.push({ key, path: statement });
    builderMembers.add(target);
  }
  return true;
}

/** Whether the declarator is the whole of a declaration that sits in a statement list. */
function standsAlone(declarator: NodePath<t.VariableDeclarator>): boolean {
  const declaration = declarator.parentPath;
  return (
    declaration.isVariableDeclaration() &&
    declaration.node.declarations.length === 1 &&
    Array.isArray(declaration.container) &&
    typeof declaration.key === 'number'
  );
}

function readEntry(value: t.Node): MapEntry | undefined {
  if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
    const template = readTemplate(value);
    return template ? { kind: 'wrapper', template } : undefined;
  }
  if (!t.isExpression(value)) return undefined;
  const isLiteral =
    t.isBooleanLiteral(value) ||
    t.isNullLiteral(value) ||
    staticString(value) !== undefined ||
    staticNumber(value) !== undefined;
  return isLiteral ? { kind: 'literal', value } : undefined;
}

interface Walk {
  candidate: MapCandidate;
  builderMembers: Set<t.MemberExpression>;
  matchedBuilders: number;
  pending: Array<{ path: NodePath<t.MemberExpression>; read: Read }>;
  approvedRefs: WeakSet<t.Node>;
  facts: StringCodeFacts;
  order: TreeOrder;
}

/**
 * Classify every reference to the map, refusing on the first one that is not a
 * static key read or a forwarding alias.
 *
 * This is where the map is proven never to escape: `Object.keys(X)`, `{ ...X }`,
 * `for (k in X)`, `f(X)` and `X[k] = v` outside the build run all fail the
 * member-read test and abandon the whole candidate.
 *
 * References that are no longer in the program are the one thing skipped rather
 * than refused, and that distinction is worth 20% of the fixture's output. See
 * {@link isDetached}.
 *
 * A read is approved only where the name provably holds the literal - past
 * its declarator, which `holdsDeclaredValue` decides. Before it a `let` or
 * `const` throws and a `var` is `undefined`: `try { log(M.K) } catch (e) {
 * log(e.name) } var M = { K: 'k' }` prints `TypeError`, and with the read
 * folded to `'k'` it printed `k`. A read that cannot be placed is still
 * audited - it has to be a read, or the map escapes - but is left as
 * written, where it stays the throw it is, and unapproved it pins the map in
 * place through `unexpected`. The other reads still see the literal, because
 * nothing reassigns it. An alias is a `var` of its own: its reads are placed
 * against its own declarator, and approved only when that declarator was
 * itself placed against the map's - `approve` carries that down - because
 * `var Y = X` run ahead of `X`'s declarator holds `undefined`, not the map.
 */
function collectReads(binding: Binding, state: Walk, seen: Set<Binding>, approve = true): boolean {
  if (seen.has(binding)) return false;
  seen.add(binding);
  // Code compiled from a string reaches the map by its NAME, which is neither a
  // reference in the list below nor a write this walk can see. `eval('M.k')`
  // reads a table `retire` has already deleted; `eval('M.k = v')` writes an
  // entry whose reads this pass has already replaced with the value the literal
  // held.
  //
  // Asked here rather than in `readCandidate` because this is the function that
  // proves a binding, and it proves the aliases as well as the map. On today's
  // shapes the map's own answer already implies theirs - `var Y = X` can only
  // be written where `X` is visible, so an alias is always at or below the
  // map's scope, and both halves of `addresses` are monotone that way - so this
  // placement buys no extra refusal; it buys that the question travels with the
  // proof instead of sitting beside the one binding the map was found through.
  if (state.facts.addresses(binding)) return false;
  // A parameter used as a local *is* reassigned - once, which is what makes it
  // a local. `parameterValue` is the proof that the write happens before every
  // read and that the caller's value is never seen; without consulting it here
  // the whole parameter spelling is rejected one step after being accepted.
  if (isReassigned(binding) && !parameterValue(binding)) return false;

  for (const reference of binding.referencePaths) {
    if (isDetached(reference)) continue;
    // Inside `with (o) { ... }` this name is looked up on `o` first, at run time,
    // so the binding Babel reports is only a fallback and the map's value is not
    // what the read produces. One such reference poisons the whole candidate.
    if (insideWith(reference)) return false;
    if (!reference.isIdentifier()) return false;
    // A parameter holds what `parameterValue` proved it holds from entry.
    const placed =
      approve && holdsDeclaredValue(reference.node.name, reference.node, reference.scope, state.facts, state.order);
    const parent = reference.parentPath;
    if (!parent) return false;

    if (parent.isVariableDeclarator() && parent.node.init === reference.node) {
      // `var _0x28ebcd = _0x8c7ed9;` - transformObjectKeys' terminal alias.
      if (!t.isIdentifier(parent.node.id)) return false;
      const alias = parent.scope.getBinding(parent.node.id.name);
      if (!alias) return false;
      if (placed) {
        state.approvedRefs.add(reference.node);
        state.candidate.aliases.push(parent);
      }
      if (!collectReads(alias, state, seen, placed)) return false;
      continue;
    }

    if (!parent.isMemberExpression() || parent.node.object !== reference.node) return false;

    if (state.builderMembers.has(parent.node)) {
      state.approvedRefs.add(reference.node);
      state.matchedBuilders++;
      continue;
    }

    // Assignment target, `delete`, `++` or a `for...in` head: not a read.
    if (!isPureContext(parent)) return false;
    const key = memberKey(parent.node);
    if (key === undefined) return false;
    const entry = state.candidate.entries.get(key);
    // A key the map does not define means something else writes to it.
    if (!entry) return false;
    // A wrapper read anywhere but a callee position hands the function out as a
    // value, where `_0xmap` is its receiver and inlining would change `this`.
    if (entry.kind === 'wrapper' && !isDirectCallee(parent)) return false;

    if (!placed) continue;
    state.approvedRefs.add(reference.node);
    state.pending.push({
      path: parent,
      read: { candidate: state.candidate, entry, key, binding },
    });
  }
  return true;
}

/**
 * Whether this reference is provably no longer part of the program.
 *
 * Babel builds a binding's reference list once per scope crawl, and a pass that
 * deletes code without handing its references back leaves entries pointing into
 * a subtree that has since been cut out. Read at face value such an entry says
 * "the map escaped into an expression nothing can account for", and one of them
 * was enough to reject a 2,200-key table with 3,900 live reads in the 4 MB
 * fixture - `simplify.fold-constants` had folded one comparison away rounds
 * earlier and the dead path outlived it.
 *
 * The check answers only in the direction it can prove: a `true` means an
 * ancestor really is gone, or the walk never reaches the program root. Anything
 * else - including a path whose node some other rewrite swapped out underneath
 * it - comes back `false` and is judged on its merits, which at worst costs a
 * refusal. Getting that backwards would approve a map that something live still
 * writes to.
 */
function isDetached(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (current.removed || !current.node) return true;
    if (current.isProgram()) return false;
    current = current.parentPath;
  }
  return true;
}

function isDirectCallee(path: NodePath<t.MemberExpression>): boolean {
  const parent = path.parentPath;
  return Boolean(parent?.isCallExpression() && parent.node.callee === path.node);
}

function propertyKey(key: t.Node): string | undefined {
  if (t.isIdentifier(key)) return key.name;
  return staticString(key);
}

function memberKey(node: t.MemberExpression): string | undefined {
  if (!node.computed) return t.isIdentifier(node.property) ? node.property.name : undefined;
  return staticString(node.property);
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/** Drop the map, the statements that built it and every alias that forwarded to it. */
function retire(candidate: MapCandidate): boolean {
  for (const { path } of candidate.builders) {
    if (!path.removed && path.node) removeStatement(path);
  }
  for (const alias of candidate.aliases) removeDeclaration(alias);
  if (candidate.site.declarator) return removeDeclaration(candidate.site.declarator);
  return candidate.site.assignment ? removeAssignment(candidate.site.assignment) : false;
}

/**
 * Delete `X = { ... }` where its value is not itself used.
 *
 * A statement of its own goes entirely. One operand of a comma sequence goes
 * too, unless it is the *last* one, whose value is the sequence's value.
 * Anywhere else - `f(X = {})`, `return X = {}` - the assignment's value is
 * consumed and the map has to stay, which costs nothing but a few bytes because
 * every read of it has already been rewritten.
 */
function removeAssignment(path: NodePath<t.AssignmentExpression>): boolean {
  if (path.removed || !path.node) return false;
  const parent = path.parentPath;
  if (!parent) return false;
  if (parent.isExpressionStatement()) return removeStatement(parent);
  if (parent.isSequenceExpression() && typeof path.key === 'number') {
    if (path.key === parent.node.expressions.length - 1) return false;
    path.remove();
    return true;
  }
  return false;
}

/**
 * Drop the entries of a surviving map that nothing reads any more.
 *
 * The map only survives because a read is left that `expandCall` refused - a
 * `&&` wrapper handed a free identifier, say, where inlining would swallow a
 * `ReferenceError`. In the 4 MB fixture that leaves a 2,200-key table alive for
 * nine reads of three keys.
 *
 * Deleting the other 2,197 is invisible, and the proof is already done:
 * `collectReads` succeeded, so *every* reference to this binding and its
 * aliases is a static-key read of a key the map defines. Nothing can enumerate
 * it, spread it, pass it on or write to it, so an entry no read names cannot be
 * observed. Every value is a literal or a function expression, so building it
 * was inert and skipping it costs nothing either.
 */
function pruneUnreadEntries(candidate: MapCandidate): number {
  const live = (key: string): boolean =>
    (candidate.readsByKey.get(key) ?? 0) > (candidate.rewrittenByKey.get(key) ?? 0);

  let dropped = 0;

  for (const { key, path } of candidate.builders) {
    if (live(key)) continue;
    if (path.removed || !path.node) continue;
    // A comment above the assignment describes it; removeStatement hands it to
    // the next statement rather than deleting what a human wrote.
    if (removeStatement(path)) dropped++;
  }

  const init = candidate.site.init;
  if (init.properties.length > 0) {
    const kept = init.properties.filter((property) => {
      if (!t.isObjectProperty(property)) return true;
      const key = propertyKey(property.key);
      if (key === undefined || live(key)) return true;
      // Annotated entries stay: the comment is the one thing here a human wrote.
      if (property.leadingComments?.length || property.trailingComments?.length) return true;
      dropped++;
      return false;
    });
    if (kept.length !== init.properties.length) init.properties = kept;
  }

  return dropped;
}
