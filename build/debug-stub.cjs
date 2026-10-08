// Stands in for the `debug` package inside the bundled engine.
//
// `@babel/traverse` asks `debug("babel")` for a logger at module load and only
// ever calls it behind `debug.enabled`, so nothing in this engine needs the
// real package - and the real package is a liability in a browser bundle. Its
// browser variant reads `window.process` inside `useColors()`, which runs the
// moment a logger is created, behind a `typeof window !== "undefined"` guard.
// A bundler that folds `typeof window` to `"object"` in code it believes is
// browser-only - Turbopack does, for the whole first-party graph - leaves a bare
// `window.process` read, and in a module Worker there is no `window`: the
// engine threw `ReferenceError: window is not defined` at load and every run
// hung. The Node variant is no better for a browser: it requires `tty` and reads
// `process.env` at load. A stub that is never enabled has neither problem and
// changes nothing Babel does.
function createDebug() {
  const debug = () => {};
  debug.enabled = false;
  debug.namespace = 'babel';
  debug.extend = () => debug;
  return debug;
}
createDebug.enable = () => {};
createDebug.enabled = () => false;
createDebug.disable = () => '';
createDebug.log = () => {};
module.exports = createDebug;
module.exports.default = createDebug;
