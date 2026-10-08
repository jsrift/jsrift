import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { obfuscate } from 'javascript-obfuscator';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * String code read through the decoder it stands in the way of, on the tree
 * as the run has it.
 *
 * Two trees the reading meets: one whose scope tables it has just rebuilt,
 * where the inliner's index must be the rebuilt tables' and not the ones it
 * was made over; and one spliced in from a string, whose nodes carry no
 * source offsets, where every placing question is answered from the tree's
 * own numbering. In both, the sites of a table whose string code the round
 * read are inlined in that round.
 *
 * Every case executes input and output in a realm with `log`, a `console`
 * the stub can overwrite, and drained timers, and compares the traces.
 */
function execute(code: string): string {
  const out: string[] = [];
  const timers: unknown[] = [];
  const quiet = (): void => {};
  const sandbox: Record<string, unknown> = {
    log: (...args: unknown[]) => out.push(args.map(String).join(' ')),
    setTimeout: (fn: unknown) => timers.push(fn),
    setInterval: (fn: unknown) => timers.push(fn),
    console: { log: quiet, warn: quiet, error: quiet, info: quiet, debug: quiet, table: quiet, trace: quiet, exception: quiet },
  };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
    for (const timer of timers) if (typeof timer === 'function') (timer as () => void)();
  } catch (error) {
    out.push(`THROWN ${(error as Error).name}`);
  }
  return out.join(' | ');
}

const PRESETS: PresetName[] = ['balanced', 'aggressive'];

describe('strings.inline: a table whose string code the round read is inlined in that round', () => {
  const SPELLED_WRAPPER = `
    var _0xa = ['return 40 + 2;', 'alpha', 'beta'];
    function _0xd(i) { return _0xa[i]; }
    var f = Function(_0xd(0));
    log(f(), _0xd(1), _0xd(2));
  `;

  it.each(PRESETS)('%s inlines every site once the wrapper is spelled', async (preset) => {
    const { code, metadata } = await deobfuscate(SPELLED_WRAPPER, { preset, performance: { maxIterations: 1 } });
    expect(execute(code)).toBe(execute(SPELLED_WRAPPER));
    expect(code).toContain("'alpha'");
    expect(code).toContain("'beta'");
    expect(code).not.toMatch(/_0xd\(/);
    expect(
      metadata.diagnostics.some((d) => /^Read the string code that held every reference to _0xd/.test(d.message)),
    ).toBe(true);
  });

  it.each(PRESETS)('%s inlines the sites of an alias declared beside the wrapper', async (preset) => {
    const source = `
      var _0xa = ['return 40 + 2;', 'alpha', 'beta'];
      function _0xd(i) { return _0xa[i]; }
      function run() { var d = _0xd; var f = Function(d(0)); return f() + d(1) + d(2); }
      log(run());
    `;
    const { code } = await deobfuscate(source, { preset, performance: { maxIterations: 1 } });
    expect(execute(code)).toBe(execute(source));
    expect(code).toContain("'alpha'");
    expect(code).not.toMatch(/\bd\((1|2)\)/);
  });
});

describe('strings.discover: a payload spliced in from a string is read without source offsets', () => {
  const PROGRAM = `function greet(name) { return 'Hello, ' + name + '!'; } log(greet('World')); log(['alpha', 'beta', 'gamma'].join('-'), 'delta'.toUpperCase());`;
  const payload = obfuscate(PROGRAM, {
    stringArray: true,
    stringArrayThreshold: 1,
    rotateStringArray: true,
    disableConsoleOutput: true,
    seed: 20260930,
    compact: true,
  }).getObfuscatedCode();
  const wrapped = `Function("x", ${JSON.stringify(payload)})();`;

  it.each(PRESETS)('%s decodes every string of the unpacked payload', async (preset) => {
    const bare = await deobfuscate(payload, { preset });
    const result = await deobfuscate(wrapped, { preset });
    expect(execute(result.code)).toBe(execute(wrapped));
    expect(result.metadata.strings.length).toBe(bare.metadata.strings.length);
    expect(result.metadata.strings.length).toBeGreaterThan(20);
    expect(result.code).not.toMatch(/\.push\([\w$]+\.shift\(\)\)/);
    const lines = result.metadata.diagnostics.map((d) => d.message);
    expect(lines.some((m) => /^Refusing to evaluate .* parseInt by name/.test(m))).toBe(false);
    expect(lines.some((m) => /none produced a usable decoder/.test(m))).toBe(false);
  }, 60_000);

  it.each(PRESETS)('%s decodes the payload in one round when it is not wrapped', async (preset) => {
    const result = await deobfuscate(payload, { preset, performance: { maxIterations: 1 } });
    expect(execute(result.code)).toBe(execute(payload));
    expect(result.metadata.strings.length).toBeGreaterThan(20);
    expect(result.code).not.toMatch(/\.push\([\w$]+\.shift\(\)\)/);
  }, 60_000);
});
