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
 * An alias born inside a unit the slice TOOK.
 *
 * The escape audit follows a captured name into the units the slice did not
 * take, and skipped the ones it did before reading their captures - so an
 * alias declared beside a needed name never existed to it. `var _0xs = 1,
 * _0xa = _0xo;` is taken for `_0xs` and captures `_0xo` on the way; `_0xa.v =
 * 1` in the next statement writes through it, both tiers read `_0xo.v` as
 * declared, and the program's `beta` came out as `alpha`. The same capture
 * beside the table, and the same for the order audit, whose reach set grew
 * through outside units only: `var _0xs = 1, _0xa = _0xd; log(_0xa(0));
 * _0xn = 1; log(_0xd(0))` printed `alpha beta` and came out `beta beta`.
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

function refused(result: Awaited<ReturnType<typeof deobfuscate>>): boolean {
  return result.metadata.diagnostics.some((d) => /Refusing to evaluate _0x/.test(d.message));
}

describe('an alias captured inside a taken unit is followed', () => {
  const escapes: [string, string, string, 'member' | 'order'][] = [
    [
      'a member write through an alias declared beside a needed offset',
      `var _0xo = { v: 0 };
var _0xs = 1, _0xa = _0xo;
_0xa.v = 1;
var _0xt = ['alpha', 'beta'];
function _0xd(_0xi) { return _0xt[_0xi + _0xo.v * _0xs]; }
log(_0xd(0));`,
      '_0xo',
      'member',
    ],
    [
      'the same capture beside the table',
      `var _0xo = { v: 0 };
var _0xt = ['alpha', 'beta'], _0xa = _0xo;
_0xa.v = 1;
function _0xd(_0xi) { return _0xt[_0xi + _0xo.v]; }
log(_0xd(0));`,
      '_0xo',
      'member',
    ],
    [
      'a call through an alias of the decoder declared beside a needed offset, ahead of a mutator',
      `var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
var _0xs = 1, _0xa = _0xd;
log(_0xa(0)); _0xn = 1; log(_0xd(0));
function _0xd(_0xi) { return _0xt[_0xi + _0xn * _0xs]; }`,
      '_0xn',
      'order',
    ],
    [
      'the same alias beside the table',
      `var _0xn = 0;
var _0xt = ['alpha', 'beta', 'gamma'], _0xa = _0xd;
log(_0xa(0)); _0xn = 1; log(_0xd(0));
function _0xd(_0xi) { return _0xt[_0xi + _0xn]; }`,
      '_0xn',
      'order',
    ],
  ];

  for (const [label, source, name, kind] of escapes) {
    it(`refuses ${label}`, async () => {
      const before = execute(source);
      expect(before).toMatch(/beta$/);
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refused(result)).toBe(true);
        expect(result.metadata.strings).toHaveLength(0);
      }
    });

    it(`reports ${label} against ${name} as ${kind}`, () => {
      const slice = sliceForEvaluation(programOf(source), ['_0xd']);
      expect(slice.unmodelledMutation).toBe(name);
      expect(slice.unmodelledMutationKind).toBe(kind);
    });
  }

  it('still decodes when the alias goes nowhere', async () => {
    // Captured beside the offset and never referenced again: every reference
    // to the alias is exempt, so the capture is inside the model.
    const source = `var _0xo = { v: 0 };
var _0xs = 1, _0xa = _0xo;
var _0xt = ['alpha', 'beta'];
function _0xd(_0xi) { return _0xt[_0xi + _0xo.v * _0xs]; }
log(_0xd(0));`;
    expect(execute(source)).toBe('alpha');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refused(result)).toBe(false);
      expect(result.code).toContain("log('alpha')");
    }
  });
});
