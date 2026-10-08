import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { idiomOnlyNames, isGlobalObjectRead, isGlobalThisExpression } from '../src/analysis/evaluator/global-object.js';
import { buildDecoder, type DecoderRefusal } from '../src/analysis/evaluator/index.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

/**
 * The global-object idiom is a call whose compiled source evaluates `this`
 * and nothing else: `Function('return this')()`, `(0, eval)('this')`. The
 * `this` inside that source is the global object; a `this` written in the
 * program itself is whatever the call binds, and no idiom. A `try` whose
 * block writes `this.cache` is not a reach for the global object, so a
 * fallback name in its `catch` is a reach for the host like any other, and
 * a decoder holding one is refused the way its `var cache = {}` twin is.
 */

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function execute(code: string, timeout = 2_000): string {
  const trace: string[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map(format).join(' '));
  };
  try {
    vm.runInNewContext(code, vm.createContext({ log }), { timeout });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programPath(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source, {});
  let found: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  if (!found) throw new Error('no Program path');
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], options: Parameters<typeof resolveConfig>[0] = {}) {
  const notes: { severity: Severity; message: string }[] = [];
  const refusals: DecoderRefusal[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig(options), {
    reporter: {
      note: (severity, message) => notes.push({ severity, message }),
      refused: (kind) => refusals.push(kind),
    },
  });
  return { decoder, notes, refusals };
}

function statements(source: string): t.Statement[] {
  return parseSource(source, {}).ast.program.body;
}

describe('a bare this in the program', () => {
  it('is no read of the global object, while this inside the idiom source is', () => {
    const [bare] = statements('this;') as [t.ExpressionStatement];
    expect(isGlobalThisExpression(bare.expression)).toBe(false);
    expect(isGlobalObjectRead(bare.expression)).toBe(false);
    const [idiom] = statements("Function('return this')();") as [t.ExpressionStatement];
    expect(isGlobalThisExpression(idiom.expression)).toBe(true);
    const [returned] = statements('(function () { return this; })();') as [t.ExpressionStatement];
    expect(isGlobalThisExpression(returned.expression)).toBe(true);
  });

  it('leaves a fallback name in the catch of a try over it as a reach for the host', () => {
    expect(idiomOnlyNames(statements('try { this.cache = {}; } catch (e) { window.decodeURIComponent = f; }'))).toEqual(new Set());
    expect(idiomOnlyNames(statements('try { var cache = {}; } catch (e) { window.decodeURIComponent = f; }'))).toEqual(new Set());
    expect(idiomOnlyNames(statements("try { Function('return this')().cache = {}; } catch (e) { window.decodeURIComponent = f; }"))).toEqual(
      new Set(['Function', 'window']),
    );
  });
});

const TABLE = "var table = ['%C3%BCn%C3%AF', 'plain', 'other'];\n";
const DECODER_OVER = (block: string): string =>
  `${TABLE}function dec(i) { try { ${block} } catch (e) { window.decodeURIComponent = function (s) { return s; }; } return decodeURIComponent(table[i]); }\nlog(dec(0), dec(1));\n`;

describe('a decoder with a fallback in the catch of a try over a bare this', () => {
  const twins: Record<string, string> = {
    'this.cache written': DECODER_OVER('this.cache = {};'),
    'a local written': DECODER_OVER('var cache = {};'),
  };

  for (const [what, source] of Object.entries(twins)) {
    it(`is refused at every preset with the fallback named: ${what}`, async () => {
      expect(execute(source)).toBe('"ünï" "plain"');
      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, ['dec', 'table'], { preset });
        expect(decoder, `${what} at ${preset}`).toBeUndefined();
        expect(notes.some((note) => note.message.includes('window')), `${what} at ${preset}`).toBe(true);
      }
      const before = execute(source);
      for (const preset of PRESETS) expect(execute((await deobfuscate(source, { preset })).code), preset).toBe(before);
    });
  }
});
