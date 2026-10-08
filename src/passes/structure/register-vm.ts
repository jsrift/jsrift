import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  looksLikeRegisterVm,
  readRegisterVm,
  resolvesToSumReducer,
  scanCaseJumps,
  type RegisterVm,
} from '../../analysis/dispatcher.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import {
  type Ancestry,
  type BlockFunctionMemo,
  isPureContext,
  isVarScopedFunctionDeclaration,
  TreeOrder,
} from '../../util/ast.js';
import { resolveNumericVector } from '../simplify/fold-constants.js';
import { REGISTER_VM_EVIDENCE, withdrawRefusal } from './refusals.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

type LoopPath = NodePath<t.WhileStatement | t.ForStatement>;

/** A concrete register file. Every value in it is a number, or the trace stops. */
type Registers = number[];

/**
 * Linearise a sum-of-registers VM whose entry vector is statically known.
 *
 * The machine `analysis/dispatcher.ts` describes has no order array to read:
 * its state is the sum of a register vector, its case labels are register reads,
 * and each case moves the sum by adding register-dependent deltas. There is no
 * static jump table to recover - and yet the machine is recoverable, because
 * the register system is closed over integers. Every write has the form
 * `R[k] op= <registers and numeric literals>`, nothing else in the program can
 * reach `R`, and the vector it starts from is written out at the call sites.
 * Once the *values* are known the labels evaluate, the successor is exact, and
 * the run is a tree of straight lines.
 *
 * So this pass interprets a register file. It does not interpret the program:
 * every statement of every visited block is emitted **verbatim**, calls and all,
 * and only the register arithmetic is evaluated. What is needed for that is
 * smaller than `analysis/evaluator/` by an order of magnitude - integer
 * arithmetic over a local array, no strings, no globals, no closures, no
 * property access beyond a register index - and it must not *execute* the calls
 * this pass is careful to leave untouched. The one place a real evaluator is
 * needed is the entry vector, which is a constant-folding question rather than
 * a register one, and that is delegated to `simplify/fold-constants`.
 *
 * Four things make the recovery exact rather than plausible:
 *
 * - **The index is a value, not a name.** `R[R[65] - 183]` is as decidable as
 *   `R[8]` once the vector is known, and 49 of the fixture's 51 tier-1 machines
 *   *read* through one. Not one of the 51 *writes* through one: counted over
 *   the hosts' own bodies, all 7,411 writes to the register file are indexed by
 *   a literal, against 187 register-valued reads out of 29,093. So the rule is
 *   what makes the labels and the deltas *evaluate*, not what makes the writes
 *   land. What is refused is an index that is *not* a function of the register
 *   file - `R.length`, `R[K[4]]`, `R[k]` - because that is where a string key
 *   or a resize could hide.
 * - **A guard nobody can decide forks.** Both successors are explored and both
 *   are emitted, under the original test, which is sound here for a reason that
 *   is checked rather than assumed: `noGuardWritesARegister` refuses any
 *   dispatcher in which an `if` test writes a register, so the two successors
 *   are reached with the same vector the test was evaluated against.
 * - **Falling off the end of a case body means the next case body**, not a
 *   return to the loop head; that is why the walk below carries the successor
 *   block rather than stopping. Modelling it the other way round is a silent
 *   wrong answer rather than a refusal.
 * - **A write is a position, and a reach is a scope.** The two claims in the
 *   paragraph above - that every write has the form `R[k] op= ...` and that
 *   nothing else can reach `R` - are the ones everything else rests on, and
 *   neither survives being enforced by shape: `delete R[1]`, `[R[1]] = xs` and
 *   `for (R[1] of xs)` are none of the two node types a write scan knows, and
 *   `eval('r[0] = 50')` mentions no register at all, so each reads as "no write"
 *   and the trace carries a stale vector into the next dispatch. Writes are
 *   therefore decided by position, through the same `isPureContext` that keeps
 *   the constant table honest, and reaches by scope, with direct `eval` refused
 *   wherever the walk relies on having seen everything.
 *
 * WHAT IT RECOVERS, measured on obfuscated4.js rather than assumed: 38 of the
 * 67 recognised machines, which is every tier-1 dispatcher whose name binds to
 * it and whose call sites agree on a vector. The 29 left standing are the four
 * refusal groups below - 16 + 8 + 3 + 2 - and nothing else; there is no residue
 * of machines refused for a reason nobody looked into. (The last two bullets
 * are limits on what a *recovered* machine amounts to, not groups of refusals.)
 *
 * THAT THOSE 38 ARE RECOVERED *CORRECTLY* is checked by running them, not by
 * reading them: `test/register-vm-equivalence.test.ts` lifts 37 of them out of
 * the fixture - the 38th leaves through an opaque statement the lifter will not
 * rewrite - and executes each before and after linearisation under `node:vm`,
 * over all 72 assignments of their undecidable guards, comparing which
 * statements ran, in what order (761 observations), and what came back. It is
 * sabotage-checked: taking the wrong arm of a decided `if`, and emitting only
 * the consequent of a fork, both fail it with a statement-order diff naming the
 * machine.
 *
 * WHAT IT DOES NOT RECOVER:
 *
 * - *Tier-2 dispatchers* - 16 of the 67 recognised loops - whose register file
 *   is not a parameter but a heap path like `o.a.b[k(r[49] + 863818, ...)][k(...)]`,
 *   with property names computed at run time from register values and the array
 *   itself arriving through a destructuring whose LHS path is computed too.
 *   That needs a heap model with computed string keys, interprocedural
 *   propagation of a destructured parameter, and a fixpoint over a dispatch
 *   expression that re-resolves which array it is dispatching on every
 *   iteration. That is a heap-aware interprocedural partial evaluator, not this
 *   pass.
 * - *Dispatchers reached with more than one entry vector.* Eight of the
 *   fixture's tier-1 machines are, one of them from 19 call sites with 19
 *   different vectors. Each vector is a different program and the function body
 *   can only be one of them; specialising by cloning the host per call site is
 *   sound in principle and is refused here because there is no equivalence
 *   evidence for it and it multiplies the output.
 * - *Dispatchers whose host is a function expression* - three of them - where
 *   there is no declaration binding to read the call sites off. A declaration
 *   written inside a block or a `switch` case is refused with them, and for the
 *   same reason rather than a related one: Annex B.3.3 var-hoists its name out
 *   of the block in sloppy mode, so the binding Babel reports is not an
 *   enumeration of the call sites either. That one is measured at 0 of the
 *   fixture's 51 tier-1 hosts.
 * - *Hosts that mention `arguments`* - two of them. `arguments[0]` **is** the
 *   register file in `function vm(r) { ... }`, so a write through it moves a
 *   register in a function that never spells `r`. See `mentionsArguments`.
 * - *The constant-delta shortcut.* Nothing about the deltas is static: measured
 *   over the fixture, zero of 985 (block, path) pairs have a compile-time
 *   constant sum delta and zero of 51 dispatchers have a delta read-set disjoint
 *   from their write-set. Labels self-modify too - `case r[61] + 323:` sits in a
 *   loop that writes `r[61]` ten times. This works because the register
 *   *values* are recoverable, not because any delta is.
 * - *Blocks the entry vector cannot reach.* They are dropped, which is correct
 * - the trace is complete, so nothing else can reach them either - but it
 *   means a recovered dispatcher is not a fully recovered one. Across the 38,
 *   172 of 383 case bodies are reached: the other 211 are proven dead from the
 *   single vector the machine is entered with, and are deleted rather than
 *   recovered. The report names both numbers so that this reads as the partial
 *   result it is.
 */
export const unflattenRegisterVmPass: Pass = {
  id: 'structure.register-vm',
  title: 'Linearise register-VM dispatchers',
  stage: 'structure',
  technique: 'controlFlowAnalysis',
  run: (ctx) => {
    const options = ctx.config.techniqueOptions.controlFlowAnalysis;
    if (!options.registerVm) return;
    if (!containsRegisterVmShape(ctx.ast)) return;

    const candidates = collectCandidates(ctx);
    // Deepest first, so a dispatcher nested inside a case body is linearised
    // before its parent moves that body.
    candidates.sort((a, b) => b.depth - a.depth);

    // The entry vector's proof places names by the tree's order, and every
    // linearisation below re-orders a stretch of it: numbered again after
    // each, on the next machine's first question.
    const order = new TreeOrder(ctx.ast);
    for (const { path, vm } of candidates) {
      if (ctx.isExhausted()) return;
      if (path.removed) continue;
      if (recover(path, vm, ctx, options.maxRegisterVmStates, order)) order.invalidate();
    }
  },
};

interface Candidate {
  path: LoopPath;
  vm: RegisterVm;
  depth: number;
}

/**
 * One traversal, and only for files that hold the shape. This pass re-runs on
 * every fixpoint iteration, so a raw structural pre-scan - several times
 * cheaper than a Babel traversal - decides whether the traversal is worth
 * paying for.
 */
function collectCandidates(ctx: PassContext): Candidate[] {
  const candidates: Candidate[] = [];
  // One memo for the traversal: nothing below adds a declaration.
  const blockFunctions: BlockFunctionMemo = new Map();
  const visit = (path: LoopPath): void => {
    const vm = readRegisterVm(path.node);
    if (!vm || !resolvesToSumReducer(path, vm.keyName, blockFunctions)) return;
    candidates.push({ path, vm, depth: path.getAncestry().length });
  };
  traverse(ctx.ast, { WhileStatement: visit, ForStatement: visit });
  return candidates;
}

function containsRegisterVmShape(root: t.Node): boolean {
  let found = false;
  walk(root, (node) => {
    if (found) return false;
    if (!t.isWhileStatement(node) && !t.isForStatement(node)) return true;
    if (looksLikeRegisterVm(node)) found = true;
    return true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

interface Block {
  /** The statements the case runs, exactly as written; jumps are not stripped. */
  body: t.Statement[];
  /**
   * The block a body that runs off its end falls into, or `undefined` for the
   * last one - which leaves the switch and so returns to the loop head.
   */
  next: number | undefined;
  /** Legality of splicing this body out, computed on first visit. */
  legality?: string | undefined;
}

interface Machine {
  /** The register file's name, proven above to be parameter 0 of the host. */
  registerName: string;
  /** Case labels in source order, each naming the block it selects. */
  labels: Array<{ test: t.Expression; block: number }>;
  blocks: Block[];
}

/**
 * What the analysis concluded about one candidate loop: the statements the
 * machine runs, or the reason this pass will not linearise it.
 *
 * The reason travels because `structure.control-flow` is what reports the
 * refusal, and a refusal reported with a reason nobody checked is worse than
 * no reason at all - it sends a reader to look at the entry vector when the
 * actual objection was three gates earlier and the vector was never read.
 */
type Recovery =
  | {
      ok: true;
      registerName: string;
      /** Case bodies the trace reached, and how many the machine has. */
      reached: number;
      blocks: number;
      statements: t.Statement[];
    }
  | { ok: false; reason: string };

function refuse(reason: string): Recovery {
  return { ok: false, reason };
}

/**
 * Every gate this pass applies, in the order it applies them.
 *
 * Shared with the reporting in `structure.control-flow` so that the reason it
 * prints is the gate that actually fired rather than a guess about which one
 * usually does.
 */
function analyse(loop: LoopPath, vm: RegisterVm, maxStates: number, order?: TreeOrder): Recovery {
  const host = loop.getFunctionParent();
  if (!host) return refuse('the dispatcher loop is not inside a function');
  // Asked first because it is the tier-1 / tier-2 split, and a tier-2 machine
  // usually trips two or three of the gates below as well - reporting one of
  // *those* would send a reader after a heap path's parentheses when the
  // objection is the heap path.
  const registerName = registerFileName(host.node, vm);
  if (!registerName) {
    return refuse('the register file is a heap path rather than parameter 0 of the enclosing function');
  }
  // The loop must be a direct statement of the host body. Anywhere else and the
  // machine can be re-entered with a register file this analysis never saw.
  if (loop.parentPath.node !== host.node.body) {
    return refuse('the loop is not a direct statement of the function that owns it');
  }
  // A `for` head runs code the trace has nowhere to put: `init` before the
  // first dispatch and `update` after every block, both able to write the very
  // registers the switch key is a sum of. Ignoring them - which is what reading
  // only `test` amounts to - traces a machine that starts in a state it is
  // never in and advances by a step it never takes.
  if (t.isForStatement(loop.node) && (loop.node.init || loop.node.update)) {
    return refuse('its `for` head carries an initialiser or an update that the trace cannot model');
  }
  // A halt condition that is itself a register read moves as the trace runs;
  // knowing when the machine has finished is not optional.
  const exitSum = vm.exitSum;
  if (exitSum === undefined) {
    return refuse('the halt condition compares against a register read rather than a literal sum');
  }
  const unsafe = unsafeRegisterUse(host, registerName, vm.keyName);
  if (unsafe) return refuse(unsafe);

  // Forking is what makes an undecidable guard survivable, and it is sound only
  // while no guard moves the register file. Checked, not assumed.
  if (!noGuardWritesARegister(vm.switchNode, registerName)) {
    return refuse(
      'an `if` test inside the dispatcher writes a register, so its two successors do not ' +
        'start from the vector the test was evaluated against',
    );
  }

  const machine = readMachine(vm, registerName);
  if (!machine) {
    return refuse('the switch has a `default`, which absorbs every state the trace did not predict');
  }

  const entry = entryVector(host, order);
  if (typeof entry === 'string') return refuse(entry);

  const prelude = applyPrelude(host.node, loop.node, entry, registerName);
  if (prelude) return refuse(prelude);

  const trace = new Trace(machine, exitSum, maxStates);
  const statements = trace.from(entry, new Set());
  if (!statements) return refuse(trace.reason ?? 'the trace stopped short of the halt sum');

  return {
    ok: true,
    registerName,
    reached: trace.reached.size,
    blocks: machine.blocks.length,
    statements,
  };
}

/**
 * Why this pass will not linearise `loop`, or `undefined` when it would.
 *
 * Exported for `structure.control-flow`, which names every register VM left
 * standing and must print the gate that actually fired rather than a guess.
 *
 * `undefined` means no gate objects - and, on a loop that is still standing
 * when `structure.control-flow` asks, that is not good news. This pass runs
 * *before* that one inside the stage (see `passes/registry.ts`,
 * "Recovery before reporting"), so a loop it had no objection to is a loop it
 * never reached: the pass was disabled by name, or the time budget ran out
 * partway through the candidate list. Measured with recovery forced on over
 * obfuscated4.js, that happens 0 times in a healthy run - all 38 recoverable
 * machines are gone before the reporting pass looks.
 */
export function describeRegisterVmRefusal(
  loop: LoopPath,
  vm: RegisterVm,
  maxStates: number,
  order?: TreeOrder,
): string | undefined {
  const result = analyse(loop, vm, maxStates, order);
  return result.ok ? undefined : result.reason;
}

/** Whether the machine was linearised, which is the tree re-ordered. */
function recover(
  loop: LoopPath,
  vm: RegisterVm,
  ctx: PassContext,
  maxStates: number,
  order: TreeOrder,
): boolean {
  const result = analyse(loop, vm, maxStates, order);
  if (!result.ok) return false;

  // A refusal from `structure.control-flow` in an earlier round described this
  // exact loop; leaving it standing would report a recovered dispatcher as one
  // the engine gave up on.
  withdrawRefusal(ctx, loop.node, REGISTER_VM_EVIDENCE);
  // "of N blocks" rather than "over N blocks": a machine whose entry vector
  // reaches 8 of its 12 case bodies has had the other four proven unreachable
  // and dropped, and a report that hid that would read as a full recovery.
  ctx.report(
    'control-flow-flattening',
    `register VM over ${result.reached} of ${result.blocks} blocks, ` +
      `${vm.keyName}(${result.registerName})`,
    1,
    1,
  );
  linearise(loop, result.statements, ctx);
  return true;
}

/**
 * Apply the register writes of everything the host runs before it reaches the
 * dispatcher, moving the entry vector to the state the machine actually starts
 * in.
 *
 * The loop is a direct statement of the host body but need not be its first
 * one. `function vm(r) { r[0] += 10; while (sum(r) !== ...) }` starts from a
 * vector no call site ever wrote, and tracing from the raw call vector
 * linearises a run the machine never makes - while still emitting the write it
 * ignored, so the wrong output carries the evidence against itself. Those
 * statements stay exactly where they are; only their effect on the vector is
 * applied here, and a write this walk cannot order refuses the whole machine.
 *
 * Returns the reason it refused, or `undefined` when the vector now holds the
 * state the machine really starts in. The reason travels because the prelude
 * refuses for two unrelated things - a write it cannot order, and a statement it
 * cannot prove inert - and one message covering both would name the wrong one
 * half the time.
 */
function applyPrelude(
  host: t.Function,
  loop: t.Statement,
  registers: Registers,
  registerName: string,
): string | undefined {
  if (!t.isBlockStatement(host.body)) return "the dispatcher's host has no block body to read a prelude from";
  const index = host.body.body.indexOf(loop);
  if (index < 0) return 'the dispatcher loop is not a statement of its own host body';
  return applyStatements(host.body.body.slice(0, index), registers, registerName);
}

/**
 * Walk a statement list applying its register writes, with no forking and no
 * jumps: the prelude runs once, before the machine starts, and a branch there
 * that this walk cannot decide leaves the entry state unknown.
 *
 * Passing over a statement is a claim that it cannot move the register file, and
 * "it holds no visible write" is not that claim - it is the same assumption
 * under which `delete R[i]`, a destructuring target and a for-in/of head read as
 * no write at all, one level up. So each statement has to be positively
 * accounted for, and there are exactly two ways to do it: the walk applies it,
 * or it is proven inert.
 *
 * Inertness rests on one thing this pass has already proved and one it checks
 * here. `unsafeRegisterUse` has established that the array never escapes - no
 * bare `R` is passed anywhere, no closure reads it, `arguments` does not appear
 * - so an opaque call in the prelude has no way to reach it, and neither does a
 * getter, a proxy or an indirect `eval`, which runs in the global scope. Direct
 * `eval` is the exception, because it is handed the scope rather than a value:
 * `eval('r[0] = 50')` writes a register in a statement whose only mention of `r`
 * is inside a string literal. That is what is checked here, and it is checked
 * over every statement including the ones the walk goes on to apply.
 */
function applyStatements(
  statements: readonly t.Statement[],
  registers: Registers,
  registerName: string,
): string | undefined {
  for (const statement of statements) {
    if (containsDirectEval(statement)) {
      return 'a statement before the loop calls `eval`, which can write the register file without naming it';
    }
    if (!containsRegisterWrite(statement, registerName)) continue;

    if (t.isBlockStatement(statement)) {
      const reason = applyStatements(statement.body, registers, registerName);
      if (reason) return reason;
      continue;
    }
    if (t.isExpressionStatement(statement)) {
      if (!applyExpression(statement.expression, registers, registerName)) {
        return 'a statement before the loop writes the register file in a way the trace cannot apply';
      }
      continue;
    }
    if (t.isIfStatement(statement)) {
      const taken = evaluate(statement.test, registers, registerName);
      if (taken === undefined) {
        return 'a branch before the loop decides a register write, and the trace cannot decide the branch';
      }
      const branch = taken ? statement.consequent : statement.alternate;
      if (!branch) continue;
      const reason = applyStatements(asStatements(branch), registers, registerName);
      if (reason) return reason;
      continue;
    }
    // A write inside a loop, a `try`, a `switch`, a labelled statement or a
    // declaration: there is no order in which this walk could reproduce it.
    return `a ${statement.type} before the loop writes the register file, with no order the trace can reproduce`;
  }
  return undefined;
}

/**
 * The register file is parameter 0 of the function that owns the loop.
 *
 * This is the whole of the tier-1 / tier-2 split. When the file is a computed
 * heap path instead, recovering it needs a heap model with runtime-computed
 * property names and an interprocedural fixpoint, which is a different program
 * from this one.
 */
function registerFileName(host: t.Function, vm: RegisterVm): string | undefined {
  if (!t.isIdentifier(vm.register)) return undefined;
  const first = host.params[0];
  return t.isIdentifier(first) && first.name === vm.register.name ? first.name : undefined;
}

/**
 * Replace the loop with the traced blocks.
 *
 * Spliced into the enclosing statement list rather than wrapped in a block, so
 * that a `var` still hoists to the function scope it reached before; the walk
 * has already refused every block-scoped declaration in a position it flattens.
 */
function linearise(loop: LoopPath, statements: t.Statement[], ctx: PassContext): void {
  if (!Array.isArray(loop.container)) {
    loop.replaceWith(t.inherits(t.blockStatement(statements), loop.node));
  } else if (statements.length === 0) {
    loop.remove();
  } else {
    loop.replaceWithMultiple(statements);
  }
  ctx.markChanged(statements.length);
}

// ---------------------------------------------------------------------------
// Preconditions on the register file
// ---------------------------------------------------------------------------

/**
 * Why some mention of the register file inside the host is one this pass has
 * not modelled, or `undefined` when every mention is.
 *
 * Read off the tree rather than off `binding.referencePaths`, because by the
 * time `structure` runs, four passes have rewritten these statements and
 * Babel's cached reference lists lag behind every one of them. A missed
 * reference here is not a lost opportunity, it is a register write the trace
 * never applied, so the question has to be asked of the code that is actually
 * there.
 *
 * Three shapes are accepted and everything else refuses: `R[<index>]` where the
 * index is itself built only from register reads and numeric literals (the only
 * access, read or write), `sum(R)` (the key function, the only thing R may be
 * passed to), and nothing at all inside a nested function (so no closure can
 * hold the file past the loop). A bare `R` anywhere else covers the rest:
 * `R = ...` reassigns it, `f(R)` hands it out, `var R` shadows it, and a nested
 * parameter named `R` would silently rebind it.
 *
 * An accepted `R[<index>]` is additionally checked *by position*, and this gate
 * and `containsRegisterWrite` have to reach the same verdict there or the pass
 * is unsound rather than merely conservative. Reading a write as
 * `AssignmentExpression.left` or `UpdateExpression.argument` and nothing else
 * lets `delete R[1]`, `[R[1]] = xs` and `for (R[1] of xs)` pass here as ordinary
 * indexed accesses *and* count as no write at all, leaving the trace to carry a
 * stale vector into the next dispatch. Both gates ask `isPureContext` instead,
 * and a write in a position `applyExpression` cannot reproduce is refused here,
 * where the reason can name the construct.
 *
 * The index rule is what this gate is really for, and it is narrower than
 * "computed". `R[R[65] - 183]` is a register read of a register-valued index
 * and the trace knows both; `R[K[4]]`, where the frozen table's fourth entry is
 * the string `'length'`, is an assignment that *resizes* the register file and
 * moves the switch key by an amount no vector model of it can see. The first is
 * a function of the file, the second reaches outside it, and only the second is
 * refused.
 *
 * What those shapes do *not* prove on their own is the absence of aliasing.
 * They are a scan for a *name*, so they are only as strong as the assumption
 * that every path to the array spells it. `arguments` breaks that assumption by
 * itself: in `function vm(r) { ... }`, `arguments[0][3] = 1` writes a register in
 * a body that never mentions `r`, and an arrow nested anywhere in it shares the
 * same object. So `arguments` is refused wherever it occurs in the host - the
 * same reasoning, and the same bluntness, as
 * `simplify/discard-wrappers.ts::usesCallerState`. A nested ordinary function's
 * own `arguments` is harmless and refused anyway, because separating the two
 * cases buys nothing a pass this conservative needs.
 *
 * The other half of "a scan for a name" is that a name can mean something else,
 * and on the fixture it usually does: the obfuscator reuses its identifiers, so
 * 19 of the 51 tier-1 hosts contain a nested `function (...OoKm8q) { ... }` whose
 * `OoKm8q` is that function's own rest parameter and has nothing to do with the
 * register file. Refusing those was a fifth of the file thrown away over a
 * spelling, so a nested function that rebinds the name *for its whole body* -
 * by a parameter, by its own name, or by a hoisted `var` - is skipped whole.
 * Anything short of the whole body (a `let` in an inner block, say) is not
 * skipped, because then some of the mentions really are the register file.
 *
 * That skip is why `arguments` is scanned for separately and first. `arguments`
 * is not a name a parameter list can rebind, and an arrow does not have one of
 * its own - so `queue((...r) => { arguments[0][3] = 1; })` reaches the host's
 * register file from inside a subtree the register-name scan is entitled to
 * skip. The two questions look alike and have different scopes, so they are
 * asked by different walks.
 */
function unsafeRegisterUse(
  host: NodePath<t.Function>,
  registerName: string,
  keyName: string,
): string | undefined {
  if (mentionsArguments(host.node)) {
    return 'the enclosing function mentions `arguments`, which aliases the register file without naming it';
  }

  let reason: string | undefined;

  const inspect = (link: Ancestry, nested: boolean): void => {
    const node = link.node;
    if (reason) return;
    if (t.isFunction(node) && rebindsThroughout(node, registerName)) return;

    if (t.isMemberExpression(node) && t.isIdentifier(node.object, { name: registerName })) {
      if (nested) {
        reason = `a nested function reads ${registerName}, so a closure could hold the register file past the loop`;
        return;
      }
      if (!node.computed || !isRegisterIndex(node.property, registerName)) {
        reason =
          `${registerName} is indexed by something other than its own values: only ` +
          `${registerName}[...] built from register reads and numeric literals is decidable`;
        return;
      }
      if (!isPureContext(link) && !isModelledWrite(link)) {
        reason =
          `${registerName} is written through ${describeWriteForm(link)}, which moves the ` +
          `register file in a position the trace has no way to evaluate`;
        return;
      }
      // The index is a register expression of its own and may nest further.
      inspect(childLink(link, node.property), nested);
      return;
    }

    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name: keyName }) &&
      node.arguments.length === 1 &&
      t.isIdentifier(node.arguments[0], { name: registerName })
    ) {
      if (nested) {
        reason = `a nested function passes ${registerName} to ${keyName}`;
      }
      return;
    }

    if (t.isIdentifier(node, { name: registerName })) {
      reason = `${registerName} is used somewhere other than an indexed access or ${keyName}(${registerName})`;
      return;
    }

    const inner = nested || t.isFunction(node);
    for (const child of childrenOf(node)) inspect(childLink(link, child), inner);
  };

  // The parameter list is skipped past its own binding occurrence; a default
  // initialiser further along is ordinary code and is inspected. It is also the
  // one piece of the host that runs before `applyPrelude` can look at anything,
  // so a write there would move the entry vector with nowhere to record it:
  // `function vm(r, x = (r[0] = 5))` passes every shape rule below and starts
  // the machine in a state the trace never sees.
  for (const param of host.node.params.slice(1)) {
    if (containsRegisterWrite(param, registerName)) {
      return `a parameter default writes ${registerName}, which runs before anything the trace can order`;
    }
    inspect(rootLink(param), false);
  }
  inspect(rootLink(host.node.body), false);
  return reason;
}

/** A subtree root, which `isPureContext` reads as a pure position. */
function rootLink(node: t.Node): Ancestry {
  return { node, parent: null, parentPath: null };
}

/**
 * The construct a register access sits in when it is neither a read nor a write
 * the trace can apply - named so the refusal says which of the three unmodelled
 * write forms it found rather than "some write, somewhere".
 */
function describeWriteForm(link: Ancestry): string {
  const parent = link.parent;
  if (t.isUnaryExpression(parent) && parent.operator === 'delete') return '`delete`';
  if (t.isForXStatement(parent) && parent.left === link.node) return 'a for-in/of head';
  if (
    t.isArrayPattern(parent) ||
    t.isObjectPattern(parent) ||
    t.isRestElement(parent) ||
    t.isObjectProperty(parent) ||
    t.isAssignmentPattern(parent)
  ) {
    return 'a destructuring pattern';
  }
  return 'a construct this pass does not model';
}

/**
 * Whether `arguments` appears anywhere in the host, nested functions included.
 *
 * Deliberately blunt, and for the same reason as
 * `simplify/discard-wrappers.ts::usesCallerState`: a nested ordinary function's
 * own `arguments` is harmless, telling it apart from the host's is a scope
 * analysis this pass does not have, and over-refusing costs a recovery while
 * under-refusing costs a wrong one.
 */
function mentionsArguments(host: t.Function): boolean {
  let found = false;
  const scan = (node: t.Node): void => {
    if (found) return;
    if (t.isIdentifier(node, { name: 'arguments' })) {
      found = true;
      return;
    }
    for (const child of childrenOf(node)) scan(child);
  };
  for (const param of host.params.slice(1)) scan(param);
  scan(host.body);
  return found;
}

/**
 * Whether `name` means something of `fn`'s own throughout `fn`'s body.
 *
 * Three shapes qualify and no others, because each of them covers the body
 * *entirely*: a parameter, the function's own name (visible inside itself), and
 * a `var`, which hoists to the function however deep it is written. A `let`,
 * `const` or `class` covers only its block, and a nested `function` declaration
 * only the block it sits in, so neither is enough to say that no mention of the
 * name anywhere in this function is the register file - and half a shadow is
 * worse than none, since the mentions it does not cover are exactly the ones
 * that matter.
 */
function rebindsThroughout(fn: t.Function, name: string): boolean {
  if ((t.isFunctionDeclaration(fn) || t.isFunctionExpression(fn)) && fn.id?.name === name) {
    return true;
  }
  for (const param of fn.params) {
    if (Object.hasOwn(t.getBindingIdentifiers(param), name)) return true;
  }

  let hoisted = false;
  walk(fn.body, (node) => {
    if (hoisted) return false;
    // A deeper function's `var` belongs to that function, not this one.
    if (t.isFunction(node)) return false;
    if (t.isVariableDeclaration(node) && node.kind === 'var') {
      if (Object.hasOwn(t.getBindingIdentifiers(node), name)) hoisted = true;
    }
    return !hoisted;
  });
  return hoisted;
}

/**
 * An index expression the trace can evaluate: register reads and numeric
 * literals under the arithmetic `evaluate` implements, and nothing else.
 *
 * This is the static half of the index rule. The dynamic half is in
 * `registerSlot`, which additionally requires the value to land on a
 * non-negative integer inside the vector - so `R[R[3] / 2]` passes here and
 * refuses there, at the point where it is known to be fractional.
 */
function isRegisterIndex(node: t.Node, name: string): boolean {
  switch (node.type) {
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return true;
    case 'MemberExpression':
      return (
        node.computed &&
        t.isIdentifier(node.object, { name }) &&
        isRegisterIndex(node.property, name)
      );
    case 'UnaryExpression':
      return isRegisterIndex(node.argument, name);
    case 'BinaryExpression':
      return (
        t.isExpression(node.left) &&
        isRegisterIndex(node.left, name) &&
        isRegisterIndex(node.right, name)
      );
    case 'LogicalExpression':
      return isRegisterIndex(node.left, name) && isRegisterIndex(node.right, name);
    case 'ConditionalExpression':
      return (
        isRegisterIndex(node.test, name) &&
        isRegisterIndex(node.consequent, name) &&
        isRegisterIndex(node.alternate, name)
      );
    default:
      return false;
  }
}

/**
 * Whether no `if` test anywhere in the dispatcher writes a register.
 *
 * The precondition for forking, and the reason it is a whole-dispatcher scan
 * rather than a check at the point of use: a fork hands the *same* vector to
 * both successors, which is only the vector each of them really starts from
 * while evaluating the test cannot have moved it. Measured over the fixture no
 * guard does - but "measured" is not "checked", and the difference between the
 * two is a trace that runs both arms from a state neither is in.
 */
function noGuardWritesARegister(switchNode: t.SwitchStatement, registerName: string): boolean {
  let clean = true;
  walk(switchNode, (node) => {
    if (!clean) return false;
    if (t.isIfStatement(node) && containsRegisterWrite(node.test, registerName)) clean = false;
    return clean;
  });
  return clean;
}

// ---------------------------------------------------------------------------
// Reading the switch
// ---------------------------------------------------------------------------

function readMachine(vm: RegisterVm, registerName: string): Machine | undefined {
  const labels: Machine['labels'] = [];
  const blocks: Block[] = [];
  /** Labels seen since the last non-empty consequent, all selecting the next block. */
  let pending: t.Expression[] = [];

  for (const kase of vm.switchNode.cases) {
    // A `default` absorbs every state the trace did not predict, which is the
    // one thing a trace must not have to guess about.
    if (!kase.test) return undefined;

    if (kase.consequent.length === 0) {
      // Consecutive labels sharing one body.
      pending.push(kase.test);
      continue;
    }

    const index = blocks.length;
    blocks.push({ body: kase.consequent, next: undefined });
    for (const test of pending) labels.push({ test, block: index });
    labels.push({ test: kase.test, block: index });
    pending = [];
  }

  // Trailing labels with no body at all: they fall straight out of the switch
  // and back to the loop head, which is an empty block whose successor is the
  // dispatcher. Modelled rather than refused, because the walk below already
  // has to answer "what happens at the end of a body" for every other block.
  if (pending.length > 0) {
    const index = blocks.length;
    blocks.push({ body: [], next: undefined });
    for (const test of pending) labels.push({ test, block: index });
  }
  if (blocks.length === 0) return undefined;

  // Running off the end of a body enters the *next* body, in source order.
  for (let index = 0; index < blocks.length - 1; index++) blocks[index]!.next = index + 1;
  return { registerName, labels, blocks };
}

/**
 * Whether a case body can be spliced out of its switch at all, independently of
 * what the trace does inside it.
 *
 * Asked on first visit rather than for every block up front, so that a body the
 * entry vector never reaches cannot refuse a machine it plays no part in.
 *
 * `switchBreaks` is checked per *opaque* statement rather than over the body,
 * because the walk only descends through blocks and `if` arms. A `break` there
 * is a jump the walk sees and follows; the same `break` inside a `try` or a
 * labelled statement is one it would emit verbatim and silently mis-model, so
 * any statement the walk does not enter must contain none.
 */
function blockLegality(block: Block): string | undefined {
  if (block.legality !== undefined) return block.legality || undefined;

  const jumps = scanCaseJumps(block.body);
  let reason = '';
  if (jumps.outerLabel) reason = 'a case body jumps to a label outside the dispatcher';
  else if (jumps.dispatcherContinues > 0) reason = 'a case body continues the dispatcher loop directly';
  // `jumps.sawEval` is not used for this, and the difference is a real hole
  // rather than a preference: `scanJumps` stops at a function boundary, which is
  // right for a jump and wrong for a scope. `(function () { eval('r[0] = 50');
  // })();` in a case body reports no eval, no register write and no jump, and is
  // emitted verbatim while the trace carries on with the vector it had.
  else if (block.body.some(containsDirectEval)) reason = 'a case body calls `eval`';
  block.legality = reason;
  return reason || undefined;
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

/** Where the walk through one case body ended. */
type Cursor = { statements: t.Statement[]; index: number; next: Cursor } | undefined;

/**
 * Follow the machine from a concrete entry vector, collecting the code it runs.
 *
 * The result is a tree rather than a line: a guard the trace cannot decide is
 * emitted as it was written, with each arm continuing into its own expansion of
 * the rest of the machine. A state reached twice down two different arms is
 * expanded twice, which duplicates code but never execution - the copies are on
 * paths the program chooses between, exactly as it did through the dispatcher.
 *
 * Refuses, rather than approximating, on: a state with no matching label (an
 * infinite loop in the original), a vector already seen *on the current path*
 * (likewise), a register write with no reproducible order, a case body that
 * cannot be spliced out of its switch, and the state budget.
 */
class Trace {
  reason: string | undefined;
  /** Blocks the trace entered, for the coverage the report prints. */
  readonly reached = new Set<number>();

  private used = 0;
  /** Nodes already spliced in; a second visit has to take a copy. */
  private readonly emitted = new Set<t.Node>();

  constructor(
    private readonly machine: Machine,
    private readonly exitSum: number,
    private readonly maxStates: number,
  ) {}

  /** The code the machine runs from `registers`, or nothing. */
  from(registers: Registers, path: ReadonlySet<string>): t.Statement[] | undefined {
    if (this.used++ >= this.maxStates) return this.stop('the state budget was spent');

    const sum = registerSum(registers);
    if (sum === undefined) return this.stop('a register stopped being a finite number');
    if (sum === this.exitSum) return [];

    const key = registers.join(',');
    if (path.has(key)) {
      return this.stop('the machine returns to a state it has already been in on the same path');
    }

    const block = this.select(registers, sum);
    if (block === undefined) return this.stop(`no case matches the state ${sum}`);

    const next = new Set(path);
    next.add(key);
    return this.body({ statements: this.machine.blocks[block]!.body, index: 0, next: undefined }, block, registers, next);
  }

  private stop(reason: string): undefined {
    this.reason ??= reason;
    return undefined;
  }

  /** The first label that strictly equals the state, exactly as `switch` picks. */
  private select(registers: Registers, sum: number): number | undefined {
    for (const label of this.machine.labels) {
      const value = evaluate(label.test, registers, this.machine.registerName);
      // A label this pass cannot decide makes every later label unreachable to
      // it too, so there is no partial answer to fall back on.
      if (typeof value !== 'number') {
        this.stop('a case label does not evaluate to a number');
        return undefined;
      }
      if (value === sum) return label.block;
    }
    return undefined;
  }

  /** `node` if this is its first appearance in the output, a deep copy otherwise. */
  private take<N extends t.Node>(node: N): N {
    if (this.emitted.has(node)) return t.cloneNode(node, true);
    this.emitted.add(node);
    return node;
  }

  /**
   * Walk one case body from `cursor`, emitting what it runs and following where
   * it goes: on to the dispatcher at a `break`, out of the function at a
   * `return`, into the next case body at the end of this one.
   */
  private body(
    cursor: Cursor,
    block: number,
    registers: Registers,
    path: ReadonlySet<string>,
  ): t.Statement[] | undefined {
    const { registerName } = this.machine;
    const out: t.Statement[] = [];
    let at = cursor;
    let current = block;

    for (;;) {
      const legality = blockLegality(this.machine.blocks[current]!);
      if (legality) return this.stop(legality);
      this.reached.add(current);

      if (!at) {
        // Ran off the end of the body. The next case body runs; the last one
        // leaves the switch, which is the loop head.
        const successor = this.machine.blocks[current]!.next;
        if (successor === undefined) {
          const tail = this.from(registers, path);
          if (!tail) return undefined;
          out.push(...tail);
          return out;
        }
        current = successor;
        at = { statements: this.machine.blocks[successor]!.body, index: 0, next: undefined };
        continue;
      }
      if (at.index >= at.statements.length) {
        at = at.next;
        continue;
      }

      const statement = at.statements[at.index]!;
      const rest: Cursor = { statements: at.statements, index: at.index + 1, next: at.next };

      // Splicing a body out of its switch moves every name it declares into the
      // enclosing block, where a block-scoped one could collide or change TDZ
      // and a function declaration would hoist somewhere new. Only the
      // statements this walk flattens are affected; a `for (let i ...)` emitted
      // whole keeps its own scope and is not this.
      if (t.isVariableDeclaration(statement) && statement.kind !== 'var') {
        return this.stop(`a case body declares \`${statement.kind}\`, which a flat splice would move`);
      }
      if (t.isClassDeclaration(statement) || t.isFunctionDeclaration(statement)) {
        return this.stop('a case body declares a class or a function, which a flat splice would move');
      }

      if (t.isBreakStatement(statement)) {
        if (statement.label) return this.stop('a case body breaks to a label');
        const tail = this.from(registers, path);
        if (!tail) return undefined;
        out.push(...tail);
        return out;
      }

      if (t.isReturnStatement(statement) || t.isThrowStatement(statement)) {
        out.push(this.take(statement));
        return out;
      }

      if (t.isBlockStatement(statement)) {
        at = { statements: statement.body, index: 0, next: rest };
        continue;
      }

      if (t.isIfStatement(statement)) {
        const taken = evaluate(statement.test, registers, registerName);
        if (taken !== undefined) {
          // The test decided, and everything `evaluate` can decide is built
          // from register reads and literals, so dropping it loses no effect.
          const branch = taken ? statement.consequent : statement.alternate;
          at = branch ? { statements: [branch], index: 0, next: rest } : rest;
          continue;
        }
        const consequent = this.body(
          { statements: [statement.consequent], index: 0, next: rest },
          current,
          [...registers],
          path,
        );
        if (!consequent) return undefined;
        const alternate = this.body(
          statement.alternate
            ? { statements: [statement.alternate], index: 0, next: rest }
            : rest,
          current,
          [...registers],
          path,
        );
        if (!alternate) return undefined;
        out.push(
          t.ifStatement(
            this.take(statement.test),
            t.blockStatement(consequent),
            t.blockStatement(alternate),
          ),
        );
        return out;
      }

      // Everything else is emitted verbatim. It may not write a register - the
      // walk would have no order to apply the write in - and it may not hold a
      // jump out of the switch, which the walk would not see.
      if (containsRegisterWrite(statement, registerName)) {
        if (!t.isExpressionStatement(statement)) {
          return this.stop(`a register is written inside a ${statement.type}, with no reproducible order`);
        }
        if (!applyExpression(statement.expression, registers, registerName)) {
          return this.stop('a register write is in a position whose order the trace cannot reproduce');
        }
      } else if (scanCaseJumps([statement]).switchBreaks > 0) {
        return this.stop(`a \`break\` inside a ${statement.type} leaves the switch where the walk cannot follow`);
      }
      out.push(this.take(statement));
      at = rest;
    }
  }
}

function registerSum(registers: Registers): number | undefined {
  let total = 0;
  for (const value of registers) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    total += value;
  }
  return total;
}

/**
 * Apply the register writes of one expression, left to right.
 *
 * Only two positions are accepted: the whole expression, and an operand of a
 * comma sequence. Both are evaluated left to right with nothing between them,
 * so the order the trace applies writes in is the order the program does. A
 * write nested any deeper - inside a call argument, a ternary arm, a logical
 * operand - is refused rather than guessed at, because the position decides
 * both when it runs and whether it runs at all.
 */
function applyExpression(
  expression: t.Expression,
  registers: Registers,
  registerName: string,
): boolean {
  if (t.isSequenceExpression(expression)) {
    for (const operand of expression.expressions) {
      if (!containsRegisterWrite(operand, registerName)) continue;
      if (!applyExpression(operand, registers, registerName)) return false;
    }
    return true;
  }

  if (t.isAssignmentExpression(expression)) {
    if (!isAssignable(expression.operator)) return false;
    const index = registerSlot(expression.left, registers, registerName);
    if (index === undefined) return false;
    // The right-hand side may read registers but may not write them, so the
    // read-modify-write below cannot observe itself.
    if (containsRegisterWrite(expression.right, registerName)) return false;
    const value = evaluate(expression.right, registers, registerName);
    if (typeof value !== 'number') return false;
    if (expression.operator === '=') {
      registers[index] = value;
      return true;
    }
    const current = registers[index];
    if (typeof current !== 'number') return false;
    registers[index] =
      expression.operator === '+='
        ? current + value
        : expression.operator === '-='
          ? current - value
          : current * value;
    return true;
  }

  if (t.isUpdateExpression(expression)) {
    const index = registerSlot(expression.argument, registers, registerName);
    if (index === undefined) return false;
    const current = registers[index];
    if (typeof current !== 'number') return false;
    registers[index] = expression.operator === '++' ? current + 1 : current - 1;
    return true;
  }

  return false;
}

const ASSIGNABLE = new Set(['=', '+=', '-=', '*=']);

function isAssignable(operator: string): boolean {
  return ASSIGNABLE.has(operator);
}

/**
 * The slot `R[k]` names, with `k` evaluated against the current vector.
 *
 * Refuses anything that is not an existing slot: a fractional or negative index
 * is a string key on a JavaScript array, and one past the end *grows* the file,
 * which moves the switch key by an amount the vector model cannot see.
 */
function registerSlot(node: t.Node, registers: Registers, name: string): number | undefined {
  if (!t.isMemberExpression(node) || !node.computed) return undefined;
  if (!t.isIdentifier(node.object, { name })) return undefined;
  const index = evaluate(node.property, registers, name);
  if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
  return index >= 0 && index < registers.length ? index : undefined;
}

/**
 * Whether a subtree moves the register file.
 *
 * The question is asked *by position*, not by syntactic form, and that is the
 * whole of it. Reading `AssignmentExpression.left` and `UpdateExpression
 * .argument` enumerates two of JavaScript's write positions and silently
 * answers "no write" for the rest: `delete R[1]`, a destructuring target
 * (`[R[1]] = xs`, `({ z: R[1] } = o)`) and a for-in/of head all move the
 * register file through a parent that is none of those two node types. "No
 * visible write" then becomes "no write", the trace carries the pre-write
 * vector into the next dispatch, and the output parses, runs and computes
 * something else.
 *
 * `util/ast.ts::isPureContext` already decides exactly this question - it is
 * why `resolveFrozenTable` refuses all of the same shapes against the constant
 * table - so it is reused rather than re-derived. What it needs and `walk` does
 * not supply is a parent, hence {@link walkWithParents}.
 *
 * Skips a nested function that rebinds the name for its whole body on the same
 * grounds `unsafeRegisterUse` does - `queue(function (...r) { r[4] += 1; })`
 * writes that function's own rest parameter - and it has to agree with that
 * gate rather than merely be as cautious as it. A statement counted as a write
 * here that the gate cleared is one the trace then refuses to order, so a
 * disagreement costs a recovery even though nothing is unsound.
 */
function containsRegisterWrite(node: t.Node, name: string): boolean {
  let found = false;
  walkWithParents(node, (link) => {
    if (found) return false;
    if (t.isFunction(link.node) && rebindsThroughout(link.node, name)) return false;
    if (mentionsRegisterFile(link.node, name) && !isPureContext(link)) found = true;
    return !found;
  });
  return found;
}

/**
 * Whether this node is a way of naming the register file, in any position.
 *
 * Deliberately looser than `registerSlot`, which answers "is this a slot the
 * trace can apply a write to": here `R['length'] = 4`, `R.length = 4` and
 * `R[k] = 1` all have to count, because the question is whether the array
 * *moved*, and a write this pass cannot model is the one it most needs to
 * notice. `unsafeRegisterUse` is what refuses them; if this agreed with
 * `registerSlot` instead, a write it could not model would read as no write at
 * all and be emitted unapplied.
 *
 * The bare identifier counts too, so that `[R] = xs` and `R = other` are seen
 * as the whole-file writes they are. `unsafeRegisterUse` refuses every bare
 * mention of the name before the trace runs, so this can only ever agree with
 * it or refuse earlier - never disagree in the direction that emits a write
 * unapplied.
 */
function mentionsRegisterFile(node: t.Node, name: string): boolean {
  if (t.isIdentifier(node, { name })) return true;
  return t.isMemberExpression(node) && t.isIdentifier(node.object, { name });
}

/**
 * Whether this position is a write `applyExpression` knows how to reproduce.
 *
 * The complement of it, among non-pure positions, is exactly three shapes:
 * `delete`, a destructuring target and a for-in/of head. Each of those moves
 * the register file, and none is a position the trace can evaluate - so they
 * are refused at the gate, where the reason can name the construct, rather than
 * deep inside the walk where the reason would be "some write, somewhere".
 *
 * The operator is *not* checked here. `applyExpression` accepts `=`, `+=`, `-=`
 * and `*=` and refuses the rest, per traced path - so `R[0] /= 2` in a block the
 * entry vector never reaches still costs nothing, which is the behaviour this
 * pass has always had.
 */
function isModelledWrite(link: Ancestry): boolean {
  const parent = link.parent;
  if (t.isAssignmentExpression(parent)) return parent.left === link.node;
  if (t.isUpdateExpression(parent)) return parent.argument === link.node;
  return false;
}

function asStatements(branch: t.Statement): t.Statement[] {
  return t.isBlockStatement(branch) ? branch.body : [branch];
}

// ---------------------------------------------------------------------------
// Register arithmetic
// ---------------------------------------------------------------------------

/**
 * Evaluate an expression against a concrete register file.
 *
 * Total by construction: every leaf is either a literal or a register read, and
 * anything else - a call, a property chain, a free name - yields `undefined`,
 * which the callers read as "cannot decide". Nothing here can run, reach or
 * observe anything outside the vector it was handed, and the short-circuiting
 * operators evaluate exactly the operands the program would, so an answer this
 * function returns never skipped a side effect the program performs.
 */
function evaluate(
  node: t.Expression | t.PrivateName,
  registers: Registers,
  name: string,
): number | boolean | undefined {
  switch (node.type) {
    case 'NumericLiteral':
      return node.value;

    case 'BooleanLiteral':
      return node.value;

    case 'MemberExpression': {
      if (!node.computed || !t.isIdentifier(node.object, { name })) return undefined;
      const index = evaluate(node.property, registers, name);
      if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
      const value = registers[index];
      return typeof value === 'number' ? value : undefined;
    }

    case 'UnaryExpression': {
      const operand = evaluate(node.argument, registers, name);
      if (operand === undefined) return undefined;
      switch (node.operator) {
        case '-':
          return -Number(operand);
        case '+':
          return Number(operand);
        case '~':
          return ~Number(operand);
        case '!':
          return !operand;
        default:
          return undefined;
      }
    }

    case 'BinaryExpression': {
      if (!t.isExpression(node.left)) return undefined;
      const left = evaluate(node.left, registers, name);
      if (left === undefined) return undefined;
      const right = evaluate(node.right, registers, name);
      if (right === undefined) return undefined;
      return applyBinary(node.operator, left, right);
    }

    case 'LogicalExpression': {
      const left = evaluate(node.left, registers, name);
      if (left === undefined) return undefined;
      if (node.operator === '&&') return left ? evaluate(node.right, registers, name) : left;
      if (node.operator === '||') return left ? left : evaluate(node.right, registers, name);
      return undefined;
    }

    case 'ConditionalExpression': {
      const test = evaluate(node.test, registers, name);
      if (test === undefined) return undefined;
      return evaluate(test ? node.consequent : node.alternate, registers, name);
    }

    default:
      return undefined;
  }
}

/**
 * Both operands are already numbers or booleans, so the host's own operators
 * implement exactly the specified semantics; the casts silence TS's operand
 * checks, which cannot express "whatever JavaScript does with these two".
 */
function applyBinary(
  operator: string,
  left: number | boolean,
  right: number | boolean,
): number | boolean | undefined {
  const l = left as never;
  const r = right as never;
  switch (operator) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return l / r;
    case '%': return l % r;
    case '**': return l ** r;
    case '&': return l & r;
    case '|': return l | r;
    case '^': return l ^ r;
    case '<<': return l << r;
    case '>>': return l >> r;
    case '>>>': return l >>> r;
    case '===': return l === r;
    case '!==': return l !== r;
    case '==': return l == r;
    case '!=': return l != r;
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// The entry vector
// ---------------------------------------------------------------------------

/**
 * The vector every call starts this machine from, or the reason there is not
 * exactly one.
 *
 * The callee is matched by *binding*, never by name. On the fixture, name
 * matching finds 147 call sites of which 59 bind somewhere else entirely, and
 * folding one of those would hand this machine a vector belonging to another.
 *
 * All call sites are read, not just a single one - 38 of the fixture's 51
 * tier-1 machines have one call site and 8 have between three and nineteen -
 * and they must agree. Two different vectors are two different programs, and
 * the function body can only be one of them; specialising by cloning the host
 * per call site would be sound and is refused for want of equivalence evidence.
 *
 * The argument itself is resolved by `simplify/fold-constants`, which is where
 * the proof that the constant table is frozen and the slice helper pure already
 * lives. Doing it here would mean writing that proof a second time, and the
 * failure mode of getting it subtly different is a vector that is wrong rather
 * than absent.
 */
function entryVector(host: NodePath<t.Function>, order: TreeOrder | undefined): Registers | string {
  if (!host.isFunctionDeclaration() || !host.node.id) {
    return 'the dispatcher is not a named function declaration, so its call sites cannot be bound';
  }
  // "All call sites agree on one vector" is a proof about
  // `binding.referencePaths`, and that list enumerates the call sites only while
  // the name means nothing outside the binding's own scope. Annex B.3.3 breaks
  // that: a sloppy-mode declaration inside a block or a `switch` case is *also*
  // var-declared in the enclosing function, so
  //
  //     { function vm(r) { ... } out = vm([1, 0, 0]); }
  //     out2 = vm([7, 0, 0]);
  //
  // calls it twice with two vectors while Babel, which binds the declaration to
  // the block, lists one reference - and the machine is specialised to a vector
  // half its callers never use. Refused rather than repaired: reading the outer
  // reference means re-deriving Annex B's scoping, and it costs 0 of
  // obfuscated4.js's 51 tier-1 hosts. See `util/ast.ts`.
  if (!isVarScopedFunctionDeclaration(host)) {
    return 'the dispatcher is declared inside a block, where a sloppy-mode `var` hoist puts it in scope for callers its binding does not list';
  }
  const binding = host.parentPath?.scope.getBinding(host.node.id.name);
  if (!binding || binding.path.node !== host.node) {
    return "the dispatcher's own name does not bind to it";
  }
  // Measured at 0 of obfuscated4.js's 51 tier-1 hosts, and it is reachable only
  // from here: the first gate above has already refused every host that is not
  // a function declaration, so a function expression that reassigns the name it
  // is held in never reaches this line. Kept because a declaration really can
  // be reassigned, and then `referencePaths` is a list of calls to whatever the
  // name happens to hold.
  if (binding.constantViolations.some((violation) => violation.node !== host.node)) {
    return 'the dispatcher reassigns its own binding, so no call site names a fixed function';
  }

  const vectors: Registers[] = [];
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    // Any use that is not a direct call reads the function as a value, and the
    // vector it would then be called with is not in this call's arguments.
    if (!parent?.isCallExpression() || parent.node.callee !== reference.node) {
      return 'the dispatcher is used as a value somewhere, not only called';
    }
    const argument = parent.get('arguments')[0];
    if (!argument?.isArrayExpression()) {
      return "this dispatcher's entry vector could not be resolved to concrete values";
    }
    const vector = resolveNumericVector(argument, undefined, order);
    if (!vector || vector.length === 0) {
      return "this dispatcher's entry vector could not be resolved to concrete values";
    }
    vectors.push(vector);
  }

  const first = vectors[0];
  if (!first) return 'the dispatcher is never called, so it has no entry vector';
  const distinct = new Set(vectors.map((vector) => vector.join(',')));
  if (distinct.size > 1) {
    return `the dispatcher is entered with ${distinct.size} different entry vectors, which are ${distinct.size} different programs`;
  }
  return first;
}

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

/** Depth-first over the AST; `visit` returns false to skip a subtree. */
function walk(root: t.Node, visit: (node: t.Node) => boolean): void {
  if (!visit(root)) return;
  for (const child of childrenOf(root)) walk(child, visit);
}

/**
 * The same walk, carrying each node's ancestry, so that `isPureContext` can be
 * asked whether a mention of the register file is a read or a write.
 *
 * Babel's own paths would answer this and are not usable here, for the reason
 * `unsafeRegisterUse` gives: by the time `structure` runs, the cached reference
 * lists lag behind four passes of rewrites, and a missed reference is a register
 * write the trace never applied. So the ancestry is built from the nodes that
 * are actually present.
 *
 * `root` is handed in with no parent, which `isPureContext` reads as a pure
 * position. Every caller passes a whole statement or a whole expression, so a
 * write is always announced by a node inside the subtree rather than above it.
 */
function walkWithParents(root: t.Node, visit: (link: Ancestry) => boolean): void {
  const step = (node: t.Node, parentPath: Ancestry | null): void => {
    const link: Ancestry = { node, parent: parentPath?.node ?? null, parentPath };
    if (!visit(link)) return;
    for (const child of childrenOf(node)) step(child, link);
  };
  step(root, null);
}

/** The ancestry of `node`, which is a child of `parent`'s node. */
function childLink(parent: Ancestry, node: t.Node): Ancestry {
  return { node, parent: parent.node, parentPath: parent };
}

/**
 * Whether a subtree contains a *direct* `eval`, nested functions included.
 *
 * Direct eval is the one call that reaches a lexical binding it was never
 * handed: `eval('r[0] = 50')` writes the register file in a statement whose only
 * mention of `r` is inside a string, so every scan for the name - and every scan
 * for a write position - reports nothing at all.
 *
 * Nested functions are *not* skipped, unlike in `analysis/dispatcher.ts`'s
 * `scanJumps`, where stopping at a function boundary is right because a jump
 * cannot cross one. A closure can: `(function () { eval('r[0] = 50'); })()` sits
 * in the host's scope chain and reaches the same array.
 *
 * `eval?.()` is included because the spec's direct-eval test is on the callee
 * reference, not on the call syntax. `(0, eval)(...)` is not, and does not need to
 * be: it is indirect, runs in the global scope, and cannot see `r` at all.
 */
function containsDirectEval(node: t.Node): boolean {
  let found = false;
  walk(node, (current) => {
    if (found) return false;
    if (
      (t.isCallExpression(current) || t.isOptionalCallExpression(current)) &&
      t.isIdentifier(current.callee, { name: 'eval' })
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

function* childrenOf(node: t.Node): Generator<t.Node> {
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) yield item;
    } else if (isNode(child)) {
      yield child;
    }
  }
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}
