import type { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';

/** Node count via a plain structural walk; ~5x faster than a Babel traversal. */
export function countNodes(node: t.Node): number {
  let count = 0;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object' || typeof (current as t.Node).type !== 'string') {
      continue;
    }
    count++;
    for (const key of t.VISITOR_KEYS[(current as t.Node).type] ?? []) {
      const child = (current as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return count;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

/**
 * UTF-8 byte length.
 *
 * `String.length` counts UTF-16 code units, which is the same number only for
 * ASCII. Decoded string tables routinely are not ASCII, so a stat reported as
 * bytes has to be counted as bytes - a file whose decoded literals hold emoji
 * under-reports its own size otherwise. Counted rather than measured through
 * `TextEncoder` so a multi-megabyte program is not copied to learn its length.
 */
export function countUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        // A surrogate pair is one code point in four bytes.
        bytes += 4;
        i++;
      } else {
        // Unpaired: encoders substitute U+FFFD, which is three bytes.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const HEX_IDENTIFIER = /^_0x[0-9a-f]{4,8}(_\d+)?$/i;
const MANGLED_IDENTIFIER = /^[_$]?[a-z]{1,2}\d{0,3}$/;

// ---------------------------------------------------------------------------
// Generated-name recognition
// ---------------------------------------------------------------------------

/*
 * `_0x4d28ce` is one obfuscator's house style, not the shape of generated names
 * in general. Commercial protectors emit names drawn uniformly from
 * `[A-Za-z0-9]` - `FCB7VNAT`, `woq4lLvw`, `OPgjD2gE` - which no lexical rule
 * keyed on a prefix will ever see.
 *
 * What separates those from names a person writes is not the alphabet, it is
 * the *statistics*: English identifiers are made of pronounceable words, so
 * roughly a third of their letters are vowels and case changes only happen at
 * word boundaries. A random alphanumeric draw has ~19% vowels and flips case on
 * every other letter. Scoring those two ratios, plus the digit placements that
 * only a generator produces, separates the two populations cleanly - measured
 * over 32k identifiers from hand-written sources it produced no false
 * positives, which is the direction that matters: renaming `getMsg` to `str1`
 * makes the output worse than leaving `woq4lLvw` alone.
 */

/** Generated names carry no separator; `_` or `$` is a signal a human named it. */
const ALPHANUMERIC_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const LOWER_WORD = /^[a-z][a-z0-9]*$/;
const CAPITAL_WORD = /^[A-Z][a-z][a-z0-9]*$/;
const UPPER_WORD = /^[A-Z][A-Z0-9]*$/;

/**
 * A digit *inside* a word rather than at the end of one.
 *
 * The case on each side is what separates the two. `md5Hash`, `utf8Decode` and
 * `int32Array` put their digits where a camelCase word ends, so the letter
 * after is a capital; `Vt7nCb` and `FCB7VNAT` interrupt a run of one case.
 */
const DIGIT_INSIDE_WORD = /[a-z][0-9]+[a-z]|[A-Z][0-9]+[A-Z]/;
const DIGIT_THEN_LOWER = /[0-9][a-z]/;
/** `SHA256`/`UTF8` end their digits; only a generator writes `FCB7VNAT`. */
const DIGIT_BETWEEN_CAPS = /[A-Z][0-9]+[A-Z]/;

const VOWEL = /[aeiouAEIOU]/;
const LETTER = /[A-Za-z]/;

const GENERATED_MIN_LENGTH = 5;
const GENERATED_MAX_LENGTH = 20;
/** Two independent markers, or one marker at full strength, before a name counts. */
const GENERATED_THRESHOLD = 4;

interface NameShape {
  /** Vowels as a fraction of letters: ~0.35 for English, ~0.19 for a random draw. */
  vowelRatio: number;
  /** Case flips as a fraction of adjacent letter pairs: ~0.15 camelCase, ~0.5 random. */
  alternationRatio: number;
}

function nameShape(name: string): NameShape {
  let letters = 0;
  let vowels = 0;
  let alternations = 0;
  let pairs = 0;
  let previous = '';
  for (const character of name) {
    if (!LETTER.test(character)) continue;
    letters++;
    if (VOWEL.test(character)) vowels++;
    if (previous !== '') {
      pairs++;
      const wasUpper = previous === previous.toUpperCase();
      const isUpper = character === character.toUpperCase();
      if (wasUpper !== isUpper) alternations++;
    }
    previous = character;
  }
  return {
    vowelRatio: letters === 0 ? 0 : vowels / letters,
    alternationRatio: pairs === 0 ? 0 : alternations / pairs,
  };
}

/**
 * How strongly a name looks drawn from a generator rather than written.
 *
 * Single words are excluded outright, in every casing a person uses: `handler`,
 * `Handler` and `SHA256` all leave with a score of zero however unusual their
 * letters are. Only names that are already unconventional get measured.
 */
function generatedScore(name: string): number {
  if (!ALPHANUMERIC_NAME.test(name)) return 0;
  if (name.length < GENERATED_MIN_LENGTH || name.length > GENERATED_MAX_LENGTH) return 0;
  if (LOWER_WORD.test(name) || CAPITAL_WORD.test(name)) return 0;
  const allCaps = UPPER_WORD.test(name);
  // `IPV4ADDRESS` and `LOG10E` are real constants, so an all-caps name is only
  // reconsidered when a digit sits *between* capitals; the vowel test below is
  // what then keeps those two out and lets `FCB7VNAT` through.
  if (allCaps && !DIGIT_BETWEEN_CAPS.test(name)) return 0;

  const { vowelRatio, alternationRatio } = nameShape(name);
  let score = 0;
  if (vowelRatio <= 0.18) score += 2;
  else if (vowelRatio <= 0.3) score += 1;
  if (alternationRatio >= 0.55) score += 2;
  else if (alternationRatio >= 0.34) score += 1;
  if (DIGIT_THEN_LOWER.test(name)) score += 2;
  else if (DIGIT_INSIDE_WORD.test(name)) score += 1;
  // Only for a name that is *entirely* capitals and digits, where there is no
  // camelCase boundary the digit could be marking: `MD5ToHex` keeps its point,
  // `FCB7VNAT` gets a second one.
  if (allCaps) score += 1;
  return score;
}

// ---------------------------------------------------------------------------
// Per-program naming scheme
// ---------------------------------------------------------------------------

/**
 * The naming conventions one particular file's generator used.
 *
 * Prefixes are discovered from the population rather than hardcoded: a
 * protector that stamps `__gwp_` onto ninety helpers is recognised by the fact
 * that ninety bindings share a short tag followed by noise, which is evidence
 * no single name carries on its own. That is deliberately how `__webpack_` and
 * a `test_`-prefixed suite avoid being swept up - see `detectNameScheme`.
 */
export interface NameScheme {
  /** Prefixes, including their trailing separator, e.g. `__gwp_`. */
  readonly prefixes: readonly string[];
}

export const EMPTY_NAME_SCHEME: NameScheme = { prefixes: [] };

/** Longest prefix treated as a generator's tag rather than a word. */
const MAX_PREFIX_LENGTH = 8;
const MAX_PREFIX_ALPHANUMERICS = 6;
const MIN_PREFIX_BINDINGS = 8;
const MIN_OPAQUE_SHARE = 0.7;
const MIN_SUFFIX_LENGTH = 3;

/** A token with English-like vowel density and no mid-word digits. */
function isPronounceable(token: string): boolean {
  if (token.length === 0) return false;
  if (/[A-Za-z][0-9]+[A-Za-z]/.test(token)) return false;
  const { vowelRatio, alternationRatio } = nameShape(token);
  return vowelRatio >= 0.3 && alternationRatio <= 0.25;
}

interface PrefixSplit {
  prefix: string;
  suffix: string;
}

/** Split `__gwp_0AKIU` into its tag and the noise after it, if it has that shape. */
function splitPrefix(name: string): PrefixSplit | undefined {
  let cut = -1;
  const limit = Math.min(name.length, MAX_PREFIX_LENGTH);
  for (let index = 0; index < limit; index++) {
    const character = name[index];
    if (character === '_' || character === '$') cut = index;
  }
  if (cut < 0) return undefined;
  const prefix = name.slice(0, cut + 1);
  const suffix = name.slice(cut + 1);
  if (suffix.length < MIN_SUFFIX_LENGTH) return undefined;
  let alphanumerics = 0;
  for (const character of prefix) if (/[A-Za-z0-9]/.test(character)) alphanumerics++;
  // `_` and `__` alone are a style, not a tag; `__webpack_` is a word, not a tag.
  if (alphanumerics < 1 || alphanumerics > MAX_PREFIX_ALPHANUMERICS) return undefined;
  return { prefix, suffix };
}

/**
 * Learn the generated-name conventions of one program from its binding names.
 *
 * A prefix qualifies only when many bindings share it *and* what follows it is
 * overwhelmingly unpronounceable. Both conditions are load-bearing:
 * `__webpack_require__` fails the first (a bundle has a handful of them, and
 * the tag is too long to be a tag), and a `test_`-prefixed test suite fails the
 * second, because `test_alpha` continues into a word.
 */
export function detectNameScheme(names: Iterable<string>): NameScheme {
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const split = splitPrefix(name);
    if (!split) continue;
    const bucket = groups.get(split.prefix);
    if (bucket) bucket.push(split.suffix);
    else groups.set(split.prefix, [split.suffix]);
  }

  const prefixes: string[] = [];
  for (const [prefix, suffixes] of groups) {
    if (suffixes.length < MIN_PREFIX_BINDINGS) continue;
    let opaque = 0;
    for (const suffix of suffixes) if (!isPronounceable(suffix)) opaque++;
    if (opaque / suffixes.length < MIN_OPAQUE_SHARE) continue;
    prefixes.push(prefix);
  }
  // Sorted so the scheme, and everything derived from it, is reproducible.
  prefixes.sort();
  return { prefixes };
}

/**
 * The statistical half of `isObfuscatedName`, on its own.
 *
 * Exposed because the naming layer needs to refuse to *emit* such a name, and
 * there it must not also refuse `i`, `fn1` or `arg2` - names the layer produces
 * on purpose, and which the short-mangled rule would otherwise veto.
 */
export function looksGeneratedName(name: string): boolean {
  return generatedScore(name) >= GENERATED_THRESHOLD;
}

/** Names an obfuscator generated, which are the ones worth replacing. */
export function isObfuscatedName(name: string, scheme?: NameScheme): boolean {
  if (HEX_IDENTIFIER.test(name) || MANGLED_IDENTIFIER.test(name)) return true;
  if (scheme) {
    for (const prefix of scheme.prefixes) {
      if (name.length > prefix.length && name.startsWith(prefix)) return true;
    }
  }
  return looksGeneratedName(name);
}

/** Names a human would plausibly have written, left alone by default. */
export function isReadableName(name: string, scheme?: NameScheme): boolean {
  if (isObfuscatedName(name, scheme)) return false;
  return name.length >= 3 && /[a-z]/i.test(name);
}

/**
 * Keys that are safe to write with dot notation.
 *
 * Reserved words are deliberately allowed: `obj.default` and `obj.class` are
 * legal member expressions in ES5 and later, so every supported environment
 * accepts them. What is *not* safe is a key that is not an identifier at all.
 */
export function isSafeDotKey(key: string): boolean {
  return t.isValidIdentifier(key, false);
}

/**
 * The operand under any TypeScript or Flow wrapper that erases at run time:
 * `x as T`, `x!`, `<T>x`, `x satisfies T`, `f<T>`, `(x: T)`.
 *
 * A shape test that asks "is this a `shift` call" of `a.shift() as string` is
 * asking it of the wrapper, and the answer is no - which is a wrong table
 * rather than a refusal wherever the test guards a decoding. Every recogniser
 * that keys on a call or member shape must look through these first.
 */
export function stripTypeWrappers(node: t.Node): t.Node {
  let current = node;
  for (;;) {
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TSSatisfiesExpression':
      case 'TSInstantiationExpression':
      case 'TypeCastExpression':
        current = current.expression;
        continue;
      default:
        return current;
    }
  }
}

/**
 * The value of an untagged template that has no substitutions, e.g. `` `foo` ``.
 *
 * `cooked` is `undefined` for exactly one reason: the literal carries an escape
 * JavaScript cannot decode (`` `\unicode` ``), which is a SyntaxError outside a
 * *tagged* template and inside one means the tag is handed the raw text and no
 * cooked value exists at all. Falling back to `raw` would resolve such a
 * literal to its own source spelling - a string the program never produces.
 * There is no right answer to substitute there, so it refuses.
 *
 * Being tagged is not visible from the node: `` tag`x` `` is a
 * `TaggedTemplateExpression` whose `quasi` is this node, so a caller that walks
 * to a `TemplateLiteral` from its parent must check the parent itself. See
 * {@link isTaggedQuasi}.
 */
export function plainTemplateValue(node: t.Node | null | undefined): string | undefined {
  if (!t.isTemplateLiteral(node)) return undefined;
  if (node.expressions.length > 0 || node.quasis.length !== 1) return undefined;
  return node.quasis[0]!.value.cooked;
}

/**
 * Whether this template literal is the operand of a tag, where its *raw* text
 * and its per-element structure are both observable and it is not a string.
 */
export function isTaggedQuasi(path: NodePath): boolean {
  const parent = path.parentPath;
  return Boolean(parent?.isTaggedTemplateExpression() && parent.node.quasi === path.node);
}

/** Statically resolve a node to a string, if it is unambiguously one. */
export function staticString(node: t.Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  return plainTemplateValue(node);
}

/**
 * Ceiling on the `split` spelling of a table, and on that spelling only.
 *
 * The cap stops `'...'.split(';')` over a megabyte of text from materialising
 * hundreds of thousands of entries during a *candidate scan* that runs on
 * every fixpoint round and again per peeled layer. An array literal needs no
 * such guard - the parse already built every element, and reading them is one
 * walk over nodes that exist either way - and applied there it left a
 * 65,537-entry table encoded with nothing in the run saying so. The 4 MB
 * fixture's table has 29,649 entries; a build twice that size crosses this.
 */
export const MAX_STRING_TABLE_ENTRIES = 65_536;

/**
 * The entries of a statically known table of strings, in either spelling.
 *
 * obfuscator.io emits `['a', 'b', ...]`, and the Cloudflare post-pass that runs on
 * top of it rewrites that to ``  `a;b;...`.split(`;`) `` - one template literal and
 * a `split`, which no recogniser keyed on `ArrayExpression` can see. The two are
 * the same table, so every recogniser that reads one should read the other, and
 * this is the single place that decides what "the same table" means.
 *
 * `split` is safe to evaluate here because the receiver is proven to be a string
 * *literal*: the method is `String.prototype.split` and its result is decided
 * entirely by two constants in the source. A separator that is not a non-empty
 * string is refused - `split()` with no argument yields the whole string, a
 * RegExp separator is not statically decidable, and an empty separator turns any
 * literal at all into a "table" of its own characters.
 */
export function staticStringTable(node: t.Node | null | undefined): string[] | undefined {
  if (!node) return undefined;

  if (t.isArrayExpression(node)) {
    if (node.elements.length === 0) return undefined;
    const values: string[] = [];
    for (const element of node.elements) {
      // A hole (`[,'a']`) is `undefined`, not a string, and a spread is unknown.
      const value = staticString(element);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }

  const spelling = splitSpelling(node);
  if (!spelling) return undefined;
  const { subject, separator } = spelling;
  if (countEntries(subject, separator) > MAX_STRING_TABLE_ENTRIES) return undefined;
  return subject.split(separator);
}

/**
 * The entry count of a `split` table the cap above refused, so the caller can
 * say the table was skipped rather than leave it looking like no table at all;
 * `undefined` for anything `staticStringTable` would read or reject on shape.
 */
export function oversizeStringTable(node: t.Node): number | undefined {
  const spelling = splitSpelling(node);
  if (!spelling) return undefined;
  const entries = countEntries(spelling.subject, spelling.separator);
  return entries > MAX_STRING_TABLE_ENTRIES ? entries : undefined;
}

/** The two literals of `'a;b'.split(';')`, when both are readable and the separator is non-empty. */
function splitSpelling(node: t.Node): { subject: string; separator: string } | undefined {
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const callee = node.callee;
  if (!t.isMemberExpression(callee)) return undefined;
  const method = callee.computed
    ? staticString(callee.property)
    : t.isIdentifier(callee.property)
      ? callee.property.name
      : undefined;
  if (method !== 'split') return undefined;

  const subject = staticString(callee.object);
  if (subject === undefined) return undefined;
  const separator = staticString(node.arguments[0]);
  if (separator === undefined || separator.length === 0) return undefined;
  return { subject, separator };
}

/** How many entries `subject.split(separator)` would have, without building them. */
function countEntries(subject: string, separator: string): number {
  let count = 1;
  for (let at = subject.indexOf(separator); at !== -1; at = subject.indexOf(separator, at + separator.length)) {
    count++;
  }
  return count;
}

/** Statically resolve a node to a number, including the `-1` unary form. */
export function staticNumber(node: t.Node | null | undefined): number | undefined {
  if (!node) return undefined;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && node.argument && t.isNumericLiteral(node.argument)) {
    if (node.operator === '-') return -node.argument.value;
    if (node.operator === '+') return node.argument.value;
  }
  return undefined;
}

/**
 * A call's arguments as the tuple a decoder is asked with, or `undefined`
 * when any argument is not a literal. Refusing here rather than guessing is
 * the difference between a call site left readable-but-encoded and a call
 * site rewritten to the wrong string.
 */
export function staticArguments(args: readonly t.Node[]): (string | number)[] | undefined {
  const tuple: (string | number)[] = [];
  for (const argument of args) {
    const numeric = staticNumber(argument);
    if (numeric !== undefined) {
      tuple.push(numeric);
      continue;
    }
    const text = staticString(argument);
    if (text === undefined) return undefined;
    tuple.push(text);
  }
  return tuple;
}

/**
 * {@link staticArguments} for a call site with its scope: an identifier
 * argument counts when the name provably holds one literal there.
 */
export function staticArgumentsAt(
  call: NodePath<t.CallExpression>,
  strings?: NameAddressing,
  order?: TreeOrder,
): (string | number)[] | undefined {
  const tuple: (string | number)[] = [];
  const args = call.get('arguments');
  for (const argument of args) {
    let value: string | number | undefined = staticNumber(argument.node) ?? staticString(argument.node);
    if (value === undefined && argument.isIdentifier()) {
      value = literalHeldAt(argument, strings, order);
    }
    if (value === undefined) return undefined;
    tuple.push(value);
  }
  return tuple;
}

/**
 * The literal a name holds at a read, or `undefined`.
 *
 * Two spellings hold one value for the whole of a binding's life. A literal
 * initialiser never assigned to - `const y = 0xd3` - placed as
 * {@link holdsDeclaredValue} places it. And a declaration with no
 * initialiser given its single write as a statement of its own, `let x; x =
 * 0xd6;`, where the read sits later in the same statement list, outside any
 * function of its own: the list runs in order, no jump inside a list can
 * skip a statement and land on a later one, and the one write is the only
 * value the name ever takes. A read under a nested function, in another
 * list, or ahead of the write is left as written, since `console[b(x)]` in
 * a loop body may run before the `x = ...` that follows it. A name code
 * compiled from a string can spell is refused outright: that write is in
 * no list.
 */
export function literalHeldAt(
  read: NodePath<t.Identifier>,
  strings?: NameAddressing,
  order?: TreeOrder,
): string | number | undefined {
  const name = read.node.name;
  const scope = read.scope;
  const binding = scope.getBinding(name);
  if (!binding) return undefined;
  if (binding.kind !== 'var' && binding.kind !== 'let' && binding.kind !== 'const') return undefined;
  if (strings?.addressesName(name, binding.scope)) return undefined;
  const declarator = binding.path;
  if (!declarator.isVariableDeclarator() || !t.isIdentifier(declarator.node.id)) return undefined;

  const init = declarator.node.init;
  if (init) {
    if (binding.constantViolations.length > 0) return undefined;
    const value = staticNumber(init) ?? staticString(init);
    if (value === undefined) return undefined;
    return holdsDeclaredValue(name, read.node, scope, strings, order) ? value : undefined;
  }

  if (binding.constantViolations.length !== 1) return undefined;
  const write = binding.constantViolations[0]!;
  if (!write.isAssignmentExpression() || write.node.operator !== '=') return undefined;
  if (!t.isIdentifier(write.node.left, { name })) return undefined;
  const value = staticNumber(write.node.right) ?? staticString(write.node.right);
  if (value === undefined) return undefined;
  const statement = write.parentPath;
  if (!statement.isExpressionStatement()) return undefined;
  if (!Array.isArray(statement.container) || typeof statement.key !== 'number') return undefined;

  // The read's own statement in that list, reached without crossing a
  // function boundary.
  let current: NodePath | null = read;
  for (let depth = 0; current && depth < 64; depth++) {
    if (current.isFunction()) return undefined;
    if (current.parentPath === statement.parentPath && current.container === statement.container) {
      return typeof current.key === 'number' && current.key > statement.key ? value : undefined;
    }
    current = current.parentPath;
  }
  return undefined;
}

/** Depth cap on the climb out of a destructuring pattern. Real ones are shallow. */
const MAX_PATTERN_DEPTH = 32;

/**
 * The three things {@link isPureContext} needs of a position: the node, the node
 * above it, and the link one step further up.
 *
 * `NodePath` satisfies this structurally, so a caller holding one passes it
 * straight in. It is named because one caller has no NodePaths to offer:
 * `structure/register-vm.ts` has to read the register file off the tree as it
 * stands - by the time `structure` runs, four passes have rewritten these
 * statements and Babel's cached paths lag behind every one of them - and so it
 * threads parents through its own walk. Sharing the *question* rather than
 * re-deriving the list of write positions is the point: the list is why
 * `resolveFrozenTable` refuses table mutation through `delete`, a destructuring
 * target and a for-in/of head, and a second copy of it would be a second copy to
 * keep correct.
 */
export interface Ancestry {
  readonly node: t.Node;
  readonly parent: t.Node | null | undefined;
  readonly parentPath: Ancestry | null | undefined;
}

/**
 * True when replacing this path with a pure value cannot change behaviour.
 * Conservative on purpose: it returns false whenever it is unsure.
 *
 * Assignment targets are not only the obvious `x = ...` and `x++`. A
 * *destructuring* pattern reaches its targets through `ArrayPattern`,
 * `ObjectPattern`, `RestElement` and `AssignmentPattern` nodes, so in
 * `[A[0]] = ['z']` the member expression's own parent is an `ArrayPattern` and
 * nothing about it looks like a write. Treating that as a read is doubly wrong:
 * the value is stale, and substituting a literal produces `['a'] = ['z']`,
 * which is not parseable JavaScript. So the climb walks out of any enclosing
 * pattern and re-asks the question at the position the pattern itself occupies.
 *
 * A position with no parent at all is pure. For a `NodePath` that is the root of
 * the file; for a caller that threads its own ancestry it is the root of
 * whatever subtree it handed in, so such a caller must hand in a subtree wide
 * enough to contain the write it is asking about.
 */
export function isPureContext(path: Ancestry): boolean {
  let current: Ancestry = path;
  for (let depth = 0; depth < MAX_PATTERN_DEPTH; depth++) {
    const parent = current.parent;
    if (!parent) return true;
    if (t.isAssignmentExpression(parent) && parent.left === current.node) return false;
    if (t.isUpdateExpression(parent)) return false;
    if (t.isUnaryExpression(parent) && parent.operator === 'delete') return false;
    if (t.isForXStatement(parent) && parent.left === current.node) return false;
    if (t.isVariableDeclarator(parent) && parent.id === current.node) return false;

    // Inside a pattern the write is announced further up, so keep climbing.
    // `ObjectProperty` and `AssignmentPattern` are only patterns on one side:
    // `{ x: A[0] }` and `f(a = A[0])` are ordinary reads.
    const inPattern =
      t.isArrayPattern(parent) ||
      t.isObjectPattern(parent) ||
      t.isRestElement(parent) ||
      (t.isObjectProperty(parent) && parent.value === current.node) ||
      (t.isAssignmentPattern(parent) && parent.left === current.node);
    if (!inPattern) return true;

    const next = current.parentPath;
    if (!next) return true;
    current = next;
  }
  return false;
}

/**
 * Whether a name resolved at this path could be intercepted by a `with` object.
 *
 * Inside `with (o) { ... }` an identifier is looked up on `o` *first*, at run
 * time, so a binding the scope analysis reports is only a fallback. Every pass
 * that rewrites a reference to the value of its binding - string inlining,
 * object-map inlining, proxy inlining, constant folding - is unsound there,
 * because the name may never reach that binding at all.
 *
 * Only the *body* is affected: the head is evaluated in the enclosing scope, so
 * `with (A[0]) { ... }` resolves `A` normally.
 */
export function insideWith(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    const parent: NodePath | null = current.parentPath;
    if (parent?.isWithStatement() && parent.node.body === current.node) return true;
    current = parent;
  }
  return false;
}

/**
 * Whether the identifier `undefined` really denotes the value `undefined`.
 *
 * `undefined` is not a keyword. It is a property of the global object, and the
 * *name* is bindable like any other:
 *
 *     function f(undefined) { return undefined; }   // whatever the caller passed
 *     function g() { var undefined = 1; ... }         // 1
 *     function h() { ... undefined ...; let undefined; } // ReferenceError, TDZ
 *
 * Nine places in this codebase read the name and conclude something about the
 * value - `x === undefined` is a nullish test, `foo(undefined)` passes nothing,
 * `p ? a : undefined` discards a branch. Only some of them ask this question,
 * and the ones that do not are wrong on all three programs above. One predicate
 * so they stop disagreeing.
 *
 * `scope.hasBinding('undefined')` is the trap and is NOT what this uses: Babel
 * lists `undefined`, `NaN`, `Infinity` and `arguments` in `Scope.contextVariables`,
 * so `hasBinding` answers `true` for the name in every scope, shadowed or not.
 * Only `getBinding` reports a binding the program actually declared.
 *
 * When nothing has bound it, the read is safe in a second way that matters to
 * {@link isInitialisedBinding}'s callers: the global `undefined` is a
 * non-writable, non-configurable property, so a bare read of it can neither
 * throw nor reach a getter the program installed. The same is true of `NaN` and
 * `Infinity`, which is why `fold-constants.ts` folds those two free names as
 * well; this predicate answers only for `undefined`.
 *
 * It does NOT answer the `with` question. Inside `with (o) { ... }` the name is
 * looked up on `o` first, so `with ({ undefined: 5 }) log(undefined)` prints 5
 * with no binding anywhere. That hazard is {@link insideWith}, which lives right
 * above this one; a caller inside an object environment needs both.
 */
export function isUnboundUndefined(node: t.Node, scope: Scope): boolean {
  return t.isIdentifier(node, { name: 'undefined' }) && scope.getBinding('undefined') === undefined;
}

/**
 * Whether reading this name is guaranteed not to throw - the TDZ half of the
 * question {@link isUnboundUndefined} answers the other half of.
 *
 * "The name is bound" is not "the name can be read". A `let`, `const` or `class`
 * binding exists for its whole block but throws a `ReferenceError` until control
 * reaches its declaration, so `var a = b; ... let b = 1;` is an expression whose
 * only observable effect is that throw, and deleting it because `a` is unread
 * swallows it. `var`, function and parameter bindings are initialised on entry
 * and are safe wherever they are read.
 *
 * The two predicates are complements, not alternatives: this one requires a
 * binding and that one requires there to be none, so `isInitialisedBinding(n, s)
 * || isUnboundUndefined(n, s)` is order-independent. It used to be written the
 * other way round, and putting the name test first let a read inside the TDZ of
 * a `let undefined` short-circuit past the very test this exists to make. That
 * composite is `isSideEffectFree`'s `Identifier` arm in `util/purity.ts` - use
 * it rather than rebuilding it.
 *
 * Source positions are the only evidence available for "control has reached the
 * declaration", and a node an earlier pass synthesised has none. That is a
 * refusal, not a licence.
 *
 * ## Being after the declaration in the TEXT is not running after it
 *
 * `start >= end` compares where two nodes are WRITTEN. Two constructs let
 * control reach a later position without having run an earlier one, and both
 * turn this comparison into a wrong answer rather than a conservative one:
 *
 *  - A `function` declaration is HOISTED, so it is callable from the moment its
 *    scope is entered no matter where it is written:
 *
 *        read();                      // ReferenceError: v is in its TDZ
 *        let v = 1;
 *        function read() { return v; }
 *
 *    The read of `v` is textually after `let v = 1`, and it runs before it.
 *
 *  - A `switch` enters at the matching case, so a `let` in an earlier case is
 *    skipped, not executed:
 *
 *        switch (2) { case 1: let v = 1; break; case 2: return v; }
 *
 * So a position is evidence only once the way control gets there is known.
 * {@link reachesAfterDeclaration} turns the read's position into that: it walks
 * the scopes between the read and the declaration, and where a hoisted function
 * lies in between it re-asks the same question of every CALL SITE of that
 * function - which is where the timing actually comes from. A function whose
 * every call site is itself past the declaration carries that proof to the
 * reads inside it, so `const K = 1; function use() { return K; }` still answers
 * true and the removals that depend on it are kept.
 *
 * The refusals are wider than the two shapes above, because a call site is only
 * evidence when it can be enumerated and placed: an Annex B block function has
 * uses its binding never lists ({@link isVarScopedFunctionDeclaration} is that
 * condition), an `export` is called by code this file cannot see, a
 * synthesised call site has no position, and the walk gives up rather than run
 * unbounded. Each of those is a refusal, and a refusal is safe.
 */
export function isInitialisedBinding(node: t.Identifier, scope: Scope): boolean {
  const binding = scope.getBinding(node.name);
  if (!binding) return false;
  if (binding.kind !== 'let' && binding.kind !== 'const' && !binding.path.isClassDeclaration()) {
    return true;
  }
  const end = binding.path.node.end;
  if (typeof end !== 'number') return false;
  const zone: DeadZone = {
    end,
    scope: binding.scope,
    switchCase: declaringSwitchCase(binding),
    visits: MAX_CALL_SITE_VISITS,
  };
  return reachesAfterDeclaration(node.start, scope, zone, new Set());
}

/**
 * Whether `name`, read at `at`, holds the value its declaration gave it - the
 * question {@link isInitialisedBinding} answers for `let`, `const` and `class`,
 * asked of `var` as well.
 *
 * A `var` is initialised on entry, so reading it never throws, and that is all
 * `isInitialisedBinding` promises. What it holds until its declarator runs is
 * `undefined`, not the initialiser: `try { log(f()) } catch (e) { log(e.name) }
 * var f = function () { return 'f' }` prints `TypeError`, and a pass that
 * folded `f()` to `'f'` on the strength of the declarator erased that throw. So
 * a pass that resolves a name to its INITIALISER - a wrapper body, a frozen
 * table, an object literal - needs the ordering proof for every kind of
 * declarator, and gets it from the same climb the dead-zone proof makes.
 *
 * The dead zone of a `var` is wider than a `let`'s in one way. A `let` is
 * scoped to the block it is written in, so a read that resolves to it is in
 * that block, and past the declaration textually or not at all. A `var` is
 * scoped to the whole function, and control reaches a read past its
 * declarator textually without having run it whenever the declarator sits in
 * a branch, a loop, a case or a `try` the read is outside of: `if (never) {
 * var f = () => 1 } log(f())` throws. So the climb's last step asks
 * {@link runsBefore} as well as the position: the read must be inside the
 * statement list the declaration is in, or that list must be one control
 * cannot skip on the way to the read.
 *
 * Every other kind is what its declaration made it from the moment its scope
 * is entered - a parameter, a function declaration, a function expression's
 * own name, an import - and holds it wherever it is read.
 *
 * `at` is the node whose place stands for the read: the identifier itself,
 * or - for a wrapper body a pass resolves without putting it in the tree -
 * the wrapper, since nothing in a body runs before the function it belongs
 * to is reached. `strings` is what lets a read inside a hoisted function be
 * placed by that function's callers even when it is WRITTEN ahead of the
 * declaration: `function g() { return h(); } const h = () => 'h'; log(g())`
 * runs `h()` after the declarator, and the only way to call `g` that
 * `referencePaths` does not list is code compiled from a string - which the
 * facts answer for, and which is also the reason `isInitialisedBinding`,
 * asked without them, keeps the read's own position as its evidence there.
 *
 * `order` is where "position" comes from. Source offsets say where a node
 * was PARSED, and that stops being where it RUNS the moment a pass reorders
 * the tree - `structure.control-flow` splices case bodies into dispatch
 * order - or splices in code parsed from a string, which `unpack` strips the
 * offsets from. A {@link TreeOrder} numbers the tree as it stands, and a
 * pass that has one is answered from it; without one the offsets are used,
 * which is what `isInitialisedBinding` still runs on.
 */
export function holdsDeclaredValue(
  name: string,
  at: t.Node,
  scope: Scope,
  strings?: NameAddressing,
  order?: TreeOrder,
): boolean {
  const binding = scope.getBinding(name);
  if (!binding) return false;
  let declared: t.Node;
  let switchCase: t.SwitchCase | null = null;
  let declaration: t.VariableDeclaration | undefined;
  // The declarator's own statement is read off the node, not the path: a
  // path's parent chain is what Babel built at the last crawl, and a pass
  // that moved the statement since leaves it pointing at a container the
  // statement is no longer in. The walks below find the statement in the
  // tree as it stands.
  if (binding.kind === 'let' || binding.kind === 'const' || binding.path.isClassDeclaration()) {
    declared = binding.path.node;
    switchCase = declaringSwitchCase(binding);
    // Placed by the climb alone - a `let` is in the block that holds it - but
    // the statement is what the shortcut below reads the scope ahead of.
    const statement = binding.path.parent;
    if (t.isVariableDeclaration(statement)) declaration = statement;
  } else if (binding.kind === 'var') {
    const declarator = binding.path;
    if (!declarator.isVariableDeclarator()) return false;
    // `var f;` gives the name nothing beyond the `undefined` it already holds.
    if (!declarator.node.init) return true;
    const statement = declarator.parent;
    if (!t.isVariableDeclaration(statement)) return false;
    declared = declarator.node;
    declaration = statement;
  } else {
    return true;
  }
  const end = order ? order.end(declared) : declared.end;
  if (typeof end !== 'number') return false;
  const zone: DeadZone = {
    end,
    scope: binding.scope,
    switchCase,
    visits: MAX_CALL_SITE_VISITS,
    strings,
    order,
    declaration,
  };
  if (reachesAfterDeclaration(startOf(at, zone), scope, zone, new Set())) return true;
  // The climb follows callers one call site at a time and gives up at a
  // depth and a budget; a function that nothing can have called yet needs
  // neither.
  const position = startOf(at, zone);
  return (
    declaration !== undefined &&
    strings !== undefined &&
    typeof position === 'number' &&
    position >= end &&
    nothingRunsBefore(declaration, binding, strings, zone)
  );
}

/**
 * The tree as it stands, numbered in pre-order: the position a node RUNS at
 * relative to every other, which is what the ordering proof compares and
 * what a source offset only approximates.
 *
 * Every statement list runs in order, every construct after its parent's
 * start and before its parent's end - the same facts a source offset
 * encodes, and encodes wrongly once a pass has moved a statement without
 * moving its offsets, or spliced in a subtree parsed from a string, whose
 * offsets count that string. Built lazily on the first question and never
 * updated: a pass that reorders statements while it asks has to
 * {@link invalidate} between the two, and a pass that only replaces
 * expressions in place need not, since the nodes it leaves keep their order
 * and the nodes it makes are simply unknown here, which is a refusal.
 *
 * The numbers live on the nodes, under symbols, stamped with the build they
 * belong to; a node from another build, or a copy `t.cloneNode` made - it
 * copies fields, not symbols - has no place and answers `undefined`. A
 * symbol is invisible to everything else that reads a node: the generator,
 * the traverser, `cloneNode` and JSON all walk named fields, and nothing in
 * the engine spreads a node into another. One numbering of the 4 MB fixture
 * is 400,000 nodes and around 60 ms; the map that would avoid touching the
 * nodes was twice that.
 */
export class TreeOrder {
  private epoch = 0;

  constructor(private readonly root: t.Node) {}

  /** Forget the numbering; the next question rebuilds it from the tree as it then stands. */
  invalidate(): void {
    this.epoch = 0;
  }

  /** The node's place, or `undefined` for a node that was not in the tree when it was numbered. */
  start(node: t.Node): number | undefined {
    if (this.epoch === 0) this.build();
    const stamped = node as Numbered;
    return stamped[ORDER_EPOCH] === this.epoch ? stamped[ORDER_START] : undefined;
  }

  /** The place after the node's last descendant, so `[start, end)` is the subtree. */
  end(node: t.Node): number | undefined {
    if (this.epoch === 0) this.build();
    const stamped = node as Numbered;
    return stamped[ORDER_EPOCH] === this.epoch ? stamped[ORDER_END] : undefined;
  }

  /** Whether a place lies inside a node's subtree. */
  contains(node: t.Node, position: number): boolean {
    const start = this.start(node);
    const end = this.end(node);
    return typeof start === 'number' && typeof end === 'number' && position >= start && position < end;
  }

  private build(): void {
    this.epoch = ++epochs;
    const epoch = this.epoch;
    let counter = 0;
    // Pre-order with an exit record per node, so `end` is known when the
    // subtree is done; a number on the stack is an index into `open`, the
    // node whose exit it marks.
    const work: Array<t.Node | number> = [this.root];
    const open: Numbered[] = [];
    while (work.length > 0) {
      const item = work.pop()!;
      if (typeof item === 'number') {
        open[item]![ORDER_END] = counter++;
        continue;
      }
      const node = item as Numbered;
      node[ORDER_EPOCH] = epoch;
      node[ORDER_START] = counter++;
      work.push(open.length);
      open.push(node);
      const keys = t.VISITOR_KEYS[node.type];
      if (!keys) continue;
      for (let index = keys.length - 1; index >= 0; index--) {
        const child = (node as unknown as Record<string, unknown>)[keys[index]!];
        if (Array.isArray(child)) {
          for (let at = child.length - 1; at >= 0; at--) {
            const element = child[at];
            if (element && typeof (element as t.Node).type === 'string') work.push(element as t.Node);
          }
        } else if (child && typeof (child as t.Node).type === 'string') {
          work.push(child as t.Node);
        }
      }
    }
  }
}

const ORDER_EPOCH = Symbol('tree-order-epoch');
const ORDER_START = Symbol('tree-order-start');
const ORDER_END = Symbol('tree-order-end');

/** Builds so far, so a node stamped by an earlier numbering is not mistaken for this one. */
let epochs = 0;

type Numbered = t.Node & {
  [ORDER_EPOCH]?: number;
  [ORDER_START]?: number;
  [ORDER_END]?: number;
};

/** A node's place in the zone's terms: its order when the zone has one, its offset otherwise. */
function startOf(node: t.Node, zone: Pick<DeadZone, 'order'>): number | null | undefined {
  return zone.order ? zone.order.start(node) : node.start;
}

/** Whether a place lies inside a node, in the zone's terms. */
function within(node: t.Node, position: number, zone: Pick<DeadZone, 'order'>): boolean {
  return zone.order ? zone.order.contains(node, position) : containsPosition(node, position);
}

/**
 * The one question the climb asks of `analysis/string-code.ts` - whether code
 * compiled from a string can reach a name - spelled here so this file need not
 * import it. `StringCodeFacts` answers it as it stands.
 */
export interface NameAddressing {
  addressesName(name: string, scope: Scope): boolean;
}

/**
 * Whether nothing of a function can have run ahead of one of its variable
 * declarations - which places every read written after it at once, reads
 * inside its hoisted functions included, however deep the call chain.
 *
 * obfuscator.io opens each function with its storage object, after aliases
 * of the decoders - `var _0xa = _0xd, _0xm = { ... }` - and reads it from every
 * function below, through chains the climb runs out of budget on. The reason
 * those reads are safe is not their call sites: it is that a hoisted
 * function of this scope can only be called by code of this scope, and the
 * first statement of the scope that could call anything is past the
 * declarator. So: the declaration sits in the function's own statement
 * list, directly or in bare blocks; every statement ahead of it, and every
 * declarator ahead of this one in its own statement, is inert - a hoisted
 * function, an empty statement, or a declaration whose initialisers make
 * values without running anything, where "running" includes a getter on an
 * object this scope did not make, since that getter holds no reference to a
 * function of this scope either; the parameters are plain names, so no
 * default ran; and no string code reaches the scope. A Program is not a
 * function: a script's hoisted functions are the global object's, and another
 * script or an `onclick` attribute can call them before this one reaches
 * the declarator.
 */
function nothingRunsBefore(
  declaration: t.VariableDeclaration,
  binding: Binding,
  strings: NameAddressing,
  zone: Pick<DeadZone, 'order'>,
): boolean {
  const owner = binding.scope.block;
  if (!t.isFunction(owner) || !t.isBlockStatement(owner.body)) return false;
  if (!owner.params.every((param) => t.isIdentifier(param))) return false;
  if (strings.addressesName(binding.identifier.name, binding.scope)) return false;

  const prefix: InertPrefix = { nodes: MAX_INERT_PREFIX_NODES, carriers: hoistedFunctionNames(owner) };
  // Down from the body to the statement, through bare blocks only, with
  // everything ahead of the way down inert, and the declarators ahead of this
  // one in its own statement last, since a name bound earlier is what a later
  // read may run a method of.
  const target = startOf(declaration, zone);
  if (typeof target !== 'number') return false;
  let list: t.Statement[] = owner.body.body;
  for (let depth = 0; depth < MAX_SCOPE_WALK; depth++) {
    const holder = list.find((statement) => within(statement, target, zone));
    if (!holder) return false;
    for (const earlier of list) {
      if (earlier === holder) break;
      if (!isInertStatement(earlier, prefix)) return false;
    }
    if (holder === declaration) {
      for (const declarator of declaration.declarations) {
        if (declarator === binding.path.node) return true;
        if (!isInertDeclarator(declarator, prefix)) return false;
      }
      return true;
    }
    if (!t.isBlockStatement(holder)) return false;
    list = holder.body;
  }
  return false;
}

/** Nodes one {@link nothingRunsBefore} query may read before refusing; a real prefix is a few declarators. */
const MAX_INERT_PREFIX_NODES = 4_096;

/**
 * What a prefix walk carries: its node budget, and the names bound in it to
 * a value that holds code of this activation; see {@link inertness}.
 */
interface InertPrefix {
  nodes: number;
  carriers: Set<string>;
}

/**
 * The names of the functions declared anywhere in `owner`'s own body, which
 * hold code of this activation from its first instruction: `{ valueOf: f }`
 * coerced in a prefix runs `f` as surely as `f()` would.
 */
function hoistedFunctionNames(owner: t.Function): Set<string> {
  const names = new Set<string>();
  const stack: t.Node[] = [owner.body];
  while (stack.length > 0) {
    const node = stack.pop() as t.Node;
    if (t.isFunctionDeclaration(node)) {
      if (node.id) names.add(node.id.name);
      continue;
    }
    if (t.isFunction(node) || t.isClass(node)) continue;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child as Array<t.Node | null>) if (item && typeof item.type === 'string') stack.push(item);
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return names;
}

/**
 * How an expression stands to running code of the scope it is in: it does
 * (`RUNS`), it does not and makes a plain value (`INERT`), or it does not
 * but the value it makes holds a function or method made here (`CARRIES`),
 * which an operator or a member read on it would run - a getter, `valueOf`,
 * `toString`, a `Symbol` method.
 */
enum Inert {
  RUNS = 0,
  INERT = 1,
  CARRIES = 2,
}

function isInertStatement(node: t.Statement, prefix: InertPrefix): boolean {
  if (t.isFunctionDeclaration(node) || t.isEmptyStatement(node)) return true;
  if (!t.isVariableDeclaration(node)) return false;
  return node.declarations.every((declarator) => isInertDeclarator(declarator, prefix));
}

function isInertDeclarator(node: t.VariableDeclarator, prefix: InertPrefix): boolean {
  if (!t.isIdentifier(node.id)) return false;
  if (!node.init) return true;
  const value = inertness(node.init, prefix);
  if (value === Inert.CARRIES) prefix.carriers.add(node.id.name);
  return value !== Inert.RUNS;
}

/**
 * An expression that makes a value without calling anything of the scope it
 * is in: names, literals, `this`, functions (made, not run), literals of
 * objects and arrays over the same, member reads and operators over the same
 * - unless the operand may hold a function or method made in this prefix,
 * whose getter or coercion the operator would run. `var o = { get x() {
 * return f(); } }, y = o.x, T = [...]` ran `f`, and its read of `T`, before
 * `T` held anything; the fold on `T` inside `f` stood on this test.
 * A call, a `new`, a tagged template, a spread, a computed key, an `await`
 * or a `yield` is not inert, and neither is anything unlisted.
 */
function inertness(node: t.Node, prefix: InertPrefix): Inert {
  if (--prefix.nodes < 0) return Inert.RUNS;
  switch (node.type) {
    case 'Identifier':
      return prefix.carriers.has(node.name) ? Inert.CARRIES : Inert.INERT;
    case 'ThisExpression':
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
      return Inert.INERT;
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return Inert.CARRIES;
    case 'TemplateLiteral':
      return node.expressions.length === 0 ? Inert.INERT : Inert.RUNS;
    case 'UnaryExpression': {
      if (node.operator === 'delete') return Inert.RUNS;
      const argument = inertness(node.argument, prefix);
      // `typeof`, `void` and `!` coerce nothing; the arithmetic ones call `valueOf`.
      if (argument === Inert.CARRIES) return node.operator === 'typeof' || node.operator === 'void' || node.operator === '!' ? Inert.INERT : Inert.RUNS;
      return argument;
    }
    case 'BinaryExpression': {
      if (t.isPrivateName(node.left)) return Inert.RUNS;
      const left = inertness(node.left, prefix);
      const right = inertness(node.right, prefix);
      if (left === Inert.RUNS || right === Inert.RUNS) return Inert.RUNS;
      if (left === Inert.INERT && right === Inert.INERT) return Inert.INERT;
      // Identity compares nothing's methods; every other operator coerces or looks one up.
      return node.operator === '===' || node.operator === '!==' ? Inert.INERT : Inert.RUNS;
    }
    case 'LogicalExpression':
      return either(inertness(node.left, prefix), inertness(node.right, prefix));
    case 'ConditionalExpression': {
      const test = inertness(node.test, prefix);
      if (test === Inert.RUNS) return Inert.RUNS;
      return either(inertness(node.consequent, prefix), inertness(node.alternate, prefix));
    }
    case 'SequenceExpression': {
      let last: Inert = Inert.INERT;
      for (const item of node.expressions) {
        last = inertness(item, prefix);
        if (last === Inert.RUNS) return Inert.RUNS;
      }
      return last;
    }
    case 'MemberExpression': {
      // A read on a carrier may be a getter; a carrier as a computed key is
      // converted through `toString`.
      if (inertness(node.object, prefix) !== Inert.INERT) return Inert.RUNS;
      if (node.computed && inertness(node.property, prefix) !== Inert.INERT) return Inert.RUNS;
      return Inert.INERT;
    }
    case 'ArrayExpression': {
      let value: Inert = Inert.INERT;
      for (const element of node.elements) {
        if (element === null) continue;
        value = either(value, inertness(element, prefix));
        if (value === Inert.RUNS) return Inert.RUNS;
      }
      return value;
    }
    case 'ObjectExpression': {
      let value: Inert = Inert.INERT;
      for (const property of node.properties) {
        if (t.isSpreadElement(property) || property.computed) return Inert.RUNS;
        if (t.isObjectMethod(property)) {
          value = Inert.CARRIES;
          continue;
        }
        value = either(value, inertness(property.value, prefix));
        if (value === Inert.RUNS) return Inert.RUNS;
      }
      return value;
    }
    default:
      return Inert.RUNS;
  }
}

/** The standing of a value that may be either of two: runs if either runs, carries if either carries. */
function either(a: Inert, b: Inert): Inert {
  if (a === Inert.RUNS || b === Inert.RUNS) return Inert.RUNS;
  return a === Inert.CARRIES || b === Inert.CARRIES ? Inert.CARRIES : Inert.INERT;
}

/**
 * Whether a `var` declaration written ahead of `position` has run by the time
 * control is there - the half of the `var` question that a position alone
 * cannot answer, asked at the end of the climb with the position of whatever
 * sits directly in the var scope around the read.
 *
 * Statements in one list run in order, so a position inside the list's own
 * container is past a declaration written earlier in it, whatever the
 * container is: a loop body reaches its later statements only through its
 * earlier ones on every iteration, and a case reaches them in order whether
 * entered directly or fallen into. A position outside the container is past
 * it only if the container itself runs whenever the list around it does - a
 * bare block does - and past the whole of it then, since a bare block is left
 * only by running out or by leaving the function. A branch, a loop, a `try`,
 * a case the position is not in and a `for` head can each leave the
 * declaration unrun with control past it, and refuse.
 *
 * Walked down from the scope's body by position, in the tree as it stands,
 * for the reason given in `holdsDeclaredValue`: a statement's cached path
 * may name a container a pass has since moved it out of.
 */
function runsBefore(
  scope: t.Node,
  declaration: t.VariableDeclaration,
  position: number,
  zone: Pick<DeadZone, 'order'>,
): boolean {
  const target = startOf(declaration, zone);
  if (typeof target !== 'number') return false;
  let node: t.Node = t.isFunction(scope) ? scope.body : scope;
  // Inside the scope but outside its body is the parameter list, where no
  // `var` of the body has run.
  if (!t.isProgram(node) && !within(node, position, zone)) return false;
  for (let depth = 0; depth < MAX_SCOPE_WALK; depth++) {
    const list = statementsOf(node);
    if (!list) return false;
    const holder = list.find((statement) => within(statement, target, zone));
    if (!holder) return false;
    if (holder === declaration) return true;
    if (t.isExportNamedDeclaration(holder)) return holder.declaration === declaration;
    if (t.isBlockStatement(holder)) {
      if (!within(holder, position, zone)) return true;
      node = holder;
      continue;
    }
    // The declaration is somewhere inside another statement: find the list
    // that holds it directly, and the position has to be in that list's
    // container too. Anything between is entered only on the way to it.
    let inner: t.Node = holder;
    let found = false;
    for (let step = 0; step < MAX_SCOPE_WALK && !found; step++) {
      const child = childContaining(inner, target, zone);
      if (!child || child === declaration) return false;
      if (statementsOf(child)?.includes(declaration)) found = true;
      inner = child;
    }
    if (!found || !within(inner, position, zone)) return false;
    node = inner;
  }
  return false;
}

/** The statement list a node holds directly, if it holds one. */
function statementsOf(node: t.Node): t.Statement[] | undefined {
  if (t.isBlockStatement(node) || t.isProgram(node)) return node.body;
  if (t.isSwitchCase(node)) return node.consequent;
  return undefined;
}

/** The direct child of a node that contains a position. */
function childContaining(node: t.Node, position: number, zone: Pick<DeadZone, 'order'>): t.Node | undefined {
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof (item as t.Node).type === 'string' && within(item as t.Node, position, zone)) {
          return item as t.Node;
        }
      }
    } else if (child && typeof (child as t.Node).type === 'string' && within(child as t.Node, position, zone)) {
      return child as t.Node;
    }
  }
  return undefined;
}

/** How deep a chain of "...and that function's callers" is followed before refusing. */
const MAX_CALL_SITE_DEPTH = 6;

/** Total call sites examined per query, so a hot predicate stays bounded. */
const MAX_CALL_SITE_VISITS = 64;

/** Scopes climbed between a read and its binding before refusing. */
const MAX_SCOPE_WALK = 64;

/** The temporal dead zone {@link reachesAfterDeclaration} is proving a position is past. */
interface DeadZone {
  /** End offset of the declaration; control must have passed this. */
  readonly end: number;
  /** Scope the binding lives in - where the climb stops. */
  readonly scope: Scope;
  /** Case the declaration sits in, when a `switch` can enter past it. */
  readonly switchCase: t.SwitchCase | null;
  /** Remaining budget, decremented across the whole query. */
  visits: number;
  /**
   * What string code can reach, when the caller knows. Without it a read
   * inside a hoisted function keeps its own position as evidence, because a
   * call site the tree does not show could otherwise be the first one.
   */
  readonly strings?: NameAddressing;
  /** Where positions come from when the caller numbered the tree; see {@link TreeOrder}. */
  readonly order?: TreeOrder;
  /**
   * The declaration's statement, when it is a variable declaration: a `var`
   * one {@link runsBefore} has to place as well as the position, and any one
   * {@link nothingRunsBefore} reads the scope ahead of.
   */
  readonly declaration?: t.VariableDeclaration;
}

/**
 * Whether control reaching `start`, from `scope`, implies the declaration ran.
 *
 * The climb is the proof. At each step `position` is where the enclosing
 * construct is EVALUATED, which for everything except a hoisted function
 * declaration is where it is written - a function expression, an arrow, a
 * method and a class field cannot be reached before the expression that creates
 * them, so their own position is a sound stand-in and the climb continues with
 * it. A `function` declaration has no such position. What it has is the scope
 * it is declared in: its name is bound there and nowhere above, so nothing
 * outside that scope holds the function until code inside it has run, and
 * its body cannot run before the scope is entered. A declaration BELOW the
 * zone's scope is therefore placed by whatever places the scope around it,
 * and the climb goes on from there - `var T = [...]; !function () { function
 * f() { return T[0]; } ... }()` puts `f`'s reads after the table wherever
 * `f` is called from, because the whole of the expression is. A function
 * hoisted into the zone's own scope can be called from ahead of the
 * declarator, and so can one hoisted into a block of that scope which holds
 * the declarator too - a `var`'s scope is the function, and a block, a
 * branch, a case, a loop body or a `catch` can hold both (see
 * {@link declaredInOwnList}). Those are handed to
 * {@link callSitesReachAfter}, which asks this same question of their
 * callers.
 */
function reachesAfterDeclaration(
  start: number | null | undefined,
  scope: Scope,
  zone: DeadZone,
  active: Set<t.Node>,
): boolean {
  let position = start;
  let current: Scope | undefined = scope;
  for (let depth = 0; depth < MAX_SCOPE_WALK; depth++) {
    if (!current) return false;
    if (current === zone.scope) return pastDeclaration(position, zone);
    const path: NodePath = current.path;
    if (path.isFunctionDeclaration()) {
      // Declared below the zone's scope, the function cannot run before that
      // scope is entered, so the climb goes on from there. A sloppy
      // block-level function is the same case: its var-scoped copy is
      // `undefined` until the block's declaration is evaluated, so a call
      // through it before the block ran is a throw, not the body. That
      // places the read only where entering the scope is itself past the
      // declarator, which a `var` declared inside a block of its function
      // is not: `{ try { f() } catch {} var w = ...; function f() { w() } }`
      // enters the block, calls `f`, and runs `w`'s declarator after.
      const owner: Scope | undefined = current.parent;
      if (owner && owner !== zone.scope && declaredInOwnList(zone)) {
        current = owner;
        continue;
      }
      // The body runs when the function is called, so its callers place the
      // read. Without the string-code facts the read's own position stays as
      // the filter it always was: `eval('g()')` is a caller the list below
      // cannot show, and a caller of THIS that has no facts cannot rule it
      // out, so what it answered before is what it goes on answering.
      if (!zone.strings && !pastDeclaration(position, zone)) return false;
      return callSitesReachAfter(path, zone, active);
    }
    if (path.isFunction()) position = startOf(path.node, zone);
    current = current.parent;
  }
  return false;
}

/** Whether a position, reached from within the zone's scope, is past the declaration. */
function pastDeclaration(position: number | null | undefined, zone: DeadZone): boolean {
  // A synthesised node has no position, so there is nothing to reason from.
  if (typeof position !== 'number' || position < zone.end) return false;
  if (zone.switchCase && !within(zone.switchCase, position, zone)) return false;
  if (!zone.declaration || zone.declaration.kind !== 'var') return true;
  return runsBefore(zone.scope.block, zone.declaration, position, zone);
}

/**
 * Whether no scope below the zone's can be entered ahead of the declarator,
 * so a function hoisted into one is placed by whatever places that scope.
 *
 * A `let`, `const` or `class` is scoped to the block that holds it, so a
 * scope below that block is inside one of the block's own statements and
 * entered by running the list up to it - or, in a `switch`, by a case entry
 * {@link pastDeclaration} refuses. A `var` is scoped to the whole function,
 * and gives the same guarantee only when its statement is in the function's
 * own list: a block below the function cannot hold it, so cannot be entered
 * before it. A `var` in a block, a branch, a case, a loop body or a `catch`
 * shares that container with whatever is hoisted into it, and that is
 * callable from the container's first statement.
 */
function declaredInOwnList(zone: DeadZone): boolean {
  const declaration = zone.declaration;
  if (!declaration || declaration.kind !== 'var') return true;
  const owner = zone.scope.block;
  const list = statementsOf(t.isFunction(owner) ? owner.body : owner);
  if (!list) return false;
  return list.some(
    (statement) =>
      statement === declaration ||
      (t.isExportNamedDeclaration(statement) && statement.declaration === declaration),
  );
}

/**
 * Whether every way of entering this hoisted function is itself past the
 * declaration.
 *
 * A reference is where the function VALUE is obtained, and it cannot be called
 * before it is obtained, so a reference position is a lower bound on every call
 * made through it - including one stored and invoked much later. References
 * inside the function itself are skipped: reaching them already required an
 * outer call, which is what the rest of this loop is proving.
 *
 * A reference inside a function whose own proof is in progress - two
 * handlers that each unregister the other, with the reads in both - is that
 * proof's assumption rather than a refutation of it: the function is entered
 * only through the references being checked, so if every reference from
 * outside the cycle is past the declaration, every entry into it is. That
 * stands only with the string-code facts in hand; without them the historic
 * refusal stays, for the reason the position does in the climb.
 *
 * This trusts `referencePaths` to enumerate the uses, which
 * {@link isVarScopedFunctionDeclaration} is the condition for, and which a
 * direct `eval` reaching the name through its scope would still defeat - a
 * zone that carries the string-code facts refuses that one too.
 */
function callSitesReachAfter(
  fn: NodePath<t.FunctionDeclaration>,
  zone: DeadZone,
  active: Set<t.Node>,
): boolean {
  if (active.has(fn.node)) return zone.strings !== undefined;
  if (active.size >= MAX_CALL_SITE_DEPTH) return false;
  if (!isVarScopedFunctionDeclaration(fn)) return false;
  // An export is called by code this file cannot see; with a circular import
  // that call can precede the module body reaching the declaration.
  const parent = fn.parentPath;
  if (!parent || parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) {
    return false;
  }
  const name = fn.node.id?.name;
  if (name === undefined) return false;
  const own = fn.scope.parent?.getBinding(name);
  if (!own || own.path.node !== fn.node) return false;
  // `eval('g()')` calls it from wherever the string is compiled, and lists
  // nowhere below.
  if (zone.strings?.addressesName(name, own.scope)) return false;

  active.add(fn.node);
  try {
    for (const reference of own.referencePaths) {
      if (zone.visits <= 0) return false;
      zone.visits--;
      if (insideFunction(reference, fn.node, zone)) continue;
      if (!reachesAfterDeclaration(startOf(reference.node, zone), reference.scope, zone, active)) {
        return false;
      }
    }
  } finally {
    active.delete(fn.node);
  }
  return true;
}

/**
 * Whether a reference lies inside a function's own body - by place when the
 * tree is numbered, since a reference's path may still climb through a
 * container its statement has been moved out of, and by the path otherwise.
 */
function insideFunction(reference: NodePath, fn: t.Node, zone: DeadZone): boolean {
  if (zone.order) {
    const position = zone.order.start(reference.node);
    return typeof position === 'number' && zone.order.contains(fn, position);
  }
  return reference.findParent((p) => p.node === fn) !== null;
}

/**
 * The `switch` case a lexical declaration sits directly in, if any.
 *
 * A `switch` body is one block with one scope, and entry jumps straight to the
 * matching case, so a declaration in another case is skipped rather than run.
 * A case that braces its body declares into that block instead, and a read
 * outside it cannot resolve to the binding at all, so only this shape needs the
 * containment test.
 */
function declaringSwitchCase(binding: { path: NodePath; scope: Scope }): t.SwitchCase | null {
  const owner = binding.scope.path;
  if (!owner.isSwitchStatement()) return null;
  const casePath = binding.path.findParent((p) => p.isSwitchCase());
  if (!casePath?.isSwitchCase() || casePath.parentPath?.node !== owner.node) return null;
  return casePath.node;
}

/** Whether an offset lies inside a node's own text. */
function containsPosition(node: t.Node, position: number): boolean {
  const { start, end } = node;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  return position >= start && position < end;
}

/** Walk up to the nearest enclosing function or program node. */
export function enclosingFunction(path: NodePath): NodePath | null {
  return path.getFunctionParent() ?? path.findParent((p) => p.isProgram());
}

/**
 * Whether a statement carries a leading comment, used by dead-code removal to
 * avoid deleting code a human annotated.
 */
export function hasLeadingComment(node: t.Node): boolean {
  return Array.isArray(node.leadingComments) && node.leadingComments.length > 0;
}

/** Stable, human-readable rendering of a node for reports and dedup keys. */
export function describeNode(node: t.Node): string {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return JSON.stringify(node.value);
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isMemberExpression(node)) {
    const object = describeNode(node.object);
    const property = node.computed
      ? `[${describeNode(node.property as t.Node)}]`
      : `.${describeNode(node.property as t.Node)}`;
    return `${object}${property}`;
  }
  if (t.isCallExpression(node)) {
    const callee = describeNode(node.callee as t.Node);
    return `${callee}(${node.arguments.map((a) => describeNode(a as t.Node)).join(', ')})`;
  }
  return node.type;
}

/**
 * Whether a function declaration's binding really is an enumeration of its uses.
 *
 * Annex B is the trap. In sloppy mode a `function` declared inside a block, a
 * `switch` case or a labelled statement is *also* var-hoisted to the enclosing
 * function scope, so it is callable from outside the block that appears to own
 * it:
 *
 *     if (ready) { function h() { return 42; } }
 *     log(h());               // legal, and h is the one declared above
 *
 * Babel scopes that declaration to the block, so `binding.referencePaths` lists
 * none of the outside call sites. Any pass that reasons "no references, so this
 * is unused" or "these are all the call sites, so they agree" is reading a
 * partial list and will act on it. `clean/unused.ts` deleted exactly the
 * function above and produced output that throws.
 *
 * Accepted: a declaration directly in a Program body, directly in a function's
 * own body block, or exported from a module - modules are strict throughout, so
 * Annex B cannot apply. Everything else refuses.
 */
export function isVarScopedFunctionDeclaration(path: NodePath<t.FunctionDeclaration>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  if (parent.isProgram()) return true;
  if (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) return true;
  if (!parent.isBlockStatement()) return false;
  const grandparent = parent.parentPath;
  return Boolean(grandparent?.isFunction() && grandparent.node.body === parent.node);
}

/**
 * What a `function` declaration binds beyond the scope Babel gives it.
 *
 *  - `none`: the binding Babel reports is the whole story. A declaration
 *    directly in a function body or a Program is that var binding itself; a
 *    block-level one in strict code, a generator or async one (B.3.3 covers
 *    plain functions only), or one whose hoisting the spec's conditions
 *    block, stays in its block and nothing outside can reach it.
 *  - `hoisted`: a sloppy block-level declaration that ALSO binds a `var` of
 *    its name in the enclosing function or script - `undefined` until the
 *    block runs, the function afterwards - which Babel records nowhere. Its
 *    `referencePaths` are complete for the block and list nothing outside it.
 *  - `unknown`: a shape the spec and the engines disagree on, or one Babel's
 *    scope tables misplace. Refuse.
 *
 * The conditions are B.3.3's, checked against V8 case by case:
 *
 *  - Hoisting is blocked by a same-named parameter of the function, and by a
 *    same-named `let`, `const` or `class` anywhere between the block and the
 *    function scope inclusive - a `for (let f ...)` head and a destructured
 *    `catch ({f})` included, a plain `catch (f)` not (B.3.4 lets a `var f`
 *    stand beside it). `function h(f) { { function f() {} } return typeof f
 *    }` is `number`; `let f = 0; { function f() {} }` leaves `f` a number.
 *    A same-named `var`, or a same-named declaration at the top of the
 *    function body, is the very var the block assigns: `function f() {
 *    return 'outer' } { function f() { return 'inner' } } f()` is `inner`.
 *  - A second `function f` in the same block, or one in an enclosing block,
 *    is an early error for the spec's replacement `var f` - so the spec does
 *    not hoist - and V8 hoists anyway (`{ function f() { return 'o' } {
 *    function f() { return 'i' } } } f()` is `i`). Neither answer is
 *    provable, so `unknown`.
 *  - `if (x) function f() {}` and `l: function f() {}` hoist in V8, but Babel
 *    registers the binding in the scope AROUND the statement, where a call
 *    made before the `if` ran lists as a reference to a function it never
 *    reaches. `unknown` too.
 *  - Strictness is the enclosing code's - a `'use strict'` inside the
 *    declaration's own body does not stop the hoisting - which is what
 *    `isInStrictMode` answers for a declaration from its parent.
 *
 * {@link blockFunctionOutsideUse} is the other half: given `hoisted`, what
 * outside the block could be reading that var.
 */
export type BlockFunctionHoisting = 'none' | 'hoisted' | 'unknown';

export function blockFunctionHoisting(path: NodePath<t.FunctionDeclaration>): BlockFunctionHoisting {
  if (isVarScopedFunctionDeclaration(path)) return 'none';
  const parent = path.parentPath;
  if (!parent || !(parent.isBlockStatement() || parent.isSwitchCase())) return 'unknown';
  const id = path.node.id;
  if (!id) return 'unknown';
  if (path.node.generator || path.node.async) return 'none';
  if (path.isInStrictMode()) return 'none';
  const name = id.name;
  // The var would be the arguments object; nothing here models that.
  if (name === 'arguments') return 'unknown';

  // The scope that owns the block binding: the block's, or the switch's for a
  // case. A catch body shares its clause's scope, and is found the same way.
  const own = parent.scope;
  const binding = own.getOwnBinding(name);
  // A second declaration of the name in the same block re-registers on the
  // first one's binding, as a violation of it.
  if (!binding || binding.path.node !== path.node) return 'unknown';
  for (const violation of binding.constantViolations) {
    if (violation.node !== path.node && violation.isFunctionDeclaration()) return 'unknown';
  }
  return hoistsThrough(name, own.parent);
}

/**
 * Whether `var name` would be created by a block function whose block's scope
 * sits directly under `from` - the walk from there up to the var scope that
 * would receive it, checking each scope's own bindings against the spec's
 * conditions. Shared by the path-based decision above and the node-based one
 * for a subtree that is about to be deleted.
 */
function hoistsThrough(name: string, from: Scope | undefined): BlockFunctionHoisting {
  for (let scope = from; scope; scope = scope.parent) {
    const owner = scope.path;
    const varScope = owner.isFunction() || owner.isProgram();
    const binding = scope.getOwnBinding(name);
    if (!binding) {
      if (varScope) return 'hoisted';
      continue;
    }
    switch (binding.kind) {
      case 'let':
      case 'const':
        // Babel registers a catch parameter as `let`; only a pattern one is a
        // conflict, and only the clause's own path tells the two apart.
        if (binding.path.isCatchClause()) {
          if (t.isIdentifier(binding.path.node.param)) {
            if (varScope) return 'hoisted';
            continue;
          }
          return 'none';
        }
        return 'none';
      case 'param':
        return 'none';
      case 'hoisted':
        // At the var scope this is the top-level declaration the block's
        // assignment overwrites; in a block between, a sibling the spec and
        // V8 disagree about.
        return varScope ? 'hoisted' : 'unknown';
      case 'var':
      case 'local':
        if (varScope) return 'hoisted';
        continue;
      default:
        return 'unknown';
    }
  }
  return 'unknown';
}

/**
 * The first identifier outside a block function's own declaration, within the
 * var scope its `var` lands in, that spells its name - or `undefined` when
 * there is none, in which case no hoisted use can exist and the binding Babel
 * reports really is every use.
 *
 * Any occurrence counts - a property key, a label, a reference inside the
 * block that Babel does list, one inside a nested function or a nested block
 * that rebinds the name: telling the occurrences apart is the scope analysis
 * Babel did not do, and over-counting only ever refuses. It has teeth on
 * `fixtures/obfuscated3.js`, whose block-level decoders name each other from
 * inside their blocks and stay for it.
 *
 * For a `none` declaration the answer is trivially `undefined`; the walk is
 * spent only on a `hoisted` or `unknown` one.
 */
export function blockFunctionOutsideUse(path: NodePath<t.FunctionDeclaration>): t.Identifier | undefined {
  if (blockFunctionHoisting(path) === 'none') return undefined;
  const name = path.node.id?.name;
  if (name === undefined) return undefined;
  const varScope = blockFunctionVarScope(path);

  const stack: unknown[] = [varScope.path.node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string' || node === path.node) continue;
    if (t.isIdentifier(node) && node.name === name) return node;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return undefined;
}

/**
 * The function or program scope a block function's Annex B var lands in -
 * where {@link blockFunctionHoisting} says there is one.
 *
 * From the PARENT's scope, not the declaration's own: a declaration's
 * `path.scope` is the function it declares, whose function parent is itself.
 */
export function blockFunctionVarScope(path: NodePath<t.FunctionDeclaration>): Scope {
  const outer = path.parentPath?.scope ?? path.scope.parent ?? path.scope;
  return outer.getFunctionParent() ?? outer.getProgramParent();
}

/**
 * The `var` names a region about to be deleted contributed to its enclosing
 * function scope: every `var` at any block depth, and every block-level
 * function Annex B hoists a var for. Returns `undefined` when that cannot be
 * decided, which is a refusal to delete the region.
 *
 * A `var` inside a branch that never ran is still a declared binding, and a
 * block function that never ran is a var holding `undefined` - when it hoists
 * one. It does not when the enclosing code is strict, when the function is a
 * generator or async, or when a same-named parameter or lexical declaration
 * blocks it; a `var` written out for those is a binding the program never
 * had, and beside a `let` of the same name it is a SyntaxError. `if (false)
 * { function log() {} } return log('x')` under `'use strict'` became `var
 * log; return log('x')` and threw where the input ran.
 *
 * The decision is {@link blockFunctionHoisting}'s, made for nodes with no
 * scope of their own: the lexical declarations on the way from a function up
 * to `anchor` are read off the deleted subtree itself, and from `anchor` up
 * to the var scope off Babel's scopes. `anchor` is the statement the region
 * is deleted from - an `if`, a loop, a `switch`, or the list owner whose
 * tail is going - and the walk starts at its node so its own head or case
 * list is on the chain; `dropped` says which of its parts are going.
 */
export function hoistedVarNames(
  anchor: NodePath,
  dropped: ReadonlySet<t.Node>,
): string[] | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  const strict = anchor.isInStrictMode();
  // The scope the anchor's own bindings live in is covered by the frames
  // below, so the Babel walk begins one step out.
  const above = anchor.parentPath?.scope ?? anchor.scope;
  let unknown = false;

  const visit = (node: t.Node, frames: LexicalFrame[], inside: boolean): void => {
    if (unknown) return;
    const within = inside || dropped.has(node);

    if (t.isFunctionDeclaration(node)) {
      if (!within || !node.id) return;
      const own = frames[frames.length - 1];
      // Not directly in a block or a case: the `if (x) function f() {}` and
      // labelled spellings, which the path-based decision refuses too.
      if (!own || !own.direct.has(node)) {
        unknown = true;
        return;
      }
      if (strict || node.generator || node.async) return;
      const name = node.id.name;
      if (name === 'arguments' || (own.functions.get(name) ?? 0) > 1) {
        unknown = true;
        return;
      }
      for (let index = frames.length - 2; index >= 0; index--) {
        const frame = frames[index]!;
        if (frame.lexical.has(name)) return;
        if (frame.functions.has(name)) {
          unknown = true;
          return;
        }
      }
      const outer = hoistsThrough(name, above);
      if (outer === 'hoisted') add(name);
      else if (outer === 'unknown') unknown = true;
      return;
    }
    // Anything with a scope of its own keeps its `var`s to itself.
    if (t.isFunction(node) || t.isClass(node)) return;
    if (within && t.isVariableDeclaration(node) && node.kind === 'var') {
      for (const name of Object.keys(t.getBindingIdentifiers(node))) add(name);
    }

    // Only the anchor can be a function's body block: the walk never enters a
    // nested function.
    const frame = lexicalFrameOf(node, node === anchor.node && Boolean(anchor.parentPath?.isFunction()));
    const next = frame ? [...frames, frame] : frames;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as t.Node).type === 'string') visit(item as t.Node, next, within);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        visit(child as t.Node, next, within);
      }
    }
  };

  visit(anchor.node, [], false);
  return unknown ? undefined : names;
}

/** The names one lexical container declares, as B.3.3's conditions read them. */
interface LexicalFrame {
  /** `let`, `const` and `class` names, plus what else blocks a `var` here. */
  lexical: Set<string>;
  /** Function declarations directly in the statement list, by name, counted. */
  functions: Map<string, number>;
  /** Those declarations themselves, so a function elsewhere in the node is told apart. */
  direct: Set<t.Node>;
}

/**
 * `functionBody` says the block is a function's own body, where a direct
 * function declaration is the function's var rather than a lexical name of
 * the block - the same distinction a Program's top level draws.
 */
function lexicalFrameOf(node: t.Node, functionBody: boolean): LexicalFrame | undefined {
  const frame: LexicalFrame = { lexical: new Set(), functions: new Map(), direct: new Set() };
  const readList = (statements: readonly t.Statement[], functionsAreVars: boolean): void => {
    for (const statement of statements) {
      if (t.isVariableDeclaration(statement) && statement.kind !== 'var') {
        for (const name of Object.keys(t.getBindingIdentifiers(statement))) frame.lexical.add(name);
      } else if (t.isClassDeclaration(statement) && statement.id) {
        frame.lexical.add(statement.id.name);
      } else if (t.isFunctionDeclaration(statement)) {
        frame.direct.add(statement);
        if (functionsAreVars || !statement.id) continue;
        frame.functions.set(statement.id.name, (frame.functions.get(statement.id.name) ?? 0) + 1);
      }
    }
  };

  if (t.isProgram(node)) {
    readList(node.body, true);
  } else if (t.isBlockStatement(node)) {
    readList(node.body, functionBody);
  } else if (t.isSwitchStatement(node)) {
    for (const entry of node.cases) readList(entry.consequent, false);
  } else if (t.isCatchClause(node)) {
    if (node.param && !t.isIdentifier(node.param)) {
      for (const name of Object.keys(t.getBindingIdentifiers(node.param))) frame.lexical.add(name);
    }
  } else if (t.isForStatement(node)) {
    if (t.isVariableDeclaration(node.init) && node.init.kind !== 'var') {
      for (const name of Object.keys(t.getBindingIdentifiers(node.init))) frame.lexical.add(name);
    }
  } else if (t.isForXStatement(node)) {
    if (t.isVariableDeclaration(node.left) && node.left.kind !== 'var') {
      for (const name of Object.keys(t.getBindingIdentifiers(node.left))) frame.lexical.add(name);
    }
  } else {
    return undefined;
  }
  return frame;
}

/**
 * Whether a sloppy block-level `function name` can stand in for `binding` at
 * a read made from `from` - the other half of the Annex B trap above.
 *
 * `{ function f() {} }` in sloppy code also declares a `var f` in the nearest
 * enclosing function or script, and assigns it the block's function when the
 * block is evaluated. Babel scopes the declaration to the block and records
 * that var nowhere: not as a binding of the function scope, and not on the
 * `constantViolations` of a same-named binding further out. So to every list
 * Babel keeps, `function f() { return 'outer'; } { function f() { return
 * 'inner'; } } f()` is a call to a constant `f` that returns `'outer'`; the
 * program prints `inner`. A pass that resolves a name to the function or the
 * array its binding declares has to ask this before trusting that binding.
 *
 * The var lands in the nearest var scope of the block, so the ones that can
 * intercept a read are those hoisted into a var scope on the chain from the
 * read up to and including the binding's own. Each such scope is searched to
 * its own function boundaries; a block function inside a deeper function
 * hoists into that function and is not on this chain. Strict code has no
 * Annex B, and strictness is the enclosing code's: a `'use strict'` inside the
 * block function's own body does not stop the hoisting, which is why the
 * directive test is on the scope and not on the declaration.
 *
 * `memo` is per traversal. The names a var scope hoists are one walk of its
 * own statements - never into a nested function - and a pass that asks this
 * for every call site of a wrapper with a thousand of them would otherwise
 * walk the top level a thousand times. A pass may keep the memo only for as
 * long as it adds no declarations to the tree, which for the folds and
 * expansions that ask is the length of one run. A global has no binding to
 * stop the climb at, and every var scope up to the program is searched.
 */
export function shadowedByBlockFunction(
  name: string,
  from: Scope,
  binding: Binding | undefined,
  memo?: BlockFunctionMemo,
): boolean {
  for (let scope: Scope | undefined = from; scope; scope = scope.parent) {
    const path = scope.path;
    if ((path.isFunction() || path.isProgram()) && !isStrictScope(path)) {
      let names = memo?.get(path.node);
      if (!names) {
        names = blockFunctionNames(path.node);
        memo?.set(path.node, names);
      }
      if (names.has(name)) return true;
    }
    if (binding && scope === binding.scope) return false;
  }
  return false;
}

/** Var-scope node -> the function names Annex B hoists into it; see {@link shadowedByBlockFunction}. */
export type BlockFunctionMemo = Map<t.Node, ReadonlySet<string>>;

/**
 * Whether code directly in this var scope is strict: a module, an enclosing
 * class or directive, or the scope's own `'use strict'`. Babel's
 * `isInStrictMode` answers for a function from its PARENT, so the function's
 * own directive is the one case added here.
 */
function isStrictScope(path: NodePath<t.Function> | NodePath<t.Program>): boolean {
  if (path.isInStrictMode()) return true;
  if (path.isProgram()) return false;
  const body = path.node.body;
  return t.isBlockStatement(body) && body.directives.some((d) => d.value.value === 'use strict');
}

/**
 * Every `function` name declared somewhere below this var scope's own statement
 * list without crossing into a nested function - in a block, a `switch` case,
 * a label, a loop body - which is exactly where Annex B hoists from.
 */
function blockFunctionNames(scope: t.Function | t.Program): ReadonlySet<string> {
  const names = new Set<string>();
  const list = t.isProgram(scope)
    ? scope.body
    : t.isBlockStatement(scope.body)
      ? scope.body.body
      : undefined;
  if (!list) return names;
  const stack: t.Node[] = [];
  for (const statement of list) {
    // A declaration directly in the list is the var-scoped one: it IS the binding
    // a scope lookup finds, not a second one hiding from it.
    if (t.isFunctionDeclaration(statement)) continue;
    stack.push(statement);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (t.isFunctionDeclaration(node)) {
      if (node.id) names.add(node.id.name);
      continue;
    }
    if (t.isFunction(node)) continue;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as t.Node).type === 'string') stack.push(item as t.Node);
        }
      } else if (child && typeof (child as t.Node).type === 'string') {
        stack.push(child as t.Node);
      }
    }
  }
  return names;
}
