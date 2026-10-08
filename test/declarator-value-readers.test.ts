import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

/**
 * Three ways a pass can trust a declarator for more than it says, each of
 * which parsed, ran and printed a different trace from the input at every
 * preset. A destructured declarator gives its name a piece of the
 * initialiser, not the whole; a string statement at the head of a body is a
 * directive once whatever stood ahead of it is removed; and an object
 * literal's getter or `valueOf` in a declaration prefix runs when a later
 * declarator reads or coerces it, before the declarators after it hold
 * anything.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  const sandbox = { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) };
  try {
    vm.runInNewContext(code, sandbox, { timeout: 2_000 });
  } catch (error) {
    lines.push(`THROWN ${error instanceof Error ? error.name : String(error)}`);
  }
  return lines.join(' | ');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

function sameTrace(title: string, source: string): void {
  for (const preset of PRESETS) {
    it(`${title} (${preset})`, async () => {
      const code = await output(source, preset);
      expect(trace(code)).toBe(trace(source));
    });
  }
}

describe('a destructured declarator', () => {
  sameTrace('is not the object it destructures', "var {a} = {a: 0}; if (!a) log('zero'); log(typeof a);");
  sameTrace('is not the array it destructures', 'var [b] = [1]; log(typeof b);');
  sameTrace('is not the function whose length it takes', 'var {length} = function (a, b) { return a; }; try { log(length(1, 2)); } catch (e) { log(e.name); }');
  sameTrace('is not the function whose name it takes', 'var {name} = function foo(a) { return a + 1; }; try { log(name(1)); } catch (e) { log(e.name); }');
  sameTrace('is not the table it takes an element of', "var {0: T} = [['x', 'y']]; log(T.slice(0, 1).join(''));");
});

describe('a string statement at the head of a body', () => {
  sameTrace('stays a statement when the value statement ahead of it is removed', 'var x = 1; function f() { x; "use strict"; return this; } log(f() === undefined);');
  sameTrace('stays a statement when the sequence it led is expanded', 'function a() {} function h() { ("use strict", a()); return this; } log(h() === undefined);');
  sameTrace('stays a statement when the unused declaration ahead of it is removed', 'function g() { var unused = 1; "use strict"; return this; } log(g() === undefined);');
  sameTrace('stays a statement at the top of a script', '1; "use strict"; log(function () { return this; }() === undefined);');

  it('prints as a parenthesised statement, and a directive the input had as a directive', async () => {
    const code = await output('function f() { "use strict"; return this; } function g() { 0; "use strict"; return this; }', 'balanced');
    expect(code).toContain('  "use strict";');
    expect(code).toContain('("use strict");');
  });
});

describe('a declaration prefix that holds a method', () => {
  sameTrace(
    'runs its getter before the declarators after it',
    "function main() { var o = { get x() { return f(); } }, y = o.x, T = ['alpha', 'beta']; function f() { if (!T) return 'unset'; return typeof T; } return y; } log(main());",
  );
  sameTrace(
    'runs its valueOf under an operator before the declarators after it',
    "function main() { var o = { valueOf: function () { return f(); } }, y = +o, T = ['alpha', 'beta']; function f() { if (!T) return 0; return T.length; } return y; } log(main());",
  );
  sameTrace(
    'runs its getter through an earlier statement of the prefix',
    "function main() { var o = { get x() { return f(); } }; var y = o.x, T = ['alpha', 'beta']; function f() { if (!T) return 'unset'; return typeof T; } return y; } log(main());",
  );
  sameTrace(
    'runs its toString as a computed key',
    "function main() { var o = { toString: function () { return f(); } }, y = ({})[o], T = ['alpha', 'beta']; function f() { if (!T) return 'unset'; return typeof T; } return y; } log(main());",
  );

  it('still folds a prefix of plain values', async () => {
    const source = "function main() { var a = 1, b = 'x', c = [a, b], d = { k: c }, y = d.k, T = ['alpha', 'beta']; function f() { if (!T) return 'unset'; return typeof T; } return f() + y.length; } log(main());";
    const code = await output(source, 'balanced');
    expect(code).not.toContain("'unset'");
    expect(trace(code)).toBe(trace(source));
  });
});
