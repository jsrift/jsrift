import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { rc4, recogniseNativeDecoder } from '../src/analysis/evaluator/native.js';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

/**
 * A parameter moved by an assignment and then indexed past by a constant -
 * `i = i - 0x100; t[i - 1]` - is two offsets where the recogniser reads one,
 * so the element it would decode is the neighbour of the one the program
 * reads. The plain arm refuses the shape; the cipher arms do the same, and
 * the interpreter, which runs both moves, decodes it.
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

function recognise(source: string, roots: string[]) {
  const program = programPath(source);
  return recogniseNativeDecoder(sliceForEvaluation(program, roots), roots);
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

const utf8Base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** The stock rc4 decoder, its parameter moved by 0x100 and the table indexed one below that. */
function fixture(lookup: string): string {
  const entries = [
    { text: 'first entry', key: 'k1' },
    { text: 'hello world', key: 'zz' },
    { text: 'third entry', key: 'q9' },
  ];
  const encoded = entries.map((entry) => utf8Base64(rc4(entry.text, entry.key)));
  return `
    var _0xarr = [${encoded.map((v) => JSON.stringify(v)).join(', ')}];
    var _0xdec = function (_0x1, _0x2) {
      _0x1 = _0x1 - 0x100;
      var _0x3 = ${lookup};
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
    log(_0xdec(0x102, 'zz'), _0xdec(0x103, 'q9'));
  `;
}

describe('a cipher decoder whose parameter is moved twice', () => {
  it('is not read by the native tier', () => {
    expect(recognise(fixture('_0xarr[_0x1 - 0x1]'), ['_0xdec'])).toBeNull();
    expect(recognise(fixture('_0xarr[_0x1]'), ['_0xdec'])).not.toBeNull();
  });

  for (const preset of PRESETS) {
    it(`decodes to what the program prints at ${preset}`, async () => {
      const source = fixture('_0xarr[_0x1 - 0x1]');
      expect(trace(await output(source, preset))).toBe(trace(source));
    });
  }

  it('is decoded by the interpreter at balanced', async () => {
    expect(await output(fixture('_0xarr[_0x1 - 0x1]'), 'balanced')).toContain("'hello world'");
  });
});
