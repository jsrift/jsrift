import { fileURLToPath } from 'node:url';
import { defineConfig, type Options } from 'tsup';

const DEBUG_STUB = fileURLToPath(new URL('./build/debug-stub.cjs', import.meta.url));

const shared = {
  sourcemap: true,
  target: 'es2022',
  splitting: false,
  treeshake: true,
  /*
   * Babel is bundled into `dist`, not left as a bare import for the consumer's
   * bundler to resolve, and the reason is `@babel/types`: it reads
   * `process.env.BABEL_TYPES_8_BREAKING` at module load, unguarded, in every
   * validator it builds. A browser bundle with no `process` global - esbuild,
   * Vite, Rollup, webpack 5 - threw `ReferenceError: process is not defined`
   * from inside Babel before a line of this engine ran, and the only fix a
   * consumer had was a `define` in their own bundler config. A `define` here
   * reaches that code only if it is in this bundle; a bare `import` of
   * `@babel/types` is resolved by the consumer, out of reach of this config.
   *
   * `platform: 'browser'` finishes the job for `picocolors`, which
   * `@babel/code-frame` pulls in: its Node variant reads `process` bare at
   * load (`let p = process || {}`, a ReferenceError where there is none) and
   * its browser variant is inert and runs under Node just as well. `debug`
   * gets no such choice - it is replaced outright by build/debug-stub.cjs,
   * through the `alias` in `esbuildOptions` below, because its browser
   * variant reads `window.process` at logger creation behind a `typeof
   * window` guard that a downstream bundler folds away in a Worker (see the
   * stub). The stub is bundled into `dist` like any other module, so `build/`
   * is a build-time input and not a published file. The CJS build takes the
   * same platform: it is a Node entry, but nothing here needs a browser, and
   * one platform means the two formats are the same program.
   *
   * `global` is the one Node-only name Babel reaches unguarded at run time
   * rather than at load: `path.evaluate()` looks a whitelisted callee up as
   * `global[name]`, and `clean.dead-branches` asks it about a branch test
   * that names a binding whose initialiser is such a call. webpack and
   * Turbopack alias `global` to `globalThis` in a browser build, which is why
   * the web app never saw it; esbuild, Vite and Rollup do not, and there the
   * first `var p = String.fromCharCode(n); if (p === 'a')` threw `global is
   * not defined` and the kernel disabled the pass for the rest of the run. The
   * two names are the same object in every Node this package supports, so the
   * rewrite changes nothing for the CJS build. esbuild rewrites only unbound
   * references; the `global2` parameters of the UMD wrappers Babel's
   * source-map dependencies ship in are bound and untouched.
   *
   * The `.d.ts` still imports `@babel/types` and `@babel/traverse` by name, so
   * the packages stay in `dependencies` for the types alone.
   */
  noExternal: [/^@babel\//],
  platform: 'browser',
  define: { 'process.env.BABEL_TYPES_8_BREAKING': 'false', global: 'globalThis' },
  esbuildOptions(options) {
    options.alias = { ...options.alias, debug: DEBUG_STUB };
  },
} satisfies Options;

/**
 * Two builds rather than one, because the two entries have different consumers.
 *
 * `index` is imported from Node and from bundlers, so it ships both ESM and CJS.
 *
 * `worker` is only ever loaded as a module Worker by a bundler - the `./worker`
 * subpath deliberately exposes no `require` condition, and the module touches
 * `self` at load time, so a CJS copy is unreachable by construction. Emitting
 * one anyway shipped 2.3 MB of unreachable code in every tarball.
 */
export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    /*
     * Never wipe `dist` on a rebuild.
     *
     * The web app resolves `jsrift` to this output, so a build that deletes
     * the folder before repopulating it leaves a window where the package has
     * no entry point. A bundler that resolves inside that window caches the
     * failure, and Turbopack in particular then replays
     * "Module not found: Can't resolve 'jsrift'" on every subsequent
     * recompile until `.next` is deleted by hand - which is exactly what
     * happened when an editor task rebuilt the engine under a running dev
     * server. Writing files in place removes the window entirely.
     *
     * Every emitted file is overwritten by each build, so the only cost is a
     * stale artifact from a renamed entry, and `npm run build:publish` cleans
     * first for the case where that actually matters.
     */
    clean: false,
  },
  {
    ...shared,
    entry: { worker: 'src/parallel/worker.ts' },
    format: ['esm'],
    dts: true,
    // Must not clean: this build runs after the one above and would erase it.
    clean: false,
  },
]);
