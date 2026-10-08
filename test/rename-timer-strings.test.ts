import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { freezeHazardKind } from '../src/naming/allocate.js';
import { deobfuscate } from '../src/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import { parseSource } from '../src/frontend/language.js';
import type { DeobfuscateOptions } from '../src/types.js';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A timer handed a string the file spells but the classifier did not read.
 *
 * `setTimeout(x, 0)` compiles `x` as a program in GLOBAL scope when `x` is a
 * string. The classifier freezes program scope when the shape proves the
 * argument may be one, and it proved that for a `+` and a template but not for
 * a conditional or a logical with a literal arm - so `'_0x4a2b()'` sat in the
 * file as a literal while the program-scope `_0x4a2b` was renamed out from
 * under it.
 *
 * The realm below models the browser timer: a string handler is compiled and
 * run in the global scope of the same context, which is the only environment
 * in which these shapes mean anything. Input and output run under the same
 * model and their traces are compared, thrown errors included.
 */

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...parts: unknown[]): void => {
    trace.push(parts.map(String).join(' '));
  };
  const queued: unknown[] = [];
  const sandbox: Record<string, unknown> = {
    console: { log },
    setTimeout: (handler: unknown) => queued.push(handler),
    setInterval: (handler: unknown) => queued.push(handler),
  };
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { timeout: 5_000 });
    // Drained after the script, as an event loop would; each handler is either
    // called or, as a string, compiled in global scope.
    for (const handler of queued) {
      if (typeof handler === 'string') vm.runInContext(handler, context, { timeout: 5_000 });
      else if (typeof handler === 'function') handler();
    }
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join('\n');
}

const PRESETS: readonly DeobfuscateOptions[] = [{ preset: 'balanced' }, { preset: 'aggressive' }];

async function expectSameBehaviour(source: string, options: DeobfuscateOptions): Promise<void> {
  const { code } = await deobfuscate(source, options);
  const before = execute(source);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed at ${options.preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
}

async function renamesOf(source: string, options: DeobfuscateOptions): Promise<string[]> {
  const { ctx } = await runPass(pass, source, options);
  return ctx.renames.map((entry) => `${entry.from}->${entry.to}`);
}

function programOf(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source, {});
  let program: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program as unknown as NodePath<t.Program>;
}

/** How the first classified call in `source` is graded. */
function kindOf(source: string): unknown {
  const seen: unknown[] = [];
  programOf(source).traverse({
    CallExpression(path) {
      seen.push(freezeHazardKind(path));
    },
  });
  return seen.find((entry) => entry !== null) ?? null;
}

// The helper is named by `console.log` evidence at every preset, so the rename
// this suite guards against fires at 'balanced' too, not only through the
// aggressive typed fallback.
const HELPER = `function _0x4a2b() { console.log('helper ran'); }`;

describe('rename.identifiers: a timer body the file spells freezes program scope', () => {
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    [
      'a conditional with two literal arms',
      `${HELPER}
       var _0x77 = Math.random();
       setTimeout(_0x77 > 2 ? 'other()' : '_0x4a2b()', 0);`,
    ],
    [
      'a logical fallback to a literal',
      `${HELPER}
       var _0x88 = null;
       setTimeout(_0x88 || '_0x4a2b()', 0);`,
    ],
    [
      'a nullish fallback to a literal',
      `${HELPER}
       var _0x88 = undefined;
       setTimeout(_0x88 ?? '_0x4a2b()', 0);`,
    ],
    [
      'a conditional between a concatenation and a function',
      `${HELPER}
       var _0x77 = 1;
       setTimeout(_0x77 ? '_0x4a2b' + '()' : function () {}, 0);`,
    ],
    [
      'a conditional whose arm is an aliased literal',
      `${HELPER}
       var _0x11 = '_0x4a2b()';
       var _0x77 = 1;
       setTimeout(_0x77 ? _0x11 : function () {}, 0);`,
    ],
    [
      'an alias of a conditional between literals',
      `${HELPER}
       var _0x77 = 1;
       var _0x11 = _0x77 ? '_0x4a2b()' : 'other()';
       setInterval(_0x11, 10);`,
    ],
  ];

  for (const [name, source] of SHAPES) {
    for (const options of PRESETS) {
      it(`${name} (${options.preset})`, async () => {
        const renames = await renamesOf(source, options);
        expect(renames.filter((entry) => entry.startsWith('_0x4a2b->'))).toEqual([]);
        await expectSameBehaviour(source, options);
      });
    }
  }

  it('classifies each shape as the global hazard', () => {
    expect(kindOf(`setTimeout(x ? 'a()' : 'b()', 0);`)).toBe('global');
    expect(kindOf(`setTimeout(x ? 'a()' : function () {}, 0);`)).toBe('global');
    expect(kindOf(`setTimeout(x || 'a()', 0);`)).toBe('global');
    expect(kindOf(`setTimeout(x && 'a()', 0);`)).toBe('global');
    expect(kindOf(`setTimeout(x ?? \`a()\`, 0);`)).toBe('global');
    expect(kindOf(`var a = 's'; setTimeout(x ? a : f, 0);`)).toBe('global');
    expect(kindOf(`var a = x ? 's' : f; setTimeout(a, 0);`)).toBe('global');
  });

  // The literal is in the file one node further away: behind a comma, on the
  // right of an assignment, or in a write to the variable rather than in its
  // initialiser. `'_0x4a2b'` is never spelled bare, so the string-literal guard
  // does not stand in for the classifier here.
  const INDIRECT: ReadonlyArray<readonly [string, string]> = [
    [
      'a sequence whose last operand is a literal',
      `${HELPER}
       var _0x77 = 1;
       setTimeout((_0x77, '_0x4a2b()'), 0);`,
    ],
    [
      'a sequence whose last operand is a concatenation',
      `${HELPER}
       var _0x77 = 0;
       setTimeout((_0x77++, '_0x4a' + '2b()'), 0);`,
    ],
    [
      'an assignment of a literal',
      `${HELPER}
       var _0x88;
       setTimeout(_0x88 = '_0x4a2b()', 0);`,
    ],
    [
      'an assignment of a concatenation',
      `${HELPER}
       var _0x88, _0x99 = '2b()';
       setTimeout(_0x88 = '_0x4a' + _0x99, 0);`,
    ],
    [
      'a variable written by every assignment as a string',
      `${HELPER}
       var _0x88 = '';
       _0x88 = '_0x4a';
       _0x88 += '2b()';
       setTimeout(_0x88, 0);`,
    ],
    [
      'a variable with no initialiser, assigned a literal',
      `${HELPER}
       var _0x88;
       if (Math.random() < 2) _0x88 = '_0x4a2b()';
       setTimeout(_0x88, 0);`,
    ],
    [
      'a variable initialised to a function, then assigned a concatenation',
      `${HELPER}
       var _0x88 = function () {};
       if (Math.random() < 2) _0x88 = '_0x4a' + '2b()';
       setInterval(_0x88, 10);`,
    ],
  ];

  for (const [name, source] of INDIRECT) {
    for (const options of PRESETS) {
      it(`${name} (${options.preset})`, async () => {
        const renames = await renamesOf(source, options);
        expect(renames.filter((entry) => entry.startsWith('_0x4a2b->'))).toEqual([]);
        await expectSameBehaviour(source, options);
      });
    }
  }

  // The literal is behind more than one name, or behind a name whose
  // declaration is not the one place it is stored: `readStaticString` and
  // `buildsAString` followed exactly one `var s = t` edge, and `buildsAString`
  // read a name's stores only when its `binding.path` was a declarator - so a
  // parameter's writes were never read, and a second declarator (a
  // `VariableDeclarator` in `constantViolations`, not an assignment) was not
  // one of the writes it read. Every shape but the last renamed `_0x4a2b` at
  // both presets and the compiled string threw where the input ran; the last
  // is the redeclaration the other way round, whose literal sits in
  // `binding.path` and was always read, kept so the two stay symmetric.
  const STORED: ReadonlyArray<readonly [string, string]> = [
    [
      'an alias of an alias of a literal',
      `${HELPER}
       var _0x11 = '_0x4a2b()';
       var _0x22 = _0x11;
       setTimeout(_0x22, 0);`,
    ],
    [
      'an alias of an alias of an alias of a literal',
      `${HELPER}
       var _0x11 = '_0x4a2b()';
       var _0x22 = _0x11;
       var _0x33 = _0x22;
       setTimeout(_0x33, 0);`,
    ],
    [
      'an alias of an alias of a concatenation',
      `${HELPER}
       var _0x11 = '_0x4a' + '2b()';
       var _0x22 = _0x11;
       setInterval(_0x22, 10);`,
    ],
    [
      'an alias of a variable whose write is the literal',
      `${HELPER}
       var _0x11;
       if (Math.random() < 2) _0x11 = '_0x4a2b()';
       var _0x22 = _0x11;
       setTimeout(_0x22, 0);`,
    ],
    [
      'a parameter reassigned to a literal',
      `${HELPER}
       function _0xf(_0xs) { _0xs = '_0x4a2b()'; setTimeout(_0xs, 0); }
       _0xf(function () {});`,
    ],
    [
      'a parameter reassigned to an alias of a literal',
      `${HELPER}
       var _0x11 = '_0x4a2b()';
       function _0xf(_0xs) { _0xs = _0x11; setTimeout(_0xs, 0); }
       _0xf(function () {});`,
    ],
    [
      'a parameter whose default is a literal',
      `${HELPER}
       function _0xf(_0xs = '_0x4a2b()') { setTimeout(_0xs, 0); }
       _0xf();`,
    ],
    [
      'a redeclared var whose second declarator is the literal',
      `${HELPER}
       var _0x88;
       var _0x88 = '_0x4a2b()';
       setTimeout(_0x88, 0);`,
    ],
    [
      'a redeclared var whose first declarator is the literal',
      `${HELPER}
       var _0x88 = '_0x4a2b()';
       var _0x88;
       setTimeout(_0x88, 0);`,
    ],
  ];

  for (const [name, source] of STORED) {
    for (const options of PRESETS) {
      it(`${name} (${options.preset})`, async () => {
        const renames = await renamesOf(source, options);
        expect(renames.filter((entry) => entry.startsWith('_0x4a2b->'))).toEqual([]);
        await expectSameBehaviour(source, options);
      });
    }
  }

  it('follows the alias chain to its bound and terminates on a cycle', () => {
    expect(kindOf(`var a = 'x()'; var b = a; setTimeout(b, 0);`)).toBe('global');
    expect(kindOf(`var a = 'x()'; var b = a; var c = b; var d = c; setTimeout(d, 0);`)).toBe(
      'global',
    );
    expect(kindOf(`var a = 'x' + y; var b = a; var c = b; setTimeout(c, 0);`)).toBe('global');
    // Two constant declarators that alias each other: the bound is what stops
    // the read, and neither name holds a string when the bound is reached.
    expect(kindOf(`var a = b; var b = a; setTimeout(a, 0);`)).toBe(null);
    // A chain that ends in a function is still a callback at every length.
    expect(kindOf(`var a = f; var b = a; var c = b; setTimeout(c, 0);`)).toBe(null);
  });

  it('classifies a parameter and a redeclared var by every place they are stored', () => {
    expect(kindOf(`function f(s) { s = 'a()'; setTimeout(s, 0); }`)).toBe('global');
    expect(kindOf(`function f(s = 'a()') { setTimeout(s, 0); }`)).toBe('global');
    expect(kindOf(`function f(s) { setTimeout(s, 0); }`)).toBe(null);
    expect(kindOf(`function f(s = g) { s = h; setTimeout(s, 0); }`)).toBe(null);
    // A default inside a pattern stores a piece, which is not graded.
    expect(kindOf(`function f([s = 'a()']) { setTimeout(s, 0); }`)).toBe(null);
    expect(kindOf(`var s; var s = 'a()'; setTimeout(s, 0);`)).toBe('global');
    expect(kindOf(`var s = 'a()'; var s; setTimeout(s, 0);`)).toBe('global');
    expect(kindOf(`var s = f; var s = g; setTimeout(s, 0);`)).toBe(null);
  });

  it('classifies a sequence, an assignment and a reassigned variable by what they store', () => {
    expect(kindOf(`setTimeout((x, 'a()'), 0);`)).toBe('global');
    expect(kindOf(`setTimeout((x, 'a' + b), 0);`)).toBe('global');
    expect(kindOf(`setTimeout(s = 'a()', 0);`)).toBe('global');
    expect(kindOf(`setTimeout(s = x ? 'a()' : f, 0);`)).toBe('global');
    expect(kindOf(`setTimeout(s += x, 0);`)).toBe('global');
    expect(kindOf(`setTimeout(s ||= 'a()', 0);`)).toBe('global');
    expect(kindOf(`var s; s = 'a()'; setTimeout(s, 0);`)).toBe('global');
    expect(kindOf(`var s = f; s = 'a' + b; setTimeout(s, 0);`)).toBe('global');
    expect(kindOf(`var s = ''; s += b; setTimeout(s, 0);`)).toBe('global');
    // The last operand and the stored value are what count, not the others.
    expect(kindOf(`setTimeout(('a()', f), 0);`)).toBe(null);
    expect(kindOf(`setTimeout(s = f, 0);`)).toBe(null);
    expect(kindOf(`setTimeout(s -= 1, 0);`)).toBe(null);
    expect(kindOf(`var s = f; s = g; setTimeout(s, 0);`)).toBe(null);
    // A pattern write stores a piece of its right side, which is not graded.
    expect(kindOf(`var s = f; [s] = [g]; setTimeout(s, 0);`)).toBe(null);
  });

  // A callback array is ordinary code; the element read proves nothing about
  // the element, and freezing on it would take in every table of handlers.
  it('still renames a callback read out of an array', async () => {
    const source = `${HELPER}
      var _0xarr = [function () { _0x4a2b(); }];
      setTimeout(_0xarr[0], 0);`;
    for (const options of PRESETS) {
      const renames = await renamesOf(source, options);
      expect(renames.some((entry) => entry.startsWith('_0x4a2b->'))).toBe(true);
      await expectSameBehaviour(source, options);
    }
    expect(kindOf(`setTimeout(arr[0], 0);`)).toBe(null);
  });

  it('still renames when the shape cannot be a string', async () => {
    const callbacks = [
      `${HELPER} setTimeout(function () { _0x4a2b(); }, 0);`,
      `${HELPER} setTimeout(() => _0x4a2b(), 0);`,
      `${HELPER} var _0xt = () => _0x4a2b(); setTimeout(cond ? _0xt : function () {}, 0);`,
      `${HELPER} var _0xt = function () { _0x4a2b(); }; setTimeout(_0xt, 0);`,
    ];
    for (const source of callbacks) {
      const renames = await renamesOf(source, { preset: 'balanced' });
      expect(renames.some((entry) => entry.startsWith('_0x4a2b->'))).toBe(true);
      await expectSameBehaviour(source, { preset: 'balanced' });
      await expectSameBehaviour(source, { preset: 'aggressive' });
    }
    expect(kindOf(`setTimeout(x ? f : g, 0);`)).toBe(null);
    expect(kindOf(`setTimeout(f || g, 0);`)).toBe(null);
    expect(kindOf(`var t = () => {}; setTimeout(t, 0);`)).toBe(null);
    expect(kindOf(`setTimeout(tick, 0);`)).toBe(null);
  });
});
