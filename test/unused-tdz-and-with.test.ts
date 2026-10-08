import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { runPass } from './helpers.js';

/**
 * Two ways a purity oracle answers "yes" about an expression that is not inert.
 *
 * Both are behavioural: the assertion is what the program printed, not what the
 * output text looks like, because the defect these pin is output that parses,
 * runs, and computes something else.
 *
 * The first is the temporal dead zone. `undefined` is a bindable name, and
 * `let undefined = 1` puts every read of it earlier in the block into a TDZ
 * where the read throws. An `Identifier` arm that answers "safe" from the name
 * alone, before asking whether the binding is initialised, deletes that throw.
 *
 * The second is `with`. Inside `with (o)` a name is looked up on `o` first, at
 * run time, so `var x = init` is not necessarily a local write: when `o` has an
 * `x`, the declarator's assignment is a PROPERTY WRITE to `o` and is live even
 * though nothing reads the binding.
 */

/** Run a program in a fresh realm and return everything it made observable. */
function execute(code: string): string {
  const trace: string[] = [];
  const LOG = (...args: unknown[]): void => {
    trace.push(args.map((value) => String(value)).join(' '));
  };
  const context = vm.createContext({ LOG });
  try {
    vm.runInContext(code, context, { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join('|');
}

async function expectSameBehaviour(source: string, expected: string): Promise<string> {
  const before = execute(source);
  expect(before).toBe(expected);
  const { code } = await deobfuscate(source, { preset: 'balanced' });
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n  input trace:  ${before}\n  output trace: ${after}\n  output code:  ${code}`,
    );
  }
  return code;
}

describe('reading `undefined` inside its own binding’s TDZ throws', () => {
  // `var dead` is unread, so the pass wants the declarator gone; the read of
  // `undefined` in its initialiser is the whole observable behaviour.
  const unreadInitialiser = [
    'function f() {',
    '  try {',
    '    var dead = undefined;',
    '    let undefined = 1;',
    "    LOG('no throw');",
    '  } catch (e) {',
    "    LOG('threw ' + e.constructor.name);",
    '  }',
    '}',
    'f();',
  ].join('\n');

  it('keeps an unread initialiser that is a TDZ read of `undefined` (whole pipeline)', async () => {
    await expectSameBehaviour(unreadInitialiser, 'threw ReferenceError');
  });

  it('keeps it in `clean.unused` alone', async () => {
    const { code } = await runPass(removeUnusedPass, unreadInitialiser);
    expect(execute(code)).toBe('threw ReferenceError');
  });

  // The same oracle in the other file: a wrapper that ignores its parameter
  // lets the expansion throw the argument away, and that argument throws.
  const discardedArgument = [
    "function w(a) { return 'ok'; }",
    'function f() {',
    '  try {',
    '    LOG(w(undefined));',
    '    let undefined = 1;',
    '  } catch (e) {',
    "    LOG('threw ' + e.constructor.name);",
    '  }',
    '}',
    'f();',
  ].join('\n');

  it('keeps a discarded argument that is a TDZ read of `undefined` (whole pipeline)', async () => {
    await expectSameBehaviour(discardedArgument, 'threw ReferenceError');
  });

  it('keeps it in `simplify.proxyFunctions` alone', async () => {
    const { code } = await runPass(inlineProxyFunctionsPass, discardedArgument);
    expect(execute(code)).toBe('threw ReferenceError');
  });

  it('still deletes an unread `undefined` initialiser where nothing binds the name', async () => {
    const { code } = await runPass(removeUnusedPass, 'function f() { var dead = undefined; }\nf();');
    expect(code).not.toContain('dead');
  });
});

describe('an unused binding declared inside `with` cannot be dropped', () => {
  // `o.x` exists, so `x = side()` writes the property, not the binding.
  const propertyWrite = [
    'var obj = { x: 0 };',
    'function side() { return 5; }',
    'function f(o) { with (o) { var x = side(); } }',
    'f(obj);',
    "LOG('obj.x=' + obj.x);",
  ].join('\n');

  it('keeps the declarator whose initialiser is impure (whole pipeline)', async () => {
    await expectSameBehaviour(propertyWrite, 'obj.x=5');
  });

  it('keeps it in `clean.unused` alone', async () => {
    const { code } = await runPass(removeUnusedPass, propertyWrite);
    expect(execute(code)).toBe('obj.x=5');
  });

  // The pure-initialiser shape is the same hazard: the write still lands on the
  // object, and only the name lookup was ever what made the initialiser look
  // droppable.
  const pureInitialiser = [
    'var obj = { x: 0 };',
    'function f(o) { with (o) { var x = 7; } }',
    'f(obj);',
    "LOG('obj.x=' + obj.x);",
  ].join('\n');

  it('keeps a declarator with a side-effect-free initialiser (whole pipeline)', async () => {
    await expectSameBehaviour(pureInitialiser, 'obj.x=7');
  });

  it('keeps it in `clean.unused` alone', async () => {
    const { code } = await runPass(removeUnusedPass, pureInitialiser);
    expect(execute(code)).toBe('obj.x=7');
  });

  it('still deletes an unused binding in a program whose `with` is elsewhere', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      'function g(o) { with (o) { LOG(k); } }\nfunction h() { var dead = 1; }\nh();',
    );
    expect(code).not.toContain('dead');
  });
});
