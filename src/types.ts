/**
 * Public type surface for the jsrift deobfuscation engine.
 *
 * Everything a consumer of the library can observe is declared here: the input
 * options, the preset/override system, and the shape of the result including
 * its metadata.
 */

// ---------------------------------------------------------------------------
// Languages & parsing
// ---------------------------------------------------------------------------

/**
 * Input dialects. `auto` runs the detection ladder in `frontend/language.ts`,
 * which is the right default for pasted code with no filename.
 *
 * `auto` refuses one shape rather than guess at it: a file that is valid as
 * both JavaScript and TypeScript with different meanings, which is what a
 * type argument on a call does - `f<T>(x)` is `(f < T) > (x)` to JavaScript.
 * That is thrown as `AmbiguousDialectError`, naming the site, and the caller
 * pins the dialect. A pinned dialect is never second-guessed.
 */
export type Language = 'auto' | 'js' | 'jsx' | 'ts' | 'tsx';

export type SourceType = 'script' | 'module' | 'unambiguous';

// ---------------------------------------------------------------------------
// Techniques
// ---------------------------------------------------------------------------

/**
 * The user-facing technique toggles.
 *
 * Each maps to one or more internal passes (see `passes/registry.ts`); a
 * technique is the unit users think in, a pass is the unit the engine runs.
 */
export interface TechniqueFlags {
  /** Decode string arrays, wrapper functions and encoded literals back to plain strings. */
  stringDecoding: boolean;
  /** Rename `_0x4d28ce` to an inferred, human-meaningful, scope-safe name. */
  variableRenaming: boolean;
  /** Recover `while(true){switch(state)}` state machines into straight-line code. */
  controlFlowAnalysis: boolean;
  /** Delete unreachable branches, unused bindings and injected filler code. */
  deadCodeRemoval: boolean;
  /** Inline proxy/wrapper functions and object-alias maps back to their targets. */
  functionUnwrapping: boolean;

  /** Fold constant expressions: `0x1*0x2+0x3`, `'a'+'b'`, `!![]`, `void 0`. */
  literalSimplification: boolean;
  /** Normalize `obj["prop"]` to `obj.prop` when the key is a valid identifier. */
  propertyNormalization: boolean;
  /** Strip `debugger` traps, self-defending guards and console suppression. */
  antiTamperRemoval: boolean;
  /** Restore idiomatic control flow: comma sequences, nested ternaries, `&&` guards. */
  statementRecovery: boolean;
  /** Unwrap webpack/Next.js chunk module maps into named module scopes. */
  moduleUnwrapping: boolean;
  /** Turn `_jsx(Component, {...})` runtime calls back into readable JSX. */
  jsxRestoration: boolean;
}

export type TechniqueId = keyof TechniqueFlags;

/**
 * A technique override is either a plain on/off switch or an object that turns
 * the technique on and tunes it. `false` always wins over the preset.
 */
export type TechniqueOverride<TOptions = unknown> = boolean | ({ enabled?: boolean } & TOptions);

export interface StringDecodingOptions {
  /** Cap on decoder invocations; guards against a pathological or hostile input. */
  maxDecodeCalls?: number;
  /**
   * Decode a string table that code compiled at run time could be reading.
   * Its machinery stays in the output either way.
   *
   * `eval(src)`, `Function(src)` and `setTimeout('src')` turn a string into code
   * while the program runs. A direct `eval` sees every binding visible where it
   * is written; the others compile in global scope, which in a script still sees
   * every name the program declares at top level - the string table, the decoder
   * that reads it, and every alias of both. A string the engine can read is
   * checked for those names; a string it cannot read - `Function(name)`, where
   * the argument is a variable - could spell any of them. Either way two things
   * follow: the compiled code may READ the machinery, so a declaration such a
   * string can name is never deleted, at any preset - deleting it would make
   * the compiled code throw where the input ran; and it may WRITE the table
   * before a value this engine already inlined is used, in which case the
   * literal left behind is what the table held rather than what the program
   * would have seen.
   *
   * Off, that second possibility is a refusal: those references stay encoded,
   * and a diagnostic names what stopped it. On, they are decoded anyway, the
   * table and decoder stay beside the literals, and a different diagnostic
   * says the trade was taken and that the deletion is not part of it.
   *
   * Which way this goes is a preset decision rather than a bug - `aggressive`
   * accepts the risk, `conservative` and `balanced` do not; the reasoning is the
   * paragraph above `PRESET_TECHNIQUES` in `config/presets.ts`. What is risked
   * is behavioural drift in output whose consumer is a human reader; what is
   * bought is a file whose call sites read as the strings they resolve to,
   * even though the table they came from is still in it.
   *
   * It only ever applies where such a construct exists AND can name the
   * machinery: `Function('return this')` spells nothing, reaches nothing, and is
   * unaffected either way.
   */
  decodeDespiteStringCode?: boolean;
  /**
   * Evaluation tiers to attempt, in order. `native` re-implements known
   * algorithms with no code execution at all and is the only tier that is safe
   * against hostile input by construction.
   */
  tiers?: EvaluatorTier[];
}

export interface VariableRenamingOptions {
  /** Minimum confidence (0..1) an inferred name needs before it is applied. */
  minConfidence?: number;
  /** Rename bindings that are already readable (default: leave them alone). */
  renameReadable?: boolean;
  /** Also rename function parameters. */
  renameParameters?: boolean;
  /** Rename object property keys. Off by default: unsound when keys are computed. */
  renameProperties?: boolean;
  /** Extra `pattern -> name` hints supplied by the caller. */
  hints?: Record<string, string>;
}

export interface ControlFlowOptions {
  /** Refuse to unflatten a dispatcher with more states than this. */
  maxStates?: number;
  /** Also relink dispatchers whose order array is computed rather than literal. */
  aggressiveDispatchers?: boolean;
  /**
   * Recover sum-of-registers VM dispatchers whose entry vector folds to
   * constants.
   *
   * Off in every preset, `aggressive` included, and opt-in by name only.
   *
   * The three soundness gaps behind that decision - a register written through
   * `delete`, a destructuring target or a for-in/of head, all read as no write
   * at all; a direct `eval` before the loop, which moves the entry vector where
   * nothing was looking; and an Annex B block-level declaration, whose binding
   * is not an enumeration of its call sites - are closed and pinned by tests,
   * and the bulk equivalence evidence is committed:
   * `test/register-vm-equivalence.test.ts` lifts 37 of the 38 machines
   * `structure.register-vm` recovers in obfuscated4.js - the 38th leaves
   * through an opaque statement it cannot instrument - and executes each one
   * before and after linearisation under `node:vm`, over all 72 assignments of
   * their undecidable guards, comparing 761 statement observations and the
   * returned value. Run `npx vitest run test/register-vm-equivalence.test.ts`
   * to reproduce those numbers.
   *
   * It stays off all the same, and the reason is scope rather than a missing
   * measurement: 37 machines out of one file is evidence about *this*
   * obfuscator's register VM. What it does not cover is a machine shaped
   * differently enough to reach a gate none of these 37 reach, and turning a
   * whole-program rewrite on by default wants more than one file behind it.
   *
   * Recognition and reporting are not gated by this flag.
   */
  registerVm?: boolean;
  /** Ceiling on distinct VM states explored per dispatcher before abandoning it. */
  maxRegisterVmStates?: number;
}

export interface DeadCodeOptions {
  /** Remove bindings that are declared but never read. */
  removeUnusedBindings?: boolean;
  /** Remove functions that are never referenced. */
  removeUnusedFunctions?: boolean;
  /** Drop `if` branches whose test folds to a constant. */
  removeConstantBranches?: boolean;
  /** Preserve any statement carrying a leading comment (default true). */
  keepCommented?: boolean;
}

export interface FunctionUnwrappingOptions {
  /** Maximum node size of a function body still considered inlinable. */
  maxInlineSize?: number;
  /** Inline single-use functions even when their body is large. */
  inlineSingleUse?: boolean;
  /**
   * Refuse to unwrap an argument-discarding wrapper whose binding is visible to
   * a direct `eval`.
   *
   * On in `conservative`, off in `balanced` and `aggressive`, and the cost of
   * turning it on is the reason for the split rather than any doubt about what
   * it catches. What it catches is real and is worth stating exactly, because
   * two of the three presets take the risk:
   *
   * ```js
   * function w() {}
   * function host() { eval("w = function (a) { log('reassigned:' + a); }"); }
   * host();
   * w(log('arg'));
   * ```
   *
   * `eval` reassigning `w` is invisible to `constantViolations`, so the pass
   * reads the wrapper as never reassigned and rewrites the last line to
   * `log('arg')`. The input prints `arg` then `reassigned:1`; the output prints
   * `arg`. Where the flag is off, the run reports how many such wrappers it
   * unwrapped as a warning in `metadata.diagnostics`, naming this option - the
   * assumption being made is that no mainstream obfuscator's string code
   * rewrites a proxy wrapper, and the file in hand is the one place that can
   * be false.
   *
   * On, that whole binding is refused. The guard is `facts.reaches`, which is
   * true for every scope from an `eval` call site up to the program, so ONE
   * direct `eval` anywhere at top level refuses every program-scope wrapper in
   * the file - and an obfuscated file usually has one. Measured on
   * `obfuscated4.js`: `simplify.discard-wrappers` goes from 13,906 rewrites to
   * 0 at `balanced`, and at `aggressive` the register VMs those rewrites expose
   * go from 67 recognised to none, which is the whole of what
   * `test/register-vm-equivalence.test.ts` measures. That is why it is off
   * outside `conservative`: the refusal is not narrow, it is the pass - and
   * `conservative` is the preset that promised identical output, so there it
   * pays that price.
   *
   * It is also not a whole answer to direct `eval`: `simplify.proxy-functions`
   * next door does not look for one at all, so this guard is one pass wide. The
   * narrower rule - refuse a call site sitting where an `eval` could have
   * invented its callee - is always enforced and is not gated by this flag.
   */
  refuseOnDirectEval?: boolean;
}

/**
 * Per-technique overrides layered on top of a preset. Omitted keys inherit the
 * preset's value, so `{ preset: 'aggressive', techniques: { deadCodeRemoval: false } }`
 * means "everything aggressive does, minus dead-code removal".
 */
export interface TechniqueOverrides {
  stringDecoding?: TechniqueOverride<StringDecodingOptions>;
  variableRenaming?: TechniqueOverride<VariableRenamingOptions>;
  controlFlowAnalysis?: TechniqueOverride<ControlFlowOptions>;
  deadCodeRemoval?: TechniqueOverride<DeadCodeOptions>;
  functionUnwrapping?: TechniqueOverride<FunctionUnwrappingOptions>;
  literalSimplification?: TechniqueOverride;
  propertyNormalization?: TechniqueOverride;
  antiTamperRemoval?: TechniqueOverride;
  statementRecovery?: TechniqueOverride;
  moduleUnwrapping?: TechniqueOverride;
  jsxRestoration?: TechniqueOverride;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * `conservative` only performs transformations that are provably meaning-preserving.
 * `balanced` adds high-confidence heuristics (the sane default).
 * `aggressive` prioritises readability and will restructure code that it cannot
 *   prove equivalent, which is the right trade-off when a human is going to read
 *   the result rather than run it.
 */
export type PresetName = 'conservative' | 'balanced' | 'aggressive';

// ---------------------------------------------------------------------------
// Evaluation sandbox
// ---------------------------------------------------------------------------

/**
 * How a discovered decoder function is turned into plaintext.
 *
 * - `native`      pattern-match a known algorithm (base64 / RC4 / index shift)
 *                 and run the engine's own implementation. No untrusted code
 *                 executes.
 * - `interpreter` walk the decoder's AST with a tiny interpreter restricted to a
 *                 whitelisted subset. Still no host code execution.
 * - `sandbox`     execute an AST-extracted slice - never the whole file, only
 *                 what the decoder needs - by compiling it with `new Function`
 *                 in the CALLING realm, with the host globals in
 *                 `analysis/evaluator/sandbox.ts` shadowed by parameters bound
 *                 to `undefined`.
 *
 * There is no isolated realm: no `node:vm`, no worker, no iframe. Shadowing is
 * a mitigation and not a boundary, and it is defeated in one expression, because
 * `constructor.constructor` on any object literal the slice can build reaches
 * the real `Function` and through it the real global object. Executed code
 * therefore has whatever the host process has - in Node that includes
 * `process`, the filesystem and the network. That is why the tier is off unless
 * {@link SandboxOptions.allowExecution} is set, is in no preset's `tiers`, and
 * should not be pointed at input you do not trust.
 */
export type EvaluatorTier = 'native' | 'interpreter' | 'sandbox';

export interface SandboxOptions {
  /**
   * Wall-clock cap for a single decoder evaluation.
   *
   * Both caps must be finite: `NaN` or `Infinity` compares false against every
   * bound, which is no bound at all, so either is a `TypeError` rather than a
   * repaired value.
   */
  timeoutMs?: number;
  /** Hard cap on the number of AST nodes the interpreter will step through. */
  maxSteps?: number;
  /**
   * Allow the `sandbox` tier at all; `false` by default, and no preset lists
   * the tier. Setting it runs code from the input in this realm - see
   * {@link EvaluatorTier} for what that does and does not contain.
   */
  allowExecution?: boolean;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface OutputOptions {
  /**
   * Pretty-print the result (default true). `false` prints compact output -
   * whitespace only where the grammar needs it - and `indent` does not apply.
   */
  format?: boolean;
  /** Spaces per indentation level, 0 to 16 (default 2). */
  indent?: number;
  /**
   * Preserve comments from the input (default true). A `sourceMappingURL` or
   * `sourceURL` directive is never preserved: it described the input, and the
   * engine emits its own map or none.
   */
  comments?: boolean;
  /** `true` emits `result.map`; `'inline'` appends a data-URI comment to the code. */
  sourceMaps?: boolean | 'inline';
  /** Prepend a comment summarising what the engine did; a source map is shifted past it. */
  banner?: boolean;
  /**
   * Quote character for string literals. `'single'` or `'double'` re-quotes
   * every literal in the output, the ones copied from the input included;
   * only the delimiters change, because the escapes inside are
   * `literalSimplification`'s business. `'preserve'` (the default) keeps
   * each input literal as it was written and uses single quotes for the
   * literals the engine creates - decoded strings, folded constants. JSX
   * attribute values are not JavaScript string literals and keep their
   * quotes under every setting.
   */
  quotes?: 'single' | 'double' | 'preserve';
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export interface PerformanceOptions {
  /**
   * Ceiling on fixpoint rounds.
   *
   * The loop runs while a round changes something and stops on the first
   * quiet one, so this is a cap rather than a count: the default (40) is
   * above anything a real file needs, and a run it does cut short reports a
   * warning and sets `stats.truncated`. It bounds the loop and nothing else:
   * `prepare` and `unpack` run before it, `rename` and `finalize` after it,
   * and a quiet round re-runs `unpack` from inside it over the moved tree to
   * open the wrappers a decoded table spelled - so `0` is a run without the
   * loop rather than a run that changes nothing.
   */
  maxIterations?: number;
  /**
   * Abort and return best-effort output after this many milliseconds.
   *
   * The only bound that always applies. It is checked between passes and inside
   * the loops of the passes that carry one, so a run that crosses it stops at
   * the next check and reports `stats.truncated`.
   */
  timeBudgetMs?: number;
  /** Cache decoder results keyed by their arguments (default true). */
  memoize?: boolean;
  /**
   * Re-parse the generated output to prove it is still valid JavaScript.
   *
   * The result is `stats.verification`, with `stats.verified` as its boolean
   * reading, and a failure is a diagnostic naming what is known about the
   * cause. Nothing narrows it further: there is no re-run with passes
   * disabled, so no pass is named. Off, `stats.verification` is `'skipped'`
   * and `stats.verified` is false without a diagnostic.
   */
  verifyOutput?: boolean;

  /*
   * There is deliberately no worker or batch-size option here.
   *
   * A syntax tree is a shared mutable graph and does not shard, so the engine
   * is single-threaded wherever it is called and has nothing to configure. The
   * parallelism that is worth having is getting the whole run off the calling
   * thread, which is `WorkerClient` and the `jsrift/worker` entry point - the
   * caller's decision, not a knob inside a run.
   */
}

// ---------------------------------------------------------------------------
// Entry point options
// ---------------------------------------------------------------------------

/**
 * Every field is checked at run time against the type declared here, because
 * a JavaScript caller has no compiler doing it: a value outside its type -
 * `techniques: { variableRenaming: 'no' }`, `tiers: 'native'`, an unknown
 * key - is a `TypeError` naming the field, not a silently different run. A
 * value of the right type but outside its range (`indent: 99`,
 * `maxIterations: 1.5`, a pass id that names nothing) is repaired and the
 * repair recorded in `metadata.diagnostics`.
 */
export interface DeobfuscateOptions {
  preset?: PresetName;
  techniques?: TechniqueOverrides;
  language?: Language;
  sourceType?: SourceType;
  /** Used for language detection and as the source-map `sources` entry. */
  filename?: string;
  output?: OutputOptions;
  performance?: PerformanceOptions;
  sandbox?: SandboxOptions;
  /** Explicit `pass.id` list to skip, escape hatch below the technique level. */
  disablePasses?: string[];
  onProgress?: (progress: Progress) => void;
  /**
   * Cancel the run. Already-aborted returns immediately; an abort raised while
   * the run is in flight is observed at the next stage boundary.
   *
   * That granularity is the whole of what it can be. A stage is one traversal
   * of the tree and cannot be interrupted from outside, so on a large file the
   * gap between `abort()` and the return is a stage - seconds, not
   * milliseconds. The engine gives the host one turn between stages, with or
   * without a signal, which is what lets a timer-driven `abort()` run at all;
   * inside a stage nothing on the host's queue gets a turn.
   *
   * A cancelled run still resolves, with best-effort output and
   * `stats.truncated` set - it does not reject. To stop the work outright, run
   * the engine on a worker and terminate it; `performance.timeBudgetMs` is the
   * bound that needs no host cooperation at all.
   */
  signal?: AbortSignal;
}

export interface Progress {
  stage: string;
  /**
   * 0..1 over the whole run, and never less than the previous report: the
   * fixpoint loop revisits its stages, so the value folds the round in
   * rather than restarting with it.
   */
  completed: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Results & metadata
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  severity: Severity;
  /** The pass that raised it, or `'frontend'` / `'pipeline'`. */
  source: string;
  message: string;
  loc?: { line: number; column: number };
}

/** One obfuscation technique recognised in the input. */
export interface Detection {
  kind: DetectionKind;
  confidence: number;
  /** Human-readable evidence, e.g. the identifier or shape that matched. */
  evidence: string;
  count?: number;
}

export type DetectionKind =
  | 'string-array'
  | 'string-array-rotate'
  | 'string-array-wrapper'
  | 'string-encoding-base64'
  | 'string-encoding-rc4'
  | 'control-flow-flattening'
  | 'dead-code-injection'
  | 'debug-protection'
  | 'self-defending'
  | 'console-disable'
  | 'object-key-map'
  | 'proxy-functions'
  | 'numbers-to-expressions'
  | 'split-strings'
  | 'hex-identifiers'
  | 'unicode-escapes'
  | 'webpack-bundle'
  | 'jsx-runtime'
  | 'eval-packer';

export interface PassReport {
  id: string;
  technique: TechniqueId | 'core';
  /** Node mutations attributed to this pass. */
  changes: number;
  durationMs: number;
  /** Set when the pass threw and was isolated, or refused to run. */
  bailout?: string;
}

export interface RenameRecord {
  from: string;
  to: string;
  /** Why the engine chose this name, for auditability. */
  reason: string;
  confidence: number;
}

export interface DecodedStringRecord {
  /** The call or index expression as written in the source. */
  reference: string;
  value: string;
  uses: number;
}

/**
 * What the output re-parse said, or that it was not asked. `'too-deep'` is the
 * re-parse running out of stack on a deeply nested tree, which is a limit of
 * the process rather than a statement about the output; `'skipped'` is
 * `performance.verifyOutput` off.
 */
export type VerificationOutcome = 'ok' | 'invalid' | 'too-deep' | 'skipped';

export interface DeobfuscateMetadata {
  language: Exclude<Language, 'auto'>;
  sourceType: Exclude<SourceType, 'unambiguous'>;
  preset: PresetName;
  techniques: TechniqueFlags;
  detections: Detection[];
  passes: PassReport[];
  renames: RenameRecord[];
  strings: DecodedStringRecord[];
  diagnostics: Diagnostic[];
  stats: {
    /** UTF-8 bytes, not `String.length` - the two differ on any non-ASCII output. */
    inputBytes: number;
    outputBytes: number;
    inputLines: number;
    outputLines: number;
    astNodes: number;
    iterations: number;
    totalChanges: number;
    parseMs: number;
    transformMs: number;
    generateMs: number;
    totalMs: number;
    /**
     * True when the output was re-parsed successfully: `verification === 'ok'`.
     * Also false when the re-parse ran out of stack, and when it did not run
     * at all; `verification` says which.
     */
    verified: boolean;
    verification: VerificationOutcome;
    /**
     * True when the time budget, the abort signal or `maxIterations` cut the
     * run short of a settled tree.
     */
    truncated: boolean;
  };
}

export interface DeobfuscateResult {
  code: string;
  /** Present when `output.sourceMaps` is `true`. */
  map?: SourceMap;
  metadata: DeobfuscateMetadata;
}

export interface SourceMap {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  sourceRoot?: string;
}
