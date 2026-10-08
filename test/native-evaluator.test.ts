import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { obfuscate, type ObfuscatorOptions } from 'javascript-obfuscator';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import {
  base64ToBytes,
  bytesToUtf8,
  collectArgumentForwarders,
  constantNumber,
  rc4,
  recogniseEncoding,
  recogniseIndexOffset,
  recogniseNativeDecoder,
  recogniseStringArray,
  resolveForwardedCall,
  rotateArray,
  rotateLetters,
  shiftChars,
  xorWithCode,
  xorWithKey,
  STANDARD_BASE64_ALPHABET,
  type NativeDecoder,
} from '../src/analysis/evaluator/native.js';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { findStringSourceCandidates } from '../src/analysis/string-array.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import type { Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

function recognise(source: string, roots: string[]) {
  const program = programPath(source);
  return recogniseNativeDecoder(sliceForEvaluation(program, roots), roots);
}

/** The single expression of a one-statement program, for constant folding. */
function programExpression(source: string): t.Expression {
  const statement = programPath(`(${source});`).node.body[0];
  if (!statement || statement.type !== 'ExpressionStatement') throw new Error('not an expression');
  return statement.expression;
}

/** The decoder function body, already unwrapped the way a recogniser sees it. */
function decoderBody(source: string, name: string): t.Function {
  const program = programPath(source);
  let found: t.Function | undefined;
  program.traverse({
    Function(path) {
      if (found) return;
      const node = path.node;
      const id =
        'id' in node && node.id && node.id.type === 'Identifier' ? node.id.name : undefined;
      const parent = path.parent;
      const declared =
        parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
          ? parent.id.name
          : undefined;
      if (id === name || declared === name) found = node as t.Function;
    },
  });
  if (!found) throw new Error(`no function named ${name}`);
  return found;
}

interface Recorded {
  severity: Severity;
  message: string;
}

function build(source: string, roots: string[], options: Parameters<typeof resolveConfig>[0] = {}) {
  const notes: Recorded[] = [];
  const config = resolveConfig(options);
  const decoder = buildDecoder(programPath(source), roots, config, {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
}

// ---------------------------------------------------------------------------
// Fixture encoders - written from the published algorithms, deliberately
// independent of the implementations under test.
// ---------------------------------------------------------------------------

function utf8Base64(text: string, alphabet = STANDARD_BASE64_ALPHABET): string {
  const standard = Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '');
  if (alphabet === STANDARD_BASE64_ALPHABET) return standard;
  return [...standard]
    .map((char) => alphabet[STANDARD_BASE64_ALPHABET.indexOf(char)]!)
    .join('');
}

/** What `btoa` does: one byte per code unit, no UTF-8 expansion. */
function latin1Base64(text: string): string {
  return Buffer.from(text, 'latin1').toString('base64').replace(/=+$/, '');
}

function rc4Encode(plain: string, key: string): string {
  const s: number[] = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key.charCodeAt(i % key.length)) % 256;
    const x = s[i]!;
    s[i] = s[j]!;
    s[j] = x;
  }
  let a = 0;
  let b = 0;
  let out = '';
  for (let k = 0; k < plain.length; k++) {
    a = (a + 1) % 256;
    b = (b + s[a]!) % 256;
    const x = s[a]!;
    s[a] = s[b]!;
    s[b] = x;
    out += String.fromCharCode(plain.charCodeAt(k) ^ s[(s[a]! + s[b]!) % 256]!);
  }
  return out;
}

const CUSTOM_ALPHABET = 'qwertyuiopASDFGHJKLzxcvbnmMNBVCXZ0987654321asdfghjklQWERTYUIOP+/';

function list(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAIN_ARRAY = `
  var _0xdb56 = ['alpha', 'beta', 'gamma'];
  function main() { return _0xdb56[0x0] + _0xdb56[0x2]; }
`;

/** obfuscator.io's canonical pair: self-replacing accessor plus offset decoder. */
const OFFSET_WRAPPER = `
  function _0x4a1c() {
    const _0x1e2f = ['alpha', 'beta', 'gamma', 'delta'];
    _0x4a1c = function () { return _0x1e2f; };
    return _0x4a1c();
  }
  function _0x123b(_0x2a, _0x3b) {
    const _0x5e = _0x4a1c();
    _0x123b = function (_0x6f, _0x7a) {
      _0x6f = _0x6f - 0x1a4;
      let _0x8b = _0x5e[_0x6f];
      return _0x8b;
    };
    return _0x123b(_0x2a, _0x3b);
  }
  function main() { return _0x123b(0x1a4) + _0x123b(0x1a6); }
`;

/**
 * A rotation whose checksum only balances after two `push(shift())` cycles.
 * `parseInt` of a non-numeric element yields NaN, so every other offset fails.
 */
function rotationFixture(target: number): string {
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
    }(_0xarr, ${target}));
    function main() { return _0xdec(0x3); }
  `;
}

function base64Fixture(plaintexts: readonly string[], alphabet: string): string {
  const encoded = plaintexts.map((text) => utf8Base64(text, alphabet));
  return `
    var _0xarr = [${list(encoded)}];
    function _0xdec(_0x1) {
      _0x1 = _0x1 - 0x0;
      var _0x2 = _0xarr[_0x1];
      var _0x3 = '${alphabet}=';
      var _0x4 = '', _0x5 = '';
      for (var _0x6 = 0, _0x7, _0x8, _0x9 = 0; _0x8 = _0x2['charAt'](_0x9++); ~_0x8 && (_0x7 = _0x6 % 4 ? _0x7 * 64 + _0x8 : _0x8, _0x6++ % 4) ? _0x4 += String['fromCharCode'](255 & _0x7 >> (-2 * _0x6 & 6)) : 0) {
        _0x8 = _0x3['indexOf'](_0x8);
      }
      for (var _0xa = 0, _0xb = _0x4['length']; _0xa < _0xb; _0xa++) {
        _0x5 += '%' + ('00' + _0x4['charCodeAt'](_0xa)['toString'](16))['slice'](-2);
      }
      return decodeURIComponent(_0x5);
    }
    function main() { return _0xdec(0x0); }
  `;
}

function rc4Fixture(entries: readonly { text: string; key: string }[]): string {
  const encoded = entries.map((entry) => utf8Base64(rc4Encode(entry.text, entry.key)));
  const calls = entries
    .map((entry, index) => `_0xdec(0x${index.toString(16)}, ${JSON.stringify(entry.key)})`)
    .join(' + ');
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1, _0x2) {
      _0x1 = _0x1 - 0x0;
      var _0x3 = _0xarr[_0x1];
      var _0x5 = function (_0x6, _0x7) {
        var _0x8 = [], _0x9 = 0, _0xa, _0xb = '', _0xc = '';
        _0x6 = atob(_0x6);
        for (var _0xd = 0, _0xe = _0x6['length']; _0xd < _0xe; _0xd++) {
          _0xc += '%' + ('00' + _0x6['charCodeAt'](_0xd)['toString'](0x10))['slice'](-0x2);
        }
        _0x6 = decodeURIComponent(_0xc);
        var _0xf;
        for (_0xf = 0; _0xf < 0x100; _0xf++) { _0x8[_0xf] = _0xf; }
        for (_0xf = 0; _0xf < 0x100; _0xf++) {
          _0x9 = (_0x9 + _0x8[_0xf] + _0x7['charCodeAt'](_0xf % _0x7['length'])) % 0x100;
          _0xa = _0x8[_0xf]; _0x8[_0xf] = _0x8[_0x9]; _0x8[_0x9] = _0xa;
        }
        _0xf = 0; _0x9 = 0;
        for (var _0x10 = 0; _0x10 < _0x6['length']; _0x10++) {
          _0xf = (_0xf + 0x1) % 0x100;
          _0x9 = (_0x9 + _0x8[_0xf]) % 0x100;
          _0xa = _0x8[_0xf]; _0x8[_0xf] = _0x8[_0x9]; _0x8[_0x9] = _0xa;
          _0xb += String['fromCharCode'](_0x6['charCodeAt'](_0x10) ^ _0x8[(_0x8[_0xf] + _0x8[_0x9]) % 0x100]);
        }
        return _0xb;
      };
      return _0x5(_0x3, _0x2);
    };
    function main() { return ${calls}; }
  `;
}

function xorKeyFixture(plaintexts: readonly string[], key: string): string {
  const encoded = plaintexts.map((text) => latin1Base64(xorWithKey(text, key)));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1, _0x2) {
      var _0x3 = atob(_0xarr[_0x1 - 0x0]);
      var _0x4 = '';
      for (var _0x5 = 0; _0x5 < _0x3['length']; _0x5++) {
        _0x4 += String['fromCharCode'](_0x3['charCodeAt'](_0x5) ^ _0x2['charCodeAt'](_0x5 % _0x2['length']));
      }
      return _0x4;
    };
    function main() { return _0xdec(0x0, ${JSON.stringify(key)}); }
  `;
}

function xorConstantFixture(plaintexts: readonly string[], code: number): string {
  const encoded = plaintexts.map((text) => xorWithCode(text, code));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      var _0x3 = _0xarr[_0x1 - 0xa];
      var _0x4 = '';
      for (var _0x5 = 0; _0x5 < _0x3['length']; _0x5++) {
        _0x4 += String['fromCharCode'](_0x3['charCodeAt'](_0x5) ^ 0x${code.toString(16)});
      }
      return _0x4;
    };
    function main() { return _0xdec(0xa); }
  `;
}

function caesarFixture(plaintexts: readonly string[], delta: number): string {
  const encoded = plaintexts.map((text) => shiftChars(text, delta));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      var _0x3 = _0xarr[_0x1];
      var _0x4 = '';
      for (var _0x5 = 0; _0x5 < _0x3['length']; _0x5++) {
        _0x4 += String['fromCharCode'](_0x3['charCodeAt'](_0x5) - ${delta});
      }
      return _0x4;
    };
    function main() { return _0xdec(0x0); }
  `;
}

function rot13Fixture(plaintexts: readonly string[]): string {
  const encoded = plaintexts.map((text) => rotateLetters(text, 13));
  return `
    var _0xarr = [${list(encoded)}];
    var _0xdec = function (_0x1) {
      return _0xarr[_0x1]['replace'](/[a-zA-Z]/g, function (_0x2) {
        return String['fromCharCode']((_0x2 <= 'Z' ? 90 : 122) >= (_0x2 = _0x2['charCodeAt'](0) + 13) ? _0x2 : _0x2 - 26);
      });
    };
    function main() { return _0xdec(0x0); }
  `;
}

// ---------------------------------------------------------------------------
// Pure algorithm implementations
// ---------------------------------------------------------------------------

describe('algorithm implementations', () => {
  it('rotates an array the way push(shift()) does', () => {
    expect(rotateArray(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(rotateArray(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotateArray(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
  });

  it('decodes base64 under the standard alphabet', () => {
    const bytes = base64ToBytes(utf8Base64('hello world'), STANDARD_BASE64_ALPHABET);
    expect(bytes && bytesToUtf8(bytes)).toBe('hello world');
  });

  it('decodes base64 under a custom alphabet', () => {
    const bytes = base64ToBytes(utf8Base64('hello world', CUSTOM_ALPHABET), CUSTOM_ALPHABET);
    expect(bytes && bytesToUtf8(bytes)).toBe('hello world');
  });

  it('round-trips multi-byte UTF-8 through base64', () => {
    const text = 'héllo → wörld ✓ 𝄞';
    const bytes = base64ToBytes(utf8Base64(text), STANDARD_BASE64_ALPHABET);
    expect(bytes && bytesToUtf8(bytes)).toBe(text);
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(bytesToUtf8(Uint8Array.from([0xff, 0xfe]))).toBeUndefined();
    expect(bytesToUtf8(Uint8Array.from([0xe2, 0x28, 0xa1]))).toBeUndefined();
  });

  it('rejects payloads outside the given alphabet', () => {
    expect(base64ToBytes('****', STANDARD_BASE64_ALPHABET)).toBeUndefined();
  });

  it('implements RC4 as its own inverse', () => {
    expect(rc4(rc4Encode('the quick brown fox', 'k3y!'), 'k3y!')).toBe('the quick brown fox');
  });

  it('implements XOR and shift as their own inverses', () => {
    expect(xorWithKey(xorWithKey('payload', 'abc'), 'abc')).toBe('payload');
    expect(xorWithCode(xorWithCode('payload', 0x2a), 0x2a)).toBe('payload');
    expect(shiftChars(shiftChars('payload', 5), -5)).toBe('payload');
    expect(rotateLetters(rotateLetters('Payload 42!', 13), 13)).toBe('Payload 42!');
  });
});

// ---------------------------------------------------------------------------
// Structural recognisers
// ---------------------------------------------------------------------------

describe('string array recognition', () => {
  it('finds a plain array declaration', () => {
    const found = recogniseStringArray(programPath(PLAIN_ARRAY).node.body);
    expect(found).toEqual([{ name: '_0xdb56', viaFunction: false, values: ['alpha', 'beta', 'gamma'] }]);
  });

  it('finds an array behind a self-replacing accessor function', () => {
    const found = recogniseStringArray(programPath(OFFSET_WRAPPER).node.body);
    expect(found[0]).toMatchObject({ name: '_0x4a1c', viaFunction: true });
    expect(found[0]?.values).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  it('ignores arrays whose elements are not all string literals', () => {
    const found = recogniseStringArray(programPath(`var a = ['x', 1, 'y'];`).node.body);
    expect(found).toEqual([]);
  });

  it('reads a subtractive index offset', () => {
    const offset = recogniseIndexOffset(decoderBody(OFFSET_WRAPPER, '_0x123b'));
    // The outer function has no offset; the self-replacing inner one carries it.
    expect(offset).toBe(0);
    const source = `var d = function (i) { i = i - 0x1a4; return a[i]; };`;
    expect(recogniseIndexOffset(decoderBody(source, 'd'))).toBe(0x1a4);
  });

  it('reads an additive index offset as a negative one', () => {
    const source = `var d = function (i) { i = i + 0x10; return a[i]; };`;
    expect(recogniseIndexOffset(decoderBody(source, 'd'))).toBe(-0x10);
  });

  it('reads an offset written as array indexing', () => {
    const source = `var d = function (i) { return a[i - 0x40]; };`;
    expect(recogniseIndexOffset(decoderBody(source, 'd'))).toBe(0x40);
  });
});

describe('encoding recognition', () => {
  it('classifies a bare lookup as plain', () => {
    const source = `var d = function (i) { i = i - 0x1a4; var v = a[i]; return v; };`;
    expect(recogniseEncoding(decoderBody(source, 'd'))).toMatchObject({ algorithm: 'plain' });
  });

  it('classifies a standard-alphabet base64 decoder', () => {
    const encoding = recogniseEncoding(
      decoderBody(base64Fixture(['alpha'], STANDARD_BASE64_ALPHABET), '_0xdec'),
    );
    expect(encoding).toMatchObject({
      algorithm: 'base64',
      base64: { alphabet: STANDARD_BASE64_ALPHABET, byteMode: 'utf8' },
    });
  });

  it('reads a custom alphabet out of the decoder body', () => {
    const encoding = recogniseEncoding(decoderBody(base64Fixture(['alpha'], CUSTOM_ALPHABET), '_0xdec'));
    expect(encoding?.base64?.alphabet).toBe(CUSTOM_ALPHABET);
  });

  it('classifies RC4 and locates its per-call-site key argument', () => {
    const encoding = recogniseEncoding(
      decoderBody(rc4Fixture([{ text: 'alpha', key: '@m8w' }]), '_0xdec'),
    );
    expect(encoding).toMatchObject({ algorithm: 'rc4', keyArgIndex: 1 });
  });

  it('classifies keyed XOR and constant XOR differently', () => {
    expect(recogniseEncoding(decoderBody(xorKeyFixture(['alpha'], 'sec'), '_0xdec'))).toMatchObject({
      algorithm: 'xor',
      keyArgIndex: 1,
    });
    expect(recogniseEncoding(decoderBody(xorConstantFixture(['alpha'], 0x2a), '_0xdec'))).toMatchObject({
      algorithm: 'xor',
      amount: 0x2a,
    });
  });

  it('classifies a char shift and a letter rotation', () => {
    expect(recogniseEncoding(decoderBody(caesarFixture(['alpha'], 5), '_0xdec'))).toMatchObject({
      algorithm: 'caesar',
      amount: -5,
    });
    expect(recogniseEncoding(decoderBody(rot13Fixture(['alpha']), '_0xdec'))).toMatchObject({
      algorithm: 'rot',
      amount: 13,
    });
  });

  it('refuses a body that transforms the string in a way it cannot name', () => {
    const source = `var d = function (i) { return a[i]['split']('')['reverse']()['join'](''); };`;
    expect(recogniseEncoding(decoderBody(source, 'd'))).toBeNull();
  });

  it('refuses base64 when an unattributable XOR is layered on top of it', () => {
    // Recognising only the base64 layer here would hand back ciphertext that
    // looks like a decoded string.
    const source = base64Fixture(['alpha'], STANDARD_BASE64_ALPHABET).replace(
      'return decodeURIComponent(_0x5);',
      "var _0xz = decodeURIComponent(_0x5); return _0xz['charCodeAt'](0) ^ _0xz['length'];",
    );
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toBeNull();
  });

  it('refuses RC4 whose key it cannot locate', () => {
    // Single-parameter decoder, and two candidate literals in the body: there is
    // no defensible way to pick one, so the recogniser declines.
    const source = rc4Fixture([{ text: 'alpha', key: '@m8w' }])
      .replace('function (_0x1, _0x2)', 'function (_0x1)')
      .replace('return _0x5(_0x3, _0x2);', "return _0x5(_0x3, 'aa') + 'bb';");
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toBeNull();
  });

  it('refuses a body with an unclassifiable XOR', () => {
    const source = `var d = function (i) { return a[i ^ 0x3]; };`;
    expect(recogniseEncoding(decoderBody(source, 'd'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end native recognition
// ---------------------------------------------------------------------------

describe('native decoder', () => {
  it('decodes a plain array by index', () => {
    const decoder = recognise(PLAIN_ARRAY, ['_0xdb56']);
    expect(decoder).toMatchObject({ kind: 'array-index', algorithm: 'plain' });
    expect(decoder?.decode([0])).toBe('alpha');
    expect(decoder?.decode([2])).toBe('gamma');
    expect(decoder?.decode([9])).toBeUndefined();
  });

  it('decodes through a wrapper with an index offset', () => {
    const decoder = recognise(OFFSET_WRAPPER, ['_0x123b']);
    expect(decoder).toMatchObject({ kind: 'wrapper-call', algorithm: 'plain', offset: 0x1a4 });
    expect(decoder?.decode([0x1a4])).toBe('alpha');
    expect(decoder?.decode([0x1a6])).toBe('gamma');
    expect(decoder?.decode([0x1a3])).toBeUndefined();
  });

  it('solves the rotation loop as arithmetic, without running it', () => {
    // 300/1 + 400/2 + 600/3 balances only after two push(shift()) cycles.
    const decoder = recognise(rotationFixture(700), ['_0xdec']);
    expect(decoder?.rotation).toBe(2);
    expect(decoder?.values).toEqual(['300', '400', '600', 'alpha', 'beta']);
    expect(decoder?.decode([3])).toBe('alpha');
  });

  it('refuses when the rotation checksum never balances', () => {
    expect(recognise(rotationFixture(999), ['_0xdec'])).toBeNull();
  });

  // The recognisers read facts off the body and nothing asked whether control
  // reaches the `return` those facts describe, so a tripwire ahead of it
  // decoded anyway and the output ran where the input threw.
  it('refuses a wrapper whose return it cannot reach', () => {
    const thrown = `
      var _0xarr = ['alpha', 'beta'];
      function _0xdec(_0xi) { throw new Error('boom'); return _0xarr[_0xi]; }
    `;
    expect(recognise(thrown, ['_0xdec'])).toBeNull();

    const looped = `
      var _0xarr = ['alpha', 'beta'];
      function _0xdec(_0xi) { while (true) { _0xi = _0xi; } return _0xarr[_0xi]; }
    `;
    expect(recognise(looped, ['_0xdec'])).toBeNull();
  });

  it('still accepts a throw the decoder can get past', () => {
    const guarded = `
      var _0xarr = ['alpha', 'beta'];
      function _0xdec(_0xi) { if (_0xi < 0) throw new Error('range'); return _0xarr[_0xi]; }
    `;
    expect(recognise(guarded, ['_0xdec'])?.decode([0])).toBe('alpha');

    const escapable = `
      var _0xarr = ['alpha', 'beta'];
      function _0xdec(_0xi) { while (true) { break; } return _0xarr[_0xi]; }
    `;
    expect(recognise(escapable, ['_0xdec'])?.decode([1])).toBe('beta');
  });

  it('refuses a rotated array with no decoder to solve the checksum against', () => {
    const source = `
      var _0xarr = ['a', 'b', 'c'];
      (function (_0xp, _0xq) {
        while (!![]) { try { if (_0xq === 0x1) break; else _0xp['push'](_0xp['shift']()); } catch (e) { _0xp['push'](_0xp['shift']()); } }
      }(_0xarr, 0x2));
    `;
    expect(recognise(source, ['_0xarr'])).toBeNull();
  });

  it('decodes standard-alphabet base64', () => {
    const texts = ['alpha', 'https://example.com/a?b=c', 'héllo → wörld'];
    const decoder = recognise(base64Fixture(texts, STANDARD_BASE64_ALPHABET), ['_0xdec']);
    expect(decoder?.algorithm).toBe('base64');
    texts.forEach((text, index) => expect(decoder?.decode([index])).toBe(text));
  });

  it('decodes custom-alphabet base64', () => {
    const texts = ['alpha', 'beta gamma'];
    const decoder = recognise(base64Fixture(texts, CUSTOM_ALPHABET), ['_0xdec']);
    expect(decoder?.algorithm).toBe('base64');
    texts.forEach((text, index) => expect(decoder?.decode([index])).toBe(text));
  });

  it('decodes RC4 with a per-call-site key', () => {
    const entries = [
      { text: 'createElement', key: '@m8w' },
      { text: 'https://api.example.com/v1', key: 'Qz!4' },
      { text: 'héllo wörld', key: 'k' },
    ];
    const decoder = recognise(rc4Fixture(entries), ['_0xdec']);
    expect(decoder?.algorithm).toBe('rc4');
    entries.forEach((entry, index) => expect(decoder?.decode([index, entry.key])).toBe(entry.text));
  });

  it('produces nothing useful from RC4 when the call site key is wrong', () => {
    const decoder = recognise(rc4Fixture([{ text: 'createElement', key: '@m8w' }]), ['_0xdec']);
    expect(decoder?.decode([0, 'wrong'])).not.toBe('createElement');
  });

  it('decodes keyed XOR over base64', () => {
    const texts = ['alpha', 'querySelectorAll'];
    const decoder = recognise(xorKeyFixture(texts, 's3cr3t'), ['_0xdec']);
    expect(decoder?.algorithm).toBe('xor');
    texts.forEach((text, index) => expect(decoder?.decode([index, 's3cr3t'])).toBe(text));
  });

  it('decodes constant XOR with an index offset', () => {
    const texts = ['alpha', 'beta'];
    const decoder = recognise(xorConstantFixture(texts, 0x2a), ['_0xdec']);
    expect(decoder).toMatchObject({ algorithm: 'xor', offset: 0xa });
    texts.forEach((text, index) => expect(decoder?.decode([0xa + index])).toBe(text));
  });

  it('decodes a char shift', () => {
    const texts = ['alpha', 'beta'];
    const decoder = recognise(caesarFixture(texts, 5), ['_0xdec']);
    expect(decoder?.algorithm).toBe('caesar');
    texts.forEach((text, index) => expect(decoder?.decode([index])).toBe(text));
  });

  it('decodes rot13 over letters only', () => {
    const texts = ['Alpha Beta 42!'];
    const decoder = recognise(rot13Fixture(texts), ['_0xdec']);
    expect(decoder?.algorithm).toBe('rot');
    expect(decoder?.decode([0])).toBe('Alpha Beta 42!');
  });

  it('coerces a string index argument the way the source would', () => {
    const decoder = recognise(PLAIN_ARRAY, ['_0xdb56']);
    expect(decoder?.decode(['1'])).toBe('beta');
    expect(decoder?.decode(['nope'])).toBeUndefined();
  });

  it('returns null when there is no string array at all', () => {
    expect(recognise(`function f(i) { return i + 1; }`, ['f'])).toBeNull();
  });

  it('returns null for a decoder whose transform it cannot name', () => {
    const source = `
      var _0xarr = ['ahpla', 'ateb'];
      var _0xdec = function (_0x1) { return _0xarr[_0x1]['split']('')['reverse']()['join'](''); };
      function main() { return _0xdec(0x0); }
    `;
    expect(recognise(source, ['_0xdec'])).toBeNull();
  });

  /**
   * `decodeURIComponent` was accounted for by name - it is the base64
   * family's byte-mode evidence - so a plain lookup that returns its element
   * through it read as "index lookup" and handed back `%C3%BCn%C3%AF` where
   * the program prints `ünï`. The step is a shape of its own now, and every
   * builtin is accounted for by the shape that read it, not by its name.
   */
  it('reads a plain lookup through a percent decoder as that step, calling the same builtin', () => {
    const through = (fn: string, body = `return ${fn}(_0xarr[_0x1]);`): string => `
      var _0xarr = ['%C3%BCn%C3%AF', 'plain', '%41%u0042'];
      function _0xdec(_0x1) { ${body} }
      function main() { return _0xdec(0x0); }
    `;
    const component = recognise(through('decodeURIComponent'), ['_0xdec']);
    expect(component?.evidence).toBe('index lookup through decodeURIComponent');
    expect(component?.decode([0])).toBe('ünï');
    expect(component?.decode([2])).toBeUndefined();
    // `decodeURI` and `unescape` are not the same function, and the reading
    // calls the one the body names: `%41` stays encoded for `decodeURI` only
    // where it is reserved, and `unescape` takes each escape as a code unit.
    expect(recognise(through('unescape'), ['_0xdec'])?.decode([0])).toBe('Ã¼nÃ¯');
    expect(recognise(through('unescape'), ['_0xdec'])?.decode([2])).toBe('AB');
    expect(recognise(through('decodeURI'), ['_0xdec'])?.decode([0])).toBe('ünï');
    expect(recognise(through('decodeURI'), ['_0xdec'])?.decode([2])).toBeUndefined();

    // The element may reach the call through a single-assignment local, and
    // the call may reach the return through one.
    const viaLocals = recognise(
      through('decodeURIComponent', 'var _0x2 = _0xarr[_0x1]; var _0x3 = decodeURIComponent(_0x2); return _0x3;'),
      ['_0xdec'],
    );
    expect(viaLocals?.decode([1])).toBe('plain');
  });

  it('refuses a percent decoder anywhere but around the element the plain lookup returns', () => {
    const shapes: Record<string, string> = {
      'a call the return does not carry': "var _0x2 = decodeURIComponent('%41'); return _0xarr[_0x1] + _0x2;",
      'two percent decoders': 'return unescape(decodeURIComponent(_0xarr[_0x1]));',
      'a local the body writes twice': 'var _0x2 = _0xarr[_0x1]; _0x2 = _0x2 + ""; return decodeURIComponent(_0x2);',
      'a return beside the call': 'if (_0x1 > 1) return _0xarr[_0x1]; return decodeURIComponent(_0xarr[_0x1]);',
      'a cipher with a percent step it cannot place':
        "var _0x2 = decodeURIComponent(_0xarr[_0x1]), _0x3 = ''; for (var _0x4 = 0; _0x4 < _0x2.length; _0x4++) _0x3 += String.fromCharCode(_0x2.charCodeAt(_0x4) ^ 0x2a); return _0x3;",
      'a call that is not the builtin': 'var decodeURIComponent = function (s) { return s; }; return decodeURIComponent(_0xarr[_0x1]);',
    };
    for (const [what, body] of Object.entries(shapes)) {
      const source = `
        var _0xarr = ['%C3%BCn%C3%AF', 'plain'];
        function _0xdec(_0x1) { ${body} }
        function main() { return _0xdec(0x0); }
      `;
      expect(recognise(source, ['_0xdec']), what).toBeNull();
    }
  });

  it('accounts for a builtin only through the shape that read it', () => {
    // `atob` beside an alphabet loop that took the alphabet is a second base64
    // the shape does not have; `decodeURIComponent` in a body read as latin1
    // is a step it does not have. Neither was refused while the two were
    // accounted for by name.
    const alphabet = base64Fixture(['alpha'], STANDARD_BASE64_ALPHABET);
    expect(recognise(alphabet, ['_0xdec'])?.algorithm).toBe('base64');
    const twice = alphabet.replace('return decodeURIComponent(_0x5);', 'return decodeURIComponent(atob(_0x5));');
    expect(recognise(twice, ['_0xdec'])).toBeNull();

    const latin1 = xorConstantFixture(['alpha'], 0x2a).replace('return _0x4;', 'return decodeURIComponent(_0x4);');
    expect(recognise(latin1, ['_0xdec'])).toBeNull();
  });

  it('claims a plain lookup only for a body that returns the element it read', () => {
    const source = `
      var _0xarr = ['alpha', 'beta'];
      function _0xdec(_0x1) { var _0x2 = _0xarr[_0x1]; return 'nope'; }
      function main() { return _0xdec(0x0); }
    `;
    expect(recognise(source, ['_0xdec'])).toBeNull();
    expect(recognise(source.replace("return 'nope';", 'return _0x2;'), ['_0xdec'])?.decode([1])).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// Tier dispatcher
// ---------------------------------------------------------------------------

describe('tier dispatcher', () => {
  it('returns a StringSource backed by the native tier', () => {
    const { decoder } = build(OFFSET_WRAPPER, ['_0x123b']);
    expect(decoder).toBeDefined();
    expect(decoder?.tier).toBe('native');
    expect(decoder?.kind).toBe('wrapper-call');
    expect(decoder?.name).toBe('_0x123b');
    expect(decoder?.decode([0x1a5])).toBe('beta');
    expect(decoder?.declarations.length).toBeGreaterThan(0);
  });

  it('refuses a slice that is not self-contained', () => {
    const source = `
      var _0xarr = [document['cookie'], 'beta'];
      var _0xdec = function (_0x1) { return _0xarr[_0x1]; };
      function main() { return _0xdec(0x0); }
    `;
    const { decoder, notes } = build(source, ['_0xdec']);
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('document'))).toBe(true);
  });

  it('collects forwarding aliases, including aliases of aliases', () => {
    const source = `${OFFSET_WRAPPER}\nvar _0x3e8cb6 = _0x123b;\nvar _0x9f2 = _0x3e8cb6;`;
    const { decoder } = build(source, ['_0x123b']);
    expect([...(decoder?.aliases ?? [])].sort()).toEqual(['_0x3e8cb6', '_0x9f2']);
  });

  it('memoizes decode results when the config asks for it', () => {
    const { decoder } = build(OFFSET_WRAPPER, ['_0x123b'], { performance: { memoize: true } });
    expect(decoder?.decode([0x1a4])).toBe('alpha');
    expect(decoder?.decode([0x1a4])).toBe('alpha');
  });

  it('stops decoding once the call budget is spent', () => {
    const { decoder, notes } = build(OFFSET_WRAPPER, ['_0x123b'], {
      performance: { memoize: false },
      techniques: { stringDecoding: { maxDecodeCalls: 2 } },
    });
    expect(decoder?.decode([0x1a4])).toBe('alpha');
    expect(decoder?.decode([0x1a5])).toBe('beta');
    expect(decoder?.decode([0x1a6])).toBeUndefined();
    expect(notes.some((note) => note.message.includes('budget'))).toBe(true);
  });

  it('falls through to the next tier when the first one does not recognise the decoder', () => {
    const source = `
      var _0xarr = ['ahpla', 'ateb'];
      var _0xdec = function (_0x1) { return _0xarr[_0x1]['split']('')['reverse']()['join'](''); };
      function main() { return _0xdec(0x0) + _0xdec(0x1); }
    `;
    const { decoder, notes } = build(source, ['_0xdec']);
    expect(notes.some((note) => note.message.includes('Tier native did not recognise'))).toBe(true);
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([0])).toBe('alpha');
  });

  it('agrees with the interpreter tier on a decoder both tiers handle', () => {
    const entries = [
      { text: 'createElement', key: '@m8w' },
      { text: 'appendChild', key: '@m8w' },
    ];
    const source = rc4Fixture(entries);
    const native = build(source, ['_0xdec'], {
      techniques: { stringDecoding: { tiers: ['native'] } },
    }).decoder;
    const interpreted = build(source, ['_0xdec'], {
      techniques: { stringDecoding: { tiers: ['interpreter'] } },
    }).decoder;

    expect(native?.tier).toBe('native');
    expect(interpreted?.tier).toBe('interpreter');
    entries.forEach((entry, index) => {
      expect(native?.decode([index, entry.key])).toBe(entry.text);
      expect(interpreted?.decode([index, entry.key])).toBe(entry.text);
    });
  });

  it('reports a cross-tier disagreement and keeps the interpreter answer', () => {
    // A *conditional* offset. The native recogniser reads `- 0x1` as the index
    // offset because that is what the shape says, but the guard means it only
    // applies above index 5 - so native and the interpreter agree on 0x7 and
    // disagree on 0x2. This is exactly the failure cross-checking exists for:
    // both answers are real strings, and only one of them is right.
    const source = `
      var _0xarr = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      var _0xdec = function (_0x1) {
        if (_0x1 > 0x5) { _0x1 = _0x1 - 0x1; }
        return _0xarr[_0x1];
      };
      function main() { return _0xdec(0x7) + _0xdec(0x2); }
    `;

    const nativeOnly = build(source, ['_0xdec'], {
      techniques: { stringDecoding: { tiers: ['native'] } },
    }).decoder;
    expect(nativeOnly?.tier).toBe('native');
    expect(nativeOnly?.decode([0x2])).toBe('b');

    const { decoder, notes } = build(source, ['_0xdec']);
    expect(notes.some((note) => note.severity === 'error' && note.message.includes('disagree'))).toBe(
      true,
    );
    expect(decoder?.tier).toBe('interpreter');
    expect(decoder?.decode([0x2])).toBe('c');
    expect(decoder?.decode([0x7])).toBe('g');
  });

  it('never reaches the sandbox tier unless execution is explicitly allowed', () => {
    const source = `
      var _0xarr = ['ahpla'];
      var _0xdec = function (_0x1) { return _0xarr[_0x1]['split']('')['reverse']()['join'](''); };
      function main() { return _0xdec(0x0); }
    `;
    const { decoder, notes } = build(source, ['_0xdec'], {
      techniques: { stringDecoding: { tiers: ['sandbox'] } },
    });
    expect(decoder).toBeUndefined();
    // Declined, not attempted: nothing was constructed and nothing was executed.
    expect(notes.some((note) => note.message.includes('Tier sandbox did not recognise'))).toBe(true);
    expect(notes.some((note) => note.message.includes('threw'))).toBe(false);
  });

  it('isolates a tier that throws instead of failing the whole build', () => {
    // A decoder whose body throws on construction: the sandbox builds the realm
    // but running the slice raises. The dispatcher's job is to record that and
    // fall through to the next tier, not to propagate it. The throw is under
    // a condition so that it is the tier that meets it, not the trap walk
    // that refuses an unconditional one before any tier runs.
    const source = `
      var _0xarr = ['ahpla'];
      var _0xboom = (function () { if (_0xarr.length > 0) throw new Error('tamper check'); })();
      var _0xdec = function (_0x1) { return _0xarr[_0x1]['split']('')['reverse']()['join'](''); };
      function main() { return _0xdec(0x0); }
    `;
    const { decoder, notes } = build(source, ['_0xdec', '_0xboom'], {
      techniques: { stringDecoding: { tiers: ['sandbox', 'interpreter'] } },
      sandbox: { allowExecution: true },
    });
    expect(notes.some((note) => note.message.includes('Tier sandbox threw'))).toBe(true);
    expect(decoder).toBeUndefined();
  });

  it('runs the sandbox tier successfully when execution is allowed', () => {
    // Regression guard: `createSandbox` must not bind `eval` (or `arguments`) as
    // a parameter name - doing so is a SyntaxError under "use strict", which
    // makes this tier throw on every input rather than ever succeeding.
    const source = `
      var _0xarr = ['ahpla'];
      var _0xdec = function (_0x1) { return _0xarr[_0x1]['split']('')['reverse']()['join'](''); };
      function main() { return _0xdec(0x0); }
    `;
    const { decoder } = build(source, ['_0xdec'], {
      techniques: { stringDecoding: { tiers: ['sandbox'] } },
      sandbox: { allowExecution: true },
    });
    expect(decoder?.tier).toBe('sandbox');
    expect(decoder?.decode([0])).toBe('alpha');
  });

  it('returns undefined when no tier can decode', () => {
    const { decoder, notes } = build(`var x = 1;`, ['x'], {
      techniques: { stringDecoding: { tiers: ['native'] } },
    });
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('No evaluation tier'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Argument forwarders - obfuscator.io's "string array wrappers"
// ---------------------------------------------------------------------------

describe('argument forwarders', () => {
  it('reads a wrapper that permutes and adjusts its arguments', () => {
    const source = `function w(a, b, c, d) { return dec(b - -0xf5, c); }`;
    const forwarders = collectArgumentForwarders([programPath(source).node]);
    expect(forwarders.get('w')).toMatchObject({
      callee: 'dec',
      params: ['a', 'b', 'c', 'd'],
    });

    const resolved = resolveForwardedCall('w', [0x3f, 0x55, '@m8w', 0x6e], forwarders, (name) =>
      name === 'dec',
    );
    expect(resolved).toEqual({ name: 'dec', args: [0x55 + 0xf5, '@m8w'] });
  });

  it('follows a chain of wrappers to a fixpoint', () => {
    const source = `
      function outer(a, b, c, d, e) { return middle(c, b - 0x2, a, e); }
      function middle(p, q, r, s) { return inner(q + 0x10, p); }
      function inner(i, k) { return dec(i - 0x1, k); }
    `;
    const forwarders = collectArgumentForwarders([programPath(source).node]);
    const resolved = resolveForwardedCall('outer', [1, 2, 'key', 4, 5], forwarders, (n) => n === 'dec');
    // outer -> middle('key', 0, 1, 5) -> inner(0x10, 'key') -> dec(0xf, 'key')
    expect(resolved).toEqual({ name: 'dec', args: [0xf, 'key'] });
  });

  it('drops a wrapper name that two different functions declare', () => {
    // With no scope information, guessing which `w` a call site meant would
    // fabricate arguments the program never passes.
    const source = `
      function a() { function w(x, y) { return dec(x - 0x1, y); } }
      function b() { function w(x, y) { return dec(x - 0x2, y); } }
    `;
    expect(collectArgumentForwarders([programPath(source).node]).has('w')).toBe(false);
  });

  it('refuses a wrapper whose argument is not determined by the call site', () => {
    const source = `
      function w(a, b) { return dec(a - outerCounter, b); }
      function v(a, b) { return dec(a.index, b); }
    `;
    const forwarders = collectArgumentForwarders([programPath(source).node]);
    expect(forwarders.has('w')).toBe(false);
    expect(forwarders.has('v')).toBe(false);
  });

  it('coerces a forwarded argument the way the program would', () => {
    // A wrapper routinely computes an argument the decoder never reads:
    // `'BvqA' - 0x85` is NaN in JavaScript, not "unknown", and refusing on it
    // would drop a call site whose *used* arguments are perfectly determined.
    const source = `function w(a, b, c, d) { return dec(c, b - 0x85, d - -0x1ad); }`;
    const forwarders = collectArgumentForwarders([programPath(source).node]);
    const resolved = resolveForwardedCall('w', [-407, 'BvqA', 0x1f, -415], forwarders, (n) => n === 'dec');
    expect(resolved?.args[0]).toBe(0x1f);
    expect(resolved?.args[1]).toBeNaN();
    expect(resolved?.args[2]).toBe(-415 + 0x1ad);
  });

  it('validates against call sites that only reach the decoder through a wrapper', () => {
    // Every literal call site names the wrapper, so sample collection that does
    // not follow wrappers adopts this decoder with nothing proven about it. The
    // table is gibberish, and validation has to say so.
    const source = `
      var _0xarr = ['\\u0001\\u0002\\u0003\\u0004', '\\u0005\\u0006\\u0007\\b'];
      var _0xdec = function (_0x1) { return _0xarr[_0x1 - 0x10]; };
      function _0xw(_0xa, _0xb, _0xc) { return _0xdec(_0xb - 0x5, _0xc); }
      function main() { return _0xw(0x1, 0x15, 0x2) + _0xw(0x1, 0x16, 0x2); }
    `;
    const { decoder, notes } = build(source, ['_0xdec'], {
      techniques: { stringDecoding: { tiers: ['native'] } },
    });
    expect(decoder).toBeUndefined();
    expect(notes.some((note) => note.message.includes('not plausible text'))).toBe(true);
  });

  it('evaluates constant arithmetic that numbersToExpressions left behind', () => {
    // The literal shapes obfuscator.io emits for 283, 256 and -245.
    expect(constantNumber(programExpression('0x35 * -0x67 + -0x1325 + 0x2993'))).toBe(283);
    expect(constantNumber(programExpression('0x8d1 * 0x3 + -0x56f + -0x16e * 0xe'))).toBe(256);
    expect(constantNumber(programExpression('-(-0x164c + -0xdb8 + 0x82 * 0x47)'))).toBe(-10);
    // Anything with a free variable in it stays unknown.
    expect(constantNumber(programExpression('i - 0x1'))).toBeUndefined();

    // ...and the index-offset recogniser reads through it, so it does not depend
    // on `prepare.fold-numbers` having run first.
    const source = `var d = function (i) { i = i - (0x35 * -0x67 + -0x1325 + 0x2993); return a[i]; };`;
    expect(recogniseIndexOffset(decoderBody(source, 'd'))).toBe(283);
  });
});

// ---------------------------------------------------------------------------
// Self-caching decoders
// ---------------------------------------------------------------------------

describe('decoders that cache on their own function object', () => {
  /**
   * obfuscator.io 5.6 builds the cipher once, parks it on the decoder function
   * itself, and memoizes per index - `if (d.setUp === undefined) { ... }` plus
   * `d.cache[i] = value`. None of that changes what a call site stands for, but
   * a recogniser that mistakes the property writes for a transform refuses it.
   */
  const selfCaching = `
    var _0xarr = ['${utf8Base64('alpha')}', '${utf8Base64('beta')}', '${utf8Base64('gamma')}'];
    function _0xdec(_0x1, _0x2) {
      _0x1 = _0x1 - 0x40;
      var _0x3 = _0xarr[_0x1];
      if (_0xdec['setUp'] === undefined) {
        var _0x4 = function (_0x5) {
          var _0x6 = '${STANDARD_BASE64_ALPHABET}=';
          var _0x7 = '', _0x8 = '';
          for (var _0x9 = 0, _0xa, _0xb, _0xc = 0; _0xb = _0x5['charAt'](_0xc++); ~_0xb && (_0xa = _0x9 % 4 ? _0xa * 64 + _0xb : _0xb, _0x9++ % 4) ? _0x7 += String['fromCharCode'](255 & _0xa >> (-2 * _0x9 & 6)) : 0) {
            _0xb = _0x6['indexOf'](_0xb);
          }
          for (var _0xd = 0, _0xe = _0x7['length']; _0xd < _0xe; _0xd++) {
            _0x8 += '%' + ('00' + _0x7['charCodeAt'](_0xd)['toString'](16))['slice'](-2);
          }
          return decodeURIComponent(_0x8);
        };
        _0xdec['decoder'] = _0x4;
        _0xdec['cache'] = {};
        _0xdec['setUp'] = !![];
      }
      var _0xf = _0xdec['cache'][_0x1];
      if (_0xf === undefined) {
        _0x3 = _0xdec['decoder'](_0x3);
        _0xdec['cache'][_0x1] = _0x3;
      } else _0x3 = _0xf;
      return _0x3;
    }
    function main() { return _0xdec(0x40) + _0xdec(0x42); }
  `;

  it('reads the index offset past the property bookkeeping', () => {
    expect(recogniseIndexOffset(decoderBody(selfCaching, '_0xdec'))).toBe(0x40);
  });

  it('decodes through the memo without mistaking it for a transform', () => {
    const decoder = recognise(selfCaching, ['_0xdec']);
    expect(decoder).toMatchObject({ algorithm: 'base64', offset: 0x40 });
    expect(decoder?.decode([0x40])).toBe('alpha');
    expect(decoder?.decode([0x41])).toBe('beta');
    expect(decoder?.decode([0x42])).toBe('gamma');
  });
});

// ---------------------------------------------------------------------------
// selfDefending woven into the decoder
// ---------------------------------------------------------------------------

describe('self-source tamper probes', () => {
  /** The base64 helper obfuscator.io emits when `selfDefending` is on. */
  const wovenGuard = (alternate: string): string => `
    var _0xarr = ['${utf8Base64('alpha')}', '${utf8Base64('beta')}'];
    var _0xdec = function (_0x1) {
      var _0x2 = _0xarr[_0x1];
      var _0x3 = '${STANDARD_BASE64_ALPHABET}=';
      var _0x4 = '', _0x5 = '', _0xself = _0x4 + _0xhelp,
          _0xbeaut = ('' + function () { return 0; })['indexOf']('\\n') !== -1;
      var _0xhelp = function () { return 0; };
      for (var _0x6 = 0, _0x7, _0x8, _0x9 = 0; _0x8 = _0x2['charAt'](_0x9++); ~_0x8 && (_0x7 = _0x6 % 4 ? _0x7 * 64 + _0x8 : _0x8, _0x6++ % 4) ? _0x4 += _0xbeaut || _0xself['charCodeAt'](_0x9 + 10) - 10 !== 0 ? String['fromCharCode'](255 & _0x7 >> (-2 * _0x6 & 6)) : ${alternate} : 0) {
        _0x8 = _0x3['indexOf'](_0x8);
      }
      for (var _0xa = 0, _0xb = _0x4['length']; _0xa < _0xb; _0xa++) {
        _0x5 += '%' + ('00' + _0x4['charCodeAt'](_0xa)['toString'](16))['slice'](-2);
      }
      return decodeURIComponent(_0x5);
    };
    function main() { return _0xdec(0x0); }
  `;

  it('decodes past a probe whose other branch cannot build characters', () => {
    // The trap appends a loop counter, which is corruption rather than a second
    // encoding - so the algorithm is unambiguous however the probe lands.
    const encoding = recogniseEncoding(decoderBody(wovenGuard('_0x6'), '_0xdec'));
    expect(encoding).toMatchObject({ algorithm: 'base64', selfSourceGuard: true });
    expect(encoding?.evidence).toContain('self-source tamper probe');

    const decoder = recognise(wovenGuard('_0x6'), ['_0xdec']);
    expect(decoder?.decode([0])).toBe('alpha');
    expect(decoder?.decode([1])).toBe('beta');
  });

  it('refuses a probe that really does choose between two transforms', () => {
    // Here the source text selects the *encoding*, and nothing in the AST says
    // which one runs. Guessing would produce plausible, wrong strings.
    expect(recogniseEncoding(decoderBody(wovenGuard("_0x2['charAt'](_0x9)"), '_0xdec'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real javascript-obfuscator output
//
// Every case below is generated by the actual obfuscator rather than hand-
// written, because the shapes that break a recogniser are the ones nobody would
// think to write by hand: a wrapper declared *inside* the rotation IIFE, an
// index offset spelled as four-term arithmetic, a decoder that caches on its own
// function object. The assertion is the decoded text itself.
// ---------------------------------------------------------------------------

const GENERATED_SOURCE = `
  function describe(role) {
    var banner = 'jsrift/diagnostics';
    var url = 'https://example.com/v1/status';
    var greeting = 'Hello, ' + role + '!';
    console.log(banner + ' ' + url + ' ' + greeting);
    return greeting;
  }
  describe('operator');
`;

/** The literals of `GENERATED_SOURCE` that are long enough to be tabled. */
const GENERATED_STRINGS = [
  'Hello, ',
  'https://example.com/v1/status',
  'log',
  'operator',
  'jsrift/diagnostics',
];

interface GeneratedDecode {
  decoder: NativeDecoder;
  /** Every distinct string the decoder produced, sorted. */
  strings: string[];
  callSites: number;
  decoded: number;
}

/**
 * Obfuscate for real, recognise natively, then decode every call site whose
 * arguments are literals - following wrapper chains and per-scope aliases,
 * which is the only way call sites are ever written in generated output.
 */
function decodeGenerated(options: ObfuscatorOptions): GeneratedDecode {
  const code = obfuscate(GENERATED_SOURCE, { ...options, seed: 20260904 }).getObfuscatedCode();
  const program = programPath(code);
  program.scope.crawl();

  const candidate = findStringSourceCandidates(program).find(
    (found) => found.kind === 'wrapper-call',
  );
  if (!candidate) throw new Error('no wrapper-call candidate was proposed');

  const decoder = recogniseNativeDecoder(
    sliceForEvaluation(program, candidate.roots),
    candidate.roots,
  );
  if (!decoder) throw new Error(`native tier refused ${candidate.roots.join(', ')}`);

  const forwarders = collectArgumentForwarders([program.node]);
  const names = new Set([decoder.name, ...candidate.roots]);
  for (let grew = true; grew; ) {
    grew = false;
    program.traverse({
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (!t.isIdentifier(id) || !t.isIdentifier(init)) return;
        if (!names.has(init.name) || names.has(id.name)) return;
        names.add(id.name);
        grew = true;
      },
    });
  }

  const strings = new Set<string>();
  let callSites = 0;
  let decoded = 0;
  program.traverse({
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;

      const tuple: (string | number)[] = [];
      for (const argument of path.node.arguments) {
        const value = literalOf(argument);
        if (value === undefined) return;
        tuple.push(value);
      }
      if (tuple.length === 0) return;

      let args: readonly (string | number)[] | undefined;
      if (names.has(callee.name)) args = tuple;
      else args = resolveForwardedCall(callee.name, tuple, forwarders, (n) => names.has(n))?.args;
      if (!args) return;

      callSites++;
      const value = decoder.decode(args);
      if (typeof value === 'string') {
        decoded++;
        strings.add(value);
      }
    },
  });

  return { decoder, strings: [...strings].sort(), callSites, decoded };
}

function literalOf(node: t.Node): string | number | undefined {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && t.isNumericLiteral(node.argument)) {
    if (node.operator === '-') return -node.argument.value;
    if (node.operator === '+') return node.argument.value;
  }
  return undefined;
}

/** Every call site decoded, and the program's own literals came back intact. */
function expectFullyDecoded(result: GeneratedDecode): void {
  expect(result.callSites).toBeGreaterThan(0);
  expect(result.decoded).toBe(result.callSites);
  expect(result.strings).toEqual(expect.arrayContaining(GENERATED_STRINGS));
}

const STRING_ARRAY_BASE: ObfuscatorOptions = { stringArray: true, stringArrayThreshold: 1 };

describe('javascript-obfuscator 5.6 shapes (native tier)', () => {
  it('(a) decodes stringArrayIndexShift', () => {
    const result = decodeGenerated({ ...STRING_ARRAY_BASE, stringArrayIndexShift: true });
    expect(result.decoder.offset).toBeGreaterThan(0);
    expectFullyDecoded(result);
  });

  it('(a) decodes stringArrayIndexShift when numbersToExpressions hides the constant', () => {
    // Nothing has folded the arithmetic here: the recogniser is handed the raw
    // obfuscator output, exactly as it would be if called directly.
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayIndexShift: true,
      numbersToExpressions: true,
    });
    expect(result.decoder.offset).toBeGreaterThan(0);
    expectFullyDecoded(result);
  });

  it('(b) solves stringArrayRotate combined with stringArrayShuffle', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayRotate: true,
      stringArrayShuffle: true,
    });
    expectFullyDecoded(result);
  });

  it('(b) solves rotate + shuffle over an rc4 payload', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayEncoding: ['rc4'],
    });
    expect(result.decoder.algorithm).toBe('rc4');
    expect(result.decoder.rotation).toBeGreaterThan(0);
    expectFullyDecoded(result);
  });

  it('(b) solves rotate + shuffle over base64 with an index shift', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayEncoding: ['base64'],
      stringArrayIndexShift: true,
    });
    expect(result.decoder.algorithm).toBe('base64');
    expectFullyDecoded(result);
  });

  it('(c) decodes through five-parameter chained function wrappers', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: 'function',
      stringArrayWrappersParametersMaxCount: 5,
      stringArrayWrappersChainedCalls: true,
    });
    expectFullyDecoded(result);
  });

  it('(c) solves a rotation whose checksum runs entirely through wrappers', () => {
    // The rotation IIFE declares its own private wrappers and never names the
    // decoder, so without the forwarder resolver this case decodes nothing.
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: 'function',
      stringArrayWrappersParametersMaxCount: 5,
      stringArrayWrappersChainedCalls: true,
    });
    expectFullyDecoded(result);
  });

  it('(c) decodes through variable-type wrappers', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      stringArrayRotate: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: 'variable',
      stringArrayWrappersChainedCalls: true,
    });
    expectFullyDecoded(result);
  });

  it('(d, e) decodes a self-caching decoder carrying a selfDefending probe', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      compact: true,
      selfDefending: true,
      stringArrayRotate: true,
      stringArrayEncoding: ['rc4'],
    });
    expect(result.decoder.algorithm).toBe('rc4');
    expect(result.decoder.evidence).toContain('self-source tamper probe');
    expectFullyDecoded(result);
    // The guard's own strings come back too, which is what lets the anti-tamper
    // pass recognise it later.
    expect(result.strings).toEqual(expect.arrayContaining(['(((.+)+)+)+$', 'constructor']));
  });

  it('(d, e) decodes selfDefending combined with wrappers, rotate and index shift', () => {
    const result = decodeGenerated({
      ...STRING_ARRAY_BASE,
      compact: true,
      selfDefending: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayIndexShift: true,
      stringArrayEncoding: ['rc4'],
      stringArrayWrappersCount: 2,
      stringArrayWrappersType: 'function',
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersChainedCalls: true,
    });
    expect(result.decoder.algorithm).toBe('rc4');
    expect(result.decoder.rotation).toBeGreaterThan(0);
    expectFullyDecoded(result);
  });

  it('decodes the full max-options build', () => {
    const result = decodeGenerated({
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.6,
      numbersToExpressions: true,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 4,
      stringArray: true,
      stringArrayEncoding: ['rc4'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 2,
      stringArrayWrappersChainedCalls: true,
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersType: 'function',
      stringArrayThreshold: 1,
      transformObjectKeys: true,
      unicodeEscapeSequence: true,
      selfDefending: true,
    });

    expect(result.decoder.algorithm).toBe('rc4');
    expect(result.decoder.offset).toBeGreaterThan(0);
    expect(result.decoder.rotation).toBeGreaterThan(0);
    expect(result.callSites).toBeGreaterThan(0);
    expect(result.decoded).toBe(result.callSites);

    // `splitStrings: 4` means the literals come back as four-character chunks;
    // the two-character tail of the banner is below the array threshold and stays inline.
    expect(result.strings).toEqual(
      expect.arrayContaining(['Hell', 'o, ', 'jsri', 'ft/d', 'iagn', 'osti', 'log']),
    );
  });

  it('agrees with the dispatcher, which validates it against real call sites', () => {
    const code = obfuscate(GENERATED_SOURCE, {
      ...STRING_ARRAY_BASE,
      compact: true,
      selfDefending: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayIndexShift: true,
      stringArrayEncoding: ['rc4'],
      stringArrayWrappersCount: 2,
      stringArrayWrappersType: 'function',
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersChainedCalls: true,
      seed: 20260904,
    }).getObfuscatedCode();

    const program = programPath(code);
    program.scope.crawl();
    const candidate = findStringSourceCandidates(program).find((f) => f.kind === 'wrapper-call')!;
    const { decoder } = build(code, candidate.roots, {
      techniques: { stringDecoding: { tiers: ['native'] } },
    });

    // Reaching here at all means `validate` accepted it on real samples: every
    // literal call site names a wrapper, not the decoder.
    expect(decoder?.tier).toBe('native');
    const native = decodeGenerated({
      ...STRING_ARRAY_BASE,
      compact: true,
      selfDefending: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayIndexShift: true,
      stringArrayEncoding: ['rc4'],
      stringArrayWrappersCount: 2,
      stringArrayWrappersType: 'function',
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersChainedCalls: true,
    });
    expect(native.strings).toEqual(expect.arrayContaining(GENERATED_STRINGS));
  });
});
