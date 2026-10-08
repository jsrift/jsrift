import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder, type DecoderRefusal } from '../src/analysis/evaluator/index.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

/**
 * A function that forwards its arguments to itself - a retry wrapper,
 * `retry(...args)` in its own catch - or to a partner that forwards them
 * back is a cycle in what a parameter is handed, and `arguments[0]` given
 * on to the same function is one in what a call returns. A parameter met
 * again while its own sources are gathered is a fixed point: the inner
 * walk could find nothing the outer one is not already gathering, so the
 * calls outside the cycle are the whole answer. A hop through the
 * arguments object counts against the same depth as any other alias. A
 * decoder beside such a wrapper is read or refused like any other, and
 * the pass that builds it stays on.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`;
  return String(value);
}

/** Run in a realm holding nothing but `log`, and record everything observable. */
function execute(code: string, timeout = 2_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programPath(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source, {});
  let found: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  if (!found) throw new Error('no Program path');
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], options: Parameters<typeof resolveConfig>[0] = {}) {
  const notes: { severity: Severity; message: string }[] = [];
  const refusals: DecoderRefusal[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: {
      note: (severity, message) => notes.push({ severity, message }),
      refused: (kind) => refusals.push(kind),
    },
  });
  return { decoder, notes, refusals };
}

const DECODER_CHARS = `
var table = ['252,110,239', '112,108,97,105,110', '111,107'];
function dec(i) {
  var parts = table[i].split(',');
  var out = '';
  for (var k = 0; k < parts.length; k++) out += String.fromCharCode(+parts[k]);
  return out;
}
log(dec(0), dec(1));
`;

const FCC = "function () { return 'Z'; }";
const PRINTS_CHARS = '"ünï" "plain"';
const PRINTS_REPLACED = '"ZZZ" "ZZZZZ"';

/** Every preset prints what the program prints, and no pass was switched off on the way. */
async function expectSameBehaviourEverywhere(source: string): Promise<Record<(typeof PRESETS)[number], string>> {
  const before = execute(source);
  const outputs = {} as Record<(typeof PRESETS)[number], string>;
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset });
    expect(execute(result.code), preset).toBe(before);
    const disabled = result.metadata.diagnostics.map((d) => d.message).filter((m) => m.startsWith('Pass disabled'));
    expect(disabled, preset).toEqual([]);
    outputs[preset] = result.code;
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Cycles in what a parameter is handed
// ---------------------------------------------------------------------------

/** A wrapper whose rest reaches `fn`'s parameter, through a cycle of forwarding. */
const FORWARDED: Record<string, (body: string) => string> = {
  'a rest forwarded to the function itself': (body) =>
    `function retry(...args) { try { return fn(...args); } catch (e) { return retry(...args); } } function fn(S) { ${body} } retry(String);`,
  'a rest forwarded between two functions': (body) =>
    `function a(...x) { try { return fn(...x); } catch (e) { return b(...x); } } function b(...y) { return a(...y); } function fn(S) { ${body} } a(String);`,
  'the arguments object forwarded to the function itself': (body) =>
    `var n = 0; function f() { return n++ > 0 ? fn(arguments[0]) : f(arguments[0]); } function fn(S) { ${body} } f(String);`,
};

describe('a parameter handed through a cycle of forwarding', () => {
  for (const [what, wrap] of Object.entries(FORWARDED)) {
    it(`refuses the decoder when the parameter is the builtin written: ${what}`, async () => {
      const source = `${wrap(`S.fromCharCode = ${FCC};`)}${DECODER_CHARS}`;
      expect(execute(source)).toBe(PRINTS_REPLACED);
      for (const preset of PRESETS) {
        const built = build(source, ['dec', 'table'], { preset });
        expect(built.decoder, `${what} at ${preset}`).toBeUndefined();
      }
      await expectSameBehaviourEverywhere(source);
    });

    it(`decodes when the parameter is written somewhere else: ${what}`, async () => {
      const source = `${wrap('S.custom = 1;')}${DECODER_CHARS}`;
      expect(execute(source)).toBe(PRINTS_CHARS);
      for (const preset of PRESETS) {
        const built = build(source, ['dec', 'table'], { preset });
        expect(built.decoder?.decode([0]), `${what} at ${preset}`).toBe('ünï');
      }
      const outputs = await expectSameBehaviourEverywhere(source);
      for (const [preset, code] of Object.entries(outputs)) expect(code, preset).toContain("'ünï'");
    });
  }
});

// ---------------------------------------------------------------------------
// A cycle in what a call returns
// ---------------------------------------------------------------------------

describe('a call whose return is the arguments object handed to itself', () => {
  const RETURNS = `var n = 0; function f() { return n++ > 0 ? arguments[0] : f(arguments[0]); }`;

  it('refuses the decoder when the call gives back the builtin written', async () => {
    const source = `${RETURNS} f(String).fromCharCode = ${FCC};${DECODER_CHARS}`;
    expect(execute(source)).toBe(PRINTS_REPLACED);
    expect(() => build(source, ['dec', 'table'], { preset: 'conservative' })).not.toThrow();
    expect(build(source, ['dec', 'table'], { preset: 'conservative' }).decoder).toBeUndefined();
    await expectSameBehaviourEverywhere(source);
  });

  it('decodes when the call gives back something the decoder never reads', async () => {
    const source = `${RETURNS} f(Math).round = function () { return 7; };${DECODER_CHARS}`;
    expect(execute(source)).toBe(PRINTS_CHARS);
    for (const preset of PRESETS) {
      expect(() => build(source, ['dec', 'table'], { preset })).not.toThrow();
    }
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const [preset, code] of Object.entries(outputs)) expect(code, preset).toContain("'ünï'");
  });
});
