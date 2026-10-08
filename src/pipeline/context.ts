import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { ResolvedConfig } from '../config/presets.js';
import type {
  DecodedStringRecord,
  Detection,
  DetectionKind,
  Diagnostic,
  Language,
  RenameRecord,
  Severity,
} from '../types.js';

// @babel/traverse ships both CJS and ESM shapes depending on the bundler.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A decoder the analysis stage discovered: a way to turn a call or index
 * expression in the source into the string literal it stands for.
 */
export interface StringSource {
  /** Binding name of the array or wrapper function, e.g. `_0xdb56` or `_0x123b`. */
  name: string;
  kind: 'array-index' | 'wrapper-call';
  /** Which evaluation tier produced this decoder. */
  tier: 'native' | 'interpreter' | 'sandbox';
  /** Resolve one reference to its plaintext, or `undefined` if out of range. */
  decode: (args: readonly (string | number)[]) => string | undefined;
  /** Aliases that forward to this decoder, e.g. `var _0x3e8cb6 = _0x123b`. */
  aliases: Set<string>;
  /** Paths that declare the decoder machinery, removable once inlining is done. */
  declarations: NodePath[];
}

/**
 * Shared state threaded through every pass.
 *
 * Passes never talk to each other directly; they read and write this object,
 * which keeps the pass set open for extension and makes each pass independently
 * testable.
 */
export interface PassContext {
  readonly ast: t.File;
  readonly source: string;
  readonly config: ResolvedConfig;
  readonly language: Exclude<Language, 'auto'>;

  /** Decoders found in the `strings` stage, consumed by inlining and naming. */
  readonly stringSources: StringSource[];
  /** Obfuscation fingerprints, surfaced in metadata and used to gate passes. */
  readonly detections: Detection[];
  readonly diagnostics: Diagnostic[];
  readonly renames: RenameRecord[];
  readonly decodedStrings: Map<string, DecodedStringRecord>;

  /** Free-form slots for passes that need to hand analysis to a later stage. */
  readonly shared: Map<string, unknown>;

  /** Which fixpoint iteration is running; 0 on the first pass through. */
  readonly iteration: number;

  /**
   * Record that the tree changed. Drives fixpoint termination and per-pass
   * attribution in the report, so every mutating pass must call it.
   */
  markChanged(count?: number): void;

  report(kind: DetectionKind, evidence: string, confidence?: number, count?: number): void;
  /**
   * Record a diagnostic. With `key`, the note is a standing verdict: a later
   * note under the same key replaces it in place, and `retract` withdraws it.
   *
   * The fixpoint loop judges the same candidate on several rounds, and each
   * round's verdict is about that round's tree. `Refusing to evaluate X: a
   * statement the slice cannot include names X` on round one, followed by
   * X adopted on round three once the statement was rewritten, left the
   * refusal in the report of a run whose output holds no trace of X. A
   * verdict about one thing is one entry, and the report carries the last.
   */
  note(severity: Severity, message: string, loc?: t.SourceLocation | null, key?: string): void;
  /** Withdraw the standing note under `key`, if any; the final output no longer bears it out. */
  retract(key: string): void;

  /** True once the time budget or the caller's abort signal has fired. */
  isExhausted(): boolean;

  /**
   * Rebuild program scope, unless the tables already describe this tree.
   *
   * Every proof in the engine that reads `binding.referencePaths` or
   * `constantViolations` needs those lists to match the tree as it is now, and
   * Babel only rebuilds them on a crawl. A crawl is a walk of the whole
   * program, and Babel's `Binding.reference` checks `referencePaths.includes`
   * before every push, so a name with N direct references costs O(N²): one
   * binding read 100k times is 5 s per crawl, and the run used to crawl three
   * to six times - mostly in passes that then changed nothing. `totalChanges`
   * is the tree's version: the kernel already skips a stage on the strength
   * of it, and a crawl taken at the same version as the last one rebuilds the
   * identical tables. Soundness rests on the contract every pass is under -
   * a mutation calls `markChanged` - read here at crawl granularity.
   */
  crawlProgramScope(program: NodePath<t.Program>): void;
}

/** Concrete context; the interface above is what passes are written against. */
export class PipelineContext implements PassContext {
  readonly stringSources: StringSource[] = [];
  readonly detections: Detection[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly renames: RenameRecord[] = [];
  readonly decodedStrings = new Map<string, DecodedStringRecord>();
  readonly shared = new Map<string, unknown>();

  iteration = 0;
  /**
   * `totalChanges` as it stood when program scope was last built. Starts at 0
   * because Babel crawls the program on the first traversal before any handler
   * runs, so the tables describe the parsed tree until a pass changes it.
   */
  private scopeBuiltAt = 0;
  /** Set by the kernel around every pass so diagnostics attribute correctly. */
  currentPass = 'pipeline';
  /** Change counts per pass id, accumulated across fixpoint iterations. */
  readonly changesByPass = new Map<string, number>();
  totalChanges = 0;

  constructor(
    readonly ast: t.File,
    readonly source: string,
    readonly config: ResolvedConfig,
    readonly language: Exclude<Language, 'auto'>,
    private readonly deadline: number,
    private readonly signal?: AbortSignal,
  ) {}

  markChanged(count = 1): void {
    if (count <= 0) return;
    this.totalChanges += count;
    this.changesByPass.set(this.currentPass, (this.changesByPass.get(this.currentPass) ?? 0) + count);
  }

  report(kind: DetectionKind, evidence: string, confidence = 1, count?: number): void {
    const existing = this.detections.find((d) => d.kind === kind && d.evidence === evidence);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence);
      if (count !== undefined) existing.count = (existing.count ?? 0) + count;
      return;
    }
    this.detections.push({ kind, evidence, confidence, count });
  }

  /** Standing notes by key, so a later verdict can find the entry it replaces. */
  private readonly keyed = new Map<string, Diagnostic>();

  note(severity: Severity, message: string, loc?: t.SourceLocation | null, key?: string): void {
    const diagnostic: Diagnostic = {
      severity,
      source: this.currentPass,
      message,
      loc: loc ? { line: loc.start.line, column: loc.start.column } : undefined,
    };
    if (key !== undefined) {
      // In place, so the entry keeps the position of the round that first
      // raised it and the report stays in the order the run found things.
      const previous = this.keyed.get(key);
      const at = previous ? this.diagnostics.indexOf(previous) : -1;
      this.keyed.set(key, diagnostic);
      if (at !== -1) {
        this.diagnostics[at] = diagnostic;
        return;
      }
    }
    this.diagnostics.push(diagnostic);
  }

  retract(key: string): void {
    const diagnostic = this.keyed.get(key);
    if (!diagnostic) return;
    this.keyed.delete(key);
    const at = this.diagnostics.indexOf(diagnostic);
    if (at !== -1) this.diagnostics.splice(at, 1);
  }

  isExhausted(): boolean {
    // `>=` so that a zero time budget means "no work at all" rather than
    // "however much fits in the first millisecond".
    return this.signal?.aborted === true || Date.now() >= this.deadline;
  }

  /**
   * How many times program scope has been built. A stage that last started
   * on an earlier build read older tables than the tree now has; the kernel
   * runs it once more on a quiet round for that reason alone.
   */
  scopeRevision = 0;

  crawlProgramScope(program: NodePath<t.Program>): void {
    if (this.totalChanges === this.scopeBuiltAt) return;
    program.scope.crawl();
    this.scopeBuiltAt = this.totalChanges;
    this.scopeRevision++;
  }

  /** Whether the scope tables were last built for a tree the run has since changed. */
  scopeStale(): boolean {
    return this.totalChanges !== this.scopeBuiltAt;
  }

  /**
   * `crawlProgramScope` for the kernel, which holds the file and not a path.
   * Babel caches the program's path, so this reaches the same scope object
   * every pass resolves through.
   */
  rebuildProgramScope(): void {
    traverse(this.ast, {
      Program: (path) => {
        this.crawlProgramScope(path);
        path.stop();
      },
    });
  }

  /**
   * Give the host one turn between stages.
   *
   * Every `await` in the kernel is on a non-promise and settles in a microtask,
   * and draining microtasks runs neither timers nor message events. So without
   * this the whole run is one synchronous span from the host's point of view:
   * an `AbortController` whose `abort()` is scheduled by the caller - from a
   * `setTimeout`, an `AbortSignal.timeout`, a click handler - could not fire
   * until the run had already resolved, a worker's progress messages left in a
   * burst at the end, and anything waiting on the worker's own event loop
   * waited for the whole file. One macrotask hop per stage is what makes each
   * of those happen while the run is still going; a microtask would not, which
   * is the whole reason it is not one.
   */
  async yieldToHost(): Promise<void> {
    if (this.signal?.aborted) return;
    // One macrotask, so the host's queue drains: an abort, a worker message, a
    // test runner's RPC reply. Unconditional, not only when a signal was
    // supplied - a run over obfuscated2.js is otherwise a single 17 s span in
    // which the event loop never turns once, and a host that cannot get a word
    // in for that long is a host that times out (vitest's worker RPC does, at a
    // hard-coded 60 s, on the larger fixtures under any load). A `MessageChannel`
    // port message rather than `setTimeout(0)`: measured over three runs each,
    // the port costs nothing (17.1 s against 17.0 s with no yield at all) while
    // the timer's clamp - 15.6 ms on Windows, 4 ms once nested in a browser -
    // adds 5 % across the 28 stage boundaries. Guarded the same way `now()`
    // guards `performance`: a realm with neither can still finish a run, it
    // just cannot be interrupted during one.
    if (typeof MessageChannel === 'function') {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          // Both ends, so the native handles go now rather than at collection.
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(null);
      });
      return;
    }
    if (typeof setTimeout !== 'function') return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
