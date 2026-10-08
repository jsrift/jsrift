import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { whitelist } from '../src/analysis/evaluator/builtins.js';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import {
  createInterpreter,
  InterpreterRefusal,
  UnsupportedSyntaxError,
} from '../src/analysis/evaluator/interpreter.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The interpreter's whitelist, closed.
 *
 * Closing the shapes one list names only exposes the adjacent ones, because
 * "what the interpreter computes exactly" is otherwise an enumeration that
 * grows. This file makes it a rule with two halves,
 * and proves each half by running it:
 *
 *  1. EVERYTHING LISTED IS V8-EXACT OR A NAMED REFUSAL. `whitelist()` hands
 *     back the interpreter's tables - every global, every prototype key,
 *     every constructor static, every namespace member - and the first block
 *     walks them: an entry with no probe below fails the suite, and each
 *     probe is computed by the V8 this test runs on and compared, or is
 *     marked as a refusal and shown to be one.
 *
 *  2. EVERYTHING UNLISTED REFUSES. A read, write, `in`, `delete`,
 *     enumeration or conversion that reaches past a table is refused, never
 *     answered `undefined` - with the one exception of `Object.prototype`,
 *     whose key set is known in full, so a plain object's missing key stays
 *     the exact `undefined` a decoder's cache lookup needs.
 *
 * The last block runs each hole closed this round as a decoder gated on it,
 * through the whole pipeline at every preset, and executes input and output
 * in a realm holding only `log`: the wrong string may not be printed, whether
 * the interpreter computed V8's answer or refused.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`;
  return String(value);
}

/** Run in a realm holding nothing but `log`, and record everything observable. */
function execute(code: string, timeout = 2_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

/** Deobfuscate and prove the output does what the input does. */
async function expectSameBehaviour(source: string, options: DeobfuscateOptions = {}): Promise<string> {
  const result = await deobfuscate(source, { preset: 'balanced', ...options });
  const before = execute(source);
  const after = execute(result.code);
  expect(after).toBe(before);
  return result.code;
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programPath(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source, {});
  let found: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  if (!found) throw new Error('no Program path');
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], options: Parameters<typeof resolveConfig>[0] = {}) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
}

/**
 * Run a function body in the interpreter, as a sloppy script, and hand back
 * what it returns. The source goes along so `Function.prototype.toString`
 * answers with the program's own bytes, as it does in the pipeline.
 */
function interpret(body: string, options: { strict?: boolean; module?: boolean } = {}): unknown {
  const source = `var __result = (function () {\n${body}\n})();`;
  const statements = parse(source, { sourceType: 'script' }).program.body;
  return createInterpreter(statements, { source, ...options }).read('__result');
}

/** The same body, run by the V8 this test runs on, in a bare realm (plus the host's `atob`/`btoa`, which V8 itself lacks). */
function v8(body: string): unknown {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, vm.createContext({ atob, btoa }));
}

/** A value as the failure message shows it: `undefined` spelled out, not dropped. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item === undefined ? '<undefined>' : typeof item === 'number' && !Number.isFinite(item) ? String(item) : item,
  );
}

/** V8's answer as data: `undefined` inside arrays survives the comparison as a marker. */
function expectSameAsV8(body: string): void {
  let expected: unknown;
  try {
    expected = v8(body);
  } catch (error) {
    throw new Error(`the probe must not throw under V8, and it did: ${(error as Error).message}\n${body}`);
  }
  const actual = interpret(body);
  expect(actual, `${body}\n  interpreter: ${show(actual)}\n  V8:          ${show(expected)}`).toEqual(expected);
}

/** V8 computes a value for the body; the interpreter refuses it. */
function expectRefusal(body: string): void {
  let error: unknown;
  try {
    v8(body);
  } catch (caught) {
    error = caught;
  }
  expect(error, `the probe must not throw under V8, and it did:\n${body}`).toBeUndefined();
  expect(() => interpret(body), body).toThrow(InterpreterRefusal);
}

/** The expression's value, or the name and message of what it throws: V8 and the interpreter agree on the throw too. */
const attempt = (expression: string): string =>
  `(function () { try { return ${expression}; } catch (e) { return e.name + ': ' + e.message; } })()`;

// ---------------------------------------------------------------------------
// 1. Everything listed: a V8 probe per entry, or a named refusal
// ---------------------------------------------------------------------------

/** Marks an entry whose whole point is to refuse; `body` still computes under V8. */
const REFUSES = Symbol('refuses');
type Probe = string | { [REFUSES]: string };
const refuses = (body: string): Probe => ({ [REFUSES]: body });

/**
 * One probe per whitelist entry, keyed `table.key`. Each is a function body:
 * a plain one returns the same value under V8 and the interpreter; a
 * `refuses` one returns a value under V8 and is refused by the interpreter.
 */
const PROBES: Record<string, Probe> = {
  // -- globals
  'globals.undefined': 'return [undefined, typeof undefined, void 0 === undefined];',
  'globals.NaN': 'return [NaN !== NaN, typeof NaN, isNaN(NaN), Number.isNaN(NaN), String(NaN)];',
  'globals.Infinity': 'return [Infinity, -Infinity, 1 / 0 === Infinity, String(Infinity), Infinity - Infinity];',
  'globals.String': "return [String(1), String(null), String(undefined), String([1, [2]]), String(true), String(), String(-0), String(1e21), String(0.1 + 0.2), typeof String, String.length, String.name];",
  'globals.Number': "return [Number('42'), Number(''), Number(' 0x1f '), Number('1e3'), Number(null), Number(undefined), Number(true), Number([]), Number([7]), Number([1, 2]), Number('12px'), Number('-0'), Number(), Number('Infinity'), Number('0b101'), Number('0o17')];",
  'globals.Boolean': "return [Boolean(0), Boolean(''), Boolean('0'), Boolean([]), Boolean({}), Boolean(NaN), Boolean(null), Boolean(), Boolean(-0)];",
  'globals.Array': "return [Array(3).length, 0 in Array(3), Array(1, 2), Array('3'), Array(), Array.length, Array.name, Array(0).length, " + attempt('Array(-1)') + '];',
  'globals.Object': "return [typeof Object(), typeof Object(null), typeof Object(undefined), Object.keys(Object({ a: 1 })), Object.length, Object.name, Object([1]).length, typeof Object(function () {})];",
  'globals.RegExp': "return [RegExp('a').source, RegExp('a', 'g').flags, new RegExp(/x/i).flags, new RegExp(/x/i, 'g').flags, new RegExp().source, new RegExp(undefined).source, new RegExp(null).source, RegExp.length, RegExp.name, (function () { var r = /a/; return RegExp(r) === r; })(), (function () { var r = /a/; return RegExp(r, 'g') === r; })(), (function () { var r = /a/; return new RegExp(r) === r; })(), String(new RegExp('a', 'gi'))];",
  'globals.Date': "return [new Date(0).getTime(), new Date(1.5).getTime(), new Date('2020-01-02').getTime(), new Date('2020-01-02T03:04:05.678Z').getTime(), new Date('2020-01-02T03:04:05+02:00').getTime(), new Date(8.64e15 + 1).getTime(), new Date(null).getTime(), new Date(new Date(7)).getTime(), new Date(NaN).getTime(), Date.length, Date.name];",
  'globals.Math': "return [typeof Math, Math.PI, Object.prototype.toString.call(Math), Math instanceof Object, '' + Math, Math == '[object Math]', Math.hasOwnProperty('PI'), 'PI' in Math];",
  'globals.JSON': "return [typeof JSON, Object.prototype.toString.call(JSON), '' + JSON, JSON instanceof Object];",
  'globals.Error': "return [new Error('m').message, new Error('m').name, Error('m').message, new Error().message, new Error().hasOwnProperty('message'), new Error('').hasOwnProperty('message'), new Error('m').hasOwnProperty('name'), new Error('m') instanceof Error, String(new Error('m')), '' + Error(), Error.length, Error.name, new Error('m').hasOwnProperty('stack'), 'stack' in new Error(), (function () { var e = new Error('m'); e.name = 'X'; return [e.name, e.hasOwnProperty('name'), String(e)]; })(), (function () { var e = new Error('m'); e.name = ''; return String(e); })(), (function () { var e = new Error(''); e.name = ''; return String(e); })(), (function () { var e = new Error('m'); e.name = 5; return [e.name, String(e)]; })(), (function () { var e = new Error('m'); e.message = 5; return [e.message, String(e)]; })(), (function () { var e = new Error('m'); delete e.message; return [e.message, e.hasOwnProperty('message'), String(e)]; })(), (function () { var e = new TypeError('m'); e.name = 'Q'; delete e.name; return [e.name, e.hasOwnProperty('name')]; })(), new Error(undefined).hasOwnProperty('message'), new Error(5).message, Object.keys(new Error('m')), JSON.stringify(new Error('m')), typeof new Error('m').toString, new Error('m').toString === Error.prototype.toString];",
  'globals.TypeError': "return [new TypeError('m').name, new TypeError('m') instanceof TypeError, new TypeError('m') instanceof Error, new TypeError('m') instanceof RangeError, new Error('m') instanceof TypeError, String(new TypeError('m')), (function () { var e = new TypeError('m'); e.name = 'RangeError'; return [e instanceof RangeError, e instanceof TypeError]; })(), TypeError.name, TypeError.length, (function () { try { null.x; } catch (e) { return [e instanceof TypeError, e.name]; } })()];",
  'globals.RangeError': "return [new RangeError('m').name, new RangeError('m') instanceof RangeError, new RangeError('m') instanceof Error, String(RangeError('x')), (function () { try { 'a'.repeat(-1); } catch (e) { return [e instanceof RangeError, e.name]; } })()];",
  'globals.SyntaxError': "return [new SyntaxError('m').name, new SyntaxError('m') instanceof SyntaxError, (function () { try { JSON.parse('{'); } catch (e) { return [e instanceof SyntaxError, e.name]; } })(), (function () { try { new RegExp('('); } catch (e) { return [e instanceof SyntaxError, e.name]; } })()];",
  'globals.ReferenceError': "return [new ReferenceError('m').name, new ReferenceError('m') instanceof ReferenceError, (function () { try { notDeclaredAnywhere; } catch (e) { return [e instanceof ReferenceError, e.name, e.message]; } })()];",
  'globals.URIError': "return [new URIError('m').name, new URIError('m') instanceof URIError, (function () { try { decodeURIComponent('%'); } catch (e) { return [e instanceof URIError, e.name]; } })()];",
  'globals.EvalError': "return [new EvalError('m').name, new EvalError('m') instanceof EvalError, new EvalError('m') instanceof Error, String(new EvalError('m'))];",
  // The two compile only the global-object idiom; what they hand back is the
  // realm's global - V8's context global here, the sandbox global there -
  // and the same object on every spelling. `security` below has the refusals.
  'globals.Function': "return [typeof Function, Function.name, Function.length, typeof Function('return this')(), Function('return this')().String === String, new Function('return this')() === Function('return this')(), Function('return this')().atob === atob, (function () {}).constructor === Function, Object.constructor === Function, 'constructor' in Object, typeof Function('return this')().Math.round];",
  'globals.eval': "return [typeof eval, eval.name, eval.length, typeof (0, eval)('this'), (0, eval)('this').String === String, (0, eval)(5), (0, eval)('this') === Function('return this')()];",
  'globals.parseInt': "return [parseInt('ff', 16), parseInt('0x1f'), parseInt('12px'), parseInt('  7'), parseInt(''), parseInt('1e3'), parseInt('z', 36), parseInt('10', 4294967298), parseInt('10', 1), parseInt('10', 37), parseInt('-0'), parseInt(null), parseInt(0.0000005), parseInt('123', 0), parseInt('123', undefined), parseInt === Number.parseInt, parseInt.length, parseInt.name];",
  'globals.parseFloat': "return [parseFloat('3.25rest'), parseFloat('.5'), parseFloat('-.5e1'), parseFloat(''), parseFloat('Infinityx'), parseFloat('0x10'), parseFloat('  1  '), parseFloat === Number.parseFloat, parseFloat.name];",
  'globals.isNaN': "return [isNaN('x'), isNaN(''), isNaN('1'), isNaN(undefined), isNaN(null), isNaN([]), isNaN([1, 2]), isNaN(NaN), isNaN.name];",
  'globals.isFinite': "return [isFinite('1'), isFinite(Infinity), isFinite(null), isFinite(undefined), isFinite('x'), isFinite([]), isFinite.name];",
  'globals.atob': "return [atob('aGk='), atob('aGk'), atob(' a G k = '), atob(''), atob('QUJD').length, (function () { try { atob('a'); } catch (e) { return e.name; } })(), (function () { try { atob('a*b='); } catch (e) { return e.name; } })()];",
  'globals.btoa': "return [btoa('hi'), btoa(''), btoa('\\u00ff'), btoa(1), (function () { try { btoa('\\u0100'); } catch (e) { return e.name; } })()];",
  'globals.encodeURIComponent': "return [encodeURIComponent('a b/c%d&é'), encodeURIComponent(1), encodeURIComponent(null), " + attempt("encodeURIComponent('\\ud800')") + '];',
  'globals.decodeURIComponent': "return [decodeURIComponent('a%20b%2Fc'), decodeURIComponent('%C3%A9'), decodeURIComponent(5), " + attempt("decodeURIComponent('%')") + '];',
  'globals.encodeURI': "return [encodeURI('http://x/a b?c=d&e#f'), encodeURI('é'), encodeURI.name];",
  'globals.decodeURI': "return [decodeURI('http://x/a%20b%3Fc'), decodeURI('%C3%A9'), " + attempt("decodeURI('%E0%A4%A')") + '];',
  'globals.escape': "return [escape('a b+c/é@*_-.'), escape('\\u0100'), escape(1)];",
  'globals.unescape': "return [unescape('a%20b%u0100%zz'), unescape(1)];",

  // -- String.prototype
  'String.prototype.charAt': "return ['abc'.charAt(1), 'abc'.charAt(-1), 'abc'.charAt(3), 'abc'.charAt(), 'abc'.charAt('1'), 'abc'.charAt(1.9), 'abc'.charAt(NaN), String.prototype.charAt.call(123, 1)];",
  'String.prototype.charCodeAt': "return ['abc'.charCodeAt(1), 'abc'.charCodeAt(9), 'abc'.charCodeAt(), '\\ud83d\\ude00'.charCodeAt(0), '\\ud83d\\ude00'.charCodeAt(1), 'abc'.charCodeAt(-1)];",
  'String.prototype.codePointAt': "return ['\\ud83d\\ude00'.codePointAt(0), '\\ud83d\\ude00'.codePointAt(1), 'a'.codePointAt(5), 'ab'.codePointAt()];",
  'String.prototype.at': "return ['abc'.at(-1), 'abc'.at(0), 'abc'.at(3), 'abc'.at(), 'abc'.at(-4)];",
  'String.prototype.indexOf': "return ['abcabc'.indexOf('c'), 'abcabc'.indexOf('c', 3), 'abc'.indexOf(''), 'abc'.indexOf('', 9), 'abc'.indexOf('x'), 'abc'.indexOf('b', -5), 'a1'.indexOf(1), 'undefined'.indexOf()];",
  'String.prototype.lastIndexOf': "return ['abcabc'.lastIndexOf('c'), 'abcabc'.lastIndexOf('c', 3), 'abcab'.lastIndexOf('ab', 2), 'abcab'.lastIndexOf('ab', undefined), 'abcab'.lastIndexOf('ab', NaN), 'abc'.lastIndexOf('x'), 'abc'.lastIndexOf('', 1)];",
  'String.prototype.includes': "return ['abc'.includes('b'), 'abc'.includes('b', 2), 'abc'.includes(''), 'a1'.includes(1), " + attempt("'a/b/'.includes(/b/)") + '];',
  'String.prototype.startsWith': "return ['abc'.startsWith('ab'), 'abc'.startsWith('bc', 1), 'abc'.startsWith(''), 'abc'.startsWith('a', -1), " + attempt("'abc'.startsWith(/a/)") + '];',
  'String.prototype.endsWith': "return ['abc'.endsWith('bc'), 'abc'.endsWith('ab', 2), 'abc'.endsWith('', 0), 'abc'.endsWith('c', undefined), 'abc'.endsWith('c', 9), " + attempt("'abc'.endsWith(/c/)") + '];',
  'String.prototype.slice': "return ['abcdef'.slice(2, 4), 'abcdef'.slice(-2), 'abcdef'.slice(4, 2), 'abcdef'.slice(), 'abcdef'.slice(undefined, 2), 'abcdef'.slice(1, undefined), 'abcdef'.slice(NaN, 'x'), 'abcdef'.slice(1.9, 3.1)];",
  'String.prototype.substring': "return ['abcdef'.substring(2, 4), 'abcdef'.substring(4, 2), 'abcdef'.substring(-2), 'abcdef'.substring(1, undefined), 'abcdef'.substring(NaN, 2), 'abcdef'.substring(1, 99)];",
  'String.prototype.substr': "return ['abcdef'.substr(1, 3), 'abcdef'.substr(-2), 'abcdef'.substr(-2, 1), 'abcdef'.substr(2), 'abcdef'.substr(2, -1), 'abcdef'.substr(9), 'abcdef'.substr(), 'abcdef'.substr(-9, 2), 'abcdef'.substr(1, Infinity), 'abcdef'.substr(-Infinity, 2), 'abcdef'.substr(NaN, NaN), 'abcdef'.substr(1, undefined)];",
  'String.prototype.concat': "return ['a'.concat('b', 1, null, undefined, [2, 3]), 'a'.concat(), ''.concat(true)];",
  'String.prototype.repeat': "return ['ab'.repeat(3), 'ab'.repeat(0), 'ab'.repeat(1.9), ''.repeat(5), 'a'.repeat('2'), " + attempt("'a'.repeat(-1)") + ', ' + attempt("'a'.repeat(Infinity)") + '];',
  'String.prototype.padStart': "return ['7'.padStart(3, '0'), 'abc'.padStart(2), 'a'.padStart(4), 'a'.padStart(4, 'xy'), 'a'.padStart(4, ''), 'a'.padStart(3, 5)];",
  'String.prototype.padEnd': "return ['7'.padEnd(3, '0'), 'abc'.padEnd(2), 'a'.padEnd(4), 'a'.padEnd(4, 'xy'), 'a'.padEnd(4, ''), 'a'.padEnd(3, 5)];",
  'String.prototype.trim': "return [' \\t\\n a b \\u00a0\\ufeff'.trim(), ''.trim(), '\\u2028x\\u2029'.trim()];",
  'String.prototype.trimStart': "return [' \\t a '.trimStart(), 'a'.trimStart()];",
  'String.prototype.trimEnd': "return [' \\t a '.trimEnd(), 'a'.trimEnd()];",
  'String.prototype.toLowerCase': "return ['AbC'.toLowerCase(), 'ÀÉ'.toLowerCase(), 'İ'.toLowerCase().length, 'ẞ'.toLowerCase()];",
  'String.prototype.toUpperCase': "return ['aBc'.toUpperCase(), 'ß'.toUpperCase(), 'ﬁ'.toUpperCase(), 'àé'.toUpperCase()];",
  'String.prototype.toString': "return ['abc'.toString(), String.prototype.toString.call('x'), " + attempt('String.prototype.toString.call(5)') + ', ' + attempt('String.prototype.toString.call({})') + '];',
  'String.prototype.valueOf': "return ['abc'.valueOf(), " + attempt('String.prototype.valueOf.call([])') + '];',
  'String.prototype.normalize': "return ['\\u00e9'.normalize('NFD').length, 'e\\u0301'.normalize().length, 'e\\u0301'.normalize('NFC') === '\\u00e9', '\\ufb01'.normalize('NFKC'), '\\u00e9'.normalize(undefined).length, " + attempt("'a'.normalize('nfd')") + '];',
  'String.prototype.split': "return ['a-b-c'.split('-'), 'a-b-c'.split('-', 2), 'abc'.split(''), 'abc'.split(), 'abc'.split(undefined, 0), 'a1b2c'.split(/\\d/), 'a1b2c'.split(/(\\d)/), ''.split(''), ''.split('x'), 'abc'.split('', -1), 'a,b'.split(',', 'x'), 'a1b'.split(1), (function () { var r = /\\d/g; r.lastIndex = 2; var parts = 'a1b2c'.split(r); return [parts, r.lastIndex]; })(), 'aXbXc'.split('X', 4294967297)];",
  'String.prototype.replace': "return ['a-b-c'.replace('-', '+'), 'a-b-c'.replace(/-/g, '+'), 'a1b2'.replace(/\\d/g, function (m) { return String(Number(m) * 2); }), 'xy'.replace(/(x)(y)/, '$2$1'), 'abc'.replace('b', '$&$&'), 'abc'.replace('b', \"$'\"), 'abc'.replace('b', '$`'), 'abc'.replace(/(?<mid>b)/, '[$<mid>]'), 'abc'.replace(/(?<mid>b)/, function (m, p1, offset, str, groups) { return typeof groups + ':' + groups.mid + ':' + Object.keys(groups) + ':' + ('toString' in groups) + ':' + offset + ':' + str; }), 'abc'.replace(/b/, function () { return arguments.length; }), 'abc'.replace(/(?<x>b)/, function () { return arguments.length; }), 'a.b'.replace('.', 'x'), 'aaa'.replace('a', 1), 'abc'.replace(undefined, 'x'), 'undefined'.replace(undefined, 'x'), 'abc'.replace(/b/, undefined), (function () { var r = /a/g; r.test('aa'); 'aa'.replace(r, 'b'); return r.lastIndex; })(), (function () { var r = /a/y; r.lastIndex = 1; var out = 'aa'.replace(r, 'b'); return [out, r.lastIndex]; })(), (function () { var r = /a/y; r.lastIndex = 1; var out = 'ba'.replace(r, 'x'); return [out, r.lastIndex]; })(), (function () { var r = /a/; r.lastIndex = 5; var out = 'aa'.replace(r, 'b'); return [out, r.lastIndex]; })(), 'abc'.replace(/b/g, function (m, offset) { return offset; })];",
  'String.prototype.replaceAll': "return ['a-b-c'.replaceAll('-', '+'), 'aaa'.replaceAll('a', 'b'), 'aXbX'.replaceAll(/X/g, function (m, o) { return o; }), 'abc'.replaceAll('', '-'), 'a.b.c'.replaceAll('.', '!'), " + attempt("'a'.replaceAll(/a/, 'b')") + ", (function () { var r = /a/g; r.lastIndex = 1; var out = 'aa'.replaceAll(r, 'b'); return [out, r.lastIndex]; })()];",
  'String.prototype.match': "return ['a1 b2'.match(/(\\w)(\\d)/g), 'a1 b2'.match(/(\\w)(\\d)/), 'a1'.match(/(\\w)(\\d)/).index, 'a1'.match(/(\\w)(\\d)/).input, 'a1'.match(/x/), 'a1'.match(/x/g), 'a.c'.match('.').index, 'abc'.match().length, 'undefined'.match(undefined)[0], 'a1'.match(1)[0], (function () { var m = 'a'.match(/(?<x>a)/); return [m.groups.x, Object.keys(m), 'groups' in m, typeof m.groups.toString]; })(), (function () { var m = 'a'.match(/a/); return [m.groups, 'groups' in m]; })(), (function () { var r = /a/g; r.lastIndex = 1; var m = 'aa'.match(r); return [m, r.lastIndex]; })(), (function () { var r = /a/y; r.lastIndex = 1; var m = 'aa'.match(r); return [m[0], m.index, r.lastIndex]; })(), (function () { var r = /a/; r.lastIndex = 1; var m = 'aa'.match(r); return [m.index, r.lastIndex]; })(), 'aXbX'.match(/X/g).length];",
  'String.prototype.search': "return ['abc'.search(/c/), 'abc'.search(/x/), 'abc'.search('.'), 'a.c'.search('\\\\.'), 'abc'.search(), 'undefined'.search(undefined), (function () { var r = /b/g; r.lastIndex = 2; var i = 'abc'.search(r); return [i, r.lastIndex]; })()];",
  'String.prototype.localeCompare': refuses("return 'a'.localeCompare('A');"),

  // -- Array.prototype
  'Array.prototype.push': "return [(function () { var a = [1]; var n = a.push(2, 3); return [n, a]; })(), [].push(), (function () { var a = [1, , 3]; a.push(4); return [a.length, 1 in a]; })()];",
  'Array.prototype.pop': "return [[1, 2].pop(), [].pop(), (function () { var a = [1, 2]; a.pop(); return a; })(), (function () { var a = [1, , ]; return [a.pop(), a.length]; })()];",
  'Array.prototype.shift': "return [[1, 2].shift(), [].shift(), (function () { var a = [1, 2]; a.shift(); return a; })(), (function () { var a = [, 2]; return [a.shift(), a]; })()];",
  'Array.prototype.unshift': "return [(function () { var a = [3]; var n = a.unshift(1, 2); return [n, a]; })(), [].unshift(), (function () { var a = [1, , 3]; a.unshift(0); return [a.length, 2 in a]; })()];",
  'Array.prototype.slice': "return [[1, 2, 3].slice(1), [1, 2, 3].slice(-2), [1, 2, 3].slice(1, 2), [1, 2, 3].slice(), [1, 2, 3].slice(2, 1), [1, , 3].slice().length, 1 in [1, , 3].slice(), [1, 2, 3].slice('1'), [1, 2, 3].slice(NaN, undefined), (function () { return Array.prototype.slice.call(arguments, 1); })(1, 2, 3), (function () { return Array.prototype.slice.call(arguments); }).apply(null, [1, , 3])];",
  'Array.prototype.splice': "return [(function () { var a = [1, 2, 3, 4]; var r = a.splice(1, 2, 'x'); return [r, a]; })(), (function () { var a = [1, 2, 3]; return [a.splice(1), a]; })(), (function () { var a = [1, 2, 3]; return [a.splice(), a]; })(), (function () { var a = [1, 2, 3]; return [a.splice(undefined), a]; })(), (function () { var a = [1, 2, 3]; return [a.splice(-1, 1), a]; })(), (function () { var a = [1, 2, 3]; return [a.splice(1, 0, 'a', 'b'), a]; })(), (function () { var a = [1, 2, 3]; return [a.splice(0, -1), a]; })(), (function () { var a = [1, , 3]; var r = a.splice(0, 2); return [r.length, 1 in r, a]; })()];",
  'Array.prototype.concat': "return [[1].concat([2, 3], 4, [[5]]), [].concat(), 1 in [1, , 3].concat([4]), [1, , 3].concat([4]).length, (function () { return [0].concat(arguments).length; })(1, 2), [1].concat('ab'), [1].concat({ length: 1, 0: 'x' }).length];",
  'Array.prototype.join': "return [[1, 2, 3].join(), [1, 2, 3].join('-'), [1, null, undefined, 2].join(''), [].join(), [[1, 2], [3]].join(';'), [1, 2].join(undefined), [1, 2].join(null), [1, , 3].join(), (function () { var a = [1]; a.push(a); return a.join(); })(), [[[[[[[[[[1]]]]]]]]]].join(), (function () { var a = [1, [2]]; a[1].push(a); return a.join('|'); })(), [true, false].join(), (function () { return Array.prototype.join.call(arguments, '-'); })(1, 2), [{}].join(), [/x/g].join(), [1.5, -0, 1e21].join()];",
  'Array.prototype.reverse': "return [[1, 2, 3].reverse(), [].reverse(), (function () { var a = [1, , 3]; a.reverse(); return [a, 1 in a, 0 in a]; })(), (function () { var a = [1, 2]; return a.reverse() === a; })()];",
  'Array.prototype.indexOf': "return [[1, 2, 3, 2].indexOf(2), [1, 2, 3].indexOf(2, 2), [1, 2].indexOf(9), [1, 2, 3].indexOf(3, -1), [1, , 3].indexOf(undefined), [NaN].indexOf(NaN), ['1'].indexOf(1), [1, 2].indexOf(2, 'x'), [1, 2].indexOf(1, -9), (function () { return Array.prototype.indexOf.call(arguments, 2); })(1, 2, 3)];",
  'Array.prototype.lastIndexOf': "return [[1, 2, 1].lastIndexOf(1), [1, 2, 1].lastIndexOf(1, 1), [1, 2, 1].lastIndexOf(1, undefined), [1, 2, 1].lastIndexOf(1, -2), [1, 2, 1].lastIndexOf(1, NaN), [1, 2, 1].lastIndexOf(1, -10), [1, 2].lastIndexOf(9), [1, , 1].lastIndexOf(undefined)];",
  'Array.prototype.includes': "return [[1, 2, 3].includes(2), [1, 2, 3].includes(9), [1, 2, 3].includes(1, 1), [NaN].includes(NaN), [1, , 3].includes(undefined), ['1'].includes(1), [1, 2].includes(2, -1), [1, 2].includes(1, -9)];",
  'Array.prototype.fill': "return [[1, 2, 3].fill(0), [1, 2, 3].fill(0, 1), [1, 2, 3].fill(0, 1, 2), [1, 2, 3].fill(0, -1), Array(3).fill('x'), 1 in Array(3).fill(), [1, 2].fill(0, 'x', undefined), (function () { var a = [1]; return a.fill(2) === a; })()];",
  'Array.prototype.forEach': "var seen = []; [1, , 3].forEach(function (v, i, arr) { seen.push(v, i, arr.length); }); [1].forEach(function (v) { seen.push(this.tag); }, { tag: 'T' }); var out = [1, 2].forEach(function () {}); return [seen, out, (function () { var a = [1, 2]; a.forEach(function (v, i) { if (i === 0) a.push(3); seen.push(v); }); return a; })(), seen, " + attempt('[1].forEach(1)') + '];',
  'Array.prototype.map': "return [[1, 2, 3].map(function (n) { return n * 2; }), (function () { var m = [1, , 3].map(function (v) { return v; }); return [m.length, 1 in m]; })(), [1].map(function (v, i, a) { return [v, i, a.length, this.t]; }, { t: 1 }), Array.apply(null, Array(3)).map(function (_, i) { return i; }), (function () { var a = [1, 2]; return a.map(function (v, i) { if (i === 0) a.push(9); return v; }); })(), ['1', '2', '3'].map(parseInt), " + attempt('[1].map()') + '];',
  'Array.prototype.filter': "return [[1, 2, 3, 4].filter(function (n) { return n % 2 === 0; }), [1, , 3].filter(function () { return true; }), [1].filter(function (v, i, a) { return this.keep; }, { keep: true }), [0, '', null, 1].filter(Boolean)];",
  'Array.prototype.reduce': "return [[1, 2, 3].reduce(function (a, n) { return a + n; }, 0), [1, 2, 3].reduce(function (a, n) { return a + n; }), [, 1, 2].reduce(function (a, n) { return a + n; }), [[1], [2]].reduce(function (a, n) { return a.concat(n); }), [1].reduce(function (a, n, i, arr) { return [a, n, i, arr.length]; }, 'init'), " + attempt('[].reduce(function (a, b) { return a + b; })') + ', ' + attempt('[, ,].reduce(function (a, b) { return a + b; })') + ', [].reduce(function () {}, 5)];',
  'Array.prototype.reduceRight': "return [[1, 2, 3].reduceRight(function (a, n) { return a + '' + n; }, ''), [1, 2, 3].reduceRight(function (a, n) { return a + '' + n; }), [1, , 3].reduceRight(function (a, n) { return a + n; }), " + attempt('[].reduceRight(function (a, b) { return a + b; })') + '];',
  'Array.prototype.some': "return [[1, 2].some(function (n) { return n > 1; }), [1, 2].some(function (n) { return n > 5; }), [].some(function () { return true; }), [, ].some(function () { return true; }), [1].some(function (v) { return this.t === v; }, { t: 1 })];",
  'Array.prototype.every': "return [[1, 2].every(function (n) { return n > 0; }), [1, 2].every(function (n) { return n > 1; }), [].every(function () { return false; }), [, ].every(function () { return false; }), [1].every(function (v) { return this.t === v; }, { t: 1 })];",
  'Array.prototype.find': "return [[1, 2, 3].find(function (n) { return n > 1; }), [1, 2].find(function (n) { return n > 5; }), (function () { var seen = []; [1, , 3].find(function (v, i) { seen.push(i, v); return false; }); return seen; })(), [1].find(function (v) { return this.t === v; }, { t: 1 })];",
  'Array.prototype.findIndex': "return [[1, 2, 3].findIndex(function (n) { return n > 1; }), [1, 2].findIndex(function (n) { return n > 5; }), (function () { var seen = []; [1, , 3].findIndex(function (v, i) { seen.push(i); return false; }); return seen; })()];",
  'Array.prototype.sort': "return [[3, 1, 2].sort(), [3, 1, 10, 2].sort(), [3, 1, 10, 2].sort(function (a, b) { return a - b; }), ['b', 'a', 'B', 'A', 'ä'].sort(), [3, , 1, undefined, 2].sort(), Object.keys([3, , 1].sort()), [1, 2, 3].sort(function () { return 0; }), [1, 2].sort(function () { return NaN; }), [[2], [1]].sort(), [true, false, null].sort(), (function () { var a = [2, 1]; return a.sort() === a; })(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (v, i) { return { k: i % 3, i: i }; }).sort(function (a, b) { return a.k - b.k; }).map(function (o) { return o.i; }), " + attempt('[1].sort(1)') + '];',
  'Array.prototype.toString': "return [[1, [2, 3]].toString(), [].toString(), '' + [1, null, 2], (function () { return Array.prototype.toString.call(arguments); })(7, 8), Array.prototype.toString.call({ join: function () { return 'J'; } }), Array.prototype.toString.call({}), " + attempt('Array.prototype.toString.call(null)') + '];',

  // -- Number.prototype
  'Number.prototype.toString': "return [(255).toString(16), (255).toString(), (0.5).toString(2), (-255).toString(36), (1e21).toString(), (1234567).toString(36), (NaN).toString(2), (Infinity).toString(16), (255).toString(undefined), (0.1).toString(3), (255).toString(16.9), (-0).toString(), (1e-7).toString(), (123.456).toString(16), " + attempt('(1).toString(1)') + ', ' + attempt('(1).toString(37)') + ', ' + attempt("Number.prototype.toString.call('x')") + '];',
  'Number.prototype.toFixed': "return [(1.005).toFixed(2), (1.5).toFixed(), (1.5).toFixed(0), (-1.5).toFixed(0), (1e21).toFixed(2), (0.000001).toFixed(7), (1.45).toFixed(1), (NaN).toFixed(2), (123.456).toFixed(100).length, " + attempt('(1).toFixed(101)') + ', ' + attempt('(1).toFixed(-1)') + '];',
  'Number.prototype.toPrecision': "return [(123.456).toPrecision(4), (0.00001).toPrecision(1), (123456).toPrecision(2), (1.5).toPrecision(), (1.5).toPrecision(undefined), (NaN).toPrecision(2), (Infinity).toPrecision(0), (1).toPrecision(100).length, " + attempt('(1).toPrecision(0)') + ', ' + attempt('(1).toPrecision(101)') + '];',
  'Number.prototype.toExponential': "return [(123456).toExponential(2), (0.00015).toExponential(), (1).toExponential(0), (NaN).toExponential(2), (Infinity).toExponential(200), (1).toExponential(100).length, (1.5).toExponential(undefined), " + attempt('(1).toExponential(101)') + ', ' + attempt('(1).toExponential(-1)') + '];',
  'Number.prototype.valueOf': "return [(5).valueOf(), Number.prototype.valueOf.call(7), " + attempt("Number.prototype.valueOf.call('7')") + '];',

  // -- Boolean.prototype
  'Boolean.prototype.toString': "return [true.toString(), false.toString(), " + attempt('Boolean.prototype.toString.call(1)') + '];',
  'Boolean.prototype.valueOf': "return [true.valueOf(), " + attempt("Boolean.prototype.valueOf.call('true')") + '];',

  // -- Object.prototype
  'Object.prototype.hasOwnProperty': "var o = { a: 1 }; function f() {} return [o.hasOwnProperty('a'), o.hasOwnProperty('b'), o.hasOwnProperty('toString'), o.hasOwnProperty('hasOwnProperty'), [1].hasOwnProperty(0), [1].hasOwnProperty(1), [1].hasOwnProperty('length'), [1, , 3].hasOwnProperty(1), 'ab'.hasOwnProperty(1), 'ab'.hasOwnProperty(2), 'ab'.hasOwnProperty('length'), (5).hasOwnProperty('x'), f.hasOwnProperty('name'), f.hasOwnProperty('length'), f.hasOwnProperty('prototype'), f.hasOwnProperty('call'), (function () {}).bind().hasOwnProperty('prototype'), /x/.hasOwnProperty('lastIndex'), /x/.hasOwnProperty('source'), new Error('m').hasOwnProperty('message'), new Error().hasOwnProperty('message'), new Error('m').hasOwnProperty('name'), new Error('m').hasOwnProperty('stack'), Object.prototype.hasOwnProperty.call({ x: 1 }, 'x'), Object.prototype.hasOwnProperty.call(Object.create(null), 'x'), Object.prototype.hasOwnProperty('hasOwnProperty'), Object.prototype.hasOwnProperty('toString'), Object.prototype.hasOwnProperty('foo'), Array.prototype.hasOwnProperty('push'), Math.hasOwnProperty('PI'), String.hasOwnProperty('fromCharCode'), String.hasOwnProperty('prototype'), ''.charAt.hasOwnProperty('prototype'), new Date(0).hasOwnProperty('getTime'), " + attempt('Object.prototype.hasOwnProperty.call(null, \'x\')') + '];',
  'Object.prototype.toString': "var t = Object.prototype.toString; return [t.call([]), t.call(null), t.call(undefined), t.call(function () {}), t.call(/x/), t.call(new Date(0)), t.call(new Error('e')), t.call('s'), t.call(1), t.call(true), t.call({ toString: function () { return 'x'; } }), t.call(Math), t.call(JSON), ({}).toString(), t.call(Object.create(null)), (function () { return t.call(arguments); })(), t.call(Object.prototype), [].toString === t, ({}).toString === t];",
  'Object.prototype.valueOf': "var o = {}; var a = []; function f() {} return [o.valueOf() === o, a.valueOf() === a, f.valueOf() === f, /x/.valueOf() instanceof RegExp, Math.valueOf() === Math, (function () { return arguments.valueOf() === arguments; })(), Object.prototype.valueOf.call(o) === o, " + attempt('Object.prototype.valueOf.call(null)') + '];',
  'Object.prototype.propertyIsEnumerable': "var o = { a: 1 }; function f() {} f.x = 1; return [o.propertyIsEnumerable('a'), o.propertyIsEnumerable('b'), o.propertyIsEnumerable('toString'), [1].propertyIsEnumerable(0), [1].propertyIsEnumerable('length'), [1, , 3].propertyIsEnumerable(1), 'ab'.propertyIsEnumerable(0), 'ab'.propertyIsEnumerable('length'), f.propertyIsEnumerable('name'), f.propertyIsEnumerable('prototype'), f.propertyIsEnumerable('x'), (function () { return [arguments.propertyIsEnumerable(0), arguments.propertyIsEnumerable('length'), arguments.propertyIsEnumerable('callee')]; })(1), /x/.propertyIsEnumerable('lastIndex'), new Error('m').propertyIsEnumerable('message'), " + attempt("Object.prototype.propertyIsEnumerable.call(undefined, 'x')") + '];',

  // -- Function.prototype
  'Function.prototype.call': "function greet(a, b) { return this.name + a + b; } return [greet.call({ name: 'n' }, '1', '2'), (function () { 'use strict'; return this; }).call(5), (function () { 'use strict'; return arguments.length; }).call(null, 1, 2), Math.max.call(null, 1, 3), String.prototype.charCodeAt.call('A', 0), greet.call.length, greet.call.name];",
  'Function.prototype.apply': "function sum() { var s = 0; for (var i = 0; i < arguments.length; i++) s += arguments[i]; return s; } return [sum.apply(null, [1, 2, 3]), sum.apply(null), sum.apply(null, undefined), sum.apply(null, null), Math.max.apply(null, [1, 5, 2]), (function () { return [arguments.length, 0 in arguments, 1 in arguments]; }).apply(null, [ , 1]), (function () { return Array.prototype.slice.call(arguments); }).apply(null, { length: 2, 0: 'a', 1: 'b' }), (function () { return [arguments.length, 0 in arguments]; }).apply(null, { length: 2, 1: 'b' }), Array.apply(null, Array(3)).map(function (_, i) { return i; }).join(), (function () { return arguments.length; }).apply(null, (function () { return arguments; })(1, 2)), (function () { 'use strict'; return this; }).apply('s'), (function () { return [Array.isArray(arguments), arguments.length]; }).apply(null, [[1, 2]]), " + attempt("(function () {}).apply(null, 'ab')") + ', ' + attempt('(function () {}).apply(null, 5)') + '];',
  'Function.prototype.bind': "function f(a, b) { return [this.t, a, b, arguments.length]; } var b = f.bind({ t: 'T' }, 1); function g() { 'use strict'; return this; } var arrow = (() => 1); return [b(2), b(), b.name, b.length, f.bind().length, f.bind(null, 1, 2, 3).length, b.bind(null, 9).name, typeof b.prototype, b.hasOwnProperty('prototype'), g.bind(null)(), g.bind(5)(), g.bind('s').call(1), Math.max.bind(null, 1)(2), (function () { return arguments.length; }).bind(null, 1)(2, 3), (function () { return typeof arrow.bind; })(), " + attempt('(function () {}).bind.call(1)') + '];',
  'Function.prototype.toString': "function named(a, b) { return a + b; } var arrow = (x) => x * 2; var expr = function () { /* c */ }; var o = { m() { return 1; } }; return [named.toString(), String(arrow), '' + expr, o.m.toString(), Math.max.toString(), String(parseInt), (function () { return typeof named.toString; })(), [named].join(''), `${named}`, named.bind().toString(), " + attempt('(function () {}).toString.call(1)') + ', ' + attempt('(function () {}).toString.call({})') + '];',

  // -- RegExp.prototype and the accessors
  'RegExp.prototype.test': "return [/a/.test('cat'), /a/.test('dog'), /a/.test(), /undefined/.test(), /1/.test(1), (function () { var r = /a/g; return [r.test('aa'), r.lastIndex, r.test('aa'), r.lastIndex, r.test('aa'), r.lastIndex]; })(), (function () { var r = /a/y; return [r.test('ba'), r.lastIndex, (r.lastIndex = 1, r.test('ba')), r.lastIndex]; })(), (function () { var r = /a/; r.lastIndex = 9; return [r.test('a'), r.lastIndex]; })(), (function () { var r = /a/g; r.lastIndex = '1'; return [r.test('aa'), r.lastIndex]; })(), (function () { var r = /a/g; r.lastIndex = -5; return [r.test('a'), r.lastIndex]; })(), " + attempt("RegExp.prototype.test.call('a', 'a')") + '];',
  'RegExp.prototype.exec': "return [/(\\w)(\\d)/.exec('a1'), /(\\w)(\\d)/.exec('a1').index, /(\\w)(\\d)/.exec('a1').input, /x/.exec('a'), /(a)|(b)/.exec('b'), (function () { var r = /a/g; var m1 = r.exec('aa'); var m2 = r.exec('aa'); var m3 = r.exec('aa'); return [m1.index, m2.index, m3, r.lastIndex]; })(), (function () { var m = /(?<y>\\d)/.exec('7'); return [m.groups.y, Object.keys(m.groups), Object.getOwnPropertyNames(m)]; })(), Object.getOwnPropertyNames(/a/.exec('a')), (function () { var r = /a/y; r.lastIndex = 1; var m = r.exec('ba'); return [m.index, r.lastIndex]; })(), " + attempt("RegExp.prototype.exec.call(5, 'a')") + '];',
  'RegExp.prototype.toString': "return [/a\\/b/gi.toString(), new RegExp('').toString(), String(/x/), '' + new RegExp('/'), /a/.toString === RegExp.prototype.toString, [/x/g].join()];",
  'RegExp accessors.source': "return [/a\\/b/.source, new RegExp('/').source, new RegExp('a/b').source, new RegExp('[/]').source, new RegExp('\\n').source, new RegExp('').source, /\\//.source, new RegExp(/a\\/b/).source, 'source' in /x/, /x/.hasOwnProperty('source')];",
  'RegExp accessors.flags': "return [/a/gimsuy.flags, new RegExp('', 'ig').flags, /a/.flags, /a/v.flags, 'flags' in /x/];",
  'RegExp accessors.global': "return [/a/g.global, /a/.global, 'global' in /x/];",
  'RegExp accessors.ignoreCase': "return [/a/i.ignoreCase, /a/.ignoreCase];",
  'RegExp accessors.multiline': "return [/a/m.multiline, /a/.multiline];",
  'RegExp accessors.dotAll': "return [/a/s.dotAll, /a/.dotAll];",
  'RegExp accessors.unicode': "return [/a/u.unicode, /a/.unicode];",
  'RegExp accessors.unicodeSets': "return [/a/v.unicodeSets, /a/.unicodeSets];",
  'RegExp accessors.sticky': "return [/a/y.sticky, /a/.sticky, 'sticky' in /x/];",
  'RegExp accessors.hasIndices': "return [/a/.hasIndices, 'hasIndices' in /x/];",

  // -- Error.prototype
  'Error.prototype.toString': "return [new Error('m').toString(), new TypeError('m').toString(), new Error().toString(), Error.prototype.toString.call({ name: 'N', message: 'M' }), Error.prototype.toString.call({ message: 'M' }), Error.prototype.toString.call({ name: 'N' }), Error.prototype.toString.call({}), Error.prototype.toString.call({ name: '', message: 'only' }), Error.prototype.toString.call({ name: 5, message: 6 }), (function () { var e = new Error('m'); e.name = undefined; return String(e); })(), " + attempt('Error.prototype.toString.call(1)') + '];',

  // -- Date.prototype
  'Date.prototype.getTime': "return [new Date(0).getTime(), new Date(1.5).getTime(), new Date(NaN).getTime(), new Date('2020-01-02').getTime(), Date.prototype.getTime.call(new Date(3))];",
  'Date.prototype.valueOf': "return [new Date(5).valueOf(), +new Date(5), new Date(5) - 0, new Date(5) < new Date(6), new Date(NaN).valueOf()];",
  'Date.prototype.getTimezoneOffset': refuses('return new Date(0).getTimezoneOffset();'),
  'Date.prototype.getFullYear': refuses('return new Date(0).getFullYear();'),
  'Date.prototype.getMonth': refuses('return new Date(0).getMonth();'),
  'Date.prototype.getDate': refuses('return new Date(0).getDate();'),
  'Date.prototype.getHours': refuses('return new Date(0).getHours();'),
  'Date.prototype.getMinutes': refuses('return new Date(0).getMinutes();'),
  'Date.prototype.getSeconds': refuses('return new Date(0).getSeconds();'),
  'Date.prototype.toISOString': "return [new Date(0).toISOString(), new Date('2020-01-02T03:04:05.678Z').toISOString(), new Date(-1).toISOString(), " + attempt('new Date(NaN).toISOString()') + ', ' + attempt('Date.prototype.toISOString.call(5)') + '];',
  'Date.prototype.toString': refuses("return '' + new Date(0);"),

  // -- Math
  'Math.E': 'return Math.E;',
  'Math.LN2': 'return Math.LN2;',
  'Math.LN10': 'return Math.LN10;',
  'Math.LOG2E': 'return Math.LOG2E;',
  'Math.LOG10E': 'return Math.LOG10E;',
  'Math.PI': 'return [Math.PI, Math.PI * 2];',
  'Math.SQRT1_2': 'return Math.SQRT1_2;',
  'Math.SQRT2': 'return Math.SQRT2;',
  'Math.min': "return [Math.min(1, 9, 5), Math.min(), Math.min('3', 2), Math.min(1, NaN), Math.min(0, -0) === 0 && 1 / Math.min(0, -0), Math.min([2], 3), Math.min.length];",
  'Math.max': "return [Math.max(1, 9, 5), Math.max(), Math.max('3', 2), Math.max(1, NaN), Math.max(-0, 0) === 0 && 1 / Math.max(-0, 0), Math.max(null, -1), Math.max.length];",
  'Math.pow': "return [Math.pow(2, 8), Math.pow(2, -1), Math.pow(2, 0.5), Math.pow(-8, 1 / 3), Math.pow(1, Infinity), Math.pow(NaN, 0), Math.pow('2', '3'), Math.pow(2, 1023) * 2, Math.pow(0, -1), Math.pow(-0, -1), Math.pow(10, 308), Math.pow(3, 40)];",
  'Math.atan2': 'return [Math.atan2(1, 1), Math.atan2(0, -0), Math.atan2(-0, 0), Math.atan2(1, 0), Math.atan2(NaN, 1), Math.atan2(1, Infinity)];',
  'Math.hypot': 'return [Math.hypot(3, 4), Math.hypot(), Math.hypot(1), Math.hypot(NaN, Infinity), Math.hypot(-3), Math.hypot(1, 2, 2)];',
  'Math.imul': "return [Math.imul(3, 4), Math.imul(0xffffffff, 5), Math.imul(-1, 8), Math.imul(2147483647, 2), Math.imul('3', 2.9), Math.imul(NaN, 1), Math.imul(0x7fffffff, 0x7fffffff)];",
  'Math.random': refuses('return Math.random();'),
  'Math.abs': "return [Math.abs(-4), Math.abs('-4'), Math.abs(-0) === 0 && 1 / Math.abs(-0), Math.abs(null), Math.abs(), Math.abs(-Infinity), Math.abs([-1])];",
  'Math.ceil': 'return [Math.ceil(1.1), Math.ceil(-1.1), Math.ceil(-0.5) === 0 && 1 / Math.ceil(-0.5), Math.ceil(NaN), Math.ceil(1e21)];',
  'Math.floor': "return [Math.floor(1.9), Math.floor(-1.1), Math.floor('2.5'), Math.floor(-0) === 0 && 1 / Math.floor(-0), Math.floor(NaN), Math.floor(Math.PI * 100) / 100, Math.floor(2147483648.5)];",
  'Math.round': 'return [Math.round(2.5), Math.round(-2.5), Math.round(2.4), Math.round(-0.4) === 0 && 1 / Math.round(-0.4), Math.round(0.49999999999999994), Math.round(NaN), Math.round(1e21), Math.round(-0.5) === 0 && 1 / Math.round(-0.5)];',
  'Math.trunc': 'return [Math.trunc(1.9), Math.trunc(-1.9), Math.trunc(-0.9) === 0 && 1 / Math.trunc(-0.9), Math.trunc(NaN), Math.trunc(Infinity)];',
  'Math.sign': 'return [Math.sign(-3), Math.sign(3), Math.sign(0), Math.sign(-0) === 0 && 1 / Math.sign(-0), Math.sign(NaN), Math.sign(\'-2\')];',
  'Math.sqrt': 'return [Math.sqrt(16), Math.sqrt(2), Math.sqrt(-1), Math.sqrt(-0) === 0 && 1 / Math.sqrt(-0), Math.sqrt(Infinity)];',
  'Math.cbrt': 'return [Math.cbrt(27), Math.cbrt(-8), Math.cbrt(2), Math.cbrt(-0) === 0 && 1 / Math.cbrt(-0)];',
  'Math.exp': 'return [Math.exp(1), Math.exp(0), Math.exp(-Infinity), Math.exp(710), Math.exp(0.5)];',
  'Math.expm1': 'return [Math.expm1(1), Math.expm1(0), Math.expm1(-0) === 0 && 1 / Math.expm1(-0), Math.expm1(1e-10)];',
  'Math.log': 'return [Math.log(Math.E), Math.log(1), Math.log(0), Math.log(-1), Math.log(10), Math.log(2)];',
  'Math.log1p': 'return [Math.log1p(0), Math.log1p(1e-10), Math.log1p(-1), Math.log1p(-2), Math.log1p(1)];',
  'Math.log2': 'return [Math.log2(8), Math.log2(3), Math.log2(0), Math.log2(1 << 30), Math.log2(0.1)];',
  'Math.log10': 'return [Math.log10(1000), Math.log10(2), Math.log10(0), Math.log10(1e-5)];',
  'Math.sin': 'return [Math.sin(0), Math.sin(Math.PI / 2), Math.sin(1), Math.sin(Math.PI), Math.sin(1e10), Math.sin(-0) === 0 && 1 / Math.sin(-0)];',
  'Math.cos': 'return [Math.cos(0), Math.cos(Math.PI), Math.cos(1), Math.cos(1e10), Math.cos(Infinity)];',
  'Math.tan': 'return [Math.tan(0), Math.tan(1), Math.tan(Math.PI / 4), Math.tan(Math.PI / 2), Math.tan(1e10)];',
  'Math.asin': 'return [Math.asin(1), Math.asin(0.5), Math.asin(2), Math.asin(-0) === 0 && 1 / Math.asin(-0)];',
  'Math.acos': 'return [Math.acos(1), Math.acos(0.5), Math.acos(-1), Math.acos(2)];',
  'Math.atan': 'return [Math.atan(1), Math.atan(Infinity), Math.atan(0.5), Math.atan(-0) === 0 && 1 / Math.atan(-0)];',
  'Math.sinh': 'return [Math.sinh(1), Math.sinh(0), Math.sinh(-1), Math.sinh(1e-10), Math.sinh(710)];',
  'Math.cosh': 'return [Math.cosh(1), Math.cosh(0), Math.cosh(-1), Math.cosh(710)];',
  'Math.tanh': 'return [Math.tanh(1), Math.tanh(0), Math.tanh(Infinity), Math.tanh(1e-10), Math.tanh(-0) === 0 && 1 / Math.tanh(-0)];',
  'Math.asinh': 'return [Math.asinh(1), Math.asinh(0), Math.asinh(-1e-10), Math.asinh(1e300)];',
  'Math.acosh': 'return [Math.acosh(1), Math.acosh(2), Math.acosh(0.5), Math.acosh(1e300)];',
  'Math.atanh': 'return [Math.atanh(0.5), Math.atanh(1), Math.atanh(-1), Math.atanh(2), Math.atanh(1e-10)];',
  'Math.fround': "return [Math.fround(5.5), Math.fround(5.05), Math.fround(1e40), Math.fround('1.1'), Math.fround(NaN), Math.fround(2 ** 24 + 1)];",
  'Math.clz32': "return [Math.clz32(1), Math.clz32(0), Math.clz32(0xffffffff), Math.clz32(-1), Math.clz32('8'), Math.clz32(NaN), Math.clz32(1.9), Math.clz32(2 ** 32)];",

  // -- JSON
  'JSON.parse': "return [JSON.parse('{\"a\":[1,2,{\"b\":\"c\"}]}'), JSON.parse('1e3'), JSON.parse('\"s\"'), JSON.parse(' null '), JSON.parse('[1,2]'), Object.keys(JSON.parse('{\"b\":1,\"2\":1,\"a\":1,\"1\":1}')), JSON.parse('{\"a\":1,\"a\":2}').a, JSON.parse(1), JSON.parse('{\"a\":[1,{\"b\":2}],\"c\":3}', function (k, v) { return typeof v === 'number' ? v * 10 : v; }), JSON.parse('1', function (k, v) { return undefined; }), JSON.parse('{\"a\":1}', 5), " + attempt("JSON.parse('{')") + ', ' + attempt("JSON.parse('')") + ', ' + attempt('JSON.parse(undefined)') + ', ' + attempt("JSON.parse('01')") + '];',
  'JSON.stringify': "return [JSON.stringify({ a: [1, 'x', null, true, undefined, function () {}, NaN, Infinity, -0], b: undefined, c: function () {} }), JSON.stringify([undefined, function () {}, , 1]), JSON.stringify('a\"b\\n\\u2028\\ud800'), JSON.stringify(undefined), JSON.stringify(function () {}), JSON.stringify(null), JSON.stringify({ b: 1, 2: 1, a: 1, 1: 1 }), JSON.stringify({ a: 1 }, null, 2), JSON.stringify({ a: [1] }, null, '--'), JSON.stringify({ a: 1 }, null, 20), JSON.stringify({ a: 1 }, null, 'abcdefghijklmnop'), JSON.stringify({ a: 1 }, null, {}), JSON.stringify({ a: 1 }, null, [5]), JSON.stringify({ a: 1 }, 5), JSON.stringify({ a: 1 }, null, 0), JSON.stringify(new Date(0)), JSON.stringify(new Date(NaN)), JSON.stringify(/x/g), JSON.stringify(new Error('m')), JSON.stringify(Object.create(null)), (function () { return JSON.stringify(arguments); })(1, 'a'), JSON.stringify({ a: Object.create({ inherited: 1 }) }), JSON.stringify(1e21), JSON.stringify(''), JSON.stringify({ '': 1 }), JSON.stringify([[]]), JSON.stringify({ a: {} }, null, 1), (function () { try { var o = {}; o.self = o; return JSON.stringify(o); } catch (e) { return e.name; } })(), (function () { try { var a = [1]; a.push(a); return JSON.stringify(a); } catch (e) { return e.name; } })()];",

  // -- constructor statics
  'String.fromCharCode': "return [String.fromCharCode(104, 105), String.fromCharCode(), String.fromCharCode(0x10000 + 65), String.fromCharCode('66'), String.fromCharCode(-1).charCodeAt(0), String.fromCharCode(NaN).charCodeAt(0), String.fromCharCode(65.9), String.fromCharCode(0xd83d, 0xde00).length];",
  'String.fromCodePoint': "return [String.fromCodePoint(0x1f600).length, String.fromCodePoint(65, 66), String.fromCodePoint(), String.fromCodePoint('67')];",
  'String.raw': "return [String.raw({ raw: ['a', 'b', 'c'] }, 1, 2), String.raw({ raw: ['a', 'b'] }, 1, 2, 3), String.raw({ raw: ['a', 'b', 'c'] }), String.raw({ raw: 'xyz' }, '-', '+'), String.raw({ raw: { length: 2, 0: 'p', 1: 'q' } }, '/'), String.raw({ raw: [] }), String.raw({ raw: Object.create({ length: 1, 0: 'z' }) }), String.raw.length, " + attempt('String.raw({})') + ', ' + attempt('String.raw()') + '];',
  'Number.parseInt': "return [Number.parseInt('0x1f'), Number.parseInt === parseInt];",
  'Number.parseFloat': "return [Number.parseFloat('1.5e1x'), Number.parseFloat === parseFloat];",
  'Number.isInteger': "return [Number.isInteger(4), Number.isInteger(4.5), Number.isInteger('4'), Number.isInteger(1e300), Number.isInteger(Infinity), Number.isInteger(-0)];",
  'Number.isFinite': "return [Number.isFinite(1), Number.isFinite('1'), Number.isFinite(Infinity), Number.isFinite(NaN), Number.isFinite(null)];",
  'Number.isNaN': "return [Number.isNaN(NaN), Number.isNaN('x'), Number.isNaN(undefined), Number.isNaN(0 / 0)];",
  'Number.isSafeInteger': "return [Number.isSafeInteger(2 ** 53), Number.isSafeInteger(2 ** 53 - 1), Number.isSafeInteger(1.5), Number.isSafeInteger('1')];",
  'Number.MAX_SAFE_INTEGER': 'return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2];',
  'Number.MIN_SAFE_INTEGER': 'return Number.MIN_SAFE_INTEGER;',
  'Number.MAX_VALUE': 'return [Number.MAX_VALUE, Number.MAX_VALUE * 2];',
  'Number.MIN_VALUE': 'return [Number.MIN_VALUE, Number.MIN_VALUE / 2];',
  'Number.EPSILON': 'return [Number.EPSILON, 0.1 + 0.2 - 0.3 < Number.EPSILON];',
  'Number.POSITIVE_INFINITY': 'return Number.POSITIVE_INFINITY;',
  'Number.NEGATIVE_INFINITY': 'return Number.NEGATIVE_INFINITY;',
  'Number.NaN': 'return [Number.NaN !== Number.NaN, typeof Number.NaN];',
  'Array.isArray': "return [Array.isArray([]), Array.isArray({}), Array.isArray('a'), Array.isArray(Array.prototype), (function () { return Array.isArray(arguments); })(), Array.isArray(Object.prototype), Array.isArray()];",
  'Array.of': "return [Array.of(3), Array.of(1, 2), Array.of(), Array.of(undefined).length, 0 in Array.of(undefined)];",
  'Array.from': "return [Array.from([1, , 3]), 1 in Array.from([1, , 3]), Array.from('a\\ud83d\\ude00b'), Array.from({ length: 2, 0: 'a' }), Array.from({ length: '2' }), Array.from({ length: -1 }), Array.from({}), Array.from(Object.create({ length: 1, 0: 'z' })), (function () { return Array.from(arguments); })(1, 2), Array.from([1, 2], function (v, i) { return v * 10 + i + this.t; }, { t: 0.5 }), Array.from({ length: 2 }, function (v, i) { return [v, i]; }), " + attempt('Array.from(null)') + ', ' + attempt('Array.from([1], 5)') + '];',
  'Object.keys': "return [Object.keys({ b: 1, 2: 1, a: 1, 1: 1 }), Object.keys([1, , 3]), Object.keys('ab'), Object.keys(5), Object.keys(function () {}), (function () { function f() {} f.b = 1; f[1] = 1; f.a = 1; f[0] = 1; return Object.keys(f); })(), (function () { return Object.keys(arguments); })(1, 2), Object.keys(/x/g), Object.keys(new Error('m')), Object.keys(new Date(0)), Object.keys(Object.create({ inherited: 1 })), Object.keys('a'.match(/a/)), Object.keys(Object.create(null)), (function () { var o = { a: 1, b: 2 }; delete o.a; o.a = 3; return Object.keys(o); })(), " + attempt('Object.keys(null)') + '];',
  'Object.values': "return [Object.values({ b: 1, 2: 'x', a: 3 }), Object.values([1, , 3]), Object.values('ab'), Object.values(Object.create({ z: 1 })), (function () { return Object.values(arguments); })(7), " + attempt('Object.values(undefined)') + '];',
  'Object.entries': "return [Object.entries({ b: 1, 2: 1, a: 1, 1: 1 }), Object.entries([1, , 3]), Object.entries('ab'), Object.entries(1), " + attempt('Object.entries(null)') + '];',
  'Object.assign': "return [Object.keys(Object.assign({}, { z: 1, 3: 1 })), Object.assign({ a: 1 }, { a: 2 }, null, undefined, { b: 3 }), Object.keys(Object.assign({}, [1, , 3])), Object.assign({}, 'ab'), (function () { var t = {}; return Object.assign(t, { x: 1 }) === t; })(), Object.assign([1], [2, 3]), (function () { function f() {} Object.assign(f, { q: 1 }); return f.q; })(), Object.assign({}, Object.create({ inherited: 1 })), " + attempt('Object.assign(null, {})') + ', ' + attempt('Object.assign(undefined)') + ', ' + attempt("Object.assign(Object.freeze({ a: 1 }), { a: 2 })") + ', ' + attempt('Object.assign(Object.freeze({}), { b: 2 })') + '];',
  'Object.fromEntries': "return [Object.fromEntries([['a', 1], ['b', 2]]), Object.keys(Object.fromEntries([['b', 1], [2, 1], ['a', 1]])), Object.fromEntries([]), Object.fromEntries([['a', 1], ['a', 2]]), " + attempt("Object.fromEntries([1])") + ', ' + attempt("Object.fromEntries([['a']]).a") + '];',
  'Object.getOwnPropertyNames': "return [Object.getOwnPropertyNames([1]), Object.getOwnPropertyNames('ab'), Object.getOwnPropertyNames(5), Object.getOwnPropertyNames('a'.match(/a/)), Object.getOwnPropertyNames('aa'.match(/a/g)), Object.getOwnPropertyNames({ b: 1, 2: 1, a: 1, 1: 1 }), Object.getOwnPropertyNames(/x/), Object.getOwnPropertyNames(new Date(0)), (function (a) { arguments.x = 1; return Object.getOwnPropertyNames(arguments); })(1, 2), Object.getOwnPropertyNames(Object.create(null)), " + attempt('Object.getOwnPropertyNames(undefined)') + '];',
  'Object.freeze': "var o = Object.freeze({ a: 1 }); o.a = 2; o.b = 3; delete o.a; var f = Object.freeze(function () {}); f.x = 1; return [o, o.a, o.b, 'b' in o, delete o.nope, delete o.a, f.x, Object.freeze(1), Object.freeze('s'), Object.freeze(null), Object.freeze(o) === o, (function () { 'use strict'; try { o.a = 5; return 'wrote'; } catch (e) { return e.name; } })(), (function () { 'use strict'; try { o.c = 5; return 'wrote'; } catch (e) { return e.name; } })(), (function () { 'use strict'; try { delete o.a; return 'deleted'; } catch (e) { return e.name; } })(), (function () { 'use strict'; return delete o.nope; })(), (function () { 'use strict'; try { f.y = 1; return 'wrote'; } catch (e) { return e.name; } })(), typeof f.prototype, (function () { var p = Object.freeze(function () {}).prototype; return typeof p; })()];",
  'Object.create': "var base = { z: 1 }; var o = Object.create(base); o.a = 1; var n = Object.create(null); n.b = 2; var c = Object.create(n); return [o.z, o.a, Object.keys(o), 'z' in o, o.hasOwnProperty('z'), o instanceof Object, typeof n.toString, 'toString' in n, n instanceof Object, Object.keys(n), c.b, typeof c.toString, c instanceof Object, JSON.stringify(n), Object.prototype.toString.call(n), typeof Object.create({}).toString, Object.keys(Object.create(o)), (function () { var k = []; for (var key in Object.create(o)) k.push(key); return k; })(), " + attempt('Object.create(1)') + ', ' + attempt('Object.create()') + '];',
  'Date.now': refuses('return Date.now();'),
  'Date.parse': "return [Date.parse('2021-06-30'), Date.parse('2020-01-02T03:04:05Z'), Date.parse('2020-01-02T03:04:05.678+02:00'), Date.parse('+010000-01-01'), Date.parse('2020'), Date.parse('2020-13-01')];",
  'Date.UTC': "return [Date.UTC(2020, 0, 2), Date.UTC(99), Date.UTC(NaN), Date.UTC(), Date.UTC(2020, 11, 31, 23, 59, 59, 999), Date.UTC('2020', '1'), Date.UTC(2020, 0, 1.9), Date.UTC(275760, 8, 13), Date.UTC(275760, 8, 14)];",
};

describe('every whitelist entry has a V8 probe', () => {
  const tables = whitelist();

  it('and nothing else is probed', () => {
    const listed = new Set<string>();
    for (const [table, keys] of tables) for (const key of keys) listed.add(`${table}.${key}`);
    const unknown = Object.keys(PROBES).filter((name) => !listed.has(name));
    expect(unknown, 'probes for entries the whitelist does not carry').toEqual([]);
  });

  it('and every function entry carries V8’s length and name', () => {
    // `reduce.length` is 1, `padStart.length` is 1, `Date.length` is 7,
    // `Object.create.length` is 2: each of those was wrong until this ran.
    for (const [table, keys] of tables) {
      if (table === 'RegExp accessors') continue;
      for (const key of keys) {
        // `Function.prototype` is reached through a function; `Function` itself is not modelled.
        const path =
          table === 'globals' ? key : table === 'Function.prototype' ? `(function () {}).${key}` : `${table}.${key}`;
        expectSameAsV8(`return typeof ${path} === 'function' ? [${path}.length, ${path}.name] : typeof ${path};`);
      }
    }
  });

  for (const [table, keys] of tables) {
    // `Boolean` and `RegExp` carry nothing but `prototype`.
    if (keys.length === 0) continue;
    describe(table, () => {
      for (const key of keys) {
        const probe = PROBES[`${table}.${key}`];
        it(`${key}: ${probe !== undefined && typeof probe !== 'string' ? 'refuses' : 'matches V8'}`, () => {
          expect(probe, `${table}.${key} is in the whitelist and has no probe`).toBeDefined();
          if (typeof probe === 'string') expectSameAsV8(probe);
          else expectRefusal(probe![REFUSES]);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Everything unlisted refuses
// ---------------------------------------------------------------------------

describe('a read past a builtin table', () => {
  const reads: Record<string, string> = {
    'Array.prototype.flat': 'return typeof [].flat;',
    'Array.prototype.at': 'return [1].at(0);',
    'Array.prototype.entries': 'return typeof [].entries;',
    'Array.prototype.toSorted': 'return typeof [].toSorted;',
    'a key no array has': "return [].nothingHere;",
    'a key no string has': "return 'abc'.nothingHere;",
    'String.prototype.matchAll': "return typeof ''.matchAll;",
    'String.prototype.toLocaleLowerCase': "return 'A'.toLocaleLowerCase();",
    'String.prototype.trimLeft': "return ' a'.trimLeft();",
    'String.prototype.isWellFormed': "return typeof ''.isWellFormed;",
    'Number.prototype.toLocaleString': 'return (1234.5).toLocaleString();',
    'a key no number has': 'return (5).nothingHere;',
    'Math.f16round': 'return typeof Math.f16round;',
    'a key Math does not have': 'return Math.nothingHere;',
    'Object.defineProperty': 'return typeof Object.defineProperty;',
    'Object.getPrototypeOf': 'return typeof Object.getPrototypeOf;',
    'Object.is': 'return typeof Object.is;',
    'a key Object does not have': 'return Object.nothingHere;',
    'String.prototype reached through the constructor': 'return typeof String.prototype.flat;',
    'a method of a builtin method': "return ''.charAt.nothingHere;",
    'JSON.rawJSON': 'return typeof JSON.rawJSON;',
    'RegExp.prototype.compile': 'return typeof /x/.compile;',
    'a key no regexp has': 'return /x/.nothingHere;',
    'Date.prototype.getUTCFullYear': 'return new Date(0).getUTCFullYear();',
    'a key no date has': 'return new Date(0).nothingHere;',
    'Error.prototype.cause': "return new Error('m').cause;",
    'a key no error has': "return new Error('m').nothingHere;",
    'Error.prototype.stack': "return typeof new Error('m').stack;",
    'Error.prototype.name': 'return Error.prototype.name;',
    'Array.prototype.length': 'return Array.prototype.length;',
    'Object.prototype.isPrototypeOf': 'return typeof ({}).isPrototypeOf;',
    'Object.prototype.toLocaleString': 'return typeof [].toLocaleString;',
    'isPrototypeOf through a plain object': "return typeof Object.prototype.isPrototypeOf;",
    'Function.prototype.arguments': 'return (function f() { return typeof f.arguments; })();',
    'Function.prototype.caller': 'return (function f() { return f.caller; })();',
    'a key of a builtin function': 'return typeof parseInt.nothingHere;',
    'a computed key on a builtin': "var k = 'fl' + 'at'; return typeof [][k];",
  };
  for (const [what, body] of Object.entries(reads)) {
    it(`refuses ${what}`, () => expectRefusal(body));
  }

  it('refuses arguments and caller whatever the function, V8 throwing there or not', () => {
    // On a bound or strict function V8's accessor throws; the model refuses either way.
    expect(() => interpret('return typeof (function () {}).bind().arguments;')).toThrow(InterpreterRefusal);
    expect(() => interpret("return (function f() { 'use strict'; return f.caller; })();")).toThrow(InterpreterRefusal);
  });
});

describe('a touch past a builtin table by any other route', () => {
  const touches: Record<string, string> = {
    '`in` on an array': "return 'flat' in [];",
    '`in` on Math': "return 'f16round' in Math;",
    '`in` on a builtin function': "return 'nothingHere' in parseInt;",
    'hasOwnProperty on Math': "return Math.hasOwnProperty('f16round');",
    'hasOwnProperty on a builtin function': "return String.hasOwnProperty('nothingHere');",
    'hasOwnProperty of arguments on a function': "return (function () {}).hasOwnProperty('arguments');",
    'hasOwnProperty of caller on a function': "return (function () {}).hasOwnProperty('caller');",
    'a write to Math': 'Math.nothingHere = 1; return Math.PI;',
    'a write to a builtin prototype': "String.prototype.charAt = function () { return 'x'; }; return 'a'.charAt(0);",
    'a write to Array.prototype': "Array.prototype.nothingHere = function () { return 1; }; return [].nothingHere();",
    'a write to a builtin constructor': 'String.nothingHere = 1; return String.nothingHere;',
    'a write to a builtin method': "''.charAt.nothingHere = 1; return ''.charAt.nothingHere;",
    'a write to Object.prototype': 'Object.prototype.nothingHere = 1; return ({}).nothingHere;',
    'a write to a regexp': '/x/.nothingHere = 1; return 1;',
    'a write to an error': "var e = new Error('m'); e.code = 5; return e.code;",
    'a write to a date': 'var d = new Date(0); d.tag = 1; return d.tag;',
    'a write to arguments on a function': 'function f() {} f.arguments = 1; return 1;',
    'a delete on Math': 'return delete Math.PI;',
    'a delete on a builtin prototype': 'return delete Array.prototype.push;',
    'a delete on a builtin function': 'return delete parseInt.name;',
    'a delete of stack': "return delete new Error('m').stack;",
    'Object.keys of Math': 'return Object.keys(Math);',
    'Object.keys of JSON': 'return Object.keys(JSON);',
    'Object.keys of a constructor': 'return Object.keys(String);',
    'Object.keys of a prototype': 'return Object.keys(Array.prototype);',
    'Object.values of Math': 'return Object.values(Math);',
    'Object.entries of JSON': 'return Object.entries(JSON);',
    'Object.getOwnPropertyNames of JSON': 'return Object.getOwnPropertyNames(JSON);',
    'Object.getOwnPropertyNames of Math': 'return Object.getOwnPropertyNames(Math);',
    'Object.getOwnPropertyNames of a prototype': 'return Object.getOwnPropertyNames(String.prototype);',
    'JSON.stringify of Math': 'return JSON.stringify(Math);',
    'JSON.stringify of a value holding Math': 'return JSON.stringify({ m: Math });',
    'propertyIsEnumerable on Math': "return Math.propertyIsEnumerable('PI');",
    'propertyIsEnumerable on a constructor': "return Array.propertyIsEnumerable('isArray');",
    'for...in over Math': 'var k = []; for (var x in Math) k.push(x); return k;',
    'for...in over a prototype': 'var k = []; for (var x in Array.prototype) k.push(x); return k;',
    'a spread of Math': 'return Object.keys({ ...Math });',
    'Object.assign from Math': 'return Object.keys(Object.assign({}, Math));',
    'Object.assign from a constructor': 'return Object.keys(Object.assign({}, Number));',
    'a rest pattern over JSON': 'var { ...rest } = JSON; return Object.keys(rest);',
    'String() of Array.prototype': 'return String(Array.prototype);',
    'String() of String.prototype': 'return String(String.prototype);',
    'the class tag of Array.prototype': 'return Object.prototype.toString.call(Array.prototype);',
    'a Number.prototype conversion': 'return Number.prototype + 1;',
    'Object.create(Array.prototype)': 'var o = Object.create(Array.prototype); return typeof o.push;',
    'Object.create(Math)': 'return Object.create(Math).PI;',
    '__proto__: Array.prototype in a literal': 'return typeof { __proto__: Array.prototype }.push;',
    'new String': "return typeof new String('a');",
    'new Number': 'return typeof new Number(1);',
    'new Boolean': 'return typeof new Boolean(false);',
    'Object() of a string': "return typeof Object('a');",
    'Object() of a number': 'return typeof Object(1);',
    'Object.prototype.valueOf on a primitive': 'return typeof Object.prototype.valueOf.call(1);',
    'a toJSON': "return JSON.stringify({ toJSON: function () { return 1; } });",
    'an inherited toJSON': "return JSON.stringify(Object.create({ toJSON: function () { return 1; } }));",
    'a toJSON on an array': "var a = [1]; a.toJSON = function () { return 2; }; return JSON.stringify(a);",
    'a toJSON deep inside': "return JSON.stringify({ a: [{ toJSON: function () { return 1; } }] });",
    'a replacer function': "return JSON.stringify({ a: 1 }, function (k, v) { return v; });",
    'a replacer array': "return JSON.stringify({ a: 1, b: 2 }, ['a']);",
    'an error with options': "return new Error('m', { cause: 1 }).message;",
    'Object.freeze of an array': 'return Object.freeze([1]).length;',
    'Object.freeze of a regexp': 'return Object.freeze(/x/).source;',
    'Object.fromEntries of a string': "return Object.fromEntries([]).x === undefined && Object.keys(Object.fromEntries('')).length;",
    'Array.from of a regexp': 'return Array.from(/x/).length;',
    'Array.from of a function': 'return Array.from(function () {}).length;',
    'a regexp with the d flag': "return /a/d.exec('a').indices.length;",
    'a constructed regexp with the d flag': "return new RegExp('a', 'd').exec('a').indices.length;",
    'a lastIndex that is an object': 'var r = /a/g; r.lastIndex = { valueOf: function () { return 0; } }; return r.test(\'a\');',
    'RegExp.prototype.toString on a plain object': 'return RegExp.prototype.toString.call({});',
    'an instance whose prototype is an array': 'function F() {} F.prototype = []; return typeof new F().push;',
    'an instance whose prototype is a function': 'function F() {} F.prototype = function () {}; return typeof new F().call;',
    'an instance whose prototype is Array.prototype': 'function F() {} F.prototype = Array.prototype; return typeof new F().push;',
  };
  for (const [what, body] of Object.entries(touches)) {
    it(`refuses ${what}`, () => expectRefusal(body));
  }

  it('is refused uncatchably, so a program cannot route around it', () => {
    expect(() => interpret("try { return [].flat; } catch (e) { return 'caught'; }")).toThrow(InterpreterRefusal);
    expect(() => interpret("try { Math.x = 1; } catch (e) { return 'caught'; } return 'wrote';")).toThrow(InterpreterRefusal);
    expect(() => interpret("try { return Object.keys(Math); } catch (e) { return 'caught'; } finally { var f = 1; }")).toThrow(
      InterpreterRefusal,
    );
  });
});

describe('Object.prototype, the one table known in full', () => {
  it('lists exactly V8’s keys, so a miss against it is an exact undefined', () => {
    // The twelve, from the V8 this runs on: four answered, six blocked, two refused.
    const keys = vm.runInNewContext('Object.getOwnPropertyNames(Object.prototype)', vm.createContext({})) as string[];
    expect([...keys].sort()).toEqual(
      [
        'constructor',
        '__defineGetter__',
        '__defineSetter__',
        'hasOwnProperty',
        '__lookupGetter__',
        '__lookupSetter__',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'toString',
        'valueOf',
        '__proto__',
        'toLocaleString',
      ].sort(),
    );
    expect([...whitelist().get('Object.prototype')!].sort()).toEqual(
      ['hasOwnProperty', 'propertyIsEnumerable', 'toString', 'valueOf'].sort(),
    );
  });

  it('answers a plain object’s, a function’s and arguments’ missing key with V8’s undefined', () => {
    expectSameAsV8(`
      var o = { a: 1 }; function f() {} var p = Object.create({ inherited: 1 });
      return [o.nothingHere, f.nothingHere, f.cache, f.initialized, p.nothingHere, p.inherited, Object.prototype.nothingHere,
              'nothingHere' in o, 'nothingHere' in f, o.hasOwnProperty('nothingHere'), f.hasOwnProperty('nothingHere'),
              (function () { return [arguments.nothingHere, 'nothingHere' in arguments]; })(),
              typeof o.nothingHere, o.nothingHere === undefined, o.nothingHere === undefined ? 'miss' : 'hit',
              typeof f.toString, typeof f.call, typeof f.hasOwnProperty, 'call' in f, 'toString' in o, 'valueOf' in p,
              f.name, f.length, typeof f.prototype, (function () {}).bind().prototype];
    `);
  });

  it('is the shape obfuscator.io’s decoder cache relies on', () => {
    expectSameAsV8(`
      function d(i) {
        if (d.cache === undefined) { d.cache = {}; d.ready = true; }
        var hit = d.cache[i];
        if (!hit) { hit = d.cache[i] = 'v' + i; }
        return hit;
      }
      return [d(1), d(1), d(2), Object.keys(d.cache), d.ready, d.nothing];
    `);
  });
});

// ---------------------------------------------------------------------------
// 3. The language: every construct the switch answers, against V8; the rest refused
// ---------------------------------------------------------------------------

describe('language constructs the interpreter walks', () => {
  const constructs: Record<string, string> = {
    'var, let, const and hoisting': "var out = [typeof a, typeof f]; var a = 1; function f() {} { let b = 2; const c = 3; out.push(b + c); } out.push(typeof b); try { d; } catch (e) { out.push(e.name); } let d = 4; return out;",
    'if / else': 'var o = []; if (1) o.push(1); else o.push(2); if (0) o.push(3); else if (\'\') o.push(4); else o.push(5); return o;',
    'while, do-while, for': 'var o = []; var i = 0; while (i < 2) o.push(i++); do { o.push(i--); } while (i > 0); for (var j = 0, k = 9; j < 2; j++, k--) o.push(j, k); for (;;) { break; } return o;',
    'for...in': "var o = []; for (var k in { b: 1, 2: 1, a: 1, 1: 1 }) o.push(k); for (k in [7, , 9]) o.push(k); for (k in 'ab') o.push(k); for (k in null) o.push('never'); for (var kk in undefined) o.push('never'); for (k in 5) o.push('never'); return o;",
    'for...of': "var o = []; for (var v of [1, , 3]) o.push(v); for (let c of 'a\\ud83d\\ude00') o.push(c.length); for (const [x, y] of [[1, 2]]) o.push(x + y); return o;",
    'for (let ...) closures': 'var fs = []; for (let i = 0; i < 3; i++) fs.push(function () { return i; }); var gs = []; for (var j = 0; j < 3; j++) gs.push(function () { return j; }); return [fs.map(function (f) { return f(); }), gs.map(function (g) { return g(); })];',
    'switch with fallthrough and default': "function s(x) { var o = []; switch (x) { case 1: o.push('one'); case 2: o.push('two'); break; default: o.push('dflt'); case 3: o.push('three'); } return o; } return [s(1), s(2), s(3), s(9), s('1')];",
    'labelled break and continue': 'var o = []; outer: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { if (j === 1) continue outer; if (i === 2) break outer; o.push(i + \'\' + j); } } blk: { o.push(\'in\'); break blk; } return o;',
    'try / catch / finally ordering': "var o = []; function t() { try { o.push('t'); throw new Error('x'); } catch (e) { o.push('c:' + e.message); return 'from-catch'; } finally { o.push('f'); } } o.push(t()); function u() { try { return 'try'; } finally { return 'finally'; } } o.push(u()); try { try { throw 1; } finally { o.push('inner-f'); } } catch (e) { o.push('outer:' + e); } try { throw 2; } catch { o.push('no-binding'); } return o;",
    'throw of any value': "var o = []; try { throw 'str'; } catch (e) { o.push(e); } try { throw { k: 1 }; } catch (e) { o.push(e.k); } try { throw null; } catch (e) { o.push(e); } return o;",
    'blocks, empty and debugger statements': 'var o = []; { ; ; o.push(1); } debugger; ; return o;',
    'sequence, conditional and logical': "var o = []; o.push((1, 2, 3), 1 ? 'a' : 'b', 0 ? 'a' : 'b', null ?? 'd', 0 ?? 'd', '' || 'x', 'y' && 'z', 0 && 1, null || undefined); return o;",
    'binary arithmetic': "return [1 + 2, '1' + 2, 1 + '2', [1] + [2], {} + 1, 1 + null, 1 + undefined, true + true, 5 - '2', '6' * '7', 7 / 2, 7 % 3, -7 % 3, 2 ** 10, 2 ** -1, (-2) ** 2, 0.1 + 0.2, 1 / 0, -1 / 0, 0 / 0, 5 % 0, 'a' - 1, null - 1, [] - 1, [5] * 2];",
    'binary bitwise': 'return [5 & 3, 5 | 3, 5 ^ 3, ~5, 1 << 31, 1 << 32, -1 >> 1, -1 >>> 1, -1 >>> 0, 2 ** 32 | 0, 2 ** 31 | 0, 1.9 | 0, -1.9 | 0, NaN | 0, "12" & 4, 0xffffffff >> 0, 1 << -1, 8 >> 40];',
    'comparison': "return [1 < 2, '2' < '10', 2 < '10', 'a' < 'b', 'B' < 'a', null < 1, undefined < 1, NaN < NaN, [2] < 3, '' < 1, 1 <= 1, 2 >= 3, 'abc' > 'abd', null >= 0, undefined == null, undefined >= null];",
    'equality': "return [1 == '1', 0 == '', 0 == '0', '' == '0', null == undefined, null == 0, undefined == 0, NaN == NaN, [] == [], [] == '', [1] == 1, [1, 2] == '1,2', ({}) == '[object Object]', true == 1, true == '1', false == '', null == false, 1 === 1, '1' === 1, NaN === NaN, null === undefined, 1 != '1', 1 !== '1', (function f() { return f == '' + f; })(), (function () {}) == 1, /a/ == '/a/', new Error('m') == 'Error: m'];",
    'in and instanceof': "function F() {} var f = new F(); return ['a' in { a: 1 }, 0 in [1], 1 in [1], 'length' in [], 'x' in Object.create({ x: 1 }), f instanceof F, f instanceof Object, [] instanceof Array, [] instanceof Object, /x/ instanceof RegExp, new Date(0) instanceof Date, new TypeError('m') instanceof Error, Object.create(null) instanceof Object, (function () {}) instanceof Object, F.prototype instanceof F, (function () { try { 'a' in 'abc'; } catch (e) { return e.name; } })(), (function () { try { f instanceof 1; } catch (e) { return e.name; } })()];",
    'unary operators': "return [-'5', +'6', !0, ~2, typeof 'x', typeof 1, typeof true, typeof undefined, typeof null, typeof {}, typeof [], typeof function () {}, typeof /x/, typeof new Error('e'), typeof Math, typeof undeclaredNameHere, void 0, -[], -{}, +[], +[1], +'', !'', !NaN, -null, -undefined, typeof typeof 1];",
    'delete': "var o = { a: 1, b: 2 }; var a = [1, 2, 3]; var s = 'abc'; function f() {} return [delete o.a, 'a' in o, delete o.nope, delete a[1], 1 in a, a.length, delete a.length, a.length, delete s.length, delete s[0], delete s.nope, delete (5).x, delete f.name, f.name, delete f.length, f.length, delete f.prototype, typeof f.prototype, delete o, delete a, delete f, delete undeclaredNameHere, delete 1, delete (0, o).b, 'b' in o, (function () { var e = new Error('m'); return [delete e.message, e.message, delete e.name, e.name]; })(), (function () { return [delete arguments.length, arguments.length, delete arguments[0], 0 in arguments, delete arguments.callee, 'callee' in arguments]; })(1), (function () { 'use strict'; try { delete arguments.callee; return 'deleted'; } catch (e) { return e.name; } })(), (function () { 'use strict'; try { delete [].length; return 'deleted'; } catch (e) { return e.name; } })(), (function () { 'use strict'; try { delete 'ab'.length; return 'deleted'; } catch (e) { return e.name; } })(), (function () { 'use strict'; try { delete (function () {}).prototype; return 'deleted'; } catch (e) { return e.name; } })(), (function () { 'use strict'; try { delete /x/.lastIndex; return 'deleted'; } catch (e) { return e.name; } })(), delete /x/.lastIndex, delete /x/.nope, delete new Date(0).nope, (function () { try { delete null.x; } catch (e) { return e.name; } })(), (function () { var o2 = null; return delete o2?.x; })()];",
    'delete of an implicit global': "(function () { madeBySloppyAssignment = 1; })(); var before = typeof madeBySloppyAssignment; var d = delete madeBySloppyAssignment; return [before, d, typeof madeBySloppyAssignment];",
    'update expressions': "var i = 1; var o = { n: '5' }; var a = [1]; var s = 'x'; return [i++, i, ++i, i--, --i, o.n++, o.n, ++o.n, a[0]++, a[0], s++, s, (function () { var u; return [u++, u]; })(), (function () { var n = null; return ++n; })()];",
    'assignment operators': "var a = 1; a += 2; a -= 1; a *= 3; a /= 2; a %= 2; a **= 3; a <<= 2; a >>= 1; a >>>= 0; a |= 8; a &= 12; a ^= 1; var s = 'a'; s += 1; var n = null; n ??= 'set'; var k = 'keep'; k ||= 'no'; var t = 1; t &&= 9; var z = 0; z ||= 'or'; var o = { p: 1 }; o.p += 1; o.q ??= 2; o.p ||= 5; o.r &&= 5; return [a, s, n, k, t, z, o, (function () { var x = 0; x += x++ + ++x; return x; })(), (function () { var c = 1; var r = (c = 2); return [r, c]; })()];",
    'member access and optional chaining': "var o = { a: { b: [1, { c: 'd' }] }, 1: 'one', 'k-k': 2 }; var n = null; return [o.a.b[1].c, o[1], o['k-k'], o['a']['b'][0], n?.x, n?.x.y.z, o?.a?.b?.length, o.nope?.x, n?.[0], o.a?.['b'], (function () { try { n.x; } catch (e) { return e.name + ': ' + e.message; } })(), (function () { try { undefined[0]; } catch (e) { return e.name; } })(), o[1.5 * 2], o[[1]], o[{ toString: undefined } === 1], 'abc'[1], 'abc'['length'], 'abc'[5], [1, 2][1], [1, 2]['1'], [1, 2][1.0], [1, 2][-1], [1, 2]['01'], (function () { var k = 'a'; return o[k].b.length; })()];",
    'calls and optional calls': "var o = { m: function (x) { return [this === o, x]; } }; function f() { return arguments.length; } var n = null; return [o.m(1), f(1, 2, 3), f(), n?.(), o.nope?.(), o.m?.(2), f.call(null), (function () { try { o.nope(); } catch (e) { return e.name + ': ' + e.message; } })(), (function () { try { n(); } catch (e) { return e.name; } })(), (function () { try { (1)(); } catch (e) { return e.name; } })(), f(...[1, 2], ...'ab', 3), Math.max(...[1, 5], 2)];",
    'new': "function P(x) { this.x = x; } P.prototype.get = function () { return this.x; }; function R() { return { r: 1 }; } function S() { return 5; } function T() { return [1]; } var arrow = () => 1; return [new P(1).get(), new P(1) instanceof P, new R().r, new S() instanceof S, new S().x, new T().length, new P, (function () { try { new arrow(); } catch (e) { return e.name; } })(), (function () { try { new Math.max(); } catch (e) { return e.name; } })(), (function () { try { new (function () { 'use strict'; return this; })() === undefined; } catch (e) { return e.name; } })(), new Array(2).length, typeof new Date(0), new RegExp('a').source, new Error('m').message, (function () { function F() {} F.prototype = null; return new F() instanceof Object; })(), (function () { function F() {} F.prototype = 5; return [new F() instanceof Object, typeof new F().toString, F.prototype]; })(), (function () { function F() {} var p = F.prototype; F.prototype.k = 1; return [new F().k, F.prototype === p, F.hasOwnProperty('prototype'), p.hasOwnProperty('k')]; })()];",
    'template literals': "var x = 5; var o = { a: [1, 2] }; return [`a${x}b${o.a}c`, `${null}${undefined}${true}`, `\\n${'q'}`.length, `${1 + 1}${[]}${{}}`, `${function () {}}`.length > 0, `plain`, `${x}${x}`];",
    'regexp literals': "return [/a/g.source, /a/g.flags, /[/]/.source, /\\//.source, /(?<n>a)/.exec('a').groups.n, /a/ === /a/, (function () { var r = /a/g; r.lastIndex = 3; return r.lastIndex; })(), (function () { function make() { return /x/; } return make() === make(); })()];",
    'array literals': "var a = [1, , 3]; var s = [...[1, 2], ...'ab', ...(function () { return arguments; })(9)]; return [a.length, 1 in a, s, [].length, [,].length, [, ,].length, [[]].length, [1, 2,].length, [undefined].length, 0 in [undefined], [...[1, , 3]].length, 1 in [...[1, , 3]]];",
    'object literals': "var k = 'dyn'; var sh = 1; var o = { a: 1, 'b': 2, 3: 3, [k]: 4, [1 + 1]: 5, sh, m() { return this.a; }, ['comp' + 'uted']() { return 6; }, get: 7, set: 8, __proto__: { inherited: 9 }, 'quoted-key': 10, 0.5: 11, 1e3: 12, null: 13, undefined: 14 }; return [Object.keys(o), o.dyn, o[2], o.sh, o.m(), o.computed(), o.get, o.set, o.inherited, o.hasOwnProperty('inherited'), o['0.5'], o[1000], o.null, o[undefined], { a: 1, a: 2 }.a, Object.keys({ b: 1, ...{ a: 2, b: 3 }, c: 4 }), ({ ...null, ...undefined, ...'ab', ...[7] }), { __proto__: null }.toString, Object.keys({ __proto__: null, x: 1 }), typeof { __proto__: 5 }.toString];",
    'functions, arrows, closures and this': "var o = { n: 5, get: function () { return this.n; }, arrow: () => typeof this, nested: function () { return (() => this.n)(); } }; function counter() { var c = 0; return function () { return ++c; }; } var inc = counter(); inc(); var named = function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }; return [o.get(), o.nested(), inc(), named(5), typeof fact, (function () { 'use strict'; return this; })(), (function () { 'use strict'; return typeof this; }).call(1), ((x, y = x + 1, ...rest) => [x, y, rest])(1), ((x, y = x + 1, ...rest) => [x, y, rest])(1, 5, 6, 7), (function (a, b) {}).length, ((a, b = 1, c) => 0).length, ((...r) => 0).length, (function () { return typeof arguments; })(), (() => 1)(), (() => ({ o: 1 }))().o];",
    'arguments': "function f(a, b) { arguments[0] = 'A'; b = 'B'; return [a, arguments[1], arguments.length, arguments.callee === f, Array.prototype.slice.call(arguments), typeof arguments, Array.isArray(arguments), Object.prototype.toString.call(arguments)]; } function g(a) { 'use strict'; arguments[0] = 2; return a; } function h(a) { function a() {} return [typeof a, typeof arguments[0]]; } function i(a) { var a; return [a, arguments[0]]; } function j(a) { var a = 2; return [a, arguments[0]]; } return [f(1, 2, 3), g(1), h(1), i(1), j(1), (function (a, a) { return [a, arguments[0], arguments[1]]; })(1, 2), (function () { return arguments.length; })(), (function (a = 1) { arguments[0] = 9; return a; })(5)];",
    'destructuring': "var [a, b = 9, ...tail] = [1, undefined, 3, 4]; var { x, y: renamed = 7, ...others } = { x: 1, w: 2, v: 3 }; var { p: { q } } = { p: { q: 'deep' } }; var [c, [d]] = 'a\\ud83d\\ude00'.split('').concat([['e']]); var e, f; [e, f] = [f, e]; ({ e = 5 } = {}); var { [\"comp\" + \"uted\"]: g } = { computed: 8 }; function params({ m, n = 2 }, [o, ...rest]) { return [m, n, o, rest]; } var [h = (() => 'lazy')()] = [undefined]; var { length } = 'abc'; var [i0, i1] = (function () { return arguments; })(7, 8); return [a, b, tail, x, renamed, others, q, c, d, e, f, g, params({ m: 1 }, [1, 2, 3]), h, length, i0, i1, (function () { try { var { z } = null; } catch (e) { return e.name; } })(), (function () { try { var [z] = 5; } catch (e) { return e.name; } })(), (function () { var [s1, s2, s3] = 'ab'; return [s1, s2, s3]; })(), (function () { var { 0: first, length: len } = [9, 8]; return [first, len]; })()];",
    'named evaluation': "var f = function () {}; let g = () => {}; var i = (function () {}); var j = (0, function () {}); var m; m = function () {}; var o = { p: function () {}, ['q']: () => {}, 5: function () {}, r() {} }; var c1; c1 ||= function () {}; var { e = function () {} } = {}; function dflt(x = function () {}) { return x.name; } return [f.name, g.name, i.name, j.name, m.name, o.p.name, o.q.name, o[5].name, o.r.name, c1.name, e.name, dflt(), (function () {}).name, (function nm() {}).name, f.bind().name];",
    'string coercions of every value kind': "function fn() {} return ['' + 1, '' + null, '' + undefined, '' + true, '' + [1, [2]], '' + {}, '' + /x/g, '' + new Error('m'), '' + new TypeError(''), '' + fn === fn.toString(), '' + (function () { return arguments; })(), '' + Math, '' + JSON, '' + Object.prototype, '' + -0, '' + 1e21, '' + 1e-7, '' + 0.000001, '' + 123456789012345680000, '' + (0.1 + 0.2), '' + 2 ** 53, '' + [null, undefined], '' + [[]], '' + [,]];",
    'numeric coercions of every value kind': "return [+'', +' 12 ', +'0x10', +'1e3', +'12px', +null, +undefined, +true, +[], +[3], +[1, 2], +[[4]], +{}, +'Infinity', +'-0', 1 / +'-0', +'\\n', +'0b11', +'0o7', +'1_000', +new Date(5), -'x', +'  ', +'.5', +'5.', +'+5', +'++5', +'1e', +'0x', +'٣'];",
    'boolean coercions': "return [!!'', !!'0', !![], !!{}, !!0, !!-0, !!NaN, !!null, !!undefined, !!function () {}, !!/x/, !!' ', !!Object.create(null), !!(function () { return arguments; })()];",
    'strict mode differences': "var sloppy = (function () { return [(function () { undeclaredMadeHere = 1; return typeof undeclaredMadeHere; })(), (function (a) { arguments[0] = 2; return a; })(1)]; })(); var strict = (function () { 'use strict'; return [typeof this, (function () { try { undeclaredStrict = 1; } catch (e) { return e.name; } })(), (function (a) { arguments[0] = 2; return a; })(1), (function () { var o = Object.freeze({ a: 1 }); try { o.a = 2; } catch (e) { return e.name; } })(), (function () { try { 'abc'.x = 1; } catch (e) { return e.name; } })(), (function () { try { (function () {}).name = 'x'; } catch (e) { return e.name; } })(), (function () { try { [].length = -1; } catch (e) { return e.name; } })()]; })(); return [sloppy, strict, (function () { 'abc'.x = 1; return 'ignored'; })(), (function () { var f = function () {}; f.name = 'x'; f.length = 5; return [f.name, f.length]; })(), (function () { var f = function () {}; delete f.name; f.name = 'x'; return [f.name, f.hasOwnProperty('name'), 'name' in f, Object.keys(f)]; })(), (function () { var f = function () {}; delete f.name; return [f.name, f.hasOwnProperty('name'), 'name' in f]; })(), (function () { var f = function (a) {}; delete f.length; return [f.length, f.hasOwnProperty('length')]; })(), (function () { function f() {} f.prototype = 5; return f.prototype; })()];",
    'array length writes': "return [(function () { var a = [1, 2, 3]; a.length = 1; return a; })(), (function () { var a = [1]; a.length = 3; return [a.length, 1 in a]; })(), (function () { var a = [1]; a.length = '2'; return a.length; })(), (function () { var a = [1]; a.length = 2.0; return a.length; })(), (function () { try { var a = []; a.length = 'x'; } catch (e) { return e.name; } })(), (function () { try { var a = []; a.length = 1.5; } catch (e) { return e.name; } })(), (function () { try { var a = []; a.length = -1; } catch (e) { return e.name; } })(), (function () { var a = []; a[4294967295] = 'x'; return [a.length, a[4294967295]]; })(), (function () { var a = []; a['01'] = 'x'; return [a.length, a['01']]; })(), (function () { var a = [1, 2]; a.x = 3; return [a.length, Object.keys(a)]; })()];",
    'getters through host RegExp results': "var m = /(a)(b)?/.exec('a'); return [m.length, m[2], 2 in m, m.index, m.input, Object.keys(m), m.groups];",
  };

  for (const [what, body] of Object.entries(constructs)) {
    it(`computes ${what} as V8 does`, () => expectSameAsV8(body));
  }

  it('erases TypeScript and Flow type-level wrappers to their operand', () => {
    const statements = parse(
      "var __result = (function () { var a: number[] = [1, 2]; a.push(a.shift() as number); return [(a as any)!.length, (<string[]>a)[0], (a satisfies number[])[1]]; })();",
      { sourceType: 'script', plugins: ['typescript'] },
    ).program.body;
    expect(createInterpreter(statements).read('__result')).toEqual([2, 2, 1]);
  });

  const unsupported: Record<string, string> = {
    'a class': 'class A {} return typeof A;',
    'a getter in a literal': 'return { get x() { return 1; } }.x;',
    'a setter in a literal': 'var o = { set x(v) {} }; o.x = 1; return 1;',
    'a tagged template': 'function tag(s) { return s.raw[0]; } return tag`a\\n`;',
    'an await': 'return (async () => await 1)();',
    'a yield': 'function* g() { yield 1; } return g().next().value;',
    'an async function, at its creation': 'var f = async function () { return 1; }; return typeof f;',
    'an async arrow, at its creation': 'var f = async () => 1; return typeof f;',
    'a generator, at its creation': 'function* g() { yield 1; } return typeof g;',
    'an async method, at its creation': 'var o = { async m() { return 1; } }; return typeof o.m;',
    'new.target': 'function F() { return typeof new.target; } return new F();',
    'a with statement': 'with ({ a: 1 }) { return a; }',
    'a BigInt literal': 'return typeof 1n;',
    'a dynamic import': "return typeof import('x');",
    'a symbol-keyed access spelled with a computed BigInt': 'return [][1n];',
  };
  for (const [what, body] of Object.entries(unsupported)) {
    it(`refuses ${what} as unsupported syntax`, () => {
      expect(() => interpret(body), body).toThrow(UnsupportedSyntaxError);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Dense argument lists, deleted function properties, and the holes beside them
// ---------------------------------------------------------------------------

describe('apply hands a dense list', () => {
  it('Gets every index of a holey array, as CreateListFromArrayLike does', () => {
    // Handing the holey array itself gives the callee's `arguments` holes,
    // which `map` skips.
    expectSameAsV8("return Array.apply(null, Array(3)).map(function (_, i) { return i; }).join();");
    expectSameAsV8('return (function () { return [arguments.length, 0 in arguments, 1 in arguments, 2 in arguments]; }).apply(null, [ , 1]);');
    expectSameAsV8('return (function () { return Array.prototype.map.call(arguments, function (v, i) { return i; }); }).apply(null, [ , , ]);');
    expectSameAsV8("return (function () { return [arguments.length, 0 in arguments]; }).apply(null, { length: 2, 1: 'b' });");
    expect(interpret("return Array.apply(null, Array(3)).map(function (_, i) { return i; }).join();")).toBe('0,1,2');
  });
});

describe('delete of a function’s name and length', () => {
  it('takes the own property off, so Function.prototype’s show through', () => {
    // Dropping the entry while still answering the function's own name gives
    // `'f'` and `true` where V8 says `''` and `false`.
    expectSameAsV8("function f() {} delete f.name; return [f.name, f.hasOwnProperty('name'), 'name' in f, Object.keys(f)];");
    expectSameAsV8("function f(a) {} delete f.length; return [f.length, f.hasOwnProperty('length'), 'length' in f];");
    expectSameAsV8("function f() {} delete f.name; f.name = 'renamed'; return [f.name, f.hasOwnProperty('name'), Object.keys(f)];");
    expectSameAsV8("function f() {} f.name = 'ignored'; return [f.name, delete f.name, f.name, delete f.name, f.name];");
    expect(interpret("function f() {} delete f.name; return [f.name, f.hasOwnProperty('name')];")).toEqual(['', false]);
  });
});

describe('this at the top level', () => {
  it('is the global object in a script, strict or not, and only a module binds undefined', () => {
    // A strict script: V8 still binds the global object, and so does the
    // interpreter - its sandbox global, which answers the builtins and
    // refuses a property it does not carry rather than reading `undefined`.
    expect(vm.runInNewContext("'use strict'; typeof this", vm.createContext({}))).toBe('object');
    expect(createInterpreter(parse("'use strict'; var t = typeof this;").program.body, { strict: true }).read('t')).toBe('object');
    expect(createInterpreter(parse("'use strict'; var t = this.String === String;").program.body, { strict: true }).read('t')).toBe(true);
    expect(() => createInterpreter(parse("'use strict'; var t = this.document;").program.body, { strict: true })).toThrow(
      /not in the sandbox/,
    );
    // A module: V8 binds undefined at the top level, and so does the interpreter.
    const module = execFileSync(process.execPath, ['--input-type=module', '-e', 'console.log(typeof this, this === undefined)'], {
      encoding: 'utf8',
    }).trim();
    expect(module).toBe('undefined true');
    expect(createInterpreter(parse('var t = typeof this;').program.body, { module: true }).read('t')).toBe('undefined');
    expect(createInterpreter(parse('var t = this === undefined;').program.body, { module: true }).read('t')).toBe(true);
    // Module implies strict: an undeclared assignment throws.
    expect(() => createInterpreter(parse('undeclaredInModule = 1;').program.body, { module: true })).toThrow(/is not defined/);
  });
});

describe('an own valueOf on a prototype-less object', () => {
  it('is what a string conversion falls to, and is refused as user code', () => {
    // Hint string: no `toString` on a bare chain, so OrdinaryToPrimitive
    // moves on to `valueOf`, which is the program's, not to the TypeError
    // meant for an object with neither.
    expect(v8("var o = Object.create(null); o.valueOf = function () { return 1; }; return String(o);")).toBe('1');
    for (const conversion of ['String(o)', "'' + o", '`${o}`', '+o', 'o - 1', 'o == 1', '({})[o]']) {
      expectRefusal(`var o = Object.create(null); o.valueOf = function () { return 1; }; return ${conversion};`);
    }
    // With neither, the TypeError stands.
    expectSameAsV8("var o = Object.create(null); try { return String(o); } catch (e) { return e.name + ': ' + e.message; }");
  });
});

describe('a function declaration named like a parameter', () => {
  it('writes the parameter’s binding, which a mapped arguments object aliases', () => {
    expectSameAsV8('return (function (a) { function a() {} return [typeof a, typeof arguments[0]]; })(1);');
    expectSameAsV8('return (function (a) { function a() {} arguments[0] = 5; return [a, arguments[0]]; })(1);');
    expectSameAsV8('return (function (a) { function a() {} a = 6; return arguments[0]; })(1);');
    expectSameAsV8("return (function (a) { 'use strict'; function a() {} return [typeof a, typeof arguments[0]]; })(1);");
    expectSameAsV8('return (function (a) { var a = 3; function a() {} return [a, arguments[0]]; })(1);');
    expect(interpret('return (function (a) { function a() {} return typeof arguments[0]; })(1);')).toBe('function');
  });
});

describe('other holes closed this round', () => {
  const probes: Record<string, string> = {
    'loose equality between two objects': "return [[] == [], [] == ![], ({}) == ({}), (function () { var a = []; return a == a; })(), null == {}, [] == 0, [0] == false, [1] == true, [[]] == 0, [[1]] == 1, [null] == '', [undefined] == 0];",
    'a join that nests deeper than eight': 'return [[[[[[[[[[1]]]]]]]]]].join();',
    'a join that cycles': "var a = [1]; a.push(a); var b = [2, a]; return [a.join(), b.join(), String(a), a + ''];",
    'the search of a string pattern': "return ['abc'.search('.'), 'a.c'.search('\\\\.'), 'abc'.search('[b]'), 'abc'.search('x|c')];",
    'the lastIndex a global replace leaves': "var r = /a/g; r.test('aa'); 'aa'.replace(r, 'b'); return r.lastIndex;",
    'the lastIndex a sticky exec advances': "var r = /a/y; var out = []; out.push(r.exec('aa') !== null, r.lastIndex, r.exec('aa') !== null, r.lastIndex, r.exec('aa'), r.lastIndex); return out;",
    'a lastIndex kept as written': "var r = /a/g; r.lastIndex = '1'; var out = [r.lastIndex, typeof r.lastIndex]; r.test('aa'); out.push(r.lastIndex); r.lastIndex = 1.5; out.push(r.lastIndex, r.test('aa'), r.lastIndex); return out;",
    'the named groups a replace callback sees': "return 'ab'.replace(/(?<first>a)(?<second>b)/, function () { var g = arguments[arguments.length - 1]; return typeof g + ':' + g.first + g.second + ':' + Object.keys(g).join('|') + ':' + (typeof g.hasOwnProperty); });",
    'includes with a regexp': "try { return 'a'.includes(/a/); } catch (e) { return e.name + ': ' + e.message; }",
    'replaceAll with a non-global regexp': "try { return 'a'.replaceAll(/a/, 'b'); } catch (e) { return e.name + ': ' + e.message; }",
    'the error toString rules': "var e = new Error('m'); e.name = ''; var f = new Error(''); f.name = 'N'; var g = new Error(); g.name = ''; return [String(e), String(f), String(g), String(new Error()), Error.prototype.toString.call({ name: 'A', message: 'B' })];",
    'an error name kept as written': "var e = new Error('m'); e.name = 5; e.message = true; return [e.name, e.message, typeof e.name, String(e)];",
    'instanceof an error constructor by chain': "var e = new TypeError('m'); e.name = 'RangeError'; return [e instanceof RangeError, e instanceof TypeError, e instanceof Error];",
    'a prototype written then read': 'function f() {} f.prototype = 5; var g = function () {}; g.prototype = null; return [f.prototype, g.prototype, new g() instanceof Object];',
    'RegExp called on a regexp': 'var r = /a/g; return [RegExp(r) === r, RegExp(r, undefined) === r, RegExp(r, "g") === r, new RegExp(r) === r];',
    'new RegExp of null and undefined': 'return [new RegExp(null).source, new RegExp(undefined).source, new RegExp().source, RegExp(null).test("null")];',
    'a match with no argument': "return ['abc'.match()[0], 'abc'.match().index, 'undefined'.match(undefined)[0], 'undefined'.match(undefined).index];",
    'String.raw over an object': "return [String.raw({ raw: ['a', 'b'] }, '-'), String.raw({ raw: ['a', 'b'] }), String.raw({ raw: 'xy' }, 1)];",
    'Array.from through an inherited length': "return [Array.from(Object.create({ length: 1, 0: 'z' })), Array.from({ length: 2, 0: 'a' }, function (v, i) { return [v, i, this.t]; }, { t: 1 })];",
    'Object.assign on a missing target': "try { Object.assign(null); } catch (e) { return e.name + ': ' + e.message; }",
    'Object.assign onto a frozen target': "try { Object.assign(Object.freeze({ a: 1 }), { a: 2 }); } catch (e) { return e.name; }",
    'an invalid array length': "try { var a = []; a.length = 'x'; } catch (e) { return e.name + ': ' + e.message; }",
    'a delete on a frozen object': 'var o = Object.freeze({ a: 1 }); return [delete o.a, delete o.nope, o.a];',
    'a strict write to a frozen object': "'use strict'; var o = Object.freeze({ a: 1 }); try { o.a = 2; } catch (e) { return [e.name, o.a]; }",
    'a strict write to a primitive': "'use strict'; try { 'abc'.x = 1; } catch (e) { return e.name; }",
    'a strict write to a function name': "'use strict'; try { (function () {}).name = 'x'; } catch (e) { return e.name; }",
    'a strict delete of a non-configurable property': "'use strict'; try { delete [].length; } catch (e) { return e.name; }",
    'a strict delete of callee': "'use strict'; try { delete arguments.callee; } catch (e) { return e.name; }",
    'delete of a declared name': 'var v = 1; function f() {} return [delete v, delete f, v, typeof f];',
    'JSON.stringify of an invalid date': 'return JSON.stringify([new Date(NaN), new Date(0)]);',
    'JSON.stringify with a space V8 ignores': "return [JSON.stringify({ a: 1 }, null, [5]), JSON.stringify({ a: 1 }, null, {}), JSON.stringify({ a: 1 }, null, true), JSON.stringify({ a: 1 }, 7)];",
    'Array.isArray of Array.prototype': 'return Array.isArray(Array.prototype);',
    'Number.prototype methods on a non-number': "var out = []; try { Number.prototype.toString.call('x'); } catch (e) { out.push(e.name); } try { Number.prototype.toFixed.call('1'); } catch (e) { out.push(e.name); } try { Boolean.prototype.toString.call(1); } catch (e) { out.push(e.name); } try { String.prototype.toString.call(1); } catch (e) { out.push(e.name); } try { (function () {}).toString.call(1); } catch (e) { out.push(e.name); } return out;",
    'Object.fromEntries of a non-entry': "try { Object.fromEntries([5]); } catch (e) { return e.name; }",
    'a hole is not in its array, but a prototype method is': "var a = [1, , 3]; return [1 in a, 'push' in a, 'hasOwnProperty' in a, 5 in a, '1' in a, 0 in a];",
  };
  for (const [what, body] of Object.entries(probes)) {
    it(`computes ${what} as V8 does`, () => expectSameAsV8(body));
  }
});

// ---------------------------------------------------------------------------
// 5. Each closed hole gating a decoder, end to end
// ---------------------------------------------------------------------------

/**
 * Each initialiser computes 1 under V8 and computed 0 - or a value the model
 * could not tell from 0 - under the round-four interpreter. The decoder
 * subtracts one from the index when the value is falsy, the native tier reads
 * that subtraction as unconditional, and only an interpreter that either
 * computes 1 or refuses keeps the wrong strings out of the output.
 */
const GATES: Record<string, string> = {
  'apply hands a dense list': "var _0xs = Array.apply(null, Array(3)).map(function (_, i) { return i; }).join() === '0,1,2' ? 1 : 0;",
  'apply fills the callee’s arguments': "var _0xs = (function () { return 0 in arguments ? 1 : 0; }).apply(null, [ , 1]);",
  'delete of name': "var _0xs = (function () { function f() {} delete f.name; return f.name === '' && !f.hasOwnProperty('name') ? 1 : 0; })();",
  'delete of length': 'var _0xs = (function () { function g(a) {} delete g.length; return g.length === 0 ? 1 : 0; })();',
  'this at the top level of a strict script': "'use strict';\nvar _0xs = typeof this === 'object' ? 1 : 0;",
  'an own valueOf on a prototype-less object': "var _0xs = (function () { var o = Object.create(null); o.valueOf = function () { return 1; }; return String(o) === '1' ? 1 : 0; })();",
  'a function declaration over a parameter, through arguments': "var _0xs = (function (a) { function a() {} return typeof arguments[0] === 'function' ? 1 : 0; })(0);",
  'Object.keys of Math': 'var _0xs = Object.keys(Math).length === 0 ? 1 : 0;',
  'JSON.stringify of Math': "var _0xs = JSON.stringify(Math) === '{}' ? 1 : 0;",
  'getOwnPropertyNames of JSON': 'var _0xs = Object.getOwnPropertyNames(JSON).length !== 2 ? 1 : 0;',
  'propertyIsEnumerable on Math': "var _0xs = Math.propertyIsEnumerable('PI') ? 0 : 1;",
  'for...in over Math': 'var _0xs = (function () { var n = 1; for (var k in Math) n = 0; return n; })();',
  'a builtin the table does not list': "var _0xs = typeof [].flat === 'function' ? 1 : 0;",
  'a builtin static the table does not list': "var _0xs = typeof Object.getPrototypeOf === 'function' ? 1 : 0;",
  'a wrapper object': "var _0xs = typeof new String('a') === 'object' ? 1 : 0;",
  'Object() of a primitive': "var _0xs = typeof Object('s') === 'object' ? 1 : 0;",
  'a strict write to a frozen object': "var _0xs = (function () { 'use strict'; var o = Object.freeze({ a: 1 }); try { o.a = 2; return 0; } catch (e) { return 1; } })();",
  'delete of a declared name': 'var _0xv = 1; var _0xs = delete _0xv ? 0 : 1;',
  'an async function': "var _0xs = (function () { var f = async function () { return 0; }; return typeof f() === 'object' ? 1 : 0; })();",
  'a toJSON': "var _0xs = JSON.stringify({ toJSON: function () { return 1; } }) === '1' ? 1 : 0;",
  'a replacer': "var _0xs = JSON.stringify({ a: 1 }, function (k, v) { return k === 'a' ? 2 : v; }) === '{\"a\":2}' ? 1 : 0;",
  'the lastIndex a global replace leaves': "var _0xs = (function () { var r = /a/g; r.test('aa'); 'aa'.replace(r, 'b'); return r.lastIndex === 0 ? 1 : 0; })();",
  'the search of a string pattern': "var _0xs = 'abc'.search('.') === 0 ? 1 : 0;",
  'loose equality between two arrays': 'var _0xs = [] == [] ? 0 : 1;',
  'the error toString rule for an empty name': "var _0xs = (function () { var e = new Error('m'); e.name = ''; return String(e) === 'm' ? 1 : 0; })();",
  'an error’s stack': "var _0xs = (function () { try { throw new Error('m'); } catch (e) { return e.stack.length > 8 ? 1 : 0; } })();",
  'a function’s arguments property': "var _0xs = (function f() { return typeof f.arguments === 'object' ? 1 : 0; })();",
  'isPrototypeOf': "var _0xs = typeof ({}).isPrototypeOf === 'function' ? 1 : 0;",
  'toLocaleString': "var _0xs = typeof (1).toLocaleString === 'function' ? 1 : 0;",
  'includes with a regexp': "var _0xs = (function () { try { 'a/b/'.includes(/b/); return 0; } catch (e) { return 1; } })();",
  'a join nested deeper than eight': "var _0xs = [[[[[[[[[[1]]]]]]]]]].join() === '1' ? 1 : 0;",
  'Object.create of a builtin prototype': 'var _0xs = (function () { var o = Object.create(Array.prototype); try { o.push(1); return o.length === 1 ? 1 : 0; } catch (e) { return 0; } })();',
  'Array.from through an inherited length': 'var _0xs = Array.from(Object.create({ length: 1, 0: 1 })).length;',
  'an error with options': "var _0xs = new Error('m', { cause: 1 }).cause === 1 ? 1 : 0;",
  'String.raw over an object': "var _0xs = String.raw({ raw: ['a', 'b'] }, '-') === 'a-b' ? 1 : 0;",
  'RegExp called on a regexp': 'var _0xs = (function () { var r = /a/; return RegExp(r) === r ? 1 : 0; })();',
  'instanceof an error constructor by chain': "var _0xs = (function () { var e = new Error('m'); e.name = 'TypeError'; return e instanceof TypeError ? 0 : 1; })();",
  'an invalid array length': "var _0xs = (function () { try { var a = []; a.length = 'x'; return 0; } catch (e) { return 1; } })();",
  'Array.isArray of Array.prototype': 'var _0xs = Array.isArray(Array.prototype) ? 1 : 0;',
  'a Number.prototype method on a string': "var _0xs = (function () { try { Number.prototype.toString.call('x'); return 0; } catch (e) { return 1; } })();",
  'a strict delete of callee': "var _0xs = (function () { 'use strict'; try { delete arguments.callee; return 0; } catch (e) { return 1; } })();",
  'a delete on a frozen object': 'var _0xs = delete Object.freeze({}).nope ? 1 : 0;',
  'an error name kept as written': "var _0xs = (function () { var e = new Error('m'); e.name = 5; return typeof e.name === 'number' ? 1 : 0; })();",
  'a prototype written then read': 'var _0xs = (function () { function f() {} f.prototype = 5; return f.prototype === 5 ? 1 : 0; })();',
  'an instance whose prototype is an array': "var _0xs = (function () { function F() {} F.prototype = []; var o = new F(); return typeof o.push === 'function' ? 1 : 0; })();",
  'a match with no argument': "var _0xs = 'abc'.match().index === 0 ? 1 : 0;",
};

describe('a decoder gated on each closed hole', () => {
  const gated = (init: string): string => `${init.startsWith("'use strict'") ? "'use strict';\n" : ''}
    var _0xt = ['alpha', 'beta', 'gamma'];
    ${init.startsWith("'use strict'") ? init.slice(init.indexOf('\n') + 1) : init}
    function _0xd(_0xi) { if (!_0xs) _0xi = _0xi - 0x1; return _0xt[_0xi]; }
    log(_0xd(1), _0xd(2));
  `;

  for (const [what, init] of Object.entries(GATES)) {
    it(`decodes or refuses, but never inlines the native reading, for ${what}`, async () => {
      // The realm this runs in computes 1, so the program prints `t[1], t[2]`.
      expect(execute(gated(init)), init).toBe('"beta" "gamma"');
      // Native alone reads the gated subtraction as unconditional.
      const nativeOnly = build(gated(init), ['_0xd'], {
        techniques: { stringDecoding: { tiers: ['native'] } },
      });
      expect(nativeOnly.decoder?.decode([1])).toBe('alpha');

      const { decoder, notes } = build(gated(init), ['_0xd']);
      if (decoder) {
        // The interpreter computed what V8 computes, contradicted the native
        // reading, and its own answer was taken.
        expect(decoder.tier).toBe('interpreter');
        expect(decoder.decode([1])).toBe('beta');
        expect(notes.some((note) => note.severity === 'error' && note.message.includes('disagree'))).toBe(true);
      } else {
        // The interpreter refused the slice, and with it the native reading.
        expect(notes.some((note) => note.message.includes('cannot be checked') || note.message.includes('Refusing'))).toBe(true);
      }

      for (const preset of PRESETS) {
        // The table may stay (refused) or go (inlined); the wrong string may
        // not be printed either way.
        const code = await expectSameBehaviour(gated(init), { preset });
        expect(code).not.toContain("log('alpha'");
      }
    });
  }
});
