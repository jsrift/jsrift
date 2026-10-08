import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A `.name` read reaching a function through a holder by a way the walk
 * did not follow. A builtin handed a local - `Reflect.get(o, 'k')`,
 * `Object.values(o)[0]`, `Object.assign({}, { k: f }).k`, `Promise.all([f])`
 * - returns nothing of its own: what comes back is an argument, an
 * element of one or a member of one, and each is read as the result. A
 * getter of a literal or a class and a class field are read as the value
 * they hold; a store made through an alias of the holder is a store into
 * it; `Object.assign(o, src)` stores every key of `src`; `arr.find(f)`,
 * `arr.pop()` and `arr.filter(f)[0]` are elements of an array this file
 * wrote out. Each of these renamed the function silently at aggressive.
 * Where the holder is proven the read pins the function; where the walk
 * still cannot see - a method's result handed through `Reflect.apply` -
 * it says so, once, at aggressive. A builtin's result opened twice,
 * `arr.map(f)` and a fold used to be said rather than followed; the walk
 * now follows each holder to the read, and they pin.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

const WARNING = /not followed/;

async function observe(code: string): Promise<string[]> {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return logs;
}

async function run(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, options);
  const warned = ctx.diagnostics.filter((note) => WARNING.test(note.message)).length;
  return { code, renames: ctx.renames.map((entry) => entry.from), warned, printed: await observe(code) };
}

/** Input and output print the same thing at every preset with no warning; returns the aggressive output. */
async function expectPreserved(source: string, expected: string[]): Promise<string> {
  expect(await observe(source)).toEqual(expected);
  let aggressive = '';
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(result.printed, options.preset).toEqual(expected);
    expect(result.warned, `${options.preset} warned`).toBe(0);
    if (options.preset === 'aggressive') aggressive = result.code;
  }
  return aggressive;
}

/** Balanced and conservative print what the input prints; aggressive drifts and warns exactly once. */
async function expectDisclosed(source: string, expected: string[], renamed: string): Promise<void> {
  expect(await observe(source)).toEqual(expected);
  for (const options of PRESETS) {
    const result = await run(source, options);
    if (options.preset === 'aggressive') {
      expect(result.renames, 'aggressive').toContain(renamed);
      expect(result.printed, 'aggressive').not.toEqual(expected);
      expect(result.warned, 'aggressive warned').toBe(1);
    } else {
      expect(result.printed, options.preset).toEqual(expected);
      expect(result.warned, `${options.preset} warned`).toBe(0);
    }
  }
}

const wrap = (body: string): string => `(function () { var _0xh = function () {}; ${body} })();`;

describe('a .name read off what a builtin returns', () => {
  it('is read off each argument, its elements and its members', async () => {
    for (const body of [
      `var o = { k: _0xh }; log(Reflect.get(o, 'k').name);`,
      `var o = { k: _0xh }; log(Object.values(o)[0].name);`,
      `var o = { k: _0xh }; for (const v of Object.values(o)) log(v.name);`,
      `log(Object.assign({}, { k: _0xh }).k.name);`,
      `var o = { k: _0xh }; log(Object.getOwnPropertyDescriptor(o, 'k').value.name);`,
      `var o = {}; Object.assign(o, { k: _0xh }); log(o.k.name);`,
      `var arr = [_0xh]; log(Array.from(arr)[0].name);`,
    ]) {
      // Before: aggressive printed `k` or `fn1` with no warning.
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('a builtin’s promise settles to what it was handed', async () => {
    const code = await expectPreserved(
      `var _0xh = function () {}; Promise.resolve(_0xh).then(function (v) { log(v.name); });`,
      ['_0xh'],
    );
    expect(code).toContain('_0xh');
  });

  it('the global object handed to a builtin is the boundary, not a holder', async () => {
    // Nothing of ours is in it that this file did not store there by name.
    const code = await expectPreserved(
      `
        var _0x5a5a = function () { return 1; };
        var $ = function (w) { return { name: 'q' }; };
        log($(globalThis).name, _0x5a5a());
      `,
      ['q 1'],
    );
    expect(code).not.toContain('_0x5a5a');
  });

  it('opened twice is followed: the pairs of entries, the value of a descriptor', async () => {
    // Before: disclosed at aggressive, the second selection past the
    // builtin being one the walk did not model.
    for (const body of [
      `var o = { k: _0xh }; for (const [k, v] of Object.entries(o)) log(v.name);`,
      `var o = { k: _0xh }; log(Object.getOwnPropertyDescriptors(o).k.value.name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('a call of a local through Reflect.apply is disclosed, as the call itself is', async () => {
    await expectDisclosed(wrap(`var o = { get() { return _0xh; } }; log(Reflect.apply(o.get, o, []).name);`), ['_0xh'], '_0xh');
  });
});

describe('a .name read through a getter, a class field, an alias, an array method', () => {
  it('a getter of a literal, of a class instance, of a class held by a local', async () => {
    for (const body of [
      `var o = { get f() { return _0xh; } }; log(o.f.name);`,
      `log(new (class { get f() { return _0xh; } })().f.name);`,
      `var _0xC = class { get f() { return _0xh; } }; log(new _0xC().f.name);`,
      `class C { get f() { return _0xh; } } log(new C().f.name);`,
      `class C { constructor() { this.f = _0xh; } } log(new C().f.name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('a static field and a static getter', async () => {
    for (const body of [`class C { static f = _0xh; } log(C.f.name);`, `class C { static get f() { return _0xh; } } log(C.f.name);`]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('a store through an alias, read back through the holder', async () => {
    for (const body of [
      `var o = {}; var p = o; p.k = _0xh; log(o.k.name);`,
      `var o = {}; var p = o; var q = p; q.k = _0xh; log(o.k.name);`,
      `var o = {}; (function (p) { p.k = _0xh; })(o); log(o.k.name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('a computed destructure of the holder', async () => {
    const code = await expectPreserved(wrap(`var o = { k: _0xh }; var k = 'k'; const { [k]: x } = o; log(x.name);`), ['_0xh']);
    expect(code).toContain('_0xh');
  });

  it('an element an array method hands back', async () => {
    for (const body of [
      `var arr = [_0xh]; log(arr.find(function (x) { return x; }).name);`,
      `var arr = [_0xh]; log(arr.filter(Boolean)[0].name);`,
      `var arr = [_0xh]; log(arr.slice()[0].name);`,
      `var arr = [_0xh]; log(arr.at(0).name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('what a callback returns is an element of the copy', async () => {
    // Before: disclosed at aggressive; what the callback returned was not
    // followed into `map`'s result.
    const code = await expectPreserved(wrap(`var arr = [_0xh]; log(arr.map(function (x) { return x; })[0].name);`), ['_0xh']);
    expect(code).toContain('_0xh');
  });

  it('a method whose name is undecoded, on an array this file wrote out, hands its elements to the callback', async () => {
    // `[f, g][dec(1)](h)`: `forEach`, `map`, `find` - the callback receives
    // the elements, and the key it reads may be `name`.
    const code = await expectPreserved(
      `
        var tbl = ['name', 'forEach']; var keep = tbl;
        function dec(i) { return tbl[i]; }
        var _0xf = function (v) { log(v[dec(0)]); };
        [function _0xdddd() {}, function _0xeeee() {}][dec(1)](_0xf);
        log(keep.length);
      `,
      ['_0xdddd', '_0xeeee', '2'],
    );
    expect(code).toContain('_0xdddd');
    expect(code).toContain('_0xeeee');
  });
});

describe('a builtin that reads a key, and a holder a builtin built', () => {
  it('Reflect.get and getOwnPropertyDescriptor with a key nothing resolves read it as .name', async () => {
    const TABLE = `var tbl = ['name', 'value']; var keep = tbl; function dec(i) { return tbl[i]; }`;
    for (const read of [
      `log(Reflect.get(_0x1, dec(0)), keep.length);`,
      `log(Object.getOwnPropertyDescriptor(_0x1, dec(0)).value, keep.length);`,
      `log(Reflect.get(_0x1, 'name'), keep.length);`,
      `const { [dec(0)]: n } = _0x1; log(n, keep.length);`,
    ]) {
      // Before: aggressive printed `val1`.
      const code = await expectPreserved(`${TABLE} class _0x1 {} ${read}`, ['_0x1 2']);
      expect(code, read).toContain('class _0x1');
    }
  });

  it('a Map built from our values hands them back', async () => {
    const code = await expectPreserved(`class _0x1 {} var m = new Map([['c', _0x1]]); log(m.get('c').name);`, ['_0x1']);
    expect(code).toContain('class _0x1');
  });
});

describe('a .name read through a collection, a descriptor, a prototype', () => {
  it('is read off what the collection was given, however it was given', async () => {
    // Each printed `fn1`, `k` or `value` at aggressive with no word said:
    // the store - `m.set`, `defineProperty`, `fromEntries`, a `__proto__`
    // - was one the walk did not read back.
    for (const body of [
      `var o = Object.fromEntries([['k', _0xh]]); log(o.k.name);`,
      `var o = Object.fromEntries(new Map([['k', _0xh]])); log(o.k.name);`,
      `const { k } = Object.fromEntries([['k', _0xh]]); log(k.name);`,
      `var entries; entries = [['k', _0xh]]; log(Object.fromEntries(entries).k.name);`,
      `var m = new Map(); m.set('k', _0xh); log(m.get('k').name);`,
      `var m = new Map(); var m2; m2 = m; m.set('k', _0xh); log(m2.get('k').name);`,
      `var m = new Map(); m.set('k', _0xh); log((0, m).get('k').name);`,
      `var m = new Map(); m.set('k', _0xh); var c = true; log((c ? m : null).get('k').name);`,
      `var m = new Map(); m.set('k', _0xh); log(m.get.call(m, 'k').name);`,
      `var m = new Map().set('k', _0xh).set('j', 1); log(m.get('k').name);`,
      `var m = new Map(); m.set('k', _0xh); for (const f of m.values()) log(f.name);`,
      `var k1 = {}; var m = new WeakMap(); m.set(k1, _0xh); log(m.get(k1).name);`,
      `log(new Map(Object.entries({ k: _0xh })).get('k').name);`,
      `var s = new Set([_0xh]); for (const f of s) log(f.name);`,
      `log(Array.from(new Set([_0xh]))[0].name);`,
      `log(Array.from(new Set([_0xh]), (f) => f)[0].name);`,
      `log([...new Set([_0xh])][0].name);`,
      `new Set([_0xh]).forEach((f) => log(f.name));`,
      `log(new Set([_0xh]).values().next().value.name);`,
      `function walk(s, n) { if (n) return walk(s, n - 1); for (const f of s) log(f.name); } walk(new Set([_0xh]), 2);`,
      `var o = { k: _0xh }; var p = { __proto__: o }; log(p.k.name);`,
      `var o = { k: _0xh }; var p = { __proto__: { __proto__: o } }; log(p.k.name);`,
      `var o = { k: _0xh }; log(Object.create(o).k.name);`,
      `var o = { k: _0xh }; log(Object.setPrototypeOf({}, o).k.name);`,
      `log(Object.assign(Object.create(null), { k: _0xh }).k.name);`,
      `var o = {}; Object.defineProperty(o, 'k', { value: _0xh }); log(o.k.name);`,
      `var o = {}; Object.defineProperty(o, 'k', { get() { return _0xh; } }); log(o.k.name);`,
      `var o = {}; var d = { value: _0xh }; Object.defineProperty(o, 'k', d); log(o.k.name);`,
      `var o = {}; var k = 'k'; Object.defineProperty(o, k, { value: _0xh }); log(o[k].name);`,
      `var o = {}; Reflect.defineProperty(o, 'k', { value: _0xh }); log(o.k.name);`,
      `var o = Object.defineProperties({}, { k: { value: _0xh } }); log(o.k.name);`,
      `var ds = { k: { value: _0xh } }; var o = Object.defineProperties({}, ds); log(o.k.name);`,
      `log(Object.defineProperty({}, 'k', { value: _0xh }).k.name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('a receiver awaited', async () => {
    const code = await expectPreserved(
      `(async function () { var _0xh = function () {}; var m = new Map(); m.set('k', _0xh); log((await m).get('k').name); })();`,
      ['_0xh'],
    );
    expect(code).toContain('_0xh');
  });

  it('defined on the global object by a builtin, read back through it', async () => {
    for (const source of [
      `Object.defineProperty(globalThis, 'h', { value: function _0x96d6() {} }); log(globalThis.h.name);`,
      `Object.defineProperties(globalThis, { h: { value: function _0x96d6() {} } }); log(globalThis.h.name);`,
      `Object.defineProperty(this, 'h', { value: function _0x96d6() {} }); log(this.h.name);`,
      `var g = globalThis; Object.defineProperty(g, 'h', { value: function _0x96d6() {} }); log(g.h.name);`,
    ]) {
      const code = await expectPreserved(source, ['_0x96d6']);
      expect(code, source).toContain('_0x96d6');
    }
  });

  it('what a callback made, a method of an instance stored, a fold: followed', async () => {
    // Before: each disclosed at aggressive. The pairs a callback returns
    // are what `fromEntries` is given; `this.m` inside a prototype method
    // is the instance's, stored into at `r.add(f)` and read back through
    // `r`; what a fold's callback returns is the fold.
    for (const body of [
      `var o = Object.fromEntries([['k', _0xh]].map((x) => x)); log(o.k.name);`,
      `function Reg() { this.m = new Map(); } Reg.prototype.add = function (f) { this.m.set('k', f); }; var r = new Reg(); r.add(_0xh); log(r.m.get('k').name);`,
      `var arr = [_0xh]; log(arr.reduce(function (a, f) { return f; }, null).name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });
});

describe('a .name read through a subclass, an instance a builtin made, a generator', () => {
  it('a static field of the parent, read off the class that extends it', async () => {
    // `B.f` reads `A.f` through the prototype chain, and `Object.getPrototypeOf(B)`
    // is `A`; each printed `fn1` at aggressive with no word said.
    for (const body of [
      `class A { static f = _0xh; } class B extends A {} log(B.f.name);`,
      `class A { static f = _0xh; } class B extends A {} class D extends B {} log(D.f.name);`,
      `class A { static f = _0xh; } class B extends A {} var { f } = B; log(f.name);`,
      `class A { static f = _0xh; } class B extends A {} log(Object.getPrototypeOf(B).f.name);`,
      `class A { static f = _0xh; } class B extends A {} log(B.f['na' + 'me']);`,
      `class A { static f = _0xh; } class B extends A {} log(String(B.f.name));`,
      `class A { static get f() { return _0xh; } } class B extends A {} log(B.f.name);`,
      `class A { static f; static { A.f = _0xh; } } class B extends A {} log(B.f.name);`,
      `class A { static f = _0xh; } class B extends (A) {} log(B.f.name);`,
      `class A { static f = _0xh; } class B extends A { constructor() { super(); } } log(B.f.name);`,
      `function A() {} A.f = _0xh; class B extends A {} log(B.f.name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('an instance made by Reflect.construct holds what the constructor stored', async () => {
    // `Reflect.construct(K, [f])` is `new K(f)`; before, the list was an escape and `fn1` was printed.
    for (const body of [
      `function K(f) { this.k = f; } var q = [Reflect.construct(K, [_0xh]).k]; log(q[0].name);`,
      `function K(f) { this.k = f; } var q = [Reflect.construct(K, [_0xh]).k]; log(Object.getOwnPropertyDescriptor(q[0], 'name').value);`,
      `class K { constructor(f) { this.k = f; } } log(Reflect.construct(K, [_0xh]).k.name);`,
    ]) {
      const code = await expectPreserved(wrap(body), ['_0xh']);
      expect(code, body).toContain('_0xh');
    }
  });

  it('what a generator returns is the value of its last next(), out of a call result: disclosed', async () => {
    // Before: renamed with no word said.
    await expectDisclosed(wrap(`function* g() { return _0xh; } var q = [g().next().value]; log(q[0].name);`), ['_0xh'], '_0xh');
    await expectDisclosed(wrap(`function* g() { return _0xh; } log(g().next().value[globalThis.K || 'name']);`), ['_0xh'], '_0xh');
  });
});
