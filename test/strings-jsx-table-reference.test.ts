import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * A wrapper's backing table handed to unknown code by a JSX tag.
 *
 * `tableIsStable` judges every spelling of the table's name outside the
 * decoder's machinery, and anything but a member read is a use that could
 * change the table. The index it reads those spellings from listed only
 * `Identifier`, and `<_0xt />` reads the binding through a `JSXIdentifier`:
 * `render(<_0xt />)` with a `render` that reverses `c.type` printed `beta
 * alpha` and came out printing `alpha beta` at every preset, where
 * `render({ type: _0xt })` was refused with "`_0xt` can be changed".
 *
 * JSX does not run in a bare realm, so each program is lowered with esbuild
 * the way a bundler would - `React.createElement` calls against a `React`
 * the program itself declares - and input and output are run in a fresh
 * realm with only `log`. The controls pin the other side: a tag that names
 * something else leaves the table decodable, and the plain spelling of the
 * escape is refused with the same words.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function lower(code: string): string {
  return transformSync(code, { loader: 'jsx', jsx: 'transform', format: 'esm' }).code;
}

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  try {
    vm.runInNewContext(lower(code), vm.createContext({ log }), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(', ');
}

/** The table and its decoder, with `escape` handing the table to `render`. */
function program(escape: string): string {
  return `var React = { createElement: function (type, props) { return { type: type, props: props, children: [].slice.call(arguments, 2) }; } };
var _0xt = ['alpha', 'beta'];
function _0xd(i) { return _0xt[i]; }
function render(c) { if (Array.isArray(c.type)) c.type.reverse(); (c.children || []).forEach(render); }
${escape}
log(_0xd(0), _0xd(1));`;
}

async function expectSameBehaviour(source: string, expected: string): Promise<DeobfuscateResult[]> {
  const before = execute(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  const results: DeobfuscateResult[] = [];
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset, language: 'jsx' });
    const after = execute(result.code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
      );
    }
    results.push(result);
  }
  return results;
}

function refusal(result: DeobfuscateResult): string | undefined {
  return result.metadata.diagnostics.find((d) => /Refusing to inline _0xd/.test(d.message))?.message;
}

describe('a table spelled as a JSX tag is a use that can change it', () => {
  const spellings: [string, string][] = [
    ['a self-closing tag', 'render(<_0xt />);'],
    ['an opening and closing tag', 'render(<_0xt>x</_0xt>);'],
    ['a tag nested in children', 'render(<div><_0xt /></div>);'],
  ];

  for (const [label, escape] of spellings) {
    it(`refuses ${label}`, async () => {
      const results = await expectSameBehaviour(program(escape), 'beta alpha');
      for (const result of results) {
        expect(refusal(result)).toMatch(/_0xt can be changed at line 5/);
        expect(result.code).toContain(escape.replace(/;$/, ''));
        expect(result.code).not.toContain("'alpha', 'beta')");
      }
    });
  }

  it('refuses the plain spelling with the same words', async () => {
    const results = await expectSameBehaviour(program('render({ type: _0xt });'), 'beta alpha');
    for (const result of results) expect(refusal(result)).toMatch(/_0xt can be changed at line 5/);
  });

  it('still decodes a table no tag names', async () => {
    const results = await expectSameBehaviour(
      program('function Other() {} render(<Other />);'),
      'alpha beta',
    );
    for (const result of results) {
      expect(refusal(result)).toBeUndefined();
      expect(result.code).toContain("log('alpha', 'beta')");
    }
  });
});
