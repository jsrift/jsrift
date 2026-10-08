import _traverse from '@babel/traverse';
import type { Binding } from '@babel/traverse';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import { RenameAllocator } from '../src/naming/allocate.js';
import { renameIdentifiersPass } from '../src/passes/rename/identifiers.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * An evidence rule must not be able to read its own output back as evidence.
 *
 * Several rules in `naming/evidence.ts` build a name as `<source> <noun>`, where
 * `source` is `world.displayName` of an identifier the rule found in the
 * evidence. `displayName` reports the name that identifier's binding *will be
 * given*, so when the identifier resolves to the binding being named, `source`
 * is that binding's own current name and the suggestion is
 * `<current name><Noun>`. The next run over that output reads the longer name
 * back and appends the same word again.
 *
 * Two rules had the bug, both measured on the eight-line sources below at
 * 'aggressive':
 *
 *   A21, `x = JSON.parse(x)`:      data -> dataData -> dataDataData -> ...
 *   A05, `x = x.getContext('2d')`: obj1 -> obj1Ctx -> obj1CtxCtx    -> ...
 *
 * Measured on the sources below at 'aggressive' before the fix: A21 added 16
 * characters a run and A05 15, and on `fixtures/lightly-obfuscated.js` A21
 * added 28. It is not literally endless - `toCamel` truncates at 32 characters,
 * so the generated-name parse source stopped growing after 7 runs (122 -> 234
 * characters) and the getContext one after 12 (149 -> 279, dropping back to 139
 * once when the cap first truncated the name and climbing again from there).
 * Bounded is not settled: what the engine needs is run N + 1 equal to run N,
 * and for those seven and twelve runs it was not. `fixtures/lightly-obfuscated.js`
 * at 'aggressive' now reaches a fixed point at the third run.
 *
 * The assertion is byte equality between a run and the run after it. "Fewer
 * changes than last time" is not the property: a pass that reports one rename a
 * run reports the same one rename forever.
 *
 * Only the 'aggressive' rows discriminate. The loop needs `displayName` to hand
 * a rule the name the previous run gave the binding, and it will only do that
 * for a name that passes `isReadableName`; under the other presets
 * `renameReadable` is off, so such a binding is not a rename target at all and
 * the second run leaves it alone. The 'balanced' rows are here to catch a fix
 * that buys convergence by moving the divergence to another preset. Measured
 * with both rules and the allocator guard reverted: all three 'aggressive' rows
 * below fail, every 'balanced' row passes, and one of the four allocator rows
 * fails.
 */
const PRESETS = ['balanced', 'aggressive'] as const;

/** Deobfuscate `source`, then deobfuscate that output `rounds - 1` more times. */
async function iterate(
  source: string,
  preset: (typeof PRESETS)[number],
  rounds: number,
): Promise<string[]> {
  const outputs: string[] = [];
  let current = source;
  for (let round = 0; round < rounds; round++) {
    const result = await deobfuscate(current, { preset });
    current = result.code;
    outputs.push(current);
  }
  return outputs;
}

/** A21: the argument of `JSON.parse` is the binding the result is assigned to. */
const SELF_PARSE = [
  'function load(input) {',
  '  var data = input;',
  '  data = JSON.parse(data);',
  '  return data.value;',
  '}',
  'console.log(load(\'{"value":1}\'));',
].join('\n');

/** A05: the receiver of `getContext` is the binding the result is assigned to. */
const SELF_CONTEXT = [
  'function draw(surface) {',
  '  var ctx = surface;',
  "  ctx = ctx.getContext('2d');",
  '  ctx.fillRect(0, 0, 1, 1);',
  '  return ctx;',
  '}',
  'draw(document.body);',
].join('\n');

/** The same two shapes written with generated names, as a file would arrive. */
const SELF_PARSE_OBFUSCATED = [
  'function _0x4f21(_0x1a2b) {',
  '  var _0x3c4d = _0x1a2b;',
  '  _0x3c4d = JSON.parse(_0x3c4d);',
  '  return _0x3c4d.value;',
  '}',
  'console.log(_0x4f21(\'{"value":1}\'));',
].join('\n');

const SELF_CONTEXT_OBFUSCATED = [
  'function _0x5e32(_0x2b3c) {',
  '  var _0x6d7e = _0x2b3c;',
  "  _0x6d7e = _0x6d7e.getContext('2d');",
  '  _0x6d7e.fillRect(0, 0, 1, 1);',
  '  return _0x6d7e;',
  '}',
  '_0x5e32(document.body);',
].join('\n');

describe('naming: a rule must not name a binding after itself', () => {
  it.each(PRESETS)('reaches a byte-identical fixed point on x = JSON.parse(x) under %s', async (preset) => {
    const [first, second, third] = await iterate(SELF_PARSE, preset, 3);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it.each(PRESETS)(
    "reaches a byte-identical fixed point on x = x.getContext('2d') under %s",
    async (preset) => {
      const [first, second, third] = await iterate(SELF_CONTEXT, preset, 3);
      expect(second).toBe(first);
      expect(third).toBe(first);
    },
  );

  it.each(PRESETS)('converges on the generated-name form of both shapes under %s', async (preset) => {
    for (const source of [SELF_PARSE_OBFUSCATED, SELF_CONTEXT_OBFUSCATED]) {
      const [first, second, third] = await iterate(source, preset, 3);
      expect(second).toBe(first);
      expect(third).toBe(first);
    }
  });

  // Convergence alone would also be satisfied by declining to name the binding
  // at all, which would lose the rule. The fallback the rule already had for "no
  // usable source" is the right answer here, so pin the name it produces.
  it('falls back to the bare noun rather than declining', async () => {
    const parse = await deobfuscate(SELF_PARSE_OBFUSCATED, { preset: 'aggressive' });
    expect(parse.code).toContain('data = JSON.parse(data)');
    expect(parse.code).not.toMatch(/dataData/);

    const context = await deobfuscate(SELF_CONTEXT_OBFUSCATED, { preset: 'aggressive' });
    expect(context.code).toContain("ctx = ctx.getContext('2d')");
    expect(context.code).not.toMatch(/[Cc]tx[A-Z]?[a-z]*Ctx/);
  });

  // The fix is refusing the *self* reference, not the `<source> <noun>` form.
  // When the argument is a different binding the rule still borrows its name.
  //
  // The binding it borrows from has to be one this run KEEPS, which the source
  // below arranges by giving it a name a rule settles on. The earlier version
  // borrowed from a bare parameter `raw` and pinned `_0x2f1a->rawData` - an
  // expectation that sat on the wrong side of this file's own rule. At
  // 'aggressive' `renameReadable` makes `raw` a target too, no rule fires for
  // it, and it becomes `arg1` in the same pass, so `rawData` was derived from an
  // identifier that appears nowhere in the output. Measured through the full
  // pipeline on that exact source: run one `raw->arg1`, `_0x2f1a->rawData`; run
  // two `rawData->arg1Data`; run three unchanged. Two runs to settle is not
  // settled, and the name a reader ends up with is `arg1Data` either way.
  it('still names a parse after a different binding', async () => {
    const { ctx } = await runPass(
      renameIdentifiersPass,
      [
        'function load(_0xa) {',
        '  var _0xb = _0xa.responseText;',
        '  var _0x2f1a = JSON.parse(_0xb);',
        '  return _0x2f1a.value;',
        '}',
        'load({});',
      ].join('\n'),
      { preset: 'aggressive' },
    );
    const renames = ctx.renames.map((entry) => `${entry.from}->${entry.to}`);
    expect(renames).toContain('_0xb->responseText');
    expect(renames).toContain('_0x2f1a->responseTextData');
  });
});

describe('naming/allocate: a name that only extends the current one is refused', () => {
  const allocator = new RenameAllocator({
    typescript: false,
    strictStringGuard: false,
    strings: new Set(),
    freeGlobalScopes: new Map(),
    globalProperties: new Set(),
    readsGlobalProperty: () => false,
    annexBNames: new Map(),
  });

  /** The program-scope binding of `name` in `source`. */
  function bindingOf(source: string, name: string): Binding {
    const parsed = parseSource(source);
    let found: Binding | undefined;
    traverse(parsed.ast, {
      Program(path) {
        found = path.scope.getBinding(name);
        path.stop();
      },
    });
    if (!found) throw new Error(`no binding named ${name}`);
    return found;
  }

  it('refuses the appended word and every collision suffix of it', () => {
    const binding = bindingOf('var data = 1; console.log(data);', 'data');
    expect(allocator.canRename(binding, 'dataData')).toBe(false);
    expect(allocator.canRename(binding, 'dataData2')).toBe(false);
    expect(allocator.canRename(binding, 'dataUrl')).toBe(false);
  });

  it('allows a longer name that does not start a new word at the seam', () => {
    // `i` -> `index` extends the current name as a string, but it is a real
    // rename rather than a rule re-reading its own output. It is also below the
    // length `displayName` will report, so it could not have been the source.
    const binding = bindingOf('var i = 0; console.log(i);', 'i');
    expect(allocator.canRename(binding, 'index')).toBe(true);
  });

  it('allows an appended word when the current name is one displayName refuses', () => {
    // Two characters, so `isReadableName` rejects it and no rule can have
    // borrowed it: this cannot be the loop, and refusing it would cost a rename.
    const binding = bindingOf('var ab = 1; console.log(ab);', 'ab');
    expect(allocator.canRename(binding, 'abData')).toBe(true);
  });

  it('still allows an unrelated name', () => {
    const binding = bindingOf('var data = 1; console.log(data);', 'data');
    expect(allocator.canRename(binding, 'payload')).toBe(true);
  });
});
