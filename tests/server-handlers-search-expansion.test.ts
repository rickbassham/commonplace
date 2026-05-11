/**
 * Unit tests for one-hop graph expansion in memory_search.
 *
 * Covers the in-process handler surface: the new `expand`, `expandTypes`,
 * and `expandLimit` arguments, the `via` field on expanded matches, decay
 * scoring, deduplication against direct hits, supersede filtering on
 * expanded entries, the `expandLimit` cap, and the final score-descending
 * sort + slice. End-to-end coverage over the spawned bin lives in
 * `server-handlers-search-expansion.integration.test.ts`.
 *
 * Test pattern:
 *
 *   - Build a real `MemoryStore` backed by a tmp dir and a stub embedder,
 *     wire a real `MemoryGraph` in, seed memories via `store.save()`, and
 *     install edges via `store.linkEdge()` so the graph's adjacency list
 *     matches the .md frontmatter.
 *   - Use `vi.spyOn(store, 'search')` to inject deterministic SearchHits
 *     for the direct-hit pass. The handler's expansion logic walks the
 *     real graph from those hits' names; the assertions then verify what
 *     ended up in `matches`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, type SearchHit } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import { createMemorySearchHandler } from '../src/server/handlers.js';
import type { MemorySearchMatch, MemorySearchResult } from '../src/server/handlers.js';
import {
  DEFAULT_EXPANSION_DECAY,
  ENV_EXPANSION_DECAY,
  resolveExpansionDecay,
} from '../src/bin/env.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar930-'));
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

interface Harness {
  store: MemoryStore;
  graph: MemoryGraph;
}

/**
 * Build a store with a graph wired in, seeded with the given memories.
 * Each memory is saved via `store.save()` so the graph's name set is
 * populated and the entry is on disk. Edges are installed via
 * `store.linkEdge()` after all memories exist (linkEdge refuses unknown
 * targets).
 */
const setupHarness = async (
  memories: ReadonlyArray<{ name: string; description?: string; body?: string }>,
  edges: ReadonlyArray<{
    from: string;
    to: string;
    type: 'related-to' | 'builds-on' | 'contradicts' | 'child-of' | 'supersedes';
  }> = [],
): Promise<Harness> => {
  const graph = new MemoryGraph();
  const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
  await store.scan();
  for (const m of memories) {
    await store.save({
      name: m.name,
      type: 'reference',
      description: m.description ?? `description for ${m.name}`,
      body: m.body ?? `body of ${m.name}`,
    });
  }
  for (const e of edges) {
    await store.linkEdge(e);
  }
  return { store, graph };
};

const fakeHit = (name: string, score: number, body = `body of ${name}`): SearchHit => ({
  memory: {
    name,
    description: `description for ${name}`,
    type: 'reference',
    body,
    relations: [],
    supersedes: [],
    vector: new Float32Array(4),
    contentSha: `sha-${name}`,
    modelId: 'Xenova/bge-base-en-v1.5',
    dim: 4,
  },
  score,
});

const isMatchArray = (v: unknown): v is MemorySearchMatch[] =>
  Array.isArray(v) &&
  v.every(
    (m) => typeof m === 'object' && m !== null && 'name' in m && 'score' in m && 'scope' in m,
  );

const assertResult = (out: unknown): MemorySearchResult => {
  expect(out).toBeDefined();
  expect(typeof out).toBe('object');
  const o = out as MemorySearchResult;
  expect(isMatchArray(o.matches)).toBe(true);
  return o;
};

// --------------------------------------------------------------------------
// default behaviour: expansion is ON by default
// --------------------------------------------------------------------------

describe('default behaviour: omitting `expand` runs one-hop expansion', () => {
  it('when `expand` is omitted, expansion runs and the response includes graph neighbours of the direct hits (tagged with `via`)', async () => {
    const { store } = await setupHarness(
      [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
      [
        { from: 'alpha', to: 'beta', type: 'related-to' },
        { from: 'alpha', to: 'gamma', type: 'builds-on' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('alpha', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', limit: 10 }));
    expect(out.matches.map((m) => m.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    const alpha = out.matches.find((m) => m.name === 'alpha');
    expect(alpha && 'via' in alpha).toBe(false);
    const expansions = out.matches.filter((m) => 'via' in m);
    expect(expansions).toHaveLength(2);
  });

  it('explicit `expand: "none"` opts out of expansion and returns direct hits only', async () => {
    const { store } = await setupHarness(
      [{ name: 'alpha' }, { name: 'beta' }],
      [{ from: 'alpha', to: 'beta', type: 'builds-on' }],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('alpha', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'none' }));
    expect(out.matches.map((m) => m.name)).toEqual(['alpha']);
    expect(out.matches.every((m) => !('via' in m))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// ac: one-hop hub + 2 neighbours
// --------------------------------------------------------------------------

describe('one-hop hub expansion', () => {
  it('a direct hit on a hub memory with two default-edge-type outbound edges returns the hub plus both neighbours, with `via` populated for the expansion entries', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'n1' }, { name: 'n2' }],
      [
        { from: 'hub', to: 'n1', type: 'builds-on' },
        { from: 'hub', to: 'n2', type: 'related-to' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    const names = out.matches.map((m) => m.name).sort();
    expect(names).toEqual(['hub', 'n1', 'n2']);

    const hub = out.matches.find((m) => m.name === 'hub');
    expect(hub).toBeDefined();
    expect('via' in (hub as MemorySearchMatch)).toBe(false);

    const n1 = out.matches.find((m) => m.name === 'n1');
    expect(n1?.via).toEqual({ source: 'hub', edge: 'builds-on' });

    const n2 = out.matches.find((m) => m.name === 'n2');
    expect(n2?.via).toEqual({ source: 'hub', edge: 'related-to' });
  });
});

// --------------------------------------------------------------------------
// ac: expandLimit caps per-source
// --------------------------------------------------------------------------

describe('expandLimit', () => {
  it('expandLimit: 1 returns exactly one neighbour per direct hit even when more outbound edges of valid types exist', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'n1' }, { name: 'n2' }, { name: 'n3' }],
      [
        { from: 'hub', to: 'n1', type: 'related-to' },
        { from: 'hub', to: 'n2', type: 'related-to' },
        { from: 'hub', to: 'n3', type: 'related-to' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(
      await handler({ query: 'q', expand: 'one-hop', expandLimit: 1, limit: 10 }),
    );
    const expansions = out.matches.filter((m) => 'via' in m);
    expect(expansions).toHaveLength(1);
  });

  it('expandLimit defaults to 2 (the documented default)', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'n1' }, { name: 'n2' }, { name: 'n3' }],
      [
        { from: 'hub', to: 'n1', type: 'related-to' },
        { from: 'hub', to: 'n2', type: 'related-to' },
        { from: 'hub', to: 'n3', type: 'related-to' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    const expansions = out.matches.filter((m) => 'via' in m);
    expect(expansions).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------
// ac: expandTypes filter
// --------------------------------------------------------------------------

describe('expandTypes', () => {
  it('`expandTypes: ["contradicts"]` follows ONLY contradicts edges; default-type edges from the same source are skipped', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'n1' }, { name: 'n2' }],
      [
        { from: 'hub', to: 'n1', type: 'related-to' },
        { from: 'hub', to: 'n2', type: 'contradicts' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(
      await handler({ query: 'q', expand: 'one-hop', expandTypes: ['contradicts'], limit: 10 }),
    );
    const expansions = out.matches.filter((m) => 'via' in m);
    expect(expansions.map((m) => m.name)).toEqual(['n2']);
    expect(expansions[0]?.via?.edge).toBe('contradicts');
  });

  it('default expandTypes excludes mentions edges; mentions neighbours are NOT included when expandTypes is omitted', async () => {
    const { store, graph } = await setupHarness(
      [{ name: 'hub' }, { name: 'n1' }, { name: 'mention_target' }],
      [{ from: 'hub', to: 'n1', type: 'builds-on' }],
    );
    // Plug a synthetic mentions edge directly into the graph -- the
    // The body tokenizer normally produces these but we don't need to
    // exercise that path here.
    graph.addMentionsEdge({ from: 'hub', to: 'mention_target' });
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    expect(out.matches.map((m) => m.name).sort()).toEqual(['hub', 'n1']);
  });

  it('`expandTypes: ["mentions"]` opts INTO following mentions edges and returns the mentioned memory as an expansion entry', async () => {
    const { store, graph } = await setupHarness(
      [{ name: 'hub' }, { name: 'mention_target' }, { name: 'unrelated' }],
      [{ from: 'hub', to: 'unrelated', type: 'related-to' }],
    );
    graph.addMentionsEdge({ from: 'hub', to: 'mention_target' });
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(
      await handler({ query: 'q', expand: 'one-hop', expandTypes: ['mentions'], limit: 10 }),
    );
    const expansions = out.matches.filter((m) => 'via' in m);
    expect(expansions.map((m) => m.name)).toEqual(['mention_target']);
    expect(expansions[0]?.via?.edge).toBe('mentions');
  });

  it('supersedes edges are NEVER followed even when expand: "one-hop" is set with a permissive expandTypes (supersedes is not a valid expandTypes value)', async () => {
    // Two memories where `successor` supersedes `predecessor`. The graph
    // therefore has an outbound supersedes edge from `successor` to
    // `predecessor`. Even with expand turned on, supersedes is not in
    // EXPAND_EDGE_TYPES so the expansion logic must not surface
    // `predecessor` via expansion.
    const { store } = await setupHarness(
      [{ name: 'predecessor' }, { name: 'successor' }],
      [{ from: 'successor', to: 'predecessor', type: 'supersedes' }],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('successor', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(
      await handler({ query: 'q', expand: 'one-hop', includeSuperseded: true, limit: 10 }),
    );
    // `predecessor` is in the corpus, but expansion did not surface it.
    expect(out.matches.map((m) => m.name)).toEqual(['successor']);
  });
});

// --------------------------------------------------------------------------
// ac: dedup against direct hits
// --------------------------------------------------------------------------

describe('deduplication against direct hits', () => {
  it('a memory that is BOTH a direct hit AND a graph neighbour of another direct hit is emitted exactly once -- as the direct hit, with no `via` field', async () => {
    const { store } = await setupHarness(
      [{ name: 'alpha' }, { name: 'beta' }],
      [{ from: 'alpha', to: 'beta', type: 'builds-on' }],
    );
    // Both alpha and beta come back as direct hits; alpha has builds-on
    // -> beta in the graph. After dedup, beta must appear once (as the
    // direct hit) without a `via` annotation.
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('alpha', 0.9), fakeHit('beta', 0.6)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    expect(out.matches.map((m) => m.name)).toEqual(['alpha', 'beta']);
    const beta = out.matches.find((m) => m.name === 'beta');
    expect(beta && 'via' in beta).toBe(false);
    // beta's score is the direct-hit score (0.6 unrounded -> 0.6 rounded),
    // NOT the expansion-derived score (0.9 * 0.7 = 0.63). The direct hit
    // wins.
    expect(beta?.score).toBe(0.6);
  });
});

// --------------------------------------------------------------------------
// ac: decay
// --------------------------------------------------------------------------

describe('score decay on expansion entries', () => {
  it('an expansion neighbour scores `direct_hit_score * decay` (default decay 0.7), rounded to 3 decimals', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'neighbour' }],
      [{ from: 'hub', to: 'neighbour', type: 'builds-on' }],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.8)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    const neighbour = out.matches.find((m) => m.name === 'neighbour');
    expect(neighbour).toBeDefined();
    // 0.8 * 0.7 = 0.56 (exact in binary). Rounded to 3 decimals is 0.56.
    expect(neighbour?.score).toBe(0.56);
    const hub = out.matches.find((m) => m.name === 'hub');
    expect(hub?.score).toBe(0.8);
    // Expansion entry scores strictly less than its source's score.
    expect((neighbour?.score ?? 0) < (hub?.score ?? 0)).toBe(true);
  });

  it('a handler constructed with a custom `expansionDecay` uses that value instead of the default', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'neighbour' }],
      [{ from: 'hub', to: 'neighbour', type: 'builds-on' }],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 1.0)]);
    const handler = createMemorySearchHandler({ store, expansionDecay: 0.5 });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    const neighbour = out.matches.find((m) => m.name === 'neighbour');
    expect(neighbour?.score).toBe(0.5);
  });
});

// --------------------------------------------------------------------------
// ac: final sort + slice
// --------------------------------------------------------------------------

describe('final sort and slice', () => {
  it('after expansion, matches are sorted by descending score and sliced to the overall `limit`', async () => {
    // Two direct hits with very different scores. The high-score hit's
    // expansion neighbour scores 0.95 * 0.7 = 0.665, which is HIGHER than
    // the low-score direct hit (0.4). With limit: 2, the result is the
    // top-2 by score: [high-direct (0.95), high-direct's neighbour (0.665)].
    const { store } = await setupHarness(
      [{ name: 'high' }, { name: 'low' }, { name: 'high_neighbour' }, { name: 'low_neighbour' }],
      [
        { from: 'high', to: 'high_neighbour', type: 'related-to' },
        { from: 'low', to: 'low_neighbour', type: 'related-to' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('high', 0.95), fakeHit('low', 0.4)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 2 }));
    expect(out.matches).toHaveLength(2);
    // Top two by score: high (0.95), high_neighbour (0.665).
    expect(out.matches[0]?.name).toBe('high');
    expect(out.matches[1]?.name).toBe('high_neighbour');
    // Scores are strictly descending.
    const scores = out.matches.map((m) => m.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] as number);
    }
  });
});

// --------------------------------------------------------------------------
// ac: supersede filtering on expansion
// --------------------------------------------------------------------------

describe('supersede filter applies to expansion entries', () => {
  it('a graph neighbour that is superseded by another memory is excluded from expansion when includeSuperseded is false (default)', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'old' }, { name: 'newer' }, { name: 'ok' }],
      [
        { from: 'hub', to: 'old', type: 'related-to' },
        { from: 'hub', to: 'ok', type: 'related-to' },
        { from: 'newer', to: 'old', type: 'supersedes' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    // `old` is filtered out by the supersede pass; `ok` and `hub` remain.
    expect(out.matches.map((m) => m.name).sort()).toEqual(['hub', 'ok']);
  });

  it('when includeSuperseded: true is passed, a superseded neighbour IS included as an expansion entry and carries the supersededBy annotation', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'old' }, { name: 'newer' }],
      [
        { from: 'hub', to: 'old', type: 'related-to' },
        { from: 'newer', to: 'old', type: 'supersedes' },
      ],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(
      await handler({ query: 'q', expand: 'one-hop', includeSuperseded: true, limit: 10 }),
    );
    const oldMatch = out.matches.find((m) => m.name === 'old');
    expect(oldMatch).toBeDefined();
    expect(oldMatch?.via).toEqual({ source: 'hub', edge: 'related-to' });
    expect(oldMatch?.supersededBy).toBe('newer');
  });
});

// --------------------------------------------------------------------------
// ac: argument validation
// --------------------------------------------------------------------------

describe('argument validation', () => {
  it('rejects `expand` values outside the enum (e.g. "two-hop", numeric, null)', async () => {
    const { store } = await setupHarness([{ name: 'alpha' }]);
    const handler = createMemorySearchHandler({ store });
    await expect(handler({ query: 'q', expand: 'two-hop' })).rejects.toThrow(/expand/);
    await expect(handler({ query: 'q', expand: 1 })).rejects.toThrow(/expand/);
    await expect(handler({ query: 'q', expand: null })).rejects.toThrow(/expand/);
  });

  it('rejects non-array `expandTypes`, an empty `expandTypes` array, and entries outside the allowed enum', async () => {
    const { store } = await setupHarness([{ name: 'alpha' }]);
    const handler = createMemorySearchHandler({ store });
    await expect(handler({ query: 'q', expandTypes: 'related-to' })).rejects.toThrow(/expandTypes/);
    await expect(handler({ query: 'q', expandTypes: [] })).rejects.toThrow(/expandTypes/);
    await expect(handler({ query: 'q', expandTypes: ['supersedes'] })).rejects.toThrow(
      /expandTypes/,
    );
    await expect(handler({ query: 'q', expandTypes: ['related-to', 42] })).rejects.toThrow(
      /expandTypes/,
    );
  });

  it('rejects `expandLimit` values that are not positive integers', async () => {
    const { store } = await setupHarness([{ name: 'alpha' }]);
    const handler = createMemorySearchHandler({ store });
    await expect(handler({ query: 'q', expandLimit: 0 })).rejects.toThrow(/expandLimit/);
    await expect(handler({ query: 'q', expandLimit: -1 })).rejects.toThrow(/expandLimit/);
    await expect(handler({ query: 'q', expandLimit: 1.5 })).rejects.toThrow(/expandLimit/);
    await expect(handler({ query: 'q', expandLimit: '2' })).rejects.toThrow(/expandLimit/);
  });
});

// --------------------------------------------------------------------------
// ac: dangling neighbour edges are tolerated
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// env-var: COMMONPLACE_EXPANSION_DECAY
// --------------------------------------------------------------------------

describe('COMMONPLACE_EXPANSION_DECAY env var', () => {
  it('returns the documented default (0.7) when the env var is unset or empty', () => {
    expect(resolveExpansionDecay({})).toBe(DEFAULT_EXPANSION_DECAY);
    expect(resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '' })).toBe(DEFAULT_EXPANSION_DECAY);
    expect(DEFAULT_EXPANSION_DECAY).toBe(0.7);
  });

  it('parses a valid float in [0, 1] from the env var', () => {
    expect(resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '0.5' })).toBe(0.5);
    expect(resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '0' })).toBe(0);
    expect(resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '1' })).toBe(1);
    expect(resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '0.123' })).toBe(0.123);
  });

  it('rejects values outside [0, 1], NaN, Infinity, and non-numeric strings with a clear error that names the env var and the offending value', () => {
    const cases = ['abc', '-0.1', '1.1', '7', 'NaN', 'Infinity', '-Infinity'];
    for (const value of cases) {
      let msg = '';
      try {
        resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: value });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg, `expected rejection for ${JSON.stringify(value)}`).toContain(ENV_EXPANSION_DECAY);
      expect(msg, `expected rejection for ${JSON.stringify(value)}`).toContain('[0, 1]');
      expect(
        msg,
        `expected rejection to name the offending value ${JSON.stringify(value)}`,
      ).toContain(value);
    }
  });

  it('a handler built with the env-resolved decay applies that value end-to-end', async () => {
    const { store } = await setupHarness(
      [{ name: 'hub' }, { name: 'neighbour' }],
      [{ from: 'hub', to: 'neighbour', type: 'builds-on' }],
    );
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 1.0)]);
    const expansionDecay = resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '0.25' });
    const handler = createMemorySearchHandler({ store, expansionDecay });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    const neighbour = out.matches.find((m) => m.name === 'neighbour');
    expect(neighbour?.score).toBe(0.25);
  });
});

// --------------------------------------------------------------------------
// ac: dangling expansion edges
// --------------------------------------------------------------------------

describe('dangling expansion edges', () => {
  it('an outbound edge whose target is not in the loaded corpus is silently skipped during expansion (does not crash, does not surface a ghost match)', async () => {
    const { store, graph } = await setupHarness(
      [{ name: 'hub' }, { name: 'real' }],
      [{ from: 'hub', to: 'real', type: 'related-to' }],
    );
    // Inject a dangling edge directly into the graph: a builds-on edge
    // pointing at a name that does not exist in the store.
    graph.addEdge({ from: 'hub', to: 'ghost', type: 'builds-on' });
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit('hub', 0.9)]);
    const handler = createMemorySearchHandler({ store });
    const out = assertResult(await handler({ query: 'q', expand: 'one-hop', limit: 10 }));
    expect(out.matches.map((m) => m.name).sort()).toEqual(['hub', 'real']);
  });
});
