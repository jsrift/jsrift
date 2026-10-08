import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  DecoderIndex,
  baseSourceOf,
  decodeThrough,
  foldStringConcat,
  isInsideAny,
  type DecoderEntry,
} from '../../analysis/string-array.js';
import { stringCodeFacts } from '../../analysis/string-code.js';
import { refreshStringCodeFacts } from '../../analysis/string-code-sites.js';
import type { PassContext, StringSource } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { isSemanticDirective } from '../simplify/proxy-functions.js';
import {
  TreeOrder,
  describeNode,
  insideWith,
  isPureContext,
  staticArguments,
  staticArgumentsAt,
  staticNumber,
  staticString,
} from '../../util/ast.js';
import { isSideEffectFree } from '../../util/purity.js';
import {
  discoverStringSources,
  hasUndiscoveredSource,
  literalArms,
  notedOnce,
  programPathOf,
  recordDecodedString,
  spellStringCodeSites,
} from './discover.js';
import { pruneStringMachinery, stringCodeAddressable } from './prune-decoders.js';

/** Call sites processed between budget checks; 4 MB of input has ~35 000. */
const BUDGET_STRIDE = 1_024;

/**
 * Replace every reference to a discovered string source with its plaintext.
 *
 * The access shapes are the whole job. `A[123]`, `A[0x7b]`, `A[1e3]`,
 * `dec(0x1)`, `dec(0x1, '@m8w')`, a function-local `var d = dec; d(0x1, k)` and
 * a wrapper `w(a, b, c) { return dec(c - 0xf4, b); }` are all the same reference
 * wearing different clothes. Working from the AST rather than from a regular
 * expression is what makes that uniform: `1e3` and `0x7b` are `NumericLiteral`
 * nodes exactly like `123` is, so the scientific-notation call sites that a
 * `[0-9]+` pattern silently skips are handled without a special case.
 *
 * A `run` pass because the decoders it consumes are produced by another `run`
 * pass in the same stage, and stage visitors are merged and run first.
 */
export const inlineStringsPass: Pass = {
  id: 'strings.inline',
  title: 'Replace decoder references with literals',
  stage: 'strings',
  technique: 'stringDecoding',
  run: (ctx) => {
    const program = programPathOf(ctx.ast);
    if (!program) return;

    const state: InlineState = {
      ctx,
      index: new DecoderIndex(program, [], { strings: stringCodeFacts(ctx) }),
      order: new TreeOrder(ctx.ast),
      machinery: new Set(),
      frozen: new Map(),
      decodedAnyway: new Map(),
      settled: new WeakSet(),
      walked: false,
      seen: 0,
      replaced: 0,
      unresolved: 0,
      unplaced: 0,
      undecodable: 0,
      merges: 0,
      pendingConcat: [],
      exhausted: false,
    };

    // Peel one layer per round. A build that has been through obfuscator.io
    // twice hides its second table inside the first: until layer one is
    // decoded, layer two's array is a list of *calls*, not of strings, and no
    // amount of looking at it beforehand will reveal it. Re-running discovery
    // after each round is what turns a one-layer tool into an n-layer one.
    let handled = 0;
    for (let layer = 0; layer < MAX_LAYERS; layer++) {
      if (layer > 0) {
        // A cheap shape scan first: an ordinary single-layer file pays nothing
        // for the layered case beyond this check.
        if (!hasUndiscoveredSource(ctx, program)) break;
        // The layer just peeled has to be *deleted* before the next one can be
        // recognised, not merely decoded - see `pruneStringMachinery`.
        pruneStringMachinery(ctx, program, state.order);
        if (discoverStringSources(ctx, program, state.order) === 0) break;
      }
      if (ctx.stringSources.length === handled) break;
      handled = ctx.stringSources.length;

      inlineLayer(program, state);
      if (state.exhausted || ctx.isExhausted()) break;
    }

    // One standing line per kind of site left as-is, with the count of the
    // last walk that met them: a later round that exposes an argument or
    // peels a layer restates it lower, and the round that leaves none
    // withdraws it. A run that walked nothing - every table frozen, and
    // said to be - learned nothing about them and leaves the lines as they
    // stand.
    if (state.walked) {
      standingCount(
        ctx,
        'strings.inline:unresolved',
        state.unresolved,
        `${state.unresolved} decoder call site(s) had non-constant arguments and were left as-is.`,
      );
      standingCount(
        ctx,
        'strings.inline:unplaced',
        state.unplaced,
        `${state.unplaced} decoder reference(s) could not be placed after the declaration they ` +
          `resolve through and were left as-is.`,
      );
      standingCount(
        ctx,
        'strings.inline:undecodable',
        state.undecodable,
        `${state.undecodable} decoder reference(s) decoded to no string - an index outside the ` +
          `table, or a key the decoder rejected - and were left as-is.`,
      );
    }
    // The blame clause is what turns "nothing was decoded" into something a
    // reader can act on: on a file whose only hazard is one unreadable source,
    // this names the line that cost them the whole table.
    //
    // Each verdict once per run, and only for a source the walk actually met a
    // reference of: the loop restates the stage every round, and a source
    // whose sites were all rewritten in the first has nothing left to be
    // "inlined anyway" in the second.
    const blame = stringCodeFacts(ctx).unreadGlobalSource;
    for (const [source, { name, sites }] of state.frozen) {
      if (sites === 0 || notedOnce(ctx, `frozen:${source.name}`)) continue;
      // Keyed on the source: a later round that finds the string code gone -
      // a wrapper opened, a table spelled out - inlines the sites and
      // withdraws the line.
      ctx.note(
        'warning',
        `Left every reference to ${source.name} encoded: code compiled from a string can reach ` +
          `${name} by name, so nothing proves the table read here is the table the program reads.` +
          (blame ? ` The source is ${blame}, which this analysis cannot read.` : ''),
        undefined,
        `strings.inline:frozen:${source.name}`,
      );
    }
    for (const source of ctx.stringSources) {
      if (!state.frozen.has(source)) ctx.retract(`strings.inline:frozen:${source.name}`);
    }
    // The other side of the same gate, and it says the same thing the other way
    // round: a reader of the report should be able to see that the unprovable
    // rewrite was made deliberately, not that nothing was in the way.
    for (const [source, { name, sites }] of state.decodedAnyway) {
      if (sites === 0 || notedOnce(ctx, `decoded-anyway:${source.name}`)) continue;
      ctx.note(
        'warning',
        `Inlined every reference to ${source.name} anyway: code compiled from a string can reach ` +
          `${name} by name, so if it writes the table before one of these sites runs, the literal ` +
          `here is the old value. Set stringDecoding.decodeDespiteStringCode to false - the ` +
          `aggressive preset turns it on - to leave them encoded instead.` +
          (blame ? ` The source is ${blame}, which this analysis cannot read.` : ''),
      );
    }
    // `splitStrings` fragments *every* literal, so the signature is that merges
    // are on the same order as decodes. A handful of merges in a large file is
    // ordinary source concatenation and reporting it would be a false positive.
    if (state.merges >= MIN_SPLIT_STRING_MERGES && state.merges * 4 >= state.replaced) {
      ctx.report(
        'split-strings',
        `${state.merges} decoded fragment(s) rejoined across ${state.replaced} call site(s)`,
        1,
        state.merges,
      );
    }
  },
};

/** Below this a merge count says nothing about the obfuscator's settings. */
const MIN_SPLIT_STRING_MERGES = 64;

/** A count of sites left as-is: the run's line under `key`, withdrawn at zero. */
function standingCount(ctx: PassContext, key: string, count: number, message: string): void {
  if (count > 0) ctx.note('info', message, undefined, key);
  else ctx.retract(key);
}

/**
 * Sources whose references a walk of this run has met while they were
 * frozen. A later round that finds every source still frozen has nothing a
 * walk could rewrite and nothing new to say of them - the line for each was
 * made on the walk that met its sites - so the walk is not made; see
 * `inlineLayer`.
 */
function frozenWalked(ctx: PassContext): WeakSet<StringSource> {
  const existing = ctx.shared.get(FROZEN_WALKED);
  if (existing instanceof WeakSet) return existing as WeakSet<StringSource>;
  const created = new WeakSet<StringSource>();
  ctx.shared.set(FROZEN_WALKED, created);
  return created;
}

const FROZEN_WALKED = 'strings.inline:frozen-walked';

/**
 * Nesting depth the loop will peel. Stacking obfuscator.io on its own output
 * more than a handful of times is pathological, and each layer costs a full
 * traversal.
 */
const MAX_LAYERS = 8;

/**
 * Rewrite every reference the currently-known decoders account for.
 *
 * The resolver and the machinery set are rebuilt from *all* sources each round,
 * not just the new ones: a later layer's table is reached through the earlier
 * layer's aliases, and both must resolve during the same walk.
 */
function inlineLayer(program: NodePath<t.Program>, state: InlineState): void {
  // The tree's order is numbered once for the run, not afresh per layer: the
  // pruning between layers deletes statements, and within a layer every
  // rewrite replaces an expression in place, and neither moves a node that
  // is left, so a numbering made before either still orders every read this
  // asks about. Numbered per layer, obfuscated2.js paid fifteen walks of
  // the tree for one answer. The facts are per iteration, and a deletion
  // only leaves them more conservative than the tree warrants.
  state.index = new DecoderIndex(program, state.ctx.stringSources, {
    strings: stringCodeFacts(state.ctx),
    order: state.order,
  });
  if (state.index.isEmpty) return;

  // The rotation wrapper calls the decoder *while the array is being shuffled*,
  // so the value it sees is not the value the decoder reports. Inlining there
  // would replace a correct checksum input with a confident, wrong string.
  for (const source of state.ctx.stringSources) {
    for (const declaration of source.declarations) state.machinery.add(declaration.node);
  }

  // What the whole `strings` stage rests on is that the table is a constant:
  // `auditArrayReferences` proves that no reference in the tree writes it, and
  // every decoded value is read out of the array as it was WRITTEN. Code
  // compiled from a string is in no tree and that proof does not cover it.
  // Executed, not hypothesised: `var A = ['alpha','beta','gamma']; function
  // dec(i) { return A[i]; } function m(s) { eval(s); } m('A[0] = "MUT"');
  // log(dec(0));` printed `MUT` and came out printing `alpha`.
  //
  // Per decoder, not per file, so a second table the string code cannot reach
  // is still inlined. A source already found exposed is not asked again in a
  // later layer of the same run; the map itself is rebuilt on the next fixpoint
  // iteration, so a hazard an earlier stage deleted stops costing anything.
  //
  // "Cannot reach" is a name question when the string code compiles in global
  // scope: `Function('return this')` spells nothing, so it exposes nothing and
  // this loop freezes nothing. It is only a whole-file refusal when the source
  // itself cannot be read - see `analysis/string-code.ts`.
  //
  // Which preset pays that price is the one thing configurable here. The
  // question is asked identically either way and the freeze it produces is
  // unchanged; `decodeDespiteStringCode` only decides whether the answer stops
  // the inlining or is recorded and reported. See that option in src/types.ts.
  const decodeAnyway = state.ctx.config.techniqueOptions.stringDecoding.decodeDespiteStringCode;
  for (const source of state.ctx.stringSources) {
    if (state.frozen.has(source) || state.decodedAnyway.has(source)) continue;
    let name = stringCodeAddressable(
      state.ctx,
      source.declarations.filter((path) => !path.removed),
    );
    // A source the facts cannot read because its text is spelled in calls
    // to the decoders of this index - the console stub's `Function(d(0xf7)
    // + d(0x105) + ');')()` - is read through them, and the table judged on
    // what it says. The decoders are proved, and what they read is what the
    // site compiles the first time it runs; see `readStringCodeThrough`.
    if (name && stringCodeFacts(state.ctx).unreadGlobalSource !== undefined) {
      const spelled = spellStringCodeSites(program, state.ctx, state.index, state.order);
      if (spelled) {
        // A rewrite of the live tree, kept only by the judgement below: a
        // throw on the way to it puts every node back.
        let kept = false;
        try {
          const still = stringCodeAddressable(
            state.ctx,
            source.declarations.filter((path) => !path.removed),
          );
          if (!still) {
            spelled.commit();
            kept = true;
            state.ctx.note('info', spelled.describe(`held every reference to ${source.name}`));
            name = undefined;
            // The commit rebuilt program scope, and the index resolves by
            // binding: made again over the tables as they now stand, or the
            // walk below would resolve nothing through it.
            state.index = new DecoderIndex(program, state.ctx.stringSources, {
              strings: stringCodeFacts(state.ctx),
              order: state.order,
            });
          }
        } finally {
          if (!kept) spelled.revert();
        }
      }
    }
    if (!name) continue;
    if (decodeAnyway) state.decodedAnyway.set(source, { name, sites: 0 });
    else state.frozen.set(source, { name, sites: 0 });
  }

  // Every source frozen, and every one of them met by a walk of an earlier
  // round: the walk would rewrite nothing - a frozen site is counted and
  // left - and the line for each is made. The whole-program traversal is
  // the cost of a round on such a file, paid for nothing; see `frozenWalked`.
  const walked = frozenWalked(state.ctx);
  const frozen = [...state.frozen.keys()];
  if (
    state.decodedAnyway.size === 0 &&
    state.ctx.stringSources.every((source) => state.frozen.has(source)) &&
    frozen.every((source) => walked.has(source))
  ) {
    return;
  }
  for (const source of frozen) walked.add(source);
  state.walked = true;

  program.traverse({
    // `exit` so that a nested `dec(dec(0x1))` has its inner call replaced by a
    // literal before the outer one asks whether its arguments are static.
    CallExpression: { exit: (path) => inlineCall(path, state) },
    MemberExpression: { exit: (path) => inlineIndex(path, state) },
  });

  mergeSplitFragments(state);
}

/** A decoder string code can reach: by which name, and at how many sites this run. */
interface Exposure {
  name: string;
  sites: number;
}

interface InlineState {
  ctx: PassContext;
  index: DecoderIndex;
  /** The tree's order for the placing proof, shared by every layer and prune of the run. */
  order: TreeOrder;
  machinery: Set<t.Node>;
  /**
   * Decoders whose machinery code compiled from a string can still address, the
   * name that reaches it, and how many sites this run met and left. Kept per
   * source rather than as one flag so that a file with two string arrays, only
   * one of them exposed, still has the other one inlined.
   */
  frozen: Map<StringSource, Exposure>;
  /**
   * Decoders that were exposed in exactly that way and inlined regardless,
   * because `decodeDespiteStringCode` is on. Kept separately from `frozen`
   * rather than simply not recorded, so the run can report the trade it took;
   * membership here also stops the question being re-asked per layer, which is
   * what `frozen` does for the other branch.
   */
  decodedAnyway: Map<StringSource, Exposure>;
  /**
   * The arms a distributed conditional was cut into, each settled by the cut
   * itself - inlined, or counted as left - so the walk, which Babel's requeue
   * brings back over the conditional's children, does not settle them again.
   */
  settled: WeakSet<t.Node>;
  /** Whether a layer of this run made its walk, and so has counts to stand on. */
  walked: boolean;
  /** Reference sites the decoder was asked about, for the budget stride. */
  seen: number;
  /** Reference sites actually rewritten to a literal. */
  replaced: number;
  unresolved: number;
  /** Reference sites that resolve to a decoder but may run before its declarator. */
  unplaced: number;
  /** Reference sites with literal arguments the decoder returned nothing for. */
  undecodable: number;
  merges: number;
  /** `+` expressions that gained a literal operand and may now be foldable. */
  pendingConcat: NodePath<t.BinaryExpression>[];
  exhausted: boolean;
}

/** `dec(0x1)`, `dec(0x1, '@m8w')`, `alias(0x1, k)`, `wrapper(a, b, 0x1)`. */
function inlineCall(path: NodePath<t.CallExpression>, state: InlineState): void {
  if (state.exhausted || state.settled.has(path.node)) return;
  const callee = path.node.callee;
  if (!t.isIdentifier(callee)) return;
  if (isInsideAny(path, state.machinery)) return;
  // `with (o) { dec(1) }` resolves `dec` against `o` first, at run time, so the
  // decoder this name binds to is only a fallback and may never be called.
  if (insideWith(path)) return;

  const entry = state.index.resolve(path, callee.name);
  if (!entry) return;
  // Indexing shapes are reached through `A[i]`; a *call* to a plain array is
  // not a string read and must not be rewritten into one.
  if (baseSourceOf(entry).kind !== 'wrapper-call') return;
  // The index placed every link below this name; the site's own read of it
  // is placed here. Before the declarator a `const` wrapper throws and a
  // `var` one is `undefined`: `try { log(S()) } catch (H) { log('early',
  // H.name) } const S = () => R(0)` prints `early ReferenceError`, and with
  // the call taken for the decoded string it printed the string. The
  // decoder itself is a hoisted `function` and passes by kind, which is
  // what keeps this from costing the ordinary file a climb per call.
  if (!state.index.holdsAt(callee.name, callee, path.scope)) {
    state.unplaced++;
    return;
  }

  const args = staticArgumentsAt(path, stringCodeFacts(state.ctx), state.order);
  if (!args) {
    if (distributeConditional(path, entry, state)) return;
    state.unresolved++;
    return;
  }

  replaceWithDecoded(path, entry, args, state);
}

/**
 * `dec(p ? 0xc7 : 0xc8)`: two sites behind one test. The decoder is pure on
 * its proof, and the test is evaluated once before either call, so `p ?
 * dec(0xc7) : dec(0xc8)` computes the same string - and each arm is a site
 * with a literal argument, which the inliner then places a literal at. What
 * the rewrite moves is the order of the test against the callee read: the
 * call reads `dec` before it evaluates its arguments, the conditional after,
 * so the test has to be one that cannot rebind anything, and the other
 * arguments - copied into both arms - literals. One conditional argument,
 * of literals or of conditionals of literals; a table the run has frozen is
 * left as written, so its accounting stays whole.
 *
 * The arms are placed by the site they were cut from: they sit where the
 * call sat, and its read of the callee was placed before the cut, so each
 * is settled here - inlined, or counted as left - once. The walk comes back
 * over the conditional's children through Babel's requeue and finds them
 * settled.
 */
function distributeConditional(
  path: NodePath<t.CallExpression>,
  entry: DecoderEntry,
  state: InlineState,
): boolean {
  const args = path.node.arguments;
  const at = args.findIndex((argument) => t.isConditionalExpression(argument));
  if (at === -1) return false;
  const conditional = args[at] as t.ConditionalExpression;
  if (!literalArms(conditional)) return false;
  for (let index = 0; index < args.length; index++) {
    if (index === at) continue;
    const argument = args[index]!;
    if (staticNumber(argument) === undefined && staticString(argument) === undefined) return false;
  }
  if (!isSideEffectFree(conditional.test, path.scope)) return false;
  const base = baseSourceOf(entry);
  if (state.frozen.has(base) || state.decodedAnyway.has(base)) return false;

  const arm = (value: t.Expression): t.CallExpression =>
    t.callExpression(
      t.cloneNode(path.node.callee),
      args.map((argument, index) => (index === at ? value : t.cloneNode(argument as t.Expression))),
    );
  const [replaced] = path.replaceWith(
    t.inherits(t.conditionalExpression(conditional.test, arm(conditional.consequent), arm(conditional.alternate)), path.node),
  );
  state.ctx.markChanged();
  for (const key of ['consequent', 'alternate'] as const) {
    const site = replaced.get(key);
    if (site.isCallExpression()) settleArm(site, entry, state);
  }
  return true;
}

/** One arm of a distributed conditional: a literal site, or a conditional of literals cut in turn. */
function settleArm(site: NodePath<t.CallExpression>, entry: DecoderEntry, state: InlineState): void {
  state.settled.add(site.node);
  const args = staticArguments(site.node.arguments);
  if (args) {
    replaceWithDecoded(site, entry, args, state);
    return;
  }
  if (!distributeConditional(site, entry, state)) state.unresolved++;
}

/** `A[123]`, `A[0x7b]`, `A[1e3]`, and the same through any alias of `A`. */
function inlineIndex(path: NodePath<t.MemberExpression>, state: InlineState): void {
  if (state.exhausted) return;
  const { node } = path;
  if (!node.computed || !t.isIdentifier(node.object)) return;
  if (!isPureContext(path)) return;
  if (isInsideAny(path, state.machinery)) return;
  // See `inlineCall`: inside a `with` body the table name may resolve elsewhere.
  if (insideWith(path)) return;

  const index = staticNumber(node.property);
  if (index === undefined) return;

  const entry = state.index.resolve(path, node.object.name);
  if (!entry || entry.kind !== 'source' || entry.source.kind !== 'array-index') return;
  // As in `inlineCall`: `A[0]` ahead of `var A = [...]` is a `TypeError`. The
  // slicer refuses such a table at discovery already, from its own reading of
  // the uses; the rewrite made here rests on this proof rather than on that
  // reading staying as strict as it is.
  if (!state.index.holdsAt(node.object.name, node.object, path.scope)) {
    state.unplaced++;
    return;
  }

  replaceWithDecoded(path, entry, [index], state);
}

function replaceWithDecoded(
  path: NodePath<t.CallExpression | t.MemberExpression>,
  entry: DecoderEntry,
  args: readonly (string | number)[],
  state: InlineState,
): void {
  // Both callers resolve through a chain of aliases and wrappers that bottoms
  // out in one table, and it is the table's exposure that decides - but only
  // because of how the exposure is asked. A direct `eval` that could rebind an
  // alias could already write the table, since an alias is declared at or below
  // the table's own scope. Global-scope string code needs the other half of
  // `stringCodeAddressable`: it names things rather than reaching scopes, and a
  // source that spells the alias and not the table would leave this test false
  // while `alias(0)` was still rebindable underneath it.
  const base = baseSourceOf(entry);
  const frozen = state.frozen.get(base);
  if (frozen) {
    frozen.sites++;
    return;
  }
  const anyway = state.decodedAnyway.get(base);
  if (anyway) anyway.sites++;
  if (++state.seen % BUDGET_STRIDE === 0 && state.ctx.isExhausted()) {
    state.exhausted = true;
    state.ctx.note('warning', 'Time budget reached; the remaining call sites were left encoded.');
    return;
  }

  const value = decodeThrough(entry, args);
  // `undefined` covers an out-of-range index, a key the decoder rejected, and
  // the point at which `maxDecodeCalls` cuts the run off. All three mean the
  // same thing here: what this reference stands for is unknown. Counted, so a
  // site left encoded for it is a line in the report and not a bare `dec(99)`
  // beside a table the survey then keeps for it.
  if (value === undefined) {
    state.undecodable++;
    return;
  }
  // A lone string statement is a directive. `_0x1(0x0);` at the top of a body
  // is an ordinary discarded call; `'use strict';` in the same place puts the
  // whole function into strict mode. Every other string is inert either way, so
  // only the two that mean something are refused.
  if (isSemanticDirective(value) && path.parentPath?.isExpressionStatement()) return;

  const reference = describeNode(path.node);
  const literal = t.inherits(t.stringLiteral(value), path.node);
  path.replaceWith(literal);
  state.replaced++;
  state.ctx.markChanged();
  recordDecodedString(state.ctx, reference, value);
  // A value the table held for a timer is a program now, spelled out where
  // the classifier reads it, and the prune that follows in this stage asks
  // facts taken before this site was rewritten.
  refreshStringCodeFacts(state.ctx, path);

  const parent = path.parentPath;
  if (parent?.isBinaryExpression({ operator: '+' })) state.pendingConcat.push(parent);
}

/**
 * Rejoin `splitStrings` fragments the inlining just produced.
 *
 * obfuscator.io's `splitStrings` chops every literal into four-character pieces
 * and rebuilds them with `+`, so decoding leaves `"cons" + "truc" + "tor"`
 * behind. Folding happens *after* the traversal rather than inside it because
 * the node being folded is an ancestor of the node just replaced, and rewriting
 * an ancestor mid-traversal invalidates the path Babel is currently walking.
 */
function mergeSplitFragments(state: InlineState): void {
  const pending = state.pendingConcat;
  state.pendingConcat = [];
  for (const start of pending) {
    let path: NodePath | null = start;
    while (path?.isBinaryExpression()) {
      if (path.removed) break;
      // Folding a whole statement down to one literal turns it into a
      // directive, which at the top of a function body changes strict mode.
      if (path.parentPath.isExpressionStatement()) break;
      const merged = foldStringConcat(path.node);
      if (!merged) break;
      const parent: NodePath | null = path.parentPath;
      path.replaceWith(t.inherits(merged, path.node));
      state.ctx.markChanged();
      state.merges++;
      path = parent;
    }
  }
}

