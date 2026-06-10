/**
 * Contract tests for the expanded labeled set (DAR-1210 ac-1): the pairs
 * mined and judged from real transcripts on 2026-06-10 -- negatives
 * included -- folded into `docs/retrieval-labeled-set.json` alongside the
 * auto-mined DAR-1034 pairs.
 *
 * Provenance: ~/.claude/artifacts/commonplace-recall-mining-2026-06-10/
 * (mined memory_search calls, agent judgments with conversation context,
 * and the re-ranked verification set). The judged categories are:
 *
 *   - `judged_positive`: the judge confirmed the search served its purpose.
 *   - `judged_negative`: a relevant memory existed but was not surfaced
 *     (the failure mode DAR-1210's fusion scoring targets).
 *   - `judged_meh`: ambiguous -- kept for completeness, mostly legitimate
 *     absence checks.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

const RECOGNISED_CATEGORIES = new Set([
  'confirmed_hit',
  'operator_correction',
  'should_have_hit',
  'synthetic',
  'judged_positive',
  'judged_negative',
  'judged_meh',
]);

interface RawPair {
  query: unknown;
  expected_names: unknown;
  category: unknown;
}

const loadLabeledSet = (): RawPair[] => {
  const raw = readFileSync(join(repoRoot, 'docs', 'retrieval-labeled-set.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as RawPair[];
};

describe('DAR-1210 ac-1: expanded labeled set', () => {
  it('docs/retrieval-labeled-set.json parses and every entry satisfies the LabeledPair shape (non-empty query string, non-empty expected_names string[], recognised category value)', () => {
    const pairs = loadLabeledSet();
    expect(pairs.length).toBeGreaterThan(0);
    for (const [i, pair] of pairs.entries()) {
      expect(typeof pair.query, `entry ${i}: query must be a string`).toBe('string');
      expect((pair.query as string).length, `entry ${i}: query must be non-empty`).toBeGreaterThan(
        0,
      );
      expect(Array.isArray(pair.expected_names), `entry ${i}: expected_names must be array`).toBe(
        true,
      );
      const names = pair.expected_names as unknown[];
      expect(names.length, `entry ${i}: expected_names must be non-empty`).toBeGreaterThan(0);
      for (const n of names) {
        expect(typeof n, `entry ${i}: expected_names entries must be strings`).toBe('string');
        expect(
          (n as string).length,
          `entry ${i}: expected_names entries non-empty`,
        ).toBeGreaterThan(0);
      }
      expect(
        RECOGNISED_CATEGORIES.has(pair.category as string),
        `entry ${i}: unrecognised category ${JSON.stringify(pair.category)}`,
      ).toBe(true);
    }
  });

  it('includes judged-negative pairs from the 2026-06-10 mining (count > 0) and the canonical production-miss pair whose gold is dda_linear_workspace_conventions', () => {
    const pairs = loadLabeledSet();
    const negatives = pairs.filter((p) => p.category === 'judged_negative');
    expect(negatives.length).toBeGreaterThan(0);
    const canonical = negatives.filter((p) =>
      (p.expected_names as string[]).includes('dda_linear_workspace_conventions'),
    );
    expect(canonical.length).toBeGreaterThan(0);
  });
});
