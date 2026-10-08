# Architecture

One engine, several front ends. This package contains every line of
deobfuscation logic. The command-line tool and the web app at
https://jsrift.github.io are thin shells over the same `deobfuscate()` call.
Nothing is reimplemented per surface, so a change in a pass lands everywhere at
once.

```
  command-line tool ---------+
                             |     +---------------------------+
                             +---->|  jsrift                   |
                                   |  deobfuscate(src, opts)   |
  web app (Web Worker) ----------->|                           |
                                   +---------------------------+
```

## The pipeline

Source text becomes an AST once, is rewritten in place by a series of passes,
and is printed once. There is no intermediate re-parsing and no string
manipulation of code anywhere in the engine.

```
  source
    |
    v
  parse ------------- frontend/language.ts   dialect detection ladder
    |
    v
  +-------------------------------------------------------+
  | prepare   fingerprint the obfuscator, normalise        |
  | unpack    reveal source behind packers and bundlers    |
  | +---------------------------------------------------+  |
  | | strings    discover decoders, inline every literal|  |
  | | simplify   fold constants, inline proxies         |  |  repeated to a
  | | structure  rebuild real control flow              |  |  fixpoint
  | | clean      delete injected and dead code          |  |
  | +---------------------------------------------------+  |
  | rename    assign inferred, scope-safe names            |
  | finalize  last-mile readability                        |
  +-------------------------------------------------------+
    |
    v
  print ------------- frontend/print.ts     code + source map + comments
    |
    v
  verify ------------ re-parse the output; report honestly if it failed
```

### Why stages

The order encodes hard dependencies. You cannot infer that a variable holds a
canvas until the string `'getContext'` has been decoded, and you cannot decode
that string until an `eval` packer has been unwrapped to expose it. Stages make
those dependencies explicit instead of implicit in a pass list.

### Why a fixpoint over four of them

`simplify`, `structure` and `clean` feed each other. Unflattening a dispatcher
exposes constant branches; folding those exposes dead bindings; deleting dead
bindings can expose another dispatcher. Running them once leaves work on the
table. They repeat as a block until no pass reports a change, capped by
`performance.maxIterations` and the wall-clock budget, so termination is
guaranteed by three independent conditions rather than by hope.

`strings` is in that loop for a specific reason: **obfuscation stacks**. Feeding
a file through obfuscator.io repeatedly produces one string table per layer, and
each table's *contents* are calls into the layer beneath it:

```js
// the outer table's elements are not literals - they are decoder calls
function _0x121c() { var t = [_0x4171(0x1db), '7272221jRWVZJ', _0x4171(0x1e2), ...]; ... }
```

A single pass can only peel the layer whose table is currently made of literals.
Decoding it turns the next table into literals, which makes *that* layer
discoverable, and so on. Putting `strings` in the fixpoint means depth is not a
parameter anyone has to configure: the loop runs until no decoder is left,
whether the input was obfuscated once or ten times.

The layered test set (the same program obfuscated one, two, three and four
times) is the test for this, and its oracle is execution rather than structure:
whatever the engine emits must still print `Hello, World!`. That catches output
which looks plausible but decoded to the wrong strings, a failure mode no
structural assertion detects.

### One traversal per stage, not one per pass

This is the single most important performance decision in the codebase.

A full `@babel/traverse` walk of a 4 MB obfuscator.io bundle (396,241 nodes)
costs 640 ms cold and 189 ms warm for a visitor that does nothing, against
128 ms for a raw recursive walk with no `NodePath` and no scope. Fifteen such
passes run sequentially cost 3,140 ms; merged into one walk they cost 337 ms, and
a fixpoint loop multiplies whichever of those you picked.

So every visitor-shaped pass in a stage is exploded (resolving Babel's node
aliases and shorthand) and merged into a single visitor object, and the tree is
walked once per stage regardless of how many passes are registered. Adding a pass
is close to free.

Passes that genuinely cannot be expressed as a visitor - those needing a global
analysis first, control over traversal order, or `await` - declare `run` instead
and execute after their stage's merged traversal. Those are the expensive ones:
on the 4 MB bundle the seven slowest passes are all `run` passes, and the
marginal cost of one more shared visitor is 4.4 ms against 205 ms for one more
walk.

## Failure isolation

Every handler is wrapped. The first throw from a pass disables that pass for the
remainder of the run and records a bailout in the report; it never propagates. A
deobfuscator that crashes on unusual input is useless, and one that silently
emits broken code is worse, so failure degrades output quality visibly rather
than corrupting it invisibly.

The backstop is `performance.verifyOutput`: the printed code is re-parsed, and
`metadata.stats.verified` reports the result. The command-line tool and the web
app both surface a failed verification prominently rather than hiding it.

## Evaluating decoders without executing the file

Obfuscated code hides its strings behind a decoder function that has to be run to
recover them. The naive approach is to `eval()` the whole input. That executes
hostile code with full DOM access in the user's browser, and forces a pile of
workarounds to stop unrelated parts of the file from throwing along the way.

This engine does two things differently.

**Slice first.** `analysis/slice.ts` computes the dependency closure of the
decoder: the statements that declare it, everything those transitively
reference, and any top-level statement that *mutates* a name in the closure. That
last category is not optional: obfuscator.io's rotation IIFE declares nothing
and is pure side effect, but the string array is in the wrong order without it.
The result is typically a few hundred bytes out of a multi-megabyte file, with no
DOM access and no user code. If the slice has any free reference outside a small
set of pure built-ins, it is rejected rather than evaluated.

**Then use the weakest tool that works**, in this order:

| Tier | Mechanism | Executes attacker code? | Default |
|---|---|---|---|
| `native` | Recognise a known algorithm (plain array, index offset, rotation, base64, RC4, XOR) from its AST shape and run the engine's own implementation | No | on |
| `interpreter` | Walk the slice with a hand-written interpreter over a whitelisted subset, with a step budget | No | on |
| `sandbox` | `new Function` with host globals shadowed | **Yes** | **off** |

Recognition in the `native` tier is driven by structure, never by identifier
names, because obfuscators randomise names on every run.

The `sandbox` tier is off by default and requires `sandbox.allowExecution`. It is
labelled as a mitigation rather than a boundary: shadowing globals does not stop
`constructor.constructor` from reopening the real global scope. A sandboxed
iframe is stronger, but it cannot be created inside a Worker, which would drag a
multi-megabyte job back onto the UI thread, and it has its own escape history.
The interpreter has nothing to escape from, which is why it, not the sandbox, is
the workhorse.

When more than one tier can decode, they are cross-checked against a sample of
call sites and a disagreement is recorded as a diagnostic. Silently emitting
wrong strings is the worst failure this tool can have.

## Presets and overrides

A preset picks a default set of technique flags; per-technique overrides are
layered on top, and an explicit `false` always wins.

```
defaults  <  preset  <  techniques{} overrides  <  disablePasses[]
```

That precedence is what makes "everything aggressive does, minus dead-code
removal" expressible in one object, and it is mirrored exactly in the web app:
choosing a preset sets the switches, and flipping a switch marks the profile as
customised rather than silently drifting from the preset.

The dividing line between presets is *provability*. `conservative` enables only
transformations guaranteed to preserve semantics. `balanced` adds heuristics that
hold for all mainstream obfuscators. `aggressive` will restructure code it cannot
prove equivalent, the right trade when the consumer is a human reader.

## Parallelism, honestly

An AST is a shared mutable graph. It does not shard, and pretending otherwise
would produce a fast tool that returns wrong answers.

What is actually parallel is one thing: **the whole engine runs off the calling
thread.** The browser's most valuable form of parallelism here is keeping the UI
responsive while a 4 MB file is processed, and `parallel/worker.ts` plus
`WorkerClient` do exactly that, with progress events and cancellation by
termination.

Nothing inside a run is concurrent, and there is no option that pretends
otherwise. The pass pipeline over a single module cannot be: the tree is shared
and mutable. Decoding call sites is embarrassingly parallel in principle but takes
milliseconds in practice, so the win would be lost in message-passing overhead,
and the memoisation that would be the right answer there is
[measurably not one either](PERFORMANCE.md#5-claims-that-did-not-survive-measurement).
The one case that could be split is a bundle's independent module subtrees
(`passes/unpack/webpack-modules.ts` notes it); it is not split today.

## Source maps, comments and metadata

Passes mutate nodes in place and carry position information across replacements,
so `@babel/generator` can emit a source map back to the original obfuscated
input. Comments are attached at parse time and preserved through printing.

Everything the engine learned is returned rather than discarded: which obfuscator
was detected and with what confidence, per-pass change counts and timings, every
rename with the evidence that justified it, every decoded string, and every
diagnostic. That metadata is what the command-line `--stats` report and the web
app's results panel render, and it is what makes the output auditable instead of
magic.

## Source layout

```
src/
  index.ts                    public entry: deobfuscate(), analyze()
  types.ts                    the entire public type surface
  config/presets.ts           presets, overrides, resolution
  config/validate.ts          run-time type checks on every option
  frontend/language.ts        dialect detection ladder, parser config
  frontend/print.ts           printing, source maps, comments
  pipeline/pass.ts            Pass interface, stage order, fixpoint set
  pipeline/context.ts         shared state passes read and write
  pipeline/kernel.ts          stage runner, visitor merging, isolation
  passes/<stage>/*.ts         one file per transformation
  passes/registry.ts          the ordered pass list
  analysis/slice.ts           decoder dependency closure
  analysis/evaluator/*        native / interpreter / sandbox tiers
  analysis/detect.ts          obfuscator fingerprinting
  naming/*                    evidence collection, scoring, safe allocation
  parallel/*                  worker protocol, worker entry, client
  util/ast.ts                 shared AST helpers
test/                         one file per pass or per hazard; helpers.ts
build/debug-stub.cjs          replaces Babel's `debug` dependency in the bundle
```

The command-line tool and the web app are maintained in their own repositories
and contain no deobfuscation logic.
