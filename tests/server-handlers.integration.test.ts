/**
 * Integration tests: end-to-end MCP server with real CRUD handlers over
 * an in-memory transport pair.
 *
 * Spins up a real `Server` (via `createServer`) wired with a real
 * `MemoryStore` backed by a tmp directory and a stub embedder, and a
 * real `Client` connected via `InMemoryTransport.createLinkedPair()`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server/server.js';
import { createDefaultHandlers } from '../src/server/tools.js';
import { MemoryStore } from '../src/store/memory-store.js';

interface TextContent {
  type: 'text';
  text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  close: () => Promise<void>;
}

let tmp: string;

const setupHarness = async (): Promise<Harness> => {
  const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder() });
  await store.scan();
  const handlers = createDefaultHandlers({ store });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ handlers });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    store,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar919-int-'));
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
  if (!isError && text.length > 0) {
    parsed = JSON.parse(text);
  }
  return { isError, text, parsed };
};

// --------------------------------------------------------------------------
// ac-1: registration over the transport
// --------------------------------------------------------------------------

describe('ac-1: createServer wires real CRUD handlers', () => {
  it("createServer wires real CRUD handlers by default for memory_save, memory_list, memory_delete (CallTool does not surface 'not implemented' for those three names)", async () => {
    const h = await setupHarness();
    try {
      // memory_list with no args should succeed
      const list = await callJSON(h.client, 'memory_list', {});
      expect(list.isError).toBe(false);

      // memory_save and memory_delete may produce validation errors with no
      // args, but their error messages must NOT be 'not implemented'.
      const save = await callJSON(h.client, 'memory_save', {});
      expect(save.text).not.toContain('not implemented');
      const del = await callJSON(h.client, 'memory_delete', {});
      expect(del.text).not.toContain('not implemented');
    } finally {
      await h.close();
    }
  });

  it('ListTools over the in-memory transport returns the eight expected tool names (memory_search, memory_save, memory_list, memory_delete, memory_link, memory_unlink, memory_graph, memory_path) with non-empty descriptions and object inputSchemas', async () => {
    const h = await setupHarness();
    try {
      const result = await h.client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'memory_delete',
        'memory_graph',
        'memory_link',
        'memory_list',
        'memory_path',
        'memory_save',
        'memory_search',
        'memory_unlink',
      ]);
      for (const tool of result.tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
      }
    } finally {
      await h.close();
    }
  });

  it('memory_search is wired to the real search handler when a store is supplied; calling it through the transport returns a non-error CallToolResult whose payload has the documented `{ matches, query, totalScanned }` envelope', async () => {
    const h = await setupHarness();
    try {
      const result = await callJSON(h.client, 'memory_search', { query: 'x' });
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain('not implemented');
      const parsed: unknown = JSON.parse(result.text);
      if (!isRecord(parsed)) throw new Error('parsed not object');
      expect(Array.isArray(parsed.matches)).toBe(true);
      expect(parsed.query).toBe('x');
      expect(typeof parsed.totalScanned).toBe('number');
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-3: round trips for each type
// --------------------------------------------------------------------------

const TYPES = ['user', 'feedback', 'project', 'reference'] as const;

for (const t of TYPES) {
  describe(`ac-3: round-trip for type ${t}`, () => {
    it(`mock-client save->list->delete round trip for type '${t}': memory_save persists the entry, memory_list returns it in the frontmatter list, memory_delete removes it, and a final memory_list does not include it`, async () => {
      const h = await setupHarness();
      try {
        const name = `entry_${t}`;
        const save = await callJSON(h.client, 'memory_save', {
          name,
          type: t,
          description: `desc ${t}`,
          body: `body for ${t}`,
        });
        expect(save.isError).toBe(false);
        if (!isRecord(save.parsed)) throw new Error('save did not return an object');
        expect(isRecord(save.parsed.saved)).toBe(true);
        expect(typeof save.parsed.path).toBe('string');

        const list1 = await callJSON(h.client, 'memory_list', {});
        expect(list1.isError).toBe(false);
        if (!isRecord(list1.parsed)) throw new Error('list did not return object');
        const memories1 = list1.parsed.memories;
        if (!Array.isArray(memories1)) throw new Error('memories not array');
        const found = memories1.find((m) => isRecord(m) && m.name === name);
        expect(found).toBeDefined();
        if (!isRecord(found)) throw new Error('found missing');
        expect(found.type).toBe(t);

        const del = await callJSON(h.client, 'memory_delete', { name });
        expect(del.isError).toBe(false);
        if (!isRecord(del.parsed)) throw new Error('del not object');
        expect(del.parsed.deleted).toBe(name);

        const list2 = await callJSON(h.client, 'memory_list', {});
        if (!isRecord(list2.parsed)) throw new Error('list2 not object');
        const memories2 = list2.parsed.memories;
        if (!Array.isArray(memories2)) throw new Error('memories2 not array');
        const refound = memories2.find((m) => isRecord(m) && m.name === name);
        expect(refound).toBeUndefined();
      } finally {
        await h.close();
      }
    });
  });
}

describe('ac-3: list filtering and frontmatter shape', () => {
  it('mock-client memory_list with `type` filter returns only entries whose stored type matches the filter when memories of multiple types are present', async () => {
    const h = await setupHarness();
    try {
      for (const t of TYPES) {
        const ok = await callJSON(h.client, 'memory_save', {
          name: `entry_${t}`,
          type: t,
          description: `desc ${t}`,
          body: `body for ${t}`,
        });
        expect(ok.isError).toBe(false);
      }

      const filtered = await callJSON(h.client, 'memory_list', { type: 'feedback' });
      expect(filtered.isError).toBe(false);
      if (!isRecord(filtered.parsed)) throw new Error('list not object');
      const memories = filtered.parsed.memories;
      if (!Array.isArray(memories)) throw new Error('memories not array');
      expect(memories.length).toBeGreaterThan(0);
      for (const m of memories) {
        if (!isRecord(m)) throw new Error('m not object');
        expect(m.type).toBe('feedback');
      }
    } finally {
      await h.close();
    }
  });

  it('mock-client memory_list response entries contain only the frontmatter fields (name, type, description) and do NOT include the body field', async () => {
    const h = await setupHarness();
    try {
      await callJSON(h.client, 'memory_save', {
        name: 'one',
        type: 'reference',
        description: 'd',
        body: 'BODY-CONTENT',
      });
      const list = await callJSON(h.client, 'memory_list', {});
      if (!isRecord(list.parsed)) throw new Error('list not object');
      const memories = list.parsed.memories;
      if (!Array.isArray(memories)) throw new Error('memories not array');
      const entry = memories.find((m) => isRecord(m) && m.name === 'one');
      if (!isRecord(entry)) throw new Error('entry missing');
      expect(entry).toEqual({
        name: 'one',
        type: 'reference',
        description: 'd',
        // List entries now carry a `scope` tag so callers can tell
        // user vs project memories apart. With only a user store wired, the
        // tag is always 'user'.
        scope: 'user',
      });
      expect('body' in entry).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('mock-client memory_save followed by an immediate memory_save with the same name returns an MCP error result (isError=true) whose message contains the duplicate name', async () => {
    const h = await setupHarness();
    try {
      const args = {
        name: 'dupe_name',
        type: 'reference',
        description: 'd',
        body: 'b',
      };
      const first = await callJSON(h.client, 'memory_save', args);
      expect(first.isError).toBe(false);
      const second = await callJSON(h.client, 'memory_save', args);
      expect(second.isError).toBe(true);
      expect(second.text).toContain('dupe_name');
    } finally {
      await h.close();
    }
  });

  it('mock-client memory_delete on a name that was never saved returns an MCP error result (isError=true) whose message contains the missing name', async () => {
    const h = await setupHarness();
    try {
      const result = await callJSON(h.client, 'memory_delete', { name: 'never_existed' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('never_existed');
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-4: content-block shape
// --------------------------------------------------------------------------

describe('ac-4: handler responses serialise to MCP text content blocks', () => {
  it('memory_save handler return value JSON-stringifies to a payload containing `saved: { name, type, description }` and `path: <string>`; the resulting CallToolResult content[0] is `{ type: "text", text: <json> }` and parses back to the same object shape', async () => {
    const h = await setupHarness();
    try {
      const result = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'shape_test',
          type: 'reference',
          description: 'desc',
          body: 'body',
        },
      });
      const content = Array.isArray(result.content) ? result.content : [];
      expect(content).toHaveLength(1);
      const first = content[0];
      if (!isTextContent(first)) throw new Error('content[0] not text');
      const parsed: unknown = JSON.parse(first.text);
      if (!isRecord(parsed)) throw new Error('parsed not object');
      if (!isRecord(parsed.saved)) throw new Error('saved not object');
      expect(parsed.saved.name).toBe('shape_test');
      expect(parsed.saved.type).toBe('reference');
      expect(parsed.saved.description).toBe('desc');
      expect(typeof parsed.path).toBe('string');
      expect((parsed.path as string).length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it('memory_list handler return value JSON-stringifies to `{ memories: Array<{ name, type, description }> }`; the resulting CallToolResult content[0] is `{ type: "text", text: <json> }` and parses back to an object with a `memories` array', async () => {
    const h = await setupHarness();
    try {
      await h.client.callTool({
        name: 'memory_save',
        arguments: { name: 'a', type: 'reference', description: 'd', body: 'b' },
      });
      const result = await h.client.callTool({ name: 'memory_list', arguments: {} });
      const content = Array.isArray(result.content) ? result.content : [];
      expect(content).toHaveLength(1);
      const first = content[0];
      if (!isTextContent(first)) throw new Error('content[0] not text');
      const parsed: unknown = JSON.parse(first.text);
      if (!isRecord(parsed)) throw new Error('parsed not object');
      expect(Array.isArray(parsed.memories)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('memory_delete handler return value JSON-stringifies to `{ deleted: <name> }`; the resulting CallToolResult content[0] is `{ type: "text", text: <json> }` and parses back to that exact shape', async () => {
    const h = await setupHarness();
    try {
      await h.client.callTool({
        name: 'memory_save',
        arguments: { name: 'gone', type: 'reference', description: 'd', body: 'b' },
      });
      const result = await h.client.callTool({
        name: 'memory_delete',
        arguments: { name: 'gone' },
      });
      const content = Array.isArray(result.content) ? result.content : [];
      expect(content).toHaveLength(1);
      const first = content[0];
      if (!isTextContent(first)) throw new Error('content[0] not text');
      const parsed: unknown = JSON.parse(first.text);
      // Delete result now carries the `scope` tag identifying the
      // store the memory was removed from.
      expect(parsed).toEqual({ deleted: 'gone', scope: 'user' });
    } finally {
      await h.close();
    }
  });

  it('errors thrown by all three handlers surface to the MCP client as a CallToolResult with isError=true and at least one text content block whose text contains the error message', async () => {
    const h = await setupHarness();
    try {
      // memory_save: bad type rejects
      const saveBad = await h.client.callTool({
        name: 'memory_save',
        arguments: { name: 'x', type: 'wrong', description: 'd', body: 'b' },
      });
      expect(saveBad.isError).toBe(true);
      const saveContent = Array.isArray(saveBad.content) ? saveBad.content : [];
      expect(saveContent.some((c) => isTextContent(c) && c.text.length > 0)).toBe(true);

      // memory_list: bad type rejects
      const listBad = await h.client.callTool({
        name: 'memory_list',
        arguments: { type: 'bogus' },
      });
      expect(listBad.isError).toBe(true);
      const listContent = Array.isArray(listBad.content) ? listBad.content : [];
      expect(listContent.some((c) => isTextContent(c) && c.text.length > 0)).toBe(true);

      // memory_delete: missing name rejects
      const delBad = await h.client.callTool({
        name: 'memory_delete',
        arguments: {},
      });
      expect(delBad.isError).toBe(true);
      const delContent = Array.isArray(delBad.content) ? delBad.content : [];
      expect(delContent.some((c) => isTextContent(c) && c.text.length > 0)).toBe(true);
    } finally {
      await h.close();
    }
  });
});
