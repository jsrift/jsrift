import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import * as t from '@babel/types';
import { parseSource } from '../src/frontend/language.js';
import { analyzeDispatcher, looksLikeDispatcher } from '../src/analysis/dispatcher.js';
import { removeDeadBranchesPass } from '../src/passes/clean/dead-branches.js';
import { removeInjectedCodePass } from '../src/passes/clean/injected-code.js';
import { restoreJsxPass } from '../src/passes/finalize/jsx.js';
import { recoverConditionalsPass } from '../src/passes/structure/conditionals.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { normalize, runPass } from './helpers.js';

/**
 * Two questions that used to be answered by hand in nine and five places.
 *
 * The first is `isUnboundUndefined`: the *name* `undefined` is bindable, so
 * `function f(undefined)`, `var undefined = 1` and `let undefined` each make a
 * read of it something other than the value - and inside a `let`'s temporal
 * dead zone the read throws outright. Five predicates concluded "this is the
 * value undefined" from the spelling alone. Four of the five are shown below to
 * have been *live*, with an executed before/after trace; the fifth (JSX) is
 * shown structurally, for the reason its own case records.
 *
 * The second is `insideWith`: inside `with (o) { ... }` a name is looked up on
 * `o` first, at run time, so the binding the scope reports is only a fallback.
 * `clean/dead-branches` resolved test identifiers through Babel's
 * `evaluateTruthy()`, which sees the lexical binding and nothing else. The same
 * gap survived the first migration at all four `undefined` sites, because
 * "nothing bound this name" and "nothing intercepts this name" are different
 * claims and `isUnboundUndefined` only makes the first; the last section pins
 * both halves being asked together.
 *
 * Every fix here is paired with a control that the guard did not swallow the
 * case it was never about. A refusal that costs nothing is not free: it is a
 * simplification the tool stopped making, and unmeasured over-refusal is how a
 * guard quietly turns into "disable the pass".
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

// ---------------------------------------------------------------------------
// analysis/dispatcher.ts - isAlwaysFalsy
// ---------------------------------------------------------------------------

describe('dispatcher: `while (!undefined)` is only unconditional when nothing bound it', () => {
  /**
   * `!undefined` reads as `!void 0` and so as an infinite loop, which is what
   * made this shape a dispatcher. Bind the name and `!undefined` is `!1` - the
   * loop never runs at all, and linearising it emits every case body of a
   * machine the program never entered.
   */
  const shadowed = `function f(undefined) {
  var order = '1|0'.split('|'), state = 0;
  while (!undefined) {
    switch (order[state++]) {
      case '0': log('a'); continue;
      case '1': log('b'); continue;
    }
    break;
  }
}
f(1);`;

  it('refuses to unroll a dispatcher whose loop test reads a bound `undefined`', async () => {
    // Before the fix this printed "b\na" for a program that prints nothing.
    expect(execute(shadowed)).toBe('');
    await expectSameBehaviour(unflattenControlFlowPass, shadowed);
  });

  it('control: still unrolls the same loop when `undefined` is free', async () => {
    const free = shadowed.replace('function f(undefined)', 'function f()').replace('f(1);', 'f();');
    const code = await expectSameBehaviour(unflattenControlFlowPass, free);
    expect(normalize(code)).toContain("log('b');log('a');");
    expect(code).not.toContain('switch');
  });

  it('control: the scope-less pre-filter stays permissive, and the real gate rejects', () => {
    // `looksLikeDispatcher` is handed a bare node by `structure/control-flow.ts`
    // and has no scope, so it answers `'unverified'`. Narrowing it there would
    // be indistinguishable from a proven refusal and would drop dispatchers that
    // `analyzeDispatcher` can prove a moment later - so it must keep saying yes,
    // and `analyzeDispatcher` must be the one to say no.
    const { ast } = parseSource(shadowed);
    let loop: t.WhileStatement | undefined;
    t.traverseFast(ast, (node) => {
      if (t.isWhileStatement(node)) loop = node;
    });
    expect(loop).toBeDefined();
    expect(looksLikeDispatcher(loop!)).toBe(true);
  });

  it('control: `analyzeDispatcher` rejects the shadowed loop with the loop-is-conditional reason', async () => {
    const { ctx } = await runPass([], shadowed);
    const traverse = (await import('@babel/traverse')).default;
    const results: string[] = [];
    traverse(ctx.ast, {
      WhileStatement(path) {
        const result = analyzeDispatcher(path, { maxStates: 64, aggressive: true });
        results.push(result.kind === 'dispatcher' ? 'dispatcher' : result.reason);
      },
    });
    expect(results).toEqual(['the loop is conditional']);
  });
});

// ---------------------------------------------------------------------------
// passes/clean/injected-code.ts - foldConstant
// ---------------------------------------------------------------------------

describe('injected-code: `undefined` folds to the value only when it is free', () => {
  it('refuses the `if` guard when the name is bound', async () => {
    const source = `function f(undefined) {
  if (undefined === void 0) { log('dead'); } else { log('real'); }
}
f(1);`;
    // `1 === undefined` is false, so the program prints "real". The fold said
    // `undefined === undefined`, kept the wrong branch and deleted the taken one.
    expect(execute(source)).toBe('real');
    await expectSameBehaviour(removeInjectedCodePass, source);
  });

  it('refuses the `switch` dispatch when the name is bound', async () => {
    const source = `function f(undefined) {
  switch (undefined) {
    case void 0: log('dead'); break;
    default: log('real'); break;
  }
}
f(1);`;
    expect(execute(source)).toBe('real');
    await expectSameBehaviour(removeInjectedCodePass, source);
  });

  it('control: still folds both forms when `undefined` is free', async () => {
    const guard = await expectSameBehaviour(
      removeInjectedCodePass,
      `function f() { if (undefined === void 0) { log('taken'); } else { log('other'); } }\nf();`,
    );
    expect(guard).not.toContain('if');
    expect(guard).toContain("log('taken')");

    const dispatch = await expectSameBehaviour(
      removeInjectedCodePass,
      `function f() { switch (undefined) { case void 0: log('taken'); break; default: log('other'); break; } }\nf();`,
    );
    expect(dispatch).not.toContain('switch');
    expect(dispatch).toContain("log('taken')");
  });
});

// ---------------------------------------------------------------------------
// passes/structure/conditionals.ts - isDiscardableValue
// ---------------------------------------------------------------------------

describe('conditionals: a discarded branch is only filler when the read cannot throw', () => {
  it('keeps the branch when `undefined` is a `let` in its temporal dead zone', async () => {
    const source = `function f(cond) {
  cond ? log('run') : undefined;
  let undefined = 1;
}
f(false);`;
    // The only observable thing this program does is throw. Dropping the branch
    // as "a placeholder value" swallowed it and the program fell silent.
    expect(execute(source)).toContain('THROWN ReferenceError');
    await expectSameBehaviour(recoverConditionalsPass, source);
  });

  it('keeps the branch when `undefined` is a parameter', async () => {
    // Not a throw, but not a placeholder either: the branch reads a binding, and
    // the predicate that authorises the drop claims it reads nothing.
    const { code } = await runPass(
      recoverConditionalsPass,
      `function f(cond, undefined) { cond ? log('run') : undefined; }`,
    );
    expect(normalize(code)).toContain('undefined;');
  });

  it('control: still drops the filler branch when `undefined` is free', async () => {
    const code = await expectSameBehaviour(
      recoverConditionalsPass,
      `function f(cond) { cond ? log('run') : undefined; }\nf(false);`,
    );
    expect(normalize(code)).toBe("function f(cond){if(cond){log('run');}}f(false);");
  });

  it('control: `void 0` filler is unaffected, having no name to bind', async () => {
    const code = await expectSameBehaviour(
      recoverConditionalsPass,
      `function f(cond, undefined) { cond ? log('run') : void 0; }\nf(false, 1);`,
    );
    expect(normalize(code)).toContain("if(cond){log('run');}");
  });
});

// ---------------------------------------------------------------------------
// passes/finalize/jsx.ts - isNullish
// ---------------------------------------------------------------------------

describe('jsx: `_jsx(C, undefined)` is props-less only when `undefined` is free', () => {
  /**
   * This one is asserted structurally rather than by execution. The output is
   * JSX, so running it needs a jsx transform *and* a React runtime, neither of
   * which is a dependency of this package; a hand-written lowering back to
   * `_jsx` calls would only be testing the lowering. What execution would show
   * is stated instead: `<div />` re-compiles to `_jsx("div", {})`, so under
   * `function f(undefined)` the element goes from being handed whatever the
   * caller passed to being handed a fresh empty object.
   */
  const jsx = { language: 'jsx' as const };

  it('leaves the call alone when the props argument is a bound `undefined`', async () => {
    const { code } = await runPass(
      restoreJsxPass,
      `import { jsx as _jsx } from "react/jsx-runtime";\nfunction f(undefined) { return _jsx("div", undefined); }`,
      jsx,
    );
    expect(code).toContain('_jsx("div", undefined)');
    expect(code).not.toContain('<div');
  });

  it('keeps the key attribute when the key argument is a bound `undefined`', async () => {
    // The element still converts - only the "there is no key here" claim is
    // refused, so the read survives as an explicit `key={undefined}`.
    const { code } = await runPass(
      restoreJsxPass,
      `import { jsx as _jsx } from "react/jsx-runtime";\nfunction f(undefined) { return _jsx("div", {}, undefined); }`,
      jsx,
    );
    expect(normalize(code)).toContain('<div key={undefined}/>');
  });

  it('control: still converts both forms when `undefined` is free', async () => {
    const props = await runPass(
      restoreJsxPass,
      `import { jsx as _jsx } from "react/jsx-runtime";\nfunction f() { return _jsx("div", undefined); }`,
      jsx,
    );
    expect(normalize(props.code)).toContain('<div />');

    const key = await runPass(
      restoreJsxPass,
      `import { jsx as _jsx } from "react/jsx-runtime";\nfunction f() { return _jsx("div", {}, undefined); }`,
      jsx,
    );
    expect(normalize(key.code)).toContain('<div />');
    expect(key.code).not.toContain('key');
  });
});

// ---------------------------------------------------------------------------
// passes/clean/dead-branches.ts - constantTruthiness inside `with`
// ---------------------------------------------------------------------------

describe('dead-branches: a constant test inside a `with` body is not constant', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [
      'if, `var` binding shadowed by the object',
      `var o = { flag: false };
var flag = true;
with (o) { if (flag) { log('then'); } else { log('else'); } }`,
    ],
    [
      'if, `const` binding in an enclosing scope',
      `const flag = true;
function g(o) { with (o) { if (flag) { log('then'); } else { log('else'); } } }
g({ flag: false });`,
    ],
    [
      'while, never-entered by the lexical binding but entered by the object',
      `const flag = false;
function g(o) { with (o) { while (flag) { log('body'); break; } log('after'); } }
g({ flag: true });`,
    ],
    [
      'for, never-entered by the lexical binding but entered by the object',
      `const flag = false;
function g(o) { with (o) { for (var i = 0; flag;) { log('body'); break; } log('after'); } }
g({ flag: true });`,
    ],
    [
      'unblocked `with` body, where the `if` is the direct child',
      `const flag = true;
function g(o) { with (o) if (flag) log('then'); else log('else'); }
g({ flag: false });`,
    ],
  ];

  for (const [name, source] of cases) {
    it(`refuses: ${name}`, async () => {
      await expectSameBehaviour(removeDeadBranchesPass, source);
    });
  }

  it('control: a `with` in the file does not stop folding outside it - before the `if`', async () => {
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `function g(o) { with (o) { log('in'); } }
if (false) { log('dead'); } else { log('live'); }
g({});`,
    );
    expect(code).not.toContain("log('dead')");
    expect(code).not.toContain('if (');
  });

  it('control: nor after it - the flag is filled in ancestor-first, not file-order', async () => {
    // The gate is set by a `WithStatement` handler in the same traversal that
    // reads it. That is sound only because Babel enters a node before its
    // descendants; source order is irrelevant, and this pins that.
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `if (false) { log('dead'); } else { log('live'); }
function g(o) { with (o) { log('in'); } }
g({});`,
    );
    expect(code).not.toContain("log('dead')");
    expect(code).not.toContain('if (');
  });

  it('control: a name-free test inside a `with` body still folds', async () => {
    // An object environment intercepts name lookups and nothing else, so the
    // refusal is narrowed to tests that mention a name. `if (0)` is decidable
    // inside a `with` for exactly the same reason it is outside one.
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `function g(o) { with (o) { if (0) { log('dead'); } else { log('live'); } } }
g({});`,
    );
    expect(code).not.toContain("log('dead')");
    expect(code).not.toContain('if (');
  });

  it('control: a name-bearing test outside any `with` in a `with`-bearing file still folds', async () => {
    const code = await expectSameBehaviour(
      removeDeadBranchesPass,
      `function g(o) { with (o) { log('in'); } }
const flag = false;
if (flag) { log('dead'); } else { log('live'); }
g({});`,
    );
    expect(code).not.toContain("log('dead')");
  });
});

// ---------------------------------------------------------------------------
// The other half of the same question, at the same five sites
// ---------------------------------------------------------------------------

/**
 * `isUnboundUndefined` answers "is the name bound"; it says in its own docs that
 * it does not answer the `with` question, and that a caller inside an object
 * environment needs both. These four sites are inside object environments, and
 * each was measured wrong there *after* the migration above landed - a name with
 * no binding anywhere for a scope to report, resolving to a property at run time.
 *
 * The fix is `insideWith`, which was already extracted and already imported at
 * fourteen sites; asking it here is adoption, not a fifteenth copy. It is placed
 * after the binding test at every site, so the ancestor walk is reached only once
 * the node is known to be a free `undefined`.
 */
describe('`with` intercepts the name even when no binding exists', () => {
  it('dispatcher: `while (!undefined)` under a `with` is not unconditional', async () => {
    const source = `function f(o) {
  with (o) {
    var order = '1|0'.split('|'), state = 0;
    while (!undefined) {
      switch (order[state++]) {
        case '0': log('a'); continue;
        case '1': log('b'); continue;
      }
      break;
    }
  }
}
f({ undefined: 1 });`;
    expect(execute(source)).toBe('');
    await expectSameBehaviour(unflattenControlFlowPass, source);
  });

  it('injected-code: a guard reading `undefined` under a `with` is not decidable', async () => {
    const source = `function f(o) {
  with (o) { if (undefined === void 0) { log('dead'); } else { log('real'); } }
}
f({ undefined: 1 });`;
    expect(execute(source)).toBe('real');
    await expectSameBehaviour(removeInjectedCodePass, source);
  });

  it('conditionals: a discarded `undefined` under a `with` can run a getter', async () => {
    const source = `function f(cond, o) {
  with (o) { cond ? log('run') : undefined; }
}
f(false, Object.defineProperty({}, 'undefined', { get: function () { log('getter'); return 1; } }));`;
    // The whole observable behaviour of this program is the getter call, which
    // the "it is only a placeholder" rewrite deleted.
    expect(execute(source)).toBe('getter');
    await expectSameBehaviour(recoverConditionalsPass, source);
  });

  it('jsx: `_jsx(C, undefined)` under a `with` is not a props-less element', async () => {
    const { code } = await runPass(
      restoreJsxPass,
      `import { jsx as _jsx } from "react/jsx-runtime";\nfunction f(o) { with (o) { return _jsx("div", undefined); } }`,
      { language: 'jsx' },
    );
    expect(code).toContain('_jsx("div", undefined)');
    expect(code).not.toContain('<div');
  });

  it('control: only the `with` body is affected, not the whole file', async () => {
    // `with` changes name resolution inside its body and nowhere else, so an
    // identical guard outside one still folds in the same program.
    const { code } = await runPass(
      removeInjectedCodePass,
      `function f(o) { with (o) { if (undefined === void 0) { log('a'); } else { log('b'); } } }
function g() { if (undefined === void 0) { log('c'); } else { log('d'); } }`,
    );
    expect(code).toContain('if (undefined === void 0)');
    expect(code).toContain("log('c')");
    expect(code).not.toContain("log('d')");
  });

  it('control: a name-free operand under a `with` still folds', async () => {
    // An object environment intercepts names. `'a' === 'b'` has none, so the
    // refusal must not reach it.
    const code = await expectSameBehaviour(
      removeInjectedCodePass,
      `function f(o) { with (o) { if ('a' === 'b') { log('dead'); } else { log('live'); } } }
f({});`,
    );
    expect(code).not.toContain("log('dead')");
    expect(code).not.toContain('if (');
  });
});
