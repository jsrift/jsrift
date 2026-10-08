import type {
  ControlFlowOptions,
  DeadCodeOptions,
  DeobfuscateOptions,
  FunctionUnwrappingOptions,
  OutputOptions,
  PerformanceOptions,
  PresetName,
  SandboxOptions,
  StringDecodingOptions,
  TechniqueFlags,
  TechniqueId,
  TechniqueOverride,
  TechniqueOverrides,
  VariableRenamingOptions,
} from '../types.js';
import { TECHNIQUE_IDS, validateOptions } from './validate.js';

/**
 * Per-technique tuning after a preset and the caller's overrides have been merged.
 * Every field is required here so no pass ever has to defend against `undefined`.
 */
export interface ResolvedTechniqueOptions {
  stringDecoding: Required<StringDecodingOptions>;
  variableRenaming: Required<VariableRenamingOptions>;
  controlFlowAnalysis: Required<ControlFlowOptions>;
  deadCodeRemoval: Required<DeadCodeOptions>;
  functionUnwrapping: Required<FunctionUnwrappingOptions>;
}

export interface ResolvedConfig {
  preset: PresetName;
  techniques: TechniqueFlags;
  techniqueOptions: ResolvedTechniqueOptions;
  output: Required<OutputOptions>;
  performance: Required<PerformanceOptions>;
  sandbox: Required<SandboxOptions>;
  disabledPasses: ReadonlySet<string>;
}

const ALL_TECHNIQUES: readonly TechniqueId[] = TECHNIQUE_IDS;

/**
 * Preset technique coverage.
 *
 * The dividing line is *provability*. Conservative only enables passes whose
 * output is guaranteed semantically identical to the input. Balanced adds
 * transformations that are correct under assumptions that hold for all
 * mainstream obfuscators. Aggressive adds ones that trade a small risk of
 * behavioural drift for a large readability win - appropriate because the
 * consumer of the output is a human reader, not a runtime.
 */
const PRESET_TECHNIQUES: Record<PresetName, TechniqueFlags> = {
  conservative: {
    stringDecoding: true,
    variableRenaming: false,
    controlFlowAnalysis: false,
    deadCodeRemoval: false,
    functionUnwrapping: false,
    literalSimplification: true,
    propertyNormalization: true,
    antiTamperRemoval: false,
    statementRecovery: false,
    moduleUnwrapping: false,
    jsxRestoration: false,
  },
  balanced: {
    stringDecoding: true,
    variableRenaming: true,
    controlFlowAnalysis: true,
    deadCodeRemoval: true,
    functionUnwrapping: true,
    literalSimplification: true,
    propertyNormalization: true,
    antiTamperRemoval: true,
    statementRecovery: true,
    /*
     * On, despite the name suggesting a structural rewrite.
     *
     * What this technique mostly does is open wrappers: an eval packer or a
     * `Function` constructor holding the program as a string. That is not a
     * transformation under an assumption - the string already *is* the source,
     * and putting it back in the tree is closer to parsing than to rewriting.
     * Splitting a webpack chunk map into named modules is the structural half,
     * and it only fires on something that is already a bundle.
     *
     * With it off the default preset returns a packed file essentially
     * unchanged: every later pass sees one opaque string literal and correctly
     * finds nothing to do. A default that cannot open the most common wrapper
     * is not a useful default.
     */
    moduleUnwrapping: true,
    jsxRestoration: true,
  },
  aggressive: {
    stringDecoding: true,
    variableRenaming: true,
    controlFlowAnalysis: true,
    deadCodeRemoval: true,
    functionUnwrapping: true,
    literalSimplification: true,
    propertyNormalization: true,
    antiTamperRemoval: true,
    statementRecovery: true,
    moduleUnwrapping: true,
    jsxRestoration: true,
  },
};

const PRESET_TECHNIQUE_OPTIONS: Record<PresetName, ResolvedTechniqueOptions> = {
  conservative: {
    stringDecoding: {
      maxDecodeCalls: 200_000,
      decodeDespiteStringCode: false,
      tiers: ['native', 'interpreter'],
    },
    variableRenaming: {
      minConfidence: 0.9,
      renameReadable: false,
      renameParameters: false,
      renameProperties: false,
      hints: {},
    },
    controlFlowAnalysis: {
      maxStates: 256,
      aggressiveDispatchers: false,
      registerVm: false,
      maxRegisterVmStates: 512,
    },
    deadCodeRemoval: {
      removeUnusedBindings: false,
      removeUnusedFunctions: false,
      removeConstantBranches: false,
      keepCommented: true,
    },
    functionUnwrapping: {
      maxInlineSize: 12,
      inlineSingleUse: false,
      // On, because this preset promises output identical to the input and a
      // direct `eval` reassigning a wrapper is a documented way the rewrite
      // breaks that - see `FunctionUnwrappingOptions.refuseOnDirectEval`. The
      // technique is off here by default, so this only bites a caller who turns
      // it on at this preset, and that caller was promised provability.
      refuseOnDirectEval: true,
    },
  },
  balanced: {
    stringDecoding: {
      maxDecodeCalls: 1_000_000,
      decodeDespiteStringCode: false,
      // `sandbox` is deliberately absent. It executes attacker-controlled code
      // and no browser primitive makes that a real boundary, so it is opt-in.
      tiers: ['native', 'interpreter'],
    },
    variableRenaming: {
      minConfidence: 0.55,
      renameReadable: false,
      renameParameters: true,
      renameProperties: false,
      hints: {},
    },
    controlFlowAnalysis: {
      maxStates: 2048,
      aggressiveDispatchers: false,
      registerVm: false,
      maxRegisterVmStates: 4096,
    },
    deadCodeRemoval: {
      removeUnusedBindings: true,
      removeUnusedFunctions: true,
      removeConstantBranches: true,
      keepCommented: true,
    },
    // Off, and the measurement behind that is on
    // `FunctionUnwrappingOptions.refuseOnDirectEval` in src/types.ts, which is
    // also the text a consumer reads in the published .d.ts.
    functionUnwrapping: { maxInlineSize: 48, inlineSingleUse: true, refuseOnDirectEval: false },
  },
  aggressive: {
    stringDecoding: {
      maxDecodeCalls: Number.MAX_SAFE_INTEGER,
      // The one preset that takes this trade, and the aggressive arm of the
      // doctrine above is the whole reason. The refusal it lifts is sound -
      // nothing proves what a string the engine cannot read compiles to - and
      // it is also the most expensive refusal in the engine: on
      // `fixtures/lightly-obfuscated.js`, whose single `Function(_)` call is
      // exactly this hazard, keeping the machinery leaves the entire string
      // table in the output and the file comes out larger than it went in.
      // `test/fixtures.test.ts` asserts both sides of that.
      //
      // What is being risked is not restated here; it is on
      // `StringDecodingOptions.decodeDespiteStringCode` in src/types.ts, which
      // is also the text a consumer reads in the published .d.ts.
      decodeDespiteStringCode: true,
      tiers: ['native', 'interpreter'],
    },
    variableRenaming: {
      minConfidence: 0.3,
      renameReadable: true,
      renameParameters: true,
      renameProperties: false,
      hints: {},
    },
    controlFlowAnalysis: {
      maxStates: 16_384,
      aggressiveDispatchers: true,
      // Off here too, and deliberately not re-argued: the reason lives with the
      // option in `ControlFlowOptions.registerVm` (src/types.ts), which is also
      // the text a consumer reads in the published .d.ts. A second copy of the
      // argument here drifts from that one.
      registerVm: false,
      maxRegisterVmStates: 65_536,
    },
    deadCodeRemoval: {
      removeUnusedBindings: true,
      removeUnusedFunctions: true,
      removeConstantBranches: true,
      keepCommented: false,
    },
    functionUnwrapping: { maxInlineSize: 160, inlineSingleUse: true, refuseOnDirectEval: false },
  },
};

const DEFAULT_OUTPUT: Required<OutputOptions> = {
  format: true,
  indent: 2,
  comments: true,
  sourceMaps: false,
  banner: false,
  quotes: 'preserve',
};

const DEFAULT_PERFORMANCE: Required<PerformanceOptions> = {
  // A ceiling, not an estimate: the loop stops on the first quiet round, and
  // an ordinary file takes three to five. Stacked layers take about two rounds
  // each - a four-deep obfuscator.io build needs nine - and a cap of six left a
  // fifth layer encoded with nothing in the report saying why. The time budget
  // is the bound that matters; this one stands behind it.
  maxIterations: 40,
  timeBudgetMs: 120_000,
  memoize: true,
  verifyOutput: true,
};

const DEFAULT_SANDBOX: Required<SandboxOptions> = {
  timeoutMs: 5_000,
  maxSteps: 20_000_000,
  // Off by default. The `native` and `interpreter` tiers cover every decoder
  // encountered so far without executing anything, so paying a real security
  // risk for the residual cases is not a trade worth making silently.
  allowExecution: false,
};

function isEnabled(override: TechniqueOverride<unknown> | undefined, fallback: boolean): boolean {
  if (override === undefined) return fallback;
  if (typeof override === 'boolean') return override;
  return override.enabled ?? true;
}

/** Pull the tuning fields out of an object-form override, dropping `enabled`. */
function tuningOf<T>(override: TechniqueOverride<T> | undefined): Partial<T> {
  if (!override || typeof override === 'boolean') return {};
  const { enabled: _enabled, ...rest } = override as { enabled?: boolean } & T;
  return defined(rest) as Partial<T>;
}

/**
 * The keys of `overrides` that carry a value. A spread copies an explicit
 * `undefined` over the default it was meant to leave alone - `{ indent:
 * undefined }` used to resolve to an indent of `undefined` - and the optional
 * property types say `undefined` and absent are the same thing.
 */
function defined<T extends object>(overrides: T | undefined): Partial<T> {
  const result: Partial<T> = {};
  if (!overrides) return result;
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    if (overrides[key] !== undefined) result[key] = overrides[key];
  }
  return result;
}

/**
 * Collapse `{ preset, techniques, ... }` into a fully-populated config.
 *
 * Precedence is strictly: defaults < preset < caller overrides. An override of
 * `false` always disables, even under the aggressive preset, which is what makes
 * "aggressive but without dead-code removal" expressible.
 *
 * Every option is type-checked first (`config/validate.ts`) and a value outside
 * its declared type is a `TypeError`; values of the right type but outside
 * their range are repaired with a diagnostic by `sanitizeConfig` in `index.ts`.
 */
export function resolveConfig(options: DeobfuscateOptions | null = {}): ResolvedConfig {
  options = validateOptions(options);
  const preset: PresetName = options.preset ?? 'balanced';
  const baseFlags = PRESET_TECHNIQUES[preset];

  const overrides: TechniqueOverrides = options.techniques ?? {};
  const techniques = {} as TechniqueFlags;
  for (const id of ALL_TECHNIQUES) {
    techniques[id] = isEnabled(overrides[id], baseFlags[id]);
  }

  const baseOptions = PRESET_TECHNIQUE_OPTIONS[preset];
  const techniqueOptions: ResolvedTechniqueOptions = {
    stringDecoding: { ...baseOptions.stringDecoding, ...tuningOf(overrides.stringDecoding) },
    variableRenaming: {
      ...baseOptions.variableRenaming,
      ...tuningOf(overrides.variableRenaming),
      hints: {
        ...baseOptions.variableRenaming.hints,
        ...tuningOf(overrides.variableRenaming).hints,
      },
    },
    controlFlowAnalysis: {
      ...baseOptions.controlFlowAnalysis,
      ...tuningOf(overrides.controlFlowAnalysis),
    },
    deadCodeRemoval: { ...baseOptions.deadCodeRemoval, ...tuningOf(overrides.deadCodeRemoval) },
    functionUnwrapping: {
      ...baseOptions.functionUnwrapping,
      ...tuningOf(overrides.functionUnwrapping),
    },
  };

  return {
    preset,
    techniques,
    techniqueOptions,
    output: { ...DEFAULT_OUTPUT, ...defined(options.output) },
    performance: { ...DEFAULT_PERFORMANCE, ...defined(options.performance) },
    sandbox: { ...DEFAULT_SANDBOX, ...defined(options.sandbox) },
    disabledPasses: new Set(options.disablePasses ?? []),
  };
}

export { ALL_TECHNIQUES, PRESET_TECHNIQUES, PRESET_TECHNIQUE_OPTIONS };
