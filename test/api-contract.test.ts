import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate, listPasses, resolveConfig, toTransferable, WorkerClient } from '../src/index.js';
import type { WorkerLike } from '../src/parallel/client.js';
import type { DeobfuscateOptions, Progress } from '../src/types.js';

const SAMPLE = [
  "var _0xa = ['alpha', 'beta', 'gamma'];",
  'function _0xd(i) { return _0xa[i]; }',
  'function _0xrun(_0xn) {',
  '  var _0xo = [];',
  '  for (var _0xi = 0; _0xi < _0xn; _0xi++) { _0xo.push(_0xd(_0xi % 3)); }',
  "  return _0xo.join(',');",
  '}',
  'console.log(_0xrun(5));',
].join('\n');

/** An obfuscator.io sample whose rotation loop takes three fixpoint rounds to settle. */
const ROTATING = readFileSync(new URL('./fixtures/rotation-in-sequence.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('onProgress', () => {
  it('reports a completed fraction that never goes backwards across fixpoint rounds', async () => {
    const events: Progress[] = [];
    const result = await deobfuscate(ROTATING, { preset: 'aggressive', onProgress: (p) => events.push(p) });
    // The fraction was computed from the stage index alone, so every round
    // after the first dropped it from `clean` back to `strings`.
    expect(result.metadata.stats.iterations).toBeGreaterThan(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.completed).toBeGreaterThanOrEqual(events[i - 1]!.completed);
    }
    expect(events[0]!.stage).toBe('parse');
    expect(events[0]!.completed).toBe(0);
    expect(events.at(-1)!.stage).toBe('done');
    expect(events.at(-1)!.completed).toBe(1);
    for (const event of events) {
      expect(event.completed).toBeGreaterThanOrEqual(0);
      expect(event.completed).toBeLessThanOrEqual(1);
      expect(Number.isFinite(event.completed)).toBe(true);
    }
  });

  it('does not announce a stage the kernel skipped', async () => {
    const controller = new AbortController();
    controller.abort();
    const stages: string[] = [];
    const result = await deobfuscate(SAMPLE, { signal: controller.signal, onProgress: (p) => stages.push(p.stage) });
    expect(result.metadata.stats.truncated).toBe(true);
    expect(result.metadata.stats.totalChanges).toBe(0);
    // Parsing and printing happen regardless; no pipeline stage ran.
    expect(stages).toEqual(['parse', 'generate', 'done']);
  });

  it('stays monotonic when the iteration cap is unbounded', async () => {
    const events: number[] = [];
    await deobfuscate(ROTATING, {
      preset: 'aggressive',
      performance: { maxIterations: Infinity },
      onProgress: (p) => events.push(p.completed),
    });
    for (let i = 1; i < events.length; i++) expect(events[i]!).toBeGreaterThanOrEqual(events[i - 1]!);
    expect(events.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WorkerClient
// ---------------------------------------------------------------------------

type Listener = (event: never) => void;

/** A worker double that records what the client does to it. */
function fakeWorker(behaviour: { onPost?: (message: unknown) => void } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const state = { created: 0, terminated: 0, posted: [] as unknown[] };
  const worker: WorkerLike = {
    postMessage(message) {
      state.posted.push(message);
      behaviour.onPost?.(message);
    },
    addEventListener(type: 'message' | 'error', listener: Listener) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
    },
    removeEventListener(type: 'message' | 'error', listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    terminate() {
      state.terminated++;
    },
  };
  return {
    state,
    createWorker: () => {
      state.created++;
      return worker;
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    emit: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event as never);
    },
  };
}

describe('WorkerClient.run', () => {
  it('rejects an already-aborted signal without creating a worker', async () => {
    const fake = fakeWorker();
    const client = new WorkerClient({ createWorker: fake.createWorker });
    const error = await client.run('var a = 1;', { signal: AbortSignal.abort() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(fake.state.created).toBe(0);
    expect(fake.state.posted).toHaveLength(0);
  });

  it('terminates the worker when postMessage throws', async () => {
    const clone = new DOMException('could not be cloned', 'DataCloneError');
    const fake = fakeWorker({
      onPost: () => {
        throw clone;
      },
    });
    const client = new WorkerClient({ createWorker: fake.createWorker });
    const error = await client.run('var a = 1;').catch((e: unknown) => e);
    expect(error).toBe(clone);
    expect(fake.state.created).toBe(1);
    expect(fake.state.terminated).toBe(1);
    expect(fake.listenerCount()).toBe(0);
  });

  it('still runs and terminates on the ordinary path', async () => {
    const fake = fakeWorker({
      onPost: (message) => {
        const request = message as { id: number };
        const done = { type: 'done', id: request.id, result: { code: 'ok', map: undefined, metadata: {} } };
        queueMicrotask(() => fake.emit('message', { data: done }));
      },
    });
    const client = new WorkerClient({ createWorker: fake.createWorker });
    const result = await client.run('var a = 1;');
    expect(result.code).toBe('ok');
    expect(fake.state.terminated).toBe(1);
    expect(fake.listenerCount()).toBe(0);
  });
});

describe('WorkerClient.run checks its arguments before it creates a worker', () => {
  /** A worker that answers every run, so `null` options can be seen to reach it as `{}`. */
  function answering() {
    const fake = fakeWorker({
      onPost: (message) => {
        const request = message as { id: number };
        const done = { type: 'done', id: request.id, result: { code: 'ok', map: undefined, metadata: {} } };
        queueMicrotask(() => fake.emit('message', { data: done }));
      },
    });
    return fake;
  }

  /**
   * A run that was let through with bad arguments does not fail - it posts to
   * a worker that has nothing to say back and waits forever, which is what
   * `run(source, 'aggressive')` did. The race is what turns that into a
   * verdict instead of a test timeout.
   */
  async function outcome(promise: Promise<unknown>): Promise<unknown> {
    return Promise.race([
      promise.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 250)),
    ]);
  }

  it('accepts null options the way deobfuscate() does', async () => {
    const fake = answering();
    const client = new WorkerClient({ createWorker: fake.createWorker });
    // Threw synchronously - `Cannot read properties of null (reading 'signal')`
    // - before a worker existed, and a caller's `.catch` never saw it.
    const result = await client.run('var a = 1;', null as never);
    expect(result.code).toBe('ok');
    expect((fake.state.posted[0] as { options: unknown }).options).toEqual({});
    expect(fake.state.terminated).toBe(1);
  });

  it('rejects a source that is not a string as a TypeError, with no worker', async () => {
    const fake = fakeWorker();
    const client = new WorkerClient({ createWorker: fake.createWorker });
    const error = await outcome(client.run(Buffer.from('var a = 1;') as never));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(
      /^WorkerClient\.run\(\) expects the source as a string, received a Buffer\/Uint8Array\./,
    );
    expect(fake.state.created).toBe(0);
  });

  it('rejects options that are not an object as a TypeError, with no worker', async () => {
    const fake = fakeWorker();
    const client = new WorkerClient({ createWorker: fake.createWorker });
    const error = await outcome(client.run('var a = 1;', 'aggressive' as never));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/options must be an object; received "aggressive"/);
    expect(fake.state.created).toBe(0);
  });

  it('rejects a wrong-typed option as the same TypeError deobfuscate() throws', async () => {
    const fake = fakeWorker();
    const client = new WorkerClient({ createWorker: fake.createWorker });
    const options = { techniques: { variableRenaming: 'no' } } as never;
    const fromWorker = await outcome(client.run('var a = 1;', options));
    const fromEngine = await deobfuscate('var a = 1;', options).catch((e: unknown) => e);
    expect(fromWorker).toBeInstanceOf(TypeError);
    expect((fromWorker as TypeError).message).toBe((fromEngine as TypeError).message);
    expect(fake.state.created).toBe(0);
  });

  it('rejects a signal it could not unsubscribe from, instead of leaking the worker', async () => {
    const fake = answering();
    const client = new WorkerClient({ createWorker: fake.createWorker });
    // `settle` removes the abort listener after the worker's own and before
    // `terminate()`; with this signal that step threw, the run never settled
    // and the worker was never terminated.
    const signal = { aborted: false, addEventListener() {} } as never;
    const error = await outcome(client.run('var a = 1;', { signal }));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/signal must be an AbortSignal; received an object/);
    expect(fake.state.created).toBe(0);
  });
});

describe('toTransferable', () => {
  it('treats null and undefined as no options', () => {
    // `null` failed on the destructuring with `Cannot destructure property
    // 'onProgress'`, a message that names nothing the caller wrote.
    expect(toTransferable(null)).toEqual({});
    expect(toTransferable(undefined)).toEqual({});
    expect(toTransferable()).toEqual({});
  });

  it('strips exactly the two fields that cannot be cloned', () => {
    const options: DeobfuscateOptions = {
      preset: 'aggressive',
      techniques: { deadCodeRemoval: false },
      onProgress: () => {},
      signal: new AbortController().signal,
    };
    expect(toTransferable(options)).toEqual({ preset: 'aggressive', techniques: { deadCodeRemoval: false } });
  });

  it('rejects what deobfuscate() would reject, before it can be posted', () => {
    // A string spread into `{ 0: 'a', 1: 'g', ... }` and was posted; the
    // worker rejected it as unknown options, one plain `Error` later.
    expect(() => toTransferable('aggressive' as never)).toThrow(TypeError);
    expect(() => toTransferable('aggressive' as never)).toThrow(/options must be an object; received "aggressive"/);
    expect(() => toTransferable({ techniques: { variableRenaming: 'no' } } as never)).toThrow(
      /techniques\.variableRenaming must be a boolean or an object; received "no"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

describe('resolveConfig rejects values outside their declared type', () => {
  it.each([
    ['a stringified boolean technique', { techniques: { variableRenaming: 'no' } }, /techniques\.variableRenaming must be a boolean or an object; received "no"/],
    ['a numeric technique', { techniques: { variableRenaming: 0 } }, /techniques\.variableRenaming must be a boolean or an object; received 0/],
    ['an unknown technique', { techniques: { renaming: true } }, /Unknown technique "renaming"\. Expected one of: stringDecoding/],
    ['tiers given as a string', { techniques: { stringDecoding: { tiers: 'native' } } }, /techniques\.stringDecoding\.tiers must be an array of native, interpreter, sandbox; received "native"/],
    ['an unknown tier', { techniques: { stringDecoding: { tiers: ['magic'] } } }, /techniques\.stringDecoding\.tiers\[0\] must be one of native, interpreter, sandbox; received "magic"/],
    ['a non-boolean enabled flag', { techniques: { deadCodeRemoval: { enabled: 'yes' } } }, /techniques\.deadCodeRemoval\.enabled must be a boolean; received "yes"/],
    ['an unknown tuning field', { techniques: { variableRenaming: { minConfidenc: 0.5 } } }, /Unknown option techniques\.variableRenaming\.minConfidenc/],
    ['a hint that is not a string', { techniques: { variableRenaming: { hints: { a: 1 } } } }, /techniques\.variableRenaming\.hints\.a must be a string; received 1/],
    ['disablePasses given as a string', { disablePasses: 'rename.identifiers' }, /disablePasses must be an array of strings; received "rename\.identifiers"/],
    ['sourceMaps outside its union', { output: { sourceMaps: 'yes' } }, /output\.sourceMaps must be true, false or 'inline'; received "yes"/],
    ['comments as a string', { output: { comments: 'no' } }, /output\.comments must be a boolean; received "no"/],
    ['quotes outside its union', { output: { quotes: 'backtick' } }, /output\.quotes must be 'single', 'double' or 'preserve'; received "backtick"/],
    ['indent as a string', { output: { indent: '4' } }, /output\.indent must be a number; received "4"/],
    ['an unknown output option', { output: { sourcemaps: true } }, /Unknown option output\.sourcemaps\. Expected one of: format, indent, comments, sourceMaps, banner, quotes\./],
    ['maxIterations as a string', { performance: { maxIterations: '6' } }, /performance\.maxIterations must be a number; received "6"/],
    ['allowExecution as a string', { sandbox: { allowExecution: 'true' } }, /sandbox\.allowExecution must be a boolean; received "true"/],
    ['an unknown top-level option', { langauge: 'ts' }, /Unknown option "langauge"\. Expected one of: preset, techniques, language/],
    ['onProgress that is not a function', { onProgress: true }, /onProgress must be a function; received true/],
    ['a signal that is not an AbortSignal', { signal: { aborted: 'no' } }, /signal must be an AbortSignal; received an object/],
    ['options that are a string', 'aggressive', /options must be an object; received "aggressive"/],
  ])('rejects %s', (_label, options, message) => {
    expect(() => resolveConfig(options as never)).toThrow(TypeError);
    expect(() => resolveConfig(options as never)).toThrow(message);
  });

  it('removed options are unknown options', () => {
    expect(() => resolveConfig({ output: { annotateBailouts: true } as never })).toThrow(/Unknown option output\.annotateBailouts/);
    expect(() => resolveConfig({ techniques: { stringDecoding: { inlineAll: true } as never } })).toThrow(
      /Unknown option techniques\.stringDecoding\.inlineAll/,
    );
  });

  it('reaches deobfuscate() callers as the same TypeError', async () => {
    await expect(deobfuscate('var a = 1;', 'aggressive' as never)).rejects.toThrow(TypeError);
    await expect(deobfuscate('var a = 1;', { techniques: { variableRenaming: 'no' } } as never)).rejects.toThrow(
      /techniques\.variableRenaming/,
    );
  });

  it('treats an explicit undefined as absent rather than as a value', () => {
    const config = resolveConfig({ output: { indent: undefined, quotes: undefined }, performance: { maxIterations: undefined } });
    expect(config.output.indent).toBe(2);
    expect(config.output.quotes).toBe('preserve');
    // The default is a ceiling the loop stops well short of on a quiet round,
    // not the round count a file takes.
    expect(config.performance.maxIterations).toBe(40);
  });

  it('accepts null the way deobfuscate() documents it', () => {
    expect(resolveConfig(null as never).preset).toBe('balanced');
  });

  it('accepts a signal from another realm', async () => {
    // A `node:vm` context has its own intrinsics and no AbortController, so a
    // signal built there is exactly what one from an iframe, a worker or a
    // polyfill looks like from here: every member the engine reads, and a
    // prototype chain `instanceof AbortSignal` cannot see.
    const realm = vm.createContext({ EventTarget, Event });
    const foreign = vm.runInContext(
      `class AbortSignal extends EventTarget {
         aborted = false;
         reason = undefined;
       }
       class AbortController {
         signal = new AbortSignal();
         abort(reason) {
           if (this.signal.aborted) return;
           this.signal.aborted = true;
           this.signal.reason = reason;
           this.signal.dispatchEvent(new Event('abort'));
         }
       }
       new AbortController()`,
      realm,
    ) as { signal: AbortSignal; abort(reason?: unknown): void };
    expect(foreign.signal instanceof AbortSignal).toBe(false);
    expect(Object.getPrototypeOf(Object.getPrototypeOf(foreign.signal))).not.toBe(AbortSignal.prototype);

    expect(resolveConfig({ signal: foreign.signal }).preset).toBe('balanced');

    // And it is honoured, not merely tolerated: an aborted foreign signal
    // stops the pipeline the way a native one does.
    foreign.abort();
    const result = await deobfuscate(SAMPLE, { signal: foreign.signal });
    expect(result.metadata.stats.truncated).toBe(true);
    expect(result.metadata.stats.totalChanges).toBe(0);
  });

  it('still rejects an object that only resembles a signal', () => {
    expect(() => resolveConfig({ signal: { aborted: false } as never })).toThrow(
      /signal must be an AbortSignal; received an object/,
    );
    expect(() => resolveConfig({ signal: { aborted: false, addEventListener: 'yes' } as never })).toThrow(
      /signal must be an AbortSignal; received an object/,
    );
    // Subscribing is half of what `WorkerClient` does with a signal; one it
    // cannot unsubscribe from broke `settle` and leaked the worker.
    expect(() => resolveConfig({ signal: { aborted: false, addEventListener() {} } as never })).toThrow(
      /signal must be an AbortSignal; received an object/,
    );
    expect(() =>
      resolveConfig({ signal: { aborted: false, addEventListener() {}, removeEventListener: true } as never }),
    ).toThrow(/signal must be an AbortSignal; received an object/);
  });

  it('still lets every documented shape through', () => {
    const config = resolveConfig({
      preset: 'conservative',
      techniques: {
        stringDecoding: { enabled: true, tiers: ['native'], maxDecodeCalls: 10, decodeDespiteStringCode: false },
        variableRenaming: { minConfidence: 0.8, renameParameters: true, hints: { _0x4d28ce: 'gameSocket' } },
        deadCodeRemoval: { removeUnusedBindings: true, keepCommented: true },
        controlFlowAnalysis: false,
        functionUnwrapping: { maxInlineSize: 20, inlineSingleUse: false, refuseOnDirectEval: true },
        jsxRestoration: true,
      },
      language: 'tsx',
      sourceType: 'module',
      filename: 'a.tsx',
      output: { format: true, indent: 4, comments: false, sourceMaps: 'inline', banner: true, quotes: 'double' },
      performance: { maxIterations: 3, timeBudgetMs: 1000, memoize: false, verifyOutput: true },
      sandbox: { timeoutMs: 10, maxSteps: 100, allowExecution: false },
      disablePasses: ['simplify.sequences'],
      onProgress: () => {},
      signal: new AbortController().signal,
    });
    expect(config.techniques.stringDecoding).toBe(true);
    expect(config.techniqueOptions.stringDecoding.tiers).toEqual(['native']);
    expect(config.techniqueOptions.variableRenaming.hints).toEqual({ _0x4d28ce: 'gameSocket' });
    expect(config.output.quotes).toBe('double');
    expect(config.disabledPasses.has('simplify.sequences')).toBe(true);
  });
});

describe('value repairs are diagnostics, not silence', () => {
  it('truncates a fractional iteration cap and says so', async () => {
    const result = await deobfuscate(SAMPLE, { preset: 'aggressive', performance: { maxIterations: 1.5 } });
    expect(result.metadata.stats.iterations).toBe(1);
    expect(result.metadata.diagnostics.some((d) => /maxIterations must be a whole number; received 1\.5, using 1/.test(d.message))).toBe(true);
  });

  it('warns about a disablePasses id that names no pass', async () => {
    const result = await deobfuscate(SAMPLE, { disablePasses: ['rename.identifers'] });
    const warning = result.metadata.diagnostics.find((d) => d.message.includes('rename.identifers'));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
    expect(warning!.message).toMatch(/no pass is registered/);
  });

  it('accepts every id listPasses() reports without a diagnostic', async () => {
    const ids = listPasses().map((p) => p.id);
    const result = await deobfuscate(SAMPLE, { disablePasses: ids });
    expect(result.metadata.diagnostics.filter((d) => d.message.includes('disablePasses'))).toHaveLength(0);
  });
});
