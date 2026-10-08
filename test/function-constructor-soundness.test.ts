import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { functionConstructorPass } from '../src/passes/unpack/function-constructor.js';
import { assertParses, runPass } from './helpers.js';

/**
 * The two ways `Function("...")` -> `function () {...}` stops being the same program.
 *
 * The constructor does not build the function where the call sits. It compiles
 * the body as a fresh top-level function, so the result takes nothing from its
 * caller: not the caller's bindings, and not the caller's strictness. A function
 * expression spliced into the call's position takes both. Where those two facts
 * disagree the rewrite produces output that parses, runs, and computes something
 * else - which is the failure mode worth the most test surface, because nothing
 * about the output looks wrong.
 *
 * Every claim here about what a program *does* is executed rather than asserted,
 * and the pass runs in isolation so that a divergence indicts this pass and not
 * some later one operating on its output.
 */

/** Run in a fresh realm and capture what the program makes observable. */
function execute(code: string, extraGlobals: Record<string, unknown> = {}): string {
  const trace: string[] = [];
  const sandbox: Record<string, unknown> = {
    log: (...args: unknown[]) => trace.push(args.map((a) => String(a)).join(' ')),
    ...extraGlobals,
  };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    // The *kind* of failure is observable behaviour too.
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join('\n');
}

/**
 * The pass must not change what the program does.
 *
 * Returns the output so a caller can additionally pin down *how* it was kept
 * equivalent - leaving the call alone and rewriting it into something that
 * happens to agree are both "equivalent", and they are not the same result.
 */
async function expectSameBehaviour(
  source: string,
  extraGlobals: Record<string, unknown> = {},
): Promise<string> {
  const before = execute(source, extraGlobals);
  const { code } = await runPass(functionConstructorPass, source);
  const after = execute(code, extraGlobals);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input  ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
  return code;
}

const stillThere = (code: string): boolean => /\bFunction\s*\(/.test(code);

// ---------------------------------------------------------------------------
// Strictness
// ---------------------------------------------------------------------------

/**
 * A constructed function is non-strict unless its own body opts in, whatever
 * the strictness of the code that called `Function`. The replacement inherits
 * its host's strictness instead, and a strict function is a different function.
 */
describe('unpack/function-constructor: strictness is not inherited from the call site', () => {
  it('refuses inside strict code when the body does not opt in', async () => {
    const { code, changes, ctx } = await runPass(
      functionConstructorPass,
      `'use strict'; var f = Function('return typeof this'); log(f.call(5));`,
    );

    expect(changes).toBe(0);
    expect(stillThere(code)).toBe(true);
    expect(ctx.diagnostics.some((d) => d.message.includes('strict code'))).toBe(true);
  });

  /** The behaviour that refusal protects: `this` is boxed only when sloppy. */
  it('keeps `this` boxed in a strict host', async () => {
    const code = await expectSameBehaviour(
      `'use strict'; var f = Function('return typeof this'); log(f.call(5));`,
    );
    // Pinned: 'object' is the sloppy answer, and it is the input's answer.
    expect(execute(code)).toBe('object');
  });

  /**
   * The global-object idiom, and the reason this guard exists at all.
   * `fixtures/obfuscated3.js` ends a `globalThis`/`global`/`window` lookup chain
   * with exactly this, because a sloppy function called with no receiver gets
   * the global object substituted for `this`. Made strict, it returns undefined
   * and the chain's universal fallback quietly stops working.
   */
  it('preserves `new Function("return this")()` as a global-object lookup', async () => {
    const source = [
      `'use strict';`,
      `var globalOf = function () { return new Function("return this")(); };`,
      `log(globalOf() === globalThis);`,
    ].join('\n');

    const code = await expectSameBehaviour(source);
    expect(execute(code)).toBe('true');
    expect(stillThere(code)).toBe(true);
  });

  it('refuses inside a class body, which is strict without any directive', async () => {
    const { changes, code, ctx } = await runPass(
      functionConstructorPass,
      `class C { m() { return Function('return typeof this'); } }`,
    );

    expect(changes).toBe(0);
    expect(stillThere(code)).toBe(true);
    expect(ctx.diagnostics.some((d) => d.message.includes('strict code'))).toBe(true);
  });

  it('refuses in a module, where every function is strict', async () => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `export var f = Function('return typeof this');`,
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('strict code'))).toBe(true);
  });

  it('refuses in a strict function nested in a sloppy program', async () => {
    const { changes } = await runPass(
      functionConstructorPass,
      `function outer() { 'use strict'; return Function('return typeof this'); }`,
    );
    expect(changes).toBe(0);
  });

  // -- The other side of the guard: it must not refuse what it can prove. ----

  it('still rewrites when the body opts into strict mode itself', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `'use strict'; var f = Function("'use strict'; return typeof this"); log(f.call(5));`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
    await expectSameBehaviour(
      `'use strict'; var f = Function("'use strict'; return typeof this"); log(f.call(5));`,
    );
    assertParses(code);
  });

  it('still rewrites in a sloppy host, where both sides are sloppy', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `var f = Function('return typeof this'); log(f.call(5));`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
    expect(execute(code)).toBe('object');
  });

  /**
   * Sloppiness is observable well beyond `this`: assigning to an undeclared
   * name creates a global rather than throwing.
   */
  it('refuses rather than turning an implicit global into a TypeError', async () => {
    const source = [
      `'use strict';`,
      `var set = Function('undeclared = 7; return undeclared;');`,
      `try { log(set()); } catch (e) { log('THREW ' + e.name); }`,
    ].join('\n');

    const code = await expectSameBehaviour(source);
    expect(execute(code)).toBe('7');
    expect(stillThere(code)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * A constructed function resolves free names against the global scope. The
 * replacement resolves them where it sits, so anything bound in between
 * captures them.
 */
describe('unpack/function-constructor: free names resolve globally, not locally', () => {
  it('refuses when a local binding would capture a name the body reads', async () => {
    const { code, changes, ctx } = await runPass(
      functionConstructorPass,
      `function f() { var x = 'local'; return Function('return x')(); }`,
    );

    expect(changes).toBe(0);
    expect(stillThere(code)).toBe(true);
    expect(ctx.diagnostics.some((d) => d.message.includes('x'))).toBe(true);
  });

  it('keeps reading the global rather than the shadowing local', async () => {
    const source = [
      `var x = 'global';`,
      `function f() { var x = 'local'; return Function('return x')(); }`,
      `log(f());`,
    ].join('\n');

    const code = await expectSameBehaviour(source);
    expect(execute(code)).toBe('global');
    expect(stillThere(code)).toBe(true);
  });

  /** A parameter shadows just as effectively as a `var`. */
  it('counts parameters of the enclosing function', async () => {
    const source = [
      `var mode = 'global';`,
      `function f(mode) { return Function('return mode')(); }`,
      `log(f('argument'));`,
    ].join('\n');

    const code = await expectSameBehaviour(source);
    expect(execute(code)).toBe('global');
    expect(stillThere(code)).toBe(true);
  });

  /** Block scopes count too - `let` in a block binds for anything inside it. */
  it('counts a block-scoped binding between the call and the program', async () => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `function f() { { let hidden = 1; return Function('return hidden')(); } }`,
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('hidden'))).toBe(true);
  });

  /**
   * A module's top level is not the global scope, so its bindings do diverge.
   * Reaching this check at all in a module needs a body that opts into strict
   * mode, since otherwise the strictness guard turns the wrapper away first.
   */
  it("counts a module's top-level bindings", async () => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      [
        `export var secret = 1;`,
        `function f() { return Function("'use strict'; return secret;"); }`,
      ].join('\n'),
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('secret'))).toBe(true);
  });

  // -- The other side of the guard. ------------------------------------------

  /**
   * A script's top-level scope *is* part of the global scope - for `let` and
   * `class` as much as for `var` - so a body reading a top-level name of a
   * script reaches the same binding either way. Refusing on those would cost
   * real rewrites for nothing, so the guard stops at the program scope.
   */
  it('does not count a script top-level `var` the body reads', async () => {
    const source = [
      `var shared = 'top';`,
      `function f() { return Function('return shared')(); }`,
      `log(f());`,
    ].join('\n');

    const { code, changes } = await runPass(functionConstructorPass, source);
    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
    await expectSameBehaviour(source);
    expect(execute(code)).toBe('top');
  });

  it('does not count a script top-level `let` the body reads', async () => {
    const source = [
      `let shared = 'top';`,
      `function f() { return Function('return shared')(); }`,
      `log(f());`,
    ].join('\n');

    const code = await expectSameBehaviour(source);
    expect(execute(code)).toBe('top');
    expect(stillThere(code)).toBe(false);
  });

  it('does not refuse over a local the body never reads', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `function f() { var unrelated = 1; return Function('return 41 + 1')(); }`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

describe('unpack/function-constructor: a refusal leaves no trace but the diagnostic', () => {
  /**
   * Both checks have to run before the nested unpack, not after it. That
   * recursion opens inner layers on a detached tree and increments the change
   * count as it goes; refusing afterwards would discard the tree while keeping
   * the counts, leaving the pass reporting wrappers it opened into nothing.
   */
  it('reports no changes for a refused wrapper that contains another', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `'use strict'; var f = Function("return Function('return 1')();");`,
    );

    expect(changes).toBe(0);
    // The inner wrapper is still inside the outer one's string, untouched.
    expect(code).toContain(`return Function('return 1')();`);
  });

  it('still records the packed shape it recognised before refusing', async () => {
    const { ctx } = await runPass(
      functionConstructorPass,
      `'use strict'; var f = Function('return typeof this');`,
    );

    expect(ctx.detections.some((d) => d.evidence.startsWith('Function constructor'))).toBe(true);
  });

  it('leaves output that parses', async () => {
    const { code } = await runPass(
      functionConstructorPass,
      `'use strict'; function f() { var x = 1; return Function('return x'); }`,
    );
    assertParses(code);
  });
});
