import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/frontend/language.js';
import { inferNames } from '../src/naming/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

/**
 * V8 spells binding names into error text: `Cannot access 'before' before
 * initialization`, `_0x1a1a is not a function`. A program that reads
 * `e.message` off what it caught observes those spellings, and the failing
 * reference sits in the `try` the catch belongs to - or in a function it
 * calls. So every binding referenced there keeps its name, at every preset;
 * disclosing the drift is not enough, since a `JSON.parse` rule renamed the
 * read to `data` at balanced with nothing but a warning to say so.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print. The disclosure stays for what the
 * pin cannot reach - a failure two calls deep, a promise nobody here made -
 * and these tests hold aggressive to one warning there, and to silence
 * where there is nothing to disclose.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

const WARNING = /error text/;

/** What the program prints, so input and output can be compared as behaviour. */
async function observe(code: string): Promise<string[]> {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  // A rejection handler runs from the microtask queue, after the script.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return logs;
}

async function run(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, options);
  const warned = ctx.diagnostics.filter((note) => WARNING.test(note.message));
  return { code, renames: ctx.renames.map((entry) => entry.from), warned, printed: await observe(code) };
}

/**
 * Input and output print the same thing at every preset, and the bindings
 * named are never renamed; returns the aggressive result.
 */
async function expectPinned(source: string, expected: string[], pinned: string[]) {
  expect(await observe(source)).toEqual(expected);
  let last;
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(result.printed, options.preset).toEqual(expected);
    for (const name of pinned) expect(result.renames, `${options.preset} renamed ${name}`).not.toContain(name);
    last = result;
  }
  return last!;
}

describe('a binding referenced in a try whose catch reads the error text keeps its name', () => {
  it('a TDZ read spells the binding, at every preset', async () => {
    // Before the pin, aggressive printed `Cannot access 'str1' before initialization`.
    await expectPinned(
      `
        try { log(before); } catch (e) { log(e.message); }
        let before = 'b';
      `,
      ["Cannot access 'before' before initialization"],
      ['before'],
    );
  });

  it('a call of a non-function spells the callee', async () => {
    const result = await expectPinned(
      `
        var _0x1a1a = 1;
        try { _0x1a1a(); } catch (e) { log(e.message); }
      `,
      ['_0x1a1a is not a function'],
      ['_0x1a1a'],
    );
    // The catch parameter carries no such text and is still free to move.
    expect(result.code).toContain('catch (error)');
  });

  it('a rule with evidence is refused the same as the fallback: balanced named this `data`', async () => {
    await expectPinned(
      `
        try { log(_0x3ebf); } catch (e) { log(e.message); }
        let _0x3ebf = JSON.parse(JSON.stringify({ value: 1 }));
        log(typeof _0x3ebf);
      `,
      ["Cannot access '_0x3ebf' before initialization", 'object'],
      ['_0x3ebf'],
    );
  });

  it('a write before the declaration is a TDZ failure too', async () => {
    await expectPinned(
      `
        try { _0x5e5e = 1; } catch (e) { log(e.message); }
        let _0x5e5e = 2;
        try { [_0x6f6f] = [1]; } catch (e) { log(e.message); }
        let _0x6f6f = 3;
        try { _0x7a7a++; } catch (e) { log(e.message); }
        let _0x7a7a = 4;
        log(_0x5e5e, _0x6f6f, _0x7a7a);
      `,
      [
        "Cannot access '_0x5e5e' before initialization",
        "Cannot access '_0x6f6f' before initialization",
        "Cannot access '_0x7a7a' before initialization",
        '2 3 4',
      ],
      ['_0x5e5e', '_0x6f6f', '_0x7a7a'],
    );
  });

  it('follows a call one level into a function this file declares', async () => {
    await expectPinned(
      `
        function _0x2b2b() { return _0x1c1c; }
        var _0x3c3c = function () { return _0x4d4d(); };
        class _0x5e5e { constructor() { this.v = _0x6f6f; } }
        try { _0x2b2b(); } catch (e) { log(e.message); }
        try { _0x3c3c(); } catch (e) { log(e.message); }
        try { new _0x5e5e(); } catch (e) { log(e.message); }
        let _0x1c1c = 1;
        var _0x4d4d = 2;
        let _0x6f6f = 3;
        log(_0x2b2b(), _0x3c3c === undefined, new _0x5e5e().v);
      `,
      [
        "Cannot access '_0x1c1c' before initialization",
        '_0x4d4d is not a function',
        "Cannot access '_0x6f6f' before initialization",
        '1 false 3',
      ],
      ['_0x1c1c', '_0x4d4d', '_0x6f6f'],
    );
  });

  it('reads through every spelling of the text', async () => {
    const message = "Cannot access '_0x1a1a' before initialization";
    const coerced = `ReferenceError: ${message}`;
    const spellings: Array<[string, string]> = [
      ['log(e.stack.split("\\n")[0])', coerced],
      ['log(e.toString())', coerced],
      ['log(String(e))', coerced],
      ['log(`${e}`)', coerced],
      ["log(e + '')", coerced],
      ["log('' + e)", coerced],
      ['var err = e; log(err.message)', message],
      // Before: the parameter taken apart in the body was not read at all,
      // and aggressive printed `Cannot access 'num1' before initialization`.
      ['const { message } = e; log(message)', message],
      ['const { stack: s } = e; log(s.split("\\n")[0])', coerced],
    ];
    for (const [read, expected] of spellings) {
      await expectPinned(
        `
          try { log(_0x1a1a); } catch (e) { ${read}; }
          let _0x1a1a = 'b';
        `,
        [expected],
        ['_0x1a1a'],
      );
    }
  });

  it('reads through a pattern assigned in the body, and a chain of aliases', async () => {
    // Before: one alias was followed, and `({ message: m } = e)` was not a
    // read at all; each of these printed `Cannot access 'str1' before
    // initialization` at aggressive with no warning.
    const message = "Cannot access '_0x1a1a' before initialization";
    const coerced = `ReferenceError: ${message}`;
    const spellings: Array<[string, string]> = [
      ['let m; ({ message: m } = e); log(m)', message],
      ['var a = e; var b = a; log(b.message)', message],
      ['const err = e; const { message } = err; log(message)', message],
      ['var a = e; var b = a; var c = b; log(c.message)', message],
      ['var a = e; let m; ({ message: m } = a); log(m)', message],
      ['var a; a = e; log(a.message)', message],
      ['var a = e; var b = a; log(`${b}`)', coerced],
      ['var a = e; var b = a; log(String(b))', coerced],
      ['var a = e; var b = a; a = b; log(b.message)', message],
      ['var a = e || null; var b = a; log(b.message)', message],
      ['var a = e; var b = a; log(b.stack.split("\\n")[0])', coerced],
      ['let m; ({ err: { message: m } } = { err: e }); log(m)', message],
      ['var o = { err: e }; log(o.err.message)', message],
    ];
    for (const [read, expected] of spellings) {
      await expectPinned(
        `
          try { log(_0x1a1a); } catch (e) { ${read}; }
          let _0x1a1a = 'b';
        `,
        [expected],
        ['_0x1a1a'],
      );
    }
    await expectPinned(
      `
        new Promise((r) => r(_0x3c3c)).catch((e) => { var a = e; var b = a; log(b.message); });
        let _0x3c3c = 2;
      `,
      ["Cannot access '_0x3c3c' before initialization"],
      ['_0x3c3c'],
    );
  });

  it('reads through a destructured parameter, and a key nothing resolves', async () => {
    await expectPinned(
      `
        var tbl = ['message'];
        function get(i) { return tbl[i]; }
        var keep = tbl;
        try { log(_0x1a1a); } catch ({ message }) { log(message); }
        try { log(_0x2b2b); } catch (e) { log(e[get(0)]); }
        let _0x1a1a = 1, _0x2b2b = 2;
        log(keep.length);
      `,
      [
        "Cannot access '_0x1a1a' before initialization",
        "Cannot access '_0x2b2b' before initialization",
        '1',
      ],
      ['_0x1a1a', '_0x2b2b'],
    );
  });

  it('a rejection handler pins the chain it catches from', async () => {
    await expectPinned(
      `
        async function _0x2b2b() { return _0x1c1c; }
        new Promise((resolve) => resolve(_0x3c3c)).catch((e) => log(e.message));
        Promise.resolve().then(() => _0x4d4d()).catch((e) => log(e.message));
        _0x2b2b().then(null, (e) => log(e.message));
        let _0x1c1c = 1, _0x3c3c = 2;
        var _0x4d4d = 3;
      `,
      [
        "Cannot access '_0x3c3c' before initialization",
        "Cannot access '_0x1c1c' before initialization",
        '_0x4d4d is not a function',
      ],
      ['_0x1c1c', '_0x3c3c', '_0x4d4d'],
    );
  });

  it('a catch that reads no text pins nothing', async () => {
    const source = `
      var _0x1a1a = 1;
      try { _0x1a1a(); } catch (e) { log(e.name); }
      try { log(_0x2b2b); } catch (e) { log('caught'); }
      let _0x2b2b = 2;
    `;
    for (const options of PRESETS) {
      const result = await run(source, options);
      expect(result.printed, options.preset).toEqual(['TypeError', 'caught']);
    }
    const aggressive = await run(source, { preset: 'aggressive' });
    expect(aggressive.renames).toContain('_0x1a1a');
    expect(aggressive.renames).toContain('_0x2b2b');
  });
});

// A TDZ read a `JSON.parse` rule has evidence to name `data` at balanced;
// the `typeof` read is what gives the rule its evidence.
const TDZ = `let _0x3ebf = JSON.parse('{"a":1}'); log(typeof _0x3ebf);`;
const MESSAGE = ["Cannot access '_0x3ebf' before initialization", 'object'];

describe('the pin follows calls transitively', () => {
  // Before, one level of calls was followed and the read below it printed
  // `Cannot access 'data' before initialization` at balanced with no word
  // said: the failure sat in a function the guarded code's callee called.

  it('a failure two calls deep, and four', async () => {
    await expectPinned(
      `
        function _0xa() { return _0x3ebf; }
        function _0xb() { return _0xa(); }
        try { _0xb(); } catch (e) { log(e.message); }
        ${TDZ}
      `,
      MESSAGE,
      ['_0x3ebf'],
    );
    await expectPinned(
      `
        function _0xa() { return _0x3ebf; }
        function _0xb() { return _0xa(); }
        function _0xc() { return _0xb(); }
        function _0xd() { return _0xc(); }
        try { _0xd(); } catch (e) { log(e.message); }
        ${TDZ}
      `,
      MESSAGE,
      ['_0x3ebf'],
    );
  });

  it('through a method of a local literal, an assigned method, a class method, a held function', async () => {
    for (const shape of [
      `var o = { m() { return _0x3ebf; } }; try { o.m(); } catch (e) { log(e.message); }`,
      `var o = {}; o.m = function () { return _0x3ebf; }; try { o.m(); } catch (e) { log(e.message); }`,
      `class _0xK { m() { return _0x3ebf; } } try { new _0xK().m(); } catch (e) { log(e.message); }`,
      `class _0xK { static m() { return _0x3ebf; } } try { _0xK.m(); } catch (e) { log(e.message); }`,
      `function _0xa() { return _0x3ebf; } try { [1].map(_0xa); } catch (e) { log(e.message); }`,
      `var f = function () { return 1; }; f = function () { return _0x3ebf; }; try { f(); } catch (e) { log(e.message); }`,
    ]) {
      await expectPinned(`${shape}\n${TDZ}`, MESSAGE, ['_0x3ebf']);
    }
  });

  it('through a block-level function in sloppy code, called past its block by its var name', async () => {
    // No scope table binds the call; the function it runs is the one
    // declared under that name in the same var scope.
    await expectPinned(
      `
        for (var i = 0; i < 1; i++) { function _0x2b2b() { return _0x1c1c; } }
        try { _0x2b2b(); } catch (e) { log(e.message); }
        let _0x1c1c = 1;
      `,
      ["Cannot access '_0x1c1c' before initialization"],
      ['_0x1c1c'],
    );
    await expectPinned(
      `
        var n = 0;
        try { _0x2b2b(); } catch (e) { log(e.message); }
        while (n++ < 1) { function _0x2b2b() { return _0x1c1c; } }
        try { _0x2b2b(); } catch (e) { log(e.message); }
        let _0x1c1c = 1;
      `,
      ['_0x2b2b is not a function', "Cannot access '_0x1c1c' before initialization"],
      ['_0x1c1c', '_0x2b2b'],
    );
  });

  it('a rejection handler pins the chain two calls deep', async () => {
    await expectPinned(
      `
        function _0xa() { return _0x3c3c; }
        function _0xb() { return _0xa(); }
        new Promise((r) => r(_0xb())).catch((e) => log(e.message));
        let _0x3c3c = 2;
      `,
      ["Cannot access '_0x3c3c' before initialization"],
      ['_0x3c3c'],
    );
  });
});

describe('the disclosure stays for what the pin cannot reach', () => {
  it('a failure past the bound is disclosed at balanced too', async () => {
    const source = `
      function _0xa() { return _0x3ebf; }
      function _0xb() { return _0xa(); }
      function _0xc() { return _0xb(); }
      function _0xd() { return _0xc(); }
      function _0xe() { return _0xd(); }
      try { _0xe(); } catch (e) { log(e.message); }
      ${TDZ}
    `;
    expect(await observe(source)).toEqual(MESSAGE);
    for (const options of [{ preset: 'balanced' }, { preset: 'aggressive' }] as const) {
      const result = await run(source, options);
      // The drift is real and this is what it looks like: same shape, new name.
      expect(result.printed, options.preset).toHaveLength(2);
      expect(result.printed[0], options.preset).toMatch(/^Cannot access '\w+' before initialization$/);
      expect(result.printed[0], options.preset).not.toContain("'_0x3ebf'");
      expect(result.warned, options.preset).toHaveLength(1);
      expect(result.warned[0]!.severity, options.preset).toBe('warning');
    }
    // Conservative renames nothing here, and discloses nothing.
    const conservative = await run(source, { preset: 'conservative' });
    expect(conservative.printed).toEqual(MESSAGE);
    expect(conservative.warned).toEqual([]);
  });

  it('a call the walk cannot resolve is disclosed at balanced too', async () => {
    // `cb` is a parameter, and `_0xrun` is let go of - an element of an
    // array stored where no local holds it - so its callers are out of
    // sight and what `cb` runs is not the walk's to say.
    const source = `
      function _0xrun(cb) { return cb(); }
      globalThis.held = [_0xrun];
      try { _0xrun(function () { return _0x3ebf; }); log(_0x9f9f()); } catch (e) { log(e.message); }
      function _0x9f9f() { return _0x3ebf; }
      ${TDZ}
    `;
    expect(await observe(source)).toEqual(MESSAGE);
    for (const options of [{ preset: 'balanced' }, { preset: 'aggressive' }] as const) {
      const result = await run(source, options);
      // The function handed in is held by the guarded code and is pinned
      // through it, so nothing drifts; the call of `cb` is still one the
      // walk did not follow, and it is said so.
      expect(result.printed, options.preset).toEqual(MESSAGE);
      expect(result.warned, options.preset).toHaveLength(1);
    }
  });

  it('is one warning however many reads there are', async () => {
    const source = `
      function _0x1a1a() { return _0x2b2b(); }
      function _0x2b2b() { return _0x3c3c; }
      try { _0x1a1a(); } catch (e) { log(e.message); log(e.stack.length > 0); }
      try { _0x1a1a(); } catch ({ message, stack }) { log(message); }
      Promise.reject(1).catch((err) => log(err.message));
      let _0x3c3c = 1;
    `;
    const aggressive = await run(source, { preset: 'aggressive' });
    expect(aggressive.renames.length).toBeGreaterThan(0);
    expect(aggressive.warned).toHaveLength(1);
  });

  it('a promise this file did not make is read where it cannot follow', async () => {
    for (const source of [
      `var _0x1a1a = 1; promise.catch(function (e) { return e.message; }); log(typeof _0x1a1a);`,
      `var _0x1a1a = 1; promise.then(null, (e) => e.stack); log(typeof _0x1a1a);`,
    ]) {
      const { ctx } = await runPass(pass, source, { preset: 'aggressive' });
      expect(ctx.renames.map((entry) => entry.from), source).toContain('_0x1a1a');
      expect(ctx.diagnostics.filter((note) => WARNING.test(note.message)), source).toHaveLength(1);
    }
  });
});

describe('the disclosure stays quiet when it has nothing to disclose', () => {
  it('a caught error that is not read', async () => {
    const source = `
      var _0x1a1a = 1;
      try { _0x1a1a(); } catch (e) { log('caught'); }
    `;
    for (const options of PRESETS) {
      const result = await run(source, options);
      expect(result.printed, options.preset).toEqual(['caught']);
      expect(result.warned, options.preset).toEqual([]);
    }
  });

  it('.message read on something that is not a caught error', async () => {
    const source = `
      var _0x1a1a = { message: 'm' };
      log(_0x1a1a.message);
    `;
    for (const options of PRESETS) {
      const result = await run(source, options);
      expect(result.printed, options.preset).toEqual(['m']);
      expect(result.warned, options.preset).toEqual([]);
    }
  });

  it('a read with nothing renamed', async () => {
    const source = `
      try { null.x; } catch (error) { log(error.message.length > 0); }
    `;
    for (const options of PRESETS) {
      const result = await run(source, options);
      expect(result.renames, options.preset).toEqual([]);
      expect(result.warned, options.preset).toEqual([]);
    }
  });
});

describe('the error handed on: to a helper, a holder, an array, a chain past the bound', () => {
  const message = "Cannot access '_0x1a1a' before initialization";
  const coerced = `ReferenceError: ${message}`;

  it('a helper reads the text off its parameter', async () => {
    // Before: the read sat in the helper, and the catch itself read
    // nothing, so nothing was pinned and aggressive printed `Cannot
    // access 'str1' before initialization`.
    const helpers: Array<[string, string, string]> = [
      [`function show(err) { log(err.message); }`, `show(e)`, message],
      [`function fmt(err) { var x = err; return x.message; }`, `log(fmt(e))`, message],
      [`function show(err) { var x; x = err; log(x.message); }`, `show(e)`, message],
      [`function show(err) { log(err.message); }`, `show((0, e))`, message],
      [`function show(err) { log(err.message); } var c = true;`, `show(c ? e : null)`, message],
      [`function show({ message }) { log(message); }`, `show(e)`, message],
      [`function show(err) { log(err.message); }`, `[e].forEach(show)`, message],
      [`function show(err) { log(err.message); }`, `show.call(null, e)`, message],
      [`function show(err) { log(err.message); }`, `show.apply(null, [e])`, message],
      [`function show(err) { log(err.message); }`, `show.bind(null, e)()`, message],
      [`function R() {} R.prototype.show = function (err) { log(err.message); };`, `new R().show(e)`, message],
      [`class R { show(err) { log(err.message); } }`, `new R().show(e)`, message],
      [`function show(err, n) { if (n) return show(err, n - 1); log(err.message); }`, `show(e, 2)`, message],
      [`function fmt(err) { return String(err); }`, `log(fmt(e))`, coerced],
      [`function fmt(err) { return \`\${err}\`; }`, `log(fmt(e))`, coerced],
      [`function show(err) { var a = err; var b = a; log(b.message); }`, `show(e)`, message],
      [`const show = (err) => log(err.message);`, `show(e)`, message],
      [`var ui = { show(err) { log(err.message); } };`, `ui.show(e)`, message],
      [`function show(box) { log(box.err.message); }`, `show({ err: e })`, message],
      [`async function show(err) { log((await err).message); }`, `show(e)`, message],
    ];
    for (const [helper, use, expected] of helpers) {
      await expectPinned(
        `
          ${helper}
          try { log(_0x1a1a); } catch (e) { ${use}; }
          let _0x1a1a = 'b';
        `,
        [expected],
        ['_0x1a1a'],
      );
    }
  });

  it('held in an array or a local and read later, or taken by a pattern', async () => {
    for (const shape of [
      `var errors = []; try { log(_0x1a1a); } catch (e) { errors.push(e); } errors.forEach(function (x) { log(x.message); });`,
      `var errors = []; try { log(_0x1a1a); } catch (e) { errors.push(e); } log(errors[0].message);`,
      `var errors = []; try { log(_0x1a1a); } catch (e) { errors.push(e); } log(errors.map((x) => x.message)[0]);`,
      `var errors = []; try { log(_0x1a1a); } catch (e) { errors.push(e); } for (const x of errors) log(x.message);`,
      `var last; function keep(err) { last = err; } try { log(_0x1a1a); } catch (e) { keep(e); } log(last.message);`,
      `try { log(_0x1a1a); } catch (e) { const [err] = [e]; log(err.message); }`,
      `try { log(_0x1a1a); } catch (e) { const { 0: err } = [e]; log(err.message); }`,
      `try { log(_0x1a1a); } catch (e) { const [, err] = [null, e]; log(err.message); }`,
    ]) {
      await expectPinned(`${shape}\nlet _0x1a1a = 'b';`, [message], ['_0x1a1a']);
    }
  });

  it('a rejection handler spelled by name', async () => {
    await expectPinned(
      `
        function show(err) { log(err.message); }
        new Promise((r) => r(_0x1a1a)).catch(show);
        let _0x1a1a = 'b';
      `,
      [message],
      ['_0x1a1a'],
    );
  });

  it('a chain of aliases past the bound is taken to read the text', async () => {
    // Four aliases are followed; a fifth and a sixth would be a read the
    // walk never saw, and it is taken as one rather than left silent.
    for (const chain of [
      `var a = e; var b = a; var c = b; var d = c; var f = d; log(f.message);`,
      `var a = e; var b = a; var c = b; var d = c; var f = d; var g = f; log(g.message);`,
    ]) {
      await expectPinned(`try { log(_0x1a1a); } catch (e) { ${chain} }\nlet _0x1a1a = 'b';`, [message], ['_0x1a1a']);
    }
  });
});

describe('the guarded code runs an accessor, a constructor, a method by another spelling', () => {
  it('a getter or setter, read or written any way', async () => {
    // Before: `o.x` with a getter that reads the TDZ binding printed
    // `Cannot access 'data' before initialization` at balanced, with no
    // word said; a pattern and an assignment ran the accessor with no
    // member spelled at all.
    for (const shape of [
      `var o = { get x() { return _0x3ebf; } }; try { o.x; } catch (e) { log(e.message); }`,
      `function report(err) { log(err.message); } var o = { get x() { return _0x3ebf; } }; try { o.x; } catch (e) { report(e); }`,
      `var o = { get x() { return _0x3ebf; } }; try { const { x } = o; } catch (e) { log(e.message); }`,
      `var o = { set x(v) { _0x3ebf = v; } }; try { o.x = 1; } catch (e) { log(e.message); }`,
      `class C { get x() { return _0x3ebf; } } try { new C().x; } catch (e) { log(e.message); }`,
      `class C { get x() { return _0x3ebf; } } var c = new C(); var d = c; try { d.x; } catch (e) { log(e.message); }`,
      `class C { static get x() { return _0x3ebf; } } try { C.x; } catch (e) { log(e.message); }`,
    ]) {
      await expectPinned(`${shape}\n${TDZ}`, MESSAGE, ['_0x3ebf']);
    }
  });

  it('a constructor, an ES5 method, a method by call or by string key, a callback', async () => {
    for (const shape of [
      `class C { constructor() { this.v = _0x3ebf; } } try { new C(); } catch (e) { log(e.message); }`,
      `function C() { this.v = _0x3ebf; } try { new C(); } catch (e) { log(e.message); }`,
      `function C() {} C.prototype.m = function () { return _0x3ebf; }; try { new C().m(); } catch (e) { log(e.message); }`,
      `function C() {} C.prototype.m = function () { return _0x3ebf; }; var c = new C(); try { c.m(); } catch (e) { log(e.message); }`,
      `function report(err) { log(err.message); } function C() {} C.prototype.m = function () { return _0x3ebf; }; try { new C().m(); } catch (e) { report(e); }`,
      `function report(err) { log(err.message); } var o = { m() { return _0x3ebf; } }; try { o.m(); } catch (e) { report(e); }`,
      `class C { m() { return _0x3ebf; } } var c = new C(); try { c.m(); } catch (e) { log(e.message); }`,
      `var o = { m() { return _0x3ebf; } }; try { o.m.call(o); } catch (e) { log(e.message); }`,
      `var o = { m() { return _0x3ebf; } }; try { o['m'](); } catch (e) { log(e.message); }`,
      `try { [1].forEach(function () { return _0x3ebf; }); } catch (e) { log(e.message); }`,
    ]) {
      await expectPinned(`${shape}\n${TDZ}`, MESSAGE, ['_0x3ebf']);
    }
  });
});

describe('the error stored into a local holder', () => {
  const REGISTER = `var R = []; function f(k) { try { log(_0x3ebf); } catch (e) { R[k] = e; } } f(0);`;

  /** The program path of a fresh parse, for `inferNames` asked directly with the assumption off. */
  function programPathOf(source: string): NodePath<t.Program> {
    let program: NodePath<t.Program> | null = null;
    traverse(parseSource(source, {}).ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    return program as unknown as NodePath<t.Program>;
  }

  it('stored under a key nothing resolves and read back under another: the assumption, disclosed', async () => {
    // obfuscated5.js: the VM's `catch (Wo) { WR[We] = Wo ... }` stores the
    // error into its register file, read everywhere as `WR[k]`. Two keys
    // nothing resolves, compounded, are taken not to meet at balanced and
    // aggressive, and the walk says so once; before, every name the
    // dispatch loop referenced was pinned. With the assumption off the
    // elements are followed, and the coercion pins.
    for (const read of [
      `var j = 0; log(typeof R[j], R[j] + '');`,
      `var j = 0; log(R[j].message);`,
      `var j = 0; log(R[j][globalThis.K || 'message']);`,
    ]) {
      const source = `${REGISTER} ${read} ${TDZ}`;
      for (const options of PRESETS) {
        const result = await run(source, options);
        if (options.preset === 'conservative') continue;
        expect(result.renames, options.preset).toContain('_0x3ebf');
        expect(result.warned, `${options.preset} warned`).toHaveLength(1);
      }
      const pinned = inferNames(programPathOf(source), { assumeHostProperties: false });
      expect(pinned.renames.map((entry) => entry.from), read).not.toContain('_0x3ebf');
      const assumed = inferNames(programPathOf(source), { assumeHostProperties: true });
      expect(assumed.renames.map((entry) => entry.from), read).toContain('_0x3ebf');
      expect(assumed.errorTextUnfollowed, read).toBe(true);
    }
  });

  it('read back under a key spelled out, or by an element method: followed, and pinned at every preset', async () => {
    for (const read of [
      `log(R[0].message);`,
      `log(String(R[0]).slice(0, 14));`,
      `log(R.find(Boolean).message);`,
      `log(R.at(-1).message);`,
      `for (const x of R) log(x.message);`,
      `R.forEach(function (x) { log(x.message); });`,
      `var [x] = R; log(x.message);`,
    ]) {
      const expected = read.startsWith('log(String') ? ['ReferenceError', 'object'] : MESSAGE;
      await expectPinned(`${REGISTER} ${read} ${TDZ}`, expected, ['_0x3ebf']);
    }
  });

  it('the error itself taken out of the holder by a key spelled out and handed on is read', async () => {
    // `R[0]` spelled out and handed to a callee resolved through a logical: read as the error, pinned.
    await expectPinned(`${REGISTER} var cb = globalThis.CB || function (x) { log(x.message); }; cb(R[0]); ${TDZ}`, MESSAGE, ['_0x3ebf']);
  });

  it('a store alone, a rethrow alone: renamed, nothing said', async () => {
    for (const source of [
      `${REGISTER} log(typeof R[0]); ${TDZ}`,
      `function g() { try { log(_0x3ebf); } catch (e) { throw e; } } try { g(); } catch (x) { log('outer'); } ${TDZ}`,
    ]) {
      const expected = source.startsWith('function g') ? ['outer', 'object'] : ['object', 'object'];
      expect(await observe(source)).toEqual(expected);
      for (const options of PRESETS) {
        const result = await run(source, options);
        expect(result.printed, options.preset).toEqual(expected);
        expect(result.warned, `${options.preset} warned`).toHaveLength(0);
        if (options.preset !== 'conservative') expect(result.renames, options.preset).toContain('_0x3ebf');
      }
    }
  });
});

describe('an implicit reader written onto a local after the fact', () => {
  it('toJSON stored by a member write, Object.assign, defineProperty; the holder nested, listed, frozen', async () => {
    // obfuscator.io's transformObjectKeys spells `{ toJSON() {...} }` as `h.toJSON = ...`;
    // `JSON.stringify(o)` runs it, and its TDZ read spelled `data` at balanced with no word said.
    const TO_JSON = `function () { return _0x3ebf; }`;
    for (const holder of [
      `var h = {}; h.toJSON = ${TO_JSON}; var o = h;`,
      `var h = {}; h['toJSON'] = ${TO_JSON}; var o = h;`,
      `var h = {}; var f = ${TO_JSON}; h.toJSON = f; var o = h;`,
      `var h = {}; Object.assign(h, { toJSON: ${TO_JSON} }); var o = h;`,
      `var h = {}; var toJSON = ${TO_JSON}; Object.assign(h, { toJSON }); var o = h;`,
      `var h = {}; Object.defineProperty(h, 'toJSON', { value: ${TO_JSON} }); var o = h;`,
      `var h = { toJSON: null }; h.toJSON = ${TO_JSON}; var o = h;`,
      `var h = {}; h.toJSON = ${TO_JSON}; var o = { inner: h };`,
      `var h = {}; h.toJSON = ${TO_JSON}; var o = [h];`,
      `var h = {}; h.toJSON = ${TO_JSON}; var o = Object.freeze(h);`,
    ]) {
      for (const use of [
        `try { JSON.stringify(o); } catch (e) { log(e.message); }`,
        `try { JSON.stringify({ o }); } catch (e) { log(e.message); }`,
        `function show(e) { log(e.message); } try { JSON.stringify(o); } catch (e) { show(e); }`,
      ]) {
        await expectPinned(`${holder} ${use} ${TDZ}`, MESSAGE, ['_0x3ebf']);
      }
    }
  });
});
