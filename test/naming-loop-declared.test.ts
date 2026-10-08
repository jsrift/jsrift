import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A `var` or a function declared in a loop body is, to Babel, reassigned:
 * `scope/binding.js` files the declaration itself under `constantViolations`
 * when it sits in a loop, so the binding reads as written once, by the one
 * statement that declares it. Every walk here that asks "is this binding
 * written?" before following its value to a call - the one-level pin under a
 * catch that reads error text, the caller walk behind a parameter's `.name`
 * read - gave up on that answer, while the call was still counted as a known
 * one whose argument never escaped. Nothing widened, nothing disclosed, and
 * the output printed `fn:val1` where the input printed `fn:_0x96d6`.
 *
 * The declaration is not a write. Each case below runs input and output in a
 * vm with only `log`, at all three presets, and compares what they print;
 * before the declaration was filtered out, every one of them drifted at
 * aggressive, and the JSON case at balanced too.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

const WARNING = /error text/;

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

async function run(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, options);
  const warned = ctx.diagnostics.filter((note) => WARNING.test(note.message));
  return { code, renames: ctx.renames.map((entry) => entry.from), warned, printed: observe(code) };
}

/**
 * Input and output print the same thing at every preset, and the bindings
 * named are never renamed; returns the aggressive result.
 */
async function expectPinned(source: string, expected: string[], pinned: string[]) {
  expect(observe(source)).toEqual(expected);
  let last;
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(result.printed, options.preset).toEqual(expected);
    for (const name of pinned) expect(result.renames, `${options.preset} renamed ${name}`).not.toContain(name);
    last = result;
  }
  return last!;
}

describe('a function declared in a loop body is followed into by the error-text pin', () => {
  it('a function declaration in a for loop', async () => {
    // Before: aggressive printed `Cannot access 'val1' before initialization`.
    await expectPinned(
      `
        for (var i = 0; i < 1; i++) {
          function _0x2b2b() { return _0x1c1c; }
          try { _0x2b2b(); } catch (e) { log(e.message); }
        }
        let _0x1c1c = 1;
      `,
      ["Cannot access '_0x1c1c' before initialization"],
      ['_0x1c1c'],
    );
  });

  it('a var function in a while loop', async () => {
    // Before: aggressive printed `fn1 is not a function`.
    await expectPinned(
      `
        var n = 0;
        while (n++ < 1) {
          var _0x3c3c = function () { return _0x4d4d(); };
          try { _0x3c3c(); } catch (e) { log(e.message); }
        }
        var _0x4d4d = 2;
      `,
      ['_0x4d4d is not a function'],
      ['_0x4d4d'],
    );
  });

  it('a function declaration in a do-while loop', async () => {
    await expectPinned(
      `
        do {
          function _0x5e5e() { return _0x6f6f; }
          try { _0x5e5e(); } catch (e) { log(e.message); }
        } while (false);
        let _0x6f6f = 3;
      `,
      ["Cannot access '_0x6f6f' before initialization"],
      ['_0x6f6f'],
    );
  });

  it('a var arrow in a for-of body', async () => {
    await expectPinned(
      `
        for (var item of [1]) {
          var _0x7a7a = () => _0x8b8b();
          try { _0x7a7a(); } catch (e) { log(e.message); }
        }
        var _0x8b8b = 4;
      `,
      ['_0x8b8b is not a function'],
      ['_0x8b8b'],
    );
  });

  it('a var function declared in the loop and called after it', async () => {
    await expectPinned(
      `
        for (var i = 0; i < 1; i++) {
          var _0x9c9c = function () { return _0xb0b0; };
        }
        try { _0x9c9c(); } catch (e) { log(e.message); }
        let _0xb0b0 = 5;
      `,
      ["Cannot access '_0xb0b0' before initialization"],
      ['_0xb0b0'],
    );
  });

  it('a rule with evidence is refused the same as the fallback: balanced named this `data`', async () => {
    await expectPinned(
      `
        for (var i = 0; i < 1; i++) {
          function _0x2b2b() { return _0x3ebf; }
          try { _0x2b2b(); } catch (e) { log(e.message); }
        }
        let _0x3ebf = JSON.parse('{"a":1}');
        log(typeof _0x3ebf);
      `,
      ["Cannot access '_0x3ebf' before initialization", 'object'],
      ['_0x3ebf'],
    );
  });

  it('a second declarator of the same var is still a write the pin cannot follow', async () => {
    // The loop declaration is filtered; the redeclaration below the loop is
    // not, and the walk gives up as it did before. That is the disclosed
    // drift, and this holds it to one warning at aggressive.
    const source = `
      for (var i = 0; i < 1; i++) {
        var _0x3c3c = function () { return _0x4d4d(); };
      }
      var _0x3c3c = function () { return _0x4d4d(); };
      try { _0x3c3c(); } catch (e) { log(e.message); }
      var _0x4d4d = 2;
    `;
    expect(observe(source)).toEqual(['_0x4d4d is not a function']);
    const aggressive = await run(source, { preset: 'aggressive' });
    expect(aggressive.printed).toHaveLength(1);
    expect(aggressive.printed[0]).toMatch(/^\w+ is not a function$/);
    expect(aggressive.warned).toHaveLength(1);
  });
});

describe('a function declared in a loop body is followed into by the parameter walk', () => {
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

  it('a function-expression argument to a declaration in a for loop', async () => {
    // The fuzz survivor: aggressive printed `fn:val1`.
    const code = await expectPreserved(
      `
        for (var i = 0; i < 1; i++) {
          function _0xc(v) { var n = v.name; return 'fn:' + n; }
          log(_0xc(function _0x96d6() {}));
        }
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('_0x96d6');
  });

  it('a class-expression argument to a var function in a while loop', async () => {
    const code = await expectPreserved(
      `
        var n = 0;
        while (n++ < 1) {
          var _0xd = function (v) { return 'cls:' + v.name; };
          log(_0xd(class _0xa1a1 {}));
        }
      `,
      ['cls:_0xa1a1'],
    );
    expect(code).toContain('_0xa1a1');
  });

  it('a declaration in a do-while, called after the loop', async () => {
    const code = await expectPreserved(
      `
        do {
          var _0xe = (v) => v.name;
        } while (false);
        log(_0xe(function _0xb2b2() {}));
      `,
      ['_0xb2b2'],
    );
    expect(code).toContain('_0xb2b2');
  });

  it('a declaration in a for-of body, handed to a known callee', async () => {
    const code = await expectPreserved(
      `
        for (var item of [1]) {
          function _0xf(v) { return v.name; }
          function _0xg(cb) { return cb(function _0xc3c3() {}); }
          log(_0xg(_0xf));
        }
      `,
      ['_0xc3c3'],
    );
    expect(code).toContain('_0xc3c3');
  });

  it('a function the loop body never hands anywhere is still renamed', async () => {
    // The callers are in sight now, so the read widens to nothing: a value
    // the loop only `typeof`s carries no spelling anyone reads.
    const source = `
      for (var i = 0; i < 1; i++) {
        function _0xc(v) { var n = v.name; return 'fn:' + n; }
        var _0x4444 = function () {};
        log(_0xc(function _0x96d6() {}), typeof _0x4444);
      }
    `;
    const code = await expectPreserved(source, ['fn:_0x96d6 function']);
    expect(code).not.toContain('_0x4444');
  });
});
