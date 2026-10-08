import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { inferNames, type InferNamesOptions } from '../../naming/index.js';
import type { PassContext } from '../../pipeline/context.js';
import type { Pass } from '../../pipeline/pass.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The readability payoff.
 *
 * Runs in the `rename` stage, after string decoding and property
 * normalisation, because the evidence that names a binding
 * (`document.getElementById('canvas')`) does not exist in the tree until those
 * have run. Deliberately not `repeatable`: a second pass would see its own
 * output as evidence and could only make names worse.
 */
export const renameIdentifiersPass: Pass = {
  id: 'rename.identifiers',
  title: 'Assign inferred, scope-safe names',
  stage: 'rename',
  technique: 'variableRenaming',
  repeatable: false,
  run: (ctx) => {
    const program = findProgram(ctx.ast);
    if (!program) return;

    // The `clean` stage runs immediately before this one and leaves the tables
    // stale when it changes anything; a stale `referencePaths` is a reference
    // the renamer never rewrites. Taken here, not inside `inferNames`, so a run
    // in which nothing changed since the last crawl pays for none.
    ctx.crawlProgramScope(program);

    // Recorded *before* renaming, while the old names still resolve.
    const typeReferences = collectTypeReferences(ctx, program);

    const result = inferNames(program, optionsFrom(ctx));

    rewriteTypeReferences(typeReferences);

    for (const rename of result.renames) {
      ctx.renames.push(rename);
      ctx.markChanged();
    }

    if (result.frozen) {
      ctx.note(
        'warning',
        'Some scopes were left unrenamed: a direct eval, with-statement or string-code call can reach bindings by name.',
      );
    }
    if (result.declined > 0) {
      ctx.note(
        'info',
        `${result.declined} binding(s) had an inferred name that could not be applied without changing resolution.`,
      );
    }
    // A script's top-level `var`s and functions are properties of the global
    // object, and the naming layer follows every spelling of that object to
    // what reads through it. Where the object itself goes somewhere the walk
    // cannot follow - handed to a function it cannot resolve, returned,
    // stored on something that is no local - code there can reach any of
    // them by a name this file never spells, so all of them keep theirs.
    if (result.globalEscapeRefusals > 0) {
      ctx.note(
        'info',
        `${result.globalEscapeRefusals} top-level binding(s) kept their names: the global object is passed to or stored in something this pass cannot follow, and code there can reach them by name.`,
      );
    }
    // A script's top-level `var`s and functions are also read through the
    // global object under keys the pipeline could not resolve - a refused
    // decoder's call, a name built from parts. Such a read is taken to be
    // of a host property, and this says so whenever a top-level name was
    // changed beside it. Names containing a part the key spells are kept.
    if (result.assumedHostPropertyRead) {
      const { line } = result.assumedHostPropertyRead;
      ctx.note(
        'warning',
        `A property of the global object is read under a key this pass could not resolve${line === undefined ? '' : ` (line ${line})`}. Top-level names containing a part the key spells kept their names; the rest were renamed on the assumption that the read is of a host property.`,
      );
    }
    // The aggressive preset's contract is drift disclosed. `Cannot access
    // 'before' before initialization` read through `e.message` names the
    // binding; the naming layer keeps the name of everything the guarded code
    // references, and of everything it calls, four levels of calls down, and
    // the drift that is left is a failure deeper than that or through a call
    // the layer could not follow - which no rename can avoid and this
    // discloses. Balanced renames only on evidence, which is the assumption
    // real obfuscated code holds to; where the layer says it lost a call it
    // is not silent there either, since a `JSON.parse` rule renamed a TDZ
    // read two calls deep to `data` at balanced with no word said.
    const unfollowed = result.errorTextUnfollowed && result.renames.length > 0;
    if (unfollowed || (result.errorTextRead && result.renames.length > 0 && ctx.config.preset === 'aggressive')) {
      ctx.note(
        'warning',
        'The program reads the text of a caught error. Bindings the guarded code references keep their names, as do those referenced by what it calls, four levels down; error text from a call the naming layer could not follow, or from deeper, may still embed a renamed one.',
      );
    }
    // The same contract, for a `.name` the naming layer does not follow to
    // its function: the result of a call on one of the program's own values
    // (`o.get().name`, `arr.pop().name`, `fn.bind(x).name`), code compiled
    // from a string that can spell `name`, or elements nested deeper than
    // the walk opens. Every function or class the layer can see read that
    // way keeps its name; what a call returns is the one value it leaves at
    // its boundary, and this says so when a spelling it may return has
    // changed. Balanced renames on evidence only, which no mainstream
    // obfuscator's output reads back this way.
    if (result.unfollowedNameRead && ctx.config.preset === 'aggressive') {
      ctx.note(
        'warning',
        'The program reads the name of a function or class through a value that was not followed to it - the result of a call on one of its own values, code compiled from a string, or elements nested more deeply than the walk opens - and a function or class was renamed; that read may see the new name.',
      );
    }
  },
};

/**
 * A type-position use of a value binding, remembered so it can follow a rename.
 *
 * Babel's scope crawler does not record identifiers inside type annotations as
 * references, so `binding.referencePaths` - which is what the naming layer
 * rewrites, and deliberately so, because it is O(references) instead of a
 * traversal per binding - does not contain them. Renaming `class Box` to
 * `class Widget` therefore left `function take(b: Box)` naming a class that no
 * longer exists: output that still parses, still runs once the types are
 * stripped, and does not compile.
 *
 * The association is captured by *scope resolution before the rename*, not by
 * name afterwards, so two different `Box`es in two scopes stay apart.
 */
interface TypeReference {
  binding: Binding;
  /** The identifier node to rewrite: the head of the entity name. */
  identifier: t.Identifier;
  /** The name it had when it was resolved; a rename is a change from this. */
  from: string;
}

function collectTypeReferences(ctx: PassContext, program: NodePath<t.Program>): TypeReference[] {
  if (ctx.language !== 'ts' && ctx.language !== 'tsx') return [];

  const found: TypeReference[] = [];
  const record = (path: NodePath, node: t.Node | null | undefined): void => {
    const head = entityHead(node);
    if (!head) return;
    const binding = path.scope.getBinding(head.name);
    // No binding means a global or an ambient type; nothing here will rename it.
    if (!binding) return;
    found.push({ binding, identifier: head, from: head.name });
  };

  program.traverse({
    TSTypeReference(path) {
      record(path, path.node.typeName);
    },
    TSTypeQuery(path) {
      record(path, path.node.exprName);
    },
    // `class C implements I`, and an interface's `extends` clause.
    TSExpressionWithTypeArguments(path) {
      record(path, path.node.expression);
    },
    // `(s: Shape): s is Circle`, `asserts s is Circle`, `asserts s`. The
    // predicate names a PARAMETER, not a type, and it sits in the return type,
    // which is not a reference position either: renaming `s` to `shape` left
    // `shape: Shape): s is Circle` - TS1225, a parameter that no longer exists.
    // `path.scope` here is the function's own scope, so the name resolves to
    // that parameter and not to an outer binding that happens to share it.
    // `this is T` has no identifier and nothing to follow.
    TSTypePredicate(path) {
      if (t.isIdentifier(path.node.parameterName)) record(path, path.node.parameterName);
    },
  });
  return found;
}

/** Apply whatever the naming layer did to the binding, to its type positions. */
function rewriteTypeReferences(references: readonly TypeReference[]): void {
  for (const reference of references) {
    const current = reference.binding.identifier.name;
    if (current === reference.from) continue;
    reference.identifier.name = current;
  }
}

/** The leftmost identifier of `A`, `A.B.C` or `typeof A.B`. */
function entityHead(node: t.Node | null | undefined): t.Identifier | undefined {
  let current = node;
  while (current && t.isTSQualifiedName(current)) current = current.left;
  return current && t.isIdentifier(current) ? current : undefined;
}

function optionsFrom(ctx: PassContext): InferNamesOptions {
  const options = ctx.config.techniqueOptions.variableRenaming;
  return {
    minConfidence: options.minConfidence,
    renameReadable: options.renameReadable,
    renameParameters: options.renameParameters,
    renameProperties: options.renameProperties,
    hints: options.hints,
    typescript: ctx.language === 'ts' || ctx.language === 'tsx',
    jsx: ctx.language === 'jsx' || ctx.language === 'tsx',
    sourceType: ctx.ast.program.sourceType === 'module' ? 'module' : 'script',
    // The aggressive preset exists to maximise readability, which is the only
    // setting where inventing `str1`-style names beats leaving `_0x4d28ce`.
    keepUnknown: ctx.config.preset !== 'aggressive',
    // Conservative promises identity, and a top-level name read back through
    // a key nobody resolved is not provably a host's.
    assumeHostProperties: ctx.config.preset !== 'conservative',
  };
}

function findProgram(ast: t.File): NodePath<t.Program> | null {
  let program: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}
