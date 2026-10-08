import { detectObfuscation, trippedByReprinting, type DetectionHints } from '../../analysis/detect.js';
import type { Pass } from '../../pipeline/pass.js';
import { armReprintHazard } from '../clean/anti-tamper.js';
import { FUNCTION_PACKER_HINT } from '../unpack/function-constructor.js';
import { ESCAPE_STATS_KEY, type EscapeStats } from './normalize-literals.js';

/**
 * Kinds that constrain what the rest of the pipeline may safely do, rather than
 * just describing the input. They earn a diagnostic so the user can see why a
 * later pass refused to execute a decoder or reformat before decoding.
 */
const TRAP_ADVICE: Partial<Record<string, string>> = {
  'self-defending': 'self-defending guards detected: a guard matches the program\'s own printed source against a formatting pattern and hangs on reformatted text; it is removed once its member names are decoded, at every preset',
  'debug-protection': 'debug-protection detected: the payload reaches the Function constructor through a computed member, so a lexical scan for `debugger` finds nothing',
  'eval-packer': 'packed source detected: the real program only becomes visible after the packer is unwrapped',
};

/**
 * Fingerprint the obfuscator.
 *
 * Pure analysis - it reads the tree, reports what it recognises, and mutates
 * nothing. `run` rather than `visitor` because detection is a whole-program
 * judgement: a string array is only a string array once you have also seen how
 * it is read, and a decoder alias only resolves after the whole alias graph is
 * known.
 */
export const detectPass: Pass = {
  id: 'prepare.detect',
  title: 'Fingerprint the obfuscator',
  stage: 'prepare',
  technique: 'core',
  // One-shot: detection describes the input, and re-running it on a partially
  // deobfuscated tree would report fingerprints the pipeline has already removed.
  repeatable: false,

  run: (ctx) => {
    const hints: DetectionHints = {};
    const stats = ctx.shared.get(ESCAPE_STATS_KEY);
    if (isEscapeStats(stats)) hints.strippedEscapes = stats;

    const detections = detectObfuscation(ctx.ast, hints);
    for (const detection of detections) {
      ctx.report(detection.kind, detection.evidence, detection.confidence, detection.count);
      const advice = TRAP_ADVICE[detection.kind];
      if (advice) ctx.note('warning', advice);
      // The warning above is about the input; this is about the output. A
      // guard that matches its own printed text hangs on the reprinted file,
      // and only the `clean` stage removes it. Said now, as an error, replaced
      // by that stage's own verdict each round and taken back once the guard
      // is gone - so a run that never gets there, because the budget ran out
      // first, ships the file with the note rather than silently.
      if (trippedByReprinting(detection)) {
        armReprintHazard(
          ctx,
          detection.evidence,
          `\`${ctx.config.techniques.antiTamperRemoval ? 'clean.anti-tamper' : 'clean.reprint-guards'}\` ` +
            'removes such a guard once its member names are decoded; the run stopped before that ' +
            'pass ran (see `stats.truncated`; raise `performance.timeBudgetMs`).',
        );
      }
    }

    if (detections.length === 0) {
      ctx.note('info', 'No obfuscator fingerprint recognised; treating the input as minified rather than obfuscated');
    }

    // Every fingerprint of a packed file is inside the package. `unpack`
    // has not run yet and, at `conservative`, never will - `moduleUnwrapping`
    // is off there - so obfuscated4.js, whose first token is
    // `Function("O9pMN3", "var ...")`, reports no detections at all and comes
    // back 74 bytes larger than it went in. The scan is the pass's own, and it
    // costs one linear pass over the source on the one preset that needs it.
    if (!ctx.config.techniques.moduleUnwrapping && FUNCTION_PACKER_HINT.test(ctx.source)) {
      ctx.note(
        'warning',
        'The source hands a string to the `Function` constructor, which is how a packed ' +
          'program hides its own text. `moduleUnwrapping` is off, so the wrapper is left ' +
          'closed and every later pass sees one opaque literal; enable that technique - it ' +
          'is on in `balanced` and `aggressive` - to open it.',
      );
    }
  },
};

function isEscapeStats(value: unknown): value is EscapeStats {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EscapeStats>;
  return typeof candidate.escaped === 'number' && typeof candidate.total === 'number';
}
