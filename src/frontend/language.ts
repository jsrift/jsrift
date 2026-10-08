import { parse, type ParserOptions, type ParserPlugin } from '@babel/parser';
import { VISITOR_KEYS } from '@babel/types';
import type * as t from '@babel/types';
import { describeValue, LANGUAGES, SOURCE_TYPES } from '../config/validate.js';
import type { Language, SourceType } from '../types.js';

export type ConcreteLanguage = Exclude<Language, 'auto'>;

/**
 * Which decorator grammar a parse used.
 *
 * `proposal` is the current TC39 syntax: `export @dec class`, auto-accessors,
 * and `@(expr)` for anything that is not a dotted name or a call on one.
 * `legacy` is the TypeScript / Babel 6 grammar, which also accepts `@a.b().c`
 * bare and `@dec export class`. Neither is a superset of the other, so a file
 * is tried under `proposal` first and under `legacy` only when that fails.
 */
export type DecoratorSyntax = 'proposal' | 'legacy';

/**
 * Plugin sets per dialect.
 *
 * `ts` and `tsx` are genuinely different grammars, not a superset relationship:
 * `<T>(x) => x` is a type assertion in `.ts` and a JSX element in `.tsx`. There
 * is no single configuration that parses both, which is why detection is a
 * ladder rather than a lookup.
 */
const PLUGIN_SETS: Record<ConcreteLanguage, ParserPlugin[]> = {
  js: ['importAttributes', 'explicitResourceManagement'],
  jsx: ['jsx', 'importAttributes', 'explicitResourceManagement'],
  ts: ['typescript', 'importAttributes', 'explicitResourceManagement'],
  tsx: ['typescript', 'jsx', 'importAttributes', 'explicitResourceManagement'],
};

const DECORATOR_PLUGINS: Record<DecoratorSyntax, ParserPlugin[]> = {
  proposal: ['decorators', 'decoratorAutoAccessors'],
  legacy: ['decorators-legacy', 'decoratorAutoAccessors'],
};

const DECORATOR_ORDER: readonly DecoratorSyntax[] = ['proposal', 'legacy'];

const EXTENSION_MAP: Record<string, ConcreteLanguage> = {
  js: 'js',
  cjs: 'js',
  mjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  cts: 'ts',
  mts: 'ts',
  tsx: 'tsx',
};

/**
 * Ladder order is least-featured first so the reported dialect is the most
 * specific one that is actually justified: plain JavaScript is reported as `js`
 * even though it would also parse as `tsx`.
 */
const LADDER: ConcreteLanguage[] = ['js', 'jsx', 'ts', 'tsx'];

/** The TypeScript grammar that reads the same text as a JavaScript dialect does. */
const TYPED_COUNTERPART: Record<'js' | 'jsx', 'ts' | 'tsx'> = { js: 'ts', jsx: 'tsx' };

export function languageFromFilename(filename: string | undefined): ConcreteLanguage | undefined {
  if (!filename) return undefined;
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? EXTENSION_MAP[ext] : undefined;
}

export function parserOptionsFor(
  language: ConcreteLanguage,
  sourceType: SourceType,
  extra: Partial<ParserOptions> = {},
  decorators: DecoratorSyntax = 'proposal',
): ParserOptions {
  return {
    sourceType,
    plugins: [...PLUGIN_SETS[language], ...DECORATOR_PLUGINS[decorators]],
    errorRecovery: false,
    ranges: false,
    attachComment: true,
    createParenthesizedExpressions: false,
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    allowNewTargetOutsideFunction: true,
    ...extra,
  };
}

export interface ParseOutcome {
  ast: t.File;
  language: ConcreteLanguage;
  sourceType: Exclude<SourceType, 'unambiguous'>;
  /** The decorator grammar the tree was read under; a re-parse of the output starts there. */
  decorators: DecoratorSyntax;
  /** True when the file only parsed with error recovery enabled. */
  recovered: boolean;
  errors: string[];
}

export interface ParseSourceOptions {
  language?: Language;
  sourceType?: SourceType;
  filename?: string;
}

/**
 * Parse `code`, detecting the dialect when it is not pinned.
 *
 * Detection walks the ladder and keeps the first configuration that parses
 * cleanly - with one exception, below. Only if every configuration fails is the
 * most permissive one retried with error recovery, so that partially-broken
 * input still produces a tree to work with rather than an exception.
 *
 * The exception is a file that is valid in a JavaScript dialect *and* in its
 * TypeScript counterpart with a different meaning. `f<T>(x)` is a call with a
 * type argument to TypeScript and `(f < T) > (x)` to JavaScript; both parse,
 * and the ladder's "first that parses" rule would report `js` and hand the
 * comparison chain to every pass as the program. That is not detection, it is
 * a guess that changes what the input means, so the file is refused with the
 * site named ({@link AmbiguousDialectError}) and the caller pins the dialect.
 * A pinned dialect is never second-guessed: a `.js` file that contains
 * `a < b > (c)` is the comparison its author wrote.
 */
export function parseSource(code: string, options: ParseSourceOptions | null = {}): ParseOutcome {
  if (typeof code !== 'string') {
    throw new TypeError(
      `parseSource() expects the source as a string, received ${describeValue(code)}. ` +
        'Read the file with an encoding (fs.readFileSync(path, "utf8")) or call String() on it first.',
    );
  }
  options = validateParseOptions(options);
  const sourceType = options.sourceType ?? 'unambiguous';
  const pinned =
    options.language && options.language !== 'auto'
      ? options.language
      : languageFromFilename(options.filename);

  const candidates = pinned ? [pinned, ...LADDER.filter((l) => l !== pinned)] : LADDER;
  const errors: string[] = [];

  for (const language of candidates) {
    const attempt = strictParse(code, language, sourceType);
    if (!attempt.ast) {
      errors.push(`${language}: ${attempt.error.message}`);
      continue;
    }
    if (!pinned && (language === 'js' || language === 'jsx') && looksLikeTypeArguments(attempt.ast)) {
      const typed = strictParse(code, TYPED_COUNTERPART[language], sourceType);
      const site = typed.ast && firstTypeArgumentSite(typed.ast, code);
      if (site) throw new AmbiguousDialectError(code, language, TYPED_COUNTERPART[language], site);
    }
    return {
      ast: attempt.ast,
      language,
      sourceType: resolveSourceType(attempt.ast, sourceType),
      decorators: attempt.decorators,
      recovered: false,
      errors: [],
    };
  }

  // Every dialect failed a strict parse. Retry the widest grammar with recovery
  // so that merely-damaged input still yields a workable tree.
  const fallback = pinned ?? 'tsx';
  let cause: unknown;
  for (const decorators of DECORATOR_ORDER) {
    try {
      const ast = parse(code, parserOptionsFor(fallback, sourceType, { errorRecovery: true }, decorators));
      return {
        ast,
        language: fallback,
        sourceType: resolveSourceType(ast, sourceType),
        decorators,
        recovered: true,
        errors,
      };
    } catch (error) {
      cause ??= error;
    }
  }
  throw new ParseFailedError(code, errors, cause);
}

type StrictAttempt =
  | { ast: t.File; decorators: DecoratorSyntax; error?: undefined }
  | { ast?: undefined; decorators?: undefined; error: Error };

/**
 * One strict parse of `code` as `language`, under each decorator grammar in
 * turn. The error reported for a failure is the one the parser got furthest
 * on: when both grammars reject a file, the one that stumbled on the
 * decorator says nothing about what is actually wrong with it.
 */
function strictParse(code: string, language: ConcreteLanguage, sourceType: SourceType): StrictAttempt {
  let furthest: Error | undefined;
  for (const decorators of DECORATOR_ORDER) {
    try {
      return { ast: parse(code, parserOptionsFor(language, sourceType, {}, decorators)), decorators };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!furthest || errorPosition(failure) > errorPosition(furthest)) furthest = failure;
    }
  }
  return { error: furthest as Error };
}

function errorPosition(error: Error): number {
  const pos = (error as { pos?: unknown }).pos;
  return typeof pos === 'number' ? pos : -1;
}

function validateParseOptions(options: ParseSourceOptions | null | undefined): ParseSourceOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`options must be an object; received ${describeValue(options)}.`);
  }
  const { language, sourceType, filename } = options;
  if (language !== undefined && !LANGUAGES.includes(language)) {
    throw new TypeError(
      `Unknown language ${describeValue(language)}. Expected one of: ${LANGUAGES.join(', ')}.`,
    );
  }
  if (sourceType !== undefined && !SOURCE_TYPES.includes(sourceType)) {
    throw new TypeError(
      `Unknown sourceType ${describeValue(sourceType)}. Expected one of: ${SOURCE_TYPES.join(', ')}.`,
    );
  }
  if (filename !== undefined && typeof filename !== 'string') {
    throw new TypeError(`filename must be a string; received ${describeValue(filename)}.`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript ambiguity
// ---------------------------------------------------------------------------

/**
 * Does this JavaScript tree contain the comparison shape a TypeScript type
 * argument list leaves behind?
 *
 * Every form of `f<...>(...)` that JavaScript accepts at all ends in a `>` whose
 * right operand starts with the parenthesised argument list - or a template
 * literal, for a generic tagged template - and that `>` sits where the `<`
 * that opened the list can reach it: as `(f < T) > (x)` directly, or as the
 * right half of the `|`, `&` or `,` that a union, intersection or second type
 * argument became - `(f < A) | (B > (x))`. A nested list closes on `>>` or
 * `>>>`, which bind tighter than `<` and so land as the right operand of the
 * `<` that opened the outer list: `(k < Foo) < (Bar >> (x))`.
 *
 * The context is what keeps this cheap. `a >> (b & c)` needs its parentheses
 * and is common in obfuscated arithmetic; without the parent rule it bought
 * a second, TypeScript parse of every such file. This is a gate on that
 * parse, not a verdict: the verdict is whether the TypeScript grammar reads
 * type arguments at all.
 */
function looksLikeTypeArguments(ast: t.File): boolean {
  let found = false;
  walk(ast.program, (node, parent) => {
    if (found || node.type !== 'BinaryExpression') return;
    const { operator, left, right } = node;
    if (operator === '>') {
      const closesList =
        (left.type === 'BinaryExpression' && left.operator === '<') ||
        parent?.type === 'BinaryExpression' ||
        parent?.type === 'SequenceExpression';
      if (!closesList) return;
    } else if (operator === '>>' || operator === '>>>') {
      if (parent?.type !== 'BinaryExpression' || parent.operator !== '<') return;
    } else {
      return;
    }
    if (right.type === 'TemplateLiteral' || startsParenthesised(right)) found = true;
  });
  return found;
}

/**
 * Whether the leftmost primary of `node` was written in parentheses - the
 * argument list of `f<T>(x).y`, `f<T>(x)(y)`, `f<T>(x) + 1`, all of which
 * the JavaScript reading hangs off that first parenthesised operand.
 */
function startsParenthesised(node: t.Node): boolean {
  let current: t.Node | undefined = node;
  while (current) {
    if (current.extra?.['parenthesized'] === true) return true;
    switch (current.type) {
      case 'CallExpression':
      case 'OptionalCallExpression':
        current = current.callee;
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        current = current.object;
        break;
      case 'TaggedTemplateExpression':
        current = current.tag;
        break;
      case 'BinaryExpression':
        current = current.left;
        break;
      default:
        return false;
    }
  }
  return false;
}

interface TypeArgumentSite {
  line: number;
  column: number;
  text: string;
}

/** The first call, `new` or tagged template that carries type arguments. */
function firstTypeArgumentSite(ast: t.File, code: string): TypeArgumentSite | undefined {
  let site: TypeArgumentSite | undefined;
  walk(ast.program, (node) => {
    if (site) return;
    if (
      node.type !== 'CallExpression' &&
      node.type !== 'OptionalCallExpression' &&
      node.type !== 'NewExpression' &&
      node.type !== 'TaggedTemplateExpression'
    ) {
      return;
    }
    const typed = node as { typeParameters?: unknown; typeArguments?: unknown };
    if (!typed.typeParameters && !typed.typeArguments) return;
    const start = node.loc?.start ?? { line: 0, column: 0 };
    site = { line: start.line, column: start.column, text: code.slice(node.start ?? 0, node.end ?? 0) };
  });
  return site;
}

/**
 * Visit every node under `root`, without recursion: a `+` chain a minifier
 * left behind nests one level per operand, and the parser's own frames were
 * already enough to exhaust the stack on such input.
 */
function walk(root: t.Node, visit: (node: t.Node, parent: t.Node | undefined) => void): void {
  const stack: Array<{ node: t.Node; parent: t.Node | undefined }> = [{ node: root, parent: undefined }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop() as { node: t.Node; parent: t.Node | undefined };
    visit(node, parent);
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (let i = child.length - 1; i >= 0; i--) {
          const item = child[i] as t.Node | null;
          if (item && typeof item.type === 'string') stack.push({ node: item, parent: node });
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push({ node: child as t.Node, parent: node });
      }
    }
  }
}

/**
 * Thrown by auto-detection when a JavaScript dialect and its TypeScript
 * counterpart both parse the input and disagree about what it means.
 *
 * The engine cannot prove which reading the author intended, and going with
 * either one silently rewrites the other into a different program - the
 * comparison `useState < number > 0` where a hook call was meant. The message
 * names the site and the option that settles it.
 */
export class AmbiguousDialectError extends Error {
  readonly untyped: 'js' | 'jsx';
  readonly typed: 'ts' | 'tsx';
  readonly loc: { line: number; column: number };

  constructor(code: string, untyped: 'js' | 'jsx', typed: 'ts' | 'tsx', site: TypeArgumentSite) {
    const excerpt = site.text.length > 60 ? `${site.text.slice(0, 57)}...` : site.text;
    super(
      `Input parses as both ${untyped} and ${typed}, and the two readings disagree: ` +
        `\`${excerpt}\` (line ${site.line}, column ${site.column + 1}) is a comparison chain in ` +
        `JavaScript and a call with type arguments in TypeScript. Auto-detection will not choose, ` +
        `because either choice rewrites the other program. Pass language: '${typed}' or '${untyped}' ` +
        `(or a filename with the matching extension) to say which it is.`,
    );
    this.name = 'AmbiguousDialectError';
    this.untyped = untyped;
    this.typed = typed;
    this.loc = { line: site.line, column: site.column };
    Object.defineProperty(this, 'excerpt', { value: code.slice(0, 200), enumerable: false });
  }
}

/**
 * Thrown when the input is not recoverable as any supported dialect.
 *
 * Reported as a distinct type rather than a raw parser exception so callers can
 * tell "this is not JavaScript" apart from "the engine has a bug", and so the
 * message can name every dialect that was attempted.
 *
 * A `RangeError` cause is neither of those and gets its own sentence. The parser
 * descends one frame per nesting level, so `var z = !!!...!!!x` with ten thousand
 * operators exhausts the stack in every dialect and arrives here looking exactly
 * like a file that is not JavaScript - which it is. Telling that user their input
 * is not code sends them hunting for corruption that is not there.
 */
export class ParseFailedError extends Error {
  readonly attempts: string[];

  constructor(code: string, attempts: string[], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const tried = `Tried: ${attempts.map((a) => a.split(':')[0]).join(', ')}.`;
    super(
      cause instanceof RangeError
        ? `Input nests too deeply for the parser to build a tree (${detail}). ` +
          `That is a stack limit rather than a syntax error, so the same input may ` +
          `parse in a process with more stack. ${tried}`
        : `Input could not be parsed as JavaScript, TypeScript or JSX (${detail}). ${tried}`,
    );
    this.name = 'ParseFailedError';
    this.attempts = attempts;
    this.cause = cause;
    // Keep a small excerpt for diagnostics without retaining a 4 MB string.
    Object.defineProperty(this, 'excerpt', { value: code.slice(0, 200), enumerable: false });
  }
}

function resolveSourceType(
  ast: t.File,
  requested: SourceType,
): Exclude<SourceType, 'unambiguous'> {
  if (requested !== 'unambiguous') return requested;
  return ast.program.sourceType === 'module' ? 'module' : 'script';
}
