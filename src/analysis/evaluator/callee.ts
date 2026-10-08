import * as t from '@babel/types';
import { staticString, stripTypeWrappers } from '../../util/ast.js';

/**
 * The syntactic half of the host-write index's two readers, shared with
 * the native recognisers: what a call invokes once the routes that only
 * rearrange it are seen through (`invocation`), the name it goes under
 * before scope is asked (`calleeSpellings`), and the key a member reads
 * where it is a literal (`propertyKey`, `literalKey`). Everything that
 * needs a scope - what a name is bound to, what a computed key holds - is
 * `index.ts`'s `originOf` and `KeyReader`, built on these.
 */

/** A key the tree cannot read at all; inside a spelling, the part of a key it cannot. */
export const UNREAD_KEY = '*';

/** How far a key, an alias or a literal chain is followed before the answer is unknown. */
export const MAX_KEY_HOPS = 4;

/** Whether a key spelling holds no `*`, so it names exactly one property. */
export function isRead(key: string): boolean {
  return !key.includes(UNREAD_KEY);
}

/** A member expression in either spelling, `o.f` and `o?.f`. */
export function isMember(node: t.Node): node is t.MemberExpression | t.OptionalMemberExpression {
  return node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression';
}

/** The key a member reads, or `*` when it is computed from anything but a string literal. */
export function propertyKey(member: t.MemberExpression | t.OptionalMemberExpression): string {
  const { property, computed } = member;
  if (!computed && property.type === 'Identifier') return property.name;
  const literal = computed ? staticString(property) : undefined;
  return literal ?? UNREAD_KEY;
}

/** `propertyKey`, reading a numeric literal too: `[String][0]` is the element `0` of the literal. */
export function literalKey(member: t.MemberExpression | t.OptionalMemberExpression): string {
  const { property, computed } = member;
  if (computed && property.type === 'NumericLiteral') return String(property.value);
  return propertyKey(member);
}

/**
 * The identifier or `this` a member chain starts from, and the keys read off
 * it in order: `a.b.c` is root `a`, keys `[b, c]`; `globalThis['x'][k]` is
 * root `globalThis`, keys `[x, *]`. Nothing else - a call, a literal, a
 * parenthesised expression - is a root the index can name.
 */
export function memberSpine(member: t.MemberExpression | t.OptionalMemberExpression): { root: string; keys: string[] } | undefined {
  const keys: string[] = [];
  let current: t.Node = member;
  for (;;) {
    current = stripTypeWrappers(current);
    if (!t.isMemberExpression(current) && !t.isOptionalMemberExpression(current)) break;
    keys.unshift(propertyKey(current));
    current = current.object;
  }
  const root = t.isIdentifier(current) ? current.name : t.isThisExpression(current) ? 'this' : undefined;
  return root === undefined ? undefined : { root, keys };
}

/** The dotted spelling of a name or a member chain of readable keys, `o`, `o.a.b`, for the walk's names; `undefined` for any other chain. */
export function memberSpelling(node: t.Node): string | undefined {
  const target = stripTypeWrappers(node);
  if (target.type === 'Identifier') return target.name;
  if (target.type === 'ThisExpression') return 'this';
  if (!isMember(target)) return undefined;
  const spine = memberSpine(target);
  return spine && spine.keys.every(isRead) ? `${spine.root}.${spine.keys.join('.')}` : undefined;
}

/**
 * The value an object literal gives `key`, the last spelling winning as it
 * does at run time; unknown when a spread or a computed key it cannot read
 * could be the one; `undefined` when no property spells it.
 */
export function literalProperty(object: t.ObjectExpression, key: string): t.Node | 'unknown' | undefined {
  let value: t.Node | undefined;
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) return 'unknown';
    const spelled =
      !property.computed && t.isIdentifier(property.key)
        ? property.key.name
        : t.isNumericLiteral(property.key)
          ? String(property.key.value)
          : staticString(property.key);
    if (spelled === undefined) {
      if (property.computed) return 'unknown';
      continue;
    }
    if (spelled !== key) continue;
    value = t.isObjectProperty(property) ? property.value : property;
  }
  return value;
}

/** The element an array literal gives a canonical index, with no hole or spread before it; a spread of an array literal is its elements in place. */
export function literalElement(array: t.ArrayExpression, key: string): t.Node | 'unknown' | undefined {
  const index = Number(key);
  if (!Number.isInteger(index) || index < 0 || String(index) !== key) return undefined;
  const elements = flatElements(array, index, 0);
  if (elements === 'unknown') return 'unknown';
  for (let i = 0; i <= index && i < elements.length; i++) if (!elements[i]) return 'unknown';
  return elements[index] ?? undefined;
}

/** An array literal's elements up to `index`, every spread of an array literal opened in place; `unknown` for a hole or a spread of anything else before that. */
function flatElements(array: t.ArrayExpression, index: number, depth: number): (t.Node | null)[] | 'unknown' {
  const elements: (t.Node | null)[] = [];
  for (const element of array.elements) {
    if (elements.length > index) break;
    if (!element || !t.isSpreadElement(element)) {
      elements.push(element);
      continue;
    }
    const spread = stripTypeWrappers(element.argument);
    if (!t.isArrayExpression(spread) || depth > MAX_KEY_HOPS) return 'unknown';
    const inner = flatElements(spread, index - elements.length, depth + 1);
    if (inner === 'unknown') return 'unknown';
    elements.push(...inner);
  }
  return elements;
}

/** The name a member of an object literal or a class body is declared under; `undefined` for a key the tree cannot read. */
export function methodKey(member: t.Node): string | undefined {
  if (member.type !== 'ObjectProperty' && member.type !== 'ObjectMethod' && member.type !== 'ClassMethod' && member.type !== 'ClassProperty') return undefined;
  if (!member.computed && member.key.type === 'Identifier') return member.key.name;
  return staticString(member.key);
}

/** What `invocation` reads a call as: the functions it may reach, the arguments and `this` they get, and each `.call` or `.apply` on the way that may instead be a holder's own method. */
export interface Invocation {
  fns: t.Node[];
  args: readonly t.Node[];
  thisArg: t.Node | undefined;
  own?: OwnMethod[];
}

/** A `.call` or `.apply` step read as the holder's own method: the member, and the call as spelled at it. */
export interface OwnMethod {
  fn: t.MemberExpression | t.OptionalMemberExpression;
  args: readonly t.Node[];
  thisArg: t.Node | undefined;
}

/**
 * What a call invokes, and with what: the one callee normaliser. Every
 * question about a call - what a hand-off reaches, whether a reflective
 * method is called, how a reference to a function is used, what a call
 * returns - is asked of this, so that a route handled here is handled
 * everywhere.
 *
 * The routes that only rearrange a call are seen through: `X?.(...)`,
 * `X.call(t, ...)`, `X.apply(t, [...])`, `X.bind(t, a...)(b...)` - the bound
 * arguments in front of the passed ones, as the bound function puts them -
 * `Reflect.apply(X, t, [...])`, and `Function.prototype.call` or `.apply`
 * invoked with `X` as their receiver, as `Function.prototype.call.call(X,
 * t, ...)` does - `receiver` is that `X` on the way in, and the `this` a
 * route established at the end; a sequence is its last expression, an `await` its operand,
 * and a conditional or a logical is each arm, so `fns` is a set. What is
 * left is the callee as spelled - a name, a member chain, a literal in
 * callee position - for `calleeSpelling` to name without a scope and
 * `originOf` to resolve with one; `thisArg` is what the route makes
 * `this` in it - the object of a method call, the first argument of
 * `.call`, `.apply`, `.bind` and `Reflect.apply` - or nothing for a
 * bare call. An `apply` whose list is not an array literal with every
 * element in place - `f.apply(t, a)`, `f.apply(t, arguments)` - is the
 * list spread, `f(...a)`, for a reader with a scope to open.
 *
 * `X.call(t, ...)` is `Function.prototype.call` only when `X` is a function;
 * a holder with a method of that name, `{ call: fn }`, an instance, is
 * that method called with every argument as spelled. Both readings are
 * given: `fns` is the function `X` would be, and `own` each such step on
 * the way, for a reader to record beside it or to prefer once the scope
 * says which `X` is.
 */
export function invocation(callee: t.Node, receiver: t.Node | undefined, args: readonly t.Node[], depth: number): Invocation | undefined {
  if (depth > 6) return undefined;
  let fn = stripTypeWrappers(callee);
  for (let hops = 0; hops < 8; hops++) {
    if (fn.type === 'SequenceExpression') {
      const last = fn.expressions[fn.expressions.length - 1];
      if (!last) return undefined;
      fn = stripTypeWrappers(last);
    } else if (fn.type === 'AwaitExpression') {
      fn = stripTypeWrappers(fn.argument);
    } else {
      break;
    }
  }
  if (fn.type === 'ConditionalExpression' || fn.type === 'LogicalExpression') {
    const arms = fn.type === 'ConditionalExpression' ? [fn.consequent, fn.alternate] : [fn.left, fn.right];
    const fns: t.Node[] = [];
    const own: OwnMethod[] = [];
    let thisArg: t.Node | undefined;
    for (const arm of arms) {
      const invoked = invocation(arm, receiver, args, depth + 1);
      if (!invoked) return undefined;
      fns.push(...invoked.fns);
      if (invoked.own) own.push(...invoked.own);
      thisArg ??= invoked.thisArg;
    }
    return own.length > 0 ? { fns, args, thisArg, own } : { fns, args, thisArg };
  }
  // The elements of a list; a list that is not a literal with every element
  // in place is spread, and `f.apply(t)` with no list is no arguments.
  const list = (node: t.Node | undefined): t.Node[] =>
    node === undefined
      ? []
      : node.type === 'ArrayExpression' && !node.elements.some((element) => !element || element.type === 'SpreadElement')
        ? (node.elements as t.Node[])
        : [t.spreadElement(node as t.Expression)];
  // `X.bind(t, a...)(b...)`: the bound function called at once, where it
  // stands or picked out of a literal, `[X.bind(t)][0](b...)`.
  const picked = pickedByLiteral(fn);
  if (picked && (picked.type === 'CallExpression' || picked.type === 'OptionalCallExpression')) {
    const bound = stripTypeWrappers(picked.callee);
    if (isMember(bound) && propertyKey(bound) === 'bind') {
      return invocation(bound.object, picked.arguments[0], [...picked.arguments.slice(1), ...args], depth + 1);
    }
    // `Function.prototype.bind.call(f, t, a...)` is `f.bind(t, a...)`.
    if (isMember(bound) && propertyKey(bound) === 'call') {
      const inner = stripTypeWrappers(bound.object);
      const spine = isMember(inner) ? memberSpine(inner) : undefined;
      const onBind = spine !== undefined && spine.root === 'Function' && spine.keys.length === 2 && spine.keys[0] === 'prototype' && spine.keys[1] === 'bind';
      const [target, thisArg, ...rest] = picked.arguments;
      if (onBind && target && target.type !== 'SpreadElement') return invocation(target, thisArg, [...rest, ...args], depth + 1);
    }
  }
  if (fn.type === 'CallExpression' || fn.type === 'OptionalCallExpression') return undefined;
  if (isMember(fn)) {
    const method = propertyKey(fn);
    const object = stripTypeWrappers(fn.object);
    if (object.type === 'Identifier' && object.name === 'Reflect' && method === 'apply') {
      const [target, thisArg, rest] = args;
      return target && target.type !== 'SpreadElement' ? invocation(target, thisArg, list(rest), depth + 1) : undefined;
    }
    if (method === 'call' || method === 'apply') {
      const spine = memberSpine(fn);
      const onFunctionPrototype =
        spine !== undefined && spine.root === 'Function' && spine.keys.length === 2 && spine.keys[0] === 'prototype';
      // `Function.prototype.call(t, ...)` is its receiver called; with no receiver it is a call of nothing.
      const target = onFunctionPrototype ? receiver : object;
      if (target === undefined || args[0]?.type === 'SpreadElement') return undefined;
      const invoked = invocation(target, args[0], method === 'call' ? args.slice(1) : list(args[1]), depth + 1);
      // Anything but a function literal, a class or what a call gave back
      // may be a holder with a `call` of its own.
      if (!invoked || onFunctionPrototype || !mayBeHolder(pickedByLiteral(object) ?? object)) return invoked;
      return { ...invoked, own: [...(invoked.own ?? []), { fn, args, thisArg: receiver ?? object }] };
    }
  }
  // What the route bound, or the object a method is read off: `this` in the callee.
  return { fns: [fn], args, thisArg: receiver ?? (isMember(fn) ? fn.object : undefined) };
}

/** Whether a node in the object position of `.call` or `.apply` may be no function but a holder with an own method of that name. */
function mayBeHolder(node: t.Node): boolean {
  switch (node.type) {
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassExpression':
    case 'CallExpression':
    case 'OptionalCallExpression':
      return false;
    default:
      return true;
  }
}

/**
 * The name a hand-off is recorded under before scope is asked, for one arm
 * `invocation` returned: a bare name; `holder.method` and deeper, for a
 * method of a literal, a class or a prototype the walk declared under that
 * spelling; `this.method` inside a method of a holder the walk knows, as
 * the holder's; `new U().method` as `U.prototype.method`; a literal in
 * callee position - `[f][0]`, `({ d: f }).d`, `[[f]][0][0]` - as what it
 * holds; a function expression called where it stands as itself; `o[k]`
 * as `o.f` for every string `readName` says `k` may hold. Anything else
 * is a call the tree cannot name, which is a hand-off to nothing it can
 * follow.
 */
export function calleeSpellings(
  fn: t.Node,
  thisHolder: string | undefined,
  readName?: (name: string) => ReadonlySet<string> | undefined,
  depth = 0,
): (string | t.Function)[] {
  if (depth > MAX_KEY_HOPS) return [];
  const callee = pickedByLiteral(fn);
  if (!callee) return [];
  if (callee.type === 'Identifier') return [callee.name];
  if (callee.type === 'ThisExpression') return thisHolder === undefined ? [] : [thisHolder];
  if (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression') return [callee];
  if (!isMember(callee)) return [];
  const literal = literalKey(callee);
  const keys = literal !== UNREAD_KEY ? [literal] : callee.computed && callee.property.type === 'Identifier' ? [...(readName?.(callee.property.name) ?? [])] : [];
  if (keys.length === 0) return [];
  const object = stripTypeWrappers(callee.object);
  if (object.type === 'NewExpression') {
    const constructor = stripTypeWrappers(object.callee);
    if (constructor.type === 'Identifier') return keys.map((key) => `${constructor.name}.prototype.${key}`);
    // `new (function () { this.f = ...; })().f(...)`: what the constructor put on `this`, under the spelling the walk declares it by.
    if (constructor.type === 'FunctionExpression') return keys.map((key) => `this.${key}`);
    // `new (class { f() {} })().f(...)`: the class's own instance method.
    if (constructor.type !== 'ClassExpression') return [];
    const methods: t.Function[] = [];
    for (const member of constructor.body.body) {
      if (member.type === 'ClassMethod' && !member.static && member.kind === 'method' && keys.includes(methodKey(member) ?? UNREAD_KEY)) methods.push(member);
    }
    return methods;
  }
  const spellings: (string | t.Function)[] = [];
  for (const holder of calleeSpellings(object, thisHolder, readName, depth + 1)) {
    if (typeof holder !== 'string') continue;
    for (const key of keys) spellings.push(`${holder}.${key}`);
  }
  return spellings;
}

/**
 * What a chain of reads off literals yields: `[f][0]` is `f`, `({ d: f }).d`
 * is `f`, `[[f]][0][0]` is `f`; a node that is no such chain is itself;
 * a chain that reads a hole, a spread or a key the tree cannot read yields
 * nothing.
 */
export function pickedByLiteral(node: t.Node, depth = 0): t.Node | undefined {
  const value = stripTypeWrappers(node);
  if (depth > MAX_KEY_HOPS) return value;
  // `[f].pop()`, `[f].shift()`, `[f].at(-1)`: an element of a literal by method.
  if ((value.type === 'CallExpression' || value.type === 'OptionalCallExpression') && isMember(value.callee)) {
    const method = propertyKey(value.callee);
    const list = pickedByLiteral(value.callee.object, depth + 1);
    if (list && list.type === 'ArrayExpression' && (method === 'pop' || method === 'shift' || method === 'at')) {
      const elements = list.elements;
      if (elements.some((element) => !element || element.type === 'SpreadElement')) return undefined;
      let index: number | undefined;
      if (method === 'pop' && value.arguments.length === 0) index = elements.length - 1;
      else if (method === 'shift' && value.arguments.length === 0) index = 0;
      else if (method === 'at' && value.arguments.length === 1) {
        const at = stripTypeWrappers(value.arguments[0] as t.Node);
        const n = t.isNumericLiteral(at) ? at.value : t.isUnaryExpression(at, { operator: '-' }) && t.isNumericLiteral(at.argument) ? -at.argument.value : undefined;
        if (n !== undefined && Number.isInteger(n)) index = n < 0 ? elements.length + n : n;
      }
      if (index === undefined) return undefined;
      const picked = elements[index];
      return picked ? stripTypeWrappers(picked) : undefined;
    }
    return value;
  }
  if (!isMember(value)) return value;
  const object = pickedByLiteral(value.object, depth + 1);
  if (!object || (object.type !== 'ArrayExpression' && object.type !== 'ObjectExpression')) return value;
  const key = literalKey(value);
  if (key === UNREAD_KEY) return undefined;
  const picked = object.type === 'ArrayExpression' ? literalElement(object, key) : literalProperty(object, key);
  return picked && picked !== 'unknown' ? stripTypeWrappers(picked) : undefined;
}

/** Whether the callee `invocation` returned is `needle`, or a literal in callee position holding it: `[f][0]`, `({ d: f }).d`. */
export function armHolds(arm: t.Node, needle: t.Node): boolean {
  return pickedByLiteral(arm) === needle;
}

/** Whether a literal holds `needle` among its elements or property values, however deep. */
export function literalHolds(literal: t.Node, needle: t.Node, depth = 0): boolean {
  if (depth > MAX_KEY_HOPS) return false;
  const values: (t.Node | null | undefined)[] =
    literal.type === 'ArrayExpression'
      ? literal.elements
      : literal.type === 'ObjectExpression'
        ? literal.properties.map((property) => (property.type === 'ObjectProperty' ? property.value : property.type === 'ObjectMethod' ? property : undefined))
        : [];
  for (const value of values) {
    if (!value) continue;
    const held = stripTypeWrappers(value);
    if (held === needle || literalHolds(held, needle, depth + 1)) return true;
  }
  return false;
}
