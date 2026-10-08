import type { NodePath } from '@babel/traverse';
import _traverse from '@babel/traverse';
import generateMod from '@babel/generator';
import * as t from '@babel/types';

import { readRegisterVm, type RegisterVm } from '../../src/analysis/dispatcher.js';
import { resolveConfig } from '../../src/config/presets.js';
import { parseSource } from '../../src/frontend/language.js';
import { buildPassList } from '../../src/passes/registry.js';
import { resolveNumericVector } from '../../src/passes/simplify/fold-constants.js';
import { describeRegisterVmRefusal } from '../../src/passes/structure/register-vm.js';
import { TreeOrder } from '../../src/util/ast.js';
import { Kernel } from '../../src/pipeline/kernel.js';
import { PipelineContext } from '../../src/pipeline/context.js';
import type { Pass } from '../../src/pipeline/pass.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;
const generate = ((generateMod as unknown as { default?: typeof generateMod }).default ??
  generateMod) as typeof generateMod;

/**
 * One register-VM dispatcher taken out of a real file and made runnable on its
 * own, so that the linearisation can be executed rather than read.
 */
export interface LiftedMachine {
  /**
   * `<host name>#<n>`, `n` counting recoverable machines in traversal order.
   * The obfuscator reuses names, and by `structure` the nodes have no `loc`, so
   * neither half identifies a machine on its own.
   */
  id: string;
  /** A whole program: the key function, the host, and the call that enters it. */
  source: string;
  /** Undecidable `if` tests rewritten to `guard(n)`; `2 ** guards` runs cover them all. */
  guards: number;
  /** Statements replaced by `log(n)`, i.e. how much of the body is opaque to the pass. */
  logs: number;
  /** Case bodies in the machine, and the length of the entry vector. */
  blocks: number;
  registers: number;
}

/** A machine that was recognised and recoverable but could not be made runnable. */
export interface SkippedMachine {
  id: string;
  reason: string;
}

export interface LiftResult {
  /** Register VMs `analysis/dispatcher` recognised in the post-`simplify` tree. */
  recognised: number;
  /** Of those, the ones `structure.register-vm` has no objection to. */
  recoverable: number;
  machines: LiftedMachine[];
  skipped: SkippedMachine[];
}

/**
 * Lift every recoverable register VM out of `source`.
 *
 * The machines are taken from the tree as it stands at the start of `structure`
 * - which is the tree the pass itself meets, four stages of rewriting later
 * than the file on disk - by running the real pipeline with a probe registered
 * immediately before `structure.register-vm`. Nothing here re-implements the
 * analysis: recognition is `readRegisterVm`, recoverability is
 * `describeRegisterVmRefusal`, and the entry vector is the same
 * `resolveNumericVector` the pass uses.
 *
 * TWO EDITS ARE MADE, and they are the only two:
 *
 * 1. A statement the pass treats as opaque - anything that is not a register
 *    write, a branch, or a jump - becomes `log(n)`. `log` records which
 *    statement ran and in what order, which is the observable the round-trip
 *    compares. Executing the real statement is not an option: it reads a frozen
 *    constant table, calls decoders, and pushes into structures that live in
 *    the other 3.8 MB of the file.
 * 2. An `if` test the pass cannot decide becomes `guard(n)`. The pass forks on
 *    such a test and emits both arms; driving `guard` through every assignment
 *    is what covers both of them, and what makes a linearisation that quietly
 *    picked one arm fail.
 *
 * Neither edit may move a register, or the machine that gets executed is no
 * longer the machine that was lifted. A statement that writes the register file
 * is therefore never replaced - it is kept verbatim if this lifter models it,
 * and the whole machine is skipped if it does not. Same for a statement whose
 * control flow escapes it (a `return` inside a loop body, a labelled `break`):
 * replacing it would change where the machine goes, so the machine is skipped
 * and counted in `skipped` rather than quietly altered.
 */
export async function liftRegisterVms(source: string, budgetMs = 600_000): Promise<LiftResult> {
  const config = resolveConfig({
    preset: 'aggressive',
    techniques: { controlFlowAnalysis: { registerVm: true } },
    performance: { verifyOutput: false, timeBudgetMs: budgetMs },
  });
  const parsed = parseSource(source, {});
  const ctx = new PipelineContext(
    parsed.ast,
    source,
    config,
    parsed.language,
    Date.now() + budgetMs,
  );

  const result: LiftResult = { recognised: 0, recoverable: 0, machines: [], skipped: [] };
  const maxStates = config.techniqueOptions.controlFlowAnalysis.maxRegisterVmStates;

  const probe: Pass = {
    id: 'test.lift-register-vms',
    title: 'Lift register VMs for the equivalence harness',
    stage: 'structure',
    technique: 'core',
    // One shot, before anything in `structure` has rewritten a thing.
    repeatable: false,
    run: (pass) => {
      // The order the pass places an entry vector's names by: the file is
      // eval-packed, so its source offsets were stripped with the packing.
      const order = new TreeOrder(pass.ast);
      traverse(pass.ast, {
        'WhileStatement|ForStatement'(path: NodePath) {
          const loop = path as NodePath<t.WhileStatement | t.ForStatement>;
          const vm = readRegisterVm(loop.node);
          if (!vm) return;
          result.recognised++;
          if (describeRegisterVmRefusal(loop, vm, maxStates, order) !== undefined) return;
          result.recoverable++;
          const lifted = lift(loop, vm, result.recoverable, order);
          if ('reason' in lifted) result.skipped.push(lifted);
          else result.machines.push(lifted);
        },
      });
    },
  };

  const passes = buildPassList();
  passes.splice(
    passes.findIndex((p) => p.id === 'structure.register-vm'),
    0,
    probe,
  );
  await new Kernel(passes, ctx).run();
  return result;
}

// ---------------------------------------------------------------------------
// Lifting one machine
// ---------------------------------------------------------------------------

function lift(
  loop: NodePath<t.WhileStatement | t.ForStatement>,
  vm: RegisterVm,
  ordinal: number,
  order: TreeOrder,
): LiftedMachine | SkippedMachine {
  const host = loop.getFunctionParent();
  const register = t.isIdentifier(vm.register) ? vm.register.name : undefined;
  const id = `${describeHost(host)}#${ordinal}`;
  if (!host || !register) return { id, reason: 'no host, or the register file is not a name' };
  if (!host.isFunctionDeclaration() || !host.node.id) {
    return { id, reason: 'the host is not a named function declaration' };
  }
  if (!t.isBlockStatement(host.node.body)) return { id, reason: 'the host has an expression body' };

  // Anything else in the host body would have to be lifted with the loop, and
  // `applyPrelude` has already had an opinion about it. Measured on
  // obfuscated4.js: every one of the 38 recoverable hosts is the loop alone.
  if (host.node.body.body.length !== 1 || host.node.body.body[0] !== loop.node) {
    return { id, reason: 'the host body holds statements besides the loop' };
  }

  const reducer = reducerDeclaration(loop, vm.keyName);
  if (!reducer) return { id, reason: `the key function ${vm.keyName} is not a declaration in scope` };

  const vector = entryVector(host, order);
  if (!vector) return { id, reason: 'the entry vector did not resolve to numbers' };

  // Clone before touching anything: this is the pipeline's own tree, and the
  // run continues after the probe returns.
  const clone = t.cloneNode(host.node, true) as t.FunctionDeclaration;
  const clonedLoop = (clone.body as t.BlockStatement).body[0] as t.WhileStatement | t.ForStatement;
  const clonedVm = readRegisterVm(clonedLoop);
  if (!clonedVm) return { id, reason: 'the clone no longer reads as a register VM' };

  const instrumented = instrument(clonedVm.switchNode, register);
  if ('reason' in instrumented) return { id, reason: instrumented.reason };

  const program = t.program([
    t.cloneNode(reducer, true),
    clone,
    t.expressionStatement(
      t.assignmentExpression(
        '=',
        t.identifier('result'),
        t.callExpression(t.identifier(host.node.id.name), [
          t.arrayExpression(vector.map((n) => numeric(n))),
        ]),
      ),
    ),
  ]);

  return {
    id,
    source: generate(program, { comments: false }).code,
    guards: instrumented.guards,
    logs: instrumented.logs,
    blocks: clonedVm.switchNode.cases.length,
    registers: vector.length,
  };
}

function describeHost(host: NodePath<t.Function> | null): string {
  if (host?.isFunctionDeclaration() && host.node.id) return host.node.id.name;
  return 'anonymous';
}

/** A NumericLiteral cannot hold a negative value; the parser spells it as a unary. */
function numeric(value: number): t.Expression {
  return value < 0
    ? t.unaryExpression('-', t.numericLiteral(-value))
    : t.numericLiteral(value);
}

function reducerDeclaration(
  loop: NodePath<t.Node>,
  keyName: string,
): t.FunctionDeclaration | undefined {
  const binding = loop.scope.getBinding(keyName);
  const node = binding?.path.node;
  return t.isFunctionDeclaration(node) && node.id ? node : undefined;
}

/**
 * The vector the machine is entered with.
 *
 * `describeRegisterVmRefusal` has already proven there is exactly one and that
 * it resolves, so the first call site is the whole answer; this only has to
 * read it back.
 */
function entryVector(host: NodePath<t.FunctionDeclaration>, order: TreeOrder): number[] | undefined {
  const name = host.node.id?.name;
  if (!name) return undefined;
  const binding = host.parentPath?.scope.getBinding(name);
  for (const reference of binding?.referencePaths ?? []) {
    const parent = reference.parentPath;
    if (!parent?.isCallExpression()) continue;
    const argument = parent.get('arguments')[0];
    if (!argument?.isArrayExpression()) continue;
    const vector = resolveNumericVector(argument, undefined, order);
    if (vector && vector.length > 0) return vector;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The two edits
// ---------------------------------------------------------------------------

interface Instrumented {
  guards: number;
  logs: number;
}

/** Rewrite every case body of `switchNode` in place. */
function instrument(
  switchNode: t.SwitchStatement,
  register: string,
): Instrumented | { reason: string } {
  let guards = 0;
  let logs = 0;
  let refusal: string | undefined;

  const call = (name: string, id: number): t.CallExpression =>
    t.callExpression(t.identifier(name), [t.numericLiteral(id)]);

  const rewrite = (statements: t.Statement[]): t.Statement[] =>
    statements.map((statement) => {
      if (refusal) return statement;

      if (t.isBlockStatement(statement)) {
        statement.body = rewrite(statement.body);
        return statement;
      }

      if (t.isIfStatement(statement)) {
        if (!decidable(statement.test, register)) {
          statement.test = call('guard', guards++);
        }
        statement.consequent = rewrite([statement.consequent])[0] as t.Statement;
        if (statement.alternate) {
          statement.alternate = rewrite([statement.alternate])[0] as t.Statement;
        }
        return statement;
      }

      // A jump is the machine's own control flow and always stays.
      if (t.isBreakStatement(statement) || t.isContinueStatement(statement)) {
        if (statement.label) refusal = 'a labelled jump in a case body';
        return statement;
      }

      // A register write is the machine. Kept verbatim when this lifter models
      // it the way the trace does, and otherwise the machine is refused rather
      // than instrumented - replacing a write is how a harness ends up proving
      // something about a machine that is not in the file.
      if (isRegisterWrite(statement, register)) {
        return modelledWrite(statement, register)
          ? statement
          : ((refusal = `a register write this lifter does not model: ${short(statement)}`),
            statement);
      }

      if (writesRegister(statement, register)) {
        refusal = `a register write buried in an opaque statement: ${short(statement)}`;
        return statement;
      }

      // `return <opaque>` keeps its `return` and loses its argument, so where
      // the machine stops is preserved and what it computes is not consulted.
      if (t.isReturnStatement(statement)) {
        if (!statement.argument) return statement;
        statement.argument = call('log', logs++);
        return statement;
      }

      const escape = escapes(statement);
      if (escape) {
        refusal = `an opaque statement whose control flow leaves it through ${escape}: ${short(statement)}`;
        return statement;
      }

      return t.expressionStatement(call('log', logs++));
    });

  for (const kase of switchNode.cases) kase.consequent = rewrite(kase.consequent);
  return refusal ? { reason: refusal } : { guards, logs };
}

function short(node: t.Node): string {
  const code = generate(node as never, { concise: true, comments: false }).code;
  return code.length > 110 ? `${code.slice(0, 110)}...` : code;
}

/** Only register reads and numeric literals - what the trace can evaluate. */
function decidable(node: t.Node, register: string): boolean {
  if (t.isNumericLiteral(node)) return true;
  if (t.isUnaryExpression(node)) return decidable(node.argument, register);
  if (t.isBinaryExpression(node)) {
    return t.isExpression(node.left) && decidable(node.left, register) && decidable(node.right, register);
  }
  if (t.isLogicalExpression(node)) {
    return decidable(node.left, register) && decidable(node.right, register);
  }
  if (t.isMemberExpression(node)) {
    return (
      node.computed &&
      t.isIdentifier(node.object, { name: register }) &&
      t.isExpression(node.property) &&
      decidable(node.property, register)
    );
  }
  return false;
}

/** `R[<index>] op= ...` or `R[<index>]++` as a statement of its own. */
function isRegisterWrite(statement: t.Statement, register: string): boolean {
  if (!t.isExpressionStatement(statement)) return false;
  const target = writeTarget(statement.expression);
  return target !== undefined && t.isIdentifier(target.object, { name: register });
}

function modelledWrite(statement: t.Statement, register: string): boolean {
  if (!t.isExpressionStatement(statement)) return false;
  const expression = statement.expression;
  const target = writeTarget(expression);
  if (!target || !decidable(target, register)) return false;
  if (t.isUpdateExpression(expression)) return true;
  return t.isAssignmentExpression(expression) && decidable(expression.right, register);
}

function writeTarget(expression: t.Expression): t.MemberExpression | undefined {
  if (t.isAssignmentExpression(expression) && t.isMemberExpression(expression.left)) {
    return expression.left;
  }
  if (t.isUpdateExpression(expression) && t.isMemberExpression(expression.argument)) {
    return expression.argument;
  }
  return undefined;
}

/**
 * Whether anything anywhere in `node` writes the register file.
 *
 * The question is about the *base* of an assignment target, not about mentions:
 * `R[3] = x` writes a register and `K[R[3]] = x` reads one, and the second is
 * by far the more common of the two in these bodies.
 *
 * Nested functions are not entered, and that is a borrowed proof rather than a
 * shortcut: `unsafeRegisterUse` refuses any machine whose host mentions the
 * register file inside a nested function at all, and this only ever runs on a
 * machine `describeRegisterVmRefusal` has already cleared. What is inside those
 * functions is a *different* binding of the same name - the obfuscator reuses
 * its identifiers, and `function (...OoKm8q) { OoKm8q[K[4]] = ... }` nested in a
 * host whose register is also `OoKm8q` is the file's normal shape, not a write.
 * Walking in anyway skips 6 of obfuscated4.js's well-behaved machines.
 */
function writesRegister(node: t.Node, register: string): boolean {
  let found = false;
  const walk = (current: t.Node): void => {
    if (found) return;
    if (t.isFunction(current) || t.isClass(current)) return;
    if (t.isAssignmentExpression(current)) {
      if (targetsRegister(current.left, register)) found = true;
    } else if (t.isUpdateExpression(current)) {
      if (targetsRegister(current.argument, register)) found = true;
    } else if (t.isUnaryExpression(current, { operator: 'delete' })) {
      if (targetsRegister(current.argument, register)) found = true;
    } else if (t.isForOfStatement(current) || t.isForInStatement(current)) {
      if (targetsRegister(current.left, register)) found = true;
    } else if (t.isVariableDeclarator(current) && targetsRegister(current.id, register)) {
      found = true;
    }
    if (found) return;
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      for (const item of Array.isArray(child) ? child : [child]) {
        if (item && typeof (item as t.Node).type === 'string') walk(item as t.Node);
      }
    }
  };
  walk(node);
  return found;
}

/** Whether assigning to `node` assigns to the register file or a slot of it. */
function targetsRegister(node: t.Node, register: string): boolean {
  if (t.isIdentifier(node)) return node.name === register;
  if (t.isMemberExpression(node)) return targetsRegister(node.object, register);
  if (t.isArrayPattern(node)) {
    return node.elements.some((element) => element !== null && targetsRegister(element, register));
  }
  if (t.isObjectPattern(node)) {
    return node.properties.some((property) =>
      t.isObjectProperty(property)
        ? targetsRegister(property.value, register)
        : targetsRegister(property.argument, register),
    );
  }
  if (t.isAssignmentPattern(node)) return targetsRegister(node.left, register);
  if (t.isRestElement(node)) return targetsRegister(node.argument, register);
  if (t.isVariableDeclaration(node)) {
    return node.declarations.some((declarator) => targetsRegister(declarator.id, register));
  }
  return false;
}

/**
 * Whether `node`'s control flow can leave `node`.
 *
 * A `for` loop with its own `break` is self-contained and may be replaced by
 * `log(n)`; one holding a `return`, a `throw` or a labelled jump is not, and a
 * machine holding one of those is skipped rather than rewritten into something
 * that stops somewhere else. A `label:` anywhere inside is refused outright
 * rather than scoped, which costs nothing here and cannot be got subtly wrong.
 */
function escapes(node: t.Node): string | undefined {
  let found: string | undefined;

  const walk = (current: t.Node, breakable: number, continuable: number): void => {
    if (found) return;
    if (t.isFunction(current) || t.isClass(current)) return; // its own return/break
    if (t.isReturnStatement(current)) {
      found = 'a `return`';
      return;
    }
    if (t.isThrowStatement(current)) {
      found = 'a `throw`';
      return;
    }
    if (t.isLabeledStatement(current)) {
      found = 'a label';
      return;
    }
    if (t.isBreakStatement(current)) {
      if (current.label) found = 'a labelled `break`';
      else if (breakable === 0) found = 'a `break`';
      return;
    }
    if (t.isContinueStatement(current)) {
      if (current.label) found = 'a labelled `continue`';
      else if (continuable === 0) found = 'a `continue`';
      return;
    }
    const loop = isLoop(current);
    const nextBreakable = breakable + (loop || t.isSwitchStatement(current) ? 1 : 0);
    const nextContinuable = continuable + (loop ? 1 : 0);
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      for (const item of Array.isArray(child) ? child : [child]) {
        if (item && typeof (item as t.Node).type === 'string') {
          walk(item as t.Node, nextBreakable, nextContinuable);
        }
      }
    }
  };

  walk(node, 0, 0);
  return found;
}

function isLoop(node: t.Node): boolean {
  return (
    t.isForStatement(node) ||
    t.isForInStatement(node) ||
    t.isForOfStatement(node) ||
    t.isWhileStatement(node) ||
    t.isDoWhileStatement(node)
  );
}
