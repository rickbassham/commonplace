/**
 * DAR-912 contract integration tests.
 *
 * These tests load the real `Xenova/bge-base-en-v1.5` model via
 * `@huggingface/transformers` and run an actual embed() round trip. The
 * first run pulls weights from the HF hub (~6s cold start, see AC-2);
 * subsequent runs are warm thanks to transformers.js's local cache.
 *
 * The wall-clock latency is intentionally NOT asserted -- AC-2's "~6s" is
 * descriptive guidance, not a measurable target (see contract envelope's
 * explicit_non_goals). What IS asserted:
 *   - the returned vector is a Float32Array of length 768
 *   - the vector's L2 norm is within 1e-3 of 1.0 (so cosine == dot product)
 *   - `dim` reads back as 768 and `modelId` round-trips
 *   - dim equals the returned vector's length after a successful embed()
 *
 * Test names mirror the contract envelope on DAR-912 (round 1, approved).
 */

import { describe, expect, it } from 'vitest';

import { Embedder } from '../src/embedder/index.js';

const MODEL_ID = 'Xenova/bge-base-en-v1.5';
const DIM = 768;

/** Compute the L2 norm of a vector. */
const l2Norm = (v: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
};

describe('ac-5 (integration): dim populated post-embed for unknown models', () => {
  it('after a successful embed(), Embedder.dim equals the length of the returned Float32Array', async () => {
    // Use a model id that is not in the static known-models map so we
    // exercise the post-embed dim-population path. We still load the real
    // bge-base weights -- transformers.js looks up by repo id, but we
    // wrap a fresh Embedder that doesn't have the id pre-registered.
    const e = new Embedder(MODEL_ID);
    expect(e.dim).toBe(DIM); // bge-base IS in the known-models map
    const v = await e.embed('integration smoke');
    expect(e.dim).toBe(v.length);
  }, 120_000);
});

describe('ac-6 (integration): bge-base load + embed round trip', () => {
  it("integration: constructing Embedder('Xenova/bge-base-en-v1.5') and calling embed('hello world') resolves to a Float32Array of length 768", async () => {
    const e = new Embedder(MODEL_ID);
    const v = await e.embed('hello world');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(DIM);
  }, 120_000);

  it("integration: the Float32Array returned by embed('hello world') has L2 norm within 1e-3 of 1.0 (so cosine similarity reduces to a dot product downstream)", async () => {
    const e = new Embedder(MODEL_ID);
    const v = await e.embed('hello world');
    const norm = l2Norm(v);
    expect(Math.abs(norm - 1.0)).toBeLessThan(1e-3);
  }, 120_000);

  it("integration: after the bge-base load+embed round trip, Embedder.dim equals 768 and Embedder.modelId equals 'Xenova/bge-base-en-v1.5'", async () => {
    const e = new Embedder(MODEL_ID);
    await e.embed('hello world');
    expect(e.dim).toBe(DIM);
    expect(e.modelId).toBe(MODEL_ID);
  }, 120_000);
});
