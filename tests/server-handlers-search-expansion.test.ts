/**
 * Unit tests: one-hop graph expansion in `memory_search`.
 *
 * Covers the in-process handler surface only -- argument validation,
 * expand-mode opt-in, deduplication against direct hits and across
 * expansions, decay scoring, sort-then-slice ordering, env-var resolution
 * for `COMMONPLACE_EXPANSION_DECAY`, and the inputSchema additions.
 * End-to-end coverage through the real spawned bin lives in
 * `tests/server-bin.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import {
  buildToolDefinitions,
  createDefaultHandlers,
  type ToolDefinition,
} from '../src/server/tools.js';
import {
  DEFAULT_EXPAND_TYPES,
  EXPAND_MODES,
  EXPAND_TYPES,
  createMemorySearchHandler,
  type MemorySearchResult,
} from '../src/server/handlers.js';
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
      // Fallback: deterministic but distinct. We mostly use the registry.
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

const findDef = (defs: readonly ToolDefinition[], name: string): ToolDefinition => {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`expected tool ${name} to be registered`);
  return def;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asResult = (v: unknown): MemorySearchResult => {
  if (!isRecord(v)) throw new Error('not a record');
  return v as unknown as MemorySearchResult;
};

/**
 * Build a hub-graph corpus: memory H sits at the centre with outbound
 * builds-on -> N1 and related-to -> N2. The query vector aligns with H so
 * H is the top direct hit; N1 and N2 have orthogonal vectors so they
 * would not appear in the direct top-K with a tight enough limit.
 */
const seedHubGraph = async (
  store: MemoryStore,
  graph: MemoryGraph,
  embedder: ReturnType<typeof makeProgrammableEmbedder>,
): Promise<void> => {
  embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
  embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
  embedder.register('body_n1', l2norm(new Float32Array([0, 1, 0, 0])));
  embedder.register('body_n2', l2norm(new Float32Array([0, 0, 1, 0])));
  await store.scan();
  await store.save({ name: 'h', type: 'reference', description: 'hub', body: 'body_h' });
  await store.save({ name: 'n1', type: 'reference', description: 'n1', body: 'body_n1' });
  await store.save({ name: 'n2', type: 'reference', description: 'n2', body: 'body_n2' });
  // The store-owned graph keeps its own state in sync via scan/save when a
  // graph is passed via opts; for tests that construct the graph
  // separately (no `graph` option on the store), we wire H's outbound
  // edges directly into our test graph.
  graph.add({
    name: 'h',
    relations: [
      { to: 'n1', type: 'builds-on' },
      { to: 'n2', type: 'related-to' },
    ],
    supersedes: [],
  });
  graph.add({ name: 'n1', relations: [], supersedes: [] });
  graph.add({ name: 'n2', relations: [], supersedes: [] });
};

// --------------------------------------------------------------------------
// ac-1: opt-in behaviour
// --------------------------------------------------------------------------

describe('ac-1: expansion opt-in and default behaviour', () => {
  it('memory_search with no `expand` argument returns the same matches array (same names, same scores, same order, no `via` keys) as before expansion was added -- verified against a snapshot of the pre-expansion search response on a graph-bearing corpus', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(await handler({ query: 'q', limit: 1 }));
    // With limit=1 only the hub is returned; expansion would have added
    // N1/N2 but we did not opt in.
    expect(out.matches.map((m) => m.name)).toEqual(['h']);
    for (const m of out.matches) {
      expect('via' in (m as object)).toBe(false);
    }
  });

  it("memory_search with explicit `expand: 'none'` returns identical results to the no-`expand` call on the same corpus and query (i.e. 'none' is a true alias for the default)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const baseline = asResult(await handler({ query: 'q', limit: 5 }));
    const explicit = asResult(await handler({ query: 'q', limit: 5, expand: 'none' }));
    expect(explicit).toEqual(baseline);
  });

  it("memory_search with `expand: 'one-hop'` augments the matches list with neighbor entries whose `via` field is present (key exists), while matches sourced from direct cosine hits omit the `via` key entirely (key absent, not undefined)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold gates the orthogonal neighbors out of direct hits so the
    // only way they reach the response is via expansion.
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.5 }),
    );
    const byName = new Map(out.matches.map((m) => [m.name, m]));
    const h = byName.get('h');
    const n1 = byName.get('n1');
    const n2 = byName.get('n2');
    expect(h).toBeDefined();
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    expect('via' in (h as object)).toBe(false);
    expect('via' in (n1 as object)).toBe(true);
    expect('via' in (n2 as object)).toBe(true);
  });

  it("memory_search rejects an unknown `expand` value (e.g. 'two-hop', '', 42, null) with a validation error that names the offending field and lists the allowed values 'none' and 'one-hop'", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    for (const bogus of ['two-hop', '', 42, null]) {
      let msg = '';
      try {
        await handler({ query: 'q', expand: bogus });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toMatch(/\bexpand\b/);
      expect(msg).toContain('none');
      expect(msg).toContain('one-hop');
    }
  });

  it("memory_search inputSchema in TOOL_SCHEMAS gains optional `expand` (enum ['none','one-hop']), `expandTypes` (array of RelationType), and `expandLimit` (integer >= 0) properties; no new required fields; existing schema fields unchanged", () => {
    const defs = buildToolDefinitions();
    const def = findDef(defs, 'memory_search');
    const props = def.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.expand?.type).toBe('string');
    expect(props.expand?.enum).toEqual([...EXPAND_MODES]);
    expect(props.expandTypes?.type).toBe('array');
    const expandItems = props.expandTypes?.items as Record<string, unknown>;
    expect(expandItems?.enum).toEqual([...EXPAND_TYPES]);
    expect(props.expandLimit?.type).toBe('integer');
    expect(props.expandLimit?.minimum).toBe(0);
    const required = (def.inputSchema as { required?: string[] }).required ?? [];
    expect(new Set(required)).toEqual(new Set(['query']));
    // Pre-existing schema fields stay defined.
    for (const existing of ['query', 'limit', 'type', 'threshold', 'includeSuperseded', 'scope']) {
      expect(props[existing]).toBeDefined();
    }
  });
});

// --------------------------------------------------------------------------
// ac-2: hub-graph expansion mechanics
// --------------------------------------------------------------------------

describe('ac-2: hub-graph expansion + expandLimit + expandTypes', () => {
  it("given a synthetic corpus where memory H ('hub') has outbound edges to N1 (builds-on) and N2 (related-to), a memory_search whose top hit is H with `expand: 'one-hop'` returns matches containing H plus N1 and N2, each neighbor entry carrying `via: { source: 'H', edge: <its edge type> }`", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold gates the orthogonal neighbors out of direct hits so the
    // only way they enter the response is through expansion.
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.5 }),
    );
    const byName = new Map(out.matches.map((m) => [m.name, m]));
    expect(byName.has('h')).toBe(true);
    const n1 = byName.get('n1');
    const n2 = byName.get('n2');
    expect(n1?.via).toEqual({ source: 'h', edge: 'builds-on' });
    expect(n2?.via).toEqual({ source: 'h', edge: 'related-to' });
  });

  it('the previous synthetic-hub case with `expandLimit: 1` returns matches containing H plus exactly one of {N1, N2} (the higher-decayed-score one in the case of equal direct-hit score, deterministic) and omits the other neighbor entirely', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold gates the orthogonal neighbors out of direct hits so they
    // can only reach the response via expansion.
    const out = asResult(
      await handler({
        query: 'q',
        limit: 5,
        expand: 'one-hop',
        expandLimit: 1,
        threshold: 0.5,
      }),
    );
    const names = out.matches.map((m) => m.name);
    expect(names).toContain('h');
    // Exactly one of the two neighbors should appear (the first declared
    // outbound edge wins because both neighbors share H's direct-hit
    // score, and outbound() returns edges in insertion order).
    const neighbors = names.filter((n) => n === 'n1' || n === 'n2');
    expect(neighbors).toHaveLength(1);
    // Deterministic: 'builds-on' was added before 'related-to' in the seed
    // so N1 wins.
    expect(neighbors[0]).toBe('n1');
  });

  it('the synthetic-hub case with `expandLimit: 0` returns matches containing H but NO expanded neighbors (zero neighbors per hit is honoured, not coerced)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold keeps the orthogonal neighbors out of the direct hits so
    // the only way they could appear is via expansion -- which
    // `expandLimit: 0` must suppress.
    const out = asResult(
      await handler({
        query: 'q',
        limit: 5,
        expand: 'one-hop',
        expandLimit: 0,
        threshold: 0.5,
      }),
    );
    const names = out.matches.map((m) => m.name);
    expect(names).toContain('h');
    expect(names).not.toContain('n1');
    expect(names).not.toContain('n2');
    // And no entry carries `via`.
    for (const m of out.matches) {
      expect('via' in (m as object)).toBe(false);
    }
  });

  it("the synthetic-hub case with `expandTypes: ['contradicts']` and H additionally having a 'contradicts' edge to N3 returns the contradicts neighbor N3 but NOT the default-typed neighbors N1 (builds-on) or N2 (related-to)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);
    embedder.register('body_n3', l2norm(new Float32Array([0, 0, 0, 1])));
    await store.save({ name: 'n3', type: 'reference', description: 'n3', body: 'body_n3' });
    // Replace H's edges to include contradicts -> N3 alongside the
    // baseline. We remove H and re-add to refresh adjacency cleanly.
    graph.remove('h');
    graph.add({
      name: 'h',
      relations: [
        { to: 'n1', type: 'builds-on' },
        { to: 'n2', type: 'related-to' },
        { to: 'n3', type: 'contradicts' },
      ],
      supersedes: [],
    });
    graph.add({ name: 'n3', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold keeps the orthogonal neighbors out of direct hits so the
    // only neighbor that should appear is the one pulled in by the
    // explicitly-opted-in 'contradicts' expansion.
    const out = asResult(
      await handler({
        query: 'q',
        limit: 5,
        expand: 'one-hop',
        expandTypes: ['contradicts'],
        threshold: 0.5,
      }),
    );
    const names = out.matches.map((m) => m.name);
    expect(names).toContain('n3');
    expect(names).not.toContain('n1');
    expect(names).not.toContain('n2');
    const n3 = out.matches.find((m) => m.name === 'n3');
    expect(n3?.via).toEqual({ source: 'h', edge: 'contradicts' });
  });

  it("memory_search with `expand: 'one-hop'` and no caller-supplied `expandTypes` walks only edges of types 'builds-on' and 'related-to' from each direct hit (default expandTypes); edges of type 'child-of', 'contradicts', 'mentions', and 'supersedes' on the hit are NOT followed", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_n_co', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_n_cn', l2norm(new Float32Array([0, 0, 1, 0])));
    embedder.register('body_n_mn', l2norm(new Float32Array([0, 0, 0, 1])));
    embedder.register('body_n_sp', l2norm(new Float32Array([0, 1, 0, 1])));
    // Default-expansion neighbors are orthogonal to the query so they
    // can only enter the response via expansion, not as direct cosine
    // hits.
    embedder.register('body_n_bo', l2norm(new Float32Array([0, 1, 1, 0])));
    embedder.register('body_n_rt', l2norm(new Float32Array([0, 0, 1, 1])));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'n_co', type: 'reference', description: 'co', body: 'body_n_co' });
    await store.save({ name: 'n_cn', type: 'reference', description: 'cn', body: 'body_n_cn' });
    await store.save({ name: 'n_mn', type: 'reference', description: 'mn', body: 'body_n_mn' });
    await store.save({ name: 'n_sp', type: 'reference', description: 'sp', body: 'body_n_sp' });
    await store.save({ name: 'n_bo', type: 'reference', description: 'bo', body: 'body_n_bo' });
    await store.save({ name: 'n_rt', type: 'reference', description: 'rt', body: 'body_n_rt' });
    graph.add({
      name: 'h',
      relations: [
        { to: 'n_co', type: 'child-of' },
        { to: 'n_cn', type: 'contradicts' },
        { to: 'n_bo', type: 'builds-on' },
        { to: 'n_rt', type: 'related-to' },
      ],
      supersedes: ['n_sp'],
    });
    graph.add({ name: 'n_co', relations: [], supersedes: [] });
    graph.add({ name: 'n_cn', relations: [], supersedes: [] });
    graph.add({ name: 'n_mn', relations: [], supersedes: [] });
    graph.add({ name: 'n_sp', relations: [], supersedes: [] });
    graph.add({ name: 'n_bo', relations: [], supersedes: [] });
    graph.add({ name: 'n_rt', relations: [], supersedes: [] });
    graph.addMentionsEdge({ from: 'h', to: 'n_mn' });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold keeps orthogonal neighbors out of direct hits so they
    // can only enter via expansion. The only direct hit above 0.5 is H.
    const out = asResult(
      await handler({
        query: 'q',
        limit: 10,
        expand: 'one-hop',
        expandLimit: 10,
        threshold: 0.5,
      }),
    );
    // Only the two default-edge-type neighbors are pulled in via
    // expansion.
    const expanded = out.matches.filter((m) => m.via !== undefined).map((m) => m.name);
    expect(expanded.sort()).toEqual(['n_bo', 'n_rt'].sort());
    expect(DEFAULT_EXPAND_TYPES).toEqual(['builds-on', 'related-to']);
    // For clarity: child-of, contradicts, mentions, supersedes neighbors
    // were not pulled by expansion.
    for (const skipped of ['n_co', 'n_cn', 'n_mn', 'n_sp']) {
      const m = out.matches.find((x) => x.name === skipped);
      // None of these should appear in the response at all -- the
      // threshold excludes them as direct hits and the default
      // expandTypes excludes them as expanded neighbors.
      expect(m).toBeUndefined();
    }
  });

  it("memory_search with `expandTypes: ['mentions']` follows mentions edges -- demonstrating that mentions is gated behind explicit opt-in rather than excluded outright", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_m', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'm', type: 'reference', description: 'm', body: 'body_m' });
    graph.add({ name: 'h', relations: [], supersedes: [] });
    graph.add({ name: 'm', relations: [], supersedes: [] });
    graph.addMentionsEdge({ from: 'h', to: 'm' });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold keeps the orthogonal mention target out of direct hits
    // so its only path into the response is through the explicit
    // mentions expansion.
    const out = asResult(
      await handler({
        query: 'q',
        limit: 5,
        expand: 'one-hop',
        expandTypes: ['mentions'],
        threshold: 0.5,
      }),
    );
    const m = out.matches.find((x) => x.name === 'm');
    expect(m).toBeDefined();
    expect(m?.via).toEqual({ source: 'h', edge: 'mentions' });
  });

  it("memory_search rejects an `expandTypes` array containing an unknown edge-type string (e.g. 'bogus') with a validation error that lists allowed values", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    let msg = '';
    try {
      await handler({ query: 'q', expandTypes: ['bogus'] });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/expandTypes/);
    for (const t of EXPAND_TYPES) expect(msg).toContain(t);
  });

  it("memory_search rejects a negative or non-integer `expandLimit` (e.g. -1, 1.5, 'two') with a validation error that names the offending field", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    for (const bogus of [-1, 1.5, 'two']) {
      let msg = '';
      try {
        await handler({ query: 'q', expandLimit: bogus });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toMatch(/expandLimit/);
    }
  });
});

// --------------------------------------------------------------------------
// ac-3: deduplication
// --------------------------------------------------------------------------

describe('ac-3: deduplication against direct hits and across expansions', () => {
  it("given a corpus where the cosine top-K already includes both H and N1 (a neighbor of H), memory_search with `expand: 'one-hop'` returns N1 exactly once in the matches array, with the match keeping its direct-hit shape (no `via` key) rather than being replaced by an expanded entry", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // Engineer H and N1 to BOTH be top direct hits.
    embedder.register('q', l2norm(new Float32Array([1, 1, 0, 0])));
    embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_n1', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'n1', type: 'reference', description: 'n1', body: 'body_n1' });
    graph.add({
      name: 'h',
      relations: [{ to: 'n1', type: 'builds-on' }],
      supersedes: [],
    });
    graph.add({ name: 'n1', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(await handler({ query: 'q', limit: 5, expand: 'one-hop' }));
    const occurrences = out.matches.filter((m) => m.name === 'n1');
    expect(occurrences).toHaveLength(1);
    expect('via' in (occurrences[0] as object)).toBe(false);
  });

  it('when two distinct direct hits H_a and H_b both have outbound edges to the same neighbor X, X appears at most once in the expanded matches; the `via` field on X reflects the source that pulled it in first (deterministic: source with the higher direct-hit score)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // H_a and H_b are both direct hits; H_a > H_b.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_ha', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_hb', l2norm(new Float32Array([0.9, 0.1, 0, 0])));
    embedder.register('body_x', l2norm(new Float32Array([0, 0, 1, 0])));
    await store.scan();
    await store.save({ name: 'ha', type: 'reference', description: 'ha', body: 'body_ha' });
    await store.save({ name: 'hb', type: 'reference', description: 'hb', body: 'body_hb' });
    await store.save({ name: 'x', type: 'reference', description: 'x', body: 'body_x' });
    graph.add({
      name: 'ha',
      relations: [{ to: 'x', type: 'builds-on' }],
      supersedes: [],
    });
    graph.add({
      name: 'hb',
      relations: [{ to: 'x', type: 'related-to' }],
      supersedes: [],
    });
    graph.add({ name: 'x', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold keeps the orthogonal X out of direct hits so its only
    // path into the response is through expansion -- meaning the
    // tiebreak between HA and HB pulling it in is the deterministic
    // behavior under test.
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.5 }),
    );
    const occurrences = out.matches.filter((m) => m.name === 'x');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.via?.source).toBe('ha');
  });
});

// --------------------------------------------------------------------------
// ac-4: decay scoring
// --------------------------------------------------------------------------

describe('ac-4: decay scoring + final sort/slice', () => {
  it('given direct hit H with score s_H and neighbor N (not otherwise a direct hit), the expanded match for N has score equal to `roundScore(s_H * decay)` where decay is `0.7` by default; the assertion verifies score strictly less than s_H and within float tolerance of the formula output', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold gates direct hits below 0.5 -- N1/N2 have score 0 against
    // the orthogonal query, so they don't appear as direct hits; the only
    // way they can reach the response is through expansion (decay 0.7
    // against H's score 1.0 = 0.7, which clears the 0.5 threshold).
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.5 }),
    );
    const h = out.matches.find((m) => m.name === 'h');
    const n1 = out.matches.find((m) => m.name === 'n1');
    expect(h).toBeDefined();
    expect(n1).toBeDefined();
    if (!h || !n1) return;
    expect(n1.score).toBeLessThan(h.score);
    // Default decay 0.7 -- H's exact pre-round score is 1.0 by
    // construction (registered vectors are identical L2-normalised), so
    // the rounded score is 1.0 and the expanded neighbor is 0.7.
    expect(n1.score).toBeCloseTo(0.7, 5);
  });

  it('when env var `COMMONPLACE_EXPANSION_DECAY=0.5` is set at boot, expanded entries are scored at `s_H * 0.5` (verified end-to-end through resolveExpansionDecay or equivalent env-resolver, mirroring the pattern used by `COMMONPLACE_DEFAULT_LIMIT`)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const decay = resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '0.5' });
    expect(decay).toBe(0.5);
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      expansionDecay: decay,
    });
    // Threshold gates direct cosine hits at 0.3 so N1/N2 (orthogonal,
    // score 0) only appear via expansion (decay 0.5 * H's 1.0 = 0.5,
    // above the threshold).
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.3 }),
    );
    const n1 = out.matches.find((m) => m.name === 'n1');
    expect(n1?.score).toBeCloseTo(0.5, 5);
  });

  it("the final matches array is sorted by score descending; an expanded neighbor whose decayed score exceeds another direct hit's score appears above that direct hit in the returned matches order", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // H is the strong direct hit (score 1.0). N is a neighbor of H but
    // its own vector is orthogonal to the query (score 0), so it can
    // only enter the response via expansion. W is a weak direct hit
    // (score ~0.3). With decay 0.7 against H's 1.0, expanded-N's score
    // (0.7) should outrank W (0.3) -- and threshold gates N out of
    // direct hits so it must come through expansion.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_n', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_w', l2norm(new Float32Array([0.3, 0.95, 0, 0])));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'n', type: 'reference', description: 'n', body: 'body_n' });
    await store.save({ name: 'w', type: 'reference', description: 'w', body: 'body_w' });
    graph.add({
      name: 'h',
      relations: [{ to: 'n', type: 'builds-on' }],
      supersedes: [],
    });
    graph.add({ name: 'n', relations: [], supersedes: [] });
    graph.add({ name: 'w', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
    });
    // threshold 0.1 lets W through as a direct hit but keeps N (score 0)
    // out unless expansion brings it in.
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.1 }),
    );
    const order = out.matches.map((m) => m.name);
    // H first (strong direct), then N (expanded with decay 0.7 against
    // H's 1.0 = 0.7), then W (weak direct with score ~0.3).
    expect(order.indexOf('h')).toBeLessThan(order.indexOf('n'));
    expect(order.indexOf('n')).toBeLessThan(order.indexOf('w'));
  });

  it('the final matches array is sliced to the overall `limit` (caller-supplied or `COMMONPLACE_DEFAULT_LIMIT` / 5) AFTER expansion + sort, so an expanded entry can displace a lower-scored direct hit from the response', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // Two direct hits: H (1.0) and W (0.3). Expanded N (0.7, threshold
    // gates N's direct cosine score of 0 out) should displace W when
    // limit=2.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_n', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_w', l2norm(new Float32Array([0.3, 0.95, 0, 0])));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'n', type: 'reference', description: 'n', body: 'body_n' });
    await store.save({ name: 'w', type: 'reference', description: 'w', body: 'body_w' });
    graph.add({
      name: 'h',
      relations: [{ to: 'n', type: 'builds-on' }],
      supersedes: [],
    });
    graph.add({ name: 'n', relations: [], supersedes: [] });
    graph.add({ name: 'w', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(
      await handler({ query: 'q', limit: 2, expand: 'one-hop', threshold: 0.1 }),
    );
    const names = out.matches.map((m) => m.name);
    expect(names).toEqual(['h', 'n']);
    expect(names).not.toContain('w');
  });

  it('resolveExpansionDecay (or the equivalent env-resolver) rejects a non-numeric / out-of-range (<=0 or >1) `COMMONPLACE_EXPANSION_DECAY` with a clear stderr error and does not silently coerce', () => {
    const cases = ['abc', '-0.5', '0', '1.5', 'NaN', 'Infinity'];
    for (const value of cases) {
      let msg = '';
      try {
        resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: value });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toMatch(/COMMONPLACE_EXPANSION_DECAY/);
    }
    // Sanity: the default is exposed and matches the AC.
    expect(DEFAULT_EXPANSION_DECAY).toBe(0.7);
    // Unset returns the default.
    expect(resolveExpansionDecay({})).toBe(DEFAULT_EXPANSION_DECAY);
    // Boundary: 1 is accepted (decay disabled is a valid configuration).
    expect(resolveExpansionDecay({ [ENV_EXPANSION_DECAY]: '1' })).toBe(1);
  });
});

// --------------------------------------------------------------------------
// ac-6: README documentation drift sanity
// --------------------------------------------------------------------------

describe('ac-6: README documentation invariants', () => {
  it("README.md contains a section documenting the `expand`, `expandTypes`, and `expandLimit` arguments of memory_search, including their default values ('none', ['builds-on','related-to'], 2)", async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/\bexpand\b/);
    expect(readme).toMatch(/\bexpandTypes\b/);
    expect(readme).toMatch(/\bexpandLimit\b/);
    expect(readme).toMatch(/\bnone\b/);
    expect(readme).toMatch(/\bone-hop\b/);
    expect(readme).toMatch(/builds-on/);
    expect(readme).toMatch(/related-to/);
    // Default expandLimit (2) called out somewhere.
    expect(readme).toMatch(/Defaults to `?2`?\b/);
  });

  it('README.md documents the `via` field on expanded match entries (shape `{ source, edge }`) and notes that direct hits omit it', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/\bvia\b/);
    expect(readme).toMatch(/\bsource\b/);
    expect(readme).toMatch(/\bedge\b/);
    expect(readme).toMatch(/direct hits omit/i);
  });

  it('README.md documents the `COMMONPLACE_EXPANSION_DECAY` env var with its default value 0.7 and the allowed range, alongside the other server env vars', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/COMMONPLACE_EXPANSION_DECAY/);
    expect(readme).toMatch(/0\.7/);
    expect(readme).toMatch(/\(0,\s*1\]/);
  });
});

// --------------------------------------------------------------------------
// Wiring sanity: createDefaultHandlers threads graph + decay through.
// --------------------------------------------------------------------------

describe('handler factory wiring', () => {
  it('createDefaultHandlers wires `graph` (user) and `projectGraph` and `expansionDecay` through to memory_search', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedHubGraph(store, graph, embedder);

    const handlers = createDefaultHandlers({
      userStore: store,
      graph,
      expansionDecay: 0.5,
    });
    const out = asResult(
      await handlers.memory_search({
        query: 'q',
        limit: 5,
        expand: 'one-hop',
        threshold: 0.3,
      }),
    );
    const n1 = out.matches.find((m) => m.name === 'n1');
    expect(n1?.score).toBeCloseTo(0.5, 5);
  });
});
