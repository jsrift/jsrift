import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A named function or class expression handed on as a literal.
 *
 * `escapedBindings` used to read a binding's references and nothing else, so
 * `o.m(function _0x96d6() {})` let nothing go: the function's own name binds
 * inside the function, is referenced nowhere, and the expression itself is
 * not a reference. A bound alias in the same position - `o.m(_0xh)` - was
 * frozen correctly, and the literal was renamed out from under the `.name`
 * read at aggressive with no warning: `fn:_0x96d6` printed as `fn:val1` on
 * every one of the positions below.
 *
 * Each case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print; every positive case drifted at
 * aggressive before the expression's own position was read as a reference.
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

describe('a named function expression handed to a callee whose parameter reads .name', () => {
  it('as the argument of a method call', async () => {
    // Before: aggressive printed `fn:val1`.
    const code = await expectPreserved(
      `
        var o = { m: function (v) { return 'fn:' + v.name; } };
        log(o.m(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as the argument of a member callee assigned after the fact', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v.name; };
        log(o.m(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('beside a bound alias in the same position, which was already frozen', async () => {
    const code = await expectPreserved(
      `
        var o = { m: function (v) { return 'fn:' + v.name; } };
        var _0xh = function _0xnamed() {};
        log(o.m(_0xh), o.m(function _0x96d6() {}));
      `,
      ['fn:_0xnamed fn:_0x96d6'],
    );
    expect(code).toContain('function _0xnamed');
    expect(code).toContain('function _0x96d6');
  });

  it('as the argument of a reassigned callee', async () => {
    const code = await expectPreserved(
      `
        var x = 1;
        var _0xf = function (v) { return 'a:' + typeof v; };
        if (x) _0xf = function (v) { return 'fn:' + v.name; };
        log(_0xf(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as the argument of a callee declared twice', async () => {
    const code = await expectPreserved(
      `
        var _0xf = function (v) { return typeof v; };
        var _0xf = function (v) { return 'fn:' + v.name; };
        log(_0xf(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as the argument of an array-element callee', async () => {
    const code = await expectPreserved(
      `
        function _0xf(v) { return 'fn:' + v.name; }
        var q = [_0xf];
        log(q[0](function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as the argument of a callee reached through eval', async () => {
    const code = await expectPreserved(
      `
        function _0xf(v) { return 'fn:' + v.name; }
        var g = globalThis;
        log(g.eval('_0xf')(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as the argument of an Annex B block function called outside its block', async () => {
    const code = await expectPreserved(
      `
        {
          function _0xc(v) { var n = v.name; return 'fn:' + n; }
        }
        log(_0xc(function _0x96d6() {}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('to `new` of a class expression and of a class declaration', async () => {
    const expression = await expectPreserved(
      `
        var _0xC = class { constructor(v) { this.n = v.name; } };
        log(new _0xC(function _0x96d6() {}).n);
      `,
      ['_0x96d6'],
    );
    expect(expression).toContain('function _0x96d6');
    const declaration = await expectPreserved(
      `
        class _0xC { constructor(v) { this.n = v.name; } }
        log(new _0xC(function _0x96d6() {}).n);
      `,
      ['_0x96d6'],
    );
    expect(declaration).toContain('function _0x96d6');
  });

  it('a class expression is frozen the same way', async () => {
    const code = await expectPreserved(
      `
        var o = { m: function (v) { return 'cls:' + v.name; } };
        log(o.m(class _0xK {}));
      `,
      ['cls:_0xK'],
    );
    expect(code).toContain('class _0xK');
  });
});

describe('a named function expression let go of somewhere other than an argument', () => {
  it('as an element of an array handed on', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v[0].name; };
        log(o.m([function _0x96d6() {}]));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as a property value handed on', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = function (v) { return 'fn:' + v.k.name; };
        log(o.m({ k: function _0x96d6() {} }));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('as the return value of a function handed on', async () => {
    // Two holes at once: the literal never escaped, and `.name` off what a
    // parameter *returned* was not a read of anything. A bound alias in the
    // same position drifted too, so the second is tested on its own below.
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

  it('as a store onto the global object', async () => {
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
});

describe('a .name read off what a call returned', () => {
  it('off a call of a parameter, widens to every escaped function', async () => {
    // Before: aggressive printed `fn:fn1`.
    const code = await expectPreserved(
      `
        (function () {
          var o = {};
          o.m = function (v) { return 'fn:' + v().name; };
          var _0xh = function () {};
          log(o.m(function () { return _0xh; }));
        })();
      `,
      ['fn:_0xh'],
    );
    expect(code).toContain('_0xh');
  });

  it('off a call of a function this file can see, reads what it returns', async () => {
    const code = await expectPreserved(
      `
        (function () {
          var _0xh = function () {};
          var _0xi = function () {};
          function pick(n) { if (n) return _0xh; return _0xi; }
          var arrow = () => _0xh;
          log(pick(1).name, pick(0).name, arrow().name);
        })();
      `,
      ['_0xh _0xi _0xh'],
    );
    expect(code).toContain('_0xh');
    expect(code).toContain('_0xi');
    // The reader was never let go of, so nothing widened to it.
    expect(code).not.toContain('function pick(');
  });

  it('off a call rooted in a name this file never binds, reads nothing of ours', async () => {
    // The unknown-code boundary: what another script's function returns is
    // that script's, and `_0xk` was let go of only to it.
    const code = await expectPreserved(
      `
        (function () {
          var _0xk = function () {};
          Object.freeze(_0xk);
          log(JSON.parse('{"name":"x"}').name, typeof _0xk);
        })();
      `,
      ['x function'],
    );
    expect(code).not.toContain('_0xk');
  });
});

describe('what the literal fix leaves alone', () => {
  // Inside an IIFE: a program-scope function a script calls is refused on
  // its own account, and these are about the escape walk.
  it('a function the program never lets go of is still renamed', async () => {
    // `_0xq` is only ever called: no parameter can hold it.
    const code = await expectPreserved(
      `
        (function () {
          var o = { m: function (v) { return 'fn:' + v.name; } };
          var _0xq = function (a) { return a + 1; };
          log(o.m(function _0x96d6() {}), _0xq(1));
        })();
      `,
      ['fn:_0x96d6 2'],
    );
    expect(code).toContain('function _0x96d6');
    expect(code).not.toContain('_0xq');
  });

  it('a named expression that is only called is still renamed', async () => {
    const code = await expectPreserved(
      `
        (function () {
          var o = { m: function (v) { return 'fn:' + v.name; } };
          var _0xh = function () {};
          log((function _0x7777() { return 1; })(), o.m(_0xh));
        })();
      `,
      ['1 fn:_0xh'],
    );
    expect(code).toContain('_0xh');
    expect(code).not.toContain('_0x7777');
  });

  it('without a .name read anywhere, a literal argument is renamed', async () => {
    const code = await expectPreserved(
      `
        var o = { m: function (v) { return typeof v; } };
        log(o.m(function _0x96d6() {}));
      `,
      ['function'],
    );
    expect(code).not.toContain('_0x96d6');
  });
});
