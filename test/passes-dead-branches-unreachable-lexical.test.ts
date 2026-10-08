import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import { removeDeadBranchesPass } from '../src/passes/clean/dead-branches.js';
import { removeInjectedCodePass } from '../src/passes/clean/injected-code.js';
import { runPass } from './helpers.js';

/**
 * A lexical declaration after a terminator is unreachable and still binds.
 *
 * `pruneUnreachable` kept function declarations past a `return` because
 * hoisting makes them reachable, and deleted everything else - a `let`,
 * `const` or `class` included. Those bind their name for the whole block and
 * throw on a read made before the declaration, so `let x = 1; function h() {
 * log(x); return; let x = 2; }` is a program that throws, and with the inner
 * declaration deleted it printed `1`: a rewrite that parses and runs. The
 * declaration now stays where it was written, unevaluated as before; only the
 * statements around it go.
 */

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

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

describe('an unreachable lexical declaration keeps its dead zone', () => {
  const cases: [string, string, string][] = [
    ['let', `let x = 1; function h(){ log(x); return; let x = 2; } h();`, 'THROWN ReferenceError'],
    ['const', `let x = 1; function h(){ log(x); return; const x = 2; } h();`, 'THROWN ReferenceError'],
    ['class', `let x = 1; function h(){ log(x); return; class x {} } h();`, 'THROWN ReferenceError'],
    [
      'let, with the throw caught and a removable statement beside it',
      `let x = 1; function h(){ try { log(x); } catch (e) { log(e.name); } return; log('dead'); let x = 2; log('dead'); } h();`,
      'ReferenceError',
    ],
    [
      'let in a switch case after a break',
      `let x = 1; function h(){ switch (1) { case 1: try { log(x); } catch (e) { log(e.name); } break; case 2: let x = 2; log(x); } } h();`,
      'ReferenceError',
    ],
  ];

  for (const [label, source, expected] of cases) {
    it(`keeps a ${label}`, async () => {
      expect(execute(source)).toBe(expected);
      for (const preset of PRESETS) {
        const { code } = await deobfuscate(source, { preset });
        expect(execute(code), `${preset}\n${code}`).toBe(expected);
      }
    });
  }

  it('clean.injected-code keeps a constant switch whose dropped case declares a lexical name', async () => {
    // The cases share one scope, so the declaration binds for the kept case
    // too, and the fold has no block to keep it in.
    const source = `let x = 1; function h(){ switch ('a') { case 'a': try { log(x); } catch (e) { log(e.name); } break; case 'b': let x = 2; log(x); } } h();`;
    expect(execute(source)).toBe('ReferenceError');
    const { code } = await runPass(removeInjectedCodePass, source);
    expect(execute(code)).toBe('ReferenceError');
    expect(code).toContain('switch');
    // A dropped case with only a `var` still folds, the var reconstructed.
    const plain = `function h(){ switch ('a') { case 'a': log(typeof v); break; case 'b': var v = 2; log(v); } } h();`;
    expect(execute(plain)).toBe('undefined');
    const folded = await runPass(removeInjectedCodePass, plain);
    expect(execute(folded.code)).toBe('undefined');
    expect(folded.code).not.toContain('switch');
  });

  it('clean.dead-branches removes the statements around the declaration and nothing else', async () => {
    const source = `function h(){ log(x); return; log('dead'); let x = 2; log('dead'); var v = 3; } h();`;
    const { code } = await runPass(removeDeadBranchesPass, source);
    expect(execute(code)).toBe(execute(source));
    expect(code).not.toContain("log('dead')");
    expect(code).toContain('let x = 2;');
    expect(code).toContain('var v;');
  });
});
