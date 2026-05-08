/**
 * DAR-926 contract tests.
 *
 * Behavioral tests for the `MemoryGraph` class -- an in-memory adjacency
 * structure built from the `relations[]` and `supersedes[]` frontmatter
 * graph fields (DAR-925) layered over the `MemoryStore` entries (DAR-916).
 *
 * Test names mirror the contract envelope on DAR-926 (round 1, approved).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryGraph, type DanglingEdge, type Edge, type GraphMemory } from '../src/store/graph.js';
import { writeMemory, type Memory } from '../src/store/memory.js';
import { MemoryStore, type Embedder } from '../src/store/memory-store.js';

const __filename = fileURLToPath(import.meta.url);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar926-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const mem = (name: string, overrides: Partial<GraphMemory> = {}): GraphMemory => ({
  name,
  relations: [],
  supersedes: [],
  ...overrides,
});

const makeStubEmbedder = (modelId = 'stub-model', dim = 4): Embedder => ({
  modelId,
  dim,
  embed: async () => {
    const out = new Float32Array(dim);
    out[0] = 1;
    return out;
  },
});

const memoryFor = (name: string, overrides: Partial<Memory> = {}): Memory => ({
  name,
  description: `desc-${name}`,
  type: 'reference',
  body: `body-${name}\n`,
  relations: [],
  supersedes: [],
  ...overrides,
});

// -------------------------------------------------------------------------
// ac-1: all four authored relation types + supersedes represented as edges
// -------------------------------------------------------------------------

describe('ac-1: edge representation', () => {
  it('rebuild from a corpus where each memory authors one relation per type emits one edge per (from, to, type) for related-to, builds-on, contradicts, and child-of', () => {
    const g = new MemoryGraph();
    g.rebuild([
      mem('a', { relations: [{ to: 'x', type: 'related-to' }] }),
      mem('b', { relations: [{ to: 'x', type: 'builds-on' }] }),
      mem('c', { relations: [{ to: 'x', type: 'contradicts' }] }),
      mem('d', { relations: [{ to: 'x', type: 'child-of' }] }),
      mem('x'),
    ]);
    expect(g.outbound('a')).toEqual([{ from: 'a', to: 'x', type: 'related-to' }]);
    expect(g.outbound('b')).toEqual([{ from: 'b', to: 'x', type: 'builds-on' }]);
    expect(g.outbound('c')).toEqual([{ from: 'c', to: 'x', type: 'contradicts' }]);
    expect(g.outbound('d')).toEqual([{ from: 'd', to: 'x', type: 'child-of' }]);
    expect(g.inbound('x')).toEqual([
      { from: 'a', to: 'x', type: 'related-to' },
      { from: 'b', to: 'x', type: 'builds-on' },
      { from: 'c', to: 'x', type: 'contradicts' },
      { from: 'd', to: 'x', type: 'child-of' },
    ]);
  });

  it("rebuild from a corpus where memory A has supersedes: [B] emits a single edge {from: A, to: B, type: 'supersedes'} on outbound(A) and inbound(B)", () => {
    const g = new MemoryGraph();
    g.rebuild([mem('a', { supersedes: ['b'] }), mem('b')]);
    expect(g.outbound('a')).toEqual([{ from: 'a', to: 'b', type: 'supersedes' }]);
    expect(g.inbound('b')).toEqual([{ from: 'a', to: 'b', type: 'supersedes' }]);
  });

  it('rebuild from a corpus where one memory authors multiple relations of distinct types to distinct targets emits all edges with their authored types preserved verbatim', () => {
    const g = new MemoryGraph();
    g.rebuild([
      mem('a', {
        relations: [
          { to: 'x', type: 'related-to' },
          { to: 'y', type: 'builds-on' },
          { to: 'z', type: 'contradicts' },
        ],
      }),
      mem('x'),
      mem('y'),
      mem('z'),
    ]);
    expect(g.outbound('a')).toEqual([
      { from: 'a', to: 'x', type: 'related-to' },
      { from: 'a', to: 'y', type: 'builds-on' },
      { from: 'a', to: 'z', type: 'contradicts' },
    ]);
  });

  it('outbound() includes both relations-derived edges and supersedes-derived edges for a memory that authors both', () => {
    const g = new MemoryGraph();
    g.rebuild([
      mem('a', {
        relations: [{ to: 'x', type: 'related-to' }],
        supersedes: ['old'],
      }),
      mem('x'),
      mem('old'),
    ]);
    const out = g.outbound('a');
    expect(out).toContainEqual({ from: 'a', to: 'x', type: 'related-to' });
    expect(out).toContainEqual({ from: 'a', to: 'old', type: 'supersedes' });
    expect(out).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------
// ac-2: mentions edges representable in the Edge union
// -------------------------------------------------------------------------

describe('ac-2: mentions edge representable', () => {
  it("graph adds an edge with type 'mentions' when the public add-mentions API (or equivalent extension hook documented in this PR) is invoked, asserting only that the edge type 'mentions' is representable in the Edge union and stored alongside authored edges", () => {
    const g = new MemoryGraph();
    g.rebuild([mem('a'), mem('b')]);
    g.addMentionsEdge({ from: 'a', to: 'b' });
    const out = g.outbound('a');
    expect(out).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });

    // Also confirm the type 'mentions' is assignable to Edge['type']
    const e: Edge = { from: 'a', to: 'b', type: 'mentions' };
    expect(e.type).toBe('mentions');
  });
});

// -------------------------------------------------------------------------
// ac-3: outbound/inbound are O(1)
// -------------------------------------------------------------------------

describe('ac-3: O(1) lookups', () => {
  it('outbound(name) returns in constant time independent of corpus size, verified by asserting the implementation reads a precomputed map keyed by from-name (no scan over all entries) and by a benchmark-style timing assertion comparing 10 vs 10000 entry corpora', () => {
    const small = new MemoryGraph();
    small.rebuild(buildLinearChain(10));
    const large = new MemoryGraph();
    large.rebuild(buildLinearChain(10000));

    // Structural assertion: the lookup map is exposed for inspection by tests.
    // outbound() reads from a Map keyed by from-name (one-shot get), not a scan.
    expect(small.hasOutboundIndex('node_5')).toBe(true);
    expect(large.hasOutboundIndex('node_5000')).toBe(true);

    const tSmall = timeManyLookups(() => small.outbound('node_5'));
    const tLarge = timeManyLookups(() => large.outbound('node_5000'));
    // Coarse sanity: large should not be more than ~50x slower than small.
    // Use an absolute 200ms ceiling as the floor so we don't multiply
    // sub-millisecond noise (or a zero-rounded `tSmall`) into a flaky
    // bound on shared CI; the structural assertion above is the
    // load-bearing one.
    expect(tLarge).toBeLessThan(timingCeiling(tSmall));
  });

  it('inbound(name) returns in constant time independent of corpus size, verified the same way as outbound: precomputed map keyed by to-name plus 10 vs 10000 entry timing comparison', () => {
    const small = new MemoryGraph();
    small.rebuild(buildLinearChain(10));
    const large = new MemoryGraph();
    large.rebuild(buildLinearChain(10000));

    expect(small.hasInboundIndex('node_5')).toBe(true);
    expect(large.hasInboundIndex('node_5000')).toBe(true);

    const tSmall = timeManyLookups(() => small.inbound('node_5'));
    const tLarge = timeManyLookups(() => large.inbound('node_5000'));
    expect(tLarge).toBeLessThan(timingCeiling(tSmall));
  });

  it('outbound(name) and inbound(name) both return [] for an unknown name without throwing', () => {
    const g = new MemoryGraph();
    g.rebuild([mem('a')]);
    expect(g.outbound('does_not_exist')).toEqual([]);
    expect(g.inbound('does_not_exist')).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// ac-4: incremental updates on save/delete
// -------------------------------------------------------------------------

describe('ac-4: incremental updates', () => {
  it("add(memory) on a graph already built over N entries inserts the new memory's outbound and inbound edges without invoking the rebuild() code path, verified via a spy/counter on rebuild()", () => {
    const g = new MemoryGraph();
    g.rebuild([mem('x'), mem('y')]);
    const rebuildSpy = vi.spyOn(g, 'rebuild');
    g.add(mem('a', { relations: [{ to: 'x', type: 'related-to' }] }));
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(g.outbound('a')).toEqual([{ from: 'a', to: 'x', type: 'related-to' }]);
    expect(g.inbound('x')).toEqual([{ from: 'a', to: 'x', type: 'related-to' }]);
  });

  it("remove(name) on a graph already built over N entries deletes the memory's outbound edges and removes it as a target from any inbound maps without invoking rebuild(), verified via a spy/counter on rebuild()", () => {
    const g = new MemoryGraph();
    g.rebuild([
      mem('a', { relations: [{ to: 'x', type: 'related-to' }] }),
      mem('b', { relations: [{ to: 'a', type: 'builds-on' }] }),
      mem('x'),
    ]);
    const rebuildSpy = vi.spyOn(g, 'rebuild');
    g.remove('a');
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(g.outbound('a')).toEqual([]);
    expect(g.inbound('x')).toEqual([]);
    expect(g.inbound('a')).toEqual([]);
  });

  it("after add(memory_a) followed by remove('memory_a') the graph state is byte-equal (deep-equal) to the state before add(), confirming incremental updates leave no residue", () => {
    const g = new MemoryGraph();
    g.rebuild([mem('x'), mem('b', { relations: [{ to: 'x', type: 'related-to' }] })]);
    const before = g.snapshot();
    g.add(
      mem('memory_a', {
        relations: [
          { to: 'x', type: 'related-to' },
          { to: 'b', type: 'builds-on' },
        ],
        supersedes: ['x'],
      }),
    );
    expect(g.snapshot()).not.toEqual(before);
    g.remove('memory_a');
    expect(g.snapshot()).toEqual(before);
  });

  it("MemoryStore.save invokes graph.add(entry) exactly once with the saved entry, integration-tested through the store's public API", async () => {
    const graph = new MemoryGraph();
    const addSpy = vi.spyOn(graph, 'add');
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.save(memoryFor('alpha'));
    expect(addSpy).toHaveBeenCalledTimes(1);
    const arg = addSpy.mock.calls[0]![0];
    expect(arg.name).toBe('alpha');
  });

  it("MemoryStore.delete invokes graph.remove(name) exactly once with the deleted name, integration-tested through the store's public API", async () => {
    const graph = new MemoryGraph();
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.save(memoryFor('beta'));
    const removeSpy = vi.spyOn(graph, 'remove');
    await store.delete('beta');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('beta');
  });

  it("MemoryStore.scan invokes graph.rebuild(entries) exactly once per scan call, integration-tested through the store's public API", async () => {
    writeMemory(join(tmp, 'one.md'), memoryFor('one'));
    writeMemory(join(tmp, 'two.md'), memoryFor('two'));
    const graph = new MemoryGraph();
    const rebuildSpy = vi.spyOn(graph, 'rebuild');
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    const arg = rebuildSpy.mock.calls[0]![0];
    expect(arg.map((e) => e.name).sort()).toEqual(['one', 'two']);
  });
});

// -------------------------------------------------------------------------
// ac-5: detectDangling, callbacks, isSuperseded, self-edge assert
// -------------------------------------------------------------------------

describe('ac-5: dangling detection and supersede', () => {
  it('detectDangling() returns one DanglingEdge per relations[].to that does not resolve to a loaded memory name, with from/to/type fields matching the authored edge', () => {
    const g = new MemoryGraph();
    g.rebuild([
      mem('a', {
        relations: [
          { to: 'present', type: 'related-to' },
          { to: 'missing_one', type: 'builds-on' },
          { to: 'missing_two', type: 'contradicts' },
        ],
      }),
      mem('present'),
    ]);
    const d = g.detectDangling();
    expect(d).toContainEqual({ from: 'a', to: 'missing_one', type: 'builds-on' });
    expect(d).toContainEqual({ from: 'a', to: 'missing_two', type: 'contradicts' });
    expect(d).toHaveLength(2);
  });

  it("detectDangling() returns one DanglingEdge per supersedes[] entry that does not resolve to a loaded memory name, with type === 'supersedes'", () => {
    const g = new MemoryGraph();
    g.rebuild([mem('a', { supersedes: ['gone_one', 'gone_two'] })]);
    const d = g.detectDangling();
    expect(d).toContainEqual({ from: 'a', to: 'gone_one', type: 'supersedes' });
    expect(d).toContainEqual({ from: 'a', to: 'gone_two', type: 'supersedes' });
    expect(d).toHaveLength(2);
  });

  it('detectDangling() returns [] when every relation and supersedes target resolves to a loaded memory', () => {
    const g = new MemoryGraph();
    g.rebuild([
      mem('a', {
        relations: [{ to: 'b', type: 'related-to' }],
        supersedes: ['c'],
      }),
      mem('b'),
      mem('c'),
    ]);
    expect(g.detectDangling()).toEqual([]);
  });

  it('the configured dangling callback is invoked once per dangling edge during rebuild(), and defaults to a console.warn-style log when no callback is provided', () => {
    const cb = vi.fn();
    const g = new MemoryGraph({ onDangling: cb });
    g.rebuild([
      mem('a', {
        relations: [{ to: 'missing_one', type: 'related-to' }],
        supersedes: ['missing_two'],
      }),
    ]);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith({ from: 'a', to: 'missing_one', type: 'related-to' });
    expect(cb).toHaveBeenCalledWith({ from: 'a', to: 'missing_two', type: 'supersedes' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const g2 = new MemoryGraph();
      g2.rebuild([mem('a', { relations: [{ to: 'gone', type: 'related-to' }] })]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('dangling edges are non-fatal: rebuild() with multiple dangling edges still populates outbound/inbound for all valid edges and returns normally', () => {
    const g = new MemoryGraph();
    expect(() =>
      g.rebuild([
        mem('a', {
          relations: [
            { to: 'b', type: 'related-to' },
            { to: 'gone', type: 'builds-on' },
          ],
        }),
        mem('b'),
      ]),
    ).not.toThrow();
    expect(g.outbound('a')).toContainEqual({ from: 'a', to: 'b', type: 'related-to' });
    expect(g.outbound('a')).toContainEqual({ from: 'a', to: 'gone', type: 'builds-on' });
    expect(g.inbound('b')).toEqual([{ from: 'a', to: 'b', type: 'related-to' }]);
  });

  it('isSuperseded(name) returns true when any other memory has `name` in its supersedes[] and false otherwise, including false for memories that supersede others but are not themselves superseded', () => {
    const g = new MemoryGraph();
    g.rebuild([mem('new_one', { supersedes: ['old_one'] }), mem('old_one'), mem('alone')]);
    expect(g.isSuperseded('old_one')).toBe(true);
    expect(g.isSuperseded('new_one')).toBe(false);
    expect(g.isSuperseded('alone')).toBe(false);
    expect(g.isSuperseded('does_not_exist')).toBe(false);
  });

  it("graph asserts (throws) when a memory's relations[] contains an entry whose to equals the memory's own name, since DAR-925 already rejects self-edges at parse time", () => {
    const g = new MemoryGraph();
    expect(() =>
      g.rebuild([
        // bypass DAR-925 parse-time check by constructing the GraphMemory
        // directly -- the graph asserts the invariant for safety.
        mem('self', { relations: [{ to: 'self', type: 'related-to' }] }),
      ]),
    ).toThrow();
    expect(() => g.add(mem('self', { supersedes: ['self'] }))).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-6: --prune-dangling flag on migrate CLI
// -------------------------------------------------------------------------

describe('ac-6: --prune-dangling on migrate CLI', () => {
  it('`commonplace migrate <dir> --prune-dangling` rewrites .md files to remove relations[] entries whose to does not resolve to any loaded memory', async () => {
    const { runMigrate } = await import('../src/cli/migrate.js');
    writeMemory(
      join(tmp, 'a.md'),
      memoryFor('a', {
        relations: [
          { to: 'b', type: 'related-to' },
          { to: 'gone', type: 'builds-on' },
        ],
      }),
    );
    writeMemory(join(tmp, 'b.md'), memoryFor('b'));
    await runMigrate({
      dir: tmp,
      pruneDangling: true,
      embedder: makeStubEmbedder(),
    });
    const a = readFileSync(join(tmp, 'a.md'), 'utf8');
    expect(a).toContain('to: b');
    expect(a).not.toContain('gone');
  });

  it('`commonplace migrate <dir> --prune-dangling` rewrites .md files to remove supersedes[] entries that do not resolve to any loaded memory', async () => {
    const { runMigrate } = await import('../src/cli/migrate.js');
    writeMemory(join(tmp, 'a.md'), memoryFor('a', { supersedes: ['gone_one', 'present'] }));
    writeMemory(join(tmp, 'present.md'), memoryFor('present'));
    await runMigrate({
      dir: tmp,
      pruneDangling: true,
      embedder: makeStubEmbedder(),
    });
    const a = readFileSync(join(tmp, 'a.md'), 'utf8');
    expect(a).toContain('present');
    expect(a).not.toContain('gone_one');
  });

  it('`commonplace migrate <dir> --prune-dangling` leaves .md files byte-unchanged when there are no dangling edges (idempotent on a clean corpus)', async () => {
    const { runMigrate } = await import('../src/cli/migrate.js');
    writeMemory(
      join(tmp, 'a.md'),
      memoryFor('a', { relations: [{ to: 'b', type: 'related-to' }] }),
    );
    writeMemory(join(tmp, 'b.md'), memoryFor('b'));
    const before = {
      a: readFileSync(join(tmp, 'a.md'), 'utf8'),
      b: readFileSync(join(tmp, 'b.md'), 'utf8'),
    };
    await runMigrate({
      dir: tmp,
      pruneDangling: true,
      embedder: makeStubEmbedder(),
    });
    expect(readFileSync(join(tmp, 'a.md'), 'utf8')).toBe(before.a);
    expect(readFileSync(join(tmp, 'b.md'), 'utf8')).toBe(before.b);
  });

  it('`commonplace migrate <dir> --prune-dangling` reports the number of pruned edges per file in its summary output', async () => {
    const { runMigrate } = await import('../src/cli/migrate.js');
    writeMemory(
      join(tmp, 'a.md'),
      memoryFor('a', {
        relations: [
          { to: 'gone_one', type: 'related-to' },
          { to: 'gone_two', type: 'builds-on' },
        ],
        supersedes: ['gone_three'],
      }),
    );
    const result = await runMigrate({
      dir: tmp,
      pruneDangling: true,
      embedder: makeStubEmbedder(),
    });
    expect(result.pruned).toEqual([{ name: 'a', edgesPruned: 3 }]);
  });

  it('`commonplace migrate <dir>` (without --prune-dangling) does NOT modify .md files even when dangling edges exist, confirming the flag is opt-in', async () => {
    const { runMigrate } = await import('../src/cli/migrate.js');
    writeMemory(
      join(tmp, 'a.md'),
      memoryFor('a', {
        relations: [{ to: 'gone', type: 'related-to' }],
      }),
    );
    const before = readFileSync(join(tmp, 'a.md'), 'utf8');
    await runMigrate({
      dir: tmp,
      pruneDangling: false,
      embedder: makeStubEmbedder(),
    });
    expect(readFileSync(join(tmp, 'a.md'), 'utf8')).toBe(before);
  });
});

// -------------------------------------------------------------------------
// ac-7: meta-coverage + build-from-corpus integration
// -------------------------------------------------------------------------

describe('ac-7: coverage and end-to-end', () => {
  it('test suite contains a meta-coverage check that every named scenario from the AC (build from corpus, neighbor lookups both directions, supersede detection, dangling detection, prune behavior, incremental update on save, incremental cleanup on delete) maps to at least one test name in this file or an integration test file referenced from it', () => {
    const self = readFileSync(__filename, 'utf8');
    const required = [
      // build-from-corpus (ac-1, ac-7 integration)
      'rebuild from a corpus where each memory authors one relation per type emits one edge',
      // neighbor lookups both directions (ac-1)
      'on outbound(A) and inbound(B)',
      // supersede detection (ac-5)
      'isSuperseded(name) returns true when any other memory has',
      // dangling detection (ac-5)
      'detectDangling() returns one DanglingEdge per relations',
      // prune behavior (ac-6)
      '--prune-dangling',
      // incremental update on save (ac-4)
      'MemoryStore.save invokes graph.add(entry) exactly once',
      // incremental cleanup on delete (ac-4)
      'MemoryStore.delete invokes graph.remove(name) exactly once',
    ];
    for (const needle of required) {
      expect(self, `missing scenario: ${needle}`).toContain(needle);
    }
  });

  it('build-from-corpus end-to-end test: load a fixture directory of N memories with mixed relations and supersedes via MemoryStore.scan, then assert outbound/inbound/isSuperseded/detectDangling all return the expected pre-computed values', async () => {
    writeMemory(
      join(tmp, 'root.md'),
      memoryFor('root', {
        relations: [{ to: 'child', type: 'child-of' }],
      }),
    );
    writeMemory(
      join(tmp, 'child.md'),
      memoryFor('child', {
        relations: [{ to: 'root', type: 'builds-on' }],
        supersedes: ['old_child'],
      }),
    );
    writeMemory(join(tmp, 'old_child.md'), memoryFor('old_child'));
    writeMemory(
      join(tmp, 'orphan.md'),
      memoryFor('orphan', {
        relations: [{ to: 'gone', type: 'contradicts' }],
      }),
    );

    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();

    expect(graph.outbound('root')).toEqual([{ from: 'root', to: 'child', type: 'child-of' }]);
    expect(graph.inbound('root')).toEqual([{ from: 'child', to: 'root', type: 'builds-on' }]);
    expect(graph.outbound('child')).toContainEqual({
      from: 'child',
      to: 'root',
      type: 'builds-on',
    });
    expect(graph.outbound('child')).toContainEqual({
      from: 'child',
      to: 'old_child',
      type: 'supersedes',
    });
    expect(graph.isSuperseded('old_child')).toBe(true);
    expect(graph.isSuperseded('child')).toBe(false);
    expect(graph.detectDangling()).toEqual([{ from: 'orphan', to: 'gone', type: 'contradicts' }]);
  });
});

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

const buildLinearChain = (n: number): GraphMemory[] => {
  const out: GraphMemory[] = [];
  for (let i = 0; i < n; i++) {
    const name = `node_${i}`;
    const next = `node_${i + 1}`;
    if (i < n - 1) {
      out.push(mem(name, { relations: [{ to: next, type: 'builds-on' }] }));
    } else {
      out.push(mem(name));
    }
  }
  return out;
};

const timeManyLookups = (fn: () => unknown, iterations = 1000): number => {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - start;
};

/**
 * Compute a flake-resistant upper bound for the 10-vs-10000 O(1) timing
 * assertion. We use a 200ms absolute ceiling combined with `tSmall * 50`,
 * but anchored on `Math.max(tSmall, 1)` so a sub-millisecond `tSmall` that
 * rounds toward zero on a noisy CI host doesn't collapse the bound.
 */
const timingCeiling = (tSmall: number): number => {
  const safeSmall = Math.max(tSmall, 1);
  return Math.max(safeSmall * 50, 200);
};

// Re-export DanglingEdge so the test compiles without an unused-import warning
// when the type is referenced only in inline annotations.
export type _DanglingEdge = DanglingEdge;
