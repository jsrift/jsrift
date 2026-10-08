import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder, type DecoderRefusal } from '../src/analysis/evaluator/index.js';
import { recogniseNativeDecoder } from '../src/analysis/evaluator/native.js';
import { declareSliceScope, sliceForEvaluation } from '../src/analysis/slice.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Two ways a decoder was trusted on nothing, both found by the round-ten
 * differential fuzz, both wrong rewrites that parsed and ran.
 *
 * The first is a decoder with no evidence at all. Every call site of the
 * two-layer file read its argument out of an object map, so the
 * sample walk read nothing, `validate` passed an empty list as "nothing to
 * get wrong", the cross-check was skipped on the same list, and the native
 * reading - unrotated, because the rotation IIFE pushed and shifted through
 * the same map - was adopted. The round after the maps were inlined exposed
 * a literal argument and inlined the unrotated entry. Its corollary is the
 * same adoption of a decoder with no `return`, whose hang went with the
 * machinery.
 *
 * The second is a builtin the program has replaced. A binding of the name
 * between the decoder and the global object is a refusal already; a write to
 * the global object - `globalThis.decodeURIComponent = ...`, `this....` at the
 * top of a script, `String.fromCharCode = ...`, a bare assignment inside a
 * `setup()` called first, `window....` - leaves every scope clean and had
 * 'ünï' inlined where the program prints something else, with both tiers
 * agreeing.
 *
 * Every shape here is executed: the input and each preset's output run in a
 * realm holding nothing but `log`, and the traces must match.
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

/** Deobfuscate at every preset and prove each output does what the input does. */
async function expectSameBehaviourEverywhere(
  source: string,
  options: DeobfuscateOptions = {},
  timeout?: number,
): Promise<Record<(typeof PRESETS)[number], string>> {
  const before = execute(source, timeout);
  const outputs = {} as Record<(typeof PRESETS)[number], string>;
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { ...options, preset });
    expect(execute(result.code, timeout), preset).toBe(before);
    outputs[preset] = result.code;
  }
  return outputs;
}

function programPath(source: string, sourceType?: 'script' | 'module'): NodePath<t.Program> {
  const { ast } = parseSource(source, sourceType ? { sourceType } : {});
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

function build(
  source: string,
  roots: string[],
  options: Parameters<typeof resolveConfig>[0] = {},
  sourceType?: 'script' | 'module',
  table?: string,
) {
  const notes: { severity: Severity; message: string }[] = [];
  const refusals: DecoderRefusal[] = [];
  const program = programPath(source, sourceType);
  // What `strings.discover` tells the slicer about a table it audits itself,
  // so a read of it in a sibling function is the caller's to judge.
  if (table) declareSliceScope(roots, program, table);
  const decoder = buildDecoder(program, roots, resolveConfig(options), {
    reporter: {
      note: (severity, message) => notes.push({ severity, message }),
      refused: (kind) => refusals.push(kind),
    },
  });
  return { decoder, notes, refusals };
}

function recognise(source: string, roots: string[]) {
  const program = programPath(source);
  return recogniseNativeDecoder(sliceForEvaluation(program, roots), roots);
}

// ---------------------------------------------------------------------------
// A decoder adopted on zero samples
// ---------------------------------------------------------------------------

/**
 * A proxied rotation adopted on zero samples. The outer layer proxies push, shift, call and apply through
 * `w`, so the rotation loop is not one the recognisers can read, and the
 * one program call site reads its argument out of `l.c`. The program prints
 * `2nm`; the unrotated table says `fn:nm`.
 */
const PROXIED_ROTATION = `function a() {
  var z = ['1', '2', '3', 'fn:'];
  a = function () { return z; };
  return a();
}
function b(P) {
  P = P - 296;
  var U = a(), w = U[P];
  return w;
}
var w = { push: 'push', shift: 'shift', call: function (q) { return q(); }, apply: function (q, M) { return q(M); } };
(function (z, U) {
  var k = {};
  k.c = 0x128;
  var X = k, O = b, C = w.call(z);
  while (true) {
    try {
      var p = parseInt(w.apply(O, X.c)) / 1;
      if (p === U) break; else C[w.push](C[w.shift]());
    } catch (q) {
      C[w.push](C[w.shift]());
    }
  }
})(a, 3);
function classify(z) {
  var l = {};
  l.c = 0x12b;
  var U = l;
  return b(U.c) + z.name;
}
log(classify(function nm() {}));
`;

describe('a decoder none of whose call sites could be read', () => {
  it('prints what the program prints at every preset', async () => {
    expect(execute(PROXIED_ROTATION)).toBe('"2nm"');
    const outputs = await expectSameBehaviourEverywhere(PROXIED_ROTATION);
    // The table may stay; the unrotated entry may not reach the call site.
    for (const code of Object.values(outputs)) expect(code).not.toMatch(/['"]fn:['"]\s*\+/);
  });

  it('is refused with the reference named, and told apart as unverified for the caller', () => {
    const { decoder, notes, refusals } = build(PROXIED_ROTATION, ['b', 'a']);
    expect(decoder).toBeUndefined();
    expect(refusals).toEqual(['unverified']);
    const refusal = notes.find((note) => note.message.includes('verified against a single call site'));
    expect(refusal?.severity).toBe('warning');
    expect(refusal?.message).toContain('Refusing b: it is called at line 29');
  });

  it('is proved once a round exposes one literal argument', () => {
    // What the object-map round hands the retry: the same file with `b(0x12b)`
    // spelled out. One site is enough for the interpreter to run the proxied
    // loop and contradict the unrotated reading.
    const exposed = PROXIED_ROTATION.replace('b(U.c)', 'b(0x12b)');
    const { decoder, refusals, notes } = build(exposed, ['b', 'a']);
    expect(refusals).toEqual([]);
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([0x12b])).toBe('2');
    expect(notes.some((note) => note.severity === 'error' && note.message.includes('disagree'))).toBe(true);
  });

  it('keeps the acceptance of a decoder nothing references at all', () => {
    const source = `
      var _0xt = ['alpha', 'beta', 'gamma'];
      function _0xd(_0xi) { _0xi = _0xi - 0x1; return _0xt[_0xi]; }
      log('nothing calls it');
    `;
    const { decoder, refusals, notes } = build(source, ['_0xd', '_0xt']);
    expect(refusals).toEqual([]);
    expect(decoder?.decode([2])).toBe('beta');
    expect(notes.some((note) => note.message.includes('Refusing'))).toBe(false);
  });

  it('counts an alias and an indexed read as uses, not only a call', () => {
    // A hand-off to a call is the slicer's refusal already; an alias taken
    // in a function is not, and is the shape the two-layer file's source had.
    const aliased = `
      var _0xt = ['alpha', 'beta', 'gamma'];
      function _0xd(_0xi) { _0xi = _0xi - 0x1; return _0xt[_0xi]; }
      function classify(z) { var k = _0xd; return k(z.length); }
      log(classify('ab'));
    `;
    const asValue = build(aliased, ['_0xd', '_0xt']);
    expect(asValue.decoder).toBeUndefined();
    expect(asValue.refusals).toEqual(['unverified']);
    expect(asValue.notes.some((note) => note.message.includes('referenced as a value at line 4'))).toBe(true);

    const indexed = `
      var _0xt = ['alpha', 'beta', 'gamma'];
      function pick(i) { return _0xt[i % 3]; }
      log(pick(4));
    `;
    const byMember = build(indexed, ['_0xt'], {}, undefined, '_0xt');
    expect(byMember.decoder).toBeUndefined();
    expect(byMember.refusals).toEqual(['unverified']);
    expect(byMember.notes.some((note) => note.message.includes('read through a member at line 3'))).toBe(
      true,
    );
  });

  it('does not count the decoder’s own machinery as a use', () => {
    // The rotation IIFE the slicer takes calls the decoder with a literal and
    // hands the accessor over; both are inside the slice, and the one program
    // site is a literal, so there is a sample and no unread use.
    const source = `
      function a() { var z = ['1', '2', '3', 'fn:']; a = function () { return z; }; return a(); }
      function b(P) { P = P - 296; var U = a(), w = U[P]; return w; }
      (function (z, U) {
        var C = z();
        while (true) { try { var p = parseInt(b(0x128)) / 1; if (p === U) break; else C.push(C.shift()); } catch (q) { C.push(C.shift()); } }
      })(a, 3);
      log(b(0x12b));
    `;
    const { decoder, refusals } = build(source, ['b', 'a']);
    expect(refusals).toEqual([]);
    expect(decoder?.decode([0x12b])).toBe('2');
  });
});

/**
 * A reduced form of the same program: the decoder lost its `return` and the rotation loop lost
 * its body, so the program hangs on load. The native tier read "index
 * lookup, index offset 296" off a body that indexes nothing, and once the
 * retry had a sample the interpreter ran out of budget on the loop, the
 * match stood unchecked at balanced, and the hang left with the machinery.
 */
const NO_RETURN_DECODER = `
(function (c, d) {
    var l = {}, h = b, i = b, j = b, e = c();
    while (!![]) {
        try {
        } catch (g) {
        }
    }
}(a, 0x1b8a3 * 0x1 + 0x1f400 + 0x19a3));
function classify(c) {
    var m = { c: 0x134 }, k = b;
    return c instanceof Function ? k(m.c) + c['\\x6e\\x61\\x6d\\x65'] : typeof c;
}
function b(c, d) {
    c = c - (-0x10 * -0x9d + -0x7 * 0x26d + -0x1 * -0x853);
    var e = a();
}
log(classify(function nm() {
}), classify(0x139c + 0x5 * -0x28f + 0x1 * -0x6d0));
function a() {
    var o = ['8005439uAcqlW', '325435laDzCY', '399ZibNCv', '9evJxnU', '606770uoYxVK', '10DDacGN', '24KWCsdq', '3EbBmMh', 'fn:', '39948tgDdRP', '415364jlmqnC', '1277744VLRSCX', '726928KKSHfU'];
    a = function () {
        return o;
    };
}
`;

describe('a decoder with no return', () => {
  it('is not an index lookup to the native tier', () => {
    expect(recognise(NO_RETURN_DECODER, ['b', 'a'])).toBeNull();
    // With the `return` back it is one, so the gate is the `return` alone.
    const returning = NO_RETURN_DECODER.replace('var e = a();\n}', 'var e = a();\n    return e[c];\n}');
    expect(recognise(returning, ['b', 'a'])?.evidence).toContain('index lookup');
  });

  it('keeps the program’s hang at every preset', async () => {
    // The input never returns; a realm budget short enough to test on stands
    // in for forever, and the output must run out of it the same way.
    const before = execute(NO_RETURN_DECODER, 250);
    expect(before).toMatch(/^THROWN Error: Script execution timed out/);
    const outputs = await expectSameBehaviourEverywhere(NO_RETURN_DECODER, {}, 250);
    for (const code of Object.values(outputs)) expect(code).not.toMatch(/['"]726928KKSHfU['"]\s*\+/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// B3: a builtin the program writes to
// ---------------------------------------------------------------------------

const DECODER_UTF8 = `
var table = ['%C3%BCn%C3%AF', 'plain', 'other'];
function dec(i) { return decodeURIComponent(table[i]); }
log(dec(0), dec(1));
`;

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

/** Each writes the builtin the decoder reads, in a way no scope chain shows. */
const WRITES: Record<string, { source: string; prints: string; write: string }> = {
  'globalThis.<name> = at program level': {
    source: `globalThis.decodeURIComponent = function (s) { return 'X' + s; };${DECODER_UTF8}`,
    prints: '"X%C3%BCn%C3%AF" "Xplain"',
    write: '`globalThis.decodeURIComponent = ...` at line 1',
  },
  'this.<name> = at program level': {
    source: `this.decodeURIComponent = function (s) { return 'Y' + s; };${DECODER_UTF8}`,
    prints: '"Y%C3%BCn%C3%AF" "Yplain"',
    write: '`this.decodeURIComponent = ...` at line 1',
  },
  'a property of an allowlisted global': {
    source: `String.fromCharCode = function () { return 'Z'; };${DECODER_CHARS}`,
    prints: '"ZZZ" "ZZZZZ"',
    write: '`String.fromCharCode = ...` at line 1',
  },
  'a bare assignment inside a setup() called first': {
    source: `function setup() { decodeURIComponent = function (s) { return 'W' + s; }; }\nsetup();${DECODER_UTF8}`,
    prints: '"W%C3%BCn%C3%AF" "Wplain"',
    write: '`decodeURIComponent = ...` at line 1',
  },
  'window.<name> =': {
    source: `var window = globalThis;\nwindow.decodeURIComponent = function (s) { return 'V' + s; };${DECODER_UTF8}`,
    prints: '"V%C3%BCn%C3%AF" "Vplain"',
    write: '`window.decodeURIComponent = ...` at line 2',
  },
};

describe('B3: a builtin the program writes to', () => {
  for (const [what, { source, prints, write }] of Object.entries(WRITES)) {
    it(`refuses the decoder and prints what the program prints, for ${what}`, async () => {
      expect(execute(source)).toBe(prints);
      const { decoder, notes } = build(source, ['dec', 'table']);
      expect(decoder).toBeUndefined();
      const refusal = notes.find((note) => note.message.includes('the program assigns to'));
      expect(refusal?.severity).toBe('warning');
      expect(refusal?.message).toContain(`assigns to ${write}`);
      const outputs = await expectSameBehaviourEverywhere(source);
      // The table stays, refused; the builtin's reading must not.
      for (const code of Object.values(outputs)) expect(code).not.toMatch(/['"]ünï['"]/);
    });
  }

  it('reads every shape an assignment takes', () => {
    const shapes: Record<string, string> = {
      'a computed key that is a string literal': "globalThis['String'] = 0;",
      'a prototype method the slice calls': 'String.prototype.split = 0;',
      'a prototype method the slice calls, on another builtin': 'Array.prototype.split = 0;',
      'a prototype replaced whole': 'String.prototype = 0;',
      'a computed property under the name': "String['fromCharCode'] = 0;",
      'a compound assignment': 'String.fromCharCode += 0;',
      'an update': 'String.fromCharCode++;',
      'a delete': 'delete String.fromCharCode;',
      'a destructuring target': '[String.fromCharCode] = [0];',
      'an object destructuring target': '({ f: String.fromCharCode } = { f: 0 });',
      'a for-in head': 'for (String.fromCharCode in {}) {}',
      'a for-of head': 'for (String.fromCharCode of []) {}',
      'self.<name>': 'self.String = 0;',
      'global.<name>': 'global.String = 0;',
      'this.<name> inside a function': 'function f() { this.String = 0; }',
      'a bare assignment under a with': 'with ({}) { String = 0; }',
      'a write through a type assertion': '(String as any).fromCharCode = 0;',
    };
    for (const [what, write] of Object.entries(shapes)) {
      const { decoder, notes } = build(`${write}\n${DECODER_CHARS}`, ['dec', 'table']);
      expect(decoder, what).toBeUndefined();
      expect(
        notes.some((note) => note.message.includes('the program assigns to')),
        what,
      ).toBe(true);
    }
  });

  it('leaves a decoder alone when the write is not to a builtin it reads', () => {
    const untouched: Record<string, string> = {
      'a write to another global': 'globalThis.jQuery = 0; window.$ = 0;',
      'a write to a builtin the decoder does not read':
        'Date.now = function () { return 0; }; Math.random = 0;',
      'a local of the same name, assigned': 'function f() { var String = {}; String = 0; }',
      'a property of the builtin the decoder does not read': 'String.raw = 0; String.prototype.trim = 0;',
      'a property below the method the decoder calls': 'String.fromCharCode.cached = 0;',
      'this[k] = inside a function': 'function C(k) { this[k] = 0; }',
      'a hand-off to a call': '[1, 2].map(String); Object.assign(globalThis, {});',
      'a read': 'log(String.fromCharCode(65));',
    };
    for (const [what, write] of Object.entries(untouched)) {
      const { decoder, notes } = build(`${write}\n${DECODER_CHARS}`, ['dec', 'table']);
      expect(decoder?.decode([1]), what).toBe('plain');
      expect(
        notes.some((note) => note.message.includes('the program assigns to')),
        what,
      ).toBe(false);
    }
  });
});

describe('B3: a write whose key cannot be read', () => {
  /** Each may be a write to what the decoder reads, for all the tree says. */
  const unread: Record<string, string> = {
    'a computed property of the builtin': "var k = [...'x'].join(''); String[k] = 0;",
    'a computed property of the global object': "var k = [...'x'].join(''); globalThis[k] = 0;",
    'a computed property of this at the top of the program': "var k = [...'x'].join(''); this[k] = 0;",
    'a computed method of a prototype': "var k = [...'x'].join(''); Array.prototype[k] = 0;",
  };

  it('is refused at conservative, which inlines only what is proved', () => {
    for (const [what, write] of Object.entries(unread)) {
      const { decoder, notes } = build(`${write}\n${DECODER_CHARS}`, ['dec', 'table'], { preset: 'conservative' });
      expect(decoder, what).toBeUndefined();
      const refusal = notes.find((note) => note.message.includes('the program assigns to'));
      expect(refusal?.message, what).toContain('the conservative preset inlines only what is proved');
    }
  });

  it('is taken for a helper at balanced and aggressive, and said once a round', () => {
    for (const preset of ['balanced', 'aggressive'] as const) {
      for (const [what, write] of Object.entries(unread)) {
        const { decoder, notes } = build(`${write}\n${DECODER_CHARS}`, ['dec', 'table'], { preset });
        expect(decoder?.decode([1]), what).toBe('plain');
        const said = notes.filter((note) => note.message.startsWith("Taking the program's assignment to"));
        expect(said.length, what).toBe(1);
        expect(said[0]?.severity, what).toBe('warning');
      }
    }
  });

  it('is what obfuscated2.js does to Math, beside a decoder that calls Math.round', () => {
    // `Math[dec(0x657b) + 'p'] = function (a, b, c) { ... }` is `Math.clamp`;
    // refusing every decoder that reads `Math` for it left 1.7 MB encoded.
    const source = `
      var table = ['alpha', 'beta', 'gamma'];
      function dec(i) { return table[Math.round(i)]; }
      Math[dec(0) + 'p'] = function (a, b, c) { return Math.min(Math.max(a, b), c); };
      log(dec(1));
    `;
    // The key is computed by the decoder itself, and its own tier reads it
    // - 'alphap', no `round` - the way it reads `Object[dec(0x1)](o)`: on
    // the same footing as every write, and so at every preset.
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { decoder, notes } = build(source, ['dec', 'table'], { preset });
      expect(decoder?.decode([1]), preset).toBe('beta');
      expect(notes.some((note) => note.message.includes('Refusing')), preset).toBe(false);
    }
    // The same key read as `round` is the write it is, at every preset.
    const round = source.replace("Math[dec(0) + 'p']", "function other(i) { return [...'ro'].join(''); }\n      Math[other(0) + 'und']");
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { decoder, notes } = build(round, ['dec', 'table'], { preset });
      expect(decoder, preset).toBeUndefined();
      expect(notes.some((note) => /assigns to `Math\[...\] = ...` at line 5, so Math is not the builtin every tier would run/.test(note.message)), preset).toBe(true);
    }
  });
});

describe('B3: a builtin code compiled from a string can reach', () => {
  const readable = `Function('decodeURIComponent = function (s) { return "U" + s; }')();${DECODER_UTF8}`;

  it('is refused where the preset refuses the table, and the source is executed', async () => {
    expect(execute(readable)).toBe('"U%C3%BCn%C3%AF" "Uplain"');
    // The conservative preset leaves the wrapper closed, so the assignment is
    // only ever a string, and the string-code fact is what refuses it.
    const { decoder, notes } = build(readable, ['dec', 'table'], {
      preset: 'conservative',
    });
    expect(decoder).toBeUndefined();
    expect(
      notes.some((note) => note.message.includes('code compiled from a string can reach decodeURIComponent')),
    ).toBe(true);
    await expectSameBehaviourEverywhere(readable);
  });

  it('is taken and disclosed where the preset decodes despite string code', () => {
    const { decoder, notes } = build(readable, ['dec', 'table'], {
      preset: 'conservative',
      techniques: { stringDecoding: { decodeDespiteStringCode: true } },
    });
    expect(decoder?.decode([1])).toBe('plain');
    expect(
      notes.some((note) => note.message.startsWith('Evaluating dec anyway: code compiled from a string')),
    ).toBe(true);
  });

  it('is asked of an unreadable source too, and blames it', () => {
    const unreadable = `var src = ['decodeURIComponent = 0'].join(''); Function(src)();${DECODER_UTF8}`;
    const { decoder, notes } = build(unreadable, ['dec', 'table'], {
      preset: 'balanced',
    });
    expect(decoder).toBeUndefined();
    const refusal = notes.find((note) => note.message.includes('code compiled from a string can reach'));
    expect(refusal?.message).toContain(
      'The source is `Function(...)` at line 1, which this analysis cannot read.',
    );
  });

  it('is asked of the source alone in a module, where a builtin is as reachable as in a script', async () => {
    // A webpack `Function('return this')()` shim in an ESM bundle spells no
    // builtin the decoder reads; the binding question would have answered
    // "any global-scope construct at all" for the module and refused it.
    const shim = `var root = Function('return this')();\nexport {};${DECODER_UTF8}`;
    const { decoder, notes } = build(shim, ['dec', 'table'], { preset: 'balanced' }, 'module');
    expect(decoder?.decode([1])).toBe('plain');
    expect(notes.some((note) => note.message.includes('code compiled from a string'))).toBe(false);
    // And one that does spell it is refused there as in a script.
    const spelled = `var root = Function('decodeURIComponent = 0')();\nexport {};${DECODER_UTF8}`;
    expect(build(spelled, ['dec', 'table'], { preset: 'balanced' }, 'module').decoder).toBeUndefined();
  });

  it('is asked of the source alone beside a direct eval, which is not asked about', async () => {
    const both = `var root = Function('return this')();\nvar n = eval('1 + 1');${DECODER_UTF8}`;
    expect(execute(both)).toBe('"ünï" "plain"');
    const { decoder, notes } = build(both, ['dec', 'table'], { preset: 'balanced' });
    expect(decoder?.decode([1])).toBe('plain');
    expect(notes.some((note) => note.message.includes('code compiled from a string'))).toBe(false);
    await expectSameBehaviourEverywhere(both);
  });

  it('spells nothing for a source that names no builtin the decoder reads', () => {
    const shim = `var root = Function('return this')();${DECODER_UTF8}`;
    const { decoder, notes } = build(shim, ['dec', 'table'], {
      preset: 'balanced',
    });
    expect(decoder?.decode([1])).toBe('plain');
    expect(notes.some((note) => note.message.includes('code compiled from a string'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B3 boundaries: a builtin written without being named
// ---------------------------------------------------------------------------

/** XOR with nothing, so the decoder calls `charCodeAt` on its entries. */
const DECODER_CODES = `
var table = ['abc', 'plain', 'other'];
function dec(i) { var s = table[i], o = ''; for (var k = 0; k < s.length; k++) o += String.fromCharCode(s.charCodeAt(k) ^ 0); return o; }
log(dec(0), dec(1));
`;

const DECODER_ROUND = `
var table = ['alpha', 'beta', 'gamma'];
function dec(i) { return table[Math.round(i)]; }
log(dec(0), dec(1));
`;

/** Indexed through `toString`, so the decoder calls it on its argument. */
const DECODER_TOSTRING = `
var table = { '0': 'alpha', '1': 'beta', '2': 'gamma' };
function dec(i) { return table[i.toString()]; }
log(dec(0), dec(1));
`;

const ROTATED = `function a() { var z = ['1', '2', '3', 'fn:']; a = function () { return z; }; return a(); }
function b(P) { P = P - 296; var U = a(), w = U[P]; return w; }
(function (z, U) { var C = z(); while (true) { try { var p = parseInt(b(0x128)) / 1; if (p === U) break; else C.push(C.shift()); } catch (q) { C.push(C.shift()); } } })(a, 3);
function classify(z) { return b(0x12b) + z.name; }
log(classify(function nm() {}));
`;

interface Boundary {
  source: string;
  /** What the program prints; the proof the write reaches the builtin. */
  prints: string;
  /** How the refusal spells the write. */
  write: string;
  roots?: string[];
}

const utf8 = (write: string, spelled: string, prints = '"X%C3%BCn%C3%AF" "Xplain"'): Boundary => ({
  source: `${write}${DECODER_UTF8}`,
  prints,
  write: spelled,
});
const chars = (write: string, spelled: string, prints = '"ZZZ" "ZZZZZ"'): Boundary => ({
  source: `${write}${DECODER_CHARS}`,
  prints,
  write: spelled,
});

const ALIASES: Record<string, Boundary> = {
  'var S = String; S.fromCharCode': chars(
    "var S = String; S.fromCharCode = function () { return 'Z'; };",
    '`S.fromCharCode = ...` at line 1',
  ),
  'var P = String.prototype; P.split': chars(
    "var P = String.prototype; P.split = function () { return ['90']; };",
    '`P.split = ...` at line 1',
    '"Z" "Z"',
  ),
  'const { prototype } = String; prototype.split': chars(
    "const { prototype } = String; prototype.split = function () { return ['90']; };",
    '`prototype.split = ...` at line 1',
    '"Z" "Z"',
  ),
  'var g = globalThis; g.decodeURIComponent': utf8(
    "var g = globalThis; g.decodeURIComponent = function (s) { return 'X' + s; };",
    '`g.decodeURIComponent = ...` at line 1',
  ),
  'an alias of an alias': chars(
    "var A = String, B = A; B.fromCharCode = function () { return 'Z'; };",
    '`B.fromCharCode = ...` at line 1',
  ),
  'var root = this at the top of the program': utf8(
    "var root = this; root.decodeURIComponent = function (s) { return 'X' + s; };",
    '`root.decodeURIComponent = ...` at line 1',
  ),
  'const { prototype: P } = String; P.charCodeAt': {
    source: `const { prototype: P } = String; P.charCodeAt = function () { return 90; };${DECODER_CODES}`,
    prints: '"ZZZ" "ZZZZZ"',
    write: '`P.charCodeAt = ...` at line 1',
  },
  'var S = globalThis.String': chars(
    "var S = globalThis.String; S.fromCharCode = function () { return 'Z'; };",
    '`S.fromCharCode = ...` at line 1',
  ),
  'an alias declared and written inside a function the program calls': chars(
    "function patch() { var S = String; S.fromCharCode = function () { return 'Z'; }; }\npatch();",
    '`S.fromCharCode = ...` at line 1',
  ),
  'var M = Math; M.round': {
    source: `var M = Math; M.round = function () { return 0; };${DECODER_ROUND}`,
    prints: '"alpha" "alpha"',
    write: '`M.round = ...` at line 1',
  },
};

const REFLECTIVE: Record<string, Boundary> = {
  'Object.defineProperty(globalThis, ...)': utf8(
    "Object.defineProperty(globalThis, 'decodeURIComponent', { value: function (s) { return 'X' + s; } });",
    '`Object.defineProperty(globalThis, "decodeURIComponent", ...)` at line 1',
  ),
  'Object.defineProperty(String, ...)': chars(
    "Object.defineProperty(String, 'fromCharCode', { value: function () { return 'Z'; } });",
    '`Object.defineProperty(String, "fromCharCode", ...)` at line 1',
  ),
  'Object.defineProperty(String.prototype, ...)': chars(
    "Object.defineProperty(String.prototype, 'split', { value: function () { return ['90']; } });",
    '`Object.defineProperty(String.prototype, "split", ...)` at line 1',
    '"Z" "Z"',
  ),
  'Object.defineProperties(globalThis, {...})': utf8(
    "Object.defineProperties(globalThis, { decodeURIComponent: { value: function (s) { return 'X' + s; } } });",
    '`Object.defineProperties(globalThis, {...})` at line 1',
  ),
  'Object.assign(globalThis, {...})': utf8(
    "Object.assign(globalThis, { decodeURIComponent: function (s) { return 'X' + s; } });",
    '`Object.assign(globalThis, {...})` at line 1',
  ),
  'Object.assign(String, {...})': chars(
    "Object.assign(String, { fromCharCode: function () { return 'Z'; } });",
    '`Object.assign(String, {...})` at line 1',
  ),
  'Reflect.set(globalThis, ...)': utf8(
    "Reflect.set(globalThis, 'decodeURIComponent', function (s) { return 'X' + s; });",
    '`Reflect.set(globalThis, "decodeURIComponent", ...)` at line 1',
  ),
  'Reflect.defineProperty(String, ...)': chars(
    "Reflect.defineProperty(String, 'fromCharCode', { value: function () { return 'Z'; } });",
    '`Reflect.defineProperty(String, "fromCharCode", ...)` at line 1',
  ),
  'Object.defineProperty(this, ...) at the top of the program': utf8(
    "Object.defineProperty(this, `decodeURIComponent`, { value: function (s) { return 'X' + s; } });",
    '`Object.defineProperty(this, "decodeURIComponent", ...)` at line 1',
  ),
  'Object.defineProperty(Object.getPrototypeOf(...), ...)': chars(
    "Object.defineProperty(Object.getPrototypeOf(''), 'split', { value: function () { return ['90']; } });",
    '`Object.defineProperty(Object.getPrototypeOf(...), "split", ...)` at line 1',
    '"Z" "Z"',
  ),
};

const THROUGH_A_VALUE: Record<string, Boundary> = {
  'Object.getPrototypeOf(x).m': chars(
    "Object.getPrototypeOf('').split = function () { return ['90']; };",
    '`Object.getPrototypeOf(...).split = ...` at line 1',
    '"Z" "Z"',
  ),
  'x.__proto__.m': chars("''.__proto__.split = function () { return ['90']; };", '`....__proto__.split = ...` at line 1', '"Z" "Z"'),
  'x.constructor.prototype.m': chars(
    "''.constructor.prototype.split = function () { return ['90']; };",
    '`....constructor.prototype.split = ...` at line 1',
    '"Z" "Z"',
  ),
  'Reflect.getPrototypeOf(x).m': chars(
    "Reflect.getPrototypeOf(new String('')).split = function () { return ['90']; };",
    '`Reflect.getPrototypeOf(...).split = ...` at line 1',
    '"Z" "Z"',
  ),
  'a prototype method the decoder calls on its entries': {
    source: `Object.getPrototypeOf('').charCodeAt = function () { return 90; };${DECODER_CODES}`,
    prints: '"ZZZ" "ZZZZZ"',
    write: '`Object.getPrototypeOf(...).charCodeAt = ...` at line 1',
  },
  'an alias of a prototype read': chars(
    "var p = Object.getPrototypeOf(''); p.split = function () { return ['90']; };",
    '`p.split = ...` at line 1',
    '"Z" "Z"',
  ),
  'x.constructor.m, a static of some constructor': chars(
    "''.constructor.fromCharCode = function () { return 'Z'; };",
    '`....constructor.fromCharCode = ...` at line 1',
  ),
  'the push a rotation loop calls on its table': {
    source: `[].__proto__.push = function () { return 0; };\n${ROTATED}`,
    prints: '"undefinednm"',
    write: '`....__proto__.push = ...` at line 1',
    roots: ['b', 'a'],
  },
  'a method the decoder calls on its argument': {
    source: `(0).__proto__.toString = function () { return '1'; };${DECODER_TOSTRING}`,
    prints: '"beta" "beta"',
    write: '`....__proto__.toString = ...` at line 1',
  },
  'x.constructor.prototype[k] with a readable k': chars(
    "var m = 'split'; ''.constructor.prototype[m] = function () { return ['90']; };",
    '`....constructor.prototype[...] = ...` at line 1',
    '"Z" "Z"',
  ),
};

const READABLE_KEYS: Record<string, Boundary> = {
  "var k = 'round'; Math[k]": {
    source: `var k = 'round'; Math[k] = function () { return 0; };${DECODER_ROUND}`,
    prints: '"alpha" "alpha"',
    write: '`Math[...] = ...` at line 1',
  },
  "var k = 'decodeURIComponent'; globalThis[k]": utf8(
    "var k = 'decodeURIComponent'; globalThis[k] = function (s) { return 'X' + s; };",
    '`globalThis[...] = ...` at line 1',
  ),
  "var k = 'fromCharCode'; String[k]": chars(
    "var k = 'fromCharCode'; String[k] = function () { return 'Z'; };",
    '`String[...] = ...` at line 1',
  ),
  "var k = 'split'; String.prototype[k]": chars(
    "var k = 'split'; String.prototype[k] = function () { return ['90']; };",
    '`String.prototype[...] = ...` at line 1',
    '"Z" "Z"',
  ),
  "const k = 'decodeURIComponent'; this[k] at the top of the program": utf8(
    "const k = 'decodeURIComponent'; this[k] = function (s) { return 'X' + s; };",
    '`this[...] = ...` at line 1',
  ),
  'a readable key handed to Object.defineProperty': utf8(
    "var k = 'decodeURIComponent'; Object.defineProperty(globalThis, k, { value: function (s) { return 'X' + s; } });",
    '`Object.defineProperty(globalThis, ..., ...)` at line 1',
  ),
  "var k = 'split'; Array.prototype[k], the cheap side of the prototype rule": chars(
    "var k = 'split'; Array.prototype[k] = function () { return ['90']; };",
    '`Array.prototype[...] = ...` at line 1',
    '"ünï" "plain"',
  ),
  'a template literal key': {
    source: `var k = \`round\`; Math[k] = function () { return 0; };${DECODER_ROUND}`,
    prints: '"alpha" "alpha"',
    write: '`Math[...] = ...` at line 1',
  },
  'a key declared and written inside a function the program calls': {
    source: `function f() { var k = 'round'; Math[k] = function () { return 0; }; }\nf();${DECODER_ROUND}`,
    prints: '"alpha" "alpha"',
    write: '`Math[...] = ...` at line 1',
  },
  'a readable key through an alias': chars(
    "var k = 'fromCharCode'; var S = String; S[k] = function () { return 'Z'; };",
    '`S[...] = ...` at line 1',
  ),
};

describe('B3 boundaries: a builtin written without being named', () => {
  const letters: [string, Record<string, Boundary>][] = [
    ['an alias of a global or of its prototype', ALIASES],
    ['a reflective write', REFLECTIVE],
    ['a prototype or constructor reached through a value', THROUGH_A_VALUE],
    ['a computed key the tree can read', READABLE_KEYS],
  ];
  for (const [letter, shapes] of letters) {
    describe(letter, () => {
      for (const [what, { source, prints, write, roots }] of Object.entries(shapes)) {
        it(`refuses at every preset and prints what the program prints, for ${what}`, async () => {
          expect(execute(source)).toBe(prints);
          for (const preset of PRESETS) {
            const { decoder, notes } = build(source, roots ?? ['dec', 'table'], { preset });
            expect(decoder, preset).toBeUndefined();
            const refusal = notes.find((note) => note.message.includes('the program assigns to'));
            expect(refusal?.message, preset).toContain(`assigns to ${write}`);
            expect(refusal?.message, preset).not.toContain('the conservative preset inlines only what is proved');
          }
          await expectSameBehaviourEverywhere(source);
        });
      }
    });
  }

  it('follows the routes one hop past the letters: with, .call/.apply, a destructured key', async () => {
    const hops: Record<string, { source: string; prints: string; write: string }> = {
      'a bare assignment under with (String)': {
        source: `with (String) { fromCharCode = function () { return 'Z'; }; }${DECODER_CHARS}`,
        prints: '"ZZZ" "ZZZZZ"',
        write: '`fromCharCode = ...` at line 1',
      },
      'a bare assignment under with over an alias': {
        source: `var S = String; with (S) { fromCharCode = function () { return 'Z'; }; }${DECODER_CHARS}`,
        prints: '"ZZZ" "ZZZZZ"',
        write: '`fromCharCode = ...` at line 1',
      },
      'Object.defineProperty.call': {
        source: `Object.defineProperty.call(null, String, 'fromCharCode', { value: function () { return 'Z'; } });${DECODER_CHARS}`,
        prints: '"ZZZ" "ZZZZZ"',
        write: '`Object.defineProperty.call(..., ..., ...)` at line 1',
      },
      'Reflect.set.apply': {
        source: `Reflect.set.apply(null, [globalThis, 'decodeURIComponent', function (s) { return 'X' + s; }]);${DECODER_UTF8}`,
        prints: '"X%C3%BCn%C3%AF" "Xplain"',
        write: '`Reflect.set.apply(..., ..., ...)` at line 1',
      },
      'a key destructured from an array literal': {
        source: `const [, k] = ['clamp', 'round']; Math[k] = function () { return 0; };${DECODER_ROUND}`,
        prints: '"alpha" "alpha"',
        write: '`Math[...] = ...` at line 1',
      },
      'a key destructured past a rest, the rest a fresh array of what was left': {
        source: `const [...rest] = ['round']; var k = rest[0]; Math[k] = function () { return 0; };${DECODER_ROUND}`,
        prints: '"alpha" "alpha"',
        write: '`Math[...] = ...` at line 1',
      },
      'a key destructured from an object literal, the last spelling winning': {
        source: `const { key: k } = { key: 'clamp', key: 'round' }; Math[k] = function () { return 0; };${DECODER_ROUND}`,
        prints: '"alpha" "alpha"',
        write: '`Math[...] = ...` at line 1',
      },
    };
    for (const [what, { source, prints, write }] of Object.entries(hops)) {
      expect(execute(source), what).toBe(prints);
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['dec', 'table'], { preset });
        expect(decoder, `${what} at ${preset}`).toBeUndefined();
        const refusal = notes.find((note) => note.message.includes('the program assigns to'));
        expect(refusal?.message, `${what} at ${preset}`).toContain(`assigns to ${write}`);
      }
      await expectSameBehaviourEverywhere(source);
    }
    // A bare name under a `with` over an object the tree cannot name is the
    // unread case.
    const unread: Record<string, string> = {
      'with over a local object': "var o = {}; with (o) { round = 0; }",
    };
    for (const [what, write] of Object.entries(unread)) {
      expect(build(`${write}\n${DECODER_ROUND}`, ['dec', 'table'], { preset: 'conservative' }).decoder, what).toBeUndefined();
      expect(build(`${write}\n${DECODER_ROUND}`, ['dec', 'table'], { preset: 'balanced' }).decoder?.decode([1]), what).toBe('beta');
    }
  }, 60_000);

  it('leaves a decoder alone when the alias, key or hand-off does not reach what it reads', () => {
    const untouched: Record<string, string> = {
      'an alias of another global': 'var D = Date; D.now = function () { return 0; };',
      'an alias whose declarator is not from a global': "var S = { fromCharCode: 1 }; S.fromCharCode = 0;",
      'an alias of the global object writing another name': 'var g = globalThis; g.jQuery = 0;',
      'a readable key that names a property the decoder does not read': "var k = 'raw'; String[k] = 0;",
      'a reflective write of a property the decoder does not read':
        "Object.defineProperty(String, 'raw', { value: 0 }); Object.assign(globalThis, { jQuery: 0 });",
      'a hand-off that is not a write': '[1, 2].map(String); patch(String.prototype); Object.keys(String);',
      'a value’s own property, written through __proto__ or constructor at the end of the chain':
        "var o = {}; o.__proto__ = null; o.constructor = String;",
      'a prototype write of a member the decoder never touches':
        "Object.getPrototypeOf('').trim = 0; ''.__proto__.padEnd = 0;",
    };
    for (const [what, write] of Object.entries(untouched)) {
      const { decoder, notes } = build(`${write}\n${DECODER_CHARS}`, ['dec', 'table']);
      expect(decoder?.decode([1]), what).toBe('plain');
      expect(notes.some((note) => note.message.includes('the program assigns to')), what).toBe(false);
    }
  });

  it('takes a key it truly cannot read for a helper at balanced, and refuses it at conservative', () => {
    // An alias or a key reassigned from a source the tree CAN read is every
    // one of its readings, and refused wherever a reading reaches the
    // decoder - `var S = String; S = Math; S.round = 0` is a write to
    // `Math.round`, see the may-writes below. Unread is a source it cannot
    // open: a call to a function the tree does not declare.
    const unread: Record<string, string> = {
      'an alias reassigned from a call the tree cannot open': 'var S = String; S = load(); S.round = 0;',
      'a key reassigned from a call the tree cannot open': "var k = 'clamp'; k = load(); Math[k] = 0;",
      'a key that is a parameter of a function handed elsewhere': "function f(k) { Math[k] = 0; } f('clamp'); keep(f);",
      'Object.assign from a holder the tree cannot open': 'var patch = load(); Object.assign(Math, patch);',
      'a new prototype': 'Object.setPrototypeOf(Math, {});',
    };
    for (const [what, write] of Object.entries(unread)) {
      const balanced = build(`${write}\n${DECODER_ROUND}`, ['dec', 'table'], { preset: 'balanced' });
      expect(balanced.decoder?.decode([1]), what).toBe('beta');
      expect(
        balanced.notes.some((note) => note.message.startsWith("Taking the program's assignment to")),
        what,
      ).toBe(true);
      const conservative = build(`${write}\n${DECODER_ROUND}`, ['dec', 'table'], { preset: 'conservative' });
      expect(conservative.decoder, what).toBeUndefined();
    }
  });

  it('still takes obfuscated2.js’s Math[dec() + "p"] for the helper it is', () => {
    const source = `
      var table = ['alpha', 'beta', 'gamma'];
      function dec(i) { return table[Math.round(i)]; }
      Math[dec(0) + 'p'] = function (a, b, c) { return Math.min(Math.max(a, b), c); };
      log(dec(1));
    `;
    const { decoder, notes } = build(source, ['dec', 'table'], { preset: 'balanced' });
    expect(decoder?.decode([1])).toBe('beta');
    expect(notes.some((note) => note.message.includes('Refusing'))).toBe(false);
  });

  it('keeps the guarded polyfill refusal, which is a correct refusal', async () => {
    const polyfill = `if (!Array.prototype.indexOf) { Array.prototype.indexOf = function (x) { for (var i = 0; i < this.length; i++) if (this[i] === x) return i; return -1; }; }
var table = ['aGVsbG8=', 'd29ybGQ='];
function dec(i) {
  var s = table[i], a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=', o = '', c, b, k = 0;
  while (k < s.length) {
    var e1 = a.indexOf(s.charAt(k++)), e2 = a.indexOf(s.charAt(k++)), e3 = a.indexOf(s.charAt(k++)), e4 = a.indexOf(s.charAt(k++));
    o += String.fromCharCode((e1 << 2) | (e2 >> 4));
    if (e3 !== 64) o += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
    if (e4 !== 64) o += String.fromCharCode(((e3 & 3) << 6) | e4);
  }
  return o;
}
log(dec(0), dec(1));`;
    const { decoder, notes } = build(polyfill, ['dec', 'table']);
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('`Array.prototype.indexOf = ...` at line 1'))).toBe(true);
    await expectSameBehaviourEverywhere(polyfill);
  });
});

describe('B3 boundaries: the write named is the first in program order', () => {
  const pairs: Record<string, string> = {
    'two assignments': "String.fromCharCode = function () { return 'first'; };\nString.fromCharCode = function () { return 'second'; };",
    'a reflective write then an assignment':
      "Object.defineProperty(String, 'fromCharCode', { value: function () { return 'first'; }, writable: true });\nString.fromCharCode = function () { return 'second'; };",
    'an assignment then a reflective write':
      "String.fromCharCode = function () { return 'first'; };\nObject.defineProperty(String, 'fromCharCode', { value: function () { return 'second'; } });",
    'an alias then the global': "var S = String; S.fromCharCode = function () { return 'first'; };\nString.fromCharCode = function () { return 'second'; };",
    'the global then an alias': "String.fromCharCode = function () { return 'first'; };\nvar S = String; S.fromCharCode = function () { return 'second'; };",
    'a write inside a function called first, then one at the top':
      "function f() { String.fromCharCode = function () { return 'first'; }; }\nf(); String.fromCharCode = function () { return 'second'; };",
    'a readable key then a named write':
      "var k = 'fromCharCode'; String[k] = function () { return 'first'; };\nString.fromCharCode = function () { return 'second'; };",
    'a prototype write then a static':
      "String.prototype.split = function () { return ['65']; };\nString.fromCharCode = function () { return 'second'; };",
    'a write through a value then a named write':
      "''.constructor.fromCharCode = function () { return 'first'; };\nString.fromCharCode = function () { return 'second'; };",
    'an update then an assignment':
      "String.fromCharCode++;\nString.fromCharCode = function () { return 'second'; };",
  };
  for (const [what, writes] of Object.entries(pairs)) {
    it(`names line 1 for ${what}`, async () => {
      const source = `${writes}${DECODER_CHARS}`;
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['dec', 'table'], { preset });
        expect(decoder, preset).toBeUndefined();
        const refusal = notes.find((note) => note.message.includes('the program assigns to'));
        expect(refusal?.message, preset).toMatch(/at line 1, so/);
      }
      await expectSameBehaviourEverywhere(source);
    });
  }
});

// ---------------------------------------------------------------------------
// B3 and C2, one hop past the letters: the residual spellings
// ---------------------------------------------------------------------------

/**
 * Every shape here was a wrong rewrite before the index read it - silent at
 * every preset, or taken at balanced for a helper with a disclosure that
 * said the key or the object could not be read when the tree could read it
 * as one of several values, one of them what the decoder reads. Each is
 * executed at every preset and refused at every preset; the refusal names
 * the write, and says "may" where the write has more than one reading.
 */
const OPAQUE = (word: string): string => `String([...'${word}'].join(''))`;
const FCC = "function () { return 'Z'; }";
const SPL = "function () { return ['90']; }";

interface Residual {
  source: string;
  prints: string;
  /** A fragment of the reason the refusal gives. */
  reason: string;
}

const residualChars = (write: string, reason: string, prints = '"ZZZ" "ZZZZZ"'): Residual => ({
  source: `${write}${DECODER_CHARS}`,
  prints,
  reason,
});
const residualRound = (write: string, reason: string, prints = '"alpha" "alpha"'): Residual => ({
  source: `${write}${DECODER_ROUND}`,
  prints,
  reason,
});
const MAY = 'may not be the builtin every tier would run';
const IS = 'is not the builtin every tier would run';
const SPLIT_IS = 'the split the slice reads on a value is not the builtin';
const ON_UNREAD_OBJECT = 'on an object the tree cannot read';

const RESIDUALS: Record<string, Record<string, Residual>> = {
  'a. an alias bound by assignment, or by more than one source': {
    'S = T = String': residualChars(`var S, T; S = T = String; S.fromCharCode = ${FCC};`, IS),
    'for (S of [String])': residualChars(`var S; for (S of [String]) {} S.fromCharCode = ${FCC};`, IS),
    'S ??= String over var S = null': residualChars(`var S = null; S ??= String; S.fromCharCode = ${FCC};`, MAY),
    'S ||= String over var S = 0': residualChars(`var S = 0; S ||= String; S.fromCharCode = ${FCC};`, MAY),
    'S &&= String over var S = 1': residualChars(`var S = 1; S &&= String; S.fromCharCode = ${FCC};`, MAY),
    'a conditional of two globals, the decoder reading one': residualRound(
      'var S = globalThis.K ? String : Math; S.round = function () { return 0; };',
      MAY,
    ),
    'an alias reassigned to another global the decoder reads': residualRound(
      'var S = String; S = Math; S.round = function () { return 0; };',
      MAY,
    ),
    'a typeof guard': residualChars(`var S = typeof String === 'function' ? String : null; S.fromCharCode = ${FCC};`, MAY),
    'a destructuring assignment': residualChars(`var S; [S] = [String]; S.fromCharCode = ${FCC};`, IS),
    'what a function of this file returns': residualChars(
      `function id(x) { return x; } var S = id(String); S.fromCharCode = ${FCC};`,
      IS,
    ),
    'an alias of an alias, both by assignment': residualChars(`var A; A = String; var B; B = A; B.fromCharCode = ${FCC};`, IS),
  },
  'b. a prototype or constructor read, aliased': {
    'a destructured __proto__': residualChars(`var { __proto__: p } = ''; p.split = ${SPL};`, SPLIT_IS, '"Z" "Z"'),
    'a conditional over a prototype read': residualChars(
      `var p = globalThis.K ? Math : ''.__proto__; p.split = ${SPL};`,
      MAY,
      '"Z" "Z"',
    ),
    'a constructor read, then its prototype': residualChars(
      `var s = 'x'; var c = s.constructor; var p = c.prototype; p.split = ${SPL};`,
      SPLIT_IS,
      '"Z" "Z"',
    ),
    'a constructor bound by assignment': residualChars(`var c; c = ''.constructor; c.fromCharCode = ${FCC};`, IS),
    'the prototype of an alias': residualChars(`var S = String; var P = S.prototype; P.split = ${SPL};`, SPLIT_IS, '"Z" "Z"'),
    'a prototype read bound by assignment': residualChars(`var p; p = Object.getPrototypeOf(''); p.split = ${SPL};`, SPLIT_IS, '"Z" "Z"'),
    'a constructor read through an array literal': residualChars(`var c = [''.constructor][0]; c.fromCharCode = ${FCC};`, IS),
    'Reflect.getPrototypeOf aliased': residualChars(`var p = Reflect.getPrototypeOf(new String('')); p.split = ${SPL};`, SPLIT_IS, '"Z" "Z"'),
    'a prototype alias inside a function the program calls': residualChars(`function f() { var p = ''.__proto__; p.split = ${SPL}; } f();`, SPLIT_IS, '"Z" "Z"'),
    'a literal’s member the tree cannot read, which may be its prototype': residualChars(
      `var k = String(['__proto__'][[].length]); ''[k].split = ${SPL};`,
      ON_UNREAD_OBJECT,
      '"Z" "Z"',
    ),
  },
  'c. the reflective method aliased': {
    'an alias of Reflect.set': residualChars(`var s = Reflect.set; s(String, 'fromCharCode', ${FCC});`, IS),
    'Object.defineProperty bound': residualChars(
      `var d = Object.defineProperty.bind(Object); d(String, 'fromCharCode', { value: ${FCC} });`,
      IS,
    ),
    'a method of an object literal': residualChars(
      `var o = { d: Object.defineProperty }; o.d(String, 'fromCharCode', { value: ${FCC} });`,
      IS,
    ),
    'a parameter handed the method': residualChars(
      `function f(d) { d(String, 'fromCharCode', { value: ${FCC} }); } f(Object.defineProperty);`,
      IS,
    ),
    'an alias that may be one of two methods': residualChars(
      `var d = globalThis.K ? Object.assign : Object.defineProperty; d(String, 'fromCharCode', { value: ${FCC} });`,
      MAY,
    ),
    'the method through globalThis': residualChars(
      `globalThis.Object.defineProperty(String, 'fromCharCode', { value: ${FCC} });`,
      IS,
    ),
    'an alias bound by assignment': residualChars(`var d; d = Object.defineProperty; d(String, 'fromCharCode', { value: ${FCC} });`, IS),
    'an alias of the alias, called through .call': residualChars(
      `var d = Object.defineProperty; var e = d; e.call(Object, String, 'fromCharCode', { value: ${FCC} });`,
      IS,
    ),
    'an alias through Reflect.apply': residualChars(
      `var d = Object.defineProperty; Reflect.apply(d, null, [String, 'fromCharCode', { value: ${FCC} }]);`,
      IS,
    ),
    'an alias through Function.prototype.call.call': residualChars(
      `var d = Object.defineProperty; Function.prototype.call.call(d, null, String, 'fromCharCode', { value: ${FCC} });`,
      IS,
    ),
    'Object.assign aliased': residualChars(`var a = Object.assign; a(String, { fromCharCode: ${FCC} });`, IS),
    'defineProperties destructured': residualChars(
      `const { defineProperties: dp } = Object; dp(String, { fromCharCode: { value: ${FCC} } });`,
      IS,
    ),
  },
  'd. a key read through every source of its binding': {
    'let k = "round"; Math[k] = ...; k = "floor"': residualRound(
      "let k = 'round'; Math[k] = function () { return 2; }; k = 'floor';",
      MAY,
      '"gamma" "gamma"',
    ),
    'reassigned before the write': residualRound(
      "let k = 'floor'; k = 'round'; Math[k] = function () { return 2; };",
      MAY,
      '"gamma" "gamma"',
    ),
    'reassigned twice, to the read name and back': residualRound(
      "let k = 'round'; k = 'floor'; k = 'round'; Math[k] = function () { return 2; };",
      MAY,
      '"gamma" "gamma"',
    ),
    'declared without a value, then assigned': residualRound(
      "let k; k = 'round'; Math[k] = function () { return 2; };",
      MAY,
      '"gamma" "gamma"',
    ),
    'a conditional of two strings': residualRound(
      "var k = globalThis.K ? 'floor' : 'round'; Math[k] = function () { return 2; };",
      MAY,
      '"gamma" "gamma"',
    ),
    'a logical with an unread left': residualRound(
      "var k = globalThis.K || 'round'; Math[k] = function () { return 2; };",
      MAY,
      '"gamma" "gamma"',
    ),
    'reassigned inside a function the program calls': residualRound(
      "var k = 'floor'; function f() { k = 'round'; } f(); Math[k] = function () { return 2; };",
      MAY,
      '"gamma" "gamma"',
    ),
    'a parameter of a fixed function': residualRound(
      "function f(k) { Math[k] = function () { return 2; }; } f('round');",
      IS,
      '"gamma" "gamma"',
    ),
    'an element of an array literal held by a name': residualRound(
      "var ks = ['round']; var k = ks[0]; Math[k] = function () { return 2; };",
      IS,
      '"gamma" "gamma"',
    ),
    'a property two literals deep': residualRound(
      "var o = { a: { k: 'round' } }; Math[o.a.k] = function () { return 2; };",
      IS,
      '"gamma" "gamma"',
    ),
    'a concatenation through an alias': residualRound(
      "var k = 'ro'; var j = k + 'und'; Math[j] = function () { return 2; };",
      IS,
      '"gamma" "gamma"',
    ),
    'a key spelled in part, fitting the name the decoder reads': residualRound(
      `var k = ${OPAQUE('und')}; Math['ro' + k] = function () { return 2; };`,
      MAY,
      '"gamma" "gamma"',
    ),
  },
  'e. a builtin handed to a parameter': {
    'through .call': residualChars(`function f(K) { K.fromCharCode = ${FCC}; } f.call(null, String);`, IS),
    'through .apply': residualChars(`function f(K) { K.fromCharCode = ${FCC}; } f.apply(null, [String]);`, IS),
    'two levels down': residualChars(`function g(K) { K.fromCharCode = ${FCC}; } function f(K) { g(K); } f(String);`, IS),
    'a parameter of a parameter, from an alias': residualChars(
      `function g(K) { K.fromCharCode = ${FCC}; } function f(K) { g(K); } var S = String; f(S);`,
      IS,
    ),
    'a default': residualChars(`function f(K = String) { K.fromCharCode = ${FCC}; } f();`, IS),
    'a destructured parameter': residualChars(`function f({ S: K }) { K.fromCharCode = ${FCC}; } f({ S: String });`, IS),
    'a rest parameter': residualChars(`function f(...K) { K[0].fromCharCode = ${FCC}; } f(String);`, IS),
    'a method of an object literal': residualChars(
      `var o = { f: function (K) { K.fromCharCode = ${FCC}; } }; o.f(String);`,
      IS,
    ),
    'a class static': residualChars(`class U { static f(K) { K.fromCharCode = ${FCC}; } } U.f(String);`, IS),
    'an alias of the function': residualChars(`function f(K) { K.fromCharCode = ${FCC}; } var g = f; g(String);`, IS),
    'an IIFE': residualChars(`(function (K) { K.fromCharCode = ${FCC}; })(String);`, IS),
    'a parameter reassigned to itself': residualChars(`function f(K) { K = K; K.fromCharCode = ${FCC}; } f(String);`, MAY),
    'two callers, one handing a global': residualChars(`function f(K) { K.fromCharCode = ${FCC}; } f({}); f(String);`, MAY),
    'a spread of an array literal': residualChars(`function f(K) { K.fromCharCode = ${FCC}; } f(...[String]);`, IS),
    'a spread of an array a name holds': residualChars(`var xs = [String]; function f(K) { K.fromCharCode = ${FCC}; } f(...xs);`, IS),
    'arguments[0]': residualChars(`function f() { arguments[0].fromCharCode = ${FCC}; } f(String);`, IS),
    'arguments[0] under an arrow, and through an alias': residualChars(
      `function f() { var a = arguments; (() => { a[0].fromCharCode = ${FCC}; })(); } f(String);`,
      IS,
    ),
    'a key from arguments': residualRound("function f() { Math[arguments[0]] = function () { return 2; }; } f('round');", IS, '"gamma" "gamma"'),
    'a callback forEach hands an element of a literal': residualChars(`[String].forEach(function (K) { K.fromCharCode = ${FCC}; });`, IS),
    'a named callback, over an array a name holds': residualChars(
      `var xs = [String]; function f(K) { K.fromCharCode = ${FCC}; } xs.forEach(f);`,
      IS,
    ),
    'a reduce callback, the element second': residualChars(
      `[String].reduce(function (acc, K) { K.fromCharCode = ${FCC}; return acc; }, 0);`,
      IS,
    ),
    'a callback over two elements, one a global': residualChars(`[{}, String].forEach(function (K) { K.fromCharCode = ${FCC}; });`, MAY),
    'a function expression called through a sequence': residualChars(`var S = String; (0, function (K) { K.fromCharCode = ${FCC}; })(S);`, IS),
    'an async function': residualChars(`async function f(K) { K.fromCharCode = ${FCC}; } f(String);`, IS),
    'a generator': residualChars(`function* g(K) { K.fromCharCode = ${FCC}; } g(String).next();`, IS),
    'a method through an alias of its holder, twice': residualChars(
      `var o = { f: function (K) { K.fromCharCode = ${FCC}; } }; var p = o; var q = p; q.f(String);`,
      IS,
    ),
    'a value returned through two functions': residualChars(
      `function id(x) { return x; } function twice(x) { return id(x); } var S = twice(String); S.fromCharCode = ${FCC};`,
      IS,
    ),
    'a constructor read a function returns': residualChars(`function ctor(s) { return s.constructor; } var c = ctor(''); c.fromCharCode = ${FCC};`, IS),
  },
  'C2. an unread hop in the chain, then a member the decoder reads': {
    'globalThis[k].fromCharCode': residualChars(
      `var k = ${OPAQUE('String')}; globalThis[k].fromCharCode = ${FCC};`,
      ON_UNREAD_OBJECT,
    ),
    'globalThis[k].prototype.split': residualChars(
      `var k = ${OPAQUE('String')}; globalThis[k].prototype.split = ${SPL};`,
      ON_UNREAD_OBJECT,
      '"Z" "Z"',
    ),
    'this[k].fromCharCode at the top of the program': residualChars(
      `var k = ${OPAQUE('String')}; this[k].fromCharCode = ${FCC};`,
      ON_UNREAD_OBJECT,
    ),
    'Reflect.set(globalThis[k], ...)': residualChars(
      `var k = ${OPAQUE('String')}; Reflect.set(globalThis[k], 'fromCharCode', ${FCC});`,
      ON_UNREAD_OBJECT,
    ),
    'globalThis[k][m] with a readable m': residualChars(
      `var k = ${OPAQUE('String')}; var m = 'fromCharCode'; globalThis[k][m] = ${FCC};`,
      ON_UNREAD_OBJECT,
    ),
    'a logical key with a literal alternative': residualChars(
      `String.prototype[globalThis.K || 'split'] = ${SPL};`,
      MAY,
      '"Z" "Z"',
    ),
    'a nullish key with a literal alternative': residualChars(`String[globalThis.K ?? 'fromCharCode'] = ${FCC};`, MAY),
    'a conditional key': residualChars(`String[globalThis.K ? 'raw' : 'fromCharCode'] = ${FCC};`, MAY),
    'a key spelled in part by concatenation': residualChars(
      `var k = ${OPAQUE('it')}; String.prototype['spl' + k] = ${SPL};`,
      MAY,
      '"Z" "Z"',
    ),
    'a key spelled in part by a template': residualChars(
      `var k = ${OPAQUE('it')}; String.prototype[\`spl\${k}\`] = ${SPL};`,
      MAY,
      '"Z" "Z"',
    ),
    'Function[k].apply beside a decoder that applies fromCharCode': {
      source: `var k = ${OPAQUE('type')}; Function['proto' + k].apply = function () { return 'Z'; };
var table = ['252,110,239', '112,108,97,105,110'];
function dec(i) { var parts = table[i].split(','); var out = ''; for (var j = 0; j < parts.length; j++) out += String.fromCharCode.apply(null, [+parts[j]]); return out; }
log(dec(0), dec(1));`,
      prints: '"ZZZ" "ZZZZZ"',
      reason: MAY,
    },
  },
};

describe('B3 and C2 residuals: one hop past the letters', () => {
  for (const [letter, shapes] of Object.entries(RESIDUALS)) {
    describe(letter, () => {
      for (const [what, { source, prints, reason }] of Object.entries(shapes)) {
        it(`refuses at every preset, naming the write, and prints what the program prints, for ${what}`, async () => {
          expect(execute(source)).toBe(prints);
          for (const preset of PRESETS) {
            const { decoder, notes } = build(source, ['dec', 'table'], { preset });
            expect(decoder, preset).toBeUndefined();
            const refusal = notes.find((note) => note.message.includes('the program assigns to'));
            expect(refusal?.message, preset).toContain(reason);
            expect(refusal?.message, preset).not.toContain('the conservative preset inlines only what is proved');
          }
          await expectSameBehaviourEverywhere(source);
        });
      }
    });
  }

  it('words a write of several readings as what it may be, and a plain one as what it is', () => {
    const several = build(`var S = String; S = Math; S.round = 0;${DECODER_ROUND}`, ['dec', 'table']);
    expect(several.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining(
        'so Math may not be the builtin every tier would run: the write has more than one reading, and this one reaches what the slice reads',
      ),
    );
    const one = build(`var S = String; S = String; S.fromCharCode = 0;${DECODER_CHARS}`, ['dec', 'table']);
    expect(one.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('so String is not the builtin every tier would run'),
    );
    expect(one.notes.some((note) => note.message.includes('cannot be read'))).toBe(false);
    const partial = build(`var k = ${OPAQUE('und')}; Math['ro' + k] = 0;${DECODER_ROUND}`, ['dec', 'table']);
    expect(partial.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('a key of the write is spelled in part, and what it may spell reaches what the slice reads'),
    );
  });

  it('keeps the helper policy for a key spelled in part that fits nothing the decoder reads', () => {
    // `Math[dec(0x657b) + 'p']` in obfuscated2.js: `*p` cannot be `round`,
    // and is still a key the tree did not read whole.
    const source = `var k = ${OPAQUE('lamp')}; Math['c' + k] = function () { return 0; };${DECODER_ROUND}`;
    const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
    expect(balanced.decoder?.decode([1])).toBe('beta');
    expect(balanced.notes.some((note) => note.message.startsWith("Taking the program's assignment to"))).toBe(true);
    expect(build(source, ['dec', 'table'], { preset: 'conservative' }).decoder).toBeUndefined();
    // And a partial that fits a member the slice reads on a value is certain.
    const fits = build(`var k = ${OPAQUE('it')}; String.prototype['spl' + k] = 0;${DECODER_CHARS}`, ['dec', 'table'], {
      preset: 'balanced',
    });
    expect(fits.decoder).toBeUndefined();
  });

  it('keeps the helper policy for a key or an object the tree cannot read at all', () => {
    const unread: Record<string, string> = {
      'a wholly unread key on a prototype': `var k = ${OPAQUE('split')}; String.prototype[String(k)] = 0;`,
      'both keys of a chain unread': `var k = ${OPAQUE('getPrototypeOf')}; var m = ${OPAQUE('split')}; Object[k]('')[m] = 0;`,
      'a with over a local the tree cannot open': 'var o = load(); with (o) { fromCharCode = 0; }',
      'a key spelled in part that fits no member': `var k = ${OPAQUE('x')}; String.prototype['zz' + k] = 0;`,
    };
    for (const [what, write] of Object.entries(unread)) {
      const balanced = build(`${write}${DECODER_CHARS}`, ['dec', 'table'], { preset: 'balanced' });
      expect(balanced.decoder?.decode([1]), what).toBe('plain');
      expect(balanced.notes.some((note) => note.message.startsWith("Taking the program's assignment to")), what).toBe(true);
      expect(build(`${write}${DECODER_CHARS}`, ['dec', 'table'], { preset: 'conservative' }).decoder, what).toBeUndefined();
    }
  });

  it('leaves a decoder alone where the hop cannot reach what it reads', () => {
    const untouched: Record<string, string> = {
      'a function that escapes, handed nothing the decoder reads': 'function f(K) { K.x = 0; } f({}); keep(f);',
      'a method of another holder': 'var o = { f: function (K) { K.fromCharCode = 0; } }; var p = { f: function () {} }; p.f(String);',
      'a conditional of two globals the decoder does not read': 'var D = globalThis.K ? Date : Math; D.now = 0;',
      'a call result of a method of a global, a value of its own': 'var o = Object.create(null); o.fromCharCode = 0;',
      'a parameter of a fixed function handed a literal': 'function f(K) { K.fromCharCode = 0; } f({});',
    };
    for (const [what, write] of Object.entries(untouched)) {
      const { decoder, notes } = build(`${write}${DECODER_CHARS}`, ['dec', 'table'], { preset: 'conservative' });
      expect(decoder?.decode([1]), what).toBe('plain');
      expect(notes.some((note) => note.message.includes('the program assigns to')), what).toBe(false);
    }
  });

  it('states the boundary: a function the tree cannot see every call of is the unknown object', () => {
    // The function escapes as a value, so its parameter may receive anything
    // - recorded under the unknown name with the parameter attached, which
    // conservative refuses and balanced takes for the helper it usually is.
    // The one call the tree sees is a certain write, whichever the others are.
    const seen = `function f(K) { K.fromCharCode = ${FCC}; } f(String); keep(f);${DECODER_CHARS}`;
    for (const preset of PRESETS) expect(build(seen, ['dec', 'table'], { preset }).decoder, preset).toBeUndefined();
    const escapes = `function f(K) { K.fromCharCode = ${FCC}; } f(Math); keep(f);${DECODER_CHARS}`;
    const balanced = build(escapes, ['dec', 'table'], { preset: 'balanced' });
    expect(balanced.decoder?.decode([1])).toBe('plain');
    expect(balanced.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('K is assigned from more than one source and cannot be read'),
    );
    expect(build(escapes, ['dec', 'table'], { preset: 'conservative' }).decoder).toBeUndefined();
    // A method reached through an instance of a fixed constructor is a call
    // the tree sees: the instances are every `new U()`, and the method is
    // what `U.prototype.f = ...` put there. A constructor handed on as a
    // value makes instances the tree cannot see, which is the same escape.
    const instance = `function U() {} U.prototype.f = function (K) { K.fromCharCode = ${FCC}; }; new U().f(String);${DECODER_CHARS}`;
    expect(execute(instance)).toBe('"ZZZ" "ZZZZZ"');
    for (const preset of PRESETS) expect(build(instance, ['dec', 'table'], { preset }).decoder, preset).toBeUndefined();
    const made = `function U() {} U.prototype.f = function (K) { K.fromCharCode = ${FCC}; }; keep(U); new U().f(Math);${DECODER_CHARS}`;
    const disclosed = build(made, ['dec', 'table'], { preset: 'balanced' });
    expect(disclosed.decoder?.decode([1])).toBe('plain');
    expect(disclosed.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('K is assigned from more than one source and cannot be read'),
    );
    expect(build(made, ['dec', 'table'], { preset: 'conservative' }).decoder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A rest parameter taken apart: the round-fifteen regression
// ---------------------------------------------------------------------------

/**
 * `function w(...[K]) { K.round = ... } w(Math)`: the rest is an array of
 * the arguments from its position on, and a pattern in place of its name
 * takes that array apart, so `K` is the first argument. Round fifteen read
 * every rest without a key as the fresh array it is, before asking whether
 * the rest had a name at all - so `K` was a fresh local nothing wrote
 * through, and 'alpha' 'beta' was inlined at every preset where the
 * program prints 'gamma' 'gamma'. Every shape here is refused at every
 * preset and executed; the shapes that hand the rest on unread - an object
 * pattern over it, a declarator taking it apart, which the raw walk once
 * dropped as no candidate at all - are the conservative refusal and the
 * balanced disclosure, as any unread hand-off.
 */
const REST_ROUND = "K.round = function () { return 2; };";
const REST_TAKEN_APART: Record<string, string> = {
  '...[K]': `function w(...[K]) { ${REST_ROUND} } w(Math);`,
  '...[K] through .call': `function w(...[K]) { ${REST_ROUND} } w.call(null, Math);`,
  '...[, K], the second argument': `function w(...[, K]) { ${REST_ROUND} } w(0, Math);`,
  '...[K = Math], the default': `function w(...[K = Math]) { ${REST_ROUND} } w();`,
  '...[K] of an arrow': `var w = (...[K]) => { ${REST_ROUND} }; w(Math);`,
  'a, ...[K]': `function w(a, ...[K]) { ${REST_ROUND} } w(0, Math);`,
  '...[...r], the rest of the rest': `function w(...[...r]) { r[0].round = function () { return 2; }; } w(Math);`,
  '...[[K]], an element of the argument': `function w(...[[K]]) { ${REST_ROUND} } w([Math]);`,
  '...[K], then Object.defineProperty(K, ...)': `function w(...[K]) { Object.defineProperty(K, 'round', { value: function () { return 2; } }); } w(Math);`,
  '...[K] of an object method': `var o = { w(...[K]) { ${REST_ROUND} } }; o.w(Math);`,
  '...[K] of a class static': `class C { static w(...[K]) { ${REST_ROUND} } } C.w(Math);`,
  '...[K] of a forEach callback': `function w(...[K]) { ${REST_ROUND} } [Math].forEach(w);`,
  '...[K] through Reflect.apply': `function w(...[K]) { ${REST_ROUND} } Reflect.apply(w, null, [Math]);`,
  '...r, then r[0]': `function w(...r) { r[0].round = function () { return 2; }; } w(Math);`,
};
const REST_HANDED_ON_UNREAD: Record<string, string> = {
  '...{ 0: K }, an object pattern over the rest': `function w(...{ 0: K }) { ${REST_ROUND} } w(Math);`,
  '...r, then var [K] = r, the rest taken apart by a declarator': `function w(...r) { var [K] = r; ${REST_ROUND} } w(Math);`,
};

describe('a rest parameter taken apart by a pattern', () => {
  for (const [what, write] of Object.entries(REST_TAKEN_APART)) {
    it(`refuses at every preset and prints what the program prints, for ${what}`, async () => {
      const source = `${write}${DECODER_ROUND}`;
      expect(execute(source)).toBe('"gamma" "gamma"');
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['dec', 'table'], { preset });
        expect(decoder, preset).toBeUndefined();
        const refusal = notes.find((note) => note.message.includes('the program assigns to'));
        expect(refusal?.message, preset).toMatch(/assigns to `(K|r\[...\])\.round = ...`|assigns to `Object\.defineProperty\(K, "round", ...\)`/);
        expect(refusal?.message, preset).not.toContain('the conservative preset inlines only what is proved');
      }
      await expectSameBehaviourEverywhere(source);
    });
  }
  for (const [what, write] of Object.entries(REST_HANDED_ON_UNREAD)) {
    it(`is refused at conservative and taken with a disclosure at balanced, for ${what}`, async () => {
      const source = `${write}${DECODER_ROUND}`;
      expect(execute(source)).toBe('"gamma" "gamma"');
      const conservative = build(source, ['dec', 'table'], { preset: 'conservative' });
      expect(conservative.decoder).toBeUndefined();
      expect(conservative.notes.map((note) => note.message)).toContainEqual(expect.stringContaining('the program assigns to `K.round = ...`'));
      const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
      expect(balanced.notes.map((note) => note.message)).toContainEqual(
        expect.stringContaining('K is assigned from more than one source and cannot be read'),
      );
      const result = await deobfuscate(source, { preset: 'conservative' });
      expect(execute(result.code)).toBe('"gamma" "gamma"');
    });
  }
});

// ---------------------------------------------------------------------------
// C3: a reflective call under a member the tree cannot read
// ---------------------------------------------------------------------------

/**
 * obfuscator.io encodes member names, so `Object.assign(String.prototype,
 * d)` arrives as `Object[dec(0x1)](String.prototype, d)` and `Object.assign
 * .apply(Object, [String.prototype, d])` as `Object[dec(0x1)][dec(0x2)](...)`,
 * and the decoder spelling the member may be one this round cannot read.
 * The index saw a reflective call only under a member it could spell, so a
 * builtin was replaced through a callee the guard did not see, and the
 * decoder beside it was folded with the native builtin - silent at every
 * preset. The rule: a call whose
 * callee is `Object`, `Reflect` or `Function.prototype` under a member the
 * tree cannot read is a may-write of every property of every argument it
 * is handed, and of every element of an array literal among them, since
 * the member may be `assign` and `apply`; refused at conservative, and the
 * unread policy at balanced. A member spelled in part that fits a
 * reflective method, `'defineProp' + k`, is that method. A member read
 * whole - `key(0)` over a local table - is the call it spells, `.call` and
 * `.apply` through computed keys included.
 */
const C3_KEYS =
  "var keys = ['assign', 'apply', 'defineProperty', 'split', 'prototype', 'call', 'fromCharCode', 'defineProperties', 'value'];\nfunction key(i) { return keys[i]; }\n";
const C3_SPLIT = 'var f = function () { return ["65"]; };\n';
const C3_CHARS = "var f = function () { return 'Z'; };\n";
/** Certain: the member is read whole, so the write is the one it spells. */
const C3_READ: Record<string, Residual> = {
  'Object[key(0)][key(1)](Object, [String.prototype, d]), assign.apply through two read keys': residualChars(
    `${C3_KEYS}${C3_SPLIT}Object[key(0)][key(1)](Object, [String.prototype, { split: f }]);`,
    SPLIT_IS,
    '"A" "A"',
  ),
  'Object[key(0)][key(5)](Object, String.prototype, d), assign.call through two read keys': residualChars(
    `${C3_KEYS}${C3_SPLIT}Object[key(0)][key(5)](Object, String.prototype, { split: f });`,
    SPLIT_IS,
    '"A" "A"',
  ),
  'the static through assign.apply': residualChars(`${C3_KEYS}${C3_CHARS}Object[key(0)][key(1)](Object, [String, { fromCharCode: f }]);`, IS),
  'a target aliased, through assign.apply': residualChars(
    `${C3_KEYS}${C3_SPLIT}var P = String.prototype; Object[key(0)][key(1)](Object, [P, { split: f }]);`,
    SPLIT_IS,
    '"A" "A"',
  ),
  'a prototype read through a value, through assign.apply': residualChars(
    `${C3_KEYS}${C3_SPLIT}Object[key(0)][key(1)](Object, [''.__proto__, { split: f }]);`,
    SPLIT_IS,
    '"A" "A"',
  ),
  'a holder built by a member write, through assign.apply': residualChars(
    `${C3_KEYS}${C3_SPLIT}var d = {}; d.split = f; Object[key(0)][key(1)](Object, [String.prototype, d]);`,
    SPLIT_IS,
    '"A" "A"',
  ),
  'a member spelled in part that fits defineProperty': residualChars(
    `var k = ${OPAQUE('erty')}; ${C3_SPLIT}Object['defineProp' + k](String.prototype, 'split', { value: f });`,
    MAY,
    '"A" "A"',
  ),
  'a member spelled in part, through a parameter': residualChars(
    `var k = ${OPAQUE('erty')}; ${C3_SPLIT}function g(K) { Object['defineProp' + k](K, 'spl' + 'it', { value: f }); } g(String.prototype);`,
    MAY,
    '"A" "A"',
  ),
  // The b3bm11 trial: obfuscator.io's transformObjectKeys spells the source
  // as a holder, and `''.__proto__` as `''[dec(0x3)]` held by a name - an
  // alias of a literal's member the tree cannot read, which may be its
  // prototype, as the same member written where it stands already was.
  'an alias of a literal’s member the tree cannot read, written through': residualChars(
    `var k = ${OPAQUE('__proto__')}; ${C3_SPLIT}var p = ''[k]; p.split = f;`,
    ON_UNREAD_OBJECT,
    '"A" "A"',
  ),
  'an alias of a literal’s member the tree cannot read, handed to Object.assign with a holder': residualChars(
    `var k = ${OPAQUE('__proto__')}; ${C3_SPLIT}var p = ''[k]; var iota = {}; iota.split = f; Object.assign(p, iota);`,
    ON_UNREAD_OBJECT,
    '"A" "A"',
  ),
};
/** Unread: the member may be any method, so every property of the argument may be written. */
const C3_UNREAD: Record<string, string> = {
  'Object[k](String.prototype, d)': `var k = ${OPAQUE('assign')}; ${C3_SPLIT}Object[k](String.prototype, { split: f });`,
  'Object[k][j](Object, [String.prototype, d])': `var k = ${OPAQUE('assign')}; var j = ${OPAQUE('apply')}; ${C3_SPLIT}Object[k][j](Object, [String.prototype, { split: f }]);`,
  'Object[k][j](Object, String.prototype, d)': `var k = ${OPAQUE('assign')}; var j = ${OPAQUE('call')}; ${C3_SPLIT}Object[k][j](Object, String.prototype, { split: f });`,
  'Object[k](P, d) over an alias of the prototype': `var k = ${OPAQUE('assign')}; ${C3_SPLIT}var P = ''.__proto__; var iota = {}; iota.split = f; Object[k](P, iota);`,
  'Object[k](K, ...) through a parameter': `var k = ${OPAQUE('defineProperty')}; ${C3_SPLIT}function g(K) { Object[k](K, 'split', { value: f }); } g(String.prototype);`,
  'Reflect[k](String.prototype, ...)': `var k = ${OPAQUE('set')}; ${C3_SPLIT}Reflect[k](String.prototype, 'split', f);`,
  'var O = Object; O[k](String.prototype, d)': `var k = ${OPAQUE('assign')}; ${C3_SPLIT}var O = Object; O[k](String.prototype, { split: f });`,
  'Function.prototype.call[k](Object.assign, Object, String.prototype, d)': `var k = ${OPAQUE('call')}; ${C3_SPLIT}Function.prototype.call[k](Object.assign, Object, String.prototype, { split: f });`,
  'the static: Object[k](String, d)': `var k = ${OPAQUE('assign')}; ${C3_CHARS}Object[k](String, { fromCharCode: f });`,
  'Object[j](p, iota) over an alias of a literal’s unread member': `var k = ${OPAQUE('__proto__')}; var j = ${OPAQUE('assign')}; ${C3_SPLIT}var p = ''[k]; var iota = {}; iota.split = f; Object[j](p, iota);`,
};
/** Left alone: the member is unread, but nothing the decoder reads is handed over. */
const C3_CONTROLS: Record<string, string> = {
  'Object[k](d) over a local': `var k = ${OPAQUE('freeze')}; var d = { split: 1 }; Object[k](d);`,
  'Object[k](Math, ...) beside a decoder that reads String': `var k = ${OPAQUE('assign')}; Object[k](Math, { round: 1 });`,
  'Object[k](String, ...) where the key fits nothing that writes': `Object['ke' + ${OPAQUE('ys')}](String);`,
};

describe('C3: a reflective call under a member the tree cannot read', () => {
  for (const [what, { source, prints, reason }] of Object.entries(C3_READ)) {
    it(`refuses at every preset, naming the write, and prints what the program prints, for ${what}`, async () => {
      expect(execute(source)).toBe(prints);
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['dec', 'table'], { preset });
        expect(decoder, preset).toBeUndefined();
        const refusal = notes.find((note) => note.message.includes('the program assigns to'));
        expect(refusal?.message, preset).toContain(reason);
        expect(refusal?.message, preset).not.toContain('the conservative preset inlines only what is proved');
      }
      await expectSameBehaviourEverywhere(source);
    });
  }
  for (const [what, write] of Object.entries(C3_UNREAD)) {
    it(`is refused at conservative and taken with a disclosure at balanced, for ${what}`, async () => {
      const source = `${write}${DECODER_CHARS}`;
      const prints = execute(source);
      expect(prints).not.toBe('"ünï" "plain"');
      const conservative = build(source, ['dec', 'table'], { preset: 'conservative' });
      expect(conservative.decoder).toBeUndefined();
      expect(conservative.notes.map((note) => note.message)).toContainEqual(expect.stringContaining('the program assigns to'));
      const balanced = build(source, ['dec', 'table'], { preset: 'balanced' });
      expect(balanced.decoder?.decode([1])).toBe('plain');
      expect(balanced.notes.map((note) => note.message)).toContainEqual(expect.stringContaining("Taking the program's assignment to"));
      const result = await deobfuscate(source, { preset: 'conservative' });
      expect(execute(result.code)).toBe(prints);
    });
  }
  it('leaves a decoder alone when the call hands over nothing it reads', () => {
    for (const [what, write] of Object.entries(C3_CONTROLS)) {
      const { decoder, notes } = build(`${write}${DECODER_CHARS}`, ['dec', 'table'], { preset: 'conservative' });
      expect(decoder?.decode([1]), what).toBe('plain');
      expect(notes.some((note) => note.message.includes('the program assigns to')), what).toBe(false);
    }
  });
});
