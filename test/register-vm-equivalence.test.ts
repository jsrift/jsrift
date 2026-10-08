import { createContext, runInContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

import { unflattenRegisterVmPass } from '../src/passes/structure/register-vm.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, runPass } from './helpers.js';
import { liftRegisterVms, type LiftResult } from './support/register-vm-lift.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

/**
 * Bulk observational equivalence for `structure.register-vm`, over every
 * dispatcher the pass recovers in obfuscated4.js.
 *
 * WHY THIS FILE EXISTS. `registerVm` is off in all three presets, and the
 * reason recorded in `types.ts` and in the preset assertion is the absence of
 * exactly this: evidence over the *fixture's* machines rather than over the
 * cases somebody thought to write down. `test/register-vm.test.ts` runs one
 * hand-lifted machine and about forty synthetic ones; a linearisation that
 * picked the wrong successor on the 23rd machine of a 4 MB file would pass all
 * of them. Nothing about a wrong linearisation is visible in the text - it
 * parses, it runs, and it computes something else - so the only test that can
 * catch it is one that runs both versions.
 *
 * WHAT IT PROVES, and the shape of the claim. For each machine: the pass
 * linearises it, and the linearised program logs the same statements in the
 * same order and returns the same value as the original, under **every**
 * assignment of the machine's undecidable guards. Coverage of the guards is
 * exhaustive rather than sampled - the machines carry 0, 1 or 2 of them, so
 * `2 ** guards` is at most 4 - which matters because forking is the one place
 * the pass emits code for a path it did not decide.
 *
 * WHAT IT DOES NOT PROVE. The opaque statements do not run: they read a frozen
 * constant table and call decoders that live in the other 3.8 MB of the file,
 * so each becomes `log(n)` and what is compared is *which* of them ran, in what
 * order. That is the property linearisation can break; it is not the property
 * "the deobfuscated file still works", which no unit test establishes.
 *
 * COST. One full `aggressive` run over the 3.8 MB fixture, because the machines
 * have to be taken from the tree at the start of `structure` rather than from
 * the file on disk - before `prepare`/`strings`/`simplify`, obfuscated4.js
 * contains zero recognisable register VMs. Measured at roughly 35 s, which is
 * inside the file-level parallelism the rest of the suite already runs at.
 */
const FIXTURE = thirdPartyFixture('obfuscated4.js');

const RECOVER: DeobfuscateOptions = {
  techniques: { controlFlowAnalysis: { registerVm: true } },
};

/**
 * Run a lifted machine and record what it did.
 *
 * `log` records which statement ran and in what order; `guard` answers each
 * undecidable test from one bit of `guards`, keyed by the guard's own id rather
 * than by call order so that a guard the linearised form reaches on a different
 * path still answers the same. `node:vm` rather than `eval` or a dynamic
 * import: the engine never executes its input, and the sandbox has no `require`
 * and no globals beyond these three.
 */
function trace(code: string, guards: number): { log: number[]; result: unknown } {
  const log: number[] = [];
  const context = createContext({
    log: (id: number) => {
      log.push(id);
      return id;
    },
    guard: (id: number) => Boolean((guards >> id) & 1),
    result: undefined,
  });
  runInContext(code, context, { timeout: 10_000 });
  return { log, result: (context as { result: unknown }).result };
}

describe.skipIf(!FIXTURE.present)('structure.register-vm: bulk equivalence over obfuscated4.js', () => {
  let lifted: LiftResult;

  beforeAll(async () => {
    lifted = await liftRegisterVms(FIXTURE.read());
  }, 300_000);

  it('lifts every machine the pass recovers', () => {
    // The numbers quoted in `register-vm.ts` and in `types.ts` are these ones,
    // and they are asserted so that a change which quietly recovers fewer
    // machines fails here rather than going unnoticed in a comment.
    expect(lifted.recognised).toBe(67);
    expect(lifted.recoverable).toBe(38);

    // Every skip is named. A harness that silently dropped the awkward machines
    // would report a number that means nothing.
    const skipped = lifted.skipped.map((s) => `${s.id}: ${s.reason}`).join('\n  ');
    console.log(
      `register-vm equivalence: ${lifted.machines.length} of ${lifted.recoverable} recoverable machines lifted` +
        (skipped ? `\n  skipped:\n  ${skipped}` : ''),
    );
    // 37 of the 38. The one skipped holds a `for (... in ...)` with a `return`
    // inside it: that machine leaves through an opaque statement, and replacing
    // that statement with `log(n)` would change where it stops - so it is
    // skipped rather than instrumented into a different machine.
    expect(lifted.machines.length).toBe(37);
    expect(lifted.skipped).toHaveLength(1);
    expect(lifted.skipped[0]?.reason).toContain('`return`');
  });

  it('covers machines with real forks, not only straight lines', () => {
    // Without this the suite could pass on 37 machines that never fork, and the
    // guard sweep below would be exhaustive over nothing.
    const forking = lifted.machines.filter((m) => m.guards > 0);
    expect(forking.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...lifted.machines.map((m) => m.guards))).toBeGreaterThanOrEqual(2);
    // And they are machines, not fragments: a dozen blocks and a wide file.
    expect(Math.min(...lifted.machines.map((m) => m.blocks))).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lifted.machines.map((m) => m.registers))).toBeGreaterThanOrEqual(64);
  });

  it('runs the same way after linearisation as before, on every machine', async () => {
    let checked = 0;
    let assignments = 0;
    let statements = 0;

    for (const machine of lifted.machines) {
      const { code, changes } = await runPass(unflattenRegisterVmPass, machine.source, RECOVER);
      // A comparison against an unchanged file passes for free, which is how a
      // recovery that quietly stopped happening would look identical to one
      // that is still exactly right.
      expect(changes, `${machine.id} was not linearised`).toBeGreaterThan(0);
      expect(code, `${machine.id} still has its dispatch loop`).not.toContain('switch (');
      assertParses(code);

      for (let guards = 0; guards < 2 ** machine.guards; guards++) {
        const before = trace(machine.source, guards);
        const after = trace(code, guards);
        expect(after.log, `${machine.id} @ guards=${guards}: statement order`).toEqual(before.log);
        expect(after.result, `${machine.id} @ guards=${guards}: result`).toEqual(before.result);
        // Not vacuous: a machine that logged nothing would compare equal to
        // anything, and one that never ran would too.
        expect(before.log.length, `${machine.id} @ guards=${guards} logged nothing`).toBeGreaterThan(0);
        assignments++;
        statements += before.log.length;
      }
      checked++;
    }

    console.log(
      `register-vm equivalence: ${checked} machines, ${assignments} guard assignments, ` +
        `${statements} statement observations, all matching`,
    );
    // Pinned rather than bounded: these are the numbers the comments in
    // `register-vm.ts` and `types.ts` quote, and a change that recovers fewer
    // machines or stops forking should fail here, not read the same.
    expect(checked).toBe(37);
    expect(assignments).toBe(72);
    expect(statements).toBeGreaterThanOrEqual(700);
  }, 300_000);

  it('would fail if the linearisation took one arm of a fork instead of both', async () => {
    // The sweep above is only meaningful if a wrong linearisation is visible
    // through `log`. Sabotage by hand: take a forking machine and delete the
    // arm the guard does not select on the first pass through.
    const forking = lifted.machines.find((m) => m.guards > 0);
    expect(forking).toBeDefined();
    const { code } = await runPass(unflattenRegisterVmPass, forking!.source, RECOVER);

    const differs = [0, 1].some((guards) => {
      const honest = trace(code, guards);
      const wrong = trace(code.replaceAll('guard(0)', 'true'), guards);
      return JSON.stringify(honest.log) !== JSON.stringify(wrong.log);
    });
    expect(differs, 'pinning a fork changed nothing, so the sweep proves nothing').toBe(true);
  }, 120_000);
});
