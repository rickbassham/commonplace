/**
 * Tests for the retrieval-variant runners under `scripts/retrieval-variants.ts`.
 *
 * Each variant turns a labeled query into a ranked list of candidate
 * memory filenames using a different scoring strategy. The harness pins
 * the variant names and their semantics; this test suite asserts each
 * variant returns a non-empty ranked list of corpus filenames for at
 * least one realistic input. Metric values themselves are covered by
 * `retrieval-metrics.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildBenchmarkInputs,
  runVariant,
  type BenchmarkInputs,
  type BenchmarkCorpusEntry,
  type Variant,
  ALL_VARIANTS,
  bm25Score,
  hybridScore,
} from '../scripts/retrieval-variants.js';
import type { LabeledPair } from '../scripts/build-labeled-set.js';

/**
 * Deterministic stub embedder: maps the lowercased text into a 4-d vector
 * keyed on three "topic" tokens. Concrete enough that different fields
 * (body vs description) produce different vectors -- so cosine variants
 * actually differ in ranking when description differs from body.
 */
const stubEmbedder = {
  modelId: 'test/stub-4d',
  dim: 4,
  embed: async (text: string): Promise<Float32Array> => {
    const lc = text.toLowerCase();
    const out = new Float32Array(4);
    out[0] = lc.includes('fsync') ? 1 : 0;
    out[1] = lc.includes('apfs') ? 1 : 0;
    out[2] = lc.includes('release') ? 1 : 0;
    out[3] = lc.includes('canonical') ? 1 : 0;
    // Normalise to unit length so dot product == cosine.
    let norm = 0;
    for (let i = 0; i < out.length; i++) norm += out[i]! * out[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
    return out;
  },
};

const corpus: BenchmarkCorpusEntry[] = [
  {
    filename: 'macos_apfs_fsync_test_perf',
    name: 'macos_apfs_fsync_test_perf',
    description: 'fsync cost on APFS',
    body: 'On macOS APFS each fsync costs ~20 ms vs ~1 ms on Linux ext4.',
    bodyVector: null, // populated by buildBenchmarkInputs
  },
  {
    filename: 'feedback_release_artifacts_canonical_only',
    name: 'Release artifacts must come out of the canonical build pipeline',
    description: 'release pipeline must be canonical -- no hand-built shortcuts',
    body: 'Releases go through the canonical pipeline. No hand-built artifacts.',
    bodyVector: null,
  },
  {
    filename: 'commonplace_app_structure',
    name: 'commonplace_app_structure',
    description: 'directory layout and key components',
    body: 'src/embedder, src/store, src/server, src/bin.',
    bodyVector: null,
  },
];

const pairs: LabeledPair[] = [
  {
    query: 'fsync apfs performance',
    expected_names: ['macos_apfs_fsync_test_perf'],
    category: 'confirmed_hit',
  },
  {
    query: 'canonical release pipeline',
    expected_names: ['feedback_release_artifacts_canonical_only'],
    category: 'confirmed_hit',
  },
];

const buildInputs = async (): Promise<BenchmarkInputs> =>
  buildBenchmarkInputs({ corpus, pairs, embedder: stubEmbedder });

describe('ALL_VARIANTS contract', () => {
  it('includes the six variant names from the contract envelope', () => {
    expect(ALL_VARIANTS).toEqual([
      'cosine-body',
      'cosine-description-plus-body',
      'cosine-description',
      'bm25',
      'bm25-cosine-hybrid',
      'cross-encoder-rerank',
    ]);
  });
});

describe('buildBenchmarkInputs (ac-3, ac-5)', () => {
  it('populates each entry.bodyVector by embedding the body field only', async () => {
    const inputs = await buildInputs();
    for (const entry of inputs.corpus) {
      expect(entry.bodyVector).not.toBeNull();
      expect(entry.bodyVector!.length).toBe(stubEmbedder.dim);
    }
  });
});

describe('runVariant -- cosine-body (ac-3)', () => {
  it('produces a non-empty ranked list per query and ranks the body-matching entry first', async () => {
    const inputs = await buildInputs();
    const result = await runVariant({ variant: 'cosine-body', inputs });
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]!.ranked_names.length).toBeGreaterThan(0);
    // fsync apfs query: the fsync-body memory should rank first.
    expect(result.queries[0]!.ranked_names[0]).toBe('macos_apfs_fsync_test_perf');
  });
});

describe('runVariant -- cosine-description-plus-body (ac-3)', () => {
  it('produces a ranked list and may differ from cosine-body when description carries extra topical signal', async () => {
    const inputs = await buildInputs();
    const result = await runVariant({ variant: 'cosine-description-plus-body', inputs });
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]!.ranked_names.length).toBeGreaterThan(0);
  });
});

describe('runVariant -- cosine-description (ac-3)', () => {
  it('produces a ranked list using only the description field', async () => {
    const inputs = await buildInputs();
    const result = await runVariant({ variant: 'cosine-description', inputs });
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]!.ranked_names.length).toBeGreaterThan(0);
    // For "canonical release pipeline": the release-pipeline memory's
    // description has both "canonical" and "release" -- it must rank
    // first under cosine-description.
    expect(result.queries[1]!.ranked_names[0]).toBe('feedback_release_artifacts_canonical_only');
  });
});

describe('runVariant -- bm25 (ac-3)', () => {
  it('produces a ranked list using lexical BM25 over body', async () => {
    const inputs = await buildInputs();
    const result = await runVariant({ variant: 'bm25', inputs });
    expect(result.queries).toHaveLength(2);
    // bm25 on "fsync apfs performance" should hit the fsync-body entry.
    expect(result.queries[0]!.ranked_names[0]).toBe('macos_apfs_fsync_test_perf');
  });

  it('bm25Score is monotone non-decreasing as more query terms appear in the document', () => {
    const docTokens = ['fsync', 'apfs', 'performance', 'macos'];
    const corpusTokens = [docTokens, ['other', 'document']];
    const oneHit = bm25Score(['fsync'], docTokens, corpusTokens);
    const twoHits = bm25Score(['fsync', 'apfs'], docTokens, corpusTokens);
    expect(twoHits).toBeGreaterThan(oneHit);
  });
});

describe('runVariant -- bm25-cosine-hybrid (ac-3)', () => {
  it('produces a ranked list using a weighted sum of normalised BM25 and cosine scores', async () => {
    const inputs = await buildInputs();
    const result = await runVariant({
      variant: 'bm25-cosine-hybrid',
      inputs,
      hybridWeight: 0.5,
    });
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]!.ranked_names.length).toBeGreaterThan(0);
  });

  it('hybrid weight is configurable: weight=1 ignores cosine; weight=0 ignores bm25', () => {
    // The weight is on the BM25 side (1 - weight on cosine), per the
    // function signature. weight=1 -> hybrid == bm25; weight=0 -> hybrid == cosine.
    expect(hybridScore(0.8, 0.2, 1)).toBeCloseTo(0.8, 10);
    expect(hybridScore(0.8, 0.2, 0)).toBeCloseTo(0.2, 10);
    expect(hybridScore(0.8, 0.2, 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('runVariant -- cross-encoder-rerank (ac-3)', () => {
  it('returns a deferred result when no cross-encoder model is available, with a reason string', async () => {
    const inputs = await buildInputs();
    const result = await runVariant({ variant: 'cross-encoder-rerank', inputs });
    // Deferred shape: empty queries but a deferralReason explaining why.
    expect(result.deferred).toBe(true);
    expect(typeof result.deferralReason).toBe('string');
    expect(result.deferralReason!.length).toBeGreaterThan(0);
  });
});

describe('every emitted ranked_names entry is a corpus filename', () => {
  it.each(ALL_VARIANTS.filter((v) => v !== 'cross-encoder-rerank'))(
    'variant %s emits only corpus filenames',
    async (variant: Variant) => {
      const inputs = await buildInputs();
      const result = await runVariant({ variant, inputs, hybridWeight: 0.5 });
      const corpusFilenames = new Set(corpus.map((c) => c.filename));
      for (const q of result.queries) {
        for (const name of q.ranked_names) {
          expect(corpusFilenames.has(name)).toBe(true);
        }
      }
    },
  );
});
