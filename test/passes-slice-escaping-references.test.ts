import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A reference the slice cannot account for, to a name whose identity matters.
 *
 * The member net refuses `_0xo.v = 1`, `_0xo.push(1)`, `_0xset(_0xo)`: the
 * shapes a scan of one statement can name. `_0xset([_0xo])` hands the same
 * object to the same function inside an array literal, and went into no net
 * at all - both tiers agreed `_0xs` is `0`, and the output printed `alpha
 * alpha` for a program that prints `beta beta`. Nine more spellings did the
 * same, every preset, no diagnostic, and a list that grows by the shapes
 * last seen is never finished.
 *
 * So the rule is closed: for a needed name that is not a primitive and not
 * the audited table, any reference in a unit the slice did not take refuses,
 * except a call of a function the slice took and nothing else reassigns, and
 * a capture into a name whose every reference is itself exempt. The ten
 * shapes below are the test of that rule, not its definition.
 *
 * Every case runs input and output in a fresh realm and compares the traces.
 */

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
    trace.push(`THROWN ${err.name}`);
  }
  return trace.join(' | ');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programOf(code: string): NodePath<t.Program> {
  const { ast } = parseSource(code, { language: 'js', sourceType: 'script' });
  let program!: NodePath<t.Program>;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

async function expectSameBehaviour(
  source: string,
  preset: (typeof PRESETS)[number],
): Promise<Awaited<ReturnType<typeof deobfuscate>>> {
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

function refusal(result: Awaited<ReturnType<typeof deobfuscate>>): string | undefined {
  return result.metadata.diagnostics.find((d) => /Refusing to evaluate _0xd/.test(d.message))?.message;
}

/** An offset read off an object that a sibling hands to code that sets it. */
function program(declaration: string, escape: string, read: string): string {
  return `${declaration}
${escape}
var _0xs = ${read};
var _0xt = ['alpha', 'beta'];
function _0xd(_0xi) { return _0xt[_0xi + _0xs]; }
log(_0xd(0), _0xd(0));`;
}

const SETTER = `function _0xset(x) { var o = Array.isArray(x) ? x[0] : x.o || x; o.v = 1; }`;

describe('a reference the slice cannot account for is refused', () => {
  const shapes: [string, string, string, string, 'escape' | 'member'][] = [
    ['inside an array literal argument', `var _0xo = { v: 0 }; ${SETTER}`, '_0xset([_0xo]);', '_0xo.v', 'escape'],
    ['inside an object literal argument', `var _0xo = { v: 0 }; ${SETTER}`, '_0xset({ o: _0xo });', '_0xo.v', 'escape'],
    ['as a branch of a conditional', `var _0xo = { v: 0 }; ${SETTER}`, '_0xset(true ? _0xo : 0);', '_0xo.v', 'escape'],
    ['as an operand of a logical', `var _0xo = { v: 0 }; ${SETTER}`, '_0xset(_0xo || 0);', '_0xo.v', 'escape'],
    ['as a member read handed on', `var _0xo = { c: { v: 0 } }; ${SETTER}`, '_0xset(_0xo.c);', '_0xo.c.v', 'escape'],
    [
      'as the root of a call whose result is written',
      'var _0xo = { v: 0 }; function _0xget() { return _0xo; }',
      '_0xget().v = 1;',
      '_0xo.v',
      'escape',
    ],
    [
      'inside a tagged template',
      'var _0xo = { v: 0 }; function _0xtag(s, o) { o.v = 1; }',
      '_0xtag`x${_0xo}`;',
      '_0xo.v',
      'escape',
    ],
    ['spread into a call', `var _0xo = { v: 0 }; ${SETTER}`, '_0xset(...[_0xo]);', '_0xo.v', 'escape'],
    [
      'yielded to a consumer',
      'var _0xo = { v: 0 }; function* _0xg() { yield _0xo; }',
      '_0xg().next().value.v = 1;',
      '_0xo.v',
      'escape',
    ],
    ['written through an alias', 'var _0xo = { v: 0 };', 'var _0xa = _0xo; _0xa.v = 1;', '_0xo.v', 'member'],
  ];

  for (const [label, declaration, escape, read, kind] of shapes) {
    it(`refuses a reference ${label}`, async () => {
      const source = program(declaration, escape, read);
      expect(execute(source)).toBe('beta beta');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toMatch(/names _0xo/);
        expect(result.metadata.strings).toHaveLength(0);
      }
    });

    it(`reports a reference ${label} as ${kind}`, () => {
      const slice = sliceForEvaluation(programOf(program(declaration, escape, read)), ['_0xd']);
      expect(slice.unmodelledMutation).toBe('_0xo');
      expect(slice.unmodelledMutationKind).toBe(kind);
    });
  }

  it('follows a capture through a nested scope and a second alias', async () => {
    const source = program(
      'var _0xo = { v: 0 };',
      'function _0xrun() { var _0xa = _0xo; var _0xb = _0xa; _0xb.v = 1; } _0xrun();',
      '_0xo.v',
    );
    expect(execute(source)).toBe('beta beta');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toMatch(/names _0xo/);
      expect(result.metadata.strings).toHaveLength(0);
    }
  });

  it('refuses a call through a name that does not hold a function written out', async () => {
    // The value is a function, but only at run time: what `_0xd(0)` runs is
    // not something the slice can point at, so the call is not exemption (a).
    const source = `var _0xt = ['alpha', 'beta', 'gamma'];
var _0xd = (function () { var _0xn = 1; return function (_0xi) { return _0xt[_0xi + _0xn]; }; })();
log(_0xd(0), _0xd(1));`;
    expect(execute(source)).toBe('beta gamma');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(result.metadata.strings).toHaveLength(0);
    }
    const slice = sliceForEvaluation(programOf(source), ['_0xd']);
    expect(slice.unmodelledMutation).toBe('_0xd');
    expect(slice.unmodelledMutationKind).toBe('escape');
  });

  it('refuses a call through an alias when a taken unit rebinds the captured name', async () => {
    // `_0xa` keeps the first function; the slice has only the second.
    const source = `var _0xt = ['alpha', 'beta', 'gamma'];
var _0xd = function (_0xi) { return _0xt[_0xi]; };
var _0xa = _0xd;
_0xd = function (_0xi) { return _0xt[_0xi + 1]; };
log(_0xa(0), _0xd(0));`;
    expect(execute(source)).toBe('alpha beta');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toMatch(/names _0xd/);
      expect(result.metadata.strings).toHaveLength(0);
    }
    const slice = sliceForEvaluation(programOf(source), ['_0xd']);
    expect(slice.unmodelledMutationKind).toBe('order');
  });
});

describe('what the closed rule leaves alone', () => {
  const HEAD = `var _0xt = ['alpha', 'beta', 'gamma'];
(function (a, n) { while (n--) a.push(a.shift()); })(_0xt, 1);
function _0xd(_0xi) { return _0xt[_0xi]; }`;

  const fine: [string, string, string[]][] = [
    ['a call at every site', `${HEAD}\nlog(_0xd(0), _0xd(1));`, ['beta', 'gamma']],
    ['the alias every obfuscator.io build opens with', `var _0xa = _0xd;\n${HEAD}\nlog(_0xa(0), _0xa(1));`, ['beta', 'gamma']],
    [
      'the alias captured again inside every function, as the variable wrapper type lays it out',
      `${HEAD}\nfunction _0xmain() { var _0xw = _0xd; log(_0xw(0), _0xw(1)); }\n_0xmain();`,
      ['beta', 'gamma'],
    ],
    [
      'a wrapper function hoisted above the rotation',
      `function _0xw(_0xi) { return _0xd(_0xi); }\n${HEAD}\nlog(_0xw(0), _0xw(1));`,
      ['beta', 'gamma'],
    ],
    [
      'a call inside a method of a literal',
      `${HEAD}\nvar _0xapi = { read: function () { return _0xd(0) + _0xd(1); } };\nlog(_0xapi.read());`,
      ['beta', 'gamma'],
    ],
    [
      'a call through the decoder rebound by its own body, as the accessor replaces itself',
      `var _0xt = ['alpha', 'beta', 'gamma'];\nfunction _0xd(_0xi) { _0xd = function (_0xj) { return _0xt[_0xj]; }; return _0xd(_0xi); }\nlog(_0xd(0), _0xd(1));`,
      ['alpha', 'beta'],
    ],
    [
      'a primitive handed anywhere at all',
      `var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;\nfunction _0xshow(x) { log('n=' + x.n); }\n_0xshow({ n: _0xn });\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xn]; }\nlog(_0xd(0), _0xd(1));`,
      ['alpha', 'beta'],
    ],
  ];

  for (const [label, source, expected] of fine) {
    it(`decodes with ${label}`, async () => {
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.metadata.strings.map((s) => s.value).sort()).toEqual(expected);
      }
    });
  }
});

describe('a borrowed name is judged the same way', () => {
  it('refuses a write through it from inside the statement that holds the module', async () => {
    const source = `var _0xo = { v: 0 };
var _0xm = (_0xo.v = 1, (function () { var _0xt = ['alpha', 'beta', 'gamma']; function _0xd(_0xi) { return _0xt[_0xi + _0xo.v]; } log(_0xd(0)); return 1; })());`;
    expect(execute(source)).toBe('beta');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toMatch(/names _0xo/);
      expect(result.metadata.strings).toHaveLength(0);
    }
  });

  it('leaves a name the decoder reads through a parameter free, rather than borrowing the outer one', async () => {
    // `_0xs` in the decoder is the parameter; the program-level `_0xs = 1`
    // is a different binding, and evaluating it printed `beta` for `alpha`.
    const source = `var _0xs = 1;
function _0xm(_0xs) { var _0xt = ['alpha', 'beta', 'gamma']; function _0xd(_0xi) { return _0xt[_0xi + _0xs]; } log(_0xd(0)); }
_0xm(0);`;
    expect(execute(source)).toBe('alpha');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(result.metadata.diagnostics.some((d) => /Refusing to evaluate _0xd.*references _0xs/.test(d.message))).toBe(true);
      expect(result.metadata.strings).toHaveLength(0);
    }
  });
});
