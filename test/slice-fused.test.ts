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

/**
 * The real obfuscator.io fixture fuses the rotation wrapper and the entire 3 MB
 * program into a single comma expression as top-level statement [0]. A slicer
 * working at statement granularity takes both or neither, which puts the whole
 * user program inside the sandbox and makes every decoder unevaluatable.
 */
const FUSED = [
  "function _0xarr() { return ['alpha', 'beta']; }",
  'function _0xdec(_0xa) { return _0xarr()[_0xa]; }',
  '(function (_0xf, _0xg) { while (_0xg--) { _0xf.push(_0xf.shift()); } }(_0xarr(), 2),',
  "!function (_0xw, _0xj) { _0xw.document.title = _0xdec(0x0); fetch('/beacon'); }(window, window['jQuery']));",
].join('\n');

describe('slicing a sequence-fused top level', () => {
  it('takes the rotation wrapper but not the fused program IIFE', () => {
    const slice = sliceForEvaluation(programOf(FUSED), ['_0xdec']);
    const printed = JSON.stringify(slice.statements);
    expect(printed).toContain('shift');
    expect(printed).not.toContain('fetch');
    expect(printed).not.toContain('beacon');
    expect(isSelfContained(slice)).toBe(true);
  });

  it('does not mistake a value read for a handoff of the closure itself', () => {
    // The program IIFE is invoked as `f(window, window['jQuery'])`. Reading from
    // a closure name in an argument is not the same as passing the array in for
    // mutation, and treating it as such pulls the whole program into the slice.
    const slice = sliceForEvaluation(programOf(FUSED), ['_0xdec']);
    expect([...slice.freeNames]).toEqual([]);
  });

  it('still recognises a genuine handoff of the array by name', () => {
    const source = [
      "var _0xarr = ['alpha', 'beta'];",
      'function _0xdec(_0xa) { return _0xarr[_0xa]; }',
      '(function (_0xf, _0xg) { while (_0xg--) { _0xf.push(_0xf.shift()); } })(_0xarr, 2);',
    ].join('\n');
    const slice = sliceForEvaluation(programOf(source), ['_0xdec']);
    expect(JSON.stringify(slice.statements)).toContain('shift');
  });

  it('keeps a plain call site out of the slice', () => {
    const source = [
      "var _0xarr = ['alpha'];",
      'function _0xdec(_0xa) { return _0xarr[_0xa]; }',
      'console.log(_0xdec(0), document.title);',
    ].join('\n');
    const slice = sliceForEvaluation(programOf(source), ['_0xdec']);
    expect(JSON.stringify(slice.statements)).not.toContain('console');
    expect(isSelfContained(slice)).toBe(true);
  });
});
