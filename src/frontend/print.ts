import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import { VISITOR_KEYS } from '@babel/types';
import * as t from '@babel/types';
import type { OutputOptions, SourceMap, SourceType } from '../types.js';
import { parserOptionsFor, type ConcreteLanguage, type DecoratorSyntax } from './language.js';
import { isSemanticDirective } from '../passes/simplify/proxy-functions.js';

const generate = ((_generate as unknown as { default?: typeof _generate }).default ??
  _generate) as typeof _generate;

export interface PrintResult {
  code: string;
  map?: SourceMap;
  /** Anything the printer was asked to do and could not; the caller surfaces each as a diagnostic. */
  warnings: string[];
}

/**
 * What the printed text is for: the name the map records, the grammar the
 * output is known to be in, and a banner to place above it.
 */
export interface PrintTarget {
  filename?: string;
  language?: ConcreteLanguage;
  sourceType?: SourceType;
  decorators?: DecoratorSyntax;
  /** Comment text to prepend. The map is shifted past it, which is why it is printed here and not by the caller. */
  banner?: string;
}

/**
 * Thrown when the generator runs out of stack on a deeply nested tree.
 *
 * `@babel/generator` prints recursively, so a long `+` or `||` chain - which is
 * what `splitStrings` and every minifier produce - descends one frame per
 * operand. Past the host's limit that is a `RangeError` from inside
 * node_modules, thrown from outside every guard the pipeline has: the kernel's
 * promise that a failing pass cannot break the run stops at the pass boundary
 * and generation is after it. Named here so a caller can tell this apart from a
 * bug in the engine, and so the message says what to do about it.
 *
 * The threshold is the host's remaining stack rather than a property of the
 * input, so the same file can print in one process and fail in another.
 */
export class PrintFailedError extends Error {
  constructor(cause: unknown) {
    super(
      'Generated tree nests too deeply to print (Maximum call stack size exceeded). ' +
        'This is a stack limit rather than a defect in the tree: a long chain of `+` or ' +
        '`||` operands descends one generator frame per operand. Running the engine in a ' +
        'thread with more stack is the only workaround.',
    );
    this.name = 'PrintFailedError';
    this.cause = cause;
  }
}

/**
 * `//# sourceMappingURL=` and `//# sourceURL=`, in either comment form.
 *
 * A directive the input carried describes the input, and printing it under
 * the rewritten code points every consumer of the output - devtools, bundlers,
 * error reporters - at a map for a different program. The engine emits its own
 * map when asked and no directive otherwise, so these never survive, whatever
 * `output.comments` says.
 */
const SOURCE_MAP_DIRECTIVE = /^\s*[#@]\s*source(?:Mapping)?URL=/;

/**
 * Render the transformed AST.
 *
 * Passing the original `source` to the generator is what lets Babel emit
 * accurate mappings back to the obfuscated input. A source map is only
 * meaningful because every pass preserves node `loc` information rather than
 * rebuilding nodes from scratch.
 */
export function printAst(
  ast: t.File,
  source: string,
  output: Required<OutputOptions>,
  target: PrintTarget = {},
): PrintResult {
  const filename = target.filename ?? 'input.js';
  const wantMap = output.sourceMaps !== false;
  const warnings: string[] = [];

  if (output.quotes !== 'preserve') requoteLiterals(ast, output.quotes === 'double' ? '"' : "'");
  keepLooseStringsLoose(ast);

  const result = ((): ReturnType<typeof generate> => {
    try {
      return generate(
        ast,
        {
          comments: output.comments,
          shouldPrintComment: (value) =>
            !SOURCE_MAP_DIRECTIVE.test(value) &&
            (output.comments || value.includes('@license') || value.includes('@preserve')),
          // `'auto'` is not an option: the generator resolves it from the length
          // of a *string* passed as the source, and the source arrives as a map.
          compact: !output.format,
          concise: false,
          retainLines: false,
          jsescOption: { minimal: true, quotes: output.quotes === 'double' ? 'double' : 'single' },
          sourceMaps: wantMap,
          sourceFileName: filename,
          filename,
        },
        // The generator needs the original source to resolve mappings back to it.
        wantMap ? { [filename]: source } : undefined,
      );
    } catch (error) {
      if (error instanceof RangeError) throw new PrintFailedError(error);
      throw error;
    }
  })();

  const map = result.map as SourceMap | undefined;

  let code = result.code;
  if (output.format && output.indent !== 2) {
    const protectedLines = literalLineStarts(code, target);
    if (protectedLines) {
      const reindented = reindent(code, output.indent, protectedLines);
      code = reindented.code;
      // Every column the generator recorded was measured against its own
      // two-space output. Re-indenting moves them, so the mappings have to move
      // with the text or the map points into the middle of tokens.
      if (map && reindented.shifted) shiftGeneratedColumns(map, reindented.deltas);
    } else {
      warnings.push(
        `output.indent ${output.indent} was not applied: the generated code could not be ` +
          'tokenised, so the lines that continue a string or template literal cannot be told ' +
          'from code. The output keeps the generator’s two-space indentation.',
      );
    }
  }

  if (map) {
    map.sourcesContent = [source];
    map.file = filename;
  }

  if (target.banner) {
    const placed = prependBanner(code, target.banner);
    code = placed.code;
    // Each `;` in `mappings` is one generated line. Inserting empty lines
    // where the banner went keeps every mapping on the line it describes.
    if (map) {
      const lines = map.mappings.split(';');
      lines.splice(placed.afterLine, 0, ...new Array<string>(placed.lines).fill(''));
      map.mappings = lines.join(';');
    }
  }

  if (output.sourceMaps === 'inline' && map) {
    // Assembled rather than written literally: a contiguous `//# sourceMappingURL=`
    // in this file makes bundlers and test runners treat *this module* as having
    // an inline source map and try to resolve it.
    const directive = `//# source${'MappingURL'}=`;
    code += `\n${directive}data:application/json;charset=utf-8;base64,${base64(JSON.stringify(map))}\n`;
  }

  return { code, map: output.sourceMaps === true ? map : undefined, warnings };
}

/**
 * Place the banner above the code - or below the shebang, which has to stay
 * on line one to mean anything.
 */
function prependBanner(code: string, banner: string): { code: string; afterLine: number; lines: number } {
  const lines = banner.split('\n').length;
  if (code.startsWith('#!')) {
    const end = code.indexOf('\n');
    const shebang = end === -1 ? code : code.slice(0, end);
    const rest = end === -1 ? '' : code.slice(end + 1);
    return { code: `${shebang}\n${banner}\n${rest}`, afterLine: 1, lines };
  }
  return { code: `${banner}\n${code}`, afterLine: 0, lines };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Make every string literal use the configured quote character.
 *
 * The generator prints a literal's `extra.raw` verbatim whenever it is present,
 * and it is present on every literal that arrived from the input, so
 * `jsescOption.quotes` on its own only reached the literals a pass had
 * synthesised - `quotes: 'double'` produced `["Hello", ", ", '!']`. That is
 * what `'preserve'` now names, and it is the default; an explicit `'single'`
 * or `'double'` comes here. Rewriting the raw text swaps the delimiters and
 * re-escapes the one character that needs it; every other escape sequence is
 * copied as written, because normalising escapes is `literalSimplification`'s
 * job and can be turned off.
 *
 * Two literal positions are left alone. A JSX attribute value has no escape
 * sequences at all, so its delimiter cannot be swapped when the text holds
 * the other quote, and `finalize.jsx` already chose its quoting. A directive
 * is its raw text - `'use strict'` spelled with different characters is not
 * a directive - and it is a different node type, so it is not visited here.
 */
function requoteLiterals(ast: t.File, quote: '"' | "'"): void {
  const stack: Array<{ node: t.Node; parent: t.Node | undefined }> = [{ node: ast.program, parent: undefined }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop() as { node: t.Node; parent: t.Node | undefined };
    if (node.type === 'StringLiteral') {
      if (parent?.type === 'JSXAttribute') continue;
      const extra = node.extra;
      const raw = extra?.['raw'];
      if (typeof raw === 'string' && raw.length >= 2 && raw[0] !== quote && extra?.['rawValue'] === node.value) {
        extra['raw'] = requote(raw, quote);
      }
      continue;
    }
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child as Array<t.Node | null>) {
          if (item && typeof item.type === 'string') stack.push({ node: item, parent: node });
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push({ node: child as t.Node, parent: node });
      }
    }
  }
}

/** `'it\'s'` → `"it's"`, `"say \"hi\""` → `'say "hi"'`; every other escape stays as written. */
function requote(raw: string, quote: '"' | "'"): string {
  const current = raw[0] as string;
  const inner = raw.slice(1, -1);
  let out = quote;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch === '\\') {
      const next = inner[i + 1] ?? '';
      // `\'` inside `"..."` no longer needs its escape; anything else is copied
      // as the pair it is, including a line continuation.
      out += next === current ? current : ch + next;
      i++;
    } else if (ch === quote) {
      out += `\\${quote}`;
    } else {
      out += ch;
    }
  }
  return out + quote;
}

// ---------------------------------------------------------------------------
// Indentation
// ---------------------------------------------------------------------------

interface Reindented {
  code: string;
  /** Column delta applied to each output line, indexed by zero-based line. */
  deltas: number[];
  /** False when nothing moved, so the source map can be left untouched. */
  shifted: boolean;
}

/**
 * Re-space the generator's two-space indentation to the requested width.
 *
 * The naive version of this - a `/^( +)/gm` replace over the whole file - is
 * silently destructive, because *not every line of output is code*. A template
 * literal and a backslash-continued string are both printed with their raw text
 * intact, newlines and all, so their continuation lines start with leading
 * whitespace that is **string content**. Rewriting it changes what the program
 * computes:
 *
 * ```js
 * var s = `alpha
 *     beta`;          // <- those four spaces are part of the value
 * ```
 *
 * So the lines are classified before they are touched. {@link literalLineStarts}
 * answers the only question that matters - is this line the continuation of a
 * literal the generator printed verbatim? - and those lines are left exactly as
 * they arrived.
 */
function reindent(code: string, indent: number, protectedLines: ReadonlySet<number>): Reindented {
  const unit = ' '.repeat(indent);
  const lines = code.split('\n');
  const deltas = new Array<number>(lines.length).fill(0);
  let shifted = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (protectedLines.has(index)) continue;
    const spaces = line.length - line.replace(/^ +/, '').length;
    if (spaces === 0) continue;
    const replacement = unit.repeat(Math.round(spaces / 2));
    if (replacement.length === spaces) continue;
    lines[index] = replacement + line.slice(spaces);
    deltas[index] = replacement.length - spaces;
    shifted = true;
  }

  return { code: lines.join('\n'), deltas, shifted };
}

/**
 * Zero-based indices of the output lines that begin *inside* a literal, or
 * `undefined` when the output cannot be tokenised.
 *
 * The classification comes from the language's own lexer - the parser, with
 * `tokens: true` - rather than from a hand-written scan of the text. A scan
 * has to re-derive every tokenisation rule the output can exercise, and each
 * one it gets wrong desynchronises it for the rest of the file: `</b>` read as
 * the start of a regex, or `https://` in JSX text read as a line comment, each
 * swallowed the backtick that opened the next template literal, and from then
 * on every literal boundary was inverted. The lexer knows what a JSX closing
 * tag is. The output is the engine's own, so it is expected to tokenise; a
 * file that does not is reported and left at the generator's width rather than
 * guessed at.
 *
 * Only a template chunk or a string with a line continuation can carry a
 * newline whose following whitespace is content. A block comment's
 * continuation lines are layout - the generator re-indents them itself - and
 * JSX text trims the leading whitespace of every line, so both are left to the
 * ordinary rule.
 */
function literalLineStarts(code: string, target: PrintTarget): Set<number> | undefined {
  let tokens: unknown[] | undefined;
  try {
    tokens = parse(
      code,
      parserOptionsFor(
        target.language ?? 'tsx',
        target.sourceType ?? 'unambiguous',
        { tokens: true, errorRecovery: true },
        target.decorators,
      ),
    ).tokens as unknown[] | undefined;
  } catch {
    return undefined;
  }
  if (!tokens) return undefined;

  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const starts = new Set<number>();
  for (const token of tokens as Array<{ type: unknown; start: number; end: number }>) {
    const label = typeof token.type === 'object' && token.type ? (token.type as { label?: string }).label : undefined;
    if (label !== 'template' && label !== 'string') continue;
    // Offsets, not `loc`: the tokenizer does not advance its line counter for
    // a backslash-newline inside a string, so the token's `loc` says one line.
    const first = lineOf(token.start);
    const last = lineOf(token.end);
    for (let line = first + 1; line <= last; line++) starts.add(line);
  }
  return starts;
}

/**
 * Move every generated column in the map by its line's re-indent delta.
 *
 * Only leading whitespace moved, so a mapping shifts by exactly its line's
 * delta; one that pointed inside the old indentation is clamped to zero rather
 * than allowed to go negative.
 */
function shiftGeneratedColumns(map: SourceMap, deltas: readonly number[]): void {
  const lines = map.mappings.split(';');
  let changed = false;

  for (let line = 0; line < lines.length; line++) {
    const delta = deltas[line] ?? 0;
    const raw = lines[line] as string;
    if (delta === 0 || raw.length === 0) continue;

    const segments = raw.split(',');
    const columns: number[] = [];
    const tails: string[] = [];
    let column = 0;
    let malformed = false;
    for (const segment of segments) {
      const fields = decodeVlq(segment);
      if (!fields || fields.length === 0) { malformed = true; break; }
      column += fields[0] as number;
      columns.push(column);
      tails.push(segment.slice(vlqLength(fields[0] as number)));
    }
    if (malformed) continue;

    let previous = 0;
    const rebuilt: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const shifted = Math.max(0, (columns[i] as number) + delta);
      rebuilt.push(encodeVlq(shifted - previous) + (tails[i] as string));
      previous = shifted;
    }
    lines[line] = rebuilt.join(',');
    changed = true;
  }

  if (changed) map.mappings = lines.join(';');
}

const VLQ_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeVlq(segment: string): number[] | undefined {
  const values: number[] = [];
  let shift = 0;
  let accumulator = 0;
  for (const char of segment) {
    const digit = VLQ_ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    accumulator += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const negative = accumulator & 1;
    accumulator >>= 1;
    values.push(negative ? -accumulator : accumulator);
    shift = 0;
    accumulator = 0;
  }
  return shift === 0 ? values : undefined;
}

function encodeVlq(value: number): string {
  let bits = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = bits & 31;
    bits >>>= 5;
    if (bits > 0) digit |= 32;
    out += VLQ_ALPHABET[digit];
  } while (bits > 0);
  return out;
}

/** Characters `encodeVlq` would use for this value - how much of a segment it owns. */
function vlqLength(value: number): number {
  return encodeVlq(value).length;
}

function base64(input: string): string {
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(input)));
  }
  // Node path: Buffer is present, but avoid a static import so browser bundles
  // never pull in a polyfill for it.
  const BufferCtor = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } })
    .Buffer;
  if (!BufferCtor) throw new Error('No base64 encoder available in this environment');
  return BufferCtor.from(input, 'utf-8').toString('base64');
}

/**
 * A string statement the parser did not read as a directive prints as one
 * when nothing stands between it and the head of its body, and the output
 * then re-parses with `"use strict"` in force where the input had a no-op.
 * Any pass that removes or expands the statement ahead of it - a dead
 * expression, a comma sequence, an unused declaration, a dead branch -
 * leaves the string in that position, so a body whose first statement is a
 * string that would mean something as a directive prints it in parentheses:
 * `("use strict");` is the statement the input had. Any other string is a
 * no-op in either position. A directive the input carried is in the body's
 * `directives`, not its statements, and prints as it was.
 */
function keepLooseStringsLoose(ast: t.File): void {
  const guard = (body: t.Statement[]): void => {
    const first = body[0];
    if (!t.isExpressionStatement(first) || !t.isStringLiteral(first.expression)) return;
    // The prologue runs to the first statement that is not a bare string, so
    // every string of the run would be read as a directive; the parentheses
    // on the first end the run before any of them.
    let semantic = false;
    for (const statement of body) {
      if (!t.isExpressionStatement(statement) || !t.isStringLiteral(statement.expression)) break;
      if (isSemanticDirective(statement.expression.value)) semantic = true;
    }
    if (!semantic) return;
    first.expression = t.parenthesizedExpression(first.expression);
  };
  guard(ast.program.body);
  const stack: t.Node[] = [ast.program];
  while (stack.length > 0) {
    const node = stack.pop() as t.Node;
    if (t.isFunction(node) && t.isBlockStatement(node.body)) guard(node.body.body);
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child as Array<t.Node | null>) if (item && typeof item.type === 'string') stack.push(item);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
}
