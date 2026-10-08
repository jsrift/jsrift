import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A program-scope `var` or function in a script is a property of the global
 * object, and a read of it through that object - `window._0x1a2b3c` - is a
 * use the binding's reference list does not show. The global object has
 * more spellings than its own names, and each is followed to what it flows
 * into once the tree is whole: an alias, an alias of that, `this` where it
 * is the global object, a parameter handed it by an IIFE or a UMD wrapper
 * or `.call`/`.apply`, a pattern that takes it apart, a local that stores
 * it in a property. Every shape here printed a `TypeError` at balanced
 * before: the map was renamed, and the read through the alias was not.
 *
 * Where the object escapes into something the walk cannot follow - a
 * callee it cannot resolve, a `return` to callers out of sight, a store
 * into something that is no local, code compiled from a string - a name
 * the file spells as a member or pattern key may be read through it, and
 * every such program-scope name keeps its own, with one note. Where the
 * object's own keys are enumerated, every program-scope name does. A
 * callee that is another script's - `$(window)` - is the boundary the
 * walk stops at, as it stops at every other value from outside.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

const NOTE = /kept their names: the global object/;

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

async function run(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, options);
  const noted = ctx.diagnostics.filter((note) => NOTE.test(note.message)).length;
  return { code, renames: ctx.renames.map((entry) => entry.from), noted, printed: observe(code) };
}

/** Input and output print the same thing at every preset; returns the aggressive result. */
async function expectPreserved(source: string, expected: string[]) {
  expect(observe(source)).toEqual(expected);
  let aggressive;
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(result.printed, options.preset).toEqual(expected);
    aggressive = result;
  }
  return aggressive!;
}

const MAP = `var _0x1a2b3c = new Map(); _0x1a2b3c.set('k', 7);`;

describe('a program-scope binding read through an alias of the global object', () => {
  const shapes: Array<[string, string]> = [
    ['an alias of an alias', `var g = globalThis, h = g; log(h._0x1a2b3c.get('k'));`],
    ['this at the top of a script', `var g = this; log(g._0x1a2b3c.get('k'));`],
    ['the standard idiom', `var g = typeof globalThis !== 'undefined' ? globalThis : this; log(g._0x1a2b3c.get('k'));`],
    [
      'a UMD wrapper handed this',
      `(function (root, factory) { root._0x9f9f = factory(root); })(this, function (root) { return root._0x1a2b3c.get('k'); }); log(_0x9f9f);`,
    ],
    ['an IIFE handed this', `(function (d) { log(d._0x1a2b3c.get('k')); })(this);`],
    ['an IIFE invoked through call', `(function (d) { log(d._0x1a2b3c.get('k')); }).call(globalThis, globalThis);`],
    ['an IIFE invoked through apply', `(function (d) { log(d._0x1a2b3c.get('k')); }).apply(this, [this]);`],
    ['a pattern taking the global object apart', `const { _0x1a2b3c: m } = globalThis; log(m.get('k'));`],
    ['a member of a local holder', `var o = { g: globalThis }; log(o.g._0x1a2b3c.get('k'));`],
    ['a logical of spellings', `var g = globalThis || window; log(g._0x1a2b3c.get('k'));`],
    // Ten more.
    ['a chain of three', `var g = globalThis; var h = g; var i = h; log(i._0x1a2b3c.get('k'));`],
    ['a sequence', `var g = (0, globalThis); log(g._0x1a2b3c.get('k'));`],
    ['a nullish coalescing', `var g = undefined ?? globalThis; log(g._0x1a2b3c.get('k'));`],
    ['this as the receiver of call', `(function () { log(this._0x1a2b3c.get('k')); }).call(globalThis);`],
    ['this handed through call', `(function (d) { log(d._0x1a2b3c.get('k')); }).call(null, this);`],
    ['an element of a local array', `var arr = [globalThis]; log(arr[0]._0x1a2b3c.get('k'));`],
    ['a nested pattern', `const { _0x1a2b3c: { size: s } } = globalThis; log(s);`],
    ['a let assigned later', `let g; g = globalThis; log(g._0x1a2b3c.get('k'));`],
    ['a named function handed this', `function _0xr(root) { return root._0x1a2b3c.get('k'); } log(_0xr(this));`],
    ['an alias of this handed to an IIFE', `var g = this; (function (d) { log(d._0x1a2b3c.get('k')); })(g);`],
    ['window.window is the window', `var g = globalThis.globalThis; log(g._0x1a2b3c.get('k'));`],
    ['a store through a chain alias', `var _0x2b2b = 1; var g = globalThis, h = g; h._0x2b2b = 5; log(_0x2b2b);`],
    ['handed back by code compiled from a string', `log(Function('return this')()._0x1a2b3c.get('k'));`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      const expected = title.includes('nested') ? ['1'] : title.includes('store') ? ['5'] : ['7'];
      const result = await expectPreserved(`${MAP}\n${read}`, expected);
      expect(result.noted, 'noted').toBe(0);
    });
  }

  it('a program-scope function called through a chain alias keeps its callers in sight', async () => {
    const result = await expectPreserved(
      `
        function _0x1a2b3c(v) { return 'fn:' + v.name; }
        var g = globalThis, h = g;
        log(h._0x1a2b3c(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(result.code).toContain('function _0x96d6');
  });

  it('an alias found through a chain, this or a parameter is renamed like any other binding', async () => {
    // Only `var g = window` and the window parameter of a wrapping IIFE keep
    // their names; the policy that keeps them is about what a published
    // value is called, and it stays where it was.
    const result = await expectPreserved(`${MAP}\nvar g = globalThis, h = g; log(h._0x1a2b3c.get('k'));`, ['7']);
    expect(result.renames).toContain('h');
    expect(result.renames).not.toContain('g');
  });
});

describe('the global object escaping into what the walk cannot follow', () => {
  const escapes: Array<[string, string]> = [
    ['stored on a non-local', `globalThis.root = globalThis; log(root._0x1a2b3c.get('k'));`],
    ['returned to callers out of sight', `function _0xg() { return this; } globalThis.q = [_0xg]; log(_0xg()._0x1a2b3c.get('k'));`],
    [
      'handed to a callee the walk cannot resolve',
      `var reader = function (o) { return o; }; reader = function (o) { return o; }; log(reader(globalThis)._0x1a2b3c.get('k'));`,
    ],
    ['stored in a holder that is a parameter of a function let go of', `function _0xh(o) { o.g = globalThis; return o; } globalThis.q = [_0xh]; log(_0xh({}).g._0x1a2b3c.get('k'));`],
  ];
  for (const [title, read] of escapes) {
    it(`${title}: every program-scope name spelled as a key keeps its own, with one note`, async () => {
      const result = await expectPreserved(`${MAP}\n${read}`, ['7']);
      expect(result.renames).not.toContain('_0x1a2b3c');
      expect(result.noted).toBe(1);
    });
  }

  it('enumerated: every program-scope name keeps its own', async () => {
    for (const [read, expected] of [
      [`var n = 0; for (var k in globalThis) if (k === '_0x1a2b3c') n++; log(n);`, '1'],
      [`log(Object.keys(globalThis).filter(function (k) { return /^_0x/.test(k); }).length);`, '2'],
      [`log(Object.assign({}, globalThis)._0x1a2b3c.size);`, '1'],
    ] as const) {
      const result = await expectPreserved(`${MAP}\nvar _0x5a5a = 1;\n${read}`, [expected]);
      expect(result.renames, read).not.toContain('_0x1a2b3c');
      expect(result.renames, read).not.toContain('_0x5a5a');
      expect(result.noted, read).toBe(1);
    }
  });

  it('a store into a parameter is a store into what the callers pass', async () => {
    // The object stored into is the callers': the literal handed in, which
    // `_0xh` hands back. The walk used to stop at the parameter as at an
    // object of the callers', and said the object had escaped.
    const result = await expectPreserved(
      `${MAP}
function _0xh(o) { o.g = globalThis; return o; } log(_0xh({}).g._0x1a2b3c.get('k'));`,
      ['7'],
    );
    expect(result.renames).not.toContain('_0x1a2b3c');
    expect(result.noted).toBe(0);
  });

  it('a literal handed to a parameter is read through the parameter, not lost to it', async () => {
    // `[this]` lands in `list`, and `list[0]` is returned to the one call
    // in sight: followed to the read, which keeps the map's name without a
    // note. The walk used to stop at the parameter as at an object of the
    // callers', and said the object had escaped.
    const result = await expectPreserved(
      `${MAP}
function _0xr(list) { return list[0]; } var q = [_0xr]; log(_0xr([this])._0x1a2b3c.get('k'));`,
      ['7'],
    );
    expect(result.renames).not.toContain('_0x1a2b3c');
    expect(result.noted).toBe(0);
  });

  it('a name the file never spells as a key is not among what an escape can reach', async () => {
    // The hazard is a static read `X._0x...` off the escaped object, and a
    // static key is spelled in the file; `_0x5a5a` is not. `cbs.first` is
    // a method of a parameter, which is the callers' to say.
    const result = await expectPreserved(
      `
        var _0x5a5a = 3;
        var _0x6b65 = 1;
        function _0xrun(cbs) { return cbs.first(globalThis); }
        var held = [_0xrun];
        var got = _0xrun({ first: function (o) { return o; } });
        log(_0x5a5a, typeof got._0x6b65);
      `,
      ['3 number'],
    );
    expect(result.renames).toContain('_0x5a5a');
    expect(result.renames).not.toContain('_0x6b65');
    expect(result.noted).toBe(1);
  });

  it('handed to another script’s function is the boundary, not an escape', async () => {
    // `$(window)`: what jQuery does with the window is jQuery's.
    const result = await expectPreserved(
      `
        var _0x5a5a = 3;
        function _0x1a2b3c() { return 1; }
        var $ = function (w) { return { on: function () { return w === globalThis; } }; };
        log($(globalThis).on(), _0x5a5a, _0x1a2b3c());
        var q = String(globalThis).length > 0;
        log(q);
      `,
      ['true 3 1', 'true'],
    );
    expect(result.noted).toBe(0);
  });

  it('a self-rewriting decoder called with the window returns no function to call it through', async () => {
    // obfuscator.io's string decoder assigns itself a new function on
    // first call; a proxy map holds its results beside functions, and
    // `map[k](x, window)` runs one of the functions.
    const result = await expectPreserved(
      `
        function _0xd(i) { var a = ['a', 'b']; _0xd = function (j) { return a[j]; }; return _0xd(i); }
        var map = { s: _0xd(0), f: function (x, g) { return g === globalThis; } };
        var _0x5a5a = 3;
        log(map[_0xd(1) === 'b' ? 'f' : 's'](1, globalThis), _0x5a5a);
      `,
      ['true 3'],
    );
    expect(result.renames).toContain('_0x5a5a');
    expect(result.noted).toBe(0);
  });

  it('in a module nothing at program scope is a property of the global object', async () => {
    const source = `var _0x1a2b3c = new Map(); var g = globalThis; var q = [g]; log(typeof g._0x1a2b3c, _0x1a2b3c.size); export {};`;
    for (const options of PRESETS) {
      const { ctx } = await runPass(pass, source, { ...options, sourceType: 'module' });
      expect(ctx.diagnostics.filter((note) => NOTE.test(note.message)), options.preset).toEqual([]);
      if (options.preset !== 'conservative') expect(ctx.renames.map((entry) => entry.from), options.preset).toContain('_0x1a2b3c');
    }
  });
});

const HOST = /host property/;

/** As `observe`, waiting a tick for what an async body prints after its first `await`. */
async function observeAsync(code: string): Promise<string[]> {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return logs;
}

describe('the global object under one more spelling: a holder taken apart, a collection, a wrapper, a prototype', () => {
  // Each printed a `TypeError` at balanced: the map was renamed, and the
  // read through the spelling was not in its reference list.
  const shapes: Array<[string, string]> = [
    ['a pattern off a local holder', `var holder = { g: globalThis }; var { g: h } = holder; log(h._0x1a2b3c.get('k'));`],
    ['a shorthand pattern off a holder', `var holder = { g: globalThis }; var { g } = holder; log(g._0x1a2b3c.get('k'));`],
    ['a pattern off a literal in place', `var { g: h } = { g: globalThis }; log(h._0x1a2b3c.get('k'));`],
    ['an array pattern off a holder', `var holder = [globalThis]; var [h] = holder; log(h._0x1a2b3c.get('k'));`],
    ['a holder of this', `var holder = { root: this }; var { root } = holder; log(root._0x1a2b3c.get('k'));`],
    ['a parameter pattern off a holder', `(function ({ g }) { log(g._0x1a2b3c.get('k')); })({ g: globalThis });`],
    ['a nested pattern off a literal array', `var [{ g }] = [{ g: globalThis }]; log(g._0x1a2b3c.get('k'));`],
    ['a pattern default', `var { g = globalThis } = {}; log(g._0x1a2b3c.get('k'));`],
    ['a Map set then get', `var m = new Map(); m.set('g', globalThis); log(m.get('g')._0x1a2b3c.get('k'));`],
    ['a Map built from entries', `var m = new Map([['g', globalThis]]); log(m.get('g')._0x1a2b3c.get('k'));`],
    ['a Map set through an alias', `var g = globalThis; var m = new Map(); m.set('g', g); log(m.get('g')._0x1a2b3c.get('k'));`],
    ['a Map set chained on the constructor', `var m = new Map().set('g', globalThis); log(m.get('g')._0x1a2b3c.get('k'));`],
    ['a Map key held in a local', `var m = new Map(); var k = 'g'; m.set(k, globalThis); log(m.get(k)._0x1a2b3c.get('k'));`],
    ['a WeakMap', `var key = {}; var m = new WeakMap(); m.set(key, globalThis); log(m.get(key)._0x1a2b3c.get('k'));`],
    ['a WeakMap set through an alias of it', `var key = {}; var m = new WeakMap(); var w = m; w.set(key, globalThis); log(m.get(key)._0x1a2b3c.get('k'));`],
    ['a Proxy', `var p = new Proxy(globalThis, {}); log(p._0x1a2b3c.get('k'));`],
    ['a Proxy of an alias with a get trap', `var g = globalThis; var p = new Proxy(g, { get(t, k) { return t[k]; } }); log(p._0x1a2b3c.get('k'));`],
    ['a Proxy of a Proxy', `var g = new Proxy(new Proxy(globalThis, {}), {}); log(g._0x1a2b3c.get('k'));`],
    ['Object() of it', `var g = Object(globalThis); log(g._0x1a2b3c.get('k'));`],
    ['Object() through call', `var g = Object.call(null, globalThis); log(g._0x1a2b3c.get('k'));`],
    ['Object() through apply', `var g = Object.apply(null, [globalThis]); log(g._0x1a2b3c.get('k'));`],
    ['Object() assigned later', `var g; g = Object(globalThis); log(g._0x1a2b3c.get('k'));`],
    ['Object() through a sequence callee', `var g = (0, Object)(globalThis); log(g._0x1a2b3c.get('k'));`],
    ['Object.assign onto it', `var g = Object.assign(globalThis, {}); log(g._0x1a2b3c.get('k'));`],
    ['Reflect.get of it', `log(Reflect.get(globalThis, '_0x1a2b3c').get('k'));`],
    ['Reflect.get off a holder', `var h = { g: globalThis }; log(Reflect.get(h, 'g')._0x1a2b3c.get('k'));`],
    ['an element of a literal in place', `log([globalThis][0]._0x1a2b3c.get('k'));`],
    ['a property of a literal in place', `log({ g: globalThis }.g._0x1a2b3c.get('k'));`],
    ['an element by a held index', `var envs = [globalThis]; var i = 0; log(envs[i]._0x1a2b3c.get('k'));`],
    ['a frozen holder', `var g = Object.freeze({ g: globalThis }).g; log(g._0x1a2b3c.get('k'));`],
    ['a holder copied by Object.assign', `var g = Object.assign({}, { g: globalThis }).g; log(g._0x1a2b3c.get('k'));`],
    ['Array.from of a holder', `var g = Array.from([globalThis])[0]; log(g._0x1a2b3c.get('k'));`],
    ['Object.values of a holder', `var g = Object.values({ g: globalThis })[0]; log(g._0x1a2b3c.get('k'));`],
    ['a callback handed the elements', `var g = [globalThis].map(function (x) { return x; })[0]; log(g._0x1a2b3c.get('k'));`],
    [
      'an ES5 holder read through a prototype method',
      `function H() { this.g = globalThis; } H.prototype.get = function () { return this.g; }; log(new H().get()._0x1a2b3c.get('k'));`,
    ],
    ['a holder member a function returns', `var h = { g: globalThis }; function root() { return h.g; } log(root()._0x1a2b3c.get('k'));`],
    ['handed back by a recursive function', `function find(o, n) { return n ? find(o, n - 1) : o; } log(find(globalThis, 3)._0x1a2b3c.get('k'));`],
    ['a conditional of a Proxy and it', `var c = true; var g = c ? new Proxy(globalThis, {}) : globalThis; log(g._0x1a2b3c.get('k'));`],
    ['an optional globalThis.globalThis', `var g = globalThis?.globalThis; log(g._0x1a2b3c.get('k'));`],
    // Inherited: a read of anything the object lacks reaches the global object.
    ['an object created from it', `var o = Object.create(globalThis); log(o._0x1a2b3c.get('k'));`],
    ['an object given it as prototype', `var o = Object.setPrototypeOf({}, globalThis); log(o._0x1a2b3c.get('k'));`],
    ['a literal with it as __proto__', `var o = { __proto__: globalThis }; log(o._0x1a2b3c.get('k'));`],
    ['an object made to inherit it', `var o = {}; Object.setPrototypeOf(o, globalThis); log(o._0x1a2b3c.get('k'));`],
    ['an object made to inherit it through Reflect', `var o = {}; Reflect.setPrototypeOf(o, globalThis); log(o._0x1a2b3c.get('k'));`],
    ['an object given it as __proto__ later', `var o = {}; o.__proto__ = globalThis; log(o._0x1a2b3c.get('k'));`],
    ['an object created from one created from it', `var o = Object.create(Object.create(globalThis)); log(o._0x1a2b3c.get('k'));`],
    ['a getter of a literal returning it', `var o = { get root() { return globalThis; } }; log(o.root._0x1a2b3c.get('k'));`],
    ['a getter of a class returning it', `class G { get root() { return globalThis; } } log(new G().root._0x1a2b3c.get('k'));`],
    ['a prototype property holding it', `function G() {} G.prototype.root = globalThis; log(new G().root._0x1a2b3c.get('k'));`],
    ['the values of a Set', `var s = new Set([globalThis]); for (const g of s) log(g._0x1a2b3c.get('k'));`],
    ['the entries of a Map', `var h = new Map([[1, globalThis]]); for (const [, g] of h) log(g._0x1a2b3c.get('k'));`],
    [
      'the UMD idiom with an alias inside the factory',
      `(function (root, factory) { root.result = factory(root); })(typeof globalThis !== 'undefined' ? globalThis : this, function (root) { var w = root; return w._0x1a2b3c.get('k'); }); log(result);`,
    ],
    [
      'the underscore root idiom',
      `var root = typeof self == 'object' && self.self === self && self || typeof global == 'object' && global.global === global && global || this; log(root._0x1a2b3c.get('k'));`,
    ],
    ['Function and an indirect eval', `var g = Function('return this')() || (42, eval)('this'); log(g._0x1a2b3c.get('k'));`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      const result = await expectPreserved(`${MAP}\n${read}`, ['7']);
      expect(result.renames).not.toContain('_0x1a2b3c');
    });
  }

  it('what Promise.resolve settles to, awaited or handed to then', async () => {
    for (const read of [
      `(async () => { var g = await Promise.resolve(globalThis); log(g._0x1a2b3c.get('k')); })();`,
      `Promise.resolve(globalThis).then(function (g) { log(g._0x1a2b3c.get('k')); });`,
      `function show(g) { log(g._0x1a2b3c.get('k')); } Promise.resolve(globalThis).then(show);`,
    ]) {
      const source = `${MAP}\n${read}`;
      expect(await observeAsync(source)).toEqual(['7']);
      for (const options of PRESETS) {
        const { code, ctx } = await runPass(pass, source, options);
        expect(await observeAsync(code), `${options.preset}: ${read}`).toEqual(['7']);
        expect(ctx.renames.map((entry) => entry.from), options.preset).not.toContain('_0x1a2b3c');
      }
    }
  });
});

describe('a key read off the global object that nothing resolves whole', () => {
  const FN = `function _0x1a2b3c(v) { return 'fn:' + v.name; }`;
  const DECODER = `var t = ['_0x1a']; function dec(i) { return t[i]; }`;

  it('every program-scope name containing a piece the key spells keeps its own', async () => {
    // Each printed a `TypeError` at balanced with no word said: the
    // function was renamed, and the read spelled its name in pieces the
    // whole-literal check never saw.
    const keys: Array<[string, string]> = [
      ['', `(globalThis.K || '_0x1a') + '2b3c'`],
      ['', '`${globalThis.K || \'_0x1a\'}2b3c`'],
      ['', '`${globalThis.K || \'_0x1a\'}${\'2b3c\'}`'],
      ['', `'_0x1a' + (globalThis.K || '2b3c')`],
      ['', `(globalThis.K || '_0x1a') + '2b' + '3c'`],
      ['', `(0, (globalThis.K || '_0x1a') + '2b3c')`],
      ['', `globalThis.K ? globalThis.K : '_0x1a' + '2b3c'`],
      ['', `'_0x1a'.concat(globalThis.K || '2b3c')`],
      ['', `String(globalThis.K || '_0x1a2b3c')`],
      [`var k = (globalThis.K || '_0x1a') + '2b3c';`, 'k'],
      [`var k; k = (globalThis.K || '_0x1a') + '2b3c';`, 'k'],
      [`var k = globalThis.K || '_0x1a'; k += '2b3c';`, 'k'],
      [`var c = false; var k = c ? globalThis.K : '_0x1a2b3c';`, 'k'],
      [`var { k } = { k: (globalThis.K || '_0x1a') + '2b3c' };`, 'k'],
      [`var o = { k: (globalThis.K || '_0x1a') + '2b3c' };`, 'o.k'],
      [`var o = { k: (globalThis.K || '_0x1a') + '2b3c' };`, `o['k']`],
      [`var o = {}; o.k = (globalThis.K || '_0x1a') + '2b3c';`, 'o.k'],
      [`function C() {} C.prototype.k = (globalThis.K || '_0x1a') + '2b3c'; var c = new C();`, 'c.k'],
      [`var p = ['_0x1a', '2b3c'];`, `(globalThis.K || p[0]) + p[1]`],
      [`function key() { return (globalThis.K || '_0x1a') + '2b3c'; }`, 'key()'],
      [`function key(n) { return n ? key(n - 1) : (globalThis.K || '_0x1a') + '2b3c'; }`, 'key(2)'],
      [`${DECODER} dec.x = 1;`, `dec(0) + '2b3c'`],
    ];
    for (const [setup, key] of keys) {
      for (const call of [
        `g[${key}](function _0x96d6() {})`,
        `g[${key}].call(null, function _0x96d6() {})`,
        `Reflect.get(g, ${key})(function _0x96d6() {})`,
      ]) {
        const result = await expectPreserved(`${FN}\nvar g = globalThis;\n${setup}\nlog(${call});`, ['fn:_0x96d6']);
        expect(result.renames, call).not.toContain('_0x1a2b3c');
      }
    }
    for (const spelling of ['globalThis', 'this']) {
      const result = await expectPreserved(`${FN}\nlog(${spelling}[(${spelling}.K || '_0x1a') + '2b3c'](function _0x96d6() {}));`, ['fn:_0x96d6']);
      expect(result.renames, spelling).not.toContain('_0x1a2b3c');
    }
  });

  it('a piece pins the names it fits and no other', async () => {
    // A prefix pins the names that start with it, a suffix those that end
    // in it: obfuscator.io's proxy maps spell every host name as
    // `dec(i) + 'n'`, and read as a bare fragment the `n` pinned the file.
    const result = await expectPreserved(
      `
        ${FN}
        var _0x9f9f = function (v) { return 'g:' + v.name; };
        var _0x2b3c1a = function () { return 1; };
        var g = globalThis;
        log(g[(globalThis.K || '_0x1a') + '2b3c'](function _0x96d6() {}), _0x9f9f(function _0x97d7() {}), _0x2b3c1a());
      `,
      ['fn:_0x96d6 g:_0x97d7 1'],
    );
    expect(result.renames).not.toContain('_0x1a2b3c');
    expect(result.renames).toContain('_0x9f9f');
    expect(result.renames).toContain('_0x2b3c1a');
  });

  it('a name the key spells whole in one arm is kept in both directions', async () => {
    const kept = await expectPreserved(`${FN}\nvar g = globalThis;\nlog(g[globalThis.K ?? '_0x1a2b3c'](function _0x96d6() {}));`, ['fn:_0x96d6']);
    expect(kept.renames).not.toContain('_0x1a2b3c');
    // `(g.K || 'm') + 'ap'` spells `map` when the host has no `K`; the
    // binding the Map rule would have named `map` is named something else.
    const minted = await expectPreserved(`var _0x1a2b3c = new Map();\nlog(typeof globalThis[(globalThis.K || 'm') + 'ap']);`, ['undefined']);
    expect(minted.code).not.toMatch(/\bmap\b/);
  });

  it('a key nothing resolves at all reads a host property: said once, refused at conservative', async () => {
    // The name is never spelled whole - the reading folds `String.fromCharCode`
    // of literals, not a `map` over them - so the rename is made on the
    // documented assumption, and the run says so with the read's line.
    const KEY = `[95, 48, 120, 49, 97, 50, 98, 51, 99].map((c) => String.fromCharCode(c)).join('')`;
    for (const [declaration, read] of [
      [`function _0x1a2b3c(v) { return 'fn:' + v.name; }`, `log(g[${KEY}](function _0x96d6() {}));`],
      [`function _0x1a2b3c() { this.v = 7; }`, `log(new g[${KEY}]().v);`],
      [`var _0x1a2b3c = new Map(); _0x1a2b3c.set('k', 7);`, `log(g[${KEY}].get('k'));`],
    ]) {
      const source = `\n${declaration}\nvar g = globalThis;\n${read}`;
      const conservative = await runPass(pass, source, { preset: 'conservative' });
      expect(observe(conservative.code), read).toEqual(observe(source));
      expect(conservative.ctx.renames, read).toEqual([]);
      expect(conservative.ctx.diagnostics.filter((note) => HOST.test(note.message)), read).toEqual([]);
      for (const preset of ['balanced', 'aggressive'] as const) {
        const { ctx } = await runPass(pass, source, { preset });
        const renamed = ctx.renames.some((entry) => entry.from === '_0x1a2b3c');
        // Balanced keeps a binding no rule names; the disclosure is owed
        // exactly when the name was changed.
        if (preset === 'aggressive') expect(renamed, read).toBe(true);
        const notes = ctx.diagnostics.filter((note) => HOST.test(note.message));
        expect(notes, `${preset}: ${read}`).toHaveLength(renamed ? 1 : 0);
        if (renamed) {
          expect(notes[0]!.severity, preset).toBe('warning');
          expect(notes[0]!.message, preset).toMatch(/\(line 4\)/);
        }
      }
    }
  });

  it('a read whose result is only tested for says nothing', async () => {
    const { ctx } = await runPass(pass, `var _0x1a2b3c = 1; var g = globalThis; log(typeof g[String.fromCharCode(75)], _0x1a2b3c);`, {
      preset: 'aggressive',
    });
    expect(ctx.renames.map((entry) => entry.from)).toContain('_0x1a2b3c');
    expect(ctx.diagnostics.filter((note) => HOST.test(note.message))).toEqual([]);
  });
});

describe('a program-scope binding is not renamed into a name the file reads off the global object', () => {
  // The read direction refuses a binding of the name; this is the write
  // direction: `var _0x1a2b3c = new Map()` named `map` beside
  // `globalThis.map` made the read of a host's `map` find the file's.
  const reads: Array<[string, string, string]> = [
    ['a dot read', `log(typeof globalThis.map);`, 'undefined'],
    ['through window', `log(typeof window.map);`, 'undefined'],
    ['through this', `log(typeof this.map);`, 'undefined'],
    ['through an alias assigned later', `var g; g = globalThis; log(typeof g.map);`, 'undefined'],
    ['through a sequence', `log(typeof (0, globalThis).map);`, 'undefined'],
    ['through a conditional', `var c = true; log(typeof (c ? globalThis : window).map);`, 'undefined'],
    ['through an optional member', `log(typeof globalThis?.map);`, 'undefined'],
    ['taken by a pattern', `const { map } = globalThis; log(typeof map);`, 'undefined'],
    ['through Reflect.get', `log(typeof Reflect.get(globalThis, 'map'));`, 'undefined'],
    ['through getOwnPropertyDescriptor', `log(typeof Object.getOwnPropertyDescriptor(globalThis, 'map'));`, 'undefined'],
    ['a key spelled as a sum', `log(typeof globalThis['m' + 'ap']);`, 'undefined'],
    ['a key spelled as a template', 'log(typeof globalThis[`map`]);', 'undefined'],
    ['a key held in a local', `var k = 'map'; log(typeof globalThis[k]);`, 'undefined'],
    ['probed with in', `log('map' in globalThis);`, 'false'],
    ['probed with hasOwnProperty', `log(globalThis.hasOwnProperty('map'));`, 'false'],
    ['probed with Object.hasOwn', `log(Object.hasOwn(globalThis, 'map'));`, 'false'],
    ['through the parameter of an IIFE', `log((function (d) { return typeof d.map; })(globalThis));`, 'undefined'],
    [
      'through an ES5 holder',
      `function G() { this.g = globalThis; } G.prototype.read = function () { return typeof this.g.map; }; log(new G().read());`,
      'undefined',
    ],
    ['handed back by a recursive function', `function find(o, n) { return n ? find(o, n - 1) : o; } log(typeof find(globalThis, 2).map);`, 'undefined'],
    ['through a local holder', `var o = { g: globalThis }; log(typeof o.g.map);`, 'undefined'],
    ['through a Proxy', `var p = new Proxy(globalThis, {}); log(typeof p.map);`, 'undefined'],
    ['through Object()', `log(typeof Object(globalThis).map);`, 'undefined'],
    ['spelled whole beside a part out of sight', `log(typeof globalThis[(globalThis.K || 'm') + 'ap']);`, 'undefined'],
    ['spelled whole by a table read under a parameter handed a literal', `var t = ['ma']; function dec(i) { return t[i]; } log(typeof globalThis[dec(0) + 'p']);`, 'undefined'],
    [
      'a member key anywhere, once the object has escaped',
      `var reader = function (o) { return o; }; reader = function (o) { return o; }; var o = { map: 1 }; log(typeof reader(globalThis).map, o.map);`,
      'undefined 1',
    ],
  ];
  for (const [title, read, expected] of reads) {
    it(title, async () => {
      const source = `var _0x1a2b3c = new Map();\n${read}`;
      const context = `var window = globalThis;`;
      expect(observe(`${context}\n${source}`)).toEqual([expected]);
      for (const options of PRESETS) {
        const { code } = await runPass(pass, source, options);
        expect(observe(`${context}\n${code}`), options.preset).toEqual([expected]);
        expect(code, options.preset).not.toMatch(/\bvar map\b/);
      }
    });
  }

  it('a name minted into a spelling the pieces of an unresolved key cover is disclosed', async () => {
    // The allocator refuses only a key spelled whole - every host read of
    // an undecoded obfuscator.io file is `g[dec(i) + 'y']`, and refusing
    // each letter handed out `getStringArray2` for the `y` - so the read
    // is disclosed with its line instead. The index is out of sight: with
    // a literal, the reading spells `map` whole and refuses it.
    const source = `
      var t = ['ma'];
      function dec(i) { return t[i]; }
      var _0x1a2b3c = new Map();
      log(typeof globalThis[dec(globalThis.I || 0) + 'p']);
    `;
    for (const preset of ['balanced', 'aggressive'] as const) {
      const { ctx } = await runPass(pass, source, { preset });
      expect(ctx.renames, preset).toContainEqual(expect.objectContaining({ from: '_0x1a2b3c', to: 'map' }));
      const notes = ctx.diagnostics.filter((note) => HOST.test(note.message));
      expect(notes, preset).toHaveLength(1);
      expect(notes[0]!.message, preset).toMatch(/\(line 5\)/);
    }
  });
});
