import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { unwrapDiscardedArgumentsPass } from '../src/passes/simplify/discard-wrappers.js';
import { inlineObjectMapsPass } from '../src/passes/simplify/object-maps.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import type { Pass } from '../src/pipeline/pass.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * The three `simplify` passes that resolve a name to a value, against code
 * compiled from a string.
 *
 * `simplify.proxy-functions` reads a function body and substitutes it at every
 * call site, then deletes the declaration. `simplify.object-maps` reads a table
 * of literals and substitutes each key's value, then deletes the table.
 * `simplify.discard-wrappers` proves a wrapper throws its arguments away and
 * rewrites its calls into comma sequences. All three answer "what does this
 * name hold?" from `binding.path` and "who else uses it?" from
 * `binding.referencePaths` - and a program that compiles a string appears in
 * neither list, while reading and writing the same name at run time.
 *
 * Every case below is a program whose observable behaviour changed: a value
 * that came out different, a `ReferenceError` that started happening, a call
 * that stopped. That is the only check worth writing here, because a structural
 * assertion ("the wrapper is still declared") passes for the wrong reason the
 * moment some other pass rewrites the shape, and the failure being guarded
 * against is output that parses, runs and computes something else.
 *
 * One pass per run, deliberately. These hazards are shared by six passes and
 * several of them are being closed at once; running the whole pipeline would
 * let another pass's refusal cover for a missing one here, and the point of a
 * pass test is to indict the pass.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run a program in a fresh realm and return everything it made observable.
 *
 * Browser-shaped in the two ways the string-code cases need: `window` is the
 * global object, so `window.eval(src)` is a real indirect eval compiling in
 * this realm's global scope, and `setTimeout` accepts a source STRING and
 * compiles it there - which a browser does and Node's own timers do not.
 * Timers run their source immediately rather than being queued, so the trace
 * stays deterministic and a case can put the write before the call it affects.
 */
function execute(code: string): string {
  const trace: string[] = [];
  const sandbox: Record<string, unknown> = {
    LOG: (...args: unknown[]): void => {
      trace.push(args.map((value) => String(value)).join(' '));
    },
  };
  const context = vm.createContext(sandbox);
  const runSource = (source: unknown): void => {
    if (typeof source === 'string') vm.runInContext(source, context, { timeout: 5_000 });
  };
  sandbox['setTimeout'] = runSource;
  sandbox['setInterval'] = runSource;
  try {
    vm.runInContext('var window = globalThis;', context);
    vm.runInContext(code, context, { timeout: 5_000 });
  } catch (error) {
    // Which throw it is matters: a `ReferenceError` that starts happening is
    // the exact shape of a declaration deleted while a string still names it.
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join('|');
}

/** Run one pass over the source and assert the program still does what it did. */
async function expectSameBehaviour(
  pass: Pass,
  source: string,
  options: DeobfuscateOptions = {},
): Promise<string> {
  const before = execute(source);
  const { code } = await runPass(pass, source, options);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n  input trace:  ${before}\n  output trace: ${after}\n  output code:  ${code}`,
    );
  }
  return code;
}

/** A refusal, stated as the pass reporting no change at all. */
async function expectRefused(
  pass: Pass,
  source: string,
  options: DeobfuscateOptions = {},
): Promise<void> {
  await expectSameBehaviour(pass, source, options);
  const { changes } = await runPass(pass, source, options);
  expect(changes).toBe(0);
}

/** The other half of every refusal: proof the guard is not wider than claimed. */
async function expectRewritten(
  pass: Pass,
  source: string,
  options: DeobfuscateOptions = {},
): Promise<string> {
  const code = await expectSameBehaviour(pass, source, options);
  const { changes } = await runPass(pass, source, options);
  expect(changes).toBeGreaterThan(0);
  return code;
}

// ===========================================================================
// simplify.proxy-functions
// ===========================================================================

describe('simplify.proxy-functions: string code addresses the wrapper', () => {
  it('refuses a wrapper a direct eval can reassign', async () => {
    // The template says `a + b`. By the time the call runs the binding holds
    // `a * b`, and `constantViolations` is empty because the write is a string.
    await expectRefused(
      inlineProxyFunctionsPass,
      `function f() {
         function w(a, b) { return a + b; }
         eval('w = function (a, b) { return a * b; }');
         LOG(w(3, 4));
       }
       f();`,
    );
  });

  it('refuses a wrapper a direct eval still calls by name', async () => {
    // Inlining the one reference makes `inlined === total`, which is the
    // condition for deleting the declaration - and the string is a use of it.
    await expectRefused(
      inlineProxyFunctionsPass,
      `function f() {
         function w(a) { return a + 1; }
         LOG(w(1));
         LOG(eval('w(5)'));
       }
       f();`,
    );
  });

  it('refuses a program-scope wrapper the `Function` constructor can read', async () => {
    await expectRefused(
      inlineProxyFunctionsPass,
      `function w(a) { return a + 1; }
       LOG(w(1));
       LOG(Function('return typeof w')());`,
    );
  });

  it('refuses one an indirect `window.eval` can read', async () => {
    await expectRefused(
      inlineProxyFunctionsPass,
      `function w(a) { return a + 1; }
       LOG(w(1));
       LOG(window.eval('typeof w'));`,
    );
  });

  it('refuses one an optional-call `eval?.()` can read', async () => {
    // `eval?.(s)` is not the direct form - the direct-eval rule lives in
    // `CallExpression`, not `OptionalChain` - so this is a global hazard, and
    // it is one the old private eval scans missed entirely.
    await expectRefused(
      inlineProxyFunctionsPass,
      `function w(a) { return a + 1; }
       LOG(w(1));
       LOG(eval?.('typeof w'));`,
    );
  });

  it('refuses one an aliased `eval` can read', async () => {
    // No test on the call site can see this: the callee there is a local name.
    await expectRefused(
      inlineProxyFunctionsPass,
      `function w(a) { return a + 1; }
       var e = eval;
       LOG(w(1));
       LOG(e('typeof w'));`,
    );
  });

  it('refuses one a `setTimeout` source string can call', async () => {
    await expectRefused(
      inlineProxyFunctionsPass,
      `function w(a) { return a + 1; }
       LOG(w(1));
       setTimeout('LOG(w(9))', 0);`,
    );
  });

  it('refuses to substitute `eval` into a callee slot', async () => {
    // Inside the wrapper `a(b)` is an INDIRECT eval: the callee is not spelled
    // `eval`, so the source compiles in global scope and reads the global `x`.
    // Substituted in, `eval('x')` is the direct form and reads the local one.
    await expectRefused(
      inlineProxyFunctionsPass,
      `function call2(a, b) { return a(b); }
       var x = 'GLOBAL';
       function g() { var x = 'LOCAL'; return call2(eval, 'x'); }
       LOG(g());`,
    );
  });

  it('still inlines when the program compiles no string at all', async () => {
    const code = await expectRewritten(
      inlineProxyFunctionsPass,
      `function w(a, b) { return a + b; }
       LOG(w(1, 2));`,
    );
    expect(code).not.toContain('function w');
  });

  it('still inlines a function-scope wrapper when the hazard is global-only', async () => {
    // `Function(...)` compiles in global scope, so it can read what the global
    // object and the global lexical environment hold - and a binding inside
    // `outer` is in neither. Refusing here would be wider than the fact.
    const code = await expectRewritten(
      inlineProxyFunctionsPass,
      `function outer() { function w(a, b) { return a + b; } return w(1, 2); }
       LOG(outer());
       LOG(Function('return 1')());`,
    );
    expect(code).toContain('1 + 2');
  });

  it('still inlines when a direct eval cannot reach the wrapper', async () => {
    // `eval` in `host` sees `host` and the program, never the inside of `f`.
    const code = await expectRewritten(
      inlineProxyFunctionsPass,
      `function host(s) { eval(s); }
       function f() { function w(a) { return a + 1; } return w(1); }
       LOG(f());
       LOG(typeof host);`,
    );
    expect(code).toContain('1 + 1');
  });
});

// ===========================================================================
// simplify.object-maps
// ===========================================================================

describe('simplify.object-maps: string code addresses the table', () => {
  it('refuses a map a direct eval still reads', async () => {
    // `retire` deletes the whole declaration once every read it knows about is
    // rewritten, and the string is a read it does not know about.
    await expectRefused(
      inlineObjectMapsPass,
      `function f() {
         var M = { 'a': 'hello', 'b': 'bye' };
         LOG(M['a']);
         LOG(eval('M["b"]'));
       }
       f();`,
    );
  });

  it('refuses a map a direct eval writes into', async () => {
    await expectRefused(
      inlineObjectMapsPass,
      `function f() {
         var M = { 'a': 'hello' };
         eval('M["a"] = "REAL"');
         LOG(M['a']);
       }
       f();`,
    );
  });

  it('refuses a map whose binding a direct eval can rebind', async () => {
    // The entry is a wrapper, so the read is reduced at its call site rather
    // than replaced in place - the same question one level up.
    await expectRefused(
      inlineObjectMapsPass,
      `function f() {
         var M = { 'k': function (x, y) { return x + y; } };
         eval('M = { "k": function (x, y) { return x * y; } }');
         LOG(M['k'](3, 4));
       }
       f();`,
    );
  });

  it('refuses a program-scope map the `Function` constructor can read', async () => {
    await expectRefused(
      inlineObjectMapsPass,
      `var M = { 'a': 'hello', 'b': 'bye' };
       LOG(M['a']);
       LOG(Function('return M["b"]')());`,
    );
  });

  it('refuses one a `setInterval` source string writes into', async () => {
    await expectRefused(
      inlineObjectMapsPass,
      `var M = { 'a': 'hello' };
       setInterval('M["a"] = "REAL"', 0);
       LOG(M['a']);`,
    );
  });

  it('still inlines when the program compiles no string at all', async () => {
    const code = await expectRewritten(
      inlineObjectMapsPass,
      `var M = { 'a': 'hello' };
       LOG(M['a']);`,
    );
    expect(code).toContain("LOG('hello')");
  });

  it('still inlines a function-scope map when the hazard is global-only', async () => {
    const code = await expectRewritten(
      inlineObjectMapsPass,
      `function outer() { var M = { 'a': 'hello' }; return M['a']; }
       LOG(outer());
       LOG(Function('return 1')());`,
    );
    expect(code).toContain("return 'hello'");
  });
});

// ===========================================================================
// simplify.discard-wrappers
// ===========================================================================

describe('simplify.discard-wrappers: string code addresses the wrapper', () => {
  it('refuses a program-scope wrapper the `Function` constructor can reassign', async () => {
    // Every gate this pass has still passes: one call site, no constant
    // violation, the body is empty. The replacement reads the argument the
    // rewrite would have thrown away.
    await expectRefused(
      unwrapDiscardedArgumentsPass,
      `function w() {}
       Function('w = function (a) { LOG("real " + a); }')();
       w(1, 2);`,
    );
  });

  it('refuses one an optional-call `eval?.()` can reassign', async () => {
    await expectRefused(
      unwrapDiscardedArgumentsPass,
      `function w() {}
       eval?.('w = function (a) { LOG("real " + a); }');
       w(1, 2);`,
    );
  });

  it('refuses one a `setTimeout` source string can reassign', async () => {
    await expectRefused(
      unwrapDiscardedArgumentsPass,
      `function w() {}
       setTimeout('w = function (a) { LOG("real " + a); }', 0);
       w(1, 2);`,
    );
  });

  it('refuses even the no-argument call, which is otherwise deleted outright', async () => {
    await expectRefused(
      unwrapDiscardedArgumentsPass,
      `function w() {}
       Function('w = function () { LOG("real"); }')();
       w();`,
    );
  });

  it('still unwraps a function-scope wrapper when the hazard is global-only', async () => {
    const code = await expectRewritten(
      unwrapDiscardedArgumentsPass,
      `function outer() { function w() {} w(LOG('a'), LOG('b')); }
       outer();
       LOG(Function('return 1')());`,
    );
    expect(code).not.toContain("w(LOG('a')");
  });

  it('still unwraps when the program compiles no string at all', async () => {
    const code = await expectRewritten(
      unwrapDiscardedArgumentsPass,
      `function w() {}
       w(LOG('a'), LOG('b'));`,
    );
    expect(code).not.toContain("w(LOG('a')");
  });

  it('refuses through the shared fact under refuseOnDirectEval', async () => {
    // The option's whole-binding refusal now reads the shared fact rather than
    // this file's own scope set; the answer for a bare `eval(s)` is the same
    // one it gave before.
    await expectRefused(
      unwrapDiscardedArgumentsPass,
      `function w() {}
       function outer(s) { eval(s); }
       LOG(typeof outer);
       w(LOG('a'), LOG('b'));`,
      { techniques: { functionUnwrapping: { refuseOnDirectEval: true } } },
    );
  });
});
