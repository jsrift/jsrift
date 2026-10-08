import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { foldConstantsPass } from '../src/passes/simplify/fold-constants.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { runPass } from './helpers.js';

/**
 * The writer `binding.constantViolations` never lists: a sloppy block-level
 * function with the callee's name.
 *
 * Annex B.3.3 gives `{ function f() {} }` a second binding - a `var f` in the
 * enclosing function or script, assigned the block's function when the block
 * runs - and Babel scopes the declaration to the block, so that var appears
 * in no scope table and on no violation list. `resolveWrapperCall` in
 * `simplify/fold-constants` and `readCandidate` in `simplify/proxy-functions`
 * both trusted the list: the first folded `f()` to the outer body's value at
 * conservative, the second expanded it at balanced and aggressive, and the
 * output printed `outer` for a program that prints `inner`. The same trust in
 * `resolveFrozenTable` folded `T.slice(0, 1).join('')` to `'x'` on a program
 * that throws, because `T` is a function by the time the read runs.
 *
 * Every case is executed before and after, at every preset, because a fold to
 * the wrong body is a program that parses and runs.
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

async function expectSameBehaviour(source: string): Promise<void> {
  const before = execute(source);
  for (const preset of PRESETS) {
    const { code } = await deobfuscate(source, { preset });
    const after = execute(code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
      );
    }
  }
}

const SAME_SCOPE = `function _0xa() { return 'outer'; }
{ function _0xa() { return 'inner'; } }
log(_0xa());`;

const CROSS_SCOPE = `function _0xa() { return 'outer'; }
function _0xw() {
  { function _0xa() { return 'inner'; } }
  return _0xa();
}
log(_0xw(), _0xa());`;

describe('a wrapper call whose name a sloppy block function can shadow', () => {
  it('is not folded when the block is in the same scope as the call', async () => {
    expect(execute(SAME_SCOPE)).toBe('inner');
    await expectSameBehaviour(SAME_SCOPE);
    for (const preset of PRESETS) {
      expect((await deobfuscate(SAME_SCOPE, { preset })).code).not.toContain("log('outer')");
    }
  });

  it('is not folded inside the function the block hoists into, and still is outside it', async () => {
    expect(execute(CROSS_SCOPE)).toBe('inner outer');
    await expectSameBehaviour(CROSS_SCOPE);
    for (const preset of PRESETS) {
      const { code } = await deobfuscate(CROSS_SCOPE, { preset });
      // The block hoists into `_0xw`, not into the script: the top-level call
      // still reaches the declaration it names and is still resolved.
      expect(code).toMatch(/return _0xa\(\);/);
      expect(code).toMatch(/log\(_0xw\(\), 'outer'\)/);
    }
  });

  it('is refused by each resolver on its own, not only by the pipeline', async () => {
    // `fold-constants` at conservative is the wrapper evaluator; the proxy
    // expansion is what reached the same rewrite at balanced and aggressive.
    for (const pass of [foldConstantsPass, inlineProxyFunctionsPass]) {
      for (const source of [SAME_SCOPE, CROSS_SCOPE]) {
        const { code } = await runPass(pass, source);
        expect(execute(code)).toBe(execute(source));
      }
    }
  });

  it('control: strict code has no Annex B, and the fold stands', async () => {
    const strict = `'use strict';\n${SAME_SCOPE}`;
    expect(execute(strict)).toBe('outer');
    await expectSameBehaviour(strict);
    expect((await deobfuscate(strict, { preset: 'balanced' })).code).toContain("log('outer')");
  });

  it('control: a same-named block function in an unrelated function changes nothing', async () => {
    const elsewhere = `function _0xa() { return 'outer'; }
function _0xother() { { function _0xa() { return 'inner'; } } return _0xa(); }
log(_0xa(), _0xother());`;
    expect(execute(elsewhere)).toBe('outer inner');
    await expectSameBehaviour(elsewhere);
    expect((await deobfuscate(elsewhere, { preset: 'balanced' })).code).toMatch(/log\('outer', /);
  });
});

describe('a frozen table whose name a sloppy block function can shadow', () => {
  const TABLE = `var T = ['x', 'y'];
{ function T() { return 'inner'; } }
log(T.slice(0, 1).join(''));`;

  const TABLE_CROSS = `var T = ['x', 'y'];
function w() {
  { function T() { return 'inner'; } }
  return T.slice(0, 1).join('');
}
log(w());`;

  it('is not resolved through the declarator', async () => {
    // The program throws: `T` is the function once the block has run.
    expect(execute(TABLE)).toBe('THROWN TypeError');
    expect(execute(TABLE_CROSS)).toBe('THROWN TypeError');
    await expectSameBehaviour(TABLE);
    await expectSameBehaviour(TABLE_CROSS);
    for (const source of [TABLE, TABLE_CROSS]) {
      const { code } = await runPass(foldConstantsPass, source);
      expect(code).not.toContain("log('x')");
      expect(code).toContain('slice(0, 1)');
    }
  });
});
