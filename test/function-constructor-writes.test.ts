import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { functionConstructorPass } from '../src/passes/unpack/function-constructor.js';
import { assertParses, runPass } from './helpers.js';

/**
 * The scope refusal has to count what the recovered body WRITES, not only what
 * it reads.
 *
 * `Function("...")` compiles its body as a fresh top-level function, so an
 * unqualified name in it - on either side of an assignment - resolves against
 * the global scope. A function expression spliced into the call's position
 * resolves that name where it sits, so a binding between the call and the global
 * scope captures it. That is one divergence, not two: a read of the wrong `x`
 * and a write to the wrong `x` are the same mistake, and the second is the
 * quieter one, because the caller's own variable silently changes value while
 * the global the program meant to set never moves.
 *
 * Babel's `ReferencedIdentifier` reports the reads and not the writes - an
 * assignment target is not a reference to the name - so the write half of the
 * question had no guard at all. `x++` did have one, since an `UpdateExpression`
 * argument *does* count as referenced, which is exactly what made the gap look
 * covered.
 *
 * Every claim here about what a program does is executed rather than asserted,
 * in a fresh realm, and the pass runs alone so a divergence indicts it and not
 * something downstream.
 */

/** Run in a fresh realm and capture what the program makes observable. */
function execute(code: string): string {
  const trace: string[] = [];
  const sandbox: Record<string, unknown> = {
    log: (...args: unknown[]) => trace.push(args.map((a) => String(a)).join(' ')),
  };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join('\n');
}

/**
 * The pass must not change what the program does, and the expected trace is
 * spelled out rather than merely compared, so that a rewrite which breaks both
 * sides identically cannot pass.
 */
async function expectSameBehaviour(source: string, expected: string): Promise<string> {
  const before = execute(source);
  expect(before).toBe(expected);

  const { code } = await runPass(functionConstructorPass, source);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input  ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
  assertParses(code);
  return code;
}

const stillThere = (code: string): boolean => /\bFunction\s*\(/.test(code);

// ---------------------------------------------------------------------------
// Writes to a captured name
// ---------------------------------------------------------------------------

describe('unpack/function-constructor: a write is a use of the name too', () => {
  /**
   * The plain form. Before the write half of `freeNames` existed this was
   * rewritten with no diagnostic, and both observable values flipped: the
   * caller's `x` took the assignment and the global kept its old value.
   */
  it('refuses when a local binding would capture a name the body only assigns', async () => {
    const source = [
      `var x = 'global';`,
      `function f() { var x = 'local'; Function("x = 'written'")(); return x; }`,
      `log('f=' + f());`,
      `log('globalX=' + x);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'f=local\nglobalX=written');
    expect(stillThere(code)).toBe(true);
  });

  it('reports the captured name in the diagnostic', async () => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `function f() { var x = 'local'; Function("x = 'written'")(); return x; }`,
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('x'))).toBe(true);
  });

  /** A compound assignment reads *and* writes, and neither half was reported. */
  it('refuses on a compound assignment', async () => {
    const source = [
      `var n = 10;`,
      `function f() { var n = 1; Function('n += 5')(); return n; }`,
      `log('f=' + f());`,
      `log('globalN=' + n);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'f=1\nglobalN=15');
    expect(stillThere(code)).toBe(true);
  });

  it.each([
    ['logical assignment', 'n ||= 5'],
    ['nullish assignment', 'n ??= 5'],
    ['exponent assignment', 'n **= 2'],
    ['shift assignment', 'n >>>= 1'],
  ])('refuses on %s', async (_label, body) => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `function f() { var n = 1; Function(${JSON.stringify(body)})(); return n; }`,
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('n'))).toBe(true);
  });

  /**
   * A destructuring target holds the name inside a pattern, where
   * `ReferencedIdentifier` is doubly blind: `isReferenced` answers false for an
   * `ArrayPattern` element and for an `ObjectPattern` property value.
   */
  it('refuses on an array-pattern assignment target', async () => {
    const source = [
      `var a = 'global';`,
      `function f() { var a = 'local'; Function("[a] = ['written']")(); return a; }`,
      `log('f=' + f());`,
      `log('globalA=' + a);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'f=local\nglobalA=written');
    expect(stillThere(code)).toBe(true);
  });

  it('refuses on an object-pattern assignment target', async () => {
    const source = [
      `var b = 'global';`,
      `function f() { var b = 'local'; Function("({ b } = { b: 'written' })")(); return b; }`,
      `log('f=' + f());`,
      `log('globalB=' + b);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'f=local\nglobalB=written');
    expect(stillThere(code)).toBe(true);
  });

  it.each([
    ['renamed object property', "({ v: c } = { v: 1 })"],
    ['rest element', '[...c] = [1, 2]'],
    ['pattern default', '[c = 1] = []'],
    ['nested pattern', '({ v: [c] } = { v: [1] })'],
  ])('refuses on a %s', async (_label, body) => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `function f() { var c = 0; Function(${JSON.stringify(body)})(); return c; }`,
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('c'))).toBe(true);
  });

  /**
   * `for (... of ...)` assigns without an assignment expression to hang the target
   * off, so the loop head needs reading on its own.
   */
  it('refuses on a for-of head that assigns to an existing name', async () => {
    const source = [
      `var k = 'global';`,
      `function f() { var k = 'local'; Function("for (k of ['written']);")(); return k; }`,
      `log('f=' + f());`,
      `log('globalK=' + k);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'f=local\nglobalK=written');
    expect(stillThere(code)).toBe(true);
  });

  it.each([
    ['for-of pattern head', "for ([k] of [['written']]);"],
    ['for-in head', "for (k in { written: 1 });"],
    ['for-in pattern head', "for ([k] in { ab: 1 });"],
  ])('refuses on a %s', async (_label, body) => {
    const { changes, ctx } = await runPass(
      functionConstructorPass,
      `function f() { var k = 'local'; Function(${JSON.stringify(body)})(); return k; }`,
    );

    expect(changes).toBe(0);
    expect(ctx.diagnostics.some((d) => d.message.includes('k'))).toBe(true);
  });

  /**
   * The one write form that was already caught, kept here so a later
   * simplification of `freeNames` cannot quietly drop it: an `UpdateExpression`
   * argument counts as referenced, so `c++` never had the hole its siblings did.
   */
  it('still refuses on an update expression', async () => {
    const source = [
      `var c = 1;`,
      `function f() { var c = 100; Function('c++')(); return c; }`,
      `log('f=' + f());`,
      `log('globalC=' + c);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'f=100\nglobalC=2');
    expect(stillThere(code)).toBe(true);
  });

  // -- The other side of the guard: it must not refuse what it can prove. ----

  /**
   * A write nothing in between binds still reaches the global from either
   * position, so the wrapper is opened. This is the case the refusal must not
   * swallow, and the reason the guard asks which names are bound rather than
   * whether the body writes at all.
   */
  it('opens a wrapper whose write no enclosing scope captures', async () => {
    const source = [
      `function f() { var unrelated = 1; Function("written = 'yes'")(); return unrelated; }`,
      `log('f=' + f());`,
      `log('global=' + typeof written);`,
    ].join('\n');

    const { code, changes } = await runPass(functionConstructorPass, source);
    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
    await expectSameBehaviour(source, 'f=1\nglobal=string');
  });

  /** A write to a name the body itself binds is not free at all. */
  it('opens a wrapper that assigns to its own local', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `function f() { var x = 1; return Function('var x; x = 2; return x')(); }`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
  });

  /** A parameter of the recovered function binds its name too. */
  it('opens a wrapper that assigns to its own parameter', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `function f() { var x = 1; return Function('x', 'x = 2; return x')(9); }`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
  });

  /**
   * `o.x = 1` writes a property, not a binding. The only name resolved is `o`,
   * which the read half already reports, so the member-expression form must not
   * start refusing over the property name.
   */
  it('does not treat a property write as a name the body assigns', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `function f() { var x = 1; return Function('host.x = 2')(); }`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `with`
// ---------------------------------------------------------------------------

/**
 * A `with` between the call and the global scope is the same divergence arriving
 * by another route: the object environment it pushes is not a set of bindings
 * the scope analysis can enumerate, so walking enclosing scopes cannot see it,
 * and any free name of the body may be answered by a property of the object at
 * run time instead of by the global.
 */
describe('unpack/function-constructor: an enclosing `with` can answer any free name', () => {
  it('refuses at program scope, where there is no enclosing binding to find', async () => {
    const source = [
      `var x = 'global';`,
      `with ({ x: 'from with' }) { log(Function('return x')()); }`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'global');
    expect(stillThere(code)).toBe(true);
  });

  it('refuses on a write the `with` object would absorb', async () => {
    const source = [
      `var x = 'global';`,
      `var o = { x: 'from with' };`,
      `with (o) { Function("x = 'written'")(); }`,
      `log('o=' + o.x);`,
      `log('global=' + x);`,
    ].join('\n');

    const code = await expectSameBehaviour(source, 'o=from with\nglobal=written');
    expect(stillThere(code)).toBe(true);
  });

  /** The head is evaluated in the enclosing scope, so it is not affected. */
  it('opens a wrapper in the head of the `with`, which is outside its object', async () => {
    const { code, changes } = await runPass(
      functionConstructorPass,
      `with (Function('return { a: 1 }')()) { log(a); }`,
    );

    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
  });

  /** With no free name there is nothing for the object to intercept. */
  it('opens a wrapper inside `with` whose body has no free names', async () => {
    const source = `with ({ x: 1 }) { log(Function('return 41 + 1')()); }`;

    const { code, changes } = await runPass(functionConstructorPass, source);
    expect(changes).toBe(1);
    expect(stillThere(code)).toBe(false);
    await expectSameBehaviour(source, '42');
  });
});
