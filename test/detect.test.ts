import * as t from '@babel/types';
import { beforeAll, describe, expect, it } from 'vitest';

import { detectObfuscation } from '../src/analysis/detect.js';
import { parseSource } from '../src/frontend/language.js';
import { detectPass } from '../src/passes/prepare/detect.js';
import { normalizeLiteralsPass } from '../src/passes/prepare/normalize-literals.js';
import type { Detection, DetectionKind, Language } from '../src/types.js';
import { expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const LIGHT_FIXTURE = thirdPartyFixture('lightly-obfuscated.js');
const HEAVY_FIXTURE = thirdPartyFixture('obfuscated2.js');

function detect(source: string, language: Language = 'auto'): Detection[] {
  return detectObfuscation(parseSource(source, { language }).ast);
}

function kinds(source: string, language: Language = 'auto'): DetectionKind[] {
  return detect(source, language).map((detection) => detection.kind);
}

function evidenceFor(source: string, kind: DetectionKind): string {
  const hit = detect(source).find((detection) => detection.kind === kind);
  if (!hit) throw new Error(`Expected a ${kind} detection.\n  got: ${kinds(source).join(', ') || '(none)'}`);
  return hit.evidence;
}

// ---------------------------------------------------------------------------
// Realistic samples, shaped after the ground truth in
// docs/analysis/transformation-catalog.md
// ---------------------------------------------------------------------------

const STRING_TABLE_THUNK = `
function _0x4a68() {
  var _0x384d51 = ['jQuery', 'setserver', 'gamemode', 'log', 'warn', 'addEventListener', 'length', 'push'];
  _0x4a68 = function () { return _0x384d51; };
  return _0x4a68();
}
`;

const DECODER = `
function _0x123b(_0x3a128d, _0x25525c) {
  _0x3a128d = _0x3a128d - 0x76;
  var _0x544ca0 = _0x4a68();
  return _0x544ca0[_0x3a128d];
}
`;

const PLAIN_TABLE = (() => {
  const entries = Array.from({ length: 30 }, (_unused, index) => `'entry${index}'`).join(', ');
  const reads = Array.from({ length: 20 }, (_unused, index) => `use(_0xdb56[${index}]);`).join('\n');
  return `var _0xdb56 = [${entries}];\n${reads}`;
})();

const ROTATION = `
(function (_0x6575cf, _0x29494) {
  var _0x420b3a = _0x6575cf();
  while (!![]) {
    try {
      var _0x50a6a4 = parseInt(_0x12ed(0x0)) / 0x1 + parseInt(_0x12ed(0x1)) / 0x2;
      if (_0x50a6a4 === _0x29494) { break; } else { _0x420b3a['push'](_0x420b3a['shift']()); }
    } catch (_0x22fc09) {
      _0x420b3a['push'](_0x420b3a['shift']());
    }
  }
}(_0x4a68, 0x6e0de));
`;

const RC4 = `
function _0x25f053(_0x2c82be, _0x568b7) {
  var _0x156492 = [], _0x1ae01d = 0x0, _0x3aed86, _0x5a1236 = '';
  for (var _0xe09179 = 0x0; _0xe09179 < 0x100; _0xe09179++) { _0x156492[_0xe09179] = _0xe09179; }
  for (_0xe09179 = 0x0; _0xe09179 < 0x100; _0xe09179++) {
    _0x1ae01d = (_0x1ae01d + _0x156492[_0xe09179] + _0x568b7['charCodeAt'](_0xe09179 % _0x568b7['length'])) % 0x100;
    _0x3aed86 = _0x156492[_0xe09179];
    _0x156492[_0xe09179] = _0x156492[_0x1ae01d];
    _0x156492[_0x1ae01d] = _0x3aed86;
  }
  for (var _0x2614c7 = 0x0; _0x2614c7 < _0x2c82be['length']; _0x2614c7++) {
    _0x5a1236 += String['fromCharCode'](_0x2c82be['charCodeAt'](_0x2614c7) ^ _0x156492[(_0x156492[0x1] + _0x156492[0x2]) % 0x100]);
  }
  return _0x5a1236;
}
`;

const FLATTENED = `
var _0x44f37d = '3|2|4|0|1'['split']('|');
var _0x48e990 = 0x0;
while (!![]) {
  switch (_0x44f37d[_0x48e990++]) {
    case '0': first(); continue;
    case '1': second(); continue;
    case '2': third(); continue;
    case '3': fourth(); continue;
  }
  break;
}
`;

describe('analysis/detect - string tables', () => {
  it('finds a self-replacing string-array thunk', () => {
    expect(kinds(STRING_TABLE_THUNK)).toContain('string-array');
    expect(evidenceFor(STRING_TABLE_THUNK, 'string-array')).toContain('8 entries');
  });

  it('finds a plain top-level table that is read at numeric indices', () => {
    expect(kinds(PLAIN_TABLE)).toContain('string-array');
  });

  it('does not call a short ordinary array a string table', () => {
    expect(kinds("var days = ['Mon', 'Tue', 'Wed']; use(days[0]); use(days[1]);")).not.toContain('string-array');
  });

  it('does not call a large array a table when nothing indexes it numerically', () => {
    const entries = Array.from({ length: 40 }, (_u, i) => `'word${i}'`).join(', ');
    expect(kinds(`var dictionary = [${entries}]; shuffle(dictionary);`)).not.toContain('string-array');
  });

  it('finds the rotation loop', () => {
    expect(kinds(ROTATION)).toContain('string-array-rotate');
    expect(evidenceFor(ROTATION, 'string-array-rotate')).toContain('parseInt checksum');
  });

  it('does not call a bounded queue rotation a string-array rotation', () => {
    const queue = 'while (queue.length > 0) { queue.push(queue.shift()); }';
    expect(kinds(queue)).not.toContain('string-array-rotate');
  });

  it('resolves decoder aliases and forwarding wrappers', () => {
    const source = `${STRING_TABLE_THUNK}${DECODER}
      var _0x273d8a = _0x123b, _0x10de82 = _0x123b;
      function _0x41251d(_0x55560c, _0x25d863, _0x1192e4) { return _0x123b(_0x1192e4 - -0xf4, _0x55560c); }
      log(_0x273d8a(0x80), _0x10de82(0x81), _0x41251d(0x1, 0x2, 0x3));`;
    expect(kinds(source)).toContain('string-array-wrapper');
    expect(detect(source).find((d) => d.kind === 'string-array-wrapper')?.count).toBe(3);
  });

  it('does not call ordinary aliasing a decoder wrapper', () => {
    expect(kinds('var a = helper, b = helper; a(); b();')).not.toContain('string-array-wrapper');
  });
});

describe('analysis/detect - string encodings', () => {
  it('finds the rotated base64 alphabet', () => {
    const source = "var _0x4a68a5 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';";
    expect(kinds(source)).toContain('string-encoding-base64');
    expect(evidenceFor(source, 'string-encoding-base64')).toContain('rotated');
  });

  it('does not mistake a long ordinary string for a base64 alphabet', () => {
    const source = `var banner = '${'-'.repeat(64)}';`;
    expect(kinds(source)).not.toContain('string-encoding-base64');
  });

  it('finds an RC4 key schedule beside its keystream XOR', () => {
    expect(kinds(RC4)).toContain('string-encoding-rc4');
  });

  it('does not call an ordinary byte-mixing hash RC4', () => {
    const hash = `
      function hash(text) {
        var acc = 0;
        for (var i = 0; i < text.length; i++) { acc = (acc * 31 + text.charCodeAt(i)) % 256; }
        return acc;
      }`;
    expect(kinds(hash)).not.toContain('string-encoding-rc4');
  });
});

describe('analysis/detect - structure', () => {
  it('finds a switch dispatcher over an incrementing cursor', () => {
    expect(kinds(FLATTENED)).toContain('control-flow-flattening');
    expect(evidenceFor(FLATTENED, 'control-flow-flattening')).toContain('order string');
  });

  it('does not call a real switch a dispatcher', () => {
    const real = `
      switch (event.type) {
        case 'click': onClick(); break;
        case 'keydown': onKey(); break;
        case 'focus': onFocus(); break;
      }`;
    expect(kinds(real)).not.toContain('control-flow-flattening');
  });

  it('finds constant-vs-constant injected predicates', () => {
    const injected = `
      if ('fgYDa' === 'pGlYu') { dead(); } else { real(); }
      if ('KIYLT' !== 'KIYLT') { dead(); } else { real(); }
      if (0x1 === 0x2) { dead(); } else { real(); }`;
    expect(kinds(injected)).toContain('dead-code-injection');
    expect(detect(injected).find((d) => d.kind === 'dead-code-injection')?.count).toBe(3);
  });

  it('does not flag a comparison against a variable', () => {
    expect(kinds("if (mode === 'debug') { a(); } else { b(); }")).not.toContain('dead-code-injection');
  });

  it('finds an object exploded by transformObjectKeys', () => {
    const exploded = `
      var _0x8c7ed9 = {};
      _0x8c7ed9['host'] = 'api.example.com';
      _0x8c7ed9['port'] = 0x1f90;
      var _0x28ebcd = _0x8c7ed9;
      send(_0x28ebcd);`;
    expect(kinds(exploded)).toContain('object-key-map');
  });

  it('does not flag an object that is merely built up and used', () => {
    const ordinary = `
      var options = {};
      options['host'] = host;
      options['port'] = port;
      connect(options);`;
    expect(kinds(ordinary)).not.toContain('object-key-map');
  });

  it('finds operator wrappers stored in a storage object', () => {
    const storage = `
      var _0x470975 = {
        'QrHIQ': function (_0xbc7360, _0x5ac301) { return _0xbc7360 < _0x5ac301; },
        'IdStr': function (_0x223cab, _0x1a1022) { return _0x223cab * _0x1a1022; },
        'SwUka': function (_0x5be7a0, _0x28af3e) { return _0x5be7a0 + _0x28af3e; },
        'SAjLR': function (_0x1de74a, _0x4b30) { return _0x1de74a(_0x4b30); }
      };`;
    expect(kinds(storage)).toContain('proxy-functions');
    expect(detect(storage).find((d) => d.kind === 'proxy-functions')?.count).toBe(4);
  });

  it('does not flag helpers that reorder or ignore their parameters', () => {
    const helpers = `
      var math = {
        'swap': function (a, b) { return b + a; },
        'square': function (a, b) { return a * a; }
      };`;
    expect(kinds(helpers)).not.toContain('proxy-functions');
  });

  it('finds all-numeric arithmetic trees', () => {
    const source = 'if (n > 0x2380 + 0x1 * -0x21b9 + -0x1bd) { go(0x866 + -0x4 * -0x1b + 0x1 * -0x8d2); }';
    expect(kinds(source)).toContain('numbers-to-expressions');
  });

  it('does not flag arithmetic that reads a variable', () => {
    expect(kinds('var n = base + 0x1 * 0x2 + 0x3;')).not.toContain('numbers-to-expressions');
  });

  it('finds split-string concatenation and recovers the chunk length', () => {
    const split = `
      var a = 'Hell' + 'o, W' + 'orld';
      var b = 'font' + 'Size';
      var c = 'lowe' + 'rCla' + 'ss';
      var d = 'bott' + 'om';`;
    expect(kinds(split)).toContain('split-strings');
    expect(evidenceFor(split, 'split-strings')).toContain('modal chunk length 4');
  });

  it('does not flag concatenation that crosses a variable', () => {
    expect(kinds("var s = 'Hello, ' + name + '!';")).not.toContain('split-strings');
  });
});

describe('analysis/detect - anti-tamper', () => {
  it('finds the Function constructor reached through a function literal', () => {
    const trap = "(function (_0x3a6fb4) {}['constructor']('debu' + 'gger')['apply']('stateObject'));";
    expect(kinds(trap)).toContain('debug-protection');
  });

  it('does not flag an ordinary IIFE invoked with call', () => {
    expect(kinds('(function () { return 1; }).call(this);')).not.toContain('debug-protection');
  });

  it('finds the self-defending backtracking guard', () => {
    const guard = `
      var _0x39f058 = function () {
        return _0x39f058['toString']()['search']('(((.+)+)+)+$')['toString']();
      };`;
    expect(kinds(guard)).toContain('self-defending');
  });

  it('finds a regex tested against a function source', () => {
    const guard = "var re = new RegExp(head + tail); var ok = re['test'](probe['toString']());";
    expect(kinds(guard)).toContain('self-defending');
  });

  it('does not flag ordinary toString formatting', () => {
    expect(kinds("var decimals = value.toString().indexOf('.');")).not.toContain('self-defending');
  });

  it('finds the console method table', () => {
    const source = "var methods = ['log', 'warn', 'info', 'error', 'exception', 'table', 'trace'];";
    expect(kinds(source)).toContain('console-disable');
    expect(evidenceFor(source, 'console-disable')).toContain('exception');
  });

  it('does not flag an unrelated string array of similar size', () => {
    expect(kinds("var levels = ['log', 'audit', 'metric', 'trace'];")).not.toContain('console-disable');
  });
});

describe('analysis/detect - lexical and packaging', () => {
  it('finds the hexadecimal identifier generator', () => {
    const source = `
      function _0x4a68(_0x123bcd) { var _0x27febf = _0x123bcd; return _0x27febf; }
      var _0x5ea468 = _0x4a68(1), _0x10de82 = 2, _0x273d8a = 3;`;
    expect(kinds(source)).toContain('hex-identifiers');
  });

  it('does not flag a file with a single hex-named binding', () => {
    const source = 'var _0xdb56 = []; var a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7;';
    expect(kinds(source)).not.toContain('hex-identifiers');
  });

  it('finds a file written in hex string escapes', () => {
    const source = String.raw`
      var a = '\x6c\x6f\x67', b = '\x77\x61\x72\x6e', c = '\x69\x6e\x66\x6f';
      var d = '\x65\x72\x72\x6f\x72', e = '\x74\x72\x61\x63\x65', f = '\x74\x61\x62\x6c\x65';`;
    expect(kinds(source)).toContain('unicode-escapes');
  });

  it('does not flag minimal escapes that a printer would emit anyway', () => {
    const source = String.raw`var a = 'line\n', b = 'tab\t', c = 'quote\'', d = 'back\\', e = 'cr\r', f = 'ff\f';`;
    expect(kinds(source)).not.toContain('unicode-escapes');
  });

  it('finds a webpack runtime', () => {
    const source = 'function m(module, exports, __webpack_require__) { __webpack_require__(1); }';
    expect(kinds(source)).toContain('webpack-bundle');
  });

  it('does not flag an ordinary CommonJS module', () => {
    expect(kinds("var fs = require('fs'); module.exports = fs;")).not.toContain('webpack-bundle');
  });

  it('finds the React automatic JSX runtime', () => {
    const source = "import { jsx as _jsx } from 'react/jsx-runtime';\nvar el = _jsx('div', { children: 'hi' });";
    expect(kinds(source)).toContain('jsx-runtime');
  });

  it('does not flag document.createElement', () => {
    expect(kinds("var node = document.createElement('div');")).not.toContain('jsx-runtime');
  });

  it('finds a Dean Edwards eval packer', () => {
    const packed = "eval(function (p, a, c, k, e, d) { while (c--) { p = p.replace(k[c], k[c]); } return p; }('0 1', 62, 2, 'alert|hi'.split('|'), 0, {}));";
    expect(kinds(packed)).toContain('eval-packer');
  });

  it('does not flag eval of a plain string', () => {
    expect(kinds("eval('1 + 1');")).not.toContain('eval-packer');
  });
});

describe('analysis/detect - reporting contract', () => {
  it('reports nothing for clean modern source', () => {
    const clean = `
      export function greet(name: string): string {
        const parts = [name.trim(), 'welcome'];
        return parts.join(', ');
      }`;
    expect(detect(clean, 'ts')).toEqual([]);
  });

  it('gives every detection a bounded confidence and a non-empty evidence string', () => {
    for (const detection of detect(`${STRING_TABLE_THUNK}${DECODER}${ROTATION}${RC4}${FLATTENED}`)) {
      expect(detection.confidence).toBeGreaterThan(0);
      expect(detection.confidence).toBeLessThanOrEqual(1);
      expect(detection.evidence.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const source = `${STRING_TABLE_THUNK}${DECODER}${ROTATION}`;
    expect(detect(source)).toEqual(detect(source));
  });

  it('handles an empty program', () => {
    expect(detect('')).toEqual([]);
  });

  // Built rather than parsed: @babel/parser itself gives up well before this
  // depth, but a `strings` pass that folds thousands of decoded chunks can build
  // a chain this deep, and a recursive detector would take the run down.
  it('survives a concatenation nested deeper than the call stack', () => {
    let chain: t.Expression = t.stringLiteral('chunk');
    for (let depth = 0; depth < 50_000; depth++) {
      chain = t.binaryExpression('+', chain, t.stringLiteral('chunk'));
    }
    const ast = t.file(t.program([t.expressionStatement(chain)]));
    expect(() => detectObfuscation(ast)).not.toThrow();
    expect(detectObfuscation(ast).map((d) => d.kind)).toContain('split-strings');
  });

  it('reports kinds in a stable canonical order', () => {
    const reported = kinds(`${STRING_TABLE_THUNK}${DECODER}${ROTATION}${RC4}${FLATTENED}`);
    expect(reported).toEqual([...reported].sort(byCanonicalOrder));
  });
});

const CANONICAL_ORDER: DetectionKind[] = [
  'string-array',
  'string-array-rotate',
  'string-array-wrapper',
  'string-encoding-base64',
  'string-encoding-rc4',
  'control-flow-flattening',
  'dead-code-injection',
  'debug-protection',
  'self-defending',
  'console-disable',
  'object-key-map',
  'proxy-functions',
  'numbers-to-expressions',
  'split-strings',
  'hex-identifiers',
  'unicode-escapes',
  'webpack-bundle',
  'jsx-runtime',
  'eval-packer',
];

function byCanonicalOrder(a: DetectionKind, b: DetectionKind): number {
  return CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b);
}

// ---------------------------------------------------------------------------
// The real fixtures. This is where a false positive shows up.
// ---------------------------------------------------------------------------

describe.skipIf(!LIGHT_FIXTURE.present)('analysis/detect - lightly-obfuscated.js', () => {
  let source: string;
  beforeAll(() => {
    source = LIGHT_FIXTURE.read();
  });

  it('recognises the plain string table and nothing more', () => {
    expect(kinds(source)).toEqual(['string-array']);
  });

  it('reports the real table size and read count', () => {
    const evidence = evidenceFor(source, 'string-array');
    expect(evidence).toContain('2239-entry');
    expect(evidence).toContain('10197 numeric index sites');
  });

  // The file genuinely has none of these. Claiming any of them would send later
  // passes hunting for machinery that is not there.
  it.each([
    'string-array-rotate',
    'string-array-wrapper',
    'string-encoding-base64',
    'string-encoding-rc4',
    'control-flow-flattening',
    'dead-code-injection',
    'debug-protection',
    'self-defending',
    'console-disable',
    'object-key-map',
    'proxy-functions',
    'numbers-to-expressions',
    'split-strings',
    'hex-identifiers',
    'unicode-escapes',
    'webpack-bundle',
    'jsx-runtime',
    'eval-packer',
  ] as DetectionKind[])('does not falsely report %s', (kind) => {
    expect(kinds(source)).not.toContain(kind);
  });
});

describe.skipIf(!HEAVY_FIXTURE.present)('analysis/detect - obfuscated2.js', () => {
  let source: string;
  beforeAll(() => {
    source = HEAVY_FIXTURE.read();
  });

  it.each([
    'string-array',
    'string-array-rotate',
    'string-array-wrapper',
    'string-encoding-base64',
    'string-encoding-rc4',
    'control-flow-flattening',
    'debug-protection',
    'self-defending',
    'object-key-map',
    'proxy-functions',
    'split-strings',
    'hex-identifiers',
    'unicode-escapes',
  ] as DetectionKind[])('reports %s', (kind) => {
    expect(kinds(source)).toContain(kind);
  });

  // Measured absent in the fixture inventory: 22 live console call sites survive,
  // there are no all-numeric arithmetic chains, and it is not a bundle.
  it.each([
    'numbers-to-expressions',
    'console-disable',
    'webpack-bundle',
    'jsx-runtime',
    'eval-packer',
  ] as DetectionKind[])('does not falsely report %s', (kind) => {
    expect(kinds(source)).not.toContain(kind);
  });

  it('recovers the splitStrings chunk length of 4', () => {
    expect(evidenceFor(source, 'split-strings')).toContain('modal chunk length 4');
  });

  it('resolves the full decoder alias closure', () => {
    const wrapper = detect(source).find((d) => d.kind === 'string-array-wrapper');
    expect(wrapper?.count).toBe(1695);
  });

  it('finds all eight control-flow dispatchers', () => {
    expect(detect(source).find((d) => d.kind === 'control-flow-flattening')?.count).toBe(8);
  });

  it('scans the 4 MB fixture fast enough for interactive use', () => {
    const ast = parseSource(source).ast;
    detectObfuscation(ast); // warm the JIT so the number reflects steady state
    const started = performance.now();
    detectObfuscation(ast);
    const elapsed = performance.now() - started;
    console.info(`detectObfuscation on obfuscated2.js (4.1 MB): ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// prepare.detect
// ---------------------------------------------------------------------------

describe('prepare.detect', () => {
  it('reports detections through the context without touching the tree', async () => {
    const source = `${STRING_TABLE_THUNK}${DECODER}${ROTATION}`;
    const result = await runPass(detectPass, source);
    expect(result.changes).toBe(0);
    expect(result.ctx.detections.map((d) => d.kind)).toContain('string-array-rotate');
  });

  it('leaves the source unchanged', async () => {
    await expectNoChange(detectPass, FLATTENED);
  });

  it('warns about guards that constrain later passes', async () => {
    const guard = "var f = function () { return f['toString']()['search']('(((.+)+)+)+$'); };";
    const result = await runPass(detectPass, guard);
    expect(result.ctx.diagnostics.some((d) => d.message.includes('self-defending'))).toBe(true);
  });

  it('notes when nothing is recognised', async () => {
    const result = await runPass(detectPass, 'export const total = items.reduce((a, b) => a + b, 0);');
    expect(result.ctx.diagnostics.some((d) => d.severity === 'info')).toBe(true);
  });

  // A packed file has no fingerprint until the package is open, so at
  // `conservative` - where `moduleUnwrapping` is off - it reports nothing at
  // all and the one action that would help goes unnamed.
  it('names the technique that would open a Function-constructor package', async () => {
    const packed = 'Function("a", "return a + 1;")(1);';
    const closed = await runPass(detectPass, packed, { preset: 'conservative' });
    expect(closed.ctx.diagnostics.some((d) => d.message.includes('moduleUnwrapping'))).toBe(true);

    const open = await runPass(detectPass, packed, { preset: 'balanced' });
    expect(open.ctx.diagnostics.some((d) => d.message.includes('moduleUnwrapping'))).toBe(false);
  });

  it('says nothing about packing when the source has no such wrapper', async () => {
    const result = await runPass(detectPass, 'var total = items.length;', {
      preset: 'conservative',
    });
    expect(result.ctx.diagnostics.some((d) => d.message.includes('moduleUnwrapping'))).toBe(false);
  });

  it('still reports unicode escapes after normalisation has stripped the raws', async () => {
    const source = String.raw`
      var a = '\x6c\x6f\x67', b = '\x77\x61\x72\x6e', c = '\x69\x6e\x66\x6f';
      var d = '\x65\x72\x72\x6f\x72', e = '\x74\x72\x61\x63\x65', f = '\x74\x61\x62\x6c\x65';`;
    const result = await runPass([detectPass, normalizeLiteralsPass], source);
    expect(result.ctx.detections.map((d) => d.kind)).toContain('unicode-escapes');
  });
});

// ---------------------------------------------------------------------------
// prepare.normalize-literals
// ---------------------------------------------------------------------------

describe('prepare.normalize-literals', () => {
  async function normalize(source: string, language?: Language): Promise<string> {
    return (await runPass(normalizeLiteralsPass, source, language ? { language } : {})).code;
  }

  it('re-emits hex-escaped strings as plain text', async () => {
    expectEquivalent(await normalize(String.raw`var s = '\x66\x6f\x6f';`), "var s = 'foo';");
  });

  it('re-emits unicode escapes as plain text', async () => {
    expectEquivalent(await normalize(String.raw`var s = '\u0066\u006f\u006f';`), "var s = 'foo';");
  });

  it('re-emits legacy octal escapes as plain text', async () => {
    expectEquivalent(await normalize(String.raw`var s = '\146\157\157';`), "var s = 'foo';");
  });

  it('leaves escapes a minimal printer would emit anyway', async () => {
    await expectNoChange(normalizeLiteralsPass, String.raw`var s = 'a\nb\tc\\d';`);
  });

  it('keeps a line-separator escape, which a minimal printer still emits', async () => {
    await expectNoChange(normalizeLiteralsPass, String.raw`var s = 'a\u2028b';`);
  });

  it('rewrites hex, octal and binary numbers as decimal', async () => {
    expectEquivalent(await normalize('var a = 0x1f, b = 0o17, c = 0b1010;'), 'var a = 31, b = 15, c = 10;');
  });

  it('drops numeric separators', async () => {
    expectEquivalent(await normalize('var n = 1_000_000;'), 'var n = 1000000;');
  });

  it('keeps a numeric form that decimal expansion would make longer', async () => {
    await expectNoChange(normalizeLiteralsPass, 'var a = 1e21, b = 1e3, c = .5;');
  });

  it('never changes a numeric value', async () => {
    const code = await normalize('var a = 0xdeadbeef, b = 0x7fffffff, c = 0.1, d = 1e-7, e = 0x1fffffffffffff;');
    for (const [source, expected] of [
      ['a', 0xdeadbeef],
      ['b', 0x7fffffff],
      ['c', 0.1],
      ['d', 1e-7],
      ['e', 0x1fffffffffffff],
    ] as Array<[string, number]>) {
      const match = new RegExp(`${source} = ([^,;]+)`).exec(code);
      expect(match, `${source} missing from ${code}`).not.toBeNull();
      expect(Number(match?.[1])).toBe(expected);
    }
  });

  it('leaves BigInt literals alone', async () => {
    await expectNoChange(normalizeLiteralsPass, 'var big = 0x1fn;');
  });

  it('canonicalises a directive without cooking its escapes', async () => {
    const code = await normalize("'use strict';\nvar a = 1;");
    expect(code).toContain('"use strict"');
  });

  it('preserves an escaped directive, which is not a directive at all', async () => {
    const code = await normalize(String.raw`'\x75se strict';` + '\nvar a = 1;');
    expect(code).toContain('\\x75se strict');
  });

  it('keeps use client and use server directives', async () => {
    for (const directive of ['use client', 'use server']) {
      const code = await normalize(`'${directive}';\nexport const x = 1;`);
      expect(code).toContain(`"${directive}"`);
    }
  });

  it('does not rewrite a JSX attribute, whose text is not escape-processed', async () => {
    await expectNoChange(normalizeLiteralsPass, 'var el = <a alt="a\\x41b" />;', { language: 'jsx' });
  });

  it('does not touch a literal in a TypeScript type position', async () => {
    const code = await normalize('type Mask = 0xff;\nconst mask: Mask = 0xff;', 'ts');
    expect(code).toContain('type Mask = 0xff');
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      normalizeLiteralsPass,
      String.raw`'use strict'; var s = '\x66\x6f\x6f', n = 0x1f, m = 1e21;`,
    );
  });

  it('leaves already-normal source alone', async () => {
    await expectNoChange(normalizeLiteralsPass, "var s = 'foo', n = 31, m = 1e21;");
  });

  it.skipIf(!HEAVY_FIXTURE.present)('normalises the whole heavy fixture without changing any value', async () => {
    const source = HEAVY_FIXTURE.read();
    const before = parseSource(source).ast;
    const result = await runPass(normalizeLiteralsPass, source);
    expect(result.changes).toBeGreaterThan(90_000);
    expect(literalDigest(before)).toEqual(literalDigest(parseSource(result.code).ast));
  }, 120_000);
});

/** Every string and number value in source order - the invariant this pass must hold. */
function literalDigest(ast: ReturnType<typeof parseSource>['ast']): string {
  const values: string[] = [];
  const stack: unknown[] = [ast.program];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as { type?: string; value?: unknown };
    if (node.type === 'StringLiteral') values.push(`s:${String(node.value)}`);
    if (node.type === 'NumericLiteral') values.push(`n:${String(node.value)}`);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments') continue;
      stack.push((node as unknown as Record<string, unknown>)[key]);
    }
  }
  return values.length + ':' + hash(values.join('|'));
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// The commercial-protector families. obfuscated3.js stacks four of them, so
// this is also where "report every mechanism, not just the loudest" is checked.
// ---------------------------------------------------------------------------

const HEAVY3_FIXTURE = thirdPartyFixture('obfuscated3.js');

/** `count` functions, each opening with an injected `debugger`. */
function flooded(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(`function work${i}(x) { debugger; return x; }`);
  return lines.join('\n');
}

describe('analysis/detect - commercial-protector anti-tamper', () => {
  it('finds a debugger flood by placement rather than volume', () => {
    const source = flooded(24);
    expect(kinds(source)).toContain('debug-protection');
    expect(evidenceFor(source, 'debug-protection')).toContain('injected at the head of');
  });

  it('reports a handful of hand-written breakpoints as exactly that', () => {
    const source = 'function audit(x) { debugger; return x; }';
    expect(evidenceFor(source, 'debug-protection')).toBe('1 debugger statement(s)');
  });

  it('does not call 24 mid-block breakpoints a flood', () => {
    const lines: string[] = [];
    for (let i = 0; i < 24; i++) lines.push(`function work${i}(x) { setup(x); debugger; return x; }`);
    expect(evidenceFor(lines.join('\n'), 'debug-protection')).toBe('24 debugger statement(s)');
  });

  it('finds a formatting-only pattern matched against a coerced function value', () => {
    const source = `(function () {
      var probe = function () {
        var re = new RegExp("\\n");
        if (re["test"](probe)) { for (;;) {} }
      };
      return probe();
    })();`;
    expect(kinds(source)).toContain('self-defending');
    expect(evidenceFor(source, 'self-defending')).toContain('formatting-only pattern');
  });

  it('does not treat a pattern that could match data as a formatting probe', () => {
    const source = 'var re = new RegExp("token"); var ok = re["test"](value);';
    expect(kinds(source)).not.toContain('self-defending');
  });

  it('finds a guard whose failure branch is a non-terminating empty loop', () => {
    const source = 'if (host !== "example.com") { while (true) {} }';
    expect(kinds(source)).toContain('self-defending');
    expect(evidenceFor(source, 'self-defending')).toContain('non-terminating empty loop');
  });

  it('names the location reads that make a hang guard a domain lock', () => {
    const source = `void function () {
      var host = location.hostname["toLowerCase"]();
      if (host !== "example.com") { for (;;) {} }
    }();`;
    expect(evidenceFor(source, 'self-defending')).toContain('location read');
  });

  it('does not flag a loop whose body does something', () => {
    expect(kinds('if (!ready) { while (true) { poll(); } }')).not.toContain('self-defending');
  });

  it('does not flag a guard whose failure branch is ordinary code', () => {
    expect(kinds('if (host !== "example.com") { redirect("/blocked"); }')).not.toContain('self-defending');
  });

  it('finds the source-integrity trampoline', () => {
    const source = `function shim(a, b) {
      var digest = impl.__k || (impl.__k = hash(impl, 4785466));
      if (digest === 1228482746886050) { return impl(a, b); } else { while (true) {} }
    }`;
    expect(kinds(source)).toContain('self-defending');
    expect(evidenceFor(source, 'self-defending')).toContain('checksumming');
  });

  it('does not flag a memoised value that is not a digest of the thing it guards', () => {
    const source = `function shim() {
      var cached = table.__k || (table.__k = compute(7));
      if (cached === 99) { return table(); }
      return null;
    }`;
    expect(kinds(source)).not.toContain('self-defending');
  });

  it('names every mechanism it found rather than only the loudest', () => {
    const source = `${flooded(24)}
      function shim(a) {
        var digest = impl.__k || (impl.__k = hash(impl, 7));
        if (digest === 99) { return impl(a); } else { while (true) {} }
      }
      void function () {
        var host = location.hostname;
        if (host !== "example.com") { for (;;) {} }
      }();`;
    const evidence = evidenceFor(source, 'self-defending');
    expect(evidence).toContain('checksumming');
    expect(evidence).toContain('non-terminating empty loop');
    expect(evidence).toContain('location read');
  });
});

describe.skipIf(!HEAVY3_FIXTURE.present)('analysis/detect - obfuscated3.js', () => {
  let source: string;
  beforeAll(() => {
    source = HEAVY3_FIXTURE.read();
  });

  it('reports the protector as more than "debug-protection"', () => {
    expect(kinds(source)).toContain('debug-protection');
    expect(kinds(source)).toContain('self-defending');
  });

  it('counts the debugger flood and calls it injected', () => {
    const evidence = evidenceFor(source, 'debug-protection');
    expect(evidence).toContain('448 debugger statement(s) injected at the head of');
  });

  it('names all four self-defending mechanisms', () => {
    const evidence = evidenceFor(source, 'self-defending');
    expect(evidence).toContain('formatting-only pattern');
    expect(evidence).toContain('80 stub(s) checksumming');
    expect(evidence).toContain('non-terminating empty loop');
    expect(evidence).toContain('location read');
  });

  // The file is a commercial protector, not obfuscator.io: claiming its
  // machinery would send the string and control-flow passes hunting for
  // transforms that are not there.
  it.each([
    'string-array-rotate',
    'string-array-wrapper',
    'string-encoding-base64',
    'string-encoding-rc4',
    'control-flow-flattening',
    'console-disable',
    'webpack-bundle',
    'jsx-runtime',
    'eval-packer',
  ] as DetectionKind[])('does not falsely report %s', (kind) => {
    expect(kinds(source)).not.toContain(kind);
  });
});
