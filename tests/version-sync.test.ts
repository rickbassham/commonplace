/**
 * Version-sync invariants. Three pieces of metadata must agree on the
 * version string:
 *
 *   1. `package.json` `version` field
 *   2. `SERVER_VERSION` constant exported from `src/server/server.ts`
 *      (reported back to every MCP client via the `initialize` handshake)
 *   3. The most recent `## [X.Y.Z]` heading in `CHANGELOG.md` (matching
 *      either the hand-authored Keep-a-Changelog format used before the
 *      commit-and-tag-version migration or the auto-generated
 *      release-please format used since the release-please migration)
 *
 * The release workflow enforces (1) <-> (2) at publish time and
 * (1) <-> git tag at publish time. These unit tests run on every CI
 * build so a missed bump fails fast.
 *
 * Reference value: `package.json`'s `version` field is the source of
 * truth. release-please bumps it atomically alongside `SERVER_VERSION`
 * (via the `extra-files` updater) and the CHANGELOG, so the invariants
 * below all reduce to "did the bump touch every place it was supposed
 * to?" A missed bump in any single place fails CI before the tag is
 * pushed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SERVER_VERSION } from '../src/server/server.js';

const repoRoot = join(__dirname, '..');

const readPackageVersion = (): string => {
  const text = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof (parsed as { version: unknown }).version !== 'string'
  ) {
    throw new Error('package.json is missing a string `version` field');
  }
  return (parsed as { version: string }).version;
};

describe('version sync: SERVER_VERSION matches package.json', () => {
  it('`SERVER_VERSION` exported from `src/server/server.ts` equals the `version` field in `package.json`', () => {
    expect(SERVER_VERSION).toBe(readPackageVersion());
  });
});

describe('version sync: CHANGELOG heading exists for the current version', () => {
  it('`CHANGELOG.md` contains a `## [<version>]` heading with an ISO date, in either the hand-authored or release-please format', () => {
    const version = readPackageVersion();
    const body = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const escaped = version.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    // Two supported heading shapes:
    //   `## [X.Y.Z] - YYYY-MM-DD`              (Keep a Changelog, hand-written)
    //   `## [X.Y.Z](compare-url) (YYYY-MM-DD)` (release-please)
    // The regex accepts either: an optional `(...)` block after the
    // bracketed version, then either ` - <date>` or ` (<date>)`. The date
    // must be ISO-shaped (4-2-2 digits); stricter calendar validation
    // belongs in a date parser, not a heading regex.
    const pattern = new RegExp(
      `^##\\s+\\[${escaped}\\](?:\\([^)]*\\))?\\s+(?:-\\s+(\\d{4}-\\d{2}-\\d{2})|\\((\\d{4}-\\d{2}-\\d{2})\\))\\s*$`,
      'm',
    );
    const match = body.match(pattern);
    expect(match, `expected a \`## [${version}]\` heading with an ISO date`).not.toBeNull();
    if (!match) return;
    const date = match[1] ?? match[2];
    expect(date, 'date must be ISO-shaped').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(date as string).getTime())).toBe(false);
  });
});
