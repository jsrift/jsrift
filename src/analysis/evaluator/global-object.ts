import { parse } from '@babel/parser';
import * as t from '@babel/types';

/**
 * The global-object idiom: the handful of spellings a program uses to get
 * hold of its realm's global object without naming it.
 *
 *   Function('return this')()
 *   (function () {}).constructor('return this')()
 *   new Function('return this')()
 *   (0, eval)('this')
 *
 * nested to any depth (`Function('return (function () {}.constructor("return
 * this")())')()` is what obfuscator.io 0.x emitted), and each one a pure
 * read: the compiled source evaluates `this` and nothing else. Every tier
 * answers the idiom with its own realm object - the interpreter's sandbox
 * global, which carries only the allowlisted builtins - and refuses every
 * other source handed to `Function` or `eval`. The predicates here are the
 * grammar, shared by the interpreter's `Function` and `eval`, by the
 * evaluator's escape check, which lets a slice name `Function` only inside
 * the idiom, and by the string-code analysis, for which an idiom source
 * spells no name at all.
 */

/** Names a program falls back to for the global object when the idiom throws. */
export const GLOBAL_OBJECT_FALLBACKS: ReadonlySet<string> = new Set(['globalThis', 'window', 'self', 'global']);

/** How deep a nested idiom source is followed before it is not one. */
const MAX_NESTING = 4;

/** Whether `node` evaluates to the global object by the idiom alone. */
export function isGlobalThisExpression(node: t.Node, depth = 0): boolean {
  if (depth > MAX_NESTING) return false;
  const expression = unwrap(node);
  if (!t.isCallExpression(expression) || expression.arguments.length !== 0) return false;
  const callee = unwrap(expression.callee);
  // `Function(src)()`, `new Function(src)()`, `(function () {}).constructor(src)()`.
  if ((t.isCallExpression(callee) || t.isNewExpression(callee)) && isFunctionConstructor(callee.callee)) {
    const source = constructorSource(callee.arguments);
    return source !== undefined && isGlobalThisSource(source, 'function', depth + 1);
  }
  // `(function () { return this; })()`: the idiom once `unpack.function-constructor`
  // has opened the `Function` call around it; a sloppy call with no receiver
  // reads `this` as the global object.
  if (t.isFunctionExpression(callee) && callee.params.length === 0 && !callee.generator && !callee.async) {
    const body = callee.body.body;
    return (
      callee.body.directives.length === 0 &&
      body.length === 1 &&
      t.isReturnStatement(body[0]) &&
      body[0].argument !== null &&
      body[0].argument !== undefined &&
      isThisOrIdiom(body[0].argument, depth + 1)
    );
  }
  // `(0, eval)(src)()` is `this()`, not the idiom; the indirect eval is read
  // as a call of one argument below.
  return false;
}

/**
 * Whether a call is the idiom or an indirect eval of it: the shape
 * `isGlobalThisExpression` reads, or `(0, eval)('this')`, `window.eval('this')`.
 */
export function isGlobalObjectRead(node: t.Node, depth = 0): boolean {
  if (isGlobalThisExpression(node, depth)) return true;
  const expression = unwrap(node);
  if (!t.isCallExpression(expression) || expression.arguments.length !== 1) return false;
  if (!isIndirectEval(expression.callee)) return false;
  const source = literalText(expression.arguments[0]!);
  return source !== undefined && isGlobalThisSource(source, 'program', depth + 1);
}

/**
 * Whether a source handed to `Function` (the body, `shape: 'function'`) or
 * to an indirect `eval` (a program) compiles to the idiom and nothing else.
 */
export function isGlobalThisSource(text: string, shape: 'program' | 'function', depth = 0): boolean {
  if (depth > MAX_NESTING || text.length > 4096) return false;
  let body: t.Statement[];
  try {
    if (shape === 'function') {
      const program = parse(`(function anonymous(\n) {\n${text}\n})`, { sourceType: 'script' }).program;
      const statement = program.body[0];
      if (program.body.length !== 1 || !t.isExpressionStatement(statement)) return false;
      const fn = statement.expression;
      if (!t.isFunctionExpression(fn) || fn.body.directives.length > 0) return false;
      body = fn.body.body;
    } else {
      const program = parse(text, { sourceType: 'script' }).program;
      if (program.directives.length > 0) return false;
      body = program.body;
    }
  } catch {
    return false;
  }
  if (body.length !== 1) return false;
  const statement = body[0]!;
  if (shape === 'function') {
    return t.isReturnStatement(statement) && statement.argument !== null && statement.argument !== undefined
      ? isThisOrIdiom(statement.argument, depth)
      : false;
  }
  return t.isExpressionStatement(statement) && isThisOrIdiom(statement.expression, depth);
}

/**
 * Whether what the idiom's body evaluates - the source `Function` or an
 * indirect `eval` compiles, the return of `(function () { ... })()` - is
 * `this`, which is the global object there and nowhere else, or the idiom
 * nested again.
 */
function isThisOrIdiom(node: t.Node, depth: number): boolean {
  return t.isThisExpression(unwrap(node)) || isGlobalObjectRead(node, depth);
}

/**
 * `Function`; `X.constructor` for a function literal `X` or a builtin
 * constructor `X` (`Object.constructor`); `L.constructor.constructor` for
 * a literal `L`, whose constructor is a builtin one (`[].constructor
 * .constructor`).
 */
function isFunctionConstructor(callee: t.Node): boolean {
  const node = unwrap(callee);
  if (t.isIdentifier(node, { name: 'Function' })) return true;
  if (!t.isMemberExpression(node)) return false;
  if (propertyName(node) !== 'constructor') return false;
  const object = unwrap(node.object);
  if (t.isFunctionExpression(object) || t.isArrowFunctionExpression(object)) return true;
  if (t.isIdentifier(object)) return BUILTIN_CONSTRUCTORS.has(object.name);
  if (!t.isMemberExpression(object) || propertyName(object) !== 'constructor') return false;
  const literal = unwrap(object.object);
  return (
    t.isArrayExpression(literal) ||
    t.isObjectExpression(literal) ||
    t.isStringLiteral(literal) ||
    t.isNumericLiteral(literal) ||
    t.isBooleanLiteral(literal) ||
    t.isRegExpLiteral(literal) ||
    t.isTemplateLiteral(literal) ||
    t.isFunctionExpression(literal) ||
    t.isArrowFunctionExpression(literal)
  );
}

/** Global constructors, every one a function whose own `constructor` is `Function`. */
const BUILTIN_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Function', 'RegExp', 'Date', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Proxy', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt', 'BigInt64Array', 'BigUint64Array',
]);

/** `(0, eval)`, `window.eval`, `globalThis.eval`: an eval that compiles in global scope. */
function isIndirectEval(callee: t.Node): boolean {
  if (t.isSequenceExpression(callee)) {
    const last = callee.expressions[callee.expressions.length - 1];
    return last !== undefined && t.isIdentifier(unwrap(last), { name: 'eval' });
  }
  if (t.isParenthesizedExpression(callee)) return isIndirectEval(callee.expression);
  if (t.isMemberExpression(callee) && propertyName(callee) === 'eval') {
    const object = unwrap(callee.object);
    return t.isIdentifier(object) && GLOBAL_OBJECT_FALLBACKS.has(object.name);
  }
  return false;
}

/**
 * The body a `Function(p1, ..., body)` call compiles, when every argument is
 * literal text; the parameters are kept out, since a parameter list cannot
 * make a body the idiom that was not one.
 */
function constructorSource(args: readonly t.Node[]): string | undefined {
  if (args.length === 0) return '';
  const parts: string[] = [];
  for (const argument of args) {
    const text = literalText(argument);
    if (text === undefined) return undefined;
    parts.push(text);
  }
  return parts[parts.length - 1];
}

/** A string literal, a substitution-free template, or a `+` of such - the text as the program spells it. */
export function literalText(node: t.Node, depth = 0): string | undefined {
  const expression = unwrap(node);
  if (t.isStringLiteral(expression)) return expression.value;
  if (t.isTemplateLiteral(expression) && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? undefined;
  }
  if (depth < 32 && t.isBinaryExpression(expression) && expression.operator === '+') {
    const left = literalText(expression.left, depth + 1);
    if (left === undefined) return undefined;
    const right = literalText(expression.right, depth + 1);
    return right === undefined ? undefined : left + right;
  }
  return undefined;
}

function propertyName(member: t.MemberExpression): string | undefined {
  if (member.computed) return t.isStringLiteral(member.property) ? member.property.value : undefined;
  return t.isIdentifier(member.property) ? member.property.name : undefined;
}

function unwrap(node: t.Node): t.Node {
  let current = node;
  for (let hops = 0; hops < 8; hops++) {
    if (t.isParenthesizedExpression(current)) current = current.expression;
    else if (t.isSequenceExpression(current) && current.expressions.length > 0) {
      current = current.expressions[current.expressions.length - 1]!;
    } else return current;
  }
  return current;
}

/**
 * The free names of a statement list that occur only as the idiom's own:
 * `Function` and `eval` as the constructor the idiom calls, and a fallback
 * name in the `catch` of a `try` whose block reads the global object by
 * the idiom, or as the operand of a `typeof` guard beside such a read.
 * A name that also occurs anywhere else is not in the set - one use outside
 * the idiom is a reach for the host, whatever the other uses are.
 */
export function idiomOnlyNames(statements: readonly t.Statement[]): Set<string> {
  const idiom = new Set<t.Node>();
  const outside = new Set<string>();
  const inside = new Set<string>();
  const candidate = (name: string): boolean => name === 'Function' || name === 'eval' || GLOBAL_OBJECT_FALLBACKS.has(name);

  const stack: { node: t.Node; parent: t.Node | undefined; fallback: boolean }[] = statements.map((node) => ({
    node,
    parent: undefined,
    fallback: false,
  }));
  while (stack.length > 0) {
    const { node, parent, fallback } = stack.pop()!;
    if (t.isIdentifier(node) && candidate(node.name)) {
      const property =
        parent !== undefined &&
        ((t.isMemberExpression(parent) && parent.property === node && !parent.computed) ||
          (t.isObjectProperty(parent) && parent.key === node && !parent.computed) ||
          (t.isObjectMethod(parent) && parent.key === node && !parent.computed));
      if (property) continue;
      const constructorOfIdiom =
        (node.name === 'Function' || node.name === 'eval') && parent !== undefined && idiom.has(parent);
      if (constructorOfIdiom || (GLOBAL_OBJECT_FALLBACKS.has(node.name) && fallback)) inside.add(node.name);
      else outside.add(node.name);
      continue;
    }
    if (isGlobalObjectRead(node)) {
      // Every callee and argument of the idiom is the idiom's; only the
      // constructor's own name is a free name in it.
      markIdiom(node, idiom);
    }
    let fallbackHere = fallback;
    if (t.isTryStatement(node) && node.handler && readsGlobalObject(node.block)) {
      stack.push({ node: node.handler, parent: node, fallback: true });
      stack.push({ node: node.block, parent: node, fallback });
      if (node.finalizer) stack.push({ node: node.finalizer, parent: node, fallback });
      continue;
    }
    // `typeof window !== 'undefined' ? window : Function('return this')()`:
    // the test and the other arm name the fallback. A `typeof` guard with
    // no idiom beside it is a branch on the host, which stays an escape.
    if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
      const arms = t.isConditionalExpression(node) ? [node.consequent, node.alternate] : [node.left, node.right];
      if (arms.some((arm) => isGlobalObjectRead(arm))) fallbackHere = true;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push({ node: item as t.Node, parent: node, fallback: fallbackHere });
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push({ node: child as t.Node, parent: node, fallback: fallbackHere });
      }
    }
  }
  const names = new Set<string>();
  for (const name of inside) if (!outside.has(name)) names.add(name);
  return names;
}

/** The call nodes whose callee spells the idiom's constructor, so the constructor name under them counts as the idiom's. */
function markIdiom(node: t.Node, idiom: Set<t.Node>): void {
  const stack: t.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (t.isCallExpression(current) || t.isNewExpression(current)) {
      const callee = unwrap(current.callee);
      if (t.isIdentifier(callee, { name: 'Function' })) idiom.add(current);
      // `(0, eval)(...)`: the name's parent is the sequence, kept as spelled.
      if (t.isSequenceExpression(current.callee)) idiom.add(current.callee);
      if (t.isMemberExpression(callee) && propertyName(callee) === 'eval') idiom.add(callee);
    }
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
}

/** Whether a block holds a read of the global object by the idiom, at any depth short of a nested function. */
function readsGlobalObject(block: t.Node): boolean {
  const stack: t.Node[] = [block];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current !== block && t.isFunction(current)) continue;
    if (isGlobalObjectRead(current)) return true;
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return false;
}
