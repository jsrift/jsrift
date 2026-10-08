import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * `X.name` reads a string out of a *function or class object*, not out of the
 * variable the member expression happened to name. These tests hold the layer
 * to that distinction: the observable string has to survive renaming, and the
 * bindings that do not carry it have to stay renameable.
 *
 * Every case is an execution comparison rather than a spelling assertion, so a
 * future implementation that freezes a different (but still correct) set of
 * identifiers keeps passing.
 */

const aggressive: DeobfuscateOptions = { preset: 'aggressive' };

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ LOG: (value: unknown) => logs.push(String(value)) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

async function expectPreserved(source: string, options: DeobfuscateOptions = aggressive) {
  const { code } = await runPass(pass, source, options);
  expect(observe(code)).toEqual(observe(source));
  return code;
}

describe('reflected names reached through an alias', () => {
  it('keeps the declaration name when only an alias is reflected', async () => {
    // The alias holds the same function object, so `.name` on it reads the
    // declaration's spelling. Matching a literal `<binding>.name` misses this.
    const source = `
      function _0x4a68() { return 1; }
      var _0xALIAS = _0x4a68;
      LOG(_0xALIAS.name);
    `;
    expect(observe(source)).toEqual(['_0x4a68']);
    const code = await expectPreserved(source);
    expect(code).toContain('_0x4a68');
  });

  it('follows an alias created by assignment rather than by initialiser', async () => {
    const source = `
      function _0x4a68() { return 1; }
      var _0x1111;
      _0x1111 = _0x4a68;
      LOG(_0x1111.name);
    `;
    expect(observe(source)).toEqual(['_0x4a68']);
    await expectPreserved(source);
  });

  it('follows a chain of aliases', async () => {
    const source = `
      function _0x4a68() { return 1; }
      var _0x1111 = _0x4a68, _0x2222 = _0x1111, _0x3333 = _0x2222;
      LOG(_0x3333.name);
    `;
    expect(observe(source)).toEqual(['_0x4a68']);
    await expectPreserved(source);
  });

  it('keeps a reflected class declaration reached through an alias', async () => {
    const source = `
      class _0x4a68 { }
      var _0x1111 = _0x4a68;
      LOG(_0x1111.name);
    `;
    expect(observe(source)).toEqual(['_0x4a68']);
    await expectPreserved(source);
  });

  it('terminates on a cyclic alias', async () => {
    // `_0x1111` is initialised from a `var` declared after it, so both are
    // undefined at that point; the walk must not chase the cycle forever.
    const source = `
      var _0x1111 = _0x2222, _0x2222 = _0x1111;
      LOG(typeof _0x1111);
    `;
    await expectPreserved(source);
  });
});

describe('reflected names living on a named function or class expression', () => {
  it('freezes the inner id of a reflected declarator, not just the variable', async () => {
    // `.name` here is `_0x9999`, and `_0x9999` is a binding this layer renames.
    // Exempting the declarator alone moved the hazard instead of removing it.
    const source = `
      var _0x1b2c = function _0x9999() { return 1; };
      LOG(_0x1b2c.name);
    `;
    expect(observe(source)).toEqual(['_0x9999']);
    const code = await expectPreserved(source);
    expect(code).toContain('_0x9999');
  });

  it('freezes the inner id of a reflected named class expression', async () => {
    const source = `
      var _0x1b2c = class _0x9999 { };
      LOG(_0x1b2c.name);
    `;
    expect(observe(source)).toEqual(['_0x9999']);
    await expectPreserved(source);
  });

  it('freezes the inner id when the reflection goes through an alias', async () => {
    const source = `
      var _0x1b2c = function _0x9999() { return 1; };
      var _0x2222 = _0x1b2c;
      LOG(_0x2222.name);
    `;
    expect(observe(source)).toEqual(['_0x9999']);
    await expectPreserved(source);
  });

  it('still renames the variable, which carries none of the observable string', async () => {
    // The inner id is what `.name` reads, so freezing the declarator too would
    // be a rename given away for nothing.
    const source = `
      var _0x1b2c = function _0x9999() { return 1; };
      LOG(_0x1b2c.name);
    `;
    const { code } = await runPass(pass, source, aggressive);
    expect(code).not.toContain('_0x1b2c');
  });
});

describe('reflection freezing stays narrow', () => {
  it('leaves an unreflected alias graph fully renameable', async () => {
    const source = `
      function _0x4a68() { return 1; }
      var _0x1111 = _0x4a68;
      LOG(_0x1111());
    `;
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(observe(source));
    expect(code).not.toContain('_0x4a68');
    expect(code).not.toContain('_0x1111');
  });

  it('does not freeze an alias whose value is not a function or class', async () => {
    const source = `
      var _0x1111 = { name: 'literal' };
      var _0x2222 = _0x1111;
      LOG(_0x2222.name);
    `;
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(observe(source));
    expect(code).not.toContain('_0x1111');
  });

  it('keeps freezing a declarator that takes its name by named evaluation', async () => {
    const source = `
      var _0x1b2c = function () { return 1; };
      LOG(_0x1b2c.name);
    `;
    expect(observe(source)).toEqual(['_0x1b2c']);
    const code = await expectPreserved(source);
    expect(code).toContain('_0x1b2c');
  });
});
