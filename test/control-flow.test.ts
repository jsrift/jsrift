import { describe, expect, it } from 'vitest';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import type { DeobfuscateOptions } from '../src/types.js';
import {
  assertParses,
  expectEquivalent,
  expectIdempotent,
  expectNoChange,
  normalize,
  runPass,
} from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const FIXTURE = thirdPartyFixture('lightly-obfuscated.js');
const BIG_FIXTURE = thirdPartyFixture('obfuscated2.js');

/** Wrap a dispatcher in a function so `var` hoisting is observable. */
function fn(body: string): string {
  return `function f() {\n${body}\n}`;
}

/** The canonical obfuscator.io emission, parameterised by order and cases. */
function dispatcher(order: string, cases: string, options: { state?: string } = {}): string {
  const init = options.state ?? '0';
  return `var order = '${order}'.split('|'), i = ${init};
  while (true) {
    switch (order[i++]) {
${cases}
    }
    break;
  }`;
}

async function run(source: string, options: DeobfuscateOptions = {}) {
  return runPass(unflattenControlFlowPass, source, options);
}

/** A bail-out is a diagnostic plus a completely untouched tree. */
async function expectBailout(source: string, fragment: string, options: DeobfuscateOptions = {}) {
  const { changes, ctx, code } = await run(source, options);
  expect(changes).toBe(0);
  const messages = ctx.diagnostics.map((d) => d.message).join('\n');
  expect(messages).toContain(fragment);
  assertParses(code);
}

// ---------------------------------------------------------------------------
// Recognition and recovery
// ---------------------------------------------------------------------------

describe('structure.control-flow: recovery', () => {
  it('inlines case bodies in dispatch order, not textual order', async () => {
    const { code, changes } = await run(
      fn(
        dispatcher(
          '3|0|4|1|2',
          `case '0': b(); continue;
           case '1': c(); continue;
           case '2': d(); continue;
           case '3': a(); continue;
           case '4': e(); continue;`,
        ),
      ),
    );
    expect(changes).toBe(1);
    expectEquivalent(code, 'function f() { a(); b(); e(); c(); d(); }');
  });

  it('recovers a reversed order, which textual inlining would get backwards', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '2|1|0',
          `case '0': third(); continue;
           case '1': second(); continue;
           case '2': first(); continue;`,
        ),
      ),
    );
    expectEquivalent(code, 'function f() { first(); second(); third(); }');
  });

  it('keeps a terminating case as the end of the recovered block', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '1|0',
          `case '0': return value;
           case '1': var value = compute(); continue;`,
        ),
      ),
    );
    expectEquivalent(code, 'function f() { var value = compute(); return value; }');
  });

  it('accepts a throw as a case terminator', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '0|1',
          `case '0': check(); continue;
           case '1': throw new Error('boom');`,
        ),
      ),
    );
    expectEquivalent(code, "function f() { check(); throw new Error('boom'); }");
  });

  it('recognises the for(;;) spelling of the loop', async () => {
    const { code } = await run(
      fn(`var order = '1|0'.split('|'), i = 0;
        for (;;) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
    );
    expectEquivalent(code, 'function f() { first(); second(); }');
  });

  it('recognises the !![] spelling of the loop test', async () => {
    const { code } = await run(
      fn(`var order = '1|0'.split('|'), i = 0;
        while (!![]) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
    );
    expectEquivalent(code, 'function f() { first(); second(); }');
  });

  it('reads the order from a plain array literal', async () => {
    const { code } = await run(
      fn(`var order = ['1', '0'], i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
    );
    expectEquivalent(code, 'function f() { first(); second(); }');
  });

  it('folds a split-string order before reading it', async () => {
    const { code } = await run(
      fn(`var order = ('1|0|' + '2|4|' + '3').split('|'), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': s1(); continue;
            case '1': s0(); continue;
            case '2': s2(); continue;
            case '3': s4(); continue;
            case '4': s3(); continue;
          }
          break;
        }`),
    );
    expectEquivalent(code, 'function f() { s0(); s1(); s2(); s3(); s4(); }');
  });

  it('tolerates a default clause that is only the terminator', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '1|0',
          `case '0': second(); continue;
           case '1': first(); continue;
           default: break;`,
        ),
      ),
    );
    expectEquivalent(code, 'function f() { first(); second(); }');
  });

  it('deletes the order and counter declarations it made unreachable', async () => {
    const { code } = await run(fn(dispatcher('0', `case '0': only(); continue;`)));
    expect(code).not.toContain('order');
    expect(code).not.toContain('split');
    expectEquivalent(code, 'function f() { only(); }');
  });

  it('keeps an order initialiser whose removal could be observed', async () => {
    const { code, changes } = await run(
      fn(`var order = buildOrder(), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
      { techniques: { controlFlowAnalysis: { aggressiveDispatchers: true } } },
    );
    // `buildOrder()` is not statically resolvable, so this is a bail-out, not a
    // silent deletion of a call.
    expect(changes).toBe(0);
    expect(code).toContain('buildOrder()');
  });

  it('splices into a block when the loop is a bare statement body', async () => {
    const { code } = await run(
      fn(`var order = '1|0'.split('|'), i = 0;
        if (ready) while (true) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
    );
    assertParses(code);
    expectEquivalent(code, 'function f() { if (ready) { first(); second(); } }');
  });

  it('produces output that still parses', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '1|0|2',
          `case '0': for (var k = 0; k < n; k++) { if (k) continue; use(k); } continue;
           case '1': var n = size(); continue;
           case '2': return n;`,
        ),
      ),
    );
    assertParses(code);
  });
});

// ---------------------------------------------------------------------------
// Hoisting and nesting
// ---------------------------------------------------------------------------

describe('structure.control-flow: hoisting and nesting', () => {
  it('keeps var declarations visible in the enclosing function scope', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '1|0',
          `case '0': var a = 1; continue;
           case '1': var b = a; continue;`,
        ) + '\n  return [a, b];',
      ),
    );
    // Dispatch order runs case 1 first, so `b` reads the hoisted-but-unset `a`
    // exactly as it did before - which only holds if both stay function-scoped.
    expectEquivalent(code, 'function f() { var b = a; var a = 1; return [a, b]; }');
  });

  it('keeps a function declaration hoisted out of its case body', async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '1|0',
          `case '0': return helper();
           case '1': function helper() { return 7; } continue;`,
        ),
      ),
    );
    assertParses(code);
    expect(normalize(code)).toContain('function helper()');
  });

  it('unflattens a dispatcher nested inside another dispatcher case', async () => {
    const { code, changes } = await run(
      fn(`var o1 = '1|0'.split('|'), i1 = 0;
        while (true) {
          switch (o1[i1++]) {
            case '0':
              outerLast();
              continue;
            case '1':
              var o2 = '1|0'.split('|'), i2 = 0;
              while (true) {
                switch (o2[i2++]) {
                  case '0': innerLast(); continue;
                  case '1': innerFirst(); continue;
                }
                break;
              }
              continue;
          }
          break;
        }`),
    );
    expect(changes).toBe(2);
    expectEquivalent(code, 'function f() { innerFirst(); innerLast(); outerLast(); }');
  });

  it("leaves a nested loop's own continue bound to that loop", async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '1|0',
          `case '0': after(); continue;
           case '1': while (more()) { if (skip()) continue; body(); } continue;`,
        ),
      ),
    );
    expectEquivalent(
      code,
      'function f() { while (more()) { if (skip()) continue; body(); } after(); }',
    );
  });

  it("leaves a nested switch's own break bound to that switch", async () => {
    const { code } = await run(
      fn(
        dispatcher(
          '0|1',
          `case '0': switch (kind()) { case 1: one(); break; default: other(); } continue;
           case '1': done(); continue;`,
        ),
      ),
    );
    assertParses(code);
    expect(normalize(code)).toContain('case 1: one();break;');
  });

  it('keeps a label declared inside the case body working', async () => {
    const { code } = await run(
      fn(dispatcher('0', `case '0': inner: for (;;) { break inner; } continue;`)),
    );
    assertParses(code);
    expect(normalize(code)).toContain('break inner;');
  });
});

// ---------------------------------------------------------------------------
// Bail-outs - every one of these must leave the tree untouched
// ---------------------------------------------------------------------------

describe('structure.control-flow: bail-outs', () => {
  it('refuses a case that breaks the switch into code after the loop', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': maybe(); break;
           case '1': second(); continue;`,
        ) + '\n  after();',
      ),
      'break escapes the switch',
    );
  });

  it('refuses when a case body steers the state counter itself', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': i = 1; continue;
           case '1': second(); continue;`,
        ),
      ),
      'state counter is written outside',
    );
  });

  it('refuses when a closure inside a case can write the state counter', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': defer(function () { i = 0; }); continue;
           case '1': second(); continue;`,
        ),
      ),
      'state counter is written outside',
    );
  });

  it('refuses when the state counter is reset after the loop', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); continue;
           case '1': second(); continue;`,
        ) + '\n  i = 0;',
      ),
      'state counter is written outside',
    );
  });

  it('refuses when the state counter is read elsewhere', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); continue;
           case '1': second(); continue;`,
        ) + '\n  report(i);',
      ),
      'state counter is read outside',
    );
  });

  it('refuses a state entered from more than one point in the order', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1|0',
          `case '0': shared(); continue;
           case '1': other(); continue;`,
        ),
      ),
      'entered more than once',
    );
  });

  it('refuses a continue targeting an outer label', async () => {
    await expectBailout(
      `outer: for (;;) {
        var order = '0|1'.split('|'), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': if (again()) continue outer; continue;
            case '1': second(); continue;
          }
          break;
        }
      }`,
      'targets a label outside the dispatcher',
    );
  });

  it('refuses a break targeting an outer label', async () => {
    await expectBailout(
      `outer: for (;;) {
        var order = '0|1'.split('|'), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': if (stop()) break outer; continue;
            case '1': second(); continue;
          }
          break;
        }
      }`,
      'targets a label outside the dispatcher',
    );
  });

  it('refuses a labelled dispatcher loop, which other code can still target', async () => {
    await expectBailout(
      fn(`var order = '0|1'.split('|'), i = 0;
        dispatch: while (true) {
          switch (order[i++]) {
            case '0': first(); continue;
            case '1': second(); continue;
          }
          break;
        }`),
      'carries a label',
    );
  });

  it('refuses a default clause that does real work', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); continue;
           case '1': second(); continue;
           default: fallback(); continue;`,
        ),
      ),
      'default that is not just the terminator',
    );
  });

  it('refuses a default clause that is not last', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `default: break;
           case '0': first(); continue;
           case '1': second(); continue;`,
        ),
      ),
      'non-final default',
    );
  });

  it('refuses a case that falls through into the next one', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first();
           case '1': second(); continue;`,
        ),
      ),
      'falls through',
    );
  });

  it('refuses an empty case, which is a fall-through in disguise', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0':
           case '1': second(); continue;`,
        ),
      ),
      'falls through',
    );
  });

  it('refuses a case that continues the dispatcher before its end', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': if (skip()) continue; work(); continue;
           case '1': second(); continue;`,
        ),
      ),
      'continues the dispatcher before its end',
    );
  });

  it('refuses a case declaring a let, whose scope the splice would change', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': let value = 1; use(value); continue;
           case '1': second(); continue;`,
        ),
      ),
      'block-scoped let',
    );
  });

  it('refuses a case declaring a const', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': const value = 1; use(value); continue;
           case '1': second(); continue;`,
        ),
      ),
      'block-scoped const',
    );
  });

  it('refuses a case declaring a class', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': class Thing {} use(Thing); continue;
           case '1': second(); continue;`,
        ),
      ),
      'declares a class',
    );
  });

  it('refuses a dispatcher with more states than maxStates allows', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1|2',
          `case '0': a(); continue;
           case '1': b(); continue;
           case '2': c(); continue;`,
        ),
      ),
      'exceeds maxStates',
      { techniques: { controlFlowAnalysis: { maxStates: 2 } } },
    );
  });

  it('refuses a computed order array unless aggressiveDispatchers is on', async () => {
    const source = fn(`var raw = '1|0';
      var order = raw.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': second(); continue;
          case '1': first(); continue;
        }
        break;
      }`);
    await expectBailout(source, 'not statically resolvable', {
      techniques: { controlFlowAnalysis: { aggressiveDispatchers: false } },
    });

    const { code, changes } = await run(source, {
      techniques: { controlFlowAnalysis: { aggressiveDispatchers: true } },
    });
    expect(changes).toBe(1);
    expect(normalize(code)).toContain('first();second();');
  });

  it('refuses an order the analysis cannot resolve at all', async () => {
    await expectBailout(
      fn(`var order = window.plan, i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': first(); continue;
            case '1': second(); continue;
          }
          break;
        }`),
      'not statically resolvable',
    );
  });

  // -------------------------------------------------------------------------
  // The order string behind a property-alias map
  // -------------------------------------------------------------------------

  /** `var m = { k: '1|0' }; var order = m.k.split('|'), i = 0; ...` */
  function mappedOrder(prelude: string, read = 'm.iVmQB'): string {
    return fn(`var m = { 'iVmQB': '1|0' };
      ${prelude}
      var order = ${read}.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': second(); continue;
          case '1': first(); continue;
        }
        break;
      }`);
  }

  it('resolves an order string held in a constant alias map, only when aggressive', async () => {
    const source = mappedOrder('');

    // obfuscator.io routes the order string through the same alias map as every
    // other constant. `simplify.object-maps` usually inlines it first, so this
    // is the fallback for when that pass refuses the map or is switched off.
    await expectBailout(source, 'not statically resolvable', {
      techniques: { controlFlowAnalysis: { aggressiveDispatchers: false } },
    });

    const { code, changes } = await run(source);
    expect(changes).toBe(1);
    expect(normalize(code)).toContain('first();second();');
  });

  it('refuses a mapped order string when anything writes to the map', async () => {
    // `binding.constant` is true - the *name* is never rebound - so the proof
    // has to be about the property, not the binding.
    await expectBailout(mappedOrder(`m.iVmQB = '0|1';`), 'not statically resolvable');
    await expectBailout(mappedOrder(`delete m.iVmQB;`), 'not statically resolvable');
  });

  it('refuses a mapped order string when the map escapes', async () => {
    await expectBailout(mappedOrder('sink(m);'), 'not statically resolvable');
    await expectBailout(mappedOrder('var copy = { ...m };'), 'not statically resolvable');
  });

  it('refuses a mapped order string when any read of the map has a computed key', async () => {
    // A key expression runs code, and that code could rewrite the entry between
    // the declaration and the lookup.
    await expectBailout(mappedOrder('var other = m[pick()];'), 'not statically resolvable');
    await expectBailout(mappedOrder('', 'm[pick()]'), 'not statically resolvable');
  });

  it('refuses a mapped order string the map does not define', async () => {
    await expectBailout(mappedOrder('', 'm.missing'), 'not statically resolvable');
  });

  it('refuses a map entry that is not a static string', async () => {
    await expectBailout(
      fn(`var m = { 'iVmQB': makeOrder() };
        var order = m.iVmQB.split('|'), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
      'not statically resolvable',
    );
  });

  it('refuses a map with a getter, which runs code on every read', async () => {
    await expectBailout(
      fn(`var m = { get iVmQB() { return '1|0'; } };
        var order = m.iVmQB.split('|'), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': second(); continue;
            case '1': first(); continue;
          }
          break;
        }`),
      'not statically resolvable',
    );
  });

  it('refuses when the order array names a state with no case', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1|2',
          `case '0': first(); continue;
           case '1': second(); continue;`,
        ),
      ),
      'missing state',
    );
  });

  it('refuses when a case is never named by the order array', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0',
          `case '0': first(); continue;
           case '1': unreachable(); continue;`,
        ),
      ),
      'never entered',
    );
  });

  it('refuses when the counter does not start at zero', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); continue;
           case '1': second(); continue;`,
          { state: '1' },
        ),
      ),
      'does not start at 0',
    );
  });

  it('refuses when the order array is reassigned', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); continue;
           case '1': second(); continue;`,
        ) + "\n  order = ['9'];",
      ),
      'order array is reassigned',
    );
  });

  it('refuses when the order array is read somewhere else too', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); continue;
           case '1': second(); continue;`,
        ) + '\n  log(order);',
      ),
      'order array is used outside',
    );
  });

  it('refuses when the declarations only appear after the loop', async () => {
    await expectBailout(
      fn(`while (true) {
          switch (order[i++]) {
            case '0': first(); continue;
            case '1': second(); continue;
          }
          break;
        }
        var order = '0|1'.split('|'), i = 0;`),
      'declared after the dispatcher',
    );
  });

  it('refuses a case body containing a direct eval', async () => {
    await expectBailout(
      fn(
        dispatcher(
          '0|1',
          `case '0': eval(payload); continue;
           case '1': second(); continue;`,
        ),
      ),
      'direct eval',
    );
  });
});

// ---------------------------------------------------------------------------
// Shapes that are not dispatchers at all - silent, no diagnostic
// ---------------------------------------------------------------------------

describe('structure.control-flow: non-dispatchers', () => {
  it('leaves a genuine application switch alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `function onKey(event) {
        switch (event.keyCode) {
          case 37: moveLeft(); break;
          case 39: moveRight(); break;
          case 13: submit(); break;
          default: ignore();
        }
      }`,
    );
  });

  it('leaves the comma-sequence discriminant shape from the fixture alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `function d(a) {
        var b;
        while (true) {
          switch (b = this[_0xdb56[3]][a], b[_0xdb56[7]]) {
            case 1: handle(b); continue;
            case 2: skip(b); continue;
          }
          break;
        }
      }`,
    );
  });

  it('leaves a while(true) whose switch is driven by a real value alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `while (true) {
        switch (queue.shift()) {
          case 'a': a(); continue;
          case 'b': b(); continue;
        }
        break;
      }`,
    );
  });

  it('leaves a prefix-increment index alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `function f() {
        var order = '0|1'.split('|'), i = 0;
        while (true) {
          switch (order[++i]) {
            case '0': first(); continue;
            case '1': second(); continue;
          }
          break;
        }
      }`,
    );
  });

  it('leaves a loop whose body carries extra statements alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `function f() {
        var order = '0|1'.split('|'), i = 0;
        while (true) {
          tick();
          switch (order[i++]) {
            case '0': first(); continue;
            case '1': second(); continue;
          }
          break;
        }
      }`,
    );
  });

  it('leaves a loop with no trailing break alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `function f() {
        var order = '0|1'.split('|'), i = 0;
        while (true) {
          switch (order[i++]) {
            case '0': first(); continue;
            case '1': return;
          }
        }
      }`,
    );
  });

  it('leaves a conditional loop alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      `function f() {
        var order = '0|1'.split('|'), i = 0;
        while (i < 2) {
          switch (order[i++]) {
            case '0': first(); continue;
            case '1': second(); continue;
          }
          break;
        }
      }`,
    );
  });

  it('leaves an ordinary for loop alone', async () => {
    await expectNoChange(
      unflattenControlFlowPass,
      'for (var i = 0; i < items.length; i++) { visit(items[i]); }',
    );
  });
});

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

describe('structure.control-flow: stability', () => {
  it('is idempotent on a recovered dispatcher', async () => {
    await expectIdempotent(
      unflattenControlFlowPass,
      fn(
        dispatcher(
          '2|0|1',
          `case '0': b(); continue;
           case '1': c(); continue;
           case '2': var a = start(); continue;`,
        ),
      ),
    );
  });

  it('is idempotent on a nested dispatcher', async () => {
    await expectIdempotent(
      unflattenControlFlowPass,
      fn(`var o1 = '1|0'.split('|'), i1 = 0;
        while (true) {
          switch (o1[i1++]) {
            case '0': outerLast(); continue;
            case '1':
              var o2 = '0|1'.split('|'), i2 = 0;
              while (true) {
                switch (o2[i2++]) {
                  case '0': innerFirst(); continue;
                  case '1': innerLast(); continue;
                }
                break;
              }
              continue;
          }
          break;
        }`),
    );
  });

  it('is idempotent on a dispatcher it refuses', async () => {
    await expectIdempotent(
      unflattenControlFlowPass,
      fn(
        dispatcher(
          '0|1',
          `case '0': first(); break;
           case '1': second(); continue;`,
        ),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Equivalence, checked by running the code rather than by reading it
// ---------------------------------------------------------------------------

/**
 * Run a snippet's `f` and report the trace it logged plus what it returned.
 *
 * A dynamic import rather than `eval` or `new Function`: the engine never
 * executes its input, and these snippets are written here in the test file, so
 * running them keeps that invariant intact while giving the strongest evidence
 * available that a recovered dispatcher does what the original did.
 */
async function observe(code: string): Promise<{ log: string[]; result: unknown }> {
  const module = (await import(
    `data:text/javascript,${encodeURIComponent(
      `const trace = [];
       function log(message) { trace.push(message); }
       ${code}
       export default () => ({ trace, result: f() });`,
    )}`
  )) as { default: () => { trace: string[]; result: unknown } };
  const { trace, result } = module.default();
  return { log: trace, result };
}

const BEHAVIOURAL_CASES: Array<[string, string]> = [
  [
    'out-of-order dispatch',
    fn(`var order = '3|0|4|1|2'.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': log('b'); continue;
          case '1': log('c'); continue;
          case '2': log('d'); return 'end';
          case '3': log('a'); continue;
          case '4': log('e'); continue;
        }
        break;
      }`),
  ],
  [
    'var hoisting across dispatch order',
    fn(`var order = '1|0'.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': var a = 1; log('a=' + a); continue;
          case '1': var b = a; log('b=' + b); continue;
        }
        break;
      }
      return a + ':' + b;`),
  ],
  [
    'nested dispatchers',
    fn(`var o1 = '1|0'.split('|'), i1 = 0;
      while (true) {
        switch (o1[i1++]) {
          case '0': log('outerLast'); continue;
          case '1':
            var o2 = '1|0'.split('|'), i2 = 0;
            while (true) {
              switch (o2[i2++]) {
                case '0': log('innerLast'); continue;
                case '1': log('innerFirst'); continue;
              }
              break;
            }
            continue;
        }
        break;
      }
      return 'done';`),
  ],
  [
    'a nested loop keeping its own continue',
    fn(`var order = '1|0'.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': log('after'); continue;
          case '1':
            for (var k = 0; k < 4; k++) { if (k % 2) continue; log('k' + k); }
            continue;
        }
        break;
      }
      return 'ok';`),
  ],
  [
    'a label declared inside a case body',
    fn(`var order = '0|1'.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': inner: for (var k = 0; k < 5; k++) { if (k === 2) break inner; log('k' + k); } continue;
          case '1': log('tail'); continue;
        }
        break;
      }
      return 'ok';`),
  ],
  [
    'a nested switch keeping its own break',
    fn(`var order = '0|1'.split('|'), i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': switch (3) { case 3: log('three'); break; default: log('other'); } continue;
          case '1': log('done'); continue;
        }
        break;
      }
      return 'ok';`),
  ],
  [
    'a throwing case',
    fn(`var order = '0|1'.split('|'), i = 0;
      try {
        while (true) {
          switch (order[i++]) {
            case '0': log('check'); continue;
            case '1': throw new Error('boom');
          }
          break;
        }
      } catch (error) { log('caught ' + error.message); return 'caught'; }`),
  ],
];

describe('structure.control-flow: behaviour is preserved when run', () => {
  for (const [name, source] of BEHAVIOURAL_CASES) {
    it(`preserves ${name}`, async () => {
      const before = await observe(source);
      const { code, changes } = await run(source);
      expect(changes).toBeGreaterThan(0);
      const after = await observe(code);
      expect(after.log).toEqual(before.log);
      expect(after.result).toEqual(before.result);
    });
  }
});

describe('structure.control-flow: reporting', () => {
  /**
   * The inner dispatcher's order array is declared in a *sibling* case of the
   * outer one, so on the first round it is not provably in scope before the
   * loop that reads it. Linearising the outer dispatcher puts the two in one
   * statement list and the second round recovers the inner one - which is the
   * shape of every real refusal: provisional, and resolved by a later pass.
   */
  const twoRounds = fn(`var order = '0|1'.split('|'), i = 0;
    while (true) {
      switch (order[i++]) {
        case '0':
          var inner = '1|0'.split('|'), j = 0;
          continue;
        case '1':
          while (true) {
            switch (inner[j++]) {
              case '0': second(); continue;
              case '1': first(); continue;
            }
            break;
          }
          continue;
      }
      break;
    }`);

  it('withdraws a refusal once a later round recovers the same dispatcher', async () => {
    const { code, ctx } = await run(twoRounds);

    expectEquivalent(code, 'function f() { first(); second(); }');
    // Both dispatchers were recovered, so nothing is left to warn about. Leaving
    // the first round's refusal in the report is what makes a dispatcher that
    // was recovered indistinguishable from one that was given up on.
    expect(ctx.diagnostics.filter((d) => d.source === 'structure.control-flow')).toHaveLength(0);
    expect(ctx.detections.filter((d) => d.evidence.includes('not recovered'))).toHaveLength(0);
    expect(ctx.detections.filter((d) => d.kind === 'control-flow-flattening')).toHaveLength(2);
  });

  it('still reports a refusal that no later round takes back', async () => {
    const source = fn(`var order = window.plan, i = 0;
      while (true) {
        switch (order[i++]) {
          case '0': first(); continue;
          case '1': second(); continue;
        }
        break;
      }`);
    const { ctx } = await run(source);
    const notes = ctx.diagnostics.filter((d) => d.source === 'structure.control-flow');
    expect(notes).toHaveLength(1);
    const refusal = ctx.detections.find((d) => d.evidence.includes('not recovered'));
    expect(refusal?.count).toBe(1);
  });
});

describe('structure.control-flow on the real fixtures', () => {
  it.skipIf(!FIXTURE.present)('makes zero changes on lightly-obfuscated.js, which has no flattening', async () => {
    const source = FIXTURE.read();
    const started = Date.now();
    const { code, changes, ctx } = await run(source);
    const elapsed = Date.now() - started;
    // The fixture's 19 switches are real application logic on real
    // discriminants. A single false positive here would silently reorder game
    // code, so this is the load-bearing assertion of the whole suite.
    expect(changes).toBe(0);
    expect(ctx.diagnostics).toHaveLength(0);
    expect(ctx.detections.filter((d) => d.kind === 'control-flow-flattening')).toHaveLength(0);
    assertParses(code);
    console.log(`structure.control-flow: ${changes} changes in ${elapsed}ms`);
  });

  it.skipIf(!BIG_FIXTURE.present)('finds every dispatcher in obfuscated2.js and refuses each exactly once', async () => {
    const source = BIG_FIXTURE.read();
    const { code, changes, ctx } = await run(source);
    const notes = ctx.diagnostics.filter((d) => d.source === 'structure.control-flow');

    // Run in isolation the eight order strings are still RC4-encoded, so every
    // dispatcher is correctly refused rather than guessed at. Recovery needs
    // the strings stage first, which the fixpoint loop supplies in a full run.
    expect(changes).toBe(0);
    expect(notes).toHaveLength(8);
    expect(new Set(notes.map((d) => d.loc?.line)).size).toBe(8);
    expect(notes.every((d) => d.message.includes('not statically resolvable'))).toBe(true);
    assertParses(code);
  }, 60_000);
});
