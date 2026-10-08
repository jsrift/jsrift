import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * Shapes from the public deobfuscator corpora (webcrack's and restringer's
 * obfuscator.io samples), reduced to the construct each turns on. Every case
 * executes the input and the output in a realm with `log` and compares the
 * traces, at the presets the rewrite is made under.
 */
function execute(code: string): string {
  const out: string[] = [];
  try {
    vm.runInNewContext(code, vm.createContext({ log: (...a: unknown[]) => out.push(a.map(String).join(' ')) }), {
      timeout: 5_000,
    });
  } catch (error) {
    out.push(`THROWN ${(error as Error).name}`);
  }
  return out.join('\n');
}

const ALL: PresetName[] = ['conservative', 'balanced', 'aggressive'];

/** The self-replacing table and decoder every obfuscator.io build opens with. */
const TABLE = `
  function a() { var h = ['Hello World!', 'log', 'warn']; a = function () { return h; }; return a(); }
  function b(c, d) { var e = a(); return b = function (f, g) { f = f - 0xce; var h = e[f]; return h; }, b(c, d); }
`;

describe('call arguments that are names holding one literal (webcrack decode-external-vars)', () => {
  const SOURCE = `${TABLE}
    function hi() {
      let x;
      const y = 0xce;
      x = 0xcf;
      log(b(x), b(y));
      log(b(x), b(y));
    }
    hi();
  `;

  it.each(ALL)('%s reads the constant through the name and inlines the site', async (preset) => {
    const { code, metadata } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).toContain("'Hello World!'");
    expect(code).not.toMatch(/\bb\((x|y)\)/);
    expect(metadata.strings.length).toBeGreaterThanOrEqual(2);
  });

  it('a read ahead of the single write is left as written', async () => {
    // The loop body reads `x` before the statement that writes it on the
    // first pass: `b(x)` is `b(undefined)` then, and no literal stands for it.
    const source = `${TABLE}
      function hi() {
        let x;
        for (var i = 0; i < 2; i++) { try { log(b(x)); } catch (e) { log('no'); } x = 0xce; }
      }
      hi();
    `;
    const { code } = await deobfuscate(source, { preset: 'balanced' });
    expect(execute(code)).toBe(execute(source));
    expect(code).toMatch(/\bb\(x\)/);
  });

  it('a read inside a nested function is left as written', async () => {
    const source = `${TABLE}
      function hi() {
        let x;
        const read = function () { return b(x); };
        try { log(read()); } catch (e) { log('no'); }
        x = 0xce;
        log(read());
      }
      hi();
    `;
    const { code } = await deobfuscate(source, { preset: 'balanced' });
    expect(execute(code)).toBe(execute(source));
    expect(code).toMatch(/\bb\(x\)/);
  });
});

describe('an object map extended by property writes before any read (webcrack control-flow-partial-keys)', () => {
  const SOURCE = `
    function hi() {
      const m = { lt: function (p, q) { return p < q; } };
      m.RLGat = 'Hello World!';
      const alias = m;
      const one = 1, two = 2;
      if (alias.lt(one, two)) log(alias.RLGat);
    }
    hi();
  `;

  it.each(['balanced', 'aggressive'] as PresetName[])('%s takes the writes as entries and inlines every read', async (preset) => {
    const { code } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).not.toMatch(/\bRLGat\b/);
    expect(code).not.toMatch(/\blt\b/);
    expect(code).toContain("'Hello World!'");
  });

  it('a write after a read keeps the map whole', async () => {
    const source = `
      function hi() {
        const m = { k: 'first' };
        log(m.k);
        m.k = 'second';
        log(m.k);
      }
      hi();
    `;
    const { code } = await deobfuscate(source, { preset: 'balanced' });
    expect(execute(code)).toBe(execute(source));
    expect(code).toMatch(/m\.k = 'second'|k: 'first'/);
  });
});

describe('a statement that evaluates to nothing (webcrack calls-transform)', () => {
  const SOURCE = `
    function foo() {
      var k = { c: 0xce, d: 0xcf };
      var unused1 = i(k.c);
      var unused2 = i(k.d);
      function i(c) { return b(c); }
      return 'done';
    }
    ${TABLE}
    log(foo());
  `;

  it.each(['balanced', 'aggressive'] as PresetName[])('%s leaves no bare literal statement where a dead proxy call stood', async (preset) => {
    const { code } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).not.toMatch(/^\s*'[^']*';\s*$/m);
  });

  it.each(ALL)('%s removes a literal or bound-name statement and keeps a directive', async (preset) => {
    const source = `
      function f() {
        'use strict';
        'not a directive';
        var v = 1;
        v;
        'dead';
        return v;
      }
      log(f());
    `;
    const { code } = await deobfuscate(source, { preset });
    expect(execute(code)).toBe(execute(source));
    expect(code).toMatch(/["']use strict["']/);
    expect(code).not.toMatch(/["']dead["']/);
    expect(code).not.toMatch(/^\s*v;\s*$/m);
  });

  it('an unbound name is not a no-op: the read throws', async () => {
    const source = `try { undeclaredName; log('reached'); } catch (e) { log(e.name); }`;
    const { code } = await deobfuscate(source, { preset: 'balanced' });
    expect(execute(code)).toBe('ReferenceError');
    expect(code).toContain('undeclaredName;');
  });
});

describe('a conditional of literals as the decoder argument (webcrack obfuscator.io)', () => {
  const SOURCE = `${TABLE}
    function hi(p, q) {
      log(b(p ? 0xce : 0xcf));
      log(b(q ? 0xd0 : p ? 0xce : 0xcf), b(p ? 0xcf : 0xce, 'unused'));
    }
    hi(true, false); hi(false, true); hi(false, false);
  `;

  it.each(ALL)('%s puts the test outside the call and a literal in each arm', async (preset) => {
    const { code, metadata } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).not.toMatch(/\bb\(/);
    // The parameters keep their names except at aggressive, whose typed fallback renames them.
    expect(code).toMatch(/\b\w+ \? 'Hello World!' : 'log'/);
    expect(code).toMatch(/\b\w+ \? 'warn' : \w+ \? 'Hello World!' : 'log'/);
    expect(metadata.strings.length).toBeGreaterThanOrEqual(3);
    expect(metadata.diagnostics.some((d) => /had non-constant arguments/.test(d.message))).toBe(false);
  });

  it('leaves a test that could rebind the decoder as written', async () => {
    // The call reads `b` before its arguments run; distributed, the test
    // would run first. A test that can write anything stays where it is.
    const source = `${TABLE}
      var seen = 0;
      function bump() { seen++; return seen > 1; }
      log(b(bump() ? 0xce : 0xcf), b(bump() ? 0xce : 0xcf), seen);
    `;
    for (const preset of ALL) {
      const { code } = await deobfuscate(source, { preset });
      expect(execute(code)).toBe(execute(source));
      expect(code).toMatch(/\b\w+\(bump\(\) \? /);
    }
  });
});

describe('a table read only for its truthiness is a read (restringer prototypeCalls)', () => {
  const SOURCE = `
    var T = ['charAt', 'slice', 'Hello'];
    if (!T) log('no table');
    if (typeof T === 'object' && T !== null) log(T[2]);
    log(T ? T[0] : 'none', T[1]);
  `;

  it.each(ALL)('%s inlines the constant reads beside the tests', async (preset) => {
    const { code } = await deobfuscate(SOURCE, { preset });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).toContain("'Hello'");
    expect(code).not.toMatch(/T\[[0-9]\]/);
  });

  it('a table handed on as a value is still refused', async () => {
    const source = `
      var T = ['a', 'b'];
      function take(arr) { arr[0] = 'z'; }
      take(T);
      log(T[0]);
    `;
    const { code } = await deobfuscate(source, { preset: 'balanced' });
    expect(execute(code)).toBe('z');
    expect(code).toMatch(/T\[0\]|arr\[0\]/);
  });
});
