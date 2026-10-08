import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { expectNoChange, runPass } from './helpers.js';

/**
 * The two purity oracles that decide whether an expression may be deleted.
 *
 * `src/passes/clean/unused.ts` and `src/passes/simplify/proxy-functions.ts`
 * each carry an `isSideEffectFree`/`isPrimitiveValued` pair, and each uses it to
 * throw an expression away: the first drops the initialiser of a name nothing
 * reads, the second drops an argument the expansion has no parameter for. Every
 * case below is a program whose observable behaviour those oracles changed -
 * a throw that stopped happening, a `valueOf` that stopped being called, a
 * binding that string code still addressed by name after it was deleted.
 *
 * Written behaviourally on purpose. A structural assertion ("the output still
 * contains `b + 1`") passes for the wrong reason as soon as some other pass
 * rewrites the shape; running both programs and comparing what they emit is the
 * only check that indicts the actual failure, which is output that parses, runs
 * and computes something else.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run a program in a fresh realm and return everything it made observable.
 *
 * The realm is deliberately browser-shaped in two ways the string-code cases
 * need. `window` is the global object, so `window.eval(src)` is a real indirect
 * eval that compiles in this realm's global scope. And `setTimeout`/
 * `setInterval` accept a source STRING and compile it there too, which is what
 * a browser does and what Node's own timers do not - without it those cases
 * would throw in both runs and assert nothing.
 */
function execute(code: string): string {
  const trace: string[] = [];
  const LOG = (...args: unknown[]): void => {
    trace.push(args.map((value) => String(value)).join(' '));
  };
  const sandbox: Record<string, unknown> = { LOG };
  const context = vm.createContext(sandbox);
  const runSource = (source: unknown): void => {
    if (typeof source === 'string') vm.runInContext(source, context, { timeout: 5_000 });
  };
  sandbox['setTimeout'] = runSource;
  sandbox['setInterval'] = runSource;
  try {
    vm.runInContext('var window = globalThis;', context);
    vm.runInContext(code, context, { timeout: 5_000 });
  } catch (error) {
    // The kind of throw is part of the behaviour: a TypeError that stops
    // happening and a ReferenceError that starts are both what these look for.
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join('|');
}

/** Deobfuscate at the preset the fixture table is measured at, then compare traces. */
async function expectSameBehaviour(source: string): Promise<string> {
  const before = execute(source);
  const { code } = await deobfuscate(source, { preset: 'balanced' });
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n  input trace:  ${before}\n  output trace: ${after}\n  output code:  ${code}`,
    );
  }
  return code;
}

function behaviour(group: string, list: ReadonlyArray<readonly [string, string]>): void {
  describe(group, () => {
    for (const [name, source] of list) {
      it(name, async () => {
        await expectSameBehaviour(source);
      });
    }
  });
}

// ===========================================================================
// A BigInt is a primitive whose coercions still throw
// ===========================================================================

/**
 * `isPrimitiveValued` counted `BigIntLiteral` as primitive, which is true and
 * beside the point. A BigInt runs no `valueOf`, but mixing it with a Number
 * throws a TypeError, and `+b` and `b >>> 1` throw on any BigInt at all.
 * Deleting the expression deleted the throw, so the program ran on.
 */
describe('BigInt: deleting the expression deletes the throw', () => {
  behaviour('clean.unused drops an unread initialiser', [
    ['`b + 1` mixes BigInt with Number', "var b = 1n; var dead = b + 1; LOG('end');"],
    ['`b >>> 1` has no BigInt form at all', "var b = 1n; var dead = b >>> 1; LOG('end');"],
    ['`+b` is ToNumber on a BigInt', "var b = 1n; var dead = +b; LOG('end');"],
    // `-b` is legal on a BigInt and yields one, so the refusal has to come from
    // the operand rather than from the `UnaryExpression` wrapper, which
    // `isPrimitiveValued` accepts whatever it wraps.
    ['`-b + 1` hides the BigInt under a legal unary', "var b = 1n; var dead = -b + 1; LOG('end');"],
    ['a template substitution coerces', "var b = 1n; var dead = `${b * 2}`; LOG('end');"],
    ['an array element still evaluates', "var b = 1n; var dead = [b + 1]; LOG('end');"],
    ['a computed key still evaluates', "var b = 1n; var dead = { [b + 1]: 0 }; LOG('end');"],
    ['the literal needs no binding to reach', "var dead = 1n + 1; LOG('end');"],
  ]);

  behaviour('simplify.proxy-functions drops an argument it has no parameter for', [
    [
      'a discarded argument',
      "function w(a) { return 1; } var b = 1n; LOG(w(b + 1)); LOG('end');",
    ],
    [
      'a surplus argument',
      "function w() { return 1; } var b = 1n; LOG(w(b + 1)); LOG('end');",
    ],
  ]);

  it('clean.unused keeps the mixed arithmetic when it drops the name it fed', async () => {
    const { code } = await runPass(removeUnusedPass, 'var b = 1n; var dead = b + 1;');
    expect(code).toContain('b + 1');
  });

  it('simplify.proxy-functions refuses to discard a BigInt argument', async () => {
    await expectNoChange(
      inlineProxyFunctionsPass,
      'function w(a) { return 1; }\nvar b = 1n;\nsink(w(b + 1));',
    );
  });

  it('still deletes a BigInt literal that nothing coerces', async () => {
    const { code } = await runPass(removeUnusedPass, 'var dead = 1n;', { sourceType: 'module' });
    expect(code.trim()).toBe('');
  });
});

// ===========================================================================
// `undefined` is a bindable name, not a keyword
// ===========================================================================

/**
 * The `Identifier` arm short-circuited on the name `undefined`. In
 * `isSideEffectFree` that is a claim about throwing and it holds; in
 * `isPrimitiveValued` it is a claim about the VALUE's type, and `undefined` is
 * shadowable - a parameter or a `let` of that name holds whatever was passed,
 * including an object with a `valueOf`.
 */
describe('shadowed `undefined`: the name is not a type proof', () => {
  const coercible = "{ valueOf: function () { LOG('valueOf'); return 1; }, toString: function () { LOG('toString'); return 'x'; } }";

  behaviour('clean.unused drops an unread initialiser', [
    [
      'a parameter named `undefined`, read by `-`',
      `function f(undefined) { var dead = -undefined; LOG('after'); }\nf(${coercible});`,
    ],
    [
      'a parameter named `undefined`, read by a template',
      `function f(undefined) { var dead = \`\${undefined}\`; LOG('after'); }\nf(${coercible});`,
    ],
    [
      'a parameter named `undefined`, read by a computed key',
      `function f(undefined) { var dead = { [undefined]: 1 }; LOG('after'); }\nf(${coercible});`,
    ],
    [
      'a `let undefined` in a block',
      `{ let undefined = ${coercible}; var dead = -undefined; LOG('after'); }`,
    ],
  ]);

  behaviour('simplify.proxy-functions drops an argument it has no parameter for', [
    [
      'a discarded argument reading a shadowed `undefined`',
      `function w(a) { return 1; }\nfunction f(undefined) { LOG(w(-undefined)); LOG('after'); }\nf(${coercible});`,
    ],
  ]);

  it('still deletes `-undefined` where the name is the global one', async () => {
    const { code } = await runPass(removeUnusedPass, 'var dead = -undefined;', { sourceType: 'module' });
    expect(code.trim()).toBe('');
  });
});

// ===========================================================================
// `with` makes the literal-initialiser proof a fallback
// ===========================================================================

/**
 * `isPrimitiveBinding` proves a name primitive from the declarator
 * `scope.getBinding` reports. Inside a `with` body that binding is only what the
 * lookup falls back to: the `with` object is consulted first, at run time, and
 * it can answer with anything.
 */
describe('`with`: scope.getBinding is only the fallback', () => {
  const env = "var env = { n: { valueOf: function () { LOG('valueOf'); return 3; } } };";

  behaviour('clean.unused drops an unread initialiser', [
    [
      'the `with` object supplies `n`, not the `var n = 2` above it',
      `var n = 2;\n${env}\nwith (env) { var dead = n * 2; }\nLOG('end');`,
    ],
    [
      'and through a nested function inside the body',
      `var n = 2;\n${env}\nwith (env) { (function () { var dead = n * 2; })(); }\nLOG('end');`,
    ],
  ]);

  behaviour('simplify.proxy-functions drops an argument it has no parameter for', [
    [
      'a discarded argument resolved by the `with` object',
      `function w(a) { return 1; }\nvar n = 2;\n${env}\nwith (env) { LOG(w(n * 2)); }\nLOG('end');`,
    ],
  ]);

  it('still deletes the same initialiser outside the `with` body', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      'var n = 2;\nvar env = {};\nvar dead = n * 2;\nwith (env) { LOG(1); }',
      { sourceType: 'module' },
    );
    expect(code).not.toContain('dead');
  });
});

// ===========================================================================
// Code compiled from a string reads program-scope names
// ===========================================================================

/**
 * `clean.unused` recognised one construct that can reach a binding by its name,
 * a direct `eval` callee. `src/naming/allocate.ts`'s `freezeHazardKind` - which
 * the naming layer's own comment names as the owner of this hazard for the
 * pipeline - recognises the rest, and this pass now calls it rather than
 * restating it.
 *
 * The two act on the answer differently, because they act on different things:
 * the naming layer freezes scopes against renaming, this one refuses deletions.
 * A `'global'` hazard means string code compiled in global scope, which sees
 * program scope and nothing narrower, so program-scope bindings stay.
 */
describe('string code: a name the counter cannot see is still a use', () => {
  behaviour('clean.unused deletes what a source string still addresses', [
    ['`window.eval` is an indirect eval', "var _0x1b2c = 5; LOG(window.eval('_0x1b2c'));"],
    ['`(0, eval)` is the canonical spelling', "var _0x1b2c = 5; LOG((0, eval)('_0x1b2c'));"],
    [
      '`var e = eval` puts eval in a value position',
      "var _0x1b2c = 5; var _0xEV = eval; LOG(_0xEV('_0x1b2c'));",
    ],
    // Survives the hazard check being reverted too, because `simplify` rewrites
    // this one into a real function expression before `clean` runs and the
    // reference it leaves behind is an ordinary one. Kept as the control that
    // pins that rewrite: it is the only thing holding the binding here.
    [
      '`new Function` compiles in global scope',
      "var _0x1b2c = 5; LOG(new Function('return _0x1b2c')());",
    ],
    [
      '`setTimeout` with a source string',
      "function _0x4a68(){ LOG('called'); } setTimeout('_0x4a68()', 0);",
    ],
    [
      '`setInterval` with a source string',
      "function _0x4a68(){ LOG('called'); } setInterval('_0x4a68()', 0);",
    ],
  ]);

  it('freezes program scope and nothing narrower', async () => {
    // The hazard is global-scope string code, which cannot see a local binding.
    const { code } = await runPass(
      removeUnusedPass,
      "var _0x1b2c = 5;\nfunction f() { var _0xlocal = 7; return 1; }\nLOG(window.eval('_0x1b2c'), f());",
    );
    // The declaration, not the name: `'_0x1b2c'` is also a string in the source,
    // so a bare substring check would pass with the binding deleted.
    expect(code).toContain('var _0x1b2c = 5');
    expect(code).not.toContain('_0xlocal');
  });

  it('leaves a program with no string code alone', async () => {
    const { code } = await runPass(removeUnusedPass, 'var _0x1b2c = 5;\nLOG(1);', { sourceType: 'module' });
    expect(code).not.toContain('_0x1b2c');
  });
});
