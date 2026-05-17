/**
 * Tests for the retrieval metric helpers (Recall@k, MRR).
 *
 * The contract pins the standard definitions:
 *   - Recall@k = fraction of queries whose any `expected_name` appears in
 *     the top-k of the ranked candidates.
 *   - MRR = mean of `1/rank-of-first-expected`, or 0 when no expected name
 *     appears in the ranking.
 */

import { describe, expect, it } from 'vitest';

import { recallAtK, mrr, type RankedQuery } from '../scripts/retrieval-metrics.js';

const q = (expected: string[], ranked: string[]): RankedQuery => ({
  expected_names: expected,
  ranked_names: ranked,
});

describe('recallAtK', () => {
  it('Recall@1 = 1.0 when every query has an expected name at rank 1', () => {
    const queries = [q(['a'], ['a', 'b', 'c']), q(['x'], ['x', 'y'])];
    expect(recallAtK(queries, 1)).toBe(1);
  });

  it('Recall@1 = 0.5 when half the queries have an expected name at rank 1', () => {
    const queries = [q(['a'], ['a', 'b']), q(['x'], ['y', 'x'])];
    expect(recallAtK(queries, 1)).toBe(0.5);
  });

  it('Recall@5 counts a hit if any expected name appears in the top 5', () => {
    const queries = [
      q(['z'], ['a', 'b', 'c', 'd', 'z', 'e']), // z at rank 5 -> hit
      q(['z'], ['a', 'b', 'c', 'd', 'e', 'z']), // z at rank 6 -> miss
    ];
    expect(recallAtK(queries, 5)).toBe(0.5);
  });

  it('returns 0 when the ranking is empty', () => {
    expect(recallAtK([q(['a'], [])], 1)).toBe(0);
  });

  it('a query with multiple expected names hits if ANY of them is in top-k', () => {
    const queries = [q(['miss', 'a'], ['x', 'y', 'a', 'z'])];
    expect(recallAtK(queries, 3)).toBe(1);
  });

  it('returns 0 for an empty query set (zero queries -> zero recall by convention)', () => {
    expect(recallAtK([], 5)).toBe(0);
  });
});

describe('mrr', () => {
  it('MRR is the mean of 1/rank of the first matching expected', () => {
    const queries = [
      q(['a'], ['a', 'b', 'c']), // first match at rank 1 -> 1
      q(['x'], ['y', 'x', 'z']), // first match at rank 2 -> 0.5
      q(['m'], ['n', 'o', 'p']), // no match -> 0
    ];
    // mean(1, 0.5, 0) = 0.5
    expect(mrr(queries)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for an empty query set', () => {
    expect(mrr([])).toBe(0);
  });

  it('a query with multiple expected names uses the BEST-RANKED expected', () => {
    const queries = [q(['miss', 'a'], ['a', 'b', 'c'])];
    expect(mrr(queries)).toBe(1);
  });
});
