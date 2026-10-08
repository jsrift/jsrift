import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import _traverse from '@babel/traverse';
import { deobfuscate } from '../src/index.js';
import { parseSource } from '../src/frontend/language.js';
import type { DeobfuscateOptions, SourceMap } from '../src/types.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Adversarial correctness audit, second round.
 *
 * The first round covered the semantics of individual constructs - `this`,
 * hoisting, TDZ, closures, labels, precedence. This one goes after the failures
 * that only appear when two correct things meet: a shared predicate that is
 * wrong in one syntactic position, a pass whose decision another pass has
 * already invalidated, and the printer's own post-processing.
 *
 * Every behavioural assertion runs both programs. A deobfuscator that emits
 * beautiful, readable, *wrong* code is worse than one that emits nothing, and
 * only execution can tell the two apart.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`;
  if (value instanceof RegExp) return value.toString();
  if (typeof value === 'function') return 'fn';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

/** Execute in a fresh realm and capture everything the program makes observable. */
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  const sandbox: Record<string, unknown> = {
    log,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    console: { log, warn: log, error: log, info: log, debug: log, trace: log },
  };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    // The *kind* of failure is observable behaviour: a ReferenceError that the
    // input did not produce is precisely the defect several of these look for.
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

async function deob(source: string, options: DeobfuscateOptions = {}): Promise<string> {
  const { code } = await deobfuscate(source, {
    preset: 'aggressive',
    ...options,
    performance: { verifyOutput: true, ...options.performance },
  });
  return code;
}

/** The core assertion: output must be observationally equivalent to input. */
async function expectSameBehaviour(
  source: string,
  options: DeobfuscateOptions = {},
): Promise<string> {
  const before = execute(source);
  const output = await deob(source, options);
  const after = execute(output);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input trace ---\n${before}\n--- output trace ---\n${after}\n--- output ---\n${output}`,
    );
  }
  return output;
}

/**
 * Names the code reads without declaring them.
 *
 * Comparing this set before and after is a sharper instrument than re-parsing:
 * output that deletes a declaration while leaving a reference to it behind
 * parses perfectly and dies on its first line. Any name that is unbound in the
 * output but was bound in the input is a deletion that took a live reference
 * with it.
 */
function unboundNames(code: string): Set<string> {
  const names = new Set<string>();
  const parsed = parseSource(code, { language: 'auto' });
  traverse(parsed.ast, {
    ReferencedIdentifier(path) {
      const { name } = path.node as { name: string };
      if (!path.scope.hasBinding(name, { noGlobals: true })) names.add(name);
    },
  });
  return names;
}

function expectNoNewDanglingNames(input: string, output: string): void {
  const before = unboundNames(input);
  const created = [...unboundNames(output)].filter((name) => !before.has(name));
  if (created.length > 0) {
    throw new Error(
      `Output references ${created.length} name(s) nothing declares any more: ${created.join(', ')}.\n` +
        `--- output ---\n${output}`,
    );
  }
}

// ===========================================================================
// 1. Assignment targets reached through a destructuring pattern
//
// `isPureContext` decides, for five different passes, whether a reference is a
// read. A check that looks only at the immediate parent reads every target
// reached through a pattern - `[A[0]] = [...]`, `({ k: A[0] } = ...)` - as a plain
// read. The value inlined there is stale, and the substitution produces
// `['a'] = [...]`, which is not parseable JavaScript.
// ===========================================================================

describe('audit: writes through a destructuring pattern are not reads', () => {
  const POOL = `var P = ['length', 255, 'push', !0, null, 8, 'slice', !1, 91, 'name', -1, 1e3];`;

  it('constant pool: array-pattern target', async () => {
    await expectSameBehaviour(`${POOL}\n[P[0]] = ['changed'];\nlog(P[0], P[1]);`);
  });

  it('constant pool: object-pattern target', async () => {
    await expectSameBehaviour(`${POOL}\n({ x: P[1] } = { x: 42 });\nlog(P[0], P[1]);`);
  });

  it('constant pool: nested pattern target', async () => {
    await expectSameBehaviour(
      `${POOL}\n({ a: { b: [P[0]] } } = { a: { b: ['deep'] } });\nlog(P[0], P[1]);`,
    );
  });

  it('constant pool: pattern with a default', async () => {
    await expectSameBehaviour(`${POOL}\n[P[0] = 'dflt'] = [];\nlog(P[0], P[1]);`);
  });

  it('constant pool: rest-element target', async () => {
    await expectSameBehaviour(`${POOL}\n[...P[0]] = ['a', 'b'];\nlog(P[0].length, P[1]);`);
  });

  it('constant pool: for-of over a pattern target', async () => {
    await expectSameBehaviour(`${POOL}\nfor ([P[0]] of [['loop']]) {}\nlog(P[0], P[1]);`);
  });

  it('string array: array-pattern target', async () => {
    await expectSameBehaviour(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
       [_0xa[0]] = ['CHANGED'];
       log(_0xa[0], _0xa[1], _0xa[2]);`,
    );
  });

  it('decoder table: object-pattern target', async () => {
    await expectSameBehaviour(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
       function _0xd(i) { return _0xa[i]; }
       ({ v: _0xa[1] } = { v: 'HACKED' });
       log(_0xd(0), _0xd(1));`,
    );
  });

  it('object alias map: array-pattern target', async () => {
    await expectSameBehaviour(
      `var _0xm = { 'aKey': 'one', 'bKey': 'two', 'cKey': 'three' };
       [_0xm['aKey']] = ['NEW'];
       log(_0xm['aKey'], _0xm['bKey']);`,
    );
  });

  it('still inlines an ordinary read that merely sits inside an object literal', async () => {
    // The guard must not over-fire: `{ x: A[0] }` is an ObjectProperty too, and
    // there the member expression is a value, not a target.
    const code = await deob(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
       log({ x: _0xa[0] }, [_0xa[1]]);`,
    );
    expect(code).toContain(`'alpha'`);
    expect(code).toContain(`'beta'`);
  });

  it('still inlines a read used as a parameter default', async () => {
    const code = await deob(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
       function f(a = _0xa[2]) { return a; }
       log(f());`,
    );
    expect(code).toContain(`'gamma'`);
  });
});

// ===========================================================================
// 2. `with` - a name that resolves at run time, not at analysis time
//
// Inside `with (o) { ... }` an identifier is looked up on `o` first. Every pass
// that rewrites a reference to the value of the binding the scope analysis
// reports is unsound there. Renaming already handles it; the four inlining
// passes have to as well.
// ===========================================================================

describe('audit: `with` defeats binding-based inlining', () => {
  it('string array read inside a with body', async () => {
    await expectSameBehaviour(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
       var o = { _0xa: ['SHADOW'] };
       with (o) { log(_0xa[0]); }
       log(_0xa[0]);`,
    );
  });

  it('decoder call inside a with body', async () => {
    await expectSameBehaviour(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta'];
       function _0xd(i) { return _0xa[i]; }
       var o = { _0xd: function (i) { return 'SHADOW' + i; } };
       with (o) { log(_0xd(0)); }
       log(_0xd(1));`,
    );
  });

  it('object alias map read inside a with body', async () => {
    await expectSameBehaviour(
      `var _0xm = { 'aKey': 'one', 'bKey': 'two', 'cKey': 'three' };
       var o = { _0xm: { aKey: 'SHADOW' } };
       with (o) { log(_0xm['aKey']); }
       log(_0xm['bKey']);`,
    );
  });

  it('proxy function call inside a with body', async () => {
    await expectSameBehaviour(
      `function _0xw(a, b) { return a + b; }
       var o = { _0xw: function () { return 'SHADOW'; } };
       with (o) { log(_0xw(1, 2)); }
       log(_0xw(3, 4));`,
    );
  });

  it('constant pool read inside a with body', async () => {
    await expectSameBehaviour(
      `var P = ['length', 255, 'push', !0, null, 8, 'slice', !1, 91, 'name', -1, 1e3];
       var o = { P: ['zzz'] };
       with (o) { log(P[0]); }
       log(P[0]);`,
    );
  });

  it('a with head is ordinary code and is still inlined', async () => {
    // Only the *body* is shadowed; the object expression is evaluated in the
    // enclosing scope, so refusing there would be a needless loss.
    const code = await deob(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
       var sink = 0;
       with ({ q: 1 }) { sink = q; }
       log(_0xa[0], sink);`,
    );
    expect(code).toContain(`'alpha'`);
  });

  it('inlining elsewhere in a file that happens to contain a with', async () => {
    const code = await deob(
      `var _0xa = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
       function outside() { return _0xa[1]; }
       with ({}) { log('x'); }
       log(outside());`,
    );
    expect(code).toContain(`'beta'`);
  });
});

// ===========================================================================
// 3. Deleting machinery through a stale path
//
// `strings` and `simplify` alternate inside the fixpoint loop, so a NodePath
// recorded in one `strings` round has had `simplify` rewrite its ancestors
// before the next round removes through it. When obfuscator.io emits the
// rotation wrapper inside a sequence shared with the program's own statements
// - `(rotate(arr, 0xaa6f2), realCode(), moreRealCode())`, which `compact`
// produces - `simplify.sequences` splits that sequence, and the stale path then
// edits a detached node while reporting success. The string array and the
// decoder go; the wrapper that calls them stays; the output parses and throws
// `ReferenceError` on its first line.
// ===========================================================================

describe('audit: machinery removal never leaves a dangling reference', () => {
  /** The shape above, hand-built so the assertion does not depend on a seed. */
  const ROTATION_IN_A_SEQUENCE = `
var _0xalias = _0xdec;
(function (provider, checksum) {
  var read = _0xdec, list = provider();
  while (!![]) {
    try {
      var total = parseInt(read(0)) / 1 + parseInt(read(1)) / 2;
      if (total === checksum) break;
      else list['push'](list['shift']());
    } catch (e) { list['push'](list['shift']()); }
  }
}(_0xarr, 987654),
log(_0xalias(2)),
log(_0xalias(3), [3, 1, 2]['sort']()['join']('')));
function _0xdec(i) { var t = _0xarr(); return t[i]; }
function _0xarr() {
  var data = ['11', '22', 'hello there', 'second value'];
  _0xarr = function () { return data; };
  return _0xarr();
}
`;

  it('keeps the program runnable when the rotation wrapper shares a sequence', async () => {
    const output = await expectSameBehaviour(ROTATION_IN_A_SEQUENCE);
    expectNoNewDanglingNames(ROTATION_IN_A_SEQUENCE, output);
  });

  it('a real obfuscator build with stringArrayCallsTransform stays runnable', async () => {
    // Captured from javascript-obfuscator 5.x with rotateStringArray,
    // shuffleStringArray, stringArrayIndexShift and stringArrayCallsTransform
    // under `compact`, which is what fuses the wrapper into the sequence.
    const input = readFileSync(
      new URL('./fixtures/rotation-in-sequence.js', import.meta.url),
      'utf8',
    );
    const output = await expectSameBehaviour(input);
    expectNoNewDanglingNames(input, output);
  });

  it('the real build is cleaned out, not merely left runnable', async () => {
    // Refusing to prune would also pass the two assertions above, so the point
    // of the fix - the machinery goes *and* the wrapper goes with it - needs its
    // own check. Nothing hex-named may survive.
    const input = readFileSync(
      new URL('./fixtures/rotation-in-sequence.js', import.meta.url),
      'utf8',
    );
    const output = await deob(input);
    expect(output).not.toMatch(/_0x[0-9a-f]{4,}/);
    expect(output).not.toContain('shift()');
    expect(output).toContain(`'changed'`);
  });
});

// ===========================================================================
// 4. The printer's own post-processing
//
// `output.indent` is applied by rewriting leading whitespace after the
// generator has run. Two things live in that whitespace which must not move:
// the interior of a multi-line literal, which is string *content*, and the
// generated columns the source map already recorded.
// ===========================================================================

describe('audit: re-indentation preserves string content', () => {
  const BACKTICK = String.fromCharCode(96);
  const BACKSLASH = String.fromCharCode(92);

  const TEMPLATE_SOURCE = [
    'function f() {',
    '  var s = ' + BACKTICK + 'alpha',
    '    beta',
    '  gamma' + BACKTICK + ';',
    '  return s;',
    '}',
    'log(JSON.stringify(f()));',
  ].join('\n');

  const CONTINUATION_SOURCE = [
    'function g() {',
    '  var s = "alpha' + BACKSLASH,
    '   beta";',
    '  return s;',
    '}',
    'log(JSON.stringify(g()));',
  ].join('\n');

  for (const indent of [1, 2, 3, 4, 8]) {
    it(`a multi-line template literal survives indent=${indent}`, async () => {
      await expectSameBehaviour(TEMPLATE_SOURCE, { output: { indent } });
    });

    it(`a backslash-continued string survives indent=${indent}`, async () => {
      await expectSameBehaviour(CONTINUATION_SOURCE, { output: { indent } });
    });
  }

  it('a regex holding quotes and a backtick does not desync the scan', async () => {
    const source = [
      'function h() {',
      '  var re = /["' + String.fromCharCode(39) + BACKTICK + ']/g;',
      '  var s = ' + BACKTICK + 'one',
      '      two' + BACKTICK + ';',
      '  return s.replace(re, "") + "|";',
      '}',
      'log(JSON.stringify(h()));',
    ].join('\n');
    await expectSameBehaviour(source, { output: { indent: 4 } });
  });

  it('a division that follows a value is not read as a regex', async () => {
    const source = [
      'function k(a, b) {',
      '  var q = a / b;',
      '  var s = ' + BACKTICK + 'x',
      '     y' + BACKTICK + ';',
      '  return q + s.length;',
      '}',
      'log(k(8, 2));',
    ].join('\n');
    await expectSameBehaviour(source, { output: { indent: 4 } });
  });

  it('still re-indents ordinary code', async () => {
    // The guard must not turn re-indentation off: this is the feature working.
    const code = await deob(
      `function f(n) {\n  if (n > 0) {\n    for (var i = 0; i < n; i++) {\n      n += i;\n    }\n  }\n  return n;\n}\nlog(f(3));`,
      { output: { indent: 4 } },
    );
    expect(code).toMatch(/\n {4}if/);
    expect(code).toMatch(/\n {8}for/);
    // Three levels deep, so the unit really is four rather than two.
    expect(code).toMatch(/\n {12}\S/);
    expect(code).not.toMatch(/\n {2}\S/);
  });
});

// ---------------------------------------------------------------------------

const VLQ_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

interface Mapping {
  generatedLine: number;
  generatedColumn: number;
  sourceLine: number;
  sourceColumn: number;
}

/** An independent VLQ reader, so the test does not share the printer's code. */
function decodeMappings(mappings: string): Mapping[] {
  const out: Mapping[] = [];
  let sourceLine = 0;
  let sourceColumn = 0;
  const lines = mappings.split(';');
  for (let generatedLine = 0; generatedLine < lines.length; generatedLine++) {
    let generatedColumn = 0;
    for (const segment of (lines[generatedLine] as string).split(',')) {
      if (segment.length === 0) continue;
      const fields: number[] = [];
      let shift = 0;
      let value = 0;
      for (const char of segment) {
        const digit = VLQ_ALPHABET.indexOf(char);
        expect(digit).toBeGreaterThanOrEqual(0);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        const negative = value & 1;
        value >>= 1;
        fields.push(negative ? -value : value);
        shift = 0;
        value = 0;
      }
      generatedColumn += fields[0] as number;
      if (fields.length === 1) continue;
      sourceLine += fields[2] as number;
      sourceColumn += fields[3] as number;
      out.push({ generatedLine, generatedColumn, sourceLine, sourceColumn });
    }
  }
  return out;
}

describe('audit: source map mappings describe the code that was emitted', () => {
  const SOURCE = `function alpha(one, two) {
  if (one > two) {
    var result = one + two;
    for (var i = 0; i < 3; i++) { result += i; }
    return result;
  }
  return 0;
}
console.log(alpha(1, 2));
`;

  it('every mapping lands inside the output it points at', async () => {
    const { code, map } = await deobfuscate(SOURCE, {
      preset: 'aggressive',
      output: { sourceMaps: true },
    });
    const lines = code.split('\n');
    const sourceLines = SOURCE.split('\n');
    const mappings = decodeMappings((map as SourceMap).mappings);
    expect(mappings.length).toBeGreaterThan(10);
    for (const m of mappings) {
      expect(m.generatedLine).toBeLessThan(lines.length);
      expect(m.generatedColumn).toBeLessThanOrEqual((lines[m.generatedLine] as string).length);
      expect(m.sourceLine).toBeLessThan(sourceLines.length);
      expect(m.sourceColumn).toBeLessThanOrEqual((sourceLines[m.sourceLine] as string).length);
    }
  });

  it('re-indenting moves the mappings with the text', async () => {
    // The two runs differ only in indentation, so a mapping must address the
    // same *token* in both: a map that comes out byte-identical across indents
    // is describing columns that have moved.
    const two = await deobfuscate(SOURCE, {
      preset: 'aggressive',
      output: { sourceMaps: true, indent: 2 },
    });
    const four = await deobfuscate(SOURCE, {
      preset: 'aggressive',
      output: { sourceMaps: true, indent: 4 },
    });

    const mapTwo = decodeMappings((two.map as SourceMap).mappings);
    const mapFour = decodeMappings((four.map as SourceMap).mappings);
    expect(mapTwo.length).toBe(mapFour.length);
    expect(two.code).not.toBe(four.code);

    const linesTwo = two.code.split('\n');
    const linesFour = four.code.split('\n');
    let indented = 0;
    for (let i = 0; i < mapTwo.length; i++) {
      const a = mapTwo[i] as Mapping;
      const b = mapFour[i] as Mapping;
      expect(b.generatedLine).toBe(a.generatedLine);
      expect(b.sourceLine).toBe(a.sourceLine);
      expect(b.sourceColumn).toBe(a.sourceColumn);
      const textTwo = (linesTwo[a.generatedLine] as string).slice(a.generatedColumn, a.generatedColumn + 12);
      const textFour = (linesFour[b.generatedLine] as string).slice(b.generatedColumn, b.generatedColumn + 12);
      expect(textFour).toBe(textTwo);
      if (b.generatedColumn !== a.generatedColumn) indented++;
    }
    // If nothing moved the assertion above proves nothing.
    expect(indented).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. The packed-blob / constant-pool family
//
// This protector has no array of strings anywhere: one bit-packed blob, and an
// accessor that cuts byte ranges out of it. Recognition is by shape, so the
// question worth asking is not "does it decode" but "does it refuse when the
// shape it matched does not compute what it assumed".
// ===========================================================================

describe('audit: packed-blob decoding is refused whenever the shape is not exact', () => {
  const ALPHABET = shuffle(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"',
  );

  function shuffle(source: string): string {
    const chars = [...source];
    let seed = 20260905;
    for (let i = chars.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
    }
    return chars.join('');
  }

  /** An independent basE91 encoder, written from the published algorithm. */
  function encode(bytes: readonly number[]): string {
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
        out += (ALPHABET[value % 91] as string) + (ALPHABET[Math.floor(value / 91)] as string);
      }
    }
    if (bits > 0) {
      out += ALPHABET[accumulator % 91] as string;
      if (bits > 7 || accumulator > 90) out += ALPHABET[Math.floor(accumulator / 91)] as string;
    }
    return out;
  }

  function program(
    entries: readonly string[],
    body: (call: (index: number) => string) => string,
    sink = `String.fromCharCode.apply(null, out)`,
  ): string {
    const spans: Array<[number, number]> = [];
    let blob = '';
    for (const entry of entries) {
      const encoded = encode([...new TextEncoder().encode(entry)]);
      spans.push([blob.length, encoded.length]);
      blob += encoded;
    }
    for (let filler = 0; blob.length < 128; filler++) {
      blob += encode([...new TextEncoder().encode(`padding-${filler}`)]);
    }
    const call = (index: number): string => {
      const [offset, length] = spans[index] as [number, number];
      return `acc(${offset}, ${length})`;
    };
    return `
var BLOB = ${JSON.stringify(blob)};
var CACHE = {};
function acc(start, len) {
  var key = start + '-' + len;
  return typeof CACHE[key] === 'undefined'
    ? CACHE[key] = (function (text) {
        for (var s = '' + (text || ''), n = s['length'], out = [], b = 0, bits = 0, v = -1, i = 0; i < n; i++) {
          var p = ${JSON.stringify(ALPHABET)}['indexOf'](s[i]);
          if (p !== -1) {
            if (v < 0) { v = p; }
            else {
              b |= (v += p * 91) << bits;
              bits += (v & 8191) > 88 ? 13 : 14;
              do { out['push'](b & 255); b >>= 8; bits -= 8; } while (bits > 7);
              v = -1;
            }
          }
        }
        return v > -1 && out['push']((b | v << bits) & 255), ${sink};
      })(BLOB['slice'](start, start + len))
    : CACHE[key];
}
${body(call)}
`;
  }

  const ENTRIES = ['hello world', 'second entry', 'third value', 'fourth item', 'fifth', 'sixth'];

  it('decodes the plain shape to literals', async () => {
    const source = program(ENTRIES, (call) => `log(${call(0)}, ${call(2)});`);
    const output = await expectSameBehaviour(source);
    expect(output).toContain('hello world');
  });

  it('reproduces the mojibake a Latin-1 sink over UTF-8 bytes actually produces', async () => {
    await expectSameBehaviour(program(['café', 'naïve', 'plain', 'more', 'yet', 'last'],
      (call) => `log(${call(0)}, ${call(1)});`));
  });

  it('refuses when the sink post-processes the decoded bytes', async () => {
    const source = program(ENTRIES, (call) => `log(${call(0)});`,
      `String.fromCharCode.apply(null, out)['toUpperCase']()`);
    await expectSameBehaviour(source);
  });

  it('refuses when the accessor shifts the offset before slicing', async () => {
    const source = program(ENTRIES, (call) => `log(${call(0)});`)
      .replace("BLOB['slice'](start, start + len)", "BLOB['slice'](start + 2, start + len + 2)");
    await expectSameBehaviour(source);
  });

  it('refuses when the blob is reassigned before it is read', async () => {
    await expectSameBehaviour(
      program(ENTRIES, (call) => `BLOB = 'zzzzzzzzzzzzzzzzzzzzzzzz'; log(${call(0)});`),
    );
  });

  it('refuses when the cache is poisoned', async () => {
    await expectSameBehaviour(
      program(ENTRIES, (call) => `CACHE = { '0-11': 'POISON' }; log(${call(0)}, ${call(1)});`),
    );
  });

  it('refuses when the accessor itself is rebound', async () => {
    await expectSameBehaviour(
      program(ENTRIES, (call) => `acc = function () { return 'REBOUND'; }; log(${call(0)});`),
    );
  });

  it('honours an accessor shadowed in an inner scope', async () => {
    await expectSameBehaviour(
      program(ENTRIES, (call) =>
        `function f() { function acc() { return 'SHADOW'; } return ${call(0)}; } log(f(), ${call(1)});`),
    );
  });

  it('decodes a run that is not an entry boundary', async () => {
    await expectSameBehaviour(program(ENTRIES, (call) => `log(${call(0)}, acc(3, 9), acc(1, 0));`));
  });

  it('is unmoved by a debugger and a domain lock injected into the accessor', async () => {
    const source = program(ENTRIES, (call) => `log(${call(0)}, ${call(3)});`).replace(
      'var key = start',
      "debugger; (function () { var h = 'x.com'; if (h !== 'x.com') { while (true) {} } })(); var key = start",
    );
    await expectSameBehaviour(source);
  });
});

// ===========================================================================
// 5b. The eval packer's substitution is simultaneous, not sequential
//
// `p.a.c.k.e.d` builds a token -> keyword table and runs *one*
// `p.replace(/\b\w+\b/g, m => d[m])`. Expanding one keyword at a time is not
// the same computation in either direction: a keyword spelled like another
// token gets rewritten again by that token's own pass. The published payload
// below is the minimal case - token `4` stands for the keyword `1`, and token
// `1` stands for `add`, so a descending sweep emits `return x + add` where the
// program says `return x + 1`. It parses and it runs.
// ===========================================================================

describe('audit: eval-packer unpacking matches what the packer computes', () => {
  const BACKSLASH = String.fromCharCode(92);
  const W = BACKSLASH + BACKSLASH + 'w+';
  const B = BACKSLASH + BACKSLASH + 'b';

  /** The canonical Dean Edwards unpacker, spelled exactly as it ships. */
  function pack(payload: string, base: number, count: number, keywords: string): string {
    return (
      `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};` +
      `if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}` +
      `k=[function(e){return d[e]}];e=function(){return'${W}'};c=1};` +
      `while(c--){if(k[c]){p=p.replace(new RegExp('${B}'+e(c)+'${B}','g'),k[c])}}return p}` +
      `(${JSON.stringify(payload)},${base},${count},${JSON.stringify(keywords)}.split('|'),0,{}))`
    );
  }

  /** What the packer itself produces, obtained by running it. */
  function unpackForReal(packed: string): string {
    const expression = `(${packed.slice('eval('.length, -1)})`;
    return vm.runInNewContext(expression, vm.createContext({ String })) as string;
  }

  it('a keyword spelled like another token is expanded once, not twice', async () => {
    const packed = pack('0 1(2){3 2+4}5(1(6))', 7, 7, 'function|add|x|return|1|log|41');
    expect(unpackForReal(packed)).toBe('function add(x){return x+1}log(add(41))');
    await expectSameBehaviour(packed);
  });

  it('a two-character token is not matched as its one-character prefix', async () => {
    // Above index 35 the base-36 encoder produces `10`, `11`, ... which contain
    // the tokens `1` and `0`. Only the longest match may win.
    const keywords = Array.from({ length: 40 }, (_, i) => `w${i}`);
    keywords[0] = 'log';
    keywords[1] = '"one"';
    keywords[36] = '"thirtysix"';
    const packed = pack('0(1,10)', 36, 40, keywords.join('|'));
    expect(unpackForReal(packed)).toBe('log("one","thirtysix")');
    await expectSameBehaviour(packed);
  });

  it('every keyword still reaches the output', async () => {
    const packed = pack('0(1,2,3)', 36, 4, 'log|"alpha"|"beta"|"gamma"');
    const output = await expectSameBehaviour(packed);
    expect(output).toContain('alpha');
    expect(output).toContain('gamma');
  });

  it('agrees with the packer on a spread of generated payloads', async () => {
    // A keyword list drawn so that collisions between a keyword and a token are
    // the common case rather than a curiosity.
    let seed = 987654321;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      // Past 35 the encoder emits two-character tokens, so the range spans both.
      const count = 6 + next(40);
      const keywords: string[] = ['log'];
      for (let i = 1; i < count; i++) {
        // Half plain words, half numerals that collide with the token alphabet.
        keywords.push(next(2) === 0 ? `w${i}` : String(next(count)));
      }
      const tokens = Array.from({ length: count }, (_, i) => i.toString(36));
      const body = Array.from({ length: 4 + next(4) }, () => tokens[next(count)] as string);
      const payload = `0(${JSON.stringify(body.join(' '))})`;
      const packed = pack(payload, 36, count, keywords.join('|'));
      const truth = unpackForReal(packed);
      const output = await deob(packed);
      // The unpacked text is a `log("...")` call; comparing the traces compares
      // the substitution result exactly.
      expect(execute(output)).toBe(execute(truth));
    }
  });
});

// ===========================================================================
// 5c. JSX text is not a JavaScript string
//
// `createElement('div', null, 'a {b} c')` cannot become `<div>a {b} c</div>`:
// braces are structural, `&` starts an entity, and two adjacent text children
// print as one run. Each of those changes the children array React receives.
// ===========================================================================

describe('audit: restored JSX children are the children React was given', () => {
  /**
   * JSX text to the string React receives, per the transform's published rule:
   * tabs become spaces, leading space is stripped from every line but the
   * first, trailing space from every line but the last, blank lines vanish, and
   * each surviving line but the last gains a joining space.
   */
  function cleanJsxText(value: string): string | undefined {
    const lines = value.split(/\r\n|\n|\r/);
    let lastNonEmpty = 0;
    for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i] as string)) lastNonEmpty = i;
    let out = '';
    for (let i = 0; i < lines.length; i++) {
      let line = (lines[i] as string).replace(/\t/g, ' ');
      if (i !== 0) line = line.replace(/^ +/, '');
      if (i !== lines.length - 1) line = line.replace(/ +$/, '');
      if (line) {
        if (i !== lastNonEmpty) line += ' ';
        out += line;
      }
    }
    return out === '' ? undefined : out;
  }

  /** The children of whichever element or factory call the output settled on. */
  function observedChildren(code: string): string[] | undefined {
    const parsed = parseSource(code, { language: 'jsx' });
    expect(parsed.recovered).toBe(false);
    let found: string[] | undefined;
    traverse(parsed.ast, {
      JSXElement(path) {
        if (found) return;
        const out: string[] = [];
        for (const child of path.node.children) {
          if (child.type === 'JSXText') {
            const cleaned = cleanJsxText(child.value);
            if (cleaned !== undefined) out.push(`str:${cleaned}`);
          } else if (child.type === 'JSXExpressionContainer') {
            if (child.expression.type === 'JSXEmptyExpression') continue;
            out.push(
              child.expression.type === 'StringLiteral'
                ? `str:${child.expression.value}`
                : 'expr',
            );
          } else {
            out.push('elem');
          }
        }
        found = out;
      },
      CallExpression(path) {
        if (found || path.node.callee.type !== 'MemberExpression') return;
        found = path.node.arguments
          .slice(2)
          .map((a) => (a.type === 'StringLiteral' ? `str:${a.value}` : 'expr'));
      },
    });
    return found;
  }

  const CHILDREN: ReadonlyArray<readonly [string, string[]]> = [
    ['leading and trailing spaces', ['str:  hello  ']],
    ['a single space', ['str: ']],
    ['braces', ['str:a {b} c']],
    ['an ampersand', ['str:AT&T']],
    ['angle brackets', ['str:a < b > c']],
    ['an embedded newline', ['str:one\ntwo']],
    ['an embedded tab', ['str:a\tb']],
    ['adjacent text children', ['str:one', 'str:two']],
    ['text, expression, text', ['str:one', 'expr', 'str:two']],
    ['the empty string', ['str:']],
  ];

  for (const [name, children] of CHILDREN) {
    it(name, async () => {
      const args = children.map((c) => (c === 'expr' ? 'q' : JSON.stringify(c.slice(4))));
      const source =
        `var q = 1;\nvar el = React.createElement('div', null, ${args.join(', ')});\nexport default el;`;
      const code = await deob(source, { filename: 'input.jsx' });
      expect(observedChildren(code)).toEqual([...children]);
    });
  }
});

// ===========================================================================
// 6. Anti-tamper removal must not take load-bearing code with it
// ===========================================================================

describe('audit: anti-tamper removal stays inside the trap', () => {
  it('a domain-lock wrapper that also does real work is left alone', async () => {
    await expectSameBehaviour(
      `var ready = 0;
       (function () {
         var h = 'example.com';
         if (h !== 'example.com') { while (true) {} }
         ready = 1;
       })();
       log(ready);`,
    );
  });

  it('a domain-lock wrapper that calls out is left alone', async () => {
    await expectSameBehaviour(
      `function boot() { log('booted'); }
       (function () {
         var h = 'example.com';
         if (h !== 'example.com') { while (true) {} }
         boot();
       })();
       log('done');`,
    );
  });

  it('a self-source probe whose wrapper assigns outward is left alone', async () => {
    await expectSameBehaviour(
      `var out = 0;
       (function () {
         var f = function () { return /\\s+/.test(f) ? 1 : 2; };
         out = f();
       })();
       log(out);`,
    );
  });

  it('a trampoline collapse preserves the call and its arguments', async () => {
    await expectSameBehaviour(
      `function impl(a, b) { log('impl', a, b); return a + b; }
       function hash() { return 12345; }
       function stub(a, b) {
         var d = impl.k || (impl.k = hash(impl, 47));
         if (d === 12345) { return impl(a, b); } else { while (true) {} }
       }
       log(stub(1, 2));`,
    );
  });

  it('a Function constructor with a real payload survives', async () => {
    await expectSameBehaviour(`var g = Function('return 40 + 2'); log(g());`);
  });

  it('a user-installed console wrapper survives', async () => {
    await expectSameBehaviour(
      `var seen = [];
       console.log = function (m) { seen.push(m); };
       console.log('x');
       log(seen.length);`,
    );
  });

  describe('the debugger flood is recognised by placement, not by count', () => {
    /**
     * `functions` bodies, each led by `perBlock` `debugger` statements.
     *
     * The bodies are deliberately more than one statement and every one of them
     * is called, so nothing here is erased by proxy inlining or dead-binding
     * removal before the flood rule is even reached - otherwise the assertions
     * below would be about the wrong pass.
     */
    function flood(functions: number, perBlock: number, extra = ''): string {
      const parts: string[] = [];
      for (let i = 0; i < functions; i++) {
        parts.push(
          `function f${i}(x) { ${'debugger; '.repeat(perBlock)}var t = x + ${i}; t = t * 2; return t; }`,
        );
      }
      const calls = Array.from({ length: functions }, (_, i) => `f${i}(${i})`);
      if (extra) {
        // A `debugger` a human parked *after* a statement, so it does not lead
        // its block and is not in the mechanical position.
        parts.push(`function human(x) { var t = x; debugger; t = t + 1; return t; }`);
        calls.push('human(1)');
      }
      parts.push(...parts.splice(parts.length, 0));
      parts.push(`log(${calls.join(' + ')});`);
      return parts.join('\n');
    }

    it('removes a flood that is wide and uniform enough', async () => {
      const source = flood(10, 3);
      const output = await expectSameBehaviour(source);
      expect(output).not.toContain('debugger');
    });

    it('keeps a file with too few debugger statements', async () => {
      const output = await expectSameBehaviour(flood(8, 2));
      expect(output).toContain('debugger');
    });

    it('keeps a flood that does not span enough functions', async () => {
      const output = await expectSameBehaviour(flood(7, 4));
      expect(output).toContain('debugger');
    });

    it('keeps a debugger a human parked mid-function even inside a flood', async () => {
      const source = flood(10, 3, 'human');
      const output = await expectSameBehaviour(source);
      // Exactly the one that is not in the mechanical position survives.
      expect(output.match(/debugger/g)).toHaveLength(1);
    });

    it('a lone hand-written debugger is never touched', async () => {
      const output = await expectSameBehaviour(`function f() { debugger; return 1; } log(f());`);
      expect(output).toContain('debugger');
    });
  });
});

// ===========================================================================
// 7. TypeScript and JSX through the whole pipeline
// ===========================================================================

describe('audit: TypeScript survives the full pipeline', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    [
      'overload signatures',
      `export function pick(x: string): string;
       export function pick(x: number): number;
       export function pick(x: any): any { return x; }
       const a = pick('q');`,
    ],
    [
      'enum and const enum',
      `enum Color { Red = 1, Green, Blue }
       const enum Dir { Up = 'U', Down = 'D' }
       function f(c: Color, d: Dir) { return String(c) + d; }
       console.log(f(Color.Green, Dir.Up));`,
    ],
    [
      'merged namespaces',
      `namespace NS { export const x = 1; export function f() { return x; } }
       namespace NS { export const y = 2; }
       console.log(NS.f(), NS.y);`,
    ],
    [
      'decorators and parameter properties',
      `function dec(target: any, key?: any): any { return target; }
       @dec
       class Foo {
         constructor(private readonly a: number, public b: string) {}
         @dec method(@dec p: number) { return this.a + p; }
       }
       console.log(new Foo(1, 'x').b);`,
    ],
    [
      'generics, conditional types and an abstract class',
      `type El<T> = T extends Array<infer U> ? U : never;
       abstract class Base<T extends { id: number }> {
         abstract get(id: number): T | undefined;
         protected items: T[] = [];
       }
       class Impl extends Base<{ id: number }> {
         get(id: number) { return this.items.find(i => i.id === id); }
       }
       const v: El<number[]> = 5;
       console.log(new Impl().get(1), v);`,
    ],
    [
      'declare module, import type and satisfies',
      `import type { Foo } from './foo';
       declare module 'bar' { export const z: number; }
       const cfg = { a: 1 } satisfies Record<string, number>;
       export type Alias = Foo;
       console.log(cfg.a);`,
    ],
    [
      'index signatures and declare fields',
      `interface Bag { [k: string]: number; readonly n?: number }
       class C implements Bag {
         [k: string]: number;
         declare n: number;
         static readonly S = 3;
       }
       console.log(C.S);`,
    ],
    ['generic arrow with a trailing comma', `const id = <T,>(x: T): T => x;\nconsole.log(id(1));`],
  ];

  for (const [name, source] of CASES) {
    it(name, async () => {
      const { code, metadata } = await deobfuscate(source, {
        preset: 'aggressive',
        filename: 'input.tsx',
        performance: { verifyOutput: true },
      });
      expect(metadata.stats.verified).toBe(true);
      expect(parseSource(code, { language: 'auto' }).recovered).toBe(false);
    });
  }
});

describe('audit: JSX survives the full pipeline', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    [
      'a component reached only through a runtime lookup',
      `function Widget(props) { return <div className="w">{props.n}</div>; }
       const registry = { Widget: Widget };
       function render(name, props) { const C = registry[name]; return <C {...props} />; }
       console.log(render('Widget', { n: 1 }));`,
    ],
    [
      'createElement with a fragment and a spread',
      `const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F' };
       const el = React.createElement(React.Fragment, null,
         React.createElement('div', { id: 'a', ...{ x: 1 } }, 'text'),
         React.createElement('span', null));
       console.log(JSON.stringify(el));`,
    ],
    [
      'member tags, namespaced attributes and entities',
      `const Ns = { Item: (p) => p };
       const e = <Ns.Item data-x="1" aria-label="a&amp;b">&nbsp;&#65;</Ns.Item>;
       console.log(e);`,
    ],
    [
      'conditional children and comments',
      `function C({ a }) {
         return (
           <ul>
             {/* comment */}
             {a ? <li key="1">yes</li> : null}
             {[1, 2].map((i) => <li key={i}>{i}</li>)}
           </ul>
         );
       }
       console.log(C({ a: true }));`,
    ],
  ];

  for (const [name, source] of CASES) {
    it(name, async () => {
      const { code, metadata } = await deobfuscate(source, {
        preset: 'aggressive',
        filename: 'input.jsx',
        performance: { verifyOutput: true },
      });
      expect(metadata.stats.verified).toBe(true);
      expect(parseSource(code, { language: 'auto' }).recovered).toBe(false);
    });
  }

  it('a createElement call the runtime cannot be proved for is left alone', async () => {
    // `React` here is a *local* binding of unknown origin, so rewriting to JSX
    // would change which value the tag names.
    const source = `const React = require('not-react');
      const el = React.createElement('div', null, 'x');
      console.log(el);`;
    const code = await deobfuscate(source, { preset: 'aggressive', filename: 'input.jsx' });
    expect(code.code).toContain('createElement');
  });
});

// ===========================================================================
// 8. Truncated runs
//
// A run that gives up must still emit code that parses, and must never claim
// `verified` for output that does not.
// ===========================================================================

const HEAVY3_FIXTURE = thirdPartyFixture('obfuscated3.js');

describe.skipIf(!HEAVY3_FIXTURE.present)('audit: a truncated run never lies about its output', () => {
  for (const timeBudgetMs of [1, 25, 200, 800]) {
    it(`a ${timeBudgetMs}ms budget yields parseable output`, async () => {
      const source = HEAVY3_FIXTURE.read();
      const { code, metadata } = await deobfuscate(source, {
        preset: 'aggressive',
        performance: { timeBudgetMs, verifyOutput: true },
      });
      const reparses = !parseSource(code, { language: 'auto' }).recovered;
      expect(reparses).toBe(true);
      // The claim and the fact must agree in both directions.
      expect(metadata.stats.verified).toBe(reparses);
    });
  }

  it('a signal aborted before the run is honoured and still emits valid code', async () => {
    const source = HEAVY3_FIXTURE.read();
    const controller = new AbortController();
    controller.abort();
    const { code, metadata } = await deobfuscate(source, {
      preset: 'aggressive',
      signal: controller.signal,
      performance: { verifyOutput: true },
    });
    expect(metadata.stats.truncated).toBe(true);
    expect(metadata.stats.verified).toBe(true);
    expect(parseSource(code, { language: 'auto' }).recovered).toBe(false);
  });

  for (const maxIterations of [0, 1, 2]) {
    it(`maxIterations=${maxIterations} yields parseable output`, async () => {
      const source = HEAVY3_FIXTURE.read();
      const { code, metadata } = await deobfuscate(source, {
        preset: 'aggressive',
        performance: { maxIterations, verifyOutput: true },
      });
      expect(metadata.stats.iterations).toBe(maxIterations);
      expect(metadata.stats.verified).toBe(true);
      expect(parseSource(code, { language: 'auto' }).recovered).toBe(false);
    });
  }
});
