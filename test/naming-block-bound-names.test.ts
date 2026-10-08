import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * A `var` is a binding of its function, declared wherever its declarator
 * sits: a block that binds a `let`, a `catch` whose parameter shares the
 * name, a scope where Annex B has made a block-level function a var too. The
 * allocator has to prove the new name against every scope between the
 * declarator and the function as well as against the function itself, or the
 * output re-declares a name the block already binds - a SyntaxError from a
 * program that ran, or a catch parameter read where the var was meant.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  try {
    vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  } catch (error) {
    const err = error as Error;
    lines.push(`THROWN ${err.name}: ${err.message}`);
  }
  return lines.join(' | ');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

describe('a var declared below a block binding of the name it would take', () => {
  const cases: [string, string][] = [
    [
      'a let in the block holding the declarator',
      'function f(x) { if (x) { let count = 1; var q = count + 1; } q++; return q; } log(f(1));',
    ],
    [
      'the parameter of the catch holding the declarator',
      "function f() { try { x(); } catch (error) { var q = new Error('e'); } return q; } log(f() instanceof Error);",
    ],
    [
      'a let two blocks above the declarator',
      'function f(x) { if (x) { let count = 5; { var q = count + 1; } } return q; } log(f(1));',
    ],
    [
      'a block-level function that Annex B makes a var of the same scope',
      "var fns = []; function WebSocket(u) { this.u = u; } function setup(url, legacy) { var q = new WebSocket(url); if (legacy) { function socket() { return 'blk'; } fns.push(socket); } return q; } log(setup('ws', true) instanceof WebSocket); log(fns.length);",
    ],
  ];

  for (const [title, source] of cases) {
    for (const preset of PRESETS) {
      it(`${title}, ${preset}`, async () => {
        const code = await output(source, preset);
        expect(trace(code)).toBe(trace(source));
      });
    }
  }
});
