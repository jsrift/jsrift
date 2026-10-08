import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * `clean.unused` leaves a script's top-level declarations alone and says why.
 * On a CommonJS file the old reason - "its top-level declarations are global" -
 * was false: under Node's loader they are locals of the module wrapper, and
 * `Function('return typeof x')()` answers `'undefined'` for every one of them.
 *
 * The refusal itself stays. The same text loaded by a `<script>` tag beside a
 * `require` shim (RequireJS pages do exactly this) makes them globals, and
 * nothing in the file says which loader runs it; a refusal is correct when the
 * proof is missing, but the note has to say that rather than assert the
 * browser case as fact.
 */

const CJS = `
'use strict';
const path = require('path');
const fs = require('fs');
const _0x1a2b = require('util');
function helper() { return path.join('a', 'b'); }
var _0xdead = 42;
module.exports = { helper };
`;

const SCRIPT = `
var kept = 1;
function helper() { return kept; }
console.log(helper());
`;

function scriptNotes(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics
    .filter((d) => d.source === 'clean.unused' && /top-level declarations/.test(d.message))
    .map((d) => d.message);
}

describe('clean.unused: the script-globals note on a CommonJS file', () => {
  it('still keeps the declarations but no longer calls them globals', async () => {
    const result = await deobfuscate(CJS, { preset: 'balanced' });
    expect(result.metadata.sourceType).toBe('script');
    expect(result.code).toContain('_0xdead');
    expect(result.code).toContain("require('fs')");
    const notes = scriptNotes(result);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/require|CommonJS/);
    expect(notes[0]).toMatch(/module-local/);
    expect(notes[0]).not.toMatch(/declarations are global/);
  });

  it('keeps the plain wording for a script with no module signal', async () => {
    const result = await deobfuscate(SCRIPT, { preset: 'balanced' });
    const notes = scriptNotes(result);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/declarations are global/);
    expect(notes[0]).not.toMatch(/require/);
  });
});
