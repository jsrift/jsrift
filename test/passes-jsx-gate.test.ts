import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * `finalize.jsx` only emits JSX into a `jsx`/`tsx` tree - JSX in a `.js` or
 * `.ts` file is output that does not re-parse. Every compiled React bundle is
 * a `.js` file, and `_jsx('div', {...})` is plain JavaScript, so the auto ladder
 * pins `js` and the pass never runs on the shape it exists for. The detection
 * fired, the change count was zero, and nothing said why: that reads as a
 * broken feature. The gate stays; it now says so.
 */

const COMPILED = `
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function App() {
  return _jsxs("div", { className: "app", children: [_jsx("h1", { children: "Hi" }), _jsx(Item, { id: 1 })] });
}
function Item(props) { return _jsx("li", { children: props.id }); }
`;

function gateNotes(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics
    .filter((d) => d.source === 'finalize.jsx')
    .map((d) => d.message);
}

describe('finalize.jsx says when the dialect gate left runtime calls in place', () => {
  it('a compiled React file with no dialect given', async () => {
    const result = await deobfuscate(COMPILED, { preset: 'balanced' });
    expect(result.metadata.language).toBe('js');
    expect(result.metadata.detections.some((d) => d.kind === 'jsx-runtime')).toBe(true);
    expect(result.code).toContain('_jsxs("div"');
    const notes = gateNotes(result);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/dialect is js/);
    expect(notes[0]).toMatch(/language: 'jsx'/);
    expect(result.metadata.diagnostics.find((d) => d.source === 'finalize.jsx')?.severity).toBe('warning');
  });

  it('the same file as jsx restores JSX and carries no note', async () => {
    const result = await deobfuscate(COMPILED, { preset: 'balanced', language: 'jsx' });
    expect(result.code).toContain('<h1>Hi</h1>');
    expect(result.code).toContain('<Item id={1} />');
    expect(gateNotes(result)).toEqual([]);
  });

  it('a .jsx filename is enough', async () => {
    const result = await deobfuscate(COMPILED, { preset: 'balanced', filename: 'App.jsx' });
    expect(result.code).toContain('<h1>Hi</h1>');
    expect(gateNotes(result)).toEqual([]);
  });

  it('a js file with no runtime calls gets no note', async () => {
    const result = await deobfuscate('export function f(a) { return a + 1; }', { preset: 'balanced' });
    expect(gateNotes(result)).toEqual([]);
  });
});
