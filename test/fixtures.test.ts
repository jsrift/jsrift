import { beforeAll, describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';
import { assertParses } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

/**
 * The whole engine against the two real files it was built for.
 *
 * Unit tests prove each pass does what it claims on a shape someone wrote by
 * hand. Only this file proves the claim that matters: that a 470 KB minified
 * bundle and a 4 MB obfuscator.io build come out the other side readable and
 * still valid JavaScript. Every number asserted here was measured, and the
 * measurements are printed so a regression shows up as a number that moved
 * rather than as a red test with no context.
 *
 * Each fixture is deobfuscated exactly once and the result shared, because a
 * full run over the large fixture is a dozen seconds of uninterrupted CPU and
 * repeating it per assertion buys nothing.
 */

const LIGHT_FIXTURE = thirdPartyFixture('lightly-obfuscated.js');
const HEAVY_FIXTURE = thirdPartyFixture('obfuscated2.js');

/** Generous: the 4 MB fixture takes ~13 s here, and CI machines are slower. */
const FIXTURE_TIMEOUT = 600_000;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function summarise(label: string, source: string, result: DeobfuscateResult): void {
  const { stats } = result.metadata;
  console.log(
    `\n${label}\n` +
      `  wall clock      ${(stats.totalMs / 1000).toFixed(1)}s ` +
      `(parse ${stats.parseMs.toFixed(0)}ms, transform ${stats.transformMs.toFixed(0)}ms, ` +
      `generate ${stats.generateMs.toFixed(0)}ms)\n` +
      `  size            ${source.length} -> ${stats.outputBytes} bytes ` +
      `(${((stats.outputBytes / source.length) * 100).toFixed(0)}%), ` +
      `${stats.inputLines} -> ${stats.outputLines} lines\n` +
      `  strings         ${result.metadata.strings.length} distinct references decoded\n` +
      `  changes         ${stats.totalChanges} over ${stats.iterations} iteration(s), verified=${stats.verified}`,
  );
  for (const diagnostic of result.metadata.diagnostics.filter((d) => d.source.startsWith('strings.'))) {
    console.log(`  [${diagnostic.severity}] ${diagnostic.message}`);
  }
}

// ---------------------------------------------------------------------------
// lightly-obfuscated.js - a UglifyJS-mangled bundle with one plain string array
// ---------------------------------------------------------------------------

/**
 * The table's own entries are reprinted from the source's raw text, so they
 * keep the double quotes they were written with while everything the engine
 * builds comes out in the configured single quotes. Matching either is what
 * makes this a test about the declaration rather than about the printer.
 */
const ARRAY_DECLARATION = /\[\s*["']jQuery["']\s*,/g;

/**
 * This fixture is also the engine's one committed example of the string-code
 * trade, so every assertion below says which preset it belongs to.
 *
 * The file contains a single `Function(_)` call whose argument is an
 * Identifier - a name reused across dozens of scopes here, so nothing resolves
 * it statically and nothing bounds what it compiles. Code compiled that way
 * runs in global scope, where it can address this program's string array by
 * name: read it after the engine deleted it, or write it before an inlined
 * value is used. `conservative` and `balanced` therefore refuse to decode this
 * table at all. `aggressive` accepts the second hazard as drift and inlines
 * every read - and keeps the declaration, because the first hazard is not
 * drift: a deleted name the compiled source spells is a `ReferenceError` where
 * the input ran. See `StringDecodingOptions.decodeDespiteStringCode` in
 * src/types.ts, and `test/string-code-preset-gate.test.ts` for the executed
 * version of both halves.
 *
 * Both sides are asserted, and that is deliberate: a suite that pinned only the
 * decoding side would let the safe presets quietly start decoding this table,
 * and that regression is invisible - the output would still parse, still read
 * well, and compute something else. The kept declaration is pinned for the
 * same reason in the other direction: with it deleted the output still parses,
 * still reads well, and throws the first time the compiled source names it.
 */
describe.skipIf(!LIGHT_FIXTURE.present)('lightly-obfuscated.js', () => {
  let source: string;
  /** The default preset, which refuses this file's table. */
  let balanced: DeobfuscateResult;
  /** The one preset that takes the trade. */
  let aggressive: DeobfuscateResult;

  beforeAll(async () => {
    source = LIGHT_FIXTURE.read();
    balanced = await deobfuscate(source);
    aggressive = await deobfuscate(source, { preset: 'aggressive' });
    summarise('lightly-obfuscated.js (balanced)', source, balanced);
    summarise('lightly-obfuscated.js (aggressive)', source, aggressive);
  }, FIXTURE_TIMEOUT);

  it('inlines every one of the 10 197 array reads at aggressive', () => {
    // Every access shape resolved, including the two scientific-notation sites
    // (`_0xdb56[1e3]`, `_0xdb56[2e3]`) that a `[0-9]+` scan silently skips.
    expect(count(source, /_0xdb56\s*\[/g)).toBe(10_197);
    expect(count(aggressive.code, /_0xdb56\s*\[/g)).toBe(0);
  });

  it('leaves all 10 197 of them encoded at balanced', () => {
    // Not "fewer": none. The read count is exactly the input's, because the
    // refusal is per string source and this file has one.
    expect(count(balanced.code, /_0xdb56\s*\[/g)).toBe(10_197);
    expect(balanced.metadata.strings).toHaveLength(0);
  });

  it('keeps the 2 239-entry array declaration at aggressive, and says why', () => {
    // Every read of it is a literal now (above), so the table is dead as far
    // as this file can see - and this file is not all there is: `Function(_)`
    // compiles a source nothing here can read, in the scope that resolves
    // `_0xdb56`. The declaration it may spell stays, and the note says which
    // line kept it and which option took the inlining.
    expect(aggressive.code).toContain('_0xdb56');
    expect(count(aggressive.code, ARRAY_DECLARATION)).toBe(1);
    const kept = aggressive.metadata.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === 'warning' &&
        diagnostic.message.startsWith(
          'Kept the string-array machinery although its call sites were inlined',
        ),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.message).toContain('`Function(...)` at line');
    expect(kept[0]!.message).toContain('stringDecoding.decodeDespiteStringCode');
  });

  it('keeps the declaration at balanced, and says which line cost it', () => {
    expect(balanced.code).toContain('_0xdb56');
    expect(count(balanced.code, ARRAY_DECLARATION)).toBe(1);
    const kept = balanced.metadata.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === 'warning' &&
        diagnostic.message.startsWith('Kept the string-array machinery'),
    );
    expect(kept.length).toBeGreaterThan(0);
    // A 45 KB table in the output with nothing naming the construct that caused
    // it is the version of this refusal nobody can act on.
    expect(kept[0]!.message).toContain('`Function(...)` at line');
  });

  it('produces output that re-parses cleanly at both presets', () => {
    for (const result of [balanced, aggressive]) {
      assertParses(result.code);
      expect(result.metadata.stats.verified).toBe(true);
    }
  });

  it('recovers the strings the program is actually about at aggressive', () => {
    const decoded = new Set(aggressive.metadata.strings.map((entry) => entry.value));
    for (const word of ['addEventListener', 'getElementById', 'jQuery', 'createElement']) {
      expect(decoded.has(word)).toBe(true);
    }
    // Present in the output too, whether still a literal or turned into the dot
    // access that a literal property key becomes downstream.
    for (const word of ['addEventListener', 'getElementById', 'jQuery']) {
      expect(aggressive.code).toContain(word);
    }
  });

  it('recovers none of them at balanced, and says so per source', () => {
    // Only the decoded-reference count can carry this. Those words are all IN
    // the balanced output - they are the table's own undecoded entries - so
    // searching the text would pass whatever the engine did.
    expect(balanced.metadata.strings).toHaveLength(0);
    expect(
      balanced.metadata.diagnostics.some((diagnostic) =>
        diagnostic.message.startsWith('Left every reference to _0xdb56 encoded'),
      ),
    ).toBe(true);
  });

  it('keeps the entry points the surrounding HTML calls, at both presets', () => {
    // Called from inline `onclick` handlers in the page, so they are live even
    // though nothing inside this file references them. Program scope is frozen
    // against renaming by the same `Function(_)` at both presets, which is a
    // different guard from the one this file is about and is not gated by it.
    for (const result of [balanced, aggressive]) {
      for (const global of [
        'setserver',
        'connectDefault',
        'showSkin',
        'hotkeySelect',
        'hotkeyClear',
        'insertPMText',
        'openSettingPage',
        'aipDisplayTag',
        'setResponsiveMenu',
      ]) {
        expect(result.code).toContain(global);
      }
    }
  });

  it('fingerprints the string array without inventing the rest', () => {
    // Detection reads the input, so the preset must not change it.
    for (const result of [balanced, aggressive]) {
      const kinds = result.metadata.detections.map((detection) => detection.kind);
      expect(kinds).toContain('string-array');
      // Nothing here rotates or encodes. Claiming otherwise would be a false
      // positive in a list the user reads.
      expect(kinds).not.toContain('string-array-rotate');
      expect(kinds).not.toContain('string-encoding-rc4');
    }
  });
});

// ---------------------------------------------------------------------------
// obfuscated2.js - real obfuscator.io: RC4 over base64, rotation, splitStrings
// ---------------------------------------------------------------------------

/** `_0x123b(0x2bd3, '\x40\x6d\x38\x77')` and every alias spelling of it. */
const DECODER_CALL = /_0x[0-9a-f]{4,6}\(0x[0-9a-f]+, *['"]\\x/g;

describe.skipIf(!HEAVY_FIXTURE.present)('obfuscated2.js', () => {
  let source: string;
  let result: DeobfuscateResult;

  beforeAll(async () => {
    source = HEAVY_FIXTURE.read();
    result = await deobfuscate(source);
    summarise('obfuscated2.js', source, result);
    console.log(
      `  call sites      ${count(source, DECODER_CALL)} -> ${count(result.code, DECODER_CALL)}`,
    );
  }, FIXTURE_TIMEOUT);

  it('resolves essentially every one of the 35 789 decoder call sites', () => {
    const before = count(source, DECODER_CALL);
    expect(before).toBeGreaterThan(35_000);
    expect(count(result.code, DECODER_CALL)).toBeLessThan(before * 0.01);
  });

  it('produces output that re-parses cleanly', () => {
    assertParses(result.code);
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('reassembles the four-character splitStrings fragments into real words', () => {
    // None of these is in the string array: it holds `"cons"`, `"truc"`, `"tor"`.
    // They exist only once the decoded `+` chains have been folded.
    for (const word of [
      'addEventListener',
      'getElementById',
      'className',
      'constructor',
      'localStorage',
      'appendChild',
      'font-size',
    ]) {
      expect(result.code).toContain(word);
    }
  });

  it('deletes the 1 MB string array, the decoder and the rotation wrapper', () => {
    expect(result.code).not.toContain('_0x4a68');
    expect(result.code).not.toContain('_0x123b');
    expect(result.metadata.stats.outputBytes).toBeLessThan(source.length / 3);
  });

  it('fingerprints the rotation, the wrapper, the RC4 layer and the split strings', () => {
    const kinds = new Set(result.metadata.detections.map((detection) => detection.kind));
    for (const kind of [
      'string-array',
      'string-array-rotate',
      'string-array-wrapper',
      'string-encoding-rc4',
      'string-encoding-base64',
      'split-strings',
    ]) {
      expect([...kinds]).toContain(kind);
    }
  });
});
