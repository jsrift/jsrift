import * as t from '@babel/types';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseSource } from '../src/frontend/language.js';
import { removeDeadBranchesPass } from '../src/passes/clean/dead-branches.js';
import { inlineObjectMapsPass } from '../src/passes/simplify/object-maps.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const UNWRAP_PASSES = [inlineObjectMapsPass, inlineProxyFunctionsPass];

async function proxies(source: string, options: DeobfuscateOptions = {}): Promise<string> {
  return (await runPass(inlineProxyFunctionsPass, source, options)).code;
}

async function maps(source: string, options: DeobfuscateOptions = {}): Promise<string> {
  return (await runPass(inlineObjectMapsPass, source, options)).code;
}

/**
 * Run the snippet and hand back `out`.
 *
 * Comparing the value before and against after is the only assertion that
 * actually catches a precedence or evaluation-order mistake; comparing printed
 * text just proves the printer is consistent with itself.
 */
function evaluate(code: string): unknown {
  return new Function(`${code}\nreturn out;`)() as unknown;
}

function expectSameBehaviour(source: string, output: string): void {
  assertParses(output);
  expect(evaluate(output)).toEqual(evaluate(source));
}

/**
 * A helper the proxy pass refuses to inline, because its body is two statements.
 *
 * Purity tests need an argument that stays impure through the whole run: a
 * one-line `function side(v) { return v; }` would be inlined *first* (expansion
 * is bottom-up), leaving a literal behind and quietly making the purity
 * precondition hold after all.
 */
const OPAQUE = 'function side(v) { var kept = v; return kept; }\n';

describe('simplify.proxy-functions', () => {
  it('inlines a binary forwarder at every call site', async () => {
    const source = 'function _0x1(a, b) { return a + b; }\nvar out = [_0x1(1, 2), _0x1(3, 4)];';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = [1 + 2, 3 + 4];');
    expectSameBehaviour(source, output);
  });

  it('inlines a call forwarder', async () => {
    const source = 'function _0x1(f, x) { return f(x); }\nvar out = _0x1(isNaN, "x");';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = isNaN("x");');
    expectSameBehaviour(source, output);
  });

  it('inlines a unary wrapper held in a variable', async () => {
    const source = 'var _0x1 = function (a) { return !a; };\nvar out = _0x1(0);';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = !0;');
    expectSameBehaviour(source, output);
  });

  it('inlines an arrow with an expression body', async () => {
    const source = 'const _0x1 = (a, b) => a * b;\nvar out = _0x1(6, 7);';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = 6 * 7;');
    expectSameBehaviour(source, output);
  });

  it('inlines a `new` forwarder', async () => {
    const source = 'function _0x1(C, v) { return new C(v); }\nvar out = _0x1(Number, "8") + 1;';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = new Number("8") + 1;');
    expectSameBehaviour(source, output);
  });

  it('inlines a computed-member forwarder', async () => {
    const source = 'function _0x1(o, k) { return o[k]; }\nvar out = _0x1({ a: 5 }, "a");';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = { a: 5 }["a"];');
    expectSameBehaviour(source, output);
  });

  it('inlines a wrapper that takes no parameters', async () => {
    const source = 'function _0x1() { return 42; }\nvar out = _0x1() + 1;';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = 42 + 1;');
    expectSameBehaviour(source, output);
  });

  it('preserves precedence when the expansion lands inside a tighter operator', async () => {
    const source = 'function _0x1(a, b) { return a + b; }\nvar out = 2 * _0x1(3, 4);';
    const output = await proxies(source);
    // 2 * 3 + 4 would be 10; the parenthesised form is 14.
    expect(output).toContain('2 * (3 + 4)');
    expectSameBehaviour(source, output);
  });

  it('preserves precedence for a nested proxy call', async () => {
    const source =
      'function _0x1(a, b) { return a + b; }\n' +
      'function _0x2(a, b) { return a * b; }\n' +
      'var out = _0x2(_0x1(1, 2), _0x1(3, 4));';
    const output = await proxies(source);
    expect(output).toContain('(1 + 2) * (3 + 4)');
    expectSameBehaviour(source, output);
  });

  it('keeps argument evaluation order', async () => {
    const source =
      'var log = [];\n' +
      'function tap(v) { log.push(v); return v; }\n' +
      'function _0x1(a, b) { return a - b; }\n' +
      'var out = [_0x1(tap(9), tap(4)), log.join(",")];';
    const output = await proxies(source);
    expect(output).toContain('tap(9) - tap(4)');
    expectSameBehaviour(source, output);
  });

  it('removes the wrapper once every call site is expanded', async () => {
    const output = await proxies('function _0x1(a, b) { return a | b; }\nvar out = _0x1(1, 2);');
    expect(output).not.toContain('_0x1');
  });

  // The search for a reference the analysis missed is deferred until a wrapper
  // is otherwise ready to be deleted, and is then run over the scope that owns
  // the binding rather than over the program. These three cover the shapes that
  // makes a difference to: a nested owner, two wrappers sharing one owner, and a
  // same-named binding in a sibling scope that must not be mistaken for a use.
  it('removes a wrapper declared inside a function once it is expanded', async () => {
    const source =
      'function host(p) { function _0x1(a, b) { return a * b; } return _0x1(p, 3); }\nvar out = host(4);';
    const output = await proxies(source);
    expect(output).not.toContain('_0x1');
    expectSameBehaviour(source, output);
  });

  it('removes two wrappers declared in the same scope', async () => {
    const source =
      'function _0x1(a, b) { return a + b; }\n' +
      'function _0x2(a, b) { return a - b; }\n' +
      'var out = [_0x1(5, 2), _0x2(5, 2)];';
    const output = await proxies(source);
    expect(output).not.toContain('_0x1');
    expect(output).not.toContain('_0x2');
    expectSameBehaviour(source, output);
  });

  it('is not fooled by an unrelated binding of the same name elsewhere', async () => {
    const source =
      'function _0x1(a, b) { return a + b; }\n' +
      'function other() { var _0x1 = 99; return _0x1; }\n' +
      'var out = [_0x1(1, 2), other()];';
    const output = await proxies(source);
    expect(output).toContain('var _0x1 = 99');
    expect(output).not.toContain('_0x1(1, 2)');
    expectSameBehaviour(source, output);
  });

  it('keeps a wrapper alive when only some call sites can be expanded', async () => {
    // The second site passes a member expression into callee position, which
    // would change `this`; the first is fine.
    const source =
      'function _0x1(f, x) { return f(x); }\n' +
      'var o = { m: function (v) { return this === o ? "bound" : "free"; } };\n' +
      'var out = [_0x1(String, 1), _0x1(o.m, 2)];';
    const output = await proxies(source);
    expect(output).toContain('String(1)');
    expect(output).toContain('_0x1(o.m, 2)');
    expectSameBehaviour(source, output);
  });

  it('refuses a parameter that is read twice', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a) { return a + a; }\nvar out = _0x1(1);',
    );
  });

  it('refuses a reassigned binding', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a, b) { return a + b; }\n_0x1 = function () { return 0; };\nvar out = _0x1(1, 2);',
    );
  });

  it('refuses a wrapper that is also used as a value', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a, b) { return a + b; }\nvar out = [_0x1(1, 2), [3, 4].reduce(_0x1)];',
    );
  });

  it('refuses a wrapper invoked with `new`', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a) { return a + 1; }\nvar out = new _0x1(1);',
    );
  });

  it('refuses a body that reads a free variable', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'var k = 3;\nfunction _0x1(a) { return a + k; }\nvar out = _0x1(1);',
    );
  });

  it('refuses a body that reads `this`', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a) { return this[a]; }\nvar out = _0x1("x");',
    );
  });

  it('refuses a body that reads `arguments`', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a) { return arguments.length; }\nvar out = _0x1(1);',
    );
  });

  it('refuses a body of more than one statement', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a) { var b = a; return b; }\nvar out = _0x1(1);',
    );
  });

  it('refuses rest, default and destructuring parameters', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(...a) { return a; }\nvar out = _0x1(1);',
    );
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x2(a = 1) { return a; }\nvar out = _0x2(2);',
    );
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x3({ a }) { return a; }\nvar out = _0x3({ a: 1 });',
    );
  });

  it('refuses async and generator wrappers', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'async function _0x1(a) { return a; }\nvar out = _0x1(1);',
    );
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function* _0x2(a) { return a; }\nvar out = _0x2(1);',
    );
  });

  it('refuses a spread argument', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a, b) { return a + b; }\nvar args = [1, 2];\nvar out = _0x1(...args);',
    );
  });

  it('refuses a call with fewer arguments than parameters', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a, b) { return a + b; }\nvar out = _0x1(1);',
    );
  });

  it('drops an unused parameter only when its argument is pure', async () => {
    const pure = await proxies('function _0x1(a, b) { return a; }\nvar out = _0x1(1, 2);');
    expectEquivalent(pure, 'var out = 1;');

    await expectNoChange(
      inlineProxyFunctionsPass,
      `${OPAQUE}function _0x1(a, b) { return a; }\nvar out = _0x1(1, side(2));`,
    );
  });

  it('drops a surplus argument only when it is pure', async () => {
    const pure = await proxies('function _0x1(a) { return a; }\nvar out = _0x1(1, 2);');
    expectEquivalent(pure, 'var out = 1;');

    await expectNoChange(
      inlineProxyFunctionsPass,
      `${OPAQUE}function _0x1(a) { return a; }\nvar out = _0x1(1, side(2));`,
    );
  });

  it('reorders parameters only when every argument is pure', async () => {
    const source = 'function _0x1(a, b) { return b - a; }\nvar out = _0x1(1, 5);';
    const output = await proxies(source);
    expectEquivalent(output, 'var out = 5 - 1;');
    expectSameBehaviour(source, output);

    // Swapping `side(1)` and `side(5)` would swap their observable order.
    await expectNoChange(
      inlineProxyFunctionsPass,
      `${OPAQUE}function _0x1(a, b) { return b - a; }\nvar out = _0x1(side(1), side(5));`,
    );
  });

  it('inlines a short-circuit wrapper only when both arguments are pure', async () => {
    const source = 'function _0x1(a, b) { return a && b; }\nvar out = _0x1(1, 2);';
    expectEquivalent(await proxies(source), 'var out = 1 && 2;');

    // The wrapper evaluated the right-hand argument eagerly; `a && b` would not.
    await expectNoChange(
      inlineProxyFunctionsPass,
      `${OPAQUE}function _0x1(a, b) { return a && b; }\nvar out = _0x1(side(0), side(1));`,
    );
  });

  it('refuses to move a member expression into callee position', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(f, x) { return f(x); }\nvar o = { m: function (v) { return v; } };\nvar out = _0x1(o.m, 1);',
    );
  });

  it('respects functionUnwrapping.maxInlineSize', async () => {
    const source =
      'function _0x1(a, b) { return a + b + 1 + 2 + 3 + 4 + 5; }\nvar out = [_0x1(1, 2), _0x1(3, 4)];';
    await expectNoChange(inlineProxyFunctionsPass, source, {
      techniques: { functionUnwrapping: { maxInlineSize: 4, inlineSingleUse: false } },
    });
  });

  it('waives the size limit for a single call site when inlineSingleUse is on', async () => {
    const source = 'function _0x1(a, b) { return a + b + 1 + 2 + 3; }\nvar out = _0x1(1, 2);';
    await expectNoChange(inlineProxyFunctionsPass, source, {
      techniques: { functionUnwrapping: { maxInlineSize: 4, inlineSingleUse: false } },
    });
    const inlined = await proxies(source, {
      techniques: { functionUnwrapping: { maxInlineSize: 4, inlineSingleUse: true } },
    });
    expect(inlined).not.toContain('_0x1(');
  });

  it('expands an identity wrapper without losing its argument', async () => {
    const source = 'function _0x1(a) { return a; }\nvar out = _0x1(1 + 2) * 3;';
    const output = await proxies(source);
    expect(output).toContain('(1 + 2) * 3');
    expectSameBehaviour(source, output);
  });

  it('expands a wrapper declared inside a loop', async () => {
    const source =
      'var out = 0;\nfor (var i = 0; i < 3; i++) {\n' +
      '  var _0x1 = function (a, b) { return a + b; };\n' +
      '  out = _0x1(out, i);\n}';
    const output = await proxies(source);
    expect(output).toContain('out + i');
    expectSameBehaviour(source, output);
  });

  it('moves a comment down rather than deleting it with the wrapper', async () => {
    const output = await proxies(
      'function _0x1(a, b) { return a + b; }\n// keep me\nvar out = _0x1(1, 2);',
    );
    expect(output).toContain('keep me');
  });

  it('refuses a TypeScript overload set', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a: number): number;\nfunction _0x1(a: any) { return a; }\nvar out = _0x1(1);',
      { language: 'ts' },
    );
  });

  it('leaves a JSX component alone', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function Box(p) { return p.children; }\nvar out = <Box>hi</Box>;',
      { language: 'jsx' },
    );
  });

  it('does nothing when the technique is disabled', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function _0x1(a, b) { return a + b; }\nvar out = _0x1(1, 2);',
      { techniques: { functionUnwrapping: false } },
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      inlineProxyFunctionsPass,
      'function _0x1(a, b) { return a + b; }\n' +
        'function _0x2(a) { return !a; }\n' +
        'var out = _0x2(_0x1(1, 2));',
    );
  });
});

describe('simplify.object-maps', () => {
  it('inlines literal-valued keys and drops the map', async () => {
    const source =
      "var _0x47 = { 'vksOM': 'toUpperCase', 'acRbf': 'ab' };\n" +
      'var out = _0x47.acRbf[_0x47.vksOM]();';
    const output = await maps(source);
    expectEquivalent(output, "var out = 'ab'['toUpperCase']();");
    expectSameBehaviour(source, output);
  });

  it('reads a computed string key the same as a dotted one', async () => {
    const source = "var _0x47 = { 'a': 1, 'b': 2 };\nvar out = _0x47['a'] + _0x47.b;";
    const output = await maps(source);
    expectEquivalent(output, 'var out = 1 + 2;');
    expectSameBehaviour(source, output);
  });

  it('beta-reduces a function-valued key at its call site', async () => {
    const source =
      "var _0x47 = { 'SwUka': function (a, b) { return a + b; }, 'QrHIQ': function (a, b) { return a < b; } };\n" +
      'var out = [_0x47.SwUka(1, 2), _0x47.QrHIQ(1, 2)];';
    const output = await maps(source);
    expectEquivalent(output, 'var out = [1 + 2, 1 < 2];');
    expectSameBehaviour(source, output);
  });

  it('preserves precedence when a wrapper expands inside a tighter operator', async () => {
    const source =
      "var _0x47 = { 'SwUka': function (a, b) { return a + b; } };\nvar out = 2 * _0x47.SwUka(3, 4);";
    const output = await maps(source);
    expect(output).toContain('2 * (3 + 4)');
    expectSameBehaviour(source, output);
  });

  it('collapses the transformObjectKeys assignment run and its alias', async () => {
    const source =
      'var _0x8c = {};\n' +
      "_0x8c['host'] = 'example.com';\n" +
      "_0x8c['add'] = function (a, b) { return a + b; };\n" +
      'var _0x28 = _0x8c;\n' +
      'var out = [_0x28.host, _0x28.add(1, 2)];';
    const output = await maps(source);
    expectEquivalent(output, "var out = ['example.com', 1 + 2];");
    expectSameBehaviour(source, output);
  });

  it('refuses an assignment run that is interrupted before the alias', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      'var _0x8c = {};\n' +
        "_0x8c['a'] = 1;\n" +
        'sideEffect(_0x8c);\n' +
        "_0x8c['b'] = 2;\n" +
        'var out = _0x8c.a;',
    );
  });

  it('takes a constant property write that precedes every read as an entry', async () => {
    // How the control-flow storage object comes out of a partial
    // `transformObjectKeys`: the literal, then the rest of the table written
    // key by key before anything reads it.
    const source = "var _0x47 = { 'a': 1 };\n_0x47.b = 2;\n_0x47.f = function (p, q) { return p < q; };\nvar out = [_0x47.a, _0x47.b, _0x47.f(1, 2)];";
    const output = await maps(source);
    expectEquivalent(output, 'var out = [1, 2, 1 < 2];');
    expectSameBehaviour(source, output);
  });

  it('refuses a map that is written to after it is read', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nvar out = _0x47.a;\n_0x47.b = 2;\nout += _0x47.b;",
    );
  });

  it('refuses a write to a key the literal already holds', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\n_0x47.a = 2;\nvar out = _0x47.a;",
    );
  });

  it('refuses a reassigned map', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\n_0x47 = { 'a': 2 };\nvar out = _0x47.a;",
    );
  });

  it('refuses a map that is iterated', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nvar out = [];\nfor (var k in _0x47) out.push(_0x47.a);",
    );
  });

  it('refuses a map handed to Object.keys', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nvar out = Object.keys(_0x47).length + _0x47.a;",
    );
  });

  it('refuses a map passed as a value', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nfunction use(o) { return o.a; }\nvar out = use(_0x47) + _0x47.a;",
    );
  });

  it('refuses a map that is spread', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nvar copy = { ..._0x47 };\nvar out = copy.a + _0x47.a;",
    );
  });

  it('refuses a read of a key the map does not define', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nvar out = _0x47.a + (_0x47.b || 0);",
    );
  });

  it('refuses a read through a computed key it cannot resolve', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1 };\nvar k = 'a';\nvar out = _0x47[k];",
    );
  });

  it('refuses a wrapper entry that is handed out instead of called', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'f': function (a, b) { return a + b; } };\nvar out = [1, 2].reduce(_0x47.f);",
    );
  });

  it('refuses a map with a non-constant value', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var seed = 1;\nvar _0x47 = { 'a': seed };\nvar out = _0x47.a;",
    );
  });

  it('refuses a `__proto__` key', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { '__proto__': null, 'a': 1 };\nvar out = _0x47.a;",
    );
  });

  it('refuses a map with a getter or a shorthand method', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { get a() { return 1; } };\nvar out = _0x47.a;",
    );
    await expectNoChange(
      inlineObjectMapsPass,
      'var _0x48 = { a(x) { return x; } };\nvar out = _0x48.a(1);',
    );
  });

  it('keeps the wrapper hazards that apply to plain proxies', async () => {
    // Callee position: `o.m` would gain a receiver it did not have.
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'f': function (g, x) { return g(x); } };\n" +
        'var o = { m: function (v) { return v; } };\n' +
        'var out = _0x47.f(o.m, 1);',
    );
    // Short-circuit: the wrapper evaluated both arguments eagerly.
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x48 = { 'f': function (a, b) { return a || b; } };\n" +
        'function side() { return 1; }\nvar out = _0x48.f(side(), side());',
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 'x', 'f': function (p, q) { return p + q; } };\n" +
        'var out = _0x47.f(_0x47.a, "y");',
    );
  });

  // -------------------------------------------------------------------------
  // Entries nothing reads
  // -------------------------------------------------------------------------

  /**
   * A map that has to survive: `f` is a short-circuit wrapper handed an impure
   * argument, so expanding the call would move a side effect behind a `||` and
   * the pass correctly refuses. Everything else in the table is dead weight.
   */
  const SURVIVOR =
    "var _0x47 = { 'f': function (a, b) { return a || b; }, 'g': 'never-read', 'h': function (p, q) { return p - q; } };\n" +
    'function side() { return 1; }\n' +
    'var out = _0x47.f(side(), side());';

  it('drops the entries nothing reads from a map that has to survive', async () => {
    const output = await maps(SURVIVOR);
    // The refused read still needs its entry.
    expect(output).toContain('a || b');
    // The other 2,197 keys of the fixture's biggest map were exactly this.
    expect(output).not.toContain('never-read');
    expect(output).not.toContain('p - q');
    expectSameBehaviour(SURVIVOR, output);
  });

  it('drops an entry whose only read it just inlined', async () => {
    const source =
      "var _0x47 = { 'f': function (a, b) { return a || b; }, 'g': 2 };\n" +
      'function side() { return 1; }\n' +
      'var out = [_0x47.f(side(), side()), _0x47.g];';
    const output = await maps(source);
    expect(output).toContain('a || b');
    expect(output).not.toContain('g:');
    expect(output).not.toContain("'g'");
    expectSameBehaviour(source, output);
  });

  it('is idempotent when all it can do is prune', async () => {
    await expectIdempotent(inlineObjectMapsPass, SURVIVOR);
  });

  it('keeps every entry of a map that escapes, read or not', async () => {
    // Once the object is handed out, an unread key is only unread *here*.
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1, 'b': 2 };\nsink(_0x47);\nvar out = _0x47.a;",
    );
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1, 'b': 2 };\nfor (var k in _0x47) log(k);\nvar out = _0x47.a;",
    );
  });

  it('keeps an unread entry a comment describes', async () => {
    const source =
      "var _0x47 = { 'f': function (a, b) { return a || b; }, /* deliberate */ 'g': 7 };\n" +
      'function side() { return 1; }\n' +
      'var out = _0x47.f(side(), side());';
    const output = await maps(source);
    expect(output).toContain('deliberate');
  });

  it('never prunes a map down to nothing', async () => {
    // The surviving read pins its own key, so the object is never emptied out
    // from under the reference that kept it alive.
    const output = await maps(SURVIVOR);
    const { changes } = await runPass(inlineObjectMapsPass, output);
    expect(changes).toBe(0);
    expect(output).toContain('_0x47.f(side(), side())');
  });
});

describe('the two unwrapping passes together', () => {
  it('expands a map wrapper whose argument is a proxy call', async () => {
    const source =
      'function _0x1(a, b) { return a * b; }\n' +
      "var _0x47 = { 'SwUka': function (a, b) { return a + b; } };\n" +
      'var out = _0x47.SwUka(_0x1(2, 3), 4);';
    const result = await runPass(UNWRAP_PASSES, source);
    expect(result.code).toContain('2 * 3 + 4');
    expectSameBehaviour(source, result.code);
  });

  it('is idempotent as a pair', async () => {
    await expectIdempotent(
      UNWRAP_PASSES,
      'function _0x1(a) { return !a; }\n' +
        "var _0x47 = { 'k': 0, 'f': function (a, b) { return a === b; } };\n" +
        'var out = _0x1(_0x47.f(_0x47.k, 1));',
    );
  });

  /**
   * Babel computes a binding's reference list once per crawl, and a pass that
   * deletes code without handing its references back leaves entries pointing
   * into a subtree that is no longer in the program. Read literally, such an
   * entry says the map escaped into an expression the analysis cannot account
   * for - and one of them was enough to reject a 2,200-key map with 4,000 live
   * reads in the 4 MB fixture.
   */
  it('inlines a map whose only escaping use an earlier pass already deleted', async () => {
    const source =
      "var _0x47 = { 'a': 1, 'b': 2 };\n" +
      'if (false) { sink(_0x47); }\n' +
      'var out = _0x47.a + _0x47.b;';
    const { code } = await runPass([inlineObjectMapsPass, removeDeadBranchesPass], source);
    expectEquivalent(code, 'var out = 1 + 2;');
    expectSameBehaviour(source, code);
  });

  it('still refuses the same map while that use is really there', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      "var _0x47 = { 'a': 1, 'b': 2 };\n" +
        'if (window.flag) { sink(_0x47); }\n' +
        'var out = _0x47.a + _0x47.b;',
    );
  });
});

describe('the shapes obfuscated2.js actually contains', () => {
  /**
   * The control-flow storage object, as `obfuscator.io` emits it: quoted random
   * keys, a mix of operator wrappers and literal replacers, every access through
   * a bracketed literal key. The wrapper census in the 4 MB fixture is dominated
   * by these five forms.
   */
  it('collapses a control-flow storage object', async () => {
    const source =
      'var _0x470975 = {\n' +
      "  'QrHIQ': function (_0xbc7360, _0x5ac301) { return _0xbc7360 < _0x5ac301; },\n" +
      "  'IdStr': function (_0x223cab, _0x1a1022) { return _0x223cab * _0x1a1022; },\n" +
      "  'SwUka': function (_0x5be7a0, _0x28af3e) { return _0x5be7a0 + _0x28af3e; },\n" +
      "  'SAjLR': function (_0x9a1f22, _0x4d5408) { return _0x9a1f22(_0x4d5408); },\n" +
      "  'vksOM': 'api.example.com',\n" +
      "  'acRbf': 'Hello, '\n" +
      '};\n' +
      "var out = [\n" +
      "  _0x470975['QrHIQ'](1, 2),\n" +
      "  _0x470975['IdStr'](3, 4),\n" +
      "  _0x470975['SwUka'](_0x470975['acRbf'], _0x470975['vksOM']),\n" +
      "  _0x470975['SAjLR'](isNaN, 'x')\n" +
      '];';
    const output = await maps(source);
    expect(output).not.toContain('_0x470975');
    expectEquivalent(
      output,
      "var out = [1 < 2, 3 * 4, 'Hello, ' + 'api.example.com', isNaN('x')];",
    );
    expectSameBehaviour(source, output);
  });

  /**
   * The same object as `transformObjectKeys` leaves it, at the shape found in
   * `obfuscated2.js:5091-5096`: built by assignment inside a flattened `switch`
   * case, handed to an alias, and read from a different case entirely.
   *
   * The read is placed by `structure.control-flow`, not by this pass. Which
   * case runs first is the order array's to say, and until the dispatcher is
   * linearised the read in case '2' is one this pass cannot put after the
   * declarator in case '1' - with the order reversed it runs first and throws,
   * and a collapse would have printed 5. So the fixture's own order, a literal
   * the dispatcher pass resolves, and the two rounds the pipeline takes: the
   * read that cannot be placed stays and keeps the map, the dispatcher is
   * linearised, and the next round collapses what is by then straight-line
   * code. The second round is a fresh parse here because that is how the
   * pipeline's scope tables reach this pass - rebuilt by `clean.unused` after
   * the linearisation - and a harness of two passes has no pass to do it.
   */
  it('collapses an exploded storage object built inside a switch case', async () => {
    const source =
      'function run(left, right) {\n' +
      "  var order = '1|2'.split('|'), out = null, i = 0;\n" +
      '  while (true) {\n' +
      '    switch (order[i++]) {\n' +
      "    case '1':\n" +
      '      var _0x8c7ed9 = {};\n' +
      "      _0x8c7ed9['BTmsni'] = function (_0x55ada0, _0x29f6e4) {\n" +
      '        return _0x55ada0 + _0x29f6e4;\n' +
      '      };\n' +
      '      var _0x28ebcd = _0x8c7ed9;\n' +
      '      continue;\n' +
      "    case '2':\n" +
      "      out = _0x28ebcd['BTmsni'](left, right);\n" +
      '      continue;\n' +
      '    }\n' +
      '    break;\n' +
      '  }\n' +
      '  return out;\n' +
      '}\n' +
      'var out = run(2, 3);';
    const alone = await maps(source);
    expect(alone).toContain("_0x28ebcd['BTmsni'](left, right)");
    expectSameBehaviour(source, alone);
    const linearised = (await runPass(unflattenControlFlowPass, source)).code;
    expect(linearised).not.toContain('switch');
    const output = await maps(linearised);
    expect(output).toContain('left + right');
    expect(output).not.toContain('_0x8c7ed9');
    expect(output).not.toContain('_0x28ebcd');
    expectSameBehaviour(source, output);
  });

  /**
   * Babel marks a `var` declared inside a loop as a constant violation of
   * itself, because the initialiser re-runs each iteration. Reading that as a
   * reassignment would refuse every storage object in the fixture, since they
   * all live inside the flattening `while (true)`.
   */
  it('treats a loop re-initialisation as a constant declaration', async () => {
    const source =
      'function run(l, r) {\n' +
      '  var acc = 0;\n' +
      '  for (var i = 0; i < 2; i++) {\n' +
      "    var _0x8c = { 'k': function (a, b) { return a + b; } };\n" +
      "    acc += _0x8c['k'](l, r);\n" +
      '  }\n' +
      '  return acc;\n' +
      '}\n' +
      'var out = run(2, 3);';
    const output = await maps(source);
    expect(output).toContain('l + r');
    expect(output).not.toContain('_0x8c');
    expectSameBehaviour(source, output);
  });

  it('still refuses a map that is genuinely reassigned inside the loop', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      'function run() {\n' +
        '  var acc = 0;\n' +
        '  for (var i = 0; i < 2; i++) {\n' +
        "    var _0x8c = { 'k': 1 };\n" +
        "    if (i) _0x8c = { 'k': 2 };\n" +
        "    acc += _0x8c['k'];\n" +
        '  }\n' +
        '  return acc;\n' +
        '}\n' +
        'var out = run();',
    );
  });

  it('tolerates the stray semicolons a beautifier leaves in the run', async () => {
    const source =
      'var _0x8c = {};\n' +
      "_0x8c['a'] = function (p, q) { return p - q; }\n" +
      ';\n' +
      "_0x8c['b'] = 7;\n" +
      ';\n' +
      "var out = _0x8c['a'](9, _0x8c['b']);";
    const output = await maps(source);
    expect(output).toContain('9 - 7');
    expectSameBehaviour(source, output);
  });

  /**
   * `stringArrayCallsTransform` uses unquoted identifier keys, dot access and
   * numeric values - a different spelling of the same table.
   */
  it('substitutes a stringArrayCallsTransform index object', async () => {
    const source =
      'function _0x52d5(i) { return String(i); }\n' +
      'function greet() {\n' +
      '  var _0x291b7e = { _0x12c858: 0x1b6, _0x3ba425: 0x1b3, _0x17a2d0: 0x1ad };\n' +
      '  return _0x52d5(_0x291b7e._0x12c858) + _0x52d5(_0x291b7e._0x3ba425) + _0x52d5(_0x291b7e._0x17a2d0);\n' +
      '}\n' +
      'var out = greet();';
    const output = await maps(source);
    expect(output).not.toContain('_0x291b7e');
    expect(output).toContain('_0x52d5(0x1b6)');
    expectSameBehaviour(source, output);
  });
});

const FIXTURE = thirdPartyFixture('lightly-obfuscated.js');

describe.skipIf(!FIXTURE.present)('the unwrapping passes on fixtures/lightly-obfuscated.js', () => {
  let source: string;
  beforeAll(() => {
    source = FIXTURE.read();
  });

  /**
   * Stand-in for the `strings` stage. Until every `_0xdb56[N]` is a literal the
   * file has no string keys at all, so both the with- and without-strings shapes
   * are worth asserting: the second is what `simplify` really receives.
   */
  function inlineStringArray(input: string): string {
    const firstLineEnd = input.indexOf('\n');
    const declaration = parseSource(input.slice(0, firstLineEnd)).ast.program.body[0];
    if (!t.isVariableDeclaration(declaration)) throw new Error('fixture: no leading declaration');
    const array = declaration.declarations[0]?.init;
    if (!t.isArrayExpression(array)) throw new Error('fixture: leading declaration is not an array');
    const strings = array.elements.map((element) =>
      t.isStringLiteral(element) ? element.value : undefined,
    );
    return input.slice(firstLineEnd + 1).replace(/_0xdb56\[(\d+)\]/g, (match, index: string) => {
      const value = strings[Number(index)];
      return value === undefined ? match : JSON.stringify(value);
    });
  }

  // Firing on hand-written code is the failure mode that matters most here, so
  // these assertions pin the exact count rather than an upper bound.
  it('finds no object alias map at all', async () => {
    await expectNoChange(inlineObjectMapsPass, source);
    await expectNoChange(inlineObjectMapsPass, inlineStringArray(source));
  }, 180_000);

  /**
   * The inventory reported no proxy functions, and it is right about the
   * obfuscator: this file has no injected indirection layer. It does contain
   * exactly one hand-written helper that happens to be a single-use forwarder -
   * `function ax(d) { return d / 2; }` at line 5535, called once at line 5627 -
   * and expanding it to `Lr / 2` is the transformation working, not misfiring.
   * The count is asserted exactly so that a rule which loosened enough to catch
   * real application functions would fail here.
   */
  it('expands only the one genuine single-use forwarder', async () => {
    for (const input of [source, inlineStringArray(source)]) {
      const result = await runPass(UNWRAP_PASSES, input);
      assertParses(result.code);
      expect(result.ctx.changesByPass.get('simplify.object-maps') ?? 0).toBe(0);
      // One expansion plus the removal of the wrapper it emptied.
      expect(result.ctx.changesByPass.get('simplify.proxy-functions')).toBe(2);
      expect(result.code).toContain('Lr / 2');
      expect(result.code).not.toContain('function ax(');
    }
  }, 180_000);

  it('leaves the file alone when function unwrapping is switched off', async () => {
    await expectNoChange(UNWRAP_PASSES, source, { techniques: { functionUnwrapping: false } });
  }, 180_000);
});
