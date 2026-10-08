import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * `.name` reads that reach a function or class without naming it.
 *
 * `Animal.name` pins `Animal`; that much `naming-reflection-aliases` covers.
 * `super.name`, `x.constructor.name`, `Object.getPrototypeOf(x).name` and
 * `this.name` in a static method read the same string, and there is no
 * `Animal` in any of them for the pass to look at. Each of these used to
 * rename the class out from under the read at aggressive: `dog:Animal` became
 * `dog:val1`.
 *
 * Every case runs input and output and compares what they print, at all three
 * presets. Balanced and conservative do not rename readable names, so the
 * readable cases are inert there by construction; the `_0x` cases are the
 * ones that exercise them.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

/** What the program prints, so input and output can be compared as behaviour. */
function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ log: (value: unknown) => logs.push(String(value)) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

/** Input and output print the same thing at every preset; returns the aggressive output. */
async function expectPreserved(source: string, expected: string[]): Promise<string> {
  expect(observe(source)).toEqual(expected);
  let aggressive = '';
  for (const options of PRESETS) {
    const { code } = await runPass(pass, source, options);
    expect(observe(code), options.preset).toEqual(expected);
    if (options.preset === 'aggressive') aggressive = code;
  }
  return aggressive;
}

describe('a .name read that reaches a class through the object model', () => {
  it('super.name in a static method reads the parent class', async () => {
    const source = `
      class Animal {}
      class Dog extends Animal { static kind() { return 'dog:' + super.name; } }
      log(Dog.kind());
    `;
    const code = await expectPreserved(source, ['dog:Animal']);
    expect(code).toContain('class Animal');
  });

  it('.constructor.name on an instance reads its class', async () => {
    const source = `
      class Animal {}
      log(new Animal().constructor.name);
    `;
    const code = await expectPreserved(source, ['Animal']);
    expect(code).toContain('class Animal');
  });

  it('.prototype.constructor.name reads the class', async () => {
    const source = `
      class Animal {}
      log(Animal.prototype.constructor.name);
    `;
    await expectPreserved(source, ['Animal']);
  });

  it('Object.getPrototypeOf(subclass).name reads the parent class', async () => {
    const source = `
      class Animal {}
      class Dog extends Animal {}
      log(Object.getPrototypeOf(Dog).name);
      log(Reflect.getPrototypeOf(Dog).name);
      log(Dog.__proto__.name);
    `;
    await expectPreserved(source, ['Animal', 'Animal', 'Animal']);
  });

  it('a local Object shadowing the global is not the reflective one', async () => {
    // `Object` here is a plain identifier bound in this file; its
    // `getPrototypeOf` is whatever the program wrote, and the result's `.name`
    // is data. Nothing observable changes when the classes are renamed.
    const source = `
      (function () {
        var Object = { getPrototypeOf: function () { return { name: 'plain' }; } };
        class Animal {}
        log(Object.getPrototypeOf(new Animal()).name);
        log(typeof Animal);
      })();
    `;
    const code = await expectPreserved(source, ['plain', 'function']);
    expect(code).not.toContain('Animal');
  });

  it('this.name in a static method reads the class it was called on', async () => {
    const source = `
      class Animal { static who() { return this.name; } }
      class Dog extends Animal {}
      log(Animal.who());
      log(Dog.who());
    `;
    await expectPreserved(source, ['Animal', 'Dog']);
  });

  it('this.name in a static block and a static field reads the class', async () => {
    const source = `
      class Animal { static { log('block:' + this.name); } }
      class Dog { static label = 'field:' + this.name; }
      log(Dog.label);
    `;
    await expectPreserved(source, ['block:Animal', 'field:Dog']);
  });

  it('this.name in a static arrow method reads the class', async () => {
    // The arrow takes `this` from the static initialiser around it.
    const source = `
      class Animal { static who = () => this.name; }
      log(Animal.who());
    `;
    await expectPreserved(source, ['Animal']);
  });

  it('arguments.callee.name reads the running function', async () => {
    const source = `
      (function () {
        function _0x4a68() { return arguments.callee.name; }
        log(_0x4a68());
      })();
    `;
    await expectPreserved(source, ['_0x4a68']);
  });

  it('reaches a function declared nowhere near the read', async () => {
    // Which constructor an instance has is a run-time fact; the read may
    // land on any class or function in the program.
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        var registry = { a: _0x1111, b: _0x2222 };
        var made = new registry[String.fromCharCode(98)]();
        log(made.constructor.name);
      })();
    `;
    await expectPreserved(source, ['_0x2222']);
  });

  it('pins a class expression named by evaluation', async () => {
    const source = `
      (function () {
        const _0x4a68 = class {};
        log(new _0x4a68().constructor.name);
      })();
    `;
    await expectPreserved(source, ['_0x4a68']);
  });

  it('is read through optional chaining and a string key too', async () => {
    const source = `
      class Animal {}
      log(new Animal()?.constructor?.name);
      log(new Animal()['constructor']['name']);
    `;
    await expectPreserved(source, ['Animal', 'Animal']);
  });
});

describe('a .name read whose object evaluates to one of several identifiers', () => {
  it('follows both arms of || and ?:', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        var pick = String.fromCharCode(98) === 'b';
        log((pick ? _0x2222 : _0x1111).name);
        log((null || _0x1111).name);
        log((0, _0x2222).name);
      })();
    `;
    await expectPreserved(source, ['_0x2222', '_0x1111', '_0x2222']);
  });

  it('keeps the inner id of a function expression read in place', async () => {
    const source = `
      log((function _0x4a68() {}).name);
      log((class _0x1b2c {}).name);
    `;
    await expectPreserved(source, ['_0x4a68', '_0x1b2c']);
  });

  it('keeps the inner id a named function expression reads of itself', async () => {
    // The binding's path is the expression itself, which is neither a
    // declaration nor a declarator; it used to fall through unfrozen.
    const source = `
      var make = function _0x4a68() { return _0x4a68.name; };
      log(make());
    `;
    await expectPreserved(source, ['_0x4a68']);
  });

  it('reads through f?.name', async () => {
    const source = `
      (function () {
        function _0x4a68() {}
        var maybe = _0x4a68;
        log(maybe?.name);
      })();
    `;
    await expectPreserved(source, ['_0x4a68']);
  });
});

describe('reflection freezing stays narrow', () => {
  it('this.name in an instance method reads a field, and pins nothing', async () => {
    // The receiver is an instance; `.name` is whatever the constructor stored.
    // obfuscated2.js reads `this.name` this way, and its decoder must still
    // come out as `getStringArray`.
    const source = `
      (function () {
        class _0x4a68 {
          constructor() { this.name = 'stored'; }
          who() { return this.name; }
        }
        function _0x1b2c() { return 1; }
        log(new _0x4a68().who());
        log(_0x1b2c());
      })();
    `;
    const code = await expectPreserved(source, ['stored', '1']);
    expect(code).not.toContain('_0x4a68');
    expect(code).not.toContain('_0x1b2c');
  });

  it('a plain assignment to .name reads nothing', async () => {
    // The property is not writable on a function, so the write fails or
    // throws the same way whatever the function is called.
    const source = `
      (function () {
        function _0x4a68() {}
        _0x4a68.name = 'other';
        log(typeof _0x4a68);
      })();
    `;
    const code = await expectPreserved(source, ['function']);
    expect(code).not.toContain('_0x4a68');
  });

  it('a compound assignment to .name still reads it', async () => {
    const source = `
      (function () {
        var o = { name: 'x' };
        function _0x4a68() {}
        o.name += _0x4a68.name;
        log(o.name);
      })();
    `;
    await expectPreserved(source, ['x_0x4a68']);
  });
});

describe('a .name read that reaches a function through a value nothing names', () => {
  // A parameter holds whatever the caller passed, and `v.name` therefore reads
  // any function or class in the program: `classify(function nm() {})` printed
  // `fn:val1` at aggressive because `nm` was renamed with no `nm.name` in sight.
  it('pins every function name when .name is read on a parameter', async () => {
    const source = `
      function classify(v) { return v instanceof Function ? 'fn:' + v.name : typeof v; }
      log(classify(function nm() {})); log(classify(1));
    `;
    const code = await expectPreserved(source, ['fn:nm', 'number']);
    expect(code).toContain('function nm()');
  });

  it('pins the reading function too, since it is a value like any other', async () => {
    const source = `
      (function () {
        function _0x1111(v) { return v.name; }
        function _0x2222() {}
        var _0x3333 = 1;
        log(_0x1111(_0x2222)); log(_0x1111(_0x1111)); log(_0x3333);
      })();
    `;
    const code = await expectPreserved(source, ['_0x2222', '_0x1111', '1']);
    // The number carries no observable name and is still renamed.
    expect(code).not.toContain('_0x3333');
  });

  it('pins when .name is read on a destructured parameter', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222({ name }) { return name; }
        function _0x3333({ name: n } = {}) { return n; }
        log(_0x2222(_0x1111)); log(_0x3333(_0x1111));
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x1111']);
  });

  it('pins when .name is read on a free identifier the program assigned', async () => {
    // `GLOBAL_HOOK` is bound by no scope in this file; the assignment gives it
    // one of our functions and the read then spells that function's name.
    const source = `
      (function () {
        function _0x2222() {}
        GLOBAL_HOOK = _0x2222;
        log(GLOBAL_HOOK.name);
      })();
    `;
    await expectPreserved(source, ['_0x2222']);
  });

  it('does not pin for .name on the global object or an ES builtin', async () => {
    // `globalThis.name` is the window's name and `Function.name` is fixed
    // text; neither can spell a function declared here.
    const source = `
      (function () {
        function _0x2222() {}
        log(typeof globalThis.name); log(Function.name); log(typeof _0x2222);
      })();
    `;
    const code = await expectPreserved(source, ['undefined', 'Function', 'function']);
    expect(code).not.toContain('_0x2222');
  });

  it('does not pin for a property other than .name on a parameter', async () => {
    const source = `
      (function () {
        function _0x1111(v) { return v.length; }
        function _0x2222(a, b) {}
        log(_0x1111(_0x2222));
      })();
    `;
    const code = await expectPreserved(source, ['2']);
    expect(code).not.toContain('_0x1111');
    expect(code).not.toContain('_0x2222');
  });

  it('new.target.name reads whichever constructor was called', async () => {
    const source = `
      (function () {
        function _0x1111() { log(new.target.name); }
        class _0x2222 { constructor() { log(new.target.name); } }
        class _0x3333 extends _0x2222 {}
        new _0x1111();
        new _0x3333();
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x3333']);
  });

  it('Object?.getPrototypeOf(x).name reads the parent class', async () => {
    const source = `
      (function () {
        class _0x1111 {}
        class _0x2222 extends _0x1111 {}
        log(Object?.getPrototypeOf(_0x2222).name); log(Reflect?.getPrototypeOf(_0x2222)?.name);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x1111']);
  });
});

describe('a .name read spelled as a destructuring pattern', () => {
  it('const { name } = f reads f.name', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        const { name } = _0x1111;
        const { name: other } = _0x2222;
        log(name); log(other);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x2222']);
  });

  it('({ name } = f) reads f.name', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        var name;
        ({ name } = _0x1111);
        log(name);
      })();
    `;
    await expectPreserved(source, ['_0x1111']);
  });

  it('for (const { name } of list) reads .name off each element', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        var _0x3333 = [_0x2222];
        for (const { name } of [_0x1111, ..._0x3333]) log(name);
        for (const { name } of _0x3333) log(name);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x2222', '_0x2222']);
  });

  it('for (const f of list) f.name reads .name off each element', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        var _0x3333 = [_0x1111];
        for (const f of _0x3333) log(f.name);
        for (var g of [_0x1111]) log(g.name);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x1111']);
  });

  it('for (const { name } in o) reads a string key, and pins nothing', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        for (const { name } in { _0x1111 }) log(typeof name + ' ' + typeof _0x1111);
      })();
    `;
    // `{ _0x1111 }` is a shorthand property, which the layer leaves alone; the
    // function itself is only pinned if the pattern is mistaken for a read.
    const code = await expectPreserved(source, ['undefined function']);
    expect(code).not.toContain('function _0x1111');
  });
});

describe('named evaluation the walk has to follow', () => {
  it('a logical assignment names the function after the variable', async () => {
    const source = `
      (function () {
        var _0x1111; _0x1111 ||= function () {};
        var _0x2222; _0x2222 ??= () => 1;
        var _0x3333 = 1; _0x3333 &&= class {};
        var _0x4444 = _0x1111;
        log(_0x4444.name); log(_0x2222.name); log(_0x3333.name);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x2222', '_0x3333']);
  });

  it('a default parameter names the function after the parameter', async () => {
    const source = `
      (function () {
        function f(_0x1111 = function () {}, { k: _0x2222 = () => 1 } = {}) {
          var a = _0x1111, b = _0x2222;
          return a.name + ' ' + b.name;
        }
        log(f());
      })();
    `;
    await expectPreserved(source, ['_0x1111 _0x2222']);
  });

  it('a destructuring default names the function after the binding', async () => {
    const source = `
      (function () {
        const { k: _0x1111 = function () {} } = {};
        const [_0x2222 = class {}] = [];
        var a = _0x1111, b = _0x2222;
        log(a.name); log(b.name);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x2222']);
  });
});

describe('a computed read whose key is not resolved', () => {
  // With string decoding refused, `_0x68f7[p_s(0x86, 'd4x)')]` is what a
  // `.name` read looks like. The key is unknowable here, so the read is
  // treated as `.name` and what it can reach keeps its spelling, whatever a
  // rule would have offered; `naming-opaque-reads` holds the rule-derived side.
  it('keeps a function read with an opaque key out of the typed fallback', async () => {
    const source = `
      var _0x1111 = ['name'];
      function _0x2222(i) { return _0x1111[i]; }
      var keep = _0x1111;
      function _0x68f7() {}
      log(_0x68f7[_0x2222(0)] + ' ' + keep.length);
    `;
    const code = await expectPreserved(source, ['_0x68f7 1']);
    expect(code).toContain('function _0x68f7()');
    // The array and its reader carry no observable name and are still renamed:
    // `_0x1111[i]` is an opaque read too, but nothing it can reach is a function.
    expect(code).not.toContain('_0x1111');
    expect(code).not.toContain('_0x2222');
  });

  it('follows the alias to the function whose name the read can reach', async () => {
    const source = `
      (function () {
        function _0x2222(i) { return ['name'][i]; }
        function _0x68f7() {}
        var _0x1111 = _0x68f7;
        log(_0x1111[_0x2222(0)] + ' ' + typeof _0x1111);
      })();
    `;
    const code = await expectPreserved(source, ['_0x68f7 function']);
    expect(code).toContain('function _0x68f7()');
    // The alias's own spelling is not what the read returns.
    expect(code).not.toContain('_0x1111');
  });

  it('covers a variable named by evaluation and an optional read', async () => {
    const source = `
      (function () {
        function _0x2222(i) { return ['name'][i]; }
        var _0x1111 = function () {};
        const _0x3333 = class {};
        log(_0x1111[_0x2222(0)] + ' ' + _0x3333?.[_0x2222(0)]);
      })();
    `;
    await expectPreserved(source, ['_0x1111 _0x3333']);
  });

  it('a computed write with = reads nothing', async () => {
    const source = `
      (function () {
        function _0x2222(i) { return ['name'][i]; }
        function _0x1111() {}
        _0x1111[_0x2222(0)] = 'other';
        log(typeof _0x1111);
      })();
    `;
    const code = await expectPreserved(source, ['function']);
    expect(code).not.toContain('_0x1111');
  });
});

describe('a .name read on a parameter is read at the call sites', () => {
  // The obfuscated2 fixture reads `['name']` off an IIFE parameter that
  // holds a record, and off a global this file never writes. Freezing every
  // function for those would cost `getStringArray`; the read is resolved to
  // what the callers pass instead, and widens only when they are out of sight.
  it('a callback over an array literal reads its elements', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        function _0x3333() {}
        [_0x1111, _0x2222].forEach(function (f) { log(f.name); });
        log([_0x3333].map((f, i) => i + f.name).join());
        log([_0x1111].reduce((acc, f) => acc + f.name, ''));
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x2222', '0_0x3333', '_0x1111']);
  });

  it('a callback over a named array reads what the array holds', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        var list = [_0x1111];
        list.push(_0x2222);
        function show(items) { for (const { name } of items) log(name); }
        show(list);
        list.map(f => f.name).forEach(n => log(n));
      })();
    `;
    // `list.push(_0x2222)` puts a second function where the loop will find it.
    const code = await expectPreserved(source, ['_0x1111', '_0x2222', '_0x1111', '_0x2222']);
    expect(code).not.toContain('function show(');
  });

  it('follows f.call, an alias, and a known callee handed the function', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        function _0x3333() {}
        function _0x4444() {}
        function show(v) { return v.name; }
        var alias = show;
        function run(cb) { return cb(_0x3333); }
        log(show.call(null, _0x1111));
        log(alias(_0x2222));
        log(run(show));
        log(typeof _0x4444);
      })();
    `;
    const code = await expectPreserved(source, ['_0x1111', '_0x2222', '_0x3333', 'function']);
    // Never passed anywhere, so no parameter can hold it.
    expect(code).not.toContain('_0x4444');
  });

  it('a spread argument hides the call site, so escaped functions are frozen', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        function show(v) { return v.name; }
        log(show(...[_0x1111]));
        log(typeof _0x2222);
      })();
    `;
    const code = await expectPreserved(source, ['_0x1111', 'function']);
    expect(code).not.toContain('_0x2222');
  });

  it('a function handed to unknown code reads whatever escaped', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        var registry = { run(cb) { cb(_0x2222); } };
        registry.run(v => log(v.name));
        _0x1111();
      })();
    `;
    const code = await expectPreserved(source, ['_0x2222']);
    // Only ever called, so nothing unknown can hand it back.
    expect(code).not.toContain('_0x1111');
  });

  it('a method parameter has no visible callers', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        class _0x3333 { who(v) { return v.name; } }
        log(new _0x3333().who(_0x1111));
        _0x2222();
      })();
    `;
    const code = await expectPreserved(source, ['_0x1111']);
    expect(code).not.toContain('_0x2222');
  });

  it('a reassigned function binding has callers this walk cannot see', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        var show = function (v) { return v.name; };
        var later = show;
        show = function () { return 'other'; };
        log(later(_0x1111));
      })();
    `;
    await expectPreserved(source, ['_0x1111']);
  });

  it('a global this file never writes is another script\'s value', async () => {
    const source = `
      (function () {
        function _0x2222() {}
        var keep = [_0x2222];
        try { log(OTHER_SCRIPT.name); } catch (e) { log('unbound'); }
        log(keep.length);
      })();
    `;
    const code = await expectPreserved(source, ['unbound', '1']);
    expect(code).not.toContain('_0x2222');
  });

  it('a global this file writes through the window is read back', async () => {
    const source = `
      (function () {
        function _0x2222() {}
        globalThis.HOOK = _0x2222;
        log(HOOK.name);
      })();
    `;
    await expectPreserved(source, ['_0x2222']);
  });
});

describe('a .name read on a parameter that sits inside a pattern', () => {
  it('reads the part of a literal argument the pattern selects', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        function _0x3333() {}
        function _0x4444() {}
        function show({ user }) { return user.name; }
        function first([head]) { return head.name; }
        function deep({ a: { b = _0x3333 } }) { return b.name; }
        log(show({ user: _0x1111 }));
        log(first([_0x2222]));
        log(deep({ a: {} }));
        log(typeof _0x4444);
      })();
    `;
    const code = await expectPreserved(source, ['_0x1111', '_0x2222', '_0x3333', 'function']);
    expect(code).not.toContain('_0x4444');
  });

  it('a non-literal argument cannot be taken apart, so escaped functions are frozen', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        function show({ user }) { return user.name; }
        var record = { user: _0x1111 };
        log(show(record));
        log(typeof _0x2222);
      })();
    `;
    const code = await expectPreserved(source, ['_0x1111', 'function']);
    // Never let go of, so no record can carry it.
    expect(code).not.toContain('_0x2222');
  });

  it('a spread in the literal could shadow the key', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function show({ user }) { return user.name; }
        var extra = { user: _0x1111 };
        log(show({ user: null, ...extra }));
      })();
    `;
    await expectPreserved(source, ['_0x1111']);
  });
});

describe('a rejection handler parameter is a caught error', () => {
  it('.name on it reads the error class, and pins nothing', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        var kept = [_0x1111];
        Promise.reject(new TypeError('x')).catch(function (e) { return e.name; });
        Promise.reject(1).then(null, (e = null) => e.name);
        log(kept.length);
      })();
    `;
    const code = await expectPreserved(source, ['1']);
    expect(code).not.toContain('_0x1111');
  });
});

describe('the walk keeps a value apart from its elements', () => {
  it('an opaque read of a map does not pin the functions stored in it', async () => {
    // obfuscated5.js: `obj[k] = fn` for dozens of functions, then `obj[k]`
    // with the decoder refused. The read is of `obj`'s own property, and
    // `obj.name` cannot spell any function stored under another key.
    const source = `
      (function () {
        function _0x2222(i) { return ['name', 'run'][i]; }
        function _0x1111() { return 'ran'; }
        var _0x3333 = {};
        _0x3333[_0x2222(1)] = _0x1111;
        log(_0x3333[_0x2222(1)]());
        log(typeof _0x3333[_0x2222(0)]);
      })();
    `;
    const code = await expectPreserved(source, ['ran', 'undefined']);
    expect(code).not.toContain('_0x1111');
    expect(code).not.toContain('_0x3333');
  });

  it('an element read of the same map pins what was stored', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        var _0x3333 = [];
        _0x3333[0] = _0x1111;
        for (const { name } of _0x3333) log(name);
        log(_0x3333.name);
      })();
    `;
    const code = await expectPreserved(source, ['_0x1111', 'undefined']);
    // `_0x3333.name` is undefined whatever the array is called.
    expect(code).not.toContain('_0x3333');
  });

  it('a rest parameter is the arguments from its index on', async () => {
    const source = `
      (function () {
        function _0x1111() {}
        function _0x2222() {}
        function show(first, ...rest) { for (const { name } of rest) log(name); log(typeof rest.name); }
        show(1, _0x1111, ..._0x2222 ? [_0x2222] : []);
      })();
    `;
    await expectPreserved(source, ['_0x1111', '_0x2222', 'undefined']);
  });
});
