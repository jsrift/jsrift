import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A `.name` read on a part of a parameter, or on a binding that holds one.
 *
 * `v.name` directly on a parameter has been read at the call sites since
 * `recordParamNameRead`. Reached one step away it was not: the walk from
 * `v` in `for (var v of vs) log(v.name)` arrived at the parameter `vs` and
 * stopped there, since a parameter has no initialiser to open, and
 * `vs[0].name` opened nothing because a parameter has no stored values. The
 * function was then handed `function _0xffff() {}` from a caller in plain
 * sight and printed `val1` for it at aggressive, with no warning.
 *
 * A read on an element, an index, a destructured part or a loop variable of a
 * parameter is a read on the parameter, and is resolved to the callers the
 * same way. Each case runs input and output in a vm with only `log`, at all
 * three presets; every positive case drifted at aggressive before.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

/** Input and output print the same thing at every preset; returns the aggressive output. */
async function expectPreserved(source: string, expected: string[]): Promise<string> {
  expect(observe(source)).toEqual(expected);
  let aggressive = '';
  for (const options of PRESETS) {
    const { code } = await runPass(pass, source, options);
    expect(observe(code), options.preset).toEqual(expected);
    if (options.preset === 'aggressive') aggressive = code;
  }
  return aggressive;
}

const BOTH = ['_0xffff', '_0x1111'];

describe('a .name read on the elements of a rest parameter', () => {
  it('through a var loop variable', async () => {
    // Before: aggressive printed `val1` twice.
    const code = await expectPreserved(
      `
        function _0xf(...vs) { for (var v of vs) log(v.name); }
        _0xf(function _0xffff() {}, class _0x1111 {});
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through a const loop variable', async () => {
    const code = await expectPreserved(
      `
        function _0xf(...vs) { for (const v of vs) log(v.name); }
        _0xf(function _0xffff() {}, class _0x1111 {});
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through an index in a counted loop', async () => {
    const code = await expectPreserved(
      `
        function _0xf(...vs) { for (var i = 0; i < vs.length; i++) log(vs[i].name); }
        _0xf(function _0xffff() {}, class _0x1111 {});
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through a literal index', async () => {
    const code = await expectPreserved(
      `
        function _0xf(...vs) { log(vs[1].name); }
        _0xf(function _0xffff() {}, class _0x1111 {});
      `,
      ['_0x1111'],
    );
    expect(code).toContain('class _0x1111');
  });
});

describe('a .name read on the elements of an array parameter', () => {
  it('through a var loop variable', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (var v of vs) log(v.name); }
        _0xf([function _0xffff() {}, class _0x1111 {}]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through a const loop variable', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(v.name); }
        _0xf([function _0xffff() {}, class _0x1111 {}]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through a loop variable copied into a var', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) { var w = v; log(w.name); } }
        _0xf([function _0xffff() {}]);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('through a literal index', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { log(vs[0].name, vs[1].name); }
        _0xf([function _0xffff() {}, class _0x1111 {}]);
      `,
      ['_0xffff _0x1111'],
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through an index copied into a var', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (var i = 0; i < vs.length; i++) { var v = vs[i]; log(v.name); } }
        _0xf([function _0xffff() {}, class _0x1111 {}]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
    const one = await expectPreserved(
      `
        function _0xf(vs) { var w = vs[0]; log(w.name); }
        _0xf([function _0xffff() {}]);
      `,
      ['_0xffff'],
    );
    expect(one).toContain('function _0xffff');
  });

  it('through an array pattern', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { const [a, b] = vs; log(a.name, b.name); }
        _0xf([function _0xffff() {}, class _0x1111 {}]);
      `,
      ['_0xffff _0x1111'],
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('through a nested array pattern', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { const [[a]] = vs; log(a.name); }
        _0xf([[function _0xffff() {}]]);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('with an unresolved key that may be name', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs, k) { log(vs[0][k]); }
        _0xf([function _0xffff() {}], 'name');
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('when the array arrives through a binding, a spread, or a push', async () => {
    const bound = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(v.name); }
        var arr = [function _0xffff() {}, class _0x1111 {}];
        _0xf(arr);
      `,
      BOTH,
    );
    expect(bound).toContain('function _0xffff');
    expect(bound).toContain('class _0x1111');
    const spread = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(v.name); }
        var arr = [function _0xffff() {}];
        _0xf([...arr]);
      `,
      ['_0xffff'],
    );
    expect(spread).toContain('function _0xffff');
    const pushed = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(v.name); }
        var arr = [];
        arr.push(function _0xffff() {});
        _0xf(arr);
      `,
      ['_0xffff'],
    );
    expect(pushed).toContain('function _0xffff');
    const destructured = await expectPreserved(
      `
        function _0xf(vs) { const [a] = vs; log(a.name); }
        var arr = [function _0xffff() {}];
        _0xf(arr);
      `,
      ['_0xffff'],
    );
    expect(destructured).toContain('function _0xffff');
  });

  it('from every caller', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(v.name); }
        _0xf([function _0xffff() {}]);
        _0xf([class _0x1111 {}]);
      `,
      BOTH,
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('from a default when no caller passes one', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs = [function _0xffff() {}]) { log(vs[0].name); }
        _0xf();
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });
});

describe('a .name read on a property of a parameter', () => {
  it('by key', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { log(vs.k.name); }
        _0xf({ k: function _0xffff() {} });
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('by an object pattern', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { const { k } = vs; log(k.name); }
        _0xf({ k: function _0xffff() {} });
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('by key under an index', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { log(vs[0].k.name); }
        _0xf([{ k: function _0xffff() {} }]);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('on the elements of a destructured parameter', async () => {
    const code = await expectPreserved(
      `
        function _0xf({ list }) { for (const v of list) log(v.name); }
        _0xf({ list: [function _0xffff() {}] });
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });
});

describe('a .name read on a binding that holds the parameter itself', () => {
  it('a var copied from the parameter', async () => {
    const code = await expectPreserved(
      `
        function _0xf(v) { var w = v; log(w.name); }
        _0xf(function _0xffff() {});
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('widens to every escaped function when the callers are out of sight', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = function (v) { var w = v; log(w.name); };
        o.m(function _0xffff() {});
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
    const elements = await expectPreserved(
      `
        var o = {};
        o.m = function (vs) { for (const v of vs) log(v.name); };
        var _0xg = function () {};
        o.m([_0xg]);
      `,
      ['_0xg'],
    );
    expect(elements).toContain('_0xg');
  });

  it('an unresolved key on such a parameter reads the argument where the method is called in sight', async () => {
    // `o.m(...)` on a local literal is a call the walk enumerates, so the key
    // that may be `name` is read off what the call passes, exactly as a
    // direct call's would be: `_0xg` keeps its spelling. Before, the
    // method's callers were taken as out of sight and the read widened to
    // nothing, which printed `fn1` for `_0xg` once the key was `name`.
    // Inside an IIFE, since a program-scope function handed to a call in a
    // script is refused on its own account.
    const code = await expectPreserved(
      `
        (function () {
          var o = {};
          o.m = function (vs, k) { for (const v of vs) log(typeof v[k]); };
          var _0xg = function () {};
          o.m([_0xg], 'length');
          log(typeof _0xg);
        })();
      `,
      ['number', 'function'],
    );
    expect(code).toContain('_0xg');
  });

  it('but widens to nothing for the callers it cannot see', async () => {
    // The same trade `naming-opaque-reads` makes for a direct read: the key
    // being `name` *and* the element being one of ours is two unknowns. With
    // `o` let go of - an element of an array, here - the method has callers
    // out of sight; the call in sight still reads its argument, and what was
    // let go of beside `o` is not read.
    const code = await expectPreserved(
      `
        (function () {
          var o = {};
          o.m = function (vs, k) { for (const v of vs) log(typeof v[k]); };
          var _0xg = function () {};
          var _0xh = function () {};
          o.m([_0xg], 'length');
          log(typeof _0xg, typeof _0xh, [o, _0xh].length);
        })();
      `,
      ['number', 'function function 2'],
    );
    expect(code).toContain('_0xg');
    expect(code).not.toContain('_0xh');
  });
});

describe('the same reads on a local array or object', () => {
  it('an array pattern over a bound array', async () => {
    const code = await expectPreserved(
      `
        var vs = [function _0xffff() {}, class _0x1111 {}];
        const [a, b] = vs;
        log(a.name, b.name);
      `,
      ['_0xffff _0x1111'],
    );
    expect(code).toContain('function _0xffff');
    expect(code).toContain('class _0x1111');
  });

  it('an array pattern assigned after declaration', async () => {
    const code = await expectPreserved(
      `
        var vs = [function _0xffff() {}];
        var a;
        [a] = vs;
        log(a.name);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('an object pattern over a bound object', async () => {
    const code = await expectPreserved(
      `
        var o = { k: function _0xffff() {} };
        const { k } = o;
        log(k.name);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('a var holding a property or an element', async () => {
    const property = await expectPreserved(
      `
        var o = { k: function _0xffff() {} };
        var w = o.k;
        log(w.name);
      `,
      ['_0xffff'],
    );
    expect(property).toContain('function _0xffff');
    const element = await expectPreserved(
      `
        var vs = [function _0xffff() {}];
        var w = vs[0];
        log(w.name);
      `,
      ['_0xffff'],
    );
    expect(element).toContain('function _0xffff');
  });

  it('a loop over a property that holds an array', async () => {
    const code = await expectPreserved(
      `
        var o = { list: [function _0xffff() {}] };
        for (const v of o.list) log(v.name);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('a loop assigning an existing var', async () => {
    const code = await expectPreserved(
      `
        var vs = [function _0xffff() {}];
        var v;
        for (v of vs) log(v.name);
      `,
      ['_0xffff'],
    );
    expect(code).toContain('function _0xffff');
  });
});

describe('a function handed its own parameter one selection deeper', () => {
  // Reading `vs[0]` at the recursive call site is reading `vs[0][0]`, and so
  // on without end; the first version of the part walk did not come back
  // from these. The read past the cap widens, so the function is still kept.
  it('by index', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { if (vs.length > 1) _0xf(vs[0]); log(typeof vs[0].name); }
        _0xf([[function _0xffff() {}], 1]);
      `,
      ['string', 'undefined'],
    );
    expect(code).toContain('function _0xffff');
  });

  it('by key', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { if (vs.k.k) _0xf(vs.k); log(typeof vs.k.name); }
        _0xf({ k: { k: function _0xffff() {} } });
      `,
      ['string', 'undefined'],
    );
    expect(code).toContain('function _0xffff');
  });
});

describe('what the parameter walk leaves alone', () => {
  it('a function no caller passes is still renamed', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(v.name); }
        var _0x2222 = function () {};
        _0xf([function _0xffff() {}]);
        log(typeof _0x2222);
      `,
      ['_0xffff', 'function'],
    );
    expect(code).toContain('function _0xffff');
    expect(code).not.toContain('_0x2222');
  });

  it('a parameter whose elements are only counted pins nothing', async () => {
    const code = await expectPreserved(
      `
        function _0xf(vs) { for (const v of vs) log(typeof v); }
        _0xf([function _0xffff() {}]);
      `,
      ['function'],
    );
    expect(code).not.toContain('_0xffff');
  });
});
