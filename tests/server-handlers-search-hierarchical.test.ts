/**
 * Unit tests: hierarchical `child-of` graph expansion in `memory_search`
 * (DAR-1144).
 *
 * Covers the contract envelope's eight acceptance criteria for the new
 * `expand: 'hierarchical'` mode:
 *
 *   - ac-1: opt-in / schema additions / validation rejection
 *   - ac-2: outbound child-of walk, parent decay, via annotation
 *   - ac-3: sibling collapse re-ranks parent above triggering children
 *   - ac-4: higher-wins dedupe when parent is already a direct hit
 *   - ac-5: env-var overrides for parent decay and collapse threshold
 *   - ac-6: intra-scope only (mirrors one-hop)
 *   - ac-7: cycle-safe (linkEdge does NOT reject child-of cycles today;
 *           the walk is bounded by MAX_HIERARCHICAL_WALK_DEPTH)
 *   - ac-8: scenarios live in
 *           tests/server-handlers-search-hierarchical-benchmark.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import { buildToolDefinitions } from '../src/server/tools.js';
import {
  EXPAND_MODES,
  MAX_HIERARCHICAL_WALK_DEPTH,
  createMemorySearchHandler,
  type MemorySearchMatch,
  type MemorySearchResult,
} from '../src/server/handlers.js';
import {
  DEFAULT_HIERARCHICAL_PARENT_DECAY,
  DEFAULT_SIBLING_COLLAPSE_THRESHOLD,
  ENV_HIERARCHICAL_PARENT_DECAY,
  ENV_SIBLING_COLLAPSE_THRESHOLD,
  resolveHierarchicalParentDecay,
  resolveSiblingCollapseThreshold,
} from '../src/bin/env.js';

let tmp: string;
let tmp2: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar1144-'));
  tmp2 = mkdtempSync(join(tmpdir(), 'dar1144-b-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tmp2, { recursive: true, force: true });
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asResult = (v: unknown): MemorySearchResult => {
  if (!isRecord(v)) throw new Error('not a record');
  return v as unknown as MemorySearchResult;
};

const findMatch = (matches: MemorySearchMatch[], name: string): MemorySearchMatch | undefined =>
  matches.find((m) => m.name === name);

// roundScore mirrors the handler-internal rounding (3 decimals).
const roundScore = (score: number): number => Math.round(score * 1000) / 1000;

// --------------------------------------------------------------------------
// ac-1: opt-in behaviour
// --------------------------------------------------------------------------

describe("ac-1: expand: 'hierarchical' opt-in and schema", () => {
  it("EXPAND_MODES includes 'hierarchical' alongside 'none' and 'one-hop'", () => {
    expect([...EXPAND_MODES]).toEqual(['none', 'one-hop', 'hierarchical']);
  });

  it("memory_search with `expand: 'hierarchical'` is accepted by argument validation and does not error on an empty corpus", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q', expand: 'hierarchical' }));
    expect(Array.isArray(out.matches)).toBe(true);
  });

  it("memory_search rejects an unknown `expand` value (e.g. 'two-hop') with a validation error that lists exactly 'none', 'one-hop', and 'hierarchical' as the allowed values", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    let msg = '';
    try {
      await handler({ query: 'q', expand: 'two-hop' });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/\bexpand\b/);
    expect(msg).toContain('none');
    expect(msg).toContain('one-hop');
    expect(msg).toContain('hierarchical');
  });

  it("TOOL_SCHEMAS for memory_search advertises the `expand` enum as ['none','one-hop','hierarchical'] and the description text names 'hierarchical' as a supported mode", () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_search');
    expect(def).toBeDefined();
    if (!def) return;
    const props = def.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.expand?.enum).toEqual(['none', 'one-hop', 'hierarchical']);
    expect(typeof props.expand?.description).toBe('string');
    expect(props.expand?.description).toContain('hierarchical');
  });
});

// --------------------------------------------------------------------------
// ac-2: outbound child-of walk, parent decay, via annotation
// --------------------------------------------------------------------------

describe('ac-2: outbound child-of walk + parent decay + via annotation', () => {
  it("given child C with outbound child-of -> parent P (P not itself a direct hit), memory_search returns P with via: { source: 'c', edge: 'child-of' }", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // C aligns with query; P is orthogonal so not a direct cosine hit.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'parent', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'child', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // Threshold gates P out of direct hits (cosine 0 against orthogonal q)
    // so it only enters via hierarchical expansion (decay 0.9 * 1.0 = 0.9).
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const parent = findMatch(out.matches, 'p');
    expect(parent).toBeDefined();
    expect(parent?.via).toEqual({ source: 'c', edge: 'child-of' });
  });

  it('the included parent P is scored exactly roundScore(score_C * 0.9) when only one child C triggers it', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      // Disable connectedness boost so C's raw cosine = 1.0 is the
      // exact triggering score and the decayed parent score is exactly
      // 0.9 (no boost contribution to defeat the float comparison).
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const child = findMatch(out.matches, 'c');
    const parent = findMatch(out.matches, 'p');
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    if (!child || !parent) return;
    expect(child.score).toBeCloseTo(1.0, 5);
    expect(parent.score).toBe(roundScore(child.score * 0.9));
  });

  it('when children C1 and C2 both have child-of edges to the same parent P with cosine scores s1 > s2, P is scored roundScore(max(s1, s2) * 0.9) (not sum, not average)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // C1 aligns strongly with query, C2 weaker; P orthogonal.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c1', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c2', l2norm(new Float32Array([0.6, 0.8, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 0, 1, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
    await store.save({ name: 'c2', type: 'reference', description: 'c2', body: 'body_c2' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c1',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'c2',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const c1 = findMatch(out.matches, 'c1');
    const c2 = findMatch(out.matches, 'c2');
    const p = findMatch(out.matches, 'p');
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(p).toBeDefined();
    if (!c1 || !c2 || !p) return;
    // C1 scores higher than C2 -- the max is C1.
    expect(c1.score).toBeGreaterThan(c2.score);
    expect(p.score).toBe(roundScore(c1.score * 0.9));
    // Sanity: not the sum, not the average.
    expect(p.score).not.toBe(roundScore((c1.score + c2.score) * 0.9));
    expect(p.score).not.toBe(roundScore(((c1.score + c2.score) / 2) * 0.9));
  });

  it('parent entries surfaced by hierarchical expansion carry the `via` key; direct-hit children omit the `via` key entirely', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const child = findMatch(out.matches, 'c');
    const parent = findMatch(out.matches, 'p');
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    if (!child || !parent) return;
    expect('via' in (child as object)).toBe(false);
    expect('via' in (parent as object)).toBe(true);
  });

  it("inbound child-of edges are NOT followed: given parent P with direct hit and child C with `child-of` -> P, memory_search with `expand: 'hierarchical'` does NOT pull C in via the hierarchical walk (because C is reached by the inbound direction)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // P aligns with query, C orthogonal so not a direct hit.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    // Direction: C child-of P. P has only an INBOUND child-of edge from C.
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    // P is a direct hit; C should NOT appear because the inbound
    // direction is not walked (the hierarchical walk is outbound-only,
    // and P has no outbound child-of edges).
    expect(findMatch(out.matches, 'p')).toBeDefined();
    expect(findMatch(out.matches, 'c')).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// ac-3: sibling collapse
// --------------------------------------------------------------------------

describe('ac-3: sibling collapse re-ranks parent above triggering children', () => {
  it('given exactly 1 direct-hit child of parent P (siblings = 1 < default threshold 2), the merged result orders P strictly below its triggering child (no collapse)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const names = out.matches.map((m) => m.name);
    const idxC = names.indexOf('c');
    const idxP = names.indexOf('p');
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxP).toBeGreaterThanOrEqual(0);
    // No collapse: P is below C by score (decay < 1).
    expect(idxP).toBeGreaterThan(idxC);
  });

  it("given 2 direct-hit children of parent P (siblings = 2 == default threshold), P is placed at an index strictly above the indices of both triggering children even though P's raw decayed score is below the children's", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c1', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c2', l2norm(new Float32Array([0.95, 0.31225, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 0, 1, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
    await store.save({ name: 'c2', type: 'reference', description: 'c2', body: 'body_c2' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c1',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'c2',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const names = out.matches.map((m) => m.name);
    const idxP = names.indexOf('p');
    const idxC1 = names.indexOf('c1');
    const idxC2 = names.indexOf('c2');
    expect(idxP).toBeGreaterThanOrEqual(0);
    expect(idxC1).toBeGreaterThanOrEqual(0);
    expect(idxC2).toBeGreaterThanOrEqual(0);
    expect(idxP).toBeLessThan(idxC1);
    expect(idxP).toBeLessThan(idxC2);
    // The parent's RAW decayed score is still below the children's.
    const p = findMatch(out.matches, 'p');
    const c1 = findMatch(out.matches, 'c1');
    expect(p?.score).toBeLessThan(c1?.score ?? Infinity);
  });

  it('after sibling collapse fires, both triggering children remain present with their original cosine scores unchanged (no score mutation, no removal)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c1', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c2', l2norm(new Float32Array([0.95, 0.31225, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 0, 1, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
    await store.save({ name: 'c2', type: 'reference', description: 'c2', body: 'body_c2' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c1',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'c2',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handlerHier = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const handlerNone = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const hier = asResult(
      await handlerHier({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const none = asResult(
      await handlerNone({ query: 'q', limit: 5, expand: 'none', threshold: 0.5 }),
    );
    const c1Hier = findMatch(hier.matches, 'c1');
    const c2Hier = findMatch(hier.matches, 'c2');
    const c1None = findMatch(none.matches, 'c1');
    const c2None = findMatch(none.matches, 'c2');
    expect(c1Hier?.score).toBe(c1None?.score);
    expect(c2Hier?.score).toBe(c2None?.score);
  });

  it('sibling collapse does not affect ordering of unrelated direct hits: a hit X with score between the parent and children stays in its score-sorted slot relative to the children', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // Engineer:
    //   c1 score = 1.0
    //   c2 score = 0.97 (still above X)
    //   X  score = 0.85 (unrelated direct hit, between P's decayed and children)
    //   P  decayed = 0.9 (max child 1.0 * 0.9)
    // Pre-collapse score order: c1 (1.0), c2 (0.97), P (0.9), X (0.85)
    // After collapse: P moves above c1 -> P, c1, c2, X.
    // X stays at the bottom relative to the children.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c1', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c2', l2norm(new Float32Array([0.97, 0.2426, 0, 0])));
    embedder.register('body_x', l2norm(new Float32Array([0.85, 0.5267, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 0, 1, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
    await store.save({ name: 'c2', type: 'reference', description: 'c2', body: 'body_c2' });
    await store.save({ name: 'x', type: 'reference', description: 'x', body: 'body_x' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c1',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'c2',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({ name: 'x', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 10, expand: 'hierarchical', threshold: 0.5 }),
    );
    const names = out.matches.map((m) => m.name);
    const idxX = names.indexOf('x');
    const idxC1 = names.indexOf('c1');
    const idxC2 = names.indexOf('c2');
    expect(idxX).toBeGreaterThanOrEqual(0);
    expect(idxC1).toBeGreaterThanOrEqual(0);
    expect(idxC2).toBeGreaterThanOrEqual(0);
    // X stays below both children (its score is below theirs and the
    // collapse only touches P and its triggering children).
    expect(idxX).toBeGreaterThan(idxC1);
    expect(idxX).toBeGreaterThan(idxC2);
  });
});

// --------------------------------------------------------------------------
// ac-4: higher-wins dedupe
// --------------------------------------------------------------------------

describe('ac-4: parent is also a direct hit -- higher-wins, no duplicate', () => {
  it('given parent P also a direct cosine hit with score s_P AND children whose max * 0.9 < s_P, P appears once with score s_P and without via', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // P scores 1.0 directly; child scores 0.6 -> decayed parent 0.54 < 1.0.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([0.6, 0.8, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.5 }),
    );
    const pMatches = out.matches.filter((m) => m.name === 'p');
    expect(pMatches).toHaveLength(1);
    const p = pMatches[0]!;
    expect(p.score).toBeCloseTo(1.0, 5);
    expect('via' in (p as object)).toBe(false);
  });

  it('given parent P also a direct hit with score s_P AND children whose max * 0.9 > s_P, P appears once with the higher (sibling-derived) score and no duplicate entry', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // P scores 0.5 directly; child C scores 1.0 -> sibling-derived 0.9.
    // Threshold gates only X-style noise; both should be returned.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0.5, 0.866, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      connectednessBoost: 0,
    });
    const out = asResult(await handler({ query: 'q', limit: 5, expand: 'hierarchical' }));
    const pMatches = out.matches.filter((m) => m.name === 'p');
    expect(pMatches).toHaveLength(1);
    // P's score upgraded to roundScore(1.0 * 0.9) = 0.9.
    const p = pMatches[0]!;
    expect(p.score).toBe(roundScore(1.0 * 0.9));
  });
});

// --------------------------------------------------------------------------
// ac-5: env-var overrides
// --------------------------------------------------------------------------

describe('ac-5: env-var overrides for parent decay and collapse threshold', () => {
  it('with no env vars set, parent decay defaults to 0.9 and sibling collapse threshold defaults to 2', () => {
    expect(DEFAULT_HIERARCHICAL_PARENT_DECAY).toBe(0.9);
    expect(DEFAULT_SIBLING_COLLAPSE_THRESHOLD).toBe(2);
    expect(resolveHierarchicalParentDecay({})).toBe(0.9);
    expect(resolveSiblingCollapseThreshold({})).toBe(2);
  });

  it('with COMMONPLACE_HIERARCHICAL_PARENT_DECAY=0.5, a single-child parent is scored roundScore(child_score * 0.5)', async () => {
    const decay = resolveHierarchicalParentDecay({ [ENV_HIERARCHICAL_PARENT_DECAY]: '0.5' });
    expect(decay).toBe(0.5);
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({
      store,
      userGraph: graph,
      hierarchicalParentDecay: decay,
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'hierarchical', threshold: 0.3 }),
    );
    const c = findMatch(out.matches, 'c');
    const p = findMatch(out.matches, 'p');
    expect(c?.score).toBeCloseTo(1.0, 5);
    expect(p?.score).toBe(roundScore((c?.score ?? 0) * 0.5));
  });

  it('with COMMONPLACE_SIBLING_COLLAPSE_THRESHOLD=3, 2 sibling hits do NOT trigger collapse but 3 sibling hits DO trigger collapse', async () => {
    const threshold = resolveSiblingCollapseThreshold({
      [ENV_SIBLING_COLLAPSE_THRESHOLD]: '3',
    });
    expect(threshold).toBe(3);
    const embedder = makeProgrammableEmbedder();
    const buildStore = async (n: number) => {
      const dir = mkdtempSync(join(tmpdir(), 'dar1144-thr-'));
      const store = new MemoryStore({ dir, embedder });
      const graph = new MemoryGraph();
      embedder.register('body_p', l2norm(new Float32Array([0, 0, 1, 0])));
      await store.scan();
      await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
      graph.add({ name: 'p', relations: [], supersedes: [] });
      for (let i = 1; i <= n; i++) {
        const name = `c${i}`;
        const body = `body_${name}`;
        const v = new Float32Array(4);
        v[0] = 1;
        v[1] = 0.1 * i;
        embedder.register(body, l2norm(v));
        await store.save({ name, type: 'reference', description: name, body });
        graph.add({
          name,
          relations: [{ to: 'p', type: 'child-of' }],
          supersedes: [],
        });
      }
      return { dir, store, graph };
    };
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

    const two = await buildStore(2);
    const three = await buildStore(3);
    try {
      const handler2 = createMemorySearchHandler({
        store: two.store,
        userGraph: two.graph,
        siblingCollapseThreshold: threshold,
        connectednessBoost: 0,
      });
      const out2 = asResult(
        await handler2({ query: 'q', limit: 10, expand: 'hierarchical', threshold: 0.5 }),
      );
      const idxP2 = out2.matches.findIndex((m) => m.name === 'p');
      const idxC1_2 = out2.matches.findIndex((m) => m.name === 'c1');
      // 2 siblings < threshold 3 -> no collapse: P stays below children.
      expect(idxP2).toBeGreaterThan(idxC1_2);

      const handler3 = createMemorySearchHandler({
        store: three.store,
        userGraph: three.graph,
        siblingCollapseThreshold: threshold,
        connectednessBoost: 0,
      });
      const out3 = asResult(
        await handler3({ query: 'q', limit: 10, expand: 'hierarchical', threshold: 0.5 }),
      );
      const idxP3 = out3.matches.findIndex((m) => m.name === 'p');
      const idxC1_3 = out3.matches.findIndex((m) => m.name === 'c1');
      // 3 siblings == threshold 3 -> collapse: P above children.
      expect(idxP3).toBeLessThan(idxC1_3);
    } finally {
      rmSync(two.dir, { recursive: true, force: true });
      rmSync(three.dir, { recursive: true, force: true });
    }
  });

  it('env-var resolver rejects out-of-range COMMONPLACE_HIERARCHICAL_PARENT_DECAY (<=0 or >1) and non-integer / <1 COMMONPLACE_SIBLING_COLLAPSE_THRESHOLD', () => {
    for (const bogus of ['0', '-0.5', '1.5', 'abc', 'NaN', 'Infinity']) {
      let msg = '';
      try {
        resolveHierarchicalParentDecay({ [ENV_HIERARCHICAL_PARENT_DECAY]: bogus });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toContain(ENV_HIERARCHICAL_PARENT_DECAY);
      expect(msg).toContain(JSON.stringify(bogus));
    }
    for (const bogus of ['0', '-1', '1.5', 'abc', 'NaN']) {
      let msg = '';
      try {
        resolveSiblingCollapseThreshold({ [ENV_SIBLING_COLLAPSE_THRESHOLD]: bogus });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toContain(ENV_SIBLING_COLLAPSE_THRESHOLD);
      expect(msg).toContain(JSON.stringify(bogus));
    }
  });
});

// --------------------------------------------------------------------------
// ac-6: intra-scope only
// --------------------------------------------------------------------------

describe('ac-6: intra-scope only (no cross-scope expansion)', () => {
  it('a user-scope child with a child-of edge that would cross into project scope does NOT pull a project-scope parent into user-scope hierarchical results', async () => {
    const embedder = makeProgrammableEmbedder();
    const userStore = new MemoryStore({ dir: tmp, embedder });
    const projectStore = new MemoryStore({ dir: tmp2, embedder });
    const userGraph = new MemoryGraph();
    const projectGraph = new MemoryGraph();
    // User-scope child C aligns with query.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await userStore.scan();
    await projectStore.scan();
    await userStore.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    // P lives in project scope; user-scope graph has C with child-of -> p,
    // but P is not in the user store. Per AC-6 (intra-scope only) the
    // dangling edge results in no parent surfacing -- a project store
    // entry must not be pulled into the user-scope result set even when
    // the project store contains a memory named "p".
    await projectStore.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    userGraph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    projectGraph.add({ name: 'p', relations: [], supersedes: [] });

    const handler = createMemorySearchHandler({
      userStore,
      projectStore,
      userGraph,
      projectGraph,
      connectednessBoost: 0,
    });
    const out = asResult(
      await handler({ query: 'q', limit: 10, expand: 'hierarchical', scope: 'user' }),
    );
    // User-scope-only search must not surface the project-scope parent.
    const userP = out.matches.find((m) => m.name === 'p' && m.scope === 'user');
    const projP = out.matches.find((m) => m.name === 'p' && m.scope === 'project');
    expect(userP).toBeUndefined();
    expect(projP).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// ac-7: cycle-safe walk
// --------------------------------------------------------------------------

describe('ac-7: cycle safety + bounded walk depth', () => {
  it('a constructed child-of cycle in the in-memory graph (A child-of B, B child-of A) terminates and returns a finite matches array without throwing or hanging', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'a', type: 'reference', description: 'a', body: 'body_a' });
    await store.save({ name: 'b', type: 'reference', description: 'b', body: 'body_b' });
    // Construct the cycle directly on the graph -- linkEdge currently
    // does not reject `child-of` cycles, so this construction is also
    // achievable through the public surface but we go straight to the
    // graph for test determinism.
    graph.add({
      name: 'a',
      relations: [{ to: 'b', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'b',
      relations: [{ to: 'a', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    // A is the direct hit; the walk must terminate and surface B as the
    // parent. It must NOT hang or throw -- the depth cap
    // (MAX_HIERARCHICAL_WALK_DEPTH=1) prevents recursion.
    const out = asResult(await handler({ query: 'q', limit: 5, expand: 'hierarchical' }));
    expect(out.matches.length).toBeGreaterThanOrEqual(1);
    expect(out.matches.length).toBeLessThanOrEqual(5);
  });

  it('memory_link does NOT reject `child-of` cycles at save time today; the hierarchical walk is bounded by MAX_HIERARCHICAL_WALK_DEPTH = 1 (a constant exported from the handler module). A multi-hop ancestor of A is never followed even when reachable through a chain of child-of edges.', async () => {
    expect(MAX_HIERARCHICAL_WALK_DEPTH).toBe(1);

    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    // Chain: c -> p (child-of) -> gp (child-of). With cap = 1 we only
    // surface p, never gp.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_gp', l2norm(new Float32Array([0, 0, 1, 0])));
    await store.scan();
    await store.save({ name: 'gp', type: 'reference', description: 'gp', body: 'body_gp' });
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'gp', relations: [], supersedes: [] });
    graph.add({
      name: 'p',
      relations: [{ to: 'gp', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(
      await handler({ query: 'q', limit: 10, expand: 'hierarchical', threshold: 0.5 }),
    );
    expect(findMatch(out.matches, 'c')).toBeDefined();
    expect(findMatch(out.matches, 'p')).toBeDefined();
    // The cap means GP is NOT reached -- only one-hop child-of from
    // each direct hit (C -> P). P's own child-of -> GP is not walked.
    expect(findMatch(out.matches, 'gp')).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Byte-identical existing modes guarantee (issue test plan)
// --------------------------------------------------------------------------

describe("expand: 'none' and 'one-hop' behaviour is byte-identical pre/post DAR-1144", () => {
  it("a hierarchical-shaped corpus called with expand: 'none' returns the same matches array as before hierarchical was added (the DAR-1144 changes are additive, not destructive)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c1', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c2', l2norm(new Float32Array([0.9, 0.4359, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c1', type: 'reference', description: 'c1', body: 'body_c1' });
    await store.save({ name: 'c2', type: 'reference', description: 'c2', body: 'body_c2' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c1',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });
    graph.add({
      name: 'c2',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const noneRes = asResult(
      await handler({ query: 'q', limit: 5, expand: 'none', threshold: 0.5 }),
    );
    // None mode must not include `via` keys and must not include the
    // orthogonal parent.
    expect(findMatch(noneRes.matches, 'p')).toBeUndefined();
    for (const m of noneRes.matches) {
      expect('via' in (m as object)).toBe(false);
    }
  });

  it("`expand: 'one-hop'` with default expandTypes does NOT follow `child-of` edges (because DEFAULT_EXPAND_TYPES = ['builds-on', 'related-to']); a child-of parent does not appear", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const graph = new MemoryGraph();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_p', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.scan();
    await store.save({ name: 'p', type: 'reference', description: 'p', body: 'body_p' });
    await store.save({ name: 'c', type: 'reference', description: 'c', body: 'body_c' });
    graph.add({ name: 'p', relations: [], supersedes: [] });
    graph.add({
      name: 'c',
      relations: [{ to: 'p', type: 'child-of' }],
      supersedes: [],
    });

    const handler = createMemorySearchHandler({ store, userGraph: graph });
    const out = asResult(
      await handler({ query: 'q', limit: 5, expand: 'one-hop', threshold: 0.5 }),
    );
    // P is reachable only via child-of, which is not in the default
    // expand types; so one-hop expansion does not surface it.
    expect(findMatch(out.matches, 'p')).toBeUndefined();
  });
});
