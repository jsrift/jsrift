import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { removeDeadBranchesPass } from '../src/passes/clean/dead-branches.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { pruneDecodersPass } from '../src/passes/strings/prune-decoders.js';
import { runPass } from './helpers.js';

/**
 * Four passes that resolved a name to a value, or deleted a declaration by
 * name, without asking whether code compiled from a string could still reach
 * it.
 *
 * `analysis/string-code.ts` answers that question once per fixpoint iteration
 * and every pass here now asks it, which is the point: the classifier
 * (`freezeHazardKind`) was already shared, but a shared classifier does not
 * help a pass that never calls it, and each of these had its own private
 * version of the analysis or none at all.
 *
 * What makes this worth executed tests rather than structural ones is that
 * every defect below produces output that parses and runs. Three of the four
 * compute a different answer; the fourth throws on a line that used to work.
 * A structural assertion cannot tell those from a correct simplification.
 *
 * Every refusal here is paired with a control showing the guard did not swallow
 * the case it was never about, because a refusal that costs nothing is not
 * free: it is a simplification the tool stopped making. Two of the controls are
 * the ones that matter most in practice - a hazard reaches a binding only when
 * a direct `eval` sits on its scope chain, or when the binding is at program
 * scope and global string code exists, so machinery inside an IIFE is untouched
 * by a `Function(src)` at top level.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Execute in a fresh realm; the *kind* of failure is part of the trace. */
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log, console: { log } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

/**
 * The only assertion that can catch this class of defect: run both programs.
 * A structural check cannot tell a correct simplification from one that
 * computes something else, because both parse and both read fine.
 */
/*
 * The `options` parameter exists for the refusal tests below. `runPass` defaults
 * to the `aggressive` preset, the one preset that lifts the string-code refusal,
 * and a test asserting the refusal has to pin the option rather than the preset.
 */
async function expectSameBehaviour(
  pass: Parameters<typeof runPass>[0],
  source: string,
  options: Parameters<typeof runPass>[2] = {},
): Promise<string> {
  const before = execute(source);
  const { code } = await runPass(pass, source, options);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
  return code;
}

const STRINGS = [discoverStringsPass, inlineStringsPass, pruneDecodersPass];

// ---------------------------------------------------------------------------
// clean/dead-branches - a constant test is only constant if nothing rewrites it
// ---------------------------------------------------------------------------

/**
 * `binding.constant` means "nothing in the TREE reassigns this name", which is
 * the whole of what Babel's evaluator can see. A write from code compiled out
 * of a string is in no tree, so the evaluator reports a value the branch may
 * never read and the wrong arm is deleted.
 */
describe('dead-branches: a test string code can rewrite is not constant', () => {
  it('refuses an `if` whose test reads a var a direct eval can write', async () => {
    await expectSameBehaviour(
      removeDeadBranchesPass,
      `var flag = true;
       function g(s) { eval(s); if (flag) log('a'); else log('b'); }
       g('flag = false');`,
    );
  });

  it('refuses it when the writer is `Function(src)` rather than a direct eval', async () => {
    // Different hazard, same outcome. `Function` compiles in GLOBAL scope, so
    // it sees no local - but a program-scope `var` in a script is a property of
    // the global object, which is not a local.
    await expectSameBehaviour(
      removeDeadBranchesPass,
      `var flag = true;
       Function('flag = false')();
       if (flag) log('a'); else log('b');`,
    );
  });

  it('refuses a `while` head on the same grounds', async () => {
    await expectSameBehaviour(
      removeDeadBranchesPass,
      `var gate = false;
       Function('gate = true')();
       while (gate) { log('entered'); break; }
       log('done');`,
    );
  });

  it('refuses a `for` head on the same grounds', async () => {
    await expectSameBehaviour(
      removeDeadBranchesPass,
      `var gate = false;
       Function('gate = true')();
       for (; gate; ) { log('entered'); break; }
       log('done');`,
    );
  });

  it('control: a test built only out of literals still folds', async () => {
    // The refusal is per NAME, so string code in the file does not stop the
    // folding it was never about.
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `Function('void 0')();
       if (1 + 1 === 2) log('a'); else log('b');`,
    );
    expect(code).not.toContain('if (');
  });

  it('control: a local no direct eval can reach still folds', async () => {
    // `reaches` is the chain from the eval site UPWARD, so a sibling function's
    // own bindings are not on it. Nothing here is global string code either:
    // a direct `eval` is the lexical hazard, not the global one.
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `function e(s) { eval(s); }
       function f() { var t = true; if (t) log('a'); else log('b'); }
       e('void 0'); f();`,
    );
    expect(code).not.toContain('if (');
  });

  it('control: a `const` still folds, because string code cannot write one', async () => {
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `const on = true;
       Function('void 0')();
       if (on) log('a'); else log('b');`,
    );
    expect(code).not.toContain('if (');
  });

  it('control: and that claim about `const` is a fact about the language', () => {
    // The carve-out above rests on this and nothing else. Assigning to a
    // `const` from eval'd code throws instead of assigning, and the throw is
    // unchanged by folding a branch, since the `eval` call stays where it is.
    expect(
      execute(`const c = 1;
               try { eval('c = 2'); } catch (e) { log('threw ' + e.name); }
               log(c);`),
    ).toBe('threw TypeError\n1');
  });

  it('control: a free `NaN` is refused by the purity test, not by the new one', async () => {
    // The new guard waves unbound names through - `evaluateTruthy` folds only
    // `undefined`, `NaN` and `Infinity` among them, and all three are
    // non-writable, non-configurable properties of the global object, so there
    // is nothing there for string code to write. What refuses this test is
    // older and unrelated: `scope.isPure(node, true)` calls an identifier with
    // no binding impure. Both spellings are left alone, which is what shows the
    // string code is not the reason.
    const withStringCode = await runPass(
      removeDeadBranchesPass,
      `Function('void 0')();
       if (!NaN) log('a'); else log('b');`,
    );
    const without = await runPass(removeDeadBranchesPass, `if (!NaN) log('a'); else log('b');`);
    expect(withStringCode.code).toContain('if (');
    expect(without.code).toContain('if (');
    expect(withStringCode.changes).toBe(without.changes);
  });

  it('control: a program with no string code folds exactly as it always did', async () => {
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `var flag = true;
       if (flag) log('a'); else log('b');`,
    );
    expect(code).not.toContain('if (');
  });

  it('control: the `with` refusal still fires, and independently', async () => {
    // Two guards, two questions. This program has no string code at all, so
    // only the positional one can be what refuses it.
    await expectSameBehaviour(
      removeDeadBranchesPass,
      `var flag = true;
       function g(o) { with (o) { if (flag) log('a'); else log('b'); } }
       g({ flag: false });`,
    );
  });
});

// ---------------------------------------------------------------------------
// strings/prune-decoders - deleting a declaration string code still names
// ---------------------------------------------------------------------------

/**
 * The survey this pass runs proves that no identifier IN THE TREE still denotes
 * the decoder. That was the whole proof, and code compiled from a string is in
 * no tree - so the machinery went, and the string naming it did not.
 */
describe('prune-decoders: machinery a string can still name', () => {
  it('keeps the decoder a `Function(src)` addresses by name', async () => {
    await expectSameBehaviour(
      STRINGS,
      `var A = ['alpha', 'beta', 'gamma'];
       function dec(i) { return A[i]; }
       log(dec(0));
       log(dec(1));
       log(Function('return dec(2)')());`,
      { techniques: { stringDecoding: { decodeDespiteStringCode: false } } },
    );
  });

  it('control: the same program without the string code is pruned to literals', async () => {
    const code = await expectSameBehaviour(
      STRINGS,
      `var A = ['alpha', 'beta', 'gamma'];
       function dec(i) { return A[i]; }
       log(dec(0));
       log(dec(1));
       log(dec(2));`,
    );
    expect(code).not.toContain('function dec');
    expect(code).not.toContain("['alpha'");
    expect(code).toContain("log('alpha')");
    expect(code).toContain("log('gamma')");
  });

  it('control: machinery inside an IIFE is out of a global compile’s reach', async () => {
    // This is the control that keeps the guard from being a switch that turns
    // the pass off. `Function(src)` compiles in global scope; a binding inside
    // an IIFE is not in global scope and not a property of the global object,
    // so it is not addressable and the machinery is deleted as before.
    const code = await expectSameBehaviour(
      STRINGS,
      `var out = [];
       (function () {
         var A = ['alpha', 'beta', 'gamma'];
         function dec(i) { return A[i]; }
         out.push(dec(0), dec(1), dec(2));
       })();
       Function('void 0')();
       log(out.join(','));`,
    );
    expect(code).not.toContain('function dec');
    expect(code).toContain("'alpha'");
  });
});

// ---------------------------------------------------------------------------
// strings/inline - a table is only a constant if nothing can rewrite it
// ---------------------------------------------------------------------------

/**
 * `auditArrayReferences` proves no reference in the tree writes the table, and
 * every decoded value is read out of the array as it was WRITTEN. String code
 * is outside that proof, and an element write from it leaves the inlined
 * literals frozen at the values the analysis happened to see.
 */
describe('inline: a table string code can rewrite', () => {
  it('leaves the references encoded when a direct eval can write the table', async () => {
    await expectSameBehaviour(
      STRINGS,
      `var A = ['alpha', 'beta', 'gamma'];
       function dec(i) { return A[i]; }
       function m(s) { eval(s); }
       m('A[0] = "MUT"');
       log(dec(0));
       log(dec(1));
       log(dec(2));`,
      { techniques: { stringDecoding: { decodeDespiteStringCode: false } } },
    );
  });

  it('control: a table out of reach of a global compile is still inlined', async () => {
    const code = await expectSameBehaviour(
      STRINGS,
      `var out = [];
       (function () {
         var A = ['alpha', 'beta', 'gamma'];
         function dec(i) { return A[i]; }
         out.push(dec(0), dec(2));
       })();
       Function('void 0')();
       log(out.join(','));`,
    );
    expect(code).toContain("'alpha'");
    expect(code).not.toContain('dec(0)');
  });
});

// ---------------------------------------------------------------------------
// clean/unused - the shapes a CallExpression-only visitor never received
// ---------------------------------------------------------------------------

/**
 * This pass already imported `freezeHazardKind`, so the shapes it asked about
 * were right. What it could not ask about is the shapes its own traversal never
 * handed over: it visited `CallExpression` and `NewExpression`, and an
 * `OptionalCallExpression` is neither, so `Function?.(src)` reached no
 * classifier at all. Sharing the fact rather than the classifier is what closes
 * that, and it also means the traversal happens once for the whole pipeline
 * instead of once here.
 */
describe('unused: optional calls are string code too', () => {
  it('keeps a program-scope binding a `Function?.(src)` can address', async () => {
    await expectSameBehaviour(
      removeUnusedPass,
      `var kept = 'K';
       Function?.('log(kept)')();`,
    );
  });

  it('keeps one an optional member call can address', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      `var kept = 'K';
       globalThis.eval?.('log(kept)');`,
    );
    expect(code).toContain('kept');
  });

  it('control: the same binding goes when nothing compiles a string', async () => {
    const { code } = await runPass(removeUnusedPass, `var kept = 'K'; log(1);`, { sourceType: 'module' });
    expect(code).not.toContain('kept');
  });

  it('control: the `arguments` half of the old scope test still refuses', async () => {
    // Splitting the two questions apart left this one exactly where it was:
    // answered on demand and memoised, because finding it up front needs an
    // `Identifier` visitor and that is the handler this pass cannot afford.
    const { code } = await runPass(
      removeUnusedPass,
      `function f() { var x = 1; return arguments.length; }
       log(f(9));`,
    );
    expect(code).toContain('var x');
  });

  it('control: the `with` refusal is untouched by the migration', async () => {
    // `with` is not string code and the shared module refuses to answer it on
    // purpose; this pass keeps its own gate.
    const { code } = await runPass(
      removeUnusedPass,
      `function f(o) { with (o) { var x = 1; } return o.x; }
       log(f({ x: 0 }));`,
    );
    expect(code).toContain('var x');
  });
});
