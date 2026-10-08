import type {
  DeobfuscateOptions,
  EvaluatorTier,
  Language,
  PresetName,
  SourceType,
  TechniqueId,
} from '../types.js';

export const LANGUAGES: readonly Language[] = ['auto', 'js', 'jsx', 'ts', 'tsx'];
export const SOURCE_TYPES: readonly SourceType[] = ['script', 'module', 'unambiguous'];
export const EVALUATOR_TIERS: readonly EvaluatorTier[] = ['native', 'interpreter', 'sandbox'];
export const PRESET_NAMES: readonly PresetName[] = ['conservative', 'balanced', 'aggressive'];
export const TECHNIQUE_IDS: readonly TechniqueId[] = [
  'stringDecoding',
  'variableRenaming',
  'controlFlowAnalysis',
  'deadCodeRemoval',
  'functionUnwrapping',
  'literalSimplification',
  'propertyNormalization',
  'antiTamperRemoval',
  'statementRecovery',
  'moduleUnwrapping',
  'jsxRestoration',
];

/** A short, safe rendering of an arbitrary value for an error message. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}...` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Uint8Array) return 'a Buffer/Uint8Array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/**
 * Runtime checks for the option object, one per declared field.
 *
 * The types are not enforced for a JavaScript caller, and every field here
 * was reachable with a wrong-typed value that did something other than fail:
 * `techniques: { variableRenaming: 'no' }` enabled the technique, `tiers:
 * 'native'` iterated the string's characters as tiers and decoded nothing,
 * `disablePasses: 'rename.identifiers'` became a set of letters, and a typo'd
 * key vanished. Each of those produced a result marked `verified` with no
 * diagnostic. A value outside its declared type is now a `TypeError` naming
 * the field, the type it wanted and the value it got - the same shape
 * `preset` has always used. Only values of the right type but outside their
 * range are repaired with a warning, and that happens in `sanitizeConfig`.
 */
type Check = (value: unknown, path: string) => void;

function fail(path: string, expected: string, value: unknown): never {
  throw new TypeError(`${path} must be ${expected}; received ${describeValue(value)}.`);
}

const boolean: Check = (value, path) => {
  if (typeof value !== 'boolean') fail(path, 'a boolean', value);
};

/** A number that is one: `NaN` compares false against every bound and satisfies no range check, so no repair follows from it. */
const number: Check = (value, path) => {
  if (typeof value !== 'number' || Number.isNaN(value)) fail(path, 'a number', value);
};

/**
 * A budget the interpreter compares against on every step. `NaN` compares
 * false against every bound and `Infinity` is never exceeded, so either is no
 * bound at all - a looping decoder would run to completion with nothing to
 * stop it - and neither has a repair worth guessing at.
 */
const finite: Check = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number', value);
};

const string: Check = (value, path) => {
  if (typeof value !== 'string') fail(path, 'a string', value);
};

const func: Check = (value, path) => {
  if (typeof value !== 'function') fail(path, 'a function', value);
};

/** A string union, reported the way `preset` reports itself: `Unknown language "python". Expected one of: ...`. */
function known(values: readonly string[], label: string): Check {
  return (value, _path) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      throw new TypeError(
        `Unknown ${label} ${describeValue(value)}. Expected one of: ${values.join(', ')}.`,
      );
    }
  };
}

function oneOf(values: readonly string[], expected: string): Check {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) fail(path, expected, value);
  };
}

function arrayOf(item: Check, expected: string): Check {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, `an array of ${expected}`, value);
    value.forEach((entry, index) => item(entry, `${path}[${index}]`));
  };
}

function recordOf(item: Check): Check {
  return (value, path) => {
    if (!isPlainObject(value)) fail(path, 'an object', value);
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) item(entry, `${path}.${key}`);
    }
  };
}

/**
 * An option bag: a plain object whose keys are all declared. An explicit
 * `undefined` is the same as an absent key, which is what the optional
 * property types promise; anything else is checked against its field.
 */
function bag(
  fields: Record<string, Check>,
  unknown: (key: string, path: string) => string = (key, path) =>
    `Unknown option ${path ? `${path}.${key}` : JSON.stringify(key)}. Expected one of: ${Object.keys(fields).join(', ')}.`,
): Check {
  return (value, path) => {
    if (!isPlainObject(value)) fail(path, 'an object', value);
    for (const [key, entry] of Object.entries(value)) {
      const check = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
      if (!check) throw new TypeError(unknown(key, path));
      if (entry !== undefined) check(entry, path ? `${path}.${key}` : key);
    }
  };
}

function technique(tuning: Record<string, Check> = {}): Check {
  const object = bag({ enabled: boolean, ...tuning });
  return (value, path) => {
    if (typeof value === 'boolean') return;
    if (!isPlainObject(value)) fail(path, 'a boolean or an object', value);
    object(value, path);
  };
}

/**
 * Duck-typed, never `instanceof AbortSignal`. A signal minted in another realm
 * - an iframe, a `node:vm` context, a polyfill - has every member the engine
 * reads and a prototype chain that does not reach this realm's constructor,
 * so `instanceof` rejected exactly the signals a host embedding the engine
 * in a sandbox would hand it. The three members named here are the three
 * that get used: `aborted` is what the pipeline polls, and `addEventListener`
 * and `removeEventListener` are what `WorkerClient` - which checks its
 * options through here before it creates a worker - subscribes with and, in
 * `settle`, unsubscribes with. The last one is not optional: a signal-like
 * that had the first two and not it passed, and `settle` then threw on the
 * unsubscribe after the worker's listeners were gone and before
 * `terminate()`, so the run never settled and the worker was never freed.
 */
const signal: Check = (value, path) => {
  const ok =
    isPlainObject(value) &&
    typeof value['aborted'] === 'boolean' &&
    typeof value['addEventListener'] === 'function' &&
    typeof value['removeEventListener'] === 'function';
  if (!ok) fail(path, 'an AbortSignal', value);
};

const tier = oneOf(EVALUATOR_TIERS, `one of ${EVALUATOR_TIERS.join(', ')}`);

const OPTIONS = bag({
  preset: known(PRESET_NAMES, 'preset'),
  techniques: bag(
    {
      stringDecoding: technique({
        maxDecodeCalls: number,
        decodeDespiteStringCode: boolean,
        tiers: arrayOf(tier, EVALUATOR_TIERS.join(', ')),
      }),
      variableRenaming: technique({
        minConfidence: number,
        renameReadable: boolean,
        renameParameters: boolean,
        renameProperties: boolean,
        hints: recordOf(string),
      }),
      controlFlowAnalysis: technique({
        maxStates: number,
        aggressiveDispatchers: boolean,
        registerVm: boolean,
        maxRegisterVmStates: number,
      }),
      deadCodeRemoval: technique({
        removeUnusedBindings: boolean,
        removeUnusedFunctions: boolean,
        removeConstantBranches: boolean,
        keepCommented: boolean,
      }),
      functionUnwrapping: technique({
        maxInlineSize: number,
        inlineSingleUse: boolean,
        refuseOnDirectEval: boolean,
      }),
      literalSimplification: technique(),
      propertyNormalization: technique(),
      antiTamperRemoval: technique(),
      statementRecovery: technique(),
      moduleUnwrapping: technique(),
      jsxRestoration: technique(),
    },
    (key) => `Unknown technique ${JSON.stringify(key)}. Expected one of: ${TECHNIQUE_IDS.join(', ')}.`,
  ),
  language: known(LANGUAGES, 'language'),
  sourceType: known(SOURCE_TYPES, 'sourceType'),
  filename: string,
  output: bag({
    format: boolean,
    indent: number,
    comments: boolean,
    sourceMaps: (value, path) => {
      if (typeof value !== 'boolean' && value !== 'inline') fail(path, "true, false or 'inline'", value);
    },
    banner: boolean,
    quotes: oneOf(['single', 'double', 'preserve'], "'single', 'double' or 'preserve'"),
  }),
  performance: bag({
    maxIterations: number,
    timeBudgetMs: number,
    memoize: boolean,
    verifyOutput: boolean,
  }),
  sandbox: bag({
    timeoutMs: finite,
    maxSteps: finite,
    allowExecution: boolean,
  }),
  disablePasses: arrayOf(string, 'strings'),
  onProgress: func,
  signal,
});

/**
 * Check every option against its declared type and return the object to read
 * from. `null` and `undefined` are both "no options": `= {}` only defaults
 * away `undefined`, and an explicit `null` used to fail on the first property
 * access with an opaque message.
 */
export function validateOptions(options: unknown): DeobfuscateOptions {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) fail('options', 'an object', options);
  OPTIONS(options, '');
  return options as DeobfuscateOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
