import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config/presets.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult, PresetName } from '../src/types.js';

/**
 * The one refusal in the string stage that a preset is allowed to overrule, the
 * proof that exactly one preset overrules it, and the half of it no preset may.
 *
 * The refusal is not re-argued here. A table is only a constant if nothing can
 * rewrite it, and code compiled from a string at run time is in no tree - so no
 * reference count and no constant-violation list can see it read the table,
 * write it, or call the decoder by name. What this file is about is who pays
 * for that, and for which half.
 *
 * `StringDecodingOptions.decodeDespiteStringCode` is where that decision lives,
 * and it buys exactly one thing: the sites the tree holds are INLINED although
 * a string could be writing the table underneath them - a stale literal, and a
 * disclosed one. It does not buy the deletion of the machinery. A deleted
 * declaration that a string still spells is a `ReferenceError` where the input
 * ran, and that is not drift: `eval('var t = o; String[t(137)]
 * = ...')` beside a decoder `o`, the sites inlined, `o` deleted, and the eval
 * threw on its first statement. So the machinery stays at every preset whenever
 * a string can reach it, and the price of the option is bounded to the drift
 * the doctrine above `PRESET_TECHNIQUES` accepts.
 *
 * Both halves are pinned below because only one is loud. If the option stopped
 * reaching `aggressive`, `test/fixtures.test.ts` would fail on the inlined read
 * count the same afternoon. If it leaked into `conservative` or `balanced`,
 * nothing would fail: the output would parse, re-read beautifully, and compute
 * something else. And if the deletion ever came back under the option, the
 * executed assertions below would throw where they now print.
 *
 * So every behavioural claim here is executed in a fresh realm rather than
 * asserted structurally - including the aggressive ones, which execute the
 * drift the preset accepts instead of describing it.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Execute in a fresh realm; the *kind* of failure is part of the trace. */
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log, console: { log } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join(' | ');
}

/** The string-stage messages a reader of the report would see. */
function notes(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics
    .filter((diagnostic) => diagnostic.source.startsWith('strings.'))
    .map((diagnostic) => diagnostic.message);
}

/** The two presets whose contract is that they never take this trade. */
const REFUSING: readonly PresetName[] = ['conservative', 'balanced'];
const ALL: readonly PresetName[] = ['conservative', 'balanced', 'aggressive'];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A table, a decoder, one construct that compiles a string, and two reads.
 *
 * The reads sit AFTER the string code deliberately: what makes an inlined value
 * wrong is a write that happens first, and a program whose write came afterwards
 * would agree with the wrong output by luck rather than by correctness.
 */
const table = (stringCode: string): string => `
  var A = ['alpha', 'beta', 'gamma'];
  function dec(i) { return A[i]; }
  ${stringCode}
  log(dec(0));
  log(dec(1));
`;

/**
 * `fixtures/lightly-obfuscated.js`'s shape, reduced: the argument to `Function`
 * is a name, so the source cannot be read, so nothing bounds which program-scope
 * name the compiled code touches. This one writes the table.
 */
const UNREADABLE = table(`
  function boot(s) { Function(s)(); }
  boot('A[0] = "MUT"');
`);

/**
 * The same, but the injected code checks before it writes.
 *
 * This is the version worth having: with the table deleted the compiled source
 * does not throw, it simply does nothing, and the program carries on and prints
 * a different answer. A refusal that only prevented crashes would be much
 * easier to argue away than one that prevents this.
 */
const SILENT = table(`
  function boot(s) { Function(s)(); }
  boot('if (typeof A !== "undefined") { A[0] = "MUT"; }');
`);

/** The lexical half of the same hazard: a direct eval sees its whole chain. */
const DIRECT_EVAL = table(`
  function m(s) { eval(s); }
  m('A[0] = "MUT"');
`);

/**
 * The control that stops the option being read as "aggressive decodes more
 * tables". This source is readable and spells nothing, so it exposes nothing,
 * and the machinery goes at every preset with the option playing no part.
 */
const SPELLS_NOTHING = table(`Function('return this')();`);

/**
 * The other control: a global compile sees the global environment, and a binding
 * inside an IIFE is not in it, however unreadable the source is.
 */
const INSIDE_IIFE = `
  var out = [];
  (function () {
    var A = ['alpha', 'beta', 'gamma'];
    function dec(i) { return A[i]; }
    out.push(dec(0), dec(2));
  })();
  function boot(s) { Function(s)(); }
  boot('void 0');
  log(out.join(','));
`;

// ---------------------------------------------------------------------------
// The preset table
// ---------------------------------------------------------------------------

describe('stringDecoding.decodeDespiteStringCode: the preset table', () => {
  it('is off at conservative and balanced and on at aggressive', () => {
    // Which presets this reaches is the entire decision, so it is asserted here
    // rather than left to whoever next reads the table. The reasoning is beside
    // the aggressive entry in src/config/presets.ts; the risk is on the option
    // in src/types.ts.
    for (const preset of REFUSING) {
      expect(resolveConfig({ preset }).techniqueOptions.stringDecoding.decodeDespiteStringCode).toBe(
        false,
      );
    }
    expect(
      resolveConfig({ preset: 'aggressive' }).techniqueOptions.stringDecoding
        .decodeDespiteStringCode,
    ).toBe(true);
  });

  it('is the option that decides, not the preset name', async () => {
    // Both directions. A gate that read the preset instead of the option would
    // satisfy the table above and still be wrong for a caller who set it.
    const off = await deobfuscate(UNREADABLE, {
      preset: 'aggressive',
      techniques: { stringDecoding: { decodeDespiteStringCode: false } },
    });
    expect(off.code).toContain('dec(0)');
    expect(execute(off.code)).toBe(execute(UNREADABLE));

    const on = await deobfuscate(UNREADABLE, {
      preset: 'balanced',
      techniques: { stringDecoding: { decodeDespiteStringCode: true } },
    });
    expect(on.code).not.toContain('dec(0)');
    expect(on.code).toContain("log('alpha')");
    // And what the option does not reach, at either preset: the declarations.
    expect(on.code).toContain('function dec');
  });
});

// ---------------------------------------------------------------------------
// The refusing presets
// ---------------------------------------------------------------------------

describe('conservative and balanced: the refusal stands', () => {
  for (const [name, source] of [
    ['a source the analysis cannot read', UNREADABLE],
    ['a source that checks before it writes', SILENT],
    ['a direct eval that can write the table', DIRECT_EVAL],
  ] as const) {
    it(`keeps the machinery and the encoded reads: ${name}`, async () => {
      for (const preset of REFUSING) {
        const result = await deobfuscate(source, { preset });
        // The executed comparison is the assertion that matters: each of these,
        // rewritten, produces a program that parses and runs.
        expect(execute(result.code)).toBe(execute(source));
        expect(result.code).toContain('function dec');
        expect(result.code).toContain('dec(0)');
        expect(result.metadata.strings).toHaveLength(0);
        expect(notes(result).some((message) => message.startsWith('Kept the string-array'))).toBe(
          true,
        );
        expect(
          notes(result).some((message) => message.startsWith('Left every reference to dec encoded')),
        ).toBe(true);
      }
    });
  }

  it('keeps a decoder a readable source names, at conservative', async () => {
    // The hazard is not only "the source cannot be read". Here it can, and what
    // it says is the decoder's own name, which is the strongest form of the
    // question `addresses` asks.
    //
    // Conservative only, and for a reason worth knowing rather than working
    // around: at the other two presets `moduleUnwrapping` opens this
    // `Function('...')` into an ordinary IIFE first. That is sound - the string
    // already IS the source - and once it is in the tree there is no string code
    // left to refuse for, so the table is decoded through the front door.
    const source = `
      var A = ['alpha', 'beta', 'gamma'];
      function dec(i) { return A[i]; }
      log(dec(0));
      log(Function('return dec(2)')());
    `;
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(execute(result.code)).toBe(execute(source));
    expect(result.code).toContain('function dec');
    expect(result.metadata.strings).toHaveLength(0);
    expect(notes(result).some((message) => message.startsWith('Kept the string-array'))).toBe(true);
  });

  it('names the construct that cost the file its table', async () => {
    // A whole table left in the output with nothing saying why is the version of
    // this refusal that costs the reader an afternoon.
    const result = await deobfuscate(UNREADABLE, { preset: 'balanced' });
    expect(notes(result).some((message) => message.includes('`Function(...)` at line'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The preset that takes the trade
// ---------------------------------------------------------------------------

describe('aggressive: the trade, and what it costs', () => {
  it('inlines the reads and keeps the machinery a string can still name', async () => {
    const result = await deobfuscate(UNREADABLE, { preset: 'aggressive' });
    expect(result.code).toContain("log('alpha')");
    expect(result.code).not.toContain('dec(0)');
    expect(result.metadata.strings.length).toBeGreaterThan(0);
    expect(result.metadata.stats.verified).toBe(true);
    // The table and the decoder are still declared: the compiled source may
    // spell either, and a spelled name has to resolve to something.
    expect(result.code).toContain('function dec');
    expect(result.code).toContain("['alpha'");
  });

  it('computes a different answer where the string code rewrites the table', async () => {
    // The price, executed rather than described: the input prints what the
    // compiled source wrote, the output prints what the table held when the
    // engine read it, and nothing at run time complains. This is the drift the
    // aggressive arm of the doctrine above `PRESET_TECHNIQUES` accepts - and
    // pinning it here means a later claim that this path is safe fails a test
    // instead of shipping.
    const result = await deobfuscate(SILENT, { preset: 'aggressive' });
    expect(execute(SILENT)).toBe('MUT | beta');
    expect(execute(result.code)).toBe('alpha | beta');
  });

  it('does not throw where the table is addressed unconditionally', async () => {
    // The half of the cost the option no longer carries. The compiled source
    // names `A`, and with `A` deleted the program that used to print two
    // lines printed `THROWN ReferenceError` instead - pinned here as the cost
    // until this round. Now the write lands on a table nothing reads any
    // more, and the output prints the stale literals; that is the drift
    // above, and all of it.
    const result = await deobfuscate(UNREADABLE, { preset: 'aggressive' });
    expect(execute(UNREADABLE)).toBe('MUT | beta');
    expect(execute(result.code)).toBe('alpha | beta');
  });

  it('keeps a decoder a readable string spells, and the string still runs', async () => {
    // The direct eval spells the decoder by name and
    // calls it. Inlining the tree's own sites is the trade; deleting `dec`
    // underneath the eval is a ReferenceError on its first statement, which
    // is what the aggressive output used to do here. The input's own trace
    // is the oracle, and it is the same trace at every preset.
    const source = `
      var A = ['alpha', 'beta', 'gamma'];
      function dec(i) { return A[i]; }
      eval('var d = dec; log(d(2))');
      log(dec(0));
      log(dec(1));
    `;
    expect(execute(source)).toBe('gamma | alpha | beta');
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset });
      expect(execute(result.code)).toBe('gamma | alpha | beta');
      expect(result.code).toContain('function dec');
    }
    const aggressive = await deobfuscate(source, { preset: 'aggressive' });
    expect(aggressive.code).toContain("log('alpha')");
    expect(
      notes(aggressive).some((message) =>
        message.startsWith('Kept the string-array machinery although its call sites were inlined'),
      ),
    ).toBe(true);
  });

  it('says in the report that it did it, how to switch it off, and what it kept', async () => {
    // Silence would be the real defect here: an unprovable rewrite made on
    // purpose has to be visible to whoever reads the diagnostics, and it has to
    // be a warning, because that is the severity a reader scans for. One line
    // per decision for the whole run, not one per fixpoint round: the second
    // round meets the same table and has nothing new to say about it.
    const result = await deobfuscate(UNREADABLE, { preset: 'aggressive' });
    const strings = result.metadata.diagnostics.filter((d) => d.source.startsWith('strings.'));
    const taken = strings.filter((d) => d.message.includes('decodeDespiteStringCode'));

    expect(taken.map((d) => d.source).sort()).toEqual(['strings.inline', 'strings.prune-decoders']);
    for (const diagnostic of taken) expect(diagnostic.severity).toBe('warning');
    const inlined = taken.find((d) => d.source === 'strings.inline')!;
    expect(inlined.message.startsWith('Inlined every reference to dec anyway')).toBe(true);
    expect(inlined.message).toContain('stringDecoding.decodeDespiteStringCode to false');
    // The prune pass says the opposite thing for the opposite reason: the
    // machinery it would have deleted is still in the file, and the option is
    // named so a reader does not go looking for a second switch.
    const kept = taken.find((d) => d.source === 'strings.prune-decoders')!;
    expect(
      kept.message.startsWith('Kept the string-array machinery although its call sites were inlined'),
    ).toBe(true);
    expect(kept.message).toContain('`Function(...)` at line');
    // And the plain refusal's note is not also emitted; one run says one thing.
    expect(notes(result).some((message) => message.startsWith('Kept the string-array machinery:'))).toBe(false);
    expect(notes(result).some((message) => message.startsWith('Deleting the string-array'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

describe('controls: what the option does not touch', () => {
  it('decodes a table no string code can name, at every preset', async () => {
    // `addresses` is a name test, not a "some string code exists" test. If this
    // ever answered to the option, the option would have become a switch that
    // turns the string stage off at two presets out of three.
    for (const preset of ALL) {
      const result = await deobfuscate(SPELLS_NOTHING, { preset });
      expect(result.code).toContain("log('alpha')");
      expect(execute(result.code)).toBe(execute(SPELLS_NOTHING));
      expect(notes(result).some((message) => message.startsWith('Kept the string-array'))).toBe(
        false,
      );
    }
  });

  it('decodes machinery a global compile cannot reach, at every preset', async () => {
    for (const preset of ALL) {
      const result = await deobfuscate(INSIDE_IIFE, { preset });
      expect(result.code).not.toContain('dec(0)');
      expect(result.code).toContain("'alpha'");
      expect(execute(result.code)).toBe(execute(INSIDE_IIFE));
    }
  });
});
