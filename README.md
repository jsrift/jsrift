# jsrift

Deobfuscate JavaScript, TypeScript and JSX/TSX. One engine, usable from Node or
straight from the browser: there is no server component and nothing is uploaded.
The web app at https://jsrift.github.io runs this same engine.

## Install

```bash
npm install @jsrift/core
```

```ts
import { deobfuscate } from '@jsrift/core';

const { code, metadata } = await deobfuscate(obfuscatedSource);

console.log(code);
console.log(metadata.detections); // what obfuscator was recognised
console.log(metadata.renames);    // every rename, with the evidence for it
```

The package ships an ESM build (`import`), a CommonJS build (`require`), type
declarations, and a `@jsrift/core/worker` entry point for running the engine off the
main thread (see [Running off the main thread](#running-off-the-main-thread)).
Node 20.19 or later is required.

## What it does

Obfuscated code is code with its meaning removed in layers. `jsrift` removes the
layers in dependency order:

| Technique | What it undoes |
|---|---|
| **String decoding** | String arrays, index offsets, rotation loops, base64/RC4 wrappers, split-string concatenation |
| **Function unwrapping** | Proxy and wrapper functions, object property-alias maps |
| **Control flow analysis** | `while(true) { switch(state) }` dispatcher state machines |
| **Dead code removal** | Injected filler, constant branches, unreachable code, unused bindings |
| **Variable renaming** | `_0x4d28ce` becomes an inferred, scope-safe, meaningful name |

Beyond those five: constant folding, `obj['key']` to `obj.key` normalisation,
`debugger`-trap and self-defending removal, comma-sequence expansion,
webpack/Next.js chunk unwrapping, eval-packer opening, and `_jsx()` to JSX
restoration.

Everything the engine learns is returned as metadata rather than thrown away.
Comments are preserved, and the output can carry a source map back to the input
(the input's own map directive is not preserved: it described the input).

`test/obfuscator-matrix.test.ts` runs 19 `javascript-obfuscator` v5.6 option
sets over 6 programs, plus a four-layer stacked case, and asserts that every
output executes identically to the original program. That execution check, not
a structural similarity check, is what the suite demands.

## What it does not do

- **Names come from static evidence, not from meaning.** You get `items` and
  `toText`, not the author's original identifiers. Nothing outside the engine
  is consulted.
- **Decoding requires evidence.** `var A = ['reduce']` is left alone. A
  one-element array is indistinguishable from ordinary application code, and
  inlining it would be a guess.
- **Nothing is executed by default.** A decoder the `native` and `interpreter`
  tiers cannot handle is reported as a diagnostic rather than run.
- **Not a general unminifier.** Recovering readable code from ordinary minified
  output that was never obfuscated is out of scope.

### Where the analyses stop

Every analysis in the engine is a proof search: it ends in a rewrite or in a
refusal, and a refusal is disclosed in the diagnostics. The shapes below are the
ones where the search stops short of the proof it would need and the output can
differ from the input **without** a diagnostic. None of them is produced by a
mainstream obfuscator; each was found by adversarial differential fuzzing -
hand-written programs, executed against their own deobfuscated form - and each
is left as it is because closing it costs more than it protects. They are stated
so that nobody reading a clean diagnostics list mistakes it for a proof.

**A builtin the program replaces, unseen by the write index.** A decoder that
calls the replaced builtin is evaluated with the real one, at every preset:

- a write through `this` with a bound receiver - `function f(k) { this[k] = ... }`
  called as `f.call(Math, 'round')`, `.apply`, `Reflect.apply`, or `.bind(Math)()`;
- a reflective write whose target is a call result - `Object.assign(mk(), d)`,
  `Reflect.set(m.get('t'), ...)`, `f(id(Math), 'round')` through an identity function;
- an alias made by `Object(x)` - `var o = Object(Math); o.round = ...`;
- the host inside a fresh container - `var arr = [Math]; arr[0].round = ...`,
  `Object.assign({}, { a: Math }).a.round = ...`, a class field holding `Math`;
- a numeric key - `({ 1: Math })[1].round = ...`;
- a method reached through an instance the engine does not track -
  `new U().f(String)` where `f` writes through its parameter.

**String code the classifier does not read.** The decoder machinery is deleted
while a string compiled at run time can still name it; the run reports this at
error severity wherever it can tell, and cannot tell here:

- a decoded value bound into a timer - `setTimeout.bind(null, dec(0), 0)()`, or
  the bound function stored and called later;
- an alias chain longer than four links between a decoded value and a timer;
- a spread or named argument vector - `setTimeout(...arr)`,
  `setTimeout.apply(null, arr)`;
- at `conservative`, a map member read as a timer argument
  (`setTimeout(o.k, 0)`), since object maps are not inlined at that preset;
- a sloppy block-level decoder addressed by a readable global string - deleted
  and disclosed, where a refusal would be the better answer.

**A name read the rename walk does not follow.** A function or class is renamed
while the program reads its `.name`, or a caught error's text, through the
shape; `balanced` keeps a name when it can see the read, `aggressive` discloses
what it cannot follow, and these are past both:

- the global object reached through a tagged template, a Proxy `get` trap,
  `Function.prototype.call.call`, `Array.prototype.concat.apply`, a custom
  `Symbol.iterator`, or `Reflect.set(o, k, globalThis)` then read through `o` -
  a top-level binding read off that object by name is renamed under it;
- a caught error handed to a callee held in a `Map`, `Set` or Proxy built in
  place; `delete g[key]` used as a value; a key built up inside a `while` loop;
- a subclass constructor passing its argument to a parent method that reads it
  under a key the engine cannot decode; `new B().constructor.f.name`; `super.f`
  in a static method;
- an implicit reader stored under a `Symbol` key - `h[Symbol.toPrimitive] = fn`.

**A write whose key the candidate decoder cannot read for itself.** A
reflective call keyed by the decoder's own wrapper - `Object[w(0x1)](o)`, what
`javascript-obfuscator` makes of `Object.keys(o)` - is read with the candidate's
own tier and judged like any named call. Three spellings are not: a plain member
write with the same key (`rest[w(0x1)] = ...`), a wrapper whose offset is a member
of a local object literal (`dec(c - o.k, a)`), and a sibling decoder's call
concatenated with a literal under `splitStrings`. There the decoder is deferred
and, when no later round exposes the key, left encoded with a warning naming the
write. Coverage, not correctness: on 851 programs produced with
`javascript-obfuscator` this is 11 at `conservative` and 4 at `balanced`.

**A local built through the encoded decoder's own keys** -
`Array[dec(0)]({ length: 0 })[dec(1)]()` - is refused at `conservative` and
disclosed at `balanced`, again coverage rather than correctness.

## API

### `deobfuscate(source, options?): Promise<DeobfuscateResult>`

```ts
interface DeobfuscateResult {
  code: string;
  map?: SourceMap;              // when output.sourceMaps === true
  metadata: DeobfuscateMetadata;
}
```

### `analyze(source, options?): AnalysisResult`

Fingerprint the input without transforming it. Parses once and mutates nothing,
so it is cheap enough to run while the user is still typing. `options` takes
`language` and `filename`.

```ts
interface AnalysisResult {
  language: 'js' | 'jsx' | 'ts' | 'tsx';
  sourceType: 'script' | 'module';
  detections: Detection[];
  bytes: number;                // UTF-8 bytes, the same counter stats.inputBytes uses
  lines: number;
}
```

Output for a 470 KB string-array bundle:

```jsonc
{
  "language": "js",
  "sourceType": "script",
  "detections": [
    {
      "kind": "string-array",
      "confidence": 0.97,
      "evidence": "2239-entry string array read at 10197 numeric index sites",
      "count": 2239
    }
  ],
  "bytes": 470485,
  "lines": 10280
}
```

`analyze()` runs the *static* detector only, so it reports less than a full run:
a complete `deobfuscate()` of the same file also reports `string-array` at
confidence 1.0 once `strings.discover` has resolved the decoder.

### `listPasses()`

Every registered pass with its id, title, stage and the technique that gates it,
in the order the pipeline runs them. Useful for building a UI, or for looking up
an id to put in `disablePasses`.

```ts
listPasses(); // [{ id: 'prepare.fold-numbers', title, stage: 'prepare', technique }, ...]
```

### Everything else exported

```ts
import {
  deobfuscate, analyze, listPasses,       // the three you normally need
  detectObfuscation,                      // (ast) => Detection[]; the detector analyze() wraps
  resolveConfig, PRESET_TECHNIQUES,       // preset/override resolution, exposed for UIs
  STAGE_ORDER,                            // ['prepare','unpack','strings','simplify',
                                          //  'structure','clean','rename','finalize']
  ParseFailedError,                       // thrown when no dialect parses the input
  AmbiguousDialectError,                  // thrown when auto-detection would have to guess
  PrintFailedError,                       // thrown when the printer runs out of stack
  WorkerClient, workersAvailable,         // off-main-thread execution
  toTransferable,                         // strip non-cloneable fields before postMessage
} from '@jsrift/core';
```

That list is exhaustive: those thirteen values are the complete runtime export
surface. Types are exported alongside them (`DeobfuscateOptions`,
`DeobfuscateResult`, `DeobfuscateMetadata`, `Detection`, `PassReport`,
`RenameRecord`, `TechniqueFlags`, `ResolvedConfig`, `Pass`, `Stage`, `WorkerLike`,
and the rest of the public type surface).

### Options

```ts
interface DeobfuscateOptions {
  preset?: 'conservative' | 'balanced' | 'aggressive';   // default 'balanced'
  techniques?: TechniqueOverrides;                        // per-technique switches and tuning
  language?: 'auto' | 'js' | 'jsx' | 'ts' | 'tsx';         // default 'auto'
  sourceType?: 'script' | 'module' | 'unambiguous';        // default 'unambiguous'
  filename?: string;            // pins the dialect by extension; names the source-map entry
  output?: OutputOptions;
  performance?: PerformanceOptions;
  sandbox?: SandboxOptions;
  disablePasses?: string[];     // pass ids to skip, below the technique level
  onProgress?: (progress: { stage: string; completed: number; message?: string }) => void;
  signal?: AbortSignal;
}
```

Each group is described in its own section below.

### Options are checked

Every option is validated against its declared type when the call is made, so a
JavaScript caller gets the same protection a TypeScript one does. A value outside
its type - `techniques: { variableRenaming: 'no' }`, `tiers: 'native'`,
`output: { sourcemaps: true }`, `language: 'python'` - throws a `TypeError` naming
the field, the type it wanted and the value it got, before anything runs. A value
of the right type but outside its range (`indent: 99`, `maxIterations: 1.5`, a
`disablePasses` id that names no pass) is repaired and the repair recorded as a
warning in `metadata.diagnostics`.

## Presets

```ts
await deobfuscate(source, { preset: 'aggressive' });
```

The dividing line between presets is **provability**.

| Preset | Behaviour |
|---|---|
| `conservative` | Only transformations guaranteed to preserve semantics: string decoding, constant folding, property normalisation. Decoder machinery that decoding itself makes dead goes with it; nothing else is deleted and nothing is renamed. |
| `balanced` *(default)* | Adds heuristics that hold for all mainstream obfuscators: renaming, control flow recovery, dead code removal, function unwrapping, wrapper unpacking. |
| `aggressive` | Will restructure code it cannot prove equivalent, and renames more freely. The right trade when a human is going to read the result rather than run it. |

The one refusal that separates `balanced` from `aggressive` on real input is
`stringDecoding.decodeDespiteStringCode`. When a program compiles code from a
string - `eval(src)`, `Function(src)`, `setTimeout('src')` - and the engine
cannot read that string, the compiled code could name the string table and
rewrite it. `balanced` therefore leaves such a table encoded and says so in a
diagnostic; `aggressive` decodes it anyway and says *that*. Neither preset
deletes the table's declaration while such a string exists: the compiled code
could spell its name, and an output that throws where the input ran is the one
outcome worse than an undecoded string. On a 470 KB bundle whose single
`Function(_)` call is exactly this hazard, that one flag is the difference
between 447,985 bytes with every reference still encoded and 447,900 bytes with
all 2,203 strings inlined beside the table they came from.

## Technique overrides

Presets are a starting point. Any technique can be turned on or off
independently, and an explicit `false` always beats the preset:

```ts
// Everything aggressive does, except don't delete anything.
await deobfuscate(source, {
  preset: 'aggressive',
  techniques: { deadCodeRemoval: false },
});
```

An override can also carry per-technique tuning, which implicitly enables it:

```ts
await deobfuscate(source, {
  preset: 'conservative',
  techniques: {
    variableRenaming: {
      minConfidence: 0.8,        // only apply names the engine is confident about
      renameParameters: true,
      hints: { _0x4d28ce: 'socket' },
    },
    deadCodeRemoval: { removeUnusedBindings: true, keepCommented: true },
  },
});
```

Resolution order is strict:

```
defaults  <  preset  <  techniques{}  <  disablePasses[]
```

### The techniques

| Key | `conservative` | `balanced` | `aggressive` |
|---|---|---|---|
| `stringDecoding` | on | on | on |
| `literalSimplification` | on | on | on |
| `propertyNormalization` | on | on | on |
| `variableRenaming` | off | on | on |
| `controlFlowAnalysis` | off | on | on |
| `deadCodeRemoval` | off | on | on |
| `functionUnwrapping` | off | on | on |
| `antiTamperRemoval` | off | on | on |
| `statementRecovery` | off | on | on |
| `jsxRestoration` - needs `language: 'jsx'` or `'tsx'`, or a `.jsx`/`.tsx` `filename`; `auto` reports compiled React as `js`, where JSX cannot be printed | off | on | on |
| `moduleUnwrapping` | off | on | on |

`moduleUnwrapping` is on in `balanced` despite the name suggesting a structural
rewrite. What it mostly does is open wrappers: an eval packer, or a `Function`
constructor holding the program as a string. Putting a string that already *is*
the source back into the tree is closer to parsing than to rewriting. With it off,
the default preset returns a packed file essentially unchanged, because every
later pass sees one opaque string literal and correctly finds nothing to do.
Splitting a webpack chunk map into named modules is the structural half, and it
only fires on something that is already a bundle.

### Per-technique tuning

Five techniques take an options object. The table lists every field and the
value each preset resolves it to; an override replaces only the fields it names.

| Option | `conservative` | `balanced` | `aggressive` |
|---|---|---|---|
| `stringDecoding.maxDecodeCalls` | 200,000 | 1,000,000 | `Number.MAX_SAFE_INTEGER` |
| `stringDecoding.decodeDespiteStringCode` | false | false | true |
| `stringDecoding.tiers` | `['native', 'interpreter']` | `['native', 'interpreter']` | `['native', 'interpreter']` |
| `variableRenaming.minConfidence` | 0.9 | 0.55 | 0.3 |
| `variableRenaming.renameReadable` | false | false | true |
| `variableRenaming.renameParameters` | false | true | true |
| `variableRenaming.renameProperties` | false | false | false |
| `variableRenaming.hints` | `{}` | `{}` | `{}` |
| `controlFlowAnalysis.maxStates` | 256 | 2,048 | 16,384 |
| `controlFlowAnalysis.aggressiveDispatchers` | false | false | true |
| `controlFlowAnalysis.registerVm` | false | false | false |
| `controlFlowAnalysis.maxRegisterVmStates` | 512 | 4,096 | 65,536 |
| `deadCodeRemoval.removeUnusedBindings` | false | true | true |
| `deadCodeRemoval.removeUnusedFunctions` | false | true | true |
| `deadCodeRemoval.removeConstantBranches` | false | true | true |
| `deadCodeRemoval.keepCommented` | true | true | false |
| `functionUnwrapping.maxInlineSize` | 12 | 48 | 160 |
| `functionUnwrapping.inlineSingleUse` | false | true | true |
| `functionUnwrapping.refuseOnDirectEval` | true | false | false |

Three of these are off in every preset and opt-in by name only.
`variableRenaming.renameProperties` rewrites object keys, which is unsound when
keys are computed. `controlFlowAnalysis.registerVm` linearises sum-of-registers
VM dispatchers; recognition and reporting of such dispatchers are not gated by
it. `stringDecoding.tiers` never lists `sandbox` in any preset; see
[Security](#security). The reasoning behind `refuseOnDirectEval` and
`decodeDespiteStringCode` is in the type declarations shipped with the package.

For finer control than a technique, disable individual passes by id:

```ts
await deobfuscate(source, { disablePasses: ['simplify.sequences'] });
```

## Languages

```ts
await deobfuscate(source, { language: 'tsx' });   // or 'js' | 'jsx' | 'ts' | 'auto'
```

`auto` (the default) walks a detection ladder from least- to most-featured
grammar and keeps the first dialect that parses cleanly, so plain JavaScript is
reported as `js` rather than as the `tsx` superset that would also accept it.

This matters because `.ts` and `.tsx` are genuinely conflicting grammars, not a
superset relationship - `<T>(x)` is a type assertion in one and a JSX element in
the other. Passing `filename` lets the extension pin the dialect directly.

One shape defeats detection outright, and `auto` refuses it rather than guess. A
type argument on a call - `useState<number>(0)`, `new Map<K, V>()`,
`querySelector<HTMLElement>(sel)` - is also valid JavaScript, where it means the
comparison chain `(useState < number) > 0`. A file whose only TypeScript syntax is
of that kind parses under both grammars with two different meanings, and picking
either would silently rewrite the other program. That throws
`AmbiguousDialectError`, naming the site and the line, and the remedy is to pin
the dialect: `language: 'tsx'` (or `'ts'`, `'js'`, `'jsx'`) or a `filename` with
the extension. A pinned dialect is never second-guessed. Files with any other
TypeScript syntax - an annotation, an interface, an `as` - are unambiguous and
detected as before.

`sourceType` defaults to `'unambiguous'`, which lets the parser decide between
script and module from the syntax; pass `'script'` or `'module'` to pin it.

Both decorator grammars are accepted: the TC39 proposal (`export @dec class`,
auto-accessors, `@(expr)`) is tried first and the legacy form (`@dec export
class`, `@a.b().c`) second, in every dialect.

TypeScript-specific constructs are protected: function overload signatures,
`enum`, `namespace`, ambient declarations and declaration merging are never
treated as dead code.

> **JSX restoration needs the runtime binding and a JSX dialect.** `finalize.jsx`
> converts a call back to JSX only when the `react/jsx-runtime` import (or
> `React.createElement`) resolves in the file, and only when the dialect is `jsx`
> or `tsx` - JSX is a syntax error in a `.js` or `.ts` file, and a compiled React
> file contains no JSX for `auto` to detect, so it is reported as `js`. Given
>
> ```tsx
> import { jsx as _jsx } from "react/jsx-runtime";
> function MyThing() { return _jsx("div", { children: "x" }); }
> export const App = () => _jsx(MyThing, {});
> ```
>
> with `{ language: 'tsx' }` (or `filename: 'App.tsx'`), both `balanced` and
> `aggressive` emit `<div>x</div>` and `<MyThing />`, and neither renames
> anything. Without the dialect the calls come back as they went in and a
> diagnostic says why. Delete the import line and every preset reports
> **0 changes** and no `finalize.jsx` entry in `metadata.passes` - a bare
> `_jsx(...)` that names nothing is left alone rather than guessed at.

Renaming a class **does** rewrite the type positions that refer to it, so
`class Box { }` / `function f(b: Box)` comes back as `class val1 { }` /
`function f(box: val1)` under `aggressive` rather than leaving a dangling type
reference.

## Output

```ts
await deobfuscate(source, {
  output: {
    format: true,          // pretty-print (default); false prints compact output
    indent: 2,             // spaces per level, 0-16; ignored when format is false
    comments: true,        // preserve comments (default)
    sourceMaps: true,      // or 'inline'; default false
    quotes: 'preserve',    // or 'single' | 'double'
    banner: false,         // prepend a summary of what was done
  },
});
```

Those six are the whole of `OutputOptions`.

`quotes: 'single'` or `'double'` re-quotes every string literal in the output,
the ones copied from the input included; only the delimiters change, the escapes
inside a literal are `literalSimplification`'s business. `'preserve'` (the
default) keeps each input literal as it was written and single-quotes the
literals the engine creates. JSX attribute values are not JavaScript string
literals and keep their quotes under every setting.

A `//# sourceMappingURL=` or `//# sourceURL=` comment in the input is never
copied to the output, whatever `comments` says: it described the input, and the
output gets the engine's own map or none. With `banner: true` the map is shifted
past the banner, so the two options compose.

## Performance

```ts
await deobfuscate(source, {
  performance: {
    maxIterations: 40,     // fixpoint cap; the loop stops on the first quiet round
    timeBudgetMs: 120_000, // return best-effort output after this
    memoize: true,
    verifyOutput: true,    // re-parse the result and report honestly
  },
  signal: controller.signal,
  onProgress: ({ stage, completed }) => console.log(stage, completed),
});
```

Those four are the defaults. `completed` is 0..1 over the whole run and never
decreases: the fixpoint loop revisits its stages, and the fraction folds the
round in rather than restarting with it. A stage the run skips - after an abort,
or past the time budget - is not reported.

`verifyOutput` re-parses the printed code and sets `metadata.stats.verified`;
`metadata.stats.verification` says whether it was `'ok'`, `'invalid'`,
`'too-deep'` (the re-parse ran out of stack, which is not a statement about
the output) or `'skipped'` (the option is off).
A `false` is a diagnostic, not an accusation: it names the dialect and
`sourceType` the output was re-parsed under and says whether the input itself
parsed with error recovery, because that is one of the two ways it happens. No
pass is named - the engine does not bisect to find one.

The time budget and `signal` both cause a graceful early return with
`metadata.stats.truncated === true`, not an exception. You always get whatever
the engine managed to do. The budget is checked at stage boundaries; a stage is
one traversal and cannot be interrupted part-way.

### Measured

Taken on an AMD Ryzen 7 5700X3D / 32 GB / Node 24.15.0 / Windows 11 against one
build. Full method, scaling curve and per-pass profile are in
`docs/PERFORMANCE.md` in the repository; the package itself ships only `dist/`.
Inputs are described by size and by the obfuscator that produced them.

| Input | Preset | Bytes in -> out | Strings | Changes / iters | Time | Peak RSS | Verified |
|---|---|---|---|---|---|---|---|
| 4.1 MB obfuscator.io bundle | `balanced` | 4,149,635 -> 757,931 (-81.7 %) | 35,102 | 259,401 / 6 | 20.7-21.4 s | 1,121-1,128 MiB | yes |
| 470 KB string-array bundle | `balanced` | 470,485 -> 447,985 (-4.8 %) | 0 | 4,213 / 5 | 8.4 s | 412 MiB | yes |
| 470 KB string-array bundle | `aggressive` | 470,485 -> 447,900 (-4.8 %) | 2,203 | 22,118 / 5 | 10.8 s | 414 MiB | yes |
| obfuscator.io, every option on | `balanced` | 14,682 -> 97 | 36 | 932 / 4 | 0.33 s | - | yes |

The 470 KB file appears twice because the presets disagree about it, for the
reason given under **Presets** above: at `balanced` the `Function(_)` refusal
leaves every reference encoded, at `aggressive` the references are inlined and
the table declaration is kept for the same string's sake.

The byte, string and change columns are deterministic and are what a
re-measurement is meant to pin; time and peak RSS are one machine's reading of
one build. Output is deterministic: byte counts, change counts and
decoded-string counts are identical across runs; only wall clock moves. Timings
are a snapshot of an engine under active development. Re-derive rather than
trust them.

Two design decisions carry the performance, both measured rather than assumed:
**one merged traversal per stage** and **batched renaming instead of Babel's
`scope.rename()`**. Both are priced in section 4 of `docs/PERFORMANCE.md`.

**Memory, not time, is the ceiling.** Peak RSS runs at about 700 times the input
size: 9.66 MiB of input peaks at 6.9 GiB. Node needs `--max-old-space-size`
raised past a few MB of input, and the browser build is realistic to roughly
3-4 MB. There is no streaming mode; the whole AST is resident.

Memoisation of decoder results is not measurable on these inputs: call sites
resolve to distinct argument tuples at a ratio of 1.02, so the cache almost never
hits. It stays on as insurance rather than as an optimisation.

### Running off the main thread

For large inputs in a browser, run the engine in a Worker so the tab stays
responsive:

```ts
import { WorkerClient } from '@jsrift/core';

const client = new WorkerClient({
  createWorker: () => new Worker(new URL('jsrift/worker', import.meta.url), { type: 'module' }),
});

const result = await client.run(source, {
  preset: 'balanced',
  onProgress: (p) => setProgress(p.completed),
  signal: abortController.signal,
});
```

One worker is created per run and terminated when the run settles - on success,
on a worker error, on abort, and when `postMessage` itself throws because an
option value cannot be cloned. `run` checks its arguments the way
`deobfuscate` does, before a worker is created: a source that is not a string
or an option outside its type rejects with the same `TypeError`, rather than
crossing to the worker and coming back as a plain `Error` carrying only the
message, and `null` options mean no options. A signal that is already aborted
rejects with an `AbortError` before a worker is created. Termination *is* the
cancellation: `terminate()` discards whatever is still in the message queue,
so there is no cancel message to send and none is sent.

`createWorker` is typed against `WorkerLike` - `postMessage`,
`addEventListener`, `removeEventListener`, `terminate` - rather than the DOM's
`Worker`, so the package compiles in a Node-only project with no DOM lib; a
`worker_threads` adapter that offers those four members works too.

**Bundling for the browser.** `dist/index.js` and `dist/worker.js` need no
`process`, `global`, `require` or `window`, and no `define` in your bundler
config. Babel is bundled into them rather than left as a bare import, because
two of its reads only a shim ever covered: `@babel/types` reads
`process.env.BABEL_TYPES_8_BREAKING` unguarded while it loads, and
`path.evaluate()` looks a callee up as `global.String` - reached from
`clean.dead-branches` whenever a branch test names a binding whose
initialiser is such a call - so under esbuild, Vite or Rollup the first threw
`process is not defined` before anything ran and the second threw `global is
not defined` mid-run and took the pass down with it.
Both are defined away at build time (`tsup.config.ts`). Of Babel's two
logging dependencies, `picocolors` is built in its browser variant, which
reads nothing at load; `debug` is replaced by a stub, because its browser
variant reads `window.process` behind a `typeof window` guard, and a bundler
that folds that guard - Turbopack does, for a graph it believes is
browser-only - leaves a bare read that throws in a Worker, where there is no
`window`. What remains is one `FORCE_COLOR` read behind a `typeof process`
check. `test/api-browser-bundle.test.ts` builds the bundle with the same
settings, asserts it never reads `window`, folds `typeof window` the way
Turbopack does, loads it in a realm with none of those globals and checks the
output against Node's.

## Security

Recovering strings requires knowing what a decoder function computes. `jsrift`
does **not** evaluate your input file to find out.

Instead it slices out the decoder's dependency closure - the declarations it
needs plus any statement that mutates them, typically a few hundred bytes - and
refuses to proceed if that slice references anything outside a small set of pure
built-ins. It then uses the weakest mechanism that works:

1. **`native`** - recognise a known algorithm (plain array, index offset,
   rotation, base64, RC4, XOR) from its AST shape and run the engine's own
   implementation. Nothing is executed.
2. **`interpreter`** - walk the slice with a hand-written interpreter over a
   whitelisted subset, with a step budget so an infinite loop terminates.
   Nothing is executed on the host. There is no realm to escape into.
3. **`sandbox`** - **off by default.** `new Function` in the calling realm with
   host globals shadowed by parameters. There is no isolated realm: shadowing is
   a mitigation, and `constructor.constructor` reopens the real global scope. In
   Node the executed code therefore has process, filesystem and network. Enable
   it deliberately or not at all:

```ts
await deobfuscate(trustedSource, { sandbox: { allowExecution: true } });
```

`SandboxOptions` has three fields: `allowExecution` (default `false`),
`timeoutMs`, the wall-clock cap for a single decoder evaluation (default 5,000),
and `maxSteps`, the cap on AST nodes the interpreter will step through (default
20,000,000). Both caps must be finite.

When two tiers can both decode, they are cross-checked and a disagreement is
recorded as a diagnostic - emitting wrong strings silently is the worst thing
this tool could do.

## Metadata

```ts
const { metadata } = await deobfuscate(source);

metadata.detections   // obfuscator fingerprints with confidence and evidence
metadata.passes       // per-pass change counts, timings and any bailouts
metadata.renames      // every rename: from, to, reason, confidence
metadata.strings      // every decoded string and how often it was used
metadata.diagnostics  // warnings and errors, attributed to the pass that raised them
metadata.stats        // bytes, lines, AST nodes, iterations, timings, verified, verification, truncated
```

A pass that throws is disabled for the remainder of the run and recorded as a
bailout; it never crashes the call and never corrupts the output.

## Documentation

- `docs/ARCHITECTURE.md`: the pipeline, the stages, the fixpoint and the decoder tiers.
- `docs/AUTHORING-PASSES.md`: the contract a pass has to follow.
- `docs/PERFORMANCE.md`: measurements, scaling, limits and how to repeat them.
- `docs/EXAMPLES.md`: inputs and outputs for each preset, dialect and option.

## License

MIT
