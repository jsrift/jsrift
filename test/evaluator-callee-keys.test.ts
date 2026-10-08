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
 * The round-fourteen work on the host-write index: one callee normaliser
 * and one key reader, and the shapes that fell through the per-spelling
 * code they replace.
 *
 * Three rounds running, the differential fuzz found the same defect one
 * spelling away from the one just closed - a `.call` where a direct call
 * was handled, `[f][0]` where `f` was, a holder passed by name where the
 * literal was read. Each shape here is executed: the input and each
 * preset's output run in a realm holding nothing but `log`, and the traces
 * must match; a write the tree can read is refused at every preset, and a
 * fresh object is nobody's builtin at any of them.
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
type Preset = (typeof PRESETS)[number];

/** Deobfuscate at every preset and prove each output does what the input does. */
async function expectSameBehaviourEverywhere(
  source: string,
  options: DeobfuscateOptions = {},
): Promise<Record<Preset, { code: string; strings: number; diagnostics: string[] }>> {
  const before = execute(source);
  const outputs = {} as Record<Preset, { code: string; strings: number; diagnostics: string[] }>;
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { ...options, preset });
    expect(execute(result.code), preset).toBe(before);
    outputs[preset] = {
      code: result.code,
      strings: result.metadata.strings.length,
      diagnostics: result.metadata.diagnostics.map((diagnostic) => diagnostic.message),
    };
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

const DECODER_ROUND = `
var table = ['alpha', 'beta', 'gamma'];
function dec(i) { return table[Math.round(i)]; }
log(dec(0), dec(1));
`;

const DECODER_UTF8 = `
var table = ['%C3%BCn%C3%AF', 'plain', 'other'];
function dec(i) { return decodeURIComponent(table[i]); }
log(dec(0), dec(1));
`;

const FCC = "function () { return 'Z'; }";
const SPL = "function () { return ['90']; }";
const PRINTS_CHARS = '"ünï" "plain"';
const PRINTS_ROUND = '"alpha" "beta"';
const PRINTS_UTF8 = '"ünï" "plain"';

/** A key no pass folds and the index cannot read: `[...'split'].join('')` is `'split'` at run time, and a spread is a part the tree cannot read. */
const OPAQUE = (word: string): string => `String([...'${word}'].join(''))`;

/** The decoder decodes at every preset, and no note calls the write a host write. */
function expectDecoded(source: string, roots: string[], sample: number, value: string, what?: string): void {
  for (const preset of PRESETS) {
    const { decoder, notes } = build(source, roots, { preset });
    expect(decoder?.decode([sample]), `${what ?? source} at ${preset}`).toBe(value);
    expect(
      notes.filter((note) => note.message.includes(WRITE_NOTE) || note.message.startsWith(HELPER_NOTE)).map((note) => note.message),
      `${what ?? source} at ${preset}`,
    ).toEqual([]);
  }
}

/** The decoder is refused at every preset, the refusal naming the write and saying `reason`. */
function expectRefused(source: string, roots: string[], reason: string, what?: string): void {
  for (const preset of PRESETS) {
    const { decoder, notes } = build(source, roots, { preset });
    expect(decoder, `${what ?? source} at ${preset}`).toBeUndefined();
    const refusal = notes.find((note) => note.message.includes(WRITE_NOTE));
    expect(refusal?.message, `${what ?? source} at ${preset}`).toContain(reason);
    expect(refusal?.message, `${what ?? source} at ${preset}`).not.toContain('the conservative preset inlines only what is proved');
  }
}

const MAY = 'may not be the builtin every tier would run';
const IS = 'is not the builtin every tier would run';
const SPLIT_IS = 'the split the slice reads on a value is not the builtin';

// ---------------------------------------------------------------------------
// R: a fresh object is nobody's builtin
// ---------------------------------------------------------------------------

/**
 * The round-twelve fix that reads a builtin written through a reflective
 * call recorded the keys of `Object.assign(X, s1, s2)` as though they were
 * a member chain `X.k1.k2`, so `Object.assign({}, j, JSON.parse(...))` - a
 * fresh `{}` and two sources the tree cannot read - was the chain
 * `{}[*][*] = ...`, which the prototype rule for `''[k].split = ...` took for a
 * write to some prototype, and conservative refused every decoder in the
 * file. The same reading made `Object.assign(String, { a: 1, fromCharCode:
 * ... })` the chain `String.a.fromCharCode`, which reaches nothing, and was
 * silent at every preset. And an alias resolved into a literal it holds
 * consumed the write's last key, so `var o = { S: String }; o.S = 5` was
 * "a write to String", and `rc[i] = rc[j]` over an array holding a value
 * the tree cannot read was a write to that value.
 */
describe('R: a fresh object is nobody’s builtin', () => {
  const FRESH: Record<string, string> = {
    'Object.assign on a fresh literal with two unreadable sources':
      'function qw() { return Object.assign({}, j, JSON.parse(JSON.stringify(w0))); }',
    'Object.assign on a fresh literal with three unreadable sources':
      'function qw() { return Object.assign({}, j, k, JSON.parse(JSON.stringify(w0))); }',
    'Object.assign on a fresh literal, spread twice':
      'function qw() { return { ...{ ...Object.assign({}, j, JSON.parse(JSON.stringify(w0))) } }; }',
    'Object.assign on a fresh array literal': 'function qw() { return Object.assign([], j, k); }',
    'an element swap over a local array literal holding an unreadable call chain':
      "var rc = [JSON.stringify(['say']).substr(5, -1)]; for (var i = 0, j = rc.length - 1; i < j; i++, j--) { rc[i] = rc[j]; }",
    'an element swap over a local array holding an unknown call result':
      'var rc = [load(), load()]; for (var i = 0, j = rc.length - 1; i < j; i++, j--) { rc[i] = rc[j]; }',
    'a write to the slot of a literal holding the builtin': 'var o = { S: String }; o.S = 5;',
    'a write to the element of a literal holding the builtin': 'var rc = [String]; rc[0] = 5;',
    'a delete of the slot of a literal holding the builtin': 'var o = { S: String }; delete o.S;',
    'a fresh object built from unreadable sources, then written': 'var x = Object.assign({}, j); x.fromCharCode = 0;',
    // Babel lists a declaration in a loop body as its own violation; the
    // function is never called, so its parameter is only its default.
    'a parameter defaulting to a literal, of a function declared in a for body and never called':
      'var f = String; for (var i = 0; i < 2; i++) { function fn(f = {}) { f.fromCharCode = 0; } }',
    'a parameter defaulting to a literal, of a function declared in a while body and never called':
      'var f = String; while (false) { function fn(f = {}) { f.fromCharCode = 0; } }',
    'a control: one unreadable source': 'function qw() { return Object.assign({}, j); }',
    'a control: a literal source': 'function qw() { return Object.assign({}, { a: 1 }); }',
  };
  for (const [what, write] of Object.entries(FRESH)) {
    it(`decodes at every preset beside ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expectDecoded(source, ['dec', 'table'], 1, 'plain', what);
      const outputs = await expectSameBehaviourEverywhere(source);
      for (const preset of PRESETS) expect(outputs[preset].strings, preset).toBeGreaterThan(0);
    });
  }

  it('decodes the element swap javascript-obfuscator emits with its default options, at conservative', async () => {
    // `var rc = [JSON.stringify(["say"]).substr(5, -1)]; for (...) { rc[i] = rc[j]; } log(rc.join("|"));`
    // obfuscated with javascript-obfuscator's defaults. The element swap is not a
    // second source of `rc`, and "rc is assigned from more than one source and
    // cannot be read" refused every string at conservative.
    const source = String.raw`var _0x40e9b1=_0x4062;function _0x4062(_0x3c0376,_0x49de45){_0x3c0376=_0x3c0376-0xaf;var _0x77e342=_0x77e3();var _0x406229=_0x77e342[_0x3c0376];return _0x406229;}(function(_0x77fb2c,_0x494cd4){var _0x523602=_0x4062,_0x1bcdad=_0x77fb2c();while(!![]){try{var _0x1f25eb=parseInt(_0x523602(0xb9))/0x1*(parseInt(_0x523602(0xb0))/0x2)+-parseInt(_0x523602(0xb4))/0x3+-parseInt(_0x523602(0xb6))/0x4*(-parseInt(_0x523602(0xb5))/0x5)+parseInt(_0x523602(0xb8))/0x6+parseInt(_0x523602(0xb2))/0x7*(parseInt(_0x523602(0xbb))/0x8)+parseInt(_0x523602(0xba))/0x9*(parseInt(_0x523602(0xb7))/0xa)+-parseInt(_0x523602(0xb3))/0xb;if(_0x1f25eb===_0x494cd4)break;else _0x1bcdad['push'](_0x1bcdad['shift']());}catch(_0x3c7217){_0x1bcdad['push'](_0x1bcdad['shift']());}}}(_0x77e3,0xc2da3));var rc=[JSON[_0x40e9b1(0xb1)]([_0x40e9b1(0xaf)])['substr'](0x5,-0x1)];function _0x77e3(){var _0x2db614=['say','20fWZcTL','stringify','2387ncAAho','23281313SbjnBk','2044047gsCzuq','97115JiKdWe','132AhnhvK','8017730TQfRzS','5688036PfbrSl','72815xJJepC','9RqYHHT','11192srHdar','join'];_0x77e3=function(){return _0x2db614;};return _0x77e3();}for(var i=0x0,j=rc['length']-0x1;i<j;i++,j--){rc[i]=rc[j];}log(rc[_0x40e9b1(0xbc)]('|'));`;
    expect(execute(source)).toBe('""');
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const preset of PRESETS) {
      expect(outputs[preset].strings, preset).toBeGreaterThan(0);
      expect(outputs[preset].code, preset).toMatch(/JSON\.stringify\(\[['"]say['"]\]\)/);
      expect(outputs[preset].diagnostics.filter((message) => message.includes(WRITE_NOTE)), preset).toEqual([]);
    }
  });

  const SEVERAL_KEYS: Record<string, string> = {
    'Object.assign with the read key second in the literal': `Object.assign(String, { a: 1, fromCharCode: ${FCC} });`,
    'Object.assign with the read key in the second source': `Object.assign(String, { a: 1 }, { fromCharCode: ${FCC} });`,
    'Object.assign with the read key third, after two others': `Object.assign(String, { a: 1, b: 2, fromCharCode: ${FCC} });`,
    'Object.defineProperties with the read key second': `Object.defineProperties(String, { a: { value: 1 }, fromCharCode: { value: ${FCC} } });`,
    'Object.assign on the prototype with the read key second': `Object.assign(String.prototype, { a: 1, split: ${SPL} });`,
    'Object.assign on the global object with the read key second': `Object.assign(globalThis, { a: 1, String: { fromCharCode: ${FCC} } });`,
  };
  for (const [what, write] of Object.entries(SEVERAL_KEYS)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).not.toBe(PRINTS_CHARS);
      for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder, preset).toBeUndefined();
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('keeps the prototype reading for a literal’s member the tree cannot read, then a write', () => {
    // `''[k].split = ...` is a read hop off a literal and then a write, which
    // may be `''.__proto__.split`; the reflective keys above are not a chain.
    const source = `var k = ${OPAQUE('__proto__')}; ''[k].split = ${SPL};${DECODER_CHARS}`;
    expect(build(source, ['dec', 'table'], { preset: 'conservative' }).decoder).toBeUndefined();
    const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
    expect(balanced.decoder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U1: one callee normaliser
// ---------------------------------------------------------------------------

/**
 * A fixed function `f(K)` writes `K.fromCharCode`, and the program hands it
 * `String` by every route `invocation` sees through and every alias
 * `originOf` follows. Each was silent at every preset while the hand-off was
 * read per spelling - a direct call handled, `f?.()` not; `f` handled,
 * `[f][0]` not; `o.f(String)` handled, `var m = o.f; m(String)` not.
 */
const WRITES_K = `function f(K) { K.fromCharCode = ${FCC}; }`;

const ROUTES: Record<string, string> = {
  'an optional call': `${WRITES_K} f?.(String);`,
  'an optional .call': `${WRITES_K} f?.call(null, String);`,
  'a call through .call with an optional member': `${WRITES_K} f.call?.(null, String);`,
  'a literal array in callee position': `${WRITES_K} [f][0](String);`,
  'a literal object in callee position': `${WRITES_K} ({ d: f }).d(String);`,
  'a literal array two deep': `${WRITES_K} [[f]][0][0](String);`,
  'a conditional in callee position, either arm': `${WRITES_K} function g() {} (globalThis.K ? g : f)(String);`,
  'a logical in callee position': `${WRITES_K} function g() {} (globalThis.K || f)(String);`,
  'a function expression handed to an IIFE, then called': `${WRITES_K} (function (h) { h(String); })(f);`,
  'a function handed to a fixed function, then called': `${WRITES_K} function run(h) { h(String); } run(f);`,
  'arrows on both sides': `var f = (K) => { K.fromCharCode = ${FCC}; }; var run = (h) => h(String); run(f);`,
  'a function handed on twice': `${WRITES_K} function run(h) { go(h); } function go(h) { h(String); } run(f);`,
  'a function expression handed to a fixed function': `function run(h) { h(String); } run(function (K) { K.fromCharCode = ${FCC}; });`,
  'a method pulled off its holder': `var o = { f: function (K) { K.fromCharCode = ${FCC}; } }; var m = o.f; m(String);`,
  'a method pulled off its holder by destructuring': `var o = { f(K) { K.fromCharCode = ${FCC}; } }; var { f: m } = o; m(String);`,
  'this.f inside a literal method': `var o = { f(K) { K.fromCharCode = ${FCC}; }, run() { this.f(String); } }; o.run();`,
  'this.f inside a literal property function': `var o = { f: function (K) { K.fromCharCode = ${FCC}; }, run: function () { this.f(String); } }; o.run();`,
  'this.f inside a class static': `class U { static f(K) { K.fromCharCode = ${FCC}; } static run() { this.f(String); } } U.run();`,
  'a class static pulled off': `class U { static f(K) { K.fromCharCode = ${FCC}; } } var m = U.f; m(String);`,
  'a class instance method': `class U { f(K) { K.fromCharCode = ${FCC}; } } new U().f(String);`,
  'a class instance method through this': `class U { f(K) { K.fromCharCode = ${FCC}; } run() { this.f(String); } } new U().run();`,
  'a prototype method of a function constructor': `function U() {} U.prototype.f = function (K) { K.fromCharCode = ${FCC}; }; new U().f(String);`,
  'a prototype method through an instance a name holds': `function U() {} U.prototype.f = function (K) { K.fromCharCode = ${FCC}; }; var u = new U(); u.f(String);`,
  'a prototype replaced by a literal': `function U() {} U.prototype = { f(K) { K.fromCharCode = ${FCC}; } }; new U().f(String);`,
  'a prototype method through this in another': `function U() {} U.prototype.f = function (K) { K.fromCharCode = ${FCC}; }; U.prototype.run = function () { this.f(String); }; new U().run();`,
  'a method assigned to a holder after the literal': `var o = {}; o.f = function (K) { K.fromCharCode = ${FCC}; }; o.f(String);`,
  'a method assigned to a holder, then this.f': `var o = {}; o.f = function (K) { K.fromCharCode = ${FCC}; }; o.run = function () { this.f(String); }; o.run();`,
  'a function declared twice, the last one called': `function f() {} function f(K) { K.fromCharCode = ${FCC}; } f(String);`,
  'an alias declared inside the fixed function': `function f(K) { var L = K; L.fromCharCode = ${FCC}; } f(String);`,
  'a const alias inside the fixed function': `function f(K) { const L = K; L.fromCharCode = ${FCC}; } f(String);`,
  'a let assigned inside the fixed function': `function f(K) { let L; L = K; L.fromCharCode = ${FCC}; } f(String);`,
  'an alias of an alias inside the fixed function': `function f(K) { var L = K, M = L; M.fromCharCode = ${FCC}; } f(String);`,
  'an alias inside, handed an alias outside': `var S = String; function f(K) { var L = K; L.fromCharCode = ${FCC}; } f(S);`,
  'an alias inside, beside a read of the parameter': `function f(K) { var L = K; K.x = 1; L.fromCharCode = ${FCC}; } f(String);`,
  'an alias of what a function returns, inside': `function id(K) { return K; } function g(K) { var L = id(K); L.fromCharCode = ${FCC}; } g(String);`,
  'a global handed through an optional call to an alias': `var S = String; ${WRITES_K} f?.(S);`,
  'a function taken apart from an array literal': `${WRITES_K} var [g] = [f]; g(String);`,
  'a function taken apart from an object literal': `${WRITES_K} var { g } = { g: f }; g(String);`,
  'a method called under a key a name holds': `var o = { f: function (K) { K.fromCharCode = ${FCC}; } }; var k = 'f'; o[k](String);`,
  'a method called under a key of two readings, one of them the method': `var o = { f: function (K) { K.fromCharCode = ${FCC}; }, g() {} }; var k = globalThis.K ? 'g' : 'f'; o[k](String);`,
  'a bound argument handed through .bind': `${WRITES_K} var g = f.bind(null, String); g();`,
};

/** The builtin written through where a route puts it: a call result, a literal, a holder's getter. */
const WRITTEN_THROUGH: Record<string, string> = {
  'a literal in target position': `[String][0].fromCharCode = ${FCC};`,
  'an object literal in target position': `({ t: String }).t.fromCharCode = ${FCC};`,
  'a function returning this, called': `Function.prototype.call.call(function () { return this; }, String).fromCharCode = ${FCC};`,
  'a function returning this, applied': `(function () { return this; }).apply(String).fromCharCode = ${FCC};`,
  'a function returning this, bound': `(function () { return this; }).bind(String)().fromCharCode = ${FCC};`,
  'a function returning this, through Reflect.apply': `Reflect.apply(function () { return this; }, String, []).fromCharCode = ${FCC};`,
  'valueOf through an optional call': `var T = String?.valueOf(); T.fromCharCode = ${FCC};`,
  'a getter of a holder returning its member': `var o = { t: String, get: function () { return this.t; } }; o.get().fromCharCode = ${FCC};`,
  'a prototype method returning a name': `function U() {} U.prototype.get = function () { return T; }; var T = String; new U().get().fromCharCode = ${FCC};`,
  'a prototype read through a call result': `(function () { return this; }).call(''.__proto__).split = ${SPL};`,
  'the global object through valueOf': `var T = globalThis?.valueOf(); T.decodeURIComponent = function (s) { return 'X' + s; };`,
};

describe('U1: one callee normaliser - every route hands the builtin over', () => {
  for (const [what, write] of Object.entries(ROUTES)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
      expectRefused(source, ['dec', 'table'], IS, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  for (const [what, write] of Object.entries(WRITTEN_THROUGH)) {
    it(`refuses at every preset for a write through ${what}`, async () => {
      const utf8 = write.includes('decodeURIComponent');
      const source = `${write}${utf8 ? DECODER_UTF8 : DECODER_CHARS}`;
      expect(execute(source)).not.toBe(utf8 ? PRINTS_UTF8 : PRINTS_CHARS);
      for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder, `${what} at ${preset}`).toBeUndefined();
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('sees an await in callee position, and a bound function called nowhere is the escape', () => {
    // Not executed: the write happens in a microtask, after the trace.
    const awaited = `${WRITES_K} async function run() { (await f)(String); } run();${DECODER_CHARS}`;
    expectRefused(awaited, ['dec', 'table'], IS, 'await');
    // `f.bind(null, x)` hands `x` to the first parameter whenever the bound
    // function is called; a bound function called nowhere the tree sees is
    // the escape, and the parameter the unknown object.
    const bound = `${WRITES_K} var g = f.bind(null, Math); keep(g);${DECODER_CHARS}`;
    const balanced = build(bound, ['dec', 'table'], { preset: 'balanced' });
    expect(balanced.decoder?.decode([1])).toBe('plain');
    expect(balanced.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('K is assigned from more than one source and cannot be read'),
    );
    expect(build(bound, ['dec', 'table'], { preset: 'conservative' }).decoder).toBeUndefined();
  });

  const REFLECTIVE_ROUTES: Record<string, string> = {
    'Object.defineProperty?.()': `Object.defineProperty?.(String, 'fromCharCode', { value: ${FCC} });`,
    'Object?.defineProperty()': `Object?.defineProperty(String, 'fromCharCode', { value: ${FCC} });`,
    'Reflect.set?.()': `Reflect.set?.(String, 'fromCharCode', ${FCC});`,
    'Object.assign?.()': `Object.assign?.(String, { fromCharCode: ${FCC} });`,
    'an alias called optionally': `var d = Object.defineProperty; d?.(String, 'fromCharCode', { value: ${FCC} });`,
    '[Object.defineProperty][0]': `[Object.defineProperty][0](String, 'fromCharCode', { value: ${FCC} });`,
    '({ d: Object.defineProperty }).d': `({ d: Object.defineProperty }).d(String, 'fromCharCode', { value: ${FCC} });`,
    "Object[k] with k = 'defineProperty'": `var k = 'defineProperty'; Object[k](String, 'fromCharCode', { value: ${FCC} });`,
    "Object['defineProperty']": `Object['defineProperty'](String, 'fromCharCode', { value: ${FCC} });`,
    'an alias of Object[k]': `var k = 'defineProperty'; var d = Object[k]; d(String, 'fromCharCode', { value: ${FCC} });`,
    "Reflect[k] with k = 'set'": `var k = 'set'; var s = Reflect[k]; s(String, 'fromCharCode', ${FCC});`,
    'a descriptor held by a name': `var d = { value: ${FCC} }; Object.defineProperty(String, 'fromCharCode', d);`,
    'descriptors held by a name': `var descs = { fromCharCode: { value: ${FCC} } }; Object.defineProperties(String, descs);`,
    'a source held by a name': `var src = { fromCharCode: ${FCC} }; Object.assign(String, src);`,
    'a source spread from an array literal': `Object.assign(String, ...[{ fromCharCode: ${FCC} }]);`,
    'a computed key built by concatenation, in defineProperties': `Object.defineProperties(String, { ['from' + 'CharCode']: { value: ${FCC} } });`,
    'a conditional callee of two reflective methods, either arm': `(globalThis.K ? Reflect.set : Object.defineProperty)(String, 'fromCharCode', { value: ${FCC} });`,
  };
  for (const [what, write] of Object.entries(REFLECTIVE_ROUTES)) {
    it(`refuses at every preset for a reflective write through ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
      for (const preset of PRESETS) expect(build(source, ['dec', 'table'], { preset }).decoder, `${what} at ${preset}`).toBeUndefined();
      await expectSameBehaviourEverywhere(source);
    });
  }

  const LITERAL_MEMBERS: Record<string, [string, string]> = {
    "''[k] with k = 'constructor'": [`var k = 'constructor'; var c = ''[k]; c.fromCharCode = ${FCC};`, IS],
    "''[k] with k = '__proto__'": [`var k = '__proto__'; var p = ''[k]; p.split = ${SPL};`, SPLIT_IS],
    "''[k] through an alias of the key": [`var j = 'constructor'; var k = j; var c = ''[k]; c.fromCharCode = ${FCC};`, IS],
    "''[k] with a key of two readings, one of them constructor": [
      `var k = globalThis.K ? 'length' : 'constructor'; var c = ''[k]; c.fromCharCode = ${FCC};`,
      MAY,
    ],
  };
  for (const [what, [write, reason]] of Object.entries(LITERAL_MEMBERS)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).not.toBe(PRINTS_CHARS);
      expectRefused(source, ['dec', 'table'], reason, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('leaves a decoder alone where the route hands over nothing it reads', () => {
    const untouched: Record<string, string> = {
      'a method pulled off another holder': `var o = { f: function (K) { K.fromCharCode = 0; } }; var p = { f: function () {} }; var m = p.f; m(String);`,
      'an optional call handing a literal': `${WRITES_K} f?.({});`,
      'a class instance method handed a literal': `class U { f(K) { K.fromCharCode = 0; } } new U().f({});`,
      'a function declared twice, the first one writing': `function f(K) { K.fromCharCode = 0; } function f() {} f(String);`,
      'an alias inside, of a literal': `function f(K) { var L = {}; L.fromCharCode = 0; } f(String);`,
      'a bound call handing a literal': `${WRITES_K} f.bind(null)({});`,
      "Object[k] with k = 'keys'": `var k = 'keys'; Object[k](String);`,
    };
    for (const [what, write] of Object.entries(untouched)) {
      expectDecoded(`${write}${DECODER_CHARS}`, ['dec', 'table'], 1, 'plain', what);
    }
  });
});

// ---------------------------------------------------------------------------
// U2: one key reader
// ---------------------------------------------------------------------------

/**
 * Every computed access reads its key through `KeyReader.read`: a write
 * target, a reflective method's key, a holder's keys, an alias source.
 * Each shape below was a key the per-route readers took for one the tree
 * cannot read - refused at conservative, taken for a helper at balanced -
 * where the key spells the name the decoder reads.
 */
const ROUND = 'function () { return 2; }';

const KEYS: Record<string, [string, string]> = {
  'k += appended': [`var k = 'ro'; k += 'und'; Math[k] = ${ROUND};`, MAY],
  'k += appended twice': [`var k = 'r'; k += 'o'; k += 'und'; Math[k] = ${ROUND};`, MAY],
  'an element at a readable index held by a name': [`var ks = ['round']; var i = 0; Math[ks[i]] = ${ROUND};`, IS],
  'an element at an index of two readings': [`var ks = ['floor', 'round']; var i = globalThis.K ? 0 : 1; Math[ks[i]] = ${ROUND};`, MAY],
  'an assignment in key position': [`var k = 'x'; Math[k = 'round'] = ${ROUND};`, IS],
  'an appending assignment in key position': [`var k = 'ro'; Math[k += 'und'] = ${ROUND};`, MAY],
  '.toLowerCase()': [`var k = 'ROUND'; Math[k.toLowerCase()] = ${ROUND};`, IS],
  '.toUpperCase() then .toLowerCase()': [`var k = 'Round'; Math[k.toUpperCase().toLowerCase()] = ${ROUND};`, IS],
  '.trim()': [`var k = ' round '; Math[k.trim()] = ${ROUND};`, IS],
  '.toString()': [`var k = 'round'; Math[k.toString()] = ${ROUND};`, IS],
  'String(k)': [`var k = 'round'; Math[String(k)] = ${ROUND};`, IS],
  '.concat': [`Math['ro'.concat('un', 'd')] = ${ROUND};`, IS],
  '.join over a literal': [`Math[['ro', 'und'].join('')] = ${ROUND};`, IS],
  '.join with a separator, over a name': [`var parts = ['ro', 'nd']; Math[parts.join('u')] = ${ROUND};`, IS],
  'a template with a readable part': [`var k = 'und'; Math[\`ro\${k}\`] = ${ROUND};`, IS],
  'a decoder over a literal table': [`var t = ['round']; function k(i) { return t[i]; } Math[k(0)] = ${ROUND};`, IS],
  '.slice(0)': [`var k = 'round'; Math[k.slice(0)] = ${ROUND};`, IS],
  '.slice(1) of a longer key': [`var k = 'xround'; Math[k.slice(1)] = ${ROUND};`, IS],
  '.slice(-5)': [`var k = 'xround'; Math[k.slice(-5)] = ${ROUND};`, IS],
  '.substring(0, 5)': [`var k = 'roundx'; Math[k.substring(0, 5)] = ${ROUND};`, IS],
  '.substr(1, 5)': [`var k = 'xroundx'; Math[k.substr(1, 5)] = ${ROUND};`, IS],
  '.replace of a literal': [`var k = 'rxound'; Math[k.replace('x', '')] = ${ROUND};`, IS],
  '.replaceAll of a literal': [`var k = 'r-ou-nd'; Math[k.replaceAll('-', '')] = ${ROUND};`, IS],
  'a getter of a literal': [`var o = { get k() { return 'round'; } }; Math[o.k] = ${ROUND};`, IS],
  'a getter of two returns': [`var o = { get k() { if (globalThis.K) return 'floor'; return 'round'; } }; Math[o.k] = ${ROUND};`, MAY],
  'a key from a for-in over a literal': [`var d = { round: ${ROUND} }; for (var k in d) Math[k] = d[k];`, IS],
  'a key from a for-in without var': [`var d = { round: ${ROUND} }; var k; for (k in d) Math[k] = d[k];`, MAY],
  'a key from Object.keys(d).forEach': [`var d = { round: ${ROUND} }; Object.keys(d).forEach(function (k) { Math[k] = d[k]; });`, IS],
  'a key from Object.entries(d).forEach': [`var d = { round: ${ROUND} }; Object.entries(d).forEach(function (e) { Math[e[0]] = e[1]; });`, IS],
  'a key from Object.entries(d).forEach, destructured': [`var d = { round: ${ROUND} }; Object.entries(d).forEach(([k, v]) => { Math[k] = v; });`, IS],
};

describe('U2: one key reader - every spelling of the key is read', () => {
  for (const [what, [write, reason]] of Object.entries(KEYS)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_ROUND}`;
      expect(execute(source)).toBe('"gamma" "gamma"');
      expectRefused(source, ['dec', 'table'], reason, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('keeps the helper policy for a key it cannot read', () => {
    const unread: Record<string, string> = {
      'a slice past the tree’s reading': `var k = 'round'; Math[k.slice(0, k.length)] = ${ROUND};`,
      'a spread joined': `Math[[...'round'].join('')] = ${ROUND};`,
      'a key from a call the tree cannot open': `var k = load(); Math[k] = ${ROUND};`,
    };
    for (const [what, write] of Object.entries(unread)) {
      const source = `${write}${DECODER_ROUND}`;
      const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
      expect(balanced.decoder?.decode([1]), what).toBe('beta');
      expect(balanced.notes.some((note) => note.message.startsWith(HELPER_NOTE)), what).toBe(true);
      expect(build(source, ['dec', 'table'], { preset: 'conservative' }).decoder, what).toBeUndefined();
    }
  });

  it('leaves a decoder alone where the key it reads names nothing the decoder reads', () => {
    const untouched: Record<string, string> = {
      'k += appended to another name': `var k = 'fl'; k += 'oor'; Math[k] = ${ROUND};`,
      '.toUpperCase()': `var k = 'round'; Math[k.toUpperCase()] = ${ROUND};`,
      'an element at a readable index': `var ks = ['round', 'floor']; var i = 1; Math[ks[i]] = ${ROUND};`,
      'a for-in over a literal of other keys': `var d = { floor: ${ROUND} }; for (var k in d) Math[k] = d[k];`,
      'Object.keys of a literal of other keys': `var d = { floor: ${ROUND} }; Object.keys(d).forEach(function (k) { Math[k] = d[k]; });`,
    };
    for (const [what, write] of Object.entries(untouched)) {
      expectDecoded(`${write}${DECODER_ROUND}`, ['dec', 'table'], 1, 'beta', what);
    }
  });
});

// ---------------------------------------------------------------------------
// D3h: a holder handed to a reflective write
// ---------------------------------------------------------------------------

/**
 * `Object.assign(String.prototype, d)` writes every key of `d`, and the
 * keys of a holder are its literal's and every write through the name -
 * read by `KeyReader.holderKeys`, whatever route the holder took to the
 * call. Before, only the inline literal was read; a holder by name was a
 * key the tree could not read, taken for a helper at balanced with a
 * disclosure that said so, and the program printed 'Z' where the output
 * printed 'ünï'.
 */
const HOLDER = `var d = { split: ${SPL} };`;

const HOLDERS: Record<string, string> = {
  'a holder by name': `${HOLDER} Object.assign(String.prototype, d);`,
  'an alias by declarator': `${HOLDER} var e = d; Object.assign(String.prototype, e);`,
  'an alias by const': `const d = { split: ${SPL} }; const e = d; Object.assign(String.prototype, e);`,
  'an alias by assignment': `${HOLDER} var e; e = d; Object.assign(String.prototype, e);`,
  'an alias of an alias': `${HOLDER} var e = d; var f = e; Object.assign(String.prototype, f);`,
  'a sequence': `${HOLDER} Object.assign(String.prototype, (0, d));`,
  'a conditional': `${HOLDER} Object.assign(String.prototype, globalThis.K ? {} : d);`,
  'a logical': `${HOLDER} Object.assign(String.prototype, d || {});`,
  'what a function returns': `function h() { return { split: ${SPL} }; } Object.assign(String.prototype, h());`,
  'what a recursion returns': `${HOLDER} function pick(n) { return n ? pick(n - 1) : d; } Object.assign(String.prototype, pick(2));`,
  'an element of an array literal': `var ds = [{ split: ${SPL} }]; Object.assign(String.prototype, ds[0]);`,
  'spread arguments': `${HOLDER} Object.assign(String.prototype, ...[d]);`,
  'spread arguments from an array a name holds': `${HOLDER} var ds = [{}, d]; Object.assign(String.prototype, ...ds);`,
  'a frozen holder': `${HOLDER} Object.freeze(d); Object.assign(String.prototype, d);`,
  'a spread of the holder into a literal': `${HOLDER} Object.assign(String.prototype, { ...d });`,
  'an assignment expression': `var d; Object.assign(String.prototype, d = { split: ${SPL} });`,
  'a parameter of an IIFE': `${HOLDER} (function (e) { Object.assign(String.prototype, e); })(d);`,
  'through .call': `${HOLDER} Object.assign.call(Object, String.prototype, d);`,
  'through .apply': `${HOLDER} Object.assign.apply(Object, [String.prototype, d]);`,
  'defineProperties with a holder': `var d = { split: { value: ${SPL} } }; var e = d; Object.defineProperties(String.prototype, e);`,
  'an aliased target': `${HOLDER} var P = String.prototype; Object.assign(P, d);`,
  'both aliased': `${HOLDER} var e = d; var P = String.prototype; Object.assign(P, e);`,
  'a key written after the literal': `var d = {}; d.split = ${SPL}; Object.assign(String.prototype, d);`,
  'a computed key written after the literal': `var d = {}; var k = 'split'; d[k] = ${SPL}; Object.assign(String.prototype, d);`,
  'a key written through an alias': `var d = {}; var e = d; e.split = ${SPL}; Object.assign(String.prototype, d);`,
  'a key assigned onto the holder': `var d = {}; Object.assign(d, { split: ${SPL} }); Object.assign(String.prototype, d);`,
  'a key defined on the holder': `var d = {}; Object.defineProperty(d, 'split', { value: ${SPL}, enumerable: true }); Object.assign(String.prototype, d);`,
  'a key written by a method of the holder through this': `var d = { init() { this.split = ${SPL}; } }; d.init(); Object.assign(String.prototype, d);`,
  'a key written through a parameter of a fixed function': `var d = {}; function fill(o) { o.split = ${SPL}; } fill(d); Object.assign(String.prototype, d);`,
  'a for-in over the holder': `${HOLDER} for (var k in d) String.prototype[k] = d[k];`,
  'Object.entries over the holder': `${HOLDER} Object.entries(d).forEach(function (e) { String.prototype[e[0]] = e[1]; });`,
  'a holder handed to Object.assign(Math, ...)': `var d = { round: ${ROUND} }; Object.assign(Math, d);`,
  'a key of a holder read through the holder': `var o = { k: 'round' }; var d = {}; d[o.k] = ${ROUND}; Object.assign(Math, d);`,
  "the prototype reached through a value's constructor": `${HOLDER} Object.assign('x'.constructor.prototype, d);`,
  "the prototype reached through a value's __proto__": `${HOLDER} Object.assign(''.__proto__, d);`,
  'the prototype reached through getPrototypeOf': `${HOLDER} Object.assign(Object.getPrototypeOf(''), d);`,
};

describe('D3h: a holder handed to a reflective write is read whatever route it took', () => {
  for (const [what, write] of Object.entries(HOLDERS)) {
    it(`refuses at every preset for ${what}`, async () => {
      const decoder = write.includes('Math') ? DECODER_ROUND : DECODER_CHARS;
      const source = `${write}${decoder}`;
      expect(execute(source)).not.toBe(decoder === DECODER_ROUND ? PRINTS_ROUND : PRINTS_CHARS);
      for (const preset of PRESETS) {
        const { decoder: built, notes } = build(source, ['dec', 'table'], { preset });
        expect(built, `${what} at ${preset}`).toBeUndefined();
        expect(notes.some((note) => note.message.includes(WRITE_NOTE)), `${what} at ${preset}`).toBe(true);
        expect(
          notes.some((note) => note.message.includes('the conservative preset inlines only what is proved')),
          `${what} at ${preset}`,
        ).toBe(false);
      }
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('keeps the helper policy for a holder the tree cannot read whole', () => {
    const unread: Record<string, string> = {
      'a holder from a call the tree cannot open': 'var d = load(); Object.assign(Math, d);',
      'a holder handed to a call the tree cannot open': 'var d = {}; fill(d); Object.assign(Math, d);',
      'a holder written under a key the tree cannot read': 'var d = {}; d[load()] = 0; Object.assign(Math, d);',
      'a holder with a method not its own called': 'var d = {}; d.set(1); Object.assign(Math, d);',
      'a holder given back by freeze under another name': 'var d = {}; var p = Object.freeze(d); p.round = 0; Object.assign(Math, d);',
      'a spread of an array the tree cannot enumerate': 'var ds = load(); Object.assign(Math, ...ds);',
    };
    for (const [what, write] of Object.entries(unread)) {
      const source = `${write}${DECODER_ROUND}`;
      const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
      expect(balanced.decoder?.decode([1]), what).toBe('beta');
      expect(balanced.notes.some((note) => note.message.startsWith(HELPER_NOTE)), what).toBe(true);
      expect(build(source, ['dec', 'table'], { preset: 'conservative' }).decoder, what).toBeUndefined();
    }
  });

  it('leaves a decoder alone for a holder whose keys name nothing it reads', () => {
    const untouched: Record<string, string> = {
      'a holder of other keys': 'var d = { clamp: 0 }; Object.assign(Math, d);',
      'a holder of other keys, through an alias': 'var d = { clamp: 0 }; var e = d; Object.assign(Math, e);',
      'a holder written under other keys': 'var d = {}; d.clamp = 0; d.floor = 1; Object.assign(Math, d);',
      'a holder read only': 'var d = { clamp: 0 }; Object.keys(d); JSON.stringify(d); Object.assign(Math, d);',
      'a fresh target from a holder': 'var d = { round: 0 }; Object.assign({}, d);',
    };
    for (const [what, write] of Object.entries(untouched)) {
      expectDecoded(`${write}${DECODER_ROUND}`, ['dec', 'table'], 1, 'beta', what);
    }
  });

  it('defers a holder whose key is computed by a decoder this round cannot read, and refuses once it is inlined', async () => {
    // `d[dec(1)] = ...;
    // Object.assign(Math, d)` beside a second decoder that calls Math.round.
    const source = `var t = ['c3BsaXQ', 'cm91bmQ'];
function dec(i) {
  var s = t[i], k = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', o = '', b = 0, n = 0;
  for (var j = 0; j < s.length; j++) { b = (b << 6) | k.indexOf(s[j]); n += 6; if (n >= 8) { n -= 8; o += String.fromCharCode((b >> n) & 255); } }
  return o;
}
var d = {}; d[dec(1)] = ${ROUND}; Object.assign(Math, d);
var table = ['alpha', 'beta', 'gamma'];
function dec2(i) { return table[Math.round(i)]; }
log(dec2(0), dec2(1));`;
    expect(execute(source)).toBe('"gamma" "gamma"');
    for (const preset of PRESETS) {
      const { decoder, notes, refusals } = build(source, ['dec2', 'table'], { preset });
      expect(decoder, preset).toBeUndefined();
      expect(refusals, preset).toEqual(['unread-key']);
      expect(notes.map((note) => note.message), preset).toContainEqual(
        expect.stringContaining('is computed by a call to dec, which this round cannot read'),
      );
    }
    const inlined = source.replace('d[dec(1)]', "d['round']");
    expectRefused(inlined, ['dec2', 'table'], IS, 'inlined');
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const preset of PRESETS) expect(outputs[preset].code, preset).not.toMatch(/['"]alpha['"]\s*,\s*['"]beta['"]\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

describe('wording: a hop the tree cannot read is a may-write', () => {
  it('says "may not" for a member written past an unread hop, in the prototype channel', () => {
    // `String[k].split` is `String.prototype.split` only if `k` is
    // `prototype`; a decoder that never spells `String` meets the write in
    // the prototype channel alone, which said "is not".
    const source = `var k = ${OPAQUE('prototype')}; String[k].split = ${SPL};
var table = ['a,b', 'c,d'];
function dec(i) { return table[i].split(',')[0]; }
log(dec(0), dec(1));`;
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, ['dec', 'table'], { preset });
      expect(decoder, preset).toBeUndefined();
      const refusal = notes.find((note) => note.message.includes(WRITE_NOTE));
      expect(refusal?.message, preset).toContain('may not be the builtin');
      expect(refusal?.message, preset).toContain('may be `prototype`');
      expect(refusal?.message, preset).not.toMatch(/split the slice reads on a value is not/);
    }
  });
});
