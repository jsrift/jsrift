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
 * A taken mutator that runs after a call site.
 *
 * The slice is evaluated as a program - every unit it took, in order - and
 * only then is the decoder called, so every call site sees the state after
 * the LAST mutator. `console.log(_0xd(0)); _0xn = 1; console.log(_0xd(0));`
 * prints `alpha` then `beta`; the slice, having run `_0xn = 1` first,
 * inlined `beta` at both. Both tiers agree, every preset, no diagnostic.
 *
 * Order is not modelled, so it is not assumed: a unit before the last taken
 * mutator that uses the decoder - or uses anything that leads to it, `main()`
 * for a `function main() { _0xd(0) }` declared later - is a refusal. A
 * capture is not a use: obfuscator.io opens with `var _0x113c54 = _0x2348;`
 * ahead of its rotation wrapper, and a function declaration hoisted above
 * the wrapper (`stringArrayWrappersType: 'function'`) runs nothing until it
 * is called. Both still decode.
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

const HEAD = `var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;`;
const DECODER = `function _0xd(_0xi) { return _0xt[_0xi + _0xn]; }`;

describe('a call site ahead of a taken mutator is refused', () => {
  const ordered: [string, string, string][] = [
    ['a bare call before a bare assignment', `${HEAD}\nlog(_0xd(0)); _0xn = 1; log(_0xd(0));\n${DECODER}`, 'alpha | beta'],
    [
      'a call before a rotation wrapper',
      `var _0xt = ['alpha', 'beta', 'gamma'];\nlog(_0xd(0));\n(function (a, n) { while (n--) a.push(a.shift()); })(_0xt, 1);\nlog(_0xd(0));\nfunction _0xd(_0xi) { return _0xt[_0xi]; }`,
      'alpha | beta',
    ],
    [
      'a call before a compound mutator',
      `${HEAD}\nlog(_0xd(0)); if (true) { _0xn = 1; } log(_0xd(0));\n${DECODER}`,
      'alpha | beta',
    ],
    [
      'a hoisted function called before the mutator',
      `${HEAD}\n_0xmain(); _0xn = 1; _0xmain();\nfunction _0xmain() { log(_0xd(0)); }\n${DECODER}`,
      'alpha | beta',
    ],
    [
      'a call through an alias captured earlier',
      `${HEAD}\nvar _0xa = _0xd; log(_0xa(0)); _0xn = 1; log(_0xa(0));\n${DECODER}`,
      'alpha | beta',
    ],
    [
      'a callback run before the mutator',
      `${HEAD}\n[0].forEach(function (i) { log(_0xd(i)); }); _0xn = 1; log(_0xd(0));\n${DECODER}`,
      'alpha | beta',
    ],
    [
      'a method of a literal called before the mutator',
      `${HEAD}\nvar _0xapi = { read: function () { return _0xd(0); } }; log(_0xapi.read()); _0xn = 1; log(_0xapi.read());\n${DECODER}`,
      'alpha | beta',
    ],
    [
      'a direct table read before a rotation',
      `var _0xt = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];\nlog(_0xt[0]);\n(function (a, n) { while (n--) a.push(a.shift()); })(_0xt, 1);\nlog(_0xt[0]);`,
      'alpha | beta',
    ],
  ];

  for (const [label, source, expected] of ordered) {
    it(`refuses ${label}`, async () => {
      expect(execute(source)).toBe(expected);
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(result.metadata.diagnostics.some((d) => /Refusing to evaluate _0x/.test(d.message))).toBe(true);
        expect(result.metadata.strings).toHaveLength(0);
      }
    });
  }

  it('reports the mutator as one that runs after a use', () => {
    const slice = sliceForEvaluation(programOf(ordered[0]![1]), ['_0xd']);
    expect(slice.unmodelledMutation).toBe('_0xn');
    expect(slice.unmodelledMutationKind).toBe('order');
  });
});

describe('order is not assumed for what the mutator search did not take either', () => {
  // The decoder reads a name a dependency unit sets on the way to its own,
  // so that the unit is in the slice without ever being taken as a mutator.
  const VIA_SIDE_EFFECT = `function _0xd(_0xi) { return _0xt[_0xi + _0xn + _0xs - 5]; }`;
  const ordered: [string, string, string][] = [
    [
      'a function declared inside a block, called there, ahead of the mutator',
      `${HEAD}\n{ function _0xmain() { log(_0xd(0)); } _0xmain(); }\n_0xn = 1; log(_0xd(0));\n${DECODER}`,
      'alpha | beta',
    ],
    [
      'a dependency whose initialiser assigns the offset in a comma sequence',
      `${HEAD}\nlog(_0xd(0)); var _0xs = (_0xn = 1, 5); log(_0xd(0));\n${VIA_SIDE_EFFECT}`,
      'undefined | beta',
    ],
    [
      'a dependency whose initialiser updates the offset',
      `${HEAD}\nlog(_0xd(0)); var _0xs = _0xn++; log(_0xd(0));\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xn + _0xs]; }`,
      'undefined | beta',
    ],
    [
      'a needed declaration after a use, which the use reads as undefined',
      `var _0xt = ['alpha', 'beta', 'gamma'];\nlog(_0xd(0)); var _0xs = 1; log(_0xd(0));\nfunction _0xd(_0xi) { return _0xt[_0xi + _0xs]; }`,
      'undefined | beta',
    ],
    [
      'the table declared after a use, which throws',
      `log(_0xd(0)); var _0xt = ['alpha', 'beta']; log(_0xd(0));\nfunction _0xd(_0xi) { return _0xt[_0xi]; }`,
      'THROWN TypeError',
    ],
    [
      'a borrowed initialiser after the module IIFE that reads it',
      `(function () { var _0xt = ['alpha', 'beta', 'gamma']; function _0xd(_0xi) { return _0xt[_0xi + _0xs]; } log(_0xd(1)); })();\nvar _0xs = 1;`,
      'undefined',
    ],
    [
      'a module function called ahead of the borrowed initialiser',
      `function _0xmain() { var _0xt = ['alpha', 'beta', 'gamma']; function _0xd(_0xi) { return _0xt[_0xi + _0xs]; } log(_0xd(1)); }\n_0xmain(); var _0xs = 1; _0xmain();`,
      'undefined | gamma',
    ],
  ];

  for (const [label, source, expected] of ordered) {
    it(`refuses ${label}`, async () => {
      expect(execute(source)).toBe(expected);
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(result.metadata.diagnostics.some((d) => /Refusing to evaluate _0x/.test(d.message))).toBe(true);
        expect(result.metadata.strings).toHaveLength(0);
      }
    });
  }

  it('reports each as a mutator that runs after a use', () => {
    for (const [, source] of ordered.slice(0, 5)) {
      const slice = sliceForEvaluation(programOf(source), ['_0xd']);
      expect(slice.unmodelledMutationKind).toBe('order');
    }
  });

  const fine: [string, string][] = [
    [
      'a module function declared ahead of the borrowed initialiser, called after it',
      `function _0xmain() { var _0xt = ['alpha', 'beta', 'gamma']; function _0xd(_0xi) { return _0xt[_0xi + _0xs]; } log(_0xd(0), _0xd(1)); }\nvar _0xs = 1; _0xmain();`,
    ],
    [
      'a borrowed initialiser ahead of the module IIFE',
      `var _0xs = 1;\n(function () { var _0xt = ['alpha', 'beta', 'gamma']; function _0xd(_0xi) { return _0xt[_0xi + _0xs]; } log(_0xd(0), _0xd(1)); })();`,
    ],
  ];

  for (const [label, source] of fine) {
    it(`decodes ${label}`, async () => {
      expect(execute(source)).toBe('beta gamma');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.metadata.strings.map((s) => s.value).sort()).toEqual(['beta', 'gamma']);
      }
    });
  }
});

describe('what runs before a taken mutator without using the decoder still decodes', () => {
  const fine: [string, string][] = [
    ['an alias captured ahead of the mutator, called after it', `${HEAD}\nvar _0xa = _0xd; _0xn = 1; log(_0xa(0), _0xa(1));\n${DECODER}`],
    [
      'a function declared ahead of the mutator, called after it',
      `${HEAD}\nfunction _0xmain() { log(_0xd(0), _0xd(1)); } _0xn = 1; _0xmain();\n${DECODER}`,
    ],
    [
      'a wrapper function hoisted above the rotation, as a function-wrappers build is laid out',
      `function _0xw(_0xi) { return _0xd(_0xi); }\nvar _0xt = ['alpha', 'beta', 'gamma'];\n(function (a, n) { while (n--) a.push(a.shift()); })(_0xt, 1);\nfunction _0xd(_0xi) { return _0xt[_0xi]; }\nlog(_0xw(0), _0xw(1));`,
    ],
    ['an unrelated statement ahead of the mutator', `${HEAD}\nlog('start'); _0xn = 1; log(_0xd(0), _0xd(1));\n${DECODER}`],
    ['the mutator first, then every call', `${HEAD}\n_0xn = 1; log(_0xd(0)); log(_0xd(1));\n${DECODER}`],
  ];

  for (const [label, source] of fine) {
    it(`decodes ${label}`, async () => {
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.metadata.strings.map((s) => s.value).sort()).toEqual(['beta', 'gamma']);
      }
    });
  }
});
