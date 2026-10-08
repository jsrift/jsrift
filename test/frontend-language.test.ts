import { describe, expect, it } from 'vitest';
import { analyze, deobfuscate } from '../src/index.js';
import { AmbiguousDialectError, parseSource } from '../src/frontend/language.js';

/**
 * `f<T>(x)` is a generic call in TypeScript and `(f < T) > (x)` in JavaScript.
 * Both parse. The auto-detect ladder used to keep the first dialect that
 * parsed - always `js` - and reprint the comparison chain as the program, with
 * `verified: true` and no diagnostic. A detection that changes what the input
 * means is a guess, and the engine does not guess: it refuses and names the
 * site, so the caller can pin the dialect.
 */
describe('auto-detect refuses input whose JavaScript and TypeScript readings differ', () => {
  const REACT_HOOKS =
    'const [n, setN] = useState<number>(0);\n' +
    'const ref = useRef<HTMLDivElement>(null);\n' +
    'export const C = () => <div ref={ref}>{n}</div>;\n';

  it('refuses a TSX component whose only TypeScript syntax is a type argument', async () => {
    const error = await deobfuscate(REACT_HOOKS).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AmbiguousDialectError);
    const message = (error as Error).message;
    // Actionable: the site, both readings, and the option that settles it.
    expect(message).toContain('useState<number>(0)');
    expect(message).toMatch(/line 1/);
    expect(message).toMatch(/language/);
  });

  it('refuses from analyze() as well, which is what a UI calls first', () => {
    expect(() => analyze(REACT_HOOKS)).toThrow(AmbiguousDialectError);
  });

  it('keeps the generic call once the dialect is pinned by option', async () => {
    const result = await deobfuscate(REACT_HOOKS, { language: 'tsx', preset: 'conservative' });
    expect(result.metadata.language).toBe('tsx');
    expect(result.code).toContain('useState<number>(0)');
    expect(result.code).toContain('useRef<HTMLDivElement>(null)');
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('keeps the generic call once the dialect is pinned by filename', async () => {
    const result = await deobfuscate(REACT_HOOKS, { filename: 'Counter.tsx', preset: 'conservative' });
    expect(result.metadata.language).toBe('tsx');
    expect(result.code).toContain('useState<number>(0)');
  });

  it('honours an explicit js pin: the caller said what the file is', async () => {
    const result = await deobfuscate('const a = f<T>(x);', { language: 'js', preset: 'conservative' });
    expect(result.metadata.language).toBe('js');
    expect(result.code).toContain('f < T > x');
  });

  it.each([
    ['a plain call', 'identity<string>("hello", "world");'],
    ['a constructor', 'const b = new Box<string>("x");'],
    ['a member chain after the call', 'const y = m<T>(x).y;'],
    ['an optional chain after the call', 'const z = q<T>(x)?.z;'],
    ['a tagged template', 'const s = g<T>`x`;'],
    ['a union type argument', 'h<A | B>(x);'],
    ['a nested type argument', 'k<Foo<Bar>>(x);'],
    ['two type arguments in statement position', 'f<A, B>(x);'],
    ['an object type argument', 'f<{ a: number }>(x);'],
    ['a member type argument', 'f<Api.Response>(x);'],
    ['an arrow argument', 'f<T>((a) => a);'],
    ['an awaited call', 'async function run() { return await f<T>(x); }'],
    ['a call inside tighter arithmetic', 'const n = f<T>(x) + 1;'],
    ['a call inside a shift', 'const n = f<T>(x) << 1;'],
    ['a union type argument inside arithmetic', 'const n = h<A | B>(x) * 2;'],
    ['a nested type argument inside a union', 'h<A | B<C>>(x);'],
  ])('refuses %s', async (_label, source) => {
    await expect(deobfuscate(source)).rejects.toThrow(AmbiguousDialectError);
  });

  it('does not refuse a comparison that TypeScript reads the same way', async () => {
    // `>` with a parenthesised right operand is the shape of a generic call,
    // but there is no `<` for TypeScript to open type arguments from, so both
    // grammars agree and the file is plain JavaScript.
    const source =
      'log(1 > (2, 3));\nlog(a > (b = 4));\n' +
      // The shape obfuscated arithmetic is full of: a shift whose right
      // operand needs its parentheses.
      'var n = _0x1bc5bd >> (-0x2 * _0x3a56a7 & 0x6);\n' +
      'var m = (a < b) > (c);\n';
    const result = await deobfuscate(source, { preset: 'conservative' });
    expect(result.metadata.language).toBe('js');
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('still reports plain JavaScript as js and TypeScript with annotations as ts', () => {
    expect(analyze('const a = f(x) > (y);').language).toBe('js');
    expect(analyze('const a: number = f<T>(x);').language).toBe('ts');
    expect(analyze('interface I { a: number }\nconst a = f<T>(x);').language).toBe('ts');
  });

  it('reports the ambiguity as a typed error distinct from a parse failure', () => {
    const error = (() => {
      try {
        parseSource('f<T>(x);');
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(AmbiguousDialectError);
    expect((error as Error).name).toBe('AmbiguousDialectError');
  });
});

/**
 * Valid TypeScript 4.9 / 5.0 syntax used to be rejected as "not TypeScript":
 * auto-accessors need the `decoratorAutoAccessors` plugin and TC39-placement
 * decorators (`export @dec class`) need the `decorators` proposal plugin, and
 * the dialect enabled only `decorators-legacy`. The legacy plugin still parses
 * shapes the proposal rejects (`@a.b().c`), so it stays as the second attempt.
 */
describe('TypeScript decorator and accessor syntax', () => {
  it('parses auto-accessors', async () => {
    const source = 'class A { accessor x = 1; static accessor y = 2; }\nlog(new A().x);';
    const result = await deobfuscate(source, { language: 'ts', preset: 'conservative' });
    expect(result.metadata.language).toBe('ts');
    expect(result.code).toContain('accessor x = 1');
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('parses decorators in the TC39 placement after export', async () => {
    const source =
      'function dec(...a: unknown[]): any {}\n' +
      'export @dec class B { @dec m() { return 1; } }\n';
    const result = await deobfuscate(source, { language: 'ts', preset: 'conservative' });
    expect(result.code).toContain('@dec');
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('parses decorators in the legacy placement before export', async () => {
    const source = 'function dec(...a: unknown[]): any {}\n@dec export class B { @dec static s = 1; }\n';
    const result = await deobfuscate(source, { language: 'ts', preset: 'conservative' });
    expect(result.code).toContain('@dec');
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('still parses a legacy decorator expression the proposal grammar rejects', async () => {
    const source = 'declare const a: any;\n@a.b().c class B {}\n';
    const result = await deobfuscate(source, { language: 'ts', preset: 'conservative' });
    // The generator parenthesises a decorator expression the proposal grammar
    // would not accept bare, which both grammars then read.
    expect(result.code).toMatch(/@\(?a\.b\(\)\.c\)?/);
    expect(result.metadata.stats.verified).toBe(true);
  });

  it('accepts the same syntax in plain JavaScript and JSX', () => {
    expect(analyze('export @dec class B { accessor x; }').language).toBe('js');
    expect(analyze('export @dec class B { render() { return <a />; } }').language).toBe('jsx');
  });
});

/**
 * A `language` or `sourceType` outside its union used to be handed straight
 * to Babel and echoed back in metadata, so `language: 'python'` came back as
 * `metadata.language === 'python'` with `verified: true`, and `sourceType:
 * 'esm'` produced a false "output did not re-parse" error. Wrong input is a
 * `TypeError`, in the same voice `preset` has always used.
 */
describe('language, sourceType and filename are validated', () => {
  it('rejects an unknown language', async () => {
    await expect(deobfuscate('var a = 1;', { language: 'python' as never })).rejects.toThrow(
      /Unknown language "python"\. Expected one of: auto, js, jsx, ts, tsx\./,
    );
    expect(() => analyze('var a = 1;', { language: 'python' as never })).toThrow(TypeError);
  });

  it('rejects an unknown sourceType', async () => {
    await expect(
      deobfuscate('import a from "a";', { sourceType: 'esm' as never }),
    ).rejects.toThrow(/Unknown sourceType "esm"\. Expected one of: script, module, unambiguous\./);
  });

  it('rejects a filename that is not a string', async () => {
    await expect(deobfuscate('var a = 1;', { filename: 42 as never })).rejects.toThrow(
      /filename must be a string; received 42/,
    );
    expect(() => analyze('var a = 1;', { filename: 42 as never })).toThrow(TypeError);
  });

  it('rejects source that is not a string from analyze() too', () => {
    expect(() => analyze(42 as never)).toThrow(/expects the source as a string/);
  });

  it('treats null options the way deobfuscate() does', () => {
    expect(analyze('var a = 1;', null as never).language).toBe('js');
  });
});
