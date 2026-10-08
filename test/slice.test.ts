import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { isSelfContained, sliceForEvaluation } from '../src/analysis/slice.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

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

/** The canonical obfuscator.io shape: array fn, rotation IIFE, decoder fn. */
const OBFUSCATOR_SHAPE = `
function _0xarr() { const _0xlocal = ['alpha', 'beta', 'gamma']; _0xarr = function () { return _0xlocal; }; return _0xarr(); }
function _0xdec(_0xa, _0xb) { const _0xc = _0xarr(); _0xdec = function (_0xd, _0xe) { _0xd = _0xd - 0x0; return _0xc[_0xd]; }; return _0xdec(_0xa, _0xb); }
(function (_0xf, _0xg) { const _0xh = _0xdec; while (true) { try { if (_0xg === parseInt(_0xh(0x0)) / 1) break; _0xf.push(_0xf.shift()); } catch (e) { _0xf.push(_0xf.shift()); } } })(_0xarr(), 123);
console.log(_0xdec(0x1));
`;

describe('sliceForEvaluation', () => {
  it('treats a decoder with locals and parameters as self-contained', () => {
    // Regression guard: a walk that counts every identifier as a reference
    // classifies the decoder's own parameters and inner consts as free
    // variables, which makes every real decoder look un-evaluatable.
    const slice = sliceForEvaluation(programOf(OBFUSCATOR_SHAPE), ['_0xdec']);
    expect([...slice.freeNames]).toEqual([]);
    expect(isSelfContained(slice)).toBe(true);
  });

  it('pulls in the rotation IIFE, which declares nothing but reorders the array', () => {
    const slice = sliceForEvaluation(programOf(OBFUSCATOR_SHAPE), ['_0xdec']);
    const printed = JSON.stringify(slice.statements);
    expect(printed).toContain('shift');
    expect(slice.definedNames.has('_0xarr')).toBe(true);
    expect(slice.definedNames.has('_0xdec')).toBe(true);
  });

  it('excludes unrelated program statements', () => {
    const slice = sliceForEvaluation(programOf(OBFUSCATOR_SHAPE), ['_0xdec']);
    expect(JSON.stringify(slice.statements)).not.toContain('console');
  });

  it('reports a genuine free reference as not self-contained', () => {
    const slice = sliceForEvaluation(
      programOf(`function dec(i) { return document.title + i; }`),
      ['dec'],
    );
    expect([...slice.freeNames]).toContain('document');
    expect(isSelfContained(slice)).toBe(false);
  });

  it('allows pure built-ins without treating them as free', () => {
    const slice = sliceForEvaluation(
      programOf(`function dec(i) { return String.fromCharCode(Math.abs(i) + parseInt('65', 10)); }`),
      ['dec'],
    );
    expect([...slice.freeNames]).toEqual([]);
    expect(isSelfContained(slice)).toBe(true);
  });
});
