import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type Binding } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { parameterValue } from '../src/analysis/parameters.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { foldConstantsPass } from '../src/passes/simplify/fold-constants.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { expectEquivalent, normalize, runPass } from './helpers.js';

/**
 * What the four migrated call sites do now that `util/purity.ts` answers for
 * them.
 *
 * `test/shared-purity-oracle.test.ts` pins the oracle's semantics. This file
 * pins the semantics of the PASSES that consume it, because "the shared
 * predicate is sound" and "swapping it in left every pass sound" are two
 * different claims, and one of them was false: `fold-constants.ts` was using
 * its private `isSideEffectFree` to answer a question that is not about purity
 * at all (see the `??` block below), and a like-for-like substitution there
 * would have deleted a live branch.
 *
 * Every assertion that a rewrite is legal is made by RUNNING the program before
 * and after, not by reading the output text. A rewrite that is merely different
 * is not a bug; a rewrite that computes something else is the only failure this
 * suite exists to catch.
 */

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Run a program in a fresh realm and return what it made observable.
 *
 * A throw is recorded by name: a throw that stops happening is exactly as much
 * of a behaviour change as a call that stops happening.
 */
function observe(code: string): string[] {
  const trace: string[] = [];
  const context = vm.createContext({
    LOG: (...args: unknown[]): void => {
      trace.push(args.map((value) => String(value)).join(' '));
    },
  });
  try {
    vm.runInContext(code, context, { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace;
}

/** Assert the pass preserved what the program does, whatever it did to the text. */
async function expectSameBehaviour(pass: Parameters<typeof runPass>[0], source: string) {
  const before = observe(source);
  const { code } = await runPass(pass, source);
  expect(observe(code)).toEqual(before);
  return code;
}

// ---------------------------------------------------------------------------
// fold-constants: the one call site that was not asking about purity
// ---------------------------------------------------------------------------

describe('simplify.fold-constants: `??` needs non-nullishness, not purity', () => {
  /**
   * The trap the migration had to see. `a ?? b` folds to `a` only when `a` can
   * never be nullish, and the pass used to spell that as "`a` is
   * side-effect-free" - sound only because its private oracle's accepted set,
   * minus the constants handled a line earlier, was exactly the object-producing
   * literals. The shared oracle accepts a plain initialised binding too, and a
   * binding holds whatever it holds.
   */
  const nullishBinding = [
    'function pick() { return null; }',
    'var a = pick();',
    "LOG(a ?? 'fallback');",
  ].join('\n');

  it('the hazard is real: the binding is nullish and the right side is what runs', () => {
    expect(observe(nullishBinding)).toEqual(['fallback']);
  });

  it('does not drop `?? right` for a name the shared oracle calls pure', async () => {
    const code = await expectSameBehaviour(foldConstantsPass, nullishBinding);
    expect(normalize(code)).toContain("'fallback'");
  });

  it('still drops `?? right` after an object literal, which is never nullish', async () => {
    const { code } = await runPass(foldConstantsPass, 'var v = {} ?? side();');
    expectEquivalent(code, 'var v = {};');
  });

  it('still drops `?? right` after a function literal', async () => {
    const { code } = await runPass(foldConstantsPass, 'var v = function () {} ?? side();');
    expectEquivalent(code, 'var v = function () {};');
  });
});

describe('simplify.fold-constants: the shared oracle widens what `void` and `typeof` fold', () => {
  it('folds `void` over an operand the private oracle could not evaluate', async () => {
    // `1 + 2` is side-effect-free but was not a shape `constantOf` reached, so
    // the old copy refused it and the fold never happened.
    const { code } = await runPass(foldConstantsPass, 'var u = void (1 + 2);');
    expectEquivalent(code, 'var u = undefined;');
  });

  it('refuses `void` over an operand that runs user code', async () => {
    await expectSameBehaviour(
      foldConstantsPass,
      ['var o = { valueOf: function () { LOG("valueOf"); return 1; } };', 'LOG(void -o);'].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// clean/unused: divergence 5, `{ a: b }` was refused by an over-broad test
// ---------------------------------------------------------------------------

describe('clean.unused: an object literal with a plain identifier value', () => {
  const source = ['function f(live) {', '  var dead = { a: live };', '  return live;', '}', 'LOG(f(7));'].join(
    '\n',
  );

  it('removes the declarator instead of demoting it to an expression statement', async () => {
    // `t.isPatternLike(t.identifier('b'))` is true, so the private copy refused
    // the commonest object literal there is and left `({ a: live });` behind.
    const code = await expectSameBehaviour(removeUnusedPass, source);
    expect(code).not.toContain('dead');
    expect(normalize(code)).not.toContain('{a:live}');
  });

  it('still refuses an object literal whose value is a real destructuring target', async () => {
    // `({ a: [b] } = src)` is a pattern, and its targets run getters and the
    // iterator protocol. The name goes, because nothing reads it; the WORK
    // stays, which is the whole difference from the case above.
    const source = [
      'function f(src) { var dead = ({ a: [b] } = src); return src.a[0]; }',
      'LOG(f({ a: [1] }), b);',
    ].join('\n');
    const code = await expectSameBehaviour(removeUnusedPass, source);
    expect(code.replace(/\s+/g, '')).toContain('({a:[b]}=src)');
  });

  it('still refuses a getter-bearing member read', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      ['function f(o) { var dead = o.k; return 1; }', 'LOG(f({ k: 1 }));'].join('\n'),
    );
    expect(code).toContain('o.k');
  });
});

// ---------------------------------------------------------------------------
// simplify/proxy-functions: divergence 4, shapes the private copy had no arm for
// ---------------------------------------------------------------------------

describe('simplify.proxy-functions: shapes the private copy refused through `default`', () => {
  /**
   * The wrapper ignores its second parameter, so the expansion drops that
   * argument and has to prove dropping it changes nothing. A template literal
   * with no substitutions is a constant, but the private copy had no
   * `TemplateLiteral` arm at all and refused the whole inline.
   */
  const templateArgument = [
    'function w(a, unusedArg) { return a + 1; }',
    'LOG(w(2, `abc`));',
  ].join('\n');

  it('inlines a wrapper whose dropped argument is an expression-free template', async () => {
    const code = await expectSameBehaviour(inlineProxyFunctionsPass, templateArgument);
    expect(normalize(code)).not.toContain('functionw(');
  });

  it('refuses when the dropped argument substitutes a value into the template', async () => {
    // `${o}` runs ToString, which is `o.toString()` - dropping the argument
    // drops that call.
    await expectSameBehaviour(
      inlineProxyFunctionsPass,
      [
        'function w(a, unusedArg) { return a + 1; }',
        'var o = { toString: function () { LOG("toString"); return "x"; } };',
        'LOG(w(2, `v${o}`));',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// analysis/parameters: divergence 3, the coercion rule regains its premise
// ---------------------------------------------------------------------------

/** The `param` binding named `p`, in the first function of `source`. */
function paramBinding(source: string, name: string): Binding {
  const ast = parse(source, { sourceType: 'script' });
  let found: Binding | undefined;
  traverse(ast, {
    Function(path) {
      const binding = path.scope.getBinding(name);
      if (binding?.kind === 'param') {
        found = binding;
        path.stop();
      }
    },
  });
  if (!found) throw new Error(`no param binding \`${name}\` in: ${source}`);
  return found;
}

describe('analysis.parameters: a coercing operator with its primitive proof', () => {
  /**
   * `prefix.quiet` asks whether anything evaluated before the assignment could
   * have called the hoisted `h`, which reads `p`. `-n` for `var n = 2` calls
   * nothing - but the private `cannotInvoke` refused every coercing operator
   * outright, with no primitive proof, so the whole parameter-as-local
   * equivalence was abandoned over an expression that provably invokes nothing.
   */
  const provablyPrimitive = [
    'function f(p) {',
    '  var n = 2;',
    '  var x = -n;',
    "  p = 'V';",
    '  function h() { return p; }',
    '  return h() + x;',
    '}',
  ].join('\n');

  it('proves the parameter equals its assigned value', () => {
    const value = parameterValue(paramBinding(provablyPrimitive, 'p'));
    expect(value).toBeDefined();
    expect(t.isStringLiteral(value!.init, { value: 'V' })).toBe(true);
  });

  it('still refuses when the operand can carry a `valueOf`', () => {
    // Same program, one binding changed: `-o` runs `o.valueOf()`, which is user
    // code, which could have called `h` and read the caller's `p`.
    const hazard = [
      'function f(p) {',
      '  var o = { valueOf: function () { return 1; } };',
      '  var x = -o;',
      "  p = 'V';",
      '  function h() { return p; }',
      '  return h() + x;',
      '}',
    ].join('\n');
    expect(parameterValue(paramBinding(hazard, 'p'))).toBeUndefined();
  });

  it('the hazard is real: `valueOf` can read the parameter before it is written', () => {
    const program = [
      'function f(p) {',
      '  var o = { valueOf: function () { LOG(h()); return 1; } };',
      '  var x = -o;',
      "  p = 'V';",
      '  function h() { return p; }',
      '  return h() + x;',
      '}',
      "LOG(f('from-caller'));",
    ].join('\n');
    // The first line is what the parameter held BEFORE the assignment, which is
    // the value the refused rewrite would have erased.
    expect(observe(program)).toEqual(['from-caller', 'V-1']);
  });

  it('still refuses when a statement before the write can invoke', () => {
    const invoking = [
      'function f(p) {',
      '  var x = side();',
      "  p = 'V';",
      '  function h() { return p; }',
      '  return h() + x;',
      '}',
    ].join('\n');
    expect(parameterValue(paramBinding(invoking, 'p'))).toBeUndefined();
  });
});
