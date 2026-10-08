import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A key nothing resolves - `v[globalThis.KEY]`, `v[dec(0)]` with the
 * decoder refused - read on a parameter widens exactly as `v.name` does,
 * to what every caller passes; and the callers are wherever the reader
 * can be run from. The rule held for a plain call and a method of a
 * local, and for nothing else the `.name` twin handled: an ES5 prototype
 * method, `.apply`, `.bind`, `Reflect.apply`, a class field, a subclass
 * constructor, `arguments[0]`, a getter reading what the constructor
 * stored, a reader let go of into an array or a `Map` and called back
 * out of it, a callback of an array method spelled any way. Each printed
 * `fn:val1` at aggressive with no word said. Every shape here is run
 * with both readings - `.name` outright and the opaque key - and the
 * twins must agree.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

async function observe(code: string): Promise<string[]> {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  // A reader that is async prints from the microtask queue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return logs;
}

/** Input and output print the same thing at every preset. */
async function expectPreserved(source: string, expected: string[], label: string): Promise<void> {
  expect(await observe(source), label).toEqual(expected);
  for (const options of PRESETS) {
    const { code } = await runPass(pass, source, options);
    expect(await observe(code), `${options.preset}: ${label}`).toEqual(expected);
  }
}

const KEY = `globalThis.KEY = 'name';`;
const FN = `function _0x96d6() {}`;
const DECODER = `var t = ['bmFtZQ=='];
function dec(i) { var s = t[i], k = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', o = '', b = 0, n = 0; for (var j = 0; j < s.length && s[j] !== '='; j++) { b = (b << 6) | k.indexOf(s[j]); n += 6; if (n >= 8) { n -= 8; o += String.fromCharCode((b >> n) & 255); } } return o; }
dec.cache = {};`;

/** The readings a shape is run under: `.name`, the opaque key, and a refused decoder's result. */
const READINGS: Array<[string, string, string]> = [
  ['.name', '.name', ''],
  ['[globalThis.KEY]', '[globalThis.KEY]', KEY],
  ['[dec(0)]', '[dec(0)]', DECODER],
];

/** `%R%` is the reading; `%P%` the prelude it needs, placed before the shape. */
function twins(title: string, shape: string, expected: string[]): void {
  for (const [name, read, prelude] of READINGS) {
    it(`${title}, read as ${name}`, async () => {
      await expectPreserved(`${prelude}\n${shape.replaceAll('%R%', read)}`, expected, title);
    });
  }
}

describe('a reader reached through the object model', () => {
  twins('an ES5 prototype method', `function C() {} C.prototype.m = function (v) { return 'fn:' + v%R%; }; log(new C().m(${FN}));`, ['fn:_0x96d6']);
  twins('an ES5 prototype method through call', `function C() {} C.prototype.m = function (v) { return 'fn:' + v%R%; }; log(C.prototype.m.call(new C(), ${FN}));`, ['fn:_0x96d6']);
  twins('a prototype replaced whole', `function C() {} C.prototype = { m: function (v) { return 'fn:' + v%R%; } }; log(new C().m(${FN}));`, ['fn:_0x96d6']);
  twins('a prototype extended by Object.assign', `function C() {} Object.assign(C.prototype, { m: function (v) { return 'fn:' + v%R%; } }); log(new C().m(${FN}));`, ['fn:_0x96d6']);
  twins('a prototype extended by defineProperty', `function C() {} Object.defineProperty(C.prototype, 'm', { value: function (v) { return 'fn:' + v%R%; } }); log(new C().m(${FN}));`, ['fn:_0x96d6']);
  twins('a class field arrow', `class C { m = (v) => 'fn:' + v%R%; } log(new C().m(${FN}));`, ['fn:_0x96d6']);
  twins('a class field arrow taken by a pattern', `class C { m = (v) => 'fn:' + v%R%; } var { m } = new C(); log(m(${FN}));`, ['fn:_0x96d6']);
  twins('a static method', `class C { static m(v) { return 'fn:' + v%R%; } } log(C.m(${FN}));`, ['fn:_0x96d6']);
  twins('a subclass constructor', `class A { constructor(v) { this.n = v%R%; } } class B extends A {} log(new B(${FN}).n);`, ['_0x96d6']);
  twins('a subclass constructor passing its arguments through', `class A { constructor(v) { this.n = v%R%; } } class B extends A { constructor(...a) { super(...a); } } log(new B(${FN}).n);`, ['_0x96d6']);
  twins('a subclass two deep', `class A { constructor(v) { this.n = v%R%; } } class B extends A {} class D extends B {} log(new D(${FN}).n);`, ['_0x96d6']);
});

describe('a reader called by another spelling', () => {
  twins('apply', `function _0xr(v) { return 'fn:' + v%R%; } log(_0xr.apply(null, [${FN}]));`, ['fn:_0x96d6']);
  twins('bind then call', `function _0xr(v) { return 'fn:' + v%R%; } log(_0xr.bind(null)(${FN}));`, ['fn:_0x96d6']);
  twins('bind then call through call', `function _0xr(v) { return 'fn:' + v%R%; } log(_0xr.bind(null).call(null, ${FN}));`, ['fn:_0x96d6']);
  twins('Reflect.apply', `function _0xr(v) { return 'fn:' + v%R%; } log(Reflect.apply(_0xr, null, [${FN}]));`, ['fn:_0x96d6']);
  twins('a recursive reader', `function _0xr(v, n) { return n ? _0xr(v, n - 1) : 'fn:' + v%R%; } log(_0xr(${FN}, 2));`, ['fn:_0x96d6']);
  twins('an async reader', `async function _0xr(v) { return 'fn:' + v%R%; } _0xr(${FN}).then(log);`, ['fn:_0x96d6']);
  twins('a generator reader', `function* _0xr(v) { yield 'fn:' + v%R%; } log([..._0xr(${FN})][0]);`, ['fn:_0x96d6']);
});

describe('a reader called through a bound function, a constructor a builtin runs, an inherited method', () => {
  // `f.bind(r)` with nothing bound is `f`, its parameters in the same
  // places; `Reflect.construct(R, [a])` is `new R(a)`; `Object.create(p).m`
  // is `p.m`. Each printed `fn:val1` at aggressive with no word said.
  twins('bound then applied', `function _0xr(v) { return 'fn:' + v%R%; } log(_0xr.bind(null).apply(null, [${FN}]));`, ['fn:_0x96d6']);
  twins('bound then Reflect.apply', `function _0xr(v) { return 'fn:' + v%R%; } log(Reflect.apply(_0xr.bind(null), null, [${FN}]));`, ['fn:_0x96d6']);
  twins('a bound constructor', `function _0xr(v) { return 'fn:' + v%R%; } function R(v) { this.n = _0xr(v); } log(new (R.bind(null))(${FN}).n);`, ['fn:_0x96d6']);
  twins('Reflect.construct', `function _0xr(v) { return 'fn:' + v%R%; } function R(v) { this.n = _0xr(v); } log(Reflect.construct(R, [${FN}]).n);`, ['fn:_0x96d6']);
  twins('a method inherited from Object.create', `function _0xr(v) { return 'fn:' + v%R%; } log(Object.create({ m(v) { return _0xr(v); } }).m(${FN}));`, ['fn:_0x96d6']);
});

describe('the argument read through arguments', () => {
  twins('arguments[0]', `function _0xr() { return 'fn:' + arguments[0]%R%; } log(_0xr(${FN}));`, ['fn:_0x96d6']);
  twins('an alias of arguments', `function _0xr() { var a = arguments; return 'fn:' + a[0]%R%; } log(_0xr(${FN}));`, ['fn:_0x96d6']);
  twins('Array.from(arguments)', `function _0xr() { return 'fn:' + Array.from(arguments)[0]%R%; } log(_0xr(${FN}));`, ['fn:_0x96d6']);
  twins('slice.call(arguments)', `function _0xr() { return 'fn:' + [].slice.call(arguments)[0]%R%; } log(_0xr(${FN}));`, ['fn:_0x96d6']);
});

describe('the argument stored on the instance and read back', () => {
  twins('a getter reading what the constructor stored', `class C { constructor(v) { this.v = v; } get n() { return this.v%R%; } } log(new C(${FN}).n);`, ['_0x96d6']);
  twins('a method reading it', `class C { constructor(v) { this.v = v; } m() { return this.v%R%; } } log(new C(${FN}).m());`, ['_0x96d6']);
  twins('a field arrow reading it', `class C { constructor(v) { this.v = v; } n = () => this.v%R%; } log(new C(${FN}).n());`, ['_0x96d6']);
  twins('read off the instance outside', `class C { constructor(v) { this.v = v; } } log(new C(${FN}).v%R%);`, ['_0x96d6']);
  twins('read off an instance a local holds', `class C { constructor(v) { this.v = v; } } var c = new C(${FN}); log(c.v%R%);`, ['_0x96d6']);
  twins('the ES5 twin, read in a prototype method', `function C(v) { this.v = v; } C.prototype.m = function () { return this.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the ES5 twin, read outside', `function C(v) { this.v = v; } log(new C(${FN}).v%R%);`, ['_0x96d6']);
  twins('stored by defineProperty on this', `function C(v) { Object.defineProperty(this, 'v', { value: v }); } C.prototype.m = function () { return this.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('read by a getter defined on the prototype', `function C(v) { this.v = v; } Object.defineProperty(C.prototype, 'n', { get: function () { return this.v%R%; } }); log(new C(${FN}).n);`, ['_0x96d6']);
});

describe('the argument stored on the instance and read back in a method that reaches the prototype otherwise', () => {
  // obfuscator.io spells `C.prototype.m = ...` as `C[k].m = ...` with `k`
  // decoded at run time, and `{ m }` for a method held by a local; the
  // reader was recognised on `C.prototype.<k> = fn` alone, and each of
  // these printed `fn:val2` at aggressive with no word said.
  const PROTO = `[globalThis.PROTO || 'prototype']`;
  twins('a method on the prototype under a key nothing resolves', `function C(v) { this.v = v; } C${PROTO}.m = function () { return this.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the same through a string key', `function C(v) { this.v = v; } C${PROTO}['m'] = function () { return this.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the same, read through an alias of this', `function C(v) { this.v = v; } C${PROTO}.m = function () { var self = this; return self.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the same, assigned onto it whole', `function C(v) { this.v = v; } Object.assign(C${PROTO}, { m: function () { return this.v%R%; } }); log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the same, the prototype replaced whole', `function C(v) { this.v = v; } C${PROTO} = { m: function () { return this.v%R%; } }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the same, through an alias of the prototype', `function C(v) { this.v = v; } var proto = C${PROTO}; proto.m = function () { return this.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the same, on a class', `class C { constructor(v) { this.v = v; } } C${PROTO}.m = function () { return this.v%R%; }; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('Object.assign with the method spelled by name', `function C(v) { this.v = v; } var m = function () { return this.v%R%; }; Object.assign(C.prototype, { m }); log(new C(${FN}).m());`, ['_0x96d6']);
  twins('the method read off a holder under a key nothing resolves', `function C(v) { this.v = v; } var P = {}; P[globalThis.K || 'x'] = function () { return this.v%R%; }; C.prototype.m = P[globalThis.K || 'x']; log(new C(${FN}).m());`, ['_0x96d6']);
  twins('a parameter read in a method on the prototype under a key nothing resolves', `function C() {} C${PROTO}.m = function (v) { return 'fn:' + v%R%; }; log(new C().m(${FN}));`, ['fn:_0x96d6']);
});

describe('a reader let go of into a holder and called back out of it', () => {
  twins('declared in a loop and pushed', `var q = []; for (var i = 0; i < 1; i++) { function _0xf(v) { return 'fn:' + v%R%; } q.push(_0xf); } log(q[0](${FN}));`, ['fn:_0x96d6']);
  twins('declared in a block and pushed', `var q = []; { function _0xf(v) { return 'fn:' + v%R%; } q.push(_0xf); } log(q[0](${FN}));`, ['fn:_0x96d6']);
  twins('pushed under a condition', `var q = []; for (var i = 0; i < 1; i++) { function _0xf(v) { return 'fn:' + v%R%; } if (i === 0) q.push(_0xf); } log(q[0](${FN}));`, ['fn:_0x96d6']);
  twins('a program-scope function pushed', `function _0xf(v) { return 'fn:' + v%R%; } var q = []; q.push(_0xf); log(q[0](${FN}));`, ['fn:_0x96d6']);
  twins('unshifted', `function _0xf(v) { return 'fn:' + v%R%; } var q = []; q.unshift(_0xf); log(q[0](${FN}));`, ['fn:_0x96d6']);
  twins('in an array literal', `function _0xf(v) { return 'fn:' + v%R%; } var q = [_0xf]; log(q[0](${FN}));`, ['fn:_0x96d6']);
  twins('in an object literal', `function _0xf(v) { return 'fn:' + v%R%; } var q = { m: _0xf }; log(q.m(${FN}));`, ['fn:_0x96d6']);
  twins('in an object literal, called by string key', `function _0xf(v) { return 'fn:' + v%R%; } var q = { m: _0xf }; log(q['m'](${FN}));`, ['fn:_0x96d6']);
  twins('in an object literal, called by a key nothing resolves', `function _0xf(v) { return 'fn:' + v%R%; } var q = { m: _0xf }; globalThis.M = 'm'; log(q[globalThis.M](${FN}));`, ['fn:_0x96d6']);
  twins('handed to a callback of the array', `function _0xf(v) { return 'fn:' + v%R%; } var q = []; q.push(_0xf); q.forEach((f) => log(f(${FN})));`, ['fn:_0x96d6']);
  twins('popped', `function _0xf(v) { return 'fn:' + v%R%; } var q = []; q.push(_0xf); log(q.pop()(${FN}));`, ['fn:_0x96d6']);
  twins('taken with at', `function _0xf(v) { return 'fn:' + v%R%; } var q = [_0xf]; log(q.at(-1)(${FN}));`, ['fn:_0x96d6']);
  twins('called through a loop index', `function _0xf(v) { return 'fn:' + v%R%; } var q = []; q.push(_0xf); for (var i = 0; i < q.length; i++) log(q[i](${FN}));`, ['fn:_0x96d6']);
  twins('set in a Map and got back', `function _0xf(v) { return 'fn:' + v%R%; } var q = new Map(); q.set('f', _0xf); log(q.get('f')(${FN}));`, ['fn:_0x96d6']);
});

describe('a callback handed the elements of an array of functions', () => {
  const VS = `var vs = [function _0xffff() {}, class _0x1111 {}];`;
  const BOTH = ['_0xffff', '_0x1111'];
  twins('forEach', `${VS} vs.forEach((v) => log(v%R%));`, BOTH);
  twins('map', `${VS} log(vs.map((v) => v%R%).join(','));`, ['_0xffff,_0x1111']);
  twins('reduce', `${VS} log(vs.reduce((a, v) => a + v%R%, ''));`, ['_0xffff_0x1111']);
  twins('for-in', `${VS} for (var i in vs) log(vs[i]%R%);`, BOTH);
  twins('forEach through call', `${VS} Array.prototype.forEach.call(vs, (v) => log(v%R%));`, BOTH);
  twins('a method whose name nothing resolves', `${VS} globalThis.M = 'forEach'; vs[globalThis.M](function (v) { log(v%R%); });`, BOTH);
  twins('a pattern over nested arrays', `var vs = [[function _0xffff() {}], [class _0x1111 {}]]; vs.forEach(([v]) => log(v%R%));`, BOTH);
  twins('Object.values of a literal', `var vs = { a: function _0xffff() {} }; log(Object.values(vs)[0]%R%);`, ['_0xffff']);
  twins('a rest parameter iterated', `function _0xf(...vs) { vs.forEach(function (v) { log(v%R%); }); } _0xf(function _0xffff() {}, class _0x1111 {});`, BOTH);
  twins('a rest parameter in for-of', `function _0xf(...vs) { for (var v of vs) log(v%R%); } _0xf(function _0xffff() {}, class _0x1111 {});`, BOTH);
  twins('a rest parameter indexed', `function _0xf(...vs) { log(vs[0]%R%); } _0xf(function _0xffff() {});`, ['_0xffff']);
  twins('a rest parameter mapped', `function _0xf(...vs) { return vs.map((v) => v%R%); } log(_0xf(function _0xffff() {}, class _0x1111 {}).join(','));`, ['_0xffff,_0x1111']);
  twins('a rest parameter through a method nothing resolves', `function _0xf(...vs) { vs[globalThis.M](function (v) { log(v%R%); }); } globalThis.M = 'forEach'; _0xf(function _0xffff() {}, class _0x1111 {});`, BOTH);
  twins('a plain parameter through a method nothing resolves', `function _0xf(vs) { vs[globalThis.M](function (v) { log(v%R%); }); } globalThis.M = 'forEach'; _0xf([function _0xffff() {}, class _0x1111 {}]);`, BOTH);
});
