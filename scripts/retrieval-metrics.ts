/**
 * Retrieval metric helpers for the DAR-1034 benchmark.
 *
 * Standard definitions per the approved contract:
 *
 *   - Recall@k = fraction of queries whose any `expected_name` appears in
 *     the top-k of the ranked candidate list.
 *   - MRR     = mean of `1 / rank-of-first-expected` across queries; 0
 *     when no expected name appears.
 *
 * A query with multiple expected names counts as a hit on Recall@k if ANY
 * of them is in the top-k, and contributes the best (lowest) rank to MRR.
 */

/** One query's expected names and one variant's ranked candidate list. */
export interface RankedQuery {
  /** Expected memory names (canonical filenames) for this query. */
  expected_names: string[];
  /** Variant's ranked candidate list, in descending score order. */
  ranked_names: string[];
}

/**
 * Compute Recall@k: fraction of queries with any expected_name in the
 * first `k` ranked candidates. Returns 0 for an empty query set by
 * convention.
 */
export const recallAtK = (queries: RankedQuery[], k: number): number => {
  if (queries.length === 0) return 0;
  let hits = 0;
  for (const q of queries) {
    const topK = q.ranked_names.slice(0, k);
    for (const exp of q.expected_names) {
      if (topK.includes(exp)) {
        hits += 1;
        break;
      }
    }
  }
  return hits / queries.length;
};

/**
 * Compute mean reciprocal rank (MRR): mean of 1/rank of the first
 * matching expected name. Queries with no matching expected name in the
 * ranking contribute 0. Returns 0 for an empty query set.
 */
export const mrr = (queries: RankedQuery[]): number => {
  if (queries.length === 0) return 0;
  let total = 0;
  for (const q of queries) {
    let bestRank = Infinity;
    for (const exp of q.expected_names) {
      const idx = q.ranked_names.indexOf(exp);
      if (idx === -1) continue;
      const rank = idx + 1;
      if (rank < bestRank) bestRank = rank;
    }
    if (bestRank !== Infinity) total += 1 / bestRank;
  }
  return total / queries.length;
};
