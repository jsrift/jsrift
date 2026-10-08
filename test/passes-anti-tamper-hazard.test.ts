import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { obfuscate } from 'javascript-obfuscator';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult } from '../src/types.js';

/**
 * A self-defending guard reads the program's own printed source and hangs when
 * the text is not the one it was built with. Reprinting is the one thing this
 * engine always does, so an output that still carries the guard does not run,
 * whatever else was done to it - and `verified: true` says only that it parses.
 *
 * The guard therefore goes at every preset: `clean.reprint-guards` removes it
 * where `antiTamperRemoval` is off, because the input runs and an output that
 * hangs is not the input's behaviour. A run cut short before the `clean`
 * stage reached the guard still ships the output; what it owes the reader is
 * an error that says the file will not run and names what removes the guard.
 */

const SOURCE = `function greet(name) { return 'Hello, ' + name + '!'; } console.log(greet('World'));`;

function selfDefending(): string {
  return obfuscate(SOURCE, {
    selfDefending: true,
    compact: true,
    stringArray: true,
    stringArrayThreshold: 1,
    seed: 20260904,
  }).getObfuscatedCode();
}

/** What the program prints, or `HANG` when it does not return within the limit. */
function execute(code: string): string {
  const out: string[] = [];
  const sandbox: Record<string, unknown> = { console: { log: (...a: unknown[]) => out.push(a.join(' ')) } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 3_000 });
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'HANG';
    return `THROWN ${err.name}: ${err.message}`;
  }
  return out.join('\n');
}

function hazardErrors(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics
    .filter((d) => d.severity === 'error' && /will not run/.test(d.message))
    .map((d) => d.message);
}

describe('a self-defending guard that survives the run is reported as an error', () => {
  it('the fixture: the input runs, the reprinted form hangs', () => {
    const input = selfDefending();
    expect(execute(input)).toBe('Hello, World!');
  });

  it('conservative removes the guard too, and the output runs with no such error', async () => {
    const result = await deobfuscate(selfDefending(), { preset: 'conservative' });
    expect(execute(result.code)).toBe('Hello, World!');
    expect(result.metadata.stats.verified).toBe(true);
    expect(hazardErrors(result)).toHaveLength(0);
    expect(result.code).not.toContain('(((.+)+)+)+$');
    // The removal is the core pass's, not the technique's, which stays off.
    expect(result.metadata.passes.some((p) => p.id === 'clean.reprint-guards' && p.changes > 0)).toBe(true);
    expect(result.metadata.passes.some((p) => p.id === 'clean.anti-tamper' && p.changes > 0)).toBe(false);
  });

  it('a run aborted before `clean` ran on the exposed guard says so, once', async () => {
    const controller = new AbortController();
    const result = await deobfuscate(selfDefending(), {
      preset: 'balanced',
      signal: controller.signal,
      onProgress: (progress) => {
        // `strings` has decoded the guard's constants by now; nothing has
        // removed it, and nothing will.
        if (progress.stage === 'simplify') controller.abort();
      },
    });
    expect(result.metadata.stats.truncated).toBe(true);
    expect(execute(result.code)).toBe('HANG');
    const errors = hazardErrors(result);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/clean\.anti-tamper/);
    expect(errors[0]).toMatch(/truncated/);
  });

  it('a full balanced run removes the guard and carries no such error', async () => {
    const result = await deobfuscate(selfDefending(), { preset: 'balanced' });
    expect(result.metadata.stats.truncated).toBe(false);
    expect(execute(result.code)).toBe('Hello, World!');
    expect(hazardErrors(result)).toHaveLength(0);
    // The detection itself is still reported: it describes the input.
    expect(result.metadata.detections.some((d) => d.kind === 'self-defending')).toBe(true);
  });

  it('a guard whose failure branch merely hangs is not a reprint hazard', async () => {
    // A domain lock hangs on the same condition before and after reprinting;
    // reformatting changes nothing about it, so no error is owed.
    const lock = `
      var host = typeof location === 'object' ? location.hostname : 'example.com';
      if (host !== 'example.com') { while (true) {} }
      console.log('locked ok');
    `;
    const result = await deobfuscate(lock, { preset: 'conservative' });
    expect(execute(result.code)).toBe('locked ok');
    expect(hazardErrors(result)).toHaveLength(0);
  });
});
