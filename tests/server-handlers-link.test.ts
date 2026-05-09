/**
 * DAR-928 unit tests: real handlers for memory_link and memory_unlink.
 *
 * Covers the in-process handler surface only -- input validation, atomic
 * write routing (verified via test seam on `__atomicWriteHooks.fs`), graph
 * incremental updates (verified via spies on the `MemoryGraph`), and the
 * documented response shape. End-to-end coverage over the in-memory MCP
 * transport (and the spawned bin) lives in the matching integration tests.
 *
 * Test pattern:
 *
 *   - We construct a real `MemoryStore` against a tmp dir + a stub embedder
 *     (the same pattern as `server-handlers.test.ts`) and a real
 *     `MemoryGraph`. Two memories are seeded so cross-name link/unlink
 *     scenarios are realistic.
 *   - We use `vi.spyOn` on `MemoryGraph` methods to assert that
 *     incremental-update APIs are invoked (and `scan` / `rebuild` are NOT)
 *     per ac-4.
 *   - For ac-2 we spy on the `node:fs/promises`-shaped seam exposed by
 *     `__atomicWriteHooks.fs` from the atomic-write helper. That seam is
 *     specifically designed for this kind of test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import { __atomicWriteHooks } from '../src/store/atomic-write.js';
import { readMemory } from '../src/store/memory.js';
import {
  buildToolDefinitions,
  createDefaultHandlers,
  type ToolDefinition,
  type ToolHandlerMap,
} from '../src/server/tools.js';
import { createMemoryLinkHandler, createMemoryUnlinkHandler } from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar928-'));
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

const setupHarness = async (): Promise<Harness> => {
  const graph = new MemoryGraph();
  const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
  await store.scan();
  // Seed two memories so link/unlink targets resolve.
  await store.save({ name: 'alpha', type: 'reference', description: 'a', body: 'A body' });
  await store.save({ name: 'beta', type: 'reference', description: 'b', body: 'B body' });
  return { store, graph };
};

const findDef = (defs: readonly ToolDefinition[], name: string): ToolDefinition => {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`expected tool ${name} to be registered`);
  return def;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --------------------------------------------------------------------------
// ac-1: registration -- tools surface in TOOL_NAMES, ListTools, and CallTool
// --------------------------------------------------------------------------

describe('ac-1: tool registration', () => {
  it('TOOL_NAMES contains exactly the six expected tool names in order: memory_search, memory_save, memory_list, memory_delete, memory_link, memory_unlink', async () => {
    // Import inline so this test reads the live module export.
    const { TOOL_NAMES } = await import('../src/server/tools.js');
    expect([...TOOL_NAMES]).toEqual([
      'memory_search',
      'memory_save',
      'memory_list',
      'memory_delete',
      'memory_link',
      'memory_unlink',
    ]);
  });

  it('listTools() response includes memory_link and memory_unlink with non-empty descriptions and JSON Schema inputSchema objects matching the documented argument shape', () => {
    const defs = buildToolDefinitions();
    const link = findDef(defs, 'memory_link');
    const unlink = findDef(defs, 'memory_unlink');

    // Descriptions are non-empty.
    expect(link.description.length).toBeGreaterThan(0);
    expect(unlink.description.length).toBeGreaterThan(0);

    // memory_link inputSchema: { from: string, to: string, type?: enum }
    expect(link.inputSchema.type).toBe('object');
    const linkProps = link.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(linkProps.from?.type).toBe('string');
    expect(linkProps.to?.type).toBe('string');
    expect(linkProps.type?.type).toBe('string');
    expect(linkProps.type?.enum).toEqual([
      'related-to',
      'builds-on',
      'contradicts',
      'child-of',
      'supersedes',
    ]);
    const linkRequired = (link.inputSchema as { required?: string[] }).required ?? [];
    expect(new Set(linkRequired)).toEqual(new Set(['from', 'to']));

    // memory_unlink inputSchema: { from: string, to: string, type?: enum }
    expect(unlink.inputSchema.type).toBe('object');
    const unlinkProps = unlink.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(unlinkProps.from?.type).toBe('string');
    expect(unlinkProps.to?.type).toBe('string');
    expect(unlinkProps.type?.type).toBe('string');
    expect(unlinkProps.type?.enum).toEqual([
      'related-to',
      'builds-on',
      'contradicts',
      'child-of',
      'supersedes',
    ]);
    const unlinkRequired = (unlink.inputSchema as { required?: string[] }).required ?? [];
    expect(new Set(unlinkRequired)).toEqual(new Set(['from', 'to']));
  });

  it("callTool dispatches name='memory_link' to the memory_link handler and name='memory_unlink' to the memory_unlink handler when wired via createDefaultHandlers({store, graph})", async () => {
    const { store, graph } = await setupHarness();
    const handlers: ToolHandlerMap = createDefaultHandlers({ store, graph });

    const linkSpy = vi.spyOn(handlers, 'memory_link');
    const unlinkSpy = vi.spyOn(handlers, 'memory_unlink');

    // Use the dispatcher directly so we observe which entry of the map ran.
    const { callTool } = await import('../src/server/tools.js');
    await callTool({ name: 'memory_link', arguments: { from: 'alpha', to: 'beta' } }, handlers);
    await callTool({ name: 'memory_unlink', arguments: { from: 'alpha', to: 'beta' } }, handlers);

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------
// ac-2: atomic writes via the DAR-923 helper
// --------------------------------------------------------------------------

describe('ac-2: atomic writes via the DAR-923 helper', () => {
  // The atomic-write helper exposes a test seam at `__atomicWriteHooks.fs`.
  // We wrap each call so we can observe which paths got `open`'d for write.
  // After each test we restore the real fs so other tests are unaffected.
  let openedForWrite: string[];
  let renamed: Array<{ from: string; to: string }>;
  // Save reference to the real fs object so we can restore it afterwards.
  let realFs: typeof __atomicWriteHooks.fs;

  beforeEach(() => {
    realFs = __atomicWriteHooks.fs;
    openedForWrite = [];
    renamed = [];
    __atomicWriteHooks.fs = {
      ...realFs,
      open: async (path: string | URL | Buffer, flags?: string | number, mode?: number) => {
        const p = typeof path === 'string' ? path : path.toString();
        if (typeof flags === 'string' && flags.includes('w')) {
          openedForWrite.push(p);
        }
        return realFs.open(path, flags, mode);
      },
      rename: async (oldPath: string | URL | Buffer, newPath: string | URL | Buffer) => {
        renamed.push({
          from: typeof oldPath === 'string' ? oldPath : oldPath.toString(),
          to: typeof newPath === 'string' ? newPath : newPath.toString(),
        });
        return realFs.rename(oldPath, newPath);
      },
    } as typeof realFs;
  });

  afterEach(() => {
    __atomicWriteHooks.fs = realFs;
  });

  it("memory_link routes the source memory's .md rewrite through atomicWrite (write-temp + fsync + rename) -- verified by spying/mocking atomicWrite and asserting it is invoked with the source .md path", async () => {
    const { store } = await setupHarness();
    // Reset capture buffers AFTER setup -- the seeded saves go through
    // atomicWrite too and we want to observe only the link's writes.
    openedForWrite = [];
    renamed = [];

    const handler = createMemoryLinkHandler({ store });
    await handler({ from: 'alpha', to: 'beta' });

    const sourceMd = join(store.dir, 'alpha.md');
    // The atomic helper opens a `<basename>.<random>.tmp` for write and then
    // renames it onto the target. Assert both halves landed on the source .md.
    expect(openedForWrite.some((p) => p.startsWith(`${sourceMd}.`) && p.endsWith('.tmp'))).toBe(
      true,
    );
    expect(renamed.some((r) => r.to === sourceMd)).toBe(true);
  });

  it("memory_unlink routes the source memory's .md rewrite through atomicWrite -- verified by spying/mocking atomicWrite and asserting it is invoked with the source .md path", async () => {
    const { store } = await setupHarness();
    // First link, then unlink -- only the unlink's writes are observed.
    const link = createMemoryLinkHandler({ store });
    await link({ from: 'alpha', to: 'beta' });
    openedForWrite = [];
    renamed = [];

    const handler = createMemoryUnlinkHandler({ store });
    await handler({ from: 'alpha', to: 'beta' });

    const sourceMd = join(store.dir, 'alpha.md');
    expect(openedForWrite.some((p) => p.startsWith(`${sourceMd}.`) && p.endsWith('.tmp'))).toBe(
      true,
    );
    expect(renamed.some((r) => r.to === sourceMd)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// ac-4: graph is updated incrementally (no full rescan)
// --------------------------------------------------------------------------

describe('ac-4: graph updated incrementally', () => {
  it('memory_link calls graph.add (or an equivalent incremental edge-add API) for the new edge and does NOT call store.scan() or graph.rebuild()', async () => {
    const { store, graph } = await setupHarness();

    const scanSpy = vi.spyOn(store, 'scan');
    const rebuildSpy = vi.spyOn(graph, 'rebuild');
    // The graph's incremental edge API is `addRelationEdge` (added in DAR-928).
    // We check that some incremental method was called by snapshotting before
    // and after, and by asserting the outbound bucket grew.
    const beforeSnap = graph.snapshot();
    expect(beforeSnap.outbound['alpha']).toBeUndefined();

    const handler = createMemoryLinkHandler({ store });
    await handler({ from: 'alpha', to: 'beta' });

    expect(scanSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    // The edge IS in the graph -- so an incremental add ran.
    const afterSnap = graph.snapshot();
    expect(afterSnap.outbound['alpha']).toBeDefined();
    expect(afterSnap.outbound['alpha']?.length).toBe(1);
  });

  it('memory_unlink incrementally removes the edge from the graph (graph.outbound(from) no longer contains the matching edge) without calling store.scan() or graph.rebuild()', async () => {
    const { store, graph } = await setupHarness();
    // Set up the edge first.
    const link = createMemoryLinkHandler({ store });
    await link({ from: 'alpha', to: 'beta' });
    expect(graph.outbound('alpha')).toHaveLength(1);

    const scanSpy = vi.spyOn(store, 'scan');
    const rebuildSpy = vi.spyOn(graph, 'rebuild');

    const handler = createMemoryUnlinkHandler({ store });
    await handler({ from: 'alpha', to: 'beta' });

    expect(scanSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    // The edge is gone.
    expect(graph.outbound('alpha').filter((e) => e.to === 'beta')).toHaveLength(0);
  });

  it('after memory_link, graph.outbound(from) includes an Edge with {from, to, type} matching the requested link', async () => {
    const { store, graph } = await setupHarness();
    const handler = createMemoryLinkHandler({ store });
    await handler({ from: 'alpha', to: 'beta', type: 'builds-on' });

    const edges = graph.outbound('alpha');
    expect(edges.some((e) => e.from === 'alpha' && e.to === 'beta' && e.type === 'builds-on')).toBe(
      true,
    );
  });
});

// --------------------------------------------------------------------------
// ac-7: link / unlink behaviours (default type, supersedes routing,
// rejections, no-op unlink)
// --------------------------------------------------------------------------

describe('ac-7: memory_link behaviours', () => {
  it("memory_link with default type appends {to, type:'related-to'} to relations[] and returns the updated relations and supersedes lists", async () => {
    const { store } = await setupHarness();
    const handler = createMemoryLinkHandler({ store });
    const result = await handler({ from: 'alpha', to: 'beta' });

    if (!isRecord(result)) throw new Error('result is not an object');
    expect(result.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
    expect(result.supersedes).toEqual([]);

    // Disk reflects the change.
    const onDisk = readMemory(join(store.dir, 'alpha.md'));
    expect(onDisk.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
    expect(onDisk.supersedes).toEqual([]);
  });

  it("memory_link with type='supersedes' appends to supersedes[] (not relations[]) and returns updated lists", async () => {
    const { store } = await setupHarness();
    const handler = createMemoryLinkHandler({ store });
    const result = await handler({ from: 'alpha', to: 'beta', type: 'supersedes' });

    if (!isRecord(result)) throw new Error('result is not an object');
    expect(result.relations).toEqual([]);
    expect(result.supersedes).toEqual(['beta']);

    const onDisk = readMemory(join(store.dir, 'alpha.md'));
    expect(onDisk.relations).toEqual([]);
    expect(onDisk.supersedes).toEqual(['beta']);
  });

  it('memory_link rejects with an error when from === to (self-edge), without writing to disk', async () => {
    const { store } = await setupHarness();

    // Snapshot atomic-write activity around the failed call.
    const realFs = __atomicWriteHooks.fs;
    let writeCount = 0;
    __atomicWriteHooks.fs = {
      ...realFs,
      open: async (path: string | URL | Buffer, flags?: string | number, mode?: number) => {
        if (typeof flags === 'string' && flags.includes('w')) writeCount += 1;
        return realFs.open(path, flags, mode);
      },
    } as typeof realFs;
    try {
      const handler = createMemoryLinkHandler({ store });
      await expect(handler({ from: 'alpha', to: 'alpha' })).rejects.toThrow(/self-edge|alpha/);
      expect(writeCount).toBe(0);
    } finally {
      __atomicWriteHooks.fs = realFs;
    }
  });

  it('memory_link rejects with an error when the target memory (`to`) does not exist in the store, without writing to disk', async () => {
    const { store } = await setupHarness();

    const realFs = __atomicWriteHooks.fs;
    let writeCount = 0;
    __atomicWriteHooks.fs = {
      ...realFs,
      open: async (path: string | URL | Buffer, flags?: string | number, mode?: number) => {
        if (typeof flags === 'string' && flags.includes('w')) writeCount += 1;
        return realFs.open(path, flags, mode);
      },
    } as typeof realFs;
    try {
      const handler = createMemoryLinkHandler({ store });
      await expect(handler({ from: 'alpha', to: 'ghost' })).rejects.toThrow(/ghost/);
      expect(writeCount).toBe(0);
    } finally {
      __atomicWriteHooks.fs = realFs;
    }
  });

  it('memory_link rejects with an error when an edge with the same {to, type} already exists on the source, without writing to disk', async () => {
    const { store } = await setupHarness();
    const handler = createMemoryLinkHandler({ store });
    await handler({ from: 'alpha', to: 'beta' });

    const realFs = __atomicWriteHooks.fs;
    let writeCount = 0;
    __atomicWriteHooks.fs = {
      ...realFs,
      open: async (path: string | URL | Buffer, flags?: string | number, mode?: number) => {
        if (typeof flags === 'string' && flags.includes('w')) writeCount += 1;
        return realFs.open(path, flags, mode);
      },
    } as typeof realFs;
    try {
      await expect(handler({ from: 'alpha', to: 'beta' })).rejects.toThrow(/duplicate|already/i);
      expect(writeCount).toBe(0);
    } finally {
      __atomicWriteHooks.fs = realFs;
    }
  });
});

describe('ac-7: memory_unlink behaviours', () => {
  it('memory_unlink removes the matching edge and returns the updated relations and supersedes lists', async () => {
    const { store } = await setupHarness();
    const link = createMemoryLinkHandler({ store });
    await link({ from: 'alpha', to: 'beta', type: 'builds-on' });
    await link({ from: 'alpha', to: 'beta', type: 'related-to' });

    const unlink = createMemoryUnlinkHandler({ store });
    const result = await unlink({ from: 'alpha', to: 'beta', type: 'builds-on' });
    if (!isRecord(result)) throw new Error('result is not an object');
    expect(result.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
    expect(result.supersedes).toEqual([]);

    const onDisk = readMemory(join(store.dir, 'alpha.md'));
    expect(onDisk.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
  });

  it('memory_unlink with type omitted removes ALL edges from->to regardless of type and returns the updated lists', async () => {
    const { store } = await setupHarness();
    const link = createMemoryLinkHandler({ store });
    await link({ from: 'alpha', to: 'beta', type: 'builds-on' });
    await link({ from: 'alpha', to: 'beta', type: 'related-to' });
    await link({ from: 'alpha', to: 'beta', type: 'supersedes' });

    const unlink = createMemoryUnlinkHandler({ store });
    const result = await unlink({ from: 'alpha', to: 'beta' });
    if (!isRecord(result)) throw new Error('result is not an object');
    expect(result.relations).toEqual([]);
    expect(result.supersedes).toEqual([]);

    const onDisk = readMemory(join(store.dir, 'alpha.md'));
    expect(onDisk.relations).toEqual([]);
    expect(onDisk.supersedes).toEqual([]);
  });

  it('memory_unlink is a no-op when the requested edge does not exist -- returns ok with a note and does not call atomicWrite', async () => {
    const { store } = await setupHarness();

    const realFs = __atomicWriteHooks.fs;
    let writeCount = 0;
    __atomicWriteHooks.fs = {
      ...realFs,
      open: async (path: string | URL | Buffer, flags?: string | number, mode?: number) => {
        if (typeof flags === 'string' && flags.includes('w')) writeCount += 1;
        return realFs.open(path, flags, mode);
      },
    } as typeof realFs;
    try {
      const unlink = createMemoryUnlinkHandler({ store });
      const result = await unlink({ from: 'alpha', to: 'beta' });
      if (!isRecord(result)) throw new Error('result is not an object');
      expect(result.relations).toEqual([]);
      expect(result.supersedes).toEqual([]);
      expect(typeof result.note).toBe('string');
      expect(writeCount).toBe(0);
    } finally {
      __atomicWriteHooks.fs = realFs;
    }
  });
});
