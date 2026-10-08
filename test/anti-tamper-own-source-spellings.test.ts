import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, DeobfuscateResult } from '../src/types.js';

/**
 * A function reads its own printed text through any spelling of the string
 * coercion - `f.toString()`, `String(f)`, `'' + f`, `f + ''` - directly or
 * through a name it stored the text under. A guard built on that text hangs
 * on the reprinted output whatever the spelling, so every spelling is read
 * as one: a guard that is the whole of its function goes, and a guard that
 * shares its function with work the program does is left, with the error
 * that says the output will not run.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

const NL = String.raw`\n`;

function trace(code: string): string {
  const lines: string[] = [];
  try {
    vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  } catch (error) {
    const err = error as Error & { code?: string };
    lines.push(err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'HANG' : `THROWN ${err.name}: ${err.message}`);
  }
  return lines.join(' | ');
}

function hazardErrors(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics.filter((d) => d.severity === 'error' && /will not run/.test(d.message)).map((d) => d.message);
}

async function run(source: string, preset: DeobfuscateOptions['preset']): Promise<DeobfuscateResult> {
  return deobfuscate(source, { preset });
}

describe('a guard that is the whole of its function is removed in every spelling', () => {
  const cases: [string, string][] = [
    ['an empty string concatenated, matched by a regex', `(function f() { if (/${NL}/.test('' + f)) { while (true) {} } })(); log('ok');`],
    ['concatenated on the right', `(function f() { if (/${NL}/.test(f + '')) { while (true) {} } })(); log('ok');`],
    ['String applied, then indexed', `(function f() { if (String(f).indexOf('${NL}') !== -1) { while (true) {} } })(); log('ok');`],
    ['concatenated, then indexed', `(function f() { if (('' + f).indexOf('${NL}') !== -1) { while (true) {} } })(); log('ok');`],
    ['stored under a name, then indexed', `(function f() { var s = '' + f; if (s.indexOf('${NL}') !== -1) { while (true) {} } })(); log('ok');`],
    ['stored under a name, then matched', `(function f() { var s = f + ''; if (/${NL}/.test(s)) { while (true) {} } })(); log('ok');`],
    ['toString stored under a name, then indexed', `(function f() { var s = f.toString(); if (s.indexOf('${NL}') !== -1) { while (true) {} } })(); log('ok');`],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`${title}, ${preset}`, async () => {
        expect(trace(source)).toBe('ok');
        const result = await run(source, preset);
        expect(trace(result.code)).toBe('ok');
        expect(hazardErrors(result)).toHaveLength(0);
      });
    }
  }
});

describe('a guard sharing its function with work the program does', () => {
  const cases: [string, string][] = [
    ['concatenated and stored under a name', `(function f() { var s = '' + f; if (s.indexOf('${NL}') !== -1) { while (true) {} } log('ok'); })();`],
    ['toString, read in place', `(function f() { if (f.toString().indexOf('${NL}') !== -1) { while (true) {} } log('ok'); })();`],
    ['matched by a regex', `(function f() { if (/${NL}/.test('' + f)) { while (true) {} } log('ok'); })();`],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`keeps the work and says the output will not run: ${title}, ${preset}`, async () => {
        expect(trace(source)).toBe('ok');
        const result = await run(source, preset);
        expect(result.code).toContain("log('ok')");
        expect(hazardErrors(result)).toHaveLength(1);
      });
    }
  }
});

describe('a coercion of something other than the function itself is left alone', () => {
  const cases: [string, string][] = [
    ['a parameter', `function render(value) { if (('' + value).indexOf('x') !== -1) { log('x'); } } render('axb'); log('ok');`],
    ['an outer binding', `var template = 'a${NL}b'; function apply() { if (('' + template).indexOf('${NL}') !== -1) { log('nl'); } } apply(); log('ok');`],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`${title}, ${preset}`, async () => {
        const result = await run(source, preset);
        expect(trace(result.code)).toBe(trace(source));
        expect(hazardErrors(result)).toHaveLength(0);
      });
    }
  }
});
