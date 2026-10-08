import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { recogniseEncoding, rotateLetters } from '../src/analysis/evaluator/native.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

/**
 * A ROT-n decoder's shift is the constant it adds to a character code
 * before the wrap, and nothing else in the body: an index offset or a
 * table length in the same range is not a shift. A body that adds two
 * different constants, or none, has no single shift to read.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

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
  return found;
}

function decoderBody(source: string, name: string): t.Function {
  let found: t.Function | undefined;
  programPath(source).traverse({
    Function(path) {
      if (found) return;
      const parent = path.parent;
      if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && parent.id.name === name) {
        found = path.node;
      }
    },
  });
  if (!found) throw new Error(`no function ${name}`);
  return found;
}

function trace(code: string): string {
  const lines: string[] = [];
  const log = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === 'string' ? JSON.stringify(a) : String(a))).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout: 2_000 });
  } catch (error) {
    lines.push(`THROWN ${(error as Error).name}`);
  }
  return lines.join('\n');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

const list = (values: readonly string[]): string => values.map((v) => JSON.stringify(v)).join(', ');

/** The decoder adds `shift` past an index offset of `offset`, wrapping at the letter bounds. */
function addingFixture(plaintexts: readonly string[], shift: number, offset: number): string {
  const encoded = plaintexts.map((text) => rotateLetters(text, 26 - shift));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      return _0xarr[_0x1 - ${offset}]['replace'](/[a-zA-Z]/g, function (_0x2) {
        return String['fromCharCode']((_0x2 <= 'Z' ? 90 : 122) >= (_0x2 = _0x2['charCodeAt'](0) + ${shift}) ? _0x2 : _0x2 - 26);
      });
    };
    log(_0xdec(${offset}), _0xdec(${offset + 1}));
  `;
}

/** The same decoder with the callback declared ahead of the offset lookup. */
function callbackFirstFixture(plaintexts: readonly string[], shift: number, offset: number): string {
  const encoded = plaintexts.map((text) => rotateLetters(text, 26 - shift));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      var _0x5 = function (_0x2) {
        return String['fromCharCode']((_0x2 <= 'Z' ? 90 : 122) >= (_0x2 = _0x2['charCodeAt'](0) + ${shift}) ? _0x2 : _0x2 - 26);
      };
      return _0xarr[_0x1 - ${offset}]['replace'](/[a-zA-Z]/g, _0x5);
    };
    log(_0xdec(${offset}), _0xdec(${offset + 1}));
  `;
}

/** The decoder subtracts `back` and wraps upward: a shift of 26 - back. */
function subtractingFixture(plaintexts: readonly string[], back: number): string {
  const encoded = plaintexts.map((text) => rotateLetters(text, back));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      return _0xarr[_0x1]['replace'](/[a-zA-Z]/g, function (_0x2) {
        var _0x3 = (_0x2 <= 'Z' ? 90 : 122) - 25;
        var _0x4 = _0x2['charCodeAt'](0) - ${back};
        return String['fromCharCode'](_0x4 < _0x3 ? _0x4 + 26 : _0x4);
      });
    };
    log(_0xdec(0), _0xdec(1));
  `;
}

/** The modular spelling: `(code - base + shift) % 26 + base`. */
function modularFixture(plaintexts: readonly string[], shift: number): string {
  const encoded = plaintexts.map((text) => rotateLetters(text, 26 - shift));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      return _0xarr[_0x1]['replace'](/[a-zA-Z]/g, function (_0x2) {
        var _0x3 = (_0x2 <= 'Z' ? 90 : 122) - 25;
        return String['fromCharCode']((_0x2['charCodeAt'](0) - _0x3 + ${shift}) % 26 + _0x3);
      });
    };
    log(_0xdec(0), _0xdec(1));
  `;
}

const WORDS = ['hello world', 'Mixed Case Text'];

describe('the shift of a ROT-n decoder', () => {
  it('is the constant added to the character code, not the index offset before it', () => {
    const encoding = recogniseEncoding(decoderBody(addingFixture(WORDS, 21, 5), '_0xdec'));
    expect(encoding).toMatchObject({ algorithm: 'rot', amount: 21 });
  });

  it('is the constant added to the character code whichever comes first in the body', () => {
    const encoding = recogniseEncoding(decoderBody(callbackFirstFixture(WORDS, 21, 5), '_0xdec'));
    expect(encoding).toMatchObject({ algorithm: 'rot', amount: 21 });
  });

  it('is thirteen for rot13', () => {
    const encoding = recogniseEncoding(decoderBody(addingFixture(WORDS, 13, 0), '_0xdec'));
    expect(encoding).toMatchObject({ algorithm: 'rot', amount: 13 });
  });

  it('is the complement of a subtracted constant', () => {
    const encoding = recogniseEncoding(decoderBody(subtractingFixture(WORDS, 5), '_0xdec'));
    expect(encoding).toMatchObject({ algorithm: 'rot', amount: 21 });
  });

  it('is read through the modular spelling', () => {
    const encoding = recogniseEncoding(decoderBody(modularFixture(WORDS, 7), '_0xdec'));
    expect(encoding).toMatchObject({ algorithm: 'rot', amount: 7 });
  });

  it('is not read from a body that adds two different constants', () => {
    const source = `
      var _0xdec = function (_0x1) {
        return _0xarr[_0x1]['replace'](/[a-zA-Z]/g, function (_0x2) {
          var _0x3 = _0x2['charCodeAt'](0) + 13;
          var _0x4 = _0x2['charCodeAt'](0) + 7;
          return String['fromCharCode']((_0x2 <= 'Z' ? 90 : 122) >= _0x3 ? _0x4 : _0x3 - 26);
        });
      };
    `;
    expect(recogniseEncoding(decoderBody(source, '_0xdec'), )).toBeNull();
  });

  it('is not read from a body whose wrap constants stand beside no shift', () => {
    const source = `
      var _0xdec = function (_0x1) {
        return _0xarr[_0x1 - 3]['replace'](/[a-zA-Z]/g, function (_0x2) {
          var _0x3 = _0x2['charCodeAt'](0) * 2 - 26;
          return String['fromCharCode'](_0x3 > 122 ? 122 : _0x3);
        });
      };
    `;
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toBeNull();
  });
});

describe('ROT-n decoders, end to end', () => {
  const sources: [string, string][] = [
    ['rot21 past an index offset of 5', addingFixture(WORDS, 21, 5)],
    ['rot21 with its callback declared first', callbackFirstFixture(WORDS, 21, 5)],
    ['rot13', addingFixture(WORDS, 13, 0)],
    ['rot21 written as a subtraction', subtractingFixture(WORDS, 5)],
    ['rot7 written modularly', modularFixture(WORDS, 7)],
  ];

  for (const [title, source] of sources) {
    for (const preset of PRESETS) {
      it(`decodes ${title} to what the program prints at ${preset}`, async () => {
        const code = await output(source, preset);
        expect(trace(code)).toBe(trace(source));
      });
    }
    it(`inlines the plaintext of ${title} at balanced`, async () => {
      const code = await output(source, 'balanced');
      expect(code).toContain("'hello world'");
    });
  }
});
