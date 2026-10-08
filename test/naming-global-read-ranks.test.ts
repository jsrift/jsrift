import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * The global object's aliases are walked at three ranks, and a read off an
 * alias can be reached at two of them: `g[k]` with `g = window` at the top
 * of a script and `g = this` inside a plain function. What the read discloses
 * depends on the rank that reaches it - only the certain one says a
 * top-level name may be read under a key the pass could not resolve - so a
 * read consumed at the weaker rank first still records the disclosure when
 * the certain one arrives, whichever order the aliases are found in.
 */

const PRESETS = ['balanced', 'aggressive'] as const;

const ASSUMED_READ = /read under a key this pass could not resolve/;

function trace(code: string): string {
  const lines: string[] = [];
  const sandbox: Record<string, unknown> = {
    log: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    dec: (index: number) => ['log'][index],
  };
  sandbox['window'] = sandbox;
  try {
    vm.runInNewContext(code, sandbox, { timeout: 2_000 });
  } catch (error) {
    const err = error as Error;
    lines.push(`THROWN ${err.name}: ${err.message}`);
  }
  return lines.join(' | ');
}

describe('a global read reached at two ranks', () => {
  const cases: [string, string][] = [
    [
      'the certain alias declared first',
      'var g = window; function init() { g = this; } for (var a = 0; a < 3; a++) log(a); var k = dec(0); g[k]();',
    ],
    [
      'the uncertain alias assigned first',
      'function init() { g = this; } var g = window; for (var a = 0; a < 3; a++) log(a); var k = dec(0); g[k]();',
    ],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`discloses the assumed host read: ${title}, ${preset}`, async () => {
        const result = await deobfuscate(source, { preset: preset as DeobfuscateOptions['preset'] });
        expect(trace(result.code)).toBe(trace(source));
        // The loop variable is renamed on the assumption the read is of a host property; the assumption is said.
        expect(result.code).not.toMatch(/var a = 0/);
        expect(result.metadata.diagnostics.some((d) => ASSUMED_READ.test(d.message))).toBe(true);
      });
    }
  }
});
