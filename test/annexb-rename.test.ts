import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * Annex B.3.3 and the renamer.
 *
 * A `function` declared inside a block, a `switch` case or a label in sloppy
 * code is ALSO a `var` of the enclosing function or script, assigned when the
 * block is evaluated. Babel scopes the declaration to the block and records
 * that var nowhere, so `binding.referencePaths` - the list the renamer rewrites
 * - omits every use outside the block. Renaming the declaration alone produced
 * `{ function add() {} } _0x1234()`: a ReferenceError from a program that ran.
 *
 * Every case here runs the input and the output in a realm with only `log`
 * and compares the traces, thrown errors included. A structural check could not
 * tell "renamed consistently" from "renamed the declaration only".
 */

function execute(code: string): string {
  const trace: string[] = [];
  const sandbox = { log: (...parts: unknown[]) => trace.push(parts.map(String).join(' ')) };
  try {
    vm.runInContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

const PRESETS: readonly DeobfuscateOptions[] = [{ preset: 'balanced' }, { preset: 'aggressive' }];

async function expectSameBehaviour(source: string, options: DeobfuscateOptions): Promise<string> {
  const { code } = await deobfuscate(source, options);
  const before = execute(source);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed at ${options.preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
  return code;
}

async function renamesOf(source: string, options: DeobfuscateOptions): Promise<string[]> {
  const { ctx } = await runPass(pass, source, options);
  return ctx.renames.map((entry) => `${entry.from}->${entry.to}`);
}

function behaves(group: string, list: ReadonlyArray<readonly [string, string]>): void {
  describe(group, () => {
    for (const [name, source] of list) {
      for (const options of PRESETS) {
        it(`${name} (${options.preset})`, async () => {
          await expectSameBehaviour(source, options);
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------

behaves('rename.identifiers: a sloppy block-level function is callable outside its block', [
  [
    'a bare block, with an evidence rule firing on the name',
    `{ function _0x1234(a, b) { return a + b; } }
     var o = { add: _0x1234 };
     log(_0x1234(1, 2), o.add(3, 4));`,
  ],
  [
    'the polyfill idiom, obfuscated',
    `if (typeof globalThis.sum !== 'function') { function _0x589579(_0x1, _0x2) { return _0x1 + _0x2; } }
     var _0xc5f6 = { add: _0x589579 };
     log(_0x589579(1, 2), _0xc5f6.add(3, 4), typeof _0x589579);`,
  ],
  [
    'the polyfill idiom, readable',
    `if (typeof globalThis.sum !== 'function') { function sum(a, b) { return a + b; } }
     var ops = { add: sum };
     log(sum(1, 2), ops.add(3, 4), typeof sum);`,
  ],
  [
    'a block function no rule can name',
    `{ function _0x1234() { return 'block'; } }
     log(_0x1234());`,
  ],
  [
    'typeof after an if-block',
    `if (true) { function _0x2f1e() { return 1; } }
     log(typeof _0x2f1e);`,
  ],
  [
    'typeof before and after the block, inside a function',
    `function _0xd6a7() { log(typeof _0x3a5c); { function _0x3a5c() { return 1; } } log(typeof _0x3a5c); }
     _0xd6a7();`,
  ],
  [
    'a try block',
    `try { function _0x4b7d(a) { return a * 2; } } catch (e) {}
     log(_0x4b7d(4));`,
  ],
  [
    'a switch case',
    `switch (1) { case 1: function _0x5c8e(a) { return a * 3; } }
     log(_0x5c8e(4));`,
  ],
  [
    'a loop body',
    `for (var _0x7e0a = 0; _0x7e0a < 1; _0x7e0a++) { function _0x6d9f() { return 'loop'; } }
     log(_0x6d9f());`,
  ],
  [
    'a call from a nested function outside the block',
    `{ function _0xd6a7() { return 'v'; } }
     function _0x3a5c() { return _0xd6a7(); }
     log(_0x3a5c());`,
  ],
  [
    'two block functions sharing one var',
    `{ function _0xd6a7() { return 1; } }
     { function _0xd6a7() { return 2; } }
     log(_0xd6a7());`,
  ],
  // The function's own directive makes its body strict, not the code that
  // declares it; the hoisting is decided by the latter.
  [
    "a block function carrying its own 'use strict'",
    `{ function _0xd6a7() { 'use strict'; return 1; } }
     log(_0xd6a7());`,
  ],
]);

// The other binding of the same var. `var f = 1; { function f() {} }` makes
// `f` the function once the block has run, so renaming the var on its own
// reference list leaves `typeof f` reading the number it started as.
behaves('rename.identifiers: a same-named var in the enclosing scope shares the Annex B binding', [
  [
    'typeof reads the function after the block',
    `function _0x8f1b() { var _0xd6a7 = 'str'; { function _0xd6a7() { return 2; } } return typeof _0xd6a7; }
     log(_0x8f1b());`,
  ],
  [
    'a call through the var reaches the function',
    `function _0x8f1b() { var _0xd6a7 = 'str'; { function _0xd6a7() { return 2; } } return _0xd6a7(); }
     log(_0x8f1b());`,
  ],
]);

// The binding Babel actually resolves the var's references to. With no var in
// its tables, a post-block `e()` inside the function is listed on whatever `e`
// exists ABOVE the var scope, and renaming that binding rewrites the reference
// with it - so the output calls the outer value where the input called the
// hoisted function.
behaves('rename.identifiers: a same-named binding above the var scope shares the Annex B binding', [
  [
    'a catch parameter',
    `function _0xo() { try { throw 'E'; } catch (e) { function _0xw() { { function e() { return 'inner'; } } return e(); } return _0xw() + ':' + e; } }
     log(_0xo());`,
  ],
  [
    'an outer parameter',
    `function _0xo(_0xp) { function _0xw() { { function _0xp() { return 'inner'; } } return _0xp(); } return _0xw() + ':' + _0xp; }
     log(_0xo('outer'));`,
  ],
  [
    'a program-level let',
    `let _0xq = 'outer';
     function _0xw() { { function _0xq() { return 'inner'; } } return _0xq(); }
     log(_0xw() + ':' + _0xq);`,
  ],
  [
    'typeof before the block, in a nested function',
    `function _0xo() { var _0xr = 'outer'; function _0xw() { var _0xb = typeof _0xr; { function _0xr() { return 'inner'; } } return _0xb + ':' + _0xr(); } return _0xw() + ':' + _0xr; }
     log(_0xo());`,
  ],
  [
    'a const in the enclosing function',
    `function _0xo() { const _0xs = 'outer'; function _0xw() { { function _0xs() { return 'inner'; } } return _0xs(); } return _0xw() + ':' + _0xs; }
     log(_0xo());`,
  ],
]);

describe('rename.identifiers: the refusal is only as wide as Annex B', () => {
  const STRICT_SCRIPT = `'use strict';
{ function _0x1234(a, b) { return a + b; } log(_0x1234(1, 2)); }
log(typeof _0x1234);`;

  const IN_CLASS = `class _0xb4e5 { static run() { { function _0x1234(a, b) { return a + b; } return _0x1234(1, 2); } } }
log(_0xb4e5.run());`;

  const MODULE = `{ function _0x1234(a, b) { return a + b; } log(_0x1234(1, 2)); }
export {};`;

  const VAR_SCOPED = `function _0x2f1e() { function _0x3a5c(a, b) { return a + b; } var o = { add: _0x3a5c }; return _0x3a5c(1, 2) + o.add(3, 4); }
log(_0x2f1e());`;

  for (const options of PRESETS) {
    it(`still renames inside a strict script (${options.preset})`, async () => {
      expect(await renamesOf(STRICT_SCRIPT, options)).toContain('_0x1234->add');
      await expectSameBehaviour(STRICT_SCRIPT, options);
    });

    it(`still renames inside a class body (${options.preset})`, async () => {
      expect(await renamesOf(IN_CLASS, options)).toContain('_0x1234->add');
      await expectSameBehaviour(IN_CLASS, options);
    });

    it(`still renames inside a module (${options.preset})`, async () => {
      expect(await renamesOf(MODULE, { ...options, sourceType: 'module' })).toContain(
        '_0x1234->add',
      );
    });

    it(`still renames a function declared directly in a function body (${options.preset})`, async () => {
      expect(await renamesOf(VAR_SCOPED, options)).toContain('_0x3a5c->add');
      await expectSameBehaviour(VAR_SCOPED, options);
    });
  }

  it('refuses the block function and the same-named var, and nothing else', async () => {
    const renames = await renamesOf(
      `function _0x8f1b(_0x9a2c) {
         var _0xd6a7 = 'str';
         var _0xa3d4 = [1, 2];
         { function _0xd6a7() { return _0x9a2c; } }
         return typeof _0xd6a7 + _0xa3d4.length;
       }
       log(_0x8f1b(1));`,
      { preset: 'aggressive' },
    );
    expect(renames.filter((entry) => entry.startsWith('_0xd6a7->'))).toEqual([]);
    expect(renames.some((entry) => entry.startsWith('_0xa3d4->'))).toBe(true);
    expect(renames.some((entry) => entry.startsWith('_0x9a2c->'))).toBe(true);
  });

  // The walk goes UP from the var scope: a same-named binding in a sibling
  // function is not visible from the block, so nothing inside resolves to it
  // and it keeps its rename. The outer parameter, which the post-block call
  // does resolve to, does not.
  it('refuses the outer same-named binding but not one in a sibling var scope', async () => {
    const source = `function _0xo(_0xz) {
       function _0xa() { var _0xz = 'sib'; return _0xz; }
       function _0xw() { { function _0xz() { return 'inner'; } } return _0xz(); }
       return _0xw() + ':' + _0xa() + ':' + _0xz;
     }
     log(_0xo('outer'));`;
    const renames = await renamesOf(source, { preset: 'aggressive' });
    expect(renames.filter((entry) => entry.startsWith('_0xz->'))).toHaveLength(1);
    expect(renames.some((entry) => entry.startsWith('_0xw->'))).toBe(true);
    await expectSameBehaviour(source, { preset: 'aggressive' });
    await expectSameBehaviour(source, { preset: 'balanced' });
  });
});
