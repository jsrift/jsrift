import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { inferNames } from '../src/naming/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * `naming/index.ts` asking `analysis/string-code.ts` which names string code can
 * reach, instead of running its own inventory of the shapes.
 *
 * The pass had its own visitor pair - `CallExpression` and `NewExpression`, each
 * calling `freezeHazardKind` - and a shared *classifier* is not a shared
 * *analysis*: a shape that is neither of those two node types was never
 * classified at all, however well the classifier handled it. `Function?.(src)`
 * is an `OptionalCallExpression`, so it was invisible, and the pass renamed
 * program-scope bindings out from under a live hazard. That is the first
 * describe below, and both cases in it are executed rather than inspected,
 * because the defect produces a program that parses, reads better than the
 * input, and throws.
 *
 * `eval?.(src)` was the same node type and did NOT miscompile, for a reason that
 * had nothing to do with the hazard analysis: `recordFreeIdentifier` visits
 * every identifier, and the bare `eval` in its callee is one, so the name - not
 * the call - is what froze program scope. The second describe pins that the
 * shared fact now carries those shapes on its own, which is what makes deleting
 * that clause a simplification rather than a regression.
 *
 * The third and fourth describes pin the two things the migration deliberately
 * did NOT do: `ScopeFreezer` stays, because it answers a question the shared
 * fact does not; and the global arm stays blunt at program scope, because this
 * is the one consumer that also *mints* names.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run in a fresh realm and report what it printed and what it threw.
 *
 * The sandbox is its own `globalThis` so that a script's top-level `var` really
 * is a global-object property, which is the whole premise of the `'global'`
 * hazard. `LOG` is a global function rather than `console.log` so that code
 * compiled from a string can reach it the same way the program does.
 */
function execute(code: string): string {
  const trace: string[] = [];
  const sandbox: Record<string, unknown> = {
    LOG: (...parts: unknown[]) => trace.push(parts.map(String).join(' ')),
  };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const thrown = error as Error;
    trace.push(`THROWN ${thrown.name}: ${thrown.message}`);
  }
  return trace.join('|');
}

/** The only assertion that catches this class of defect: run both programs. */
function expectSameBehaviour(source: string, output: string): void {
  expect(`${execute(output)}   <- ${output.replace(/\s+/g, ' ')}`).toBe(
    `${execute(source)}   <- ${output.replace(/\s+/g, ' ')}`,
  );
}

const AGGRESSIVE: DeobfuscateOptions = { preset: 'aggressive' };

async function renamesOf(source: string, options: DeobfuscateOptions = AGGRESSIVE) {
  const { ctx } = await runPass(pass, source, options);
  return ctx.renames.map((entry) => `${entry.from}->${entry.to}`);
}

async function codeOf(source: string, options: DeobfuscateOptions = AGGRESSIVE) {
  const { code } = await runPass(pass, source, options);
  return code;
}

function programPathOf(ast: t.File): NodePath<t.Program> {
  let program: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program as unknown as NodePath<t.Program>;
}

// ---------------------------------------------------------------------------
// The miscompile
// ---------------------------------------------------------------------------

describe('rename.identifiers: an optional call compiles code too', () => {
  // `Function?.(...)` rather than `Function(...)`: the plain spelling is opened by
  // `unpack/function-constructor.ts` into an ordinary IIFE before naming ever
  // runs, which renames the binding and the string's mention of it together and
  // so cannot show this defect. The optional call is left standing, so what
  // reaches the renamer is a hazard nothing else has neutralised.
  const SOURCE = `var K = 'kept';\nFunction?.('LOG(K)')();`;

  it('does not rename a program-scope binding the compiled source names', async () => {
    expect(await renamesOf(SOURCE)).toEqual([]);
  });

  it('keeps that program running, through the whole engine', async () => {
    const { code } = await deobfuscate(SOURCE, AGGRESSIVE);
    // Stated as the observable rather than the shape: before this migration the
    // output was `var str1 = 'kept'; Function?.('LOG(K)')();`, which throws
    // `ReferenceError: K is not defined`.
    expectSameBehaviour(SOURCE, code);
    expect(execute(code)).toBe('kept');
  });

  it('covers the shape where the compiled function is called later', async () => {
    const source = `var K = 'kept';\nvar g = Function?.('return LOG(K)');\ng();`;
    const { code } = await deobfuscate(source, AGGRESSIVE);
    expectSameBehaviour(source, code);
    expect(execute(code)).toBe('kept');
  });

  it('still classifies the two node types the old visitor pair did see', async () => {
    expect(await renamesOf(`var K = 'kept';\nFunction('LOG(K)')();`)).toEqual([]);
    expect(await renamesOf(`var K = 'kept';\nnew Function('LOG(K)')();`)).toEqual([]);
    expect(await renamesOf(`var K = 'kept';\n(function () {}).constructor('LOG(K)')();`)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// The `eval` clause `recordFreeIdentifier` used to carry
// ---------------------------------------------------------------------------

describe('rename.identifiers: the eval backstop is redundant, not load-bearing', () => {
  it('freezes an optional eval call, which the deleted clause used to catch', async () => {
    const source = `var K = 'kept';\neval?.('LOG(K)');`;
    expect(await renamesOf(source)).toEqual([]);
    const { code } = await deobfuscate(source, AGGRESSIVE);
    expectSameBehaviour(source, code);
    expect(execute(code)).toBe('kept');
  });

  it('freezes eval taken as a value, which is the shape no call site can see', async () => {
    const source = `var K = 'kept';\nvar e = eval;\ne('LOG(K)');`;
    expect(await renamesOf(source)).toEqual([]);
    const { code } = await deobfuscate(source, AGGRESSIVE);
    expectSameBehaviour(source, code);
    expect(execute(code)).toBe('kept');
  });

  it('freezes eval reached through a member or a sequence', async () => {
    expect(await renamesOf(`var K = 'kept';\nglobalThis.eval('LOG(K)');`)).toEqual([]);
    expect(await renamesOf(`var K = 'kept';\n(0, eval)('LOG(K)');`)).toEqual([]);
  });

  /**
   * The one place the two answers disagree, and the deleted clause was the
   * wrong one. `eval` is not a constructor, so `new eval(src)` throws before it
   * compiles anything: it addresses no name and freezes nothing.
   * `isDirectEvalCallee` tested for a `CallExpression`, so it read this as an
   * indirect eval and surrendered program scope for a call that never runs.
   */
  it('does not freeze `new eval(src)`, which compiles nothing', async () => {
    const source = `var K = 'kept';\nLOG(K);\ntry {\n  new eval('LOG("reached")');\n} catch (err) {\n  LOG('threw');\n}`;
    const renames = await renamesOf(source);
    expect(renames.length).toBeGreaterThan(0);
    expect(renames.some((entry) => entry.startsWith('K->'))).toBe(true);
    expectSameBehaviour(source, await codeOf(source));
  });
});

// ---------------------------------------------------------------------------
// What ScopeFreezer is still for
// ---------------------------------------------------------------------------

describe('rename.identifiers: ScopeFreezer keeps the capture half', () => {
  /**
   * A binding in a scope nested BELOW a direct `eval` - not on the chain the
   * `eval` can read, so `StringCodeFacts.reaches` is false for it and the
   * shared fact alone would allow the rename. What is unsound is the other
   * direction: `eval` can declare `q` in `outer`, and a free `q` inside `inner`
   * then resolves to it, so a rename that puts `q` on an unrelated binding of
   * `inner` captures the reference. The freeze is over-approximate - it costs
   * every name in every scope under the call - and there is nothing narrower
   * available, because what the injected source declares is exactly what a
   * source we cannot read does not say.
   */
  const SOURCE = `function outer(src) {
  eval(src);
  function inner() {
    var _0x4a68 = new Map();
    _0x4a68.set('k', 7);
    return _0x4a68;
  }
  return inner;
}`;

  it('refuses a binding below the call site, which no name can address', async () => {
    expect(await renamesOf(SOURCE)).toEqual([]);
  });

  it('refuses the call site scope and the chain above it too', async () => {
    expect(
      await renamesOf(`var _0x4a68 = new Map();
function outer(src) {
  var _0x91 = 1;
  eval(src);
  return _0x91 + _0x4a68.size;
}`),
    ).toEqual([]);
  });

  it('leaves a sibling scope alone: a direct eval is not a whole-file freeze', async () => {
    const code = await codeOf(`function outer(src) {
  eval(src);
}
function sibling() {
  var _0x4a68 = new Map();
  _0x4a68.set('k', 7);
  return _0x4a68;
}`);
    expect(code).toContain('var map = new Map()');
  });
});

// ---------------------------------------------------------------------------
// Why the global arm is not narrowed by name here
// ---------------------------------------------------------------------------

describe('rename.identifiers: the global arm stays blunt at program scope', () => {
  /**
   * `StringCodeFacts.addresses` answers "can the source spell the name this
   * binding HAS". Renaming also needs "can it spell the name we are about to
   * GIVE it" - `Function('X = 1')()` beside a program-scope `var Z` renamed to
   * `X` lets the string clobber Z - and the fact has no predicate for that, so
   * a script's program scope is refused whole rather than per name.
   *
   * The source here mentions neither binding, so the read direction alone would
   * allow both renames. The refusal is the write direction, and this test is
   * what would notice if a later change narrowed the arm by name and took the
   * one direction without the other.
   */
  const SOURCE = `Function('return 1')();
var _0x4a68 = new Map();
_0x4a68.set('k', 7);
function _0xouter() {
  var _0x91 = new Map();
  _0x91.set('k', 7);
  return _0x91;
}`;

  it('refuses a program-scope binding the source does not mention', async () => {
    expect(await renamesOf(SOURCE)).not.toContain('_0x4a68->map');
  });

  it('still renames inside a function, so one call is not a whole-file freeze', async () => {
    expect(await codeOf(SOURCE)).toContain('var map = new Map()');
  });

  /**
   * The narrowing that IS taken, and it is not about names: in a module the top
   * level is a module environment record, which global-scope code has no path
   * to at all, so `Function(src)` freezes nothing there. `ScopeFreezer` was
   * never told which kind of program it was looking at and so froze both.
   *
   * Run through `inferNames` rather than `deobfuscate` so the two programs
   * differ in exactly one bit - the parser's resolved `sourceType` - with the
   * same text, the same options and the same rules on both sides.
   */
  it('renames a module program scope that a script would refuse', () => {
    const source = `var _0x4a68 = new Map();\n_0x4a68.set('k', 7);\nFunction('return 1')();`;
    const asScript = inferNames(
      programPathOf(parseSource(source, { sourceType: 'script' }).ast),
      { sourceType: 'script' },
    );
    const asModule = inferNames(
      programPathOf(parseSource(source, { sourceType: 'module' }).ast),
      { sourceType: 'module' },
    );
    expect(asScript.renames.map((entry) => `${entry.from}->${entry.to}`)).toEqual([]);
    expect(asModule.renames.map((entry) => `${entry.from}->${entry.to}`)).toEqual([
      '_0x4a68->map',
    ]);
  });

  /**
   * The refusal has to be reported, or a file whose whole program scope was
   * left alone comes back claiming full coverage. `ScopeFreezer.empty` used to
   * carry this through its `globalOnly` flag; the flag is no longer set, so the
   * count of string-code refusals is what carries it now.
   */
  it('reports the refusal as partial coverage', async () => {
    const { ctx } = await runPass(pass, SOURCE, AGGRESSIVE);
    expect(ctx.diagnostics.some((note) => note.message.includes('left unrenamed'))).toBe(true);
  });

  it('claims full coverage when there is no string code at all', async () => {
    const { ctx } = await runPass(
      pass,
      `var _0x4a68 = new Map();\n_0x4a68.set('k', 7);`,
      AGGRESSIVE,
    );
    expect(ctx.diagnostics.some((note) => note.message.includes('left unrenamed'))).toBe(false);
  });
});
