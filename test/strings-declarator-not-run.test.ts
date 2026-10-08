import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * A decoder reached through a name that does not yet hold what its
 * declaration gives it.
 *
 * `strings.inline` resolves a call site through a chain of aliases and
 * wrappers to a decoder, and `simplify.fold-constants`, `proxy-functions`
 * and `object-maps` learned in the previous round that a chain is only a
 * chain once each declarator on it has RUN: before it a `let` or `const`
 * throws and a `var` holds `undefined`. The string inliner had not. `try {
 * log(S()); } catch (H) { log('early', H.name); } ... const S = () => R(0);`
 * printed `early ReferenceError` and came out printing the table's first
 * entry, at every preset, in the seventh fuzz round's D1 class - the
 * wrapper was a wrapper at every site, including the one that ran first.
 *
 * The proof is the same `holdsDeclaredValue`, asked twice: by the
 * `DecoderIndex` of every link it follows - the read of the decoder inside a
 * wrapper's body, the read of the initialiser at an alias - and by the
 * inliner of the site's own read of the chain's first name. Every case runs
 * input and output in a fresh realm with only `log` and compares the
 * traces. The controls at the end pin what the proof must still accept: a
 * call after the declarator, and reads inside hoisted functions of an
 * expression that is itself past the table, however deep the calls between
 * them go - the shape of every real single-file build.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}`);
  }
  return trace.join(', ');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

/** A self-replacing accessor and a decoder with a plain index, as obfuscator.io writes them. */
const DECODER = `
function R(i) { const M = q(); return M[i]; }
function q() { const K = ['CamelCase', 'b', 'c']; q = function () { return K; }; return q(); }`;

async function expectSameBehaviour(source: string, expected: string): Promise<DeobfuscateResult[]> {
  const before = execute(source);
  expect(before, 'the fixture itself must produce the trace it claims').toBe(expected);
  const results: DeobfuscateResult[] = [];
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { preset });
    const after = execute(result.code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
      );
    }
    results.push(result);
  }
  return results;
}

function changesOf(result: DeobfuscateResult, pass: string): number {
  return result.metadata.passes.find((p) => p.id === pass)?.changes ?? 0;
}

/** The balanced output with its names left alone, so a shape can be asserted by name. */
async function shapeOf(source: string): Promise<string> {
  const result = await deobfuscate(source, { preset: 'balanced', techniques: { variableRenaming: false } });
  return result.code;
}

// ---------------------------------------------------------------------------
// A wrapper called before its declarator has run
// ---------------------------------------------------------------------------

describe('a wrapper called before its declarator has run is not inlined', () => {
  it('const arrow, call in the dead zone', async () => {
    const results = await expectSameBehaviour(
      `try { log(S()); } catch (H) { log('early', H.name); }${DECODER}
const S = () => R(0);
log(S(), R(1), R(2));`,
      'early ReferenceError, CamelCase b c',
    );
    // The refusal costs that one site, not the table: the body and the later
    // sites are decoded and the machinery goes.
    for (const result of results) {
      expect(result.code).toContain("'CamelCase', 'b', 'c'");
      expect(result.code).not.toContain('function q');
      expect(changesOf(result, 'strings.inline')).toBe(4);
    }
  });

  it('var arrow, call before the assignment', async () => {
    await expectSameBehaviour(
      `try { log(S()); } catch (H) { log('early', H.name); }${DECODER}
var S = () => R(0);
log(S(), R(1), R(2));`,
      'early TypeError, CamelCase b c',
    );
  });

  it('let function expression, call in the dead zone', async () => {
    await expectSameBehaviour(
      `try { log(S()); } catch (H) { log('early', H.name); }${DECODER}
let S = function () { return R(0); };
log(S(), R(1), R(2));`,
      'early ReferenceError, CamelCase b c',
    );
  });

  it('the same inside a block', async () => {
    await expectSameBehaviour(
      `{ try { log(S()); } catch (H) { log('early', H.name); } const S = () => R(0); log(S(), R(1), R(2)); }${DECODER}`,
      'early ReferenceError, CamelCase b c',
    );
  });

  it('the call inside a hoisted function whose first call precedes the declaration', async () => {
    await expectSameBehaviour(
      `function g() { try { return S(); } catch (H) { return H.name; } }
log(g());${DECODER}
const S = () => R(0);
log(g(), R(1), R(2));`,
      'ReferenceError, CamelCase b c',
    );
  });

  it('a wrapper with an argument', async () => {
    const source = `try { log(S(0)); } catch (H) { log('early', H.name); }${DECODER}
const S = (a) => R(a);
log(S(0), R(1), R(2));`;
    await expectSameBehaviour(source, 'early ReferenceError, CamelCase b c');
    // The early site still reads the decoder through the wrapper's body, so
    // the machinery has to stay for it.
    const shape = await shapeOf(source);
    expect(shape).toContain('log(S(0))');
    expect(shape).toContain('return M[i]');
    expect(shape).toContain("log('CamelCase', 'b', 'c')");
  });
});

// ---------------------------------------------------------------------------
// An alias whose own read of the decoder has not run
// ---------------------------------------------------------------------------

describe('an alias declared ahead of what it aliases is not a decoder', () => {
  it('program-level var alias of a var alias, called between the two', async () => {
    // Discovery lists `b` as an alias by name from the `var b = a` link; the
    // read of `a` in it ran with `a` still `undefined`, so `b` is too.
    await expectSameBehaviour(
      `var b = a;
try { log(b(0)); } catch (H) { log('early', H.name); }
var a = R;
log(a(1), R(2));${DECODER}`,
      'early TypeError, b c',
    );
  });
});

// ---------------------------------------------------------------------------
// Controls: what the proof must still accept
// ---------------------------------------------------------------------------

describe('a call after the declarator is still inlined', () => {
  it('const arrow wrapper, every site after it', async () => {
    const results = await expectSameBehaviour(
      `${DECODER}
const S = () => R(0);
log(S(), R(1), R(2));
try { log(S()); } catch (H) { log('late', H.name); }`,
      'CamelCase b c, CamelCase',
    );
    for (const result of results) {
      expect(result.code).toContain("log('CamelCase', 'b', 'c')");
      expect(result.code).not.toContain('function q');
    }
  });

  it('reads inside hoisted functions of an expression that is past the table, eight calls deep', async () => {
    // Deeper than the climb follows callers, and the callers are not what
    // places these reads: `h` is declared in the expression's own scope, so
    // nothing can call it before the expression runs, and the expression
    // is after the table. Every real single-file build is this shape.
    const results = await expectSameBehaviour(
      `var T = ['alpha', 'beta', 'gamma', 'delta'];
!function () {
  function a() { return b(); }
  function b() { return c(); }
  function c() { return d(); }
  function d() { return e(); }
  function e() { return f(); }
  function f() { return g(); }
  function g() { return h(); }
  function h() { return T[0] + T[1]; }
  log(a(), T[2]);
}();`,
      'alphabeta gamma',
    );
    for (const result of results) {
      expect(result.code).toContain("'alphabeta'");
      expect(result.code).not.toContain('T[0]');
    }
  });

  it('a hoisted function in the table\'s own scope is still placed by its callers', async () => {
    // `f` is declared beside the table, so a call from ahead of it is
    // possible and has to be ruled out; here it is, and the read is decoded.
    const results = await expectSameBehaviour(
      `var T = ['alpha', 'beta', 'gamma', 'delta'];
function f() { return T[1]; }
log(f(), T[3]);`,
      'beta delta',
    );
    for (const result of results) expect(result.code).toContain("'beta'");
  });

  it('and refused when one of them runs first', async () => {
    const source = `function f() { try { return T[1]; } catch (H) { return H.name; } }
log(f());
var T = ['alpha', 'beta', 'gamma', 'delta'];
log(f(), T[3]);`;
    await expectSameBehaviour(source, 'TypeError, beta delta');
    expect(await shapeOf(source)).toContain('return T[1]');
  });
});
