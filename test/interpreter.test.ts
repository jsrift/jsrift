import { parse } from '@babel/parser';
import { cloneNode } from '@babel/types';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
  CallDepthExceeded,
  createInterpreter,
  InterpreterRefusal,
  InterpreterRuntimeError,
  MemoryLimitExceeded,
  StepLimitExceeded,
  UnsupportedSyntaxError,
  type Interpreter,
  type InterpreterOptions,
} from '../src/analysis/evaluator/interpreter.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function statementsOf(source: string): t.Statement[] {
  return parse(source, { sourceType: 'script' }).program.body;
}

function load(source: string, options: InterpreterOptions = {}): Interpreter {
  return createInterpreter(statementsOf(source), options);
}

/** Run a function body and return what it returns, as plain host data. */
function evaluate(body: string, options: InterpreterOptions = {}): unknown {
  return load(`var __result = (function () {\n${body}\n})();`, options).read('__result');
}

// ---------------------------------------------------------------------------
// Literals and expressions
// ---------------------------------------------------------------------------

describe('literals', () => {
  it('evaluates primitive literals', () => {
    expect(evaluate("return [1, 'a', true, false, null, 0x1f, 1e3];")).toEqual([
      1,
      'a',
      true,
      false,
      null,
      31,
      1000,
    ]);
  });

  it('evaluates template literals with interpolation', () => {
    expect(evaluate('var n = 4; return `a${n}b${n * 2}c`;')).toBe('a4b8c');
  });

  it('evaluates array literals with holes and spread', () => {
    expect(evaluate('var mid = [2, 3]; return [1, ...mid, 4];')).toEqual([1, 2, 3, 4]);
    expect(evaluate('return [1, , 3].length;')).toBe(3);
  });

  it('evaluates object literals with computed keys, methods and spread', () => {
    expect(
      evaluate(`
        var k = 'dyn';
        var base = { a: 1 };
        var o = { ...base, [k + 'amic']: 2, m: function () { return 3; } };
        return [o.a, o.dynamic, o.m()];
      `),
    ).toEqual([1, 2, 3]);
  });

  it('evaluates regular expression literals as values', () => {
    expect(evaluate("return /a(b+)c/.exec('xabbbc')[1];")).toBe('bbb');
    expect(evaluate("return /^\\d+$/.test('12345');")).toBe(true);
  });
});

describe('operators', () => {
  it('applies arithmetic with correct precedence', () => {
    expect(evaluate('return 2 + 3 * 4 - 6 / 3;')).toBe(12);
    expect(evaluate('return 2 ** 10 % 1000;')).toBe(24);
  });

  it('applies bitwise operators including >>> and ^', () => {
    expect(evaluate('return (-1 >>> 28);')).toBe(15);
    expect(evaluate('return (0xf0 ^ 0x0f);')).toBe(255);
    expect(evaluate('return [5 & 3, 5 | 3, ~5, 1 << 10, -16 >> 2];')).toEqual([1, 7, -6, 1024, -4]);
  });

  it('concatenates with + and coerces like JavaScript', () => {
    expect(evaluate("return 1 + '2';")).toBe('12');
    expect(evaluate("return '3' * '4';")).toBe(12);
    expect(evaluate("return [1,2] + '';")).toBe('1,2');
  });

  it('compares strings lexicographically and numbers numerically', () => {
    expect(evaluate("return ['b' > 'a', '10' < '9', 10 < 9, '10' < 9];")).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('distinguishes loose from strict equality', () => {
    expect(evaluate("return [1 == '1', 1 === '1', null == undefined, null === undefined];")).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('short-circuits &&, || and ??', () => {
    expect(
      evaluate(`
        var calls = 0;
        function bump() { calls++; return 'x'; }
        var a = false && bump();
        var b = true || bump();
        var c = null ?? 'fallback';
        var d = 0 ?? 'not-used';
        return [a, b, c, d, calls];
      `),
    ).toEqual([false, true, 'fallback', 0, 0]);
  });

  it('evaluates conditional and sequence expressions', () => {
    expect(evaluate("return (1, 2, 3) === 3 ? 'yes' : 'no';")).toBe('yes');
  });

  it('applies unary operators', () => {
    expect(
      evaluate(`
        var o = { a: 1 };
        var deleted = delete o.a;
        return [-'5', +'6', !0, ~2, typeof 'x', void 0, deleted, o.a];
      `),
    ).toEqual([-5, 6, true, -3, 'string', undefined, true, undefined]);
  });

  it('applies ++ and -- in prefix and postfix position', () => {
    expect(
      evaluate(`
        var i = 5;
        var post = i++;
        var pre = ++i;
        var o = { n: 1 };
        var mpost = o.n++;
        return [post, pre, i, mpost, o.n];
      `),
    ).toEqual([5, 7, 7, 1, 2]);
  });

  it('applies compound assignment operators', () => {
    expect(
      evaluate(`
        var a = 5; a += 3;
        var b = 5; b *= 3;
        var c = 0xff; c ^= 0x0f;
        var d = -1; d >>>= 28;
        var e = null; e ??= 'set';
        var f = 'keep'; f ||= 'ignored';
        var g = 1; g &&= 9;
        return [a, b, c, d, e, f, g];
      `),
    ).toEqual([8, 15, 240, 15, 'set', 'keep', 9]);
  });

  it('reports typeof for an undeclared name without throwing', () => {
    expect(evaluate("return typeof someUndeclaredName === 'undefined';")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

describe('declarations', () => {
  it('honours var, let and const', () => {
    expect(evaluate('var a = 1; let b = 2; const c = 3; return a + b + c;')).toBe(6);
  });

  it('rejects assignment to a const binding', () => {
    expect(() => evaluate('const c = 1; c = 2; return c;')).toThrow(InterpreterRuntimeError);
  });

  it('gives let block scope and var function scope', () => {
    expect(
      evaluate(`
        var out = [];
        { let x = 'inner'; out.push(x); }
        { var y = 'hoisted'; }
        out.push(typeof x, y);
        return out;
      `),
    ).toEqual(['inner', 'undefined', 'hoisted']);
  });

  it('hoists function declarations above their position', () => {
    expect(evaluate('return early(); function early() { return 42; }')).toBe(42);
  });

  it('enforces the temporal dead zone for let', () => {
    expect(() => evaluate('return before; let before = 1;')).toThrow(InterpreterRuntimeError);
  });
});

describe('control flow', () => {
  it('executes if/else', () => {
    expect(evaluate("if (1 > 2) { return 'a'; } else if (2 > 1) { return 'b'; } return 'c';")).toBe('b');
  });

  it('runs a for loop', () => {
    expect(evaluate('var s = 0; for (var i = 0; i < 5; i++) s += i; return s;')).toBe(10);
  });

  it('gives each for-let iteration its own binding', () => {
    expect(
      evaluate(`
        var fns = [];
        for (let i = 0; i < 3; i++) fns.push(function () { return i; });
        return fns.map(function (f) { return f(); });
      `),
    ).toEqual([0, 1, 2]);
  });

  it('shares one binding across for-var iterations', () => {
    expect(
      evaluate(`
        var fns = [];
        for (var i = 0; i < 3; i++) fns.push(function () { return i; });
        return fns.map(function (f) { return f(); });
      `),
    ).toEqual([3, 3, 3]);
  });

  it('runs while and do-while, and do-while runs at least once', () => {
    expect(evaluate('var n = 0; while (n < 4) n++; return n;')).toBe(4);
    expect(evaluate('var n = 0; do { n++; } while (false); return n;')).toBe(1);
  });

  it('iterates an object with for-in', () => {
    expect(
      evaluate(`
        var o = { a: 1, b: 2, c: 3 };
        var out = [];
        for (var k in o) out.push(k + '=' + o[k]);
        return out.join(',');
      `),
    ).toBe('a=1,b=2,c=3');
  });

  it('iterates arrays and strings with for-of', () => {
    expect(evaluate("var out = []; for (const v of [1, 2, 3]) out.push(v * 2); return out;")).toEqual([
      2, 4, 6,
    ]);
    expect(evaluate("var out = ''; for (const ch of 'abc') out = ch + out; return out;")).toBe('cba');
  });

  it('honours a labelled break', () => {
    expect(
      evaluate(`
        var hits = [];
        outer: for (var i = 0; i < 3; i++) {
          for (var j = 0; j < 3; j++) {
            if (i === 1 && j === 1) break outer;
            hits.push(i + ':' + j);
          }
        }
        return hits.join(',');
      `),
    ).toBe('0:0,0:1,0:2,1:0');
  });

  it('honours a labelled continue', () => {
    expect(
      evaluate(`
        var hits = [];
        outer: for (var i = 0; i < 3; i++) {
          for (var j = 0; j < 3; j++) {
            if (j === 1) continue outer;
            hits.push(i + ':' + j);
          }
        }
        return hits.join(',');
      `),
    ).toBe('0:0,1:0,2:0');
  });

  it('breaks out of a labelled block', () => {
    expect(
      evaluate(`
        var out = [];
        done: { out.push('a'); if (out.length) break done; out.push('b'); }
        out.push('c');
        return out.join(',');
      `),
    ).toBe('a,c');
  });

  it('falls through switch cases until a break', () => {
    const source = `
      function classify(x) {
        var out = [];
        switch (x) {
          case 1: out.push('one');
          case 2: out.push('two'); break;
          case 3: out.push('three');
          default: out.push('other');
        }
        return out.join(',');
      }
    `;
    const interpreter = load(source);
    expect(interpreter.call('classify', [1])).toBe('one,two');
    expect(interpreter.call('classify', [2])).toBe('two');
    expect(interpreter.call('classify', [3])).toBe('three,other');
    expect(interpreter.call('classify', [99])).toBe('other');
  });

  it('runs try/catch/finally in the right order', () => {
    expect(
      evaluate(`
        var log = [];
        function f() {
          try { log.push('try'); return 'from-try'; }
          catch (e) { log.push('catch'); }
          finally { log.push('finally'); }
        }
        var r = f();
        return log.join(',') + '|' + r;
      `),
    ).toBe('try,finally|from-try');
  });

  it('lets an abrupt finally override the pending completion', () => {
    expect(evaluate('function g() { try { return 1; } finally { return 2; } } return g();')).toBe(2);
    expect(
      evaluate("function g() { try { throw new Error('x'); } finally { return 'swallowed'; } } return g();"),
    ).toBe('swallowed');
  });

  it('catches a thrown Error and reads its message', () => {
    expect(
      evaluate(`
        try { throw new TypeError('bad input'); }
        catch (e) { return e.name + ': ' + e.message; }
      `),
    ).toBe('TypeError: bad input');
  });

  it('runs finally before rethrowing an uncaught error', () => {
    expect(
      evaluate(`
        var log = [];
        try {
          try { throw new Error('boom'); } finally { log.push('cleanup'); }
        } catch (e) { log.push(e.message); }
        return log.join(',');
      `),
    ).toBe('cleanup,boom');
  });
});

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

describe('functions', () => {
  it('supports closures over mutable state', () => {
    expect(
      evaluate(`
        function counter() { var n = 0; return function () { return ++n; }; }
        var c = counter();
        c(); c();
        return [c(), counter()()];
      `),
    ).toEqual([3, 1]);
  });

  it('supports recursion', () => {
    expect(evaluate('function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); } return fact(10);')).toBe(
      3628800,
    );
  });

  it('supports a named function expression calling itself', () => {
    expect(
      evaluate("var f = function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }; return f(12);"),
    ).toBe(144);
  });

  it('exposes arguments inside a function', () => {
    expect(
      evaluate(`
        function f() { return arguments.length + ':' + arguments[0] + ',' + arguments[1]; }
        return f(7, 8, 9);
      `),
    ).toBe('3:7,8');
  });

  it('binds this for a method call', () => {
    expect(evaluate('var o = { n: 5, get: function () { return this.n; } }; return o.get();')).toBe(5);
  });

  it('gives arrow functions a lexical this', () => {
    expect(
      evaluate(`
        var o = { n: 5, get: function () { var inner = () => this.n * 2; return inner(); } };
        return o.get();
      `),
    ).toBe(10);
  });

  it('supports default parameters, rest parameters and spread arguments', () => {
    expect(
      evaluate(`
        function f(a, b = 10, ...rest) { return [a, b, rest]; }
        return [f(1), f(1, 2, 3, 4), f(...[5, 6, 7])];
      `),
    ).toEqual([
      [1, 10, []],
      [1, 2, [3, 4]],
      [5, 6, [7]],
    ]);
  });

  it('constructs objects with new and finds prototype methods', () => {
    expect(
      evaluate(`
        function Point(x, y) { this.x = x; this.y = y; }
        Point.prototype.sum = function () { return this.x + this.y; };
        var p = new Point(2, 3);
        return [p.sum(), p instanceof Point];
      `),
    ).toEqual([5, true]);
  });

  it('supports call, apply and bind', () => {
    expect(
      evaluate(`
        function greet(a, b) { return this.name + a + b; }
        var ctx = { name: 'n' };
        return [greet.call(ctx, '1', '2'), greet.apply(ctx, ['3', '4']), greet.bind(ctx, '5')('6')];
      `),
    ).toEqual(['n12', 'n34', 'n56']);
  });

  it('destructures arrays and objects, with defaults and rest', () => {
    expect(
      evaluate(`
        var [a, b = 9, ...tail] = [1, undefined, 3, 4];
        var { x, y: renamed = 7, ...others } = { x: 1, w: 2, v: 3 };
        return [a, b, tail, x, renamed, others];
      `),
    ).toEqual([1, 9, [3, 4], 1, 7, { w: 2, v: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

describe('builtins', () => {
  it('provides the String methods decoders rely on', () => {
    expect(
      evaluate(`
        var s = ' Hello World ';
        return [
          s.trim().toLowerCase(),
          s.charCodeAt(1),
          String.fromCharCode(104, 105),
          s.trim().split(' ').join('-'),
          s.indexOf('World'),
          'ab'.repeat(3),
          '7'.padStart(3, '0'),
          'abcdef'.slice(2, 4),
          'abcdef'.substr(1, 3),
          'abc'.startsWith('ab'),
          'abc'.endsWith('bc'),
          '\\u{1f600}'.codePointAt(0)
        ];
      `),
    ).toEqual([
      'hello world',
      72,
      'hi',
      'Hello-World',
      7,
      'ababab',
      '007',
      'cd',
      'bcd',
      true,
      true,
      128512,
    ]);
  });

  it('supports replace with a string and with a function', () => {
    expect(
      evaluate(`
        return [
          'a-b-c'.replace('-', '+'),
          'a-b-c'.replace(/-/g, '+'),
          'a1b2'.replace(/\\d/g, function (m) { return String(Number(m) * 2); }),
          'xy'.replace(/(x)(y)/, '$2$1')
        ];
      `),
    ).toEqual(['a+b-c', 'a+b+c', 'a2b4', 'yx']);
  });

  it('provides the Array methods decoders rely on', () => {
    expect(
      evaluate(`
        var a = [3, 1, 2];
        var sorted = a.slice().sort(function (x, y) { return x - y; });
        var spliced = [1, 2, 3, 4]; spliced.splice(1, 2, 'x');
        return [
          a.concat([4]).join(','),
          sorted,
          spliced,
          [1, 2, 3].map(function (n) { return n * 2; }),
          [1, 2, 3, 4].filter(function (n) { return n % 2 === 0; }),
          [1, 2, 3].reduce(function (acc, n) { return acc + n; }, 0),
          [1, 2, 3].indexOf(2),
          [1, 2, 3].includes(9),
          [1, 2, 3].reverse()
        ];
      `),
    ).toEqual([
      '3,1,2,4',
      [1, 2, 3],
      [1, 'x', 4],
      [2, 4, 6],
      [2, 4],
      6,
      1,
      false,
      [3, 2, 1],
    ]);
  });

  it('rotates an array with push/shift, the obfuscator.io primitive', () => {
    expect(
      evaluate("var a = ['a','b','c','d']; a.push(a.shift()); a.push(a.shift()); return a.join('');"),
    ).toBe('cdab');
  });

  it('provides Number, parseInt and parseFloat', () => {
    expect(
      evaluate(`
        return [
          parseInt('ff', 16),
          parseInt('0x1f'),
          parseFloat('3.25rest'),
          (1234567).toString(36),
          Number('42'),
          isNaN(Number('x')),
          Number.isInteger(4)
        ];
      `),
    ).toEqual([255, 31, 3.25, 'qglj', 42, true, true]);
  });

  it('provides the pure Math methods', () => {
    expect(
      evaluate(`
        return [
          Math.floor(Math.PI * 100) / 100,
          Math.max(1, 9, 5),
          Math.min(1, 9, 5),
          Math.abs(-4),
          Math.pow(2, 8),
          Math.round(2.5),
          Math.imul(3, 4)
        ];
      `),
    ).toEqual([3.14, 9, 1, 4, 256, 3, 12]);
  });

  it('round-trips JSON', () => {
    expect(evaluate('return JSON.stringify(JSON.parse(\'{"a":[1,2,{"b":"c"}]}\'));')).toBe(
      '{"a":[1,2,{"b":"c"}]}',
    );
  });

  it('provides Object.keys, values and entries', () => {
    expect(
      evaluate("var o = { a: 1, b: 2 }; return [Object.keys(o), Object.values(o), Object.entries(o)];"),
    ).toEqual([
      ['a', 'b'],
      [1, 2],
      [
        ['a', 1],
        ['b', 2],
      ],
    ]);
  });

  it('implements binary-safe atob and btoa', () => {
    expect(
      evaluate(`
        var all = '';
        for (var i = 0; i < 256; i++) all += String.fromCharCode(i);
        var encoded = btoa(all);
        return [atob(encoded) === all, btoa('hi'), atob('aGk=')];
      `),
    ).toEqual([true, 'aGk=', 'hi']);
  });

  it('rejects out-of-range input to btoa and malformed input to atob', () => {
    expect(evaluate("try { btoa('\\u0100'); } catch (e) { return e.name; }")).toBe(
      'InvalidCharacterError',
    );
    expect(evaluate("try { atob('a'); } catch (e) { return e.name; }")).toBe('InvalidCharacterError');
  });

  it('encodes and decodes URI components', () => {
    expect(evaluate("return decodeURIComponent(encodeURIComponent('a b/c%d'));")).toBe('a b/c%d');
  });

  it('constructs RegExp objects and runs test, exec and match', () => {
    expect(
      evaluate(`
        var re = new RegExp('(\\\\w)(\\\\d)', 'g');
        var m = 'a1 b2'.match(re);
        var single = /(\\w)(\\d)/.exec('a1');
        return [re.test('c3'), m, single[1], single[2], single.index];
      `),
    ).toEqual([true, ['a1', 'b2'], 'a', '1', 0]);
  });

  it('supports the Object.prototype.hasOwnProperty.call idiom obfuscators emit', () => {
    expect(
      evaluate(`
        var map = { zQdKB: 'hit' };
        var has = Object['prototype']['hasOwnProperty']['call'](map, 'zQdKB');
        var missing = Object['prototype']['hasOwnProperty']['call'](map, 'other');
        return [has, missing, map['zQdKB']];
      `),
    ).toEqual([true, false, 'hit']);
  });

  it('supports borrowing a prototype method with call', () => {
    expect(evaluate("return String.prototype.charCodeAt.call('A', 0);")).toBe(65);
  });

  it('refuses the clock rather than freezing it', () => {
    // A frozen clock made two runs agree with each other and neither with the
    // program: a decoder keyed on the year decoded to 2023's string in 2026.
    // The refusal is not catchable, so a decoder cannot fall back to a default.
    expect(() => evaluate('return Date.now();')).toThrow(InterpreterRefusal);
    expect(() => evaluate('return new Date().getTime();')).toThrow(InterpreterRefusal);
    expect(() => evaluate("try { return Date.now(); } catch (e) { return 'caught'; }")).toThrow(
      InterpreterRefusal,
    );
    // A time value the program itself supplies is a fact about the program.
    expect(evaluate("return [new Date(0).getTime(), new Date('2020-01-02').toISOString()];")).toEqual([
      0,
      '2020-01-02T00:00:00.000Z',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  it('refuses the constructor.constructor escape on every value shape, uncatchably', () => {
    // The canonical break of every "shadow the globals" sandbox. `.constructor`
    // is outside the object model, so the chain dies at the first hop with a
    // refusal - not a value, and not a TypeError the program could `catch`
    // and route around. An earlier table answered `undefined`, which the
    // `try { ... } catch {}` below swallowed into a silently wrong run.
    expect(() =>
      evaluate(`
        try {
          var leaked = ({}).constructor.constructor('return this')();
          return 'ESCAPED:' + typeof leaked;
        } catch (e) { return 'blocked:' + e.name; }
      `),
    ).toThrow(InterpreterRefusal);
  });

  it('refuses .constructor on objects, arrays, strings, numbers, booleans, regexps and prototypes', () => {
    const receivers = ['({})', '[]', "''", '(5)', 'true', '/x/', 'f.prototype', 'Math'];
    for (const receiver of receivers) {
      expect(() => evaluate(`function f() {} return typeof ${receiver}.constructor;`), receiver).toThrow(
        /'constructor' property leads from any value back to Function/,
      );
    }
  });

  it('answers .constructor on a function with a Function that compiles the global-object idiom and nothing else', () => {
    // The one link of the chain the model answers, because what it leads to
    // runs no source: `Function('return this')()` is the sandbox global, an
    // object of the interpreter's own, and every other source is refused.
    expect(evaluate('function f() {} return [typeof f.constructor, f.constructor === Object.constructor, f.constructor === Function];')).toEqual([
      'function',
      true,
      true,
    ]);
    expect(evaluate("function f() {} var g = f.constructor('return this')(); return [typeof g, g.String === String, g.Math === Math];")).toEqual([
      'object',
      true,
      true,
    ]);
    for (const source of ["'return process'", "'return 1'", "'a', 'return a'", "''", "'return this; 1'", "'return globalThis'"]) {
      expect(() => evaluate(`function f() {} return f.constructor(${source})();`), source).toThrow(
        /compiles source the interpreter does not run/,
      );
    }
    // What the idiom hands back is the sandbox, not the host: a host global is refused, not read.
    for (const name of ['process', 'document', 'require', 'globalThis', 'Reflect', 'setTimeout']) {
      expect(() => evaluate(`function f() {} return f.constructor('return this')().${name};`), name).toThrow(InterpreterRefusal);
    }
  });

  it('refuses the escape through computed and aliased property access too', () => {
    const probes = ["({})[key]", "[]['constructor']", "''['constructor']"];
    for (const probe of probes) {
      expect(() => evaluate(`var key = 'cons' + 'tructor'; return typeof ${probe};`), probe).toThrow(
        InterpreterRefusal,
      );
    }
    // Through a function the chain reaches `Function`, which is no escape: the
    // classic `[key]('return this')()` yields the sandbox, and a source that
    // is not the idiom is refused before it is compiled.
    expect(evaluate("var key = 'cons' + 'tructor'; return typeof (function () {})[key]('return this')();")).toBe('object');
    expect(() => evaluate("var key = 'cons' + 'tructor'; return (function () {})[key]('return this')().process;")).toThrow(
      InterpreterRefusal,
    );
    expect(() => evaluate("var key = 'cons' + 'tructor'; return (function () {})[key]('return process')();")).toThrow(
      InterpreterRefusal,
    );
  });

  it('refuses every touch of __proto__ and the Object.prototype accessors', () => {
    const touches = [
      'var o = {}; return o.__proto__;',
      'var o = {}; o.__proto__ = { injected: 1 }; return o.injected;',
      "var o = {}; return '__proto__' in o;",
      "var o = {}; return o.hasOwnProperty('__proto__');",
      'var o = {}; return delete o.__proto__;',
      "return [].__defineGetter__;",
      "return ({}).__lookupSetter__;",
      "return Object.keys({ ['__proto__']: 1 });",
      "return JSON.parse('{\"__proto__\":1}');",
      "return Object.fromEntries([['constructor', 1]]);",
      'return { constructor: 1 };',
    ];
    for (const touch of touches) {
      expect(() => evaluate(touch), touch).toThrow(InterpreterRefusal);
    }
  });

  it('models the literal __proto__ form as the prototype it sets', () => {
    // `{ __proto__: x }` is a prototype, not a property, and a null one is a
    // chain that ends nowhere: no `toString`, no `hasOwnProperty`, no
    // conversion to a string.
    expect(
      evaluate(`
        var base = { z: 1 };
        var o = { __proto__: base, a: 1 };
        var n = { __proto__: null, b: 2 };
        var p = { __proto__: 5 };
        var out = [o.z, Object.keys(o), typeof n.toString, Object.keys(n), 'b' in n, n instanceof Object, typeof p.toString];
        try { out.push('' + n); } catch (e) { out.push(e.name + ': ' + e.message); }
        return out;
      `),
    ).toEqual([1, ['a'], 'undefined', ['b'], true, false, 'function', 'TypeError: Cannot convert object to primitive value']);
    expect(() => evaluate('return { __proto__: function () {} };')).toThrow(InterpreterRefusal);
    expect(() => evaluate('return { __proto__: [] };')).toThrow(InterpreterRefusal);
  });

  it('leaves every host global unreachable', () => {
    const forbidden = [
      'globalThis',
      'window',
      'self',
      'global',
      'document',
      'navigator',
      'location',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'Worker',
      'importScripts',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'require',
      'module',
      'exports',
      'process',
      'setTimeout',
      'setInterval',
      'queueMicrotask',
      'Reflect',
      'Proxy',
      'WebAssembly',
      'crypto',
      'Buffer',
    ];
    for (const name of forbidden) {
      expect(evaluate(`return typeof ${name};`)).toBe('undefined');
      expect(evaluate(`try { return ${name}; } catch (e) { return 'ReferenceError'; }`)).toBe(
        'ReferenceError',
      );
    }
  });

  it('binds Function and eval to builtins that compile the global-object idiom and refuse every other source', () => {
    expect(evaluate('return [typeof Function, typeof eval, Function.name, eval.name];')).toEqual(['function', 'function', 'Function', 'eval']);
    // The idiom, in each spelling, is the sandbox global: the interpreter's own realm.
    expect(
      evaluate(
        "var a = Function('return this')(); var b = new Function('return this')(); var c = (0, eval)('this'); var d = Function('return (function() {}.constructor(\"return this\")( ));')(); return [typeof a, a === b, b === c, c === d, a.String === String];",
      ),
    ).toEqual(['object', true, true, true, true]);
    // Every other source is a refusal, not a compile: the program is never run.
    for (const body of [
      "return Function('return process')();",
      "return Function('return 1')();",
      "return new Function('x', 'return x')(1);",
      "return (0, eval)('1 + 1');",
      "return (0, eval)('process');",
      "return eval('this');",
      "return eval('1');",
      "var e = eval; return e('this');",
      "return Function('return this')().process;",
      "return Function('return this')().setTimeout;",
      "var g = Function('return this')(); g.x = 1; return g.y;",
    ]) {
      expect(() => evaluate(body), body).toThrow(InterpreterRefusal);
    }
    // A polyfill assigned onto the sandbox global is what a bare name resolves to afterwards.
    expect(evaluate("var g = Function('return this')(); g.atob = function (s) { return 'poly:' + s; }; return atob('x');")).toBe('poly:x');
    expect(evaluate("var g = Function('return this')(); return (g.atob || (g.atob = function () { return 'poly'; })) === atob;")).toBe(true);
    expect(evaluate("var g = (0, eval)('this'); g.made = 7; return made;")).toBe(7);
  });

  it('refuses dynamic import and other unsupported syntax rather than guessing', () => {
    expect(() => load('var p = import("./x.js");')).toThrow(UnsupportedSyntaxError);
    expect(() => load('class A {}')).toThrow(UnsupportedSyntaxError);
  });

  it('terminates while (1) {} through the step budget', () => {
    expect(() => load('while (1) {}', { maxSteps: 50_000 })).toThrow(StepLimitExceeded);
  });

  it('terminates a busy loop that swallows exceptions', () => {
    // A decoder cannot catch its way out of the budget: limit errors bypass
    // interpreted try/catch entirely.
    expect(() =>
      load('while (true) { try { var x = 1; } catch (e) { } }', { maxSteps: 50_000 }),
    ).toThrow(StepLimitExceeded);
  });

  it('throws on deep recursion instead of blowing the host stack', () => {
    expect(() =>
      evaluate('function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } return f(100000);', {
        maxCallDepth: 256,
      }),
    ).toThrow(CallDepthExceeded);
  });

  it('stops a string bomb with the memory guard', () => {
    expect(() =>
      evaluate("var s = 'x'; for (var i = 0; i < 64; i++) { s = s + s; } return s.length;", {
        maxSteps: 10_000_000,
        maxStringLength: 500_000,
        maxTotalStringLength: 2_000_000,
      }),
    ).toThrow(MemoryLimitExceeded);
  });

  it('stops an array bomb with the memory guard', () => {
    expect(() =>
      evaluate('var a = []; while (true) { a.push(1); } return a.length;', {
        maxSteps: 100_000_000,
        maxArrayLength: 50_000,
      }),
    ).toThrow(MemoryLimitExceeded);
  });

  it('caps wall-clock time even when steps remain', () => {
    expect(() => load('while (true) {}', { maxSteps: 2_000_000_000, timeoutMs: 50 })).toThrow(
      /time budget/,
    );
  });

  it('hands out copies, never live references into the interpreter heap', () => {
    const interpreter = load('var data = [1, 2, 3]; function get() { return data; }');
    const first = interpreter.call('get', []) as unknown[];
    first.push(99);
    (interpreter.read('data') as unknown[]).push(98);
    expect(interpreter.call('get', [])).toEqual([1, 2, 3]);
  });

  it('refuses to accept a host function as an argument', () => {
    const interpreter = load('function apply(f) { return f(); }');
    expect(() => interpreter.call('apply', [() => 'host'])).toThrow(TypeError);
  });

  it('copies object arguments in rather than sharing them', () => {
    const interpreter = load('function keep(o) { o.marked = true; return o.a; }');
    const argument = { a: 1 };
    expect(interpreter.call('keep', [argument])).toBe(1);
    expect(argument).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical results for identical programs', () => {
    const source = `
      var log = [];
      var seed = 0x2f6e2b1;
      for (var i = 0; i < 5; i++) { seed = (seed * 1103515245 + 12345) % 0x80000000; log.push(seed); }
      log.push(new Date(0).getTime());
      function decode(n) { seed = (seed * 1103515245 + 12345) % 0x80000000; return String.fromCharCode(n ^ 0x20) + seed; }
    `;
    const a = load(source);
    const b = load(source);
    expect(a.read('log')).toEqual(b.read('log'));
    expect(a.call('decode', [97])).toEqual(b.call('decode', [97]));
  });

  it('has no source of nondeterminism to seed', () => {
    // `Math.random` used to be a seeded PRNG so that this held; the program's
    // own draw is different on every run, so the only reproducible answer is
    // none. `sort` and the rest stay host-native and deterministic.
    expect(() => load('var r = Math.random();')).toThrow(InterpreterRefusal);
    expect(() => load("var r = 'a'.localeCompare('b');")).toThrow(InterpreterRefusal);
    expect(load("var s = ['b', 'a', 'c'].sort();").read('s')).toEqual(['a', 'b', 'c']);
  });

  it('reports a step count that grows monotonically', () => {
    const interpreter = load('function f(n) { var s = 0; for (var i = 0; i < n; i++) s += i; return s; }');
    const afterLoad = interpreter.steps();
    interpreter.call('f', [100]);
    const afterCall = interpreter.steps();
    expect(afterLoad).toBeGreaterThan(0);
    expect(afterCall).toBeGreaterThan(afterLoad);
  });

  it('gives each entry a fresh budget so one heavy call cannot starve the next', () => {
    const interpreter = load('function spin(n) { var s = 0; for (var i = 0; i < n; i++) s++; return s; }', {
      maxSteps: 100_000,
    });
    for (let i = 0; i < 20; i++) expect(interpreter.call('spin', [1000])).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// A real obfuscator.io-shaped decoder
// ---------------------------------------------------------------------------

const ALPHABET = 'QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm0123456789+/';
const RC4_KEY = 'kM3xPq';
const ROTATION = 5;

/** RC4 over a byte string. Symmetric, so this is also the decoder's inverse. */
function rc4(input: string, key: string): string {
  const s: number[] = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key.charCodeAt(i % key.length)) % 256;
    const swap = s[i]!;
    s[i] = s[j]!;
    s[j] = swap;
  }
  let out = '';
  let i = 0;
  j = 0;
  for (let y = 0; y < input.length; y++) {
    i = (i + 1) % 256;
    j = (j + s[i]!) % 256;
    const swap = s[i]!;
    s[i] = s[j]!;
    s[j] = swap;
    out += String.fromCharCode(input.charCodeAt(y) ^ s[(s[i]! + s[j]!) % 256]!);
  }
  return out;
}

function base64Encode(binary: string, alphabet: string): string {
  let out = '';
  for (let i = 0; i < binary.length; i += 3) {
    const b0 = binary.charCodeAt(i);
    const b1 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(triple >> 18) & 63]! + alphabet[(triple >> 12) & 63]!;
    out += i + 1 < binary.length ? alphabet[(triple >> 6) & 63]! : '=';
    out += i + 2 < binary.length ? alphabet[triple & 63]! : '=';
  }
  return out;
}

interface Fixture {
  source: string;
  plaintexts: string[];
}

/**
 * Build a program in the shape `javascript-obfuscator` emits with
 * `stringArray + stringArrayRotate + stringArrayEncoding: rc4`:
 * a shuffled string array, a self-replacing decoder, and a rotation loop that
 * push/shifts the array until a `parseInt` checksum over six decoded entries
 * matches a baked constant.
 */
function buildFixture(entryCount: number): Fixture {
  const plaintexts: string[] = [];
  // The first six entries are numeric, because the rotation checksum parseInts them.
  for (let i = 0; i < 6; i++) plaintexts.push(String(104729 + i * 7919));
  for (let i = 6; i < entryCount; i++) plaintexts.push(`segment-${i}-payload-${(i * 37) % 1000}`);

  const encoded = plaintexts.map((text) => base64Encode(rc4(text, RC4_KEY), ALPHABET));
  // The literal is rotated right, so ROTATION push/shift cycles restore it.
  const literal = [...encoded.slice(encoded.length - ROTATION), ...encoded.slice(0, encoded.length - ROTATION)];

  const p = plaintexts;
  const checksum =
    -Number.parseInt(p[0]!) / 1 +
    Number.parseInt(p[1]!) / 2 +
    -Number.parseInt(p[2]!) / 3 +
    Number.parseInt(p[3]!) / 4 +
    -Number.parseInt(p[4]!) / 5 +
    Number.parseInt(p[5]!) / 6;

  const source = `
var _0xd4c1 = ${JSON.stringify(literal)};
var _0xalpha = ${JSON.stringify(ALPHABET)};

function _0x4f19(_0xdata) {
  _0xdata = String(_0xdata)['replace'](/=+$/, '');
  var _0xout = '', _0xbuf = 0, _0xbits = 0;
  for (var _0xi = 0; _0xi < _0xdata['length']; _0xi++) {
    var _0xv = _0xalpha['indexOf'](_0xdata['charAt'](_0xi));
    if (_0xv === -1) { continue; }
    _0xbuf = (_0xbuf << 6) | _0xv;
    _0xbits += 6;
    if (_0xbits >= 8) {
      _0xbits -= 8;
      _0xout += String['fromCharCode']((_0xbuf >> _0xbits) & 0xff);
    }
  }
  return _0xout;
}

function _0x2ba8(_0xstr, _0xkey) {
  var _0xs = [], _0xj = 0, _0xx, _0xres = '';
  _0xstr = _0x4f19(_0xstr);
  for (var _0xi = 0; _0xi < 256; _0xi++) { _0xs[_0xi] = _0xi; }
  for (_0xi = 0, _0xj = 0; _0xi < 256; _0xi++) {
    _0xj = (_0xj + _0xs[_0xi] + _0xkey['charCodeAt'](_0xi % _0xkey['length'])) % 256;
    _0xx = _0xs[_0xi]; _0xs[_0xi] = _0xs[_0xj]; _0xs[_0xj] = _0xx;
  }
  _0xi = 0; _0xj = 0;
  for (var _0xy = 0; _0xy < _0xstr['length']; _0xy++) {
    _0xi = (_0xi + 1) % 256;
    _0xj = (_0xj + _0xs[_0xi]) % 256;
    _0xx = _0xs[_0xi]; _0xs[_0xi] = _0xs[_0xj]; _0xs[_0xj] = _0xx;
    _0xres += String['fromCharCode'](_0xstr['charCodeAt'](_0xy) ^ _0xs[(_0xs[_0xi] + _0xs[_0xj]) % 256]);
  }
  return _0xres;
}

function _0x3a71(_0xindex, _0xkey) {
  var _0xarray = _0xd4c1;
  _0x3a71 = function (_0xinner, _0xinnerKey) {
    _0xinner = _0xinner - 0x100;
    var _0xraw = _0xarray[_0xinner];
    if (_0x3a71['cache'] === undefined) { _0x3a71['cache'] = {}; }
    var _0xhit = _0x3a71['cache'][_0xraw];
    if (_0xhit !== undefined) { return _0xhit; }
    var _0xplain = _0x2ba8(_0xraw, _0xinnerKey);
    _0x3a71['cache'][_0xraw] = _0xplain;
    return _0xplain;
  };
  return _0x3a71(_0xindex, _0xkey);
}

(function (_0xarray, _0xtarget) {
  var _0xdecode = _0x3a71;
  while (true) {
    try {
      var _0xsum =
        -parseInt(_0xdecode(0x100, ${JSON.stringify(RC4_KEY)})) / 1 +
        parseInt(_0xdecode(0x101, ${JSON.stringify(RC4_KEY)})) / 2 +
        -parseInt(_0xdecode(0x102, ${JSON.stringify(RC4_KEY)})) / 3 +
        parseInt(_0xdecode(0x103, ${JSON.stringify(RC4_KEY)})) / 4 +
        -parseInt(_0xdecode(0x104, ${JSON.stringify(RC4_KEY)})) / 5 +
        parseInt(_0xdecode(0x105, ${JSON.stringify(RC4_KEY)})) / 6;
      if (_0xsum === _0xtarget) { break; } else { _0xarray['push'](_0xarray['shift']()); }
    } catch (_0xe) {
      _0xarray['push'](_0xarray['shift']());
    }
  }
})(_0xd4c1, ${checksum});
`;

  return { source, plaintexts };
}

describe('obfuscator.io-shaped decoder', () => {
  it('runs the rotation loop and decodes every entry', () => {
    const { source, plaintexts } = buildFixture(64);
    const interpreter = load(source);

    expect(interpreter.isCallable('_0x3a71')).toBe(true);
    for (let i = 0; i < plaintexts.length; i++) {
      expect(interpreter.call('_0x3a71', [0x100 + i, RC4_KEY])).toBe(plaintexts[i]);
    }
  });

  it('leaves the array in the rotated order the decoder expects', () => {
    const { source, plaintexts } = buildFixture(32);
    const interpreter = load(source);
    const array = interpreter.read('_0xd4c1') as string[];
    expect(array).toHaveLength(plaintexts.length);
    // Entry 0 must now decode to the first plaintext, proving the loop rotated.
    expect(interpreter.call('_0x3a71', [0x100, RC4_KEY])).toBe(plaintexts[0]);
  });

  it('decodes identically on a second interpreter built from the same source', () => {
    const { source } = buildFixture(32);
    const first = load(source);
    const second = load(source);
    for (let i = 0; i < 32; i++) {
      expect(first.call('_0x3a71', [0x100 + i, RC4_KEY])).toBe(second.call('_0x3a71', [0x100 + i, RC4_KEY]));
    }
  });
});

// ---------------------------------------------------------------------------
// Function.prototype.toString
// ---------------------------------------------------------------------------

/**
 * `javascript-obfuscator`'s `selfDefending` option welds a guard into the string
 * decoder that matches a regular expression against one of its own inner
 * functions' source text, and diverts into a loop that never terminates when the
 * match fails. A function that stringifies to a placeholder therefore does not
 * merely print oddly: the decoder hangs, no string is decoded, and the guard
 * survives into the output. So `toString` fidelity is a correctness property.
 */
describe('function source text', () => {
  /** The realistic setup: the caller hands over the text it parsed. */
  function loadWithSource(source: string, options: InterpreterOptions = {}): Interpreter {
    return createInterpreter(statementsOf(source), { ...options, source });
  }

  it('reports a function\'s own bytes through every coercion form', () => {
    // The comment and the irregular spacing are the point: only a slice of the
    // original text can reproduce them, a reprint of the AST cannot.
    const declaration = 'function target(a,   b) { return a /* kept */ + b; }';
    const program = [
      declaration,
      'var forms = {',
      "  plus: '' + target,",
      "  plusReversed: target + '',",
      '  ctor: String(target),',
      '  method: target.toString(),',
      '  template: `${target}`,',
      "  joined: [target].join(''),",
      '  concat: String.prototype.concat.call(target),',
      '};',
    ].join('\n');

    const forms = loadWithSource(program).read('forms') as Record<string, unknown>;
    expect(Object.keys(forms)).toHaveLength(7);
    for (const [form, text] of Object.entries(forms)) {
      expect(`${form}: ${String(text)}`).toBe(`${form}: ${declaration}`);
    }
  });

  it('reports the inner function, not the enclosing one, for a nested function', () => {
    const program = [
      'function outer(seed) {',
      '  function inner(x) { return x * 2 + seed; }',
      "  return ['' + inner, ('' + outer).indexOf('function outer') === 0];",
      '}',
      'var out = outer(1);',
    ].join('\n');

    expect(loadWithSource(program).read('out')).toEqual([
      'function inner(x) { return x * 2 + seed; }',
      true,
    ]);
  });

  it('reports arrow functions and object methods verbatim', () => {
    const program = [
      'var arrow = (x) => x + 1;',
      'var terse = x => x;',
      'var obj = { m(a) { return a; } };',
      "var out = [String(arrow), '' + terse, '' + obj.m];",
    ].join('\n');

    expect(loadWithSource(program).read('out')).toEqual([
      '(x) => x + 1',
      'x => x',
      'm(a) { return a; }',
    ]);
  });

  it('keeps the [native code] form for builtins', () => {
    const program = "var out = [String(Math.max), '' + parseInt, [].push.toString()];";
    expect(loadWithSource(program).read('out')).toEqual([
      'function max() { [native code] }',
      'function parseInt() { [native code] }',
      'function push() { [native code] }',
    ]);
  });

  it('preserves newlines, so a self-check can tell compact source from pretty', () => {
    const compact = "var probe=function(){return 0;};var out=(''+probe).indexOf('\\n');";
    const pretty = ['var probe = function () {', '  return 0;', '};', "var out = ('' + probe).indexOf('\\n');"].join(
      '\n',
    );

    expect(loadWithSource(compact).read('out')).toBe(-1);
    expect(loadWithSource(pretty).read('out')).toBeGreaterThan(0);
  });

  it('falls back to regenerated source, with a diagnostic, when no source is supplied', () => {
    const interpreter = load("function f(a) { return a + 1; }\nvar out = '' + f;");
    const text = interpreter.read('out') as string;

    // Regenerated rather than sliced, so only the token sequence is guaranteed.
    expect(text.replace(/\s+/g, '')).toBe('functionf(a){returna+1;}');
    expect(interpreter.diagnostics()).toHaveLength(1);
    expect(interpreter.diagnostics()[0]).toMatch(/No original source was supplied/);
  });

  it('falls back, with a diagnostic, when the node has no offsets into the source', () => {
    const source = "function f(a) { return a + 1; }\nvar out = '' + f;";
    // What the slicer hands over today: `t.cloneNode` drops `start`/`end`.
    const statements = statementsOf(source).map((statement) => cloneNode(statement, true, true));
    const interpreter = createInterpreter(statements, { source });

    expect((interpreter.read('out') as string).replace(/\s+/g, '')).toBe('functionf(a){returna+1;}');
    expect(interpreter.diagnostics()).toHaveLength(1);
    expect(interpreter.diagnostics()[0]).toMatch(/offsets .* are missing or do not match/);
  });

  it('files no diagnostic when every function answered from the original bytes', () => {
    const interpreter = loadWithSource("function f() { return 1; }\nvar out = '' + f;");
    expect(interpreter.diagnostics()).toEqual([]);
  });

  it('bounds the source text it will hand out, and says when it stopped', () => {
    // Nested functions each carry their children's text, so the total is not
    // bounded by the program's own size. `maxStringLength` bounds it here.
    const program = [
      'function a() { function b() { function c() { return 1; } return c; } return b; }',
      'var out = [a.toString(), a().toString(), a()().toString()];',
    ].join('\n');

    const interpreter = loadWithSource(program, { maxStringLength: 40 });
    const [outer, middle, inner] = interpreter.read('out') as string[];

    // The first answer is exact; the budget is gone by the second.
    expect(outer).toBe('function a() { function b() { function c() { return 1; } return c; } return b; }');
    expect(middle).toBe('function b() { [native code] }');
    expect(inner).toBe('function c() { [native code] }');
    expect(interpreter.diagnostics().join(' ')).toMatch(/Exhausted the budget for function source text/);
  });

  it('decodes a selfDefending decoder that pattern-matches its own source', () => {
    // The obfuscator's own shape, compacted the way it emits it: a probe
    // function, the regex it must satisfy, and a loop that never ends when it
    // does not. `_0xguard` is reached only if `toString` lies.
    const decoder = [
      'function _0xdec(_0xi) {',
      "var _0xtable = ['alpha', 'beta', 'gamma'];",
      "var _0xprobe=function(){return'newState';};",
      "var _0xre = new RegExp('\\\\w+ *\\\\(\\\\) *{\\\\w+ *' + '[\\x27|\"].+[\\x27|\"];? *}');",
      "if (!_0xre['test'](_0xprobe['toString']())) {",
      '  for (var _0xa = 0, _0xb = 1; _0xa < _0xb; _0xa++) { _0xb = _0xb + 1; }',
      '}',
      'return _0xtable[_0xi];',
      '}',
    ].join('\n');

    const interpreter = loadWithSource(decoder, { maxSteps: 200_000 });
    expect(interpreter.call('_0xdec', [0])).toBe('alpha');
    expect(interpreter.call('_0xdec', [1])).toBe('beta');
    expect(interpreter.call('_0xdec', [2])).toBe('gamma');

    // And the guard is real: swap the probe for a builtin, whose faithful
    // stringification is `[native code]`, and the same decoder never returns.
    const trapped = decoder.replace("var _0xprobe=function(){return'newState';};", 'var _0xprobe = Math.max;');
    const trap = loadWithSource(trapped, { maxSteps: 200_000 });
    expect(() => trap.call('_0xdec', [0])).toThrow(StepLimitExceeded);
  });
});

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

describe('throughput', () => {
  it('runs a 2000-entry array, its rotation loop and 5000 decode calls', () => {
    const ENTRIES = 2000;
    const CALLS = 5000;
    const { source, plaintexts } = buildFixture(ENTRIES);

    const loadStart = performance.now();
    const interpreter = load(source, { maxSteps: 200_000_000, timeoutMs: 120_000 });
    const loadMs = performance.now() - loadStart;
    const loadSteps = interpreter.steps();

    const callStart = performance.now();
    let checksum = 0;
    for (let i = 0; i < CALLS; i++) {
      const value = interpreter.call('_0x3a71', [0x100 + (i % ENTRIES), RC4_KEY]) as string;
      checksum += value.length;
    }
    const callMs = performance.now() - callStart;
    const callSteps = interpreter.steps() - loadSteps;

    expect(interpreter.call('_0x3a71', [0x100 + ENTRIES - 1, RC4_KEY])).toBe(plaintexts[ENTRIES - 1]);
    expect(checksum).toBeGreaterThan(0);

    // A tight arithmetic loop isolates raw interpreter overhead from the time
    // spent inside native builtins, which the decode path is dominated by.
    const rawStart = performance.now();
    const raw = load('var s = 0; for (var i = 0; i < 500000; i++) { s = (s + i) ^ 3; }', {
      maxSteps: 200_000_000,
      timeoutMs: 120_000,
    });
    const rawMs = performance.now() - rawStart;
    const rawSteps = raw.steps();

    const totalSteps = interpreter.steps();
    const totalMs = loadMs + callMs;
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `  interpreter throughput (${ENTRIES} entries, ${CALLS} decode calls)`,
        `    array + rotation loop : ${loadMs.toFixed(1)} ms, ${loadSteps.toLocaleString()} steps`,
        `    ${CALLS} decode calls  : ${callMs.toFixed(1)} ms, ${callSteps.toLocaleString()} steps ` +
          `(${((callMs * 1000) / CALLS).toFixed(1)} us/call)`,
        `    total                 : ${totalMs.toFixed(1)} ms, ${totalSteps.toLocaleString()} steps`,
        `    throughput            : ${Math.round(totalSteps / (totalMs / 1000)).toLocaleString()} steps/second`,
        `    raw loop throughput   : ${Math.round(rawSteps / (rawMs / 1000)).toLocaleString()} steps/second ` +
          `(${rawSteps.toLocaleString()} steps in ${rawMs.toFixed(1)} ms)`,
        '',
      ].join('\n'),
    );

    expect(totalSteps).toBeGreaterThan(1_000_000);
  });
});
