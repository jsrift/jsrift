import { describe, expect, it } from 'vitest';
import { restoreJsxPass } from '../src/passes/finalize/jsx.js';
import { tidyOutputPass } from '../src/passes/finalize/tidy.js';
import { assertParses, expectEquivalent, expectIdempotent, expectNoChange, runPass } from './helpers.js';

/** Every automatic-runtime fixture needs the import that makes `_jsx` real. */
const AUTO_IMPORT = 'import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";\n';

async function jsx(source: string, language: 'jsx' | 'tsx' = 'jsx'): Promise<string> {
  const { code } = await runPass(restoreJsxPass, source, { language });
  assertParses(code, language);
  return code;
}

describe('finalize.jsx - element shapes', () => {
  it('turns a host element with props and a text child into JSX', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("div", { className: "x", children: "hi" });`);
    expect(code).toContain('<div className="x">hi</div>');
  });

  it('spreads an array of children into sibling expressions', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsxs("ul", { children: [a, b] });`);
    expect(code).toContain('<ul>{a}{b}</ul>');
  });

  it('keeps a component identifier capitalised and wraps non-string props', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx(Component, { a: 1, children: c });`);
    expect(code).toContain('<Component a={1}>{c}</Component>');
  });

  it('writes a Fragment as <>...</>', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx(_Fragment, { children: x });`);
    expect(code).toContain('<>{x}</>');
  });

  it('handles the jsxDEV signature and drops its compiler-generated debug arguments', async () => {
    const source =
      'import { jsxDEV as _jsxDEV } from "react/jsx-dev-runtime";\n' +
      'const el = _jsxDEV("span", { children: "hi" }, "k1", false, { fileName: "a.jsx" }, this);';
    const code = await jsx(source);
    expect(code).toContain('<span key="k1">hi</span>');
    expect(code).not.toContain('fileName');
  });

  it('converts React.createElement on the global React object', async () => {
    const code = await jsx('const el = React.createElement("div", null, "hi");');
    expect(code).toContain('<div>hi</div>');
  });

  it('converts variadic createElement children', async () => {
    const code = await jsx('const el = React.createElement("ul", null, a, b);');
    expect(code).toContain('<ul>{a}{b}</ul>');
  });

  it('emits a self-closing tag when there are no children', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("br", {});`);
    expect(code).toContain('<br />');
  });

  it('rebuilds a member-expression tag', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx(A.B.C, { children: x });`);
    expect(code).toContain('<A.B.C>{x}</A.B.C>');
  });

  it('nests converted children inside their converted parent', async () => {
    const code = await jsx(
      `${AUTO_IMPORT}const el = _jsx("div", { children: _jsx("span", { children: "hi" }) });`,
    );
    expect(code).toContain('<div><span>hi</span></div>');
  });

  it('works in a tsx file', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el: unknown = _jsx("div", { children: "hi" });`, 'tsx');
    expect(code).toContain('<div>hi</div>');
  });
});

describe('finalize.jsx - attributes', () => {
  it('turns a spread property into a spread attribute', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("div", { ...p, id: "a" });`);
    expect(code).toContain('<div {...p} id="a" />');
  });

  it('uses boolean shorthand for `true` but not for `false`', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("input", { hidden: true, readOnly: false });`);
    expect(code).toContain('<input hidden readOnly={false} />');
  });

  it('lifts the runtime key argument into a key attribute', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("li", { children: x }, "k");`);
    expect(code).toContain('<li key="k">{x}</li>');
  });

  it('keeps ref and hyphenated and namespaced prop names', async () => {
    const code = await jsx(
      `${AUTO_IMPORT}const el = _jsx("use", { ref: r, "data-id": "7", "xlink:href": "#a" });`,
    );
    expect(code).toContain('ref={r}');
    expect(code).toContain('data-id="7"');
    expect(code).toContain('xlink:href="#a"');
  });

  it('escapes a string attribute value into an expression when JSX would reinterpret it', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("div", { title: "a & b", alt: "plain" });`);
    // `&` starts an HTML entity inside a quoted JSX attribute, so it must stay
    // an expression; the neighbouring plain value still gets the string form.
    expect(code).toContain('alt="plain"');
    expect(code).toContain('title={"a & b"}');
  });

  it('keeps an apostrophe inside a double-quoted attribute rather than escaping it', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("div", { title: "it's" });`);
    expect(code).toContain('title="it\'s"');
  });
});

describe('finalize.jsx - children', () => {
  it('keeps a null child as an explicit expression', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("div", { children: null });`);
    expect(code).toContain('<div>{null}</div>');
  });

  it('keeps text that JSX would reinterpret inside an expression container', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("p", { children: "a < b" });`);
    expect(code).not.toContain('>a < b<');
    expect(code).toContain('<p>{');
  });

  it('does not merge two adjacent string children into one text run', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsxs("p", { children: ["a", "b"] });`);
    expect(code).not.toContain('<p>ab</p>');
    expect(code).toContain('<p>{"a"}{"b"}</p>');
  });

  it('treats a one-element children array as a single array-valued child', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsx("div", { children: [x] });`);
    expect(code).toContain('<div>{[x]}</div>');
  });

  it('keeps a lone spread array as one child rather than expanding it', async () => {
    const code = await jsx(`${AUTO_IMPORT}const el = _jsxs("ul", { children: [...items] });`);
    expect(code).toContain('<ul>{[...items]}</ul>');
  });

  it('re-parses as tsx after converting a dense element', async () => {
    const source =
      `${AUTO_IMPORT}const el = _jsxs(A.B, { ...rest, "data-x": "1", hidden: true, onClick: h, ` +
      'children: [_jsx("i", { className: "c" }), "text", null] }, k);';
    const code = await jsx(source, 'tsx');
    assertParses(code, 'tsx');
    expect(code).toContain('<A.B key={k} {...rest} data-x="1" hidden onClick={h}>');
    expect(code).toContain('<i className="c" />text{null}</A.B>');
  });
});

describe('finalize.jsx - callee resolution', () => {
  it('resolves the (0, ns.jsx) namespace-call form', async () => {
    const source =
      'import * as _rt from "react/jsx-runtime";\nconst el = (0, _rt.jsx)("div", { children: "hi" });';
    const code = await jsx(source);
    expect(code).toContain('<div>hi</div>');
  });

  it('resolves a require of the runtime module', async () => {
    const source =
      'const _rt = require("react/jsx-runtime");\nconst el = _rt.jsx("div", { children: "hi" });';
    const code = await jsx(source);
    expect(code).toContain('<div>hi</div>');
  });

  it('resolves a destructured require of the runtime module', async () => {
    const source =
      'const { jsx: _j } = require("react/jsx-runtime");\nconst el = _j("div", { children: "hi" });';
    const code = await jsx(source);
    expect(code).toContain('<div>hi</div>');
  });

  it('resolves createElement imported by name from react', async () => {
    const source = 'import { createElement } from "react";\nconst el = createElement("div", null, "hi");';
    const code = await jsx(source);
    expect(code).toContain('<div>hi</div>');
  });

  it('resolves a Fragment reached through the react namespace', async () => {
    const source = 'import * as React from "react";\nconst el = React.createElement(React.Fragment, null, x);';
    const code = await jsx(source);
    expect(code).toContain('<>{x}</>');
  });
});

describe('finalize.jsx - bail-outs', () => {
  it('leaves a .ts file untouched because JSX would not re-parse there', async () => {
    const source = `${AUTO_IMPORT}const el = _jsx("div", { children: "hi" });`;
    await expectNoChange(restoreJsxPass, source, { language: 'ts' });
  });

  it('leaves a plain .js file untouched', async () => {
    const source = `${AUTO_IMPORT}const el = _jsx("div", { children: "hi" });`;
    await expectNoChange(restoreJsxPass, source, { language: 'js' });
  });

  it('ignores a local function that merely happens to be called _jsx', async () => {
    const source = 'function _jsx(type, props) { return type; }\nconst el = _jsx("div", { children: "hi" });';
    await expectNoChange(restoreJsxPass, source, { language: 'jsx' });
  });

  it('ignores an unresolved _jsx with no binding at all', async () => {
    await expectNoChange(restoreJsxPass, 'const el = _jsx("div", { children: "hi" });', {
      language: 'jsx',
    });
  });

  it('ignores React.createElement when React is a local non-react binding', async () => {
    const source = 'const React = { createElement: f };\nconst el = React.createElement("div", null, "hi");';
    await expectNoChange(restoreJsxPass, source, { language: 'jsx' });
  });

  it('refuses a computed prop name', async () => {
    await expectNoChange(restoreJsxPass, `${AUTO_IMPORT}const el = _jsx("div", { [k]: 1 });`, {
      language: 'jsx',
    });
  });

  it('refuses a lowercase identifier tag, which would become a host element', async () => {
    await expectNoChange(restoreJsxPass, `${AUTO_IMPORT}const el = _jsx(comp, { children: x });`, {
      language: 'jsx',
    });
  });

  it('refuses an uppercase string tag, which would become a component reference', async () => {
    await expectNoChange(restoreJsxPass, `${AUTO_IMPORT}const el = _jsx("Foo", { children: x });`, {
      language: 'jsx',
    });
  });

  it('refuses props that are not an object literal', async () => {
    await expectNoChange(restoreJsxPass, `${AUTO_IMPORT}const el = _jsx("div", props);`, {
      language: 'jsx',
    });
  });

  it('refuses a spread mixed into a multi-child array', async () => {
    await expectNoChange(
      restoreJsxPass,
      `${AUTO_IMPORT}const el = _jsxs("ul", { children: [a, ...items] });`,
      { language: 'jsx' },
    );
  });

  it('refuses a hole in the children array', async () => {
    await expectNoChange(restoreJsxPass, `${AUTO_IMPORT}const el = _jsxs("ul", { children: [a, , b] });`, {
      language: 'jsx',
    });
  });

  it('refuses a getter in the props object', async () => {
    await expectNoChange(
      restoreJsxPass,
      `${AUTO_IMPORT}const el = _jsx("div", { get id() { return 1; } });`,
      { language: 'jsx' },
    );
  });

  it('refuses a spread that follows the children prop', async () => {
    await expectNoChange(
      restoreJsxPass,
      `${AUTO_IMPORT}const el = _jsx("div", { children: x, ...rest });`,
      { language: 'jsx' },
    );
  });

  it('is idempotent', async () => {
    await expectIdempotent(restoreJsxPass, `${AUTO_IMPORT}const el = _jsx("div", { id: "a", children: [x, y] });`, {
      language: 'jsx',
    });
  });
});

describe('finalize.tidy', () => {
  it('collapses else { if } into else if', async () => {
    const { code } = await runPass(tidyOutputPass, 'if (a) { p(); } else { if (b) { q(); } }');
    expectEquivalent(code, 'if (a) { p(); } else if (b) { q(); }');
  });

  it('does not collapse an else block that holds more than the if', async () => {
    await expectNoChange(tidyOutputPass, 'if (a) { p(); } else { if (b) { q(); } r(); }');
  });

  it('unwraps a redundant nested block', async () => {
    const { code } = await runPass(tidyOutputPass, 'function f() { { a(); b(); } }');
    expectEquivalent(code, 'function f() { a(); b(); }');
  });

  it('keeps a block that scopes a let declaration', async () => {
    await expectNoChange(tidyOutputPass, 'function f() { { let a = 1; use(a); } }');
  });

  it('keeps a block that scopes a function declaration', async () => {
    await expectNoChange(tidyOutputPass, 'function f() { { function g() {} use(g); } }');
  });

  it('unwraps a block holding only var declarations, which are function-scoped', async () => {
    const { code } = await runPass(tidyOutputPass, 'function f() { { var a = 1; } }');
    expectEquivalent(code, 'function f() { var a = 1; }');
  });

  it('does not unwrap the body of an if statement', async () => {
    await expectNoChange(tidyOutputPass, 'if (a) { b(); }');
  });

  it('removes a trailing bare return, including a run of them', async () => {
    const { code } = await runPass(tidyOutputPass, 'function f() { a(); return; return; }');
    expectEquivalent(code, 'function f() { a(); }');
  });

  it('keeps a return that carries a value and one that is not last', async () => {
    await expectNoChange(tidyOutputPass, 'function f() { if (a) { return; } b(); return c; }');
  });

  it('inverts a negated equality', async () => {
    const { code } = await runPass(tidyOutputPass, 'const a = !(x === y), b = !(x !== y);');
    expectEquivalent(code, 'const a = x !== y, b = x === y;');
  });

  it('leaves a negated relational comparison alone because of NaN', async () => {
    await expectNoChange(tidyOutputPass, 'const a = !(x < y);');
  });

  it('drops double negation in an if test', async () => {
    const { code } = await runPass(tidyOutputPass, 'if (!!x) { a(); }');
    expectEquivalent(code, 'if (x) { a(); }');
  });

  it('drops double negation in a while test and a ternary test', async () => {
    const { code } = await runPass(tidyOutputPass, 'while (!!x) a(); const v = !!y ? 1 : 2;');
    expectEquivalent(code, 'while (x) a(); const v = y ? 1 : 2;');
  });

  it('drops double negation in a logical operand inside a condition', async () => {
    const { code } = await runPass(tidyOutputPass, 'if (a && !!x) { b(); }');
    expectEquivalent(code, 'if (a && x) { b(); }');
  });

  it('preserves double negation where the value is actually used', async () => {
    await expectNoChange(tidyOutputPass, 'const a = !!x;');
  });

  it('preserves double negation in a returned value and a call argument', async () => {
    await expectNoChange(tidyOutputPass, 'function f() { g(!!x); return !!y; }');
  });

  it('preserves double negation in a logical expression whose value is assigned', async () => {
    await expectNoChange(tidyOutputPass, 'const ok = !!x || y;');
  });

  it('preserves double negation under ?? because it distinguishes null from false', async () => {
    await expectNoChange(tidyOutputPass, 'if (!!x ?? y) { a(); }');
  });

  it('collapses a negated double negation to a single negation', async () => {
    const { code } = await runPass(tidyOutputPass, 'const a = !!!x;');
    expectEquivalent(code, 'const a = !x;');
  });

  it('simplifies a doubly-negated equality all the way down', async () => {
    const { code } = await runPass(tidyOutputPass, 'const a = !!(x === y);');
    expectEquivalent(code, 'const a = x === y;');
  });

  it('removes stray empty statements', async () => {
    const { code } = await runPass(tidyOutputPass, 'a();;;b();');
    expectEquivalent(code, 'a(); b();');
  });

  it('keeps the empty statement that is the body of a loop', async () => {
    await expectNoChange(tidyOutputPass, 'for (;;);');
  });

  it('keeps a commented statement it would otherwise delete', async () => {
    await expectNoChange(tidyOutputPass, 'function f() {\n  a();\n  // deliberate\n  return;\n}');
  });

  it('is idempotent', async () => {
    await expectIdempotent(
      tidyOutputPass,
      'function f() { { a(); } if (p) { q(); } else { if (r) { s(); } } if (!!t) { u(); } return; }',
    );
  });

  it('produces output that still parses', async () => {
    const { code } = await runPass(
      tidyOutputPass,
      'function f() { { var a = 1; } if (p) { q(); } else { if (!!r) { s(); } } return; }',
    );
    assertParses(code);
    expect(code).toContain('else if (r)');
  });
});
