import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RenameAllocator, freezeHazardKind } from '../src/naming/allocate.js';
import { inferNames } from '../src/naming/index.js';
import { deobfuscate } from '../src/index.js';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { parseSource } from '../src/frontend/language.js';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

const balanced: DeobfuscateOptions = { preset: 'balanced' };

async function renamesOf(source: string, options: DeobfuscateOptions = balanced) {
  const { ctx } = await runPass(pass, source, options);
  return ctx.renames.map((entry) => `${entry.from}->${entry.to}`);
}

async function codeOf(source: string, options: DeobfuscateOptions = balanced) {
  const { code } = await runPass(pass, source, options);
  return code;
}

/**
 * Run a program and report what it printed and what it threw.
 *
 * `prelude` runs in the same context first, which is how the browser-only facts
 * these tests turn on are modelled: a `window` that *is* the global object, and
 * a `window.name` that stringifies whatever is written to it.
 */
function execute(code: string, prelude = ''): { logs: string[]; error: string | null } {
  const logs: string[] = [];
  const sandbox: Record<string, unknown> = {
    console: { log: (...parts: unknown[]) => logs.push(parts.map(String).join(' ')) },
  };
  const context = vm.createContext(sandbox);
  if (prelude) vm.runInContext(prelude, context);
  let error: string | null = null;
  try {
    vm.runInContext(code, context, { timeout: 5000 });
  } catch (thrown) {
    error = String((thrown as Error)?.message ?? thrown);
  }
  return { logs, error };
}

/** The deobfuscated program must print what the original printed. */
async function expectSameBehaviour(
  source: string,
  options: DeobfuscateOptions = balanced,
  prelude = '',
): Promise<string> {
  const { code } = await deobfuscate(source, options);
  const before = execute(source, prelude);
  const after = execute(code, prelude);
  expect({ logs: after.logs, error: after.error }).toEqual({
    logs: before.logs,
    error: before.error,
  });
  return code;
}

const WINDOW_IS_GLOBAL = 'var window = globalThis;';

// ---------------------------------------------------------------------------

describe('naming/allocate: string code compiled in global scope freezes program scope', () => {
  const parse = (source: string): NodePath<t.Program> => {
    const { ast } = parseSource(source, {});
    let program: NodePath<t.Program> | null = null;
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    return program as unknown as NodePath<t.Program>;
  };

  /** How the first call or `new` in `source` is classified. */
  const kindOf = (source: string) => {
    const seen: unknown[] = [];
    parse(source).traverse({
      enter(path) {
        if (path.isCallExpression() || path.isNewExpression()) seen.push(freezeHazardKind(path));
      },
    });
    // A traversal reaches the outer call of `Function('...')()` first, so take the
    // classification that is not `null` when the source produced one.
    return seen.find((entry) => entry !== null) ?? (seen.length ? null : 'not found');
  };

  it('classifies Function with all-string-literal arguments as a global hazard', () => {
    expect(kindOf(`var f = Function('return x');`)).toBe('global');
    expect(kindOf(`var f = new Function('a', 'return a');`)).toBe('global');
  });

  it('still classifies Function with a computed body as a global hazard', () => {
    expect(kindOf(`var f = Function(src);`)).toBe('global');
  });

  it('classifies a member-expression timer with a static string body', () => {
    expect(kindOf(`window.setTimeout('code', 0);`)).toBe('global');
    expect(kindOf(`self.setInterval(\`code\`, 0);`)).toBe('global');
  });

  it('leaves a timer given a callback alone', () => {
    expect(kindOf(`setTimeout(tick, 0);`)).toBe(null);
    expect(kindOf(`window.setTimeout(function () {}, 0);`)).toBe(null);
  });

  // A body the analysis cannot read is still a body when the shape proves it is
  // a string: `+` never yields a function and a template never does either.
  it('classifies a timer body it can only prove is a string', () => {
    expect(kindOf("setTimeout('log(' + name + ')', 0);")).toBe('global');
    expect(kindOf('setTimeout(`log(${name})`, 0);')).toBe('global');
    expect(kindOf("var s = 'log(' + name + ')'; setTimeout(s, 0);")).toBe('global');
  });

  it('separates direct eval from every indirect spelling', () => {
    expect(kindOf(`eval('x');`)).toBe('lexical');
    expect(kindOf(`window.eval('x');`)).toBe('global');
    expect(kindOf(`(0, eval)('x');`)).toBe('global');
  });

  it('follows a bound Function back to its target', () => {
    expect(kindOf(`Function.bind(null)(src)();`)).toBe('global');
    expect(kindOf(`Function.bind(null, 'a')('return a')();`)).toBe('global');
    expect(kindOf(`Function.bind(null).bind(null)(src)();`)).toBe('global');
    expect(kindOf(`eval.bind(null)(src);`)).toBe('global');
  });

  it('follows Reflect.apply and Reflect.construct to their target', () => {
    expect(kindOf(`Reflect.apply(Function, null, [src])();`)).toBe('global');
    expect(kindOf(`Reflect.construct(Function, [src])();`)).toBe('global');
  });

  // The forwarding must not invent a hazard out of an ordinary bound call, and
  // `new` is where `eval` stops being one: it is not a constructor.
  it('classifies nothing when the forwarding target is not a hazard', () => {
    expect(kindOf(`foo.bind(null)(src)();`)).toBe(null);
    expect(kindOf(`Reflect.apply(foo, null, [src]);`)).toBe(null);
    expect(kindOf(`Reflect.construct(eval, [src]);`)).toBe(null);
    expect(kindOf(`var bound = Function.bind(null);`)).toBe(null);
    expect(kindOf(`setTimeout.bind(null)(tick, 0);`)).toBe(null);
  });
});

describe('rename.identifiers: a name a string can address is not renamed', () => {
  it('refuses a program-scope binding named by a Function body', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(Function('return _0x4a68')().get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
  });

  it('keeps that program running', async () => {
    await expectSameBehaviour(
      `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(Function('return _0x4a68')().get('k'));`,
      { preset: 'balanced', techniques: { moduleUnwrapping: false } },
    );
  });

  it('refuses when the body only becomes a literal after string decoding', async () => {
    await expectSameBehaviour(`var _0x91 = ['return _0x4a68', 'k'];
function _0xd(_0xi) { return _0x91[_0xi]; }
var _0x4a68 = new Map();
_0x4a68.set(_0xd(1), 7);
console.log(Function(_0xd(0))().get(_0xd(1)));`);
  });

  // The renaming half of the same miss: the declaration survived (a script's
  // program scope is not deletable), but the binding was renamed and the timer
  // string still named the old identifier, so the output threw where the input
  // printed 7.
  it('refuses when a timer is handed a concatenation it cannot read', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
var _0xs = 'log(_0x4a68.get(' + quote('k') + '))';
setTimeout(_0xs, 0);`;
    expect(await renamesOf(source)).toEqual([]);
  });

  it('refuses when a member-expression timer is given a string body', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
window.setTimeout("_0x4a68.get('k')", 0);`;
    expect(await renamesOf(source)).toEqual([]);
  });

  it('refuses when eval is taken as a value and called indirectly', async () => {
    const source = `var _0xrun = eval;
var _0x4a68 = new Map();
_0x4a68.set('k', 7);
_0xrun('_0x4a68.get("k")');`;
    expect(await renamesOf(source)).toEqual([]);
  });

  // Both spellings reached the Function constructor without the classifier
  // seeing it, so the binding was renamed and the string kept naming the old
  // name: the whole program threw `_0x4a68 is not defined` where the input
  // printed 7.
  it('refuses when the Function constructor is reached through bind', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(Function.bind(null)('return _0x4a68')().get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source);
  });

  it('refuses when the Function constructor is reached through Reflect.apply', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(Reflect.apply(Function, null, ['return _0x4a68'])().get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source);
  });

  // The forwarded vector is not readable here, so the source is not readable
  // either - the answer has to be every program-scope name, not the empty set
  // an unwritten argument list would otherwise reduce to.
  it('refuses when an indirect eval is given an argument list it cannot read', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
var argv = ['_0x4a68.get("k")'];
console.log(eval.apply(null, argv));`;
    expect(await renamesOf(source)).toEqual([]);
  });

  // The other direction: a global-scope hazard must not cost nested scopes their
  // names, or one `Function(...)` call would surrender the whole file.
  it('still renames inside a function when only program scope is frozen', async () => {
    const code = await codeOf(`Function('return 1')();
function outer() {
  var _0x4a68 = new Map();
  _0x4a68.set('k', 7);
  return _0x4a68;
}`);
    expect(code).toContain('var map = new Map()');
  });

  it('reports the freeze rather than claiming full coverage', async () => {
    const { ctx } = await runPass(pass, `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(Function('return _0x4a68')().get('k'));`, balanced);
    expect(
      ctx.diagnostics.some((note) => note.message.includes('left unrenamed')),
    ).toBe(true);
  });
});

describe('rename.identifiers: a rename must not capture a free global', () => {
  const SOURCE = `function boot() {
  var _0x3f7a = [1, 2, 3];
  app.storage = _0x3f7a;
  function read() { return storage.read(); }
  return read() + ':' + app.storage.length;
}
console.log(boot());`;

  const PRELUDE = `var app = {}; var storage = { read: function () { return 'other-script'; } };`;

  it('keeps the program running', async () => {
    await expectSameBehaviour(SOURCE, balanced, PRELUDE);
  });

  it('refuses the name the file reads but never binds', async () => {
    expect(await renamesOf(SOURCE)).not.toContain('_0x3f7a->storage');
  });

  // Refusal is scoped to the declaring scope's subtree: the same name is free
  // for a binding whose references can never reach that read.
  it('allows the name when the free read is in a sibling scope', async () => {
    const code = await codeOf(`function elsewhere() { return storage.read(); }
function boot() {
  var _0x3f7a = [1, 2, 3];
  app.storage = _0x3f7a;
  return _0x3f7a.length;
}`);
    expect(code).toContain('var storage = [1, 2, 3]');
  });
});

describe('rename.identifiers: a script binding is also a property of the global object', () => {
  it('refuses a binding this file reads back as window.<name>', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(window._0x4a68.get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source, balanced, WINDOW_IS_GLOBAL);
  });

  it('refuses it through globalThis too', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(globalThis._0x4a68.get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
  });

  // The read need not spell the global object by name. Each of these printed
  // a `TypeError` at balanced: the binding was renamed, and the read through
  // the alias or through `this` was left addressing the old property.
  it('refuses it through an alias of the global object', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
var g = globalThis;
console.log(g._0x4a68.get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source);
  });

  it('refuses it through an alias declared below the read', async () => {
    const source = `function _0x2e9c() { return g._0x4a68.get('k'); }
var _0x4a68 = new Map();
_0x4a68.set('k', 7);
var g = globalThis;
console.log(_0x2e9c());`;
    expect(await renamesOf(source)).not.toContain('_0x4a68->map');
    await expectSameBehaviour(source);
  });

  it('refuses it through the window parameter of a wrapping IIFE', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
!function (d) { console.log(d._0x4a68.get('k')); }(window);`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source, balanced, WINDOW_IS_GLOBAL);
  });

  it('refuses it through this at the top of a script', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
console.log(this._0x4a68.get('k'));`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source);
  });

  it('refuses it through this in a sloppy function, which a plain call binds to the global object', async () => {
    const source = `var _0x4a68 = new Map();
_0x4a68.set('k', 7);
(function () { console.log(this._0x4a68.get('k')); })();`;
    expect(await renamesOf(source)).toEqual([]);
    await expectSameBehaviour(source);
  });

  it('refuses a program-scope function the global object calls by that spelling', async () => {
    // `_0x96d6` is a named function expression handed to `_0x1a2b3c` by a
    // call that is not in the function's reference list; with the function
    // reached only by name, the read of `v.name` widens to what escaped.
    const source = `function _0x1a2b3c(v) { return 'fn:' + v.name; }
var g = globalThis;
console.log(g._0x1a2b3c(function _0x96d6() {}));`;
    for (const preset of ['balanced', 'aggressive'] as const) {
      const code = await expectSameBehaviour(source, { preset });
      expect(code, preset).toContain('function _0x1a2b3c');
      expect(code, preset).toContain('function _0x96d6');
    }
  });

  it('still allows the name when the alias is of something else', async () => {
    const code = await codeOf(`var _0x4a68 = new Map();
_0x4a68.set('k', 7);
var g = { _0x4a68: _0x4a68 };
console.log(g._0x4a68.get('k'));`);
    expect(code).toContain('var map = new Map()');
  });

  it('refuses a Window own property as the name of a top-level var', async () => {
    const source = `var _0x4a68 = ['a', 'b'];
var _0xcfg = {};
_0xcfg.name = _0x4a68;
console.log(Array.isArray(_0x4a68) + '/' + _0x4a68.length);`;
    expect(await renamesOf(source)).not.toContain('_0x4a68->name');
    await expectSameBehaviour(
      source,
      balanced,
      `var __n = '';
       Object.defineProperty(globalThis, 'name', {
         get() { return __n; },
         set(v) { __n = String(v); },
         configurable: true, enumerable: true,
       });`,
    );
  });

  // Only a script's *program-scope* var shares that namespace.
  it('allows the same name one scope down', async () => {
    const code = await codeOf(`function boot() {
  var _0x4a68 = ['a', 'b'];
  var _0xcfg = {};
  _0xcfg.name = _0x4a68;
  return _0x4a68.length;
}`);
    expect(code).toContain('var name = [');
  });
});

describe('rename.identifiers: the rewrite touches only the binding being renamed', () => {
  it('leaves a shadowing function declaration its own parameters', async () => {
    await expectSameBehaviour(`var _0xf = _0x4a68;
var _0x4a68 = new Map();
_0x4a68.set('k', 7);
function _0x4a68(_0x4a68) { return _0x4a68 * 2; }
console.log(_0xf(21) + ':' + _0x4a68.get('k'));`);
  });
});

describe('rename.identifiers: a function-valued binding carries its own name', () => {
  it('refuses to rename one whose .name is read', async () => {
    const source = `var _0x4a68 = function (_0xa, _0xb) { return _0xa + _0xb; };
console.log(_0x4a68.name);`;
    expect(await renamesOf(source)).not.toContain('_0x4a68->add');
    await expectSameBehaviour(source);
  });

  it('refuses one whose .toString() is read', async () => {
    const source = `var _0x4a68 = function (_0xa, _0xb) { return _0xa + _0xb; };
console.log(typeof _0x4a68.toString());`;
    expect(await renamesOf(source)).not.toContain('_0x4a68->add');
  });

  // A named function expression keeps its own `.name`, so the variable is free.
  it('still renames when the expression names itself', async () => {
    const code = await codeOf(`var _0x4a68 = function _0xg(_0xa, _0xb) { return _0xa + _0xb; };
console.log(_0x4a68.name);`);
    expect(code).toContain('var add = function _0xg');
  });
});

describe('rename.identifiers: object-literal keys are disambiguated against the literal', () => {
  const options: DeobfuscateOptions = {
    preset: 'balanced',
    techniques: {
      variableRenaming: { renameProperties: true },
      deadCodeRemoval: false,
      functionUnwrapping: false,
    },
  };

  it('does not mint a key the literal already has', async () => {
    await expectSameBehaviour(
      `var _0x4a68 = { _0xqw: function (a, b) { return a + b; }, add: 'poison' };
console.log(_0x4a68._0xqw(3, 4));`,
      options,
    );
  });

  it('refuses to rename a key that is written twice', async () => {
    await expectSameBehaviour(
      `var _0x4a68 = { _0xqw: function (a, b) { return a + b; }, _0xqw: 42 };
console.log(_0x4a68._0xqw);`,
      options,
    );
  });
});

describe('rename.identifiers: F07 names a search, not every loop that contains a break', () => {
  it('names the result of a real search', async () => {
    const code = await codeOf(`function pick(_0xitems) {
  var _0x22b2 = null;
  for (var _0x33c3 = 0; _0x33c3 < _0xitems.length; _0x33c3++) {
    if (_0xitems[_0x33c3] > 2) {
      _0x22b2 = _0xitems[_0x33c3];
      break;
    }
  }
  return _0x22b2;
}`);
    expect(code).toContain('var found = null');
  });

  it('follows a labelled break out of a nested loop', async () => {
    const code = await codeOf(`function pick(_0xrows) {
  var _0x22b2 = null;
  outer: for (var _0xi = 0; _0xi < _0xrows.length; _0xi++) {
    for (var _0xj = 0; _0xj < _0xrows[_0xi].length; _0xj++) {
      if (_0xrows[_0xi][_0xj] > 2) {
        _0x22b2 = _0xrows[_0xi][_0xj];
        break outer;
      }
    }
  }
  return _0x22b2;
}`);
    expect(code).toContain('var found = null');
  });

  // A `break` inside a `switch` ends the switch, not the loop, so nothing here
  // is searched for.
  it('does not treat a switch break as a loop exit', async () => {
    const names = await renamesOf(`function demo(_0xops) {
  var _0x22b2;
  for (var _0x33c3 = 0; _0x33c3 < _0xops.length; _0x33c3++) {
    switch (_0xops[_0x33c3]) {
      case 1:
        _0x22b2 = _0xops(_0x33c3);
        break;
      case 2:
        _0x22b2 = _0xops(0);
        break;
    }
  }
  return _0x22b2;
}`);
    expect(names.filter((entry) => entry.endsWith('->found'))).toEqual([]);
  });

  // The loop header runs once; only the body is written repeatedly.
  it('does not treat a loop header assignment as a write inside the search', async () => {
    const names = await renamesOf(`function demo(_0xrows, _0xtable) {
  var _0x22b2 = null;
  var _0x33c3;
  var _0xdec;
  for (_0x33c3 = 0, _0xdec = _0xtable; _0x33c3 < _0xrows.length; _0x33c3++) {
    if (_0xrows[_0x33c3] > 2) {
      _0x22b2 = _0xrows[_0x33c3];
      break;
    }
  }
  return [_0x22b2, _0xdec];
}`);
    expect(names).toContain('_0x22b2->found');
    expect(names.filter((entry) => entry.startsWith('_0x33c3->found'))).toEqual([]);
  });

  // `for (...; true;) { switch (...) { ... } break; }` is the statement shuffler: the
  // loop runs once and leaves. Nothing is searched for.
  it('does not treat an unconditional trailing break as a search', async () => {
    const names = await renamesOf(`function demo(_0xorder, _0xinput) {
  var _0x22b2;
  for (var _0xi = 0; true;) {
    switch (_0xorder[_0xi++]) {
      case '0':
        _0x22b2 = _0xinput(1);
        continue;
      case '1':
        _0x22b2 = _0xinput(2);
        continue;
    }
    break;
  }
  return _0x22b2;
}`);
    expect(names.filter((entry) => entry.endsWith('->found'))).toEqual([]);
  });
});

describe('naming/allocate: a collision suffix cannot be read as part of the name', () => {
  const allocator = new RenameAllocator({
    typescript: false,
    strictStringGuard: false,
    strings: new Set(),
    freeGlobalScopes: new Map(),
    globalProperties: new Set(),
    readsGlobalProperty: () => false,
    annexBNames: new Map(),
  });
  const firstThree = (name: string) => {
    const out: string[] = [];
    for (const attempt of allocator.suffixes(name)) {
      out.push(attempt);
      if (out.length === 3) break;
    }
    return out;
  };

  it('separates the suffix when the base ends in a digit', () => {
    expect(firstThree('uint16')).toEqual(['uint16', 'uint16_2', 'uint16_3']);
    expect(firstThree('arg10')).toEqual(['arg10', 'arg10_2', 'arg10_3']);
  });

  it('leaves the plain form alone otherwise', () => {
    expect(firstThree('found')).toEqual(['found', 'found2', 'found3']);
  });

  it('applies it end to end', async () => {
    const code = await codeOf(`(function () {
  function read(v, t) {
    var a = v.getUint16(t, true);
    var b = v.getUint16(t + 2, true);
    return a + b;
  }
  read();
})();`);
    expect(code).toContain('uint16_2');
    expect(code).not.toContain('uint162');
  });

  // The separator is not alphanumeric, so it must not become a way past the
  // guard that refuses to emit a generated-looking name.
  it('does not let a generated-looking name through the guard', async () => {
    const names = await renamesOf(`function build(_0xsrc) {
  var _0xa = _0xsrc.bQe5r7;
  var _0xb = _0xsrc.bQe5r7;
  return [_0xa, _0xb];
}`);
    expect(names.filter((entry) => entry.includes('bQe5r7'))).toEqual([]);
  });
});

describe('rename.identifiers: a rule claims only what its evidence shows', () => {
  it('A16 calls a boolean a flag, not an enablement', async () => {
    const code = await codeOf(`function demo() {
  var _0x44d4 = false;
  if (!_0x44d4) console.log('x');
  _0x44d4 = true;
  return _0x44d4;
}`);
    expect(code).toContain('var flag = false');
    expect(code).not.toContain('isEnabled');
  });

  it('A13 calls an object filled in by name a record, not a cache', async () => {
    const code = await codeOf(`function demo() {
  var _0x2bc4 = {};
  _0x2bc4.s = 56;
  _0x2bc4.c = 'x';
  return _0x2bc4.s + _0x2bc4.c;
}`);
    expect(code).toContain('var record = {}');
    expect(code).not.toContain('cache');
  });

  it('A07 refuses to name an instance after a lowercase constructor', async () => {
    const names = await renamesOf(`function on(_0xa) { this.a = _0xa; }
var _0x66f6 = new on(1);
console.log(_0x66f6.a);`);
    expect(names.filter((entry) => entry.startsWith('_0x66f6->'))).toEqual([]);
  });

  it('A07 still names one after a PascalCase constructor', async () => {
    const code = await codeOf(`function Widget(_0xa) { this.a = _0xa; }
var _0x66f6 = new Widget(1);
console.log(_0x66f6.a);`);
    expect(code).toContain('var widget = new Widget(1)');
  });

  it('A20 falls back to the basename when its alias cannot be emitted', async () => {
    const code = await codeOf(`function boot() {
  var _0xaaa1 = require('lodash');
  return _0xaaa1.map([1], function (n) { return n; });
}`, { preset: 'aggressive' });
    expect(code).toContain('var lodash = require(');
  });
});

describe('rename.identifiers: propagation runs to a fixed point', () => {
  const SOURCE = `(function () {
  var a = document.getElementById('minimap');
  var b = a.getContext('2d');
  var c = b.createImageData(1, 1);
  c.data[0] = 1;
  b.fillRect(0, 0, 1, 1);
})();`;

  const namesAfter = (rounds: number) => {
    const { ast } = parseSource(SOURCE, {});
    let program: NodePath<t.Program> | null = null;
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    return inferNames(program as unknown as NodePath<t.Program>, {
      minConfidence: 0.55,
      propagationRounds: rounds,
    }).renames.map((entry) => `${entry.from}->${entry.to}`);
  };

  it('reaches the same answer however many rounds are allowed', () => {
    const three = namesAfter(3);
    expect(three.length).toBeGreaterThan(0);
    expect(namesAfter(50)).toEqual(three);
    expect(namesAfter(4)).toEqual(three);
  });
});
