import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyze.js';

/**
 * `analyze()` is the entry point a UI calls while the user is still typing,
 * which makes it the one most likely to be handed an `undefined` or `null`
 * mid-wiring. It used to fail with `code.slice is not a function` from inside
 * the parse-failure constructor - a message about engine internals for a
 * caller's mistake - where `deobfuscate()` already says what it expected.
 */
describe('analyze() argument guard', () => {
  it('names the caller error for a non-string source', () => {
    for (const bad of [123, null, undefined, { code: 'x' }, ['x'], true]) {
      expect(() => analyze(bad as never)).toThrow(/^analyze\(\) expects the source as a string, received /);
    }
    expect(() => analyze(123 as never)).toThrow(/received 123/);
    expect(() => analyze(null as never)).toThrow(/received null/);
    // The same describer `deobfuscate()` and `parseSource()` use, so the three
    // entry points spell a wrong argument the same way: a private copy here
    // said "received a object".
    expect(() => analyze({ code: 'x' } as never)).toThrow(/received an object\./);
    expect(() => analyze(['x'] as never)).toThrow(/received an array\./);
  });

  it('treats a null options bag as no options', () => {
    const result = analyze('var a = 1;', null as never);
    expect(result.language).toBe('js');
    expect(result.lines).toBe(1);
  });
});
