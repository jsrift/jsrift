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
 * A write THROUGH a name the slice includes, other than the table.
 *
 * `var _0xo = { v: 0 }; _0xo.v = 1; var _0xs = _0xo.v;` beside a decoder that
 * reads `_0xt[_0xi + _0xs]`: the slice takes `_0xo` and `_0xs`, the member
 * write is no unit the mutator search recognises, and it went into no
 * refusal net either - the assignment net was narrowed to bare names on the
 * argument that a member write is the table audit's question. It is, for the
 * table. For every other binding in the slice it was nobody's: both tiers
 * agreed `_0xs` is `0`, and the output printed `alpha alpha` for a program
 * that prints `beta beta`. Every preset, no diagnostic.
 *
 * Seven spellings of the same fact, none of which a scan of one statement
 * can tell apart from a harmless one - `test` moves `lastIndex`, and
 * `defineProperty` is an ordinary call with the object as an argument - so
 * every write through a member, every `delete`, every method call and every
 * hand-off to a call counts, and `unmodelledMutation` refuses. The table is
 * still the audit's: its message names the reference, and it runs on the
 * whole program rather than the owning scope.
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

/** An offset read off an object the sibling statement changes through a member. */
function program(declaration: string, mutation: string, read: string): string {
  return `${declaration}
${mutation}
var _0xs = ${read};
var _0xt = ['alpha', 'beta'];
function _0xd(_0xi) { return _0xt[_0xi + _0xs]; }
log(_0xd(0), _0xd(0));`;
}

describe('a write through a slice binding that is not the table is refused', () => {
  const spellings: [string, string, string, string, string][] = [
    ['a member assignment', 'var _0xo = { v: 0 };', '_0xo.v = 1;', '_0xo.v', '_0xo'],
    ['a mutating call', 'var _0xo = [];', '_0xo.push(1);', '_0xo.length', '_0xo'],
    ['an index assignment', 'var _0xo = [0];', '_0xo[0] = 1;', '_0xo[0]', '_0xo'],
    ['a delete', 'var _0xo = { v: 0 };', 'delete _0xo.v;', '_0xo.v === undefined ? 1 : 0', '_0xo'],
    ['a method that moves lastIndex', 'var _0xr = /a/g;', "_0xr.test('aa');", '_0xr.lastIndex', '_0xr'],
    [
      'a defineProperty',
      'var _0xo = { v: 0 };',
      "Object.defineProperty(_0xo, 'v', { get: function () { return 1; } });",
      '_0xo.v',
      '_0xo',
    ],
    ['a __proto__ assignment', 'var _0xp = { v: 1 }; var _0xo = {};', '_0xo.__proto__ = _0xp;', '_0xo.v | 0', '_0xo'],
  ];

  for (const [label, declaration, mutation, read, name] of spellings) {
    it(`refuses ${label}`, async () => {
      const source = program(declaration, mutation, read);
      expect(execute(source)).toBe('beta beta');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toMatch(new RegExp(`names ${name}`));
        expect(result.metadata.strings).toHaveLength(0);
      }
    });

    it(`reports ${label} as a write through ${name}`, () => {
      const slice = sliceForEvaluation(programOf(program(declaration, mutation, read)), ['_0xd']);
      expect(slice.unmodelledMutation).toBe(name);
      expect(slice.unmodelledMutationKind).toBe('member');
    });
  }

  it('refuses a hand-off to a plain call, which may do any of the above', async () => {
    const source = program('var _0xo = { v: 0 }; function _0xbump(o) { o.v = 1; }', '_0xbump(_0xo);', '_0xo.v');
    expect(execute(source)).toBe('beta beta');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toMatch(/names _0xo/);
      expect(result.metadata.strings).toHaveLength(0);
    }
  });
});

describe('what the member net leaves alone', () => {
  it('a hand-off of a primitive, which no callee can change through', async () => {
    // `_0xn` is a number: `_0xn.x = 1` and `f(_0xn)` cannot give it a new
    // value, and a bare reassignment is the assignment net's. Refusing here
    // would refuse every decoder whose offset is ever passed to anything.
    const source = `var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 1;
function _0xshow(n) { log('n=' + n); }
_0xshow(_0xn);
function _0xd(_0xi) { return _0xt[_0xi + _0xn]; }
log(_0xd(0), _0xd(1));`;
    expect(execute(source)).toBe('n=1 | beta gamma');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toBeUndefined();
      expect(result.metadata.strings.map((s) => s.value)).toEqual(['beta', 'gamma']);
    }
  });

  it('the table, whose writes are the reference audit\'s with its own message', async () => {
    const member = `var _0xt = ['alpha', 'beta', 'gamma']; _0xt[0] = 'zeta';
function _0xd(_0xi) { return _0xt[_0xi]; }
log(_0xd(0), _0xd(1));`;
    const handed = `var _0xt = ['alpha', 'beta', 'gamma']; Object.freeze(_0xt);
function _0xd(_0xi) { return _0xt[_0xi]; }
log(_0xd(0), _0xd(1));`;
    for (const preset of PRESETS) {
      for (const source of [member, handed]) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.metadata.diagnostics.some((d) => /Refusing to inline _0xt/.test(d.message))).toBe(true);
        expect(result.metadata.strings).toHaveLength(0);
      }
    }
  });

  it('a direct caller with no table tagged gets the stricter answer for it', () => {
    const slice = sliceForEvaluation(
      programOf(`var _0xt = ['alpha', 'beta', 'gamma']; _0xt[0] = 'zeta';
function _0xd(_0xi) { return _0xt[_0xi]; }
log(_0xd(0), _0xd(1));`),
      ['_0xd'],
    );
    expect(slice.unmodelledMutation).toBe('_0xt');
    expect(slice.unmodelledMutationKind).toBe('member');
  });

  it('a rotation is still reported as the rotation, whatever else the wrapper does', () => {
    const slice = sliceForEvaluation(
      programOf(`var _0xt = ['alpha', 'beta', 'gamma'];
function _0xd(_0xi) { return _0xt[_0xi]; }
for (var _0xk = 0, _0xw = (function (a, n) { a.x = 1; while (n--) a.push(a.shift()); })(_0xt, 1); _0xk < 1; _0xk++) {}
log(_0xd(0), _0xd(1));`),
      ['_0xd'],
    );
    expect(slice.unmodelledMutation).toBe('_0xt');
    expect(slice.unmodelledMutationKind).toBe('shuffle');
  });
});
