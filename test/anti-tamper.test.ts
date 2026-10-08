import { describe, expect, it } from 'vitest';
import { removeAntiTamperPass } from '../src/passes/clean/anti-tamper.js';
import { removeInjectedCodePass } from '../src/passes/clean/injected-code.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';
import { thirdPartyFixture } from './support/third-party-fixtures.js';

const LIGHT_FIXTURE = thirdPartyFixture('lightly-obfuscated.js');

const keepComments: DeobfuscateOptions = {
  techniques: { deadCodeRemoval: { keepCommented: true } },
};

/** The `debugProtection` shape obfuscator.io emits, with the strings already decoded. */
const DEBUG_PROTECTION = `
function _0x687f67(_0x3a6fb4) {
  function _0x4c09f5(_0x1de036) {
    if (typeof _0x1de036 === 'string') {
      return function (_0x2a57e8) {}['constructor']('while (true) {}')['apply']('counter');
    } else {
      if (('' + _0x1de036 / _0x1de036)['length'] !== 1 || _0x1de036 % 20 === 0) {
        (function () { return true; }['constructor']('debu' + 'gger')['call']('action'));
      } else {
        (function () { return false; }['constructor']('debu' + 'gger')['apply']('stateObject'));
      }
    }
    _0x4c09f5(++_0x1de036);
  }
  try { if (_0x3a6fb4) return _0x4c09f5; else _0x4c09f5(0); } catch (_0x16be85) {}
}
_0x16be85['setInterval'](_0x687f67, 4000);
`;

/** The shared `callController` closure that debugProtection and selfDefending both use. */
const CALL_CONTROLLER = `
var _0x83f0a4 = function () {
  var _0x21ac91 = true;
  return function (_0x5a8ff3, _0x37ce42) {
    var _0x3ee4f1 = _0x21ac91 ? function () {
      if (_0x37ce42) {
        var _0x1 = _0x37ce42['apply'](_0x5a8ff3, arguments);
        _0x37ce42 = null;
        return _0x1;
      }
    } : function () {};
    _0x21ac91 = false;
    return _0x3ee4f1;
  };
}();
`;

const SELF_DEFENDING = `${CALL_CONTROLLER}
var _0x39f058 = _0x83f0a4(this, function () {
  return _0x39f058['toString']()['search']('(((.+)+)+)+$')['toString']()['constructor'](_0x39f058)['search']('(((.+)+)+)+$');
});
_0x39f058();
`;

/**
 * The same controller, written the way it reads *after* the pipeline has decoded
 * the strings and renamed the identifiers - which is the form the removal logic
 * actually meets on obfuscator.io output, so the construct tests below use it.
 */
const CONTROLLER = `var controller = function () {
  var first = true;
  return function (self, fn) {
    var wrapped = first ? function () {
      if (fn) { var result = fn.apply(self, arguments); fn = null; return result; }
    } : function () {};
    first = false;
    return wrapped;
  };
}();`;

/**
 * obfuscator.io's `debugProtection` trap once its strings are plain.
 *
 * The shape that matters: `protect` *returns* the inner loop, so emptying it is
 * not an option, and its only callers live inside the guard that arms it.
 */
const TRAP = `function protect(shouldReturn) {
  function loop(counter) {
    if (typeof counter === 'string') return function (x) {}['constructor']('while (true) {}')['apply']('counter');
    else if (('' + counter / counter)['length'] !== 1 || counter % 20 === 0) {
      (function () { return true; })['constructor']('debu' + 'gger')['call']('action');
    } else {
      (function () { return false; })['constructor']('debu' + 'gger')['apply']('stateObject');
    }
    loop(++counter);
  }
  try { if (shouldReturn) return loop; else loop(0); } catch (e) {}
}`;

/** The statement that arms the trap: a guard closure handed to the controller. */
const ARM = `(function () {
  controller(this, function () {
    var re = new RegExp('function *\\\\( *\\\\)'),
      re2 = new RegExp('\\\\+\\\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)', 'i'),
      armed = protect('init');
    if (!re.test(armed + 'chain') || !re2.test(armed + 'input')) { armed('0'); } else { protect(); }
  })();
})();`;

/**
 * The `selfDefending` guard the "everything (max options)" matrix case emits,
 * hand-decoded: it lands *inside* the user's function, above real code, so the
 * construct has to be lifted out of a body that must otherwise survive intact.
 */
const MAX_SELF_DEFENDING = `function greet(name) {
  ${CONTROLLER}
  var guard = controller(this, function () {
    if (guard.bind().toString().indexOf('\\n') !== -1) return;
    return guard.toString().search('(((.+)+)+)+$').toString().constructor(guard).search('(((.+)+)+)+$');
  });
  guard();
  return 'Hello, ' + name + '!';
}
console.log(greet('World'));`;

const CONSOLE_DISABLE = `
var _0x4653a6 = function () {
  var _0x3a6fb4 = _0x1de036();
  var _0x4c09f5 = _0x3a6fb4['console'] = _0x3a6fb4['console'] || {};
  var _0x1de036 = ['log', 'warn', 'info', 'error', 'exception', 'table', 'trace'];
  for (var _0x2a57e8 = 0; _0x2a57e8 < _0x1de036['length']; _0x2a57e8++) {
    _0x4c09f5[_0x1de036[_0x2a57e8]] = function () {};
  }
};
_0x4653a6();
`;

describe('clean.anti-tamper: debugProtection', () => {
  it('removes the generated protection function and its interval heartbeat', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, DEBUG_PROTECTION);
    expect(code.trim()).toBe('');
    expect(ctx.detections.map((d) => d.kind)).toContain('debug-protection');
  });

  it('removes a minimal self-recursive debugger trap and every call to it', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      'function trap(n) { debugger; trap(++n); }\ntrap(0);\nkeep();',
    );
    expectEquivalent(code, 'keep();');
  });

  it('removes a Function-constructor debugger payload that runs as its own statement', async () => {
    const { code } = await runPass(removeAntiTamperPass, "Function('debugger')();\nkeep();");
    expectEquivalent(code, 'keep();');
  });

  it('removes a payload built by concatenation and reached through .constructor', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      "(function () {}).constructor('debu' + 'gger').call(this);\nkeep();",
    );
    expectEquivalent(code, 'keep();');
  });

  it('removes a while(true) payload, the other half of the trap pair', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      "(function () {})['constructor']('while (true) {}')['apply']('counter');\nkeep();",
    );
    expectEquivalent(code, 'keep();');
  });

  it('removes a debugger-only timer heartbeat', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      'setInterval(function () { debugger; }, 100);\nkeep();',
    );
    expectEquivalent(code, 'keep();');
  });

  it('keeps a bare debugger statement a human wrote', async () => {
    await expectNoChange(removeAntiTamperPass, 'function audit(x) { debugger; return x + 1; }\naudit(1);');
  });

  it('keeps a debugger inside a timer callback that also does real work', async () => {
    await expectNoChange(removeAntiTamperPass, 'setInterval(function () { poll(); debugger; }, 100);');
  });

  it('keeps a timer whose callback is ordinary code', async () => {
    await expectNoChange(removeAntiTamperPass, 'function tick() { render(); }\nsetInterval(tick, 100);');
  });

  it('disarms rather than deletes a trap whose name real code still references', async () => {
    const { code, ctx } = await runPass(
      removeAntiTamperPass,
      'function trap(n) { debugger; trap(++n); }\nhandlers.onLoad = trap;',
    );
    expectEquivalent(code, 'function trap(n) {} handlers.onLoad = trap;');
    expect(ctx.diagnostics.some((d) => d.message.includes('Emptied a debug-protection'))).toBe(true);
  });

  it('leaves a disarmed trap alone on a second run', async () => {
    await expectNoChange(removeAntiTamperPass, 'function trap(n) {}\nhandlers.onLoad = trap;');
  });

  it('never mistakes the enclosing module IIFE for the trap', async () => {
    const source = `!function () {
      ${'app();'.repeat(1)}
      function trap(n) { debugger; trap(++n); }
      trap(0);
      var state = 1;
      run(state);
    }();`;
    const { code } = await runPass(removeAntiTamperPass, source);
    assertParses(code);
    expect(code).toContain('app()');
    expect(code).toContain('run(state)');
    expect(code).not.toContain('debugger');
  });
});

describe('clean.anti-tamper: selfDefending', () => {
  it('removes the guard, its invocation and the spent call controller', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, SELF_DEFENDING);
    expect(code.trim()).toBe('');
    expect(ctx.detections.map((d) => d.kind)).toContain('self-defending');
  });

  it('removes a function that tests its own toString output', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      "function shield() { if (shield.toString().indexOf('\\n') !== -1) { report(); } }\nshield();\nkeep();",
    );
    expectEquivalent(code, 'keep();');
  });

  it('removes a self-check that goes through bind()', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      "function shield() { return shield.bind().toString().search('(((.+)+)+)+$'); }\nshield();\nkeep();",
    );
    expectEquivalent(code, 'keep();');
  });

  it('keeps the call controller while another consumer still uses it', async () => {
    const source = `${CALL_CONTROLLER}
      var _0x39f058 = _0x83f0a4(this, function () {
        return _0x39f058['toString']()['search']('(((.+)+)+)+$');
      });
      _0x39f058();
      var live = _0x83f0a4(this, function () { return real(); });
      live();`;
    const { code } = await runPass(removeAntiTamperPass, source);
    assertParses(code);
    expect(code).toContain('_0x83f0a4');
    expect(code).toContain('live');
    expect(code).not.toContain('(((.+)+)+)+$');
  });

  it('disarms a self-check whose name real code still references', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      "function shield() { if (shield.toString().search('(((.+)+)+)+$') !== -1) { report(); } }\nexport { shield };",
    );
    expectEquivalent(code, 'function shield() {} export { shield };');
  });

  it('refuses to disarm a self-check whose value escapes to callers we cannot see', async () => {
    // Emptying this body would turn an exported function that answered with a
    // number into one that answers `undefined`. The guard is worthless, but its
    // *value* is observable, and changing an observable value is worse than
    // leaving a guard in a file nobody is going to run through a beautifier check.
    await expectNoChange(
      removeAntiTamperPass,
      "function shield() { return shield.toString().search('(((.+)+)+)+$'); }\nexport { shield };",
    );
  });

  it('keeps a function that stringifies a parameter rather than itself', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      "function render(value) { return value.toString().indexOf('x'); }\nrender(1);",
    );
  });

  it('keeps a function that stringifies an unrelated outer binding', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      "var template = load();\nfunction apply() { return template.toString().indexOf('x'); }\napply();",
    );
  });

  it('keeps an ordinary toString whose result is not tested', async () => {
    await expectNoChange(removeAntiTamperPass, 'function show(n) { return n.toString(); }\nshow(2);');
  });
});

/**
 * A trap is not a function, it is a construct: the trap body, the guard closure
 * that reads it, the controller that arms the guard, and the statement that
 * fires the whole thing. Deleting one of those is what leaves output that still
 * hangs; these tests are about deleting all of them, and - just as important -
 * about the cases where the construct cannot be told apart from real code and
 * the pass has to leave it alone.
 */
describe('clean.anti-tamper: whole constructs', () => {
  it('removes the selfDefending construct the max-options case emits', async () => {
    const { code } = await runPass(removeAntiTamperPass, MAX_SELF_DEFENDING);
    expectEquivalent(
      code,
      "function greet(name) { return 'Hello, ' + name + '!'; } console.log(greet('World'));",
    );
  });

  it('removes a debugProtection construct: trap, guard, controller and arming call', async () => {
    const { code, ctx } = await runPass(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}\n${ARM}\nkeep();`,
    );
    expectEquivalent(code, 'keep();');
    expect(ctx.detections.map((d) => d.kind)).toContain('debug-protection');
  });

  it('deletes a trap whose only callers are inside the guard going with it', async () => {
    // The rule that unblocks everything else: `protect` looks referenced, but
    // both references live inside the closure being deleted, so once the
    // construct is bounded there is nothing left pointing at it.
    const { code } = await runPass(
      removeAntiTamperPass,
      `${CONTROLLER}
function trap(n) { debugger; trap(++n); }
(function () { controller(this, function () { trap(0); })(); })();
keep();`,
    );
    expectEquivalent(code, 'keep();');
  });

  it('lifts the construct out of a function whose real code must survive', async () => {
    // The shape in fixtures/obfuscated2.js: the guard is armed from the top of a
    // real helper that goes on to do the work the program depends on.
    const { code } = await runPass(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}
function readQuery(key) {
  ${ARM}
  return decodeURIComponent(key) || null;
}
console.log(readQuery('a'));`,
    );
    expectEquivalent(
      code,
      "function readQuery(key) { return decodeURIComponent(key) || null; } console.log(readQuery('a'));",
    );
  });

  it('removes a guard fired from a comma operand and keeps the value beside it', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `function greet(name) {
  ${CONTROLLER}
  var guard = controller(this, function () { return guard.toString().search('(((.+)+)+)+$'); });
  return guard(), 'Hello, ' + name + '!';
}
console.log(greet('World'));`,
    );
    expectEquivalent(
      code,
      "function greet(name) { return 'Hello, ' + name + '!'; } console.log(greet('World'));",
    );
  });

  it('removes the trap together with the timer that schedules it', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `function protect(x) { function loop(n) { debugger; loop(++n); } try { if (x) return loop; else loop(0); } catch (e) {} }
setInterval(protect, 4000);
keep();`,
    );
    expectEquivalent(code, 'keep();');
  });

  it('keeps real work that shares the wrapper with the arming call', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}
(function () {
  boot();
  controller(this, function () { var armed = protect('init'); armed('0'); })();
})();`,
    );
    expectEquivalent(code, '(function () { boot(); })();');
  });

  it('keeps a global write that shares the wrapper with the arming call', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}
(function () {
  window.installed = true;
  controller(this, function () { var armed = protect('init'); armed('0'); })();
})();`,
    );
    expectEquivalent(code, '(function () { window.installed = true; })();');
  });

  it('refuses when the trap is also called by code we keep', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}
(function () { controller(this, function () { protect(); })(); })();
var handle = protect(true);
use(handle);`,
    );
  });

  it('refuses when the arming region reads a binding real code owns', async () => {
    // `log` is declared outside the region, so the region is not provably all
    // trap: deleting it would delete a call into code of unknown effect.
    await expectNoChange(
      removeAntiTamperPass,
      `var log = makeLogger();\n${CONTROLLER}\n${TRAP}
(function () {
  controller(this, function () { log('tick'); var armed = protect('init'); armed('0'); })();
})();`,
    );
  });

  it("refuses when the arming call's value is handed to a real function", async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}
init(controller(this, function () { var armed = protect('init'); armed('0'); })());`,
    );
  });

  it('refuses when the guard call is the value of the expression it sits in', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `function greet(name) {
  ${CONTROLLER}
  var guard = controller(this, function () { return guard.toString().search('(((.+)+)+)+$'); });
  return name, guard();
}
console.log(greet('World'));`,
    );
  });

  it('refuses a trap that is reassigned, which is not a trap we understand', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}
protect = wrap(protect);
(function () { controller(this, function () { var armed = protect('init'); armed('0'); })(); })();`,
    );
  });

  it('keeps a debugger a human wrote in a helper an IIFE happens to call', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      "function trace(x) { debugger; console.log(x); }\n(function () { trace('boot'); })();",
    );
  });

  it('is idempotent over a whole construct', async () => {
    await expectIdempotent(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}\n${ARM}\n${MAX_SELF_DEFENDING}\nkeep();`,
    );
  });

  it('leaves valid, parseable output after whole-construct removal', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `${CONTROLLER}\n${TRAP}\n${ARM}\n${MAX_SELF_DEFENDING}\nkeep();`,
    );
    assertParses(code);
    expect(code).not.toContain('debu');
    expect(code).not.toContain('(((.+)+)+)+$');
  });
});

describe('clean.anti-tamper: disableConsoleOutput', () => {
  it('removes the generated console method table and its invocation', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, CONSOLE_DISABLE);
    expect(code.trim()).toBe('');
    expect(ctx.detections.map((d) => d.kind)).toContain('console-disable');
  });

  it('removes the console table when it is wrapped in an IIFE', async () => {
    const source = `(function () {
      var target = window['console'];
      var methods = ['log', 'warn', 'info', 'error', 'exception', 'table', 'trace'];
      for (var i = 0; i < methods.length; i++) { target[methods[i]] = function () {}; }
    })();
    keep();`;
    const { code } = await runPass(removeAntiTamperPass, source);
    expectEquivalent(code, 'keep();');
  });

  it('removes a direct no-op assignment', async () => {
    const { code } = await runPass(removeAntiTamperPass, 'console.log = function () {};\nkeep();');
    expectEquivalent(code, 'keep();');
  });

  it('removes a chained no-op assignment', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      'console.log = console.warn = console.error = function () {};\nkeep();',
    );
    expectEquivalent(code, 'keep();');
  });

  it('removes a no-op assignment reached through window', async () => {
    const { code } = await runPass(removeAntiTamperPass, 'window.console.log = () => {};\nkeep();');
    expectEquivalent(code, 'keep();');
  });

  it('keeps a console method reassigned to a real logger', async () => {
    await expectNoChange(removeAntiTamperPass, 'console.log = myLogger;');
  });

  it('keeps a console method reassigned to a function that does work', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      'console.log = function (message) { transport(message); };',
    );
  });

  it('keeps ordinary console call sites, which are user code', async () => {
    await expectNoChange(removeAntiTamperPass, "console.log('ready');\nconsole.error(err);");
  });

  it('keeps a string array that is not the console method table', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      "var order = ['log', 'warn'];\nfunction pick() { return order[0]; }\npick();",
    );
  });
});

describe('clean.anti-tamper: contract', () => {
  it('is idempotent over all three families at once', async () => {
    await expectIdempotent(
      removeAntiTamperPass,
      `${DEBUG_PROTECTION}\n${SELF_DEFENDING}\n${CONSOLE_DISABLE}\nconsole.log = function () {};\nkeep();`,
    );
  });

  it('leaves valid, parseable output', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `${DEBUG_PROTECTION}\n${SELF_DEFENDING}\n${CONSOLE_DISABLE}\nkeep();`,
    );
    assertParses(code);
    expectEquivalent(code, 'keep();');
  });

  it('honours antiTamperRemoval: false', async () => {
    await expectNoChange(removeAntiTamperPass, DEBUG_PROTECTION, {
      techniques: { antiTamperRemoval: false },
    });
  });

  it.skipIf(!LIGHT_FIXTURE.present)('makes no change to the lightly-obfuscated fixture, which has no anti-tamper', async () => {
    const source = LIGHT_FIXTURE.read();
    await expectNoChange(removeAntiTamperPass, source);
  });
});

describe('clean.injected-code: the if form', () => {
  it('keeps the else when the guard compares two different constants', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('fgYDa' === 'pGlYu') { garbage(); } else { real(); }",
    );
    expectEquivalent(code, 'real();');
  });

  it('keeps the else when the guard compares a constant with itself using !==', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('KIYLT' !== 'KIYLT') { garbage(); } else { real(); }",
    );
    expectEquivalent(code, 'real();');
  });

  it('keeps the consequent when the guard is true', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('abc' === 'abc') { real(); } else { garbage(); }",
    );
    expectEquivalent(code, 'real();');
  });

  it('folds a guard whose operands are split-string concatenations', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('ab' + 'c' === 'abc') { real(); } else { garbage(); }",
    );
    expectEquivalent(code, 'real();');
  });

  it('folds a numeric guard', async () => {
    const { code } = await runPass(removeInjectedCodePass, 'if (1 === 2) { garbage(); } else { real(); }');
    expectEquivalent(code, 'real();');
  });

  it('folds a guard with no else', async () => {
    const { code } = await runPass(removeInjectedCodePass, "if ('a' === 'a') real();");
    expectEquivalent(code, 'real();');
  });

  it('hoists a var out of the deleted branch, which is still a binding', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('a' === 'b') { var dead = 1; ghost(); } else { real(); }\nuse(dead);",
    );
    expectEquivalent(code, 'var dead; real(); use(dead);');
  });

  it('hoists a function declared in the deleted branch as a bare var', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('a' === 'b') { function ghost() {} } else { real(); }\nuse(ghost);",
    );
    expectEquivalent(code, 'var ghost; real(); use(ghost);');
  });

  it('keeps a lexical declaration inside its block when the live branch is kept', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('a' === 'a') { let q = 1; use(q); } else { garbage(); }",
    );
    expectEquivalent(code, '{ let q = 1; use(q); }');
  });

  it('refuses a guard with a variable operand', async () => {
    await expectNoChange(removeInjectedCodePass, "if (key === 'abc') { a(); } else { b(); }");
  });

  it('refuses a guard that has to call something', async () => {
    await expectNoChange(removeInjectedCodePass, "if (getKey() === 'abc') { a(); } else { b(); }");
  });

  it('refuses a loose comparison across two types', async () => {
    await expectNoChange(removeInjectedCodePass, "if (0 == '') { a(); } else { b(); }");
  });

  it('refuses a non-comparison test, which is dead-branches territory', async () => {
    await expectNoChange(removeInjectedCodePass, 'if (true) { a(); } else { b(); }');
  });

  it('keeps a commented dead branch when asked to', async () => {
    await expectNoChange(
      removeInjectedCodePass,
      "if ('a' === 'b') {\n  // explains the legacy path\n  legacy();\n} else {\n  real();\n}",
      keepComments,
    );
  });

  it('reports the dead-code-injection fingerprint', async () => {
    const { ctx } = await runPass(
      removeInjectedCodePass,
      "if ('fgYDa' === 'pGlYu') { garbage(); } else { real(); }",
    );
    expect(ctx.detections.map((d) => d.kind)).toContain('dead-code-injection');
  });
});

describe('clean.injected-code: the switch form', () => {
  it('keeps only the matching case', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "switch ('KsQ') { case 'KsQ': real(); break; case 'wRt': garbage(); break; }",
    );
    expectEquivalent(code, 'real();');
  });

  it('falls back to the default when nothing matches', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "switch ('zz') { case 'a': garbage(); break; default: real(); }",
    );
    expectEquivalent(code, 'real();');
  });

  it('removes a switch that selects nothing, keeping its hoisted vars', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "switch ('zz') { case 'a': var dead = 1; garbage(); break; }\nuse(dead);",
    );
    expectEquivalent(code, 'var dead; use(dead);');
  });

  it('refuses a case that falls through into the next one', async () => {
    await expectNoChange(
      removeInjectedCodePass,
      "switch ('a') { case 'a': first(); case 'b': second(); break; }",
    );
  });

  it('refuses a case whose break targets a label outside the switch', async () => {
    await expectNoChange(
      removeInjectedCodePass,
      "outer: for (;;) { switch ('a') { case 'a': break outer; } }",
    );
  });

  it('refuses a break the switch owns from inside a nested block', async () => {
    await expectNoChange(
      removeInjectedCodePass,
      "switch ('a') { case 'a': if (ready()) { break; } run(); break; }",
    );
  });

  it('refuses a non-constant discriminant', async () => {
    await expectNoChange(removeInjectedCodePass, "switch (state) { case 'a': a(); break; default: b(); }");
  });

  it('refuses a non-constant case test', async () => {
    await expectNoChange(removeInjectedCodePass, "switch ('a') { case key: a(); break; default: b(); }");
  });
});

describe('clean.injected-code: contract', () => {
  it('is idempotent', async () => {
    await expectIdempotent(
      removeInjectedCodePass,
      "if ('a' === 'b') { var dead = 1; ghost(); } else { real(); }\nswitch ('KsQ') { case 'KsQ': keep(); break; case 'x': junk(); break; }",
    );
  });

  it('leaves valid, parseable output', async () => {
    const { code } = await runPass(
      removeInjectedCodePass,
      "if ('a' === 'b') { function ghost() { return _0xfree; } } else { real(); }",
    );
    assertParses(code);
  });

  it.skipIf(!LIGHT_FIXTURE.present)('makes no change to the lightly-obfuscated fixture, which has no dead-code injection', async () => {
    const source = LIGHT_FIXTURE.read();
    await expectNoChange(removeInjectedCodePass, source);
  });
});

// ---------------------------------------------------------------------------
// The commercial-protector families, measured on obfuscated3.js
// ---------------------------------------------------------------------------

const HEAVY3_FIXTURE = thirdPartyFixture('obfuscated3.js');

/**
 * The newline tripwire, copied from the fixture.
 *
 * Note what is *not* here: the word `toString`. Passing a function where a
 * string is expected coerces it, so the guard reads its own source without ever
 * naming the operation - which is why the recogniser keys on the pattern and the
 * self-reference instead.
 */
const NEWLINE_TRIPWIRE = `(function () {
  var namedFunction = function () {
    var test = function () {
      var regExp = new RegExp("\\n");
      return regExp["test"](namedFunction);
    };
    if (test()) { for (;;) {} }
  };
  return namedFunction();
})();`;

/** The domain lock, in the `void function () {}()` spelling the fixture opens with. */
const DOMAIN_LOCK = `void function () {
  var allowed = ["example.com"];
  var host = "";
  try {
    host = typeof location !== "undefined" && location && location.hostname ? location.hostname["toLowerCase"]() : "";
  } catch (e) {
    host = "";
  }
  if (host["substring"](0, 4) === "www.") host = host["slice"](4);
  if (allowed["indexOf"](host) === -1) {
    for (;;) {}
  }
}();`;

/** The source-integrity trampoline: 80 of these wrap the fixture's shared functions. */
const TRAMPOLINE = `function impl(a, b) { return a + b; }
function shim(a, b) {
  var digest = impl.__k || (impl.__k = hash(impl, 4785466));
  if (digest === 1228482746886050) {
    return impl(a, b);
  } else {
    while (true) {}
  }
}
use(shim);`;

/** `count` functions, each opening with an injected `debugger`. */
function flooded(count: number, perFunction = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const blocks: string[] = [];
    for (let j = 0; j < perFunction; j++) {
      blocks.push(`if (x > ${j}) { debugger; step${j}(x); }`);
    }
    lines.push(`function work${i}(x) { debugger; ${blocks.join(' ')} return x; }`);
  }
  return lines.join('\n');
}

describe('clean.anti-tamper: newline tripwire', () => {
  it('removes the whole construct and reports it as self-defending', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, `${NEWLINE_TRIPWIRE}\nkeep();`);
    expectEquivalent(code, 'keep();');
    expect(ctx.detections.map((d) => d.kind)).toContain('self-defending');
  });

  it('removes the variant that hangs with while(1) and carries injected debuggers', async () => {
    const source = `(function () {
      var probe = function () {
        var check = function () { debugger; var re = new RegExp("\\n"); return re["test"](probe); };
        if (check()) { debugger; while (1) {} }
      };
      return probe();
    })();
    keep();`;
    const { code } = await runPass(removeAntiTamperPass, source);
    expectEquivalent(code, 'keep();');
  });

  it('reads the pattern through an alias, the way the fixture writes it', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `(function () {
        var pattern = new RegExp("\\n");
        var guard = function () { if (pattern["test"](guard)) { while (true) {} } };
        return guard();
      })();
      keep();`,
    );
    expectEquivalent(code, 'keep();');
  });

  // The pattern is what separates a formatting probe from ordinary matching, so
  // a pattern that could be matching data disqualifies the construct outright.
  it('keeps a self-test whose pattern matches real data rather than layout', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `(function () {
        var validate = function () {
          var re = new RegExp("token");
          if (re["test"](validate)) { while (true) {} }
        };
        return validate();
      })();`,
    );
  });

  it('keeps a check on a function handed in from outside', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `(function (fn) {
        var re = new RegExp("\\n");
        if (re["test"](fn)) { for (;;) {} }
      })(handler);`,
    );
  });

  it('keeps a wrapper that also does real work', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `(function () {
        var probe = function () {
          var re = new RegExp("\\n");
          if (re["test"](probe)) { for (;;) {} }
        };
        probe();
        boot();
      })();`,
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(removeAntiTamperPass, `${NEWLINE_TRIPWIRE}\nkeep();`);
  });
});

describe('clean.anti-tamper: domain lock', () => {
  it('removes a void-invoked lock and leaves the program', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, `${DOMAIN_LOCK}\nboot();`);
    expectEquivalent(code, 'boot();');
    expect(ctx.detections.map((d) => d.kind)).toContain('self-defending');
  });

  it('removes the parenthesised-IIFE spelling too', async () => {
    const source = `(function () {
      var host = location.hostname["toLowerCase"]();
      var ok = host === "example.com";
      if (!ok) { while (1) {} }
    })();
    boot();`;
    const { code } = await runPass(removeAntiTamperPass, source);
    expectEquivalent(code, 'boot();');
  });

  it('removes a lock that parses the host out of location.href', async () => {
    const source = `void function () {
      var url = location.href["toLowerCase"]();
      var at = url["indexOf"]("://");
      var host = (at === -1 ? url : url["slice"](at + 3))["split"]("/")[0];
      if (host !== String["fromCharCode"](97)) { for (;;) {} }
    }();
    boot();`;
    const { code } = await runPass(removeAntiTamperPass, source);
    expectEquivalent(code, 'boot();');
  });

  // Reading the hostname is not the signal and must never be treated as one.
  it('keeps a hostname check whose failure branch does something observable', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `(function () {
        var host = location.hostname;
        if (host !== "example.com") { redirect("/blocked"); }
      })();`,
    );
  });

  it('keeps a hostname check with no failure branch at all', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      '(function () { if (location.hostname === "example.com") { enableBeta(); } })();',
    );
  });

  it('keeps a lock whose wrapper also calls out to real code', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `void function () {
        var host = location.hostname;
        track(host);
        if (host !== "example.com") { while (true) {} }
      }();`,
    );
  });

  it('keeps a deliberate spin loop that no guard leads to', async () => {
    await expectNoChange(removeAntiTamperPass, 'function block() { while (true) {} }\nblock();');
  });

  it('is idempotent', async () => {
    await expectIdempotent(removeAntiTamperPass, `${DOMAIN_LOCK}\nboot();`);
  });
});

describe('clean.anti-tamper: source-integrity trampoline', () => {
  it('collapses the stub to the call it guards', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, TRAMPOLINE);
    expectEquivalent(
      code,
      'function impl(a, b) { return a + b; } function shim(a, b) { return impl(a, b); } use(shim);',
    );
    expect(ctx.detections.map((d) => d.kind)).toContain('self-defending');
  });

  it('handles the inverted spelling, where the mismatch branch comes first', async () => {
    const source = `function impl() { return 1; }
    function shim() {
      var digest = impl.k || (impl.k = hash(impl, 7));
      if (digest !== 99) { for (;;) {} } else { return impl(); }
    }`;
    const { code } = await runPass(removeAntiTamperPass, source);
    expectEquivalent(code, 'function impl() { return 1; } function shim() { return impl(); }');
  });

  // Every one of these is a coincidence the real shape does not have, and each
  // on its own is enough to make the rewrite unsound.
  it('refuses a guard whose failure branch does something other than hang', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `function impl() { return 1; }
      function shim() {
        var digest = impl.k || (impl.k = hash(impl, 7));
        if (digest === 99) { return impl(); } else { return fallback(); }
      }`,
    );
  });

  it('refuses a stub that forwards to something other than the digested value', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `function impl() { return 1; }
      function shim() {
        var digest = impl.k || (impl.k = hash(impl, 7));
        if (digest === 99) { return other(); } else { while (true) {} }
      }`,
    );
  });

  it('refuses a stub whose forwarding branch also does real work', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `function impl() { return 1; }
      function shim() {
        var digest = impl.k || (impl.k = hash(impl, 7));
        if (digest === 99) { audit(); return impl(); } else { while (true) {} }
      }`,
    );
  });

  it('refuses a memoised value that is not a digest of the forwarded function', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `function impl() { return 1; }
      function shim() {
        var cached = impl.k || (impl.k = compute(7));
        if (cached === 99) { return impl(); } else { while (true) {} }
      }`,
    );
  });

  it('refuses a comparison against something that is not a constant', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      `function impl() { return 1; }
      function shim() {
        var digest = impl.k || (impl.k = hash(impl, 7));
        if (digest === expected) { return impl(); } else { while (true) {} }
      }`,
    );
  });

  it('is idempotent: the collapsed stub is no longer a trampoline', async () => {
    await expectIdempotent(removeAntiTamperPass, TRAMPOLINE);
  });
});

describe('clean.anti-tamper: debugger flood', () => {
  it('removes an injected flood', async () => {
    const { code, ctx } = await runPass(removeAntiTamperPass, flooded(24));
    expect(code).not.toContain('debugger');
    expect(code).toContain('return x;');
    assertParses(code);
    const flood = ctx.detections.find((d) => d.kind === 'debug-protection');
    expect(flood?.count).toBe(24);
  });

  it('keeps the one or two debugger statements a human wrote', async () => {
    await expectNoChange(
      removeAntiTamperPass,
      'function a(x) { debugger; return x; }\nfunction b(y) { debugger; return y; }',
    );
  });

  it('keeps a debugger a human parked in the middle of a flooded file', async () => {
    const { code } = await runPass(
      removeAntiTamperPass,
      `${flooded(24)}\nfunction audit(x) { prepare(x); debugger; return x; }`,
    );
    expect(code.match(/debugger/g)).toHaveLength(1);
    expect(code).toContain('prepare(x);');
  });

  // Volume alone is not evidence: what makes it mechanical is that the keyword
  // lands in the same place every time, across the whole file.
  it('keeps 24 debugger statements that are not uniformly positioned', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 24; i++) lines.push(`function work${i}(x) { setup(x); debugger; return x; }`);
    await expectNoChange(removeAntiTamperPass, lines.join('\n'));
  });

  it('keeps a flood that never spreads beyond a handful of functions', async () => {
    // 4 functions, 6 leading debuggers each: uniform, plentiful, and still the
    // shape of someone stepping through four functions rather than a transform.
    await expectNoChange(removeAntiTamperPass, flooded(4, 5));
  });

  it('is idempotent', async () => {
    await expectIdempotent(removeAntiTamperPass, flooded(24));
  });
});

describe.skipIf(!HEAVY3_FIXTURE.present)('clean.anti-tamper: obfuscated3.js', () => {
  it('clears every anti-tamper family the protector uses', async () => {
    const source = HEAVY3_FIXTURE.read();
    const { code, ctx } = await runPass(removeAntiTamperPass, source);
    assertParses(code);

    // Input counts, so a drift in the fixture shows up as a failure here rather
    // than as a silently weaker test.
    expect(source.match(/\bdebugger\b/g)).toHaveLength(448);
    expect(source.match(/namedFunction/g)).toHaveLength(78);

    expect(code).not.toContain('debugger');
    expect(code).not.toContain('namedFunction');
    expect(code).not.toContain('app.example.com');
    expect(code).not.toContain('while (true) {}');
    expect(code).not.toContain('for (;;) {}');
    // Every `location` read in the file lives inside a domain lock.
    expect(code).not.toContain('location');

    expect(ctx.detections.map((d) => d.kind)).toContain('self-defending');
    expect(ctx.detections.map((d) => d.kind)).toContain('debug-protection');
  });
});
