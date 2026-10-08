import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * What a value is, read off what the program does with it.
 *
 * A decoded obfuscator.io file has its strings and its own function names
 * back, and what is still unreadable is the values: parameters and locals the
 * generator named, most of them never passed to anything a dictionary knows.
 * What is left to read them by is the body - a method only a string answers
 * to, a `for...of` that walks them, an index they are used as, a literal they
 * are joined to.
 *
 * Each arm is paired with its refusal, because every one of these rules is a
 * claim about a *kind* of value and the way to test such a claim is the case
 * where the same shape means something else: `rows[i]` is a list read and
 * `map[token]` is not, `'total: ' + n` prints a number and does not make one
 * text. Every case runs input and output in a vm with only `log`, at all three
 * presets.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

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

function has(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code);
}

describe('a method only one kind of value answers to', () => {
  it('names a string after the call that proves it is one', async () => {
    const out = await expectPreserved(
      `
        function _0x2c91ab(_0x4e7f21) { return _0x4e7f21.toUpperCase().padStart(4, '.'); }
        log(_0x2c91ab('ab'));
      `,
      ['..AB'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\(text\)/);
      expect(has(code, '_0x4e7f21')).toBe(false);
    }
  });

  it('refuses the methods an array answers to as readily', async () => {
    // `.length` and `.slice` are both, so neither settles what this holds.
    const out = await expectPreserved(
      `
        function _0x2c91ab(_0x4e7f21) { return _0x4e7f21.slice(0, _0x4e7f21.length - 1); }
        log(_0x2c91ab([1, 2, 3]).join('') + _0x2c91ab('abc'));
      `,
      ['12ab'],
    );
    expect(has(out.balanced, 'text')).toBe(false);
  });
});

describe('a value the program walks', () => {
  it('is named for its elements, through a for-of', async () => {
    const out = await expectPreserved(
      `
        function _0x3d81cc(_0x51ba0e) {
          let _0x22cd41 = 0;
          for (const _0x7bd192 of _0x51ba0e) _0x22cd41 += _0x7bd192;
          return _0x22cd41;
        }
        log(_0x3d81cc([1, 2, 3]));
      `,
      ['6'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\(items\)/);
      expect(code).toMatch(/of items/);
      expect(has(code, '_0x51ba0e')).toBe(false);
    }
  });

  it('is named for its elements, through a spread', async () => {
    const out = await expectPreserved(
      `
        function _0x3d81cc(_0x51ba0e) { return Math.max(..._0x51ba0e); }
        log(_0x3d81cc([1, 7, 3]));
      `,
      ['7'],
    );
    expect(out.balanced).toMatch(/\(items\)/);
  });

  it('leaves a loop counter to the rule that knows it is one', async () => {
    // `[...x]` of a counter cannot happen, but a counter spread through
    // `for (i of ...)` can: F01's name is the better one for the same binding.
    const out = await expectPreserved(
      `
        var _0x91ab22 = [];
        for (var _0x44fe01 = 0; _0x44fe01 < 3; _0x44fe01++) _0x91ab22.push(_0x44fe01);
        log(_0x91ab22.join(''));
      `,
      ['012'],
    );
    expect(out.balanced).toMatch(/for \(var i = 0; i < 3; i\+\+\)/);
  });
});

describe('a value used as a position', () => {
  it('is named an index when the program counts with it', async () => {
    const out = await expectPreserved(
      `
        function _0x5ca913(_0x2f8b44, _0x8e1d05) {
          return _0x2f8b44[_0x8e1d05 - 1];
        }
        log(_0x5ca913(['a', 'b'], 2));
      `,
      ['b'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(has(code, '_0x8e1d05')).toBe(false);
      expect(code).toMatch(/index/);
    }
  });

  it('refuses a key that is only ever a key', async () => {
    // A dictionary read is the same syntax and the opposite claim.
    const out = await expectPreserved(
      `
        function _0x5ca913(_0x2f8b44, _0x8e1d05) { return _0x2f8b44[_0x8e1d05]; }
        log(_0x5ca913({ k: 'v' }, 'k'));
      `,
      ['v'],
    );
    expect(has(out.balanced, 'index')).toBe(false);
  });

  it('names a list by its length and the positions read out of it', async () => {
    const out = await expectPreserved(
      `
        function _0x7a44b1(_0x6b2c08) {
          let _0x1d9e70 = '';
          for (var _0x3c55a9 = 0; _0x3c55a9 < _0x6b2c08.length; _0x3c55a9++) _0x1d9e70 += _0x6b2c08[_0x3c55a9];
          return _0x1d9e70;
        }
        log(_0x7a44b1(['x', 'y']));
      `,
      ['xy'],
    );
    expect(out.balanced).toMatch(/\(list\)/);
  });
});

describe('a value the program steps', () => {
  it('is a count even when it was not seeded with zero', async () => {
    const out = await expectPreserved(
      `
        function counter(_0x5671e0) {
          var _0x44453d = _0x5671e0;
          return { inc: function () { return ++_0x44453d; }, get: function () { return _0x44453d; } };
        }
        var c = counter(10);
        c.inc();
        log(c.get());
      `,
      ['11'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\+\+count/);
      expect(has(code, '_0x44453d')).toBe(false);
    }
  });

  it('leaves an accumulator to the rule that knows it is one', async () => {
    const out = await expectPreserved(
      `
        function _0x71aa22(_0x82bb33) {
          var _0x93cc44 = 0;
          for (var i = 0; i < _0x82bb33.length; i++) _0x93cc44 += _0x82bb33[i];
          return _0x93cc44;
        }
        log(_0x71aa22([1, 2, 3]));
      `,
      ['6'],
    );
    expect(out.balanced).toMatch(/total/);
    expect(has(out.balanced, 'count')).toBe(false);
  });
});

describe('a value joined to a literal', () => {
  it('is named text when nothing counts with it', async () => {
    const out = await expectPreserved(
      `
        function greet(_0x5cff57) { return 'Hello, ' + _0x5cff57 + '!'; }
        log(greet('World'));
      `,
      ['Hello, World!'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/greet\(text\)|function greet\(text\)/);
      expect(has(code, '_0x5cff57')).toBe(false);
    }
  });

  it('refuses a number the program prints', async () => {
    const out = await expectPreserved(
      `
        function _0x61ce22(_0x8d12f4) { return 'total: ' + (_0x8d12f4 * 2); }
        log(_0x61ce22(3));
      `,
      ['total: 6'],
    );
    expect(has(out.balanced, 'text')).toBe(false);
  });
});

describe('the argument positions a decoded file is full of', () => {
  it('names a radix, a slice bound and a character position', async () => {
    const out = await expectPreserved(
      `
        function _0x12ab34(_0x56cd78, _0x9aef01, _0x23bc45) {
          return parseInt('ff', _0x56cd78) + '/' + 'abcdef'.slice(_0x9aef01) + '/' + 'abc'.charCodeAt(_0x23bc45);
        }
        log(_0x12ab34(16, 2, 1));
      `,
      ['255/cdef/98'],
    );
    expect(out.balanced).toMatch(/\(radix, start, index\)/);
  });

  it('names the target and the argument list of a reflective call', async () => {
    const out = await expectPreserved(
      `
        const proxy = new Proxy(String, {
          apply(_0x77aa11, _0x88bb22, _0x99cc33) { return Reflect.apply(_0x77aa11, undefined, _0x99cc33); }
        });
        log(proxy(7));
      `,
      ['7'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/apply\(target, [\w$]+, args\)/);
      expect(has(code, '_0x77aa11')).toBe(false);
      expect(has(code, '_0x99cc33')).toBe(false);
    }
  });
});

describe('the holder a control-flow-flattened function proxies through', () => {
  it('is named for what it holds when it holds one helper', async () => {
    const out = await expectPreserved(
      `
        function hi(_0x4b21ca) {
          const _0xa7728a = { UcfbR: function (_0x5a9ca0, _0x56527a) { return _0x5a9ca0 < _0x56527a; } };
          return _0xa7728a.UcfbR(_0x4b21ca, 3) ? 'low' : 'high';
        }
        log(hi(1), hi(9));
      `,
      ['low high'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/helpers\.UcfbR/);
      expect(has(code, '_0xa7728a')).toBe(false);
    }
  });
});

describe('a function that is one operation', () => {
  it('names its operands by side, through the block flattening leaves around them', async () => {
    // The body is `{ { return a ^ b; } }` at the time this layer runs -
    // `finalize.tidy` unwraps the inner block after it - so a rule that reads
    // the body has to look through it.
    const out = await expectPreserved(
      `
        const helpers = {
          dBFli: function (_0x270e0b, _0x20310f) { { return _0x270e0b ^ _0x20310f; } }
        };
        log(helpers.dBFli(12, 10));
      `,
      ['6'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/function \(left, right\)/);
      expect(has(code, '_0x270e0b')).toBe(false);
    }
  });

  it('leaves the parameters of a callback to the call that fills them', async () => {
    const out = await expectPreserved(
      `
        var users = ['a', 'b'];
        log(users.map(function (_0x5c11aa, _0x6d22bb) { return _0x5c11aa + _0x6d22bb; }).join(','));
      `,
      ['a0,b1'],
    );
    expect(out.balanced).toMatch(/function \(user, index\)/);
  });
});

describe('a class with nothing to name it after', () => {
  it('falls back to a class-shaped name rather than a function-shaped one', async () => {
    // `new fn1(...)` told the reader the wrong thing about the one shape in the
    // language where the distinction is visible.
    const out = await expectPreserved(
      `
        class _0x31cd90 { constructor() { this.k = 1; } }
        log(new _0x31cd90().k);
      `,
      ['1'],
    );
    expect(out.aggressive).toMatch(/class cls1/);
    expect(has(out.aggressive, 'fn1')).toBe(false);
  });
});

describe('a method only a list answers to with a callback', () => {
  it('names the value for its elements', async () => {
    // Before: `obj2 => obj2.map(...)` at aggressive, `_0x51ba0e` at balanced -
    // one `.map` is not two hits of B11's signature.
    const out = await expectPreserved(
      `
        function _0x3d81cc(_0x51ba0e) { return _0x51ba0e.map(function (n) { return n * 2; }).join(','); }
        const _0x6e21f0 = _0x2b9c11 => _0x2b9c11.reduce((total, n) => total + n, 0);
        log(_0x3d81cc([1, 2]), _0x6e21f0([3, 4]));
      `,
      ['2,4 7'],
    );
    for (const code of [out.balanced, out.aggressive]) {
      expect(code).toMatch(/\(items\) \{/);
      expect(code).toMatch(/items => items\.reduce/);
      expect(has(code, '_0x51ba0e')).toBe(false);
      expect(has(code, '_0x2b9c11')).toBe(false);
    }
  });

  it('refuses a find that takes a query, and a map that is read rather than called', async () => {
    const out = await expectPreserved(
      `
        function _0x3d81cc(_0x51ba0e, _0x7c22aa) { return _0x51ba0e.find({ id: 1 }).name + _0x7c22aa.map.size; }
        log(_0x3d81cc({ find: function (q) { return { name: 'n' + q.id }; } }, { map: new Map([[1, 1]]) }));
      `,
      ['n11'],
    );
    expect(has(out.balanced, 'items')).toBe(false);
    expect(has(out.aggressive, 'items')).toBe(false);
  });
});

describe('the names this evidence produces are a fixed point', () => {
  it('renames nothing on a second pass over its own output', async () => {
    const source = `
      function _0x3d81cc(_0x51ba0e) {
        let _0x22cd41 = '';
        for (const _0x7bd192 of _0x51ba0e) _0x22cd41 += _0x7bd192.toUpperCase();
        return 'v: ' + _0x22cd41;
      }
      log(_0x3d81cc(['a', 'b']));
    `;
    const expected = ['v: AB'];
    const out = await expectPreserved(source, expected);
    for (const options of PRESETS) {
      const second = await runPass(pass, out[options.preset as keyof Outputs], options);
      expect(second.changes, options.preset).toBe(0);
      expect(observe(second.code), options.preset).toEqual(expected);
    }
  });
});
