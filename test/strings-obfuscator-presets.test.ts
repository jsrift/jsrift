import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { obfuscate, type ObfuscatorOptions } from 'javascript-obfuscator';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult, PresetName } from '../src/types.js';

/**
 * obfuscator.io's built-in presets and its `selfDefending` option, end to end.
 *
 * `low-obfuscation` is the commonest real configuration - `selfDefending`,
 * `disableConsoleOutput`, a string array behind a `variable` wrapper, rotated
 * and shuffled - and it used to come out with nothing decoded and an output
 * that hung: the console stub reaches the global object through
 * `Function('return (function() ' + '{}.constructor("return this")( )' +
 * ');')()`, both literals of which are calls to the decoder, and a source the
 * facts cannot read refused the decoder for the `parseInt` its rotation
 * reads. `strings.discover` now reads that source through the decoder it is
 * built from; the self-defending guard, whose member names are then plain,
 * goes with `clean`; and the guard goes at `conservative` too, since the
 * reprinted output hangs on it where the input runs.
 *
 * Every case executes the source, the obfuscated form and the output in a
 * realm with `log` and drained timers - `selfDefending` and `debugProtection`
 * register timers, and a realm without them makes the obfuscated form itself
 * diverge - and compares the three traces.
 */

const PROGRAMS: Record<string, string> = {
  greeting: `function greet(name) { return 'Hello, ' + name + '!'; } log(greet('World'));`,
  controlFlow: `function classify(n) { if (n < 0) return 'negative'; switch (n % 3) { case 0: return 'triple'; case 1: return 'one-over'; default: return 'two-over'; } } for (var i = -1; i < 5; i++) log(i + ':' + classify(i));`,
  closures: `function counter(start) { var n = start; return { inc: function () { return ++n; }, get: function () { return n; } }; } var c = counter(10); c.inc(); c.inc(); log(c.get());`,
  objectsAndArrays: `var config = { name: 'widget', sizes: [1, 2, 3], nested: { depth: 2 } }; var total = config.sizes.reduce(function (a, b) { return a + b; }, 0); log(config.name + '/' + total + '/' + config.nested.depth);`,
  modern: `class Vessel { #mask = 170; constructor(hex) { this.hex = hex; } *unmask() { for (const ch of this.hex.match(/../g)) yield (parseInt(ch, 16) ^ this.#mask).toString(16).padStart(2, '0'); } static from(h) { return new Vessel(h); } } const v = Vessel.from('d3cbed8acf'); const out = [...v.unmask()].map(x => x.toUpperCase()).join(':'); const tag = (s, ...a) => s.raw.join('|') + a.length; log(out, tag\`a\${1}b\${2}\`, typeof Vessel, JSON.stringify({ k: [1, 'two', null] }));`,
  async: `const sleep = () => Promise.resolve(); async function main() { let acc = ''; for (const w of ['alpha', 'beta']) { await sleep(); acc += w.slice(0, 2); } try { null.x; } catch (e) { acc += e instanceof TypeError ? '!' : '?'; } log(acc); } main();`,
};

interface Timer {
  fn: unknown;
  args: unknown[];
  repeat: boolean;
  dead?: boolean;
}

/** The program's trace: `log` lines, then whatever the drained timers add. */
function execute(code: string): string {
  const out: string[] = [];
  const timers: Timer[] = [];
  const sandbox = {
    log: (...args: unknown[]) => out.push(args.map(String).join(' ')),
    setTimeout: (fn: unknown, _ms: unknown, ...args: unknown[]) => timers.push({ fn, args, repeat: false }),
    setInterval: (fn: unknown, _ms: unknown, ...args: unknown[]) => timers.push({ fn, args, repeat: true }),
    clearTimeout: (id: number) => {
      if (timers[id - 1]) timers[id - 1]!.dead = true;
    },
    clearInterval: (id: number) => {
      if (timers[id - 1]) timers[id - 1]!.dead = true;
    },
  };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
    for (let round = 0; round < 2; round++) {
      for (const timer of timers) {
        if (timer.dead || typeof timer.fn !== 'function') continue;
        try {
          vm.runInNewContext('fn(...args)', { fn: timer.fn, args: timer.args }, { timeout: 2_000 });
        } catch (error) {
          out.push(`TIMER-THROW ${(error as Error).name}`);
        }
        if (!timer.repeat) timer.dead = true;
      }
    }
  } catch (error) {
    const err = error as Error & { code?: string };
    out.push(err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'HANG' : `THROWN ${err.name}`);
  }
  return out.join('\n');
}

/** Stack `layers` obfuscations of `source` with reproducible seeds. */
function layered(source: string, options: ObfuscatorOptions, layers: number): string {
  let current = source;
  for (let layer = 1; layer <= layers; layer++) {
    current = obfuscate(current, { ...options, seed: 20260920 + layer }).getObfuscatedCode();
  }
  return current;
}

const ENCODED_CALL = /\b_0x[0-9a-f]+\((0x)?[0-9a-f]+\)/;
/** The rotation loop: the table shifted onto its own end until a checksum matches. */
const ROTATION = /\.push\([\w$]+\.shift\(\)\)/;
const REDOS_GUARD = '(((.+)+)+)+$';

/** What a reader must not be left holding once the run is complete. */
function expectClean(result: DeobfuscateResult): void {
  expect(result.metadata.stats.verified).toBe(true);
  expect(result.metadata.stats.truncated).toBe(false);
  expect(result.metadata.strings.length).toBeGreaterThan(0);
  expect(result.code).not.toMatch(ENCODED_CALL);
  expect(result.code).not.toMatch(ROTATION);
  expect(result.code).not.toContain(REDOS_GUARD);
  expect(result.code).not.toContain('return this');
  expect(result.metadata.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
}

const LOW: ObfuscatorOptions = { optionsPreset: 'low-obfuscation' };
const MEDIUM: ObfuscatorOptions = { optionsPreset: 'medium-obfuscation' };

describe('optionsPreset: low-obfuscation (selfDefending + disableConsoleOutput + variable wrappers)', () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    const expected = execute(source);
    // One layer. Stacked, each layer's console stub spells its Function
    // arguments in calls to ITS decoder, and the outer decoder is refused for a
    // site it cannot read: the STRINGS workstream's rejected list has the shape.
    for (const layers of [1]) {
      for (const preset of ['balanced', 'aggressive'] as PresetName[]) {
        it(`${name} x${layers} at ${preset}: every string decoded, the guard and the console stub gone, same trace`, async () => {
          const input = layered(source, LOW, layers);
          expect(execute(input)).toBe(expected);
          const result = await deobfuscate(input, { preset });
          expectClean(result);
          expect(execute(result.code)).toBe(expected);
          // The console stub's global-object probe and its method table are gone with it.
          expect(result.code).not.toContain("'exception'");
          expect(result.metadata.diagnostics.some((d) => /Read the string code that stood in the way of/.test(d.message))).toBe(true);
        }, 60_000);
      }
    }
  }
});

describe('optionsPreset: medium-obfuscation, one layer', () => {
  // The two programs whose console stub routes the `Function` arguments through
  // a `+` proxy of the control-flow object map are left with the map's keys,
  // and with them the source, still encoded: see the STRINGS workstream's
  // rejected list. The four below carry the stub as the low preset does.
  for (const name of ['controlFlow', 'closures', 'modern', 'async']) {
    const source = PROGRAMS[name]!;
    const expected = execute(source);
    for (const preset of ['balanced', 'aggressive'] as PresetName[]) {
      it(`${name} at ${preset}`, async () => {
        const input = layered(source, MEDIUM, 1);
        expect(execute(input)).toBe(expected);
        const result = await deobfuscate(input, { preset });
        expectClean(result);
        expect(execute(result.code)).toBe(expected);
      }, 60_000);
    }
  }
});

describe('selfDefending alone, at every preset including conservative', () => {
  const VARIANTS: Array<{ name: string; options: ObfuscatorOptions }> = [
    { name: 'no string array', options: { selfDefending: true, compact: true } },
    {
      name: 'variable wrappers',
      options: { selfDefending: true, stringArray: true, stringArrayThreshold: 1, stringArrayWrappersType: 'variable', stringArrayWrappersCount: 2 },
    },
    {
      name: 'function wrappers',
      options: { selfDefending: true, stringArray: true, stringArrayThreshold: 1, stringArrayWrappersType: 'function', stringArrayWrappersCount: 2 },
    },
    {
      name: 'mangled identifier names',
      options: { selfDefending: true, stringArray: true, stringArrayThreshold: 1, identifierNamesGenerator: 'mangled' },
    },
  ];
  const source = PROGRAMS.closures!;
  const expected = execute(source);
  for (const { name, options } of VARIANTS) {
    for (const preset of ['conservative', 'balanced', 'aggressive'] as PresetName[]) {
      it(`${name} at ${preset}: the guard is removed and the output runs`, async () => {
        const input = layered(source, options, 1);
        expect(execute(input)).toBe(expected);
        const result = await deobfuscate(input, { preset });
        expect(result.metadata.stats.verified).toBe(true);
        expect(result.code).not.toContain(REDOS_GUARD);
        expect(result.code).not.toMatch(ENCODED_CALL);
        expect(result.metadata.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
        expect(execute(result.code)).toBe(expected);
        if (preset === 'conservative') {
          const remover = result.metadata.passes.find((p) => p.id === 'clean.reprint-guards');
          expect(remover?.changes ?? 0).toBeGreaterThan(0);
        }
      }, 60_000);
    }
  }
});

describe('the fingerprint tells the truth about the guard', () => {
  it('names the guard, not the decoder, and says every preset removes it', async () => {
    const input = layered(PROGRAMS.greeting!, { selfDefending: true, stringArray: true, stringArrayThreshold: 1 }, 1);
    const result = await deobfuscate(input, { preset: 'balanced' });
    const advice = result.metadata.diagnostics.find((d) => /self-defending guards detected/.test(d.message));
    expect(advice).toBeDefined();
    expect(advice!.message).not.toMatch(/decoder inspects its own source/);
    expect(advice!.message).toMatch(/matches the program's own printed source/);
    expect(advice!.message).toMatch(/at every preset/);
  });

  it('a self-defending guard beside an obfuscated decoder is not attributed to the decoder', async () => {
    // The guard reads its own text; the decoder beside it is a plain index
    // lookup, and the report says so by not refusing it.
    const input = layered(PROGRAMS.greeting!, LOW, 1);
    const result = await deobfuscate(input, { preset: 'balanced' });
    expect(result.metadata.diagnostics.some((d) => /Refusing to evaluate/.test(d.message))).toBe(false);
    expect(result.metadata.detections.some((d) => d.kind === 'string-array-wrapper')).toBe(true);
  });
});
