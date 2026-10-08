import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { stringCodeFacts, type StringCodeFacts } from '../src/analysis/string-code.js';
import type { Pass } from '../src/pipeline/pass.js';
import {
  foldConstantsPass,
  resolveNumericVector,
} from '../src/passes/simplify/fold-constants.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * One question, asked at the six places in `simplify/fold-constants.ts` that
 * resolve a name: the two builtin arms of `resolveCall`, `resolveWrapperCall`,
 * `resolveFrozenTable`, `constantOf` and `literalFor`.
 *
 * Every proof that file makes is an account of two lists: `constantViolations`
 * ("nothing writes this name after its declarator") and `referencePaths`
 * ("these are all the uses"). Both ENUMERATE THE TREE, and code compiled from a
 * string at run time is not in the tree. `eval('T = [9, 2]')` writes `T`
 * without appearing in either list, so a table proved frozen is rewritten
 * between its declarator and the read; `eval('var parseInt = ...')` puts a
 * binding in front of a name `scope.getBinding` answers `undefined` for.
 *
 * The mechanism is `with`'s, one step further out. A `with` intercepts a name
 * at a POSITION, which is why the resolvers carry one; string code writes it at
 * a TIME, which no position can see. Both produce the same failure, and it is
 * the silent one: the folded program parses, runs, and computes something else.
 * So every case below is EXECUTED - in a fresh realm, before and after the
 * pass - rather than compared as text. A shape assertion cannot tell a refusal
 * from a fold that happened to be right.
 *
 * One of the sections below is the EMIT side, and it is the one an audit of the
 * readers misses. `literalFor` writes the name `undefined`, and a direct `eval`
 * can declare it: guarding every read still leaves a fold whose RESULT is
 * `undefined` spelling out a name the string code answers.
 *
 * Every section ends in controls. String code narrows what a name may mean and
 * nothing else, so `1 + 2` is still `3` in a file full of `eval`, and a
 * `Function` source that cannot spell `T` cannot reach `T`. A guard that also
 * refused those would be a pass quietly switching itself off.
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

/**
 * Run the pass and require the observable trace to be unchanged.
 *
 * `expected` is asserted against the FIXTURE first, so a repro that stops
 * demonstrating what it claims fails here rather than passing vacuously.
 */
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

/** Run the pass and require the fold to have happened. */
async function expectFolded(source: string, expected: string, folded: RegExp): Promise<void> {
  const code = await expectSameBehaviour(source, expected);
  expect(code, 'the control must still fold; a guard that refuses this is an off-switch').toMatch(
    folded,
  );
}

/**
 * The same, for a fixture whose whole point is that it is a MODULE.
 *
 * `vm.runInNewContext` compiles a script, and a script is the other half of the
 * distinction under test, so the module cases are written to a real `.mjs` and
 * imported - which is also the only way to observe that a `Function` body's
 * assignment lands on a global rather than on the module's binding of the same
 * name. The file name is unique because the module registry caches by URL.
 */
let moduleCounter = 0;
async function executeModule(code: string): Promise<string> {
  const trace: string[] = [];
  const holder = globalThis as unknown as Record<string, unknown>;
  const previous = holder['LOG'];
  holder['LOG'] = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const file = path.join(os.tmpdir(), `jsrift-fold-${process.pid}-${moduleCounter++}.mjs`);
  await fs.writeFile(file, code, 'utf8');
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  } finally {
    holder['LOG'] = previous;
    await fs.rm(file, { force: true });
  }
  return trace.join('\n');
}

async function expectFoldedModule(source: string, expected: string, folded: RegExp): Promise<void> {
  const before = await executeModule(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  const { code } = await runPass(foldConstantsPass, source);
  expect(await executeModule(code), 'behaviour changed').toBe(before);
  expect(code, 'the control must still fold; a guard that refuses this is an off-switch').toMatch(
    folded,
  );
}

// ---------------------------------------------------------------------------
// A name this pass follows to its binding
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: a table string code can reach', () => {
  /*
   * `resolveFrozenTable`'s licence is that the binding is "never written after
   * its declarator" and that "every reference is a member read". Both are read
   * out of the two lists, and both are false here while the lists stay empty.
   */
  it('refuses a table a direct eval reassigns', async () => {
    await expectSameBehaviour(
      `var T = [1, 2];
       eval('T = [9, 2];');
       LOG(T.slice(0, 2).join('-'));`,
      '9-2',
    );
  });

  it('refuses a table an eval nested in a function writes through', async () => {
    // The `eval` is not at program scope and the write is an element store, so
    // neither the read site nor the declarator is anywhere near it. What makes
    // it reachable is that every scope from the call site UP is reachable, and
    // the table's scope is one of them.
    await expectSameBehaviour(
      `var T = [1, 2];
       function poke() { eval('T[1] = 7;'); }
       poke();
       LOG(T.slice(0, 2).join('-'));`,
      '1-7',
    );
  });

  it('refuses a table a global-scope Function reassigns', async () => {
    // The other hazard, and not the same fact: no `eval` here at all. `T` is a
    // program-scope `var` in a script, so it is a property of the global
    // object, and a `Function` body assigns to it by name.
    await expectSameBehaviour(
      `var T = [1, 2];
       Function('T = [9, 2]')();
       LOG(T.slice(0, 2).join('-'));`,
      '9-2',
    );
  });

  it('folds a table no source in the program can spell', async () => {
    // The narrowing, and the reason this asks the shared fact rather than "is
    // there any string code": the `Function` source is readable and mentions
    // one name, which is not this one.
    await expectFolded(
      `var T = [1, 2];
       Function('other = 1')();
       LOG(T.slice(0, 2).join('-'));`,
      '1-2',
      /LOG\(['"]1-2['"]\)/,
    );
  });

  it('folds a table in a module, where global-scope code reaches nothing', async () => {
    // The second narrowing. A module's top level is a module environment
    // record, so `T` is not a global-object property and the `Function` body
    // assigns to an unrelated global of the same name - which the trace below
    // shows, since the fixture prints `1-2` before anything folds it.
    await expectFoldedModule(
      `export {};
       var T = [1, 2];
       Function('T = [9, 2]')();
       LOG(T.slice(0, 2).join('-'));`,
      '1-2',
      /LOG\(['"]1-2['"]\)/,
    );
  });

  it('folds a table when nothing in the program compiles a string', async () => {
    await expectFolded(
      `var T = [1, 2];
       LOG(T.slice(0, 2).join('-'));`,
      '1-2',
      /LOG\(['"]1-2['"]\)/,
    );
  });
});

describe('simplify.fold-constants: a wrapper string code can reach', () => {
  it('refuses a wrapper a direct eval reassigns', async () => {
    // `constantViolations` is empty: the assignment is inside a string, so the
    // template `resolveWrapperCall` builds describes a function this call no
    // longer reaches.
    await expectSameBehaviour(
      `function add(a, b) { return a + b; }
       eval('add = function () { return 101; };');
       LOG(add(1, 1));`,
      '101',
    );
  });

  it('refuses a wrapper whose free name string code rebinds', async () => {
    // The wrapper itself is clean - the source spells `T`, not `part`, so the
    // per-name answer for `part` is false and its own guard passes. The refusal
    // has to come from the name INSIDE the body, asked at the wrapper's own
    // position. This is why every hop asks, and why a single question at the
    // call site would not have been enough.
    await expectSameBehaviour(
      `var T = [1, 2];
       function part(a, b) { return T.slice(a, b).join('-'); }
       Function('T = [9, 8]')();
       LOG(part(0, 2));`,
      '9-8',
    );
  });

  it('folds a wrapper and its table when no string code exists', async () => {
    await expectFolded(
      `var T = [1, 2];
       function part(a, b) { return T.slice(a, b).join('-'); }
       LOG(part(0, 2));`,
      '1-2',
      /LOG\(['"]1-2['"]\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// A free name, which has no binding to ask about
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: a value global a direct eval declares', () => {
  /*
   * `undefined`, `NaN` and `Infinity` are foldable because they are
   * non-writable, non-configurable properties of the global object. That
   * licence survives every global-scope construct - `Function('undefined =
   * 5')()` changes nothing - and fails against exactly one: a sloppy direct
   * `eval`, whose `var` lands in the enclosing function's variable environment
   * and gets in front of the property.
   */
  it('refuses `undefined` where an eval declared it', async () => {
    await expectSameBehaviour(
      `function f() {
         eval('var undefined = 5;');
         return typeof undefined === 'number' ? 'y' : 'n';
       }
       LOG(f());`,
      'y',
    );
  });

  it('refuses `NaN` where an eval declared it', async () => {
    await expectSameBehaviour(
      `function f() {
         eval('var NaN = 1;');
         return NaN !== NaN;
       }
       LOG(f());`,
      'false',
    );
  });

  it('folds the value globals when nothing compiles a string', async () => {
    await expectFolded(
      `function f() { return typeof undefined === 'number' ? 'y' : 'n'; }
       LOG(f());`,
      'n',
      /return ['"]n['"]/,
    );
  });
});

describe('simplify.fold-constants: a global function string code replaces', () => {
  it('refuses `parseInt` where an eval declared a shadowing binding', async () => {
    await expectSameBehaviour(
      `function f() {
         eval('var parseInt = function () { return 99; };');
         return parseInt('12');
       }
       LOG(f());`,
      '99',
    );
  });

  it('refuses `parseInt` where a Function body assigned the global', async () => {
    // Not the name question the frozen table asks, and the reason this arm does
    // not use the per-name fact: `parseInt` is a property of the global object,
    // not a binding the program declares, so no name set drawn from the
    // program's own scopes bounds it. It is writable, and any string code at
    // all can write it.
    await expectSameBehaviour(
      `Function('parseInt = function () { return 99; }')();
       LOG(parseInt('12'));`,
      '99',
    );
  });

  it('refuses `String.fromCharCode` where a Function body replaced `String`', async () => {
    await expectSameBehaviour(
      `Function('String = { fromCharCode: function () { return "X"; } }')();
       LOG(String.fromCharCode(65));`,
      'X',
    );
  });

  it('folds the global functions when nothing compiles a string', async () => {
    await expectFolded(
      `LOG(parseInt('12'));
       LOG(String.fromCharCode(65));`,
      '12\nA',
      /LOG\(12\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// The emit side
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: writing the name `undefined`', () => {
  it('refuses to emit `undefined` where an eval declared it', async () => {
    // `void 0` folds to the VALUE undefined, and the only literal for that
    // value is the name. Reading `undefined` is guarded above; this is the
    // other direction, and no audit of the readers reaches it. The read of `x`
    // afterwards is not foldable, so a wrong emit survives into the trace.
    await expectSameBehaviour(
      `function f() {
         eval('var undefined = 5;');
         var x = void 0;
         return String(x);
       }
       LOG(f());`,
      'undefined',
    );
  });

  it('emits `undefined` when nothing compiles a string', async () => {
    await expectFolded(
      `function f() {
         var x = void 0;
         return String(x);
       }
       LOG(f());`,
      'undefined',
      /var x = undefined/,
    );
  });
});

// ---------------------------------------------------------------------------
// The exported entry point, which has no pass to take the facts from
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: resolveNumericVector', () => {
  /**
   * Collect the entry vector `f([...])` is called with, and the program's
   * string-code facts, from one run over one tree.
   */
  async function readVector(
    source: string,
  ): Promise<{ vector: NodePath<t.ArrayExpression>; strings: StringCodeFacts }> {
    let vector: NodePath<t.ArrayExpression> | undefined;
    let strings: StringCodeFacts | undefined;
    const capture: Pass = {
      id: 'test.capture-vector',
      title: 'Capture one entry vector and the string-code facts',
      stage: 'simplify',
      technique: 'core',
      run: (ctx) => {
        strings = stringCodeFacts(ctx);
        traverse(ctx.ast, {
          CallExpression(callPath) {
            if (!callPath.get('callee').isIdentifier({ name: 'f' })) return;
            const [argument] = callPath.get('arguments');
            if (argument?.isArrayExpression()) vector = argument;
          },
        });
      },
    };
    await runPass(capture, source);
    if (!vector || !strings) throw new Error('the fixture did not produce a vector');
    return { vector, strings };
  }

  const SOURCE = `var T = [1, 2];
     function part(a, b) { return T.slice(a, b); }
     f([...part(0, 2), 9]);
     eval('T = [8, 8];');`;

  it('refuses the vector when the caller hands it the facts', async () => {
    const { vector, strings } = await readVector(SOURCE);
    expect(resolveNumericVector(vector, strings)).toBeUndefined();
  });

  it('resolves it when the caller asks nothing, which is what the default says', async () => {
    // Pinned deliberately, not because it is right. `structure/register-vm` is
    // the one caller in `src` and passes nothing, so this is the behaviour that
    // pass gets today; the constant behind it says why refusing instead would
    // not make that pass sound, and what the one-line repair is.
    const { vector } = await readVector(SOURCE);
    expect(resolveNumericVector(vector)).toEqual([1, 2, 9]);
  });

  it('resolves it with facts when the program compiles no strings', async () => {
    const { vector, strings } = await readVector(
      `var T = [1, 2];
       function part(a, b) { return T.slice(a, b); }
       f([...part(0, 2), 9]);`,
    );
    expect(resolveNumericVector(vector, strings)).toEqual([1, 2, 9]);
  });
});

// ---------------------------------------------------------------------------
// Controls: the guards are about names, and only about names
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: string code does not switch the pass off', () => {
  it('still folds arithmetic in a program full of string code', async () => {
    // The `LOG` runs before the `setTimeout` this realm does not have, so the
    // folded value is observed rather than merely printed into the source.
    await expectFolded(
      `eval('x = 1;');
       Function('y = 2')();
       LOG(0x1 * 0x2 + 0x3);
       setTimeout('z = 3', 0);`,
      '5\nTHROWN ReferenceError: setTimeout is not defined',
      /LOG\(5\)/,
    );
  });

  it('still folds a chain that consults no name at all', async () => {
    await expectFolded(
      `eval('x = 1;');
       LOG('moc.elpmaxe.ppa'.split('').reverse().join(''));`,
      'app.example.com',
      /LOG\(['"]app.example.com['"]\)/,
    );
  });
});
