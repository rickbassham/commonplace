# Retrieval-quality benchmark for `memory_search`

This document reports the results of the DAR-1034 retrieval benchmark: a comparison of six retrieval variants against a labeled test set mined from real Claude Code session transcripts. The benchmark does not change the production retrieval path -- acting on the numbers is a separate follow-up issue.

## Methodology

The labeled test set is produced by `scripts/mine-transcripts.ts` and `scripts/build-labeled-set.ts`. Mining walks every `.jsonl` transcript under `~/.claude/projects/<project-slug>/` and emits one record per `mcp__commonplace__memory_search` tool call (query, returned names, and surrounding agent / operator follow-up text). Labeling then classifies each record into one of three categories:

- `confirmed_hit`: the search returned a corpus name as the top result and the agent continued without operator correction. The expected name is the top returned result.
- `operator_correction`: the operator's next turn explicitly named a memory in the corpus that was NOT in the search's returned results. The expected names are the operator-mentioned filenames.
- `should_have_hit`: the search returned no candidates, but the operator's next turn named a corpus memory that should have been found. The expected names are the operator-mentioned filenames.

Hand-curation is explicitly forbidden by the issue's Notes; the test set is the unfiltered output of the mining + labeling pipeline. The achievable pair count is the natural ceiling of the available transcripts -- when it falls below the 30-pair target, this document reports the actual count and explains why (see Test set stats).

### Metric definitions

- `Recall@1`: fraction of queries whose any `expected_name` appears in the top-1 ranked candidate. Range `[0, 1]`.
- `Recall@5`: same, but for the top-5. Range `[0, 1]`.
- `MRR` (mean reciprocal rank): mean of `1 / rank-of-first-expected` across queries; queries with no expected name in the ranked list contribute `0`. Range `[0, 1]`.

## Corpus stats

- Memory count: 110
- Mean body length: 1444.6 characters

## Test set stats

- Pair count: 9
- confirmed_hit: 9
- operator_correction: 0
- should_have_hit: 0

The labeled set contains 9 pairs, below the 30-pair target. This is the natural ceiling of the available transcripts at the time of the benchmark run -- `memory_search` is invoked relatively rarely (a handful of times per session) and the corpus of historical sessions is small. Hand-curation is forbidden by the issue's Notes, so the pair count is reported as-is. Re-running the harness against a larger transcript corpus (more sessions, longer time window) will naturally lift the pair count.

## Results

| variant                      | Recall@1 | Recall@5 | MRR      | notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosine-body                  | 0.556    | 1.000    | 0.778    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.222    | 0.778    | 0.425    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.111    | 0.556    | 0.310    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| bm25                         | 0.111    | 0.333    | 0.206    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.111    | 0.667    | 0.390    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

## Interpretation

The `cosine-body` row is the current production baseline: it is what `MemoryStore.search` actually does today. All other rows are read relative to it.

### `cosine-body`

cosine similarity over the body embedding -- the production baseline. Recall@1 = 0.556, Recall@5 = 1.000, MRR = 0.778. This is the current production retrieval path.

### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.222 (lower than baseline by 0.333), Recall@5 = 0.778, MRR = 0.425 (lower by 0.352). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.111 (lower than baseline by 0.444), Recall@5 = 0.556, MRR = 0.310 (lower by 0.468). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.111 (lower than baseline by 0.444), Recall@5 = 0.333, MRR = 0.206 (lower by 0.572). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.111 (lower than baseline by 0.444), Recall@5 = 0.667, MRR = 0.390 (lower by 0.388). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

### `cross-encoder-rerank`

cross-encoder rerank over the top-K cosine candidates. Currently deferred. Deferred. No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency.

## Reproducibility

Re-run the full pipeline with:

```
pnpm exec tsx scripts/run-retrieval-benchmark.ts
```

The script reads from `~/.claude/projects` (transcripts) and `~/.commonplace/memory` (user-scope corpus) by default and writes this file plus the labeled set under `docs/`. It does not mutate the `.embedding` sidecars on disk (DAR-1034 AC-5).

Hybrid weight: `0.5` (BM25 weight; cosine weight = `0.5`).
