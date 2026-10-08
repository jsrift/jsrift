import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A real-world sample under `<repo>/fixtures/`.
 *
 * The samples are third-party files and are not distributed with the engine,
 * so a checkout may be without them. A test that reads one gates itself on
 * `present` - `it.skipIf(!FIXTURE.present)` or the `describe` form - and is
 * reported as skipped rather than failing on a file that is not there. Vitest
 * still collects a skipped suite's body, so a suite-level read belongs in
 * `beforeAll`, which a skipped suite does not run.
 */
export interface ThirdPartyFixture {
  /** Whether the file is on disk. */
  readonly present: boolean;
  /** The file's text. Only from a test or hook that `present` gates. */
  read(): string;
}

const FIXTURES = new URL('../../../../fixtures/', import.meta.url);

export function thirdPartyFixture(name: string): ThirdPartyFixture {
  const path = fileURLToPath(new URL(name, FIXTURES));
  return {
    present: existsSync(path),
    read: () => readFileSync(path, 'utf8'),
  };
}
