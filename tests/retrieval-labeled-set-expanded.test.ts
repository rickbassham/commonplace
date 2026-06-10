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

interface LabeledPairShape {
  query: string;
  expected_names: string[];
  category: string;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isLabeledPairShape = (value: unknown): value is LabeledPairShape => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('query' in value && 'expected_names' in value && 'category' in value)) return false;
  return (
    typeof value.query === 'string' &&
    isStringArray(value.expected_names) &&
    typeof value.category === 'string'
  );
};

function assertLabeledPairShape(value: unknown, label: string): asserts value is LabeledPairShape {
  if (!isLabeledPairShape(value)) {
    expect.fail(
      `${label}: must be { query: string; expected_names: string[]; category: string }, ` +
        `got ${JSON.stringify(value)}`,
    );
  }
}

const loadLabeledSet = (): unknown[] => {
  const raw = readFileSync(join(repoRoot, 'docs', 'retrieval-labeled-set.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('docs/retrieval-labeled-set.json: expected a top-level JSON array');
  }
  return parsed;
};

describe('DAR-1210 ac-1: expanded labeled set', () => {
  it('docs/retrieval-labeled-set.json parses and every entry satisfies the LabeledPair shape (non-empty query string, non-empty expected_names string[], recognised category value)', () => {
    const pairs = loadLabeledSet();
    expect(pairs.length).toBeGreaterThan(0);
    for (const [i, pair] of pairs.entries()) {
      assertLabeledPairShape(pair, `entry ${i}`);
      expect(pair.query.length, `entry ${i}: query must be non-empty`).toBeGreaterThan(0);
      expect(
        pair.expected_names.length,
        `entry ${i}: expected_names must be non-empty`,
      ).toBeGreaterThan(0);
      for (const n of pair.expected_names) {
        expect(n.length, `entry ${i}: expected_names entries non-empty`).toBeGreaterThan(0);
      }
      expect(
        RECOGNISED_CATEGORIES.has(pair.category),
        `entry ${i}: unrecognised category ${JSON.stringify(pair.category)}`,
      ).toBe(true);
    }
  });

  it('includes judged-negative pairs from the 2026-06-10 mining (count > 0) and the canonical production-miss pair whose gold is dda_linear_workspace_conventions', () => {
    const negatives = loadLabeledSet()
      .filter(isLabeledPairShape)
      .filter((p) => p.category === 'judged_negative');
    expect(negatives.length).toBeGreaterThan(0);
    const canonical = negatives.filter((p) =>
      p.expected_names.includes('dda_linear_workspace_conventions'),
    );
    expect(canonical.length).toBeGreaterThan(0);
  });
});
