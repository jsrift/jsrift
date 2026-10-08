import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { recoverConditionalsPass } from '../src/passes/structure/conditionals.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, expectNoChange, runPass } from './helpers.js';

/**
 * Work the engine could only do on the *second* run over its own output.
 *
 * Every case here was a real gap between run one and run two on the five
 * fixtures, and each one is the same shape: run one judged something against a
 * fact that its own output then changed. Printing rewrites a bare `if`
 * consequent into a braced one; renaming replaces the very names the naming
 * rules read as evidence. Neither is visible from inside the run that causes
 * it, which is why the difference only ever showed up as "run two is not run
 * one".
 *
 * The assertion that matters in every case is byte equality between a run and
 * the run after it. "Run two changes less than run one" is not the property: a
 * pass that moves three characters a run moves them forever.
 */
const PRESETS = ['balanced', 'aggressive'] as const;

/** Deobfuscate `source`, then deobfuscate that output `rounds - 1` more times. */
async function iterate(
  source: string,
  rounds: number,
  options: DeobfuscateOptions,
): Promise<string[]> {
  const outputs: string[] = [];
  let current = source;
  for (let round = 0; round < rounds; round++) {
    const { code } = await deobfuscate(current, options);
    current = code;
    outputs.push(code);
  }
  return outputs;
}

/** Assert the first output is already the fixed point. */
async function expectSettledFirstRun(
  source: string,
  options: DeobfuscateOptions,
): Promise<string> {
  const [first, second, third] = await iterate(source, 3, options);
  expect(second).toBe(first);
  expect(third).toBe(second);
  assertParses(first!);
  return first!;
}

// ---------------------------------------------------------------------------
// The printer's braces
// ---------------------------------------------------------------------------

/**
 * `if (a) if (b) c(); else d();` binds the `else` to the *inner* `if`, so an
 * outer `if` that has an `else` of its own cannot be printed without bracing its
 * consequent. `@babel/generator` inserts those braces itself - its rule is
 * `node.alternate && isIfStatement(getLastStatement(node.consequent))` - and the
 * tree it printed from still says "bare statement".
 *
 * That disagreement decides whether a pass may insert a sibling statement.
 * `simplify/sequences.ts` hoists `if (a, b)` to `a; if (b)` only from a real
 * statement list, and in this position there is none until the output has been
 * printed and parsed again.
 *
 * Measured on `lightly-obfuscated.js` at 'balanced' before the fix: the engine
 * converged with one such `if` unhoisted, printed the braces, and a second run
 * hoisted it and emitted 164 characters the first run could not. A probe over
 * the settled tree counted five `if`s with a sequence test, none of them in a
 * statement list; after the reparse one of the five was.
 */
const DANGLING_ELSE = `function _0x1(_0x2, _0x3, _0x4) {
  if (_0x2) if (report(_0x3), _0x4) { report('c'); } else { report('d'); } else { report('e'); }
  return _0x4;
}
report(_0x1(1, 2, 3));`;

describe('structure.conditionals: the braces a dangling else forces', () => {
  it.each(PRESETS)('hoists the sequence on the first run at %s', async (preset) => {
    const code = await expectSettledFirstRun(DANGLING_ELSE, { preset });
    // The sequence's leading operand is now a statement of its own, which is
    // only expressible because the consequent became a block. Written against
    // the shape rather than the names, which 'aggressive' rewrites.
    expect(code).toMatch(/if \([\w$]+\) \{\s*report\([\w$]+\);\s*if \(/);
    expect(code).not.toMatch(/if \(report\([\w$]+\), [\w$]+\)/);
  });

  it('is that pass doing it - disabled, the work moves to the second run', async () => {
    const [first, second] = await iterate(DANGLING_ELSE, 2, {
      preset: 'balanced',
      disablePasses: ['structure.conditionals'],
    });
    // The defect, reproduced: run one prints braces it did not put in the tree...
    expect(first).toContain('if (report(_0x3), _0x4)');
    // ...and run two, reading them back, does the hoist run one could not.
    expect(second).not.toBe(first);
    expect(second).toContain('report(_0x3);');
  });

  it('braces a consequent whose dangling `if` is reached through a loop', async () => {
    // `getLastStatement` follows `body`, so the printer braces this one too and
    // the rule has to reach through the loop to agree with it. Asserted on the
    // change count rather than on the text: the printed bytes are identical
    // either way, which is the whole reason the disagreement was invisible.
    const result = await runPass(
      recoverConditionalsPass,
      'if (a) while (b) if (c) d(); else e(); else f();',
    );
    expect(result.changes).toBe(1);
    expect(result.code).toMatch(/if \(a\) \{[\s\S]*while \(b\)/);
  });

  it('leaves the consequent bare when no `else` can dangle', async () => {
    // No outer `else`, so the printer emits no braces and neither do we.
    await expectNoChange(recoverConditionalsPass, 'if (a) if (b) c(); else d();');
    // A consequent that is not an `if` cannot capture an `else` either.
    await expectNoChange(recoverConditionalsPass, 'if (a) c(); else d();');
  });
});

// ---------------------------------------------------------------------------
// Fallback numbers
// ---------------------------------------------------------------------------

/**
 * `val1`, `val2`, `arg7` are what a binding is called when no rule fired. The
 * number is a *position* - how many `val`s this scope had handed out before this
 * one - so it is a fact about the run and not about the binding, and it cannot
 * be re-derived from the output.
 *
 * Measured on `lightly-obfuscated.js` at 'aggressive' before the fix: one
 * binding joined the `val` family on the second run, shifted every later number
 * by one, and each shifted name collided with the binding then holding it, so 73
 * bindings moved to the `_2` spelling (`val64 -> val65_2`, `val65 -> val66_2`,
 * ...) and 62 of them moved back on the third (`val64_2 -> val64`). The output
 * went +1 253 characters and then -1 058 and never settled.
 */
const SETTLED_FAMILY = `function _0x1(_0x2) {
  var _0x3 = _0x2(), val1 = _0x2(), val2 = _0x2();
  return report(_0x3, val1, val2);
}
report(_0x1(function () { return 1; }));`;

describe('rename.identifiers: a fallback number is a position, not a name', () => {
  it('leaves a binding already carrying a name from its own fallback family', async () => {
    // The newcomer is written first, so without the guard it takes `val1` - the
    // number `val1` is already using - and the collision walks down the list:
    // `_0x3 -> val1_2`, `val1 -> val2_2`, `val2 -> val3`, which the next run
    // undoes as `val1_2 -> val1`, `val2_2 -> val2`.
    const code = await expectSettledFirstRun(SETTLED_FAMILY, { preset: 'aggressive' });
    expect(code).toContain('val1 = ');
    expect(code).toContain('val2 = ');
  });

  it('hands a newcomer the first free number, not a collision suffix', async () => {
    const code = await expectSettledFirstRun(SETTLED_FAMILY, { preset: 'aggressive' });
    // `val1` and `val2` are taken, so the counter steps over them rather than
    // offering the binding `val1_2` - a spelling that says "second `val1`"
    // about a binding that is neither.
    expect(code).toContain('val3 = ');
    expect(code).not.toContain('_2');
  });
});

// ---------------------------------------------------------------------------
// Evidence that survives the run that reads it
// ---------------------------------------------------------------------------

/**
 * A naming rule that copies a name out of the evidence has to copy the name the
 * *output* will carry. `world.displayName` is the channel for that, and it
 * reported a binding's current name whenever `isReadableName` liked the look of
 * it - a claim about the spelling, not about whether this run is going to
 * replace it.
 *
 * Two measured cases, both at 'aggressive':
 *
 *   * F03 (for-of element). `_0x2` passes `isReadableName` - four characters,
 *     one letter, too few hex digits for the obfuscated pattern - so the element
 *     was named after it at confidence 0.704, under the preset's floor, and fell
 *     through to `val1`. Run two read the parameter's new name `arg1`, F03
 *     declined, and the element became `item`.
 *   * A07 (instance named after its class). `lightly-obfuscated.js` declares
 *     `function Ix(...)` and a binding `ja = new Ix()`, so run one emitted
 *     `ja -> ix` while renaming `Ix` itself to a numbered fallback in the same
 *     pass - a name derived from an identifier that appears nowhere in its own
 *     output. Three bindings moved that way on run two, 331 characters.
 */
const FOR_OF_ELEMENT = `function _0x1(_0x2) { var _0x3 = 0; for (var _0x4 of _0x2) { _0x3 += _0x4; } return _0x3; }
report(_0x1([1, 2]));`;

const RENAMED_CONSTRUCTOR = `function Ix(_0xv) { this.v = _0xv; }
function _0x9(_0xa) { var _0xb = new Ix(_0xa); return _0xb.v; }
report(_0x9(1));`;

const HOST_CONSTRUCTOR = `function _0x9(_0xa) { var _0xb = new Widget(_0xa); return _0xb.v; }
report(_0x9(1));`;

describe('naming: evidence is the name the output will carry', () => {
  it('does not name a for-of element after a container about to be renamed', async () => {
    const code = await expectSettledFirstRun(FOR_OF_ELEMENT, { preset: 'aggressive' });
    expect(code).toContain('for (var item of');
    expect(code).not.toContain('val1');
  });

  it('does not name an instance after a constructor this run renames', async () => {
    const code = await expectSettledFirstRun(RENAMED_CONSTRUCTOR, { preset: 'aggressive' });
    // `Ix` is itself a rename target, so there is no class name to copy.
    expect(code).not.toMatch(/\bix\b/);
  });

  it('still names an instance after a constructor nothing renames', async () => {
    // `Widget` is free: this file does not bind it and cannot rename it, so its
    // own name is the surviving one and A07 uses it exactly as before.
    const code = await expectSettledFirstRun(HOST_CONSTRUCTOR, { preset: 'aggressive' });
    expect(code).toContain('widget = new Widget(');
  });
});
