import { describe, expect, it } from 'vitest';
import { evalPackerPass } from '../src/passes/unpack/eval-packer.js';
import { webpackModulesPass } from '../src/passes/unpack/webpack-modules.js';
import type { ModuleRecord } from '../src/passes/unpack/webpack-modules.js';
import {
  assertParses,
  expectEquivalent,
  expectIdempotent,
  expectNoChange,
  runPass,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Packer fixtures
//
// These are the four unpacker bodies Dean Edwards' packer actually emits,
// transcribed verbatim. `String.raw` matters: the emitted source contains the
// two-character sequences `\b` and `\w`, and a cooked template would turn them
// into a backspace and a `w`.
// ---------------------------------------------------------------------------

const ENCODER_62 = String.raw`e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};`;
const ENCODER_36 = String.raw`e=function(c){return c.toString(a)};`;
const ENCODER_10 = String.raw`e=function(c){return c};`;
const ENCODER_95 = String.raw`e=function(c){return(c<a?'':e(parseInt(c/a)))+String.fromCharCode(c%a+161)};`;

const FAST_DECODE = String.raw`if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\w+'};c=1};`;
const LOOP_WORD_BOUNDARY = String.raw`while(c--){if(k[c]){p=p.replace(new RegExp('\b'+e(c)+'\b','g'),k[c])}}return p`;
const LOOP_PLAIN = String.raw`while(c--){if(k[c]){p=p.replace(new RegExp(e(c),'g'),k[c])}}return p`;

interface PackerSpec {
  payload: string;
  base: number;
  count: number;
  /** A string is emitted as `'...'.split('|')`; an array as an array literal. */
  keywords: string | string[];
  encoder?: string;
  loop?: string;
  fastDecode?: boolean;
}

function pack(spec: PackerSpec): string {
  const body = [
    spec.encoder ?? ENCODER_62,
    spec.fastDecode === false ? '' : FAST_DECODE,
    spec.loop ?? LOOP_WORD_BOUNDARY,
  ].join('');
  const keywords = Array.isArray(spec.keywords)
    ? `[${spec.keywords.map(quote).join(',')}]`
    : `${quote(spec.keywords)}.split('|')`;
  return `eval(function(p,a,c,k,e,d){${body}}(${quote(spec.payload)},${spec.base},${spec.count},${keywords},0,{}))`;
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/** `function hello(){console.log("world")}` under any of the four encoders. */
const GREETING_PAYLOAD = '0 1(){2.3("4")}';
const GREETING_KEYWORDS = 'function|hello|console|log|world';
// Quotes stay as the payload wrote them: the generator prints a parsed literal
// from its original raw text rather than re-quoting it.
const GREETING_SOURCE = 'function hello(){console.log("world");}';

describe('unpack.eval-packer', () => {
  it('inverts a base-62 packer without executing it', async () => {
    const { code, changes } = await runPass(
      evalPackerPass,
      pack({ payload: GREETING_PAYLOAD, base: 62, count: 5, keywords: GREETING_KEYWORDS }),
    );
    expect(changes).toBeGreaterThan(0);
    expectEquivalent(code, GREETING_SOURCE);
    assertParses(code);
  });

  it('inverts a base-36 packer', async () => {
    const { code } = await runPass(
      evalPackerPass,
      pack({
        payload: GREETING_PAYLOAD,
        base: 36,
        count: 5,
        keywords: GREETING_KEYWORDS,
        encoder: ENCODER_36,
      }),
    );
    expectEquivalent(code, GREETING_SOURCE);
  });

  it('inverts a base-10 packer whose encoder is the identity function', async () => {
    const { code } = await runPass(
      evalPackerPass,
      pack({
        payload: GREETING_PAYLOAD,
        base: 10,
        count: 5,
        keywords: GREETING_KEYWORDS,
        encoder: ENCODER_10,
      }),
    );
    expectEquivalent(code, GREETING_SOURCE);
  });

  it('inverts a base-95 packer, whose tokens are not word characters', async () => {
    // Tokens are String.fromCharCode(161 + index), so the substitution regex
    // carries no \b and the payload is written with those characters directly.
    const token = (index: number) => String.fromCharCode(161 + index);
    const payload = `${token(0)} ${token(1)}(){${token(2)}.${token(3)}("${token(4)}")}`;
    const { code } = await runPass(
      evalPackerPass,
      pack({
        payload,
        base: 95,
        count: 5,
        keywords: GREETING_KEYWORDS,
        encoder: ENCODER_95,
        loop: LOOP_PLAIN,
        fastDecode: false,
      }),
    );
    expectEquivalent(code, GREETING_SOURCE);
  });

  it('substitutes keywords in descending order', async () => {
    // Token 10 is 'a' and keyword 0 is also 'a'. Ascending order would rewrite
    // the 'a' it just produced into 'alert'; descending order never revisits it.
    const source = pack({
      payload: '0()',
      base: 36,
      count: 11,
      keywords: 'a||||||||||alert',
      encoder: ENCODER_36,
    });
    const { code } = await runPass(evalPackerPass, source);
    expectEquivalent(code, 'a();');
    expect(code).not.toContain('alert');
  });

  it('skips empty keyword slots the way the packer guard does', async () => {
    const { code } = await runPass(
      evalPackerPass,
      pack({ payload: '0(1)', base: 62, count: 2, keywords: ['alert', ''] }),
    );
    expectEquivalent(code, 'alert(1);');
  });

  it('accepts the array-literal keyword form', async () => {
    const { code } = await runPass(
      evalPackerPass,
      pack({
        payload: GREETING_PAYLOAD,
        base: 62,
        count: 5,
        keywords: ['function', 'hello', 'console', 'log', 'world'],
      }),
    );
    expectEquivalent(code, GREETING_SOURCE);
  });

  it('unwraps layered packers to a fixpoint', async () => {
    const inner = pack({ payload: '0(1)', base: 62, count: 2, keywords: 'alert|42' });
    // Token 39 encodes to 'D', which appears nowhere else in the inner source.
    const outer = pack({
      payload: inner.replace("'alert|42'", "'D|42'"),
      base: 62,
      count: 40,
      keywords: `${'|'.repeat(39)}alert`,
    });

    const { code, ctx } = await runPass(evalPackerPass, outer);
    expectEquivalent(code, 'alert(42);');
    expect(ctx.diagnostics.some((d) => d.message.includes('2 eval-packer layer'))).toBe(true);
  });

  it('unwraps a packer nested inside a function body', async () => {
    const source = `function boot(){${pack({
      payload: GREETING_PAYLOAD,
      base: 62,
      count: 5,
      keywords: GREETING_KEYWORDS,
    })};}\nboot();`;
    const { code } = await runPass(evalPackerPass, source);
    expect(code).toContain('function hello(');
    expect(code).not.toContain('eval(');
    assertParses(code);
  });

  it('reports the packer as a detection', async () => {
    const { ctx } = await runPass(
      evalPackerPass,
      pack({ payload: GREETING_PAYLOAD, base: 62, count: 5, keywords: GREETING_KEYWORDS }),
    );
    const detection = ctx.detections.find((d) => d.kind === 'eval-packer');
    expect(detection?.evidence).toContain('base-62');
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      evalPackerPass,
      pack({ payload: GREETING_PAYLOAD, base: 62, count: 5, keywords: GREETING_KEYWORDS }),
    );
  });

  it('refuses a six-parameter function that is not an unpacker', async () => {
    await expectNoChange(
      evalPackerPass,
      "eval(function(p,a,c,k,e,d){return p}('x',62,1,'y'.split('|'),0,{}));",
    );
  });

  it('refuses a packer whose payload is not a static string', async () => {
    const source = pack({
      payload: GREETING_PAYLOAD,
      base: 62,
      count: 5,
      keywords: GREETING_KEYWORDS,
    }).replace(`'${GREETING_PAYLOAD}'`, 'getPayload()');
    await expectNoChange(evalPackerPass, source);
  });

  it('refuses a five-parameter unpacker', async () => {
    const source = pack({
      payload: GREETING_PAYLOAD,
      base: 62,
      count: 5,
      keywords: GREETING_KEYWORDS,
    }).replace('function(p,a,c,k,e,d)', 'function(p,a,c,k,e)');
    await expectNoChange(evalPackerPass, source);
  });

  it('refuses a payload that does not parse, and says why', async () => {
    const { changes, ctx } = await runPass(
      evalPackerPass,
      pack({ payload: '0 {', base: 62, count: 1, keywords: ['function'] }),
    );
    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
  });

  it('refuses a packer in expression position', async () => {
    const source = `var src = ${pack({
      payload: GREETING_PAYLOAD,
      base: 62,
      count: 5,
      keywords: GREETING_KEYWORDS,
    })};`;
    await expectNoChange(evalPackerPass, source);
  });

  it('refuses a packer that has no statement list to expand into', async () => {
    const source = `if (ready) ${pack({
      payload: GREETING_PAYLOAD,
      base: 62,
      count: 5,
      keywords: GREETING_KEYWORDS,
    })};`;
    const { changes, ctx } = await runPass(evalPackerPass, source);
    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('statement list'))).toBe(true);
  });

  it('does nothing when moduleUnwrapping is turned off', async () => {
    await expectNoChange(
      evalPackerPass,
      pack({ payload: GREETING_PAYLOAD, base: 62, count: 5, keywords: GREETING_KEYWORDS }),
      { techniques: { moduleUnwrapping: false } },
    );
  });

  it('reports JSFuck by charset without trying to decode it', async () => {
    const jsfuck =
      '(![]+[])[+[]]+(![]+[])[+!+[]]+(![]+[])[!+[]+!+[]]+(![]+[])[!+[]+!+[]+!+[]];';
    const { changes, ctx } = await runPass(evalPackerPass, jsfuck);
    expect(changes).toBe(0);
    expect(ctx.detections.some((d) => d.evidence.startsWith('jsfuck'))).toBe(true);
  });

  it('reports AAencode by its kaomoji alphabet', async () => {
    const signature = String.fromCharCode(0xff9f, 0x03c9, 0xff9f, 0xff89);
    const { ctx } = await runPass(evalPackerPass, `${signature}=['_'];`);
    expect(ctx.detections.some((d) => d.evidence.startsWith('aaencode'))).toBe(true);
  });

  it('reports JJencode by its coercion-table shape', async () => {
    const { ctx } = await runPass(
      evalPackerPass,
      '$=~[];$={___:++$,$$$$:(![]+"")[$],__$:++$};',
    );
    expect(ctx.detections.some((d) => d.evidence.startsWith('jjencode'))).toBe(true);
  });

  it('does not mistake ordinary code for a legacy format', async () => {
    const { ctx } = await runPass(evalPackerPass, 'const total = items.filter(Boolean).length;');
    expect(ctx.detections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bundler fixtures
// ---------------------------------------------------------------------------

const WEBPACK_HEAD = '(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push';
const TURBOPACK_HEAD = '(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push';

function webpackChunk(modules: string): string {
  return `${WEBPACK_HEAD}([["app/page"], {${modules}}]);`;
}

function inlineMap(sourcePath: string): string {
  const map = JSON.stringify({
    version: 3,
    sources: [sourcePath],
    names: [],
    mappings: '',
  });
  const base64 = Buffer.from(map, 'utf-8').toString('base64');
  return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}`;
}

describe('unpack.webpack-modules', () => {
  const twoModules = webpackChunk(`
    "./src/a.js": function (module, exports, __webpack_require__) { module.exports = 1; },
    "./src/b.js": function (module, exports, __webpack_require__) { module.exports = 2; }
  `);

  it('hoists each module factory into its own named declaration', async () => {
    const { code, changes } = await runPass(webpackModulesPass, twoModules);
    expect(changes).toBe(2);
    expect(code).toContain('function module_src_a(module, exports, __webpack_require__)');
    expect(code).toContain('function module_src_b(module, exports, __webpack_require__)');
    assertParses(code);
  });

  it('leaves the registration call in place, referring to the hoisted bindings', async () => {
    const { code } = await runPass(webpackModulesPass, twoModules);
    expect(code).toContain('.push(');
    // The map still registers both ids; only the factories moved out of it.
    expect(code).toMatch(/"\.\/src\/a\.js":\s*module_src_a/);
    expect(code).toMatch(/"\.\/src\/b\.js":\s*module_src_b/);
  });

  it('preserves module order, declaring every factory before the push', async () => {
    const { code } = await runPass(webpackModulesPass, twoModules);
    const first = code.indexOf('function module_src_a');
    const second = code.indexOf('function module_src_b');
    const push = code.indexOf('.push(');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(push);
  });

  it('labels each module with a navigable banner comment', async () => {
    const { code } = await runPass(webpackModulesPass, twoModules);
    expect(code).toContain('webpack module "./src/a.js"');
    expect(code).toContain('webpack module "./src/b.js"');
  });

  it('keeps two modules that declare the same name in separate scopes', async () => {
    const source = webpackChunk(`
      "./a.js": function (module, exports) { var shared = 1; module.exports = shared; },
      "./b.js": function (module, exports) { var shared = 2; module.exports = shared; }
    `);
    const { code } = await runPass(webpackModulesPass, source);
    assertParses(code);
    expect(code.match(/var shared/g)).toHaveLength(2);
    // Each `shared` is inside its own function, so neither shadows the other.
    expect(code).toContain('function module_a(module, exports)');
    expect(code).toContain('function module_b(module, exports)');
  });

  it('gives two chunks that share a module id two distinct bindings', async () => {
    const source = [
      `${WEBPACK_HEAD}([[1], {10: function (module) { module.exports = 'a'; }}]);`,
      `${WEBPACK_HEAD}([[2], {10: function (module) { module.exports = 'b'; }}]);`,
    ].join('\n');
    const { code } = await runPass(webpackModulesPass, source);
    assertParses(code);
    // A shared name would make one declaration shadow the other and both
    // chunks would register the same factory.
    expect(code.match(/function module_10\b/g)).toHaveLength(1);
    expect(code.match(/function module_10_2\b/g)).toHaveLength(1);
  });

  it('converts arrow factories that cannot observe `this`', async () => {
    const source = webpackChunk(`
      10: (module, exports) => { module.exports = 10; },
      20: (module, exports) => { module.exports = 20; }
    `);
    const { code } = await runPass(webpackModulesPass, source);
    expect(code).toContain('function module_10(module, exports)');
    expect(code).toContain('function module_20(module, exports)');
  });

  it('keeps an arrow factory as an arrow when its body reads `this`', async () => {
    const source = webpackChunk('30: (module) => { module.exports = this; }');
    const { code } = await runPass(webpackModulesPass, source);
    expect(code).toContain('const module_30 =');
    expect(code).toContain('=>');
  });

  it('unwraps the Turbopack container shape', async () => {
    const source = `${TURBOPACK_HEAD}(["object" == typeof document ? document.currentScript : void 0, 51364, e => { "use strict"; var t = e.i(43476); }, 51365, e => { "use strict"; }]);`;
    const { code, ctx } = await runPass(webpackModulesPass, source);
    expect(code).toContain('function module_51364(e)');
    expect(code).toContain('function module_51365(e)');
    expect(ctx.detections.some((d) => d.evidence.startsWith('turbopack chunk'))).toBe(true);
    assertParses(code);
  });

  it('records what it unwrapped for later stages', async () => {
    const { ctx } = await runPass(webpackModulesPass, twoModules);
    const records = ctx.shared.get('unpack.webpack-modules:modules') as ModuleRecord[];
    expect(records.map((record) => record.id)).toEqual(['./src/a.js', './src/b.js']);
    expect(records[0]?.binding).toBe('module_src_a');
    expect(ctx.detections.some((d) => d.kind === 'webpack-bundle')).toBe(true);
  });

  it('is idempotent', async () => {
    await expectIdempotent(webpackModulesPass, twoModules);
  });

  it('refuses a chunk map holding anything that is not a factory', async () => {
    await expectNoChange(
      webpackModulesPass,
      webpackChunk('10: function (module) { module.exports = 1; }, 20: existingFactory'),
    );
  });

  it('refuses a chunk map with a spread element', async () => {
    await expectNoChange(
      webpackModulesPass,
      webpackChunk('...extra, 10: function (module) { module.exports = 1; }'),
    );
  });

  it('refuses an empty chunk map', async () => {
    await expectNoChange(webpackModulesPass, webpackChunk(''));
  });

  it('refuses a Turbopack array whose id/factory pairs do not line up', async () => {
    await expectNoChange(
      webpackModulesPass,
      `${TURBOPACK_HEAD}([document.currentScript, 51364, e => {}, 51365]);`,
    );
  });

  it('refuses a push to something that is not a bundler registry', async () => {
    await expectNoChange(
      webpackModulesPass,
      'var __webpack_require__ = null;\n(self.myThing = self.myThing || []).push([[1], {10: function (module) { module.exports = 1; }}]);',
    );
  });

  it('refuses a chunk that has no statement list to expand into', async () => {
    await expectNoChange(
      webpackModulesPass,
      `if (ready) ${webpackChunk('10: function (module) { module.exports = 1; }')}`,
    );
  });

  it('does nothing when moduleUnwrapping is turned off', async () => {
    await expectNoChange(webpackModulesPass, twoModules, {
      techniques: { moduleUnwrapping: false },
    });
  });

  it('does nothing on a file with no bundler markers at all', async () => {
    await expectNoChange(webpackModulesPass, 'export const answer = 42;');
  });
});

describe('unpack.webpack-modules dev builds', () => {
  const devModule = [
    '__webpack_require__.r(exports);',
    'var greeting = 1;',
    '//# sourceURL=[module]',
    inlineMap('webpack://_N_E/./src/app/page.tsx'),
  ].join('\n');

  it('inlines an eval string module and drops its stale source annotations', async () => {
    const source = webpackChunk(
      `"./src/app/page.tsx": function (module, exports, __webpack_require__) { eval(${JSON.stringify(devModule)}); }`,
    );
    const { code } = await runPass(webpackModulesPass, source);
    expect(code).toContain('var greeting = 1;');
    expect(code).not.toContain('eval(');
    expect(code).not.toContain('sourceMappingURL');
    expect(code).toContain('function module_src_app_page(');
    assertParses(code);
  });

  it('unwraps the `__webpack_require__.ts(...)` wrapper form', async () => {
    const source = webpackChunk(
      `"./src/x.js": function (module, exports, __webpack_require__) { eval(__webpack_require__.ts(${JSON.stringify(devModule)})); }`,
    );
    const { code } = await runPass(webpackModulesPass, source);
    expect(code).toContain('var greeting = 1;');
    expect(code).not.toContain('eval(');
  });

  it('names a standalone eval module from its source map', async () => {
    const { code } = await runPass(webpackModulesPass, `eval(${JSON.stringify(devModule)});`);
    expect(code).toContain('module source "./src/app/page.tsx"');
    expect(code).toContain('var greeting = 1;');
  });

  it('falls back to the sourceURL when there is no inline map', async () => {
    const module = 'var value = 2;\n//# sourceURL=webpack://app/./src/value.js';
    const { code } = await runPass(webpackModulesPass, `eval(${JSON.stringify(module)});`);
    expect(code).toContain('module source "./src/value.js"');
  });

  it('refuses an eval string with no bundler marker in it', async () => {
    await expectNoChange(
      webpackModulesPass,
      'var __webpack_require__ = null;\neval("var value = 1;");',
    );
  });

  it('refuses an eval string that does not parse', async () => {
    const { changes, ctx } = await runPass(
      webpackModulesPass,
      `eval(${JSON.stringify('function {\n//# sourceURL=webpack://app/./broken.js')});`,
    );
    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
  });

  it('is idempotent over an inlined dev module', async () => {
    await expectIdempotent(webpackModulesPass, `eval(${JSON.stringify(devModule)});`);
  });
});
