import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/frontend/language.js';
import { inferNames } from '../src/naming/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import { detectNameScheme, isObfuscatedName, isReadableName } from '../src/util/ast.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Every reference identifier's source offset mapped to the source offset of the
 * declaration it resolves to. Renaming only mutates `.name`, so offsets are
 * stable and the two maps must be identical before and after the pass. That is
 * a mechanical proof that no rename captured or shadowed a binding.
 */
function resolutionMap(ast: t.File): Map<number, number> {
  const map = new Map<number, number>();
  traverse(ast, {
    Scopable(path) {
      if (path.scope.path !== path) return;
      for (const name of Object.keys(path.scope.bindings)) {
        const binding = path.scope.bindings[name]!;
        const declared = binding.identifier.start;
        if (declared == null) continue;
        for (const reference of [...binding.referencePaths, ...binding.constantViolations]) {
          const start = reference.node.start;
          if (start != null) map.set(start, declared);
        }
      }
    },
  });
  return map;
}

function programPathOf(ast: t.File) {
  let program: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program as unknown as NodePath<t.Program>;
}

async function expectBindingsPreserved(source: string, options: DeobfuscateOptions) {
  const before = resolutionMap(parseSource(source, { language: options.language }).ast);
  const { ctx, code } = await runPass(pass, source, options);
  const after = resolutionMap(ctx.ast);
  let broken = 0;
  for (const [reference, declaration] of before) {
    if (after.get(reference) !== declaration) broken++;
  }
  expect({ broken, size: after.size }).toEqual({ broken: 0, size: before.size });
  return { ctx, code };
}

const balanced: DeobfuscateOptions = { preset: 'balanced' };

async function rename(source: string, options: DeobfuscateOptions = balanced) {
  const result = await runPass(pass, source, options);
  assertParses(result.code, options.language ?? 'auto');
  return result;
}

/** Names actually produced, so a test can assert on the decision not the layout. */
async function renamesOf(source: string, options: DeobfuscateOptions = balanced) {
  const { ctx } = await rename(source, options);
  return ctx.renames.map((entry) => `${entry.from}->${entry.to}`);
}

describe('rename.identifiers - evidence classes', () => {
  it('A01: names a getElementById result after its element id', async () => {
    const { code } = await rename(`(function () {
      var a = document.getElementById('minimap');
      a.width = 10;
    })();`);
    expect(code).toContain('minimapEl');
    expect(code).not.toContain('var a =');
  });

  it('A05 + propagation: a getContext result is named from its receiver', async () => {
    const { code } = await rename(`(function () {
      var a = document.getElementById('minimap');
      var b = a.getContext('2d');
      b.fillRect(0, 0, 1, 1);
    })();`);
    expect(code).toContain('minimapEl');
    expect(code).toContain('minimapCtx');
  });

  it('A08: a constructor alias names the instance', async () => {
    const { code } = await rename(`(function () {
      var a = new WebSocket('wss://example.test/x');
      a.send(1);
    })();`);
    expect(code).toContain('var socket = new WebSocket');
  });

  it('B02: duck typing recognises a 2d context from its method calls', async () => {
    const { code } = await rename(`(function () {
      function draw(c) {
        c.beginPath();
        c.fillRect(0, 0, 1, 1);
      }
      draw(null);
    })();`);
    expect(code).toContain('function draw(ctx)');
    expect(code).toContain('ctx.beginPath()');
  });

  it('C12/C13: iterator callback parameters take conventional names', async () => {
    const { code } = await rename(`(function () {
      var users = [1, 2, 3];
      users.map(function (a, b) {
        return a + b;
      });
    })();`);
    expect(code).toContain('function (user, index)');
  });

  it('F08: a catch parameter becomes error', async () => {
    const { code } = await rename(`(function () {
      try {
        boom();
      } catch (q) {
        report(q);
      }
    })();`);
    expect(code).toContain('catch (error)');
    expect(code).toContain('report(error)');
  });

  it('F01: a pure loop counter becomes i', async () => {
    const { code } = await rename(`(function () {
      for (var q = 0; q < 10; q++) {
        sink(q);
      }
    })();`);
    expect(code).toContain('for (let i = 0; i < 10; i++)'.replace('let', 'var'));
  });

  it('E07: a two-parameter operator function is named after its operator', async () => {
    const { code } = await rename(`(function () {
      var q = function (a, b) {
        return a - b;
      };
      use(q(1, 2));
    })();`);
    expect(code).toContain('var subtract =');
    expect(code).toContain('subtract(1, 2)');
  });

  it('D02: a renamed destructuring key names the binding', async () => {
    const { code } = await rename(`(function (source) {
      var { displayName: q } = source;
      use(q);
    })({});`);
    expect(code).toContain('displayName: displayName');
    expect(code).not.toContain('q');
  });

  it('G07/C04: known call results get their conventional names', async () => {
    const { code } = await rename(`(function () {
      var q = Date.now();
      var z = setTimeout(tick, 10);
      use(q, z);
    })();`);
    expect(code).toContain('var timestamp = Date.now()');
    expect(code).toContain('var timeoutId = setTimeout');
  });

  it('I01/I05: obfuscator machinery is recognised by shape', async () => {
    const { code } = await rename(`(function () {
      function q() {
        return ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii'];
      }
      function z(w, v) {
        return q()[w - 0x10] + v;
      }
      use(z(16, 1), z(17, 2), z(18, 3));
    })();`);
    expect(code).toContain('function getStringArray()');
    expect(code).toContain('function decodeString(');
  });

  it('H01: a JSX component keeps PascalCase', async () => {
    const { code } = await rename(
      `const Zz = () => <div />;
       render(<Zz />);`,
      { ...balanced, language: 'jsx' },
    );
    expect(code).toContain('<Component />');
    expect(code).toMatch(/const Component = \(\) =>/);
  });

  it('H16: a TypeScript type annotation names the parameter', async () => {
    const { code } = await rename(
      `(function () {
         function show(q: Invoice) {
           return q.total;
         }
         show(null as any);
       })();`,
      { ...balanced, language: 'ts' },
    );
    expect(code).toContain('function show(invoice: Invoice)');
  });
});

describe('rename.identifiers - safety', () => {
  it('never renames a binding published on a global object', async () => {
    const source = `!function (d) {
      var q = function () {
        return document.getElementById('menu');
      };
      d.setResponsiveMenu = q;
    }(window);`;
    const { code, ctx } = await rename(source);
    expect(code).toContain('d.setResponsiveMenu = q');
    expect(ctx.renames.map((r) => r.from)).not.toContain('q');
  });

  it('never renames a binding whose name appears as a string literal', async () => {
    const { code } = await rename(`(function () {
      var q = document.getElementById('minimap');
      track('q');
      use(q);
    })();`);
    expect(code).toContain('var q = document.getElementById');
  });

  it('never renames an exported binding', async () => {
    const source = `const q = new WebSocket('wss://example.test/x');
      q.send(1);
      export { q };`;
    await expectNoChange(pass, source, balanced);
  });

  it('suffixes rather than shadowing an outer binding of the same name', async () => {
    const { code } = await rename(`(function () {
      var error = 'outer';
      try {
        boom();
      } catch (q) {
        report(q, error);
      }
    })();`);
    expect(code).toContain('catch (error2)');
    expect(code).toContain('report(error2, error)');
  });

  it('suffixes rather than letting a nested binding capture a reference', async () => {
    const { code } = await rename(`(function () {
      var q = document.getElementById('minimap');
      function inner() {
        var minimapEl = 2;
        return [q, minimapEl];
      }
      return inner;
    })();`);
    expect(code).toContain('minimapEl2');
    expect(code).toContain('var minimapEl = 2');
  });

  it('renames nothing inside a scope reachable by direct eval', async () => {
    const source = `(function () {
      var q = document.getElementById('minimap');
      return eval('q.width');
    })();`;
    await expectNoChange(pass, source, balanced);
    const { ctx } = await rename(source);
    expect(ctx.diagnostics.some((d) => d.message.includes('direct eval'))).toBe(true);
  });

  it('leaves object property keys alone unless renameProperties is on', async () => {
    const source = `(function () {
      var m = {
        qq: function (a, b) {
          return a - b;
        }
      };
      return m.qq(1, 2);
    })();`;
    const off = await rename(source);
    expect(off.code).toContain('m.qq(1, 2)'.replace('m.', ''));
    expect(off.code).toContain('qq');

    const on = await rename(source, {
      preset: 'balanced',
      techniques: { variableRenaming: { renameProperties: true } },
    });
    expect(on.code).toContain('subtract: function');
    expect(on.code).toMatch(/\.subtract\(1, 2\)/);
  });

  it('declines a rename when the object escapes the analysis', async () => {
    const source = `(function () {
      var m = {
        qq: function (a, b) {
          return a - b;
        }
      };
      send(m);
      return m.qq(1, 2);
    })();`;
    const { code } = await rename(source, {
      preset: 'balanced',
      techniques: { variableRenaming: { renameProperties: true } },
    });
    expect(code).toContain('qq:');
  });

  it('does not rename readable names by default and does under aggressive', async () => {
    const source = `(function () {
      var container = new WebSocket('wss://example.test/x');
      container.send(1);
    })();`;
    await expectNoChange(pass, source, balanced);
    const { code } = await rename(source, { preset: 'aggressive' });
    expect(code).toContain('socket');
  });
});

describe('rename.identifiers - policy and determinism', () => {
  it('records a RenameRecord with a reason and confidence for every rename', async () => {
    const { ctx } = await rename(`(function () {
      var q = document.getElementById('minimap');
      use(q);
    })();`);
    expect(ctx.renames).toHaveLength(1);
    const [record] = ctx.renames;
    expect(record).toMatchObject({ from: 'q', to: 'minimapEl' });
    expect(record!.reason).toMatch(/^A01: /);
    expect(record!.confidence).toBeGreaterThan(0.5);
    expect(ctx.totalChanges).toBe(1);
  });

  it('is deterministic across runs', async () => {
    const source = `(function () {
      var a = document.getElementById('minimap');
      var b = a.getContext('2d');
      var c = new WebSocket('wss://example.test/x');
      for (var d = 0, e = 0; d < 10; d++) {
        e += d;
      }
      try {
        b.fillRect(0, 0, e, e);
      } catch (f) {
        c.send(f);
      }
    })();`;
    const first = await renamesOf(source);
    const second = await renamesOf(source);
    const third = await renamesOf(source);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.length).toBeGreaterThan(4);
  });

  it('produces the same decisions when unrelated code is prepended', async () => {
    const body = `(function () {
      var a = document.getElementById('minimap');
      var b = a.getContext('2d');
      b.fillRect(0, 0, 1, 1);
    })();`;
    const prefix = Array.from({ length: 200 }, (_, i) => `var unrelated${i} = ${i};`).join('\n');
    const plain = await renamesOf(body);
    const shifted = await renamesOf(`${prefix}\n${body}`);
    expect(shifted).toEqual(plain);
  });

  it('honours minConfidence', async () => {
    const source = `(function () {
      var q = [];
      q.push(1);
    })();`;
    const permissive = await renamesOf(source, {
      preset: 'balanced',
      techniques: { variableRenaming: { minConfidence: 0.3 } },
    });
    expect(permissive).toContain('q->items');
    await expectNoChange(pass, source, {
      preset: 'balanced',
      techniques: { variableRenaming: { minConfidence: 0.95 } },
    });
  });

  it('honours renameParameters', async () => {
    const source = `(function () {
      function draw(c) {
        c.beginPath();
        c.fillRect(0, 0, 1, 1);
      }
      draw(null);
    })();`;
    await expectNoChange(pass, source, {
      preset: 'balanced',
      techniques: { variableRenaming: { renameParameters: false } },
    });
  });

  it('honours caller-supplied hints', async () => {
    const { code } = await rename(
      `(function () {
        var _0xab12 = 1;
        use(_0xab12);
      })();`,
      {
        preset: 'balanced',
        techniques: { variableRenaming: { hints: { _0xab12: 'seedValue' } } },
      },
    );
    expect(code).toContain('var seedValue = 1');
  });

  it('falls back to typed generic names only under the aggressive preset', async () => {
    const source = `(function () {
      var q = external;
      var z = other;
      use(q, z);
    })();`;
    await expectNoChange(pass, source, balanced);
    const { code } = await rename(source, { preset: 'aggressive' });
    expect(code).toMatch(/var val1 = external/);
    expect(code).toMatch(/var val2 = other/);
  });

  it('makes no change when there is no evidence at all', async () => {
    await expectNoChange(
      pass,
      `(function () {
        var q = external;
        use(q);
      })();`,
      balanced,
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      pass,
      `(function () {
        var a = document.getElementById('minimap');
        var b = a.getContext('2d');
        b.fillRect(0, 0, 1, 1);
        try {
          boom();
        } catch (c) {
          report(c);
        }
      })();`,
      balanced,
    );
  });

  it('keeps every reference resolving to the same binding after renaming', async () => {
    const { code } = await rename(`(function () {
      var a = document.getElementById('minimap');
      function inner(a2) {
        return a2 + a.width;
      }
      return inner(1);
    })();`);
    assertParses(code);
    expect(code).toContain('minimapEl.width');
    expect(code).toContain('function inner(');
  });
});

describe('rename.identifiers - real fixtures', () => {
  const LIGHT_FIXTURE = thirdPartyFixture('lightly-obfuscated.js');
  const HEAVY_FIXTURE = thirdPartyFixture('obfuscated2.js');

  it.skipIf(!LIGHT_FIXTURE.present)('preserves every binding resolution across 470 KB of mangled ES5', async () => {
    const source = LIGHT_FIXTURE.read();
    const { ctx, code } = await expectBindingsPreserved(source, {
      preset: 'balanced',
      language: 'js',
    });
    expect(ctx.renames.length).toBeGreaterThan(100);
    // `Mb` is published as `d[_0xdb56[325]]` where `d` is the window parameter
    // of the wrapping IIFE, so it is callable from the page's HTML.
    expect(ctx.renames.map((entry) => entry.from)).not.toContain('Mb');
    expect(code).toContain('d[_0xdb56[325]] = Mb');
  });

  it.skipIf(!HEAVY_FIXTURE.present)('recovers the obfuscator machinery in 4.1 MB of obfuscator.io output', async () => {
    const source = HEAVY_FIXTURE.read();
    const { ctx } = await expectBindingsPreserved(source, { preset: 'balanced', language: 'js' });
    const applied = new Map(ctx.renames.map((entry) => [entry.from, entry.to]));
    expect(applied.get('_0x4a68')).toBe('getStringArray');
    expect(applied.get('_0x123b')).toBe('decodeString');
    expect(applied.get('_0x27febf')).toBe('expectedChecksum');
    expect(applied.get('_0x5c3867')).toBe('checksum');
    expect(applied.get('_0x4d28ce')).toMatch(/^getStringArray\d?$/);
  });

  it('exposes inferNames directly, with renameImports as an escape hatch', () => {
    const source = `import Zz from 'axios';\nZz.get('/x');`;
    const parsed = parseSource(source, { language: 'js', sourceType: 'module' });
    const frozen = inferNames(programPathOf(parsed.ast), { sourceType: 'module' });
    expect(frozen.renames).toEqual([]);

    const reparsed = parseSource(source, { language: 'js', sourceType: 'module' });
    const opened = inferNames(programPathOf(reparsed.ast), {
      sourceType: 'module',
      renameImports: true,
    });
    expect(opened.renames).toEqual([
      expect.objectContaining({ from: 'Zz', to: 'axios', reason: expect.stringMatching(/^A20: /) }),
    ]);
  });

  it.skipIf(!LIGHT_FIXTURE.present)('is deterministic on a real fixture', async () => {
    const source = LIGHT_FIXTURE.read();
    const first = await runPass(pass, source, { preset: 'balanced', language: 'js' });
    const second = await runPass(pass, source, { preset: 'balanced', language: 'js' });
    expect(second.code).toBe(first.code);
  });
});

/**
 * `_0x4d28ce` is one obfuscator's house style, not the shape of a generated
 * name. A commercial protector draws from `[A-Za-z0-9]` - `FCB7VNAT`,
 * `woq4lLvw` - and stamps a short tag on its helpers, and neither is reachable
 * from a prefix rule.
 *
 * The negative cases below matter more than the positive ones. Leaving
 * `woq4lLvw` alone costs the reader one opaque name; renaming `getMsg` to
 * `str1` costs them a name that was already right, and there is no way for them
 * to tell from the output that it happened.
 */
describe('generated-name recognition', () => {
  const GENERATED = [
    'Atpk5jY',
    'OPgjD2gE',
    'Vt7nCb',
    'aSjPvWC',
    'bdWz9TI',
    'cLmZ0yN5',
    'pf4vF',
    'uAZ1rG8w',
    'woq4lLvw',
    'xPjwC0rm',
    'FCB7VNAT',
  ];

  const HAND_WRITTEN = [
    // Short names and acronyms, which the rule must never reach for.
    'URL', 'API', 'UUID', 'ctx', 'idx', 'req', 'res', 'err', 'msg',
    // Ordinary camelCase and PascalCase, including acronym runs.
    'getUserById', 'XMLHttpRequest', 'parseURL', 'toJSONString', 'HTMLElement',
    'getMsg', 'setCtx', 'xhrSend', 'imgSrc', 'useMemo', 'ReactDOM', 'RGBToHSL',
    'WebGL2RenderingContext', 'getURLParams', 'parseHTMLString',
    // Digits where a person puts them: at the end of a camelCase word.
    'md5Hash', 'MD5ToHex', 'utf8Decode', 'utf16leToBytes', 'base64Encode',
    'sha256Hex', 'vec3Add', 'int32Array', 'html5Parser', 'toRGBA', 'i18next',
    'a11yProps', 'p2pConnect', 'secp256k1', 'keccak256', 'ed25519Sign', 'crc32Table',
    // ALL-CAPS constants, including ones with digits.
    'SHA256', 'CRC32', 'BASE64', 'IPV4ADDRESS', 'IPV6ADDRESS', 'LOG10E', 'LOG2E',
    'MAX_SAFE_INTEGER',
    // Separators are a human signal, so a snake or private name is never generated.
    'my_var_name', '_private', '$element', '__dirname', '__webpack_require__',
  ];

  it.each(GENERATED)('recognises %s as generated', (name) => {
    expect(isObfuscatedName(name)).toBe(true);
    expect(isReadableName(name)).toBe(false);
  });

  it.each(HAND_WRITTEN)('leaves %s alone', (name) => {
    expect(isObfuscatedName(name)).toBe(false);
  });

  it('still recognises the two schemes it always did', () => {
    expect(isObfuscatedName('_0x4d28ce')).toBe(true);
    expect(isObfuscatedName('_0x27febf_1')).toBe(true);
    expect(isObfuscatedName('a1')).toBe(true);
    expect(isObfuscatedName('_b')).toBe(true);
  });

  it('will not judge a name too short or too long to have a shape', () => {
    expect(isObfuscatedName('Vt7n')).toBe(false);
    expect(isObfuscatedName('aB3cD4eF5gH6iJ7kL8mN9oP0qR')).toBe(false);
  });
});

describe('generated-prefix schemes', () => {
  const gwp = [
    '__gwp_0AKIU', '__gwp_1xzB5', '__gwp_2oF5j', '__gwp_4TzQy', '__gwp_5Rkze',
    '__gwp_7DqSv', '__gwp_9EgWV', '__gwp_Cf2XH', '__gwp_GxR7X', '__gwp_KqTgF',
    '__gwp_Q0Ygx', '__gwp_zie0N',
  ];

  it('learns a tag that many bindings share', () => {
    expect(detectNameScheme(gwp).prefixes).toEqual(['__gwp_']);
  });

  it('applies the learned tag to every binding carrying it', () => {
    const scheme = detectNameScheme(gwp);
    expect(isObfuscatedName('__gwp_9xpj5_imul', scheme)).toBe(true);
    // The same name is unremarkable without the population evidence behind it.
    expect(isObfuscatedName('__gwp_9xpj5_imul')).toBe(false);
  });

  it('refuses a bundler prefix, whose tag is a word and whose suffixes are words', () => {
    const webpack = [
      '__webpack_require__', '__webpack_modules__', '__webpack_exports__',
      '__webpack_module_cache__', '__webpack_unused_export__', '__webpack_public_path__',
      '__webpack_nonce__', '__webpack_chunk_load__', '__webpack_hash__', '__webpack_base_uri__',
    ];
    expect(detectNameScheme(webpack).prefixes).toEqual([]);
    expect(isObfuscatedName('__webpack_require__', detectNameScheme(webpack))).toBe(false);
  });

  it('refuses a snake_case convention, however many bindings share it', () => {
    const suite = [
      'test_alpha', 'test_beta', 'test_gamma', 'test_delta', 'test_epsilon',
      'test_zeta', 'test_eta', 'test_theta', 'test_iota', 'test_kappa',
    ];
    expect(detectNameScheme(suite).prefixes).toEqual([]);
  });

  it('refuses a tag that too few bindings share', () => {
    expect(detectNameScheme(gwp.slice(0, 4)).prefixes).toEqual([]);
  });

  it('is order-independent, so the scheme is reproducible', () => {
    expect(detectNameScheme([...gwp].reverse()).prefixes).toEqual(
      detectNameScheme(gwp).prefixes,
    );
  });
});

describe('rename.identifiers - a non-_0x naming scheme', () => {
  const SOURCE = [
    'function __gwp_0AKIU(a) { return a; }',
    'function __gwp_1xzB5(a) { return a; }',
    'function __gwp_2oF5j(a) { return a; }',
    'function __gwp_4TzQy(a) { return a; }',
    'function __gwp_5Rkze(a) { return a; }',
    'function __gwp_7DqSv(a) { return a; }',
    'function __gwp_9EgWV(a) { return a; }',
    'function __gwp_Cf2XH(a) { return a; }',
    'function __gwp_GxR7X(a) { return a; }',
    "var woq4lLvw = document.getElementById('minimap');",
    'woq4lLvw.width = 10;',
    'var getMsg = document.getElementById("banner");',
    'use(__gwp_0AKIU, __gwp_1xzB5, __gwp_2oF5j, __gwp_4TzQy, __gwp_5Rkze,',
    '    __gwp_7DqSv, __gwp_9EgWV, __gwp_Cf2XH, __gwp_GxR7X, getMsg);',
  ].join('\n');

  it('renames a random mixed-case name that no prefix rule would reach', async () => {
    const applied = await renamesOf(SOURCE, { preset: 'aggressive' });
    expect(applied).toContain('woq4lLvw->minimapEl');
  });

  it('renames the tagged helpers once the tag is learned from the population', async () => {
    const applied = await renamesOf(SOURCE, { preset: 'aggressive' });
    expect(applied.filter((entry) => entry.startsWith('__gwp_')).length).toBeGreaterThan(4);
  });

  it('leaves an already-good name in the same file alone', async () => {
    const applied = await renamesOf(SOURCE, { preset: 'aggressive' });
    expect(applied.some((entry) => entry.startsWith('getMsg->'))).toBe(false);
  });

  it('keeps every binding resolving where it did', async () => {
    await expectBindingsPreserved(SOURCE, { preset: 'aggressive' });
  });

  it('is idempotent', async () => {
    await expectIdempotent(pass, SOURCE, { preset: 'aggressive' });
  });
});
