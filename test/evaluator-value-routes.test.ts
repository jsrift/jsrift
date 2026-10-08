import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The routes a builtin takes to a write that name no call, or a call the
 * tree cannot open: a value that flows through a call whose callee the
 * tree cannot read - `[String].pop()`, `m.get(k)` - a `for` head that
 * declares, a `catch`, a getter, a class field, a literal read back and
 * then `.call`ed, an `apply` over a list held by a name, a bound argument,
 * the global object spelled as its own property or returned by
 * `Function('return this')`, a bare name assigned as a global property.
 * Each was silent at every preset: the write went under a local, and
 * conservative inlined the builtin's reading where the program prints the
 * replacement's. Every shape is executed: the input and each preset's
 * output run in a realm holding nothing but `log`, and the traces match.
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
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
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

const DECODER_UTF8 = `
var table = ['%C3%BCn%C3%AF', 'plain', 'other'];
function dec(i) { return decodeURIComponent(table[i]); }
log(dec(0), dec(1));
`;

const FCC = "function () { return 'Z'; }";
const SPL = "function () { return ['90']; }";
const XDEC = "function (s) { return 'X' + s; }";
const PRINTS_CHARS = '"ünï" "plain"';
const PRINTS_UTF8 = '"ünï" "plain"';

/** The decoder decodes at every preset, and no note calls the write a host write. */
function expectDecoded(source: string, what: string): void {
  for (const preset of PRESETS) {
    const { decoder, notes } = build(source, ['dec', 'table'], { preset });
    expect(decoder?.decode([1]), `${what} at ${preset}`).toBe('plain');
    expect(
      notes.filter((note) => note.message.includes(WRITE_NOTE) || note.message.startsWith(HELPER_NOTE)).map((note) => note.message),
      `${what} at ${preset}`,
    ).toEqual([]);
  }
}

/** The decoder is refused at every preset, with a note naming the write. */
function expectRefused(source: string, what: string): void {
  for (const preset of PRESETS) {
    const { decoder, notes } = build(source, ['dec', 'table'], { preset });
    expect(decoder, `${what} at ${preset}`).toBeUndefined();
    expect(notes.some((note) => note.message.includes(WRITE_NOTE)), `${what} at ${preset}`).toBe(true);
    expect(
      notes.some((note) => note.message.includes('the conservative preset inlines only what is proved')),
      `${what} at ${preset}`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// A value that flows through a call the tree cannot open
// ---------------------------------------------------------------------------

/**
 * A call of something the tree cannot name - a method of a literal, of an
 * instance, of a value a parameter holds - may return anything it was
 * given, so its result is a value the tree cannot read, and a write
 * through it is a write to what may be the builtin. Before, the result of
 * such a call was taken for a fresh object, and `var S = [String].pop();
 * S.fromCharCode = ...` was a write to nobody.
 */
const THROUGH_CALLS: Record<string, string> = {
  'an element popped off a literal': `var S = [String].pop(); S.fromCharCode = ${FCC};`,
  'an element found in a literal': `var S = [String].find(Boolean); S.fromCharCode = ${FCC};`,
  'an element shifted off a literal': `var S = [String].shift(); S.fromCharCode = ${FCC};`,
  'Array.of': `var S = Array.of(String)[0]; S.fromCharCode = ${FCC};`,
  'Array.from over a literal': `var S = Array.from([String])[0]; S.fromCharCode = ${FCC};`,
  'concat onto an empty literal': `var S = [].concat(String)[0]; S.fromCharCode = ${FCC};`,
  'a spread into a literal': `var S = [...[String]][0]; S.fromCharCode = ${FCC};`,
  'a slice of a literal': `var S = [String].slice()[0]; S.fromCharCode = ${FCC};`,
  'a nested literal flattened': `var S = [[String]].flat()[0]; S.fromCharCode = ${FCC};`,
  'an element at -1': `var S = [String].at(-1); S.fromCharCode = ${FCC};`,
  'a Set iterated': `for (const S of new Set([String])) S.fromCharCode = ${FCC};`,
  'Object.values of a literal': `var S = Object.values({ a: String })[0]; S.fromCharCode = ${FCC};`,
  'Object.entries of a literal': `var S = Object.entries({ a: String })[0][1]; S.fromCharCode = ${FCC};`,
  'Reflect.get on a literal': `var S = Reflect.get({ a: String }, 'a'); S.fromCharCode = ${FCC};`,
  'a Map built from a literal': `var m = new Map([['S', String]]); m.get('S').fromCharCode = ${FCC};`,
  'a Map filled by a call': `var m = new Map(); m.set('S', String); m.get('S').fromCharCode = ${FCC};`,
  'a WeakMap filled by a call': `var m = new WeakMap(); var k = {}; m.set(k, String); m.get(k).fromCharCode = ${FCC};`,
  'a bound function returning this': `var g = function () { return this; }.bind(String); g().fromCharCode = ${FCC};`,
  'a generator yielding the builtin': `function* g() { yield String; } for (var S of g()) S.fromCharCode = ${FCC};`,
  'a method of a parameter holding a literal': `function f(a) { var S = a.pop(); S.fromCharCode = ${FCC}; } f([String]);`,
};

describe('a value that flows through a call the tree cannot open', () => {
  for (const [what, write] of Object.entries(THROUGH_CALLS)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('leaves a decoder alone where nothing the slice reads flows into the call', () => {
    const untouched: Record<string, string> = {
      'an element popped off a literal of its own': 'var x = [{}].pop(); x.fromCharCode = 0;',
      'Array.of a literal': 'var x = Array.of({})[0]; x.fromCharCode = 0;',
      'a Map of its own': "var m = new Map(); m.set('k', {}); m.get('k').fromCharCode = 0;",
      'a value a call the tree cannot open returns, given nothing': 'var x = load(); x.fromCharCode = 0;',
      'a string method result': "var s = ['a'].join(''); s.fromCharCode = 0;",
      'JSON.parse': "var x = JSON.parse('{}'); x.fromCharCode = 0;",
      'Object.keys': 'var x = Object.keys({}); x.fromCharCode = 0;',
      'a split of a string literal by what a builtin returned': "var t = 'a,b'.split(String.fromCharCode(44)); t[0] = 'x';",
      'a string literal’s method chain': "var t = 'a,b'.split(',').map(function (x) { return x; }); t[0] = 'x';",
      'a builtin run as a callback, never kept': 'var xs = [1, 2]; var s = xs.map(String); s[0] = 0;',
      'a builtin run as a callback over a parameter': 'function f(x) { var s = x.map(String); s[0] = 0; } f([1]);',
      'a method of a decoder called with what it returned': 'function d(i) { return i; } d.cache = {}; d.cache[d(0)] = d.cache[d(0)] || 1;',
      'an array literal’s methods under keys a decoder spells, then an element swap': "var m = ['filter', 'concat', 'map']; function k(i) { return m[i]; } var t = ['a'][k(0)](Boolean)[k(1)]([2])[k(2)](function (x) { return x; }); t[0] = t[1];",
      'a rest of a literal, written through': 'var [a, ...rest] = [1, {}]; rest[0].fromCharCode = 0;',
      'Object of a number': 'var x = Object(1); x.fromCharCode = 0;',
      'a holder given a method that writes this, none of them the read key': 'var d = {}; d.m = function () { this.k = 1; }; d.m(); Object.assign(Math, d);',
    };
    for (const [what, write] of Object.entries(untouched)) expectDecoded(`${write}${DECODER_CHARS}`, what);
  });
});

// ---------------------------------------------------------------------------
// A binding given the builtin by a head, a catch, a getter, a field
// ---------------------------------------------------------------------------

const BOUND_ELSEWHERE: Record<string, string> = {
  'a for-of head that declares': `for (var S of [String]) S.fromCharCode = ${FCC};`,
  'a for-of head with const': `for (const S of [String]) S.fromCharCode = ${FCC};`,
  'a for-of head destructuring': `for (let [S] of [[String]]) S.fromCharCode = ${FCC};`,
  'a for-of head over a literal a name holds': `var xs = [String]; for (var S of xs) S.fromCharCode = ${FCC};`,
  'a for-of head destructuring the pairs of a Map': `for (const [k, S] of new Map([['a', String]])) S.fromCharCode = ${FCC};`,
  'a for-of head destructuring the pairs of a Map a name holds': `var m = new Map([['a', String]]); for (const [k, S] of m) S.fromCharCode = ${FCC};`,
  'a for-of head destructuring the entries of a literal': `for (const [k, S] of Object.entries({ a: String })) S.fromCharCode = ${FCC};`,
  'a for-in head that declares, over a holder': `var o = { S: String }; for (var k in o) o[k].fromCharCode = ${FCC};`,
  'a catch of what the program throws': `try { throw String; } catch (S) { S.fromCharCode = ${FCC}; }`,
  'a catch of what a function throws': `function boom() { throw String; } try { boom(); } catch (S) { S.fromCharCode = ${FCC}; }`,
  'a getter of a literal': `var o = { get S() { return String; } }; o.S.fromCharCode = ${FCC};`,
  'a static field of a class': `class H { static S = String; } H.S.fromCharCode = ${FCC};`,
  'a static field of a class expression': `var H = class { static S = String; }; H.S.fromCharCode = ${FCC};`,
  'a static getter of a class': `class H { static get S() { return String; } } H.S.fromCharCode = ${FCC};`,
  'a field of an instance': `class H { S = String; } new H().S.fromCharCode = ${FCC};`,
  'a destructuring with a default, the function picked': `function f(K) { K.fromCharCode = ${FCC}; } var { f: g = 0 } = { f }; g(String);`,
  'a destructuring with a default, the builtin picked': `var { S = 0 } = { S: String }; S.fromCharCode = ${FCC};`,
  'a destructuring with a default taken': `var { S = String } = {}; S.fromCharCode = ${FCC};`,
};

describe('a binding given the builtin by a head, a catch, a getter or a field', () => {
  for (const [what, write] of Object.entries(BOUND_ELSEWHERE)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('leaves a decoder alone where the binding holds nothing the slice reads', () => {
    const untouched: Record<string, string> = {
      'a for-of head over literals of its own': 'for (var x of [{}]) x.fromCharCode = 0;',
      'a catch of a literal': 'try { throw {}; } catch (e) { e.fromCharCode = 0; }',
      'a getter returning a literal': 'var o = { get x() { return {}; } }; o.x.fromCharCode = 0;',
      'a static field holding a literal': 'class H { static x = {}; } H.x.fromCharCode = 0;',
      'a default of a literal': 'var { x = {} } = {}; x.fromCharCode = 0;',
    };
    for (const [what, write] of Object.entries(untouched)) expectDecoded(`${write}${DECODER_CHARS}`, what);
  });
});

// ---------------------------------------------------------------------------
// Routes the callee normaliser sees through, one spelling further
// ---------------------------------------------------------------------------

const WRITES_K = `function f(K) { K.fromCharCode = ${FCC}; }`;
const DESC = `{ value: ${FCC}, configurable: true, writable: true }`;

const ROUTES: Record<string, string> = {
  'a literal read back, then .call': `${WRITES_K} [f][0].call(null, String);`,
  'a method assigned from a declaration, called off its holder': `${WRITES_K} var o = {}; o.f = f; o.f(String);`,
  'a property path given the builtin, written through': `var o = {}; o.S = String; o.S.fromCharCode = ${FCC};`,
  'a property path two deep given the builtin, written through': `var o = { a: {} }; o.a.S = String; o.a.S.fromCharCode = ${FCC};`,
  'a method assigned from a name, called off its holder': `var g = function (K) { K.fromCharCode = ${FCC}; }; var o = {}; o.f = g; o.f(String);`,
  'a method assigned from a name, called off an alias of its holder': `var g = function (K) { K.fromCharCode = ${FCC}; }; var o = {}; o.f = g; var p = o; p.f(String);`,
  'a literal read back, then .apply': `${WRITES_K} ({ d: f }).d.apply(null, [String]);`,
  'a literal read back, then .bind called at once': `${WRITES_K} [f][0].bind(null)(String);`,
  'a literal two deep, then .call': `${WRITES_K} [[f]][0][0].call(null, String);`,
  'a class expression constructed in place': `new (class { f(K) { K.fromCharCode = ${FCC}; } })().f(String);`,
  'apply over the arguments object': `${WRITES_K} function w() { return f.apply(null, arguments); } w(String);`,
  'apply over a list a name holds': `${WRITES_K} var a = [String]; f.apply(null, a);`,
  'a spread of a list a name holds': `${WRITES_K} var a = [String]; f(...a);`,
  'a rest parameter spread on': `${WRITES_K} function w(...a) { return f(...a); } w(String);`,
  'a bound argument, called at once': `${WRITES_K} f.bind(null, String)();`,
  'a bound argument before a passed one': `function f(a, K) { K.fromCharCode = ${FCC}; } f.bind(null, 0)(String);`,
  'a bound reflective method with the target bound': `Object.defineProperty.bind(Object, String)('fromCharCode', ${DESC});`,
  'a bound reflective method with the target and the key bound': `Object.defineProperty.bind(Object, String, 'fromCharCode')(${DESC});`,
  'a bound reflective method held by a name': `var d = Object.defineProperty.bind(Object, String); d('fromCharCode', ${DESC});`,
  'a reflective method applied over a list a name holds': `var a = [String, 'fromCharCode', ${DESC}]; Object.defineProperty.apply(Object, a);`,
  'a reflective method spread a list a name holds': `var a = [String, 'fromCharCode', ${DESC}]; Object.defineProperty(...a);`,
  'a reflective method under with': `with (Object) { defineProperty(String, 'fromCharCode', ${DESC}); }`,
  "a reflective method off a literal's constructor": `({}).constructor.defineProperty(String, 'fromCharCode', ${DESC});`,
  "a reflective method off Object.prototype's constructor": `Object.prototype.constructor.defineProperty(String, 'fromCharCode', ${DESC});`,
  'Reflect.apply held by a name': `var ap = Reflect.apply; ap(Object.defineProperty, Object, [String, 'fromCharCode', ${DESC}]);`,
  'a reflective method held by a literal in an array': `var os = [{ a: Object.assign }]; os[0].a(String, { fromCharCode: ${FCC} });`,
  'a reflective method held two literals deep': `var o = { n: { d: Object.defineProperty } }; o.n.d(String, 'fromCharCode', ${DESC});`,
  'a reflective method held by a literal, called through an alias of the holder': `var o = { d: Object.defineProperty }; var p = o; p.d(String, 'fromCharCode', ${DESC});`,
  'a reflective method held by a literal, called through an alias of an alias': `var o = { d: Object.defineProperty }; var p = o; var q = p; q.d(String, 'fromCharCode', ${DESC});`,
  'Reflect.apply held by a name, handing the builtin to a fixed function': `${WRITES_K} var ap = Reflect.apply; ap(f, null, [String]);`,
  'a callback of a Map': `new Map([['S', String]]).forEach(function (v) { v.fromCharCode = ${FCC}; });`,
  'a callback of a Set': `new Set([String]).forEach(function (v) { v.fromCharCode = ${FCC}; });`,
  'a callback run over what a call the tree cannot open holds': `var m = new Map(); m.set('S', String); m.forEach(function (v) { v.fromCharCode = ${FCC}; });`,
};

/** A holder or its keys reached by a route: `Object.keys.call(null, d)`, a holder `Object.assign.call` built. */
const HOLDER_ROUTES: Record<string, string> = {
  'Object.keys through .call, iterated by a callback': `var d = { split: ${SPL} }; Object.keys.call(null, d).forEach(function (k) { String.prototype[k] = d[k]; });`,
  'Object.entries through Reflect.apply, iterated by a callback': `var d = { split: ${SPL} }; Reflect.apply(Object.entries, null, [d]).forEach(function (e) { String.prototype[e[0]] = e[1]; });`,
  'a holder built by Object.assign through .call': `var d = Object.assign.call(null, {}, { split: ${SPL} }); Object.assign(String.prototype, d);`,
  'a holder kept in a Map': `var m = new Map(); m.set('d', { split: ${SPL} }); Object.assign(String.prototype, m.get('d'));`,
  'a holder given a method that writes the key through this': `var d = {}; d.m = function () { this.split = ${SPL}; }; d.m(); Object.assign(String.prototype, d);`,
  'a Map iterated, its keys the properties written through this': `new Map([['split', ${SPL}]]).forEach(function (v, k) { this[k] = v; }, String.prototype);`,
  'an array iterated, its index the key': `var ks = ['split']; [${SPL}].forEach(function (v, i) { String.prototype[ks[i]] = v; });`,
  'a receiver given to forEach, written through this': `[${SPL}].forEach(function (v) { this.split = v; }, String.prototype);`,
  'a receiver given to map, written through this under a key': `var k = 'split'; [${SPL}].map(function (v) { this[k] = v; }, String.prototype);`,
};

/** A prototype reached by a route: `Object.getPrototypeOf` called through `.call`, `Reflect.apply` or a name. */
const PROTOTYPE_ROUTES: Record<string, string> = {
  'getPrototypeOf through .call': `Object.getPrototypeOf.call(Object, '').split = ${SPL};`,
  'getPrototypeOf through Reflect.apply': `Reflect.apply(Object.getPrototypeOf, null, ['']).split = ${SPL};`,
  'getPrototypeOf held by a name': `var gp = Object.getPrototypeOf; gp('').split = ${SPL};`,
  'Reflect.getPrototypeOf held by a name': `var gp = Reflect.getPrototypeOf; gp('').split = ${SPL};`,
  'getPrototypeOf through an alias, aliased again': `var gp = Object.getPrototypeOf; var p = gp(''); p.split = ${SPL};`,
  'a local string under a key spelled __proto__ by a global’s reading': `var s = 'x'; var k = String(Object.keys({ __proto__x: 1 })[0]).slice(0, 9); s[k].split = ${SPL};`,
};

describe('routes the callee normaliser sees through, one spelling further', () => {
  for (const [what, write] of Object.entries(ROUTES)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  for (const [what, write] of Object.entries(HOLDER_ROUTES)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"Z" "Z"');
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('refuses at every preset a key computed by a function taking nothing, until a later round inlines it', async () => {
    // The slicer keeps `k` out of the interpreter's reach here; the write is judged once the call is a literal.
    const source = `function k() { return 'fromCharCode'; } Object.defineProperty(String, k(), { value: ${FCC} });${DECODER_CHARS}`;
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, ['dec', 'table'], { preset });
      expect(decoder, preset).toBeUndefined();
      expect(notes.some((note) => note.message.includes('is computed by a call to k')), preset).toBe(true);
    }
    await expectSameBehaviourEverywhere(source);
  });

  for (const [what, write] of Object.entries(PROTOTYPE_ROUTES)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).not.toBe(PRINTS_CHARS);
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('refuses at conservative, and says so at balanced, where the route is read only as far as a parameter something else calls', async () => {
    // `this.f = ...` inside a constructor expression: the walk spells the
    // method `this.f`, and the scope cannot say who calls it, so the
    // parameter is one something else may call - the disclosed policy.
    const source = `new (function () { this.f = function (K) { K.fromCharCode = ${FCC}; }; })().f(String);${DECODER_CHARS}`;
    expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
    const conservative = build(source, ['dec', 'table'], { preset: 'conservative' });
    expect(conservative.decoder).toBeUndefined();
    expect(conservative.notes.some((note) => note.message.includes(WRITE_NOTE))).toBe(true);
    const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
    expect(balanced.decoder?.decode([1])).toBe('plain');
    expect(balanced.notes.some((note) => note.message.startsWith(HELPER_NOTE))).toBe(true);
  });

  it('refuses a callback a promise resolves the builtin into, which runs after the trace', () => {
    // Not executed: the write happens in a microtask, after the trace.
    const source = `Promise.resolve(String).then(function (S) { S.fromCharCode = ${FCC}; });${DECODER_CHARS}`;
    expectRefused(source, 'then');
  });

  it('leaves a decoder alone where the route hands over nothing it reads', () => {
    const untouched: Record<string, string> = {
      'a literal read back, then .call with a literal': `${WRITES_K} [f][0].call(null, {});`,
      'apply over a list of literals': `${WRITES_K} var a = [{}]; f.apply(null, a);`,
      'a bound literal': `${WRITES_K} f.bind(null, {})();`,
      'a callback of a Map of literals': `new Map([['k', {}]]).forEach(function (v) { v.fromCharCode = 0; });`,
      'a class expression constructed in place, handed a literal': `new (class { f(K) { K.fromCharCode = 0; } })().f({});`,
    };
    for (const [what, write] of Object.entries(untouched)) expectDecoded(`${write}${DECODER_CHARS}`, what);
  });
});

// ---------------------------------------------------------------------------
// The global object, by every spelling
// ---------------------------------------------------------------------------

const GLOBAL_OBJECT: Record<string, string> = {
  'globalThis.globalThis': `globalThis.globalThis.decodeURIComponent = ${XDEC};`,
  'globalThis.self': `globalThis.self.decodeURIComponent = ${XDEC};`,
  'a name holding globalThis.globalThis': `var g = globalThis.globalThis; g.decodeURIComponent = ${XDEC};`,
  "Function('return this')()": `var g = Function('return this')(); g.decodeURIComponent = ${XDEC};`,
  "new Function('return this')()": `var g = new Function('return this')(); g.decodeURIComponent = ${XDEC};`,
  "Function('return this;')() with a semicolon": `var g = Function('return this;')(); g.decodeURIComponent = ${XDEC};`,
  "an indirect eval of 'this'": `var g = (0, eval)('this'); g.decodeURIComponent = ${XDEC};`,
  "Function('return this')() written through at once": `Function('return this')().decodeURIComponent = ${XDEC};`,
};

/** A bare name and the global object's property of that name are one binding. */
const GLOBAL_PROPERTIES: Record<string, string> = {
  'assigned as a property of globalThis, read bare': `globalThis.S = String; S.fromCharCode = ${FCC};`,
  'assigned as a property of this, read bare': `this.S = String; S.fromCharCode = ${FCC};`,
  'assigned as a property of an alias of the global object, read bare': `var g = globalThis; g.S = String; S.fromCharCode = ${FCC};`,
  'assigned bare, read bare': `S = String; S.fromCharCode = ${FCC};`,
  'assigned bare, read as a property of globalThis': `S = String; globalThis.S.fromCharCode = ${FCC};`,
  'assigned as a property of globalThis, read the same way': `globalThis.S = String; globalThis.S.fromCharCode = ${FCC};`,
  'assigned as a property of globalThis, read as a property of this': `globalThis.S = String; this.S.fromCharCode = ${FCC};`,
  'declared with var at the top of a script, read as a property of globalThis': `var S = String; globalThis.S.fromCharCode = ${FCC};`,
  'declared as a function at the top of a script, read as a property of globalThis': `function S() {} S.x = String; globalThis.S.x.fromCharCode = ${FCC};`,
  'assigned as a property of globalThis under a readable key': `var k = 'S'; globalThis[k] = String; S.fromCharCode = ${FCC};`,
  'assigned as a property of globalThis, handed on bare': `${WRITES_K} globalThis.S = String; f(S);`,
};

describe('the global object, by every spelling', () => {
  for (const [what, write] of Object.entries(GLOBAL_OBJECT)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_UTF8}`;
      expect(execute(source)).not.toBe(PRINTS_UTF8);
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  for (const [what, write] of Object.entries(GLOBAL_PROPERTIES)) {
    it(`refuses at every preset for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      expect(execute(source)).toBe('"ZZZ" "ZZZZZ"');
      expectRefused(source, what);
      await expectSameBehaviourEverywhere(source);
    });
  }

  it('leaves a decoder alone where the global property holds nothing the slice reads', () => {
    const untouched: Record<string, string> = {
      'a literal, read bare': 'globalThis.S = {}; S.fromCharCode = 0;',
      'a literal assigned bare': 'S = {}; S.fromCharCode = 0;',
      'a var at the top of a script holding a literal': 'var S = {}; globalThis.S.fromCharCode = 0;',
      'a let at the top of a script holding the builtin, which is no property of the global object': `let S = String; globalThis.S = {}; globalThis.S.fromCharCode = 0;`,
      "Function('return 1')()": "var g = Function('return 1')(); g.fromCharCode = 0;",
    };
    for (const [what, write] of Object.entries(untouched)) expectDecoded(`${write}${DECODER_CHARS}`, what);
  });
});
