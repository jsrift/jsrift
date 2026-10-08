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
 * A compound statement that writes the offset AND leaves the statement list
 * it sits in.
 *
 * Taking `{ _0xn = 1; }` whole as a mutator fixed the slot-next-door bug; it
 * also took `if (true) { _0xn = 1; return 'early'; }`, and that is worse than
 * the bug it fixed. Evaluated as a program-level statement, the `return`
 * completion is discarded, the decoder is built with `_0xn = 1`, and the
 * pruner deletes the whole unit with the machinery - `return 'early'`
 * included. The function then runs on to `return _0xd(0)`, a call the input
 * never reaches, and prints `beta` for a program that prints `early`. Every
 * preset, no diagnostic, and the input's control flow is what changed.
 *
 * The slicer now declines any compound that can complete other than by
 * running off its end - a `return`, a `break` or `continue` aimed past its
 * own loops and labels, an `await` or `yield` - and leaves it to the
 * assignment net, which refuses. A `throw` is not on that list: it ends the
 * slice's run exactly as it ends the program's.
 *
 * Every case runs input and output in a fresh realm and compares the traces,
 * thrown error kinds included.
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

/** The line that replaces a refusal once a later round adopts the decoder. */
function adoption(result: Awaited<ReturnType<typeof deobfuscate>>): string | undefined {
  return result.metadata.diagnostics.find((d) => /_0xd was deferred or refused on an earlier round/.test(d.message))
    ?.message;
}

/** The decoder in a function body, with the compound between the offset and the call the input never reaches. */
function inFunction(compound: string): string {
  return `function _0xw() { var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
${compound}
return _0xd(0); function _0xd(_0xi) { return _0xt[_0xi + _0xn]; } }
log(_0xw());`;
}

/** The decoder in a loop body, with the compound leaving the loop before the call. */
function inLoop(compound: string): string {
  return `outer: for (var _0xk = 0; _0xk < 2; _0xk++) { var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
${compound}
log(_0xd(0)); function _0xd(_0xi) { return _0xt[_0xi + _0xn]; } }
log('k=' + _0xk);`;
}

describe('a compound mutator that leaves its statement list is refused, not taken', () => {
  const shapes: [string, string, string][] = [
    ['an if that returns', inFunction("if (true) { _0xn = 1; return 'early'; }"), 'early'],
    ['a block that returns nothing', inFunction('{ _0xn = 1; return; }'), 'undefined'],
    ['a labelled block that returns', inFunction("outer: { _0xn = 1; return 'early'; }"), 'early'],
    ['a try that returns through a finally', inFunction("try { _0xn = 1; return 'early'; } finally { _0xn = 2; }"), 'early'],
    ['a while that returns', inFunction("while (true) { _0xn = 1; return 'early'; }"), 'early'],
    [
      'a return inside a module IIFE',
      `log((function () { var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
if (true) { _0xn = 1; return 'early'; }
return _0xd(0); function _0xd(_0xi) { return _0xt[_0xi + _0xn]; } })());`,
      'early',
    ],
    ['a break aimed past the compound', inLoop('while (true) { _0xn = 1; break outer; }'), 'k=0'],
    ['a continue aimed past the compound', inLoop('while (true) { _0xn = 1; continue outer; }'), 'k=2'],
  ];

  for (const [label, source, expected] of shapes) {
    it(`refuses ${label}`, async () => {
      expect(execute(source)).toBe(expected);
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toMatch(/names _0xn/);
        expect(result.metadata.strings).toHaveLength(0);
      }
    });
  }

  it('reports the write as an assignment the slice could not include', () => {
    const slice = sliceForEvaluation(programOf(inFunction("if (true) { _0xn = 1; return 'early'; }")), ['_0xd']);
    // The direct caller slices the program; the decoder is one scope down.
    expect(slice.unmodelledMutation).toBe('_0xn');
    expect(slice.unmodelledMutationKind).toBe('assignment');
  });

  it('refuses an await and a yield the same way', async () => {
    const awaited = `async function _0xw() { var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
if (true) { _0xn = 1; await 0; }
return _0xd(0); function _0xd(_0xi) { return _0xt[_0xi + _0xn]; } }
_0xw().then(function (v) { log(v); });`;
    const yielded = `function* _0xw() { var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
if (true) { _0xn = 1; yield 'early'; }
return _0xd(0); function _0xd(_0xi) { return _0xt[_0xi + _0xn]; } }
var _0xg = _0xw(); log(_0xg.next().value, _0xg.next().value);`;
    expect(execute(yielded)).toBe('early beta');
    // Refused while the `if (true)` compound stands - for the whole run at
    // conservative. At the other presets the next round folds the compound
    // away, `_0xn = 1` is an ordered assignment the slice takes, and the decode
    // is the value the program computes; the report then carries the adoption
    // in place of the refusal, which the output no longer bears out.
    for (const preset of PRESETS) {
      for (const source of [awaited, yielded]) {
        const result = await expectSameBehaviour(source, preset);
        if (preset === 'conservative') {
          expect(refusal(result)).toMatch(/names _0xn/);
          expect(adoption(result)).toBeUndefined();
          expect(result.code).toContain('if (true)');
          expect(result.metadata.strings).toHaveLength(0);
        } else {
          expect(refusal(result)).toBeUndefined();
          expect(adoption(result)).toMatch(/^_0xd was deferred or refused on an earlier round/);
          expect(result.code).not.toContain('if (true)');
          expect(result.code).not.toContain('_0xd(0)');
          expect(result.metadata.strings).toHaveLength(1);
        }
      }
    }
  });
});

describe('a compound that completes normally is still taken', () => {
  const taken: [string, string][] = [
    ['a throw that ends the run as the program ends', "if (false) { _0xn = 1; throw new Error('never'); } _0xn = 1;"],
    ['a break aimed at its own loop', 'while (true) { _0xn = 1; break; }'],
    ['a continue aimed at its own loop', 'for (let _0xj = 0; _0xj < 1; _0xj++) { _0xn = 1; continue; }'],
    ['a labelled break aimed at its own label', 'outer: { _0xn = 1; break outer; }'],
    ['a break inside its own switch', 'switch (1) { case 1: _0xn = 1; break; }'],
    // The `return` is inside a function the block declares and never calls;
    // it ends that function, not the block, and must not make the block one
    // that leaves.
    ['a return inside a nested function it never calls', '{ let _0xf = function () { return 1; }; _0xn = 1; }'],
  ];

  for (const [label, compound] of taken) {
    it(`decodes through ${label}`, async () => {
      const source = `var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
${compound}
function _0xd(_0xi) { return _0xt[_0xi + _0xn]; }
log(_0xd(0), _0xd(1));`;
      expect(execute(source)).toBe('beta gamma');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.code).toContain("'beta'");
        expect(result.code).toContain("'gamma'");
      }
    });
  }
});
