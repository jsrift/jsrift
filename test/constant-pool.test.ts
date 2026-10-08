import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import {
  constantPoolNode,
  constantPoolValueOf,
} from '../src/analysis/string-array.js';
import {
  decodeBitPacked,
  recogniseBitPackDecoder,
  recogniseBlobAccessors,
  isPositionalForwarder,
} from '../src/analysis/evaluator/native.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { pruneDecodersPass } from '../src/passes/strings/prune-decoders.js';
import type { Pass } from '../src/pipeline/pass.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';

/**
 * The constant-pool and packed-blob family.
 *
 * This is the shape a commercial protector emits and the one every string-array
 * recogniser is blind to: there is no array of strings anywhere. Instead there
 * is a *pool* - one heterogeneous array holding every string, mask and sentinel
 * the program was written with - and a *blob*, one long `basE91`-style payload
 * that call sites index by byte range rather than by position.
 *
 * The two are inseparable in practice. Until pool reads are values again, the
 * decoder's own radix is `pool[12]` and its call sites read `G(498, pool[2])`,
 * so nothing has a literal argument and nothing can be proved about anything.
 *
 * Every fixture below is *generated*: the payloads are produced by an
 * independent basE91 encoder written from the published algorithm, so a test
 * passing means the recogniser agrees with the specification rather than with a
 * golden string copied out of the implementation it is meant to check.
 */

const STRING_PASSES: Pass[] = [discoverStringsPass, inlineStringsPass, pruneDecodersPass];

// ---------------------------------------------------------------------------
// An independent basE91 encoder, from the published algorithm
// ---------------------------------------------------------------------------

/** A deterministic 91-symbol alphabet that is not the published one. */
const ALPHABET = shuffled(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"',
);

function shuffled(source: string): string {
  const chars = [...source];
  // A fixed linear-congruential shuffle: reproducible, and unrelated to the
  // orderings any real build uses.
  let seed = 20260904;
  for (let i = chars.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function encodeBasE91(bytes: readonly number[], alphabet: string): string {
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
      out += alphabet[value % 91]! + alphabet[Math.floor(value / 91)]!;
    }
  }
  if (bits > 0) {
    out += alphabet[accumulator % 91]!;
    if (bits > 7 || accumulator > 90) out += alphabet[Math.floor(accumulator / 91)]!;
  }
  return out;
}

interface Blob {
  text: string;
  /** `[offset, length]` for each entry, in the order they were packed. */
  spans: [number, number][];
}

/**
 * Pack a list of strings into one blob, recording each entry's byte range.
 *
 * Padded to a realistic size: the recogniser will not call a sixty-character
 * string a table, and a fixture squeaking under that floor would be testing the
 * threshold rather than the algorithm.
 */
function packBlob(entries: readonly string[], alphabet: string): Blob {
  const spans: [number, number][] = [];
  let text = '';
  for (const entry of entries) {
    const encoded = encodeBasE91([...new TextEncoder().encode(entry)], alphabet);
    spans.push([text.length, encoded.length]);
    text += encoded;
  }
  for (let filler = 0; text.length < 96; filler++) {
    text += encodeBasE91([...new TextEncoder().encode(`padding-${filler}`)], alphabet);
  }
  return { text, spans };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * The unpacking loop, written the way the protectors write it: computed member
 * access throughout, a comma-fused return, and a `do/while` drain.
 *
 * `constants` decides whether the loop's numbers are literals or pool reads,
 * which is the whole point of the composed test further down.
 */
function unpackerBody(alphabet: string, constants: (n: number) => string, sink: string): string {
  return `function (text) {
    for (var s = '' + (text || ''), n = s['length'], out = [], b = ${constants(0)}, bits = ${constants(0)}, v = -${constants(1)}, i = ${constants(0)}; i < n; i++) {
      var p = ${quote(alphabet)}['indexOf'](s[i]);
      if (p !== -${constants(1)}) {
        if (v < ${constants(0)}) {
          v = p;
        } else {
          b |= (v += p * ${constants(91)}) << bits;
          bits += (v & ${constants(8191)}) > ${constants(88)} ? ${constants(13)} : ${constants(14)};
          do {
            out['push'](b & ${constants(255)});
            b >>= ${constants(8)};
            bits -= ${constants(8)};
          } while (bits > ${constants(7)});
          v = -${constants(1)};
        }
      }
    }
    return v > -${constants(1)} && out['push']((b | v << bits) & ${constants(255)}), ${sink};
  }`;
}

/** `String.fromCharCode.apply(null, bytes)` - a Latin-1 sink, and reachable. */
const LATIN1_SINK = `String.fromCharCode.apply(null, out)`;

function literalConstant(n: number): string {
  return String(n);
}

/**
 * A complete program: the blob, the accessor, and whatever call sites the caller
 * wants written against it.
 */
function blobProgram(
  entries: readonly string[],
  body: (call: (index: number) => string) => string,
  options: {
    alphabet?: string;
    constants?: (n: number) => string;
    sink?: string;
    preamble?: string;
    accessor?: string;
  } = {},
): string {
  const alphabet = options.alphabet ?? ALPHABET;
  const constants = options.constants ?? literalConstant;
  const blob = packBlob(entries, alphabet);
  const accessor = options.accessor ?? 'acc';
  const call = (index: number): string => {
    const [offset, length] = blob.spans[index]!;
    return `${accessor}(${offset}, ${length})`;
  };
  return `
${options.preamble ?? ''}
var BLOB = ${quote(blob.text)};
var CACHE = {};
function ${accessor}(start, len) {
  var key = start + '-' + len;
  return typeof CACHE[key] === 'undefined'
    ? CACHE[key] = ${unpackerBody(alphabet, constants, options.sink ?? LATIN1_SINK)}(BLOB['slice'](start, start + len))
    : CACHE[key];
}
${body(call)}
`;
}

// ---------------------------------------------------------------------------
// Constant pools
// ---------------------------------------------------------------------------

/** Twelve entries is the floor, and the pool has to be heterogeneous. */
const POOL = `var P = ['length', 255, 'push', !0, null, 8, 'slice', !1, 91, 'name', -1, 1e3];`;

describe('constant pools', () => {
  // The pool *declaration* survives this pass set: deleting a binding nothing
  // reads any more is `clean.unused`'s job, not the string stage's. Every
  // assertion below is therefore about the reads, which is what this rewrites.
  const afterPool = (code: string): string => code.slice(code.indexOf(';') + 1).trim();

  it('inlines pool reads and preserves each value’s exact type', async () => {
    const { code } = await runPass(
      STRING_PASSES,
      `${POOL}\nsend(P[0], P[1], P[3], P[4], P[7], P[10], P[11]);`,
    );
    expectEquivalent(afterPool(code), `send('length', 255, true, null, false, -1, 1000);`);
  });

  it('does not stringify the sentinels', async () => {
    const { code } = await runPass(STRING_PASSES, `${POOL}\nif (P[3] === P[7]) go(P[4]);`);
    // `true`/`false`/`null`, never `'true'`/`'false'`/`'null'`.
    expect(afterPool(code)).not.toMatch(/'(true|false|null)'/);
    expectEquivalent(afterPool(code), `if (true === false) go(null);`);
  });

  it('refuses a pool that is written through', async () => {
    const source = `${POOL}\nP[0] = 'changed';\nsend(P[1]);`;
    await expectNoChange(STRING_PASSES, source);
  });

  it('refuses a pool that is mutated by a method call', async () => {
    const source = `${POOL}\nP['push']('extra');\nsend(P[1]);`;
    await expectNoChange(STRING_PASSES, source);
  });

  it('refuses a pool whose binding is reassigned', async () => {
    const source = `${POOL}\nP = other();\nsend(P[1]);`;
    await expectNoChange(STRING_PASSES, source);
  });

  it('refuses a pool that escapes as a value', async () => {
    const source = `${POOL}\nregister(P);\nsend(P[1]);`;
    await expectNoChange(STRING_PASSES, source);
  });

  it('leaves an all-string array to the string-array path', async () => {
    // Twelve strings: pool-sized, but homogeneous, so the pool rule declines and
    // the array-index recogniser owns it.
    const strings = Array.from({ length: 12 }, (_, i) => `'s${i}'`).join(', ');
    const { ctx, code } = await runPass(STRING_PASSES, `var A = [${strings}];\nsend(A[3]);`);
    expect(code).toContain(`'s3'`);
    expect(ctx.stringSources.some((source) => source.kind === 'array-index')).toBe(true);
  });

  it('leaves a homogeneous numeric table alone', async () => {
    const numbers = Array.from({ length: 16 }, (_, i) => i * 7).join(', ');
    await expectNoChange(STRING_PASSES, `var T = [${numbers}];\nsend(T[3], T[9]);`);
  });

  it('ignores an array too small to be a pool', async () => {
    await expectNoChange(STRING_PASSES, `var P = ['a', 1, 'b', 2];\nsend(P[0], P[1]);`);
  });

  it('leaves an out-of-range read alone', async () => {
    const { code } = await runPass(STRING_PASSES, `${POOL}\nsend(P[0], P[99]);`);
    expect(code).toContain('P[99]');
    expect(code).toContain(`'length'`);
  });

  it('leaves a very long entry in place rather than copying it everywhere', async () => {
    const long = 'x'.repeat(400);
    const source = `var P = ['a', 1, 'b', 2, 'c', 3, 'd', 4, 'e', 5, 'f', '${long}'];\nsend(P[0], P[11], P[11], P[11]);`;
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'a'`);
    expect(code).toContain('P[11]');
  });

  it('keeps two same-named pools in sibling scopes apart', async () => {
    const first = `['alpha', 1, 'b', 2, 'c', 3, 'd', 4, 'e', 5, 'f', 6]`;
    const second = `['omega', 9, 'z', 8, 'y', 7, 'x', 6, 'w', 5, 'v', 4]`;
    const { code } = await runPass(
      STRING_PASSES,
      `function one() { var P = ${first}; return P[0]; }\n` +
        `function two() { var P = ${second}; return P[0]; }`,
    );
    expectEquivalent(
      code,
      `function one() { var P = ${first}; return 'alpha'; } ` +
        `function two() { var P = ${second}; return 'omega'; }`,
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(STRING_PASSES, `${POOL}\nsend(P[0], P[3], P[4]);`);
  });
});

describe('constant pool values', () => {
  it('reads every literal shape a minifier emits', () => {
    const parsed = (text: string): t.Node =>
      (parse(`(${text})`).program.body[0] as t.ExpressionStatement).expression;
    expect(constantPoolValueOf(parsed(`'x'`))).toEqual({ value: 'x' });
    expect(constantPoolValueOf(parsed('255'))).toEqual({ value: 255 });
    expect(constantPoolValueOf(parsed('!0'))).toEqual({ value: true });
    expect(constantPoolValueOf(parsed('!1'))).toEqual({ value: false });
    expect(constantPoolValueOf(parsed('null'))).toEqual({ value: null });
    expect(constantPoolValueOf(parsed('-1'))).toEqual({ value: -1 });
    expect(constantPoolValueOf(parsed('true'))).toEqual({ value: true });
    // Not constants that can be reproduced without evaluating something.
    expect(constantPoolValueOf(parsed('void 0'))).toBeUndefined();
    expect(constantPoolValueOf(parsed('x'))).toBeUndefined();
    expect(constantPoolValueOf(parsed('[1]'))).toBeUndefined();
  });

  it('builds a node of the value’s own type', () => {
    expect(constantPoolNode('x')!.type).toBe('StringLiteral');
    expect(constantPoolNode(255)!.type).toBe('NumericLiteral');
    expect(constantPoolNode(true)!.type).toBe('BooleanLiteral');
    expect(constantPoolNode(null)!.type).toBe('NullLiteral');
    // Babel refuses a negative NumericLiteral, so a sign is an explicit negation.
    expect(constantPoolNode(-1)).toMatchObject({ type: 'UnaryExpression', operator: '-' });
    expect(constantPoolNode('x'.repeat(1000))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The unpacking loop
// ---------------------------------------------------------------------------

function parseFunction(source: string): t.Function {
  const program = parse(source, { sourceType: 'script' }).program;
  const statement = program.body[0]!;
  if (t.isFunctionDeclaration(statement)) return statement;
  throw new Error('expected a function declaration');
}

describe('recognising the unpacking loop', () => {
  const loop = (body: string): t.Function =>
    parseFunction(`function unpack(text) { ${body} }`);

  it('reads the alphabet and every packing constant off the AST', () => {
    const source = unpackerBody(ALPHABET, literalConstant, LATIN1_SINK);
    const fn = parseFunction(`function unpack(text) { return (${source})(text); }`);
    const recognition = recogniseBitPackDecoder(fn);
    expect(recognition).not.toBeNull();
    expect(recognition!.charset).toBe(ALPHABET);
    expect(recognition!.params).toEqual({
      radix: 91,
      mask: 8191,
      threshold: 88,
      bitsWhenAbove: 13,
      bitsWhenBelow: 14,
      byteMask: 255,
      shift: 8,
      keep: 7,
    });
  });

  it('round-trips every byte an entry can contain', () => {
    const source = unpackerBody(ALPHABET, literalConstant, LATIN1_SINK);
    const fn = parseFunction(`function unpack(text) { return (${source})(text); }`);
    const recognition = recogniseBitPackDecoder(fn)!;
    for (const sample of ['a', 'hello world', 'documentElement', '', 'ÿþ', 'x'.repeat(64)]) {
      const bytes = [...new TextEncoder().encode(sample)];
      const decoded = decodeBitPacked(encodeBasE91(bytes, ALPHABET), {
        ...recognition,
        byteMode: 'latin1',
      });
      expect([...decoded!].map((c) => c.charCodeAt(0))).toEqual(bytes);
    }
  });

  it('decodes UTF-8 payloads when the sink says UTF-8', () => {
    const source = unpackerBody(ALPHABET, literalConstant, `new TextDecoder().decode(new Uint8Array(out))`);
    const fn = parseFunction(`function unpack(text) { return (${source})(text); }`);
    const recognition = recogniseBitPackDecoder(fn)!;
    expect(recognition.byteMode).toBe('utf8');
    const sample = '\u{1f3ae} Play - café';
    const encoded = encodeBasE91([...new TextEncoder().encode(sample)], ALPHABET);
    expect(decodeBitPacked(encoded, recognition)).toBe(sample);
  });

  it('is not fooled into Latin-1 by a fromCharCode string constant', () => {
    // `String.fromCharCode(112, 108, ...)` spells out a hidden literal; it says
    // nothing about how the byte array becomes a string, and reading it as
    // evidence turns every UTF-8 entry into mojibake.
    const sink = `check(String.fromCharCode(112, 108, 97, 121)) && toText(out)`;
    const source = unpackerBody(ALPHABET, literalConstant, sink);
    const fn = parseFunction(`function unpack(text) { return (${source})(text); }`);
    expect(recogniseBitPackDecoder(fn)!.byteMode).toBe('utf8');
  });

  it('refuses a loop whose constants do not describe a workable scheme', () => {
    const broken = unpackerBody(ALPHABET, literalConstant, LATIN1_SINK).replace(
      '& 255',
      '& 254',
    );
    const fn = parseFunction(`function unpack(text) { return (${broken})(text); }`);
    expect(recogniseBitPackDecoder(fn)).toBeNull();
  });

  it('refuses a loop whose radix is not the alphabet length', () => {
    const broken = unpackerBody(ALPHABET, literalConstant, LATIN1_SINK).replace('* 91', '* 64');
    const fn = parseFunction(`function unpack(text) { return (${broken})(text); }`);
    expect(recogniseBitPackDecoder(fn)).toBeNull();
  });

  it('refuses an ordinary indexOf loop', () => {
    expect(
      recogniseBitPackDecoder(
        loop(`var out = ''; for (var i = 0; i < text.length; i++) { out += 'abcdef'['indexOf'](text[i]); } return out;`),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The accessor and its forwarder
// ---------------------------------------------------------------------------

describe('recognising the blob accessor', () => {
  it('pairs a blob with the loop that unpacks it', () => {
    const source = blobProgram(['alpha', 'beta'], () => '');
    const accessors = recogniseBlobAccessors(parse(source, { sourceType: 'script' }).program.body);
    expect([...accessors.keys()]).toEqual(['acc']);
    expect(accessors.get('acc')!.blobName).toBe('BLOB');
    expect(accessors.get('acc')!.lengthIsEnd).toBe(false);
  });

  it('finds nothing when the blob is missing', () => {
    const source = blobProgram(['alpha'], () => '').replace(/var BLOB = "[^"]*";/, 'var BLOB = "";');
    const accessors = recogniseBlobAccessors(parse(source, { sourceType: 'script' }).program.body);
    expect(accessors.size).toBe(0);
  });

  it('accepts a guarded forwarder that can only finish by forwarding', () => {
    const fn = parseFunction(
      `function G(e, U) { var h = hash(acc); if (h === 1228482746886050) { return acc(e, U); } else { while (true) {} } }`,
    );
    expect(isPositionalForwarder(fn, 'acc')).toBe(true);
  });

  it('refuses a forwarder with a path that completes without forwarding', () => {
    const fn = parseFunction(
      `function G(e, U) { if (ok()) { return acc(e, U); } }`,
    );
    expect(isPositionalForwarder(fn, 'acc')).toBe(false);
  });

  it('refuses a forwarder that permutes or drops its arguments', () => {
    expect(
      isPositionalForwarder(parseFunction(`function G(e, U) { return acc(U, e); }`), 'acc'),
    ).toBe(false);
    expect(
      isPositionalForwarder(parseFunction(`function G(e, U) { return acc(e); }`), 'acc'),
    ).toBe(false);
    expect(
      isPositionalForwarder(parseFunction(`function G(e, U) { return acc(e, U + 1); }`), 'acc'),
    ).toBe(false);
  });

  it('refuses a forwarder whose loop can break out', () => {
    const fn = parseFunction(
      `function G(e, U) { if (h()) { return acc(e, U); } else { while (true) { break; } } }`,
    );
    expect(isPositionalForwarder(fn, 'acc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('packed-blob decoders end to end', () => {
  it('inlines every call site of a blob accessor', async () => {
    const source = blobProgram(
      ['createElement', 'appendChild', 'documentElement'],
      (call) => `send(${call(0)}, ${call(1)}, ${call(2)});`,
    );
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'createElement'`);
    expect(code).toContain(`'appendChild'`);
    expect(code).toContain(`'documentElement'`);
    expect(code).not.toContain('acc(');
    assertParses(code);
  });

  it('deletes the blob once nothing reads it', async () => {
    const source = blobProgram(['createElement'], (call) => `send(${call(0)});`);
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).not.toContain('BLOB');
  });

  it('reaches the accessor through a guarded forwarder', async () => {
    const source = blobProgram(
      ['createElement', 'appendChild'],
      (call) => `send(${call(0)}, ${call(1)});`,
      {
        accessor: 'inner',
      },
    ).concat(`
function G(e, U) {
  var h = fingerprint(inner);
  if (h === 1228482746886050) { return inner(e, U); }
  else { while (true) {} }
}
`);
    // Rewrite the call sites to go through the forwarder instead.
    const throughForwarder = source.replace(/\binner\((\d+), (\d+)\)/g, 'G($1, $2)');
    const { code } = await runPass(STRING_PASSES, throughForwarder);
    expect(code).toContain(`'createElement'`);
    expect(code).toContain(`'appendChild'`);
    assertParses(code);
  });

  it('decodes when the packing constants themselves come from a pool', async () => {
    // The composed case, and the one the whole feature exists for: nothing in
    // the decoder is a literal until the pool is inlined, and nothing in the
    // pool is reachable until the decoder is recognised.
    const pool = [0, 1, 91, 8191, 88, 13, 14, 255, 8, 7, 'slice', 'push', 'length', null];
    const index = new Map<number, number>();
    pool.forEach((value, i) => {
      if (typeof value === 'number') index.set(value, i);
    });
    const constants = (n: number): string => `POOL[${index.get(n)}]`;
    const source = blobProgram(
      ['createElement', 'appendChild', 'documentElement'],
      (call) => `send(${call(0)}, ${call(1)}, ${call(2)});`,
      {
        constants,
        preamble: `var POOL = [${pool.map((v) => (typeof v === 'string' ? quote(v) : String(v))).join(', ')}];`,
      },
    );
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'createElement'`);
    expect(code).toContain(`'documentElement'`);
    expect(ctx.decodedStrings.size).toBe(3);
    assertParses(code);
  });

  it('keeps two accessors with the same name and different alphabets apart', async () => {
    const other = shuffled(ALPHABET);
    expect(other).not.toBe(ALPHABET);
    const first = blobProgram(['alpha'], (call) => `return ${call(0)};`, { alphabet: ALPHABET });
    const second = blobProgram(['omega'], (call) => `return ${call(0)};`, { alphabet: other });
    const { code } = await runPass(
      STRING_PASSES,
      `function one() {${first}}\nfunction two() {${second}}`,
    );
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'omega'`);
    assertParses(code);
  });

  it('leaves a call site whose arguments are not constant alone', async () => {
    const source = blobProgram(['createElement'], (call) => `send(${call(0)}, acc(start, len));`);
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'createElement'`);
    expect(code).toContain('acc(start, len)');
  });

  it('reads an overrunning span to the end of the blob, as slice() does', async () => {
    // Not a refusal: `BLOB.slice(0, 99999)` is the whole blob in the program
    // being read, so the call site has a definite value and the pass has to
    // agree with it rather than invent an error the program does not have.
    const source = blobProgram(['createElement'], (call) => `send(${call(0)}, acc(0, 99999));`);
    const { code } = await runPass(STRING_PASSES, source);
    expect(code).toContain(`'createElement'`);
    expect(code).not.toContain('acc(0, 99999)');
  });

  it('reads an offset past the end of the blob as the empty string', async () => {
    // Again the program's own answer: `slice` clamps both ends, so the run is
    // empty and the entry is `''`. The native tier and the interpreter agree,
    // which is the property that matters.
    const source = blobProgram(['createElement'], (call) => `send(${call(0)}, acc(99999, 8));`);
    const { code } = await runPass(STRING_PASSES, source);
    expectEquivalent(code.slice(code.lastIndexOf('send(')), `send('createElement', '');`);
  });

  it('refuses a negative offset rather than modelling slice’s end-relative form', async () => {
    const source = blobProgram(['createElement'], (call) => `send(${call(0)}, acc(-4, 8));`);
    const { code } = await runPass(STRING_PASSES, source, {
      techniques: { stringDecoding: { tiers: ['native'] } },
    });
    expect(code).toContain(`'createElement'`);
    expect(code).toContain('acc(-4, 8)');
  });

  it('is idempotent', async () => {
    const source = blobProgram(
      ['createElement', 'appendChild'],
      (call) => `send(${call(0)}, ${call(1)});`,
    );
    await expectIdempotent(STRING_PASSES, source);
  });

  it('does nothing to a file with a long string and no unpacker', async () => {
    await expectNoChange(
      STRING_PASSES,
      `var text = ${quote('lorem ipsum dolor sit amet '.repeat(8))};\nsend(text.slice(0, 8));`,
    );
  });
  // A blob accessor has no fingerprint in `prepare.detect` and no audit of its
  // own, so a refusal made without a note here is one the report never
  // mentions: the file comes out with its blob and its accessor intact and
  // nothing saying they were seen. Each way out of `adoptBlob` that is not an
  // adoption is asserted to leave a line, with the reason in it.
  it('says why when no call site carries two literal arguments', async () => {
    const source = blobProgram(
      ['createElement'],
      () => `function show(a, b) { send(acc(a, b)); }\nshow(0, 5);`,
    );
    const { code, ctx } = await runPass(STRING_PASSES, source);
    expect(code).toContain('acc(a, b)');
    expect(ctx.stringSources).toHaveLength(0);
    expect(
      ctx.diagnostics.some((d) =>
        /^Left the packed-blob accessor acc as written: no call to it carries two literal arguments/.test(
          d.message,
        ),
      ),
    ).toBe(true);
  });

  it('says why when the slice reaches outside and the native tier is not enabled', async () => {
    // The domain-lock idiom: the sink reads `location`, so the slice is not
    // closed and only the native tier could read it - and it is switched off.
    const source = blobProgram(['createElement'], (call) => `send(${call(0)});`, {
      sink: `(location.host, String.fromCharCode.apply(null, out))`,
    });
    const { code, ctx } = await runPass(STRING_PASSES, source, {
      techniques: { stringDecoding: { tiers: ['interpreter'] } },
    });
    expect(code).toContain('acc(');
    expect(ctx.stringSources).toHaveLength(0);
    expect(
      ctx.diagnostics.some((d) =>
        /^Left the packed-blob accessor acc as written: its slice reaches outside itself and only the native tier/.test(
          d.message,
        ),
      ),
    ).toBe(true);
  });
});
