import * as t from '@babel/types';
import type { Detection, DetectionKind } from '../types.js';

/**
 * Obfuscator fingerprinting.
 *
 * Three properties drive every decision in this file:
 *
 * 1. **Structure, never names.** Obfuscators randomise identifiers on every run,
 *    so a detector keyed on `_0x...` recognises one build and misses the next.
 *    Everything here matches node shapes and *constants* the transform is forced
 *    to emit (the base64 alphabet, `256` in an RC4 loop, `'(((.+)+)+)+$'`), or it
 *    matches a name the file itself declared against the uses of that same name.
 *    The one exception is `webpack-bundle`, where `__webpack_require__` is a
 *    fixed part of the bundler's runtime rather than generated noise.
 *
 * 2. **One traversal.** A manual stack walk over `VISITOR_KEYS` rather than
 *    `@babel/traverse`, because detection needs no scope information and scope
 *    construction is the expensive half of a Babel traversal. Measured on the
 *    4.1 MB / 396k-node fixture this scan is ~130 ms, which is fast enough to run
 *    on every keystroke behind a short debounce.
 *
 * 3. **Honesty over coverage.** Every threshold below was calibrated against both
 *    real fixtures. `lightly-obfuscated.js` is a minified bundle with a plain
 *    string table and genuinely has no flattening, no injected dead code, no
 *    proxy functions, no alias maps and no anti-tamper; reporting any of those
 *    would be a lie that sends later passes hunting for something that is not
 *    there. When the evidence is ambiguous the detector stays silent.
 */

// ---------------------------------------------------------------------------
// Tunables - every number here was measured against the two real fixtures.
// ---------------------------------------------------------------------------

/** Smallest all-string array literal worth treating as a candidate string table. */
const MIN_ARRAY_ENTRIES = 8;
/** A plain (unwrapped) table only counts once it is read like a table. */
const MIN_TABLE_ENTRIES = 20;
const MIN_TABLE_READS = 10;
/** Below this many adjacent literal pairs, `+` chains are ordinary concatenation. */
const MIN_SPLIT_PAIRS = 5;
/** A single operator wrapper is a helper; a crowd of them is a storage object. */
const MIN_PROXY_WRAPPERS = 2;
/** Hex-name share of all declared/referenced identifiers that marks a generator. */
const MIN_HEX_NAME_SHARE = 0.5;
const MIN_HEX_NAMES = 5;
/** Escaped-string share before `unicodeEscapeSequence` is a credible explanation. */
const MIN_ESCAPE_SHARE = 0.2;
const MIN_ESCAPED_STRINGS = 5;

/** Identifiers emitted by `identifierNamesGenerator: 'hexadecimal'`. */
const HEX_IDENTIFIER = /^_0x[0-9a-f]{4,8}$/i;
/** The React automatic-runtime call names (`_jsx`, `jsxs`, `_jsxDEV`, ...). */
const JSX_RUNTIME_CALLEE = /^_?jsxs?(DEV)?$/;
/** Bundler runtime names. These are fixed by the bundler, not randomised. */
const WEBPACK_RUNTIME_NAMES = new Set([
  '__webpack_require__',
  '__webpack_modules__',
  '__webpack_exports__',
  'webpackJsonp',
]);
const JSX_RUNTIME_MODULES = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime']);
/**
 * The method list `disableConsoleOutput` actually emits in 5.6.0 - note it ships
 * `table` and omits `debug`, which the documented list has backwards.
 */
const CONSOLE_METHODS = new Set([
  'log',
  'warn',
  'info',
  'error',
  'exception',
  'table',
  'trace',
  'debug',
]);
/** The catastrophic-backtracking regex `selfDefending` searches its own source with. */
const REDOS_PATTERN = '(((.+)+)+)+$';
/** Payloads `debugProtection` hands to the `Function` constructor. */
const DEBUG_PAYLOADS = new Set(['debugger', 'while (true) {}']);

/**
 * Regex atoms that describe nothing but the *shape* of source text: whitespace,
 * line breaks, and the punctuation a printer moves around. A pattern assembled
 * from only these cannot be matching data - it is measuring how the program was
 * printed, which is the one thing a deobfuscator is guaranteed to change.
 */
const SOURCE_SHAPE_ATOM = /^(?:\\[nrstS]|\\[^A-Za-z0-9]|[\s|(){}[\].,;:^$+*?/-])+$/;
/** Longest pattern still credible as a formatting probe rather than real data. */
const MAX_SHAPE_PATTERN = 64;

/** Members that mean an expression is reading the page's own address. */
const LOCATION_MEMBERS = new Set(['hostname', 'href', 'host', 'origin', 'location', 'domain']);

/** Mirrors `clean.anti-tamper`: the volume and uniformity that make a flood a flood. */
const MIN_DEBUGGER_FLOOD = 20;
const MIN_FLOOD_BLOCKS = 8;
const MIN_FLOOD_SHARE = 0.9;

const ARITHMETIC_OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '|',
  '&',
  '^',
  '<<',
  '>>',
  '>>>',
]);

/** Report order, so callers and snapshots see a stable list. */
const KIND_ORDER: readonly DetectionKind[] = [
  'string-array',
  'string-array-rotate',
  'string-array-wrapper',
  'string-encoding-base64',
  'string-encoding-rc4',
  'control-flow-flattening',
  'dead-code-injection',
  'debug-protection',
  'self-defending',
  'console-disable',
  'object-key-map',
  'proxy-functions',
  'numbers-to-expressions',
  'split-strings',
  'hex-identifiers',
  'unicode-escapes',
  'webpack-bundle',
  'jsx-runtime',
  'eval-packer',
];

/**
 * Facts a caller already knows that the AST can no longer show.
 *
 * The only real case is escape density: `prepare.normalize-literals` strips
 * `extra.raw` from hex-escaped strings, and because visitor passes in a stage run
 * before `run` passes, the raws are already gone by the time the detect pass
 * executes inside the pipeline. Standalone `analyze()` sees intact raws and needs
 * none of this.
 */
export interface DetectionHints {
  strippedEscapes?: { escaped: number; total: number };
}

/** Descendant-of flags carried down the walk stack. */
const IN_UNBOUNDED_LOOP = 1;

export function detectObfuscation(ast: t.File, hints: DetectionHints = {}): Detection[] {
  const evidence = new Evidence();
  scan(ast.program, evidence);
  return evidence.conclude(hints);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Depth-first walk over `VISITOR_KEYS` using three parallel stacks.
 *
 * Parallel arrays rather than a stack of `{node, parent, flags}` objects: at
 * 400k nodes the per-node allocation is the dominant cost, and this shape has
 * none.
 */
/** Hoisted out of the namespace object: this is read once per node visited. */
const VISITOR_KEYS = t.VISITOR_KEYS;

function scan(root: t.Node, evidence: Evidence): void {
  const nodes: t.Node[] = [root];
  const parents: (t.Node | null)[] = [null];
  const flagStack: number[] = [0];

  while (nodes.length > 0) {
    const node = nodes.pop() as t.Node;
    const parent = parents.pop() as t.Node | null;
    const flags = flagStack.pop() as number;

    evidence.visit(node, parent, flags);

    const childFlags = isUnboundedLoop(node) ? flags | IN_UNBOUNDED_LOOP : flags;
    const keys = VISITOR_KEYS[node.type];
    if (!keys) continue;
    for (const key of keys) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (!child || typeof child !== 'object') continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          if (!isNode(item)) continue;
          nodes.push(item);
          parents.push(node);
          flagStack.push(childFlags);
        }
      } else if (isNode(child)) {
        nodes.push(child);
        parents.push(node);
        flagStack.push(childFlags);
      }
    }
  }
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

interface WrapperCandidate {
  /** Name the wrapper was declared under, if it has one. */
  name: string;
  /** Identifier it forwards to. */
  target: string;
}

class Evidence {
  // --- string table -------------------------------------------------------
  /** `binding name -> entry count` for all-string array literals. */
  readonly stringArrays = new Map<string, number>();
  /** `binding name -> count` of `X[<number>]` reads. */
  readonly numericIndexReads = new Map<string, number>();
  /** Self-replacing `function f(){var a=[...]; f=function(){return a}; return f()}`. */
  thunkArrays = 0;
  thunkEntries = 0;

  // --- rotation -----------------------------------------------------------
  rotations = 0;
  checksumParseInts = 0;

  // --- decoder / wrappers -------------------------------------------------
  readonly decoderRoots = new Set<string>();
  /** `alias -> source` edges from `var a = b` and `a = b`. */
  readonly aliasEdges: Array<[string, string]> = [];
  readonly wrapperCandidates: WrapperCandidate[] = [];

  // --- encodings ----------------------------------------------------------
  base64Alphabets = 0;
  base64Rotated = false;
  rc4IdentityFills = 0;
  rc4XorIndex = 0;
  rc4KeyStreamMods = 0;

  // --- structural transforms ---------------------------------------------
  cffDispatchers = 0;
  cffOrderStrings = 0;
  constantPredicateIfs = 0;
  explodedObjects = 0;
  literalAliasMaps = 0;
  proxyWrappers = 0;
  numberExpressions = 0;
  numberExpressionLeaves = 0;

  // --- anti-tamper --------------------------------------------------------
  functionConstructorCalls = 0;
  computedCallsOnFunctionLiteral = 0;
  debuggerStatements = 0;
  debugPayloadConcats = 0;
  selfRecursiveIncrements = 0;
  redosLiterals = 0;
  toStringGuards = 0;
  consoleMethodTables = 0;
  consoleMethodNames: string[] = [];
  /** `debugger` statements leading a block, and how many blocks carry one. */
  leadingDebuggers = 0;
  floodedBlocks = 0;
  /** `if (...) { while (true) {} }` - a branch that hangs and does nothing else. */
  hangGuards = 0;
  /** Regexes whose whole pattern describes source layout rather than data. */
  sourceShapeRegexes = 0;
  /** `re.test(fn)` - a pattern matched against a value that is not a string. */
  functionShapeProbes = 0;
  /** Stubs that checksum an implementation's printed source before forwarding. */
  integrityTrampolines = 0;
  /** Reads of the page's own address, which is what a domain lock compares. */
  locationReads = 0;

  // --- lexical ------------------------------------------------------------
  readonly identifierNames = new Set<string>();
  readonly hexIdentifierNames = new Set<string>();
  totalStrings = 0;
  escapedStrings = 0;

  // --- split strings ------------------------------------------------------
  splitPairs = 0;
  readonly splitChunkLengths = new Map<number, number>();

  // --- packaging ----------------------------------------------------------
  webpackRuntimeRefs = 0;
  webpackModuleMaps = 0;
  jsxRuntimeCalls = 0;
  jsxRuntimeImports = 0;
  evalPackers = 0;

  visit(node: t.Node, parent: t.Node | null, flags: number): void {
    switch (node.type) {
      case 'Identifier':
        this.visitIdentifier(node, parent);
        return;
      case 'StringLiteral':
        this.visitStringLiteral(node);
        return;
      case 'DebuggerStatement':
        this.debuggerStatements++;
        return;
      case 'MemberExpression':
        this.visitMemberExpression(node);
        return;
      case 'CallExpression':
        this.visitCallExpression(node, flags);
        return;
      case 'NewExpression':
        if (t.isIdentifier(node.callee, { name: 'RegExp' })) {
          const pattern = node.arguments[0];
          if (t.isStringLiteral(pattern) && isSourceShapePattern(pattern.value)) {
            this.sourceShapeRegexes++;
          }
        }
        return;
      case 'RegExpLiteral':
        if (isSourceShapePattern(node.pattern)) this.sourceShapeRegexes++;
        return;
      case 'BinaryExpression':
        this.visitBinaryExpression(node, parent);
        return;
      case 'AssignmentExpression':
        if (node.operator === '=' && t.isIdentifier(node.left) && t.isIdentifier(node.right)) {
          this.aliasEdges.push([node.left.name, node.right.name]);
        }
        return;
      case 'VariableDeclaration':
        this.visitVariableDeclaration(node);
        return;
      case 'SwitchStatement':
        this.visitSwitchStatement(node);
        return;
      case 'SwitchCase':
        this.scanStatementList(node.consequent);
        return;
      case 'Program':
      case 'BlockStatement':
        this.scanStatementList(node.body);
        return;
      case 'ForStatement':
        this.visitForStatement(node);
        return;
      case 'IfStatement':
        this.visitIfStatement(node);
        return;
      case 'ObjectExpression':
        this.visitObjectExpression(node);
        return;
      case 'ImportDeclaration':
        if (JSX_RUNTIME_MODULES.has(node.source.value)) this.jsxRuntimeImports++;
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.visitFunction(node, parent);
        return;
      default:
        return;
    }
  }

  // -- leaves --------------------------------------------------------------

  private visitIdentifier(node: t.Identifier, parent: t.Node | null): void {
    if (WEBPACK_RUNTIME_NAMES.has(node.name)) this.webpackRuntimeRefs++;
    // Property and key positions are a different namespace from bindings;
    // counting `obj.length` as an identifier would drown the hex-name ratio.
    if (parent && isPropertyPosition(node, parent)) return;
    // Set membership before the regex: on the heavy fixture there are 12,703
    // distinct names across hundreds of thousands of references, so testing the
    // pattern once per name rather than once per occurrence is most of the cost.
    if (this.identifierNames.has(node.name)) return;
    this.identifierNames.add(node.name);
    if (HEX_IDENTIFIER.test(node.name)) this.hexIdentifierNames.add(node.name);
  }

  private visitStringLiteral(node: t.StringLiteral): void {
    this.totalStrings++;
    const raw = node.extra?.['raw'];
    if (typeof raw === 'string' && hasVerboseEscape(raw)) this.escapedStrings++;

    const value = node.value;
    if (value === REDOS_PATTERN) this.redosLiterals++;
    if (value.length >= 64 && isBase64Alphabet(value)) {
      this.base64Alphabets++;
      // obfuscator.io emits a lowercase-first alphabet, so a stock base64
      // decoder produces plausible-looking garbage rather than an error.
      if (value[0] !== 'A') this.base64Rotated = true;
    }
  }

  private visitMemberExpression(node: t.MemberExpression): void {
    if (node.computed && t.isIdentifier(node.object) && t.isNumericLiteral(node.property)) {
      const name = node.object.name;
      this.numericIndexReads.set(name, (this.numericIndexReads.get(name) ?? 0) + 1);
    }
    if (t.isIdentifier(node.object, { name: 'location' })) {
      this.locationReads++;
      return;
    }
    const key = memberKey(node);
    if (key !== undefined && LOCATION_MEMBERS.has(key)) this.locationReads++;
  }

  private visitCallExpression(node: t.CallExpression, flags: number): void {
    const callee = node.callee;

    if (t.isIdentifier(callee)) {
      this.visitPlainCall(callee.name, node, flags);
      return;
    }
    if (!t.isMemberExpression(callee)) return;
    const method = memberKey(callee);

    if (method === 'push' && node.arguments.length === 1) {
      const inner = node.arguments[0];
      if (
        t.isCallExpression(inner) &&
        inner.arguments.length === 0 &&
        memberKey(inner.callee) === 'shift' &&
        // The rotation loop is unbounded by construction: its only exit is the
        // checksum match. A bare `q.push(q.shift())` is an ordinary queue idiom.
        (flags & IN_UNBOUNDED_LOOP) !== 0
      ) {
        this.rotations++;
      } else if (looksLikeWebpackChunk(node)) {
        this.webpackModuleMaps++;
      }
      return;
    }

    // `function(){}['constructor']('debu' + 'gger')` - reaching the `Function`
    // constructor through a function literal. `.call` / `.apply` / `.bind` on an
    // IIFE are ordinary minified code and are deliberately not counted.
    if (t.isFunctionExpression(callee.object) || t.isArrowFunctionExpression(callee.object)) {
      if (method === 'constructor') this.functionConstructorCalls++;
      else if (method === undefined) this.computedCallsOnFunctionLiteral++;
    }

    // A guard that measures the program's own source text: `re.test(f.toString())`
    // or `f.toString().indexOf('\n') !== -1`. Both break the moment output is
    // reformatted, which is exactly what they are there to notice.
    if (method === 'test' || method === 'search' || method === 'match' || method === 'exec') {
      const objectIsToString =
        t.isCallExpression(callee.object) && memberKey(callee.object.callee) === 'toString';
      const argumentIsToString = node.arguments.some(
        (arg) => t.isCallExpression(arg) && memberKey(arg.callee) === 'toString',
      );
      if (objectIsToString || argumentIsToString) this.toStringGuards++;
      // `re.test(fn)` with no `toString` in sight: passing a non-string to a
      // regex method coerces it, which is how a source probe hides the word.
      // Meaningless alone - paired with a formatting-only pattern it is not.
      if (node.arguments.length === 1 && t.isIdentifier(node.arguments[0])) {
        this.functionShapeProbes++;
      }
      return;
    }
    // `indexOf` needs the extra newline check: `n.toString().indexOf('.')` is
    // ordinary number formatting, and only the newline probe is a beautify guard.
    if (method === 'indexOf' && t.isCallExpression(callee.object)) {
      const probe = node.arguments[0];
      if (
        memberKey(callee.object.callee) === 'toString' &&
        t.isStringLiteral(probe) &&
        probe.value.includes('\n')
      ) {
        this.toStringGuards++;
      }
      return;
    }

    if (method === 'split' && node.arguments.length === 1) {
      const separator = node.arguments[0];
      if (t.isStringLiteral(separator) && separator.value === '|') this.cffOrderStrings++;
      return;
    }

    // `React.createElement(type, props, ...)`. One-argument calls are
    // `document.createElement('div')` and must not count.
    if (method === 'createElement' && node.arguments.length >= 2) {
      const props = node.arguments[1];
      if (t.isObjectExpression(props) || t.isNullLiteral(props)) this.jsxRuntimeCalls++;
    }
  }

  private visitPlainCall(name: string, node: t.CallExpression, flags: number): void {
    if (name === 'parseInt' && (flags & IN_UNBOUNDED_LOOP) !== 0) this.checksumParseInts++;
    if (JSX_RUNTIME_CALLEE.test(name)) this.jsxRuntimeCalls++;

    const first = node.arguments[0];
    if (name === 'eval' && node.arguments.length === 1 && first && isPackerPayload(first)) {
      this.evalPackers++;
    }
    if (name === 'require' && t.isStringLiteral(first) && JSX_RUNTIME_MODULES.has(first.value)) {
      this.jsxRuntimeImports++;
    }
    // `f(++n)` with no base case - the debugProtection recursion.
    if (node.arguments.length === 1 && t.isUpdateExpression(first) && first.prefix) {
      this.selfRecursiveIncrements++;
    }
  }

  private visitBinaryExpression(node: t.BinaryExpression, parent: t.Node | null): void {
    // RC4 PRGA: `... ^ S[(S[i] + S[j]) % 256]`.
    if (node.operator === '^') {
      for (const side of [node.left, node.right]) {
        if (
          t.isMemberExpression(side) &&
          side.computed &&
          t.isBinaryExpression(side.property) &&
          side.property.operator === '%' &&
          isNumber(side.property.right, 256)
        ) {
          this.rc4XorIndex++;
        }
      }
    }
    if (node.operator === '%' && isNumber(node.right, 256)) this.rc4KeyStreamMods++;

    // Only look at chain roots so each `+`/arithmetic tree is flattened once.
    const isChainRoot = !(
      parent &&
      t.isBinaryExpression(parent) &&
      ARITHMETIC_OPERATORS.has(parent.operator)
    );
    if (!isChainRoot || !ARITHMETIC_OPERATORS.has(node.operator)) return;

    const numeric = collectNumericLeaves(node);
    if (numeric !== undefined && numeric >= 3) {
      this.numberExpressions++;
      this.numberExpressionLeaves = Math.max(this.numberExpressionLeaves, numeric);
      return;
    }

    if (node.operator !== '+') return;
    const leaves = flattenConcat(node);
    if (leaves.length < 2) return;

    // `splitStrings` leaves adjacent literals behind. Each literal that touches
    // another literal contributes its length once, so the modal length recovers
    // the configured chunk size.
    let allStrings = true;
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      if (!t.isStringLiteral(leaf)) {
        allStrings = false;
        continue;
      }
      const before = i > 0 ? leaves[i - 1] : undefined;
      const after = leaves[i + 1];
      if (before && t.isStringLiteral(before)) this.splitPairs++;
      if ((before && t.isStringLiteral(before)) || (after && t.isStringLiteral(after))) {
        const length = leaf.value.length;
        this.splitChunkLengths.set(length, (this.splitChunkLengths.get(length) ?? 0) + 1);
      }
    }

    if (!allStrings) return;
    let joined = '';
    for (const leaf of leaves) joined += (leaf as t.StringLiteral).value;
    if (DEBUG_PAYLOADS.has(joined)) this.debugPayloadConcats++;
  }

  private visitVariableDeclaration(node: t.VariableDeclaration): void {
    for (const declarator of node.declarations) {
      if (!t.isIdentifier(declarator.id)) continue;
      const init = declarator.init;
      if (!init) continue;
      if (t.isIdentifier(init)) {
        this.aliasEdges.push([declarator.id.name, init.name]);
        continue;
      }
      if (t.isArrayExpression(init)) this.recordArrayLiteral(declarator.id.name, init);
    }
  }

  private recordArrayLiteral(name: string, array: t.ArrayExpression): void {
    const elements = array.elements;
    if (elements.length < 4) return;
    for (const element of elements) if (!t.isStringLiteral(element)) return;

    if (elements.length >= MIN_ARRAY_ENTRIES) {
      this.stringArrays.set(name, Math.max(this.stringArrays.get(name) ?? 0, elements.length));
    }

    // `disableConsoleOutput` builds its method list as a plain string array.
    // The bound keeps the 29,649-entry table off this path entirely.
    if (elements.length > CONSOLE_METHODS.size) return;
    for (const element of elements) {
      if (!CONSOLE_METHODS.has((element as t.StringLiteral).value)) return;
    }
    this.consoleMethodTables++;
    if (this.consoleMethodNames.length === 0) {
      this.consoleMethodNames = elements.map((element) => (element as t.StringLiteral).value);
    }
  }

  private visitSwitchStatement(node: t.SwitchStatement): void {
    // `switch (order[i++])` with decimal-string case labels is the flattening
    // dispatcher. Genuine switches discriminate on a value, not on a cursor.
    const discriminant = node.discriminant;
    if (!t.isMemberExpression(discriminant) || !discriminant.computed) return;
    if (!t.isUpdateExpression(discriminant.property)) return;
    let digitCases = 0;
    for (const switchCase of node.cases) {
      if (switchCase.test && t.isStringLiteral(switchCase.test) && /^\d+$/.test(switchCase.test.value)) {
        digitCases++;
      }
    }
    if (digitCases >= 3) this.cffDispatchers++;
  }

  private visitForStatement(node: t.ForStatement): void {
    // RC4 KSA identity fill: `for (i = 0; i < 256; i++) S[i] = i;`
    const test = node.test;
    if (!t.isBinaryExpression(test) || test.operator !== '<' || !isNumber(test.right, 256)) return;
    if (!t.isIdentifier(test.left)) return;
    const counter = test.left.name;
    const body = t.isBlockStatement(node.body) ? node.body.body : [node.body];
    for (const statement of body) {
      if (!t.isExpressionStatement(statement)) continue;
      const assignment = statement.expression;
      if (!t.isAssignmentExpression(assignment) || assignment.operator !== '=') continue;
      const target = assignment.left;
      if (
        t.isMemberExpression(target) &&
        target.computed &&
        t.isIdentifier(target.property) &&
        target.property.name === counter &&
        t.isIdentifier(assignment.right) &&
        assignment.right.name === counter
      ) {
        this.rc4IdentityFills++;
        return;
      }
    }
  }

  private visitIfStatement(node: t.IfStatement): void {
    // A branch that loops forever and does nothing is not a behaviour any
    // program wants; it is what an anti-tamper guard does when it is unhappy.
    if (branchHangs(node.consequent) || branchHangs(node.alternate)) this.hangGuards++;

    // deadCodeInjection emits a comparison of two compile-time constants and
    // hides the real code in the branch that never runs.
    const test = node.test;
    if (!t.isBinaryExpression(test)) return;
    if (test.operator !== '===' && test.operator !== '!==' && test.operator !== '==' && test.operator !== '!=') {
      return;
    }
    if (isConstantOperand(test.left) && isConstantOperand(test.right)) this.constantPredicateIfs++;
  }

  private visitObjectExpression(node: t.ObjectExpression): void {
    const properties = node.properties;
    if (properties.length < 3) return;
    for (const property of properties) {
      if (!t.isObjectProperty(property) || property.computed) return;
      if (!t.isStringLiteral(property.key)) return;
      if (!t.isStringLiteral(property.value) && !t.isNumericLiteral(property.value)) return;
    }
    this.literalAliasMaps++;
  }

  private visitFunction(
    node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
    parent: t.Node | null,
  ): void {
    const declaredName = functionName(node, parent);
    const body = t.isBlockStatement(node.body) ? node.body.body : undefined;

    if (body && isIntegrityTrampoline(body)) this.integrityTrampolines++;
    if (body && node.params.length === 0) this.recordThunk(body);

    if (node.params.length >= 1 && node.params.length <= 2 && body && declaredName) {
      if (hasIndexShift(node.params, body) || hasTableLookup(node.params, body)) {
        this.decoderRoots.add(declaredName);
      }
    }

    const returned = singleReturnValue(node, body);
    if (!returned) return;

    if (declaredName && t.isCallExpression(returned) && t.isIdentifier(returned.callee)) {
      this.wrapperCandidates.push({ name: declaredName, target: returned.callee.name });
    }
    if (isOperatorWrapper(node.params, returned) && isStoredAsProperty(node, parent)) {
      this.proxyWrappers++;
    }
  }

  /** `function f(){ var a = [...]; f = function(){ return a; }; return f(); }` */
  private recordThunk(body: readonly t.Statement[]): void {
    let arrayName: string | undefined;
    let entries = 0;
    for (const statement of body) {
      if (!t.isVariableDeclaration(statement)) continue;
      for (const declarator of statement.declarations) {
        if (!t.isIdentifier(declarator.id) || !t.isArrayExpression(declarator.init)) continue;
        const elements = declarator.init.elements;
        if (elements.length < MIN_ARRAY_ENTRIES) continue;
        if (!elements.every((element) => t.isStringLiteral(element))) continue;
        arrayName = declarator.id.name;
        entries = elements.length;
      }
    }
    if (!arrayName) return;

    for (const statement of body) {
      if (!t.isExpressionStatement(statement)) continue;
      const expression = statement.expression;
      if (!t.isAssignmentExpression(expression) || !t.isIdentifier(expression.left)) continue;
      const replacement = expression.right;
      if (!t.isFunctionExpression(replacement) && !t.isArrowFunctionExpression(replacement)) continue;
      const returned = singleReturnValue(replacement, t.isBlockStatement(replacement.body) ? replacement.body.body : undefined);
      if (returned && t.isIdentifier(returned) && returned.name === arrayName) {
        this.thunkArrays++;
        this.thunkEntries = Math.max(this.thunkEntries, entries);
        return;
      }
    }
  }

  /**
   * `transformObjectKeys` inversion signal: an object built empty, filled by a
   * contiguous run of computed assignments, then handed to an alias. The alias
   * is what makes this unambiguous - plain `var x = {}; x[k] = v;` is everyday
   * code and appears 17 times in the light fixture, which must stay clean.
   */
  private scanStatementList(list: readonly t.Statement[]): void {
    // A `debugger` flood is recognised by placement, not volume: this protector
    // prepends the keyword to the head of a block, so the leading run is the
    // mechanical part and anything deeper in the block is somebody's breakpoint.
    let leading = 0;
    while (leading < list.length && t.isDebuggerStatement(list[leading] as t.Node)) leading++;
    if (leading > 0) {
      this.leadingDebuggers += leading;
      this.floodedBlocks++;
    }

    for (let i = 0; i < list.length; i++) {
      const statement = list[i];
      if (!t.isVariableDeclaration(statement)) continue;
      const declarator = statement.declarations[statement.declarations.length - 1];
      if (!declarator || !t.isIdentifier(declarator.id)) continue;
      if (!t.isObjectExpression(declarator.init) || declarator.init.properties.length !== 0) continue;

      const name = declarator.id.name;
      let cursor = i + 1;
      let writes = 0;
      for (; cursor < list.length; cursor++) {
        const next = list[cursor];
        if (!t.isExpressionStatement(next)) break;
        const assignment = next.expression;
        if (!t.isAssignmentExpression(assignment) || assignment.operator !== '=') break;
        const target = assignment.left;
        if (!t.isMemberExpression(target) || !target.computed) break;
        if (!t.isIdentifier(target.object) || target.object.name !== name) break;
        writes++;
      }
      if (writes === 0) continue;

      const tail = list[cursor];
      if (!tail || !t.isVariableDeclaration(tail)) continue;
      const aliased = tail.declarations.some(
        (d) => t.isIdentifier(d.id) && t.isIdentifier(d.init) && d.init.name === name,
      );
      if (aliased) this.explodedObjects++;
    }
  }

  // -- conclusions ---------------------------------------------------------

  conclude(hints: DetectionHints): Detection[] {
    const found = new Map<DetectionKind, Detection>();
    const add = (kind: DetectionKind, evidence: string, confidence: number, count?: number): void => {
      const existing = found.get(kind);
      if (existing && existing.confidence >= confidence) return;
      found.set(kind, { kind, confidence, evidence, count });
    };

    this.concludeStringTable(add);
    this.concludeEncodings(add);
    this.concludeStructure(add);
    this.concludeAntiTamper(add);
    this.concludeLexical(add, hints);
    this.concludePackaging(add);

    const ordered: Detection[] = [];
    for (const kind of KIND_ORDER) {
      const detection = found.get(kind);
      if (detection) ordered.push(detection);
    }
    return ordered;
  }

  private concludeStringTable(add: AddDetection): void {
    if (this.thunkArrays > 0) {
      add(
        'string-array',
        `self-replacing string-array thunk holding ${this.thunkEntries} entries`,
        0.98,
        this.thunkEntries,
      );
    }
    for (const [name, entries] of this.stringArrays) {
      if (entries < MIN_TABLE_ENTRIES) continue;
      const reads = this.numericIndexReads.get(name) ?? 0;
      if (reads < MIN_TABLE_READS) continue;
      add(
        'string-array',
        `${entries}-entry string array read at ${reads} numeric index sites`,
        reads >= 100 ? 0.97 : 0.8,
        entries,
      );
    }

    if (this.rotations > 0) {
      const checksum = this.checksumParseInts > 0 ? ` guarded by a ${this.checksumParseInts}-term parseInt checksum` : '';
      add(
        'string-array-rotate',
        `push(shift()) rotation inside an unbounded loop${checksum}`,
        0.97,
        this.rotations,
      );
    }

    const closure = this.resolveDecoderClosure();
    if (closure.size > this.decoderRoots.size) {
      const aliases = closure.size - this.decoderRoots.size;
      add(
        'string-array-wrapper',
        `${aliases} decoder aliases resolved from ${this.decoderRoots.size} decoder root(s)`,
        0.95,
        aliases,
      );
    }
  }

  /**
   * Union-find over `var a = b` edges, seeded with functions that look like a
   * table decoder, then extended through single-return forwarding wrappers.
   * Bounded iteration: alias chains are three deep in the wild, ten is slack.
   */
  private resolveDecoderClosure(): Set<string> {
    const closure = new Set(this.decoderRoots);
    if (closure.size === 0) return closure;
    for (let round = 0; round < 10; round++) {
      let grew = false;
      for (const [alias, source] of this.aliasEdges) {
        if (closure.has(source) && !closure.has(alias)) {
          closure.add(alias);
          grew = true;
        }
      }
      for (const wrapper of this.wrapperCandidates) {
        if (closure.has(wrapper.target) && !closure.has(wrapper.name)) {
          closure.add(wrapper.name);
          grew = true;
        }
      }
      if (!grew) break;
    }
    return closure;
  }

  private concludeEncodings(add: AddDetection): void {
    if (this.base64Alphabets > 0) {
      const shape = this.base64Rotated ? 'rotated (lowercase-first)' : 'standard';
      add('string-encoding-base64', `${shape} 64-character base64 alphabet literal`, 0.95, this.base64Alphabets);
    }
    // Two independent RC4 landmarks. Either alone is a plausible accident in
    // byte-manipulation code; together they are the KSA and the PRGA.
    if (this.rc4IdentityFills > 0 && this.rc4XorIndex > 0) {
      add(
        'string-encoding-rc4',
        `RC4 key schedule (256-entry identity fill) and keystream XOR over a mod-256 index`,
        0.95,
        this.rc4IdentityFills,
      );
    }
  }

  private concludeStructure(add: AddDetection): void {
    if (this.cffDispatchers > 0) {
      const order = this.cffOrderStrings > 0 ? `, ${this.cffOrderStrings} pipe-separated order string(s)` : '';
      add(
        'control-flow-flattening',
        `${this.cffDispatchers} switch dispatcher(s) over an incrementing cursor${order}`,
        0.95,
        this.cffDispatchers,
      );
    }

    if (this.constantPredicateIfs > 0) {
      add(
        'dead-code-injection',
        `${this.constantPredicateIfs} if-statement(s) testing two compile-time constants`,
        this.constantPredicateIfs >= 3 ? 0.9 : 0.6,
        this.constantPredicateIfs,
      );
    }

    const objectMaps = this.explodedObjects + this.literalAliasMaps;
    if (objectMaps > 0) {
      const parts: string[] = [];
      if (this.explodedObjects > 0) parts.push(`${this.explodedObjects} object(s) built by computed assignment then aliased`);
      if (this.literalAliasMaps > 0) parts.push(`${this.literalAliasMaps} all-literal quoted-key alias map(s)`);
      add('object-key-map', parts.join(', '), objectMaps >= 3 ? 0.9 : 0.7, objectMaps);
    }

    if (this.proxyWrappers >= MIN_PROXY_WRAPPERS) {
      add(
        'proxy-functions',
        `${this.proxyWrappers} single-expression operator/call wrapper(s) stored as object members`,
        this.proxyWrappers >= 8 ? 0.95 : 0.7,
        this.proxyWrappers,
      );
    }

    if (this.numberExpressions > 0) {
      add(
        'numbers-to-expressions',
        `${this.numberExpressions} all-numeric arithmetic tree(s), up to ${this.numberExpressionLeaves} leaves`,
        this.numberExpressions >= 5 ? 0.9 : 0.6,
        this.numberExpressions,
      );
    }

    if (this.splitPairs >= MIN_SPLIT_PAIRS) {
      const { chunk, share } = this.modalChunkLength();
      add(
        'split-strings',
        `${this.splitPairs} adjacent string-literal pairs in + chains, modal chunk length ${chunk}`,
        clamp(share, 0.5, 0.95),
        this.splitPairs,
      );
    }
  }

  private modalChunkLength(): { chunk: number; share: number } {
    let chunk = 0;
    let best = 0;
    let total = 0;
    for (const [length, count] of this.splitChunkLengths) {
      total += count;
      if (count > best) {
        best = count;
        chunk = length;
      }
    }
    return { chunk, share: total > 0 ? best / total : 0 };
  }

  /**
   * Anti-tamper is the one area where a file routinely carries several
   * *different* mechanisms at once - obfuscator.io ships one, the commercial
   * protectors stack four - so each kind reports every signal it found rather
   * than only the loudest. The confidence stays that of the strongest signal;
   * the evidence names all of them, because "debug-protection" on its own does
   * not tell a reader whether to expect a `Function('debugger')` payload or four
   * hundred injected keywords.
   */
  private concludeAntiTamper(add: AddDetection): void {
    const debug = new Signals();
    if (this.functionConstructorCalls > 0) {
      debug.push(
        `${this.functionConstructorCalls} call(s) to Function via a function literal's constructor`,
        0.95,
        this.functionConstructorCalls,
      );
    } else if (this.computedCallsOnFunctionLiteral > 0 && this.selfRecursiveIncrements > 0) {
      // The property name is itself built from decoder calls, so `constructor`
      // is not readable yet; the shape `function(){}[...](...)` plus an unbounded
      // `f(++n)` recursion is still unmistakable.
      debug.push(
        `${this.computedCallsOnFunctionLiteral} computed call(s) on a function literal beside an f(++n) recursion`,
        0.85,
        this.computedCallsOnFunctionLiteral,
      );
    } else if (this.debugPayloadConcats > 0) {
      debug.push(
        `${this.debugPayloadConcats} concatenation(s) spelling a debugger payload`,
        0.85,
        this.debugPayloadConcats,
      );
    }

    // Placement, not volume. A handful of `debugger` keywords is a developer at
    // work; hundreds of them wedged uniformly at the head of a block is a tool.
    const floodShare =
      this.debuggerStatements > 0 ? this.leadingDebuggers / this.debuggerStatements : 0;
    if (
      this.leadingDebuggers >= MIN_DEBUGGER_FLOOD &&
      this.floodedBlocks >= MIN_FLOOD_BLOCKS &&
      floodShare >= MIN_FLOOD_SHARE
    ) {
      debug.push(
        `${this.leadingDebuggers} debugger statement(s) injected at the head of ${this.floodedBlocks} blocks`,
        0.95,
        this.leadingDebuggers,
      );
    } else if (this.debuggerStatements > 0 && debug.empty) {
      debug.push(`${this.debuggerStatements} debugger statement(s)`, 0.6, this.debuggerStatements);
    }
    debug.report('debug-protection', add);

    const defending = new Signals();
    if (this.redosLiterals > 0) {
      defending.push(
        `catastrophic-backtracking guard regex ${JSON.stringify(REDOS_PATTERN)}`,
        0.98,
        this.redosLiterals,
      );
    } else if (this.toStringGuards > 0) {
      defending.push(
        `${this.toStringGuards} guard(s) matching a pattern against a function's own toString()`,
        0.9,
        this.toStringGuards,
      );
    }
    // A pattern made only of whitespace and punctuation, matched against a value
    // the regex has to coerce: the implicit spelling of the same self-check.
    if (this.sourceShapeRegexes > 0 && this.functionShapeProbes > 0) {
      const probes = Math.min(this.sourceShapeRegexes, this.functionShapeProbes);
      defending.push(
        `${probes} formatting-only pattern(s) matched against a coerced function value`,
        0.9,
        probes,
      );
    }
    if (this.integrityTrampolines > 0) {
      defending.push(
        `${this.integrityTrampolines} stub(s) checksumming an implementation's printed source before forwarding to it`,
        0.95,
        this.integrityTrampolines,
      );
    }
    if (this.hangGuards > 0) {
      const lock = this.locationReads > 0 ? `, alongside ${this.locationReads} location read(s)` : '';
      defending.push(
        `${this.hangGuards} guard(s) whose failure branch is a non-terminating empty loop${lock}`,
        0.9,
        this.hangGuards,
      );
    }
    defending.report('self-defending', add);

    if (this.consoleMethodTables > 0) {
      add(
        'console-disable',
        `console method table [${this.consoleMethodNames.join(', ')}]`,
        0.9,
        this.consoleMethodTables,
      );
    }
  }

  private concludeLexical(add: AddDetection, hints: DetectionHints): void {
    const hexNames = this.hexIdentifierNames.size;
    const allNames = this.identifierNames.size;
    if (hexNames >= MIN_HEX_NAMES && allNames > 0) {
      const share = hexNames / allNames;
      if (share >= MIN_HEX_NAME_SHARE) {
        add(
          'hex-identifiers',
          `${hexNames} of ${allNames} distinct identifiers match _0x[0-9a-f]{4,8}`,
          clamp(share, 0.5, 0.99),
          hexNames,
        );
      }
    }

    const escapes = hints.strippedEscapes ?? { escaped: this.escapedStrings, total: this.totalStrings };
    if (escapes.escaped >= MIN_ESCAPED_STRINGS && escapes.total > 0) {
      const share = escapes.escaped / escapes.total;
      if (share >= MIN_ESCAPE_SHARE) {
        add(
          'unicode-escapes',
          `${escapes.escaped} of ${escapes.total} string literals written with \\x / \\u / octal escapes`,
          clamp(share, 0.5, 0.99),
          escapes.escaped,
        );
      }
    }
  }

  private concludePackaging(add: AddDetection): void {
    if (this.webpackRuntimeRefs > 0) {
      add('webpack-bundle', `${this.webpackRuntimeRefs} webpack runtime reference(s)`, 0.95, this.webpackRuntimeRefs);
    } else if (this.webpackModuleMaps > 0) {
      add('webpack-bundle', `${this.webpackModuleMaps} chunk push with a module-id map`, 0.8, this.webpackModuleMaps);
    }

    if (this.jsxRuntimeImports > 0) {
      add('jsx-runtime', `import of the React automatic JSX runtime`, 0.98, this.jsxRuntimeImports);
    } else if (this.jsxRuntimeCalls > 0) {
      add('jsx-runtime', `${this.jsxRuntimeCalls} JSX factory call(s)`, 0.85, this.jsxRuntimeCalls);
    }

    if (this.evalPackers > 0) {
      add('eval-packer', `eval() of a packer function's return value`, 0.95, this.evalPackers);
    }
  }
}

type AddDetection = (
  kind: DetectionKind,
  evidence: string,
  confidence: number,
  count?: number,
) => void;

/**
 * Several independent signals for one detection kind, collapsed into a single
 * honest report: every signal is named in the evidence, and the confidence and
 * count are the strongest signal's rather than a blend that means nothing.
 */
class Signals {
  private readonly parts: string[] = [];
  private confidence = 0;
  private count = 0;

  get empty(): boolean {
    return this.parts.length === 0;
  }

  push(evidence: string, confidence: number, count: number): void {
    this.parts.push(evidence);
    if (confidence > this.confidence) {
      this.confidence = confidence;
      this.count = count;
    }
  }

  report(kind: DetectionKind, add: AddDetection): void {
    if (this.parts.length === 0) return;
    add(kind, this.parts.join('; '), this.confidence, this.count);
  }
}

/**
 * The `self-defending` signals that read the program's own printed text: a
 * regex over a function's `toString()`, a checksum of it. Each is a fragment
 * of the evidence `concludeAntiTamper` writes for that signal and nothing else.
 */
const REPRINT_PROBES = ['guard regex', "function's own toString()", 'formatting-only pattern', 'checksumming'];

/**
 * Whether reprinting the file is what trips this detection.
 *
 * A guard that matches its own source hangs on any text but the one it was
 * built with, and every run of this engine reprints. A guard whose failure
 * branch merely hangs - a domain lock - fails on the same condition before and
 * after, so it is not the same hazard even though both report `self-defending`.
 */
export function trippedByReprinting(detection: Detection): boolean {
  if (detection.kind !== 'self-defending') return false;
  return REPRINT_PROBES.some((probe) => detection.evidence.includes(probe));
}

// ---------------------------------------------------------------------------
// Shape predicates
// ---------------------------------------------------------------------------

/** Switched on the type string rather than `t.isX`, because it runs per node. */
function isUnboundedLoop(node: t.Node): boolean {
  switch (node.type) {
    case 'ForStatement':
      return node.test === null;
    case 'WhileStatement':
    case 'DoWhileStatement':
      return isAlwaysTruthy(node.test);
    default:
      return false;
  }
}

/** `true`, `1`, `!![]`, `!0` - the forms obfuscators write an infinite loop with. */
function isAlwaysTruthy(node: t.Node): boolean {
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value !== 0;
  if (t.isStringLiteral(node)) return node.value.length > 0;
  if (t.isArrayExpression(node) || t.isObjectExpression(node)) return true;
  if (t.isUnaryExpression(node) && node.operator === '!') {
    const inner = node.argument;
    if (t.isUnaryExpression(inner) && inner.operator === '!') return isAlwaysTruthy(inner.argument);
    if (t.isNumericLiteral(inner)) return inner.value === 0;
    if (t.isBooleanLiteral(inner)) return !inner.value;
  }
  return false;
}

/**
 * `while (1) {}`, `while (true) {}`, `for (;;) {}` - a loop that cannot exit and
 * cannot be observed doing anything.
 *
 * A body holding nothing but `debugger` counts as empty: the protector that
 * emits these also floods `debugger` into every block, this one included, and
 * the trap has to stay recognisable whichever removal runs first.
 *
 * Exported because `clean.anti-tamper` decides what to delete on exactly this
 * definition, and a detector that disagreed with the pass about what a trap is
 * would report one thing and remove another.
 */
export function isHangTrap(node: t.Node): boolean {
  if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
    return isAlwaysTruthy(node.test) && isInertBody(node.body);
  }
  if (t.isForStatement(node)) return node.test == null && isInertBody(node.body);
  return false;
}

function isInertBody(body: t.Statement): boolean {
  if (t.isEmptyStatement(body)) return true;
  if (!t.isBlockStatement(body) || body.directives.length > 0) return false;
  return body.body.every(
    (statement) => t.isDebuggerStatement(statement) || t.isEmptyStatement(statement),
  );
}

/** A branch of an `if` that does nothing but hang. */
export function branchHangs(branch: t.Statement | null | undefined): boolean {
  if (!branch) return false;
  if (isHangTrap(branch)) return true;
  if (!t.isBlockStatement(branch) || branch.directives.length > 0) return false;
  const real = branch.body.filter(
    (statement) => !t.isDebuggerStatement(statement) && !t.isEmptyStatement(statement),
  );
  return real.length === 1 && real[0] !== undefined && isHangTrap(real[0]);
}

/**
 * Whether a regex pattern describes the layout of source text and nothing else.
 *
 * The point of the test is what it *rejects*: a pattern containing a letter, a
 * digit or any character class is matching data, not layout, and is out of
 * scope. A pattern that is only whitespace and punctuation, and that actually
 * probes for whitespace, has no use except measuring how the program was printed.
 */
export function isSourceShapePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_SHAPE_PATTERN) return false;
  if (!SOURCE_SHAPE_ATOM.test(pattern)) return false;
  // It has to actually probe whitespace. `\.` on its own is a decimal-point test.
  return /\\[nrst]|[\n\r\t ]/.test(pattern);
}

/**
 * The source-integrity trampoline shape:
 *
 *     var digest = impl.k || (impl.k = hash(impl, seed));
 *     if (digest === 1228482746886050) { return impl(a, b); } else { while (true) {} }
 *
 * The hash is taken over `impl`'s printed source, so the comparison is a
 * checksum of the file's own formatting. Detection only needs the memoised
 * digest of a named value guarding a branch that hangs; `clean.anti-tamper`
 * checks the forwarding call as well before it rewrites anything.
 */
function isIntegrityTrampoline(body: readonly t.Statement[]): boolean {
  if (body.length !== 2) return false;
  const [declaration, guard] = body;
  if (!t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1) return false;
  if (!t.isIfStatement(guard)) return false;
  if (!branchHangs(guard.consequent) && !branchHangs(guard.alternate)) return false;

  const declarator = declaration.declarations[0];
  if (!declarator || !t.isIdentifier(declarator.id)) return false;
  const init = declarator.init;
  if (!t.isLogicalExpression(init) || init.operator !== '||') return false;
  if (!t.isMemberExpression(init.left) || !t.isIdentifier(init.left.object)) return false;

  const name = init.left.object.name;
  const store = init.right;
  if (!t.isAssignmentExpression(store) || store.operator !== '=') return false;
  if (!t.isMemberExpression(store.left) || !t.isIdentifier(store.left.object, { name })) return false;
  if (!t.isCallExpression(store.right)) return false;
  return store.right.arguments.some((argument) => t.isIdentifier(argument, { name }));
}

function isPropertyPosition(node: t.Identifier, parent: t.Node): boolean {
  if (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) {
    return parent.property === node && !parent.computed;
  }
  if (
    t.isObjectProperty(parent) ||
    t.isObjectMethod(parent) ||
    t.isClassMethod(parent) ||
    t.isClassProperty(parent)
  ) {
    return parent.key === node && !parent.computed;
  }
  return false;
}

/** The property name of `a.b` / `a['b']`, or `undefined` when it is dynamic. */
function memberKey(node: t.Node): string | undefined {
  if (!t.isMemberExpression(node)) return undefined;
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (node.computed && t.isStringLiteral(node.property)) return node.property.value;
  return undefined;
}

function isNumber(node: t.Node, value: number): boolean {
  return t.isNumericLiteral(node) && node.value === value;
}

/** All 62 alphanumerics plus `+` and `/`, in any order - including rotated. */
function isBase64Alphabet(value: string): boolean {
  if (value.length > 70) return false;
  const seen = new Set(value);
  for (let code = 65; code <= 90; code++) if (!seen.has(String.fromCharCode(code))) return false;
  for (let code = 97; code <= 122; code++) if (!seen.has(String.fromCharCode(code))) return false;
  for (let digit = 0; digit <= 9; digit++) if (!seen.has(String(digit))) return false;
  return seen.has('+') && seen.has('/');
}

/**
 * True when the raw text spells a character with an escape a minimal printer
 * would not use - `\xNN`, `\uNNNN` for an ordinary printable, or a legacy octal.
 * `\n`, `\\`, `\'` and the line-separator escapes are all minimal already, so a
 * raw containing only those is left alone and reports no change.
 */
export function hasVerboseEscape(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 0x5c) continue;
    const next = raw[i + 1];
    if (next === undefined) return false;
    if (next === 'x') return true;
    if (next >= '0' && next <= '7') return true;
    if (next === 'u') {
      const code = unicodeEscapeValue(raw, i + 2);
      if (code === undefined) return true;
      if (!mustStayEscaped(code)) return true;
    }
    i++;
  }
  return false;
}

function unicodeEscapeValue(raw: string, at: number): number | undefined {
  if (raw[at] === '{') {
    const end = raw.indexOf('}', at);
    if (end === -1) return undefined;
    const code = Number.parseInt(raw.slice(at + 1, end), 16);
    return Number.isNaN(code) ? undefined : code;
  }
  const hex = raw.slice(at, at + 4);
  if (hex.length < 4) return undefined;
  const code = Number.parseInt(hex, 16);
  return Number.isNaN(code) ? undefined : code;
}

/** Code points a minimal printer still emits as `\uXXXX`. */
function mustStayEscaped(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  return code >= 0xd800 && code <= 0xdfff;
}

/**
 * Number of leaves when every leaf of an arithmetic tree is numeric, else
 * `undefined`. Iterative rather than recursive: `numbersToExpressions` chains are
 * short, but a hostile input can nest `+` thousands deep and blowing the stack
 * inside a detector would take the whole analysis down with it.
 */
function collectNumericLeaves(node: t.Node): number | undefined {
  const stack: t.Node[] = [node];
  let leaves = 0;
  while (stack.length > 0) {
    const current = stack.pop() as t.Node;
    if (t.isBinaryExpression(current) && ARITHMETIC_OPERATORS.has(current.operator)) {
      stack.push(current.left, current.right);
      continue;
    }
    if (t.isNumericLiteral(current)) {
      leaves++;
      continue;
    }
    if (
      t.isUnaryExpression(current) &&
      t.isNumericLiteral(current.argument) &&
      (current.operator === '-' || current.operator === '+' || current.operator === '~')
    ) {
      leaves++;
      continue;
    }
    return undefined;
  }
  return leaves;
}

function flattenConcat(node: t.Node): t.Node[] {
  const leaves: t.Node[] = [];
  const stack: t.Node[] = [node];
  // Right-to-left push keeps `leaves` in source order without a reverse.
  while (stack.length > 0) {
    const current = stack.pop() as t.Node;
    if (t.isBinaryExpression(current) && current.operator === '+') {
      stack.push(current.right, current.left);
      continue;
    }
    leaves.push(current);
  }
  return leaves;
}

/** Pure and compile-time known, so a comparison of two of them is decidable. */
function isConstantOperand(node: t.Node): boolean {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    (t.isUnaryExpression(node) && t.isNumericLiteral(node.argument))
  );
}

function functionName(
  node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
  parent: t.Node | null,
): string | undefined {
  if (!t.isArrowFunctionExpression(node) && node.id) return node.id.name;
  if (!parent) return undefined;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if (t.isAssignmentExpression(parent) && t.isIdentifier(parent.left)) return parent.left.name;
  return undefined;
}

function singleReturnValue(
  node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
  body: readonly t.Statement[] | undefined,
): t.Expression | undefined {
  if (!body) return t.isExpression(node.body) ? node.body : undefined;
  if (body.length !== 1) return undefined;
  const only = body[0];
  return t.isReturnStatement(only) && only.argument ? only.argument : undefined;
}

/** `stringArrayIndexShift`: `index = index - 0x76;` on one of the parameters. */
function hasIndexShift(params: readonly t.Node[], body: readonly t.Statement[]): boolean {
  const names = new Set<string>();
  for (const param of params) if (t.isIdentifier(param)) names.add(param.name);
  if (names.size === 0) return false;

  for (const statement of body) {
    if (!t.isExpressionStatement(statement)) continue;
    const assignment = statement.expression;
    if (!t.isAssignmentExpression(assignment)) continue;
    const target = assignment.left;
    if (!t.isIdentifier(target) || !names.has(target.name)) continue;
    if (assignment.operator === '-=' && t.isNumericLiteral(assignment.right)) return true;
    if (assignment.operator !== '=') continue;
    const value = assignment.right;
    if (
      t.isBinaryExpression(value) &&
      (value.operator === '-' || value.operator === '+') &&
      t.isIdentifier(value.left) &&
      value.left.name === target.name &&
      t.isNumericLiteral(value.right)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The shiftless decoder: `var table = getTable(); return table[index];` - a
 * local bound to a zero-argument call and then indexed by a parameter.
 */
function hasTableLookup(params: readonly t.Node[], body: readonly t.Statement[]): boolean {
  const paramNames = new Set<string>();
  for (const param of params) if (t.isIdentifier(param)) paramNames.add(param.name);
  if (paramNames.size === 0) return false;

  const tables = new Set<string>();
  for (const statement of body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      if (!t.isIdentifier(declarator.id)) continue;
      const init = declarator.init;
      if (t.isCallExpression(init) && init.arguments.length === 0 && t.isIdentifier(init.callee)) {
        tables.add(declarator.id.name);
      }
    }
  }
  if (tables.size === 0) return false;

  for (const statement of body) {
    const expression = t.isReturnStatement(statement)
      ? statement.argument
      : t.isVariableDeclaration(statement)
        ? statement.declarations[statement.declarations.length - 1]?.init
        : undefined;
    if (!expression || !t.isMemberExpression(expression) || !expression.computed) continue;
    if (!t.isIdentifier(expression.object) || !tables.has(expression.object.name)) continue;
    if (t.isIdentifier(expression.property) && paramNames.has(expression.property.name)) return true;
  }
  return false;
}

/**
 * `function (a, b) { return a + b; }` / `{ return a(b, c); }` - the control-flow
 * storage object's operator and call wrappers. Parameters must be used exactly
 * once each and in declaration order, otherwise inlining would duplicate or
 * reorder side effects and this would not be a wrapper worth naming.
 */
function isOperatorWrapper(params: readonly t.Node[], returned: t.Expression): boolean {
  if (params.length === 0) return false;
  const names: string[] = [];
  for (const param of params) {
    if (!t.isIdentifier(param)) return false;
    names.push(param.name);
  }

  if (t.isBinaryExpression(returned) || t.isLogicalExpression(returned)) {
    return (
      names.length === 2 &&
      t.isIdentifier(returned.left) &&
      t.isIdentifier(returned.right) &&
      returned.left.name === names[0] &&
      returned.right.name === names[1]
    );
  }
  if (t.isCallExpression(returned) || t.isNewExpression(returned)) {
    if (!t.isIdentifier(returned.callee) || returned.callee.name !== names[0]) return false;
    if (returned.arguments.length !== names.length - 1) return false;
    return returned.arguments.every(
      (argument, index) => t.isIdentifier(argument) && argument.name === names[index + 1],
    );
  }
  return false;
}

/** Wrappers live in a storage object, either as a literal property or an assignment. */
function isStoredAsProperty(node: t.Node, parent: t.Node | null): boolean {
  if (!parent) return false;
  if (t.isObjectProperty(parent)) return parent.value === node;
  if (t.isAssignmentExpression(parent)) {
    return parent.right === node && t.isMemberExpression(parent.left);
  }
  return false;
}

/**
 * The Dean Edwards packer payload: `eval(function(p,a,c,k,e,d){...}(...))`, or any
 * `eval` of an expression containing a `'a|b|c'.split('|')` dictionary.
 */
function isPackerPayload(argument: t.Node): boolean {
  if (!t.isCallExpression(argument)) return false;
  if (t.isFunctionExpression(argument.callee) || t.isArrowFunctionExpression(argument.callee)) {
    return true;
  }
  return argument.arguments.some((arg) => {
    if (!t.isCallExpression(arg)) return false;
    if (memberKey(arg.callee) !== 'split') return false;
    const separator = arg.arguments[0];
    return t.isStringLiteral(separator) && separator.value === '|';
  });
}

/** `(self.webpackChunk = self.webpackChunk || []).push([[id], { 123: fn }])` */
function looksLikeWebpackChunk(node: t.CallExpression): boolean {
  const payload = node.arguments[0];
  if (!t.isArrayExpression(payload) || payload.elements.length < 2) return false;
  if (!t.isArrayExpression(payload.elements[0])) return false;
  const modules = payload.elements[1];
  if (!t.isObjectExpression(modules) || modules.properties.length === 0) return false;
  return modules.properties.every((property) => {
    if (!t.isObjectProperty(property)) return false;
    const key = property.key;
    const keyIsModuleId =
      t.isNumericLiteral(key) || (t.isStringLiteral(key) && /^\d+$/.test(key.value)) || t.isIdentifier(key);
    return (
      keyIsModuleId &&
      (t.isFunctionExpression(property.value) || t.isArrowFunctionExpression(property.value))
    );
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
