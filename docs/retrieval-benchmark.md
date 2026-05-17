# Retrieval-quality benchmark for `memory_search`

This document reports the results of the DAR-1034 retrieval benchmark: a comparison of six retrieval variants across two independent labeled test sets (mined from real Claude Code session transcripts, and synthetically generated). The benchmark does not change the production retrieval path -- acting on the numbers is a separate follow-up issue.

## Methodology

Two independent test sets are used. Each has different strengths and biases; we report them separately rather than averaging because their failure modes differ.

**Mined test set (real session transcripts).** Built by `scripts/mine-transcripts.ts` + `scripts/build-labeled-set.ts`. Walks every `.jsonl` transcript recursively under `~/.claude/projects/` (including subagent transcripts) and emits one record per `mcp__commonplace__memory_search` invocation. Labeling assigns each record to one of `confirmed_hit`, `operator_correction`, or `should_have_hit`. Bias: small N (the tool is invoked rarely in practice), but ground-truth signal -- these are real queries with real expected results that the dev's sessions surfaced.

**Synthetic test set (task-derived, no information leak).** Built by mining real first-user-message task descriptions from every session transcript (~/.claude/projects/**/\*.jsonl), then for each task: (1) a generator agent **without corpus access\*\* composes a query an in-task agent would issue, (2) the production cosine ranker produces top-10 candidates, (3) a judge agent picks the single candidate that would have helped (or "none" if the corpus has no relevant memory). Only matched pairs are kept. `memory_search` is an MCP-only tool -- there are no human-typed queries to compare against, so the "realistic" bar is reproducing the deployment shape (agent in-task generates the query without seeing the answer). N is bounded by how many of the sampled tasks the judge actually pairs with a corpus memory (most do not; the corpus is one dev's personal notes, not a general KB). Earlier versions of this benchmark generated queries from memory bodies directly -- that version was an information leak (BM25 trivially won by lexical overlap) and has been replaced.

Variants are run independently against each set. A variant that wins on one set but loses on the other is doing well on its biases, not on retrieval per se; the headline question is whether a variant clearly dominates the baseline `cosine-body` across both sets.

### Metric definitions

- `Recall@1`: fraction of queries whose any `expected_name` appears in the top-1 ranked candidate. Range `[0, 1]`.
- `Recall@5`: same, but for the top-5. Range `[0, 1]`.
- `MRR` (mean reciprocal rank): mean of `1 / rank-of-first-expected` across queries; queries with no expected name in the ranked list contribute `0`. Range `[0, 1]`.

## Corpus stats

- Memory count: 113
- Mean body length: 1438.8 characters

## Mined test set (real session transcripts)

### Test set stats

- Pair count: 10
- confirmed_hit: 10

Below the 30-pair statistical-power target. Treat per-variant deltas on this set as directional only; cross-reference against the other test set before drawing conclusions.

### Results

| variant                      | Recall@1 | Recall@5 | MRR      | notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosine-body                  | 0.600    | 1.000    | 0.800    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.300    | 0.800    | 0.483    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.100    | 0.500    | 0.279    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| bm25                         | 0.100    | 0.300    | 0.196    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.100    | 0.700    | 0.398    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

### Interpretation

#### `cosine-body`

cosine similarity over the body embedding -- the production baseline. Recall@1 = 0.600, Recall@5 = 1.000, MRR = 0.800. This is the current production retrieval path.

#### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.300 (lower than baseline by 0.300), Recall@5 = 0.800, MRR = 0.483 (lower by 0.317). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.100 (lower than baseline by 0.500), Recall@5 = 0.500, MRR = 0.279 (lower by 0.521). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.100 (lower than baseline by 0.500), Recall@5 = 0.300, MRR = 0.196 (lower by 0.604). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.100 (lower than baseline by 0.500), Recall@5 = 0.700, MRR = 0.398 (lower by 0.402). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cross-encoder-rerank`

cross-encoder rerank over the top-K cosine candidates. Currently deferred. Deferred. No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency.

## Synthetic test set (task-derived, no information leak)

### Test set stats

- Pair count: 19
- synthetic: 19

Below the 30-pair statistical-power target. Treat per-variant deltas on this set as directional only; cross-reference against the other test set before drawing conclusions.

### Results

| variant                      | Recall@1 | Recall@5 | MRR      | notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosine-body                  | 0.579    | 0.947    | 0.745    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.579    | 0.947    | 0.741    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.316    | 0.579    | 0.428    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| bm25                         | 0.211    | 0.526    | 0.384    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.368    | 0.895    | 0.585    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

### Interpretation

#### `cosine-body`

cosine similarity over the body embedding -- the production baseline. Recall@1 = 0.579, Recall@5 = 0.947, MRR = 0.745. This is the current production retrieval path.

#### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.579 (unchanged than baseline by 0.000), Recall@5 = 0.947, MRR = 0.741 (lower by 0.004). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.316 (lower than baseline by 0.263), Recall@5 = 0.579, MRR = 0.428 (lower by 0.318). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.211 (lower than baseline by 0.368), Recall@5 = 0.526, MRR = 0.384 (lower by 0.361). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.368 (lower than baseline by 0.211), Recall@5 = 0.895, MRR = 0.585 (lower by 0.160). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cross-encoder-rerank`

cross-encoder rerank over the top-K cosine candidates. Currently deferred. Deferred. No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency.

## Reproducibility

Re-run the full pipeline with:

```
make benchmark
```

The harness reads from `~/.claude/projects` (transcripts) and `~/.commonplace/memory` (user-scope corpus) by default and writes this file plus the mined labeled set under `docs/`. The synthetic labeled set at `docs/retrieval-labeled-set-synthetic.json` is treated as an already-committed artifact -- regenerate it by running the agent-based generator described in the DAR-1034 PR description if memories have been added/removed/renamed. The benchmark never mutates `.embedding` sidecars on disk (DAR-1034 AC-5).

Hybrid weight: `0.5` (BM25 weight; cosine weight = `0.5`).
