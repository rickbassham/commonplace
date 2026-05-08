/**
 * DAR-917 contract tests.
 *
 * Behavioral tests for `MemoryStore.search(query, opts?)` -- brute-force
 * top-k cosine search over the in-memory index. Vectors in the store are
 * normalized at write time (DAR-916), so cosine reduces to a dot product.
 *
 * Test names mirror the contract envelope on DAR-917 (round 1, approved).
 *
 * The Embedder dependency is stubbed (no real model load) so these tests
 * run hermetically and quickly. Stubs return small deterministic vectors
 * so dot products and ordering can be hand-computed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Memory, type MemoryType, MEMORY_TYPES } from '../src/store/memory.js';
import { MemoryStore } from '../src/store/memory-store.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar917-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * L2-normalise a Float32Array in place and return it. Real embeddings in the
 * store are L2-normalised at write time so dot product == cosine; tests need
 * the same property for thresholds (which are described in cosine units) to
 * make sense.
 */
const l2norm = (v: Float32Array): Float32Array => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n > 0) {
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  }
  return v;
};

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/**
 * Programmable Embedder stub. Map-driven: each input string returns a
 * pre-registered vector (caller is responsible for normalisation). Falls back
 * to a zero vector for unknown inputs and tracks call count + inputs for
 * provenance assertions.
 */
const makeProgrammableEmbedder = (
  dim: number,
  registry: Map<string, Float32Array> = new Map(),
  modelId = 'Xenova/bge-base-en-v1.5',
): {
  modelId: string;
  dim: number;
  embed: (text: string) => Promise<Float32Array>;
  callCount: () => number;
  lastInputs: () => string[];
  register: (text: string, vector: Float32Array) => void;
} => {
  let callCount = 0;
  const inputs: string[] = [];
  const embed = vi.fn(async (text: string): Promise<Float32Array> => {
    callCount += 1;
    inputs.push(text);
    const v = registry.get(text);
    if (v) return new Float32Array(v); // copy so callers can't mutate fixture
    return new Float32Array(dim); // zero vector
  });
  return {
    modelId,
    dim,
    embed,
    callCount: () => callCount,
    lastInputs: () => inputs.slice(),
    register: (text, vector): void => {
      registry.set(text, vector);
    },
  };
};

const makeMemory = (
  name: string,
  body = `body of ${name}`,
  type: MemoryType = 'reference',
): Memory => ({
  name,
  description: `description for ${name}`,
  type,
  body,
});

/**
 * Save a memory through the store with a controlled vector. We register the
 * vector against the body text in the embedder registry, then call save() so
 * the store persists everything end-to-end.
 */
const saveWithVector = async (
  store: MemoryStore,
  embedder: ReturnType<typeof makeProgrammableEmbedder>,
  m: Memory,
  vector: Float32Array,
): Promise<void> => {
  embedder.register(m.body, vector);
  await store.save(m);
};

// -------------------------------------------------------------------------
// ac-1: method shape
// -------------------------------------------------------------------------

describe('ac-1: search method shape', () => {
  it('MemoryStore exposes `search` as an own async method that takes (query, opts?) and returns a Promise resolving to an array', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    expect(typeof store.search).toBe('function');
    const result = store.search('q');
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(Array.isArray(resolved)).toBe(true);
  });

  it('search() resolves to an array whose entries each have shape `{ memory: MemoryEntry, score: number }` where `memory` is the same object identity as the matching entry from `all()`', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    await saveWithVector(
      store,
      embedder,
      makeMemory('alpha'),
      l2norm(new Float32Array([1, 0, 0, 0])),
    );
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q');
    expect(results).toHaveLength(1);
    const [hit] = results;
    expect(hit).toBeDefined();
    expect(typeof hit!.score).toBe('number');
    expect(hit!.memory).toBeDefined();
    // Object identity must match the entry from all() -- the same MemoryEntry,
    // not a copy.
    const entries = store.all();
    expect(hit!.memory).toBe(entries[0]);
  });

  it('search() called with no `opts` argument behaves identically to search() called with `opts = {}`', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (const name of ['a', 'b', 'c']) {
      await saveWithVector(
        store,
        embedder,
        makeMemory(name, `body-${name}`),
        l2norm(new Float32Array([Math.random(), Math.random(), Math.random(), Math.random()])),
      );
    }
    embedder.register('query', l2norm(new Float32Array([1, 1, 1, 1])));

    const a = await store.search('query');
    const b = await store.search('query', {});
    expect(a.map((h) => [h.memory.name, h.score])).toEqual(b.map((h) => [h.memory.name, h.score]));
  });

  it('search() against an empty store returns an empty array without invoking the embedder', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    const before = embedder.callCount();
    const results = await store.search('anything');
    expect(results).toEqual([]);
    expect(embedder.callCount()).toBe(before);
  });
});

// -------------------------------------------------------------------------
// ac-2: default limit 5
// -------------------------------------------------------------------------

describe('ac-2: default limit', () => {
  it('search() with `opts.limit` omitted returns at most 5 results when more than 5 candidates exist', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (let i = 0; i < 8; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q');
    expect(results.length).toBe(5);
  });

  it('search() with explicit `opts.limit = 3` returns at most 3 results when more than 3 candidates exist', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (let i = 0; i < 8; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { limit: 3 });
    expect(results.length).toBe(3);
  });

  it('search() with `opts.limit` larger than the number of candidates returns all candidates (no padding, no error)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (let i = 0; i < 3; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { limit: 100 });
    expect(results.length).toBe(3);
  });

  it('search() with `opts.limit = 0` returns an empty array (still embeds the query exactly once)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (let i = 0; i < 3; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const before = embedder.callCount();
    const results = await store.search('q', { limit: 0 });
    expect(results).toEqual([]);
    expect(embedder.callCount() - before).toBe(1);
  });
});

// -------------------------------------------------------------------------
// ac-3: type filter
// -------------------------------------------------------------------------

describe('ac-3: type filter', () => {
  it("search() with `opts.type = 'feedback'` returns only entries whose `type === 'feedback'`", async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    let i = 0;
    for (const t of MEMORY_TYPES) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m_${t}`, `body-${t}`, t), v);
      i++;
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { type: 'feedback' });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.type).toBe('feedback');
  });

  it('search() with `opts.type` omitted returns entries across all four memory types (no implicit filter)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    let i = 0;
    for (const t of MEMORY_TYPES) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m_${t}`, `body-${t}`, t), v);
      i++;
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { limit: 10 });
    const returnedTypes = new Set(results.map((r) => r.memory.type));
    expect(returnedTypes.size).toBe(MEMORY_TYPES.length);
    for (const t of MEMORY_TYPES) {
      expect(returnedTypes.has(t)).toBe(true);
    }
  });

  it('search() with `opts.type` set to a type that no entry matches returns an empty array', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    // Only insert reference type entries.
    for (let i = 0; i < 3; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`, 'reference'), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { type: 'feedback' });
    expect(results).toEqual([]);
  });

  it('search() applies the type filter before the `limit` slice (limit counts only post-filter matches)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    // Insert 6 reference memories with high scores and 3 feedback memories
    // with lower scores. If the type filter applied AFTER the limit, default
    // limit 5 + filter would yield 0 feedback hits (because the top 5 by
    // score would all be reference). Filter-before-slice must yield 3.
    for (let i = 0; i < 6; i++) {
      const v = l2norm(new Float32Array([10, i / 10, 0, 0])); // high in slot 0
      await saveWithVector(store, embedder, makeMemory(`r${i}`, `r-body-${i}`, 'reference'), v);
    }
    for (let i = 0; i < 3; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0])); // lower in slot 0
      await saveWithVector(store, embedder, makeMemory(`f${i}`, `f-body-${i}`, 'feedback'), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { type: 'feedback' });
    expect(results.length).toBe(3);
    for (const r of results) expect(r.memory.type).toBe('feedback');
  });
});

// -------------------------------------------------------------------------
// ac-4: threshold filter
// -------------------------------------------------------------------------

describe('ac-4: threshold filter', () => {
  it('search() with `opts.threshold = t` drops every result whose `score < t` and keeps every result whose `score >= t`', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    // Use known unit vectors so dot product = cos(angle).
    const queryVec = l2norm(new Float32Array([1, 0, 0, 0]));
    embedder.register('q', queryVec);

    // Three planted candidates with hand-chosen cosines: 0.9, 0.5, 0.1.
    const planted = [
      { name: 'high', vec: l2norm(new Float32Array([0.9, Math.sqrt(1 - 0.81), 0, 0])) },
      { name: 'mid', vec: l2norm(new Float32Array([0.5, Math.sqrt(1 - 0.25), 0, 0])) },
      { name: 'low', vec: l2norm(new Float32Array([0.1, Math.sqrt(1 - 0.01), 0, 0])) },
    ];
    for (const p of planted) {
      await saveWithVector(store, embedder, makeMemory(p.name, `body-${p.name}`), p.vec);
    }

    const results = await store.search('q', { threshold: 0.4 });
    // Should include high (0.9) and mid (0.5), drop low (0.1).
    const names = results.map((r) => r.memory.name).sort();
    expect(names).toEqual(['high', 'mid']);
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(0.4);
  });

  it('search() with `opts.threshold` omitted returns results regardless of score (including negative dot products)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    const queryVec = l2norm(new Float32Array([1, 0, 0, 0]));
    embedder.register('q', queryVec);

    // Plant a memory whose vector is anti-parallel: dot product = -1.
    await saveWithVector(
      store,
      embedder,
      makeMemory('opposite'),
      l2norm(new Float32Array([-1, 0, 0, 0])),
    );

    const results = await store.search('q');
    expect(results.length).toBe(1);
    expect(results[0]!.score).toBeLessThan(0);
  });

  it('search() applies the threshold cutoff before the `limit` slice (limit counts only post-threshold matches)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    // 8 entries with high cosines (close to 1): should default-limit to 5
    // *after* threshold filtering. Plant 3 below-threshold and 8 above-threshold
    // entries, set threshold to 0.5, default limit (5). The 3 below must not
    // count toward the limit; we should still get 5 results, all above 0.5.
    for (let i = 0; i < 8; i++) {
      const c = 0.6 + i * 0.01; // 0.6, 0.61, ...
      const v = l2norm(new Float32Array([c, Math.sqrt(1 - c * c), 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`hi${i}`, `hi-${i}`), v);
    }
    for (let i = 0; i < 3; i++) {
      const c = 0.1 + i * 0.05; // well below 0.5
      const v = l2norm(new Float32Array([c, Math.sqrt(1 - c * c), 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`lo${i}`, `lo-${i}`), v);
    }

    const results = await store.search('q', { threshold: 0.5 });
    expect(results.length).toBe(5);
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(0.5);
  });

  it("search() with a `threshold` higher than every candidate's score returns an empty array", async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    for (let i = 0; i < 5; i++) {
      const c = 0.1 + i * 0.05;
      const v = l2norm(new Float32Array([c, Math.sqrt(1 - c * c), 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }

    const results = await store.search('q', { threshold: 0.9 });
    expect(results).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// ac-5: ranking semantics
// -------------------------------------------------------------------------

describe('ac-5: ranking semantics', () => {
  it('search() invokes `embedder.embed(query)` exactly once per call with the query string passed through verbatim', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (let i = 0; i < 3; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    const before = embedder.callCount();
    const queryString = 'this  is  the   exact query  ';
    embedder.register(queryString, l2norm(new Float32Array([1, 0, 0, 0])));

    await store.search(queryString, { limit: 2 });
    expect(embedder.callCount() - before).toBe(1);
    const inputs = embedder.lastInputs();
    expect(inputs[inputs.length - 1]).toBe(queryString);
  });

  it("search() computes each candidate's `score` as the dot product of the query vector and `entry.vector` (asserted against a hand-computed expected score on a fixture)", async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    const candidateVec = new Float32Array([0.6, 0.8, 0.0, 0.0]); // already unit
    const queryVec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
    await saveWithVector(store, embedder, makeMemory('alpha'), candidateVec);
    embedder.register('q', queryVec);

    const results = await store.search('q');
    expect(results).toHaveLength(1);
    // Hand-computed: 1*0.6 + 0*0.8 + 0 + 0 = 0.6
    const expected = dot(queryVec, candidateVec);
    expect(results[0]!.score).toBeCloseTo(expected, 6);
    expect(results[0]!.score).toBeCloseTo(0.6, 6);
  });

  it('search() returns results sorted by `score` in strictly descending order', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    // 6 distinct cosines, inserted in non-sorted order.
    const cosines = [0.2, 0.9, 0.4, 0.7, 0.1, 0.5];
    for (let i = 0; i < cosines.length; i++) {
      const c = cosines[i]!;
      const v = l2norm(new Float32Array([c, Math.sqrt(1 - c * c), 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { limit: cosines.length });
    expect(results.length).toBe(cosines.length);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
    // And not reversed -- top result is the highest planted cosine.
    expect(results[0]!.score).toBeCloseTo(0.9, 6);
  });

  it('search() ranks candidates over the full `all()` set (the lowest-scoring planted entry still appears in results when `limit` is large enough to include it)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    // 7 candidates, distinct cosines, inserted out-of-order. We then set
    // limit large enough to include the worst-scoring entry. If search()
    // truncates the set before sorting (say, takes the first N entries from
    // all() and ranks only those), the lowest-scoring one would not appear
    // in results.
    const cosines = [0.95, 0.05, 0.7, 0.3, 0.5, 0.85, 0.15];
    for (let i = 0; i < cosines.length; i++) {
      const c = cosines[i]!;
      const v = l2norm(new Float32Array([c, Math.sqrt(1 - c * c), 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const results = await store.search('q', { limit: cosines.length });
    const names = new Set(results.map((r) => r.memory.name));
    // Every planted name must be present.
    for (let i = 0; i < cosines.length; i++) {
      expect(names.has(`m${i}`)).toBe(true);
    }
  });

  it('search() does not call `embedder.embed` for any candidate body — only the query is embedded at search time (candidate vectors come from the in-memory entries)', async () => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });
    for (let i = 0; i < 5; i++) {
      const v = l2norm(new Float32Array([1, i / 10, 0, 0]));
      await saveWithVector(store, embedder, makeMemory(`m${i}`, `body-${i}`), v);
    }

    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    const before = embedder.callCount();
    await store.search('q');
    const after = embedder.callCount();
    expect(after - before).toBe(1);
    // The single new input must be the query, not any body.
    const inputs = embedder.lastInputs();
    const lastInput = inputs[inputs.length - 1];
    expect(lastInput).toBe('q');
    for (let i = 0; i < 5; i++) {
      expect(lastInput).not.toBe(`body-${i}`);
    }
  });
});

// -------------------------------------------------------------------------
// ac-6: synthetic-corpus end-to-end tests
// -------------------------------------------------------------------------

describe('ac-6: synthetic corpus', () => {
  /**
   * Build a planted-fixture corpus of 10 unit vectors in 4-D where each
   * candidate has a near-duplicate match with one of three queries. Returned
   * as a setup callable so each test gets a fresh store.
   */
  const buildCorpus = async (): Promise<{
    embedder: ReturnType<typeof makeProgrammableEmbedder>;
    store: MemoryStore;
    queries: { name: 'A' | 'B' | 'C'; text: string; vec: Float32Array }[];
    plantedTopFor: Record<'A' | 'B' | 'C', string>;
  }> => {
    const embedder = makeProgrammableEmbedder(4);
    const store = new MemoryStore({ dir: tmp, embedder });

    // Three orthogonal-ish query directions.
    const dirA = l2norm(new Float32Array([1, 0, 0, 0]));
    const dirB = l2norm(new Float32Array([0, 1, 0, 0]));
    const dirC = l2norm(new Float32Array([0, 0, 1, 0]));

    // Plant near-duplicates for each query (cosine ~ 0.99) and a handful
    // of "noise" entries pointing in scattered directions.
    const corpus: {
      name: string;
      type: MemoryType;
      vec: Float32Array;
    }[] = [
      // Near-duplicates
      { name: 'top_a', type: 'reference', vec: l2norm(new Float32Array([0.99, 0.1, 0.05, 0.05])) },
      { name: 'top_b', type: 'reference', vec: l2norm(new Float32Array([0.05, 0.99, 0.1, 0.05])) },
      { name: 'top_c', type: 'reference', vec: l2norm(new Float32Array([0.05, 0.1, 0.99, 0.05])) },
      // Mid-similarity (some component of A but lower than top_a)
      { name: 'mid_a1', type: 'feedback', vec: l2norm(new Float32Array([0.6, 0.4, 0.4, 0.4])) },
      { name: 'mid_b1', type: 'feedback', vec: l2norm(new Float32Array([0.3, 0.7, 0.3, 0.3])) },
      // Low-similarity / noise
      { name: 'noise1', type: 'project', vec: l2norm(new Float32Array([0.1, 0.1, 0.1, 1.0])) },
      { name: 'noise2', type: 'project', vec: l2norm(new Float32Array([0.2, 0.2, 0.2, 0.9])) },
      { name: 'noise3', type: 'user', vec: l2norm(new Float32Array([0.3, 0.3, 0.3, 0.8])) },
      { name: 'noise4', type: 'user', vec: l2norm(new Float32Array([0.0, 0.0, 0.1, 1.0])) },
      { name: 'noise5', type: 'reference', vec: l2norm(new Float32Array([0.1, 0.0, 0.0, 1.0])) },
    ];

    for (const c of corpus) {
      await saveWithVector(store, embedder, makeMemory(c.name, `body-${c.name}`, c.type), c.vec);
    }

    embedder.register('query-a', dirA);
    embedder.register('query-b', dirB);
    embedder.register('query-c', dirC);

    return {
      embedder,
      store,
      queries: [
        { name: 'A', text: 'query-a', vec: dirA },
        { name: 'B', text: 'query-b', vec: dirB },
        { name: 'C', text: 'query-c', vec: dirC },
      ],
      plantedTopFor: { A: 'top_a', B: 'top_b', C: 'top_c' },
    };
  };

  it('synthetic corpus of ~10 memories ranks the planted near-duplicate of query A as the top result', async () => {
    const { store, queries, plantedTopFor } = await buildCorpus();
    const q = queries.find((qq) => qq.name === 'A')!;
    const results = await store.search(q.text);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.name).toBe(plantedTopFor.A);
  });

  it("synthetic corpus of ~10 memories ranks the planted near-duplicate of query B as the top result (different from query A's top)", async () => {
    const { store, queries, plantedTopFor } = await buildCorpus();
    const q = queries.find((qq) => qq.name === 'B')!;
    const results = await store.search(q.text);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.name).toBe(plantedTopFor.B);
    expect(plantedTopFor.B).not.toBe(plantedTopFor.A);
  });

  it('synthetic corpus of ~10 memories ranks the planted near-duplicate of query C as the top result (different from queries A and B)', async () => {
    const { store, queries, plantedTopFor } = await buildCorpus();
    const q = queries.find((qq) => qq.name === 'C')!;
    const results = await store.search(q.text);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.name).toBe(plantedTopFor.C);
    expect(plantedTopFor.C).not.toBe(plantedTopFor.A);
    expect(plantedTopFor.C).not.toBe(plantedTopFor.B);
  });

  it('synthetic corpus search with `type` filter narrows the returned set to entries of that type only while preserving descending score order', async () => {
    const { store, queries } = await buildCorpus();
    const q = queries.find((qq) => qq.name === 'A')!;
    const results = await store.search(q.text, { type: 'feedback', limit: 10 });
    // Only feedback entries.
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.memory.type).toBe('feedback');
    // Descending score order.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it('synthetic corpus search with a mid-range `threshold` drops the planted low-similarity entries and retains the planted high-similarity entries', async () => {
    const { store, queries } = await buildCorpus();
    const q = queries.find((qq) => qq.name === 'A')!;
    // Threshold midway between top_a's near-1.0 score and the noise entries'
    // ~0.1 scores. mid_a1's projection on dirA is ~0.6 (after norm), so 0.5
    // keeps top_a and mid_a1, drops the noise/low entries.
    const results = await store.search(q.text, { threshold: 0.5, limit: 10 });
    const names = new Set(results.map((r) => r.memory.name));
    expect(names.has('top_a')).toBe(true);
    // Noise must not appear.
    for (const noise of ['noise1', 'noise2', 'noise3', 'noise4', 'noise5']) {
      expect(names.has(noise)).toBe(false);
    }
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(0.5);
  });
});
