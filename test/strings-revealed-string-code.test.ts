import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { DeobfuscateResult, PresetName } from '../src/types.js';

/**
 * A string the run itself puts where a construct compiles it.
 *
 * The string-code facts are computed once per fixpoint iteration, and the
 * classifier grades a timer on its argument as written: `setTimeout(dec(0),
 * 0)` is a call result, a callback as far as anything can tell, so the facts
 * for the iteration say no string code exists. The strings pass then decodes
 * `dec(0)` to `'log(dec(2))'`, and the prune that follows in the same stage
 * asked the same memoised facts, deleted `dec`, and the output threw from the
 * timer where the input printed - at every preset. Executed on the round-14
 * engine: `var A = ['log(dec(2))', 'beta', 'gamma']; function dec(i) { return
 * A[i]; } setTimeout(dec(0), 0); log(dec(1), dec(2));` came out as
 * `setTimeout('log(dec(2))', 0); log('beta', 'gamma');`, trace `beta gamma`
 * then `THROWN ReferenceError: dec is not defined` against the input's `beta
 * gamma` then `gamma`. The same through a name the timer reads, a timer in a
 * function, an `.apply` vector, and a map whose reads the fold or the inliner
 * turned into the literal that names it.
 *
 * Every rewrite that materialises a literal now refreshes the facts when the
 * literal lands where the classifier reads code (`analysis/string-code-sites.ts`),
 * and a pass that deletes a declaration once its reads are gone asks the
 * facts as they stand after its own rewrites. Each case below is executed in
 * a realm whose timers drain after the script, as an event loop's would, so
 * a string handler runs in global scope the way a browser's does.
 */

const ALL: readonly PresetName[] = ['conservative', 'balanced', 'aggressive'];

function execute(code: string): string {
  const trace: string[] = [];
  const log = (...parts: unknown[]): void => {
    trace.push(parts.map(String).join(' '));
  };
  const queued: unknown[] = [];
  const sandbox: Record<string, unknown> = {
    log,
    setTimeout: (handler: unknown) => queued.push(handler),
    setInterval: (handler: unknown) => queued.push(handler),
  };
  sandbox['globalThis'] = sandbox;
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { timeout: 5_000 });
    for (const handler of queued) {
      if (typeof handler === 'string') vm.runInContext(handler, context, { timeout: 5_000 });
      else if (typeof handler === 'function') handler();
    }
  } catch (error) {
    const err = error as Error;
    trace.push(`THROWN ${err.name}: ${err.message}`);
  }
  return trace.join(' | ');
}

function notes(result: DeobfuscateResult, source = 'strings.'): string[] {
  return result.metadata.diagnostics
    .filter((diagnostic) => diagnostic.source.startsWith(source))
    .map((diagnostic) => diagnostic.message);
}

async function expectSameTrace(source: string, preset: PresetName): Promise<DeobfuscateResult> {
  const result = await deobfuscate(source, { preset });
  const before = execute(source);
  const after = execute(result.code);
  if (after !== before) {
    throw new Error(
      `Behaviour changed at ${preset}.\n--- input ---\n${before}\n--- output ---\n${after}\n--- code ---\n${result.code}`,
    );
  }
  return result;
}

const TABLE = `var A = ['log(dec(2))', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\n`;

describe('a decoded value that is a timer program keeps the machinery it names', () => {
  it.each([
    ['handed to the timer', `setTimeout(dec(0), 0);`],
    ['read by the timer through a name', `var s = dec(0);\nsetTimeout(s, 0);`],
    ['read through two names', `var s = dec(0);\nvar u = s;\nsetTimeout(u, 0);`],
    ['stored by assignment', `var s;\ns = dec(0);\nsetTimeout(s, 0);`],
    ['handed to a timer inside a function', `function later() { setTimeout(dec(0), 0); }\nlater();`],
    ['handed through an .apply vector', `setTimeout.apply(null, [dec(0), 0]);`],
    ['handed to setInterval', `setInterval(dec(0), 0);`],
    ['handed to globalThis.setTimeout', `globalThis.setTimeout(dec(0), 0);`],
    ['an arm of a conditional', `setTimeout(A.length > 5 ? function () {} : dec(0), 0);`],
  ])('%s', async (_name, timer) => {
    const source = `${TABLE}${timer}\nlog(dec(1), dec(2));\n`;
    expect(execute(source)).toBe('beta gamma | gamma');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      // The sites the timer does not reach are still decoded; what stays is
      // the machinery, and the report says so.
      expect(result.code).toContain("log('beta', 'gamma')");
      expect(result.code).toContain('function dec');
      expect(result.code).toContain("'log(dec(2))'");
      expect(notes(result).some((m) => m.startsWith('Kept the string-array machinery'))).toBe(true);
      expect(notes(result).some((m) => m.startsWith('Removed'))).toBe(false);
    }
  });

  it('is asked of the decoded text, not of the position: a timer program that names nothing lets the machinery go', async () => {
    // The control that keeps this from reading as "a timer freezes the
    // table". The literal is a program, the facts are refreshed for it, and
    // what it spells - `log` - is no binding of this file, so the prune
    // proceeds exactly as it would have without the timer.
    const source = `var A = ['log(1)', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nsetTimeout(dec(0), 0);\nlog(dec(1), dec(2));\n`;
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).not.toContain('function dec');
      expect(result.code).toContain("setTimeout('log(1)', 0)");
      expect(notes(result).some((m) => m.startsWith('Removed 2 declaration'))).toBe(true);
    }
  });

  it('a timer program that names a neighbour of the machinery keeps the machinery too', async () => {
    // The whole-scope question `stringCodeAddressable` asks of program-scope
    // machinery - can the source name ANY binding declared beside it - and
    // its cost, stated: the string spells only `helper`, and `dec` stays for
    // it, with the sites the timer does not reach inlined all the same. The
    // question is asked that way because the links from a site to the table
    // are found as the sites are met, so the names a source would have to be
    // checked against are not known when it is asked; see the note above
    // that function.
    const source = `var A = ['log(helper())', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nfunction helper() { return 'H'; }\nsetTimeout(dec(0), 0);\nlog(dec(1), dec(2));\n`;
    expect(execute(source)).toBe('beta gamma | H');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).toContain("log('beta', 'gamma')");
      expect(result.code).toContain('function helper');
      expect(result.code).toContain('function dec');
      expect(notes(result).some((m) => m.startsWith('Kept the string-array machinery'))).toBe(true);
    }
  });
});

describe('a map whose reads became the literal that names it', () => {
  it('decoded by the inliner: the map stays at the presets that inline maps', async () => {
    const source = `var A = ['log(o.k)', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nvar o = { k: 'v', j: 'w' };\nsetTimeout(dec(0), 0);\nlog(o.k, o.j, dec(1), dec(2));\n`;
    expect(execute(source)).toBe('v w beta gamma | v');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).toContain("k: 'v'");
      expect(result.code).toContain("setTimeout('log(o.k)', 0)");
    }
  });

  it('folded by fold-constants in the same stage: the map stays', async () => {
    // `['log(o.k)'].join('')` is a call result until the fold and a program
    // after it; `simplify.object-maps` runs after the fold in the same stage
    // and used to delete `o` on facts taken before the fold.
    const source = `var o = { k: 'v', j: 'w' };\nsetTimeout(['log(o.k)'].join(''), 0);\nlog(o.k, o.j);\n`;
    expect(execute(source)).toBe('v w | v');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).toContain("k: 'v'");
    }
  });

  it('a map read whose value is the program that names the map', async () => {
    const source = `var o = { k: 'log(o.j)', j: 'w' };\nsetTimeout(o.k, 0);\nlog(o.j);\n`;
    expect(execute(source)).toBe('w | w');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).toContain("j: 'w'");
    }
  });

  it("a computed ['eval'] that simplify.properties spells out in the same stage", async () => {
    // `g['eval'](src)` is classified by nothing - the key is a string, not a
    // name - and `g.eval(src)` by the indirect-eval rule. The property pass
    // makes that rewrite in the merged traversal ahead of the map pass, which
    // then deleted `o` on facts taken before it.
    const source = `var o = { k: 'v', j: 'w' };\nglobalThis['eval']('log(o.k)');\nlog(o.k, o.j);\n`;
    expect(execute(source)).toBe('v | v w');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).toContain("k: 'v'");
    }
  });
});

describe('a source the classifier could not read until after the prune', () => {
  it('is an error in the report, naming the deleted machinery', async () => {
    // `['log(dec(2))'].join('')` is folded to a literal by `simplify.fold-
    // constants`, one stage after `strings.prune-decoders` deleted `dec` on
    // the strength of a timer whose argument was a call result. Nothing can
    // put the declaration back; what the run can do is refuse to end with
    // `Removed 2 declaration(s)` as its last word on a table the output still
    // needs. The trace is pinned as the cost: when the classifier reads a
    // call result that yields a string, this case keeps the machinery, the
    // pin fails, and the pin goes.
    const source = `var A = ['alpha', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nsetTimeout(['log(dec(2))'].join(''), 0);\nlog(dec(0), dec(1));\n`;
    expect(execute(source)).toBe('alpha beta | gamma');
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset });
      expect(execute(result.code)).toBe('alpha beta | THROWN ReferenceError: dec is not defined');
      const errors = result.metadata.diagnostics.filter(
        (d) => d.source === 'strings.prune-decoders' && d.severity === 'error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/^Code compiled from a string spells dec, and this run deleted the declaration/);
      expect(errors[0]!.message).toContain('strings.prune-decoders disabled keeps it');
    }
  });

  it('names every deleted name the source spells, once, in one line', async () => {
    // Both the table and the decoder are spelled, and both went; one line
    // says so, and a second round meeting the same source says nothing more.
    const source = `var A = ['alpha', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nsetTimeout(['log(A.length, dec(2))'].join(''), 0);\nlog(dec(0), dec(1));\n`;
    const result = await deobfuscate(source, { preset: 'balanced' });
    expect(result.metadata.stats.iterations).toBeGreaterThan(1);
    const errors = result.metadata.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/^Code compiled from a string spells A, dec, and/);
  });

  it('is silent for a source that spells none of what went', async () => {
    const source = `var A = ['alpha', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nsetTimeout(['log(1)'].join(''), 0);\nlog(dec(0), dec(1));\n`;
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).not.toContain('function dec');
      expect(result.metadata.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    }
  });
});

describe('the audit asks only of names global code could reach', () => {
  // `spells` is a test on the NAME, with no scope in the question. The audit
  // used to ask it of every name the prune deleted, and machinery inside a
  // function - which code compiled in global scope has no path to - was
  // deleted correctly and then reported as throwing, an error-severity line
  // on an output that runs identically (chk15/extra/x1..x10). What is
  // recorded at removal is only the names the deletion took from PROGRAM
  // scope, and the audit asks the binding question of that scope.
  const NESTED = `var A = ['alpha', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nlog(dec(0), dec(1));\n`;

  it.each([
    ['inside an IIFE', `(function () {\n${NESTED}})();\nsetTimeout('log(typeof dec, typeof A)', 0);\n`],
    ['inside a function', `function main() {\n${NESTED}}\nmain();\nsetTimeout('log(typeof dec, typeof A)', 0);\n`],
  ])('machinery %s that a global timer string spells is deleted, with no error line', async (_name, source) => {
    expect(execute(source)).toBe('alpha beta | undefined undefined');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).not.toContain('function dec');
      expect(notes(result).some((m) => m.startsWith('Removed 2 declaration'))).toBe(true);
      expect(result.metadata.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    }
  });

  it('a forwarder inside a function is not a deletion of the program-scope name it shares', async () => {
    // `var d = dec` in `main` goes with the machinery; the `d` the timer
    // reads is the program's own, and it is still there.
    const source = `function main() {\n  var A = ['alpha', 'beta', 'gamma'];\n  function dec(i) { return A[i]; }\n  var d = dec;\n  log(d(0), d(1));\n}\nmain();\nvar d = 42;\nsetTimeout('log(d)', 0);\n`;
    expect(execute(source)).toBe('alpha beta | 42');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).not.toContain('function dec');
      expect(result.code).toContain('var d = 42');
      expect(result.metadata.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    }
  });

  it('a module top level is out of global reach: deleted, with no error line', async () => {
    // A module's top-level bindings are in a module environment record that
    // global code has no path to (measured in `analysis/string-code.ts`), so
    // the timer's `dec` is a ReferenceError in the input and in the output
    // alike - the IIFE case above, executed, is this one's trace. The
    // deletion is right and the audit has nothing to say about it.
    const source = `var A = ['alpha', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nsetTimeout(['log(dec(2))'].join(''), 0);\nlog(dec(0), dec(1));\nexport {};\n`;
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset, sourceType: 'module' });
      expect(result.code).not.toContain('function dec');
      expect(result.code).toContain("setTimeout('log(dec(2))', 0)");
      expect(result.metadata.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    }
  });

  it('a sloppy block-level decoder at the top of a script is in reach through its Annex B var', async () => {
    // Babel lists `dec` in the block's scope; B.3.3 makes it a var of the
    // script too, which the timer reaches by name. The error line stays for
    // the deletion the prune made here, whatever scope the binding is in.
    const source = `{\n  var A = ['alpha', 'beta', 'gamma'];\n  function dec(i) { return A[i]; }\n  log(dec(0), dec(1));\n}\nsetTimeout(['log(dec(2))'].join(''), 0);\n`;
    expect(execute(source)).toBe('alpha beta | gamma');
    for (const preset of ALL) {
      const result = await deobfuscate(source, { preset });
      if (result.code.includes('function dec')) continue;
      const errors = result.metadata.diagnostics.filter(
        (d) => d.source === 'strings.prune-decoders' && d.severity === 'error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/^Code compiled from a string spells dec, and/);
    }
  });

  it('a source the analysis cannot read says the output may throw, not that it does', async () => {
    // `globalThis['eval'](dec(0))` is classified by nothing while the key is
    // a string; the prune goes ahead, `simplify.properties` spells the key
    // out, and the next round's facts are the blunt "every name" answer with
    // `eval` used as a value to blame. The source here spells nothing that
    // went and the output runs as the input did; the analysis cannot see
    // that, and the line must not claim more than it knows.
    const source = `var A = ['log(1)', 'beta', 'gamma'];\nfunction dec(i) { return A[i]; }\nglobalThis['eval'](dec(0));\nlog(dec(1), dec(2));\n`;
    expect(execute(source)).toBe('1 | beta gamma');
    for (const preset of ALL) {
      const result = await expectSameTrace(source, preset);
      expect(result.code).not.toContain('function dec');
      const errors = result.metadata.diagnostics.filter(
        (d) => d.source === 'strings.prune-decoders' && d.severity === 'error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/^Code compiled from a string may reach A, dec by name - the source is `eval` used as a value/);
      expect(errors[0]!.message).toContain('The output may throw where the input ran');
      expect(errors[0]!.message).not.toContain('The output throws');
    }
  });
});
