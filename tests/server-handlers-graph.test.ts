/**
 * Unit tests: memory_graph and memory_path MCP handlers.
 *
 * Covers the in-process handler surface only: registration on TOOL_NAMES,
 * ListTools schema shape, CallTool dispatch, BFS traversal correctness
 * (depth/types/direction filters), cycle handling, and the documented
 * response shape including the `{ path: null, reason }` discriminator.
 *
 * Performance assertions live in
 * `server-handlers-graph-perf.integration.test.ts` because they rely on a
 * 10K-entry synthetic graph and a warmup pass. Spawned-bin end-to-end
 * coverage lives in `server-bin-graph.integration.test.ts`.
 *
 * Pattern matches `server-handlers-link.test.ts`: a real `MemoryStore`
 * against a tmp dir + stub embedder + real `MemoryGraph` synchronised by
 * the store, seeded with hand-crafted memories so cross-name link patterns
 * are realistic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryGraph } from '../src/store/graph.js';
import { MemoryStore } from '../src/store/memory-store.js';
import type { MemoryType, RelationType } from '../src/store/memory.js';
import { callTool, createDefaultHandlers, listTools } from '../src/server/tools.js';
import {
  createMemoryGraphHandler,
  createMemoryPathHandler,
  type MemoryGraphResult,
  type MemoryPathResult,
} from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar932-'));
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

const setupHarness = async (
  memories: Array<{
    name: string;
    type?: MemoryType;
    description?: string;
    body?: string;
    relations?: { to: string; type: RelationType }[];
    supersedes?: string[];
  }>,
): Promise<Harness> => {
  const graph = new MemoryGraph({ onDangling: () => {} });
  const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
  await store.scan();
  for (const m of memories) {
    await store.save({
      name: m.name,
      type: m.type ?? 'reference',
      description: m.description ?? m.name,
      body: m.body ?? `${m.name} body`,
      relations: m.relations ?? [],
      supersedes: m.supersedes ?? [],
    });
  }
  return { store, graph };
};

// --------------------------------------------------------------------------
// ac-1: registration -- tools surface in TOOL_NAMES, ListTools, and CallTool
// --------------------------------------------------------------------------

describe('ac-1: tool registration', () => {
  it("TOOL_NAMES includes 'memory_graph' and 'memory_path' (and still includes the six prior tool names)", async () => {
    const { TOOL_NAMES } = await import('../src/server/tools.js');
    expect([...TOOL_NAMES]).toEqual([
      'memory_search',
      'memory_save',
      'memory_list',
      'memory_delete',
      'memory_link',
      'memory_unlink',
      'memory_graph',
      'memory_path',
    ]);
  });

  it("listTools() result contains 'memory_graph' and 'memory_path' entries, each with a JSON-schema-shaped inputSchema (object type with non-empty properties map matching the documented argument shape)", () => {
    const tools = listTools().tools;
    const graphTool = tools.find((t) => t.name === 'memory_graph');
    const pathTool = tools.find((t) => t.name === 'memory_path');
    expect(graphTool).toBeDefined();
    expect(pathTool).toBeDefined();

    // memory_graph: { name, depth?, types?, direction?, scope? }, required: name
    expect(graphTool!.inputSchema.type).toBe('object');
    const graphProps = graphTool!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(graphProps.name?.type).toBe('string');
    expect(graphProps.depth?.type).toBe('integer');
    expect(graphProps.types?.type).toBe('array');
    expect(graphProps.direction?.type).toBe('string');
    expect(graphProps.direction?.enum).toEqual(['out', 'in', 'both']);
    const graphRequired = (graphTool!.inputSchema as { required?: string[] }).required ?? [];
    expect(new Set(graphRequired)).toEqual(new Set(['name']));

    // memory_path: { from, to, maxDepth?, types?, scope? }, required: from + to
    expect(pathTool!.inputSchema.type).toBe('object');
    const pathProps = pathTool!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(pathProps.from?.type).toBe('string');
    expect(pathProps.to?.type).toBe('string');
    expect(pathProps.maxDepth?.type).toBe('integer');
    expect(pathProps.types?.type).toBe('array');
    const pathRequired = (pathTool!.inputSchema as { required?: string[] }).required ?? [];
    expect(new Set(pathRequired)).toEqual(new Set(['from', 'to']));
  });

  it("callTool({ name: 'memory_graph', arguments: { name: <existing> } }) dispatches to the wired handler and does NOT throw UnknownToolError or 'not implemented'", async () => {
    const { store, graph } = await setupHarness([{ name: 'alpha' }]);
    const handlers = createDefaultHandlers({ userStore: store, graph });
    const result = (await callTool(
      { name: 'memory_graph', arguments: { name: 'alpha' } },
      handlers,
    )) as MemoryGraphResult;
    expect(result.root.name).toBe('alpha');
  });

  it("callTool({ name: 'memory_path', arguments: { from: <existing>, to: <existing> } }) dispatches to the wired handler and does NOT throw UnknownToolError or 'not implemented'", async () => {
    const { store, graph } = await setupHarness([{ name: 'alpha' }, { name: 'beta' }]);
    const handlers = createDefaultHandlers({ userStore: store, graph });
    const result = (await callTool(
      { name: 'memory_path', arguments: { from: 'alpha', to: 'beta' } },
      handlers,
    )) as MemoryPathResult;
    // alpha and beta are not connected -- should be unreachable, not an error.
    if ('reason' in result) {
      expect(result.path).toBeNull();
      expect(result.reason).toBe('unreachable');
    } else {
      throw new Error('expected unreachable result for unlinked memories');
    }
  });

  it('createDefaultHandlers({ userStore, graph }) returns real (non-stub) handlers for memory_graph and memory_path; createDefaultHandlers({}) (no store/graph) returns the not-implemented stub for both names so the baseline is preserved', async () => {
    const { store, graph } = await setupHarness([{ name: 'alpha' }]);
    const real = createDefaultHandlers({ userStore: store, graph });
    // Real handlers do not throw 'not implemented'.
    await expect(real.memory_graph({ name: 'alpha' })).resolves.toBeDefined();

    const stub = createDefaultHandlers({});
    await expect(stub.memory_graph({ name: 'alpha' })).rejects.toThrow(/not implemented/);
    await expect(stub.memory_path({ from: 'alpha', to: 'beta' })).rejects.toThrow(
      /not implemented/,
    );
  });
});

// --------------------------------------------------------------------------
// ac-2: depth / types / direction
// --------------------------------------------------------------------------

describe('ac-2: traversal respects depth, type filter, direction', () => {
  it('memory_graph with depth=2 returns nodes at distance 1 AND 2 from root but NOT nodes at distance 3 (uses a hand-built three-hop chain A->B->C->D, root=A)', async () => {
    const { store, graph } = await setupHarness([
      { name: 'd' },
      { name: 'c', relations: [{ to: 'd', type: 'related-to' }] },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ name: 'a', depth: 2, direction: 'out' })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).toContain('c');
    expect(names).not.toContain('d');
  });

  it("memory_graph with types=['builds-on'] omits 'related-to' / 'mentions' / 'supersedes' / 'child-of' / 'contradicts' edges (and their unreached nodes) from the response", async () => {
    const { store, graph } = await setupHarness([
      { name: 'a' },
      { name: 'b' },
      {
        name: 'root',
        relations: [
          { to: 'a', type: 'builds-on' },
          { to: 'b', type: 'related-to' },
        ],
      },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      name: 'root',
      depth: 1,
      types: ['builds-on'],
      direction: 'out',
    })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('a');
    expect(names).not.toContain('b');
    for (const edge of result.edges) {
      expect(edge.type).toBe('builds-on');
    }
  });

  it("memory_graph default types filter excludes 'mentions' edges but includes all four authored RelationType edges and 'supersedes' (verbatim from issue: 'defaults to all authored types (omits mentions unless requested)')", async () => {
    const { store, graph } = await setupHarness([
      { name: 'related_target' },
      { name: 'buildson_target' },
      { name: 'contradicts_target' },
      { name: 'childof_target' },
      { name: 'superseded_target' },
      { name: 'mention_target' },
      {
        name: 'root',
        relations: [
          { to: 'related_target', type: 'related-to' },
          { to: 'buildson_target', type: 'builds-on' },
          { to: 'contradicts_target', type: 'contradicts' },
          { to: 'childof_target', type: 'child-of' },
        ],
        supersedes: ['superseded_target'],
      },
    ]);
    // Add a mentions edge directly (the body extractor would add it; here we
    // add it post-save so the test is deterministic).
    graph.addMentionsEdge({ from: 'root', to: 'mention_target' });

    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      name: 'root',
      depth: 1,
      direction: 'out',
    })) as MemoryGraphResult;
    const edgeTypes = new Set(result.edges.map((e) => e.type));
    expect(edgeTypes.has('related-to')).toBe(true);
    expect(edgeTypes.has('builds-on')).toBe(true);
    expect(edgeTypes.has('contradicts')).toBe(true);
    expect(edgeTypes.has('child-of')).toBe(true);
    expect(edgeTypes.has('supersedes')).toBe(true);
    expect(edgeTypes.has('mentions')).toBe(false);

    const names = result.nodes.map((n) => n.name);
    expect(names).not.toContain('mention_target');
  });

  it("memory_graph with direction='out' returns only outbound edges from root; an inbound-only neighbor (edge points AT root) is excluded from nodes and edges", async () => {
    const { store, graph } = await setupHarness([
      { name: 'out_target' },
      { name: 'inbound_source', relations: [{ to: 'root', type: 'related-to' }] },
      { name: 'root', relations: [{ to: 'out_target', type: 'related-to' }] },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      name: 'root',
      depth: 1,
      direction: 'out',
    })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('out_target');
    expect(names).not.toContain('inbound_source');
    for (const edge of result.edges) {
      expect(edge.from).toBe('root');
    }
  });

  it("memory_graph with direction='in' returns only inbound edges to root; an outbound-only neighbor (edge points FROM root) is excluded from nodes and edges", async () => {
    const { store, graph } = await setupHarness([
      { name: 'out_target' },
      { name: 'inbound_source', relations: [{ to: 'root', type: 'related-to' }] },
      { name: 'root', relations: [{ to: 'out_target', type: 'related-to' }] },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      name: 'root',
      depth: 1,
      direction: 'in',
    })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('inbound_source');
    expect(names).not.toContain('out_target');
    for (const edge of result.edges) {
      expect(edge.to).toBe('root');
    }
  });

  it("memory_graph with direction='both' returns both inbound and outbound neighbors of root in a single response", async () => {
    const { store, graph } = await setupHarness([
      { name: 'out_target' },
      { name: 'inbound_source', relations: [{ to: 'root', type: 'related-to' }] },
      { name: 'root', relations: [{ to: 'out_target', type: 'related-to' }] },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      name: 'root',
      depth: 1,
      direction: 'both',
    })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('out_target');
    expect(names).toContain('inbound_source');
  });
});

// --------------------------------------------------------------------------
// ac-3: BFS shortest path
// --------------------------------------------------------------------------

describe('ac-3: path query uses BFS, returns shortest path or null with reason', () => {
  it('memory_path between A and C in graph A->B->C with also A->C returns the 1-edge path [{from:A, to:C, type:<edgeType>}] (shortest, not the 2-edge A->B->C route)', async () => {
    const { store, graph } = await setupHarness([
      { name: 'c' },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      {
        name: 'a',
        relations: [
          { to: 'b', type: 'related-to' },
          { to: 'c', type: 'related-to' },
        ],
      },
    ]);
    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ from: 'a', to: 'c' })) as MemoryPathResult;
    if ('reason' in result) throw new Error('expected a path, got null');
    expect(result.path).toHaveLength(1);
    expect(result.path[0]).toEqual({ from: 'a', to: 'c', type: 'related-to' });
  });

  it("memory_path between disconnected memories returns { path: null, reason: 'unreachable' }", async () => {
    const { store, graph } = await setupHarness([{ name: 'a' }, { name: 'b' }]);
    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ from: 'a', to: 'b' })) as MemoryPathResult;
    if (!('reason' in result)) throw new Error('expected null path with reason');
    expect(result.path).toBeNull();
    expect(result.reason).toBe('unreachable');
  });

  it("memory_path between memories whose shortest connection is longer than maxDepth returns { path: null, reason: 'depth-exceeded' }", async () => {
    // A chain a -> b -> c -> d; shortest a->d has length 3, set maxDepth=2.
    const { store, graph } = await setupHarness([
      { name: 'd' },
      { name: 'c', relations: [{ to: 'd', type: 'related-to' }] },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ from: 'a', to: 'd', maxDepth: 2 })) as MemoryPathResult;
    if (!('reason' in result)) throw new Error('expected null path with reason');
    expect(result.path).toBeNull();
    expect(result.reason).toBe('depth-exceeded');
  });

  it("memory_path with types=['builds-on'] does not traverse 'related-to' edges: if the only path from A to C is A -[related-to]-> B -[builds-on]-> C, the result is null with reason 'unreachable' (or 'depth-exceeded' if applicable)", async () => {
    const { store, graph } = await setupHarness([
      { name: 'c' },
      { name: 'b', relations: [{ to: 'c', type: 'builds-on' }] },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      from: 'a',
      to: 'c',
      types: ['builds-on'],
    })) as MemoryPathResult;
    if (!('reason' in result)) throw new Error('expected null path');
    expect(result.path).toBeNull();
    expect(['unreachable', 'depth-exceeded']).toContain(result.reason);
  });

  it("memory_path returned `path` is a sequence of consecutive edges where each edge.from === previous edge.to and each edge's (from, to, type) exists in the underlying MemoryGraph outbound bucket", async () => {
    const { store, graph } = await setupHarness([
      { name: 'd' },
      { name: 'c', relations: [{ to: 'd', type: 'builds-on' }] },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ from: 'a', to: 'd' })) as MemoryPathResult;
    if ('reason' in result) throw new Error('expected a path');
    // Each consecutive edge connects.
    for (let i = 1; i < result.path.length; i++) {
      expect(result.path[i]!.from).toBe(result.path[i - 1]!.to);
    }
    // Each edge exists in the graph's outbound bucket.
    for (const edge of result.path) {
      const outbound = graph.outbound(edge.from);
      const match = outbound.find(
        (e) => e.from === edge.from && e.to === edge.to && e.type === edge.type,
      );
      expect(match, `edge ${edge.from}->${edge.to}:${edge.type} should exist`).toBeDefined();
    }
  });
});

// --------------------------------------------------------------------------
// ac-4: cycles
// --------------------------------------------------------------------------

describe('ac-4: cycles handled via visited-set tracking', () => {
  it('memory_graph on a graph containing a cycle A->B->A (depth >= 2) terminates and returns each reachable node exactly once in `nodes[]` (no duplicates)', async () => {
    const { store, graph } = await setupHarness([
      { name: 'b' },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    // Add the B->A back-edge manually to form a cycle.
    graph.addEdge({ from: 'b', to: 'a', type: 'related-to' });

    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ name: 'a', depth: 5, direction: 'out' })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names.sort()).toEqual(['a', 'b']);
    // Each name appears exactly once.
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [, count] of counts) {
      expect(count).toBe(1);
    }
  });

  it('memory_path on a graph containing a cycle A->B->A->B->...->target terminates without exceeding the visited-set bound and returns the shortest path (no infinite loop)', async () => {
    const { store, graph } = await setupHarness([
      { name: 'target' },
      { name: 'b', relations: [{ to: 'target', type: 'related-to' }] },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    // Add cycle: B->A
    graph.addEdge({ from: 'b', to: 'a', type: 'related-to' });

    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ from: 'a', to: 'target' })) as MemoryPathResult;
    if ('reason' in result) throw new Error('expected a path');
    expect(result.path).toHaveLength(2);
    expect(result.path[0]).toEqual({ from: 'a', to: 'b', type: 'related-to' });
    expect(result.path[1]).toEqual({ from: 'b', to: 'target', type: 'related-to' });
  });
});

// --------------------------------------------------------------------------
// ac-6: depth=0 / depth=1 / self-path
// --------------------------------------------------------------------------

describe('ac-6: depth=0, depth=1, self-path', () => {
  it('memory_graph with depth=0 returns { root, nodes: [root], edges: [] } -- root included as a node, no edges in the response', async () => {
    const { store, graph } = await setupHarness([
      { name: 'b' },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ name: 'a', depth: 0 })) as MemoryGraphResult;
    expect(result.root.name).toBe('a');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.name).toBe('a');
    expect(result.edges).toEqual([]);
  });

  it('memory_graph with depth=1 returns root plus exactly the immediate neighbors of root (direct outbound and inbound per direction setting); does NOT include any 2-hop nodes', async () => {
    const { store, graph } = await setupHarness([
      { name: 'c' },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const result = (await handler({
      name: 'a',
      depth: 1,
      direction: 'out',
    })) as MemoryGraphResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).toEqual(['a', 'b']);
    expect(names).not.toContain('c');
  });

  it("memory_path with from === to returns { path: [] } (empty edge sequence, NOT null) -- verbatim from issue: 'empty if from === to'", async () => {
    const { store, graph } = await setupHarness([{ name: 'a' }]);
    const handler = createMemoryPathHandler({ userStore: store, userGraph: graph });
    const result = (await handler({ from: 'a', to: 'a' })) as MemoryPathResult;
    if ('reason' in result) throw new Error('expected empty path, got null');
    expect(result.path).toEqual([]);
  });
});
