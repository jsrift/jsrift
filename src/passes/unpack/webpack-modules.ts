import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { parseSource } from '../../frontend/language.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { staticString } from '../../util/ast.js';
import { EVAL_PACKER_UNPACKED, adoptProgram, refreshScope } from './eval-packer.js';
import { FUNCTION_CONSTRUCTOR_UNPACKED } from './function-constructor.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/** Analysis handed to later stages: module id -> the binding it was hoisted to. */
export const WEBPACK_MODULES = 'unpack.webpack-modules:modules';

/**
 * A bundle always names its own bundler somewhere -- in the chunk registry, in
 * the require helper, or in a `webpack://` source-map URL. One linear scan here
 * saves a full traversal of a multi-megabyte file that has no chunk map.
 */
const BUNDLER_HINT = /webpack|turbopack/i;

const WEBPACK_REGISTRY = /webpackChunk|webpackJsonp/;
const TURBOPACK_REGISTRY = /TURBOPACK|__turbopack/i;

/**
 * A string passed to `eval` is only treated as a module when it carries a
 * bundler's own marker. Unwrapping every `eval("...")` in the file would be a much
 * larger claim than this pass is entitled to make.
 */
const MODULE_MARKER = /\/\/[#@]\s*source(?:URL|MappingURL)=|__webpack_require__|__turbopack/;

const SOURCE_URL = /\/\/[#@]\s*sourceURL=(\S+)/;
const SOURCE_MAP_URL = /\/\/[#@]\s*sourceMappingURL=(\S+)/;
const INLINE_MAP = /^data:application\/json[^,]*;base64,(.+)$/;
const SOURCE_ANNOTATION = /[ \t]*\r?\n?\/\/[#@][ \t]*source(?:URL|MappingURL)=\S*[ \t]*/g;

/** A banner wide enough to find while scrolling a hundred-thousand-line bundle. */
const RULE = ' '.concat('='.repeat(58));

/**
 * Split a bundler chunk map into one named, commented module per factory.
 *
 * A production Next.js chunk is dozens of independent modules concatenated into
 * a single expression, which is why a bundle reads as an undifferentiated wall
 * of code: there is nothing in the text that says where one module ends. This
 * pass gives each factory a top-level binding named after its id (or, on dev
 * builds, after the original file the source map names) and leaves the
 * registration call behind, referring to those bindings.
 *
 * That shape is deliberate. Hoisting the factories out *without* rewriting the
 * `push` would change what the chunk registers; leaving each factory as its own
 * function keeps every module's scope separate, so two modules that both declare
 * `useState` never collide. Each module is transformed independently and reads
 * nothing from its neighbours, so the loop is trivially parallelisable later.
 *
 * The pass restructures the program, so it refuses on anything it does not
 * recognise exactly: one unexpected property in the module map and the whole
 * chunk is left alone.
 */
export const webpackModulesPass: Pass = {
  id: 'unpack.webpack-modules',
  title: 'Split webpack chunk maps into named modules',
  stage: 'unpack',
  technique: 'moduleUnwrapping',
  run: (ctx) => {
    // `ctx.source` is the pre-pipeline text, so it cannot see a bundle that
    // `unpack.eval-packer` just revealed. That pass leaves a marker behind.
    if (
      !BUNDLER_HINT.test(ctx.source) &&
      !ctx.shared.has(EVAL_PACKER_UNPACKED) &&
      !ctx.shared.has(FUNCTION_CONSTRUCTOR_UNPACKED)
    ) {
      return;
    }

    const found = collect(ctx);
    if (found.chunks.length === 0 && found.evalModules.length === 0) return;

    /** Original file paths recovered from dev-build source maps, by factory node. */
    const labels = new Map<t.Node, string>();

    // Leaf first: unwrapping a chunk moves whole factory nodes under new
    // parents, which would strand any path pointing inside one of them.
    let inlined = 0;
    for (let index = found.evalModules.length - 1; index >= 0; index--) {
      if (ctx.isExhausted()) break;
      if (unwrapEvalModule(found.evalModules[index]!, ctx, labels)) inlined++;
    }

    const modules: ModuleRecord[] = [];
    // One name pool for the whole run: `insertBefore` does not register the
    // bindings it adds, so a second chunk holding the same module id would
    // otherwise be handed a name the first chunk already declared, and the
    // duplicate declaration would silently win for both.
    const claimed = new Set<string>();
    for (let index = found.chunks.length - 1; index >= 0; index--) {
      if (ctx.isExhausted()) break;
      unwrapChunk(found.chunks[index]!, ctx, labels, modules, claimed);
    }

    if (modules.length === 0 && inlined === 0) return;

    refreshScope(ctx.ast);
    if (modules.length > 0) {
      ctx.shared.set(WEBPACK_MODULES, modules);
      ctx.note('info', `Split ${modules.length} bundler module(s) into named top-level scopes.`);
    }
    if (inlined > 0) {
      ctx.note('info', `Inlined ${inlined} dev-build eval module(s).`);
    }
  },
};

export interface ModuleRecord {
  kind: 'webpack' | 'turbopack';
  id: string;
  /** Original file the module came from, when a source map named one. */
  label: string;
  binding: string;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface FactorySlot {
  id: string;
  factory: t.FunctionExpression | t.ArrowFunctionExpression;
  /** Put a reference back where the factory used to sit. */
  detach: (reference: t.Identifier) => void;
}

interface Chunk {
  kind: 'webpack' | 'turbopack';
  registry: string;
  path: NodePath<t.ExpressionStatement>;
  slots: FactorySlot[];
}

interface EvalModule {
  path: NodePath<t.ExpressionStatement>;
  code: string;
}

interface Found {
  chunks: Chunk[];
  evalModules: EvalModule[];
}

function collect(ctx: PassContext): Found {
  const chunks: Chunk[] = [];
  const evalModules: EvalModule[] = [];

  traverse(ctx.ast, {
    ExpressionStatement(path) {
      const chunk = matchChunk(path);
      if (chunk) {
        chunks.push(chunk);
        return;
      }
      const evalModule = matchEvalModule(path);
      if (evalModule) evalModules.push(evalModule);
    },
  });

  return { chunks, evalModules };
}

function matchChunk(path: NodePath<t.ExpressionStatement>): Chunk | undefined {
  // Hoisted declarations need somewhere to go; without a statement list there
  // is no position that preserves the order they must run in.
  if (!Array.isArray(path.container)) return undefined;

  const call = path.node.expression;
  if (!t.isCallExpression(call)) return undefined;

  const callee = call.callee;
  if (!t.isMemberExpression(callee) || callee.computed) return undefined;
  if (!t.isIdentifier(callee.property, { name: 'push' })) return undefined;

  const registry = registryName(callee.object);
  if (!registry) return undefined;

  const payload = call.arguments[0];
  if (!t.isArrayExpression(payload)) return undefined;

  if (TURBOPACK_REGISTRY.test(registry)) {
    const slots = turbopackSlots(payload);
    return slots && { kind: 'turbopack', registry, path, slots };
  }
  if (WEBPACK_REGISTRY.test(registry)) {
    const slots = webpackSlots(payload);
    return slots && { kind: 'webpack', registry, path, slots };
  }
  return undefined;
}

/**
 * Name the thing being pushed to, seeing through the two idioms bundlers use to
 * create it on first use: `(self.x = self.x || []).push(...)` and
 * `(globalThis.X || (globalThis.X = [])).push(...)`.
 */
function registryName(node: t.Node): string | undefined {
  if (t.isAssignmentExpression(node)) return registryName(node.left);
  if (t.isLogicalExpression(node)) return registryName(node.left);
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) {
    const object = registryName(node.object);
    const key = node.computed
      ? staticString(node.property)
      : t.isIdentifier(node.property)
        ? node.property.name
        : undefined;
    return object !== undefined && key !== undefined ? `${object}.${key}` : undefined;
  }
  return undefined;
}

/** `push([[chunkIds], { id: factory, ... }])` -- the module map is element 1. */
function webpackSlots(payload: t.ArrayExpression): FactorySlot[] | undefined {
  const map = payload.elements[1];
  if (!t.isObjectExpression(map) || map.properties.length === 0) return undefined;

  const slots: FactorySlot[] = [];
  for (const property of map.properties) {
    // A spread, a method, or a computed key means this is not a module map.
    // Unwrapping the recognised half of it would be worse than not trying.
    if (!t.isObjectProperty(property) || property.computed) return undefined;
    const id = literalKey(property.key);
    if (id === undefined || !isFactory(property.value)) return undefined;
    const factory = property.value;
    slots.push({
      id,
      factory,
      detach: (reference) => {
        property.value = reference;
      },
    });
  }
  return slots;
}

/** `push([currentScript, id, factory, id, factory, ...])`. */
function turbopackSlots(payload: t.ArrayExpression): FactorySlot[] | undefined {
  const elements = payload.elements;
  if (elements.length < 3 || (elements.length - 1) % 2 !== 0) return undefined;

  const slots: FactorySlot[] = [];
  for (let index = 1; index < elements.length; index += 2) {
    const key = elements[index];
    const factory = elements[index + 1];
    const id = key && !t.isSpreadElement(key) ? literalKey(key) : undefined;
    if (id === undefined || !factory || !isFactory(factory)) return undefined;
    const slot = index + 1;
    slots.push({
      id,
      factory,
      detach: (reference) => {
        elements[slot] = reference;
      },
    });
  }
  return slots;
}

function literalKey(node: t.Node): string | undefined {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isIdentifier(node)) return node.name;
  return undefined;
}

function isFactory(node: t.Node): node is t.FunctionExpression | t.ArrowFunctionExpression {
  return t.isFunctionExpression(node) || t.isArrowFunctionExpression(node);
}

// ---------------------------------------------------------------------------
// Chunk maps
// ---------------------------------------------------------------------------

function unwrapChunk(
  chunk: Chunk,
  ctx: PassContext,
  labels: Map<t.Node, string>,
  records: ModuleRecord[],
  claimed: Set<string>,
): void {
  const declarations: t.Statement[] = [];

  for (const slot of chunk.slots) {
    const label = labels.get(slot.factory) ?? tidyModulePath(slot.id);
    const binding = allocate(bindingBase(label, slot.id), chunk.path.scope, claimed);

    const declaration = hoist(binding, slot.factory);
    annotate(declaration, chunk.kind, slot.id, label);
    declarations.push(declaration);

    // The registration call keeps running, now referring to the hoisted
    // binding, so the chunk still registers exactly what it registered before.
    slot.detach(t.identifier(binding));
    records.push({ kind: chunk.kind, id: slot.id, label, binding });
  }

  chunk.path.insertBefore(declarations);
  ctx.report('webpack-bundle', `${chunk.kind} chunk on ${chunk.registry}`, 1, chunk.slots.length);
  ctx.markChanged(chunk.slots.length);
}

/**
 * Give the factory its own top-level binding.
 *
 * A plain function expression becomes a function declaration, which is both the
 * most readable form and exactly equivalent: `this` still comes from the call
 * site either way. Everything else -- arrows, and named function expressions
 * whose name is visible to their own body -- keeps its expression form under a
 * `const`, because rewriting those would silently change what `this`,
 * `arguments` or the self-reference resolve to.
 */
function hoist(
  name: string,
  factory: t.FunctionExpression | t.ArrowFunctionExpression,
): t.Statement {
  if (t.isFunctionExpression(factory) && !factory.id) {
    return t.inherits(
      t.functionDeclaration(
        t.identifier(name),
        factory.params,
        factory.body,
        factory.generator,
        factory.async,
      ),
      factory,
    );
  }
  if (
    t.isArrowFunctionExpression(factory) &&
    t.isBlockStatement(factory.body) &&
    !bindsDynamically(factory)
  ) {
    return t.inherits(
      t.functionDeclaration(t.identifier(name), factory.params, factory.body, false, factory.async),
      factory,
    );
  }

  const declaration = t.variableDeclaration('const', [
    t.variableDeclarator(t.identifier(name), factory),
  ]);
  // Only the position is copied: `t.inherits` would also copy the comments,
  // and the factory node itself stays in the tree as the initialiser.
  declaration.loc = factory.loc;
  return declaration;
}

/**
 * True when an arrow's body reads something a function declaration would rebind.
 * Nested non-arrow functions are skipped: they introduce their own `this` and
 * `arguments`, so what they contain says nothing about the arrow around them.
 */
function bindsDynamically(arrow: t.ArrowFunctionExpression): boolean {
  const stack: unknown[] = [arrow.body];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object' || typeof (current as t.Node).type !== 'string') {
      continue;
    }
    const node = current as t.Node;
    if (t.isThisExpression(node) || t.isMetaProperty(node)) return true;
    if (t.isIdentifier(node, { name: 'arguments' })) return true;
    if (
      t.isFunctionExpression(node) ||
      t.isFunctionDeclaration(node) ||
      t.isObjectMethod(node) ||
      t.isClassMethod(node) ||
      t.isClassPrivateMethod(node)
    ) {
      continue;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

function annotate(
  declaration: t.Statement,
  kind: 'webpack' | 'turbopack',
  id: string,
  label: string,
): void {
  t.addComment(declaration, 'leading', RULE, true);
  const origin = label && label !== id ? ` -> ${label}` : '';
  t.addComment(declaration, 'leading', ` ${kind} module ${JSON.stringify(id)}${origin}`, true);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function bindingBase(label: string, id: string): string {
  const candidate = identifierish(label) || identifierish(id);
  return `module_${candidate || 'anon'}`;
}

function identifierish(value: string): string {
  const name = value
    .replace(/\?.*$/, '')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9_$]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return t.isValidIdentifier(`module_${name}`, false) ? name : '';
}

/**
 * A name nothing else in scope answers to.
 *
 * `scope.generateUid` is not usable here: it strips trailing digits, so every
 * numeric Turbopack id would collapse onto the same `_module_` stem.
 */
function allocate(base: string, scope: Scope, claimed: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (
    claimed.has(candidate) ||
    scope.hasBinding(candidate) ||
    scope.hasGlobal(candidate) ||
    scope.hasReference(candidate)
  ) {
    candidate = `${base}_${suffix++}`;
  }
  claimed.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Dev-build eval modules
// ---------------------------------------------------------------------------

function matchEvalModule(path: NodePath<t.ExpressionStatement>): EvalModule | undefined {
  if (!Array.isArray(path.container)) return undefined;

  const call = path.node.expression;
  if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: 'eval' })) return undefined;
  if (call.arguments.length !== 1) return undefined;

  const argument = call.arguments[0]!;
  let code = staticString(argument);
  if (
    code === undefined &&
    t.isCallExpression(argument) &&
    argument.arguments.length === 1 &&
    t.isMemberExpression(argument.callee) &&
    !argument.callee.computed &&
    t.isIdentifier(argument.callee.object) &&
    t.isIdentifier(argument.callee.property)
  ) {
    // `eval(__webpack_require__.ts("..."))`: the helper is a pass-through that
    // exists only to keep the module's source map attached to the string.
    code = staticString(argument.arguments[0]);
  }

  if (code === undefined || !MODULE_MARKER.test(code)) return undefined;
  return { path, code };
}

function unwrapEvalModule(
  module: EvalModule,
  ctx: PassContext,
  labels: Map<t.Node, string>,
): boolean {
  const label = labelFromAnnotations(module.code);
  // The factory has to be resolved before the statement is replaced, because
  // afterwards this path no longer has a parent to walk up from.
  const factory = module.path.getFunctionParent();

  const parsed = (() => {
    try {
      // The trailing sourceURL / sourceMappingURL comments describe the packed
      // module, so re-emitting them would point tooling at a stale map.
      return parseSource(module.code.replace(SOURCE_ANNOTATION, ''), { language: ctx.language });
    } catch {
      return undefined;
    }
  })();
  if (!parsed || parsed.recovered) {
    ctx.note('warning', 'eval module body did not parse; left in place.', module.path.node.loc);
    return false;
  }

  const statements = adoptProgram(parsed.ast.program);
  if (statements.length === 0) {
    module.path.remove();
  } else {
    // When the module is inside a chunk the banner comes from the hoisted
    // declaration; a standalone factory would otherwise lose the file name.
    if (label && !factory) {
      t.addComment(statements[0]!, 'leading', RULE, true);
      t.addComment(statements[0]!, 'leading', ` module source ${JSON.stringify(label)}`, true);
    }
    module.path.replaceWithMultiple(statements);
  }

  if (label && factory) labels.set(factory.node, label);
  ctx.report('webpack-bundle', 'dev-build eval module', 1, 1);
  ctx.markChanged();
  return true;
}

/** Prefer the source map's own `sources[0]`; fall back to the `sourceURL`. */
function labelFromAnnotations(code: string): string | undefined {
  const mapUrl = SOURCE_MAP_URL.exec(code)?.[1];
  const inline = mapUrl ? INLINE_MAP.exec(mapUrl) : null;
  const payload = inline?.[1];
  if (payload) {
    const decoded = decodeBase64(payload);
    const source = decoded === undefined ? undefined : firstSource(decoded);
    if (source) return tidyModulePath(source);
  }

  const sourceUrl = SOURCE_URL.exec(code)?.[1];
  return sourceUrl ? tidyModulePath(sourceUrl) : undefined;
}

function firstSource(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    const sources = (parsed as { sources?: unknown } | null)?.sources;
    if (!Array.isArray(sources)) return undefined;
    const first: unknown = sources[0];
    return typeof first === 'string' ? first : undefined;
  } catch {
    return undefined;
  }
}

/** `webpack://_N_E/./src/app/page.tsx?a1b2` -> `./src/app/page.tsx`. */
function tidyModulePath(value: string): string {
  let out = value;
  const scheme = out.indexOf('://');
  if (scheme !== -1) {
    const rest = out.slice(scheme + 3);
    const slash = rest.indexOf('/');
    out = slash === -1 ? rest : rest.slice(slash + 1);
  }
  const query = out.indexOf('?');
  return query === -1 ? out : out.slice(0, query);
}

function decodeBase64(value: string): string | undefined {
  try {
    if (typeof atob === 'function') {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    // Node path: reach for Buffer dynamically so browser bundles never pull in
    // a polyfill for it.
    const BufferCtor = (
      globalThis as {
        Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
      }
    ).Buffer;
    return BufferCtor?.from(value, 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}
