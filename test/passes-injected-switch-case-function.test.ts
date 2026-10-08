import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * `clean.injected-code` folds a `switch` on a literal down to the case it
 * selects, and deleted a `function` declared in a case it dropped.
 *
 * A switch body is one block, and a function declared in any of its cases is
 * instantiated when the switch is ENTERED, whichever case then runs. So the
 * kept case reads the function through the block binding: `switch (1) { case
 * 0: function f() {} break; case 1: log(typeof f); }` prints `function`.
 * `hoistedVarNames` treated the declaration as the `var` Annex B also gives
 * it, and wrote `var f;` in its place - the var is real, but the case that
 * would have assigned it never ran, so the kept case now read `undefined`
 * from it, and in strict code, where there is no var, nothing at all. The
 * round that refused a `let`, `const` or `class` in a dropped case stopped
 * one declaration short. The fold now refuses while the surviving switch can
 * still read the block binding - a reference the scope lists, or string code
 * that can reach the scope - and a function only the dropped case used, or
 * one read only outside the switch through its var, folds as it did.
 *
 * Every case runs input and output in a fresh realm with only `log` and
 * compares the traces, at every preset. The function is observed through
 * `typeof`, its name and a call, never printed: a printed function is its
 * source text, and reformatting that is not a behaviour change.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}`);
  }
  return trace.join(', ');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

async function expectSameBehaviour(source: string, expected: string): Promise<void> {
  const before = execute(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset });
    const after = execute(result.code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
      );
    }
  }
}

describe('clean.injected-code: a function declared in a dropped case', () => {
  it('read by the kept case as a value', async () => {
    await expectSameBehaviour(
      `function h() { switch (1) { case 0: function f() {} break; case 1: log(f.name); } } h();`,
      'f',
    );
  });

  it('read by the kept case through typeof', async () => {
    await expectSameBehaviour(
      `function h() { switch (1) { case 0: function f() {} break; case 1: log(typeof f); } } h();`,
      'function',
    );
  });

  it('captured into an alias and called', async () => {
    await expectSameBehaviour(
      `function h() { switch (1) { case 0: function f() { return 'f'; } break; case 1: var g = f; log(g()); } } h();`,
      'f',
    );
  });

  it('read by a kept default case', async () => {
    await expectSameBehaviour(
      `function h() { switch (5) { case 0: function f() {} break; default: log(typeof f); } } h();`,
      'function',
    );
  });

  it('at the top level of a script', async () => {
    await expectSameBehaviour(
      `switch (1) { case 0: function f() {} break; case 1: log(typeof f); } log(typeof f);`,
      'function, undefined',
    );
  });

  it('in strict code, where there is no var to write', async () => {
    await expectSameBehaviour(
      `'use strict'; function h() { switch (1) { case 0: function f() {} break; case 1: log(typeof f); } } h();`,
      'function',
    );
  });

  it('read by name from string code inside the kept case', async () => {
    await expectSameBehaviour(
      `function h() { switch (1) { case 0: function f() {} break; case 1: log(eval('typeof f')); } } h();`,
      'function',
    );
  });
});

describe('clean.injected-code: the fold is still made where nothing surviving reads the function', () => {
  it('a dropped case of plain statements', async () => {
    const source = `function h() { switch (1) { case 0: log('dead'); break; case 1: log('live'); } } h();`;
    await expectSameBehaviour(source, 'live');
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.code).not.toContain('switch');
    expect(result.code).not.toContain('dead');
  });

  it('a function only the dropped case calls', async () => {
    const source = `function h() { switch (1) { case 0: function f() { return 'dead'; } log(f()); break; case 1: log('live'); } } h();`;
    await expectSameBehaviour(source, 'live');
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.code).not.toContain('switch');
    expect(result.code).not.toContain('dead');
  });

  it('a function read only outside the switch, through the var it hoisted', async () => {
    // Outside the switch the name is the Annex B var, which the case that
    // would have assigned it never ran: `var f;` is the honest reconstruction.
    const source = `function h() { switch ('x') { case 'x': break; case 'y': function f() {} break; } return typeof f; } log(h());`;
    await expectSameBehaviour(source, 'undefined');
    const result = await deobfuscate(source, { preset: 'balanced', techniques: { variableRenaming: false } });
    expect(result.code).not.toContain('switch');
    expect(result.code).toContain('var f;');
  });
});
