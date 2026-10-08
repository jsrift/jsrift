# Performance

Every number on this page was produced on the machine below by running the
engine, not by quoting an earlier document. Where a measurement contradicts a
claim made during design, the measurement wins and the correction is stated
([section 5](#5-claims-that-did-not-survive-measurement)).

> **Snapshot warning.** Wall-clock figures were taken against one build of an
> engine that is under active development, and they have moved by 20-30 % between
> builds within a single day of work. Treat milliseconds as a snapshot and
> re-derive them with [section 7](#7-reproducing). Byte counts, change counts,
> iteration counts and decoded-string counts are deterministic and do not move
> between runs of the same build. The *shapes* (merged-vs-sequential traversal,
> batched renaming, the memory multiplier) are the durable results.

**Measurement machine.** AMD Ryzen 7 5700X3D (8 cores / 16 threads), 32 GB RAM,
Windows 11 (10.0.26200), Node v24.15.0. Engine built with `tsup`
(`dist/index.js`), driven from a Node script that runs one input per process so
peak RSS is attributable to that input alone. `preset: 'balanced'` unless
stated. Peak RSS is `process.resourceUsage().maxRSS` for the whole process, so
it includes Node itself (about a 40 MiB floor). Byte counts are exact; memory
and input sizes are mebibytes.

**Inputs.** Inputs are described by size and by the obfuscator that produced
them. The two large ones are production bundles that are not part of this
repository: a 4.1 MB obfuscator.io bundle with a rotated base64 and RC4 string
decoder, and a 470 KB bundle whose strings sit in a plain indexed string array.
The layered samples are a one-line program run through `javascript-obfuscator`
one, two, three and four times. The max-options case is a small program
obfuscated once with every `javascript-obfuscator` option on.

---

## 1. Inputs

| Input | Preset | Bytes in -> out | Lines in -> out | Reduction | AST nodes (out) | Strings decoded | Changes | Iters | parse / transform / generate (ms) | Total | Peak RSS | Verified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4.1 MB obfuscator.io bundle | `balanced` | 4,149,635 -> 757,931 | 26,139 -> 19,228 | **-81.7 %** | 113,050 | 35,102 | 259,401 | 6 | 362 / 20,188 / 68 | **20.7-21.4 s** | 1,121-1,128 MiB | yes |
| 470 KB string-array bundle | `balanced` | 470,485 -> 447,985 | 10,280 -> 12,940 | -4.8 % | 94,676 | 0 | 4,213 | 5 | 116 / 8,118 / 55 | **8.35 s** | 412 MiB | yes |
| 470 KB string-array bundle | `aggressive` | 470,485 -> 447,900 | 10,280 -> 12,939 | -4.8 % | 74,248 | 2,203 | 22,118 | 5 | 128 / 10,567 / 47 | **10.8 s** | 414 MiB | yes |
| obfuscator.io max options | `balanced` | 14,682 -> **97** | 1 -> 4 | -99.3 % | - | 36 | 932 | 4 | - | **0.33 s** | - | yes |
| obfuscator.io max options | `aggressive` | 14,682 -> **87** | 1 -> 4 | -99.4 % | - | 36 | 933 | 4 | - | **0.20 s** | - | yes |
| layered sample, depth 1 | `balanced` | 1,241 -> 52 | - | -95.8 % | - | 1 | 39 | 2 | - | 90 ms | - | yes |
| layered sample, depth 2 | `balanced` | 2,462 -> 52 | - | -97.9 % | - | 13 | 93 | 2 | - | 120 ms | - | yes |
| layered sample, depth 3 | `balanced` | 3,840 -> 52 | - | -98.6 % | - | 37 | 171 | 2 | - | 138 ms | - | yes |
| layered sample, depth 4 | `balanced` | 5,384 -> 52 | - | -99.0 % | - | 69 | 266 | 2 | - | 157 ms | - | yes |

Notes on the table, all of which matter:

- **The 470 KB bundle is listed twice because the presets disagree about it,
  and that is the most informative row here.** The file makes one
  `Function(_)` call whose argument is a variable the engine cannot read. Code
  compiled from a string compiles in global scope, and in a script that scope
  still sees every top-level name, including `_0xdb56`, the string table. So
  nothing proves the table this engine reads is the table the program reads, and
  `balanced` refuses: all 2,203 strings stay encoded and the 45 KB table stays
  in the output. Both diagnostics name the line: *"Left every reference to
  `_0xdb56` encoded ... The source is `Function(...)` at line 7258, which this
  analysis cannot read."* `aggressive` flips
  `stringDecoding.decodeDespiteStringCode` and inlines the 2,203 strings at
  their call sites, saying so in the other direction, but it keeps the table's
  declaration, because code compiled from that string could still spell
  `_0xdb56`, and deleting a declaration such code can reach would make the
  output throw where the input ran. That is why the rows are 85 bytes apart
  rather than 20 KB: the flag buys literals and renames (1,185 against 222), not
  size. A build that pruned the table here would be unsound.
- **The 4 MB bundle's timing is a range over 3 runs** on this build (20,718 /
  21,221 / 21,362 ms wall). The parse/transform/generate split quoted is from the
  first of them; the other two gave 359 / 20,691 / 67 and 382 / 20,807 / 70.
  Byte, change and decoded-string counts were identical in all three. The row
  read 14.4-14.6 s on an earlier build; the difference is proofs that run per
  candidate per round (declaration order for constant and map inlining, an
  index of every write to a builtin, a trap walk over each decoder's slice), and
  section 5 keeps the earlier history.
- **The 470 KB bundle grows in line count** (10,280 -> 12,940) while
  shrinking in bytes, because the input is minified onto few long lines and the
  output is pretty-printed. Line count is not a quality signal here.
- **The max-options case does not reduce to one statement any more.** Its output
  is `console.log('Hello, World!');` preceded by the `greet` function the call
  was inlined from. The input is a *script*, so `greet` is a global, and
  `clean.unused` will not delete a program-scope declaration in a script: some
  other file may be relying on it. Both outputs execute and print
  `Hello, World!`. The input was produced locally with `javascript-obfuscator`
  v5.6.0 using the exact option set and `seed: 20260904` from
  `test/obfuscator-matrix.test.ts`; its byte size depends on that seed and that
  obfuscator version.
- **All four layered depths converge to the same 52-byte program** under
  `balanced` and `aggressive`, and all four execute and print `Hello, World!`.
  Under `conservative` all four converge to a 130-byte program (the decoded
  call inlined, the decoder function kept and unrenamed) differing from each
  other only in the obfuscator's identifier names. Conservative applies two
  fewer changes at each depth (37 / 91 / 169 / 264).
- **`metadata.stats.astNodes` is the *output* tree, not the input.** It is
  counted after the passes have mutated the tree in place. The 4 MB bundle
  parses to **396,241** nodes and leaves **113,050**, a 3.5x reduction that the
  byte figure alone understates. Every "AST nodes" column here is labelled
  `(out)` for that reason.

---

## 2. Scaling

The ladder is built by a script that concatenates N copies of the 470 KB
bundle, suffixes each copy's `_0x...` identifiers so copies cannot collide, and
wraps each in its own IIFE. Every copy keeps its own string array, so string
discovery and inlining run on all of them and the input grows in *work*
(bindings, decode sites) rather than only in bytes. Each rung is parse-checked
before use. The script is a measurement harness and is not part of this
repository.

Measured at `preset: 'balanced'` with `timeBudgetMs` raised to 900,000:

| Lines | MiB | AST nodes (out) | Strings decoded | Changes | parse ms | transform ms | generate ms | **Total** | Peak RSS | Verified |
|---|---|---|---|---|---|---|---|---|---|---|
| 10,282 | 0.48 | 72,009 | 2,203 | 21,769 | 103 | 5,763 | 51 | **5.98 s** | 409 MiB | yes |
| 51,410 | 2.39 | 360,037 | 11,007 | 108,845 | 310 | 30,652 | 172 | **31.39 s** | 1,615 MiB | yes |
| 205,640 | 9.66 | 1,440,142 | 44,022 | 435,380 | 999 | 121,451 | 580 | **125.45 s** | 6,937 MiB | yes |

The bottom rung does not fit the default 120,000 ms budget; see
[section 6.2](#62-the-default-time-budget-is-a-real-limit).

**Is it linear? Very nearly.**

| | 10k -> 50k | 10k -> 200k |
|---|---|---|
| Input lines | 5.00x | 20.00x |
| AST nodes | 5.00x | 20.00x |
| Changes applied | 5.00x | 20.00x |
| **Total time** | **5.25x** | **20.98x** |
| Peak RSS | 3.95x | 16.96x |

Per-1,000-lines cost: **582 ms -> 611 ms -> 610 ms**. The work grows exactly
linearly (nodes and changes are both exactly 5.00x and 20.00x, which is a good
sign that the ladder is well-formed) and time grows 20.98x against 20.00x of
work: a **1.05x degradation in per-line cost across a 20x size increase**, all of
it incurred between the first and second rung. Parse and generate stay strongly
sub-linear (parse 9.72x, generate 11.42x for 20x input).

Memory grows sub-linearly in ratio but the absolute number is the problem:
**6.9 GiB peak for a 9.66 MiB input**, roughly a 718x multiplier.

### 2.1 A benchmark that used to measure nothing, and now measures more than its source

That IIFE wrapper mattered enormously once, and the story is worth keeping
because it is a general trap.

An earlier build's string-array discovery scanned only the `Program` body
(`analysis/string-array.ts` had a `topLevelUnits(program)` walking
`program.get('body')`). Putting each array inside an IIFE therefore hid it, and
this ladder decoded **0 strings at every rung** while still reporting a
plausible-looking wall clock. It was measuring parse, traversal, scope and
renaming with the entire string pipeline silently skipped. `topLevelUnits` is now
`candidateScopes(program)` and every rung decodes.

The wrapper still changes the answer, but in the opposite direction and for a
different reason. At `balanced` the flat 470 KB bundle decodes **0** strings and
the wrapped copy of the same bytes decodes **2,203**, because the wrapper is what
takes `_0xdb56` out of global scope, and the `Function(_)` refusal in section 1
only applies to names the compiled string could reach. The benchmark is
therefore doing *more* string work per rung than the file it is built from,
which is worth knowing before comparing a rung against section 1.

The lesson generalises: **a synthetic benchmark can quietly stop exercising the
thing it is named after, and can just as quietly start exercising more.** The
guard is to assert on work done (strings decoded, changes applied) and not only
on wall clock.

---

## 3. Per-pass profile, 4 MB bundle

**Attribution caveat, stated first because it changes how the table reads.** The
kernel merges every visitor-shaped pass in a stage into one traversal, then
splits that traversal's elapsed time **equally** across those passes
(`pipeline/kernel.ts`: *"Attribute traversal cost proportionally; per-handler
timing would cost more than it reveals at 400k nodes."*). So a visitor pass's
`durationMs` is its equal share of a shared walk, not exclusive time, which is
why `simplify.fold-constants`, `simplify.properties`, `simplify.discard-wrappers`
and `simplify.sequences` all report exactly 185.7 ms. Run-shaped passes *are*
timed exclusively. Stage sums are exact either way, because the shares add back
up to the traversal.

**Stage totals** (sum = 14,078 ms, reconciling with `transformMs` 14,082 ms):

| Stage | ms | % of transform | Changes | Passes that reported / registered |
|---|---|---|---|---|
| `strings` | 6,734 | **47.8 %** | 80,523 | 5 / 5 |
| `clean` | 2,564 | **18.2 %** | 645 | 4 / 4 |
| `simplify` | 2,007 | **14.3 %** | 31,289 | 6 / 6 |
| `structure` | 1,168 | 8.3 % | 2,627 | 3 / 4 |
| `prepare` | 988 | 7.0 % | 142,791 | 3 / 3 |
| `rename` | 532 | 3.8 % | 1,344 | 1 / 1 |
| `finalize` | 73 | 0.5 % | 184 | 1 / 2 |
| `unpack` | 12 | 0.1 % | 0 | 1 / 3 |

**Individual passes**, slowest first:

| Pass | ms | Changes | Shape |
|---|---|---|---|
| `strings.inline` | 4,437 | 76,913 | run |
| `strings.discover` | 1,253 | 0 | run |
| `clean.unused` | 1,234 | 404 | run |
| `simplify.object-maps` | 819 | 7,023 | run |
| `structure.control-flow` | 581 | 8 | run |
| `rename.identifiers` | 532 | 1,344 | run |
| `clean.anti-tamper` | 479 | 9 | run |
| `clean.dead-branches` | 446 | 232 | visitor |
| `simplify.proxy-functions` | 445 | 0 | run |
| `prepare.fold-numbers` | 436 | 4 | visitor (shared) |
| `prepare.normalize-literals` | 436 | 142,787 | visitor (shared) |
| `clean.injected-code` | 405 | 0 | run |
| `strings.normalize-literals` | 365 | 0 | visitor (shared) |
| `strings.merge-split` | 365 | 3,609 | visitor (shared) |
| `strings.prune-decoders` | 314 | 1 | run |
| `structure.conditionals` | 294 | 2,455 | visitor (shared) |
| `structure.loops` | 294 | 164 | visitor (shared) |
| `simplify.fold-constants` | 186 | 1,823 | visitor (shared) |
| `simplify.properties` | 186 | 20,268 | visitor (shared) |
| `simplify.discard-wrappers` | 186 | 0 | visitor (shared) |
| `simplify.sequences` | 186 | 2,175 | visitor (shared) |
| `prepare.detect` | 115 | 0 | run |
| `finalize.tidy` | 73 | 184 | visitor |
| `unpack.eval-packer` | 12 | 0 | run |

That is 24 of the 28 passes registered in the build measured. The four absent
ones did not run on this input and inventing a row for them would make this
document say something nobody measured: `unpack.function-constructor` and
`unpack.webpack-modules` found no wrapper (`webpack-modules` does appear in some
runs, at 1.2 ms and 0 changes), `structure.register-vm` is gated off in every
preset (`controlFlowAnalysis.registerVm`) and guarded by a raw structural
pre-scan, and `finalize.jsx` needs a `react/jsx-runtime` binding this file does
not have.

**What dominates.** `strings` is 47.8 % of transform time, and `strings.inline`
alone is 31.5 % of it. It does 76,913 of the run's changes, so the cost is at
least proportionate. `strings.discover` is second at 1,253 ms for **zero**
changes, because discovery is analysis: it resolves the decoder, the rotation and
the alias set and hands them to `inline`.

`clean` is the second-largest stage while producing the fewest changes (645):
`clean.unused`, `clean.injected-code` and `clean.anti-tamper` are whole-program
scope queries that re-examine every binding on all 6 iterations regardless of how
little they find. `clean.unused` is 1,234 ms for 404 changes.

Conversely `prepare.normalize-literals` does 142,787 changes, 55 % of all
changes in the run, for 436 ms of shared traversal.

---

## 4. Why it is fast

### 4.1 One merged traversal per stage

Measured by a standalone traversal harness on freshly-built visitor objects
(Babel's `visitors.explode()` mutates a visitor in place and stamps `_exploded`
on it; reusing one silently skips handlers, so every visitor below was built
once and handed to `traverse()` exactly once). Hit counters for merged and
sequential runs were compared and **matched exactly in every case**; without
that check the comparison would be meaningless.

| Input | Passes | Merged (1 walk) | Sequential (N walks) | Speed-up | Hits match |
|---|---|---|---|---|---|
| 4.1 MB bundle | 1 | 275.3 ms | 273.7 ms | 0.99x | yes |
| 4.1 MB bundle | 5 | 342.9 ms | 1,151.2 ms | 3.36x | yes |
| 4.1 MB bundle | **15** | **336.8 ms** | **3,140.4 ms** | **9.32x** | yes, 1,355,180 |
| 470 KB bundle | 15 | 70.5 ms | 663.6 ms | 9.41x | yes |
| 205,640-line ladder | 15 | 1,577.7 ms | 16,469.2 ms | 10.44x | yes |

The number that actually drives the design is the **marginal cost of one more
pass**:

| Input | Merged | Sequential |
|---|---|---|
| 4.1 MB bundle | **+4.39 ms** | +204.76 ms |
| 470 KB bundle | **+2.13 ms** | +44.40 ms |
| 205,640-line ladder | **+34.76 ms** | +1,098.27 ms |

At one pass the merged form is fractionally *slower* on the big input (0.99x):
merging has real overhead. It pays from about the third pass on, and by 15 passes
adding another is 47x cheaper merged. This is what makes a pipeline of thirty
passes affordable.

### 4.2 Batched renaming instead of `scope.rename()`

Babel's `scope.rename()` re-crawls and rewrites from the binding's scope on
every call, so renaming K bindings is O(K x scope size). Measured with a fresh
AST per sample, on the 4.1 MB bundle:

| K renames via `scope.rename()` | Total | Per rename |
|---|---|---|
| 25 | 3,355 ms | 134.2 ms |
| 50 | 10,723 ms | 214.5 ms |
| 100 | 25,749 ms | 257.5 ms |
| 200 | 55,501 ms | 277.5 ms |

The per-rename cost is still *rising* at K=200, so extrapolating the last rate to
all 9,408 bindings, about **43 minutes**, is a lower bound rather than an
estimate. That the cost is not constant is itself the result.

The batched renamer instead does **one collect traversal, then one mutation
sweep**:

| | Bindings | Identifiers rewritten | Collect | Mutate | **Total** |
|---|---|---|---|---|---|
| 4.1 MB bundle | 9,408 | 77,971 | 685.1 ms | 332.1 ms | **1,017.2 ms** |
| 470 KB bundle | 2,277 | 26,378 | 208.2 ms | 98.3 ms | **306.5 ms** |
| 205,640-line ladder | 45,540 | 527,560 | 4,056.8 ms | 1,856.6 ms | **5,913.4 ms** |

Each result was re-printed, re-parsed and re-resolved: valid JavaScript, **0**
original obfuscated names surviving, **0** unresolved references. So: **one
second instead of tens of minutes.** The plan is keyed on binding identity (a
`Map` on the `Binding` object) rather than on name, which is why coverage is
total.

In the real pipeline, `rename.identifiers` on this input costs 471-532 ms and
applies 1,344 renames, far fewer than 9,408, because the engine only renames
where it has evidence.

### 4.3 Fixpoint by change counter

The kernel ends the loop when a full round adds nothing to `ctx.totalChanges`
(`pipeline/kernel.ts`). The counter is already maintained by the passes, so the
check is free, and it is more informative than a boolean: it can name which
passes are still reporting changes, which is how an oscillating pair (A undoes B)
gets found.

The alternative, re-printing the source and hashing it after every round, was
priced rather than assumed. On the 4 MB bundle: print 104-122 ms, SHA-256 3 ms,
so **107-125 ms per check**. At one check per round across 6 iterations that is
about 0.7 s, roughly 5 % of a 14 s transform. Real, but small, and the counter
costs nothing.

### 4.4 What does *not* explain the speed

See [section 5](#5-claims-that-did-not-survive-measurement). Decoder
memoisation, which the design notes credited, is not measurable on these inputs.

---

## 5. Claims that did not survive measurement

Recorded because a performance document that only lists confirmations is not
worth reading.

**"35,789 call sites resolve from far fewer distinct argument tuples, so
memoisation is a large win." - Not supported.**

Measured on the 4 MB bundle: 35,780 decoder call sites resolve to 35,102
distinct references, a ratio of **1.02**. The memo cache keys on the argument
tuple (`analysis/evaluator/index.ts`, `cacheKey(args)`), and obfuscator.io's
index-shift plus per-wrapper key scheme gives almost every call site a unique
tuple. 34,511 of the 35,102 references are used exactly once.

A/B run with `performance.memoize` on and off, twice each:

| memoize | Total | transform | `strings.inline` | Strings | Changes |
|---|---|---|---|---|---|
| on | 16,007 ms | 15,483 ms | 4,913 ms | 35,102 | 259,403 |
| off | 16,012 ms | 15,666 ms | 4,667 ms | 35,102 | 259,403 |
| on | 15,200 ms | 14,855 ms | 4,598 ms | 35,102 | 259,403 |
| off | 15,547 ms | 15,227 ms | 4,488 ms | 35,102 | 259,403 |

There is no signal in the totals: the two conditions are inside each other's
run-to-run spread. The one consistent effect is in the pass the cache lives in:
`strings.inline` is 2-5 % *faster with the cache off*, in both pairs, because the
engine pays to build 35,102 cache entries to save a few hundred lookups.
Memoisation remains correct and stays on as insurance against an input where the
ratio *is* high (distinct *values* number 10,472, so a 3.35x ratio does exist at
the value level and a differently-keyed cache could exploit it) but it does not
explain current performance and should not be cited as if it did.

**"The 4 MB bundle completes in 9.55 s." - Still not reproducible, but the gap
has closed.**

Successive builds have given 12.1-14.4 s, then 17.9-19.0 s, then 14.4-14.6 s,
and now 20.7-21.4 s on this one. Output is byte-identical run to run in every
case. The slowdown in the 17.9-19.0 s build was localised to `strings.inline`
and removed. The rise to 20.7-21.4 s is the price of proofs that run once per
candidate per fixpoint round (declaration order before an inline, the
builtin-write index, the trap walk over a decoder's slice), each added to close
an unsound rewrite that differential fuzzing had found, and each measured when
it landed. The moral is the snapshot warning at the top of this page: this
figure has moved by 40 % between builds and will move again.

**"The 200k-line ladder decodes 0 strings." - Closed, and now overshoots.**

See [section 2.1](#21-a-benchmark-that-used-to-measure-nothing-and-now-measures-more-than-its-source).
Every rung decodes; the wrapped construction now decodes *more* than the flat
file it is built from, at `balanced`.

**"The max-options case reduces to exactly `console.log('Hello, World!');`." -
No longer true, deliberately.**

It reduces to that statement plus the `greet` function it was inlined from. In a
script, program-scope declarations are the global scope, and `clean.unused` will
not delete one. 97 bytes at `balanced`, 87 at `aggressive`, both still printing
`Hello, World!`.

---

## 6. Limits, stated plainly

### 6.1 Memory is the ceiling, not time

Peak RSS is roughly **718x the input size** on the full pipeline: 9.66 MiB in,
6.9 GiB peak. That comes from Babel `Node` objects plus `NodePath` and scope
metadata for 1.44 M nodes.

Consequences:

- **Node** needs `--max-old-space-size` raised well above default for inputs
  past a few MB. The 200k-line runs here used 14 GB of headroom.
- **Browsers cannot do this.** A tab's practical JS heap is about 2-4 GiB (and
  much less on mobile). Extrapolating, the browser build is realistic to roughly
  **3-4 MB of input**, around the size of the 4 MB bundle (1.2 GiB peak,
  comfortable) and nowhere near the 200k-line ladder. There is no streaming or
  chunked mode; the whole AST is resident.
- **The multiplier itself moves.** It was about 766x on the build measured
  before this one, and the 470 KB bundle went 332 MiB -> 818 MiB -> 336 MiB
  across three builds. Memory is not tracked between builds, and it should be.

### 6.2 The default time budget is a real limit

`timeBudgetMs` defaults to 120,000, and the 205,640-line rung lands directly on
it: its transform alone measured 121.5 s and 122.8 s on two runs. The two
outcomes either side of that line are worth stating together, because they are
the same input and the same options:

| Run | `stats.truncated` | Renames applied | Changes | Output bytes |
|---|---|---|---|---|
| budget raised to 900 s (transform 121.5 s) | false | 16,680 | 435,380 | 8,585,499 |
| default budget, run A (wall 128.9 s) | false | 16,680 | 433,800 | 8,636,859 |
| default budget, run B (transform 122.8 s) | **true** | **0** | 417,120 | 7,822,239 |

The budget is checked at stage boundaries. When it runs out inside the fixpoint
loop, the epilogue stages, `rename` and `finalize`, are skipped, and losing
`rename` costs all 16,680 renames at once. `metadata.stats.truncated` reports
this honestly, but a caller that does not check it will not notice that the
output it got is the one without any names in it.

### 6.3 What is slow

- `clean` is 18 % of transform time for 0.25 % of the changes. `clean.unused` is
  the third most expensive pass in the engine at 1,234 ms, and at 3.1 ms per
  change it is the worst rate of any pass that actually rewrites something.
- The string pipeline is where the remaining super-linearity lives:
  `strings.inline` is 33.9 s of the 121.5 s transform at 205,640 lines, against
  4.4 s of 14.1 s on the 4 MB bundle.
- There is **no** per-pass scope opt-out. A no-op `Identifier` traversal of the
  4 MB bundle costs 681-728 ms with scope and 243-266 ms without, for identical
  hit counts (87,805): roughly 450 ms per traversal that a per-pass opt-out
  would save. The passes do not declare whether they need scope.

### 6.4 What the engine refuses to do

- **No execution of the input by default.** A decoder the native and interpreter
  tiers cannot handle is reported as a diagnostic, not run. `sandbox.allowExecution`
  is opt-in, is `new Function` in the calling realm, and is documented as a
  mitigation rather than a security boundary.
- **No output it cannot re-parse.** `verifyOutput` re-parses with error recovery
  *off* and sets `metadata.stats.verified`. Every measurement in this document
  is from a run where that flag came back `true`.

  **What that flag does and does not prove.** It proves the output is
  syntactically valid JavaScript/TypeScript. It does **not** prove the output
  means the same thing as the input, and it does not typecheck: a dangling type
  reference, a renamed-away binding or a wrongly-decoded string all parse
  perfectly well. Behavioural equivalence is asserted separately and much more
  strongly, by `test/obfuscator-matrix.test.ts` actually **executing** the
  original source, the obfuscated form and the engine's output, and requiring
  all three to produce identical results. `verified` is a floor, not the
  guarantee. A `false` has two causes, and the diagnostic distinguishes them:
  the output is genuinely invalid, or the re-parse ran out of stack on a
  legitimately deep tree.
- **No guessing.** A single-element array like `var A = ['reduce']` is left
  alone: it is indistinguishable from ordinary application code, and inlining it
  would be a guess. Decoding requires positive evidence: a decoder body, a
  rotation loop, a wrapper, or index density. The `Function(_)` refusal in
  [section 1](#1-inputs) is the same principle keeping a 45 KB table in the
  output of the 470 KB bundle, and it is priced there rather than hidden.
- **No renaming that changes resolution.** On the 4 MB bundle 165 bindings had
  an inferred name that could not be applied without changing what some
  identifier resolves to. They kept their obfuscated names, and
  `rename.identifiers` says so in a diagnostic.

---

## 7. Reproducing

```bash
npm ci && npm run build
```

Every column in sections 1 and 3 comes from `metadata.passes` and
`metadata.stats` on a `deobfuscate()` result. The command-line front end
(`npm install -g @jsrift/cli`) prints the same data: `--stats` renders the
per-pass table and the result block on stderr, and `--json` emits the whole
metadata object.

```bash
jsrift input.js --stats -o out.js
jsrift input.js --json -o out.js
```

For inputs over about 2 MB, raise Node's heap:

```bash
NODE_OPTIONS=--max-old-space-size=8192 jsrift big-bundle.js --stats -o clean.js
```

The two production bundles in section 1 are not part of this repository, so
those rows can be repeated in shape but not byte for byte; the layered samples
and the max-options case can be rebuilt from `test/obfuscator-matrix.test.ts`
and `test/layered.test.ts`. The harnesses behind sections 2 and 4 are standalone
scripts that are also not part of this repository; the sections describe their
method so that the measurements can be repeated.
