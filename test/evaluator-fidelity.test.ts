import vm from 'node:vm';
import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import { createInterpreter, InterpreterRefusal } from '../src/analysis/evaluator/interpreter.js';
import { recogniseNativeDecoder } from '../src/analysis/evaluator/native.js';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ??
  _generate) as typeof _generate;

/**
 * The evaluation tiers telling the truth.
 *
 * Every case in the first half is behavioural: the input runs, the output runs,
 * and the two traces must match. That is the only assertion that can tell a
 * correct refusal from a plausible wrong string, and every case here started as
 * a wrong string that parsed, ran and reported `verified: true` - a decoder the
 * native tier read past a later declaration of the same name, a `throw` it did
 * not see inside a block, a table rotated behind a TypeScript `as`, and a
 * builtin table that answered `localeCompare`, `normalize('NFD')`, a user
 * `toString`, `new Date()` and `Math.random()` with values the program never
 * computes. The second half pins each builtin either to V8's answer, computed
 * here by V8 itself, or to a refusal.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`;
  return String(value);
}

/** Run in a realm holding nothing but `log`, and record everything observable. */
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

interface Behaviour {
  code: string;
  diagnostics: string[];
}

/** Deobfuscate and prove the output does what the input does. */
async function expectSameBehaviour(
  source: string,
  options: DeobfuscateOptions = {},
  timeout?: number,
): Promise<Behaviour> {
  const result = await deobfuscate(source, { preset: 'balanced', ...options });
  const strip = options.language === 'ts';
  const before = execute(strip ? stripTypes(source) : source, timeout);
  const after = execute(strip ? stripTypes(result.code) : result.code, timeout);
  expect(after).toBe(before);
  return {
    code: result.code,
    diagnostics: result.metadata.diagnostics.map((d) => `${d.severity} ${d.message}`),
  };
}

/** Erase TypeScript syntax so `vm` can run it; the fixtures use no TS-only declarations. */
function stripTypes(code: string): string {
  const ast = parse(code, { sourceType: 'script', plugins: ['typescript'] });
  traverse(ast, {
    enter(path) {
      const node = path.node as t.Node & {
        typeAnnotation?: t.Node | null;
        returnType?: t.Node | null;
        typeParameters?: t.Node | null;
        optional?: boolean | null;
      };
      if (
        t.isTSAsExpression(node) ||
        t.isTSNonNullExpression(node) ||
        t.isTSTypeAssertion(node) ||
        t.isTSSatisfiesExpression(node) ||
        t.isTSInstantiationExpression(node)
      ) {
        path.replaceWith(node.expression);
        return;
      }
      if (node.typeAnnotation) node.typeAnnotation = null;
      if (node.returnType) node.returnType = null;
      if (node.typeParameters) node.typeParameters = null;
      if (t.isIdentifier(node) && node.optional) node.optional = false;
    },
  });
  return generate(ast).code;
}

function programPath(source: string, language?: 'ts'): NodePath<t.Program> {
  const { ast } = parseSource(source, { language });
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

function recognise(source: string, roots: string[], language?: 'ts') {
  const program = programPath(source, language);
  return recogniseNativeDecoder(sliceForEvaluation(program, roots), roots);
}

function build(
  source: string,
  roots: string[],
  options: Parameters<typeof resolveConfig>[0] = {},
  samples?: readonly (readonly (string | number)[])[],
) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
    ...(samples ? { samples } : {}),
  });
  return { decoder, notes };
}

/** Run a function body in the interpreter and hand back what it returns. */
function interpret(body: string): unknown {
  const statements = parse(`var __result = (function () {\n${body}\n})();`, {
    sourceType: 'script',
  }).program.body;
  return createInterpreter(statements, {}).read('__result');
}

// ---------------------------------------------------------------------------
// The native tier and hoisting
// ---------------------------------------------------------------------------

describe('a name the slice declares twice', () => {
  // Two independently obfuscated files concatenated, with a hexadecimal name
  // collision: program A's decoder and program B's array thunk are both `_0xdec`.
  // Function hoisting makes the *last* one the only one that ever runs, so
  // `_0xdec(0)` is an array, not 'alpha' - and the native tier used to decode
  // every call site against the declaration the program never calls.
  const COLLISION = `
    function _0xarr1() { return ['alpha', 'beta', 'gamma', 'delta']; }
    function _0xdec(_0xi) { return _0xarr1()[_0xi]; }
    log(typeof _0xdec(0), _0xdec(2).length);
    function _0xdec() { return ['one', 'two', 'three', 'four']; }
    function _0xdec2(_0xj) { return _0xdec()[_0xj]; }
    log(_0xdec2(1), _0xdec2(3));
  `;

  it('is refused by the native tier rather than read in source order', () => {
    expect(recognise(COLLISION, ['_0xdec'])).toBeNull();
  });

  it('leaves the program computing what it computed', async () => {
    const { code } = await expectSameBehaviour(COLLISION);
    expect(execute(code)).toBe('"object" 4\n"two" "four"');
    expect(code).not.toContain("'string'");
  });

  it('refuses a table a later declaration or a reassignment replaces', () => {
    const redeclared = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { return _0xt[_0xi]; }
      var _0xt = ['gamma', 'delta'];
      log(_0xd(0));
    `;
    expect(recognise(redeclared, ['_0xd'])).toBeNull();

    const reassigned = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { return _0xt[_0xi]; }
      _0xt = _0xt.reverse();
      log(_0xd(0));
    `;
    expect(recognise(reassigned, ['_0xd'])).toBeNull();
  });

  it('still follows the self-replacing accessor, which is an assignment inside its own body', () => {
    const decoder = recognise(
      `
        function _0xarr() {
          const _0xd = ['alpha', 'beta'];
          _0xarr = function () { return _0xd; };
          return _0xarr();
        }
        function _0xdec(_0xa) {
          const _0xc = _0xarr();
          _0xdec = function (_0xe) { return _0xc[_0xe]; };
          return _0xdec(_0xa);
        }
        log(_0xdec(0x1));
      `,
      ['_0xdec'],
    );
    expect(decoder?.decode([1])).toBe('beta');
  });
});

describe('a decoder whose return control never reaches', () => {
  it('sees a throw inside a bare block', async () => {
    const source = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { { throw new Error('boom'); } return _0xt[_0xi]; }
      log(_0xd(0), _0xd(1));
    `;
    expect(recognise(source, ['_0xd'])).toBeNull();
    const { code } = await expectSameBehaviour(source);
    expect(execute(code)).toBe('THROWN Error: boom');
  });

  it('sees a do-while that never exits', async () => {
    const source = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { do { _0xi++; } while (!![]); return _0xt[_0xi]; }
      log(_0xd(0), _0xd(1));
    `;
    expect(recognise(source, ['_0xd'])).toBeNull();
    // Both hang, and both must hang: the input never prints, so the output
    // must not either.
    const { code } = await expectSameBehaviour(source, {}, 150);
    expect(execute(code, 150)).toMatch(/^THROWN Error: Script execution timed out/);
  });

  it('still accepts a do-while that can exit, and a block that returns', () => {
    // The loop counts on a local, not on the index: a `++` on the parameter
    // is a rewrite of the index the plain recogniser refuses on its own.
    const exits = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { var _0xn = 0; do { if (_0xn > 5) break; _0xn++; } while (true); return _0xt[_0xi]; }
    `;
    expect(recognise(exits, ['_0xd'])?.decode([1])).toBe('beta');

    const returns = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { { return _0xt[_0xi]; } }
    `;
    expect(recognise(returns, ['_0xd'])?.decode([1])).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// TypeScript wrappers
// ---------------------------------------------------------------------------

describe('type-level wrappers in string-array machinery', () => {
  const TABLE = ['log', 'hello ', 'world', 'name', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  /** The same program, once as JavaScript and once with the annotations a TS author adds. */
  const program = (typed: boolean): string => {
    const T = (annotation: string) => (typed ? annotation : '');
    return `
      var _0x1a2b${T(': string[]')} = ${JSON.stringify(TABLE)};
      (function (a${T(': string[]')}, b${T(': number')}) {
        var c = function (d${T(': number')}) { while (--d) { a['push'](a['shift']()${T(' as string')}); } };
        c(++b);
      })(_0x1a2b, 0x3);
      var _0x5c6d = function (e${T(': any')}, f${T('?: any')})${T(': string')} {
        e = e - 0x0;
        var g = _0x1a2b[e]${T(' as string')};
        return g;
      };
      log(_0x5c6d('0xa') + _0x1a2b[0x8] + _0x5c6d('0xb'), _0x5c6d('0x0'));
    `;
  };

  it('do not hide the rotation loop from the native tier', () => {
    // No checksum: the rotation is the 0.x fixed count, `c(++b)` over `0x3`,
    // and the tier reads it the same through the annotations as without.
    for (const [source, language] of [[program(false), undefined], [program(true), 'ts']] as const) {
      const decoder = recognise(source, ['_0x5c6d'], language);
      expect(decoder?.evidence, language ?? 'js').toBe('index lookup, rotation 3');
      expect(decoder?.decode(['0xa'])).toBe('hello ');
      expect(decoder?.decode(['0x0'])).toBe('name');
    }
  });

  it('are transparent to the interpreter', () => {
    const statements = parse(program(true), {
      sourceType: 'script',
      plugins: ['typescript'],
    }).program.body;
    const machine = createInterpreter(statements.slice(0, 3), {});
    expect(machine.call('_0x5c6d', ['0xa'])).toBe('hello ');
    expect(machine.call('_0x5c6d', ['0x0'])).toBe('name');
  });

  it('decode to the same strings as the untyped program', async () => {
    const untyped = await expectSameBehaviour(program(false));
    const typed = await expectSameBehaviour(program(true), { language: 'ts' });
    expect(execute(stripTypes(typed.code))).toBe(execute(untyped.code));
    expect(typed.code).toContain("'hello ");
    expect(typed.code).toContain("'name'");
  });

  it('let the native tier solve a rotation puzzle written with `as` and `!`', () => {
    // 300/1 + 400/2 + 600/3 balances only after two push(shift()) cycles.
    const source = `
      function _0xarr(): string[] {
        const _0xd = ['alpha', 'beta', '300', '400', '600'];
        _0xarr = function () { return _0xd; };
        return _0xarr();
      }
      function _0xdec(_0xa: number, _0xb?: string): string {
        const _0xc = _0xarr();
        _0xdec = function (_0xe: number, _0xf?: string) { _0xe = _0xe - 0x0; return _0xc[_0xe]!; };
        return _0xdec(_0xa, _0xb);
      }
      (function (_0xp: string[], _0xq: number) {
        var _0xr = _0xdec;
        while (!![]) {
          try {
            var _0xs = parseInt(_0xr(0x0)) / 0x1 + parseInt(_0xr(0x1)) / 0x2 + parseInt(_0xr(0x2)) / 0x3;
            if (_0xs === _0xq) break;
            else _0xp['push'](_0xp['shift']() as string);
          } catch (_0xt) {
            _0xp['push'](_0xp['shift']()!);
          }
        }
      })(_0xarr, 700);
      log(_0xdec(0x3));
    `;
    const decoder = recognise(source, ['_0xdec'], 'ts');
    expect(decoder?.rotation).toBe(2);
    expect(decoder?.decode([3])).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// Cross-check verdicts
// ---------------------------------------------------------------------------

describe('the cross-check', () => {
  it('refuses a native match the interpreter falsified without a usable answer of its own', async () => {
    // The offset is applied on a branch the program never takes, and the
    // native tier reads an assignment as unconditional: `_0xd(1)` is 'beta'
    // and native says 'alpha'. The interpreter refuses to draw entropy, so it
    // validates nothing - and the native answer, which it has just
    // contradicted, must not be returned as the consolation prize.
    const source = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { if (Math.random() > 2) _0xi = _0xi - 0x1; return _0xt[_0xi]; }
      log(_0xd(1), _0xd(0));
    `;
    const nativeOnly = build(source, ['_0xd'], {
      techniques: { stringDecoding: { tiers: ['native'] } },
    });
    expect(nativeOnly.decoder?.decode([1])).toBe('alpha');

    const { decoder, notes } = build(source, ['_0xd']);
    expect(decoder).toBeUndefined();
    expect(
      notes.some(
        (note) =>
          note.severity === 'error' &&
          note.message.includes('disagree') &&
          note.message.includes('left encoded'),
      ),
    ).toBe(true);

    const { code } = await expectSameBehaviour(source);
    expect(code).toContain('_0xd(1)');
  });

  it('treats a non-string from the interpreter as a disagreement, not an abstention', async () => {
    // The accessor rewrites its third entry to a number before handing the
    // table over; the native tier reads the literal and inlines 'c' where
    // the program prints 2. (An early `return _0xi` beside the lookup used to
    // be the shape here; the plain recogniser now refuses a body whose every
    // return is not the element, so the disagreement has to come from
    // something it reads past.)
    const source = `
      function _0xa() { var _0xo = ['a', 'b', 'c']; _0xo[2] = 2; _0xa = function () { return _0xo; }; return _0xa(); }
      function _0xd(_0xi) { var _0xv = _0xa()[_0xi]; return _0xv; }
      log(_0xd(0), _0xd(2));
    `;
    const { decoder, notes } = build(source, ['_0xd']);
    // The report says what came back - the number 2 - not the `undefined`
    // that narrowing it to a string left behind.
    const disagreement = notes.find((note) => note.message.includes('disagree'));
    expect(disagreement?.message).toContain('native produced "c", the interpreter produced the number 2');
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([2])).toBeUndefined();

    const { code } = await expectSameBehaviour(source);
    expect(execute(code)).toBe('"a" 2');
  });

  it('puts its question to the name the native tier chose, not to any root it can read', async () => {
    // Roots are `[decoder, table]`. The interpreter refuses the decoder's
    // call (a user `toString`, met on the way to the return), but it can
    // read the table - and reading `_0xt[0]` happens to equal the native
    // tier's `_0xd(0)`. That is a different function agreeing by
    // coincidence, not a confirmation.
    const source = `
      var _0xt = ['x', 'y'];
      var _0xo = { toString: function () { return 'Z'; } };
      function _0xd(_0xi) { var _0xv = _0xt[_0xi]; _0xo + ''; return _0xv; }
      log(_0xd(0), _0xd(1));
    `;
    const { decoder, notes } = build(source, ['_0xd', '_0xt']);
    expect(decoder).toBeUndefined();
    expect(
      notes.some((note) => note.message.includes('_0xd(0)') && note.message.includes('threw')),
    ).toBe(true);

    const { code } = await expectSameBehaviour(source);
    expect(execute(code)).toBe('"x" "y"');
  });

  it('reports why the interpreter tier produced no decoder', () => {
    const { notes } = build(
      `
        var _0xt = ['alpha', 'beta'];
        function _0xd(_0xi) { return _0xt; }
        log(_0xd(0));
      `,
      ['_0xd'],
      { techniques: { stringDecoding: { tiers: ['interpreter'] } } },
    );
    expect(
      notes.some((note) => note.message.includes('_0xd(0) returned an array, not a string')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A call the recognisers did not account for
// ---------------------------------------------------------------------------

/**
 * obfuscator.io's base64 decoder, pristine but for its last line: the UTF-8
 * step is `call(decodeURIComponent, onyx)` through `function call(o, p) {
 * return o(p); }`. The recognisers know `decodeURIComponent` by its callee's
 * name and see none here, so they read the body as "base64, latin1" - the
 * bytes of each string, one code unit apiece - and the rotation IIFE's twelve
 * numeric checksum strings plus the program's four ASCII strings are exactly
 * the sixteen call sites the cross-check used to stop at. The fifth program
 * string, 'ünï', was the seventeenth.
 */
const PROXIED_DECODE_URI = `
  var Theta = delta;
  var Ruby = delta;
  function eta() {
    var Mu = ["mZi3ntKZB1bPEgXL", "C25HA2vFy2fZzq", "AM9PBG", "AgvSBg8GD29YBgq", "mvLHBgnOtG",
      "mZzUsgjowKu", "Dhj1zq", "C3rYAw5NAwz5", "q2fTzwXdyxnL", "ntbNvMfcEgS", "ysXIlgm", "BNvSBa",
      "nxLvDgL3tq", "A2v5CW", "BgvUz3rO", "DgfIcwHLCMu", "nZyWnJHvAerXtMq", "mtK4mtq3ng9crxPoCq",
      "mtaXodeWofjwrvvNua", "B2jQzwn0", "mZi3mdrtsu5Qqwy", "mtHHr0HOqMq", "mZCXnZbLyKPYsLu", "W7XUW68",
      "odm2nZq2tu1vrMrS", "C2XPy2u", "y29UC3rYDwn0B3i", "zNjVBq", "zNjVBunOyxjdB2rL", "AxnbCNjHEq"];
    eta = function () { return Mu; };
    return eta();
  }
  var Elm = delta;
  (function (Sigma, Pi) {
    var Gamma = delta;
    var Nu = delta;
    var Xi = delta;
    var Eta = Sigma();
    while (!![]) {
      try {
        var Jade =
          (parseInt(Gamma(0x84)) / 0x1) * (parseInt(Nu(0x7a)) / 0x2) +
          parseInt(Xi("0x96")) / 0x3 +
          (parseInt(Xi("0x92")) / 0x4) * (parseInt(Xi("0x8c")) / 0x5) +
          (-parseInt(Nu(0x95)) / 0x6) * (-parseInt(Nu(0x80)) / 0x7) +
          -parseInt(Gamma(0x94)) / 0x8 +
          (-parseInt(Nu(0x90)) / 0x9) * (parseInt(Xi("0x89")) / 0xa) +
          (-parseInt(Gamma("0x91")) / 0xb) * (parseInt(Nu(0x85)) / 0xc);
        if (Jade === Pi) { break; } else { Eta["push"](Eta["shift"]()); }
      } catch (Chi) {
        Eta["push"](Eta["shift"]());
      }
    }
  })(eta, 0x3a559);
  function delta(beta, lambda) {
    beta = beta - 0x7a;
    var omicron = eta();
    var pi = omicron[beta];
    if (delta["TKHCnR"] === undefined) {
      var yew = function (xi) {
        var blue = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";
        var opal = "";
        var onyx = "";
        for (
          var iota = 0x0, ivy, gamma, alpha = 0x0;
          (gamma = xi["charAt"](alpha++));
          ~gamma && ((ivy = iota % 0x4 ? ivy * 0x40 + gamma : gamma), iota++ % 0x4)
            ? (opal += String["fromCharCode"](0xff & (ivy >> ((-0x2 * iota) & 0x6))))
            : 0x0
        ) {
          gamma = blue["indexOf"](gamma);
        }
        for (var zeta = 0x0, kappa = opal["length"]; zeta < kappa; zeta++) {
          onyx += "%" + ("00" + opal["charCodeAt"](zeta)["toString"](0x10))["slice"](-0x2);
        }
        return call(decodeURIComponent, onyx);
      };
      delta["aRPKlR"] = yew;
      delta["eOHCSl"] = {};
      delta["TKHCnR"] = !![];
    }
    var gold = omicron[0x0];
    if (delta["mmhjCh"] !== gold) {
      delta["eOHCSl"] = {};
      delta["mmhjCh"] = gold;
    }
    var nu = delta["eOHCSl"][beta];
    if (nu === undefined) {
      pi = delta["aRPKlR"](pi);
      delta["eOHCSl"][beta] = pi;
    } else {
      pi = nu;
    }
    return pi;
  }
  function call(o, p) {
    return o(p);
  }
  log(Theta(0x7f), Ruby("0x8a"), Theta(0x81), Theta("0x86"), Elm("0x97"));
`;

/** The same build with the builtin called where obfuscator.io calls it. */
const DIRECT_DECODE_URI = PROXIED_DECODE_URI.replace(
  'return call(decodeURIComponent, onyx);',
  'return decodeURIComponent(onyx);',
);

/** The helper moved inside the decoder: the callee is now a name the body binds. */
const LOCAL_PROXY_DECODE_URI = PROXIED_DECODE_URI.replace(
  'return call(decodeURIComponent, onyx);',
  'function call(o, p) { return o(p); }\n        return call(decodeURIComponent, onyx);',
);

/** A rewrite the body declares itself, through a method base64 is not written with. */
const UPPERCASED_DECODE_URI = PROXIED_DECODE_URI.replace(
  'return call(decodeURIComponent, onyx);',
  "var up = function (s) { return s['toUpperCase'](); };\n        return up(decodeURIComponent(onyx));",
);

const EXPECTED_TRACE = '"isArray" "a,b,c" "snake_case" "true" "ünï"';

describe('a decoder that calls what the recognisers did not read', () => {
  it('is refused by the native tier when the callee is bound outside the body', () => {
    expect(recognise(PROXIED_DECODE_URI, ['delta', 'eta'])).toBeNull();
    // The unproxied build is the ordinary case and must go on decoding natively.
    const direct = recognise(DIRECT_DECODE_URI, ['delta', 'eta']);
    expect(direct?.evidence).toContain('base64 (custom alphabet, utf8)');
    expect(direct?.decode(['0x97'])).toBe('ünï');
  });

  it('is refused when a builtin is handed to a helper rather than called', () => {
    // `call` is now the body's own, so the callee gate lets it through; the
    // builtin passed to it as a value is what no fact reads.
    expect(recognise(LOCAL_PROXY_DECODE_URI, ['delta', 'eta'])).toBeNull();
  });

  it('is refused when a method base64 is not written with is called', () => {
    // The helper is the body's own and calls nothing but a method, so neither
    // callee gate objects; the `toUpperCase` is a rewrite the classification
    // has no name for, and reading past it inlined 'isArray' for 'ISARRAY'.
    expect(recognise(UPPERCASED_DECODE_URI, ['delta', 'eta'])).toBeNull();
  });

  for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
    it(`decodes every string through the interpreter on the ${preset} preset`, async () => {
      const { code } = await expectSameBehaviour(PROXIED_DECODE_URI, { preset });
      expect(execute(code)).toBe(EXPECTED_TRACE);
      expect(code).toContain("'ünï'");
      expect(code).not.toContain('Ã¼');

      const local = await expectSameBehaviour(LOCAL_PROXY_DECODE_URI, { preset });
      expect(execute(local.code)).toBe(EXPECTED_TRACE);

      const upper = await expectSameBehaviour(UPPERCASED_DECODE_URI, { preset });
      expect(execute(upper.code)).toBe(EXPECTED_TRACE.toUpperCase());

      const direct = await expectSameBehaviour(DIRECT_DECODE_URI, { preset });
      expect(execute(direct.code)).toBe(EXPECTED_TRACE);
    });
  }
});

// ---------------------------------------------------------------------------
// A call the recognisers read by the wrong route
// ---------------------------------------------------------------------------

/**
 * The direct build with its UTF-8 step reached by every route but a plain call
 * of the name. The recognisers know a call by its callee's name and a method
 * by the name it is spelled with, so each of these read as something else:
 * `.call`, `.apply` and `.bind` as a method named `call`; `?.()` as nothing at
 * all, the facts never visiting it; `[k]` as a method with no name; a callee
 * that is itself a call as no call; a `decodeURIComponent` property of the
 * decoder as the builtin, which nothing inside the allowlist can hold; and a
 * `var decodeURIComponent` beside the decoder as the builtin too, when it is
 * `unescape` under that name. Each one's native reading is wrong at exactly
 * one site, the one that decodes a non-ASCII string; the cross-check can
 * only compare the sites it is handed, and with that site last of twenty-one
 * it was not among them, so the wrong reading reached the output. The gate
 * has to refuse on its own.
 */
const ROUTED_DECODE_URI: Record<string, string> = {
  'dot call': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'return decodeURIComponent.call(null, onyx);',
  ),
  'dot apply': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'return decodeURIComponent.apply(null, [onyx]);',
  ),
  'computed call': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'return decodeURIComponent["call"](null, onyx);',
  ),
  'computed by variable': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'var k = "call";\n' + '        return decodeURIComponent[k](null, onyx);',
  ),
  'bind then call': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'return decodeURIComponent.bind(null)(onyx);',
  ),
  'optional call of an outer helper': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'return call?.(onyx);',
  ).replace(
    'function call(o, p) {\n    return o(p);\n  }',
    'function call(p) {\n    return decodeURIComponent(p);\n  }',
  ),
  'optional method on the result': DIRECT_DECODE_URI.replace(
    'return decodeURIComponent(onyx);',
    'var up = function (s) { return s?.["normalize"]("NFD"); };\n' +
      '        return up(decodeURIComponent(onyx));',
  ),
  'shadowed by a slice-level var': DIRECT_DECODE_URI.replace(
    'var Elm = delta;',
    'var Elm = delta;\n' + '  var decodeURIComponent = function (s) { return unescape(s); };',
  ),
};

/** `s?.['toUpperCase']()`: the method the earlier block refused, now behind `?.`. */
const OPTIONAL_UPPERCASED_DECODE_URI = DIRECT_DECODE_URI.replace(
  'return decodeURIComponent(onyx);',
  "var up = function (s) { return s?.['toUpperCase'](); };\n" +
    '        return up(decodeURIComponent(onyx));',
);

/**
 * The builtin's name as a property of the decoder, bound to the identity. The
 * program returns percent-encoded text from every call, so the rotation
 * checksum never matches and the loop never ends. Read as the builtin, the
 * decoder inlined clean strings - and no cross-check could object, since the
 * interpreter has no answer for a decoder that never returns - and the output
 * ran to completion where the program hangs.
 */
const MEMBER_NAMED_DECODE_URI = DIRECT_DECODE_URI.replace(
  'return decodeURIComponent(onyx);',
  'delta["decodeURIComponent"] = function (s) { return s; };\n' +
    '        return delta["decodeURIComponent"](onyx);',
);

/**
 * Twenty ASCII call sites and then the non-ASCII one: the shape the wrong
 * readings above leaked through in, with the rotation IIFE's twelve sites
 * ahead of it in file order.
 */
function manySites(source: string): string {
  const sites = [
    0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x81, 0x82, 0x83, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x91, 0x92,
  ];
  const tail = sites.map((index) => `log(Theta(0x${index.toString(16)}));`).join('\n  ');
  const single = 'log(Theta(0x7f), Ruby("0x8a"), Theta(0x81), Theta("0x86"), Elm("0x97"));';
  if (!source.includes(single)) throw new Error('fixture has no single-site tail to replace');
  return source.replace(single, `${tail}\n  log(Elm("0x97"));`);
}

describe('a decoder that calls what the recognisers read by the wrong route', () => {
  it('is refused by the native tier for every route', () => {
    for (const [route, source] of Object.entries(ROUTED_DECODE_URI)) {
      expect(recognise(source, ['delta', 'eta']), route).toBeNull();
    }
    expect(recognise(OPTIONAL_UPPERCASED_DECODE_URI, ['delta', 'eta'])).toBeNull();
    expect(recognise(MEMBER_NAMED_DECODE_URI, ['delta', 'eta'])).toBeNull();
    // The plain call is the ordinary case and must go on decoding natively,
    // with its many-site tail as much as without.
    const direct = recognise(manySites(DIRECT_DECODE_URI), ['delta', 'eta']);
    expect(direct?.evidence).toContain('base64 (custom alphabet, utf8)');
    expect(direct?.decode(['0x97'])).toBe('ünï');
  });

  for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
    it(`decodes every route through the interpreter on the ${preset} preset`, async () => {
      for (const [route, source] of Object.entries(ROUTED_DECODE_URI)) {
        const many = manySites(source);
        const { code } = await expectSameBehaviour(many, { preset });
        // The last site is where the wrong reading showed. Whatever the
        // program computes there - 'ünï', its NFD form, or the 'Ã¼nÃ¯' the
        // shadowing var makes of it - is what the output has to have inlined.
        const last = JSON.parse(execute(many).split('\n').at(-1)!) as string;
        expect(code, route).toContain(`log('${last}')`);
      }
      const upper = manySites(OPTIONAL_UPPERCASED_DECODE_URI);
      expect((await expectSameBehaviour(upper, { preset })).code).toContain("log('ÜNÏ')");

      // The hang is the program's; the output has to keep it.
      const held = await expectSameBehaviour(MEMBER_NAMED_DECODE_URI, { preset }, 250);
      expect(execute(held.code, 250)).toContain('timed out');

      const direct = await expectSameBehaviour(manySites(DIRECT_DECODE_URI), { preset });
      expect(direct.code).toContain("log('ünï')");
    });
  }
});

// ---------------------------------------------------------------------------
// A builtin's name bound between the decoder and the global object
// ---------------------------------------------------------------------------

/** `unescape` under the builtin's name: 'Ã¼nÃ¯' where the builtin gives 'ünï'. */
const UNESCAPE_AS_DECODE_URI = 'function (s) { return unescape(s); }';

/**
 * The direct build with `decodeURIComponent` bound to `unescape` somewhere
 * the decoder can see it and the slice cannot take it from. A same-named
 * declaration beside the decoder is a unit of the scope and goes into the
 * slice, where the interpreter runs it (see 'shadowed by a slice-level var'
 * above); each of these is a binding that is no unit of any scope - a `var`
 * hoisted out of a block, an `if` or a `for` head, a parameter, a `catch`
 * binding - and the slice left the name free. Judged in a throwaway scope
 * of its own statements, the slice reported the name as the global, and
 * both tiers ran the builtin: 'ünï' inlined on every preset where the
 * program prints 'Ã¼nÃ¯', with nothing to disagree.
 */
const REBOUND_DECODE_URI: Record<string, (source: string) => string> = {
  'a var one block deeper': (source) =>
    source.replace('var Elm = delta;', `var Elm = delta;\n  { var decodeURIComponent = ${UNESCAPE_AS_DECODE_URI}; }`),
  'a var behind an if': (source) =>
    source.replace('var Elm = delta;', `var Elm = delta;\n  if (true) var decodeURIComponent = ${UNESCAPE_AS_DECODE_URI};`),
  'a var in a for head': (source) =>
    source.replace(
      'var Elm = delta;',
      `var Elm = delta;\n  for (var decodeURIComponent = ${UNESCAPE_AS_DECODE_URI}; ; ) break;`,
    ),
  'a parameter of the IIFE around it': (source) =>
    `(function (decodeURIComponent) {\n${source}\n})(${UNESCAPE_AS_DECODE_URI});`,
  'a parameter of the arrow around it': (source) =>
    `((decodeURIComponent) => {\n${source}\n})(${UNESCAPE_AS_DECODE_URI});`,
  'a default parameter': (source) =>
    `(function (decodeURIComponent = ${UNESCAPE_AS_DECODE_URI}) {\n${source}\n})();`,
  'a destructured parameter': (source) =>
    `(function ({ decodeURIComponent }) {\n${source}\n})({ decodeURIComponent: ${UNESCAPE_AS_DECODE_URI} });`,
  'a parameter of a named function called later': (source) =>
    `function main(decodeURIComponent) {\n${source}\n}\nmain(${UNESCAPE_AS_DECODE_URI});`,
  'a catch binding': (source) =>
    `try { throw ${UNESCAPE_AS_DECODE_URI}; } catch (decodeURIComponent) {\n${source}\n}`,
  'a parameter two scopes out': (source) =>
    `(function (decodeURIComponent) {\n  (function () {\n${source}\n  })();\n})(${UNESCAPE_AS_DECODE_URI});`,
  'a parameter, reached through .call': (source) =>
    `(function (decodeURIComponent) {\n${source.replace(
      'return decodeURIComponent(onyx);',
      'return decodeURIComponent.call(null, onyx);',
    )}\n})(${UNESCAPE_AS_DECODE_URI});`,
  "a named function expression's own name": (source) =>
    `(function decodeURIComponent(s) {\n  if (s !== undefined) return unescape(s);\n${source}\n})();`,
  // Annex B.3.3: a sloppy block's function declaration is also a `var` of the
  // scope around it, which Babel's scope pass does not record, and the slice
  // takes no block. Bound in the block's scope only, the name walked past
  // every `getBinding` from the decoder, and the program called it.
  'a function declared in a block': (source) =>
    source.replace('var Elm = delta;', 'var Elm = delta;\n  { function decodeURIComponent(s) { return unescape(s); } }'),
  'a function declared in an if arm': (source) =>
    source.replace(
      'var Elm = delta;',
      'var Elm = delta;\n  if (true) { function decodeURIComponent(s) { return unescape(s); } }',
    ),
};

/**
 * Any allowlisted name, not only the two the recognisers read for the byte
 * mode: `String` as a parameter holding a `fromCharCode` that folds every
 * byte above 127 to '?', so the program prints '??n??'.
 */
const REBOUND_STRING = (source: string): string =>
  `(function (String) {\n${source}\n})({ fromCharCode: function (c) { return c > 127 ? '?' : String.fromCharCode(c); } });`;

describe("a builtin's name bound between the decoder and the global object", () => {
  const REFUSAL = /not the builtin, and every tier would run the builtin/;

  for (const [what, rebind] of Object.entries(REBOUND_DECODE_URI)) {
    it(`by ${what} is refused before any tier runs`, () => {
      const { decoder, notes } = build(rebind(DIRECT_DECODE_URI), ['delta', 'eta']);
      expect(decoder).toBeUndefined();
      const refusal = notes.find((note) => REFUSAL.test(note.message));
      expect(refusal?.severity).toBe('warning');
      expect(refusal?.message).toContain('decodeURIComponent is a');
      // Refused ahead of the tiers, so neither had a say.
      expect(notes.some((note) => /^Tier /.test(note.message))).toBe(false);
    });

    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      it(`by ${what} leaves the program printing what it prints on the ${preset} preset`, async () => {
        const source = rebind(DIRECT_DECODE_URI);
        const { code, diagnostics } = await expectSameBehaviour(source, { preset });
        expect(execute(code).split('\n').at(-1)).toContain('"Ã¼nÃ¯"');
        expect(code).not.toContain("'ünï'");
        // Refused where the binding stands as written; where a round has
        // folded `if (true) var ...` into a declaration the slice takes, the
        // interpreter runs the program's own function, and what it inlines
        // is the program's reading, never the builtin's.
        expect(
          diagnostics.some((line) => REFUSAL.test(line)) || code.includes('Ã¼nÃ¯'),
          diagnostics.join('\n'),
        ).toBe(true);
      });
    }
  }

  it('by a parameter named String is refused before any tier runs', () => {
    const { decoder, notes } = build(REBOUND_STRING(DIRECT_DECODE_URI), ['delta', 'eta']);
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('String is a parameter'))).toBe(true);
  });

  for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
    it(`by a parameter named String leaves the program printing what it prints on the ${preset} preset`, async () => {
      const { code } = await expectSameBehaviour(REBOUND_STRING(DIRECT_DECODE_URI), { preset });
      expect(execute(code).split('\n').at(-1)).toContain('"??n??"');
      expect(code).not.toContain("'ünï'");
    });
  }

  it('by an import is refused with the import named', () => {
    // A module cannot run in the harness realm, so the gate is asked directly.
    const source = `import { decodeURIComponent } from './percent.js';\n${DIRECT_DECODE_URI}`;
    const { decoder, notes } = build(source, ['delta', 'eta']);
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('decodeURIComponent is an import'))).toBe(true);
  });

  it('is not a function declared in a block of a strict program', async () => {
    // Strict code has no Annex B: the declaration stays in its block, the
    // decoder calls the builtin, and the builtin is what gets inlined.
    const source = `'use strict';\n${REBOUND_DECODE_URI['a function declared in a block']!(DIRECT_DECODE_URI)}`;
    const { decoder, notes } = build(source, ['delta', 'eta']);
    expect(decoder?.decode(['0x97'])).toBe('ünï');
    expect(notes.some((note) => REFUSAL.test(note.message))).toBe(false);
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { code } = await expectSameBehaviour(source, { preset });
      expect(code).toContain("'ünï'");
    }
  });

  it('is not a same-named declaration the slice takes', async () => {
    // The gate asks about names the slice resolved to the host, and a `var`
    // beside the decoder is bound in the slice: the interpreter runs it, as
    // it did before the gate existed, and the native tier stays refused.
    const source = ROUTED_DECODE_URI['shadowed by a slice-level var']!;
    const { decoder, notes } = build(source, ['delta', 'eta']);
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode(['0x97'])).toBe('Ã¼nÃ¯');
    expect(notes.some((note) => REFUSAL.test(note.message))).toBe(false);
    const { code } = await expectSameBehaviour(source);
    expect(code).toContain("'Ã¼nÃ¯'");
  });
});

// ---------------------------------------------------------------------------
// Which call sites the cross-check puts to the interpreter
// ---------------------------------------------------------------------------

/**
 * A base64 decoder whose index offset is piecewise: `i = i + 1` runs outside
 * `[lo, hi]`, and the offset recogniser folds it in unconditionally, so the
 * native reading is one element off - but only inside `[lo, hi]`. Nothing
 * about the body is a call the recognisers did not read; only comparing the
 * two tiers on a call site inside the region can show it.
 */
function piecewiseOffsetDecoder(plaintexts: readonly string[], lo: number, hi: number): string {
  const encoded = plaintexts.map((text) =>
    JSON.stringify(Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '')),
  );
  return `
    var _0xarr = [${encoded.join(', ')}];
    function _0xdec(_0x1) {
      _0x1 = _0x1 - 0x7a;
      if (_0x1 < ${lo} || _0x1 > ${hi}) { _0x1 = _0x1 + 1; }
      var _0x2 = _0xarr[_0x1];
      var _0x3 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      var _0x4 = '', _0x5 = '';
      for (var _0x6 = 0, _0x7, _0x8, _0x9 = 0; _0x8 = _0x2['charAt'](_0x9++); ~_0x8 && (_0x7 = _0x6 % 4 ? _0x7 * 64 + _0x8 : _0x8, _0x6++ % 4) ? _0x4 += String['fromCharCode'](255 & _0x7 >> (-2 * _0x6 & 6)) : 0) {
        _0x8 = _0x3['indexOf'](_0x8);
      }
      for (var _0xa = 0, _0xb = _0x4['length']; _0xa < _0xb; _0xa++) {
        _0x5 += '%' + ('00' + _0x4['charCodeAt'](_0xa)['toString'](16))['slice'](-2);
      }
      return decodeURIComponent(_0x5);
    }
    log(_0xdec(0x7a));
  `;
}

describe('which call sites the cross-check puts to the interpreter', () => {
  it('is not decided by where the telling call site sits', () => {
    // Nineteen call sites, the only wrong one last. Taking the first sixteen
    // in file order confirmed the native reading and inlined 's19' where the
    // program computes 's18'; reversing the list caught it. Both orders must.
    const source = piecewiseOffsetDecoder(
      Array.from({ length: 20 }, (_, i) => `s${i}`),
      18,
      18,
    );
    const ascending = Array.from({ length: 19 }, (_, k) => [0x7a + k]);
    for (const samples of [ascending, [...ascending].reverse()]) {
      const { decoder, notes } = build(source, ['_0xdec'], {}, samples);
      expect(decoder?.tier).toBe('interpreter');
      expect(decoder?.decode([0x7a + 18])).toBe('s18');
      expect(
        notes.some(
          (note) =>
            note.severity === 'error' &&
            note.message.includes('_0xdec(140)') &&
            note.message.includes('native produced "s19", the interpreter produced "s18"'),
        ),
      ).toBe(true);
    }
  });

  it('thins a pool beyond the budget by what the native reading looks like, not by position', () => {
    // Ninety-nine call sites in file order, the wrong ones in the middle of
    // the range, and the native reading at one of them is the non-ASCII
    // neighbour. A byte-mode misread is visible only on such a site, so it is
    // put to the interpreter ahead of any number of ASCII sites before it.
    const source = piecewiseOffsetDecoder(
      Array.from({ length: 100 }, (_, i) => (i === 51 ? 'ünï' : `s${i}`)),
      50,
      52,
    );
    const samples = Array.from({ length: 99 }, (_, k) => [0x7a + k]);
    const { decoder, notes } = build(source, ['_0xdec'], {}, samples);
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([0x7a + 50])).toBe('s50');
    expect(
      notes.some(
        (note) =>
          note.severity === 'error' &&
          note.message.includes('native produced "ünï", the interpreter produced "s50"'),
      ),
    ).toBe(true);
  });

  /** The piecewise decoder wrong at the fiftieth of a hundred ASCII sites, with every site called. */
  const HUNDRED_ASCII_SITES = piecewiseOffsetDecoder(
    Array.from({ length: 101 }, (_, i) => `s${i}`),
    50,
    50,
  ).replace(
    'log(_0xdec(0x7a));',
    Array.from({ length: 100 }, (_, k) => `log(_0xdec(0x${(0x7a + k).toString(16)}));`).join('\n    '),
  );

  it('compares every site the collector hands over, not a spread of them', async () => {
    // A hundred ASCII sites, the native reading wrong at exactly one - the
    // fiftieth - and nothing in its output to tell it apart: no non-ASCII
    // character, no `%`, a string like every other. Thinned to thirty-two by
    // content, the check compared sites 47 and 51 and inlined 's51' where the
    // program prints 's50'. The collector hands over every distinct site; a
    // pool that fits the budget is compared whole.
    const samples = Array.from({ length: 100 }, (_, k) => [0x7a + k]);
    const { decoder, notes } = build(HUNDRED_ASCII_SITES, ['_0xdec'], {}, samples);
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([0x7a + 50])).toBe('s50');
    expect(
      notes.some(
        (note) =>
          note.severity === 'error' &&
          note.message.includes('_0xdec(172)') &&
          note.message.includes('native produced "s51", the interpreter produced "s50"'),
      ),
    ).toBe(true);

    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { code } = await expectSameBehaviour(HUNDRED_ASCII_SITES, { preset });
      const trace = execute(code).split('\n');
      expect(trace[50]).toBe('"s50"');
      expect(trace[49]).toBe('"s50"');
      expect(code).toMatch(/log\('s50'\);\s*log\('s50'\);/);
    }
  });
});

// ---------------------------------------------------------------------------
// The interpreter failing to build is not silence
// ---------------------------------------------------------------------------

/**
 * Six ways a slice's own initialisation stops the interpreter before the
 * decoder is reached: syntax outside its subset (a class, a getter, a tagged
 * template) and values only the run supplies (the clock, `Math.random()`, a
 * user `toString`). Each is paired with a decoder whose index goes through the
 * initialised value, so the native reading - which never looks at that value -
 * is wrong, and the program says so when run.
 */
const CONSTRUCTION_FAILURES: Record<string, string> = {
  'a class': `class _0xk { static v() { return 1; } }\nvar _0xs = _0xk.v();`,
  'a getter': `var _0xo = { get v() { return 1; } };\nvar _0xs = _0xo.v;`,
  'a tagged template': `function _0xtag(s) { return s.raw.length; }\nvar _0xs = _0xtag\`x\`;`,
  'the clock': `var _0xs = new Date().getFullYear() > 2000 ? 1 : 0;`,
  'Math.random()': `var _0xs = Math.random() < 2 ? 1 : 0;`,
  'a user toString': `var _0xs = +('' + { toString() { return '1'; } });`,
};

describe('a slice the interpreter cannot build', () => {
  /** The index is moved by the initialised value: native reads `t[i]`, the program computes `t[i + 1]`. */
  const shifted = (init: string): string => `
    var _0xt = ['alpha', 'beta', 'gamma'];
    ${init}
    function _0xd(_0xi) { return _0xt[_0xi + _0xs]; }
    log(_0xd(0), _0xd(1));
  `;

  /** The index is the parameter; the offset is gated on the initialised value, which is 1. */
  const gated = (init: string): string => `
    var _0xt = ['alpha', 'beta', 'gamma'];
    ${init}
    function _0xd(_0xi) { if (!_0xs) _0xi = _0xi - 0x1; return _0xt[_0xi]; }
    log(_0xd(0), _0xd(1));
  `;

  for (const [what, init] of Object.entries(CONSTRUCTION_FAILURES)) {
    it(`because of ${what} is refused when the index is computed from it`, async () => {
      // The index recogniser does not read past `i + s`, whatever `s` is.
      expect(recognise(shifted(init), ['_0xd'])).toBeNull();
      for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
        const { code } = await expectSameBehaviour(shifted(init), { preset });
        expect(execute(code)).toBe('"beta" "gamma"');
        expect(code).toContain('_0xd(0)');
      }
    });

    it(`because of ${what} is refused even when the native tier matched`, async () => {
      // Native reads the gated `i - 1` as unconditional and matches `t[i - 1]`
      // - the shape is fine, the value is wrong - and the only thing that
      // could have said so is the interpreter, which cannot run the slice.
      const nativeOnly = build(gated(init), ['_0xd'], {
        techniques: { stringDecoding: { tiers: ['native'] } },
      });
      expect(nativeOnly.decoder?.decode([1])).toBe('alpha');

      const { decoder, notes } = build(gated(init), ['_0xd']);
      expect(decoder).toBeUndefined();
      expect(notes.some((note) => note.message.includes('threw while building'))).toBe(true);
      expect(
        notes.some(
          (note) =>
            note.severity === 'warning' &&
            note.message.includes('cannot be checked') &&
            note.message.includes('rejected the slice'),
        ),
      ).toBe(true);
      expect(notes.some((note) => note.message.includes('stands unchecked'))).toBe(false);

      for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
        const { code } = await expectSameBehaviour(gated(init), { preset });
        expect(execute(code)).toBe('"alpha" "beta"');
        expect(code).toContain('_0xd(1)');
      }
    });
  }

  /**
   * A rotation loop the interpreter cannot finish on a short budget, and the
   * native tier solves as arithmetic: forty entries, the two numeric ones
   * last, so the checksum balances only after thirty-eight `push(shift())`s.
   * The one loop in the slice is the one the recogniser read, which is what
   * lets a match stand unchecked - obfuscated2.js's wrapper is exactly this.
   */
  const rotated = (decoder: string): string => {
    const entries = Array.from({ length: 38 }, (_, i) => `'w${i}'`).concat(["'300'", "'400'"]);
    return `
      var _0xt = [${entries.join(', ')}];
      var _0xs = 1;
      (function (_0xp, _0xq) {
        var _0xr = _0xd;
        while (!![]) {
          try {
            var _0xc = parseInt(_0xr(0x0)) / 0x1 + parseInt(_0xr(0x1)) / 0x2;
            if (_0xc === _0xq) break;
            else _0xp['push'](_0xp['shift']());
          } catch (_0xe) {
            _0xp['push'](_0xp['shift']());
          }
        }
      }(_0xt, 500));
      function _0xd(_0xi) { ${decoder} }
      log(_0xd(2), _0xd(3));
    `;
  };

  it('because it ran out of budget in the rotation loop is confirmed past the loop, at every preset', async () => {
    // The loop is where the budget goes, and the recogniser solved it as
    // arithmetic: the interpreter runs the slice with the loop stood in for
    // by its solution and confirms the decoder on the sites and on the
    // checksum's own terms. Nothing stands unchecked, the whole slice is
    // never run, and conservative, which inlines only what is proved, takes
    // what was checked. The reading used to stand at balanced with "stands
    // unchecked" attached and be refused at conservative.
    const source = rotated('return _0xt[_0xi];');
    expect(execute(source)).toBe('"w0" "w1"');
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { decoder, notes } = build(source, ['_0xd'], { preset, sandbox: { maxSteps: 1_000 } });
      expect(decoder?.tier, preset).toBe('native');
      expect(decoder?.decode([2]), preset).toBe('w0');
      expect(notes.some((note) => note.message.includes('ran out of budget while building')), preset).toBe(false);
      expect(
        notes.some((note) => note.message.includes('stands unchecked') || note.message.includes('cannot be checked')),
        preset,
      ).toBe(false);
      expect(
        notes.some(
          (note) =>
            note.severity === 'info' &&
            note.message.includes('Confirmed the "index lookup, rotation 38" match for _0xd by the interpreter on 2 of 2 call site(s)') &&
            note.message.includes('on the 2 term(s) of the rotation checksum') &&
            note.message.includes('with the 38 shift(s) it solves to'),
        ),
        `${preset}: ${notes.map((note) => note.message).join('\n')}`,
      ).toBe(true);

      const { code } = await expectSameBehaviour(source, { preset, sandbox: { maxSteps: 1_000 } });
      expect(code, preset).toContain("'w0'");
      expect(code, preset).not.toContain('_0xd(2)');
    }
  });

  it('because it ran out of budget in a loop the recogniser did not read is refused at every preset', async () => {
    // The budget went into a loop the native tier never modelled, and what
    // that loop did to the table - here, to the flag the offset is gated on
    // - is exactly what the run was going to say. `_0xs` finishes at 1, the
    // offset never applies, the program prints `t[i]`, and the recogniser,
    // which reads the gated `i - 1` as unconditional, says `t[i - 1]`. That
    // reading used to stand at balanced with "stands unchecked" attached;
    // now nothing lets it stand.
    const source = `
      var _0xt = ['alpha', 'beta', 'gamma'];
      var _0xs = 1;
      (function () { for (var _0xn = 0; _0xn < 100000; _0xn++) { _0xs = _0xn & 0x1; } })();
      function _0xd(_0xi) { if (!_0xs) _0xi = _0xi - 0x1; return _0xt[_0xi]; }
      log(_0xd(1), _0xd(2));
    `;
    expect(execute(source)).toBe('"beta" "gamma"');

    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { decoder, notes } = build(source, ['_0xd'], { preset, sandbox: { maxSteps: 5_000 } });
      expect(decoder, preset).toBeUndefined();
      expect(notes.some((note) => note.message.includes('ran out of budget while building')), preset).toBe(true);
      expect(
        notes.some(
          (note) =>
            note.severity === 'warning' &&
            note.message.startsWith('Refusing _0xd:') &&
            note.message.includes('ran out of budget') &&
            note.message.includes('a loop the recogniser did not read (`for (... ...;...) ...`, in the statement at line 4)'),
        ),
        preset,
      ).toBe(true);
      expect(notes.some((note) => note.message.includes('stands unchecked')), preset).toBe(false);

      const { code, diagnostics } = await expectSameBehaviour(source, { preset, sandbox: { maxSteps: 5_000 } });
      expect(code, preset).toContain('_0xd(1)');
      expect(code, preset).not.toContain("log('alpha'");
      expect(diagnostics.some((line) => line.includes('Refusing _0xd:') && line.includes('did not read')), preset).toBe(true);
    }
  });

  it('because it ran out of budget in the rotation loop is refused wherever the interpreter, run past the loop, disagrees', async () => {
    // The same rotation loop over an accessor that rewrites its third entry
    // before handing the table over: 'w2' to the recogniser, which reads the
    // literal, 'mutated' to the program, which prints it. The interpreter
    // runs the accessor in the slice it is given past the loop, reads
    // 'mutated' at the site that prints it, and the disagreement refuses the
    // decoder at every preset. The literal's reading used to stand at
    // balanced with "stands unchecked" attached, 'w2' inlined where the
    // program prints 'mutated', and conservative refused it for want of a
    // check rather than for the reading being wrong.
    const entries = Array.from({ length: 38 }, (_, i) => `'w${i}'`).concat(["'300'", "'400'"]);
    const source = `
      function _0xa() {
        var _0xo = [${entries.join(', ')}];
        _0xo[2] = 'mutated';
        _0xa = function () { return _0xo; };
        return _0xa();
      }
      (function (_0xp, _0xq) {
        var _0xr = _0xd, _0xl = _0xp();
        while (!![]) {
          try {
            var _0xc = parseInt(_0xr(0x0)) / 0x1 + parseInt(_0xr(0x1)) / 0x2;
            if (_0xc === _0xq) break;
            else _0xl['push'](_0xl['shift']());
          } catch (_0xe) {
            _0xl['push'](_0xl['shift']());
          }
        }
      }(_0xa, 500));
      function _0xd(_0xi) { var _0xv = _0xa()[_0xi]; return _0xv; }
      log(_0xd(2), _0xd(4));
    `;
    expect(execute(source)).toBe('"w0" "mutated"');

    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { decoder, notes } = build(source, ['_0xd'], { preset, sandbox: { maxSteps: 1_000 } });
      expect(decoder, preset).toBeUndefined();
      expect(
        notes.some(
          (note) =>
            note.severity === 'error' &&
            note.message.includes('disagree on _0xd(4): native produced "w2", the interpreter produced "mutated"') &&
            note.message.includes('run past the rotation loop with the 38 shift(s) the recogniser solved') &&
            note.message.includes('the references are left encoded'),
        ),
        `${preset}: ${notes.map((note) => note.message).join('\n')}`,
      ).toBe(true);
      expect(
        notes.some((note) => note.message.includes('stands unchecked') || note.message.includes('ran out of budget while building')),
        preset,
      ).toBe(false);

      const { code, diagnostics } = await expectSameBehaviour(source, { preset, sandbox: { maxSteps: 1_000 } });
      expect(code, preset).toContain('_0xd(2)');
      expect(code, preset).toContain('_0xd(4)');
      expect(code, preset).not.toContain("log('w0'");
      expect(diagnostics.some((line) => line.includes('disagree on _0xd(4)')), preset).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The plain index recogniser reads the index
// ---------------------------------------------------------------------------

describe('the plain index recogniser', () => {
  const decoder = (body: string): string => `
    var _0xt = ['alpha', 'beta', 'gamma', 'delta'];
    var _0xn = 1;
    function _0xd(_0xi) { ${body} }
    log(_0xd(0), _0xd(1));
  `;

  it('accepts the parameter, moved only by the recognised offset', () => {
    const accepted: [string, number, string][] = [
      ['return _0xt[_0xi];', 1, 'beta'],
      ['return _0xt[_0xi - 0x0];', 1, 'beta'],
      ['return _0xt[_0xi + 0x0];', 1, 'beta'],
      ['_0xi = _0xi - 0x2; return _0xt[_0xi];', 3, 'beta'],
      ['_0xi -= 0x2; return _0xt[_0xi];', 3, 'beta'],
      ['_0xi += 0x1; return _0xt[_0xi];', 0, 'beta'],
      ['return _0xt[_0xi - 0x2];', 3, 'beta'],
      ['return _0xt[_0xi + 0x1];', 0, 'beta'],
      ["var _0xv = _0xt[_0xi]; return _0xv['length'] ? _0xv : _0xv;", 1, 'beta'],
      ["_0xi = _0xi - 0x2; var _0xc = _0xd['cache'] || {}; return _0xc[_0xi] || _0xt[_0xi];", 3, 'beta'],
    ];
    for (const [body, index, value] of accepted) {
      expect(recognise(decoder(body), ['_0xd'])?.decode([index]), body).toBe(value);
    }
  });

  it('refuses an index that is not the parameter, or a parameter written by anything else', () => {
    const refused = [
      'return _0xt[_0xi + _0xn];',
      'return _0xt[_0xn];',
      'return _0xt[0x1];',
      'return _0xt[_0xi * 0x1];',
      '_0xi = _0xi * 0x1; return _0xt[_0xi];',
      '_0xi = _0xn; return _0xt[_0xi];',
      '_0xi++; return _0xt[_0xi];',
      '_0xi ^= 0x0; return _0xt[_0xi];',
      // Two offsets: the recogniser reads the assignment and stops, so the
      // index it would use is off by the second one.
      '_0xi = _0xi - 0x1; return _0xt[_0xi - 0x1];',
      'var _0xj = _0xi; return _0xt[_0xj];',
    ];
    for (const body of refused) {
      expect(recognise(decoder(body), ['_0xd']), body).toBeNull();
    }
  });

  it('leaves the two-offset decoder to the interpreter, which applies both', async () => {
    const source = decoder('_0xi = _0xi - 0x1; return _0xt[_0xi - 0x1];');
    const { decoder: built } = build(source.replace('log(_0xd(0), _0xd(1));', 'log(_0xd(2), _0xd(3));'), ['_0xd']);
    expect(built?.tier).toBe('interpreter');
    expect(built?.decode([3])).toBe('beta');
    const { code } = await expectSameBehaviour(source.replace('log(_0xd(0), _0xd(1));', 'log(_0xd(2), _0xd(3));'));
    expect(execute(code)).toBe('"alpha" "beta"');
  });
});

// ---------------------------------------------------------------------------
// Interpreter fidelity notes
// ---------------------------------------------------------------------------

describe('a decoder that reads its own source text', () => {
  it('is confirmed on a reprint, and the notes say so', () => {
    // The slice reaches the interpreter as clones without offsets, so `'' + f`
    // is a reprint of the AST rather than the program's bytes. The verdict
    // rests on the two agreeing, which is worth an info note every time.
    const source = `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { var _0xs = '' + _0xd; return _0xs.length > 0 ? _0xt[_0xi] : _0xt[0]; }
      log(_0xd(0), _0xd(1));
    `;
    const { decoder, notes } = build(source, ['_0xd']);
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([1])).toBe('beta');
    const fidelity = notes.filter((note) => note.message.startsWith('Interpreter fidelity for _0xd:'));
    expect(fidelity).toHaveLength(1);
    expect(fidelity[0]?.severity).toBe('info');
    expect(fidelity[0]?.message).toContain('regenerated source');
  });

  it('is the only kind of decoder that gets one', () => {
    const { notes } = build(
      `
        var _0xt = ['alpha', 'beta'];
        function _0xd(_0xi) { return _0xt[_0xi]; }
        log(_0xd(0), _0xd(1));
      `,
      ['_0xd'],
    );
    expect(notes.some((note) => note.message.includes('Interpreter fidelity'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Builtins: V8's answer, or none
// ---------------------------------------------------------------------------

describe('decoders that reach a value only the real run can supply', () => {
  const cases: Record<string, string> = {
    'the collation of the host locale': `
      var _0xt = ['a', 'A', 'b'];
      function _0xd(_0xi) {
        var s = _0xt.slice().sort(function (x, y) { return x.localeCompare(y); });
        return s[_0xi];
      }
      log(_0xd(0), _0xd(1), _0xd(2));
    `,
    'a user toString': `
      var _0xt = ['x', 'y'];
      var _0xo = { toString: function () { return 'Z'; } };
      function _0xd(_0xi) { return _0xt[_0xi] + _0xo; }
      log(_0xd(0), _0xd(1));
    `,
    'a user valueOf': `
      var _0xt = ['p', 'q', 'r'];
      var _0xo = { valueOf: function () { return 1; } };
      function _0xd(_0xi) { return _0xt[_0xi + _0xo]; }
      log(_0xd(0), _0xd(1));
    `,
    'the clock': `
      var _0xt = ['alpha', 'beta', 'gamma', 'delta'];
      function _0xd(_0xi) { return _0xt[(new Date().getFullYear() - 2023 + _0xi) % 4]; }
      log(_0xd(0), _0xd(1));
    `,
    'the time zone': `
      var _0xt = ['alpha', 'beta'];
      function _0xd(_0xi) { return _0xt[(new Date(0).getHours() + _0xi) % 2]; }
      log(_0xd(0), _0xd(1));
    `,
  };

  for (const [what, source] of Object.entries(cases)) {
    it(`are left alone when they depend on ${what}`, async () => {
      for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
        const { code } = await expectSameBehaviour(source, { preset });
        expect(code).toContain('_0xd(0)');
      }
    });
  }
});

describe('builtins the interpreter answers exactly', () => {
  it('normalize honours its form and rejects a bad one the way V8 does', () => {
    const body = `
      var s = '\\u00e9t\\u00e9';
      var out = [s.normalize('NFD').length, s.normalize().length, s.normalize('NFC') === s,
                 'e\\u0301'.normalize('NFC') === '\\u00e9', '\\ufb01'.normalize('NFKC'), s.normalize(undefined).length];
      try { s.normalize('nfd'); out.push('accepted'); } catch (e) { out.push(e.name + ': ' + e.message); }
      return out;
    `;
    const s = 'été';
    const expected: unknown[] = [
      s.normalize('NFD').length,
      s.normalize().length,
      s.normalize('NFC') === s,
      'é'.normalize('NFC') === 'é',
      'ﬁ'.normalize('NFKC'),
      s.normalize(undefined).length,
    ];
    try {
      s.normalize('nfd');
      expected.push('accepted');
    } catch (error) {
      expected.push(`${(error as Error).name}: ${(error as Error).message}`);
    }
    expect(interpret(body)).toEqual(expected);
    expect(expected[0]).toBe(5);
  });

  it('lastIndexOf honours a present fromIndex, including an explicit undefined', () => {
    const body = `
      var a = ['a', 'b', 'a', 'c'];
      return [a.lastIndexOf('a'), a.lastIndexOf('a', 1), a.lastIndexOf('a', undefined), a.lastIndexOf('a', -2),
              a.lastIndexOf('a', NaN), a.lastIndexOf('a', -10), 'abcab'.lastIndexOf('ab', 2), 'abcab'.lastIndexOf('ab', undefined)];
    `;
    const a = ['a', 'b', 'a', 'c'];
    expect(interpret(body)).toEqual([
      a.lastIndexOf('a'),
      a.lastIndexOf('a', 1),
      a.lastIndexOf('a', undefined as unknown as number),
      a.lastIndexOf('a', -2),
      a.lastIndexOf('a', Number.NaN),
      a.lastIndexOf('a', -10),
      'abcab'.lastIndexOf('ab', 2),
      'abcab'.lastIndexOf('ab', undefined as unknown as number),
    ]);
  });

  it('converts an array to a number through its string form', () => {
    const body = `return [+[undefined], +[true], +[null], +[[5]], +['0x10'], +[1, 2], +[], +[' 7 ']];`;
    expect(interpret(body)).toEqual([
      +[undefined],
      +[true],
      +[null],
      +[[5]],
      +['0x10'],
      +[1, 2],
      +[],
      +[' 7 '],
    ]);
  });

  it('answers the UTC face of a Date exactly', () => {
    const body = `
      return [new Date(0).getTime(), new Date(1.5).getTime(), new Date('2020-01-02').toISOString(),
              new Date('2020-01-02T03:04:05.678Z').getTime(), new Date('2020-01-02T03:04:05+02:00').getTime(),
              Date.UTC(2020, 0, 2), Date.UTC(99), Date.UTC(NaN), Date.parse('2021-06-30'),
              new Date(8.64e15 + 1).getTime(), new Date(null).getTime(), new Date(new Date(7)).valueOf()];
    `;
    expect(interpret(body)).toEqual([
      new Date(0).getTime(),
      new Date(1.5).getTime(),
      new Date('2020-01-02').toISOString(),
      new Date('2020-01-02T03:04:05.678Z').getTime(),
      new Date('2020-01-02T03:04:05+02:00').getTime(),
      Date.UTC(2020, 0, 2),
      Date.UTC(99),
      Date.UTC(Number.NaN),
      Date.parse('2021-06-30'),
      new Date(8.64e15 + 1).getTime(),
      new Date(null as unknown as number).getTime(),
      new Date(new Date(7)).valueOf(),
    ]);
  });
});

describe('builtins the interpreter refuses', () => {
  const refusals: Record<string, string> = {
    'Math.random()': 'return Math.random();',
    'Date.now()': 'return Date.now();',
    'new Date()': 'return new Date().getTime();',
    'Date()': 'return Date();',
    'a local-time getter': 'return new Date(0).getFullYear();',
    'getTimezoneOffset': 'return new Date(0).getTimezoneOffset();',
    'Date.prototype.toString': "return '' + new Date(0);",
    'a local-time constructor': 'return new Date(2020, 0, 1).getTime();',
    'a date-time string without an offset': "return new Date('2020-01-02T03:04').getTime();",
    'a non-ISO date string': "return Date.parse('Jan 2, 2020');",
    'localeCompare': "return 'a'.localeCompare('A');",
    'a user toString under +': "return 'x' + { toString: function () { return 'Z'; } };",
    'a user toString in a template': 'return `${{ toString: function () { return "Z"; } }}`;',
    'a user valueOf under -': 'return 3 - { valueOf: function () { return 1; } };',
    'a user valueOf under <': 'return 3 < { valueOf: function () { return 1; } };',
    'a user valueOf under ==': 'return 1 == { valueOf: function () { return 1; } };',
    'an inherited toString': "return String(Object.create({ toString: function () { return 'Z'; } }));",
    'a function with its own toString': "function f() {} f.toString = function () { return 'Z'; }; return '' + f;",
    'an array with its own toString': "var a = [1]; a.toString = function () { return 'Z'; }; return '' + a;",
    'a user toString as a property key': "var o = {}; return o[{ toString: function () { return 'k'; } }];",
    'a user toString through decodeURIComponent': "return decodeURIComponent({ toString: function () { return '%41'; } });",
  };

  for (const [what, body] of Object.entries(refusals)) {
    it(`refuses ${what}`, () => {
      expect(() => interpret(body)).toThrow(InterpreterRefusal);
    });
  }

  it('cannot be caught, swallowed or diverted from interpreted code', () => {
    expect(() =>
      interpret(`
        try { return Math.random(); } catch (e) { return 'caught'; } finally { var f = 1; }
      `),
    ).toThrow(InterpreterRefusal);
    expect(() =>
      interpret(`
        try { return '' + { toString: function () { return 'Z'; } }; } catch (e) { return 'caught'; }
      `),
    ).toThrow(InterpreterRefusal);
  });

  it('still answers everything that has one value', () => {
    expect(
      interpret(`
        var o = { a: 1 };
        var fn = function () {};
        return ['' + o, '' + [1, [2, 3]], '' + fn === fn.toString(), o == '[object Object]', +[] === 0,
                'a' < 'b', String([]), [].join('-'), ({}).hasOwnProperty('toString')];
      `),
    ).toEqual([
      '[object Object]',
      '1,2,3',
      true,
      true,
      true,
      true,
      '',
      '',
      false,
    ]);
  });
});
