import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { refreshStringCodeFacts } from '../../analysis/string-code-sites.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { isSafeDotKey, staticString } from '../../util/ast.js';

type KeyedNode = t.ObjectProperty | t.ObjectMethod | t.ClassMethod | t.ClassProperty;

/**
 * Keys whose meaning depends on the `computed` flag.
 *
 * `{ ['__proto__']: v }` installs an own property while `{ __proto__: v }` sets
 * the prototype, and a computed `'constructor'` in a class body is an ordinary
 * method rather than the constructor. Quoted *non*-computed keys are already
 * equivalent to their identifier form, so only computed keys are at risk.
 */
const COMPUTED_KEY_HAZARDS = new Set(['__proto__', 'constructor', 'prototype']);

export const normalizePropertiesPass: Pass = {
  id: 'simplify.properties',
  title: 'Rewrite computed string keys as dot access',
  stage: 'simplify',
  technique: 'propertyNormalization',
  visitor: (ctx) => ({
    MemberExpression: (path: NodePath<t.MemberExpression>) => normalizeMember(path, ctx),
    OptionalMemberExpression: (path: NodePath<t.OptionalMemberExpression>) =>
      normalizeMember(path, ctx),
    ObjectProperty: (path: NodePath<t.ObjectProperty>) => normalizeKey(path, ctx),
    ObjectMethod: (path: NodePath<t.ObjectMethod>) => normalizeKey(path, ctx),
    ClassMethod: (path: NodePath<t.ClassMethod>) => normalizeKey(path, ctx),
    ClassProperty: (path: NodePath<t.ClassProperty>) => normalizeKey(path, ctx),
  }),
};

/**
 * `a['b']` -> `a.b`, for any object expression whatsoever.
 *
 * Working on the AST rather than on text is the whole win here: the shape of
 * what precedes the bracket is irrelevant, so `f(x)['length']` and
 * `a.b.c['d']` convert exactly like a bare identifier does.
 */
function normalizeMember(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  ctx: PassContext,
): void {
  const { node } = path;
  if (!node.computed) return;
  const key = staticString(node.property);
  if (key === undefined || !isSafeDotKey(key)) return;

  // `optional` is carried by the node itself, so `a?.['b']` becomes `a?.b` and
  // keeps short-circuiting exactly as before.
  node.property = t.inherits(t.identifier(key), node.property);
  node.computed = false;
  ctx.markChanged();
  // `g['eval'](src)` is classified by nothing and `g.eval(src)` by the
  // indirect-eval rule; the passes after this one in the stage delete by
  // what the facts say a string can reach.
  refreshStringCodeFacts(ctx, path);
}

function normalizeKey(path: NodePath<KeyedNode>, ctx: PassContext): void {
  const { node } = path;
  // A shorthand property shares one node between key and value; rewriting the
  // key would silently rewrite the value too.
  if (t.isObjectProperty(node) && node.shorthand) return;

  const key = staticString(node.key);
  if (key === undefined || !isSafeDotKey(key)) return;
  if (node.computed && COMPUTED_KEY_HAZARDS.has(key)) return;

  node.key = t.inherits(t.identifier(key), node.key);
  node.computed = false;
  ctx.markChanged();
}
