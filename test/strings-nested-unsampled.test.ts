import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * A candidate declared below program scope and called, but never with a
 * literal argument, is put up again on later rounds the way a top-level one
 * is: the argument is not opaque, only not yet a literal, and the round after
 * the object-map pass exposes it is when the candidate becomes provable, with
 * the rotation in its slice. The shape is `strings-retry-unsampled`'s inside
 * one function.
 *
 * Every case runs input and output in a fresh realm with only `log` and
 * compares the traces.
 */
function execute(code: string): string {
  const trace: string[] = [];
  try {
    vm.runInNewContext(code, vm.createContext({ log: (...args: unknown[]) => trace.push(args.map(String).join(' ')) }), {
      timeout: 5_000,
    });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(', ');
}

const NESTED_PROXIED_ROTATION = `
  (function () {
    function a() {
      var z = ['1', '2', '3', 'fn:'];
      a = function () { return z; };
      return a();
    }
    function b(P) {
      P = P - 296;
      var U = a(), w = U[P];
      return w;
    }
    var w = { push: 'push', shift: 'shift', call: function (q) { return q(); }, apply: function (q, M) { return q(M); } };
    (function (z, U) {
      var k = {};
      k.c = 0x128;
      var X = k, O = b, C = w.call(z);
      while (true) {
        try {
          var p = parseInt(w.apply(O, X.c)) / 1;
          if (p === U) break; else C[w.push](C[w.shift]());
        } catch (q) {
          C[w.push](C[w.shift]());
        }
      }
    })(a, 3);
    function classify(z) {
      var l = {};
      l.c = 0x12b;
      var U = l;
      return b(U.c) + z.name;
    }
    log(classify(function nm() {}));
  })();
`;

const ADOPTED = /^b was deferred or refused on an earlier round and has since been proved/;
const NONE_USABLE = /^Found \d+ string-array shape\(s\) but none produced a usable decoder\.$/;

describe('strings.discover: a nested candidate refused for want of a sample is retried', () => {
  it('conservative leaves the site encoded', async () => {
    const { code } = await deobfuscate(NESTED_PROXIED_ROTATION, { preset: 'conservative' });
    expect(execute(code)).toBe(execute(NESTED_PROXIED_ROTATION));
    expect(code).toMatch(/function b\(/);
    expect(code).toMatch(/b\(U\.c\)/);
  });

  it.each(['balanced', 'aggressive'] as const)(
    '%s decodes the site on the round after the map is inlined, with the rotation seen',
    async (preset) => {
      const { code, metadata } = await deobfuscate(NESTED_PROXIED_ROTATION, { preset });
      expect(execute(code)).toBe(execute(NESTED_PROXIED_ROTATION));
      expect(code).toMatch(/'2'\s*\+/);
      expect(code).not.toContain("'fn:'");
      expect(code).not.toMatch(/\bparseInt\b/);
      const lines = metadata.diagnostics.map((d) => d.message);
      expect(lines.filter((m) => ADOPTED.test(m))).toHaveLength(1);
      // A round that adopts withdraws the round-end count of shapes none of
      // which produced a decoder: the output bears it out no longer.
      expect(lines.some((m) => NONE_USABLE.test(m))).toBe(false);
    },
  );
});
