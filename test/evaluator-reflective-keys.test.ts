import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder, type DecoderRefusal } from '../src/analysis/evaluator/index.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * K (round sixteen): a reflective call under a method the tree cannot
 * read, `Object[k](o)`, read for what its arguments and its key say.
 *
 * Round fifteen's C3 rule made every such call a may-write of every
 * property of every argument, which is right for `Object[k](String
 * .prototype, d)` and wrong for what obfuscator.io does to every program:
 * `Object.keys(map)` becomes `Object[w(0x1)](map)` with `w` a wrapper of
 * the decoder itself. The evaluator could not read the key - the wrapper
 * is not among the decoder's names - deferred the write for a later
 * round to inline, and the decoder waited on its own wrapper for the rest
 * of the run: 0 strings at every preset, an info line for company.
 *
 * Three rules replace it, every one executed here at every preset:
 *
 *  (a) FRESH ARGUMENTS ARE NEVER A BUILTIN. A `new` of a host constructor,
 *      a literal, `Object.create(...)`, `Array.from(...)`, what a fixed
 *      function of the file returns, a nested `Object[k](...)` - no
 *      builtin's property is reachable through them, so the call writes
 *      nothing the decoder reads whatever `k` spells. And a reflective
 *      method writes its FIRST argument alone, and given one argument
 *      writes nothing a program can name. Only positive evidence - a
 *      global, the global object, a prototype, an alias of one - makes the
 *      call a may-write, and an argument the tree cannot read is the
 *      preset's call: conservative refuses, naming the call and its line;
 *      balanced takes the mainstream reading, `Object.keys(x)` on a
 *      program value, without a line per call.
 *  (b) A KEY COMPUTED BY THE CANDIDATE ITSELF IS READABLE. `Object[dec(0)]
 *      (o)`, `Object[w(0)](o)` over a wrapper of `dec`: the key is put to
 *      the decoder's own tier, and the call judged for what it spells - a
 *      read, or `Object.assign(String, ...)`, refused as any named write.
 *  (c) A DEFERRAL NEVER ENDS SILENT. A key computed by a call the round
 *      cannot read and the candidate does not own is still deferred, and
 *      the deferral is a warning naming the write, its line and the call:
 *      the strings stage does not run again once a round changes nothing,
 *      and a table left encoded is a refusal, not an info line.
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
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  const sandbox: Record<string, unknown> = { log };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 2_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;
type Preset = (typeof PRESETS)[number];

/** Deobfuscate at every preset and prove each output does what the input does. */
async function expectSameBehaviourEverywhere(
  source: string,
  options: DeobfuscateOptions = {},
): Promise<Record<Preset, Awaited<ReturnType<typeof deobfuscate>>>> {
  const before = execute(source);
  const outputs = {} as Record<Preset, Awaited<ReturnType<typeof deobfuscate>>>;
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { ...options, preset });
    expect(execute(result.code), preset).toBe(before);
    outputs[preset] = result;
  }
  return outputs;
}

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

const WRITE_NOTE = 'the program assigns to';
const HELPER_NOTE = "Taking the program's assignment to";
const DEFERRED = 'is computed by a call to';

/** A value the tree cannot read that runs to the word: the key the C3 shapes use. */
const OPAQUE = (word: string): string => `String([...'${word}'].join(''))`;

/** A decoder that reads `parseInt`, which a write of every property of `globalThis` may replace. */
const DECODER = `
var t = ['keys', 'ünï', 'plain'];
function dec(i) { return t[parseInt(i, 16)]; }
function w(i) { return dec(i); }
`;
const FCC = "function () { return 'Z'; }";

/** Build `dec` at a preset and expect it decoded with nothing said about a write. */
function expectClean(source: string, preset: Preset, what: string): void {
  const { decoder, notes } = build(source, ['dec', 't'], { preset });
  expect(decoder?.decode(['1']), `${what} at ${preset}`).toBe('ünï');
  const said = notes.filter((note) => note.message.includes(WRITE_NOTE) || note.message.includes(HELPER_NOTE) || note.message.includes(DEFERRED));
  expect(said.map((note) => note.message), `${what} at ${preset}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// (a) Fresh arguments are never a builtin
// ---------------------------------------------------------------------------

/** `Object[k](o)` with `k` a value the tree cannot read and `o` a fresh value: decoded at every preset. */
const FRESH: Record<string, string> = {
  'a Map': `var o = new Map(); log(Object[k](o).length);`,
  'a Set': `var o = new Set([1]); log(Object[k](o).length);`,
  'a Map under the global object': `var o = new globalThis.Map(); log(Object[k](o).length);`,
  'a Date': `var o = new Date(0); log(Object[k](o).length);`,
  'an object literal': `var o = { a: 1 }; log(Object[k](o).length);`,
  'an array literal': `var o = [1, 2]; log(Object[k](o).length);`,
  'Object.create(null)': `var o = Object.create(null); o.a = 1; log(Object[k](o).length);`,
  'Array.from': `var o = Array.from('ab'); log(Object[k](o).length);`,
  'JSON.parse': `var o = JSON.parse('{"a":1}'); log(Object[k](o).length);`,
  'what a fixed function returns': `function mk() { return { a: 1 }; } var o = mk(); log(Object[k](o).length);`,
  'a nested reflective call': `var o = { a: 1 }; log(Object[k](Object[k](o)).length);`,
  'a parameter handed a literal': `function count(o) { return Object[k](o).length; } log(count({ a: 1 }));`,
  'a member of a literal': `var s = { props: { a: 1 } }; log(Object[k](s.props).length);`,
  'a local assigned twice, from literals': `var o = { a: 1 }; o = { b: 2, c: 3 }; log(Object[k](o).length);`,
  'a fresh target with more arguments': `var o = new Map(); log(Object[k](o, { a: 1 }, { b: 2 }).size);`,
  'a fresh target with a builtin as a source': `var o = {}; log(Object[k](o, String).length);`,
};

describe('(a) a reflective call under an unread method on a fresh argument writes nothing the decoder reads', () => {
  for (const [what, program] of Object.entries(FRESH)) {
    it(`decodes at every preset for ${what}`, async () => {
      const source = `var k = ${OPAQUE('keys')};\n${program}\n${DECODER}log(w('1'));`;
      expect(execute(source)).not.toContain('THROWN');
      for (const preset of PRESETS) expectClean(source, preset, what);
      const outputs = await expectSameBehaviourEverywhere(source);
      for (const preset of PRESETS) expect(outputs[preset].metadata.strings.length, preset).toBeGreaterThan(0);
    });
  }

  it('is no reflective route through what it gives back: `Object[k](o)[j](...)` is a method of `o`, its prototype or a fresh value', async () => {
    // `Object.keys(o).join(',')`, `Object.entries(o).reduce(...)`: round
    // fifteen read the callee as the member `Object[*][*]`, a reflective
    // method through `.call`, and every argument as may-written.
    const shapes: Record<string, string> = {
      'a fresh object': `var o = { a: 1 }; log(Object[k](o)[j](','));`,
      'a Map': `var o = new Map(); log(Object[k](o)[j](','));`,
      'a parameter the tree cannot read': `function f(x) { return Object[k](x)[j](','); } [f].forEach(function (g) { log(g({ a: 1 })); });`,
      'with a function of the file as the argument': `function cb(a, b) { return a + b; } var o = { a: 1 }; log(Object[k](o)[j](cb, ''));`,
    };
    for (const [what, program] of Object.entries(shapes)) {
      const source = `var k = ${OPAQUE('keys')}; var j = ${OPAQUE('join')};\n${program}\n${DECODER}log(w('1'));`;
      expect(execute(source), what).not.toContain('THROWN');
      for (const preset of PRESETS) expectClean(source, preset, what);
      await expectSameBehaviourEverywhere(source);
    }
    // `Object` itself given back - `Object.freeze(Object)` - is the route it always was.
    const through = `var k = ${OPAQUE('freeze')}; var j = ${OPAQUE('assign')};\nvar d = {}; d[${OPAQUE('parseInt')}] = ${FCC};\nObject[k](Object)[j](globalThis, d);\n${DECODER}log(w('1'));`;
    expect(execute(through)).toBe('undefined');
    const conservative = build(through, ['dec', 't'], { preset: 'conservative' });
    expect(conservative.decoder).toBeUndefined();
    expect(conservative.notes.map((note) => note.message)).toContainEqual(expect.stringContaining(WRITE_NOTE));
    const result = await deobfuscate(through, { preset: 'conservative' });
    expect(execute(result.code)).toBe('undefined');
  });

  it('is a read of its one argument whatever the method: a single argument writes nothing', async () => {
    // Every writer on `Object` and `Reflect` writes its first argument and
    // reads the rest; given one argument, `assign` copies nothing and the
    // others throw. So the argument may be anything at all.
    const shapes: Record<string, string> = {
      'the global object': `log(typeof Object[k](globalThis));`,
      'a builtin': `log(typeof Object[k](String));`,
      'a parameter the tree cannot read': `function f(x) { return typeof Object[k](x); } [f].forEach(function (g) { log(g({ a: 1 })); });`,
      'Reflect on a builtin': `var r = ${OPAQUE('ownKeys')}; log(typeof Reflect[r](String));`,
    };
    for (const [what, program] of Object.entries(shapes)) {
      const source = `var k = ${OPAQUE('keys')};\n${program}\n${DECODER}log(w('1'));`;
      for (const preset of PRESETS) expectClean(source, preset, what);
      await expectSameBehaviourEverywhere(source);
    }
  });

  it('keeps the may-write for an argument with positive evidence of a builtin', async () => {
    // The C3 shapes: the argument IS the builtin, or reaches one.
    const evidence: Record<string, string> = {
      'the global object': `var o = {}; o[${OPAQUE('parseInt')}] = ${FCC}; Object[k](globalThis, o);`,
      'a builtin, through Object': `var o = {}; o[${OPAQUE('parseInt')}] = ${FCC}; Object[k](new Object(globalThis), o);`,
      'a builtin, through a Proxy': `var o = {}; o[${OPAQUE('parseInt')}] = ${FCC}; Object[k](new Proxy(globalThis, {}), o);`,
      'an alias of the global object': `var g = globalThis; var o = {}; o[${OPAQUE('parseInt')}] = ${FCC}; Object[k](g, o);`,
    };
    for (const [what, program] of Object.entries(evidence)) {
      const source = `var k = ${OPAQUE('assign')};\n${program}\n${DECODER}log(w('1'));`;
      // The replacement returns 'Z', so the decoder reads t['Z']: what the
      // program prints is not the table's entry.
      expect(execute(source), what).toBe('undefined');
      const conservative = build(source, ['dec', 't'], { preset: 'conservative' });
      expect(conservative.decoder, what).toBeUndefined();
      expect(conservative.notes.map((note) => note.message), what).toContainEqual(expect.stringContaining(WRITE_NOTE));
      // The unread policy, as for every C3 shape: balanced takes the write
      // for a helper and says so, which is the disclosed drift the preset
      // documents; conservative's output is the program's.
      const balanced = build(source, ['dec', 't'], { preset: 'balanced' });
      expect(balanced.notes.map((note) => note.message), what).toContainEqual(expect.stringContaining(HELPER_NOTE));
      const result = await deobfuscate(source, { preset: 'conservative' });
      expect(execute(result.code), what).toBe('undefined');
    }
  });

  it('refuses at conservative, naming the call and its line, and takes the mainstream reading quietly at balanced, for an argument the tree cannot read', async () => {
    // `x` is the parameter of a function handed on as a value, so its
    // callers are not all in view. Two arguments, so the call may write.
    const source = `var k = ${OPAQUE('keys')};
function f(x) { return Object[k](x, { b: 2 }).length; }
[f].forEach(function (g) { log(g({ a: 1 })); });
${DECODER}log(w('1'));`;
    expect(execute(source)).toBe('1\n"ünï"');
    const conservative = build(source, ['dec', 't'], { preset: 'conservative' });
    expect(conservative.decoder).toBeUndefined();
    const refusal = conservative.notes.find((note) => note.message.includes(WRITE_NOTE));
    expect(refusal?.severity).toBe('warning');
    expect(refusal?.message).toMatch(/assigns to `Object\[...\]\(x, \{...\}\)` at line 2/);
    for (const preset of ['balanced', 'aggressive'] as const) {
      const { decoder, notes } = build(source, ['dec', 't'], { preset });
      expect(decoder?.decode(['1']), preset).toBe('ünï');
      expect(notes.filter((note) => note.message.includes(HELPER_NOTE) || note.message.includes(WRITE_NOTE)), preset).toEqual([]);
    }
    const outputs = await expectSameBehaviourEverywhere(source);
    expect(outputs.conservative.metadata.strings).toHaveLength(0);
    expect(outputs.conservative.metadata.diagnostics.some((d) => d.severity === 'warning' && d.message.includes(WRITE_NOTE))).toBe(true);
    expect(outputs.balanced.metadata.strings.length).toBeGreaterThan(0);
  });

  it('is a builtin again through `new Object(x)` and `new Proxy(x, h)`', () => {
    // The two host constructors that give back what they were handed;
    // every other `new` is a fresh object.
    const write = `var d = { parseInt: ${FCC} };`;
    for (const made of ['new Object(globalThis)', 'new Proxy(globalThis, {})']) {
      const source = `${write}\nvar target = ${made};\nObject.assign(target, d);\n${DECODER}log(w('1'));`;
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['dec', 't'], { preset });
        expect(decoder, `${made} at ${preset}`).toBeUndefined();
        expect(notes.map((note) => note.message), `${made} at ${preset}`).toContainEqual(expect.stringContaining(WRITE_NOTE));
      }
    }
    const fresh = `${write}\nvar target = new Map();\nObject.assign(target, d);\n${DECODER}log(w('1'));`;
    for (const preset of PRESETS) expectClean(fresh, preset, 'new Map()');
  });
});

// ---------------------------------------------------------------------------
// (b) A key computed by the candidate itself is readable
// ---------------------------------------------------------------------------

/** `Object[<own key>](o)`: the candidate's own tier reads the key. */
const OWN_KEY: Record<string, string> = {
  'the decoder itself': `var o = new Map(); log(Object[dec('0')](o).length);`,
  'a wrapper of the decoder': `var o = new Map(); log(Object[w('0')](o).length);`,
  'a wrapper of a wrapper': `function w2(a, b) { return w(b); } var o = new Map(); log(Object[w2(9, '0')](o).length);`,
  'a wrapper with arithmetic': `function w3(a) { return dec(a - 0x10); } var o = new Map(); log(Object[w3(0x10)](o).length);`,
  'an argument the tree cannot read': `function f(x) { return Object[w('0')](x, { b: 2 }).length; } [f].forEach(function (g) { log(g({ a: 1 })); });`,
  'the global object, read': `log(typeof Object[w('0')](globalThis, {}));`,
  'a nested pair, both keys the decoder’s': `var t2 = ['entries']; function e(i) { return t2[i]; } var o = { a: 1 }; log(Object[w('0')](Object[w('0')](o)).length);`,
};

describe('(b) a key computed by the decoder being built, or a wrapper of it, is read with its own tier', () => {
  for (const [what, program] of Object.entries(OWN_KEY)) {
    it(`decodes at every preset for ${what}`, async () => {
      const source = `${DECODER}${program}\nlog(w('1'));`;
      expect(execute(source)).not.toContain('THROWN');
      for (const preset of PRESETS) expectClean(source, preset, what);
      const outputs = await expectSameBehaviourEverywhere(source);
      for (const preset of PRESETS) {
        expect(outputs[preset].metadata.strings.length, preset).toBeGreaterThan(0);
        expect(outputs[preset].code, preset).toContain('Object.keys(');
        expect(outputs[preset].metadata.diagnostics.filter((d) => d.severity === 'warning'), preset).toEqual([]);
      }
    });
  }

  it('reads the key for obfuscator.io’s self-replacing decoder, whose binding the scope reads to two functions', async () => {
    const source = `var t = ['keys', 'ünï'];
function dec(a, b) { dec = function (c) { return t[parseInt(c, 16)]; }; return dec(a, b); }
function w(i) { return dec(i); }
var o = new Map();
log(Object[w('0')](o).length, w('1'));`;
    expect(execute(source)).toBe('0 "ünï"');
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, ['dec', 't'], { preset });
      expect(decoder?.decode(['1']), preset).toBe('ünï');
      expect(notes.filter((note) => note.message.includes(WRITE_NOTE) || note.message.includes(DEFERRED)), preset).toEqual([]);
    }
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const preset of PRESETS) expect(outputs[preset].code, preset).toContain('Object.keys(');
  });

  it('judges the call it spells, now: `assign` of a builtin the decoder reads is refused at every preset', async () => {
    // The key reads to `assign`, the target is the global object, and the
    // holder carries `parseInt`: the write the decoder's own key spells
    // out reaches what the decoder reads, and no preset takes it.
    const source = `var t = ['assign', 'ünï', 'parseInt'];
function dec(i) { return t[parseInt(i, 16)]; }
function w(i) { return dec(i); }
var o = {}; o[w('2')] = ${FCC};
Object[w('0')](globalThis, o);
log(w('1'));`;
    // The replacement returns 'Z', so the decoder reads t['Z']: what the
    // program prints is not the table's entry.
    expect(execute(source)).toBe('undefined');
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, ['dec', 't'], { preset });
      expect(decoder, preset).toBeUndefined();
      const refusal = notes.find((note) => note.message.includes(WRITE_NOTE));
      expect(refusal?.message, preset).toMatch(/assigns to `Object\[...\]\(globalThis, ..., ...\)` at line 5/);
      expect(refusal?.message, preset).not.toContain('the conservative preset inlines only what is proved');
      expect(notes.filter((note) => note.message.includes(DEFERRED)), preset).toEqual([]);
    }
    await expectSameBehaviourEverywhere(source);
  });

  it('leaves a key a wrapper of ANOTHER decoder computes to the round that inlines it', () => {
    // `v` is a wrapper of `dec2`, not of `dec`: nothing `dec`'s tier can
    // read, and a later round - once `dec2` is adopted - spells it out.
    const source = `${DECODER}var t2 = ['assign', 'parseInt'];
function dec2(i) { return t2[parseInt(i, 16)]; }
function v(i) { return dec2(i); }
var o = {}; o[v('1')] = ${FCC};
Object[v('0')](globalThis, o);
log(w('1'));`;
    for (const preset of PRESETS) {
      const { decoder, refusals, notes } = build(source, ['dec', 't'], { preset });
      expect(decoder, preset).toBeUndefined();
      expect(refusals, preset).toEqual(['unread-key']);
      expect(notes.map((note) => note.message), preset).toContainEqual(expect.stringContaining('is computed by a call to v, which this round cannot read'));
    }
  });
});

// ---------------------------------------------------------------------------
// (c) A deferral never ends silent
// ---------------------------------------------------------------------------

describe('(c) a deferred write the run never reads ends in a warning, not an info line', () => {
  // `v` reads the global object, which no slice may, so its call is a key
  // the round cannot read and never will; the target is the global object,
  // so the call may write `parseInt`, which `dec` reads. The program runs
  // as written at every preset - `Object.keys(globalThis, o)` - with the
  // table left encoded, and the reader is owed a warning that names what
  // stood in the way.
  const source = `globalThis.KEY = 'keys';
function v(i) { return globalThis.KEY.slice(i); }
var t = ['keys', 'ünï'];
function dec(i) { return t[parseInt(i, 16)]; }
function w(i) { return dec(i); }
var o = { a: 1 };
log(Object[v(0)](globalThis, o).length > 0, w('1'));`;

  it('is deferred with the write, its line and the call named, at warning severity, at every preset', async () => {
    expect(execute(source)).toBe('true "ünï"');
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const preset of PRESETS) {
      const result = outputs[preset];
      expect(result.metadata.strings, preset).toHaveLength(0);
      const deferred = result.metadata.diagnostics.filter((d) => d.message.startsWith('Deferred dec:'));
      expect(deferred, preset).toHaveLength(1);
      expect(deferred[0]!.severity, preset).toBe('warning');
      expect(deferred[0]!.message, preset).toMatch(
        /^Deferred dec: the key of `Object\[...\]\(globalThis, ..., ...\)` at line 7 is computed by a call to v, which this round cannot read/,
      );
      expect(deferred[0]!.message, preset).toContain('left as written if none changes that');
    }
  });

  it('keeps the info line for a deferral for want of a sample, which decides nothing against the candidate', async () => {
    const unsampled = `var t = ['keys', 'ünï'];
function dec(i) { return t[parseInt(i, 16)]; }
function show(i) { log(dec(i)); }
show('1');`;
    const result = await deobfuscate(unsampled, { preset: 'conservative' });
    expect(execute(result.code)).toBe(execute(unsampled));
    const deferred = result.metadata.diagnostics.filter((d) => d.message.startsWith('Deferred dec:'));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.severity).toBe('info');
  });
});
