import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * How far the reflection walk follows `var b = a` edges before it gives up.
 *
 * `naming-reflection-aliases.test.ts` covers what the walk *finds*; this file
 * covers what happened at its far end, which used to be the opposite of what
 * the rest of the layer does. The walk was capped at eight hops and the cap
 * returned having frozen nothing, so on a longer chain the function whose
 * `.name` was being read was renamed and the program read back a string its
 * source never contained - the one place in this pass where running out of
 * budget produced wrong output rather than a missed rename.
 *
 * Every assertion is an execution comparison first, so an implementation that
 * freezes a different but still sound set of identifiers keeps passing.
 *
 * Link names are four hex digits (`_0x1101`) rather than three, because
 * `HEX_IDENTIFIER` in `util/ast.ts` needs four before it calls a name
 * generated: with three, the aliases are not rename targets at all and a test
 * that meant to watch them freeze would be watching nothing.
 */

const aggressive: DeobfuscateOptions = { preset: 'aggressive' };

function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ LOG: (value: unknown) => logs.push(String(value)) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

const link = (index: number): string => `_0x11${String(index).padStart(2, '0')}`;

/** `head`, then `hops` chained aliases of it, then whatever `tail` makes of the last. */
function aliasChain(head: string, hops: number, tail: (last: string) => string): string {
  const lines = [head];
  for (let index = 1; index <= hops; index++) {
    lines.push(`var ${link(index)} = ${index === 1 ? headName(head) : link(index - 1)};`);
  }
  lines.push(tail(link(hops)));
  return lines.join('\n');
}

/** The binding a chain hangs off: the declared name in `head`. */
function headName(head: string): string {
  const match = head.match(/^(?:function|class)\s+(\S+?)[\s(]|^var\s+(\S+)\s/);
  return (match?.[1] ?? match?.[2])!;
}

const REFLECTED_FUNCTION = 'function _0x4a68() { return 1; }';

describe('reflection through an alias chain of any length', () => {
  // Seven hops fitted inside the old cap and has always been correct; eight did
  // not, and the walk gave up without freezing anything at all.
  for (const hops of [7, 8, 9, 20]) {
    it(`keeps the reflected declaration name across ${hops} alias hops`, async () => {
      const source = aliasChain(REFLECTED_FUNCTION, hops, (last) => `LOG(${last}.name);`);
      expect(observe(source)).toEqual(['_0x4a68']);
      const { code } = await runPass(pass, source, aggressive);
      expect(observe(code)).toEqual(['_0x4a68']);
      expect(code).toContain('_0x4a68');
    });
  }

  it('freezes the inner id of a named function expression past the old cap', async () => {
    // The observable string lives on the function expression's own id rather
    // than on the binding at the end of the chain, so the walk has to reach the
    // far end *and* pick the right identifier once it is there.
    const source = aliasChain(
      'var _0x1b2c = function _0x9999() { return 1; };',
      12,
      (last) => `LOG(${last}.name);`,
    );
    expect(observe(source)).toEqual(['_0x9999']);
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(['_0x9999']);
    expect(code).toContain('_0x9999');
  });

  it('reaches the far end from every reflection site, not only the first', async () => {
    // Visited bindings are remembered for the whole program rather than for one
    // site, so the second site here finds `_0x2204` already walked. What it must
    // not do is conclude there is nothing left to freeze: `_0x5b79` sits eight
    // hops beyond the point the first site had any reason to stop.
    const source = `
      function _0x4a68() { return 1; }
      function _0x5b79() { return 2; }
      var _0x2201 = _0x4a68, _0x2202 = _0x2201, _0x2203 = _0x2202, _0x2204 = _0x2203;
      var _0x3301 = _0x2204, _0x3302 = _0x3301, _0x3303 = _0x3302, _0x3304 = _0x3303;
      var _0x4401 = _0x5b79, _0x4402 = _0x4401, _0x4403 = _0x4402, _0x4404 = _0x4403;
      var _0x5501 = _0x4404, _0x5502 = _0x5501, _0x5503 = _0x5502, _0x5504 = _0x5503;
      LOG(_0x2204.name);
      LOG(_0x3304.name);
      LOG(_0x5504.name);
    `;
    expect(observe(source)).toEqual(['_0x4a68', '_0x4a68', '_0x5b79']);
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(['_0x4a68', '_0x4a68', '_0x5b79']);
  });
});

describe('the alias walk stays narrow', () => {
  it('leaves a long unreflected chain fully renameable', async () => {
    // Nothing reads a `.name`, so the walk is never entered and the function at
    // the head of the chain is still a rename target. This is the assertion
    // that fails if the cap is fixed by freezing more, everywhere.
    const source = aliasChain(REFLECTED_FUNCTION, 20, (last) => `LOG(${last}());`);
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(observe(source));
    expect(code).not.toContain('_0x4a68');
  });

  it('does not freeze a long chain whose value is not a function or class', async () => {
    // `.name` here is an ordinary property of an object literal, so no
    // identifier's spelling is observable and the whole chain stays renameable
    // however long it is.
    const source = aliasChain(
      `var _0x1b2c = { name: 'literal' };`,
      12,
      (last) => `LOG(${last}.name);`,
    );
    expect(observe(source)).toEqual(['literal']);
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(['literal']);
    expect(code).not.toContain('_0x1b2c');
  });

  it('terminates on a cycle longer than the old cap', async () => {
    // The visited set was always the termination proof and the hop cap only a
    // work bound, so removing the cap must not turn a cyclic alias graph into a
    // hang.
    const lines: string[] = [];
    for (let index = 0; index < 12; index++) {
      lines.push(`var ${link(index)} = ${link((index + 1) % 12)};`);
    }
    lines.push('LOG(typeof _0x1100);');
    const source = lines.join('\n');
    const { code } = await runPass(pass, source, aggressive);
    expect(observe(code)).toEqual(observe(source));
  });
});
