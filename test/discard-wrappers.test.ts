import { describe, expect, it } from 'vitest';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { unwrapDiscardedArgumentsPass } from '../src/passes/simplify/discard-wrappers.js';
import { expandSequencesPass } from '../src/passes/simplify/sequences.js';
import type { DeobfuscateOptions } from '../src/types.js';
import {
  assertParses,
  expectEquivalent,
  expectIdempotent,
  expectNoChange,
  normalize,
  runPass,
} from './helpers.js';

/** The fixture's own shape: a wrapper that erases itself on first call. */
const SELF_ERASING = 'function w() { w = function () {}; }';

async function unwrap(source: string, options: DeobfuscateOptions = {}) {
  return runPass(unwrapDiscardedArgumentsPass, source, options);
}

/** The pass plus its downstream consumer, in registry order. */
async function flatten(source: string, options: DeobfuscateOptions = {}) {
  return runPass([unwrapDiscardedArgumentsPass, expandSequencesPass], source, options);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

describe('simplify.discard-wrappers: recovery', () => {
  it('turns a self-erasing wrapper call into a comma sequence', async () => {
    const { code } = await unwrap(`${SELF_ERASING} w(a[i] = 1, b.k++);`);
    expectEquivalent(code, `${SELF_ERASING} a[i] = 1, b.k++;`);
  });

  it('turns an empty-bodied wrapper call into a comma sequence', async () => {
    const { code } = await unwrap('function w() {} w(a(), b());');
    expectEquivalent(code, 'function w() {} a(), b();');
  });

  it('reaches statements in one traversal when paired with simplify.sequences', async () => {
    // What the registry position buys. With one fixpoint round available the
    // in-place rewrite is visible to the sequence expander in the same
    // traversal; registered the other way round it would still be a sequence.
    const source = `${SELF_ERASING} w(a(), b(), c());`;
    const forwards = await flatten(source, { performance: { maxIterations: 1 } });
    expectEquivalent(forwards.code, `${SELF_ERASING} a(); b(); c();`);

    const backwards = await runPass([expandSequencesPass, unwrapDiscardedArgumentsPass], source, {
      performance: { maxIterations: 1 },
    });
    expect(normalize(backwards.code)).toContain('a(),b(),c();');
  });

  it('preserves argument order and every side effect', async () => {
    const { code } = await flatten(`${SELF_ERASING} w(a[i++] = 1, a[i++] = 2, log(i));`);
    expectEquivalent(code, `${SELF_ERASING} a[i++] = 1; a[i++] = 2; log(i);`);
  });

  it('keeps a function expression argument intact', async () => {
    const { code } = await flatten('function w() {} w(on(function () { return 1; }), b());');
    expectEquivalent(code, 'function w() {} on(function () { return 1; }); b();');
  });

  it('replaces a one-argument call with the argument, not a one-operand sequence', async () => {
    const { code } = await unwrap('function w() {} w(send(x));');
    expectEquivalent(code, 'function w() {} send(x);');
  });

  it('counts every argument it moves, not every call it rewrites', async () => {
    // 13,906 arguments hide behind 1,753 calls in the fixture, and the report
    // is meant to describe the work rather than the syntax.
    const { changes } = await unwrap('function w() {} w(a(), b(), c());');
    expect(changes).toBe(3);
  });

  it('reports the wrapper through the existing proxy-functions detection', async () => {
    const { ctx } = await unwrap('function w() {} w(a(), b());');
    const detection = ctx.detections.find((d) => d.evidence === 'argument-discarding wrapper');
    expect(detection?.kind).toBe('proxy-functions');
    expect(detection?.count).toBe(1);
  });

  it('is idempotent', async () => {
    await expectIdempotent(unwrapDiscardedArgumentsPass, `${SELF_ERASING} w(a(), b());`);
    await expectIdempotent(unwrapDiscardedArgumentsPass, 'function w() {} w(a());');
    await expectIdempotent(unwrapDiscardedArgumentsPass, 'function w() {} w();');
  });
});

// ---------------------------------------------------------------------------
// Zero-argument calls
// ---------------------------------------------------------------------------

describe('simplify.discard-wrappers: calls with no arguments', () => {
  it('removes the statement outright', async () => {
    const { code } = await unwrap('function w() {} w(); after();');
    expectEquivalent(code, 'function w() {} after();');
  });

  it('leaves an empty statement where there is no statement list to shrink', async () => {
    // `path.remove()` on a bare loop or `if` body either throws or leaves a
    // malformed parent, and an empty statement is the only equivalent form.
    const { code } = await unwrap('function w() {} if (c) w();');
    expectEquivalent(code, 'function w() {} if (c) ;');
  });

  it('keeps a dangling else attached', async () => {
    const { code } = await unwrap('function w() {} if (c) w(); else g();');
    assertParses(code);
    expect(normalize(code)).toContain('else g();');
  });
});

// ---------------------------------------------------------------------------
// Directive and printing hygiene
// ---------------------------------------------------------------------------

describe('simplify.discard-wrappers: directives and printing', () => {
  it('refuses to turn a discarded string into a directive', async () => {
    // `'use strict';` at the head of a body switches the whole function into
    // strict mode; the call it replaced did nothing at all.
    const { code } = await unwrap("function w() {} function f() { w('use strict'); }");
    expect(normalize(code)).toContain("void 'use strict';");
  });

  it('leaves a harmless lone string as itself', async () => {
    const { code } = await unwrap("function w() {} function f() { w('anything else'); }");
    expect(normalize(code)).toContain("'anything else';");
    expect(normalize(code)).not.toContain('void');
  });

  it('prints a statement-leading object or function argument parseably', async () => {
    // Statement-start parenthesisation is `@babel/generator` behaviour this pass
    // depends on, not a guarantee it makes; pinning it here means a generator
    // change surfaces as a failure rather than as unparseable output.
    const object = await unwrap('function w() {} w({ a: 1 }, b());');
    assertParses(object.code);
    const fn = await unwrap('function w() {} w(function () {}, b());');
    assertParses(fn.code);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('simplify.discard-wrappers: refusals', () => {
  it('refuses a body that reads arguments', async () => {
    // Zero parameters and every argument still observed. The single most
    // dangerous near-miss of the whole shape.
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      'function w() { send(arguments); } w(a(), b());',
    );
  });

  it('refuses arguments read from an arrow nested in the body', async () => {
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      'function w() { queue(() => send(arguments)); } w(a(), b());',
    );
  });

  it('refuses a self-reassignment whose replacement takes a parameter', async () => {
    // The first call discards and every later one does not, and call order is
    // not something this analysis knows.
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      'function w() { w = function (a) { log(a); }; } w(a(), b());',
    );
  });

  it('refuses a body that does anything other than erase itself', async () => {
    await expectNoChange(unwrapDiscardedArgumentsPass, 'function w() { hits++; } w(a(), b());');
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      'function w() { other = function () {}; } w(a(), b());',
    );
  });

  it('refuses a wrapper used as the right operand of `in`', async () => {
    // The exact shape two of the fixture's wrappers have: a perfect body match
    // whose every reference is an opaque predicate reading the function as a
    // value. Deleting or bypassing it would turn the predicate into a throw.
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      "function w() {} if ('x' in w) { hit(); } w(a(), b());",
    );
  });

  it('refuses every reference that is not a direct call', async () => {
    const shapes = [
      'queue(w);',
      'w.call(o, a());',
      'w.apply(o, args);',
      'w.bind(o);',
      'new w(a());',
      'w?.(a());',
      'w`x`;',
      'var alias = w;',
      'log(typeof w);',
    ];
    for (const shape of shapes) {
      await expectNoChange(unwrapDiscardedArgumentsPass, `function w() {} ${shape} w(a(), b());`);
    }
  });

  it('refuses a spread argument', async () => {
    // `(...xs)` does not parse, and dropping the spread would skip the whole
    // iterator protocol the call runs on `xs`.
    await expectNoChange(unwrapDiscardedArgumentsPass, 'function w() {} w(...xs);');
    await expectNoChange(unwrapDiscardedArgumentsPass, 'function w() {} w(a(), ...xs);');
  });

  it('refuses a call in value position', async () => {
    const { code } = await unwrap('function w() {} w(a(), b()); x = w(c(), d());');
    const flat = normalize(code);
    expect(flat).toContain('x = w(c(),d());');
    expect(flat).not.toContain('x = c(),d();');
  });

  it('refuses inside a with statement', async () => {
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      'function w() {} with (o) { w(a(), b()); }',
      { language: 'js' },
    );
  });

  it('refuses an Annex B block-level declaration', async () => {
    // The hoisted `var` holds `undefined` until control reaches the block, so a
    // call is not guaranteed to reach a function at all.
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      'function outer() { if (c) { function w() {} w(a(), b()); } }',
    );
  });

  it('refuses a wrapper that is not a function declaration', async () => {
    await expectNoChange(unwrapDiscardedArgumentsPass, 'var w = function () {}; w(a(), b());');
    await expectNoChange(unwrapDiscardedArgumentsPass, 'let w = () => {}; w(a(), b());');
  });

  it('refuses an async or generator wrapper', async () => {
    await expectNoChange(unwrapDiscardedArgumentsPass, 'async function w() {} w(a(), b());');
    await expectNoChange(unwrapDiscardedArgumentsPass, 'function* w() {} w(a(), b());');
  });

  it('refuses a binding with a third writer', async () => {
    await expectNoChange(
      unwrapDiscardedArgumentsPass,
      `${SELF_ERASING} w = g; w(a(), b());`,
    );
  });
});

// ---------------------------------------------------------------------------
// Direct eval
// ---------------------------------------------------------------------------

describe('simplify.discard-wrappers: direct eval', () => {
  const SOURCE = 'function w() {} function outer(s) { eval(s); w(a(), b()); } w(c(), d());';

  it('refuses only the call sites a direct eval could have redefined', async () => {
    const { code } = await unwrap(SOURCE);
    const flat = normalize(code);
    // `eval('var w = ...')` injects into `outer`, so the call beneath it may not
    // be reaching this binding at all.
    expect(flat).toContain('w(a(),b());');
    expect(flat).toContain('}c(),d();');
    expect(flat).not.toContain('w(c(),d());');
  });

  it('refuses the whole binding under refuseOnDirectEval', async () => {
    await expectNoChange(unwrapDiscardedArgumentsPass, SOURCE, {
      techniques: { functionUnwrapping: { refuseOnDirectEval: true } },
    });
  });

  // `balanced` and `aggressive` take the other side of that trade, and this is
  // what it costs: `w` is reassigned by the `eval` at run time, so the rewritten
  // call site runs the empty wrapper instead of the replacement. Pinned as a
  // divergence rather than left implicit - the measurement that keeps the flag
  // off there is on `FunctionUnwrappingOptions.refuseOnDirectEval`.
  const DIVERGENT = `function w() {} function host() { eval("w = function (a) { log(a); }"); } host(); w(log('arg'));`;

  it('rewrites it at balanced and aggressive, which is a divergence the flag exists to buy off', async () => {
    for (const preset of ['balanced', 'aggressive'] as const) {
      const { code } = await runPass(unwrapDiscardedArgumentsPass, DIVERGENT, { preset });
      expect(normalize(code)).toContain("host();log('arg');");
    }
  });

  it('says so: the run carries a warning naming the count and the option', async () => {
    // A risk a preset takes on the file's behalf is one the run has to state;
    // without this the only record of it was the option's doc comment.
    const { ctx } = await runPass(unwrapDiscardedArgumentsPass, DIVERGENT, { preset: 'balanced' });
    const warning = ctx.diagnostics.find((d) => d.severity === 'warning' && /direct eval/.test(d.message));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('1 argument-discarding wrapper ');
    expect(warning!.message).toContain('refuseOnDirectEval');
  });

  it('does not warn when no eval can reach the wrapper', async () => {
    const { ctx } = await runPass(
      unwrapDiscardedArgumentsPass,
      'function outer(s) { eval(s); } function f() { function w() {} w(a(), b()); }',
      { preset: 'balanced' },
    );
    expect(ctx.diagnostics.some((d) => /direct eval/.test(d.message))).toBe(false);
  });

  it('refuses at conservative, which promised identical output', async () => {
    // The technique is off in that preset, so this is the caller who turned it
    // on there - and was promised provability when they picked the preset.
    const { code } = await runPass(unwrapDiscardedArgumentsPass, DIVERGENT, {
      preset: 'conservative',
      techniques: { functionUnwrapping: true },
    });
    expect(normalize(code)).toContain("host();w(log('arg'));");
  });

  it('is unaffected by an eval that cannot see the binding', async () => {
    const { code } = await unwrap(
      'function outer(s) { eval(s); } function f() { function w() {} w(a(), b()); }',
    );
    expect(normalize(code)).toContain('function f(){function w(){}a(),b();}');
  });
});

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

describe('simplify.discard-wrappers: the declaration', () => {
  it('leaves the declaration standing, and lets clean.unused retire it', async () => {
    // Rewriting is safe with the declaration in place; deleting it is the step
    // that breaks `eval('typeof w')` or a reference nobody modelled.
    const unwrapped = await flatten('function w() {} w(a(), b());');
    expect(unwrapped.code).toContain('function w()');

    const cleaned = await runPass(removeUnusedPass, unwrapped.code, { sourceType: 'module' });
    expect(cleaned.code).not.toContain('function w()');
    assertParses(cleaned.code);
  });
});
