import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { branchHangs, isSourceShapePattern } from '../../analysis/detect.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { blockFunctionOutsideUse, countNodes, staticNumber, staticString } from '../../util/ast.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Size ceiling on a subtree that can be called "a trap and nothing else".
 *
 * Every recogniser below finds a *signal* first and then walks out to the
 * function that owns it. Without a ceiling that walk can land on the module-wide
 * IIFE that obfuscator.io wraps the whole program in, and deleting it would
 * delete the program. The real traps are 50-200 nodes.
 */
const MAX_TRAP_NODES = 512;
const MAX_TRAP_STATEMENTS = 8;

/** Payload strings that only ever appear in a debugger trap, whitespace removed. */
const DEBUGGER_PAYLOADS = new Set([
  'debugger',
  'debugger;',
  'while(true){}',
  'while(true);',
  'while(!![]){}',
  'for(;;){}',
  'for(;;);',
]);

/** The catastrophic-backtracking regex obfuscator.io uses as a beautifier tripwire. */
const REDOS_GUARD = '(((.+)+)+)+$';

/** Regex methods that consume a value by matching a pattern against its text. */
const SHAPE_PROBE_METHODS = new Set(['test', 'exec', 'search', 'match']);

/** Members that mean an expression is reading the page's own address. */
const LOCATION_MEMBERS = new Set(['hostname', 'href', 'host', 'origin', 'location', 'domain']);

/**
 * Globals a tamper wrapper is allowed to reach: pure built-in namespaces, and
 * the address objects a domain lock reads its host out of. Reaching one is not
 * on its own permission to *call* through it - see `INSPECTION_METHODS`.
 */
const INERT_GLOBAL_ROOTS = new Set([
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'RegExp',
  'Symbol', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
  'location', 'window', 'document', 'self', 'top', 'globalThis',
]);

/**
 * Methods that read a value and hand back a new one. A call through a global has
 * to name one of these, which is what separates `location.href.toLowerCase()`
 * from `location.reload()` and `String.fromCharCode(...)` from `document.write(...)`.
 */
const INSPECTION_METHODS = new Set([
  'toLowerCase', 'toUpperCase', 'toString', 'valueOf', 'trim', 'trimStart', 'trimEnd',
  'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith',
  'charAt', 'charCodeAt', 'codePointAt', 'at',
  'slice', 'substr', 'substring', 'split', 'join', 'reverse', 'concat', 'repeat',
  'padStart', 'padEnd', 'replace', 'replaceAll', 'match', 'matchAll', 'search',
  'test', 'exec', 'normalize', 'fromCharCode', 'fromCodePoint', 'hasOwnProperty',
]);

/** Minimum `debugger` statements before uniform placement can be called a flood. */
const MIN_DEBUGGER_FLOOD = 20;
/** Distinct functions the flood must span. Nobody hand-seeds breakpoints this widely. */
const MIN_FLOOD_FUNCTIONS = 8;
/** Share of the file's `debugger` statements that must sit in the mechanical position. */
const MIN_FLOOD_SHARE = 0.9;

/** Consumers that mean a `toString()` result is being *examined*, not just produced. */
const TOSTRING_INSPECTORS = new Set([
  'search',
  'indexOf',
  'lastIndexOf',
  'match',
  'test',
  'exec',
  'constructor',
  'charCodeAt',
  'replace',
  'includes',
]);

/**
 * The exact method list obfuscator.io's `disableConsoleOutput` overwrites, plus
 * the neighbouring names a hand-rolled equivalent tends to add. The seven core
 * names are what the emitted table always contains.
 */
const CORE_CONSOLE_METHODS = ['log', 'warn', 'info', 'error', 'exception', 'table', 'trace'];
const CONSOLE_METHODS = new Set([
  ...CORE_CONSOLE_METHODS,
  'debug',
  'dir',
  'dirxml',
  'group',
  'groupCollapsed',
  'groupEnd',
  'time',
  'timeEnd',
  'count',
  'assert',
]);

const TIMER_NAMES = new Set(['setInterval', 'setTimeout', 'setImmediate', 'requestAnimationFrame']);

type Family = 'debug-protection' | 'self-defending' | 'console-disable';

interface Finding {
  family: Family;
  evidence: string;
  confidence: number;
  /**
   * Either the function that implements the trap (whose declaration and call
   * sites both go), or - when `statement` is set - the single statement to drop.
   */
  target: NodePath;
  statement: boolean;
  /**
   * For a function that reads its own source: the read. The statement holding
   * it is the guard, and the function is a trap only if everything beside
   * that statement is inert; see `guardIsWholeFunction`.
   */
  guard?: NodePath;
}

/**
 * One thing a removal plan deletes.
 *
 * A trap is never a single function: it is a *construct* - the trap body, the
 * guard closure that reads it, the call controller that arms the guard, and the
 * statement that fires the whole thing. Each of those is a unit, and they only
 * make sense together, which is why removability is decided over the set rather
 * than one function at a time.
 */
interface Unit {
  path: NodePath;
  kind: 'statement' | 'declarator' | 'function-declaration' | 'sequence-element';
  /** Binding this unit declares. Every reference to it must land inside the plan. */
  name?: string;
}

interface Plan {
  units: Unit[];
  /** Call controllers the construct used, removable once nothing else wants them. */
  controllers: Set<Binding>;
}

/** Growth caps: a real construct is a handful of units found in one or two rounds. */
const MAX_PLAN_UNITS = 32;
const MAX_PLAN_ROUNDS = 8;

/** What actually happened to a finding: deleted outright, disarmed in place, or left alone. */
type Outcome = 'removed' | 'neutralised' | 'refused';

/**
 * One `debugger` keyword and the two facts that decide whether it was typed or
 * injected: where it sits in its block, and which function owns it.
 */
interface DebuggerSite {
  path: NodePath<t.DebuggerStatement>;
  /** Leads its block, preceded by nothing but other `debugger` statements. */
  injected: boolean;
  /** Enclosing function node, or `null` at the top level. Used to measure spread. */
  owner: t.Node | null;
}

/**
 * A source-integrity trampoline: a stub that checksums the printed source of the
 * real implementation and either forwards to it or hangs forever.
 */
interface Trampoline {
  guard: NodePath<t.IfStatement>;
  declarator: NodePath<t.VariableDeclarator>;
  /** Whether the forwarding branch is the consequent (so the other one hangs). */
  passIsConsequent: boolean;
  /** The single statement that calls the implementation. */
  live: t.Statement[];
}

/** Everything one traversal of the tree turns up. */
interface Signals {
  findings: Finding[];
  debuggers: DebuggerSite[];
  trampolines: Trampoline[];
}

/**
 * Anti-tamper code is recognised by *shape*, and a shape spans a whole function
 * plus its call sites, so this is a `run` pass: it collects every signal in one
 * traversal, resolves each to the region that owns it, and only then deletes.
 */
export const removeAntiTamperPass: Pass = {
  id: 'clean.anti-tamper',
  title: 'Remove debugger traps and self-defending',
  stage: 'clean',
  technique: 'antiTamperRemoval',
  run: (ctx) => removeTraps(ctx, 'every', 'clean.anti-tamper'),
};

/**
 * The guards that hang on reprinted source, for a run with `antiTamperRemoval`
 * off.
 *
 * Every preset reprints, and a guard that matches the program's own printed
 * text against a formatting pattern hangs on any text but the one it was
 * built with. Leaving it is not "the input's behaviour": the input runs, and
 * the reprinted output never returns. Removing the guard - a construct that
 * does nothing on the text it was built with, and only ever hangs on any
 * other - is the one rewrite under which the output does what the input did,
 * which is the whole of what the conservative preset promises. The debugger
 * traps, console stubs and domain locks the technique also strips fail the
 * same way before and after reprinting, so those stay with the technique.
 * `when` keeps this to one traversal: with the technique on, the pass above
 * handles every family from the same walk.
 */
export const removeReprintGuardsPass: Pass = {
  id: 'clean.reprint-guards',
  title: 'Remove guards that hang on reprinted source',
  stage: 'clean',
  technique: 'core',
  when: (ctx) => !ctx.config.techniques.antiTamperRemoval,
  run: (ctx) => removeTraps(ctx, 'reprint', 'clean.reprint-guards'),
};

/** Which families a run acts on: every one, or only the guards reprinting trips. */
type Families = 'every' | 'reprint';

/**
 * Evidence of the `self-defending` findings that read the program's own
 * printed text. A domain lock's hang is the same before and after reprinting
 * and is not among them.
 */
const REPRINT_EVIDENCE = new Set([
  'catastrophic-backtracking regex self-check',
  'function inspects its own toString() output',
  'function source matched against a formatting pattern',
]);

function trippedByReprint(finding: Finding): boolean {
  return finding.family === 'self-defending' && REPRINT_EVIDENCE.has(finding.evidence);
}

function removeTraps(ctx: PassContext, families: Families, pass: string): void {
  const collected = collect(ctx);
  const findings =
    families === 'every' ? collected.findings : collected.findings.filter(trippedByReprint);
  const debuggers = families === 'every' ? collected.debuggers : [];
  const trampolines = collected.trampolines;
  if (findings.length === 0 && debuggers.length === 0 && trampolines.length === 0) {
    // A refusal from an earlier round is about a construct no longer found.
    const refusals = standingRefusals(ctx);
    for (const key of refusals) ctx.retract(key);
    refusals.clear();
    // The hazard stands from `prepare.detect`. A round that finds no guard
    // after one that removed some has the removal to thank - the refused
    // finding was a second signal on the same construct - and settles it;
    // with no guard ever removed, the tree holds a guard this pass never
    // recognised, and the reason is what the reader needs.
    if (ctx.shared.get(GUARDS_REMOVED)) settleReprintHazard(ctx);
    else restateReprintHazard(ctx, pass);
    return;
  }

  // Self-defending guards this run disposed of and ones it left standing.
  // Only a run that reaches its end settles the hazard note: a return on the
  // budget below leaves whatever it had not got to in the output, which is
  // exactly the case the note exists for.
  let guardsRemoved = 0;
  let guardsRefused = 0;
  let refusedEvidence = '';

  // Collapse first: a trampoline is a rewrite rather than a deletion, and the
  // statement it leaves behind is what the constructs below are measured against.
  let collapsed = 0;
  for (const trampoline of trampolines) {
    if (ctx.isExhausted()) return;
    if (collapseTrampoline(trampoline, ctx)) collapsed++;
  }
  guardsRemoved += collapsed;
  if (collapsed > 0) {
    ctx.report(
      'self-defending',
      `${collapsed} source-integrity trampoline(s): a printed-source checksum guarding a call, hanging on mismatch`,
      0.95,
      collapsed,
    );
  }

  const controllers = new Set<Binding>();
  // A refusal is this round's word on a construct: the round that removes
  // it, or no longer finds it, withdraws the line. Tracked per family, since
  // the finding that removes a guard need not be the one that refused it.
  const refusals = standingRefusals(ctx);
  const refusedNow = new Map<string, Finding>();
  for (const finding of findings) {
    if (ctx.isExhausted()) return;
    // One per finding, so the report says how many of each shape were found
    // rather than only that the shape occurred.
    ctx.report(finding.family, finding.evidence, finding.confidence, 1);
    // Only a guard reprinting trips counts either way: a domain lock is of the
    // same family and hangs the same before and after, so removing one says
    // nothing about the hazard, and refusing one does not arm it.
    if (isDetached(finding.target)) {
      if (trippedByReprint(finding)) guardsRemoved++;
      continue;
    }
    const outcome = removeFinding(finding, ctx, controllers);
    if (outcome === 'neutralised') {
      ctx.note(
        'info',
        `Emptied a ${finding.family} function instead of deleting it: real code still references it (${finding.evidence}).`,
        finding.target.node?.loc,
      );
    } else if (outcome === 'refused') {
      refusedNow.set(refusalKey(finding), finding);
    }
    if (trippedByReprint(finding) && outcome !== 'refused') guardsRemoved++;
  }
  // A refusal is judged once the round's removals are done: two signals in
  // one construct - the guard's regex literal twice over - are two findings,
  // and the one refused first is gone with the construct the second removed.
  for (const [key, finding] of refusedNow) {
    if (isDetached(finding.target)) {
      if (trippedByReprint(finding)) guardsRemoved++;
      continue;
    }
    if (trippedByReprint(finding)) {
      guardsRefused++;
      refusedEvidence = finding.evidence;
    }
    refusals.add(key);
    ctx.note(
      'warning',
      `Left ${finding.family} in place: could not bound the code to delete (${finding.evidence}).`,
      finding.target.node?.loc,
      key,
    );
  }
  for (const key of refusals) {
    if (refusedNow.has(key) && !isDetached(refusedNow.get(key)!.target)) continue;
    refusals.delete(key);
    ctx.retract(key);
  }

  // The self-disabling "call controller" closure is shared between the
  // debugProtection and selfDefending transforms, so it can only go once the
  // last trap that called it has gone.
  for (const binding of controllers) removeSpentController(binding, ctx);

  // Last, because the constructs above carry `debugger` statements of their
  // own and the flood verdict has to be read off the file as it arrived.
  removeDebuggerFlood(debuggers, ctx);

  if (guardsRemoved > 0) ctx.shared.set(GUARDS_REMOVED, true);
  if (guardsRefused > 0) {
    armReprintHazard(
      ctx,
      refusedEvidence,
      `\`${pass}\` could not bound the guard to delete it, as its own note says, and nothing else removes it.`,
    );
  } else if (ctx.shared.get(GUARDS_REMOVED)) {
    settleReprintHazard(ctx);
  } else {
    // This round's findings were all of the other shapes: the guard the
    // fingerprint saw, if any, is one this pass did not recognise.
    restateReprintHazard(ctx, pass);
  }
}

/** Set once a run has removed a reprint-tripped guard, for the rounds after. */
const GUARDS_REMOVED = 'clean.anti-tamper:guards-removed';

/** One key per trap construct, by the node that owns it. */
function refusalKey(finding: Finding): string {
  const loc = finding.target.node?.loc?.start;
  return `clean.anti-tamper:refused:${finding.family}:${loc ? `${loc.line}:${loc.column}` : finding.evidence}`;
}

/** Keys of the refusal lines standing from earlier rounds. */
function standingRefusals(ctx: PassContext): Set<string> {
  const existing = ctx.shared.get('clean.anti-tamper:refusals');
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  ctx.shared.set('clean.anti-tamper:refusals', created);
  return created;
}

/** The standing hazard note, one entry replaced by each round's verdict on the guard. */
const REPRINT_HAZARD_KEY = 'clean.anti-tamper:reprint-hazard';

/**
 * Say, as an error, that the output will not run.
 *
 * A self-defending guard matches the program's own printed source and hangs on
 * any text but the one it was built with. Reprinting is the one thing every
 * run does, so an output that still carries the guard does not run whatever
 * else was done to it, and `verified: true` says only that it parses. Measured
 * on obfuscator.io's `selfDefending` build of a one-line program: the input
 * prints, and a `balanced` output cut off before this pass reached the
 * decoded guard never returns.
 *
 * The note stands from the moment `prepare.detect` sees such a guard. It is
 * one keyed entry: each round this pass runs replaces it with its own verdict
 * - the guard it could not bound, or no guard recognised in a tree whose
 * strings are still encoded - and the round that removes every guard takes
 * it back, so the report's last word on the guard describes the output.
 * `why` names what stands between the reader and a running output.
 */
export function armReprintHazard(ctx: PassContext, evidence: string, why: string): void {
  ctx.shared.set(REPRINT_HAZARD_KEY, evidence);
  ctx.note(
    'error',
    `The program inspects its own printed source (self-defending: ${evidence}) and hangs when ` +
      `the text is not the one it was built with, so this output will not run. ${why}`,
    undefined,
    REPRINT_HAZARD_KEY,
  );
}

/** Take the hazard note back: every guard this pass found is gone. */
function settleReprintHazard(ctx: PassContext): void {
  if (!ctx.shared.has(REPRINT_HAZARD_KEY)) return;
  ctx.shared.delete(REPRINT_HAZARD_KEY);
  ctx.retract(REPRINT_HAZARD_KEY);
}

/**
 * The hazard is armed and this round's tree holds no guard the pass reads: the
 * fingerprint saw the shape, and what keeps the guard from being recognised
 * here is that its member names are still decoder calls. Said in place of
 * the standing line, so a run that never decodes them ends with the reason.
 */
function restateReprintHazard(ctx: PassContext, pass: string): void {
  const evidence = ctx.shared.get(REPRINT_HAZARD_KEY);
  if (typeof evidence !== 'string') return;
  armReprintHazard(
    ctx,
    evidence,
    `\`${pass}\` found no guard it recognises in the tree as it stands: the guard's ` +
      `member names are still encoded, or its shape is not one this pass reads, so nothing removed it.`,
  );
}

// ---------------------------------------------------------------------------
// Signal collection
// ---------------------------------------------------------------------------

function collect(ctx: PassContext): Signals {
  const byTarget = new Map<t.Node, Finding>();
  const debuggers: DebuggerSite[] = [];
  const trampolines: Trampoline[] = [];
  const add = (finding: Finding): void => {
    const key = finding.target.node;
    if (!key) return;
    const existing = byTarget.get(key);
    if (existing && existing.confidence >= finding.confidence) return;
    byTarget.set(key, finding);
  };

  traverse(ctx.ast, {
    CallExpression(path) {
      inspectDebuggerPayload(path, add);
      inspectSelfToString(path, add);
      inspectSourceShapeProbe(path, add);
    },
    NewExpression(path) {
      inspectDebuggerPayload(path, add);
    },
    DebuggerStatement(path) {
      inspectDebuggerStatement(path, add);
      debuggers.push({
        path,
        injected: leadsItsBlock(path),
        owner: path.getFunctionParent()?.node ?? null,
      });
    },
    IfStatement(path) {
      inspectDomainLock(path, add);
    },
    Function(path) {
      const trampoline = readTrampoline(path);
      if (trampoline) trampolines.push(trampoline);
    },
    StringLiteral(path) {
      if (path.node.value !== REDOS_GUARD) return;
      const fn = path.getFunctionParent();
      if (!fn || !isSelfContained(fn)) return;
      add({
        family: 'self-defending',
        evidence: 'catastrophic-backtracking regex self-check',
        confidence: 0.95,
        target: fn,
        statement: false,
      });
    },
    ArrayExpression(path) {
      inspectConsoleMethodTable(path, add);
    },
    ExpressionStatement(path) {
      inspectConsoleNoop(path, add);
    },
  });

  return { findings: [...byTarget.values()], debuggers, trampolines };
}

// ---------------------------------------------------------------------------
// debugProtection
// ---------------------------------------------------------------------------

/**
 * `fn['constructor']('debu' + 'gger')` - the Function constructor reached through
 * an instance so that the token `debugger` never appears in the source. Nothing
 * legitimate compiles a function whose entire body is `debugger`.
 */
function inspectDebuggerPayload(
  path: NodePath<t.CallExpression | t.NewExpression>,
  add: (finding: Finding) => void,
): void {
  const payload = debuggerPayload(path.node);
  if (payload === undefined) return;

  const evidence = `Function constructor called with ${JSON.stringify(payload)}`;
  const fn = path.getFunctionParent();
  const trap = fn ? debugTrapFunction(fn) : undefined;
  if (trap) {
    add({ family: 'debug-protection', evidence, confidence: 0.98, target: trap, statement: false });
    return;
  }

  // No enclosing trap function: the payload runs from a statement of its own,
  // e.g. `Function('debugger')();`. Dropping that statement is self-contained.
  const statement = enclosingPayloadStatement(path);
  if (statement) {
    add({
      family: 'debug-protection',
      evidence,
      confidence: 0.98,
      target: statement,
      statement: true,
    });
  }
}

/**
 * A `debugger` keyword is only removable as part of a recognised structure. A
 * bare one is something a human wrote and must survive untouched.
 */
function inspectDebuggerStatement(
  path: NodePath<t.DebuggerStatement>,
  add: (finding: Finding) => void,
): void {
  const fn = path.getFunctionParent();
  if (!fn) return;

  const trap = debugTrapFunction(fn);
  if (trap) {
    add({
      family: 'debug-protection',
      evidence: 'self-recursive debugger trap',
      confidence: 0.9,
      target: trap,
      statement: false,
    });
    return;
  }

  const heartbeat = timerHeartbeatStatement(fn);
  if (heartbeat) {
    add({
      family: 'debug-protection',
      evidence: 'debugger heartbeat on a timer',
      confidence: 0.9,
      target: heartbeat,
      statement: true,
    });
  }
}

/**
 * The function to delete for a trap signal found inside `fn`.
 *
 * The defining property is self-recursion with no base case: the trap re-enters
 * itself forever so a detached debugger cannot be stepped past. Where that inner
 * function sits inside a thin `try { ... } catch {}` dispatcher, the dispatcher is
 * the real unit - deleting only the inner half would leave it calling a name
 * that no longer exists.
 */
function debugTrapFunction(fn: NodePath): NodePath | undefined {
  if (!isSelfContained(fn)) return undefined;
  const name = ownName(fn);
  if (!name || !callsItself(fn, name)) return undefined;
  return trapDispatcher(fn, name) ?? fn;
}

function trapDispatcher(fn: NodePath, name: string): NodePath | undefined {
  if (!fn.isFunctionDeclaration()) return undefined;
  const outer = fn.getFunctionParent();
  if (!outer || !isSelfContained(outer)) return undefined;
  const body = blockBody(outer);
  if (!body || !body.some((statement) => t.isTryStatement(statement))) return undefined;

  // Everything the wrapper does must be about the trap: declare it, hold a few
  // locals, or dispatch to it. Anything else and the wrapper is real code.
  for (const statement of body) {
    if (statement === fn.node) continue;
    if (t.isVariableDeclaration(statement)) continue;
    if (!referencesName(statement, name)) return undefined;
  }
  return outer;
}

/** `setInterval(function () { debugger; }, 1000);` and friends. */
function timerHeartbeatStatement(fn: NodePath): NodePath<t.Statement> | undefined {
  const body = blockBody(fn);
  if (!body || body.length === 0) return undefined;
  if (!body.every((statement) => t.isDebuggerStatement(statement))) return undefined;

  const call = fn.parentPath;
  if (!call?.isCallExpression() || call.node.arguments[0] !== fn.node) return undefined;
  if (!isTimerCallee(call.node.callee)) return undefined;

  const statement = call.parentPath;
  return statement.isExpressionStatement() ? statement : undefined;
}

function debuggerPayload(node: t.CallExpression | t.NewExpression): string | undefined {
  if (!isFunctionConstructor(node.callee)) return undefined;
  for (const argument of node.arguments) {
    const text = foldToString(argument as t.Node);
    if (text === undefined) continue;
    if (DEBUGGER_PAYLOADS.has(text.replace(/\s+/g, ''))) return text;
  }
  return undefined;
}

function isFunctionConstructor(callee: t.Node): boolean {
  if (t.isIdentifier(callee, { name: 'Function' })) return true;
  return t.isMemberExpression(callee) && memberName(callee) === 'constructor';
}

/** The statement a payload call is the whole of, walking out through `.call(...)` tails. */
function enclosingPayloadStatement(path: NodePath): NodePath<t.Statement> | undefined {
  let current: NodePath = path;
  for (let depth = 0; depth < 6; depth++) {
    const parent: NodePath | null = current.parentPath;
    if (!parent) return undefined;
    if (parent.isMemberExpression() && parent.node.object === current.node) {
      current = parent;
      continue;
    }
    if ((parent.isCallExpression() || parent.isNewExpression()) && parent.node.callee === current.node) {
      current = parent;
      continue;
    }
    return parent.isExpressionStatement() ? parent : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// selfDefending
// ---------------------------------------------------------------------------

/**
 * A function that reads its own source and checks the shape of it. Beautifying
 * the file changes that source, so the check exists to punish beautifying.
 *
 * "Its own" is what makes this safe to key on: the identifier being stringified
 * must resolve to a binding whose declaration *encloses* the check, which is only
 * true of a self-reference. A parameter or an outer helper never is.
 *
 * Two spellings of the same check: `f.toString()` handed to an inspector, and
 * an inspector called on the text however it was coerced - `('' + f).indexOf`,
 * `String(f).search`, `s.indexOf` with `s` holding `'' + f`; see
 * `coercedToText`.
 */
function inspectSelfToString(
  path: NodePath<t.CallExpression>,
  add: (finding: Finding) => void,
): void {
  const callee = path.node.callee;
  if (!t.isMemberExpression(callee)) return;
  const method = memberName(callee);
  const evidence = 'function inspects its own toString() output';
  if (method === 'toString') {
    if (!isInspected(path)) return;
    const root = referenceRoot(callee.object);
    if (!root) return;
    const binding = path.scope.getBinding(root);
    if (!binding || binding.kind === 'param' || binding.kind === 'module') return;
    if (!binding.path.isVariableDeclarator() && !binding.path.isFunction()) return;
    if (!binding.path.isAncestor(path)) {
      if (holdsFunction(binding)) addUnbounded(path, evidence, add);
      return;
    }
  } else if (method === undefined || !TOSTRING_INSPECTORS.has(method)) {
    return;
  } else if (!inspectsOwnSource(path, callee.object)) {
    if (inspectsFileFunction(path, callee.object)) addUnbounded(path, evidence, add);
    return;
  }

  const fn = path.getFunctionParent();
  if (!fn || !isSelfContained(fn)) return;
  add({
    family: 'self-defending',
    evidence,
    confidence: 0.9,
    target: fn,
    statement: false,
    guard: path,
  });
}

/**
 * A read of a function's printed text from outside that function - at the
 * top level, or in a sibling - is a guard this pass does not bound: the
 * finding is refused and the report says the output will not run, since the
 * reprint changes the text it reads. Left unsaid, the output hung with a
 * detection line claiming the guard was removed.
 */
function addUnbounded(path: NodePath<t.CallExpression>, evidence: string, add: (finding: Finding) => void): void {
  const statement = path.getStatementParent();
  add({ family: 'self-defending', evidence, confidence: 0.9, target: statement ?? path, statement: false, guard: path });
}

/** Whether the text read here is that of a function this file declares, enclosing the read or not. */
function inspectsFileFunction(path: NodePath<t.CallExpression>, node: t.Node | undefined): boolean {
  if (!node) return false;
  const subject = coercedToText(path, node) ?? node;
  if (!t.isIdentifier(subject)) return false;
  const binding = path.scope.getBinding(subject.name);
  if (!binding || binding.kind === 'param' || binding.kind === 'module') return false;
  return holdsFunction(binding);
}

/** Whether the value produced here is fed to something that tests it. */
function isInspected(path: NodePath): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  if (parent.isBinaryExpression()) return true;
  if (parent.isMemberExpression() && parent.node.object === path.node) {
    const property = memberName(parent.node);
    return property !== undefined && TOSTRING_INSPECTORS.has(property);
  }
  // `regexp.test(fn.toString())` - the string is the argument, not the receiver.
  if (parent.isCallExpression() && t.isMemberExpression(parent.node.callee)) {
    const property = memberName(parent.node.callee);
    return property !== undefined && TOSTRING_INSPECTORS.has(property);
  }
  return false;
}

/** Strip `.bind()` / `.call()` / property tails down to the identifier underneath. */
function referenceRoot(node: t.Node): string | undefined {
  let current = node;
  for (let depth = 0; depth < 6; depth++) {
    if (t.isIdentifier(current)) return current.name;
    if (t.isCallExpression(current)) {
      current = current.callee as t.Node;
      continue;
    }
    if (t.isMemberExpression(current)) {
      current = current.object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source-shape probes: the generalised selfDefending guard
// ---------------------------------------------------------------------------

/**
 * A guard that measures how the program was *printed*.
 *
 * `regExp.test(namedFunction)` never writes `toString`: passing a function where
 * a string is expected coerces it to its own source text, and the pattern then
 * asks whether that text still contains a newline. Beautified output does; the
 * one-line original did not. So the check is not protecting anything, it exists
 * to punish exactly the transformation this pass performs - and leaving it
 * behind means the output hangs where the input ran fine.
 *
 * Two independent facts have to line up before anything is deleted:
 *
 *  - the pattern describes source *shape* and nothing else (whitespace, line
 *    breaks, punctuation), so it cannot be matching real data, and
 *  - the value being measured is a function whose own declaration *encloses* the
 *    measurement, which is only ever true of a self-reference. A parameter, an
 *    import or an unrelated helper fails this and is left alone.
 *
 * The construct then goes as a whole through `isTrapOnly`, which refuses any
 * wrapper that reads a binding it does not own or writes anything it does not
 * declare - so a real function that happens to inspect itself survives.
 */
function inspectSourceShapeProbe(
  path: NodePath<t.CallExpression>,
  add: (finding: Finding) => void,
): void {
  const callee = path.node.callee;
  if (!t.isMemberExpression(callee)) return;
  const method = memberName(callee);
  if (method === undefined || !SHAPE_PROBE_METHODS.has(method)) return;

  // `pattern.test(subject)` and `subject.match(pattern)` are the same check with
  // the operands swapped, so both orientations are tried.
  const subject = path.node.arguments[0] as t.Node | undefined;
  const measuresSubject =
    measuresSourceShape(path, callee.object) && inspectsOwnSource(path, subject);
  const measuresReceiver =
    measuresSourceShape(path, subject) && inspectsOwnSource(path, callee.object);
  const evidence = 'function source matched against a formatting pattern';
  if (!measuresSubject && !measuresReceiver) {
    if (
      (measuresSourceShape(path, callee.object) && inspectsFileFunction(path, subject)) ||
      (measuresSourceShape(path, subject) && inspectsFileFunction(path, callee.object))
    ) {
      addUnbounded(path, evidence, add);
    }
    return;
  }
  const construct = enclosingTrapIife(path);
  if (construct) {
    add({ family: 'self-defending', evidence, confidence: 0.95, target: construct, statement: true });
    return;
  }
  // No wrapper around it is proved inert. A function that reads its own
  // source and does the program's work beside it is no trap, and is refused
  // outright so that the hazard is said rather than left to the fingerprint.
  const fn = path.getFunctionParent();
  if (!fn || !isSelfContained(fn) || guardIsWholeFunction(fn, path)) return;
  add({ family: 'self-defending', evidence, confidence: 0.95, target: fn, statement: false, guard: path });
}

/** Whether an expression resolves to a regex that only describes source layout. */
function measuresSourceShape(path: NodePath, node: t.Node | undefined): boolean {
  const pattern = regexPattern(path, node);
  return pattern !== undefined && isSourceShapePattern(pattern);
}

/** Resolve an expression to the regex source it stands for, following one alias. */
function regexPattern(path: NodePath, node: t.Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 4) return undefined;
  if (t.isRegExpLiteral(node)) return node.pattern;
  if (
    (t.isNewExpression(node) || t.isCallExpression(node)) &&
    t.isIdentifier(node.callee, { name: 'RegExp' })
  ) {
    return foldToString(node.arguments[0] as t.Node);
  }
  if (t.isIdentifier(node)) {
    const binding = path.scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0) return undefined;
    if (!binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) return undefined;
    return regexPattern(binding.path, binding.path.node.init ?? undefined, depth + 1);
  }
  return foldToString(node);
}

/**
 * Whether this expression is a function reading *its own* text.
 *
 * The self-reference is the whole safety argument: the identifier has to resolve
 * to a function-valued binding whose declaration is an ancestor of the call, so
 * the only thing being measured is the code doing the measuring.
 */
function inspectsOwnSource(path: NodePath<t.CallExpression>, node: t.Node | undefined): boolean {
  if (!node) return false;
  const subject = coercedToText(path, node) ?? node;
  if (!t.isIdentifier(subject)) return false;

  const binding = path.scope.getBinding(subject.name);
  if (!binding || binding.kind === 'param' || binding.kind === 'module') return false;
  if (!holdsFunction(binding)) return false;
  return binding.path.isAncestor(path);
}

/**
 * The value whose text this expression is, for the explicit spellings of the
 * coercion a bare `re.test(fn)` performs implicitly - `fn.toString()`,
 * `String(fn)`, `'' + fn`, `fn + ''` - and for a name declared once holding
 * one of them, `var s = '' + fn`. Anything else is not a text this pass reads.
 */
function coercedToText(path: NodePath, node: t.Node, depth = 0): t.Node | undefined {
  if (depth > 4) return undefined;
  if (t.isCallExpression(node)) {
    const inner = node.callee;
    if (t.isMemberExpression(inner) && memberName(inner) === 'toString') return inner.object;
    if (t.isIdentifier(inner, { name: 'String' }) && node.arguments.length === 1) return node.arguments[0] as t.Node;
    return undefined;
  }
  if (t.isBinaryExpression(node) && node.operator === '+') {
    if (isEmptyString(node.left)) return node.right;
    if (isEmptyString(node.right) && t.isExpression(node.left)) return node.left;
    return undefined;
  }
  if (t.isIdentifier(node)) {
    const binding = path.scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0 || !binding.path.isVariableDeclarator()) return undefined;
    const init = binding.path.node.init;
    return init ? coercedToText(binding.path, init, depth + 1) : undefined;
  }
  return undefined;
}

function isEmptyString(node: t.Node): boolean {
  if (t.isStringLiteral(node)) return node.value === '';
  return t.isTemplateLiteral(node) && node.expressions.length === 0 && node.quasis[0]?.value.cooked === '';
}

function holdsFunction(binding: Binding): boolean {
  if (binding.path.isFunction()) return true;
  if (!binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) return false;
  const init = binding.path.node.init;
  return t.isFunctionExpression(init) || t.isArrowFunctionExpression(init);
}

// ---------------------------------------------------------------------------
// Domain lock
// ---------------------------------------------------------------------------

/**
 * A guard on the page's own address whose failure branch is a loop that never
 * exits and never does anything.
 *
 * The hostname read is deliberately *not* the signal - real code reads
 * `location.hostname` constantly, and deleting those checks would change what a
 * program does. The signal is the failure branch: an empty non-terminating loop
 * is not a behaviour anyone wants, it is a punishment for running the code
 * somewhere it was not licensed to run. A host check that redirects, logs,
 * throws or returns fails `branchHangs` and is left exactly as written.
 *
 * What is removed is the whole wrapper, and only after `isTrapOnly` proves it
 * reads no binding it does not own and writes nothing it did not declare - so a
 * lock woven into real code is refused rather than guessed at.
 */
function inspectDomainLock(path: NodePath<t.IfStatement>, add: (finding: Finding) => void): void {
  if (!branchHangs(path.node.consequent) && !branchHangs(path.node.alternate)) return;

  let fn: NodePath | null = path.getFunctionParent();
  for (let level = 0; fn && level < 3; level++) {
    const statement = iifeStatement(fn);
    if (statement) {
      if (!readsLocation(fn.node)) return;
      if (!isInertWrapper(statement)) return;
      add({
        family: 'self-defending',
        evidence: 'domain lock: host comparison whose failure branch is a non-terminating empty loop',
        confidence: 0.95,
        target: statement,
        statement: true,
      });
      return;
    }
    fn = fn.getFunctionParent();
  }
}

/** Whether a subtree reads the current document's address. */
function readsLocation(node: t.Node): boolean {
  return containsNode(node, (candidate) => {
    if (t.isIdentifier(candidate, { name: 'location' })) return true;
    if (!t.isMemberExpression(candidate)) return false;
    const name = memberName(candidate);
    return name !== undefined && LOCATION_MEMBERS.has(name);
  });
}

// ---------------------------------------------------------------------------
// Source-integrity trampolines
// ---------------------------------------------------------------------------

/**
 * The stub this protector wraps every shared function in:
 *
 *     function G(a, b) {
 *       var digest = impl.k || (impl.k = hash(impl, 4785466));
 *       if (digest === 1228482746886050) { return impl(a, b); } else { while (true) {} }
 *     }
 *
 * `hash` stringifies `impl` and digests the result, so the comparison is a
 * checksum over the implementation's *printed source*. Any reformatting fails
 * it, which is what makes this a correctness problem rather than a tidiness one:
 * left in place, every call in the output hangs.
 *
 * Nor is there a meaningful check to preserve. The construct has exactly two
 * outcomes - call the implementation, or never return - so collapsing it to the
 * call is precisely what the untampered program does, and it is the only outcome
 * that leaves the program runnable.
 *
 * Recognition is entirely structural: a two-statement body, a memoised digest of
 * a named value, an equality against a numeric constant on the name just bound,
 * a branch that forwards to that same value, and a branch that hangs. Nothing
 * here keys on an identifier's spelling.
 */
function readTrampoline(fn: NodePath): Trampoline | undefined {
  if (!fn.isFunction()) return undefined;
  const bodyPath = fn.get('body') as NodePath;
  if (!bodyPath.isBlockStatement()) return undefined;
  if (bodyPath.node.directives.length > 0 || bodyPath.node.body.length !== 2) return undefined;

  const [declaration, guard] = bodyPath.node.body;
  if (!t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1) return undefined;
  if (!t.isIfStatement(guard)) return undefined;

  const declarator = declaration.declarations[0];
  if (!declarator || !t.isIdentifier(declarator.id)) return undefined;
  const digest = declarator.id.name;

  const target = digestedName(declarator.init);
  if (target === undefined) return undefined;

  const equality = comparesToConstant(guard.test, digest);
  if (equality === undefined) return undefined;

  const passIsConsequent = equality;
  const pass = passIsConsequent ? guard.consequent : guard.alternate;
  const fail = passIsConsequent ? guard.alternate : guard.consequent;
  if (!branchHangs(fail)) return undefined;

  const live = forwardingBranch(pass, target);
  if (!live) return undefined;

  // The implementation has to be a stable binding other than this stub, or the
  // "forward" branch is really a recursion and collapsing it would spin.
  const binding = fn.scope.getBinding(target);
  if (!binding || binding.constantViolations.length > 0) return undefined;
  if (binding.path.node === fn.node) return undefined;

  const guardPath = bodyPath.get('body.1') as NodePath;
  const declaratorPath = bodyPath.get('body.0.declarations.0') as NodePath;
  if (!guardPath.isIfStatement() || !declaratorPath.isVariableDeclarator()) return undefined;

  return {
    guard: guardPath,
    declarator: declaratorPath,
    passIsConsequent,
    live,
  };
}

/** `impl.k || (impl.k = hash(impl, seed))` - the name whose source is digested. */
function digestedName(init: t.Node | null | undefined): string | undefined {
  if (!init || !t.isLogicalExpression(init) || init.operator !== '||') return undefined;

  const cached = init.left;
  if (!t.isMemberExpression(cached) || !t.isIdentifier(cached.object)) return undefined;
  const name = cached.object.name;
  const slot = memberName(cached);
  if (slot === undefined) return undefined;

  const store = init.right;
  if (!t.isAssignmentExpression(store) || store.operator !== '=') return undefined;
  const left = store.left;
  if (!t.isMemberExpression(left) || !t.isIdentifier(left.object, { name })) return undefined;
  if (memberName(left) !== slot) return undefined;

  // The value being digested has to be the implementation itself, and the digest
  // has to come from somewhere else - a self-call would be the implementation.
  const call = store.right;
  if (!t.isCallExpression(call) || t.isIdentifier(call.callee, { name })) return undefined;
  if (!call.arguments.some((argument) => t.isIdentifier(argument as t.Node, { name }))) return undefined;
  return name;
}

/**
 * Whether the test is `digest === <number>` (true) or `digest !== <number>`
 * (false) on the name just bound, or `undefined` when it is neither.
 */
function comparesToConstant(test: t.Expression, digest: string): boolean | undefined {
  if (!t.isBinaryExpression(test)) return undefined;
  const equal = test.operator === '===' || test.operator === '==';
  const unequal = test.operator === '!==' || test.operator === '!=';
  if (!equal && !unequal) return undefined;

  const left = test.left as t.Node;
  const matches =
    (t.isIdentifier(left, { name: digest }) && staticNumber(test.right) !== undefined) ||
    (t.isIdentifier(test.right, { name: digest }) && staticNumber(left) !== undefined);
  return matches ? equal : undefined;
}

/** A branch that does nothing but call `target` and hand back what it returned. */
function forwardingBranch(
  branch: t.Statement | null | undefined,
  target: string,
): t.Statement[] | undefined {
  if (!branch) return undefined;
  if (t.isBlockStatement(branch) && branch.directives.length > 0) return undefined;
  const statements = t.isBlockStatement(branch) ? branch.body : [branch];
  const real = statements.filter((s) => !t.isDebuggerStatement(s) && !t.isEmptyStatement(s));
  if (real.length !== 1) return undefined;

  const only = real[0] as t.Statement;
  const call = t.isReturnStatement(only)
    ? only.argument
    : t.isExpressionStatement(only)
      ? only.expression
      : undefined;
  if (!call || !t.isCallExpression(call)) return undefined;
  if (!t.isIdentifier(call.callee, { name: target })) return undefined;
  return [only];
}

function collapseTrampoline(trampoline: Trampoline, ctx: PassContext): boolean {
  const { guard, declarator } = trampoline;
  if (isDetached(guard) || isDetached(declarator)) return false;

  // Hand back the references the checksum held so the hash helper can be pruned.
  releaseReferences(guard.get('test') as NodePath);
  const dead = guard.get(trampoline.passIsConsequent ? 'alternate' : 'consequent') as NodePath;
  if (dead.node) releaseReferences(dead);

  guard.replaceWithMultiple(trampoline.live);
  removeDeclarator(declarator, ctx);
  ctx.markChanged();
  return true;
}

// ---------------------------------------------------------------------------
// Debugger flood
// ---------------------------------------------------------------------------

/**
 * Delete a mechanically injected `debugger` flood.
 *
 * A `debugger` a human wrote has to survive: it marks a place someone chose to
 * stop, and silently deleting it destroys work. So the flood is not recognised
 * by counting keywords - it is recognised by *placement*. This protector
 * prepends `debugger` to the head of a block, everywhere, which produces three
 * facts at once that hand-written breakpoints never produce together:
 *
 *   - volume:      at least 20 of them in the file,
 *   - spread:      across at least 8 distinct functions,
 *   - uniformity:  at least 90% lead their block, preceded by nothing but other
 *                  `debugger` statements.
 *
 * A file with one or two breakpoints fails the volume test and is untouched. A
 * file where someone parked a `debugger` in the middle of a function keeps that
 * one even when the rest of the file is flooded, because only the statements in
 * the mechanical position are removed.
 */
function removeDebuggerFlood(sites: DebuggerSite[], ctx: PassContext): void {
  if (sites.length < MIN_DEBUGGER_FLOOD) return;

  const injected = sites.filter((site) => site.injected);
  if (injected.length / sites.length < MIN_FLOOD_SHARE) return;
  const owners = new Set(injected.map((site) => site.owner));
  if (owners.size < MIN_FLOOD_FUNCTIONS) return;

  let removed = 0;
  for (const site of injected) {
    if (isDetached(site.path)) continue;
    site.path.remove();
    removed++;
  }
  if (removed === 0) return;

  ctx.report(
    'debug-protection',
    `${removed} debugger statements injected at the head of a block across ${owners.size} functions`,
    0.95,
    removed,
  );
  ctx.markChanged(removed);
}

/** Whether a `debugger` leads its block, after nothing but other `debugger`s. */
function leadsItsBlock(path: NodePath<t.DebuggerStatement>): boolean {
  const parent = path.parentPath;
  if (!parent.isBlockStatement() && !parent.isProgram()) return false;
  const body = (parent.node as t.BlockStatement | t.Program).body;
  const index = body.indexOf(path.node);
  if (index < 0) return false;
  for (let i = 0; i < index; i++) {
    if (!t.isDebuggerStatement(body[i] as t.Node)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Trap wrappers
//
// Nothing in this pass removes a hang trap on its own. `while (1) {}` only ever
// goes as part of a construct that has already been recognised - a self-source
// probe, a domain lock, or an integrity trampoline - so a deliberate spin loop
// in real code is never even a candidate. What counts as a hang trap is defined
// once, in `analysis/detect` (`isHangTrap` / `branchHangs`), so the fingerprint
// the user is shown and the code this pass deletes can never disagree.
// ---------------------------------------------------------------------------

/**
 * The statement an IIFE is the whole of: `(function () { ... })();`,
 * `void function () { ... }();`, `(function () { ... }).call(this);`.
 *
 * This is the boundary that makes whole-construct removal decidable. A wrapper
 * invoked in statement position produces a value nobody reads, so once the body
 * is proved inert the statement can go without leaving a hole behind.
 */
function iifeStatement(fn: NodePath): NodePath<t.Statement> | undefined {
  if (!fn.isFunctionExpression() && !fn.isArrowFunctionExpression()) return undefined;
  const parent = fn.parentPath;
  if (!parent) return undefined;

  let call: NodePath | undefined;
  if (parent.isCallExpression() && parent.node.callee === fn.node) {
    call = parent;
  } else if (parent.isMemberExpression() && parent.node.object === fn.node) {
    const method = memberName(parent.node);
    if (method !== 'call' && method !== 'apply') return undefined;
    const outer = parent.parentPath;
    if (outer?.isCallExpression() && outer.node.callee === parent.node) call = outer;
  }
  if (!call) return undefined;

  let host: NodePath | null = call.parentPath;
  // `void` and `!` are the two prefixes used to force a function *expression*;
  // both discard the value, so neither changes what removing the statement costs.
  if (host?.isUnaryExpression() && (host.node.operator === 'void' || host.node.operator === '!')) {
    host = host.parentPath;
  }
  return host?.isExpressionStatement() ? host : undefined;
}

/**
 * The wrapper statement a signal belongs to, once that statement is proved to
 * hold trap machinery and nothing else.
 */
function enclosingTrapIife(path: NodePath): NodePath<t.Statement> | undefined {
  let fn: NodePath | null = path.getFunctionParent();
  for (let level = 0; fn && level < 5; level++) {
    const statement = iifeStatement(fn);
    if (statement) return isInertWrapper(statement) ? statement : undefined;
    fn = fn.getFunctionParent();
  }
  return undefined;
}

/**
 * Whether deleting this wrapper can be observed by anything outside it.
 *
 * Two conditions, and both are needed. `isTrapOnly` establishes that the region
 * reads no binding it does not own and writes nothing it did not declare - but
 * it deliberately tolerates *unbound* names, because a guard body has to reach
 * `RegExp` and `String`, and there the region had already earned its place by
 * being armed through a call controller.
 *
 * A wrapper reached by climbing to the nearest IIFE has earned nothing, so the
 * second condition closes the hole that tolerance leaves: every call it makes
 * must be to something it declared itself, to a literal, or to a named
 * inspection method on a pure built-in. `boot()`, `document.write(...)` and
 * `location.reload()` all fail that, and the wrapper is left alone - which is
 * the whole point, because those are the cases where the trap is entangled with
 * code that does something.
 */
function isInertWrapper(statement: NodePath<t.Statement>): boolean {
  if (!isTrapOnly({ path: statement, kind: 'statement' }, [], new Set())) return false;
  return callsNothingOutside(statement, statement);
}

/** Whether every call in `region` is inert relative to `wrapper`, with no tag function and no thrown value. */
function callsNothingOutside(region: NodePath, wrapper: NodePath): boolean {
  let inert = true;
  region.traverse({
    'CallExpression|NewExpression|OptionalCallExpression'(inner) {
      if (isInertCallee(inner.get('callee') as NodePath, wrapper)) return;
      inert = false;
      inner.stop();
    },
    // A tag function and a thrown value both escape the wrapper.
    TaggedTemplateExpression(inner) {
      inert = false;
      inner.stop();
    },
    ThrowStatement(inner) {
      inert = false;
      inner.stop();
    },
  });
  return inert;
}

/**
 * Whether a function that reads its own source is the guard and nothing else:
 * beside the statement holding the read, only statements that call nothing
 * outside the function. The guard's own statement is the shape the pass
 * deletes - its branches run only on tampered text - and anything else the
 * function does runs on every text.
 */
function guardIsWholeFunction(fn: NodePath, guard: NodePath): boolean {
  if (!fn.isFunction()) return false;
  const body = fn.get('body') as NodePath;
  if (!body.isBlockStatement()) return true;
  for (const statement of body.get('body')) {
    if (contains(statement, guard)) continue;
    if (!callsNothingOutside(statement, fn)) return false;
  }
  return true;
}

function isInertCallee(callee: NodePath, wrapper: NodePath): boolean {
  const node = callee.node;
  if (!node) return false;

  // The wrapper's own invocation, and any nested IIFE: the body being entered is
  // inside the region under judgement, so it is covered by this same walk.
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;

  if (t.isIdentifier(node)) {
    return declaredInside(callee, node.name, wrapper) || INERT_GLOBAL_ROOTS.has(node.name);
  }
  if (!t.isMemberExpression(node)) return false;

  const owned = ownsReceiver(node.object, callee, wrapper);
  if (owned === 'own') return true;
  if (owned === 'foreign') return false;

  // The receiver came from outside, so the method name is what decides: reading
  // `location.href` is free, calling `location.reload()` is not.
  const method = memberName(node);
  return method !== undefined && INSPECTION_METHODS.has(method);
}

/**
 * Where a method call's receiver came from.
 *
 * `own` - every value it can be was built inside the wrapper or is a literal, so
 * calling into it is as contained as the wrapper is. `global` - it bottoms out
 * at a pure built-in namespace, which is safe to *read* but where the method
 * name still has to be checked. `foreign` - anything else, and the wrapper stays.
 */
function ownsReceiver(
  node: t.Node,
  callee: NodePath,
  wrapper: NodePath,
  depth = 0,
): 'own' | 'global' | 'foreign' {
  if (depth > 16) return 'foreign';

  if (t.isMemberExpression(node)) return ownsReceiver(node.object, callee, wrapper, depth + 1);
  if (t.isCallExpression(node)) return ownsReceiver(node.callee as t.Node, callee, wrapper, depth + 1);
  if (t.isTSNonNullExpression(node) || t.isTypeCastExpression(node)) {
    return ownsReceiver(node.expression, callee, wrapper, depth + 1);
  }

  // A value chosen between branches is only owned when *every* branch is.
  if (t.isConditionalExpression(node)) {
    return worse(
      ownsReceiver(node.consequent, callee, wrapper, depth + 1),
      ownsReceiver(node.alternate, callee, wrapper, depth + 1),
    );
  }
  if (t.isLogicalExpression(node) || (t.isBinaryExpression(node) && t.isExpression(node.left))) {
    return worse(
      ownsReceiver(node.left, callee, wrapper, depth + 1),
      ownsReceiver(node.right, callee, wrapper, depth + 1),
    );
  }
  if (t.isSequenceExpression(node)) {
    const last = node.expressions[node.expressions.length - 1];
    return last ? ownsReceiver(last, callee, wrapper, depth + 1) : 'foreign';
  }

  if (t.isIdentifier(node)) {
    if (declaredInside(callee, node.name, wrapper)) return 'own';
    return INERT_GLOBAL_ROOTS.has(node.name) ? 'global' : 'foreign';
  }
  if (
    t.isStringLiteral(node) ||
    t.isTemplateLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isArrayExpression(node) ||
    t.isObjectExpression(node) ||
    t.isRegExpLiteral(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isUnaryExpression(node)
  ) {
    return 'own';
  }
  return 'foreign';
}

function worse(a: 'own' | 'global' | 'foreign', b: 'own' | 'global' | 'foreign'): 'own' | 'global' | 'foreign' {
  if (a === 'foreign' || b === 'foreign') return 'foreign';
  return a === 'global' || b === 'global' ? 'global' : 'own';
}

function declaredInside(path: NodePath, name: string, wrapper: NodePath): boolean {
  const binding = path.scope.getBinding(name);
  return binding !== undefined && contains(wrapper, binding.path);
}

/**
 * The shared controller: `(function () { var first = true; return function (self, fn)
 * { ... fn.apply(self, arguments) ... }; }())`. It is inert on its own, so it is only
 * removed once every trap that used it is gone.
 */
function isCallController(node: t.Node | null | undefined): boolean {
  if (!node || !t.isCallExpression(node) || node.arguments.length > 0) return false;
  const callee = node.callee;
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return false;
  if (!t.isBlockStatement(callee.body)) return false;

  let latch = false;
  let factory = false;
  for (const statement of callee.body.body) {
    if (t.isVariableDeclaration(statement)) {
      for (const declarator of statement.declarations) {
        if (declarator.init && isBooleanish(declarator.init)) latch = true;
      }
    }
    if (
      t.isReturnStatement(statement) &&
      t.isFunctionExpression(statement.argument) &&
      statement.argument.params.length === 2
    ) {
      factory = true;
    }
  }
  return latch && factory;
}

function isBooleanish(node: t.Node): boolean {
  if (t.isBooleanLiteral(node)) return true;
  return t.isUnaryExpression(node) && node.operator === '!';
}

function removeSpentController(binding: Binding, ctx: PassContext): void {
  if (binding.references > 0 || binding.constantViolations.length > 0) return;
  const path = binding.path;
  if (!path.isVariableDeclarator() || isDetached(path)) return;
  if (!isCallController(path.node.init)) return;
  removeDeclarator(path, ctx);
}

// ---------------------------------------------------------------------------
// disableConsoleOutput
// ---------------------------------------------------------------------------

/**
 * The generated form: a table of console method names, looped over to overwrite
 * each method on the real console with a bound no-op.
 */
function inspectConsoleMethodTable(
  path: NodePath<t.ArrayExpression>,
  add: (finding: Finding) => void,
): void {
  const names: string[] = [];
  for (const element of path.node.elements) {
    const name = element ? staticString(element) : undefined;
    if (name === undefined || !CONSOLE_METHODS.has(name)) return;
    names.push(name);
  }
  if (CORE_CONSOLE_METHODS.filter((name) => names.includes(name)).length < 5) return;

  // Without an enclosing function there is no boundary saying how much of the
  // surrounding code belongs to the transform.
  const fn = path.getFunctionParent();
  if (!fn || !isSelfContained(fn) || !mentionsConsole(fn)) return;
  add({
    family: 'console-disable',
    evidence: 'console method table overwritten in a loop',
    confidence: 0.95,
    target: fn,
    statement: false,
  });
}

/**
 * The calls that arm the program's `disableConsoleOutput` stubs,
 * `controller(this, stub)`, for the strings stage's reading of a stacked
 * build. The stub of a layer sits wherever that layer's obfuscator put it,
 * and in a build obfuscated twice that is the rotation wrapper of the layer
 * beneath - whose decoder is then refused before any tier for the
 * `Function`, `window` and console write the stub carries. The arming call
 * is what a reading replaces, with a function that does nothing: the value
 * the controller hands back is a function that runs the stub once, and
 * running it once is the whole of the construct's effect. Recognised as
 * `collect` recognises the family, and only ever replaced under the
 * technique that removes it.
 */
export function consoleDisableArmings(program: NodePath<t.Program>): NodePath<t.CallExpression>[] {
  const findings: Finding[] = [];
  program.traverse({
    ArrayExpression(path) {
      inspectConsoleMethodTable(path, (finding) => findings.push(finding));
    },
  });
  const armings: NodePath<t.CallExpression>[] = [];
  for (const { target } of findings) {
    const call = target.parentPath;
    if (!call?.isCallExpression() || !t.isIdentifier(call.node.callee)) continue;
    if (!call.node.arguments.some((argument) => (argument as t.Node) === target.node)) continue;
    const binding = call.scope.getBinding(call.node.callee.name);
    if (!binding || !isControllerBinding(binding)) continue;
    armings.push(call);
  }
  return armings;
}

/** The hand-written form: `console.log = console.warn = function () {};`. */
function inspectConsoleNoop(
  path: NodePath<t.ExpressionStatement>,
  add: (finding: Finding) => void,
): void {
  const methods = consoleNoopTargets(path.node.expression);
  if (!methods) return;
  add({
    family: 'console-disable',
    evidence: 'console methods reassigned to no-ops',
    confidence: 0.85,
    target: path,
    statement: true,
  });
}

/**
 * The console methods an expression silences, or `undefined` if it does anything
 * else. Assigning a *real* function to `console.log` is a logger, not
 * suppression, so only an empty function body qualifies.
 */
function consoleNoopTargets(node: t.Node, depth = 0): string[] | undefined {
  if (depth > 16) return undefined;
  if (t.isSequenceExpression(node)) {
    const all: string[] = [];
    for (const item of node.expressions) {
      const part = consoleNoopTargets(item, depth + 1);
      if (!part) return undefined;
      all.push(...part);
    }
    return all.length > 0 ? all : undefined;
  }
  if (!t.isAssignmentExpression(node) || node.operator !== '=') return undefined;
  const method = consoleMethodName(node.left);
  if (!method) return undefined;
  if (isNoopFunction(node.right)) return [method];
  const rest = consoleNoopTargets(node.right, depth + 1);
  return rest ? [method, ...rest] : undefined;
}

function consoleMethodName(node: t.Node): string | undefined {
  if (!t.isMemberExpression(node)) return undefined;
  const property = memberName(node);
  if (property === undefined || !CONSOLE_METHODS.has(property)) return undefined;
  const object = node.object;
  if (t.isIdentifier(object, { name: 'console' })) return property;
  if (t.isMemberExpression(object) && memberName(object) === 'console') return property;
  return undefined;
}

function isNoopFunction(node: t.Node): boolean {
  if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
  const body = node.body;
  return t.isBlockStatement(body) && body.body.length === 0 && body.directives.length === 0;
}

function mentionsConsole(fn: NodePath): boolean {
  return containsNode(fn.node, (node) => {
    if (t.isStringLiteral(node)) return node.value === 'console';
    if (t.isIdentifier(node)) return node.name === 'console';
    return false;
  });
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

function removeFinding(
  finding: Finding,
  ctx: PassContext,
  controllers: Set<Binding>,
): Outcome {
  if (finding.statement) {
    const path = finding.target;
    if (!path.isStatement()) return 'refused';
    releaseReferences(path);
    path.remove();
    ctx.markChanged();
    return 'removed';
  }

  // A function that reads its own source and also does the program's work is
  // not a trap: deleting or emptying it would take the work with the guard.
  if (finding.guard && !guardIsWholeFunction(finding.target, finding.guard)) return 'refused';

  const plan = planConstruct(finding.target);
  if (plan && execute(plan, ctx)) {
    for (const binding of plan.controllers) controllers.add(binding);
    return 'removed';
  }

  // Deleting a console shim that cannot be bounded would take real code with
  // it, so that family stops here. A debugger or self-defending trap is
  // different: it is still worth disarming even when its name is wired into
  // code that stays.
  if (finding.family === 'console-disable') return 'refused';
  return neutralise(finding.target, ctx) ? 'neutralised' : 'refused';
}

// ---------------------------------------------------------------------------
// Planning: grow the construct, then decide
// ---------------------------------------------------------------------------

/**
 * Everything that has to go for `seed` to be gone, or `undefined` if that set
 * cannot be closed.
 *
 * The reason a per-function decision fails on real obfuscator.io output is that
 * a trap's only callers live *inside its own guard* - `trap('init')` sits in the
 * closure that the controller arms, which is itself only reached from the
 * statement that fires it. Asking "does anything reference this function?" one
 * function at a time always answers yes and always refuses.
 *
 * So the set is grown instead: start at the trap, and for every reference decide
 * whether it can be deleted with a statement of its own or whether it belongs to
 * a region that is itself trap machinery. References that land inside a region
 * already in the plan cost nothing - they are going away with it. The plan is
 * only accepted once *every* reference to *every* binding it deletes is
 * accounted for, which is what makes deleting the whole thing safe.
 */
function planConstruct(seed: NodePath): Plan | undefined {
  const controllers = new Set<Binding>();
  const first = seedUnit(seed, controllers);
  if (!first) return undefined;
  const units: Unit[] = [first];

  for (let round = 0; round < MAX_PLAN_ROUNDS; round++) {
    let grew = false;
    let unresolved = false;

    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      if (!unit?.name) continue;

      const binding = unit.path.scope.getBinding(unit.name);
      // A shadowed name is a different binding than the one being deleted.
      if (!binding || binding.path.node !== unit.path.node) return undefined;
      // A trap that is reassigned is not a trap this pass understands.
      if (binding.constantViolations.length > 0) return undefined;

      for (const reference of binding.referencePaths) {
        if (isDetached(reference)) continue;
        if (insidePlan(units, reference)) continue;

        // The smallest region that works is always the safest one, so a use that
        // deletes cleanly on its own wins. The exception is a use that *is* some
        // closure's entire body: deleting it alone leaves an empty guard behind,
        // and if that guard is trap machinery too then the machinery is the real
        // unit. Falling back to the small use keeps the reference resolvable when
        // the surrounding region turns out to be real code.
        const use = removableUse(reference);
        const region = use && !emptiesItsHost(use) ? undefined : armingUnit(reference, units, controllers);
        const chosen = region ?? use;
        if (!chosen) {
          unresolved = true;
          continue;
        }
        if (addUnit(units, chosen)) grew = true;
      }
    }

    if (!unresolved) return { units, controllers };
    if (!grew || units.length > MAX_PLAN_UNITS) return undefined;
  }
  return undefined;
}

/** The unit the trap itself is: its declaration, or the region its value sits in. */
function seedUnit(fn: NodePath, controllers: Set<Binding>): Unit | undefined {
  if (fn.isFunctionDeclaration() && fn.node.id) {
    // The plan closes over `referencePaths`, and a sloppy block-level trap has
    // a use that list omits: Annex B.3.3 makes it a var of the enclosing
    // function or script too. `{ function t() { ... } } log(typeof t)` printed
    // `function` and, with the block's declaration deleted, `undefined`.
    if (blockFunctionOutsideUse(fn)) return undefined;
    return { path: fn, kind: 'function-declaration', name: fn.node.id.name };
  }
  const unit = discardedHost(fn, controllers);
  if (!unit) return undefined;
  // A binding keeps its own boundary; a statement has to earn one.
  if (unit.kind === 'declarator') return unit;
  return isTrapOnly(unit, [], controllers) ? unit : undefined;
}

function addUnit(units: Unit[], unit: Unit): boolean {
  for (const existing of units) if (existing.path.node === unit.path.node) return false;
  units.push(unit);
  return true;
}

function insidePlan(units: Unit[], path: NodePath): boolean {
  for (const unit of units) if (contains(unit.path, path)) return true;
  return false;
}

/** Subtree containment by node identity, safe on paths whose parents are gone. */
function contains(container: NodePath, path: NodePath): boolean {
  const target = container.node;
  if (!target) return false;
  let current: NodePath | null = path;
  for (let depth = 0; current && depth < 512; depth++) {
    if (current.node === target) return true;
    current = current.parentPath;
  }
  return false;
}

/**
 * Climb from an expression to the outermost place whose value nobody reads.
 *
 * Only two ways out are followed, because only two are provably value-preserving:
 * being the callee of a call, and being an argument to a recognised call
 * controller. Being any other argument would mean a real function received the
 * value, with no way to see what it did with it.
 */
function discardedHost(start: NodePath, controllers: Set<Binding>): Unit | undefined {
  let current: NodePath = start;
  for (let step = 0; step < 24; step++) {
    const parent: NodePath | null = current.parentPath;
    if (!parent) return undefined;

    if (parent.isMemberExpression() && parent.node.object === current.node) {
      current = parent;
      continue;
    }

    if (parent.isCallExpression() || parent.isNewExpression()) {
      if (parent.node.callee === current.node || isControllerInvocation(parent, current, controllers)) {
        current = parent;
        continue;
      }
      return undefined;
    }

    if (parent.isSequenceExpression()) {
      const list = parent.node.expressions;
      // Every element but the last is evaluated purely for its side effects.
      if (list[list.length - 1] !== current.node) {
        return { path: current, kind: 'sequence-element' };
      }
      current = parent;
      continue;
    }

    if (parent.isExpressionStatement()) {
      // `(function () { arm(); })()` - the wrapper exists only to hold the call,
      // so the construct is the whole wrapper, not the statement inside it.
      const wrapper = enclosingIifeCall(parent);
      if (wrapper) {
        current = wrapper;
        continue;
      }
      return { path: parent, kind: 'statement' };
    }

    if (
      parent.isVariableDeclarator() &&
      parent.node.init === current.node &&
      t.isIdentifier(parent.node.id)
    ) {
      return { path: parent, kind: 'declarator', name: parent.node.id.name };
    }

    return undefined;
  }
  return undefined;
}

/** The call of an IIFE whose entire body is `statement`, if that is what this is. */
function enclosingIifeCall(statement: NodePath<t.Statement>): NodePath | undefined {
  const block = statement.parentPath;
  if (!block?.isBlockStatement()) return undefined;
  if (block.node.body.length !== 1 || block.node.directives.length > 0) return undefined;

  const fn = block.parentPath;
  if (!fn) return undefined;
  if (!fn.isFunctionExpression() && !fn.isArrowFunctionExpression()) return undefined;
  if (fn.node.params.length > 0 || fn.node.async || fn.node.generator) return undefined;

  const parent = fn.parentPath;
  if (!parent) return undefined;
  if (parent.isCallExpression() && parent.node.callee === fn.node) return parent;
  // `(function () { ... }).call(this)` is the same wrapper with a receiver.
  if (parent.isMemberExpression() && parent.node.object === fn.node) {
    const method = memberName(parent.node);
    if (method !== 'call' && method !== 'apply') return undefined;
    const call = parent.parentPath;
    if (call?.isCallExpression() && call.node.callee === parent.node) return call;
  }
  return undefined;
}

/**
 * `controller(this, guard)` - the shared closure both transforms arm their guard
 * through. Passing a function to it is not the function escaping, because the
 * controller only ever calls it once and drops it.
 */
function isControllerInvocation(
  call: NodePath,
  argument: NodePath,
  controllers: Set<Binding>,
): boolean {
  if (!call.isCallExpression()) return false;
  const callee = call.node.callee;
  if (!t.isIdentifier(callee)) return false;
  if (!call.node.arguments.some((item) => (item as t.Node) === argument.node)) return false;

  const binding = call.scope.getBinding(callee.name);
  if (!binding || !isControllerBinding(binding)) return false;
  controllers.add(binding);
  return true;
}

function isControllerBinding(binding: Binding): boolean {
  const path = binding.path;
  return path.isVariableDeclarator() && isCallController(path.node.init);
}

/**
 * The region that arms a trap referenced from inside a guard closure.
 *
 * This is the step that makes whole-construct removal possible: the reference
 * itself is unremovable (`var f = trap('init')` needs its value), but the closure
 * it lives in is handed straight to a call controller or immediately invoked, and
 * *that* is a statement whose value nobody reads.
 */
function armingUnit(
  reference: NodePath,
  units: Unit[],
  controllers: Set<Binding>,
): Unit | undefined {
  let guard: NodePath | null = reference.getFunctionParent();
  for (let level = 0; guard && level < 4; level++) {
    const unit = discardedHost(guard, controllers);
    if (unit && (unit.kind === 'declarator' || isTrapOnly(unit, units, controllers))) return unit;
    guard = guard.getFunctionParent();
  }
  return undefined;
}

/**
 * Whether a region contains trap machinery and nothing else.
 *
 * This is the safety net under `armingUnit`: the climb can reach a statement
 * that also does real work, and deleting that would delete the program's
 * behaviour. A region qualifies only when every name it reads is either declared
 * inside it, already part of the construct, a call controller, or unbound - and
 * when it writes to nothing it does not own.
 *
 * Unbound names are the one liberty taken. A guard body reaches `RegExp`,
 * `Function` and `String`, and a region cannot be recognised without allowing
 * them. The reason that is safe enough here is what it took to get this far: the
 * region is only a candidate because a trap's guard closure is armed inside it,
 * through a call controller or a wrapper that exists to hold the call. Real code
 * does not appear in that position; anything a module actually owns is a binding
 * and is rejected above.
 */
function isTrapOnly(unit: Unit, units: Unit[], controllers: Set<Binding>): boolean {
  const root = unit.path;
  const node = root.node;
  if (!node || countNodes(node) > MAX_TRAP_NODES) return false;

  const seen: Binding[] = [];
  let clean = true;

  root.traverse({
    ReferencedIdentifier(inner) {
      const binding = inner.scope.getBinding(inner.node.name);
      if (!binding) return; // A global: dropping a read of it changes nothing.
      if (contains(root, binding.path)) return;
      if (insidePlan(units, binding.path)) return;
      if (isControllerBinding(binding)) {
        seen.push(binding);
        return;
      }
      clean = false;
      inner.stop();
    },
    AssignmentExpression(inner) {
      if (!writesInside(inner.get('left'), root, units)) {
        clean = false;
        inner.stop();
      }
    },
    UpdateExpression(inner) {
      if (!writesInside(inner.get('argument'), root, units)) {
        clean = false;
        inner.stop();
      }
    },
  });

  if (!clean) return false;
  for (const binding of seen) controllers.add(binding);
  return true;
}

/** True when an assignment target is state the region owns, so losing it is free. */
function writesInside(target: NodePath, root: NodePath, units: Unit[]): boolean {
  let node: t.Node | null | undefined = target.node;
  for (let depth = 0; depth < 8 && t.isMemberExpression(node); depth++) node = node.object;
  if (!t.isIdentifier(node)) return false;

  const binding = target.scope.getBinding(node.name);
  if (!binding) return false; // Writing to a global is a side effect we must keep.
  return contains(root, binding.path) || insidePlan(units, binding.path);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function execute(plan: Plan, ctx: PassContext): boolean {
  let removed = false;
  for (const unit of plan.units) {
    // A unit nested inside another already went with it.
    if (isDetached(unit.path)) continue;
    removeUnit(unit, ctx);
    removed = true;
  }
  return removed;
}

function removeUnit(unit: Unit, ctx: PassContext): void {
  if (unit.kind === 'declarator' && unit.path.isVariableDeclarator()) {
    removeDeclarator(unit.path, ctx);
    return;
  }

  if (unit.kind === 'sequence-element') {
    const sequence = unit.path.parentPath;
    releaseReferences(unit.path);
    unit.path.remove();
    // A one-element sequence is legal but nonsense to read; collapse it.
    if (sequence && !sequence.removed && sequence.isSequenceExpression()) {
      const remaining = sequence.node.expressions;
      if (remaining.length === 1 && remaining[0]) sequence.replaceWith(remaining[0]);
    }
    ctx.markChanged();
    return;
  }

  releaseReferences(unit.path);
  unit.path.remove();
  ctx.markChanged();
}

/**
 * Fallback for a trap the plan could not bound: real code holds its name, so the
 * declaration has to stay even though the body should not run.
 *
 * Keeping the binding and its arity while emptying the body leaves every
 * reference resolvable and every trap disarmed - but only when nothing can
 * observe the difference. `debugProtection` builds its payload as
 * `var f = protect('init'); ... f('0')`, so emptying that body turns `f` into
 * `undefined` and the output throws where the obfuscated input ran fine.
 *
 * Emitting broken code is strictly worse than leaving a trap in place, so an
 * unobservable body is a precondition, not an optimisation.
 */
function neutralise(fn: NodePath, ctx: PassContext): boolean {
  if (!fn.isFunction()) return false;
  // Emptying a body would contradict a declared return type.
  if ('returnType' in fn.node && fn.node.returnType) return false;
  const body = fn.get('body') as NodePath;
  if (!body.isBlockStatement()) return false;
  // Already disarmed - re-running must be a no-op.
  if (body.node.body.length === 0 && body.node.directives.length === 0) return false;
  if (returnValueIsUsed(fn)) return false;

  releaseReferences(body);
  body.replaceWith(t.blockStatement([]));
  ctx.markChanged();
  return true;
}

/**
 * True when emptying this function could change a value some other code reads.
 *
 * Two questions, in order. First: can a call of it evaluate to anything but
 * `undefined`? A trap whose body is `debugger; trap(++n);` already returns
 * `undefined`, so an empty body is indistinguishable no matter who calls it or
 * what they do with the result - and `handlers.onLoad = trap` is then perfectly
 * safe to disarm. Second, and only for a function that *does* produce a value:
 * is every call of it a statement on its own? `debugProtection` builds its
 * payload as `var f = protect('init'); ... f('0')`, and emptying `protect` there
 * turns `f` into `undefined` and makes the output throw where the obfuscated
 * input ran fine.
 *
 * Construction through `new` fails both ways round, since the caller observes
 * the properties the body would have written.
 */
function returnValueIsUsed(fn: NodePath): boolean {
  const produces = producesAValue(fn);

  const name = fn.isFunctionDeclaration() && fn.node.id ? fn.node.id.name : undefined;
  if (!name) return produces; // Cannot enumerate references, so assume the worst.
  // Nor for a block-level declaration whose hoisted var is read outside the
  // block: those reads are on no list here.
  if (fn.isFunctionDeclaration() && blockFunctionOutsideUse(fn)) return produces;

  const binding = fn.scope.parent?.getBinding(name) ?? fn.scope.getBinding(name);
  if (!binding) return produces;

  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    if (!parent) return true;
    if (parent.isNewExpression() && parent.node.callee === reference.node) return true;
    if (!produces) continue;
    // A bare mention that is not a call: the function itself escapes.
    if (!parent.isCallExpression() || parent.node.callee !== reference.node) return true;
    if (!parent.parentPath?.isExpressionStatement()) return true;
  }
  return false;
}

/** Whether calling this function can evaluate to anything other than `undefined`. */
function producesAValue(fn: NodePath): boolean {
  if (!fn.isFunction()) return true;
  const node = fn.node;
  // An async function resolves to its body's value; a generator yields.
  if (node.async || node.generator) return true;
  // A concise arrow body *is* the return value.
  if (!t.isBlockStatement(node.body)) return true;

  let found = false;
  fn.traverse({
    Function(inner) {
      inner.skip();
    },
    ReturnStatement(inner) {
      if (!inner.node.argument) return;
      found = true;
      inner.stop();
    },
  });
  return found;
}

/**
 * The unit a single reference to the trap can be deleted with, or `undefined`
 * when the reference feeds a value into something whose end is not visible.
 *
 * Deliberately narrow: a call standing alone as a statement, a call whose value
 * is thrown away as a non-final comma operand, a bare mention in the same
 * position, and the timer registration that schedules a trap. Anything else goes
 * to `armingUnit`, which has to prove a whole region instead.
 */
function removableUse(reference: NodePath): Unit | undefined {
  const parent = reference.parentPath;
  if (!parent) return undefined;

  if (parent.isExpressionStatement()) return { path: parent, kind: 'statement' };
  if (parent.isSequenceExpression()) return discardedOperand(reference);

  if (parent.isCallExpression()) {
    const isCallee = parent.node.callee === reference.node;
    const isTimerArgument =
      parent.node.arguments[0] === reference.node && isTimerCallee(parent.node.callee);
    if (!isCallee && !isTimerArgument) return undefined;

    const host = parent.parentPath;
    if (host.isExpressionStatement()) return { path: host, kind: 'statement' };
    if (host.isSequenceExpression()) return discardedOperand(parent);
    return undefined;
  }
  return undefined;
}

/** Whether deleting this unit would leave some closure with an empty body. */
function emptiesItsHost(unit: Unit): boolean {
  if (unit.kind !== 'statement') return false;
  const block = unit.path.parentPath;
  if (!block?.isBlockStatement()) return false;
  if (block.node.body.length !== 1 || block.node.directives.length > 0) return false;
  return block.parentPath?.isFunction() === true;
}

/** A comma operand whose value is discarded, so deleting it drops side effects only. */
function discardedOperand(element: NodePath): Unit | undefined {
  const sequence = element.parentPath;
  if (!sequence?.isSequenceExpression()) return undefined;
  const list = sequence.node.expressions;
  if (list[list.length - 1] === element.node) return undefined;
  return { path: element, kind: 'sequence-element' };
}

function isTimerCallee(callee: t.Node): boolean {
  if (t.isIdentifier(callee)) return TIMER_NAMES.has(callee.name);
  if (!t.isMemberExpression(callee)) return false;
  const name = memberName(callee);
  return name !== undefined && TIMER_NAMES.has(name);
}

function removeDeclarator(path: NodePath<t.VariableDeclarator>, ctx: PassContext): void {
  releaseReferences(path);
  const declaration = path.parentPath;
  if (declaration.isVariableDeclaration() && declaration.node.declarations.length === 1) {
    declaration.remove();
  } else {
    path.remove();
  }
  ctx.markChanged();
}

/**
 * Babel computes reference counts once per crawl, so a subtree about to be
 * deleted has to hand its references back - otherwise the controller still
 * looks used and `clean.unused` still sees names that no longer exist.
 */
function releaseReferences(path: NodePath): void {
  path.traverse({
    ReferencedIdentifier(inner) {
      inner.scope.getBinding(inner.node.name)?.dereference();
    },
  });
}

/** A path inside an already-deleted subtree still looks live from the outside. */
function isDetached(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (current.removed || !current.node) return true;
    if (current.isProgram()) return false;
    current = current.parentPath;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

function isSelfContained(fn: NodePath): boolean {
  if (!fn.isFunction()) return false;
  const body = blockBody(fn);
  if (body && body.length > MAX_TRAP_STATEMENTS) return false;
  return countNodes(fn.node) <= MAX_TRAP_NODES;
}

function blockBody(fn: NodePath): t.Statement[] | undefined {
  if (!fn.isFunction()) return undefined;
  const body = fn.node.body;
  return t.isBlockStatement(body) ? body.body : undefined;
}

/** The name a function is reachable by: its own id, or the variable holding it. */
function ownName(fn: NodePath): string | undefined {
  if (fn.isFunctionDeclaration() || fn.isFunctionExpression()) {
    if (fn.node.id) return fn.node.id.name;
  }
  const parent = fn.parentPath;
  if (parent?.isVariableDeclarator() && parent.node.init === fn.node && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  return undefined;
}

function callsItself(fn: NodePath, name: string): boolean {
  const binding = fn.scope.getBinding(name);
  if (!binding) return false;
  return binding.referencePaths.some(
    (reference) =>
      reference.parentPath?.isCallExpression() === true &&
      (reference.parentPath.node as t.CallExpression).callee === reference.node &&
      fn.isAncestor(reference),
  );
}

/** Static property name of a member expression, folding a concatenated key. */
function memberName(node: t.MemberExpression): string | undefined {
  if (!node.computed) return t.isIdentifier(node.property) ? node.property.name : undefined;
  return foldToString(node.property);
}

/** Resolve a node to a string, following the `'debu' + 'gger'` split the transform emits. */
function foldToString(node: t.Node | null | undefined, depth = 0): string | undefined {
  if (!node || depth > 16) return undefined;
  const direct = staticString(node);
  if (direct !== undefined) return direct;
  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = foldToString(node.left as t.Node, depth + 1);
    if (left === undefined) return undefined;
    const right = foldToString(node.right, depth + 1);
    return right === undefined ? undefined : left + right;
  }
  return undefined;
}

function referencesName(node: t.Node, name: string): boolean {
  return containsNode(node, (candidate) => t.isIdentifier(candidate) && candidate.name === name);
}

/** Structural subtree scan with a node budget; cheaper than a Babel traversal. */
function containsNode(root: t.Node, predicate: (node: t.Node) => boolean): boolean {
  let budget = MAX_TRAP_NODES * 4;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    if (budget-- <= 0) return false;
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    if (predicate(node)) return true;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}
