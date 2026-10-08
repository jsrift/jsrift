import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * `.name` read through a member chain that this file can see the far end of.
 *
 * `class Circle {} var kinds = { Circle }; log(kinds.Circle.name)` reads the
 * class's spelling, and nothing in it names the class where the read sits.
 * The aggressive preset printed `circle` for `Circle` on that shape: the class was stored under a property key, the key named it, and
 * the read went through the key. The holder is followed exactly as an alias
 * is - initialiser, assignments, stores made through it afterwards - and a
 * literal at the far end is opened by key or index. A holder this file
 * cannot see into is left as it was: that is the unknown-code boundary the
 * whole walk stops at.
 *
 * Every case runs input and output and compares what they print, at all
 * three presets. Balanced and conservative do not rename readable names, so
 * the `_0x` spellings are what exercise them.
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

describe('a .name read through a property of an object literal', () => {
  it('a class stored under a shorthand key keeps its spelling', async () => {
    // Before: aggressive printed `circle`, the class named after the key.
    const code = await expectPreserved(
      `
        class Circle {}
        var kinds = { Circle };
        log(kinds.Circle.name);
      `,
      ['Circle'],
    );
    expect(code).toContain('class Circle');
  });

  it('a class stored under another key keeps its spelling, not the key', async () => {
    // Before: aggressive printed `bar`.
    const code = await expectPreserved(
      `
        class Foo {}
        var k = { bar: Foo };
        log(k.bar.name);
      `,
      ['Foo'],
    );
    expect(code).toContain('class Foo');
  });

  it('a computed key nobody resolves reads every value the object holds', async () => {
    const code = await expectPreserved(
      `
        class Circle {} class Square {}
        var kinds = { Circle, Square };
        for (var k in kinds) log(k, kinds[k].name);
      `,
      ['Circle Circle', 'Square Square'],
    );
    expect(code).toContain('class Circle');
    expect(code).toContain('class Square');
  });

  it('a stored function keeps its spelling; the holder and the key do not', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() {}
        var _0x2222 = { _0x3333: _0x1111 };
        log(_0x2222._0x3333.name);
      `,
      ['_0x1111'],
    );
    expect(code).toContain('function _0x1111()');
    expect(code).not.toContain('_0x2222');
  });

  it('follows stores made through the holder afterwards, and array pushes', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() {} function _0x2222() {} function _0x3333() {}
        var registry = {}; registry.first = _0x1111; registry['second'] = _0x2222;
        var list = []; list.push(_0x3333);
        log(registry.first.name, registry.second.name, list[0].name);
      `,
      ['_0x1111 _0x2222 _0x3333'],
    );
    for (const name of ['_0x1111', '_0x2222', '_0x3333']) expect(code).toContain(`function ${name}()`);
  });

  it('follows a chain of members, a spread, and an alias of the holder', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() {} function _0x2222() {}
        var inner = { fn: _0x1111 };
        var outer = { ...{ deep: inner }, other: _0x2222 };
        var alias = outer;
        log(alias.deep.fn.name, alias.other.name);
      `,
      ['_0x1111 _0x2222'],
    );
    expect(code).toContain('function _0x1111()');
    expect(code).toContain('function _0x2222()');
  });

  it('ends on a holder that stores itself', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() {}
        var t = { self: null, fn: _0x1111 }; t.self = t;
        var u = t; t = u;
        log(t.self.self.fn.name, u.self.fn.name);
      `,
      ['_0x1111 _0x1111'],
    );
    expect(code).toContain('function _0x1111()');
  });

  it('reads the elements of a member that holds a list', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() {} function _0x2222() {}
        var o = { list: [_0x1111, _0x2222], all: [] };
        o.all = [...o.list];
        for (const f of o.list) log(f.name);
        log(o.all[1].name);
      `,
      ['_0x1111', '_0x2222', '_0x2222'],
    );
    expect(code).toContain('function _0x1111()');
    expect(code).toContain('function _0x2222()');
  });

  it('an element by index reads only that element', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() {} function _0x2222() {}
        var pair = [_0x1111, _0x2222];
        log(pair[1].name, typeof pair[0]);
      `,
      ['_0x2222 function'],
    );
    expect(code).toContain('function _0x2222()');
    expect(code).not.toContain('_0x1111');
  });
});

describe('a member this file cannot see into stays uncovered', () => {
  it('a property of a call result, or of this, pins nothing', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() { return 1; }
        function make() { return { fn: _0x1111 }; }
        var o = { get() { return this.fn; }, fn: _0x1111 };
        log(typeof make().fn.name, typeof o.get().name, _0x1111());
      `,
      ['string string 1'],
    );
    expect(code).not.toContain('_0x1111');
  });

  it('a method of the literal is named by its key, which no binding spells', async () => {
    const code = await expectPreserved(
      `
        function _0x1111() { return 1; }
        var o = { run() { return _0x1111(); } };
        log(o.run.name, o.run());
      `,
      ['run 1'],
    );
    expect(code).not.toContain('_0x1111');
  });
});
