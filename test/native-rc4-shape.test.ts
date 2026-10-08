import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { rc4, recogniseEncoding, validateAgainstSamples } from '../src/analysis/evaluator/native.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

/**
 * "rc4" names one cipher: the stock key schedule and generator, spelled as
 * the obfuscators spell them. A body with the same modulus and XOR but a
 * term added to the schedule, a different stride in the generator, or no
 * swap is some other cipher, and the native decoder for it is a wrong
 * string on every call. The sample gate is the other half: a table of
 * random bytes decodes to random bytes, and random bytes are not text.
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
  const atob = (data: string): string => Buffer.from(data, 'base64').toString('latin1');
  try {
    vm.runInNewContext(code, vm.createContext({ log, atob }), { timeout: 2_000 });
  } catch (error) {
    lines.push(`THROWN ${(error as Error).name}`);
  }
  return lines.join('\n');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

const list = (values: readonly string[]): string => values.map((v) => JSON.stringify(v)).join(', ');
const utf8Base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** The cipher with a term added to its key schedule and a stride of two in its generator. */
function tweakedRc4(data: string, key: string, addIndex: boolean, stride: number): string {
  const s: number[] = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key.charCodeAt(i % key.length) + (addIndex ? i : 0)) % 256;
    const x = s[i]!;
    s[i] = s[j]!;
    s[j] = x;
  }
  let a = 0;
  let b = 0;
  let out = '';
  for (let k = 0; k < data.length; k++) {
    a = (a + stride) % 256;
    b = (b + s[a]!) % 256;
    const x = s[a]!;
    s[a] = s[b]!;
    s[b] = x;
    out += String.fromCharCode(data.charCodeAt(k) ^ s[(s[a]! + s[b]!) % 256]!);
  }
  return out;
}

interface Spelling {
  /** The key-schedule step. */
  schedule: string;
  /** The generator's first step. */
  stride: string;
  /** The swap after the schedule step, or nothing. */
  scheduleSwap: string;
  modulus: string;
}

const STOCK: Spelling = {
  schedule: "_0x9 = (_0x9 + _0x8[_0xf] + _0x7['charCodeAt'](_0xf % _0x7['length'])) % 0x100;",
  stride: '_0xf = (_0xf + 0x1) % 0x100;',
  scheduleSwap: '_0xa = _0x8[_0xf]; _0x8[_0xf] = _0x8[_0x9]; _0x8[_0x9] = _0xa;',
  modulus: '0x100',
};

function fixture(entries: readonly { text: string; key: string }[], encode: (text: string, key: string) => string, spelling: Spelling): string {
  const encoded = entries.map((entry) => utf8Base64(encode(entry.text, entry.key)));
  const calls = entries.map((entry, index) => `_0xdec(0x${index.toString(16)}, ${JSON.stringify(entry.key)})`).join(', ');
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
        for (_0xf = 0; _0xf < ${spelling.modulus}; _0xf++) { _0x8[_0xf] = _0xf; }
        for (_0xf = 0; _0xf < ${spelling.modulus}; _0xf++) {
          ${spelling.schedule}
          ${spelling.scheduleSwap}
        }
        _0xf = 0; _0x9 = 0;
        for (var _0x10 = 0; _0x10 < _0x6['length']; _0x10++) {
          ${spelling.stride}
          _0x9 = (_0x9 + _0x8[_0xf]) % ${spelling.modulus};
          _0xa = _0x8[_0xf]; _0x8[_0xf] = _0x8[_0x9]; _0x8[_0x9] = _0xa;
          _0xb += String['fromCharCode'](_0x6['charCodeAt'](_0x10) ^ _0x8[(_0x8[_0xf] + _0x8[_0x9]) % ${spelling.modulus}]);
        }
        return _0xb;
      };
      return _0x5(_0x3, _0x2);
    };
    log(${calls});
  `;
}

const ENTRIES = [
  { text: 'hello world', key: 'k1' },
  { text: 'second entry', key: 'zz' },
];

describe('what reads as rc4', () => {
  it('the stock schedule and generator', () => {
    const source = fixture(ENTRIES, rc4, STOCK);
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toMatchObject({ algorithm: 'rc4', keyArgIndex: 1 });
  });

  it('the stock cipher with its modulus written as arithmetic', () => {
    const source = fixture(ENTRIES, rc4, { ...STOCK, modulus: '(0x8d1 * 0x3 + -0x56f + -0x16e * 0xe)' });
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toMatchObject({ algorithm: 'rc4', keyArgIndex: 1 });
  });

  it('not a schedule with a term added', () => {
    const source = fixture(ENTRIES, (d, k) => tweakedRc4(d, k, true, 1), {
      ...STOCK,
      schedule: "_0x9 = (_0x9 + _0x8[_0xf] + _0x7['charCodeAt'](_0xf % _0x7['length']) + _0xf) % 0x100;",
    });
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toBeNull();
  });

  it('not a generator with a stride of two', () => {
    const source = fixture(ENTRIES, (d, k) => tweakedRc4(d, k, false, 2), { ...STOCK, stride: '_0xf = (_0xf + 0x2) % 0x100;' });
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toBeNull();
  });

  it('not a schedule without its swap', () => {
    const source = fixture(ENTRIES, rc4, { ...STOCK, scheduleSwap: '' });
    expect(recogniseEncoding(decoderBody(source, '_0xdec'))).toBeNull();
  });
});

describe('rc4 and its near misses, end to end', () => {
  const sources: [string, string][] = [
    ['stock rc4', fixture(ENTRIES, rc4, STOCK)],
    ['a schedule with a term added', fixture(ENTRIES, (d, k) => tweakedRc4(d, k, true, 1), {
      ...STOCK,
      schedule: "_0x9 = (_0x9 + _0x8[_0xf] + _0x7['charCodeAt'](_0xf % _0x7['length']) + _0xf) % 0x100;",
    })],
    ['a generator with a stride of two', fixture(ENTRIES, (d, k) => tweakedRc4(d, k, false, 2), { ...STOCK, stride: '_0xf = (_0xf + 0x2) % 0x100;' })],
  ];

  for (const [title, source] of sources) {
    for (const preset of PRESETS) {
      it(`prints what the program prints for ${title} at ${preset}`, async () => {
        expect(trace(await output(source, preset))).toBe(trace(source));
      });
    }
  }
});

describe('the sample gate', () => {
  /** A deterministic stream of bytes, uniform over 0..255. */
  function randomBytes(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 24;
    };
  }

  function randomTable(seed: number, count: number, length: (index: number) => number): string[] {
    const next = randomBytes(seed);
    const table: string[] = [];
    for (let i = 0; i < count; i++) {
      let s = '';
      for (let k = 0; k < length(i); k++) s += String.fromCharCode(next());
      table.push(s);
    }
    return table;
  }

  const samplesFor = (count: number): (readonly number[])[] => Array.from({ length: count }, (_, i) => [i]);
  const lookup = (table: readonly string[]) => (args: readonly (string | number)[]) => table[Number(args[0])];

  it('rejects a table of random bytes, whatever the lengths', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const long = randomTable(seed, 20, (i) => 4 + ((i * 7) % 13));
      expect(validateAgainstSamples(lookup(long), samplesFor(20)).ok).toBe(false);
      const short = randomTable(seed + 100, 20, () => 2);
      expect(validateAgainstSamples(lookup(short), samplesFor(20)).ok).toBe(false);
    }
  });

  it('accepts a table of text', () => {
    const table = ['hello world', 'getElementById', 'application/json', 'Ünïcödé text', '日本語', 'a\tb\nc', '0', 'x'];
    expect(validateAgainstSamples(lookup(table), samplesFor(table.length))).toEqual({ ok: true });
  });
});
