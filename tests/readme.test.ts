/**
 * README sanity tests.
 *
 * Two narrow goals:
 *
 *   1. Catch drift between README and code: every `inputSchema` property of
 *      every registered MCP tool, and every COMMONPLACE_* env var the bin
 *      reads, must appear somewhere in the README. If a property is renamed
 *      or removed, the test fails until the README catches up.
 *   2. Catch link rot: README markdown links to files in the repo must
 *      resolve on disk.
 *
 * Everything else about README quality (prose, section ordering, specific
 * phrasings, install-command verbatims) is a review-time concern. Asserting
 * on prose turns natural documentation rewrites into test rewrites for no
 * meaningful coverage.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildToolDefinitions } from '../src/server/tools.js';

const repoRoot = join(__dirname, '..');
const readmePath = join(repoRoot, 'README.md');
const readme = (): string => readFileSync(readmePath, 'utf8');

describe('README/code drift: tool schemas', () => {
  it('every inputSchema property of every registered tool appears in README.md', () => {
    const body = readme();
    for (const def of buildToolDefinitions()) {
      const schema = def.inputSchema as { properties?: Record<string, unknown> };
      const props = Object.keys(schema.properties ?? {});
      for (const prop of props) {
        expect(body, `${def.name}.${prop} not documented in README`).toMatch(
          new RegExp(`\\b${prop}\\b`),
        );
      }
    }
  });
});

describe('README/code drift: env vars', () => {
  // Manually maintained against src/bin/env.ts and src/bin/scope.ts. If
  // a new COMMONPLACE_* knob is added to the bin, add it here so the
  // README is forced to document it.
  const REQUIRED_ENV_VARS = [
    'COMMONPLACE_USER_DIR',
    'COMMONPLACE_PROJECT_DIR',
    'COMMONPLACE_MEMORY_DIR',
    'COMMONPLACE_MODEL',
    'COMMONPLACE_DEFAULT_LIMIT',
    'COMMONPLACE_EXPANSION_DECAY',
    'COMMONPLACE_CONNECTEDNESS_BOOST',
    'COMMONPLACE_NO_UPDATE_CHECK',
  ];

  it('every COMMONPLACE_* env var the bin reads appears in README.md', () => {
    const body = readme();
    for (const name of REQUIRED_ENV_VARS) {
      expect(body, `${name} not documented in README`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

describe('README links resolve', () => {
  it('the docs/sidecar-format.md link target exists on disk', () => {
    expect(readme()).toMatch(/\]\([^)]*docs\/sidecar-format\.md[^)]*\)/);
    expect(existsSync(join(repoRoot, 'docs/sidecar-format.md'))).toBe(true);
  });
});
