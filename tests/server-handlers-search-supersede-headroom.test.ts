/**
 * Unit tests for DAR-959: per-store `searchOpts.limit` headroom is bounded by
 * `supersededCount` rather than scaling with corpus size.
 *
 * Covers contract DAR-959:
 *   - ac-1: headroom equals (callerLimit ?? fallbackLimit) + supersededCount
 *           when filtering superseded entries; when `includeSuperseded: true`
 *           the expansion is skipped; when supersededCount === 0, no
 *           headroom is added.
 *   - ac-3: with corpus=100 and N superseded entries and callerLimit=5,
 *           the store-side limit is bounded to 5 + N (provably < 100).
 *
 * Spy strategy: wrap `MemoryStore.prototype.search` once per test, capture
 * the `SearchOptions` argument that the handler passes through, and assert
 * directly. We do NOT mutate the store's return value -- the wrapped method
 * still delegates to the real implementation so post-search semantics
 * (supersede filter, totalScanned) remain end-to-end correct.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemoryStore,
  DEFAULT_SEARCH_LIMIT,
  type SearchOptions,
  type SearchHit,
} from '../src/store/memory-store.js';
import { createMemorySearchHandler } from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar959-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const l2norm = (v: Float32Array): Float32Array => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n > 0) {
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  }
  return v;
};

const makeProgrammableEmbedder = (dim = 4) => {
  const registry = new Map<string, Float32Array>();
  return {
    modelId: 'Xenova/bge-base-en-v1.5',
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      const v = registry.get(text);
      if (v) return new Float32Array(v);
      const out = new Float32Array(dim);
      let acc = 0;
      for (let i = 0; i < text.length; i++) acc += text.charCodeAt(i);
      out[0] = (acc % 13) / 13;
      for (let i = 1; i < dim; i++) out[i] = ((acc + i) % 17) / 17;
      return l2norm(out);
    },
    register: (text: string, vector: Float32Array): void => {
      registry.set(text, vector);
    },
  };
};

/**
 * Wrap `store.search` with a spy that records the SearchOptions it sees,
 * then delegates to the original method. Returns the recorder so each test
 * can assert on the captured `limit`.
 */
const spyOnSearch = (store: MemoryStore): { calls: SearchOptions[]; restore: () => void } => {
  const calls: SearchOptions[] = [];
  const original = store.search.bind(store);
  const spy = async (query: string, opts: SearchOptions = {}): Promise<SearchHit[]> => {
    // Capture a shallow copy so any later in-place mutation by the handler
    // cannot retroactively change what we observed.
    calls.push({ ...opts });
    return original(query, opts);
  };
  (store as unknown as { search: typeof spy }).search = spy;
  return {
    calls,
    restore: () => {
      (store as unknown as { search: typeof original }).search = original;
    },
  };
};

/**
 * Seed a corpus of `totalCount` simple reference memories, with the FIRST
 * `supersededCount` of them superseded by a single trailing entry whose
 * `supersedes` frontmatter lists them.
 *
 * The trailing entry is NOT counted toward `totalCount` -- callers wanting
 * exactly N entries on disk should pass `totalCount = N - 1` and account for
 * the trailing superseder explicitly, or just check `store.all().length`.
 */
const seedCorpus = async (
  store: MemoryStore,
  embedder: ReturnType<typeof makeProgrammableEmbedder>,
  totalCount: number,
  supersededCount: number,
): Promise<void> => {
  if (supersededCount > totalCount) {
    throw new Error('supersededCount cannot exceed totalCount');
  }
  await store.scan();
  // Pin the query and a tight cluster of body vectors so every entry is a
  // plausible hit; the supersede filter is then the only thing distinguishing
  // them from the trailing superseder.
  embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
  const supersededNames: string[] = [];
  for (let i = 0; i < totalCount; i++) {
    const name = `e${i.toString().padStart(4, '0')}`;
    const body = `body_${name}`;
    embedder.register(body, l2norm(new Float32Array([1, 0.0001 * i, 0, 0])));
    await store.save({ name, type: 'reference', description: 'd', body });
    if (i < supersededCount) supersededNames.push(name);
  }
  if (supersededCount > 0) {
    embedder.register('body_super', l2norm(new Float32Array([0.99, 0.01, 0, 0])));
    await store.save({
      name: 'super',
      type: 'reference',
      description: 'super',
      body: 'body_super',
      supersedes: supersededNames,
    });
  }
};

describe('DAR-959 ac-1: per-store searchOpts.limit no longer scales with corpus size', () => {
  it('with callerLimit set and corpusSize >> callerLimit + supersededCount, the SearchOptions.limit passed to store.search equals callerLimit + supersededCount', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await seedCorpus(store, embedder, 50, 3);
    // Corpus on disk is 50 base + 1 trailing superseder = 51. Caller limit is
    // 5, supersededCount is 3, so expected store limit is 5 + 3 = 8 -- far
    // less than the corpus size of 51.
    expect(store.all().length).toBe(51);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q', limit: 5 });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBe(8);
    expect(spy.calls[0]!.limit!).toBeLessThan(store.all().length);
  });

  it('with callerLimit omitted and corpusSize >> fallbackLimit + supersededCount, the SearchOptions.limit passed to store.search equals fallbackLimit + supersededCount', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await seedCorpus(store, embedder, 50, 3);
    expect(store.all().length).toBe(51);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q' });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    // fallbackLimit is DEFAULT_SEARCH_LIMIT (5) when no defaultLimit is wired.
    expect(spy.calls[0]!.limit).toBe(DEFAULT_SEARCH_LIMIT + 3);
    expect(spy.calls[0]!.limit!).toBeLessThan(store.all().length);
  });

  it('with includeSuperseded: true, the headroom expansion is skipped: SearchOptions.limit equals callerLimit regardless of corpus size', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await seedCorpus(store, embedder, 50, 3);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q', limit: 5, includeSuperseded: true });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBe(5);
  });

  it('with includeSuperseded: true and callerLimit undefined, SearchOptions.limit is omitted regardless of corpus size', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await seedCorpus(store, embedder, 50, 3);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q', includeSuperseded: true });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBeUndefined();
  });

  it('with supersededCount === 0, the SearchOptions.limit equals callerLimit with no headroom added', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await seedCorpus(store, embedder, 20, 0);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q', limit: 5 });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBe(5);
  });

  it('with supersededCount === 0 and callerLimit undefined, the SearchOptions.limit is omitted (no headroom added; preserves the baseline "omits unset SearchOptions fields" contract)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await seedCorpus(store, embedder, 20, 0);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q' });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBeUndefined();
  });
});

describe('DAR-959 ac-3: bound is a function of supersededCount, not a hard-coded constant', () => {
  it('corpus of 100 entries with N=3 superseded and callerLimit=5: SearchOptions.limit passed to store.search equals 5 + 3 = 8 (and is < 100)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    // 99 base + 1 trailing superseder = 100 entries on disk; 3 superseded.
    await seedCorpus(store, embedder, 99, 3);
    expect(store.all().length).toBe(100);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q', limit: 5 });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBe(8);
    expect(spy.calls[0]!.limit!).toBeLessThan(100);
  });

  it('corpus of 100 entries with N=10 superseded and callerLimit=5: SearchOptions.limit passed to store.search equals 5 + 10 = 15 (proves bound scales with supersededCount, not a constant)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    // 99 base + 1 trailing superseder = 100 entries on disk; 10 superseded.
    await seedCorpus(store, embedder, 99, 10);
    expect(store.all().length).toBe(100);

    const spy = spyOnSearch(store);
    try {
      const handler = createMemorySearchHandler({ store });
      await handler({ query: 'q', limit: 5 });
    } finally {
      spy.restore();
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.limit).toBe(15);
    expect(spy.calls[0]!.limit!).toBeLessThan(100);
  });
});
