import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A `.name` read through `await`. An async function's result is a promise,
 * which has no `.name` of ours and holds nothing iterable - until it is
 * awaited, when it is what the function returns: `(await _0xp()).name`
 * printed `val1` for `_0x96d6` at aggressive with no warning, and so did
 * the result held by a binding, iterated with `for await`, or taken apart
 * by a pattern. The await is looked through wherever a call result is
 * followed, and what the walk does not follow past it - a property of the
 * result, a method's result - is disclosed exactly as it is without it.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print once the microtasks have run.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

const WARNING = /not followed/;

async function observe(code: string): Promise<string[]> {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  // An async function's body past its first `await` runs from the microtask queue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return logs;
}

async function run(source: string, options: DeobfuscateOptions) {
  const { code, ctx } = await runPass(pass, source, options);
  const warned = ctx.diagnostics.filter((note) => WARNING.test(note.message)).length;
  return { code, renames: ctx.renames.map((entry) => entry.from), warned, printed: await observe(code) };
}

async function expectPreserved(source: string, expected: string[]): Promise<string> {
  expect(await observe(source)).toEqual(expected);
  let aggressive = '';
  for (const options of PRESETS) {
    const result = await run(source, options);
    expect(result.printed, options.preset).toEqual(expected);
    expect(result.warned, `${options.preset} warned`).toBe(0);
    if (options.preset === 'aggressive') aggressive = result.code;
  }
  return aggressive;
}

async function expectDisclosed(source: string, expected: string[], renamed: string): Promise<void> {
  expect(await observe(source)).toEqual(expected);
  for (const options of PRESETS) {
    const result = await run(source, options);
    if (options.preset === 'aggressive') {
      expect(result.renames, 'aggressive').toContain(renamed);
      expect(result.printed, 'aggressive').not.toEqual(expected);
      expect(result.warned, 'aggressive warned').toBe(1);
    } else {
      expect(result.printed, options.preset).toEqual(expected);
      expect(result.warned, `${options.preset} warned`).toBe(0);
    }
  }
}

const ASYNC = `var _0xp = async function () { return function _0x96d6() {}; };`;

describe('a .name read through await of a call result', () => {
  it('read outright, held by a binding, of a declared or arrow async function, of a sync call', async () => {
    for (const source of [
      `${ASYNC} (async () => { log((await _0xp()).name); })();`,
      `${ASYNC} (async () => { var w = await _0xp(); log(w.name); })();`,
      `async function _0xp() { return function _0x96d6() {}; } (async () => { log((await _0xp()).name); })();`,
      `var _0xp = async () => function _0x96d6() {}; (async () => { log((await _0xp()).name); })();`,
      `var _0xp = function () { return function _0x96d6() {}; }; (async () => { log((await _0xp()).name); })();`,
    ]) {
      // Before: aggressive printed `val1` with no warning.
      const code = await expectPreserved(source, ['_0x96d6']);
      expect(code, source).toContain('function _0x96d6');
    }
  });

  it('iterated with for await, and a sync iterable an async function returns', async () => {
    let code = await expectPreserved(
      `async function* _0xg() { yield function _0x96d6() {}; } (async () => { for await (const v of _0xg()) log(v.name); })();`,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
    code = await expectPreserved(
      `async function _0xg() { return [function _0x96d6() {}]; } (async () => { for await (const v of await _0xg()) log(v.name); })();`,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('the inliner’s shape: a parameter called and awaited', async () => {
    const code = await expectPreserved(
      `
        var o = {};
        o.m = async function (v) { return 'fn:' + (await v()).name; };
        o.m(async function () { return function _0x96d6() {}; }).then(log);
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('a builtin’s promise settles to what it was handed', async () => {
    const code = await expectPreserved(
      `
        var _0xh = function _0x96d6() {};
        (async () => { const [v] = await Promise.all([_0xh]); log(v.name); })();
      `,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('a promise that is not awaited has no .name of ours', async () => {
    const code = await expectPreserved(`${ASYNC} log(typeof _0xp().name);`, ['undefined']);
    expect(code).not.toContain('_0x96d6');
  });
});

describe('what the walk does not follow past an await is disclosed as it is without one', () => {
  it('a property of the settled value', async () => {
    const MAKE = `var _0xp = async function () { return { k: function _0x96d6() {} }; };`;
    await expectDisclosed(`${MAKE} (async () => { const r = await _0xp(); log(r.k.name); })();`, ['_0x96d6'], '_0x96d6');
    await expectDisclosed(`${MAKE} (async () => { const { k } = await _0xp(); log(k.name); })();`, ['_0x96d6'], '_0x96d6');
  });

  it('the settled result of a method of a local object', async () => {
    await expectDisclosed(
      `
        (function () {
          var _0xh = function () {};
          var o = { async get() { return _0xh; } };
          (async () => { log((await o.get()).name); })();
        })();
      `,
      ['_0xh'],
      '_0xh',
    );
  });
});

describe('a .name read through a Promise combinator with a call among its elements', () => {
  // `Promise.all([_0xp()])` settles to what each element settles to, and
  // the call of an async function of this file's is what it returns -
  // read there only under the `await`. Each printed `val1` at aggressive
  // with no word said: the element was a call, and a call's promise had
  // no `.name` of ours.
  const HELD = `var _0xh = function _0x96d6() {}; async function _0xp() { return _0xh; }`;
  const reads: string[] = [
    `(async () => { const [a] = await Promise.all([_0xp()]); log(a.name); })();`,
    `(async () => { log((await Promise.all([_0xp()]))[0].name); })();`,
    `(async () => { const r = await Promise.all([_0xp()]); log(r[0].name); })();`,
    `Promise.all([_0xp()]).then(([a]) => log(a.name));`,
    `(async () => { const a = await Promise.race([_0xp()]); log(a.name); })();`,
    `(async () => { const a = await Promise.any([_0xp()]); log(a.name); })();`,
    `(async () => { const [r] = await Promise.allSettled([_0xp()]); log(r.value.name); })();`,
    `(async () => { const [a] = await Promise.all([_0xh]); log(a.name); })();`,
    `(async () => { let r; r = await Promise.all([_0xp()]); const [a] = r; log(a.name); })();`,
    `(async () => { for (const a of await Promise.all([_0xp()])) log(a.name); })();`,
    `(async () => { log((await Promise.all([_0xp()])).map((a) => a.name)[0]); })();`,
    `(async () => { const [a] = await Promise.all([Promise.resolve(_0xp())]); log(a.name); })();`,
    `Promise.all([_0xp()]).then((r) => r[0]).then((a) => log(a.name));`,
    `(async () => { const [a] = await (0, Promise.all([_0xp()])); log(a.name); })();`,
    `var c = true; (async () => { const r = await (c ? Promise.all([_0xp()]) : Promise.race([_0xp()])); log((c ? r[0] : r).name); })();`,
    `(async () => { let ps; ps = [_0xp()]; const [a] = await Promise.all(ps); log(a.name); })();`,
    `(async () => { const ps = [_0xp()]; const [a] = await Promise.all([...ps]); log(a.name); })();`,
    `(async () => { const [a] = await Promise.all.call(Promise, [_0xp()]); log(a.name); })();`,
    `function _0xs() { return _0xh; } (async () => { const [a] = await Promise.all([_0xs()]); log(a.name); })();`,
    `async function _0xq() { return _0xh; } (async () => { const a = await Promise.race([_0xp(), _0xq()]); log(a.name); })();`,
    `const read = async () => (await Promise.all([_0xp()]))[0].name; read().then(log);`,
  ];
  for (const read of reads) {
    it(read, async () => {
      const code = await expectPreserved(`${HELD}\n${read}`, ['_0x96d6']);
      expect(code).toContain('function _0x96d6');
    });
  }

  it('a second selection past the combinator is followed', async () => {
    // Before: disclosed, one selection off a builtin's result being all
    // the walk modelled. `[[a]]` takes the element of what the async
    // function returned out of what the combinator settles to.
    const code = await expectPreserved(
      `${HELD}\nasync function _0xr() { return [_0xh]; }\n(async () => { const [[a]] = await Promise.all([_0xr()]); log(a.name); })();`,
      ['_0x96d6'],
    );
    expect(code).toContain('_0x96d6');
  });
});
