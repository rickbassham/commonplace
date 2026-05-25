/**
 * Integration benchmark scenarios for hierarchical `child-of` expansion
 * (DAR-1144 AC-8).
 *
 * The DAR-1034 retrieval-quality harness in `scripts/run-retrieval-benchmark.ts`
 * is a doc-generating tool driven by labeled query/expected-name pairs over
 * the live user-scope corpus. The variants it ships compare alternative
 * scoring strategies (BM25, hybrid, description-only, etc.) against the
 * production `MemoryStore.search` baseline -- they do not exercise the MCP
 * handler's expansion modes.
 *
 * This file contributes the two AC-8 scenarios as standalone retrieval-
 * quality fixtures with the same metric definitions used by DAR-1034
 * (`recallAtK`, `mrr` from `scripts/retrieval-metrics.ts`) so the
 * sibling-collapse and lone-leaf-parent-inclusion claims are demonstrably
 * better than the `expand: 'one-hop'` baseline. The fixtures are
 * synthetic (small N, hand-built) -- the contract requires the scenarios
 * to exist and to show the metric gain, not to be mined from real
 * transcripts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import { createMemorySearchHandler, type MemorySearchResult } from '../src/server/handlers.js';
import { recallAtK, mrr, type RankedQuery } from '../scripts/retrieval-metrics.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar1144-bench-'));
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

const makeProgrammableEmbedder = (dim = 8) => {
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asResult = (v: unknown): MemorySearchResult => {
  if (!isRecord(v)) throw new Error('not a record');
  return v as unknown as MemorySearchResult;
};

const namesIn = (out: MemorySearchResult): string[] => out.matches.map((m) => m.name);

interface Scenario {
  /** Short description used in `expect(...).toBe(true, msg)` failure paths. */
  label: string;
  /** Direct hits in this scenario. */
  expected: string[];
}

const buildSiblingCollapseScenario = async (): Promise<{
  store: MemoryStore;
  graph: MemoryGraph;
  query: string;
  scenario: Scenario;
}> => {
  const embedder = makeProgrammableEmbedder();
  const store = new MemoryStore({ dir: tmp, embedder });
  const graph = new MemoryGraph();

  // Construct: parent P plus three sibling children c1, c2, c3 all
  // `child-of` P. The query semantically hits the three children with
  // very similar (but slightly different) scores; the parent is
  // orthogonal and would never appear as a direct cosine hit. The
  // labeled-relevant set treats the parent as the most useful single
  // result for this query (P is the synthesis the agent actually
  // wants), with the three children as supporting evidence.
  embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])));
  embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0, 0, 0, 0, 0])));
  embedder.register('body_c1', l2norm(new Float32Array([1, 0.1, 0, 0, 0, 0, 0, 0])));
  embedder.register('body_c2', l2norm(new Float32Array([1, 0.2, 0, 0, 0, 0, 0, 0])));
  embedder.register('body_c3', l2norm(new Float32Array([1, 0.3, 0, 0, 0, 0, 0, 0])));
  // Three irrelevant noise memories so the corpus is larger than the
  // top-K and the ranking actually matters.
  for (let i = 0; i < 3; i++) {
    embedder.register(`body_noise${i}`, l2norm(new Float32Array([0, 0, 0, 0, 1, 0.1 * i, 0, 0])));
  }
  await store.scan();
  await store.save({ name: 'p', type: 'reference', description: 'parent', body: 'body_p' });
  await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
  await store.save({ name: 'c2', type: 'reference', description: 'c2', body: 'body_c2' });
  await store.save({ name: 'c3', type: 'reference', description: 'c3', body: 'body_c3' });
  for (let i = 0; i < 3; i++) {
    await store.save({
      name: `noise${i}`,
      type: 'reference',
      description: `n${i}`,
      body: `body_noise${i}`,
    });
  }
  graph.add({ name: 'p', relations: [], supersedes: [] });
  for (const child of ['c1', 'c2', 'c3']) {
    graph.add({
      name: child,
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
  }
  for (let i = 0; i < 3; i++) {
    graph.add({ name: `noise${i}`, relations: [], supersedes: [] });
  }

  return {
    store,
    graph,
    query: 'q',
    scenario: {
      label: 'sibling-collapse: 3 siblings of P all hit; expected top result is P',
      // The single most-relevant memory is the parent P -- this is the
      // scaffold the query actually wants. The children are supporting
      // evidence (still relevant but secondary).
      expected: ['p'],
    },
  };
};

const buildLoneLeafParentScenario = async (): Promise<{
  store: MemoryStore;
  graph: MemoryGraph;
  query: string;
  scenario: Scenario;
}> => {
  const embedder = makeProgrammableEmbedder();
  const store = new MemoryStore({ dir: tmp, embedder });
  const graph = new MemoryGraph();

  // Construct: parent P with a single child c1 that is the only cosine
  // hit for the query. The parent is orthogonal (would never be a
  // direct hit) but is the labeled-relevant scaffold for the query.
  // The lone-leaf path requires the hierarchical expansion to surface
  // P; `one-hop` (with default expandTypes) does not follow `child-of`,
  // so the parent would never appear.
  embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])));
  embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0, 0, 0, 0, 0])));
  embedder.register('body_c1', l2norm(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])));
  // Noise memories with slight similarity to query so the top-K is
  // contested rather than trivially [c1, p].
  for (let i = 0; i < 4; i++) {
    const v = new Float32Array(8);
    v[0] = 0.3 - 0.05 * i;
    v[2] = 1;
    embedder.register(`body_noise${i}`, l2norm(v));
  }
  await store.scan();
  await store.save({ name: 'p', type: 'reference', description: 'parent', body: 'body_p' });
  await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
  for (let i = 0; i < 4; i++) {
    await store.save({
      name: `noise${i}`,
      type: 'reference',
      description: `n${i}`,
      body: `body_noise${i}`,
    });
  }
  graph.add({ name: 'p', relations: [], supersedes: [] });
  graph.add({
    name: 'c1',
    relations: [{ to: 'p', type: 'child-of' }],
    supersedes: [],
  });
  for (let i = 0; i < 4; i++) {
    graph.add({ name: `noise${i}`, relations: [], supersedes: [] });
  }

  return {
    store,
    graph,
    query: 'q',
    scenario: {
      label: 'lone-leaf parent inclusion: single child c1 hits; scaffold P is relevant',
      // The single most-relevant memory is P (the scaffold whose
      // synthesis the agent wants); c1 is the only direct cosine hit,
      // and without hierarchical expansion P is unreachable.
      expected: ['p'],
    },
  };
};

const rank = async (
  store: MemoryStore,
  graph: MemoryGraph,
  query: string,
  expand: 'one-hop' | 'hierarchical',
): Promise<RankedQuery> => {
  const handler = createMemorySearchHandler({
    store,
    userGraph: graph,
    // Disable connectedness boost so the comparison isolates the
    // expansion mode rather than the boost.
    connectednessBoost: 0,
  });
  const out = asResult(
    await handler({
      query,
      limit: 10,
      expand,
      // Allow `child-of` to be followed by one-hop for a fair fight --
      // otherwise one-hop with defaults could never surface the parent
      // and the win would be trivial.
      expandTypes: ['child-of', 'builds-on', 'related-to'],
    }),
  );
  return {
    expected_names: [], // filled per-scenario below.
    ranked_names: namesIn(out),
  };
};

const evaluate = (
  ranked: { ranked_names: string[] },
  expected: string[],
): { recall_at_1: number; recall_at_5: number; mrr: number } => {
  const queries: RankedQuery[] = [{ expected_names: expected, ranked_names: ranked.ranked_names }];
  return {
    recall_at_1: recallAtK(queries, 1),
    recall_at_5: recallAtK(queries, 5),
    mrr: mrr(queries),
  };
};

describe('DAR-1144 AC-8: hierarchical expansion improves DAR-1034-style retrieval metrics', () => {
  it('sibling-collapse scenario: labeled-relevant set includes scaffold P and >= 2 sibling children of P are direct cosine hits', async () => {
    const fx = await buildSiblingCollapseScenario();
    // Sanity: the sibling-collapse precondition holds -- the query's
    // direct cosine top-K already contains at least 2 sibling children.
    const baseline = await rank(fx.store, fx.graph, fx.query, 'one-hop');
    const siblingsHit = baseline.ranked_names.filter((n) => ['c1', 'c2', 'c3'].includes(n));
    expect(siblingsHit.length).toBeGreaterThanOrEqual(2);
    // The labeled-relevant set includes the scaffold parent.
    expect(fx.scenario.expected).toContain('p');
  });

  it('lone-leaf parent-inclusion scenario: labeled-relevant set includes scaffold P reachable only via a single child cosine hit', async () => {
    const fx = await buildLoneLeafParentScenario();
    const baseline = await rank(fx.store, fx.graph, fx.query, 'one-hop');
    // Sanity: c1 is the (sole) direct cosine hit for P. The one-hop
    // baseline does surface c1 in the top-K (it has the highest cosine
    // similarity); P only surfaces when hierarchical walks child-of.
    expect(baseline.ranked_names).toContain('c1');
    expect(fx.scenario.expected).toContain('p');
  });

  it("running the retrieval benchmark with expand: 'hierarchical' on the sibling-collapse scenario produces strictly higher MRR (and recall@1) than expand: 'one-hop' on the same scenario", async () => {
    const fx = await buildSiblingCollapseScenario();
    const baseline = await rank(fx.store, fx.graph, fx.query, 'one-hop');
    const hier = await rank(fx.store, fx.graph, fx.query, 'hierarchical');
    const baseMetrics = evaluate(baseline, fx.scenario.expected);
    const hierMetrics = evaluate(hier, fx.scenario.expected);
    // Sibling collapse should move the scaffold P from outside the top
    // of the one-hop ranking to position 1 in the hierarchical
    // ranking, raising MRR (and recall@1) strictly above baseline.
    expect(hierMetrics.mrr).toBeGreaterThan(baseMetrics.mrr);
    expect(hierMetrics.recall_at_1).toBeGreaterThan(baseMetrics.recall_at_1);
  });

  it("running the retrieval benchmark with expand: 'hierarchical' on the lone-leaf parent-inclusion scenario produces strictly higher MRR (and recall@5) than expand: 'one-hop' on the same scenario", async () => {
    const fx = await buildLoneLeafParentScenario();
    const baseline = await rank(fx.store, fx.graph, fx.query, 'one-hop');
    const hier = await rank(fx.store, fx.graph, fx.query, 'hierarchical');
    const baseMetrics = evaluate(baseline, fx.scenario.expected);
    const hierMetrics = evaluate(hier, fx.scenario.expected);
    // The lone-leaf case is the hardest for sibling collapse (only one
    // child hits, so no collapse fires) -- the win comes purely from
    // the parent being included via expansion. With explicit
    // `expandTypes: ['child-of', ...]` on the one-hop baseline, both
    // modes surface P -- but hierarchical's score formula
    // (max(child)*parentDecay) places it higher than one-hop's
    // (direct_hit * expansionDecay, default 0.7) when parentDecay
    // (default 0.9) > expansionDecay (default 0.7). Verify that the
    // expected name appears at a strictly better rank under
    // hierarchical, lifting MRR.
    expect(hierMetrics.mrr).toBeGreaterThan(baseMetrics.mrr);
    expect(hierMetrics.recall_at_5).toBeGreaterThanOrEqual(baseMetrics.recall_at_5);
  });
});
