/**
 * Performance test: at corpus size 10K with avg outbound fan-out
 * 5, `memory_graph({ name: <root>, depth: 3 })` completes in <50ms.
 *
 * We bypass the disk-backed MemoryStore + Embedder here -- those are not
 * what the perf bound is measuring (filesystem and embedding throughput
 * dominate on a real corpus). The handler reads `store.all()` and the
 * `MemoryGraph` only; a lightweight in-memory shim that returns a hand-built
 * entry list is sufficient and reproducible on the CI runner.
 *
 * The synthetic graph uses a deterministic fan-out so the test result is
 * stable across runs. A warmup pass absorbs GC / JIT jitter before the
 * timed run.
 */

import { describe, expect, it } from 'vitest';

import { MemoryGraph } from '../src/store/graph.js';
import type { MemoryEntry, MemoryStore } from '../src/store/memory-store.js';
import { createMemoryGraphHandler, type MemoryGraphResult } from '../src/server/handlers.js';

const buildSyntheticCorpus = (
  size: number,
  fanOut: number,
): { entries: MemoryEntry[]; graph: MemoryGraph } => {
  const graph = new MemoryGraph({ onDangling: () => {} });
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < size; i++) {
    const name = `m${i}`;
    // Each memory points at `fanOut` deterministic successors (wrap-around).
    const relations = Array.from({ length: fanOut }, (_, k) => ({
      to: `m${(i + k + 1) % size}`,
      type: 'related-to' as const,
    }));
    entries.push({
      name,
      type: 'reference',
      description: `desc ${i}`,
      body: `body ${i}`,
      relations,
      supersedes: [],
      pinned: false,
      vector: new Float32Array(0),
      contentSha: 'x',
      modelId: 'stub',
      dim: 0,
    });
  }
  // Rebuild once with the full corpus so the adjacency lists are populated.
  graph.rebuild(entries);
  return { entries, graph };
};

/**
 * Minimal MemoryStore stand-in: the handler only reads `.all()` and `.dir`.
 * Cast the shim to `MemoryStore` once at the call site so the test stays
 * readable.
 */
const makeStoreShim = (entries: MemoryEntry[]): MemoryStore => {
  const shim = {
    dir: '/tmp/perf-test',
    all: () => entries,
  };
  return shim as unknown as MemoryStore;
};

describe('memory_graph performance', () => {
  it('synthetic 10K-node graph with avg outbound fan-out 5: memory_graph({ name: <root>, depth: 3 }) completes in <50ms wall-clock on the CI runner (single best-of-N run after warmup to absorb GC jitter)', async () => {
    const { entries, graph } = buildSyntheticCorpus(10_000, 5);
    const store = makeStoreShim(entries);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });

    // Warmup pass: prime the JIT and absorb GC jitter.
    for (let i = 0; i < 3; i++) {
      await handler({ name: 'm0', depth: 3 });
    }

    // Best-of-N timed run.
    const N = 5;
    let bestMs = Infinity;
    let lastResult: MemoryGraphResult | undefined;
    for (let i = 0; i < N; i++) {
      const startNs = process.hrtime.bigint();
      const result = (await handler({ name: 'm0', depth: 3 })) as MemoryGraphResult;
      const endNs = process.hrtime.bigint();
      const elapsedMs = Number(endNs - startNs) / 1_000_000;
      if (elapsedMs < bestMs) bestMs = elapsedMs;
      lastResult = result;
    }

    // Sanity: the traversal actually visited a non-trivial neighborhood.
    expect(lastResult).toBeDefined();
    expect(lastResult!.nodes.length).toBeGreaterThan(1);

    // ac-5 bound.
    expect(bestMs).toBeLessThan(50);
  });
});
