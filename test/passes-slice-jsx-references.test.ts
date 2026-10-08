import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A reference the slice's escape audit never opened, because it was spelled
 * as a JSX tag.
 *
 * `render(_0xa)` hands the object to code the slice cannot include, and the
 * audit refuses: the unit is on the `mentionersOf` list for `_0xa`, its exact
 * scan says the name escapes, and the decoder that reads `_0xa.v` is refused
 * for it. `render(<_0xa />)` is the same reference - Babel lists it on the
 * binding, and the exact unit scan already reads a JSX tag as an escape - but
 * the cheap rotation scan that feeds `mentionersOf` spelled only `Identifier`,
 * so the unit was never on the list, the exact scan was never asked, and the
 * decoder was evaluated over an offset the program had already changed:
 * `log('alpha', 'alpha')` for a program that prints `beta beta`.
 *
 * JSX cannot run in a bare realm, so the assertion is the refusal itself,
 * compared against the plain spelling's: the same diagnostic naming the same
 * object, the same absent strings, and a slice verdict against it.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programOf(code: string): NodePath<t.Program> {
  const { ast } = parseSource(code, { language: 'jsx', sourceType: 'script' });
  let program!: NodePath<t.Program>;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

function refusal(result: DeobfuscateResult): string | undefined {
  return result.metadata.diagnostics.find((d) => /Refusing to evaluate _0xd/.test(d.message))?.message;
}

/** An offset read off an object that a sibling hands to code that sets it. */
function program(declaration: string, escape: string): string {
  return `${declaration}
${escape}
var _0xs = _0xo.v;
var _0xt = ['alpha', 'beta'];
function _0xd(_0xi) { return _0xt[_0xi + _0xs]; }
log(_0xd(0), _0xd(0));`;
}

const SETTER = `function render(c) { (c.type || c).v = 1; }`;

describe('a reference spelled as a JSX tag is refused like the plain spelling', () => {
  // A bare argument is the member net's catch and reports as `member`; a tag
  // is an argument the way `[_0xo]` is, caught by the closed rule as `escape`.
  const spellings: [string, string, string, 'member' | 'escape'][] = [
    ['a plain argument', `var _0xo = { v: 0 }; ${SETTER}`, 'render(_0xo);', 'member'],
    ['a self-closing tag', `var _0xo = { v: 0 }; ${SETTER}`, 'render(<_0xo />);', 'escape'],
    ['an opening and closing tag', `var _0xo = { v: 0 }; ${SETTER}`, 'render(<_0xo>x</_0xo>);', 'escape'],
    ['the root of a member tag', `var _0xo = { v: 0, C: function () {} }; ${SETTER}`, 'render(<_0xo.C />);', 'escape'],
    ['a tag nested in children', `var _0xo = { v: 0 }; ${SETTER}`, 'render(<div><_0xo /></div>);', 'escape'],
  ];

  for (const [label, declaration, escape, kind] of spellings) {
    it(`refuses ${label}`, async () => {
      const source = program(declaration, escape);
      for (const preset of PRESETS) {
        const result = await deobfuscate(source, { preset, language: 'jsx' });
        expect(refusal(result)).toMatch(/names _0xo/);
        expect(result.metadata.strings).toHaveLength(0);
        // The reference the refusal is about is still in the output.
        expect(result.code).toContain(escape.replace(/;$/, ''));
      }
    });

    it(`reports ${label} as ${kind}`, () => {
      const slice = sliceForEvaluation(programOf(program(declaration, escape)), ['_0xd']);
      expect(slice.unmodelledMutation).toBe('_0xo');
      expect(slice.unmodelledMutationKind).toBe(kind);
    });
  }

  it('a lower-case tag is a DOM element, not a reference, and refuses nothing', async () => {
    const source = program(`var _0xo = { v: 0 }; ${SETTER}`, 'render(<div />);');
    for (const preset of PRESETS) {
      const result = await deobfuscate(source, { preset, language: 'jsx' });
      expect(refusal(result)).toBeUndefined();
      expect(result.metadata.strings).toHaveLength(1);
      expect(result.code).toContain("log('alpha', 'alpha')");
    }
  });
});

describe('strings.prune-decoders keeps machinery a JSX tag still spells', () => {
  /*
   * The other reader of references with the same blind spot. A primitive
   * offset is not the escape audit's concern - nothing reached through `0`
   * can change it - so the decoder is evaluated; the machinery is then
   * pruned by a survey that resolved every `Identifier` and no
   * `JSXIdentifier`, and `render(<_0xs />)` came out with `var _0xs` gone.
   */
  const source = `var _0xs = 0;
var _0xt = ['alpha', 'beta'];
function _0xd(_0xi) { return _0xt[_0xi + _0xs]; }
render(<_0xs />);
log(_0xd(0), _0xd(1));`;

  it('inlines the strings and keeps the declaration the tag reads', async () => {
    for (const preset of PRESETS) {
      const result = await deobfuscate(source, { preset, language: 'jsx' });
      expect(result.code).toContain("log('alpha', 'beta')");
      expect(result.code).toContain('var _0xs = 0');
      expect(result.code).toContain('<_0xs />');
      const kept = result.metadata.diagnostics.find((d) => /Kept the string-array machinery/.test(d.message));
      expect(kept?.message).toMatch(/_0xs at line 4/);
    }
  });

  it('prunes the same program once the tag is gone', async () => {
    const result = await deobfuscate(source.replace('render(<_0xs />);', 'render();'), { preset: 'balanced', language: 'jsx' });
    expect(result.code).toContain("log('alpha', 'beta')");
    expect(result.code).not.toContain('_0xs');
  });
});
