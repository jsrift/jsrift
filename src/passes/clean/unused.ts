import _traverse, { type Binding, type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { stringCodeFacts, type StringCodeFacts } from '../../analysis/string-code.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';
import { programPathOf } from '../strings/discover.js';
import {
  blockFunctionHoisting,
  blockFunctionOutsideUse,
  blockFunctionVarScope,
  hasLeadingComment,
  insideWith,
} from '../../util/ast.js';
import { isSideEffectFree } from '../../util/purity.js';
import type { DeadCodeOptions } from '../../types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/** Removing one binding can free another; in practice this settles in two or three. */
const MAX_ROUNDS = 8;
/** Candidates examined between budget checks. */
const BUDGET_STRIDE = 512;

const GLOBAL_ROOTS = new Set(['window', 'globalThis', 'self', 'global', 'top', 'exports']);

interface Candidate {
  binding: Binding;
  name: string;
  done: boolean;
}

interface Analysis {
  candidates: Candidate[];
  /**
   * Whether string code can still address a name after this pass deletes it.
   *
   * `analysis/string-code.ts` owns the question - the shapes, the direct-`eval`
   * scope set and the composite {@link StringCodeFacts.addresses} this pass
   * asks - and it is computed once per fixpoint iteration and shared, so the
   * `strings` passes and this one traverse for it once between them rather than
   * once each. What used to live here was the same analysis privately: a
   * `CallExpression`/`NewExpression` pair of handlers on this pass's own
   * traversal, a `Set<Scope>`, and a `program.scope.globals` lookup for the
   * aliased-`eval` case.
   *
   * Two hazards, still not the same fact. `directEval` sees every binding up
   * its own scope chain. `global` - `Function(src)`, indirect `eval`,
   * `setTimeout('src')` - compiles in global scope and so sees no local
   * binding, but program-scope names are not local: in a script the
   * program-scope `var`s and function declarations are properties of the global
   * object and the `let`/`const`/`class` are the global lexical environment,
   * and string code reads all of them by name. So it freezes program scope, and
   * only program scope.
   */
  facts: StringCodeFacts;
  /**
   * Function node -> whether it owns an `arguments` read, filled in on demand.
   * See `ownsArguments` for why this is not collected up front.
   */
  argumentsMemo: WeakMap<t.Node, boolean>;
  /** Names re-exported, or published on a global object, and therefore live. */
  exposedNames: Set<string>;
  /** Names used in TypeScript type position, where Babel's scope may not see them. */
  typeNames: Set<string>;
  /**
   * Whether program scope is the global scope - i.e. this is a script, not a module.
   *
   * The same fact `facts.global` already turns on for string code, applied to
   * the ordinary case. In a script the program-scope `var`s and function
   * declarations ARE properties of the global object and the `let`/`const`/
   * `class` ARE the global lexical environment, so an inline `onclick=`, the
   * next `<script>` tag, or the console reads them by name. Nothing inside one
   * file can prove no such reader exists, which makes "no references in this
   * tree" not a proof of death for these bindings and only these.
   *
   * It costs nothing measurable: the obfuscator machinery this engine exists to
   * remove is pruned by `strings/prune-decoders`, which proves its own case,
   * and every fixture is byte-identical with this refusal in place. What it
   * stops is the pass reaching past the machinery into the page's own entry
   * points - the functions someone opened the tool to read.
   */
  scriptGlobals: boolean;
  /**
   * Whether the program contains a `with` at all.
   *
   * Only a gate: it makes the per-candidate `insideWith` walk cost nothing on
   * the overwhelming majority of files, which contain no `with` statement.
   */
  sawWith: boolean;
}

/**
 * Deleting a binding is only safe once you can see the whole program: a name is
 * unused if *nothing anywhere* reads it, and that is a global fact. So this is a
 * `run` pass with its own analysis traversal rather than a visitor.
 */
export const removeUnusedPass: Pass = {
  id: 'clean.unused',
  title: 'Remove unused bindings and functions',
  stage: 'clean',
  technique: 'deadCodeRemoval',
  run: (ctx) => {
    const options = ctx.config.techniqueOptions.deadCodeRemoval;
    if (!options.removeUnusedBindings && !options.removeUnusedFunctions) return;

    const analysis = analyse(ctx);
    // Each standing fact is one line, however many rounds restate it.
    if (analysis.facts.directEval) {
      ctx.note(
        'info',
        'Direct eval found; bindings it could reach were left in place.',
        undefined,
        'clean.unused:direct-eval',
      );
    }
    if (analysis.facts.global) {
      ctx.note(
        'info',
        'Code compiled from a string was found; program-scope bindings were left in place.',
        undefined,
        'clean.unused:string-code',
      );
    } else if (analysis.scriptGlobals) {
      // A CommonJS file is parsed as a script too, and under Node's loader its
      // top level is a function body - `Function('return typeof x')()` answers
      // 'undefined' for every declaration in it - so "they are global" would be
      // false for every `require()` file. The refusal stands regardless: the
      // same text loaded by a `<script>` tag beside a `require` shim, which is
      // how a RequireJS page runs, makes them globals after all, and nothing
      // in the file says which loader it gets. Only the reason changes.
      ctx.note(
        'info',
        usesCommonJs(ctx.ast.program)
          ? 'This file is parsed as a script and its top-level declarations were left in place ' +
              'even where nothing in the file reads them. It uses `require`/`module.exports`, ' +
              'under which Node keeps those declarations module-local, but a script tag with a ' +
              '`require` shim would make them globals, and the file does not say which loads it.'
          : 'This is a script, so its top-level declarations are global; they were left in place ' +
              'even where nothing in the file reads them.',
        undefined,
        'clean.unused:script-globals',
      );
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (ctx.isExhausted()) return;
      let removed = 0;
      let examined = 0;
      for (const candidate of analysis.candidates) {
        if (++examined % BUDGET_STRIDE === 0 && ctx.isExhausted()) return;
        if (candidate.done) continue;
        if (!tryRemove(candidate, analysis, options, ctx)) continue;
        candidate.done = true;
        removed++;
      }
      if (removed === 0) return;
    }
  },
};

// ---------------------------------------------------------------------------
// Whole-program analysis
// ---------------------------------------------------------------------------

function analyse(ctx: PassContext): Analysis {
  const candidates: Candidate[] = [];
  const exposedNames = new Set<string>();
  const typeNames = new Set<string>();
  let sawWith = false;

  // "Nothing reads this name" is read straight off Babel's reference counter,
  // and Babel only computes that counter when a scope is crawled. Every stage
  // before this one rewrites the tree, and a pass that deletes a reference
  // without handing it back leaves the count too high - which reads here as
  // "still used" and is indistinguishable from a genuinely live binding. On the
  // 4 MB fixture that stale arithmetic was the single dominant refusal: 6,837
  // of the 6,920 candidates in the final round. Rebuild the tables first so the
  // counts describe the program as it is now - through the context, which
  // skips the rebuild when nothing has changed since the last one.
  const program = programPathOf(ctx.ast);
  if (program) ctx.crawlProgramScope(program);

  // Written after the crawl but not dependent on it, and that is worth being
  // exact about because the answer is memoised for the whole iteration: an
  // earlier stage may well have computed it before this crawl ran. It survives
  // that because the direct-`eval` half is recorded as the AST NODES that own
  // the reachable scopes rather than as `Scope` objects, and a re-crawl does
  // not move a scope from one node to another. What it does not survive is a
  // pass that INTRODUCES string code mid-iteration, which is the residue
  // `stringCodeFacts` documents and hands `invalidateStringCodeFacts` for.
  //
  // What the shared module does NOT answer is `with`, which is why `sawWith`
  // below survives the migration unchanged: a name under a `with` is resolved
  // on the object at run time, which is a hazard about POSITION and not about
  // strings. The two are independent and this pass needs both.
  //
  // `setTimeout(s, 0)` where `s` is a string-valued VARIABLE used to be a
  // residue here - the classifier reported no hazard, and a DELETION that
  // misses leaves nothing at all, while a rename that misses at least leaves a
  // name. It is closed in `freezeHazardKind`, which is the only place it could
  // be closed: a rule only this pass carries is the drift the shared classifier
  // exists to prevent. A timer whose first argument is neither a readable
  // string nor a provable function now reports the hazard with no source, which
  // arrives here as the blunt "every program-scope name".
  const facts = stringCodeFacts(ctx);

  // Every node type below has children, which is what keeps this walk at the
  // price of a bare traversal: Babel builds a `NodePath` for a node when it has
  // children *or* when the visitor names its type, so those types cost nothing
  // extra while a childless one - `Identifier`, `StringLiteral`, `NumericLiteral`
  // - silently adds a path per node and roughly doubles the walk. Anything this
  // pass needs from a leaf belongs in `aliasesParameters`, answered on demand.
  traverse(ctx.ast, {
    Scopable(path) {
      // Every scope is reachable from several paths; only its owner enumerates it.
      if (path.scope.path !== path) return;
      for (const name of Object.keys(path.scope.bindings)) {
        const binding = path.scope.bindings[name];
        if (binding) candidates.push({ binding, name, done: false });
      }
    },

    WithStatement() {
      sawWith = true;
    },

    AssignmentExpression(path) {
      const key = globalMemberName(path.node.left);
      if (key) exposedNames.add(key);
    },

    ExportNamedDeclaration(path) {
      for (const specifier of path.node.specifiers) {
        if (t.isExportSpecifier(specifier)) exposedNames.add(specifier.local.name);
      }
      const declaration = path.node.declaration;
      if (declaration) {
        for (const name of Object.keys(t.getBindingIdentifiers(declaration))) {
          exposedNames.add(name);
        }
      }
    },

    ExportDefaultDeclaration(path) {
      const declaration = path.node.declaration;
      if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) {
        if (declaration.id) exposedNames.add(declaration.id.name);
      }
    },

    TSTypeReference(path) {
      const head = entityHead(path.node.typeName);
      if (head) typeNames.add(head);
    },

    TSTypeQuery(path) {
      const head = entityHead(path.node.exprName);
      if (head) typeNames.add(head);
    },
  });

  // `var _0xEV = eval; _0xEV('_0x1b2c')` used to be answered right here, from
  // `program.scope.globals` - Babel's record of the unbound names the crawl
  // above found. `analysis/string-code.ts` answers it now, off its own raw
  // scan, so this pass no longer needs the crawl for anything but the reference
  // counts. The two are not identical and the difference is in the safe
  // direction: `scope.globals` is precise about boundness, and the raw scan
  // counts any `eval` identifier outside a direct-callee position, so a program
  // that binds the name itself freezes program scope for nothing. Its own doc
  // states that trade.

  return {
    candidates,
    facts,
    argumentsMemo: new WeakMap<t.Node, boolean>(),
    exposedNames,
    typeNames,
    scriptGlobals: ctx.ast.program.sourceType === 'script',
    sawWith,
  };
}

/**
 * Whether the program's own top level reads like a CommonJS module: a
 * `require()` in a declaration or a statement, or a write to `module.exports`
 * / `exports.x`. Top-level statements only, which is a handful of checks; a
 * lazy `require` inside a function says nothing about how the file is loaded.
 */
function usesCommonJs(program: t.Program): boolean {
  const isRequire = (node: t.Node | null | undefined): boolean =>
    t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'require' });
  for (const statement of program.body) {
    if (t.isVariableDeclaration(statement)) {
      if (statement.declarations.some((declarator) => isRequire(declarator.init))) return true;
      continue;
    }
    if (!t.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (isRequire(expression)) return true;
    if (!t.isAssignmentExpression(expression) || !t.isMemberExpression(expression.left)) continue;
    let object: t.Node = expression.left.object;
    if (t.isMemberExpression(object) && t.isIdentifier(object.object, { name: 'module' })) {
      object = object.object;
    }
    if (t.isIdentifier(object, { name: 'module' }) || t.isIdentifier(object, { name: 'exports' })) {
      return true;
    }
  }
  return false;
}

/**
 * Whether this scope's own bindings can be reached through its function's
 * `arguments` object.
 *
 * This used to answer the string-code half of the question too, and the
 * contrast is why it still exists at all rather than folding into the caller. A
 * direct `eval` is rare enough to enumerate up front, off `CallExpression` and
 * friends - handlers that cost nothing, because Babel visits those types
 * regardless, and now the shared fact enumerates them once for the whole
 * pipeline.
 *
 * `arguments` is not like that. Finding it up front takes a handler keyed on
 * `Identifier`, and that flips a switch inside Babel: a node type with a
 * handler is always given a `NodePath`, and identifiers - 31% of the nodes in
 * the 9.7 MB benchmark, and childless, so otherwise skipped outright - then
 * cost a path each. That handler alone was ~30% of the analysis traversal, to
 * answer a question that 740 scopes out of 45,460 candidates ever asked. So it
 * is answered on demand instead, and memoised per function.
 */
function aliasesParameters(scope: Scope, analysis: Analysis): boolean {
  const owner = scope.path;
  // Only a function has an `arguments` object to alias its parameters with.
  if (!owner.isFunction()) return false;
  const cached = analysis.argumentsMemo.get(owner.node);
  if (cached !== undefined) return cached;
  const owns = ownsArguments(owner.node);
  analysis.argumentsMemo.set(owner.node, owns);
  return owns;
}

/**
 * Whether this function is the one an `arguments` inside it would resolve to.
 *
 * An arrow has no `arguments` of its own, so a mention inside one belongs to the
 * function above it - which is why the walk descends through nested arrows but
 * stops at any other function, whose own `arguments` shadows the outer one.
 */
function ownsArguments(fn: t.Node): boolean {
  const stack: unknown[] = [];
  pushChildren(fn, stack);
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const node = current as t.Node;
    if (typeof node.type !== 'string') continue;
    if (node.type === 'Identifier' && node.name === 'arguments') return true;
    if (t.isFunction(node) && !t.isArrowFunctionExpression(node)) continue;
    pushChildren(node, stack);
  }
  return false;
}

function pushChildren(node: t.Node, stack: unknown[]): void {
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (value && typeof value === 'object') stack.push(value);
  }
}

function entityHead(node: t.Node): string | undefined {
  let current: t.Node = node;
  while (t.isTSQualifiedName(current)) current = current.left;
  return t.isIdentifier(current) ? current.name : undefined;
}

/** `window.foo = ...`, `exports.foo = ...`: the name escapes into an unreadable object. */
function globalMemberName(left: t.Node): string | undefined {
  if (!t.isMemberExpression(left)) return undefined;
  const object = left.object;
  const rooted =
    (t.isIdentifier(object) && GLOBAL_ROOTS.has(object.name)) ||
    (t.isMemberExpression(object) &&
      t.isIdentifier(object.object, { name: 'module' }) &&
      !object.computed &&
      t.isIdentifier(object.property, { name: 'exports' }));
  if (!rooted) return undefined;
  if (!left.computed && t.isIdentifier(left.property)) return left.property.name;
  if (left.computed && t.isStringLiteral(left.property)) return left.property.value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

function tryRemove(
  candidate: Candidate,
  analysis: Analysis,
  options: Required<DeadCodeOptions>,
  ctx: PassContext,
): boolean {
  const { binding, name } = candidate;
  if (binding.references !== 0) return false;
  // A write to a deleted binding would silently create a global, so a name that
  // is assigned anywhere stays even when nothing reads it.
  if (binding.constantViolations.length > 0) return false;
  if (analysis.exposedNames.has(name)) return false;
  // Nothing about `Function('return _0x1b2c')` or `eval(src)` is a reference to
  // `_0x1b2c` that this pass's counter can see, so "no references" is not
  // "unused" for a name string code can still spell. One call because it is one
  // question: `addresses` is the disjunction of "a direct eval reaches the
  // declaring scope" and "the binding is at program scope and global string
  // code exists". Splitting it back into two tests is how the two halves drift.
  if (analysis.facts.addresses(binding)) return false;
  if (analysis.scriptGlobals && binding.scope.block.type === 'Program') return false;
  // The same two refusals for the binding Babel keeps nowhere. A sloppy `{
  // function f() {} }` at the top of a script is also a `var f` of the script
  // - a property of the global object once the block has run - and both
  // `Function('return f()')` and the next `<script>` tag reach it there by
  // name, while the block's binding, which is the only one this pass sees,
  // sits below program scope and passes both tests above.
  if (binding.path.isFunctionDeclaration() && blockFunctionHoisting(binding.path) !== 'none') {
    const varScope = blockFunctionVarScope(binding.path);
    if (analysis.facts.addressesName(name, varScope)) return false;
    if (analysis.scriptGlobals && varScope.path.isProgram()) return false;
  }
  if (aliasesParameters(binding.scope, analysis)) return false;

  const typescript = ctx.language === 'ts' || ctx.language === 'tsx';
  if (typescript && analysis.typeNames.has(name)) return false;

  switch (binding.kind) {
    case 'var':
    case 'let':
    case 'const':
    case 'hoisted':
      break;
    default:
      // `param` changes arity, `module` changes an import's side effects.
      return false;
  }

  const path = binding.path;
  if (isDetached(path)) return false;
  // Inside `with (o) { ... }` a name is resolved on `o` first, at run time, so
  // this pass's premise - nothing reads the name, therefore nothing observes
  // the declaration - stops holding. `var x = init` resolves `x` through the
  // object environment like any other name, so when `o` has an `x` the
  // declarator ASSIGNS o.x. That is a write no reference counter sees, and the
  // "keep the work, drop the name" rewrite deletes it precisely:
  // `with (o) { var x = side(); }` became `with (o) { side(); }` and `o.x` kept
  // its old value.
  //
  // The hazard on the OTHER side of `removeDeclarator` - every name in `init`
  // resolving through `o` as well, which makes any "this name holds a literal"
  // proof about a binding the expression may never reach - is not this guard's
  // any more: `isSideEffectFree` refuses a name under a `with` itself. The
  // refusal still sits here rather than there, because the write above is
  // invisible to every purity question and a guard placed only on the deletion
  // path would leave it open.
  //
  // It is deliberately WIDER than the write proved above - every declaration
  // form under the `with`, and every nested scope, not just a `var` the object
  // environment can shadow - because narrowing it means proving which names `o`
  // can carry, which is a run-time fact. `sawWith` gates the walk, so the width
  // costs nothing on a file with no `with` in it.
  if (analysis.sawWith && insideWith(path)) return false;
  // A catch parameter's binding points at the whole clause; it cannot be dropped.
  if (path.isCatchClause()) return false;
  if (isExportedDeclaration(path)) return false;
  // A TypeScript overload signature is a declaration with no body; the
  // implementation that follows shares its name and is very much used.
  if (path.isTSDeclareFunction() || path.isDeclareFunction()) return false;
  // `keepCommented` is documented as "preserve any statement carrying a leading
  // comment", and a declaration is a statement: the annotated helper nothing
  // calls stays, comment attached, rather than going out and leaving the
  // comment orphaned above whatever came next. The whole `var` statement is the
  // unit here, so a comment on `var a = 1, b = 2;` keeps both declarators.
  if (options.keepCommented && hasLeadingComment(declarationStatementOf(path))) return false;

  if (path.isVariableDeclarator()) return removeDeclarator(path, analysis, options, ctx);
  if (path.isFunctionDeclaration()) {
    return removeFunction(path, name, typescript, analysis, options, ctx);
  }
  if (path.isClassDeclaration()) return removeClass(path, analysis, options, ctx);
  return false;
}

/** The statement a comment would sit on: a declarator's `var`, otherwise the declaration itself. */
function declarationStatementOf(path: NodePath): t.Node {
  return path.isVariableDeclarator() && path.parentPath ? path.parentPath.node : path.node;
}

function removeDeclarator(
  path: NodePath<t.VariableDeclarator>,
  analysis: Analysis,
  options: Required<DeadCodeOptions>,
  ctx: PassContext,
): boolean {
  if (!options.removeUnusedBindings) return false;
  // A destructuring pattern binds several names at once and can invoke getters.
  if (!t.isIdentifier(path.node.id)) return false;

  const declaration = path.parentPath;
  if (!declaration.isVariableDeclaration()) return false;
  const owner = declaration.parentPath;
  if (owner && (owner.isForStatement() || owner.isForXStatement())) return false;

  const init = path.node.init;
  // A declarator under a `with` never reaches here: `tryRemove` refuses it
  // above, for both of the rewrites in this function at once.
  if (!init || isSideEffectFree(init, path.scope)) {
    dropReferences(path, analysis);
    path.remove();
    ctx.markChanged();
    return true;
  }

  // The value is dead but computing it is not: keep the work, drop the name.
  if (declaration.node.declarations.length !== 1 || !declaration.inList) return false;
  const statement = t.expressionStatement(init);
  statement.loc = init.loc;
  t.inheritLeadingComments(statement, declaration.node);
  t.inheritTrailingComments(statement, declaration.node);
  declaration.replaceWith(statement);
  ctx.markChanged();
  return true;
}

function removeFunction(
  path: NodePath<t.FunctionDeclaration>,
  name: string,
  typescript: boolean,
  analysis: Analysis,
  options: Required<DeadCodeOptions>,
  ctx: PassContext,
): boolean {
  if (!options.removeUnusedFunctions) return false;
  if (typescript && hasSameNameSibling(path, name)) return false;
  // "No references" is only evidence of disuse when the binding lists every
  // use, and for a sloppy block-level `function` it does not: Annex B.3.3 also
  // var-declares the name in the enclosing function or script, so
  //
  //     if (ready) { function h() { return 42; } }
  //     log(h());
  //
  // calls the same `h` from a reference Babel lists nowhere. Deleting it
  // produced output that threw. Refusing every such declaration would be
  // sound but costs real output - 72 of them on `fixtures/obfuscated3.js`,
  // worth about 28 KB, most genuinely dead - so the question asked is the
  // narrower one Annex B raises: does the NAME occur anywhere in the var scope
  // outside this declaration? Nowhere means no hoisted call can exist;
  // anywhere at all refuses without deciding which occurrence it is.
  if (blockFunctionOutsideUse(path)) return false;
  dropReferences(path, analysis);
  path.remove();
  ctx.markChanged();
  return true;
}

function removeClass(
  path: NodePath<t.ClassDeclaration>,
  analysis: Analysis,
  options: Required<DeadCodeOptions>,
  ctx: PassContext,
): boolean {
  if (!options.removeUnusedFunctions) return false;
  if (!isInertClass(path.node)) return false;
  dropReferences(path, analysis);
  path.remove();
  ctx.markChanged();
  return true;
}

/**
 * Evaluating a class declaration runs its heritage clause, its computed keys,
 * its decorators and its static initialisers. A class with none of those
 * produces nothing but the binding.
 */
function isInertClass(node: t.ClassDeclaration): boolean {
  if (node.superClass) return false;
  if (node.decorators && node.decorators.length > 0) return false;
  for (const member of node.body.body) {
    if ('decorators' in member && member.decorators && member.decorators.length > 0) return false;
    if (t.isStaticBlock(member)) return false;
    if ('computed' in member && member.computed) return false;
    if (t.isClassProperty(member) || t.isClassPrivateProperty(member)) {
      if (member.static && member.value) return false;
    }
  }
  return true;
}

/** In TypeScript, a repeated function name is an overload set, not a duplicate. */
function hasSameNameSibling(path: NodePath<t.FunctionDeclaration>, name: string): boolean {
  const container = path.container;
  if (!Array.isArray(container)) return false;
  let count = 0;
  for (const item of container) {
    const node = item as t.Node;
    if (!t.isFunctionDeclaration(node) && !t.isTSDeclareFunction(node)) continue;
    if (node.id?.name === name) count++;
  }
  return count > 1;
}

function isExportedDeclaration(path: NodePath): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  if (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) return true;
  const grandparent = parent.parentPath;
  return Boolean(grandparent?.isExportNamedDeclaration());
}

/**
 * Settle up with a subtree that is about to be deleted, in one walk.
 *
 * Two debts. Babel computes reference counts once per crawl, so the subtree has
 * to hand its references back or the next round will not see the names it
 * freed. And because `arguments` is resolved on demand, a mention that leaves
 * with this subtree has to be recorded before it goes - otherwise a function
 * asked about only afterwards would look at a tree the mention is no longer in,
 * and the answer would depend on the order candidates happened to be examined
 * in. Deletion is the only thing that changes the tree during this pass, so
 * this is the only place that can happen.
 */
function dropReferences(path: NodePath, analysis: Analysis): void {
  path.traverse({
    ReferencedIdentifier(inner) {
      inner.scope.getBinding(inner.node.name)?.dereference();
    },

    Identifier(inner) {
      if (inner.node.name !== 'arguments') return;
      let fn = inner.getFunctionParent();
      while (fn) {
        analysis.argumentsMemo.set(fn.node, true);
        if (!fn.isArrowFunctionExpression()) break;
        fn = fn.parentPath.getFunctionParent();
      }
    },
  });
}

/** A binding inside an already-deleted subtree still has a live-looking path. */
function isDetached(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (current.removed || !current.node) return true;
    if (current.isProgram()) return false;
    current = current.parentPath;
  }
  return true;
}
