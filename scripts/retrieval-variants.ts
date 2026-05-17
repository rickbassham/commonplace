/**
 * Retrieval variants for the DAR-1034 benchmark harness.
 *
 * Each variant scores corpus entries against a query and returns a
 * ranked candidate list (by canonical filename). The variants share a
 * common {@link BenchmarkInputs} shape so the harness can run them all
 * over the same pre-processed corpus.
 *
 * # Variants
 *
 *   - `cosine-body`                 -- cosine similarity over the body
 *     embedding stored in {@link BenchmarkCorpusEntry.bodyVector}. This
 *     matches the production retrieval path (`MemoryStore.search`).
 *   - `cosine-description-plus-body` -- cosine similarity over an in-
 *     memory re-embedding of `${description}\n${body}`.
 *   - `cosine-description`          -- cosine similarity over an in-
 *     memory re-embedding of the description only.
 *   - `bm25`                        -- lexical BM25 over the tokenized
 *     body. Standard parameters (`k1=1.2`, `b=0.75`).
 *   - `bm25-cosine-hybrid`          -- weighted sum of min-max-normalised
 *     BM25 and cosine scores (per-query normalisation). The weight is
 *     configurable via {@link RunVariantOpts.hybridWeight} (default 0.5,
 *     interpreted as the BM25 weight; the cosine weight is `1 - weight`).
 *   - `cross-encoder-rerank`        -- cross-encoder rerank over the
 *     top-K cosine candidates. Currently deferred -- no local ONNX
 *     cross-encoder model ships with the project; the variant returns a
 *     deferral result with an explanatory reason that the harness
 *     surfaces in `docs/retrieval-benchmark.md`.
 *
 * # No on-disk mutation (ac-5)
 *
 * The description-only and description+body variants re-embed in
 * memory: `buildBenchmarkInputs` precomputes the alternate vectors but
 * NEVER writes them to disk. The harness uses the in-memory cache for
 * the duration of the run and discards it on exit.
 */

import type { RankedQuery } from './retrieval-metrics.js';
import type { LabeledPair } from './build-labeled-set.js';

/** A memory in the benchmark corpus. */
export interface BenchmarkCorpusEntry {
  /** Canonical filename (snake_case basename of the .md file). */
  filename: string;
  /** YAML frontmatter `name:` value (may differ from filename). */
  name: string;
  /** YAML frontmatter description. */
  description: string;
  /** Markdown body. */
  body: string;
  /**
   * L2-normalised body embedding -- the production sidecar value.
   * Populated by {@link buildBenchmarkInputs} (either from the loaded
   * sidecar or from a fresh embedding). Read by the cosine-body variant.
   */
  bodyVector: Float32Array | null;
  /** L2-normalised description+body embedding (in-memory, never on disk). */
  descBodyVector?: Float32Array;
  /** L2-normalised description-only embedding (in-memory, never on disk). */
  descVector?: Float32Array;
  /** Lowercased + tokenised body for BM25. */
  bodyTokens?: string[];
}

/** A minimal embedder shape -- compatible with `src/embedder/index.ts`'s Embedder. */
export interface BenchmarkEmbedder {
  readonly modelId: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

/** Pre-processed benchmark inputs. Build once, run every variant against. */
export interface BenchmarkInputs {
  corpus: BenchmarkCorpusEntry[];
  pairs: LabeledPair[];
  embedder: BenchmarkEmbedder;
  /** All corpus tokenised bodies, for BM25 IDF calculation. */
  bodyTokensList: string[][];
}

export interface BuildBenchmarkInputsOptions {
  corpus: BenchmarkCorpusEntry[];
  pairs: LabeledPair[];
  embedder: BenchmarkEmbedder;
}

/**
 * Pre-compute the in-memory re-embeddings and tokenisation needed by the
 * variants. After this call:
 *
 *   - `entry.bodyVector` is populated (if it was null, we embed the body).
 *   - `entry.descBodyVector` is populated (in memory).
 *   - `entry.descVector` is populated (in memory).
 *   - `entry.bodyTokens` is populated.
 *
 * Does NOT write to disk -- the alternate vectors live only in process
 * memory for the duration of the benchmark run.
 */
export const buildBenchmarkInputs = async (
  opts: BuildBenchmarkInputsOptions,
): Promise<BenchmarkInputs> => {
  const { corpus, pairs, embedder } = opts;
  for (const entry of corpus) {
    if (entry.bodyVector === null) {
      entry.bodyVector = await embedder.embed(entry.body);
    }
    entry.descBodyVector = await embedder.embed(`${entry.description}\n${entry.body}`);
    entry.descVector = await embedder.embed(entry.description);
    entry.bodyTokens = tokenize(entry.body);
  }
  return {
    corpus,
    pairs,
    embedder,
    bodyTokensList: corpus.map((c) => c.bodyTokens!),
  };
};

/** The six variants required by the contract envelope, in pinned order. */
export const ALL_VARIANTS = [
  'cosine-body',
  'cosine-description-plus-body',
  'cosine-description',
  'bm25',
  'bm25-cosine-hybrid',
  'cross-encoder-rerank',
] as const;

export type Variant = (typeof ALL_VARIANTS)[number];

export interface RunVariantOpts {
  variant: Variant;
  inputs: BenchmarkInputs;
  /**
   * BM25 weight in the `bm25-cosine-hybrid` variant. Cosine weight is
   * `1 - weight`. Defaults to 0.5.
   */
  hybridWeight?: number;
}

export interface VariantResult {
  variant: Variant;
  /** One ranked-query entry per labeled pair. Empty when `deferred === true`. */
  queries: RankedQuery[];
  /** True when the variant was deferred (e.g. cross-encoder-rerank). */
  deferred: boolean;
  /** Human-readable reason when `deferred === true`; null otherwise. */
  deferralReason: string | null;
  /** Configurable parameters surfaced for the docs output. */
  parameters: Record<string, string | number | boolean>;
}

/**
 * Run a single variant over the pre-built inputs and return one ranked
 * query per labeled pair. Each ranked list is over corpus filenames in
 * descending score order.
 */
export const runVariant = async (opts: RunVariantOpts): Promise<VariantResult> => {
  const { variant, inputs } = opts;
  switch (variant) {
    case 'cosine-body':
      return runCosineVariant(variant, inputs, (e) => e.bodyVector ?? null);
    case 'cosine-description-plus-body':
      return runCosineVariant(variant, inputs, (e) => e.descBodyVector ?? null);
    case 'cosine-description':
      return runCosineVariant(variant, inputs, (e) => e.descVector ?? null);
    case 'bm25':
      return runBm25Variant(variant, inputs);
    case 'bm25-cosine-hybrid':
      return runHybridVariant(variant, inputs, opts.hybridWeight ?? 0.5);
    case 'cross-encoder-rerank':
      return {
        variant,
        queries: [],
        deferred: true,
        deferralReason:
          'No local ONNX cross-encoder rerank model ships with the project ' +
          '(e.g. Xenova/ms-marco-MiniLM-L-12-v2 is not present in the ' +
          'transformers.js model cache). Running it would require ' +
          'downloading a model on first benchmark run, which the contract ' +
          'permits deferring rather than introducing a network dependency.',
        parameters: {},
      };
  }
};

// --- cosine variants --------------------------------------------------------

const runCosineVariant = async (
  variant: Variant,
  inputs: BenchmarkInputs,
  getVector: (e: BenchmarkCorpusEntry) => Float32Array | null,
): Promise<VariantResult> => {
  const queries: RankedQuery[] = [];
  for (const pair of inputs.pairs) {
    const qVec = await inputs.embedder.embed(pair.query);
    const scored: Array<{ filename: string; score: number }> = [];
    for (const entry of inputs.corpus) {
      const vec = getVector(entry);
      if (vec === null) continue;
      scored.push({ filename: entry.filename, score: dot(qVec, vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    queries.push({
      expected_names: pair.expected_names,
      ranked_names: scored.map((s) => s.filename),
    });
  }
  return {
    variant,
    queries,
    deferred: false,
    deferralReason: null,
    parameters: { embedderModelId: inputs.embedder.modelId },
  };
};

// --- BM25 -------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Standard ASCII word tokenizer: lowercase, split on non-word boundary. */
export const tokenize = (text: string): string[] => {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
};

/**
 * Compute the BM25 score of a document for a query. The corpus is needed
 * to compute IDF and average document length.
 */
export const bm25Score = (
  queryTokens: string[],
  docTokens: string[],
  corpusTokens: string[][],
): number => {
  const N = corpusTokens.length;
  const avgLen = corpusTokens.reduce((acc, doc) => acc + doc.length, 0) / Math.max(N, 1);
  const docLen = docTokens.length;
  const docTf = new Map<string, number>();
  for (const t of docTokens) docTf.set(t, (docTf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTokens) {
    const tf = docTf.get(term) ?? 0;
    if (tf === 0) continue;
    let df = 0;
    for (const doc of corpusTokens) if (doc.includes(term)) df += 1;
    if (df === 0) continue;
    // Standard BM25 IDF: log(1 + (N - df + 0.5) / (df + 0.5))
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const num = tf * (BM25_K1 + 1);
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / Math.max(avgLen, 1));
    score += idf * (num / denom);
  }
  return score;
};

const runBm25Variant = async (
  variant: Variant,
  inputs: BenchmarkInputs,
): Promise<VariantResult> => {
  const queries: RankedQuery[] = [];
  for (const pair of inputs.pairs) {
    const qTokens = tokenize(pair.query);
    const scored: Array<{ filename: string; score: number }> = [];
    for (const entry of inputs.corpus) {
      const score = bm25Score(qTokens, entry.bodyTokens ?? [], inputs.bodyTokensList);
      scored.push({ filename: entry.filename, score });
    }
    scored.sort((a, b) => b.score - a.score);
    queries.push({
      expected_names: pair.expected_names,
      ranked_names: scored.map((s) => s.filename),
    });
  }
  return {
    variant,
    queries,
    deferred: false,
    deferralReason: null,
    parameters: { k1: BM25_K1, b: BM25_B, field: 'body' },
  };
};

// --- BM25 + cosine hybrid ---------------------------------------------------

/**
 * Hybrid scoring: `weight * bm25 + (1 - weight) * cosine`. Both inputs
 * are assumed to be per-query min-max-normalised by the caller (so the
 * weight is meaningful regardless of absolute scale).
 */
export const hybridScore = (bm25: number, cosine: number, weight: number): number => {
  return weight * bm25 + (1 - weight) * cosine;
};

const minMaxNormalise = (scores: number[]): number[] => {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) return scores.map(() => 0);
  return scores.map((s) => (s - min) / (max - min));
};

const runHybridVariant = async (
  variant: Variant,
  inputs: BenchmarkInputs,
  weight: number,
): Promise<VariantResult> => {
  const queries: RankedQuery[] = [];
  for (const pair of inputs.pairs) {
    const qTokens = tokenize(pair.query);
    const qVec = await inputs.embedder.embed(pair.query);
    const bm25Scores: number[] = [];
    const cosineScores: number[] = [];
    for (const entry of inputs.corpus) {
      bm25Scores.push(bm25Score(qTokens, entry.bodyTokens ?? [], inputs.bodyTokensList));
      const vec = entry.bodyVector;
      cosineScores.push(vec === null ? 0 : dot(qVec, vec));
    }
    const bm25Norm = minMaxNormalise(bm25Scores);
    const cosNorm = minMaxNormalise(cosineScores);
    const scored: Array<{ filename: string; score: number }> = [];
    for (let i = 0; i < inputs.corpus.length; i++) {
      scored.push({
        filename: inputs.corpus[i]!.filename,
        score: hybridScore(bm25Norm[i]!, cosNorm[i]!, weight),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    queries.push({
      expected_names: pair.expected_names,
      ranked_names: scored.map((s) => s.filename),
    });
  }
  return {
    variant,
    queries,
    deferred: false,
    deferralReason: null,
    parameters: {
      bm25Weight: weight,
      cosineWeight: 1 - weight,
      normalisation: 'per-query min-max',
    },
  };
};

// --- math -------------------------------------------------------------------

const dot = (a: Float32Array, b: Float32Array): number => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};
