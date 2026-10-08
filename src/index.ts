import { parse as babelParse } from '@babel/parser';
import { resolveConfig, type ResolvedConfig } from './config/presets.js';
import { describeValue } from './config/validate.js';
import {
  parseSource,
  parserOptionsFor,
  type ConcreteLanguage,
  type DecoratorSyntax,
} from './frontend/language.js';
import { printAst } from './frontend/print.js';
import { PipelineContext } from './pipeline/context.js';
import { Kernel } from './pipeline/kernel.js';
import { ITERATIVE_STAGES, STAGE_ORDER, type Stage } from './pipeline/pass.js';
import { buildPassList } from './passes/registry.js';
import { countLines, countNodes, countUtf8Bytes } from './util/ast.js';
import type {
  DeobfuscateOptions,
  DeobfuscateResult,
  Progress,
  SourceType,
  VerificationOutcome,
} from './types.js';

export type {
  ControlFlowOptions,
  DeadCodeOptions,
  DecodedStringRecord,
  DeobfuscateMetadata,
  DeobfuscateOptions,
  DeobfuscateResult,
  Detection,
  DetectionKind,
  Diagnostic,
  EvaluatorTier,
  FunctionUnwrappingOptions,
  Language,
  OutputOptions,
  PassReport,
  PerformanceOptions,
  PresetName,
  Progress,
  RenameRecord,
  SandboxOptions,
  Severity,
  SourceMap,
  SourceType,
  StringDecodingOptions,
  TechniqueFlags,
  TechniqueId,
  TechniqueOverride,
  TechniqueOverrides,
  VariableRenamingOptions,
  VerificationOutcome,
} from './types.js';

export { PRESET_TECHNIQUES, resolveConfig } from './config/presets.js';
export type { ResolvedConfig } from './config/presets.js';
export type { AnalysisResult } from './analysis/analyze.js';
export { AmbiguousDialectError, ParseFailedError } from './frontend/language.js';
export { PrintFailedError } from './frontend/print.js';
export { STAGE_ORDER } from './pipeline/pass.js';
export type { Pass, Stage } from './pipeline/pass.js';
export { listPasses } from './passes/registry.js';
export { detectObfuscation } from './analysis/detect.js';
export { WorkerClient, workersAvailable } from './parallel/client.js';
export type { WorkerClientOptions, WorkerLike } from './parallel/client.js';
export { toTransferable } from './parallel/protocol.js';
export type { TransferableOptions, WorkerRequest, WorkerResponse } from './parallel/protocol.js';

/**
 * Deobfuscate a JavaScript, TypeScript or JSX/TSX source file.
 *
 * Everything runs in-process with no network and no server component, so the
 * same call works unchanged in Node and in a browser tab.
 *
 * ```ts
 * const { code, metadata } = await deobfuscate(source, {
 *   preset: 'aggressive',
 *   techniques: { deadCodeRemoval: false },
 * });
 * ```
 */
export async function deobfuscate(
  source: string,
  options: DeobfuscateOptions = {},
): Promise<DeobfuscateResult> {
  const startedAt = now();
  if (typeof source !== 'string') {
    throw new TypeError(
      `deobfuscate() expects the source as a string, received ${describeValue(source)}. ` +
        'Read the file with an encoding (fs.readFileSync(path, "utf8")) or call String() on it first.',
    );
  }
  // `resolveConfig` type-checks every option and accepts `null` as "no
  // options"; nothing below reads a field it has not vetted.
  const config = resolveConfig(options);
  options = options ?? {};
  const sanitizations = sanitizeConfig(config);
  const filename = options.filename ?? 'input.js';

  const progress = makeProgressReporter(options.onProgress);
  progress('parse', 0, 'Parsing source');

  const parseStart = now();
  const parsed = parseSource(source, {
    language: options.language,
    sourceType: options.sourceType,
    filename: options.filename,
  });
  const parseMs = now() - parseStart;

  // Must be epoch-based: PassContext compares against Date.now(), and
  // performance.now() is monotonic from process start, not from the epoch.
  const deadline = Date.now() + config.performance.timeBudgetMs;
  const ctx = new PipelineContext(
    parsed.ast,
    source,
    config,
    parsed.language,
    deadline,
    options.signal,
  );

  for (const message of sanitizations) ctx.note('warning', message);

  if (parsed.recovered) {
    ctx.note(
      'warning',
      `Input did not parse cleanly under any dialect; continued with error recovery. ${parsed.errors[0] ?? ''}`.trim(),
    );
  }

  const passes = buildPassList();
  const transformStart = now();
  const kernel = new Kernel(passes, ctx);
  const { reports, iterations, truncated } = await kernel.run((stage, iteration) => {
    // The kernel announces a stage before it checks the budget, and a stage
    // that starts past it does not run; a run cancelled before it began used
    // to report every stage of a pipeline that did nothing.
    if (ctx.isExhausted()) return;
    progress(
      stage,
      stageFraction(stage, iteration, config.performance.maxIterations),
      `${stage} (round ${iteration + 1})`,
    );
  });
  const transformMs = now() - transformStart;

  progress('generate', 0.92, 'Generating output');
  const generateStart = now();
  const printed = printAst(parsed.ast, source, config.output, {
    filename,
    language: parsed.language,
    sourceType: parsed.sourceType,
    decorators: parsed.decorators,
    banner: config.output.banner ? renderBanner(ctx, iterations) : undefined,
  });
  const generateMs = now() - generateStart;
  for (const warning of printed.warnings) ctx.note('warning', warning);

  const code = printed.code;
  let verification: VerificationOutcome = 'skipped';
  if (config.performance.verifyOutput) {
    // Only what is known. There is no bisection: the engine does not re-run with
    // halves of the pass list disabled, so it cannot name a pass - and asserting
    // that one produced an invalid tree was wrong outright whenever the cause
    // sat upstream of every pass. `deobfuscate(esm, { sourceType: 'script' })`
    // is the reproducible case: the strict re-parse rejects the import
    // declarations the recovered tree still holds, and no pass touched them.
    verification = verifyParse(code, parsed.language, parsed.sourceType, parsed.decorators);
    if (verification === 'too-deep') {
      ctx.note(
        'warning',
        'Generated output could not be verified: the re-parse ran out of stack on it. ' +
          'That is a limit of this process rather than a defect in the output.',
      );
    } else if (verification === 'invalid') {
      ctx.note(
        'error',
        `Generated output did not re-parse as ${parsed.language}/${parsed.sourceType}. ` +
          (parsed.recovered
            ? 'The input did not parse cleanly either, so the tree carried recovered errors ' +
              'into the output; check the language and sourceType before suspecting a pass.'
            : 'The input parsed cleanly, so a pass produced a tree that does not print as ' +
              'valid source. The engine does not narrow this further and no pass is named.'),
      );
    }
  }

  progress('done', 1, 'Complete');

  return {
    code,
    map: printed.map,
    metadata: {
      language: parsed.language,
      sourceType: parsed.sourceType,
      preset: config.preset,
      techniques: config.techniques,
      detections: ctx.detections.sort((a, b) => b.confidence - a.confidence),
      passes: reports,
      renames: ctx.renames,
      strings: [...ctx.decodedStrings.values()],
      diagnostics: ctx.diagnostics,
      stats: {
        inputBytes: countUtf8Bytes(source),
        outputBytes: countUtf8Bytes(code),
        inputLines: countLines(source),
        outputLines: countLines(code),
        astNodes: countNodes(parsed.ast),
        iterations,
        totalChanges: ctx.totalChanges,
        parseMs: round(parseMs),
        transformMs: round(transformMs),
        generateMs: round(generateMs),
        totalMs: round(now() - startedAt),
        verified: verification === 'ok',
        verification,
        truncated: truncated || options.signal?.aborted === true,
      },
    },
  };
}

/**
 * Fingerprint the input without transforming it. Cheap enough to run on every
 * keystroke in a UI; it parses once and inspects the tree.
 */
export { analyze } from './analysis/analyze.js';

/**
 * Verification must use a *strict* parse. `parseSource` deliberately falls back
 * to error recovery so that broken input still yields a workable tree - using it
 * here would report success for output that does not actually parse.
 *
 * `'too-deep'` is separated out because it is not an answer about the output at
 * all: the parser descends one frame per nesting level, so a long `+` chain
 * exhausts the stack on code that is perfectly valid. Reporting that as
 * "a pass produced an invalid tree" blames the engine for the host's limit.
 */
function verifyParse(
  code: string,
  language: ConcreteLanguage,
  sourceType: SourceType,
  decorators: DecoratorSyntax,
): 'ok' | 'invalid' | 'too-deep' {
  // The grammar the input was read under first; the other decorator grammar
  // second, because the generator may print a decorator in a placement only
  // that one accepts.
  let outcome: 'invalid' | 'too-deep' = 'invalid';
  for (const syntax of [decorators, decorators === 'proposal' ? 'legacy' : 'proposal'] as const) {
    try {
      babelParse(code, parserOptionsFor(language, sourceType, { errorRecovery: false }, syntax));
      return 'ok';
    } catch (error) {
      if (error instanceof RangeError) outcome = 'too-deep';
    }
  }
  return outcome;
}

/** Widest indent the printer will honour; beyond this it is a typo, not a style. */
const MAX_INDENT = 16;

/** Fixpoint rounds an ordinary file takes, for the progress estimate. */
const TYPICAL_ROUNDS = 4;

/** Resolved once so a repair can fall back to the same value the preset would have used. */
const DEFAULT_PERFORMANCE = resolveConfig({}).performance;

/**
 * Repair option values that are of the right type but outside the range the
 * engine can act on.
 *
 * Wrong *types* are rejected earlier, by `resolveConfig`, as a `TypeError`.
 * What is left here is a number the engine cannot honour as written - `NaN`,
 * a negative count, a fraction - or an id that names nothing. Each repair is
 * returned as a warning so it lands in `metadata.diagnostics` rather than
 * happening invisibly.
 */
function sanitizeConfig(config: ResolvedConfig): string[] {
  const warnings: string[] = [];

  // `frontend/print.ts` builds the indent unit with `' '.repeat(n)`, which throws
  // RangeError for a negative or absurd count.
  const indent = config.output.indent;
  if (!Number.isInteger(indent) || indent < 0 || indent > MAX_INDENT) {
    const repaired = Number.isFinite(indent)
      ? Math.min(Math.max(Math.trunc(indent), 0), MAX_INDENT)
      : 2;
    warnings.push(
      `output.indent must be a whole number between 0 and ${MAX_INDENT}; received ${describeValue(indent)}, using ${repaired}.`,
    );
    config.output.indent = repaired;
  }

  // NaN compares false against every bound, so the fixpoint loop exits before
  // running a single pass and the caller gets untouched code marked verified.
  const iterations = config.performance.maxIterations;
  if (Number.isNaN(iterations)) {
    warnings.push(
      `performance.maxIterations must be a number; received ${describeValue(iterations)}, using the default.`,
    );
    config.performance.maxIterations = DEFAULT_PERFORMANCE.maxIterations;
  } else if (iterations < 0) {
    // Not "nothing will run": `Kernel.run` executes the prologue and epilogue
    // stages outside the capped loop, and on a 437 KB file that is still 1,080
    // changes and a third off the size. Saying otherwise invites a caller to
    // trust the result as an untouched baseline.
    warnings.push(
      `performance.maxIterations cannot be negative; received ${iterations}, using 0 ` +
        '(the fixpoint loop will not run; the prepare, unpack, rename and finalize stages still do).',
    );
    config.performance.maxIterations = 0;
  } else if (Number.isFinite(iterations) && !Number.isInteger(iterations)) {
    // `i < 1.5` runs two rounds; a cap is a whole number of them.
    const repaired = Math.trunc(iterations);
    warnings.push(
      `performance.maxIterations must be a whole number; received ${iterations}, using ${repaired}.`,
    );
    config.performance.maxIterations = repaired;
  }

  const budget = config.performance.timeBudgetMs;
  if (Number.isNaN(budget)) {
    warnings.push(
      `performance.timeBudgetMs must be a number; received ${describeValue(budget)}, using the default.`,
    );
    config.performance.timeBudgetMs = DEFAULT_PERFORMANCE.timeBudgetMs;
  }

  // An id that names no pass disables nothing, and the typo that produced it
  // is invisible in a result that still says `verified`.
  if (config.disabledPasses.size > 0) {
    const known = new Set(buildPassList().map((pass) => pass.id));
    for (const id of config.disabledPasses) {
      if (!known.has(id)) {
        warnings.push(
          `disablePasses: no pass is registered as ${JSON.stringify(id)}, so it disables nothing; ` +
            'listPasses() names every id.',
        );
      }
    }
  }

  return warnings;
}

/**
 * Where a stage sits in the whole run, as a fraction of it.
 *
 * The kernel runs the stages before the first iterative one once, the
 * iterative span up to `maxIterations` times, and the stages after it once.
 * Folding the round into the position is what keeps the fraction from falling
 * back to the top of the loop on every round; when the loop exits early the
 * fraction jumps forward to the epilogue, which is the truth of it.
 */
function stageFraction(stage: Stage, iteration: number, maxIterations: number): number {
  const index = STAGE_ORDER.indexOf(stage);
  const first = STAGE_ORDER.findIndex((s) => ITERATIVE_STAGES.has(s));
  const last = STAGE_ORDER.reduce((acc, s, i) => (ITERATIVE_STAGES.has(s) ? i : acc), -1);
  const span = last - first + 1;
  // The cap is a ceiling most runs never approach, so the share is divided by
  // the rounds a file usually takes, growing with the round in hand once that
  // is exceeded; the reporter's clamp keeps the estimate from moving backwards.
  const rounds = Math.max(1, Math.min(maxIterations, Math.max(TYPICAL_ROUNDS, iteration + 2)));
  const total = first + span * rounds + (STAGE_ORDER.length - last - 1);
  const position =
    index < first
      ? index
      : index > last
        ? first + span * rounds + (index - last - 1)
        : first + span * Math.min(iteration, rounds - 1) + (index - first);
  return 0.1 + (0.8 * position) / total;
}

function makeProgressReporter(
  onProgress: ((p: Progress) => void) | undefined,
): (stage: string, completed: number, message?: string) => void {
  if (!onProgress) return () => {};
  // Never backwards: `completed` feeds a progress bar, and a bar that retreats
  // is wrong however the estimate underneath it moved.
  let high = 0;
  return (stage, completed, message) => {
    high = Math.max(high, Math.min(1, completed));
    onProgress({ stage, completed: high, message });
  };
}

function renderBanner(ctx: PipelineContext, iterations: number): string {
  const found = ctx.detections
    .slice(0, 6)
    .map((d) => d.kind)
    .join(', ');
  return [
    '/*',
    ' * Deobfuscated with jsrift.',
    ` * Detected: ${found || 'no known obfuscator signature'}`,
    ` * Changes: ${ctx.totalChanges} across ${iterations} iteration(s)`,
    ' */',
  ].join('\n');
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
