import { describeValue } from '../config/validate.js';
import { parseSource } from '../frontend/language.js';
import { countLines, countUtf8Bytes } from '../util/ast.js';
import { detectObfuscation } from './detect.js';
import type { Detection, Language, SourceType } from '../types.js';

export interface AnalysisResult {
  language: Exclude<Language, 'auto'>;
  sourceType: Exclude<SourceType, 'unambiguous'>;
  detections: Detection[];
  /** UTF-8 bytes - the same counter `deobfuscate` reports as `stats.inputBytes`. */
  bytes: number;
  lines: number;
}

/** Fingerprint input without transforming it. Parses once, mutates nothing. */
export function analyze(source: string, options: { language?: Language; filename?: string } = {}): AnalysisResult {
  // The same guard `deobfuscate()` has, for the same reason: this is the entry
  // point a UI calls on every keystroke, so it is the one most likely to be
  // handed an `undefined` mid-wiring, and the failure it produced without the
  // guard - `code.slice is not a function`, thrown while the parse-failure
  // error was being built - named engine internals for a caller's mistake.
  if (typeof source !== 'string') {
    throw new TypeError(
      `analyze() expects the source as a string, received ${describeValue(source)}. ` +
        'Read the file with an encoding (fs.readFileSync(path, "utf8")) or call String() on it first.',
    );
  }
  // `= {}` only defaults away `undefined`; an explicit `null` reaches the
  // parser's option reads and fails there.
  const parsed = parseSource(source, options ?? {});
  return {
    language: parsed.language,
    sourceType: parsed.sourceType,
    detections: detectObfuscation(parsed.ast),
    // `source.length` is UTF-16 code units, and `deobfuscate` reports UTF-8
    // bytes, so the two entry points answered "how big is this file" with
    // different numbers for the same input - 470,483 against 470,485 on
    // `fixtures/lightly-obfuscated.js`, where 470,485 is what the file occupies
    // on disk. Same walk, same cost as the line count beside it.
    bytes: countUtf8Bytes(source),
    // `countLines`, not `split('\n').length`: identical result and cost, but the
    // split materialises every line as a separate string first - megabytes of
    // immediate garbage on a large input, in a function whose whole purpose is to
    // be cheap enough for a UI to call on every keystroke. It is also the counter
    // `deobfuscate` reports, so the two entry points cannot drift.
    lines: countLines(source),
  };
}
