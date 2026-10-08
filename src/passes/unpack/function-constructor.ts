import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { parseSource } from '../../frontend/language.js';
import { invalidateStringCodeFacts, stringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { insideWith, staticString } from '../../util/ast.js';
import { firstMeeting, refreshScope, releaseSite, siteKey, stripLocations } from './eval-packer.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Set in `ctx.shared` once a `Function` wrapper has been opened, for the same
 * reason `unpack.eval-packer` sets its own flag: the recovered code never
 * appeared in `ctx.source`, so any later pass that skips work by testing the
 * source text would miss whatever was inside.
 */
export const FUNCTION_CONSTRUCTOR_UNPACKED = 'unpack.function-constructor:unpacked';

/** Wrappers nest; this is runaway protection, not a real expectation. */
const MAX_LAYERS = 12;
const MAX_BODY_CHARS = 12_000_000;

/**
 * `Function` applied to string arguments. One linear scan of the source rules
 * out the overwhelming majority of files before any traversal happens.
 *
 * Exported because `prepare.detect` asks the same question when this pass is
 * switched off: a packed file whose wrapper is never opened fingerprints as
 * nothing at all, so the user has to be told which technique would open it. A
 * second copy of the pattern there would drift from this one.
 */
export const FUNCTION_PACKER_HINT = /\bFunction\s*\(\s*['"`]/;

/**
 * Rewrite `Function("a,b", "...body...")` as the function it constructs.
 *
 * A whole program can be hidden by handing its text to the `Function`
 * constructor and calling the result - the file parses as a single call whose
 * arguments are two string literals, so every later pass sees one opaque string
 * and there is nothing for them to do. That is not an encoding, though: the body
 * is already JavaScript. Parsing that string and putting the real function back
 * in its place is enough to hand the rest of the pipeline an ordinary program.
 *
 * Nothing is executed. The payload is parsed, exactly as the file's own top
 * level is, which matters because "the entire program arrives as a string" is
 * the shape hostile code travels in.
 *
 * TWO SEMANTIC DIFFERENCES separate "the body is already JavaScript" from "the
 * rewrite is sound", and this is why the pass is not simply a syntactic one.
 * The constructor does not build the function *here*; it compiles the body as a
 * fresh top-level function, and a function expression written into the call's
 * position instead inherits everything about its surroundings:
 *
 *   - SCOPE. The constructed function resolves free names against the global
 *     scope; the replacement resolves them where it sits.
 *   - STRICTNESS. The constructed function is non-strict unless its own body
 *     opts in; the replacement is strict whenever the code around it is.
 *
 * At program scope in a sloppy script - which is where packers put these - both
 * differences vanish and the rewrite is exact. Away from there the two are not
 * answered the same way, and neither is answered by refusing on position alone:
 *
 *   - STRICTNESS is refused outright. A call in strict code whose body does not
 *     carry its own `'use strict'` builds a sloppy function that the rewrite
 *     would make strict, and no property of the call site takes that back. A
 *     body that opts in is strict on both sides, so there is no difference left
 *     to refuse over.
 *   - SCOPE is refused when it actually bites: when a name the recovered body
 *     resolves without binding it - read or assigned to, since both ask where
 *     the name lives - is bound by a scope between the call and the global
 *     scope, or could be answered at run time by the object of an enclosing
 *     `with`, which pushes an environment no list of bindings can enumerate. A
 *     body whose free names meet neither condition resolves them the same way in
 *     either position, so it is rewritten however deeply it is nested - the
 *     wrapper inside a function that holds bindings the body never touches is
 *     opened, not refused.
 *
 *     One case stays open: a direct `eval` in the recovered body resolves names
 *     that exist only inside its string argument, so they are not among the
 *     names weighed here, and after the rewrite that `eval` sees the enclosing
 *     scopes the constructed function never had. Closing that would mean
 *     refusing on the presence of a direct `eval` call rather than on any name,
 *     which this does not do.
 *
 * A refusal leaves the call in place and a diagnostic says why. It costs an
 * unopened wrapper; performing the rewrite where one of the differences is real
 * costs output that parses, runs, and computes something else, with the
 * divergence hidden inside a function that still looks right. See
 * `refuseForStrictness` for the case this pass was actually getting wrong in
 * `fixtures/obfuscated3.js`, and `refuseForScope` for why the scope walk stops
 * where it does.
 *
 * Registered ahead of `unpack.eval-packer` because the common nesting is a
 * `Function` wrapper on the outside with something else within: opening it first
 * lets the packer and bundler passes see what it was holding.
 */
export const functionConstructorPass: Pass = {
  id: 'unpack.function-constructor',
  title: 'Rewrite Function-constructor wrappers',
  stage: 'unpack',
  technique: 'moduleUnwrapping',
  run: (ctx) => {
    // The source text is the pre-pipeline text. The kernel runs this stage
    // again on a tree the loop has moved, where a wrapper the strings stage
    // spelled out of a decoded table is in no source; a raw walk of the tree
    // for a constructor call over literals costs a few milliseconds where
    // the traversal below cost half a second on the 757 KB fixture per run.
    if (!FUNCTION_PACKER_HINT.test(ctx.source) && !holdsLiteralWrapper(ctx.ast)) return;

    const state = { layers: 0 };
    unpackTree(ctx.ast, ctx, 0, state);
    if (state.layers === 0) return;

    refreshScope(ctx.ast);
    // A wrapper opened is a string-code site gone; the facts memoised for this
    // round still list it.
    invalidateStringCodeFacts(ctx);
    ctx.shared.set(FUNCTION_CONSTRUCTOR_UNPACKED, state.layers);
    ctx.note('info', `Opened ${state.layers} Function-constructor wrapper(s).`);
  },
};

/**
 * Whether the tree holds a `Function(...)` / `new Function(...)` / `<global>.Function(...)`
 * call whose arguments are all readable strings - the shape `matchWrapper`
 * opens - found by a raw node walk that builds no paths.
 */
function holdsLiteralWrapper(file: t.File): boolean {
  const stack: unknown[] = [file.program];
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
      (t.isCallExpression(node) || t.isNewExpression(node)) &&
      node.arguments.length > 0 &&
      namesFunction(node.callee) &&
      node.arguments.every((argument) => staticString(argument) !== undefined)
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

/** `Function` or `<name>.Function`, before the scope question `isFunctionCallee` asks. */
function namesFunction(callee: t.Node): boolean {
  if (t.isIdentifier(callee, { name: 'Function' })) return true;
  return (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property, { name: 'Function' }) &&
    t.isIdentifier(callee.object)
  );
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

interface Wrapper {
  /** Comma-joined parameter source, exactly as the constructor would read it. */
  params: string;
  body: string;
}

type ConstructorCall = t.CallExpression | t.NewExpression;

/** The names a script can reach the global object by. */
const GLOBAL_OBJECT_NAMES = new Set(['window', 'globalThis', 'self', 'global']);

/**
 * Whether the callee is the global `Function` constructor.
 *
 * `Function(...)` and `new Function(...)` build the same object, so both forms are
 * accepted. Two shapes qualify, and each carries the same burden: the callee
 * has to be *provably* the global constructor, because the rewrite deletes the
 * call and puts the function its arguments spell out in its place. If the
 * callee was something else, that something else never runs and its return
 * value is replaced by an unrelated object.
 *
 *   - A bare `Function` that resolves to no binding in scope. A local one -
 *     a parameter, an import, a `var` - is somebody else's function.
 *   - `<global>.Function`, where `<global>` is a bare `window`, `globalThis`,
 *     `self` or `global` that likewise resolves to no binding in scope. That is
 *     the same constructor reached by another name.
 *
 * Everything else is refused, including `lib.Function(...)` and any other object
 * (`this.Function`, `a.b.Function`), a shadowed `window` - the wrapper
 * parameter `(function (window) {...})(env)` rebinds it to whatever was passed -
 * and the computed `window['Function']`, which no packer needs and which this
 * does not attempt to resolve.
 */
function isFunctionCallee(callee: t.Node, scope: Scope): boolean {
  if (t.isIdentifier(callee, { name: 'Function' })) return !scope.getBinding('Function');

  if (!t.isMemberExpression(callee) || callee.computed) return false;
  if (!t.isIdentifier(callee.property, { name: 'Function' })) return false;

  const object = callee.object;
  return (
    t.isIdentifier(object) &&
    GLOBAL_OBJECT_NAMES.has(object.name) &&
    !scope.getBinding(object.name)
  );
}

function matchWrapper(path: NodePath<ConstructorCall>): Wrapper | undefined {
  const node = path.node;
  if (!isFunctionCallee(node.callee, path.scope)) return undefined;

  const args = node.arguments ?? [];
  if (args.length === 0) return undefined;

  // Every argument has to be statically known: the constructor reads them all
  // as source text, so one unknown argument means an unknown program.
  const parts: string[] = [];
  for (const argument of args) {
    const value = staticString(argument);
    if (value === undefined) return undefined;
    parts.push(value);
  }

  const body = parts[parts.length - 1]!;
  if (body.length > MAX_BODY_CHARS) return undefined;

  return { params: parts.slice(0, -1).join(','), body };
}

// ---------------------------------------------------------------------------
// Inversion
// ---------------------------------------------------------------------------

interface UnpackState {
  layers: number;
}

function unpackTree(
  root: t.File | t.Node,
  ctx: PassContext,
  depth: number,
  state: UnpackState,
): void {
  const targets: Array<{ path: NodePath<ConstructorCall>; wrapper: Wrapper }> = [];

  const collect = (path: NodePath<ConstructorCall>) => {
    const wrapper = matchWrapper(path);
    if (!wrapper) return;
    targets.push({ path, wrapper });
    // The arguments are string literals about to be replaced by the tree they
    // describe; there is nothing below this node worth visiting.
    path.skip();
  };

  traverse(root as t.File, { CallExpression: collect, NewExpression: collect });
  if (targets.length === 0) return;

  if (depth >= MAX_LAYERS) {
    ctx.note('warning', `Stopped after ${MAX_LAYERS} nested Function-constructor layers.`);
    return;
  }

  for (const target of targets) {
    if (ctx.isExhausted()) return;
    expand(target.path, target.wrapper, ctx, depth, state);
  }
}

/**
 * The function a `Function(...)` call at `path` constructs, ready to stand in
 * its place, or `undefined` - with the reason noted - when the arguments are
 * not all readable strings, do not describe one function, or would change
 * meaning in this position (see `refuseForStrictness`, `refuseForScope`).
 *
 * For the strings stage, which spells a wrapper's arguments out of a decoded
 * table mid-round and must open it in the same breath: the wrapper is the
 * one string-code site in the file, and until it is read every decoder in
 * the program stays refused. The caller replaces the call itself, since it
 * may still have to put it back.
 */
export function recoverFunctionWrapper(
  path: NodePath<t.CallExpression | t.NewExpression>,
  ctx: PassContext,
): t.FunctionExpression | undefined {
  const wrapper = matchWrapper(path);
  if (!wrapper) return undefined;
  const fn = parseWrapper(wrapper, ctx, path);
  if (!fn) return undefined;
  if (refuseForStrictness(path, fn, ctx) || refuseForScope(path, fn, ctx)) return undefined;
  stripLocations([fn]);
  return fn;
}

function expand(
  path: NodePath<ConstructorCall>,
  wrapper: Wrapper,
  ctx: PassContext,
  depth: number,
  state: UnpackState,
): void {
  // The shape is recorded whether or not it opens; once per wrapper, since
  // the stage meets a refused one again on the quiet round.
  if (firstMeeting(ctx, path.node)) {
    ctx.report('eval-packer', `Function constructor, ${wrapper.body.length} chars of body`, 1, 1);
  }

  const fn = parseWrapper(wrapper, ctx, path);
  if (!fn) return;

  // Both soundness checks run before the nested unpack below, and the order is
  // load-bearing twice over.
  //
  // `unpackTree` increments `state.layers` and calls `ctx.markChanged()` for
  // every inner layer it opens. Those counts are not undone, so refusing after
  // it ran would report changes the output does not contain and would leave the
  // pass claiming it opened wrappers that are still sitting in the file.
  //
  // It also decides the question these checks ask, for the inner layers. The
  // recursion below walks a synthetic program holding nothing but `fn`, so an
  // inner wrapper is judged against `fn` rather than against the real host -
  // sound only because reaching that line means `fn` is about to be spliced in
  // unchanged, having already been proven to carry its host's strictness and to
  // resolve its free names the same way.
  if (refuseForStrictness(path, fn, ctx)) return;
  if (refuseForScope(path, fn, ctx)) return;

  // Resolve nested wrappers while the recovered tree is still detached, rather
  // than re-walking the host file once per layer.
  unpackTree(t.file(t.program([t.expressionStatement(fn)])), ctx, depth + 1, state);

  stripLocations([fn]);
  releaseSite(ctx, functionConstructorPass.id, path.node);
  path.replaceWith(fn);

  state.layers++;
  ctx.markChanged();
}

/**
 * Parse the wrapper as the function expression it stands for.
 *
 * Building the whole `(function (params) { body })` in one string and parsing
 * that - rather than parsing the body alone and attaching it to synthesised
 * parameters - is what makes the parameter list validate. It also lets a
 * `'use strict'` at the top of the body land in the function's directive
 * prologue, where it still means what it meant.
 */
function parseWrapper(
  wrapper: Wrapper,
  ctx: PassContext,
  path: NodePath<ConstructorCall>,
): t.FunctionExpression | undefined {
  const parsed = (() => {
    try {
      return parseSource(`(function (${wrapper.params}) {\n${wrapper.body}\n})`, {
        language: ctx.language,
        sourceType: 'script',
      });
    } catch {
      return undefined;
    }
  })();

  if (!parsed || parsed.recovered) {
    ctx.note(
      'warning',
      'Function-constructor body is not valid JavaScript; the call was left in place.',
      path.node.loc,
      siteKey(ctx, functionConstructorPass.id, path.node),
    );
    return undefined;
  }

  // Exactly one statement holding exactly one function expression. Anything else
  // means the parameter text closed the parameter list and wrote code of its
  // own, and the tree would no longer describe what the constructor builds.
  const program = parsed.ast.program;
  if (program.body.length !== 1 || program.directives.length > 0) return rejected(ctx, path);
  const statement = program.body[0]!;
  if (!t.isExpressionStatement(statement)) return rejected(ctx, path);
  const fn = statement.expression;
  if (!t.isFunctionExpression(fn)) return rejected(ctx, path);

  return fn;
}

function rejected(ctx: PassContext, path: NodePath<ConstructorCall>): undefined {
  ctx.note(
    'warning',
    'Function-constructor arguments do not describe a single function; left in place.',
    path.node.loc,
    siteKey(ctx, functionConstructorPass.id, path.node),
  );
  return undefined;
}

/**
 * Refuse when the constructed function would be sloppy and its replacement
 * would be strict.
 *
 * The constructor compiles the body as a fresh top-level function, so the
 * strictness of the code that called `Function` never reaches it: the result is
 * non-strict unless the body's own directive prologue opts in. A function
 * expression sitting in that position is strict whenever its surroundings are,
 * and a strict function is a different function - `this` is no longer boxed or
 * substituted, assigning to an undeclared name throws instead of creating a
 * global, `arguments` stops tracking the parameters it aliases.
 *
 * This is a refusal rather than a note because the pass was getting it wrong in
 * the fixture set, silently and with no diagnostic at all.
 * `fixtures/obfuscated3.js` parses as a module, so every function in it is
 * strict, and it closes a global-object lookup chain (`globalThis`, `global`,
 * `window`) with the fallback that works in any host: `new Function("return
 * this")()`. Constructed, that is a sloppy function called with no receiver, so
 * `this` is substituted and it hands back the global object - the entire point
 * of the idiom. Rewritten in place it is strict, `this` stays `undefined`, and
 * the chain's last resort silently starts returning `undefined`.
 *
 * A body opening with its own `'use strict'` is strict either way, and is the
 * one shape that survives a strict host. `parseWrapper` builds the whole
 * function in one string precisely so that such a directive lands in the
 * prologue, where it is still a directive and still means this.
 */
function refuseForStrictness(
  path: NodePath<ConstructorCall>,
  fn: t.FunctionExpression,
  ctx: PassContext,
): boolean {
  if (!path.isInStrictMode()) return false;
  if (fn.body.directives.some((directive) => directive.value.value === 'use strict')) return false;

  ctx.note(
    'warning',
    'Function-constructor call sits in strict code, but the body it builds does not opt in; ' +
      'the constructed function is non-strict, so the call was left in place.',
    path.node.loc,
    siteKey(ctx, functionConstructorPass.id, path.node),
  );
  return true;
}

/**
 * Refuse when a name the body uses would resolve to something other than the
 * global it was reaching for.
 *
 * The constructed function resolves its free names against the global scope.
 * The function expression put in its place resolves them where it sits, so a
 * binding introduced between the call and the global scope captures them. Reads
 * and writes are both uses, and `freeNames` collects both: a write that lands on
 * an intervening binding instead of the global is the same divergence, hidden
 * better.
 *
 * "Between the call and the global scope" is narrower than "every enclosing
 * binding", and deliberately: in a script the program scope *is* part of the
 * global scope, for `let` and `class` as much as for `var`, so a body using a
 * top-level name of a script reaches the same binding either way and refusing
 * on it would cost real rewrites for nothing. A module's top-level scope is not
 * global and its names genuinely diverge, so those are collected - even though
 * `refuseForStrictness` already turns away every wrapper in a module whose body
 * does not opt into strict mode, which leaves this reachable in a module only
 * for the one that does.
 *
 * An enclosing `with` is the one intervening scope that cannot be enumerated:
 * it pushes an object environment whose names are the object's properties at
 * run time, so no list of bindings describes it and any free name at all may be
 * answered by it. Being unable to say which names diverge, the refusal covers
 * every free name - and only there, so a `with` body still gets its wrappers
 * opened when the recovered code resolves nothing outside itself.
 */
function refuseForScope(
  path: NodePath<ConstructorCall>,
  fn: t.FunctionExpression,
  ctx: PassContext,
): boolean {
  const enclosing = enclosingBindingNames(path);
  const withObject = insideWith(path);
  // The common case, and the reason for checking it first: at program scope in
  // a script there is nothing in between, and the recovered tree is never
  // walked at all.
  if (enclosing.length === 0 && !withObject) return false;

  const free = freeNames(fn);

  if (withObject) {
    if (free.size === 0) return false;
    ctx.note(
      'warning',
      `Function-constructor call sits in the body of a \`with\`, whose object may answer ${[...free]
        .slice(0, 5)
        .join(', ')} at run time; ` +
        'the constructed function would have used the global(s), so the call was left in place.',
      path.node.loc,
      siteKey(ctx, functionConstructorPass.id, path.node),
    );
    return true;
  }

  const captured = enclosing.filter((name) => free.has(name));
  if (captured.length === 0) return false;

  ctx.note(
    'warning',
    `Function-constructor body uses ${captured
      .slice(0, 5)
      .join(', ')}, which a scope between the call and the global scope binds; ` +
      'the constructed function would have used the global(s), so the call was left in place.',
    path.node.loc,
    siteKey(ctx, functionConstructorPass.id, path.node),
  );
  return true;
}

/**
 * Names bound between the call and the global scope - the ones the constructed
 * function could not have seen.
 */
function enclosingBindingNames(path: NodePath<ConstructorCall>): string[] {
  const names: string[] = [];
  for (let scope: Scope | undefined = path.scope; scope; scope = scope.parent) {
    const scopePath = scope.path;
    if (scopePath.isProgram()) {
      if (scopePath.node.sourceType === 'module') names.push(...Object.keys(scope.bindings));
      break;
    }
    names.push(...Object.keys(scope.bindings));
  }
  return names;
}

/**
 * Every name the recovered function resolves without binding it - read or
 * written.
 *
 * Both halves have to be here, because the divergence this feeds is about where
 * a name resolves and not about what is then done with it. A body that only
 * assigns `x` stores to the global when the constructor compiles it and stores
 * to whatever an intervening scope binds once the function expression sits in
 * the call's place, which is the same wrong answer a read would get and the
 * quieter one: the caller's own variable changes value while the global the
 * program meant to set never moves.
 *
 * `ReferencedIdentifier` reports only the reads. An assignment target is not a
 * *reference* to the name, so `x = 1`, `x += 1`, `[x] = a`, `({ x } = a)` and a
 * pattern in a `for (... of ...)` head are all invisible to it; `x++` is not, since
 * an `UpdateExpression` argument does count as referenced, which is what made
 * the write half look covered when it was not.
 *
 * `getBindingIdentifiers` is what takes an assignment target down to its names:
 * it descends array and object patterns, rest elements and pattern defaults,
 * and yields nothing for a member expression - `o.x = 1` resolves only `o`,
 * which is a read the first visitor has already reported, and `x` there is a
 * property name that no scope answers.
 *
 * Collected in one traversal rather than one per candidate name: the enclosing
 * scopes of a deeply nested call can hold a great many bindings, and the
 * recovered body is a whole program's worth of tree.
 */
function freeNames(fn: t.FunctionExpression): Set<string> {
  const free = new Set<string>();

  const addUnbound = (name: string, scope: Scope): void => {
    if (!scope.getBinding(name)) free.add(name);
  };

  const addTargets = (target: t.Node, scope: Scope): void => {
    for (const name of Object.keys(t.getBindingIdentifiers(target))) addUnbound(name, scope);
  };

  traverse(t.file(t.program([t.expressionStatement(fn)])), {
    ReferencedIdentifier(path) {
      addUnbound(path.node.name, path.scope);
    },
    AssignmentExpression(path) {
      addTargets(path.node.left, path.scope);
    },
    // A `for (... in/of ...)` head assigns with no assignment expression to hang
    // the target off. A declaration head binds instead of assigning, and its
    // names are bound in the loop's own scope, so it is left alone.
    ForXStatement(path) {
      const left = path.node.left;
      if (!t.isVariableDeclaration(left)) addTargets(left, path.scope);
    },
  });
  return free;
}
