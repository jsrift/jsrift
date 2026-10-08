import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { machineryOf } from '../src/analysis/string-array.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A table captured by a declarator BESIDE it, in a statement the slice took.
 *
 * The reference audits exempted every unit the slice took, whole, as the
 * table's own machinery. A declaration statement is a unit only by the
 * accident of the obfuscator's `simplify`, which merges adjacent `var`s: `var
 * a = ['alpha', 'beta', 'gamma'], b = a;` is the table's declarator and an
 * alias beside it, and `b.reverse(); log(a[0])` came out as `log('alpha')` at
 * every preset - the alias never existed to the audit, so the reverse through
 * it was never seen (round twelve, chk/r1/adj 2g, four trials). The same
 * through a capture beside a needed offset, a function beside either that
 * touches the table when called, and the table function's alias beside its
 * own declarator. Only the roots' own declarators are machinery now; every
 * other declarator of a taken statement is judged as its own statement is.
 *
 * Beside it, the same audit for a decoder one scope BELOW its table: a
 * borrowed table's declarator is never among the slice's sources, and the
 * audit took that for "a same-named binding declared elsewhere" and judged no
 * reference to it at all - `rev(t)` at the outer level, an alias in its own
 * var, all unseen. The binding itself is the test now.
 *
 * Every case runs input and output in a fresh realm with only `log`.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(', ');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

type Result = Awaited<ReturnType<typeof deobfuscate>>;

async function expectSameBehaviour(source: string, preset: (typeof PRESETS)[number]): Promise<Result> {
  const result = await deobfuscate(source, { preset });
  const before = execute(source);
  const after = execute(result.code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
    );
  }
  return result;
}

function warnings(result: Result): string[] {
  return result.metadata.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message);
}

const TABLE = `['alpha', 'beta', 'gamma']`;

describe('strings: a table captured by a declarator beside it', () => {
  // [label, source, the refusal the audit owes, what the input prints]
  const refused: [string, string, RegExp, string][] = [
    [
      'an alias in the same var',
      `var a = ${TABLE}, b = a;\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: 1 reference\(s\) could change the array before it is read \(a\.reverse at line 2 may mutate it\)/,
      'gamma',
    ],
    [
      'an alias in the same let',
      `let a = ${TABLE}, b = a;\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 2 may mutate it\)/,
      'gamma',
    ],
    [
      'an alias in the same const',
      `const a = ${TABLE}, b = a;\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 2 may mutate it\)/,
      'gamma',
    ],
    [
      'an alias two declarators over',
      `var a = ${TABLE}, n = 1, b = a;\nb.reverse();\nlog(a[0], n);`,
      /^Refusing to inline a: .*\(a\.reverse at line 2 may mutate it\)/,
      'gamma 1',
    ],
    [
      'an alias of an alias in the same var',
      `var a = ${TABLE}, b = a, c = b;\nc.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 2 may mutate it\)/,
      'gamma',
    ],
    [
      'an element write through the alias',
      `var a = ${TABLE}, b = a;\nb[0] = 'zeta';\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a is written through at line 2\)/,
      'zeta',
    ],
    [
      'a sort through the alias',
      `var a = ['gamma', 'alpha', 'beta'], b = a;\nb.sort();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.sort at line 2 may mutate it\)/,
      'alpha',
    ],
    [
      'the alias handed to a function',
      `function rev(x) { x.reverse(); }\nvar a = ${TABLE}, b = a;\nrev(b);\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 3\)/,
      'gamma',
    ],
    [
      'the alias mutated in a loop body',
      `var a = ${TABLE}, b = a;\nfor (var i = 0; i < 1; i++) b.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 2 may mutate it\)/,
      'gamma',
    ],
    [
      'the alias mutated by a recursion',
      `var a = ${TABLE}, b = a;\nfunction walk(n) { if (n === 0) return; b.reverse(); walk(n - 1); }\nwalk(1);\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 2 may mutate it\)/,
      'gamma',
    ],
    [
      'the alias reversed by Array.prototype.reverse.call',
      `var a = ${TABLE}, b = a;\nArray.prototype.reverse.call(b);\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 2\)/,
      'gamma',
    ],
    [
      'the alias reversed through a bound method',
      `var a = ${TABLE}, b = a;\nvar r = b.reverse.bind(b);\nr();\nlog(a[0]);`,
      /^Refusing to inline a: 2 reference\(s\) .*\(a\.reverse at line 2 may mutate it; a escapes as a value at line 2\)/,
      'gamma',
    ],
    [
      'the whole shape inside a function',
      `function f() {\n  var a = ${TABLE}, b = a;\n  b.reverse();\n  return a[0];\n}\nlog(f());`,
      /^Refusing to inline a: .*\(a\.reverse at line 3 may mutate it\)/,
      'gamma',
    ],
    [
      'an alias that is later reassigned',
      `var a = ${TABLE}, b = a;\nif (a.length > 5) b = [];\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 1\)/,
      'gamma',
    ],
    [
      'a capture through a sequence',
      `var a = ${TABLE}, b = (0, a);\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 1\)/,
      'gamma',
    ],
    [
      'a capture through a conditional',
      `var a = ${TABLE}, b = true ? a : null;\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 1\)/,
      'gamma',
    ],
    [
      'a capture by a pattern',
      `var a = ${TABLE}, [b] = [a];\nb.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 1\)/,
      'gamma',
    ],
    [
      'a capture into an object literal',
      `var a = ${TABLE}, o = { t: a };\no.t.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 1\)/,
      'gamma',
    ],
    [
      'a capture into an array literal',
      `var a = ${TABLE}, o = [a];\no[0].reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 1\)/,
      'gamma',
    ],
    [
      'a function beside the table that reverses it when called',
      `var a = ${TABLE}, f = function () { a.reverse(); };\nf();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 1 may mutate it\)/,
      'gamma',
    ],
    [
      'an arrow beside the table that reverses it when called',
      `var a = ${TABLE}, f = () => a.reverse();\nf();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 1 may mutate it\)/,
      'gamma',
    ],
    [
      'a mutating call in the sibling declarator itself',
      `var a = ${TABLE}, b = a.reverse();\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a\.reverse at line 1 may mutate it\)/,
      'gamma',
    ],
    [
      'a hand-off to a function in the sibling declarator itself',
      `function rev(x) { x.reverse(); }\nvar a = ${TABLE}, b = rev(a);\nlog(a[0]);`,
      /^Refusing to inline a: .*\(a escapes as a value at line 2\)/,
      'gamma',
    ],
  ];

  for (const [label, source, refusal, prints] of refused) {
    it(`refuses ${label} at every preset`, async () => {
      expect(execute(source)).toBe(prints);
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(warnings(result).some((m) => refusal.test(m)), `${preset}: ${warnings(result).join(' | ')}`).toBe(true);
        expect(result.metadata.strings).toHaveLength(0);
        // The read stays a read of the table, under whatever name it has.
        expect(result.code, preset).toMatch(/\w+\[(0x)?0\]/);
      }
    });
  }

  it('refuses the same alias in its own var, with the same reason', async () => {
    const source = `var a = ${TABLE};\nvar b = a;\nb.reverse();\nlog(a[0]);`;
    expect(execute(source)).toBe('gamma');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(warnings(result)).toEqual([
        expect.stringMatching(/^Refusing to inline a: .*\(a\.reverse at line 3 may mutate it\)/),
      ]);
    }
  });

  it('follows the alias as one link: a read through it is inlined', async () => {
    const source = `var a = ${TABLE}, b = a;\nlog(b[2]);`;
    expect(execute(source)).toBe('gamma');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(warnings(result)).toEqual([]);
      expect(result.code, preset).toContain("log('gamma')");
      expect(result.code, preset).not.toMatch(/\w+\[(0x)?2\]/);
    }
  });

  it('still inlines beside read-only sibling declarators', async () => {
    const source = `var a = ${TABLE}, b = a[1], n = a.length;\nlog(a[0], b, n);`;
    expect(execute(source)).toBe('alpha beta 3');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(warnings(result).some((m) => /^Refusing to inline/.test(m)), preset).toBe(false);
      expect(result.code, preset).toMatch(/log\('alpha', \w+, \w+\)/);
    }
  });
});

describe('strings: a table captured beside a name the slice needed', () => {
  const refused: [string, string, RegExp][] = [
    [
      'an alias beside the offset a decoder reads',
      `var _0xt = ${TABLE};\nvar _0xn = 0, _0xa = _0xt;\n_0xa.reverse();\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xn]; }\nlog(_0xd(0));`,
      /^Refusing to inline _0xd: _0xt can be changed at line 2, so the decoded values need not be the ones that run\.$/,
    ],
    [
      'an alias beside the table a decoder reads',
      `var _0xt = ${TABLE}, _0xa = _0xt;\n_0xa.reverse();\nfunction _0xd(_0xi) { return _0xt[_0xi]; }\nlog(_0xd(0));`,
      /^Refusing to inline _0xd: _0xt can be changed at line 1, so the decoded values need not be the ones that run\.$/,
    ],
    [
      'an alias beside the decoder itself',
      `var _0xt = ${TABLE};\nvar _0xd = function (_0xi) { return _0xt[_0xi]; }, _0xa = _0xt;\n_0xa.reverse();\nlog(_0xd(0));`,
      /^Refusing to inline _0xd: _0xt can be changed at line 2, so the decoded values need not be the ones that run\.$/,
    ],
    [
      'a function beside the offset that reverses the table when called',
      `var _0xt = ${TABLE};\nvar _0xn = 0, _0xf = function () { _0xt.reverse(); };\n_0xf();\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xn]; }\nlog(_0xd(0));`,
      /^Refusing to inline _0xd: _0xt can be changed at line 2, so the decoded values need not be the ones that run\.$/,
    ],
    [
      'an alias of the table function beside its own declarator',
      `var _0xg = function () { var j = ${TABLE}; _0xg = function () { return j; }; return _0xg(); }, _0xa = _0xg;\nfunction _0xd(_0xi) { var e = _0xg(); return e[_0xi]; }\n_0xa().reverse();\nlog(_0xd(0));`,
      /^Refusing to inline _0xd: _0xg can be changed at line 1, so the decoded values need not be the ones that run\.$/,
    ],
  ];

  for (const [label, source, refusal] of refused) {
    it(`refuses ${label} at every preset`, async () => {
      expect(execute(source)).toBe('gamma');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(warnings(result).some((m) => refusal.test(m)), `${preset}: ${warnings(result).join(' | ')}`).toBe(true);
        expect(result.metadata.strings).toHaveLength(0);
        expect(result.code, preset).toMatch(/log\(\w+\((0x)?0\)\)/);
      }
    });
  }

  it('still decodes beside a sibling declarator that does not capture the table', async () => {
    const source = `var _0xt = ${TABLE};\nvar _0xn = 1, _0xm = _0xt.length;\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xn]; }\nlog(_0xd(0), _0xm);`;
    expect(execute(source)).toBe('beta 3');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(warnings(result).some((m) => /^Refusing to inline/.test(m)), preset).toBe(false);
      expect(result.code, preset).toMatch(/log\('beta', \w+\)/);
    }
  });

  it('refuses a capture beside the offset that goes nowhere, as it does one in its own var', async () => {
    // The wrapper audit does not follow an alias of the table; one in its own
    // statement was always a refusal, and the merged statement now is the same.
    const own = `var _0xt = ${TABLE};\nvar _0xa = _0xt;\nfunction _0xd(_0xi) { return _0xt[_0xi]; }\nlog(_0xd(1));`;
    const beside = `var _0xt = ${TABLE};\nvar _0xn = 0, _0xa = _0xt;\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xn + 1]; }\nlog(_0xd(0));`;
    for (const source of [own, beside]) {
      expect(execute(source)).toBe('beta');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(warnings(result), preset).toEqual([
          'Refusing to inline _0xd: _0xt can be changed at line 2, so the decoded values need not be the ones that run.',
        ]);
      }
    }
  });
});

describe('strings: a table borrowed from the scope that lets it escape', () => {
  // A decoder one scope below its table. The wrapper audit told the table's
  // binding apart from a same-named one by whether its declarator sat in the
  // slice's sources, which never carry a borrowed declaration: every reference
  // at the outer level was taken for another array's and none was judged.
  const refused: [string, string, number][] = [
    [
      'an alias in its own var',
      `var t = ${TABLE};\nvar b = t;\nfunction m() { function d(i) { return t[i]; } b.reverse(); log(d(0)); }\nm();`,
      2,
    ],
    [
      'an alias beside the table',
      `var t = ${TABLE}, b = t;\nfunction m() { function d(i) { return t[i]; } b.reverse(); log(d(0)); }\nm();`,
      1,
    ],
    [
      'a hand-off to a function',
      `var t = ${TABLE};\nfunction rev(x) { x.reverse(); }\nrev(t);\nfunction m() { function d(i) { return t[i]; } log(d(0)); }\nm();`,
      3,
    ],
    [
      'an alias reversed before the module runs',
      `var t = ${TABLE};\nvar keep = t;\nfunction m() { function d(i) { return t[i]; } log(d(0)); }\nkeep.reverse();\nm();`,
      2,
    ],
    [
      'a table function whose result is reversed outside',
      `function t() { var j = ${TABLE}; t = function () { return j; }; return t(); }\nfunction m() { function d(i) { var e = t(); return e[i]; } log(d(0)); }\nt().reverse();\nm();`,
      3,
    ],
  ];

  for (const [label, source, line] of refused) {
    it(`refuses ${label} at every preset`, async () => {
      expect(execute(source)).toBe('gamma');
      const refusal = `Refusing to inline d: t can be changed at line ${line}, so the decoded values need not be the ones that run.`;
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(warnings(result), preset).toContain(refusal);
        expect(result.metadata.strings).toHaveLength(0);
        expect(result.code, preset).toMatch(/log\(\w+\((0x)?0\)\)/);
      }
    });
  }

  it('still decodes a borrowed table the outer scope only reads', async () => {
    const source = `var t = ${TABLE};\nfunction m() { function d(i) { return t[i]; } log(d(1)); }\nm();\nlog(t.length);`;
    expect(execute(source)).toBe('beta, 3');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(warnings(result).some((m) => /^Refusing to inline/.test(m)), preset).toBe(false);
      expect(result.code, preset).toContain("log('beta')");
    }
  });

  it('refuses a table function called outside its machinery one scope down as it does beside it', async () => {
    const beside = `function t() { var j = ${TABLE}; t = function () { return j; }; return t(); }\nfunction d(i) { var e = t(); return e[i]; }\nlog(d(1));\nlog(t().length);`;
    const below = `function t() { var j = ${TABLE}; t = function () { return j; }; return t(); }\nfunction m() { function d(i) { var e = t(); return e[i]; } log(d(1)); }\nm();\nlog(t().length);`;
    for (const source of [beside, below]) {
      expect(execute(source)).toBe('beta, 3');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(warnings(result), preset).toEqual([
          'Refusing to inline d: t can be changed at line 4, so the decoded values need not be the ones that run.',
        ]);
      }
    }
  });
});

describe('strings: a merged declaration aliasing the table', () => {
  // javascript-obfuscator output for `var a = [...]; var b = a; b.reverse();
  // log(b[0], a[2])` with `simplify` on, which merged the two `var`s; the
  // table's entries are decoder calls until the decoder is inlined.
  const source = readFileSync(new URL('./fixtures/table-alias-merged-var.js', import.meta.url), 'utf8');

  it('reverses through the alias at every preset', async () => {
    expect(execute(source)).toBe('gamma alpha');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      // The decoder is inlined - the table is spelt out - and the table itself refused.
      expect(result.code, preset).toContain("'alpha', 'beta', 'gamma'");
      expect(result.code, preset).toMatch(/log\(\w+\[(0x)?0\], \w+\[(0x)?2\]\)/);
      expect(warnings(result), preset).toEqual([
        expect.stringMatching(
          /^Refusing to inline \w+: 1 reference\(s\) could change the array before it is read \(\w+\["reverse"\] at line 20 may mutate it\)/,
        ),
      ]);
    }
  });
});

describe('machineryOf', () => {
  function statements(code: string): NodePath<t.Statement>[] {
    const { ast } = parseSource(code, { language: 'js', sourceType: 'script' });
    let program!: NodePath<t.Program>;
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    return program.get('body');
  }

  it('keeps only the roots’ declarators of a declaration statement', () => {
    const [declaration] = statements(`var a = ${TABLE}, n = 1, b = a;`);
    const machinery = machineryOf([declaration!], ['a']);
    const declarators = (declaration!.node as t.VariableDeclaration).declarations;
    expect([...machinery]).toEqual([declarators[0]]);
  });

  it('keeps a root declared by a pattern', () => {
    const [declaration] = statements(`var [a] = [${TABLE}], b = a;`);
    const machinery = machineryOf([declaration!], ['a']);
    const declarators = (declaration!.node as t.VariableDeclaration).declarations;
    expect([...machinery]).toEqual([declarators[0]]);
  });

  it('keeps every other unit whole', () => {
    const [table, wrapper, decoder] = statements(
      `function a() { return ${TABLE}; }\n(function (x) { x.push(x.shift()); })(a());\nvar d = function (i) { return a()[i]; };`,
    );
    const machinery = machineryOf([table!, wrapper!, decoder!], ['d', 'a']);
    expect([...machinery]).toEqual([
      table!.node,
      wrapper!.node,
      (decoder!.node as t.VariableDeclaration).declarations[0],
    ]);
  });

  it('skips a removed declaration', () => {
    const [declaration, other] = statements(`var a = ${TABLE};\nvar b = a;`);
    other!.remove();
    expect(machineryOf([declaration!, other!], ['a']).size).toBe(1);
  });
});
