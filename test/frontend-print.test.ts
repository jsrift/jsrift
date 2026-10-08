import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateOptions } from '../src/types.js';

const BACKTICK = String.fromCharCode(96);

/** Run in a fresh realm with only `log`, and return everything it logged. */
function execute(code: string): string {
  const trace: string[] = [];
  const sandbox = { log: (...args: unknown[]) => trace.push(args.map((a) => JSON.stringify(a)).join(' ')) };
  try {
    vm.runInNewContext(code, vm.createContext(sandbox), { timeout: 5_000 });
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

async function expectSameBehaviour(source: string, options: DeobfuscateOptions): Promise<string> {
  const { code, metadata } = await deobfuscate(source, { preset: 'conservative', ...options });
  expect(metadata.stats.verified).toBe(true);
  expect(execute(code)).toBe(execute(source));
  return code;
}

/** The tree with every position stripped, so two printings can be compared as programs. */
function shape(code: string, jsx: boolean): unknown {
  const ast = parse(code, { sourceType: 'unambiguous', plugins: jsx ? ['jsx'] : [] });
  return JSON.parse(
    JSON.stringify(ast.program, (key, value: unknown) =>
      key === 'loc' || key === 'start' || key === 'end' || key === 'range' ? undefined : value,
    ),
  );
}

// ---------------------------------------------------------------------------
// Re-indentation must not touch literal content it cannot classify
// ---------------------------------------------------------------------------

describe('re-indentation of JSX output', () => {
  const JSX_IMPORT = 'import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";\n';

  // A closing tag's `/` used to be read as a regex start and a URL's `//` as
  // a line comment, so the scanner lost the template literal that opened later
  // on the same line and rewrote its continuation lines as if they were code.
  it('keeps a template literal that shares a line with a closing tag', async () => {
    const source =
      JSX_IMPORT +
      'export const A = ({ x }) => _jsxs("div", { children: [_jsx("b", { children: "x" }), ' +
      `_jsx("pre", { children: ${BACKTICK}a \${x}\n b${BACKTICK} })] });\n` +
      `export const B = ({ y }) => _jsx("p", { children: ${BACKTICK}c\n   d${BACKTICK} });\n`;
    const two = await deobfuscate(source, { language: 'jsx', output: { indent: 2 } });
    const four = await deobfuscate(source, { language: 'jsx', output: { indent: 4 } });
    expect(two.code).toContain('</b>');
    expect(four.code).toContain('</b>');
    expect(shape(four.code, true)).toEqual(shape(two.code, true));
  });

  it('keeps a template literal that shares a line with a URL in JSX text', async () => {
    const source =
      JSX_IMPORT +
      'export const A = ({ x }) => _jsxs("a", { href: "https://example.com", children: ["https://example.com", ' +
      `_jsx("pre", { children: ${BACKTICK}a \${x}\n b${BACKTICK} })] });\n` +
      `export const B = ({ y }) => _jsx("p", { children: ${BACKTICK}c \${y}\n   d${BACKTICK} });\n`;
    const two = await deobfuscate(source, { language: 'jsx', output: { indent: 2 } });
    const four = await deobfuscate(source, { language: 'jsx', output: { indent: 4 } });
    expect(four.code).toContain('https://example.com');
    expect(shape(four.code, true)).toEqual(shape(two.code, true));
  });

  it('still re-indents the code around the JSX', async () => {
    const source =
      JSX_IMPORT +
      'export function A({ items }) {\n  if (items.length) {\n    return _jsx("ul", { children: items.map((i) => _jsx("li", { children: i })) });\n  }\n  return null;\n}\n';
    const { code } = await deobfuscate(source, { language: 'jsx', output: { indent: 4 } });
    expect(code).toMatch(/\n {4}if \(/);
    expect(code).toMatch(/\n {8}return/);
  });
});

// ---------------------------------------------------------------------------
// output.format
// ---------------------------------------------------------------------------

describe('output.format', () => {
  const SOURCE =
    'function greet(a) {\n  var b = [1, 2, 3];\n  if (a) {\n    return b.join("");\n  }\n  return a;\n}\nlog(greet(true), greet(false));\n';

  it('false prints compact output on any input size', async () => {
    const pretty = await expectSameBehaviour(SOURCE, { output: { format: true } });
    const compact = await expectSameBehaviour(SOURCE, { output: { format: false } });
    expect(pretty.split('\n').length).toBeGreaterThan(3);
    expect(compact.split('\n').length).toBeLessThan(pretty.split('\n').length);
    expect(compact).not.toMatch(/\n {2}/);
  });

  it('false ignores indent, which has nothing to apply to', async () => {
    const compact = await expectSameBehaviour(SOURCE, { output: { format: false, indent: 4 } });
    expect(compact).not.toMatch(/\n {4}/);
  });
});

// ---------------------------------------------------------------------------
// output.quotes
// ---------------------------------------------------------------------------

describe('output.quotes', () => {
  const SOURCE =
    'var a = \'single\';\nvar b = "double";\nvar c = "it\'s";\nvar d = \'say "hi"\';\n' +
    'var e = \'x\' + \'y\';\nvar f = "\\x41\\n";\nlog(a, b, c, d, e, f);\n';

  it('double re-quotes every literal, not only the ones the engine wrote', async () => {
    const code = await expectSameBehaviour(SOURCE, { output: { quotes: 'double' } });
    expect(code).toContain('var a = "single";');
    expect(code).toContain('var b = "double";');
    expect(code).toContain('var c = "it\'s";');
    expect(code).toContain('var d = "say \\"hi\\"";');
    expect(code).toContain('var e = "xy";');
    expect(code).not.toMatch(/'[^']*'/);
  });

  it('single re-quotes the double-quoted literals from the input', async () => {
    const code = await expectSameBehaviour(SOURCE, { output: { quotes: 'single' } });
    expect(code).toContain("var a = 'single';");
    expect(code).toContain("var b = 'double';");
    expect(code).toContain("var c = 'it\\'s';");
    expect(code).toContain("var d = 'say \"hi\"';");
    // Normalised by `literalSimplification` and then quoted by the printer.
    expect(code).toContain("var f = 'A\\n';");
  });

  it('preserve keeps each input literal as written and writes new ones single-quoted', async () => {
    const code = await expectSameBehaviour(SOURCE, { output: { quotes: 'preserve' } });
    expect(code).toContain("var a = 'single';");
    expect(code).toContain('var b = "double";');
    expect(code).toContain('var c = "it\'s";');
    expect(code).toContain("var e = 'xy';");
    const byDefault = await expectSameBehaviour(SOURCE, {});
    expect(byDefault).toBe(code);
  });

  it('changes the quotes and nothing else about a literal', async () => {
    // Escape normalisation is `literalSimplification`'s job and can be turned
    // off; re-quoting must not do it through the back door.
    const code = await expectSameBehaviour('log("\\x41\\u0042");', {
      output: { quotes: 'single' },
      techniques: { literalSimplification: false },
    });
    expect(code).toContain("log('\\x41\\u0042');");
  });

  it('leaves directives and JSX attributes alone, where the quotes are not a style', async () => {
    // A directive is its raw text: `'use strict'` with different characters is
    // not a directive. A JSX attribute has no escapes at all, so `alt='a\tb'`
    // is backslash-t to JSX, and its quotes cannot be swapped without one.
    const source = '"use strict";\nexport const el = <input alt=\'a\\tb\' title="it\'s" />;\n';
    const { code, metadata } = await deobfuscate(source, { language: 'jsx', output: { quotes: 'single' } });
    expect(metadata.stats.verified).toBe(true);
    expect(code).toContain('"use strict";');
    expect(code).toContain("alt='a\\tb'");
    expect(code).toContain('title="it\'s"');
    const double = await deobfuscate(source, { language: 'jsx', output: { quotes: 'double' } });
    expect(double.code).toContain("alt='a\\tb'");
  });
});

// ---------------------------------------------------------------------------
// Stale source map directives
// ---------------------------------------------------------------------------

describe('input sourceMappingURL directives', () => {
  const SOURCE = "var a = 'x' + 'y';\nlog(a);\n//# sourceMappingURL=original.js.map\n";

  it('are not copied into output that they no longer describe', async () => {
    const code = await expectSameBehaviour(SOURCE, {});
    expect(code).not.toContain('sourceMappingURL');
  });

  it('are replaced, not joined, by the inline map', async () => {
    const { code } = await deobfuscate(SOURCE, { output: { sourceMaps: 'inline' } });
    expect(code.match(/sourceMappingURL=/g)).toHaveLength(1);
    expect(code).toContain('sourceMappingURL=data:application/json');
    expect(code).not.toContain('original.js.map');
  });

  it('covers sourceURL and the block-comment spelling as well', async () => {
    const source = '/*# sourceURL=bundle.js */\nvar a = 1;\nlog(a);\n/*# sourceMappingURL=a.map */\n';
    const code = await expectSameBehaviour(source, {});
    expect(code).not.toContain('sourceURL');
    expect(code).not.toContain('sourceMappingURL');
  });

  it('keeps every other comment', async () => {
    const source = '// keep me\nvar a = 1;\nlog(a);\n//# sourceMappingURL=a.map\n';
    const code = await expectSameBehaviour(source, {});
    expect(code).toContain('keep me');
  });
});

// ---------------------------------------------------------------------------
// output.banner and the source map
// ---------------------------------------------------------------------------

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode one mappings string into [generatedLine, generatedColumn, sourceLine, sourceColumn] rows. */
function decodeMappings(mappings: string): number[][] {
  const rows: number[][] = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  mappings.split(';').forEach((line, generatedLine) => {
    let generatedColumn = 0;
    if (!line) return;
    for (const segment of line.split(',')) {
      const fields: number[] = [];
      let shift = 0;
      let value = 0;
      for (const char of segment) {
        const digit = VLQ.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >> 1) : value >> 1);
        shift = 0;
        value = 0;
      }
      generatedColumn += fields[0]!;
      if (fields.length >= 4) {
        source += fields[1]!;
        sourceLine += fields[2]!;
        sourceColumn += fields[3]!;
        rows.push([generatedLine, generatedColumn, sourceLine, sourceColumn]);
      }
    }
  });
  return rows;
}

describe('output.banner with source maps', () => {
  const SOURCE = 'function alpha(x) {\n  return x + 1;\n}\nfunction beta(y) {\n  return alpha(y) * 2;\n}\nlog(beta(3));\n';

  it('shifts every mapping by the lines the banner occupies', async () => {
    const plain = await deobfuscate(SOURCE, { preset: 'conservative', filename: 'in.js', output: { sourceMaps: true } });
    const banner = await deobfuscate(SOURCE, {
      preset: 'conservative',
      filename: 'in.js',
      output: { sourceMaps: true, banner: true },
    });
    expect(execute(banner.code)).toBe(execute(SOURCE));

    const bannerLines = banner.code.indexOf('\n' + plain.code.split('\n')[0]!);
    expect(bannerLines).toBeGreaterThan(0);
    const offset = banner.code.slice(0, bannerLines + 1).split('\n').length - 1;
    expect(offset).toBe(5);

    const before = decodeMappings(plain.map!.mappings);
    const after = decodeMappings(banner.map!.mappings);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      const [line, ...rest] = before[i]!;
      expect(after[i]).toEqual([(line as number) + offset, ...rest]);
    }
    // Spot check against the text itself: `beta` in the output maps to `beta` in the input.
    const outputLines = banner.code.split('\n');
    const inputLines = SOURCE.split('\n');
    const betaRow = after.find(([line, column]) => outputLines[line!]!.slice(column!).startsWith('beta'));
    expect(betaRow).toBeDefined();
    expect(inputLines[betaRow![2]!]!.slice(betaRow![3]!)).toMatch(/^beta/);
  });

  it('shifts the inline map the same way', async () => {
    const plain = await deobfuscate(SOURCE, { preset: 'conservative', output: { sourceMaps: true } });
    const { code } = await deobfuscate(SOURCE, { preset: 'conservative', output: { sourceMaps: 'inline', banner: true } });
    const encoded = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/.exec(code);
    expect(encoded).not.toBeNull();
    const inline = JSON.parse(Buffer.from(encoded![1]!, 'base64').toString('utf8')) as { mappings: string };
    const before = decodeMappings(plain.map!.mappings);
    const after = decodeMappings(inline.mappings);
    expect(after).toEqual(before.map(([line, ...rest]) => [(line as number) + 5, ...rest]));
  });

  it('keeps a shebang on the first line', async () => {
    const { code } = await deobfuscate('#!/usr/bin/env node\nlog(1);\n', {
      preset: 'conservative',
      output: { banner: true },
    });
    expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(code).toContain('Deobfuscated with jsrift');
  });
});
