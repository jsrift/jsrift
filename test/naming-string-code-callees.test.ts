import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { freezeHazardKind } from '../src/naming/allocate.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A string compiled by `Function` or an indirect `eval` addresses
 * program-scope names by their spelling, and the callee that compiles it can
 * be reached by any route a call takes: a sequence, a literal in callee
 * position, one arm of a conditional, `Function.prototype.call` applied to
 * it. The renamer, `clean.unused` and the strings passes all ask one
 * classifier which routes it sees through, so a route it misses deletes the
 * table and the decoder the compiled string still names - output that throws
 * where the input printed.
 */

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function trace(code: string): string {
  const lines: string[] = [];
  try {
    vm.runInNewContext(code, { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) }, { timeout: 2_000 });
  } catch (error) {
    const err = error as Error;
    lines.push(`THROWN ${err.name}: ${err.message}`);
  }
  return lines.join(' | ');
}

async function output(source: string, preset: DeobfuscateOptions['preset']): Promise<string> {
  return (await deobfuscate(source, { preset })).code;
}

const TABLE = "var _0x1f = ['alpha', 'beta']; function _0x2e(i) { return _0x1f[i]; } log(_0x2e(0)); ";

describe('string code compiled through a rearranged callee keeps what it names', () => {
  const cases: [string, string][] = [
    ['a sequence ending in Function', "log((0, Function)('return _0x2e(1)')());"],
    ['Function.prototype.call applied to Function', "log(Function.prototype.call.call(Function, null, 'return _0x2e(1)')());"],
    ['Function picked out of an array literal', "log([Function][0]('return _0x2e(1)')());"],
    ['Function picked out of an object literal', "log(({ F: Function }).F('return _0x2e(1)')());"],
    ['Function as one arm of a conditional', "var c = true; log((c ? Function : parseInt)('return _0x2e(1)')());"],
    ['Function as one arm of a logical', "var c = null; log((c || Function)('return _0x2e(1)')());"],
    ['an indirect eval reached through a sequence and .call', "log((0, eval).call(null, '_0x2e(1)'));"],
  ];

  for (const [title, tail] of cases) {
    const source = TABLE + tail;
    for (const preset of PRESETS) {
      it(`${title}, ${preset}`, async () => {
        const code = await output(source, preset);
        expect(trace(code)).toBe(trace(source));
        expect(code).toContain('_0x2e');
      });
    }
  }
});

describe('naming/allocate: the classifier sees through the routes a call can take', () => {
  /** How the outermost call or `new` in `source` is classified. */
  const kindOf = (source: string): unknown => {
    const { ast } = parseSource(source, {});
    let seen: unknown = 'not found';
    traverse(ast, {
      enter(path: NodePath) {
        if (!path.isCallExpression() && !path.isNewExpression()) return;
        seen = freezeHazardKind(path);
        path.stop();
      },
    });
    return seen;
  };

  it('a sequence, a literal pick and a conditional reach Function', () => {
    expect(kindOf('(0, Function)(src);')).toBe('global');
    expect(kindOf('[Function][0](src);')).toBe('global');
    expect(kindOf('({ F: Function }).F(src);')).toBe('global');
    expect(kindOf('(c ? Function : parseInt)(src);')).toBe('global');
    expect(kindOf('(c && Function)(src);')).toBe('global');
    expect(kindOf('Function.prototype.call.call(Function, null, src);')).toBe('global');
    expect(kindOf('Function.prototype.apply.call(Function, null, [src]);')).toBe('global');
  });

  it('only a bare eval called directly is lexical', () => {
    expect(kindOf('eval(src);')).toBe('lexical');
    expect(kindOf('(0, eval)(src);')).toBe('global');
    expect(kindOf('[eval][0](src);')).toBe('global');
    expect(kindOf('eval.call(null, src);')).toBe('global');
    expect(kindOf('(c ? eval : parseInt)(src);')).toBe('global');
  });

  it('eval reached through new is no hazard, whatever the route', () => {
    expect(kindOf('new eval(src);')).toBe(null);
    expect(kindOf('new (0, eval)(src);')).toBe(null);
    expect(kindOf('new (eval.bind(null))(src);')).toBe(null);
    expect(kindOf('Reflect.construct(eval, [src]);')).toBe(null);
    expect(kindOf('Reflect.construct(Function, [src]);')).toBe('global');
  });

  it('a route to something else is still nothing', () => {
    expect(kindOf('(0, parseInt)(src);')).toBe(null);
    expect(kindOf('[parseInt][0](src);')).toBe(null);
    expect(kindOf('(c ? parseInt : Number)(src);')).toBe(null);
    expect(kindOf('Function.prototype.call.call(parseInt, null, src);')).toBe(null);
  });
});
