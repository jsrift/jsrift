import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import { findSliceTrap, recogniseNativeDecoder, unmodelledLoop } from '../src/analysis/evaluator/native.js';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A decoder's slice is machinery the caller prunes once the strings are
 * inlined, and what the tiers vouch for is only what they ran. Three ways a
 * slice the program never runs past - or a slice a tier never ran - had its
 * hang or throw pruned with it, each found by the round-eleven fuzz as a
 * wrong rewrite that parsed and ran:
 *
 *  - the rotation IIFE is a trap. `while (!![]) { try {} catch (g) {} }`
 *    beside a real decoder ran the interpreter out of budget, the native
 *    "index lookup" match stood unchecked at balanced, and `"fn:nm"` was
 *    printed where the input never terminates; `throw new Error('tamper')`
 *    in the IIFE of a decoder nothing references was pruned at every preset.
 *  - the slice holds a loop the native tier never read. A rotation proxied
 *    through `w.call` and `C[w.push](C[w.shift]())` is no rotation to the
 *    recognisers, the loop is where the interpreter's budget went, and the
 *    unrotated entry stood "unchecked" at balanced.
 *  - a decoder nothing references was accepted on nothing. With no call
 *    site to prove a tier on, the interpreter running every source to
 *    completion is the only thing that vouches for the machinery.
 *
 * Every shape here is executed: the input and each preset's output run in a
 * realm holding nothing but `log`, under a budget that stands in for forever,
 * and the traces must match.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function execute(code: string, timeout = 2_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

async function expectSameBehaviourEverywhere(
  source: string,
  options: DeobfuscateOptions = {},
  timeout?: number,
): Promise<Record<(typeof PRESETS)[number], { code: string; diagnostics: string[] }>> {
  const before = execute(source, timeout);
  const outputs = {} as Record<(typeof PRESETS)[number], { code: string; diagnostics: string[] }>;
  for (const preset of PRESETS) {
    const result = await deobfuscate(source, { ...options, preset });
    expect(execute(result.code, timeout), preset).toBe(before);
    outputs[preset] = { code: result.code, diagnostics: result.metadata.diagnostics.map((d) => d.message) };
  }
  return outputs;
}

function programPath(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source);
  let found: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  if (!found) throw new Error('no Program path');
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], options: Parameters<typeof resolveConfig>[0] = {}) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
}

/** The realm budget that stands in for a hang: long enough for a decode, short enough to test on. */
const HANG = 300;
const TIMES_OUT = /^THROWN Error: Script execution timed out/;

// ---------------------------------------------------------------------------
// V1: a trap in the slice's own statements
// ---------------------------------------------------------------------------

/** The rotation IIFE reduced to its trap; the decoder itself is sound. */
const TRAPPED_ROTATION = `function a() { var o = ['x0', 'x1', 'x2', 'fn:', 'x4']; a = function () { return o; }; return a(); }
(function (c, d) { var e = c(); while (!![]) { try { } catch (g) { } } }(a, 0x1b8a3));
function classify(c) { var m = { c: 0x12b }, k = b; return k(m.c) + c.name; }
function b(c) { c = c - 296; var e = a(); if (c >= 0) return e[c]; }
log(classify(function nm() {}));
`;

describe('V1: a slice the program never runs past', () => {
  it('keeps the hang at every preset, and refuses the decoder naming the loop', async () => {
    expect(execute(TRAPPED_ROTATION, HANG)).toMatch(TIMES_OUT);
    const outputs = await expectSameBehaviourEverywhere(TRAPPED_ROTATION, {}, HANG);
    for (const { code, diagnostics } of Object.values(outputs)) {
      expect(code).not.toMatch(/['"]fn:['"]\s*\+/);
      // The loop is quoted as the round sees it: `!![]` as written, or the
      // `true` an earlier pass folded it to.
      expect(diagnostics).toContainEqual(
        expect.stringMatching(
          /Refusing to evaluate b: its slice runs into a loop with no exit \(`while \((!!\[\]|true)\) ...`, in the statement at line 2\)/,
        ),
      );
    }
  }, 60_000);

  it('is refused before any tier, whichever spelling the decoder’s return takes', () => {
    const returns = {
      'under an if': 'if (c >= 0) return e[c];',
      'in a try': 'try { return e[c]; } finally { }',
      bare: 'return e[c];',
    };
    for (const [what, spelling] of Object.entries(returns)) {
      const source = TRAPPED_ROTATION.replace('if (c >= 0) return e[c];', spelling);
      const { decoder, notes } = build(source, ['b', 'a'], { preset: 'balanced' });
      expect(decoder, what).toBeUndefined();
      expect(notes.map((note) => note.message), what).toContainEqual(
        expect.stringContaining('its slice runs into a loop with no exit'),
      );
      // The tiers were never asked.
      expect(notes.some((note) => /^Tier /.test(note.message)), what).toBe(false);
    }
  });

  it('finds the trap in every spelling of a slice statement', () => {
    const traps: Record<string, string> = {
      'an IIFE with a loop that never exits': '(function () { while (!![]) { try {} catch (g) {} } })();',
      'an IIFE with a do-while trap': '(function () { do {} while (true); })();',
      'an IIFE with a for(;;) trap': '(function () { for (;;) {} })();',
      'an IIFE that throws': "(function () { throw new Error('tamper'); })();",
      'an IIFE that throws from a bare block': "(function () { { throw new Error('tamper'); } })();",
      'a negated IIFE': '!function () { while (1) {} }();',
      'an IIFE in a sequence': '(0, function () { while (true) {} }());',
      'an IIFE in a declarator': 'var r = (function () { while (true) {} })();',
      'a trap inside a try with a catch': '(function () { try { while (true) {} } catch (e) {} })();',
      'a trap in a finally': '(function () { try { var x = 1; } finally { for (;;) {} } })();',
      'a bare loop statement': 'while (!![]) {}',
      'a bare throw': "throw new Error('tamper');",
      'a throw in a try with no catch': "(function () { try { throw new Error('t'); } finally {} })();",
    };
    for (const [what, statement] of Object.entries(traps)) {
      const found = findSliceTrap(programPath(statement).node.body);
      expect(found, what).toBeDefined();
    }
    const clear: Record<string, string> = {
      'the obfuscator.io rotation loop, which carries a break':
        '(function (c, d) { var e = c(); while (!![]) { try { if (1) break; else e.push(e.shift()); } catch (g) { e.push(e.shift()); } } })(a, 3);',
      'a loop with a return': '(function () { while (true) { return 1; } })();',
      'a throw inside a try with a catch': "(function () { try { throw new Error('t'); } catch (e) {} })();",
      'a conditional throw': "(function () { if (Math.random() > 2) throw new Error('t'); })();",
      'a loop whose condition can become false': '(function () { var i = 0; while (i < 3) i++; })();',
      'a function declaration holding a trap, never called here': 'function f() { while (true) {} }',
      'a trap after a return': '(function () { return 1; while (true) {} })();',
    };
    for (const [what, statement] of Object.entries(clear)) {
      expect(findSliceTrap(programPath(statement).node.body), what).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// V2: a decoder nothing references
// ---------------------------------------------------------------------------

const UNREFERENCED = (iife: string): string => `function a() { var o = ['x0', 'x1', 'fn:']; a = function () { return o; }; return a(); }
(function (c, d) { var e = c(); ${iife} }(a, 0x1b8a3));
function b(c) { c = c - 296; var e = a(); return e[c]; }
log('after');
`;

describe('V2: a decoder nothing references', () => {
  it('keeps the hang of its machinery at every preset', async () => {
    const source = UNREFERENCED('while (!![]) { try { } catch (g) { } }');
    expect(execute(source, HANG)).toMatch(TIMES_OUT);
    const outputs = await expectSameBehaviourEverywhere(source, {}, HANG);
    for (const { code } of Object.values(outputs)) expect(code).toContain('while (');
  }, 60_000);

  it('keeps the throw of its machinery at every preset', async () => {
    const source = UNREFERENCED("throw new Error('tamper');");
    expect(execute(source)).toBe('THROWN Error: tamper');
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const { code, diagnostics } of Object.values(outputs)) {
      expect(code).toContain("throw new Error('tamper')");
      expect(diagnostics).toContainEqual(expect.stringContaining('its slice runs into an unconditional throw'));
    }
  }, 60_000);

  it('is refused when the interpreter cannot run its sources, whatever the reason', async () => {
    // A throw the walk cannot see - conditional on a value - and a slice the
    // interpreter refuses outright: nothing vouches for either.
    const conditional = UNREFERENCED("if (e.length > 1) throw new Error('tamper');");
    expect(execute(conditional)).toBe('THROWN Error: tamper');
    const refused = build(conditional, ['b', 'a']);
    expect(refused.decoder).toBeUndefined();
    expect(refused.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('Refusing b: nothing references it, so no call site proves a tier, and the interpreter refused'),
    );
    await expectSameBehaviourEverywhere(conditional);

    const heavy = UNREFERENCED('var s = 0; for (var i = 0; i < 60000000; i++) s = (s + i) % 7; d = s;');
    const budget = build(heavy, ['b', 'a'], { sandbox: { maxSteps: 100_000 } });
    expect(budget.decoder).toBeUndefined();
    // The native tier read the decoder; what refused it is the machinery nothing ran.
    expect(budget.notes.some((note) => note.message.startsWith('Tier native did not recognise'))).toBe(false);
    expect(budget.notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('the interpreter ran out of budget running its machinery'),
    );
  }, 60_000);

  it('is refused when only the native tier is enabled, since nothing else vouches for the sources', () => {
    const source = `var _0xt = ['alpha', 'beta', 'gamma'];\nfunction _0xd(_0xi) { _0xi = _0xi - 0x1; return _0xt[_0xi]; }\nlog('nothing calls it');`;
    const { decoder, notes } = build(source, ['_0xd', '_0xt'], {
      techniques: { stringDecoding: { tiers: ['native'] } },
    });
    expect(decoder).toBeUndefined();
    expect(notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('only the interpreter tier, which is not enabled, could vouch for its machinery'),
    );
  });

  it('keeps the acceptance when the interpreter runs every source to completion', () => {
    const source = `var _0xt = ['alpha', 'beta', 'gamma'];\nfunction _0xd(_0xi) { _0xi = _0xi - 0x1; return _0xt[_0xi]; }\nlog('nothing calls it');`;
    const { decoder, notes } = build(source, ['_0xd', '_0xt']);
    expect(decoder?.decode([2])).toBe('beta');
    expect(notes.some((note) => note.message.includes('Refusing'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V4: a loop the native tier did not read
// ---------------------------------------------------------------------------

/** The rotation proxied out of the recognisers' sight, with a loop that outruns the interpreter. */
const PROXIED_HEAVY_ROTATION = `function a() {
  var z = ['1', '2', '3', 'fn:'];
  a = function () { return z; };
  return a();
}
function b(P) {
  P = P - 296;
  var U = a(), w = U[P];
  return w;
}
var w = { push: 'push', shift: 'shift', call: function (q) { return q(); }, apply: function (q, M) { return q(M); } };
(function (z, U) {
  var k = {};
  k.c = 0x128;
  var X = k, O = b, C = w.call(z), n = 0;
  while (true) {
    try {
      var s = 0; for (var i = 0; i < 6000000; i++) s = (s + i * 7) % 1000003;
      var p = parseInt(w.apply(O, X.c)) / 1 + (s - s);
      if (p === U) break; else C[w.push](C[w.shift]());
    } catch (q) {
      C[w.push](C[w.shift]());
    }
  }
})(a, 3);
function classify(z) { return b(0x12b) + z.name; }
log(classify(function nm() {}));
`;

describe('V4: an unchecked native match over a loop the recogniser did not read', () => {
  it('prints what the program prints at every preset, refusing rather than standing unchecked', async () => {
    expect(execute(PROXIED_HEAVY_ROTATION, 10_000)).toBe('"2nm"');
    const outputs = await expectSameBehaviourEverywhere(PROXIED_HEAVY_ROTATION, {}, 10_000);
    for (const preset of PRESETS) {
      const { code, diagnostics } = outputs[preset];
      expect(code, preset).not.toMatch(/['"]fn:['"]\s*\+/);
      // The loop named is the first the recogniser did not read: the
      // proxied `while (true)` as written, or - once a round has inlined
      // the proxy map and the rotation reads - the busy `for` inside it.
      expect(diagnostics, preset).toContainEqual(
        expect.stringMatching(
          /the slice holds a loop the recogniser did not read \(`(while \(true\)|for \(... ...;...\)) ...`, in the statement at line 12\)/,
        ),
      );
      expect(diagnostics, preset).not.toContainEqual(expect.stringContaining('stands unchecked'));
    }
  }, 120_000);

  it('lets a match stand only over loops the native tier modelled', () => {
    // obfuscator.io's own shape: the rotation loop is the one the checksum
    // was solved over, and the decoder body holds every other loop.
    const modelled = `function a() { var z = ['1', '2', '3', 'fn:']; a = function () { return z; }; return a(); }
function b(P) { P = P - 296; var U = a(), w = U[P]; for (var i = 0; i < 1; i++) {} return w; }
(function (z, U) { var C = z(); while (true) { try { var p = parseInt(b(0x128)) / 1; if (p === U) break; else C.push(C.shift()); } catch (q) { C.push(C.shift()); } } })(a, 3);
log(b(0x12b));`;
    const program = programPath(modelled);
    const slice = sliceForEvaluation(program, ['b', 'a']);
    const decoder = recogniseNativeDecoder(slice, ['b', 'a']);
    expect(decoder?.rotation).toBe(2);
    expect(unmodelledLoop(slice.statements, decoder!.modelled)).toBeUndefined();

    // A loop nested inside the rotation loop is not the rotation loop, and
    // a loop anywhere else in the slice is nobody's.
    const nested = modelled.replace('try { var p', 'try { for (var j = 0; j < 1; j++) {} var p');
    const nestedSlice = sliceForEvaluation(programPath(nested), ['b', 'a']);
    const nestedDecoder = recogniseNativeDecoder(nestedSlice, ['b', 'a']);
    expect(nestedDecoder).not.toBeNull();
    expect(unmodelledLoop(nestedSlice.statements, nestedDecoder!.modelled)?.type).toBe('ForStatement');

    const beside = modelled.replace("log(b(0x12b));", "var n = 0; while (n < 2) n++;\nlog(b(0x12b));");
    const besideSlice = sliceForEvaluation(programPath(beside), ['b', 'a']);
    const besideDecoder = recogniseNativeDecoder(besideSlice, ['b', 'a']);
    if (besideDecoder) {
      // Only when the slicer took the loop; a loop it left out is not in the slice.
      const loop = unmodelledLoop(besideSlice.statements, besideDecoder.modelled);
      expect(loop === undefined || loop.type === 'WhileStatement').toBe(true);
    }
  });

  it('refuses at conservative too, with the loop named rather than the budget alone', () => {
    const { decoder, notes } = build(PROXIED_HEAVY_ROTATION, ['b', 'a'], { preset: 'conservative' });
    expect(decoder).toBeUndefined();
    const refusal = notes.find((note) => note.message.startsWith('Refusing b: the "index lookup, index offset 296" match'));
    expect(refusal?.message).toContain('the slice holds a loop the recogniser did not read');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// V3, end to end: a plain lookup through a percent decoder
// ---------------------------------------------------------------------------

describe('V3: a plain lookup through decodeURIComponent', () => {
  const plain = `var table = ['%C3%BCn%C3%AF', 'plain', 'other'];\nfunction dec(i) { return decodeURIComponent(table[i]); }\nlog(dec(0), dec(1));`;

  it('is read by the native tier as what it is, and the tiers agree', async () => {
    const { decoder, notes } = build(plain, ['dec', 'table']);
    expect(decoder?.tier).toBe('native');
    expect(decoder?.decode([0])).toBe('ünï');
    expect(notes.some((note) => note.message.includes('recogniser is wrong'))).toBe(false);
    const outputs = await expectSameBehaviourEverywhere(plain);
    for (const { diagnostics } of Object.values(outputs)) {
      expect(diagnostics).not.toContainEqual(expect.stringContaining('disagree'));
    }
  });

  it('never inlines the raw entry beside a rotation loop that outruns the interpreter', async () => {
    const heavy = `function a() {
  var z = ['1', '2', '3', '%C3%BCn%C3%AF', 'plain'];
  a = function () { return z; };
  return a();
}
function b(P) {
  P = P - 296;
  var U = a();
  return decodeURIComponent(U[P]);
}
(function (z, U) {
  var C = z();
  while (true) {
    try {
      var s = 0; for (var i = 0; i < 6000000; i++) s = (s + i * 7) % 1000003;
      var p = parseInt(b(0x128)) / 1 + (s - s);
      if (p === U) break; else C.push(C.shift());
    } catch (q) {
      C.push(C.shift());
    }
  }
})(a, 3);
log(b(0x129), b(0x12a));
`;
    expect(execute(heavy, 10_000)).toBe('"ünï" "plain"');
    const outputs = await expectSameBehaviourEverywhere(heavy, {}, 10_000);
    // The table may stay, refused; the raw entry may not reach the call site.
    for (const { code } of Object.values(outputs)) expect(code).not.toMatch(/log\(\s*['"]%C3%BCn%C3%AF['"]/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V5: a budget spent where the recogniser did not read
// ---------------------------------------------------------------------------

/**
 * A rotation IIFE that recurses without a base case. The input throws a RangeError; the interpreter ran out of frames,
 * which was an `InterpreterLimitError` like the step budget, so the native
 * match stood unchecked at balanced and the crash left with the machinery.
 * Only a step (or clock) budget spent inside a loop the recogniser read may
 * stand; every other limit, and a budget spent in a recursion, a callback or
 * a function the recogniser never opened, is a refusal naming the cause.
 */
const RECURSING_IIFE = (trap: string): string =>
  `function a() { var o = ['x0', 'x1', 'x2', 'fn:', 'x4']; a = function () { return o; }; return a(); }
(function (c, d) { var e = c(); ${trap} }(a, 0x1b8a3));
function classify(c) { return b(0x12b) + c.name; }
function b(c) { c = c - 296; var e = a(); if (c >= 0) return e[c]; }
log(classify(function nm() {}));
`;

/** The rotation the recognisers solve, with `pre` run on every turn of the loop before the checksum. */
const ROTATING = (pre: string, before = ''): string =>
  `function a() { var z = ['1', '2', '3', 'fn:']; a = function () { return z; }; return a(); }
function b(P) { P = P - 296; var U = a(), w = U[P]; return w; }
var cnt = 0;
${before}(function (z, U) { var C = z(); while (true) { try { ${pre} var p = parseInt(b(0x128)) / 1; if (p === U) break; else C.push(C.shift()); } catch (q) { if (q.message === 'boom') throw q; C.push(C.shift()); } } })(a, 3);
function classify(z) { return b(0x12b) + z.name; }
log(classify(function nm() {}));
`;

const RANGE_ERROR = 'THROWN RangeError: Maximum call stack size exceeded';

describe('V5: a budget spent where the recogniser did not read', () => {
  it('keeps the RangeError of a recursion in the rotation IIFE at every preset, and names the limit', async () => {
    const source = RECURSING_IIFE('(function r(n) { return r(n + 1) + 1; })(0);');
    expect(execute(source)).toBe(RANGE_ERROR);
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, ['b', 'a'], { preset });
      expect(decoder, preset).toBeUndefined();
      expect(notes.map((note) => note.message), preset).toContainEqual(
        expect.stringContaining(
          'Refusing b: the "index lookup, index offset 296" match cannot be checked because the interpreter hit a ' +
            'limit evaluating the slice (Interpreter exceeded its call depth limit (256 frames))',
        ),
      );
      expect(notes.some((note) => note.message.includes('stands unchecked')), preset).toBe(false);
    }
    const outputs = await expectSameBehaviourEverywhere(source);
    for (const { code } of Object.values(outputs)) expect(code).not.toMatch(/['"]fn:['"]\s*\+/);
  }, 60_000);

  it('names the limit for every spelling of the recursion', () => {
    const spellings: Record<string, string> = {
      'mutual recursion': 'function p(n) { return q(n + 1) + 1; } function q(n) { return p(n + 1) + 1; } p(0);',
      'recursion through .call': '(function r(n) { return r.call(null, n + 1) + 1; })(0);',
      'recursion through .apply': '(function r(n) { return r.apply(null, [n + 1]) + 1; })(0);',
      'recursion through .bind': '(function r(n) { var s = r.bind(null, n + 1); return s() + 1; })(0);',
      'new of a recursive constructor': 'function C(n) { this.v = new C(n + 1); } new C(0);',
      'a base case an off-by-one never reaches': '(function r(n) { if (n === 0) return 0; return r(n - 2) + 1; })(1001);',
      'an arrow': 'var r = (n) => r(n + 1) + 1; r(0);',
      'a recursion with a loop inside it': '(function r(n) { for (var i = 0; i < 2; i++) {} return r(n + 1) + 1; })(0);',
    };
    for (const [what, trap] of Object.entries(spellings)) {
      const source = RECURSING_IIFE(trap);
      expect(execute(source), what).toBe(RANGE_ERROR);
      const { decoder, notes } = build(source, ['b', 'a'], { preset: 'balanced' });
      expect(decoder, what).toBeUndefined();
      expect(notes.map((note) => note.message), what).toContainEqual(
        expect.stringContaining('hit a limit evaluating the slice (Interpreter exceeded its call depth limit'),
      );
    }
    // In a helper the IIFE calls, and in the accessor: the same limit, the same refusal.
    const helper = `function helper() { (function r(n) { return r(n + 1) + 1; })(0); }\n${RECURSING_IIFE('helper();')}`;
    expect(build(helper, ['b', 'a'], { preset: 'balanced' }).decoder).toBeUndefined();
    const accessor = RECURSING_IIFE('').replace(
      'a = function () { return o; };',
      '(function r(n) { return r(n + 1) + 1; })(0); a = function () { return o; };',
    );
    expect(execute(accessor)).toBe(RANGE_ERROR);
    const { decoder, notes } = build(accessor, ['b', 'a'], { preset: 'balanced' });
    expect(decoder).toBeUndefined();
    expect(notes.map((note) => note.message)).toContainEqual(expect.stringContaining('hit a limit evaluating the slice'));
  });

  it('refuses a getter that recurses, which the interpreter does not model', async () => {
    const source = RECURSING_IIFE('var o = { get x() { return this.x + 1; } }; d = o.x;');
    expect(execute(source)).toBe(RANGE_ERROR);
    const { decoder, notes } = build(source, ['b', 'a'], { preset: 'balanced' });
    expect(decoder).toBeUndefined();
    expect(notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining(
        'the interpreter rejected the slice (Refusing to evaluate: unsupported syntax for the interpreter: ObjectMethod:get)',
      ),
    );
    await expectSameBehaviourEverywhere(source);
  });

  it('refuses a memory limit as a limit, not as a budget', () => {
    // 20 million characters is under V8's limit and over the interpreter's,
    // so the guard that fires is the interpreter's own; the program runs.
    const source = RECURSING_IIFE("var s = 'x'.repeat(2000000).repeat(10); d = s.length;");
    const { decoder, notes } = build(source, ['b', 'a'], { preset: 'balanced' });
    expect(decoder).toBeUndefined();
    expect(notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('hit a limit evaluating the slice (Interpreter produced a string of 20000000 characters'),
    );
    expect(notes.some((note) => note.message.includes('stands unchecked'))).toBe(false);
  });

  it('refuses a step budget spent outside any loop, keeping the hang', async () => {
    const source = RECURSING_IIFE('(function r(n) { return n > 40 ? 0 : r(n + 1) + r(n + 1); })(0);');
    expect(execute(source, HANG)).toMatch(TIMES_OUT);
    const { decoder, notes } = build(source, ['b', 'a'], { preset: 'balanced', sandbox: { maxSteps: 30_000 } });
    expect(decoder).toBeUndefined();
    expect(notes.map((note) => note.message)).toContainEqual(
      expect.stringContaining('the budget ran out outside any loop; only a loop the recogniser read may spend it'),
    );
    const outputs = await expectSameBehaviourEverywhere(source, { sandbox: { maxSteps: 30_000 } }, HANG);
    for (const { code } of Object.values(outputs)) expect(code).not.toMatch(/['"]fn:['"]\s*\+/);
  }, 60_000);

  it('refuses a step budget spent in a recursion, a callback or an unread call under the loop it read', async () => {
    const shapes: Record<string, { source: string; cause: string; prints: RegExp }> = {
      'a recursion on every turn of the rotation loop': {
        source: ROTATING(
          "(function r(n) { if (++cnt > 30000) throw new Error('nope'); return n > 12 ? 0 : r(n + 1) + r(n + 1); })(0);",
        ),
        cause: 'in a recursion through `function r(...) ...`, in the statement at line 4',
        prints: TIMES_OUT,
      },
      'a callback a builtin invokes on every turn': {
        source: ROTATING("new Array(5000).fill(0).forEach(function (x) { if (++cnt > 12000) throw new Error('boom'); });"),
        cause: 'in a callback a builtin invoked, `function (...) ...`, in the statement at line 4',
        prints: /^THROWN Error: boom$/,
      },
      'a straight-line helper the recogniser never opened': {
        source: ROTATING(
          'heavy();',
          "function heavy() { var s = 'x'.repeat(20000).length; if (++cnt > 2) throw new Error('boom'); return s; }\n",
        ),
        cause: 'in a call the recogniser did not read, to `function heavy() ...`, in the statement at line 4',
        prints: /^THROWN Error: boom$/,
      },
      'a recursive constructor on every turn': {
        source: ROTATING(
          'new K(0);',
          "function K(n) { if (++cnt > 30000) throw new Error('nope'); this.v = n > 12 ? 0 : new K(n + 1).v + new K(n + 1).v; }\n",
        ),
        cause: 'in a recursion through `function K(...) ...`, in the statement at line 4',
        prints: TIMES_OUT,
      },
    };
    for (const [what, { source, cause, prints }] of Object.entries(shapes)) {
      expect(execute(source, HANG), what).toMatch(prints);
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['b', 'a'], { preset, sandbox: { maxSteps: 30_000 } });
        expect(decoder, `${what} at ${preset}`).toBeUndefined();
        expect(notes.map((note) => note.message), `${what} at ${preset}`).toContainEqual(
          expect.stringContaining(`the budget ran out ${cause}; only a loop the recogniser read may spend it`),
        );
        expect(notes.some((note) => note.message.includes('stands unchecked')), `${what} at ${preset}`).toBe(false);
      }
      const outputs = await expectSameBehaviourEverywhere(source, { sandbox: { maxSteps: 30_000 } }, HANG);
      for (const { code } of Object.values(outputs)) expect(code, what).not.toMatch(/['"]fn:['"]\s*\+/);
    }
  }, 120_000);

  it('lets the match stand over the loop it read, and over the accessor and forwarders the loop calls', () => {
    // The budget spent by the rotation loop calling the decoder, the decoder
    // calling the accessor, and the accessor its replacement, is the shape's
    // - that is obfuscated2.js, and the stand at balanced is kept.
    const plain = ROTATING('');
    expect(execute(plain)).toBe('"2nm"');
    const stood = build(plain, ['b', 'a'], { preset: 'balanced', sandbox: { maxSteps: 100 } });
    expect(stood.decoder?.tier).toBe('native');
    expect(stood.decoder?.decode([0x12b])).toBe('2');
    expect(stood.notes.map((note) => note.message)).toContainEqual(expect.stringContaining('stands unchecked'));
    // A recursion that completed before the loop began is not where the budget went.
    const completed = ROTATING('', '(function r(n) { return n > 5 ? 0 : r(n + 1) + 1; })(0);\n');
    expect(execute(completed)).toBe('"2nm"');
    const still = build(completed, ['b', 'a'], { preset: 'balanced', sandbox: { maxSteps: 100 } });
    expect(still.decoder?.tier).toBe('native');
    expect(still.notes.map((note) => note.message)).toContainEqual(expect.stringContaining('stands unchecked'));
    // Through a forwarder the checksum calls, as obfuscator.io's wrappers do.
    const forwarded = ROTATING('')
      .replace('var C = z();', 'var C = z(); function f(x) { return b(x - 0x10); }')
      .replace('var p = parseInt(b(0x128)) / 1;', 'var p = parseInt(f(0x138)) / 1;');
    expect(execute(forwarded)).toBe('"2nm"');
    const viaForwarder = build(forwarded, ['b', 'a'], { preset: 'balanced', sandbox: { maxSteps: 100 } });
    expect(viaForwarder.decoder?.tier).toBe('native');
    expect(viaForwarder.notes.map((note) => note.message)).toContainEqual(expect.stringContaining('stands unchecked'));
    // And conservative still refuses the stand itself, as before.
    expect(build(plain, ['b', 'a'], { preset: 'conservative', sandbox: { maxSteps: 100 } }).decoder).toBeUndefined();
  });
});
