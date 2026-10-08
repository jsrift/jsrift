import _traverse from '@babel/traverse';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSource } from '../src/frontend/language.js';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import { foldNumbersPass } from '../src/passes/prepare/fold-numbers.js';
import { discoverStringsPass } from '../src/passes/strings/discover.js';
import { unflattenControlFlowPass } from '../src/passes/structure/control-flow.js';
import { runPass } from './helpers.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * A program-scope crawl is O(references²) per binding in Babel - its
 * `Binding.reference` checks `referencePaths.includes` before every push - so
 * one name read 100k times costs about five seconds per crawl, and the run
 * used to take three to six of them, most in passes that then changed
 * nothing. `PassContext.crawlProgramScope` rebuilds the tables only when
 * `totalChanges` moved since the last build; the kernel's stage-skip already
 * rests on that counter, and this is the same contract read one level down.
 */

type Crawlable = { crawl(): void; path: { isProgram(): boolean } };

/**
 * Count crawls of PROGRAM scope only. Every nested scope crawls itself once
 * when Babel first builds it, and those are not the cost in question; the
 * prototype is taken from a live path so the package's CJS/ESM shape does not
 * matter.
 */
function countProgramCrawls(): { calls: number } {
  const { ast } = parseSource('var a = 1;', {});
  let prototype: Crawlable | undefined;
  traverse(ast, {
    Program(path) {
      prototype = Object.getPrototypeOf(path.scope) as Crawlable;
      path.stop();
    },
  });
  const original = prototype!.crawl;
  const counter = { calls: 0 };
  vi.spyOn(prototype!, 'crawl').mockImplementation(function (this: Crawlable) {
    if (this.path.isProgram()) counter.calls++;
    return original.call(this);
  });
  return counter;
}

/** Many direct references to one binding, with nothing for any pass to do. */
function wideReads(count: number): string {
  const lines = ['var x = 1; var s = 0;'];
  for (let i = 0; i < count; i++) lines.push('s += x;');
  lines.push('log(s);');
  return lines.join('\n');
}

describe('program scope is crawled at most once per tree state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clean.unused takes no crawl of its own on a tree nothing changed', async () => {
    const crawls = countProgramCrawls();
    const { changes } = await runPass(removeUnusedPass, wideReads(200), { sourceType: 'module' });
    expect(changes).toBe(0);
    // Exactly the one Babel takes when it first builds the program's scope.
    expect(crawls.calls).toBe(1);
  });

  it('but crawls once the tree has changed, and not again until it changes more', async () => {
    const crawls = countProgramCrawls();
    // fold-numbers changes the tree in `prepare`. control-flow, in `structure`,
    // sees a dispatcher shape and asks for fresh tables - a rebuild - then
    // refuses the loop and changes nothing; unused, in `clean`, asks next on
    // the identical tree and is answered from the same build, then deletes
    // `y`. That deletion is a change, so the second fixpoint round's
    // control-flow rebuilds once more; unused after it is answered again.
    const source = `${wideReads(50)}\nvar y = 1 + 2;\nwhile (true) { switch (s) { case 1: break; } break; }`;
    const { changes } = await runPass([foldNumbersPass, removeUnusedPass, unflattenControlFlowPass], source, {
      sourceType: 'module',
    });
    expect(changes).toBeGreaterThan(0);
    // Babel's initial build and one rebuild per round that changed the tree.
    // Five is what every request crawling unconditionally used to cost here.
    expect(crawls.calls).toBe(3);
  });

  it('strings.discover on an already-decoded tree does not crawl again', async () => {
    const crawls = countProgramCrawls();
    // No string table anywhere: discovery has nothing to judge and must not
    // pay for a crawl to find that out; unused after it sees the same tree.
    await runPass([discoverStringsPass, removeUnusedPass], wideReads(200), { sourceType: 'module' });
    expect(crawls.calls).toBe(1);
  });
});
