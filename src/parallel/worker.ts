/**
 * Worker entry point.
 *
 * The browser's single most valuable form of parallelism here is not splitting
 * the AST - a syntax tree is a shared mutable graph and does not shard - it is
 * getting the entire engine off the UI thread so a 4 MB file does not freeze the
 * tab for several seconds. That is what this module provides.
 *
 * Bundlers pick this up as `@jsrift/core/worker`.
 */
import { deobfuscate } from '../index.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

function post(message: WorkerResponse): void {
  (self as unknown as { postMessage(data: unknown): void }).postMessage(message);
}

/**
 * There is no cancel message, and adding one would be a protocol nobody can
 * speak: the client terminates the worker in the same task it decides to stop,
 * and `terminate()` discards whatever is still queued here. Cancellation on
 * this side of the boundary is termination.
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const result = await deobfuscate(request.source, {
      ...request.options,
      onProgress: (progress) => post({ type: 'progress', id: request.id, progress }),
    });
    post({ type: 'done', id: request.id, result });
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};
