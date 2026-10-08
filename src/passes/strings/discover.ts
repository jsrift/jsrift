import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  AliasIndex,
  buildDecoder,
  type ArgumentTuple,
  type DecoderRefusal,
} from '../../analysis/evaluator/index.js';
import {
  collectArgumentForwarders,
  recogniseBlobDecoder,
  resolveForwardedCall,
  validateAgainstSamples,
  type ArgumentForwarder,
} from '../../analysis/evaluator/native.js';
import { isSelfContained, sliceForEvaluation } from '../../analysis/slice.js';
import { StatementScanCache } from '../../analysis/slice.js';
import {
  invalidateStringCodeFacts,
  stringCodeFacts,
  type StringCodeFacts,
} from '../../analysis/string-code.js';
import {
  auditArrayReferences,
  baseSourceOf,
  constantPoolNode,
  decodeThrough,
  DecoderIndex,
  findBlobDecoderCandidates,
  findConstantPoolCandidates,
  findStringSourceCandidates,
  foldStringConcat,
  type OversizeTable,
  isInsideAny,
  machineryOf,
  resolveIdentityAlias,
  scanPackedShapes,
  type BlobDecoderCandidate,
  type ConstantPoolCandidate,
  type PackedShapeScan,
  type StringSourceCandidate,
} from '../../analysis/string-array.js';
import { freezeHazardSite, readStaticString } from '../../naming/allocate.js';
import type { PassContext, StringSource } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import type { Severity } from '../../types.js';
import {
  describeNode,
  insideWith,
  isPureContext,
  MAX_STRING_TABLE_ENTRIES,
  staticArguments,
  staticArgumentsAt,
  staticNumber,
  staticString,
  TreeOrder,
} from '../../util/ast.js';
import { consoleDisableArmings } from '../clean/anti-tamper.js';
import { expandCall, isReassigned, isSemanticDirective, readTemplate } from '../simplify/proxy-functions.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/** Enough samples to catch a wrong recogniser, few enough to stay off the profile. */
const SAMPLE_LIMIT = 32;

/**
 * The most distinct call sites a candidate's pool holds. A sanity bound on a
 * pathological file, not a sample size: the pool is *every* distinct site of
 * the scope, because a wrong reading of one site is caught only when that
 * site is in the pool, and which site that is cannot be known before it is
 * read. The cross-check in `analysis/evaluator` compares every site it is
 * handed up to a budget of its own, and past that chooses by what the native
 * reading of each site looks like - a non-ASCII character or a `%` first,
 * then a spread over the argument range - so it can only be as thorough as
 * the pool. A cap of 256 in traversal order handed it 0.9% of
 * obfuscated2.js's 29,608 sites, and a 300-site file whose reading went
 * wrong at the 290th was proved sound on the first 256 and inlined at every
 * preset, conservative included. Collecting is the walk the index makes once
 * per scope anyway - obfuscated2.js's 29,608 sites are 35 ms of recording
 * over a 480 ms walk - and a candidate is validated on the head of the pool
 * (see `representative`), not the whole, so the pool's size costs nothing
 * the cross-check does not choose to spend.
 */
const POOL_LIMIT = 65_536;

/**
 * Sites the head of a pool is made to cover: one per eighth of the argument
 * range, the extremes included, so a decoder that only goes wrong past some
 * threshold, or on the last element, is not proved on the first thirty-two
 * sites of the file alone.
 */
const RANGE_PICKS = SAMPLE_LIMIT / 4;

/**
 * Rounds a candidate `buildDecoder` refuses as `unverified` - used, and never
 * with a literal argument - is put up in before it is given up on.
 *
 * Such a candidate is refused because there is nothing to prove it on, and
 * used to enter `seen` with every other refusal, which is final. But the
 * argument it is called with is not necessarily opaque, only not yet a
 * literal: `b(U.c)` with `U = l; l.c = 0x12b` is a call site the object-map
 * pass turns into `b(0x12b)` in the same round, and the rotation IIFE
 * proxied through the same map - `C[w.push](C[w.shift]())` - comes out as
 * `C.push(C.shift())` beside it. The round after that is exactly when the
 * candidate becomes provable, with the rotation in the slice, and a refusal
 * remembered forever leaves the file's strings encoded; a model adopted on
 * nothing, the defect this replaced, decoded them against the unrotated
 * table. So the refusal is not remembered until the candidate has been put
 * up in this many distinct fixpoint rounds without a sample. Three is one
 * more than the mainstream case needs (the argument surfaces on the round
 * after the map is inlined) and small enough that a candidate whose
 * arguments never do surface costs a slice and a tier attempt per round,
 * not one per round for as long as the loop runs.
 *
 * A candidate refused for a statement the slice cannot model (`mutation`) is
 * not bounded by this count. What stands in its way is a statement, and a
 * statement the next round rewrites is gone: control-flow flattening hands
 * every decoder call to a proxy, `m[k](dec, 0x1b3)`, and the decoder of a
 * layer stacked on two others is handed to one in every use until the layer
 * beneath is decoded and the proxies inlined - the round after that for each
 * layer, so a cap of three would leave a fourth layer encoded for good. The
 * bound is the fixpoint's own: a round that changes nothing is the last, and
 * a retry on an unchanged tree changes nothing.
 */
const UNVERIFIED_ROUNDS = 3;

/**
 * Locate every string source in the program, without being told where to look.
 *
 * Nothing has to be pointed at by hand. The search is structural - an array of
 * strings, a function that returns one, a short function that forwards to
 * another with the index adjusted - and every candidate is then *proved* by
 * `buildDecoder`, which decodes real call sites and refuses if the results are
 * not plausible text.
 *
 * A `run` pass because it is a whole-program analysis whose results the rest of
 * the stage depends on, and because it must complete before a single literal is
 * inlined.
 */
export const discoverStringsPass: Pass = {
  id: 'strings.discover',
  title: 'Locate string arrays and decoder functions',
  stage: 'strings',
  technique: 'stringDecoding',
  run: (ctx) => {
    const program = programPathOf(ctx.ast);
    if (!program) return;

    // The stage runs once, but the pass must still be a no-op on a second call:
    // rediscovering would push duplicate sources and inline everything twice.
    // Pools are the exception: they are a *prerequisite* for discovery rather
    // than a result of it, and a layer peeled since the last round can expose
    // one, so a re-entry still looks for those. The work is keyed by pool, so
    // finding nothing new costs one shape scan and nothing else.
    if (ctx.stringSources.length > 0) {
      inlineConstantPools(ctx, program);
      return;
    }

    // One numbering of the tree for the run of the pass; see `TreeOrder`.
    if (discoverStringSources(ctx, program, new TreeOrder(ctx.ast)) > 0) return;
    // Attempted is `seen` plus the candidates still to be retried: those were
    // put up and refused too, only not for good yet. Said once per count: the
    // pass runs every fixpoint round, and a round that put up nothing new has
    // nothing new to say. Standing lines, withdrawn by the round that adopts
    // a candidate: what they say of the output is then no longer so.
    const attempted = seenCandidates(ctx).size + unverifiedCandidates(ctx).size;
    if (attempted > 0) {
      const key = `${NONE_USABLE}:${attempted}`;
      sharedSet(ctx, NONE_USABLE).add(key);
      ctx.note(
        'info',
        `Found ${attempted} string-array shape(s) but none produced a usable decoder.`,
        undefined,
        key,
      );
    }
    if (attempted === 0) noteUnproposed(ctx);
  },
};

/** The round-end shape counts' keys, one per count said, so an adoption can withdraw them all. */
const NONE_USABLE = 'strings.discover:none-usable';

function retractNoneUsable(ctx: PassContext): void {
  const keys = sharedSet(ctx, NONE_USABLE);
  for (const key of keys) ctx.retract(key);
  keys.clear();
}

/**
 * Nothing was proposed, and the fingerprint said there was something to find.
 *
 * Every refusal above this line is a line in the report; a table the scan
 * never materialises is not, because there is no candidate to refuse. The
 * fingerprint in `prepare.detect` reads the decoder's shape and not the
 * table's entries, so it is the one place that has already seen what this
 * pass could not: `var f = [e.ESYVX, 'b', 'c']` behind a decoder `b(i)`,
 * where the first entry is an object-map read that the conservative preset
 * never turns into a literal. Such a run used to end with nothing in the
 * report. Said once, on the first round that
 * proposed nothing; a later round that does propose has the evaluator's lines.
 */
function noteUnproposed(ctx: PassContext): void {
  const fingerprint = ctx.detections.find(
    (detection) => detection.kind === 'string-array' || detection.kind === 'string-array-wrapper',
  );
  if (!fingerprint) {
    noteUnreadProgram(ctx);
    return;
  }
  if (ctx.shared.get(NOTED_UNPROPOSED)) return;
  ctx.shared.set(NOTED_UNPROPOSED, true);
  ctx.note(
    'info',
    `The fingerprint saw a string-array shape (${fingerprint.evidence}) but no array of string ` +
      `literals was found to propose: an entry may be computed - an object-map read, a ` +
      `concatenation, a call - and a later round or a less conservative preset may turn it into ` +
      `one.`,
  );
}

const NOTED_UNPROPOSED = 'strings.discover:noted-unproposed';

/**
 * No table anywhere, and a source the program compiles at run time that this
 * analysis cannot read: what the program runs is not all in the file, and a
 * report with nothing in it leaves that to be guessed. One standing line,
 * withdrawn by a round that reads the source; a packer family has a line of
 * its own from the unpack stage.
 */
function noteUnreadProgram(ctx: PassContext): void {
  const source = stringCodeFacts(ctx).unreadGlobalSource;
  if (source === undefined || ctx.detections.some((detection) => detection.kind === 'eval-packer')) {
    ctx.retract(UNREAD_PROGRAM);
    return;
  }
  ctx.note(
    'warning',
    `The program compiles code from ${source}, which this analysis cannot read: what it runs is ` +
      `not all in the file, and no string table was found in the part that is.`,
    undefined,
    UNREAD_PROGRAM,
  );
}

const UNREAD_PROGRAM = 'strings.discover:unread-program';

/**
 * One round of discovery, appending whatever it proves to `ctx.stringSources`.
 *
 * Exported because a *stacked* build only reveals its next layer once the
 * current one is inlined: layer two's table is a list of calls into layer one,
 * which is not an array of strings until layer one has been decoded. The
 * inlining pass therefore calls this again after each layer it peels. Candidates
 * already attempted are remembered across rounds so re-running is cheap.
 */
export function discoverStringSources(
  ctx: PassContext,
  program: NodePath<t.Program>,
  order: TreeOrder = new TreeOrder(ctx.ast),
): number {
  // A pool read is not a decoder call site, but it *hides* one: an argument
  // written `pool[2]` is not a literal, so the call around it cannot be inlined
  // and the decoder around that cannot be validated. Values first, then tables.
  //
  // The two whole-program shape scans share one walk: on a four-megabyte bundle
  // that has neither shape, each walk is tens of milliseconds and this runs once
  // per fixpoint iteration and again per peeled layer.
  const shapes = scanPackedShapes(program);
  inlineConstantPools(ctx, program, shapes);
  const found = discoverArraySources(ctx, program, order) + discoverBlobSources(ctx, program, shapes);
  if (found > 0) retractNoneUsable(ctx);
  return found;
}

/**
 * The classic shape: an array of strings, optionally behind a decoder.
 *
 * `order` is the caller's numbering of the tree, and the only one alive in
 * the stage: a numbering stamps the nodes, so two built over one tree read
 * each other's stamps as another build's, and the inliner that hands its
 * own down would otherwise find every read unplaced once a reading here had
 * numbered the tree afresh.
 */
function discoverArraySources(ctx: PassContext, program: NodePath<t.Program>, order: TreeOrder): number {
  const seen = seenCandidates(ctx);
  const unverified = unverifiedCandidates(ctx);
  const refused = refusedSlices(ctx);
  const skipped: OversizeTable[] = [];
  const scans = new StatementScanCache();
  const candidates = findStringSourceCandidates(program, skipped).filter((c) =>
    isDue(c, program, ctx, seen, unverified, refused, scans),
  );
  // A table the scan would not even materialise is not "no string array here",
  // which is what a run with no candidate and no note otherwise reads as. Once
  // per table: the scan repeats every round and per peeled layer.
  for (const table of skipped) {
    const key = `${table.loc?.start.line ?? 0}:${table.loc?.start.column ?? 0}:${table.entries}`;
    const noted = sharedSet(ctx, 'strings.discover:oversize');
    if (noted.has(key)) continue;
    noted.add(key);
    ctx.note(
      'warning',
      `A split() string table of ${table.entries.toLocaleString('en-US')} entries was left ` +
        `encoded: the candidate scan does not materialise a split over ` +
        `${MAX_STRING_TABLE_ENTRIES.toLocaleString('en-US')} entries.`,
      table.loc,
    );
  }
  if (candidates.length === 0) {
    scans.release();
    return 0;
  }

  // Every safety decision below is a statement about references, and the tree
  // has changed since scope was last built - by an earlier stage on the first
  // round, and by the previous layer's inlining on later ones. Pay for a crawl
  // only when there is actually a new candidate to judge, and only if the
  // tree moved since the last one.
  ctx.crawlProgramScope(program);

  const fingerprinted = fingerprintedArrays(ctx);
  // Every candidate, in one round. The unit that matters is the module, not
  // the file: a bundle is thousands of modules concatenated, each with its own
  // table, decoder and rotation offset. A cap of 512 per round used to stand
  // here as a stop against an adversarial input claiming thousands - and what
  // it did to a real bundle was hand the rest to `strings.inline`'s layer
  // loop, which re-enters this function once per 512, each re-entry paying a
  // crawl, two shape scans and a full inlining traversal of the whole program.
  // Measured on 2,048 concatenated modules (5 MB): 46 s in `strings.inline`
  // at 3.5x per doubling with the cap, 12 s at 2x without it. The bound on an
  // adversarial input is the one the cap never was: each candidate's own work
  // is indexed and budgeted, and the loop checks the time budget per candidate.
  //
  // One traversal per *scope*, not per candidate - the program included. A
  // module factory can hold a dozen array-shaped things, and a top-level build
  // with `stringArrayWrappersCount` set, or several obfuscated files
  // concatenated, holds hundreds; walking the whole body once for each of them
  // is how a linear analysis turns quadratic on exactly the files this feature
  // exists for. Measured before the program was indexed: 512 top-level tables
  // in 663 KB took 120 s in this pass alone and hit the budget, at ~4.5x per
  // doubling. Scoped to this round, because the next one has a different tree.
  const sites = new CallSiteIndex(candidates, stringCodeFacts(ctx));
  const identifiers = new IdentifierIndex(candidates);
  // The top-level alias links, read once for the same reason as `scans`: every
  // candidate's forwarders are a closure over the same few hundred links, and
  // reading the program body per candidate to find them was the other
  // quadratic term in this loop.
  const aliases = new AliasIndex(program.node);

  let accepted = 0;
  try {
    for (const candidate of candidates) {
      if (ctx.isExhausted()) {
        ctx.note('warning', 'Time budget reached before all string sources were discovered.');
        break;
      }
      const key = keyOf(candidate);
      const retry: Retry = { key, unverified, seen };
      const outcome = adopt(candidate, program, ctx, fingerprinted, sites, identifiers, scans, aliases, retry, order);
      if (outcome === 'adopted') accepted++;
      // A refusal is remembered, except the one that says only "not yet":
      // see `UNVERIFIED_ROUNDS`. That one is remembered against the round
      // instead, so the next round puts the candidate up again, until enough
      // rounds have gone by without a sample. A refusal the evaluator made
      // is remembered with the slice it was made on: it is a verdict on
      // those statements, and a round that rewrites one of them - the clean
      // stage cutting a guard out of the rotation wrapper, the inliner
      // spelling out a call the wrapper made through the layer above - puts
      // the candidate up again, on a slice nothing has judged yet.
      if (outcome === 'deferred') continue;
      unverified.delete(key);
      seen.add(key);
      if (outcome === 'refused' && retry.judged) {
        refused.set(key, sliceFingerprint(program, candidate, scans));
      }
    }
  } finally {
    // The round is over and the tree is about to change, so the cache is
    // stale; it is also still reachable, because the decoders adopted above
    // hold the options they were built with. Emptied here, it costs nothing
    // for the rest of the run rather than a level's worth of unit scans per
    // adopted decoder: 250 MB resident on the 757 KB fixture.
    scans.release();
  }
  return accepted;
}

/**
 * Whether another round could find anything, without paying for one.
 *
 * A shape scan is cheap; the crawl and the slice validation that follow are not.
 * The inlining pass asks this before deciding whether a file is layered at all.
 */
export function hasUndiscoveredSource(ctx: PassContext, program: NodePath<t.Program>): boolean {
  const seen = seenCandidates(ctx);
  const unverified = unverifiedCandidates(ctx);
  const refused = refusedSlices(ctx);
  const scans = new StatementScanCache();
  try {
    if (
      findStringSourceCandidates(program).some((candidate) =>
        isDue(candidate, program, ctx, seen, unverified, refused, scans),
      )
    ) {
      return true;
    }
  } finally {
    scans.release();
  }
  return findBlobDecoderCandidates(program).some((candidate) => !seen.has(blobKey(candidate)));
}

/**
 * Identity of a proposal, so no round re-does work an earlier one refused.
 *
 * Keyed on the scope as well as the names, because names are not identity: two
 * modules in one bundle routinely both call their table `_0x1234`, and a
 * name-only key silently drops the second one as "already attempted".
 */
function keyOf(candidate: StringSourceCandidate): string {
  return `${candidate.kind}:${candidate.scopeId}:${candidate.roots.join(',')}`;
}

function seenCandidates(ctx: PassContext): Set<string> {
  return sharedSet(ctx, 'strings.discover:attempted');
}

/**
 * Candidates refused for want of a sample and not yet given up on: how many
 * distinct rounds each has been put up in, and which round was the last.
 */
function unverifiedCandidates(ctx: PassContext): Map<string, UnverifiedAttempts> {
  const existing = ctx.shared.get('strings.discover:unverified');
  if (existing instanceof Map) return existing as Map<string, UnverifiedAttempts>;
  const created = new Map<string, UnverifiedAttempts>();
  ctx.shared.set('strings.discover:unverified', created);
  return created;
}

interface UnverifiedAttempts {
  rounds: number;
  /** The fixpoint iteration of the last attempt. */
  last: number;
}

/**
 * Whether a candidate is one this round should put up.
 *
 * Not one already refused on the slice it still has; and not one deferred
 * *this* round, which the inlining pass would otherwise put up again after
 * every layer it peels, paying a slice and a tier attempt to learn what the
 * same tree already said. The tree the deferral waits on is the next
 * round's, after the simplify stage has run.
 *
 * A candidate the evaluator refused is due again once its slice is not the
 * one it was refused on. The slice is cut afresh to ask, which is the price
 * of the question: a refusal keyed on the candidate alone was final, and a
 * decoder whose rotation wrapper carried the layer above's self-defending
 * guard - refused on the guard's `this`, which the interpreter has no global
 * for - stayed refused after the clean stage had cut the guard out, and the
 * output kept every string of that layer encoded and the guard in the
 * function beside it, hanging. The statement scans are cached for the round,
 * so the re-cut costs the slice's assembly and a walk of its statements.
 */
function isDue(
  candidate: StringSourceCandidate,
  program: NodePath<t.Program>,
  ctx: PassContext,
  seen: Set<string>,
  unverified: ReadonlyMap<string, UnverifiedAttempts>,
  refused: Map<string, string>,
  scans: StatementScanCache,
): boolean {
  const key = keyOf(candidate);
  if (seen.has(key)) {
    const judged = refused.get(key);
    if (judged === undefined || sliceFingerprint(program, candidate, scans) === judged) return false;
    seen.delete(key);
    refused.delete(key);
    return true;
  }
  return unverified.get(key)?.last !== ctx.iteration;
}

/** Candidates the evaluator refused, by key, with the slice each was refused on. */
function refusedSlices(ctx: PassContext): Map<string, string> {
  const existing = ctx.shared.get('strings.discover:refused-slices');
  if (existing instanceof Map) return existing as Map<string, string>;
  const created = new Map<string, string>();
  ctx.shared.set('strings.discover:refused-slices', created);
  return created;
}

/**
 * The shape of a candidate's slice as one string: the statements the
 * evaluator would be handed, walked for their node types, names and literal
 * values. Two slices with the same fingerprint are the same statements as far
 * as any tier reads them, so a refusal made on one holds for the other.
 */
function sliceFingerprint(
  program: NodePath<t.Program>,
  candidate: StringSourceCandidate,
  scans: StatementScanCache,
): string {
  const slice = sliceForEvaluation(program, candidate.roots, scans);
  let hash = 0;
  let nodes = 0;
  const mix = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
    }
    hash = (Math.imul(hash, 31) + 7) | 0;
  };
  const stack: unknown[] = [...slice.statements];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    nodes++;
    mix(node.type);
    if (t.isIdentifier(node)) mix(node.name);
    else if (t.isStringLiteral(node)) mix(node.value);
    else if (t.isNumericLiteral(node)) mix(String(node.value));
    else if (t.isBooleanLiteral(node)) mix(String(node.value));
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return `${nodes}:${hash}:${slice.unmodelledMutation ?? ''}`;
}

/**
 * Record a refusal for want of a sample: the round this makes, counting from
 * one, while the candidate is still to be retried, or 0 once it has had its
 * {@link UNVERIFIED_ROUNDS} and the refusal is to be remembered like any other.
 *
 * Counted in distinct fixpoint iterations, not attempts: `isDue` keeps a
 * round to one attempt, but the count is what the bound is stated in, and
 * an attempt from the layer loop must not be able to spend two of them.
 */
function deferUnverified(
  key: string,
  ctx: PassContext,
  unverified: Map<string, UnverifiedAttempts>,
  uncapped = false,
): number {
  const attempts = unverified.get(key);
  let rounds = 1;
  if (attempts) rounds = attempts.last === ctx.iteration ? attempts.rounds : attempts.rounds + 1;
  if (!uncapped && rounds >= UNVERIFIED_ROUNDS) return 0;
  unverified.set(key, { rounds, last: ctx.iteration });
  return rounds;
}

/**
 * Arrays already fingerprinted. One array can be proposed twice - once through
 * its decoder and once for the direct reads - and it is still one fingerprint.
 */
function fingerprintedArrays(ctx: PassContext): Set<string> {
  return sharedSet(ctx, 'strings.discover:fingerprinted');
}

function sharedSet(ctx: PassContext, key: string): Set<string> {
  const existing = ctx.shared.get(key);
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  ctx.shared.set(key, created);
  return created;
}

/**
 * Whether a note keyed on `key` has already been made this run.
 *
 * For the string stage's standing verdicts - a table a string can still name,
 * a source left encoded for it - which the fixpoint loop would otherwise
 * restate every round, and the layer loop once per layer on top of that, with
 * nothing new in the restatement: the machinery a round kept is the machinery
 * the next round keeps, for the reason already given. Keyed on the name and
 * the kind of verdict, not the text, so a count that moved still gets its
 * line and a second table in a later layer gets its own.
 */
export function notedOnce(ctx: PassContext, key: string): boolean {
  const noted = sharedSet(ctx, 'strings:noted');
  if (noted.has(key)) return true;
  noted.add(key);
  return false;
}

/**
 * What became of a candidate. `deferred` is the one refusal that is not a
 * verdict on the candidate: it is used, so there is something to prove, and
 * never with a literal argument, so there is nothing to prove it on - yet.
 * The evaluator's word for it is `unverified` (`DecoderRefusal`), told apart
 * there for exactly this caller; `unread-key` is its second shape, a host
 * write whose key a call this round cannot read computes, deferred the
 * same way and noted at warning severity. Here either is a deferral for as
 * long as {@link UNVERIFIED_ROUNDS} allows, and a refusal after. The third,
 * `mutation`, is a statement in the way rather than a sample wanting, and is
 * deferred for as long as the tree keeps moving.
 */
type Adoption = 'adopted' | 'refused' | 'deferred';

/** The deferral book for one candidate: its key, the rounds so far, and the round's refusals. */
interface Retry {
  key: string;
  unverified: Map<string, UnverifiedAttempts>;
  /** Candidates refused for good, which a decoder adopted on the strength of a reading joins. */
  seen: Set<string>;
  /** Set once the evaluator has judged the candidate's slice, so a refusal is remembered with it. */
  judged?: boolean;
}

/** The report's standing lines about one candidate, replaced round by round and withdrawn on adoption. */
function verdictKey(retry: Retry): string {
  return `strings.discover:verdict:${retry.key}`;
}

function deferralKey(retry: Retry): string {
  return `strings.discover:deferred:${retry.key}`;
}

function adopt(
  candidate: StringSourceCandidate,
  program: NodePath<t.Program>,
  ctx: PassContext,
  fingerprinted: Set<string>,
  sites: CallSiteIndex,
  identifiers: IdentifierIndex,
  scans: StatementScanCache,
  aliases: AliasIndex,
  retry: Retry,
  order: TreeOrder,
): Adoption {
  const samples = sites.samplesFor(candidate);
  // No literal-argument reference anywhere in the scope means there is nothing
  // this candidate could inline this round, whatever `buildDecoder` would
  // conclude about it - and, below program scope, the tiers are not asked:
  // ordinary application code is full of two- and three-element string
  // arrays read with a computed index, and proving a decoder for each of them
  // is the largest cost a scope-wide search adds to an ordinary file. A
  // program-scope wrapper still takes the tiers, which accept an unreferenced
  // decoder (nothing to get wrong), so the classic top-level file comes out
  // as it did.
  if (samples.length === 0 && (candidate.scope.node !== program.node || candidate.kind === 'array-index')) {
    return withoutSample(candidate, program, ctx, scans, retry);
  }

  // What the evaluator says is held back until the outcome is known. A
  // candidate deferred for want of a sample is put up again the next round
  // and, as often as not, refused for the same want; the evaluator's line
  // for that refusal is the deferral's own reason, worth one line per run
  // and not one per round, so it is kept out of the report while the
  // deferrals last and let through once they are spent, as the last word.
  // Everything else it says - a write it took for a helper, a builtin it
  // evaluates despite string code - is a disclosure it makes once a round
  // and counts as made, so those go through whatever the outcome.
  const pending: [Severity, string][] = [];
  /** The refusal that is a fact about this round's tree rather than about the candidate, if the evaluator made one. */
  let deferrable: DecoderRefusal | undefined;
  let refusal: [Severity, string] | undefined;
  // The two spellings the evaluator gives its own refusal line, so the held
  // line is that one and no other.
  const prefixes = [`Refusing ${candidate.roots[0]}: `, `Refusing to evaluate ${candidate.roots[0]}: `];
  retry.judged = true;
  let source = buildDecoder(program, candidate.roots, ctx.config, {
    reporter: {
      note: (severity, message) => {
        pending.push([severity, message]);
      },
      refused: (kind) => {
        deferrable = kind;
        // The evaluator names the refusal just before it signals it; the
        // line is held back only when it is that line.
        const last = pending[pending.length - 1];
        if (last && prefixes.some((prefix) => last[1].startsWith(prefix))) refusal = pending.pop();
      },
    },
    samples,
    scans,
    aliases,
    stringCode: stringCodeFacts(ctx),
  });
  // The two refusals a candidate can answer itself: string code spelled in
  // calls to this very decoder, and a host write whose key is a call to the
  // decoder of the layer beneath, whose table is calls to this one. Read
  // through the candidate, and judged again on what it says. A candidate
  // built past that string code on the aggressive preset's leave is read
  // the same way: a reading that goes through is a proof where the build
  // was a trade, and the trade's disclosure goes with it.
  let reading: StringCodeReading | undefined;
  const unreadStringCode = deferrable === undefined && mentionsUnreadStringCode(pending, candidate.roots[0]!);
  if (unreadStringCode || (!source && deferrable === 'unread-key')) {
    reading = readThroughCandidate(
      candidate,
      program,
      ctx,
      samples,
      aliases,
      deferrable === 'unread-key' ? 'unread-key' : 'string-code',
      order,
    );
    if (reading) {
      pending.length = 0;
      source = reading.source;
      pending.push(...reading.notes);
      deferrable = undefined;
      refusal = undefined;
    }
  }
  // Every line about the candidate is this round's word on it. The previous
  // round's lines were about a slice this round has judged again - the
  // interpreter's refusal on a guard the clean stage has since cut out - so
  // they are withdrawn as this round's go in, and the last round's stand.
  const lines = candidateLines(ctx);
  const putUpBefore = (lines.get(retry.key)?.length ?? 0) > 0 || retry.unverified.has(retry.key);
  for (const key of lines.get(retry.key) ?? []) ctx.retract(key);
  const keys: string[] = [];
  pending.forEach(([severity, message], index) => {
    const key = `strings.discover:${retry.key}:${index}`;
    keys.push(key);
    ctx.note(severity, message, undefined, key);
  });
  lines.set(retry.key, keys);
  if (!source && deferrable !== undefined) {
    const round = deferUnverified(retry.key, ctx, retry.unverified, deferrable === 'mutation');
    if (round > 0) {
      // The evaluator's reason, not a paraphrase of the commonest one. Two
      // things defer: no call site with a literal argument, and a host write
      // whose key a call this round cannot read computes - and the second was
      // reported as the first, so the file whose `globalThis[...] = ...` key ran
      // through a wrapper of the very decoder read as "never with a literal
      // argument" while every site had two. Said once, on the first round.
      //
      // And no promise. The run stops when a round changes nothing, which at
      // conservative is the round after this one, before the retries are
      // spent and before the refusal below is ever let through; a note that
      // ended "it will be put up again" was then the last word on a table the
      // output still holds. So the line says what stands in the way and what
      // happens if nothing moves it, and stands on its own either way.
      //
      // At warning severity when what stands in the way is a host write
      // whose key a call this round cannot read computes: the line names
      // the write, its line and the call, and when no later round reads
      // the key - the strings stage does not run again once a round
      // changes nothing - it is the last word on a table left encoded,
      // which is a refusal and is owed a warning, not an info line. A
      // deferral for want of a sample stays info: nothing is decided
      // against the candidate, there is only nothing to prove it on yet.
      //
      // A statement in the way is a refusal on this round's tree and is
      // said as the evaluator said it, once: the reason is the statement,
      // which the line names, and a later round that rewrites it adopts the
      // candidate and has its own lines. A run that never rewrites it ends
      // with the refusal as the last word, which is what it is.
      if (round === 1) {
        if (deferrable === 'mutation' && refusal) {
          ctx.note(refusal[0], refusal[1], undefined, deferralKey(retry));
          return 'deferred';
        }
        const held = refusal?.[1];
        const prefix = held ? prefixes.find((p) => held.startsWith(p)) : undefined;
        const reason =
          held && prefix
            ? held.slice(prefix.length)
            : `it is used but never with a literal argument, so there is nothing to prove a ` +
              `decoder on.`;
        ctx.note(
          deferrable === 'unverified' ? 'info' : 'warning',
          `Deferred ${candidate.roots[0]}: ${reason} It is put up again after each later round ` +
            `and is left as written if none changes that.`,
          undefined,
          deferralKey(retry),
        );
      }
      return 'deferred';
    }
    if (refusal) ctx.note(refusal[0], refusal[1], undefined, verdictKey(retry));
  } else if (refusal) {
    ctx.note(refusal[0], refusal[1], undefined, verdictKey(retry));
  }
  if (!source) return 'refused';

  // A reading is a rewrite of the live tree, kept by the adoption alone: a
  // refusal below, or a throw on the way to the commit, puts every node back
  // before anything else reads the tree.
  let kept = reading === undefined;
  try {
    // `buildDecoder` proves the decoder *computes* the right strings. For a
    // plain array read directly at call sites it cannot prove the table is
    // still the same table by the time those reads run, and that is a
    // property of every reference in the program rather than of the decoder.
    if (source.kind === 'array-index' && !arrayIsImmutable(candidate, source.name, source.declarations, ctx)) {
      return 'refused';
    }
    if (source.kind === 'wrapper-call' && !tableIsStable(candidate, source, program, ctx, identifiers)) {
      return 'refused';
    }
    if (reading) {
      // The decoders the reading exposed are judged as this one was, and the
      // reading is kept only with every one of them: a rewrite it made is a
      // rewrite through them.
      const exposedIdentifiers = new IdentifierIndex(reading.exposed.map((entry) => entry.candidate));
      for (const entry of reading.exposed) {
        if (!tableIsStable(entry.candidate, entry.source, program, ctx, exposedIdentifiers)) return 'refused';
      }
      reading.commit();
      kept = true;
      const key = `strings.discover:${retry.key}:reading`;
      keys.push(key);
      ctx.note('info', reading.describe(), undefined, key);
      for (const entry of reading.exposed) {
        ctx.stringSources.push(entry.source);
        reportDetections(entry.candidate, entry.source, ctx, fingerprinted);
        retry.seen.add(keyOf(entry.candidate));
      }
    }
  } finally {
    if (!kept) reading?.revert();
  }

  ctx.stringSources.push(source);
  reportDetections(candidate, source, ctx, fingerprinted);
  // Adopted: every earlier round's verdict on this candidate is about a tree
  // the output no longer holds. A candidate put up before is said to have
  // been, in one line, in place of the deferral or refusal it stood under.
  ctx.retract(verdictKey(retry));
  if (putUpBefore) {
    ctx.note(
      'info',
      `${candidate.roots[0]} was deferred or refused on an earlier round and has since been ` +
        `proved on the tree as rewritten, and adopted.`,
      undefined,
      deferralKey(retry),
    );
  }
  return 'adopted';
}

/**
 * A candidate with no site to prove a decoder on: nothing this round could
 * inline, whatever a tier would make of it, and not a verdict on the
 * candidate either. The argument is not opaque, only not yet a literal - an
 * object-map read the next round spells out - so the candidate is put up
 * again for {@link UNVERIFIED_ROUNDS}, as one the evaluator refused for the
 * same want is, and remembered as refused only after. No slice is cut for a
 * nested one; the shortcut is what keeps a scope-wide search off the
 * computed-index arrays of ordinary code.
 *
 * Silence is right for those arrays. It is not right for a table the audit
 * would clear: a `var` declared in a bare block is read from the rest of its
 * function, outside the scope the index sampled, and a reader is owed the
 * reason - one standing line, replaced round by round and withdrawn on
 * adoption. A nested table is asked with nothing exempt, so one whose own
 * machinery writes it - a rotation - stays quiet; a top-level table read
 * directly takes the audit on its slice, which names the write or the
 * `reverse()` that makes it unsafe, where the evaluator would only say the
 * array is used and unverified.
 */
function withoutSample(
  candidate: StringSourceCandidate,
  program: NodePath<t.Program>,
  ctx: PassContext,
  scans: StatementScanCache,
  retry: Retry,
): Adoption {
  if (candidate.kind === 'array-index') {
    const key = verdictKey(retry);
    if (candidate.scope.node !== program.node) {
      const audit = auditArrayReferences(candidate.scope, candidate.arrayName, NOTHING_EXEMPT);
      if (audit.unsafe.length === 0 && audit.inlinable > 0) noteUnsampled(candidate, ctx, key);
    } else {
      const slice = sliceForEvaluation(program, candidate.roots, scans);
      if (arrayIsImmutable(candidate, candidate.arrayName, slice.sources, ctx, key)) {
        noteUnsampled(candidate, ctx, key);
      }
    }
  }
  return deferUnverified(retry.key, ctx, retry.unverified) > 0 ? 'deferred' : 'refused';
}

/** The keys of the lines the last round said about each candidate, so the next round can withdraw them. */
function candidateLines(ctx: PassContext): Map<string, string[]> {
  const existing = ctx.shared.get('strings.discover:lines');
  if (existing instanceof Map) return existing as Map<string, string[]>;
  const created = new Map<string, string[]>();
  ctx.shared.set('strings.discover:lines', created);
  return created;
}

/**
 * Whether the evaluator's lines refuse the candidate for string code the facts
 * cannot read, or evaluate it past that refusal and say so.
 */
function mentionsUnreadStringCode(pending: readonly [Severity, string][], root: string): boolean {
  const heads = [
    `Refusing to evaluate ${root}: code compiled from a string can reach`,
    `Evaluating ${root} anyway: code compiled from a string can reach`,
  ];
  return pending.some(([, message]) => heads.some((head) => message.startsWith(head)));
}

// ---------------------------------------------------------------------------
// String code spelled in the decoder's own calls
// ---------------------------------------------------------------------------

/**
 * A facts object with no string code in it, for the trial builds below. A
 * trial is not the adoption: what it yields is a reading of a decoder that
 * every tier has proved on the candidate's call sites, used only to read the
 * arguments of the sites that stood in its way. The adoption is made
 * afterwards, by a build over the real facts of the tree as rewritten.
 */
const NO_STRING_CODE: StringCodeFacts = {
  global: false,
  directEval: false,
  empty: true,
  unreadGlobalSource: undefined,
  reaches: () => false,
  addresses: () => false,
  addressesName: () => false,
  spells: () => false,
  addressesAnyOwnBinding: () => false,
};

/**
 * Most global string-code sites one reading walks. A stacked build has one
 * console stub per layer, and each opens onto a `constructor("return this")`
 * of its own that is walked again on every later step.
 */
const MAX_READ_SITES = 32;

/**
 * Layers a reading exposes beneath the candidate: `strings.inline` peels no
 * more than this many, and every layer exposed here is one that loop peels.
 */
const MAX_READ_LAYERS = 8;

/**
 * A candidate read past its string code, held until the caller keeps or
 * reverts the reading: the candidate built over the facts of the rewritten
 * tree, the decoders beneath it the reading exposed and built the same way,
 * and the lines the builds said.
 */
interface StringCodeReading {
  source: StringSource;
  notes: [Severity, string][];
  exposed: Exposed[];
  commit(): void;
  revert(): void;
  /** The line that discloses the reading. */
  describe(): string;
}

/**
 * Judge a candidate refused for string code by reading that code through the
 * candidate.
 *
 * obfuscator.io's `disableConsoleOutput` reaches the global object through
 * `Function('return (function() ' + '{}.constructor("return this")( )' +
 * ');')()`, and with a string array in the build both literals are calls to
 * the decoder: `Function(d(0xf7) + d(0x105) + ');')()`. The facts cannot
 * read a source spelled that way, an unread source is every name, and the
 * decoder is refused for the `parseInt` its rotation reads - on the
 * `low-obfuscation` preset, which is the commonest real configuration, with
 * nothing in the file decoded at all.
 *
 * The circle is broken from the decoder's side. A trial build with the
 * string-code question set aside yields a reading of the decoder that every
 * tier has proved on its call sites; if that reading is what the program
 * runs, the site's arguments are what it decodes them to. So they are
 * rewritten to those literals, a `Function` wrapper among them is opened
 * (the console stub's, once spelled, is `return (function () {}
 * .constructor("return this")());`, and the facts read that nested call
 * as the `return this` it compiles), and the candidate is built again over
 * the facts of the rewritten tree. That build is the adoption, and it can
 * still refuse - a source that spells a name the slice reads, a host write
 * the preset refuses - in which case every rewrite is put back.
 *
 * A layer stacked on the candidate's spells ITS stub in calls to its own
 * decoder, whose table is a list of calls to the candidate: nothing about
 * that stub can be read until the candidate is adopted, and the candidate is
 * refused until the stub is read. The reading breaks that circle the same
 * way it breaks the first. The entries of every table spelled in calls the
 * index decodes are spelled out, the decoders over the tables that are then
 * literal are built on the same trial terms, and the index grows by them,
 * layer by layer, until every source is read or a layer exposes nothing.
 * Every rewrite along the way is a reading through a decoder every tier has
 * proved on its own sites, and every one is put back if the sources do not
 * all come out read.
 *
 * The same reading answers a host write whose key is a call to the decoder
 * of the layer beneath - `_0x5e2801[_0x4583(...)] = ...`, the console write of
 * that layer's stub, with `_0x4583`'s table a list of calls to the candidate
 * - which the host-write index cannot read until the layer beneath is spelled.
 *
 * Why the reading is sound: before the first such site runs, no string code
 * has run, so the decoder is the one the tiers proved and the source the site
 * compiles is the one read here. A source the facts then find to reach
 * nothing the decoder or its table depends on leaves the decoder as proved
 * for the next site, and so on; a source that does reach something is the
 * final build's refusal, and nothing is kept. A decoder read through another
 * is the two composed, each proved on its sites, and the argument holds one
 * layer down unchanged. Bounded in sites and layers because the rewrite is
 * made in place and reverted by hand.
 */
function readThroughCandidate(
  candidate: StringSourceCandidate,
  program: NodePath<t.Program>,
  ctx: PassContext,
  samples: ArgumentTuple[],
  aliases: AliasIndex,
  why: 'string-code' | 'unread-key',
  order: TreeOrder,
): StringCodeReading | undefined {
  const facts = stringCodeFacts(ctx);
  if (why === 'string-code' && (!facts.global || facts.unreadGlobalSource === undefined)) return undefined;

  // The trial's own lines are the first build's, already held by the caller;
  // the builds below say whatever is said about the adoption.
  const scans = new StatementScanCache();
  const trial = buildDecoder(program, candidate.roots, ctx.config, {
    reporter: { note: () => {} },
    samples,
    scans,
    aliases,
    stringCode: NO_STRING_CODE,
  });
  scans.release();
  if (!trial) return undefined;

  const log = new RewriteLog(ctx, program, order);
  const sources: StringSource[] = [trial];
  const exposed: Exposed[] = [];
  const seen = seenCandidates(ctx);
  const notes: [Severity, string][] = [];
  let source: StringSource | undefined;
  let read: StringCodeFacts | undefined;
  // The tree is rewritten in place from the first step on, and the builds
  // that judge it come after: a throw anywhere between puts every node back
  // before it goes on, or the kernel would ship the half-made trial as the
  // pass's output while every guard read the tree as unchanged.
  try {
    for (let layer = 0; layer <= MAX_READ_LAYERS; layer++) {
      // Placed by the tree's numbering, as the inliner places: a payload the
      // unpack stage spliced in from a string carries no source offsets, and
      // offsets are what a link is placed by without one.
      const index = new DecoderIndex(program, sources, { strings: NO_STRING_CODE, order });
      if (!spellSitesThrough(program, index, log)) break;
      // The layer's other sites, as `strings.inline` would rewrite them: the
      // table beneath is a list of calls to this layer, the stub the layer
      // above put in a rotation wrapper is recognised only by its plain names,
      // and a host write keyed by a call to this layer is read only spelled.
      const spelledSites = spellLayerThrough(program, index, declarationsOf(sources), log);
      log.blankSpentAliases();
      if (ctx.config.techniques.antiTamperRemoval) neutraliseConsoleStubs(program, log);
      const current = log.facts();
      if (current.unreadGlobalSource === undefined) {
        // The adoption: the candidate built over the facts of the tree as
        // rewritten. A refusal on this tree is a key or a statement of the
        // layer beneath, which exposing that layer may read.
        notes.length = 0;
        source = rebuildOn(current, candidate, program, ctx, samples, aliases, notes);
        if (source) {
          read = current;
          break;
        }
      }
      if (ctx.isExhausted() || layer === MAX_READ_LAYERS || spelledSites === 0) break;
      const next = trialDecodersOver(program, ctx, sources, seen, aliases, log);
      if (next.length === 0) break;
      exposed.push(...next);
      sources.push(...next.map((entry) => entry.source));
    }
    if (!source || !read) {
      log.revert();
      return undefined;
    }

    // Every decoder the reading rests on, built the same way: a rewrite the
    // reading made is a rewrite through them.
    for (const entry of exposed) {
      const rebuilt = rebuildOn(read, entry.candidate, program, ctx, entry.samples, aliases, notes);
      if (!rebuilt) {
        log.revert();
        return undefined;
      }
      entry.source = rebuilt;
    }
  } catch (error) {
    log.revert();
    throw error;
  }
  return {
    source,
    notes,
    exposed,
    commit: () => log.commit(),
    revert: () => log.revert(),
    describe: () => log.describe(`stood in the way of ${candidate.roots[0]}`),
  };
}

/** A decoder the reading exposed beneath the candidate, and the sites it was proved on. */
interface Exposed {
  candidate: StringSourceCandidate;
  source: StringSource;
  samples: ArgumentTuple[];
}

/** The candidate built over `facts`, its lines appended to `notes`. */
function rebuildOn(
  facts: StringCodeFacts,
  candidate: StringSourceCandidate,
  program: NodePath<t.Program>,
  ctx: PassContext,
  samples: ArgumentTuple[],
  aliases: AliasIndex,
  notes: [Severity, string][],
): StringSource | undefined {
  const scans = new StatementScanCache();
  const source = buildDecoder(program, candidate.roots, ctx.config, {
    reporter: {
      // Once per reading: the host-write index says the same thing of the
      // same write for every decoder it is built for.
      note: (severity, message) => {
        if (!notes.some(([, said]) => said === message)) notes.push([severity, message]);
      },
    },
    samples,
    scans,
    aliases,
    stringCode: facts,
  });
  scans.release();
  return source;
}

/** The declarations of every source, as a set of nodes, for the machinery exemption. */
function declarationsOf(sources: readonly StringSource[]): ReadonlySet<t.Node> {
  const nodes = new Set<t.Node>();
  for (const source of sources) {
    for (const declaration of source.declarations) if (!declaration.removed) nodes.add(declaration.node);
  }
  return nodes;
}

/**
 * The global string-code sites of the program spelled through `index`, and
 * the facts of the tree as rewritten - or `undefined`, with nothing changed,
 * when a source stays unread.
 *
 * For `strings.inline`, whose index holds every adopted decoder: a table
 * whose machinery a string could still name is read through that index and
 * judged on what the sources say. The caller keeps the rewrite or puts every
 * node back; keeping it is sound on the argument `readStringCodeThrough`
 * gives, and only then.
 */
export function spellStringCodeSites(
  program: NodePath<t.Program>,
  ctx: PassContext,
  index: DecoderIndex,
  order: TreeOrder,
): SpelledStringCode | undefined {
  const log = new RewriteLog(ctx, program, order);
  try {
    if (!spellSitesThrough(program, index, log) || log.size === 0) {
      log.revert();
      return undefined;
    }
    const facts = log.facts();
    if (facts.unreadGlobalSource !== undefined) {
      log.revert();
      return undefined;
    }
    return {
      facts,
      revert: () => log.revert(),
      commit: () => log.commit(),
      describe: (what) => log.describe(what),
    };
  } catch (error) {
    log.revert();
    throw error;
  }
}

/** A rewrite of the string-code sites, held until the caller keeps or reverts it. */
export interface SpelledStringCode {
  /** The facts of the tree as rewritten; every global source in it is read. */
  facts: StringCodeFacts;
  revert(): void;
  /** Keep the rewrite: count it, and rebuild scope over it. */
  commit(): void;
  /** The line that discloses the reading, `what` being the decoder's part in it. */
  describe(what: string): string;
}

/**
 * The rewrites of one reading, in the order made, so they can be put back in
 * the reverse order or kept as one change. A node put back is the node taken
 * out: the replaced paths keep their containers, and the arguments an
 * expansion moved into a copy of a proxy's body are the call's own argument
 * nodes, untouched in the call that is restored over the copy.
 */
class RewriteLog {
  private readonly entries: { path: NodePath; original: t.Node }[] = [];
  private readonly decoded: { reference: string; value: string }[] = [];
  /** Spelled calls per identity alias of a decoder, `var a = dec`; see `blankSpentAliases`. */
  private readonly through = new Map<Binding, number>();
  /** Whether a step crawled program scope over the rewritten tree; see `revert`. */
  private crawled = false;
  /** Whether the facts were taken over the rewritten tree, so the cache holds a tree `revert` takes away. */
  private factsTaken = false;
  /** Whether a replacement put a node the numbering may be asked about where another stood; see `replace`. */
  private reshaped = false;
  /** Decoder calls spelled at string-code sites; sites of the layers beneath; stubs disarmed; layers exposed. */
  literals = 0;
  sites = 0;
  stubs = 0;
  layers = 0;

  constructor(
    private readonly ctx: PassContext,
    private readonly program: NodePath<t.Program>,
    /** The stage's numbering of the tree, which a replacement asked about afterwards has to be in. */
    private readonly order: TreeOrder,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  replace(path: NodePath, replacement: t.Node): void {
    this.entries.push({ path, original: path.node });
    path.replaceWith(replacement);
    // A literal is asked nothing; a proxy's expansion is asked at once whether
    // its callee holds, and a node the numbering was made without is a
    // refusal. Numbered again on the next question, over the tree as it then
    // stands - a few expansions per reading, not one per spelled site.
    if (!t.isLiteral(replacement)) {
      this.reshaped = true;
      this.order.invalidate();
    }
  }

  /** Spell a decoder call or table read as the literal it decodes to. */
  spell(path: NodePath, value: string, tally: 'literals' | 'sites'): void {
    if (path.isCallExpression() && t.isIdentifier(path.node.callee)) {
      const binding = path.scope.getBinding(path.node.callee.name);
      if (binding) this.through.set(binding, (this.through.get(binding) ?? 0) + 1);
    }
    this.decoded.push({ reference: describeNode(path.node), value });
    this.replace(path, t.inherits(t.stringLiteral(value), path.node));
    this[tally]++;
  }

  /**
   * `var a = dec` with every reference spelled away no longer forwards
   * anything, and is left as `var a = null` - what `clean.unused` deletes
   * on the round the sites are inlined. Blanked here because a declarator
   * that still names the decoder is a mention: the rotation wrapper of the
   * layer beneath, now spelling `list.push(list.shift())` where it read the
   * method name through the decoder, would otherwise be taken by the slicer
   * for a rotation of the decoder's own table that its slice cannot include.
   */
  blankSpentAliases(): void {
    for (const [binding, spelled] of this.through) {
      if (!binding.constant || spelled < binding.referencePaths.length) continue;
      // A program-scope alias is a statement of its own, in no rotation
      // wrapper, and the prune deletes it as a forwarder; blanked it would
      // outlive the machinery, since a script's globals are never unused.
      if (binding.scope.path.isProgram()) continue;
      const declarator = binding.path;
      if (!declarator.isVariableDeclarator() || !t.isIdentifier(declarator.node.init)) continue;
      this.replace(declarator.get('init') as NodePath, t.nullLiteral());
    }
    this.through.clear();
  }

  /** The facts of the tree as it stands, computed afresh. */
  facts(): StringCodeFacts {
    this.factsTaken = true;
    invalidateStringCodeFacts(this.ctx);
    return stringCodeFacts(this.ctx);
  }

  /**
   * Scope tables over the rewritten tree, for a candidate search or a slice
   * cut on it. Off the versioned crawl: the trial has changed nothing the
   * counter records, and the tables it builds must not be taken for the
   * restored tree's - `revert` builds those again.
   */
  crawl(): void {
    this.program.scope.crawl();
    this.crawled = true;
  }

  revert(): void {
    // The cached facts describe the tree only while nothing was put in it and
    // nothing was computed over a tree this takes away; a reading that
    // spelled nothing leaves them standing rather than have the next asker
    // compute the same answer again.
    const stale = this.entries.length > 0 || this.factsTaken;
    for (let at = this.entries.length - 1; at >= 0; at--) {
      const { path, original } = this.entries[at]!;
      if (!path.removed) path.replaceWith(original);
    }
    this.entries.length = 0;
    this.decoded.length = 0;
    this.through.clear();
    if (this.crawled) this.program.scope.crawl();
    this.crawled = false;
    // The originals put back were not in the tree the last numbering was
    // made over when a replacement was; the next question numbers them.
    if (this.reshaped) this.order.invalidate();
    this.reshaped = false;
    if (stale) invalidateStringCodeFacts(this.ctx);
    this.factsTaken = false;
  }

  commit(): void {
    for (const { reference, value } of this.decoded) recordDecodedString(this.ctx, reference, value);
    this.ctx.markChanged(this.entries.length);
    this.ctx.crawlProgramScope(this.program);
  }

  describe(what: string): string {
    return (
      `Read the string code that ${what} through the decoder itself: ${this.literals} argument(s) ` +
      `spelled in calls to it were decoded` +
      (this.layers > 0
        ? `, ${this.sites} site(s) of the ${this.layers} layer(s) beneath it inlined to prove the ` +
          `decoder(s) over them` +
          (this.stubs > 0 ? ` and ${this.stubs} console-disable stub(s) among them disarmed` : '')
        : '') +
      `, and every source reaches nothing the decoders or their tables depend on.`
    );
  }
}

/** Record a decoded string for the report; `strings.inline` records every site it rewrites the same way. */
export function recordDecodedString(ctx: PassContext, reference: string, value: string): void {
  const existing = ctx.decodedStrings.get(reference);
  if (existing) {
    existing.uses++;
    return;
  }
  ctx.decodedStrings.set(reference, { reference, value, uses: 1 });
}

/**
 * One step of a reading: every global string-code site whose arguments the
 * index can spell is spelled. The wrapper itself is left as written - the
 * facts read a `Function` over a literal, and opening it is the unpack
 * stage's rewrite, which the quiet round makes where the preset allows it.
 * Left closed it also keeps the global-object idiom the evaluator reads,
 * `Function('return this')()` with `window` in the `catch` beside it, whole
 * for a decoder whose rotation wrapper carries the stub of the layer above.
 * False when the program has more such sites than a reading walks.
 */
function spellSitesThrough(program: NodePath<t.Program>, index: DecoderIndex, log: RewriteLog): boolean {
  let sites = 0;
  program.traverse({
    'CallExpression|NewExpression|OptionalCallExpression'(path) {
      const site = freezeHazardSite(path);
      if (!site || site.kind !== 'global' || !site.code) return;
      if (++sites > MAX_READ_SITES) {
        path.stop();
        return;
      }
      for (const node of site.code) {
        if (readStaticString(node, path.scope) !== undefined) continue;
        const argument = argumentPathOf(path, node);
        if (argument) spellThroughDecoder(argument, index, log);
      }
    },
  });
  return sites <= MAX_READ_SITES;
}

/**
 * Every call and table read the index decodes, outside the sources' own
 * machinery, spelled - the layer's sites, as `strings.inline` rewrites them,
 * on `exit` so a nested `dec(dec(1))` is spelled inside out. Returns how
 * many were.
 */
function spellLayerThrough(
  program: NodePath<t.Program>,
  index: DecoderIndex,
  machinery: ReadonlySet<t.Node>,
  log: RewriteLog,
): number {
  let spelled = 0;
  program.traverse({
    CallExpression: {
      exit(path) {
        if (isInsideAny(path, machinery) || insideWith(path)) return;
        if (spellDecoderCall(path, index, log, 'sites')) spelled++;
      },
    },
    MemberExpression: {
      exit(path) {
        if (isInsideAny(path, machinery) || insideWith(path)) return;
        if (spellTableRead(path, index, log)) spelled++;
      },
    },
  });
  return spelled;
}

/**
 * The console-disable stubs armed inside a rotation wrapper, disarmed: each
 * arming call, `controller(this, stub)`, becomes a function that does
 * nothing. What the clean stage removes under the same technique, made here
 * because such a stub is in the slice of the wrapper's decoder, which is
 * refused for it before any tier; see `consoleDisableArmings`. A stub armed
 * anywhere else is in no slice and is left to that stage, which removes the
 * whole construct where this would leave its controller and call behind.
 */
function neutraliseConsoleStubs(program: NodePath<t.Program>, log: RewriteLog): void {
  for (const arming of consoleDisableArmings(program)) {
    const host = arming.getFunctionParent();
    if (!host || !rotatesATable(host.node)) continue;
    log.replace(arming, t.functionExpression(null, [], t.blockStatement([])));
    log.stubs++;
  }
}

/** Whether a function's body runs a `push(shift())` rotation of its own. */
function rotatesATable(fn: t.Function): boolean {
  const stack: unknown[] = [fn.body];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    if (t.isFunction(node)) continue;
    if (
      t.isCallExpression(node) &&
      t.isMemberExpression(node.callee) &&
      methodNameOf(node.callee) === 'push' &&
      node.arguments.length === 1 &&
      t.isCallExpression(node.arguments[0]) &&
      t.isMemberExpression(node.arguments[0].callee) &&
      methodNameOf(node.arguments[0].callee) === 'shift'
    ) {
      return true;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

function methodNameOf(member: t.MemberExpression): string | undefined {
  if (!member.computed) return t.isIdentifier(member.property) ? member.property.name : undefined;
  return staticString(member.property);
}

/**
 * Decoders over the tables a step just spelled out, built on the trial's
 * terms: proved on their own call sites, with the string-code question set
 * aside. The scope tables are rebuilt over the rewritten tree first, since a
 * slice reads them.
 */
function trialDecodersOver(
  program: NodePath<t.Program>,
  ctx: PassContext,
  sources: readonly StringSource[],
  seen: ReadonlySet<string>,
  aliases: AliasIndex,
  log: RewriteLog,
): Exposed[] {
  log.crawl();
  const held = new Set(sources.map((source) => source.name));
  const candidates = findStringSourceCandidates(program).filter(
    (candidate) =>
      candidate.kind === 'wrapper-call' && !held.has(candidate.roots[0]!) && !seen.has(keyOf(candidate)),
  );
  if (candidates.length === 0) return [];
  const sites = new CallSiteIndex(candidates, NO_STRING_CODE);
  const built: Exposed[] = [];
  for (const candidate of candidates) {
    if (ctx.isExhausted()) break;
    const samples = sites.samplesFor(candidate);
    if (samples.length === 0) continue;
    const scans = new StatementScanCache();
    const source = buildDecoder(program, candidate.roots, ctx.config, {
      reporter: { note: () => {} },
      samples,
      scans,
      aliases,
      stringCode: NO_STRING_CODE,
    });
    scans.release();
    if (source) built.push({ candidate, source, samples });
  }
  if (built.length > 0) log.layers++;
  return built;
}

/** The path of `node` among a call's arguments, when it is one of them. */
function argumentPathOf(call: NodePath, node: t.Node): NodePath | undefined {
  const args = call.get('arguments');
  if (!Array.isArray(args)) return undefined;
  return args.find((argument) => argument.node === node);
}

/**
 * Rewrite an expression to the string literal it spells, when every part of
 * it is a literal, a call to a decoder of the index, a read of a table the
 * index holds, a `+` of such parts, or a call through an object map's
 * forwarding entry over such parts. Returns whether the whole expression is
 * a literal afterwards; a part of any other shape leaves it as written.
 */
function spellThroughDecoder(path: NodePath, index: DecoderIndex, log: RewriteLog): boolean {
  const node = path.node;
  if (t.isStringLiteral(node)) return true;
  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = path.get('left') as NodePath;
    const right = path.get('right') as NodePath;
    if (!spellThroughDecoder(left, index, log) || !spellThroughDecoder(right, index, log)) return false;
    const folded = path.isBinaryExpression() ? foldStringConcat(path.node) : undefined;
    if (!folded) return false;
    log.replace(path, t.inherits(folded, node));
    return true;
  }
  if (insideWith(path)) return false;
  if (path.isCallExpression()) {
    if (t.isIdentifier(path.node.callee)) return spellDecoderCall(path, index, log, 'literals');
    if (t.isMemberExpression(path.node.callee)) return spellProxyCall(path, index, log);
    return false;
  }
  if (path.isMemberExpression()) return spellTableRead(path, index, log);
  return false;
}

/**
 * `dec(0xf7)`, or an alias or wrapper of it, with literal arguments. A call
 * that is the whole of a statement is left when its value is a directive:
 * `'use strict';` at the head of a body means something the call did not.
 */
function spellDecoderCall(
  path: NodePath<t.CallExpression>,
  index: DecoderIndex,
  log: RewriteLog,
  tally: 'literals' | 'sites',
): boolean {
  const value = decodesThrough(path, index);
  if (value === undefined) return false;
  if (isSemanticDirective(value) && path.parentPath?.isExpressionStatement()) return false;
  log.spell(path, value, tally);
  return true;
}

/** What a decoder call spells through the index, or nothing. */
function decodesThrough(path: NodePath<t.CallExpression>, index: DecoderIndex): string | undefined {
  const callee = path.node.callee;
  if (!t.isIdentifier(callee)) return undefined;
  const entry = index.resolve(path, callee.name);
  if (!entry || baseSourceOf(entry).kind !== 'wrapper-call') return undefined;
  if (!index.holdsAt(callee.name, callee, path.scope)) return undefined;
  const args = staticArguments(path.node.arguments);
  if (!args) return undefined;
  return decodeThrough(entry, args);
}

/** `_0xa[0]` on a table the index holds for direct reads. */
function spellTableRead(path: NodePath<t.MemberExpression>, index: DecoderIndex, log: RewriteLog): boolean {
  const { object, property, computed } = path.node;
  if (!computed || !t.isIdentifier(object) || !isPureContext(path)) return false;
  const at = staticNumber(property);
  if (at === undefined) return false;
  const entry = index.resolve(path, object.name);
  if (!entry || entry.kind !== 'source' || entry.source.kind !== 'array-index') return false;
  if (!index.holdsAt(object.name, object, path.scope)) return false;
  const value = decodeThrough(entry, [at]);
  if (value === undefined) return false;
  if (isSemanticDirective(value) && path.parentPath?.isExpressionStatement()) return false;
  log.spell(path, value, 'literals');
  return true;
}

/**
 * `M[k](a, b)` through an object map whose entry `k` is a forwarding function
 * - the control-flow storage object's `+` proxy, which the medium preset's
 * console stub spells its `Function` arguments through, with `k` itself a
 * call to the decoder. The map is read as `simplify.object-maps` reads it,
 * and only where that pass would: a literal the name holds for the whole of
 * its scope, every use of it a member read, the key spelled or plain and
 * naming exactly one entry. The call is expanded as that pass expands it and
 * the expansion spelled in turn.
 */
function spellProxyCall(path: NodePath<t.CallExpression>, index: DecoderIndex, log: RewriteLog): boolean {
  const callee = path.node.callee;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object)) return false;
  const binding = path.scope.getBinding(callee.object.name);
  if (!binding || isReassigned(binding) || !binding.path.isVariableDeclarator()) return false;
  const init = binding.path.node.init;
  if (!t.isObjectExpression(init)) return false;
  if (!index.holdsAt(callee.object.name, callee.object, path.scope)) return false;
  for (const reference of binding.referencePaths) {
    if (reference.removed) continue;
    const parent = reference.parentPath;
    if (!parent?.isMemberExpression() || parent.node.object !== reference.node) return false;
    if (!isPureContext(parent)) return false;
  }

  let key: string | undefined;
  if (callee.computed) {
    const property = path.get('callee.property') as NodePath;
    if (!spellThroughDecoder(property, index, log)) return false;
    key = staticString(property.node);
  } else if (t.isIdentifier(callee.property)) {
    key = callee.property.name;
  }
  if (key === undefined || key === '__proto__') return false;

  let value: t.Node | undefined;
  let matches = 0;
  for (const property of init.properties) {
    if (!t.isObjectProperty(property) || property.computed) return false;
    const name = t.isIdentifier(property.key) ? property.key.name : staticString(property.key);
    if (name === undefined) return false;
    if (name !== key) continue;
    value = property.value;
    matches++;
  }
  if (matches !== 1 || !t.isFunctionExpression(value) && !t.isArrowFunctionExpression(value)) return false;
  const template = readTemplate(value);
  if (!template) return false;
  const expanded = expandCall(template, path.node, path.scope);
  if (!expanded) return false;
  log.replace(path, expanded);
  return spellThroughDecoder(path, index, log);
}

const NOTHING_EXEMPT: ReadonlySet<t.Node> = new Set();

/** The table's reference audit passed and the index still had nothing to prove a decoder on. */
function noteUnsampled(candidate: StringSourceCandidate, ctx: PassContext, key: string): void {
  ctx.note(
    'info',
    `Left ${candidate.arrayName} as written: its reference audit passes, but no read of it ` +
      `with a constant index was collected to prove a decoder on.`,
    undefined,
    key,
  );
}

/**
 * Argument tuples to validate candidates against, gathered scope by scope.
 *
 * `buildDecoder` can find these itself, but only by name and only by traversing
 * the whole program, once per candidate. Neither is right for a bundle. By name,
 * a sibling module's identically-named decoder contributes arguments this one
 * never receives, and the resulting "only 4/32 call sites decoded" refuses a
 * perfectly good decoder. Once per candidate, a module factory holding a dozen
 * array-shaped things pays a dozen walks of its whole body - the quadratic
 * behaviour that searching every scope would otherwise introduce.
 *
 * So: one walk per scope, collecting the names *every* candidate in that scope
 * asked about, and each candidate then reads its own answer out of the result.
 * The program is a scope like any other here: it is where a classic top-level
 * build keeps its tables, and where a build with many of them pays most.
 */
class CallSiteIndex {
  /** Names any candidate in a scope cares about, keyed by that scope's node. */
  private readonly wanted = new Map<t.Node, Set<string>>();
  /** Scopes holding a wrapper candidate, the only ones where forwarders matter. */
  private readonly forwarding = new Set<t.Node>();
  private readonly scopes = new Map<t.Node, NodePath>();
  private readonly built = new Map<t.Node, Map<string, ArgumentTuple[]>>();

  constructor(
    candidates: readonly StringSourceCandidate[],
    private readonly facts: StringCodeFacts,
  ) {
    for (const candidate of candidates) {
      const node = candidate.scope.node;
      this.scopes.set(node, candidate.scope);
      let names = this.wanted.get(node);
      if (!names) {
        names = new Set();
        this.wanted.set(node, names);
      }
      for (const root of candidate.roots) names.add(root);
      if (candidate.kind === 'wrapper-call') this.forwarding.add(node);
    }
  }

  /**
   * The candidate's pool: every distinct call site of its scope in traversal
   * order (bounded by {@link POOL_LIMIT}), the head of them representative of
   * the whole (see {@link representative}).
   */
  samplesFor(candidate: StringSourceCandidate): ArgumentTuple[] {
    const node = candidate.scope.node;
    const sites = this.sitesIn(node);
    const pool: ArgumentTuple[] = [];
    const seen = new Set<string>();
    for (const root of candidate.roots) {
      for (const tuple of sites.get(root) ?? []) {
        const key = tupleKey(tuple);
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(tuple);
        if (pool.length >= POOL_LIMIT) return representative(pool);
      }
    }
    return representative(pool);
  }

  /**
   * Every literal-argument reference in one scope, in both shapes.
   *
   * `_0x123b(0x2bd3, '@m8w')` and `_0xdb56[0x1f]` are collected together because
   * the tier that wins decides which one the source actually uses. Calls that
   * reach the decoder *through a wrapper* count too: on a build with
   * `stringArrayWrappersType: 'function'` they are the only calls there are, and
   * without following them such a module would yield no samples and its decoder
   * would be adopted with nothing proven about it.
   */
  private sitesIn(node: t.Node): Map<string, ArgumentTuple[]> {
    const cached = this.built.get(node);
    if (cached) return cached;

    const sites = new Map<string, ArgumentTuple[]>();
    this.built.set(node, sites);

    const scope = this.scopes.get(node);
    const wanted = this.wanted.get(node);
    if (!scope || !wanted || wanted.size === 0) return sites;

    let full = 0;
    // Distinct per name: a site the file repeats is one piece of evidence,
    // and counting it again would fill the pool with less than it holds.
    const keys = new Map<string, Set<string>>();
    const record = (name: string, tuple: ArgumentTuple): void => {
      let list = sites.get(name);
      let seen = keys.get(name);
      if (!list || !seen) {
        list = [];
        seen = new Set();
        sites.set(name, list);
        keys.set(name, seen);
      }
      if (list.length >= POOL_LIMIT) return;
      const key = tupleKey(tuple);
      if (seen.has(key)) return;
      seen.add(key);
      list.push(tuple);
      // Once every wanted name holds all the pool can, the rest of the scope
      // has nothing left to contribute.
      if (list.length === POOL_LIMIT) full++;
    };

    const forwarders = this.forwarding.has(node)
      ? collectArgumentForwarders([node])
      : new Map<string, ArgumentForwarder>();
    const facts = this.facts;

    scope.traverse({
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee)) return;
        const tuples = sampleTuples(path, facts);
        if (tuples.length === 0) return;

        if (wanted.has(callee.name)) {
          for (const tuple of tuples) record(callee.name, tuple);
        } else {
          // `cL(1147)` where `cL = Y`: an identity alias, not a wrapper. In a
          // file whose every call site goes through one, this is the only place
          // a sample can come from.
          const aliased = resolveIdentityAlias(path, callee.name, (name) => wanted.has(name));
          if (aliased) {
            for (const tuple of tuples) record(aliased, tuple);
            if (full >= wanted.size) path.stop();
            return;
          }
          const forwarder = forwarders.get(callee.name);
          // Resolution is by name, so the binding is checked to be *this*
          // function before it is trusted: a local of the same name in another
          // scope would otherwise contribute arguments never actually passed.
          if (forwarder && denotes(path, callee.name, forwarder)) {
            for (const tuple of tuples) {
              const resolved = resolveForwardedCall(callee.name, tuple, forwarders, (name) =>
                wanted.has(name),
              );
              // A wrapper often computes an argument the decoder ignores, and
              // that one can legitimately be NaN. An index that is NaN cannot
              // decode to anything, so it is not evidence either way, and
              // counting it would only make a sound decoder look unreliable.
              if (resolved && Number.isFinite(Number(resolved.args[0]))) {
                record(resolved.name, resolved.args);
              }
            }
          }
        }

        if (full >= wanted.size) path.stop();
      },
      MemberExpression(path) {
        const { object, property, computed } = path.node;
        if (!computed || !t.isIdentifier(object)) return;
        const index = literalValue(property);
        if (typeof index !== 'number') return;
        // `_0xb[0x1]` where `_0xb = _0xa`, as for a call: the reference audit
        // follows the alias when it counts what is inlinable, and a table read
        // only that way had no sample to be proved on.
        const name = wanted.has(object.name)
          ? object.name
          : resolveIdentityAlias(path, object.name, (candidate) => wanted.has(candidate));
        if (!name) return;
        record(name, [index]);
        if (full >= wanted.size) path.stop();
      },
    });

    return sites;
  }
}

/** A name as the tree spells it: an identifier, or a JSX tag or attribute name. */
type Spelling = NodePath<t.Identifier | t.JSXIdentifier>;

/**
 * Every identifier spelling a candidate's table name, per region, in one walk.
 *
 * `tableIsStable` has to look at each reference to the table outside the
 * decoder's machinery. It used to traverse the binding's region once per
 * candidate, and for a top-level table that region is the whole program - so
 * a file with hundreds of tables walked itself hundreds of times. The region
 * is walked once, collecting only the names the round's candidates asked
 * about, and each candidate reads its own list.
 *
 * Both spellings of a name: `<_0xt />` reads the binding through a
 * `JSXIdentifier`, which an `Identifier` visitor never meets, and it hands
 * the table to whatever renders the element - `render(<_0xt />)` with a
 * `render` that reverses `c.type` printed `beta alpha` and came out
 * printing `alpha beta`, where `render(_0xt)` was refused. The judging is
 * `tableIsStable`'s and is the same for both: anything but a member read is
 * a use that could change the table.
 */
class IdentifierIndex {
  private readonly wanted: Set<string>;
  private readonly built = new Map<t.Node, Map<string, Spelling[]>>();

  constructor(candidates: readonly StringSourceCandidate[]) {
    this.wanted = new Set(candidates.map((candidate) => candidate.arrayName));
  }

  named(region: NodePath, name: string): readonly Spelling[] {
    let byName = this.built.get(region.node);
    if (!byName) {
      byName = new Map();
      this.built.set(region.node, byName);
      const wanted = this.wanted;
      const index = byName;
      const spelled = (path: Spelling): void => {
        if (!wanted.has(path.node.name)) return;
        let list = index.get(path.node.name);
        if (!list) {
          list = [];
          index.set(path.node.name, list);
        }
        list.push(path);
      };
      region.traverse({
        Identifier: spelled,
        JSXIdentifier: spelled,
      });
    }
    return byName.get(name) ?? [];
  }
}

/** Whether `name`, as seen from `path`, really binds to this forwarder. */
function denotes(path: NodePath, name: string, forwarder: ArgumentForwarder): boolean {
  const binding = path.scope.getBinding(name);
  if (!binding) return false;
  const declaration = binding.path.node;
  if (declaration === forwarder.fn) return true;
  return t.isVariableDeclarator(declaration) && declaration.init === forwarder.fn;
}

/**
 * The tuples one call is a site for: its literal arguments; a name argument
 * holding one literal, `const y = 0xd3; b(y)`, which is a site like any
 * other (see `literalHeldAt`); or, for one conditional argument of literals,
 * `b(p ? 0xce : 0xcf)`, one tuple per arm - the two sites behind the test
 * that `strings.inline` puts a literal at once the test is outside the call,
 * proved on here so that a decoder called only that way is proved on
 * something.
 */
function sampleTuples(call: NodePath<t.CallExpression>, facts: StringCodeFacts): ArgumentTuple[] {
  const args = call.node.arguments;
  const tuple = literalArguments(args) ?? heldArguments(call, facts);
  if (tuple) return [tuple];
  return conditionalArmTuples(args);
}

/** `staticArgumentsAt` as a sample: at least one argument, or nothing. */
function heldArguments(call: NodePath<t.CallExpression>, facts: StringCodeFacts): ArgumentTuple | null {
  const tuple = staticArgumentsAt(call, facts);
  return tuple && tuple.length > 0 ? tuple : null;
}

/**
 * The tuples a call with exactly one conditional argument stands for, one
 * per leaf arm with the other arguments beside it - the same shape, read by
 * the same predicates, as the call `strings.inline` distributes. Empty for
 * any other call.
 */
function conditionalArmTuples(args: readonly t.Node[]): ArgumentTuple[] {
  const at = args.findIndex((argument) => t.isConditionalExpression(argument));
  if (at === -1) return [];
  const rest: (string | number | undefined)[] = [];
  for (let index = 0; index < args.length; index++) {
    if (index === at) {
      rest.push(undefined);
      continue;
    }
    const value = staticNumber(args[index]) ?? staticString(args[index]);
    if (value === undefined) return [];
    rest.push(value);
  }
  const arms = literalArmValues(args[at] as t.ConditionalExpression);
  if (!arms) return [];
  return arms.map((arm) => rest.map((value, index) => (index === at ? arm : value)) as (string | number)[]);
}

/** Whether every arm of a conditional is a literal, through nested conditionals. */
export function literalArms(node: t.ConditionalExpression): boolean {
  return literalArmValues(node) !== undefined;
}

/** The literal each leaf arm of a conditional holds, in order, or nothing when an arm is not one. */
function literalArmValues(node: t.ConditionalExpression): (string | number)[] | undefined {
  const values: (string | number)[] = [];
  for (const arm of [node.consequent, node.alternate]) {
    if (t.isConditionalExpression(arm)) {
      const nested = literalArmValues(arm);
      if (!nested) return undefined;
      values.push(...nested);
      continue;
    }
    const value = staticNumber(arm) ?? staticString(arm);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function literalArguments(args: readonly t.Node[]): ArgumentTuple | null {
  const tuple: (string | number)[] = [];
  for (const argument of args) {
    const value = literalValue(argument);
    if (value === undefined) return null;
    tuple.push(value);
  }
  return tuple.length > 0 ? tuple : null;
}

function literalValue(node: t.Node): string | number | undefined {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && t.isNumericLiteral(node.argument)) {
    if (node.operator === '-') return -node.argument.value;
    if (node.operator === '+') return node.argument.value;
  }
  return undefined;
}

/** One tuple, one key: `(1)` and `('1')` are different call sites, `(1)` twice is one. */
function tupleKey(tuple: ArgumentTuple): string {
  return JSON.stringify(tuple);
}

/**
 * A pool whose first {@link SAMPLE_LIMIT} sites stand for the whole of it.
 *
 * Traversal order is file order, and the first sites of a file are the top
 * of it: a rotation loop's checksum strings, the first function's own few
 * indices. A pool larger than the sample cap keeps that head - the probes
 * `buildDecoder` opens with are its first entries - but gives up its tail
 * to sites spread across the argument range, one per {@link RANGE_PICKS}th
 * of it with the extremes included, so the last element of the table and an
 * index past whatever threshold the decoder changes behaviour at are among
 * the sites a candidate is proved on, and not only among the ones the
 * cross-check may then choose. The sites the head no longer holds follow it,
 * so nothing collected is lost to the cross-check's own choice.
 */
function representative(pool: ArgumentTuple[]): ArgumentTuple[] {
  if (pool.length <= SAMPLE_LIMIT) return pool;
  const head = pool.slice(0, SAMPLE_LIMIT);
  const byArgument = [...pool].sort(compareArguments);
  const step = (byArgument.length - 1) / (RANGE_PICKS - 1);
  const picks: ArgumentTuple[] = [];
  for (let k = 0; k < RANGE_PICKS; k++) picks.push(byArgument[Math.round(k * step)]!);
  const picked = new Set(picks.map(tupleKey));
  const held = new Set(head.map(tupleKey));
  // From the tail up, over entries the spread did not itself choose.
  let slot = head.length - 1;
  for (const pick of picks) {
    if (held.has(tupleKey(pick))) continue;
    while (slot >= 0 && picked.has(tupleKey(head[slot]!))) slot--;
    if (slot < 0) break;
    held.delete(tupleKey(head[slot]!));
    held.add(tupleKey(pick));
    head[slot--] = pick;
  }
  return [...head, ...pool.filter((tuple) => !held.has(tupleKey(tuple)))];
}

/** Numeric first arguments in order, whatever they are spelt as; the rest by spelling. */
function compareArguments(a: ArgumentTuple, b: ArgumentTuple): number {
  const left = Number(a[0]);
  const right = Number(b[0]);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  const first = tupleKey(a);
  const second = tupleKey(b);
  return first < second ? -1 : first > second ? 1 : 0;
}

/**
 * `declarations` is the table's own machinery, exempt from the audit: the
 * slice's sources, whether a decoder was built from it or not - narrowed to
 * the roots' own declarators by `machineryOf`, since a `var` the slice took
 * for the table can declare an alias of it beside it.
 */
function arrayIsImmutable(
  candidate: StringSourceCandidate,
  name: string,
  declarations: readonly NodePath[],
  ctx: PassContext,
  key?: string,
): boolean {
  const exempt = machineryOf(declarations, candidate.roots);
  // Resolved from the candidate's own scope: `_0x1234` in one module and
  // `_0x1234` in the next are different arrays with different reference sets.
  const audit = auditArrayReferences(candidate.scope, name, exempt);

  if (audit.unsafe.length > 0) {
    ctx.note(
      'warning',
      `Refusing to inline ${name}: ${audit.unsafe.length} reference(s) could change the ` +
        `array before it is read (${audit.unsafe.slice(0, 3).join('; ')}).`,
      undefined,
      key,
    );
    return false;
  }
  if (audit.inlinable === 0) {
    ctx.note(
      'info',
      `${name} is never indexed by a constant (${audit.opaqueReads} runtime read(s)); ` +
        'there is nothing to inline.',
      undefined,
      key,
    );
    return false;
  }
  return true;
}

/**
 * Whether a wrapper's backing table is the same table when the wrapper runs.
 *
 * `arrayIsImmutable` guards the array-index shape, where the call sites *are*
 * reads of the array. A wrapper hides that: `_0xd(0)` looks like a pure
 * function call, so nothing else asks whether `_0xarr` still holds what it held
 * at load. It need not - `_0xarr[0] = 'z';` anywhere in the program silently
 * makes every decoded literal a confident lie, which is precisely the failure
 * mode a reader cannot detect.
 *
 * The decoder's own machinery is exempt because that is what the decoder *is*:
 * for a rotated table the `push(shift())` loop is part of the value the slice
 * already reproduced. Everything outside it is judged, and anything that could
 * write to the table - or hand it to something that could - is a refusal.
 */
function tableIsStable(
  candidate: StringSourceCandidate,
  source: StringSource,
  program: NodePath<t.Program>,
  ctx: PassContext,
  identifiers: IdentifierIndex,
): boolean {
  const machinery = machineryOf(source.declarations, candidate.roots);
  if (machinery.size === 0) return true;

  // The table the decoder reads, resolved from where the decoder lives. A
  // table borrowed from an enclosing scope is declared by a unit `sources`
  // never carries, so telling it apart from a same-named binding elsewhere by
  // whether its declarator sits in the machinery put every reference to a
  // borrowed table on the wrong side: `rev(_0xt)` and `var _0xk = _0xt;
  // _0xk.reverse()` beside the module were never judged, and the decoder one
  // scope down inlined the values from before the reverse, at every preset.
  // The binding itself is the test; the declarator stands in only when the
  // candidate's scope cannot resolve one. What declares the table is its
  // machinery wherever it lives - the binding identifier, and for a table
  // function the body that replaces its own name - as the level-0 unit is.
  const table = candidate.scope.scope.getBinding(candidate.arrayName);
  if (table && !table.path.removed) machinery.add(table.path.node);

  let unsafe: NodePath | undefined;
  // Only the region the table's binding covers. A module-local `_0xarr` cannot
  // be named from outside the module, so scanning the whole bundle for it finds
  // exactly the same references - at forty times the cost, once per module. And
  // one walk of that region for every candidate whose table lives in it, not
  // one walk per candidate: for a top-level build the region is the program.
  for (const path of identifiers.named(bindingRegion(candidate, program), candidate.arrayName)) {
    if (isInsideAny(path, machinery)) continue;
    const binding = path.scope.getBinding(candidate.arrayName);
    // A same-named binding declared somewhere else is a different array.
    if (!binding || (table ? binding !== table : !isInsideAny(binding.path, machinery))) continue;
    if (!isReadOnlyTableUse(path)) {
      unsafe = path;
      break;
    }
  }

  if (!unsafe) return true;
  ctx.note(
    'warning',
    `Refusing to inline ${source.name}: ${candidate.arrayName} can be changed at line ` +
      `${unsafe.node.loc?.start.line ?? 0}, so the decoded values need not be the ones that run.`,
  );
  return false;
}

/**
 * The subtree in which a name can possibly refer to the candidate's table.
 *
 * That is the scope its binding lives in - which for a nested decoder reading an
 * array from an enclosing scope is *not* the candidate's own scope, so the
 * binding is asked rather than assumed. The program is the fallback whenever the
 * binding cannot be resolved, which keeps the check conservative by default.
 */
function bindingRegion(
  candidate: StringSourceCandidate,
  program: NodePath<t.Program>,
): NodePath {
  const binding = candidate.scope.scope.getBinding(candidate.arrayName);
  const owner = binding?.scope.path;
  return owner && !owner.removed ? owner : program;
}

/**
 * Whether this use of the table provably cannot change it.
 *
 * Mirrors the rules `auditArrayReferences` applies to a directly-indexed array:
 * a read through a member expression is fine, a write through one is not, and a
 * *call* through an unresolved key might be `push` as easily as `at`.
 */
function isReadOnlyTableUse(path: NodePath): boolean {
  const parent = path.parentPath;
  // A table function called with nothing, `var e = T()`, hands the array to
  // a local; the use is a read when every use of the local is one. That is
  // how a second decoder over the same table reads it.
  if (parent?.isCallExpression() && parent.node.callee === path.node && parent.node.arguments.length === 0) {
    return readsOnlyThroughLocal(parent);
  }
  // Anything but a member read hands the array itself to unknown code.
  if (!parent?.isMemberExpression() || parent.node.object !== path.node) return false;
  if (!isPureContext(parent)) return false;

  const member = parent.node;
  const calledAsMethod = parent.parentPath.isCallExpression()
    ? parent.parentPath.node.callee === member
    : false;
  if (calledAsMethod) return false;
  if (member.computed) return true;
  return t.isIdentifier(member.property, { name: 'length' });
}

/** `var e = T()` whose `e` is never reassigned and only ever read through a member. */
function readsOnlyThroughLocal(call: NodePath<t.CallExpression>): boolean {
  const declarator = call.parentPath;
  if (!declarator?.isVariableDeclarator() || declarator.node.init !== call.node) return false;
  if (!t.isIdentifier(declarator.node.id)) return false;
  const binding = declarator.scope.getBinding(declarator.node.id.name);
  if (!binding || !binding.constant) return false;
  return binding.referencePaths.every((reference) => reference.removed || isReadOnlyTableUse(reference));
}

function reportDetections(
  candidate: StringSourceCandidate,
  source: StringSource,
  ctx: PassContext,
  fingerprinted: Set<string>,
): void {
  // Small arrays in ordinary code look exactly like small obfuscated ones, so
  // the fingerprint is reported with confidence proportional to the evidence
  // rather than asserted outright. Keyed by scope as well as name so a bundle
  // reports one detection per module instead of folding them all into the first.
  const fingerprint = `${candidate.scopeId}:${candidate.arrayName}`;
  if (!fingerprinted.has(fingerprint)) {
    fingerprinted.add(fingerprint);
    const confidence = candidate.size >= 64 ? 1 : candidate.size >= 8 ? 0.75 : 0.4;
    ctx.report(
      'string-array',
      `${candidate.arrayName} (${candidate.size} entries)`,
      confidence,
      candidate.size,
    );
    if (candidate.rotated) {
      ctx.report('string-array-rotate', `${candidate.arrayName} rotated at load`, 1);
    }
  }

  if (candidate.kind === 'wrapper-call' && candidate.decoderName) {
    ctx.report('string-array-wrapper', `${candidate.decoderName} (${source.tier} tier)`, 1);
  }

  const algorithm = candidate.encoding?.algorithm;
  if (algorithm === 'rc4') {
    ctx.report('string-encoding-rc4', candidate.encoding!.evidence, 1);
  }
  if (algorithm === 'base64' || candidate.encoding?.base64) {
    ctx.report('string-encoding-base64', candidate.encoding!.evidence, 1);
  }
}

/**
 * The `Program` path for a parsed file.
 *
 * `run` passes are handed the `File` node, but every scope and reference query
 * needs a path. Traversal stops at the first node, so this is a constant-time
 * lookup rather than a walk.
 */
export function programPathOf(file: t.File): NodePath<t.Program> | undefined {
  let program: NodePath<t.Program> | undefined;
  traverse(file, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

// ---------------------------------------------------------------------------
// Constant pools
// ---------------------------------------------------------------------------

/**
 * Replace `pool[<literal>]` with the exact constant it stands for.
 *
 * A protector that leaves no literal in the source has to put them *somewhere*,
 * and a pool is where: one array holding every string, mask, sentinel and hash
 * seed the program was written with, read by index at thousands of sites. Until
 * those reads are values again, nothing downstream can see a constant - the
 * decoder's own radix is `pool[12]`, its byte mask is `pool[3]`, and every call
 * site's arguments are `pool[...]` too, so a decoder call that looks like
 * `G(498, pool[2])` has no literal arguments and is invisible to inlining.
 *
 * Safety is `auditArrayReferences`, unchanged and unweakened: one write through
 * the binding anywhere in the program, one escape of the array as a value, and
 * the whole pool is refused. Nothing is inlined on the strength of the
 * declaration alone.
 *
 * Returns the number of reads rewritten.
 */
function inlineConstantPools(
  ctx: PassContext,
  program: NodePath<t.Program>,
  shapes: PackedShapeScan = scanPackedShapes(program),
): number {
  const done = sharedSet(ctx, 'strings.discover:pools');
  const candidates = findConstantPoolCandidates(program, shapes).filter(
    (candidate) => !done.has(poolKey(candidate)),
  );
  if (candidates.length === 0) return 0;

  // Every decision below is a statement about references, and the tree has
  // changed since scope was last built.
  ctx.crawlProgramScope(program);

  let rewritten = 0;
  for (const candidate of candidates) {
    done.add(poolKey(candidate));
    rewritten += inlinePool(candidate, ctx);
  }
  return rewritten;
}

function poolKey(candidate: ConstantPoolCandidate): string {
  return `${candidate.scopeId}:${candidate.name}:${candidate.values.length}`;
}

function inlinePool(candidate: ConstantPoolCandidate, ctx: PassContext): number {
  const audit = auditArrayReferences(candidate.declarator, candidate.name, new Set());
  if (audit.unsafe.length > 0) {
    ctx.note(
      'warning',
      `Refusing to inline the constant pool ${candidate.name}: ${audit.unsafe.length} ` +
        `reference(s) could change it before it is read (${audit.unsafe.slice(0, 3).join('; ')}).`,
    );
    return 0;
  }
  if (audit.inlinable === 0) return 0;

  const binding = candidate.declarator.scope.getBinding(candidate.name);
  if (!binding) return 0;

  let rewritten = 0;
  let outOfRange = 0;
  let oversized = 0;
  for (const reference of binding.referencePaths) {
    if (reference.removed) continue;
    const member = reference.parentPath;
    if (!member?.isMemberExpression()) continue;
    if (member.node.object !== reference.node || !member.node.computed) continue;
    // The audit already refuses a pool that is written to anywhere, so this is
    // belt and braces rather than the load-bearing check.
    if (!isPureContext(member)) continue;
    // Inside `with (o) { ... }` the pool's name resolves against `o` first, so
    // this read may never reach the pool the binding names.
    if (insideWith(reference)) continue;

    const index = staticNumber(member.node.property);
    if (index === undefined || !Number.isInteger(index)) continue;
    if (index < 0 || index >= candidate.values.length) {
      outOfRange++;
      continue;
    }

    const literal = constantPoolNode(candidate.values[index]!);
    if (!literal) {
      oversized++;
      continue;
    }
    member.replaceWith(t.inherits(literal, member.node));
    rewritten++;
  }

  if (rewritten > 0) {
    ctx.markChanged(rewritten);
    ctx.note(
      'info',
      `Inlined ${rewritten} read(s) of the ${candidate.values.length}-entry constant pool ` +
        `${candidate.name}.` +
        (oversized > 0 ? ` ${oversized} read(s) of long entries were left in place.` : '') +
        (outOfRange > 0 ? ` ${outOfRange} read(s) were out of range and left alone.` : ''),
    );
  }
  return rewritten;
}

// ---------------------------------------------------------------------------
// Packed-blob decoders
// ---------------------------------------------------------------------------

/**
 * Adopt every `acc(offset, length)` decoder that cuts runs out of a packed blob.
 *
 * Separate from the array search above because there is nothing array-shaped to
 * find: the table is one long encoded string and a call site names a byte range
 * in it. Everything else is shared - the same slicer decides what the decoder
 * depends on, the same native tier recognises the algorithm without running a
 * line of it, and the same `StringSource` comes out the other end, so inlining,
 * pruning and reporting need to know nothing about this family at all.
 */
function discoverBlobSources(
  ctx: PassContext,
  program: NodePath<t.Program>,
  shapes: PackedShapeScan = scanPackedShapes(program),
): number {
  const seen = seenCandidates(ctx);
  const unsampled = unsampledBlobs(ctx);
  const candidates = findBlobDecoderCandidates(program, shapes).filter((candidate) =>
    blobIsDue(blobKey(candidate), ctx, seen, unsampled),
  );
  if (candidates.length === 0) return 0;

  ctx.crawlProgramScope(program);

  // One cache per round, as in `discoverStringSources`: every candidate's slice
  // is cut from the same tree, and the unit facts the audit reads - free
  // variables, scans, aliases - are facts about the tree. Without it each
  // candidate rebuilt every level it drew from and re-crawled every sibling
  // unit per name it needed: 298 level rebuilds and 18,028 throwaway scope
  // crawls on the 448 KB fixture, 3.2 s of discovery turned into 11.7 s.
  const scans = new StatementScanCache();

  let accepted = 0;
  try {
    for (const candidate of candidates) {
      if (ctx.isExhausted()) {
        ctx.note('warning', 'Time budget reached before all packed blobs were discovered.');
        break;
      }
      const key = blobKey(candidate);
      const outcome = adoptBlob(candidate, program, ctx, scans, key);
      if (outcome === 'adopted') accepted++;
      // An accessor no call reaches with two literals is not refused, it is
      // not yet provable: `U(2454, 8)` is `U(e, U)` until the round that
      // inlines the map its arguments come from, and remembered as refused
      // it stayed as written while a second run over the output decoded it.
      // The samples are a walk of one binding's references, so it is put up
      // again each round the tree moves.
      if (outcome === 'unsampled') {
        unsampled.set(key, ctx.iteration);
        continue;
      }
      unsampled.delete(key);
      seen.add(key);
    }
  } finally {
    // Same as `discoverStringSources`: stale once the round ends, and reachable.
    scans.release();
  }
  return accepted;
}

function blobKey(candidate: BlobDecoderCandidate): string {
  return `blob:${candidate.scopeId}:${candidate.roots.join(',')}`;
}

/** Accessors put up without a sample, by key, with the round they were last put up in. */
function unsampledBlobs(ctx: PassContext): Map<string, number> {
  const existing = ctx.shared.get('strings.discover:unsampled-blobs');
  if (existing instanceof Map) return existing as Map<string, number>;
  const created = new Map<string, number>();
  ctx.shared.set('strings.discover:unsampled-blobs', created);
  return created;
}

/** As `isDue` for the array shapes: not refused for good, and not put up this round already. */
function blobIsDue(
  key: string,
  ctx: PassContext,
  seen: ReadonlySet<string>,
  unsampled: ReadonlyMap<string, number>,
): boolean {
  if (seen.has(key)) return false;
  return unsampled.get(key) !== ctx.iteration;
}

type BlobAdoption = 'adopted' | 'refused' | 'unsampled';

function adoptBlob(
  candidate: BlobDecoderCandidate,
  program: NodePath<t.Program>,
  ctx: PassContext,
  scans: StatementScanCache,
  key: string,
): BlobAdoption {
  const samples = blobSamples(candidate);
  // No call site with literal arguments means there is nothing to inline and
  // nothing to validate against, and a decoder proved against nothing has no
  // evidence behind it at all. Each way out of here that is not an adoption
  // is a line: this family has no fingerprint in `prepare.detect` and no
  // audit of its own, so a refusal made in silence here is one the report
  // never mentions at all. One line per accessor, the last round's, and
  // withdrawn if a later round adopts it.
  const line = `strings.discover:blob:${key}`;
  const left = (why: string): 'refused' => {
    ctx.note('info', `Left the packed-blob accessor ${candidate.roots[0]} as written: ${why}.`, undefined, line);
    return 'refused';
  };
  if (samples.length === 0) {
    left('no call to it carries two literal arguments to prove a decoder on');
    return 'unsampled';
  }

  const slice = sliceForEvaluation(program, candidate.roots, scans);
  if (slice.statements.length === 0) return left('its declaration could not be sliced out');

  // The ordinary route whenever the slice is closed. It runs the whole tier
  // ladder, cross-checks the native answer against the interpreter, and applies
  // the caller's decode budget - none of which is worth reimplementing here.
  if (isSelfContained(slice)) {
    const built = buildDecoder(program, candidate.roots, ctx.config, {
      reporter: { note: (severity, message) => ctx.note(severity, message) },
      samples,
      scans,
      stringCode: stringCodeFacts(ctx),
    });
    if (built) {
      ctx.stringSources.push(built);
      reportBlob(candidate, built.name, ctx);
      ctx.retract(line);
      ctx.note(
        'info',
        `Recognised ${built.name} as a packed-blob decoder via the ${built.tier} tier; ` +
          `validated on ${samples.length} call site(s).`,
      );
      return 'adopted';
    }
    // The evaluator has said why, through the reporter above.
    return 'refused';
  }

  // The slice is not closed, which for this family is the normal case rather
  // than the suspicious one: the protector staples a domain lock and a newline
  // tripwire into the middle of the unpacking loop, so the decoder's own
  // dependency closure mentions `location` and `window` however small it is.
  //
  // Those are reasons never to *evaluate* the slice, and it never is: the only
  // tier used here is `native`, which executes nothing at all. It reads three
  // literals out of the AST - the blob, the alphabet and the packing constants -
  // and everything after that is this engine's own code operating on its own
  // strings, with no path from the input to anything but
  // `String.prototype.indexOf`. The interpreter and sandbox tiers stay
  // unreachable for such a slice, exactly as `buildDecoder` intends.
  if (!ctx.config.techniqueOptions.stringDecoding.tiers.includes('native')) {
    return left(
      'its slice reaches outside itself and only the native tier reads such a slice, which ' +
        'stringDecoding.tiers does not include',
    );
  }

  const native = recogniseBlobDecoder(slice.statements, candidate.roots);
  if (!native) {
    return left(
      'its slice reaches outside itself and the native tier does not recognise the unpacking ' +
        'it does',
    );
  }

  const verdict = validateAgainstSamples(native.decode, samples);
  if (!verdict.ok) {
    ctx.note(
      'warning',
      `Refusing the packed-blob decoder ${candidate.roots[0]}: ${verdict.reason}.`,
    );
    return 'refused';
  }

  ctx.stringSources.push({
    name: native.name,
    kind: native.kind,
    tier: 'native',
    decode: budgeted(native.decode, ctx),
    aliases: new Set(),
    declarations: slice.sources,
  });
  reportBlob(candidate, native.name, ctx);
  ctx.retract(line);
  ctx.note(
    'info',
    `Recognised ${native.name} as a packed-blob decoder (${native.evidence}); ` +
      `validated on ${samples.length} call site(s) without executing any of it.`,
  );
  return 'adopted';
}

/**
 * Literal-argument call sites of the accessor, resolved through its binding.
 *
 * Through the binding rather than by name: this family puts a decoder in every
 * nested scope of the file, a dozen of which are called `U` or `V`, and samples
 * borrowed from the wrong one would either fail a sound decoder or pass an
 * unsound one.
 */
function blobSamples(candidate: BlobDecoderCandidate): ArgumentTuple[] {
  const binding = candidate.scope.scope.getBinding(candidate.roots[0]!);
  if (!binding) return [];

  const pool: ArgumentTuple[] = [];
  const seen = new Set<string>();
  for (const reference of binding.referencePaths) {
    if (reference.removed) continue;
    const call = reference.parentPath;
    if (!call?.isCallExpression() || call.node.callee !== reference.node) continue;
    const tuple = literalArguments(call.node.arguments);
    if (!tuple || tuple.length !== 2) continue;
    const key = tupleKey(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(tuple);
    if (pool.length >= POOL_LIMIT) break;
  }
  return representative(pool);
}

/**
 * The caller's memoization and decode budget, mirroring what `buildDecoder`
 * wraps around every decoder it returns. A blob decoder is asked the same
 * question thousands of times over a single blob, so the cache is not an
 * optimisation, it is the difference between milliseconds and seconds.
 */
function budgeted(
  decode: (args: readonly (string | number)[]) => string | undefined,
  ctx: PassContext,
): (args: readonly (string | number)[]) => string | undefined {
  const limit = ctx.config.techniqueOptions.stringDecoding.maxDecodeCalls;
  let calls = 0;
  let exhausted = false;

  const guarded = (args: readonly (string | number)[]): string | undefined => {
    if (exhausted) return undefined;
    if (++calls > limit) {
      exhausted = true;
      ctx.note(
        'warning',
        `Decode budget of ${limit} calls exhausted; remaining references left encoded.`,
      );
      return undefined;
    }
    try {
      return decode(args);
    } catch {
      return undefined;
    }
  };

  if (!ctx.config.performance.memoize) return guarded;

  const cache = new Map<string, string | undefined>();
  return (args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const value = guarded(args);
    cache.set(key, value);
    return value;
  };
}

function reportBlob(candidate: BlobDecoderCandidate, name: string, ctx: PassContext): void {
  ctx.report(
    'string-array-wrapper',
    `${name} (packed blob${candidate.viaForwarder ? `, forwarding to ${candidate.accessorName}` : ''})`,
    1,
  );
}
