/**
 * DAR-921 contract tests: version sync invariants for the v0.1.0 release.
 *
 * The v0.1.0 release ships with three pieces of metadata that MUST agree on
 * the version string:
 *
 *   1. `package.json` `version` field
 *   2. `SERVER_VERSION` constant exported from `src/server/server.ts`
 *      (reported back to every MCP client via the `initialize` handshake)
 *   3. The most recent `## [X.Y.Z] - YYYY-MM-DD` heading in `CHANGELOG.md`
 *
 * The DAR-960 release workflow enforces (1) <-> (2) at publish time via a
 * dedicated drift-guard step, and enforces (1) <-> git tag via another. These
 * unit tests enforce the same invariants on the prep PR itself so a missed
 * bump fails CI before the tag is ever pushed.
 *
 * For v0.1.0 these are the contract values; future releases bump them
 * together. If a later release intentionally moves the version, update all
 * four places in lockstep (package.json, SERVER_VERSION, CHANGELOG section,
 * and the EXPECTED_VERSION constant below).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SERVER_VERSION } from '../src/server/server.js';

const repoRoot = join(__dirname, '..');
const EXPECTED_VERSION = '0.1.0';

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

describe('DAR-921 ac-1 / ac-7: package.json version', () => {
  it(`package.json \`version\` field equals \`${EXPECTED_VERSION}\` exactly`, () => {
    expect(readPackageVersion()).toBe(EXPECTED_VERSION);
  });
});

describe('DAR-921 ac-1 / ac-7: SERVER_VERSION constant', () => {
  it(`\`SERVER_VERSION\` exported from \`src/server/server.ts\` equals \`${EXPECTED_VERSION}\` and matches \`package.json\` version`, () => {
    expect(SERVER_VERSION).toBe(EXPECTED_VERSION);
    expect(SERVER_VERSION).toBe(readPackageVersion());
  });
});

describe('DAR-921 ac-7: CHANGELOG heading', () => {
  it(`\`CHANGELOG.md\` contains a \`## [${EXPECTED_VERSION}] - YYYY-MM-DD\` heading with a valid ISO date`, () => {
    const body = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    // Match `## [X.Y.Z] - YYYY-MM-DD` exactly. The date must be ISO-shaped
    // (4-2-2 digits); the regex deliberately does NOT validate calendar
    // legality (e.g. it would accept 2026-13-40) — Keep a Changelog only
    // requires the YYYY-MM-DD shape, and stricter calendar validation
    // belongs in a date parser, not a heading regex.
    const escaped = EXPECTED_VERSION.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^##\\s+\\[${escaped}\\]\\s+-\\s+(\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm');
    const match = body.match(pattern);
    expect(match, `expected a \`## [${EXPECTED_VERSION}] - YYYY-MM-DD\` heading`).not.toBeNull();
    if (!match) return;
    const date = match[1];
    expect(date, 'date must be ISO-shaped').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Sanity: the parsed Date must not be Invalid Date.
    expect(Number.isNaN(new Date(date as string).getTime())).toBe(false);
  });
});
