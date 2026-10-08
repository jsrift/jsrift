import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, type BuildOptions } from 'esbuild';
import type { Options } from 'tsup';
import { beforeAll, describe, expect, it } from 'vitest';
import config from '../tsup.config.js';
import { deobfuscate } from '../src/index.js';

/**
 * A `Function`-free sample that still walks the two paths where Babel reaches
 * for a Node global: `@babel/types` reads `process.env.BABEL_TYPES_8_BREAKING`
 * while its validators are built, and `path.evaluate()` looks the callee of
 * `String.fromCharCode(n)` up as `global.String` before it finds `n` is not a
 * constant. `clean.dead-branches` asks that of `probe === 'a'`, and Babel
 * resolves `probe` to its initialiser; the call cannot sit in the test
 * directly, because the pass refuses a test with a call in it before Babel is
 * consulted. The argument has to be opaque too: with a literal,
 * `simplify.fold-constants` folds the call first. The last `if` is the
 * witness: once the first test has thrown inside the pass, the kernel
 * disables it and the constant branch after it survives.
 */
const SAMPLE = [
  "var _0xa = ['left', 'right'];",
  'function _0xd(i) { return _0xa[i]; }',
  'function pick(n) {',
  '  var probe = String.fromCharCode(n);',
  "  if (probe === 'a') { log(_0xd(0) + probe); } else { log(_0xd(1) + probe); }",
  '}',
  'pick(97);',
  'pick(98);',
  "if (1) { log('kept'); } else { log('dropped'); }",
].join('\n');

/** Run `code` in a realm with only `log`, returning what it logged. */
function execute(code: string): string {
  const trace: string[] = [];
  vm.runInNewContext(code, { log: (v: unknown) => trace.push(String(v)) }, { timeout: 5_000 });
  return trace.join('\n');
}

const ROOT = new URL('../', import.meta.url);

/**
 * What tsup leaves as a bare import: every `dependencies` /
 * `peerDependencies` name that no `noExternal` pattern claims. The same rule,
 * so the test bundles exactly what the published `dist/index.js` bundles.
 */
function externalsOf(options: Options): string[] {
  const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
  const claimed = (options.noExternal ?? []).map((pattern) =>
    pattern instanceof RegExp ? pattern : new RegExp(`^${String(pattern)}$`),
  );
  return names.filter((name) => !claimed.some((pattern) => pattern.test(name)));
}

/**
 * An identifier-level read of `window` - `window.x`, `window[x]` - and not
 * the string `"window"`, which the engine's own name tables carry. The same
 * expression `packages/web/scripts/check-export.mjs` runs over the exported
 * engine chunk.
 */
const BARE_WINDOW_READ = /(^|[^.\w$"'`])window\s*[.[]/;

/**
 * A realm with only ECMAScript intrinsics plus the `self` a page or Worker
 * has. No `process`, no `global`, no `require`, no `window`: what esbuild,
 * Vite and Rollup hand the engine in a browser, and - the `window` part - what
 * every bundler hands it in a module Worker.
 */
function workerRealm(): vm.Context {
  const realm = vm.createContext(Object.create(null));
  vm.runInContext('globalThis.self = globalThis;', realm);
  for (const name of ['process', 'global', 'require', 'window']) {
    expect(vm.runInContext(`typeof ${name}`, realm)).toBe('undefined');
  }
  return realm;
}

describe('the published bundle runs where there is no process and no window', () => {
  let code: string;

  beforeAll(async () => {
    // The `index` entry's settings, not a copy of them: the point is that
    // `tsup.config.ts` is what makes the shipped file self-sufficient. That
    // includes its `esbuildOptions` hook, where the `debug` alias lives - a
    // bundle built from the plain fields is the one with `debug`'s browser
    // variant in it, and this test passed against that bundle while the
    // product hung.
    const [index] = config as Options[];
    expect(index?.entry).toEqual({ index: 'src/index.ts' });

    const options: BuildOptions & { write: false } = {
      entryPoints: [fileURLToPath(new URL('src/index.ts', ROOT))],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'jsrift',
      target: 'es2022',
      platform: index!.platform,
      define: index!.define,
      external: externalsOf(index!),
      logLevel: 'silent',
    };
    index!.esbuildOptions?.(options, { format: 'esm' });
    const bundled = await build(options);
    code = bundled.outputFiles[0]!.text;
  });

  it('never reads `window`, guarded or not', () => {
    // A guard is not enough. `debug`'s browser variant read `window.process`
    // behind `typeof window !== "undefined"`, which holds in a Worker and in
    // the realm below - and Turbopack folds `typeof window` to `"object"`
    // across the graph it believes is browser-only, so what shipped was a bare
    // read that threw at load. A read that is not there cannot be unguarded.
    const hit = BARE_WINDOW_READ.exec(code);
    expect(hit ? code.slice(hit.index, hit.index + 80) : null).toBeNull();
    expect(code).not.toMatch(/typeof window/);
  });

  it('loads and deobfuscates in a realm with neither `process` nor `window`', async () => {
    const realm = workerRealm();

    // The fold Turbopack applied, applied here, so the realm sees the bundle
    // a downstream build ships to a Worker rather than the one esbuild wrote.
    // A no-op on a bundle that has no `typeof window` to fold, which the test
    // above requires; on the bundle that carried `debug`'s browser variant it
    // is what turned the guarded read into `ReferenceError: window is not
    // defined` at load.
    const folded = code.replaceAll('typeof window', '"object"');
    vm.runInContext(folded, realm, { filename: 'jsrift.iife.js' });
    const engine = vm.runInContext('jsrift', realm) as { deobfuscate: typeof deobfuscate };
    expect(typeof engine.deobfuscate).toBe('function');

    const foreign = await engine.deobfuscate(SAMPLE, { preset: 'balanced' });
    const native = await deobfuscate(SAMPLE, { preset: 'balanced' });

    expect(foreign.metadata.diagnostics.map((d) => d.message)).not.toContainEqual(
      expect.stringMatching(/is not defined/),
    );
    expect(foreign.code).toBe(native.code);
    expect(foreign.metadata.stats.verified).toBe(true);
    expect(execute(foreign.code)).toBe('lefta\nrightb\nkept');
    // The constant branch after the `String.fromCharCode` test is folded, which
    // it cannot be once that test has thrown and taken the pass down with it.
    expect(foreign.code).not.toContain('dropped');
  });
});
