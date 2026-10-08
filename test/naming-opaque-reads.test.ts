import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A computed read whose key nothing resolves is read as `.name`.
 *
 * `_0x68f7[p_s(0x86, 'd4x)')]` with the decoder refused is what a `.name`
 * read looks like, and the key often is `'name'`. Keeping such a read out
 * of the typed fallback only, on the argument that a rule which fired had
 * evidence the key was something else, leaves rule-derived renames firing -
 * `this[k]` in a static method, `super[k]`, `x.constructor[k]`, a parameter
 * whose callers hand it a function - and prints `fn4` for a class whose
 * spelling the read returned. The proof that the key is not `name` is
 * missing, so the read is refused as one would be, at every preset.
 *
 * Every table below escapes through an alias so that decoding is refused
 * and the key stays opaque when the pass runs alone; each case runs input
 * and output and compares what they print at all three presets.
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

const TABLE = `
  var tbl = ['name'];
  function get(i) { return tbl[i]; }
  var keep = tbl;
`;

describe('an opaque read is refused a rule-derived name too', () => {
  it('a function stored under a key that names it, read through the key', async () => {
    // Before: balanced and aggressive printed `circle`, from the key rule.
    const code = await expectPreserved(
      `${TABLE}
        function _0x68f7() {}
        var holder = { Circle: _0x68f7 };
        log(holder.Circle[get(0)], keep.length);
      `,
      ['_0x68f7 1'],
    );
    expect(code).toContain('function _0x68f7()');
  });

  it('this[k] in a static method reads the class', async () => {
    // Before: aggressive printed `fn1`.
    const code = await expectPreserved(
      `${TABLE}
        class _0xb8ec { static s() { return this[get(0)]; } }
        log(_0xb8ec.s(), keep.length);
      `,
      ['_0xb8ec 1'],
    );
    expect(code).toContain('class _0xb8ec');
  });

  it('super[k] in a static method reads the parent class', async () => {
    const code = await expectPreserved(
      `${TABLE}
        class _0x1ef6 {} class _0x24ea extends _0x1ef6 { static kind() { return 'k:' + super[get(0)]; } }
        log(_0x24ea.kind(), keep.length);
      `,
      ['k:_0x1ef6 1'],
    );
    expect(code).toContain('class _0x1ef6');
  });

  it('x.constructor[k] reads whichever class made x', async () => {
    const code = await expectPreserved(
      `${TABLE}
        class _0xb8ec {}
        var _0x1a33 = new _0xb8ec();
        log(_0x1a33.constructor[get(0)], keep.length);
      `,
      ['_0xb8ec 1'],
    );
    expect(code).toContain('class _0xb8ec');
  });

  it('on a parameter, reads what the visible callers pass', async () => {
    // Before: aggressive printed `fn:val1`.
    const code = await expectPreserved(
      `${TABLE}
        function classify(v) { return v instanceof Function ? 'fn:' + v[get(0)] : typeof v; }
        log(classify(function nm() {}), classify(1), keep.length);
      `,
      ['fn:nm number 1'],
    );
    expect(code).toContain('function nm()');
  });

  it('on a parameter whose callers are out of sight, widens to nothing', async () => {
    // A `.name` outright would freeze every escaped function here; the key
    // being `name` *and* the argument being one of them is two unknowns,
    // and refusing on both cost `decodeString` on obfuscated2.js.
    const code = await expectPreserved(
      `${TABLE}
        function _0x1111() { return 1; }
        function pick(o, k) { return o[k]; }
        var api = { run: _0x1111 };
        var handlers = [pick];
        log(pick(api, 'run')(), handlers.length, keep.length);
      `,
      ['1 1 1'],
    );
    expect(code).not.toContain('_0x1111');
  });

  it('a numeric key is an element read, not a property, and pins nothing', async () => {
    const code = await expectPreserved(
      `${TABLE}
        function _0x1111() { return 1; }
        var _0x2222 = [_0x1111];
        log(_0x2222[0x0](), keep.length);
      `,
      ['1 1'],
    );
    expect(code).not.toContain('_0x1111');
    expect(code).not.toContain('_0x2222');
  });
});
