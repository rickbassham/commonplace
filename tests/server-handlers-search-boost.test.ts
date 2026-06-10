/**
 * Unit tests: connectedness boost in `memory_search` ranking.
 *
 * Covers the env-resolver for `COMMONPLACE_CONNECTEDNESS_BOOST`, the
 * additive `alpha * log(1 + inbound_count)` boost applied to each direct
 * cosine hit before sort/slice, the edge-type filter (boost ignores
 * `mentions` and `supersedes` inbound edges), the wiring into the handler
 * factory and bin, and the composition with one-hop expansion (expanded
 * neighbors decay the BOOSTED direct-hit score).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import { createDefaultHandlers } from '../src/server/tools.js';
import { createMemorySearchHandler, type MemorySearchResult } from '../src/server/handlers.js';
import {
  DEFAULT_CONNECTEDNESS_BOOST,
  ENV_CONNECTEDNESS_BOOST,
  resolveConnectednessBoost,
} from '../src/bin/env.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar931-'));
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
      // Fallback: zero vector. Unregistered text (e.g. the description
      // channel of fixtures that only register body vectors) contributes
      // no signal, so fused scores reduce to the registered body cosine.
      return new Float32Array(dim);
    },
    register: (text: string, vector: Float32Array): void => {
      registry.set(text, vector);
    },
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asResult = (v: unknown): MemorySearchResult => {
  if (!isRecord(v)) throw new Error('not a record');
  return v as unknown as MemorySearchResult;
};

const roundScore = (score: number): number => Math.round(score * 1000) / 1000;

// --------------------------------------------------------------------------
// ac-3: env-resolver
// --------------------------------------------------------------------------

describe('ac-3: COMMONPLACE_CONNECTEDNESS_BOOST env-resolver', () => {
  it('parses COMMONPLACE_CONNECTEDNESS_BOOST and returns the parsed number when set, otherwise the default 0.02', () => {
    expect(resolveConnectednessBoost({ [ENV_CONNECTEDNESS_BOOST]: '0.05' })).toBe(0.05);
    expect(resolveConnectednessBoost({ [ENV_CONNECTEDNESS_BOOST]: '0.1' })).toBe(0.1);
    expect(resolveConnectednessBoost({})).toBe(DEFAULT_CONNECTEDNESS_BOOST);
    expect(DEFAULT_CONNECTEDNESS_BOOST).toBe(0.02);
  });

  it('treats an empty string COMMONPLACE_CONNECTEDNESS_BOOST= as unset and returns the default 0.02', () => {
    expect(resolveConnectednessBoost({ [ENV_CONNECTEDNESS_BOOST]: '' })).toBe(
      DEFAULT_CONNECTEDNESS_BOOST,
    );
  });

  it('throws at boot with a clear error naming the offending env var and value when COMMONPLACE_CONNECTEDNESS_BOOST is non-numeric, NaN, Infinity, or negative -- no silent coercion', () => {
    const cases = ['abc', 'NaN', 'Infinity', '-Infinity', '-0.5', '-1'];
    for (const value of cases) {
      let msg = '';
      try {
        resolveConnectednessBoost({ [ENV_CONNECTEDNESS_BOOST]: value });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg, `expected rejection for ${JSON.stringify(value)}`).toContain(
        ENV_CONNECTEDNESS_BOOST,
      );
      expect(msg, `expected rejection for ${JSON.stringify(value)}`).toContain(value);
    }
  });

  it('accepts 0 as a valid value (disable case) and does not throw', () => {
    expect(resolveConnectednessBoost({ [ENV_CONNECTEDNESS_BOOST]: '0' })).toBe(0);
  });
});

// --------------------------------------------------------------------------
// ac-1: score adjustment applied after vector similarity, before sort
// --------------------------------------------------------------------------

/**
 * Build a corpus with a hub-and-leaf shape: `foundational` is referenced by
 * several other memories (inbound edges), `leaf` has none. Both have
 * identical cosine to the query so any post-boost ordering difference must
 * come from the connectedness boost.
 */
const seedFoundationalLeaf = async (
  store: MemoryStore,
  graph: MemoryGraph,
  embedder: ReturnType<typeof makeProgrammableEmbedder>,
  inboundCount = 5,
): Promise<void> => {
  // foundational and leaf both align with the query vector -> identical
  // cosine.
  embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
  embedder.register('body_f', l2norm(new Float32Array([1, 0, 0, 0])));
  embedder.register('body_l', l2norm(new Float32Array([1, 0, 0, 0])));
  await store.scan();
  await store.save({
    name: 'foundational',
    type: 'reference',
    description: 'f',
    body: 'body_f',
  });
  await store.save({ name: 'leaf', type: 'reference', description: 'l', body: 'body_l' });

  graph.add({ name: 'foundational', relations: [], supersedes: [] });
  graph.add({ name: 'leaf', relations: [], supersedes: [] });

  // Add `inboundCount` memories that each point at foundational via a
  // builds-on edge. Their own body vectors are orthogonal so they don't
  // pollute the top-K.
  for (let i = 0; i < inboundCount; i++) {
    const name = `inb_${i}`;
    const body = `body_inb_${i}`;
    embedder.register(body, l2norm(new Float32Array([0, 1, 0, i / 100])));
    await store.save({ name, type: 'reference', description: `inb ${i}`, body });
    graph.add({
      name,
      relations: [{ to: 'foundational', type: 'builds-on' }],
      supersedes: [],
    });
  }
};

describe('ac-1: score adjustment is applied after cosine and before sort', () => {
  it('memory_search applies the connectedness boost to each direct hit after MemoryStore.search returns and before the sort by descending score', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 5);

    const alpha = 0.02;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
    });
    // threshold 0.5 keeps the orthogonal inbound source memories out of
    // direct hits so we only compare foundational vs leaf.
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f = out.matches.find((m) => m.name === 'foundational');
    const l = out.matches.find((m) => m.name === 'leaf');
    expect(f).toBeDefined();
    expect(l).toBeDefined();
    if (!f || !l) return;
    // Identical cosine but foundational has 5 inbound edges -> boost
    // applies and foundational ranks first.
    const idx = out.matches.map((m) => m.name);
    expect(idx.indexOf('foundational')).toBeLessThan(idx.indexOf('leaf'));
    // The boosted score must equal cosine + alpha * log(1 + inbound).
    const expected = roundScore(1.0 + alpha * Math.log(1 + 5));
    expect(f.score).toBeCloseTo(expected, 5);
    expect(l.score).toBeCloseTo(roundScore(1.0), 5);
  });

  it('given a corpus where memory A has higher raw cosine than B but B has many more inbound edges so that cosine_A + boost_A < cosine_B + boost_B, memory_search returns B above A', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    // A's cosine is slightly higher than B's; B has many more inbound
    // edges. With alpha large enough, the boost should flip the order.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    // a's vector closer to q.
    embedder.register('body_a', l2norm(new Float32Array([1, 0.05, 0, 0])));
    // b's vector slightly further.
    embedder.register('body_b', l2norm(new Float32Array([1, 0.2, 0, 0])));
    await store.scan();
    await store.save({ name: 'a', type: 'reference', description: 'a', body: 'body_a' });
    await store.save({ name: 'b', type: 'reference', description: 'b', body: 'body_b' });

    graph.add({ name: 'a', relations: [], supersedes: [] });
    graph.add({ name: 'b', relations: [], supersedes: [] });

    // Wire several inbound edges to b. We use a moderate count (10) plus
    // a healthy alpha so the boost (alpha * log(11) ~= 1.2 at alpha=0.5)
    // dwarfs the small cosine gap (~0.01) between A and B. Keeping the
    // count modest keeps the test fast.
    const inb = 10;
    for (let i = 0; i < inb; i++) {
      const name = `s_${i}`;
      const body = `body_s_${i}`;
      embedder.register(body, l2norm(new Float32Array([0, 0, 1, i / 1000])));
      await store.save({ name, type: 'reference', description: `s ${i}`, body });
      graph.add({
        name,
        relations: [{ to: 'b', type: 'builds-on' }],
        supersedes: [],
      });
    }

    // Use a healthy alpha so the boost overcomes the small cosine gap.
    const alpha = 0.5;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.7 }));
    const names = out.matches.map((m) => m.name);
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('a'));
  });

  it('boost is applied exactly once per direct hit: final scores equal `roundScore(cosine + alpha * log(1 + inbound_count))` (within float tolerance)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 3);

    const alpha = 0.04;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f = out.matches.find((m) => m.name === 'foundational');
    const l = out.matches.find((m) => m.name === 'leaf');
    expect(f?.score).toBeCloseTo(roundScore(1.0 + alpha * Math.log(1 + 3)), 5);
    expect(l?.score).toBeCloseTo(roundScore(1.0 + alpha * Math.log(1 + 0)), 5);
  });

  it("when memory_search is called with `expand: 'one-hop'`, the decayed score for an expanded neighbor is computed from the BOOSTED direct-hit score (i.e. `(cosine_direct + boost_direct) * decay`), not from the raw cosine", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    // H is the direct hit (cosine 1.0); N is a neighbor of H with
    // orthogonal vector (cosine 0).
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_h', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_n', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'n', type: 'reference', description: 'n', body: 'body_n' });

    graph.add({
      name: 'h',
      relations: [{ to: 'n', type: 'builds-on' }],
      supersedes: [],
    });
    graph.add({ name: 'n', relations: [], supersedes: [] });

    // Add 4 inbound edges to H so the boost is `alpha * log(5)`.
    const inboundN = 4;
    for (let i = 0; i < inboundN; i++) {
      const name = `inb_h_${i}`;
      const body = `body_inb_h_${i}`;
      embedder.register(body, l2norm(new Float32Array([0, 0, 1, i / 1000])));
      await store.save({ name, type: 'reference', description: `inb ${i}`, body });
      graph.add({
        name,
        relations: [{ to: 'h', type: 'builds-on' }],
        supersedes: [],
      });
    }

    const alpha = 0.05;
    const decay = 0.5;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
      expansionDecay: decay,
    });
    const out = asResult(
      await handler({
        query: 'q',
        limit: 10,
        expand: 'one-hop',
        threshold: 0.4,
      }),
    );
    const h = out.matches.find((m) => m.name === 'h');
    const n = out.matches.find((m) => m.name === 'n');
    expect(h).toBeDefined();
    expect(n).toBeDefined();
    if (!h || !n) return;
    // H's boosted score: cosine 1.0 + alpha * log(1 + 4)
    const boostedH = 1.0 + alpha * Math.log(1 + inboundN);
    // N is decayed from H's BOOSTED score, not raw cosine.
    expect(n.score).toBeCloseTo(roundScore(boostedH * decay), 5);
    expect(h.score).toBeCloseTo(roundScore(boostedH), 5);
  });
});

// --------------------------------------------------------------------------
// ac-2: edge-type filter (mentions + supersedes excluded)
// --------------------------------------------------------------------------

describe('ac-2: boost calculation skips mentions and supersedes edges by default', () => {
  it("a memory whose ONLY inbound edges are 'mentions' and 'supersedes' has boost == 0 (final score equals raw cosine)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_t', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.scan();
    await store.save({ name: 't', type: 'reference', description: 't', body: 'body_t' });
    graph.add({ name: 't', relations: [], supersedes: [] });

    // Two memories that mention t (mentions edges), one that supersedes
    // t. No authored relations point at t.
    embedder.register('body_m', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_s', l2norm(new Float32Array([0, 0, 1, 0])));
    embedder.register('body_sup', l2norm(new Float32Array([0, 0, 0, 1])));
    await store.save({ name: 'm', type: 'reference', description: 'm', body: 'body_m' });
    await store.save({ name: 's', type: 'reference', description: 's', body: 'body_s' });
    await store.save({
      name: 'sup',
      type: 'reference',
      description: 'sup',
      body: 'body_sup',
    });
    graph.add({ name: 'm', relations: [], supersedes: [] });
    graph.add({ name: 's', relations: [], supersedes: [] });
    graph.add({ name: 'sup', relations: [], supersedes: ['t'] });
    graph.addMentionsEdge({ from: 'm', to: 't' });
    graph.addMentionsEdge({ from: 's', to: 't' });

    const alpha = 0.5;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
      // Even with a big alpha, mentions/supersedes inbound shouldn't
      // boost.
    });
    // includeSuperseded: true so t shows up despite being superseded.
    const out = asResult(
      await handler({ query: 'q', limit: 5, threshold: 0.5, includeSuperseded: true }),
    );
    const t = out.matches.find((m) => m.name === 't');
    expect(t).toBeDefined();
    if (!t) return;
    // Cosine 1.0; boost should be 0 because all inbound is mentions or
    // supersedes.
    expect(t.score).toBeCloseTo(roundScore(1.0), 5);
  });

  it("a memory with N authored-relation inbound edges plus K additional 'mentions' inbound edges has boost == alpha * log(1 + N) (not alpha * log(1 + N + K))", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_t', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.scan();
    await store.save({ name: 't', type: 'reference', description: 't', body: 'body_t' });
    graph.add({ name: 't', relations: [], supersedes: [] });

    const N = 3;
    const K = 7;
    for (let i = 0; i < N; i++) {
      const name = `rel_${i}`;
      const body = `body_rel_${i}`;
      embedder.register(body, l2norm(new Float32Array([0, 1, 0, i / 1000])));
      await store.save({ name, type: 'reference', description: `rel ${i}`, body });
      graph.add({
        name,
        relations: [{ to: 't', type: 'related-to' }],
        supersedes: [],
      });
    }
    for (let i = 0; i < K; i++) {
      const name = `mention_${i}`;
      const body = `body_mention_${i}`;
      embedder.register(body, l2norm(new Float32Array([0, 0, 1, i / 1000])));
      await store.save({ name, type: 'reference', description: `m ${i}`, body });
      graph.add({ name, relations: [], supersedes: [] });
      graph.addMentionsEdge({ from: name, to: 't' });
    }

    const alpha = 0.1;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
    });
    const out = asResult(await handler({ query: 'q', limit: 20, threshold: 0.5 }));
    const t = out.matches.find((m) => m.name === 't');
    expect(t).toBeDefined();
    if (!t) return;
    // Boost is computed from N (authored relations) only, ignoring the K
    // mentions edges.
    const expected = roundScore(1.0 + alpha * Math.log(1 + N));
    expect(t.score).toBeCloseTo(expected, 5);
    // And explicitly NOT alpha * log(1 + N + K).
    const wrong = roundScore(1.0 + alpha * Math.log(1 + N + K));
    expect(t.score).not.toBeCloseTo(wrong, 5);
  });

  it('the connectedness boost reads inbound edges through MemoryGraph.inbound() -- mutating the graph via addEdge after scan changes the boost on the next memory_search', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 0);

    const alpha = 0.1;
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
    });
    // Baseline: foundational has 0 inbound -> same score as leaf.
    const baseline = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f1 = baseline.matches.find((m) => m.name === 'foundational');
    expect(f1?.score).toBeCloseTo(roundScore(1.0), 5);

    // Mutate the graph in place: add a new memory that points at
    // foundational with a builds-on edge. We do this directly via
    // addEdge() to ensure the handler reads inbound counts from the
    // graph (not from re-scanning frontmatter).
    graph.add({ name: 'newref', relations: [], supersedes: [] });
    graph.addEdge({ from: 'newref', to: 'foundational', type: 'builds-on' });

    const next = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f2 = next.matches.find((m) => m.name === 'foundational');
    expect(f2?.score).toBeCloseTo(roundScore(1.0 + alpha * Math.log(1 + 1)), 5);
  });

  it("when the per-scope MemoryGraph is undefined, memory_search returns scores equal to raw cosine (no boost applied) and does not throw -- preserves the 'optional graph' contract", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 5);

    // No userGraph passed -- handler should not attempt to read inbound
    // counts and should not throw.
    const alpha = 0.02;
    const handler = createMemorySearchHandler({
      store,
      connectednessBoost: alpha,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f = out.matches.find((m) => m.name === 'foundational');
    const l = out.matches.find((m) => m.name === 'leaf');
    // Both equal to raw cosine since there's no graph to consult.
    expect(f?.score).toBeCloseTo(roundScore(1.0), 5);
    expect(l?.score).toBeCloseTo(roundScore(1.0), 5);
  });
});

// --------------------------------------------------------------------------
// ac-3 (cont.): wiring + disable-via-env
// --------------------------------------------------------------------------

describe('ac-3: alpha = 0 yields v0.1 ranking and wiring through env -> handler factory -> handler', () => {
  it('when COMMONPLACE_CONNECTEDNESS_BOOST=0 is resolved at boot, memory_search returns matches whose final scores equal raw cosine (boost is exactly zero, not approximately)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 5);

    const alpha = resolveConnectednessBoost({ [ENV_CONNECTEDNESS_BOOST]: '0' });
    expect(alpha).toBe(0);
    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: alpha,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f = out.matches.find((m) => m.name === 'foundational');
    const l = out.matches.find((m) => m.name === 'leaf');
    // Boost is exactly zero -> both scores equal raw cosine (1.0).
    expect(f?.score).toBe(roundScore(1.0));
    expect(l?.score).toBe(roundScore(1.0));
  });

  it('createDefaultHandlers wires `connectednessBoost` through to memory_search', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 5);

    const alpha = 0.1;
    const handlers = createDefaultHandlers({
      userStore: store,
      graph,
      connectednessBoost: alpha,
    });
    const out = asResult(await handlers.memory_search({ query: 'q', limit: 5, threshold: 0.5 }));
    const f = (out as MemorySearchResult).matches.find((m) => m.name === 'foundational');
    expect(f?.score).toBeCloseTo(roundScore(1.0 + alpha * Math.log(1 + 5)), 5);
  });
});

// --------------------------------------------------------------------------
// ac-4: synthetic-corpus / ranking-stability scenarios
// --------------------------------------------------------------------------

describe('ac-4: synthetic foundational+leaf corpus and ranking stability', () => {
  it('synthetic corpus: a foundational memory with 5 inbound authored-relation edges and a leaf with 0 inbound edges, both cosine 0.6 to the query, returns foundational strictly above leaf', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    // Set up vectors so foundational and leaf BOTH have cosine 0.6 to q.
    // We use a query oriented in (1, 0) and bodies in (0.6, 0.8) (i.e.
    // l2-normalised: cos = 0.6 * 1 + 0.8 * 0 = 0.6).
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_f', new Float32Array([0.6, 0.8, 0, 0]));
    embedder.register('body_l', new Float32Array([0.6, 0.8, 0, 0]));
    await store.scan();
    await store.save({
      name: 'foundational',
      type: 'reference',
      description: 'f',
      body: 'body_f',
    });
    await store.save({ name: 'leaf', type: 'reference', description: 'l', body: 'body_l' });
    graph.add({ name: 'foundational', relations: [], supersedes: [] });
    graph.add({ name: 'leaf', relations: [], supersedes: [] });

    for (let i = 0; i < 5; i++) {
      const name = `inb_${i}`;
      const body = `body_inb_${i}`;
      embedder.register(body, l2norm(new Float32Array([0, 1, 0, i / 100])));
      await store.save({ name, type: 'reference', description: `inb ${i}`, body });
      graph.add({
        name,
        relations: [{ to: 'foundational', type: 'builds-on' }],
        supersedes: [],
      });
    }

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: DEFAULT_CONNECTEDNESS_BOOST,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const names = out.matches.map((m) => m.name);
    expect(names.indexOf('foundational')).toBeLessThan(names.indexOf('leaf'));
  });

  it('alpha = 0 on the same foundational+leaf corpus returns matches whose scores are equal to raw cosine -- pre-boost ordering preserved (deterministic)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    await seedFoundationalLeaf(store, graph, embedder, 5);

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const f = out.matches.find((m) => m.name === 'foundational');
    const l = out.matches.find((m) => m.name === 'leaf');
    // Both equal to raw cosine; no boost applied.
    expect(f?.score).toBe(roundScore(1.0));
    expect(l?.score).toBe(roundScore(1.0));
  });

  it('ranking-stability sweep: for alpha in [0, 0.01, 0.02, 0.05, 0.1], a memory H (cosine 0.9, no inbound) always ranks above memory L (cosine 0.2 with many inbound)', async () => {
    // Set up the corpus once and reuse it across alpha values. Disk I/O
    // for saving memories dominates the test time; sweeping alpha only
    // requires re-creating the handler with the new value (the store
    // and graph are unchanged).
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    // H: cosine 0.9 (after l2norm).
    embedder.register('body_h', new Float32Array([0.9, Math.sqrt(1 - 0.81), 0, 0]));
    // L: cosine 0.2 (after l2norm).
    embedder.register('body_l', new Float32Array([0.2, Math.sqrt(1 - 0.04), 0, 0]));
    await store.scan();
    await store.save({ name: 'h', type: 'reference', description: 'h', body: 'body_h' });
    await store.save({ name: 'l', type: 'reference', description: 'l', body: 'body_l' });
    graph.add({ name: 'h', relations: [], supersedes: [] });
    graph.add({ name: 'l', relations: [], supersedes: [] });

    // Many inbound edges to L (none to H). 20 is well below 50 for
    // speed but high enough that log(1 + 20) = 3.04 keeps the test
    // meaningful: with alpha=0.1 the boost (~0.30) cannot close the
    // 0.7 cosine gap between H (0.9) and L (0.2).
    const inb = 20;
    for (let i = 0; i < inb; i++) {
      const name = `s_${i}`;
      const body = `body_s_${i}`;
      embedder.register(body, l2norm(new Float32Array([0, 0, 1, i / 1000])));
      await store.save({ name, type: 'reference', description: `s ${i}`, body });
      graph.add({
        name,
        relations: [{ to: 'l', type: 'builds-on' }],
        supersedes: [],
      });
    }

    for (const alpha of [0, 0.01, 0.02, 0.05, 0.1]) {
      const handler = createMemorySearchHandler({
        store,
        userGraph: graph,
        connectednessBoost: alpha,
      });
      const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.15 }));
      const names = out.matches.map((m) => m.name);
      expect(names.indexOf('h'), `alpha=${alpha}: H should rank above L`).toBeLessThan(
        names.indexOf('l'),
      );
    }
  });

  it('boost magnitude bound: alpha * log(1 + corpus_size) for the default alpha (0.02) and a 10000-memory corpus is < 0.19 -- a future alpha bump that breaks the bound is caught here', () => {
    const corpusSize = 10000;
    const bound = DEFAULT_CONNECTEDNESS_BOOST * Math.log(1 + corpusSize);
    expect(bound).toBeLessThan(0.19);
  });

  it('two memories with identical raw cosine AND identical inbound_count produce identical post-boost scores (no spurious ordering change)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();

    // Two memories with identical cosine to query.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.scan();
    await store.save({ name: 'a', type: 'reference', description: 'a', body: 'body_a' });
    await store.save({ name: 'b', type: 'reference', description: 'b', body: 'body_b' });
    graph.add({ name: 'a', relations: [], supersedes: [] });
    graph.add({ name: 'b', relations: [], supersedes: [] });

    // Identical inbound counts: 3 each.
    for (let i = 0; i < 3; i++) {
      for (const target of ['a', 'b']) {
        const name = `s_${target}_${i}`;
        const body = `body_s_${target}_${i}`;
        embedder.register(body, l2norm(new Float32Array([0, 1, 0, i / 1000])));
        await store.save({ name, type: 'reference', description: 's', body });
        graph.add({
          name,
          relations: [{ to: target, type: 'builds-on' }],
          supersedes: [],
        });
      }
    }

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0.1,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, threshold: 0.5 }));
    const a = out.matches.find((m) => m.name === 'a');
    const b = out.matches.find((m) => m.name === 'b');
    expect(a?.score).toBe(b?.score);
  });
});

// --------------------------------------------------------------------------
// ac-5: README documentation
// --------------------------------------------------------------------------

describe('ac-5: README documents the formula, rationale, env var, and expansion interaction', () => {
  it('README.md contains the formula `final_score = cosine_score + alpha * log(1 + inbound_count)` and the default alpha = 0.02', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    // Formula. We accept the verbatim form or its plain-text equivalent.
    expect(readme).toMatch(
      /final_score\s*=\s*cosine_score\s*\+\s*alpha\s*\*\s*log\(\s*1\s*\+\s*inbound_count\s*\)/,
    );
    // Default alpha called out.
    expect(readme).toMatch(/0\.02/);
  });

  it('README.md documents the rationale: foundational memories rank slightly above leaves with similar cosine; small alpha so cosine still dominates between dissimilar memories', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/foundational/i);
    expect(readme).toMatch(/leaf|leaves/i);
    expect(readme).toMatch(/cosine still dominates|cosine.+dominates/i);
  });

  it('README.md documents that the boost excludes `mentions` and `supersedes` edges by default', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    // Match a sentence that talks about both excluded edge types.
    expect(readme).toMatch(/mentions/);
    expect(readme).toMatch(/supersedes/);
    expect(readme).toMatch(/exclud|skip|ignore/i);
  });

  it('README.md documents the COMMONPLACE_CONNECTEDNESS_BOOST env var with default 0.02, disable value 0, and invalid-value behaviour', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/COMMONPLACE_CONNECTEDNESS_BOOST/);
    expect(readme).toMatch(/0\.02/);
    expect(readme).toMatch(/\b0\b/);
    expect(readme).toMatch(/non-negative|negative|invalid/i);
  });

  it('README.md notes the interaction with one-hop expansion: expanded neighbors decay the BOOSTED direct-hit score', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/boosted/i);
    expect(readme).toMatch(/expansion|expand|one-hop|neighbor/i);
  });
});
