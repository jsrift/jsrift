import type { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { insideWith, isUnboundUndefined } from '../../util/ast.js';

/**
 * Turn React runtime calls back into JSX.
 *
 * The whole pass is written around one asymmetry: a *missing* conversion costs
 * the reader some noise, while a *wrong* conversion silently changes what the
 * component renders. `_jsx(foo, {})` written as `<foo />` stops referencing the
 * binding `foo` and starts asking React for an HTML element called `foo`, with
 * no error anywhere. So every step below either proves the JSX form is exactly
 * equivalent or returns `undefined` and leaves the call alone.
 */
export const restoreJsxPass: Pass = {
  id: 'finalize.jsx',
  title: 'Restore JSX from jsx-runtime calls',
  stage: 'finalize',
  technique: 'jsxRestoration',
  // JSX is not valid in a `.ts` file - `<Foo>bar</Foo>` is a type assertion
  // followed by a syntax error there - so the dialect is a hard gate, not a
  // preference. Emitting JSX into `js`/`ts` produces output that will not
  // re-parse, which is the one failure this tool must never ship.
  visitor: (ctx) =>
    isJsxCapable(ctx)
      ? {
          CallExpression: {
            // On exit, so a nested call has already become a JSXElement by the
            // time its parent reads it as a child.
            exit(path) {
              restoreElement(path, ctx);
            },
          },
        }
      : {},
  // The gate has to be audible. Every compiled React bundle is a `.js` file
  // and `_jsx('div', {...})` is plain JavaScript, so the auto ladder pins `js`
  // and the visitor above is empty on exactly the input this pass exists for;
  // the `jsx-runtime` detection fired, the change count was zero, and nothing
  // said which of the two was wrong. `finalize` runs once, so this is one note.
  run: (ctx) => {
    if (isJsxCapable(ctx)) return;
    const runtime = ctx.detections.find((d) => d.kind === 'jsx-runtime');
    if (!runtime) return;
    ctx.note(
      'warning',
      `JSX was not restored: the file's dialect is ${ctx.language}, and JSX is only emitted into ` +
        `jsx or tsx, so the React runtime calls (${runtime.evidence}) were left as calls. Pass ` +
        `language: 'jsx' or 'tsx', or a .jsx/.tsx filename, to restore them.`,
    );
  },
};

function isJsxCapable(ctx: PassContext): boolean {
  return ctx.language === 'jsx' || ctx.language === 'tsx';
}

// ---------------------------------------------------------------------------
// Runtime resolution - which calls are actually React element factories
// ---------------------------------------------------------------------------

/** `jsx`/`jsxs` take children inside props; `jsxDEV` appends debug metadata. */
const AUTOMATIC_FACTORIES = new Set(['jsx', 'jsxs', 'jsxDEV', 'jsxsDEV']);
const CLASSIC_FACTORY = 'createElement';
const FRAGMENT_EXPORT = 'Fragment';

/** `react/jsx-runtime`, `preact/jsx-dev-runtime`, `.../jsx-runtime.mjs`, ... */
const JSX_RUNTIME_MODULE = /(?:^|\/)jsx-(?:dev-)?runtime(?:\.[cm]?js)?$/;
const REACT_MODULE = /^(?:react|preact(?:\/compat)?)$/;

/** Marker for "this binding is the module object itself", not a named export. */
const NAMESPACE = '*';

/** Alias chains (`var a = b; var b = ns.jsx`) are followed, but not forever. */
const MAX_RESOLVE_DEPTH = 6;

interface ModuleRef {
  source: string;
  /** Exported name, or `NAMESPACE` for the module object. */
  exported: string;
}

type FactoryKind = 'automatic' | 'classic';

interface Factory {
  kind: FactoryKind;
  /** The runtime export name, so `jsxDEV`'s extra arguments can be recognised. */
  name: string;
}

function restoreElement(path: NodePath<t.CallExpression>, ctx: PassContext): void {
  const callee = unwrapIndirectCall(path.node.callee);
  if (!callee) return;
  const factory = resolveFactory(callee, path.scope);
  if (!factory) return;

  const element = buildElement(factory, path);
  if (!element) return;

  path.replaceWith(t.inherits(element, path.node));
  ctx.report('jsx-runtime', factory.name, 1, 1);
  ctx.markChanged();
}

/**
 * Minifiers emit `(0, ns.jsx)(...)` to call a namespace member without binding
 * `this`. The sequence is pure indirection; the real callee is the second half.
 */
function unwrapIndirectCall(callee: t.Node): t.Expression | undefined {
  if (t.isSequenceExpression(callee) && callee.expressions.length === 2) {
    const [first, second] = callee.expressions;
    if (first && second && t.isNumericLiteral(first, { value: 0 })) return second;
    return undefined;
  }
  return t.isExpression(callee) ? callee : undefined;
}

/**
 * Decide whether this callee is genuinely a React element factory.
 *
 * Name matching alone is not evidence: a project can have its own function
 * called `jsx`. The callee must trace to an import or `require` of a real
 * jsx-runtime/React module - the single exception being `React.createElement`
 * on an unbound global `React`, which is unambiguous by convention and is how
 * pre-bundler scripts are written.
 */
function resolveFactory(callee: t.Expression, scope: Scope): Factory | undefined {
  if (t.isIdentifier(callee)) {
    const ref = resolveBinding(scope, callee.name, 0);
    return ref ? factoryFor(ref) : undefined;
  }

  if (!t.isMemberExpression(callee) || callee.computed) return undefined;
  if (!t.isIdentifier(callee.property) || !t.isIdentifier(callee.object)) return undefined;

  const property = callee.property.name;
  const ref = resolveBinding(scope, callee.object.name, 0);
  if (ref) {
    if (ref.exported !== NAMESPACE) return undefined;
    return factoryFor({ source: ref.source, exported: property });
  }

  // `React.createElement` on a genuinely global `React` - the one shape that
  // needs no import to be unambiguous. A local binding called `React` that
  // could not be traced is not that shape.
  if (callee.object.name === 'React' && property === CLASSIC_FACTORY) {
    return scope.getBinding('React') ? undefined : { kind: 'classic', name: property };
  }
  return undefined;
}

function factoryFor(ref: ModuleRef): Factory | undefined {
  if (JSX_RUNTIME_MODULE.test(ref.source) && AUTOMATIC_FACTORIES.has(ref.exported)) {
    return { kind: 'automatic', name: ref.exported };
  }
  if (REACT_MODULE.test(ref.source) && ref.exported === CLASSIC_FACTORY) {
    return { kind: 'classic', name: ref.exported };
  }
  return undefined;
}

/** Which module export a local name came from, following imports and requires. */
function resolveBinding(scope: Scope, name: string, depth: number): ModuleRef | undefined {
  if (depth > MAX_RESOLVE_DEPTH) return undefined;
  const binding = scope.getBinding(name);
  if (!binding) return undefined;

  const node = binding.path.node;
  const parent = binding.path.parent;

  if (t.isImportDeclaration(parent)) {
    const source = parent.source.value;
    if (t.isImportSpecifier(node)) {
      const { imported } = node;
      return { source, exported: t.isIdentifier(imported) ? imported.name : imported.value };
    }
    // A default or namespace import is the module object for this purpose:
    // both `React.createElement` and `ns.jsx` read a member off it.
    if (t.isImportDefaultSpecifier(node) || t.isImportNamespaceSpecifier(node)) {
      return { source, exported: NAMESPACE };
    }
    return undefined;
  }

  if (!t.isVariableDeclarator(node) || !node.init) return undefined;
  const declaratorScope = binding.path.scope;

  if (t.isIdentifier(node.id)) {
    return resolveExpression(declaratorScope, node.init, depth + 1);
  }

  if (t.isObjectPattern(node.id)) {
    const namespace = resolveExpression(declaratorScope, node.init, depth + 1);
    if (!namespace || namespace.exported !== NAMESPACE) return undefined;
    for (const property of node.id.properties) {
      if (!t.isObjectProperty(property) || property.computed) continue;
      if (!t.isIdentifier(property.value, { name })) continue;
      const key = staticPropertyName(property.key);
      return key === undefined ? undefined : { source: namespace.source, exported: key };
    }
  }
  return undefined;
}

function resolveExpression(scope: Scope, node: t.Node, depth: number): ModuleRef | undefined {
  if (depth > MAX_RESOLVE_DEPTH) return undefined;

  const required = requireSource(node);
  if (required !== undefined) return { source: required, exported: NAMESPACE };

  if (t.isIdentifier(node)) return resolveBinding(scope, node.name, depth + 1);

  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    const object = resolveExpression(scope, node.object, depth + 1);
    if (object?.exported === NAMESPACE) {
      return { source: object.source, exported: node.property.name };
    }
  }
  return undefined;
}

function requireSource(node: t.Node): string | undefined {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee, { name: 'require' })) {
    return undefined;
  }
  const [argument] = node.arguments;
  return argument && t.isStringLiteral(argument) ? argument.value : undefined;
}

function isFragmentType(node: t.Expression, scope: Scope): boolean {
  if (t.isIdentifier(node)) {
    const ref = resolveBinding(scope, node.name, 0);
    return ref !== undefined && ref.exported === FRAGMENT_EXPORT && isReactModule(ref.source);
  }
  if (!t.isMemberExpression(node) || node.computed) return false;
  if (!t.isIdentifier(node.property, { name: FRAGMENT_EXPORT })) return false;
  if (!t.isIdentifier(node.object)) return false;

  const ref = resolveBinding(scope, node.object.name, 0);
  if (ref) return ref.exported === NAMESPACE && isReactModule(ref.source);
  return node.object.name === 'React' && scope.getBinding('React') === undefined;
}

function isReactModule(source: string): boolean {
  return JSX_RUNTIME_MODULE.test(source) || REACT_MODULE.test(source);
}

// ---------------------------------------------------------------------------
// Element construction
// ---------------------------------------------------------------------------

/**
 * A tag written in lowercase is a *host* element, so only a string type may
 * become one. Dots are excluded deliberately: `<a.b/>` is a member lookup on
 * the binding `a`, not an element named `"a.b"`.
 */
const INTRINSIC_TAG = /^[a-z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/;
/** Conversely, a component reference must not read as a host element. */
const COMPONENT_TAG = /^[A-Z_$][a-zA-Z0-9_$]*$/;
const PLAIN_JS_NAME = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
/** JSXIdentifier = IdentifierStart followed by identifier parts or hyphens. */
const JSX_ATTRIBUTE_NAME = /^[a-zA-Z_$][a-zA-Z0-9_$-]*$/;
const JSX_NAMESPACED_NAME = /^([a-zA-Z_$][a-zA-Z0-9_$-]*):([a-zA-Z_$][a-zA-Z0-9_$-]*)$/;

/**
 * Characters that must not appear in a quoted JSX attribute value.
 *
 * JSX attribute strings are *not* JavaScript strings: backslash escapes are
 * literal text and `&` starts an HTML entity, so a value containing either
 * would mean something different after the rewrite.
 */
const SAFE_ATTRIBUTE_TEXT = /^[^"\\&\r\n\u2028\u2029\u0000-\u001f]*$/;
/** `<`, `>`, `{` and `}` are structural in JSX text; `&` is an entity. */
const SAFE_CHILD_TEXT = /^[^<>{}&\r\n\t\u2028\u2029\u0000-\u001f]*$/;

function buildElement(
  factory: Factory,
  at: NodePath<t.CallExpression>,
): t.JSXElement | t.JSXFragment | undefined {
  const call = at.node;
  const scope = at.scope;
  const parts = readArguments(factory, at);
  if (!parts) return undefined;

  const props = readProps(parts.props);
  if (!props) return undefined;

  if (parts.explicitChildren && props.children !== undefined) {
    // `createElement(type, {children}, extra)` - React lets the trailing
    // arguments win, but keeping only one of the two is not a rewrite the
    // source alone justifies.
    return undefined;
  }

  let rawChildren: t.Expression[] = [];
  if (parts.explicitChildren) {
    rawChildren = parts.explicitChildren;
  } else if (props.children !== undefined) {
    const listed = childList(props.children);
    if (!listed) return undefined;
    rawChildren = listed;
  }

  const children = buildChildren(rawChildren);
  if (children === undefined) return undefined;

  const attributes = props.attributes;
  if (parts.key) {
    // The automatic runtime hoists `key` out of props into its own argument;
    // putting it back at the front is where an author would have written it.
    attributes.unshift(t.jsxAttribute(t.jsxIdentifier('key'), attributeValue(parts.key)));
  }

  // A fragment can only be written `<>...</>` when it carries nothing else; with
  // a key it stays a named tag, which is still valid JSX.
  if (attributes.length === 0 && isFragmentType(parts.type, scope)) {
    return t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), children);
  }

  const name = buildTagName(parts.type);
  if (!name) return undefined;

  const selfClosing = children.length === 0;
  return t.jsxElement(
    t.jsxOpeningElement(name, attributes, selfClosing),
    selfClosing ? null : t.jsxClosingElement(t.cloneNode(name, true)),
    children,
    selfClosing,
  );
}

interface CallParts {
  type: t.Expression;
  props: t.ObjectExpression | undefined;
  key: t.Expression | undefined;
  /** Classic-runtime variadic children, when the call supplied any. */
  explicitChildren: t.Expression[] | undefined;
}

function readArguments(
  factory: Factory,
  at: NodePath<t.CallExpression>,
): CallParts | undefined {
  const call = at.node;
  const args = call.arguments;
  const type = args[0];
  if (!type || !t.isExpression(type)) return undefined;

  const propsArgument = args[1];
  let props: t.ObjectExpression | undefined;
  if (propsArgument === undefined) {
    // The automatic runtime always passes props; a one-argument call is some
    // other function entirely.
    if (factory.kind === 'automatic') return undefined;
  } else if (t.isObjectExpression(propsArgument)) {
    props = propsArgument;
  } else if (t.isExpression(propsArgument) && isNullish(propsArgument, at)) {
    props = undefined;
  } else {
    // `_jsx(C, someProps)` has no JSX spelling: `<C {...someProps}/>` is a
    // different call (it would rebuild the object).
    return undefined;
  }

  if (factory.kind === 'classic') {
    const explicit: t.Expression[] = [];
    for (let index = 2; index < args.length; index++) {
      const argument = args[index];
      if (!argument || !t.isExpression(argument)) return undefined;
      explicit.push(argument);
    }
    return {
      type,
      props,
      key: undefined,
      explicitChildren: explicit.length > 0 ? explicit : undefined,
    };
  }

  // `jsxDEV(type, props, key, isStaticChildren, source, self)`. Everything past
  // the key is instrumentation the compiler synthesised, never source the
  // author wrote, so dropping it recovers the original JSX rather than losing
  // information.
  const maxArguments = factory.name.endsWith('DEV') ? 6 : 3;
  if (args.length > maxArguments) return undefined;

  const keyArgument = args[2];
  let key: t.Expression | undefined;
  if (keyArgument !== undefined) {
    if (!t.isExpression(keyArgument)) return undefined;
    if (!isNullish(keyArgument, at)) key = keyArgument;
  }
  return { type, props, key, explicitChildren: undefined };
}

interface ReadProps {
  attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
  children: t.Expression | undefined;
}

function readProps(props: t.ObjectExpression | undefined): ReadProps | undefined {
  const attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute> = [];
  let children: t.Expression | undefined;
  if (!props) return { attributes, children };

  for (const property of props.properties) {
    if (t.isSpreadElement(property)) {
      // In JSX the children always come last, so a spread after `children:`
      // would be reordered - and a spread can carry its own `children`.
      if (children !== undefined) return undefined;
      attributes.push(t.inherits(t.jsxSpreadAttribute(property.argument), property));
      continue;
    }
    // An accessor or shorthand method has no attribute spelling at all.
    if (!t.isObjectProperty(property) || property.computed) return undefined;

    const name = staticPropertyName(property.key);
    if (name === undefined) return undefined;
    const value = property.value;
    if (!t.isExpression(value)) return undefined;

    if (name === 'children') {
      if (children !== undefined) return undefined;
      children = value;
      continue;
    }

    const attributeName = buildAttributeName(name);
    if (!attributeName) return undefined;
    attributes.push(t.inherits(t.jsxAttribute(attributeName, attributeValue(value)), property));
  }
  return { attributes, children };
}

function buildAttributeName(name: string): t.JSXIdentifier | t.JSXNamespacedName | undefined {
  if (JSX_ATTRIBUTE_NAME.test(name)) return t.jsxIdentifier(name);
  const namespaced = JSX_NAMESPACED_NAME.exec(name);
  if (!namespaced) return undefined;
  const [, namespace, local] = namespaced;
  if (!namespace || !local) return undefined;
  return t.jsxNamespacedName(t.jsxIdentifier(namespace), t.jsxIdentifier(local));
}

function attributeValue(value: t.Expression): t.JSXAttribute['value'] {
  // `<div hidden />` is exactly `hidden: true`; `false` has no shorthand.
  if (t.isBooleanLiteral(value, { value: true })) return null;
  if (t.isStringLiteral(value) && SAFE_ATTRIBUTE_TEXT.test(value.value)) {
    return jsxAttributeString(value);
  }
  return t.jsxExpressionContainer(value);
}

/**
 * Re-quote a string for JSX attribute position.
 *
 * The original `raw` cannot be reused: `"a\nb"` is a newline in JavaScript and
 * a literal backslash in JSX. The value has already been checked to contain no
 * quote or backslash, so wrapping it verbatim in double quotes is exact - and
 * pinning `raw` stops the generator's `quotes: 'single'` setting from
 * re-escaping an apostrophe into something JSX reads as two characters.
 */
function jsxAttributeString(from: t.StringLiteral): t.StringLiteral {
  const literal = t.stringLiteral(from.value);
  literal.extra = { raw: `"${from.value}"`, rawValue: from.value };
  return t.inherits(literal, from);
}

/**
 * Split the `children` prop into one entry per JSX child.
 *
 * The array form only ever comes from *multiple* children - a lone child is
 * passed through unwrapped - so `children: []` and `children: [x]` are literal
 * array values the author wrote, not child lists. Treating them as lists would
 * turn `<div>{[]}</div>` into `<div />`.
 */
function childList(children: t.Expression): t.Expression[] | undefined {
  if (!t.isArrayExpression(children) || children.elements.length < 2) return [children];

  const values: t.Expression[] = [];
  for (const element of children.elements) {
    // A hole (`[a, , b]`) or a spread has no children spelling in JSX.
    if (!element || !t.isExpression(element)) return undefined;
    values.push(element);
  }
  return values;
}

function buildChildren(values: readonly t.Expression[]): t.JSXElement['children'] | undefined {
  // Two adjacent text children would be printed as one run and re-parse as a
  // single child, changing the children array React sees. Whenever a plain
  // string neighbours another, both stay inside expression containers.
  const textual = values.map(
    (value) => t.isStringLiteral(value) && value.value.length > 0 && SAFE_CHILD_TEXT.test(value.value),
  );

  const children: t.JSXElement['children'] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value) return undefined;

    if (textual[index] && !textual[index - 1] && !textual[index + 1]) {
      children.push(t.inherits(t.jsxText((value as t.StringLiteral).value), value));
      continue;
    }
    if (t.isJSXElement(value) || t.isJSXFragment(value)) {
      children.push(value);
      continue;
    }
    children.push(t.jsxExpressionContainer(value));
  }
  return children;
}

function buildTagName(type: t.Expression): t.JSXIdentifier | t.JSXMemberExpression | undefined {
  if (t.isStringLiteral(type)) {
    return INTRINSIC_TAG.test(type.value)
      ? t.inherits(t.jsxIdentifier(type.value), type)
      : undefined;
  }
  if (t.isIdentifier(type)) {
    return COMPONENT_TAG.test(type.name) ? t.inherits(t.jsxIdentifier(type.name), type) : undefined;
  }
  if (t.isMemberExpression(type)) return buildDottedTagName(type);
  return undefined;
}

/**
 * `<A.B.C />`. A dotted tag is always a value lookup, so - unlike a bare tag -
 * a lowercase root is fine: `<a.b/>` reads the binding `a`, `<a/>` does not.
 */
function buildDottedTagName(node: t.MemberExpression): t.JSXMemberExpression | undefined {
  if (node.computed || !t.isIdentifier(node.property)) return undefined;
  if (!PLAIN_JS_NAME.test(node.property.name)) return undefined;

  let object: t.JSXIdentifier | t.JSXMemberExpression | undefined;
  if (t.isIdentifier(node.object)) {
    if (!PLAIN_JS_NAME.test(node.object.name)) return undefined;
    object = t.inherits(t.jsxIdentifier(node.object.name), node.object);
  } else if (t.isMemberExpression(node.object)) {
    object = buildDottedTagName(node.object);
  }
  if (!object) return undefined;

  return t.inherits(t.jsxMemberExpression(object, t.jsxIdentifier(node.property.name)), node);
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

function staticPropertyName(key: t.Node): string | undefined {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  return undefined;
}

/**
 * Whether an argument is the "nothing here" placeholder the runtime treats as
 * absent, so dropping it from the JSX is equivalent.
 *
 * The `undefined` case asks whether the *name* is the value here. It usually
 * is, but `_jsx(C, undefined)` inside `function f(undefined)` passes whatever
 * the caller gave, and inside `with (o)` it passes `o.undefined`; `<C />`
 * re-compiles to `_jsx(C, {})` - a different props object, with no error
 * anywhere, which is the asymmetry this whole pass is written around. Either
 * way the call is left alone.
 */
function isNullish(node: t.Expression, at: NodePath): boolean {
  if (t.isNullLiteral(node)) return true;
  if (isUnboundUndefined(node, at.scope) && !insideWith(at)) return true;
  return t.isUnaryExpression(node) && node.operator === 'void' && t.isNumericLiteral(node.argument);
}
