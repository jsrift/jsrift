import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { packedSourceSite, unpackStringCode, type PackedRefusal, type PackedSource } from '../src/analysis/evaluator/packed-source.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * `eval(E)`, `(0, eval)(E)`, `Function(E)()` and `new Function(E)()` where
 * `E` is a computation over literals - a custom packer - are computed by the
 * interpreter over the slice of what `E` reads, and the text is the program,
 * when it parses. The pass that splices it in is `unpack`'s; what is proved
 * here is the computation, at every preset, and that a program with the
 * packed statement replaced by the computed text does what the packed one
 * does.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function execute(code: string, timeout = 5_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log, atob, btoa }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

interface Site {
  program: NodePath<t.Program>;
  site: NodePath<t.CallExpression | t.NewExpression>;
}

/** The program, and the first call that compiles a string. */
function packedSite(source: string): Site {
  const { ast } = parseSource(source);
  let program: NodePath<t.Program> | undefined;
  let site: NodePath<t.CallExpression | t.NewExpression> | undefined;
  traverse(ast, {
    Program(path) {
      program = path;
    },
    'CallExpression|NewExpression'(path) {
      if (site) return;
      if (packedSourceSite(path.node as t.CallExpression | t.NewExpression)) {
        site = path as NodePath<t.CallExpression | t.NewExpression>;
        path.stop();
      }
    },
  });
  if (!program || !site) throw new Error('no packed site');
  program.scope.crawl();
  return { program, site };
}

function unpack(source: string, preset: (typeof PRESETS)[number] = 'balanced'): PackedSource | PackedRefusal {
  const { program, site } = packedSite(source);
  return unpackStringCode(program, site, resolveConfig({ preset }));
}

/** The source with the packed statement replaced by the computed text, as the pass would splice it. */
function spliced(source: string, unpacked: PackedSource): string {
  const { site } = packedSite(source);
  const statement = site.getStatementParent()!;
  const [start, end] = [statement.node.start!, statement.node.end!];
  const body = unpacked.kind === 'program' ? unpacked.code : `(function (${unpacked.params.join(', ')}) {\n${unpacked.code}\n})();`;
  return source.slice(0, start) + body + source.slice(end);
}

// ---------------------------------------------------------------------------
// Packers
// ---------------------------------------------------------------------------

const PAYLOAD = `var greeting = 'hello';\nfunction shout(s) { return s.toUpperCase() + '!'; }\nlog(shout(greeting), 'ünï ✓');`;
const EXPECTED = '"HELLO!" "ünï ✓"';

/** The hunter.js packer: each char code written in a custom base, joined by a separator, with a table-driven base converter beside it. */
function hunterPack(text: string): string {
  // The call is (payload, 43, 'hMNxdbwFL', 26, 6, 56): each UTF-8 byte plus
  // 26, in base 6 over the alphabet's first six letters, tokens ended by the
  // seventh; the 43 and 56 are read by nothing.
  const base = 6;
  const alphabet = 'hMNxdbwFL';
  const separator = 'w';
  const offset = 26;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/'.split('');
  const encodeNumber = (n: number): string => {
    let out = '';
    do {
      out = digits[n % base]! + out;
      n = Math.floor(n / base);
    } while (n > 0);
    return out;
  };
  const bytes = unescape(encodeURIComponent(text));
  let packed = '';
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i) + offset;
    packed += [...encodeNumber(code)].map((d) => alphabet[parseInt(d, 10)] ?? d).join('') + separator;
  }
  return `var _0xc98e = ["", "split", "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/", "slice", "indexOf", "", "", ".", "pow", "reduce", "reverse", "0"];
function _0xe49c(d, e, f) {
	var g = _0xc98e[2][_0xc98e[1]](_0xc98e[0]);
	var h = g[_0xc98e[3]](0, e);
	var i = g[_0xc98e[3]](0, f);
	var j = d[_0xc98e[1]](_0xc98e[0])[_0xc98e[10]]()[_0xc98e[9]](function (a, b, c) {if (h[_0xc98e[4]](b) !== -1) return a += h[_0xc98e[4]](b) * (Math[_0xc98e[8]](e, c));}, 0);
	var k = _0xc98e[0];
	while (j > 0) {
		k = i[j % f] + k;
		j = (j - (j % f)) / f;
	}
	return k || _0xc98e[11];
}
eval(function (h, u, n, t, e, r) {
	r = "";
	for (var i = 0, len = h.length; i < len; i++) {
		var s = "";
		while (h[i] !== n[e]) {
			s += h[i];
			i++;
		}
		for (var j = 0; j < n.length; j++) s = s.replace(new RegExp(n[j], "g"), j);
		r += String.fromCharCode(_0xe49c(s, e, 10) - t);
	}
	return decodeURIComponent(escape(r));
}(${JSON.stringify(packed)}, 43, ${JSON.stringify(alphabet)}, ${offset}, ${base}, 56));`;
}

const xorPack = (text: string, key: string): string =>
  [...text].map((ch, i) => (ch.charCodeAt(0) ^ key.charCodeAt(i % key.length)).toString(16).padStart(4, '0')).join('');

const VARIANTS: { name: string; source: string; kind: 'program' | 'function' }[] = [
  { name: 'the hunter.js packer: a custom base over a table-driven converter', source: hunterPack(PAYLOAD), kind: 'program' },
  {
    name: 'a base-36 conversion of char codes',
    source: `eval(function (p) { return p.split('|').map(function (c) { return String.fromCharCode(parseInt(c, 36)); }).join(''); }(${JSON.stringify([...PAYLOAD].map((ch) => ch.charCodeAt(0).toString(36)).join('|'))}));`,
    kind: 'program',
  },
  {
    name: 'an xor over a repeating key',
    source: `eval(function (p, k) { var out = ''; for (var i = 0; i < p.length; i += 4) out += String.fromCharCode(parseInt(p.substr(i, 4), 16) ^ k.charCodeAt((i / 4) % k.length)); return out; }(${JSON.stringify(xorPack(PAYLOAD, 'k3y!'))}, 'k3y!'));`,
    kind: 'program',
  },
  {
    name: 'char-code arithmetic with a rotating offset',
    source: `eval(function (p) { var out = ''; for (var i = 0; i < p.length; i++) out += String.fromCharCode(p.charCodeAt(i) - (i % 7) - 1); return out; }(${JSON.stringify([...PAYLOAD].map((ch, i) => String.fromCharCode(ch.charCodeAt(0) + (i % 7) + 1)).join(''))}));`,
    kind: 'program',
  },
  {
    name: 'base64 through atob, then percent-decoded',
    source: `eval(decodeURIComponent(escape(atob(${JSON.stringify(Buffer.from(PAYLOAD, 'utf8').toString('base64'))}))));`,
    kind: 'program',
  },
  {
    name: 'an indirect eval of a reversed text',
    source: `(0, eval)(${JSON.stringify([...PAYLOAD].reverse().join(''))}.split('').reverse().join(''));`,
    kind: 'program',
  },
  {
    name: 'a Function body called at once',
    source: `Function(${JSON.stringify(PAYLOAD.split('').map((c) => c.charCodeAt(0)).join(','))}.split(',').map(function (n) { return String.fromCharCode(+n); }).join(''))();`,
    kind: 'function',
  },
  {
    name: 'a new Function with a parameter, called at once',
    source: `new Function('unused', ${JSON.stringify(PAYLOAD)}.replace(/\\u0000/g, ''))();`,
    kind: 'function',
  },
  {
    name: 'a two-stage pack: the outer stage reveals an inner eval',
    source: `eval(${JSON.stringify(`eval(${JSON.stringify([...PAYLOAD].reverse().join(''))}.split('').reverse().join(''));`.split('').reverse().join(''))}.split('').reverse().join(''));`,
    kind: 'program',
  },
  {
    name: 'a table the packer reads beside a helper it calls, declared after it',
    source: `var KEY = 'ab';\neval(unmask(${JSON.stringify(xorPack(PAYLOAD, 'ab'))}));\nfunction unmask(p) { var out = ''; for (var i = 0; i < p.length; i += 4) out += String.fromCharCode(parseInt(p.substr(i, 4), 16) ^ KEY.charCodeAt((i / 4) % KEY.length)); return out; }`,
    kind: 'program',
  },
];

describe('a program hidden behind computable string code', () => {
  for (const variant of VARIANTS) {
    it(`is computed by the interpreter at every preset, and parses: ${variant.name}`, () => {
      const expected = execute(variant.source);
      expect(expected).toBe(EXPECTED);
      for (const preset of PRESETS) {
        const unpacked = unpack(variant.source, preset);
        expect('code' in unpacked, `${preset}: ${'refused' in unpacked ? unpacked.refused : ''}`).toBe(true);
        const result = unpacked as PackedSource;
        expect(result.kind).toBe(variant.kind);
        expect(result.steps).toBeGreaterThan(0);
        // The text is the program, and spliced where the packer stood it does what the packer did.
        if (!variant.name.startsWith('a two-stage')) expect(result.code).toContain('shout');
        expect(execute(spliced(variant.source, result)), preset).toBe(expected);
      }
    });
  }

  it('reveals the inner stage of a two-stage pack for the next round to open', () => {
    const unpacked = unpack(VARIANTS[8]!.source) as PackedSource;
    expect(unpacked.code).toMatch(/^eval\(/);
    const inner = unpack(unpacked.code) as PackedSource;
    expect(inner.code).toBe(PAYLOAD);
  });

  it('refuses a text that does not parse, saying so', () => {
    const source = `eval(${JSON.stringify('var = ;')}.split('').reverse().join('').split('').reverse().join(''));`;
    for (const preset of PRESETS) {
      const unpacked = unpack(source, preset);
      expect('refused' in unpacked && unpacked.refused, preset).toMatch(/does not parse as a program/);
    }
    const body = `Function('return ' + ')(')();`;
    expect('refused' in unpack(body) && (unpack(body) as PackedRefusal).refused).toMatch(/does not parse as a function body/);
  });

  it('refuses a source over anything but literals and builtins, a trap, a budget, and a string it cannot compute', () => {
    const refusals: [string, RegExp][] = [
      [`eval(document.title);`, /reads document/],
      [`eval(String(Math.random()));`, /refused or threw/],
      [`var k = prompt(); eval(k + '1');`, /outside the evaluation allowlist|refused or threw|reads prompt|changes k/],
      [`eval(function () { while (true) {} }());`, /ran out of budget/],
      [`eval(function (n) { return n; }(1));`, /computes number, not a string/],
      [`eval(function (s) { return Function('return ' + s)(); }('1'));`, /compiles a further string itself/],
      [`var T = ['log(1)']; T.reverse(); eval(T[0]);`, /changes|refused|reverse/],
    ];
    for (const [source, reason] of refusals) {
      const unpacked = unpack(source);
      expect('refused' in unpacked, source).toBe(true);
      expect((unpacked as PackedRefusal).refused, source).toMatch(reason);
    }
  });

  it('says whether the text is a program, an expression, or both, for the position the eval sits in', () => {
    // The text is read as `eval` reads it, a script: `function () {...}` is a
    // syntax error there, not the expression its parenthesised form is.
    const anonymous = unpack("log(eval(['function () {', 'return 1;', '}'].join('')) ());");
    expect('refused' in anonymous && anonymous.refused).toMatch(/does not parse as a program/);
    const unbalanced = unpack("log(eval(['1)', '(2'].join(' + ')));");
    expect('refused' in unbalanced && unbalanced.refused).toMatch(/does not parse as a program/);
    // A block, a declaration, and a lone string: `{a: 1}` and `function f() {}`
    // are statements whose value is not the parenthesised one; `'abc'` is one
    // expression even where the parser files it as a directive.
    const block = unpack("var v = eval(['{a:', '1}'].join(' '));") as PackedSource;
    expect(block.program).toBe(true);
    expect(block.expression).toBe(false);
    const declaration = unpack("var f = eval(['function f() {', '}'].join(''));") as PackedSource;
    expect(declaration.program).toBe(true);
    expect(declaration.expression).toBe(false);
    const lone = unpack("var s = eval([\"'ab\", \"c'\"].join(''));") as PackedSource;
    expect(lone.program).toBe(true);
    expect(lone.expression).toBe(true);
    const asProgram = unpack("eval(['var x = 1;', 'log(x);'].join(''));") as PackedSource;
    expect(asProgram.program).toBe(true);
    expect(asProgram.expression).toBe(false);
    const both = unpack("var v = eval(['1', '+ 1'].join(' '));") as PackedSource;
    expect(both.program).toBe(true);
    expect(both.expression).toBe(true);
    const body = unpack("Function('return 1')();") as PackedSource;
    expect(body.program).toBe(true);
    expect(body.expression).toBe(false);
  });

  it('names the shapes it opens, and no other', () => {
    const shapes: [string, 'program' | 'function' | undefined][] = [
      ["eval('1');", 'program'],
      ["(0, eval)('1');", 'program'],
      ["globalThis.eval('1');", 'program'],
      ["window.eval('1');", 'program'],
      ["Function('return 1')();", 'function'],
      ["new Function('return 1')();", 'function'],
      ["Function('a', 'return a')();", 'function'],
      ["Function('return 1');", undefined],
      ["eval('1', 2);", undefined],
      ["setTimeout('1');", undefined],
      ["o.eval('1');", undefined],
    ];
    for (const [source, kind] of shapes) {
      const { ast } = parseSource(source);
      const statement = ast.program.body[0]!;
      const expression = (statement as t.ExpressionStatement).expression as t.CallExpression;
      expect(packedSourceSite(expression)?.kind, source).toBe(kind);
    }
  });
});
