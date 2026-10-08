import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

function programOf(code: string, language: 'js' | 'ts'): NodePath<t.Program> {
  const { ast } = parseSource(code, { language, sourceType: 'script' });
  let program!: NodePath<t.Program>;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

/**
 * A write the slicer's mutator search could not see.
 *
 * `var _0xn = 0; _0xn = 1;` beside a decoder that reads `_0xt[_0xi + _0xn]`
 * has always been handled: the bare assignment is a unit, it names `_0xn`, and
 * the slice takes it. The same write one statement deeper - `{ _0xn = 1; }`,
 * `if (true) _0xn = 1;`, `outer: { _0xn = 1; break outer; }` - was not a unit
 * the search recognised, so the slice left it out, both tiers agreed on
 * `_0xn = 0`, and every call site was inlined with the string from the slot
 * next door. No diagnostic, every preset. The output printed `alpha beta` for a
 * program that prints `beta gamma`.
 *
 * Two repairs, and both are executed here. A compound statement that hoists
 * nothing is now taken whole, under the same node budget as a closure-style
 * wrapper, so the three spellings above decode. What cannot be taken - a loop
 * that declares `var i`, a block over the budget, a sibling function that
 * assigns - is refused through `unmodelledMutation`, which used to look for
 * a `push(shift())` and nothing else. A write to the TABLE through a member
 * is neither: `arrayIsImmutable` in `strings.discover` refuses that already,
 * and taking the statement would have exempted it from that audit.
 *
 * Every case runs the input and the output in a fresh realm and compares the
 * traces, because a decoder that decodes the wrong slot produces a program that
 * parses, runs and prints something plausible.
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

/** A three-slot table read through an offset the sibling statement changes. */
function program(mutator: string): string {
  return `var _0xt = ['alpha', 'beta', 'gamma']; var _0xn = 0;
${mutator}
function _0xd(_0xi) { return _0xt[_0xi + _0xn]; }
log(_0xd(0), _0xd(1));`;
}

async function expectSameBehaviour(
  source: string,
  preset: (typeof PRESETS)[number],
  language?: 'ts',
): Promise<Awaited<ReturnType<typeof deobfuscate>>> {
  const result = await deobfuscate(source, { preset, language });
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

describe('a write inside a compound statement is taken as a mutator', () => {
  const taken: [string, string][] = [
    ['a block', '{ _0xn = 1; }'],
    ['an if with an unbraced consequent', 'if (true) _0xn = 1;'],
    ['a labelled block that breaks out of itself', 'outer: { _0xn = 1; break outer; }'],
    ['a while that breaks after one write', 'while (true) { _0xn = 1; break; }'],
    ['a try whose body writes', 'try { _0xn = 1; } catch (e) {}'],
    ['a switch case', 'switch (1) { case 1: _0xn = 1; }'],
    ['an update expression statement', '_0xn++;'],
  ];

  for (const [label, mutator] of taken) {
    it(`decodes through ${label}`, async () => {
      const source = program(mutator);
      expect(execute(source)).toBe('beta gamma');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.code).toContain("'beta'");
        expect(result.code).toContain("'gamma'");
      }
    });
  }

  it('control: the bare assignment spelling decodes as it always has', async () => {
    const source = program('_0xn = 1;');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toBeUndefined();
      expect(result.code).toContain("'gamma'");
    }
  });

  it('leaves a member write and a mutating call on the table to the table audit', async () => {
    // Neither is taken: in the slice they would be exempt from the audit that
    // refuses them, and the audit's refusal is the one with the right message.
    const member = `var _0xt = ['alpha', 'beta', 'gamma']; _0xt[0] = 'zeta';
function _0xd(_0xi) { return _0xt[_0xi]; }
log(_0xd(0), _0xd(1));`;
    const reversed = `var _0xt = ['alpha', 'beta', 'gamma']; _0xt.reverse();
function _0xd(_0xi) { return _0xt[_0xi]; }
log(_0xd(0), _0xd(1));`;
    expect(execute(member)).toBe('zeta beta');
    expect(execute(reversed)).toBe('gamma beta');
    for (const preset of PRESETS) {
      for (const source of [member, reversed]) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toBeUndefined();
        expect(result.metadata.diagnostics.some((d) => /Refusing to inline _0xt/.test(d.message))).toBe(true);
        expect(result.code).toContain('_0xt[');
      }
    }
  });

  it('still refuses a compound statement whose condition reaches outside the sandbox', async () => {
    // Taking `if (flag) ...` means evaluating it, and `flag` is a host name.
    const source = program('if (flag) _0xn = 1;');
    for (const preset of PRESETS) {
      const result = await deobfuscate(source, { preset });
      expect(result.code).toContain('_0xt[');
      expect(refusal(result)).toMatch(/references flag/);
    }
  });
});

describe('a write the search cannot take is refused rather than missed', () => {
  const refused: [string, string][] = [
    // Taking the loop would put it in `sources`, and the pruner deletes what is
    // in `sources` once inlining is done - `i` with it, for anything reading it.
    ['a loop that hoists its counter', 'for (var i = 0; i < 1; i++) { _0xn = 1; }'],
    ['a sibling function that assigns', 'function _0xbump() { _0xn = 1; } _0xbump();'],
  ];

  for (const [label, mutator] of refused) {
    it(`refuses ${label}`, async () => {
      const source = program(mutator);
      expect(execute(source)).toBe('beta gamma');
      for (const preset of PRESETS) {
        const result = await expectSameBehaviour(source, preset);
        expect(refusal(result)).toMatch(/names _0xn/);
        expect(result.code).toContain('_0xt[');
      }
    });
  }

  // The refusal is for the block as it stands. At conservative it stands for
  // the whole run and the table stays encoded. At the other presets the next
  // round's `clean.unused` drops the 150 dead lets, the block is under the
  // budget, and `_0xn = 1` is an ordered assignment the slice takes: the
  // decode is the program's value, and the report carries the adoption in
  // place of the round-one refusal, which the output no longer bears out.
  it('refuses a block over the node budget until a later round shrinks it', async () => {
    const source = program(`{ ${Array.from({ length: 150 }, (_, i) => `let _0xq${i} = ${i};`).join(' ')} _0xn = 1; }`);
    expect(execute(source)).toBe('beta gamma');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      if (preset === 'conservative') {
        expect(refusal(result)).toMatch(/names _0xn/);
        expect(adoption(result)).toBeUndefined();
        expect(result.code).toContain('_0xq0');
        expect(result.code).toContain('_0xt[');
        expect(result.metadata.strings).toHaveLength(0);
      } else {
        expect(refusal(result)).toBeUndefined();
        expect(adoption(result)).toMatch(/^_0xd was deferred or refused on an earlier round/);
        expect(result.code).not.toContain('_0xq0');
        expect(result.code).not.toContain('_0xt[');
        expect(result.metadata.strings).toHaveLength(2);
      }
    }
  });

  it('refuses an assignment hidden in a for head, which is no statement to take', async () => {
    const source = program('for (var i = 0; i < 1; _0xn = 1, i++) {}');
    expect(execute(source)).toBe('beta gamma');
    for (const preset of PRESETS) {
      const result = await expectSameBehaviour(source, preset);
      expect(refusal(result)).toMatch(/names _0xn/);
    }
  });
});

describe('a rotation spelled with a TypeScript wrapper', () => {
  /**
   * The rotation sits in a `for` head the mutator search cannot take, so the
   * only thing between the decoder and a table at rotation zero is the
   * statement scan's `push(shift())` test - and `a.shift() as string` is a
   * `TSAsExpression`, not a `shift` call, until the wrapper is looked through.
   */
  const T = (typed: boolean, annotation: string): string => (typed ? annotation : '');
  const rotated = (typed: boolean): string => `
var _0xt${T(typed, ': string[]')} = ['alpha', 'beta', 'gamma'];
function _0xd(_0xi${T(typed, ': number')})${T(typed, ': string')} { return _0xt[_0xi]${T(typed, '!')}; }
for (var _0xk = 0, _0xw = (function (a${T(typed, ': string[]')}, n${T(typed, ': number')}) { while (n--) a.push(a.shift()${T(typed, ' as string')}); })(_0xt, 1); _0xk < 1; _0xk++) {}
log(_0xd(0), _0xd(1));`;

  const erase = (code: string): string =>
    code.replace(/: string\[\]|: number|: string| as string/g, '').replace(/\]!;/g, '];');

  it('is reported by the slicer through the wrapper', () => {
    expect(sliceForEvaluation(programOf(rotated(false), 'js'), ['_0xd']).unmodelledMutation).toBe('_0xt');
    expect(sliceForEvaluation(programOf(rotated(true), 'ts'), ['_0xd']).unmodelledMutation).toBe('_0xt');
  });

  it('is refused under language ts exactly as its JavaScript spelling is', async () => {
    expect(execute(rotated(false))).toBe('beta gamma');
    for (const preset of PRESETS) {
      const untyped = await expectSameBehaviour(rotated(false), preset);
      expect(refusal(untyped)).toMatch(/push\(shift\(\)\) rotation.*names _0xt/);

      const typed = await deobfuscate(rotated(true), { preset, language: 'ts' });
      expect(refusal(typed)).toMatch(/push\(shift\(\)\) rotation.*names _0xt/);
      expect(execute(erase(typed.code))).toBe('beta gamma');
    }
  });
});
