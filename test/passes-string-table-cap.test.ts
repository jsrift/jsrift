import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * `MAX_STRING_TABLE_ENTRIES` exists so that a `'...'.split(';')` over a megabyte
 * of text is not materialised during a candidate scan that then rejects it. An
 * array literal is bounded by the parse that already built it, so the cap has
 * no work to do there - and applied there it made a 65,537-entry table come
 * back untouched, with nothing in the metadata to distinguish that from "no
 * string array here". Where the cap does apply, the skip is now said out loud.
 */

const ENTRIES = 65_537;

function execute(code: string): string {
  const out: string[] = [];
  const sandbox: Record<string, unknown> = { console: { log: (...a: unknown[]) => out.push(a.join(' ')) } };
  sandbox['globalThis'] = sandbox;
  vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 10_000 });
  return out.join('|');
}

function entries(): string[] {
  const values: string[] = [];
  for (let index = 0; index < ENTRIES; index++) values.push(`s${index.toString(36)}`);
  return values;
}

/** A few call sites into the far end of the table, so the decode is checkable. */
const SITES = [0, 1, 65_535, 65_536, 4_242, 60_000];

function program(table: string): string {
  const calls = SITES.map((i) => `_0xdec(0x${i.toString(16)})`).join(', ');
  return `var _0xtbl = ${table};\nfunction _0xdec(i) { return _0xtbl[i - 0x0]; }\nconsole.log(${calls});\n`;
}

describe('a string table over 65,536 entries', () => {
  it('spelled as an array literal is decoded like any other', async () => {
    const source = program(`[${entries().map((v) => `'${v}'`).join(',')}]`);
    const expected = execute(source);
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.metadata.strings.length).toBe(SITES.length);
    expect(result.code).not.toContain('_0xdec(');
    expect(execute(result.code)).toBe(expected);
  }, 60_000);

  it('spelled as a split() is left encoded and the metadata says so', async () => {
    const source = program(`'${entries().join(';')}'.split(';')`);
    const expected = execute(source);
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.metadata.strings.length).toBe(0);
    expect(execute(result.code)).toBe(expected);
    const notes = result.metadata.diagnostics.filter((d) => /65,536/.test(d.message));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.severity).toBe('warning');
    expect(notes[0]!.message).toMatch(new RegExp(`${ENTRIES.toLocaleString('en-US')} entries`));
  }, 60_000);
});
