import { validateOptions } from '../config/validate.js';
import type { DeobfuscateOptions, DeobfuscateResult, Progress } from '../types.js';

/**
 * Options minus the parts that cannot cross a `postMessage` boundary.
 * `onProgress` becomes a message stream; `signal` becomes `terminate()`, which
 * is why there is no cancel request below.
 */
export type TransferableOptions = Omit<DeobfuscateOptions, 'onProgress' | 'signal'>;

export type WorkerRequest = {
  type: 'run';
  id: number;
  source: string;
  options: TransferableOptions;
};

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: Progress }
  | { type: 'done'; id: number; result: DeobfuscateResult }
  | { type: 'error'; id: number; message: string; stack?: string };

/**
 * Strip non-cloneable fields so `postMessage` cannot throw a DataCloneError.
 *
 * Type-checked first, the way `deobfuscate` checks its options, because the
 * worker on the other side never gets to: `signal` and `onProgress` are
 * removed here and read only on this side, and anything else wrong-typed
 * would cross the boundary, fail inside `deobfuscate` there and come back as
 * a plain `Error` carrying the message and nothing else. `null` and
 * `undefined` are both "no options"; destructuring `null` was the opaque
 * failure a JavaScript caller used to get, and a string spread into a
 * character-indexed object that the worker then rejected.
 */
export function toTransferable(options: DeobfuscateOptions | null = {}): TransferableOptions {
  const { onProgress: _onProgress, signal: _signal, ...rest } = validateOptions(options);
  return rest;
}
