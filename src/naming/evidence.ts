import type { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { isReadableName, staticNumber, staticString } from '../util/ast.js';
import {
  ARG_POSITION_RULES,
  CALL_RESULT_RULES,
  CTOR_ALIASES,
  DUCK_SIGNATURES,
  GLOBAL_OBJECT_NAMES,
  ITERATOR_METHODS,
  LIST_METHODS,
  MODULE_ALIASES,
  OP_NAMES,
  PROXY_TRAPS,
  TEXT_METHODS,
  basenameNoExt,
  endsWithElementWord,
  identFromString,
  isReservedName,
  lastPathSegment,
  looksLikePath,
  looksLikeSelector,
  looksLikeUrl,
  lowerFirst,
  plural,
  singular,
  stripElementSuffix,
  stripGetterPrefix,
  toCamel,
  toPascal,
  type NameKind,
  type Tier,
} from './dictionary.js';

export interface NameCandidate {
  /** Final identifier text, already cased and inflected. */
  name: string;
  kind: NameKind;
  tier: Tier;
  /** 0..1 confidence contributed by this single rule firing. */
  confidence: number;
  ruleId: string;
  reason: string;
  /** Evidence node `.start`; the determinism tie-break of last resort. */
  anchor: number;
  /** 0 for direct evidence, 1+ when the name was propagated from another binding. */
  hops: number;
}

export type DeclKind =
  | 'param'
  | 'catch'
  | 'var'
  | 'let'
  | 'const'
  | 'fn'
  | 'class'
  | 'import'
  | 'forIn'
  | 'forOf'
  | 'unknown';

export interface CallSiteFact {
  /** Dotted callee text such as `document.getElementById`, when resolvable. */
  full: string;
  /** Trailing member name, so bare-method rules match any receiver. */
  method: string;
  argIndex: number;
  arity: number;
  anchor: number;
  /** Static value of argument 0, which is the event type for a listener call. */
  firstStringArg: string | undefined;
  /**
   * The parameter this argument is bound to, when the callee is a function or
   * class this file can see whole; see `boundParameter`. The callee's own word
   * for the value is evidence about the value, which is what D10 reads.
   */
  parameter: ParameterSlot | null;
}

/** A parameter of a resolved callee, with the scope its name resolves in. */
export interface ParameterSlot {
  name: string;
  scope: Scope;
}

/**
 * Every use of a function this file can see whole.
 *
 * Read in one direction by D11 - a parameter named after the argument its
 * callers pass - which needs `escapes` to be false: a function the file hands
 * somewhere else is called from places this list does not contain, and the
 * arguments here are then not all of them.
 */
export interface FunctionUses {
  calls: NodePath<t.CallExpression | t.NewExpression>[];
  /** `` f`a${1}` `` - the function is a template tag, whose parameters are fixed. */
  tags: number;
  /** A use that is neither a call nor a tag: the value went somewhere this walk does not follow. */
  escapes: boolean;
}

/** How a function-valued binding reaches its call site, which names its params. */
export interface CallbackContext {
  method: string;
  argIndex: number;
  containerName?: string;
  eventType?: string;
}

export interface BindingFacts {
  binding: Binding;
  name: string;
  anchor: number;
  declKind: DeclKind;
  /** Initialiser plus every assigned value, in source order. */
  shapes: t.Expression[];
  members: Map<string, number>;
  callSites: CallSiteFact[];
  usedAsCallee: number;
  ops: Set<string>;
  comparedStrings: string[];
  storedInto: Array<{ object: string | null; key: string; isThis: boolean; anchor: number }>;
  /** The containers this value is a position into, resolved to their display names when a rule fires, since a container renamed later in the same run settles after the facts are read. */
  indexedInto: { scope: Scope; name: string }[];
  /** Whether the value is used as a computed key: `list[binding]`. */
  usedAsIndex: boolean;
  /** `for (const x of binding)`, `[...binding]` - the value is walked element by element. */
  iterated: boolean;
  /** Whether the value is joined to a string literal with `+`. */
  concatenatedWithText: boolean;
  /** `x++` or `--x`: the program steps the value, which only a number takes. */
  stepped: boolean;
  /**
   * The first list-only method the program calls on the value with the
   * callback such a call takes - `.map(fn)`, `.reduce(fn)`; see `LIST_METHODS`.
   */
  listMethod: string | null;
  jsx: boolean;
  escapeReason: string | null;
  paramIndex: number;
  ownerFunction: NodePath<t.Function> | null;
  functionPath: NodePath<t.Function> | null;
  callbackContext: CallbackContext | null;
  /** `const { foo: x } = y` - the key that already names this value. */
  patternKey: string | null;
  /** `function f(...rest)` - the parameter is every argument after its index. */
  isRestParam: boolean;
  /** `new binding(...)`: the value is a constructor, not a plain function. */
  usedAsConstructor: number;
  /**
   * What this parameter's callers pass at its index, when every use of its
   * function is a call in plain sight; see `functionUses`. Empty otherwise,
   * which is the refusal: a caller this walk cannot see passes something else.
   */
  callerArguments: Array<{ node: t.Expression; scope: Scope }>;
  /** Whether this parameter's function is only ever used as a template tag. */
  templateTag: boolean;
  /** The Proxy trap this parameter's function is, when it is one; see `proxyTrapOf`. */
  proxyTrap: string | null;
  incremented: boolean;
  indexedRead: boolean;
  loopDepth: number;
  isLoopCounter: boolean;
  forOfContainer: t.Node | null;
  forInObject: t.Node | null;
  accumulates: boolean;
  assignedInLoopWithBreak: boolean;
  switchLabels: string[];
  typeAnnotation: t.TSType | null;
  returnsJsx: boolean;
  callsHooks: boolean;
  /** Import specifier, for the A19/A20 module-name rules. */
  moduleSpecifier: string | null;
}

/** Facts about the whole file that individual rules need to consult. */
export interface NamingWorld {
  typescript: boolean;
  /** Enables the React/JSX rules, which need a per-function body traversal. */
  jsx: boolean;
  /** False lets the anti-debug rule skip its traversal entirely. */
  hasDebugger: boolean;
  /** Every string literal in the program; a name colliding with one is unsafe. */
  strings: ReadonlySet<string>;
  /** Binding identifiers holding (or returning) a large string-literal array. */
  stringArrayIdentifiers: ReadonlySet<t.Identifier>;
  /** Bindings that alias a global object, e.g. the `d` of `!function(d){}(window)`. */
  globalAliasIdentifiers: ReadonlySet<t.Identifier>;
  /** Loop nodes that some `break` inside them actually exits; see F07. */
  breakingLoops: ReadonlySet<t.Node>;
  /**
   * Per-run memo for the two whole-function traversals I05 and I10 make.
   *
   * Both are pure functions of the function node and of fields of this object
   * that never change during a run, but `inferCandidates` re-runs every binding
   * once per propagation round, and a nested function is walked again by every
   * function that encloses it. Lives here rather than in module state so the
   * nodes are released with the run.
   */
  functionProbes: Map<t.Node, { stringArray?: boolean; debuggerTrap?: boolean }>;
  /**
   * Per-run memo for `functionUses`, which walks a function binding's
   * references: one function's answer serves every one of its parameters, and
   * `null` records that the function has no binding this walk can enumerate.
   */
  functionUses: Map<t.Node, FunctionUses | null>;
  hints: ReadonlyArray<{ source: string; regex: RegExp | null; name: string }>;
  /** Best name known for whatever `name` resolves to from `scope`, if any. */
  displayName(scope: Scope, name: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Fact collection
// ---------------------------------------------------------------------------

function anchorOf(node: t.Node | null | undefined): number {
  return node?.start ?? 0;
}

interface CalleeText {
  full: string;
  method: string;
  receiver: t.Node | null;
}

function calleeText(node: t.Node | null | undefined): CalleeText {
  if (!node) return { full: '', method: '', receiver: null };
  if (t.isIdentifier(node)) return { full: node.name, method: node.name, receiver: null };
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    const method = node.property.name;
    const object = node.object;
    let objectText = '';
    if (t.isIdentifier(object)) objectText = object.name;
    else if (t.isThisExpression(object)) objectText = 'this';
    else if (
      t.isMemberExpression(object) &&
      !object.computed &&
      t.isIdentifier(object.object) &&
      t.isIdentifier(object.property)
    ) {
      objectText = `${object.object.name}.${object.property.name}`;
    }
    return { full: objectText ? `${objectText}.${method}` : method, method, receiver: object };
  }
  return { full: '', method: '', receiver: null };
}

/**
 * The name `identifier` will still be spelled with once the run has finished, or
 * `undefined` when nothing can be said about it.
 *
 * A rule that copies a name out of the evidence has to copy the name the
 * *output* will carry. Reading the identifier's current name instead makes the
 * rule derive from a spelling the same run is about to delete, and the second
 * run - which sees the replacement - derives something else.
 *
 * Measured on `lightly-obfuscated.js` at 'aggressive', with only this function's
 * resolution reverted to the raw callee name. A07 names an instance after its
 * class: the file declares `function Ix(...)` and a binding `ja = new Ix()`, so
 * run one emits `ja -> ix` while renaming `Ix` itself to a numbered fallback in
 * the same pass - a name derived from an identifier that appears nowhere in its
 * own output. Run two reads the renamed constructor, A07 declines, and the three
 * bindings named that way go `ix -> val125_2`, `ux -> val126_2`,
 * `ux2 -> val127_2`: 331 characters the first run could not produce.
 *
 * Three answers, and the middle one is the point:
 *
 *   * No binding - a free or host identifier (`Map`, `XMLHttpRequest`, an
 *     import this file cannot rewrite). Nothing renames it, so its own name is
 *     the surviving one and is returned as-is. This is what keeps A07 and A08
 *     working for every ordinary constructor.
 *   * A binding `displayName` will name - either it has already settled on one,
 *     or nothing in this run is going to rename it. That name is returned.
 *   * A binding `displayName` will not name. It is a rename target heading for a
 *     numbered fallback, so there is no name to copy and the rule must fall back
 *     to its own noun.
 */
function survivingName(name: string, scope: Scope, world: NamingWorld): string | undefined {
  if (!scope.getBinding(name)) return name;
  return world.displayName(scope, name);
}

/**
 * Whether `node` is an identifier that resolves, from `scope`, back to `binding`.
 *
 * Several rules build a name as `<source> <noun>`, where `source` is
 * `world.displayName` of an identifier in the evidence. `displayName` reports
 * the name that identifier's binding *will be given*, so when the identifier
 * resolves to the binding being named - `x = JSON.parse(x)`, `x = x.getContext()`
 * - `source` is that binding's own current name and the suggestion is
 * `<current name><Noun>`. The next run reads the new name back out of
 * `displayName` and appends again: `data`, `dataData`, `dataDataData`, ... Two
 * measured cases, each on its own handful-of-lines repro at 'aggressive': A21
 * added 16 characters a run and A05 15. Neither runs away forever - `toCamel`
 * truncates at 32 characters, so both eventually reach a length where two
 * rounds agree, A21 after 7 runs and A05 after 12 (and A05 not monotonically:
 * the first truncation dropped it back to a short name and it climbed again).
 * Bounded is not the same as settled, though. What the engine needs is that run
 * N+1 equals run N, and until the cap bites it does not.
 *
 * Callers pass the same scope they would ask `displayName` about, so this
 * answers the question about exactly the binding whose name would be borrowed.
 * A binding is not evidence about itself, so dropping the source in this one
 * case loses nothing a reader would want: the rule falls back to its bare noun,
 * which is a fixed point.
 */
function refersToBinding(scope: Scope, binding: Binding, node: t.Node | null | undefined): boolean {
  if (!t.isIdentifier(node)) return false;
  return scope.getBinding(node.name) === binding;
}

function declarationKind(binding: Binding): DeclKind {
  const path = binding.path;
  if (path.isCatchClause()) return 'catch';
  if (binding.kind === 'param') return 'param';
  if (path.isFunctionDeclaration() || path.isFunctionExpression()) return 'fn';
  if (path.isClassDeclaration() || path.isClassExpression()) return 'class';
  if (binding.kind === 'module') return 'import';
  if (path.isVariableDeclarator()) {
    const declaration = path.parentPath;
    const outer = declaration?.parentPath;
    if (outer?.isForInStatement()) return 'forIn';
    if (outer?.isForOfStatement()) return 'forOf';
    if (declaration?.isVariableDeclaration()) return declaration.node.kind as DeclKind;
  }
  return 'unknown';
}

/** Whether the object of an assignment target escapes the file through a global. */
function isGlobalObject(node: t.Node, scope: Scope, world: NamingWorld): boolean {
  if (!t.isIdentifier(node)) return false;
  const binding = scope.getBinding(node.name);
  if (!binding) return GLOBAL_OBJECT_NAMES.has(node.name);
  return world.globalAliasIdentifiers.has(binding.identifier);
}

function enclosingLoopDepth(path: NodePath): number {
  let depth = 0;
  let current: NodePath | null = path.parentPath;
  while (current) {
    if (current.isLoop()) depth++;
    current = current.parentPath;
  }
  return depth;
}

function isInsideLoop(path: NodePath): boolean {
  return path.findParent((parent) => parent.isLoop()) !== null;
}

function callbackContextOf(fn: NodePath<t.Function>, world: NamingWorld): CallbackContext | null {
  const parent = fn.parentPath;
  if (!parent?.isCallExpression()) return null;
  const argIndex = fn.node === parent.node.arguments[0] ? 0 : parent.node.arguments.indexOf(fn.node as never);
  if (argIndex < 0) return null;
  const { method, receiver } = calleeText(parent.node.callee);
  if (!method) return null;
  const context: CallbackContext = { method, argIndex };
  if (receiver && t.isIdentifier(receiver)) {
    const resolved = world.displayName(parent.scope, receiver.name);
    if (resolved) context.containerName = resolved;
  }
  if (method === 'addEventListener' || method === 'removeEventListener') {
    const type = staticString(parent.node.arguments[0]);
    if (type) context.eventType = type;
  }
  return context;
}

function functionOf(binding: Binding): NodePath<t.Function> | null {
  const path = binding.path;
  if (path.isFunctionDeclaration()) return path;
  if (path.isVariableDeclarator()) {
    const init = path.get('init');
    if (!Array.isArray(init) && (init.isFunctionExpression() || init.isArrowFunctionExpression())) {
      return init as NodePath<t.Function>;
    }
  }
  return null;
}

/**
 * The function a callee denotes, when this file can see all of it.
 *
 * A literal in callee position, or a name bound once to a function or to a
 * class - `new Vessel(h)` runs the class's constructor, whose parameters name
 * its arguments as a function's do. A name that is written after it is bound
 * calls something else by the time the call runs, so it resolves to nothing.
 */
function calleeFunctionOf(callee: NodePath): NodePath<t.Function> | undefined {
  if (callee.isFunctionExpression() || callee.isArrowFunctionExpression()) return callee;
  if (callee.isClassExpression()) return classConstructor(callee);
  if (callee.isMemberExpression()) return heldFunction(callee);
  return callee.isIdentifier() ? declaredFunction(callee.scope.getBinding(callee.node.name)) : undefined;
}

/** The function or class constructor a name is bound to once and never rebound. */
function declaredFunction(binding: Binding | undefined): NodePath<t.Function> | undefined {
  if (!binding || writesTo(binding).length > 0) return undefined;
  const declaration = binding.path;
  if (declaration.isFunctionDeclaration()) return declaration;
  if (declaration.isClassDeclaration() || declaration.isClassExpression()) {
    return classConstructor(declaration as NodePath<t.Class>);
  }
  if (!declaration.isVariableDeclarator()) return undefined;
  const init = declaration.get('init');
  if (Array.isArray(init)) return undefined;
  if (init.isFunctionExpression() || init.isArrowFunctionExpression()) return init;
  return init.isClassExpression() ? classConstructor(init) : undefined;
}

/**
 * The function a local holder keeps under a key: the shape control-flow
 * flattening leaves behind, a `const h = { xZgXr: function (f, a, b) { return
 * f(a, b); } }` called as `h.xZgXr(parseInt, ch, 16)`, and the revealing
 * module's `const m = (() => { function f(list) {...} return { f: f }; })()`
 * called as `m.f(x)`.
 *
 * The holder must be a binding of an object literal that nothing reassigns and
 * nothing writes that key on, or the call runs something else by the time it
 * runs; a value that is a name resolves as a callee does, to a function bound
 * once.
 */
function heldFunction(member: NodePath<t.MemberExpression>): NodePath<t.Function> | undefined {
  const key = memberKeyOf(member.node);
  if (key === undefined) return undefined;
  const object = member.get('object');
  if (Array.isArray(object) || !object.isIdentifier()) return undefined;
  const binding = object.scope.getBinding(object.node.name);
  if (!binding || writesTo(binding).length > 0) return undefined;
  const literal = holderLiteral(binding) ?? revealedLiteral(binding);
  if (!literal || writesKey(binding, key)) return undefined;
  for (const property of literal.get('properties')) {
    if (property.isObjectMethod()) {
      if (property.node.kind === 'method' && staticKeyOf(property.node) === key) return property;
      continue;
    }
    if (!property.isObjectProperty() || staticKeyOf(property.node) !== key) continue;
    const value = property.get('value');
    if (Array.isArray(value)) return undefined;
    if (value.isFunctionExpression() || value.isArrowFunctionExpression()) return value;
    return value.isIdentifier() ? declaredFunction(value.scope.getBinding(value.node.name)) : undefined;
  }
  return undefined;
}

/**
 * The object literal an IIFE hands back as a binding's value: `const m = (()
 * => { ...; return { f: f }; })()`. The IIFE takes nothing and returns the
 * literal on its one exit - declarations and expression statements up to a
 * final `return {...}` - so that what the binding holds is that literal and
 * nothing else; an `async` one holds a promise.
 */
function revealedLiteral(binding: Binding): NodePath<t.ObjectExpression> | undefined {
  if (!binding.path.isVariableDeclarator()) return undefined;
  const init = binding.path.get('init');
  if (Array.isArray(init) || !init.isCallExpression() || init.node.arguments.length > 0) return undefined;
  const callee = init.get('callee');
  if (!callee.isArrowFunctionExpression() && !callee.isFunctionExpression()) return undefined;
  if (callee.node.params.length > 0 || callee.node.async || callee.node.generator) return undefined;
  const body = callee.get('body');
  if (Array.isArray(body)) return undefined;
  if (body.isObjectExpression()) return body;
  if (!body.isBlockStatement()) return undefined;
  const statements = body.get('body');
  const last = statements[statements.length - 1];
  if (!last?.isReturnStatement()) return undefined;
  for (const statement of statements.slice(0, -1)) {
    if (!statement.isDeclaration() && !statement.isExpressionStatement()) return undefined;
  }
  const returned = last.get('argument');
  return !Array.isArray(returned) && returned.isObjectExpression() ? returned : undefined;
}

/**
 * The Proxy trap a function is: a method of the handler literal handed to
 * `new Proxy(target, handler)` or `Proxy.revocable(target, handler)`, under a
 * trap's name. The literal sits in the call, or in a binding nothing writes
 * that such a call reads. A method of any other object is not a trap, whatever
 * it is called.
 */
function proxyTrapOf(fn: NodePath<t.Function>): string | null {
  const property = fn.isObjectMethod() ? fn : fn.parentPath;
  if (!property?.isObjectMethod() && !property?.isObjectProperty()) return null;
  if (property.isObjectProperty() && property.node.value !== fn.node) return null;
  const key = staticKeyOf(property.node);
  if (key === undefined || !PROXY_TRAPS.has(key)) return null;
  const literal = property.parentPath;
  return literal?.isObjectExpression() && isProxyHandler(literal) ? key : null;
}

function isProxyHandler(literal: NodePath<t.ObjectExpression>): boolean {
  const parent = literal.parentPath;
  if (parent?.isNewExpression() || parent?.isCallExpression()) return constructsProxy(parent, literal.node);
  if (!parent?.isVariableDeclarator() || parent.node.init !== literal.node) return false;
  if (!t.isIdentifier(parent.node.id)) return false;
  const binding = parent.scope.getBinding(parent.node.id.name);
  if (!binding || writesTo(binding).length > 0) return false;
  return binding.referencePaths.some((reference) => {
    const use = reference.parentPath;
    return (use?.isNewExpression() || use?.isCallExpression()) && constructsProxy(use, reference.node);
  });
}

/** `new Proxy(target, handler)` or `Proxy.revocable(target, handler)`, with the builtin `Proxy`. */
function constructsProxy(call: NodePath<t.NewExpression | t.CallExpression>, handler: t.Node): boolean {
  if (call.node.arguments[1] !== handler || call.scope.getBinding('Proxy')) return false;
  const callee = call.node.callee;
  if (call.isNewExpression()) return t.isIdentifier(callee, { name: 'Proxy' });
  return (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.object, { name: 'Proxy' }) &&
    t.isIdentifier(callee.property, { name: 'revocable' })
  );
}

/** The object literal a binding is declared as, when that is what it holds. */
function holderLiteral(binding: Binding): NodePath<t.ObjectExpression> | undefined {
  if (!binding.path.isVariableDeclarator()) return undefined;
  const init = binding.path.get('init');
  return !Array.isArray(init) && init.isObjectExpression() ? init : undefined;
}

/** Whether the program writes `holder.<key>`, which replaces what it holds. */
function writesKey(binding: Binding, key: string): boolean {
  for (const reference of binding.referencePaths) {
    const member = reference.parentPath;
    if (!member?.isMemberExpression() || member.node.object !== reference.node) continue;
    if (memberKeyOf(member.node) !== key) continue;
    const parent = member.parentPath;
    if (parent?.isAssignmentExpression() && parent.node.left === member.node) return true;
    if (parent?.isUpdateExpression()) return true;
    if (parent?.isUnaryExpression() && parent.node.operator === 'delete') return true;
  }
  return false;
}

/** A member's fixed key: `o.k` and `o['k']`, and nothing computed at run time. */
function memberKeyOf(node: t.MemberExpression): string | undefined {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  return node.computed ? staticString(node.property) : undefined;
}

/** An object property's or method's fixed key. */
function staticKeyOf(property: t.ObjectProperty | t.ObjectMethod): string | undefined {
  if (property.computed) return staticString(property.key);
  if (t.isIdentifier(property.key)) return property.key.name;
  return staticString(property.key);
}

/**
 * A class's own constructor.
 *
 * A derived class without one forwards its arguments to the base, whose
 * parameters this does not go looking for: the names would be a level away
 * from the call and the base may be foreign.
 */
function classConstructor(cls: NodePath<t.Class>): NodePath<t.Function> | undefined {
  const body = cls.get('body').get('body');
  for (const member of body) {
    if (member.isClassMethod() && member.node.kind === 'constructor') return member;
  }
  return undefined;
}

/**
 * The parameter an argument is bound to, for D10.
 *
 * A spread at or before the index shifts every parameter after it by an
 * unknown amount, and a parameter that is itself a pattern or a rest names
 * nothing at that index.
 */
function boundParameter(call: NodePath, index: number): ParameterSlot | null {
  const node = call.node;
  if (!t.isCallExpression(node) && !t.isNewExpression(node)) return null;
  for (let i = 0; i <= index; i++) if (t.isSpreadElement(node.arguments[i])) return null;
  const callee = call.get('callee');
  if (Array.isArray(callee)) return null;
  const fn = calleeFunctionOf(callee);
  if (!fn) return null;
  const param = fn.node.params[index];
  return t.isIdentifier(param) ? { name: param.name, scope: fn.scope } : null;
}

/**
 * Every use of a function whose binding this file can enumerate; see
 * {@link FunctionUses}.
 *
 * A function expression in argument or property position has no binding of its
 * own, and its callers are whoever was handed it: `null`, which the callers of
 * this refuse on rather than reading an empty call list as "never called".
 */
function functionUses(fn: NodePath<t.Function>, world: NamingWorld): FunctionUses | null {
  const cached = world.functionUses.get(fn.node);
  if (cached !== undefined) return cached;

  const found = functionBinding(fn);
  let uses: FunctionUses | null = null;
  if (found && writesTo(found.binding).length === 0) {
    uses = { calls: [], tags: 0, escapes: false };
    for (const reference of found.binding.referencePaths) {
      let parent = reference.parentPath;
      let node: t.Node = reference.node;
      if (found.key !== undefined) {
        // Through the holder: this function is what `h.<key>` reads, and a
        // read of another key is a use of a different value entirely.
        if (!parent?.isMemberExpression() || parent.node.object !== node) {
          uses.escapes = true;
          continue;
        }
        const key = memberKeyOf(parent.node);
        if (key !== found.key) {
          if (key === undefined) uses.escapes = true;
          continue;
        }
        node = parent.node;
        parent = parent.parentPath;
      }
      if (!parent) {
        uses.escapes = true;
        continue;
      }
      if ((parent.isCallExpression() || parent.isNewExpression()) && parent.node.callee === node) {
        uses.calls.push(parent as NodePath<t.CallExpression | t.NewExpression>);
      } else if (parent.isTaggedTemplateExpression() && parent.node.tag === node) {
        uses.tags++;
      } else {
        uses.escapes = true;
      }
    }
  }
  world.functionUses.set(fn.node, uses);
  return uses;
}

/**
 * The binding a function is reached through, and the key under it.
 *
 * A function held in an object literal is reached through the holder's
 * binding: every `h.k(...)` is a call of it, and every other use of `h` that
 * this walk cannot resolve to a different key takes the whole holder
 * somewhere, which takes this function with it.
 */
function functionBinding(fn: NodePath<t.Function>): { binding: Binding; key?: string } | undefined {
  if (fn.isFunctionDeclaration()) {
    const id = fn.node.id;
    if (!id) return undefined;
    // A declaration's name is bound in the scope around it, not in its own.
    const declared = fn.scope.parent?.getBinding(id.name) ?? fn.scope.getBinding(id.name);
    return declared ? { binding: declared } : undefined;
  }
  const parent = fn.parentPath;
  if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    const named = parent.scope.getBinding(parent.node.id.name);
    return named ? { binding: named } : undefined;
  }
  if (!parent?.isObjectProperty() || parent.node.value !== fn.node) return undefined;
  const key = staticKeyOf(parent.node);
  if (key === undefined) return undefined;
  const literal = parent.parentPath;
  const declarator = literal?.parentPath;
  if (!literal?.isObjectExpression() || !declarator?.isVariableDeclarator()) return undefined;
  if (!t.isIdentifier(declarator.node.id)) return undefined;
  const holder = declarator.scope.getBinding(declarator.node.id.name);
  if (!holder || writesKey(holder, key)) return undefined;
  return { binding: holder, key };
}

/**
 * The argument each call passes at `index`.
 *
 * A spread anywhere at or before the index leaves nothing at all: the call
 * passes something at that position and this cannot say what, so the set is no
 * longer every call and D11's claim about every caller would be false.
 */
function argumentsAt(
  calls: readonly NodePath<t.CallExpression | t.NewExpression>[],
  index: number,
): Array<{ node: t.Expression; scope: Scope }> {
  const found: Array<{ node: t.Expression; scope: Scope }> = [];
  for (const call of calls) {
    const list = call.node.arguments;
    for (let i = 0; i <= index && i < list.length; i++) if (t.isSpreadElement(list[i])) return [];
    const argument = list[index];
    if (argument && !t.isSpreadElement(argument) && !t.isArgumentPlaceholder(argument)) {
      found.push({ node: argument, scope: call.scope });
    }
  }
  return found;
}

/**
 * The places a binding is written after it is declared: every `=`, `++`,
 * `for (x of ...)` and redeclaration of the name, and nothing else.
 *
 * Babel's `constantViolations` is that list plus one entry the layer must not
 * count. `scope/binding.js` files a `var` or a function declared inside a loop
 * body under its own violations - `for (...) { var f = function () {} }` is
 * "reassigned" by the one declarator that declares it, on the reasoning that
 * the second iteration stores the name again. To a walk asking whether the
 * value it follows is the one the declaration gave the name, that is no
 * write: each iteration stores what the initialiser says, the same as the
 * declarator does outside a loop. Every count of the violations used to give
 * up on that entry - the one-level pin under a catch that reads error text,
 * the caller walk behind a parameter's `.name` read - while the call to the
 * function was still a known one whose argument never escaped, so nothing
 * widened and nothing was disclosed, and the output printed `fn:val1` where the
 * input printed `fn:_0x96d6`. A `var` on the left of a `for...of` gets the same
 * entry; its values are the iterable's elements, which the declaration's
 * facts already read from the loop.
 *
 * Matched on the node: the violation IS `binding.path`, and a second
 * declarator of the same name - `for (...) { var f = g } var f = h` - is a
 * different node, and stays the write it is.
 */
export function writesTo(binding: Binding): NodePath[] {
  const declaration = binding.path.node;
  return binding.constantViolations.filter((violation) => violation.node !== declaration);
}

/**
 * Gather every piece of evidence attached to one binding.
 *
 * The walk is bounded by the binding's own references rather than the program,
 * which is what keeps the whole naming layer linear in identifier count.
 */
export function collectFacts(binding: Binding, world: NamingWorld): BindingFacts {
  const declKind = declarationKind(binding);
  const facts: BindingFacts = {
    binding,
    name: binding.identifier.name,
    anchor: anchorOf(binding.identifier),
    declKind,
    shapes: [],
    members: new Map(),
    callSites: [],
    usedAsCallee: 0,
    ops: new Set(),
    comparedStrings: [],
    storedInto: [],
    indexedInto: [],
    usedAsIndex: false,
    iterated: false,
    concatenatedWithText: false,
    stepped: false,
    listMethod: null,
    jsx: false,
    escapeReason: null,
    paramIndex: -1,
    ownerFunction: null,
    functionPath: functionOf(binding),
    callbackContext: null,
    patternKey: null,
    isRestParam: false,
    usedAsConstructor: 0,
    callerArguments: [],
    templateTag: false,
    proxyTrap: null,
    incremented: false,
    indexedRead: false,
    loopDepth: enclosingLoopDepth(binding.path),
    isLoopCounter: false,
    forOfContainer: null,
    forInObject: null,
    accumulates: false,
    assignedInLoopWithBreak: false,
    switchLabels: [],
    typeAnnotation: null,
    returnsJsx: false,
    callsHooks: false,
    moduleSpecifier: null,
  };

  collectDeclarationFacts(facts, binding, world);
  for (const ref of binding.referencePaths) analyzeReference(facts, ref, world);
  for (const violation of binding.constantViolations) analyzeViolation(facts, violation, world);
  // The only signals this traversal produces are React-specific, so on plain
  // JavaScript it would be a per-function walk that can never fire a rule.
  if (world.jsx && facts.functionPath) analyzeFunctionBody(facts, facts.functionPath);

  return facts;
}

function collectDeclarationFacts(facts: BindingFacts, binding: Binding, world: NamingWorld): void {
  const path = binding.path;

  if (path.isVariableDeclarator()) {
    if (path.node.init) facts.shapes.push(path.node.init);
    const declaration = path.parentPath;
    const outer = declaration?.parentPath;
    if (outer?.isForOfStatement()) facts.forOfContainer = outer.node.right;
    if (outer?.isForInStatement()) facts.forInObject = outer.node.right;
    if (outer?.isForStatement() && declaration?.node === outer.node.init) {
      facts.isLoopCounter = isLoopCounter(binding, outer);
      facts.loopDepth = enclosingLoopDepth(outer) + 1;
    }
    findPatternKey(facts, path.node.id, binding.identifier);
  }

  if (binding.kind === 'param') {
    const paramPath = path;
    if (paramPath.listKey === 'params' && typeof paramPath.key === 'number') {
      facts.paramIndex = paramPath.key;
    }
    // The whole parameter, not the name inside it: `(...rest)` binds through a
    // RestElement and `(x = 0)` through an AssignmentPattern, and both are the
    // path Babel files the binding under.
    facts.isRestParam = paramPath.isRestElement();
    const owner = paramPath.parentPath;
    if (owner?.isFunction()) {
      facts.ownerFunction = owner;
      facts.callbackContext = callbackContextOf(owner, world);
      facts.proxyTrap = proxyTrapOf(owner);
      const uses = functionUses(owner, world);
      if (uses && !uses.escapes) {
        facts.templateTag = uses.tags > 0 && uses.calls.length === 0;
        if (facts.paramIndex >= 0 && !facts.isRestParam) {
          facts.callerArguments = argumentsAt(uses.calls, facts.paramIndex);
        }
      }
    }
    findPatternKey(facts, paramPath.node as t.Node, binding.identifier);
  }

  if (path.isImportDefaultSpecifier() || path.isImportSpecifier() || path.isImportNamespaceSpecifier()) {
    const declaration = path.parentPath;
    if (declaration?.isImportDeclaration()) facts.moduleSpecifier = declaration.node.source.value;
  }

  const annotated = binding.identifier.typeAnnotation;
  if (annotated && t.isTSTypeAnnotation(annotated)) facts.typeAnnotation = annotated.typeAnnotation;

  const declarationParent = path.parentPath?.parentPath;
  if (
    path.parentPath?.isExportNamedDeclaration() ||
    path.parentPath?.isExportDefaultDeclaration() ||
    declarationParent?.isExportNamedDeclaration() ||
    declarationParent?.isExportDefaultDeclaration()
  ) {
    facts.escapeReason = 'exported';
  }
}

/** `const { foo: x } = y` records `foo`; `const { x } = y` records the shorthand flag. */
function findPatternKey(facts: BindingFacts, pattern: t.Node, target: t.Identifier): void {
  if (!t.isObjectPattern(pattern)) return;
  for (const property of pattern.properties) {
    if (!t.isObjectProperty(property)) continue;
    let value = property.value;
    if (t.isAssignmentPattern(value)) value = value.left;
    if (value !== target) continue;
    // A shorthand key is already the name; `index.ts` declines those outright.
    if (property.shorthand) return;
    const key = property.computed ? undefined : t.isIdentifier(property.key)
      ? property.key.name
      : staticString(property.key);
    if (key) facts.patternKey = key;
    return;
  }
}

function isLoopCounter(binding: Binding, loop: NodePath<t.ForStatement>): boolean {
  const { test, update } = loop.node;
  if (!test || !update) return false;
  const name = binding.identifier.name;
  const mentions = (node: t.Node | null | undefined): boolean => {
    if (!node) return false;
    if (t.isIdentifier(node)) return node.name === name;
    if (t.isBinaryExpression(node)) return mentions(node.left) || mentions(node.right);
    if (t.isUpdateExpression(node)) return mentions(node.argument);
    if (t.isAssignmentExpression(node)) return mentions(node.left);
    if (t.isMemberExpression(node)) return mentions(node.object) || mentions(node.property);
    return false;
  };
  return mentions(test) && mentions(update);
}

function analyzeReference(facts: BindingFacts, ref: NodePath, world: NamingWorld): void {
  const node = ref.node;
  if (t.isJSXIdentifier(node)) {
    facts.jsx = true;
    return;
  }
  const parent = ref.parent;
  const parentPath = ref.parentPath;
  if (!parent || !parentPath) return;

  // Recorded before the dispatch below, because a value reaches a bracket both
  // as itself and through arithmetic, and those arrive in two different arms.
  const indexed = indexedMember(ref);
  if (indexed && !refersToBinding(ref.scope, facts.binding, indexed.object)) {
    facts.usedAsIndex = true;
    if (t.isIdentifier(indexed.object)) facts.indexedInto.push({ scope: ref.scope, name: indexed.object.name });
  }

  if (parentPath.isExportSpecifier() || parentPath.isExportDefaultDeclaration()) {
    facts.escapeReason ??= 'exported';
    return;
  }

  if (t.isMemberExpression(parent)) {
    if (parent.object === node) {
      recordMemberAccess(facts, ref, parent);
      return;
    }
    // A computed read's position is recorded above, by `indexedMember`.
    if (parent.computed && parent.property === node && t.isIdentifier(parent.object)) return;
  }

  if ((t.isCallExpression(parent) || t.isNewExpression(parent)) && parent.callee === node) {
    facts.usedAsCallee++;
    if (t.isNewExpression(parent)) facts.usedAsConstructor++;
    return;
  }

  if (t.isCallExpression(parent) || t.isNewExpression(parent)) {
    const argIndex = parent.arguments.indexOf(node as never);
    if (argIndex >= 0) {
      const { full, method } = calleeText(parent.callee);
      facts.callSites.push({
        full,
        method,
        argIndex,
        arity: parent.arguments.length,
        anchor: anchorOf(parent),
        firstStringArg: staticString(parent.arguments[0]),
        parameter: boundParameter(parentPath, argIndex),
      });
      return;
    }
  }

  if (t.isAssignmentExpression(parent) && parent.right === node) {
    if (t.isMemberExpression(parent.left)) {
      recordStore(facts, parent.left, ref, world);
    }
    return;
  }

  if (t.isObjectProperty(parent) && parent.value === node && !parent.computed) {
    const key = t.isIdentifier(parent.key) ? parent.key.name : staticString(parent.key);
    if (key) facts.storedInto.push({ object: null, key, isThis: false, anchor: anchorOf(parent) });
    return;
  }

  if (t.isBinaryExpression(parent) || t.isLogicalExpression(parent)) {
    facts.ops.add(parent.operator);
    const other = parent.left === node ? parent.right : parent.left;
    if (['===', '==', '!==', '!='].includes(parent.operator)) {
      const literal = staticString(other);
      if (literal !== undefined) facts.comparedStrings.push(literal);
    }
    if (parent.operator === '+' && t.isStringLiteral(other)) facts.concatenatedWithText = true;
    return;
  }

  // `for (const ch of binding)` and `[...binding]` walk the value's elements.
  // A RestElement is not the same shape: it binds a name, and a reference
  // never sits directly under one.
  if (t.isForOfStatement(parent) && parent.right === node) {
    facts.iterated = true;
    return;
  }
  if (parentPath.isSpreadElement()) {
    facts.iterated = true;
    return;
  }

  if (t.isUnaryExpression(parent)) {
    facts.ops.add(parent.operator);
    return;
  }

  if (t.isUpdateExpression(parent)) {
    facts.incremented = true;
    facts.stepped = true;
    return;
  }

  if (t.isSwitchStatement(parent) && parent.discriminant === node) {
    for (const clause of parent.cases) {
      const label = staticString(clause.test);
      if (label !== undefined) facts.switchLabels.push(label);
    }
  }
}

/**
 * The member read this value is the position of: `rows[cursor]` directly, or
 * through the arithmetic a position is written with, `rows[cursor - 1]`.
 *
 * Bounded, and only over the operators that move a position. A value three
 * operations away from the bracket is a term in a computation, not the
 * position, and `rows[map[key]]` reaches the outer bracket through a member
 * read, where the walk stops for the same reason.
 *
 * `x[x]` indexes a binding by itself, which is not evidence that it indexes
 * anything: F02 would name it `<current name>Index` and each later run would
 * append to that again. The caller refuses that with `refersToBinding`, on the
 * same reasoning as A05 and A21.
 */
function indexedMember(ref: NodePath): t.MemberExpression | undefined {
  let node: t.Node = ref.node;
  let path: NodePath | null = ref.parentPath;
  for (let depth = 0; path && depth < INDEX_DEPTH; depth++) {
    const parent = path.node;
    if (t.isMemberExpression(parent)) {
      return parent.computed && parent.property === node ? parent : undefined;
    }
    if (!t.isBinaryExpression(parent) || !INDEX_OPERATORS.has(parent.operator)) return undefined;
    node = parent;
    path = path.parentPath;
  }
  return undefined;
}

const INDEX_DEPTH = 3;
const INDEX_OPERATORS: ReadonlySet<string> = new Set(['+', '-', '*', '%']);

function recordMemberAccess(facts: BindingFacts, ref: NodePath, parent: t.MemberExpression): void {
  let key: string | undefined;
  if (!parent.computed && t.isIdentifier(parent.property)) key = parent.property.name;
  else if (parent.computed) {
    key = staticString(parent.property);
    // Everything computed that is not a fixed string is a read at a position:
    // `rows[4]` and `rows[i]` are the same evidence, and it was the literal
    // form alone before - which the obfuscator's own output almost never has,
    // since it moves the index into a variable. B11, the one rule that reads
    // this, asks for a `.length` beside it, so a dictionary read `map[key]`
    // still needs that second half before anything calls it a list.
    if (key === undefined) {
      facts.indexedRead = true;
      return;
    }
  }
  if (!key) return;
  facts.members.set(key, (facts.members.get(key) ?? 0) + 1);
  if (facts.listMethod === null && LIST_METHODS.has(key)) {
    const call = ref.parentPath?.parentPath;
    if (call && (call.isCallExpression() || call.isOptionalCallExpression()) && call.node.callee === parent) {
      if (isCallback(call.node.arguments[0], call.scope)) facts.listMethod = key;
    }
  }
}

/**
 * Whether a call's first argument is a function: a literal, or a name bound
 * once to one in sight. A free name is refused rather than read as a builtin:
 * `.map(Number)` passes one, and so does `Model.find(userId)`.
 */
function isCallback(argument: t.Node | undefined, scope: Scope): boolean {
  if (t.isFunctionExpression(argument) || t.isArrowFunctionExpression(argument)) return true;
  if (!t.isIdentifier(argument)) return false;
  const binding = scope.getBinding(argument.name);
  return binding !== undefined && writesTo(binding).length === 0 && functionOf(binding) !== null;
}

function recordStore(
  facts: BindingFacts,
  target: t.MemberExpression,
  ref: NodePath,
  world: NamingWorld,
): void {
  if (isGlobalObject(target.object, ref.scope, world)) {
    facts.escapeReason ??= 'assigned to a global object member';
    return;
  }
  let key: string | undefined;
  if (!target.computed && t.isIdentifier(target.property)) key = target.property.name;
  // `this.#value = v` is the same evidence as `this.value = v` - the field's
  // own word for what it holds - and a private name is never computed, so it
  // cannot be reached any other way.
  else if (t.isPrivateName(target.property)) key = target.property.id.name;
  else key = staticString(target.property);
  if (!key) return;
  if (t.isThisExpression(target.object)) {
    facts.storedInto.push({ object: null, key, isThis: true, anchor: anchorOf(target) });
    return;
  }
  const objectName = t.isIdentifier(target.object) ? target.object.name : null;
  facts.storedInto.push({ object: objectName, key, isThis: false, anchor: anchorOf(target) });
}

function analyzeViolation(
  facts: BindingFacts,
  violation: NodePath,
  world: NamingWorld,
): void {
  if (violation.isUpdateExpression()) {
    facts.incremented = true;
    facts.stepped = true;
    return;
  }
  if (violation.isAssignmentExpression()) {
    const { operator, right } = violation.node;
    if (operator === '=') facts.shapes.push(right);
    if (operator === '+=' || operator === '-=') {
      facts.incremented = true;
      if (isInsideLoop(violation)) facts.accumulates = true;
    }
    if (writtenInsideSearchLoop(violation, world)) facts.assignedInLoopWithBreak = true;
    return;
  }
  if (violation.isForXStatement()) {
    if (violation.isForOfStatement()) facts.forOfContainer = violation.node.right;
    if (violation.isForInStatement()) facts.forInObject = violation.node.right;
  }
}

/**
 * F07's evidence: this write happens in the body of a loop that a `break` leaves.
 *
 * Every enclosing loop is considered, not just the nearest, because a labelled
 * `break outer` exits the outer loop of a nest while the write sits in the inner
 * one - which is what a two-dimensional search looks like.
 *
 * The write must be in that loop's *body*: `for (i = 0, dec = table; i < n; i++)`
 * assigns in the header, which runs once. F07 claims the binding is written
 * repeatedly while a search runs, and without this the rule named loop counters
 * and hoisted decoder aliases `found`.
 */
function writtenInsideSearchLoop(violation: NodePath, world: NamingWorld): boolean {
  let loop = violation.findParent((parent) => parent.isLoop());
  while (loop) {
    if (world.breakingLoops.has(loop.node) && isInLoopBody(violation, loop)) return true;
    loop = loop.findParent((parent) => parent.isLoop());
  }
  return false;
}

function isInLoopBody(violation: NodePath, loop: NodePath): boolean {
  let current: NodePath | null = violation;
  while (current && current.parentPath !== loop) current = current.parentPath;
  return current?.key === 'body';
}

function analyzeFunctionBody(facts: BindingFacts, fn: NodePath<t.Function>): void {
  const body = fn.get('body');
  if (Array.isArray(body)) return;
  if (body.isExpression()) {
    facts.returnsJsx = body.isJSXElement() || body.isJSXFragment();
    return;
  }
  let sawJsxReturn = false;
  let sawHook = false;
  body.traverse({
    ReturnStatement(returnPath) {
      if (returnPath.getFunctionParent() !== fn) return;
      const argument = returnPath.node.argument;
      if (t.isJSXElement(argument) || t.isJSXFragment(argument)) sawJsxReturn = true;
    },
    CallExpression(callPath) {
      const callee = callPath.node.callee;
      const name = t.isIdentifier(callee)
        ? callee.name
        : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
          ? callee.property.name
          : '';
      if (/^use[A-Z]/.test(name)) sawHook = true;
    },
  });
  facts.returnsJsx = sawJsxReturn;
  facts.callsHooks = sawHook;
}

// ---------------------------------------------------------------------------
// Rule firing
// ---------------------------------------------------------------------------

class CandidateSink {
  readonly items: NameCandidate[] = [];

  constructor(
    private readonly facts: BindingFacts,
    private readonly world: NamingWorld,
  ) {}

  /**
   * `weight` below 1 marks a name borrowed from another binding, using the §7
   * edge weights: 0.9 for a receiver, 0.8 for a container, 0.6 for a plain copy.
   */
  push(
    raw: string | undefined,
    ruleId: string,
    tier: Tier,
    score: number,
    reason: string,
    anchor = this.facts.anchor,
    weight = 1,
    kind: NameKind = 'var',
  ): boolean {
    if (!raw) return false;
    const name = raw.length > 32 ? raw.slice(0, 32) : raw;
    if (name.length === 0) return false;
    if (!t.isValidIdentifier(name, false)) return false;
    if (isReservedName(name, this.world.typescript)) return false;
    if (name === '_' || name === '$') return false;
    this.items.push({
      name,
      kind,
      tier,
      confidence: Math.max(0, Math.min(1, (score / 100) * weight)),
      ruleId,
      reason,
      anchor,
      hops: weight < 1 ? 1 : 0,
    });
    return true;
  }
}

/**
 * Fire every rule against one binding's facts.
 *
 * Rules only read `facts` and `world`; the ranking in `allocate.ts` is what
 * turns the resulting bag of candidates into a decision, so a rule that fires
 * spuriously costs confidence rather than correctness.
 */
export function inferCandidates(facts: BindingFacts, world: NamingWorld): NameCandidate[] {
  const sink = new CandidateSink(facts, world);

  applyHints(sink, facts, world);
  applyShapeRules(sink, facts, world);
  applyDuckTyping(sink, facts);
  applyParameterRules(sink, facts, world);
  applyCallSiteRules(sink, facts, world);
  applyStructuralRules(sink, facts, world);
  applyFunctionRules(sink, facts, world);
  applyLoopRules(sink, facts, world);
  applyUsageRules(sink, facts, world);
  applyLiteralRules(sink, facts);
  applyFrameworkRules(sink, facts, world);
  applyObfuscatorRules(sink, facts, world);

  return sink.items;
}

function applyHints(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  for (const hint of world.hints) {
    const matched = hint.regex ? hint.regex.test(facts.name) : hint.source === facts.name;
    if (matched) sink.push(hint.name, 'H00', 0, 100, `caller hint ${hint.source}`);
  }
}

function applyShapeRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  for (const shape of facts.shapes) {
    applyShapeRule(sink, facts, world, shape);
  }
}

function applyShapeRule(
  sink: CandidateSink,
  facts: BindingFacts,
  world: NamingWorld,
  shape: t.Expression,
): void {
  const anchor = anchorOf(shape);
  const scope = facts.binding.scope;

  if (t.isAwaitExpression(shape)) {
    const inner = shape.argument;
    if (t.isCallExpression(inner)) {
      const { full, method } = calleeText(inner.callee);
      if (full === 'fetch') {
        sink.push('response', 'C08', 1, 92, 'awaited fetch()', anchor);
        return;
      }
      if (method === 'json' || method === 'text') {
        sink.push('data', 'C09', 1, 82, `awaited .${method}()`, anchor);
        return;
      }
    }
    applyShapeRule(sink, facts, world, inner as t.Expression);
    return;
  }

  if (t.isNewExpression(shape)) {
    const ctor = t.isIdentifier(shape.callee)
      ? survivingName(shape.callee.name, facts.binding.scope, world)
      : undefined;
    if (ctor) {
      const alias = CTOR_ALIASES.get(ctor);
      if (alias) sink.push(alias, 'A08', 1, 90, `new ${ctor}()`, anchor);
      // A07 names the instance after its class, which only reads as an instance
      // when the class is spelled like one. `new on(1)` lower-cases to `on`, the
      // constructor's own name, so the allocator disambiguates it to `on2` -
      // which reads as a second constructor, not as a thing the constructor made.
      else if (/^[A-Z]/.test(ctor)) {
        sink.push(lowerFirst(toCamel(ctor)), 'A07', 1, 84, `new ${ctor}()`, anchor);
      }
      if (ctor === 'Audio') {
        const src = staticString(shape.arguments[0]);
        if (src && looksLikePath(src)) {
          sink.push(
            toCamel(`${basenameNoExt(src)} sound`),
            'A10',
            1,
            86,
            `new Audio(${JSON.stringify(src)})`,
            anchor,
          );
        }
      }
    }
    return;
  }

  if (t.isCallExpression(shape)) {
    applyCallShapeRule(sink, facts, world, shape, anchor);
    return;
  }

  if (t.isMemberExpression(shape) && !shape.computed && t.isIdentifier(shape.property)) {
    sink.push(toCamel(shape.property.name), 'D06', 2, 74, `read from .${shape.property.name}`, anchor);
    return;
  }

  if (t.isArrayExpression(shape)) {
    if (shape.elements.length === 0 && facts.members.has('push')) {
      sink.push('items', 'A11', 2, 62, 'empty array, only pushed into', anchor);
    } else if (shape.elements.length > 0) {
      sink.push('items', 'A11', 2, 55, 'array literal', anchor);
    }
    return;
  }

  if (t.isObjectExpression(shape)) {
    const keys = shape.properties.filter((p) => t.isObjectProperty(p)).length;
    if (keys === 0 && facts.members.size > 0) {
      // `record`, not `cache`: `{}` filled in through fixed dot keys is how a
      // struct is built, and says nothing about memoisation. The corpus fills
      // eleven of these with `{s, c, cc}` channel rows, none of them a cache.
      sink.push('record', 'A13', 2, 58, 'empty object filled in by name', anchor);
    } else if (keys >= 2) {
      // Weak on purpose, and left weak. "Two or more keys" is nearly no evidence
      // - it fires on a 68-key lookup table as readily as on a settings object -
      // and 0.48 cannot carry a name past any preset's floor on its own, so this
      // only ever tips a decision another rule has already half made. Making the
      // claim honest would take evidence about how the object is *read*, which
      // this arm does not collect; lowering the score changes no output.
      sink.push('config', 'A14', 2, 48, `object literal with ${keys} keys`, anchor);
    }
    return;
  }

  if (t.isBooleanLiteral(shape)) {
    sink.push('flag', 'A16', 3, 40, `initialised to ${shape.value}`, anchor);
    return;
  }

  if (t.isNumericLiteral(shape) && shape.value === 0 && facts.incremented && !facts.accumulates) {
    sink.push('count', 'A15', 2, 60, 'zero-initialised counter', anchor);
    return;
  }

  if (t.isRegExpLiteral(shape)) {
    sink.push('pattern', 'G03', 1, 76, 'regular expression literal', anchor);
    return;
  }

  if (t.isStringLiteral(shape)) {
    applyStringShapeRule(sink, shape.value, anchor);
    return;
  }

  if (t.isIdentifier(shape)) {
    const alias = world.displayName(scope, shape.name);
    if (alias && alias !== facts.name) {
      sink.push(alias, 'D09', 3, 66, `copied from ${shape.name}`, anchor, 0.6);
    }
  }
}

function applyStringShapeRule(sink: CandidateSink, value: string, anchor: number): void {
  if (looksLikeUrl(value)) {
    sink.push('url', 'G01', 1, 80, 'string literal is a URL', anchor);
    return;
  }
  if (looksLikeSelector(value)) {
    const ident = identFromString(value.slice(1));
    if (ident) sink.push(toCamel(`${ident} selector`), 'G02', 1, 78, 'CSS selector literal', anchor);
    return;
  }
  if (looksLikePath(value)) {
    sink.push('path', 'G01', 2, 62, 'string literal is a path', anchor);
  }
}

function applyCallShapeRule(
  sink: CandidateSink,
  facts: BindingFacts,
  world: NamingWorld,
  call: t.CallExpression,
  anchor: number,
): void {
  const { full, method, receiver } = calleeText(call.callee);
  const firstString = staticString(call.arguments[0]);

  if (full === 'require') {
    const specifier = staticString(call.arguments[0]);
    if (specifier) {
      // `lodash` and `jquery` map to `_` and `$`, which the sink refuses as too
      // short to be worth reading. Pushing the alias and returning left those two
      // specifiers with no candidate at all, so `require('lodash')` fell through
      // to the typed fallback and came out `val1`. Fall back to the basename.
      const alias = MODULE_ALIASES.get(specifier);
      const placed =
        alias !== undefined &&
        sink.push(alias, 'A20', 0, 98, `require(${JSON.stringify(specifier)})`, anchor);
      if (!placed) {
        sink.push(
          toCamel(lastPathSegment(specifier)),
          'A18',
          0,
          96,
          `require(${JSON.stringify(specifier)})`,
          anchor,
        );
      }
      return;
    }
  }

  if (method === 'getElementById' && firstString !== undefined) {
    const ident = identFromString(firstString);
    if (ident) {
      const name = endsWithElementWord(firstString) ? ident : toCamel(`${ident} el`);
      sink.push(name, 'A01', 1, 92, `getElementById(${JSON.stringify(firstString)})`, anchor);
    }
    return;
  }

  if (method === 'querySelector' && firstString !== undefined) {
    const ident = identFromString(firstString.replace(/^[#.]/, ''));
    if (ident) sink.push(toCamel(`${ident} el`), 'A02', 1, 88, 'querySelector()', anchor);
    return;
  }

  if (
    (method === 'querySelectorAll' ||
      method === 'getElementsByClassName' ||
      method === 'getElementsByTagName') &&
    firstString !== undefined
  ) {
    const ident = identFromString(firstString.replace(/^[#.]/, ''));
    if (ident) sink.push(plural(toCamel(`${ident} el`)), 'A03', 1, 88, `${method}()`, anchor);
    return;
  }

  if (method === 'createElement' && firstString !== undefined) {
    const ident = identFromString(firstString);
    if (ident) sink.push(toCamel(`${ident} el`), 'A04', 1, 86, `createElement(${firstString})`, anchor);
    return;
  }

  if (method === 'getContext') {
    const mode = firstString ?? '';
    // `x = x.getContext('2d')` makes the receiver the binding being named, so
    // `base` would be its own current name and the suggestion `<name>Ctx`, which
    // the next run extends again. The bare `ctx`/`gl` fallback is a fixed point;
    // see `refersToBinding`.
    const receiverName =
      t.isIdentifier(receiver) && !refersToBinding(facts.binding.scope, facts.binding, receiver)
        ? world.displayName(facts.binding.scope, receiver.name)
        : undefined;
    const base = receiverName ? stripElementSuffix(receiverName) : '';
    if (mode === 'webgl' || mode === 'webgl2' || mode === 'experimental-webgl') {
      sink.push(base ? toCamel(`${base} gl`) : 'gl', 'A06', 1, 94, `getContext(${mode})`, anchor, base ? 0.9 : 1);
    } else {
      sink.push(
        base ? toCamel(`${base} ctx`) : 'ctx',
        'A05',
        1,
        94,
        `getContext(${mode || '2d'})`,
        anchor,
        base ? 0.9 : 1,
      );
    }
    return;
  }

  if (full === 'JSON.parse') {
    const argument = call.arguments[0];
    // `x = JSON.parse(x)` parses a binding in place, so the argument is the
    // binding being named and `${source} data` is `<current name>Data`, which the
    // next run extends again. The bare `data` fallback is a fixed point and says
    // the same thing; see `refersToBinding`.
    const source =
      t.isIdentifier(argument) && !refersToBinding(facts.binding.scope, facts.binding, argument)
        ? world.displayName(facts.binding.scope, argument.name)
        : undefined;
    sink.push(source ? toCamel(`${source} data`) : 'data', 'A21', 1, 78, 'JSON.parse()', anchor);
    return;
  }

  if (full === 'localStorage.getItem' || full === 'sessionStorage.getItem') {
    const ident = firstString ? identFromString(firstString) : undefined;
    sink.push(ident ?? 'stored', 'G11', 1, 86, `${full}()`, anchor);
    return;
  }

  if (full === 'Math.floor') {
    const inner = call.arguments[0];
    if (
      t.isBinaryExpression(inner) &&
      inner.operator === '*' &&
      isMathRandom(inner.left) !== isMathRandom(inner.right)
    ) {
      sink.push('randomIndex', 'G10', 1, 84, 'Math.floor(Math.random() * n)', anchor);
      return;
    }
  }

  if (method === 'split') {
    const separator = firstString;
    const name =
      separator === '\n' ? 'lines' : separator === ',' ? 'values' : separator === '/' ? 'segments' : 'parts';
    sink.push(name, 'A22', 2, 70, `split(${JSON.stringify(separator ?? '')})`, anchor);
    return;
  }

  const known = CALL_RESULT_RULES.get(full);
  if (known) {
    sink.push(known.name, known.id, known.tier, known.score, `${full}()`, anchor);
    return;
  }

  if (full === 'fetch') {
    sink.push('request', 'C08', 2, 66, 'fetch() promise', anchor);
    return;
  }

  if (method && !full.includes('.')) return;

  if (method) {
    const stripped = stripGetterPrefix(method);
    if (stripped && stripped !== method) {
      sink.push(stripped, 'D07', 1, 80, `result of .${method}()`, anchor);
    }
  }
}

function isMathRandom(node: t.Node | null | undefined): boolean {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: 'Math' }) &&
    t.isIdentifier(node.callee.property, { name: 'random' })
  );
}

function applyDuckTyping(sink: CandidateSink, facts: BindingFacts): void {
  if (facts.members.size === 0) return;
  for (const method of facts.members.keys()) {
    if (!TEXT_METHODS.has(method)) continue;
    sink.push('text', 'B17', 1, 80, `calls .${method}(), which only a string has`);
    break;
  }
  if (facts.listMethod !== null) {
    sink.push('items', 'B18', 2, 66, `calls .${facts.listMethod}() with a callback, which a list does`);
  }
  for (const signature of DUCK_SIGNATURES) {
    let hits = 0;
    for (const property of signature.props) if (facts.members.has(property)) hits++;
    if (hits < signature.minHits) continue;
    sink.push(
      signature.name,
      signature.id,
      signature.tier,
      signature.score,
      `accesses ${hits} of ${signature.props.length} ${signature.name} properties`,
    );
  }
}

/**
 * What a parameter is, read off the way its own function is used and the way
 * the body uses it - the evidence left on a decoded obfuscator.io file, where
 * the program's functions keep their names and their parameters do not.
 *
 * Every arm needs the parameter's *position*, so none of them can fire for a
 * local: a value called once is a function wherever it sits, but only a
 * parameter is "the second argument of every call".
 */
function applyParameterRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  if (facts.declKind !== 'param') return;

  // A tag's parameters are fixed by the language: the cooked strings, then one
  // substitution per hole. `templateTag` is only set when nothing calls the
  // function normally, so this cannot fight an ordinary call's evidence.
  if (facts.templateTag) {
    if (facts.paramIndex === 0) {
      sink.push('strings', 'P03', 1, 88, 'first parameter of a template tag');
      return;
    }
    sink.push(facts.isRestParam ? 'values' : 'value', 'P03', 1, 84, 'substitution of a template tag');
    return;
  }

  // A Proxy trap's parameters are fixed by the language as a tag's are -
  // `apply(target, thisArg, args)`, `get(target, key, receiver)` - and the
  // handler literal is called by nothing but the proxy.
  if (facts.proxyTrap !== null && !facts.isRestParam) {
    const name = PROXY_TRAPS.get(facts.proxyTrap)?.[facts.paramIndex];
    if (name) {
      sink.push(name, 'P05', 1, 88, `parameter ${facts.paramIndex} of a Proxy ${facts.proxyTrap} trap`);
      return;
    }
  }

  if (facts.isRestParam) sink.push('args', 'P01', 1, 80, 'rest parameter');

  // `function (a, b) { return a ^ b; }` - the proxy control-flow flattening
  // puts an operator behind. E07 names the function after the operator; these
  // are its operands, and which one is which is the whole of what they are.
  // Not for a callback: `users.map(function (a, b) { return a + b; })` is one
  // binary operation too, and what fills its parameters is the call, which
  // C12 and C13 read. The proxy this rule is for is called by name.
  const operand = facts.callbackContext ? undefined : operandPosition(facts);
  if (operand) sink.push(operand, 'P04', 1, 78, 'operand of a single binary operation');

  if (facts.usedAsConstructor > 0) {
    sink.push('ctor', 'P02', 1, 78, 'used with new', facts.anchor, 1, 'class');
  } else if (facts.usedAsCallee > 0) {
    sink.push('fn', 'P02', 1, 76, 'called', facts.anchor, 1, 'fn');
  }

  // D11: the caller's word for the value. `callerArguments` is empty unless
  // every use of this function is a call this file can see, so the names below
  // are all the names this parameter is ever passed under. Disagreement is not
  // resolved by picking one - two callers with two words for the argument say
  // nothing about the parameter - and a call that passes the parameter back to
  // its own function is recursion, not a source.
  let source: ArgumentName | undefined;
  let anchor = facts.anchor;
  for (const argument of facts.callerArguments) {
    if (refersToBinding(argument.scope, facts.binding, argument.node)) continue;
    const named = argumentName(argument.node, argument.scope, world);
    if (!named) return;
    if (source !== undefined && source.name !== named.name) return;
    source = named;
    anchor = anchorOf(argument.node);
  }
  // A property key is a fixed string in the program, so nothing is borrowed
  // from another binding and the §7 copy weight does not apply; a name read off
  // an identifier is a spelling that belongs to a binding of its own.
  if (source) {
    sink.push(source.name, 'D11', 1, 84, `passed ${source.name} by every caller`, anchor, source.borrowed ? 0.8 : 1);
  }
}

/**
 * The word a call site uses for an argument, when it has one worth copying.
 *
 * `isReadableName` is the filter rather than "is it a name at all": a
 * parameter called `i` or `_0x4a68` because its caller passes `i` or `_0x4a68`
 * has been given the obfuscator's spelling a second time. `displayName`
 * answers with the name the output will carry, so a caller whose own binding
 * this run is about to rename contributes nothing until that name settles.
 */
function argumentName(
  node: t.Expression,
  scope: Scope,
  world: NamingWorld,
): ArgumentName | undefined {
  let name: string | undefined;
  let borrowed = false;
  if (t.isIdentifier(node)) {
    name = survivingName(node.name, scope, world);
    borrowed = true;
  } else if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    name = node.property.name;
  }
  if (!name || !isReadableName(name)) return undefined;
  return { name: toCamel(name), borrowed };
}

/** A caller's word for an argument, and whether it is another binding's spelling. */
interface ArgumentName {
  name: string;
  borrowed: boolean;
}

function applyCallSiteRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  for (const site of facts.callSites) {
    // D10: the callee's own word for this argument. The parameter is resolved
    // through `displayName`, so a parameter this run is renaming contributes
    // the name it is being given rather than the one it is losing, and a
    // parameter that is heading for a numbered fallback contributes nothing.
    const slot = site.parameter;
    if (slot && slot.scope.getBinding(slot.name) !== facts.binding) {
      const name = world.displayName(slot.scope, slot.name);
      if (name && isReadableName(name)) {
        sink.push(
          toCamel(name),
          'D10',
          1,
          82,
          site.full ? `bound to the ${name} parameter of ${site.full}()` : `bound to the ${name} parameter`,
          site.anchor,
          0.9,
        );
      }
    }
    // Both spellings, and only once when they are the same: a bare `slice`
    // matches `slice` and a dotted `Reflect.apply` matches itself.
    for (const callee of site.full === site.method ? [site.full] : [site.full, site.method]) {
      for (const rule of ARG_POSITION_RULES.get(callee) ?? []) {
        if (rule.index !== site.argIndex) continue;
        sink.push(rule.name, rule.id, rule.tier, rule.score, `argument ${site.argIndex} of ${rule.callee}`, site.anchor);
      }
    }
    if (site.argIndex === site.arity - 1 && site.arity > 1) {
      const shape = facts.shapes[0];
      if (shape && t.isObjectExpression(shape)) {
        sink.push('options', 'C19', 2, 62, 'trailing object-literal argument', site.anchor);
      }
    }
  }
  void world;
}

function applyStructuralRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  if (facts.moduleSpecifier) {
    // See the `require` arm: an alias the sink refuses must not cost the binding
    // its basename candidate.
    const alias = MODULE_ALIASES.get(facts.moduleSpecifier);
    const reason = `imported from ${JSON.stringify(facts.moduleSpecifier)}`;
    const placed = alias !== undefined && sink.push(alias, 'A20', 0, 98, reason);
    if (!placed) {
      sink.push(toCamel(basenameNoExt(lastPathSegment(facts.moduleSpecifier))), 'A19', 0, 96, reason);
    }
  }

  // A class keeps a key's capital: `Vessel: _0x1a2b` names `class Vessel`,
  // and `new vessel(...)` reads as a call on a value to anyone used to the
  // convention.
  const spell = facts.declKind === 'class' || t.isClassExpression(facts.shapes[0]) ? toPascal : toCamel;
  if (facts.patternKey) {
    sink.push(spell(facts.patternKey), 'D02', 0, 96, `destructured from .${facts.patternKey}`);
  }

  for (const store of facts.storedInto) {
    if (store.isThis) {
      sink.push(spell(store.key), 'D03', 1, 84, `stored as this.${store.key}`, store.anchor);
    } else if (store.object === null) {
      sink.push(spell(store.key), 'D05', 2, 70, `object literal key ${store.key}`, store.anchor);
    } else {
      sink.push(spell(store.key), 'D04', 2, 72, `stored as ${store.object}.${store.key}`, store.anchor);
    }
  }

  if (facts.declKind === 'catch') {
    const nested = facts.binding.path.parentPath?.findParent((p) => p.isCatchClause()) != null;
    sink.push(nested ? 'innerError' : 'error', 'F08', 0, 96, 'catch clause parameter');
  }

  if (facts.comparedStrings.length >= 2) {
    sink.push('mode', 'G05', 2, 68, `compared against ${facts.comparedStrings.length} string literals`);
  }

  if (facts.switchLabels.length >= 2) {
    sink.push('action', 'F10', 2, 66, `switch discriminant over ${facts.switchLabels.length} cases`);
  }

  const context = facts.callbackContext;
  if (context && facts.declKind === 'param') {
    applyCallbackParamRules(sink, facts, context, world);
  }
}

function applyCallbackParamRules(
  sink: CandidateSink,
  facts: BindingFacts,
  context: CallbackContext,
  world: NamingWorld,
): void {
  const { method } = context;
  const index = facts.paramIndex;
  const container = context.containerName;

  if (ITERATOR_METHODS.has(method)) {
    if (index === 0) {
      sink.push(
        container ? singular(container) : 'item',
        'C12',
        1,
        86,
        `parameter 0 of .${method}()`,
        facts.anchor,
        container ? 0.8 : 1,
      );
    } else if (index === 1) sink.push('index', 'C13', 0, 92, `parameter 1 of .${method}()`);
    else if (index === 2) sink.push('array', 'C14', 1, 80, `parameter 2 of .${method}()`);
    return;
  }

  if (method === 'reduce') {
    if (index === 0) sink.push('acc', 'C15', 0, 92, 'reduce accumulator');
    else if (index === 1) {
      sink.push(container ? singular(container) : 'item', 'C16', 1, 84, 'reduce element', facts.anchor, container ? 0.8 : 1);
    } else if (index === 2) sink.push('index', 'C13', 1, 80, 'reduce index');
    return;
  }

  if (method === 'sort') {
    if (index === 0) sink.push('a', 'C17', 0, 90, 'sort comparator left');
    else if (index === 1) sink.push('b', 'C17', 0, 90, 'sort comparator right');
    return;
  }

  if (method === 'then' && index === 0) {
    sink.push('result', 'C10', 1, 80, 'then() callback parameter');
    return;
  }

  if (method === 'catch' && index === 0) {
    sink.push('error', 'C11', 0, 94, 'catch() callback parameter');
    return;
  }

  if ((method === 'addEventListener' || method === 'on') && index === 0 && context.eventType) {
    sink.push('event', 'C01', 1, 84, `${context.eventType} listener parameter`);
  }
  void world;
}

function applyFunctionRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  const fn = facts.functionPath;
  if (!fn) return;
  const params = fn.node.params;

  const opName = binaryOperatorFunction(fn);
  if (opName) {
    sink.push(opName, 'E07', 0, 94, 'body is a single binary operation', anchorOf(fn.node), 1, 'fn');
    return;
  }

  const returnShape = soleReturnShape(fn);
  if (returnShape) {
    if (t.isNewExpression(returnShape) && t.isIdentifier(returnShape.callee)) {
      sink.push(
        toCamel(`create ${returnShape.callee.name}`),
        'E04',
        1,
        80,
        `returns new ${returnShape.callee.name}()`,
        anchorOf(returnShape),
        1,
        'fn',
      );
      return;
    }
    if (isBooleanShaped(returnShape)) {
      const subject = booleanSubject(returnShape);
      sink.push(
        subject ? toCamel(`is ${subject}`) : 'isValid',
        subject ? 'E02' : 'E01',
        1,
        subject ? 84 : 82,
        'returns a boolean expression',
        anchorOf(returnShape),
        1,
        'fn',
      );
      return;
    }
    if (t.isArrayExpression(returnShape)) {
      sink.push('getItems', 'E03', 2, 70, 'returns an array', anchorOf(returnShape), 1, 'fn');
      return;
    }
    if (t.isBinaryExpression(returnShape) && returnShape.operator === '+' && params.length > 0) {
      sink.push('toText', 'E13', 2, 60, 'returns a concatenation', anchorOf(returnShape), 1, 'fn');
    }
  }

  const listenerType = onlyUsedAsListener(facts);
  if (listenerType) {
    sink.push(
      toCamel(`on ${listenerType}`),
      'E11',
      1,
      88,
      `only registered as a ${listenerType} listener`,
      facts.anchor,
      1,
      'fn',
    );
  }

  if (isConsoleOnly(fn)) {
    sink.push('log', 'E06', 2, 68, 'body only calls console', anchorOf(fn.node), 1, 'fn');
  }
  void world;
}

/**
 * `left` or `right`, for a parameter of a function whose whole body is one
 * binary operation over both parameters.
 *
 * Read off the expression, not off the parameter index: `binaryOperatorFunction`
 * accepts `(a, b) => b - a` as readily as `(a, b) => a - b`, and in the first
 * the parameter at index 0 is the right operand.
 */
function operandPosition(facts: BindingFacts): 'left' | 'right' | undefined {
  const fn = facts.ownerFunction;
  if (!fn || facts.paramIndex < 0 || !binaryOperatorFunction(fn)) return undefined;
  const returned = soleReturnShape(fn);
  if (!t.isBinaryExpression(returned) && !t.isLogicalExpression(returned)) return undefined;
  const own = fn.node.params[facts.paramIndex];
  if (!t.isIdentifier(own)) return undefined;
  if (t.isIdentifier(returned.left, { name: own.name })) return 'left';
  if (t.isIdentifier(returned.right, { name: own.name })) return 'right';
  return undefined;
}

function binaryOperatorFunction(fn: NodePath<t.Function>): string | undefined {
  if (fn.node.params.length !== 2) return undefined;
  const [first, second] = fn.node.params;
  if (!t.isIdentifier(first) || !t.isIdentifier(second)) return undefined;
  const returned = soleReturnShape(fn);
  if (!returned) return undefined;
  if (!t.isBinaryExpression(returned) && !t.isLogicalExpression(returned)) return undefined;
  const { left, right, operator } = returned;
  const matches =
    (t.isIdentifier(left, { name: first.name }) && t.isIdentifier(right, { name: second.name })) ||
    (t.isIdentifier(left, { name: second.name }) && t.isIdentifier(right, { name: first.name }));
  if (!matches) return undefined;
  return OP_NAMES.get(operator);
}

/**
 * The one expression a function hands back, when that is all it does.
 *
 * A block nested inside the body counts as the body: control-flow flattening
 * leaves `function (a, b) { { return a ^ b; } }`, and `finalize.tidy` unwraps
 * that redundant block only *after* this layer has run, so every rule that
 * reads a function's shape - E01 to E07, P04 - saw two levels of braces and
 * declined on the file shape they exist for. Nothing here rewrites, so looking
 * through the block is free: a block holding one `return` declares nothing
 * that the lexical scoping of `let` or `class` could hide.
 */
function soleReturnShape(fn: NodePath<t.Function>): t.Expression | null {
  let body: t.Node = fn.node.body;
  if (!t.isBlockStatement(body)) return body as t.Expression;
  for (let depth = 0; depth < BLOCK_DEPTH; depth++) {
    if (!t.isBlockStatement(body) || body.directives.length > 0 || body.body.length !== 1) return null;
    const only: t.Statement = body.body[0]!;
    if (t.isReturnStatement(only)) return only.argument ?? null;
    if (!t.isBlockStatement(only)) return null;
    body = only;
  }
  return null;
}

/** How many redundant blocks deep a body is still read as one expression. */
const BLOCK_DEPTH = 4;

function isBooleanShaped(node: t.Expression): boolean {
  if (t.isBooleanLiteral(node)) return true;
  if (t.isUnaryExpression(node) && node.operator === '!') return true;
  if (t.isBinaryExpression(node)) {
    return ['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(node.operator);
  }
  return false;
}

function booleanSubject(node: t.Expression): string | undefined {
  if (t.isBinaryExpression(node)) {
    for (const side of [node.left, node.right]) {
      if (t.isMemberExpression(side) && !side.computed && t.isIdentifier(side.property)) {
        return side.property.name;
      }
    }
  }
  if (t.isUnaryExpression(node) && node.operator === '!') return booleanSubject(node.argument);
  return undefined;
}

function onlyUsedAsListener(facts: BindingFacts): string | undefined {
  if (facts.callSites.length === 0) return undefined;
  if (facts.callSites.length !== facts.binding.references) return undefined;
  let type: string | undefined;
  for (const site of facts.callSites) {
    if (site.method !== 'addEventListener' || site.argIndex !== 1) return undefined;
    if (site.firstStringArg === undefined) return undefined;
    if (type !== undefined && type !== site.firstStringArg) return undefined;
    type = site.firstStringArg;
  }
  return type;
}

function isConsoleOnly(fn: NodePath<t.Function>): boolean {
  const body = fn.node.body;
  if (!t.isBlockStatement(body) || body.body.length === 0) return false;
  return body.body.every((statement) => {
    if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) return false;
    const callee = statement.expression.callee;
    return t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'console' });
  });
}

const LOOP_COUNTER_NAMES = ['i', 'j', 'k'];

/** The name the first indexed container will carry, once it has one this run will keep; see `indexedInto`. */
function containerName(facts: BindingFacts, world: NamingWorld): string | undefined {
  const first = facts.indexedInto[0];
  return first ? world.displayName(first.scope, first.name) : undefined;
}

function applyLoopRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  if (facts.isLoopCounter) {
    const depth = Math.max(0, facts.loopDepth - 1);
    const name = LOOP_COUNTER_NAMES[depth] ?? `i${depth + 1}`;
    sink.push(name, 'F01', 0, 94, `loop counter at depth ${depth + 1}`, facts.anchor, 1, 'index');
    const container = containerName(facts, world);
    if (container && depth > 0) {
      sink.push(
        toCamel(`${singular(container)} index`),
        'F02',
        1,
        80,
        `indexes ${container}`,
        facts.anchor,
        0.8,
        'index',
      );
    }
    return;
  }

  if (facts.forOfContainer) {
    const container = t.isIdentifier(facts.forOfContainer)
      ? world.displayName(facts.binding.scope, facts.forOfContainer.name)
      : undefined;
    sink.push(
      container ? singular(container) : 'item',
      'F03',
      1,
      88,
      'for-of element',
      facts.anchor,
      container ? 0.8 : 1,
    );
    return;
  }

  if (facts.forInObject) {
    sink.push('key', 'F04', 1, 86, 'for-in key');
    return;
  }

  if (facts.accumulates) {
    const shape = facts.shapes[0];
    const name = t.isStringLiteral(shape)
      ? 'result'
      : t.isArrayExpression(shape)
        ? 'all'
        : 'total';
    sink.push(name, 'F06', 1, 78, 'accumulated inside a loop');
    return;
  }

  if (facts.assignedInLoopWithBreak) {
    sink.push('found', 'F07', 2, 70, 'assigned in a loop that then breaks');
  }
}

/**
 * What the body does with a value, where no call site and no initialiser says
 * what it is.
 *
 * This is the evidence a decoded obfuscator.io file has most of: the strings
 * are back and the program's own shape is visible, but the values flowing
 * through it were named by the generator. Each arm is a use only one kind of
 * value supports.
 */
function applyUsageRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  // Walked element by element. `items` rather than `list`, so that F03 names an
  // element of it `item` instead of colliding with the container's own name.
  if (facts.iterated && !facts.isLoopCounter) {
    sink.push('items', 'F11', 2, 70, 'iterated over');
  }

  // Used as a position into something, and handled like one. The arithmetic is
  // what separates an index from a dictionary key: `map[token]` reads a key,
  // `rows[cursor - 1]` moves along a list. A loop counter is F01's, which has a
  // better name for the same evidence.
  if (facts.usedAsIndex && !facts.isLoopCounter && isCountedWith(facts)) {
    const container = containerName(facts, world);
    sink.push(
      container ? toCamel(`${singular(container)} index`) : 'index',
      'F12',
      2,
      70,
      container ? `indexes ${container}` : 'used as an index',
      facts.anchor,
      container ? 0.8 : 1,
      'index',
    );
  }

  // Stepped, and not a loop's own counter (F01 knows that one) nor an
  // accumulator (F06's `total`). A15 says this of a binding seeded with zero;
  // the step is the same evidence without the seed, which is the shape a
  // closure counter has: `var n = start; return { inc: () => ++n }`.
  if (facts.stepped && !facts.isLoopCounter && !facts.accumulates) {
    sink.push('count', 'A15', 2, 62, 'stepped with ++ or --');
  }

  // Joined to a string literal, and never counted with. `'total: ' + n` is the
  // counter-example the second half exists for: a value the program adds to and
  // compares is a number however it is printed.
  if (facts.concatenatedWithText && !isCountedWith(facts) && !facts.incremented) {
    sink.push('text', 'A23', 2, 66, 'joined to a string literal');
  }
  void world;
}

/** Whether the program does arithmetic or ordering with the value: it is a number. */
function isCountedWith(facts: BindingFacts): boolean {
  for (const operator of ['-', '*', '/', '%', '<', '>', '<=', '>=', '**']) {
    if (facts.ops.has(operator)) return true;
  }
  return facts.incremented;
}

function applyLiteralRules(sink: CandidateSink, facts: BindingFacts): void {
  if (facts.ops.has('!') && facts.shapes.some((shape) => t.isBooleanLiteral(shape))) {
    // `flag`, the same name the other A16 arm gives the weaker version of this
    // evidence. `!x` over a boolean proves the binding holds a boolean; it does
    // not say what the boolean turns on, and `isEnabled` asserted exactly that.
    sink.push('flag', 'A16', 2, 52, 'boolean tested with !');
  }
  if (facts.indexedRead && facts.members.has('length')) {
    sink.push('list', 'B11', 2, 58, 'length plus numeric indexing');
  }
}

function applyFrameworkRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  if (facts.returnsJsx || facts.jsx) {
    const base = facts.functionPath ? 'Component' : toPascal(facts.name);
    const named = facts.storedInto[0]?.key ?? facts.patternKey;
    sink.push(
      named ? toPascal(named) : base,
      'H01',
      0,
      99,
      'used as a JSX element name',
      facts.anchor,
      1,
      'component',
    );
    return;
  }

  if (facts.callsHooks && facts.functionPath) {
    const suffix = facts.storedInto[0]?.key ?? 'State';
    sink.push(toCamel(`use ${suffix}`), 'H02', 0, 98, 'calls hooks at the top level', facts.anchor, 1, 'hook');
    return;
  }

  const hookInit = facts.shapes.find(
    (shape) => t.isCallExpression(shape) && t.isIdentifier(shape.callee) && /^use[A-Z]/.test(shape.callee.name),
  );
  if (hookInit && t.isCallExpression(hookInit) && t.isIdentifier(hookInit.callee)) {
    const hook = hookInit.callee.name;
    if (hook === 'useRef') {
      sink.push('ref', 'H04', 1, 84, 'useRef()', anchorOf(hookInit));
    } else if (hook === 'useContext') {
      const argument = hookInit.arguments[0];
      const contextName = t.isIdentifier(argument) ? argument.name.replace(/Context$/, '') : '';
      sink.push(contextName ? toCamel(contextName) : 'context', 'H06', 1, 86, 'useContext()', anchorOf(hookInit));
    } else if (hook === 'useMemo' || hook === 'useCallback') {
      sink.push(hook === 'useMemo' ? 'memo' : 'callback', 'H07', 2, 60, `${hook}()`, anchorOf(hookInit));
    }
  }

  if (facts.typeAnnotation) applyTypeAnnotationRule(sink, facts.typeAnnotation, facts.anchor);
  void world;
}

function applyTypeAnnotationRule(sink: CandidateSink, annotation: t.TSType, anchor: number): void {
  if (t.isTSArrayType(annotation)) {
    const element = annotation.elementType;
    if (t.isTSTypeReference(element) && t.isIdentifier(element.typeName)) {
      sink.push(plural(lowerFirst(toCamel(element.typeName.name))), 'H16', 1, 86, 'array type annotation', anchor);
    }
    return;
  }
  if (t.isTSTypeReference(annotation) && t.isIdentifier(annotation.typeName)) {
    const type = annotation.typeName.name;
    if (type === 'HTMLElement' || type.startsWith('HTML')) {
      sink.push(toCamel(`${type.replace(/^HTML|Element$/g, '') || 'html'} el`), 'H16', 1, 84, 'DOM type annotation', anchor);
      return;
    }
    sink.push(lowerFirst(toCamel(type)), 'H16', 1, 86, `annotated as ${type}`, anchor);
  }
}

function applyObfuscatorRules(sink: CandidateSink, facts: BindingFacts, world: NamingWorld): void {
  const fn = facts.functionPath;

  if (fn && functionReturnsStringArray(fn.node)) {
    sink.push('getStringArray', 'I01', 0, 97, 'returns a large string-literal array', facts.anchor, 1, 'fn');
  }

  if (facts.declKind === 'param' && facts.usedAsCallee > 0) {
    const argument = boundArgument(facts);
    if (argument && t.isIdentifier(argument) && isStringArrayIdentifier(argument, facts, world)) {
      sink.push('getStringArray', 'I02', 0, 95, 'parameter bound to the string-array function', facts.anchor);
    }
  }

  if (facts.declKind === 'param' && facts.comparedStrings.length === 0) {
    const argument = boundArgument(facts);
    if (argument && t.isNumericLiteral(argument) && facts.ops.has('===')) {
      sink.push('expectedChecksum', 'I03', 0, 93, 'numeric parameter compared for equality', facts.anchor);
    }
  }

  if (facts.shapes.some(isChecksumExpression)) {
    sink.push('checksum', 'I04', 0, 93, 'sum of parseInt() terms', facts.anchor);
  }

  if (
    fn &&
    fn.node.params.length === 2 &&
    world.stringArrayIdentifiers.size > 0 &&
    usesStringArray(fn, world)
  ) {
    sink.push('decodeString', 'I05', 0, 96, 'two-parameter string-array decoder', facts.anchor, 1, 'fn');
  }

  if (
    fn &&
    (world.hasDebugger || world.strings.has('return this')) &&
    containsDebuggerTrap(fn, world)
  ) {
    sink.push('antiDebug', 'I10', 1, 84, 'contains a debugger or self-defence trap', facts.anchor, 1, 'fn');
  }

  const shape = facts.shapes[0];
  if (
    shape &&
    t.isObjectExpression(shape) &&
    shape.properties.length >= 1 &&
    shape.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        (t.isFunctionExpression(property.value) || t.isArrowFunctionExpression(property.value)),
    )
  ) {
    sink.push(
      'helpers',
      'I09',
      1,
      shape.properties.length >= 2 ? 80 : 68,
      'object of helper functions',
      anchorOf(shape),
    );
  }
}

function boundArgument(facts: BindingFacts): t.Node | undefined {
  const owner = facts.ownerFunction;
  const call = owner?.parentPath;
  if (!call?.isCallExpression()) return undefined;
  return call.node.arguments[facts.paramIndex];
}

function isStringArrayIdentifier(
  node: t.Identifier,
  facts: BindingFacts,
  world: NamingWorld,
): boolean {
  const binding = facts.binding.scope.getBinding(node.name);
  return binding !== undefined && world.stringArrayIdentifiers.has(binding.identifier);
}

/** I01: the obfuscator's string-array getter, whether it returns or caches the array. */
export function functionReturnsStringArray(fn: t.Function): boolean {
  const body = fn.body;
  if (!t.isBlockStatement(body)) return false;
  let found = false;
  for (const statement of body.body) {
    const array = t.isReturnStatement(statement)
      ? statement.argument
      : t.isVariableDeclaration(statement)
        ? (statement.declarations[0]?.init ?? null)
        : t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression)
          ? statement.expression.right
          : null;
    if (t.isArrayExpression(array) && array.elements.length >= 8) {
      if (array.elements.every((element) => t.isStringLiteral(element))) found = true;
    }
  }
  return found;
}

/**
 * A decoder does not merely mention the string array, it *indexes it by its own
 * first parameter*. Without that clause every function in a lightly-obfuscated
 * bundle matches, since they all read `_0xdb56[<literal>]`.
 */
function probeCache(
  world: NamingWorld,
  node: t.Node,
): { stringArray?: boolean; debuggerTrap?: boolean } {
  let entry = world.functionProbes.get(node);
  if (!entry) {
    entry = {};
    world.functionProbes.set(node, entry);
  }
  return entry;
}

function usesStringArray(fn: NodePath<t.Function>, world: NamingWorld): boolean {
  const cache = probeCache(world, fn.node);
  if (cache.stringArray !== undefined) return cache.stringArray;

  const [first] = fn.node.params;
  if (!t.isIdentifier(first)) return (cache.stringArray = false);
  const indexName = first.name;
  let uses = false;
  fn.traverse({
    MemberExpression(path) {
      if (!path.node.computed) return;
      if (!t.isIdentifier(path.node.object)) return;
      if (!mentionsIdentifier(path.node.property, indexName)) return;
      const binding = path.scope.getBinding(path.node.object.name);
      if (binding && world.stringArrayIdentifiers.has(binding.identifier)) {
        uses = true;
        path.stop();
      }
    },
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee)) return;
      const binding = path.scope.getBinding(path.node.callee.name);
      if (binding && world.stringArrayIdentifiers.has(binding.identifier)) {
        uses = true;
        path.stop();
      }
    },
  });
  return (cache.stringArray = uses);
}

function mentionsIdentifier(node: t.Node | null | undefined, name: string): boolean {
  if (!node) return false;
  if (t.isIdentifier(node)) return node.name === name;
  if (t.isBinaryExpression(node)) {
    return mentionsIdentifier(node.left, name) || mentionsIdentifier(node.right, name);
  }
  if (t.isUnaryExpression(node)) return mentionsIdentifier(node.argument, name);
  if (t.isCallExpression(node)) {
    return node.arguments.some((argument) => mentionsIdentifier(argument, name));
  }
  return false;
}

function isChecksumExpression(shape: t.Expression): boolean {
  let parseIntCalls = 0;
  const visit = (node: t.Node | null | undefined): void => {
    if (!node) return;
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'parseInt' })) parseIntCalls++;
    if (t.isBinaryExpression(node)) {
      visit(node.left);
      visit(node.right);
    }
    if (t.isUnaryExpression(node)) visit(node.argument);
  };
  visit(shape);
  return parseIntCalls >= 2;
}

function containsDebuggerTrap(fn: NodePath<t.Function>, world: NamingWorld): boolean {
  const cache = probeCache(world, fn.node);
  if (cache.debuggerTrap !== undefined) return cache.debuggerTrap;

  let found = false;
  fn.traverse({
    DebuggerStatement(path) {
      found = true;
      path.stop();
    },
    StringLiteral(path) {
      if (path.node.value !== 'return this' && path.node.value !== 'debugger') return;
      found = true;
      path.stop();
    },
  });
  return (cache.debuggerTrap = found);
}

