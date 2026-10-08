import _traverse, { type Binding, type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import type { ResolvedConfig } from '../../config/presets.js';
import type { PassContext, StringSource } from '../../pipeline/context.js';
import type { EvaluatorTier, Severity } from '../../types.js';
import { holdsDeclaredValue, staticString, stripTypeWrappers } from '../../util/ast.js';
import {
  isSelfContained,
  sliceForEvaluation,
  type SliceResult,
  type StatementScanCache,
  type UnmodelledMutationKind,
} from '../slice.js';
import { stringCodeFacts, type StringCodeFacts } from '../string-code.js';
import {
  createInterpreter,
  InterpreterLimitError,
  isUseStrict,
  StepLimitExceeded,
  TimeLimitExceeded,
  type ExhaustionSite,
  type Interpreter,
} from './interpreter.js';
import {
  collectArgumentForwarders,
  exciseStateObjectGuards,
  findSliceTrap,
  recogniseNativeDecoder,
  resolveForwardedCall,
  unmodelledLoop,
  type ArgumentForwarder,
  type ModelledCode,
  type SolvedRotation,
} from './native.js';
import { globalNames } from './builtins.js';
import { GLOBAL_OBJECT_FALLBACKS, idiomOnlyNames, isGlobalObjectRead } from './global-object.js';
import {
  armHolds,
  calleeSpellings,
  literalHolds,
  pickedByLiteral,
  invocation,
  isMember,
  isRead,
  literalElement,
  literalKey,
  literalProperty,
  MAX_KEY_HOPS,
  memberSpelling,
  memberSpine,
  methodKey,
  propertyKey,
  UNREAD_KEY,
} from './callee.js';
import { createSandbox } from './sandbox.js';

/**
 * The tier dispatcher: turn a discovered decoder binding into a `StringSource`.
 *
 * Three implementations of the same question - "what string does this call site
 * stand for?" - sit behind one entry point, ordered cheapest-and-safest first:
 *
 * 1. `native`      recognise the algorithm, run a native implementation of it.
 * 2. `interpreter` walk the decoder's own AST in a restricted interpreter.
 * 3. `sandbox`     actually execute the slice. Opt-in, and off by default.
 *
 * Two things make the ladder trustworthy rather than merely convenient. First,
 * every tier is fed the *slice* - the dependency closure of the decoder - and a
 * slice with free references to anything outside a short arithmetic/string
 * allowlist is refused outright, so no tier ever sees DOM, network or user code.
 * Second, a tier's output is validated against real call sites before it is
 * trusted, and tiers that can check each other do.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EvaluatorReporter {
  note(severity: Severity, message: string): void;
  /**
   * A refusal that is a fact about the tree as it stands rather than about
   * the decoder, told apart so a caller that remembers what it refused can
   * leave this one out of that memory. Every other refusal is final and is
   * reported through `note` alone.
   */
  refused?(kind: DecoderRefusal): void;
}

/**
 * `unverified`: the decoder is used, and not one of its uses has an argument
 * the sample walk could read - an object-map read, a call through a proxy -
 * so no tier was proved on anything. A round that inlines those maps exposes
 * a literal argument, and the same candidate is then worth proposing again.
 *
 * `unread-key`: a write that may reach a builtin the decoder reads has its
 * key computed by a call to a function of the file this round cannot read
 * - `String[k(0)] = ...` over another decoder `k` - and a round that inlines
 * that call spells the key out. Deferred the same way, and told apart so
 * the caller can make the deferral a warning: a decoder on which the
 * key never surfaces ends the run undecoded, and that is a refusal owed a
 * warning naming the write, not an info line.
 *
 * `mutation`: a statement the slice cannot include names the decoder or its
 * table in a way the slicer cannot model - a method call handed the decoder,
 * a write through a member. That statement is part of the tree, and the tree
 * moves: obfuscator.io's control-flow flattening routes every decoder call
 * through a proxy, `m[k](dec, 0x1b3)` with `k` decoded by the layer beneath,
 * and stacked three deep the third layer's decoder is handed to a proxy in
 * every one of its uses until the second layer's strings are inlined and the
 * proxies with them. The refusal is right on the round it is made and stale
 * on the next; remembered for the run it left a third of such a file encoded.
 */
export type DecoderRefusal = 'unverified' | 'unread-key' | 'mutation';

export interface BuildDecoderOptions {
  /** Where refusals, fall-throughs and cross-check disagreements are recorded. */
  reporter?: EvaluatorReporter;
  /**
   * Argument tuples to validate and cross-check against. Discovered from the
   * program if omitted. A tier is proved on the first `DEFAULT_SAMPLE_LIMIT`
   * of them; the rest are the cross-check's to compare.
   */
  samples?: readonly ArgumentTuple[];
  /** Cap on call sites scanned when discovering samples. */
  maxSamples?: number;
  /**
   * Compare `native` against `interpreter` on the sample set even when the first
   * tier already succeeded. On by default whenever both tiers are enabled.
   */
  crossCheck?: boolean;
  /** Per-round statement scans shared across candidates; see `StatementScanCache`. */
  scans?: StatementScanCache;
  /** Per-round top-level alias links shared across candidates; see `AliasIndex`. */
  aliases?: AliasIndex;
  /**
   * The program's string-code facts, when the caller holds the pipeline's
   * copy. Computed here otherwise - one raw walk of the tree per round, which
   * the pipeline already made for the iteration; see `stringCodeOf`.
   */
  stringCode?: StringCodeFacts;
}

export type ArgumentTuple = readonly (string | number)[];

/**
 * Enough samples to catch a wrong recogniser, few enough to stay off the
 * profile. Also the head of a caller's larger list: `strings.discover` hands
 * over every distinct call site of a candidate, its first entries made to
 * stand for the whole (`representative` there), and a tier is proved on that
 * head - the rest of the list is the cross-check's.
 */
const DEFAULT_SAMPLE_LIMIT = 32;
/**
 * The most call sites the interpreter is asked to confirm.
 *
 * Every site, whenever the list fits. The budget used to equal the sample cap,
 * on the reasoning that a collector never hands over more than it proves on;
 * then `strings.discover` started handing over its whole pool so that the one
 * non-ASCII site in a file could be chosen by content, and the budget went on
 * thinning it to thirty-two. A recogniser wrong at one ASCII site in a
 * hundred - an offset folded in for the wrong range - is caught only when
 * that site is compared, and thirty-two spread over a hundred land on the
 * forty-seventh and the fifty-first. So the budget is where comparing stops
 * paying: an interpreted base64 decode is some 150 µs, four thousand of them
 * half a second, and the 29,608 sites of obfuscated2.js's decoder would be
 * four and a half - for a decoder the interpreter does not build within its
 * step budget in any case. Above it the head is kept and the rest thinned by
 * content; see `crossCheckSet`.
 */
const CROSS_CHECK_LIMIT = 4096;
const INTERPRETER_MAX_DEPTH = 256;

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildDecoder(
  program: NodePath<t.Program>,
  roots: readonly string[],
  config: ResolvedConfig,
  options: BuildDecoderOptions = {},
): StringSource | undefined {
  const note = (severity: Severity, message: string): void =>
    options.reporter?.note(severity, message);

  if (roots.length === 0) return undefined;

  const slice = sliceForEvaluation(program, roots, options.scans);
  if (slice.statements.length === 0) {
    note('warning', `No declaration found for decoder ${roots.join(', ')}.`);
    return undefined;
  }
  // A value something else changes is not the value that runs. The slicer takes
  // every mutator it can recognise; when it reports one it could not, every
  // string this decoder would produce is plausible and wrong, so there is
  // nothing to do but refuse - and the reader is told which kind of change it was.
  if (slice.unmodelledMutation) {
    note(
      'warning',
      `Refusing to evaluate ${roots[0]}: ${describeMutation(slice.unmodelledMutation, slice.unmodelledMutationKind)}`,
    );
    options.reporter?.refused?.('mutation');
    return undefined;
  }
  // A slice the program never runs past is not a decoder's machinery, it is
  // the program's behaviour. `(function () { var e = c(); while (!![]) { try
  // {} catch (g) {} } })(a)` beside a real decoder ran the interpreter out of
  // budget, the native match stood unchecked at balanced, and the pruned
  // machinery took the hang with it: `"fn:nm"` printed where the input never
  // terminates. Every tier runs these statements before it runs a decoder, so
  // the walk is made once here, before any tier is trusted with them.
  // obfuscator.io 0.x's `selfDefending` state object, invoked inside the
  // decoder, tests a formatting pattern against the compact print of one of
  // its own methods and returns at once on a match; on a mismatch it never
  // returns. The invocation is cut from the slice when the shape is the
  // template's and the match holds - a no-op, for every tier at once - so
  // no tier is judged on how it reprints a function; see
  // `findStateObjectGuards`.
  const excised = exciseStateObjectGuards(slice.statements);
  if (excised.length > 0) {
    note(
      'info',
      `Excised ${excised.length} self-defending state-object invocation(s) from the slice of ${roots[0]}: ` +
        `each tests a formatting pattern against its own compact print, which matches, and does nothing more.`,
    );
  }
  const trap = findSliceTrap(slice.statements);
  if (trap) {
    note(
      'warning',
      `Refusing to evaluate ${roots[0]}: its slice runs into ${trap.what} (${spellStatement(trap.statement)}` +
        `${whereInSlice(slice, trap.statement)}) before any decoder is called, and the program never gets past it.`,
    );
    return undefined;
  }
  // Strictness is a property of the `Program` - its source type and its
  // directive prologue - that the statements cut out of it no longer carry.
  // Module-ness is kept apart from it: a `'use strict'` script is strict and
  // still has the global object as its top-level `this`; only a module binds
  // `undefined` there.
  const module = program.node.sourceType === 'module';
  const strict = module || program.node.directives.some(isUseStrict);
  // The names the slice resolves to nothing of its own. Every tier answers
  // each of them with the host's builtin: the interpreter from its table, the
  // recognisers by reading `decodeURIComponent(s)` as the UTF-8 step. The
  // allowlist says which builtins may be answered that way; it does not say
  // that the program's name still means the builtin, and that is a question
  // only the decoder's own scope chain can answer.
  // `Function`, `eval` and a fallback name of the global object are host
  // names the slice may spell only inside the global-object idiom:
  // `Function('return this')()` with `window` in the `catch` beside it is
  // how obfuscator.io 0.x reached the realm for its `atob` polyfill, and
  // every tier answers the idiom with its own realm - the interpreter's
  // sandbox global, whose `atob` is the builtin. The fallback is never
  // reached, since the idiom does not throw in any tier, so it is no read of
  // the host either: left in `outside`, a program's `window.x = ...` would
  // read as a write to something the slice reads. The constructor stays,
  // for the shadow check - a `Function` bound in scope is not the builtin.
  const idiom = idiomOnlyNames(slice.statements);
  const outside = hostReferences(slice).filter((name) => !(idiom.has(name) && GLOBAL_OBJECT_FALLBACKS.has(name)));
  if (!isSelfContained(slice)) {
    // `freeNames` is the slicer's own reading of the same question with the
    // allowlist taken out; the intersection keeps that list in one place.
    const escapes = outside.filter((name) => slice.freeNames.has(name) && !idiom.has(name));
    if (escapes.length > 0) {
      // Refusing here is the whole point of slicing. A decoder that reaches for
      // `document` or `fetch` is either not a decoder or is trying to get
      // something run, and no tier - including `native` - should touch it.
      note(
        'warning',
        `Refusing to evaluate ${roots[0]}: its slice references ${escapes.join(', ')}, ` +
          `which is outside the evaluation allowlist.`,
      );
      return undefined;
    }
  }
  // A binding of an allowlisted name between the decoder and the global
  // object is a different function under the builtin's name, and the slice
  // does not carry it: a `var` one block deeper, a `for` head, a parameter of
  // the IIFE the decoder sits in, a `catch` binding, a function a sloppy
  // block hoists out of itself. The slicer takes a
  // same-named declaration that is a unit of a scope it drew from - that one
  // is in the statements, bound, and not in `outside` - and leaves every
  // other shape free, where the throwaway scope the slice is judged in
  // reports it as the global. `(function (decodeURIComponent) { ... })(unescape)`
  // then decoded 'ünï' where the program prints 'Ã¼nÃ¯', on every preset,
  // with both tiers agreeing. So each name the slice takes for a global is
  // put to the scope the decoder is declared in, and any binding there is a
  // refusal before a tier runs.
  const shadowed = shadowedHostName(slice, outside, annexBIndex(program, strict, options.scans));
  if (shadowed) {
    note(
      'warning',
      `Refusing to evaluate ${roots[0]}: ${shadowed.name} is ${shadowed.what} in scope at the ` +
        `decoder, not the builtin, and every tier would run the builtin.`,
    );
    return undefined;
  }
  // A binding is one way the name stops meaning the builtin; a write is the
  // other, and no scope chain shows it. `globalThis.decodeURIComponent = ...`
  // at the top of the file, `String.fromCharCode = ...`, a bare
  // `decodeURIComponent = ...` inside a `setup()` the program calls first:
  // each leaves every scope clean and the global object changed, and each
  // had 'ünï' inlined where the program prints something else, on every
  // preset, with both tiers agreeing. The write may sit anywhere - order is
  // not asked, since a call site before the write and one after it are both
  // in the file. A write to a property is the name's only as far as the
  // slice reads that property: `String.fromCharCode = ...` is what the slice
  // reads through `String`, and `Math.clamp = ...` beside a decoder that calls
  // `Math.round` is a helper added, not a builtin replaced. A key that
  // cannot be read is the one case the presets decide: `Math[k] = ...` may be
  // `Math.round` for all the tree says, conservative refuses on that, and the
  // other two take it for the helper it is in every real file - obfuscated2's
  // `Math[dec(0x657b) + 'p'] = function (a, b, c) { ... }` is `Math.clamp` - and
  // say so once a round.
  const index = hostWriteIndex(program, options.scans);
  // A write inside the slice's own statements is one every tier that runs
  // the slice makes for itself: the interpreter assigns `g.atob = polyfill`
  // on its sandbox global and calls the polyfill from then on, and refuses
  // `String.fromCharCode = f`, which its builtins do not take. Judged here
  // as a write of the program's, obfuscator.io 0.x's guarded polyfill -
  // `f['atob'] || (f['atob'] = ...)` inside the decoder - refused the decoder
  // at every preset. So the slice's writes are the interpreter's, and the
  // native tier, which reads shapes and runs nothing, may stand on such a
  // slice only with the interpreter's confirmation; see `sliceWrites`.
  const ownWrite = insideSources(slice);
  const writes = withoutWrites(index, ownWrite);
  let written = writtenHostName(slice, outside, writes);
  // A slice write that reaches a builtin the slice reads for certain is the
  // interpreter's alone. One that only may - the decoder's own cache on its
  // `arguments` object, `c[k] = h` with `c` the tree cannot read - is what
  // the interpreter runs when it can, and what the helper policy below
  // judges when it cannot: obfuscated2.js's rotation loop outruns any
  // budget, and its cache write stood as a helper write at balanced before
  // the slice's writes were told apart from the program's.
  const inside = writtenHostName(slice, outside, withoutWrites(index, (node) => !ownWrite(node)));
  const sliceWrites = inside && !inside.unread ? inside : undefined;
  const sliceMayWrite = inside && inside.unread ? inside : undefined;
  const aliases = (options.aliases ?? new AliasIndex(program.node)).of(roots);
  const names = [...new Set([...roots, ...aliases])];

  const samples = options.samples ?? collectSamples(program, names, options.maxSamples ?? DEFAULT_SAMPLE_LIMIT);
  // What a tier is proved on. A caller's list beyond it is the cross-check's
  // to compare, one site at a time, not `validate`'s to decode twice over:
  // the collector's whole pool is every site in the file, and the proof is
  // the head it made representative.
  const head = samples.slice(0, DEFAULT_SAMPLE_LIMIT);
  const tiers = config.techniqueOptions.stringDecoding.tiers;
  const built = new Map<EvaluatorTier, TierOutcome>();
  const buildTier = (tier: EvaluatorTier): TierOutcome => {
    const cached = built.get(tier);
    if (cached !== undefined) return cached;
    let outcome: TierOutcome;
    try {
      outcome = attemptTier(tier, slice, roots, config, samples, { strict, module }, note);
    } catch (error) {
      // A throw here is the slice's own initialisation failing before the
      // decoder was ever reached, and only one kind is silence. Running out
      // of budget says nothing about the program - the work was merely too
      // much - and it is the one construction failure a real file produces
      // (obfuscated2.js's rotation loop). Everything else is a verdict on
      // the slice: syntax the interpreter does not model, a value only the
      // run supplies (the clock, `Math.random()`, a user `toString`), an
      // interpreted throw. Collapsing those into silence is how a `class`
      // next to the table, or `new Date()` in the index arithmetic, got the
      // native tier's unchecked reading inlined with a warning attached.
      //
      // The budget is the step count and the clock that stands in for it on
      // a slow machine, and nothing else. The call-depth and memory guards
      // are limits too, and they used to take the same branch: `(function
      // r(n) { return r(n + 1) + 1 })(0)` in the rotation IIFE ran the
      // interpreter out of frames, the native match stood unchecked at
      // balanced, and the RangeError the input throws left with the pruned
      // machinery. A frame or a string the program cannot have is a crash
      // the program has, not work it has too much of.
      const budget = error instanceof StepLimitExceeded || error instanceof TimeLimitExceeded;
      const limit = !budget && error instanceof InterpreterLimitError;
      note(
        'warning',
        `Tier ${tier} ${budget ? 'ran out of budget' : limit ? 'hit a limit' : 'threw'} while building a decoder ` +
          `for ${roots[0]}: ${describe(error)}`,
      );
      outcome = {
        candidate: null,
        failed: budget ? 'budget' : limit ? 'limit' : 'refused',
        reason: describe(error),
        site: budget ? error.site : undefined,
      };
    }
    built.set(tier, outcome);
    return outcome;
  };
  // The first tier whose candidate the samples prove, asked once: by the
  // key oracle below, which reads a key with the tier the strings will come
  // from, and by the adoption after the guards, which takes the same answer.
  let choice: Candidate | undefined | null = null;
  const chooseTier = (): Candidate | undefined => {
    if (choice !== null) return choice;
    choice = undefined;
    for (const tier of tiers) {
      const { candidate, reason } = buildTier(tier);
      if (!candidate) {
        note('info', `Tier ${tier} did not recognise ${roots[0]}${reason ? `: ${reason}` : '.'}`);
        continue;
      }
      const verdict = validate(candidate, head);
      if (!verdict.ok) {
        note('warning', `Tier ${tier} produced an unusable decoder for ${roots[0]}: ${verdict.reason}`);
        continue;
      }
      choice = candidate;
      break;
    }
    return choice;
  };

  // A key computed by this very decoder - `Object[dec(0x1)](o)`, or by a
  // wrapper of it, `Object[w(0x1)](o)`, which is how obfuscator.io spells
  // every `Object.keys(o)` - is one the decoder's own tier can read, and the
  // call is then judged like any call under a name: a read, or a write to
  // what it names. The reading rests on the builtins being the builtins,
  // which is the very question; it is sound because every write is judged
  // on the same footing: were some write to replace a builtin the decoder
  // reads, the first such write in the run would be judged with the
  // builtins still whole, its key read as the program computes it, and
  // the replacement named. Reading the call as one the round could not open
  // deferred the decoder on its own key, which nothing else ever inlined.
  //
  // For a reflective call, where the key decides whether the call writes
  // at all, and for an assignment under such a key alike: `g[w(0x1)] = ...`
  // over the global object obfuscator.io's console stub reaches by the
  // idiom is `g.console = ...` once the wrapper's call is read, and a key
  // only this decoder can inline is otherwise waited on to the end of the
  // run, the decoder left encoded.
  const own = ownKeys(program, slice, names, options.scans);
  const ownKey = (deferrable: string): boolean => own.covers(deferrable) || names.includes(deferrable);
  if (written?.unread && written.deferrable !== undefined && own.covers(written.deferrable)) {
    const read: KeyOracle = (binding, name, args) => {
      const reached = own.reach(binding, name, args);
      if (!reached) return undefined;
      const candidate = chooseTier();
      if (!candidate) return undefined;
      try {
        const value = candidate.evaluate ? candidate.evaluate(reached.args) : candidate.decode(reached.args);
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      } finally {
        candidate.settle?.();
      }
    };
    written = writtenHostName(slice, outside, withoutWrites(index.rejudged(read, own.covers), ownWrite));
  }
  if (written) {
    // `String[k(0)] = ...` over a decoder `k` this round cannot read is a
    // write a later round spells out, once `k(0)` is inlined; taking it for a
    // helper now inlines 'ünï' where the program prints 'A'. The candidate is put up again instead, unless the
    // call is to this very decoder or a wrapper of it - the only key it
    // would wait on is its own, and its own tier has just been asked.
    //
    // Not at balanced for a reflective call under a method the tree cannot
    // read on an argument it cannot read either, `Object[k](x, ...)` with `x`
    // a parameter: waiting on the key is the conservative reading, and the
    // preset that assumes mainstream obfuscation takes the call for the
    // `Object.keys(x)` it is on a program value, below, and does not wait.
    if (
      written.unread &&
      written.deferrable !== undefined &&
      !ownKey(written.deferrable) &&
      (config.preset === 'conservative' || !written.quiet)
    ) {
      note(
        'warning',
        `Refusing ${roots[0]}: the key of ${written.what} is computed by a call to ${written.deferrable}, ` +
          `which this round cannot read; a later round may inline it, and the write is judged then.`,
      );
      options.reporter?.refused?.('unread-key');
      return undefined;
    }
    if (!written.unread || config.preset === 'conservative') {
      note(
        'warning',
        `Refusing to evaluate ${roots[0]}: the program assigns to ${written.what}, ${written.reason}` +
          (written.unread
            ? `, and the conservative preset inlines only what is proved. Use the balanced preset, ` +
              `which takes such a write for ${written.unread === 'object' ? 'an object' : 'a property'} the ` +
              `decoder never reads and says so.`
            : '.'),
      );
      return undefined;
    }
    // A reflective call under a method the tree cannot read, on an argument
    // it cannot read, `Object[k](x, ...)` with `x` a parameter or what a call
    // gave back, is `Object.keys(x)` on a program value in every mainstream
    // file, and the balanced preset - which assumes mainstream obfuscation,
    // as its documentation says - takes it for that without a line per
    // call. Every other unread write is disclosed, once a round.
    if (!written.quiet && writes.disclose(written.what)) {
      // Two things can be unreadable about a write, and the reader is told
      // which: `Math[k] = ...` is a key the tree cannot spell, `var S = String;
      // S = Math; S.round = ...` an object whose sources disagree.
      note(
        'warning',
        written.unread === 'object'
          ? `Taking the program's assignment to ${written.what} for a write to an object no decoder reads: ` +
              (written.object?.endsWith('(...)')
                ? `what ${written.object} gives back cannot be read, and if it is a `
                : `${written.object} is assigned from more than one source and cannot be read, and if it is a `) +
              `builtin they do, every string decoded here is the builtin's reading and not the program's. ` +
              `The conservative preset refuses instead.`
          : `Taking the program's assignment to ${written.what} for a property no decoder reads: the ` +
              `key cannot be read, and if it names one they do, every string decoded here is the ` +
              `builtin's reading and not the program's. The conservative preset refuses instead.`,
      );
    }
  }
  // The same write made by code compiled from a string is in no tree to
  // find. Which builtin such code can name is `analysis/string-code.ts`'s
  // question, asked here the way `strings.inline` asks it of the table, and
  // decided the same way: a preset that inlines the table despite string
  // code inlines the builtin's reading too, and says so.
  const spelled = stringCodeReach(outside, program, options);
  if (spelled) {
    const blame = spelled.blame ? ` The source is ${spelled.blame}, which this analysis cannot read.` : '';
    if (!config.techniqueOptions.stringDecoding.decodeDespiteStringCode) {
      note(
        'warning',
        `Refusing to evaluate ${roots[0]}: code compiled from a string can reach ${spelled.name} by ` +
          `name, and nothing proves it is still the builtin every tier would run.${blame}`,
      );
      return undefined;
    }
    note(
      'warning',
      `Evaluating ${roots[0]} anyway: code compiled from a string can reach ${spelled.name} by name, ` +
        `and every tier runs the builtin; if that code replaces it, every decoded string is the ` +
        `builtin's reading and not the program's. Set stringDecoding.decodeDespiteStringCode to ` +
        `false - the aggressive preset turns it on - to refuse instead.${blame}`,
    );
  }

  // No sample is a proof of nothing, and nothing is enough only when nothing
  // uses the decoder. A two-layer file whose outer layer proxies the inner
  // one had every call site read its argument out of an object map,
  // `w(U.c)`, and the rotation IIFE call push and shift through the same map
  // - so the recogniser saw no rotation, `validate` passed an empty list,
  // the cross-check was skipped on the same list, and an unrotated reading
  // stood with no evidence at all. The round after the maps were inlined
  // exposed a literal argument and inlined 'fn:' where the program prints
  // '2'. A use the samples could not read is a refusal; the reference
  // that makes it one is named so a caller can propose the candidate again
  // once a round has exposed something to read.
  if (samples.length === 0) {
    const use = unreadUse(slice, names);
    if (use) {
      note(
        'warning',
        `Refusing ${roots[0]}: it is ${use}, and no reference to it carries a literal argument or ` +
          `index, so no tier was verified against a single call site.`,
      );
      options.reporter?.refused?.('unverified');
      return undefined;
    }
  }

  let chosen = chooseTier();

  // The slice writes a builtin it reads (see `ownWrite`), and only a tier
  // that runs the slice knows what the builtin is from then on.
  const sliceWriteUnchecked = (how: string): boolean => {
    if (sliceWrites) {
      note(
        'warning',
        `Refusing to evaluate ${roots[0]}: the program assigns to ${sliceWrites.what} in the decoder's own slice, ` +
          `${sliceWrites.reason}, and ${how}; only the interpreter, which runs the slice, can say what that ` +
          `write leaves the name meaning.`,
      );
      return false;
    }
    if (!sliceMayWrite) return true;
    // The helper policy, for the write the interpreter could not run.
    if (config.preset === 'conservative') {
      note(
        'warning',
        `Refusing to evaluate ${roots[0]}: its slice assigns to ${sliceMayWrite.what}, ${sliceMayWrite.reason}, ${how}, ` +
          `and the conservative preset inlines only what is proved. Use the balanced preset, which takes such a write for ` +
          `${sliceMayWrite.unread === 'object' ? 'an object' : 'a property'} the decoder never reads and says so.`,
      );
      return false;
    }
    if (!sliceMayWrite.quiet && index.disclose(sliceMayWrite.what)) {
      note(
        'warning',
        `Taking the slice's assignment to ${sliceMayWrite.what} for a write to ` +
          `${sliceMayWrite.unread === 'object' ? 'an object' : 'a property'} no decoder reads: ${how}, and ` +
          `${sliceMayWrite.unread === 'object' ? `${sliceMayWrite.object} cannot be read` : 'the key cannot be read'}; if it ` +
          `names a builtin the decoder reads, every string decoded here is the builtin's reading and not the program's. ` +
          `The conservative preset refuses instead.`,
      );
    }
    return true;
  };
  const crossCheck = options.crossCheck ?? true;
  if (!chosen) {
    // Named first when the slice's own write is what the interpreter
    // refused on: `(function (K) { K.fromCharCode = ... })(String)` beside
    // the decoder is in the slice, and "no tier" says less than the write.
    if (sliceWrites) {
      sliceWriteUnchecked('no tier decoded it');
      return undefined;
    }
    note('warning', `No evaluation tier could decode ${roots[0]}.`);
    return undefined;
  }
  if (chosen.tier === 'native' && !(crossCheck && tiers.includes('interpreter'))) {
    if (!sliceWriteUnchecked('the native match is not checked by the interpreter')) return undefined;
  }
  // A rotation loop solved as arithmetic is run by the interpreter as its
  // solution, before the whole slice is tried: the loop is where a slice's
  // own initialisation outruns any budget; see `confirmPastRotation`.
  let pastRotation: Candidate | 'refused' | 'unchecked' = 'unchecked';
  if (crossCheck && chosen.tier === 'native' && tiers.includes('interpreter') && samples.length > 0 && chosen.solvedRotation) {
    pastRotation = confirmPastRotation(chosen, chosen.solvedRotation, slice, roots, config, samples, head, { strict, module }, note);
    if (pastRotation === 'refused') return undefined;
    if (pastRotation !== 'unchecked') chosen = pastRotation;
  }
  if (samples.length === 0) {
    // Nothing references the decoder, so no call site proved a tier and what
    // is adopted here is the machinery alone - the caller prunes it. The one
    // thing that vouches for a slice nothing calls is the interpreter running
    // every source statement to completion: a slice it cannot run, for want
    // of budget or of syntax it models, is a slice nothing has read, and
    // `throw new Error('tamper')` in its IIFE was pruned with it at every
    // preset, `"after"` printed where the program throws.
    if (!tiers.includes('interpreter')) {
      note(
        'warning',
        `Refusing ${roots[0]}: nothing references it, so no call site proves a tier, and only the ` +
          `interpreter tier, which is not enabled, could vouch for its machinery running to completion.`,
      );
      return undefined;
    }
    const check = buildTier('interpreter');
    if (check.failed) {
      note(
        'warning',
        `Refusing ${roots[0]}: nothing references it, so no call site proves a tier, and the interpreter ` +
          `${check.failed === 'budget' ? 'ran out of budget' : check.failed === 'limit' ? 'hit a limit' : 'refused'} ` +
          `running its machinery${check.reason ? ` (${check.reason})` : ''}; nothing else says what that machinery does.`,
      );
      return undefined;
    }
  } else if (crossCheck && chosen.tier === 'native' && tiers.includes('interpreter') && pastRotation === 'unchecked') {
    const check = buildTier('interpreter');
    if (check.runtime) {
      // Bound to the name and shape the native tier chose, not to whichever
      // root the interpreter could make a string out of: with roots
      // `[decoder, table]`, a decoder whose call the interpreter refuses would
      // otherwise be "confirmed" by reading `table[i]`, which is a different
      // function that merely takes the same argument.
      const mirror = bindRuntimeTo('interpreter', check.runtime, chosen, check.settle);
      const agreed = reconcile(chosen, mirror, samples, head, roots[0]!, note);
      if (!agreed) return undefined;
      chosen = agreed;
    } else if (check.failed === 'budget') {
      // The interpreter never got as far as the decoder because the slice's
      // own initialisation outran its budget, so there is no second opinion,
      // only the structural match. That is the native tier's documented
      // contract, and the warning says the check is missing.
      //
      // What ran out of budget was a loop, and the match may stand only when
      // every loop in the slice is one the recogniser read: the rotation loop
      // whose checksum it solved, the loops of the decoder body it classified.
      // A loop it did not read is where the budget went, and what that loop
      // did to the table is exactly what the run was going to say - a
      // rotation proxied through `w.call` and `C[w.push](C[w.shift]())`
      // reads as no rotation, and the unrotated entry was inlined at
      // balanced with "stands unchecked" attached. That is a refusal at
      // every preset, not a disclosure.
      if (!sliceWriteUnchecked('the interpreter ran out of budget evaluating the slice')) return undefined;
      const unread = chosen.modelled ? unmodelledLoop(slice.statements, chosen.modelled) : undefined;
      if (unread) {
        note(
          'warning',
          `Refusing ${roots[0]}: the "${chosen.evidence}" match could not be checked because the ` +
            `interpreter ran out of budget evaluating the slice, and the slice holds a loop the ` +
            `recogniser did not read (${spellStatement(unread)}${whereInSlice(slice, unread)}), so ` +
            `nothing says what that loop does to the table.`,
        );
        return undefined;
      }
      // Every loop read is not yet every step read. The budget is spent
      // where the interpreter was when it ran out, and only a loop the
      // recogniser modelled - the rotation loop, a loop of the decoder's own
      // body - spends it on nothing worse than work: the same budget gone
      // into a recursion, a callback, or a function the recogniser never
      // opened is a crash or a hang the match says nothing about. The
      // interpreter records the site with the error; what it recorded is
      // put to what the recogniser read.
      const astray = budgetAstray(check.site, chosen.modelled, slice);
      if (astray) {
        note(
          'warning',
          `Refusing ${roots[0]}: the "${chosen.evidence}" match could not be checked because the ` +
            `interpreter ran out of budget evaluating the slice, and the budget ran out ${astray}; only a ` +
            `loop the recogniser read may spend it, and what the program does there is not in the match.`,
        );
        return undefined;
      }
      // Whether the match may then stand is the preset's call. Conservative
      // promises output provably identical to the input, and a structural
      // match nothing confirmed is not a proof: the recognisers read `if
      // (flag) i = i - 1` as an offset of one whatever the flag, and the flag
      // is exactly what the run that ran out of budget was computing. Balanced
      // and aggressive take the reading and disclose it - obfuscated2.js's
      // rotation loop outruns any sensible budget and its match is right -
      // and conservative refuses, at the price of that file's strings.
      if (config.preset === 'conservative') {
        note(
          'warning',
          `Refusing ${roots[0]}: the "${chosen.evidence}" match could not be checked because the ` +
            `interpreter ran out of budget evaluating the slice, and the conservative preset inlines ` +
            `only what is proved. Raise sandbox.maxSteps, or use the balanced preset, which takes the ` +
            `unchecked match and says so.`,
        );
        return undefined;
      }
      note(
        'warning',
        `The "${chosen.evidence}" match for ${roots[0]} stands unchecked: the interpreter ` +
          `ran out of budget evaluating the slice and could not confirm it.`,
      );
    } else if (check.failed === 'limit') {
      // A frame or an allocation the interpreter would not make is one the
      // program makes: the call-depth guard is V8's RangeError a few
      // thousand frames early, the string guard its "Invalid string length".
      // Neither is a loop the recogniser read, and neither is silence about
      // the program - it is where the program crashes, at every preset.
      note(
        'warning',
        `Refusing ${roots[0]}: the "${chosen.evidence}" match cannot be checked because the ` +
          `interpreter hit a limit evaluating the slice (${check.reason ?? 'no reason recorded'}); ` +
          `a call depth or an allocation is not a loop the recogniser read, and the crash the program ` +
          `meets there would leave with the machinery.`,
      );
      return undefined;
    } else {
      // The interpreter refused the slice outright. The native recognisers
      // read shapes, not values - `if (flag) i = i - 1` is an offset of one
      // to them whatever the flag is, and the flag is what the slice could
      // not compute - and the interpreter was the only thing standing
      // between that reading and the output. With it gone the match is not
      // "unchecked", it is uncheckable, and a decoder nothing can check is a
      // decoder nothing should inline. A write of the slice's own to a
      // builtin it reads is the likeliest thing refused, and is named first.
      if (sliceWrites && !sliceWriteUnchecked('the interpreter refused the slice')) return undefined;
      note(
        'warning',
        `Refusing ${roots[0]}: the "${chosen.evidence}" match cannot be checked because the ` +
          `interpreter rejected the slice (${check.reason ?? 'no reason recorded'}), and a ` +
          `structural match alone does not say what the program computes.`,
      );
      return undefined;
    }
  }

  return {
    name: chosen.name,
    kind: chosen.kind,
    tier: chosen.tier,
    decode: instrument(chosen, config, note),
    aliases,
    declarations: slice.sources,
  };
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

interface Candidate {
  tier: EvaluatorTier;
  kind: StringSource['kind'];
  name: string;
  evidence: string;
  decode(args: ArgumentTuple): string | undefined;
  /**
   * What the call site evaluates to before `decode` narrows it to a string.
   * Only the runtime-backed tiers have one; a disagreement report names the
   * number or array the decoder actually produced, not the `undefined` the
   * narrowing left.
   */
  evaluate?(args: ArgumentTuple): unknown;
  /**
   * Surface what the runtime learned since the last call - the interpreter's
   * fidelity notes. Called after every batch of evaluations, because a decoder
   * that stringifies itself only on its fortieth call is not compromised on
   * the four probes that built it.
   */
  settle?: () => void;
  /** What the native recogniser read of the slice; see `NativeDecoder.modelled`. */
  modelled?: ModelledCode;
  /** The rotation loop solved as arithmetic; see `NativeDecoder.solvedRotation`. */
  solvedRotation?: SolvedRotation;
}

/**
 * What a tier had to say about the decoder.
 *
 * A null candidate means four different things and the cross-check has to
 * tell them apart. With a `runtime` present it is a verdict: the interpreter
 * built the slice, called the root on real call sites, and got no string
 * back - a throw, a hang, a value that depends on the run, or simply not a
 * string. Without one the slice's own initialisation failed and the decoder
 * was never reached, and `failed` says how: `budget` is silence, the work was
 * too much and nothing is known either way, and `site` says where the work
 * was; `limit` is the call-depth or memory guard, which is where the program
 * crashes rather than work it has too much of; `refused` is a verdict on the
 * slice itself - syntax outside the interpreter's subset, a value only the
 * run can supply, an interpreted throw. The runtime is kept so the
 * cross-check can put its own question to it rather than reuse an answer
 * given to a different one.
 */
interface TierOutcome {
  candidate: Candidate | null;
  runtime?: Runtime;
  /** The runtime's `settle`, for a candidate bound to it later; see `Candidate.settle`. */
  settle?: () => void;
  /** Why there is no candidate: what the decoder did on the probes, or what stopped the build. */
  reason?: string;
  /** Set when the tier could not be built at all; see above. */
  failed?: 'budget' | 'limit' | 'refused';
  /** Where the budget ran out, for `failed: 'budget'`; see `ExhaustionSite`. */
  site?: ExhaustionSite;
}

function attemptTier(
  tier: EvaluatorTier,
  slice: SliceResult,
  roots: readonly string[],
  config: ResolvedConfig,
  samples: readonly ArgumentTuple[],
  program: { strict: boolean; module: boolean },
  note: (severity: Severity, message: string) => void,
): TierOutcome {
  switch (tier) {
    case 'native': {
      const decoder = recogniseNativeDecoder(slice, roots);
      if (!decoder) return { candidate: null };
      return {
        candidate: {
          tier: 'native',
          kind: decoder.kind,
          name: decoder.name,
          evidence: decoder.evidence,
          decode: (args) => decoder.decode(args),
          modelled: decoder.modelled,
          solvedRotation: decoder.solvedRotation,
        },
      };
    }

    case 'interpreter': {
      const machine = createInterpreter(slice.statements, {
        strict: program.strict,
        module: program.module,
        maxSteps: config.sandbox.maxSteps,
        timeoutMs: config.sandbox.timeoutMs,
        maxCallDepth: INTERPRETER_MAX_DEPTH,
      });
      // The slice reaches the interpreter as clones without source offsets, so
      // a decoder that reads its own text gets a reprint of its AST, not the
      // program's bytes. For a `selfDefending` build the verdict rests on that
      // reprint matching what the obfuscator emitted - usually true for
      // compact output, never proven - and the reader is owed the fact
      // whenever it happens: after the probes here, and after every later
      // batch through `Candidate.settle`, since a decoder may not stringify
      // itself until a sample the probes never reached.
      const settle = fidelityNotes(machine, roots[0]!, note);
      const outcome = bindRuntime('interpreter', machine, roots, samples, settle);
      settle();
      return outcome;
    }

    case 'sandbox': {
      if (!config.sandbox.allowExecution) return { candidate: null };
      const handle = createSandbox(slice, {
        timeoutMs: config.sandbox.timeoutMs,
        allowExecution: true,
      });
      return bindRuntime('sandbox', handle, roots, samples);
    }

    default:
      return { candidate: null };
  }
}

/** The subset of the interpreter and sandbox handles the dispatcher relies on. */
interface Runtime {
  read(name: string): unknown;
  call(name: string, args: ArgumentTuple): unknown;
}

/**
 * A poll of the interpreter's fidelity notes: each new one is reported once,
 * in the order it was made. `diagnostics()` is the same growing array on every
 * call, so a poll after every decode costs a length comparison.
 */
function fidelityNotes(
  machine: Interpreter,
  root: string,
  note: (severity: Severity, message: string) => void,
): () => void {
  let reported = 0;
  return () => {
    const messages = machine.diagnostics();
    for (; reported < messages.length; reported++) {
      note('info', `Interpreter fidelity for ${root}: ${messages[reported]}`);
    }
  };
}

/**
 * Work out how a root name is *used* - a call or an index - by trying both and
 * keeping whichever produces a string.
 *
 * Asking rather than assuming matters because the two shapes are not
 * distinguishable from the declaration alone: obfuscator.io's array accessor is
 * a function that returns the array, and its decoder is a function that returns
 * a string, and only calling them tells you which is which.
 */
function bindRuntime(
  tier: EvaluatorTier,
  runtime: Runtime,
  roots: readonly string[],
  samples: readonly ArgumentTuple[],
  settle?: () => void,
): TierOutcome {
  const probes: readonly ArgumentTuple[] = samples.length > 0 ? samples.slice(0, 4) : [[0], [1]];
  // The first thing that went wrong is the one worth reporting: a refusal or
  // a throw on the first probe explains every probe after it.
  let reason: string | undefined;

  for (const name of roots) {
    for (const probe of probes) {
      let value: unknown;
      try {
        value = runtime.call(name, probe);
      } catch (error) {
        // Not callable, or not callable with this shape. Try the next probe.
        reason ??= `${name}(${probe.join(', ')}) threw: ${describe(error)}`;
        continue;
      }
      if (typeof value === 'string') {
        return { runtime, settle, candidate: callCandidate(tier, runtime, name, settle) };
      }
      reason ??= `${name}(${probe.join(', ')}) returned ${typeOfValue(value)}, not a string`;
    }

    const table = indexCandidate(tier, runtime, name, settle);
    if (table) return { runtime, settle, candidate: table };
  }
  return { runtime, settle, candidate: null, reason };
}

/**
 * The interpreter's answer to exactly the question the native tier answered:
 * this name, used this way. A table that is not an array is null; a call that
 * throws is left to throw, because at cross-check time a throw is the verdict.
 */
function bindRuntimeTo(
  tier: EvaluatorTier,
  runtime: Runtime,
  shape: Candidate,
  settle?: () => void,
): Candidate | null {
  return shape.kind === 'wrapper-call'
    ? callCandidate(tier, runtime, shape.name, settle)
    : indexCandidate(tier, runtime, shape.name, settle);
}

function callCandidate(tier: EvaluatorTier, runtime: Runtime, name: string, settle?: () => void): Candidate {
  const evaluate = (args: ArgumentTuple): unknown => runtime.call(name, args);
  return {
    tier,
    kind: 'wrapper-call',
    name,
    evidence: `${tier} call to ${name}`,
    decode: (args) => asString(evaluate(args)),
    evaluate,
    settle,
  };
}

function indexCandidate(
  tier: EvaluatorTier,
  runtime: Runtime,
  name: string,
  settle?: () => void,
): Candidate | null {
  let value: unknown;
  try {
    value = runtime.read(name);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || !value.some((entry) => typeof entry === 'string')) return null;
  const values = value as unknown[];
  const evaluate = (args: ArgumentTuple): unknown => {
    const index = Number(args[0]);
    return Number.isFinite(index) ? values[index] : undefined;
  };
  return {
    tier,
    kind: 'array-index',
    name,
    evidence: `${tier} index into ${name} (${values.length} entries)`,
    decode: (args) => asString(evaluate(args)),
    evaluate,
    settle,
  };
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** A value as a diagnostic should show it: strings quoted, primitives as written, the rest by kind. */
function showValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object' || typeof value === 'function') return typeOfValue(value);
  return `the ${typeof value} ${String(value)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A decoder is only trusted once it has decoded real call sites.
 *
 * A recogniser that matched the wrong algorithm still returns *something* for
 * every index - usually mojibake, occasionally a plausible word. The cheap
 * checks below (right type, mostly non-empty, deterministic across two calls)
 * catch the overwhelming majority of those before a single literal is inlined.
 */
function validate(
  candidate: Candidate,
  samples: readonly ArgumentTuple[],
): { ok: true } | { ok: false; reason: string } {
  if (samples.length === 0) {
    // Nothing references the decoder, so there is nothing to get wrong.
    return { ok: true };
  }
  try {
    return validateSamples(candidate, samples);
  } finally {
    candidate.settle?.();
  }
}

function validateSamples(
  candidate: Candidate,
  samples: readonly ArgumentTuple[],
): { ok: true } | { ok: false; reason: string } {
  let decoded = 0;
  let printable = 0;
  for (const args of samples) {
    let first: string | undefined;
    try {
      first = candidate.decode(args);
    } catch (error) {
      return { ok: false, reason: `threw on (${args.join(', ')}): ${describe(error)}` };
    }
    if (typeof first !== 'string') continue;

    const second = candidate.decode(args);
    if (second !== first) {
      return { ok: false, reason: `not stable across two calls for (${args.join(', ')})` };
    }
    decoded++;
    if (isPlausibleString(first)) printable++;
  }

  if (decoded === 0) return { ok: false, reason: 'no sample call site decoded to a string' };
  if (decoded * 2 < samples.length) {
    return { ok: false, reason: `only ${decoded}/${samples.length} call sites decoded` };
  }
  if (printable * 2 < decoded) {
    return { ok: false, reason: `${decoded - printable}/${decoded} results were not plausible text` };
  }
  return { ok: true };
}

/**
 * Cheap sanity filter on decoder output. Control characters other than the
 * usual whitespace are the tell-tale of a wrong key or a wrong rotation; real
 * obfuscated strings are identifiers, URLs, messages and property names.
 */
function isPlausibleString(value: string): boolean {
  if (value.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0xfffd) suspicious++;
  }
  return suspicious * 4 <= value.length;
}

// ---------------------------------------------------------------------------
// Cross-checking
// ---------------------------------------------------------------------------

/**
 * Run the native recogniser against the interpreter on a handful of call sites.
 *
 * They compute the same thing by completely different routes, so agreement is
 * strong evidence and disagreement is proof that one of them is wrong. On a
 * disagreement the interpreter wins - it derives behaviour from the
 * decoder's own AST, whereas the native tier asserts that the AST *is* a known
 * algorithm, and that assertion has just been falsified - but only if the
 * interpreter's own output validates. When neither can be trusted there is no
 * answer to return: the native candidate has just been shown wrong on a real
 * call site, and handing it back anyway would inline the very strings the
 * diagnostic says are untrustworthy.
 *
 * The interpreter producing *no string* for a call site is not neutral either.
 * It ran the decoder's own code; a call that threw, hung, returned a
 * non-string or reached a value only the real run can supply is a call the
 * native tier has claimed to understand, and the claim did not survive
 * checking. A `throw` planted ahead of the `return`, a table shadowed by a
 * later same-named declaration and a `Math.random()` in the index are all
 * shapes the recognisers read straight past; the interpreter is the net under
 * them, and a net with a hole where the decoder fell through is no net.
 *
 * Which call sites get compared is decided by what the native tier made of
 * them, never by where they sit in the file. The check used to stop at the
 * sixteenth sample in traversal order, and a rotation IIFE contributes a dozen
 * before the program's own first call: a decoder read as "base64, latin1"
 * that was really UTF-8 sailed through on twelve ASCII checksum strings and
 * four ASCII program strings, and the one non-ASCII string - the only sample
 * that could have caught it - was the seventeenth. A check that can be
 * defeated by ordering is not a check.
 */
function reconcile(
  chosen: Candidate,
  other: Candidate | null,
  samples: readonly ArgumentTuple[],
  head: readonly ArgumentTuple[],
  root: string,
  note: (severity: Severity, message: string) => void,
): Candidate | undefined {
  if (!other) {
    note(
      'warning',
      `Refusing ${root}: the "${chosen.evidence}" recogniser read ${chosen.name} as a table, ` +
        `but evaluating the slice does not produce an array under that name.`,
    );
    return undefined;
  }
  const checked = crossCheckSet(chosen, samples);
  // Proved on the same head the native tier was, so that a fall-back to the
  // interpreter rests on the same evidence its rival did; the comparison
  // below is what covers the rest of the list.
  const otherIsUsable = validate(other, head).ok;
  try {
    return compare(chosen, other, otherIsUsable, checked, root, note);
  } finally {
    other.settle?.();
  }
}

/**
 * The native match confirmed by the interpreter past the rotation loop.
 *
 * The loop is the one place a slice's own initialisation outruns any
 * budget: every turn decodes a string per checksum term, and the turns to
 * the solution - 478 over 11 terms of rc4 on obfuscated2.js, hundreds over
 * a dozen in a chained-wrapper build - are tens of millions of steps before
 * a single call site is reached. Run whole, the slice fails on budget, the
 * match stands unchecked at balanced and is refused at conservative, and
 * the decoder body, its cache write and its table read go unconfirmed for
 * want of a loop the recogniser solved as arithmetic. So the slice is run
 * with the loop stood in for by its solution - the loop's own
 * `x.push(x.shift())`, `shifts` times over - and the interpreter is asked
 * about the head, an even spread of the sites, and every term of the
 * checksum. Agreement on the terms is the loop's stopping condition
 * confirmed at the solution; that no earlier turn stops it rests on the
 * decoder being the template the recogniser read, which is what every site
 * past the head rests on already. The check spends at most one budget: the
 * head measures a call, and the spread is cut to what the rest affords.
 *
 * The candidate when the interpreter agreed; `'refused'` when it disagreed,
 * since its reading over a rotation of the recogniser's own choosing is no
 * fallback; `'unchecked'` when it could not finish, or the slice holds a
 * loop the recogniser did not read, where the whole slice is then run and
 * says so itself.
 */
function confirmPastRotation(
  chosen: Candidate,
  solved: SolvedRotation,
  slice: SliceResult,
  roots: readonly string[],
  config: ResolvedConfig,
  samples: readonly ArgumentTuple[],
  head: readonly ArgumentTuple[],
  program: { strict: boolean; module: boolean },
  note: (severity: Severity, message: string) => void,
): Candidate | 'refused' | 'unchecked' {
  if (!chosen.modelled || unmodelledLoop(slice.statements, chosen.modelled)) return 'unchecked';
  const statements = withLoopSolved(slice.statements, solved);
  if (!statements) return 'unchecked';
  // A build that fails is silent here: the whole slice is run next, fails
  // the same way, and says so once. A build that stands keeps its fidelity
  // notes, which are about the decoder and not about the loop.
  const kept: { severity: Severity; message: string }[] = [];
  let attempt: TierOutcome;
  try {
    attempt = attemptTier('interpreter', { ...slice, statements }, roots, config, samples, program, (severity, message) =>
      kept.push({ severity, message }),
    );
  } catch {
    return 'unchecked';
  }
  if (!attempt.runtime) return 'unchecked';
  const mirror = bindRuntimeTo('interpreter', attempt.runtime, chosen, attempt.settle);
  if (!mirror) return 'unchecked';
  for (const { severity, message } of kept) note(severity, message);
  const root = roots[0]!;
  const disagree = (args: ArgumentTuple, read: string, outcome: string): void =>
    note(
      'error',
      `Native and interpreter tiers disagree on ${root}(${args.join(', ')}): native ${read}, the interpreter ${outcome}, ` +
        `run past the rotation loop with the ${solved.shifts} shift(s) the recogniser solved. The "${chosen.evidence}" ` +
        `recogniser is wrong for this input, and the interpreter's reading rests on that rotation, so it is no fallback; ` +
        `the references are left encoded.`,
    );
  const counted = attempt.runtime as Partial<Pick<Interpreter, 'steps'>>;
  const steps = (): number => (typeof counted.steps === 'function' ? counted.steps() : 0);
  try {
    const before = steps();
    const onHead = agreeOn(chosen, mirror, head, true, disagree);
    if (onHead !== 'agreed') return onHead === 'budget' ? 'unchecked' : 'refused';
    const spent = steps() - before;
    const afford =
      typeof counted.steps === 'function' && head.length > 0
        ? Math.floor(Math.max(0, config.sandbox.maxSteps - spent) / Math.max(1, spent / head.length))
        : CROSS_CHECK_LIMIT;
    const limit = Math.max(head.length, Math.min(CROSS_CHECK_LIMIT, afford));
    const rest = crossCheckSet(chosen, samples, limit).filter((args) => !head.includes(args));
    const seen = new Set([...head, ...rest].map(cacheKey));
    const terms = solved.terms.filter((args) => !seen.has(cacheKey(args)));
    const onRest = agreeOn(chosen, mirror, [...rest, ...terms], true, disagree);
    if (onRest !== 'agreed') return onRest === 'budget' ? 'unchecked' : 'refused';
    note(
      'info',
      `Confirmed the "${chosen.evidence}" match for ${root} by the interpreter on ${head.length + rest.length} of ` +
        `${samples.length} call site(s) and on the ${solved.terms.length} term(s) of the rotation checksum, run past the ` +
        `rotation loop with the ${solved.shifts} shift(s) it solves to: every turn of the loop decodes ${solved.terms.length} ` +
        `string(s), and the turns to the solution are not a budget the interpreter is given.`,
    );
    return chosen;
  } finally {
    mirror.settle?.();
  }
}

/**
 * The sites put to both tiers, in order, until one disagrees. A budget the
 * interpreter runs out of is its own answer where `budgetIsSilence`, and a
 * throw like any other where it is not: the whole slice's check reads a
 * budget spent on one site as the program's, past the loop it is the
 * check's.
 */
function agreeOn(
  chosen: Candidate,
  other: Candidate,
  sites: readonly ArgumentTuple[],
  budgetIsSilence: boolean,
  disagree: (args: ArgumentTuple, read: string, outcome: string) => void,
): 'agreed' | 'disagreed' | 'budget' {
  for (const args of sites) {
    // Either decode can throw here: the native one on a site past the head
    // it was proved on, the interpreter's on any. A throw is an answer - the
    // program throws there, or the recogniser's algorithm does not take the
    // argument - that no string can equal.
    let native: string | undefined;
    let read: string;
    try {
      native = chosen.decode(args);
      read = `produced ${showValue(native)}`;
    } catch (error) {
      read = `threw (${describe(error)})`;
    }
    let interpreted: string | undefined;
    let outcome: string;
    try {
      // `evaluate` is the value before narrowing, so the report says "the
      // number 2" or "undefined" for what the decoder actually returned.
      const value = other.evaluate ? other.evaluate(args) : other.decode(args);
      interpreted = asString(value);
      outcome = `produced ${showValue(value)}`;
    } catch (error) {
      if (budgetIsSilence && (error instanceof StepLimitExceeded || error instanceof TimeLimitExceeded)) return 'budget';
      outcome = `threw (${describe(error)})`;
    }
    if (native === interpreted) continue;
    disagree(args, read, outcome);
    return 'disagreed';
  }
  return 'agreed';
}

/**
 * The statements with the solved loop stood in for by its own shuffle run
 * `shifts` times, the statement around it cloned; nothing when the loop is
 * not among them.
 */
function withLoopSolved(statements: readonly t.Statement[], solved: SolvedRotation): t.Statement[] | undefined {
  const index = statements.findIndex((statement) => holds(statement, solved.loop));
  if (index < 0) return undefined;
  const counter = t.identifier(freshName(statements[index]!, 'turn'));
  const turns = t.forStatement(
    t.variableDeclaration('var', [t.variableDeclarator(counter, t.numericLiteral(0))]),
    t.binaryExpression('<', t.cloneNode(counter), t.numericLiteral(solved.shifts)),
    t.updateExpression('++', t.cloneNode(counter)),
    t.expressionStatement(t.cloneNode(solved.shuffle, true)),
  );
  const replaced = [...statements];
  replaced[index] = cloneReplacing(statements[index]!, solved.loop, turns);
  return replaced;
}

/** A name no identifier under `root` spells: `base`, or `base` with a count. */
function freshName(root: t.Node, base: string): string {
  const taken = new Set<string>();
  const stack: t.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'Identifier') taken.add(node.name);
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  let name = base;
  for (let count = 2; taken.has(name); count++) name = `${base}${count}`;
  return name;
}

/** A copy of `node` with `target` under it replaced by `replacement`; every other node is copied, none shared. */
function cloneReplacing<T extends t.Node>(node: T, target: t.Node, replacement: t.Node): T {
  if (node === target) return replacement as T;
  const copy = t.cloneNode(node, false) as unknown as Record<string, unknown>;
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      copy[key] = child.map((item) => (item && typeof (item as t.Node).type === 'string' ? cloneReplacing(item as t.Node, target, replacement) : item));
    } else if (child && typeof (child as t.Node).type === 'string') {
      copy[key] = cloneReplacing(child as t.Node, target, replacement);
    }
  }
  return copy as unknown as T;
}

/**
 * The call sites the interpreter is asked about.
 *
 * All of them, whenever the list fits the budget. `strings.discover` hands
 * over every distinct site a candidate has, so a decoder wrong at any one of
 * them is compared at that one; a list past the budget is thinned by what the
 * native reading of each site looks like, not by position. Its head - the
 * first `DEFAULT_SAMPLE_LIMIT`, which the collector made representative and
 * the native tier was proved on - is kept whole; then every site whose
 * native string carries a non-ASCII character or a `%`, because a byte-mode
 * or percent-decoding misread shows nowhere else; then sites spread evenly
 * across the argument range, one per distinct native string, so the extremes
 * of the index space and a decoder that only goes wrong past some threshold
 * are covered rather than the first sixteen call sites in the file.
 */
function crossCheckSet(chosen: Candidate, samples: readonly ArgumentTuple[], limit = CROSS_CHECK_LIMIT): readonly ArgumentTuple[] {
  if (samples.length <= limit) return samples;

  const readings = samples.map((args) => ({ args, native: nativeReading(chosen, args) }));
  const byArgument = [...readings].sort((a, b) => {
    const left = Number(a.args[0]);
    const right = Number(b.args[0]);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return cacheKey(a.args) < cacheKey(b.args) ? -1 : 1;
  });

  const chosenSet = new Set(readings.slice(0, DEFAULT_SAMPLE_LIMIT));

  const telling = byArgument.filter(
    (r) => !chosenSet.has(r) && r.native !== undefined && TELLING_OUTPUT.test(r.native),
  );
  for (const reading of spread(telling, limit - chosenSet.size)) chosenSet.add(reading);

  const covered = new Set<string | undefined>();
  for (const reading of chosenSet) covered.add(reading.native);
  const distinct = byArgument.filter((r) => {
    if (chosenSet.has(r) || covered.has(r.native)) return false;
    covered.add(r.native);
    return true;
  });
  for (const reading of spread(distinct, limit - chosenSet.size)) chosenSet.add(reading);

  return [...chosenSet].map((r) => r.args);
}

/**
 * The native tier's string for a site, or nothing. `validate` ran it over the
 * head without a throw; a site past the head is one it has not seen, and a
 * throw there is a reading of no string, which the comparison then judges.
 */
function nativeReading(chosen: Candidate, args: ArgumentTuple): string | undefined {
  try {
    return chosen.decode(args);
  } catch {
    return undefined;
  }
}

/** A non-ASCII character or a percent sign: where a byte-mode misread is visible. */
const TELLING_OUTPUT = /[^\x00-\x7f]|%/;

/** `count` elements of `list` at even intervals, the first and last included. */
function spread<T>(list: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (list.length <= count) return [...list];
  const step = count === 1 ? 0 : (list.length - 1) / (count - 1);
  const picked: T[] = [];
  for (let k = 0; k < count; k++) picked.push(list[Math.round(k * step)]!);
  return picked;
}

function compare(
  chosen: Candidate,
  other: Candidate,
  otherIsUsable: boolean,
  samples: readonly ArgumentTuple[],
  root: string,
  note: (severity: Severity, message: string) => void,
): Candidate | undefined {
  const verdict = agreeOn(chosen, other, samples, false, (args, read, outcome) =>
    note(
      'error',
      `Native and interpreter tiers disagree on ${root}(${args.join(', ')}): ` +
        `native ${read}, the interpreter ${outcome}. ` +
        `The "${chosen.evidence}" recogniser is wrong for this input. ` +
        (otherIsUsable
          ? 'Falling back to the interpreter, which derives its answer from the decoder itself.'
          : 'The interpreter did not validate either, so neither answer can be trusted; ' +
            'the references are left encoded.'),
    ),
  );
  if (verdict === 'agreed') return chosen;
  return otherIsUsable ? other : undefined;
}

// ---------------------------------------------------------------------------
// Memoization and budget
// ---------------------------------------------------------------------------

/**
 * Wrap the chosen decoder with the caller's memoization and call budget.
 *
 * Memoization is not a micro-optimisation here: a decoder is called once per
 * *reference*, and a large bundle references the same few hundred strings tens
 * of thousands of times.
 */
function instrument(
  candidate: Candidate,
  config: ResolvedConfig,
  note: (severity: Severity, message: string) => void,
): (args: ArgumentTuple) => string | undefined {
  const limit = config.techniqueOptions.stringDecoding.maxDecodeCalls;
  let calls = 0;
  let exhausted = false;

  const guarded = (args: ArgumentTuple): string | undefined => {
    if (exhausted) return undefined;
    if (++calls > limit) {
      exhausted = true;
      note('warning', `Decode budget of ${limit} calls exhausted; remaining references left encoded.`);
      return undefined;
    }
    try {
      return candidate.decode(args);
    } catch {
      return undefined;
    } finally {
      // Inline-time decodes reach call sites the samples never did; a note
      // first raised on one of them is raised now, not never.
      candidate.settle?.();
    }
  };

  if (!config.performance.memoize) return guarded;

  const cache = new Map<string, string | undefined>();
  return (args) => {
    const key = cacheKey(args);
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit;
    const value = guarded(args);
    cache.set(key, value);
    return value;
  };
}

/**
 * A collision-free key for an argument tuple. Type-tagged so the numeric index
 * `1` and the key string `'1'` - which decode to different things - never share
 * a cache entry.
 */
function cacheKey(args: ArgumentTuple): string {
  if (args.length === 1) {
    const only = args[0];
    return typeof only === 'number' ? `#${only}` : `$${only}`;
  }
  return JSON.stringify(args);
}

// ---------------------------------------------------------------------------
// Program scanning
// ---------------------------------------------------------------------------

/**
 * Names the slice genuinely reads from outside itself.
 *
 * Babel's scope pass answers "which identifiers resolve to no binding", which is
 * the question that actually matters. Intersected with the slicer's `freeNames`
 * it keeps the allowlist defined in exactly one place - a name is an escape
 * only if it is both unbound *and* one the slicer declined to allow - and put
 * to the decoder's scope it says which allowed names the program has rebound.
 */
function hostReferences(slice: SliceResult): string[] {
  const file = t.file(t.program(slice.statements.map((statement) => t.cloneNode(statement, true, true))));
  let names: string[] = [];
  traverse(file, {
    Program(path) {
      names = Object.keys(path.scope.globals);
      path.stop();
    },
  });
  return names.sort();
}

/**
 * The first of `outside` that is a binding, not the global, where the decoder
 * is declared - with what kind of binding it is, for the refusal.
 *
 * The question is put to the scope holding the slice's own statements, not to
 * the decoder's function scope: a parameter of the decoder is cloned into the
 * slice with it and never reaches `outside`, while a same-named parameter of
 * the rotation IIFE beside it does not shadow the decoder's reference. Every
 * source of a slice is a unit of that one scope, so the first stands for all.
 * `arguments` is in the allowlist and is never a binding; it resolves the way
 * the slicer expects unless the program declares it, which is a shadow too.
 */
function shadowedHostName(
  slice: SliceResult,
  outside: readonly string[],
  annexB: AnnexBIndex,
): { name: string; what: string } | undefined {
  const anchor = slice.sources[0];
  if (!anchor) return undefined;
  const scope = anchor.isScope() ? anchor.scope.parent : anchor.scope;
  for (const name of outside) {
    const binding = scope.getBinding(name);
    if (binding) return { name, what: describeBinding(binding) };
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (annexB.hoistedIn(current.path.node, name)) {
        return { name, what: 'a function declared in a block' };
      }
    }
  }
  return undefined;
}

/**
 * Names Annex B.3.3 gives a second, `var`-like binding in the function or
 * program scope around a sloppy block: a function declared in a block, an
 * `if` arm, a `switch` case or under a label, anywhere in the body short of a
 * nested function. Babel registers such a declaration on the block's own
 * scope, so a `getBinding` from the decoder's scope walks straight past it
 * - and the program calls it. Keyed by the Function or Program node whose
 * scope receives the binding; empty for a strict program, and a function
 * with its own `'use strict'`, like a class body, is left out with everything
 * in it.
 *
 * One walk of the program per discovery round, kept on the round's scan
 * cache the way `AliasIndex` is passed in: a bundle of two thousand modules
 * proposes a candidate per module, and a walk per candidate would be the
 * quadratic cost `scans` exists to avoid.
 */
class AnnexBIndex {
  private readonly names = new Map<t.Node, Set<string>>();

  constructor(program: t.Program, strict: boolean) {
    if (strict) return;
    for (const statement of program.body) this.collect(statement, program, true);
  }

  hoistedIn(owner: t.Node, name: string): boolean {
    return this.names.get(owner)?.has(name) ?? false;
  }

  /** `top` is whether `node` is a statement of `owner`'s own body, where a function declaration is not Annex B's. */
  private collect(node: t.Node, owner: t.Node, top: boolean): void {
    if (t.isClass(node)) return;
    if (t.isFunction(node)) {
      // The declaration is the sloppy block's to hoist whatever its own body
      // says; the directive only decides whether the body is walked.
      if (t.isFunctionDeclaration(node) && !top && node.id) this.record(owner, node.id.name);
      if (t.isBlockStatement(node.body)) {
        if (node.body.directives.some(isUseStrict)) return;
        for (const param of node.params) this.collect(param, node, false);
        for (const statement of node.body.body) this.collect(statement, node, true);
      } else {
        for (const param of node.params) this.collect(param, node, false);
        this.collect(node.body, node, false);
      }
      return;
    }
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as t.Node).type === 'string') this.collect(item as t.Node, owner, false);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        this.collect(child as t.Node, owner, false);
      }
    }
  }

  private record(owner: t.Node, name: string): void {
    let names = this.names.get(owner);
    if (!names) {
      names = new Set();
      this.names.set(owner, names);
    }
    names.add(name);
  }
}

/** The round's index, built once per scan cache; a caller without one pays for its own walk. */
const annexBByRound = new WeakMap<StatementScanCache, AnnexBIndex>();

function annexBIndex(
  program: NodePath<t.Program>,
  strict: boolean,
  scans: StatementScanCache | undefined,
): AnnexBIndex {
  return perRound(scans, annexBByRound, () => new AnnexBIndex(program.node, strict));
}

/**
 * A whole-program fact kept for the round, keyed the way `AnnexBIndex` is:
 * the scan cache lives exactly as long as the tree it was built over, so a
 * fact hung on it is never read against a tree that has since changed. A
 * caller with no cache pays for its own walk.
 */
function perRound<T>(
  scans: StatementScanCache | undefined,
  cache: WeakMap<StatementScanCache, T>,
  build: () => T,
): T {
  if (!scans) return build();
  let value = cache.get(scans);
  if (value === undefined) {
    value = build();
    cache.set(scans, value);
  }
  return value;
}
/**
 * Every write the program makes as though to a global, by the name written
 * and the property path under it: a bare assignment to a name no binding
 * declares is the name with no path; `String.fromCharCode = ...` is `String`
 * with `[fromCharCode]`; a write through `globalThis`, `window`, `self`,
 * `global` or `this` is the first property's, `[...]` after it. A key that is
 * not an identifier or a string literal is `*`, and a write whose first key
 * under the global object is such a key - `window[k] = ...` - is to the
 * unknown name `*`. Updates, deletes, destructuring targets and `for` heads
 * count as assignments, because each is one.
 *
 * Which names matter is the caller's question - the ones a slice takes for
 * builtins - so the index records writes under any name and answers by
 * name, in program order. `this` is taken as the global object wherever it
 * appears, since a function's `this` is whatever its caller makes it, with
 * the one exception of `this[k] = ...`, which every constructor writes and is
 * read as the global's only at the top of the program.
 *
 * Two readers answer every question of a route. What a call invokes is
 * `invocation` - `?.()`, `.call`, `.apply`, `.bind()()`, `Reflect.apply`,
 * `Function.prototype.call.call`, a sequence, an `await`, either arm of
 * a conditional or a logical - with `calleeSpellings` naming the callee
 * before scope is asked and `originOf` resolving it once scope is: a
 * literal in callee position, `[f][0]`, `({ d: f }).d`; a method pulled
 * off its holder, `var m = o.f`; `this.f` inside a method of a literal or
 * a class the tree names; `new U().f` and `u.f` over `var u = new U()`
 * for a class's instance method or what `U.prototype.f = ...` put there; a
 * function handed to a fixed function and called through its parameter,
 * `run(f)` over `function run(h) { h(String); }`; the last of several
 * declarations of one name. And what a computed key spells is
 * `KeyReader.read`, asked by every computed access alike: a write target,
 * a reflective method's key, a holder's keys, an alias source, a literal's
 * member. Both directions of the hand-off question - what a call hands
 * over, and who calls a function - are the same routes: `callThrough` is
 * the inverse of `invocation`.
 *
 * Four spellings reach a builtin without naming it, and each is followed:
 *
 *  - an alias. `var S = String; S.fromCharCode = ...`, `var P = String.prototype;
 *    P.split = ...`, `const { prototype } = String`, `var g = globalThis` - a
 *    binding whose sources are the same global, or the same property of one,
 *    is that global, and a write through it is recorded under the global's
 *    name. The sources are the declarator and every assignment: `let S; S =
 *    String`, `S ??= String`, `S = T = String`, `var S = (0, String)`, `var S
 *    = String || 0`, `var [S] = [String]`, `var S = [String][0]`, `for (S of
 *    [String])`, a property of a literal the binding holds, `var o = { S:
 *    String }; o.S.fromCharCode = ...`, and what a function of this file
 *    returns, `var S = id(String)` over `function id(x) { return x; }`. A
 *    binding with more than one source is every one of them: `var S = k ?
 *    Math : String; S.round = ...` may write `Math.round`, and is recorded as
 *    a write to each, marked as one reading among several; a source the
 *    tree cannot read - a call it cannot open, a parameter of a function
 *    something else calls - is recorded under the unknown name besides, with
 *    the binding's name attached, so the disclosure can say it was the
 *    object that could not be read. A parameter is an alias of what every
 *    call of a fixed function hands it: `var S = String; function f(K) {
 *    K.fromCharCode = ... } f(S)` writes `String.fromCharCode`, and so does
 *    the same through `f.call`, `f.apply`, `Reflect.apply`, an IIFE, a
 *    default, a destructured or a rest parameter, a method of an object
 *    literal or a class static the program calls through its holder, and a
 *    parameter handed on to another fixed function, as deep as
 *    `MAX_ALIAS_DEPTH`. A function the tree does not declare, reassigns, or
 *    hands somewhere as a value is the boundary: its parameter may receive
 *    anything, which is the unknown name. A value flows into a binding by
 *    every other head too: `for (var S of [String])`, a `catch` of what the
 *    program throws, a getter, a class field, a destructuring default or
 *    rest, an element popped off a literal, a Map's `get` of what `set` was
 *    given, a callback's parameter over what the receiver holds, `this`
 *    bound by a bare call in sloppy code or by `forEach`'s second argument.
 *    A name bound nowhere is the global object's property of that name,
 *    under every spelling of the global object - `globalThis.S = String; S`
 *    reads it, `S = String; globalThis.S` too, and in a script so does a
 *    top-level `var` - and `Function('return this')()` is the global object.
 *  - a reflective write. `Object.defineProperty(X, key, ...)`,
 *    `Object.defineProperties(X, {...})`, `Object.assign(X, {...})`,
 *    `Reflect.set(X, key, ...)`, `Reflect.defineProperty(X, key, ...)` and
 *    `Object.setPrototypeOf(X, ...)`, made directly, through `.call`, `.apply`
 *    and `.bind`, through `Reflect.apply`, through `Function.prototype.call.call`,
 *    or through an alias of the method - `var d = Object.defineProperty;
 *    d(String, ...)`, `const { defineProperty } = Object`, `o.d(String, ...)` over
 *    an object literal, a parameter, `Object[k]` with a readable `k` - each
 *    write `X`'s `key`, one write per key; a source that is a holder rather
 *    than a literal - `Object.assign(X, d)`, `{ ...d }`, `...[d]`, what a
 *    function returns - writes every key of the holder, which is its
 *    literal's and every write made through the name; a key that cannot be
 *    read, a holder that escapes to a call the tree cannot open, and a new
 *    prototype are a write of every property of `X`.
 *  - a prototype reached through a value. `Object.getPrototypeOf(x).m = ...`,
 *    `x.__proto__.m = ...`, `x.constructor.prototype.m = ...` write the `m` of a
 *    prototype the tree does not name, recorded under `<prototype>`, and
 *    `x.constructor.m = ...` a constructor's, under `<constructor>`; the
 *    caller reads them against every member the slice touches on any value.
 *    An alias of such a read - `var p = s.__proto__; p.split = ...`, `var c =
 *    s.constructor; c.fromCharCode = ...` - is followed like any alias, and a
 *    literal's member the tree cannot read, `''[k].split = ...`, may be either.
 *  - a bare name under `with (X)`, which is `X`'s property whenever `X` has
 *    one: recorded under `X` when the tree can name it, and under the unknown
 *    name as well when `X` is a local.
 *
 * A computed key is read as every string it may hold; see `KeyReader`. A
 * literal and a `+`, a `.concat` or a `.join` of readable parts are read
 * as written; a name is read through every source of its binding - the
 * declarator, run by the time the write is (`holdsDeclaredValue`), and
 * every assignment, since which of them the write sees is not asked: `let
 * k = 'round'; Math[k] = ...; k = 'floor'` may write `Math.round` - through
 * an alias, a destructuring, a property of an object literal, an element
 * at a readable index, a `+=`, a `for (k in o)` head, a `.toString()`, a
 * `.trim()`, a `.toLowerCase()`, a `String(k)`, a parameter of a fixed
 * function, a branch of a logical or a conditional, and a call with literal
 * arguments to a function of this file whose slice reads nothing but its own
 * literals, which the interpreter evaluates. `String[k(0)] = ...` over `var t
 * = ['fromCharCode']; function k(i) { return t[i]; }` is a write to
 * `String.fromCharCode`. A part the tree cannot read is `*` inside the
 * spelling: `'spl' + k` is `spl*`, which may be `split` and cannot be
 * `fromCharCode`, and only a key spelled by nothing at all is the unread `*`
 * the presets decide on.
 *
 * A call in the chain is a hop too. `Object.getPrototypeOf(x)` is the
 * prototype read above; `Object[k](x).split = ...` with an unreadable `k` is a
 * hop the tree cannot read followed by a member it can, recorded as such;
 * a method of a global returns a value of its own, and a write on that is
 * no write to the global - except the `Object` methods that return their
 * first argument, `Object.assign(X, ...).m = ...` being `X.m = ...`, and
 * `valueOf`. A call of a function of this file, or of a function
 * expression, is what it returns, with `this` in it whatever the route
 * bound: `(function () { return this; }).call(Math).round = ...`, `o.get().x
 * = ...` over `get() { return this.t; }`, `new U().get().x = ...`. A literal
 * written through is what it holds: `[Math][0].round = ...`.
 *
 * A write to a fresh object is nobody's: `Object.assign({}, j, k)` and
 * `rc[i] = rc[j]` over a local array literal write what they were built
 * from, and `var o = { S: String }; o.S = 5` replaces what `o` holds and
 * writes nothing on `String` - a place reached by consuming the write's
 * last key is the literal's own slot.
 *
 * What is not a write here: a plain hand-off to a call the tree cannot open
 * - `.map(String)`, `patch(String.prototype)` - since a call may do anything
 * with what it is given and every ordinary file hands builtins to calls.
 */
class HostWriteIndex implements HostWrites {
  private readonly writes = new Map<string, HostWrite[]>();
  /** Where `record` puts a write placed again by `rejudged`, for the span of it; the round's own map otherwise. */
  private overlay: Map<string, HostWrite[]> | undefined;
  /** The raw writes placed with a key some call of this file computes and the round could not read, by the callees; see `rejudged`. */
  private readonly deferred = new Map<RawWrite, Set<string>>();
  /** The key reader of this build, for `rejudged` to set the oracle on. */
  private readonly reader: KeyReader;
  /** Set while the arguments of a reflective call under a method the tree cannot read are placed; see `HostWrite.quiet`. */
  private unreadMethod = false;
  /** Writes already spoken for this round; see `disclose`. */
  private readonly disclosed = new Set<string>();
  private readonly strict: boolean;
  private readonly module: boolean;

  /**
   * One raw walk of the tree, the way `AnnexBIndex` takes its own: a Babel
   * traversal mints a path per node and costs three times as much on
   * obfuscated2.js, once per discovery round. What a raw walk cannot answer
   * is anything about bindings - whether a bare `String = 0` is a local's,
   * what an alias root is bound to, what a computed key holds - and those
   * are asked of the few writes that need them, by one traversal taken only
   * when there are any. Everything is recorded with its place in the walk,
   * so a list read back is in program order whichever pass recorded it.
   *
   * The walk reads `node.type` rather than asking `t.isX`: the bundle reaches
   * `@babel/types` through esbuild's `__toESM` namespace, whose every member
   * read is a getter, and a dozen of them per node were two thirds of what
   * the walk cost on obfuscated2.js.
   */
  constructor(
    private readonly program: NodePath<t.Program>,
    private readonly scans: StatementScanCache | undefined,
  ) {
    this.module = program.node.sourceType === 'module';
    this.strict = this.module || program.node.directives.some(isUseStrict);
    // What `followAlias`, `fixedCalls`, `thisCalls` and the key reader
    // remember is about this tree as it stands; the next build is the next
    // round's tree.
    originsByBinding = new WeakMap();
    callersByFunction = new WeakMap();
    returnsByFunction = new WeakMap();
    thisMembersByBody = new WeakMap();
    keyReader = new KeyReader(program, scans, this.strict, this.module);
    this.reader = keyReader;
    const found: RawWrite[] = [];
    /**
     * Names a declarator, an assignment, a `for` head, a default or a
     * hand-off gives a host name, the global object, `this`, another name,
     * or a property path of one; a property path written through a name is
     * a name here too, `o.S` for `o.S = String`; see `aliasCandidates`.
     */
    const initRoots = new Map<string, Set<string>>();
    /** A name given the result of a call, with the callee's spelling and the roots of the arguments; a source once the callee is known to be this file's. */
    const returned: { name: string; callee: string | t.Function; roots: string[] }[] = [];
    /** Functions declared by name, or by `holder.method` for a method of a literal, a class or a prototype, for the parameters a hand-off reaches; see `targetsOf`. */
    const functions = new Map<string, Set<t.Function>>();
    /** Names given an instance of a constructor, `var u = new U()`, whose methods are `U.prototype`'s. */
    const instanceOf = new Map<string, Set<string>>();
    /** Arguments with a nameable root, or a function literal, handed to a callee the walk could spell. */
    const handoffs: Handoff[] = [];
    /** Calls whose callee may be no function of this file, resolved with the hand-offs; see `EscapedCall`. */
    const escaped: EscapedCall[] = [];
    /** Names given a string literal, by every declarator and assignment; see `readName`. */
    const strings = new Map<string, Set<string>>();
    /** The roots of everything the program throws, which any `catch` may be handed. */
    const thrownRoots = new Set<string>();
    /** The names every `catch` binds, given the thrown roots once the walk has them all. */
    const caught = new Set<string>();
    /** `m.set(k, String)`: what a method call on a local was given, for the local to hold once the walk knows the method is not a function of this file. */
    const kept: { receiver: string; method: string; roots: string[] }[] = [];
    /** Every call of a bare name, for the names the walk learns hold `Reflect.apply`. */
    const routed: { name: string; args: readonly t.Node[]; node: t.CallExpression | t.OptionalCallExpression | t.NewExpression; topLevel: boolean }[] = [];
    thrownSites = [];
    propertyAssignments = new Map();
    programScope = program.scope;
    scriptGlobals = !this.module;
    sloppyThis = !this.strict;
    let order = 0;
    /** The innermost scope-owning node around the write being recorded. */
    let scopeNode: t.Node = program.node;
    /** The holder `this` names in the function being walked, when the walk knows it; see `calleeSpelling`. */
    let thisHolder: string | undefined;

    const note = (
      root: t.Node | string,
      keys: RawKey[],
      node: t.Node,
      topLevel: boolean,
      reflective?: DeferredReflective,
      unreadObject?: string,
    ): void => {
      found.push({ root, keys, node, topLevel, order: order++, scope: scopeNode, reflective, unreadObject });
    };
    /** The spellings `targetsBelow` follows from each name, made once per state of the roots, and listed by holder for the roots that change them; see there. */
    const expansionsOf = new Map<string, readonly string[]>();
    const expandedByHolder = new Map<string, string[]>();
    const addRoot = (name: string, root: string): void => {
      let roots = initRoots.get(name);
      if (!roots) initRoots.set(name, (roots = new Set()));
      if (roots.has(root)) return;
      roots.add(root);
      const dot = name.indexOf('.');
      const holder = dot < 0 ? name : name.slice(0, dot);
      const expanded = expandedByHolder.get(holder);
      if (expanded) {
        for (const key of expanded) expansionsOf.delete(key);
        expandedByHolder.delete(holder);
      }
    };
    /** The objects of the `with` statements around the node being recorded, innermost last. */
    let withObjects: readonly t.Node[] = [];
    const target = (node: t.Node, write: t.Node, topLevel: boolean): void => {
      const written = stripTypeWrappers(node);
      if (written.type === 'Identifier') {
        if (written.name === 'arguments') return;
        // Under `with (String) { fromCharCode = ... }` a bare name is the
        // object's property whenever the object has one; every enclosing
        // `with` is a candidate, and one over an object the index cannot
        // name is a write to nothing it can rule out.
        for (const object of withObjects) {
          const spine = spineOf(object);
          const nameable = spine.root.type === 'Identifier' || spine.root.type === 'ThisExpression' || isPrototypeRead(spine.root);
          note(nameable ? spine.root : UNKNOWN_NAME, [...spine.keys, written.name], write, topLevel);
          // A local's own object is one the tree cannot rule out either,
          // unless the local turns out to be an alias of a global.
          if (spine.root.type === 'Identifier' && !NAMED_ROOTS.has(spine.root.name) && !GLOBAL_OBJECT_NAMES.has(spine.root.name)) {
            note(UNKNOWN_NAME, [...spine.keys, written.name], write, topLevel, undefined, spine.root.name);
          }
        }
        if (HOST_NAMES.has(written.name)) note(written, [], write, topLevel);
        return;
      }
      if (!isMember(written)) return;
      const spine = spineOf(written);
      found.push({ root: spine.root, keys: spine.keys, node: write, topLevel, order: order++, scope: scopeNode, target: written });
    };
    const targets = (node: t.Node, write: t.Node, topLevel: boolean): void => {
      for (const each of assignedTargets(node)) target(each, write, topLevel);
    };
    /** `name` is given `source`, as far as `pattern` lets the part be read: a candidate for every root the value may have. */
    const alias = (pattern: t.Node, source: t.Node | null | undefined, topLevel: boolean): void => {
      if (!source) return;
      for (const name of Object.keys(t.getBindingIdentifiers(pattern as t.Identifier))) {
        const picked = pattern.type === 'Identifier' ? source : patternSource(pattern, source, name);
        if (picked === 'unknown') {
          // `var [K] = r` over a rest parameter: a part the tree cannot pick
          // of a value with roots may be any of them, and the scope, asked,
          // refuses what it cannot read.
          for (const root of sourceRoots(source, topLevel, 0)) addRoot(name, root);
          continue;
        }
        if (!picked) continue;
        const value = stripTypeWrappers(picked);
        if (value.type === 'CallExpression' || value.type === 'OptionalCallExpression') {
          const invoked = invocation(value.callee, undefined, value.arguments, 0);
          for (const arm of invoked?.fns ?? []) {
            for (const callee of calleeSpellings(arm, thisHolder, readName)) {
              const roots: string[] = [];
              for (const argument of invoked!.args) roots.push(...heldRoots(argument, topLevel, 0));
              returned.push({ name, callee, roots });
            }
          }
        }
        if (value.type === 'NewExpression') {
          const constructor = stripTypeWrappers(value.callee);
          if (constructor.type === 'Identifier') {
            let constructors = instanceOf.get(name);
            if (!constructors) instanceOf.set(name, (constructors = new Set()));
            constructors.add(constructor.name);
          }
        }
        for (const root of sourceRoots(picked, topLevel, 0)) addRoot(name, root);
        // `var o = { d: Object.defineProperty }`: `o.d` is a path given the method, the way `o.d = ...` gives one.
        if (value.type === 'ObjectExpression' || value.type === 'ArrayExpression') pathRoots(name, value, topLevel, 0);
        for (const spelled of literalSpellings(value)) {
          let known = strings.get(name);
          if (!known) strings.set(name, (known = new Set()));
          known.add(spelled);
        }
      }
    };
    /** The roots of a literal's members under their paths, `o.a.b` for `{ a: { b: ... } }`, `xs.0.a` for `[{ a: ... }]`, as deep as `MAX_KEY_HOPS`. */
    const pathRoots = (holder: string, literal: t.ObjectExpression | t.ArrayExpression, topLevel: boolean, depth: number): void => {
      if (depth > MAX_KEY_HOPS) return;
      const members: [string, t.Node][] = [];
      if (literal.type === 'ObjectExpression') {
        for (const property of literal.properties) {
          const key = property.type === 'ObjectProperty' ? methodKey(property) : undefined;
          if (key !== undefined && property.type === 'ObjectProperty') members.push([key, property.value]);
        }
      } else {
        literal.elements.forEach((element, index) => {
          if (element && element.type !== 'SpreadElement') members.push([String(index), element]);
        });
      }
      for (const [key, member] of members) {
        const value = stripTypeWrappers(member);
        for (const root of sourceRoots(value, topLevel, 0)) addRoot(`${holder}.${key}`, root);
        if (value.type === 'ObjectExpression' || value.type === 'ArrayExpression') pathRoots(`${holder}.${key}`, value, topLevel, depth + 1);
      }
    };
    /** The strings a name is given anywhere, for `o[k](...)` to spell as `o.f`; the scope decides which, later. */
    const readName = (name: string): ReadonlySet<string> | undefined => strings.get(name);
    /** The property path a member write gives a value: `o.S = String` makes `o.S` a name holding `String`. */
    const memberAlias = (left: t.Node, right: t.Node, topLevel: boolean): void => {
      const written = stripTypeWrappers(left);
      if (!isMember(written)) return;
      const spine = memberSpine(written);
      if (!spine || spine.keys.slice(0, -1).some((key) => !isRead(key))) return;
      // The last key as spelled, or every string a name in it is given: `o[k] = ...` over `var k = 'S'`.
      const last = spine.keys[spine.keys.length - 1]!;
      const keys = isRead(last) ? [last] : written.computed && written.property.type === 'Identifier' ? [...(readName(written.property.name) ?? [])] : [];
      const value = stripTypeWrappers(right);
      for (const key of keys) {
        // `X.S = ...` may give the global object's `S`, which a bare `S` reads; see `globalPropertyOrigin`.
        propertyAssignment(key, { object: written.object, value: right, scope: scopeNode, topLevel });
        const name = `${spine.root}.${[...spine.keys.slice(0, -1), key].join('.')}`;
        for (const root of sourceRoots(right, topLevel, 0)) addRoot(name, root);
        if (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression') declareFunction(functions, name, value);
        else if (value.type === 'ObjectExpression') declareMethods(name, value.properties, topLevel);
      }
    };
    /**
     * The roots the arguments of every call in a chain carry, for what a
     * callback run over the chain's result may be handed:
     * `Promise.resolve(String).then(cb)` hands `cb` what `resolve` was given.
     */
    const chainArgumentRoots = (node: t.Node, topLevel: boolean): string[] => {
      const roots: string[] = [];
      let current: t.Node = stripTypeWrappers(node);
      for (let hops = 0; hops < 16; hops++) {
        if (isMember(current)) {
          current = stripTypeWrappers(current.object);
        } else if (current.type === 'CallExpression' || current.type === 'OptionalCallExpression' || current.type === 'NewExpression') {
          for (const argument of storedArguments(current)) roots.push(...heldRoots(argument, topLevel, 0));
          current = stripTypeWrappers(current.callee);
        } else {
          break;
        }
      }
      return roots;
    };
    /** What a call hands over, by position, to whatever `callee` spells. */
    const handoff = (callee: string | t.Function, args: readonly t.Node[], topLevel: boolean): void => {
      for (let index = 0; index < args.length && index < MAX_HANDOFF_ARGS; index++) {
        const argument = args[index]!;
        if (argument.type === 'SpreadElement') {
          // `f(...xs)`: the roots of what is spread, at this position and every one after; the index is read at the call.
          for (const root of sourceRoots(argument.argument, topLevel, 0)) {
            for (let at = index; at < MAX_HANDOFF_ARGS; at++) handoffs.push({ callee, index: at, root });
          }
          break;
        }
        for (const root of sourceRoots(argument, topLevel, 0)) handoffs.push({ callee, index, root });
        const literal = stripTypeWrappers(argument);
        if (literal.type === 'FunctionExpression' || literal.type === 'ArrowFunctionExpression') handoffs.push({ callee, index, root: literal });
      }
    };
    const call = (node: t.CallExpression | t.OptionalCallExpression | t.NewExpression, topLevel: boolean, callee: t.Node = node.callee, args: readonly t.Node[] = node.arguments): void => {
      // The function a call reaches and what it hands over, through every
      // route `invocation` sees through; a builtin handed to a function of
      // this file may be written through its parameter, and only a callee
      // the walk can spell is worth remembering. `callee` and `args` are the
      // call's own, or the route a bare name turned out to hold.
      const invoked = invocation(callee, undefined, args, 0);
      // What the call carries to any function among its arguments, should
      // its callee turn out to be no function of this file: the roots of
      // the arguments, and of a receiver that is not a builtin's own name.
      const escape: EscapedCall = { callees: [], handed: [], carried: [] };
      for (const argument of invoked?.args ?? args) {
        const spread = argument.type === 'SpreadElement';
        const roots = sourceRoots(spread ? argument.argument : argument, topLevel, 0);
        escape.carried.push(...roots);
        if (!spread) escape.handed.push(...roots);
        const value = stripTypeWrappers(argument);
        if (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression') escape.handed.push(value);
      }
      if (escape.handed.length > 0) escaped.push(escape);
      if (!invoked) return;
      // `api.call(t, ...)` over a holder that is no function: its own method, handed every argument as spelled.
      for (const method of invoked.own ?? []) {
        const spellings = calleeSpellings(method.fn, thisHolder, readName);
        escape.callees.push(...spellings);
        for (const callee of spellings) handoff(callee, method.args, topLevel);
      }
      for (const arm of invoked.fns) {
        const fn = stripTypeWrappers(arm);
        const spellings = calleeSpellings(fn, thisHolder, readName);
        escape.callees.push(...spellings);
        for (const callee of spellings) handoff(callee, invoked.args, topLevel);
        // `f.bind(t, a, b)`: `a` and `b` reach `f`'s first parameters, whenever the bound function is called.
        if (isMember(fn) && propertyKey(fn) === 'bind' && invoked.args.length > 1) {
          for (const bound of calleeSpellings(fn.object, thisHolder, readName)) handoff(bound, invoked.args.slice(1), topLevel);
        }
        if (isMember(fn)) {
          const method = propertyKey(fn);
          const receiver = stripTypeWrappers(fn.object);
          if (receiver.type !== 'Identifier' || (!NAMED_ROOTS.has(receiver.name) && !GLOBAL_OBJECT_NAMES.has(receiver.name))) escape.carried.push(...sourceRoots(receiver, topLevel, 0));
          // A callback a builtin runs over an array is handed its elements;
          // one run over anything else - a Map, a promise - is handed what
          // the receiver was built from, which the scope reads or refuses.
          // `Array.from(xs, f)` runs `f` over `xs`; a comparator takes two
          // elements at once.
          const fromArray = method === 'from' && receiver.type === 'Identifier' && receiver.name === 'Array';
          const pairs = method === 'sort' || method === 'toSorted';
          const receives = fromArray || pairs ? 0 : ITERATES_ELEMENTS.get(method);
          if (receives !== undefined) {
            const listed = fromArray ? invoked.args[0] && stripTypeWrappers(invoked.args[0]) : receiver;
            const callbacks = fromArray ? invoked.args.slice(1, 2) : method === 'then' ? invoked.args.slice(0, 2) : invoked.args.slice(0, 1);
            const roots: string[] = [];
            if (listed?.type === 'ArrayExpression') {
              for (const element of listed.elements) if (element && element.type !== 'SpreadElement') roots.push(...sourceRoots(element, topLevel, 0));
            } else if (listed && listed.type !== 'SpreadElement') {
              roots.push(...sourceRoots(listed, topLevel, 0), ...chainArgumentRoots(listed, topLevel));
            }
            for (const callback of callbacks) {
              for (const spelled of calleeSpellings(callback, thisHolder, readName)) {
                for (const root of roots) {
                  handoffs.push({ callee: spelled, index: receives, root });
                  if (pairs) handoffs.push({ callee: spelled, index: 1, root });
                }
              }
            }
          }
          // `m.set(k, String)`: a method of a local the walk cannot name may keep what it is given, for `m.get(k)` to give back.
          if (receiver.type === 'Identifier' && !NAMED_ROOTS.has(receiver.name) && !GLOBAL_OBJECT_NAMES.has(receiver.name) && isRead(method)) {
            const roots: string[] = [];
            const stored = stripTypeWrappers(node.callee) === fn ? storedArguments(node) : invoked.args;
            for (const argument of stored) roots.push(...heldRoots(argument, topLevel, 0));
            if (roots.length > 0) kept.push({ receiver: receiver.name, method, roots });
          }
        }
        if (node.type === 'NewExpression' || invoked.args.length === 0) continue;
        if (isMember(fn)) {
          const spine = memberSpine(fn);
          if (spine && (spine.root === 'Object' || spine.root === 'Reflect') && spine.keys.length === 1 && isRead(spine.keys[0]!)) {
            const written = reflectiveWrite(spine.root, spine.keys[0]!, invoked.args);
            if (!written) {
              // `Object.defineProperty(...a)`, `.apply(Object, a)`: the list is the scope's to open.
              if (invoked.args[0]?.type === 'SpreadElement') note('', [], node, topLevel, { callee: fn, args: invoked.args, thisHolder });
              continue;
            }
            // One write per key: `Object.assign(X, { a, b })` writes `X.a`
            // and `X.b`, not the chain `X.a.b`. Read as a chain,
            // `Object.assign(String, { a: 1, fromCharCode: ... })` reached
            // nothing, and `Object.assign({}, j, k)` was `{}[*][*]`, which
            // the prototype rule for `''[k].split` took for a write to some
            // prototype - and conservative refused every decoder for it.
            const objectSpine = spineOf(written.object);
            for (const key of written.keys) note(objectSpine.root, [...objectSpine.keys, key], node, topLevel);
            continue;
          }
        }
        // `d(String, 'fromCharCode', ...)` over `var d = Object.defineProperty`,
        // `o.d(...)` over `var o = { d: Object.defineProperty }`, `Object[k](...)`,
        // `[Object.defineProperty][0](...)`, `globalThis.Object.defineProperty(...)`:
        // what the callee is bound to is a question for the scope, asked in `place`.
        if (fn.type === 'Identifier' || isMember(fn)) note('', [], node, topLevel, { callee: fn, args: invoked.args, thisHolder });
        // `with (Object) { defineProperty(...) }`: a bare callee may be the object's method.
        if (fn.type === 'Identifier') {
          for (const object of withObjects) note('', [], node, topLevel, { callee: object, args: invoked.args, thisHolder, key: fn.name });
          // `var ap = Reflect.apply; ap(f, t, [String])`: a route held by a name, opened once the walk knows the name.
          routed.push({ name: fn.name, args: invoked.args, node, topLevel });
        }
      }
    };
    /** A default is a source of its parameter: `function f(K = String)`, and as deep as a pattern goes, `function f(...[K = String])`. */
    const defaults = (fn: t.Function): void => {
      const walk = (param: t.Node): void => {
        switch (param.type) {
          case 'AssignmentPattern':
            alias(param.left, param.right, false);
            walk(param.left);
            break;
          case 'ArrayPattern':
            for (const element of param.elements) if (element) walk(element);
            break;
          case 'ObjectPattern':
            for (const property of param.properties) walk(property.type === 'RestElement' ? property.argument : property.value);
            break;
          case 'RestElement':
            walk(param.argument);
            break;
          default:
            break;
        }
      };
      for (const param of fn.params) walk(param);
    };
    /**
     * The methods of an object literal or a class body, declared under
     * `holder.method`; a class's instance members under
     * `holder.prototype.method`, which is how `new U().m` is spelled. A
     * getter gives the name what it returns, a field what it holds.
     */
    const declareMethods = (holder: string, body: readonly t.Node[], topLevel: boolean): void => {
      for (const member of body) {
        const isStatic = member.type === 'ClassProperty' || member.type === 'ClassMethod' ? member.static : true;
        const key = methodKey(member);
        if (key === undefined) continue;
        const name = isStatic ? `${holder}.${key}` : `${holder}.prototype.${key}`;
        if (member.type === 'ObjectProperty' || member.type === 'ClassProperty') {
          if (!member.value) continue;
          const value = stripTypeWrappers(member.value);
          if (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression') declareFunction(functions, name, value);
          else if (value.type === 'ObjectExpression') declareMethods(name, value.properties, false);
          if (member.type === 'ClassProperty') {
            // The class holds a static the way a literal holds a property: `H.S.x = ...` asks the scope through `H`.
            for (const root of sourceRoots(member.value, topLevel, 0)) {
              addRoot(name, root);
              if (isStatic) addRoot(holder, root);
            }
          }
        } else if (member.type === 'ObjectMethod' || member.type === 'ClassMethod') {
          if (member.kind !== 'get') {
            declareFunction(functions, name, member);
            continue;
          }
          for (const root of returnedRoots(member, false, 0)) {
            addRoot(name, root);
            if (member.type === 'ClassMethod' && isStatic) addRoot(holder, root);
          }
        }
      }
    };

    // `topLevel` is whether `this` here is the program's: under no function,
    // or under arrows alone. An explicit stack, since an obfuscated tree is
    // deep enough to overflow a recursive one; children are pushed last
    // child first so that they are popped in program order. Each frame
    // carries the scope-owning node it sits under, by the same rule Babel
    // gives a path its scope, so a write can be resolved without a path;
    // `holder` is the spelling of the literal or class the node is a direct
    // member of, from which a method's `this` takes its name.
    interface Frame {
      node: t.Node;
      parent: t.Node | undefined;
      topLevel: boolean;
      scope: t.Node;
      withs: readonly t.Node[];
      thisHolder: string | undefined;
      holder: string | undefined;
    }
    const stack: Frame[] = [
      { node: program.node, parent: undefined, topLevel: true, scope: program.node, withs: [], thisHolder: undefined, holder: undefined },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const { node, parent, holder } = frame;
      let { topLevel, withs } = frame;
      thisHolder = frame.thisHolder;
      scopeNode = parent !== undefined && isScope(node, parent) ? node : frame.scope;
      withObjects = withs;
      if (parent?.type === 'WithStatement' && parent.body === node) withs = [...withs, parent.object];
      /** The holder the direct members of `node` belong to, when it is a literal or class the walk can name. */
      let members: string | undefined;
      switch (node.type) {
        case 'AssignmentExpression':
          targets(node.left, node, topLevel);
          // The assignment is a source of every name it binds: `S = String`
          // makes `S` a candidate the way `var S = String` does, and `o.S =
          // String` makes `o.S` one.
          if (node.operator === '=' || node.operator === '||=' || node.operator === '&&=' || node.operator === '??=') {
            alias(node.left, node.right, topLevel);
            memberAlias(node.left, node.right, topLevel);
            // `S = String` with `S` bound nowhere gives the global object's `S`; the scope decides.
            if (node.left.type === 'Identifier') propertyAssignment(node.left.name, { object: 'bare', value: node.right, scope: scopeNode, topLevel });
          }
          break;
        case 'ThrowStatement':
          thrownSites.push({ node: node.argument, scope: scopeNode });
          for (const root of sourceRoots(node.argument, topLevel, 0)) thrownRoots.add(root);
          break;
        case 'CatchClause':
          if (node.param) for (const name of Object.keys(t.getBindingIdentifiers(node.param))) caught.add(name);
          break;
        case 'UpdateExpression':
          target(node.argument, node, topLevel);
          break;
        case 'UnaryExpression':
          if (node.operator === 'delete') target(node.argument, node, topLevel);
          break;
        case 'ForInStatement':
          if (node.left.type !== 'VariableDeclaration') targets(node.left, node, topLevel);
          break;
        case 'ForOfStatement': {
          // `for (S of [String])`, `for (var [S] of [[String]])`: each element is a source of the head.
          if (node.left.type !== 'VariableDeclaration') targets(node.left, node, topLevel);
          const heads = node.left.type === 'VariableDeclaration' ? node.left.declarations.map((declarator) => declarator.id) : [node.left];
          const iterated = stripTypeWrappers(node.right);
          for (const head of heads) {
            if (head.type === 'Identifier') {
              alias(head, node.right, topLevel);
            } else if (iterated.type === 'ArrayExpression') {
              for (const element of iterated.elements) if (element && element.type !== 'SpreadElement') alias(head, element, topLevel);
            } else {
              // `for (const [k, S] of new Map(...))`: every name of the pattern may hold what the iterable was built from.
              for (const name of Object.keys(t.getBindingIdentifiers(head))) for (const root of sourceRoots(node.right, topLevel, 0)) addRoot(name, root);
            }
          }
          break;
        }
        case 'CallExpression':
        case 'OptionalCallExpression':
        case 'NewExpression':
          call(node, topLevel);
          break;
        case 'VariableDeclarator': {
          alias(node.id, node.init, topLevel);
          if (node.id.type === 'Identifier' && node.init) {
            const init = stripTypeWrappers(node.init);
            if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') declareFunction(functions, node.id.name, init);
            else if (init.type === 'ObjectExpression') declareMethods(node.id.name, init.properties, topLevel);
            else if (init.type === 'ClassExpression') declareMethods(node.id.name, init.body.body, topLevel);
          }
          break;
        }
        case 'ClassDeclaration':
          if (node.id) declareMethods(node.id.name, node.body.body, topLevel);
          break;
        case 'FunctionDeclaration':
          if (node.id) declareFunction(functions, node.id.name, node);
          topLevel = false;
          thisHolder = undefined;
          defaults(node);
          break;
        case 'FunctionExpression':
          topLevel = false;
          // The value of a property of a holder, or assigned to `o.f` or
          // `U.prototype.f`: `this` in it is the holder.
          thisHolder =
            parent?.type === 'ObjectProperty'
              ? holder
              : parent?.type === 'AssignmentExpression' && parent.right === node && isMember(parent.left)
                ? memberSpelling(parent.left.object)
                : undefined;
          defaults(node);
          break;
        case 'ObjectMethod':
          topLevel = false;
          thisHolder = holder;
          defaults(node);
          break;
        case 'ClassMethod':
        case 'ClassPrivateMethod':
          topLevel = false;
          thisHolder = holder === undefined ? undefined : node.type === 'ClassMethod' && node.static ? holder : `${holder}.prototype`;
          defaults(node);
          break;
        case 'ArrowFunctionExpression':
          defaults(node);
          break;
        default:
          break;
      }
      // The spelling the direct members of a literal or class body take.
      if (node.type === 'ObjectExpression' || node.type === 'ClassBody') {
        if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && parent.init === node) members = parent.id.name;
        else if (parent?.type === 'ClassExpression' || parent?.type === 'ClassDeclaration') members = holder;
        else if (parent?.type === 'AssignmentExpression' && parent.right === node) members = memberSpelling(parent.left);
        else if (parent?.type === 'ObjectProperty' && parent.value === node) members = holder;
      } else if (node.type === 'ClassExpression' && parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        members = parent.id.name;
      } else if (node.type === 'ClassDeclaration' && node.id) {
        members = node.id.name;
      } else if (node.type === 'ObjectProperty' && holder !== undefined) {
        // The value of a property: a function's `this` is the holder, a
        // nested literal's members are `holder.key`'s.
        const key = methodKey(node);
        members = key === undefined ? undefined : `${holder}.${key}`;
      }
      const keys = VISITOR_KEYS[node.type] ?? [];
      for (let k = keys.length - 1; k >= 0; k--) {
        const child = (node as unknown as Record<string, unknown>)[keys[k]!];
        // `holder` reaches a property's value and a literal's members, and no further.
        const childHolder = node.type === 'ObjectProperty' ? (keys[k] === 'value' ? holder : undefined) : members;
        const literalHolder = node.type === 'ObjectProperty' && keys[k] === 'value' && members !== undefined ? members : childHolder;
        if (Array.isArray(child)) {
          for (let i = child.length - 1; i >= 0; i--) {
            const item = child[i];
            if (item && typeof (item as t.Node).type === 'string') {
              stack.push({ node: item as t.Node, parent: node, topLevel, scope: scopeNode, withs, thisHolder, holder: childHolder });
            }
          }
        } else if (child && typeof (child as t.Node).type === 'string') {
          const value = child as t.Node;
          const holds = value.type === 'ObjectExpression' || value.type === 'ClassExpression' ? literalHolder : childHolder;
          stack.push({ node: value, parent: node, topLevel, scope: scopeNode, withs, thisHolder, holder: holds });
        }
      }
    }

    // `var g = f`: a call of `g` reaches `f`'s parameters, as far as the
    // roots follow the alias; `var p = o` reaches `o`'s methods, `var u =
    // new U()` reaches `U.prototype`'s. Resolved at each hand-off rather
    // than copied into the map: obfuscator.io reuses a function name in
    // hundreds of scopes, and copying every alias's list grew half a
    // million entries.
    /** `targetsOf` remembered per name at the top until a round adds a function or a root, so a callee is asked about once and not once per call site. */
    const targetMemo = new Map<string, Iterable<t.Function>>();
    const targetsOf = (name: string | t.Function, depth: number): Iterable<t.Function> => {
      if (typeof name !== 'string') return [name];
      if (depth > 0) return targetsBelow(name, depth);
      let known = targetMemo.get(name);
      if (known === undefined) {
        known = targetsBelow(name, 0);
        targetMemo.set(name, known);
      }
      return known;
    };
    /**
     * The functions a name reaches through the names it is given, breadth
     * first and each name once: the alias graph of an obfuscated bundle is
     * dense - a parameter name shared by hundreds of functions gathers
     * hundreds of roots - and followed by path rather than by name it
     * multiplied into hundreds of millions of steps on one build. A spelling
     * the routes make up, `root.suffix` or `X.prototype.suffix`, is followed
     * only while some key of the maps could still match it: the routes keep
     * a spelling's suffix or put `.prototype` in front of it, so a suffix
     * that no key ends in, with or without those, names nothing and never
     * will. Once the strings of a bundle are inlined, its member paths read
     * and the spellings ran to hundreds of thousands per name.
     */
    let keyedAt = -1;
    const keySuffixes = new Set<string>(['']);
    const suffixesOfKeys = (): ReadonlySet<string> => {
      const size = functions.size + initRoots.size + instanceOf.size;
      if (size !== keyedAt) {
        keyedAt = size;
        keySuffixes.clear();
        keySuffixes.add('');
        for (const map of [functions, initRoots, instanceOf]) {
          for (const key of map.keys()) {
            const dot = key.indexOf('.');
            if (dot < 0) continue;
            let suffix = key.slice(dot);
            keySuffixes.add(suffix);
            while (suffix.startsWith('.prototype.')) {
              suffix = suffix.slice('.prototype'.length);
              keySuffixes.add(suffix);
            }
          }
        }
      }
      return keySuffixes;
    };
    let expandedAt = -1;
    const expansions = (current: string): readonly string[] => {
      const allowed = suffixesOfKeys();
      if (keyedAt !== expandedAt) {
        // A new key admits spellings every list so far left out.
        expandedAt = keyedAt;
        expansionsOf.clear();
        expandedByHolder.clear();
      }
      let list = expansionsOf.get(current);
      if (list) return list;
      const out: string[] = [];
      const push = (target: string): void => {
        const dot = target.indexOf('.');
        if (dot < 0 || allowed.has(target.slice(dot))) out.push(target);
      };
      const dot = current.indexOf('.');
      const holder = dot < 0 ? current : current.slice(0, dot);
      const suffix = dot < 0 ? '' : current.slice(dot);
      for (const root of initRoots.get(holder) ?? []) if (root !== holder) push(root + suffix);
      if (dot >= 0) {
        // `o.f = g`: the property path is a name given `g`, called wherever `o.f` is.
        for (const root of initRoots.get(current) ?? []) if (root !== current) push(root);
        for (const constructor of instanceOf.get(holder) ?? []) push(`${constructor}.prototype${suffix}`);
      }
      expansionsOf.set(current, out);
      let expanded = expandedByHolder.get(holder);
      if (!expanded) expandedByHolder.set(holder, (expanded = []));
      expanded.push(current);
      return out;
    };
    const targetsBelow = (name: string, depth: number): Iterable<t.Function> => {
      const reached = new Set<t.Function>();
      const visited = new Set<string>([name]);
      let frontier = [name];
      for (let level = depth; frontier.length > 0; level++) {
        const next: string[] = [];
        for (const current of frontier) {
          for (const fn of functions.get(current) ?? []) reached.add(fn);
          if (level >= 3) continue;
          for (const target of expansions(current)) {
            if (visited.has(target)) continue;
            visited.add(target);
            next.push(target);
          }
        }
        frontier = next;
      }
      return reached;
    };
    // A call's result is a source of what the call was handed only when the
    // callee is a function of this file, whose returns `originOf` can read;
    // the map is complete only once the walk is.
    /** The roots a name stands for, through the names it is given, as far as `targetsOf` follows them. */
    const namedRoots = (name: string, depth: number, into: Set<string>): Set<string> => {
      for (const root of initRoots.get(name) ?? []) {
        if (into.has(root)) continue;
        into.add(root);
        if (depth < 3) namedRoots(root, depth + 1, into);
      }
      return into;
    };
    /**
     * Whether a function's returns could carry anything the scope would
     * follow: a name, a member, `this`, a literal holding one, a call. The
     * helpers obfuscator.io keeps on an object - `function (a, b) { return
     * a - b; }`, called thousands of times - return arithmetic, and a name
     * given one of those is nobody's alias.
     */
    const returnsReach = new Map<t.Function, boolean>();
    const reaches = (fn: t.Function): boolean => {
      let known = returnsReach.get(fn);
      if (known === undefined) {
        // A generator yields whatever it yields; a function that is not one returns what it returns.
        known = fn.generator || ownReturns(fn).some((node) => {
          const value = stripTypeWrappers(node);
          return value.type === 'CallExpression' || value.type === 'OptionalCallExpression' || value.type === 'NewExpression' || sourceRoots(value, false, 0, 'this').length > 0;
        });
        returnsReach.set(fn, known);
      }
      return known;
    };
    for (const { name, callee, roots } of returned) {
      let known = false;
      let reaching = false;
      for (const fn of targetsOf(callee, 0)) {
        known = true;
        if (reaches(fn)) {
          reaching = true;
          break;
        }
      }
      // `var gp = Object.getPrototypeOf; var p = gp(x)`: the prototype read, by its alias.
      if (!known && typeof callee === 'string') {
        const named = namedRoots(callee, 0, new Set());
        if (named.has('Object.getPrototypeOf') || named.has('Reflect.getPrototypeOf')) addRoot(name, PROTOTYPE_OF_A_VALUE);
        continue;
      }
      if (!known) continue;
      if (reaching) addRoot(name, RETURNED);
      for (const root of roots) addRoot(name, root);
    }
    // A `catch` may be handed anything the program throws.
    for (const name of caught) for (const root of thrownRoots) addRoot(name, root);
    // `var ap = Reflect.apply; ap(f, t, [String])`: the call the route makes, now that the name is known to hold it.
    thisHolder = undefined;
    for (const { name, args, node, topLevel } of routed) {
      if (namedRoots(name, 0, new Set()).has('Reflect.apply')) call(node, topLevel, REFLECT_APPLY, args);
    }
    // A method the walk cannot name - a Map's `set`, not `delta.decode` over
    // `delta.decode = function ...` - may keep in its holder what it is given.
    for (const { receiver, method, roots } of kept) {
      let named = false;
      for (const _ of targetsOf(`${receiver}.${method}`, 0)) {
        named = true;
        break;
      }
      if (!named) for (const root of roots) addRoot(receiver, root);
    }
    // Every hand-off is a source of the parameter it reaches: `f(String)`
    // gives `K` the root `String`, `run(f)` gives `h` the root `f`, and
    // `run(function (K) { ... })` declares the function under `h`. To a fixed
    // point, since what a call reaches may itself be a parameter handed a
    // function: `h(String)` reaches `f` only once `h` holds it.
    const reachesFunction = (callee: string | t.Function): boolean => {
      for (const _ of targetsOf(callee, 0)) return true;
      return false;
    };
    /** The names a function's parameters bind, per function. */
    const parameterNames = new Map<t.Function, string[]>();
    const parametersOf = (fn: t.Function): string[] => {
      let names = parameterNames.get(fn);
      if (!names) {
        names = [];
        for (const param of fn.params) names.push(...Object.keys(t.getBindingIdentifiers(param as t.Identifier)));
        parameterNames.set(fn, names);
      }
      return names;
    };
    for (let round = 0, grew = true; grew && round <= MAX_ALIAS_DEPTH; round++) {
      grew = false;
      targetMemo.clear();
      for (const { callee, index, root } of handoffs) {
        for (const fn of targetsOf(callee, 0)) {
          // The parameter at the position, or the rest parameter that takes it.
          let param = fn.params[index];
          const last = fn.params[fn.params.length - 1];
          if (!param && last?.type === 'RestElement') param = last;
          if (!param) continue;
          for (const name of Object.keys(t.getBindingIdentifiers(param as t.Identifier))) {
            if (typeof root === 'string') {
              if (initRoots.get(name)?.has(root)) continue;
              addRoot(name, root);
            } else {
              if (functions.get(name)?.has(root)) continue;
              declareFunction(functions, name, root);
            }
            grew = true;
          }
        }
      }
      if (grew) continue;
      // Once the hand-offs have settled: a function handed to a call that
      // reaches no function of this file may be called with anything the
      // call carries, at any parameter, and the scope reads the call - a
      // builtin running it over a literal - or refuses. A global is given
      // as it is; an alias of one is the handed value, which makes the
      // parameter an alias and no more; a local nobody will ask about, a
      // function of the program among them, is not given, since each root
      // is weight on every name that holds it - a builtin that hands a
      // callback a function is read where the builtin is modelled, above.
      // A parameter made an alias may be carried by the next pass. A global
      // a function is declared under changes what a name reaches, and asks
      // the hand-offs again - when it is given to a name they resolve
      // through: a callee, its holder, and what their roots lead to.
      const resolving = new Set<string>();
      const resolve = (name: string): void => {
        resolving.add(name);
        const dot = name.indexOf('.');
        if (dot >= 0) resolving.add(name.slice(0, dot));
      };
      for (const { callee } of handoffs) if (typeof callee === 'string') resolve(callee);
      for (let hop = 0, frontier = [...resolving]; hop < 3 && frontier.length > 0; hop++) {
        const next: string[] = [];
        for (const name of frontier) {
          for (const root of [...(initRoots.get(name) ?? []), ...(instanceOf.get(name) ?? [])]) {
            if (resolving.has(root)) continue;
            resolve(root);
            next.push(root);
          }
        }
        frontier = next;
      }
      for (let again = true; again; ) {
        again = false;
        const { aliases: candidates, globalKeys: keysSoFar } = aliasCandidates(initRoots);
        for (const { callees, handed, carried } of escaped) {
          if (carried.length === 0 || callees.some(reachesFunction)) continue;
          const given = new Set<string>();
          for (const root of carried) {
            if (isGlobalRoot(root, keysSoFar)) given.add(root);
            else if (candidates.has(root)) given.add(HANDED);
          }
          if (given.size === 0) continue;
          for (const name of handed) {
            for (const fn of targetsOf(name, 0)) {
              for (const bound of parametersOf(fn)) {
                for (const root of given) {
                  if (initRoots.get(bound)?.has(root)) continue;
                  addRoot(bound, root);
                  again = true;
                  if (resolving.has(bound) && reachesFunction(root)) grew = true;
                }
              }
            }
          }
        }
      }
    }

    // A write that needs a binding is answered from the scope Babel built
    // for its node at the last crawl, which is what a path's `scope` would
    // be; only a tree nobody crawled - the scope cache holds nothing for it
    // - pays for a traversal, and only over the writes that need one.
    const { aliases, globalKeys, reflective } = aliasCandidates(initRoots);
    // Names given a global's reading outright - `var k = Object.keys(o)[0]` - which a computed key may spell `__proto__` through.
    const keyNames = new Set<string>();
    for (const [name, roots] of initRoots) {
      for (const root of roots) {
        if (NAMED_ROOTS.has(root) || GLOBAL_OBJECT_NAMES.has(root)) {
          keyNames.add(name);
          break;
        }
      }
    }
    /**
     * Whether a path may hold a reflective method: given one itself, or a
     * path of a name the holder is an alias of - `p.d` over `var p = o`,
     * `o = { d: Object.defineProperty }`.
     */
    const pathReflective = (path: string, depth: number): boolean => {
      if (reflective.has(path)) return true;
      const dot = path.indexOf('.');
      if (dot < 0 || depth >= 3) return false;
      const holder = path.slice(0, dot);
      for (const root of initRoots.get(holder) ?? []) if (root !== holder && !root.includes('.') && pathReflective(root + path.slice(dot), depth + 1)) return true;
      return false;
    };
    const pending = new Map<t.Node, RawWrite[]>();
    for (const write of found) {
      if (!needsScope(write, aliases, globalKeys, keyNames, reflective, pathReflective)) {
        this.place(write, undefined);
        continue;
      }
      const scope = write.scope === program.node ? program.scope : traverse.cache.scope.get(write.scope);
      if (scope) {
        this.place(write, scope);
        continue;
      }
      let list = pending.get(write.node);
      if (!list) pending.set(write.node, (list = []));
      list.push(write);
    }

    if (pending.size > 0) {
      const resolve = (path: NodePath): void => {
        const writes = pending.get(path.node);
        if (!writes) return;
        for (const write of writes) this.place(write, path.scope);
      };
      program.traverse({
        AssignmentExpression: resolve,
        UpdateExpression: resolve,
        UnaryExpression: resolve,
        ForInStatement: resolve,
        ForOfStatement: resolve,
        CallExpression: resolve,
        OptionalCallExpression: resolve,
      });
    }
    for (const list of this.writes.values()) list.sort((a, b) => a.order - b.order);
  }

  /**
   * Record a write once its root and keys are settled - with `scope` when
   * the write needed one, and then a root that is an alias is followed to
   * every global it may stand for, a bare host name is a global only while
   * no binding claims it, a computed key is read as every string it may
   * hold, and a call in the chain is read as the hop it is. A write with
   * more than one reading is recorded once per reading, each marked `maybe`.
   */
  private place(write: RawWrite, scope: Scope | undefined): void {
    write.placedScope = scope;
    if (!write.reflective) {
      this.placeChain(write.root, write.keys, write, scope, false);
      return;
    }
    // The callee has to be an alias of exactly `Object.m` or `Reflect.m`;
    // anything else is a call to a function of the program's own, which is
    // a hand-off. A callee that may be either is the write it may make.
    if (!scope) return;
    const { callee, args, key } = write.reflective;
    this.placeReflective(key === undefined ? callee : t.memberExpression(callee as t.Expression, t.identifier(key)), args, write, scope, 0);
  }

  /**
   * The reflective writes a call of `callee` with `args` makes, once the
   * scope says what the callee is: `Object.m` or `Reflect.m` by any alias,
   * the constructor of a literal - `({}).constructor.defineProperty` - for
   * the `Object` it is, `Reflect.apply` held by a name for the call it
   * makes, a `bind` held by a name for its bound arguments in front, `.call`
   * and `.apply` of the method through keys the scope reads. A member of
   * `Object`, `Reflect` or `Function.prototype` the scope cannot read is
   * every method, and a may-write of every argument. A list a name holds is
   * opened; one the scope cannot open is a write of something at some key.
   */
  private placeReflective(callee: t.Node, args: readonly t.Node[], write: RawWrite, scope: Scope, depth: number): void {
    if (depth > 2) return;
    // `x[dec(0x1a)](...)`: before the key is read - a decoder run per site -
    // the holder is asked, once per binding, whether it could hold `Object`
    // or `Reflect` at all; a global that is neither holds no reflective
    // method, while a literal, a function or a value the tree cannot read
    // may. obfuscated2.js makes thousands of such calls on other globals.
    const spelled = stripTypeWrappers(callee);
    if (isMember(spelled) && stripTypeWrappers(spelled.object).type === 'Identifier') {
      const holder = originOf(spelled.object, scope, 0, []);
      const could =
        holder !== undefined &&
        (holder.other ||
          holder.functions.length > 0 ||
          holder.places.some((place) => {
            const root = throughGlobalObject(place).root;
            return root === 'Object' || root === 'Reflect' || root === CONSTRUCTOR_OF_A_VALUE || GLOBAL_OBJECT_NAMES.has(root);
          }));
      if (!could) return;
    }
    keyReader.unreadCallee = undefined;
    const origin = originOf(callee, scope, 0, []);
    // A member spelled by a call to a decoder this round could not read is judged once a later round has inlined it.
    const deferrable = keyReader.unreadCallee;
    if (!origin) return;
    const maybe = severalReadings(origin);
    /** The list `apply` is handed, opened where it is a literal. */
    const applied = (list: t.Node | undefined): t.Node[] =>
      list === undefined ? [] : list.type === 'ArrayExpression' && !list.elements.some((element) => !element || element.type === 'SpreadElement') ? (list.elements as t.Node[]) : [t.spreadElement(list as t.Expression)];
    for (const held of origin.places) {
      const place = throughGlobalObject(held);
      if (place.consumed !== 0 || place.keys.length === 0) continue;
      const reflective = place.root === 'Object' || place.root === 'Reflect' || place.root === CONSTRUCTOR_OF_A_VALUE;
      const functional = place.root === 'Function' && place.keys[0] === 'prototype' && place.keys.length > 1;
      if (!reflective && !functional) continue;
      const [first, ...through] = place.keys as [string, ...string[]];
      // `Object[k](T, d)`, `Object[k][j](Object, [T, d])`, `Function.prototype
      // .call[k](Object.assign, Object, T, d)`: a member the tree cannot read
      // on a holder of reflective methods may be any of them, `assign` and
      // `apply` among them, so every property of every argument - and of
      // every element of an array literal among them, the list `apply`
      // takes - may be written. obfuscator.io spells `Object.assign` as
      // `Object[dec(0x1)]`, and the decoder may be one this round refuses.
      // The constructor of some value is not such a holder: `''[k](x)` is
      // `''.split(x)` as the same obfuscator spells every string method.
      if (functional ? through.some((key) => !isRead(key)) : first === UNREAD_KEY || through.some((key) => !isRead(key))) {
        if (place.root === CONSTRUCTOR_OF_A_VALUE) continue;
        const opened = spreadArguments(args, scope);
        if (opened === 'unknown') {
          this.placeChain(UNKNOWN_NAME, [UNREAD_KEY], write, scope, true, deferrable);
          continue;
        }
        // What the method may write is bounded by what the methods write.
        // Every writer on `Object` and `Reflect` - `assign`, `defineProperty`,
        // `defineProperties`, `setPrototypeOf`, `set` - writes its FIRST
        // argument and reads the rest, and given one argument alone writes
        // nothing a program can name: `Object.assign(o)` copies nothing,
        // `defineProperty(o)`, `defineProperties(o)` and `setPrototypeOf(o)`
        // throw, `Reflect.set(o)` sets `o.undefined`. So `Object[k](o)` is a
        // read of `o` whatever `k` spells - `Object.keys(o)`, as obfuscator.io
        // spells it in every program - and `Object[k](a, b, c)` may write
        // `a` and nothing else. `Reflect[k](...)` keeps every argument: `set`
        // writes its receiver, the fourth, and `apply` and `construct` hand
        // a list on. So does `Object[k][j](...)`, where `j` may be `call` or
        // `apply` and the target sits one position along.
        const direct = !functional && through.length === 0;
        if (direct && opened.length <= 1) continue;
        const onObject = direct && place.root === 'Object';
        const targets = onObject ? opened.slice(0, 1) : opened;
        this.unreadMethod = true;
        try {
          for (const argument of targets) {
            const value = stripTypeWrappers(argument);
            for (const target of value.type === 'ArrayExpression' && !onObject ? value.elements : [value]) {
              if (!target || target.type === 'SpreadElement' || t.isLiteral(target) || t.isFunction(target) || t.isClass(target) || target.type === 'ObjectExpression' || target.type === 'ArrayExpression') continue;
              this.placeChain(target, [UNREAD_KEY], write, scope, true, deferrable);
            }
          }
        } finally {
          this.unreadMethod = false;
        }
        continue;
      }
      if (functional) continue;
      // The method spelled whole, or each reflective method a spelling in part fits: `Object['defineProp' + k]`.
      const methods = isRead(first) ? [first] : [...REFLECTIVE_METHODS, ...(place.root === 'Reflect' ? ['apply'] : [])].filter((name) => keyMayBe(first, name));
      // `Object[k][j](Object, [T, d])` with `j` read as `apply` or `call`: the method, with the call's own arguments.
      let list: readonly t.Node[] = args;
      if (through.length === 1 && through[0] === 'call') list = args.slice(1);
      else if (through.length === 1 && through[0] === 'apply') list = applied(args[1]);
      else if (through.length > 0) continue;
      for (const method of methods) {
        const several = maybe || methods.length > 1;
        if (place.root === 'Reflect' && method === 'apply') {
          const [target, , given] = list;
          if (target && target.type !== 'SpreadElement') this.placeReflective(target, applied(given), write, scope, depth + 1);
          continue;
        }
        // `X.constructor.defineProperty(...)`: only `Object` has the method, and `X` may be one of its instances.
        const root = place.root === CONSTRUCTOR_OF_A_VALUE && OBJECT_WRITERS.has(method) ? 'Object' : place.root;
        if (root !== 'Object' && root !== 'Reflect') continue;
        const opened = spreadArguments(list, scope);
        const written = opened === 'unknown' ? undefined : reflectiveWrite(root, method, opened);
        if (!written) {
          // `Object.defineProperty(...a)` over a list the tree cannot open: something, at some key.
          if (opened === 'unknown' && OBJECT_WRITERS.has(method)) this.placeChain(UNKNOWN_NAME, [UNREAD_KEY], write, scope, true, deferrable);
          continue;
        }
        const spine = spineOf(written.object);
        for (const written_key of written.keys) this.placeChain(spine.root, [...spine.keys, written_key], write, scope, several || root !== place.root, deferrable);
      }
    }
    // `var d = Object.defineProperty.bind(Object, String); d('fromCharCode', ...)`: the bound call, with its bound arguments first.
    const bound = boundCall(callee, write.node, scope, args);
    for (const arm of bound?.fns ?? []) this.placeReflective(arm, bound!.args, write, scope, depth + 1);
  }

  /**
   * `place` for a chain: the keys read, and one placement per combination
   * of their readings. A holder's keys - `Object.assign(X, d)` - are one
   * write each, since each is a property of its own, not a reading of one.
   */
  private placeChain(
    object: t.Node | string,
    rawKeys: readonly RawKey[],
    write: RawWrite,
    scope: Scope | undefined,
    maybe: boolean,
    deferrable?: string,
  ): void {
    keyReader.unreadCallee = deferrable;
    // A call in the chain - `(function () { return this; }).call(T).x = ...`,
    // `o.get().x = ...` - is what the call returns, which `originOf` reads
    // whole; a call it reads as no global is left to `throughCalls`.
    const called = scope && write.target && rawKeys.includes(CALLED) ? callInChain(write.target) : undefined;
    if (called && scope) {
      const prefix = literalPrefix(called.keys.slice(0, -1).map((key) => (typeof key === 'string' ? key : UNREAD_KEY)));
      const followed = originOf(called.call, scope, 0, prefix);
      if (followed && followed.places.some((place) => place.root !== UNKNOWN_NAME)) {
        const several = maybe || severalReadings(followed);
        for (const place of followed.places) {
          if (place.root === UNKNOWN_NAME) continue;
          const rest = called.keys.slice(place.consumed);
          const readings: ChainKey[][] = rest.map((key) => (typeof key === 'string' ? [key] : keyReader.read(key, write.node, scope, 0)));
          for (const keys of product(readings, MAX_KEY_COMBINATIONS)) this.placeKeys(place.root, [...place.keys, ...keys], write, scope, several, deferrable);
        }
        return;
      }
    }
    const holder = rawKeys.findIndex((key) => typeof key === 'object' && 'keysOf' in key);
    if (holder >= 0) {
      const keys = scope ? keyReader.holderKeys((rawKeys[holder] as KeysOf).keysOf, write.node, scope, 0) : [UNREAD_KEY];
      const carried = keyReader.unreadCallee;
      for (const key of keys) this.placeChain(object, [...rawKeys.slice(0, holder), key, ...rawKeys.slice(holder + 1)], write, scope, maybe, carried);
      return;
    }
    const readings: ChainKey[][] = rawKeys.map((key) =>
      typeof key === 'string' || key === CALLED ? [key] : scope ? keyReader.read(key as t.Node, write.node, scope, 0) : [UNREAD_KEY],
    );
    const unread = keyReader.unreadCallee;
    const combinations = product(readings, MAX_KEY_COMBINATIONS);
    for (const keys of combinations) this.placeKeys(object, keys, write, scope, maybe || combinations.length > 1, unread);
  }

  private placeKeys(
    object: t.Node | string,
    keys: ChainKey[],
    write: RawWrite,
    scope: Scope | undefined,
    maybe: boolean,
    deferrable: string | undefined,
  ): void {
    const { node, topLevel } = write;
    let root: string | undefined;
    if (typeof object === 'string') {
      root = object;
    } else if (object.type === 'ThisExpression') {
      // `xs.forEach(function (v, k) { this[k] = v; }, T)`: `this` in the callback is `T`.
      const receiver = scope && callbackReceiver(scope);
      if (receiver) {
        this.placeKeys(receiver.node, keys, write, receiver.scope, maybe, deferrable);
        return;
      }
      root = 'this';
    } else if (object.type === 'Identifier') {
      const name = object.name;
      if (keys.length === 0) {
        // A bare host name: bound anywhere up the chain, it is a local of
        // the program's own and not the global; `getBinding`, not
        // `hasBinding`, because the latter counts Babel's own list of
        // builtin globals as bindings.
        if (scope?.getBinding(name)) return;
        root = name;
      } else if (scope && !GLOBAL_OBJECT_NAMES.has(name)) {
        // The last key is the slot written, which no literal the name
        // holds is asked to consume: `var o = { S: String }; o.S = 5`
        // replaces what `o` holds and writes nothing on `String`.
        const prefix = literalPrefix(keys.slice(0, -1));
        const followed = name === 'arguments' && !scope.getBinding(name) ? argumentsOrigin(scope, 0, prefix) : followAlias(name, scope, 0, prefix);
        if (followed === undefined || followed.places.length === 0) {
          // A binding whose every source the scope read and found no
          // global in - a local `var Math = {}`, a parameter every caller
          // hands a literal - holds nothing the host reads, whatever it is
          // called. The name is the host's only where nothing binds it. A
          // chain that leaves the value for its prototype or constructor,
          // or one under a key the tree cannot read, is judged below by
          // where it goes: `''[k].split = ...` over a local string writes
          // `String.prototype.split` whatever the local holds.
          if (scope.getBinding(name) && !leavesForPrototype(keys) && keys.every((key) => key !== CALLED && isRead(key))) return;
          root = name;
        } else {
          const several = maybe || severalReadings(followed);
          for (const place of followed.places) {
            const rest = keys.slice(place.consumed);
            if (place.root === UNKNOWN_NAME) this.finish(UNKNOWN_NAME, rest, node, write, true, name, deferrable);
            else this.finish(place.root, [...place.keys, ...rest], node, write, several, undefined, deferrable);
          }
          return;
        }
      } else {
        root = name;
      }
    } else if (scope && keys.length > 0 && !isPrototypeRead(object)) {
      // A literal, a call or a `new` written through: what it stands for is
      // `originOf`'s question, the same as an alias's - `[Math][0].round`,
      // `(function () { return this; }).call(Math).round`, `o.get().round`.
      // The unread place is the literal's own member the tree cannot name,
      // `''[k].split`, which `finish` reads for a prototype step.
      const followed = originOf(object, scope, 0, literalPrefix(keys.slice(0, -1)));
      if (followed && followed.places.some((place) => place.root !== UNKNOWN_NAME)) {
        const several = maybe || severalReadings(followed);
        for (const place of followed.places) {
          if (place.root === UNKNOWN_NAME) continue;
          this.finish(place.root, [...place.keys, ...keys.slice(place.consumed)], node, write, several, undefined, deferrable);
        }
        if (isUnread(followed)) this.finish(rootName(object), keys, node, write, true, write.unreadObject, deferrable);
        return;
      }
      // `m.get(k).x = ...`, `f().x = ...` over a call the tree cannot open: a
      // write to something it may have been given.
      if (isUnread(followed)) {
        this.finish(UNKNOWN_NAME, keys, node, write, true, write.unreadObject ?? spellTarget(object), deferrable);
        return;
      }
      root = rootName(object);
    } else {
      root = rootName(object);
    }
    this.finish(root, keys, node, write, maybe, write.unreadObject, deferrable);
  }

  /** The chain with its root named: through the calls in it, through a prototype or constructor it leaves for, and under the global object's first key. */
  private finish(
    named: string | undefined,
    keys: ChainKey[],
    node: t.Node,
    write: RawWrite,
    maybe: boolean,
    unreadObject: string | undefined,
    deferrable: string | undefined,
    depth = 0,
  ): void {
    // A root the index cannot name - a literal, a call of the program's own
    // - still writes somewhere the chain may name below.
    const hopped = throughCalls(named ?? UNNAMED_ROOT, keys);
    if (!hopped) return;
    let root = hopped.root;
    let path = hopped.keys;

    // A chain that leaves its object for a prototype or a constructor is
    // read by where it went, whatever it started from: `''.__proto__.split`
    // starts from a literal the index cannot name and still writes
    // `String.prototype.split`; a constructor's `prototype` is a prototype.
    const through = prototypeThroughValue(path);
    if (through) {
      root = through.root;
      path = through.keys;
    }
    if (root === CONSTRUCTOR_OF_A_VALUE && path[0] === 'prototype') {
      root = PROTOTYPE_OF_A_VALUE;
      path = path.slice(1);
    }
    const record = (name: string, under: readonly string[], several: boolean): void => {
      this.record(name, under, node, write, several, unreadObject, deferrable);
    };
    if (root === UNNAMED_ROOT) {
      // `''[k].split = ...`: the only members of a literal the tree can name
      // are its prototype's and its constructor's, and an unread key may be
      // either - kept as the hop it is, in front of what follows it.
      const first = path[0];
      if (first !== undefined && !isRead(first) && path.length > 1) {
        record(PROTOTYPE_OF_A_VALUE, [UNREAD_KEY, ...path.slice(1)], true);
        record(CONSTRUCTOR_OF_A_VALUE, [UNREAD_KEY, ...path.slice(1)], true);
      }
      return;
    }
    if (GLOBAL_OBJECT_NAMES.has(root)) {
      // `globalThis.globalThis.x`, `window.self.x`: the global object still.
      while (path.length > 0 && GLOBAL_OBJECT_NAMES.has(path[0]!) && path[0] !== 'this') path = path.slice(1);
      const [first, ...rest] = path;
      if (first === undefined) return;
      if (isRead(first)) {
        // `globalThis.S.fromCharCode = ...` over `S = String`: a write through
        // the property is a write to what it holds; see `globalPropertyOrigin`.
        const followed = !NAMED_ROOTS.has(first) && rest.length > 0 && depth < 3 ? globalPropertyOrigin(first, 0, literalPrefix(rest.slice(0, -1))) : undefined;
        if (followed && followed.places.length > 0) {
          const several = maybe || severalReadings(followed);
          for (const place of followed.places) {
            const tail = rest.slice(place.consumed);
            if (place.root === UNKNOWN_NAME) this.record(UNKNOWN_NAME, tail, node, write, true, first, deferrable);
            else this.finish(place.root, [...place.keys, ...tail], node, write, several, undefined, deferrable, depth + 1);
          }
          return;
        }
        record(first, rest, maybe);
      } else if (root === 'this' && !write.topLevel) {
        return;
      } else {
        // A name spelled by nothing, or only in part - `window[k + 'n'] = ...`
        // in obfuscated2.js, a handler on the window that fits `Boolean` -
        // is the unknown name: what is spelled after it decides.
        record(UNKNOWN_NAME, rest, maybe || first !== UNREAD_KEY);
      }
    } else {
      record(root, path, maybe);
    }
  }

  private record(
    name: string,
    keys: readonly string[],
    node: t.Node,
    write: RawWrite,
    maybe: boolean,
    unreadObject: string | undefined,
    deferrable: string | undefined,
  ): void {
    const into = this.overlay ?? this.writes;
    let list = into.get(name);
    if (!list) {
      list = [];
      into.set(name, list);
    }
    list.push({ keys, node, order: write.order, maybe, unreadObject, deferrable, reflective: write.reflective !== undefined, quiet: this.unreadMethod && name === UNKNOWN_NAME && unreadObject !== undefined });
    if (deferrable !== undefined && !this.overlay) {
      let callees = this.deferred.get(write);
      if (!callees) this.deferred.set(write, (callees = new Set()));
      callees.add(deferrable);
    }
  }

  /** Every write to `name`, in program order. */
  of(name: string): readonly HostWrite[] {
    return this.writes.get(name) ?? [];
  }

  /**
   * The index as a decoder that can read its own keys sees it: every
   * write whose key is computed by a call `covers` names - a call to that
   * decoder, or to a wrapper of it - is placed again with `oracle`
   * answering those calls, and the rest stand as they are. The index
   * itself is the round's, shared by every candidate, and is not changed:
   * the writes placed again go to an overlay this returns a view of, and
   * what the key reader and the alias memos learnt while the oracle was
   * set is dropped with it, since a reading made with one candidate's
   * decoder is not the next candidate's.
   *
   * `Object[w(0x1)](o)` over a wrapper `w` of the decoder being built is
   * what obfuscator.io makes of every `Object.keys(o)`; read as a call the
   * round could not open, it deferred the decoder on its own key, which
   * nothing else ever inlined, and every string of the program stayed
   * encoded with an info line for company.
   */
  rejudged(oracle: KeyOracle, covers: (callee: string) => boolean): HostWrites {
    const again: RawWrite[] = [];
    for (const [write, callees] of this.deferred) if ([...callees].some(covers)) again.push(write);
    if (again.length === 0) return this;
    const orders = new Set(again.map((write) => write.order));
    const overlay = new Map<string, HostWrite[]>();
    for (const [name, list] of this.writes) {
      const kept = list.filter((write) => !orders.has(write.order));
      if (kept.length > 0) overlay.set(name, kept);
    }
    const reader = this.reader;
    // Every memo a reading may have gone into is set aside: an origin, a
    // holder's shape or a function's callers remembered with a key unread
    // is not what the same question answers with the key read, in either
    // direction - a target read as unknown may be a builtin once the key
    // that reaches it is read.
    const memos = { origins: originsByBinding, callers: callersByFunction, returns: returnsByFunction, shapes: reader.shapes, reader: keyReader };
    this.overlay = overlay;
    keyReader = reader;
    reader.oracle = oracle;
    reader.shapes = new WeakMap();
    originsByBinding = new WeakMap();
    callersByFunction = new WeakMap();
    returnsByFunction = new WeakMap();
    try {
      for (const write of again) {
        reader.unreadCallee = undefined;
        this.place(write, write.placedScope);
      }
    } finally {
      this.overlay = undefined;
      reader.oracle = undefined;
      reader.shapes = memos.shapes;
      reader.unreadCallee = undefined;
      originsByBinding = memos.origins;
      callersByFunction = memos.callers;
      returnsByFunction = memos.returns;
      keyReader = memos.reader;
    }
    for (const list of overlay.values()) list.sort((a, b) => a.order - b.order);
    return { of: (name) => overlay.get(name) ?? [], disclose: (what) => this.disclose(what) };
  }

  /**
   * Whether `what` is a write nothing has yet been said about this round.
   * A file with one `window[k] = ...` has hundreds of candidates that read a
   * builtin, and one sentence about the write is the whole of the news.
   */
  disclose(what: string): boolean {
    if (this.disclosed.has(what)) return false;
    this.disclosed.add(what);
    return true;
  }
}

/** The key reader of the index being built; see `KeyReader`. Per build, the way `originsByBinding` is. */
let keyReader: KeyReader;

/**
 * The one key reader: every string a computed key may hold, asked by every
 * computed access the index meets - a write target, a reflective method's
 * key, a holder's keys, an alias source, a member read off a literal. A
 * key read here is read the same way everywhere, so a spelling the reader
 * learns is learnt for every route at once.
 *
 * `*` stands for a part the tree cannot read. A literal and a `+`, a
 * `.concat` or a `.join` of readable parts are read as written, a template
 * the same way; a name is read through every source of its binding - the
 * declarator, every assignment, an appended `+=` joined onto what came
 * before, a `for (k in o)` head as the keys of `o`, a parameter as what
 * every caller of a fixed function hands it - and on through an alias, a
 * destructuring, a property of a literal or an element at a readable
 * index, `ks[i]`; a logical or a conditional is each branch, an assignment
 * in key position its value; `k.toString()`, `k.trim()`, `k.toLowerCase()`,
 * `k.toUpperCase()` and `String(k)` are read through `k`; a call to a
 * function of this file with literal arguments is put to the interpreter
 * over that function's slice. Never empty: nothing known is `[*]`.
 */
class KeyReader {
  /** Keys computed by a call, remembered per callee binding and arguments; see `readCallKey`. */
  private readonly callKeys = new Map<Binding, Map<string, string>>();
  /** Set while a write's keys are read: the function of this file whose call could not be read now. */
  unreadCallee: string | undefined;
  /** Holder shapes remembered per binding; see `holderWrites`. Swapped out while an oracle reads, since a shape read without one is not the shape read with it. */
  shapes = new WeakMap<Binding, HolderWrites>();
  /**
   * A reader of the keys a call to the decoder being built computes, set
   * for the span of `HostWriteIndex.rejudged`; see `KeyOracle`. Asked only
   * of a call the slice reader could not read, and answered only for a
   * call that reaches that decoder.
   */
  oracle: KeyOracle | undefined;

  constructor(
    private readonly program: NodePath<t.Program>,
    private readonly scans: StatementScanCache | undefined,
    private readonly strict: boolean,
    private readonly module: boolean,
  ) {}

  read(key: t.Node, at: t.Node, scope: Scope, depth: number): string[] {
    if (depth > MAX_KEY_HOPS) return [UNREAD_KEY];
    const node = stripTypeWrappers(key);
    const literal = staticString(node);
    if (literal !== undefined) return [literal];
    if (t.isNumericLiteral(node)) return [String(node.value)];
    if (t.isBinaryExpression(node) && node.operator === '+' && t.isExpression(node.left)) {
      return addSpellings(this.read(node.left, at, scope, depth + 1), this.read(node.right, at, scope, depth + 1), spellsString(node.left) || spellsString(node.right));
    }
    if (t.isBinaryExpression(node) && NUMERIC_OPERATORS.has(node.operator) && t.isExpression(node.left)) {
      return arithmeticSpellings(node.operator, this.read(node.left, at, scope, depth + 1), this.read(node.right, at, scope, depth + 1));
    }
    if (t.isUnaryExpression(node) && (node.operator === '+' || node.operator === '-' || node.operator === '~')) {
      return arithmeticSpellings(node.operator, ['0'], this.read(node.argument, at, scope, depth + 1));
    }
    if (t.isUpdateExpression(node) && t.isIdentifier(node.argument)) {
      // `T[i++]` reads `i` as it stands; `T[++i]` one past it.
      const held = this.read(node.argument, at, scope, depth + 1);
      return node.prefix ? arithmeticSpellings(node.operator === '++' ? '+' : '-', held, ['1']) : held;
    }
    if (t.isTemplateLiteral(node)) {
      let spellings = [node.quasis[0]?.value.cooked ?? UNREAD_KEY];
      for (let i = 0; i < node.expressions.length; i++) {
        const expression = node.expressions[i]!;
        const part = t.isExpression(expression) ? this.read(expression, at, scope, depth + 1) : [UNREAD_KEY];
        spellings = joinSpellings(joinSpellings(spellings, part), [node.quasis[i + 1]?.value.cooked ?? UNREAD_KEY]);
      }
      return spellings;
    }
    if (t.isSequenceExpression(node)) {
      const last = node.expressions[node.expressions.length - 1];
      return last ? this.read(last, at, scope, depth + 1) : [UNREAD_KEY];
    }
    if (t.isObjectMethod(node)) {
      // `{ get k() { return 'round'; } }` read as `o.k`: what the getter returns.
      if (node.kind !== 'get') return [UNREAD_KEY];
      let spellings: string[] = [];
      for (const returned of ownReturns(node)) spellings = unionSpellings(spellings, this.read(returned, at, scope, depth + 1));
      return spellings.length === 0 ? [UNREAD_KEY] : spellings;
    }
    if (t.isAssignmentExpression(node)) {
      // `Math[k = 'round']`: the key is what is assigned; `Math[k += 'd']`
      // what `k` held with the right joined on.
      if (node.operator === '=') return this.read(node.right, at, scope, depth + 1);
      if (node.operator !== '+=' || !t.isIdentifier(node.left)) return [UNREAD_KEY];
      return addSpellings(this.read(node.left, at, scope, depth + 1), this.read(node.right, at, scope, depth + 1), spellsString(node.right));
    }
    if (t.isLogicalExpression(node)) {
      // A string literal on the left decides; anything else is both branches.
      const left = stripTypeWrappers(node.left);
      if (t.isStringLiteral(left)) {
        const taken = node.operator === '??' || (node.operator === '||') === left.value.length > 0;
        return taken ? [left.value] : this.read(node.right, at, scope, depth + 1);
      }
      return unionSpellings(this.read(node.left, at, scope, depth + 1), this.read(node.right, at, scope, depth + 1));
    }
    if (t.isConditionalExpression(node)) {
      const test = literalTruthiness(node.test);
      if (test) return this.read(test.truthy ? node.consequent : node.alternate, at, scope, depth + 1);
      return unionSpellings(this.read(node.consequent, at, scope, depth + 1), this.read(node.alternate, at, scope, depth + 1));
    }
    if (t.isIdentifier(node)) {
      if (node.name === 'undefined' && !scope.getBinding('undefined')) return ['undefined'];
      const sources = keySources(node.name, at, scope);
      if (sources === 'unknown') return [UNREAD_KEY];
      let spellings: string[] = [];
      for (const source of sources) {
        if (source === 'unknown') {
          spellings = unionSpellings(spellings, [UNREAD_KEY]);
        } else if (source.appended) {
          // `k += 'und'`: what `k` held before, with the right joined on. Every
          // reading so far is a candidate for "before", which is more than
          // the program has and never less.
          spellings = unionSpellings(spellings, addSpellings(spellings, this.read(source.node, source.at, source.scope, depth + 1), spellsString(source.node)));
        } else if (source.keysOf) {
          spellings = unionSpellings(spellings, this.holderKeys(source.node, source.at, source.scope, depth + 1));
        } else {
          spellings = unionSpellings(spellings, this.read(source.node, source.at, source.scope, depth + 1));
        }
      }
      return spellings.length === 0 ? [UNREAD_KEY] : spellings;
    }
    if (isMember(node)) {
      // `o.k` over `var o = { k: 'round' }`, `o.a.k`, `ks[0]`, `ks[i]` with a
      // readable `i`: the property the literal gives the key.
      if (t.isIdentifier(node.object, { name: 'arguments' }) && !scope.getBinding('arguments')) {
        // `Math[arguments[0]] = ...`: what every caller hands the function there.
        const property = literalKey(node);
        if (property === UNREAD_KEY) return [UNREAD_KEY];
        const sources = argumentSources(scope, property);
        if (!sources) return [UNREAD_KEY];
        let spellings: string[] = [];
        for (const source of sources) {
          spellings = unionSpellings(spellings, source === 'unknown' ? [UNREAD_KEY] : this.read(source.node, source.node, source.scope, depth + 1));
        }
        return spellings.length === 0 ? [UNREAD_KEY] : spellings;
      }
      const properties = this.memberKeys(node, at, scope, depth);
      const held = this.literalValues(node.object, at, scope, depth);
      if (held === 'unknown') return [UNREAD_KEY];
      let spellings: string[] = [];
      for (const property of properties) {
        if (property === UNREAD_KEY) return [UNREAD_KEY];
        for (const literal of held) {
          const picked = t.isObjectExpression(literal.node) ? literalProperty(literal.node, property) : literalElement(literal.node, property);
          spellings = unionSpellings(
            spellings,
            picked && picked !== 'unknown' ? this.read(picked, literal.at, literal.scope, depth + 1) : [UNREAD_KEY],
          );
        }
      }
      return spellings.length === 0 ? [UNREAD_KEY] : spellings;
    }
    if (t.isCallExpression(node)) {
      const callee = stripTypeWrappers(node.callee);
      if (isMember(callee)) {
        const method = propertyKey(callee);
        const through = READ_THROUGH_METHODS.get(method);
        if (node.arguments.length === 0 && through) return unionSpellings([], this.read(callee.object, at, scope, depth + 1).map(through));
        const cut = CUT_METHODS.get(method);
        if (cut) {
          const args = literalArguments(node.arguments);
          if (!args) return [UNREAD_KEY];
          return unionSpellings([], this.read(callee.object, at, scope, depth + 1).map((spelling) => (isRead(spelling) ? (cut(spelling, args) ?? UNREAD_KEY) : UNREAD_KEY)));
        }
        if (method === 'concat' && node.arguments.every((argument) => t.isExpression(argument))) {
          let spellings = this.read(callee.object, at, scope, depth + 1);
          for (const argument of node.arguments) spellings = joinSpellings(spellings, this.read(argument, at, scope, depth + 1));
          return spellings;
        }
        if (method === 'join' && node.arguments.length <= 1) {
          // `['fromChar', 'Code'].join('')`: the parts, joined by the separator.
          const separator = node.arguments[0] ? this.read(node.arguments[0], at, scope, depth + 1) : [','];
          const arrays = this.literalValues(callee.object, at, scope, depth);
          if (arrays === 'unknown') return [UNREAD_KEY];
          let spellings: string[] = [];
          for (const array of arrays) {
            if (!t.isArrayExpression(array.node)) return [UNREAD_KEY];
            let joined = [''];
            for (let index = 0; index < array.node.elements.length; index++) {
              const element = array.node.elements[index];
              if (!element || t.isSpreadElement(element)) return [UNREAD_KEY];
              if (index > 0) joined = joinSpellings(joined, separator);
              joined = joinSpellings(joined, this.read(element, array.at, array.scope, depth + 1));
            }
            spellings = unionSpellings(spellings, joined);
          }
          return spellings.length === 0 ? [UNREAD_KEY] : spellings;
        }
        return [UNREAD_KEY];
      }
      if (node.arguments.length === 1 && t.isIdentifier(callee, { name: 'String' }) && !scope.getBinding('String')) {
        return this.read(node.arguments[0]!, at, scope, depth + 1);
      }
      if (t.isIdentifier(callee)) return [this.readCallKey(callee, node.arguments, scope)];
    }
    return [UNREAD_KEY];
  }

  /** The readings of a member's key: the property name, or every string a computed key may hold. */
  private memberKeys(member: t.MemberExpression | t.OptionalMemberExpression, at: t.Node, scope: Scope, depth: number): string[] {
    const property = literalKey(member);
    if (property !== UNREAD_KEY || !member.computed) return [property];
    return this.read(member.property, at, scope, depth + 1);
  }

  /**
   * The object or array literals an expression may be, for a key read off
   * one: a literal itself, a name through every source of its binding, a
   * property of a literal that is one, the arrays `Object.keys`, `values`
   * and `entries` make of a holder. `unknown` when any value may be
   * something else.
   */
  literalValues(node: t.Node, at: t.Node, scope: Scope, depth: number): LiteralValue[] | 'unknown' {
    if (depth > MAX_KEY_HOPS) return 'unknown';
    const value = stripTypeWrappers(node);
    if (t.isObjectExpression(value) || t.isArrayExpression(value)) return [{ node: value, at, scope }];
    if (t.isIdentifier(value)) {
      const sources = keySources(value.name, at, scope);
      if (sources === 'unknown') return 'unknown';
      const values: LiteralValue[] = [];
      for (const source of sources) {
        if (source === 'unknown' || source.appended || source.keysOf) return 'unknown';
        const held = this.literalValues(source.node, source.at, source.scope, depth + 1);
        if (held === 'unknown') return 'unknown';
        values.push(...held);
      }
      return values;
    }
    if (isMember(value)) {
      const properties = this.memberKeys(value, at, scope, depth);
      const containers = this.literalValues(value.object, at, scope, depth + 1);
      if (containers === 'unknown') return 'unknown';
      const values: LiteralValue[] = [];
      for (const property of properties) {
        if (property === UNREAD_KEY) return 'unknown';
        for (const container of containers) {
          const picked = t.isObjectExpression(container.node) ? literalProperty(container.node, property) : literalElement(container.node, property);
          if (!picked || picked === 'unknown') return 'unknown';
          const held = this.literalValues(picked, container.at, container.scope, depth + 1);
          if (held === 'unknown') return 'unknown';
          values.push(...held);
        }
      }
      return values;
    }
    if (t.isCallExpression(value)) {
      const listed = holderList(value, at, scope, depth);
      return listed ? [{ node: listed, at, scope }] : 'unknown';
    }
    return 'unknown';
  }

  /**
   * Every key a holder may have at `at`, for `Object.assign(X, d)`,
   * `defineProperties(X, d)`, `{ ...d }` and `for (k in d)`: the literal's
   * own keys and every key written through the name - `d.k = ...`, `d[k] =
   * ...`, `Object.assign(d, ...)`, `defineProperty(d, k, ...)`, `this.k = ...` in a
   * method of its own, the writes through an alias and through a parameter
   * of a fixed function it is handed to - with `*` when a key could not be
   * read or something may have added one the tree cannot see: a call it
   * cannot open, a method that is not the literal's own.
   */
  holderKeys(node: t.Node, at: t.Node, scope: Scope, depth: number): string[] {
    const shape = this.holderShape(node, at, scope, depth);
    if (shape === 'unknown') return [UNREAD_KEY];
    const keys = [...shape.keys.keys()];
    if (shape.unread && !keys.includes(UNREAD_KEY)) keys.push(UNREAD_KEY);
    return keys.length === 0 ? [] : keys;
  }

  /** Shape questions open at once; see `holderShape`. */
  private nesting = 0;

  /**
   * The keys of a holder and, per key, the values it may hold; see `holderKeys`.
   *
   * `depth` bounds one chain of aliases. It does not bound the questions
   * a chain opens along the way: the writes through a binding read their
   * keys afresh, and a key spelled by a member of a holder that is itself
   * a source of the first binding asks the first question again at depth
   * zero. obfuscator.io 0.x's rc4 build overflowed the stack on exactly
   * that cycle - the decoder's cache object written through the decoder,
   * keyed by a read through the decoder - so the questions open at once
   * are counted too, and past the bound a holder is unread.
   */
  holderShape(node: t.Node, at: t.Node, scope: Scope, depth: number): HolderShape | 'unknown' {
    if (depth > MAX_ALIAS_DEPTH || this.nesting > MAX_SHAPE_NESTING) return 'unknown';
    this.nesting++;
    try {
      return this.shapeOf(node, at, scope, depth);
    } finally {
      this.nesting--;
    }
  }

  private shapeOf(node: t.Node, at: t.Node, scope: Scope, depth: number): HolderShape | 'unknown' {
    const value = stripTypeWrappers(node);
    const shape: HolderShape = { keys: new Map(), unread: false };
    const add = (key: string, held: t.Node | 'unknown', where: Scope): void => {
      if (key === UNREAD_KEY) shape.unread = true;
      let list = shape.keys.get(key);
      if (!list) shape.keys.set(key, (list = []));
      list.push({ node: held, scope: where });
    };
    const merge = (other: HolderShape | 'unknown'): void => {
      if (other === 'unknown') {
        shape.unread = true;
        return;
      }
      for (const [key, held] of other.keys) for (const each of held) add(key, each.node, each.scope);
      shape.unread ||= other.unread;
    };
    switch (value.type) {
      case 'ObjectExpression':
        for (const property of value.properties) {
          if (property.type === 'SpreadElement') {
            merge(this.holderShape(property.argument, at, scope, depth + 1));
            continue;
          }
          const keys = !property.computed && property.key.type === 'Identifier' ? [property.key.name] : this.read(property.key, at, scope, depth + 1);
          for (const key of keys) add(key, property.type === 'ObjectProperty' ? property.value : property, scope);
        }
        for (const [key, held] of thisWrites(value, scope)) add(key, held, scope);
        return shape;
      case 'ArrayExpression':
        for (let index = 0; index < value.elements.length; index++) {
          const element = value.elements[index];
          if (!element || element.type === 'SpreadElement') {
            shape.unread = true;
            break;
          }
          add(String(index), element, scope);
        }
        return shape;
      case 'SequenceExpression': {
        const last = value.expressions[value.expressions.length - 1];
        return last ? this.holderShape(last, at, scope, depth + 1) : 'unknown';
      }
      case 'ConditionalExpression': {
        const test = literalTruthiness(value.test);
        if (test) return this.holderShape(test.truthy ? value.consequent : value.alternate, at, scope, depth + 1);
        merge(this.holderShape(value.consequent, at, scope, depth + 1));
        merge(this.holderShape(value.alternate, at, scope, depth + 1));
        return shape;
      }
      case 'LogicalExpression':
        merge(this.holderShape(value.left, at, scope, depth + 1));
        merge(this.holderShape(value.right, at, scope, depth + 1));
        return shape;
      case 'AssignmentExpression':
        // `Object.assign(P, d = { ... })`: the value assigned, and whatever is
        // written through the name besides.
        if (value.operator !== '=') return 'unknown';
        merge(this.holderShape(value.right, at, scope, depth + 1));
        if (t.isIdentifier(value.left)) merge(this.heldShape(value.left.name, at, scope, depth, false));
        return shape;
      case 'Identifier':
        return this.heldShape(value.name, at, scope, depth, true);
      case 'SpreadElement': {
        // `Object.assign(X, ...xs)` over an array the tree can enumerate: every element's keys.
        const arrays = this.literalValues(value.argument, at, scope, depth + 1);
        if (arrays === 'unknown') return 'unknown';
        for (const array of arrays) {
          if (!t.isArrayExpression(array.node)) return 'unknown';
          for (const element of array.node.elements) {
            if (!element || t.isSpreadElement(element)) return 'unknown';
            merge(this.holderShape(element, array.at, array.scope, depth + 1));
          }
        }
        return shape;
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const made = objectMethodCall(value, scope);
        if (made) {
          const { method, args } = made;
          const [first, ...rest] = args;
          // The methods that return their first argument, with what `assign` adds.
          if (first && RETURNS_TARGET.has(method) && !t.isSpreadElement(first)) {
            merge(this.holderShape(first, at, scope, depth + 1));
            if (method === 'assign') {
              for (const source of rest) {
                if (t.isSpreadElement(source)) shape.unread = true;
                else merge(this.holderShape(source, at, scope, depth + 1));
              }
            } else if (method === 'defineProperty') {
              const [, key, descriptor] = args;
              for (const spelled of key ? this.read(key, at, scope, depth + 1) : [UNREAD_KEY]) add(spelled, descriptorValue(descriptor), scope);
            } else if (method === 'defineProperties') {
              const [, descriptors] = args;
              const described = descriptors ? this.holderShape(descriptors, at, scope, depth + 1) : 'unknown';
              if (described === 'unknown') shape.unread = true;
              else for (const [key, held] of described.keys) for (const each of held) add(key, descriptorValue(each.node), each.scope);
            } else if (method === 'setPrototypeOf') {
              shape.unread = true;
            }
            return shape;
          }
          if (method === 'create') return 'unknown';
        }
        // `m.get(k)`, `ds.pop()`: an element of a Map or an array the tree can list.
        const callee = stripTypeWrappers(value.callee);
        if (isMember(callee) && ELEMENT_METHODS.has(propertyKey(callee))) {
          const elements = arrayElements(callee.object, at, scope);
          if (!elements) return 'unknown';
          for (const element of elements) {
            if (element === 'unknown') shape.unread = true;
            else merge(this.holderShape(element, at, scope, depth + 1));
          }
          return shape;
        }
        // What a function of this file returns.
        const targets = calleeTargets(value, scope);
        if (targets.escapes || targets.functions.length === 0) return 'unknown';
        for (const fn of targets.functions) {
          const returns = returnsOf(fn);
          if (!returns) return 'unknown';
          for (const returned of returns) merge(this.holderShape(returned.node, returned.node, returned.scope, depth + 1));
        }
        return shape;
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        // `ds[0]`: the element, with the writes made on it through the container.
        const properties = this.memberKeys(value, at, scope, depth);
        const containers = this.literalValues(value.object, at, scope, depth + 1);
        if (containers === 'unknown') return 'unknown';
        for (const property of properties) {
          if (property === UNREAD_KEY) return 'unknown';
          for (const container of containers) {
            const picked = t.isObjectExpression(container.node) ? literalProperty(container.node, property) : literalElement(container.node, property);
            if (!picked || picked === 'unknown') return 'unknown';
            merge(this.holderShape(picked, container.at, container.scope, depth + 1));
          }
        }
        const object = stripTypeWrappers(value.object);
        if (t.isIdentifier(object)) {
          const binding = scope.getBinding(object.name);
          const written = binding ? this.holderWrites(binding, 0) : undefined;
          if (!written) return 'unknown';
          if (written.escapes) shape.unread = true;
          for (const write of written.writes) {
            if (write.keys.length !== 2) continue;
            if (write.deferrable !== undefined) this.unreadCallee ??= write.deferrable;
            const [first, second] = write.keys;
            if (!first!.some((key) => properties.some((property) => keyMayBe(key, property)))) continue;
            for (const key of second!) add(key, write.value, write.scope);
          }
        }
        return shape;
      }
      default:
        return 'unknown';
    }
  }

  /** `holderShape` for a name: every source of its binding, and every write through it. */
  private heldShape(name: string, at: t.Node, scope: Scope, depth: number, withSources: boolean): HolderShape | 'unknown' {
    const binding = scope.getBinding(name);
    if (!binding) return 'unknown';
    // A binding whose shape is being read is a cycle when it comes up
    // again under its own question, and a cycle read on is not one
    // reading deeper but every reading, `MAX_SHAPE_NESTING` times over: on
    // obfuscator.io 0.x's rc4 build the walk under the bound took forty
    // seconds. What the cycle would add is what is already being read.
    if (this.open.has(binding)) return 'unknown';
    this.open.add(binding);
    try {
      return this.shapeHeld(binding, name, depth, withSources);
    } finally {
      this.open.delete(binding);
    }
  }

  /** Bindings whose `heldShape` is open; see there. */
  private readonly open = new Set<Binding>();

  private shapeHeld(binding: Binding, name: string, depth: number, withSources: boolean): HolderShape | 'unknown' {
    const shape: HolderShape = { keys: new Map(), unread: false };
    const merge = (other: HolderShape | 'unknown'): void => {
      if (other === 'unknown') {
        shape.unread = true;
        return;
      }
      for (const [key, held] of other.keys) {
        let list = shape.keys.get(key);
        if (!list) shape.keys.set(key, (list = []));
        list.push(...held);
      }
      shape.unread ||= other.unread;
    };
    if (withSources) {
      const sources = binding.kind === 'param' ? paramSources(binding, []).sources : bindingSources(binding, name);
      if (binding.kind === 'param' && paramSources(binding, []).consumed > 0) return 'unknown';
      for (const source of sources) {
        if (source === 'unknown' || source.appended) merge('unknown');
        else if (source.keysOf) merge('unknown');
        else merge(this.holderShape(source.node, source.node, source.scope, depth + 1));
      }
    }
    const written = this.holderWrites(binding, 0);
    if (written.escapes) shape.unread = true;
    for (const write of written.writes) {
      if (write.keys.length !== 1) continue;
      if (write.deferrable !== undefined) this.unreadCallee ??= write.deferrable;
      for (const key of write.keys[0]!) {
        if (key === UNREAD_KEY) shape.unread = true;
        let list = shape.keys.get(key);
        if (!list) shape.keys.set(key, (list = []));
        list.push({ node: write.value, scope: write.scope });
      }
    }
    return shape;
  }

  /**
   * Every write the program makes through a binding to the object it holds
   * - `d.k = ...`, `d[k] = ...`, `d.a.b = ...`, `Object.assign(d, ...)`,
   * `defineProperty(d, k, ...)`, `Reflect.set(d, k, ...)`, the same through an
   * alias and through a parameter of a fixed function the name is handed
   * to - with the keys of each read, and whether the object escapes to
   * something that may write it unseen: a call the tree cannot open, a
   * method that is not the literal's own, a place in an array or another
   * object, a `return`. Remembered per binding for one build.
   */
  holderWrites(binding: Binding, depth: number): HolderWrites {
    const remembered = this.shapes.get(binding);
    if (remembered) return remembered;
    const found: HolderWrites = { writes: [], escapes: false };
    // Set before the walk: a holder aliased to itself is a cycle.
    this.shapes.set(binding, found);
    if (depth > MAX_ALIAS_DEPTH) {
      found.escapes = true;
      return found;
    }
    const own = new Set<string>();
    /** An array literal, or a Map or a Set, has methods of its own that the tree reads; a literal object's own are the ones it spells. */
    let collection = false;
    if (binding.path.isVariableDeclarator()) {
      const init = binding.path.node.init && stripTypeWrappers(binding.path.node.init);
      if (init?.type === 'ObjectExpression') for (const property of init.properties) if (property.type !== 'SpreadElement') own.add(methodKey(property) ?? UNREAD_KEY);
      const made = init?.type === 'NewExpression' ? stripTypeWrappers(init.callee) : undefined;
      collection = init?.type === 'ArrayExpression' || (made?.type === 'Identifier' && COLLECTIONS.has(made.name) && !binding.scope.getBinding(made.name));
    } else if (binding.kind === 'param') {
      // A parameter every caller hands an array literal is an array.
      const { sources } = paramSources(binding, []);
      collection = sources.length > 0 && sources.every((source) => source !== 'unknown' && stripTypeWrappers(source.node).type === 'ArrayExpression');
    }
    // `d.f = g`, then `d.f(...)`: a method the holder was given is its own,
    // and what it writes through `this` is the holder's - obfuscator.io's
    // decoder keeps its base64 helper and its cache on itself this way.
    const given = new Map<string, t.Function[]>();
    for (const reference of binding.referencePaths) {
      const member = reference.parentPath;
      const assignment = member?.parentPath;
      if (!member || !isMemberPath(member) || member.node.object !== reference.node || !assignment?.isAssignmentExpression()) continue;
      if (assignment.node.left !== member.node || assignment.node.operator !== '=') continue;
      const key = propertyKey(member.node);
      const fn = spelledFunction(assignment.node.right, assignment.scope);
      if (key === UNREAD_KEY || !fn) continue;
      let list = given.get(key);
      if (!list) given.set(key, (list = []));
      list.push(fn);
    }
    for (const reference of binding.referencePaths) {
      const parent = reference.parentPath;
      if (!parent) continue;
      if (isMemberPath(parent) && parent.node.object === reference.node) {
        // The chain written or called: `d.a.b = ...`, `d.f(...)`. The keys are
        // read only for a write - a read costs nothing, and a holder read a
        // thousand times under a decoded key is not asked a thousand times.
        let top: NodePath = parent;
        const members: NodePath<t.MemberExpression | t.OptionalMemberExpression>[] = [parent];
        for (;;) {
          const above = top.parentPath;
          if (!above || !isMemberPath(above) || above.node.object !== top.node) break;
          top = above;
          members.push(above);
        }
        const use = top.parentPath;
        if (!use) continue;
        const written =
          (use.isAssignmentExpression() && use.node.left === top.node) ||
          use.isUpdateExpression() ||
          ((use.isForInStatement() || use.isForOfStatement()) && use.node.left === top.node) ||
          use.isArrayPattern() ||
          use.isRestElement() ||
          use.isAssignmentPattern() ||
          (use.isObjectProperty() && use.parentPath.isObjectPattern());
        if (written) {
          // The callee a key could not be read through is kept with the
          // write, since the writes are remembered and read again without
          // reading the keys.
          const before = this.unreadCallee;
          this.unreadCallee = undefined;
          const chain = members.map((member) => this.memberKeys(member.node, member.node, member.scope, 0));
          const deferrable = this.unreadCallee;
          this.unreadCallee = before ?? deferrable;
          const plain = use.isAssignmentExpression() && (use.node.operator === '=' || use.node.operator === '||=' || use.node.operator === '&&=' || use.node.operator === '??=');
          found.writes.push({ keys: chain, value: plain ? use.node.right : 'unknown', scope: use.scope, deferrable });
        } else if ((use.isCallExpression() || use.isOptionalCallExpression()) && use.node.callee === top.node) {
          // A method of the literal's own writes through `this`, which the
          // literal's shape already counts; an array's own that adds what it
          // is given is a write of that at some slot, one that only takes
          // away or reorders writes nothing new; any other method may write
          // anything.
          const method = members.length === 1 ? propertyKey(parent.node) : UNREAD_KEY;
          if (own.has(method) || (collection && ARRAY_KEEPS_ELEMENTS.has(method))) continue;
          const methods = given.get(method);
          if (methods) {
            for (const fn of methods) {
              for (const [key, held] of methodThisWrites(fn, use.scope)) found.writes.push({ keys: [[key]], value: held, scope: use.scope, deferrable: undefined });
            }
            continue;
          }
          // A method of an array the tree cannot name, `xs[dec(0x1a)](...)`, may be `push`: whatever it was given is in the array.
          const adds = collection ? (method === UNREAD_KEY ? 0 : ARRAY_ADDS_ARGUMENTS.get(method)) : undefined;
          if (adds === undefined) {
            found.escapes = true;
            continue;
          }
          for (const argument of use.node.arguments.slice(adds)) {
            found.writes.push({ keys: [[UNREAD_KEY]], value: argument.type === 'SpreadElement' ? 'unknown' : argument, scope: use.scope, deferrable: undefined });
          }
        }
        continue;
      }
      if (parent.isVariableDeclarator() && parent.node.init === reference.node) {
        // `var { f } = d` reads the holder; `var e = d` names it.
        if (parent.node.id.type !== 'Identifier') continue;
        const alias = parent.scope.getBinding(parent.node.id.name);
        if (alias && alias.path.node === parent.node) this.mergeWrites(found, this.holderWrites(alias, depth + 1));
        else found.escapes = true;
        continue;
      }
      if (parent.isAssignmentExpression() && parent.node.right === reference.node && parent.node.operator === '=' && parent.node.left.type === 'Identifier') {
        const alias = parent.scope.getBinding(parent.node.left.name);
        if (alias) this.mergeWrites(found, this.holderWrites(alias, depth + 1));
        else found.escapes = true;
        continue;
      }
      if (parent.isCallExpression() || parent.isOptionalCallExpression() || parent.isNewExpression()) {
        // Called or constructed, the holder's own properties are untouched; handed over, they may not be.
        if (parent.node.callee !== reference.node) this.handedWrites(found, reference, parent, depth, collection);
        continue;
      }
      if (parent.isArrayExpression()) {
        // `f.apply(t, [d])`, `Reflect.apply(f, t, [d])`: the list `invocation` opens, which hands `d` over as it stands.
        const call = parent.parentPath;
        if (call && (call.isCallExpression() || call.isOptionalCallExpression()) && (call.node.arguments as t.Node[]).includes(parent.node)) {
          this.handedWrites(found, reference, call, depth, collection);
          continue;
        }
      }
      if (isHolderRead(parent, reference.node, collection)) continue;
      found.escapes = true;
    }
    return found;
  }

  private mergeWrites(into: HolderWrites, from: HolderWrites): void {
    into.writes.push(...from.writes);
    into.escapes ||= from.escapes;
  }

  /** A holder handed to a call: a reflective write of its properties, a read, or a parameter of a fixed function whose writes are followed. */
  private handedWrites(
    found: HolderWrites,
    reference: NodePath,
    call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
    depth: number,
    collection: boolean,
  ): void {
    const spelled = stripTypeWrappers(call.node.callee);
    const spelledSpine = isMember(spelled) ? memberSpine(spelled) : undefined;
    const given = spreadArguments(call.node.arguments, call.scope);
    const at = given === 'unknown' ? -1 : given.indexOf(reference.node);
    // An array handed as the list of `f.apply(t, xs)` or `Reflect.apply(f, t, xs)` gives its elements away and keeps them.
    if (collection && isMember(spelled) && (spelledSpine?.root === 'Reflect' && spelledSpine.keys[0] === 'apply' ? at === 2 : propertyKey(spelled) === 'apply' && at === 1)) return;
    // The call as `invocation` opens it: `Object.keys.call(null, d)` hands `d` to `Object.keys` first.
    const invoked = invocation(call.node.callee, undefined, call.node.arguments, 0);
    const args = invoked ? spreadArguments(invoked.args, call.scope) : 'unknown';
    const index = args === 'unknown' ? -1 : args.indexOf(reference.node);
    if (!invoked || args === 'unknown' || index < 0 || invoked.fns.length !== 1) {
      found.escapes = true;
      return;
    }
    const callee = stripTypeWrappers(invoked.fns[0]!);
    const spine = isMember(callee) ? memberSpine(callee) : undefined;
    if (spine && (spine.root === 'Object' || spine.root === 'Reflect') && spine.keys.length === 1 && call.node.type !== 'NewExpression') {
      const method = spine.keys[0]!;
      if (index > 0) {
        // A source of `assign`, a descriptor of `defineProperties`, an
        // argument of `keys`: read, not written.
        if (!(method === 'setPrototypeOf' || method === 'defineProperty' || method === 'set')) return;
        found.escapes = true;
        return;
      }
      if (HOLDER_READS.has(method)) return;
      // A method that gives the holder back, `var p = Object.freeze(d)`,
      // names it again under a name this does not follow.
      if (RETURNS_TARGET.has(method) && !call.parentPath.isExpressionStatement()) found.escapes = true;
      if (method === 'freeze' || method === 'seal' || method === 'preventExtensions') return;
      const written = reflectiveWrite(spine.root as 'Object' | 'Reflect', method, args);
      if (!written) {
        found.escapes = true;
        return;
      }
      for (const key of written.keys) {
        const readings = this.rawKey(key, call.node, call.scope);
        found.writes.push({ keys: [readings], value: 'unknown', scope: call.scope, deferrable: this.unreadCallee });
      }
      return;
    }
    if (spine && spine.keys.length === 1 && HOLDER_READS.has(`${spine.root}.${spine.keys[0]}`)) return;
    if (callee.type === 'Identifier' && HOLDER_READS.has(callee.name) && !call.scope.getBinding(callee.name)) return;
    // A function of this file: what it writes through its parameter.
    const targets = calleeTargets(call.node, call.scope);
    if (targets.escapes || targets.functions.length === 0) {
      found.escapes = true;
      return;
    }
    for (const fn of targets.functions) {
      const param = fn.params[index];
      const scope = traverse.cache.scope.get(fn);
      const name = param && param.type === 'Identifier' ? param.name : undefined;
      const binding = name !== undefined && scope ? scope.getBinding(name) : undefined;
      if (!binding || binding.kind !== 'param') {
        found.escapes = true;
        continue;
      }
      this.mergeWrites(found, this.holderWrites(binding, depth + 1));
    }
  }

  /** The readings of a chain key as the walk left it: a spelling, the unread call, a holder's keys, or an expression read here. */
  rawKey(key: RawKey, at: t.Node, scope: Scope): string[] {
    if (typeof key === 'string') return [key];
    if (key === CALLED) return [UNREAD_KEY];
    if ('keysOf' in key) return this.holderKeys(key.keysOf, at, scope, 0);
    return this.read(key, at, scope, 0);
  }

  /**
   * `k(0)` over `var t = ['fromCharCode']; function k(i) { return t[i]; }`:
   * the key a decoder over a literal table computes, read by the interpreter
   * over the callee's slice. Only a slice that reads nothing outside itself
   * qualifies - no builtin, no host name - so the answer rests on the
   * interpreter and the literals alone, and a slice that is too much work
   * for a small budget is unread rather than waited for: obfuscated2.js's
   * `Math[dec(0x657b) + 'p']` calls the very decoder being built, whose
   * slice reads `String` and `parseInt`, and is refused here before a step
   * is run - and is then put to the decoder's own tier, once one is built,
   * by the `oracle` `HostWriteIndex.rejudged` sets; see `KeyOracle`.
   */
  private readCallKey(callee: t.Identifier, args: readonly t.Node[], scope: Scope): string {
    // `var s = b; String[s(0)]`: the alias is followed to the function it names.
    const targets = calleeTargets(t.callExpression(callee, []), scope);
    // `k()` over `function k() { return 'round'; }` takes nothing and is read like a call with literals.
    const literal = args.length === 0 ? [] : literalArguments(args);
    if (targets.escapes || targets.functions.length !== 1) {
      // A name the scope reads to several functions is still the decoder's
      // when its binding is: obfuscator.io's decoder replaces its own
      // binding on first call, and the oracle knows the binding.
      const bound = this.oracle && literal !== null ? scope.getBinding(callee.name) : undefined;
      if (bound && literal !== null) {
        const answered = this.oracle!(bound, callee.name, literal);
        if (answered !== undefined) return answered;
      }
      return UNREAD_KEY;
    }
    const fn = targets.functions[0]!;
    const name = fn.type === 'FunctionDeclaration' ? fn.id?.name : declaredName(fn);
    const binding = name === undefined ? undefined : (traverse.cache.scope.get(fn)?.parent ?? scope).getBinding(name);
    if (!name || !binding) return UNREAD_KEY;
    if (literal === null) return UNREAD_KEY;
    // The slice is taken by name from the top of the program: a function
    // bound anywhere below it - `var q = function () {...}` inside `setup`,
    // shadowing a `q` at the top - is not the one the slice would hold.
    const sliceable = binding.scope.block === this.program.node;
    const memo = this.callKeys.get(binding) ?? new Map<string, string>();
    this.callKeys.set(binding, memo);
    // A slice refused once is refused for every argument; obfuscated2.js
    // writes through its decoders' calls at seventeen sites, and the slice
    // of one carries the whole table.
    const key = memo.has(SLICE_UNREAD) ? SLICE_UNREAD : JSON.stringify(literal);
    let remembered = memo.get(key);
    if (remembered === undefined) {
      const evaluated = sliceable ? this.evaluateCallKey(name, literal) : UNREAD_KEY;
      remembered = evaluated ?? UNREAD_KEY;
      memo.set(evaluated === null ? SLICE_UNREAD : key, remembered);
    }
    if (remembered === UNREAD_KEY && this.oracle) {
      // The decoder being built, or a wrapper of it, computes the key: its
      // own tier reads it. Not remembered here - the memo is the round's,
      // shared by every candidate, and the answer is one candidate's.
      const answered = this.oracle(binding, name, literal);
      if (answered !== undefined) return answered;
    }
    // A function of this file the interpreter could not read may be a
    // decoder a later round inlines, after which the key is a literal.
    if (remembered === UNREAD_KEY) this.unreadCallee ??= name;
    return remembered;
  }

  /** The key the call computes; `null` when the callee's slice is not one the interpreter may run, whatever the arguments. */
  private evaluateCallKey(name: string, args: ArgumentTuple): string | null {
    const slice = sliceForEvaluation(this.program, [name], this.scans);
    if (slice.statements.length === 0 || slice.unmodelledMutation || !isSelfContained(slice)) return null;
    if (hostReferences(slice).length > 0 || findSliceTrap(slice.statements)) return null;
    try {
      const machine = createInterpreter(slice.statements, {
        strict: this.strict,
        module: this.module,
        maxSteps: KEY_STEPS,
        timeoutMs: KEY_TIMEOUT_MS,
        maxCallDepth: 32,
      });
      const value = machine.call(name, args);
      return typeof value === 'string' ? value : UNREAD_KEY;
    } catch {
      return UNREAD_KEY;
    }
  }
}

/** The name a function expression is bound under, `var f = function () {}`, or `undefined`. */
function declaredName(fn: t.Function): string | undefined {
  const path = traverse.cache.scope.get(fn)?.path;
  const parent = path?.parentPath;
  return parent?.isVariableDeclarator() && parent.node.init === fn && parent.node.id.type === 'Identifier' ? parent.node.id.name : undefined;
}

/** Methods that give back the receiver's own string, or a case or trim of it: read through the receiver, each reading changed the same way (`*` is unchanged by all of them). */
const READ_THROUGH_METHODS: ReadonlyMap<string, (spelling: string) => string> = new Map([
  ['toString', (spelling) => spelling],
  ['valueOf', (spelling) => spelling],
  ['trim', (spelling) => spelling.trim()],
  ['toLowerCase', (spelling) => spelling.toLowerCase()],
  ['toUpperCase', (spelling) => spelling.toUpperCase()],
]);

/**
 * Methods that cut or rewrite the receiver's string by literal arguments,
 * run on each reading that is spelled whole: `'xround'.slice(1)`,
 * `'r-ound'.replace('-', '')`. A reading with a part the tree cannot read
 * is where the cut may fall, and stays the unread `*`.
 */
const CUT_METHODS: ReadonlyMap<string, (spelling: string, args: ArgumentTuple) => string | undefined> = new Map([
  ['slice', (spelling, [from, to]) => (typeof from === 'number' && (to === undefined || typeof to === 'number') ? spelling.slice(from, to) : undefined)],
  ['substring', (spelling, [from, to]) => (typeof from === 'number' && (to === undefined || typeof to === 'number') ? spelling.substring(from, to) : undefined)],
  ['substr', (spelling, [from, length]) => (typeof from === 'number' && (length === undefined || typeof length === 'number') ? spelling.substr(from, length) : undefined)],
  ['replace', (spelling, [from, to]) => (typeof from === 'string' && typeof to === 'string' ? spelling.replace(from, to) : undefined)],
  ['replaceAll', (spelling, [from, to]) => (typeof from === 'string' && typeof to === 'string' ? spelling.replaceAll(from, to) : undefined)],
]);

/** `Object` and `Reflect` methods, and other builtins, that read their argument and write nothing on it. */
const HOLDER_READS: ReadonlySet<string> = new Set([
  'keys',
  'values',
  'entries',
  'getOwnPropertyNames',
  'getOwnPropertySymbols',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getPrototypeOf',
  'hasOwn',
  'isFrozen',
  'isSealed',
  'isExtensible',
  'is',
  'ownKeys',
  'has',
  'get',
  'JSON.stringify',
  'Array.isArray',
  'String',
  'Boolean',
]);

/** An object or array literal, where it stands. */
interface LiteralValue {
  node: t.ObjectExpression | t.ArrayExpression;
  at: t.Node;
  scope: Scope;
}

/** The keys a holder may have, each with the values it may hold there; `unread` when a key or a writer could not be read. */
interface HolderShape {
  keys: Map<string, { node: t.Node | 'unknown'; scope: Scope }[]>;
  unread: boolean;
}

/**
 * The writes made through a holder binding, by the readings of each key in
 * the chain, with the function of this file a key's call could not be read
 * through, for a later round to; see `KeyReader.holderWrites`.
 */
interface HolderWrites {
  writes: { keys: string[][]; value: t.Node | 'unknown'; scope: Scope; deferrable: string | undefined }[];
  escapes: boolean;
}

/** The `value` of a property descriptor literal, or a value the tree cannot read. */
function descriptorValue(descriptor: t.Node | undefined | 'unknown'): t.Node | 'unknown' {
  if (!descriptor || descriptor === 'unknown' || !t.isObjectExpression(descriptor)) return 'unknown';
  const value = literalProperty(descriptor, 'value');
  return value && value !== 'unknown' ? value : 'unknown';
}

/** Whether a use of a holder only reads it: `for (k in d)`, `{ ...d }`, `k in d`, `typeof d`, a comparison, a template, a `log(d)`-style argument is not one. */
function isHolderRead(parent: NodePath, node: t.Node, collection = false): boolean {
  if (parent.isForInStatement()) return parent.node.right === node;
  // An array iterated or spread gives its elements away and keeps them.
  if (parent.isForOfStatement()) return collection && parent.node.right === node;
  if (parent.isSpreadElement()) return collection || (parent.parentPath?.isObjectExpression() ?? false);
  if (parent.isBinaryExpression()) return parent.node.operator === 'in' ? parent.node.right === node : COMPARISONS.has(parent.node.operator);
  if (parent.isUnaryExpression()) return parent.node.operator === 'typeof' || parent.node.operator === '!' || parent.node.operator === 'void';
  if (parent.isLogicalExpression() || parent.isConditionalExpression() || parent.isSequenceExpression()) {
    // Its value is passed on; where to is the parent's use, which the walk above does not follow.
    return false;
  }
  if (parent.isExpressionStatement() || parent.isIfStatement() || parent.isWhileStatement()) return true;
  return false;
}

const COMPARISONS: ReadonlySet<string> = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'instanceof']);

/** A member expression path in either spelling. */
function isMemberPath(path: NodePath): path is NodePath<t.MemberExpression | t.OptionalMemberExpression> {
  return path.isMemberExpression() || path.isOptionalMemberExpression();
}

/**
 * `this.k = ...` in a method of a literal's own: the keys and values, for the
 * literal's shape. Only a method - a function expression as a property's
 * value, or an `ObjectMethod` - binds `this` to the literal when called as
 * its method; an arrow's `this` is the enclosing one, and a nested function's
 * is its own caller's.
 */
function thisWrites(literal: t.ObjectExpression, scope: Scope): [string, t.Node | 'unknown'][] {
  const writes: [string, t.Node | 'unknown'][] = [];
  for (const property of literal.properties) {
    let method: t.Function | undefined;
    if (property.type === 'ObjectMethod') method = property;
    else if (property.type === 'ObjectProperty') {
      const value = stripTypeWrappers(property.value);
      if (value.type === 'FunctionExpression') method = value;
    }
    if (method) writes.push(...methodThisWrites(method, scope));
  }
  return writes;
}

/** `this.k = ...` in one method's own body, for the holder it is called as a method of; see `thisWrites`. */
function methodThisWrites(method: t.Function, scope: Scope): [string, t.Node | 'unknown'][] {
  const writes: [string, t.Node | 'unknown'][] = [];
  const stack: t.Node[] = [method.body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod' || node.type === 'ClassMethod') continue;
    if (node.type === 'AssignmentExpression') {
      for (const target of assignedTargets(node.left)) {
        const spine = spineOf(target);
        if (spine.root.type !== 'ThisExpression' || spine.keys.length === 0) continue;
        const first = spine.keys[0]!;
        const keys = typeof first === 'string' ? [first] : first === CALLED || 'keysOf' in first ? [UNREAD_KEY] : keyReader.read(first, node, scope, 0);
        for (const key of keys) writes.push([key, spine.keys.length === 1 && node.operator === '=' ? node.right : 'unknown']);
      }
    }
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return writes;
}

/**
 * The function a value spells without a scope's help: a function
 * expression, or a name declared as one - `var g = function () {}`,
 * `function g() {}` - for a method a holder is given by assignment.
 */
function spelledFunction(value: t.Node, scope: Scope): t.Function | undefined {
  const node = stripTypeWrappers(value);
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return node;
  if (!t.isIdentifier(node)) return undefined;
  const binding = scope.getBinding(node.name);
  if (!binding) return undefined;
  const declared = binding.path;
  if (declared.isFunctionDeclaration()) {
    const declarations = hoistedDeclarations(binding);
    return declarations && declarations[declarations.length - 1] === declared.node ? declared.node : undefined;
  }
  if (!binding.constant) return undefined;
  const init = declared.isVariableDeclarator() && declared.node.init ? stripTypeWrappers(declared.node.init) : undefined;
  return init && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) ? init : undefined;
}

/**
 * `Object.m(...)` by any route `invocation` sees through - `Object.m.call(t,
 * ...)`, `Reflect.apply(Object.m, t, [...])` - with the arguments the method
 * gets; `undefined` for a call of anything else, or of a local `Object`.
 */
function objectMethodCall(call: t.CallExpression | t.OptionalCallExpression, scope: Scope | undefined): { method: string; args: readonly t.Node[] } | undefined {
  const invoked = invocation(call.callee, undefined, call.arguments, 0);
  if (!invoked || invoked.fns.length !== 1) return undefined;
  const fn = stripTypeWrappers(invoked.fns[0]!);
  const spine = isMember(fn) ? memberSpine(fn) : undefined;
  if (!spine || spine.root !== 'Object' || spine.keys.length !== 1 || !isRead(spine.keys[0]!) || scope?.getBinding('Object')) return undefined;
  return { method: spine.keys[0]!, args: invoked.args };
}

/**
 * The array `Object.keys(h)`, `Object.values(h)` or `Object.entries(h)`
 * makes of a holder the tree can read, as a literal: its keys as string
 * literals, its values where they stand, its entries as pairs. Nothing for
 * a holder with a key or a writer the tree cannot see.
 */
function holderList(call: t.CallExpression, at: t.Node, scope: Scope, depth: number): t.ArrayExpression | undefined {
  const made = objectMethodCall(call, scope);
  if (!made) return undefined;
  const { method, args } = made;
  if (method !== 'keys' && method !== 'values' && method !== 'entries') return undefined;
  const [holder] = args;
  if (!holder || t.isSpreadElement(holder)) return undefined;
  const shape = keyReader.holderShape(holder, at, scope, depth + 1);
  if (shape === 'unknown' || shape.unread) return undefined;
  const elements: t.Expression[] = [];
  for (const [key, held] of shape.keys) {
    // A key written more than once holds one of several values; the pair
    // is unread past its key, which is what `entries` is asked for. A
    // getter's value is what it returns.
    const single = held.length === 1 && held[0]!.node !== 'unknown' ? held[0]!.node : undefined;
    const value = single === undefined ? undefined : t.isExpression(single) ? single : t.isObjectMethod(single) && single.kind === 'get' ? returnedValue(single) : undefined;
    if (method === 'keys') elements.push(t.stringLiteral(key));
    else if (value === undefined) return undefined;
    else elements.push(method === 'values' ? value : t.arrayExpression([t.stringLiteral(key), value]));
  }
  return t.arrayExpression(elements);
}

interface HostWrite {
  /** The property path written under the name; empty for the name itself; `*` for a key that cannot be read, inside a key for the part of it that cannot. */
  keys: readonly string[];
  /** The assignment, update, delete, `for` statement or reflective call. */
  node: t.Node;
  /** The write's place in the program, for the order `of` answers in. */
  order: number;
  /** One reading among several: the object or a key of the write may be another, and this one is what it may be. */
  maybe: boolean;
  /** For a write under the unknown name: the alias whose sources could not all be read, so the disclosure names the object and not the key. */
  unreadObject: string | undefined;
  /** A key computed by a call to this function of the file, unread now; a round that inlines the call reads it. */
  deferrable: string | undefined;
  /** A reflective call, `Object.m(...)` by any route, rather than an assignment, an update, a delete or a `for` head. */
  reflective: boolean;
  /**
   * A may-write of a reflective call under a method the tree cannot read,
   * `Object[k](x, ...)`, on an argument it cannot read either: the shape the
   * balanced preset takes for the read it is in every mainstream file -
   * `Object.keys(x)` on a program value - without a line per call.
   */
  quiet: boolean;
}

/** What `writtenHostName` asks of an index: the writes under a name, and the once-a-round disclosure. */
interface HostWrites {
  of(name: string): readonly HostWrite[];
  disclose(what: string): boolean;
}

/**
 * The decoder being built, asked to read a key a call to it computes:
 * `binding` the binding the call's name resolves to, `name` that name,
 * `args` the call's literal arguments; the string the call gives back, or
 * `undefined` for a call that does not reach the decoder, or one its tier
 * cannot read. Set on the key reader for the span of
 * `HostWriteIndex.rejudged`.
 */
type KeyOracle = (binding: Binding, name: string, args: ArgumentTuple) => string | undefined;

/** A call made on a member chain, before its method is read; see `throughCalls`. */
const CALLED: unique symbol = Symbol('called');
/** Among a slice's members: a method called through a key it cannot read; see `hostReads`. */
const CALLED_UNREAD = '*()';

/** A key of a member chain before scope is asked: a name, `*`, the expression that computes it, or a call. */
type RawKey = string | t.Expression | typeof CALLED | KeysOf;

/** Every key of a holder, as one position of a chain: `Object.assign(X, d)` writes each of `d`'s; read by `KeyReader.holderKeys`. */
interface KeysOf {
  keysOf: t.Node;
}

/** A key once scope has been asked: a spelling, `*`, or a call. */
type ChainKey = string | typeof CALLED;

/** A reflective call whose callee is a name or a member of one, resolved in `place`: `d(String, 'fromCharCode', ...)`. */
interface DeferredReflective {
  callee: t.Node;
  args: readonly t.Node[];
  /** The holder `this` names where the call sits, when the walk knows it. */
  thisHolder: string | undefined;
  /** For a bare callee under `with (X)`: the name, read as `X`'s property, `callee` being `X`. */
  key?: string;
}

/** A write as the raw walk found it; the root is a node until `place` names it. */
interface RawWrite {
  root: t.Node | string;
  keys: RawKey[];
  node: t.Node;
  topLevel: boolean;
  order: number;
  /** The innermost scope-owning node around the write; see the constructor. */
  scope: t.Node;
  reflective?: DeferredReflective;
  /** For a write under the unknown name from the walk: the local it is the object of. */
  unreadObject?: string;
  /** The member written, kept for a chain with a call in it, which `originOf` reads whole; see `placeChain`. */
  target?: t.MemberExpression | t.OptionalMemberExpression;
  /** The scope `place` was given, for `rejudged` to place the write again in. */
  placedScope?: Scope;
}

/** A root handed to a call: to a function by name, to `holder.method`, or to a function expression called where it stands. */
interface Handoff {
  callee: string | t.Function;
  index: number;
  /** A nameable root of the argument, or a function literal handed as it stands. */
  root: string | t.Function;
}

/**
 * A call that may reach no function of this file - a builtin's callback,
 * `Array.from([String], f)`, `xs.sort(f)`, a call the walk cannot name -
 * which may call any function among its arguments with anything it
 * carries: the roots of its arguments and of its receiver.
 */
interface EscapedCall {
  /** Every spelling of the callee; none for a call the walk cannot name. */
  callees: (string | t.Function)[];
  /** The names and function literals among the arguments, any of which may be called. */
  handed: (string | t.Function)[];
  carried: string[];
}

/** The names a slice can take for the host's; the bare targets worth resolving a binding for. */
const HOST_NAMES: ReadonlySet<string> = new Set(globalNames());

/** The globals a write chain is named by: the host names, and the two the reflective and prototype routes go through. */
const NAMED_ROOTS: ReadonlySet<string> = new Set([...HOST_NAMES, 'Function', 'Reflect']);

/** Spellings of the global object a property write goes through; `this` is `memberSpine`'s name for a `ThisExpression` root. */
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'window', 'self', 'global', 'this']);

/** The name a write goes under when the tree cannot say which global it reaches; see `writtenHostName`. */
const UNKNOWN_NAME = '*';
/** A chain's root the index cannot name at all, kept only until the chain is read for a prototype step. */
const UNNAMED_ROOT = '';
/** Among a name's roots: what a function of this file returned, which `originOf` reads; see `aliasCandidates`. */
const RETURNED = '<returned>';
/** Among a parameter's roots: a value handed by a call that reaches no function of this file, which the scope reads; see `EscapedCall`. */
const HANDED = '<handed>';
/** The prototype of some value, reached without naming its constructor. */
const PROTOTYPE_OF_A_VALUE = '<prototype>';
/** The constructor of some value. */
const CONSTRUCTOR_OF_A_VALUE = '<constructor>';

/** `Object` methods that return their first argument, so a write on the result is a write on it. */
const RETURNS_TARGET = new Set(['assign', 'freeze', 'seal', 'preventExtensions', 'defineProperty', 'defineProperties', 'setPrototypeOf']);

/** The `Object` methods that write their first argument; `Reflect`'s are `set`, `defineProperty` and `setPrototypeOf`. */
const OBJECT_WRITERS: ReadonlySet<string> = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
/** Every name a reflective write goes under, on `Object` or `Reflect`. */
const REFLECTIVE_METHODS: ReadonlySet<string> = new Set([...OBJECT_WRITERS, 'set']);

/**
 * `X.k = v` and `k = v` everywhere in the program, by `k`: the sources of
 * the global object's `k`, once the scope says `X` is the global object or
 * `k` is bound nowhere; see `globalPropertyOrigin`. Per build, the way
 * `keyReader` is; the walk fills it.
 */
let propertyAssignments = new Map<string, PropertyAssignment[]>();
interface PropertyAssignment {
  /** The object written, or `'bare'` for `k = v`. */
  object: t.Node | 'bare';
  value: t.Node;
  /** The innermost scope-owning node around the assignment, resolved the way a write's is. */
  scope: t.Node;
  topLevel: boolean;
}
function propertyAssignment(key: string, assignment: PropertyAssignment): void {
  let list = propertyAssignments.get(key);
  if (!list) propertyAssignments.set(key, (list = []));
  list.push(assignment);
}
/** Every `throw` in the program, for what a `catch` may be handed; per build. */
let thrownSites: { node: t.Node; scope: t.Node }[] = [];
/** The program's scope, for a bare name bound nowhere; per build. */
let programScope: Scope | undefined;
/** Whether the program is a script, whose top-level `var` and function declarations are the global object's properties. */
let scriptGlobals = false;
/** Whether a bare call binds `this` to the global object: sloppy code, where `(function () { return this; })()` is the webpack shim's global. */
let sloppyThis = false;
/** The global object, for `this` in a bare call of sloppy code; a node of no tree, which `followAlias` reads by name. */
const GLOBAL_THIS = t.identifier('globalThis');
/** The scope Babel built for a scope-owning node at the last crawl, the way `place` finds a write's. */
function scopeOf(node: t.Node): Scope | undefined {
  return programScope && node === programScope.path.node ? programScope : traverse.cache.scope.get(node);
}

/**
 * Methods that hand a callback each element of their receiver, by the
 * callback parameter that receives it; `then` hands a promise's value,
 * which is what `Promise.resolve(x)` was given, to either of its callbacks.
 */
const ITERATES_ELEMENTS: ReadonlyMap<string, number> = new Map([
  ['then', 0],
  ['forEach', 0],
  ['map', 0],
  ['filter', 0],
  ['some', 0],
  ['every', 0],
  ['find', 0],
  ['findIndex', 0],
  ['findLast', 0],
  ['findLastIndex', 0],
  ['flatMap', 0],
  ['reduce', 1],
  ['reduceRight', 1],
]);

/** The elements of an array literal, or of one a name holds at `at` - `var xs = [String]; xs.forEach(...)`; `undefined` for anything else. */
function arrayElements(node: t.Node, at: t.Node, scope: Scope | undefined, pairs = false): (t.Node | 'unknown')[] | undefined {
  const value = stripTypeWrappers(node);
  let literal: t.ArrayExpression | undefined;
  /** What was put in after the literal: `xs.push(String)`, `xs[1] = String`; unknown for a holder that escapes. */
  let added: (t.Node | 'unknown')[] = [];
  if (value.type === 'ArrayExpression') {
    literal = value;
  } else if (value.type === 'NewExpression' && scope) {
    literal = collectionEntries(value, scope, pairs);
  } else if (value.type === 'Identifier' && scope) {
    const held = heldSource(value.name, at, scope);
    const init = held && stripTypeWrappers(held.node);
    if (init?.type === 'ArrayExpression') literal = init;
    else if (held && init?.type === 'NewExpression') literal = collectionEntries(init, held.scope, pairs);
    const binding = literal && scope.getBinding(value.name);
    if (binding) {
      const written = keyReader.holderWrites(binding, 0);
      if (written.escapes) return undefined;
      added = written.writes.map((write) => write.value);
    }
  } else if (value.type === 'CallExpression' && scope) {
    // `Object.keys(o)`, `Object.values(o)`, `Object.entries(o)` over a holder the tree can read; a generator of this file, what it yields.
    literal = holderList(value, at, scope, 0) ?? generatorYields(value, scope);
  }
  if (!literal) return undefined;
  return [...literal.elements.map((element) => (!element || element.type === 'SpreadElement' ? 'unknown' : element)), ...added];
}

/**
 * What a call of a generator function of this file yields, as an array
 * literal, for a `for (x of g())` head: every `yield` of the generator's
 * own body, with a `yield*` the tree cannot list; `undefined` for a call
 * of anything else.
 */
function generatorYields(call: t.CallExpression, scope: Scope): t.ArrayExpression | undefined {
  const invoked = invocation(call.callee, undefined, call.arguments, 0);
  if (!invoked) return undefined;
  const elements: (t.Expression | t.SpreadElement)[] = [];
  for (const arm of invoked.fns) {
    const origin = originOf(arm, scope, 0, []);
    if (!origin || origin.places.length > 0 || origin.functions.length === 0) return undefined;
    for (const fn of origin.functions) {
      if (!t.isFunction(fn) || !fn.generator || fn.body.type !== 'BlockStatement') return undefined;
      const pending: t.Node[] = [fn.body];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (current.type === 'YieldExpression') {
          // `yield* xs` is every element of `xs`; `yield` with nothing is `undefined`.
          elements.push(current.delegate ? t.spreadElement(t.identifier('undefined')) : (current.argument ?? t.identifier('undefined')));
          if (current.argument) pending.push(current.argument);
          continue;
        }
        if (current !== fn.body && (t.isFunction(current) || t.isClass(current))) continue;
        for (const field of VISITOR_KEYS[current.type] ?? []) {
          const child = (current as unknown as Record<string, unknown>)[field];
          if (Array.isArray(child)) {
            for (const item of child) if (item && typeof (item as t.Node).type === 'string') pending.push(item as t.Node);
          } else if (child && typeof (child as t.Node).type === 'string') {
            pending.push(child as t.Node);
          }
        }
      }
    }
  }
  return t.arrayExpression(elements);
}

/** The arguments of a call with a spread of an array literal opened - or, with a scope, of a name holding one; `unknown` for any other spread. */
function spreadArguments(args: readonly t.Node[], scope?: Scope): t.Node[] | 'unknown' {
  if (!args.some((argument) => argument.type === 'SpreadElement')) return args as t.Node[];
  const flat: t.Node[] = [];
  for (const argument of args) {
    if (argument.type !== 'SpreadElement') {
      flat.push(argument);
      continue;
    }
    // Read where the list is: the spread `invocation` makes of `f.apply(t, a)` has no place of its own.
    const elements = arrayElements(argument.argument, argument.argument, scope, true);
    if (!elements) return 'unknown';
    for (const element of elements) {
      if (element === 'unknown') return 'unknown';
      flat.push(element);
    }
  }
  return flat;
}

/** How many arguments of a call are remembered as hand-offs; obfuscator.io's wrappers take five. */
const MAX_HANDOFF_ARGS = 8;
/**
 * How far an alias, a key or a hand-off is followed before the answer is
 * unknown: `var S = twice(String)` over `twice(x) { return id(x); }` is
 * seven hops, and an element of `[b][dec(0)]()[dec(1)]()` over `var b =
 * f(...)` returning `JSON.parse(JSON.stringify(...))`, as obfuscator.io spells
 * a two-method chain, is twelve.
 */
const MAX_ALIAS_DEPTH = 16;
/** Holder-shape questions open at once, across chains; see `KeyReader.holderShape`. */
const MAX_SHAPE_NESTING = 48;
/** How many readings one key, or one alias, keeps before the rest are the unread `*`. */
const MAX_READINGS = 8;
/** How many placements one write with several readings makes; positions past the budget are unread. */
const MAX_KEY_COMBINATIONS = 16;
/** In `callKeys`, the mark of a callee whose slice was refused for every argument. */
const SLICE_UNREAD = '';
/** The interpreter's budget for one call-computed key: a table read is a few dozen steps, a decoder's rotation loop is millions. */
const KEY_STEPS = 50_000;
const KEY_TIMEOUT_MS = 250;

/**
 * Bound once: the bundle reads `@babel/types` through esbuild's `__toESM`
 * namespace, where every member is a getter, and the raw walks ask these of
 * every node. Everything else on the walk's path reads `node.type`.
 */
const isScope: typeof t.isScope = t.isScope;
const VISITOR_KEYS: typeof t.VISITOR_KEYS = t.VISITOR_KEYS;

/**
 * Whether a written key may be the read one: a spelling with `*` in it is
 * every string the readable parts fit around, in order - `spl*` fits
 * `split` and not `fromCharCode`. `*` alone, on either side, fits anything.
 */
function keyMayBe(written: string, read: string): boolean {
  if (written === read || written === UNREAD_KEY || read === UNREAD_KEY) return true;
  if (isRead(written)) return false;
  const parts = written.split(UNREAD_KEY);
  const head = parts[0]!;
  const tail = parts[parts.length - 1]!;
  if (!read.startsWith(head) || !read.endsWith(tail) || read.length < head.length + tail.length) return false;
  let at = head.length;
  const end = read.length - tail.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const found = read.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Whether some member the slice touches is one the spelling may name. A
 * member the slice reads by a key of its own it cannot spell - an index,
 * `table[i]` - and the unnamed method `*()` fit nothing here: what a
 * spelling in part may name is decided against the names the slice spells.
 */
function memberMayBe(members: ReadonlySet<string>, key: string): boolean {
  if (isRead(key)) return members.has(key);
  for (const member of members) if (member !== CALLED_UNREAD && member !== UNREAD_KEY && keyMayBe(key, member)) return true;
  return false;
}

/** Every concatenation of a left spelling and a right one; adjacent unread parts collapse into one. */
function joinSpellings(left: readonly string[], right: readonly string[]): string[] {
  const joined: string[] = [];
  for (const a of left) {
    for (const b of right) {
      const spelling = (a + b).replace(/\*{2,}/g, UNREAD_KEY);
      if (!joined.includes(spelling)) joined.push(spelling);
    }
  }
  return joined.length > MAX_READINGS ? [...joined.slice(0, MAX_READINGS), UNREAD_KEY] : joined;
}

/** Whether a node is a string by its syntax alone: a string literal or a template. */
function spellsString(node: t.Node): boolean {
  const value = stripTypeWrappers(node);
  return t.isStringLiteral(value) || t.isTemplateLiteral(value);
}

/** Whether a spelling is the canonical form of a number, so the value it spells may have been one. */
function spellsNumber(spelling: string): boolean {
  return String(Number(spelling)) === spelling;
}

/**
 * The readings of a `+`: strings joined, numbers added. `joins` when a
 * side is a string by its syntax. Otherwise a reading that spells a number
 * - `'0'` over `var i = 0` as over `var i = '0'`, which the reader does not
 * tell apart - may be either, so the sum stands beside the join; and a
 * part the tree cannot read beside one is any number, unread whole.
 */
function addSpellings(left: readonly string[], right: readonly string[], joins: boolean): string[] {
  if (joins) return joinSpellings(left, right);
  const mayBeNumber = (spelling: string): boolean => spellsNumber(spelling) || !isRead(spelling);
  let readings: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (spellsNumber(a) && spellsNumber(b)) readings = unionSpellings(readings, [a + b, String(Number(a) + Number(b))]);
      else if (mayBeNumber(a) && mayBeNumber(b)) readings = unionSpellings(readings, [UNREAD_KEY]);
      else readings = unionSpellings(readings, joinSpellings([a], [b]));
    }
  }
  return readings;
}

/** The binary operators that make a number of two numbers, and nothing of anything else. */
const NUMERIC_OPERATORS: ReadonlySet<string> = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);

/**
 * The readings of an arithmetic operator: the result spelled as the key it
 * makes when both sides spell numbers, and otherwise a number the tree did
 * not read - never nothing, since `T[j - 1]` with `j` unread is some element.
 */
function arithmeticSpellings(operator: string, left: readonly string[], right: readonly string[]): string[] {
  let readings: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (!spellsNumber(a) || !spellsNumber(b)) {
        readings = unionSpellings(readings, [UNREAD_KEY]);
        continue;
      }
      const x = Number(a);
      const y = Number(b);
      let value: number;
      switch (operator) {
        case '-': value = x - y; break;
        case '*': value = x * y; break;
        case '/': value = x / y; break;
        case '%': value = x % y; break;
        case '**': value = x ** y; break;
        case '|': value = x | y; break;
        case '&': value = x & y; break;
        case '^': value = x ^ y; break;
        case '<<': value = x << y; break;
        case '>>': value = x >> y; break;
        case '>>>': value = x >>> y; break;
        case '+': value = x + y; break;
        case '~': value = ~y; break;
        default: value = Number.NaN;
      }
      readings = unionSpellings(readings, Number.isNaN(value) ? [UNREAD_KEY] : [String(value)]);
    }
  }
  return readings;
}

/** The spellings of either branch, kept apart, within the budget. */
function unionSpellings(left: readonly string[], right: readonly string[]): string[] {
  const union = [...left];
  for (const spelling of right) if (!union.includes(spelling)) union.push(spelling);
  return union.length > MAX_READINGS ? [...union.slice(0, MAX_READINGS), UNREAD_KEY] : union;
}

/**
 * Every combination of one reading per position, at most `cap` of them: a
 * position whose readings would take the count past the cap is the unread
 * `*` instead, which the caller judges as the hop it cannot read.
 */
function product(readings: readonly (readonly ChainKey[])[], cap: number): ChainKey[][] {
  let combinations: ChainKey[][] = [[]];
  for (const position of readings) {
    const options: readonly ChainKey[] = combinations.length * position.length > cap ? [UNREAD_KEY] : position;
    const next: ChainKey[][] = [];
    for (const combination of combinations) for (const option of options) next.push([...combination, option]);
    combinations = next;
  }
  return combinations;
}

/** The root a write's object chain starts from when it is not a name: a prototype read off a value. */
function rootName(node: t.Node): string | undefined {
  return isPrototypeRead(node) ? PROTOTYPE_OF_A_VALUE : undefined;
}

/** `Object.getPrototypeOf(x)` or `Reflect.getPrototypeOf(x)`. */
function isPrototypeRead(node: t.Node): boolean {
  if (node.type !== 'CallExpression' || node.arguments.length === 0) return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return false;
  return (callee.object.name === 'Object' || callee.object.name === 'Reflect') && propertyKey(callee) === 'getPrototypeOf';
}

/**
 * A chain that leaves the object it started from for a prototype or a
 * constructor: the keys after the last `__proto__`, `constructor.prototype`
 * or `constructor` are written on something the root does not name. A
 * chain that ends at one of them writes the value's own property and is
 * left as it is.
 */
function prototypeThroughValue(keys: readonly string[]): { root: string; keys: string[] } | undefined {
  for (let i = keys.length - 1; i >= 0; i--) {
    if (keys[i] === '__proto__' && i < keys.length - 1) {
      return { root: PROTOTYPE_OF_A_VALUE, keys: keys.slice(i + 1) };
    }
    if (keys[i] === 'constructor' && i < keys.length - 1) {
      return keys[i + 1] === 'prototype' && i < keys.length - 2
        ? { root: PROTOTYPE_OF_A_VALUE, keys: keys.slice(i + 2) }
        : { root: CONSTRUCTOR_OF_A_VALUE, keys: keys.slice(i + 1) };
    }
  }
  return undefined;
}

/**
 * `prototypeThroughValue` for a chain that is READ rather than written: one
 * that ends at `__proto__`, `constructor` or `constructor.prototype` is the
 * prototype or constructor itself, which is what an alias of it holds.
 */
function prototypeReadThrough(keys: readonly string[]): { root: string; keys: string[] } | undefined {
  const through = prototypeThroughValue(keys);
  if (through) return through;
  const last = keys[keys.length - 1];
  if (last === '__proto__') return { root: PROTOTYPE_OF_A_VALUE, keys: [] };
  if (last === 'constructor') return { root: CONSTRUCTOR_OF_A_VALUE, keys: [] };
  if (last === 'prototype' && keys[keys.length - 2] === 'constructor') return { root: PROTOTYPE_OF_A_VALUE, keys: [] };
  return undefined;
}

/**
 * The object and keys a reflective method writes, or nothing for any other
 * method. `Object.assign` with a source that is not an object literal, a
 * computed or spread key, an unreadable key argument and a new prototype
 * are each a write of every property.
 */
function reflectiveWrite(
  holder: 'Object' | 'Reflect',
  method: string,
  args: readonly t.Node[],
): { object: t.Node; keys: RawKey[] } | undefined {
  // A spread of an array literal is opened; any other spread is a source
  // the tree cannot read, or no target at all when it comes first.
  const flat = spreadArguments(args);
  const [object, second, ...rest] = flat === 'unknown' ? args : flat;
  if (!object || !t.isExpression(object)) return undefined;

  const keyOf = (node: t.Node | undefined): RawKey => {
    if (!node) return UNREAD_KEY;
    const literal = staticString(node);
    if (literal !== undefined) return literal;
    return t.isExpression(node) ? node : UNREAD_KEY;
  };
  // A source that is not a literal - a name, a call, a spread - is a holder
  // whose keys the scope reads; see `KeyReader.holderKeys`.
  const keysOfLiteral = (node: t.Node | undefined): RawKey[] => {
    if (!node) return [UNREAD_KEY];
    if (!t.isObjectExpression(node)) return [{ keysOf: node }];
    const keys: RawKey[] = [];
    for (const property of node.properties) {
      if (t.isSpreadElement(property)) keys.push({ keysOf: property.argument });
      else if (property.computed) keys.push(keyOf(property.key));
      else if (t.isIdentifier(property.key)) keys.push(property.key.name);
      else keys.push(keyOf(property.key));
    }
    return keys;
  };

  if (holder === 'Object') {
    switch (method) {
      case 'defineProperty':
        return { object, keys: [keyOf(second)] };
      case 'defineProperties':
        return { object, keys: keysOfLiteral(second) };
      case 'assign': {
        const keys: RawKey[] = [];
        for (const source of [second, ...rest]) keys.push(...keysOfLiteral(source));
        return { object, keys };
      }
      case 'setPrototypeOf':
        return { object, keys: [UNREAD_KEY] };
      default:
        return undefined;
    }
  }
  switch (method) {
    case 'set':
    case 'defineProperty':
      return { object, keys: [keyOf(second)] };
    case 'setPrototypeOf':
      return { object, keys: [UNREAD_KEY] };
    default:
      return undefined;
  }
}

/**
 * The names an initialiser or an assigned value could make a name an alias
 * of, for `aliasCandidates`: the roots of every value the expression may
 * take - through a sequence, an assignment, a logical, a conditional, an
 * array or object literal it is drawn from, and a member chain - where a
 * root is a host name, the global object, `this` at the top of the program,
 * a prototype or constructor read, or another name. `var i =
 * window.innerWidth` names nothing: a property of the global object that is
 * not a host name is nobody's to resolve. Raw node types, not `t.isX`, for
 * the reason the walk gives.
 */
function sourceRoots(node: t.Node, topLevel: boolean, depth: number, thisHolder?: string): string[] {
  if (depth > MAX_ALIAS_DEPTH) return [];
  const value = stripTypeWrappers(node);
  switch (value.type) {
    case 'SequenceExpression': {
      const last = value.expressions[value.expressions.length - 1];
      return last ? sourceRoots(last, topLevel, depth + 1, thisHolder) : [];
    }
    case 'AssignmentExpression':
      return sourceRoots(value.right, topLevel, depth + 1, thisHolder);
    case 'LogicalExpression':
      return [...sourceRoots(value.left, topLevel, depth + 1, thisHolder), ...sourceRoots(value.right, topLevel, depth + 1, thisHolder)];
    case 'ConditionalExpression':
      return [...sourceRoots(value.consequent, topLevel, depth + 1, thisHolder), ...sourceRoots(value.alternate, topLevel, depth + 1, thisHolder)];
    case 'ArrayExpression': {
      const roots: string[] = [];
      for (const element of value.elements) if (element) roots.push(...sourceRoots(element, topLevel, depth + 1, thisHolder));
      return roots;
    }
    case 'ObjectExpression': {
      const roots: string[] = [];
      for (const property of value.properties) {
        if (property.type === 'ObjectProperty') roots.push(...sourceRoots(property.value, topLevel, depth + 1, thisHolder));
        else if (property.type === 'SpreadElement') roots.push(...sourceRoots(property.argument, topLevel, depth + 1, thisHolder));
        else if (property.kind === 'get') roots.push(...returnedRoots(property, topLevel, depth + 1, thisHolder));
      }
      return roots;
    }
    case 'SpreadElement':
      // `[...xs]`, `f(...xs)`: whatever the spread holds.
      return sourceRoots(value.argument, topLevel, depth + 1, thisHolder);
    default:
      break;
  }
  if (isGlobalObjectRead(value)) return ['globalThis'];
  const spine = spineOf(value);
  const { root } = spine;
  let keys = spine.keys;
  // `x.valueOf()` is `x` for every object here.
  while (keys.length >= 2 && keys[keys.length - 2] === 'valueOf' && keys[keys.length - 1] === CALLED) keys = keys.slice(0, -2);
  if (leavesForPrototype(keys) || isPrototypeRead(root)) return [PROTOTYPE_OF_A_VALUE];
  // A call in the chain may give back what it was given: `[].concat(String)`,
  // `m.get(k)` over `m.set(k, String)`; the scope reads which. A callback
  // is run, not kept: `xs.map(String)` holds what `String` returned.
  const given: string[] = [];
  if (keys.includes(CALLED)) {
    for (const call of chainCalls(value)) for (const argument of storedArguments(call)) given.push(...heldRoots(argument, topLevel, depth + 1, thisHolder));
  }
  // `[String][0]`, `({ S: String }).S`: the literal's own roots.
  if (keys.length > 0 && (root.type === 'ArrayExpression' || root.type === 'ObjectExpression')) return [...sourceRoots(root, topLevel, depth + 1), ...given];
  // `''[k]` with a key the walk cannot read may be `''.constructor` or
  // `''.__proto__`: the scope decides. `''[k](...)` is a method of the
  // literal called, as obfuscator.io spells every string method, and what
  // it gives back is no prototype.
  if (
    root.type !== 'Identifier' &&
    root.type !== 'ThisExpression' &&
    keys.some((key, index) => typeof key !== 'string' && key !== CALLED && keys[index + 1] !== CALLED)
  ) {
    return [PROTOTYPE_OF_A_VALUE, ...given];
  }
  if (root.type === 'Identifier') {
    if (GLOBAL_OBJECT_NAMES.has(root.name)) {
      const first = keys[0];
      // `globalThis.S` is the name `S` as well: the global object's property a bare `S` reads.
      if (first === undefined || (typeof first === 'string' && (NAMED_ROOTS.has(first) || GLOBAL_OBJECT_NAMES.has(first)))) return [root.name, ...given];
      return typeof first === 'string' && isRead(first) ? [first, ...given] : given;
    }
    // `o.f` is the name and the property path both: what `o` is an alias
    // of, and what the walk declared or assigned under `o.f`.
    const spelled = keys.length > 0 && keys.every((key) => typeof key === 'string' && isRead(key)) ? `${root.name}.${keys.join('.')}` : undefined;
    return spelled === undefined ? [root.name, ...given] : [root.name, spelled, ...given];
  }
  if (root.type === 'ThisExpression') {
    // `this.d` in a method of a holder the walk names is the holder's `d`.
    if (topLevel) return ['this', ...given];
    if (thisHolder === undefined) return given;
    const spelled = keys.length > 0 && keys.every((key) => typeof key === 'string' && isRead(key)) ? `${thisHolder}.${keys.join('.')}` : undefined;
    return spelled === undefined ? [thisHolder, ...given] : [thisHolder, spelled, ...given];
  }
  if (root.type === 'NewExpression') {
    // An instance holds what its constructor was given; `new U().d` is what `U.prototype.d` holds besides.
    for (const argument of root.arguments) given.push(...heldRoots(argument, topLevel, depth + 1, thisHolder));
    const constructor = stripTypeWrappers(root.callee);
    if (constructor.type !== 'Identifier' || keys.length === 0 || !keys.every((key) => typeof key === 'string' && isRead(key))) return given;
    return [`${constructor.name}.prototype`, `${constructor.name}.prototype.${keys.join('.')}`, ...given];
  }
  return given;
}

/**
 * The arguments of a call that the callee may keep: all of them, but for
 * a callback the callee runs and does not hold - the function `map`,
 * `forEach`, `sort` and `then` are given, the replacer of `replace`.
 */
function storedArguments(call: t.CallExpression | t.OptionalCallExpression | t.NewExpression): t.Node[] {
  const callee = stripTypeWrappers(call.callee);
  const method = isMember(callee) ? propertyKey(callee) : undefined;
  const skipped = method === undefined ? -1 : method === 'replace' || method === 'replaceAll' ? 1 : ITERATES_ELEMENTS.has(method) || method === 'sort' || method === 'toSorted' ? 0 : -1;
  // What a call returns is the scope's to read, not a global handed over: `s.split(String.fromCharCode(44))` keeps no `String`.
  const kept = (argument: t.Node): boolean => {
    const value = stripTypeWrappers(argument.type === 'SpreadElement' ? argument.argument : argument);
    return value.type !== 'CallExpression' && value.type !== 'OptionalCallExpression' && value.type !== 'NewExpression';
  };
  return call.arguments.filter((argument, index) => index !== skipped && !(method === 'then' && index === 1) && kept(argument));
}

/**
 * The roots a value HANDED somewhere carries: `sourceRoots` with no call
 * opened, since what `m.set(k, JSON.stringify(x))` puts into `m` is a
 * string of `JSON`'s making and not `JSON`, while `m.set(k, String)` and
 * `m.set(k, { S: String })` put the builtin in. A name is itself, a
 * member chain its root, `this` what the walk names it, a literal what it
 * holds, a `new` what its constructor was given.
 */
function heldRoots(node: t.Node, topLevel: boolean, depth: number, thisHolder?: string): string[] {
  if (depth > MAX_ALIAS_DEPTH) return [];
  const value = stripTypeWrappers(node);
  switch (value.type) {
    case 'SequenceExpression': {
      const last = value.expressions[value.expressions.length - 1];
      return last ? heldRoots(last, topLevel, depth + 1, thisHolder) : [];
    }
    case 'AssignmentExpression':
      return heldRoots(value.right, topLevel, depth + 1, thisHolder);
    case 'LogicalExpression':
      return [...heldRoots(value.left, topLevel, depth + 1, thisHolder), ...heldRoots(value.right, topLevel, depth + 1, thisHolder)];
    case 'ConditionalExpression':
      return [...heldRoots(value.consequent, topLevel, depth + 1, thisHolder), ...heldRoots(value.alternate, topLevel, depth + 1, thisHolder)];
    case 'SpreadElement':
      return heldRoots(value.argument, topLevel, depth + 1, thisHolder);
    case 'ArrayExpression': {
      const roots: string[] = [];
      for (const element of value.elements) if (element) roots.push(...heldRoots(element, topLevel, depth + 1, thisHolder));
      return roots;
    }
    case 'ObjectExpression': {
      const roots: string[] = [];
      for (const property of value.properties) {
        if (property.type === 'ObjectProperty') roots.push(...heldRoots(property.value, topLevel, depth + 1, thisHolder));
        else if (property.type === 'SpreadElement') roots.push(...heldRoots(property.argument, topLevel, depth + 1, thisHolder));
      }
      return roots;
    }
    case 'NewExpression': {
      const roots: string[] = [];
      for (const argument of value.arguments) roots.push(...heldRoots(argument, topLevel, depth + 1, thisHolder));
      return roots;
    }
    case 'CallExpression':
    case 'OptionalCallExpression':
      if (isGlobalObjectRead(value)) return ['globalThis'];
      if (isPrototypeRead(value)) return [PROTOTYPE_OF_A_VALUE];
      return givenBack(value, topLevel, depth, thisHolder);
    default:
      break;
  }
  const spine = spineOf(value);
  if (!spine.keys.includes(CALLED)) return sourceRoots(value, topLevel, depth, thisHolder);
  // `Object.keys(o)[0]`: an element of what a global gave back of its argument.
  const innermost = chainCalls(value).pop();
  return innermost && innermost.type !== 'NewExpression' ? givenBack(innermost, topLevel, depth, thisHolder) : [];
}

/**
 * What a call of `Object.keys`, `Object.values`, `Object.entries`,
 * `Array.of`, `Array.from` or `Reflect.get` hands on of its arguments, with
 * the global's name for the pre-filter to see it by; nothing for any other
 * call, whose result is the scope's to read.
 */
function givenBack(call: t.CallExpression | t.OptionalCallExpression, topLevel: boolean, depth: number, thisHolder?: string): string[] {
  const callee = stripTypeWrappers(call.callee);
  if (!isMember(callee)) return [];
  const spine = memberSpine(callee);
  if (!spine || spine.keys.length !== 1) return [];
  const method = spine.keys[0]!;
  const gives = RETURNS_GIVEN.has(`${spine.root}.${method}`) || (spine.root === 'Object' && (method === 'keys' || method === 'values' || method === 'entries'));
  if (!gives) return [];
  const roots = [spine.root];
  for (const argument of call.arguments) roots.push(...heldRoots(argument, topLevel, depth + 1, thisHolder));
  return roots;
}

/** The calls along a member chain, outermost first: `a.f(x).g(y)` is `.g(y)` then `.f(x)`. */
function chainCalls(node: t.Node): (t.CallExpression | t.OptionalCallExpression | t.NewExpression)[] {
  const calls: (t.CallExpression | t.OptionalCallExpression | t.NewExpression)[] = [];
  let current: t.Node = stripTypeWrappers(node);
  for (let hops = 0; hops < 64; hops++) {
    if (isMember(current)) {
      current = stripTypeWrappers(current.object);
    } else if (current.type === 'CallExpression' || current.type === 'OptionalCallExpression' || current.type === 'NewExpression') {
      calls.push(current);
      current = stripTypeWrappers(current.callee);
    } else {
      break;
    }
  }
  return calls;
}

/**
 * The roots of what a getter returns, for `{ get S() { return String; } }`
 * read as `o.S`: every `return` of its own body, none of a nested function's.
 */
function returnedRoots(getter: t.Function, topLevel: boolean, depth: number, thisHolder?: string): string[] {
  const roots: string[] = [];
  for (const returned of ownReturns(getter)) roots.push(...sourceRoots(returned, topLevel, depth, thisHolder));
  return roots;
}

/**
 * What a getter gives, as one expression: its one return, or several as
 * the arms of a conditional nobody can decide, which every reader takes as
 * any of them; `undefined` where it returns nothing.
 */
function returnedValue(getter: t.Function): t.Expression {
  const returned = ownReturns(getter).filter((node): node is t.Expression => t.isExpression(node));
  if (returned.length === 0) return t.identifier('undefined');
  return returned.reduceRight((rest, node) => (rest === node ? node : t.conditionalExpression(UNREAD_VALUE, node, rest)), returned[returned.length - 1]!);
}

/** What a function returns, read off the tree with no path: every `return` argument of its own body, or its expression body. */
function ownReturns(fn: t.Function): t.Node[] {
  if (fn.body.type !== 'BlockStatement') return [fn.body];
  const returned: t.Node[] = [];
  const pending: t.Node[] = [fn.body];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === 'ReturnStatement') {
      if (current.argument) returned.push(current.argument);
      continue;
    }
    if (current !== fn.body && (t.isFunction(current) || t.isClass(current))) continue;
    for (const field of VISITOR_KEYS[current.type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[field];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') pending.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        pending.push(child as t.Node);
      }
    }
  }
  return returned;
}

function declareFunction(functions: Map<string, Set<t.Function>>, name: string, fn: t.Function): void {
  let list = functions.get(name);
  if (!list) functions.set(name, (list = new Set()));
  list.add(fn);
}

/**
 * The names some declarator or assignment gives a global, `this` at the top
 * of the program, or another such name: the closure of `initRoots` over
 * itself. A name is a candidate wherever it is declared, and the binding at
 * each write decides whether it is the alias; the set only keeps the
 * traversal away from the writes that cannot be.
 */
function aliasCandidates(initRoots: ReadonlyMap<string, ReadonlySet<string>>): { aliases: Set<string>; globalKeys: Set<string>; reflective: Set<string> } {
  const aliases = new Set<string>();
  // The names that could hold `Object.m` or `Reflect.m`: given `Object`, the
  // global object, a constructor read, what a function returns or an argument.
  const reflective = new Set<string>();
  const couldReflect = (name: string): boolean =>
    name === 'Object' ||
    name === 'Reflect' ||
    GLOBAL_OBJECT_NAMES.has(name) ||
    name === RETURNED ||
    name === HANDED ||
    name === 'arguments' ||
    name === CONSTRUCTOR_OF_A_VALUE ||
    reflective.has(name);
  // The global object's properties given a global - `globalThis.S = String`,
  // `g.S = String` over `var g = globalThis` - which a bare `S` reads.
  const globalKeys = new Set<string>();
  const isGlobal = (name: string): boolean => isGlobalRoot(name, globalKeys);
  let grew = true;
  for (let round = 0; grew && round < 8; round++) {
    grew = false;
    for (const [name, roots] of initRoots) {
      if (!reflective.has(name)) {
        for (const root of roots) {
          if (couldReflect(root)) {
            reflective.add(name);
            grew = true;
            break;
          }
        }
      }
      if (aliases.has(name)) continue;
      for (const root of roots) {
        if (isGlobal(root) || aliases.has(root)) {
          aliases.add(name);
          grew = true;
          const dot = name.lastIndexOf('.');
          const holder = dot < 0 ? undefined : name.slice(0, dot);
          if (holder !== undefined && (GLOBAL_OBJECT_NAMES.has(holder) || aliases.has(holder))) globalKeys.add(name.slice(dot + 1));
          break;
        }
      }
    }
  }
  return { aliases, globalKeys, reflective };
}

/** Whether a root among a name's is a global, or stands for one: the global object, a host name, a property the global object was given, a prototype or constructor read, a call's return, a value handed by a call the walk cannot name, the arguments object. */
function isGlobalRoot(name: string, globalKeys: ReadonlySet<string>): boolean {
  return (
    GLOBAL_OBJECT_NAMES.has(name) ||
    NAMED_ROOTS.has(name) ||
    globalKeys.has(name) ||
    name === PROTOTYPE_OF_A_VALUE ||
    name === CONSTRUCTOR_OF_A_VALUE ||
    name === RETURNED ||
    name === HANDED ||
    name === 'arguments'
  );
}

/**
 * Whether a raw write has a question only a binding can answer, and is one
 * the answer could matter for: a write under a local nobody will ask about
 * is placed as it is, whatever its keys, since a single pending write costs
 * the traversal of the whole program. A reflective call is asked when its
 * callee may reach `Object` or `Reflect` by any route `sourceRoots` sees -
 * a name, an alias, a literal in callee position, the global object.
 */
function needsScope(
  write: RawWrite,
  aliases: ReadonlySet<string>,
  globalKeys: ReadonlySet<string>,
  keyNames: ReadonlySet<string>,
  reflective: ReadonlySet<string>,
  pathReflective: (path: string, depth: number) => boolean,
): boolean {
  if (write.reflective) {
    const callee = write.reflective.callee;
    // `globalThis[k].defineProperty(...)`: the key is the scope's to read.
    const spine = isMember(callee) ? memberSpine(callee) : undefined;
    if (spine && GLOBAL_OBJECT_NAMES.has(spine.root)) return true;
    // `x.foo(...)` with `foo` spelled is `Object.foo` only if `x` is `Object`,
    // which is no reflective method; the holder `o.foo = Object.defineProperty`
    // was given is a path of its own, read as one. `x[k](...)` may be any.
    const method = isMember(callee) ? propertyKey(callee) : undefined;
    const spelledElsewhere = method !== undefined && isRead(method) && !REFLECTIVE_METHODS.has(method);
    // A constructor read, `({}).constructor.defineProperty`, may be `Object`'s;
    // `Function.prototype.call[k](Object.assign, ...)` is a route to any method.
    return sourceRoots(callee, write.topLevel, 0, write.reflective.thisHolder).some(
      (root) =>
        root === 'Object' ||
        root === 'Reflect' ||
        root === 'Function' ||
        root === PROTOTYPE_OF_A_VALUE ||
        GLOBAL_OBJECT_NAMES.has(root) ||
        (spelledElsewhere ? root.includes('.') && pathReflective(root, 0) : reflective.has(root)),
    );
  }
  const root = write.root;
  // `this` in a callback may be the receiver the caller chose; see `callbackReceiver`.
  if (typeof root !== 'string' && root.type === 'ThisExpression' && !write.topLevel) return true;
  if (typeof root !== 'string' && root.type === 'Identifier') {
    if (write.keys.length === 0) return true;
    if (aliases.has(root.name) || root.name === 'arguments' || globalKeys.has(root.name)) return true;
    // `globalThis.S.x = ...` over `S = String`: the property's value is the scope's to read.
    const first = write.keys[0];
    if (GLOBAL_OBJECT_NAMES.has(root.name) && typeof first === 'string' && globalKeys.has(first)) return true;
    // `o.S.x = ...` over `o.S = String`: a path the walk gave a global, written through - not `o.S = ...`, which replaces it.
    let path = root.name;
    for (const key of write.keys.slice(0, -1)) {
      if (typeof key !== 'string' || !isRead(key)) break;
      path += `.${key}`;
      if (aliases.has(path)) return true;
    }
    // `s[k].split = ...` with `k` built from a global's reading, `Object.keys(...)[0]`: the key is the scope's to read.
    if (write.keys.some((key) => typeof key === 'object' && !('keysOf' in key) && key.type === 'Identifier' && keyNames.has(key.name))) return true;
    // A host name written through is the host's only where nothing binds
    // it: `for (var Math = {}; ...) Math.round = 1` inside a function is a
    // local's property, and the scope is what says so.
    if (NAMED_ROOTS.has(root.name)) return true;
    if (!GLOBAL_OBJECT_NAMES.has(root.name) && !leavesForPrototype(write.keys)) {
      return false;
    }
  }
  // A literal, a call or a `new` written through may stand for a global -
  // `[Math][0].round = ...`, `o.get().round = ...` - when something it is
  // built from does; `sourceRoots` sees through the same shapes.
  if (typeof root !== 'string' && root.type !== 'Identifier' && root.type !== 'ThisExpression' && write.keys.length > 0) {
    const roots = sourceRoots(root, write.topLevel, 0);
    if (roots.some((name) => NAMED_ROOTS.has(name) || GLOBAL_OBJECT_NAMES.has(name) || aliases.has(name) || name === PROTOTYPE_OF_A_VALUE)) return true;
    if ((root.type === 'CallExpression' || root.type === 'OptionalCallExpression' || root.type === 'NewExpression') && callMayReturnGlobal(root, aliases)) return true;
  }
  if (write.target && write.keys.includes(CALLED)) {
    const called = callInChain(write.target);
    if (called && callMayReturnGlobal(called.call, aliases)) return true;
  }
  // A chain from a literal or a call keeps its keys: one the tree cannot
  // read may be its prototype's, and reading the key is the scope's.
  return write.keys.some((key) => typeof key !== 'string' && key !== CALLED);
}

/**
 * Whether a call written through - `f().x = ...`, `o.get().x = ...`, `new U().x = ...`
 * - could give back a global: its callee is a function of this file, or a
 * method of a holder, that may return one, or a route that binds a
 * receiver the walk can name. A method of a global returns a value of its
 * own, and a call the walk cannot name at all is left where it is.
 */
function callMayReturnGlobal(call: t.CallExpression | t.OptionalCallExpression | t.NewExpression, aliases: ReadonlySet<string>): boolean {
  const invoked = invocation(call.callee, undefined, call.arguments, 0);
  if (!invoked) return false;
  const global = (name: string): boolean => NAMED_ROOTS.has(name) || GLOBAL_OBJECT_NAMES.has(name) || aliases.has(name) || name === PROTOTYPE_OF_A_VALUE;
  if (invoked.thisArg && sourceRoots(invoked.thisArg, false, 0).some(global)) return true;
  for (const arm of invoked.fns) {
    const fn = stripTypeWrappers(arm);
    if (fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression') return true;
    for (const spelled of calleeSpellings(fn, undefined)) {
      if (typeof spelled !== 'string') return true;
      const root = spelled.split('.')[0]!;
      if (!NAMED_ROOTS.has(root) && !GLOBAL_OBJECT_NAMES.has(root)) return true;
      // A prototype read by a route, `Reflect.apply(Object.getPrototypeOf, ...)`, or a method that gives back what it was given.
      if (spelled === 'Object.getPrototypeOf' || spelled === 'Reflect.getPrototypeOf' || RETURNS_GIVEN.has(spelled)) return true;
    }
  }
  return false;
}

/** The strings an initialiser may be, read without a scope: a literal, either arm of a conditional or a logical, a `+` of two. For the walk's names only; the scope reads the real thing. */
function literalSpellings(node: t.Node, depth = 0): string[] {
  if (depth > MAX_KEY_HOPS) return [];
  const value = stripTypeWrappers(node);
  const literal = staticString(value);
  if (literal !== undefined) return [literal];
  if (value.type === 'ConditionalExpression') return [...literalSpellings(value.consequent, depth + 1), ...literalSpellings(value.alternate, depth + 1)];
  if (value.type === 'LogicalExpression') return [...literalSpellings(value.left, depth + 1), ...literalSpellings(value.right, depth + 1)];
  if (value.type === 'SequenceExpression') {
    const last = value.expressions[value.expressions.length - 1];
    return last ? literalSpellings(last, depth + 1) : [];
  }
  if (value.type === 'BinaryExpression' && value.operator === '+') {
    const spellings: string[] = [];
    for (const left of literalSpellings(value.left, depth + 1)) for (const right of literalSpellings(value.right, depth + 1)) spellings.push(left + right);
    return spellings;
  }
  return [];
}

/** The outermost call a member chain is written through, and the keys read off its result: `f().a.b` is `f()` with `[a, b]`. */
function callInChain(target: t.MemberExpression | t.OptionalMemberExpression): { call: t.CallExpression | t.OptionalCallExpression | t.NewExpression; keys: (string | t.Expression)[] } | undefined {
  const keys: (string | t.Expression)[] = [];
  let current: t.Node = target;
  for (let hops = 0; hops < 64; hops++) {
    current = stripTypeWrappers(current);
    if (!isMember(current)) break;
    const key = rawKey(current);
    keys.unshift(key === CALLED ? UNREAD_KEY : typeof key === 'string' ? key : 'keysOf' in key ? UNREAD_KEY : key);
    current = current.object;
  }
  current = stripTypeWrappers(current);
  if (current.type !== 'CallExpression' && current.type !== 'OptionalCallExpression' && current.type !== 'NewExpression') return undefined;
  if (isPrototypeRead(current)) return undefined;
  return { call: current, keys };
}

/** Whether a chain has a `__proto__` or `constructor` step, so that `prototypeThroughValue` could name it. */
function leavesForPrototype(keys: readonly RawKey[]): boolean {
  return keys.some((key) => key === '__proto__' || key === 'constructor');
}
/** The readable keys at the front of a chain, for a literal an alias holds to consume. */
function literalPrefix(keys: readonly ChainKey[]): string[] {
  const prefix: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !isRead(key)) break;
    prefix.push(key);
  }
  return prefix;
}

/**
 * A global, or a property of one, that an alias stands for: the global's
 * name and the keys read off it, plus how many of the write's own leading
 * keys a literal it holds consumed - `var o = { S: String }; o.S.fromCharCode`
 * is `String` with the `S` consumed.
 */
interface Place {
  root: string;
  keys: string[];
  consumed: number;
}

/**
 * What an expression, or the name it is bound to, may stand for: every place
 * the tree can read it as - one for a plain alias, several for a binding
 * assigned from more than one, `var S = k ? Math : String` - every function
 * of this file it may be, for a call of it to reach, and whether a source
 * among them is some other value, no global at all: a literal, a fresh
 * object. A source the tree cannot read at all - a call it cannot open, a
 * parameter of a function something else calls - is a place under the
 * unknown name, so that it carries a `consumed` count like any other: `var
 * rc = [load()]; rc[0] = ...` writes the array's own slot, and the value the
 * tree could not read is untouched. `undefined` is a binding with no source
 * of any kind.
 */
type Origin = { places: Place[]; functions: (t.Function | t.Class)[]; other: boolean } | undefined;

/** A value the tree cannot read: the unknown place. */
const UNREAD: NonNullable<Origin> = { places: [{ root: UNKNOWN_NAME, keys: [], consumed: 0 }], functions: [], other: false };
/** A value that is no global: a literal, a fresh object, `this` inside a function. */
const NONE: Origin = { places: [], functions: [], other: true };
/** No source at all: what a cycle contributes past its first turn, which the turn before is already gathering. */
const EMPTY: NonNullable<Origin> = { places: [], functions: [], other: false };

/** One place, and nothing else. */
function placeAt(root: string, keys: string[] = []): Origin {
  return { places: [{ root, keys, consumed: 0 }], functions: [], other: false };
}

/** A function or a class of this file, and nothing else. */
function functionAt(fn: t.Function | t.Class): Origin {
  return { places: [], functions: [fn], other: true };
}

/** Whether some source of the origin is one the tree could not read. */
function isUnread(origin: Origin): boolean {
  return origin !== undefined && origin.places.some((place) => place.root === UNKNOWN_NAME);
}

/** Whether an origin is more than one reading: places of more than one global, or one beside a value that is not it. */
function severalReadings(origin: Origin): boolean {
  return origin !== undefined && (origin.places.length > 1 || isUnread(origin) || origin.other);
}

/** `globalThis.Object.defineProperty` is `Object.defineProperty`: a place under the global object, re-rooted at the builtin its first key names; `globalThis.globalThis` is the global object again. */
function throughGlobalObject(place: Place): Place {
  if (place.consumed !== 0 || !GLOBAL_OBJECT_NAMES.has(place.root)) return place;
  let keys = place.keys;
  while (keys.length > 0 && GLOBAL_OBJECT_NAMES.has(keys[0]!) && keys[0] !== 'this') keys = keys.slice(1);
  const first = keys[0];
  if (first !== undefined && NAMED_ROOTS.has(first)) return { root: first, keys: keys.slice(1), consumed: 0 };
  return keys === place.keys ? place : { root: place.root, keys, consumed: 0 };
}

function samePlace(a: Place, b: Place): boolean {
  return a.root === b.root && a.consumed === b.consumed && a.keys.length === b.keys.length && a.keys.every((key, index) => key === b.keys[index]);
}

/** The places and functions of both, each once; more than `MAX_READINGS` places is unread past that. */
function mergeOrigins(a: Origin, b: Origin): Origin {
  if (!a) return b;
  if (!b) return a;
  const places = [...a.places];
  for (const place of b.places) if (!places.some((known) => samePlace(known, place))) places.push(place);
  const functions = [...a.functions];
  for (const fn of b.functions) if (!functions.includes(fn)) functions.push(fn);
  if (places.length <= MAX_READINGS) return { places, functions, other: a.other || b.other };
  const kept = places.slice(0, MAX_READINGS);
  if (!kept.some((place) => place.root === UNKNOWN_NAME)) kept.push(UNREAD.places[0]!);
  return { places: kept, functions, other: a.other || b.other };
}

/** An origin with the places changed, the rest kept. */
function withPlaces(origin: Origin, places: Place[]): Origin {
  return origin && { places, functions: origin.functions, other: origin.other };
}

/** An origin one key deeper into a literal: every place with one more of the write's keys consumed. */
function consumedOne(origin: Origin): Origin {
  return withPlaces(origin, origin?.places.map((place) => ({ ...place, consumed: place.consumed + 1 })) ?? []);
}

/**
 * What `name`, read at a write in `scope`, is an alias of; see `Origin`.
 * Every source of the binding - its declarator, every assignment to it,
 * what every caller hands a parameter, every write through it to the key
 * asked for - is resolved, and a name stands for all of them. `keys` are
 * the write's own leading keys, for a literal the binding holds and for
 * the index a rest parameter is read at.
 */
function followAlias(name: string, scope: Scope, depth: number, keys: readonly string[]): Origin {
  if (depth > MAX_ALIAS_DEPTH) return UNREAD;
  const binding = scope.getBinding(name);
  if (!binding) {
    return GLOBAL_OBJECT_NAMES.has(name) || NAMED_ROOTS.has(name) ? placeAt(name) : globalPropertyOrigin(name, depth, keys);
  }
  // Remembered per binding and keys, with the depth it was asked at: a
  // parameter's origin walks every caller of its function, and obfuscated2.js
  // asks it of the same parameter at every write through it. An answer
  // found deeper in a chain is cut off sooner by the depth, so it serves a
  // question asked as deep or deeper, and a shallower one is asked again.
  const memo = originsByBinding.get(binding) ?? new Map<string, { origin: Origin; depth: number }>();
  originsByBinding.set(binding, memo);
  const key = keys.join('\0');
  const remembered = memo.get(key);
  if (remembered !== undefined && remembered.depth <= depth) return remembered.origin;
  const origin = aliasOrigin(binding, name, depth, keys);
  if (remembered === undefined || remembered.depth > depth) memo.set(key, { origin, depth });
  return origin;
}

/** `followAlias` past the binding lookup: every source of the binding, merged. */
function aliasOrigin(binding: Binding, name: string, depth: number, keys: readonly string[]): Origin {
  let sources: Source[];
  let consumed = 0;
  let rest = keys;
  let result: Origin;
  const declared = binding.path;
  if (binding.kind === 'param') {
    const given = paramSources(binding, keys);
    sources = given.sources;
    consumed = given.consumed;
    rest = keys.slice(consumed);
  } else if (declared.isFunctionDeclaration()) {
    // A function declaration hoists, the last of several wins, and any
    // other assignment to the name is a source like any binding's; what
    // is written through the name, `S.x = String`, is read below.
    const declarations = hoistedDeclarations(binding);
    if (declarations) {
      result = originOf(declarations[declarations.length - 1]!, declared.scope, depth + 1, keys);
      sources = [];
    } else {
      result = originOf(declared.node, declared.scope, depth + 1, keys);
      sources = bindingSources(binding, name).filter((source) => source === 'unknown' || !t.isFunctionDeclaration(source.node));
    }
  } else if (declared.isClassDeclaration()) {
    if (!binding.constant) return UNREAD;
    return originOf(declared.node, declared.scope, depth + 1, keys);
  } else if (declared.isCatchClause()) {
    // A `catch` is handed anything the program throws, from wherever; a
    // throw the scope cannot place, or a rethrow of a value it cannot
    // read, is anything at all.
    const param = declared.node.param;
    sources = thrownSites.map((site): Source => {
      const at = scopeOf(site.scope);
      const picked = param ? patternSource(param, site.node, name) : undefined;
      return at && picked && picked !== 'unknown' ? { node: picked, scope: at } : 'unknown';
    });
    sources.push(...bindingSources(binding, name));
  } else {
    sources = bindingSources(binding, name);
  }
  for (const source of sources) {
    if (source === 'unknown') result = mergeOrigins(result, UNREAD);
    // A `+=` and a `for (k in o)` head give the name a string, no global.
    else if (source.appended || source.keysOf) result = mergeOrigins(result, NONE);
    else result = mergeOrigins(result, originOf(source.node, source.scope, depth + 1, rest));
  }
  // `var o = {}; o.S = String; var S = o.S`: what is written through the
  // name at the key asked for, one key deeper.
  // A name holding nothing but primitives - a loop counter, a string built
  // up - has no property a write through it could give.
  const primitive = sources.length > 0 && sources.every((source) => source !== 'unknown' && (source.appended === true || isPrimitiveLiteral(source.node)));
  if (rest.length > 0 && binding.kind !== 'param' && !primitive) result = mergeOrigins(result, writtenOrigin(binding, depth, rest));
  if (result && consumed > 0) {
    result = withPlaces(result, result.places.map((place) => ({ ...place, consumed: place.consumed + consumed })));
  }
  return result;
}

/**
 * What a name bound nowhere stands for: the global object's property of
 * that name, which is one binding under every spelling - `S = String`
 * with no `S` declared, `globalThis.S = String`, `this.S = String` at the
 * top of the program, `g.S = String` over `var g = globalThis` - and, in a
 * script, the program's own `var S` and `function S`, which are the global
 * object's properties too. Every such source is merged, the way a
 * binding's are; a name given nothing anywhere is `undefined`, as before.
 */
function globalPropertyOrigin(name: string, depth: number, keys: readonly string[]): Origin {
  if (depth > MAX_ALIAS_DEPTH) return UNREAD;
  let result: Origin;
  for (const assignment of propertyAssignments.get(name) ?? []) {
    const scope = scopeOf(assignment.scope);
    if (!scope) {
      result = mergeOrigins(result, UNREAD);
      continue;
    }
    if (assignment.object === 'bare') {
      // A bound `S = ...` is the binding's, read where the binding is.
      if (scope.getBinding(name)) continue;
    } else {
      const object = originOf(assignment.object, scope, depth + 1, []);
      if (!object || !object.places.some((place) => GLOBAL_OBJECT_NAMES.has(place.root) && place.keys.length === 0 && place.consumed === 0)) continue;
    }
    result = mergeOrigins(result, originOf(assignment.value, scope, depth + 1, keys));
  }
  const declared = scriptGlobals ? programScope?.getBinding(name) : undefined;
  if (declared && (declared.kind === 'var' || declared.kind === 'hoisted')) result = mergeOrigins(result, followAlias(name, programScope!, depth + 1, keys));
  return result;
}

/**
 * What the writes through a binding put at the keys asked for: `o.S =
 * String` for `o.S`, `o.a.b = String` for `o.a.b`; a write under a key
 * that may be the one asked for counts, and a holder that escapes to
 * something the tree cannot see may hold anything there.
 */
function writtenOrigin(binding: Binding, depth: number, keys: readonly string[]): Origin {
  const written = keyReader.holderWrites(binding, 0);
  let result: Origin;
  if (written.escapes) result = UNREAD;
  for (const write of written.writes) {
    const consumed = write.keys.length;
    if (consumed > keys.length || consumed > 2) continue;
    if (!write.keys.every((readings, index) => readings.some((key) => keyMayBe(key, keys[index]!)))) continue;
    const value = write.value === 'unknown' ? UNREAD : originOf(write.value, write.scope, depth + 1, keys.slice(consumed));
    result = mergeOrigins(result, withPlaces(value, value?.places.map((place) => ({ ...place, consumed: place.consumed + consumed })) ?? []));
  }
  return result;
}

/** Origins remembered by `followAlias` for one build of the index, which is one tree; see the constructor. */
let originsByBinding = new WeakMap<Binding, Map<string, { origin: Origin; depth: number }>>();

/**
 * What `arguments[n]` stands for at a write: the nth argument of every
 * call of the nearest function that is not an arrow, read the way a rest
 * parameter is, the index consumed. An index the tree cannot read is any
 * argument, unread. Each argument is one hop deeper, as an alias's source
 * is: `f(arguments[0])` inside `f` hands the object round to itself.
 */
function argumentsOrigin(scope: Scope, depth: number, keys: readonly string[]): Origin {
  if (depth > MAX_ALIAS_DEPTH) return UNREAD;
  // The arguments object itself is a fresh one.
  if (keys.length === 0) return NONE;
  const owner = argumentsOwner(scope);
  if (!owner) return undefined;
  // `f(arguments[0])` inside `f` hands the object round to itself: met
  // again at the same index, it is a fixed point, and the calls from
  // outside are the whole answer; see `paramSources`.
  const asked = keys[0]!;
  let gathering = argumentsGathering.get(owner.node);
  if (gathering?.has(asked)) return EMPTY;
  if (!gathering) argumentsGathering.set(owner.node, (gathering = new Set()));
  gathering.add(asked);
  try {
    let result: Origin;
    for (const source of argumentSources(scope, asked) ?? []) {
      result = mergeOrigins(result, source === 'unknown' ? UNREAD : originOf(source.node, source.scope, depth + 1, keys.slice(1)));
    }
    return consumedOne(result);
  } finally {
    gathering.delete(asked);
    if (gathering.size === 0) argumentsGathering.delete(owner.node);
  }
}

/** The functions whose `arguments` `argumentsOrigin` is reading, each with the indices asked; see the fixed point there. */
const argumentsGathering = new Map<t.Node, Set<string>>();

/** The function whose `arguments` a scope reads: the nearest one that is not an arrow; `undefined` outside any. */
function argumentsOwner(scope: Scope): NodePath<t.Function> | undefined {
  let owner = scope.getFunctionParent();
  while (owner && owner.path.isArrowFunctionExpression()) owner = owner.path.parentPath?.scope.getFunctionParent() ?? null;
  return owner?.path.isFunction() ? owner.path : undefined;
}

/**
 * What `arguments[key]` may hold: the argument at that index of every call
 * of the nearest function that is not an arrow; an index the tree cannot
 * read is any argument, unread; `undefined` outside any such function.
 */
function argumentSources(scope: Scope, key: string | undefined): Source[] | undefined {
  const owner = argumentsOwner(scope);
  if (!owner) return undefined;
  const at = key === undefined ? Number.NaN : Number(key);
  if (!Number.isInteger(at) || at < 0 || String(at) !== key) return ['unknown'];
  const { calls, escapes } = fixedCalls(owner, 0);
  const sources: Source[] = escapes ? ['unknown'] : [];
  for (const call of calls) {
    const args = spreadArguments(call.args, call.scope);
    if (args === 'unknown') {
      sources.push('unknown');
      continue;
    }
    const argument = args[at];
    if (argument) sources.push({ node: argument, scope: call.scope });
  }
  return sources;
}

/**
 * A value a binding is given, with the scope it is read in. `appended` is a
 * `+=`: the right side, joined onto whatever the name held; `keysOf` is a
 * `for (k in o)` head: the keys of `o`, one at a time.
 */
type Source = { node: t.Node; scope: Scope; appended?: boolean; keysOf?: boolean } | 'unknown';

/**
 * The declarator's initialiser and every assignment to the binding, each as
 * far as a pattern lets it be read: a `for (S of [String])` head is each
 * element of the literal, a `for (k in o)` head the keys of `o`, a `+=` the
 * right side appended, and any other compound assignment a value the tree
 * cannot read.
 */
function bindingSources(binding: Binding, name: string): Source[] {
  const sources: Source[] = [];
  const give = (pattern: t.Node, value: t.Node | null | undefined, scope: Scope): void => {
    if (!value) return;
    const picked = patternSource(pattern, value, name);
    if (picked === 'unknown') sources.push('unknown');
    else if (picked) sources.push({ node: picked, scope });
  };
  // A `for` head: each element of an array literal iterated, the keys of
  // what a `for...in` walks, and anything else a value the tree cannot read.
  const loop = (statement: t.ForOfStatement | t.ForInStatement, pattern: t.Node, scope: Scope): void => {
    if (statement.type === 'ForInStatement') {
      if (t.isIdentifier(pattern, { name })) sources.push({ node: statement.right, scope, keysOf: true });
      else sources.push('unknown');
      return;
    }
    // An array literal, or a name holding one, is each element; anything else is what the tree cannot read.
    const elements = arrayElements(statement.right, statement, scope, true);
    if (!elements) {
      sources.push('unknown');
      return;
    }
    for (const element of elements) {
      if (element === 'unknown') sources.push('unknown');
      else give(pattern, element, scope);
    }
  };
  const declared = (declarator: NodePath<t.VariableDeclarator>): void => {
    give(declarator.node.id, declarator.node.init, declarator.scope);
    // `for (var k in o)`: the declarator is the head, and Babel lists it as its own violation.
    const head = declarator.parentPath.parentPath;
    if ((head?.isForInStatement() || head?.isForOfStatement()) && head.node.left === declarator.parent) {
      loop(head.node, declarator.node.id, head.scope);
    }
  };
  const declarator = binding.path;
  if (declarator.isVariableDeclarator()) declared(declarator);
  for (const violation of binding.constantViolations) {
    if (violation.isAssignmentExpression()) {
      const { operator, left, right } = violation.node;
      if (operator === '=' || operator === '||=' || operator === '&&=' || operator === '??=') give(left, right, violation.scope);
      else if (operator === '+=' && t.isIdentifier(left, { name })) sources.push({ node: right, scope: violation.scope, appended: true });
      else sources.push('unknown');
    } else if (violation.isVariableDeclarator()) {
      if (violation.node !== declarator.node) declared(violation);
    } else if (violation.isForOfStatement() || violation.isForInStatement()) {
      loop(violation.node, violation.node.left, violation.scope);
    } else {
      sources.push('unknown');
    }
  }
  return sources;
}

/**
 * What every call of a parameter's function hands it, when the function is
 * a fixed one of this file - see `fixedCalls` - plus every assignment to
 * the parameter in the body. A default is a source too. A rest parameter
 * is read at the write's first key, which it consumes: `function f(...K) {
 * K[0].fromCharCode = ... }` is the first argument. A rest taken apart by a
 * pattern, `function f(...[K])`, is the arguments from its position on,
 * spelled as the array literal they make and read through the pattern.
 */
function paramSources(binding: Binding, keys: readonly string[]): { sources: Source[]; consumed: number } {
  const unknown = { sources: ['unknown' as const], consumed: 0 };
  const top = binding.path;
  const owner = top.parentPath;
  if (!owner || !owner.isFunction()) return unknown;
  const index = (owner.node.params as readonly t.Node[]).indexOf(top.node);
  if (index < 0) return unknown;
  const name = binding.identifier.name;
  const sources: Source[] = [];
  let pattern: t.Node = top.node;
  const give = (value: t.Node | undefined, scope: Scope): void => {
    if (!value) return;
    const picked = patternSource(pattern, value, name);
    if (picked === 'unknown') sources.push('unknown');
    else if (picked) sources.push({ node: picked, scope });
  };
  if (pattern.type === 'AssignmentPattern') {
    const given = pattern;
    pattern = given.left;
    give(given.right, owner.scope);
  }
  let offset = 0;
  let consumed = 0;
  let takenApart = false;
  if (pattern.type === 'RestElement') {
    pattern = pattern.argument;
    if (pattern.type !== 'Identifier') {
      takenApart = true;
    } else {
      const key = keys[0];
      // The rest array itself is a fresh one, and holds nothing without an index.
      if (key === undefined) return { sources: [], consumed: 0 };
      const at = Number(key);
      if (!Number.isInteger(at) || at < 0 || String(at) !== key) return unknown;
      offset = at;
      consumed = 1;
    }
  }
  // A parameter met again while its own sources are gathered - a function
  // forwarding its rest to itself, `retry(...args)` in its own catch, or
  // to a partner that forwards it back - is a fixed point: nothing the
  // inner walk could find that the outer one is not gathering. Met at
  // another index on the way round, `a(...z)` over `b(y, ...z)` over
  // `b(...x)`, it is unread.
  const asked = consumed === 1 ? keys[0]! : '';
  const gathering = paramSourcesGathering.get(binding);
  if (gathering !== undefined) return gathering === asked ? { sources: [], consumed } : unknown;
  paramSourcesGathering.set(binding, asked);
  try {
    const { calls, escapes } = fixedCalls(owner, 0);
    if (escapes) sources.push('unknown');
    for (const call of calls) {
      const args = spreadArguments(call.args, call.scope);
      if (args === 'unknown') {
        // `f.apply(t, arguments)`, `f(...rest)`: what the caller's own callers handed it, one position along.
        const forwarded = takenApart ? undefined : forwardedSources(call, index + offset);
        if (forwarded) sources.push(...forwarded);
        else sources.push('unknown');
        continue;
      }
      if (!takenApart) {
        give(args[index + offset], call.scope);
        continue;
      }
      // `...[K]`, `...[, K]`, `...[...r]`: the arguments from the rest's
      // position on, spelled as the array literal they make and read through
      // the pattern - `K` is the first of them, `r` a fresh array of the rest.
      const rest = args.slice(index);
      if (rest.every((argument): argument is t.Expression => t.isExpression(argument))) give(t.arrayExpression(rest), call.scope);
      else sources.push('unknown');
    }
  } finally {
    paramSourcesGathering.delete(binding);
  }
  for (const violation of binding.constantViolations) {
    if (violation.isAssignmentExpression()) {
      const { operator, left, right } = violation.node;
      if (operator === '=' || operator === '||=' || operator === '&&=' || operator === '??=') {
        const picked = patternSource(left, right, name);
        if (picked === 'unknown') sources.push('unknown');
        else if (picked) sources.push({ node: picked, scope: violation.scope });
      } else if (operator === '+=' && t.isIdentifier(left, { name })) {
        sources.push({ node: right, scope: violation.scope, appended: true });
      } else {
        sources.push('unknown');
      }
    } else {
      sources.push('unknown');
    }
  }
  return { sources, consumed };
}

/** The parameters whose sources `paramSources` is gathering, each with the rest index asked; see the fixed point there. */
const paramSourcesGathering = new Map<Binding, string>();

/**
 * What position `at` of a call receives when the call spreads the
 * arguments object or a rest parameter of the function it sits in -
 * `f.apply(null, arguments)`, `f(...rest)` - which is what that function's
 * own callers handed it, `at` less the spread's position along; `undefined`
 * for a spread of anything else, or a spread the position sits before.
 */
function forwardedSources(call: CallSite, at: number): Source[] | undefined {
  const position = call.args.findIndex((argument) => argument.type === 'SpreadElement');
  if (position < 0 || at < position || call.args.slice(0, position).some((argument) => argument.type === 'SpreadElement')) return undefined;
  const spread = stripTypeWrappers((call.args[position] as t.SpreadElement).argument);
  if (spread.type !== 'Identifier') return undefined;
  const index = String(at - position);
  if (spread.name === 'arguments' && !call.scope.getBinding('arguments')) return argumentSources(call.scope, index);
  const binding = call.scope.getBinding(spread.name);
  if (!binding || binding.kind !== 'param' || binding.path.node.type !== 'RestElement') return undefined;
  const { sources, consumed } = paramSources(binding, [index]);
  return consumed === 1 ? sources : undefined;
}

/** A call of a function, as `fixedCalls` finds it: its arguments, and the scope they are read in. */
interface CallSite {
  args: readonly t.Node[];
  scope: Scope;
}

/** What the tree sees of a function's callers: every call it could read, and whether the function escapes to calls it cannot. */
interface Callers {
  calls: CallSite[];
  escapes: boolean;
}

const ESCAPES: Callers = { calls: [], escapes: true };

/** The calls of both. */
function mergeCallers(into: Callers, from: Callers): Callers {
  into.calls.push(...from.calls);
  into.escapes ||= from.escapes;
  return into;
}

/**
 * Every call of a function the tree can see, and whether there are others:
 * a function reassigned, or handed anywhere as a value the tree cannot
 * follow, may be called with anything, and that is the escape. A function
 * declaration is found through its binding's references - the last of
 * several declarations of one name being the one every call reaches - and
 * an expression through the use it sits in: called where it stands, bound
 * by a declarator, assigned to a name or to a member, a property of a
 * literal or a method of a class, handed to a call. Each is one route of
 * `callThrough`, the inverse of `invocation`.
 */
function fixedCalls(owner: NodePath<t.Function>, depth: number): Callers {
  const remembered = callersByFunction.get(owner.node);
  if (remembered) return remembered;
  // Set before the walk: a function reached again through a parameter of
  // its own is a cycle, and what it saw so far stands.
  const callers: Callers = { calls: [], escapes: false };
  callersByFunction.set(owner.node, callers);
  mergeCallers(callers, findCalls(owner, depth));
  return callers;
}

/** Callers remembered by `fixedCalls` for one build of the index, per function node; see the constructor. */
let callersByFunction = new WeakMap<t.Node, Callers>();

function findCalls(owner: NodePath<t.Function>, depth: number): Callers {
  if (depth > MAX_ALIAS_DEPTH) return ESCAPES;
  if (owner.isFunctionDeclaration()) {
    const parent = owner.parentPath;
    if (!owner.node.id || !parent) return ESCAPES;
    const binding = parent.scope.getBinding(owner.node.id.name);
    if (!binding) return ESCAPES;
    const declarations = hoistedDeclarations(binding);
    if (!declarations) return ESCAPES;
    // Every declaration hoists, the last assignment wins, and the ones
    // before it are never called at all.
    return declarations[declarations.length - 1] === owner.node ? callsOf(binding, depth) : { calls: [], escapes: false };
  }
  return callThrough(owner, depth) ?? ESCAPES;
}

/**
 * The function declarations a binding is, in order, when it is nothing
 * else: one declaration, or several of the same name in the same function
 * or program body, which Babel keeps as a declaration and its violations.
 * A binding that is also assigned, or declared in a block - where Annex B
 * gives it a second, `var`-like binding the references do not list - is
 * not one the calls of can be enumerated.
 */
function hoistedDeclarations(binding: Binding): t.FunctionDeclaration[] | undefined {
  if (!binding.path.isFunctionDeclaration()) return undefined;
  const declarations = [binding.path.node];
  for (const violation of binding.constantViolations) {
    // A declaration in a loop body is registered by the loop's scope and
    // again by the block's, and Babel lists the second pass as a violation
    // of the first: the same node, not another declaration.
    if (violation.node === binding.path.node) continue;
    if (!violation.isFunctionDeclaration() || violation.parentPath?.scope !== binding.scope) return undefined;
    declarations.push(violation.node);
  }
  if (declarations.length > 1) {
    const owner = binding.scope.path;
    if (!owner.isFunction() && !owner.isProgram()) return undefined;
    const body = owner.isProgram() ? owner.node.body : (owner.node.body as t.BlockStatement).body;
    if (!declarations.every((declaration) => (body as readonly t.Node[]).includes(declaration))) return undefined;
  }
  return declarations;
}

/** The calls made through a binding's references; a reference that is not a call is the escape. */
function callsOf(binding: Binding, depth: number): Callers {
  if (depth > MAX_ALIAS_DEPTH) return ESCAPES;
  const callers: Callers = { calls: [], escapes: false };
  for (const reference of binding.referencePaths) {
    const through = callThrough(reference, depth);
    if (through) mergeCallers(callers, through);
  }
  return callers;
}

/**
 * How a function reached at `reference` is used: the calls it makes, or
 * `null` for a use that is neither a call nor an escape - a member of the
 * function read, as `f.prototype.m = ...` reads one. The inverse of
 * `invocation`: the use is climbed through the routes that only rearrange
 * a call - `.call`, `.apply`, a `.bind` called at once, `Reflect.apply`, a
 * sequence, a conditional or logical arm, an `await`, an element of an
 * array literal or a property of an object literal read back at once -
 * until a call is met, and the call's `invocation` has to hand the very
 * function back. A function given a name - `var g = f`, `g = f` - is called
 * wherever the name is; given to a holder - `o.f = f`, `{ f }`,
 * `U.prototype.f = f` - wherever the holder's method is; handed to a call
 * - `run(f)`, `[String].forEach(f)` - wherever the parameter that receives
 * it is called, or with each element a builtin runs it over. Anything else
 * is the escape.
 */
/** Array methods that hand back one element of a literal; see `pickedByLiteral`. */
const PICK_METHODS: ReadonlySet<string> = new Set(['pop', 'shift', 'at']);

/** `Function.prototype.bind.call(f, ...)`, by that spelling. */
function isBindCall(call: t.CallExpression | t.OptionalCallExpression | t.NewExpression): boolean {
  const callee = stripTypeWrappers(call.callee);
  if (!isMember(callee) || propertyKey(callee) !== 'call') return false;
  const inner = stripTypeWrappers(callee.object);
  const spine = isMember(inner) ? memberSpine(inner) : undefined;
  return spine !== undefined && spine.root === 'Function' && spine.keys.length === 2 && spine.keys[0] === 'prototype' && spine.keys[1] === 'bind';
}

function callThrough(reference: NodePath, depth: number): Callers | null {
  let node: NodePath = reference;
  /** Every node the climb came through, for a literal read back at once to pick. */
  const climbed = new Set<t.Node>();
  for (let hops = 0; hops < 2 * MAX_KEY_HOPS; hops++) {
    climbed.add(node.node);
    const parent = node.parentPath;
    if (!parent) return ESCAPES;
    if (parent.isCallExpression() || parent.isOptionalCallExpression() || parent.isNewExpression()) {
      const call = parent.node;
      const invoked = invocation(call.callee, undefined, call.arguments, 0);
      if (call.callee === node.node) {
        if (invoked && invoked.fns.some((arm) => armHolds(arm, reference.node))) return { calls: [{ args: invoked.args, scope: parent.scope }], escapes: false };
        // `api.call(t, ...)` reached as the holder's own method: the call as spelled.
        const own = invoked?.own?.find((method) => method.fn === node.node);
        if (own) return { calls: [{ args: own.args, scope: parent.scope }], escapes: false };
        // `[f.bind(t)].pop()`, `.shift()`, `.at(n)`: a pick called at once is the picked function.
        if (isMemberPath(node) && PICK_METHODS.has(propertyKey(node.node)) && pickedByLiteral(call) !== undefined && parent.parentPath && (parent.parentPath.isCallExpression() || parent.parentPath.isOptionalCallExpression()) && parent.parentPath.node.callee === call) {
          node = parent;
          continue;
        }
        if (isMemberPath(node) && propertyKey(node.node) === 'bind' && armHolds(node.node.object, reference.node)) {
          // `f.bind(t)`: the bound function, called or not where the call is
          // used; `f.bind(t, a)(b)` is a call `invocation` reads whole, and
          // `f.bind(t, a)` held by a name hands `a` first to every call of it.
          const outer = parent.parentPath;
          if (call.arguments.length <= 1 || (outer && (outer.isCallExpression() || outer.isOptionalCallExpression()) && outer.node.callee === call)) {
            node = parent;
            continue;
          }
          const bound = callThrough(parent, depth + 1);
          if (!bound) return { calls: [], escapes: false };
          const first = call.arguments.slice(1);
          if (first.some((argument) => argument.type === 'SpreadElement')) return ESCAPES;
          return { calls: bound.calls.map((site) => ({ args: [...first, ...site.args], scope: parent.scope })), escapes: bound.escapes };
        }
        return ESCAPES;
      }
      // `Function.prototype.bind.call(f, t, a...)` is `f.bind(t, a...)`: the bound
      // function, called or not where the call is used.
      if (call.arguments[0] === node.node && isBindCall(call)) {
        const outer = parent.parentPath;
        if (call.arguments.length <= 2 || (outer && (outer.isCallExpression() || outer.isOptionalCallExpression()) && outer.node.callee === call)) {
          node = parent;
          continue;
        }
        const bound = callThrough(parent, depth + 1);
        if (!bound) return { calls: [], escapes: false };
        const first = call.arguments.slice(2);
        if (first.some((argument) => argument.type === 'SpreadElement')) return ESCAPES;
        return { calls: bound.calls.map((site) => ({ args: [...first, ...site.args], scope: parent.scope })), escapes: bound.escapes };
      }
      // `Reflect.apply(f, t, [...])`, `Function.prototype.call.call(f, t, ...)`.
      if (invoked && invoked.fns.some((arm) => armHolds(arm, reference.node))) return { calls: [{ args: invoked.args, scope: parent.scope }], escapes: false };
      const own = invoked?.own?.find((method) => method.fn === node.node);
      if (own) return { calls: [{ args: own.args, scope: parent.scope }], escapes: false };
      return handedCalls(node, parent, depth);
    }
    if (isMemberPath(parent) && parent.node.object === node.node) {
      // A literal read back at once: `[f][0]`, `[[f]][0][0]`, `({ d: f }).d`.
      // What the read picks has to be the function, a use of it the climb
      // came through - `[f.bind(t)][0]` - or a literal still holding it;
      // another element picked is the function left unused. A member of
      // what a chain picked - `[f][0].call` - is the function's.
      const held = node.isArrayExpression() || node.isObjectExpression() ? node.node : pickedByLiteral(node.node);
      if (held?.type === 'ArrayExpression' || held?.type === 'ObjectExpression') {
        // `[f.bind(t)].pop`: the pick is made by the call around the member.
        if (held.type === 'ArrayExpression' && PICK_METHODS.has(propertyKey(parent.node))) {
          node = parent;
          continue;
        }
        const picked = pickedByLiteral(parent.node);
        if (picked === undefined) return ESCAPES;
        if (!climbed.has(picked) && !literalHolds(picked, reference.node)) return null;
        node = parent;
        continue;
      }
      const method = propertyKey(parent.node);
      if (method === 'call' || method === 'apply' || method === 'bind') {
        node = parent;
        continue;
      }
      return method === UNREAD_KEY ? ESCAPES : null;
    }
    // The function is written over, not called: `o.f = ...` with `o.f` reached as a value.
    if ((parent.isAssignmentExpression() && parent.node.left === node.node) || parent.isUpdateExpression() || parent.isUnaryExpression()) return null;
    if (parent.isSequenceExpression()) {
      if (parent.node.expressions[parent.node.expressions.length - 1] !== node.node) return null;
      node = parent;
      continue;
    }
    if (parent.isConditionalExpression()) {
      if (parent.node.test === node.node) return null;
      node = parent;
      continue;
    }
    if (parent.isLogicalExpression() || parent.isAwaitExpression() || isTypeWrapperPath(parent)) {
      node = parent;
      continue;
    }
    if (parent.isArrayExpression()) {
      // An element of a literal: read back at once, `[f][0](...)`, taken
      // apart by a pattern, `var [g] = [f]`, or handed on with the
      // literal, which is the escape.
      const member = parent.parentPath;
      if (member && (isMemberPath(member) || member.isArrayExpression() || member.isObjectProperty())) {
        node = parent;
        continue;
      }
      return patternCalls(parent, node.node, depth) ?? ESCAPES;
    }
    if (parent.isObjectProperty() && parent.node.value === node.node) {
      const literal = parent.parentPath;
      const key = methodKey(parent.node);
      if (!literal || !literal.isObjectExpression() || key === undefined) return ESCAPES;
      const member = literal.parentPath;
      if (member && (isMemberPath(member) || member.isArrayExpression() || member.isObjectProperty())) {
        // `({ d: f }).d(...)`: the literal read back at once, or nested deeper.
        node = literal;
        continue;
      }
      return patternCalls(literal, node.node, depth) ?? heldCalls(literal, key, depth);
    }
    if (parent.isObjectExpression() && node.isObjectMethod()) {
      const key = methodKey(node.node);
      return key === undefined ? ESCAPES : heldCalls(parent, key, depth);
    }
    if (parent.isClassBody() && (node.isClassMethod() || node.isClassPrivateMethod())) {
      if (node.isClassPrivateMethod()) return ESCAPES;
      const key = methodKey(node.node);
      const carrier = parent.parentPath;
      if (key === undefined || !carrier) return ESCAPES;
      const bound = classBinding(carrier);
      if (!bound) {
        // `new (class { f() {} })().f(...)`: the one instance's method, read off it at once.
        const made = carrier.parentPath;
        if (!node.node.static && made?.isNewExpression() && made.node.callee === carrier.node) {
          const member = made.parentPath;
          if (member && isMemberPath(member) && member.node.object === made.node && propertyKey(member.node) === key) return callThrough(member, depth + 1) ?? ESCAPES;
        }
        return ESCAPES;
      }
      return node.node.static ? holderCalls(bound, key, depth + 1) : instanceCalls(bound, key, depth + 1);
    }
    if (parent.isVariableDeclarator() && parent.node.init === node.node) {
      // `var g = f`: the alias's calls are the function's.
      if (parent.node.id.type !== 'Identifier') return ESCAPES;
      const alias = parent.scope.getBinding(parent.node.id.name);
      return alias && alias.path.node === parent.node ? callsOf(alias, depth + 1) : ESCAPES;
    }
    if (parent.isAssignmentExpression() && parent.node.right === node.node) {
      if (parent.node.operator !== '=') return ESCAPES;
      const left = stripTypeWrappers(parent.node.left);
      if (left.type === 'Identifier') {
        const alias = parent.scope.getBinding(left.name);
        return alias ? callsOf(alias, depth + 1) : ESCAPES;
      }
      return isMember(left) ? assignedMethodCalls(left, parent.scope, depth) : ESCAPES;
    }
    return ESCAPES;
  }
  return ESCAPES;
}

/** A TypeScript or Flow wrapper a value passes through unchanged; see `stripTypeWrappers`. */
function isTypeWrapperPath(path: NodePath): boolean {
  return (
    path.isTSAsExpression() ||
    path.isTSNonNullExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSSatisfiesExpression() ||
    path.isTSInstantiationExpression() ||
    path.isTypeCastExpression()
  );
}

/**
 * A function handed to a call as an argument: to a builtin that runs it
 * over the elements of an array literal, each element; to a function of
 * this file, every call of the parameter that receives it - `run(f)` over
 * `function run(h) { h(String); }` calls `f` with `String`. To anything
 * else, the escape.
 */
function handedCalls(argument: NodePath, call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>, depth: number): Callers {
  const args = spreadArguments(call.node.arguments, call.scope);
  if (args === 'unknown') return ESCAPES;
  const index = args.findIndex((arg) => armHolds(arg, argument.node));
  if (index < 0) return ESCAPES;
  const elements = iteratedElements(call, index);
  if (elements) return elements;
  // `var ap = Reflect.apply; ap(f, t, [String])`: the route, held by a name.
  const named = stripTypeWrappers(call.node.callee);
  if (named.type === 'Identifier' && call.node.type !== 'NewExpression') {
    const route = originOf(named, call.scope, 0, []);
    if (route && route.places.some((place) => place.root === 'Reflect' && place.keys.length === 1 && place.keys[0] === 'apply' && place.consumed === 0)) {
      const invoked = invocation(REFLECT_APPLY, undefined, call.node.arguments, 0);
      if (invoked && invoked.fns.some((arm) => armHolds(arm, argument.node))) return { calls: [{ args: invoked.args, scope: call.scope }], escapes: severalReadings(route) };
    }
  }
  const targets = calleeTargets(call.node, call.scope);
  if (targets.escapes) return ESCAPES;
  const callers: Callers = { calls: [], escapes: false };
  for (const fn of targets.functions) {
    const param = fn.params[index];
    const scope = traverse.cache.scope.get(fn);
    const binding = param?.type === 'Identifier' && scope ? scope.getBinding(param.name) : undefined;
    if (!binding || binding.kind !== 'param') {
      callers.escapes = true;
      continue;
    }
    mergeCallers(callers, callsOf(binding, depth + 1));
  }
  return callers;
}

/**
 * The functions of this file a call reaches, through every route
 * `invocation` sees through and every alias `originOf` follows; `escapes`
 * when some arm is a value the tree cannot read, or no function of its own
 * - a builtin, which may call what it is given anywhere.
 */
function calleeTargets(call: t.CallExpression | t.OptionalCallExpression | t.NewExpression, scope: Scope): { functions: t.Function[]; escapes: boolean } {
  const invoked = invocation(call.callee, undefined, call.arguments, 0);
  if (!invoked) return { functions: [], escapes: true };
  const functions: t.Function[] = [];
  let escapes = false;
  for (const arm of invoked.fns) {
    const origin = originOf(arm, scope, 0, []);
    if (!origin || origin.places.length > 0 || origin.functions.length === 0) escapes = true;
    for (const fn of origin?.functions ?? []) {
      if (!t.isFunction(fn)) escapes = true;
      else if (!functions.includes(fn)) functions.push(fn);
    }
  }
  return { functions, escapes };
}

/** The class a class body's carrier is bound to, when it is bound once: a declaration, or an expression a declarator holds. */
function classBinding(carrier: NodePath): Binding | undefined {
  let bound: Binding | undefined;
  if (carrier.isClassDeclaration()) {
    if (!carrier.node.id) return undefined;
    bound = carrier.parentPath.scope.getBinding(carrier.node.id.name);
    if (!bound || bound.path.node !== carrier.node) return undefined;
  } else {
    const declarator = carrier.parentPath;
    if (!declarator?.isVariableDeclarator() || declarator.node.id.type !== 'Identifier' || declarator.node.init !== carrier.node) return undefined;
    bound = declarator.scope.getBinding(declarator.node.id.name);
    if (!bound || bound.path.node !== declarator.node) return undefined;
  }
  return bound.constant ? bound : undefined;
}

/** The calls of a method of an object literal, through the name the literal is bound to. */
function heldCalls(literal: NodePath<t.ObjectExpression>, method: string, depth: number): Callers {
  const carrier = literal.parentPath;
  if (!carrier) return ESCAPES;
  if (carrier.isVariableDeclarator() && carrier.node.init === literal.node && carrier.node.id.type === 'Identifier') {
    const bound = carrier.scope.getBinding(carrier.node.id.name);
    return bound && bound.path.node === carrier.node && bound.constant ? holderCalls(bound, method, depth + 1) : ESCAPES;
  }
  if (carrier.isAssignmentExpression() && carrier.node.right === literal.node && carrier.node.operator === '=') {
    const left = stripTypeWrappers(carrier.node.left);
    if (left.type === 'Identifier') {
      const bound = carrier.scope.getBinding(left.name);
      return bound ? holderCalls(bound, method, depth + 1) : ESCAPES;
    }
    // `U.prototype = { f() { ... } }`: the instances' method.
    if (isMember(left)) {
      const spine = memberSpine(left);
      if (spine && spine.keys.length === 1 && spine.keys[0] === 'prototype') {
        const bound = carrier.scope.getBinding(spine.root);
        return bound && bound.constant ? instanceCalls(bound, method, depth + 1) : ESCAPES;
      }
    }
    return ESCAPES;
  }
  return ESCAPES;
}

/** `o.f = function ...`, `U.prototype.f = function ...`: the method's calls through its holder. */
function assignedMethodCalls(left: t.MemberExpression | t.OptionalMemberExpression, scope: Scope, depth: number): Callers {
  const spine = memberSpine(left);
  if (!spine || spine.keys.some((key) => !isRead(key))) return ESCAPES;
  const bound = scope.getBinding(spine.root);
  if (!bound) return ESCAPES;
  if (spine.keys.length === 1) return holderCalls(bound, spine.keys[0]!, depth + 1);
  if (spine.keys.length === 2 && spine.keys[0] === 'prototype' && bound.constant) return instanceCalls(bound, spine.keys[1]!, depth + 1);
  return ESCAPES;
}

/**
 * The calls of `holder.method(...)` through a holder binding's references:
 * a member read under the method's key - the key read the way every key
 * is, so `o[k](...)` with a readable `k` counts and an unreadable one is the
 * escape - and then whatever `callThrough` makes of the member; an alias
 * of the holder followed; `this.method(...)` inside the literal's or the
 * class's own methods; any other use the escape.
 */
function holderCalls(bound: Binding, method: string, depth: number): Callers {
  if (depth > MAX_ALIAS_DEPTH) return ESCAPES;
  const callers: Callers = { calls: [], escapes: false };
  for (const reference of bound.referencePaths) {
    const member = reference.parentPath;
    if (!member || !isMemberPath(member) || member.node.object !== reference.node) {
      const declarator = member;
      let alias: Binding | undefined;
      if (declarator?.isVariableDeclarator() && declarator.node.init === reference.node && declarator.node.id.type === 'Identifier') {
        alias = declarator.scope.getBinding(declarator.node.id.name);
        if (alias && alias.path.node !== declarator.node) alias = undefined;
      } else if (declarator?.isVariableDeclarator() && declarator.node.init === reference.node && declarator.node.id.type === 'ObjectPattern') {
        // `var { f: m } = o`: the method under a name of its own.
        mergeCallers(callers, destructuredCalls(declarator.node.id, method, declarator.scope, depth));
        continue;
      } else if (declarator?.isAssignmentExpression() && declarator.node.right === reference.node && declarator.node.operator === '=' && declarator.node.left.type === 'Identifier') {
        alias = declarator.scope.getBinding(declarator.node.left.name);
      }
      if (!alias) {
        callers.escapes = true;
        continue;
      }
      mergeCallers(callers, holderCalls(alias, method, depth + 1));
      continue;
    }
    const keys = keyReader.read(member.node.computed ? member.node.property : t.identifier(propertyKey(member.node)), member.node, member.scope, 0);
    if (!member.node.computed) keys.splice(0, keys.length, propertyKey(member.node));
    if (keys.some((key) => key === UNREAD_KEY)) {
      callers.escapes = true;
      continue;
    }
    if (!keys.some((key) => keyMayBe(key, method))) continue;
    const through = callThrough(member, depth);
    if (through) mergeCallers(callers, through);
  }
  mergeCallers(callers, thisCalls(bound, method, false, depth));
  return callers;
}

/**
 * The calls of the name a pattern gives a value of a literal it takes
 * apart: `var [g] = [f]` and `var { g } = { g: f }` call `f` wherever `g`
 * is called. Nothing when the literal is not a declarator's value; the
 * escape when the pattern is not one `patternSource` reads.
 */
function patternCalls(literal: NodePath<t.ArrayExpression | t.ObjectExpression>, value: t.Node, depth: number): Callers | undefined {
  const declarator = literal.parentPath;
  if (!declarator?.isVariableDeclarator() || declarator.node.init !== literal.node) return undefined;
  // `var g = [f]` names the literal, through which `f` may be called anywhere.
  if (declarator.node.id.type !== 'ArrayPattern' && declarator.node.id.type !== 'ObjectPattern') return undefined;
  const callers: Callers = { calls: [], escapes: false };
  let found = false;
  for (const name of Object.keys(t.getBindingIdentifiers(declarator.node.id))) {
    const picked = patternSource(declarator.node.id, literal.node, name);
    if (picked === 'unknown') {
      callers.escapes = true;
      continue;
    }
    // `var { f: g = d } = { f }` picks `f ?? d`, either of which may be the function.
    const held = picked && stripTypeWrappers(picked);
    const arms: (t.Node | undefined)[] = held?.type === 'LogicalExpression' ? [stripTypeWrappers(held.left), stripTypeWrappers(held.right)] : [held];
    if (!held || !arms.includes(value)) continue;
    found = true;
    const alias = declarator.scope.getBinding(name);
    if (alias) mergeCallers(callers, callsOf(alias, depth + 1));
    else callers.escapes = true;
  }
  return found || callers.escapes ? callers : { calls: [], escapes: false };
}

/** The calls of the name a pattern gives `method`: `var { f: m } = o` calls `o.f` wherever `m` is called; a rest takes every method. */
function destructuredCalls(pattern: t.ObjectPattern, method: string, scope: Scope, depth: number): Callers {
  const callers: Callers = { calls: [], escapes: false };
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') {
      callers.escapes = true;
      continue;
    }
    const key = !property.computed && property.key.type === 'Identifier' ? property.key.name : staticString(property.key);
    if (key === undefined) {
      callers.escapes = true;
      continue;
    }
    if (key !== method) continue;
    const alias = property.value.type === 'Identifier' ? scope.getBinding(property.value.name) : undefined;
    if (!alias) {
      callers.escapes = true;
      continue;
    }
    mergeCallers(callers, callsOf(alias, depth + 1));
  }
  return callers;
}

/**
 * The calls of a method every instance of a constructor has: `new U().f(...)`,
 * `var u = new U(); u.f(...)`, `this.f(...)` in another method of the same
 * prototype or in the constructor. A constructor used as anything but
 * `new U(...)`, a member read, or a call of a static - handed on as a value,
 * extended, applied - makes instances the tree cannot see.
 */
function instanceCalls(bound: Binding, method: string, depth: number): Callers {
  if (depth > MAX_ALIAS_DEPTH) return ESCAPES;
  const callers: Callers = { calls: [], escapes: false };
  for (const reference of bound.referencePaths) {
    const parent = reference.parentPath;
    if (!parent) continue;
    if (parent.isNewExpression() && parent.node.callee === reference.node) {
      const use = parent.parentPath;
      if (use && isMemberPath(use) && use.node.object === parent.node) {
        const keys = use.node.computed ? keyReader.read(use.node.property, use.node, use.scope, 0) : [propertyKey(use.node)];
        if (keys.some((key) => key === UNREAD_KEY)) callers.escapes = true;
        else if (keys.some((key) => keyMayBe(key, method))) mergeCallers(callers, callThrough(use, depth) ?? { calls: [], escapes: false });
        continue;
      }
      if (use?.isVariableDeclarator() && use.node.init === parent.node && use.node.id.type === 'Identifier') {
        const instance = use.scope.getBinding(use.node.id.name);
        if (instance && instance.path.node === use.node && instance.constant) mergeCallers(callers, holderCalls(instance, method, depth + 1));
        else callers.escapes = true;
        continue;
      }
      if (use?.isExpressionStatement()) continue;
      callers.escapes = true;
      continue;
    }
    if (isMemberPath(parent) && parent.node.object === reference.node) continue;
    callers.escapes = true;
  }
  mergeCallers(callers, thisCalls(bound, method, true, depth));
  return callers;
}

/**
 * `this.method(...)` inside the methods a holder binding declares: the
 * literal's own, a class's statics or instance methods, the functions
 * assigned to `U.prototype.*` and the body of `U` itself for a constructor.
 */
function thisCalls(bound: Binding, method: string, instance: boolean, depth: number): Callers {
  const callers: Callers = { calls: [], escapes: false };
  const bodies: NodePath[] = [];
  const declared = bound.path;
  if (declared.isVariableDeclarator()) {
    const init = declared.get('init');
    if (init.isObjectExpression() && !instance) bodies.push(init);
    else if (init.isClassExpression()) bodies.push(init);
    else if (instance && (init.isFunctionExpression() || init.isArrowFunctionExpression())) bodies.push(init);
  } else if (declared.isClassDeclaration()) {
    bodies.push(declared);
  } else if (declared.isFunctionDeclaration() && instance) {
    bodies.push(declared);
  }
  // The functions assigned to the holder's members, `o.run = function () {
  // this.f(...) }`, or to `U.prototype.*`, or a literal assigned to `U.prototype`.
  for (const reference of bound.referencePaths) {
    const member = reference.parentPath;
    if (!member || !isMemberPath(member) || member.node.object !== reference.node) continue;
    const above = member.parentPath;
    if (!instance) {
      if (above?.isAssignmentExpression() && above.node.left === member.node) bodies.push(above.get('right'));
      continue;
    }
    if (propertyKey(member.node) !== 'prototype') continue;
    if (above?.isAssignmentExpression() && above.node.left === member.node) bodies.push(above.get('right'));
    else if (above && isMemberPath(above) && above.node.object === member.node) {
      const assignment = above.parentPath;
      if (assignment?.isAssignmentExpression() && assignment.node.left === above.node) bodies.push(assignment.get('right'));
    }
  }
  for (const body of bodies) {
    for (const { member, owner } of thisMembers(body)) {
      // `this` inside a nested function that is not a method of the same holder is somebody else's.
      if (!isMethodOf(owner, body.node, instance)) continue;
      const keys = member.node.computed ? keyReader.read(member.node.property, member.node, member.scope, 0) : [propertyKey(member.node)];
      if (keys.some((key) => key === UNREAD_KEY)) {
        callers.escapes = true;
        continue;
      }
      if (!keys.some((key) => keyMayBe(key, method))) continue;
      const through = callThrough(member, depth + 1);
      if (through) mergeCallers(callers, through);
    }
  }
  return callers;
}

/** The `this.<key>` members of a holder body, with the function each sits in, remembered per body for one build; see the constructor. */
let thisMembersByBody = new WeakMap<t.Node, { member: NodePath<t.MemberExpression | t.OptionalMemberExpression>; owner: NodePath }[]>();

/** Every member read off `this` under `body`, in a function of `body`'s own: one walk of the body, however many methods are asked of it. */
function thisMembers(body: NodePath): { member: NodePath<t.MemberExpression | t.OptionalMemberExpression>; owner: NodePath }[] {
  let members = thisMembersByBody.get(body.node);
  if (members) return members;
  const found: { member: NodePath<t.MemberExpression | t.OptionalMemberExpression>; owner: NodePath }[] = [];
  body.traverse({
    ThisExpression(path) {
      const member = path.parentPath;
      if (!member || !isMemberPath(member) || member.node.object !== path.node) return;
      const owner = path.scope.getFunctionParent()?.path;
      if (owner && within(owner, body.node)) found.push({ member, owner });
    },
  });
  members = found;
  thisMembersByBody.set(body.node, members);
  return members;
}

/** Whether `ancestor` is on the path's way up: the depth of the tree, where a walk down `ancestor` is its size, for every `this` a holder's methods spell. */
function within(path: NodePath, ancestor: t.Node): boolean {
  for (let above: NodePath | null = path; above; above = above.parentPath) if (above.node === ancestor) return true;
  return false;
}

/** Whether a function is a method of the holder `body` is - one whose `this`, called as the holder's method, is the holder or its instance. */
function isMethodOf(owner: NodePath, body: t.Node, instance: boolean): boolean {
  if (owner.isArrowFunctionExpression()) {
    const outer = owner.parentPath?.scope.getFunctionParent()?.path;
    return !!outer && within(outer, body) && isMethodOf(outer, body, instance);
  }
  // The body itself: a function assigned to `o.f` or `U.prototype.f`, or the constructor `U`.
  if (owner.node === body) return true;
  if (owner.isClassMethod()) return owner.parentPath.parentPath?.node === body && owner.node.static !== instance;
  if (owner.isObjectMethod()) return owner.parentPath.node === body;
  const parent = owner.parentPath;
  if (!parent) return false;
  return parent.isObjectProperty() && parent.node.value === owner.node && parent.parentPath.node === body;
}

/**
 * The calls a callback at argument `at` receives from a builtin that runs
 * it over a literal: `[String].forEach(function (K) { ... })` hands `K` each
 * element, `Object.values(o).forEach(...)` each value of a holder the tree
 * can read, `Array.from([String], f)` each element of its first argument,
 * and a comparator, `[String, x].sort(f)`, two elements at once. Any other
 * list is one the tree cannot enumerate, and the escape; a callback of
 * anything else is `undefined`.
 */
function iteratedElements(call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>, at: number): Callers | undefined {
  const callee = stripTypeWrappers(call.node.callee);
  if (!isMember(callee)) return undefined;
  const method = propertyKey(callee);
  const object = stripTypeWrappers(callee.object);
  const fromArray = method === 'from' && object.type === 'Identifier' && object.name === 'Array' && !call.scope.getBinding('Array');
  const pairs = method === 'sort' || method === 'toSorted';
  const receives = fromArray || pairs ? 0 : ITERATES_ELEMENTS.get(method);
  if (receives === undefined || at !== (fromArray ? 1 : 0)) return undefined;
  const source = fromArray ? call.node.arguments[0] : callee.object;
  if (!source || source.type === 'SpreadElement') return ESCAPES;
  // `Array.from` lists a Map by its pairs, as iterating it does.
  const elements = method === 'then' ? promisedValues(source, call.scope) : arrayElements(source, call.node, call.scope, fromArray);
  if (!elements) return ESCAPES;
  const keys = iterationKeys(source, call.scope);
  const callers: Callers = { calls: [], escapes: false };
  elements.forEach((element, index) => {
    if (element === 'unknown') {
      callers.escapes = true;
      return;
    }
    // The element sits where the callback's parameter takes it, then its
    // index or a Map's key, then the receiver; `reduce` hands the
    // accumulator first, a comparator takes two elements, either of which
    // may be any. An element added after the literal has a place the tree
    // does not number.
    const args: t.Node[] = [];
    for (let i = 0; i < receives; i++) args.push(t.identifier('undefined'));
    if (pairs) args.push(element, element);
    else if (fromArray) args.push(element, t.numericLiteral(index));
    else args.push(element, keys[index] ?? UNREAD_VALUE, source);
    callers.calls.push({ args, scope: call.scope });
  });
  return callers;
}

/** A name bound nowhere, standing in for a value the tree cannot read where a node is needed. */
const UNREAD_VALUE = t.identifier('__unread');
/** `Reflect.apply`, for a call made through a name that holds it; a node of no tree, read by `invocation` as the route. */
const REFLECT_APPLY = t.memberExpression(t.identifier('Reflect'), t.identifier('apply'));

/**
 * What a callback run over the receiver gets as its second argument, one
 * per element the receiver lists: an index for an array or a list, a key
 * for a Map's pairs, the element itself for a Set.
 */
function iterationKeys(receiver: t.Node, scope: Scope): t.Node[] {
  let value = stripTypeWrappers(receiver);
  if (value.type === 'Identifier') {
    const held = heldSource(value.name, receiver, scope);
    if (held) value = stripTypeWrappers(held.node);
  }
  if (value.type === 'NewExpression') {
    const constructor = stripTypeWrappers(value.callee);
    const [init] = value.arguments;
    const listed = init && stripTypeWrappers(init);
    if (constructor.type !== 'Identifier' || !COLLECTIONS.has(constructor.name) || !listed || listed.type !== 'ArrayExpression') return [];
    const isMap = constructor.name === 'Map' || constructor.name === 'WeakMap';
    return listed.elements.map((element) => {
      const entry = element && stripTypeWrappers(element);
      if (!entry || entry.type === 'SpreadElement') return UNREAD_VALUE;
      if (!isMap) return entry;
      return entry.type === 'ArrayExpression' && entry.elements[0] && entry.elements[0].type !== 'SpreadElement' ? entry.elements[0] : UNREAD_VALUE;
    });
  }
  const keys: t.Node[] = [];
  for (let index = 0; index < 64; index++) keys.push(t.numericLiteral(index));
  return keys;
}

/**
 * What a promise's `then` hands its callbacks: the value `Promise.resolve(x)`
 * or `Promise.reject(x)` was given; any other promise's is a value the
 * tree cannot read.
 */
function promisedValues(promise: t.Node, scope: Scope): (t.Node | 'unknown')[] | undefined {
  const value = stripTypeWrappers(promise);
  if (value.type !== 'CallExpression') return undefined;
  const callee = stripTypeWrappers(value.callee);
  const spine = isMember(callee) ? memberSpine(callee) : undefined;
  if (!spine || spine.root !== 'Promise' || spine.keys.length !== 1 || scope.getBinding('Promise')) return undefined;
  if (spine.keys[0] !== 'resolve' && spine.keys[0] !== 'reject') return undefined;
  const [given] = value.arguments;
  return given === undefined ? [t.identifier('undefined')] : given.type === 'SpreadElement' ? ['unknown'] : [given];
}

/**
 * Every value a function returns, where it stands: each `return` argument,
 * or an expression body; `undefined` for a function the tree has no path
 * for. Remembered per function for one build, the way callers are.
 */
function returnsOf(fn: t.Function): { node: t.Node; scope: Scope }[] | undefined {
  const remembered = returnsByFunction.get(fn);
  if (remembered) return remembered.returns;
  const path = traverse.cache.scope.get(fn)?.path;
  let returns: { node: t.Node; scope: Scope }[] | undefined;
  if (path && path.isFunction() && path.node === fn) {
    const body = path.get('body');
    if (body.isExpression()) {
      returns = [{ node: body.node, scope: body.scope }];
    } else {
      const found: { node: t.Node; scope: Scope }[] = [];
      path.traverse({
        Function(inner) {
          inner.skip();
        },
        ReturnStatement(statement) {
          const argument = statement.node.argument;
          if (argument) found.push({ node: argument, scope: statement.scope });
        },
      });
      returns = found;
    }
  }
  returnsByFunction.set(fn, { returns });
  return returns;
}

/** Returns remembered by `returnsOf` for one build of the index; see the constructor. */
let returnsByFunction = new WeakMap<t.Function, { returns: { node: t.Node; scope: Scope }[] | undefined }>();
/**
 * The part of `value` a pattern gives `name`: the value itself for a plain
 * name, the matching element of an array literal or property of an object
 * literal for a destructuring, and unknown for a destructuring of anything
 * else, a rest, a default, or a hole, spread or computed key in the way.
 * `undefined` when the pattern does not bind `name`.
 */
function patternSource(pattern: t.Node, value: t.Node, name: string): t.Node | 'unknown' | undefined {
  const target = stripTypeWrappers(pattern);
  if (t.isIdentifier(target)) return target.name === name ? value : undefined;
  const binds = (node: t.Node): boolean => name in t.getBindingIdentifiers(node as t.Identifier);
  if (!binds(target)) return undefined;
  const init = stripTypeWrappers(value);
  // `var { S = String } = o`: the value, or the default where the value is
  // `undefined` - either, spelled as the `??` the language reads it as.
  const withDefault = (element: t.Node, given: t.Node | undefined): t.Node | 'unknown' | undefined => {
    if (!t.isAssignmentPattern(element)) return given ? patternSource(element, given, name) : 'unknown';
    if (given !== undefined && !t.isExpression(given)) return 'unknown';
    return patternSource(element.left, given === undefined ? element.right : t.logicalExpression('??', given, element.right), name);
  };
  if (t.isArrayPattern(target)) {
    if (!t.isArrayExpression(init)) return 'unknown';
    for (let index = 0; index < target.elements.length; index++) {
      const element = target.elements[index];
      if (!element || !binds(element)) continue;
      for (let i = 0; i <= index; i++) {
        const given = init.elements[i];
        if (i < index && (!given || t.isSpreadElement(given))) return 'unknown';
        if (given && t.isSpreadElement(given)) return 'unknown';
      }
      // `[a, ...rest] = [x, y, z]`: a fresh array of the elements left, spelled as one.
      if (t.isRestElement(element)) {
        const rest = init.elements.slice(index);
        return rest.some((given) => !given) ? 'unknown' : patternSource(element.argument, t.arrayExpression(rest as (t.Expression | t.SpreadElement)[]), name);
      }
      return withDefault(element, init.elements[index] ?? undefined);
    }
    return 'unknown';
  }
  if (t.isObjectPattern(target)) {
    for (const property of target.properties) {
      if (!binds(property)) continue;
      if (t.isRestElement(property)) {
        // `{ a, ...rest } = { a, b, c }`: a fresh object of the properties not named, spelled as one.
        if (!t.isObjectExpression(init)) return 'unknown';
        const named = new Set<string>();
        for (const other of target.properties) {
          if (t.isRestElement(other)) continue;
          const key = !other.computed && t.isIdentifier(other.key) ? other.key.name : staticString(other.key);
          if (key === undefined) return 'unknown';
          named.add(key);
        }
        const left = init.properties.filter((given) => t.isSpreadElement(given) || !named.has((!given.computed && t.isIdentifier(given.key) ? given.key.name : staticString(given.key)) ?? UNREAD_KEY));
        return patternSource(property.argument, t.objectExpression(left), name);
      }
      const key = !property.computed && t.isIdentifier(property.key) ? property.key.name : staticString(property.key);
      if (key === undefined) return 'unknown';
      if (t.isObjectExpression(init)) {
        const given = literalProperty(init, key);
        if (given === 'unknown') return 'unknown';
        return withDefault(property.value, given);
      }
      if (t.isAssignmentPattern(property.value)) return 'unknown';
      // `const { prototype: P } = String` reads `String.prototype`: the read
      // is spelled as the member it is, over the tree's own node.
      if (!t.isExpression(init)) return 'unknown';
      return patternSource(property.value, t.memberExpression(init, t.stringLiteral(key), true), name);
    }
    return 'unknown';
  }
  return 'unknown';
}

/** Whether a literal is truthy and whether it is nullish, for the branch a logical or conditional takes; `undefined` for anything else. */
function literalTruthiness(node: t.Node): { truthy: boolean; nullish: boolean } | undefined {
  const value = stripTypeWrappers(node);
  if (t.isStringLiteral(value)) return { truthy: value.value.length > 0, nullish: false };
  if (t.isNumericLiteral(value)) return { truthy: value.value !== 0 && !Number.isNaN(value.value), nullish: false };
  if (t.isBooleanLiteral(value)) return { truthy: value.value, nullish: false };
  if (t.isNullLiteral(value) || t.isIdentifier(value, { name: 'undefined' })) return { truthy: false, nullish: true };
  if (t.isUnaryExpression(value, { operator: 'void' })) return { truthy: false, nullish: true };
  return undefined;
}

/**
 * What an expression is an alias of; see `Origin`. A global is truthy and
 * not nullish, so `String || x` and `String ?? x` are `String` and `String
 * && x` is `x`; a literal picks its branch; anything else on the left of a
 * logical, or in the test of a conditional, makes both branches the value.
 * A call is what a function of this file returns, and otherwise a value the
 * tree cannot read; a `new` is a fresh object, no global.
 */
function originOf(node: t.Node, scope: Scope, depth: number, keys: readonly string[]): Origin {
  if (depth > MAX_ALIAS_DEPTH) return UNREAD;
  const value = stripTypeWrappers(node);
  if (t.isSequenceExpression(value)) {
    const last = value.expressions[value.expressions.length - 1];
    return last ? originOf(last, scope, depth + 1, keys) : NONE;
  }
  if (t.isAwaitExpression(value)) return originOf(value.argument, scope, depth + 1, keys);
  if (t.isAssignmentExpression(value)) {
    const right = originOf(value.right, scope, depth + 1, keys);
    if (value.operator === '=') return right;
    const left = t.isIdentifier(value.left) ? followAlias(value.left.name, scope, depth + 1, keys) : UNREAD;
    return mergeOrigins(left, right);
  }
  if (t.isLogicalExpression(value)) {
    const left = originOf(value.left, scope, depth + 1, keys);
    const definite = left !== undefined && left.places.length > 0 && !isUnread(left);
    const literal = literalTruthiness(value.left);
    const right = (): Origin => originOf(value.right, scope, depth + 1, keys);
    if (value.operator === '&&') {
      if (definite) return right();
      if (literal) return literal.truthy ? right() : NONE;
    } else {
      // Only a global itself is known truthy and not nullish; a property
      // of one, `globalThis.MyString || String`, may be missing, and the
      // value is either arm.
      const global = definite && !left.other && left.places.every((place) => place.keys.length === 0 && place.consumed === 0 && (NAMED_ROOTS.has(place.root) || GLOBAL_OBJECT_NAMES.has(place.root)));
      if (global) return left;
      if (literal) return (value.operator === '||' ? literal.truthy : !literal.nullish) ? NONE : right();
    }
    return mergeOrigins(left, right());
  }
  if (t.isConditionalExpression(value)) {
    const test = literalTruthiness(value.test);
    if (test) return originOf(test.truthy ? value.consequent : value.alternate, scope, depth + 1, keys);
    return mergeOrigins(originOf(value.consequent, scope, depth + 1, keys), originOf(value.alternate, scope, depth + 1, keys));
  }
  if (t.isIdentifier(value)) {
    // `var a = arguments; a[0].x = ...`: the arguments object, read at the key.
    if (value.name === 'arguments' && !scope.getBinding(value.name)) return argumentsOrigin(scope, depth + 1, keys) ?? NONE;
    return followAlias(value.name, scope, depth + 1, keys);
  }
  if (t.isThisExpression(value)) {
    if (scope.getFunctionParent() === null) return placeAt('this');
    // `this` in a function whose returns are being read for one call is
    // what that call's route made it; see `returnsOrigin`. The global
    // object a bare call binds in sloppy code is `undefined` in a function
    // that is strict on its own.
    const bound = boundThis(scope);
    if (bound) return bound.node === GLOBAL_THIS && ownStrictness(scope) ? NONE : originOf(bound.node, bound.scope, depth + 1, keys);
    // `this` in a method of a literal or a class the tree names is the
    // holder, or its instance, when the method is called as the holder's;
    // called any other way it is something else, which is `other`.
    const holder = thisHolderOf(scope);
    if (!holder) return NONE;
    if (!holder.instance) return mergeOrigins(originOf(holder.expression, holder.scope, depth + 1, keys), NONE);
    const constructor = originOf(holder.expression, holder.scope, depth + 1, []);
    let result: Origin = NONE;
    if (!constructor || isUnread(constructor)) result = mergeOrigins(result, UNREAD);
    for (const fn of constructor?.functions ?? []) result = mergeOrigins(result, instanceOrigin(fn, holder.scope, depth + 1, keys));
    return result;
  }
  if (t.isFunction(value)) return keys.length === 0 ? functionAt(value) : NONE;
  if (t.isClass(value)) {
    // A class is a holder of its statics; a `new` of it is `instanceOrigin`.
    const key = keys[0];
    if (key === undefined) return functionAt(value);
    const picked = classMember(value, key, true);
    if (picked === 'unknown') return UNREAD;
    if (!picked) return NONE;
    if (t.isClassMethod(picked) && picked.kind === 'get') return consumedOne(returnsOrigin(picked, depth + 1, keys.slice(1), { node: value, scope }));
    return consumedOne(originOf(picked, scope, depth + 1, keys.slice(1)));
  }
  if (t.isObjectExpression(value) || t.isArrayExpression(value)) {
    const key = keys[0];
    if (key === undefined) return NONE;
    // A key the tree could not read may be any element.
    if (!isRead(key)) return UNREAD;
    const picked = t.isObjectExpression(value) ? literalProperty(value, key) : literalElement(value, key);
    if (picked === 'unknown') return UNREAD;
    if (!picked) return NONE;
    // `{ get S() { return String; } }` read as `o.S` is what the getter returns, with the literal as `this`.
    if (t.isObjectMethod(picked) && picked.kind !== 'method') {
      return picked.kind === 'get' ? consumedOne(returnsOrigin(picked, depth + 1, keys.slice(1), { node: value, scope })) : UNREAD;
    }
    return consumedOne(originOf(picked, scope, depth + 1, keys.slice(1)));
  }
  if (isMember(value)) {
    // Every reading of every computed key in the chain, one origin per spelling of it.
    const chains: string[][] = [[]];
    let current: t.Node = value;
    while (isMember(current)) {
      const member: t.MemberExpression | t.OptionalMemberExpression = current;
      const readings = member.computed && literalKey(member) === UNREAD_KEY ? keyReader.read(member.property, member, scope, 0) : [literalKey(member)];
      const next: string[][] = [];
      for (const reading of readings) for (const chain of chains) next.push([reading, ...chain]);
      if (next.length > MAX_READINGS) return UNREAD;
      chains.splice(0, chains.length, ...next);
      current = stripTypeWrappers(member.object);
    }
    let result: Origin;
    for (const own of chains) {
      const through = prototypeReadThrough(own);
      if (through) {
        result = mergeOrigins(result, placeAt(through.root, through.keys));
        continue;
      }
      const base = originOf(current, scope, depth + 1, [...own, ...keys]);
      // A function reached one key deeper is the method the chain named,
      // not the function the chain started from.
      result = mergeOrigins(
        result,
        base && {
          places: base.places.map((place) =>
            place.consumed <= own.length
              ? { root: place.root, keys: [...place.keys, ...own.slice(place.consumed)], consumed: 0 }
              : { root: place.root, keys: place.keys, consumed: place.consumed - own.length },
          ),
          functions: base.functions,
          other: base.other,
        },
      );
    }
    return result;
  }
  if (t.isNewExpression(value)) {
    const invoked = invocation(value.callee, undefined, value.arguments, 0);
    if (!invoked) return UNREAD;
    let result: Origin;
    for (const arm of invoked.fns) {
      const constructor = originOf(arm, scope, depth + 1, []);
      // A `new` of a host constructor is a fresh object whatever the
      // constructor: `new Map()`, `new Set()`, `new Promise(...)` - a name
      // bound nowhere that nothing in the program assigns is the realm's
      // own, and `new` hands back the object it allocated unless the
      // constructor returns another. Two builtins do: `new Object(x)` is
      // `x` when `x` is an object, and `new Proxy(x, h)` forwards every
      // write it takes to `x`. Reading `new Map()` as a call the tree could
      // not open made an `Object[k](o)` handed the map a may-write of
      // something unknown, and the decoder computing `k` was deferred on its
      // own key at every preset.
      const hosted = hostConstructor(arm, constructor, scope);
      if (hosted !== undefined) {
        result = mergeOrigins(result, hosted === 'fresh' ? NONE : constructedFrom(value.arguments[0], scope, depth, keys));
        continue;
      }
      if (!constructor || isUnread(constructor)) {
        result = mergeOrigins(result, UNREAD);
        continue;
      }
      // An instance of a builtin, `new String('')`, is a fresh object.
      if (constructor.places.length > 0 || constructor.functions.length === 0) result = mergeOrigins(result, NONE);
      for (const fn of constructor.functions) result = mergeOrigins(result, instanceOrigin(fn, scope, depth + 1, keys));
    }
    return result;
  }
  if (t.isCallExpression(value) || t.isOptionalCallExpression(value)) {
    if (isPrototypeRead(value)) return placeAt(PROTOTYPE_OF_A_VALUE);
    if (isGlobalObjectRead(value)) return placeAt('globalThis');
    const bound = stripTypeWrappers(value.callee);
    // `Object.defineProperty.bind(Object)` is the method, for a call of it.
    if (isMember(bound) && propertyKey(bound) === 'bind') {
      return value.arguments.length <= 1 ? originOf(bound.object, scope, depth + 1, keys) : UNREAD;
    }
    const invoked = invocation(value.callee, undefined, value.arguments, 0);
    return invoked ? callOrigin(invoked, value, scope, depth, keys) : UNREAD;
  }
  // `var p = ''[k]` with a key the tree cannot read: the only members of a
  // string or a regex literal the index can name are its prototype's and
  // its constructor's, and the key may be either - kept as the hop it is,
  // in front of what follows, the way `finish` reads `''[k].split = ...`
  // where it stands. A number is a loop counter read under a computed key
  // in real code far more often than `(0)[k]` is a prototype read.
  const first = keys[0];
  if (first !== undefined && !isRead(first) && (t.isStringLiteral(value) || t.isTemplateLiteral(value) || t.isRegExpLiteral(value))) {
    return {
      places: [
        { root: PROTOTYPE_OF_A_VALUE, keys: [UNREAD_KEY], consumed: 1 },
        { root: CONSTRUCTOR_OF_A_VALUE, keys: [UNREAD_KEY], consumed: 1 },
      ],
      functions: [],
      other: false,
    };
  }
  return NONE;
}

/**
 * Whether a `new` reaches a constructor of the realm's own, and what that
 * makes the instance: `'fresh'` for every host constructor but the two
 * that give back what they were handed, `Object` and `Proxy`, which are
 * `'argument'`. `undefined` for a constructor of this file, a name the
 * program assigns, or one the tree cannot read - every one of them the
 * caller's to follow as before. A bare name is the realm's when no scope
 * binds it and `followAlias` found nothing the program gives it: nothing
 * at all for a builtin the allowlist does not name, or the one place that
 * is the builtin itself for one it does; `new globalThis.Map()` is the
 * same question asked of the global object's property.
 */
function hostConstructor(arm: t.Node, constructor: Origin, scope: Scope): 'fresh' | 'argument' | undefined {
  const callee = stripTypeWrappers(arm);
  let name: string;
  if (t.isIdentifier(callee)) {
    if (scope.getBinding(callee.name)) return undefined;
    name = callee.name;
    if (constructor !== undefined) {
      const [place] = constructor.places;
      const builtin = place !== undefined && constructor.places.length === 1 && constructor.functions.length === 0 && !constructor.other && place.root === name && place.keys.length === 0 && place.consumed === 0;
      if (!builtin) return undefined;
    }
  } else if (isMember(callee)) {
    const spine = memberSpine(callee);
    if (!spine || spine.root === 'this' || !GLOBAL_OBJECT_NAMES.has(spine.root) || spine.keys.length !== 1) return undefined;
    name = spine.keys[0]!;
    if (!isRead(name) || globalPropertyOrigin(name, 0, []) !== undefined) return undefined;
  } else {
    return undefined;
  }
  return name === 'Object' || name === 'Proxy' ? 'argument' : 'fresh';
}

/** `new Object(x)` and `new Proxy(x, h)`: `x` itself when it is an object, a fresh wrapper when it is a primitive, and a fresh object when there is none. */
function constructedFrom(argument: t.Node | undefined, scope: Scope, depth: number, keys: readonly string[]): Origin {
  if (argument === undefined || isPrimitiveLiteral(argument)) return NONE;
  if (argument.type === 'SpreadElement' || !t.isExpression(argument)) return UNREAD;
  return originOf(argument, scope, depth + 1, keys);
}

/** What a call `invocation` opened gives back at `keys`; the call branch of `originOf`. */
function callOrigin(
  invoked: NonNullable<ReturnType<typeof invocation>>,
  value: t.CallExpression | t.OptionalCallExpression,
  scope: Scope,
  depth: number,
  keys: readonly string[],
): Origin {
  if (depth > MAX_ALIAS_DEPTH) return UNREAD;
  let result: Origin;
  for (const arm of invoked.fns) {
    const listed = isMember(arm) ? arrayMethodOrigin(arm, invoked.args, scope, depth + 1, keys) : undefined;
    if (listed) {
      result = mergeOrigins(result, listed);
      continue;
    }
    // A method of a string, a number or a regex literal, or of what one
    // gave back - `'a,b'.split(',').map(f)` - returns a value of its own;
    // only a chain that leaves the literal for its constructor or
    // prototype reaches anything the tree names.
    if (isMember(arm) && primitiveChain(arm)) {
      result = mergeOrigins(result, NONE);
      continue;
    }
    // `var g = f.bind(t, a); g(b)`: `f` called with `t` as `this` and `a` first.
    const bound = boundCall(arm, value, scope, invoked.args);
    if (bound) {
      result = mergeOrigins(result, callOrigin(bound, value, scope, depth + 1, keys));
      continue;
    }
    const callee = originOf(arm, scope, depth + 1, []);
    if (!callee) {
      result = mergeOrigins(result, UNREAD);
      continue;
    }
    if (isUnread(callee)) result = mergeOrigins(result, UNREAD);
    // What the route made `this`: the object of a method call, the first
    // argument of `.call`; in a bare call of sloppy code, the global object.
    const receiver = invoked.thisArg === undefined ? (sloppyThis ? { node: GLOBAL_THIS, scope } : undefined) : { node: invoked.thisArg, scope };
    for (const fn of callee.functions) result = mergeOrigins(result, t.isFunction(fn) ? returnsOrigin(fn, depth + 1, keys, receiver) : UNREAD);
    for (const held of callee.places) {
        if (held.root === UNKNOWN_NAME) continue;
        const place = throughGlobalObject(held);
        const method = place.keys[0];
        if (place.consumed === 0 && method === undefined) {
          // A global called as a function: `Object(x)` gives back its
          // argument, and every other - `String(x)`, `Number(x)`, `Array(n)`,
          // `Function(src)` - a primitive or a value of its own.
          const [first] = invoked.args;
          if (place.root !== 'Object') result = mergeOrigins(result, NONE);
          else result = mergeOrigins(result, first && t.isExpression(first) ? originOf(first, scope, depth + 1, keys) : NONE);
        } else if (place.consumed !== 0 || method === undefined || place.keys.length > 1) {
          // A method of a property of a global: what `String.prototype.x(...)` returns is nothing the tree read.
          result = mergeOrigins(result, UNREAD);
        } else if (method === 'valueOf' && invoked.args.length === 0) {
          // `Math.valueOf()` is `Math`.
          result = mergeOrigins(result, placeAt(place.root));
        } else if ((place.root === 'Object' || place.root === 'Reflect') && method === 'getPrototypeOf') {
          // The prototype read, by whatever route or alias reached the method.
          result = mergeOrigins(result, invoked.args.length > 0 ? placeAt(PROTOTYPE_OF_A_VALUE) : UNREAD);
        } else if (method === UNREAD_KEY) {
          // `Object[k](x)` gives back `x` (`assign`, `freeze`, `seal`,
          // `preventExtensions`, `defineProperty`, `defineProperties`,
          // `setPrototypeOf`), its prototype (`getPrototypeOf`), or a value
          // of its own (`keys`, `entries`, `values`, `create`, `fromEntries`
          // and the rest) - every one of them, and nothing else, so the
          // value is `x` or its prototype or fresh, whatever `k` spells.
          // Read further, `Object[k](x).m`, it may also be what `values`,
          // `entries` or a descriptor hold of `x`, which no method the tree
          // cannot name is opened for: unread past the first key. With no
          // argument, a value of its own or a throw. `Reflect[k](x)` is
          // `get`, `apply` and `construct` besides, kept as the hop the
          // tree cannot read; `Array[k](x)` may hold `x`; `JSON[k](x)`,
          // `Math[k](x)`, `String[k](x)` give a value of their own, as
          // obfuscator.io spells every method it calls. Round fifteen read
          // `Object[k](x)` as the member `Object[*]` itself, so `Object[k]
          // (o)[j](...)` - `Object.keys(o).join(...)`, `Object.entries(o)
          // .reduce(...)` - was a reflective call through `Object[*][*]`.
          const root = place.root;
          if (root === 'Object') {
            const [first] = invoked.args;
            if (!first) result = mergeOrigins(result, NONE);
            else if (first.type === 'SpreadElement' || !t.isExpression(first)) result = mergeOrigins(result, UNREAD);
            else {
              result = mergeOrigins(result, mergeOrigins(mergeOrigins(originOf(first, scope, depth + 1, keys), placeAt(PROTOTYPE_OF_A_VALUE)), NONE));
              if (keys.length > 0) result = mergeOrigins(result, UNREAD);
            }
          } else if (root === 'Reflect') result = mergeOrigins(result, placeAt(root, [UNREAD_KEY]));
          else if (root === 'Array' || root === 'Function' || GLOBAL_OBJECT_NAMES.has(root)) result = mergeOrigins(result, UNREAD);
          else result = mergeOrigins(result, NONE);
        } else if (place.root === 'Object' && RETURNS_TARGET.has(method)) {
          const first = invoked.args[0];
          result = mergeOrigins(result, first && t.isExpression(first) ? originOf(first, scope, depth + 1, keys) : NONE);
        } else if (RETURNS_GIVEN.has(`${place.root}.${method}`)) {
          result = mergeOrigins(result, givenOrigin(place.root, method, value, invoked.args, scope, depth + 1, keys));
        } else {
          // Any other method of a global returns a value of its own: `JSON.stringify(x).substr(5)` is a fresh string.
          result = mergeOrigins(result, NONE);
        }
      }
    // A call of something the tree cannot name - a method of a literal,
    // `[String].pop()`, of an instance, `m.get(k)` - may give back
    // whatever it was given, which is a value the tree cannot read.
    if (callee.other && callee.functions.length === 0) result = mergeOrigins(result, UNREAD);
  }
  return result;
}

/** A string, number, boolean, bigint, null or template literal, or `undefined`: a value with no property of its own to write. */
function isPrimitiveLiteral(node: t.Node): boolean {
  const value = stripTypeWrappers(node);
  return (
    t.isStringLiteral(value) ||
    t.isNumericLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isNullLiteral(value) ||
    t.isTemplateLiteral(value) ||
    t.isIdentifier(value, { name: 'undefined' }) ||
    (t.isUnaryExpression(value) && (value.operator === '-' || value.operator === '+' || value.operator === '!' || value.operator === 'typeof' || value.operator === 'void'))
  );
}

/** Whether a member chain starts from a string, number, boolean, bigint or regex literal and never leaves it for its prototype or constructor. */
function primitiveChain(member: t.MemberExpression | t.OptionalMemberExpression): boolean {
  const spine = spineOf(member);
  const root = spine.root.type;
  // A unary or a binary operator yields a primitive too: `(typeof x).endsWith(...)`, `(a + b).split(...)`.
  if (root !== 'StringLiteral' && root !== 'TemplateLiteral' && root !== 'NumericLiteral' && root !== 'BooleanLiteral' && root !== 'BigIntLiteral' && root !== 'RegExpLiteral' && root !== 'UnaryExpression' && root !== 'BinaryExpression' && root !== 'UpdateExpression') return false;
  // A key the tree cannot read - `'😀'[dec(0x5e)]()`, as obfuscator.io spells
  // every method - names a method of the primitive all the same.
  return !leavesForPrototype(spine.keys);
}

/**
 * The call a name holding `f.bind(t, a...)` makes when called with `b...`: `f`
 * with `t` as `this` and `a...` before `b...`, as `invocation` opens it;
 * `undefined` for a callee that is no such name.
 */
function boundCall(arm: t.Node, at: t.Node, scope: Scope, args: readonly t.Node[]): ReturnType<typeof invocation> {
  const named = stripTypeWrappers(arm);
  if (named.type !== 'Identifier') return undefined;
  const held = heldSource(named.name, at, scope);
  const init = held && stripTypeWrappers(held.node);
  if (!init || (init.type !== 'CallExpression' && init.type !== 'OptionalCallExpression')) return undefined;
  const bound = stripTypeWrappers(init.callee);
  if (!isMember(bound) || propertyKey(bound) !== 'bind') return undefined;
  return invocation(bound.object, init.arguments[0], [...init.arguments.slice(1), ...args], 0);
}

/**
 * Methods of an array or a collection a holder may be that put what they
 * are given into it, by the first argument that is a value rather than a
 * key: `xs.push(String)` makes `String` one of `xs`'s elements, `m.set(k,
 * String)` one of the map's values. The write goes under an unread key,
 * since which slot it lands in is not the question a holder's keys answer.
 */
const ARRAY_ADDS_ARGUMENTS: ReadonlyMap<string, number> = new Map([
  ['push', 0],
  ['unshift', 0],
  ['add', 0],
  ['set', 1],
  ['splice', 2],
  ['fill', 0],
]);
/** The collections whose methods the tree reads as an array's; see `holderWrites`. */
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
/** Methods that only take away from a holder, reorder it, or read it: what it holds is unchanged. */
const ARRAY_KEEPS_ELEMENTS: ReadonlySet<string> = new Set([
  'pop', 'shift', 'slice', 'concat', 'reverse', 'sort', 'join', 'indexOf', 'lastIndexOf', 'includes', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'at', 'get', 'has', 'keys', 'values', 'entries', 'toString', 'delete', 'clear', 'forEach', 'map', 'filter', 'some', 'every', 'reduce', 'reduceRight', 'flat',
]);

/** Array methods that give back one of the receiver's elements; `get` a Map's value. */
const ELEMENT_METHODS: ReadonlySet<string> = new Set(['pop', 'shift', 'at', 'find', 'findLast', 'get']);

/**
 * The values a Map, a Set or their weak kinds are built with, as an array
 * literal, for `new Map([['k', String]]).get('k')` to read the way
 * `[String].pop()` is: a Map's pairs give their values, a Set's elements
 * themselves; `undefined` for a constructor that is not one of them, a
 * collection built from anything but a literal, or a pair the tree cannot
 * open.
 */
function collectionEntries(made: t.NewExpression, scope: Scope, pairs = false): t.ArrayExpression | undefined {
  const constructor = stripTypeWrappers(made.callee);
  if (constructor.type !== 'Identifier' || !COLLECTIONS.has(constructor.name) || scope.getBinding(constructor.name)) return undefined;
  const [init] = made.arguments;
  if (init === undefined) return t.arrayExpression([]);
  const listed = stripTypeWrappers(init);
  if (listed.type !== 'ArrayExpression') return undefined;
  // Iterated or spread, a Map is its pairs; read by `get` or `forEach`, its values.
  if (constructor.name === 'Set' || constructor.name === 'WeakSet' || pairs) return listed;
  const values: (t.Expression | t.SpreadElement)[] = [];
  for (const pair of listed.elements) {
    const entry = pair && stripTypeWrappers(pair);
    if (!entry || entry.type !== 'ArrayExpression' || entry.elements.length !== 2 || !entry.elements[1] || entry.elements[1].type === 'SpreadElement') return undefined;
    values.push(entry.elements[1]);
  }
  return t.arrayExpression(values);
}
/** Array methods that give back an array of the receiver's elements, in some order, `concat`'s with its arguments' among them. */
const ELEMENTS_METHODS: ReadonlySet<string> = new Set(['slice', 'concat', 'reverse', 'filter', 'flat', 'sort', 'toSorted', 'toReversed', 'with', 'toSpliced', 'splice', 'fill', 'copyWithin']);
/** Array methods that give back a number, a string, a boolean or nothing: a value of their own. */
const SCALAR_METHODS: ReadonlySet<string> = new Set([
  'join', 'indexOf', 'lastIndexOf', 'includes', 'some', 'every', 'findIndex', 'findLastIndex', 'toString', 'toLocaleString', 'forEach', 'push', 'unshift',
]);

/**
 * What a method called on an array literal - or on a name holding one and
 * written through nowhere, or on what an array method gave back - gives
 * back: `[String].pop()` is `String`, `[].concat(String)[0]` is `String`,
 * `[String].join('')` a string of its own; `map` and the rest give back
 * what a callback made, which the tree does not read. `undefined` for a
 * receiver that is no such array, which is `originOf`'s to read as a call.
 */
function arrayMethodOrigin(callee: t.MemberExpression | t.OptionalMemberExpression, args: readonly t.Node[], scope: Scope, depth: number, keys: readonly string[]): Origin | undefined {
  const method = propertyKey(callee);
  const listed = arrayChain(callee.object, callee, scope, 0);
  if (!listed) return undefined;
  if (SCALAR_METHODS.has(method)) return NONE;
  const element = ELEMENT_METHODS.has(method);
  // A method the tree cannot name - `[a, b][dec(0x1a)](...)`, as obfuscator.io
  // spells every one - is read as an element, or an array of them, which
  // is what every method of an array gives back but for a callback's own
  // results; a method it names and does not list is anything at all.
  const unread = method === UNREAD_KEY;
  if (!element && !unread && !ELEMENTS_METHODS.has(method)) return UNREAD;
  const held = (chain: ArrayChain, rest: readonly string[]): Origin => {
    let result: Origin = chain.unread ? UNREAD : undefined;
    for (const { node, scope: at } of chain.elements) result = mergeOrigins(result, node === 'unknown' ? UNREAD : originOf(node, at, depth, rest));
    return result ?? NONE;
  };
  // The array given back is a fresh one; an element of it is any the method lists.
  const elements = (): Origin => (keys.length === 0 ? NONE : consumedOne(held(arrayMethodResult(listed, method, args, scope), keys.slice(1))));
  if (element) return held(listed, keys);
  return unread ? mergeOrigins(held(listed, keys), elements()) : elements();
}

/** The elements an array may hold, each where it is read; `unknown` for one the tree cannot list, `unread` when some may be anything. */
interface ArrayChain {
  elements: { node: t.Node | 'unknown'; scope: Scope }[];
  unread: boolean;
}

/**
 * The elements of the array an array method gives back: the receiver's
 * for `filter`, `slice`, `reverse` and the rest that hand them on,
 * `concat`'s with its arguments, `flat`'s the elements of its element
 * arrays one level down, `with`'s, `fill`'s and `splice`'s with what is
 * put in; `map` and `flatMap` a callback's results, which the tree does
 * not read; a method it cannot name any of those.
 */
function arrayMethodResult(chain: ArrayChain, method: string, args: readonly t.Node[], scope: Scope): ArrayChain {
  if (method === 'map' || method === 'flatMap') return { elements: [], unread: true };
  const result: ArrayChain = { elements: [], unread: chain.unread };
  if (method === 'flat') {
    if (args.length > 0) return { elements: [], unread: true };
    for (const element of chain.elements) {
      const value = element.node === 'unknown' ? undefined : stripTypeWrappers(element.node);
      if (value?.type === 'ArrayExpression') for (const inner of value.elements) if (inner) result.elements.push({ node: inner.type === 'SpreadElement' ? 'unknown' : inner, scope: element.scope });
      else result.elements.push(element);
    }
    return result;
  }
  result.elements.push(...chain.elements);
  const given = method === 'concat' ? args : method === 'with' || method === 'fill' || method === 'splice' || method === 'toSpliced' ? args.slice(1) : [];
  for (const argument of given) result.elements.push({ node: argument.type === 'SpreadElement' ? 'unknown' : argument, scope });
  return result;
}

/**
 * The elements of an array the tree can list: a literal, with a spread of
 * a literal opened; a name holding one and written through nowhere it
 * cannot see, with what was pushed in; a Map's or a Set's entries; and
 * what an array method of one gave back - see `arrayMethodResult`.
 * `undefined` for anything else.
 */
function arrayChain(node: t.Node, at: t.Node, scope: Scope, depth: number): ArrayChain | undefined {
  if (depth > MAX_KEY_HOPS) return undefined;
  const value = stripTypeWrappers(node);
  const literal = (array: t.ArrayExpression, where: Scope): ArrayChain => {
    const chain: ArrayChain = { elements: [], unread: false };
    for (const element of array.elements) {
      if (!element) continue;
      if (element.type !== 'SpreadElement') {
        chain.elements.push({ node: element, scope: where });
        continue;
      }
      const spread = stripTypeWrappers(element.argument);
      if (spread.type === 'ArrayExpression') for (const inner of spread.elements) if (inner) chain.elements.push({ node: inner.type === 'SpreadElement' ? 'unknown' : inner, scope: where });
      else chain.unread = true;
    }
    return chain;
  };
  if (value.type === 'ArrayExpression') return literal(value, scope);
  if (value.type === 'NewExpression') {
    const made = collectionEntries(value, scope);
    return made ? literal(made, scope) : undefined;
  }
  if (value.type === 'Identifier') {
    const binding = scope.getBinding(value.name);
    if (!binding) return undefined;
    const init = heldSource(value.name, at, scope);
    const collection = init && init.node.type === 'NewExpression' ? collectionEntries(init.node, init.scope) : undefined;
    let chain: ArrayChain;
    if (init && collection) {
      chain = literal(collection, init.scope);
    } else {
      const held = keyReader.literalValues(value, at, scope, 0);
      if (held === 'unknown' || held.length === 0 || !held.every((each) => each.node.type === 'ArrayExpression')) return undefined;
      chain = { elements: [], unread: false };
      for (const each of held) {
        const listed = literal(each.node as t.ArrayExpression, each.scope);
        chain.elements.push(...listed.elements);
        chain.unread ||= listed.unread;
      }
    }
    // `xs.push(String)` before `xs.pop()`: the literal is not all the array holds; a holder that escapes may hold anything.
    const written = keyReader.holderWrites(binding, 0);
    if (written.escapes) return undefined;
    for (const write of written.writes) chain.elements.push({ node: write.value, scope: write.scope });
    return chain;
  }
  if (value.type === 'CallExpression' || value.type === 'OptionalCallExpression') {
    const callee = stripTypeWrappers(value.callee);
    if (!isMember(callee)) return undefined;
    const inner = arrayChain(callee.object, at, scope, depth + 1);
    if (!inner) return undefined;
    const method = propertyKey(callee);
    if (method !== UNREAD_KEY && !ELEMENTS_METHODS.has(method) && method !== 'map' && method !== 'flatMap') return undefined;
    return arrayMethodResult(inner, method, value.arguments, scope);
  }
  return undefined;
}

/**
 * Methods of a global that give back what they were given, at some key or
 * another, rather than a value of their own: `Array.of(x)` is `[x]`,
 * `Array.from(xs)` is `xs` element for element, `Object.values(o)` and
 * `Object.entries(o)` list a holder's values, `Reflect.get(o, k)` is
 * `o[k]`, and `Object.fromEntries` builds a holder out of its pairs.
 */
const RETURNS_GIVEN: ReadonlySet<string> = new Set(['Array.of', 'Array.from', 'Object.values', 'Object.entries', 'Object.fromEntries', 'Reflect.get']);

/** What a `RETURNS_GIVEN` call gives back at `keys`: read through the literal it lists where the tree can; unread where it cannot. */
function givenOrigin(root: string, method: string, call: t.CallExpression | t.OptionalCallExpression, args: readonly t.Node[], scope: Scope, depth: number, keys: readonly string[]): Origin {
  const [first, second] = args;
  if (!first || first.type === 'SpreadElement') return UNREAD;
  if (root === 'Array') {
    if (method === 'of') return originOf(t.arrayExpression(args.filter(t.isExpression) as t.Expression[]), scope, depth, keys);
    // `Array.from(xs, map)` runs the mapper; `Array.from(xs)` over anything but a literal is elements the tree cannot list.
    return second === undefined && first.type === 'ArrayExpression' ? originOf(first, scope, depth, keys) : UNREAD;
  }
  if (root === 'Reflect') {
    // `Reflect.get(o, k)` is `o[k]`: the key consumed on the way in is not one of the write's.
    if (!second || second.type === 'SpreadElement') return UNREAD;
    let result: Origin;
    for (const key of keyReader.read(second, call, scope, 0)) {
      if (!isRead(key)) return UNREAD;
      const held = originOf(first, scope, depth, [key, ...keys]);
      result = mergeOrigins(result, withPlaces(held, held?.places.map((place) => ({ ...place, consumed: Math.max(0, place.consumed - 1) })) ?? []));
    }
    return result;
  }
  if (method === 'fromEntries') return UNREAD;
  const listed = t.isCallExpression(call) ? holderList(call, call, scope, depth) : undefined;
  return listed ? originOf(listed, scope, depth, keys) : UNREAD;
}

/**
 * What an instance of a constructor of this file has at the keys asked
 * for: a class's instance method, or what `U.prototype.f = ...` and
 * `U.prototype = { f }` put there. With no key asked for, a fresh object.
 */
function instanceOrigin(constructor: t.Function | t.Class, scope: Scope, depth: number, keys: readonly string[]): Origin {
  const key = keys[0];
  if (key === undefined) return NONE;
  if (t.isClass(constructor)) {
    const picked = classMember(constructor, key, false);
    if (picked === 'unknown') return UNREAD;
    if (!picked) return NONE;
    // An instance getter's `this` is the instance, which the tree does not hold: its returns read with none.
    if (t.isClassMethod(picked) && picked.kind === 'get') return consumedOne(returnsOrigin(picked, depth + 1, keys.slice(1)));
    return consumedOne(originOf(picked, scope, depth + 1, keys.slice(1)));
  }
  const name = constructor.type === 'FunctionDeclaration' ? constructor.id?.name : declaredName(constructor);
  const bound = name === undefined ? undefined : (traverse.cache.scope.get(constructor)?.parent ?? scope).getBinding(name);
  if (!bound) return UNREAD;
  // Read against `['prototype', ...keys]`, so a place found there has one
  // key more consumed than the instance's own chain.
  const written = writtenOrigin(bound, depth, ['prototype', ...keys]);
  return withPlaces(written, written?.places.map((place) => ({ ...place, consumed: place.consumed - 1 })) ?? []);
}

/**
 * The value a class body gives a key among its statics, or among its
 * instance members: a method, or a property's value; unknown for a
 * computed key the tree cannot read, or a static block, in the way.
 */
function classMember(node: t.Class, key: string, isStatic: boolean): t.Node | 'unknown' | undefined {
  let value: t.Node | undefined;
  for (const member of node.body.body) {
    if (member.type === 'StaticBlock') {
      if (isStatic) return 'unknown';
      continue;
    }
    if (member.type !== 'ClassMethod' && member.type !== 'ClassProperty') continue;
    if (member.static !== isStatic) continue;
    const spelled = methodKey(member);
    if (spelled === undefined) {
      if (member.computed) return 'unknown';
      continue;
    }
    if (spelled !== key) continue;
    // A getter is read for what it returns, by `originOf`; a setter is a member the tree does not read.
    if (member.type === 'ClassMethod') {
      if (member.kind === 'set' || member.kind === 'constructor') return 'unknown';
      value = member;
    } else {
      value = member.value ?? undefined;
    }
  }
  return value;
}

/**
 * The holder a `this` in `scope` names: an expression for the literal,
 * the class or the constructor whose method the nearest function that is
 * not an arrow is - a method of a literal, a class method, a function
 * assigned to `o.f` or to `U.prototype.f` - and whether `this` is the
 * instance of it rather than the holder itself.
 */
function thisHolderOf(scope: Scope): { expression: t.Node; scope: Scope; instance: boolean } | undefined {
  let owner = scope.getFunctionParent();
  while (owner && owner.path.isArrowFunctionExpression()) owner = owner.path.parentPath?.scope.getFunctionParent() ?? null;
  if (!owner) return undefined;
  const fn = owner.path;
  if (fn.isObjectMethod()) {
    const literal = fn.parentPath;
    return literal.isObjectExpression() ? { expression: literal.node, scope: literal.scope, instance: false } : undefined;
  }
  if (fn.isClassMethod()) {
    const body = fn.parentPath;
    const carrier = body.parentPath;
    if (!carrier?.isClass()) return undefined;
    return { expression: carrier.node, scope: carrier.scope, instance: !fn.node.static };
  }
  if (!fn.isFunctionExpression()) return undefined;
  const parent = fn.parentPath;
  if (parent?.isObjectProperty() && parent.node.value === fn.node) {
    const literal = parent.parentPath;
    return literal.isObjectExpression() ? { expression: literal.node, scope: literal.scope, instance: false } : undefined;
  }
  if (parent?.isAssignmentExpression() && parent.node.right === fn.node && parent.node.operator === '=') {
    const left = stripTypeWrappers(parent.node.left);
    if (!isMember(left)) return undefined;
    const object = stripTypeWrappers(left.object);
    // `U.prototype.f = function () { this.g(...) }`: the instance; `o.f = function () { this.g(...) }`: the holder.
    if (isMember(object) && propertyKey(object) === 'prototype') return { expression: object.object, scope: parent.scope, instance: true };
    return { expression: object, scope: parent.scope, instance: false };
  }
  return undefined;
}

/**
 * What a function returns, at the keys asked for, with `this` in it bound
 * to what the call's route made it - `(function () { return this; }).call(T)`
 * returns `T` - for as long as the returns are read.
 */
function returnsOrigin(fn: t.Function, depth: number, keys: readonly string[], receiver?: { node: t.Node; scope: Scope }): Origin {
  if (fn.generator || fn.async) return UNREAD;
  const returns = returnsOf(fn);
  if (!returns) return UNREAD;
  const bound = receiver && !t.isArrowFunctionExpression(fn) && !receiversBound.has(fn);
  if (bound) receiversBound.set(fn, receiver);
  let result: Origin;
  try {
    for (const returned of returns) result = mergeOrigins(result, originOf(returned.node, returned.scope, depth + 1, keys));
  } finally {
    if (bound) receiversBound.delete(fn);
  }
  return result;
}

/** The receivers bound for the functions whose returns are being read; see `returnsOrigin`. */
const receiversBound = new WeakMap<t.Function, { node: t.Node; scope: Scope }>();

/** What `this` is in `scope`, when the nearest function that is not an arrow has a receiver bound; see `returnsOrigin`. */
function boundThis(scope: Scope): { node: t.Node; scope: Scope } | undefined {
  let owner = scope.getFunctionParent();
  while (owner && owner.path.isArrowFunctionExpression()) owner = owner.path.parentPath?.scope.getFunctionParent() ?? null;
  return owner && owner.path.isFunction() ? receiversBound.get(owner.path.node) : undefined;
}

/**
 * What `this` is in a callback a builtin runs with a receiver of the
 * caller's choosing: the second argument of `xs.forEach(cb, T)`, `map`,
 * `filter`, `some`, `every`, `find` and the rest that take one - `reduce`
 * takes an accumulator there, `then` nothing. `undefined` for a function
 * that is no such callback, or one with an arrow between.
 */
function callbackReceiver(scope: Scope): { node: t.Node; scope: Scope } | undefined {
  const owner = scope.getFunctionParent();
  if (!owner || !owner.path.isFunctionExpression()) return undefined;
  const call = owner.path.parentPath;
  if (!call || !(call.isCallExpression() || call.isOptionalCallExpression()) || call.node.arguments[0] !== owner.path.node) return undefined;
  const callee = stripTypeWrappers(call.node.callee);
  if (!isMember(callee)) return undefined;
  const method = propertyKey(callee);
  if (ITERATES_ELEMENTS.get(method) !== 0 || method === 'then') return undefined;
  const receiver = call.node.arguments[1];
  return receiver && receiver.type !== 'SpreadElement' ? { node: receiver, scope: call.scope } : undefined;
}

/** Whether the nearest function that is not an arrow, or one around it, opens with `'use strict'` of its own. */
function ownStrictness(scope: Scope): boolean {
  for (let owner = scope.getFunctionParent(); owner; owner = owner.path.parentPath?.scope.getFunctionParent() ?? null) {
    const body = owner.path.isFunction() ? owner.path.node.body : undefined;
    if (body?.type === 'BlockStatement' && body.directives.some(isUseStrict)) return true;
  }
  return false;
}
/** A value a key's name may hold, where it is read, or a value the tree cannot read; `appended` and `keysOf` as on `Source`. */
type KeySource = { node: t.Node; at: t.Node; scope: Scope; appended?: boolean; keysOf?: boolean } | 'unknown';

/**
 * Every value a name may hold at `at`, for a key: a binding never reassigned
 * is its one declarator's initialiser, as far as a destructuring lets it be
 * read, when the declarator has run by the time the write does; a binding
 * reassigned is every source it has, since which one the write sees is not
 * asked, a declarator with nothing to give holding `undefined`; a parameter
 * is what every caller of a fixed function hands it.
 */
function keySources(name: string, at: t.Node, scope: Scope): KeySource[] | 'unknown' {
  const binding = scope.getBinding(name);
  if (!binding) return 'unknown';
  const place = (source: Source): KeySource =>
    source === 'unknown' ? 'unknown' : { node: source.node, at: source.node, scope: source.scope, appended: source.appended, keysOf: source.keysOf };
  if (binding.kind === 'param') {
    const { sources, consumed } = paramSources(binding, []);
    if (consumed > 0) return 'unknown';
    return sources.map(place);
  }
  const declarator = binding.path;
  if (!declarator.isVariableDeclarator()) return 'unknown';
  if (binding.constant) {
    const held = heldSource(name, at, scope);
    return held ? [held] : 'unknown';
  }
  const sources = bindingSources(binding, name).map(place);
  // A declarator with nothing to give holds `undefined`, unless it is a
  // `for` head, which the loop fills before the body runs.
  const head = declarator.parentPath.parentPath;
  const loop = (head?.isForInStatement() || head?.isForOfStatement()) && head.node.left === declarator.parent;
  if (!declarator.node.init && !loop) sources.push({ node: t.identifier('undefined'), at: declarator.node, scope: declarator.scope });
  return sources;
}

/**
 * The value a name holds at `at`, for a key: its one declarator's
 * initialiser, as far as a destructuring lets it be read, when the binding
 * is never reassigned and the declarator has run by the time the write does.
 */
function heldSource(name: string, at: t.Node, scope: Scope): { node: t.Node; at: t.Node; scope: Scope } | undefined {
  const binding = scope.getBinding(name);
  if (!binding || !binding.constant) return undefined;
  const declarator = binding.path;
  if (!declarator.isVariableDeclarator() || !declarator.node.init) return undefined;
  const picked = patternSource(declarator.node.id, declarator.node.init, name);
  if (!picked || picked === 'unknown') return undefined;
  if (!holdsDeclaredValue(name, at, scope)) return undefined;
  return { node: picked, at: declarator.node, scope: declarator.scope };
}

/**
 * The chain with its calls read: `Object.getPrototypeOf(...)` at the front is
 * the prototype read; a call through a key that could not be read, wholly
 * or in part, is one hop that could not be read; a call through any other
 * method returns a value of its own, and the write is on that value, not on
 * the global - `undefined` here. The `Object` methods that return their
 * first argument were re-rooted at it by `spineOf`.
 */
function throughCalls(root: string, keys: readonly ChainKey[]): { root: string; keys: string[] } | undefined {
  let current = root;
  let chain: ChainKey[] = [...keys];
  for (let i = 0; i < chain.length; i++) {
    if (chain[i] !== CALLED) continue;
    const method = i > 0 ? chain[i - 1] : undefined;
    if (method === undefined || method === CALLED) return undefined;
    if (i === 1 && method === 'getPrototypeOf' && (current === 'Object' || current === 'Reflect')) {
      current = PROTOTYPE_OF_A_VALUE;
      chain = chain.slice(2);
      i = -1;
      continue;
    }
    if (!isRead(method)) {
      chain = [...chain.slice(0, i - 1), UNREAD_KEY, ...chain.slice(i + 1)];
      i -= 1;
      continue;
    }
    return undefined;
  }
  return { root: current, keys: chain as string[] };
}

/**
 * The root and keys of the chain a write's target is, before scope is asked:
 * `a.b.c` is root `a`, keys `[b, c]`; `a[k].c` keeps `k` for `readKey`; a
 * call on the chain is its method's key and then `CALLED`, with the `Object`
 * methods that return their first argument followed into it. The root is
 * whatever the chain starts from - a name, `this`, a literal, a call.
 */
function spineOf(node: t.Node): { root: t.Node; keys: RawKey[] } {
  const keys: RawKey[] = [];
  let current: t.Node = stripTypeWrappers(node);
  for (let hops = 0; hops < 64; hops++) {
    if (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') {
      keys.unshift(rawKey(current));
      current = stripTypeWrappers(current.object);
      continue;
    }
    if ((current.type === 'CallExpression' || current.type === 'OptionalCallExpression' || current.type === 'NewExpression') && !isPrototypeRead(current)) {
      const callee = stripTypeWrappers(current.callee);
      if (!isMember(callee)) break;
      const method = rawKey(callee);
      const first = current.arguments[0];
      if (
        typeof method === 'string' &&
        RETURNS_TARGET.has(method) &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'Object' &&
        first &&
        t.isExpression(first)
      ) {
        current = stripTypeWrappers(first);
        continue;
      }
      keys.unshift(method, CALLED);
      current = stripTypeWrappers(callee.object);
      continue;
    }
    break;
  }
  return { root: current, keys };
}

/** `propertyKey`, keeping a computed expression for `readKey` to ask about. */
function rawKey(member: t.MemberExpression | t.OptionalMemberExpression): RawKey {
  const { property, computed } = member;
  if (computed && property.type !== 'PrivateName') {
    // `xs[0]` is the key `0`, the way `literalKey` reads it.
    const literal = property.type === 'NumericLiteral' ? String(property.value) : staticString(property);
    return literal ?? property;
  }
  return propertyKey(member);
}

/** The expressions an assignment target writes to, patterns opened. */
function assignedTargets(node: t.Node): t.Node[] {
  const targets: t.Node[] = [];
  const walk = (current: t.Node): void => {
    const target = stripTypeWrappers(current);
    switch (target.type) {
      case 'ObjectPattern':
        for (const property of target.properties) walk(property.type === 'RestElement' ? property.argument : property.value);
        break;
      case 'ArrayPattern':
        for (const element of target.elements) if (element) walk(element);
        break;
      case 'RestElement':
        walk(target.argument);
        break;
      case 'AssignmentPattern':
        walk(target.left);
        break;
      default:
        targets.push(target);
    }
  };
  walk(node);
  return targets;
}

/** A loop or a `throw` as a reader would find it, its body elided. */
function spellStatement(statement: t.Statement): string {
  const spelled = t.isWhileStatement(statement)
    ? `while (${spellTest(statement.test)}) ...`
    : t.isDoWhileStatement(statement)
      ? `do ... while (${spellTest(statement.test)})`
      : t.isForStatement(statement)
        ? `for (...${statement.test ? ` ${spellTest(statement.test)}` : ''};...) ...`
        : t.isForInStatement(statement)
          ? 'for (... in ...) ...'
          : t.isForOfStatement(statement)
            ? 'for (... of ...) ...'
            : t.isThrowStatement(statement)
              ? 'throw ...'
              : '...';
  return `\`${spelled}\``;
}

/** The loop conditions an obfuscator writes for "forever", as written; anything else is elided. */
function spellTest(test: t.Expression): string {
  if (t.isBooleanLiteral(test) || t.isNumericLiteral(test)) return String(test.value);
  if (t.isUnaryExpression(test, { operator: '!' }) && t.isUnaryExpression(test.argument, { operator: '!' })) {
    const inner = test.argument.argument;
    if (t.isArrayExpression(inner) && inner.elements.length === 0) return '!![]';
    if (t.isObjectExpression(inner) && inner.properties.length === 0) return '!!{}';
  }
  return '...';
}

/**
 * Where a statement of the slice sits in the file: the line of the source
 * unit holding it. The slice's statements are clones without positions, and
 * the units the slicer cut from the owning scope are its sources, in the same
 * order at the tail of the list - a borrowed outer declaration comes first
 * and has no source here.
 */
function whereInSlice(slice: SliceResult, node: t.Node): string {
  const borrowed = slice.statements.length - slice.sources.length;
  for (let index = 0; index < slice.statements.length; index++) {
    if (!holds(slice.statements[index]!, node)) continue;
    const line = slice.sources[index - borrowed]?.node.loc?.start.line;
    return line === undefined ? '' : `, in the statement at line ${line}`;
  }
  return '';
}

/**
 * Why the place the budget ran out is not one the recogniser read, worded
 * for the refusal - or `undefined` when every loop running was modelled and
 * every function entered under them is one the shape read.
 *
 * Every running loop is asked, not only the innermost: the static
 * `unmodelledLoop` has already refused a loop the recogniser never read
 * anywhere in the slice, and this is the dynamic half of the same question,
 * asked of what actually ran. A function is the shape's when it sits under a
 * modelled subtree - the decoder and the helpers it declares inside itself -
 * or is one of the callees the shape read straight through, the accessor
 * and the forwarders; a frame of anything else under a modelled loop is
 * where the budget may have gone, and what that frame does - recurse, hang,
 * throw - is what the run was going to say.
 */
function budgetAstray(
  site: ExhaustionSite | undefined,
  modelled: ModelledCode | undefined,
  slice: SliceResult,
): string | undefined {
  if (!site) return 'somewhere the interpreter did not record';
  if (site.loops.length === 0) return 'outside any loop';
  if (!modelled) return 'in a loop the recogniser did not read';
  const underModelled = (node: t.Node): boolean => modelled.subtrees.some((root) => holds(root, node));
  for (const loop of site.loops) {
    if (modelled.loops.includes(loop) || underModelled(loop)) continue;
    return `in a loop the recogniser did not read (${spellStatement(loop)}${whereInSlice(slice, loop)})`;
  }
  if (site.recursed) {
    return `in a recursion through ${spellFunction(site.recursed)}${whereInSlice(slice, site.recursed)}`;
  }
  if (site.callback) {
    return `in a callback a builtin invoked, ${spellFunction(site.callback)}${whereInSlice(slice, site.callback)}`;
  }
  for (const fn of site.entered) {
    if (modelled.callees.includes(fn) || underModelled(fn)) continue;
    return `in a call the recogniser did not read, to ${spellFunction(fn)}${whereInSlice(slice, fn)}`;
  }
  return undefined;
}

/** A function as a reader would find it: its name and arity, its body elided. */
function spellFunction(fn: t.Function): string {
  const params = fn.params.map(() => '...').join(', ');
  if (t.isArrowFunctionExpression(fn)) return `\`(${params}) => ...\``;
  const name = t.isFunctionDeclaration(fn) || t.isFunctionExpression(fn) ? (fn.id?.name ?? '') : spellTarget(fn.key);
  return `\`function ${name}(${params}) ...\``;
}

/** Whether `needle` is `root` or somewhere under it. */
function holds(root: t.Node, needle: t.Node): boolean {
  const stack: t.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === needle) return true;
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return false;
}

/** An assignment, update, delete or `for` head as a reader would find it in the file. */
function spellWrite(write: HostWrite): string {
  const node = write.node;
  const line = node.loc?.start.line;
  const where = line === undefined ? '' : ` at line ${line}`;
  const spelled = t.isAssignmentExpression(node)
    ? `${spellTarget(node.left)} ${node.operator} ...`
    : t.isUpdateExpression(node)
      ? node.prefix
        ? `${node.operator}${spellTarget(node.argument)}`
        : `${spellTarget(node.argument)}${node.operator}`
      : t.isUnaryExpression(node)
        ? `delete ${spellTarget(node.argument)}`
        : t.isForInStatement(node)
          ? `for (${spellTarget(node.left)} in ...)`
          : t.isForOfStatement(node)
            ? `for (${spellTarget(node.left)} of ...)`
            : t.isCallExpression(node)
              ? spellCall(node)
              : '...';
  return `\`${spelled}\`${where}`;
}

/** A reflective write as a reader would find it: the callee, the object, a literal key, the rest elided. */
function spellCall(call: t.CallExpression): string {
  const [object, key] = call.arguments;
  const parts = [object ? spellTarget(object) : '...'];
  if (key) {
    const literal = staticString(key);
    parts.push(literal !== undefined ? JSON.stringify(literal) : t.isObjectExpression(key) ? '{...}' : '...');
  }
  if (call.arguments.length > 2 || (call.arguments.length === 2 && !t.isObjectExpression(key))) parts.push('...');
  return `${spellTarget(call.callee)}(${parts.join(', ')})`;
}

function spellTarget(node: t.Node): string {
  const target = stripTypeWrappers(node);
  if (t.isIdentifier(target)) return target.name;
  if (t.isThisExpression(target)) return 'this';
  if (t.isMemberExpression(target)) {
    const object = spellTarget(target.object);
    if (!target.computed && t.isIdentifier(target.property)) return `${object}.${target.property.name}`;
    if (t.isStringLiteral(target.property)) return `${object}[${JSON.stringify(target.property.value)}]`;
    return `${object}[...]`;
  }
  if (t.isCallExpression(target) || t.isNewExpression(target)) {
    const callee = stripTypeWrappers(target.callee);
    return t.isMemberExpression(callee) || t.isIdentifier(callee) ? `${spellTarget(callee)}(...)` : '...';
  }
  return '...';
}

const hostWritesByRound = new WeakMap<StatementScanCache, HostWriteIndex>();
const forwardersByRound = new WeakMap<StatementScanCache, Map<string, ArgumentForwarder>>();

/** The calls a candidate's own tier can read the key of; see `ownKeys`. */
interface OwnKeys {
  /** Whether a call to `callee` reaches the candidate: one of its names, or a forwarder chain ending at one. */
  covers(callee: string): boolean;
  /** The candidate's own call a call of `binding` under `name` with `args` amounts to, or `undefined` when it does not reach the candidate or an argument does not resolve. */
  reach(binding: Binding, name: string, args: ArgumentTuple): { name: string; args: ArgumentTuple } | undefined;
}

/** How many forwarders a chain to the candidate may pass through; `resolveForwardedCall`'s own bound. */
const OWN_KEY_HOPS = 8;

/**
 * The calls a candidate's own tier can read the key of: a call to one of
 * `names` - the roots and their aliases - or to a forwarder that reaches
 * one, `function w(a, b) { return dec(b - 0x1f); }`, the wrapper shape
 * obfuscator.io puts every call through. `covers` answers for a callee the
 * write index could not read a call to, by name; `reach` resolves one
 * call, by the binding its name has where it is made, to the candidate's
 * own call: the binding is one the slice declares under one of the names,
 * or a forwarder's, and the forwarders are the round's, read once from the
 * program the way `strings.discover` reads them for its samples and
 * trusted the same way - the first hop checked against the binding, the
 * rest by name.
 */
function ownKeys(program: NodePath<t.Program>, slice: SliceResult, names: readonly string[], scans: StatementScanCache | undefined): OwnKeys {
  const own = new Set(names);
  // The bindings the names have in the scope the slice was cut from, and
  // the program's for an alias `strings.discover` listed from its top level.
  const bindings = new Set<Binding>();
  // A function, or a name given another name - the table root is a call of
  // nothing, and a call of it is no key the decoder computes.
  const callable = (binding: Binding): boolean => {
    if (boundFunction(binding) !== undefined) return true;
    const path = binding.path;
    return path.isVariableDeclarator() && path.node.init !== null && path.node.init !== undefined && t.isIdentifier(stripTypeWrappers(path.node.init));
  };
  for (const source of slice.sources) {
    const node = source.node;
    if (t.isFunctionDeclaration(node) && node.id && own.has(node.id.name)) {
      const binding = source.parentPath?.scope.getBinding(node.id.name);
      if (binding && binding.path.node === node) bindings.add(binding);
    } else if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (!t.isIdentifier(declarator.id) || !own.has(declarator.id.name)) continue;
        const binding = source.scope.getBinding(declarator.id.name);
        if (binding && binding.path.node === declarator && callable(binding)) bindings.add(binding);
      }
    }
  }
  for (const name of names) {
    const binding = program.scope.getBinding(name);
    if (binding && callable(binding)) bindings.add(binding);
  }
  let forwarders: Map<string, ArgumentForwarder> | undefined;
  const table = (): Map<string, ArgumentForwarder> => (forwarders ??= perRound(scans, forwardersByRound, () => collectArgumentForwarders([program.node])));
  const stop = (name: string): boolean => own.has(name);
  return {
    covers: (callee) => {
      let current = callee;
      for (let hops = 0; hops <= OWN_KEY_HOPS; hops++) {
        if (own.has(current)) return true;
        const forwarder = table().get(current);
        if (!forwarder) return false;
        current = forwarder.callee;
      }
      return false;
    },
    reach: (binding, name, args) => {
      if (bindings.has(binding)) return { name, args };
      const forwarder = table().get(name);
      if (!forwarder || forwarder.fn !== boundFunction(binding)) return undefined;
      const resolved = resolveForwardedCall(name, args, table(), stop);
      return resolved && own.has(resolved.name) ? resolved : undefined;
    },
  };
}

/** The function a binding declares: a declaration's own node, or the function a declarator holds. */
function boundFunction(binding: Binding): t.Function | undefined {
  const path = binding.path;
  if (path.isFunctionDeclaration()) return path.node;
  if (path.isVariableDeclarator() && path.node.init) {
    const init = stripTypeWrappers(path.node.init);
    return t.isFunction(init) ? init : undefined;
  }
  return undefined;
}

function hostWriteIndex(program: NodePath<t.Program>, scans: StatementScanCache | undefined): HostWriteIndex {
  return perRound(scans, hostWritesByRound, () => new HostWriteIndex(program, scans));
}

/** Why a write is only a "may": its key could not be read, or the object it is written on. */
type Unread = 'key' | 'object';

/**
 * The first write in the program that could change what the slice reads
 * through a name in `outside`, with the write spelled and the reason worded
 * for the refusal - or, when the only such writes have a key or an object
 * the tree does not say, the first of those, marked `unread` for the preset
 * to decide. First in program order over every route below, so that the
 * write named is the one a reader meets first, not the one the route met
 * first.
 *
 * A write and a read are compared as property paths under the name. The
 * write reaches the read when it rewrites the name itself, a property on
 * the read's path, or the property the read ends at; a write *below* the
 * read reaches it only when the read goes on - a value the slice holds and
 * may read further - and not when the read is a call, since
 * `String.fromCharCode.x = 1` changes nothing about calling
 * `String.fromCharCode`. A `*` on the read's side matches any key, because
 * the slice reads it could be that one; a `*` on the write's side is a hop
 * the tree could not read, and the rule for it is `tailHit`: what is
 * spelled after the hop decides, and only a tail spelled by nothing is the
 * unread write the helper policy takes. A key spelled in part, `spl*`, is
 * read as every name it fits. A write the index recorded as one reading
 * among several - an alias of one of two globals, a key of one of two
 * strings - is judged like any other and worded as what it may be: a
 * refusal at every preset, since the reading that reaches the slice may be
 * the one that runs.
 *
 * A write under the unknown name - `globalThis[k]...`, an alias whose sources
 * the tree could not all read - is a write to this name for all the tree
 * says, and is judged as the chain with that hop unread in front.
 *
 * Prototypes are the one route to the slice's values that names no global
 * it reads: `String.prototype.charCodeAt = ...` changes what `s.charCodeAt()`
 * does in a decoder that never spells `String`. So every builtin's
 * `prototype` writes are read against the members the slice reads or calls
 * on anything at all, whatever the receiver - a decoder calling `.split`
 * on its table entry is refused for `Array.prototype.split = ...` as much as
 * for `String.prototype.split = ...`, which is the cheap side to be wrong on
 * - and a first key that could not be read, `String[k].split = ...`, is read
 * as though it were `prototype`, since it may be.
 */
/**
 * Whether a node of the program sits under one of the slice's own source
 * statements. Answered from one walk of the sources, made on the first
 * question: the writes under every name the slice reads are asked, and a
 * walk per write over a table of thirty thousand literals was twelve
 * seconds on obfuscated2.js.
 */
function insideSources(slice: SliceResult): (node: t.Node) => boolean {
  let inside: Set<t.Node> | undefined;
  return (node) => {
    if (inside === undefined) {
      inside = new Set();
      const stack: t.Node[] = slice.sources.map((source) => source.node);
      while (stack.length > 0) {
        const current = stack.pop()!;
        inside.add(current);
        for (const key of VISITOR_KEYS[current.type] ?? []) {
          const child = (current as unknown as Record<string, unknown>)[key];
          if (Array.isArray(child)) {
            for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
          } else if (child && typeof (child as t.Node).type === 'string') {
            stack.push(child as t.Node);
          }
        }
      }
    }
    return inside.has(node);
  };
}

/** The index with the writes `left` says to leave out; the disclosure book stays the index's. */
/** Judgements of `builtinWritten` by statement shape, per index; see the note inside. */
const judgedShapes = new WeakMap<HostWriteIndex, Map<string, ReturnType<typeof writtenHostName> | null>>();

/**
 * Whether a write of the program reaches a builtin `statements` read, judged
 * as `buildDecoder` judges a slice: a certain write refuses at every preset;
 * one that only may reach it refuses at conservative, waits on a key another
 * round may spell, and is otherwise taken for the helper it is in every
 * mainstream file, disclosed once. For a pass that folds a builtin call in
 * place and has no slice; the string says which write and why.
 */
export function builtinWritten(
  program: NodePath<t.Program>,
  statements: readonly t.Statement[],
  outside: readonly string[],
  config: ResolvedConfig,
  scans: StatementScanCache | undefined,
  note?: (severity: Severity, message: string) => void,
): string | undefined {
  const index = hostWriteIndex(program, scans);
  // The judgement reads the whole program's writes against the names and
  // members of the statement, and nothing about where the statement stands,
  // so one answer serves every fold of the same shape in the round: a
  // bundle has thousands of `'...'.split(...)` and `parseInt(...)` sites, and the
  // may-writes under an unread name are judged against each.
  const reads = hostReads(statements, new Set(outside));
  const shape = JSON.stringify([outside, [...reads.byName], [...reads.members]]);
  let judged = judgedShapes.get(index);
  if (!judged) judgedShapes.set(index, (judged = new Map()));
  let written = judged.get(shape);
  if (written === undefined) {
    written = writtenHostName({ statements: [...statements] }, outside, index) ?? null;
    judged.set(shape, written);
  }
  if (!written) return undefined;
  if (!written.unread || config.preset === 'conservative') {
    return `the program assigns to ${written.what}, ${written.reason}`;
  }
  if (written.deferrable !== undefined && !written.quiet) {
    return `the key of ${written.what} is computed by a call to ${written.deferrable}, which this round cannot read`;
  }
  if (!written.quiet && index.disclose(written.what)) {
    note?.(
      'warning',
      `Taking the program's assignment to ${written.what} for ${written.unread === 'object' ? 'an object' : 'a property'} ` +
        `no folded builtin reads: it cannot be read, and if it names one they do, every value folded from that ` +
        `builtin is the builtin's reading and not the program's. The conservative preset refuses instead.`,
    );
  }
  return undefined;
}

function withoutWrites(writes: HostWrites, left: (node: t.Node) => boolean): HostWrites {
  return {
    of: (name) => writes.of(name).filter((write) => !left(write.node)),
    disclose: (what) => writes.disclose(what),
  };
}

function writtenHostName(
  slice: Pick<SliceResult, 'statements'>,
  outside: readonly string[],
  writes: HostWrites,
): { what: string; reason: string; unread: Unread | false; object?: string; deferrable?: string; quiet: boolean; reflective: boolean } | undefined {
  const reads = hostReads(slice.statements, new Set(outside));
  // Every write that reaches a read, certain or not; the first in program
  // order of each kind is the one named, whichever route it came by.
  let certain: { write: HostWrite; reason: string } | undefined;
  let unread: { write: HostWrite; reason: string } | undefined;
  // Among the unread writes, one the balanced preset says something about
  // comes before one it takes quietly, whatever their order: the candidate
  // is quiet only when every unread write that reaches it is.
  const hit = (write: HostWrite, reason: string, sure: boolean): void => {
    if (sure) {
      if (!certain || write.order < certain.write.order) certain = { write, reason };
    } else if (!unread || (unread.write.quiet && !write.quiet) || (unread.write.quiet === write.quiet && write.order < unread.write.order)) {
      unread = { write, reason };
    }
  };
  /**
   * Why a write that reaches the slice is not the builtin - or may not be,
   * for a write of several readings, or one whose key is spelled in part.
   */
  const because = (write: HostWrite, keys: readonly string[]): string | undefined =>
    write.maybe
      ? 'the write has more than one reading, and this one reaches what the slice reads'
      : keys.some((key) => key !== UNREAD_KEY && !isRead(key))
        ? 'a key of the write is spelled in part, and what it may spell reaches what the slice reads'
        : undefined;
  const isNot = (write: HostWrite, keys: readonly string[], name: string): string => {
    const why = because(write, keys);
    return why ? `so ${name} may not be the builtin every tier would run: ${why}` : `so ${name} is not the builtin every tier would run`;
  };

  for (const name of outside) {
    if (name === 'arguments') continue;
    const paths = reads.byName.get(name) ?? [];
    const judge = (write: HostWrite, keys: readonly string[]): void => {
      const opaque = keys.findIndex((key) => !isRead(key));
      if (opaque < 0) {
        if (paths.some((read) => reaches(keys, read, false))) hit(write, isNot(write, keys, name), true);
        return;
      }
      // `Math['ro' + k]` fits `round`: what a key spelled in part may name.
      if (keys[opaque] !== UNREAD_KEY && paths.some((read) => reaches(keys, read, false))) {
        hit(write, isNot(write, keys, name), true);
        return;
      }
      const tail = tailHit(keys.slice(opaque + 1), reads.members);
      if (tail === 'certain') {
        hit(write, `so a member the slice reads on a value may be what it writes, on an object the tree cannot read`, true);
      } else if (tail === 'unread' && paths.length > 0) {
        hit(write, `so ${name} may not be the builtin every tier would run`, false);
      } else if (tail === undefined && paths.some((read) => reaches(keys, read, true))) {
        hit(write, `so ${name} may not be the builtin every tier would run`, false);
      }
    };
    for (const write of writes.of(name)) judge(write, write.keys);
    // A write to the constructor of some value is read against every name
    // the slice reads a builtin's property through, the way a prototype
    // write is read against every member: `''.constructor` is `String`, and
    // which value's constructor it was is the cheap side to be wrong on.
    for (const write of writes.of(CONSTRUCTOR_OF_A_VALUE)) judge(write, write.keys);
    // A write to a global whose name cannot be read is a write to this one
    // for all the tree says: the chain with that hop in front. A write to an
    // object the tree could not read - an alias with a source it cannot
    // open, a local under `with` - is one the helper policy decides, since
    // it is some object, and not the global by another name.
    for (const write of writes.of(UNKNOWN_NAME)) {
      if (write.unreadObject === undefined) judge(write, [UNREAD_KEY, ...write.keys]);
      else if (paths.length > 0) hit(write, `so ${name} may not be the builtin every tier would run`, false);
    }
  }

  // A prototype write reaches every member the slice touches on a value,
  // whichever builtin's prototype it is: the named ones through their
  // `prototype`, and the prototype of some value - `Object.getPrototypeOf(x)`,
  // `x.__proto__`, `x.constructor.prototype` - through nothing the tree names.
  const prototype = (write: HostWrite, members: readonly string[], afterUnread: boolean): void => {
    const member = members[0];
    // A write past a hop the tree could not read - `String[k].split` - is
    // a write to the prototype only if the hop is `prototype`: a "may".
    const why = because(write, write.keys) ?? (afterUnread ? 'the key before it cannot be read, and may be `prototype`' : undefined);
    if (member === undefined) {
      hit(write, why ? `so nothing the slice calls on a value may be the builtin: ${why}` : 'so nothing the slice calls on a value is the builtin', true);
    } else if (member === UNREAD_KEY || (afterUnread && !isRead(member))) {
      const tail = tailHit(members, reads.members);
      if (tail === 'certain') {
        hit(write, 'so a member the slice reads on a value may be what it writes, through a key the tree cannot read', true);
      } else if (tail === 'unread') {
        hit(write, 'so a method the slice calls on a value may not be the builtin', false);
      }
    } else if (!isRead(member)) {
      // `String.prototype['spl' + k]`: what the spelling fits is certain,
      // and a spelling that fits nothing is the key the presets decide on.
      if (memberMayBe(reads.members, member)) {
        hit(write, `so a member the slice reads on a value may not be the builtin every tier would run: ${why}`, true);
      } else {
        hit(write, 'so a method the slice calls on a value may not be the builtin', false);
      }
    } else if (memberMayBe(reads.members, member)) {
      hit(
        write,
        why
          ? `so a member the slice reads on a value may not be the builtin every tier would run: ${why}`
          : `so the ${member} the slice reads on a value is not the builtin every tier would run`,
        true,
      );
    } else if (reads.members.has(CALLED_UNREAD)) {
      // The slice calls a method it does not name - `d[f][v(B.c)](',')` in a
      // second-layer decoder whose method names are themselves decoded -
      // and a readable prototype write may be to that very method. The name
      // channel already reads a computed read as any property; this is the
      // prototype channel's side of the same question.
      hit(write, `so the ${member} written here may be the method the slice calls through a key it cannot read`, true);
    }
  };
  for (const constructor of PROTOTYPED_GLOBALS) {
    for (const write of writes.of(constructor)) {
      const first = write.keys[0];
      if (first === 'prototype') prototype(write, write.keys.slice(1), false);
      else if (first !== undefined && !isRead(first) && write.keys.length > 1 && keyMayBe(first, 'prototype')) {
        // `String[k].split`, `String['proto' + k].split`: read as though the key were `prototype`.
        prototype(write, write.keys.slice(1), true);
      }
    }
  }
  for (const write of writes.of(PROTOTYPE_OF_A_VALUE)) prototype(write, write.keys, false);

  const found = certain ?? unread;
  if (!found) return undefined;
  const object = found === unread ? found.write.unreadObject : undefined;
  return {
    what: spellWrite(found.write),
    reason: found.reason,
    unread: found === unread ? (object === undefined ? 'key' : 'object') : false,
    object,
    deferrable: found === unread ? found.write.deferrable : undefined,
    quiet: found === unread && found.write.quiet,
    reflective: found.write.reflective,
  };
}

/**
 * What the keys after a hop the tree could not read say about a write. A
 * readable key among them that names a member the slice reads is a write
 * that may reach that member: `String[k].split = ...` may be
 * `String.prototype.split`, and is certain, since the helper policy takes
 * an unread key for a property no decoder reads, and this key is read.
 * Keys spelled by nothing, or only in part - `window[k][j + 'e']` in
 * obfuscated2.js, which fits `replace` and is a handler on some global -
 * are the unread write that policy is for: past a hop the tree could not
 * read, a spelling in part is evidence of nothing more than the hop. A
 * readable tail naming no member the slice reads is a write the slice
 * cannot see, unless the slice calls a method by a key it cannot read, in
 * which case any name may be the one and the write is certain.
 */
function tailHit(tail: readonly string[], members: ReadonlySet<string>): 'certain' | 'unread' | undefined {
  if (tail.some((key) => isRead(key) && members.has(key))) return 'certain';
  if (tail.every((key) => !isRead(key))) return 'unread';
  return members.has(CALLED_UNREAD) ? 'certain' : undefined;
}

/** Whether a write at `write` under a name changes a read at `read` under it; see `writtenHostName`. */
function reaches(write: readonly string[], read: readonly string[], unreadKeysMatch: boolean): boolean {
  const shared = Math.min(write.length, read.length);
  for (let i = 0; i < shared; i++) {
    const w = write[i]!;
    const r = read[i]!;
    if (r === UNREAD_KEY) continue;
    if (w === UNREAD_KEY) {
      if (unreadKeysMatch) continue;
      return false;
    }
    if (!keyMayBe(w, r)) return false;
  }
  if (write.length <= read.length) return true;
  return read[read.length - 1] === UNREAD_KEY;
}

/** The builtins whose `prototype` the slice's own values are instances of. */
const PROTOTYPED_GLOBALS: readonly string[] = [...HOST_NAMES];

/**
 * How the slice reads the names it takes for globals: for each, the property
 * paths it reads under the name - a call at the end of a path is the path
 * as spelled, a value taken from it is the path with `*` after, since what
 * is done with the value is not in view; and, for every member expression in
 * the slice whatever its receiver, the member's name (`*` when computed), the
 * prototype channel's side of the comparison.
 */
function hostReads(
  statements: readonly t.Statement[],
  names: ReadonlySet<string>,
): { byName: Map<string, string[][]>; members: Set<string> } {
  const byName = new Map<string, string[][]>();
  const members = new Set<string>();
  const read = (name: string, keys: string[]): void => {
    let list = byName.get(name);
    if (!list) {
      list = [];
      byName.set(name, list);
    }
    list.push(keys);
  };

  const stack: { node: t.Node; parent: t.Node | undefined }[] = statements.map((node) => ({ node, parent: undefined }));
  const push = (node: unknown, parent: t.Node): void => {
    if (node && typeof (node as t.Node).type === 'string') stack.push({ node: node as t.Node, parent });
  };
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    const called =
      !!parent &&
      (t.isCallExpression(parent) || t.isNewExpression(parent) || t.isOptionalCallExpression(parent)) &&
      parent.callee === node;
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      // A computed member that is called is a method the slice cannot name,
      // and any prototype write may be to it; one merely read is an index.
      const member = propertyKey(node);
      members.add(member === '*' && called ? CALLED_UNREAD : member);
      const spine = memberSpine(node);
      if (spine && t.isIdentifier(stripTypeWrappers(rootOf(node))) && names.has(spine.root)) {
        read(spine.root, called ? spine.keys : [...spine.keys, '*']);
        // The chain is read; only the computed keys in it are left to walk.
        for (let current: t.Node = node; ; ) {
          current = stripTypeWrappers(current);
          if (!t.isMemberExpression(current) && !t.isOptionalMemberExpression(current)) break;
          if (current.computed) push(current.property, current);
          current = current.object;
        }
        continue;
      }
    } else if (t.isIdentifier(node) && names.has(node.name)) {
      read(node.name, called ? [] : ['*']);
      continue;
    }
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      // A name in key position is a property, not a reference: `o.String`,
      // `{ String: 1 }`, `String:` before a loop.
      if (key === 'label' || ((key === 'key' || key === 'property') && !(node as { computed?: boolean }).computed)) {
        continue;
      }
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) for (const item of child) push(item, node);
      else push(child, node);
    }
  }
  return { byName, members };
}

/** The expression a member chain starts from. */
function rootOf(member: t.MemberExpression | t.OptionalMemberExpression): t.Node {
  let current: t.Node = member;
  for (;;) {
    current = stripTypeWrappers(current);
    if (!t.isMemberExpression(current) && !t.isOptionalMemberExpression(current)) return current;
    current = current.object;
  }
}

/**
 * The first of `outside` that code compiled from a string could spell, and
 * the unreadable source to blame when that is why.
 *
 * `analysis/string-code.ts`'s global arm - a `Function(src)`, an indirect
 * `eval`, a timer with a string - is the one that applies to a builtin,
 * which is a property of the global object whatever scope the decoder sits
 * in, and `spells` is that arm asked on its own: what the sources say, and
 * nothing about the tree around them. The binding question would have
 * answered "any global-scope construct at all" for a module and for a
 * script with a direct `eval` beside the construct, and a webpack
 * `Function('return this')()` shim in an ESM bundle refused every decoder
 * that reads `String` for it. A direct `eval` on its own is not asked
 * about, on the same footing `strings.inline` gives the table: its reach is
 * the scope chain it sits in, and what it compiles is the program's own
 * concealment under every mainstream obfuscator.
 */
function stringCodeReach(
  outside: readonly string[],
  program: NodePath<t.Program>,
  options: BuildDecoderOptions,
): { name: string; blame: string | undefined } | undefined {
  if (outside.length === 0) return undefined;
  const facts = options.stringCode ?? stringCodeOf(program, options.scans);
  if (!facts.global) return undefined;
  for (const name of outside) {
    if (name === 'arguments') continue;
    if (facts.spells(name)) return { name, blame: facts.unreadGlobalSource };
  }
  return undefined;
}

const stringCodeByRound = new WeakMap<StatementScanCache, StringCodeFacts>();

/**
 * The program's string-code facts, against a one-shot context the way
 * `naming/index.ts` builds one: the shared analysis memoises on a
 * `PassContext` this entry point does not have, and the round's scan cache
 * stands in for its iteration. `program.parent` is the `File` on every path
 * the pipeline hands over; the wrapper is for a `Program` built some other
 * way, and refusing it would be answering "no string code" about a tree
 * nobody looked at.
 */
function stringCodeOf(program: NodePath<t.Program>, scans: StatementScanCache | undefined): StringCodeFacts {
  return perRound(scans, stringCodeByRound, () => {
    const file = t.isFile(program.parent) ? program.parent : t.file(program.node);
    const context: Pick<PassContext, 'ast' | 'shared' | 'iteration'> = {
      ast: file,
      shared: new Map(),
      iteration: 0,
    };
    return stringCodeFacts(context as PassContext);
  });
}

/**
 * A use of the decoder its samples hold nothing of: the first reference to a
 * root or alias from outside the slice's own sources, described for the
 * refusal. The sources are the units of the owning scope, so a reference
 * inside one - the decoder reading its own table, a rotation IIFE the slicer
 * took - is machinery, and everything else is a call site or a hand-off the
 * sample walk could not read.
 */
function unreadUse(slice: SliceResult, names: readonly string[]): string | undefined {
  const anchor = slice.sources[0];
  if (!anchor) return undefined;
  const scope = anchor.isScope() ? anchor.scope.parent : anchor.scope;
  const machinery = new Set(slice.sources.map((source) => source.node));
  for (const name of names) {
    const binding = scope.getBinding(name);
    if (!binding) continue;
    for (const reference of binding.referencePaths) {
      if (reference.removed || reference.findParent((parent) => machinery.has(parent.node))) continue;
      const parent = reference.parentPath;
      const line = reference.node.loc?.start.line;
      const where = line === undefined ? '' : ` at line ${line}`;
      if (parent?.isCallExpression() && parent.node.callee === reference.node) return `called${where}`;
      if (parent?.isMemberExpression() && parent.node.object === reference.node) {
        return `read through a member${where}`;
      }
      return `referenced as a value${where}`;
    }
  }
  return undefined;
}

function describeBinding(binding: Binding): string {
  const declaration = binding.path;
  if (binding.kind === 'param') return 'a parameter';
  if (declaration.isCatchClause()) return 'a `catch` binding';
  if (declaration.isClassDeclaration()) return 'a class';
  if (declaration.isFunctionDeclaration()) return 'a function declaration';
  if (binding.kind === 'local') return "a function expression's own name";
  if (binding.kind === 'module') return 'an import';
  return `a \`${binding.kind}\` binding`;
}

/**
 * The top-level `var x = y;` and `x = y;` links of a program, read once, from
 * which any decoder's forwarders - the names call sites use interchangeably
 * with it - are a closure over a few entries.
 *
 * One per discovery round, shared by every candidate in it the way `scans`
 * is: the body is the same body for all of them and the links are a few
 * hundred lines of it at most. Reading it per candidate through
 * `program.get('body')` was 11.6 s of `buildDecoder`'s 14.6 s on 2,048
 * concatenated modules, and `strings.discover` went from 17.6 s to 3.3 s
 * without it - Babel mints a `NodePath` for every statement on every `get`,
 * and the fixed-point loop below asked for the body at least twice per
 * candidate. The index costs 4 ms to build and 6 ms across every `of`.
 */
export class AliasIndex {
  /** `[from, to]` for each `var to = from;` / `to = from;`, in program order. */
  private readonly links: readonly (readonly [string, string])[];

  constructor(program: t.Program) {
    const links: [string, string][] = [];
    for (const node of program.body) {
      if (t.isVariableDeclaration(node)) {
        for (const declarator of node.declarations) {
          if (t.isIdentifier(declarator.id) && t.isIdentifier(declarator.init)) {
            links.push([declarator.init.name, declarator.id.name]);
          }
        }
      } else if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
        const { left, right, operator } = node.expression;
        if (operator === '=' && t.isIdentifier(left) && t.isIdentifier(right)) {
          links.push([right.name, left.name]);
        }
      }
    }
    this.links = links;
  }

  /** Names that forward to any of `roots`, transitively; the roots themselves are not in it. */
  of(roots: readonly string[]): Set<string> {
    const aliases = new Set<string>();
    const known = new Set(roots);

    // Iterate to a fixed point: aliases of aliases are common in bundled output.
    let grew = true;
    while (grew) {
      grew = false;
      for (const [from, to] of this.links) {
        if (!known.has(from) || known.has(to)) continue;
        known.add(to);
        aliases.add(to);
        grew = true;
      }
    }
    return aliases;
  }
}

/**
 * Real call sites, used to validate and cross-check. Both reference shapes are
 * collected - `_0x123b(0x2bd3, '@m8w')` and `_0xdb56[0x1f]` - because the tier
 * that wins decides which one the source actually uses.
 *
 * Calls that reach the decoder *through a wrapper* count too, and on a build with
 * `stringArrayWrappersType: 'function'` they are the only calls there are: every
 * literal-argument call site names a four-parameter forwarder, never the decoder.
 * Without following those, such a file yields zero samples and the decoder gets
 * adopted with nothing proven about it - which is precisely the situation the
 * validation step exists to prevent.
 */
function collectSamples(
  program: NodePath<t.Program>,
  names: readonly string[],
  limit: number,
): ArgumentTuple[] {
  if (limit <= 0) return [];
  const lookup = new Set(names);
  const samples: ArgumentTuple[] = [];
  const seen = new Set<string>();

  const push = (tuple: ArgumentTuple): void => {
    const key = cacheKey(tuple);
    if (seen.has(key)) return;
    seen.add(key);
    samples.push(tuple);
  };

  const forwarders = collectArgumentForwarders([program.node]);

  program.traverse({
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const tuple = literalArguments(path.node.arguments);
      if (!tuple) return;

      if (lookup.has(callee.name)) {
        push(tuple);
      } else {
        const forwarder = forwarders.get(callee.name);
        // Resolution is by name, so the binding is checked to be *this* function
        // before it is trusted: a local of the same name in another scope would
        // otherwise contribute arguments the decoder never receives.
        if (forwarder && denotes(path, callee.name, forwarder)) {
          const resolved = resolveForwardedCall(callee.name, tuple, forwarders, (name) =>
            lookup.has(name),
          );
          // A wrapper often computes an argument the decoder ignores, and that
          // one can legitimately be NaN. An index that is NaN is different: it
          // cannot decode to anything, so it is not evidence either way and
          // counting it would only make a sound decoder look unreliable.
          if (resolved && Number.isFinite(Number(resolved.args[0]))) push(resolved.args);
        }
      }

      if (samples.length >= limit) path.stop();
    },
    MemberExpression(path) {
      const { object, property, computed } = path.node;
      if (!computed || !t.isIdentifier(object) || !lookup.has(object.name)) return;
      const index = literalValue(property);
      if (typeof index === 'number') push([index]);
      if (samples.length >= limit) path.stop();
    },
  });

  return samples;
}

/** Whether `name`, as seen from `path`, really binds to this forwarder. */
function denotes(path: NodePath, name: string, forwarder: ArgumentForwarder): boolean {
  const binding = path.scope.getBinding(name);
  if (!binding) return false;
  const declaration = binding.path.node;
  if (declaration === forwarder.fn) return true;
  return t.isVariableDeclarator(declaration) && declaration.init === forwarder.fn;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The refusal for a name changed outside the slice, worded by what the change
 * is: a rotation moves the table, an assignment replaces a value, a member
 * write alters one in place, and an `order` mutator ran too early. A kind the
 * slicer did not report gets the wording that is true of all four.
 */
function describeMutation(name: string, kind: UnmodelledMutationKind | undefined): string {
  switch (kind) {
    case 'shuffle':
      return (
        `a push(shift()) rotation the slice cannot include names ${name}, which this decoder ` +
        `depends on; if that is its table, every decoded string would be taken from the wrong position.`
      );
    case 'assignment':
      return (
        `an assignment the slice cannot include names ${name}, which this decoder depends on; ` +
        `every decoded string would be computed from a value the program has replaced.`
      );
    case 'member':
      return (
        `a write through a member, a delete or a method call the slice cannot include names ${name}, ` +
        `which this decoder depends on; every decoded string would be computed from a value the ` +
        `program has changed in place.`
      );
    case 'order':
      return (
        `a mutator the slice runs first names ${name}, which a use of this decoder outside the slice ` +
        `reads before that mutator runs; that use would be decoded with a value it never sees.`
      );
    default:
      return (
        `code outside the slice names ${name}, which this decoder depends on, and changes it in a way ` +
        `the slice does not reproduce; every decoded string could be computed from a value the ` +
        `program never has.`
      );
  }
}
