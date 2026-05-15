/**
 * ac-10 regression guard: memory_search ranking output is unchanged
 * before vs. after the pinned-recall pack feature lands. Toggling the
 * `pinned` flag on a memory does not affect its rank, score, or
 * inclusion in the search response -- the new flag participates only
 * in `instructions` rendering.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { createMemorySearchHandler } from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar1003r-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const makeStubEmbedder = (modelId = 'Xenova/bge-base-en-v1.5', dim = 4) => {
  let count = 0;
  return {
    modelId,
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      count += 1;
      const out = new Float32Array(dim);
      out[0] = count;
      for (let i = 1; i < dim; i++) out[i] = (i + (text.length % 7)) / 10;
      return out;
    },
  };
};

const makeStore = (): MemoryStore => new MemoryStore({ dir: tmp, embedder: makeStubEmbedder() });

interface SearchResponse {
  matches: Array<{ name: string; score: number }>;
}

describe('ac-10: memory_search ranking is unchanged by the pinned flag', () => {
  it('memory_search ranking output on a fixture is unchanged before vs. after this change (regression guard against the ranking path being touched)', async () => {
    const store = makeStore();
    await store.scan();
    // Three deterministic memories. The names contain different text so
    // the stub embedder produces distinguishable vectors; pinning is
    // toggled on a subset.
    await store.save({
      name: 'alpha_one',
      type: 'feedback',
      description: 'first entry',
      body: 'aaa',
      pinned: true,
    });
    await store.save({
      name: 'beta_two',
      type: 'feedback',
      description: 'second entry',
      body: 'bbbb',
    });
    await store.save({
      name: 'gamma_three',
      type: 'feedback',
      description: 'third entry',
      body: 'ccccc',
      pinned: true,
    });

    const handler = createMemorySearchHandler({ store });
    const withPins = (await handler({ query: 'q' })) as unknown as SearchResponse;

    // Re-save each entry with pinned cleared / toggled -- ranking output
    // must be byte-equal because the pinned flag does not feed search.
    await store.upsert({
      name: 'alpha_one',
      type: 'feedback',
      description: 'first entry',
      body: 'aaa',
      pinned: false,
    });
    await store.upsert({
      name: 'gamma_three',
      type: 'feedback',
      description: 'third entry',
      body: 'ccccc',
      pinned: false,
    });
    const withoutPins = (await handler({ query: 'q' })) as unknown as SearchResponse;

    // The stub embedder is non-deterministic across calls (it increments a
    // counter), so absolute scores are not comparable across two
    // `memory_search` invocations. The ranking *order* is the property
    // that matters: pinned must not push an entry up or down in results.
    const order = (r: SearchResponse): string[] => r.matches.map((m) => m.name);
    expect(order(withoutPins)).toEqual(order(withPins));
    expect(withoutPins.matches.length).toBe(withPins.matches.length);
  });
});
