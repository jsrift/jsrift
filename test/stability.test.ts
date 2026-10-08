import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * Deobfuscating the engine's own output must be a fixed point.
 *
 * This is not cosmetic. A tool whose output changes every time it is run cannot
 * be diffed across versions, cannot be cached, and cannot be trusted to have
 * finished - and instability of this kind is invisible to every behavioural
 * check, because both spellings run identically.
 */
const LOOP_SAMPLE = [
  "var _0xa = ['alpha', 'beta', 'gamma'];",
  'function _0xd(i) { return _0xa[i]; }',
  'function _0xrun(_0xn) {',
  '  var _0xo = [];',
  '  for (var _0xi = 0; _0xi < _0xn; _0xi++) { _0xo.push(_0xd(_0xi % 3)); }',
  "  return _0xo.join(',');",
  '}',
  'console.log(_0xrun(5));',
].join('\n');

describe('idempotence', () => {
  it.each(['conservative', 'balanced', 'aggressive'] as const)(
    'reaches a fixed point under %s',
    async (preset) => {
      let current = LOOP_SAMPLE;
      const outputs: string[] = [];
      for (let round = 0; round < 4; round++) {
        const result = await deobfuscate(current, { preset });
        current = result.code;
        outputs.push(current);
      }
      // Round 1 does the real work; everything after it must be identical.
      expect(outputs[1]).toBe(outputs[2]);
      expect(outputs[2]).toBe(outputs[3]);
    },
  );

  it('reports no renames once every binding is already well named', async () => {
    // Regression guard: a rule that re-derives a binding's existing name is
    // agreement, not failure. Treating it as failure sent the binding to the
    // typed-fallback branch (`items` -> `arr1`), and the next run's rules renamed
    // it straight back, so the engine oscillated forever.
    const first = await deobfuscate(LOOP_SAMPLE, { preset: 'aggressive' });
    const second = await deobfuscate(first.code, { preset: 'aggressive' });
    expect(second.metadata.renames).toHaveLength(0);
    expect(second.code).toBe(first.code);
  });

  it('does not grow the output on a second pass', async () => {
    const first = await deobfuscate(LOOP_SAMPLE, { preset: 'aggressive' });
    const second = await deobfuscate(first.code, { preset: 'aggressive' });
    expect(second.code.length).toBeLessThanOrEqual(first.code.length);
  });
});

describe('JSX component preservation', () => {
  const SOURCE = [
    "import { jsx as _jsx } from 'react/jsx-runtime';",
    "function _0xC(p) { return _jsx('div', { children: p.t }); }",
    "export default function _0xApp() { return _jsx(_0xC, { t: 'hi' }); }",
  ].join('\n');

  it('keeps a component capitalised so JSX restoration can fire', async () => {
    // A component that has not been restored to JSX yet is still an ordinary
    // call argument, so its current name is not PascalCase and the
    // "was capitalised, must stay capitalised" rule never fires. Renaming it to
    // `fn1` is not incorrect - finalize.jsx correctly refuses to emit `<fn1>` -
    // but the file silently loses its JSX restoration, which is the point.
    const { code } = await deobfuscate(SOURCE, { preset: 'aggressive', language: 'tsx' });
    expect(code).toMatch(/<_0xC\b/);
    expect(code).not.toMatch(/_jsx\(\s*[a-z]/);
  });

  it('still restores the host element', async () => {
    const { code } = await deobfuscate(SOURCE, { preset: 'aggressive', language: 'tsx' });
    expect(code).toContain('<div>');
  });

  it('never emits a lowercase custom tag', async () => {
    const { code } = await deobfuscate(SOURCE, { preset: 'aggressive', language: 'tsx' });
    const tags = [...code.matchAll(/<([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
    const hostTags = new Set(['div', 'span', 'p', 'a', 'ul', 'li', 'button', 'input', 'img']);
    for (const tag of tags) {
      if (/^[a-z]/.test(tag)) expect(hostTags.has(tag)).toBe(true);
    }
  });
});
