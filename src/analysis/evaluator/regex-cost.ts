/**
 * What a host regex can cost before it runs.
 *
 * The host engine backtracks with no step budget of its own, and a pattern
 * such as `(a+)+$` is done in time exponential in its subject, so a cap on the
 * subject bounds nothing there. The pattern is read first, and the run is
 * refused unless its backtracking is provably polynomial with a degree the
 * subject can afford.
 *
 * The reading is a proof, not an estimate. A quantifier that leaves a choice
 * (`*`, `+`, `?`, `{n,m}` with n < m) is one factor of the work; a choice
 * nested inside another, an alternation under one whose branches could begin
 * alike or match nothing, and a backreference under one are all refused. What
 * remains matches each iteration of every loop in exactly one way, so the
 * attempts a subject of `n` characters can draw are at most the product of
 * the choices, each at most `n + 1`, once per start position unless the
 * pattern is anchored. A quantifier that ends the pattern draws none: its
 * first match completes the pattern. A quantifier over one character set
 * draws at most the longest run of that set in the subject, which is what
 * keeps `/=+$/` linear on a base64 blob.
 */

/** Sorted, disjoint, inclusive code-point ranges as flat pairs; `null` is a set this reader cannot spell. */
type CharSet = readonly number[] | null;

interface Choice {
  /** Choices this quantifier leaves: `Infinity` when they grow with the subject. */
  readonly count: number;
  /** The single-character set the quantifier repeats, when it repeats one. */
  readonly set: CharSet | undefined;
}

export interface RegexCost {
  readonly choices: readonly Choice[];
  /** Product of the branch counts of every alternation. */
  readonly branches: number;
  /** One start position: every alternative begins at `^` without `m`, or the flags are sticky. */
  readonly anchored: boolean;
  /** Matching by code point (`u` or `v`) rather than by code unit. */
  readonly unicode: boolean;
}

/** Attempts one host call may draw; roughly a second of a native engine. */
export const MAX_REGEX_WORK = 50_000_000;

const MAX_CODE_POINT = 0x10ffff;
const ALL: readonly number[] = [0, MAX_CODE_POINT];
const LINE_TERMINATORS: readonly number[] = [0x0a, 0x0a, 0x0d, 0x0d, 0x2028, 0x2029];
const DIGITS: readonly number[] = [0x30, 0x39];
const WORD: readonly number[] = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
const WORD_FOLDED: readonly number[] = [...WORD, 0x017f, 0x017f, 0x212a, 0x212a];
const SPACE: readonly number[] = [
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f,
  0x3000, 0x3000, 0xfeff, 0xfeff,
];

type Node =
  | { readonly kind: 'char'; readonly set: CharSet }
  | { readonly kind: 'group'; readonly body: Alternative[] }
  | { readonly kind: 'assert'; readonly start: boolean }
  | { readonly kind: 'backref' };

interface Term {
  readonly atom: Node;
  readonly min: number;
  readonly max: number;
  /** The entry this term's quantifier registered, when it leaves a choice. */
  readonly choice?: Choice;
}

type Alternative = Term[];

class Unreadable extends Error {}

/**
 * Read `source` as V8 already compiled it - the pattern is valid - and
 * classify its backtracking. The returned string says why no bound exists.
 */
export function readRegexCost(source: string, flags: string): RegexCost | string {
  try {
    return new Reader(source, flags).read();
  } catch (error) {
    if (error instanceof Unreadable) return error.message;
    throw error;
  }
}

/** Attempts a run over `subject` may draw, or `Infinity` once past the budget. */
export function regexWork(cost: RegexCost, subject: string): number {
  const n = subject.length;
  let work = (cost.anchored ? 1 : n + 1) * cost.branches;
  if (work > MAX_REGEX_WORK) return Number.POSITIVE_INFINITY;
  const runs = new Map<CharSet, number>();
  for (const choice of cost.choices) {
    let count = Math.min(choice.count, n + 1);
    if (choice.set !== undefined && choice.set !== null && count > 1) {
      let run = runs.get(choice.set);
      if (run === undefined) {
        run = longestRun(subject, choice.set, cost.unicode);
        runs.set(choice.set, run);
      }
      count = Math.min(count, run + 1);
    }
    work *= count;
    if (work > MAX_REGEX_WORK) return Number.POSITIVE_INFINITY;
  }
  return work;
}

function longestRun(subject: string, set: readonly number[], unicode: boolean): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < subject.length; i++) {
    const point = unicode ? subject.codePointAt(i)! : subject.charCodeAt(i);
    if (point > 0xffff) i++;
    if (contains(set, point)) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

class Reader {
  private i = 0;
  private readonly unicode: boolean;
  private readonly unicodeSets: boolean;
  private readonly ignoreCase: boolean;
  private readonly dotAll: boolean;
  private readonly multiline: boolean;
  private readonly sticky: boolean;
  private readonly choices: Choice[] = [];
  private branches = 1;

  constructor(
    private readonly source: string,
    flags: string,
  ) {
    this.unicodeSets = flags.includes('v');
    this.unicode = flags.includes('u') || this.unicodeSets;
    this.ignoreCase = flags.includes('i');
    this.dotAll = flags.includes('s');
    this.multiline = flags.includes('m');
    this.sticky = flags.includes('y');
  }

  read(): RegexCost {
    const top = this.disjunction();
    if (this.i < this.source.length) throw new Unreadable('the pattern could not be read');
    for (const alternative of top) this.exemptTail(alternative);
    const anchored = this.sticky || (!this.multiline && top.every((alternative) => startsAnchored(alternative)));
    return { choices: this.choices, branches: this.branches, anchored, unicode: this.unicode };
  }

  /** The last quantifier of the pattern draws no choice; drop the entry it registered. */
  private exemptTail(alternative: Alternative): void {
    const last = alternative[alternative.length - 1];
    if (!last) return;
    if (last.choice) {
      const index = this.choices.indexOf(last.choice);
      if (index >= 0) this.choices.splice(index, 1);
      return;
    }
    if (last.min === 1 && last.max === 1 && last.atom.kind === 'group') {
      for (const inner of last.atom.body) this.exemptTail(inner);
    }
  }

  private disjunction(): Alternative[] {
    const alternatives: Alternative[] = [this.alternative()];
    while (this.peek() === '|') {
      this.i++;
      alternatives.push(this.alternative());
    }
    if (alternatives.length > 1) this.branches *= alternatives.length;
    return alternatives;
  }

  private alternative(): Alternative {
    const terms: Term[] = [];
    while (this.i < this.source.length) {
      const c = this.peek();
      if (c === '|' || c === ')') break;
      terms.push(this.term());
    }
    return terms;
  }

  private term(): Term {
    const atom = this.atom();
    // A backreference is matched by comparison, as long as its capture.
    if (atom.kind === 'backref') this.choices.push({ count: Number.POSITIVE_INFINITY, set: undefined });
    const quantifier = this.quantifier();
    if (!quantifier) return { atom, min: 1, max: 1 };
    const { min, max } = quantifier;
    if (min === max) return { atom, min, max };
    // A choice: nothing under it may choose again, and every alternation
    // under it must be decided by its next character.
    if (atom.kind === 'backref') throw new Unreadable('a backreference under a quantifier');
    if (atom.kind === 'group') this.requireUnique(atom.body);
    const choice: Choice = {
      count: max === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : max - min + 1,
      set: atom.kind === 'char' ? atom.set : undefined,
    };
    this.choices.push(choice);
    return { atom, min, max, choice };
  }

  /** Every loop iteration over `body` must match in exactly one way. */
  private requireUnique(body: Alternative[]): void {
    if (body.length > 1) {
      const firsts: CharSet[] = [];
      for (const alternative of body) {
        if (nullable(alternative)) throw new Unreadable('an alternation under a quantifier with a branch that can match nothing');
        firsts.push(firstSet(alternative));
      }
      for (let a = 0; a < firsts.length; a++) {
        for (let b = a + 1; b < firsts.length; b++) {
          const left = firsts[a]!;
          const right = firsts[b]!;
          if (left === null || right === null || intersects(left, right)) {
            throw new Unreadable('an alternation under a quantifier whose branches can begin alike');
          }
        }
      }
    }
    for (const alternative of body) {
      for (const term of alternative) {
        if (term.min !== term.max) throw new Unreadable('a quantifier nested inside another');
        if (term.atom.kind === 'backref') throw new Unreadable('a backreference under a quantifier');
        if (term.atom.kind === 'group') this.requireUnique(term.atom.body);
      }
    }
  }

  private quantifier(): { min: number; max: number } | undefined {
    const c = this.peek();
    let range: { min: number; max: number } | undefined;
    if (c === '*') range = { min: 0, max: Number.POSITIVE_INFINITY };
    else if (c === '+') range = { min: 1, max: Number.POSITIVE_INFINITY };
    else if (c === '?') range = { min: 0, max: 1 };
    else if (c === '{') {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.source.slice(this.i));
      if (!match) return undefined;
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[3] === '' ? Number.POSITIVE_INFINITY : Number(match[3]!);
      this.i += match[0].length - 1;
      range = { min, max };
    }
    if (!range) return undefined;
    this.i++;
    if (this.peek() === '?') this.i++;
    return range;
  }

  private atom(): Node {
    const c = this.peek();
    switch (c) {
      case '^':
        this.i++;
        return { kind: 'assert', start: true };
      case '$':
        this.i++;
        return { kind: 'assert', start: false };
      case '.':
        this.i++;
        return { kind: 'char', set: this.dotAll ? ALL : complement(LINE_TERMINATORS) };
      case '(':
        return this.group();
      case '[':
        return { kind: 'char', set: this.characterClass() };
      case '\\':
        return this.escape();
      default: {
        const point = this.codePointAt(this.i);
        this.i += point > 0xffff ? 2 : 1;
        return { kind: 'char', set: this.fold([point, point]) };
      }
    }
  }

  private group(): Node {
    this.i++;
    if (this.source.startsWith('?', this.i)) {
      const opener = /^\?(?::|=|!|<=|<!|<[^>]*>|[ims]*(?:-[ims]*)?:)/.exec(this.source.slice(this.i));
      if (!opener) throw new Unreadable('a group this reader does not know');
      this.i += opener[0].length;
    }
    const body = this.disjunction();
    if (this.peek() !== ')') throw new Unreadable('an unclosed group');
    this.i++;
    return { kind: 'group', body };
  }

  private escape(): Node {
    this.i++;
    const c = this.peek();
    if (c === undefined) throw new Unreadable('a trailing backslash');
    this.i++;
    switch (c) {
      case 'd':
        return { kind: 'char', set: DIGITS };
      case 'D':
        return { kind: 'char', set: complement(DIGITS) };
      case 'w':
        return { kind: 'char', set: this.ignoreCase && this.unicode ? WORD_FOLDED : WORD };
      case 'W':
        return { kind: 'char', set: complement(this.ignoreCase && this.unicode ? WORD_FOLDED : WORD) };
      case 's':
        return { kind: 'char', set: SPACE };
      case 'S':
        return { kind: 'char', set: complement(SPACE) };
      case 'b':
      case 'B':
        return { kind: 'assert', start: false };
      case 'k':
        if (this.peek() === '<') {
          const close = this.source.indexOf('>', this.i);
          if (close < 0) throw new Unreadable('an unclosed group name');
          this.i = close + 1;
        }
        return { kind: 'backref' };
      case 'p':
      case 'P':
        this.skipPropertyName();
        return { kind: 'char', set: null };
      default: {
        if (c >= '1' && c <= '9') {
          while (/\d/.test(this.peek() ?? '')) this.i++;
          return { kind: 'backref' };
        }
        this.i--;
        const point = this.escapedCodePoint();
        return { kind: 'char', set: point === undefined ? null : this.fold([point, point]) };
      }
    }
  }

  private skipPropertyName(): void {
    if (this.peek() !== '{') return;
    const close = this.source.indexOf('}', this.i);
    if (close < 0) throw new Unreadable('an unclosed property escape');
    this.i = close + 1;
  }

  /** The code point an escape denotes, `this.i` on the character after the backslash; `undefined` when it is no single character. */
  private escapedCodePoint(): number | undefined {
    const c = this.peek()!;
    this.i++;
    switch (c) {
      case 't':
        return 0x09;
      case 'n':
        return 0x0a;
      case 'v':
        return 0x0b;
      case 'f':
        return 0x0c;
      case 'r':
        return 0x0d;
      case '0':
        return 0;
      case 'c': {
        const letter = this.peek();
        if (letter !== undefined && /[a-zA-Z]/.test(letter)) {
          this.i++;
          return letter.charCodeAt(0) % 32;
        }
        return undefined;
      }
      case 'x': {
        const hex = /^[0-9a-fA-F]{2}/.exec(this.source.slice(this.i));
        if (!hex) return c.charCodeAt(0);
        this.i += 2;
        return Number.parseInt(hex[0], 16);
      }
      case 'u': {
        const braced = /^\{([0-9a-fA-F]+)\}/.exec(this.source.slice(this.i));
        if (braced && this.unicode) {
          this.i += braced[0].length;
          return Number.parseInt(braced[1]!, 16);
        }
        const hex = /^[0-9a-fA-F]{4}/.exec(this.source.slice(this.i));
        if (!hex) return c.charCodeAt(0);
        this.i += 4;
        let point = Number.parseInt(hex[0], 16);
        if (this.unicode && point >= 0xd800 && point <= 0xdbff) {
          const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(this.source.slice(this.i));
          if (low) {
            this.i += low[0].length;
            point = 0x10000 + ((point - 0xd800) << 10) + (Number.parseInt(low[1]!, 16) - 0xdc00);
          }
        }
        return point;
      }
      default: {
        const point = this.codePointAt(this.i - 1);
        if (point > 0xffff) this.i++;
        return point;
      }
    }
  }

  private characterClass(): CharSet {
    this.i++;
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.i++;
    }
    let set: readonly number[] = [];
    let unknown = false;
    const add = (piece: number | CharSet): void => {
      const folded = typeof piece === 'number' ? this.fold([piece, piece]) : piece;
      if (folded === null) unknown = true;
      else set = union(set, folded);
    };
    while (this.i < this.source.length && this.peek() !== ']') {
      const c = this.peek()!;
      if (this.unicodeSets && (c === '[' || this.source.startsWith('--', this.i) || this.source.startsWith('&&', this.i))) {
        // Nested classes and set operations are not spelled out; the class is unknown.
        unknown = true;
        this.skipUnicodeSetsClass();
        continue;
      }
      const lo = this.classAtom();
      if (this.peek() === '-' && this.i + 1 < this.source.length && this.source[this.i + 1] !== ']') {
        this.i++;
        const hi = this.classAtom();
        if (typeof lo === 'number' && typeof hi === 'number') {
          add(this.fold([lo, hi]));
        } else {
          // `[\d-x]`: a class escape beside a hyphen is three atoms.
          add(lo);
          add(0x2d);
          add(hi);
        }
        continue;
      }
      add(lo);
    }
    if (this.peek() !== ']') throw new Unreadable('an unclosed character class');
    this.i++;
    if (unknown) return null;
    return negated ? complement(set) : set;
  }

  /** Under `v`, everything up to the bracket closing the class being read. */
  private skipUnicodeSetsClass(): void {
    let depth = 0;
    while (this.i < this.source.length) {
      const c = this.peek();
      if (c === '\\') {
        this.i += 2;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        if (depth === 0) return;
        depth--;
      }
      this.i++;
    }
  }

  /** One class atom: a code point, a class escape's set, or `null` when unknown. */
  private classAtom(): number | CharSet {
    const c = this.peek()!;
    if (c !== '\\') {
      const point = this.codePointAt(this.i);
      this.i += point > 0xffff ? 2 : 1;
      return point;
    }
    this.i++;
    const e = this.peek();
    if (e === undefined) throw new Unreadable('a trailing backslash');
    switch (e) {
      case 'd':
        this.i++;
        return DIGITS;
      case 'D':
        this.i++;
        return complement(DIGITS);
      case 'w':
        this.i++;
        return this.ignoreCase && this.unicode ? WORD_FOLDED : WORD;
      case 'W':
        this.i++;
        return complement(this.ignoreCase && this.unicode ? WORD_FOLDED : WORD);
      case 's':
        this.i++;
        return SPACE;
      case 'S':
        this.i++;
        return complement(SPACE);
      case 'b':
        this.i++;
        return 0x08;
      case 'p':
      case 'P':
        this.i++;
        this.skipPropertyName();
        return null;
      default:
        return this.escapedCodePoint() ?? null;
    }
  }

  /** Case folding for `i`: ASCII letters carry their other case; a cased character beyond ASCII makes the set unknown. */
  private fold(range: readonly number[]): CharSet {
    if (!this.ignoreCase) return range;
    let set: readonly number[] = range;
    for (let k = 0; k < range.length; k += 2) {
      const lo = range[k]!;
      const hi = range[k + 1]!;
      if (hi >= 0x80) {
        const from = Math.max(lo, 0x80);
        if (hi - from > 256) return null;
        for (let point = from; point <= hi; point++) {
          const char = String.fromCodePoint(point);
          if (char.toLowerCase() !== char || char.toUpperCase() !== char) return null;
        }
      }
      const upperLo = Math.max(lo, 0x41);
      const upperHi = Math.min(hi, 0x5a);
      if (upperLo <= upperHi) set = union(set, [upperLo + 0x20, upperHi + 0x20]);
      const lowerLo = Math.max(lo, 0x61);
      const lowerHi = Math.min(hi, 0x7a);
      if (lowerLo <= lowerHi) set = union(set, [lowerLo - 0x20, lowerHi - 0x20]);
      if (this.unicode) {
        if (contains(range, 0x6b) || contains(range, 0x4b)) set = union(set, [0x212a, 0x212a]);
        if (contains(range, 0x73) || contains(range, 0x53)) set = union(set, [0x017f, 0x017f]);
      }
    }
    return set;
  }

  private codePointAt(index: number): number {
    return this.unicode ? this.source.codePointAt(index)! : this.source.charCodeAt(index);
  }

  private peek(): string | undefined {
    return this.source[this.i];
  }
}

function startsAnchored(alternative: Alternative): boolean {
  const first = alternative[0];
  if (!first || first.min < 1) return false;
  if (first.atom.kind === 'assert') return first.atom.start;
  if (first.atom.kind === 'group') return first.atom.body.every((inner) => startsAnchored(inner));
  return false;
}

function nullable(alternative: Alternative): boolean {
  return alternative.every((term) => term.min === 0 || nullableAtom(term.atom));
}

function nullableAtom(atom: Node): boolean {
  switch (atom.kind) {
    case 'char':
      return false;
    case 'assert':
    case 'backref':
      return true;
    case 'group':
      return atom.body.some((alternative) => nullable(alternative));
  }
}

/** Every character a match of `alternative` can begin with; `null` when that cannot be spelled. */
function firstSet(alternative: Alternative): CharSet {
  let set: readonly number[] = [];
  for (const term of alternative) {
    const first = firstOfAtom(term.atom);
    if (first === null) return null;
    set = union(set, first);
    if (term.min >= 1 && !nullableAtom(term.atom)) return set;
  }
  return set;
}

function firstOfAtom(atom: Node): CharSet {
  switch (atom.kind) {
    case 'char':
      return atom.set;
    case 'assert':
      return [];
    case 'backref':
      return null;
    case 'group': {
      let set: readonly number[] = [];
      for (const alternative of atom.body) {
        const first = firstSet(alternative);
        if (first === null) return null;
        set = union(set, first);
      }
      return set;
    }
  }
}

// ---------------------------------------------------------------------------
// Range sets
// ---------------------------------------------------------------------------

function union(a: readonly number[], b: readonly number[]): readonly number[] {
  const pairs: [number, number][] = [];
  for (let k = 0; k < a.length; k += 2) pairs.push([a[k]!, a[k + 1]!]);
  for (let k = 0; k < b.length; k += 2) pairs.push([b[k]!, b[k + 1]!]);
  pairs.sort((x, y) => x[0] - y[0]);
  const out: number[] = [];
  for (const [lo, hi] of pairs) {
    if (out.length > 0 && lo <= out[out.length - 1]! + 1) {
      out[out.length - 1] = Math.max(out[out.length - 1]!, hi);
    } else {
      out.push(lo, hi);
    }
  }
  return out;
}

function complement(set: readonly number[]): readonly number[] {
  const out: number[] = [];
  let next = 0;
  for (let k = 0; k < set.length; k += 2) {
    if (set[k]! > next) out.push(next, set[k]! - 1);
    next = set[k + 1]! + 1;
  }
  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT);
  return out;
}

function intersects(a: readonly number[], b: readonly number[]): boolean {
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length) {
    if (a[x + 1]! < b[y]!) x += 2;
    else if (b[y + 1]! < a[x]!) y += 2;
    else return true;
  }
  return false;
}

function contains(set: readonly number[], point: number): boolean {
  let lo = 0;
  let hi = set.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (point < set[mid * 2]!) hi = mid - 1;
    else if (point > set[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}
