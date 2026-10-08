import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { isInitialisedBinding } from '../src/util/ast.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { runPass } from './helpers.js';

/**
 * Where a read is WRITTEN is not when it RUNS.
 *
 * `isInitialisedBinding` proves a `let`/`const`/`class` read is past its
 * temporal dead zone, and its only evidence is source offsets: the read starts
 * at or after the declaration ends. That is an argument about text, and two
 * constructs let control arrive at a later offset without having executed an
 * earlier one - a hoisted `function`, callable from the moment its scope is
 * entered, and a `switch`, which enters at the matching case and skips the
 * others.
 *
 * Both turn the predicate's `true` into a licence to delete a `ReferenceError`.
 * Every case below is behavioural: it runs the program in a fresh realm first
 * and asserts what it observed - a throw included, since a throw that stops
 * happening is as much of a change as a call that stops happening - and only
 * then asserts the pipeline preserved it. A predicate test alone would pass
 * just as well against a hazard that was never real.
 *
 * The other half of the file is the COST. "Refuse every read inside a function"
 * would fix all of this and delete the commonest safe shape there is
 * (`const K = 1; function use() { return K; }`), so the acceptances are pinned
 * as tightly as the refusals.
 */

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

/** Run a program in a fresh realm and return everything it made observable. */
function execute(code: string): string {
  const trace: string[] = [];
  const LOG = (...args: unknown[]): void => {
    trace.push(args.map((value) => String(value)).join(' '));
  };
  const context = vm.createContext({ LOG });
  try {
    vm.runInContext(code, context, { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join('|');
}

/**
 * Prove the hazard, then prove every preset preserves it.
 *
 * `expected` is asserted against the INPUT first, so a shape that stopped
 * throwing - because it was written wrong, or because JavaScript never made it
 * throw - fails here rather than silently passing as a refusal test.
 */
async function expectPreserved(source: string, expected: string): Promise<void> {
  expect(execute(source)).toBe(expected);
  for (const preset of PRESETS) {
    const { code } = await deobfuscate(source, { preset });
    const after = execute(code);
    if (after !== expected) {
      throw new Error(
        `Behaviour changed at ${preset}.\n  input:  ${expected}\n  output: ${after}\n  code:\n${code}`,
      );
    }
  }
}

/** The identifier marked `PROBE(<name>)`, with the scope it is read in. */
function probe(source: string): { node: t.Identifier; scope: Scope; path: NodePath } {
  const ast = parse(source, { sourceType: 'script' });
  let found: { node: t.Identifier; scope: Scope; path: NodePath } | undefined;
  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee, { name: 'PROBE' })) return;
      const argument = path.get('arguments')[0];
      if (!argument?.isIdentifier()) return;
      found = { node: argument.node, scope: argument.scope, path: argument };
      path.stop();
    },
  });
  if (!found) throw new Error(`no PROBE(<identifier>) in: ${source}`);
  return found;
}

function initialised(source: string): boolean {
  const p = probe(source);
  return isInitialisedBinding(p.node, p.scope);
}

// ---------------------------------------------------------------------------
// Hoisting: the call site is where the timing comes from
// ---------------------------------------------------------------------------

describe('a hoisted function runs whenever it is called, not where it is written', () => {
  /*
   * The base shape. `hoisted` is DECLARED AFTER `let v` and READS it, so the
   * read sits at a later offset than the declaration and executes before it.
   */
  const readInHoisted = [
    'function f() {',
    '  try {',
    '    hoisted();',
    "    LOG('no throw');",
    '  } catch (e) {',
    "    LOG('threw ' + e.constructor.name);",
    '  }',
    '  let v = 1;',
    '  function hoisted() { var dead = v; }',
    '}',
    'f();',
  ].join('\n');

  it('keeps a read of a `let` reached through a hoisted call site', async () => {
    await expectPreserved(readInHoisted, 'threw ReferenceError');
  });

  it('keeps it in `clean.unused` alone, so the indictment names one pass', async () => {
    const { code } = await runPass(removeUnusedPass, readInHoisted);
    expect(execute(code)).toBe('threw ReferenceError');
  });

  it('keeps a read of a `class` binding reached the same way', async () => {
    await expectPreserved(
      [
        'function f() {',
        '  try {',
        '    hoisted();',
        "    LOG('no throw');",
        '  } catch (e) {',
        "    LOG('threw ' + e.constructor.name);",
        '  }',
        '  class C {}',
        '  function hoisted() { var dead = C; }',
        '}',
        'f();',
      ].join('\n'),
      'threw ReferenceError',
    );
  });

  it('keeps it at program scope, where the binding is the global lexical one', async () => {
    await expectPreserved(
      [
        'try {',
        '  hoisted();',
        "  LOG('no throw');",
        '} catch (e) {',
        "  LOG('threw ' + e.constructor.name);",
        '}',
        'let v = 1;',
        'function hoisted() { var dead = v; }',
      ].join('\n'),
      'threw ReferenceError',
    );
  });

  it('keeps a read the fold would otherwise resolve, not only one `unused` would drop', async () => {
    await expectPreserved(
      [
        'function f() {',
        '  try {',
        '    hoisted();',
        "    LOG('no throw');",
        '  } catch (e) {',
        "    LOG('threw ' + e.constructor.name);",
        '  }',
        '  let v = 1;',
        '  function hoisted() { var dead = v ? 1 : 2; }',
        '}',
        'f();',
      ].join('\n'),
      'threw ReferenceError',
    );
  });

  /*
   * The indirect shape, and the reason the proof has to climb rather than look
   * at one function. The read is in a function EXPRESSION, which cannot be
   * called before the expression that creates it - sound on its own. What makes
   * it early is the hoisted declaration that expression is written inside.
   */
  it('keeps a read in a closure that a hoisted function hands out', async () => {
    await expectPreserved(
      [
        'function f() {',
        '  var run;',
        '  try {',
        '    seed();',
        '    run();',
        "    LOG('no throw');",
        '  } catch (e) {',
        "    LOG('threw ' + e.constructor.name);",
        '  }',
        '  let v = 1;',
        '  function seed() { run = function () { var dead = v; }; }',
        '}',
        'f();',
      ].join('\n'),
      'threw ReferenceError',
    );
  });
});

// ---------------------------------------------------------------------------
// switch: entry jumps past the declaration
// ---------------------------------------------------------------------------

describe('a `switch` enters at its case, so an earlier case never ran', () => {
  const fallthrough = [
    'function f(x) {',
    '  try {',
    '    switch (x) {',
    '      case 1: let v = 1; break;',
    '      case 2: var dead = v; break;',
    '    }',
    "    LOG('no throw');",
    '  } catch (e) {',
    "    LOG('threw ' + e.constructor.name);",
    '  }',
    '}',
    'f(2);',
  ].join('\n');

  it('keeps a read in a later case of a `let` declared in an earlier one', async () => {
    // A switch body is ONE block with one scope, so `case 2` resolves `v` to the
    // binding in `case 1` - at an earlier offset, and never executed.
    await expectPreserved(fallthrough, 'threw ReferenceError');
  });

  it('keeps it in `clean.unused` alone', async () => {
    const { code } = await runPass(removeUnusedPass, fallthrough);
    expect(execute(code)).toBe('threw ReferenceError');
  });

  it('still accepts a read in the SAME case, which entry cannot skip', () => {
    expect(initialised('switch (x) { case 1: let v = 1; PROBE(v); }')).toBe(true);
  });

  it('refuses a read in a different case', () => {
    expect(initialised('switch (x) { case 1: let v = 1; break; case 2: PROBE(v); }')).toBe(false);
  });

  it('is unaffected when the case braces its body, where the read cannot resolve', () => {
    // `{ let v }` declares into the braced block, so a read outside is a
    // different name entirely; the containment test never applies.
    expect(initialised('switch (x) { case 1: { let v = 1; PROBE(v); } }')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The refusals, at the predicate
// ---------------------------------------------------------------------------

describe('isInitialisedBinding refuses a read whose call site is not proven late', () => {
  it('refuses when the only call site precedes the declaration', () => {
    expect(initialised('use(); let v = 1; function use() { PROBE(v); }')).toBe(false);
  });

  it('refuses when one call site of several precedes it', () => {
    expect(initialised('use(); let v = 1; use(); function use() { PROBE(v); }')).toBe(false);
  });

  it('refuses through a chain of callers when the outermost one is early', () => {
    expect(
      initialised(
        ['outer();', 'let v = 1;', 'function outer() { inner(); }', 'function inner() { PROBE(v); }'].join(
          '\n',
        ),
      ),
    ).toBe(false);
  });

  it('refuses when the function is merely mentioned early, not even called', () => {
    // A reference is where the value is OBTAINED; whoever obtained it may call
    // it at any moment after, including before the declaration.
    expect(initialised('var q = use; let v = 1; function use() { PROBE(v); }')).toBe(false);
  });

  it('refuses an Annex B block function, whose binding never lists its outside uses', () => {
    expect(
      initialised(
        ['if (x) { function use() { PROBE(v); } }', 'let v = 1;', 'use();'].join('\n'),
      ),
    ).toBe(false);
  });

  it('refuses a function whose callers this file cannot see', async () => {
    const source = ['export const K = 1;', 'export function use() { return K; }'].join('\n');
    const ast = parse(source, { sourceType: 'module' });
    let answer: boolean | undefined;
    traverse(ast, {
      ReturnStatement(path) {
        const argument = path.get('argument');
        if (argument.isIdentifier()) answer = isInitialisedBinding(argument.node, argument.scope);
      },
    });
    // A circular import can call an export before the module body reaches the
    // declaration, and no call site of it is in this file.
    expect(answer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cost: what still answers true
// ---------------------------------------------------------------------------

describe('the reads that stay provable, so the fix is not "refuse inside a function"', () => {
  it('accepts the commonest shape there is: a call after the declaration', () => {
    expect(initialised('const K = 1; function use() { PROBE(K); } use();')).toBe(true);
  });

  it('accepts a function nothing references, whose read can never run', () => {
    expect(initialised('const K = 1; function use() { PROBE(K); }')).toBe(true);
  });

  it('accepts a recursive function, whose self-call needed an outer call first', () => {
    expect(
      initialised('const K = 1; function use(n) { if (n) use(n - 1); PROBE(K); } use(2);'),
    ).toBe(true);
  });

  it('accepts a chain of callers that are all after the declaration', () => {
    expect(
      initialised(
        ['const K = 1;', 'function inner() { PROBE(K); }', 'function outer() { inner(); }', 'outer();'].join(
          '\n',
        ),
      ),
    ).toBe(true);
  });

  it('accepts a function expression, which cannot be called before it is created', () => {
    expect(initialised('const K = 1; var use = function () { PROBE(K); }; use();')).toBe(true);
  });

  it('accepts an arrow, for the same reason', () => {
    expect(initialised('const K = 1; var use = () => { PROBE(K); }; use();')).toBe(true);
  });

  it('accepts a method, created when its object literal is evaluated', () => {
    expect(initialised('const K = 1; var o = { m() { PROBE(K); } }; o.m();')).toBe(true);
  });

  it('accepts a class field initialiser, which runs no earlier than the class', () => {
    expect(initialised('const K = 1; class A { x = PROBE(K); } new A();')).toBe(true);
  });

  it('accepts a nested block, which a `switch` is the only way to enter past', () => {
    expect(initialised('function f() { let v = 1; { PROBE(v); } }')).toBe(true);
  });

  it('accepts a hoisted function that reads a binding declared before it in text', () => {
    // The declaration precedes the function, so entering the scope at all is
    // already past it - no call site needs to be examined.
    expect(initialised('function f() { let v = 1; function use() { PROBE(v); } use(); }')).toBe(
      true,
    );
  });

  it('leaves every non-lexical kind alone, which is where the hot path stays', () => {
    // `var`, function and parameter bindings are initialised on scope entry, so
    // none of this reasoning runs for them at all.
    expect(initialised('use(); var v = 1; function use() { PROBE(v); }')).toBe(true);
    expect(initialised('use(); function v() {} function use() { PROBE(v); }')).toBe(true);
    expect(initialised('function f(v) { use(); function use() { PROBE(v); } }')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Synthesised nodes still refuse
// ---------------------------------------------------------------------------

describe('a node with no position still answers with a refusal', () => {
  it('refuses a synthesised read, which is the state of everything this engine builds', () => {
    const p = probe('const K = 1; function use() { PROBE(K); } use();');
    // The same read, at the same scope, answers true when it carries its
    // position; the copy without one has no evidence to reason from.
    expect(isInitialisedBinding(p.node, p.scope)).toBe(true);
    const synthetic = t.identifier('K');
    expect(synthetic.start).toBeUndefined();
    expect(isInitialisedBinding(synthetic, p.scope)).toBe(false);
  });

  it('refuses when a call site is synthesised, so the chain has no position either', () => {
    const source = 'const K = 1; function use() { PROBE(K); } use();';
    const ast = parse(source, { sourceType: 'script' });
    let answer: boolean | undefined;
    traverse(ast, {
      Program(path) {
        // Replace the real `use()` with one an earlier pass could have built.
        const last = path.get('body').at(-1);
        last?.replaceWith(t.expressionStatement(t.callExpression(t.identifier('use'), [])));
        path.scope.crawl();
      },
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: 'PROBE' })) return;
        const argument = path.get('arguments')[0];
        if (argument?.isIdentifier()) answer = isInitialisedBinding(argument.node, argument.scope);
        path.stop();
      },
    });
    expect(answer).toBe(false);
  });
});
