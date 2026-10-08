import type { NodePath, Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import { hasVerboseEscape } from '../../analysis/detect.js';
import type { Pass } from '../../pipeline/pass.js';
import type { PassContext } from '../../pipeline/context.js';
import { isSemanticDirective } from '../simplify/proxy-functions.js';
import { isTaggedQuasi, plainTemplateValue } from '../../util/ast.js';

/**
 * Escape census, handed to `prepare.detect`.
 *
 * The detect pass is a `run` pass, and the kernel runs a stage's merged visitor
 * traversal *before* its `run` passes - so by the time detection executes, this
 * pass has already thrown away the `\xNN` raws that are the evidence for
 * `unicodeEscapeSequence`. Counting here and passing the numbers forward keeps
 * both honest: standalone `analyze()` still measures the intact tree.
 */
export const ESCAPE_STATS_KEY = 'prepare.normalize-literals:escapes';

export interface EscapeStats {
  escaped: number;
  total: number;
}

/**
 * Lossless literal normalisation.
 *
 * Nothing here changes a value; it changes only how a value is *written*, by
 * dropping a `extra.raw` the generator would otherwise echo verbatim. That is
 * what turns `'\x66\x6f\x6f'` into `'foo'` and `0x1f` into `31` for free, and it
 * is why every later pass can pattern-match on plain forms.
 *
 * This registration covers the *input* only. `prepare` runs before `unpack`, so
 * anything a packer was holding arrives after it has finished; that half is
 * `renormalizeLiteralsPass` below, which shares this visitor.
 */
export const normalizeLiteralsPass: Pass = {
  id: 'prepare.normalize-literals',
  title: 'Normalise escaped and numeric literals',
  stage: 'prepare',
  technique: 'literalSimplification',

  visitor: (ctx) => normalizeVisitor(ctx, true),
};

/**
 * The same normalisation, re-run once per fixpoint round.
 *
 * `prepare` runs once, in the kernel's prologue, and it runs *before* `unpack`.
 * A packer's payload therefore enters the tree already past the only pass that
 * would have normalised it: `unpack.function-constructor` re-parses a source
 * string, and every literal in the subtree it grafts in keeps the `extra.raw`
 * the parser gave it. Nothing downstream rewrites a literal it does not
 * otherwise need to touch, so those raws are echoed verbatim by the generator
 * all the way to the output.
 *
 * Measured on `obfuscated4.js`, which is one `Function(name, "<3.5 MB body>")`
 * call: the payload holds 85 verbose-escaped literals totalling 1,401,198 raw
 * characters, 2 of them 858,878 and 531,242 characters long. Before this pass
 * existed the engine emitted them unchanged, so its own output was not its own
 * fixpoint - feeding the output back in normalised them on the *second* run and
 * removed 1,119,791 characters that the first run had no way to reach.
 *
 * It lives in `strings` - the first stage of the fixpoint loop - rather than in
 * the epilogue, because the raws are only half of what is being normalised. A
 * template literal is a *different node type*, so a recogniser spelled against
 * `StringLiteral` cannot see one, and several of them sit downstream of here:
 * `clean.anti-tamper` matches the self-defending trap on a `StringLiteral`, and
 * a payload whose strings are all backticks - which is what Cloudflare's
 * post-pass produces - hides the trap from it entirely. Normalising after the
 * loop instead prints that trap more prettily and leaves it in the output: that
 * was measured on the same input by moving this registration to `finalize`, and
 * `renormalize-fixpoint.test.ts` pins the reachable half of it - the trap is
 * removed with this pass and survives with it disabled.
 *
 * Later than `clean` would be wrong for a second reason: `finalize.jsx`
 * deliberately *sets* `extra.raw` on the literals it moves into JSX attributes,
 * because a JSX attribute's text is not escape-processed and a cooked re-emit
 * would change what the attribute says.
 *
 * The price of running every round rather than once is one set of handler calls
 * per round on a traversal the stage already performs for `strings.merge-split`
 * - no extra walk. Measured paired against the same pass placed after the loop,
 * that is 745 ms of 25.3 s on `obfuscated4.js` (3.8 MB, 4 rounds) and inside the
 * noise on the other four fixtures.
 *
 * Sharing the visitor with the `prepare` registration rather than duplicating it
 * is what keeps the two spellings of "normalised" from drifting apart.
 */
export const renormalizeLiteralsPass: Pass = {
  id: 'strings.normalize-literals',
  title: 'Re-normalise literals revealed by unpacking',
  stage: 'strings',
  technique: 'literalSimplification',

  // Disabling the normalisation has to disable it everywhere; a caller who put
  // `prepare.normalize-literals` in `disablePasses` asked to keep their raws.
  when: (ctx) => !ctx.config.disabledPasses.has('prepare.normalize-literals'),

  // No census: `prepare.detect` has already run and read the `prepare`
  // registration's numbers, and those describe the *input*, which is what a
  // fingerprint is about. Overwriting them from a half-deobfuscated tree would
  // make the reported escape density a measurement of our own progress.
  visitor: (ctx) => normalizeVisitor(ctx, false),
};

function normalizeVisitor(ctx: PassContext, census: boolean): Visitor<unknown> {
  const stats: EscapeStats = { escaped: 0, total: 0 };
  if (census) ctx.shared.set(ESCAPE_STATS_KEY, stats);
  // TS type positions can only exist in a TS dialect, so the ancestor walk is
  // skipped entirely for JavaScript - which is every large obfuscated input.
  const guardTypePositions = ctx.language === 'ts' || ctx.language === 'tsx';

  return {
    StringLiteral(path: NodePath<t.StringLiteral>) {
      const node = path.node;
      stats.total++;
      const raw = rawOf(node);
      if (raw === undefined || !hasVerboseEscape(raw)) return;
      stats.escaped++;

      // A JSX attribute's text is NOT escape-processed: `alt="a\tb"` means
      // backslash-t-b to JSX, so re-emitting the cooked value through a JS
      // string escaper would silently rewrite the attribute.
      if (path.parentPath.isJSXAttribute()) return;
      if (guardTypePositions && isInTypePosition(path)) return;

      dropRaw(node);
      ctx.markChanged();
    },

    NumericLiteral(path: NodePath<t.NumericLiteral>) {
      const node = path.node;
      const raw = rawOf(node);
      if (raw === undefined) return;

      const decimal = decimalFormOf(node.value);
      // Longer is not a normalisation: `1e21` must not become `1e+21`, and
      // `0.5` must not become `0.5` via a detour that costs bytes.
      if (decimal === undefined || decimal === raw || decimal.length > raw.length) return;
      if (guardTypePositions && isInTypePosition(path)) return;

      dropRaw(node);
      ctx.markChanged();
    },

    DirectiveLiteral(path: NodePath<t.DirectiveLiteral>) {
      const node = path.node;
      const raw = rawOf(node);
      if (raw === undefined) return;

      // `DirectiveLiteral.value` holds the *raw* source text between the
      // quotes - Babel deliberately does not cook it, because a directive
      // containing an escape is not a directive at all. Re-emitting from the
      // value therefore preserves `'\x75se strict'` as an inert string while
      // canonicalising a real `'use strict'` to the double-quoted form the
      // generator uses for every directive.
      const value = node.value;
      if (hasUnescaped(value, '"') && hasUnescaped(value, "'")) return;
      if (raw === `"${value}"`) return;

      dropRaw(node);
      ctx.markChanged();
    },

    /**
     * `` `foo` `` -> `'foo'`.
     *
     * An untagged template with no substitutions *is* a string literal: same
     * value, same type, no observable difference. Rewriting it here rather
     * than teaching every recogniser to accept both spellings is what makes
     * the rest of the engine work on a file that has been through
     * Cloudflare's post-pass, which converts every string literal in the
     * program to this form. On the 448 KB managed-challenge fixture that is
     * 687 literals, and until they are plain strings the switch-case labels,
     * the string table and the alias-map keys are all invisible.
     */
    TemplateLiteral(path: NodePath<t.TemplateLiteral>) {
      const value = plainTemplateValue(path.node);
      // Refuses substitutions, multiple quasis, and an undefined `cooked`
      // (an escape with no decoded value, which only a tag can observe).
      if (value === undefined) return;
      // A tag receives the strings array and the raws, not a string.
      if (isTaggedQuasi(path)) return;
      // `` `use strict` `` is an ordinary expression statement; `'use strict'`
      // in the same position is a directive that changes the enclosing
      // function's semantics.
      if (isSemanticDirective(value) && path.parentPath.isExpressionStatement()) return;
      // Template-literal *types* are not values; `type A = `a${B}`` is a
      // different construct that happens to share the node.
      if (guardTypePositions && isInTypePosition(path)) return;

      path.replaceWith(t.inherits(t.stringLiteral(value), path.node));
      ctx.markChanged();
    },
  };
}

function rawOf(node: t.Node): string | undefined {
  const raw = node.extra?.['raw'];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Clear only `raw`, not the whole `extra` bag: `parenthesized` also lives there
 * and the generator consults it to decide whether `(1).toFixed()` keeps its
 * parentheses.
 */
function dropRaw(node: t.Node): void {
  if (node.extra) node.extra['raw'] = undefined;
}

/**
 * The shortest exact decimal spelling of a numeric literal, or `undefined` when
 * there is not one.
 *
 * `Infinity` is the trap: `1e999` parses to a `NumericLiteral` whose value is
 * `Infinity`, and `String(Infinity)` is an identifier, not a literal. `-0` is the
 * other one: it prints as `0` and would silently change `Object.is` and `1/x`.
 */
function decimalFormOf(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (Object.is(value, -0)) return undefined;
  const decimal = String(value);
  return Number(decimal) === value ? decimal : undefined;
}

/** True when `quote` appears in `text` without a preceding backslash. */
function hasUnescaped(text: string, quote: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '\\') {
      i++;
      continue;
    }
    if (character === quote) return true;
  }
  return false;
}

/**
 * Whether the literal sits inside a TypeScript type. Rewriting `type A = 0xff`
 * to `type A = 255` is value-preserving, but type positions are not this pass's
 * business and an enum initialiser or a template-literal type is close enough to
 * the edge that bailing is the right call.
 *
 * Bounded: a literal in a type is always inside the type annotation subtree of
 * the statement that declares it, so the walk stops at the first statement.
 */
function isInTypePosition(path: NodePath): boolean {
  let current: NodePath | null = path.parentPath;
  for (let depth = 0; current !== null && depth < 32; depth++) {
    if (current.node.type.startsWith('TS')) return true;
    if (current.isStatement() || current.isFunction() || current.isProgram()) return false;
    current = current.parentPath;
  }
  return false;
}
