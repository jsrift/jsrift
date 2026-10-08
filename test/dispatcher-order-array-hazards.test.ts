import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { normalize, runPass } from './helpers.js';

/**
 * Two questions `analysis/dispatcher.ts` asks about one expression, and the one
 * assumption both of them are answered under.
 *
 * The order array is the only thing standing between a flattened `switch` and
 * straight-line code, so everything the analysis believes about it is
 * load-bearing twice over: once to READ the execution order, and once to decide
 * that BUILDING the array was unobservable and the declaration can go.
 *
 * For `'1|0'.split('|')` - the spelling every obfuscator emits - both answers
 * come from the same place: `String.prototype.split` is the one the
 * specification defines. The read spends it outright (the order is computed with
 * this process's `split`), so the deletion is entitled to spend it too, which it
 * does by name through the purity oracle's `assumeNativeBuiltins`. What the
 * assumption would cost is measured below rather than described, in both
 * directions: a `split` that logs and delegates would lose its log, and a
 * `split` that returns a different array would make the order itself wrong.
 * Refusing the DELETION bought only the first and could not buy the second at
 * any price, so the refusal is not there - it is on the READ, gated on the
 * whole-file fact that this program replaces `split` at all. Every file that
 * leaves the intrinsic alone, which is every real one, pays nothing for it.
 *
 * Every case below is executed in a fresh realm before and after the rewrite,
 * because a structural assertion cannot separate a correct recovery from one
 * that computes a different program: both parse, both run.
 */

/** Execute in a fresh realm; the *kind* of failure is part of the trace. */
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log, console: { log } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}`);
  }
  return trace.join(' | ');
}

async function expectSameBehaviour(
  source: string,
  options: Parameters<typeof runPass>[2] = {},
): Promise<string> {
  const before = execute(source);
  const { code } = await runPass(unflattenControlFlowPass, source, options);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
  return code;
}

/** `case '0'` logs 'a' and `case '1'` logs 'b', so the trace names the order. */
function machine(orderInit: string): string {
  return `var order = ${orderInit}, state = 0;
    while (true) {
      switch (order[state++]) {
        case '0': log('a'); continue;
        case '1': log('b'); continue;
      }
      break;
    }`;
}

// ---------------------------------------------------------------------------
// Deleting the order array: one assumption, spent twice on one call
// ---------------------------------------------------------------------------

describe('the order array is deleted under the assumption its order was read under', () => {
  /**
   * The wrapper delegates, so the recovered order is still correct and the ONLY
   * thing at stake is the call itself. That is what makes it the right probe for
   * the deletion question: it isolates it from the separate question of what
   * `split` returns, which the residual at the bottom of this file probes
   * instead.
   */
  const delegating = `var real = String.prototype.split;
String.prototype.split = function (sep) {
  log('POISON');
  return real.call(this, sep);
};
function f() {
    ${machine(`'1|0'.split('|')`)}
}
f();`;

  it('refuses the dispatcher outright on a program that replaced split', async () => {
    // The assumption is spent on every file that leaves `split` alone and on no
    // file that does not: `replacesSplit` is the whole-file fact, asked only
    // when the order array is spelled through a `.split(...)` call. Here it keeps
    // the wrapper's log, which the deletion used to drop.
    expect(execute(delegating)).toBe('POISON | b | a');
    const { code } = await runPass(unflattenControlFlowPass, delegating);
    expect(code).toContain('split(');
    expect(execute(code)).toBe('POISON | b | a');
  });

  it('control: on a program that leaves the intrinsics alone, nothing is lost at all', async () => {
    // Same machine, no wrapper: this is what every real input looks like, and
    // here the deleted call was genuinely unobservable.
    const clean = `function f() {
    ${machine(`'1|0'.split('|')`)}
}
f();`;
    const code = await expectSameBehaviour(clean);
    expect(code).not.toContain('switch');
    expect(code).not.toContain('split');
    expect(normalize(code)).toContain("log('b');log('a');");
    // The counter is retired by the same decision, as it always was.
    expect(code).not.toContain('state');
  });

  it('holds through the whole pipeline at balanced, where the pass is on by default', async () => {
    const clean = `function f() {
    ${machine(`'1|0'.split('|')`)}
}
f();`;
    const before = execute(clean);
    const { code } = await deobfuscate(clean, { preset: 'balanced' });
    expect(execute(code)).toBe(before);
    expect(code).not.toContain('switch');
    expect(code).not.toContain('split');
  });

  it('control: an array-literal order array is still deleted outright', async () => {
    const source = `function f() {
    ${machine(`['1', '0']`)}
}
f();`;
    const code = await expectSameBehaviour(source);
    expect(code).not.toContain('order');
    expect(normalize(code)).toContain("log('b');log('a');");
  });

  it('the shared oracle is also wider: a signed-numeric element no longer blocks the delete', async () => {
    // `staticNumber` reads `-0` and `+1`, so an order array can legitimately
    // contain one. The private predicate had no `UnaryExpression` arm and so
    // kept a declaration that provably evaluates nothing. The LABEL still has to
    // be a plain literal - `literalKey` refuses `case -0:` - which is why the
    // entry is `-0` and the label is `0`.
    const source = `function f() {
  var order = [1, -0], state = 0;
  while (true) {
    switch (order[state++]) {
      case 0: log('a'); continue;
      case 1: log('b'); continue;
    }
    break;
  }
}
f();`;
    const code = await expectSameBehaviour(source);
    expect(code).not.toContain('order');
    expect(normalize(code)).toContain("log('b');log('a');");
  });

  it('and wider again: an order array reached through a constant name is now deleted', async () => {
    // `aggressiveDispatchers` follows the name to the literal to READ the order;
    // deleting `var order = src` is a separate claim, and reading an initialised
    // local binding is one the oracle can make. The private predicate had no
    // `Identifier` arm, so it kept the declaration.
    const source = `var src = ['1', '0'];
function f() {
    ${machine('src')}
}
f();`;
    const code = await expectSameBehaviour(source, { preset: 'aggressive' });
    expect(code).not.toContain('var order');
    expect(normalize(code)).toContain("log('b');log('a');");
  });

  /**
   * The half no rule about the DELETION could ever have reached.
   *
   * `resolveOrderEntries` computes the order with this process's own `split`, so
   * a `split` that returns a different array makes the recovered order wrong.
   * That is a claim about what the call RETURNS rather than about whether
   * running it is observable, and the engine used to emit straight-line code
   * that read correctly and ran its cases in the opposite sequence, with
   * `verified: true` and no diagnostic. One refusal on the READ, gated on the
   * whole-file fact, closes it and the log above together.
   */
  it('refuses a `split` that returns a different array rather than reversing the order', async () => {
    const substituting = `String.prototype.split = function () { return ['0', '1']; };
function f() {
    ${machine(`'1|0'.split('|')`)}
}
f();`;
    expect(execute(substituting)).toBe('a | b');
    const { code } = await runPass(unflattenControlFlowPass, substituting);
    expect(execute(code)).toBe('a | b');
  });

  // Through the public entry point as well, because that is where it was
  // measured: a pass-level refusal is worth nothing if the pipeline reaches the
  // same rewrite by another route.
  it('refuses it through deobfuscate() at balanced and aggressive too', async () => {
    const substituting = `String.prototype.split = function () { return ['0', '1']; };
function f() {
    ${machine(`'1|0'.split('|')`)}
}
f();`;
    expect(execute(substituting)).toBe('a | b');
    for (const preset of ['balanced', 'aggressive'] as const) {
      const { code } = await deobfuscate(substituting, { preset });
      expect(execute(code)).toBe('a | b');
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the order array: `with` makes every name a run-time lookup
// ---------------------------------------------------------------------------

describe('a dispatcher whose names resolve through a `with` object is refused', () => {
  /**
   * No aggressive arm involved and nothing exotic in the machine: the
   * dispatcher's OWN two names are looked up on the object first. With an
   * `order` accessor on it, the declarator's initialisation goes to the setter
   * and every dispatch reads the getter, so the array the analysis resolved was
   * never the array the program indexed.
   */
  const ownNames = `function f(o) {
  with (o) {
    ${machine(`'1|0'.split('|')`)}
  }
}
var sink = {};
f({
  get order() { return ['0', '1']; },
  set order(v) { sink.v = v; },
  state: 0
});`;

  it('refuses when the dispatcher itself is inside the `with`', async () => {
    expect(execute(ownNames)).toBe('a | b');
    const code = await expectSameBehaviour(ownNames, { preset: 'balanced' });
    expect(code).toContain('switch');
  });

  it('says so, rather than refusing silently', async () => {
    const { ctx } = await runPass(unflattenControlFlowPass, ownNames, { preset: 'balanced' });
    expect(ctx.diagnostics.map((d) => d.message).join('\n')).toContain('inside a `with`');
  });

  it('refuses the aggressive alias arm, which resolves a name to a literal', async () => {
    const source = `var src = ['1', '0'];
function f(o) {
  with (o) {
    ${machine('src')}
  }
}
f({ src: ['0', '1'] });`;
    expect(execute(source)).toBe('a | b');
    await expectSameBehaviour(source, { preset: 'aggressive' });
  });

  it('refuses the aggressive alias-map arm too', async () => {
    const source = `var m = { k: '1|0' };
function f(o) {
  with (o) {
    ${machine(`m.k.split('|')`)}
  }
}
f({ m: { k: '0|1' } });`;
    expect(execute(source)).toBe('a | b');
    await expectSameBehaviour(source, { preset: 'aggressive' });
  });

  it('refuses when only the FOLLOWED declaration sits under a `with`', async () => {
    // The loop is clear, so the whole-construct guard says nothing here. The
    // declaration is the second position: `var src = [...]` inside `with (host)`
    // stores into `host` and leaves the hoisted binding `undefined`, so the
    // program throws where the recovered order would have printed.
    const source = `var host = { src: ['0', '1'] };
with (host) { var src = ['1', '0']; }
function f() {
    ${machine('src')}
}
f();`;
    expect(execute(source)).toBe('THROWN TypeError');
    await expectSameBehaviour(source, { preset: 'aggressive' });
  });

  it('control: the same machine outside a `with` is still recovered', async () => {
    const source = `var src = ['1', '0'];
function f() {
    ${machine('src')}
}
f();`;
    const code = await expectSameBehaviour(source, { preset: 'aggressive' });
    expect(code).not.toContain('switch');
    expect(normalize(code)).toContain("log('b');log('a');");
  });
});
