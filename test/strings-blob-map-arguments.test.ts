import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * A packed-blob accessor whose every call takes its arguments from an object
 * map, `acc(U.a, U.b)`, has no site to be proved on until the map is inlined,
 * and is put up again on the round after. The line that said it was left as
 * written is withdrawn by the round that adopts it: the report carries the
 * last word on the accessor, and the output bears that one out.
 *
 * The blob is produced by an independent basE91 encoder written from the
 * published algorithm, so a case passing means the recogniser agrees with
 * the specification. Every case runs input and output in a fresh realm with
 * only `log` and compares the traces.
 */
const ALPHABET = shuffled(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"',
);

function shuffled(source: string): string {
  const chars = [...source];
  let seed = 20260904;
  for (let i = chars.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function encodeBasE91(bytes: readonly number[]): string {
  let accumulator = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    accumulator |= byte << bits;
    bits += 8;
    if (bits > 13) {
      let value = accumulator & 8191;
      if (value > 88) {
        accumulator >>= 13;
        bits -= 13;
      } else {
        value = accumulator & 16383;
        accumulator >>= 14;
        bits -= 14;
      }
      out += ALPHABET[value % 91]! + ALPHABET[Math.floor(value / 91)]!;
    }
  }
  if (bits > 0) {
    out += ALPHABET[accumulator % 91]!;
    if (bits > 7 || accumulator > 90) out += ALPHABET[Math.floor(accumulator / 91)]!;
  }
  return out;
}

/** The blob and each entry's `[offset, length]`, padded past the recogniser's size floor. */
function packBlob(entries: readonly string[]): { text: string; spans: [number, number][] } {
  const spans: [number, number][] = [];
  let text = '';
  for (const entry of entries) {
    const encoded = encodeBasE91([...new TextEncoder().encode(entry)]);
    spans.push([text.length, encoded.length]);
    text += encoded;
  }
  for (let filler = 0; text.length < 96; filler++) {
    text += encodeBasE91([...new TextEncoder().encode(`padding-${filler}`)]);
  }
  return { text, spans };
}

/** The unpacking loop as the protectors write it, over the accessor's cache. */
function blobProgram(entries: readonly string[], body: (span: (index: number) => string) => string): string {
  const blob = packBlob(entries);
  const span = (index: number): string => blob.spans[index]!.join(', ');
  return `
var BLOB = ${JSON.stringify(blob.text)};
var CACHE = {};
function acc(start, len) {
  var key = start + '-' + len;
  return typeof CACHE[key] === 'undefined'
    ? CACHE[key] = function (text) {
        for (var s = '' + (text || ''), n = s['length'], out = [], b = 0, bits = 0, v = -1, i = 0; i < n; i++) {
          var p = ${JSON.stringify(ALPHABET)}['indexOf'](s[i]);
          if (p !== -1) {
            if (v < 0) {
              v = p;
            } else {
              b |= (v += p * 91) << bits;
              bits += (v & 8191) > 88 ? 13 : 14;
              do {
                out['push'](b & 255);
                b >>= 8;
                bits -= 8;
              } while (bits > 7);
              v = -1;
            }
          }
        }
        return v > -1 && out['push']((b | v << bits) & 255), String.fromCharCode.apply(null, out);
      }(BLOB['slice'](start, start + len))
    : CACHE[key];
}
${body(span)}
`;
}

function execute(code: string): string {
  const out: string[] = [];
  try {
    vm.runInNewContext(code, vm.createContext({ log: (...a: unknown[]) => out.push(a.map(String).join(' ')) }), {
      timeout: 5_000,
    });
  } catch (error) {
    out.push(`THROWN ${(error as Error).name}`);
  }
  return out.join('\n');
}

const LEFT = /^Left the packed-blob accessor acc as written/;
const RECOGNISED = /^Recognised acc as a packed-blob decoder/;

describe('strings.discover: a blob accessor called only through an object map', () => {
  const SOURCE = blobProgram(['createElement', 'appendChild'], (span) => {
    const [first, second] = [span(0).split(', '), span(1).split(', ')];
    return `
      function show() {
        var U = { a: ${first[0]}, b: ${first[1]}, c: ${second[0]}, d: ${second[1]} };
        log(acc(U.a, U.b), acc(U.c, U.d));
      }
      show();
    `;
  });

  it.each(['balanced', 'aggressive'] as const)('%s adopts it on the round after the map is inlined and withdraws the earlier line', async (preset) => {
    const { code, metadata } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).toContain("'createElement'");
    expect(code).toContain("'appendChild'");
    expect(code).not.toMatch(/\bacc\(/);
    const lines = metadata.diagnostics.map((d) => d.message);
    expect(lines.filter((m) => RECOGNISED.test(m))).toHaveLength(1);
    expect(lines.some((m) => LEFT.test(m))).toBe(false);
  });

  it('conservative leaves the calls as written and says why once', async () => {
    const { code, metadata } = await deobfuscate(SOURCE, { preset: 'conservative' });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).toMatch(/\bacc\(U\.a, U\.b\)/);
    const lines = metadata.diagnostics.map((d) => d.message);
    expect(lines.filter((m) => LEFT.test(m))).toHaveLength(1);
    expect(lines.some((m) => RECOGNISED.test(m))).toBe(false);
  });
});
