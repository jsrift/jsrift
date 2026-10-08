# Authoring a pass

Every transformation in the engine is a `Pass`. This document is the contract.
Read it before writing one; the kernel makes assumptions that only hold if
passes follow these rules.

## The shape

```ts
import type { Pass } from '../../pipeline/pass.js';

export const foldConstantsPass: Pass = {
  id: 'simplify.fold-constants',
  title: 'Fold constant expressions',
  stage: 'simplify',
  technique: 'literalSimplification',
  visitor: (ctx) => ({ /* Babel visitor */ }),
};
```

`id` is stable and user-visible (`disablePasses: ['simplify.fold-constants']`).
Use `<stage>.<kebab-name>`. Export a single `const` named `<camelName>Pass`.

## Visitor vs run

Pick **`visitor`** whenever the work is node-local. Every visitor in a stage is
exploded and merged into one traversal, so a visitor pass is nearly free to add:
on a 4 MB obfuscator.io bundle, one more shared visitor costs **+4.4 ms** and one
more independent walk costs **+205 ms**. A pass that does its own `traverse()`
pays that full walk (640 ms cold on that file for a visitor that does nothing)
and is not accepted.

Pick **`run`** only when you genuinely need one of:

- a whole-program analysis before any mutation (e.g. counting references),
- control over traversal order,
- `await` (worker dispatch, sandbox evaluation).

`run` passes execute after their stage's merged traversal.

## Rules

1. **Call `ctx.markChanged()` whenever you mutate the tree.** The fixpoint loop
   terminates on "no pass reported a change". A pass that mutates silently causes
   the pipeline to stop early; a pass that reports changes it did not make causes
   it to spin until `maxIterations`.

2. **Never throw for expected conditions.** Returning early is how a pass says
   "not applicable". A thrown error disables the pass for the rest of the run and
   is surfaced to the user as a bailout. Use `ctx.note('warning', ...)` to explain
   a deliberate refusal.

3. **Bail out rather than guess.** If a precondition is not provably met, do
   nothing. Wrong output is far worse than un-deobfuscated output: the user can
   see the second problem and cannot see the first.

4. **Respect scope.** Use `path.scope.getBinding(name)` and check
   `binding.constant` / `binding.references` before inlining or removing. Never
   assume a name resolves to what its nearest declaration suggests.

5. **Preserve `loc`.** Source maps only work because nodes keep their original
   positions. When you replace a node, copy position information across with
   `t.inherits(newNode, oldNode)` (this carries `loc`, comments and leading
   whitespace) rather than constructing a bare node.

6. **Preserve comments.** When deleting a statement that carries
   `leadingComments`, reattach them to the following statement unless the
   `deadCodeRemoval.keepCommented` option says to keep the statement itself.

7. **Guard on TypeScript.** Several transformations are unsound on TS-specific
   nodes. Check `ctx.language` and skip `TSDeclareFunction`, `TSModuleDeclaration`,
   `TSEnumDeclaration`, `TSInterfaceDeclaration` and overload signatures. Never
   delete a "duplicate" function declaration in TS: it is an overload.

8. **Guard on JSX.** A `JSXIdentifier` is not an `Identifier`. Component names
   must stay PascalCase or they stop being components.

9. **Be idempotent.** A pass runs multiple times inside the fixpoint loop. Running
   it on its own output must be a no-op, otherwise the loop never terminates.

10. **Respect the budget.** Long `run` passes should poll `ctx.isExhausted()` in
    their outer loop and return early when it is true.

## Reporting

- `ctx.report(kind, evidence, confidence, count)` records an obfuscator
  fingerprint for the metadata and the UI.
- `ctx.note(severity, message, loc)` records a diagnostic.
- `ctx.renames.push(...)` records a rename so the user can audit it.
- `ctx.shared` is a `Map` for handing analysis to a later stage. Namespace your
  keys with the pass id.

## Testing

Tests live flat in `test/`, one file per pass or per hazard the pass has to
survive (`clean.test.ts`, `dispatcher-order-array-hazards.test.ts`). A new pass
needs, at minimum:

- a positive case proving the transformation happens,
- a **negative case proving it does not fire** when a precondition fails,
- an idempotence check (running twice equals running once),
- a scope-safety case where a naive implementation would capture a binding.

`test/helpers.ts` has what those need: `runPass` runs a single pass in isolation
so a failure points at one pass rather than the whole pipeline, and
`expectIdempotent`, `expectNoChange`, `expectEquivalent` and `assertParses` are
the four assertions above.
