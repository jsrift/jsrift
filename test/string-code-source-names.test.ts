import vm from 'node:vm';
import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { stringCodeFacts } from '../src/analysis/string-code.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { freezeHazardKind } from '../src/naming/allocate.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { inlineStringsPass } from '../src/passes/strings/inline.js';
import { pruneDecodersPass } from '../src/passes/strings/prune-decoders.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The narrowing of `'global'` from "some string code exists" to "some string
 * code can spell this name".
 *
 * The blunt version was sound and it cost whole files: one `Function(src)`
 * anywhere in a script froze every program-scope binding, which on a file whose
 * string array is a top-level `var` means the array, the decoder, and every one
 * of its reads. `fixtures/obfuscated3.js` is the case: its only global-scope
 * construct is `new Function("return this")`, a source that names nothing at
 * all, and the blunt answer left it at 390 decoded string references against
 * the 1,727 it decodes once the source is read.
 *
 * Two independent narrowings are tested here, plus the refusals that hold the
 * line either side of them:
 *
 *   * the source is READ. When every global-scope construct in the program has
 *     a source this analysis can parse, only the identifiers those sources
 *     contain are addressable.
 *   * the program is a MODULE. Nothing at a module's top level is in the global
 *     environment, so global-scope code cannot see any of it - asserted against
 *     `node:vm` below rather than argued from the spec.
 *
 * Every refusal is executed rather than asserted structurally, because each one
 * of them, got wrong, produces a program that parses and runs and computes
 * something else.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

const STRINGS = [discoverStringsPass, inlineStringsPass, pruneDecodersPass];

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

/** `addresses` for a program-scope binding, which is the whole global arm. */
function addressesTop(source: string, name: string): boolean {
  const ctx = contextFor(source);
  const program = programOf(ctx);
  const binding = program.scope.getBinding(name);
  if (!binding) throw new Error(`no program-scope binding ${name}`);
  return stringCodeFacts(ctx).addresses(binding);
}

function anyOwnBinding(source: string): boolean {
  const ctx = contextFor(source);
  const program = programOf(ctx);
  return stringCodeFacts(ctx).addressesAnyOwnBinding(program.scope);
}

/** A string array with a decoder and one read, plus whatever `extra` adds. */
function table(extra: string): string {
  return `
    var A = ['alpha', 'beta'];
    function dec(i) { return A[i]; }
    ${extra}
    log(dec(0));
  `;
}

// ---------------------------------------------------------------------------
// The premise, measured rather than assumed
// ---------------------------------------------------------------------------

describe('what global-scope code can actually see', () => {
  it('sees a script top-level var, function and let by name', () => {
    const probe = `
      var v = 1; function f() {} let l = 3;
      result = [Function('return typeof v')(), Function('return typeof f')(),
                Function('return typeof l')()].join(',');
    `;
    const sandbox: Record<string, unknown> = { result: null };
    vm.runInContext(probe, vm.createContext(sandbox), { timeout: 5_000 });
    expect(sandbox['result']).toBe('number,function,number');
  });

  it('sees none of the same three in a module, which is why the arm is off there', () => {
    // `vm.SourceTextModule` is behind a flag, so the module half is asserted
    // through the parser and the fact rather than through a second realm. The
    // executed half of the claim is above; the untestable-here half is the
    // spec's: a module's top level is a Module Environment Record, and the
    // global environment has no path into one. Cross-checked out of band on
    // node 24 with a real `.mjs`: all three answer `'undefined'`.
    const module = `export const marker = 1; var v = 1; Function('return typeof v')();`;
    expect(parseSource(module, {}).sourceType).toBe('module');
    expect(addressesTop(module, 'v')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

describe('a readable global-scope source addresses only the names it contains', () => {
  it('freezes nothing when the source names nothing - the obfuscated3.js shape', () => {
    expect(addressesTop(`var top = 1; new Function("return this")();`, 'top')).toBe(false);
  });

  it('still freezes the name the source does spell', () => {
    expect(addressesTop(`var top = 1; Function('return top')();`, 'top')).toBe(true);
  });

  it('separates two program-scope names by whether the source mentions them', () => {
    const source = `var kept = 1; var other = 2; Function('return kept')();`;
    expect(addressesTop(source, 'kept')).toBe(true);
    expect(addressesTop(source, 'other')).toBe(false);
  });

  it('reads the parameter arguments of Function too, where a default can reference', () => {
    // `Function('a = top', 'return a')` compiles `function (a = top) {...}`, and
    // the reference to `top` is in the PARAMETER text, not the body.
    expect(addressesTop(`var top = 1; Function('a = top', 'return a')();`, 'top')).toBe(true);
  });

  it('counts a name that occurs only as a property, because `this` is the global', () => {
    // In a sloppy `Function` body `this` IS the global object, so `this.top`
    // is a read of the program-scope `top` written in property position.
    expect(addressesTop(`var top = 1; Function('this.top = 2')();`, 'top')).toBe(true);
  });

  it('reads a timer body held in a variable, which used to be no hazard at all', () => {
    const source = `var top = 1; var s = 'top = 2'; setTimeout(s, 0);`;
    const ctx = contextFor(source);
    let kind: unknown = 'not found';
    programOf(ctx).traverse({
      CallExpression(path) {
        kind = freezeHazardKind(path);
      },
    });
    expect(kind).toBe('global');
    expect(addressesTop(source, 'top')).toBe(true);
    // ...and the same shape still names only what it names.
    expect(addressesTop(`var top = 1; var s = 'other = 2'; setTimeout(s, 0);`, 'top')).toBe(false);
  });

  it('follows a reassigned variable into its writes', () => {
    // `s = 'top'` is a write `buildsAString` follows: the timer is a hazard,
    // and `top` is frozen whether the answer is read from that literal or is
    // the blunt one for a source with no text.
    expect(addressesTop(`var top = 1; var s = 'x'; s = 'top'; setTimeout(s, 0);`, 'top')).toBe(
      true,
    );
  });

  it('follows an alias of an alias to the text', () => {
    // `readStaticString` used to stop after one identifier, so an alias of an
    // alias was a callback as far as the classifier could tell and `top` was
    // renamed under a timer body that spells it. The chain is bounded, not
    // one hop; what it reads is the text, so the source still names only what
    // it names.
    expect(addressesTop(`var top = 1; var a = 'top'; var s = a; setTimeout(s, 0);`, 'top')).toBe(
      true,
    );
    expect(
      addressesTop(`var top = 1; var a = 'other'; var b = a; var s = b; setTimeout(s, 0);`, 'top'),
    ).toBe(false);
  });

  it('reads a Function source through the same chain', () => {
    // The chain is `readStaticString`'s, so it reaches every hazard that reads
    // its arguments, not only the timers.
    const source = `var top = 1; var other = 2; var a = 'return top'; var b = a; Function(b)();`;
    expect(addressesTop(source, 'top')).toBe(true);
    expect(addressesTop(source, 'other')).toBe(false);
  });
});

describe('an unreadable or unboundable source restores the blunt answer', () => {
  const blunt: [string, string][] = [
    ['a runtime value', `var top = 1; Function(src)();`],
    ['a concatenation', `var top = 1; Function('return ' + name)();`],
    ['a template with a substitution', 'var top = 1; Function(`return ${name}`)();'],
    ['a computed member, which addresses by a name never written', `var top = 1; Function('globalThis[k] = 1')();`],
    ['a `with`, which resolves its body against an object at run time', `var top = 1; Function('with (o) { y = 1 }')();`],
    ['a source that can compile a further string', `var top = 1; Function('eval(more)')();`],
    ['a source that is not valid JavaScript', `var top = 1; Function('return {{')();`],
    ['an aliased eval, which has no call site to read', `var top = 1; var e = eval; e(src);`],
    // `readStaticString` follows constant declarators a bounded number of
    // hops; a cycle of two reaches the bound without a text, and past the
    // bound the argument is unread, which is this blunt answer.
    ['an alias cycle, which the bounded chain never reads', `var top = 1; var a = b; var b = a; Function(a)();`],
    ['a chain longer than the bound', `var top = 1; var a = 'return 1'; var b = a; var c = b; var d = c; var e = d; var f = e; Function(f)();`],
  ];

  for (const [label, source] of blunt) {
    it(`refuses on ${label}`, () => {
      expect(addressesTop(source, 'top')).toBe(true);
    });
  }

  it('names the construct it could not read, so the refusal is findable', () => {
    const ctx = contextFor(`var top = 1;\nFunction(src)();`);
    programOf(ctx);
    expect(stringCodeFacts(ctx).unreadGlobalSource).toBe('`Function(...)` at line 2');
  });

  it('reports nothing to blame when every source was read', () => {
    const ctx = contextFor(`var top = 1; Function('return top')();`);
    programOf(ctx);
    expect(stringCodeFacts(ctx).unreadGlobalSource).toBeUndefined();
  });

  it('is absorbing: one unreadable source outvotes any number of readable ones', () => {
    const source = `var top = 1; Function('return this')(); Function('return this')(); Function(src)();`;
    expect(addressesTop(source, 'top')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The scope-wide question the strings passes need
// ---------------------------------------------------------------------------

describe('addressesAnyOwnBinding, for a value resolved through a chain of names', () => {
  it('is false when the readable source names nothing bound in the scope', () => {
    expect(anyOwnBinding(`var A = ['a']; var alias = A; Function('return this')();`)).toBe(false);
    expect(anyOwnBinding(`var A = ['a']; Function('return unrelated')();`)).toBe(false);
  });

  it('is true when the source names a link in the chain and not the table', () => {
    // The reason the strings passes cannot use the per-name `addresses`: this
    // program's source spells neither `A` nor `dec`.
    const source = `
      var A = ['a']; function dec(i) { return A[i]; } var alias = dec;
      Function('alias = function () { return "X" }')();
    `;
    const ctx = contextFor(source);
    const program = programOf(ctx);
    const facts = stringCodeFacts(ctx);
    expect(facts.addresses(program.scope.getBinding('A')!)).toBe(false);
    expect(facts.addresses(program.scope.getBinding('dec')!)).toBe(false);
    expect(facts.addressesAnyOwnBinding(program.scope)).toBe(true);
  });

  it('does not answer for a scope the global arm cannot reach', () => {
    const ctx = contextFor(`
      var top = 1;
      function host() { var inner = ['a']; return inner; }
      Function('return top')();
    `);
    const program = programOf(ctx);
    let hostScope: Scope | null = null;
    program.traverse({
      FunctionDeclaration(path) {
        if (path.node.id?.name === 'host') hostScope = path.scope;
      },
    });
    expect(stringCodeFacts(ctx).addressesAnyOwnBinding(hostScope!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the passes that pay for it
// ---------------------------------------------------------------------------

describe('strings: what the narrowing buys and what it still refuses', () => {
  it('inlines and prunes past a source that names nothing', async () => {
    const source = table(`var g = Function("return this")();`);
    const before = execute(source);
    const { code } = await runPass(STRINGS, source);
    expect(code).not.toContain("'alpha'.length");
    expect(code).toContain("log('alpha')");
    expect(code).not.toContain('var A =');
    expect(execute(code)).toBe(before);
  });

  /*
   * The four tests below assert the REFUSAL, so they pin the option rather than
   * the preset: `runPass` defaults to `aggressive`, which is the one preset that
   * lifts this refusal. Everything else about the run stays aggressive, and with
   * the option off the refusal path is the same code it always was.
   */
  it('keeps everything when the source cannot be read', async () => {
    const source = table(`Function(payload)();`);
    const { code } = await runPass(STRINGS, source, {
      techniques: { stringDecoding: { decodeDespiteStringCode: false } },
    });
    expect(code).toContain("var A = ['alpha', 'beta']");
    expect(code).toContain('dec(0)');
  });

  it('keeps everything when the source names the table', async () => {
    const source = table(`Function('A[0] = "MUT"')();`);
    const { code } = await runPass(STRINGS, source, {
      techniques: { stringDecoding: { decodeDespiteStringCode: false } },
    });
    expect(code).toContain("var A = ['alpha', 'beta']");
    expect(code).toContain('dec(0)');
  });

  it('keeps everything when the source names an alias and not the table', async () => {
    const source = `
      var A = ['alpha', 'beta'];
      function dec(i) { return A[i]; }
      var alias = dec;
      Function('alias = function () { return "MUT" }')();
      log(alias(0));
    `;
    const { code } = await runPass(STRINGS, source, {
      techniques: { stringDecoding: { decodeDespiteStringCode: false } },
    });
    expect(code).toContain("var A = ['alpha', 'beta']");
    expect(code).toContain('alias(0)');
  });

  it('runs the same before and after on the shape that used to be rewritten wrongly', async () => {
    // The proof that the refusal above is not merely cautious: with the string
    // code left in place, the two programs must agree, and they only can if the
    // table survives to be mutated.
    const source = `
      var A = ['alpha', 'beta'];
      function dec(i) { return A[i]; }
      Function('A[0] = "MUT"')();
      log(dec(0));
    `;
    const before = execute(source);
    expect(before).toBe('MUT');
    const { code } = await runPass(STRINGS, source, {
      techniques: { stringDecoding: { decodeDespiteStringCode: false } },
    });
    expect(execute(code)).toBe(before);
  });
});
