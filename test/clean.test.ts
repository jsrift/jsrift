import { beforeAll, describe, expect, it } from 'vitest';
import { removeDeadBranchesPass } from '../src/passes/clean/dead-branches.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { recoverConditionalsPass } from '../src/passes/structure/conditionals.js';
import { recoverLoopsPass } from '../src/passes/structure/loops.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const FIXTURE = thirdPartyFixture('lightly-obfuscated.js');

const keepComments: DeobfuscateOptions = {
  techniques: { deadCodeRemoval: { keepCommented: true } },
};

describe('clean.dead-branches', () => {
  it('keeps only the taken branch of a constant if', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (true) { a(); } else { b(); }');
    expectEquivalent(code, 'a();');
  });

  it('keeps only the else of a constant-false if', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (false) { a(); } else { b(); }');
    expectEquivalent(code, 'b();');
  });

  it('folds the obfuscator idiom !![]', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (!![]) { a(); }');
    expectEquivalent(code, 'a();');
  });

  it('removes a constant-false if with no else', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (!!0) { a(); } b();');
    expectEquivalent(code, 'b();');
  });

  it('hoists var declarations out of a removed branch', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (false) { var x = 1; side(); } use(x);');
    expectEquivalent(code, 'var x; use(x);');
  });

  it('hoists a function declaration out of a removed branch as a bare var', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (false) { function f() {} } use(f);');
    expectEquivalent(code, 'var f; use(f);');
  });

  it('drops block-scoped declarations in a removed branch entirely', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (false) { let y = 1; const z = 2; }');
    expectEquivalent(code, '');
  });

  it('hoists vars out of the branch that loses a constant if/else', async () => {
    const { code } = await runPass(
      removeDeadBranchesPass,
      'if (true) { keep(); } else { var gone = 1; }',
    );
    expectEquivalent(code, 'var gone; keep();');
  });

  it('keeps a lexical declaration inside its block when folding', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'if (true) { let q = 1; use(q); }');
    expectEquivalent(code, '{ let q = 1; use(q); }');
  });

  it('removes a while loop whose test is constantly false', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'while (false) { var w = 1; step(); } end();');
    expectEquivalent(code, 'var w; end();');
  });

  it('keeps the initialiser of a for loop that never iterates', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'for (var i = 0; false; i++) { step(); }');
    expectEquivalent(code, 'var i = 0;');
  });

  it('refuses to fold a test that has to run', async () => {
    await expectNoChange(removeDeadBranchesPass, 'if (log() || true) { a(); } else { b(); }');
  });

  it('refuses to fold a test it cannot prove', async () => {
    await expectNoChange(removeDeadBranchesPass, 'if (x) { a(); } else { b(); }');
  });

  it('honours removeConstantBranches: false', async () => {
    await expectNoChange(removeDeadBranchesPass, 'if (true) { a(); }', {
      techniques: { deadCodeRemoval: { removeConstantBranches: false } },
    });
  });

  it('still prunes unreachable code with removeConstantBranches: false', async () => {
    // The option switches off branch folding only. The visitor is assembled to
    // match the option, so this is what proves the rest of it survived that.
    const { code } = await runPass(
      removeDeadBranchesPass,
      'function g() { if (true) { a(); } return 1; unreachable(); }',
      { techniques: { deadCodeRemoval: { removeConstantBranches: false } } },
    );
    expectEquivalent(code, 'function g() { if (true) { a(); } return 1; }');
  });

  it('still drops an empty block with removeConstantBranches: false', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'a(); { } b();', {
      techniques: { deadCodeRemoval: { removeConstantBranches: false } },
    });
    expectEquivalent(code, 'a(); b();');
  });

  it('removes statements after a return', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'function g() { return 1; unreachable(); }');
    expectEquivalent(code, 'function g() { return 1; }');
  });

  it('hoists a var declared after a return', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'function g() { return 1; var x = 2; }');
    expectEquivalent(code, 'function g() { var x; return 1; }');
  });

  it('keeps a function declared after a return, which is already bound', async () => {
    await expectNoChange(
      removeDeadBranchesPass,
      'function g() { return h(); function h() { return 2; } }',
    );
  });

  it('removes statements after a throw', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'function g() { throw e; after(); }');
    expectEquivalent(code, 'function g() { throw e; }');
  });

  it('removes statements after a break inside a switch case', async () => {
    const { code } = await runPass(
      removeDeadBranchesPass,
      'switch (x) { case 1: a(); break; b(); default: c(); }',
    );
    expect(code).not.toContain('b()');
    expect(code).toContain('c()');
  });

  it('removes statements after a continue', async () => {
    const { code } = await runPass(
      removeDeadBranchesPass,
      'for (var i = 0; i < n; i++) { continue; never(); }',
    );
    expect(code).not.toContain('never()');
  });

  it('keeps a commented unreachable statement when asked to', async () => {
    await expectNoChange(
      removeDeadBranchesPass,
      'function g() { return 1;\n  // deliberately kept\n  audit(); }',
      keepComments,
    );
  });

  it('keeps a commented dead branch when asked to', async () => {
    await expectNoChange(
      removeDeadBranchesPass,
      'if (false) {\n  // explains the flag\n  legacy();\n}',
      keepComments,
    );
  });

  it('never deletes an empty catch block', async () => {
    await expectNoChange(removeDeadBranchesPass, 'try { risky(); } catch (e) {}');
  });

  it('never deletes an empty catch block with no binding', async () => {
    await expectNoChange(removeDeadBranchesPass, 'try { risky(); } catch {}');
  });

  it('keeps an empty loop body, which is not a free-standing block', async () => {
    await expectNoChange(removeDeadBranchesPass, 'while (poll()) {}');
  });

  it('keeps an empty function body', async () => {
    await expectNoChange(removeDeadBranchesPass, 'function noop() {}');
  });

  it('removes a free-standing empty block', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'a(); {} b();');
    expectEquivalent(code, 'a(); b();');
  });

  it('removes stray empty statements', async () => {
    const { code } = await runPass(removeDeadBranchesPass, 'a();;;b();');
    expectEquivalent(code, 'a(); b();');
  });

  it('keeps a semicolon that is a loop body', async () => {
    await expectNoChange(removeDeadBranchesPass, 'while (poll());');
  });

  it('is idempotent over mixed dead code', async () => {
    await expectIdempotent(
      removeDeadBranchesPass,
      'if (true) { a(); } if (false) { var v = 1; } function g() { return 1; b(); } ;; {}',
    );
  });
});

describe('clean.unused', () => {
  it('removes a binding nothing reads', async () => {
    const { code } = await runPass(removeUnusedPass, 'var a = 1; use(b);', { sourceType: 'module' });
    expectEquivalent(code, 'use(b);');
  });

  it('keeps a binding that is read', async () => {
    await expectNoChange(removeUnusedPass, 'var a = 1; use(a);');
  });

  it('keeps a side-effecting initialiser as a statement', async () => {
    const { code } = await runPass(removeUnusedPass, 'var a = boot();', { sourceType: 'module' });
    expectEquivalent(code, 'boot();');
  });

  it('keeps an initialiser that reads a member, which may be a getter', async () => {
    const { code } = await runPass(removeUnusedPass, 'var a = cfg.mode;', { sourceType: 'module' });
    expectEquivalent(code, 'cfg.mode;');
  });

  it('removes an unused function declaration', async () => {
    const { code } = await runPass(removeUnusedPass, 'function dead() { return 1; } live();', { sourceType: 'module' });
    expectEquivalent(code, 'live();');
  });

  it('iterates to a fixpoint when one removal frees another', async () => {
    const { code } = await runPass(
      removeUnusedPass,
      'function a() {} function b() { a(); } var c = 1; keep(c);',
      { sourceType: 'module' },
    );
    expectEquivalent(code, 'var c = 1; keep(c);');
  });

  it('honours removeUnusedFunctions: false', async () => {
    await expectNoChange(removeUnusedPass, 'function dead() { return 1; }', {
      techniques: { deadCodeRemoval: { removeUnusedFunctions: false, removeUnusedBindings: true } },
    });
  });

  it('honours removeUnusedBindings: false', async () => {
    await expectNoChange(removeUnusedPass, 'var a = 1;', {
      techniques: { deadCodeRemoval: { removeUnusedBindings: false, removeUnusedFunctions: false } },
    });
  });

  it('keeps a binding that is assigned even if never read', async () => {
    await expectNoChange(removeUnusedPass, 'var x; x = 1;');
  });

  it('keeps every binding of a function that uses arguments', async () => {
    await expectNoChange(
      removeUnusedPass,
      'function f(p) { var unused = 1; return arguments.length; } f(1);',
    );
  });

  it('keeps every binding a direct eval could reach', async () => {
    await expectNoChange(removeUnusedPass, 'function f() { var secret = 1; eval(payload); } f();');
  });

  // `arguments` is resolved on demand, per function, rather than by scanning
  // every identifier in the program up front. These four pin the rule that
  // makes that legal: the alias belongs to the nearest enclosing function that
  // is not an arrow, and to nothing above it.
  it('keeps a binding when a nested arrow reads the outer arguments', async () => {
    await expectNoChange(
      removeUnusedPass,
      'function f(p) { var unused = 1; return () => arguments.length; } f(1);',
    );
  });

  it('keeps a binding through a chain of nested arrows', async () => {
    await expectNoChange(
      removeUnusedPass,
      'function f(p) { var unused = 1; return () => () => arguments[0]; } f(1);',
    );
  });

  it('removes a binding whose arguments read belongs to a nested function', async () => {
    // The inner `function` has its own `arguments`, so the outer one is not
    // aliased and `unused` really is unused.
    const { code } = await runPass(
      removeUnusedPass,
      'function f(p) { var unused = 1; return function () { return arguments.length; }; } f(1);',
    );
    expect(code).not.toContain('unused');
    expect(code).toContain('arguments.length');
  });

  it('keeps a binding pinned by an arguments read removed earlier in the same run', async () => {
    // Within one run of the pass the answer must not depend on the order the
    // candidates happened to be examined in. `dead` goes in the first round and
    // takes the function's only `arguments` with it; `a` becomes unreferenced
    // only because of that, and is asked about in the second round - by which
    // time the mention that protects it is no longer in the tree to be found.
    // (A later pipeline iteration re-analyses and does then remove `a`, which is
    // correct: by then the program really does not mention `arguments`.)
    const { code } = await runPass(
      removeUnusedPass,
      'function f() { var a = 1; { let dead = () => a + arguments.length; } }\nf();',
      { performance: { maxIterations: 1 } },
    );
    expect(code).not.toContain('dead');
    expect(code).toContain('var a = 1');
  });

  it('removes a block-scoped binding inside a function that uses arguments', async () => {
    // `arguments` aliases parameters, not block scopes, so only the function's
    // own bindings are pinned by it.
    const { code } = await runPass(
      removeUnusedPass,
      'function f(p) { { let inner = 1; } return arguments.length; } f(1);',
    );
    expect(code).not.toContain('inner');
    expect(code).toContain('arguments.length');
  });

  it('keeps function parameters, which define arity', async () => {
    await expectNoChange(removeUnusedPass, 'function f(unusedParam) { return 1; } f(2);');
  });

  it('keeps a catch parameter', async () => {
    await expectNoChange(removeUnusedPass, 'try { risky(); } catch (e) { report(); }');
  });

  it('keeps a destructuring declaration, which can trigger getters', async () => {
    await expectNoChange(removeUnusedPass, 'var { a } = source;');
  });

  it('keeps a for-in binding', async () => {
    await expectNoChange(removeUnusedPass, 'for (var k in source) { total(); }');
  });

  it('keeps a name published on window', async () => {
    await expectNoChange(removeUnusedPass, 'var cfg = 2; window.cfg = 1;');
  });

  it('keeps a name published on module.exports', async () => {
    await expectNoChange(removeUnusedPass, 'function api() {} module.exports.api = 1;');
  });

  it('keeps an exported declaration', async () => {
    await expectNoChange(removeUnusedPass, 'export function used() { return 1; }');
  });

  it('keeps a re-exported binding', async () => {
    await expectNoChange(removeUnusedPass, 'function used() { return 1; }\nexport { used };');
  });

  it('keeps import bindings alone', async () => {
    await expectNoChange(removeUnusedPass, "import { thing } from 'mod';");
  });

  it('removes an inert unused class', async () => {
    const { code } = await runPass(removeUnusedPass, 'class Dead { run() {} } live();', { sourceType: 'module' });
    expectEquivalent(code, 'live();');
  });

  it('keeps a class whose definition runs code', async () => {
    await expectNoChange(removeUnusedPass, 'class Dead extends base() { run() {} }');
  });

  it('keeps a class with a static initialiser', async () => {
    await expectNoChange(removeUnusedPass, 'class Dead { static x = register(); }');
  });

  it('never removes TypeScript overload signatures', async () => {
    const source = [
      'function f(a: string): void;',
      'function f(a: number): void;',
      'function f(a: any): void {}',
    ].join('\n');
    await expectNoChange(removeUnusedPass, source, { language: 'ts' });
  });

  it('never removes a TypeScript interface or enum', async () => {
    await expectNoChange(removeUnusedPass, 'interface Shape { a: string }\nenum Mode { On }', {
      language: 'ts',
    });
  });

  it('keeps a function referenced only from a type position', async () => {
    await expectNoChange(removeUnusedPass, 'function make() { return 1; }\ntype R = typeof make;', {
      language: 'ts',
    });
  });

  it('keeps a TypeScript type alias and the class it names', async () => {
    await expectNoChange(removeUnusedPass, 'class Box {}\ntype B = Box;', { language: 'ts' });
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      removeUnusedPass,
      'var a = 1; var b = boot(); function c() {} function d() { c(); } keep();',
    );
  });

  // -------------------------------------------------------------------------
  // References an earlier pass deleted
  // -------------------------------------------------------------------------

  /**
   * "Nothing reads this" is read straight off Babel's reference counter, which
   * is computed once per crawl. A pass that deletes a reader without handing
   * the reference back leaves the count too high, and a stale count is
   * indistinguishable here from a genuinely live binding. On the 4 MB fixture
   * that one fact accounted for 6,837 of the 6,920 refusals in the final round.
   */
  it('collects a binding whose only reader an earlier pass deleted', async () => {
    const { code } = await runPass(
      [removeDeadBranchesPass, removeUnusedPass],
      'var gone = 1; if (false) { use(gone); } keep();',
      { sourceType: 'module' },
    );
    expectEquivalent(code, 'keep();');
  });

  it('collects a function whose only caller an earlier pass deleted', async () => {
    const { code } = await runPass(
      [removeDeadBranchesPass, removeUnusedPass],
      'function helper() { return 1; } if (!![]) { keep(); } else { helper(); }',
      { sourceType: 'module' },
    );
    expectEquivalent(code, 'keep();');
  });

  it('still keeps a binding the surviving branch reads', async () => {
    const { code } = await runPass(
      [removeDeadBranchesPass, removeUnusedPass],
      'var live = 1; if (false) { use(live); } else { keep(live); }',
    );
    expectEquivalent(code, 'var live = 1; keep(live);');
  });

  it('still keeps a binding a direct eval could reach after a branch is folded', async () => {
    // Rebuilding the reference tables must not undo the eval guard, which is
    // about names eval can see rather than about references anyone wrote.
    const { code } = await runPass(
      [removeDeadBranchesPass, removeUnusedPass],
      'function f() { var hidden = 1; if (false) { drop(); } return eval(src); }',
    );
    expect(code).toContain('var hidden = 1');
  });
});

/**
 * Annex B.3.3: a `function` declared in a block in sloppy mode is ALSO
 * var-hoisted to the enclosing function scope, so it is callable from outside
 * the block Babel scoped it to. `binding.referencePaths` lists none of those
 * outside calls, so "no references" is not evidence of disuse - and acting on it
 * deleted a function the program went on to call.
 */
describe('clean.unused: Annex B block-scoped declarations', () => {
  it('keeps a block-level declaration whose calls the binding cannot see', async () => {
    const source = 'if (ready) { function h() { return 42; } } out = h();';
    await expectNoChange(removeUnusedPass, source);
  });

  it('keeps one declared in a switch case', async () => {
    const source = 'switch (k) { case 1: function s() { return 7; } } out = s();';
    await expectNoChange(removeUnusedPass, source);
  });

  it('still removes a genuinely unused declaration at function scope', async () => {
    const { code, changes } = await runPass(
      removeUnusedPass,
      'function outer() { function dead() { return 1; } return 2; }',
    );
    expect(changes).toBeGreaterThan(0);
    expect(code).not.toContain('dead');
    assertParses(code);
  });

  it('still removes a genuinely unused declaration at module program scope', async () => {
    const { code, changes } = await runPass(
      removeUnusedPass,
      'function dead() { return 1; } out = 2;',
      { sourceType: 'module' },
    );
    expect(changes).toBeGreaterThan(0);
    expect(code).not.toContain('dead');
  });
});

describe.skipIf(!FIXTURE.present)('clean passes on the real fixture', () => {
  let source: string;
  beforeAll(() => {
    source = FIXTURE.read();
  });

  it('removes dead branches without breaking the file', async () => {
    const started = Date.now();
    const { code, changes } = await runPass(removeDeadBranchesPass, source);
    const elapsed = Date.now() - started;
    assertParses(code);
    console.log(`clean.dead-branches: ${changes} changes in ${elapsed}ms`);
  });

  it('removes unused bindings without breaking the file', async () => {
    const started = Date.now();
    const { code, changes } = await runPass(removeUnusedPass, source);
    const elapsed = Date.now() - started;
    assertParses(code);
    console.log(`clean.unused: ${changes} changes in ${elapsed}ms`);
  });

  it('keeps the load-bearing empty catch block', async () => {
    const { code } = await runPass(removeDeadBranchesPass, source);
    expect(code).toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/);
  });

  it('runs all four structure and clean passes together and settles', async () => {
    const all = [recoverConditionalsPass, recoverLoopsPass, removeDeadBranchesPass, removeUnusedPass];
    const started = Date.now();
    const { code, ctx } = await runPass(all, source);
    const elapsed = Date.now() - started;
    assertParses(code);
    expect(code).toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/);
    const perPass = [...ctx.changesByPass].map(([id, n]) => `${id}=${n}`).join(' ');
    console.log(`combined: ${perPass} in ${elapsed}ms`);

    // The fixpoint loop only terminates if every pass reports exactly the
    // changes it made, so a second run over the output must be a no-op.
    const again = await runPass(all, code);
    expect(again.changes).toBe(0);
  });
});


/**
 * A script's top-level declarations are the global scope.
 *
 * `var` and `function` at program scope become properties of the global object
 * and `let`/`const`/`class` become the global lexical environment, so an inline
 * `onclick=`, the next `<script>` tag, or the console reads them by name.
 * Nothing inside one file can prove no such reader exists - which makes "no
 * references in this tree" not a proof of death for these bindings, and the
 * pass's own premise stop holding. The engine already knew this: it freezes
 * program scope the moment string code appears. These tests hold it to the
 * ordinary case, which is the one a person actually pastes in.
 */
describe('clean.unused: a script’s program scope is the global scope', () => {
  const PAGE = [
    'function validateForm(f) { return !!f.email.value; }',
    'function trackClick(id) { new Image().src = "/px?" + id; }',
    'var CONFIG = { endpoint: "/v1" };',
  ].join('\n');

  it('keeps entry points nothing in the file calls', async () => {
    const { code } = await runPass(removeUnusedPass, PAGE);
    for (const name of ['validateForm', 'trackClick', 'CONFIG']) {
      expect(code).toContain(name);
    }
  });

  it('does not reduce a page script to nothing', async () => {
    // The shape that made this a defect rather than a missed cleanup: every
    // declaration unread, so every declaration removed, so the file came back
    // empty - reported as a successful, verified run.
    const { code, changes } = await runPass(removeUnusedPass, PAGE);
    expect(code.trim()).not.toBe('');
    expect(changes).toBe(0);
  });

  it('says why it kept them', async () => {
    const { ctx } = await runPass(removeUnusedPass, PAGE);
    expect(ctx.diagnostics.some((d) => d.message.includes('top-level declarations are global'))).toBe(
      true,
    );
  });

  it.each(['let', 'const'])('freezes `%s` too - the global lexical environment', async (kind) => {
    await expectNoChange(removeUnusedPass, `${kind} unread = 1; run();`);
  });

  it('freezes an unread class declaration', async () => {
    await expectNoChange(removeUnusedPass, 'class Unread { go() {} } run();');
  });

  it('still deletes inside a function, where the scope is not global', async () => {
    // The control that keeps the refusal from being the pass turned off: only
    // program scope is frozen, and only in a script.
    const { code, changes } = await runPass(
      removeUnusedPass,
      'function outer() { var dead = 1; return 2; } run(outer);',
    );
    expect(changes).toBeGreaterThan(0);
    expect(code).not.toContain('dead');
  });

  it('still deletes at program scope of a module, where it is not global', async () => {
    const { code, changes } = await runPass(removeUnusedPass, 'var dead = 1; run();', {
      sourceType: 'module',
    });
    expect(changes).toBeGreaterThan(0);
    expect(code).not.toContain('dead');
  });

  it('leaves the obfuscator machinery to the pass that can prove its case', async () => {
    // The refusal costs nothing on the files this engine exists for: a string
    // table is pruned by `strings/prune-decoders`, which proves no identifier
    // still denotes it, not by reference-counting it at program scope.
    const source = [
      "var _0xdb56 = ['alpha', 'beta'];",
      'function dec(i) { return _0xdb56[i]; }',
      'log(dec(0));',
    ].join('\n');
    await expectNoChange(removeUnusedPass, source);
  });
});
