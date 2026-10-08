import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { analyzeDispatcher } from '../src/analysis/dispatcher.js';
import type { StringCodeFacts } from '../src/analysis/string-code.js';
import { deobfuscate } from '../src/index.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { normalize, runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * What `analysis/dispatcher.ts` proves, and the one way a program can make every
 * one of those proofs describe a different program.
 *
 * Each gate in that file is a reading of a Babel binding: the counter is written
 * only by `state++`, the array is written once and read once, the name the
 * aggressive arms follow is `constant`. All of that is assembled from the
 * references Babel can SEE. A direct `eval` names a binding in source it compiles
 * at run time, and `Function(src)` does the same to anything in program scope -
 * neither leaves a reference or a constant violation behind, so both are
 * invisible to every list those proofs are built from.
 *
 * The four cases below all recovered a machine the program never runs, at stock
 * presets, before the string-code fact was consulted here. They are executed in
 * a fresh realm before and after, because each of the wrong outputs parses and
 * runs - it just prints the dispatch order backwards.
 */

/** Execute in a fresh realm; the *kind* of failure is part of the trace. */
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

async function expectSameBehaviour(
  source: string,
  options: Parameters<typeof runPass>[2] = {},
): Promise<string> {
  const before = execute(source);
  const { code } = await runPass(unflattenControlFlowPass, source, options);
  const after = execute(code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${code}`,
    );
  }
  return code;
}

/** `case '0'` logs 'a' and `case '1'` logs 'b', so the trace names the order. */
function machine(orderInit: string, injected: string): string {
  return `var order = ${orderInit}, state = 0;
    ${injected}
    while (true) {
      switch (order[state++]) {
        case '0': log('a'); continue;
        case '1': log('b'); continue;
      }
      break;
    }`;
}

// ---------------------------------------------------------------------------
// The dispatcher's own two bindings
// ---------------------------------------------------------------------------

describe('a dispatcher whose own bindings string code can address is refused', () => {
  const evalWritesOrder = `function f() {
  ${machine(`['1', '0']`, `eval('order = ["0","1"]');`)}
}
f();`;

  it('refuses when a direct eval writes the order array', async () => {
    // Nothing aggressive here and nothing exotic: the declaration is a plain
    // array literal, and `order` still reads as written-once and read-once
    // because the write is inside a string. Recovered from the literal, the
    // machine printed `b | a` for a program that prints `a | b` - and the
    // declaration was deleted, leaving the `eval` writing a global nothing reads.
    expect(execute(evalWritesOrder)).toBe('a | b');
    const code = await expectSameBehaviour(evalWritesOrder, { preset: 'balanced' });
    expect(code).toContain('switch');
  });

  it('refuses when a direct eval writes the state counter', async () => {
    // `state = 1` skips the first block. The counter's proof - written only by
    // `state++`, read only there - is the same kind of reading of the same kind
    // of list.
    const source = `function f() {
  ${machine(`['1', '0']`, `eval('state = 1');`)}
}
f();`;
    expect(execute(source)).toBe('a');
    const code = await expectSameBehaviour(source, { preset: 'balanced' });
    expect(code).toContain('switch');
  });

  it('says which hazard it is, rather than refusing silently', async () => {
    const { ctx } = await runPass(unflattenControlFlowPass, evalWritesOrder, {
      preset: 'balanced',
    });
    expect(ctx.diagnostics.map((d) => d.message).join('\n')).toContain('a direct eval can address');
  });

  it('refuses a program-scope dispatcher when a direct eval anywhere can see program scope', async () => {
    // The asymmetry that makes the fact worth consulting rather than guessing:
    // an `eval` inside a function cannot name another function's locals, but its
    // scope chain runs up through program scope, so a top-level `order` is
    // squarely in its reach. The refusal below and the acceptance in the next
    // test are the same rule read in both directions.
    const source = `function elsewhere(src) { return eval(src); }
${machine(`['1', '0']`, '')}`;
    const code = await expectSameBehaviour(source, { preset: 'balanced' });
    expect(code).toContain('switch');
  });

  it('refuses a program-scope dispatcher that global-scope string code can write', async () => {
    // `Function(src)` compiles in global scope, where it cannot see a local -
    // but a program-scope `var` in a script IS a property of the global object,
    // so this write lands on exactly the storage the loop reads. Which
    // program-scope NAMES such a source can spell is
    // `analysis/string-code.ts`'s question and is answered there; what this
    // pins is that the answer reaches this analysis and stops it.
    const source = `${machine(`['1', '0']`, `Function('order = ["0","1"]')();`)}`;
    expect(execute(source)).toBe('a | b');
    const code = await expectSameBehaviour(source, { preset: 'balanced' });
    expect(code).toContain('switch');
  });

  it('control: an eval that cannot see the dispatcher does not refuse it', async () => {
    // The fact is scope-precise, not file-wide: an `eval` in an unrelated
    // function has no way to name a binding declared in this one, and a
    // whole-file answer would give up every dispatcher in a file that contains
    // one `eval` anywhere.
    const source = `function elsewhere(src) { return eval(src); }
function f() {
  ${machine(`['1', '0']`, '')}
}
f();`;
    const code = await expectSameBehaviour(source, { preset: 'balanced' });
    expect(code).not.toContain('switch');
    expect(normalize(code)).toContain("log('b');log('a');");
  });

});

// ---------------------------------------------------------------------------
// The aggressive arms, which follow a "constant" binding
// ---------------------------------------------------------------------------

describe('the aggressive arms refuse a name string code can write', () => {
  it('refuses a constant initialiser a direct eval reassigns', async () => {
    // `binding.constant` is true - Babel records no write, because the only one
    // is inside a string. Following it to `['1','0']` recovered the order of a
    // machine the program never runs.
    const source = `function f() {
  var src = ['1', '0'];
  eval('src = ["0","1"]');
  ${machine('src', '')}
}
f();`;
    expect(execute(source)).toBe('a | b');
    const code = await expectSameBehaviour(source, { preset: 'aggressive' });
    expect(code).toContain('switch');
  });

  it('refuses an alias map a direct eval replaces', async () => {
    // `constantMapEntry` proves three things about the object and every one of
    // them is a reading of the same reference list.
    const source = `function f() {
  var m = { k: '1|0' };
  eval('m = { k: "0|1" }');
  ${machine(`m.k.split('|')`, '')}
}
f();`;
    expect(execute(source)).toBe('a | b');
    const code = await expectSameBehaviour(source, { preset: 'aggressive' });
    expect(code).toContain('switch');
  });

  it('control: both shapes are still recovered with the eval removed', async () => {
    const byName = `function f() {
  var src = ['1', '0'];
  ${machine('src', '')}
}
f();`;
    const byMap = `function f() {
  var m = { k: '1|0' };
  ${machine(`m.k.split('|')`, '')}
}
f();`;
    for (const source of [byName, byMap]) {
      const code = await expectSameBehaviour(source, { preset: 'aggressive' });
      expect(code).not.toContain('switch');
      expect(normalize(code)).toContain("log('b');log('a');");
    }
  });
});

// ---------------------------------------------------------------------------
// The fact as an argument: what each answer makes the analysis do
// ---------------------------------------------------------------------------

/** Every reason `analyzeDispatcher` gives for one `while` loop in `source`. */
function reasonsFor(source: string, options: Parameters<typeof analyzeDispatcher>[1]): string[] {
  const ast = parse(source, { sourceType: 'script' });
  const reasons: string[] = [];
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
    },
    WhileStatement(path) {
      const result = analyzeDispatcher(path, options);
      reasons.push(result.kind === 'dispatcher' ? 'dispatcher' : result.reason);
    },
  });
  return reasons;
}

/** A program-scope dispatcher, so the global-scope arm has something to reach. */
const TOP_LEVEL = `var order = ['1', '0'], state = 0;
while (true) {
  switch (order[state++]) {
    case '0': log('a'); continue;
    case '1': log('b'); continue;
  }
  break;
}`;

/**
 * A facts object carrying only the two questions this analysis asks.
 *
 * `StringCodeFacts` is a wider interface than `analyzeDispatcher` uses - the
 * flags on it are there for callers that report - so the stub answers `reaches`
 * and `addresses` and is cast rather than filled in. Filling it in would couple
 * these cases to fields this analysis never reads, and would break them every
 * time the module they belong to grows one.
 */
function facts(answer: { reaches: boolean; addresses: boolean }): StringCodeFacts {
  return {
    reaches: () => answer.reaches,
    addresses: () => answer.addresses,
  } as unknown as StringCodeFacts;
}

/** What a program with no string code in it at all answers. */
const NO_STRING_CODE = facts({ reaches: false, addresses: false });

describe('analyzeDispatcher and the facts it is handed', () => {
  it('refuses, because a caller that cannot say has established nothing', () => {
    // The option is not a configuration knob and its absence is not "no string
    // code": it is a caller that did not ask. The other default would make a
    // forgotten argument a silent miscompile, and this one makes it a visible
    // refusal - every test in this file fails loudly if the pass stops threading
    // the fact through.
    const source = `function f() {
  var order = ['1', '0'], state = 0;
  while (true) {
    switch (order[state++]) {
      case '0': log('a'); continue;
      case '1': log('b'); continue;
    }
    break;
  }
}`;
    expect(reasonsFor(source, { maxStates: 64, aggressive: true })).toEqual([
      'string code was not ruled out for the order array or the state counter',
    ]);
  });

  it('control: the same loop is a dispatcher once the facts say so', () => {
    const source = `function f() {
  var order = ['1', '0'], state = 0;
  while (true) {
    switch (order[state++]) {
      case '0': log('a'); continue;
      case '1': log('b'); continue;
    }
    break;
  }
}`;
    expect(
      reasonsFor(source, { maxStates: 64, aggressive: true, stringCode: NO_STRING_CODE }),
    ).toEqual(['dispatcher']);
  });

  it('refuses on the global-scope hazard, and names that one rather than an eval', () => {
    // `Function(src)` and indirect `eval` compile in global scope, where a
    // program-scope `var` in a script is a property of the global object and can
    // be written by name. Asked of the fact rather than of a whole program,
    // because which program-scope NAMES a global source can spell is
    // `analysis/string-code.ts`'s question and is tested there; what belongs
    // here is that this analysis refuses on the answer and says which hazard it
    // was.
    // No scope is REACHED - that is the direct-`eval` question - and the
    // program-scope binding is nonetheless ADDRESSED, which is what a readable
    // `Function(src)` naming it looks like.
    const globalOnly = facts({ reaches: false, addresses: true });
    expect(
      reasonsFor(TOP_LEVEL, { maxStates: 64, aggressive: true, stringCode: globalOnly }),
    ).toEqual(['string code compiled in global scope can address the order array or the state counter by name']);
  });

  it('control: the same program-scope machine is recovered when nothing can reach it', () => {
    expect(
      reasonsFor(TOP_LEVEL, { maxStates: 64, aggressive: true, stringCode: NO_STRING_CODE }),
    ).toEqual(['dispatcher']);
  });
});

// ---------------------------------------------------------------------------
// The pipeline, end to end
// ---------------------------------------------------------------------------

describe('the whole engine on the same programs', () => {
  it('preserves behaviour at every preset', async () => {
    const source = `function f() {
  var src = ['1', '0'];
  eval('src = ["0","1"]');
  ${machine('src', '')}
}
f();`;
    const before = execute(source);
    expect(before).toBe('a | b');
    for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
      const { code } = await deobfuscate(source, { preset });
      expect(execute(code), `preset ${preset}`).toBe(before);
    }
  });
});
