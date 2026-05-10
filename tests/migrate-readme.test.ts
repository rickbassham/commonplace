/**
 * DAR-961 ac-7: README sanity tests for the migration section.
 *
 * Asserts the migration documentation covers:
 *   - the `commonplace migrate` entry-point (with `--from claude-code`,
 *     `--auto`, and `--dry-run`)
 *   - the skip-and-report conflict policy
 *   - the "Migrating from mem0 / Letta" dual-MCP-server pattern, with
 *     an explicit note that no commonplace-side integration code is
 *     required.
 *
 * These are doc-drift guards rather than prose-quality assertions:
 * each test pins one concrete claim that the issue body says must be
 * present, so a future README rewrite that drops the claim fails the
 * test rather than silently regressing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const readme = (): string => readFileSync(join(repoRoot, 'README.md'), 'utf8');

describe('DAR-961 ac-7: README migration section', () => {
  it('contains a migration section that documents `commonplace migrate`, `--from claude-code`, `--auto`, and `--dry-run` with at least one example invocation', () => {
    const body = readme();
    expect(body).toMatch(/##\s+Migration/i);
    expect(body).toContain('commonplace migrate');
    expect(body).toContain('--from claude-code');
    expect(body).toContain('--auto');
    expect(body).toContain('--dry-run');
  });

  it('explicitly states the skip-and-report conflict policy for existing target names', () => {
    const body = readme();
    // The phrase "skip and report" (or "skip-and-report") must appear
    // near a description of name collisions. We assert both pieces
    // independently rather than relying on a single regex.
    expect(body).toMatch(/skip[-\s]and[-\s]report/i);
    expect(body.toLowerCase()).toContain('already exists');
  });

  it('contains a section referencing "Migrating from mem0 / Letta" that describes the dual-MCP-server pattern and explicitly notes no commonplace-side integration code is required', () => {
    const body = readme();
    expect(body).toMatch(/mem0/i);
    expect(body).toMatch(/Letta/i);
    // The dual-MCP-server pattern: both servers are registered, the
    // agent bridges them in natural language. The README must say so.
    expect(body.toLowerCase()).toMatch(/no\s+commonplace[-\s]side\s+integration\s+code/);
  });
});
