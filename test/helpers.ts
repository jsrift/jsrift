import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { printAst } from '../src/frontend/print.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { Kernel } from '../src/pipeline/kernel.js';
import type { Pass } from '../src/pipeline/pass.js';
import type { DeobfuscateOptions, Language } from '../src/types.js';

export interface RunPassResult {
  code: string;
  changes: number;
  ctx: PipelineContext;
}

/**
 * Run a single pass (or a small set) in isolation.
 *
 * Isolation is the point: when a pass test fails it should indict that pass, not
 * leave you bisecting a twenty-pass pipeline.
 */
export async function runPass(
  passes: Pass | Pass[],
  source: string,
  options: DeobfuscateOptions = {},
): Promise<RunPassResult> {
  const list = Array.isArray(passes) ? passes : [passes];
  const config = resolveConfig({
    preset: 'aggressive',
    ...options,
    performance: { verifyOutput: false, ...options.performance },
  });
  const parsed = parseSource(source, { language: options.language, sourceType: options.sourceType });
  const ctx = new PipelineContext(
    parsed.ast,
    source,
    config,
    parsed.language,
    Date.now() + 60_000,
  );
  await new Kernel(list, ctx).run();
  const { code } = printAst(parsed.ast, source, config.output);
  return { code, changes: ctx.totalChanges, ctx };
}

/** Normalise whitespace so assertions compare structure rather than formatting. */
export function normalize(code: string): string {
  return code.replace(/\s+/g, ' ').replace(/\s*([{}();,])\s*/g, '$1').trim();
}

export function expectEquivalent(actual: string, expected: string): void {
  const a = normalize(actual);
  const b = normalize(expected);
  if (a !== b) {
    throw new Error(`Output mismatch.\n  actual:   ${a}\n  expected: ${b}`);
  }
}

/** Assert a pass is idempotent: applying it twice equals applying it once. */
export async function expectIdempotent(
  passes: Pass | Pass[],
  source: string,
  options: DeobfuscateOptions = {},
): Promise<void> {
  const once = await runPass(passes, source, options);
  const twice = await runPass(passes, once.code, options);
  if (normalize(once.code) !== normalize(twice.code)) {
    throw new Error(
      `Pass is not idempotent.\n  after 1: ${normalize(once.code)}\n  after 2: ${normalize(twice.code)}`,
    );
  }
}

/** Assert the pass makes no change - the negative case every pass test needs. */
export async function expectNoChange(
  passes: Pass | Pass[],
  source: string,
  options: DeobfuscateOptions = {},
): Promise<void> {
  const result = await runPass(passes, source, options);
  if (result.changes !== 0) {
    throw new Error(
      `Expected no change but pass reported ${result.changes}.\n  output: ${normalize(result.code)}`,
    );
  }
}

/** Parse the given code, throwing a readable error if it is not valid. */
export function assertParses(code: string, language: Language = 'auto'): void {
  const parsed = parseSource(code, { language });
  if (parsed.recovered) {
    throw new Error(`Output only parsed with error recovery: ${parsed.errors.join('; ')}`);
  }
}
