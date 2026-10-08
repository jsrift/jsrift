import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { isSelfContained, sliceForEvaluation } from '../src/analysis/slice.js';
import { findStringSourceCandidates } from '../src/analysis/string-array.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { mergeSplitStringsPass } from '../src/passes/strings/merge-split.js';
import { pruneDecodersPass } from '../src/passes/strings/prune-decoders.js';
import type { Pass } from '../src/pipeline/pass.js';
import { expectIdempotent, expectNoChange, runPass } from './helpers.js';

/**
 * String arrays that live inside a function scope.
 *
 * Every bundler on earth - webpack, Next.js, Vite, and every hand-rolled
 * `;(function(){ ... })();` wrapper - puts the module body inside a function.
 * Discovery and slicing that work only on the program's own statement list
 * propose nothing, decode nothing, and report success - for the single most
 * common shape of real bundled JavaScript.
 */

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

const STRING_PASSES: Pass[] = [
  mergeSplitStringsPass,
  discoverStringsPass,
  inlineStringsPass,
  pruneDecodersPass,
];

function programOf(code: string): NodePath<t.Program> {
  const ast = parse(code, { sourceType: 'script' });
  let program!: NodePath<t.Program>;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

/** The canonical module wrapper: one IIFE around an array, a decoder and code. */
function iife(body: string): string {
  return `;(function () {\n${body}\n})();`;
}

const MODULE = iife(`
  var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
  function _0xdec(_0xi) { return _0xa[_0xi - 0x10]; }
  send(_0xdec(0x10), _0xdec(0x12));
`);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('finding a string array inside a function scope', () => {
  it('proposes a candidate for an array declared in an IIFE', () => {
    const candidates = findStringSourceCandidates(programOf(MODULE));
    expect(candidates.map((c) => c.arrayName)).toContain('_0xa');
    expect(candidates.some((c) => c.decoderName === '_0xdec')).toBe(true);
  });

  it('anchors the candidate on the scope, not the program', () => {
    const program = programOf(MODULE);
    const candidate = findStringSourceCandidates(program).find((c) => c.kind === 'wrapper-call')!;
    expect(candidate.scope.node).not.toBe(program.node);
    expect(candidate.scope.isBlockStatement()).toBe(true);
  });

  it('decodes and prunes an array and decoder inside an IIFE', async () => {
    const { code } = await runPass(STRING_PASSES, MODULE);
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'gamma'`);
    expect(code).not.toContain('_0xa');
    expect(code).not.toContain('_0xdec');
  });

  it('reaches an array two function scopes down', async () => {
    const source = iife(`
      function makeModule() {
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xdec(_0xi) { return _0xa[_0xi]; }
        return _0xdec(0x0) + _0xdec(0x2);
      }
      send(makeModule());
    `);
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`return 'alphagamma'`);
  });

  it('reaches an array inside a bare block, not only a function body', async () => {
    const source = `
      {
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xdec(_0xi) { return _0xa[_0xi]; }
        send(_0xdec(0x1));
      }
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'beta'`);
  });

  it('finds a plain indexed table in a module with no decoder at all', async () => {
    const source = iife(`
      var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
      send(_0xa[0x0], _0xa[1e0], _0xa[3]);
    `);
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`send('alpha', 'beta', 'delta')`);
    expect(code).not.toContain('_0xa');
  });
});

// ---------------------------------------------------------------------------
// Many independent modules in one file
// ---------------------------------------------------------------------------

describe('one file, many modules', () => {
  it('decodes two sibling IIFEs whose tables share a name', async () => {
    // The single most important property of the whole feature: `_0xa` in module
    // one and `_0xa` in module two are different arrays holding different
    // strings, and a name-keyed engine decodes half the file against the wrong
    // table - confidently, and without any signal that it did.
    const source = [
      iife(`
        var _0xa = ['alpha', 'beta'];
        function _0xd(_0xi) { return _0xa[_0xi]; }
        first(_0xd(0x0), _0xd(0x1));
      `),
      iife(`
        var _0xa = ['gamma', 'delta'];
        function _0xd(_0xi) { return _0xa[_0xi]; }
        second(_0xd(0x0), _0xd(0x1));
      `),
    ].join('\n');

    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`first('alpha', 'beta')`);
    expect(code).toContain(`second('gamma', 'delta')`);
  });

  it('gives each module its own index offset and rotation', async () => {
    const source = [
      iife(`
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xd(_0xi) { return _0xa[_0xi - 0x10]; }
        first(_0xd(0x11));
      `),
      iife(`
        var _0xb = ['delta', 'epsilon', 'zeta'];
        (function (_0xp, _0xq) { while (_0xq--) { _0xp['push'](_0xp['shift']()); } })(_0xb, 1);
        function _0xe(_0xi) { return _0xb[_0xi - 0x100]; }
        second(_0xe(0x100));
      `),
    ].join('\n');

    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`first('beta')`);
    // One `push(shift())` moves 'delta' to the back, so index 0 is 'epsilon'.
    expect(code).toContain(`second('epsilon')`);
  });

  it('reports every module, not just the first', async () => {
    const source = [
      iife(`var _0xa = ['alpha', 'beta'];\nfirst(_0xa[0], _0xa[1]);`),
      iife(`var _0xb = ['gamma', 'delta'];\nsecond(_0xb[0], _0xb[1]);`),
    ].join('\n');
    const { ctx } = await runPass(STRING_PASSES, source);
    expect(ctx.detections.filter((d) => d.kind === 'string-array')).toHaveLength(2);
  });

  it('counts a second module even when its table shares the first one\'s name', async () => {
    // The two modules produce the same evidence string, so the context folds
    // them into one detection - but the *count* has to come from both, which it
    // only does if the second module was fingerprinted separately rather than
    // dismissed as "already seen `_0xa`".
    const source = [
      iife(`var _0xa = ['alpha', 'beta'];\nfirst(_0xa[0], _0xa[1]);`),
      iife(`var _0xa = ['gamma', 'delta'];\nsecond(_0xa[0], _0xa[1]);`),
    ].join('\n');
    const { ctx } = await runPass(STRING_PASSES, source);
    const array = ctx.detections.find((d) => d.kind === 'string-array');
    expect(array?.count).toBe(4);
  });

  it('decodes far more modules than the old eight-candidate budget allowed', async () => {
    const modules = Array.from({ length: 24 }, (_, module) =>
      iife(`
        var _0xa = ['m${module}a', 'm${module}b', 'm${module}c'];
        function _0xd(_0xi) { return _0xa[_0xi]; }
        send${module}(_0xd(0x0), _0xd(0x2));
      `),
    ).join('\n');

    const { code } = await runPass(STRING_PASSES, modules);
    for (let module = 0; module < 24; module++) {
      expect(code).toContain(`send${module}('m${module}a', 'm${module}c')`);
    }
  });
});

// ---------------------------------------------------------------------------
// Reaching out of the scope
// ---------------------------------------------------------------------------

describe('a slice that needs a binding from an enclosing scope', () => {
  it('borrows a constant the decoder reads, and decodes with it', () => {
    const source = `
      var _0xoffset = 0x10;
      ;(function () {
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xdec(_0xi) { return _0xa[_0xi - _0xoffset]; }
        send(_0xdec(0x11));
      })();
    `;
    const program = programOf(source);
    const candidate = findStringSourceCandidates(program).find((c) => c.kind === 'wrapper-call')!;
    const slice = sliceForEvaluation(program, candidate.roots);

    expect(isSelfContained(slice)).toBe(true);
    expect(slice.definedNames.has('_0xoffset')).toBe(true);
    expect(JSON.stringify(slice.statements)).toContain('_0xoffset');
  });

  it('decodes end to end against the borrowed constant', async () => {
    const source = `
      var _0xoffset = 0x10;
      ;(function () {
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xdec(_0xi) { return _0xa[_0xi - _0xoffset]; }
        send(_0xdec(0x11));
      })();
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`send('beta')`);
  });

  it('never deletes the borrowed declaration, which the rest of the file may read', async () => {
    const source = `
      var _0xoffset = 0x10;
      ;(function () {
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xdec(_0xi) { return _0xa[_0xi - _0xoffset]; }
        send(_0xdec(0x11));
      })();
      elsewhere(_0xoffset);
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain('var _0xoffset = 0x10');
    expect(code).toContain('elsewhere(_0xoffset)');
  });

  it('refuses when the enclosing binding is reassigned rather than constant', async () => {
    // The decoder would evaluate against `0x10`, but by the time a call site
    // runs the offset is `0x20` and every decoded literal is off by sixteen.
    // Leaving the file encoded is the only honest answer.
    const source = `
      var _0xoffset = 0x10;
      _0xoffset = 0x20;
      ;(function () {
        var _0xa = ['alpha', 'beta', 'gamma'];
        function _0xdec(_0xi) { return _0xa[_0xi - _0xoffset]; }
        send(_0xdec(0x11));
      })();
    `;
    await expectNoChange(STRING_PASSES, source);
  });

  it('refuses when the enclosing scope reaches the host', async () => {
    const source = iife(`
      var _0xa = ['alpha', 'beta'];
      function _0xdec(_0xi) { return _0xa[_0xi] + document.title; }
      send(_0xdec(0x0));
    `);
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain('_0xdec(0x0)');
    expect(ctx.diagnostics.some((d) => d.message.includes('document'))).toBe(true);
  });

  it('refuses when a wrapper outside the scope rotates the borrowed table', async () => {
    // The rotation wrapper is a sibling of the array, one scope out from the
    // decoder. Evaluating the decoder without it decodes against the unrotated
    // order; taking it would mean protecting it from inlining through a channel
    // the slice does not have. Refusing is the only sound option.
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      (function (_0xp, _0xq) { while (_0xq--) { _0xp['push'](_0xp['shift']()); } })(_0xa, 1);
      ;(function () {
        function _0xdec(_0xi) { return _0xa[_0xi]; }
        send(_0xdec(0x0));
      })();
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain('_0xdec(0x0)');
    expect(code).not.toContain(`send('alpha')`);
  });

  it('never drags the enclosing IIFE itself into the slice', () => {
    const source = `
      ;(function (_0xw) {
        var _0xa = ['alpha', 'beta'];
        function _0xdec(_0xi) { return _0xa[_0xi]; }
        _0xw.fetch('/beacon');
        send(_0xdec(0x0));
      })(window);
    `;
    const program = programOf(source);
    const candidate = findStringSourceCandidates(program).find((c) => c.kind === 'wrapper-call')!;
    const slice = sliceForEvaluation(program, candidate.roots);
    const printed = JSON.stringify(slice.statements);

    expect(printed).not.toContain('beacon');
    expect(printed).not.toContain('window');
    expect(isSelfContained(slice)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The decoder and its array in different scopes
// ---------------------------------------------------------------------------

describe('a decoder in a different scope from its array', () => {
  it('slices from the decoder scope and borrows the array', () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      ;(function () {
        function _0xdec(_0xi) { return _0xa[_0xi]; }
        send(_0xdec(0x0), _0xdec(0x2));
      })();
    `;
    const program = programOf(source);
    const candidate = findStringSourceCandidates(program).find((c) => c.kind === 'wrapper-call');
    expect(candidate?.decoderName).toBe('_0xdec');
    expect(candidate?.arrayName).toBe('_0xa');

    const slice = sliceForEvaluation(program, candidate!.roots);
    expect(isSelfContained(slice)).toBe(true);
    expect(slice.definedNames.has('_0xa')).toBe(true);
    expect(slice.definedNames.has('_0xdec')).toBe(true);
  });

  it('decodes through it end to end', async () => {
    const source = `
      var _0xa = ['alpha', 'beta', 'gamma'];
      ;(function () {
        function _0xdec(_0xi) { return _0xa[_0xi]; }
        send(_0xdec(0x0), _0xdec(0x2));
      })();
    `;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`send('alpha', 'gamma')`);
  });
});

// ---------------------------------------------------------------------------
// Shadowing, safety and stability
// ---------------------------------------------------------------------------

describe('nested discovery stays sound', () => {
  it('does not decode a call against a same-named table in a sibling module', async () => {
    // Module two's `_0xa` has only two entries, so `_0xd(0x2)` there is out of
    // range and must stay as written. Resolving `_0xd` by name would reach
    // module one's four-entry table and answer 'gamma' - a confident literal
    // where the program produces `undefined`, and nothing in the output to
    // suggest anything went wrong.
    const source = [
      iife(`
        var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
        function _0xd(_0xi) { return _0xa[_0xi]; }
        first(_0xd(0x0));
      `),
      iife(`
        var _0xa = ['epsilon', 'zeta'];
        function _0xd(_0xi) { return _0xa[_0xi]; }
        second(_0xd(0x2), _0xd(0x0));
      `),
    ].join('\n');

    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`first('alpha')`);
    expect(code).toContain(`second(_0xd(0x2), 'epsilon')`);
    expect(code).not.toContain(`second('gamma'`);
    expect(code).not.toContain(`'gamma', 'epsilon'`);
  });

  it('refuses a nested array that a method call could mutate', async () => {
    await expectNoChange(
      STRING_PASSES,
      iife(`var _0xa = ['alpha', 'beta', 'gamma'];\n_0xa['push']('delta');\nsend(_0xa[0]);`),
    );
  });

  it('leaves a nested array of non-strings alone', async () => {
    await expectNoChange(STRING_PASSES, iife(`var _0xa = [1, 2, 3];\nsend(_0xa[0]);`));
  });

  it('is idempotent over a nested module', async () => {
    await expectIdempotent(STRING_PASSES, MODULE);
  });

  it('is idempotent over two sibling modules with colliding names', async () => {
    await expectIdempotent(
      STRING_PASSES,
      [
        iife(`var _0xa = ['alpha', 'beta'];\nfunction _0xd(_0xi) { return _0xa[_0xi]; }\nfirst(_0xd(0x0));`),
        iife(`var _0xa = ['gamma', 'delta'];\nfunction _0xd(_0xi) { return _0xa[_0xi]; }\nsecond(_0xd(0x1));`),
      ].join('\n'),
    );
  });

  it('produces output that still parses after nested inlining', async () => {
    const { code } = await runPass(STRING_PASSES, MODULE);
    expect(() => parse(code, { sourceType: 'script' })).not.toThrow();
  });
});
