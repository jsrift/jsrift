import { createContext, runInContext } from 'node:vm';
import * as t from '@babel/types';
import { beforeAll, describe, expect, it } from 'vitest';

import { isSumReducer, looksLikeRegisterVm } from '../src/analysis/dispatcher.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { unflattenRegisterVmPass } from '../src/passes/structure/register-vm.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, expectIdempotent, expectNoChange, normalize, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

/** The sum reducer every one of these machines dispatches through. */
const REDUCER =
  'function sum(a) { for (var s = 0, i = 0; i < a.length; i++) { s += a[i]; } return s; }';

/**
 * A minimal register VM: three blocks, labels both literal and register-relative,
 * every guard decidable, entered once from a literal vector.
 *
 * Traced from `[1, 0, 0]`: sum 1 picks the literal `case 1`, which moves the sum
 * to 3; `case r[1] + 3` then evaluates to 3 and moves it to 6; `case 6` returns.
 */
const RETURNING = `${REDUCER}
function vm(r) {
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        first();
        r[0] += 2;
        break;
      case r[1] + 3:
        second();
        r[0] += 3;
        break;
      case 6:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;

/** The same machine, reaching the halt sum instead of returning. */
const HALTING = `${REDUCER}
function vm(r) {
  while (sum(r) !== 6) {
    switch (sum(r)) {
      case 1:
        first();
        r[0] += 2;
        break;
      case r[1] + 3:
        second();
        r[0] += 3;
        break;
    }
  }
  done();
}
out = vm([1, 0, 0]);`;

/**
 * A variant of `RETURNING`, refusing to build one whose edit did not land.
 *
 * Every refusal below is asserted as "no change", which is also what a fixture
 * that silently failed to mutate would produce.
 */
function variant(from: string, to: string, source = RETURNING): string {
  if (!source.includes(from)) throw new Error(`fixture edit did not apply: ${from}`);
  return source.replace(from, to);
}

const RECOVER: DeobfuscateOptions = {
  techniques: { controlFlowAnalysis: { registerVm: true } },
};

/**
 * A preset with recovery switched off - which is all three - named explicitly
 * rather than left to the `aggressive` default in `test/helpers.ts`.
 */
const LEAVE_STANDING: DeobfuscateOptions = { preset: 'balanced' };

async function recover(source: string, options: DeobfuscateOptions = RECOVER) {
  return runPass(unflattenRegisterVmPass, source, options);
}

/** The single loop in a snippet, for the recognisers that take a bare node. */
function loopOf(source: string): t.Node {
  const { ast } = parseSource(source);
  let found: t.Node | undefined;
  t.traverseFast(ast, (node) => {
    if (!found && (t.isWhileStatement(node) || t.isForStatement(node))) found = node;
  });
  if (!found) throw new Error('no loop in snippet');
  return found;
}

/**
 * Run a fixture and record what it did.
 *
 * Textual comparison proves the pass emitted what was intended; this proves the
 * intention was right. A linearisation that picks the wrong successor produces
 * code that parses and runs, so the only test that can catch it is one that
 * runs both versions and compares.
 */
function observe(code: string, flag = false): { calls: string[]; out: unknown } {
  const calls: string[] = [];
  const context = createContext({
    first: () => calls.push('first'),
    second: () => calls.push('second'),
    third: () => {
      calls.push('third');
      return 'returned';
    },
    // Only reachable from a call site the machine's binding does not list, which
    // is what makes the Annex B fixtures observable rather than merely refused.
    fourth: () => {
      calls.push('fourth');
      return 'fourth';
    },
    done: () => calls.push('done'),
    // Only ever read by a fixture's guard, which is what makes that guard
    // undecidable to the pass and decidable to this runner.
    flag,
    out: undefined,
  });
  runInContext(code, context, { timeout: 2_000 });
  return { calls, out: (context as { out: unknown }).out };
}

/** Both sides of an undecidable guard, since either may be the one that is wrong. */
function observeBothWays(code: string): Array<{ calls: string[]; out: unknown }> {
  return [observe(code, true), observe(code, false)];
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

describe('analysis.dispatcher: register-VM recognition', () => {
  it('matches a sum-keyed loop', () => {
    expect(looksLikeRegisterVm(loopOf('while (sum(r) !== -177) { switch (sum(r)) { case 1: a(); } }'))).toBe(true);
  });

  it('does not match the obfuscator.io order-array dispatcher', () => {
    // The two machines share a syntax and nothing else, and running the order
    // array analysis over this one is how a register VM stays invisible.
    expect(
      looksLikeRegisterVm(
        loopOf("while (true) { switch (order[i++]) { case '0': a(); continue; } break; }"),
      ),
    ).toBe(false);
  });

  it('does not match when the loop test and the dispatch disagree', () => {
    expect(looksLikeRegisterVm(loopOf('while (sum(r) !== 1) { switch (sum(q)) { case 1: a(); } }'))).toBe(false);
    expect(looksLikeRegisterVm(loopOf('while (key(r) !== 1) { switch (sum(r)) { case 1: a(); } }'))).toBe(false);
  });

  it('does not match a loop that exits through a trailing break', () => {
    expect(
      looksLikeRegisterVm(loopOf('while (sum(r) !== 1) { switch (sum(r)) { case 1: a(); } break; }')),
    ).toBe(false);
  });

  it('recognises the sum reducer, and only the sum reducer', () => {
    const reducer = (source: string): t.Function => {
      const { ast } = parseSource(source);
      let found: t.Function | undefined;
      t.traverseFast(ast, (node) => {
        if (!found && t.isFunctionDeclaration(node)) found = node;
      });
      if (!found) throw new Error('no function in snippet');
      return found;
    };

    expect(isSumReducer(reducer(REDUCER))).toBe(true);
    expect(
      isSumReducer(
        reducer('function sum(a) { for (var s = 0, i = 0; i < a.length; i++) { s += a[i] * 2; } return s; }'),
      ),
    ).toBe(false);
    expect(
      isSumReducer(
        reducer('function sum(a) { for (var s = 1, i = 0; i < a.length; i++) { s += a[i]; } return s; }'),
      ),
    ).toBe(false);
    expect(isSumReducer(reducer('function sum(a) { return a.length; }'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Honest reporting
// ---------------------------------------------------------------------------

describe('structure.control-flow: register-VM reporting', () => {
  it('names the machine it leaves standing, once', async () => {
    // Two runs share one context, which is how the fixpoint loop sees it.
    const { ctx, changes } = await runPass(
      [unflattenControlFlowPass, unflattenControlFlowPass],
      RETURNING,
      LEAVE_STANDING,
    );
    expect(changes).toBe(0);

    const detections = ctx.detections.filter(
      (d) => d.evidence === 'register-VM dispatcher (not recovered)',
    );
    expect(detections).toHaveLength(1);
    expect(detections[0]?.kind).toBe('control-flow-flattening');
    expect(detections[0]?.confidence).toBe(0.9);
    expect(detections[0]?.count).toBe(1);

    const notes = ctx.diagnostics.filter((d) => d.source === 'structure.control-flow');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.severity).toBe('warning');
    expect(notes[0]?.message).toContain('sum over sum(r)');
    // Recovery is off in every preset, so nothing was attempted and no gate has
    // an opinion: naming the entry vector here would describe a step that never
    // ran.
    expect(notes[0]?.message).toContain('switched off');
    expect(notes[0]?.message).not.toContain('entry vector');
    expect(notes[0]?.loc).toBeDefined();
  });

  it('names the gate that actually refused, not the entry vector', async () => {
    /** The one note `structure.control-flow` leaves on a snippet. */
    const noteFor = async (source: string): Promise<string> => {
      const { ctx, changes } = await runPass(unflattenControlFlowPass, source, RECOVER);
      expect(changes).toBe(0);
      const notes = ctx.diagnostics.filter((d) => d.source === 'structure.control-flow');
      expect(notes).toHaveLength(1);
      return notes[0]?.message ?? '';
    };

    // A computed index is checked several gates before any call site is read,
    // so the entry vector here is concrete and simply never consulted. That
    // gate order is the point: on obfuscated4.js none of the 29 machines left
    // standing is refused for its index at all, and reporting the vector for
    // them would have been reporting a step that never ran.
    const computed = await noteFor(variant('r[0] += 2;', 'r[k] = 2;'));
    expect(computed).toContain('indexed by something other than');
    expect(computed).not.toContain('entry vector');

    // And when the entry vector really is the objection, it is still named.
    expect(await noteFor(variant('vm([1, 0, 0])', 'vm(vector)'))).toContain(
      'entry vector could not be resolved',
    );

    // Each gate speaks for itself rather than borrowing the last one's line.
    expect(await noteFor(variant('while (sum(r) !== 9) {', 'for (r[0] += 10; sum(r) !== 9; ) {')))
      .toContain('`for` head');
    expect(await noteFor(variant('first();', 'arguments[0][1] = 5;'))).toContain('`arguments`');
  });

  it('says nothing about a machine the recovery pass has already linearised', async () => {
    // In the shipped order (see `passes/registry.ts`, "Recovery before
    // reporting") `structure.register-vm` runs *first*, so the loop is gone
    // before this pass walks the tree and there is nothing to name. Reporting a
    // refusal for a machine that is recovered is how it ends up looking, in the
    // report, like one that was given up on.
    //
    // Both passes, in this order, deliberately. Handed only
    // `structure.control-flow`, this would pass for the wrong reason: a
    // reporting path that stays quiet whenever no gate objected is silent here
    // too.
    const { ctx } = await runPass(
      [unflattenRegisterVmPass, unflattenControlFlowPass],
      RETURNING,
      RECOVER,
    );
    expect(ctx.diagnostics.filter((d) => d.source === 'structure.control-flow')).toHaveLength(0);
    expect(ctx.detections.filter((d) => d.evidence.includes('not recovered'))).toHaveLength(0);
    expect(ctx.detections.some((d) => d.evidence.startsWith('register VM over'))).toBe(true);
  });

  it('names a machine the recovery pass never reached, rather than staying quiet', async () => {
    // `structure.register-vm` disabled by name with recovery still switched on:
    // every gate is happy and the loop is still standing, which is the case a
    // quiet early return swallows.
    const { ctx } = await runPass(
      [unflattenRegisterVmPass, unflattenControlFlowPass],
      RETURNING,
      { ...RECOVER, disablePasses: ['structure.register-vm'] },
    );
    const notes = ctx.diagnostics.filter((d) => d.source === 'structure.control-flow');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain('never reached it');
    expect(ctx.detections.filter((d) => d.evidence.includes('not recovered'))).toHaveLength(1);
  });

  it('never runs the order-array analysis over a register VM', async () => {
    const { ctx } = await runPass(unflattenControlFlowPass, RETURNING);
    expect(
      ctx.detections.filter((d) => d.evidence === 'switch dispatcher (not recovered)'),
    ).toHaveLength(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('switch dispatcher'))).toBe(false);
  });

  it('says nothing when the key function is not a sum reducer', async () => {
    // Recognition is what earns the 0.9; without it there is nothing to name.
    const source = variant(REDUCER, 'function sum(a) { return a.length; }');
    const { ctx } = await runPass(unflattenControlFlowPass, source);
    expect(ctx.detections.filter((d) => d.kind === 'control-flow-flattening')).toHaveLength(0);
  });

  it('withdraws the refusal once the register-VM pass recovers the same loop', async () => {
    // Reporting pass first, recovery pass second. That is not the order inside
    // one `structure` run - it is the order across a *round boundary* of the
    // stage, which repeats: this pass reports on round N and the recovery pass
    // gets its next turn on round N+1. It is the only sequence in which a
    // withdrawal can happen at all, which is why the withdrawal is pinned here
    // rather than on the within-round order, where there is nothing to take
    // back. Measured with recovery forced on over obfuscated4.js, the real
    // pipeline reaches it 0 times: `withdrawRefusal` is called 38 times and
    // finds nothing, because round 1 already recovers everything recoverable.
    // Reporting pass on its own: there *is* a refusal to withdraw. Without this
    // half, the assertion below passes on a run that never recorded one.
    const reportedAlone = await runPass(unflattenControlFlowPass, RETURNING, RECOVER);
    expect(
      reportedAlone.ctx.detections.filter((d) => d.evidence.includes('not recovered')),
    ).toHaveLength(1);

    const { ctx } = await runPass(
      [unflattenControlFlowPass, unflattenRegisterVmPass],
      RETURNING,
      RECOVER,
    );
    expect(ctx.detections.filter((d) => d.evidence.includes('not recovered'))).toHaveLength(0);
    expect(ctx.diagnostics.filter((d) => d.source === 'structure.control-flow')).toHaveLength(0);
    expect(ctx.detections.some((d) => d.evidence.startsWith('register VM over'))).toBe(true);
  });

  it('still reports the refusal while recovery is switched off', async () => {
    // Shipped order. With `registerVm` off the recovery pass returns without
    // looking at anything, so the refusal this pass records is the last word.
    const { ctx, changes } = await runPass(
      [unflattenRegisterVmPass, unflattenControlFlowPass],
      RETURNING,
      LEAVE_STANDING,
    );
    expect(changes).toBe(0);
    expect(
      ctx.detections.filter((d) => d.evidence === 'register-VM dispatcher (not recovered)'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

describe('structure.register-vm: recovery', () => {
  it('is off in every preset and only runs when asked for by name', async () => {
    // Which presets this is on is a claim the pass header makes about itself, so
    // it is asserted here rather than left to whoever next reads the table.
    //
    // No preset enables it. The three demonstrated wrong traces - a write made
    // through `delete`, a destructuring target or a for-in/of head; a direct
    // `eval` in the prelude; an Annex B block-level declaration whose binding
    // does not list its call sites - are closed, and the three `describe` blocks
    // at the end of this file fail if any of them is reverted. The bulk
    // equivalence evidence is committed too, in
    // `test/register-vm-equivalence.test.ts`: 37 of the fixture's 38 recovered
    // machines run identically before and after, over every assignment of their
    // guards. What is still only one file's worth of evidence is exactly that -
    // one file - so opting in by name stays the only way to get it.
    // See `registerVm` in config/presets.ts and types.ts.
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      expect(resolveConfig({ preset }).techniqueOptions.controlFlowAnalysis.registerVm).toBe(false);
      await expectNoChange(unflattenRegisterVmPass, RETURNING, { preset });
    }

    // Still reachable, so the capability is pinned rather than merely dormant.
    const { changes } = await runPass(unflattenRegisterVmPass, RETURNING, {
      preset: 'aggressive',
      techniques: { controlFlowAnalysis: { registerVm: true } },
    });
    expect(changes).toBeGreaterThan(0);
  });

  it('is off when switched off, whatever the preset', async () => {
    await expectNoChange(unflattenRegisterVmPass, RETURNING, {
      preset: 'aggressive',
      techniques: { controlFlowAnalysis: { registerVm: false } },
    });
  });

  it('linearises a machine that ends by returning', async () => {
    const { code } = await recover(RETURNING);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[0] += 2;second();r[0] += 3;return third();}',
    );
    assertParses(code);
  });

  it('linearises a machine that ends on the halt sum, keeping what follows', async () => {
    const { code } = await recover(HALTING);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[0] += 2;second();r[0] += 3;done();}',
    );
    assertParses(code);
  });

  it('runs the same way it did before', async () => {
    for (const source of [RETURNING, HALTING]) {
      const { code } = await recover(source);
      expect(observe(code)).toEqual(observe(source));
    }
  });

  it('follows a decidable guard inside a block', async () => {
    const source = `${REDUCER}
function vm(r) {
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        if (r[1] === 0) {
          first();
          r[0] += 2;
        } else {
          never();
          r[0] += 100;
        }
        break;
      case 3:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;
    const { code } = await recover(source);
    expect(observe(code)).toEqual(observe(source));
    expect(normalize(code)).toContain('return third();');
  });

  it('applies the register writes that run before the dispatcher', async () => {
    // The loop is a statement of the host body but not its first one, so the
    // machine starts from a vector no call site wrote. Tracing from the raw
    // call vector runs `first()` - a block the real machine never enters -
    // while still emitting the `r[0] += 2` that ruled it out.
    const source = variant(
      'while (sum(r) !== 9) {',
      'r[0] += 2;\n  while (sum(r) !== 9) {',
    );
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'function vm(r){r[0] += 2;second();r[0] += 3;return third();}',
    );
    expect(observe(code)).toEqual(observe(source));
    expect(observe(code).calls).toEqual(['second', 'third']);
    assertParses(code);
  });

  it('writes through a register-valued index', async () => {
    // `r[r[1] + 1]` is as decidable as `r[1]` once the vector is known, and 49
    // of the fixture's 51 tier-1 machines write through one. Both writes below
    // land on a different slot from the one they name.
    const source = `${REDUCER}
function vm(r) {
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        first();
        r[r[1] + 1] += 2;
        break;
      case 3:
        second();
        r[r[1]] += 3;
        break;
      case 6:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[r[1] + 1] += 2;second();r[r[1]] += 3;return third();}',
    );
    expect(observe(code)).toEqual(observe(source));
    expect(observe(code).calls).toEqual(['first', 'second', 'third']);
  });

  it('forks on a guard it cannot decide and emits both successors', async () => {
    // The two arms leave the machine in different states and reach the return
    // by different routes, so a linearisation that picked one would be wrong
    // for the other. `third()` is emitted twice, which is also what proves the
    // second visit takes a copy rather than moving the node.
    const source = `${REDUCER}
function vm(r) {
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        if (flag) {
          first();
          r[0] += 2;
        } else {
          second();
          r[0] += 5;
        }
        break;
      case 3:
        second();
        r[0] += 3;
        break;
      case 6:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'if(flag){first();r[0] += 2;second();r[0] += 3;return third();}' +
        'else{second();r[0] += 5;return third();}',
    );
    expect(observeBothWays(code)).toEqual(observeBothWays(source));
    expect(observe(code, true).calls).toEqual(['first', 'second', 'third']);
    expect(observe(code, false).calls).toEqual(['second', 'third']);
    assertParses(code);
  });

  it('falls through into the next case body', async () => {
    // The state after `case 1` is 5, which no label matches - so a model that
    // treated the end of a body as a return to the loop head would refuse here,
    // and one that treated it as a return to the loop head *and guessed* would
    // run the wrong block. The body that actually runs next is `case 3`'s,
    // which is reachable no other way.
    const source = `${REDUCER}
function vm(r) {
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        first();
        r[0] += 4;
      case 3:
        second();
        r[0] += 1;
        break;
      case 6:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[0] += 4;second();r[0] += 1;return third();}',
    );
    expect(observe(code)).toEqual(observe(source));
    expect(observe(code).calls).toEqual(['first', 'second', 'third']);
  });

  it('reads the entry vector through a frozen table and a pure slice helper', async () => {
    // The fixture never writes its entry vectors out: they arrive as spreads of
    // a one-line forwarder over a constant table, 88 call sites of them.
    const source = `${REDUCER}
var TABLE = [1, 0, 0, 99];
function part(a, b) { return TABLE.slice(a, b); }
${RETURNING.slice(REDUCER.length).replace('vm([1, 0, 0])', 'vm([...part(0, 2), 0])')}`;
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[0] += 2;second();r[0] += 3;return third();}',
    );
    expect(observe(code)).toEqual(observe(source));
  });

  it('accepts several call sites that agree on the vector', async () => {
    const source = `${RETURNING}\nout = vm([1, 0, 0]);`;
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(observe(code)).toEqual(observe(source));
    expect(observe(code).calls).toEqual([
      'first', 'second', 'third', 'first', 'second', 'third',
    ]);
  });

  it('reports how much of the machine the entry vector reached', async () => {
    // `case 6` is entered, `case 1` and `case r[1] + 3` are entered, and a
    // fourth body is not - so three of four is the honest number, and a report
    // that said "over 4 blocks" would read as a full recovery.
    const source = variant('case 6:', 'case 99:\n        never();\n        break;\n      case 6:');
    const { ctx } = await recover(source);
    const detection = ctx.detections.find((d) => d.evidence.startsWith('register VM over'));
    expect(detection?.evidence).toBe('register VM over 3 of 4 blocks, sum(r)');
  });

  it('is idempotent', async () => {
    await expectIdempotent(unflattenRegisterVmPass, RETURNING, RECOVER);
    await expectIdempotent(unflattenRegisterVmPass, HALTING, RECOVER);
  });
});

// ---------------------------------------------------------------------------
// A real dispatcher
// ---------------------------------------------------------------------------

/**
 * The equivalence evidence this pass shipped disabled for want of.
 *
 * Every fixture above is one somebody wrote to exercise a rule, which proves
 * the rule and nothing about the machines the rule was written for. This one is
 * lifted out of obfuscated4.js unmodified except for the instrumentation that
 * makes it runnable - 12 case bodies, labels that read registers the blocks
 * below them write, two guard tests that read through a register-valued index,
 * two guards nothing can decide, and a 98-slot entry vector.
 *
 * `log` records which statement ran and in what order; driving `guard` through
 * every assignment covers both sides of both forks. A linearisation that picked
 * the wrong successor, dropped a block or mis-ordered a delta changes that
 * sequence, and none of those is visible in the text. Both halves were checked
 * by sabotage: narrowing the index rule back to a literal makes the machine
 * unrecoverable, and taking the consequent of a fork instead of emitting both
 * makes the sequences disagree.
 */
const LIFTED_MACHINE = thirdPartyFixture('register-vm-machine.js');

describe.skipIf(!LIFTED_MACHINE.present)('structure.register-vm: a real dispatcher from obfuscated4.js', () => {
  let MACHINE = '';
  beforeAll(() => {
    MACHINE = LIFTED_MACHINE.read();
  });

  /** The statements the machine runs, and what it leaves in `result`. */
  function trace(code: string, guards: number): { log: number[]; result: unknown } {
    const log: number[] = [];
    const context = createContext({
      log: (id: number) => log.push(id),
      // Keyed by the guard's own id rather than by call order, so a guard the
      // linearised form reaches on a different path still answers the same.
      guard: (id: number) => Boolean((guards >> id) & 1),
      result: undefined,
    });
    runInContext(code, context, { timeout: 5_000 });
    return { log, result: (context as { result: unknown }).result };
  }

  it('is linearised, loop and switch and all', async () => {
    const { code, changes } = await recover(MACHINE);
    expect(changes).toBeGreaterThan(0);
    expect(code).not.toContain('while (mvoumz(');
    expect(code).not.toContain('switch (');
    assertParses(code);
  });

  it('runs the same way under every assignment of its guards', async () => {
    const { code, changes } = await recover(MACHINE);
    // Without this the comparison passes on an unchanged file, which is how a
    // recovery that quietly stopped happening would look identical to one that
    // is still exactly right.
    expect(changes).toBeGreaterThan(0);
    for (let guards = 0; guards < 4; guards++) {
      expect(trace(code, guards)).toEqual(trace(MACHINE, guards));
    }
    // Not vacuous: the machine really does run statements, and which ones it
    // runs really does depend on the guards.
    expect(trace(MACHINE, 0).log.length).toBeGreaterThan(0);
    expect(trace(MACHINE, 0).log).not.toEqual(trace(MACHINE, 3).log);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('structure.register-vm: refusals', () => {
  it('refuses a `for` whose head runs code the trace does not model', async () => {
    // `init` runs before the first dispatch and `update` after every block, and
    // both can write the registers the switch key is a sum of. Reading only
    // `test` - which is all the recogniser does - silently ignores them: from
    // `[1, 0, 0]` the init below puts the machine in state 11, and the trace
    // that skips it confidently runs states 1, 3 and 6 instead.
    const head = 'while (sum(r) !== 9) {';

    // The same machine as a bare `for` is recovered, so what the two fixtures
    // below pin is the head and nothing else about them.
    const bare = await recover(variant(head, 'for (; sum(r) !== 9; ) {'));
    expect(bare.changes).toBeGreaterThan(0);

    await expectNoChange(
      unflattenRegisterVmPass,
      variant(head, 'for (r[0] += 10; sum(r) !== 9; ) {'),
      RECOVER,
    );
    await expectNoChange(
      unflattenRegisterVmPass,
      variant(head, 'for (; sum(r) !== 9; r[0] += 10) {'),
      RECOVER,
    );
  });

  it('refuses a parameter default that writes a register', async () => {
    // It runs before the first statement of the body, so `applyPrelude` - which
    // walks statements - has nowhere to see it, and the trace would start from
    // the call site's vector rather than the one the machine really has.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('function vm(r) {', 'function vm(r, x = (r[0] = 5)) {'),
      RECOVER,
    );
  });

  it('refuses a statement before the loop whose register write it cannot order', async () => {
    // The prelude is applied when the trace can follow it and refuses when it
    // cannot; an undecidable guard there is as fatal as one inside a block.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('while (sum(r) !== 9) {', 'if (flag) { r[0] += 2; }\n  while (sum(r) !== 9) {'),
      RECOVER,
    );
  });

  it('refuses a host that mentions `arguments`', async () => {
    // `arguments[0]` *is* the register file, so this writes r[1] in a function
    // that never spells `r` - invisible to a scan that looks for the name.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'arguments[0][1] = 5;'),
      RECOVER,
    );
    // Refused even where it is plainly harmless: telling an alias apart from a
    // read is an analysis this pass does not have, and over-refusing costs a
    // recovery while under-refusing costs a wrong one.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'log(arguments.length);'),
      RECOVER,
    );
    // And inside a nested function that rebinds `r`, which the register-name
    // scan skips whole. An arrow has no `arguments` of its own, so this one is
    // the host's - the register file - in a subtree the other scan never enters.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'second((...r) => { arguments[0][1] = 5; });'),
      RECOVER,
    );
  });

  it('refuses a fork whose other arm goes nowhere', async () => {
    // Forking explores both successors, so a fork is only survivable when both
    // of them are: here the `else` reaches state 4, which no label covers, and
    // the arm that *does* work does not excuse the one that does not.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();\n        r[0] += 2;', 'if (flag) { r[0] += 2; } else { r[0] += 3; }'),
      RECOVER,
    );
  });

  it('refuses a guard that writes a register', async () => {
    // Forking hands the same vector to both successors, which is the vector
    // each of them starts from only while evaluating the test cannot have moved
    // it. This one moves it, so both arms would be traced from a state neither
    // is in.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'if ((r[0] += 1) > 0) { first(); }'),
      RECOVER,
    );
  });

  it('refuses a dispatcher entered with two different vectors', async () => {
    // Two vectors are two programs and the body can only be one of them.
    // Specialising by cloning the host per call site would be sound and is not
    // done: there is no equivalence evidence for it.
    await expectNoChange(
      unflattenRegisterVmPass,
      `${RETURNING}\nout = vm([3, 0, 0]);`,
      RECOVER,
    );
  });

  it('refuses an entry vector whose table the program can write', async () => {
    // The table is what makes the vector concrete, so "never written" is the
    // whole proof; `const` is not enough, because the elements are the claim.
    const withHelper = (extra: string): string => `${REDUCER}
var TABLE = [1, 0, 0, 99];
function part(a, b) { return TABLE.slice(a, b); }
${extra}${RETURNING.slice(REDUCER.length).replace('vm([1, 0, 0])', 'vm([...part(0, 2), 0])')}`;

    await expectNoChange(unflattenRegisterVmPass, withHelper('TABLE[0] = 5;\n'), RECOVER);
    await expectNoChange(unflattenRegisterVmPass, withHelper('TABLE.reverse();\n'), RECOVER);
    // And the helper has to be pure: a body that is more than one returned
    // expression is a body this cannot evaluate without running it.
    await expectNoChange(
      unflattenRegisterVmPass,
      withHelper('').replace(
        'function part(a, b) { return TABLE.slice(a, b); }',
        'function part(a, b) { first(); return TABLE.slice(a, b); }',
      ),
      RECOVER,
    );
  });

  it('refuses an entry vector that is not fully concrete', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('vm([1, 0, 0])', 'vm([1, seed, 0])'),
      RECOVER,
    );
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('vm([1, 0, 0])', 'vm(vector)'),
      RECOVER,
    );
  });

  it('refuses a register written through a computed index', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('r[0] += 2;', 'r[k] = 2;'),
      RECOVER,
    );
  });

  it('refuses a register file handed to anything but the key function', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'send(r);'),
      RECOVER,
    );
  });

  it('refuses a register file reassigned inside the machine', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'r = other;'),
      RECOVER,
    );
  });

  it('refuses a register captured by a nested closure', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'queue(function () { r[4] += 1; });'),
      RECOVER,
    );
    // A `let` shadows its block and not the rest of the function, so the `r[4]`
    // before it is still the register file.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'queue(function () { r[4] += 1; { let r = []; use(r); } });'),
      RECOVER,
    );
  });

  it('looks past a nested function that rebinds the name for its whole body', async () => {
    // The obfuscator reuses its identifiers: 19 of the fixture's 51 tier-1
    // hosts hold a nested `function (...r) { ... }` whose `r` is its own rest
    // parameter. Reading those as the register file threw away a fifth of the
    // file over a spelling.
    for (const shadow of [
      'second(function (...r) { r[4] += 1; });',
      'second(function (r) { r[4] += 1; });',
      'second(function r() { r[4] += 1; });',
      'second(function () { if (flag) { var r = []; } r[4] += 1; });',
    ]) {
      const source = variant('first();', `first();\n        ${shadow}`);
      const { changes } = await recover(source);
      expect(changes, shadow).toBeGreaterThan(0);
      expect(observe(source).calls).toEqual(observe((await recover(source)).code).calls);
    }
  });

  it('refuses a register write inside a nested loop', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('r[0] += 2;', 'for (var j = 0; j < n; j++) { r[0] += 2; }'),
      RECOVER,
    );
  });

  it('refuses an early break that puts the machine back where it was', async () => {
    // The break is followed rather than refused - it is a jump to the loop
    // head, which the walk models - and following it is what shows the problem:
    // no register has moved, so the same case is selected again for ever.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'if (flag) break;'),
      RECOVER,
    );
  });

  it('refuses a break the walk cannot see', async () => {
    // A `break` inside a `try` still leaves the switch, and the walk emits the
    // `try` whole rather than entering it - so this is the one jump it would
    // mis-model, and it is refused by position rather than followed.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'try { break; } finally { first(); }'),
      RECOVER,
    );
  });

  it('refuses a switch with a default', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('case 6:\n        return third();', 'default:\n        return third();'),
      RECOVER,
    );
  });

  it('refuses a state the labels do not cover', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('case r[1] + 3:', 'case r[1] + 4:'),
      RECOVER,
    );
  });

  it('refuses once the state budget is spent', async () => {
    await expectNoChange(unflattenRegisterVmPass, RETURNING, {
      techniques: { controlFlowAnalysis: { registerVm: true, maxRegisterVmStates: 1 } },
    });
  });

  it('refuses a block declaring a block-scoped name or a function', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'let held = 1;'),
      RECOVER,
    );
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();', 'function held() {}'),
      RECOVER,
    );
  });

  it('refuses when the key function is not the sum reducer', async () => {
    await expectNoChange(
      unflattenRegisterVmPass,
      variant(REDUCER, 'function sum(a) { return a.length; }'),
      RECOVER,
    );
  });
});

// ---------------------------------------------------------------------------
// Soundness: writes, and reaches, the pass could not see
// ---------------------------------------------------------------------------

/** The one note `structure.control-flow` leaves on a snippet it refuses. */
async function refusalReason(source: string): Promise<string> {
  const { ctx, changes } = await runPass(unflattenControlFlowPass, source, RECOVER);
  expect(changes).toBe(0);
  const notes = ctx.diagnostics.filter((d) => d.source === 'structure.control-flow');
  expect(notes).toHaveLength(1);
  return notes[0]?.message ?? '';
}

/**
 * A machine whose *visible* write moves the state 1 → 3, with room for one more
 * statement that moves it 3 → 6.
 *
 * That gap is the whole point. A trace that misses the second write believes the
 * machine is in state 3, runs `case 3` - a block the program never enters - and
 * emits the very statement that ruled it out, so the wrong output carries the
 * evidence against itself and still parses, runs and returns a value.
 *
 * Without the gate, `[r[1]] = [3];` here linearises to `function vm(r) {
 * first(); r[0] += 2; [r[1]] = [3]; second(); r[0] += 3; return third(); }` -
 * `first, second, third` against the program's `first, third`.
 */
function invisibleWrite(write: string): string {
  return `${REDUCER}
function vm(r) {
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        first();
        r[0] += 2;
        ${write}
        break;
      case 3:
        second();
        r[0] += 3;
        break;
      case 6:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;
}

describe('structure.register-vm: a write is a position, not a node type', () => {
  it('recovers the same machine when the extra statement is not a write', async () => {
    // The control every refusal below is measured against: those fixtures differ
    // from this one by a single statement, so what they pin is that statement
    // and not some accident of the shape.
    const source = invisibleWrite('done();');
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[0] += 2;done();second();r[0] += 3;return third();}',
    );
    expect(observe(code)).toEqual(observe(source));
    expect(observe(source).calls).toEqual(['first', 'done', 'second', 'third']);
  });

  for (const [form, write, named] of [
    ['a destructuring array pattern', '[r[1]] = [3];', 'a destructuring pattern'],
    ['a destructuring object pattern', '({ z: r[1] } = { z: 3 });', 'a destructuring pattern'],
    ['a for-of head', 'for (r[1] of [3]) {}', 'a for-in/of head'],
  ] as const) {
    it(`refuses a register written through ${form}`, async () => {
      const source = invisibleWrite(write);
      // Not vacuous: the write really does move the machine, so the pass has
      // two honest options here and linearising is neither of them.
      expect(observe(source).calls).toEqual(['first', 'third']);
      await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
      expect(await refusalReason(source)).toContain(`r is written through ${named}`);
    });
  }

  it('refuses a register written through `delete`', async () => {
    // Not run through `observe`: deleting a slot leaves a hole, the reducer sums
    // `undefined` into the key, and `NaN !== 9` keeps the original in its loop
    // for ever. Which is the point - without the gate this linearises to
    // `first(); r[0] += 2; delete r[1]; second(); r[0] += 3; return third();`,
    // a program that terminates where the one it came from does not.
    const source = invisibleWrite('delete r[1];');
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('r is written through `delete`');
  });

  it('refuses a register written through a for-in head', async () => {
    // Out of `observe` for the same reason as `delete`: the head assigns the
    // *string* '3', the reducer concatenates rather than adds, and the key never
    // matches a label again.
    const source = invisibleWrite('for (r[1] in { 3: 1 }) {}');
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('r is written through a for-in/of head');
  });

  it('still refuses when the unseen write is the only one in the block', async () => {
    // With no `r[0] += 2` beside it the machine returns to state 1, so a
    // detector blind to the write still refuses by luck - "already been in this
    // state on this path". Pinned so that accident cannot be mistaken for the
    // gate doing its job.
    await expectNoChange(
      unflattenRegisterVmPass,
      variant('first();\n        r[0] += 2;', 'first();\n        [r[0]] = [3];'),
      RECOVER,
    );
  });
});

describe('structure.register-vm: reaching the register file without naming it', () => {
  /** The same machine, with one statement placed before the loop. */
  function prelude(statement: string): string {
    return `${REDUCER}
function vm(r) {
  ${statement}
  while (sum(r) !== 9) {
    switch (sum(r)) {
      case 1:
        first();
        r[0] += 2;
        break;
      case 3:
        second();
        r[0] += 3;
        break;
      case 6:
        return third();
    }
  }
}
out = vm([1, 0, 0]);`;
  }

  it('refuses a direct `eval` before the loop', async () => {
    // `applyPrelude` walks these statements to move the entry vector. A direct
    // `eval` is handed the scope rather than a value, so it writes `r` in a
    // statement whose sole mention of `r` is inside a string literal: a walk
    // that asks only "does this hold a write it can see" passes over it and
    // traces from the call site's vector instead.
    const source = prelude("eval('r[0] += 2');");
    // The eval moves the machine to state 3, so the program never runs `case 1`.
    expect(observe(source).calls).toEqual(['second', 'third']);
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('calls `eval`');
  });

  it('refuses a direct `eval` nested in a function before the loop', async () => {
    // The scan must not stop at a function boundary the way `scanJumps` does: a
    // jump cannot cross one and a scope chain can, so this closure's `eval`
    // reaches the same array through the same lexical `r`.
    const source = prelude("(function () { eval('r[0] += 2'); })();");
    expect(observe(source).calls).toEqual(['second', 'third']);
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('calls `eval`');
  });

  it('refuses a direct `eval` nested in a function inside a case body', async () => {
    // The same hole one level down: `scanCaseJumps().sawEval` has to report
    // this too, or the body is emitted verbatim while the trace carries on with
    // the vector it had.
    const source = invisibleWrite("(function () { eval('r[1] = 3'); })();");
    expect(observe(source).calls).toEqual(['first', 'third']);
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('`eval`');
  });

  it('recovers past an indirect `eval`, which cannot see the register file', async () => {
    // The refusal is aimed rather than blanket. `(0, eval)(...)` is indirect: it
    // runs in the global scope, where `r` does not exist, so it can no more
    // reach the register file than any other opaque call the prelude makes.
    const source = prelude("(0, eval)('1;');");
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain('first();r[0] += 2;second();r[0] += 3;return third();');
  });
});

describe('structure.register-vm: call sites a binding does not list', () => {
  /** `RETURNING`, plus a `case 7` only an outer call site can reach. */
  const WITH_SEVEN = variant(
    'case 6:\n        return third();',
    'case 6:\n        return third();\n      case 7:\n        return fourth();',
  );

  /** The machine, with its declaration and its call site wrapped in `open`...`close`. */
  function wrapped(open: string, close: string, outer = ''): string {
    return `${REDUCER}\n${open}${WITH_SEVEN.slice(REDUCER.length)}\n${close}${outer}`;
  }

  it('refuses a dispatcher declared inside a block', async () => {
    // Annex B.3.3: in sloppy mode the name of a block-level function
    // declaration is *also* var-declared in the enclosing script, so `vm` is
    // callable from outside the block while Babel binds it to the block. The
    // "all call sites agree on one vector" proof then reads one call site out of
    // two and specialises the machine to a vector half its callers never use:
    // the output runs `first, second, third` twice where the program runs it
    // once and then `fourth`.
    const source = wrapped('{\n', '}\n', 'out2 = vm([7, 0, 0]);');
    expect(observe(source).calls).toEqual(['first', 'second', 'third', 'fourth']);
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('declared inside a block');
  });

  it('refuses it even when nothing outside the block calls it', async () => {
    // The objection is that `binding.referencePaths` is not an enumeration of
    // the call sites, not that this particular file exploited it. A gate that
    // fired only on the exploit would be one that passes until it matters.
    const source = wrapped('{\n', '}\n');
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('declared inside a block');
  });

  it('refuses a dispatcher declared inside a switch case', async () => {
    const source = wrapped('switch (flag) {\n  case true:\n', '}\n');
    await expectNoChange(unflattenRegisterVmPass, source, RECOVER);
    expect(await refusalReason(source)).toContain('declared inside a block');
  });

  it('recovers a dispatcher whose binding really is the whole story', async () => {
    // Both halves of the rule, so that what the refusals above pin is the block
    // and not function declarations in general. At the top level of a function
    // body the declaration is var-scoped to that function and Annex B has
    // nothing to add; at the top level of the program - which every other
    // fixture in this file uses - the same holds.
    const source = wrapped('function outer() {\n', 'return out;\n}\nout = outer();\n');
    const { code, changes } = await recover(source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain(
      'function vm(r){first();r[0] += 2;second();r[0] += 3;return third();}',
    );
    expect(observe(code)).toEqual(observe(source));
  });
});
