import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  analyzeDispatcher,
  DispatcherRound,
  keyId,
  looksLikeDispatcher,
  looksLikeRegisterVm,
  readRegisterVm,
  resolvesToSumReducer,
  type Dispatcher,
} from '../../analysis/dispatcher.js';
import { stringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { describeNode, TreeOrder, type BlockFunctionMemo } from '../../util/ast.js';
import { describeRegisterVmRefusal } from './register-vm.js';
import {
  recordRefusal,
  REFUSAL_EVIDENCE,
  REGISTER_VM_EVIDENCE,
  withdrawRefusal,
} from './refusals.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

type LoopPath = NodePath<t.WhileStatement | t.ForStatement>;

/**
 * Rebuild straight-line code from `controlFlowFlattening` dispatchers.
 *
 * A flattened function keeps its statements in `switch` cases and its real
 * execution order in a string: `'3|0|4|1|2'` means case 3 runs first. Recovery
 * is concatenating the case bodies in *that* order - inlining them in textual
 * order instead yields a program that still parses, usually still runs, and
 * computes something else entirely. That failure mode is silent, so the
 * analysis in `analysis/dispatcher.ts` refuses everything it cannot prove and
 * this pass only ever acts on a proven match.
 *
 * A `run` pass rather than a visitor because the rewrite deletes a whole loop
 * and two declarations that live outside it, which a merged traversal must not
 * do underneath other passes. It still costs exactly one traversal: candidates
 * are collected in one walk, then each is transformed through its own subtree.
 */
export const unflattenControlFlowPass: Pass = {
  id: 'structure.control-flow',
  title: 'Unflatten dispatcher state machines',
  stage: 'structure',
  technique: 'controlFlowAnalysis',
  run: (ctx) => {
    const candidates = collectCandidates(ctx);
    if (candidates.length === 0) return;

    const options = ctx.config.techniqueOptions.controlFlowAnalysis;
    // Every gate in `analyzeDispatcher` reads a binding's reference list, and a
    // direct `eval` writes a name without appearing in one. The fact is a
    // whole-program one and is computed once per fixpoint iteration, so it is
    // taken here rather than per candidate; the analysis has no `ctx` to ask
    // from, which is why it arrives as an option.
    const stringCode = stringCodeFacts(ctx);
    // Likewise the analysis's own whole-program memos, one set per run: the
    // next round's tree is a different tree.
    const round = new DispatcherRound();
    // The tree's order, for the register-VM report to place an entry vector's
    // names by the way recovery did; numbered again after every linearisation
    // below, each of which re-orders a stretch of it.
    const order = new TreeOrder(ctx.ast);
    // Deepest first, so a dispatcher nested inside a case body is already
    // linearised by the time its parent reads that body.
    candidates.sort((a, b) => b.depth - a.depth);

    for (const { path, kind } of candidates) {
      if (ctx.isExhausted()) return;
      if (path.removed) continue;

      if (kind === 'register-vm') {
        reportRegisterVm(path, ctx, order);
        continue;
      }

      const result = analyzeDispatcher(path, {
        maxStates: options.maxStates,
        aggressive: options.aggressiveDispatchers,
        stringCode,
        round,
      });
      if (result.kind === 'reject') continue;

      if (result.kind === 'bail') {
        // The fixpoint loop re-runs this stage, and an earlier pass may yet make
        // the same dispatcher resolvable, so report each refusal only once.
        recordRefusal(
          ctx,
          path.node,
          REFUSAL_EVIDENCE,
          0.6,
          `Left a switch dispatcher flattened: ${result.reason}.`,
        );
        continue;
      }

      const dispatcher = result.value;
      // A refusal is only ever provisional: the order array is usually a call
      // into a string decoder or an alias map, and the pass that resolves it
      // runs in a *later* fixpoint iteration. A refusal never taken back reports
      // a dispatcher that was recovered as one the engine gave up on.
      withdrawRefusal(ctx, path.node, REFUSAL_EVIDENCE);
      ctx.report(
        'control-flow-flattening',
        `${dispatcher.orderName}[${dispatcher.stateName}++] over ${dispatcher.order.length} states`,
        1,
        1,
      );
      linearise(dispatcher, ctx);
      order.invalidate();
    }
  },
};

/**
 * Name the register VM and leave it standing, saying why.
 *
 * Two things are deliberately not done here. `analyzeDispatcher` is never
 * called: it proves an order array driving a counter, would `reject` on this
 * shape, and a silent reject is how these loops stayed invisible in the first
 * place. And the confidence stays high. `Detection` has one axis, and on this
 * shape *recognition* is near-certain - the key function is proven to be the
 * sum reducer - while it is *recovery* that failed. A low number would read as
 * uncertainty about what the loop is, which is the opposite of the truth, so
 * the failure lives in the evidence string and the diagnostic instead.
 *
 * The reason is asked of `structure.register-vm` rather than asserted here,
 * because a reason asserted here is a guess about which gate fired: that pass
 * refuses nearly every tier-1 machine several steps *before* it ever looks at a
 * call site, so a message naming the entry vector is false for most of the
 * loops it would appear on. The fixture's 29 refusals name four causes instead
 * - 16 heap-path register files, 8 machines entered with more than one vector,
 * 3 function-expression hosts, 2 hosts that mention `arguments`.
 *
 * When recovery is switched off - `conservative` and `balanced` - nothing was
 * attempted at all and no gate has an opinion to report, so the message says
 * that instead of inventing one.
 */
function reportRegisterVm(path: LoopPath, ctx: PassContext, order: TreeOrder): void {
  const vm = readRegisterVm(path.node);
  const where = vm ? `${vm.keyName}(${describeNode(vm.register)})` : 'the register file';
  const options = ctx.config.techniqueOptions.controlFlowAnalysis;

  let reason: string | undefined;
  if (!options.registerVm) {
    reason = 'recovering it is switched off (controlFlowAnalysis.registerVm)';
  } else if (!vm) {
    reason = 'it could not be re-read as a register VM';
  } else {
    reason = describeRegisterVmRefusal(path, vm, options.maxRegisterVmStates, order);
    // No gate objects - and the loop is nonetheless still here. Recovery runs
    // *earlier* in the stage (see `passes/registry.ts`, "Recovery before
    // reporting"), and both passes' `run` bodies execute in registration order
    // within one `runStage`, so a loop nothing objects to is one the recovery
    // pass never got to: disabled by name, or out of time budget partway down
    // its candidate list. Staying quiet there hides a dispatcher nothing is
    // going to recover.
    //
    // Measured with recovery forced on over obfuscated4.js, this branch is
    // taken 0 times: all 38 recoverable machines are gone before this pass
    // looks, and the 29 that remain each name a gate. It still has to exist for
    // the other composition order - which is also what the `structure`
    // fixpoint's round boundary looks like, this pass on round N followed by
    // the recovery pass on round N+1, whose `recover` takes the refusal back
    // through `withdrawRefusal`.
    if (reason === undefined) {
      reason = 'no gate objects to recovering it, so `structure.register-vm` never reached it';
    }
  }

  recordRefusal(
    ctx,
    path.node,
    REGISTER_VM_EVIDENCE,
    0.9,
    `Left a register-VM dispatcher in place: the switch key is a sum over ${where}, and ${reason}.`,
  );
}

interface Candidate {
  path: LoopPath;
  depth: number;
  /**
   * Which machine this is. The two share a syntax and nothing else, so the
   * discriminant has to travel with the candidate rather than be re-derived by
   * whichever analysis happens to look at it next.
   */
  kind: 'switch' | 'register-vm';
}

/**
 * One traversal of the program, and only for files that contain the shape.
 *
 * Most input has no dispatcher at all, and this pass re-runs on every fixpoint
 * iteration, so a plain structural pre-scan - several times cheaper than a
 * Babel traversal - decides whether the traversal is worth paying for.
 */
function collectCandidates(ctx: PassContext): Candidate[] {
  if (!containsDispatcherShape(ctx.ast)) return [];

  // Every gate in `analyzeDispatcher` is a statement about a binding's writes
  // and reads, and the tree has changed since scope was last built: the
  // `simplify` stage runs immediately before this one and `simplify.sequences`
  // alone splits every comma statement in the file. Reading a stale reference
  // list here does not produce a wrong rewrite - the gates only ever get
  // *stricter* on stale data - but it does refuse dispatchers that are provable,
  // and it did: `order = '...'.split('|'), state = 0;` above a `while (!![])` was
  // recovered when written as two statements and refused when written as one.
  // Paid only on files that actually contain the shape, which the scan above
  // has just established, and only if the tree moved since the last crawl.
  const program = programOf(ctx.ast);
  if (program) ctx.crawlProgramScope(program);

  const candidates: Candidate[] = [];
  // One memo for the traversal: nothing below adds a declaration.
  const blockFunctions: BlockFunctionMemo = new Map();
  const visit = (path: LoopPath): void => {
    if (looksLikeDispatcher(path.node)) {
      candidates.push({ path, depth: path.getAncestry().length, kind: 'switch' });
      return;
    }
    // The structural match alone would report on any `while (f(r) !== n)`; the
    // reducer check is what makes the detection worth a reader's trust.
    const vm = readRegisterVm(path.node);
    if (!vm || !resolvesToSumReducer(path, vm.keyName, blockFunctions)) return;
    candidates.push({ path, depth: path.getAncestry().length, kind: 'register-vm' });
  };
  traverse(ctx.ast, {
    WhileStatement: visit,
    ForStatement: visit,
  });
  return candidates;
}

/** The program path, for a scope rebuild. */
function programOf(ast: t.File): NodePath<t.Program> | null {
  let program: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

function containsDispatcherShape(root: t.Node): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    if (
      (t.isWhileStatement(node) || t.isForStatement(node)) &&
      (looksLikeDispatcher(node) || looksLikeRegisterVm(node))
    ) {
      return true;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

/**
 * Replace the loop with its case bodies in dispatch order.
 *
 * The bodies are spliced into the enclosing statement list rather than wrapped
 * in a block, which is what keeps `var` and function declarations hoisting to
 * the same function scope they reached before. The analysis has already refused
 * any case declaring a `let`, `const` or `class`, for which a flat splice would
 * change the scope a name lands in.
 */
function linearise(dispatcher: Dispatcher, ctx: PassContext): void {
  // A `for (init; !![];)` head runs `init` exactly once, before the first
  // dispatch. Straight-line code reproduces that by putting it first - minus
  // the order/state writes, which the analysis has just proven unobservable.
  const statements: t.Statement[] = [...dispatcher.prelude];
  for (const key of dispatcher.order) {
    const body = dispatcher.cases.get(keyId(key));
    if (body) statements.push(...body.body);
  }

  const loop = dispatcher.loop;
  if (!Array.isArray(loop.container)) {
    // A bare loop body (`if (x) while (true) ...`) has no statement list to splice
    // into; a block is the only equivalent single-statement form.
    loop.replaceWith(t.inherits(t.blockStatement(statements), loop.node));
  } else if (statements.length === 0) {
    loop.remove();
  } else {
    loop.replaceWithMultiple(statements);
  }

  // Both bindings were proven to be read only by the dispatcher, so with the
  // dispatcher gone nothing can observe the writes. Whether the VALUE could be
  // observed as it was built is a second question, and the order array is on
  // this list only when the analysis put it there - see the purity call in
  // `analyzeDispatcher`. Only declarations that outlive the loop are listed:
  // one in the `for` head has already gone with it.
  for (const declarator of dispatcher.retire) removeDeclarator(declarator);

  ctx.markChanged();
}

function removeDeclarator(declarator: NodePath<t.VariableDeclarator>): void {
  if (declarator.removed) return;
  const declaration = declarator.parentPath;
  declarator.remove();
  // Babel leaves an empty `var;` behind, which does not print as valid JS.
  if (declaration?.isVariableDeclaration() && declaration.node.declarations.length === 0) {
    declaration.remove();
  }
}
