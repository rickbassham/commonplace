/**
 * DAR-928 integration tests: end-to-end memory_link / memory_unlink behaviour.
 *
 * Covers:
 *   - ac-2 valid YAML round-trip through readMemory
 *   - ac-3 contentSha unchanged after link/unlink (no sidecar re-embed)
 *   - ac-3 sidecar mtime/bytes unchanged after link/unlink
 *
 * Driven via the in-memory MCP transport pair so the assertions go through
 * the same dispatch surface clients see in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server/server.js';
import { createDefaultHandlers } from '../src/server/tools.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryGraph } from '../src/store/graph.js';
import { contentSha, readMemory } from '../src/store/memory.js';

interface TextContent {
  type: 'text';
  text: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isTextContent = (value: unknown): value is TextContent => {
  if (!isRecord(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
};

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
  client: Client;
  store: MemoryStore;
  graph: MemoryGraph;
  close: () => Promise<void>;
}

let tmp: string;

const setupHarness = async (): Promise<Harness> => {
  const graph = new MemoryGraph();
  const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
  await store.scan();
  await store.save({ name: 'alpha', type: 'reference', description: 'a', body: 'A body' });
  await store.save({ name: 'beta', type: 'reference', description: 'b', body: 'B body' });

  const handlers = createDefaultHandlers({ store, graph });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ handlers });
  const client = new Client({ name: 'dar928-int', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    store,
    graph,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar928-int-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const callJSON = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; parsed: unknown }> => {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError === true;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isTextContent)
    .map((c) => c.text)
    .join('');
  let parsed: unknown = null;
  if (text.length > 0 && !isError) {
    parsed = JSON.parse(text);
  }
  return { isError, text, parsed };
};

// --------------------------------------------------------------------------
// ac-2: valid YAML round-trip
// --------------------------------------------------------------------------

describe('ac-2: atomic writes leave frontmatter as valid YAML', () => {
  it("after memory_link succeeds, the source .md file's frontmatter parses as valid YAML via readMemory and the new edge is present in relations[] (or supersedes[] when type='supersedes')", async () => {
    const h = await setupHarness();
    try {
      const link1 = await callJSON(h.client, 'memory_link', { from: 'alpha', to: 'beta' });
      expect(link1.isError).toBe(false);

      const onDisk1 = readMemory(join(h.store.dir, 'alpha.md'));
      expect(onDisk1.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
      expect(onDisk1.supersedes).toEqual([]);

      const link2 = await callJSON(h.client, 'memory_link', {
        from: 'alpha',
        to: 'beta',
        type: 'supersedes',
      });
      expect(link2.isError).toBe(false);

      const onDisk2 = readMemory(join(h.store.dir, 'alpha.md'));
      expect(onDisk2.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
      expect(onDisk2.supersedes).toEqual(['beta']);
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-3: contentSha and sidecar are unchanged across link/unlink
// --------------------------------------------------------------------------

describe('ac-3: link/unlink do not invalidate the sidecar', () => {
  it("memory_link does not change the source memory's contentSha -- recomputed sha after link equals sha before link", async () => {
    const h = await setupHarness();
    try {
      const before = readMemory(join(h.store.dir, 'alpha.md'));
      const shaBefore = contentSha(before);

      const link = await callJSON(h.client, 'memory_link', { from: 'alpha', to: 'beta' });
      expect(link.isError).toBe(false);

      const after = readMemory(join(h.store.dir, 'alpha.md'));
      const shaAfter = contentSha(after);
      expect(shaAfter).toBe(shaBefore);
    } finally {
      await h.close();
    }
  });

  it('memory_link does not rewrite the .embedding sidecar -- sidecar mtime and bytes are unchanged after a successful link', async () => {
    const h = await setupHarness();
    try {
      const sidecarPath = join(h.store.dir, 'alpha.embedding');
      const bytesBefore = readFileSync(sidecarPath);
      const mtimeBefore = statSync(sidecarPath).mtimeMs;

      // Wait long enough that any sidecar write would advance mtime
      // observably (filesystem mtime resolution varies).
      await new Promise((resolve) => setTimeout(resolve, 20));

      const link = await callJSON(h.client, 'memory_link', { from: 'alpha', to: 'beta' });
      expect(link.isError).toBe(false);

      const bytesAfter = readFileSync(sidecarPath);
      const mtimeAfter = statSync(sidecarPath).mtimeMs;
      expect(bytesAfter.equals(bytesBefore)).toBe(true);
      expect(mtimeAfter).toBe(mtimeBefore);
    } finally {
      await h.close();
    }
  });

  it('memory_unlink does not change contentSha and does not rewrite the .embedding sidecar', async () => {
    const h = await setupHarness();
    try {
      // Link first so there's an edge to remove.
      const linked = await callJSON(h.client, 'memory_link', { from: 'alpha', to: 'beta' });
      expect(linked.isError).toBe(false);

      const before = readMemory(join(h.store.dir, 'alpha.md'));
      const shaBefore = contentSha(before);
      const sidecarPath = join(h.store.dir, 'alpha.embedding');
      const bytesBefore = readFileSync(sidecarPath);
      const mtimeBefore = statSync(sidecarPath).mtimeMs;

      await new Promise((resolve) => setTimeout(resolve, 20));

      const unlinked = await callJSON(h.client, 'memory_unlink', {
        from: 'alpha',
        to: 'beta',
      });
      expect(unlinked.isError).toBe(false);

      const after = readMemory(join(h.store.dir, 'alpha.md'));
      expect(contentSha(after)).toBe(shaBefore);

      const bytesAfter = readFileSync(sidecarPath);
      const mtimeAfter = statSync(sidecarPath).mtimeMs;
      expect(bytesAfter.equals(bytesBefore)).toBe(true);
      expect(mtimeAfter).toBe(mtimeBefore);
    } finally {
      await h.close();
    }
  });
});
