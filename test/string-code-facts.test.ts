import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { freezeHazardKind } from '../src/naming/allocate.js';
import { invalidateStringCodeFacts, stringCodeFacts } from '../src/analysis/string-code.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function contextFor(source: string): PipelineContext {
  const config = resolveConfig({ preset: 'balanced', performance: { verifyOutput: false } });
  const parsed = parseSource(source, {});
  return new PipelineContext(parsed.ast, source, config, parsed.language, Date.now() + 60_000);
}

function programOf(ctx: PipelineContext): NodePath<t.Program> {
  let program: NodePath<t.Program> | null = null;
  traverse(ctx.ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  if (!program) throw new Error('no Program path');
  const found = program as NodePath<t.Program>;
  found.scope.crawl();
  return found;
}

/** The scope owned by the first function whose id is `name`. */
function functionScope(program: NodePath<t.Program>, name: string): Scope {
  let scope: Scope | null = null;
  program.traverse({
    FunctionDeclaration(path) {
      if (path.node.id?.name === name) scope = path.scope;
    },
  });
  if (!scope) throw new Error(`no function named ${name}`);
  return scope;
}

/**
 * How `freezeHazardKind` classifies the first call-shaped node in `source`.
 *
 * Optional calls are visited explicitly: `t.isCallExpression` is false for an
 * `OptionalCallExpression`, and a visitor keyed on `CallExpression` never sees
 * one either, which is the whole reason the shapes below went unclassified.
 */
function kindOf(source: string): unknown {
  const ctx = contextFor(source);
  const program = programOf(ctx);
  const seen: unknown[] = [];
  program.traverse({
    enter(path) {
      if (path.isCallExpression() || path.isNewExpression() || path.isOptionalCallExpression()) {
        seen.push(freezeHazardKind(path));
      }
    },
  });
  if (seen.length === 0) return 'not found';
  return seen.find((entry) => entry !== null) ?? null;
}

// ---------------------------------------------------------------------------

describe('naming/allocate: shapes the classifier could not be asked about', () => {
  it('is false for OptionalCallExpression under t.isCallExpression, which is why they were missed', () => {
    const ctx = contextFor(`eval?.('x');`);
    let optional = 0;
    let plain = 0;
    traverse(ctx.ast, {
      OptionalCallExpression(path) {
        optional++;
        if (t.isCallExpression(path.node)) plain++;
      },
    });
    expect({ optional, plain }).toEqual({ optional: 1, plain: 0 });
  });

  it('classifies an optional direct-eval spelling as global, not lexical', () => {
    expect(kindOf(`eval?.('x');`)).toBe('global');
  });

  it('classifies optional member and optional callee spellings', () => {
    expect(kindOf(`window?.eval(src);`)).toBe('global');
    expect(kindOf(`window.eval?.(src);`)).toBe('global');
    expect(kindOf(`Function?.(src);`)).toBe('global');
    expect(kindOf(`self?.setTimeout('code', 0);`)).toBe('global');
  });

  it('classifies a non-computed .constructor callee', () => {
    expect(kindOf(`(function () {}).constructor(src);`)).toBe('global');
    expect(kindOf(`[].constructor.constructor(src);`)).toBe('global');
    expect(kindOf(`new (function () {}).constructor('a', 'return a');`)).toBe('global');
  });

  it('leaves .constructor alone when it is not the callee', () => {
    expect(kindOf(`log(''.__proto__.constructor.name);`)).toBe(null);
  });

  it('follows .call and .apply back to the receiver', () => {
    expect(kindOf(`Function.prototype.constructor.call(null, src);`)).toBe('global');
    expect(kindOf(`Function.prototype.constructor.apply(null, [src]);`)).toBe('global');
    expect(kindOf(`Function.call(null, src);`)).toBe('global');
  });

  it('reads the shifted argument list for a forwarded timer', () => {
    expect(kindOf(`setTimeout.call(null, 'code', 0);`)).toBe('global');
    expect(kindOf(`setTimeout.call(null, tick, 0);`)).toBe(null);
    expect(kindOf(`setTimeout.apply(null, ['code', 0]);`)).toBe('global');
    // `.apply` with an argument list this analysis cannot read refuses rather
    // than guessing which element would have been the body.
    expect(kindOf(`setTimeout.apply(null, args);`)).toBe(null);
  });

  it('does not mistake an ordinary .call for a hazard', () => {
    expect(kindOf(`handler.call(this, event);`)).toBe(null);
    expect(kindOf(`a.call.call.call(b);`)).toBe(null);
  });

  it('keeps the two arms separate for a forwarded eval', () => {
    // `eval.call(null, s)` is INDIRECT: the direct-eval branch lives only in the
    // plain `CallExpression` production. Classifying it `'lexical'` would freeze
    // local scopes on a claim about the language that is false.
    expect(kindOf(`eval.call(null, src);`)).toBe('global');
    expect(kindOf(`eval(src);`)).toBe('lexical');
  });

  it('still refuses `new eval(...)`, which throws before it compiles anything', () => {
    expect(kindOf(`new eval('x');`)).toBe(null);
  });
});

describe('naming/allocate: the optional and forwarded eval spellings really are indirect', () => {
  /** Run `body` inside a function with a local `x`, and report what came back. */
  function evaluateInLocalScope(expression: string): string {
    const source = `
      function probe() {
        var x = 41;
        try { return String(${expression}); } catch (error) { return 'threw'; }
      }
      result = probe();
    `;
    const sandbox: Record<string, unknown> = { result: null };
    vm.runInContext(source, vm.createContext(sandbox), { timeout: 5000 });
    return String(sandbox.result);
  }

  it('sees the local through a plain call and not through the other two', () => {
    expect(evaluateInLocalScope(`eval('x + 1')`)).toBe('42');
    expect(evaluateInLocalScope(`eval?.('x + 1')`)).toBe('threw');
    expect(evaluateInLocalScope(`eval.call(null, 'x + 1')`)).toBe('threw');
  });
});

// ---------------------------------------------------------------------------

describe('analysis/string-code: the program-level fact', () => {
  it('reports nothing on a program with no string code in it', () => {
    const ctx = contextFor(`var a = 1; function f() { return a; } f();`);
    const facts = stringCodeFacts(ctx);
    expect({ empty: facts.empty, global: facts.global, directEval: facts.directEval }).toEqual({
      empty: true,
      global: false,
      directEval: false,
    });
  });

  it('answers false for every binding when nothing was found', () => {
    const ctx = contextFor(`var a = 1; function f() { var b = 2; return b; }`);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    expect(facts.addresses(program.scope.getBinding('a')!)).toBe(false);
    expect(facts.reaches(program.scope)).toBe(false);
  });

  it('freezes program scope, and only program scope, for global string code', () => {
    const ctx = contextFor(`
      var top = 1;
      function f() { var inner = 2; return inner; }
      Function('return top')();
    `);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    expect({ global: facts.global, directEval: facts.directEval }).toEqual({
      global: true,
      directEval: false,
    });
    expect(facts.addresses(program.scope.getBinding('top')!)).toBe(true);
    expect(facts.addresses(functionScope(program, 'f').getBinding('inner')!)).toBe(false);
  });

  it('reaches the whole chain above a direct eval and nothing beside it', () => {
    const ctx = contextFor(`
      var top = 1;
      function host() {
        var seen = 2;
        function nested() { var hidden = 3; return hidden; }
        eval(src);
        return nested();
      }
      function other() { var elsewhere = 4; return elsewhere; }
    `);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    expect(facts.directEval).toBe(true);

    expect(facts.reaches(program.scope)).toBe(true);
    expect(facts.reaches(functionScope(program, 'host'))).toBe(true);
    expect(facts.reaches(functionScope(program, 'nested'))).toBe(false);
    expect(facts.reaches(functionScope(program, 'other'))).toBe(false);

    expect(facts.addresses(program.scope.getBinding('top')!)).toBe(true);
    expect(facts.addresses(functionScope(program, 'host').getBinding('seen')!)).toBe(true);
    // Injected code runs at the `eval` site, so a binding declared BELOW it is
    // not addressable. Renaming has a further hazard there - see the module doc.
    expect(facts.addresses(functionScope(program, 'nested').getBinding('hidden')!)).toBe(false);
    expect(facts.addresses(functionScope(program, 'other').getBinding('elsewhere')!)).toBe(false);
  });

  it('sees a block scope between the eval and its function', () => {
    const ctx = contextFor(`
      function host() {
        { let boxed = 1; eval(src); log(boxed); }
      }
    `);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    let blockScope: Scope | null = null;
    program.traverse({
      BlockStatement(path) {
        if (path.parentPath.isBlockStatement() || path.parentPath.isFunctionDeclaration()) {
          if (path.scope.path === path) blockScope = path.scope;
        }
      },
    });
    expect(blockScope).not.toBeNull();
    expect(facts.reaches(blockScope!)).toBe(true);
    expect(facts.addresses(blockScope!.getBinding('boxed')!)).toBe(true);
  });

  it('catches the shapes a CallExpression-only visitor never receives', () => {
    for (const source of [
      `eval?.(src);`,
      `Function?.(src);`,
      `[].constructor.constructor(src);`,
      `Function.prototype.constructor.call(null, src);`,
    ]) {
      const ctx = contextFor(`var top = 1; ${source}`);
      const program = programOf(ctx);
      const facts = stringCodeFacts(ctx);
      expect([source, facts.global]).toEqual([source, true]);
      expect([source, facts.addresses(program.scope.getBinding('top')!)]).toEqual([source, true]);
    }
  });

  it('catches an aliased eval, which no test on the call site can see', () => {
    const ctx = contextFor(`var top = 1; var e = eval; e('top');`);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    expect(facts.global).toBe(true);
    expect(facts.addresses(program.scope.getBinding('top')!)).toBe(true);
  });

  it('does not take an object or class key named eval for a reference', () => {
    const ctx = contextFor(`
      var top = 1;
      var options = { eval: false };
      class Runner { eval() { return 1; } }
    `);
    const facts = stringCodeFacts(ctx);
    expect({ empty: facts.empty, global: facts.global }).toEqual({ empty: true, global: false });
  });

  it('leaves the `with` question alone; it is a hazard about position, not strings', () => {
    const ctx = contextFor(`var top = 1; with (o) { log(top); }`);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    expect(facts.empty).toBe(true);
    expect(facts.addresses(program.scope.getBinding('top')!)).toBe(false);
  });

  it('does not report a direct eval as merely global, or the reverse', () => {
    const direct = stringCodeFacts(contextFor(`function f() { eval(src); }`));
    expect({ directEval: direct.directEval, global: direct.global }).toEqual({
      directEval: true,
      global: false,
    });

    const indirect = stringCodeFacts(contextFor(`function f() { (0, eval)(src); }`));
    expect({ directEval: indirect.directEval, global: indirect.global }).toEqual({
      directEval: false,
      global: true,
    });
  });

  it('spells a name from the global sources alone, whatever the tree around them', () => {
    // A builtin is a property of the global object in a module as in a
    // script, and a direct `eval` beside the construct says nothing about
    // what the construct's source can spell: `spells` is the global arm
    // asked on its own, where `addressesName` would answer for a binding.
    const readable = stringCodeFacts(contextFor(`Function('return this.top')(); function dec() { return String(1); }`));
    expect(readable.spells!('String')).toBe(false);
    expect(readable.spells!('top')).toBe(true);

    const spelled = stringCodeFacts(contextFor(`Function('String.fromCharCode = 0')();`));
    expect(spelled.spells!('String')).toBe(true);
    expect(spelled.spells!('decodeURIComponent')).toBe(false);

    const module = contextFor(`var root = Function('return this')();\nexport {};`);
    const inModule = stringCodeFacts(module);
    expect(inModule.spells!('String')).toBe(false);
    expect(inModule.addressesName('String', programOf(module).scope)).toBe(false);

    const withEval = contextFor(`var root = Function('return this')();\nvar n = eval('1');`);
    const beside = stringCodeFacts(withEval);
    expect(beside.directEval).toBe(true);
    expect(beside.spells!('String')).toBe(false);
    // The binding question is still the blunt one here.
    expect(beside.addressesName('String', programOf(withEval).scope)).toBe(true);

    const unread = stringCodeFacts(contextFor(`var src = ['x'].join(''); Function(src)();`));
    expect(unread.spells!('String')).toBe(true);
    expect(unread.unreadGlobalSource).toBe('`Function(...)` at line 1');

    const none = stringCodeFacts(contextFor(`var a = 1;`));
    expect(none.spells!('String')).toBe(false);
  });

  it('reads the global-object idiom as a source that spells nothing, in every spelling and joined', () => {
    // obfuscator.io 0.x: three literals joined, the inner call spelled
    // through `.constructor`, which the generic walk would take for a
    // candidate name and answer with every name in the program.
    const legacy = stringCodeFacts(
      contextFor(
        `var g = Function('return\\x20(function()\\x20' + '{}.constructor(\\x22return\\x20this\\x22)(\\x20)' + ');')();\n` +
          `function dec() { return atob('YQ=='); }`,
      ),
    );
    expect(legacy.global).toBe(true);
    expect(legacy.unreadGlobalSource).toBeUndefined();
    expect(legacy.spells!('atob')).toBe(false);
    expect(legacy.spells!('constructor')).toBe(false);

    for (const source of [
      `var g = Function('return this')();`,
      `var g = new Function('return this')();`,
      `var g = (0, eval)('this');`,
      `var g = (function () {}).constructor('return this')();`,
    ]) {
      const facts = stringCodeFacts(contextFor(`${source}\nfunction dec() { return atob('YQ=='); }`));
      expect(facts.unreadGlobalSource, source).toBeUndefined();
      expect(facts.spells!('atob'), source).toBe(false);
    }

    // A joined source that is not the idiom is read for what it spells.
    const joined = stringCodeFacts(contextFor(`Function('String.from' + 'CharCode = 0')();`));
    expect(joined.spells!('String')).toBe(true);
    expect(joined.spells!('atob')).toBe(false);
    // Joined through a name the scope cannot read: unread, as before.
    const unread = stringCodeFacts(contextFor(`var tail = [')'].join(''); Function('return this' + tail)();`));
    expect(unread.unreadGlobalSource).toBe('`Function(...)` at line 1');

    // `eval` read as a value is still the blunt answer; `(0, eval)` is a call
    // whose source is read, and `o.eval(x)` stays counted as the value read.
    expect(stringCodeFacts(contextFor(`var e = eval; e('1');`)).unreadGlobalSource).toBe('`eval` used as a value');
    expect(stringCodeFacts(contextFor(`(0, eval)('1');`)).unreadGlobalSource).toBeUndefined();
    expect(stringCodeFacts(contextFor(`window.eval('1');`)).unreadGlobalSource).toBe('`eval` used as a value');
  });
});

describe('analysis/string-code: caching', () => {
  it('answers from the cache within one fixpoint iteration', () => {
    const ctx = contextFor(`Function('return top');`);
    const first = stringCodeFacts(ctx);
    expect(stringCodeFacts(ctx)).toBe(first);
  });

  it('recomputes on the next iteration rather than remembering a deleted hazard', () => {
    const ctx = contextFor(`var top = 1; Function('return top');`);
    expect(stringCodeFacts(ctx).global).toBe(true);

    // What `unpack` does to a `Function` wrapper: the hazard leaves the tree.
    const program = programOf(ctx);
    program.traverse({
      ExpressionStatement(path) {
        if (t.isCallExpression(path.node.expression)) path.remove();
      },
    });

    ctx.iteration = 1;
    const after = stringCodeFacts(ctx);
    expect(after.global).toBe(false);
    expect(after.addresses(programOf(ctx).scope.getBinding('top')!)).toBe(false);
  });

  it('drops the cached answer on demand', () => {
    const ctx = contextFor(`var top = 1; log(top);`);
    expect(stringCodeFacts(ctx).empty).toBe(true);

    const program = programOf(ctx);
    program.pushContainer('body', t.expressionStatement(t.callExpression(t.identifier('eval'), [])));

    // Still the stale answer, which is the residue the module documents ...
    expect(stringCodeFacts(ctx).empty).toBe(true);
    // ... and this is the cure a pass that introduces string code must reach for.
    invalidateStringCodeFacts(ctx);
    expect(stringCodeFacts(ctx).directEval).toBe(true);
  });
});
