import vm from 'node:vm';
import { parse } from '@babel/parser';
import _traverse, { type NodePath, type Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { canInvokeUserCode, isSideEffectFree } from '../src/util/purity.js';

/**
 * `PurityOptions.assumeNativeBuiltins`: the one assumption a caller can opt into,
 * and everything it still refuses.
 *
 * The option exists because two halves of one rewrite were disagreeing about one
 * call. `analysis/dispatcher.ts` reads a flattened function's execution order by
 * running `'3|0|4'.split('|')` with this process's `split` and reorders the whole
 * function around the result; it then asked the oracle whether deleting that same
 * call was observable and was told no, on the ground that `String.prototype.split`
 * might have been replaced. Trusting a builtin enough to reorder a program around
 * what it returns, and distrusting it enough to keep the call, are not two
 * positions a pass gets to hold at once - so the assumption is now named, and a
 * caller already spending it says so.
 *
 * What matters here is the SHAPE of what the option opens up, because that is
 * the part a future caller will lean on: it accepts one method, on a receiver
 * proven to be a string, with arguments proven to be primitives. Each refusal
 * below is a case where dropping one of those three would reach user code or
 * throw, and the hazard tests run the shape first to show the hazard is real.
 */

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

interface Probe {
  readonly node: t.Node;
  readonly scope: Scope;
  readonly path: NodePath;
}

/** The expression marked `PROBE(<expr>)`, with the scope and path it sits at. */
function probe(source: string): Probe {
  const ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true });
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

/** Whether the oracle would let a removal delete this expression. */
function removable(source: string, assumeNativeBuiltins: boolean): boolean {
  const { node, scope, path } = probe(source);
  return isSideEffectFree(node, scope, { path, assumeNativeBuiltins });
}

/** Run in a fresh realm; used to show a hazard is real before asserting a refusal. */
function execute(code: string): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(String).join(' '));
  };
  const sandbox: Record<string, unknown> = { log, console: { log } };
  sandbox['globalThis'] = sandbox;
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}`);
  }
  return trace.join(' | ');
}

// ---------------------------------------------------------------------------
// What the option opens up
// ---------------------------------------------------------------------------

describe('assumeNativeBuiltins accepts a native split on a string', () => {
  it('refuses `<literal>.split(<literal>)` by default, and accepts it under the option', () => {
    const source = `PROBE('1|0'.split('|'));`;
    expect(removable(source, false)).toBe(false);
    expect(removable(source, true)).toBe(true);
  });

  it('reads a template receiver, which is a string whatever it interpolates', () => {
    // Cloudflare's post-pass rewrites every string literal as a template, so
    // this is the spelling the order array arrives in on a real challenge.
    expect(removable('PROBE(`1|0`.split(`|`));', true)).toBe(true);
  });

  it('reads a `+` chain of literals, which the obfuscator splits across operands', () => {
    expect(removable(`PROBE(('1|0|' + '2|4|' + '3').split('|'));`, true)).toBe(true);
  });

  it('reads the computed spelling of the method name', () => {
    expect(removable(`PROBE('1|0'['split']('|'));`, true)).toBe(true);
  });

  it('accepts a second argument when it is a primitive', () => {
    expect(removable(`PROBE('1|0'.split('|', 2));`, true)).toBe(true);
  });

  it('changes nothing about the weaker strength, which never refused a plain literal', () => {
    const { node, scope, path } = probe(`PROBE('1|0'.split('|'));`);
    expect(canInvokeUserCode(node, scope, { path })).toBe(true);
    expect(canInvokeUserCode(node, scope, { path, assumeNativeBuiltins: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What it still refuses, and why each one is a real hazard
// ---------------------------------------------------------------------------

describe('assumeNativeBuiltins refuses everything it cannot prove total', () => {
  it('refuses a receiver that is a primitive but not a string', () => {
    // `(5).split` is `undefined`, and calling `undefined` throws - an
    // observable a removal must not drop. `5` is `isPrimitiveValued`, so
    // proving the receiver is a STRING is doing real work here.
    expect(execute(`try { (5).split('|'); } catch (e) { log('THREW ' + e.constructor.name); }`)).toBe(
      'THREW TypeError',
    );
    expect(removable(`PROBE((5).split('|'));`, true)).toBe(false);
  });

  it('refuses a receiver whose type it cannot see', () => {
    expect(removable(`PROBE(x.split('|'));`, true)).toBe(false);
    expect(removable(`PROBE(o.k.split('|'));`, true)).toBe(false);
  });

  it('refuses a `+` chain whose other operand could be an object', () => {
    // `'a' + o` runs `o.valueOf()`, which is a method the program wrote.
    expect(execute(`var o = { valueOf: function () { log('VALUEOF'); return 1; } }; 'a' + o;`)).toBe(
      'VALUEOF',
    );
    expect(removable(`var o = {}; PROBE(('1|0' + o).split('|'));`, true)).toBe(false);
  });

  it('refuses an argument that is not provably a primitive', () => {
    // A separator that is an object is looked up for `Symbol.split` and then
    // called - the argument decides what runs.
    expect(
      execute(
        `var sep = {}; sep[Symbol.split] = function () { log('SYMBOL.SPLIT'); return []; };` +
          `'1|0'.split(sep);`,
      ),
    ).toBe('SYMBOL.SPLIT');
    expect(removable(`var sep = {}; PROBE('1|0'.split(sep));`, true)).toBe(false);
  });

  it('refuses an argument that runs code on the way in', () => {
    expect(removable(`PROBE('1|0'.split(f()));`, true)).toBe(false);
    expect(removable(`PROBE('1|0'.split(o.sep));`, true)).toBe(false);
  });

  it('refuses a spread argument, which runs the iterator protocol', () => {
    expect(removable(`var a = ['|']; PROBE('1|0'.split(...a));`, true)).toBe(false);
  });

  it('refuses a method outside the set, however string-like the call looks', () => {
    // `repeat` throws a RangeError on a negative count, `replace` calls a
    // replacer, `match` dispatches through `@@match`: none is total on the
    // operands this oracle can prove, so the assumption does not extend to them.
    for (const call of [`'ab'.repeat(2)`, `'ab'.replace('a', 'b')`, `'ab'.toUpperCase()`]) {
      expect(removable(`PROBE(${call});`, true), call).toBe(false);
    }
  });

  it('refuses a plain call and a `new`, which the option says nothing about', () => {
    expect(removable(`PROBE(split('|'));`, true)).toBe(false);
    expect(removable(`PROBE(new Thing());`, true)).toBe(false);
  });

  it('refuses an optional call, which is a call with a null check in front of it', () => {
    expect(removable(`PROBE('1|0'?.split('|'));`, true)).toBe(false);
  });

  it('refuses inside a `with`, where even the method name resolves at run time', () => {
    // The receiver is still a literal, but the ARGUMENT is a name, and under a
    // `with` a name is a property read on the object - a getter.
    expect(
      execute(
        `var sep = '|'; with ({ get sep() { log('GETTER'); return '|'; } }) { '1|0'.split(sep); }`,
      ),
    ).toBe('GETTER');
    expect(removable(`var sep = '|'; with (o) { PROBE('1|0'.split(sep)); }`, true)).toBe(false);
  });
});
