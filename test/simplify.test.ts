import * as t from '@babel/types';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseSource } from '../src/frontend/language.js';
import { foldConstantsPass } from '../src/passes/simplify/fold-constants.js';
import { normalizePropertiesPass } from '../src/passes/simplify/properties.js';
import { expandSequencesPass } from '../src/passes/simplify/sequences.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const SIMPLIFY_PASSES = [foldConstantsPass, normalizePropertiesPass, expandSequencesPass];

async function fold(source: string): Promise<string> {
  return (await runPass(foldConstantsPass, source)).code;
}

async function properties(source: string): Promise<string> {
  return (await runPass(normalizePropertiesPass, source)).code;
}

async function sequences(source: string): Promise<string> {
  return (await runPass(expandSequencesPass, source)).code;
}

describe('simplify.fold-constants', () => {
  it('folds a chain of numeric literals', async () => {
    expectEquivalent(await fold('var n = 0x1 * 0x2 + 0x3;'), 'var n = 5;');
  });

  it('folds string concatenation', async () => {
    expectEquivalent(await fold("var s = 'a' + 'b' + 'c';"), "var s = 'abc';");
  });

  it('folds the !0 / !1 boolean encoding', async () => {
    expectEquivalent(await fold('var a = !0, b = !1;'), 'var a = true, b = false;');
  });

  it('folds the !![] / ![] boolean encoding', async () => {
    expectEquivalent(await fold('var a = !![], b = ![];'), 'var a = true, b = false;');
  });

  it('folds negation of an empty object literal', async () => {
    expectEquivalent(await fold('var a = !{};'), 'var a = false;');
  });

  it('rewrites hex, octal and binary literals as decimal', async () => {
    expectEquivalent(await fold('var a = 0x1f, b = 0o17, c = 0b1010;'), 'var a = 31, b = 15, c = 10;');
  });

  it('keeps a numeric form that is shorter than its decimal expansion', async () => {
    expectEquivalent(await fold('var a = 1e21;'), 'var a = 1e21;');
  });

  it('normalises the literal under a unary minus', async () => {
    expectEquivalent(await fold('var n = -0x1;'), 'var n = -1;');
  });

  it('replaces void 0 with undefined', async () => {
    expectEquivalent(await fold('var u = void 0;'), 'var u = undefined;');
  });

  it('folds typeof on a literal operand', async () => {
    expectEquivalent(
      await fold("var a = typeof 1, b = typeof 'x', c = typeof null;"),
      "var a = 'number', b = 'string', c = 'object';",
    );
  });

  it('folds String.fromCharCode on literal arguments', async () => {
    expectEquivalent(await fold('var s = String.fromCharCode(72, 105);'), "var s = 'Hi';");
  });

  it('folds string methods on a literal receiver', async () => {
    expectEquivalent(
      await fold("var a = 'abc'.charCodeAt(0), b = 'abc'.toUpperCase();"),
      "var a = 97, b = 'ABC';",
    );
  });

  it('folds Number#toString with a literal radix', async () => {
    expectEquivalent(await fold('var h = (255).toString(16);'), "var h = 'ff';");
  });

  it('folds parseInt and Number on literal arguments', async () => {
    expectEquivalent(await fold("var a = parseInt('0x1f', 16), b = Number('5');"), 'var a = 31, b = 5;');
  });

  it('collapses a constant ternary', async () => {
    expectEquivalent(await fold('var v = !0 ? first() : second();'), 'var v = first();');
  });

  it('collapses constant logical operators', async () => {
    expectEquivalent(
      await fold('var a = true && x, b = false || y, c = null ?? z;'),
      'var a = x, b = y, c = z;',
    );
  });

  it('folds comparisons between literals', async () => {
    expectEquivalent(await fold("var a = 1 < 2, b = 'a' === 'b';"), 'var a = true, b = false;');
  });

  it('refuses a fold that would produce Infinity', async () => {
    await expectNoChange(foldConstantsPass, 'var n = 1 / 0;');
  });

  it('refuses a fold that would produce -0', async () => {
    await expectNoChange(foldConstantsPass, 'var n = 0 * -1;');
  });

  it('refuses a fold that would produce NaN', async () => {
    await expectNoChange(foldConstantsPass, "var n = 'a' / 2;");
  });

  it('refuses to turn a string concatenation into a directive', async () => {
    await expectNoChange(foldConstantsPass, "function f() { 'use' + ' strict'; return this; }");
  });

  it('leaves void 0 alone when undefined is shadowed', async () => {
    await expectNoChange(foldConstantsPass, 'function f(undefined) { return void 0; }');
  });

  it('leaves typeof on an identifier alone', async () => {
    await expectNoChange(foldConstantsPass, "var t = typeof unknownGlobal === 'undefined';");
  });

  it('leaves a non-constant test in a ternary or logical operator alone', async () => {
    await expectNoChange(foldConstantsPass, 'var a = x ? y : z, b = probe() && y;');
  });

  it('leaves a member call on a non-literal receiver alone', async () => {
    await expectNoChange(foldConstantsPass, 'var n = obj.charCodeAt(0);');
  });

  it('refuses a string bomb', async () => {
    await expectNoChange(foldConstantsPass, "var s = 'x'.repeat(1e9);");
  });

  it('leaves a shadowed global builtin alone', async () => {
    await expectNoChange(
      foldConstantsPass,
      "function f(String) { return String.fromCharCode(72, 105); }",
    );
  });

  it('keeps a kept branch parenthesised when it lands at the start of a statement', async () => {
    const code = await fold('true ? function () { return 1; } : 0;');
    assertParses(code);
    expectEquivalent(code, '(function () { return 1; });');
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      foldConstantsPass,
      "var a = 0x1 * 0x2 + 0x3, b = !![], c = void 0, d = -0x1, e = 'a' + 'b', f = typeof 1;",
    );
  });
});

/**
 * A protector hides its domain check behind a chain of pure string methods
 * rather than behind a decoder, so nothing in the `strings` stage ever sees it.
 * The chain is decidable at rest, and folding it is what turns a grep-proof
 * literal back into evidence.
 */
describe('simplify.fold-constants - pure string and array chains', () => {
  it('folds the reversed-domain idiom to the domain it hides', async () => {
    expectEquivalent(
      await fold(`var host = 'moc.elpmaxe.ppa'.split('').reverse().join('');`),
      "var host = 'app.example.com';",
    );
  });

  it('folds the same idiom written with computed member access', async () => {
    expectEquivalent(
      await fold(`var host = ['moc.elpmaxe.ppa'['split']('')['reverse']()['join']('')];`),
      "var host = ['app.example.com'];",
    );
  });

  it('folds split and join with a real separator', async () => {
    expectEquivalent(await fold("var s = 'a,b,c'.split(',').join('-');"), "var s = 'a-b-c';");
  });

  it('folds a join on an array literal', async () => {
    expectEquivalent(await fold("var s = ['a', 'b', 'c'].join('');"), "var s = 'abc';");
  });

  it('folds reverse and concat on array literals', async () => {
    expectEquivalent(
      await fold("var a = [1, 2, 3].reverse().join(''), b = [1, 2].concat([3]).join('-');"),
      "var a = '321', b = '1-2-3';",
    );
  });

  it('folds indexOf and slice through a chain', async () => {
    expectEquivalent(
      await fold("var a = 'abc'.split('').indexOf('b'), b = 'abcd'.split('').slice(1, 3).join('');"),
      "var a = 1, b = 'bc';",
    );
  });

  it('folds replace with string arguments', async () => {
    expectEquivalent(
      await fold("var s = 'a-b-c'.replace('-', '+'), t = 'a-b-c'.replaceAll('-', '+');"),
      "var s = 'a+b-c', t = 'a+b+c';",
    );
  });

  it('folds a chain built from String.fromCharCode', async () => {
    expectEquivalent(
      await fold('var s = String.fromCharCode(99, 98, 97).split("").reverse().join("");'),
      "var s = 'abc';",
    );
  });

  it('leaves an intermediate array on the page rather than materialising it', async () => {
    // `split` alone yields an array. Writing it out would turn one short literal
    // into twelve and buys nothing, so the chain has to reach a primitive first.
    await expectNoChange(foldConstantsPass, "var parts = 'a,b,c'.split(',');");
  });

  it('leaves a regex-argument split or replace alone', async () => {
    await expectNoChange(
      foldConstantsPass,
      "var a = 'a1b'.split(/[0-9]/), b = 'a1b'.replace(/[0-9]/g, '-');",
    );
  });

  it('leaves replace with a function argument alone', async () => {
    await expectNoChange(
      foldConstantsPass,
      "var s = 'abc'.replace('a', function () { return log(); });",
    );
  });

  it('leaves a method that takes a callback alone', async () => {
    await expectNoChange(foldConstantsPass, "var s = ['a', 'b'].map(f).join('');");
  });

  it('leaves sort alone, because its result depends on a comparator', async () => {
    await expectNoChange(foldConstantsPass, "var s = ['b', 'a'].sort().join('');");
  });

  it('leaves a chain on a variable receiver alone, even a const one', async () => {
    // Proving the read is safe means proving the binding is never reassigned,
    // which is the inlining passes' job and needs scope, not text.
    await expectNoChange(
      foldConstantsPass,
      "const raw = 'moc.elpmaxe.ppa'; var host = raw.split('').reverse().join('');",
    );
  });

  it('leaves a chain alone when the receiver has a hole or a spread', async () => {
    await expectNoChange(foldConstantsPass, "var a = [1, , 3].join(''), b = [...xs].join('');");
  });

  it('refuses a chain that would blow up the output', async () => {
    await expectNoChange(foldConstantsPass, "var s = ['x'.repeat(1e9)].join('');");
  });

  it('refuses a fold that would leave a lone surrogate in the output', async () => {
    // `'\u{1f600}'.split('')` splits the pair into two unpaired code units. The
    // generator prints those raw, so writing the result to a UTF-8 file would
    // replace them with U+FFFD and silently change the value.
    await expectNoChange(foldConstantsPass, "var s = '\\u{1f600}a'.split('').reverse().join('');");
  });

  it('preserves an astral character that stays paired', async () => {
    const code = await fold("var s = '\\u{1f600}'.split('|').join('');");
    assertParses(code);
    expect(code).toContain('\u{1f600}');
  });

  it('leaves a shadowed String constructor alone inside a chain', async () => {
    await expectNoChange(
      foldConstantsPass,
      'function f(String) { return String.fromCharCode(97).split("").join(""); }',
    );
  });

  it('is idempotent over a chain', async () => {
    await expectIdempotent(
      foldConstantsPass,
      "var a = 'moc.elpmaxe.ppa'.split('').reverse().join(''), b = 'a,b'.split(','), c = ['x'].join('');",
    );
  });
});

/**
 * A register-VM entry vector arrives as a spread of slices of one frozen table:
 * `f([...T.slice(0, 8), -9, 799, ...T.slice(13, 17)])`. Every later analysis
 * needs that argument to be an array of numbers, and nothing but this fold gets
 * it there - the slices are decidable, but they are decidable one hop behind an
 * identifier the pass otherwise refuses to follow.
 */
describe('simplify.fold-constants - spreads of a frozen table', () => {
  it('splices a slice of a constant table into the literal that spreads it', async () => {
    expectEquivalent(
      await fold('var T = [1, 2, 3, 4]; var v = [...T.slice(0, 3), 9];'),
      'var T = [1, 2, 3, 4]; var v = [1, 2, 3, 9];',
    );
  });

  it('splices several spreads and keeps the surrounding elements in place', async () => {
    expectEquivalent(
      await fold('var T = [1, 2, 3, 4]; var v = [-5, ...T.slice(0, 2), 0, ...T.slice(3, 4)];'),
      'var T = [1, 2, 3, 4]; var v = [-5, 1, 2, 0, 4];',
    );
  });

  it('spreads the table itself', async () => {
    expectEquivalent(
      await fold("var T = ['a', 'b']; var v = [...T, 'c'];"),
      "var T = ['a', 'b']; var v = ['a', 'b', 'c'];",
    );
  });

  it('is idempotent, and the result still parses', async () => {
    const source = 'var T = [1, 2, 3, 4]; var v = [...T.slice(0, 3), 9];';
    assertParses(await fold(source));
    await expectIdempotent(foldConstantsPass, source);
  });

  it('gives each fold its own nodes rather than sharing one array', async () => {
    // Two spreads of the same slice are two allocations at run time and have to
    // be two subtrees here, or a later pass rewriting one would rewrite both.
    const code = await fold('var T = [1, 2]; var a = [...T], b = [...T];');
    const { ast } = parseSource(code);
    const arrays: t.ArrayExpression[] = [];
    t.traverseFast(ast, (node) => {
      if (t.isArrayExpression(node)) arrays.push(node);
    });
    const [table, first, second] = arrays;
    expect(table?.elements).toHaveLength(2);
    expect(first?.elements[0]).not.toBe(second?.elements[0]);
    expectEquivalent(code, 'var T = [1, 2]; var a = [1, 2], b = [1, 2];');
  });

  it('refuses a table written after it is declared', async () => {
    await expectNoChange(
      foldConstantsPass,
      'var T = [1, 2, 3]; T[0] = 5; var v = [...T.slice(0, 2)];',
    );
  });

  it('refuses a table reordered or resized anywhere in the program', async () => {
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; T.reverse(); var v = [...T];');
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; T.push(4); var v = [...T];');
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; T.sort(); var v = [...T];');
  });

  it('refuses a table a callback-taking method can write through', async () => {
    // Every one of these hands the callback the receiver itself, so `a` and `T`
    // are the same array: the table is written through a name that is not the
    // table's, which a scan for uses of `T` sees as a read. Any of them counted
    // as non-mutating is a fold - on by default - to a value the running
    // program never holds.
    await expectNoChange(
      foldConstantsPass,
      'var T = [1, 2, 3]; T.forEach(function (v, i, a) { a[0] = 9; }); var v = [...T];',
    );
    for (const method of [
      'map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex',
      'some', 'every', 'flatMap',
    ]) {
      await expectNoChange(
        foldConstantsPass,
        `var T = [1, 2, 3]; T.${method}(function (v, i, a) { a[0] = 9; }); var v = [...T];`,
      );
    }
    for (const method of ['reduce', 'reduceRight']) {
      await expectNoChange(
        foldConstantsPass,
        `var T = [1, 2, 3]; T.${method}(function (s, v, i, a) { a[0] = 9; }, 0); var v = [...T];`,
      );
    }
  });

  it('still folds through a member that cannot reach the table', async () => {
    // The refusal above is about callbacks, not about arity: `flat` takes a
    // depth and hands nothing to anyone, and the iterator members yield
    // elements rather than the array.
    for (const call of ['T.flat()', 'T.entries()', 'T.keys()', 'T.values()', 'T.join()']) {
      expectEquivalent(
        await fold(`var T = [1, 2, 3]; ${call}; var v = [...T];`),
        `var T = [1, 2, 3]; ${call}; var v = [1, 2, 3];`,
      );
    }
  });

  it('refuses a table that escapes as a value', async () => {
    // `var u = T; u[0] = 9;` mutates the same object without ever naming `T`.
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; send(T); var v = [...T];');
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; var u = T; var v = [...T];');
  });

  it('refuses a table that is reassigned', async () => {
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; T = [4]; var v = [...T];');
  });

  it('refuses a table holding a non-literal element', async () => {
    await expectNoChange(foldConstantsPass, 'var T = [1, x, 3]; var v = [...T.slice(0, 2)];');
    await expectNoChange(foldConstantsPass, 'var T = [1, , 3]; var v = [...T];');
  });

  it('refuses a spread this pass cannot resolve', async () => {
    await expectNoChange(foldConstantsPass, 'var v = [...xs, 1];');
    await expectNoChange(foldConstantsPass, 'function f(a) { return [...a, 1]; }');
  });

  it('refuses a result larger than the emission cap', async () => {
    const table = `var T = [${Array.from({ length: 5000 }, (_, i) => i).join(', ')}];`;
    await expectNoChange(foldConstantsPass, `${table} var v = [...T];`);
  });

  it('still leaves a chain that only passes through an array alone', async () => {
    // The carve-out is for spreads, not for materialising arrays generally.
    await expectNoChange(foldConstantsPass, 'var T = [1, 2, 3]; var v = T.slice(0, 2);');
  });
});

/**
 * The fixture never slices its table in the open; all 1,585 slices go through
 * one forwarder. `simplify.proxy-functions` refuses that forwarder, correctly
 * on its own terms - its templates may only mention their parameters, and this
 * one mentions the table. So the evaluator resolves the call instead of
 * inlining it, and only a value ever comes back.
 */
describe('simplify.fold-constants - one-line wrappers', () => {
  it('resolves a call to a table-slicing forwarder', async () => {
    expectEquivalent(
      await fold(
        'var T = [1, 2, 3, 4]; function part(a, b) { return T.slice(a, b); } var v = [...part(1, 3), 9];',
      ),
      'var T = [1, 2, 3, 4]; function part(a, b) { return T.slice(a, b); } var v = [2, 3, 9];',
    );
  });

  it('resolves a wrapper to a primitive', async () => {
    expectEquivalent(
      await fold('function add(a, b) { return a + b; } var n = add(2, 3);'),
      'function add(a, b) { return a + b; } var n = 5;',
    );
  });

  it('resolves an arrow wrapper and a const-bound one', async () => {
    expectEquivalent(
      await fold('const add = (a, b) => a * b; var n = add(3, 4);'),
      'const add = (a, b) => a * b; var n = 12;',
    );
  });

  it('reads the wrapper body in its own scope, not the call site s', async () => {
    // `T` inside the wrapper is the outer table even where the caller has bound
    // a `T` of its own.
    expectEquivalent(
      await fold(
        'var T = [1, 2]; function part(a) { return T.slice(0, a); } function f(T) { return [...part(1), 9]; }',
      ),
      'var T = [1, 2]; function part(a) { return T.slice(0, a); } function f(T) { return [1, 9]; }',
    );
  });

  it('refuses a wrapper whose arity does not match the call', async () => {
    // Fewer arguments than parameters means the body reads `undefined`, and
    // writing that out is a guess about intent.
    await expectNoChange(
      foldConstantsPass,
      'function add(a, b) { return a + b; } var n = add(2);',
    );
  });

  it('refuses a reassigned wrapper', async () => {
    await expectNoChange(
      foldConstantsPass,
      'function add(a, b) { return a + b; } add = other; var n = add(2, 3);',
    );
  });

  it('refuses a wrapper that does more than return an expression', async () => {
    await expectNoChange(
      foldConstantsPass,
      'function add(a, b) { log(a); return a + b; } var n = add(2, 3);',
    );
  });

  it('refuses a wrapper reaching anything the whitelists do not cover', async () => {
    await expectNoChange(foldConstantsPass, 'function f(a) { return this[a]; } var n = f(1);');
    await expectNoChange(
      foldConstantsPass,
      'function f(a) { return arguments[a]; } var n = f(0);',
    );
    await expectNoChange(foldConstantsPass, 'function f(a) { return outside + a; } var n = f(1);');
  });

  it('refuses a wrapper argument that is not itself constant', async () => {
    await expectNoChange(
      foldConstantsPass,
      'function add(a, b) { return a + b; } var n = add(x, 3);',
    );
  });

  it('refuses a shadowed wrapper name', async () => {
    await expectNoChange(
      foldConstantsPass,
      'function add(a, b) { return a + b; } function f(add) { return add(2, 3); }',
    );
  });

  it('refuses a call or spread inside a with body', async () => {
    // `with (o)` looks the name up on `o` first, at run time, so the binding
    // this pass proved constant may not be the one the call reaches at all.
    await expectNoChange(
      foldConstantsPass,
      "function w(a, b) { return a + b; } var o = { w: function () { return 'shadow'; } };" +
        ' with (o) { log(w(1, 2)); }',
      { language: 'js' },
    );
    await expectNoChange(
      foldConstantsPass,
      'var T = [1, 2]; var o = { T: [9] }; with (o) { log([...T]); }',
      { language: 'js' },
    );
  });
});

describe('simplify.properties', () => {
  it('rewrites a computed string key on an identifier', async () => {
    expectEquivalent(await properties("var v = obj['name'];"), 'var v = obj.name;');
  });

  it('rewrites a computed key whose object is a call result', async () => {
    // The regex-based predecessor required a bare identifier left of the bracket
    // and missed every case like this one.
    expectEquivalent(
      await properties("var n = b('div.modal:visible')['length'];"),
      "var n = b('div.modal:visible').length;",
    );
  });

  it('rewrites chained and nested computed keys', async () => {
    expectEquivalent(
      await properties("a['b']['c'] = d[e()]['f'];"),
      'a.b.c = d[e()].f;',
    );
  });

  it('rewrites a quoted object literal key', async () => {
    expectEquivalent(await properties("var o = { 'name': 1 };"), 'var o = { name: 1 };');
  });

  it('rewrites a computed object literal key', async () => {
    expectEquivalent(await properties("var o = { ['name']: 1 };"), 'var o = { name: 1 };');
  });

  it('rewrites quoted object and class methods', async () => {
    expectEquivalent(
      await properties("var o = { 'go'() { return 1; } }; class A { 'run'() { return 2; } }"),
      'var o = { go() { return 1; } }; class A { run() { return 2; } }',
    );
  });

  it('preserves optional chaining', async () => {
    expectEquivalent(await properties("var v = obj?.['x'];"), 'var v = obj?.x;');
  });

  it('rewrites a reserved word key, which is legal in dot position', async () => {
    expectEquivalent(await properties("var v = obj['default'];"), 'var v = obj.default;');
  });

  it('leaves a key that is not a valid identifier alone', async () => {
    await expectNoChange(normalizePropertiesPass, "var v = obj['a-b'] + obj['0'] + obj[''];");
  });

  it('leaves a numeric key alone', async () => {
    await expectNoChange(normalizePropertiesPass, 'var v = arr[0] + arr[i];');
  });

  it('leaves a computed __proto__ key alone', async () => {
    await expectNoChange(normalizePropertiesPass, "var o = { ['__proto__']: base };");
  });

  it('leaves a computed constructor key in a class body alone', async () => {
    await expectNoChange(normalizePropertiesPass, "class A { ['constructor']() { return 1; } }");
  });

  it('leaves shorthand properties alone', async () => {
    await expectNoChange(normalizePropertiesPass, 'var o = { a, b };');
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      normalizePropertiesPass,
      "var v = b('x')['length'], o = { 'name': 1, ['other']: 2 }, w = a?.['k'];",
    );
  });
});

describe('simplify.sequences', () => {
  it('expands a sequence in statement position', async () => {
    expectEquivalent(await sequences('a(), b(), c();'), 'a(); b(); c();');
  });

  it('expands a sequence in a return argument', async () => {
    expectEquivalent(
      await sequences('function f() { return a(), b(), c(); }'),
      'function f() { a(); b(); return c(); }',
    );
  });

  it('expands a sequence in a throw argument', async () => {
    expectEquivalent(
      await sequences('function f() { throw a(), b(); }'),
      'function f() { a(); throw b(); }',
    );
  });

  it('blocks a sequence that has no statement list to expand into', async () => {
    expectEquivalent(await sequences('if (x) a(), b();'), 'if (x) { a(); b(); }');
  });

  it('hoists a sequence out of an if test in a statement list', async () => {
    expectEquivalent(await sequences('if (a(), b()) c();'), 'a(); if (b()) c();');
  });

  it('expands a sequence inside a switch case body', async () => {
    expectEquivalent(
      await sequences('switch (k) { case 1: a(), b(); break; }'),
      'switch (k) { case 1: a(); b(); break; }',
    );
  });

  it('converts an arrow expression body into a block', async () => {
    expectEquivalent(await sequences('var f = () => (a(), b());'), 'var f = () => { a(); return b(); };');
  });

  it('does not hoist out of a switch discriminant', async () => {
    // The exact shape at fixtures/lightly-obfuscated.js:9208. Lifting the
    // assignment above the switch reorders it against the case tests.
    await expectNoChange(
      expandSequencesPass,
      'switch (b = this[x][i], b[y]) { case 3: this[z](b); break; }',
    );
  });

  it('does not hoist out of a for update', async () => {
    await expectNoChange(expandSequencesPass, 'for (i = 0; i < n; i++, j++) k();');
  });

  it('does not hoist out of a for init', async () => {
    await expectNoChange(expandSequencesPass, 'for (i = 0, j = 0; i < n; i++) k();');
  });

  it('does not hoist out of a short-circuit operand', async () => {
    await expectNoChange(expandSequencesPass, 'x && (a(), b());');
  });

  it('does not hoist out of a ternary branch', async () => {
    await expectNoChange(expandSequencesPass, 'x ? (a(), b()) : c();');
  });

  it('does not hoist out of an argument list', async () => {
    await expectNoChange(expandSequencesPass, 'f((a(), b()));');
  });

  it('does not hoist an if test that has no statement list around it', async () => {
    await expectNoChange(expandSequencesPass, 'while (x) if (a(), b()) c();');
  });

  it('blocks a loop body and a labelled statement rather than leaking siblings', async () => {
    expectEquivalent(await sequences('do a(), b(); while (x);'), 'do { a(); b(); } while (x);');
    expectEquivalent(await sequences('outer: a(), b();'), 'outer: { a(); b(); }');
  });

  it('keeps an expanded function expression from starting a statement bare', async () => {
    const code = await sequences('(function () {}, 1);');
    assertParses(code);
    expectEquivalent(code, '(function () {}); 1;');
  });

  it('preserves an empty catch block', async () => {
    expectEquivalent(
      await sequences('try { a(), b(); } catch (e) {}'),
      'try { a(); b(); } catch (e) {}',
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      expandSequencesPass,
      'a(), b(); function f() { return c(), d(); } if (e(), g()) h(); var k = () => (m(), n());',
    );
  });
});

const FIXTURE = thirdPartyFixture('lightly-obfuscated.js');

describe.skipIf(!FIXTURE.present)('the simplify stage on a real-world bundle', () => {
  let source: string;
  beforeAll(() => {
    source = FIXTURE.read();
  });

  interface StageReport {
    inputBytes: number;
    outputBytes: number;
    foldConstants: number;
    normalizeProperties: number;
    expandSequences: number;
    totalChanges: number;
    wallClockMs: number;
  }

  async function runStage(input: string): Promise<{ report: StageReport; code: string }> {
    const started = performance.now();
    const result = await runPass(SIMPLIFY_PASSES, input);
    const wallClockMs = Math.round(performance.now() - started);
    assertParses(result.code);
    const changes = (id: string): number => result.ctx.changesByPass.get(id) ?? 0;
    return {
      code: result.code,
      report: {
        inputBytes: input.length,
        outputBytes: result.code.length,
        foldConstants: changes('simplify.fold-constants'),
        normalizeProperties: changes('simplify.properties'),
        expandSequences: changes('simplify.sequences'),
        totalChanges: result.changes,
        wallClockMs,
      },
    };
  }

  /**
   * Stand-in for the `strings` stage, which normally runs first: until every
   * `_0xdb56[N]` has become its literal there are no string keys for the
   * property pass to see, so this is the input `simplify` actually receives.
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

  it('collapses fixtures/lightly-obfuscated.js and still produces parsable code', async () => {
    const { report, code } = await runStage(source);
    console.log('simplify stage, fixture as-is:', report);

    expect(report.foldConstants).toBeGreaterThan(1_000);
    // 768 of the file's 1424 sequences are in statement, return or if-test
    // position; the other 656 sit in a short-circuit operand, a ternary branch,
    // a `for` init or a switch discriminant and are deliberately left alone.
    expect(report.expandSequences).toBeGreaterThan(700);
    // Every key in this file is still `_0xdb56[N]`, so there is genuinely
    // nothing for property normalisation to convert until strings are inlined.
    expect(report.normalizeProperties).toBe(0);
    // The ten switch discriminants still carry their comma sequence.
    expect(/switch \([^()]*,/.test(code)).toBe(true);
  }, 180_000);

  it('normalises the property accesses the string array was hiding', async () => {
    const { report } = await runStage(inlineStringArray(source));
    console.log('simplify stage, string array inlined:', report);

    // The regex-based predecessor missed 1216 of these because a `)` or `]`
    // sat left of the bracket. An AST pass has no such blind spot.
    expect(report.normalizeProperties).toBeGreaterThan(1_216);
  }, 180_000);
});
