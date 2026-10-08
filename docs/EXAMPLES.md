# Examples

Every input and every output on this page was run through the built engine and
copied out. Nothing is hand-written, with one exception: the Worker snippets in
section 9 are sketches of consumer code and are not executable under Node.
Where output is abbreviated it says so.

Inputs are described by size and by the obfuscator that produced them. The
"layered samples" are a one-line program run through `javascript-obfuscator`
one, two, three and four times; the four-layer sample is 5,384 bytes.

---

## 1. Library basics

```ts
import { deobfuscate } from 'jsrift';

const { code, metadata } = await deobfuscate(source);
```

`metadata` is everything the engine learned on the way, returned rather than
discarded:

```ts
metadata.detections   // what was recognised, with evidence and confidence
metadata.passes       // per-pass change counts, timings, bailouts
metadata.renames      // every rename: from, to, reason, confidence
metadata.strings      // every decoded string and how often it was used
metadata.diagnostics  // warnings/errors attributed to the pass that raised them
metadata.stats        // bytes, lines, AST nodes, iterations, timings, verified
```

### `analyze()`: fingerprint without transforming

Parses once and mutates nothing, so it is cheap enough to run while the user is
still typing.

```ts
import { analyze } from 'jsrift';

const { language, sourceType, detections, bytes, lines } = analyze(source);
```

Output for a 470 KB string-array bundle:

```json
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

`bytes` is UTF-8 bytes, the same counter `metadata.stats.inputBytes` uses, so
the two entry points cannot disagree about the size of the same file.

> `analyze()` is a **static fingerprint only**. It runs the detector, not the
> pipeline, so it reports less than a full run does: a full run of the same file
> also reports `string-array` at confidence 1.0 once `strings.discover` has
> resolved the decoder. On a small hand-written sample with no decoder and no hex
> identifiers, `analyze()` correctly returns `detections: []`.

---

## 2. The three presets on one input

Input: the four-layer sample, real `javascript-obfuscator` output (5,384 bytes,
four stacked obfuscation passes). First 300 bytes:

```js
function _0x39ad(){var _0x1817f3=['43932GIlFpA','push','1226SveKZV','285733yikRqn','6500280LqQhjf','200pAPQJh','882kMxgHc','24XgJsBo','162366HBIlOH','8oeRReF','699770jsXiRd','Hello,\x20','log','2412624NpoRDg','3032iipeCa','20321QNTIcC','World','7272221jRWVZJ','897115lGWiej','70Wjqaqn','1563iiLDwL','
```

### `conservative`: 130 bytes

```ts
await deobfuscate(source, { preset: 'conservative' });
```

```js
(function () {
  function _0x249b9b(_0x5deeb0) {
    return 'Hello, ' + _0x5deeb0 + '!';
  }
  console.log('Hello, World!');
})();
```

The strings are decoded, the array machinery that fed them goes with them, and
the decoder call is folded to its value; every one of those is provably
meaning-preserving. No dead-code removal and no renaming run at this preset,
which is why `_0x249b9b` survives even though nothing calls it any more.

### `balanced` (default): 52 bytes

```js
(function () {
  console.log('Hello, World!');
})();
```

### `aggressive`: 52 bytes

Identical to `balanced` on this input. The presets differ where there is
something left to be aggressive about; here `balanced` already stops with
nothing left to change.

| Preset | Bytes | Changes | Iterations | Strings | Verified | Executes as |
|---|---|---|---|---|---|---|
| `conservative` | 130 | 264 | 2 | 69 | yes | `Hello, World!` |
| `balanced` | 52 | 266 | 2 | 69 | yes | `Hello, World!` |
| `aggressive` | 52 | 266 | 2 | 69 | yes | `Hello, World!` |

All three outputs were executed with `node` and all three print `Hello, World!`.

---

## 3. Technique overrides

A preset is a starting point. An explicit `false` always beats the preset, and
an object-form override implicitly enables the technique and tunes it.

All examples below run against the same four-layer sample.

### Turning a technique off

```ts
await deobfuscate(source, {
  preset: 'aggressive',
  techniques: { stringDecoding: false },
});
```

Result: 4,807 bytes, 252 changes, verified. Renaming still runs, so the
machinery becomes *readable* without being removed (abbreviated):

```js
function getStringArray() {
  var items = ['43932GIlFpA', 'push', '1226SveKZV', /* ... 37 more ... */ '185221nyXNyG'];
  getStringArray = function () {
    return items;
  };
  return getStringArray();
}
```

Note `_0x39ad` -> `getStringArray` and `_0x1817f3` -> `items`: the renamer
inferred both from the self-replacing-thunk shape, with string decoding switched
off.

### Tuning a technique (implicitly enabling it)

`conservative` has `variableRenaming` off. Passing an options object turns it on
and configures it in one step:

```ts
await deobfuscate(source, {
  preset: 'conservative',
  techniques: {
    variableRenaming: { minConfidence: 0.3, renameParameters: true },
  },
});
```

Result: 127 bytes, 265 changes, verified:

```js
(function () {
  function toText(_0x5deeb0) {
    return 'Hello, ' + _0x5deeb0 + '!';
  }
  console.log('Hello, World!');
})();
```

`_0x249b9b` -> `toText`, inferred from the function returning a string
concatenation. Compare the `conservative` output in section 2, which left it
alone.

### Disabling one pass, below the technique level

```ts
await deobfuscate(source, { disablePasses: ['simplify.sequences'] });
```

Result: 52 bytes, 265 changes (one fewer than the 266 above), verified.
`listPasses()` names every id.

### Other override shapes

```ts
// Everything aggressive does, minus deletion.
await deobfuscate(source, {
  preset: 'aggressive',
  techniques: { deadCodeRemoval: false },
});

// Caller-supplied naming hints.
await deobfuscate(source, {
  techniques: { variableRenaming: { hints: { _0x4d28ce: 'socket' } } },
});
```

Resolution order is strict: `defaults < preset < techniques{} < disablePasses[]`.

---

## 4. TypeScript

Types must survive; obfuscation must not.

**Input** (`pick.ts`):

```ts
type Role = 'admin' | 'viewer';
interface User { id: number; name: string; role: Role }
const _0x2f1a = ['viewer', 'admin', 'name', 'length'];
function pick<T extends User>(_0x11b: T[], _0x22c: Role): string[] {
  const _0x33d: string[] = [];
  for (let _0x44e = 0x0; _0x44e < _0x11b[_0x2f1a[3]]; _0x44e++) {
    if (_0x11b[_0x44e]['role'] === _0x22c) _0x33d['push'](_0x11b[_0x44e][_0x2f1a[2]]);
  }
  return _0x33d;
}
export default pick;
```

```ts
await deobfuscate(source, { language: 'ts', filename: 'pick.ts' });
```

**Output**, verbatim (371 bytes, 8 changes, verified):

```ts
type Role = 'admin' | 'viewer';
interface User {
  id: number;
  name: string;
  role: Role;
}
function pick<T extends User>(_0x11b: T[], _0x22c: Role): string[] {
  const _0x33d: string[] = [];
  for (let _0x44e = 0; _0x44e < _0x11b.length; _0x44e++) {
    if (_0x11b[_0x44e].role === _0x22c) _0x33d.push(_0x11b[_0x44e].name);
  }
  return _0x33d;
}
export default pick;
```

What happened: the string array is gone entirely; `_0x11b[_0x2f1a[3]]` became
`.length`, `_0x2f1a[2]` became `.name`, `['role']`/`['push']` became dot access,
and `0x0` became `0`. The `type` alias, the `interface`, the generic constraint
`<T extends User>`, the parameter and return annotations and the default export
are all untouched.

The identifiers were **not** renamed, which is the honest result: `balanced`
renaming found no evidence strong enough for these bindings. Pass
`{ preset: 'aggressive' }` to lower the confidence floor.

> Dialect selection matters: `.ts` and `.tsx` are conflicting grammars, not a
> superset relationship. `<string>x` is a type assertion in one and an
> unterminated JSX element in the other. Pass `filename` or `language` to pin it;
> `auto` walks a ladder and keeps the least-featured dialect that parses.

---

## 5. TSX / React

Compiled `jsx-runtime` calls go back to JSX.

**Input** (`List.tsx`):

```tsx
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
interface Props { items: string[]; title: string }
const _0x9c = ['map', 'length'];
export function List({ items, title }: Props) {
  return _jsxs(_Fragment, { children: [
    _jsx("h2", { className: "title", children: title }),
    _jsx("ul", { children: items[_0x9c[0]]((_0x1a: string, _0x2b: number) => _jsx("li", { children: _0x1a }, _0x2b)) }),
    _jsx("span", { children: items[_0x9c[1]] })
  ]});
}
```

```ts
await deobfuscate(source, { language: 'tsx', filename: 'List.tsx' });
```

**Output**, verbatim (357 bytes, 10 changes, verified):

```tsx
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
interface Props {
  items: string[];
  title: string;
}
export function List({
  items,
  title
}: Props) {
  return <><h2 className="title">{title}</h2><ul>{items.map((_0x1a: string, _0x2b: number) => <li key={_0x2b}>{_0x1a}</li>)}</ul><span>{items.length}</span></>;
}
```

`_jsxs(_Fragment, ...)` became `<>...</>`, the third argument of `_jsx` became
`key={_0x2b}`, `items[_0x9c[0]]` became `items.map`, and the `Props` interface
and parameter annotation survived.

The `React.createElement` form is handled too, and the debug arguments a
compiler adds for `jsxDEV` are dropped.

**The import line is a precondition, not decoration.** Delete it and no preset
produces a `finalize.jsx` entry in `metadata.passes`: the `_jsx(...)` calls come
back exactly as they went in, only re-printed, because a call that resolves to
nothing is left alone rather than guessed at. The rest of the file is still
worked on: `_0x9c` is an ordinary string table, so `balanced` reports 5 changes
and 414 bytes with or without the import, and the JSX restoration is the only
thing the import gates.

`aggressive` differs from `balanced` here, in one way: it renames the two arrow
parameters (`_0x1a` -> `item`, `_0x2b` -> `index`), giving 12 changes and 355
bytes against balanced's 10 and 357.

---

## 6. Layered obfuscation

The layered samples are the same one-line program obfuscated 1, 2, 3 and 4
times. The engine does not peel a set number of layers: it loops until a
round changes nothing, capped at `maxIterations` (40). That is weaker than a true
fixpoint, and the gap is measured. A second `deobfuscate()` call over the
finished output of a 360 KB obfuscated bundle still removes 2.5 % more at
`balanced` and 3.9 % at `aggressive`, from a run that stopped on its own at
iteration 4, because two things a later round cannot undo (Babel scope data a
pass invalidated, and the non-repeatable passes dropped after the first round)
need a fresh parse. On these four inputs it converges outright:

| Depth | Input | `conservative` | `balanced` | `aggressive` | Strings | Executes as |
|---|---|---|---|---|---|---|
| 1 | 1,241 B | 130 B | **52 B** | 52 B | 1 | `Hello, World!` |
| 2 | 2,462 B | 130 B | **52 B** | 52 B | 13 | `Hello, World!` |
| 3 | 3,840 B | 130 B | **52 B** | 52 B | 37 | `Hello, World!` |
| 4 | 5,384 B | 130 B | **52 B** | 52 B | 69 | `Hello, World!` |

All twelve outputs re-parsed (`verified: true`) and all twelve were executed
with `node`. Under `balanced` and `aggressive` every depth converges on the
identical program:

```js
(function () {
  console.log('Hello, World!');
})();
```

The four `conservative` outputs are the same 130-byte shape but not the same
bytes: with renaming off, each keeps the obfuscator's own identifier for the
decoder it declines to delete (`_0x454b32`, `_0x2b902a`, `_0x3cec2b`,
`_0x249b9b`).

The number of strings to decode grows with depth (1 -> 13 -> 37 -> 69) while the
output does not change, which is the property worth testing, and
`test/obfuscator-matrix.test.ts` asserts it for an arbitrary number of stacked
layers.

---

## 7. Source maps

```ts
const { code, map } = await deobfuscate(source, {
  filename: 'sample.js',
  output: { sourceMaps: true },     // or 'inline'
});
```

`map` is a standard v3 source map with keys
`version, file, names, sourceRoot, sources, sourcesContent, mappings, ignoreList`.
For the two-layer sample it carries `sources: ["sample.js"]`,
`names: ["console","log"]` and the original obfuscated text in `sourcesContent`,
so a debugger can map the readable output back to the bytes you were given.

`sourceMaps: 'inline'` appends a `//# sourceMappingURL=data:` comment instead.

From the command line:

```bash
jsrift sample.js -o clean.js --source-map
```

Writes `clean.js`:

```js
(function () {
  console.log('Hello, World!');
})();
//# sourceMappingURL=clean.js.map
```

and `clean.js.map` alongside it (2,704 bytes for the two-layer sample).

---

## 8. Command line

The command-line front end is published separately as `jsrift-cli`:

```bash
npm install -g jsrift-cli        # provides the `jsrift` command
jsrift --help
```

### A run with `--stats`

```bash
jsrift sample4.js --stats
```

Code goes to stdout, the report to stderr, so redirection still works. Real
output over the four-layer sample, unabridged:

```
(function () {
  console.log('Hello, World!');
})();
```

```
jsrift · balanced preset · js script · 11/11 techniques on

DETECTIONS
  string-array-rotate      100%  _0x39ad rotated at load
  string-array-wrapper     100%  _0x2bbc (native tier)
  string-array-rotate      100%  _0xc781 rotated at load
  string-array-wrapper     100%  _0x4b9f (native tier)
  string-array-rotate      100%  _0x2f23 rotated at load
  string-array-wrapper     100%  _0x4171 (native tier)
  string-array-rotate      100%  _0x121c rotated at load
  string-array-wrapper     100%  _0x168a (native tier)
  string-array              98%  self-replacing string-array thunk holdi... ×40
  hex-identifiers           97%  65 of 67 distinct identifiers match _0x... ×65
  string-array-rotate       97%  push(shift()) rotation inside an unboun... ×2
  string-array-wrapper      95%  15 decoder aliases resolved from 4 deco... ×15
  ... and 4 more

PASSES 12 of 28 reported work · 69ms in passes
  prepare.normalize-literals      167 changes      6ms ████████████
  strings.inline                   91 changes     29ms ███████
  strings.prune-decoders            4 changes      1ms █
  clean.unused                      1 changes   0.75ms █
  simplify.fold-constants           1 changes   0.56ms █
  simplify.properties               1 changes   0.56ms █
  simplify.sequences                1 changes   0.56ms █

RESULT
  bytes            5,384 →          52  -99.0%
  lines                2 →           3  +50.0%
  changes            266 over 2 iterations · 12 AST nodes
  renames              0 identifiers
  strings             69 decoded
  time              90ms parse 12ms · transform 75ms · generate 2ms
  verified           yes

DIAGNOSTICS
  info    strings.inline  Removed 7 declaration(s) of string-array machiner...
  info    strings.inline  Removed 6 declaration(s) of string-array machiner...
  info    strings.inline  Removed 6 declaration(s) of string-array machiner...
  info    strings.prune-decoders  Removed 4 declaration(s) of string-array machiner...
  info    clean.unused  This is a script, so its top-level declarations a...
  info    clean.unused  This is a script, so its top-level declarations a...
```

The last two diagnostics are the reason a `52`-byte output is not smaller: in a
script, program-scope declarations are the global scope, so `clean.unused` will
not delete one even when nothing in this file reads it. The "12 of 28" count
belongs to the build that produced this report; `jsrift --list-passes` prints
the current total.

### Other modes

```bash
# Fingerprint only; transform nothing.
jsrift sample2.js --analyze
```

```
jsrift --analyze · js script · 2,462 bytes, 2 lines

DETECTIONS
  string-array              98%  self-replacing string-array thunk holdi... ×22
  string-array-rotate       97%  push(shift()) rotation inside an unboun... ×2
  string-array-wrapper      95%  6 decoder aliases resolved from 2 decod... ×6
  hex-identifiers           94%  32 of 34 distinct identifiers match _0x... ×32
```

```bash
# stdin -> stdout, with a preset.
cat sample1.js | jsrift - --preset conservative
```

```js
(function () {
  function _0x454b32(_0x31a11a) {
    return 'Hello, ' + _0x31a11a + '!';
  }
  console.log('Hello, World!');
})();
```

```bash
# Machine-readable metadata. Pair with -o to keep the code too.
jsrift bundle.js --json -o clean.js > report.json

# Which techniques does each preset enable?
jsrift --list-techniques
```

```
TECHNIQUES what you toggle; each maps to one or more passes

                         cons bala aggr
  stringDecoding         on   on   on   decode string arrays, wrapper functions and encoded literals
  variableRenaming       ·    on   on   replace mangled identifiers with inferred, scope-safe names
  controlFlowAnalysis    ·    on   on   recover flattened while/switch state machines
  deadCodeRemoval        ·    on   on   delete unreachable branches, unused bindings and filler
  functionUnwrapping     ·    on   on   inline proxy functions and object alias maps
  literalSimplification  on   on   on   fold constant expressions, !![] and void 0
  propertyNormalization  on   on   on   rewrite obj["prop"] as obj.prop
  antiTamperRemoval      ·    on   on   strip debugger traps, self-defending and console guards
  statementRecovery      ·    on   on   restore statements from comma sequences and ternaries
  moduleUnwrapping       ·    on   on   split webpack/Next.js chunk maps into named modules
  jsxRestoration         ·    on   on   turn _jsx(...) runtime calls back into JSX
```

For inputs over a few MB, raise Node's heap; memory, not time, is the ceiling:

```bash
NODE_OPTIONS=--max-old-space-size=8192 jsrift big-bundle.js -o clean.js --stats
```

---

## 9. Running in a Web Worker

A 4 MB file is about twenty seconds of uninterrupted CPU on the machine in
`PERFORMANCE.md`. On the main thread that is a frozen tab, so the browser path
runs the engine in a Worker.

### Using the built-in client

```ts
import { WorkerClient, workersAvailable } from 'jsrift';

if (!workersAvailable()) throw new Error('No Worker in this environment');

const client = new WorkerClient({
  createWorker: () =>
    new Worker(new URL('jsrift/worker', import.meta.url), { type: 'module' }),
});

const controller = new AbortController();

const result = await client.run(source, {
  preset: 'balanced',
  onProgress: ({ stage, completed }) => setProgress(completed),
  signal: controller.signal,
});
```

`createWorker` is supplied by the caller because worker URL resolution is
bundler-specific. One worker is created per run and terminated when the run
settles.

**Cancellation is the termination, and there is no cancel message.**
`terminate()` discards whatever is still in the worker's message queue, so a
`{ type: 'cancel' }` posted immediately before it can never be read. Aborting the
signal terminates the worker; that is the whole mechanism.

### The tree-shaking hazard

`jsrift/worker` is a side-effect-only module. This package's `package.json`
declares `"sideEffects": ["./dist/worker.js"]` so a bundler will not drop it.
If your toolchain ignores that field, or you are re-exporting the engine
through a package of your own that declares `"sideEffects": false`, write a
one-file worker that imports `deobfuscate` as a *value*, which no tree-shaker
can elide. A minimal one looks like this:

```ts
// deobfuscate.worker.ts
import { deobfuscate, type DeobfuscateOptions } from 'jsrift';

interface Request {
  id: number;
  source: string;
  options?: DeobfuscateOptions;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, source, options } = event.data;
  try {
    const result = await deobfuscate(source, {
      ...options,
      onProgress: (progress) => self.postMessage({ type: 'progress', id, progress }),
    });
    self.postMessage({ type: 'done', id, result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
```

There is no `AbortController` and no `cancel` branch in it, for the reason above:
the owner of the worker terminates it.

Spawn it with the static form both Turbopack and webpack detect, or the worker
will not be emitted as a chunk at all:

```ts
new Worker(new URL('./deobfuscate.worker.ts', import.meta.url), { type: 'module' });
```

> These Worker snippets are not executable under Node, where
> `workersAvailable()` returns `false`.
