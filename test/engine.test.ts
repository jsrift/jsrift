import { describe, expect, it } from 'vitest';
import * as t from '@babel/types';
import { analyze, deobfuscate, listPasses, PRESET_TECHNIQUES } from '../src/index.js';
import { ParseFailedError } from '../src/frontend/language.js';
import { PrintFailedError, printAst } from '../src/frontend/print.js';
import { resolveConfig } from '../src/config/presets.js';

const SAMPLE = `
// a leading comment that must survive
var _0xdb56 = ["log", "hello"];
!function (w) {
  w.console[_0xdb56[0]](_0xdb56[1]);
}(window);
`;

describe('engine integration', () => {
  it('registers every pass exactly once with a known stage and technique', () => {
    const passes = listPasses();
    expect(passes.length).toBeGreaterThan(0);
    expect(new Set(passes.map((p) => p.id)).size).toBe(passes.length);
  });

  it('produces verified, parseable output', async () => {
    const result = await deobfuscate(SAMPLE);
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('does not report a truncated run when well inside the time budget', async () => {
    // Regression guard: the deadline is epoch-based while timings use
    // performance.now(). Mixing the two makes every run report truncated and
    // silently skips the entire fixpoint loop.
    const result = await deobfuscate(SAMPLE, { performance: { timeBudgetMs: 60_000 } });
    expect(result.metadata.stats.truncated).toBe(false);
    expect(result.metadata.stats.iterations).toBeGreaterThan(0);
  });

  it('honours an already-expired time budget instead of running forever', async () => {
    const result = await deobfuscate(SAMPLE, { performance: { timeBudgetMs: 0 } });
    expect(result.metadata.stats.truncated).toBe(true);
  });

  it('preserves comments by default and drops them on request', async () => {
    const kept = await deobfuscate(SAMPLE);
    expect(kept.code).toContain('must survive');
    const dropped = await deobfuscate(SAMPLE, { output: { comments: false } });
    expect(dropped.code).not.toContain('must survive');
  });

  it('emits a source map that points back at the original input', async () => {
    const result = await deobfuscate(SAMPLE, {
      filename: 'game.js',
      output: { sourceMaps: true },
    });
    expect(result.map).toBeDefined();
    expect(result.map!.sources).toEqual(['game.js']);
    expect(result.map!.sourcesContent?.[0]).toBe(SAMPLE);
    expect(result.map!.mappings.length).toBeGreaterThan(0);
  });

  it('inlines the source map when asked', async () => {
    const result = await deobfuscate(SAMPLE, { output: { sourceMaps: 'inline' } });
    expect(result.code).toContain('sourceMappingURL=data:application/json');
    expect(result.map).toBeUndefined();
  });

  it.each([
    ['const a = 1;', 'js'],
    ['const F = () => <div>{y}</div>;', 'jsx'],
    ['const a = <string>x; interface I { a: number }', 'ts'],
    ['const F = (p: {a: string}) => <div>{p.a}</div>;', 'tsx'],
  ])('detects the dialect of %s as %s', (code, expected) => {
    expect(analyze(code).language).toBe(expected);
  });

  it('recovers from merely-damaged input and records a warning', async () => {
    // Recoverable in Babel's sense: an invalid assignment target parses into a
    // usable tree with a recorded error, unlike a truncated statement.
    const result = await deobfuscate('a++ = 3;');
    expect(result.metadata.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
  });

  it('throws a typed, informative error when the input is not code at all', async () => {
    await expect(deobfuscate('function ( {')).rejects.toThrow(ParseFailedError);
    await expect(deobfuscate('function ( {')).rejects.toThrow(/could not be parsed/);
  });

  // Valid JavaScript that exhausts the parser's stack used to arrive as "could
  // not be parsed as JavaScript, TypeScript or JSX", which sends the user
  // looking for corruption in a file that has none.
  it('separates a parser stack limit from input that is not JavaScript', async () => {
    const source = `var z = ${'!'.repeat(200_000)}x;`;
    const error = await deobfuscate(source).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ParseFailedError);
    expect((error as Error).message).toMatch(/nests too deeply/);
  });

  // The generator descends one frame per operand, and that throw lands outside
  // every guard the pipeline has - the kernel's isolation stops at the pass
  // boundary. A `RangeError` from inside node_modules is not an answer.
  it('reports a printer stack limit as a typed failure', () => {
    let expression: t.Expression = t.stringLiteral('a');
    for (let i = 0; i < 100_000; i++) {
      expression = t.binaryExpression('+', expression, t.stringLiteral('a'));
    }
    const file = t.file(t.program([t.expressionStatement(expression)]));
    expect(() => printAst(file, '', resolveConfig({}).output)).toThrow(PrintFailedError);
  });

  it('respects an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await deobfuscate(SAMPLE, { signal: controller.signal });
    expect(result.metadata.stats.truncated).toBe(true);
  });

  // The signal was checked all along and could never fire: every `await` in the
  // kernel settles in a microtask, and microtasks are drained before any timer
  // callback runs, so the `abort()` below used to land after the run had already
  // resolved with `truncated: false`. The engine now gives the host one
  // macrotask between stages.
  it('observes an abort raised after the run has started', async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const run = deobfuscate(SAMPLE.repeat(200), {
      signal: controller.signal,
      onProgress: (progress) => stages.push(progress.stage),
    });
    // Queued after the engine's own first hop, so the run is in flight here.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await run;
    expect(result.metadata.stats.truncated).toBe(true);
    expect(stages.length).toBeGreaterThan(1);
  });

  // With or without a signal. A run that never turns the loop is a run the host
  // cannot get a word into - no progress message leaves a worker until the end,
  // and anything with a deadline on the worker's own loop (vitest's RPC, at a
  // hard-coded 60 s) times out on a large file. The hop is a `MessageChannel`
  // message, which costs nothing measurable; a timer would.
  it('gives the host a turn between stages even when no signal was supplied', async () => {
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    await deobfuscate(SAMPLE);
    expect(ticked).toBe(true);
  });
});

describe('preset and override resolution', () => {
  it('exposes three presets with increasing coverage', () => {
    const count = (p: keyof typeof PRESET_TECHNIQUES) =>
      Object.values(PRESET_TECHNIQUES[p]).filter(Boolean).length;
    expect(count('conservative')).toBeLessThan(count('balanced'));
    expect(count('balanced')).toBeLessThanOrEqual(count('aggressive'));
  });

  it('lets an explicit false override win over the preset', () => {
    const config = resolveConfig({
      preset: 'aggressive',
      techniques: { deadCodeRemoval: false },
    });
    expect(config.techniques.deadCodeRemoval).toBe(false);
    expect(config.techniques.variableRenaming).toBe(true);
  });

  it('lets an object override both enable and tune a technique', () => {
    const config = resolveConfig({
      preset: 'conservative',
      techniques: { variableRenaming: { minConfidence: 0.42 } },
    });
    expect(config.techniques.variableRenaming).toBe(true);
    expect(config.techniqueOptions.variableRenaming.minConfidence).toBe(0.42);
  });

  it('keeps the sandbox evaluation tier off unless explicitly allowed', () => {
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const config = resolveConfig({ preset });
      expect(config.sandbox.allowExecution).toBe(false);
      expect(config.techniqueOptions.stringDecoding.tiers).not.toContain('sandbox');
    }
  });

  it('rejects an unknown preset with a helpful message', () => {
    expect(() => resolveConfig({ preset: 'turbo' as never })).toThrow(/Unknown preset/);
  });
});

/**
 * `inputBytes` / `outputBytes` are reported to callers as bytes and rendered
 * that way by the web UI, so they have to be bytes. `String.length` counts
 * UTF-16 code units, which agrees only on ASCII - and a decoded string table
 * is exactly where non-ASCII text enters the output.
 */
describe('stats: sizes are UTF-8 bytes, not code units', () => {
  const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

  it('counts a non-ASCII input as the bytes it occupies', async () => {
    const source = `var greeting = "caf\u00e9 \u{1f3ae}";\nconsole.log(greeting);\n`;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(result.metadata.stats.inputBytes).toBe(bytesOf(source));
    expect(result.metadata.stats.inputBytes).toBeGreaterThan(source.length);
  });

  it('counts the output it actually returned', async () => {
    const source = `var t = ["\u{1f3af}", "\u{1f3ae}"];\nconsole.log(t[0] + t[1]);\n`;
    const result = await deobfuscate(source, { preset: 'aggressive' });
    expect(result.metadata.stats.outputBytes).toBe(bytesOf(result.code));
  });

  it('agrees with code units on pure ASCII', async () => {
    const result = await deobfuscate(SAMPLE, { preset: 'balanced' });
    expect(result.metadata.stats.inputBytes).toBe(SAMPLE.length);
    expect(result.metadata.stats.outputBytes).toBe(result.code.length);
  });

  // The two entry points used to answer "how big is this file" differently:
  // `analyze` returned `source.length`, which is code units.
  it('reports the same input size from analyze() and deobfuscate()', async () => {
    const source = `var greeting = "café \u{1f3ae}";\nconsole.log(greeting);\n`;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(analyze(source).bytes).toBe(result.metadata.stats.inputBytes);
    expect(analyze(source).bytes).toBe(bytesOf(source));
  });

  it('counts an unpaired surrogate the way an encoder writes it', async () => {
    // Reachable through a decoded literal, so it is measured, not hypothetical:
    // encoders substitute U+FFFD, which is three bytes.
    const source = `var s = "\ud800";\nconsole.log(s);\n`;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(result.metadata.stats.outputBytes).toBe(bytesOf(result.code));
  });
});

/**
 * `truncated` has to cover the whole run, not just the loop.
 *
 * `runStage` stops at the budget and skips a stage that starts past it, so a
 * `rename` cut mid-walk and a `finalize` never entered are both truncation.
 * The prologue and the fixpoint loop recorded that; the epilogue did not, and
 * a caller checking the flag was told the run was complete when its last two
 * stages had not happened.
 */
describe('truncated: the epilogue counts', () => {
  it('reports a budget that expires during the rename stage', async () => {
    const { PipelineContext } = await import('../src/pipeline/context.js');
    const { Kernel } = await import('../src/pipeline/kernel.js');
    const { parseSource } = await import('../src/frontend/language.js');

    const source = 'var a = 1; use(a);';
    const parsed = parseSource(source, {});
    const config = resolveConfig({ preset: 'balanced', performance: { verifyOutput: false } });
    const budgetMs = 40;
    const ctx = new PipelineContext(parsed.ast, source, config, parsed.language, Date.now() + budgetMs);

    let finalizeRan = false;
    const passes = [
      {
        id: 'test.burn',
        title: 'Burn the budget inside rename',
        stage: 'rename' as const,
        technique: 'core' as const,
        run: () => {
          // Synchronous, so the deadline passes while this stage is running.
          const until = Date.now() + budgetMs * 3;
          while (Date.now() < until) {
            /* spin */
          }
        },
      },
      {
        id: 'test.finalize-probe',
        title: 'Would run last',
        stage: 'finalize' as const,
        technique: 'core' as const,
        run: () => {
          finalizeRan = true;
        },
      },
    ];

    const result = await new Kernel(passes, ctx).run();
    expect(finalizeRan).toBe(false);
    expect(result.truncated).toBe(true);
  });
});
