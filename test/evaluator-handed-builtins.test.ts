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
 * A builtin reaches a write by a route the index has to see whole: the
 * right arm of a `||` or `??` whose left is a property that may not exist,
 * the parameter of a callback a builtin runs - `Array.from`'s mapper, a
 * comparator - the global object read through a function literal's
 * constructor, a bound function picked out of an array literal and called
 * at once. Every shape here writes `String.fromCharCode` and the program
 * prints the replacement's answer; the decoder beside it is refused, or
 * read as the program runs it, at every preset.
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

/** Deobfuscate at every preset and prove each output does what the input does. */
async function expectSameBehaviourEverywhere(source: string): Promise<void> {
  const before = execute(source);
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset });
    expect(execute(result.code), preset).toBe(before);
  }
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
const PRINTS_REPLACED = '"ZZZ" "ZZZZZ"';

// ---------------------------------------------------------------------------
// Routes to the builtin
// ---------------------------------------------------------------------------

const HANDED: Record<string, string> = {
  'the right arm of || behind a property of the global object': `var S = globalThis.MyString || String; S.fromCharCode = ${FCC};`,
  'the right arm of || behind a property of a prototype': `var S = String.prototype.foo || String; S.fromCharCode = ${FCC};`,
  'the right arm of ?? behind a property of a builtin': `var S = Math.nope ?? String; S.fromCharCode = ${FCC};`,
  'the mapper of Array.from': `function patch(S) { S.fromCharCode = ${FCC}; } Array.from([String], patch);`,
  'the mapper of Array.from as a function expression': `Array.from([String], function (S) { S.fromCharCode = ${FCC}; });`,
  'the comparator of sort': `function patch(S) { S.fromCharCode = ${FCC}; } [String, String].sort(patch);`,
  'the global object through a function literal constructor': `var g = (function () {}).constructor('return this')(); g.String.fromCharCode = ${FCC};`,
  'a bound function picked out of an array literal': `function f(K) { K.fromCharCode = ${FCC}; } [f.bind(null)][0](String);`,
};

describe('a builtin handed to a write by a route seen whole', () => {
  for (const [what, write] of Object.entries(HANDED)) {
    it(`refuses the decoder at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe(PRINTS_REPLACED);
      for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder, `${what} at ${preset}`).toBeUndefined();
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('still takes the left arm of || when it is a builtin itself', async () => {
    const source = `var S = String || Math; S.custom = 1; var M = Math || String; M.fromCharCode = ${FCC};${DECODER_CHARS}`;
    expect(execute(source)).toBe('"ünï" "plain"');
    for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder?.decode([0]), preset).toBe('ünï');
    await expectSameBehaviourEverywhere(source);
  });
});
