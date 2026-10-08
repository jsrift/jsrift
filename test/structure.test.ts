import { beforeAll, describe, expect, it } from 'vitest';
import { recoverConditionalsPass } from '../src/passes/structure/conditionals.js';
import { recoverLoopsPass } from '../src/passes/structure/loops.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const FIXTURE = thirdPartyFixture('lightly-obfuscated.js');

describe('structure.conditionals', () => {
  it('turns a && guard into an if statement', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a && b();');
    expectEquivalent(code, 'if (a) { b(); }');
  });

  it('turns a || guard into a negated if statement', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a || b();');
    expectEquivalent(code, 'if (!a) { b(); }');
  });

  it('inverts an equality test rather than wrapping it in !', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'x === 1 || fail();');
    expectEquivalent(code, 'if (x !== 1) { fail(); }');
  });

  it('does not flip a relational operator, which NaN makes unsound', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'x < 1 || fail();');
    expectEquivalent(code, 'if (!(x < 1)) { fail(); }');
  });

  it('collapses a double negation instead of stacking one more', async () => {
    const { code } = await runPass(recoverConditionalsPass, '!ready || start();');
    expectEquivalent(code, 'if (ready) { start(); }');
  });

  it('turns a statement-position ternary into if/else', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a ? b() : c();');
    expectEquivalent(code, 'if (a) { b(); } else { c(); }');
  });

  it('drops a placeholder alternate', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a ? b() : void 0;');
    expectEquivalent(code, 'if (a) { b(); }');
  });

  it('drops a placeholder consequent by negating the test', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a ? 0 : b();');
    expectEquivalent(code, 'if (!a) { b(); }');
  });

  it('gives a sequence inside the recovered branch one statement per operand', async () => {
    const { code } = await runPass(recoverConditionalsPass, '(!d || b && x) && (ca = Di[sa], foo());');
    expectEquivalent(code, 'if (!d || b && x) { ca = Di[sa]; foo(); }');
  });

  it('chains && guards into a single test rather than nesting', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'a && b && c();');
    expectEquivalent(code, 'if (a && b) { c(); }');
  });

  it('collapses if (a) { if (b) {} } into a single test', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'if (a) { if (b) { run(); } }');
    expectEquivalent(code, 'if (a && b) { run(); }');
  });

  it('refuses to collapse when the outer if has an else', async () => {
    await expectNoChange(recoverConditionalsPass, 'if (a) { if (b) { run(); } } else { other(); }');
  });

  it('refuses to collapse when the inner if has an else', async () => {
    await expectNoChange(recoverConditionalsPass, 'if (a) { if (b) { run(); } else { other(); } }');
  });

  it('keeps a comment attached to the inner condition', async () => {
    await expectNoChange(recoverConditionalsPass, 'if (a) {\n  // only when b\n  if (b) { run(); }\n}');
  });

  it('leaves a logical expression whose value is used', async () => {
    await expectNoChange(recoverConditionalsPass, 'var r = a && b();');
  });

  it('leaves a logical expression used as an argument', async () => {
    await expectNoChange(recoverConditionalsPass, 'send(a && b());');
  });

  it('leaves a guard that computes nothing', async () => {
    await expectNoChange(recoverConditionalsPass, 'a && b.c;');
  });

  it('leaves nullish coalescing alone', async () => {
    await expectNoChange(recoverConditionalsPass, 'a ?? b();');
  });

  it('leaves a small return ternary as a ternary', async () => {
    await expectNoChange(recoverConditionalsPass, 'function f() { return a ? b : c; }');
  });

  it('splits a large return ternary into an if chain', async () => {
    const source =
      'function f() { return t ? aaa(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20) : bbb(); }';
    const { code } = await runPass(recoverConditionalsPass, source);
    expect(code).toContain('if (t)');
    expect(code).toContain('return bbb();');
  });

  it('unrolls a nested return ternary into else-if rather than nesting', async () => {
    const source =
      'function f() { return p ? one(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20) : q ? two() : three(); }';
    const { code } = await runPass(recoverConditionalsPass, source);
    expect(code).toContain('} else if (q) {');
  });

  it('is idempotent over mixed expression control flow', async () => {
    await expectIdempotent(
      recoverConditionalsPass,
      'a && b(); c || d(); e ? f() : g(); if (h) { if (i) { j(); } }',
    );
  });

  it('produces parseable output for a guard inside a non-block if branch', async () => {
    const { code } = await runPass(recoverConditionalsPass, 'if (x) a && b(); else c();');
    assertParses(code);
    expect(code).toContain('else');
  });
});

describe('structure.loops', () => {
  it('rewrites for(;;) as while (true)', async () => {
    const { code } = await runPass(recoverLoopsPass, 'for (;;) { if (done) break; step(); }');
    expect(code).toContain('while (true)');
  });

  it('rewrites a test-only for as a while', async () => {
    const { code } = await runPass(recoverLoopsPass, 'for (; i < n;) { step(); }');
    expect(code).toContain('while (i < n)');
  });

  it('gives a bare loop body a block', async () => {
    const { code } = await runPass(recoverLoopsPass, 'while (x) step();');
    expectEquivalent(code, 'while (x) { step(); }');
  });

  it('normalises a prefix increment in the update slot', async () => {
    const { code } = await runPass(recoverLoopsPass, 'for (var i = 0; i < n; ++i) { step(); }');
    expect(code).toContain('i++');
  });

  it('leaves an already idiomatic counting loop alone', async () => {
    await expectNoChange(recoverLoopsPass, 'for (var i = 0; i < n; i++) { step(); }');
  });

  it('lifts hidden work out of a comma-separated update', async () => {
    const { code } = await runPass(recoverLoopsPass, 'for (i = 0; i < n; log(i), i++) { step(); }');
    expectEquivalent(code, 'for (i = 0; i < n; i++) { step(); log(i); }');
  });

  it('refuses to lift the update when continue would skip it', async () => {
    await expectNoChange(
      recoverLoopsPass,
      'for (i = 0; i < n; log(i), i++) { if (skip) continue; step(); }',
    );
  });

  it('leaves a purely arithmetic comma update in the header', async () => {
    await expectNoChange(recoverLoopsPass, 'for (i = 0, j = n; i < j; i++, j--) { step(); }');
  });

  it('unwraps do/while(false) into a plain block', async () => {
    const { code } = await runPass(recoverLoopsPass, 'do { step(); } while (false);');
    expectEquivalent(code, '{ step(); }');
  });

  it('keeps do/while(false) when a break depends on it', async () => {
    await expectNoChange(recoverLoopsPass, 'do { if (x) break; step(); } while (false);');
  });

  it('keeps do/while(true), which is a real loop', async () => {
    await expectNoChange(recoverLoopsPass, 'do { step(); } while (true);');
  });

  it('keeps a labelled do/while(false) reachable by its label', async () => {
    await expectNoChange(recoverLoopsPass, 'outer: do { step(); } while (false);');
  });

  it('preserves a labelled continue when converting for(;;)', async () => {
    const { code } = await runPass(
      recoverLoopsPass,
      'outer: for (;;) { for (;;) { continue outer; } }',
    );
    assertParses(code);
    expect(code).toContain('continue outer');
  });

  it('is idempotent over mixed loop forms', async () => {
    await expectIdempotent(
      recoverLoopsPass,
      'for (;;) { break; } while (x) step(); for (var i = 0; i < n; ++i) { step(); } do { a(); } while (false);',
    );
  });
});

describe.skipIf(!FIXTURE.present)('structure passes on the real fixture', () => {
  let source: string;
  beforeAll(() => {
    source = FIXTURE.read();
  });

  it('recovers conditionals without breaking the file', async () => {
    const started = Date.now();
    const { code, changes } = await runPass(recoverConditionalsPass, source);
    const elapsed = Date.now() - started;
    assertParses(code);
    // Run in isolation only ~220 guards sit directly in statement position; the
    // other ~870 are still inside comma sequences that `simplify.sequences`
    // expands earlier in a full pipeline run.
    expect(changes).toBeGreaterThan(150);
    console.log(`structure.conditionals: ${changes} changes in ${elapsed}ms`);
  });

  it('recovers loops without breaking the file', async () => {
    const started = Date.now();
    const { code, changes } = await runPass(recoverLoopsPass, source);
    const elapsed = Date.now() - started;
    assertParses(code);
    console.log(`structure.loops: ${changes} changes in ${elapsed}ms`);
  });
});
