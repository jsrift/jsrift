import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A `.name` read one step past where the walk used to stop.
 *
 * Three families, each of which printed a typed fallback for a `_0x` function
 * at aggressive with no warning:
 *
 *  - a call whose callee is spelled as a literal - `(function () { return
 *    function _0x96d6() {} })().name`, which is what the proxy inliner leaves
 *    of `o.m(function () { return function _0x96d6() {} })` - or through a
 *    wrapper a value passes unchanged (`(0, f)()`, `(c ? f : g)()`), or whose
 *    result is held by a binding or iterated (`var w = pick()`, `for (const v
 *    of pick())`, a generator's yields); and a read through the global
 *    object, `globalThis.h.name` with `globalThis.h = ...` stored anywhere in
 *    the file, by that spelling or `this.h` at the top of a script or in a
 *    sloppy IIFE, or `d.h` with `d` an alias of the window - and a call
 *    through those same spellings, `g._0xf(fn)`, of a program-scope function
 *    whose reference list does not show it;
 *  - the rows of a list: `for (const row of vs) log(row[0].name)`, `row.k`,
 *    `const [v] = row`, a nested `for-of`, a rest parameter's rows, and the
 *    same off a plain local, where the walk opened one level of elements and
 *    stopped at the next;
 *  - what the walk still does not follow, disclosed: the result of a call on
 *    a value of this file's (`fn.bind(x).name`, `o.get().name`,
 *    `arr.pop().name`, a reassigned local called), a property of any call's
 *    result (`make().fn.name`, `pick()[0].name`, `const { k } = make()`),
 *    and code compiled from a string that can spell `name`.
 *    `naming-reflection-members` pins that those are not followed; this
 *    holds aggressive to one warning there and to silence where nothing was
 *    renamed that a read could see.
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

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

async function run(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, options);
  const warned = ctx.diagnostics.filter((note) => WARNING.test(note.message)).length;
  return { code, renames: ctx.renames.map((entry) => entry.from), warned, printed: observe(code) };
}

/** Input and output print the same thing at every preset, with no warning; returns the aggressive output. */
async function expectPreserved(source: string, expected: string[]): Promise<string> {
  expect(observe(source)).toEqual(expected);
  let aggressive = '';
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(result.printed, options.preset).toEqual(expected);
    expect(result.warned, `${options.preset} warned`).toBe(0);
    if (options.preset === 'aggressive') aggressive = result.code;
  }
  return aggressive;
}

/**
 * Balanced and conservative print what the input prints with no warning;
 * aggressive renames the named function, drifts, and warns exactly once.
 */
async function expectDisclosed(source: string, expected: string[], renamed: string): Promise<void> {
  expect(observe(source)).toEqual(expected);
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

const BOTH = ['_0xffff', '_0x1111'];
const ROWS = `[[function _0xffff() {}], [class _0x1111 {}]]`;

describe('a .name read off the result of a call whose callee is a literal', () => {
  it('a function expression called in place', async () => {
    // Before: aggressive printed `val1`.
    const code = await expectPreserved(`log((function () { return function _0x96d6() {}; })().name);`, ['_0x96d6']);
    expect(code).toContain('function _0x96d6');
  });

  it('an arrow called in place', async () => {
    const code = await expectPreserved(`log((() => function _0x96d6() {})().name);`, ['_0x96d6']);
    expect(code).toContain('function _0x96d6');
  });

  it('the inliner’s shape: a returned function read through a parameter call', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v().name; };
        log(o.m(function () { return function _0x96d6() {}; }));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });
});

describe('a .name read off the result of a call, whatever the callee’s spelling', () => {
  it('a literal behind a comma, which is how a method is called with its receiver dropped', async () => {
    // Before: aggressive printed `val1` with no warning; the callee was
    // read as a sequence expression and matched nothing.
    const code = await expectPreserved(`log((0, function () { return function _0x96d6() {}; })().name);`, ['_0x96d6']);
    expect(code).toContain('function _0x96d6');
  });

  it('a choice between two fixed functions', async () => {
    const code = await expectPreserved(
      `
        var _0xp = function () { return function _0x96d6() {}; };
        var _0xq = function () { return class _0x1111 {}; };
        log((Math.random() < 2 ? _0xp : _0xq)().name, (null || _0xq)().name);
      `,
      ['_0x96d6 _0x1111'],
    );
    expect(code).toContain('function _0x96d6');
    expect(code).toContain('class _0x1111');
  });

  it('a literal called through .call is a member callee, and is disclosed', async () => {
    await expectDisclosed(
      `log((function () { return function _0x96d6() {}; }).call(null).name);`,
      ['_0x96d6'],
      '_0x96d6',
    );
  });
});

describe('a call result held by a binding, or iterated', () => {
  it('held by a variable', async () => {
    // Before: aggressive printed `val1` with no warning; the walk from `w`
    // met a call as its source and read nothing off it.
    const code = await expectPreserved(
      `
        var _0xp = function () { return function _0x96d6() {}; };
        var w = _0xp();
        log(w.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('iterated by a for-of, from a fixed function and from a literal', async () => {
    const code = await expectPreserved(
      `
        var _0xp = function () { return [function _0x96d6() {}]; };
        for (const v of _0xp()) log(v.name);
        for (const v of (function () { return [class _0x1111 {}]; })()) log(v.name);
      `,
      ['_0x96d6', '_0x1111'],
    );
    expect(code).toContain('function _0x96d6');
    expect(code).toContain('class _0x1111');
  });

  it('what a generator yields, one element per yield and the elements of a delegate', async () => {
    const code = await expectPreserved(
      `
        function* _0xgen() { yield function _0x96d6() {}; yield* [class _0x1111 {}]; }
        for (const v of _0xgen()) log(v.name);
      `,
      ['_0x96d6', '_0x1111'],
    );
    expect(code).toContain('function _0x96d6');
    expect(code).toContain('class _0x1111');
  });

  it('a generator’s own .name is the iterator’s, which is nothing of ours', async () => {
    const code = await expectPreserved(
      `
        function* _0xgen() { yield function _0x96d6() {}; }
        log(typeof _0xgen().name);
      `,
      ['undefined'],
    );
    expect(code).not.toContain('_0x96d6');
  });

  it('what a method of a local object returns, held by a variable or iterated, is disclosed', async () => {
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var o = { get() { return _0xh; } };
          var w = o.get();
          log(w.name);
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var o = { get() { return [_0xh]; } };
          for (const v of o.get()) log(v.name);
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });
});

describe('a program-scope function called through the global object', () => {
  // `_0x1a2b3c` has no reference: the call reaches it by its spelling, as a
  // property of the global object, and `holdersOf` cannot enumerate the
  // callers of a function reached that way. Each shape printed `fn:val1`
  // at aggressive with no warning, the function having been read as one
  // with no callers at all.
  const READER = `function _0x1a2b3c(v) { return 'fn:' + v.name; }`;

  it('through an alias of the global object, declared before or after the call', async () => {
    let code = await expectPreserved(
      `
        ${READER}
        var g = globalThis;
        log(g._0x1a2b3c(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
    code = await expectPreserved(
      `
        ${READER}
        function _0xs() { return g._0x1a2b3c(function _0x96d6() {}); }
        var g = globalThis;
        log(_0xs());
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('through the window parameter of a wrapping IIFE', async () => {
    const code = await expectPreserved(
      `
        ${READER}
        !function (d) { log(d._0x1a2b3c(function _0x96d6() {})); }(globalThis);
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('through this at the top of a script, and in a sloppy IIFE', async () => {
    let code = await expectPreserved(
      `
        ${READER}
        log(this._0x1a2b3c(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
    code = await expectPreserved(
      `
        ${READER}
        (function () { log(this._0x1a2b3c(function _0x96d6() {})); })();
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });
});

describe('a .name read through the global object', () => {
  it('stored as globalThis.h, read as globalThis.h', async () => {
    // Before: aggressive printed `val1`; the store was recorded, the read never asked for it.
    const code = await expectPreserved(
      `
        globalThis.h = function _0x96d6() {};
        log(globalThis.h.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('stored as a bare free name, read through globalThis', async () => {
    const code = await expectPreserved(
      `
        h = function _0x96d6() {};
        log(globalThis.h.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('the read may come before the store', async () => {
    const code = await expectPreserved(
      `
        function later() { return globalThis.h.name; }
        globalThis.h = function _0x96d6() {};
        log(later());
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('stored on this at the top of a script, read both ways', async () => {
    const code = await expectPreserved(
      `
        this.h = function _0x96d6() {};
        log(this.h.name, h.name);
      `,
      ['_0x96d6 _0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('stored on this inside a sloppy IIFE, which a plain call binds to the global object', async () => {
    const code = await expectPreserved(
      `
        (function () { this.h = function _0x96d6() {}; })();
        log(globalThis.h.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('read off this inside a sloppy IIFE', async () => {
    const code = await expectPreserved(
      `
        globalThis.h = function _0x96d6() {};
        (function () { log(this.h.name); })();
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('a strict IIFE’s this is undefined, and stores nothing', async () => {
    const source = `
      'use strict';
      var _0x96d6 = function () {};
      (function () { try { this.h = 1; } catch (e) { log(typeof _0x96d6); } })();
    `;
    const code = await expectPreserved(source, ['function']);
    expect(code).not.toContain('_0x96d6');
  });

  it('read off this in a method of an object literal, which is the literal', async () => {
    const code = await expectPreserved(
      `
        var _0xo = { h: function _0x96d6() {}, m() { return this.h.name; } };
        log(_0xo.m());
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('stored through the window parameter of a wrapping IIFE', async () => {
    const code = await expectPreserved(
      `
        !function (d) { d.h = function _0x96d6() {}; }(globalThis);
        log(globalThis.h.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('stored through an alias declared after the store', async () => {
    const code = await expectPreserved(
      `
        function _0xs() { g.h = function _0x96d6() {}; }
        var g = globalThis;
        _0xs();
        log(globalThis.h.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('follows a chain of members below the global object', async () => {
    const code = await expectPreserved(
      `
        globalThis.reg = { fn: function _0x96d6() {} };
        log(globalThis.reg.fn.name);
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('the inliner’s shape: a parameter handed globalThis.h', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v.name; };
        globalThis.h = function _0x96d6() {};
        log(o.m(globalThis.h));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('a key nothing resolves under a key that may itself be name selects nothing', async () => {
    // obfuscator.io reads every host global as `window[k1][k2]` before its
    // strings are decoded; the two unknowns compounded would freeze every
    // top-level binding, and the fixture test on obfuscated2.js expects the
    // string array function to be named.
    const source = `
      function _0x4a68() { return ['a']; }
      var k = ['x', 'y'][0];
      var j = ['n', 'ame'].join('');
      log(typeof globalThis[k] === 'undefined' ? 'no' : globalThis[k][j], _0x4a68().length);
    `;
    const code = await expectPreserved(source, ['no 1']);
    expect(code).not.toContain('_0x4a68');
  });
});

describe('a .name read on the rows of a list', () => {
  it('an index off a loop variable of an array parameter', async () => {
    // Before: aggressive printed `val1` twice.
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const row of vs) log(row[0].name); }
        _0xf(${ROWS});
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a key off a loop variable of an array parameter', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const row of vs) log(row.k.name); }
        _0xf([{ k: function _0xffff() {} }, { k: class _0x1111 {} }]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a loop variable taken apart by a pattern', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const row of vs) { const [v] = row; log(v.name); } }
        _0xf(${ROWS});
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a nested for-of over an array parameter', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const row of vs) for (const v of row) log(v.name); }
        _0xf(${ROWS});
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('the rows of a rest parameter', async () => {
    const code = await expectPreserved(
      `
        function _0xf(...rows) { for (const row of rows) for (const v of row) log(v.name); }
        _0xf([function _0xffff() {}], [class _0x1111 {}]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('an argument spread into the parameter', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const row of vs) for (const v of row) log(v.name); }
        var rows = ${ROWS};
        _0xf([...rows]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a nested for-of over a plain local', async () => {
    const code = await expectPreserved(
      `
        var vs = ${ROWS};
        for (const row of vs) for (const v of row) log(v.name);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('an index off the loop variable of a plain local, and of a spread copy', async () => {
    const code = await expectPreserved(
      `
        var rows = ${ROWS};
        var vs = [...rows];
        for (const row of rows) log(row[0].name);
        for (const row of vs) log(row[0].name);
      `,
      [...BOTH, ...BOTH],
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a pattern in the head of the loop', async () => {
    const code = await expectPreserved(
      `
        function _0xffff() {} class _0x1111 {}
        var vs = ${ROWS};
        for (const [v] of vs) log(v.name);
        var w;
        for ([w] of vs) log(w.name);
        for (const { k } of [{ k: _0xffff }, { k: _0x1111 }]) log(k.name);
      `,
      [...BOTH, ...BOTH, ...BOTH],
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a loop variable assigned by the loop rather than declared in it', async () => {
    const code = await expectPreserved(
      `
        var vs = ${ROWS};
        var row;
        for (row of vs) log(row[0].name);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a row picked out by a pattern declarator, then indexed', async () => {
    // Before: `const [row] = vs` read `row` as `vs`, and `row[0]` found the row.
    const code = await expectPreserved(
      `
        var vs = [[function _0xffff() {}]];
        const [row] = vs;
        var other;
        [other] = vs;
        log(row[0].name, other[0].name);
      `,
      ['_0xffff _0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('the rows handed to an array callback', async () => {
    const code = await expectPreserved(
      `
        var vs = ${ROWS};
        vs.forEach(function (row) { log(row[0].name); });
        vs.forEach(function (row) { for (const v of row) log(v.name); });
      `,
      [...BOTH, ...BOTH],
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('a part of a parameter stored under a key and read back', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { var o = { first: vs[0] }; log(o.first.name); }
        _0xf([function _0xffff() {}]);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('three levels down', async () => {
    const code = await expectPreserved(
      `
        var vs = [[[function _0xffff() {}]], [[class _0x1111 {}]]];
        for (const a of vs) for (const b of a) for (const c of b) log(c.name);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('ends on a list spread into itself, and has nothing to give up', async () => {
    // The spread copies the rows at the depth they are held: the walk
    // meets the same holder again and stops, with the read in sight. It
    // used to open one level per round and give up at a bound, with a word.
    const source = `
      var a = [[function _0xffff() {}]];
      a = [...a];
      for (const row of a) log(row[0].name);
      var _0x9999 = function () { return 1; };
      log(_0x9999());
    `;
    expect(observe(source)).toEqual(['_0xffff', '1']);
    for (const options of PRESETS) {
      const result = await run(source, options);
      expect(result.printed, options.preset).toEqual(['_0xffff', '1']);
      expect(result.warned, `${options.preset} warned`).toBe(0);
      expect(result.renames, options.preset).not.toContain('_0xffff');
    }
  });
});

describe('through the whole pipeline, where the proxy inliner makes the shapes above', () => {
  /** Every preset prints what the input prints, and the function keeps its name. */
  async function expectPipelinePreserved(source: string, expected: string[]): Promise<void> {
    expect(observe(source)).toEqual(expected);
    for (const options of PRESETS) {
      const { code } = await deobfuscate(source, options);
      expect(observe(code), options.preset).toEqual(expected);
      expect(code, options.preset).toContain('function _0x96d6');
    }
  }

  it('a method that calls its argument, handed a function returning a named function', async () => {
    // Before: the pass on its own pinned this; the inliner turned the call
    // into `(function () { return function _0x96d6() {} })().name`, and the
    // pass read nothing off a call with no name for a callee.
    await expectPipelinePreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v().name; };
        log(o.m(function () { return function _0x96d6() {}; }));
      `,
      ['fn:_0x96d6'],
    );
  });

  it('a method that reads its argument, handed globalThis.h', async () => {
    await expectPipelinePreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v.name; };
        globalThis.h = function _0x96d6() {};
        log(o.m(globalThis.h));
      `,
      ['fn:_0x96d6'],
    );
  });
});

describe('what the walk does not follow is disclosed at aggressive', () => {
  it('a bound function’s name is its own, and is followed', async () => {
    // `"bound " + _0xh.name`: the same spelling, read whole. Before:
    // aggressive printed `bound fn1` with no warning, then with one; now
    // the function keeps its name and nothing is disclosed.
    const code = await expectPreserved(
      `
        (function () {
          var _0xh = function () {};
          log(_0xh.bind(null).name);
        })();
      `,
      ['bound _0xh'],
    );
    expect(code).toContain('_0xh');
  });

  it('what a method of a local object returns', async () => {
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var o = { get() { return _0xh; } };
          log(o.get().name);
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });

  it('what an array method returns off an array this file wrote out is one of its elements', async () => {
    // `arr.pop()`, `arr.find(f)`, `arr.filter(f)[0]`: the receiver is an
    // array literal, so the method is the array's own and what comes back
    // is among its elements - pinned, and nothing to disclose.
    for (const read of ['arr.pop().name', 'arr.find(function (x) { return x; }).name', 'arr.filter(Boolean)[0].name']) {
      const code = await expectPreserved(
        `
          (function () {
            var _0xh = function () {};
            var arr = [_0xh];
            log(${read});
          })();
        `,
        ['_0xh'],
      );
      expect(code, read).toContain('_0xh');
    }
  });

  it('what an array method returns off a receiver that may be anything else', async () => {
    // A parameter's `.pop` may be any object's: the elements of what the
    // callers pass are read, and the read is disclosed as well.
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var o = { pop() { return _0xh; } };
          log(o.pop().name);
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });

  it('a property of a call result, which the contract says pins nothing', async () => {
    // Before: aggressive printed `val1` for each with no warning. The
    // callee is fixed and its returns in plain sight, but
    // `naming-reflection-members` holds `make().fn.name` to pin nothing,
    // so the read is disclosed rather than followed.
    const MAKE = `var _0xp = function () { return { k: function _0x96d6() {} }; };`;
    const PICK = `var _0xp = function () { return [function _0x96d6() {}]; };`;
    await expectDisclosed(`${MAKE} log(_0xp().k.name);`, ['_0x96d6'], '_0x96d6');
    await expectDisclosed(`${PICK} log(_0xp()[0].name);`, ['_0x96d6'], '_0x96d6');
    await expectDisclosed(`${MAKE} var w = _0xp(); log(w.k.name);`, ['_0x96d6'], '_0x96d6');
    await expectDisclosed(`${MAKE} const { k } = _0xp(); log(k.name);`, ['_0x96d6'], '_0x96d6');
    await expectDisclosed(`${PICK} const [v] = _0xp(); log(v.name);`, ['_0x96d6'], '_0x96d6');
    await expectDisclosed(
      `var _0xp = function () { return [[function _0x96d6() {}]]; }; for (const row of _0xp()) for (const v of row) log(v.name);`,
      ['_0x96d6'],
      '_0x96d6',
    );
  });

  it('a property of what a method of a local object returns', async () => {
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var o = { get() { return { k: _0xh }; } };
          log(o.get().k.name);
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });

  it('what a reassigned local returns when called', async () => {
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var g = function () { return 1; };
          g = function () { return _0xh; };
          log(g().name);
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });

  it('code compiled from a string that spells name, handed a local', async () => {
    await expectDisclosed(
      `
        (function () {
          var g = globalThis;
          var _0xh = function () {};
          log(g.eval('(function(v){return v.name})')(_0xh));
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          log(Function('v', 'return v.name')(_0xh));
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });

  it('says nothing when no function or class was renamed', async () => {
    // `_0xh.name` pins the one function; the holder is renamed, and it
    // carries no spelling a read could see.
    const code = await expectPreserved(
      `
        (function () {
          var _0xh = function () {};
          var _0xo = { get() { return _0xh; } };
          log(_0xh.name, typeof _0xo.get().name);
        })();
      `,
      ['_0xh string'],
    );
    expect(code).not.toContain('_0xo');
  });

  it('says nothing for a call rooted in a free name, which returns nothing of ours', async () => {
    const code = await expectPreserved(
      `
        (function () {
          var _0xh = function () { return 1; };
          log(typeof JSON.parse('{"name":"x"}').name, typeof JSON.parse('{"k":{"name":"x"}}').k.name, _0xh());
        })();
      `,
      ['string string 1'],
    );
    expect(code).not.toContain('_0xh');
  });

  it('says nothing for string code that cannot spell name', async () => {
    const code = await expectPreserved(
      `
        (function () {
          var _0xh = function () { return 2; };
          log(Function('v', 'return v()')(_0xh));
        })();
      `,
      ['2'],
    );
    expect(code).not.toContain('_0xh');
  });
});
