import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * Evidence that names a parameter, or a value, from the way it is passed
 * around rather than from what it holds.
 *
 * Every case is a fully decoded obfuscator.io shape: the strings are back, the
 * program's own function and class names survive because `renameGlobals` is
 * off by default, and what is left wearing `_0x` names is the parameters and
 * locals whose only evidence is the call they are handed to, the call they
 * arrive through, or the way their function is used. Each case runs input and
 * output in a vm with only `log`, at all three presets, and asserts the name
 * the output carries - a coverage test, so the shape that is gone from the
 * output is asserted, not only the behaviour.
 *
 * Where a case asserts at 'aggressive' too, the name it copies is one that
 * survives that preset: a constructor parameter the `this.k` store names, or a
 * property read, which belongs to no binding. A name that merely *reads* well
 * is not one of those - 'aggressive' renames those as readily as it renames a
 * `_0x` one, so a rule that copies it has nothing to copy there.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({
    log: (...values: unknown[]) => logs.push(values.map(String).join(' ')),
  });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

interface Outputs {
  conservative: string;
  balanced: string;
  aggressive: string;
}

/** Input and output print the same thing at every preset; returns every output. */
async function expectPreserved(source: string, expected: string[]): Promise<Outputs> {
  expect(observe(source)).toEqual(expected);
  const outputs: Outputs = { conservative: '', balanced: '', aggressive: '' };
  for (const options of PRESETS) {
    const { code } = await runPass(pass, source, options);
    expect(observe(code), options.preset).toEqual(expected);
    outputs[options.preset as keyof Outputs] = code;
  }
  return outputs;
}

/** Whether a name is left in an output, as a whole identifier. */
function has(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code);
}

describe('D10: an argument takes the name of the parameter it is bound to', () => {
  it('through a class constructor', async () => {
    // Before: `_0x38b772` at balanced, `arg1` at aggressive - the shape the
    // `modern` probe program is left holding once everything else decodes.
    const out = await expectPreserved(
      `
        class Vessel {
          constructor(_0x1f2244) { this.hex = _0x1f2244; }
          static from(_0x38b772) { return new Vessel(_0x38b772); }
        }
        log(Vessel.from('d3cb').hex);
      `,
      ['d3cb'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/from\(hex\)/);
      expect(has(code, '_0x38b772')).toBe(false);
      expect(has(code, '_0x1f2244')).toBe(false);
    }
  });

  it('through a function declaration, at the argument index', async () => {
    // The two arguments are handed over crossed, so copying by position rather
    // than by index would name both of them the same thing.
    const out = await expectPreserved(
      `
        function pad(width, fill) { return fill.repeat(width); }
        function _0x4c1a77(_0x2b7d31, _0x3e8f02) { return pad(_0x3e8f02, _0x2b7d31); }
        log(_0x4c1a77('-', 3));
      `,
      ['---'],
    );
    expect(out.balanced).toMatch(/_0x4c1a77\(fill, width\)/);
    expect(has(out.balanced, '_0x2b7d31')).toBe(false);
    expect(has(out.balanced, '_0x3e8f02')).toBe(false);
  });

  it('copies the name the callee\'s parameter is being given, not the one it is losing', async () => {
    // `_0x1f2244` is itself a rename target, named `label` by its store; a run
    // that copied its current spelling would put `_0x1f2244` on a second
    // binding and delete it from the first.
    const out = await expectPreserved(
      `
        class Tag {
          constructor(_0x1f2244) { this.label = _0x1f2244; }
          static of(_0x2a3355) { return new Tag(_0x2a3355); }
        }
        log(Tag.of('x').label);
      `,
      ['x'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/of\(label\)/);
      expect(has(code, '_0x2a3355')).toBe(false);
      expect(has(code, '_0x1f2244')).toBe(false);
    }
  });

  it('refuses a callee whose binding is written after it is bound', async () => {
    // `_0x9a1122` is rebound, so the call runs a different function than the
    // one whose parameters are in sight, and that one's word for the argument
    // says nothing about this value.
    const out = await expectPreserved(
      `
        function _0x9a1122(width) { return 'a' + width; }
        _0x9a1122 = function (_0x3c5566) { return 'b' + _0x3c5566; };
        function outer(_0x7c3344) { return _0x9a1122(_0x7c3344); }
        log(outer(1));
      `,
      ['b1'],
    );
    expect(out.balanced).toMatch(/function outer\(_0x7c3344\)/);
  });

  it('refuses a spread at or before the argument index', async () => {
    // The spread shifts `second` by however many elements it carries, so
    // nothing binds the argument at index 1 to it.
    const out = await expectPreserved(
      `
        function take(first, second) { return first + '/' + second; }
        function _0x5d6677(_0x6e8899, _0x7f00aa) { return take(..._0x6e8899, _0x7f00aa); }
        log(_0x5d6677(['a'], 'b'));
      `,
      ['a/b'],
    );
    // The spread's own parameter is named for being spread; what must not
    // happen is either of them taking a name off `take`'s parameter list.
    expect(out.balanced).toMatch(/function _0x5d6677\(items, _0x7f00aa\)/);
  });
});

describe('D11: a parameter takes the name every caller passes it under', () => {
  it('when every use of the function is a call in sight', async () => {
    // The argument is a property read, which no rename touches, so the name
    // holds at 'aggressive' as well.
    const out = await expectPreserved(
      `
        function _0x3b1234(_0x4c5678) { return _0x4c5678.toUpperCase(); }
        const settings = { message: 'hi' };
        log(_0x3b1234(settings.message));
      `,
      ['HI'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\(message\) \{\s*return message\.toUpperCase\(\)/);
      expect(has(code, '_0x4c5678')).toBe(false);
    }
  });

  it('refuses when two callers use two words for it', async () => {
    const out = await expectPreserved(
      `
        function _0x3b1234(_0x4c5678) { return String(_0x4c5678); }
        const settings = { message: 'hi', counter: 2 };
        log(_0x3b1234(settings.message) + _0x3b1234(settings.counter));
      `,
      ['hi2'],
    );
    expect(out.balanced).toMatch(/function _0x3b1234\(_0x4c5678\)/);
  });

  it('refuses when the function itself is handed somewhere else', async () => {
    // A caller this walk cannot see passes something the callers it can see
    // never pass, so the names in sight are not all of them.
    const out = await expectPreserved(
      `
        function _0x3b1234(_0x4c5678) { return String(_0x4c5678); }
        const settings = { message: 'hi' };
        log(_0x3b1234(settings.message) + ['x'].map(_0x3b1234).join(''));
      `,
      ['hix'],
    );
    expect(out.balanced).toMatch(/function _0x3b1234\(_0x4c5678\)/);
  });

  it('is not fed by the recursive call that passes the parameter back', async () => {
    // A function that passes its own parameter on is not a second source for
    // it; the caller in sight is the one that names it.
    const out = await expectPreserved(
      `
        function _0x1e2233(_0x2f4455, _0x3a6677) {
          return _0x3a6677 === 0 ? '' : _0x2f4455 + _0x1e2233(_0x2f4455, _0x3a6677 - 1);
        }
        const glyph = { symbol: '*' };
        log(_0x1e2233(glyph.symbol, 3));
      `,
      ['***'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\(symbol, [\w$]+\) \{/);
      expect(has(code, '_0x2f4455')).toBe(false);
    }
  });

  it('refuses a caller whose own word is the obfuscator\'s', async () => {
    // Copying it would put the same generated spelling on a second binding.
    const out = await expectPreserved(
      `
        function _0x3b1234(_0x4c5678) { return String(_0x4c5678); }
        var _0x5dab90 = 7;
        log(_0x3b1234(_0x5dab90));
      `,
      ['7'],
    );
    expect(out.balanced).toMatch(/function _0x3b1234\(_0x4c5678\)/);
  });
});

describe('a parameter named by the way its own function is used', () => {
  it('names a template tag\'s parameters after what the language puts in them', async () => {
    const out = await expectPreserved(
      `
        const tag = (_0x40176c, ..._0x20201a) => _0x40176c.raw.join('|') + _0x20201a.length;
        log(tag\`a\${1}b\${2}\`);
      `,
      ['a|b|2'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\(strings, \.\.\.values\)/);
      expect(has(code, '_0x40176c')).toBe(false);
      expect(has(code, '_0x20201a')).toBe(false);
    }
  });

  it('names a rest parameter after what it collects', async () => {
    const out = await expectPreserved(
      `
        function _0x8c1234(_0x9d5678, ..._0xae9012) { return _0x9d5678 + _0xae9012.length; }
        log(_0x8c1234(1, 2, 3));
      `,
      ['3'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\.\.\.args\)/);
      expect(has(code, '_0xae9012')).toBe(false);
    }
  });

  it('names a called parameter a function, and a constructed one a constructor', async () => {
    const out = await expectPreserved(
      `
        function run(_0x11aabb, _0x22ccdd) { return _0x11aabb(new _0x22ccdd(3).length); }
        log(run(function (n) { return 'n' + n; }, Array));
      `,
      ['n3'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/run\(fn, ctor\)/);
      expect(has(code, '_0x11aabb')).toBe(false);
      expect(has(code, '_0x22ccdd')).toBe(false);
    }
  });
});

describe('a function a local holder keeps under a key', () => {
  it('names its parameters from the calls through the holder', async () => {
    // obfuscator.io's control-flow flattening leaves exactly this: the call is
    // `h.key(...)`, so the function has no binding of its own and its callers
    // are the holder's references.
    const out = await expectPreserved(
      `
        function hi(_0x4b21ca) {
          const _0xa7728a = {
            xZgXr: function (_0x3a4297, _0x5472fb, _0x735f6c) { return _0x3a4297(_0x5472fb, _0x735f6c); }
          };
          return _0xa7728a.xZgXr(parseInt, _0x4b21ca.digits, 16);
        }
        log(hi({ digits: 'ff' }));
      `,
      ['255'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/function \(fn, digits, [\w$]+\)/);
      expect(has(code, '_0x5472fb')).toBe(false);
    }
  });

  it('refuses when the holder itself goes somewhere the walk cannot follow', async () => {
    const out = await expectPreserved(
      `
        function hi(_0x4b21ca) {
          const _0xa7728a = {
            xZgXr: function (_0x3a4297, _0x5472fb) { return _0x3a4297(_0x5472fb); }
          };
          const kept = [_0xa7728a];
          return _0xa7728a.xZgXr(String, _0x4b21ca.digits) + kept.length;
        }
        log(hi({ digits: 7 }));
      `,
      ['71'],
    );
    expect(out.balanced).toMatch(/function \([\w$]+, _0x5472fb\)/);
  });

  it('refuses when the program writes that key', async () => {
    // What `h.k` holds at the call is not what the literal declared.
    const out = await expectPreserved(
      `
        function hi(_0x4b21ca) {
          const _0xa7728a = {
            xZgXr: function (_0x3a4297, _0x5472fb) { return _0x3a4297(_0x5472fb); }
          };
          _0xa7728a.xZgXr = function (f, v) { return 'x' + f(v); };
          return _0xa7728a.xZgXr(String, _0x4b21ca.digits);
        }
        log(hi({ digits: 7 }));
      `,
      ['x7'],
    );
    expect(out.balanced).toMatch(/function \([\w$]+, _0x5472fb\)/);
  });
});

describe('a value stored in a private field', () => {
  it('takes the field\'s own name', async () => {
    const out = await expectPreserved(
      `
        class Vessel {
          #value;
          constructor(_0x5e6f88) { this.#value = _0x5e6f88; }
          read() { return this.#value; }
        }
        log(new Vessel('kept').read());
      `,
      ['kept'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/constructor\(value\)/);
      expect(has(code, '_0x5e6f88')).toBe(false);
    }
  });
});

describe('P05: a Proxy trap\'s parameters are the ones the language passes', () => {
  it('names the get trap\'s key and receiver and the apply trap\'s receiver', async () => {
    // Before: `apply(target, _0x88bb22, args)` - C29 knew the two arguments
    // that reach `Reflect.apply`, and nothing knew the one that does not.
    const out = await expectPreserved(
      `
        const box = new Proxy({ n: 1 }, {
          get(_0x1a2b3c, _0x4d5e6f, _0x7a8b9c) { return _0x1a2b3c[_0x4d5e6f] + 1; }
        });
        const call = new Proxy(String, {
          apply(_0x77aa11, _0x88bb22, _0x99cc33) { return Reflect.apply(_0x77aa11, _0x88bb22, _0x99cc33) + '!'; }
        });
        log(box.n, call(7));
      `,
      ['2 7!'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/get\(target, key, receiver\)/);
      expect(code).toMatch(/apply\(target, thisArg, args\)/);
      expect(has(code, '_0x7a8b9c')).toBe(false);
      expect(has(code, '_0x88bb22')).toBe(false);
    }
  });

  it('through a handler kept in a binding the construction reads', async () => {
    const out = await expectPreserved(
      `
        const handler = {
          set: function (_0x3c4d5e, _0x6f7a8b, _0x9c0d1e) { _0x3c4d5e[_0x6f7a8b] = _0x9c0d1e * 2; return true; }
        };
        const doubled = new Proxy({}, handler);
        doubled.k = 4;
        log(doubled.k);
      `,
      ['8'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/set: function \(target, key, value\)/);
    }
  });

  it('refuses a method called apply on an object no Proxy takes', async () => {
    // The trap names are ordinary words; only the handler position makes one
    // a trap.
    const out = await expectPreserved(
      `
        const helpers = {
          apply(_0x11aa22, _0x33bb44, _0x55cc66) { return _0x11aa22(_0x33bb44, _0x55cc66); }
        };
        log(helpers.apply(Math.max, 1, 2));
      `,
      ['2'],
    );
    expect(has(out.balanced, 'thisArg')).toBe(false);
    expect(has(out.aggressive, 'thisArg')).toBe(false);
  });
});

describe('D10: through the literal an IIFE hands back', () => {
  it('names an argument after the parameter of the function the module returns', async () => {
    // The revealing-module shape: `lib.reverse` is `reverse`, declared inside
    // the IIFE and returned under its own name.
    // `reverse`'s own parameter is named by the spread, at both presets, and
    // that is the name the argument copies.
    const out = await expectPreserved(
      `
        const lib = (() => {
          function reverse(_0x5a1b2c) { return [..._0x5a1b2c].reverse(); }
          return { reverse: reverse };
        })();
        const thru = _0x1f2a3b => lib.reverse(_0x1f2a3b).join('');
        log(thru(['a', 'b']));
      `,
      ['ba'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/reverse\(items\)/);
      expect(code).toMatch(/items => [\w$]+\.reverse\(items\)/);
      expect(has(code, '_0x1f2a3b')).toBe(false);
    }
  });

  it('refuses an IIFE with more than one way out', async () => {
    // Two returns, two literals: what the binding holds depends on a branch
    // this rule does not take.
    const out = await expectPreserved(
      `
        const lib = (() => {
          function reverse(list) { return list.slice().reverse(); }
          function keep(text) { return [text]; }
          if (typeof reverse === 'function') return { reverse: keep };
          return { reverse: reverse };
        })();
        const thru = _0x1f2a3b => lib.reverse(_0x1f2a3b).join('');
        log(thru('ab'));
      `,
      ['ab'],
    );
    expect(out.balanced).toMatch(/_0x1f2a3b => [\w$]+\.reverse\(_0x1f2a3b\)/);
  });
});

describe('a class named from a key keeps the key\'s capital', () => {
  it('is spelled as the key is, through the literal that returns it', async () => {
    // Before: `class vessel` under `Vessel: vessel`, which reads as a value
    // to anyone used to the convention.
    const source = `
      const api = (() => {
        class _0x1dc93a { constructor(v) { this.v = v; } }
        return { Vessel: _0x1dc93a };
      })();
      log(new api.Vessel(3).v);
    `;
    const expected = ['3'];
    const out = await expectPreserved(source, expected);
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/class Vessel \{/);
      expect(code).toMatch(/Vessel: Vessel/);
      expect(has(code, 'vessel')).toBe(false);
    }
    for (const options of PRESETS) {
      const second = await runPass(pass, out[options.preset as keyof Outputs], options);
      expect(second.changes, options.preset).toBe(0);
      expect(observe(second.code), options.preset).toEqual(expected);
    }
  });
});

describe('the names this evidence produces are a fixed point', () => {
  it('renames nothing on a second pass over its own output', async () => {
    const source = `
      class Vessel {
        #value;
        constructor(_0x1f2244) { this.#value = _0x1f2244; }
        static from(_0x38b772) { return new Vessel(_0x38b772); }
        read() { return this.#value; }
      }
      const tag = (_0x40176c, ..._0x20201a) => _0x40176c.raw.join('|') + _0x20201a.length;
      function _0x8c1234(_0x9d5678, ..._0xae9012) { return _0x9d5678 + _0xae9012.length; }
      log(Vessel.from('d3cb').read(), tag\`a\${1}\`, _0x8c1234(1, 2));
    `;
    const expected = ['d3cb a|1 2'];
    const out = await expectPreserved(source, expected);
    for (const options of PRESETS) {
      const second = await runPass(pass, out[options.preset as keyof Outputs], options);
      expect(second.changes, options.preset).toBe(0);
      expect(observe(second.code), options.preset).toEqual(expected);
    }
  });
});
