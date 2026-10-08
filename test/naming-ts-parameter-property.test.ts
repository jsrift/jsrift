import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * TypeScript spells two things the naming walk reads through in JavaScript
 * form. A parameter property, `constructor(private cb)`, is `this.cb = cb`
 * on the instance, so a value handed to it is read wherever `this.cb` is; a
 * `satisfies` or an angle-bracket assertion is the expression under it, so a
 * call through one is a call on this file's own value. A `.name` read that
 * reaches a function through either is the same read as in the JavaScript
 * analog: the function keeps its name, or the drift is said.
 */

const UNFOLLOWED_NAME_READ = /reads the name of a function or class through a value that was not followed/;

describe('a parameter property holds the value the constructor was given', () => {
  const cases: [string, string][] = [
    ['private', 'class C { constructor(private cb: Function) {} run() { log(this.cb.name); } } function qq() {} new C(qq).run();'],
    ['public readonly', 'class C { constructor(public readonly cb: Function) {} run() { log(this.cb.name); } } function qq() {} new C(qq).run();'],
    ['with a default', 'class C { constructor(private cb: Function = qq) {} run() { log(this.cb.name); } } function qq() {} new C().run();'],
  ];

  for (const [title, source] of cases) {
    it(`keeps the name the instance reads: ${title}`, async () => {
      const result = await deobfuscate(source, { preset: 'aggressive', language: 'ts' });
      expect(result.code).toContain('function qq()');
      expect(result.code).toContain('.name');
    });
  }

  it('the JavaScript analog keeps it the same way', async () => {
    const source = 'class C { constructor(cb) { this.cb = cb; } run() { log(this.cb.name); } } function qq() {} new C(qq).run();';
    const result = await deobfuscate(source, { preset: 'aggressive' });
    expect(result.code).toContain('function qq()');
  });
});

describe('a call through a type-only wrapper is a call on this file\'s value', () => {
  // `qq` is let go of to a callee out of sight, and `get()` hands back a
  // value the walk cannot connect to it: what says the read may see the
  // rename is only that the call is on one of this file's own values.
  const PROGRAM =
    'const handlers = { slot: null, get() { return this.slot; } }; handlers.slot = load(); function qq() {} sink(qq); log((RECEIVER).get().name);';
  const cases: [string, string][] = [
    ['satisfies', 'handlers satisfies object'],
    ['an angle-bracket assertion', '<object>handlers'],
    ['as, the spelling already read', 'handlers as object'],
  ];

  for (const [title, receiver] of cases) {
    it(`says the name read may see a rename: ${title}`, async () => {
      const result = await deobfuscate(PROGRAM.replace('RECEIVER', receiver), { preset: 'aggressive', language: 'ts' });
      const plain = await deobfuscate(PROGRAM.replace('RECEIVER', 'handlers'), { preset: 'aggressive', language: 'ts' });
      expect(plain.code).not.toContain('function qq()');
      expect(result.code).not.toContain('function qq()');
      const said = result.metadata.diagnostics.some((d) => UNFOLLOWED_NAME_READ.test(d.message));
      const saidPlain = plain.metadata.diagnostics.some((d) => UNFOLLOWED_NAME_READ.test(d.message));
      expect(saidPlain).toBe(true);
      expect(said).toBe(true);
    });
  }
});
