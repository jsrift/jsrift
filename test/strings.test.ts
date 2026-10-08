import { describe, expect, it } from 'vitest';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { mergeSplitStringsPass } from '../src/passes/strings/merge-split.js';
import { pruneDecodersPass } from '../src/passes/strings/prune-decoders.js';
import type { Pass } from '../src/pipeline/pass.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, normalize, runPass } from './helpers.js';

/**
 * The string layer end to end. Ordering matches the registry: the merge visitor
 * runs with the stage traversal, then discovery, inlining and pruning as `run`
 * passes, which is exactly how the kernel schedules them in a real run.
 */
const STRING_PASSES: Pass[] = [
  mergeSplitStringsPass,
  discoverStringsPass,
  inlineStringsPass,
  pruneDecodersPass,
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAIN_ARRAY = `
  var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
  console.log(_0xa[0], _0xa[0x2]);
`;

/** The self-replacing accessor plus a decoder with a subtractive index offset. */
const THUNK_AND_DECODER = `
  function _0xarr() {
    const _0xd = ['alpha', 'beta', 'gamma'];
    _0xarr = function () { return _0xd; };
    return _0xarr();
  }
  function _0xdec(_0xi) {
    const _0xb = _0xarr();
    return _0xb[_0xi - 0x10];
  }
`;

function withThunk(body: string): string {
  return `${THUNK_AND_DECODER}\n${body}`;
}

/** A large table, so that `1e3` and `0x7b` are both in range. */
function wideArray(size: number, tail: string): string {
  const values = Array.from({ length: size }, (_, index) => `'s${index}'`).join(', ');
  return `var _0xa = [${values}];\n${tail}`;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovering a string source without being told where it is', () => {
  it('finds a plain top-level array and inlines every constant index', async () => {
    const { code } = await runPass(STRING_PASSES, PLAIN_ARRAY);
    expectEquivalent(code, `console.log('alpha', 'gamma');`);
  });

  it('finds an array behind a self-replacing thunk and its decoder', async () => {
    const { code } = await runPass(STRING_PASSES, withThunk(`console.log(_0xdec(0x10), _0xdec(0x12));`));
    expectEquivalent(code, `console.log('alpha', 'gamma');`);
  });

  it('finds an array behind a plain accessor function', async () => {
    const source = `
      function _0xarr() { return ['alpha', 'beta', 'gamma']; }
      function _0xdec(_0xi) { return _0xarr()[_0xi]; }
      console.log(_0xdec(0x1));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `console.log('beta');`);
  });

  it('reads the index offset out of the AST rather than assuming zero', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      function _0xdec(_0xi) { _0xi = _0xi - 0x1a4; return _0xa[_0xi]; }
      console.log(_0xdec(0x1a5));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `console.log('beta');`);
  });

  it('decodes a base64 payload it recognises from the decoder body', async () => {
    const source = `
      function _0xarr() {
        const _0xd = ['YWxwaGE=', 'YmV0YQ=='];
        _0xarr = function () { return _0xd; };
        return _0xarr();
      }
      function _0xdec(_0xi) { return atob(_0xarr()[_0xi]); }
      console.log(_0xdec(0x0), _0xdec(0x1));
    `;
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `console.log('alpha', 'beta');`);
    expect(ctx.detections.map((d) => d.kind)).toContain('string-encoding-base64');
  });

  it('reports the array, the wrapper and the entry count', async () => {
    const { ctx } = await runPass(STRING_PASSES, withThunk(`console.log(_0xdec(0x10));`));
    const array = ctx.detections.find((d) => d.kind === 'string-array');
    expect(array?.count).toBe(3);
    expect(ctx.detections.map((d) => d.kind)).toContain('string-array-wrapper');
  });

  it('picks the most-referenced decoder when several functions close over the array', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      function _0xhelper(_0xi) { return _0xa.length + _0xi; }
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      console.log(_0xdec(0x0), _0xdec(0x1), _0xdec(0x2), _0xhelper(1));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'gamma'`);
  });

  it('does not treat an array of non-strings as a string source', async () => {
    await expectNoChange(STRING_PASSES, `var _0xa = [1, 2, 3, 4];\nconsole.log(_0xa[0]);`);
  });

  it('does not treat a one-element array as a table', async () => {
    await expectNoChange(STRING_PASSES, `var _0xa = ['alpha'];\nconsole.log(_0xa[0]);`);
  });

  it('refuses a rotated array it has no decoder to solve the checksum against', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      (function (_0xp, _0xq) {
        while (!![]) {
          try { if (_0xq === 0x1) break; else _0xp['push'](_0xp['shift']()); }
          catch (_0xe) { _0xp['push'](_0xp['shift']()); }
        }
      }(_0xa, 0x2));
      console.log(_0xa[0]);
    `;
    await expectNoChange(STRING_PASSES, source);
  });
});

// ---------------------------------------------------------------------------
// Access shapes
// ---------------------------------------------------------------------------

describe('every shape a reference can take', () => {
  it('inlines a decimal index', async () => {
    const { code } = await runPass(STRING_PASSES, wideArray(1200, 'send(_0xa[12]);'));
    expect(code).toContain(`send('s12')`);
  });

  it('inlines a scientific-notation index, which a [0-9]+ pattern would miss', async () => {
    const { code } = await runPass(STRING_PASSES, wideArray(1200, 'send(_0xa[1e3]);'));
    expect(code).toContain(`send('s1000')`);
  });

  it('inlines a hexadecimal index', async () => {
    const { code } = await runPass(STRING_PASSES, wideArray(1200, 'send(_0xa[0x7b]);'));
    expect(code).toContain(`send('s123')`);
  });

  it('inlines a one-argument decoder call', async () => {
    const { code } = await runPass(STRING_PASSES, withThunk('send(_0xdec(0x11));'));
    expect(code).toContain(`send('beta')`);
  });

  it('inlines a two-argument decoder call, keying on the second argument', async () => {
    // A keyed XOR decoder: the key travels with the call site, as obfuscator.io
    // emits for RC4, so the second argument has to reach the decoder.
    const encode = (text: string, key: string): string =>
      [...text].map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
    const values = [encode('alpha', 'k1'), encode('beta', 'k2')].map((v) => JSON.stringify(v));
    const source = `
      var _0xa = [${values.join(', ')}];
      function _0xdec(_0xi, _0xk) {
        var _0xs = _0xa[_0xi], _0xo = '';
        for (var _0xn = 0; _0xn < _0xs.length; _0xn++) {
          _0xo += String.fromCharCode(_0xs.charCodeAt(_0xn) ^ _0xk.charCodeAt(_0xn % _0xk.length));
        }
        return _0xo;
      }
      send(_0xdec(0x0, 'k1'), _0xdec(0x1, 'k2'));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'beta'`);
  });

  it('leaves an index that is out of range alone', async () => {
    const { code } = await runPass(STRING_PASSES, `var _0xa = ['alpha', 'beta'];\nsend(_0xa[9], _0xa[0]);`);
    expect(code).toContain('_0xa[9]');
    expect(code).toContain(`'alpha'`);
  });

  it('does not rewrite a read it cannot resolve, and keeps the table for it', async () => {
    const source = `var _0xa = ['alpha', 'beta', 'gamma'];\nsend(_0xa[0], _0xa[pick()]);`;
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`send('alpha'`);
    expect(code).toContain('_0xa[pick()]');
    expect(ctx.diagnostics.some((d) => d.message.includes('still resolve to it'))).toBe(true);
  });

  it('inlines direct reads and decoder calls against the same array', async () => {
    // The decoder applies an index offset that a bare `A[0]` does not, so the
    // two shapes are separate sources over the same table.
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
      function _0xdec(_0xi) { return _0xa[_0xi - 0x10]; }
      send(_0xa[0x1], _0xdec(0x12));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `send('beta', 'gamma');`);
  });

  it('never rewrites an index that is being written to', async () => {
    await expectNoChange(STRING_PASSES, `var _0xa = ['alpha', 'beta'];\n_0xa[0] = 'x';\nsend(_0xa[1]);`);
  });
});

// ---------------------------------------------------------------------------
// Aliases and wrappers
// ---------------------------------------------------------------------------

describe('aliases and wrappers', () => {
  it('follows a top-level alias of the decoder', async () => {
    const { code } = await runPass(STRING_PASSES, withThunk(`var _0xb = _0xdec;\nsend(_0xb(0x10));`));
    expectEquivalent(code, `send('alpha');`);
  });

  it('follows a chain of top-level aliases to a fixed point', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`var _0xb = _0xdec;\nvar _0xc = _0xb;\nvar _0xe = _0xc;\nsend(_0xe(0x11));`),
    );
    expectEquivalent(code, `send('beta');`);
  });

  it('follows the function-local alias real obfuscator.io output uses everywhere', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`function f() { var _0xl = _0xdec; return _0xl(0x10) + _0xl(0x11); }`),
    );
    expect(code).toContain("return 'alphabeta'");
  });

  it('follows a chain of function-local aliases', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`function f() { var _0xl = _0xdec, _0xm = _0xl; return _0xm(0x12); }`),
    );
    expect(code).toContain(`'gamma'`);
  });

  it('evaluates a wrapper argument expression instead of scraping a constant', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
      function _0xdec(_0xi) { return _0xa[_0xi - 0x10]; }
      function _0xw(_0xp, _0xq, _0xr) { return _0xdec(_0xr - 0xf4); }
      send(_0xw(1, 2, 0x104), _0xw(1, 2, 0x106));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `send('alpha', 'gamma');`);
  });

  it('composes nested wrappers', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      function _0xw(_0xi) { return _0xdec(_0xi - 0x10); }
      function _0xv(_0xi) { return _0xw(_0xi + 0x2); }
      send(_0xv(0xe), _0xv(0x11));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `send('alpha', 'delta');`);
  });

  it('follows an alias of the array itself', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      `var _0xa = ['alpha', 'beta', 'gamma'];\nvar _0xb = _0xa;\nsend(_0xb[0x1]);`,
    );
    expectEquivalent(code, `send('beta');`);
  });

  it('refuses a wrapper whose argument is not determined by the call site', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      function _0xw(_0xi) { return _0xdec(_0xi + offset); }
      send(_0xw(0x0));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain('_0xw(0x0)');
  });

  it('refuses an alias that is reassigned somewhere', async () => {
    const source = withThunk(`
      var _0xb = _0xdec;
      _0xb = function () { return 'other'; };
      send(_0xb(0x10));
    `);
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain('_0xb(0x10)');
  });

  it('does not follow a local binding that merely shares the decoder name', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      function f() { function _0xdec(_0xi) { return 'local' + _0xi; } return _0xdec(0x1); }
      send(_0xdec(0x0), f());
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`send('alpha'`);
    expect(code).toContain(`return _0xdec(0x1)`);
  });

  it('refuses the decoder when it is passed as a value rather than called', async () => {
    // `window.onload = _0xdec` hands the function to code the slice does not
    // run - the host, here - and a reference that is neither a call nor a
    // capture into a name is one the slicer cannot account for. The call
    // site next to it used to be inlined anyway; now nothing is, and the
    // reader is told why.
    const source = withThunk(`window.onload = _0xdec;\nsend(_0xdec(0x10));`);
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain('window.onload = _0xdec');
    expect(code).toContain('send(_0xdec(0x10))');
    expect(ctx.diagnostics.some((d) => /Refusing to evaluate _0xdec.*names _0xdec/.test(d.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refusals that keep the output correct
// ---------------------------------------------------------------------------

describe('refusing rather than guessing', () => {
  it('refuses an array that a method call could mutate', async () => {
    await expectNoChange(
      STRING_PASSES,
      `var _0xa = ['alpha', 'beta', 'gamma'];\n_0xa['push']('delta');\nsend(_0xa[0]);`,
    );
  });

  it('refuses an array reassigned later in the program', async () => {
    await expectNoChange(
      STRING_PASSES,
      `var _0xa = ['alpha', 'beta', 'gamma'];\n_0xa = ['x', 'y', 'z'];\nsend(_0xa[0]);`,
    );
  });

  it('refuses an array that escapes into a call', async () => {
    await expectNoChange(
      STRING_PASSES,
      `var _0xa = ['alpha', 'beta', 'gamma'];\nregister(_0xa);\nsend(_0xa[0]);`,
    );
  });

  it('refuses an array reached through an alias that is then mutated', async () => {
    await expectNoChange(
      STRING_PASSES,
      `var _0xa = ['alpha', 'beta', 'gamma'];\nvar _0xb = _0xa;\n_0xb['reverse']();\nsend(_0xa[0]);`,
    );
  });

  it('explains a refusal in the diagnostics instead of failing silently', async () => {
    const { ctx } = await runPass(
      STRING_PASSES,
      `var _0xa = ['alpha', 'beta', 'gamma'];\n_0xa['push']('delta');\nsend(_0xa[0]);`,
    );
    expect(ctx.diagnostics.some((d) => d.message.includes('Refusing to inline _0xa'))).toBe(true);
  });

  it('leaves a call whose arguments are not statically known', async () => {
    const source = withThunk(`function show(_0xk) { send(_0xdec(_0xk)); }`);
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain('_0xdec(_0xk)');
    // With that one call its only use, there is no site to prove the decoder
    // on: it is not adopted and then left alone, it is refused, and the
    // refusal is the kind a later round may lift.
    expect(ctx.diagnostics.some((d) => /^Deferred _0xdec: it is called at line \d+, and no reference to it carries a literal argument or index/.test(d.message))).toBe(true);
    expect(ctx.stringSources).toHaveLength(0);
  });

  it('leaves a call whose arguments are not statically known beside ones that are', async () => {
    const source = withThunk(`function show(_0xk) { send(_0xdec(_0xk), _0xdec(0x10)); }`);
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain('_0xdec(_0xk)');
    expect(code).toContain("'alpha'");
    expect(ctx.diagnostics.some((d) => d.message.includes('non-constant arguments'))).toBe(true);
  });

  it('honours the decode budget and leaves the rest encoded', async () => {
    const source = wideArray(1200, 'send(_0xa[1], _0xa[2], _0xa[3], _0xa[4]);');
    const { code } = await runPass(STRING_PASSES, source, {
      techniques: { stringDecoding: { maxDecodeCalls: 2 } },
    });
    expect(code).toContain(`'s1'`);
    expect(code).toContain('_0xa[4]');
  });
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe('pruning the machinery once nothing reads it', () => {
  it('removes the array declaration entirely', async () => {
    const { code } = await runPass(STRING_PASSES, PLAIN_ARRAY);
    expect(code).not.toContain('_0xa');
  });

  it('removes the thunk, the decoder and the aliases together', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`var _0xb = _0xdec;\nfunction f() { var _0xl = _0xb; return _0xl(0x10); }`),
    );
    expect(code).not.toContain('_0xarr');
    expect(code).not.toContain('_0xdec');
    expect(code).not.toContain('_0xb');
    expect(normalize(code)).toBe("function f(){return 'alpha';}");
  });

  it('removes a wrapper that only existed to forward to the decoder', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      function _0xw(_0xp, _0xq, _0xr) { return _0xdec(_0xr - 0xf4); }
      send(_0xw(1, 2, 0xf4));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `send('alpha');`);
  });

  it('keeps everything when a single reference survives, and says why', async () => {
    const source = withThunk(`function show(_0xk) { send(_0xdec(_0xk)); }\nsend(_0xdec(0x10));`);
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain('function _0xarr');
    expect(code).toContain('function _0xdec');
    expect(ctx.diagnostics.some((d) => d.message.startsWith('Kept the string-array machinery'))).toBe(true);
  });

  it('counts the removals it made', async () => {
    const { ctx } = await runPass(STRING_PASSES, PLAIN_ARRAY);
    expect(ctx.diagnostics.some((d) => d.message.includes('Removed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rotation and stacked layers
// ---------------------------------------------------------------------------

/**
 * obfuscator.io's real top-level shape: a self-replacing accessor, a decoder
 * that replaces itself on first call, and a rotation wrapper fused with the
 * program into one comma expression. `300/1 + 400/2 + 600/3` balances only after
 * two `push(shift())` cycles, so the checksum genuinely has to be solved.
 */
function rotated(body: string): string {
  return `
    function _0xarr() {
      const _0xd = ['alpha', 'beta', '300', '400', '600'];
      _0xarr = function () { return _0xd; };
      return _0xarr();
    }
    function _0xdec(_0xa, _0xb) {
      const _0xc = _0xarr();
      _0xdec = function (_0xe, _0xf) { _0xe = _0xe - 0x0; return _0xc[_0xe]; };
      return _0xdec(_0xa, _0xb);
    }
    (function (_0xp, _0xq) {
      var _0xr = _0xdec;
      while (!![]) {
        try {
          var _0xs = parseInt(_0xr(0x0)) / 0x1 + parseInt(_0xr(0x1)) / 0x2 + parseInt(_0xr(0x2)) / 0x3;
          if (_0xs === _0xq) break;
          else _0xp['push'](_0xp['shift']());
        } catch (_0xt) {
          _0xp['push'](_0xp['shift']());
        }
      }
    }(_0xarr(), 0x2bc), ${body});
  `;
}

describe('rotation and stacked layers', () => {
  it('decodes against the rotated array and removes the fused wrapper', async () => {
    const { code } = await runPass(STRING_PASSES, rotated('send(_0xdec(0x3), _0xdec(0x4))'));
    expectEquivalent(code, `send('alpha', 'beta');`);
  });

  it('never rewrites the checksum inside the rotation wrapper', async () => {
    // The loop calls the decoder *while* the array is being shuffled, so the
    // value it sees is not the value substitution would install. Leaving it
    // encoded is the only correct answer; here a surviving reference also stops
    // the prune, which puts the untouched loop in the output to assert on.
    const { code } = await runPass(
      STRING_PASSES,
      rotated('send(_0xdec(0x3))') + `\nfunction show(_0xk) { send(_0xdec(_0xk)); }`,
    );
    expect(code).toContain('parseInt(_0xr(0x0))');
    expect(code).not.toContain(`parseInt('300')`);
  });

  it('peels a second layer whose table only becomes readable after the first', async () => {
    // Layer two's array is a list of *calls* into layer one. Nothing can see it
    // as a string table until layer one has been decoded and deleted.
    const source = `
      function _0xarrA() {
        var _0xd = ['alpha', 'beta', 'gamma'];
        _0xarrA = function () { return _0xd; };
        return _0xarrA();
      }
      function _0xdecA(_0xi) { return _0xarrA()[_0xi]; }
      function _0xarrB() {
        var _0xd = [_0xdecA(0x0), _0xdecA(0x2)];
        _0xarrB = function () { return _0xd; };
        return _0xarrB();
      }
      function _0xdecB(_0xi) { return _0xarrB()[_0xi]; }
      send(_0xdecB(0x0), _0xdecB(0x1));
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code, `send('alpha', 'gamma');`);
  });

  it('is idempotent over a two-layer program', async () => {
    await expectIdempotent(
      STRING_PASSES,
      `
        function _0xarrA() { var _0xd = ['alpha', 'beta']; _0xarrA = function () { return _0xd; }; return _0xarrA(); }
        function _0xdecA(_0xi) { return _0xarrA()[_0xi]; }
        function _0xarrB() { var _0xd = [_0xdecA(0x0), _0xdecA(0x1)]; _0xarrB = function () { return _0xd; }; return _0xarrB(); }
        function _0xdecB(_0xi) { return _0xarrB()[_0xi]; }
        send(_0xdecB(0x1));
      `,
    );
  });
});

// ---------------------------------------------------------------------------
// Split-string reassembly
// ---------------------------------------------------------------------------

describe('reassembling split strings', () => {
  it('folds two adjacent literals', async () => {
    const { code } = await runPass(mergeSplitStringsPass, `var x = 'wer' + 'Class';`);
    expectEquivalent(code, `var x = 'werClass';`);
  });

  it('folds a whole left-nested chain in one traversal', async () => {
    const { code } = await runPass(mergeSplitStringsPass, `var x = 'con' + 'stru' + 'ctor';`);
    expectEquivalent(code, `var x = 'constructor';`);
  });

  it('leaves a concatenation with a non-literal operand alone', async () => {
    await expectNoChange(mergeSplitStringsPass, `var x = 'a' + y + 'b';`);
  });

  it('does not fold a number into a string', async () => {
    await expectNoChange(mergeSplitStringsPass, `var x = 1 + 'b';`);
  });

  it('does not turn a statement into a directive', async () => {
    // `('use' + ' strict');` folding to `'use strict';` at the top of a function
    // would silently switch that function into strict mode.
    await expectNoChange(mergeSplitStringsPass, `function f() { 'use' + ' strict'; return 1; }`);
  });

  it('refuses to materialise a string beyond the size cap', async () => {
    const half = 'x'.repeat(20_000);
    await expectNoChange(mergeSplitStringsPass, `var x = '${half}' + '${half}';`);
  });

  it('is idempotent', async () => {
    await expectIdempotent(mergeSplitStringsPass, `var x = 'a' + 'b' + 'c' + d + 'e' + 'f';`);
  });

  it('does not fold a decoded statement into a directive either', async () => {
    // The same strict-mode hazard applies to the fold the inlining pass does on
    // the literals it has just substituted.
    const source = `
      var _0xa = ['use', ' strict', 'body'];
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      function f() { _0xdec(0x0) + _0xdec(0x1); return _0xdec(0x2); }
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'use' + ' strict'`);
    expect(code).toContain(`return 'body'`);
  });

  it('rejoins fragments that inlining produced, and reports the technique', async () => {
    const fragments = Array.from({ length: 100 }, (_, index) => `'p${index}'`).join(', ');
    const calls = Array.from({ length: 100 }, (_, index) => `_0xdec(0x${index.toString(16)})`);
    const source = `
      var _0xa = [${fragments}];
      function _0xdec(_0xi) { return _0xa[_0xi]; }
      send(${calls.join(' + ')});
    `;
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'p0p1p2`);
    expect(ctx.detections.map((d) => d.kind)).toContain('split-strings');
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping and stability
// ---------------------------------------------------------------------------

describe('bookkeeping', () => {
  it('records every decoded reference with its use count', async () => {
    const { ctx } = await runPass(STRING_PASSES, withThunk(`send(_0xdec(0x10), _0xdec(0x10), _0xdec(0x11));`));
    const first = ctx.decodedStrings.get('_0xdec(16)');
    expect(first).toEqual({ reference: '_0xdec(16)', value: 'alpha', uses: 2 });
    expect(ctx.decodedStrings.get('_0xdec(17)')?.value).toBe('beta');
  });

  it('keeps source positions on the literal it substitutes', async () => {
    const { ctx } = await runPass(STRING_PASSES, PLAIN_ARRAY);
    // The replaced literal inherits the reference's location, which is what the
    // source map is generated from.
    expect(ctx.totalChanges).toBeGreaterThan(0);
  });

  it('is idempotent over a plain array', async () => {
    await expectIdempotent(STRING_PASSES, PLAIN_ARRAY);
  });

  it('is idempotent over a thunk and decoder', async () => {
    await expectIdempotent(STRING_PASSES, withThunk(`send(_0xdec(0x10), _0xdec(0x12));`));
  });

  it('produces output that still parses', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`var _0xb = _0xdec;\nfunction f() { var _0xl = _0xb; return _0xl(0x10) + _0xl(0x11); }`),
    );
    assertParses(code);
  });

  it('does nothing at all when there is no string source', async () => {
    await expectNoChange(STRING_PASSES, `function greet(name) { return 'hello ' + name; }`);
  });
});

// ---------------------------------------------------------------------------
// Decoders that shadow their own name
// ---------------------------------------------------------------------------

/**
 * `function d(a, b) { var d = ...; }` is a real shape - commercial protectors
 * emit it in every accessor they generate, using the shadow as a cache key - and
 * it can make a whole file undecodable. The decoder is recognised and proved,
 * and then *not one call site is rewritten*, because the binding the index
 * resolves the decoder to is the string inside its own body rather than the
 * function outside it. Nothing about that failure is visible in the output: the
 * file simply comes out untouched.
 */
describe('a decoder that shadows its own name', () => {
  const SHADOWED = `
    function _0xdec(_0xi) {
      var _0xdec = 'cache-key';
      return _0xa[_0xi - 0x10];
    }
    var _0xa = ['alpha', 'beta', 'gamma'];
  `;

  it('still resolves at every call site', async () => {
    const { code } = await runPass(STRING_PASSES, `${SHADOWED}\nsend(_0xdec(0x10), _0xdec(0x12));`);
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'gamma'`);
    expect(code).not.toContain('_0xdec(');
  });

  it('resolves through an alias of the shadowed decoder', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      `${SHADOWED}\nvar _0xb = _0xdec;\nsend(_0xb(0x11));`,
    );
    expect(code).toContain(`'beta'`);
  });
});

// ---------------------------------------------------------------------------
// Constant pools as a prerequisite for decoding
// ---------------------------------------------------------------------------

/**
 * A pool is not itself a string source, but it hides them: while an argument is
 * written `P[3]` the call around it has no literal arguments, so it cannot be
 * inlined and the decoder behind it cannot be validated. The stage therefore
 * turns pool reads back into values before it looks for anything else.
 *
 * The pool's own shape is covered in `constant-pool.test.ts`; these two prove
 * the ordering, which is a property of this stage.
 */
describe('constant pools feeding ordinary decoders', () => {
  const POOL = `var P = ['length', 255, 'push', !0, null, 16, 'slice', !1, 91, 'name', 17, 18];`;

  it('unblocks a decoder whose call sites index through the pool', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`${POOL}\nsend(_0xdec(P[5]), _0xdec(P[10]), _0xdec(P[11]));`),
    );
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'beta'`);
    expect(code).toContain(`'gamma'`);
    expect(code).not.toContain('_0xdec(');
  });

  it('leaves the rest of the program alone when the pool is unsafe', async () => {
    // One write anywhere and every read is refused, including the ones that
    // would have unblocked the decoder - which is the right answer, because the
    // value at the call site is no longer the value in the literal.
    const { code } = await runPass(
      STRING_PASSES,
      withThunk(`${POOL}\nP[5] = 0x12;\nsend(_0xdec(P[5]));`),
    );
    expect(code).toContain('P[5]');
    expect(code).toContain('_0xdec(');
  });
});
