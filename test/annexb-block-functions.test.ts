import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { removeAntiTamperPass } from '../src/passes/clean/anti-tamper.js';
import { removeDeadBranchesPass } from '../src/passes/clean/dead-branches.js';
import { removeInjectedCodePass } from '../src/passes/clean/injected-code.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { unwrapDiscardedArgumentsPass } from '../src/passes/simplify/discard-wrappers.js';
import { inlineProxyFunctionsPass } from '../src/passes/simplify/proxy-functions.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { pruneDecodersPass } from '../src/passes/strings/prune-decoders.js';
import {
  blockFunctionHoisting,
  blockFunctionOutsideUse,
  hoistedVarNames,
} from '../src/util/ast.js';
import { parseSource } from '../src/frontend/language.js';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * Annex B.3.3, closed once for every pass.
 *
 * A sloppy block-level `function` is two bindings: the block's, which Babel
 * records, and a `var` of the enclosing function or script, assigned when the
 * block runs, which Babel records nowhere. Every pass that deletes, replaces,
 * hoists or inlines such a declaration from what Babel lists - or that
 * reconstructs the var for a branch it deleted - had its own copy of the
 * decision, each wrong in its own way, and the differential fuzz found two of
 * them: `simplify.proxy-functions` deleted a block function whose var was
 * called outside the block, and `clean.dead-branches` wrote `var f;` for a
 * function that hoisted nothing, beside a `let f` (a SyntaxError) and under
 * `'use strict'` (a call of `undefined`).
 *
 * The decision now lives in `util/ast.ts` - `blockFunctionHoisting`,
 * `blockFunctionOutsideUse`, `hoistedVarNames` - and this file executes every
 * shape at every preset, input against output, plus one pass at a time so a
 * regression indicts the pass and not the pipeline.
 */

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
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(' | ');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

async function expectSameBehaviour(source: string, expected: string): Promise<void> {
  const before = execute(source);
  expect(before).toBe(expected);
  for (const preset of PRESETS) {
    const { code } = await deobfuscate(source, { preset });
    const after = execute(code);
    if (after !== before) {
      throw new Error(
        `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
      );
    }
  }
}

async function expectPassKeepsBehaviour(pass: Parameters<typeof runPass>[0], source: string): Promise<string> {
  const { code } = await runPass(pass, source);
  expect(execute(code), code).toBe(execute(source));
  return code;
}

// ---------------------------------------------------------------------------
// F1: a block function whose hoisted var is called outside the block
// ---------------------------------------------------------------------------

const F1_TAIL = `try { log(typeof bf, bf()); } catch (e) { log('blockfn', e.name); }`;
const F1 = {
  block: `{ function bf(){ var o={k:'inner'}; return o.k; } log(bf()); }\n${F1_TAIL}`,
  case: `switch (1) { case 1: function bf(){ var o={k:'inner'}; return o.k; } log(bf()); }\n${F1_TAIL}`,
  label: `{ l: function bf(){ var o={k:'inner'}; return o.k; } log(bf()); }\n${F1_TAIL}`,
  if: `if (true) function bf(){ var o={k:'inner'}; return o.k; }\nlog(bf());\n${F1_TAIL}`,
};

describe('F1: a block function called through its hoisted var', () => {
  for (const [spelling, source] of Object.entries(F1)) {
    it(`keeps the declaration in the ${spelling} spelling`, async () => {
      await expectSameBehaviour(source, 'inner | function inner');
    });
  }

  it('simplify.proxy-functions expands the calls inside the block and keeps the declaration', async () => {
    const code = await expectPassKeepsBehaviour(inlineProxyFunctionsPass, F1.block.replace('var o={k:\'inner\'}; return o.k;', "return 'inner';"));
    expect(code).toContain("log('inner')");
    expect(code).toContain('function bf()');
  });

  it('simplify.proxy-functions still deletes a block function nothing outside the block names', async () => {
    const source = `function h(){ { function bf(){ return 'inner'; } log(bf()); } return 1; } h();`;
    const code = await expectPassKeepsBehaviour(inlineProxyFunctionsPass, source);
    expect(code).not.toContain('function bf');
  });

  it('clean.unused keeps a block function whose name occurs outside its block', async () => {
    const source = `function h(){ { function f(){ return 'x'; } } return f(); } log(h());`;
    const code = await expectPassKeepsBehaviour(removeUnusedPass, source);
    expect(code).toContain('function f()');
  });

  it('clean.unused still deletes a block function that is blocked from hoisting', async () => {
    // `let f` at the function top blocks the var, so the block binding is the
    // only one and nothing reads it.
    const source = `function h(){ let f = 'y'; { function f(){ return 'x'; } } return f; } log(h());`;
    const code = await expectPassKeepsBehaviour(removeUnusedPass, source);
    expect(code).not.toContain('function f');
  });

  it('clean.unused keeps a block function hoisted to the top of a script, like any global', async () => {
    // `Function('...')` reads the var by name; the block's binding is below
    // program scope and the program-scope refusals did not see it.
    const spelled = `{ function helper(){ return 1; } }
log(Function('return typeof helper')());`;
    await expectSameBehaviour(spelled, 'function');
    expect(await expectPassKeepsBehaviour(removeUnusedPass, spelled)).toContain('function helper');
    // And without a reader in the file, for the reason every other top-level
    // declaration of a script is kept: the next script tag may be one.
    const bare = `{ function helper(){ return 1; } }
log(1);`;
    expect(await expectPassKeepsBehaviour(removeUnusedPass, bare)).toContain('function helper');
    // Inside a function the var is the function's own, and it goes.
    const local = `function h(){ { function helper(){ return 1; } } return 1; }
log(h());`;
    expect(await expectPassKeepsBehaviour(removeUnusedPass, local)).not.toContain('function helper');
  });

  it('strings.prune-decoders keeps a block-level decoder its hoisted var still calls', async () => {
    const source = `var A = ['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa'];
{ function dec(i) { return A[i]; } log(dec(0)); }
log(dec(1));`;
    await expectSameBehaviour(source, 'alpha | beta');
    const { code } = await runPass([discoverStringsPass, inlineStringsPass, pruneDecodersPass], source);
    expect(execute(code)).toBe('alpha | beta');
    expect(code).toContain('function dec');
  });

  it('clean.anti-tamper leaves a block-level trap whose name is read outside the block', async () => {
    const source = `{ function t(n){ try { if (n) { return function(){}.constructor('debugger').call('action'); } t(0); } catch(e) {} } }\nlog(typeof t);`;
    await expectSameBehaviour(source, 'function');
    const code = await expectPassKeepsBehaviour(removeAntiTamperPass, source);
    expect(code).toContain('function t(');
  });
});

// ---------------------------------------------------------------------------
// F2: a deleted branch whose function hoisted no var
// ---------------------------------------------------------------------------

const F2 = {
  strict: `function h(){ 'use strict'; if (false) { function log(){} } return log('in h'); } h();`,
  let: `let bf = 1; { if (false) { function bf(){} } } log(bf);`,
  param: `function h(f){ if (false) { function f(){} } return f; } log(h(7));`,
  generator: `function h(){ if (false) { function* f(){} } try { return f; } catch (e) { return e.name; } } log(h());`,
  catchPattern: `function h(){ if (false) { try {} catch ({f}) { { function f(){} } } } try { return f; } catch (e) { return e.name; } } log(h());`,
  forLet: `function h(){ if (false) { for (let f of []) { function f(){} } } try { return f; } catch (e) { return e.name; } } log(h());`,
  while: `function h(){ let f = 2; while (false) { function f(){} } return f; } log(h());`,
  for: `function h(){ let f = 3; for (;false;) { function f(){} } return f; } log(h());`,
  unreachable: `function h(){ let f = 1; return f; { function f(){} } } log(h());`,
  injectedIf: `function h(){ let f = 5; if ('a' === 'b') { function f(){} } return f; } log(h());`,
  injectedIfStrict: `function h(){ 'use strict'; if ('a' === 'b') { function f(){} } try { return f; } catch (e) { return e.name; } } log(h());`,
  injectedSwitch: `function h(){ let f = 6; switch ('x') { case 'x': break; case 'y': function f(){} break; } return f; } log(h());`,
};
const F2_EXPECTED: Record<keyof typeof F2, string> = {
  strict: 'in h',
  let: '1',
  param: '7',
  generator: 'ReferenceError',
  catchPattern: 'ReferenceError',
  forLet: 'ReferenceError',
  while: '2',
  for: '3',
  unreachable: '1',
  injectedIf: '5',
  injectedIfStrict: 'ReferenceError',
  injectedSwitch: '6',
};

describe('F2: a deleted branch reconstructs only the vars its functions hoisted', () => {
  for (const [spelling, source] of Object.entries(F2)) {
    it(`writes no var for the ${spelling} spelling`, async () => {
      await expectSameBehaviour(source, F2_EXPECTED[spelling as keyof typeof F2]);
    });
  }

  it('clean.dead-branches still writes the var a sloppy function did hoist', async () => {
    for (const source of [
      `function h(){ if (false) { function f(){} } return f; } log(h());`,
      `function h(){ while (false) { function f(){} } return f; } log(h());`,
      `function h(){ for (;false;) { function f(){} } return f; } log(h());`,
      `function h(){ return typeof f; { function f(){} } } log(h());`,
    ]) {
      expect(execute(source)).toBe('undefined');
      const code = await expectPassKeepsBehaviour(removeDeadBranchesPass, source);
      expect(code).toContain('var f;');
      expect(code).not.toContain('function f');
    }
  });

  it('clean.dead-branches writes none for a strict, blocked or generator function', async () => {
    for (const source of [F2.strict, F2.let, F2.param, F2.generator, F2.catchPattern, F2.forLet, F2.while, F2.for, F2.unreachable]) {
      const code = await expectPassKeepsBehaviour(removeDeadBranchesPass, source);
      expect(code).not.toContain('var f;');
      expect(code).not.toContain('var log;');
      expect(code).not.toContain('var bf;');
    }
  });

  it('clean.dead-branches refuses the fold where the spec and V8 disagree', async () => {
    // A second `function f` in the same block, or one in an enclosing block: V8
    // hoists, the spec does not, and neither `var f;` nor its absence is right.
    for (const source of [
      `function h(){ if (false) { function f(){} function f(){} } return typeof f; } log(h());`,
      `function h(){ if (false) { function f(){} { function f(){} } } return typeof f; } log(h());`,
      `function h(){ if (false) if (true) function f(){}; return typeof f; } log(h());`,
    ]) {
      const code = await expectPassKeepsBehaviour(removeDeadBranchesPass, source);
      expect(code).toContain('if (false)');
    }
  });

  it('clean.injected-code decides the same way for its guard and its switch', async () => {
    for (const source of [F2.injectedIf, F2.injectedIfStrict, F2.injectedSwitch]) {
      const code = await expectPassKeepsBehaviour(removeInjectedCodePass, source);
      expect(code).not.toContain('var f;');
    }
    for (const source of [
      `function h(){ if ('a' === 'b') { function f(){} } return f; } log(h());`,
      `function h(){ switch ('x') { case 'x': break; case 'y': function f(){} break; } return f; } log(h());`,
    ]) {
      expect(execute(source)).toBe('undefined');
      const code = await expectPassKeepsBehaviour(removeInjectedCodePass, source);
      expect(code).toContain('var f;');
    }
  });
});

// ---------------------------------------------------------------------------
// The reader's side: a call resolved to a declaration a block function shadows
// ---------------------------------------------------------------------------

describe('a name a sloppy block function can stand in for', () => {
  it('simplify.discard-wrappers does not unwrap a call the block function receives', async () => {
    const source = `function w() {}\n{ function w(a) { log('shadow', a); } }\nw(log('arg'));`;
    await expectSameBehaviour(source, 'arg | shadow undefined');
    const code = await expectPassKeepsBehaviour(unwrapDiscardedArgumentsPass, source);
    expect(code).toContain("w(log('arg'))");
  });

  it('strings.inline does not decode a call the block function receives', async () => {
    const source = `var A = ['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa'];
function dec(i) { return A[i]; }
{ function dec(i) { return 'shadow' + i; } }
log(dec(0));
log(dec(1));`;
    await expectSameBehaviour(source, 'shadow0 | shadow1');
    const { code } = await runPass([discoverStringsPass, inlineStringsPass], source);
    expect(execute(code)).toBe('shadow0 | shadow1');
    expect(code).not.toContain("log('alpha')");
    expect(code).toContain('log(dec(0))');
  });

  it('structure.control-flow does not linearise a case that declares a function', async () => {
    const source = `function h(){ var o = '1|0'.split('|'), i = 0; while (true) { switch (o[i++]) { case '0': log(typeof f); continue; case '1': function f(){}; continue; } break; } } h();`;
    await expectSameBehaviour(source, 'function');
    const code = await expectPassKeepsBehaviour(unflattenControlFlowPass, source);
    expect(code).toContain('switch');
  });
});

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------

/** The innermost declaration of `name`: the block-level one where a same-named var-scoped one sits above it. */
function declarationOf(source: string, name: string): NodePath<t.FunctionDeclaration> {
  const { ast } = parseSource(source, {});
  let found: NodePath<t.FunctionDeclaration> | undefined;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === name) found = path;
    },
  });
  if (!found) throw new Error(`no function ${name} in ${source}`);
  return found;
}

describe('blockFunctionHoisting', () => {
  const cases: [string, string][] = [
    [`function h(){ { function f(){} } }`, 'hoisted'],
    [`function h(){ switch (1) { case 1: function f(){} } }`, 'hoisted'],
    [`{ function f(){} }`, 'hoisted'],
    [`function h(){ try {} catch (f) { { function f(){} } } }`, 'hoisted'],
    [`function h(){ function f(){} { function f(){} } }`, 'hoisted'],
    [`function h(){ var f; { function f(){} } }`, 'hoisted'],
    [`var g = function f(){ { function f(){} } };`, 'hoisted'],
    [`function h(){ { { function f(){} } } }`, 'hoisted'],
    [`function h(){ function f(){} }`, 'none'],
    [`function f(){}`, 'none'],
    [`'use strict'; { function f(){} }`, 'none'],
    [`function h(){ 'use strict'; { function f(){} } }`, 'none'],
    [`class C { m() { { function f(){} } } }`, 'none'],
    [`function h(){ { function* f(){} } }`, 'none'],
    [`function h(){ { async function f(){} } }`, 'none'],
    [`function h(f){ { function f(){} } }`, 'none'],
    [`function h(){ let f; { function f(){} } }`, 'none'],
    [`function h(){ const f = 1; { function f(){} } }`, 'none'],
    [`function h(){ class f {} { function f(){} } }`, 'none'],
    [`function h(){ { let f; { function f(){} } } }`, 'none'],
    [`function h(){ for (let f of []) { function f(){} } }`, 'none'],
    [`function h(){ try {} catch ({f}) { { function f(){} } } }`, 'none'],
    [`let f; { function f(){} }`, 'none'],
    [`function h(){ { function f(){} function f(){} } }`, 'unknown'],
    [`function h(){ { function f(){} { function f(){} } } }`, 'unknown'],
    [`function h(){ if (true) function f(){} }`, 'unknown'],
    [`function h(){ { l: function f(){} } }`, 'unknown'],
    [`function h(){ { function arguments(){} } }`, 'unknown'],
  ];
  for (const [source, expected] of cases) {
    it(`${expected}: ${source}`, () => {
      expect(blockFunctionHoisting(declarationOf(source, source.includes('arguments(') ? 'arguments' : 'f'))).toBe(expected);
    });
  }

  it('matches what V8 does with the var', () => {
    // Every `hoisted` case above reads the function through the var after the
    // block; every `none` case reads something else or nothing.
    const reads: [string, string][] = [
      [`function h(){ { function f(){} } return typeof f; } log(h());`, 'function'],
      [`function h(){ try { throw 1; } catch (f) { { function f(){} } } return typeof f; } log(h());`, 'function'],
      [`function h(){ function f(){ return 'o'; } { function f(){ return 'i'; } } return f(); } log(h());`, 'i'],
      [`function h(f){ { function f(){} } return typeof f; } log(h(1));`, 'number'],
      [`function h(){ let f = 1; { function f(){} } return typeof f; } log(h());`, 'number'],
      [`function h(){ for (let f of [1]) { function f(){} } return typeof f; } log(h());`, 'undefined'],
      [`function h(){ try { throw {f: 1}; } catch ({f}) { { function f(){} } } return typeof f; } log(h());`, 'undefined'],
      [`function h(){ { function* f(){} } return typeof f; } log(h());`, 'undefined'],
      [`function h(){ 'use strict'; { function f(){} } return typeof f; } log(h());`, 'undefined'],
    ];
    for (const [source, expected] of reads) expect(execute(source), source).toBe(expected);
  });
});

describe('blockFunctionOutsideUse', () => {
  it('finds the name anywhere in the var scope but the declaration itself', () => {
    const alone = declarationOf(`function h(){ { function f(){ return f; } } return 1; }`, 'f');
    expect(blockFunctionOutsideUse(alone)).toBeUndefined();
    const inside = declarationOf(`function h(){ { function f(){} f(); } }`, 'f');
    expect(blockFunctionOutsideUse(inside)?.name).toBe('f');
    const outside = declarationOf(`function h(){ { function f(){} } return f; }`, 'f');
    expect(blockFunctionOutsideUse(outside)?.name).toBe('f');
    const nested = declarationOf(`function h(){ { function f(){} } function g(){ return f; } }`, 'f');
    expect(blockFunctionOutsideUse(nested)?.name).toBe('f');
    const sibling = declarationOf(`function h(){ { function f(){} } } function g(){ return f; }`, 'f');
    expect(blockFunctionOutsideUse(sibling)).toBeUndefined();
  });

  it('is trivially nothing for a declaration that hoists no var', () => {
    const strict = declarationOf(`'use strict'; { function f(){} } f();`, 'f');
    expect(blockFunctionOutsideUse(strict)).toBeUndefined();
  });
});

describe('hoistedVarNames', () => {
  function anchorOf(source: string, type: string): NodePath {
    const { ast } = parseSource(source, {});
    let found: NodePath | undefined;
    traverse(ast, {
      enter(path) {
        if (path.node.type === type && !found) found = path;
      },
    });
    if (!found) throw new Error(`no ${type}`);
    return found;
  }

  it('collects vars and hoisted functions, and nothing that hoists nothing', () => {
    const fold = (source: string): string[] | undefined => {
      const anchor = anchorOf(source, 'IfStatement');
      return hoistedVarNames(anchor, new Set([(anchor.node as t.IfStatement).consequent]));
    };
    expect(fold(`function h(){ if (false) { var a = 1; function f(){} { var b; } } }`)).toEqual(['a', 'f', 'b']);
    expect(fold(`function h(){ 'use strict'; if (false) { var a; function f(){} } }`)).toEqual(['a']);
    expect(fold(`function h(f){ if (false) { function f(){} } }`)).toEqual([]);
    expect(fold(`function h(){ let f; if (false) { function f(){} } }`)).toEqual([]);
    expect(fold(`function h(){ if (false) { let f; { function f(){} } } }`)).toEqual([]);
    expect(fold(`function h(){ if (false) { function* f(){} } }`)).toEqual([]);
    expect(fold(`function h(){ if (false) { function g(){ var inner; function f(){} } } }`)).toEqual(['g']);
    expect(fold(`function h(){ if (false) { function f(){} function f(){} } }`)).toBeUndefined();
    expect(fold(`function h(){ if (false) { function f(){} { function f(){} } } }`)).toBeUndefined();
    expect(fold(`function h(){ function f(){} if (false) { { function f(){} } } }`)).toEqual(['f']);
    expect(fold(`function h(){ if (false) if (true) function f(){} }`)).toBeUndefined();
  });
});
