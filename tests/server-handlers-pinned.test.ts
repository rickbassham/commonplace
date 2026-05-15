/**
 * Tests for ac-2 + ac-3: pinned flag on memory_save and memory_list.
 *
 * memory_save accepts an optional `pinned` boolean. On a new memory it
 * defaults to `false`. On an update (same name) with `pinned` omitted,
 * the prior on-disk value is preserved. memory_list echoes `pinned` on
 * each entry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { buildToolDefinitions } from '../src/server/tools.js';
import { createMemoryListHandler, createMemorySaveHandler } from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar1003h-'));
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

const baseArgs = {
  name: 'pin_a',
  type: 'reference',
  description: 'desc',
  body: 'body',
};

describe('ac-2: memory_save inputSchema declares pinned as optional boolean', () => {
  it('memory_save inputSchema declares `pinned` as an optional boolean property (not in `required`)', () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_save');
    if (!def) throw new Error('expected memory_save in definitions');
    const schema = def.inputSchema;
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    expect(props).toBeDefined();
    if (!props) throw new Error('properties missing');
    expect(props.pinned?.type).toBe('boolean');
    const required = (schema as { required?: string[] }).required ?? [];
    expect(required).not.toContain('pinned');
  });
});

describe('ac-2: memory_save persists pinned to frontmatter', () => {
  it('memory_save with `pinned: true` writes a `.md` whose frontmatter has `pinned: true`', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySaveHandler({ store });
    await handler({ ...baseArgs, pinned: true });
    const onDisk = readFileSync(join(tmp, `${baseArgs.name}.md`), 'utf8');
    expect(onDisk).toMatch(/pinned:\s*true/);
  });

  it('memory_save on a new name with `pinned` omitted writes frontmatter with `pinned: false` (no `pinned:` key emitted, reads back as `false`)', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySaveHandler({ store });
    await handler({ ...baseArgs });
    const onDisk = readFileSync(join(tmp, `${baseArgs.name}.md`), 'utf8');
    expect(onDisk).not.toContain('pinned');
  });

  it('memory_save updating an existing memory with `pinned` omitted preserves the prior `pinned: true` value on disk', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySaveHandler({ store });
    await handler({ ...baseArgs, pinned: true });
    // Update without pinned -- prior `true` must persist on disk.
    await handler({ ...baseArgs, description: 'updated desc' });
    const onDisk = readFileSync(join(tmp, `${baseArgs.name}.md`), 'utf8');
    expect(onDisk).toMatch(/pinned:\s*true/);
    expect(onDisk).toContain('updated desc');
  });

  it('memory_save updating an existing memory with `pinned: false` explicitly clears a previously-pinned entry', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySaveHandler({ store });
    await handler({ ...baseArgs, pinned: true });
    await handler({ ...baseArgs, pinned: false });
    const onDisk = readFileSync(join(tmp, `${baseArgs.name}.md`), 'utf8');
    expect(onDisk).not.toContain('pinned');
  });

  it('memory_save rejects a non-boolean `pinned` argument with an error naming the field', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySaveHandler({ store });
    for (const bad of ['true', 1, null, [], {}]) {
      let msg = '';
      try {
        await handler({ ...baseArgs, pinned: bad });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toContain('pinned');
    }
  });
});

describe('ac-3: memory_list response includes pinned', () => {
  it('memory_list response includes `pinned: true` on entries whose `.md` frontmatter sets `pinned: true`', async () => {
    const store = makeStore();
    await store.scan();
    const save = createMemorySaveHandler({ store });
    const list = createMemoryListHandler({ store });
    await save({ ...baseArgs, name: 'pinned_one', pinned: true });
    const res = (await list({})) as { memories: Array<{ name: string; pinned: boolean }> };
    const entry = res.memories.find((m) => m.name === 'pinned_one');
    expect(entry).toBeDefined();
    expect(entry?.pinned).toBe(true);
  });

  it('memory_list response includes `pinned: false` on entries with the key absent or set to false', async () => {
    const store = makeStore();
    await store.scan();
    const save = createMemorySaveHandler({ store });
    const list = createMemoryListHandler({ store });
    await save({ ...baseArgs, name: 'pinned_none' });
    const res = (await list({})) as { memories: Array<{ name: string; pinned: boolean }> };
    const entry = res.memories.find((m) => m.name === 'pinned_none');
    expect(entry).toBeDefined();
    expect(entry?.pinned).toBe(false);
  });
});
