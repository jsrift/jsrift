import { describe, expect, it } from 'vitest';
import { removeUnusedPass } from '../src/passes/clean/unused.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * `deadCodeRemoval.keepCommented` is documented as "preserve any statement
 * carrying a leading comment". `clean.unused` deletes declarations, and a
 * declaration is a statement, so the option has to hold there too - it used to
 * be read only by the constant-branch passes, and an annotated helper that
 * nothing called went out with the orphaned comment left behind.
 */

const SOURCE = `
function main() {
  // kept: a human wrote this note
  function helper() { return 1; }
  function silent() { return 2; }
  // important
  var annotated = 3;
  var plain = 4;
  return 5;
}
main();
`;

function withKeepCommented(keepCommented: boolean): DeobfuscateOptions {
  return { techniques: { deadCodeRemoval: { keepCommented } } };
}

describe('clean.unused honours deadCodeRemoval.keepCommented', () => {
  it('keeps a declaration with a leading comment and removes the rest', async () => {
    const { code } = await runPass(removeUnusedPass, SOURCE, withKeepCommented(true));
    expect(code).toContain('function helper()');
    expect(code).toContain('var annotated = 3');
    expect(code).not.toContain('function silent()');
    expect(code).not.toContain('var plain');
    // The comment stays attached to the statement it annotates.
    expect(code).toMatch(/kept: a human wrote this note\s*\n\s*function helper\(\)/);
  });

  it('removes the same declarations when the option is off', async () => {
    const { code } = await runPass(removeUnusedPass, SOURCE, withKeepCommented(false));
    expect(code).not.toContain('function helper()');
    expect(code).not.toContain('var annotated');
    expect(code).not.toContain('function silent()');
    expect(code).not.toContain('var plain');
  });

  it('holds at module scope, where the script-globals refusal does not apply', async () => {
    const source = `
      // important
      const unusedButCommented = 2;
      const unused = 3;
      export const used = 1;
    `;
    const { code } = await runPass(removeUnusedPass, source, {
      sourceType: 'module',
      ...withKeepCommented(true),
    });
    expect(code).toContain('const unusedButCommented = 2');
    expect(code).not.toContain('const unused = 3');
  });

  it('keeps a commented declaration whose initialiser has effects, rather than dropping its name', async () => {
    const source = `
      function main() {
        // the name matters to whoever reads this
        var handle = register();
        return 1;
      }
      main();
    `;
    const { code } = await runPass(removeUnusedPass, source, withKeepCommented(true));
    expect(code).toContain('var handle = register()');
  });
});
