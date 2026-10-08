import { describe, expect, it } from 'vitest';
import { deobfuscate, listPasses } from '../src/index.js';
import {
  normalizeLiteralsPass,
  renormalizeLiteralsPass,
} from '../src/passes/prepare/normalize-literals.js';
import { assertParses, expectEquivalent, expectIdempotent, runPass } from './helpers.js';

/**
 * `strings.normalize-literals` exists because the engine was not its own
 * fixpoint.
 *
 * `prepare` runs once, in the kernel's prologue, and it runs *before* `unpack`.
 * Anything a packer was holding therefore enters the tree past the only pass
 * that would have normalised it, and `unpack.function-constructor` re-parses a
 * source string, so every literal in the subtree it grafts in keeps the
 * `extra.raw` the parser gave it. The generator echoes a raw verbatim, so those
 * escapes travelled untouched to the output - and a second run over that output
 * removed them, because by then they were in the *file* and `prepare` did see
 * them.
 *
 * Measured on `obfuscated4.js` (one `Function(name, "<3.5 MB body>")` call, the
 * payload holding 85 verbose-escaped literals, the largest 858,878 raw
 * characters): first run 4,204,050 chars, second run 3,084,259, third run
 * unchanged. The whole 1,119,791-character difference was
 * `prepare.normalize-literals` reporting 84 changes on a run it should never
 * have had to make.
 *
 * These tests pin the mechanism rather than the fixture: a wrapper `prepare`
 * cannot see through, a normalisation that must still happen, and - because a
 * pass inside the fixpoint loop that reports a change every round would spin the
 * loop forever - a convergence proof.
 */

/** `Function("", body)()`, the shape `prepare` cannot see into. */
function packed(body: string): string {
  return `Function("", ${JSON.stringify(body)})();`;
}

const balanced = { preset: 'balanced' } as const;

describe('strings.normalize-literals: literals revealed by unpacking', () => {
  it('normalises escapes inside a Function-constructor payload', async () => {
    const source = packed(String.raw`var s = '\x66\x6f\x6f'; return s;`);
    const { code } = await deobfuscate(source, balanced);
    expect(code).toContain("'foo'");
    expect(code).not.toContain('\\x66');
    assertParses(code);
  });

  it('is the pass that does it - the run is unchanged when it is disabled', async () => {
    const source = packed(String.raw`var s = '\x66\x6f\x6f'; return s;`);
    const { code } = await deobfuscate(source, {
      ...balanced,
      disablePasses: ['strings.normalize-literals'],
    });
    // The escape survives to the output: this is the defect, reproduced.
    expect(code).toContain('\\x66');
  });

  it('rewrites a payload template literal early enough for a recogniser to match it', async () => {
    // `clean.anti-tamper` matches the self-defending trap on a `StringLiteral`
    // node, so the guard spelled in backticks - which is what Cloudflare's
    // post-pass does to every string in a program - is invisible to it until
    // this pass has run. Normalising after the fixpoint loop would print the
    // trap more prettily and leave it in the output.
    const source = packed(
      [
        'function guard() {',
        '  var re = new RegExp(`(((.+)+)+)+$`);',
        '  if (re.test(`aaaaaaaaaaaaaaaaaaaaaaaaaaaa!`)) { return true; }',
        '  return false;',
        '}',
        'guard();',
        'return 1;',
      ].join('\n'),
    );
    const { code, metadata } = await deobfuscate(source, balanced);
    expect(code).not.toContain('(((.+)+)+)+$');
    expect(metadata.passes.find((p) => p.id === 'clean.anti-tamper')?.changes ?? 0).toBeGreaterThan(
      0,
    );
    assertParses(code);

    // The other half: with the re-normalisation gone the trap is invisible to
    // `clean.anti-tamper` and reaches the output intact. This is what moving
    // the pass to an epilogue stage would do - prettier, and still armed.
    const withoutPass = await deobfuscate(source, {
      ...balanced,
      disablePasses: ['strings.normalize-literals'],
    });
    expect(withoutPass.code).toContain('(((.+)+)+)+$');
    expect(
      withoutPass.metadata.passes.find((p) => p.id === 'clean.anti-tamper')?.changes ?? 0,
    ).toBe(0);
  });

  it('leaves the escape census to the prepare registration', async () => {
    // `prepare.normalize-literals` strips the raws that are the evidence for
    // `unicode-escapes`, and hands `prepare.detect` a census instead. A second
    // registration that also wrote the census would overwrite those input
    // numbers with a measurement of a half-deobfuscated tree.
    const literals = Array.from(
      { length: 12 },
      (_, i) => String.raw`var v${i} = '\x61\x62\x63';`,
    ).join('\n');
    const { metadata } = await deobfuscate(literals, balanced);
    expect(metadata.detections.map((d) => d.kind)).toContain('unicode-escapes');
  });
});

describe('strings.normalize-literals: convergence', () => {
  it('reports no change on a second run over its own output', async () => {
    // The failure this guards against is `prepare.fold-numbers`' old bug: a
    // rewrite whose output re-parses into the very shape the pass matches, so
    // it reports a change on every fixpoint round and the loop only ever stops
    // on the iteration budget.
    const source = packed(
      [
        String.raw`var a = '\x66\x6f\x6f';`,
        String.raw`var b = 'bar';`,
        String.raw`var c = '\146\157\157';`,
        'var d = `plain`;',
        'var e = 0x1f;',
        'var f = 1_000_000;',
        'return [a, b, c, d, e, f];',
      ].join('\n'),
    );

    const first = await deobfuscate(source, balanced);
    const second = await deobfuscate(first.code, balanced);

    expect(second.metadata.stats.totalChanges).toBe(0);
    expect(second.code).toBe(first.code);
    assertParses(first.code);
  });

  it('does not spin the fixpoint loop', async () => {
    // A pass that reported a change every round would drive `iterations` to
    // `maxIterations` (6 at every preset) and set nothing else apart from it.
    const source = packed(String.raw`var s = '\x66\x6f\x6f'; return s;`);
    const { metadata } = await deobfuscate(source, balanced);
    expect(metadata.stats.iterations).toBeLessThan(6);
    expect(metadata.stats.truncated).toBe(false);
  });

  it('is idempotent in isolation', async () => {
    await expectIdempotent(
      renormalizeLiteralsPass,
      [
        String.raw`var a = '\x66\x6f\x6f';`,
        'var b = `plain`;',
        'var c = 0x1f;',
        String.raw`var d = 'a\nb\tc';`,
      ].join('\n'),
    );
  });

  it('reports no change on a tree the prepare registration already normalised', async () => {
    const source = String.raw`var a = '\x66\x6f\x6f'; var b = ` + '`plain`;';
    const once = await runPass(normalizeLiteralsPass, source);
    expect(once.changes).toBe(2);
    const twice = await runPass(renormalizeLiteralsPass, once.code);
    expect(twice.changes).toBe(0);
  });
});

describe('strings.normalize-literals: registration', () => {
  it('shares the prepare pass behaviour, so both spellings normalise alike', async () => {
    const source = [
      String.raw`var a = '\x66\x6f\x6f';`,
      'var b = `plain`;',
      'var c = 0x1f;',
    ].join('\n');
    const viaPrepare = await runPass(normalizeLiteralsPass, source);
    const viaLoop = await runPass(renormalizeLiteralsPass, source);
    expectEquivalent(viaLoop.code, viaPrepare.code);
    expect(viaLoop.changes).toBe(viaPrepare.changes);
  });

  it('sits in the strings stage, ahead of the passes that read the tree', async () => {
    const ids = listPasses();
    const index = ids.findIndex((p) => p.id === 'strings.normalize-literals');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(ids[index]?.stage).toBe('strings');
    // `strings.discover` is a `run` pass, which the kernel executes after the
    // stage's merged visitor traversal - but the three `run` passes read the
    // tree in registration order, and being first is what makes the ordering
    // legible rather than incidental.
    expect(index).toBeLessThan(ids.findIndex((p) => p.id === 'strings.discover'));
  });

  it('is disabled together with the prepare registration it mirrors', async () => {
    // One toggle, one behaviour: a caller who asked to keep their raws must not
    // get them stripped by the second registration.
    const source = packed(String.raw`var s = '\x66\x6f\x6f'; return s;`);
    const { code } = await deobfuscate(source, {
      ...balanced,
      disablePasses: ['prepare.normalize-literals'],
    });
    expect(code).toContain('\\x66');
  });
});
