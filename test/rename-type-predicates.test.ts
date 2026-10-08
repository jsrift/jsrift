import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/frontend/language.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * `(s: Shape): s is Circle` names a parameter from inside the return type.
 *
 * That position is neither a reference Babel records nor a type name, so the
 * renamer's reference rewrite and its type-position rewrite both missed it,
 * and `s` became `shape` everywhere except in the predicate: TS1225, "Cannot
 * find parameter 's'", from output that had compiled as input.
 *
 * The check below is that diagnostic's own condition, asked of the re-parsed
 * output: every predicate must name a parameter of the function whose return
 * type it is. It is paired with an assertion that the parameter WAS renamed,
 * so a run that declined every rename cannot pass by doing nothing.
 */

/** Predicate parameter names that no parameter of their function carries. */
function danglingPredicates(code: string, language: 'ts' | 'tsx' = 'ts'): string[] {
  const { ast } = parseSource(code, { language });
  const dangling: string[] = [];
  traverse(ast, {
    TSTypePredicate(path) {
      const name = path.node.parameterName;
      if (!t.isIdentifier(name)) return;
      const fn = path.getFunctionParent();
      const params = fn?.node.params ?? [];
      const declared = params.some((param) => {
        const target = t.isAssignmentPattern(param) ? param.left : param;
        return t.isIdentifier(target) && target.name === name.name;
      });
      if (!declared) dangling.push(name.name);
    },
  });
  return dangling;
}

async function rename(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, { language: 'ts', ...options });
  return { code, renames: ctx.renames.map((entry) => `${entry.from}->${entry.to}`) };
}

const PRESETS: readonly DeobfuscateOptions[] = [{ preset: 'balanced' }, { preset: 'aggressive' }];

describe('rename.identifiers: a type predicate follows its parameter', () => {
  const SOURCE = `interface Shape { kind: string }
interface Circle extends Shape { kind: 'circle'; r: number }
export const arrow = (s: Shape): s is Circle => s.kind === 'circle';
export class C { method(p: Shape): p is Circle { return p.kind === 'circle'; } }
function _0x4a2b(_0x1f3c: unknown): _0x1f3c is string { return typeof _0x1f3c === 'string'; }
function _0x5b3c(_0x2e4d: unknown): asserts _0x2e4d is number { if (typeof _0x2e4d !== 'number') throw new Error('no'); }
function _0x6c4d(_0x3f5e: unknown): asserts _0x3f5e { if (!_0x3f5e) throw new Error('no'); }
export function use(v: unknown) { _0x5b3c(v); _0x6c4d(v); return _0x4a2b(v) ? 1 : v; }
`;

  for (const options of PRESETS) {
    it(`renames the parameter and the predicate together (${options.preset})`, async () => {
      const { code, renames } = await rename(SOURCE, options);
      expect(renames).toContain('s->shape');
      expect(renames).toContain('p->shape');
      expect(danglingPredicates(code)).toEqual([]);
      expect(code).toContain('(shape: Shape): shape is Circle');
      expect(code).toContain('method(shape: Shape): shape is Circle');
    });
  }

  it('follows the typed fallback into asserts predicates', async () => {
    const { code, renames } = await rename(SOURCE, { preset: 'aggressive' });
    expect(renames).toContain('_0x1f3c->arg1');
    expect(renames).toContain('_0x2e4d->arg1');
    expect(renames).toContain('_0x3f5e->arg1');
    expect(danglingPredicates(code)).toEqual([]);
    expect(code).toContain('(arg1: unknown): arg1 is string');
    expect(code).toContain('(arg1: unknown): asserts arg1 is number');
    expect(code).toContain('(arg1: unknown): asserts arg1 {');
  });

  // The predicate resolves in the function's own scope, so it follows the
  // parameter it annotates and not an outer binding that shares the spelling.
  it('binds to the annotated function, not to a same-named outer parameter', async () => {
    const { code, renames } = await rename(
      `function outer(_0x1f3c: unknown) {
  const _0x7d5e = (_0x1f3c: unknown): _0x1f3c is string => typeof _0x1f3c === 'string';
  return _0x7d5e(_0x1f3c) ? _0x1f3c.length : 0;
}
outer(1);`,
      { preset: 'aggressive' },
    );
    // Two bindings, two different new names; the predicate must carry the inner one.
    const given = renames.filter((entry) => entry.startsWith('_0x1f3c->')).map((entry) => entry.slice(9));
    expect(given).toHaveLength(2);
    expect(new Set(given).size).toBe(2);
    const inner = /\((\w+): unknown\): (\w+) is string/.exec(code);
    expect(inner?.[2]).toBe(inner?.[1]);
    expect(code).not.toContain(`: ${given.find((name) => name !== inner?.[1])} is string`);
    expect(danglingPredicates(code)).toEqual([]);
  });

  it('leaves a this-predicate alone', async () => {
    const { code } = await rename(
      `export class _0x8e6f { _0x9f70 = 1; isBox(): this is _0x8e6f { return this._0x9f70 === 1; } }`,
      { preset: 'aggressive' },
    );
    expect(code).toContain('this is ');
    expect(danglingPredicates(code)).toEqual([]);
  });
});
