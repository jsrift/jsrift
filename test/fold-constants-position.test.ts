import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { foldConstantsPass } from '../src/passes/simplify/fold-constants.js';
import { expectNoChange, runPass } from './helpers.js';

/**
 * One question, asked by the seven helpers that could not ask it.
 *
 * `simplify/fold-constants.ts` resolved every name through a `scope: Scope`.
 * A scope cannot answer what `with (o) { ... }` asks, because that construct
 * changes nothing about BINDING: inside the body a name is looked up on `o`
 * first, at run time, and when it hits there is no binding for the scope to
 * report at all. So `scope.getBinding('undefined') === undefined` - the
 * predicate the whole file leant on - is not a weaker version of the right
 * question, it is a different question that happens to agree everywhere a
 * `with` is absent.
 *
 * Three of the visitor's seven entry points held a `NodePath` and guarded on it
 * (`foldCall`, `foldSpreads`, `resolveNumericVector`); four did not, and the
 * helpers under them had no path to guard with. Every case in the first two
 * sections below was a fold to a value the running program never holds.
 *
 * The third section is why the fix is a threaded position rather than four more
 * entry guards. A wrapper body's free names mean what they meant WHERE THE
 * WRAPPER WAS WRITTEN, so the `with` that governs them is one the call site
 * need not be in - `foldCall` is outside it and passes its own guard. No number
 * of guards at the entries reaches those.
 *
 * Every section ends in controls. `with` narrows what a name may mean and
 * nothing else, so `1 + 2` inside a `with` body is still `3`; a guard that also
 * refused that would be a pass quietly switching itself off.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Execute in a fresh realm. The only assertion that can catch this class: both
 * programs parse, both run, and the wrong one computes something else.
 */
function execute(code: string): string {
  const trace: string[] = [];
  const LOG = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { LOG, log: LOG, console: { log: LOG } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

/** Run the pass and require the observable trace to be unchanged. */
async function expectSameBehaviour(source: string, expected: string): Promise<string> {
  const before = execute(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  const { code } = await runPass(foldConstantsPass, source);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- before ---\n${before}\n--- after ---\n${after}\n--- code ---\n${code}`,
    );
  }
  return code;
}

// ---------------------------------------------------------------------------
// Read side: `constantOf` and the three helpers above it
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: a name read inside a `with` body', () => {
  /*
   * `undefined`, `NaN` and `Infinity` are non-writable, non-configurable
   * properties of the global object, which is what makes reading them foldable
   * at all. Both halves of that licence are about a NAME, and an object
   * environment revokes both: the read never reaches the global property, and
   * it can reach a getter besides.
   */

  it('refuses `undefined` as a conditional test (foldConditional -> staticTruthiness)', async () => {
    await expectSameBehaviour(
      `function f(o){ with (o) { LOG(undefined ? 'yes' : 'no'); } } f({undefined: 1});`,
      'yes',
    );
  });

  it('refuses `typeof undefined` (foldUnary -> staticTypeOf)', async () => {
    await expectSameBehaviour(
      `function f(o){ with (o) { LOG(typeof undefined); } } f({undefined: 'hello'});`,
      'string',
    );
  });

  it('refuses `undefined ?? fallback` (foldLogical -> constantOf)', async () => {
    await expectSameBehaviour(
      `function f(o){ with (o) { LOG(undefined ?? 'fb'); } } f({undefined: 'real'});`,
      'real',
    );
  });

  it('refuses `!NaN` (foldUnary -> staticTruthiness)', async () => {
    await expectSameBehaviour(`with ({NaN: 7}) { LOG(!NaN); }`, 'false');
  });

  it('refuses `Infinity ? ... : ...` (foldConditional -> staticTruthiness)', async () => {
    await expectSameBehaviour(`with ({Infinity: 0}) { LOG(Infinity ? 't' : 'f'); }`, 'f');
  });

  it('refuses `undefined` as a `&&` left operand', async () => {
    await expectSameBehaviour(`with ({undefined: 5}) { LOG(undefined && 'rhs'); }`, 'rhs');
  });

  it("refuses `'x' + undefined` (foldBinary -> constantOf)", async () => {
    await expectSameBehaviour(`with ({undefined: 5}) { LOG('x' + undefined); }`, 'x5');
  });

  it('reaches an unblocked `with` body, which is not a scope of its own', async () => {
    // `with (o) stmt;` gives the body no block and so no scope, which is the
    // shape a scope-derived hazard test cannot see. `insideWith` walks the
    // parent link and does.
    await expectSameBehaviour(
      `function f(o){ with (o) LOG(undefined ? 'yes' : 'no'); } f({undefined: 1});`,
      'yes',
    );
  });

  it('does not delete the getter that is the program’s only observable effect', async () => {
    // The fold here removed a call, not just a value: `LOG('n')` never touches
    // the object at all, so the accessor the program installed stops running.
    await expectSameBehaviour(
      `with ({ get undefined() { LOG('GETTER'); return 1; } }) { LOG(undefined ? 'y' : 'n'); }`,
      'GETTER\ny',
    );
  });

  it('control: arithmetic that consults no name still folds inside a `with`', async () => {
    // The guard is on names, not on the position. A `with` cannot change what
    // `1 + 2` means, and refusing it would be an unmeasured cost paid on every
    // statement in the body.
    const code = await expectSameBehaviour(`with ({a: 1}) { LOG(1 + 2); }`, '3');
    expect(code).toContain('LOG(3)');
  });

  it('control: the three names still fold where nothing intercepts them', async () => {
    const { code } = await runPass(
      foldConstantsPass,
      `LOG(undefined ? 'y' : 'n'); LOG(!NaN); LOG(typeof undefined);`,
    );
    expect(code).toContain(`LOG('n')`);
    expect(code).toContain('LOG(true)');
    expect(code).toContain(`LOG('undefined')`);
  });

  it('control: a `with` HEAD is evaluated in the enclosing scope', async () => {
    // Only the body is an object environment. A guard that climbed to the
    // `with` from anywhere inside the statement would refuse this too.
    const { code } = await runPass(
      foldConstantsPass,
      `function f(o){ with (o[undefined ? 0 : 1]) { LOG(1); } } f([{}, {}]);`,
    );
    expect(code).toContain('o[1]');
  });
});

// ---------------------------------------------------------------------------
// Write side: `literalFor`
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: emitting the name `undefined`', () => {
  /*
   * The site every audit of this hazard missed, because each one enumerated
   * READERS of the name and this one WRITES it. `literalFor` is the only place
   * in `src` that spells `undefined`, so a fold whose RESULT is that value
   * emits a name the object environment answers - with every read already
   * guarded and the input containing no such read at all.
   */

  it('refuses to write `undefined` into a `with` body', async () => {
    const code = await expectSameBehaviour(
      `with ({undefined: 5}) { LOG(void 0); }`,
      'undefined',
    );
    // The fold that used to happen was `void 0` -> `undefined`, and the emitted
    // name resolved to 5. Nothing is rewritten now.
    expect(code).toContain('void 0');
    expect(code).not.toMatch(/LOG\(undefined\)/);
  });

  it('refuses rather than rewriting `void 0` to itself, so the fixpoint ends', async () => {
    // The reason the arm refuses instead of emitting `void 0`, which would also
    // be correct: with the reads guarded, the only fold that reaches it inside
    // a `with` is `void <side-effect-free>`, and that is usually `void 0`. A
    // replacement equal to the node already there would report a change on
    // every iteration and never converge.
    await expectNoChange(foldConstantsPass, `with ({undefined: 5}) { LOG(void 0); }`);
  });

  it('control: `void 0` still becomes `undefined` outside a `with`', async () => {
    const { code } = await runPass(foldConstantsPass, `var u = void 0;`);
    expect(code).toContain('var u = undefined;');
  });

  it('control: `void 0` is still left alone when the NAME is bound', async () => {
    // The binding half of the question, which this arm already asked and which
    // the position half must not have replaced.
    await expectNoChange(foldConstantsPass, `function f(undefined) { return void 0; }`);
  });
});

// ---------------------------------------------------------------------------
// Positions the call site is not in
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: a resolver whose names live somewhere else', () => {
  /*
   * These are the cases that decided the shape of the fix. Each call site is
   * OUTSIDE the `with` and passes `foldCall`'s guard; what sits inside it is
   * the wrapper or the table whose free names the resolver then reads. Guarding
   * `foldUnary`, `foldBinary`, `foldLogical` and `foldConditional` - the four
   * entry points that lacked a guard - leaves all three live.
   */

  it('refuses a wrapper whose body reads a table through an object environment', async () => {
    await expectSameBehaviour(
      `var T = [1, 2, 3];
function g(o) {
  with (o) { var w = function (a, b) { return T.slice(a, b).join('-'); }; }
  return w(0, 2);
}
LOG(g({T: [9, 8, 7]}));`,
      '9-8',
    );
  });

  it('refuses a wrapper whose body reads `undefined` through an object environment', async () => {
    await expectSameBehaviour(
      `function g(o) {
  with (o) { var w = function (a) { return a + undefined; }; }
  return w('x');
}
LOG(g({undefined: 5}));`,
      'x5',
    );
  });

  it('refuses a wrapper whose body calls a built-in through an object environment', async () => {
    // `parseInt` is only `parseInt` when nothing binds it AND nothing
    // intercepts it; the second half has no binding to report.
    await expectSameBehaviour(
      `function g(o) {
  with (o) { var w = function (a) { return parseInt(a, 10); }; }
  return w('12');
}
LOG(g({parseInt: function () { return 99; }}));`,
      '99',
    );
  });

  /*
   * The four below were ALREADY correct, and they still pass with every guard
   * this file added removed: each is a call or a spread sitting directly in a
   * `with` body, so `foldCall` and `foldSpreads` refuse them at the entry on
   * the coarse guard they have always had. They are not evidence of a fixed
   * defect and are not written as if they were.
   *
   * They earn their place as the pin on the entry guards being redundant rather
   * than load-bearing. Each is now refused twice, and the three cases above are
   * what shows the inner refusal is the one that generalises: move the same
   * name one hop, into a wrapper body, and the entry guard stops seeing it.
   */

  it('stays refused: an unshadowed global function called inside a `with`', async () => {
    await expectSameBehaviour(
      `with ({parseInt: function () { return 99; }}) { LOG(parseInt('12', 10)); }`,
      '99',
    );
  });

  it('stays refused: `String.fromCharCode` inside a `with`', async () => {
    await expectSameBehaviour(
      `with ({String: {fromCharCode: function () { return 'Z'; }}}) { LOG(String.fromCharCode(65)); }`,
      'Z',
    );
  });

  it('stays refused: a frozen table read inside a `with`', async () => {
    await expectSameBehaviour(
      `var T = [1, 2, 3]; with ({T: [9, 8, 7]}) { LOG(T.slice(0, 2).join('-')); }`,
      '9-8',
    );
  });

  it('stays refused: a spread of a frozen table inside a `with`', async () => {
    await expectSameBehaviour(
      `var T = [1, 2, 3]; with ({T: [9, 8, 7]}) { LOG([...T.slice(0, 2)].join('-')); }`,
      '9-8',
    );
  });

  it('control: the same wrapper and table still fold with no `with` anywhere', async () => {
    // The whole point of the resolvers, unchanged: this is the obfuscated
    // fixture's slice idiom, and a guard that swallowed it would cost 1,585
    // recoveries on one file.
    const source = `var T = [1, 2, 3];
function w(a, b) { return T.slice(a, b).join('-'); }
LOG(w(0, 2));
LOG([...T.slice(1, 3), 4]);`;
    const code = await expectSameBehaviour(source, "1-2\n2,3,4");
    expect(code).toContain(`LOG('1-2')`);
    expect(code).toContain('LOG([2, 3, 4])');
  });

  it('control: a wrapper written outside a `with` is unaffected by one elsewhere', async () => {
    // The refusal is on the wrapper's OWN position, not on the file containing
    // a `with` at all.
    const source = `var T = [1, 2, 3];
function w(a, b) { return T.slice(a, b).join('-'); }
function unrelated(o) { with (o) { LOG(o.k); } }
LOG(w(0, 2));`;
    const code = await expectSameBehaviour(source, '1-2');
    expect(code).toContain(`LOG('1-2')`);
  });
});
