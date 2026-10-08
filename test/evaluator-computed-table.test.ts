import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { obfuscate } from 'javascript-obfuscator';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import { recogniseStringArray } from '../src/analysis/evaluator/native.js';
import { findStringSourceCandidates } from '../src/analysis/string-array.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A string table computed at load by a pure function of literals - `var T =
 * (function (c, q) { ... })('...', 6120338)`, read as `T[0]` everywhere - is the
 * table of several older tools. The interpreter runs the computation to
 * completion and its result is the table, at every preset.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function execute(code: string, timeout = 5_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(' '));
  };
  const timers: (() => void)[] = [];
  const queue = (fn: () => void): number => timers.push(fn);
  try {
    vm.runInNewContext(code, vm.createContext({ log, setTimeout: queue, setInterval: queue, clearInterval: () => undefined, clearTimeout: () => undefined }), { timeout });
    for (let drained = 0; timers.length > 0 && drained < 32; drained++) timers.shift()!();
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

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
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], preset: (typeof PRESETS)[number]) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig({ preset }), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
}

// ---------------------------------------------------------------------------
// The shufflers, generated with their inverse
// ---------------------------------------------------------------------------

const WORDS = ['checkClassName', '874221', 'shippingContainer', '#billing\\:email', 'location', 'test', 'ünï ✓', 'onepage|checkout'];

/** The udu.js shuffler: swap by a seeded walk, then join and split around three markers. */
function uduShuffle(words: readonly string[], seed: number): { literal: string; seed: number } {
  // The inverse is the shuffle run backwards: the swaps are self-inverse in reverse order.
  const joined = words.map((word) => word.replace(/%/g, '#0').replace(/\x7f/g, '#1')).join('\x7f').replace(/\x7f/g, '%');
  const chars = [...joined];
  const length = chars.length;
  const swaps: [number, number][] = [];
  let q = seed;
  for (let p = 0; p < length; p++) {
    const a = q * (p + 333) + (q % 43485);
    const j = q * (p + 309) + (q % 14071);
    swaps.push([a % length, j % length]);
    q = (a + j) % 6120338;
  }
  for (let i = swaps.length - 1; i >= 0; i--) {
    const [n, m] = swaps[i]!;
    [chars[n], chars[m]] = [chars[m]!, chars[n]!];
  }
  return { literal: chars.join(''), seed };
}

const UDU_BODY = `
    var l=c.length;var k=[];
    for(var p=0;p< l;p++){k[p]= c.charAt(p)};
    for(var p=0;p< l;p++){var a=q* (p+ 333)+ (q% 43485);var j=q* (p+ 309)+ (q% 14071);var n=a% l;var m=j% l;var f=k[n];k[n]= k[m];k[m]= f;q= (a+ j)% 6120338};
    var g=String.fromCharCode(127);var d='';var i='\\x25';var e='\\x23\\x31';var o='\\x25';var b='\\x23\\x30';var h='\\x23';
    return k.join(d).split(i).join(g).split(e).join(o).split(b).join(h).split(g)`;

const uses = (table: string, count: number): string => `log(${Array.from({ length: count }, (_, i) => `${table}[${i}]`).join(', ')});`;

interface Variant {
  name: string;
  source: string;
  table: string;
  words: readonly string[];
}

const udu = uduShuffle(WORDS, 4045901);
const VARIANTS: Variant[] = [
  {
    name: 'the udu.js shuffler: swaps by a seeded walk, then join and split around markers',
    source: `var _$_2b1a=(function(c,q){${UDU_BODY}})(${JSON.stringify(udu.literal)},${udu.seed});\n` + uses('_$_2b1a', WORDS.length),
    table: '_$_2b1a',
    words: WORDS,
  },
  {
    name: 'the same shuffler as a function declaration called beside the table',
    source: `function Ox$(c,q){${UDU_BODY}}\nvar T = Ox$(${JSON.stringify(udu.literal)}, ${udu.seed});\n` + uses('T', WORDS.length),
    table: 'T',
    words: WORDS,
  },
  {
    name: 'a split returning the table',
    source: `var T = (function (s) { return s.split('/'); })(${JSON.stringify(WORDS.join('/'))});\n` + uses('T', WORDS.length),
    table: 'T',
    words: WORDS,
  },
  {
    name: 'Array.from over a split, mapped',
    source: `var T = (function (s) { return Array.from(s.split(',')).map(function (x) { return x.toUpperCase(); }); })('alpha,beta,gamma');\n` + uses('T', 3),
    table: 'T',
    words: ['ALPHA', 'BETA', 'GAMMA'],
  },
  {
    name: 'a spread of a split, reversed',
    source: `var T = (function (s) { return [...s.split(':')].reverse(); })('one:two:three');\n` + uses('T', 3),
    table: 'T',
    words: ['three', 'two', 'one'],
  },
  {
    name: 'an xor over char codes, then a split',
    source: `var T = (function (c, k) { var out = ''; for (var i = 0; i < c.length; i++) out += String.fromCharCode(c.charCodeAt(i) ^ k); return out.split(','); })(${JSON.stringify([...'red,green,blue'].map((ch) => String.fromCharCode(ch.charCodeAt(0) ^ 7)).join(''))}, 7);\n` + uses('T', 3),
    table: 'T',
    words: ['red', 'green', 'blue'],
  },
  {
    name: 'an arrow function over a template literal',
    source: 'var T = ((s) => s.split(";").map((w) => w.trim()))(`a ; b ;c`);\n' + uses('T', 3),
    table: 'T',
    words: ['a', 'b', 'c'],
  },
  {
    name: 'a seeded Fisher-Yates permutation undone with modular arithmetic',
    source: (() => {
      const words = ['first', 'second', 'third', 'fourth', 'fifth'];
      // Forward: swap i with (seed * (i + 1)) % length, i descending; the literal is the shuffled order.
      const order = [...words];
      const seed = 97;
      for (let i = order.length - 1; i > 0; i--) {
        const j = (seed * (i + 1)) % (i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      return (
        `var T = (function (s, seed) { var a = s.split('/'); for (var i = 1; i < a.length; i++) { var j = (seed * (i + 1)) % (i + 1); var x = a[i]; a[i] = a[j]; a[j] = x; } return a; })(${JSON.stringify(order.join('/'))}, ${seed});\n` +
        uses('T', words.length)
      );
    })(),
    table: 'T',
    words: ['first', 'second', 'third', 'fourth', 'fifth'],
  },
  {
    name: 'a base-36 packed table decoded with parseInt and fromCharCode',
    source: (() => {
      const words = ['pack', 'un', 'pack✓'];
      const packed = words.map((word) => [...word].map((ch) => ch.charCodeAt(0).toString(36)).join('-')).join('_');
      return (
        `var T = (function (p) { return p.split('_').map(function (w) { return w.split('-').map(function (c) { return String.fromCharCode(parseInt(c, 36)); }).join(''); }); })(${JSON.stringify(packed)});\n` +
        uses('T', words.length)
      );
    })(),
    table: 'T',
    words: ['pack', 'un', 'pack✓'],
  },
  {
    name: 'a table under a rotation of its own making',
    source: `var T = (function (s, n) { var a = s.split(','); while (n--) a.push(a.shift()); return a; })('c,d,a,b', 2);\n` + uses('T', 4),
    table: 'T',
    words: ['a', 'b', 'c', 'd'],
  },
];

describe('a string table computed at load', () => {
  for (const variant of VARIANTS) {
    it(`is read by the interpreter and inlined at every preset: ${variant.name}`, async () => {
      const expected = execute(variant.source);
      expect(expected).toBe(variant.words.map((word) => JSON.stringify(word)).join(' '));

      const program = programPath(variant.source);
      const recognised = recogniseStringArray(program.node.body).find((array) => array.name === variant.table);
      expect(recognised?.values, 'the recogniser reads the computed table').toEqual([...variant.words]);
      // The candidate the scan proposes, its scope declared to the slicer as the pipeline declares it.
      const candidate = findStringSourceCandidates(program).find((each) => each.kind === 'array-index' && each.arrayName === variant.table);
      expect(candidate).toBeDefined();

      for (const preset of PRESETS) {
        const { decoder, notes } = build(variant.source, candidate!.roots, preset);
        expect(decoder, `${preset}: ${notes.map((n) => n.message).join('\n')}`).toBeDefined();
        expect(decoder!.kind).toBe('array-index');
        expect(notes.filter((n) => n.severity !== 'info')).toEqual([]);

        const result = await deobfuscate(variant.source, { preset });
        expect(execute(result.code), preset).toBe(expected);
        expect(result.code, preset).not.toMatch(new RegExp(`${variant.table.replace(/[$]/g, '\\$')}\\[`));
        for (const word of variant.words) if (!word.includes('\\')) expect(result.code, preset).toContain(word);
      }
    });
  }

  it('peels a table under a second obfuscator.io layer', async () => {
    const source = VARIANTS[2]!.source;
    const expected = execute(source);
    const layered = obfuscate(source, { stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64'], seed: 20260920 }).getObfuscatedCode();
    expect(execute(layered)).toBe(expected);
    for (const preset of ['balanced', 'aggressive'] as const) {
      const result = await deobfuscate(layered, { preset, performance: { maxIterations: 12 } });
      expect(execute(result.code), preset).toBe(expected);
      expect(result.code, preset).not.toMatch(/\bT\[|_0x[0-9a-f]+\(/);
      for (const word of WORDS.slice(0, 3)) expect(result.code).toContain(word);
    }
  });

  it('reads no table from a computation over a name that is not a builtin, or that is not all strings', () => {
    for (const source of [
      "var T = (function (s) { return s.split(config.sep); })('a,b');",
      "var T = (function (s) { return [s, 1]; })('a');",
      "var T = (function (s) { return s; })('a,b');",
      "var T = (function (s) { return s.split(',').map(Number); })('1,2');",
      "var T = (function (s) { while (true) {} })('a');",
      "var T = (function (s) { throw new Error(s); })('a');",
      "var T = (function (s) { return Function('return this')().leak.split(','); })('a');",
    ]) {
      expect(recogniseStringArray(programPath(source).node.body), source).toEqual([]);
    }
    // A shadowed builtin is the program's own binding, run as such: `split` here is not String.prototype's.
    const shadowed = "var T = (function (s) { var String = { fromCharCode: function () { return 'x'; } }; return [String.fromCharCode(1), s]; })('y');";
    expect(recogniseStringArray(programPath(shadowed).node.body)[0]?.values).toEqual(['x', 'y']);
  });

  it('refuses a table that a later statement rewrites', async () => {
    const source = "var T = (function (s) { return s.split(','); })('a,b'); T[0] = 'z'; log(T[0], T[1]);";
    for (const preset of PRESETS) {
      const result = await deobfuscate(source, { preset });
      expect(execute(result.code)).toBe(execute(source));
      // The table stays a computation and the reads stay reads: nothing was inlined.
      expect(result.code).toMatch(/\.split\(/);
      expect(result.code).not.toMatch(/log\('[az]', 'b'\)/);
    }
  });
});
