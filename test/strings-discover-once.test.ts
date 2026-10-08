import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { PipelineContext } from '../src/pipeline/context.js';

/**
 * The round-end "Found N string-array shape(s) but none produced a usable
 * decoder" is said once per count, not once per fixpoint round: the pass runs
 * every round, and a round that put nothing new up has nothing new to say.
 */

const FOUND = /^Found (\d+) string-array shape\(s\) but none produced a usable decoder\.$/;

function found(diagnostics: readonly { message: string }[]): string[] {
  return diagnostics.map((d) => d.message).filter((m) => FOUND.test(m));
}

describe('strings.discover: the round-end shape count', () => {
  it('is reported once per run when a later round puts nothing new up', async () => {
    // Refused in round one (the table escapes into the conditional); the
    // conditional folds, and round two puts the same candidate up again.
    const source = `var a = ['alpha', 'beta', 'gamma'], b = true ? a : null;\nb.reverse();\nlog(a[0]);`;
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { metadata } = await deobfuscate(source, { preset });
      expect(metadata.stats.iterations, preset).toBeGreaterThan(1);
      expect(found(metadata.diagnostics), preset).toEqual([
        'Found 1 string-array shape(s) but none produced a usable decoder.',
      ]);
    }
  });

  it('is reported again when the count changes', () => {
    const source = `var a = ['alpha', 'beta', 'gamma'];\na.reverse();\nlog(a[0]);`;
    const parsed = parseSource(source, { language: 'js', sourceType: 'script' });
    const ctx = new PipelineContext(
      parsed.ast,
      source,
      resolveConfig({ preset: 'balanced' }),
      parsed.language,
      Date.now() + 60_000,
    );
    const run = () => discoverStringsPass.run!(ctx);

    run();
    run();
    expect(found(ctx.diagnostics)).toEqual([
      'Found 1 string-array shape(s) but none produced a usable decoder.',
    ]);

    // A second table the next round exposes, refused the same way.
    parsed.ast.program.body.push(
      ...(parseSource(`var c = ['delta', 'epsilon', 'zeta'];\nc.sort();\nlog(c[0]);`, {
        language: 'js',
        sourceType: 'script',
      }).ast.program.body as t.Statement[]),
    );
    ctx.markChanged();
    run();
    run();
    expect(found(ctx.diagnostics)).toEqual([
      'Found 1 string-array shape(s) but none produced a usable decoder.',
      'Found 2 string-array shape(s) but none produced a usable decoder.',
    ]);
  });
});
