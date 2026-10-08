import { describe, expect, it } from 'vitest';
import { functionConstructorPass } from '../src/passes/unpack/function-constructor.js';
import {
  assertParses,
  expectEquivalent,
  expectIdempotent,
  expectNoChange,
  runPass,
} from './helpers.js';

/**
 * The `Function` constructor as a packer.
 *
 * Handing a whole program to `Function` as a string leaves a file that parses
 * as one call over two string literals - nothing for any later pass to work on
 * until the string is put back in the tree as the code it already is.
 */
describe('unpack/function-constructor', () => {
  it('rewrites a constructed function as the function expression it builds', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `var add = Function("a,b", "return a + b;");`,
    );
    expect(changes).toBe(1);
    expectEquivalent(code, `var add = function (a, b) { return a + b; };`);
    assertParses(code);
  });

  it('treats `new Function` the same as calling it', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `var f = new Function("x", "return x * 2;");`,
    );
    expect(changes).toBe(1);
    expectEquivalent(code, `var f = function (x) { return x * 2; };`);
  });

  it('joins parameters supplied as separate arguments', async () => {
    const { code } = await runPass(
      functionConstructorPass,
      `var f = Function("a", "b", "return a + b;");`,
    );
    expectEquivalent(code, `var f = function (a, b) { return a + b; };`);
  });

  it('handles a body with no parameters at all', async () => {
    const { code } = await runPass(functionConstructorPass, `var f = Function("return 1;");`);
    expectEquivalent(code, `var f = function () { return 1; };`);
  });

  it('opens the real-world shape: a wrapper invoked with its host bindings', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `Function("host", "host.log('hi');")({ log: console.log });`,
    );
    expect(changes).toBe(1);
    expectEquivalent(
      code,
      `(function (host) { host.log('hi'); })({ log: console.log });`,
    );
    assertParses(code);
  });

  it('opens wrappers nested inside one another', async () => {
    const inner = `Function("return 41 + 1;")`;
    const { code, changes } = await runPass(
      functionConstructorPass,
      `var f = Function("return (${inner.replace(/"/g, '\\"')})();");`,
    );
    expect(changes).toBeGreaterThanOrEqual(1);
    // Both layers are gone: no `Function(` call survives anywhere in the output.
    expect(/\bFunction\s*\(/.test(code)).toBe(false);
    assertParses(code);
  });

  it("keeps 'use strict' in the body's directive prologue", async () => {
    const { code } = await runPass(
      functionConstructorPass,
      `var f = Function("'use strict'; return this;");`,
    );
    expect(code).toContain('use strict');
    assertParses(code);
  });

  it('reports the wrapper as a packed shape', async () => {
    const { ctx } = await runPass(functionConstructorPass, `Function("x", "return x;");`);
    expect(ctx.detections.some((d) => d.evidence.startsWith('Function constructor'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Refusals. Each of these would produce a tree that does not describe what
  // the constructor actually builds.
  // -------------------------------------------------------------------------

  it('leaves a call whose body is not statically known', async () => {
    await expectNoChange(functionConstructorPass, `var f = Function("a", bodyFromSomewhere);`);
  });

  it('leaves a locally bound `Function` alone', async () => {
    await expectNoChange(
      functionConstructorPass,
      `function run(Function) { return Function("a", "return a;"); }`,
    );
  });

  it('refuses parameter text that breaks out of the parameter list', async () => {
    const source = `var f = Function("a) {} ; leaked(); (function (b", "return b;");`;
    const { changes, ctx } = await runPass(functionConstructorPass, source);
    expect(changes).toBe(0);
    expect(ctx.diagnostics.length).toBeGreaterThan(0);
  });

  /**
   * The same attempt, balanced so that it parses. It yields a sequence
   * expression rather than a function, which is the guard that catches
   * injected parameter text the parser is happy with.
   */
  it('refuses parameter text that parses as something other than one function', async () => {
    const source = `var f = Function("a) {}, leaked(), function (b", "return b;");`;
    const { changes, ctx } = await runPass(functionConstructorPass, source);
    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('single function'))).toBe(true);
  });

  it('leaves a body that is not valid JavaScript', async () => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `var f = Function("a", "return a +;");`,
    );
    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('not valid JavaScript'))).toBe(true);
  });

  /**
   * The one case where the rewrite changes meaning: a constructed function
   * resolves free names globally, so a local binding of the same name must not
   * be allowed to capture them silently.
   */
  it('warns when the rewrite lands inside a scope that binds a name the body reads', async () => {
    const { ctx } = await runPass(
      functionConstructorPass,
      `function outer() { var secret = 1; return Function("return secret;"); }`,
    );
    expect(ctx.diagnostics.some((d) => d.message.includes('secret'))).toBe(true);
  });

  it('does nothing when moduleUnwrapping is turned off', async () => {
    await expectNoChange(functionConstructorPass, `var f = Function("a", "return a;");`, {
      techniques: { moduleUnwrapping: false },
    });
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      functionConstructorPass,
      `Function("host", "host.log('hi');")({ log: console.log });`,
    );
  });
});

/**
 * Which callees are the global `Function` constructor.
 *
 * The rewrite deletes the call, so accepting a callee that is not the global
 * constructor does not merely leave the output uglier - the real callee never
 * runs, and whatever it returned is replaced by an unrelated function. The
 * member form therefore has to prove the object is the global object, not just
 * that the property is spelled `Function`.
 */
describe('unpack/function-constructor: callee must be the global constructor', () => {
  it('leaves `lib.Function(...)` alone - it is a property, not the constructor', async () => {
    const source = [
      `var lib = { Function: function (p, b) { return register(p, b); } };`,
      `sink(lib.Function('a', 'return a + 1'));`,
    ].join('\n');

    await expectNoChange(functionConstructorPass, source);

    // Stated positively: the call that would have been deleted is still there.
    const { code } = await runPass(functionConstructorPass, source);
    expect(code).toContain(`lib.Function('a', 'return a + 1')`);
  });

  it('still accepts `globalThis.Function(...)`', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `var f = globalThis.Function("a", "return a + 1;");`,
    );
    expect(changes).toBe(1);
    expectEquivalent(code, `var f = function (a) { return a + 1; };`);
    assertParses(code);
  });

  it.each(['window', 'self', 'global'])('still accepts `%s.Function(...)`', async (name) => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `var f = ${name}.Function("a", "return a + 1;");`,
    );
    expect(changes).toBe(1);
    expectEquivalent(code, `var f = function (a) { return a + 1; };`);
  });

  /**
   * The wrapper shape `(function (window) { ... })(env)` is common enough that
   * the global names cannot be trusted on spelling alone.
   */
  it('refuses a `window` that a local binding has taken over', async () => {
    await expectNoChange(
      functionConstructorPass,
      `function run(window) { return window.Function("a", "return a + 1;"); }`,
    );
  });

  it('refuses every other object in the member position', async () => {
    for (const callee of ['this.Function', 'a.b.Function', 'globalThis.x.Function']) {
      await expectNoChange(functionConstructorPass, `sink(${callee}("a", "return a + 1;"));`);
    }
  });

  /**
   * Refused rather than resolved: nothing this pass recognises needs it, and a
   * computed key is one more thing that would have to be proven.
   */
  it('refuses the computed form `window["Function"]`', async () => {
    await expectNoChange(
      functionConstructorPass,
      `var f = window["Function"]("a", "return a + 1;");`,
    );
  });
});
