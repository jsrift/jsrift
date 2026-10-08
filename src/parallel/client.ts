import { describeValue, validateOptions } from '../config/validate.js';
import type { DeobfuscateOptions, DeobfuscateResult } from '../types.js';
import { toTransferable, type WorkerRequest, type WorkerResponse } from './protocol.js';

/**
 * The four members of a worker the client uses, spelled out so the published
 * types do not name the DOM's `Worker`. A Node-only consumer compiles with
 * `lib: ["es2022"]` and no DOM, and `createWorker: () => Worker` failed its
 * build inside `node_modules` with nothing it had written in the message. The
 * browser `Worker` and a `worker_threads` adapter both satisfy this.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

export interface WorkerClientOptions {
  /**
   * Factory for the worker. Bundler-specific, so the caller supplies it:
   *
   * ```ts
   * () => new Worker(new URL('jsrift/worker', import.meta.url), { type: 'module' })
   * ```
   */
  createWorker: () => WorkerLike;
}

/**
 * Runs the engine on a worker thread, keeping the calling thread responsive.
 *
 * The worker is created per call and terminated when the run settles. A pool
 * would be wrong here: runs are long and infrequent, and a stale worker holding
 * a 400k-node AST is a memory leak the user cannot see.
 */
export class WorkerClient {
  private nextId = 1;

  constructor(private readonly options: WorkerClientOptions) {}

  run(source: string, options: DeobfuscateOptions = {}): Promise<DeobfuscateResult> {
    // Everything `deobfuscate` would reject is rejected here first, before a
    // worker exists to spend a start-up on it. That is the only place two of
    // the options can be checked at all: `signal` and `onProgress` never
    // cross to the worker, and they are read below as if they were what the
    // types say - an `options` of `null` failed on the first of those reads
    // with nothing a caller could act on. The rest could be left to the
    // worker's `deobfuscate`, but its `TypeError` comes back over the wire as
    // a plain `Error` with the message alone, so the check runs here where
    // the type survives. Rejected, never thrown: `run` returns a promise and
    // a caller's `.catch` is where its failures are expected.
    try {
      if (typeof source !== 'string') {
        throw new TypeError(
          `WorkerClient.run() expects the source as a string, received ${describeValue(source)}. ` +
            'Read the file with an encoding (fs.readFileSync(path, "utf8")) or call String() on it first.',
        );
      }
      options = validateOptions(options);
    } catch (error) {
      return Promise.reject(error);
    }

    // The signal does not cross to the worker - `toTransferable` strips it -
    // so an abort that has already happened has to be answered here, before
    // a worker exists to spend a full run on it.
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const worker = this.options.createWorker();
    const id = this.nextId++;

    return new Promise<DeobfuscateResult>((resolve, reject) => {
      const settle = (fn: () => void) => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        options.signal?.removeEventListener('abort', onAbort);
        worker.terminate();
        fn();
      };

      const onMessage = (event: { data: unknown }) => {
        const message = event.data as WorkerResponse;
        if (message.id !== id) return;
        if (message.type === 'progress') {
          options.onProgress?.(message.progress);
        } else if (message.type === 'done') {
          settle(() => resolve(message.result));
        } else {
          settle(() => reject(new Error(message.message)));
        }
      };

      const onError = (event: { message?: string }) => {
        settle(() => reject(new Error(event.message || 'Worker failed')));
      };

      // Termination IS the cancellation mechanism, and there is no handshake to
      // add. `settle` calls `worker.terminate()` in this same task, and per spec
      // that sets the terminated flag and discards the event queue, so a
      // `{ type: 'cancel' }` posted here could never be read on the other side -
      // it would only buy a dead branch in the worker documenting a protocol
      // that does not exist.
      const onAbort = () => {
        settle(() => reject(new DOMException('Aborted', 'AbortError')));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      // A `DataCloneError` here - an option value the structured clone cannot
      // carry - rejects like any other failure, and through `settle`, so the
      // worker it would otherwise orphan is terminated with the listeners gone.
      try {
        worker.postMessage({
          type: 'run',
          id,
          source,
          options: toTransferable(options),
        } satisfies WorkerRequest);
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }
}

/** True when the current environment can host a module worker. */
export function workersAvailable(): boolean {
  return typeof Worker !== 'undefined';
}
