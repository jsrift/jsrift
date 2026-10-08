import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { expectNoChange, normalize, runPass } from './helpers.js';

/**
 * ToPrimitive is program code.
 *
 * `-x`, `x + y`, `x < y` and `` `${x}` `` are not reads. On an object operand
 * each one calls `valueOf` or `toString`, which the program wrote and which can
 * call anything. So an argument the expansion discards, a surplus argument, and
 * an unread initialiser can only be dropped when no operand of a coercing
 * operator can be an object.
 *
 * The three cases below are the observed defect: the wrapper's expansion threw
 * the argument away and `effect()` stopped running. They are written end to end
 * at the default preset, because that is where the loss was visible - the pass
 * that expands the call and the pass that deletes the declarator are different
 * passes reaching the same wrong answer.
 *
 * `src/analysis/parameters.ts` has refused these operators for the same reason
 * all along (`test/cloudflare-postpass.test.ts`, "what can run before the
 * write"); these pin the other two oracles to that answer.
 */
describe('ToPrimitive reaches user code: coercing operands are not side-effect-free', () => {
  const objectWithValueOf = `var obj = { valueOf: function () { effect(); return 2; } };`;

  it('keeps `-obj` as a discarded argument: ToNumber calls valueOf', async () => {
    const { code } = await deobfuscate(
      `function w(a) { return 1; }\n${objectWithValueOf}\nsink(w(-obj));`,
      { preset: 'balanced' },
    );
    expect(code).toContain('-obj');
    expect(code).toContain('effect()');
  });

  it('keeps `obj + 1` as a discarded argument: ToPrimitive calls valueOf', async () => {
    const { code } = await deobfuscate(
      `function w(a) { return 1; }\n${objectWithValueOf}\nsink(w(obj + 1));`,
      { preset: 'balanced' },
    );
    expect(code).toContain('obj + 1');
    expect(code).toContain('effect()');
  });

  it('keeps an unread `${obj}` initialiser: ToString calls toString', async () => {
    const { code } = await deobfuscate(
      "var obj2 = { toString: function () { effect(); return 'x'; } };\nvar t = `${obj2}`;",
      { preset: 'balanced' },
    );
    // The name `t` is dead and may go; the coercion it performed may not.
    expect(code).toContain('${obj2}');
    expect(code).toContain('effect()');
  });

  // -------------------------------------------------------------------------
  // The same three, per pass, so a failure names the oracle that is wrong.
  // -------------------------------------------------------------------------

  it('simplify.proxy-functions refuses to discard a coercing argument', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      `function w(a) { return 1; }\n${objectWithValueOf}\nsink(w(-obj));`,
    );
  });

  it('simplify.proxy-functions refuses to discard a coercing surplus argument', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      `function w() { return 1; }\n${objectWithValueOf}\nsink(w(obj + 1));`,
    );
  });

  it('clean.unused keeps the coercion when it drops the name it fed', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      "var obj2 = { toString: function () { effect(); return 'x'; } };\nvar t = `${obj2}`;",
    );
    expect(code).toContain('${obj2}');
  });

  it('clean.unused refuses an unread initialiser that coerces a parameter', async () => {
    // `o` is whatever the caller passed, so `o * 2` can be a call to `valueOf`.
    const { code } = await runPass(
      removeUnusedPass,
      'function f(o) { var dead = o * 2; return 1; }\nuse(f);',
    );
    expect(code).toContain('o * 2');
  });

  it('clean.unused refuses an unread computed key, which is ToPropertyKey', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      `${objectWithValueOf}\nvar dead = { [obj]: 1 };`,
    );
    expect(code).toContain('[obj]');
  });

  // -------------------------------------------------------------------------
  // The other half of the rule: refuse only where primitiveness is unproven.
  // A blanket refusal would pass every test above and cost real removals.
  // -------------------------------------------------------------------------

  it('still discards `-n` where `n` is a binding whose only assignment is a literal', async () => {
    const { code } = await runPass(
      inlineProxyFunctionsPass,
      'function w(a) { return 1; }\nvar n = 2;\nsink(w(-n));',
    );
    expect(normalize(code)).toContain('sink(1)');
  });

  it('still discards an unread initialiser built from such a binding', async () => {
    const { code } = await runPass(removeUnusedPass, 'var n = 4;\nvar dead = n * 2;\nuse(n);', { sourceType: 'module' });
    expect(code).not.toContain('dead');
    expect(code).not.toContain('n * 2');
  });

  it('still discards `!o`, `typeof o` and `void o`, none of which coerce', async () => {
    for (const argument of ['!obj', 'typeof obj', 'void obj']) {
      const { code } = await runPass(
        inlineProxyFunctionsPass,
        `function w(a) { return 1; }\n${objectWithValueOf}\nsink(w(${argument}));`,
      );
      expect(normalize(code), argument).toContain('sink(1)');
    }
  });

  it('still discards `x === y`, the comparison that does not convert', async () => {
    const { code } = await runPass(
      inlineProxyFunctionsPass,
      'function w(a) { return 1; }\nvar x = {}, y = {};\nsink(w(x === y));',
    );
    expect(normalize(code)).toContain('sink(1)');
  });

  it('still discards a template whose substitution is a proven primitive', async () => {
    const { code } = await runPass(removeUnusedPass, 'var n = 4;\nvar dead = `${n}`;\nuse(n);', { sourceType: 'module' });
    expect(code).not.toContain('dead');
    expect(code).not.toContain('${n}');
  });
});
