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
  it('includes cosine-desc-body-max and cosine-desc-body-mean in addition to the six existing variant names (DAR-1210 ac-2)', () => {
    expect(ALL_VARIANTS).toEqual([
      'cosine-body',
      'cosine-description-plus-body',
      'cosine-description',
      'cosine-desc-body-max',
      'cosine-desc-body-mean',
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

describe('runVariant -- desc/body fusion (DAR-1210 ac-2)', () => {
  /**
   * Registry-keyed stub embedder: each exact input string maps to a
   * pre-registered unit vector; unregistered inputs embed to the zero
   * vector. Lets the fixtures pin per-channel cosines exactly.
   */
  const makeRegistryEmbedder = (
    dim: number,
    entries: Array<[string, number[]]>,
  ): { modelId: string; dim: number; embed: (text: string) => Promise<Float32Array> } => {
    const registry = new Map(entries.map(([k, v]) => [k, Float32Array.from(v)]));
    return {
      modelId: 'test/registry-4d',
      dim,
      embed: async (text: string): Promise<Float32Array> =>
        new Float32Array(registry.get(text) ?? new Float32Array(dim)),
    };
  };

  /**
   * Fixture pinned for both fusion rules. Query is the unit x-axis.
   *
   *   - desc_only_hit: desc cosine 1.0, body cosine 0.0
   *       -> max = 1.0, mean = 0.5
   *   - balanced:      desc cosine 0.6, body cosine 0.6
   *       -> max = 0.6, mean = 0.6
   *
   * Under max-fusion desc_only_hit ranks first; under mean-fusion the
   * hand-computed means (0.5 vs 0.6) put balanced first. The flip is what
   * pins the arithmetic-mean rule (a max implementation would rank
   * desc_only_hit first in both).
   */
  const fusionFixture = async (): Promise<BenchmarkInputs> => {
    const embedder = makeRegistryEmbedder(4, [
      ['fusion query', [1, 0, 0, 0]],
      ['desc-only-hit description', [1, 0, 0, 0]],
      ['desc-only-hit body', [0, 1, 0, 0]], // orthogonal to the query
      ['balanced description', [0.6, 0.8, 0, 0]],
      ['balanced body', [0.6, 0, 0.8, 0]],
    ]);
    const fusionCorpus: BenchmarkCorpusEntry[] = [
      {
        filename: 'desc_only_hit',
        name: 'desc_only_hit',
        description: 'desc-only-hit description',
        body: 'desc-only-hit body',
        bodyVector: null,
      },
      {
        filename: 'balanced',
        name: 'balanced',
        description: 'balanced description',
        body: 'balanced body',
        bodyVector: null,
      },
    ];
    const fusionPairs: LabeledPair[] = [
      { query: 'fusion query', expected_names: ['desc_only_hit'], category: 'confirmed_hit' },
    ];
    return buildBenchmarkInputs({ corpus: fusionCorpus, pairs: fusionPairs, embedder });
  };

  it('cosine-desc-body-max ranks first an entry whose description vector matches the query even when its body vector is orthogonal', async () => {
    const inputs = await fusionFixture();
    const result = await runVariant({ variant: 'cosine-desc-body-max', inputs });
    expect(result.deferred).toBe(false);
    expect(result.queries).toHaveLength(1);
    // max(desc=1.0, body=0.0) = 1.0 beats max(0.6, 0.6) = 0.6.
    expect(result.queries[0]!.ranked_names).toEqual(['desc_only_hit', 'balanced']);
  });

  it('cosine-desc-body-mean scores each entry as the arithmetic mean of the description and body cosines (hand-computed expected score)', async () => {
    const inputs = await fusionFixture();
    const result = await runVariant({ variant: 'cosine-desc-body-mean', inputs });
    expect(result.deferred).toBe(false);
    expect(result.queries).toHaveLength(1);
    // Hand-computed means: desc_only_hit = (1.0 + 0.0) / 2 = 0.5;
    // balanced = (0.6 + 0.6) / 2 = 0.6. Mean-fusion must rank balanced
    // first -- the opposite of max-fusion on the same fixture, which pins
    // the arithmetic-mean rule rather than any max-like fallback.
    expect(result.queries[0]!.ranked_names).toEqual(['balanced', 'desc_only_hit']);
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
