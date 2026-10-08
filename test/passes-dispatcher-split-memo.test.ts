import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * `analyzeDispatcher` refuses a dispatcher whose order array is read through
 * `.split(...)` when the program installs its own `split`. The question is asked
 * per dispatcher and the answer memoised per program - and it used to be
 * memoised for the whole run, on the claim that a later pass can only delete
 * such an assignment, never introduce one. Proxy inlining introduces one: the
 * key `String.prototype[k()] = ...` is written under becomes the literal `split`
 * on a later fixpoint round, after the dispatchers that read it were already
 * judged against a memoised `false`. The output then runs its cases in the
 * order this process's `split` gave, not the program's.
 */

function execute(code: string): string {
  const out: string[] = [];
  const sandbox: Record<string, unknown> = { console: { log: (...a: unknown[]) => out.push(a.join(' ')) } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    const err = error as Error;
    out.push(`THROWN ${err.name}: ${err.message}`);
  }
  return out.join(' ');
}

/** The key and the order string each come out of a flattened function of their own. */
const POISONED_BEHIND_DISPATCHERS = `
function _0xk() {
  var _0xs = '1|0'.split('|'), _0xi = 0;
  while (!![]) { switch (_0xs[_0xi++]) { case '0': return 'spl' + 'it'; case '1': var _0xu = 0; continue; } break; }
}
function _0xo() {
  var _0xs = '1|0'.split('|'), _0xi = 0;
  while (!![]) { switch (_0xs[_0xi++]) { case '0': return '0|1|2'; case '1': var _0xv = 0; continue; } break; }
}
var _0xorig = String.prototype.split;
String.prototype[_0xk()] = function (_0xsep) { var r = _0xorig.call(this, _0xsep); return r.length === 3 ? r.reverse() : r; };
function _0xmain() {
  var _0xs3 = _0xo().split('|'), _0xn = 0;
  while (!![]) { switch (_0xs3[_0xn++]) { case '0': console.log('A'); continue; case '1': console.log('B'); continue; case '2': console.log('C'); continue; } break; }
}
_0xmain();
`;

describe('structure.control-flow: a `split` replacement exposed on a later round', () => {
  it('the fixture runs its cases in the poisoned order', () => {
    expect(execute(POISONED_BEHIND_DISPATCHERS)).toBe('C B A');
  });

  for (const preset of ['balanced', 'aggressive'] as const) {
    it(`${preset} output preserves that order`, async () => {
      const result = await deobfuscate(POISONED_BEHIND_DISPATCHERS, { preset });
      expect(result.metadata.stats.verified).toBe(true);
      expect(execute(result.code), result.code).toBe('C B A');
    });
  }

  it('a literal replacement is refused on the first round, as before', async () => {
    const literal = POISONED_BEHIND_DISPATCHERS.replace('String.prototype[_0xk()]', 'String.prototype.split');
    expect(execute(literal)).toBe('C B A');
    const result = await deobfuscate(literal, { preset: 'balanced' });
    expect(execute(result.code)).toBe('C B A');
    expect(
      result.metadata.diagnostics.some((d) => /replaces `split`/.test(d.message)),
    ).toBe(true);
  });
});
