import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { runPass } from './helpers.js';

/**
 * `replacesSplit` recognised `String.prototype.split = f` and refused the
 * dispatcher, because the order array is read by running THIS process's
 * `split` on the literal that spells it. The same replacement with its key
 * routed through a table the analysis cannot read - `String.prototype[_0xk()]
 * = f` - never became a literal on any round, matched no shape, and the
 * dispatcher was recovered against the intrinsic: `A B C` for a program that
 * prints `C B A`, `verified: true`, no diagnostic.
 *
 * An assignment to a computed, unreadable member of `String.prototype` is a
 * shape no bundle carries - a polyfill spells the name it installs - so every
 * one now counts as a replacement. A computed key the analysis CAN read is
 * matched by name as before, and stops nothing unless it spells `split`.
 */

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
    trace.push(`THROWN ${err.name}`);
  }
  return trace.join(' | ');
}

/** `case '0'` logs A, `'1'` B, `'2'` C, so the trace names the order. */
const MACHINE = `function run() {
  var _0xorder = '0|1|2'.split('|'), _0xi = 0;
  while (true) {
    switch (_0xorder[_0xi++]) {
      case '0': log('A'); continue;
      case '1': log('B'); continue;
      case '2': log('C'); continue;
    }
    break;
  }
}
run();`;

/** The method name is assembled at run time, so no round can read it. */
const UNREADABLE_KEY = `var _0xtab = [String.fromCharCode(Date.now() > 0 ? 115 : 0) + 'plit'];
function _0xk() { return _0xtab[0]; }
String.prototype[_0xk()] = function () { return ['2', '1', '0']; };
${MACHINE}`;

describe('a `split` replaced through a computed key the analysis cannot read', () => {
  it('refuses the dispatcher rather than recovering it against the intrinsic', async () => {
    expect(execute(UNREADABLE_KEY)).toBe('C | B | A');
    const { code } = await runPass(unflattenControlFlowPass, UNREADABLE_KEY);
    expect(execute(code)).toBe('C | B | A');
    expect(code).toContain('switch');
  });

  it('holds through deobfuscate() at every preset', async () => {
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { code } = await deobfuscate(UNREADABLE_KEY, { preset });
      expect(execute(code)).toBe('C | B | A');
    }
  });

  it('counts `String["prototype"][k]` the same way', async () => {
    const bracketed = UNREADABLE_KEY.replace('String.prototype[_0xk()]', "String['prototype'][_0xk()]");
    expect(execute(bracketed)).toBe('C | B | A');
    const { code } = await runPass(unflattenControlFlowPass, bracketed);
    expect(execute(code)).toBe('C | B | A');
  });

  it('control: a readable computed key that is not `split` still lets the dispatcher go', async () => {
    const harmless = `String.prototype['shout'] = function () { return this.toUpperCase(); };
${MACHINE}`;
    expect(execute(harmless)).toBe('A | B | C');
    const { code } = await runPass(unflattenControlFlowPass, harmless);
    expect(execute(code)).toBe('A | B | C');
    expect(code).not.toContain('switch');
  });

  it('control: an unreadable key on some other prototype is not a `split` replacement', async () => {
    const other = `var _0xtab = ['shout'];
function _0xk() { return _0xtab[0]; }
Array.prototype[_0xk()] = function () { return this.length; };
${MACHINE}`;
    expect(execute(other)).toBe('A | B | C');
    const { code } = await runPass(unflattenControlFlowPass, other);
    expect(execute(code)).toBe('A | B | C');
    expect(code).not.toContain('switch');
  });
});
