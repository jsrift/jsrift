import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { ResolvedConfig } from '../../config/presets.js';
import { parseSource } from '../../frontend/language.js';
import { asSliceScope, isSelfContained, sliceForEvaluation, type SliceResult, type StatementScanCache } from '../slice.js';
import { globalNames } from './builtins.js';
import { GLOBAL_OBJECT_FALLBACKS, idiomOnlyNames, literalText } from './global-object.js';
import { createInterpreter, InterpreterLimitError, isUseStrict } from './interpreter.js';
import { findSliceTrap } from './native.js';

/**
 * A program hidden behind `eval(E)`, `(0, eval)(E)`, `Function(E)()` or
 * `new Function(E)()`, where `E` is a computation over literals: the Dean
 * Edwards packer is one shape of it, and every custom packer - a base
 * conversion, an xor over a key, char-code arithmetic, a table lookup -
 * is another. The interpreter runs `E` over its slice, the way it runs a
 * decoder, and the text it produces is the program the packer hides, when
 * it parses. Nothing of the input is executed by the host: a refusal
 * stands wherever the interpreter has no exact answer.
 */

export interface PackedSource {
  /** `'program'` for an eval, `'function'` for a `Function` body called at once. */
  kind: 'program' | 'function';
  /** The parameter names of a `Function(p, ..., body)`; empty for a program. */
  params: readonly string[];
  /** The text the packer produces, which parses as the kind says. */
  code: string;
  /** Interpreter steps the computation took. */
  steps: number;
  /** Whether the text parses as the kind says: a program, or a function body. */
  program: boolean;
  /**
   * For a program: whether its text is one expression statement, so an
   * `eval(E)` in expression position - `return eval(E)`, `x = eval(E)` -
   * may be replaced by the expression itself. `var x = 1` and `{a: 1}` are
   * programs and no expression; `1 + 1` both.
   */
  expression: boolean;
}

export interface PackedRefusal {
  refused: string;
}

/** Sizes the interpreter's string budget is set to: a packed program is at most this long. */
const MAX_PACKED_LENGTH = 8_000_000;
const MAX_CALL_DEPTH = 256;
const RESULT = '__packed';

/**
 * Whether `site` is a call that compiles a string, and which of the two
 * shapes; `undefined` for any other call.
 */
export function packedSourceSite(
  node: t.CallExpression | t.NewExpression,
): { kind: 'program' | 'function'; source: t.Expression; params: t.Node[] } | undefined {
  if (t.isCallExpression(node) && node.arguments.length === 0) {
    // `Function(...)()`, `new Function(...)()`: the body call, then the constructor.
    const callee = node.callee;
    if ((t.isCallExpression(callee) || t.isNewExpression(callee)) && t.isIdentifier(callee.callee, { name: 'Function' })) {
      const args = callee.arguments;
      const source = args[args.length - 1];
      if (!source || !t.isExpression(source)) return undefined;
      return { kind: 'function', source, params: args.slice(0, -1) };
    }
    return undefined;
  }
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const source = node.arguments[0]!;
  if (!t.isExpression(source)) return undefined;
  const callee = node.callee;
  if (t.isIdentifier(callee, { name: 'eval' })) return { kind: 'program', source, params: [] };
  if (t.isSequenceExpression(callee)) {
    const last = callee.expressions[callee.expressions.length - 1];
    if (last && t.isIdentifier(last, { name: 'eval' })) return { kind: 'program', source, params: [] };
  }
  if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property, { name: 'eval' })) {
    if (t.isIdentifier(callee.object) && GLOBAL_OBJECT_FALLBACKS.has(callee.object.name)) return { kind: 'program', source, params: [] };
  }
  return undefined;
}

/**
 * The program `site` compiles, computed by the interpreter, or the reason it
 * is not computed. `site` is the call as the tree holds it; its scope is
 * where the source's names resolve, and the slice is taken from there.
 */
export function unpackStringCode(
  program: NodePath<t.Program>,
  site: NodePath<t.CallExpression | t.NewExpression>,
  config: ResolvedConfig,
  options: { scans?: StatementScanCache } = {},
): PackedSource | PackedRefusal {
  const shape = packedSourceSite(site.node);
  if (!shape) return { refused: 'the call compiles no string: it is not an eval or a Function body called at once' };

  const params: string[] = [];
  for (const param of shape.params) {
    const name = literalText(param);
    if (name === undefined) return { refused: 'a parameter name of the Function call is not a literal' };
    params.push(name);
  }

  // The names the source reads: bound ones are roots of the slice; unbound
  // ones must be builtins every tier holds.
  const free = freeNamesOf(shape.source);
  const roots: string[] = [];
  for (const name of free) {
    if (site.scope.getBinding(name)) roots.push(name);
    else if (!INTERPRETER_GLOBALS.has(name)) return { refused: `the source reads ${name}, which is neither bound in the program nor a builtin the interpreter holds` };
  }
  if (free.has('eval') || free.has('Function')) return { refused: 'the source compiles a further string itself' };

  const scope = asSliceScope(site.scope.path) ?? program;
  const slice: SliceResult = roots.length > 0 ? sliceForEvaluation(scope, roots, options.scans) : { statements: [], definedNames: new Set(), freeNames: new Set(), sources: [] };
  if (roots.length > 0 && slice.statements.length === 0) return { refused: `no declaration of ${roots.join(', ')} could be sliced` };
  if (slice.unmodelledMutation) return { refused: `code outside the slice changes ${slice.unmodelledMutation} in a way the slice does not reproduce` };
  if (!isSelfContained(slice)) {
    const idiom = idiomOnlyNames(slice.statements);
    const escapes = [...slice.freeNames].filter((name) => !idiom.has(name));
    if (escapes.length > 0) return { refused: `the slice references ${escapes.join(', ')}, which is outside the evaluation allowlist` };
  }
  const trap = findSliceTrap(slice.statements);
  if (trap) return { refused: `the slice runs into ${trap.what} before the source is computed` };

  const strict = program.node.sourceType === 'module' || program.node.directives.some(isUseStrict);
  const statements: t.Statement[] = slice.statements.map((statement) => t.cloneNode(statement, true, true));
  statements.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(RESULT), t.cloneNode(shape.source, true, true))]));

  let value: unknown;
  let steps = 0;
  try {
    const machine = createInterpreter(statements, {
      strict,
      module: program.node.sourceType === 'module',
      maxSteps: config.sandbox.maxSteps,
      timeoutMs: config.sandbox.timeoutMs,
      maxCallDepth: MAX_CALL_DEPTH,
      maxStringLength: MAX_PACKED_LENGTH,
      maxTotalStringLength: MAX_PACKED_LENGTH * 4,
    });
    value = machine.read(RESULT);
    steps = machine.steps();
  } catch (error) {
    const budget = error instanceof InterpreterLimitError;
    return { refused: `the interpreter ${budget ? 'ran out of budget' : 'refused or threw'} computing the source: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof value !== 'string') return { refused: `the source computes ${value === null ? 'null' : typeof value}, not a string` };

  const asProgram = parses(value, shape.kind, params);
  const asExpression = shape.kind === 'program' && isOneExpression(value);
  if (!asProgram && !asExpression) return { refused: `the text the source computes does not parse as a ${shape.kind === 'program' ? 'program' : 'function body'}` };
  return { kind: shape.kind, params, code: value, steps, program: asProgram, expression: asExpression };
}

/**
 * Whether a program's text is one expression statement: what `return eval(E)`
 * may be replaced by. The text is read as `eval` reads it, so `{a: 1}` is a
 * block, `function f() {}` a declaration and `function () {}` a syntax error,
 * whatever their parenthesised forms would be. A lone string literal is filed
 * as a directive, and is one expression all the same.
 */
function isOneExpression(code: string): boolean {
  try {
    const parsed = parseSource(code, { language: 'js', sourceType: 'script' });
    if (parsed.recovered || parsed.language !== 'js') return false;
    const { body, directives } = parsed.ast.program;
    if (body.length === 0) return directives.length === 1;
    return directives.length === 0 && body.length === 1 && t.isExpressionStatement(body[0]);
  } catch {
    return false;
  }
}

const INTERPRETER_GLOBALS: ReadonlySet<string> = new Set(globalNames());

/** Identifiers `node` reads that nothing inside it binds. */
function freeNamesOf(node: t.Node): Set<string> {
  const bound = new Set<string>();
  const read = new Set<string>();
  const stack: { node: t.Node; parent: t.Node | undefined }[] = [{ node, parent: undefined }];
  while (stack.length > 0) {
    const { node: current, parent } = stack.pop()!;
    if (t.isFunction(current)) {
      for (const param of current.params) for (const name of Object.keys(t.getBindingIdentifiers(param))) bound.add(name);
      if ((t.isFunctionExpression(current) || t.isFunctionDeclaration(current)) && current.id) bound.add(current.id.name);
    }
    if (t.isVariableDeclarator(current) || t.isClassDeclaration(current) || t.isCatchClause(current)) {
      for (const name of Object.keys(t.getBindingIdentifiers(current))) bound.add(name);
    }
    if (t.isIdentifier(current) && parent !== undefined) {
      const property =
        ((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) && parent.property === current && !parent.computed) ||
        ((t.isObjectProperty(parent) || t.isObjectMethod(parent)) && parent.key === current && !parent.computed) ||
        (t.isLabeledStatement(parent) && parent.label === current) ||
        t.isBreakStatement(parent) ||
        t.isContinueStatement(parent);
      if (!property && current.name !== 'arguments') read.add(current.name);
    }
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push({ node: item as t.Node, parent: current });
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push({ node: child as t.Node, parent: current });
      }
    }
  }
  for (const name of bound) read.delete(name);
  return read;
}

function parses(code: string, kind: 'program' | 'function', params: readonly string[]): boolean {
  const text = kind === 'program' ? code : `(function (${params.join(', ')}) {\n${code}\n})`;
  try {
    const parsed = parseSource(text, { language: 'js', sourceType: 'script' });
    return !parsed.recovered && parsed.language === 'js';
  } catch {
    return false;
  }
}
