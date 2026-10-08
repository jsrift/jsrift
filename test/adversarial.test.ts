import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { printAst } from '../src/frontend/print.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, Language } from '../src/types.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Adversarial suite.
 *
 * Every assertion in the first half of this file is *behavioural*: the input is
 * executed, the output is executed, and the two observable traces are compared.
 * That is deliberate. A deobfuscator's dangerous failure is not a crash - it is
 * output that reads perfectly and computes something else, and no structural
 * assertion can tell that apart from a correct simplification. Only running
 * both programs can.
 *
 * The cases are grouped by the mechanism they attack rather than by the pass
 * they hit, because the interesting bugs live where two passes meet.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`;
  if (value instanceof RegExp) return value.toString();
  if (typeof value === 'function') return `fn:${(value as { name?: string }).name ?? ''}`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

/** Execute in a fresh realm and capture everything the program makes observable. */
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  const sandbox: Record<string, unknown> = {
    log,
    console: { log, warn: log, error: log, info: log, debug: log, trace: log },
  };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    // The *kind* of failure is part of the observable behaviour: swallowing a
    // ReferenceError is exactly the bug several of these cases look for.
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

async function deob(source: string, options: DeobfuscateOptions = {}): Promise<string> {
  const { code } = await deobfuscate(source, {
    preset: 'aggressive',
    ...options,
    performance: { verifyOutput: true, ...options.performance },
  });
  return code;
}

/** The core assertion: output must be observationally equivalent to input. */
async function expectSameBehaviour(
  source: string,
  options: DeobfuscateOptions = {},
): Promise<string> {
  const before = execute(source);
  const output = await deob(source, options);
  const after = execute(output);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input trace ---\n${before}\n--- output trace ---\n${after}\n--- output code ---\n${output}`,
    );
  }
  return output;
}

function cases(group: string, list: ReadonlyArray<readonly [string, string]>): void {
  describe(group, () => {
    for (const [name, source] of list) {
      it(name, async () => {
        await expectSameBehaviour(source);
      });
    }
  });
}

// ===========================================================================
// Regressions for defects this suite found
//
// The comment above each group names the pass whose guard it pins.
// ===========================================================================

describe('adversarial: fixed defects', () => {
  // simplify/proxy-functions.ts, strings/inline.ts, simplify/object-maps.ts:
  // replacing a discarded call with a string literal turns it into a directive.
  it('proxy inlining does not turn a discarded call into "use strict"', async () => {
    await expectSameBehaviour(
      `function _0xw(a) { return a; }
       function g() { _0xw('use strict'); leaked = 1; return typeof leaked; }
       log(g());`,
    );
  });

  it('string inlining does not turn a discarded decoder call into "use strict"', async () => {
    await expectSameBehaviour(
      `var _0xarr = ['use strict', 'other'];
       function _0xd(i) { return _0xarr[i]; }
       function g() { _0xd(0); leaked = 1; return typeof leaked; }
       log(g());`,
    );
  });

  it('object-map inlining does not turn a discarded read into "use strict"', async () => {
    await expectSameBehaviour(
      `var _0xm = { 'aKey': 'use strict' };
       function g() { _0xm['aKey']; leaked = 1; return typeof leaked; }
       log(g());`,
    );
  });

  it('still inlines an ordinary string into an expression statement', async () => {
    // The guard is on the value, not the position: narrowing it to "any string"
    // stopped the lightly-obfuscated fixture inlining one of its 10 197 reads.
    const code = await deob(
      `var _0xarr = ['alpha', 'beta', 'gamma'];
       function _0xd(i) { return _0xarr[i]; }
       function g() { _0xd(0); return _0xd(1); }
       log(g());`,
    );
    expect(code).not.toContain('_0xarr');
  });

  // strings/discover.ts: a wrapper's backing table that is not checked for
  // mutation makes every literal decoded through it a guess.
  it('refuses to decode through a wrapper whose table is written to', async () => {
    await expectSameBehaviour(
      `var _0xarr = ['a', 'b'];
       function _0xd(i) { return _0xarr[i]; }
       _0xarr[0] = 'z';
       log(_0xd(0), _0xarr[1]);`,
    );
  });

  it('refuses a table handed to a function that could mutate it', async () => {
    await expectSameBehaviour(
      `var _0xa = ['m', 'n'];
       function _0xd(i) { return _0xa[i]; }
       function mutate(arr) { arr[0] = 'X'; }
       mutate(_0xa);
       log(_0xd(0), _0xd(1));`,
    );
  });

  it('refuses a table that is sorted before it is read', async () => {
    await expectSameBehaviour(
      `var _0xa = ['b', 'a'];
       function _0xd(i) { return _0xa[i]; }
       _0xa.sort();
       log(_0xd(0), _0xd(1));`,
    );
  });

  it('still decodes through a rotated table, whose mutation is its own machinery', async () => {
    const code = await deob(
      `var _0xarr = ['alpha', 'beta', 'gamma', 'delta'];
       (function (a, b) { var c = function (d) { while (--d) { a['push'](a['shift']()); } }; c(++b); })(_0xarr, 0x2);
       function _0xd(i) { return _0xarr[i]; }
       log(_0xd(0x0), _0xd(0x1));`,
    );
    expect(code).not.toContain('_0xarr');
    expect(code).toContain('gamma');
  });

  // strings/prune-decoders.ts: a reference survey that knows only the *decoder*
  // names cannot see a surviving read of the backing table, and deletes the
  // declaration that read needs out from under it.
  it('never deletes machinery a live reference still needs', async () => {
    const code = await deob(
      `var _0xa = ['p', 'q', 'r'];
       function _0xd(i) { return _0xa[i]; }
       log(_0xd(0), _0xa.length);`,
    );
    expect(execute(code)).toBe(execute('log("p", 3);'));
  });

  // clean/unused.ts and simplify/proxy-functions.ts: "the name is bound" is not
  // "the name can be read" - inside a TDZ the second is false.
  it('keeps a dead binding whose initialiser throws on a TDZ read', async () => {
    await expectSameBehaviour(
      `function f() { try { var a = b; } catch (e) { return e.name; } let b = 1; return 'ok'; }
       log(f());`,
    );
  });

  it('does not drop an unused proxy argument that is a TDZ read', async () => {
    await expectSameBehaviour(
      `function w(a, b) { return b; }
       function f() { try { return w(v, 1); } catch (e) { return e.name; } let v = 2; }
       log(f());`,
    );
  });

  it('does not drop a surplus proxy argument that is a TDZ read', async () => {
    await expectSameBehaviour(
      `function w(a) { return a; }
       function f() { try { return w(1, v); } catch (e) { return e.name; } let v = 2; }
       log(f());`,
    );
  });

  it('does not reorder proxy arguments across a TDZ read', async () => {
    await expectSameBehaviour(
      `function w(a, b) { return b - a; }
       function f() { try { return w(v, 1); } catch (e) { return e.name; } let v = 2; }
       log(f());`,
    );
  });

  it('does not drop an object-map wrapper argument that is a TDZ read', async () => {
    await expectSameBehaviour(
      `var _0xm = { 'kk': function (a, b) { return b; } };
       function f() { try { return _0xm['kk'](v, 1); } catch (e) { return e.name; } let v = 2; }
       log(f());`,
    );
  });

  it('keeps a dead binding whose initialiser reads a class before its declaration', async () => {
    await expectSameBehaviour(
      `function f() { try { var a = K; } catch (e) { return e.name; } class K {} return 'ok'; }
       log(f());`,
    );
  });

  // rename/identifiers.ts: identifiers in TypeScript type positions are not in
  // Babel's reference list, so renaming a class leaves its annotations dangling.
  it('rewrites a renamed class in a parameter type annotation', async () => {
    const code = await deob('class Box { v = 1; }\nexport function take(b: Box): number { return b.v; }\n', {
      language: 'ts',
    });
    expect(code).not.toMatch(/:\s*Box\b/);
    const declared = /class (\w+)/.exec(code)?.[1];
    expect(declared).toBeDefined();
    expect(code).toContain(`b: ${declared}`);
  });

  it('rewrites a renamed class inside type arguments', async () => {
    const code = await deob(
      'class Store<T> { items: T[] = []; }\nexport function use(s: Store<number>) { return s.items; }\n' +
        'export const made = new Store();\n',
      { language: 'ts' },
    );
    const declared = /class (\w+)/.exec(code)?.[1];
    expect(code).toContain(`s: ${declared}<number>`);
    expect(code).not.toMatch(/\bStore\b/);
  });

  it('rewrites a renamed class in an implements clause and a type alias', async () => {
    const code = await deob(
      'interface Shape { n: number }\nclass Circle implements Shape { n = 1; }\n' +
        'type C = Circle;\nexport function f(x: C): Shape { return x; }\nexport const made = new Circle();\n',
      { language: 'ts' },
    );
    expect(code).not.toMatch(/\bCircle\b/);
    expect(code).toContain('interface Shape');
  });

  it('leaves an unrelated same-named type alone', async () => {
    const code = await deob(
      'declare const external: unknown;\nfunction outer() { class Box { v = 1; } return new Box(); }\n' +
        'export function take(b: Box): unknown { return b; }\n',
      { language: 'ts' },
    );
    // The annotation names a global `Box`, not the function-local class.
    expect(code).toContain('b: Box');
  });
});

// ===========================================================================
// Getters, setters and Proxy - a read that does work
// ===========================================================================

cases('adversarial: side-effecting property reads', [
  [
    'getter read order is preserved through property normalisation',
    `var o = { get a() { log('read a'); return 1; }, get b() { log('read b'); return 2; } };
     log(o['a'] + o['b']);`,
  ],
  [
    'a getter is not duplicated by a proxy that reads its parameter twice',
    `var hits = 0;
     var o = { get v() { hits++; return 3; } };
     function w(a) { return a + a; }
     log(w(o.v)); log(hits);`,
  ],
  [
    'a getter is not dropped by a proxy that ignores its parameter',
    `var hits = 0;
     var o = { get v() { hits++; return 3; } };
     function w(a, b) { return b; }
     log(w(o.v, 7)); log(hits);`,
  ],
  [
    'a Proxy get trap sees the same keys in the same order',
    `var seen = [];
     var p = new Proxy({}, { get(t, k) { seen.push(String(k)); return 1; } });
     log(p['x'] + p['y']); log(seen.join(','));`,
  ],
  [
    'a getter inherited from the prototype chain still runs',
    `var base = { get z() { log('proto'); return 'B'; } };
     var o = Object.create(base);
     log(o['z']);`,
  ],
  [
    'a getter installed on an array index is not folded away',
    `var calls = 0; var a = [];
     Object.defineProperty(a, 0, { get: function () { calls++; return 'g'; } });
     log(a[0], a[0], calls);`,
  ],
  [
    'a getter in an if test is not evaluated twice or never',
    `var hits = 0;
     var o = { get flag() { hits++; return true; } };
     if (o.flag) { log('t'); } else { log('f'); }
     log(hits);`,
  ],
  [
    'accessor pairs survive computed-key normalisation',
    `var backing = 0;
     var o = { get v() { return backing; }, set v(x) { backing = x * 2; } };
     o['v'] = 5; log(o.v);`,
  ],
  [
    'a getter defined with a computed key keeps its key',
    `var o = { get ['x']() { return 1; } }; log(o.x);`,
  ],
  [
    'wrapper arguments that are getters keep their evaluation order',
    `var t = [];
     var _0xm = { 'kAdd': function (a, b) { return a + b; } };
     var o = { get p() { t.push('p'); return 1; }, get q() { t.push('q'); return 2; } };
     log(_0xm['kAdd'](o.p, o.q)); log(t.join(','));`,
  ],
]);

// ===========================================================================
// `this` binding
// ===========================================================================

cases('adversarial: this binding', [
  ['an IIFE inside a method still has its own this', `var o = { m: function () { return (function () { return typeof this; })(); } };
     log(o.m());`],
  [
    'a method passed as a value is not given a receiver by inlining',
    `var o = { v: 5, m: function () { return this.v; } };
     function call(f) { return f(); }
     try { log(call(o.m)); } catch (e) { log('E ' + e.name); }`,
  ],
  [
    'a quoted method key keeps its receiver when normalised',
    `var o = { 'go': function () { return this === o; } };
     log(o['go']());`,
  ],
  [
    'new through a wrapper keeps the constructed receiver',
    `function C(v) { this.v = v; }
     function mk(f, x) { return new f(x); }
     log(mk(C, 3).v);`,
  ],
  ['super calls survive', `class A { m() { return 'A'; } }
     class B extends A { m() { return super.m() + 'B'; } }
     log(new B().m());`],
]);

// ===========================================================================
// Hoisting: what a deleted region still contributed
// ===========================================================================

cases('adversarial: hoisting', [
  ['a var inside a never-taken branch is still declared', `function f() { if (false) { var x = 1; } return typeof x; }
     log(f());`],
  [
    'a function declared in a never-taken branch is still a name',
    `function f() { if (0) { function g() { return 1; } } return typeof g; }
     log(f());`,
  ],
  ['a var after a return is still hoisted', `function f() { return typeof x; var x = 1; }
     log(f());`],
  [
    'a var only assigned outside its dead declaration still works',
    `var out = (function () { if (false) { var q = 9; } q = 3; return q; })();
     log(out);`,
  ],
  [
    'an injected constant guard keeps the hoisting of what it deletes',
    `function f() { if ('a' === 'b') { var q = 1; function h() {} } return typeof q + ':' + typeof h; }
     log(f());`,
  ],
  [
    'a dispatcher case declaring a var keeps it in the function scope',
    `function f() {
       var _0x1 = '1|0'['split']('|'), _0x2 = 0;
       while (true) {
         switch (_0x1[_0x2++]) {
           case '0': var a = 1; continue;
           case '1': var b = 2; continue;
         }
         break;
       }
       return (typeof a) + ':' + (typeof b);
     }
     log(f());`,
  ],
  ['a labelled block containing a var', `function f() { L: { var x = 1; break L; } return x; } log(f());`],
]);

// ===========================================================================
// TDZ, closures, labels, switch
// ===========================================================================

cases('adversarial: TDZ, closures and jumps', [
  ['a let read before its declaration throws', `function f() { try { return v; } catch (e) { return e.name; } let v = 1; }
     log(f());`],
  [
    'a const in a folded ternary is not resolved early',
    `function f() { try { return c ? 'a' : 'b'; } catch (e) { return e.name; } const c = 1; }
     log(f());`,
  ],
  [
    'a var read before its own initialiser is undefined, not the later value',
    `function f() { if (x) { return 'yes'; } var x = 1; return 'no'; }
     log(f());`,
  ],
  ['let in a loop gives each closure its own binding', `var fs = []; for (let i = 0; i < 3; i++) fs.push(function () { return i; });
     log(fs.map(function (f) { return f(); }).join(','));`],
  ['var in a loop gives every closure the same binding', `var fs = []; for (var i = 0; i < 3; i++) fs.push(function () { return i; });
     log(fs.map(function (f) { return f(); }).join(','));`],
  [
    'labelled continue skips to the right loop',
    `var s = '';
     outer: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { if (j === 1) continue outer; s += '' + i + j; } }
     log(s);`,
  ],
  ['labelled break out of a block', `var s = ''; blk: { s += 'a'; if (true) break blk; s += 'b'; } log(s);`],
  ['a labelled do-while(false) is not unwrapped', `var t = []; L: do { t.push('a'); break L; } while (false); log(t.join(','));`],
  ['a do-while(false) containing a break keeps its loop', `var t = [];
     do { t.push('a'); if (t.length) break; t.push('b'); } while (false);
     log(t.join(','));`],
  [
    'switch fallthrough is preserved',
    `function f(n) { var s = ''; switch (n) { case 1: s += '1'; case 2: s += '2'; break; case 3: s += '3'; default: s += 'd'; } return s; }
     log(f(1) + '|' + f(2) + '|' + f(3) + '|' + f(9));`,
  ],
  ['try/finally runs the finaliser before a break', `function f() { for (var i = 0; i < 3; i++) { try { if (i === 1) break; } finally { log('f' + i); } } return i; }
     log(f());`],
  ['try/finally does not swallow the returned value', `function f() { try { return 1; } finally { log('fin'); } } log(f());`],
]);

// ===========================================================================
// Evaluation order - where "obviously equivalent" usually is not
// ===========================================================================

cases('adversarial: evaluation order', [
  [
    'a comma sequence in a switch discriminant is not hoisted',
    `var order = [];
     function a() { order.push('a'); return 1; }
     function b() { order.push('b'); return 2; }
     switch (a(), b()) { case 2: order.push('hit'); break; default: order.push('miss'); }
     log(order.join(','));`,
  ],
  [
    'a comma sequence in a for update runs once per iteration',
    `var t = [];
     for (var i = 0; i < 2; (t.push('u'), i++)) { t.push('b'); }
     log(t.join(','));`,
  ],
  [
    'a comma sequence behind a short circuit never runs',
    `var t = [];
     function s(x) { t.push(x); return true; }
     false && (s('a'), s('b'));
     log(t.join(',') || 'none');`,
  ],
  [
    'a comma sequence in an else-if test is not hoisted above the chain',
    `var t = [];
     function s(x) { t.push(x); return x; }
     if (0) { t.push('a'); } else if (s(1), s(0)) { t.push('b'); } else { t.push('c'); }
     log(t.join(','));`,
  ],
  ['a comma sequence in an arrow body keeps its order', `var t = []; var f = () => (t.push('a'), t.push('b'), 7); log(f(), t.join(','));`],
  [
    'argument order survives proxy inlining',
    `var t = [];
     function p(x) { t.push(x); return x; }
     function w(a, b) { return a - b; }
     log(w(p(5), p(2))); log(t.join(','));`,
  ],
  [
    'a proxy that reads its parameters out of order refuses impure arguments',
    `var t = [];
     function p(x) { t.push(x); return x; }
     function w(a, b) { return b - a; }
     log(w(p(5), p(2))); log(t.join(','));`,
  ],
  [
    'a lazy proxy body does not make an eager argument conditional',
    `var t = [];
     function p(x) { t.push(x); return x; }
     function w(a, b) { return a || b; }
     log(w(p(1), p(2))); log(t.join(','));`,
  ],
  [
    'an object-map wrapper with a short circuit keeps both arguments eager',
    `var t = [];
     function s(x) { t.push(x); return x; }
     var _0xm = { 'kOr': function (a, b) { return a || b; } };
     log(_0xm['kOr'](s(1), s(2))); log(t.join(','));`,
  ],
  [
    'a surplus argument is still evaluated',
    `var t = [];
     function s(x) { t.push(x); return x; }
     function w(a) { return a; }
     log(w(1, s('extra'))); log(t.join(','));`,
  ],
  [
    'a nested if collapse does not make the inner test unconditional',
    `var t = [];
     function s(x) { t.push(x); return x; }
     if (s(0)) { if (s(1)) { t.push('in'); } }
     log(t.join(','));`,
  ],
  [
    'lifting work out of a for update bails when a continue can skip it',
    `var t = [];
     function s(x) { t.push(x); return x; }
     for (var i = 0; i < 3; s('u'), i++) { if (i === 1) continue; t.push('b' + i); }
     log(t.join(','));`,
  ],
  [
    'an exception in an earlier argument prevents the later one',
    `function w(a, b) { return b + a; }
     var t = [];
     function s(x) { t.push(x); return x; }
     try { log(w(null.x, s(2))); } catch (e) { log('E ' + e.constructor.name); }
     log(t.join(',') || 'none');`,
  ],
  ['comma in a for init', `var t = []; for (var i = 0, j = 5; i < j; i++, j--) t.push(i + ':' + j); log(t.join(','));`],
]);

// ===========================================================================
// Precedence when an inlined body is spliced into a tighter context
// ===========================================================================

cases('adversarial: precedence', [
  ['an inlined sum keeps its parentheses under multiplication', `function add(a, b) { return a + b; }
     log(2 * add(3, 4));`],
  ['an inlined ternary keeps its parentheses under addition', `function pick(a, b, c) { return a ? b : c; }
     log(pick(1, 2, 3) + 10);`],
  ['an inlined unary minus does not become a subtraction', `function neg(a) { return -a; }
     log(typeof neg(1), 3 - neg(1));`],
  ['a numeric literal receiver keeps its parentheses', `log((0x10).toString(2)); log((1).toFixed(2));`],
  ['exponentiation stays right-associative', `log(2 ** 3 ** 2, (-2) ** 2);`],
  ['shift and additive precedence is not reassociated', `log(1 + 2 << 3, 1 << 2 + 3);`],
]);

// ===========================================================================
// Strings through decode and re-emit
// ===========================================================================

cases('adversarial: string edge cases', [
  [
    'backslashes, quotes, separators, NUL and surrogates round-trip',
    `var s = ['\\\\', '\\'', '"', '\\r', '\\n', '\\u2028', '\\u2029', '\\0', '\\uD83D\\uDE00', '\\uD800'];
     log(s.map(function (x) { return x.charCodeAt(0); }).join(','));
     log(JSON.stringify(s));`,
  ],
  [
    'a string table full of hostile characters decodes byte for byte',
    `var _0xa = ['\\x6c\\x69\\x6e\\x65\\u2028sep', 'nul\\0end', 'q\\u0027q', 'back\\\\slash'];
     function _0xd(i) { return _0xa[i]; }
     log(_0xd(0).length, _0xd(1).length, _0xd(2), _0xd(3));`,
  ],
  [
    'a lone surrogate survives a table decode',
    `var _0xarr = ['\\uD800x', 'ok\\uDFFF'];
     function _0xd(i) { return _0xarr[i]; }
     log(_0xd(0).charCodeAt(0), _0xd(1).charCodeAt(2));`,
  ],
  [
    'a table entry named __proto__ does not become a prototype write',
    `var _0xarr = ['__proto__', 'constructor'];
     function _0xd(i) { return _0xarr[i]; }
     var o = {}; o[_0xd(0)] = null;
     log(Object.getPrototypeOf(o) === null || Object.getPrototypeOf(o) === Object.prototype);`,
  ],
  ['a real directive is not disturbed', `function f() { var a = 'use'; return a; }
     log(f());
     (function () { 'not strict'; x = 1; log(typeof x); })();`],
  ['nested template literals', `var x = 1; log(\`a\${\`b\${x}\`}c\`);`],
  [
    'a tagged template keeps its raw strings and its site identity',
    `var seen = []; function tag(s, ...v) { seen.push(s === tag.last); tag.last = s; return s[0] + v.join(''); }
     function run() { return tag\`x\${1}y\`; }
     log(run(), run(), seen.join(','));`,
  ],
  ['a raw tagged template is not cooked', `function tag(s) { return s.raw[0]; } log(tag\`a\\nb\`);`],
]);

it('never emits a lone surrogate or a raw line separator into the output text', async () => {
  const code = await deob(
    `var _0xa = ['\\uD800x', 'y\\uDFFF', 'a\\u2028b', 'c\\u2029d', 'e\\0f'];
     function _0xd(i) { return _0xa[i]; }
     log(_0xd(0), _0xd(1), _0xd(2), _0xd(3), _0xd(4));`,
  );
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    const high = c >= 0xd800 && c <= 0xdbff;
    const low = c >= 0xdc00 && c <= 0xdfff;
    if (high) expect(code.charCodeAt(i + 1) >= 0xdc00 && code.charCodeAt(i + 1) <= 0xdfff).toBe(true);
    if (low) expect(code.charCodeAt(i - 1) >= 0xd800 && code.charCodeAt(i - 1) <= 0xdbff).toBe(true);
    expect(c === 0x2028 || c === 0x2029 || c === 0).toBe(false);
  }
  // Written to disk and read back, the file must still be the same program.
  expect(Buffer.from(code, 'utf8').toString('utf8')).toBe(code);
});

// ===========================================================================
// Numbers
// ===========================================================================

cases('adversarial: numeric edge cases', [
  ['negative zero is never printed as zero', `log(1 / (0 * -1), 1 / (-1 * 0), 1 / (0 / -1)); log(Object.is(-0, 0 * -1));`],
  ['NaN and the infinities keep their identity', `log(0 / 0, 1 / 0, -1 / 0, typeof (0 / 0)); log(1e308 * 10);`],
  ['BigInt arithmetic is not folded into a Number', `log((2n ** 64n).toString()); log(typeof (1n + 2n));`],
  ['bitwise operators keep 32-bit wrapping', `log(0xffffffff | 0, 2147483648 | 0, 1 << 31, 1 << 32, 5 >>> -1);`],
  ['the 2^53 boundary is not folded through a lossy intermediate', `log(9007199254740993 - 1, 2 ** 53 + 1, (2 ** 53) * 2, 0.1 + 0.2);`],
  ['parseInt and Number keep their exact coercions', `log(parseInt('08'), parseInt('0x10'), parseInt('10', 0), Number(''), Number(null));`],
  ['length-driven string methods are bounded but exact', `log('ab'.repeat(3).length, 'x'.padStart(5, '-'));`],
]);

// ===========================================================================
// Regexes
// ===========================================================================

cases('adversarial: regexes', [
  ['a regex literal with slashes and a class survives', `var r = /a\\/b[/]/g; log(r.source, r.flags, r.test('a/b/'));`],
  ['division is not mistaken for a regex', `var a = 10, b = 2, g = 1; log(a / b / g);`],
  ['a regex passed through a wrapper is not copied', `function m(s, r) { return s.match(r); }
     log(String(m('abc', /b/)));`],
  ['a stateful regex keeps one lastIndex', `var r = /a/g; log(r.lastIndex); r.test('aa'); log(r.lastIndex);`],
]);

// ===========================================================================
// arguments, eval, with, delete
// ===========================================================================

cases('adversarial: reflective constructs', [
  ['arguments aliases the parameter in sloppy mode', `function f(a) { a = 9; return arguments[0]; } log(f(1));`],
  ['arguments.length is not changed by inlining', `function w(a) { return arguments.length; } log(w(1, 2, 3));`],
  ['delete through a wrapper still deletes the property', `var o = { x: 1 }; function d(t) { return delete t.x; } log(d(o), 'x' in o);`],
  ['with changes what a bare name means', `var o = { a: 1 }; var a = 2; with (o) { log(a); } log(a);`],
  ['with plus a normalised member read', `var o = { a: 1, b: 2 }; var a = 9;
     with (o) { log(a, o['b']); }`],
  ['direct eval can still see the local it names', `var secretName = 41; log(eval('secretName + 1'));`],
  ['a function reached only from an eval string is kept', `function handler() { return 'H'; } log(eval('handler()'));`],
  ['a local reached only from an eval string is not renamed away', `function f() { var _0xsecret = 7; return eval('_0xsecret'); }
     log(f());`],
  ['in and instanceof are not folded away', `log('a' in { a: 1 }, [] instanceof Array);`],
  ['the exception class is preserved', `try { null.x; } catch (e) { log(e instanceof TypeError); }`],
]);

// ===========================================================================
// Renaming
// ===========================================================================

cases('adversarial: renaming', [
  ['shadowing is preserved', `var _0x1 = 1; function f(_0x1) { return _0x1; } log(f(2), _0x1);`],
  ['an inner function still closes over the outer parameter', `function _0x1(_0x2) {
       function _0x3() { return _0x2; }
       var _0x2b = 2;
       return _0x3() + _0x2b;
     }
     log(_0x1(1));`],
  ['a catch parameter keeps its value', `try { null.x; } catch (_0xe) { log(typeof _0xe, _0xe instanceof TypeError); }`],
  ['a recursive call still reaches its own function', `function _0xfact(_0xn) { return _0xn <= 1 ? 1 : _0xn * _0xfact(_0xn - 1); }
     log(_0xfact(5));`],
  ['a function published on the global object stays callable by that name', `function _0x11(_0x22) { return _0x22 * 2; }
     globalThis.entry = _0x11;
     log(globalThis.entry(21));`],
  ['labels are not confused with bindings', `var s = ''; _0xouter: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { if (j) continue _0xouter; s += i; } } log(s);`],
  ['a function name observed through .name is still a name', `function _0xabcd() { return 1; }
     log(_0xabcd.name.length > 0, _0xabcd.length);`],
]);

describe('adversarial: renaming under JSX and TypeScript', () => {
  it('never lowercases a component that is written as a JSX tag', async () => {
    const code = await deob(
      'const MyThing = (p) => null;\nexport const el = <MyThing a="1"><span>t</span></MyThing>;\n',
      { language: 'jsx' },
    );
    const tag = /<(\w+)\s/.exec(code)?.[1];
    expect(tag).toBeDefined();
    expect(/^[A-Z]/.test(tag!)).toBe(true);
  });

  it('never emits a lowercase tag for a renamed component', async () => {
    const code = await deob(
      'import { jsx as _jsx } from "react/jsx-runtime";\n' +
        'function App(props) { const Inner = props.c; return _jsx(Inner, { children: _jsx("div", { children: "t" }) }); }\n' +
        'export default App;\n',
      { language: 'jsx' },
    );
    for (const [, tag] of code.matchAll(/<([A-Za-z_$][\w$.]*)[\s/>]/g)) {
      // A lowercase tag is a host element; a component that becomes one is a
      // different program. Known host tags are the only lowercase names allowed.
      if (!/^[A-Z]/.test(tag!) && !tag!.includes('.')) {
        expect(['div', 'span', 'p', 'ul', 'li', 'br', 'input', 'img']).toContain(tag);
      }
    }
  });

  it('keeps every signature of a TypeScript overload set', async () => {
    const code = await deob(
      'export function pick(a: string): string;\nexport function pick(a: number): number;\n' +
        'export function pick(a: any): any { return a; }\n',
      { language: 'ts' },
    );
    expect(code.match(/function pick/g)?.length).toBe(3);
  });

  it('keeps an interface referenced only by a type annotation', async () => {
    const code = await deob('interface Shape { n: number }\nexport const f = (s: Shape): number => s.n;\n', {
      language: 'ts',
    });
    expect(code).toContain('interface Shape');
  });

  it('keeps an enum used only through its members', async () => {
    const code = await deob('enum E { A = 1, B = 2 }\nexport const v = E.B;\n', { language: 'ts' });
    expect(code).toContain('enum E');
  });

  it('preserves module bindings and re-exports', async () => {
    const code = await deob(
      'import { a as _0xa } from "./m.js";\nconst _0xb = _0xa + 1;\nexport { _0xb as b };\nexport default _0xb;\n',
      { language: 'ts' },
    );
    expect(code).toContain('export default');
    expect(code).toMatch(/as b\b/);
    expect(code).toContain('from "./m.js"');
  });

  it('does not put an unescapable value into a raw JSX attribute', async () => {
    // JSX attribute text is not escape-processed: `alt="a\tb"` means
    // backslash-t-b, so a value containing one must use an expression container.
    const code = await deob(
      'import { jsx as _jsx } from "react/jsx-runtime";\n' +
        'export const el = _jsx("img", { alt: "a\\\\b\\tc", title: "q\\"q" });\n',
      { language: 'jsx' },
    );
    for (const [, , value] of code.matchAll(/(alt|title)=("[^"]*"|\{[^}]*\})/g)) {
      expect(value!.startsWith('{'), `attribute emitted as raw text: ${value}`).toBe(true);
    }
  });
});

// ===========================================================================
// Modern syntax must survive the whole pipeline unchanged in meaning
// ===========================================================================

cases('adversarial: modern syntax', [
  ['private fields, static fields and static blocks', `class C { #v = 1; static s = 2; get v() { return this.#v; } static { C.t = 3; } }
     log(new C().v, C.s, C.t);`],
  ['generators', `function* g() { yield 1; yield 2; return 3; }
     var it = g(); log(it.next().value, it.next().value, it.next().value, it.next().done);`],
  ['async functions keep their microtask ordering', `async function f() { return 1; }
     f().then(function (v) { log('resolved', v); });
     log('sync');`],
  ['destructuring defaults run only when needed', `var t = [];
     function d(x) { t.push(x); return x; }
     var { a = d('A'), b = d('B') } = { a: 1 };
     log(a, b, t.join(','));`],
  ['spread and rest', `function f(...xs) { return xs.length; }
     var a = [1, 2]; log(f(...a, 3), Math.max(...a), { ...{ p: 1 }, q: 2 }.p);`],
  ['optional catch binding', `try { throw 1; } catch { log('caught'); }`],
  ['optional chaining short-circuits', `var o = null; log(o?.a?.b, o?.['a'], typeof o?.f?.());`],
  ['a computed class member key', `var k = 'm'; class C { [k]() { return 'ok'; } } log(new C().m());`],
  ['a computed constructor key is an ordinary method', `class C { ['constructor']() { return 'm'; } } log(new C().constructor(), typeof C.prototype.constructor);`],
  ['a computed __proto__ key defines a property', `var o = { ['__proto__']: 1 }; log(Object.getPrototypeOf(o) === Object.prototype, o.__proto__);`],
  ['Symbol.iterator', `var o = { *[Symbol.iterator]() { yield 1; yield 2; } };
     log([...o].join(','));`],
  ['do-while runs its body once', `var n = 0; do { n++; } while (false); log(n);`],
  ['negation of a relational operator is not flipped', `function f(a, b) { if (!(a < b)) return 'ge'; return 'lt'; }
     log(f(NaN, 1), f(1, 2), f(2, 1));`],
  ['a double negation that is read as a value keeps its boolean', `function f(x) { return !!x; } log(f(0), f('a'), typeof f(0));`],
  ['?? is not collapsed through a boolean coercion', `var v = !!undefined ?? 'd'; log(v);`],
  ['a ternary statement with assignments in both branches', `var x = 0; true ? (x = 1) : (x = 2); log(x);`],
]);

// ===========================================================================
// Obfuscator-shaped inputs
// ===========================================================================

cases('adversarial: obfuscator shapes', [
  [
    'a dispatcher runs its cases in dispatch order',
    `function f() {
       var _0x1 = '2|0|1'['split']('|'), _0x2 = 0;
       var out = '';
       while (true) {
         switch (_0x1[_0x2++]) {
           case '0': out += 'B'; continue;
           case '1': out += 'C'; continue;
           case '2': out += 'A'; continue;
         }
         break;
       }
       return out;
     }
     log(f());`,
  ],
  [
    'a dispatcher nested in a loop is linearised per iteration',
    `function f(n) {
       var out = '';
       for (var i = 0; i < n; i++) {
         var _0xo = '1|0|2'['split']('|'), _0xs = 0;
         while (true) {
           switch (_0xo[_0xs++]) {
             case '0': out += 'b'; continue;
             case '1': out += 'a'; continue;
             case '2': out += i; continue;
           }
           break;
         }
       }
       return out;
     }
     log(f(2));`,
  ],
  [
    'a dispatcher case that returns early still returns early',
    `function f(x) {
       var _0xo = '0|1'['split']('|'), _0xs = 0;
       while (true) {
         switch (_0xo[_0xs++]) {
           case '0': if (x) return 'early'; continue;
           case '1': return 'late';
         }
       }
     }
     log(f(1), f(0));`,
  ],
  ['an injected constant guard deletes only the dead side', `function f() {
       if ('abc' === 'abd') { log('never'); return 'dead'; }
       return 'live';
     }
     log(f());`],
  [
    'a map, a wrapper and a proxy stacked together',
    `var t = [];
     function s(x) { t.push(x); return x; }
     var _0xm = { 'kA': function (a, b) { return a + b; }, 'kB': 'concat', 'kC': function (a, b) { return a[b]; } };
     function _0xw(a, b) { return _0xm['kA'](a, b); }
     log(_0xw(s(1), s(2)), _0xm['kC']([1, 2], 1), _0xm['kB']);
     log(t.join(','));`,
  ],
  [
    'an exploded map that is observed while it is being built',
    `var _0xm = {};
     _0xm['a'] = 'A';
     log(Object.keys(_0xm).length);
     _0xm['b'] = 'B';
     log(_0xm['a'] + _0xm['b']);`,
  ],
  [
    'a table read through an alias',
    `var _0xa = ['one', 'two', 'three'];
     var _0xb = _0xa;
     log(_0xb[0], _0xa[2]);`,
  ],
  [
    'a table whose entries are replaced by a defineProperty getter',
    `var _0xa = ['s', 't'];
     function _0xd(i) { return _0xa[i]; }
     Object.defineProperty(_0xa, 0, { get: function () { return 'G'; } });
     log(_0xd(0), _0xd(1));`,
  ],
  [
    'a decoded key used as an assignment target',
    `var _0xa = ['key', 'other'];
     function _0xd(i) { return _0xa[i]; }
     var o = {};
     o[_0xd(0)] = 5;
     log(o.key, _0xd(1));`,
  ],
  [
    'a decoded key inside a destructuring pattern',
    `var _0xa = ['aa', 'bb'];
     function _0xd(i) { return _0xa[i]; }
     var box = {};
     [box[_0xd(0)]] = ['v'];
     log(box.aa, _0xd(1));`,
  ],
  [
    'a map read as the left-hand side of for-of',
    `var _0xm = { 'kk': 'p' };
     var o = {};
     for (o[_0xm['kk']] of [1, 2]) {}
     log(o.p);`,
  ],
  ['a self-referencing function is not mistaken for a tamper guard', `var out = [];
     var _0xf = function () { return _0xf.toString().length > 0; };
     out.push(_0xf());
     log(out.join(','));`],
  ['console reached through an alias', `var m = console.log; m('via alias');`],
]);

// ---------------------------------------------------------------------------
// Dean Edwards packer, in the form it is actually emitted (`'\\b'`, `'\\w+'`),
// so the unpacked program can be run and compared.
// ---------------------------------------------------------------------------

const ENCODER_62 = String.raw`e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};`;
const FAST_DECODE = String.raw`if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};`;
const LOOP = String.raw`while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p`;

function pack(payload: string, keywords: string, count: number): string {
  const quote = (v: string): string =>
    `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  return (
    `eval(function(p,a,c,k,e,d){${ENCODER_62}${FAST_DECODE}${LOOP}}` +
    `(${quote(payload)},62,${count},${quote(keywords)}.split('|'),0,{}))`
  );
}

cases('adversarial: eval packer', [
  ['a packed program is unpacked to the same program', pack('0 1(){2.3("4")}\n1();', 'function|greet|console|log|hi', 5)],
  ['statement order inside a payload is preserved', pack('0.1("2");0.1("3");', 'console|log|a|b', 4)],
  ['a keyword containing spaces is substituted whole', pack('0.1("2");', 'console|log|a b c', 3)],
]);

// ===========================================================================
// Idempotence and round-trip
// ===========================================================================

/**
 * A mechanical re-obfuscator, so `deobfuscate(obfuscate(x))` can be checked
 * against `x` by execution rather than by eye. It applies the three transforms
 * that matter for round-tripping: a string table behind a wrapper, arithmetic
 * in place of numeric literals, and an alias map.
 */
function obfuscate(source: string): string {
  const parsed = parseSource(source, {});
  const table: string[] = [];
  const indexOf = (value: string): number => {
    const at = table.indexOf(value);
    if (at >= 0) return at;
    table.push(value);
    return table.length - 1;
  };

  traverse(parsed.ast, {
    StringLiteral(path) {
      const parent = path.parentPath;
      // Keys and directives are not values; rewriting them changes the program.
      if (parent.isObjectProperty() && parent.node.key === path.node) return;
      if (parent.isObjectMethod() || parent.isClassMethod()) return;
      if (parent.isImportDeclaration() || parent.isExportNamedDeclaration()) return;
      if (parent.isExpressionStatement()) return;
      if (parent.isMemberExpression() && !parent.node.computed) return;
      path.replaceWith(
        t.callExpression(t.identifier('_0xdec'), [t.numericLiteral(indexOf(path.node.value))]),
      );
      path.skip();
    },
    NumericLiteral(path) {
      const value = path.node.value;
      if (!Number.isSafeInteger(value) || Math.abs(value) > 1000) return;
      if (path.parentPath.isObjectProperty() && path.parentPath.node.key === path.node) return;
      const left = Math.floor(value / 2);
      path.replaceWith(
        t.binaryExpression('+', t.numericLiteral(left), t.numericLiteral(value - left)),
      );
      path.skip();
    },
  });

  const { code } = printAst(parsed.ast, source, resolveConfig({}).output);
  return [
    `var _0xtab = [${table.map((s) => JSON.stringify(s)).join(', ')}];`,
    'function _0xdec(_0xi) { return _0xtab[_0xi - 0x0]; }',
    'function _0xadd(_0xa, _0xb) { return _0xa + _0xb; }',
    "var _0xmap = { 'qWzT': 'length', 'pLmN': function (a, b) { return a === b; } };",
    'void _0xadd;',
    'void _0xmap;',
    code,
  ].join('\n');
}

const PROGRAMS: ReadonlyArray<readonly [string, string]> = [
  [
    'a closure-returning factory',
    `function make(start) {
       var n = start;
       return { inc: function (by) { n = n + by; return n; }, get: function () { return n; } };
     }
     var c = make(10);
     log(c.inc(5), c.inc(-3), c.get());
     var words = ['alpha', 'beta', 'gamma'];
     for (var i = 0; i < words.length; i++) log(i + ':' + words[i].toUpperCase());`,
  ],
  [
    'a string-driven state machine',
    `function run(input) {
       var out = [];
       var state = 'start';
       for (var i = 0; i < input.length; i++) {
         var ch = input[i];
         if (state === 'start') { out.push('s' + ch); state = 'mid'; }
         else if (state === 'mid') { out.push('m' + ch); state = ch === 'x' ? 'start' : 'mid'; }
       }
       return out.join(',');
     }
     log(run('abxcd'));`,
  ],
  [
    'closures in a loop plus a caught error',
    `var fns = [];
     for (var i = 0; i < 3; i++) (function (j) { fns.push(function () { return j * j; }); })(i);
     log(fns.map(function (f) { return f(); }).join('|'));
     try { JSON.parse('{'); } catch (e) { log('caught ' + (e instanceof SyntaxError)); }
     log([3, 1, 2].sort().join(''), 'a,b'.split(',').length);`,
  ],
  [
    'getters whose order is observable',
    `var trace = [];
     var o = { get a() { trace.push('a'); return 1; }, get b() { trace.push('b'); return 2; } };
     log(o.a + o.b, o['b'] + o['a']);
     log(trace.join(''));`,
  ],
];

describe('adversarial: obfuscate then deobfuscate', () => {
  for (const [name, program] of PROGRAMS) {
    it(`${name} survives a synthetic obfuscation`, async () => {
      const obfuscated = obfuscate(program);
      // The obfuscator itself must be faithful, or the test proves nothing.
      expect(execute(obfuscated)).toBe(execute(program));
      expect(execute(await deob(obfuscated))).toBe(execute(program));
    });

    it(`${name} survives two obfuscate/deobfuscate rounds`, async () => {
      const first = await deob(obfuscate(program));
      const second = await deob(obfuscate(first));
      expect(execute(second)).toBe(execute(program));
    });

    it(`${name} deobfuscates to a behavioural fixed point`, async () => {
      const once = await deob(obfuscate(program));
      const twice = await deob(once);
      const thrice = await deob(twice);
      expect(execute(twice)).toBe(execute(program));
      expect(execute(thrice)).toBe(execute(program));
    });
  }
});

describe('adversarial: our own output is not corrupted by re-running', () => {
  for (const name of ['lightly-obfuscated.js', 'obfuscated2.js']) {
    const fixture = thirdPartyFixture(name);
    it.skipIf(!fixture.present)(`${name} re-parses and does not grow on a second run`, async () => {
      const source = fixture.read();
      const first = await deobfuscate(source, {
        preset: 'aggressive',
        performance: { verifyOutput: true },
      });
      expect(first.metadata.stats.verified).toBe(true);
      const second = await deobfuscate(first.code, {
        preset: 'aggressive',
        performance: { verifyOutput: true },
      });
      expect(second.metadata.stats.verified).toBe(true);
      // The second run is *not* byte-identical, because the naming layer
      // classifies its own output (`fn1`, `el`, `id`) as obfuscated and renames
      // it again. What must hold is that nothing is corrupted: the file still
      // parses and does not grow.
      expect(second.code.length).toBeLessThan(first.code.length * 1.05);
      expect(second.metadata.stats.astNodes).toBeLessThan(first.metadata.stats.astNodes * 1.01);
    }, 300_000);
  }
});

// ===========================================================================
// The output must not merely parse: every name in it must resolve.
// ===========================================================================

describe('adversarial: no output references a binding it deleted', () => {
  const SOURCES: ReadonlyArray<readonly [string, string, Language]> = [
    [
      'array with an opaque read left behind',
      `var _0xa = ['p', 'q', 'r'];
       function _0xd(i) { return _0xa[i]; }
       var k = 1;
       log(_0xd(0), _0xa[k]);`,
      'js',
    ],
    [
      'wrapper whose table is also read directly',
      `var _0xa = ['p', 'q'];
       function _0xd(i) { return _0xa[i]; }
       log(_0xd(0), _0xa.length);`,
      'js',
    ],
    [
      'map with one read the expander refuses',
      `var _0xm = { 'k1': 'A', 'k2': function (a, b) { return a || b; } };
       log(_0xm['k1'], _0xm['k2'](missingGlobal, 'fallback'));`,
      'js',
    ],
  ];

  for (const [name, source, language] of SOURCES) {
    it(name, async () => {
      const code = await deob(source, { language });
      const parsed = parseSource(code, { language });
      const unresolved: string[] = [];
      traverse(parsed.ast, {
        Program(path) {
          path.scope.crawl();
        },
        ReferencedIdentifier(path) {
          const { name: id } = path.node;
          if (path.scope.hasBinding(id) || path.scope.hasGlobal(id)) return;
          unresolved.push(id);
        },
      });
      // `hasGlobal` covers real globals; anything left is a name the run deleted.
      expect(unresolved.filter((n) => /^_0x/.test(n))).toEqual([]);
    });
  }
});
