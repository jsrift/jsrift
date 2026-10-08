import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions, DeobfuscateResult } from '../src/types.js';

/**
 * The standing error that says a reprinted output will not run is taken back
 * only by the round that removes a guard reprinting trips. A domain lock is
 * of the same family and hangs the same before and after reprinting, so
 * removing one says nothing about the guard the fingerprint saw: the error
 * stands, as it does when there is no lock to remove.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

const FINGERPRINT = "var pat = '(((.+)+)+)+$'; ";
const LOCK =
  "(function () { var host = typeof location === 'object' ? location.hostname : 'example.com'; if (host !== 'example.com') { while (true) {} } })(); ";
const WORK = "log('ok');";

function trace(code: string): string {
  const lines: string[] = [];
  try {
    vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  } catch (error) {
    const err = error as Error & { code?: string };
    lines.push(err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'HANG' : `THROWN ${err.name}: ${err.message}`);
  }
  return lines.join(' | ');
}

function hazardErrors(result: DeobfuscateResult): string[] {
  return result.metadata.diagnostics.filter((d) => d.severity === 'error' && /will not run/.test(d.message)).map((d) => d.message);
}

describe('a domain lock removed beside an unrecognised reprint guard', () => {
  for (const preset of PRESETS) {
    it(`leaves the standing error where the run without the lock leaves it, ${preset}`, async () => {
      const options: DeobfuscateOptions = { preset };
      const withLock = await deobfuscate(FINGERPRINT + LOCK + WORK, options);
      const withoutLock = await deobfuscate(FINGERPRINT + WORK, options);
      expect(trace(withLock.code)).toBe(trace(FINGERPRINT + LOCK + WORK));
      expect(hazardErrors(withoutLock)).toHaveLength(1);
      expect(hazardErrors(withLock)).toHaveLength(1);
    });
  }
});
