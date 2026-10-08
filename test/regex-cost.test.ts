import { describe, expect, it } from 'vitest';
import { InterpreterRefusal } from '../src/analysis/evaluator/builtins.js';
import { createInterpreter } from '../src/analysis/evaluator/interpreter.js';
import { MAX_REGEX_WORK, readRegexCost, regexWork } from '../src/analysis/evaluator/regex-cost.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';

/**
 * A host regex runs with no step budget, so a pattern whose backtracking is
 * exponential hangs the engine past every budget it has. The pattern is read
 * before it runs; what cannot be bounded is refused, what can is charged
 * against a fixed amount of work over the actual subject.
 */

function bounded(source: string, flags = ''): boolean {
  return typeof readRegexCost(source, flags) !== 'string';
}

function work(source: string, subject: string, flags = ''): number {
  const cost = readRegexCost(source, flags);
  if (typeof cost === 'string') throw new Error(cost);
  return regexWork(cost, subject);
}

describe('readRegexCost', () => {
  it('refuses a quantifier nested inside another', () => {
    expect(bounded('^(a+)+$')).toBe(false);
    expect(bounded('(((.+)+)+)+$')).toBe(false);
    expect(bounded('(\\\\[x|u](\\w){2,4})+')).toBe(false);
    expect(bounded('(?:a?b?)+c')).toBe(false);
    expect(bounded('(a*)*')).toBe(false);
  });

  it('refuses an alternation under a quantifier whose branches can begin alike or match nothing', () => {
    expect(bounded('(a|a)+$')).toBe(false);
    expect(bounded('(?:a|ab)+c')).toBe(false);
    expect(bounded('(?:\\w|_)+$')).toBe(false);
    expect(bounded('(?:a|)+b')).toBe(false);
    expect(bounded('(?:a|\\p{L})+', 'u')).toBe(false);
  });

  it('refuses a backreference under a quantifier', () => {
    expect(bounded('(a)\\1+')).toBe(false);
    expect(bounded('(?:(a)\\1)+')).toBe(false);
    expect(bounded('(?<x>a)\\k<x>*')).toBe(false);
  });

  it('accepts star height one and alternations decided by their next character', () => {
    expect(bounded('\\w+ *\\(\\) *{\\w+ *[\'|"].+[\'|"];? *}')).toBe(true);
    expect(bounded('(?:\\r\\n|\\n)+')).toBe(true);
    expect(bounded('(?:[a-z]|[0-9])+')).toBe(true);
    expect(bounded('[^A-Za-z0-9+/=]', 'g')).toBe(true);
    expect(bounded('^\\s*(.*?)\\s*$')).toBe(true);
    expect(bounded('(?:ab){3}', 'g')).toBe(true);
    expect(bounded('(?=a)*b')).toBe(true);
  });

  it('folds case before deciding that branches begin apart', () => {
    expect(bounded('(?:a|A)+')).toBe(true);
    expect(bounded('(?:a|A)+', 'i')).toBe(false);
    expect(bounded('(?:k|\\u212a)+', 'iu')).toBe(false);
  });

  it('charges a quantifier over one character set by the longest run of it', () => {
    const blob = 'QUJD'.repeat(50_000) + '==';
    expect(work('=+$', blob)).toBeLessThan(MAX_REGEX_WORK);
    expect(work('\\s+$', blob)).toBeLessThan(MAX_REGEX_WORK);
    expect(work('[^A-Za-z0-9+/=]+', blob, 'g')).toBeLessThan(MAX_REGEX_WORK);
    expect(work('=+$', '='.repeat(200_000))).toBe(Number.POSITIVE_INFINITY);
  });

  it('charges nothing for the quantifier that ends the pattern and one start for an anchor', () => {
    const long = 'a'.repeat(500_000);
    expect(work('\\s+', long, 'g')).toBeLessThan(MAX_REGEX_WORK);
    expect(work('x(?:a+)', long)).toBeLessThan(MAX_REGEX_WORK);
    expect(work('^a*a*a*b', 'a'.repeat(300))).toBeLessThan(MAX_REGEX_WORK);
    expect(work('a*a*a*b', 'a'.repeat(300))).toBe(Number.POSITIVE_INFINITY);
    expect(work('^a*a*a*b', 'a'.repeat(300), 'm')).toBe(Number.POSITIVE_INFINITY);
  });

  it('reads the syntax the host accepts', () => {
    for (const [source, flags] of [
      ['[\\d-x]', ''],
      ['[a-]', ''],
      ['a{', ''],
      ['\\cJ\\x41\\u0041\\u{1F600}', 'u'],
      ['(?<name>a)\\k<name>', ''],
      ['(?i:a)b', ''],
      ['[[a-z]--[aeiou]]', 'v'],
      ['\\p{Script=Greek}', 'u'],
      ['(?<=a)(?<!b)(?=c)(?!d)', ''],
    ] as const) {
      // A pattern this host cannot compile never reaches the reader: inline
      // modifiers, for one, arrived in V8 after Node 22.
      try {
        new RegExp(source, flags);
      } catch {
        continue;
      }
      expect(typeof readRegexCost(source, flags)).not.toBe('string');
    }
  });
});

describe('the interpreter', () => {
  function run(source: string, name: string, options = {}): unknown {
    const program = parseSource(source, { filename: 'input.js' });
    return createInterpreter(program.ast.program.body, options).read(name);
  }

  it('refuses a catastrophic pattern instead of running it past its budgets', () => {
    const started = performance.now();
    expect(() =>
      run("var x = 'a'.repeat(34) + '!'; var r = /^(a+)+$/.test(x);", 'r', { timeoutMs: 500, maxSteps: 1_000 }),
    ).toThrow(InterpreterRefusal);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses through every method that reaches the host regex', () => {
    for (const method of [
      "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.replace(/(a+)+$/, '')",
      "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.match(/(a+)+$/)",
      "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.search(/(a+)+$/)",
      "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.split(/(a+)+$/)",
      "/(a+)+$/.exec('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')",
    ]) {
      expect(() => run(`var r = ${method};`, 'r', { timeoutMs: 500 })).toThrow(InterpreterRefusal);
    }
  });

  it('still runs the patterns decoders use', () => {
    expect(run("var r = 'a b\\tc'.replace(/\\s+/g, '');", 'r')).toBe('abc');
    expect(run("var r = 'QUJD=='.replace(/=+$/, '');", 'r')).toBe('QUJD');
    expect(run("var r = 'x1y22z'.split(/\\d+/);", 'r')).toEqual(['x', 'y', 'z']);
    expect(run("var r = /^[A-Za-z0-9+/]*={0,2}$/.test('QUJD==');", 'r')).toBe(true);
    expect(run("var r = 'a\\r\\nb\\nc'.split(/(?:\\r\\n|\\n)+/);", 'r')).toEqual(['a', 'b', 'c']);
  });
});

describe('the self-defending guard', () => {
  it('is left as written when its formatting pattern has no backtracking bound', async () => {
    const source = [
      'var _0x = {',
      "  a: '(((.+)+)+)+', b: '$', c: [0, 0],",
      "  m1: function () { return 'ok'; },",
      '  m2: function (r) { return r === -1 ? undefined : this.m1(); },',
      "  m3: function () { var f = new RegExp(this.a + this.b); var g = f.test(this.m1.toString()) ? --this.c[1] : --this.c[0]; return this.m2(g); },",
      '};',
      '_0x.m3();',
      'log(1);',
    ].join('\n');
    const started = performance.now();
    const result = await deobfuscate(source, { preset: 'balanced', performance: { timeBudgetMs: 10_000 } });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.code).toContain('(((.+)+)+)+');
  });
});
