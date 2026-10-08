import * as t from '@babel/types';

export type Tier = 0 | 1 | 2 | 3;

export type NameKind =
  | 'var'
  | 'param'
  | 'fn'
  | 'class'
  | 'component'
  | 'hook'
  | 'type'
  | 'index'
  | 'property';

// ---------------------------------------------------------------------------
// Reserved and unsafe names
// ---------------------------------------------------------------------------

/**
 * Names that are lexically legal but still unsafe to introduce.
 *
 * `undefined`/`NaN`/`Infinity` are writable-looking globals whose shadowing
 * changes meaning silently; `arguments` and `eval` are restricted in strict mode
 * and inside class bodies even though the parser accepts them elsewhere.
 */
const UNSAFE_NAMES: ReadonlySet<string> = new Set([
  'arguments',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'this',
  'let',
  'static',
  'await',
  'yield',
  'async',
]);

/**
 * Contextual keywords in TypeScript. Several are only reserved in specific
 * positions, but introducing them as identifier names buys nothing and risks a
 * parse difference between the `ts` and `tsx` grammars.
 */
const TS_RESERVED: ReadonlySet<string> = new Set([
  'any',
  'never',
  'unknown',
  'declare',
  'namespace',
  'abstract',
  'asserts',
  'infer',
  'keyof',
  'readonly',
  'unique',
  'satisfies',
  'enum',
  'interface',
  'implements',
  'private',
  'protected',
  'public',
  'package',
  'override',
  'accessor',
  'out',
]);

/** Object identifiers whose members are reachable from outside the file. */
export const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set([
  'window',
  'globalThis',
  'self',
  'global',
  'top',
  'parent',
  'frames',
  'exports',
  'module',
]);

export function isReservedName(name: string, typescript: boolean): boolean {
  if (!t.isValidIdentifier(name)) return true;
  if (UNSAFE_NAMES.has(name)) return true;
  if (typescript && TS_RESERVED.has(name)) return true;
  return false;
}

/**
 * Own properties of a browser's `window` that a script-level `var` collides
 * with.
 *
 * A `var` at the top level of a script does not create a fresh slot when the
 * global object already has one - it reuses it. Most of the names below are
 * accessors, so the initialiser runs through a setter that coerces, ignores or
 * *acts on* the value: `var name = ['a','b']` reads back as the string `"a,b"`,
 * `var location = url` navigates, `var self = x` is silently dropped. None of
 * that is visible in the file, which is why it takes a list rather than an
 * analysis, and why the list is only consulted for the one binding shape that
 * shares the namespace (see `isGlobalObjectProperty`).
 *
 * Deliberately not exhaustive over the whole Window IDL: it holds the names our
 * own rules can plausibly emit. A name we never emit costs nothing to omit.
 */
const GLOBAL_OBJECT_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  'caches',
  'closed',
  'crypto',
  'devicePixelRatio',
  'document',
  'event',
  'external',
  'frameElement',
  'frames',
  'history',
  'indexedDB',
  'innerHeight',
  'innerWidth',
  'length',
  'localStorage',
  'location',
  'locationbar',
  'menubar',
  'name',
  'navigator',
  'opener',
  'origin',
  'outerHeight',
  'outerWidth',
  'pageXOffset',
  'pageYOffset',
  'parent',
  'performance',
  'personalbar',
  'screen',
  'screenLeft',
  'screenTop',
  'screenX',
  'screenY',
  'scrollX',
  'scrollY',
  'scrollbars',
  'self',
  'sessionStorage',
  'status',
  'statusbar',
  'toolbar',
  'top',
  'visualViewport',
  'window',
]);

export function isGlobalObjectPropertyName(name: string): boolean {
  return GLOBAL_OBJECT_PROPERTY_NAMES.has(name);
}

/**
 * Order two identifier-ish strings by code unit.
 *
 * Not `localeCompare`: that reads the host's default locale, which Node takes
 * from the OS, so the same input can order differently on two machines. Every
 * comparison in this layer decides which of several equally-scored names a
 * binding ends up with, and the layer's contract is that two runs of the same
 * build on the same input agree. Code-unit order is the same everywhere.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Rule tables
// ---------------------------------------------------------------------------

/** A08/A09: `new X()` where the constructor implies a better name than `x`. */
export const CTOR_ALIASES: ReadonlyMap<string, string> = new Map([
  ['WebSocket', 'socket'],
  ['XMLHttpRequest', 'xhr'],
  ['Image', 'img'],
  ['Audio', 'audio'],
  ['Worker', 'worker'],
  ['SharedWorker', 'worker'],
  ['Map', 'map'],
  ['Set', 'set'],
  ['WeakMap', 'cache'],
  ['WeakSet', 'seen'],
  ['Date', 'date'],
  ['RegExp', 're'],
  ['FormData', 'formData'],
  ['FileReader', 'reader'],
  ['AbortController', 'controller'],
  ['URL', 'url'],
  ['URLSearchParams', 'params'],
  ['Blob', 'blob'],
  ['File', 'file'],
  ['EventSource', 'source'],
  ['IntersectionObserver', 'observer'],
  ['MutationObserver', 'observer'],
  ['ResizeObserver', 'observer'],
  ['Promise', 'promise'],
  ['Error', 'error'],
  ['TypeError', 'error'],
  ['RangeError', 'error'],
  ['Event', 'event'],
  ['CustomEvent', 'event'],
  ['DataView', 'view'],
  ['ArrayBuffer', 'buffer'],
  ['SharedArrayBuffer', 'buffer'],
  ['Uint8Array', 'bytes'],
  ['Uint8ClampedArray', 'bytes'],
  ['Int8Array', 'bytes'],
  ['Uint16Array', 'shorts'],
  ['Int16Array', 'shorts'],
  ['Uint32Array', 'ints'],
  ['Int32Array', 'ints'],
  ['Float32Array', 'floats'],
  ['Float64Array', 'floats'],
  ['BigInt64Array', 'longs'],
  ['TextEncoder', 'encoder'],
  ['TextDecoder', 'decoder'],
  ['Headers', 'headers'],
  ['Request', 'request'],
  ['Response', 'response'],
  ['AudioContext', 'audioCtx'],
  ['OffscreenCanvas', 'canvas'],
]);

/** A20: module specifiers whose conventional local name is not the basename. */
export const MODULE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['react', 'React'],
  ['react-dom', 'ReactDOM'],
  ['react-dom/client', 'ReactDOM'],
  ['lodash', '_'],
  ['lodash-es', '_'],
  ['jquery', '$'],
  ['axios', 'axios'],
  ['path', 'path'],
  ['node:path', 'path'],
  ['fs', 'fs'],
  ['node:fs', 'fs'],
  ['crypto', 'crypto'],
  ['node:crypto', 'crypto'],
  ['prop-types', 'PropTypes'],
  ['classnames', 'classNames'],
]);

/** E07: a two-parameter function whose whole body is one operator. */
export const OP_NAMES: ReadonlyMap<string, string> = new Map([
  ['-', 'subtract'],
  ['+', 'add'],
  ['*', 'multiply'],
  ['/', 'divide'],
  ['%', 'mod'],
  ['**', 'power'],
  ['===', 'equals'],
  ['==', 'looseEquals'],
  ['!==', 'notEquals'],
  ['!=', 'looseNotEquals'],
  ['<', 'lessThan'],
  ['>', 'greaterThan'],
  ['<=', 'atMost'],
  ['>=', 'atLeast'],
  ['|', 'bitOr'],
  ['&', 'bitAnd'],
  ['^', 'bitXor'],
  ['<<', 'shiftLeft'],
  ['>>', 'shiftRight'],
  ['>>>', 'shiftRightUnsigned'],
  ['&&', 'and'],
  ['||', 'or'],
  ['??', 'coalesce'],
  ['in', 'isIn'],
  ['instanceof', 'isInstanceOf'],
]);

export interface DuckSignature {
  readonly id: string;
  readonly name: string;
  readonly props: readonly string[];
  readonly minHits: number;
  readonly tier: Tier;
  readonly score: number;
}

/** Family B: identify a value by the multiset of properties read off it. */
export const DUCK_SIGNATURES: readonly DuckSignature[] = [
  {
    id: 'B01',
    name: 'canvas',
    props: ['getContext', 'toDataURL', 'width', 'height'],
    minHits: 2,
    tier: 1,
    score: 88,
  },
  {
    id: 'B02',
    name: 'ctx',
    props: [
      'fillRect',
      'drawImage',
      'beginPath',
      'stroke',
      'fill',
      'save',
      'restore',
      'fillText',
      'closePath',
      'arc',
      'moveTo',
      'lineTo',
    ],
    minHits: 2,
    tier: 1,
    score: 90,
  },
  {
    id: 'B03',
    name: 'socket',
    props: ['send', 'readyState', 'onmessage', 'onopen', 'onclose', 'binaryType'],
    minHits: 2,
    tier: 1,
    score: 88,
  },
  {
    id: 'B05',
    name: 'event',
    props: ['preventDefault', 'stopPropagation', 'currentTarget', 'target'],
    minHits: 2,
    tier: 1,
    score: 86,
  },
  {
    id: 'B06',
    name: 'event',
    props: ['clientX', 'clientY', 'pageX', 'pageY', 'button', 'buttons'],
    minHits: 2,
    tier: 1,
    score: 84,
  },
  {
    id: 'B07',
    name: 'event',
    props: ['key', 'keyCode', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey'],
    minHits: 2,
    tier: 1,
    score: 84,
  },
  {
    id: 'B08',
    name: 'event',
    props: ['touches', 'changedTouches', 'identifier'],
    minHits: 2,
    tier: 1,
    score: 84,
  },
  { id: 'B09', name: 'error', props: ['message', 'stack'], minHits: 2, tier: 1, score: 82 },
  {
    id: 'B10',
    name: 'response',
    props: ['status', 'statusText', 'json', 'ok', 'headers'],
    minHits: 2,
    tier: 1,
    score: 86,
  },
  {
    id: 'B16',
    name: 'storage',
    props: ['getItem', 'setItem', 'removeItem'],
    minHits: 2,
    tier: 1,
    score: 84,
  },
  {
    id: 'B04',
    name: 'el',
    props: [
      'appendChild',
      'classList',
      'setAttribute',
      'innerHTML',
      'textContent',
      'removeChild',
      'getAttribute',
      'style',
    ],
    minHits: 2,
    tier: 2,
    score: 70,
  },
  { id: 'B12', name: 'promise', props: ['then', 'catch', 'finally'], minHits: 2, tier: 2, score: 72 },
  {
    id: 'B11',
    name: 'list',
    props: ['push', 'pop', 'shift', 'splice', 'slice', 'indexOf'],
    minHits: 2,
    tier: 2,
    score: 66,
  },
  { id: 'B15', name: 'rect', props: ['top', 'left', 'right', 'bottom'], minHits: 3, tier: 2, score: 64 },
  { id: 'B13', name: 'point', props: ['x', 'y', 'z'], minHits: 2, tier: 2, score: 60 },
  { id: 'B14', name: 'size', props: ['width', 'height'], minHits: 2, tier: 2, score: 60 },
];

export interface ArgPositionRule {
  readonly id: string;
  /** Dotted callee text, e.g. `document.getElementById` or a bare method name. */
  readonly callee: string;
  readonly index: number;
  readonly name: string;
  readonly tier: Tier;
  readonly score: number;
}

/** Family C: the callee plus the argument slot names the value being passed. */
const ARG_POSITION_LIST: readonly ArgPositionRule[] = [
  { id: 'C03', callee: 'setTimeout', index: 0, name: 'callback', tier: 2, score: 70 },
  { id: 'C03', callee: 'setInterval', index: 0, name: 'tick', tier: 2, score: 70 },
  { id: 'C03', callee: 'requestAnimationFrame', index: 0, name: 'render', tier: 2, score: 68 },
  { id: 'C02', callee: 'addEventListener', index: 0, name: 'eventType', tier: 2, score: 66 },
  { id: 'C01', callee: 'addEventListener', index: 1, name: 'handler', tier: 1, score: 74 },
  { id: 'C01', callee: 'removeEventListener', index: 1, name: 'handler', tier: 1, score: 74 },
  { id: 'C06', callee: 'JSON.stringify', index: 0, name: 'data', tier: 2, score: 60 },
  { id: 'C06', callee: 'JSON.parse', index: 0, name: 'json', tier: 2, score: 66 },
  { id: 'C07', callee: 'fetch', index: 0, name: 'url', tier: 1, score: 84 },
  { id: 'C20', callee: 'appendChild', index: 0, name: 'child', tier: 2, score: 64 },
  { id: 'C20', callee: 'append', index: 0, name: 'node', tier: 2, score: 58 },
  { id: 'C20', callee: 'removeChild', index: 0, name: 'child', tier: 2, score: 64 },
  { id: 'C21', callee: 'send', index: 0, name: 'message', tier: 2, score: 66 },
  { id: 'C22', callee: 'parseInt', index: 0, name: 'raw', tier: 3, score: 45 },
  { id: 'C23', callee: 'parseInt', index: 1, name: 'radix', tier: 1, score: 84 },
  { id: 'C24', callee: 'slice', index: 0, name: 'start', tier: 2, score: 62 },
  { id: 'C24', callee: 'slice', index: 1, name: 'end', tier: 2, score: 60 },
  { id: 'C24', callee: 'substring', index: 0, name: 'start', tier: 2, score: 62 },
  { id: 'C24', callee: 'substring', index: 1, name: 'end', tier: 2, score: 60 },
  { id: 'C25', callee: 'charAt', index: 0, name: 'index', tier: 2, score: 70 },
  { id: 'C25', callee: 'charCodeAt', index: 0, name: 'index', tier: 2, score: 70 },
  { id: 'C26', callee: 'split', index: 0, name: 'separator', tier: 2, score: 66 },
  { id: 'C26', callee: 'join', index: 0, name: 'separator', tier: 2, score: 66 },
  { id: 'C27', callee: 'replace', index: 0, name: 'pattern', tier: 2, score: 64 },
  { id: 'C27', callee: 'replace', index: 1, name: 'replacement', tier: 2, score: 62 },
  { id: 'C28', callee: 'push', index: 0, name: 'item', tier: 2, score: 58 },
  // The reflective spellings an obfuscator reaches for when it hides a call.
  { id: 'C29', callee: 'Reflect.apply', index: 0, name: 'target', tier: 1, score: 84 },
  { id: 'C29', callee: 'Reflect.apply', index: 2, name: 'args', tier: 1, score: 82 },
  { id: 'C29', callee: 'Reflect.construct', index: 0, name: 'target', tier: 1, score: 84 },
  { id: 'C29', callee: 'Reflect.construct', index: 1, name: 'args', tier: 1, score: 82 },
  { id: 'C30', callee: 'Reflect.get', index: 0, name: 'target', tier: 1, score: 82 },
  { id: 'C30', callee: 'Reflect.get', index: 1, name: 'key', tier: 1, score: 80 },
  { id: 'C30', callee: 'Reflect.set', index: 0, name: 'target', tier: 1, score: 82 },
  { id: 'C30', callee: 'Reflect.set', index: 1, name: 'key', tier: 1, score: 80 },
  { id: 'C30', callee: 'Reflect.has', index: 0, name: 'target', tier: 1, score: 82 },
  { id: 'C30', callee: 'Reflect.has', index: 1, name: 'key', tier: 1, score: 80 },
  { id: 'C31', callee: 'Object.defineProperty', index: 0, name: 'target', tier: 1, score: 82 },
  { id: 'C31', callee: 'Object.defineProperty', index: 1, name: 'key', tier: 1, score: 80 },
  { id: 'C31', callee: 'Object.defineProperty', index: 2, name: 'descriptor', tier: 1, score: 84 },
  { id: 'C31', callee: 'Object.assign', index: 0, name: 'target', tier: 2, score: 70 },
  { id: 'C22', callee: 'parseFloat', index: 0, name: 'raw', tier: 3, score: 45 },
  { id: 'C22', callee: 'Number', index: 0, name: 'raw', tier: 3, score: 45 },
];

/**
 * The same rules, indexed by the callee text they match.
 *
 * A call site asks for two spellings - the dotted one and the bare method -
 * and the list is scanned once per site otherwise, which is a scan of every
 * rule for every argument of every binding on a file with a hundred thousand
 * call sites.
 */
export const ARG_POSITION_RULES: ReadonlyMap<string, readonly ArgPositionRule[]> = (() => {
  const byCallee = new Map<string, ArgPositionRule[]>();
  for (const rule of ARG_POSITION_LIST) {
    const bucket = byCallee.get(rule.callee);
    if (bucket) bucket.push(rule);
    else byCallee.set(rule.callee, [rule]);
  }
  return byCallee;
})();

export interface CallResultRule {
  readonly id: string;
  readonly name: string;
  readonly tier: Tier;
  readonly score: number;
}

/** Rules of the form `x = <known call>(...)` where the callee fixes the name. */
export const CALL_RESULT_RULES: ReadonlyMap<string, CallResultRule> = new Map([
  ['setTimeout', { id: 'C04', name: 'timeoutId', tier: 1, score: 86 }],
  ['setInterval', { id: 'C04', name: 'intervalId', tier: 1, score: 86 }],
  ['requestAnimationFrame', { id: 'C05', name: 'frameId', tier: 1, score: 86 }],
  ['Date.now', { id: 'G07', name: 'timestamp', tier: 1, score: 84 }],
  ['performance.now', { id: 'G08', name: 'startTime', tier: 1, score: 84 }],
  ['Math.random', { id: 'G09', name: 'rand', tier: 1, score: 82 }],
  ['JSON.stringify', { id: 'A21', name: 'json', tier: 1, score: 76 }],
  ['document.createDocumentFragment', { id: 'A04', name: 'fragment', tier: 1, score: 84 }],
  ['document.createTextNode', { id: 'A04', name: 'textNode', tier: 1, score: 84 }],
]);

/**
 * Methods no value but a string has.
 *
 * `slice`, `indexOf`, `includes` and `length` are shared with arrays and are
 * deliberately absent: the point of this set is that one hit settles the
 * question, so a method that two kinds of value answer to belongs in a
 * multi-hit signature instead.
 */
export const TEXT_METHODS: ReadonlySet<string> = new Set([
  'charAt',
  'charCodeAt',
  'codePointAt',
  'toUpperCase',
  'toLowerCase',
  'substring',
  'substr',
  'trim',
  'trimStart',
  'trimEnd',
  'padStart',
  'padEnd',
  'startsWith',
  'endsWith',
  'split',
  'replace',
  'replaceAll',
  'match',
  'matchAll',
  'normalize',
  'repeat',
  'localeCompare',
]);

/**
 * Methods that take a callback over the elements of a list, and nothing else
 * answers to with a callback: `.map(fn)`, `.reduce(fn)`. `find` and `filter`
 * are here on that condition - a query model's `.find({ id })` takes an
 * object, and `LIST_METHODS` is asked only of a call whose first argument is
 * a function. `sort` and `flat` are absent: the first takes no callback as
 * often as it takes one, the second none at all.
 */
export const LIST_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
]);

/**
 * The parameters of each Proxy handler trap, in the order the language calls
 * them with. `key` where the specification says "property", the word the
 * `Reflect.*` rules use for the same argument.
 */
export const PROXY_TRAPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['get', ['target', 'key', 'receiver']],
  ['set', ['target', 'key', 'value', 'receiver']],
  ['has', ['target', 'key']],
  ['deleteProperty', ['target', 'key']],
  ['defineProperty', ['target', 'key', 'descriptor']],
  ['getOwnPropertyDescriptor', ['target', 'key']],
  ['ownKeys', ['target']],
  ['getPrototypeOf', ['target']],
  ['setPrototypeOf', ['target', 'proto']],
  ['isExtensible', ['target']],
  ['preventExtensions', ['target']],
  ['apply', ['target', 'thisArg', 'args']],
  ['construct', ['target', 'args', 'newTarget']],
]);

/** Iteration callbacks whose parameter positions have fixed conventional names. */
export const ITERATOR_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'forEach',
  'find',
  'findIndex',
  'some',
  'every',
  'flatMap',
]);

/** Prefixes stripped from a getter name before it becomes a variable name (D07). */
const GETTER_PREFIXES = ['get', 'fetch', 'read', 'compute', 'load', 'build', 'make', 'create'];

/** HTML tags recognised so `getElementById('chtCanvas')` keeps its own name. */
export const DOM_TAGS: ReadonlySet<string> = new Set([
  'a',
  'button',
  'canvas',
  'div',
  'form',
  'iframe',
  'img',
  'input',
  'label',
  'li',
  'link',
  'nav',
  'ol',
  'option',
  'p',
  'script',
  'section',
  'select',
  'span',
  'svg',
  'table',
  'td',
  'textarea',
  'th',
  'tr',
  'ul',
  'video',
  'audio',
  'header',
  'footer',
  'main',
  'aside',
  'dialog',
  'menu',
  'box',
  'panel',
  'container',
  'wrapper',
  'element',
  'node',
  'bar',
  'list',
  'icon',
  'modal',
  'overlay',
  'field',
]);

/** Words that already say "DOM element", so appending `El` would stutter. */
const ELEMENT_SUFFIXES = ['el', 'element', 'node', 'dom'];

// ---------------------------------------------------------------------------
// Name formatting
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 32;

/** Split an arbitrary string into lowercase words on punctuation and case runs. */
export function words(raw: string): string[] {
  const cleaned = raw.replace(/[^A-Za-z0-9]+/g, ' ');
  const out: string[] = [];
  for (const chunk of cleaned.split(' ')) {
    if (chunk.length === 0) continue;
    // Split `XMLHttpRequest` into `XML`, `Http`, `Request` and `foo2Bar` into `foo2`, `Bar`.
    const parts = chunk.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[0-9]+|[A-Z]/g);
    if (parts) for (const part of parts) out.push(part.toLowerCase());
    else out.push(chunk.toLowerCase());
  }
  return out;
}

export function toCamel(raw: string): string {
  const parts = words(raw);
  if (parts.length === 0) return '';
  const head = parts[0]!;
  let result = head;
  for (let i = 1; i < parts.length; i++) result += upperFirst(parts[i]!);
  return truncate(result);
}

export function toPascal(raw: string): string {
  return upperFirst(toCamel(raw));
}

export function upperFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function lowerFirst(value: string): string {
  if (value.length === 0) return value;
  // `URLParams` should become `urlParams`, not `uRLParams`.
  const lead = /^[A-Z]+(?![a-z])/.exec(value);
  if (lead && lead[0].length > 1) {
    return lead[0].slice(0, -1).toLowerCase() + value.slice(lead[0].length - 1);
  }
  return value[0]!.toLowerCase() + value.slice(1);
}

function truncate(value: string): string {
  return value.length <= MAX_NAME_LENGTH ? value : value.slice(0, MAX_NAME_LENGTH);
}

/** Turn a decoded string into a camelCase identifier, or `undefined` if it cannot be one. */
export function identFromString(raw: string): string | undefined {
  const camel = toCamel(raw);
  if (camel.length === 0) return undefined;
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel;
  return t.isValidIdentifier(safe, false) ? truncate(safe) : undefined;
}

/** Strip a trailing `El`/`Element` so `canvasEl.getContext()` yields `canvasCtx`. */
export function stripElementSuffix(name: string): string {
  const parts = words(name);
  if (parts.length > 1 && ELEMENT_SUFFIXES.includes(parts[parts.length - 1]!)) {
    return toCamel(parts.slice(0, -1).join(' '));
  }
  return name;
}

/** Whether appending `El` would be redundant because the name already ends in a tag word. */
export function endsWithElementWord(raw: string): boolean {
  const parts = words(raw);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1]!;
  return DOM_TAGS.has(last) || ELEMENT_SUFFIXES.includes(last);
}

/** D07: `y.getFoo()` names its result `foo`, not `getFoo`. */
export function stripGetterPrefix(method: string): string {
  const parts = words(method);
  if (parts.length > 1 && GETTER_PREFIXES.includes(parts[0]!)) {
    return toCamel(parts.slice(1).join(' '));
  }
  return toCamel(method);
}

// ---------------------------------------------------------------------------
// Inflection
// ---------------------------------------------------------------------------

const IRREGULAR: ReadonlyArray<readonly [string, string]> = [
  ['children', 'child'],
  ['people', 'person'],
  ['men', 'man'],
  ['women', 'woman'],
  ['teeth', 'tooth'],
  ['feet', 'foot'],
  ['mice', 'mouse'],
  ['geese', 'goose'],
  ['oxen', 'ox'],
  ['indices', 'index'],
  ['indexes', 'index'],
  ['vertices', 'vertex'],
  ['matrices', 'matrix'],
  ['appendices', 'appendix'],
  ['criteria', 'criterion'],
  ['phenomena', 'phenomenon'],
  ['analyses', 'analysis'],
  ['bases', 'basis'],
  ['crises', 'crisis'],
  ['theses', 'thesis'],
  ['axes', 'axis'],
  ['diagnoses', 'diagnosis'],
  ['parentheses', 'parenthesis'],
  ['hypotheses', 'hypothesis'],
  ['leaves', 'leaf'],
  ['lives', 'life'],
  ['knives', 'knife'],
  ['wives', 'wife'],
  ['halves', 'half'],
  ['selves', 'self'],
  ['shelves', 'shelf'],
  ['wolves', 'wolf'],
  ['thieves', 'thief'],
  ['loaves', 'loaf'],
  ['calves', 'calf'],
  ['elves', 'elf'],
  ['aliases', 'alias'],
  ['statuses', 'status'],
  ['buses', 'bus'],
  ['quizzes', 'quiz'],
];

const PLURAL_TO_SINGULAR: ReadonlyMap<string, string> = new Map(IRREGULAR);
const SINGULAR_TO_PLURAL: ReadonlyMap<string, string> = new Map(
  IRREGULAR.map(([p, s]) => [s, p] as const),
);

/** Words whose singular and plural are identical; inflecting them makes noise. */
const UNCOUNTABLE: ReadonlySet<string> = new Set([
  'data',
  'info',
  'news',
  'series',
  'species',
  'media',
  'equipment',
  'software',
  'audio',
  'video',
  'text',
  'json',
  'config',
  'meta',
  'props',
  'css',
  'html',
]);

function inflectLastWord(name: string, transform: (word: string) => string): string {
  const parts = words(name);
  if (parts.length === 0) return name;
  const last = parts[parts.length - 1]!;
  if (UNCOUNTABLE.has(last)) return toCamel(name);
  const replaced = transform(last);
  if (replaced === last) return toCamel(name);
  return toCamel([...parts.slice(0, -1), replaced].join(' '));
}

export function singular(name: string): string {
  return inflectLastWord(name, (word) => {
    const irregular = PLURAL_TO_SINGULAR.get(word);
    if (irregular) return irregular;
    if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
    if (/(ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
    if (/(?:ss|us|is|s)s$/.test(word)) return word;
    if (/[^s]s$/.test(word)) return word.slice(0, -1);
    return word;
  });
}

export function plural(name: string): string {
  return inflectLastWord(name, (word) => {
    const irregular = SINGULAR_TO_PLURAL.get(word);
    if (irregular) return irregular;
    if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
    if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
    if (/s$/.test(word)) return word;
    return `${word}s`;
  });
}

// ---------------------------------------------------------------------------
// Misc classification helpers
// ---------------------------------------------------------------------------

const URL_PATTERN = /^(?:https?:)?\/\//;
const PATH_PATTERN = /^\.{0,2}\/[\w./-]+$/;
const SELECTOR_PATTERN = /^[#.][A-Za-z_][\w-]*$/;

export function looksLikeUrl(value: string): boolean {
  return URL_PATTERN.test(value);
}

export function looksLikePath(value: string): boolean {
  return PATH_PATTERN.test(value);
}

export function looksLikeSelector(value: string): boolean {
  return SELECTOR_PATTERN.test(value);
}

export function basenameNoExt(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Last non-empty path segment of a module specifier, for A19. */
export function lastPathSegment(specifier: string): string {
  const parts = specifier.split('/').filter((part) => part.length > 0 && !part.startsWith('@'));
  return parts[parts.length - 1] ?? specifier;
}
