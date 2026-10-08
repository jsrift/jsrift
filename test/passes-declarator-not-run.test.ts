import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * A name resolved to its initialiser at a read that runs BEFORE the
 * declarator has.
 *
 * Three passes read a declaration and put its value where the name is used:
 * `simplify.fold-constants` evaluates a wrapper call and a frozen table,
 * `simplify.proxy-functions` expands a wrapper body, `simplify.object-maps`
 * inlines a storage object's entries. Each proved the name was never
 * REASSIGNED and none asked whether the declarator had RUN. Before it a
 * `let` or `const` throws a `ReferenceError`, and a `var` - initialised on
 * entry, so its read never throws - holds `undefined`, so a call through it
 * is a `TypeError`. The program prints the error's name; the output printed
 * the value, at every preset.
 *
 * The proof is `holdsDeclaredValue` in `util/ast.ts`: the dead-zone climb
 * `isInitialisedBinding` already made for `let`, `const` and `class`, asked of
 * `var` as well, where the read must also be inside the statement list the
 * declaration is in, or that list one control cannot skip on the way. A call
 * inside a hoisted function or a callback is placed by whatever calls THAT,
 * which is the climb; a function that nothing in its scope can have called
 * yet is placed by the statements ahead of the declaration instead.
 *
 * Every case runs input and output in a fresh realm with only `log` and
 * compares the traces. The last sections are the controls: a call after the
 * declarator, a call inside a function declared before it but called after,
 * a read the climb cannot follow in a function that opens with the map, all
 * still fold - a proof that refused those would be a pass quietly switching
 * itself off - and a read that cannot be placed costs that read, not the
 * fold.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}`);
  }
  return trace.join(', ');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

async function expectSameBehaviour(source: string, expected: string): Promise<DeobfuscateResult[]> {
  const before = execute(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  const results: DeobfuscateResult[] = [];
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset });
    const after = execute(result.code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
      );
    }
    results.push(result);
  }
  return results;
}

function changesOf(result: DeobfuscateResult, pass: string): number {
  return result.metadata.passes.find((p) => p.id === pass)?.changes ?? 0;
}

/** The balanced output with its names left alone, so a shape can be asserted by name. */
async function shapeOf(source: string): Promise<string> {
  const result = await deobfuscate(source, { preset: 'balanced', techniques: { variableRenaming: false } });
  return result.code;
}

// ---------------------------------------------------------------------------
// simplify.fold-constants: a wrapper call
// ---------------------------------------------------------------------------

describe('a wrapper called before its declarator has run is not folded', () => {
  it('const arrow, call in the dead zone', async () => {
    await expectSameBehaviour(
      `try { log(m()); } catch (e) { log(e.name); } const m = () => 'm'; log(m());`,
      'ReferenceError, m',
    );
  });

  it('let function expression, call in the dead zone', async () => {
    await expectSameBehaviour(
      `try { log(f()); } catch (e) { log(e.name); } let f = function () { return 'f'; }; log(f());`,
      'ReferenceError, f',
    );
  });

  it('the same inside a block', async () => {
    await expectSameBehaviour(
      `{ try { log(m()); } catch (e) { log(e.name); } const m = () => 'm'; log(m()); }`,
      'ReferenceError, m',
    );
  });

  it('the call inside a hoisted function whose first call precedes the declaration', async () => {
    await expectSameBehaviour(
      `function g() { try { return h(); } catch (e) { return e.name; } } log(g()); const h = () => 'h'; log(g());`,
      'ReferenceError, h',
    );
  });

  it('var function expression, call before the assignment', async () => {
    await expectSameBehaviour(
      `try { log(f()); } catch (e) { log(e.name); } var f = function () { return 'f'; }; log(f());`,
      'TypeError, f',
    );
  });

  it('var arrow, call before the assignment', async () => {
    await expectSameBehaviour(
      `try { log(h()); } catch (e) { log(e.name); } var h = () => 'h'; log(h());`,
      'TypeError, h',
    );
  });

  it('var arrow read from a hoisted function called first', async () => {
    await expectSameBehaviour(
      `function g() { try { return h(); } catch (e) { return e.name; } } log(g()); var h = () => 'h'; log(g());`,
      'TypeError, h',
    );
  });

  it('the call inside a callback that runs first', async () => {
    await expectSameBehaviour(
      `function run(cb) { try { return cb(); } catch (e) { return e.name; } } log(run(() => q())); const q = () => 'q'; log(run(() => q()));`,
      'ReferenceError, q',
    );
  });

  it('a var declared in a branch that never ran, read after it', async () => {
    await expectSameBehaviour(
      `if (false) { var f = () => 1; } try { log(f()); } catch (e) { log(e.name); }`,
      'TypeError',
    );
  });

  it('a var declared in a case that was not entered', async () => {
    await expectSameBehaviour(
      `switch (2) { case 1: var f = () => 1; break; case 2: try { log(f()); } catch (e) { log(e.name); } }`,
      'TypeError',
    );
  });

  it('a var declared in a try block that threw first', async () => {
    await expectSameBehaviour(
      `try { throw 0; var f = () => 1; } catch (e) {} try { log(f()); } catch (e) { log(e.name); }`,
      'TypeError',
    );
  });
});

// ---------------------------------------------------------------------------
// simplify.fold-constants: a frozen table
// ---------------------------------------------------------------------------

describe('a frozen table read before its declarator has run is not folded', () => {
  it('var table, method chain in the dead zone', async () => {
    await expectSameBehaviour(
      `try { log(T.slice(0, 1).join('-')); } catch (e) { log(e.name); } var T = [1, 2, 3]; log(T.slice(0, 1).join('-'));`,
      'TypeError, 1',
    );
  });

  it('const table, method chain in the dead zone', async () => {
    await expectSameBehaviour(
      `try { log(T.slice(0, 1).join('-')); } catch (e) { log(e.name); } const T = [1, 2, 3]; log(T.slice(0, 1).join('-'));`,
      'ReferenceError, 1',
    );
  });

  it('var table spread inside a hoisted function called first', async () => {
    await expectSameBehaviour(
      `function g() { try { return [...T].length; } catch (e) { return e.name; } } log(g()); var T = [1, 2, 3]; log(g());`,
      'TypeError, 3',
    );
  });
});

// ---------------------------------------------------------------------------
// simplify.proxy-functions: a non-constant argument
// ---------------------------------------------------------------------------

describe('a proxy called before its declarator has run is not expanded', () => {
  it('const arrow with a variable argument', async () => {
    await expectSameBehaviour(
      `var x = 3; try { log(m(x)); } catch (e) { log(e.name); } const m = (a) => a + 1; log(m(x));`,
      'ReferenceError, 4',
    );
  });

  it('var function expression with a variable argument', async () => {
    await expectSameBehaviour(
      `var x = 3; try { log(m(x)); } catch (e) { log(e.name); } var m = function (a) { return a + 1; }; log(m(x));`,
      'TypeError, 4',
    );
  });

  it('the call inside a hoisted function called first', async () => {
    await expectSameBehaviour(
      `var x = 3; function g() { try { return m(x); } catch (e) { return e.name; } } log(g()); const m = (a) => a + 1; log(g());`,
      'ReferenceError, 4',
    );
  });
});

// ---------------------------------------------------------------------------
// simplify.object-maps: a storage object
// ---------------------------------------------------------------------------

describe('a storage object read before its declarator has run is not inlined', () => {
  it('var map, wrapper entry called in the dead zone', async () => {
    await expectSameBehaviour(
      `var x = 3; try { log(M.add(x, 1)); } catch (e) { log(e.name); } var M = { add: function (a, b) { return a + b; }, K: 'k' }; log(M.add(x, 1)); log(M.K);`,
      'TypeError, 4, k',
    );
  });

  it('const map, wrapper entry called in the dead zone', async () => {
    await expectSameBehaviour(
      `var x = 3; try { log(M.add(x, 1)); } catch (e) { log(e.name); } const M = { add: function (a, b) { return a + b; }, K: 'k' }; log(M.add(x, 1)); log(M.K);`,
      'ReferenceError, 4, k',
    );
  });

  it('var map, literal entry read in the dead zone', async () => {
    await expectSameBehaviour(
      `try { log(M.K); } catch (e) { log(e.name); } var M = { K: 'k' }; log(M.K);`,
      'TypeError, k',
    );
  });
});

// ---------------------------------------------------------------------------
// A var declared in a block, read from a function hoisted into that block
// ---------------------------------------------------------------------------

describe('a var read from a function hoisted into the block that declares it is not resolved', () => {
  // A `var` belongs to the function, so a block, a branch, a case, a loop
  // body or a `catch` can hold both the declarator and a hoisted function
  // that reads it, and the function is callable from the top of that block -
  // before the declarator has run. The climb used to place such a function
  // by the entry of the block it is declared in, which is right only when
  // entering the block is itself past the declarator, i.e. when the
  // declarator is directly in the function's own statement list; here it is
  // not, so the read has to be placed by the callers, and an Annex B function
  // does not list them. Every shape prints the throw first.
  it('a wrapper of a decoder, in a bare block', async () => {
    const source = `var _0xt = ['alpha', 'beta'];
function _0xd(i) { return _0xt[i]; }
{
  try { log(f()); } catch (e) { log(e.name); }
  var w = function (i) { return _0xd(i); };
  function f() { return w(0); }
}
log(f(), _0xd(1));`;
    await expectSameBehaviour(source, 'TypeError, alpha beta');
    expect(await shapeOf(source)).toContain('return w(0)');
  });

  it('a proxy, in a bare block', async () => {
    const source = `{
  try { log(f()); } catch (e) { log(e.name); }
  var P = function (x, y) { return x + y; };
  function f() { return P(1, 2); }
}
log(f());`;
    await expectSameBehaviour(source, 'TypeError, 3');
    expect(await shapeOf(source)).toContain('return P(1, 2)');
  });

  it('a storage object, in a branch', async () => {
    const source = `if (true) {
  try { log(f()); } catch (e) { log(e.name); }
  var M = { a: 'alpha', b: 'beta' };
  function f() { return M.a; }
}
log(f(), M.b);`;
    await expectSameBehaviour(source, 'TypeError, alpha beta');
    expect(await shapeOf(source)).toContain('return M.a');
  });

  it('a proxy declared in a branch nested in the block that hoists the function', async () => {
    const source = `{
  try { log(f()); } catch (e) { log(e.name); }
  if (true) { var P = function (x, y) { return x + y; }; }
  function f() { return P(1, 2); }
}
log(f());`;
    await expectSameBehaviour(source, 'TypeError, 3');
    expect(await shapeOf(source)).toContain('return P(1, 2)');
  });

  it('a proxy in a catch clause', async () => {
    const source = `try { throw 0; } catch (e) {
  try { log(f()); } catch (x) { log(x.name); }
  var P = function (a) { return a * 2; };
  function f() { return P(21); }
}
log(f());`;
    await expectSameBehaviour(source, 'TypeError, 42');
    expect(await shapeOf(source)).toContain('return P(21)');
  });

  it('still places the reads of a block function by the entry of an expression past the declarator', async () => {
    // The declarator is in the program's own list, so nothing below it runs
    // ahead of it, and the block function inside the expression is placed by
    // the expression - no caller of it needs to be listed.
    const source = `var P = function (x, y) { return x + y; };
!function () {
  { function f() { return P(1, 2); } }
  log(f());
}();`;
    const results = await expectSameBehaviour(source, '3');
    expect(results[1]!.code).toContain('return 3');
    expect(results[2]!.code).toContain('return 3');
  });
});

// ---------------------------------------------------------------------------
// Granularity: one unplaceable read keeps the declaration, not the fold
// ---------------------------------------------------------------------------

describe('a read the proof cannot place is left as written and the rest still fold', () => {
  it('a proxy called from a callback ahead of its declarator and again after it', async () => {
    // The callback runs after the declarator in practice; the proof cannot
    // know that, so the call inside it stays and keeps the declaration, and
    // the call after the declarator is expanded all the same.
    const source = `var x = 3, later = []; later.push(() => m(x)); const m = (a) => a + 1; log(m(x)); log(later[0]());`;
    await expectSameBehaviour(source, '4, 4');
    const shape = await shapeOf(source);
    expect(shape).toContain('const m = ');
    expect(shape).toContain('log(x + 1)');
    expect(shape).toContain('later.push(() => m(x))');
  });

  it('a storage object aliased late, from a function a callback reaches', async () => {
    // The alias declarator runs on the way down, after the map; the reads
    // through it are inside a function that a callback ahead of the alias
    // calls, which the proof cannot place. Those reads stay, and pin the map;
    // the reads through the map itself are inlined.
    const source = `function outer() {
  var M = { K: 'k', add: function (a, b) { return a + b; } }, later = [];
  later.push(function () { return use(); });
  function use() { return A.K + A.add(1, 2); }
  log(M.K, M.add(1, 2));
  var A = M;
  log(later[0]());
}
outer();`;
    await expectSameBehaviour(source, 'k 3, k3');
    const shape = await shapeOf(source);
    expect(shape).toContain("log('k', 3)");
    expect(shape).toContain('return A.K + A.add(1, 2)');
    expect(shape).toMatch(/var M = \{/);
    expect(shape).toContain('var A = M');
  });

  it('an escape ahead of the declarator still refuses the whole map', async () => {
    const source = `function outer() {
  var later = [];
  later.push(function () { M.K = 'changed'; });
  var M = { K: 'k' };
  later[0]();
  log(M.K);
}
outer();`;
    await expectSameBehaviour(source, 'changed');
    expect(await shapeOf(source)).toContain('log(M.K)');
  });

  it('a hoisted function that string code can call is not placed by its visible callers', async () => {
    const source = `function outer() {
  function g() { try { return h(); } catch (e) { return e.name; } }
  log(eval('g()'));
  const h = () => 'h';
  log(g());
}
outer();`;
    await expectSameBehaviour(source, 'ReferenceError, h');
    expect(await shapeOf(source)).toContain('return h()');
  });
});

// ---------------------------------------------------------------------------
// Controls: a declarator that has run is still resolved
// ---------------------------------------------------------------------------

describe('a read the climb cannot follow is placed by what runs ahead of the declarator', () => {
  it('a storage object read seven calls deep in a function that opens with it', async () => {
    // Deeper than the climb follows callers. Nothing in `outer` can have
    // called any of its own functions before the first statement ran, and
    // the map is in that statement.
    const source = `function outer() {
  var dec = String, M = { K: 'k' };
  function g1() { return g2(); }
  function g2() { return g3(); }
  function g3() { return g4(); }
  function g4() { return g5(); }
  function g5() { return g6(); }
  function g6() { return g7(); }
  function g7() { return M.K; }
  log(g1());
}
outer();`;
    await expectSameBehaviour(source, 'k');
    const shape = await shapeOf(source);
    expect(shape).toContain("log('k')");
    expect(shape).not.toContain('M.K');
  });

  it('a const wrapper called seven calls deep in a function that opens with it', async () => {
    const source = `function outer() {
  const w = (a) => a + 1;
  function g1() { return g2(); }
  function g2() { return g3(); }
  function g3() { return g4(); }
  function g4() { return g5(); }
  function g5() { return g6(); }
  function g6() { return g7(); }
  function g7() { return w(1); }
  log(g1());
}
outer();`;
    await expectSameBehaviour(source, '2');
    expect(await shapeOf(source)).toContain('log(2)');
  });

  it('two handlers that each unregister the other, reading the map in both', async () => {
    const source = `function outer() {
  var M = { K: 'move', L: 'leave' }, bus = { on: {}, add: function (n, f) { this.on[n] = f; }, remove: function (n) { delete this.on[n]; } };
  function move() { log(M.K); bus.remove(M.L, leave); }
  function leave() { log(M.L); bus.remove(M.K, move); }
  bus.add('move', move);
  bus.add('leave', leave);
  bus.on.move();
  log(Object.keys(bus.on).join());
}
outer();`;
    await expectSameBehaviour(source, 'move, move');
    const shape = await shapeOf(source);
    expect(shape).toContain("log('move')");
    expect(shape).toContain("log('leave')");
    expect(shape).not.toContain('M.K');
  });

  it('a call ahead of the map in the function refuses the shortcut', async () => {
    const source = `function outer() {
  g();
  var M = { K: 'k' };
  function g() { try { log(M.K); } catch (e) { log(e.name); } }
  g();
}
outer();`;
    await expectSameBehaviour(source, 'TypeError, k');
    expect(await shapeOf(source)).toContain('log(M.K)');
  });
});

describe('a call after the declarator still folds', () => {
  it('const arrow called after its declaration', async () => {
    const results = await expectSameBehaviour(`const m = () => 'm'; log(m());`, 'm');
    for (const result of results) {
      expect(result.code).toContain("log('m')");
      expect(changesOf(result, 'simplify.fold-constants')).toBeGreaterThan(0);
    }
  });

  it('var function expression called after its declaration', async () => {
    const results = await expectSameBehaviour(`var f = function () { return 'f'; }; log(f());`, 'f');
    for (const result of results) expect(result.code).toContain("log('f')");
  });

  it('a call inside a function declared before but called after', async () => {
    const results = await expectSameBehaviour(`function g() { return h(); } const h = () => 'h'; log(g());`, 'h');
    for (const result of results) expect(result.code).toContain("return 'h'");
  });

  it('a var wrapper in a bare block, called after it', async () => {
    const results = await expectSameBehaviour(`{ var f = () => 'f'; } log(f());`, 'f');
    for (const result of results) expect(result.code).toContain("log('f')");
  });

  it('a var wrapper declared and called inside one loop body', async () => {
    // The declarator runs on every iteration before the call does; the fold
    // is refused all the same, because a loop body is a place control can
    // reach past the declarator without it - and a refusal is never wrong.
    await expectSameBehaviour(`for (var i = 0; i < 2; i++) { var f = () => 'f'; log(f()); }`, 'f, f');
  });

  it('a frozen var table read after its declaration', async () => {
    const results = await expectSameBehaviour(`var T = [1, 2, 3]; log(T.slice(0, 1).join('-'));`, '1');
    for (const result of results) expect(result.code).toContain("log('1')");
  });

  it('a proxy with a variable argument called after its declaration', async () => {
    const source = `var x = 3; const m = (a) => a + 1; log(m(x));`;
    const results = await expectSameBehaviour(source, '4');
    // `proxy-functions` is a balanced-and-up pass; at conservative the call stays.
    expect(results[1]!.code).not.toContain('m(x)');
    expect(results[2]!.code).not.toContain('m(x)');
  });

  it('a storage object read after its declaration', async () => {
    const source = `var x = 3; var M = { add: function (a, b) { return a + b; }, K: 'k' }; log(M.add(x, 1)); log(M.K);`;
    const results = await expectSameBehaviour(source, '4, k');
    expect(results[1]!.code).toContain("log('k')");
    expect(results[2]!.code).toContain("log('k')");
  });
});
