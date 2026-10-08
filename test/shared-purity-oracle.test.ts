import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { isInitialisedBinding, isUnboundUndefined } from '../src/util/ast.js';
import {
  canInvokeUserCode,
  isPrimitiveValued,
  isSideEffectFree,
} from '../src/util/purity.js';

/**
 * The two shared modules that replace twelve copies of one question.
 *
 * `src/util/purity.ts` answers "can evaluating this hand control to program
 * code" at three strengths, and `isUnboundUndefined`/`isInitialisedBinding` in
 * `src/util/ast.ts` answer "does the name `undefined` denote the value
 * `undefined`, and can this name be read at all".
 *
 * Two kinds of assertion here, and the second is the one that matters. A
 * predicate test states what the oracle answers for a shape. A HAZARD test
 * first runs the shape in a real realm and proves the hazard is real - that the
 * bare read reached a getter, that the destructuring ran an iterator, that the
 * BigInt arithmetic threw - and only then asserts the oracle refuses it. Without
 * the first half a refusal test passes just as well when the hazard was
 * imaginary, and every one of these predicates is a licence to DELETE code.
 *
 * No call site is migrated in this phase, so nothing below asserts anything
 * about a pass; these are the semantics the migration will inherit.
 */

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Probe {
  readonly node: t.Node;
  readonly scope: Scope;
  readonly path: NodePath;
}

/**
 * Parse as a SCRIPT - `with` is a syntax error in a module, and half of these
 * cases are about `with`.
 */
function parseScript(source: string): t.File {
  return parse(source, { sourceType: 'script', allowReturnOutsideFunction: true });
}

/** The expression marked `PROBE(<expr>)`, with the scope and path it sits at. */
function probe(source: string): Probe {
  const ast = parseScript(source);
  let found: Probe | undefined;
  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee, { name: 'PROBE' })) return;
      const argument = path.get('arguments')[0];
      if (!argument) return;
      found = { node: argument.node, scope: argument.scope, path: argument };
      path.stop();
    },
  });
  if (!found) throw new Error(`no PROBE(...) in: ${source}`);
  return found;
}

/** The statement marked `PROBE: <statement>`, for the statement-level strength. */
function probeStatement(source: string): Probe {
  const ast = parseScript(source);
  let found: Probe | undefined;
  traverse(ast, {
    LabeledStatement(path) {
      if (path.node.label.name !== 'PROBE') return;
      const body = path.get('body');
      found = { node: body.node, scope: body.scope, path: body };
      path.stop();
    },
  });
  if (!found) throw new Error(`no PROBE: statement in: ${source}`);
  return found;
}

/** Every predicate, for the shape marked in this source. */
function ask(source: string): {
  invokes: boolean;
  primitive: boolean;
  free: boolean;
  freeWithoutPath: boolean;
} {
  const p = source.includes('PROBE:') ? probeStatement(source) : probe(source);
  const options = { path: p.path };
  return {
    invokes: canInvokeUserCode(p.node, p.scope, options),
    primitive: isPrimitiveValued(p.node, p.scope, options),
    free: isSideEffectFree(p.node, p.scope, options),
    freeWithoutPath: isSideEffectFree(p.node, p.scope),
  };
}

/**
 * Run a program in a fresh realm and return what it made observable.
 *
 * `LOG` is the only channel; a throw is recorded by name, because a throw that
 * stops happening is exactly as much of a behaviour change as a call that stops
 * happening.
 */
function observe(code: string): string[] {
  const trace: string[] = [];
  const sandbox: Record<string, unknown> = {
    LOG: (...args: unknown[]): void => {
      trace.push(args.map((value) => String(value)).join(' '));
    },
  };
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace;
}

// ---------------------------------------------------------------------------
// canInvokeUserCode - every shape that can reach program code
// ---------------------------------------------------------------------------

describe('canInvokeUserCode: the shapes that transfer control', () => {
  it('a call reaches the callee, so it is refused', () => {
    expect(ask('function f() {} PROBE(f());').invokes).toBe(true);
  });

  it('`new` reaches the constructor, so it is refused', () => {
    expect(ask('function C() {} PROBE(new C());').invokes).toBe(true);
  });

  it('`await` hands control to whatever is queued, so it is refused', () => {
    expect(ask('async function f(p) { PROBE(await p); }').invokes).toBe(true);
  });

  it('`yield` hands control to the caller, so it is refused', () => {
    expect(ask('function* g(v) { PROBE(yield v); }').invokes).toBe(true);
  });

  it('a property read can run a getter, so `o.x` is refused', () => {
    expect(ask('var o = {}; PROBE(o.x);').invokes).toBe(true);
  });

  it('a computed property read can run a getter, so `o[k]` is refused', () => {
    expect(ask('var o = {}; var k = "x"; PROBE(o[k]);').invokes).toBe(true);
  });

  it('an optional read is still a read, so `o?.x` is refused', () => {
    expect(ask('var o = {}; PROBE(o?.x);').invokes).toBe(true);
  });

  it('a tagged template calls the tag, so it is refused', () => {
    expect(ask('function tag() {} PROBE(tag`x`);').invokes).toBe(true);
  });

  it('spread runs the iterator protocol, so `[...xs]` is refused', () => {
    expect(ask('var xs = []; PROBE([...xs]);').invokes).toBe(true);
  });

  it('object spread runs ownKeys and every enumerable getter, so `{...o}` is refused', () => {
    expect(ask('var o = {}; PROBE({ ...o });').invokes).toBe(true);
  });

  it('`delete` reaches a proxy trap, so it is refused', () => {
    expect(ask('var o = {}; PROBE(delete o.x);').invokes).toBe(true);
  });

  it('`instanceof` dispatches through Symbol.hasInstance, so it is refused', () => {
    expect(ask('var a = 1, b = 1; PROBE(a instanceof b);').invokes).toBe(true);
  });

  it('`in` reaches the proxy has trap, so it is refused', () => {
    expect(ask('var a = 1, b = 1; PROBE(a in b);').invokes).toBe(true);
  });

  it('a class body evaluates extends, computed keys and static blocks, so it is refused', () => {
    expect(ask('PROBE(class {});').invokes).toBe(true);
  });

  it('a bound name resolves to its binding and evaluates nothing, so it is accepted', () => {
    expect(ask('var v = 1; PROBE(v);').invokes).toBe(false);
  });

  it('creating a closure runs none of its body, so a function expression is accepted', () => {
    expect(ask('PROBE(function () { return document.cookie; });').invokes).toBe(false);
  });
});

describe('canInvokeUserCode: the two strengths it deliberately does not have', () => {
  it('a TDZ read throws but runs no program code, so only isSideEffectFree refuses it', () => {
    const answers = ask('function f() { PROBE(v); let v = 1; }');
    expect(answers.invokes).toBe(false);
    expect(answers.free).toBe(false);
  });

  it('a write to a bound name invokes nothing but is observable, so only isSideEffectFree refuses it', () => {
    const answers = ask('var v = 1; PROBE(v = 2);');
    expect(answers.invokes).toBe(false);
    expect(answers.free).toBe(false);
  });

  it('a compound assignment coerces the old value, so even the weak strength refuses it', () => {
    expect(ask('var v = 1; PROBE(v += 2);').invokes).toBe(true);
  });

  it('an update writes and coerces, so both strengths refuse it', () => {
    const answers = ask('var v = 1; PROBE(v++);');
    expect(answers.invokes).toBe(true);
    expect(answers.free).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Free names: a bare read is a global property access
// ---------------------------------------------------------------------------

describe('free names reach the global object', () => {
  it('a bare read of a free name can run a global getter, so it is refused', () => {
    const trace = observe(
      "Object.defineProperty(globalThis, 'g', { get: function () { LOG('getter ran'); return 1; } }); g;",
    );
    expect(trace).toEqual(['getter ran']);

    const answers = ask('PROBE(g);');
    expect(answers.invokes).toBe(true);
    expect(answers.free).toBe(false);
  });

  it('`typeof` does not throw on a free name but still performs the read, so it is refused', () => {
    const trace = observe(
      "Object.defineProperty(globalThis, 'g', { get: function () { LOG('getter ran'); return 1; } }); typeof g;",
    );
    expect(trace).toEqual(['getter ran']);
    expect(ask('PROBE(typeof g);').free).toBe(false);
  });

  it('a bare write to a free name can run a global setter, so it is refused', () => {
    const trace = observe(
      "Object.defineProperty(globalThis, 's', { set: function () { LOG('setter ran'); } }); s = 1;",
    );
    expect(trace).toEqual(['setter ran']);
    expect(ask('PROBE(s = 1);').invokes).toBe(true);
  });

  it('a write to a bound name reaches no setter, so the weak strength accepts it', () => {
    expect(ask('var s = 0; PROBE(s = 1);').invokes).toBe(false);
  });

  it('`undefined`, `NaN` and `Infinity` are non-configurable, so a free read of them is accepted', () => {
    // The distinguishing fact, not an assumption: the property cannot be
    // replaced by an accessor, so there is no getter for the read to reach.
    const trace = observe(
      "try { Object.defineProperty(globalThis, 'undefined', { get: function () { LOG('getter ran'); } }); } catch (e) { LOG('THREW ' + e.name); }",
    );
    expect(trace).toEqual(['THREW TypeError']);

    expect(ask('PROBE(undefined);').free).toBe(true);
    expect(ask('PROBE(NaN);').free).toBe(true);
    expect(ask('PROBE(Infinity);').free).toBe(true);
  });

  it('a shadowed `NaN` is an ordinary binding, so the immutable-global licence does not apply', () => {
    expect(ask('function f(NaN) { PROBE(NaN); }').primitive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Destructuring targets: the half that is easy to miss
// ---------------------------------------------------------------------------

describe('destructuring targets run code that appears nowhere in the source', () => {
  it('an object pattern runs a getter on the source, so `var { x } = o` is refused', () => {
    const trace = observe(
      "var src = { get x() { LOG('getter ran'); return 1; } }; var { x } = src;",
    );
    expect(trace).toEqual(['getter ran']);
    expect(ask('var src = {}; PROBE: var { x } = src;').invokes).toBe(true);
  });

  it('an array pattern runs the iterator protocol, so `var [x] = o` is refused', () => {
    const trace = observe(
      'var src = { [Symbol.iterator]: function () { LOG("iterator ran"); return { next: function () { return { done: true }; } }; } }; var [x] = src;',
    );
    expect(trace).toEqual(['iterator ran']);
    expect(ask('var src = []; PROBE: var [x] = src;').invokes).toBe(true);
  });

  it('a bare name binds without evaluating a target, so `var x = v` is accepted', () => {
    expect(ask('var v = 1; PROBE: var x = v;').invokes).toBe(false);
  });

  it('a declaration binds, which is a write, so isSideEffectFree refuses what the weak strength accepts', () => {
    const answers = ask('var v = 1; PROBE: var x = v;');
    expect(answers.invokes).toBe(false);
    expect(answers.free).toBe(false);
  });

  it('a defaulted pattern target evaluates the default too, so `var { a = 1 } = o` is refused', () => {
    expect(ask('var src = {}; PROBE: var { a = 1 } = src;').invokes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToPrimitive: coercion is a call spelled without parentheses
// ---------------------------------------------------------------------------

describe('coercing operators reach valueOf and toString', () => {
  it('`-o` runs valueOf on an object, so an operand not provably primitive is refused', () => {
    const trace = observe("var o = { valueOf: function () { LOG('valueOf ran'); return 1; } }; -o;");
    expect(trace).toEqual(['valueOf ran']);

    expect(ask('var o = {}; PROBE(-o);').free).toBe(false);
    expect(ask('var n = 2; PROBE(-n);').free).toBe(true);
  });

  it('`!`, `typeof` and `void` convert without asking the value, so any operand is accepted', () => {
    expect(ask('var o = {}; PROBE(!o);').free).toBe(true);
    expect(ask('var o = {}; PROBE(typeof o);').free).toBe(true);
    expect(ask('var o = {}; PROBE(void o);').free).toBe(true);
  });

  it('`==` converts and `===` does not, so only the strict comparison is accepted', () => {
    expect(ask('var o = {}; PROBE(o == 1);').free).toBe(false);
    expect(ask('var o = {}; PROBE(o === 1);').free).toBe(true);
  });

  it('a relational operator converts, so `o < 1` is refused', () => {
    expect(ask('var o = {}; PROBE(o < 1);').free).toBe(false);
  });

  it('a template substitution runs toString, so `${o}` is refused', () => {
    const trace = observe(
      "var o = { toString: function () { LOG('toString ran'); return 'x'; } }; `${o}`;",
    );
    expect(trace).toEqual(['toString ran']);

    expect(ask('var o = {}; PROBE(`${o}`);').free).toBe(false);
    expect(ask('var n = 2; PROBE(`${n}`);').free).toBe(true);
    expect(ask('PROBE(`plain`);').free).toBe(true);
  });

  it('a computed key runs ToPropertyKey, which is ToPrimitive, so it is refused', () => {
    const trace = observe(
      "var k = { toString: function () { LOG('toString ran'); return 'k'; } }; ({ [k]: 1 });",
    );
    expect(trace).toEqual(['toString ran']);

    expect(ask('var k = {}; PROBE({ [k]: 1 });').free).toBe(false);
    expect(ask('PROBE({ ["k"]: 1 });').free).toBe(true);
  });

  it('a non-computed accessor is defined rather than run, so `{ get x() {} }` is accepted', () => {
    expect(ask('PROBE({ get x() { return document.cookie; } });').free).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPrimitiveValued - the TYPE claim, including the BigInt hole
// ---------------------------------------------------------------------------

describe('isPrimitiveValued: BigInt is a primitive this proof still cannot use', () => {
  it('mixing a BigInt with a Number throws, so a BigInt literal is not primitive-valued', () => {
    const trace = observe('var b = 1n; var dead = b + 1; LOG("reached");');
    expect(trace).toEqual(['THROWN TypeError']);

    expect(ask('PROBE(1n);').primitive).toBe(false);
  });

  it('a BigInt literal runs no valueOf, so on its own it is still side-effect-free', () => {
    expect(ask('PROBE(1n);').free).toBe(true);
  });

  it('deleting `b + 1` would delete the throw, so the arithmetic is refused', () => {
    expect(ask('var b = 1n; PROBE(b + 1);').free).toBe(false);
  });

  it('a BigInt initialiser is refused, which is what keeps the composite claims safe', () => {
    expect(ask('var b = 1n; PROBE(b);').primitive).toBe(false);
    // Every BinaryExpression is primitive-VALUED, so the guard has to hold at
    // the leaf: `(b * 2n) + 1` passes the type test and is still refused.
    expect(ask('var b = 1n; PROBE((b * 2n) + 1);').free).toBe(false);
  });

  it('`+b` throws on any BigInt, and the same leaf refusal covers it', () => {
    const trace = observe('var b = 1n; var dead = +b; LOG("reached");');
    expect(trace).toEqual(['THROWN TypeError']);
    expect(ask('var b = 1n; PROBE(+b);').free).toBe(false);
  });
});

describe('isPrimitiveValued: what counts as a proof', () => {
  it('an object is not primitive-valued however it is written', () => {
    expect(ask('PROBE({});').primitive).toBe(false);
    expect(ask('PROBE([]);').primitive).toBe(false);
    expect(ask('PROBE(/x/);').primitive).toBe(false);
    expect(ask('PROBE(function () {});').primitive).toBe(false);
  });

  it('a constant binding to a literal holds a primitive, so it is accepted', () => {
    expect(ask('var n = 2; PROBE(n);').primitive).toBe(true);
    expect(ask('const s = "a"; PROBE(s);').primitive).toBe(true);
  });

  it('a reassigned binding can hold an object later, so it is refused', () => {
    expect(ask('var n = 2; n = {}; PROBE(n);').primitive).toBe(false);
  });

  it('a parameter takes its value from a caller, so it is refused', () => {
    expect(ask('function f(n) { PROBE(n); }').primitive).toBe(false);
  });

  it('a destructured binding can be a literal constructor, so it is refused', () => {
    expect(ask('var { constructor: c } = "abc"; PROBE(c);').primitive).toBe(false);
  });

  it('a branching producer yields one of its operands, so every branch has to be proved', () => {
    expect(ask('var n = 2, o = {}; PROBE(n || o);').primitive).toBe(false);
    expect(ask('var n = 2, m = 3; PROBE(n || m);').primitive).toBe(true);
    expect(ask('var n = 2, o = {}; PROBE(n ? n : o);').primitive).toBe(false);
    expect(ask('var o = {}, n = 2; PROBE((o, n));').primitive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUnboundUndefined - nine sites, one question
// ---------------------------------------------------------------------------

describe('isUnboundUndefined: the name `undefined` is not the keyword it looks like', () => {
  it('nothing bound the name, so the bare read is the value undefined', () => {
    const p = probe('PROBE(undefined);');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(true);
  });

  it('`function f(undefined)` rebinds the name to whatever the caller passed', () => {
    const trace = observe('function f(undefined) { LOG(undefined); } f(7);');
    expect(trace).toEqual(['7']);

    const p = probe('function f(undefined) { PROBE(undefined); }');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(false);
  });

  it('`var undefined = 1` rebinds the name for the whole function', () => {
    const trace = observe('function f() { var undefined = 1; LOG(undefined); } f();');
    expect(trace).toEqual(['1']);

    const p = probe('function f() { var undefined = 1; PROBE(undefined); }');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(false);
  });

  it('`let undefined` rebinds it even where the read precedes the declaration', () => {
    const p = probe('function f() { PROBE(undefined); let undefined = 1; }');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(false);
  });

  it('Babel reports `undefined` as bound in every scope, so hasBinding cannot answer this', () => {
    const p = probe('PROBE(undefined);');
    // The trap the nine sites have to avoid: `hasBinding` counts Babel's
    // context variables, so it is `true` here with nothing declared anywhere.
    expect(p.scope.hasBinding('undefined')).toBe(true);
    expect(p.scope.getBinding('undefined')).toBeUndefined();
    expect(isUnboundUndefined(p.node, p.scope)).toBe(true);
  });

  it('another name is not this question, however nullish it looks', () => {
    const p = probe('PROBE(nil);');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(false);
  });

  it('a non-identifier is not this question either', () => {
    const p = probe('PROBE(void 0);');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(false);
  });

  it('a `with` object can supply the name, which this predicate does not model', () => {
    const trace = observe('with ({ undefined: 5 }) { LOG(undefined); }');
    expect(trace).toEqual(['5']);

    // Stated so nobody reads a `true` here as "safe": there is no binding, so
    // the predicate answers `true`, and the object environment is the separate
    // `insideWith` question that purity.ts asks alongside it.
    const p = probe('with (o) { PROBE(undefined); }');
    expect(isUnboundUndefined(p.node, p.scope)).toBe(true);
    expect(isSideEffectFree(p.node, p.scope, { path: p.path })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isInitialisedBinding - the TDZ half
// ---------------------------------------------------------------------------

describe('isInitialisedBinding: a binding that exists is not a binding that can be read', () => {
  it('a `let` read before its declaration throws, so it is refused', () => {
    const trace = observe('function f() { LOG(v); let v = 1; } f();');
    expect(trace).toEqual(['THROWN ReferenceError']);

    const p = probe('function f() { PROBE(v); let v = 1; }');
    expect(isInitialisedBinding(p.node as t.Identifier, p.scope)).toBe(false);
  });

  it('a `let` read after its declaration is initialised, so it is accepted', () => {
    const p = probe('function f() { let v = 1; PROBE(v); }');
    expect(isInitialisedBinding(p.node as t.Identifier, p.scope)).toBe(true);
  });

  it('a `var` is initialised to undefined on entry, so a read before it is accepted', () => {
    const trace = observe('function f() { LOG(v); var v = 1; } f();');
    expect(trace).toEqual(['undefined']);

    const p = probe('function f() { PROBE(v); var v = 1; }');
    expect(isInitialisedBinding(p.node as t.Identifier, p.scope)).toBe(true);
  });

  it('a class declaration has a TDZ like `let`, so a read before it is refused', () => {
    const trace = observe('function f() { LOG(C); class C {} } f();');
    expect(trace).toEqual(['THROWN ReferenceError']);

    const p = probe('function f() { PROBE(C); class C {} }');
    expect(isInitialisedBinding(p.node as t.Identifier, p.scope)).toBe(false);
  });

  it('an unbound name has no binding to be initialised, so it is refused', () => {
    const p = probe('PROBE(free);');
    expect(isInitialisedBinding(p.node as t.Identifier, p.scope)).toBe(false);
  });

  it('a synthesised node carries no position, so the answer is a refusal rather than a guess', () => {
    const p = probe('function f() { PROBE(v); let v = 1; }');
    const synthetic = t.identifier('v');
    expect(synthetic.start).toBeUndefined();
    expect(isInitialisedBinding(synthetic, p.scope)).toBe(false);
  });

  it('the two predicates are complements, so their composite is order-independent', () => {
    // The regression this extraction exists to end: written the other way round,
    // the name test short-circuited past the TDZ test on `let undefined`.
    const shadowed = probe('function f() { PROBE(undefined); let undefined = 1; }');
    const node = shadowed.node as t.Identifier;
    expect(isInitialisedBinding(node, shadowed.scope)).toBe(false);
    expect(isUnboundUndefined(node, shadowed.scope)).toBe(false);
    expect(isSideEffectFree(node, shadowed.scope, { path: shadowed.path })).toBe(false);
  });

  it('a bound `undefined` that IS initialised reads safely while still not being the value', () => {
    const p = probe('function f(undefined) { PROBE(undefined); }');
    expect(isInitialisedBinding(p.node as t.Identifier, p.scope)).toBe(true);
    expect(isUnboundUndefined(p.node, p.scope)).toBe(false);
    // Safe to evaluate, and not safe to treat as the value `undefined`: the two
    // questions have different answers on the same node, which is why they are
    // two predicates.
    expect(isSideEffectFree(p.node, p.scope, { path: p.path })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// with - the object environment answers before any binding does
// ---------------------------------------------------------------------------

describe('with: a binding is only a fallback', () => {
  it('a `with` object intercepts a name that has a binding, so names inside are refused', () => {
    const trace = observe('var v = 1; with ({ v: 2 }) { LOG(v); }');
    expect(trace).toEqual(['2']);

    const answers = ask('var v = 1; with (o) { PROBE(v); }');
    expect(answers.invokes).toBe(true);
    expect(answers.free).toBe(false);
    expect(answers.primitive).toBe(false);
  });

  it('a `with` changes name resolution only, so a literal inside one is still a literal', () => {
    expect(ask('with (o) { PROBE(1); }').free).toBe(true);
  });

  it('a `with` body that is not a block still hides the name, and is found without a path too', () => {
    const trace = observe('var v = 1; with ({ v: 2 }) LOG(v);');
    expect(trace).toEqual(['2']);

    const answers = ask('var v = 1; with (o) PROBE(v);');
    expect(answers.free).toBe(false);
    // The scope-derived fallback has to catch this one by scanning, because the
    // node's scope is the `with`'s own ancestor rather than its descendant.
    expect(answers.freeWithoutPath).toBe(false);
  });

  it('the head is evaluated in the enclosing scope, so it resolves normally', () => {
    const trace = observe('var o = { v: 2 }; var v = 1; with (o) { LOG(v); } LOG(v);');
    expect(trace).toEqual(['2', '1']);

    const answers = ask('var v = 1; with (PROBE(v)) { }');
    expect(answers.free).toBe(true);
    expect(answers.freeWithoutPath).toBe(true);
  });

  it('a blocked body is a scope of its own, so the answer does not depend on being given a path', () => {
    const p = probe('var v = 1; with (o) { PROBE(v); }');
    expect(isSideEffectFree(p.node, p.scope, { path: p.path })).toBe(false);
    expect(isSideEffectFree(p.node, p.scope)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

describe('the three strengths are nested', () => {
  const corpus = [
    'PROBE(1);',
    'PROBE("s");',
    'PROBE(1n);',
    'PROBE(/x/);',
    'PROBE(undefined);',
    'PROBE(free);',
    'var v = 1; PROBE(v);',
    'function f() { PROBE(v); let v = 1; }',
    'var v = 1; PROBE(v = 2);',
    'var v = 1; PROBE(v++);',
    'var o = {}; PROBE(-o);',
    'var n = 1; PROBE(-n);',
    'var o = {}; PROBE(o.x);',
    'var o = {}; PROBE(`${o}`);',
    'var n = 1; PROBE(`${n}`);',
    'var o = {}; PROBE({ [o]: 1 });',
    'var n = 1; PROBE([n, , n]);',
    'var n = 1; PROBE({ a: n });',
    'function f() {} PROBE(f());',
    'var xs = []; PROBE([...xs]);',
    'PROBE(class {});',
    'var v = 1; with (o) { PROBE(v); }',
  ];

  it('anything side-effect-free also cannot invoke user code', () => {
    const answers = corpus.map((source) => ({ source, ...ask(source) }));
    // Non-vacuity: the implication below is only worth asserting if the corpus
    // actually contains both answers.
    expect(answers.some((a) => a.free)).toBe(true);
    expect(answers.some((a) => !a.free)).toBe(true);
    for (const answer of answers) {
      if (answer.free) {
        expect(`${answer.source} invokes=${answer.invokes}`).toBe(`${answer.source} invokes=false`);
      }
    }
  });

  it('`{ a: b }` is an object literal rather than a pattern, so a bound value is accepted', () => {
    // The one case where the old copies over-refused: `isPatternLike` is true of
    // a bare Identifier, which refused the commonest object literal there is.
    expect(ask('var n = 1; PROBE({ a: n });').free).toBe(true);
    expect(ask('var n = 1; PROBE({ a: n.x });').free).toBe(false);
  });

  it('an array hole evaluates nothing, so holes do not block acceptance', () => {
    expect(ask('var n = 1; PROBE([n, , n]);').free).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

describe('the depth cap refuses rather than overflows', () => {
  const chain = (length: number): string =>
    `PROBE(${Array.from({ length }, () => '"a"').join(' + ')});`;

  it('an ordinary chain is decided normally', () => {
    expect(ask(chain(10)).free).toBe(true);
  });

  it('a chain past the cap answers the refusal, which is the safe direction', () => {
    expect(ask(chain(400)).free).toBe(false);
    expect(ask(chain(400)).invokes).toBe(true);
  });
});
