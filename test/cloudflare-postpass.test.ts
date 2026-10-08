import { parse } from '@babel/parser';
import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parameterValue } from '../src/analysis/parameters.js';
import { normalizeLiteralsPass } from '../src/passes/prepare/normalize-literals.js';
import { inlineObjectMapsPass } from '../src/passes/simplify/object-maps.js';
import { expandSequencesPass } from '../src/passes/simplify/sequences.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { staticString, staticStringTable } from '../src/util/ast.js';
import { assertParses, expectEquivalent, expectNoChange, normalize, runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Cloudflare's managed-challenge script runs a post-pass over stock
 * obfuscator.io output, and each of the four things it does lands exactly on a
 * recogniser precondition: every string literal becomes a template literal, the
 * string table becomes `'a;b'.split(';')`, every local becomes a parameter
 * assigned by a comma sequence, and whole function bodies collapse into
 * `for (<sequence>; test;)` heads.
 *
 * These tests cover the four lifts and - as importantly - the neighbouring
 * cases where lifting them would be unsound.
 */

const parseExpression = (code: string): t.Expression =>
  (parse(`(${code})`).program.body[0] as t.ExpressionStatement).expression;

// ---------------------------------------------------------------------------
// R1: an untagged, substitution-free template literal is a string literal
// ---------------------------------------------------------------------------

describe('prepare.normalize-literals: template literals', () => {
  it('rewrites an untagged substitution-free template as a string literal', async () => {
    const { code, changes } = await runPass(normalizeLiteralsPass, 'const a = `foo`;');
    expect(changes).toBe(1);
    expectEquivalent(code, `const a = 'foo';`);
  });

  it('leaves a template with a substitution alone', async () => {
    await expectNoChange(normalizeLiteralsPass, 'const a = `x${y}z`;');
  });

  it('leaves a tagged template alone: the tag sees the raws, not a string', async () => {
    await expectNoChange(normalizeLiteralsPass, 'const a = tag`foo`;');
  });

  it('refuses to turn `use strict` into a directive', async () => {
    // As a template this is an ordinary expression statement; as a string
    // literal it is a directive that makes the whole function strict.
    await expectNoChange(normalizeLiteralsPass, 'function f() { `use strict`; return this; }');
  });

  it('still rewrites `use strict` where it cannot become a directive', async () => {
    const { code, changes } = await runPass(normalizeLiteralsPass, 'const a = `use strict`;');
    expect(changes).toBe(1);
    expectEquivalent(code, `const a = 'use strict';`);
  });
});

describe('staticString', () => {
  it('reads an untagged substitution-free template', () => {
    const node = t.templateLiteral([t.templateElement({ raw: 'x', cooked: 'x' }, true)], []);
    expect(staticString(node)).toBe('x');
  });

  it('refuses a template element with no cooked value', () => {
    // An escape JavaScript cannot decode has no cooked value at all; only a tag
    // can observe such a literal. Resolving it to its own source spelling -
    // which is what falling back to `raw` does - invents a string the program
    // never produces.
    const quasi = t.templateElement({ raw: 'a' }, true);
    quasi.value.cooked = undefined;
    expect(staticString(t.templateLiteral([quasi], []))).toBeUndefined();
  });
});

describe('staticStringTable', () => {
  it('reads an array of string literals', () => {
    expect(staticStringTable(parseExpression(`['a', 'b']`))).toEqual(['a', 'b']);
  });

  it('reads an array of substitution-free templates', () => {
    expect(staticStringTable(parseExpression('[`a`, `b`]'))).toEqual(['a', 'b']);
  });

  it('reads the split spelling of the same table', () => {
    expect(staticStringTable(parseExpression(`'a;b;c'.split(';')`))).toEqual(['a', 'b', 'c']);
    expect(staticStringTable(parseExpression('`a;b`.split(`;`)'))).toEqual(['a', 'b']);
  });

  it('refuses an empty separator, which turns any literal into a table', () => {
    expect(staticStringTable(parseExpression(`'abc'.split('')`))).toBeUndefined();
  });

  it('refuses a split whose subject, separator or arity is not what it assumes', () => {
    expect(staticStringTable(parseExpression(`x.split(';')`))).toBeUndefined();
    expect(staticStringTable(parseExpression(`'a;b'.split(sep)`))).toBeUndefined();
    expect(staticStringTable(parseExpression(`'a;b'.split(';', 1)`))).toBeUndefined();
    expect(staticStringTable(parseExpression(`'a;b'.slice(1)`))).toBeUndefined();
  });

  it('refuses an array with a hole or a non-string element', () => {
    expect(staticStringTable(parseExpression(`['a', , 'b']`))).toBeUndefined();
    expect(staticStringTable(parseExpression(`['a', 1]`))).toBeUndefined();
  });
});

describe('strings: the split spelling of a table', () => {
  it('decodes a table written as a template split on a separator', async () => {
    const source = [
      'function g() {',
      '  var A = `alpha;beta;gamma;delta;epsilon;zeta;eta;theta`.split(`;`);',
      '  function d(i) { return A[i - 0]; }',
      '  return [d(0), d(3), d(7)];',
      '}',
    ].join('\n');
    const { code, ctx } = await runPass(
      [normalizeLiteralsPass, discoverStringsPass, inlineStringsPass],
      source,
    );
    expect(ctx.stringSources.length).toBe(1);
    expect(normalize(code)).toContain(`'alpha'`);
    expect(normalize(code)).toContain(`'delta'`);
    expect(normalize(code)).toContain(`'theta'`);
    assertParses(code);
  });
});

// ---------------------------------------------------------------------------
// R2: a populated `for` head can host a dispatcher
// ---------------------------------------------------------------------------

const CASES = `case '0': second(); continue;
               case '1': first(); continue;`;

describe('structure.control-flow: `for` heads', () => {
  it('linearises a dispatcher whose order and state live in the `for` head', async () => {
    const source = `function f() {
      for (var order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    const { code, changes } = await runPass(unflattenControlFlowPass, source);
    expect(changes).toBeGreaterThan(0);
    expectEquivalent(code, 'function f() { first(); second(); }');
  });

  it('hoists the rest of the head ahead of the linearised body', async () => {
    const source = `function f() {
      for (var side = setup(), order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) {
          case '0': second(side); continue;
          case '1': first(side); continue;
        }
        break;
      }
    }`;
    const { code } = await runPass(unflattenControlFlowPass, source);
    expectEquivalent(code, 'function f() { var side = setup(); first(side); second(side); }');
  });

  it('refuses a head with an update, which runs after every block', async () => {
    const source = `function f() {
      for (var order = '1|0'.split('|'), state = 0; !![]; tick()) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    await expectNoChange(unflattenControlFlowPass, source);
  });

  it('refuses a `let` in the head, which is scoped to the loop', async () => {
    const source = `function f() {
      for (let order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    const { changes, ctx } = await runPass(unflattenControlFlowPass, source);
    expect(changes).toBe(0);
    expect(ctx.diagnostics.map((d) => d.message).join('\n')).toContain('scoped to the loop');
  });

  it('refuses a `let` in the head even when the dispatcher bindings are parameters', async () => {
    // Nothing about the order array is wrong here; hoisting the head would move
    // `side` out of the loop scope, and every later `side` would resolve to it.
    const source = `function f(order, state) {
      for (let side = setup(); !![];) {
        order = '1|0'.split('|');
        state = 0;
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    await expectNoChange(unflattenControlFlowPass, source);
  });
});

// ---------------------------------------------------------------------------
// R3: parameters used as locals
// ---------------------------------------------------------------------------

/** Resolve one parameter of a source and ask whether it reads as a local. */
function acceptsAsLocal(source: string, name: string): boolean {
  const ast = parse(source, { sourceType: 'script' });
  let binding: Binding | undefined;
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
    },
    Function(path: NodePath<t.Function>) {
      binding ??= path.scope.bindings[name];
    },
  });
  if (!binding) throw new Error(`no binding named ${name}`);
  return parameterValue(binding) !== undefined;
}

describe('analysis/parameters: a parameter assigned once, before first use', () => {
  it('accepts the shape the post-pass emits', () => {
    expect(acceptsAsLocal('function f(a, m) { m = { k: 1 }; return a + m.k; }', 'm')).toBe(true);
  });

  it('accepts an assignment inside the leading comma sequence', () => {
    expect(acceptsAsLocal('function f(a, m, n) { n = (m = { k: 1 }, m.k); return a + n; }', 'm')).toBe(
      true,
    );
  });

  it('accepts an assignment in a leading `for` head', () => {
    expect(acceptsAsLocal('function f(m) { for (m = { k: 1 }; g();) h(m); }', 'm')).toBe(true);
  });

  it('accepts an assignment in a returned comma sequence', () => {
    expect(acceptsAsLocal('function f(m) { return m = { k: 1 }, m.k; }', 'm')).toBe(true);
  });

  it('refuses when the value is computed from the incoming argument', () => {
    // `i = i - 152` is a real decoder in the fixture this exists for. Treating
    // `i` as a local would decode every string at the wrong index.
    expect(acceptsAsLocal('function f(i) { i = i - 152; return table[i]; }', 'i')).toBe(false);
  });

  it('refuses when a read comes before the write', () => {
    expect(acceptsAsLocal('function f(p) { use(p); p = 1; return p; }', 'p')).toBe(false);
  });

  it('refuses when the write is conditional', () => {
    expect(acceptsAsLocal('function f(p) { if (c) { p = 1; } return p; }', 'p')).toBe(false);
  });

  it('refuses when a statement before the write can skip it', () => {
    expect(acceptsAsLocal('function f(p) { if (c) return 0; p = 1; return p; }', 'p')).toBe(false);
  });

  it('refuses a second write', () => {
    expect(acceptsAsLocal('function f(p) { p = 1; p = 2; return p; }', 'p')).toBe(false);
  });

  it('refuses a compound assignment', () => {
    expect(acceptsAsLocal('function f(p) { p += 1; return p; }', 'p')).toBe(false);
  });

  it('refuses when the function mentions `arguments`', () => {
    // In sloppy mode `arguments[0]` aliases a simple parameter, so it reads the
    // caller's value whatever the body assigns to the name.
    expect(acceptsAsLocal('function f(p) { p = 1; return arguments[0] + p; }', 'p')).toBe(false);
  });

  it('refuses when the function contains a direct eval', () => {
    expect(acceptsAsLocal('function f(p) { p = 1; return eval("p"); }', 'p')).toBe(false);
  });

  it('accepts a reference inside a closure created after the write', () => {
    expect(
      acceptsAsLocal('function f(p) { p = 1; return function () { return p; }; }', 'p'),
    ).toBe(true);
  });

  it('refuses a reference inside a closure created before the write', () => {
    expect(
      acceptsAsLocal('function f(p) { var g = function () { return p; }; p = 1; return g; }', 'p'),
    ).toBe(false);
  });

  it('accepts a hoisted function reference when nothing before the write can call it', () => {
    expect(
      acceptsAsLocal('function f(p) { p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(true);
  });

  it('refuses a hoisted function reference when a call runs before the write', () => {
    // `h()` is free to call `g`, which would read the caller's value.
    expect(
      acceptsAsLocal('function f(p) { h(); p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses a destructured parameter', () => {
    expect(acceptsAsLocal('function f({ p }) { p = 1; return p; }', 'p')).toBe(false);
  });
});

/**
 * `cannotInvoke` decides one thing only: whether the code that runs *before* the
 * assignment could have called a hoisted function that reads the parameter. Get
 * it wrong and the analysis reports a value the reader never sees, so each case
 * below is written as the exploit rather than as the shape - a hoisted `g` that
 * reads `p`, and a preceding expression that reaches `g` through a `valueOf`, a
 * `toString` or a getter the operand never mentions.
 */
describe('analysis/parameters: what can run before the write', () => {
  it('refuses `-o`, which runs ToNumber and so calls `valueOf`', () => {
    expect(
      acceptsAsLocal('function f(p) { -o; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses unary `+`, which is the same coercion', () => {
    expect(
      acceptsAsLocal('function f(p) { +o; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses `~o`, which is ToNumber followed by an integer conversion', () => {
    expect(
      acceptsAsLocal('function f(p) { ~o; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('still accepts `!`, `typeof` and `void`, none of which coerce', () => {
    expect(
      acceptsAsLocal(
        'function f(p, o) { !o; typeof o; void o; p = 1; return g(); function g() { return p; } }',
        'p',
      ),
    ).toBe(true);
  });

  it('refuses `o < 1`, which runs ToPrimitive on the object operand', () => {
    expect(
      acceptsAsLocal('function f(p) { o < 1; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses `o + 1`, whose ToPrimitive calls `valueOf` then `toString`', () => {
    expect(
      acceptsAsLocal('function f(p) { o + 1; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses loose `==`, which coerces where `===` does not', () => {
    expect(
      acceptsAsLocal('function f(p) { o == 1; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('still accepts `===` and `!==`, which compare without converting', () => {
    expect(
      acceptsAsLocal(
        'function f(p, o) { o === 1; o !== 1; p = 1; return g(); function g() { return p; } }',
        'p',
      ),
    ).toBe(true);
  });

  it('refuses an earlier object-destructuring declarator, which runs a getter', () => {
    // The call is in neither `o` nor anything else the initialiser mentions: it
    // is `o.x`'s getter, reached by the binding pattern itself.
    expect(
      acceptsAsLocal(
        'function f(p) { var { x } = o; p = 1; return g(); function g() { return p; } }',
        'p',
      ),
    ).toBe(false);
  });

  it('refuses an earlier array-destructuring declarator, which runs the iterator', () => {
    expect(
      acceptsAsLocal(
        'function f(p) { var [x] = o; p = 1; return g(); function g() { return p; } }',
        'p',
      ),
    ).toBe(false);
  });

  it('refuses a destructuring declarator in the same declaration as the write', () => {
    // Same hole one level in: the climb to the top of the body passes the
    // earlier declarators of `var { x } = o, q = (p = 1);` and has to weigh the
    // targets, not just the initialisers.
    expect(
      acceptsAsLocal(
        'function f(p) { var { x } = o, q = (p = 1); return g(); function g() { return p; } }',
        'p',
      ),
    ).toBe(false);
  });

  /*
   * A free name is a property access on the global object, so reading one runs
   * whatever getter is installed there and assigning to one runs a setter. Both
   * hand control to program code, which is exactly what `quiet` exists to
   * exclude - the operator whitelists above do not contain it, because the
   * hazard is the name, not the operator.
   */
  it('refuses a bare read of a free name, which can run a global getter', () => {
    expect(
      acceptsAsLocal('function f(p) { q = trap; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses a write to a free name, which can run a global setter', () => {
    expect(
      acceptsAsLocal('function f(p) { trap = 1; p = 1; return g(); function g() { return p; } }', 'p'),
    ).toBe(false);
  });

  it('refuses a free name behind the operators the whitelists do allow', () => {
    for (const prefix of ['q = typeof trap;', 'q = trap === 1;', 'var t = trap;']) {
      expect(
        acceptsAsLocal(
          `function f(p) { ${prefix} p = 1; return g(); function g() { return p; } }`,
          'p',
        ),
      ).toBe(false);
    }
  });

  it('still accepts an earlier declarator that binds a plain name', () => {
    expect(
      acceptsAsLocal(
        'function f(p, o) { var x = o; p = 1; return g(); function g() { return p; } }',
        'p',
      ),
    ).toBe(true);
  });
});

describe('structure.control-flow: parameters as the order array and state counter', () => {
  it('linearises when both live in the parameter list and the `for` head', async () => {
    const source = `function f(order, state) {
      for (order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    const { code, changes } = await runPass(unflattenControlFlowPass, source);
    expect(changes).toBeGreaterThan(0);
    expectEquivalent(code, 'function f(order, state) { first(); second(); }');
  });

  it('linearises when the parameters are assigned above the loop', async () => {
    const source = `function f(order, state) {
      order = '1|0'.split('|');
      state = 0;
      while (!![]) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    const { code, changes } = await runPass(unflattenControlFlowPass, source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain('first();second();');
  });

  it('still linearises after an earlier pass has rewritten the tree', async () => {
    // `simplify.sequences` splits the comma statement in the stage immediately
    // before this one, which leaves Babel's cached reference lists stale. Every
    // gate here is a statement about references, so a stale list refuses a
    // dispatcher that is provable - which is why the pass rebuilds scope.
    const source = `function f(order, state) {
      order = '1|0'.split('|'), state = 0;
      while (!![]) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    const { code, changes } = await runPass(
      [expandSequencesPass, unflattenControlFlowPass],
      source,
    );
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain('first();second();');
  });

  it('refuses when the state counter is read before it is set', async () => {
    const source = `function f(order, state) {
      probe(state);
      order = '1|0'.split('|');
      state = 0;
      while (!![]) {
        switch (order[state++]) { ${CASES} }
        break;
      }
    }`;
    await expectNoChange(unflattenControlFlowPass, source);
  });

  it('refuses a `for` head assignment when the function mentions `arguments`', async () => {
    // What licenses the head shortcut is that the dispatcher is the binding's
    // only reader, and that is read off `binding.referencePaths`. In sloppy
    // mode `arguments[0]` aliases the simple parameter `order` and produces no
    // reference at all, so linearising would retire the head assignment and
    // leave `arguments[0]` yielding the caller's value instead of the array.
    const source = `function f(order, state) {
      for (order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) { ${CASES} }
        break;
      }
      return arguments[0];
    }`;
    await expectNoChange(unflattenControlFlowPass, source);
  });

  it('refuses a `for` head assignment when the function contains a direct eval', async () => {
    // A direct `eval` can name `order` at a point no reference walk sees.
    const source = `function f(order, state) {
      for (order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) { ${CASES} }
        break;
      }
      return eval('order');
    }`;
    await expectNoChange(unflattenControlFlowPass, source);
  });

  it('still linearises a `for` head assignment in a function that does neither', async () => {
    const source = `function f(order, state) {
      for (order = '1|0'.split('|'), state = 0; !![];) {
        switch (order[state++]) { ${CASES} }
        break;
      }
      return 1;
    }`;
    const { code, changes } = await runPass(unflattenControlFlowPass, source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain('first();second();');
  });
});

// ---------------------------------------------------------------------------
// R4: numeric index maps behind parameters
// ---------------------------------------------------------------------------

describe('simplify.object-maps: maps assigned to a parameter', () => {
  it('inlines an all-numeric index map written as a parameter assignment', async () => {
    const source = `function f(a, map) {
      map = { W: 1838, c: 152 };
      return dec(map.W) + dec(map.c);
    }`;
    const { code, changes } = await runPass(inlineObjectMapsPass, source);
    expect(changes).toBeGreaterThan(0);
    expect(normalize(code)).toContain('dec(1838)');
    expect(normalize(code)).toContain('dec(152)');
    expect(normalize(code)).not.toContain('map.W');
    assertParses(code);
  });

  it('drops the assignment when it is one operand of a comma sequence', async () => {
    const source = `function f(a, map, out) {
      out = (map = { W: 7 }, base);
      return out + map.W;
    }`;
    const { code } = await runPass(inlineObjectMapsPass, source);
    expect(normalize(code)).not.toContain('W:7');
    expect(normalize(code)).toContain('base');
    expect(normalize(code)).toContain('7');
  });

  it('keeps the assignment when its own value is used', async () => {
    const source = `function f(map, out) {
      out = (map = { W: 7 });
      return out.W + map.W;
    }`;
    const { code, changes } = await runPass(inlineObjectMapsPass, source);
    expect(changes).toBeGreaterThan(0);
    // The read is rewritten; the assignment stays, because the sequence rule
    // does not apply and `out` still needs the object.
    expect(normalize(code)).toContain('W: 7');
    expect(normalize(code)).toContain('out.W + 7');
  });

  it('refuses when the assignment is not on the entry prefix', async () => {
    // Buried in a call argument: something has already run, and nothing here
    // proves what.
    await expectNoChange(
      inlineObjectMapsPass,
      'function f(map) { return take(map = { W: 7 }) + map.W; }',
    );
  });

  it('refuses a map read before the assignment', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      'function f(map) { probe(map.W); map = { W: 7 }; return map.W; }',
    );
  });

  it('refuses a map the function can reassign', async () => {
    await expectNoChange(
      inlineObjectMapsPass,
      'function f(map) { map = { W: 7 }; map = other; return map.W; }',
    );
  });
});

// ---------------------------------------------------------------------------
// A rotation the slice cannot take is a refusal, not a rotation of zero
// ---------------------------------------------------------------------------

describe('strings: an unmodelled rotation', () => {
  it('refuses a table shuffled by a wrapper buried in a comma sequence', async () => {
    // The wrapper is not an expression *statement*, so the statement-granular
    // slicer cannot include it. Decoding without it takes every entry from the
    // wrong offset: plausible strings, all wrong, and nothing downstream can
    // tell. Measured on the real fixture, index 152 reads '0|1|5|2|7|4|3|6'
    // with the rotation missed and 'responseText' with it applied.
    const source = [
      '(function () {',
      '  for (side = (function (t, n) { while (n-- > 0) t().push(t().shift()); })(A, 2), ready = 1; !ready;);',
      "  function A() { var d = ['alpha', 'beta', 'gamma', 'delta']; A = function () { return d; }; return A(); }",
      '  function D(i) { return A()[i - 0]; }',
      '  log(D(0), D(1));',
      '})();',
    ].join('\n');
    const { code, ctx } = await runPass([discoverStringsPass, inlineStringsPass], source);
    expect(ctx.stringSources.length).toBe(0);
    expect(normalize(code)).toContain('D(0)');
    const messages = ctx.diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('push(shift()) rotation');
  });
});
