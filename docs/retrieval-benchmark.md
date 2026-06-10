# Retrieval-quality benchmark for `memory_search`

This document reports the results of the retrieval benchmark introduced in DAR-1034 and extended in DAR-1210: a comparison of the retrieval variants in `scripts/retrieval-variants.ts` across independent labeled test sets (mined from real Claude Code session transcripts, judged subsets thereof, and a synthetically generated set). As of DAR-1210 the production retrieval path is the `cosine-desc-body-max` variant; `cosine-body` is the pre-fusion baseline it is compared against.

## Methodology

Two independent test sets are used. Each has different strengths and biases; we report them separately rather than averaging because their failure modes differ.

**Mined test set (expanded, real session transcripts).** Built by `scripts/mine-transcripts.ts` + `scripts/build-labeled-set.ts`, expanded with the judged pairs from the 2026-06-10 mining pass (DAR-1210). The auto-mined portion walks every `.jsonl` transcript recursively under `~/.claude/projects/` (including subagent transcripts), emits one record per `mcp__commonplace__memory_search` invocation, and labels each as `confirmed_hit`, `operator_correction`, or `should_have_hit`. The judged portion comes from `~/.claude/artifacts/commonplace-recall-mining-2026-06-10/`: 209 real `memory_search` calls mined across 11 projects were judged by independent agents reading each call WITH its surrounding conversation context, yielding 69 unique (query, gold) pairs -- 33 positive (`judged_positive`), 34 negative (`judged_negative`: a relevant gold memory existed but was not surfaced), and 2 ambiguous (`judged_meh`). Negatives are included deliberately: the earlier auto-mined set was all `confirmed_hit`, i.e. survivorship-biased toward whatever the production variant already retrieved, and structurally blind to the miss mode DAR-1210 fixes. Judged pairs are preserved verbatim across benchmark regenerations (judgments are not re-litigated) and take precedence over an auto-mined pair with the same query. Bias: one dev’s sessions; ground-truth signal.

**Judged positives (2026-06-10 mining).** The 33 `judged_positive` pairs from the 2026-06-10 mining pass, scored on their own so regressions against the body-only baseline are visible: a fusion variant must keep finding what production already found. DAR-1210 gate: `cosine-desc-body-max` Recall@5 here must be >= the `cosine-body` Recall@5.

**Judged negatives (2026-06-10 mining).** The 34 `judged_negative` pairs from the 2026-06-10 mining pass: real queries where a relevant memory existed in the corpus but production retrieval missed it (gold typically ranked 60+). This is the failure mode two-channel fusion targets. DAR-1210 gate: `cosine-desc-body-max` Recall@5 here must be >= 0.9. Caveat: 26 of the 34 share one gold (`dda_linear_workspace_conventions`); excluding it, the body-only-misses pattern still holds on the remaining 8 pairs across 5 distinct memories.

**Synthetic test set (task-derived, no information leak).** Built by mining real first-user-message task descriptions from every session transcript (~/.claude/projects/**/\*.jsonl), then for each task: (1) a generator agent **without corpus access\*\* composes a query an in-task agent would issue, (2) the production cosine ranker produces top-10 candidates, (3) a judge agent picks the single candidate that would have helped (or "none" if the corpus has no relevant memory). Only matched pairs are kept. `memory_search` is an MCP-only tool -- there are no human-typed queries to compare against, so the "realistic" bar is reproducing the deployment shape (agent in-task generates the query without seeing the answer). N is bounded by how many of the sampled tasks the judge actually pairs with a corpus memory (most do not; the corpus is one dev's personal notes, not a general KB). Earlier versions of this benchmark generated queries from memory bodies directly -- that version was an information leak (BM25 trivially won by lexical overlap) and has been replaced.

Variants are run independently against each set. A variant that wins on one set but loses on the other is doing well on its biases, not on retrieval per se; the headline question is whether a variant clearly dominates the baseline `cosine-body` across both sets.

### Metric definitions

- `Recall@1`: fraction of queries whose any `expected_name` appears in the top-1 ranked candidate. Range `[0, 1]`.
- `Recall@5`: same, but for the top-5. Range `[0, 1]`.
- `MRR` (mean reciprocal rank): mean of `1 / rank-of-first-expected` across queries; queries with no expected name in the ranked list contribute `0`. Range `[0, 1]`.

## Corpus stats

- Memory count: 150
- Mean body length: 1486.9 characters

## Mined test set (expanded, real session transcripts)

### Test set stats

- Pair count: 176
- confirmed_hit: 107
- judged_positive: 33
- judged_negative: 34
- judged_meh: 2

### Results

| variant                      | Recall@1 | Recall@5 | MRR      | notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosine-body                  | 0.756    | 0.801    | 0.782    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.619    | 0.784    | 0.696    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.460    | 0.705    | 0.585    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-desc-body-max         | 0.511    | 0.892    | 0.667    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=max(desc, body)                                                                                                                                                                                                                                                  |
| cosine-desc-body-mean        | 0.670    | 0.938    | 0.780    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=mean(desc, body)                                                                                                                                                                                                                                                 |
| bm25                         | 0.369    | 0.580    | 0.468    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.460    | 0.886    | 0.633    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

### Interpretation

#### `cosine-body`

cosine similarity over the body embedding -- the pre-DAR-1210 production baseline. Recall@1 = 0.756, Recall@5 = 0.801, MRR = 0.782. This is the pre-fusion baseline every other row is read against.

#### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.619 (lower than baseline by 0.136), Recall@5 = 0.784, MRR = 0.696 (lower by 0.086). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.460 (lower than baseline by 0.295), Recall@5 = 0.705, MRR = 0.585 (lower by 0.197). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-max`

two-channel fusion: `max(cos(q, description), cos(q, body))` per entry. The production `MemoryStore.search` scorer as of DAR-1210 -- max-fusion eliminates the catastrophic-miss mode where a dense-fact-sheet body hides a memory from queries that restate its description. Recall@1 = 0.511 (lower than baseline by 0.244), Recall@5 = 0.892, MRR = 0.667 (lower by 0.115). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-mean`

two-channel fusion: arithmetic mean of the description and body cosines. Benchmark-only alternative to max-fusion (not shipped). Recall@1 = 0.670 (lower than baseline by 0.085), Recall@5 = 0.938, MRR = 0.780 (lower by 0.002). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.369 (lower than baseline by 0.386), Recall@5 = 0.580, MRR = 0.468 (lower by 0.314). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.460 (lower than baseline by 0.295), Recall@5 = 0.886, MRR = 0.633 (lower by 0.149). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cross-encoder-rerank`

cross-encoder rerank over the top-K cosine candidates. Currently deferred. Deferred. No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency.

## Judged positives (2026-06-10 mining)

### Test set stats

- Pair count: 33
- judged_positive: 33

### Results

| variant                      | Recall@1 | Recall@5 | MRR      | notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosine-body                  | 0.818    | 0.939    | 0.868    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.788    | 0.909    | 0.835    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.697    | 0.909    | 0.811    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-desc-body-max         | 0.697    | 0.939    | 0.817    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=max(desc, body)                                                                                                                                                                                                                                                  |
| cosine-desc-body-mean        | 0.758    | 0.970    | 0.852    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=mean(desc, body)                                                                                                                                                                                                                                                 |
| bm25                         | 0.636    | 0.909    | 0.740    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.697    | 1.000    | 0.822    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

### Interpretation

#### `cosine-body`

cosine similarity over the body embedding -- the pre-DAR-1210 production baseline. Recall@1 = 0.818, Recall@5 = 0.939, MRR = 0.868. This is the pre-fusion baseline every other row is read against.

#### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.788 (lower than baseline by 0.030), Recall@5 = 0.909, MRR = 0.835 (lower by 0.032). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.697 (lower than baseline by 0.121), Recall@5 = 0.909, MRR = 0.811 (lower by 0.057). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-max`

two-channel fusion: `max(cos(q, description), cos(q, body))` per entry. The production `MemoryStore.search` scorer as of DAR-1210 -- max-fusion eliminates the catastrophic-miss mode where a dense-fact-sheet body hides a memory from queries that restate its description. Recall@1 = 0.697 (lower than baseline by 0.121), Recall@5 = 0.939, MRR = 0.817 (lower by 0.051). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-mean`

two-channel fusion: arithmetic mean of the description and body cosines. Benchmark-only alternative to max-fusion (not shipped). Recall@1 = 0.758 (lower than baseline by 0.061), Recall@5 = 0.970, MRR = 0.852 (lower by 0.015). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.636 (lower than baseline by 0.182), Recall@5 = 0.909, MRR = 0.740 (lower by 0.128). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.697 (lower than baseline by 0.121), Recall@5 = 1.000, MRR = 0.822 (lower by 0.046). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cross-encoder-rerank`

cross-encoder rerank over the top-K cosine candidates. Currently deferred. Deferred. No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency.

## Judged negatives (2026-06-10 mining)

### Test set stats

- Pair count: 34
- judged_negative: 34

### Results

| variant                      | Recall@1 | Recall@5 | MRR      | notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosine-body                  | 0.059    | 0.059    | 0.086    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.029    | 0.059    | 0.068    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.912    | 0.971    | 0.942    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-desc-body-max         | 0.912    | 0.971    | 0.941    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=max(desc, body)                                                                                                                                                                                                                                                  |
| cosine-desc-body-mean        | 0.853    | 0.941    | 0.881    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=mean(desc, body)                                                                                                                                                                                                                                                 |
| bm25                         | 0.882    | 0.971    | 0.927    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.765    | 0.941    | 0.837    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

### Interpretation

#### `cosine-body`

cosine similarity over the body embedding -- the pre-DAR-1210 production baseline. Recall@1 = 0.059, Recall@5 = 0.059, MRR = 0.086. This is the pre-fusion baseline every other row is read against.

#### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.029 (lower than baseline by 0.029), Recall@5 = 0.059, MRR = 0.068 (lower by 0.018). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.912 (higher than baseline by 0.853), Recall@5 = 0.971, MRR = 0.942 (higher by 0.855). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-max`

two-channel fusion: `max(cos(q, description), cos(q, body))` per entry. The production `MemoryStore.search` scorer as of DAR-1210 -- max-fusion eliminates the catastrophic-miss mode where a dense-fact-sheet body hides a memory from queries that restate its description. Recall@1 = 0.912 (higher than baseline by 0.853), Recall@5 = 0.971, MRR = 0.941 (higher by 0.855). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-mean`

two-channel fusion: arithmetic mean of the description and body cosines. Benchmark-only alternative to max-fusion (not shipped). Recall@1 = 0.853 (higher than baseline by 0.794), Recall@5 = 0.941, MRR = 0.881 (higher by 0.795). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.882 (higher than baseline by 0.824), Recall@5 = 0.971, MRR = 0.927 (higher by 0.841). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.765 (higher than baseline by 0.706), Recall@5 = 0.941, MRR = 0.837 (higher by 0.751). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

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
| cosine-body                  | 0.474    | 0.895    | 0.653    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description-plus-body | 0.526    | 0.895    | 0.691    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-description           | 0.316    | 0.526    | 0.413    | embedderModelId=Xenova/bge-base-en-v1.5                                                                                                                                                                                                                                                                          |
| cosine-desc-body-max         | 0.421    | 0.789    | 0.575    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=max(desc, body)                                                                                                                                                                                                                                                  |
| cosine-desc-body-mean        | 0.579    | 0.842    | 0.687    | embedderModelId=Xenova/bge-base-en-v1.5; fusion=mean(desc, body)                                                                                                                                                                                                                                                 |
| bm25                         | 0.211    | 0.526    | 0.375    | k1=1.2; b=0.75; field=body                                                                                                                                                                                                                                                                                       |
| bm25-cosine-hybrid           | 0.368    | 0.842    | 0.553    | bm25Weight=0.5; cosineWeight=0.5; normalisation=per-query min-max                                                                                                                                                                                                                                                |
| cross-encoder-rerank         | deferred | deferred | deferred | No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency. |

### Interpretation

#### `cosine-body`

cosine similarity over the body embedding -- the pre-DAR-1210 production baseline. Recall@1 = 0.474, Recall@5 = 0.895, MRR = 0.653. This is the pre-fusion baseline every other row is read against.

#### `cosine-description-plus-body`

cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval. Recall@1 = 0.526 (higher than baseline by 0.053), Recall@5 = 0.895, MRR = 0.691 (higher by 0.038). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-description`

cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal. Recall@1 = 0.316 (lower than baseline by 0.158), Recall@5 = 0.526, MRR = 0.413 (lower by 0.240). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-max`

two-channel fusion: `max(cos(q, description), cos(q, body))` per entry. The production `MemoryStore.search` scorer as of DAR-1210 -- max-fusion eliminates the catastrophic-miss mode where a dense-fact-sheet body hides a memory from queries that restate its description. Recall@1 = 0.421 (lower than baseline by 0.053), Recall@5 = 0.789, MRR = 0.575 (lower by 0.078). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cosine-desc-body-mean`

two-channel fusion: arithmetic mean of the description and body cosines. Benchmark-only alternative to max-fusion (not shipped). Recall@1 = 0.579 (higher than baseline by 0.105), Recall@5 = 0.842, MRR = 0.687 (higher by 0.034). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25`

lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive. Recall@1 = 0.211 (lower than baseline by 0.263), Recall@5 = 0.526, MRR = 0.375 (lower by 0.278). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `bm25-cosine-hybrid`

weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone. Recall@1 = 0.368 (lower than baseline by 0.105), Recall@5 = 0.842, MRR = 0.553 (lower by 0.099). Interpret with the test-set size in mind -- small N means noisy deltas; the headline question is whether this variant clearly dominates the baseline.

#### `cross-encoder-rerank`

cross-encoder rerank over the top-K cosine candidates. Currently deferred. Deferred. No local ONNX cross-encoder rerank model ships with the project (e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the transformers.js model cache). Running it would require downloading a model on first benchmark run, which the contract permits deferring rather than introducing a network dependency.

## Reproducibility

Re-run the full pipeline with:

```
make benchmark
```

The harness reads from `~/.claude/projects` (transcripts) and `~/.commonplace/memory` (user-scope corpus) by default and writes this file plus the mined labeled set under `docs/`. The synthetic labeled set at `docs/retrieval-labeled-set-synthetic.json` is treated as an already-committed artifact -- regenerate it by running the agent-based generator described in the DAR-1034 PR description if memories have been added/removed/renamed. The benchmark never mutates `.embedding` sidecars on disk (DAR-1034 AC-5).

Hybrid weight: `0.5` (BM25 weight; cosine weight = `0.5`).
