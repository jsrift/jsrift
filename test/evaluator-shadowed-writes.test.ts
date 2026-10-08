import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * A write through a name that spells a builtin is the builtin's only where
 * nothing binds the name: `for (var Math = {}; ...) Math.round = 1` inside a
 * function is a local's property, and so is a parameter's, a catch
 * binding's, a `let`'s in a block. The host-write index answers by binding,
 * never by spelling, and a decoder beside such a write decodes at every
 * preset. A write to the builtin itself, and a binding of the builtin's
 * name in the decoder's own scope chain, are what they are.
 */

function execute(code: string, timeout = 5_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log, atob, btoa }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

/** A decoder over four builtins: base64, the percent step, a char code and a rounding. */
const DECODER = `var T = ['JUMzJUJDbg==', 'JUMzJUFGeA=='];\nfunction dec(i) { return decodeURIComponent(atob(T[i])) + String.fromCharCode(65) + Math.round(1.4); }\n`;

const SHADOWED: Record<string, string> = {
  'a parameter': `function f(decodeURIComponent) { decodeURIComponent.x = 1; return decodeURIComponent.x; } log(f({}), dec(0), dec(1));`,
  'an inner var': `function f() { var String = {}; String.fromCharCode = function () { return 'z'; }; return String.fromCharCode(); } log(f(), dec(0), dec(1));`,
  'a catch binding': `function f() { try { throw {}; } catch (String) { String.fromCharCode = 1; return String.fromCharCode; } } log(f(), dec(0), dec(1));`,
  'a class method parameter': `class K { m(atob) { atob.y = 2; return atob.y; } } log(new K().m({}), dec(0), dec(1));`,
  'a let in a block': `function f() { { let decodeURIComponent = {}; decodeURIComponent.z = 3; return decodeURIComponent.z; } } log(f(), dec(0), dec(1));`,
  'a var in a for head': `function f() { for (var Math = {}, i = 0; i < 1; i++) { Math.round = 1; } return Math.round; } log(f(), dec(0), dec(1));`,
  'a function declared in a function': `function g() { function String() {} String.fromCharCode = 7; return String.fromCharCode; } log(g(), dec(0), dec(1));`,
  'an arrow parameter, reassigned': `var r = [1].map((decodeURIComponent) => { decodeURIComponent = {}; decodeURIComponent.q = 1; return decodeURIComponent.q; }); log(r[0], dec(0), dec(1));`,
  'a destructured parameter': `function h({ atob }) { atob.w = 1; return atob.w; } log(h({ atob: {} }), dec(0), dec(1));`,
  'a parameter whose function replaces itself, written after `c = arguments`': `function dec2(c, d) { return (dec2 = function (f) { c = arguments; c[f + 'k'] = f; return c[f + 'k']; }), dec2(c); } log(dec2(1), dec(0), dec(1));`,
};

describe('a write through a local that spells a builtin', () => {
  for (const [what, tail] of Object.entries(SHADOWED)) {
    it(`is the local's, and the decoder beside it decodes: ${what}`, async () => {
      const source = DECODER + tail;
      const expected = execute(source);
      expect(expected).toContain('"ünA1" "ïxA1"');
      for (const preset of PRESETS) {
        const result = await deobfuscate(source, { preset });
        expect(execute(result.code), preset).toBe(expected);
        // The one write the tree cannot read the object of - `c = arguments`
        // in a function that replaces itself - is the helper policy's:
        // taken and said at balanced, refused at conservative.
        const unread = what.includes('arguments');
        if (unread && preset === 'conservative') {
          expect(result.metadata.strings, preset).toHaveLength(0);
          expect(result.metadata.diagnostics.some((d) => /the conservative preset inlines only what is proved/.test(d.message))).toBe(true);
          continue;
        }
        expect(result.metadata.strings.length, preset).toBeGreaterThanOrEqual(2);
        expect(result.code, preset).toContain("'ünA1'");
        expect(result.code, preset).not.toMatch(/\bdec\(/);
        if (!unread) {
          expect(result.metadata.diagnostics.filter((d) => /assigns to|Taking the program's assignment/.test(d.message)), preset).toEqual([]);
        }
      }
    });
  }

  it('is refused where the name is the builtin, or bound in the decoder’s own chain', async () => {
    const written = `${DECODER}String.fromCharCode = function () { return 'Q'; }; log(dec(0), dec(1));`;
    for (const preset of PRESETS) {
      // Literal simplification off: with it on, `String.fromCharCode(65)` is
      // folded to 'A' before the strings stage, and the decoder then reads no
      // `String` for the write to reach.
      const result = await deobfuscate(written, { preset, techniques: { literalSimplification: false } });
      expect(result.metadata.strings, preset).toHaveLength(0);
      expect(result.metadata.diagnostics.some((d) => /assigns to `String\.fromCharCode = ...`/.test(d.message)), preset).toBe(true);
    }
    const bound = `(function () {\n${DECODER}var atob = function () { return 'shadow'; };\nlog(dec(0), dec(1));\n})();`;
    for (const preset of PRESETS) {
      const result = await deobfuscate(bound, { preset });
      expect(execute(result.code), preset).toBe(execute(bound));
      expect(result.code, preset).not.toContain("'ünA1'");
    }
  });
});
