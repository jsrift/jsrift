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
 * The key a write goes under, and the callee a call reaches, read the way
 * the program does: a key computed by a call is the callee the scope
 * resolves, not another function of the same name at the top; `+` over
 * two numbers adds where `+` over strings joins; `{ 0: String }` gives
 * `o[0]` the builtin as `{ '0': String }` does; `api.call(t, ...)` on a
 * holder that is no function is the holder's own method, called with
 * every argument as spelled. Every shape here writes `String.fromCharCode`
 * and the program prints the replacement's answer; the decoder beside it
 * is refused at every preset.
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
const PRINTS_CHARS = '"ünï" "plain"';
const PRINTS_REPLACED = '"ZZZ" "ZZZZZ"';

// ---------------------------------------------------------------------------
// Keys and callees
// ---------------------------------------------------------------------------

const WRITES: Record<string, string> = {
  'a key computed by a function shadowing one of the same name at the top':
    `function q(i) { return 'round'; } function setup() { var q = function (i) { return 'fromCharCode'; }; String[q(0)] = ${FCC}; } setup();`,
  'a key that adds a counter and a number': `var T = [Math, String]; var i = 0; T[i + 1].fromCharCode = ${FCC};`,
  'a key that adds two counters': `var T = [Math, Math, String]; var i = 1, j = 1; T[i + j].fromCharCode = ${FCC};`,
  'a key that appends a number to a counter': `var T = [Math, String]; var i = 0; i += 1; T[i].fromCharCode = ${FCC};`,
  'a numeric key of an object literal': `var o = { 0: String }; o[0].fromCharCode = ${FCC};`,
  'a numeric key of an object literal past the first': `var o = { 0: Math, 1: String }; o[1].fromCharCode = ${FCC};`,
  'an own call method of a literal holder': `function fn(tag, K) { K.fromCharCode = ${FCC}; } var api = { call: fn }; api.call('x', String);`,
  'an own apply method of a literal holder': `function fn(tag, K) { K.fromCharCode = ${FCC}; } var api = { apply: fn }; api.apply('x', String);`,
  'an own call method of a literal in callee position': `function fn(tag, K) { K.fromCharCode = ${FCC}; } ({ call: fn }).call('x', String);`,
  'an own call method of an instance': `function fn(tag, K) { K.fromCharCode = ${FCC}; } function Api() {} Api.prototype.call = fn; new Api().call('x', String);`,
};

describe('a key or a callee read the way the program reads it', () => {
  for (const [what, write] of Object.entries(WRITES)) {
    it(`refuses the decoder at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe(PRINTS_REPLACED);
      for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder, `${what} at ${preset}`).toBeUndefined();
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('still joins a number onto a string, and reads a numeric key that names nothing', async () => {
    const source = `var T = { fromCharCode1: Math, fromCharCode: String }; var i = 1; T['fromCharCode' + i].custom = 1; var U = [Math, String]; var j = 0; U[j + 5] = String;${DECODER_CHARS}`;
    expect(execute(source)).toBe(PRINTS_CHARS);
    for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder?.decode([0]), preset).toBe('ünï');
    await expectSameBehaviourEverywhere(source);
  });

  it('still reads a function called through Function.prototype.call as itself', async () => {
    const source = `function fn(K) { K.custom = 1; } fn.call(null, String);${DECODER_CHARS}`;
    expect(execute(source)).toBe(PRINTS_CHARS);
    for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder?.decode([0]), preset).toBe('ünï');
    await expectSameBehaviourEverywhere(source);
  });
});
