import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deobfuscate } from '../src/index.js';

/**
 * A reading rewrites the live tree before the build that judges it. A build
 * that throws instead of answering leaves no reading behind: every rewrite
 * is put back before the throw goes on to the kernel, which disables the
 * pass, so the output is the tree the pass was handed and the run's own
 * guards read it as unchanged because it is.
 *
 * The throw is injected at the one build made over the facts of the
 * rewritten tree - the adoption - and nowhere else.
 */
const fault = vi.hoisted(() => ({ armed: false }));

vi.mock('../src/analysis/evaluator/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/analysis/evaluator/index.js')>();
  return {
    ...actual,
    buildDecoder: (...args: Parameters<typeof actual.buildDecoder>) => {
      const facts = args[3]?.stringCode;
      if (fault.armed && facts?.global && facts.unreadGlobalSource === undefined) {
        throw new RangeError('Maximum call stack size exceeded');
      }
      return actual.buildDecoder(...args);
    },
  };
});

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

// The decoder reads a host name, so an unreadable wrapper refuses it and the
// reading is what adopts it.
const SOURCE = `
  var _0xa = ['return 40 + 2;', 'alpha', 'beta'];
  function _0xd(i) { return _0xa[parseInt(i, 10)]; }
  var f = Function(_0xd('0'));
  log(f(), _0xd('1'), _0xd('2'));
`;

describe('strings.discover: a reading whose adoption throws is put back', () => {
  it('the wrapper keeps its call to the decoder and the pass is reported disabled', async () => {
    fault.armed = true;
    try {
      const { code, metadata } = await deobfuscate(SOURCE, { preset: 'balanced' });
      expect(execute(code)).toBe(execute(SOURCE));
      expect(code).toMatch(/Function\(_0xd\('0'\)\)/);
      expect(code).not.toMatch(/Function\('return 40 \+ 2;'\)/);
      expect(metadata.diagnostics.some((d) => /^Pass disabled after error: Maximum call stack size exceeded/.test(d.message))).toBe(true);
      expect(metadata.passes.find((p) => p.id === 'strings.discover')?.changes ?? 0).toBe(0);
    } finally {
      fault.armed = false;
    }
  });

  it('the same input is read and decoded when the build answers', async () => {
    const { code, metadata } = await deobfuscate(SOURCE, { preset: 'balanced' });
    expect(execute(code)).toBe(execute(SOURCE));
    expect(code).toContain("'alpha'");
    expect(code).not.toMatch(/_0xd\(/);
    expect(metadata.diagnostics.some((d) => /^Read the string code that stood in the way of _0xd/.test(d.message))).toBe(true);
  });
});
