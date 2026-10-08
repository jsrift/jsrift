import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * One value-flow walk for the global object, a caught error and this
 * file's own functions and classes, and one reading of a key's strings.
 *
 * Three rounds running, each of the three walks covered a different subset
 * of the spellings a value passes through, and the shape one missed was a
 * program-scope function renamed under a read through the window, an
 * error text with a new name in it, a function renamed out from under a
 * `.name` read of it. Every shape here printed a `TypeError`, a renamed
 * name in an error message, or `val1` for `_0x96d6` at some preset before
 * the walks were one; each is now followed by `Flow` - the same positions,
 * holders, builtins, callees and accessors whichever value is walked - and
 * a key's strings by `keyStrings`, whole and in parts at once.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print. A shape read as an opaque key
 * (`v[k]` with `k` nothing here resolves) is run beside its `.name` twin
 * wherever the reading is of a function's name, since the D invariant
 * holds the two to one answer.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

async function observe(code: string, host: Record<string, unknown> = {}): Promise<string[]> {
  const logs: string[] = [];
  const context = vm.createContext({ ...host, log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  // What an async body prints after its first `await`, and a `then` handler.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return logs;
}

interface Run {
  code: string;
  renames: string[];
  warned: number;
  noted: number;
}

async function run(source: string, options: DeobfuscateOptions): Promise<Run> {
  const { code, ctx } = await runPass(pass, source, options);
  const messages = ctx.diagnostics.map((note) => note.message);
  return {
    code,
    renames: ctx.renames.map((entry) => entry.from),
    warned: messages.filter((message) => /reads the name of a function|error text/.test(message)).length,
    noted: messages.filter((message) => /kept their names: the global object/.test(message)).length,
  };
}

/** Input and output print the same thing at every preset; returns the aggressive run. */
async function expectPreserved(source: string, host: Record<string, unknown> = {}): Promise<Run> {
  const expected = await observe(source, host);
  let aggressive!: Run;
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(await observe(result.code, host), `${options.preset}: ${source}`).toEqual(expected);
    aggressive = result;
  }
  return aggressive;
}

const MAP = `var _0x1a2b3c = new Map(); _0x1a2b3c.set('k', 7);`;
const FN = `(function _0x96d6() {})`;

describe('the global object, followed by the one walk', () => {
  const shapes: Array<[string, string]> = [
    ['stored by a setter into an outer variable', `var h; var o = { set g(v) { h = v; } }; o.g = globalThis; log(h._0x1a2b3c.get('k'));`],
    ['stored by a class setter', `var h; class K { set g(v) { h = v; } } new K().g = globalThis; log(h._0x1a2b3c.get('k'));`],
    ['handed back by Reflect.apply(Object)', `var h = Reflect.apply(Object, null, [globalThis]); log(h._0x1a2b3c.get('k'));`],
    ['an element of Array.of', `var h = Array.of(globalThis)[0]; log(h._0x1a2b3c.get('k'));`],
    ['a WeakRef dereferenced', `var h = new WeakRef(globalThis).deref(); log(h._0x1a2b3c.get('k'));`],
    ['its own valueOf', `var h = globalThis.valueOf(); log(h._0x1a2b3c.get('k'));`],
    ['arguments[0] of an IIFE', `(function () { var h = arguments[0]; log(h._0x1a2b3c.get('k')); })(globalThis);`],
    ['the prototype of an object created from it', `var h = Object.getPrototypeOf(Object.create(globalThis)); log(h._0x1a2b3c.get('k'));`],
    ['stored into a parameter and handed back', `function keep(o) { o.g = globalThis; return o; } log(keep({}).g._0x1a2b3c.get('k'));`],
    ['stored into a parameter that is a local', `var box = {}; function keep(o) { o.g = globalThis; } keep(box); log(box.g._0x1a2b3c.get('k'));`],
    ['a chained Map.set', `var h = new Map().set('a', 1).set('g', globalThis).get('g'); log(h._0x1a2b3c.get('k'));`],
    ['a getter a descriptor installed', `var o = {}; Object.defineProperty(o, 'g', { get: function () { return globalThis; } }); log(o.g._0x1a2b3c.get('k'));`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      // Before: balanced printed a TypeError, the map renamed and the read through the spelling not in its reference list.
      const result = await expectPreserved(`${MAP}\n${read}`);
      expect(result.renames).not.toContain('_0x1a2b3c');
    });
  }
});

describe('a caught error, followed to where its text is read', () => {
  const TAIL = `let _0x1a1a = 'b';`;
  const shapes: Array<[string, string]> = [
    ['a helper taking a pattern', `function show({ err }) { log(err.message); } try { log(_0x1a1a); } catch (e) { show({ err: e }); }`],
    ['a helper taking an array pattern', `function show([err]) { log(err.message); } try { log(_0x1a1a); } catch (e) { show([e]); }`],
    ['stored by index and read back', `var errors = []; try { log(_0x1a1a); } catch (e) { errors[0] = e; } log(errors[0].message);`],
    ['stored on a local and read back', `var o = {}; try { log(_0x1a1a); } catch (e) { o.err = e; } log(o.err.message);`],
    ['stored in a Map and read back', `var m = new Map(); try { log(_0x1a1a); } catch (e) { m.set('e', e); } log(m.get('e').message);`],
    ['held by a class instance', `class R { constructor(err) { this.e = err; } show() { log(this.e.message); } } try { log(_0x1a1a); } catch (e) { new R(e).show(); }`],
    ['wrapped by Object()', `function show(err) { log(Object(err).message); } try { log(_0x1a1a); } catch (e) { show(e); }`],
    ['handed through an optional call', `function show(err) { log(err.message); } try { log(_0x1a1a); } catch (e) { show?.(e); }`],
    ['handed to a constructor', `function Show(err) { log(err.message); } try { log(_0x1a1a); } catch (e) { new Show(e); }`],
    ['handed through Reflect.apply', `function show(err) { log(err.message); } try { log(_0x1a1a); } catch (e) { Reflect.apply(show, null, [e]); }`],
    ['the cause of an outer error', `try { try { log(_0x1a1a); } catch (e) { throw new Error('outer', { cause: e }); } } catch (x) { log(x.cause.message); }`],
    ['among the errors of an AggregateError', `try { try { log(_0x1a1a); } catch (e) { throw new AggregateError([e]); } } catch (x) { log(x.errors[0].message); }`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      // Before: aggressive printed `Cannot access 'str1' before initialization`, the error lost at the store or the call.
      const result = await expectPreserved(`${read}\n${TAIL}`);
      expect(result.renames).not.toContain('_0x1a1a');
    });
  }

  it('lost into a callee the walk cannot resolve is pinned and said, at balanced too', async () => {
    // `run` is published, so `cb` may be anything the host hands it: the callback in sight is followed, the loss is said.
    const source = `function run(cb) { try { log(_0x1a1a); } catch (e) { cb(e); } } globalThis.run = run; run(function (e) { log(e.message); });\n${TAIL}`;
    const expected = await observe(source);
    for (const options of PRESETS) {
      const result = await run(source, options);
      expect(await observe(result.code), options.preset).toEqual(expected);
      if (options.preset !== 'conservative') expect(result.warned, options.preset).toBe(1);
    }
  });
});

describe('an accessor of a local object, run by any use of it but a plain read', () => {
  const GET = `var o = { get x() { return _0x3ebf; } };`;
  const TAIL = `let _0x3ebf = JSON.parse('{"a":1}'); log(typeof _0x3ebf);`;
  const shapes: Array<[string, string]> = [
    ['JSON.stringify', `${GET} try { JSON.stringify(o); } catch (e) { log(e.message); }`],
    ['Object.assign', `${GET} try { Object.assign({}, o); } catch (e) { log(e.message); }`],
    ['a spread', `${GET} try { ({ ...o }); } catch (e) { log(e.message); }`],
    ['Object.values', `${GET} try { Object.values(o); } catch (e) { log(e.message); }`],
    ['Object.entries', `${GET} try { Object.entries(o); } catch (e) { log(e.message); }`],
    ['toString through a template', `var o = { toString() { return _0x3ebf; } }; try { \`\${o}\`; } catch (e) { log(e.message); }`],
    ['valueOf through +', `var o = { valueOf() { return _0x3ebf; } }; try { o + 1; } catch (e) { log(e.message); }`],
    ['a Proxy get trap', `var o = new Proxy({}, { get() { return _0x3ebf; } }); try { o.x; } catch (e) { log(e.message); }`],
    ['Reflect.get', `${GET} try { Reflect.get(o, 'x'); } catch (e) { log(e.message); }`],
    ['a getter a descriptor installed', `var o = {}; Object.defineProperty(o, 'x', { get() { return _0x3ebf; } }); try { o.x; } catch (e) { log(e.message); }`],
    ['Symbol.iterator through a spread', `var o = { [Symbol.iterator]() { return _0x3ebf; } }; try { [...o]; } catch (e) { log(e.message); }`],
    ['a getter inherited by Object.create', `${GET} var p = Object.create(o); try { p.x; } catch (e) { log(e.message); }`],
    ['a descriptor getter called outright', `${GET} try { Object.getOwnPropertyDescriptor(o, 'x').get(); } catch (e) { log(e.message); }`],
    ['a setter through Object.assign', `var o = { set x(v) { _0x3ebf = v; } }; try { Object.assign(o, { x: 1 }); } catch (e) { log(e.message); }`],
    ['toJSON through JSON.stringify', `var o = { toJSON() { return _0x3ebf; } }; try { JSON.stringify(o); } catch (e) { log(e.message); }`],
    ['Symbol.toPrimitive through unary +', `var o = { [Symbol.toPrimitive]() { return _0x3ebf; } }; try { +o; } catch (e) { log(e.message); }`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      // Before: balanced printed `Cannot access 'data' before initialization`, the getter never counted as called.
      const result = await expectPreserved(`${read}\n${TAIL}`);
      expect(result.renames).not.toContain('_0x3ebf');
    });
  }
});

describe('a .name read through a holder the walk follows', () => {
  const wrap = (body: string): string => `(function () { var _0xh = function () {}; ${body} })();`;
  const shapes: Array<[string, string]> = [
    ['Array.of', `log(Array.of(_0xh)[0].name);`],
    ['an empty concat', `log([].concat([_0xh])[0].name);`],
    ['flat', `log([[_0xh]].flat()[0].name);`],
    ['with', `log([0].with(0, _0xh)[0].name);`],
    ['Map.groupBy', `log(Map.groupBy([_0xh], () => 'k').get('k')[0].name);`],
    ['Object.groupBy', `log(Object.groupBy([_0xh], () => 'k').k[0].name);`],
    ['fromEntries round trip', `log(Object.fromEntries(Object.entries({ k: _0xh })).k.name);`],
    ['entries indexed', `log(Object.entries({ k: _0xh })[0][1].name);`],
    ['a descriptor value', `log(Object.getOwnPropertyDescriptors({ k: _0xh }).k.value.name);`],
    ['a __proto__ assignment', `var o = { k: _0xh }; var p = {}; p.__proto__ = o; log(p.k.name);`],
    ['Reflect.setPrototypeOf', `var o = { k: _0xh }; var p = {}; Reflect.setPrototypeOf(p, o); log(p.k.name);`],
    ['Object.create with descriptors', `var o = Object.create(null, { k: { value: _0xh } }); log(o.k.name);`],
    ['Object.create two deep', `var o = { k: _0xh }; var p = Object.create(Object.create(o)); log(p.k.name);`],
    ['a prototype property', `class P {} P.prototype.k = _0xh; log(new P().k.name);`],
    ['a chained Map.set past other keys', `var m = new Map(); m.set('a', 1).set('k', _0xh); log(m.get('k').name);`],
    ['a Map handed back by a function', `function mk() { var m = new Map(); m.set('k', _0xh); return m; } log(mk().get('k').name);`],
    ['a getter a descriptor installed', `var o = {}; Object.defineProperty(o, 'k', { get() { return _0xh; } }); log(o.k.name);`],
    ['a Set copied by its constructor', `var s = new Set(); s.add(_0xh); log(new Set(s).values().next().value.name);`],
    ['Map.get through call', `var m = new Map(); m.set('k', _0xh); log(m.get.call(m, 'k').name);`],
    ['a class newed in place', `log(new (class { get f() { return _0xh; } })().f.name);`],
    ['a store into a parameter', `var o = {}; (function (p) { p.k = _0xh; })(o); log(o.k.name);`],
    ['a method on the prototype of an aliased constructor', `function C() {} C.prototype.m = function (v) { return v.name; }; var D = C; log(new D().m(_0xh));`],
    ['the same, under a key nothing resolves', `function C() {} C.prototype.m = function (v) { return v[globalThis.KEY]; }; var D = C; globalThis.KEY = 'name'; log(new D().m(_0xh));`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      // Before: aggressive printed `fn1` (or the key) with no word said.
      const result = await expectPreserved(wrap(read));
      expect(result.renames).not.toContain('_0xh');
      expect(result.warned).toBe(0);
    });
  }

  it('a Promise combinator under one more spelling', async () => {
    const PRE = `var _0xh = function _0x96d6() {}; async function _0xp() { return _0xh; }`;
    for (const read of [
      `(async () => { log((await Promise.all.apply(Promise, [[_0xp()]]))[0].name); })();`,
      `var all = Promise.all; (async () => { log((await all.call(Promise, [_0xp()]))[0].name); })();`,
      `Promise.all([_0xp()]).then(([{ name }]) => log(name));`,
      `(async () => { log((await Promise.all([_0xp()]).finally(() => {}))[0].name); })();`,
      `(async () => { log((await Promise.all([_0xp()])).at(0).name); })();`,
      `(async () => { log((await Promise.all([_0xp()])).pop().name); })();`,
      `(async () => { for await (const f of [_0xp()]) log(f.name); })();`,
      `(async () => { const f = await Promise.all([_0xp()]).then((r) => r[0]); log(f.name); })();`,
      `Promise.all([_0xp()]).then((r) => r.map((f) => f.name)).then((n) => log(n[0]));`,
      `(async () => { log((await Promise.all([_0xp()].map((x) => x)))[0].name); })();`,
    ]) {
      // Before: aggressive printed `val1` with no word said.
      const result = await expectPreserved(`${PRE}\n${read}`);
      expect(result.renames, read).not.toContain('_0x96d6');
    }
  });
});

describe('an opaque key read on a parameter widens as .name does', () => {
  const READS = { name: '.name', opaque: `[globalThis.K || 'name']` };
  const K_PRE = `var k = ['na', 'me'].join('');`;
  const twins = (title: string, shape: string): void => {
    for (const [tag, read] of Object.entries(READS)) {
      it(`${title}, read as ${tag}`, async () => {
        // Before: the `.name` twin held and the opaque one printed `fn:val1` with no word said.
        const result = await expectPreserved(`${K_PRE}\n${shape.replaceAll('READ', read)}`);
        expect(result.renames).not.toContain('_0x96d6');
      });
    }
  };
  twins('an ES5 instance method', `function C() { this.m = function (v) { return 'fn:' + vREAD; }; } log(new C().m(${FN}));`);
  twins('an ES5 subclass applying its arguments', `function C(v) { this.n = 'fn:' + vREAD; } function D() { C.apply(this, arguments); } log(new D(${FN}).n);`);
  twins('a getter returning the reader', `class C { get r() { return (v) => 'fn:' + vREAD; } } log(new C().r(${FN}));`);
  twins('apply with arguments', `function _0xr(v) { return 'fn:' + vREAD; } function w() { return _0xr.apply(null, arguments); } log(w(${FN}));`);
  twins('a spread of arguments', `function _0xr() { return 'fn:' + [...arguments][0]READ; } log(_0xr(${FN}));`);
  twins('Array.prototype.map.call on arguments', `function _0xr() { return Array.prototype.map.call(arguments, (v) => 'fn:' + vREAD)[0]; } log(_0xr(${FN}));`);
  twins('bind twice', `function _0xr(v) { return 'fn:' + vREAD; } log(_0xr.bind(null).bind(null)(${FN}));`);
  twins('Object.values of a holder', `function _0xr(v) { return 'fn:' + vREAD; } var q = { r: _0xr }; log(Object.values(q)[0](${FN}));`);
  twins('a Map literal', `function _0xr(v) { return 'fn:' + vREAD; } log(new Map([['r', _0xr]]).get('r')(${FN}));`);
  twins('a Set iterator', `function _0xr(v) { return 'fn:' + vREAD; } log(new Set([_0xr]).values().next().value(${FN}));`);
  twins('a nested array', `function _0xr(v) { return 'fn:' + vREAD; } var q = [[_0xr]]; log(q[0][0](${FN}));`);
  twins('a spread copy', `function _0xr(v) { return 'fn:' + vREAD; } var q = [_0xr]; var q2 = [...q]; log(q2[0](${FN}));`);
  twins('Object.assign onto a holder', `function _0xr(v) { return 'fn:' + vREAD; } var q = Object.assign({}, { r: _0xr }); log(q.r(${FN}));`);
  twins('a holder a function returns', `function _0xr(v) { return 'fn:' + vREAD; } function mk() { return [_0xr]; } log(mk()[0](${FN}));`);
  twins('Array.from with a mapper', `function f(vs) { return Array.from(vs, (v) => 'fn:' + vREAD); } log(f([${FN}])[0]);`);
  twins('a Map parameter iterated', `function f(m) { m.forEach((v) => log('fn:' + vREAD)); } f(new Map([['a', ${FN}]]));`);
  twins('concat into a holder', `var q = []; for (var i = 0; i < 1; i++) { const f = (v) => 'fn:' + vREAD; q = q.concat([f]); } log(q[0](${FN}));`);
  twins('Object.assign onto this', `class C { constructor(v) { Object.assign(this, { v }); } m() { return 'fn:' + this.vREAD; } } log(new C(${FN}).m());`);
  twins('a pattern on this', `class C { constructor(v) { this.v = v; } m() { const { v } = this; return 'fn:' + vREAD; } } log(new C(${FN}).m());`);
  twins('a subclass without a constructor', `class C { constructor(v) { this.n = 'fn:' + vREAD; } } class D extends C {} log(new D(${FN}).n);`);
  twins('this.m inside a class newed in place', `function _0xr(v) { return 'fn:' + vREAD; } log(new (class { m(v) { return _0xr(v); } run() { return this.m(${FN}); } })().run());`);
  twins('a callee declared twice', `var _0xf = function (v) { return typeof v; }; var _0xf = function (v) { return 'fn:' + vREAD; }; log(_0xf(${FN}));`);

  it('the four shapes the pre-round dist kept and the tree renamed', async () => {
    for (const shape of [
      `function _0xr(v) { return 'fn:' + v.name; } var q = [_0xr]; const [f] = q; log(f(${FN}));`,
      `function _0xr(v) { return 'fn:' + v.name; } var q = { r: _0xr }; const { r } = q; log(r(${FN}));`,
      `function _0xr(v) { return 'fn:' + v.name; } var q = [_0xr]; log(q.find(Boolean)(${FN}));`,
      `function _0xr() { return Array.prototype.map.call(arguments, (v) => 'fn:' + v.name)[0]; } log(_0xr(${FN}));`,
    ]) {
      const result = await expectPreserved(shape);
      expect(result.renames, shape).not.toContain('_0x96d6');
      expect(result.warned, shape).toBe(0);
    }
  });
});

describe('a key on the global object, read for its strings by one reading', () => {
  const FN_G = `function _0x1a2b3c(v) { return 'fn:' + v.name; } var g = globalThis;`;
  // A bare V8 realm has no `atob`; the host's stands in, as in the evaluator tests.
  const keys: Array<[string, string, Record<string, unknown>?]> = [
    ['appended to', `var k = globalThis.K || '_0x1a'; k += '2b3c'; var key = k;`],
    ['appended to inside the key', `var k = globalThis.K || '_0x1a'; var key = (k += '2b3c');`],
    ['a String.raw template', `var k = globalThis.K || '_0x1a'; var key = String.raw\`\${k}2b3c\`;`],
    ['through toString', `var k = globalThis.K || '_0x1a'; var key = (k + '2b3c').toString();`],
    ['a trimmed piece', `var k = globalThis.K || '_0x1a'; var key = k + ' 2b3c '.trim();`],
    ['String.prototype.concat.call', `var k = globalThis.K || '2b3c'; var key = String.prototype.concat.call('_0x1a', k);`],
    ['a class static field', `class K { static k = (globalThis.K || '_0x1a') + '2b3c'; } var key = K.k;`],
    ['a getter', `var o = { get k() { return (globalThis.K || '_0x1a') + '2b3c'; } }; var key = o.k;`],
    ['decodeURIComponent of a literal', `var key = decodeURIComponent('%5F0x1a2b3c');`],
    ['String.fromCharCode', `var key = String.fromCharCode(95, 48, 120, 49, 97, 50, 98, 51, 99);`],
    ['reversed and joined', `var key = ['3c', '2b', '_0x1a'].reverse().join('');`],
    ['sliced', `var key = 'x_0x1a2b3c'.slice(1);`],
    ['lower-cased', `var key = '_0X1A2B3C'.toLowerCase();`],
    ['atob', `var key = atob('XzB4MWEyYjNj');`, { atob }],
    ['arguments summed by an IIFE', `var key = (function () { return arguments[0] + arguments[1]; })(globalThis.K || '_0x1a', '2b3c');`],
    ['a one-entry table', `var t = ['_0x1a2b3c']; var key = t[0];`],
    ['a table read under a parameter handed a literal', `var t = ['_0x1a']; function dec(i) { return t[i]; } var key = dec(0) + '2b3c';`],
    ['a store two members deep', `var o = { a: {} }; o.a.b = (globalThis.K || '_0x1a') + '2b3c'; var key = o.a.b;`],
  ];
  for (const [title, key, host] of keys) {
    it(`${title}: the function keeps its name and the read is followed`, async () => {
      // Before: balanced printed a TypeError - the piece the key spells was dropped, or the whole never read.
      const result = await expectPreserved(`${FN_G}\n${key}\nlog(g[key](${FN}));`, host);
      expect(result.renames).not.toContain('_0x1a2b3c');
    });
  }

  it('a result merely passed along is a use, and the read is disclosed', async () => {
    const OPAQUE = `var _0x1a2b3c = 7; var g = globalThis; var k = String(globalThis.K || '');`;
    for (const use of [
      `var f = g[k]; log(typeof f);`,
      `log(typeof g[k]);`,
      `log(g[k] === undefined);`,
      `log(\`\${g[k]}\`);`,
      `function pick() { return g[k]; } log(typeof pick());`,
      `var o = { f: g[k] }; log(typeof o.f);`,
      `log(g[k] ?? 'none');`,
    ]) {
      // Before: silent for every shape but a call, a `new` and a member read.
      const { ctx } = await runPass(pass, `${OPAQUE}\n${use}`, { preset: 'aggressive' });
      expect(ctx.diagnostics.some((note) => /host property/.test(note.message)), use).toBe(true);
    }
  });
});

describe('the write direction: a name the file defines on the global object is not minted', () => {
  const defines: Array<[string, string]> = [
    ['Object.defineProperty', `Object.defineProperty(globalThis, 'map', { value: 1, configurable: true });`],
    ['Reflect.defineProperty', `Reflect.defineProperty(globalThis, 'map', { value: 1, configurable: true });`],
    ['Object.defineProperties', `Object.defineProperties(globalThis, { map: { value: 1, configurable: true } });`],
    ['Object.assign', `Object.assign(globalThis, { map: 1 });`],
    ['a free assignment', `map = 1;`],
    ['a dotted assignment', `globalThis.map = 1;`],
    ['Reflect.set', `Reflect.set(globalThis, 'map', 1);`],
    ['a key read out of an array written in place', `Object.defineProperty(globalThis, ['map'][0], { value: 1, configurable: true });`],
    ['a key read out of an array written in place, in pieces', `Object.defineProperty(globalThis, ['ma', 'p'][0] + 'p', { value: 1, configurable: true });`],
  ];
  for (const [title, define] of defines) {
    it(title, async () => {
      // Before: `_0x1a2b3c.size` printed `undefined`, the map renamed `map` and clobbered by the define.
      const result = await expectPreserved(`var _0x1a2b3c = new Map();\n${define}\nlog(_0x1a2b3c.size);`);
      expect(result.renames).not.toContain('map');
    });
  }
});

describe('obfuscator.io: a store through an opaque key of a local holder', () => {
  const DEC = `var t = ['bmFtZQ', 'cHVzaA', 'Zg', 'c2V0', 'Z2V0', 'bQ'];
function dec(i) { var s = t[i], k = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', o = '', b = 0, n = 0; for (var j = 0; j < s.length; j++) { b = (b << 6) | k.indexOf(s[j]); n += 6; if (n >= 8) { n -= 8; o += String.fromCharCode((b >> n) & 255); } } return o; }
dec.cache = {};`;
  const shapes: Array<[string, string]> = [
    ['pushed through an opaque method, then indexed', `function m(v) { return 'fn:' + v[dec(0)]; } var arr = []; arr[dec(1)](${FN}); log(m(arr[0]));`],
    ['pushed through an opaque method, then iterated', `function m(v) { return 'fn:' + v[dec(0)]; } var arr = []; arr[dec(1)](${FN}); for (const f of arr) log(m(f));`],
    ['set through an opaque method of a Map', `function m(v) { return 'fn:' + v[dec(0)]; } var mp = new Map(); mp[dec(3)]('f', ${FN}); log(m(mp.get('f')));`],
    ['got through an opaque method of a Map', `function m(v) { return 'fn:' + v[dec(0)]; } var mp = new Map(); mp.set('f', ${FN}); log(m(mp[dec(4)]('f')));`],
    ['pushed, then mapped', `function m(v) { return 'fn:' + v[dec(0)]; } var arr = []; arr.push(${FN}); log(arr.map(m)[0]);`],
  ];
  for (const [title, read] of shapes) {
    it(title, async () => {
      const result = await expectPreserved(`${DEC}\n${read}`);
      expect(result.renames).not.toContain('_0x96d6');
    });
  }
});
