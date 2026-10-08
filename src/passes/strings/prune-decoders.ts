import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { DecoderIndex, isInsideAny } from '../../analysis/string-array.js';
import { stringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import {
  TreeOrder,
  blockFunctionHoisting,
  blockFunctionOutsideUse,
  blockFunctionVarScope,
} from '../../util/ast.js';
import { notedOnce, programPathOf } from './discover.js';

/** External references quoted in the diagnostic when pruning is refused. */
const REPORTED_SURVIVORS = 5;

/**
 * Delete the decoder machinery once nothing reads it any more.
 *
 * Without it the output still opens with the original string array: on a large
 * input, tens of kilobytes of entries that are all dead by the time inlining has
 * finished. Deleting them needs a proof that no reference survives, and that
 * proof is the entire content of this pass.
 *
 * The proof is a single traversal that resolves every identifier through the
 * scope chain and asks whether it still denotes the decoder. That is stricter
 * than reading `binding.referencePaths`, which after tens of thousands of
 * replacements lists identifiers that are no longer in the tree at all, and it
 * is the difference between "looks unused" and "is unused".
 */
export const pruneDecodersPass: Pass = {
  id: 'strings.prune-decoders',
  title: 'Delete decoder machinery once inlined',
  stage: 'strings',
  technique: 'stringDecoding',
  run: (ctx) => {
    const program = programPathOf(ctx.ast);
    if (program) pruneStringMachinery(ctx, program);
  },
};

/**
 * Remove every discovered decoder whose references are all gone. Returns the
 * number of declarations deleted.
 *
 * Exported because a stacked build has to be pruned *between* layers, not only
 * at the end: while the outer rotation wrapper is still in the file it lands in
 * the inner decoder's evaluation slice, and a slice containing two rotation
 * loops offers no way to tell which checksum belongs to which array. Clearing
 * the peeled layer away is what makes the next one recognisable.
 */
export function pruneStringMachinery(
  ctx: PassContext,
  program: NodePath<t.Program>,
  order: TreeOrder = new TreeOrder(ctx.ast),
): number {
  const machinery = new Set(
    ctx.stringSources.flatMap((source) =>
      source.declarations.filter((path) => !path.removed).map((path) => path.node),
    ),
  );
  auditDeletedMachinery(ctx);
  if (machinery.size === 0) {
    // Nothing left to keep: a verdict that kept it stood on a tree since
    // rewritten, and the output bears it out no longer.
    ctx.retract(KEPT_KEY);
    return 0;
  }

  // The survey below proves that no identifier IN THE TREE still denotes the
  // machinery. Code compiled from a string is in no tree, and it addresses the
  // decoder by exactly the name this pass is about to delete. Executed, not
  // hypothesised: `var A = ['alpha','beta','gamma']; function dec(i) { return
  // A[i]; } log(dec(0)); log(dec(1)); log(Function('return dec(2)')());`
  // printed three lines and came out printing two and then throwing
  // `ReferenceError: dec is not defined`.
  //
  // This is the same refusal `clean/unused.ts` makes for every other kind of
  // binding, asked through the same `addresses`, and it has to be made here as
  // well rather than left to that pass: `deadCodeRemoval` is off at the
  // conservative preset and this pass is not, so at that preset nothing else in
  // the pipeline stands between a `Function(src)` and a deleted string array.
  //
  // `addresses` is a name test, not a "some string code exists" test: a
  // `Function('return this')` reads and spells nothing, and does not stop this.
  // What does stop it is a source the analysis cannot read, and then the note
  // below quotes the construct, because the alternative is a file that comes out
  // with its whole table intact and nothing saying which line caused it.
  //
  // No preset overrules this one. `decodeDespiteStringCode` is the aggressive
  // preset's leave to INLINE the sites the tree does hold while a string could
  // be writing the table underneath them - a stale literal, disclosed by
  // `strings.inline` - and it used to be read here as leave to delete the
  // declarations too. Those are not the same trade. A stale literal is drift; a
  // deleted declaration that a string still spells is `ReferenceError` where
  // the input ran: `eval('var t = o; String[t(137)] = ...')` beside a decoder
  // `o` had its call sites inlined, then `o` and its table deleted, and the
  // eval threw on its first statement. So the machinery stays whenever a string
  // can reach it, at every preset; what the option changes is only that the
  // sites above it have already been rewritten, and the note says which of the
  // two situations the reader is looking at.
  // Every reason the machinery is kept is one standing verdict, this one
  // and the two the survey below makes: the round that keeps it for another
  // reason restates it, and the round that deletes the machinery, or finds
  // none left, withdraws it.
  const addressable = stringCodeAddressable(ctx, machineryDeclarations(ctx));
  if (addressable) {
    const inlined = ctx.config.techniqueOptions.stringDecoding.decodeDespiteStringCode;
    const blame = stringCodeFacts(ctx).unreadGlobalSource;
    const source = blame ? ` The source is ${blame}, which this analysis cannot read.` : '';
    ctx.note(
      'warning',
      inlined
        ? `Kept the string-array machinery although its call sites were inlined: code compiled ` +
            `from a string can still reach ${addressable} by name, and deleting a declaration that ` +
            `code spells would make it throw where the input ran. The inlining is the trade ` +
            `stringDecoding.decodeDespiteStringCode takes; the deletion is not part of it.` +
            source
        : `Kept the string-array machinery: code compiled from a string can still reach ${addressable} ` +
            `by name, and no reference counter can see that it does.` +
            source,
      undefined,
      KEPT_KEY,
    );
    return 0;
  }

  // Placed the way `strings.inline` placed them, so a chain the inlining
  // refused to follow is not a forwarder here: its body still reads the
  // decoder, and that read is what keeps the machinery. The inliner's own
  // numbering serves between layers: deleting statements moves none of the
  // nodes that stay.
  const index = new DecoderIndex(program, ctx.stringSources, {
    strings: stringCodeFacts(ctx),
    order,
  });
  if (index.isEmpty) return 0;

  const survey = surveyReferences(program, index, machinery, bindingNamesOf(machinery));
  if (survey.hoisted) {
    ctx.note(
      'warning',
      `Kept the string-array machinery: ${survey.hoisted.name} is a block-level declaration that ` +
        `sloppy-mode hoisting makes reachable from outside its block, and ` +
        `${describeSurvivor(survey.hoisted)} still spells it.`,
      undefined,
      KEPT_KEY,
    );
    return 0;
  }
  if (survey.external.length > 0) {
    // Restated with each round's count: it falls as the rounds inline more.
    ctx.note(
      'warning',
      `Kept the string-array machinery: ${survey.external.length} reference(s) still resolve to it ` +
        `(${survey.external.slice(0, REPORTED_SURVIVORS).map(describeSurvivor).join('; ')}).`,
      undefined,
      KEPT_KEY,
    );
    return 0;
  }

  let removed = 0;
  const deleted = deletedMachineryNames(ctx);
  // Forwarders first: each one is a reference to the declaration behind it, so
  // removing them in the other order would leave the tree briefly inconsistent
  // for anything that re-reads scope in between. These paths came out of the
  // survey's own walk, so they are current by construction.
  for (const path of survey.forwarders) removed += remove(path, deleted);

  // The declarations are not: they were recorded during discovery, which for a
  // second fixpoint round happened before `simplify` last rewrote the tree. See
  // `livePaths`.
  const live = livePaths(program, machinery);
  for (const source of ctx.stringSources) {
    for (const path of source.declarations) {
      const current = live.get(path.node);
      // Absent from the live tree means it has already gone; the danger is the
      // opposite case, a node still in the program reached through a path that
      // no longer describes where it sits.
      if (current) removed += remove(current, deleted);
    }
  }

  if (removed > 0) {
    ctx.markChanged(removed);
    ctx.retract(KEPT_KEY);
    // A running total in one line: the layer loop and the fixpoint rounds
    // each prune what the last left.
    const total = ((ctx.shared.get(REMOVED_TOTAL) as number | undefined) ?? 0) + removed;
    ctx.shared.set(REMOVED_TOTAL, total);
    ctx.note(
      'info',
      `Removed ${total} declaration(s) of string-array machinery after inlining.`,
      undefined,
      'strings.prune-decoders:removed',
    );
  }
  return removed;
}

/** The standing "kept" verdict's key - one for every reason - and the run's running total of deletions. */
const KEPT_KEY = 'strings.prune-decoders:kept';
const REMOVED_TOTAL = 'strings.prune-decoders:removed-total';

/**
 * Names this run has deleted from PROGRAM scope as machinery - the
 * declarations and the forwarders that went with them - for
 * {@link auditDeletedMachinery}. Kept by name because a removed path has no
 * node left to read one from, and program-scope only because that is the
 * audit's question; see {@link programScopeNames}.
 */
function deletedMachineryNames(ctx: PassContext): Set<string> {
  const existing = ctx.shared.get(DELETED_NAMES);
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  ctx.shared.set(DELETED_NAMES, created);
  return created;
}

const DELETED_NAMES = 'strings.prune-decoders:deleted';

/**
 * A name this run deleted as machinery that a string can now spell.
 *
 * The survey and `stringCodeAddressable` prove the tree clear as it stands
 * when the machinery goes, and a later rewrite can put a source where none
 * was: `setTimeout(['log(dec(2))'].join(''), 0)` is a call result when the
 * prune runs and a program once `simplify.fold-constants` has folded it, and
 * nothing can put `dec` back. What can be done is to say so, as an error,
 * because this output throws where the input ran and a report whose last
 * word on the table is `Removed 2 declaration(s)` reads as a success. The
 * rewrites this engine makes refresh the facts as they go - see
 * `analysis/string-code-sites.ts` - so what reaches here is a source the
 * classifier could not read until the rewrite: a call result, a member read.
 *
 * Asked of the program scope, as the binding question `addressesName`, and
 * of the names deleted THERE: `spells` is a test on the name alone, and asked
 * of every name the prune took it reported machinery inside a function -
 * which global code has no path to - as a deletion the output throws on,
 * over an output that runs as the input did. A module's top level is out of
 * reach the same way, and `addressesName` knows it; `spells` does not.
 *
 * Where the source could not be read the line says "may throw": the blunt
 * answer is every name, and that is a hazard, not a proof of one.
 */
function auditDeletedMachinery(ctx: PassContext): void {
  const deleted = ctx.shared.get(DELETED_NAMES);
  if (!(deleted instanceof Set) || deleted.size === 0) return;
  const facts = stringCodeFacts(ctx);
  if (!facts.global) return;
  const program = programPathOf(ctx.ast);
  if (!program) return;
  const spelled = [...(deleted as Set<string>)].filter(
    (name) =>
      facts.addressesName(name, program.scope) && !notedOnce(ctx, `deleted-spelled:${name}`),
  );
  if (spelled.length === 0) return;
  const names = spelled.join(', ');
  const blame = facts.unreadGlobalSource;
  ctx.note(
    'error',
    (blame
      ? `Code compiled from a string may reach ${names} by name - the source is ${blame}, which ` +
        `this analysis cannot read - and`
      : `Code compiled from a string spells ${names}, and`) +
      ` this run deleted the declaration as string-array machinery while that source was still ` +
      `a value it could not read. The output ${blame ? 'may throw' : 'throws'} where the input ` +
      `ran; the declaration cannot be put back, and a run with strings.prune-decoders disabled ` +
      `keeps it.`,
  );
}

/**
 * Every declaration path of every discovered decoder, in one iterator. Paths
 * already detached from the tree are dropped by the consumer, not here.
 */
function* machineryDeclarations(ctx: PassContext): Iterable<NodePath> {
  for (const source of ctx.stringSources) {
    for (const path of source.declarations) yield path;
  }
}

/**
 * The first name among these declarations that code compiled from a string can
 * still address, or `undefined` when none of them can be.
 *
 * Shared with `strings/inline.ts`, which asks it of one decoder's declarations
 * at a time to decide whether that decoder's values are still the values that
 * will run. Both callers are asking `analysis/string-code.ts`'s `addresses`;
 * what differs is only which declarations they hand it.
 *
 * Only the names a declaration BINDS in the scope AROUND it are asked about,
 * and for a function declaration that means its own name and not its
 * parameters. `t.getBindingIdentifiers` lists the parameters too, and a
 * parameter is resolved from the function's own scope - so a decoder written
 * `function dec(_0xdb56) { ... }`, shadowing the very table this is asking about,
 * would answer for the parameter and report the program-scope table as
 * unreachable. That is a miss, not an over-refusal, which is why the name list
 * is narrowed here rather than left to the general helper.
 *
 * The forwarders and aliases that die with the machinery are still NOT
 * enumerated here, and the reason is no longer the same one.
 *
 * For a direct `eval` it remains the old argument: a forwarder holds a
 * reference to the decoder, so its scope is at or below the decoder's own, and
 * an `eval` that reaches the forwarder's scope reaches the decoder's too.
 *
 * For global-scope string code that argument no longer holds, because
 * `addresses` is now a test on the NAME. A source that spells a program-scope
 * alias but not the table it forwards to would answer false for the table and
 * true for nothing this loop asks about, and both passes would then rewrite
 * sites that spell the alias. So a machinery declaration at PROGRAM scope is
 * asked `addressesAnyOwnBinding` instead - can the string code name anything
 * at all in that scope - which covers the alias, the wrapper and every later
 * link without this function having to know they exist. Below program scope the
 * global arm cannot reach in the first place and the per-name question stands.
 */
export function stringCodeAddressable(
  ctx: PassContext,
  declarations: Iterable<NodePath>,
): string | undefined {
  const facts = stringCodeFacts(ctx);
  if (facts.empty) return undefined;
  for (const path of declarations) {
    if (path.removed || !path.node) continue;
    for (const name of declaredNames(path.node)) {
      const binding = path.scope.getBinding(name);
      if (!binding) continue;
      const reachable = binding.scope.path.isProgram()
        ? facts.addressesAnyOwnBinding(binding.scope)
        : facts.addresses(binding);
      if (reachable) return name;
    }
  }
  return undefined;
}

/** The names this declaration binds in the scope AROUND it. */
function declaredNames(node: t.Node): string[] {
  if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) {
    return node.id ? [node.id.name] : [];
  }
  return Object.keys(t.getBindingIdentifiers(node));
}

interface ReferenceSurvey {
  /** Live references: while any of these exist the machinery must stay. */
  external: NodePath[];
  /** Aliases and wrappers that exist only to forward to it, and are now dead. */
  forwarders: NodePath[];
  /**
   * A machinery declaration that is a sloppy block-level function, and the
   * identifier outside its block that its hoisted var may reach.
   *
   * The walk below resolves every identifier through Babel's scopes, and Annex
   * B.3.3 gives such a declaration a use those scopes do not list: it is also
   * a var of the enclosing function or script, so `{ function dec(i) { return
   * A[i]; } log(dec(0)); } log(dec(1));` reaches it from outside the block.
   * The second call resolved to no binding, the walk counted nothing, and the
   * machinery was deleted underneath it. Asked of the declaration as it sits
   * in the tree now, from the same walk, since the recorded paths may be
   * stale - see `livePaths`.
   */
  hoisted?: { name: string; node: t.Identifier };
}

/**
 * Classify every identifier in the program that still denotes a decoder.
 *
 * Three outcomes matter. A reference inside the machinery itself is not a use of
 * it. A reference that only exists to *forward* the decoder onward - the
 * `var _0x273d8a = _0x123b` that opens every function in real obfuscator.io
 * output, or the body of a wrapper nothing calls any more - dies with it.
 * Anything else is a genuine use, and one is enough to keep everything.
 */
function surveyReferences(
  program: NodePath<t.Program>,
  index: DecoderIndex,
  machinery: ReadonlySet<t.Node>,
  machineryNames: ReadonlySet<string>,
): ReferenceSurvey {
  const survey: ReferenceSurvey = { external: [], forwarders: [] };
  const forwarderNodes = new Set<t.Node>();

  // Both spellings of a reference: `<_0xs />` reads a binding through a
  // JSXIdentifier, which an `Identifier` visitor never meets, and a table
  // spelled only as a tag was deleted from under it - `render(<_0xs />)`
  // came out referencing a name the output no longer declared.
  const reference = (path: NodePath<t.Identifier | t.JSXIdentifier>): void => {
    if (!path.isReferencedIdentifier()) return;
    const { name } = path.node;
    // The resolver only knows the *decoder* names. A wrapper's backing table
    // is machinery too, and nothing indexes it - so a surviving `_0xarr[0] =
    // 'z'` would be invisible here and the declaration it needs would be
    // deleted underneath it. That is output that does not run at all.
    if (!index.resolve(path, name) && !declaredByMachinery(path, name, machinery, machineryNames)) {
      return;
    }
    if (isInsideAny(path, machinery)) return;

    const link = forwardingOwner(path, index);
    if (!link) {
      survey.external.push(path);
      return;
    }
    if (forwarderNodes.has(link.node)) return;
    forwarderNodes.add(link.node);
    survey.forwarders.push(link);
  };

  program.traverse({
    FunctionDeclaration(path) {
      if (survey.hoisted || !machinery.has(path.node) || !path.node.id) return;
      const use = blockFunctionOutsideUse(path);
      if (use) survey.hoisted = { name: path.node.id.name, node: use };
    },
    Identifier: reference,
    JSXIdentifier: reference,
  });

  // A forwarder is only dead if nothing outside the machinery uses *it* either,
  // and a live use of an alias shows up in `external` through the same walk -
  // so the presence of any external reference already condemns the whole chain.
  return survey;
}

/** Every name the machinery declarations bind, so the walk can pre-filter cheaply. */
function bindingNamesOf(machinery: ReadonlySet<t.Node>): Set<string> {
  const names = new Set<string>();
  for (const node of machinery) {
    for (const name of Object.keys(t.getBindingIdentifiers(node))) names.add(name);
  }
  return names;
}

/** Whether this reference resolves to a binding the machinery itself declares. */
function declaredByMachinery(
  path: NodePath,
  name: string,
  machinery: ReadonlySet<t.Node>,
  machineryNames: ReadonlySet<string>,
): boolean {
  if (!machineryNames.has(name)) return false;
  const binding = path.scope.getBinding(name);
  // A same-named binding declared elsewhere is a different thing entirely.
  return Boolean(binding && isInsideAny(binding.path, machinery));
}

/**
 * The declaration this reference merely passes the decoder along to, if any.
 *
 * Two shapes forward: `var alias = decoder;`, and a wrapper function whose only
 * statement returns a call to the decoder. Both are recognised by asking the
 * resolver what the *owner* binding denotes, so an alias of an alias of a
 * wrapper is handled by the same code as a direct alias.
 */
function forwardingOwner(reference: NodePath, index: DecoderIndex): NodePath | undefined {
  const parent = reference.parentPath;
  if (
    parent?.isVariableDeclarator() &&
    parent.node.init === reference.node &&
    t.isIdentifier(parent.node.id) &&
    index.resolve(parent, parent.node.id.name)
  ) {
    return parent;
  }

  const fn = reference.getFunctionParent();
  if (!fn) return undefined;
  const owner = ownerBindingOf(fn);
  if (!owner) return undefined;
  const entry = index.resolveBinding(owner);
  // Only a *wrapper* owns its body's reference. If the enclosing function were
  // an alias target rather than a forwarder, its body would be ordinary code.
  if (!entry || entry.kind !== 'wrapper') return undefined;
  return fn.isFunctionDeclaration() ? fn : (fn.parentPath ?? undefined);
}

function ownerBindingOf(fn: NodePath<t.Function>): Binding | undefined {
  if (fn.isFunctionDeclaration() && fn.node.id) return fn.scope.getBinding(fn.node.id.name);
  const parent = fn.parentPath;
  if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.scope.getBinding(parent.node.id.name);
  }
  return undefined;
}

/**
 * Current paths for a set of nodes, found by walking the tree as it is now.
 *
 * A `NodePath` recorded during discovery is only valid until something rewrites
 * one of its ancestors, and the fixpoint loop guarantees that something will:
 * `strings` runs, then `simplify`, then `strings` again. The case that made this
 * necessary is `simplify.sequences` splitting the sequence a rotation wrapper
 * shares with the program's own statements - obfuscator.io emits
 * `(rotate(arr, 0xaa6f2), realCode(), moreRealCode())` under `compact`. After
 * the split the recorded path still points into the dissolved sequence, and
 * `path.remove()` there dutifully edits a node that is no longer part of the
 * program and reports success.
 *
 * The consequence is the worst kind this tool has: the string array and the
 * decoder are deleted, the rotation wrapper that calls them both survives, and
 * the output parses cleanly and throws `ReferenceError` on its first line. So
 * removal never trusts a stored path - it re-finds the node.
 *
 * The walk stops as soon as every node is accounted for, which for machinery
 * declared at the top of the file is a few dozen nodes rather than a traversal.
 */
function livePaths(
  program: NodePath<t.Program>,
  targets: ReadonlySet<t.Node>,
): Map<t.Node, NodePath> {
  const found = new Map<t.Node, NodePath>();
  if (targets.size === 0) return found;
  program.traverse({
    enter(path) {
      if (!targets.has(path.node)) return;
      found.set(path.node, path);
      if (found.size === targets.size) path.stop();
    },
  });
  return found;
}

/**
 * Delete a declaration, including the case Babel gets wrong.
 *
 * `NodePath.remove()` on the *last* element of a sequence expression does not
 * delete it: a removal hook replaces the parent sequence with that element and
 * then marks the path removed, so the node requested for deletion is hoisted
 * into its parent's position while every caller is told it is gone. That is
 * how a rotation wrapper survives with its decoder deleted underneath it, which
 * is output that no longer runs. When the sequence holds nothing but this
 * expression, removing the sequence is what "remove this" actually means.
 */
function remove(path: NodePath, deleted: Set<string>): number {
  if (path.removed || !path.node) return 0;
  const parent = path.parentPath;
  if (parent?.isSequenceExpression() && parent.node.expressions.length === 1) {
    return remove(parent, deleted);
  }
  for (const name of programScopeNames(path)) deleted.add(name);
  path.remove();
  return 1;
}

/**
 * The names this declaration binds at PROGRAM scope - the only ones code
 * compiled in global scope could spell - read before the node goes, since a
 * removed path has no scope left to ask. A forwarder `var d = dec` inside a
 * function is not a deletion of a program-scope `d` beside it; a sloppy
 * block-level decoder at the top of a script IS a program-scope name, through
 * the var Annex B gives it, whatever scope Babel lists its binding in.
 */
function programScopeNames(path: NodePath): string[] {
  const names = declaredNames(path.node);
  if (path.isFunctionDeclaration() && blockFunctionHoisting(path) !== 'none') {
    return blockFunctionVarScope(path).path.isProgram() ? names : [];
  }
  // A function or class declaration's own `path.scope` is the scope it
  // creates, whose parameters could shadow the very name being asked about.
  const scope =
    path.isFunctionDeclaration() || path.isClassDeclaration()
      ? (path.parentPath?.scope ?? path.scope)
      : path.scope;
  return names.filter((name) => scope.getBinding(name)?.scope.path.isProgram() === true);
}

function describeSurvivor(survivor: { node: t.Node }): string {
  const node = survivor.node;
  const name = t.isIdentifier(node) || t.isJSXIdentifier(node) ? node.name : node.type;
  return `${name} at line ${node.loc?.start.line ?? 0}`;
}
