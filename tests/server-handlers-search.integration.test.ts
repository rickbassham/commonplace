/**
 * Integration tests: end-to-end MCP server with the real memory_search
 * handler over an in-memory transport pair.
 *
 * Spins up a real `Server` (via `createServer`) wired with a real
 * `MemoryStore` backed by a tmp directory and a programmable stub
 * embedder, and a real `Client` connected via
 * `InMemoryTransport.createLinkedPair()`.
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

/**
 * L2-normalise a Float32Array in place. The store's vectors are L2-normalised
 * at write time so dot product == cosine; we want our seeded fixtures to
 * follow the same invariant.
 */
const l2norm = (v: Float32Array): Float32Array => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n > 0) {
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  }
  return v;
};

/**
 * Programmable embedder: registry-driven so tests can pin specific bodies and
 * the query string to specific vectors and reason about scoring directly.
 */
const makeProgrammableEmbedder = (dim = 4) => {
  const registry = new Map<string, Float32Array>();
  return {
    modelId: 'Xenova/bge-base-en-v1.5',
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      const v = registry.get(text);
      if (v) return new Float32Array(v);
      // Fallback: deterministic but distinct across inputs.
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

interface Harness {
  client: Client;
  store: MemoryStore;
  embedder: ReturnType<typeof makeProgrammableEmbedder>;
  close: () => Promise<void>;
}

let tmp: string;

const setupHarness = async (): Promise<Harness> => {
  const embedder = makeProgrammableEmbedder();
  const store = new MemoryStore({ dir: tmp, embedder });
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
    embedder,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar920-int-'));
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
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { isError, text, parsed };
};

// --------------------------------------------------------------------------
// ac-1: registration over the transport
// --------------------------------------------------------------------------

describe('ac-1: createServer wires real memory_search handler', () => {
  it('ListTools over the in-memory MCP transport returns the eight expected tool names (memory_search, memory_save, memory_list, memory_delete, memory_link, memory_unlink, memory_graph, memory_path) with non-empty descriptions and an object inputSchema', async () => {
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

  it("CallTool with name 'memory_search' over the in-memory MCP transport dispatches to the search handler (response is a non-error CallToolResult, not an error containing 'not implemented')", async () => {
    const h = await setupHarness();
    try {
      const result = await callJSON(h.client, 'memory_search', { query: 'anything' });
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain('not implemented');
      if (!isRecord(result.parsed)) throw new Error('parsed not object');
      expect(Array.isArray(result.parsed.matches)).toBe(true);
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-3: full body returned through the transport
// --------------------------------------------------------------------------

describe('ac-3: full body round-trip through MCP transport', () => {
  it("for each SearchHit returned by store.search, the corresponding entry in `matches` carries a `body` field whose value equals the memory's full body string verbatim (no truncation, no ellipsis, no summarisation) -- verified by saving a multi-paragraph memory and asserting byte-for-byte equality on round-trip through memory_search", async () => {
    const h = await setupHarness();
    try {
      const longBody = [
        'First paragraph with some content.',
        '',
        'Second paragraph -- includes punctuation, edge characters: <> & "quotes" and \'apostrophes\'.',
        '',
        'Third paragraph mentioning multi\nline content and even \t tabs.',
        '',
        'Final paragraph closes things out with words that would be tempting to summarise away.',
      ].join('\n');
      h.embedder.register(longBody, l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
      const save = await callJSON(h.client, 'memory_save', {
        name: 'multi_paragraph',
        type: 'reference',
        description: 'd',
        body: longBody,
        scope: 'user',
      });
      expect(save.isError).toBe(false);

      const search = await callJSON(h.client, 'memory_search', { query: 'q' });
      expect(search.isError).toBe(false);
      if (!isRecord(search.parsed)) throw new Error('parsed not object');
      const matches = search.parsed.matches;
      if (!Array.isArray(matches)) throw new Error('matches not array');
      const entry = matches.find((m) => isRecord(m) && m.name === 'multi_paragraph');
      if (!isRecord(entry)) throw new Error('entry missing');
      expect(entry.body).toBe(longBody);
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-4: ordering on a seeded corpus
// --------------------------------------------------------------------------

describe('ac-4: ordering on a seeded corpus', () => {
  it("with a seeded corpus and a deterministic stub embedder where one entry's vector is closest to the query vector, memory_search returns matches in strictly descending `score` order", async () => {
    const h = await setupHarness();
    try {
      // Three vectors, distinct cosine similarities to the query [1,0,0,0].
      const a = l2norm(new Float32Array([1, 0, 0, 0])); // cos = 1
      const b = l2norm(new Float32Array([0.9, 0.4, 0, 0])); // cos < 1
      const c = l2norm(new Float32Array([0.5, 0.5, 0.5, 0.5])); // cos = 0.5
      h.embedder.register('body_a', a);
      h.embedder.register('body_b', b);
      h.embedder.register('body_c', c);
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));

      for (const [name, body] of [
        ['alpha', 'body_a'],
        ['bravo', 'body_b'],
        ['charlie', 'body_c'],
      ] as const) {
        const ok = await callJSON(h.client, 'memory_save', {
          name,
          type: 'reference',
          description: `d ${name}`,
          body,
          scope: 'user',
        });
        expect(ok.isError).toBe(false);
      }

      const search = await callJSON(h.client, 'memory_search', { query: 'q' });
      expect(search.isError).toBe(false);
      if (!isRecord(search.parsed)) throw new Error('parsed not object');
      const matches = search.parsed.matches as Array<{ name: string; score: number }>;
      expect(matches.length).toBe(3);
      // Strictly descending on score.
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1]!.score).toBeGreaterThan(matches[i]!.score);
      }
    } finally {
      await h.close();
    }
  });

  it('memory_search invoked over the in-memory MCP client transport on a seeded corpus returns the expected top match as the first element of `matches` (end-to-end ordering through the MCP layer, not just the in-process handler)', async () => {
    const h = await setupHarness();
    try {
      const a = l2norm(new Float32Array([1, 0, 0, 0])); // top
      const b = l2norm(new Float32Array([0, 1, 0, 0]));
      const c = l2norm(new Float32Array([0, 0, 1, 0]));
      h.embedder.register('body_a', a);
      h.embedder.register('body_b', b);
      h.embedder.register('body_c', c);
      h.embedder.register('find me', l2norm(new Float32Array([0.99, 0.01, 0, 0])));

      for (const [name, body] of [
        ['alpha', 'body_a'],
        ['bravo', 'body_b'],
        ['charlie', 'body_c'],
      ] as const) {
        const ok = await callJSON(h.client, 'memory_save', {
          name,
          type: 'reference',
          description: `d ${name}`,
          body,
          scope: 'user',
        });
        expect(ok.isError).toBe(false);
      }

      const search = await callJSON(h.client, 'memory_search', { query: 'find me' });
      if (!isRecord(search.parsed)) throw new Error('parsed not object');
      const matches = search.parsed.matches as Array<{ name: string }>;
      expect(matches[0]?.name).toBe('alpha');
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-5: type filter
// --------------------------------------------------------------------------

describe('ac-5: type filter narrows results', () => {
  it("given a seeded corpus containing memories of multiple types, memory_search invoked with `type: 'feedback'` returns only matches whose `type === 'feedback'`", async () => {
    const h = await setupHarness();
    try {
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
      const types = ['user', 'feedback', 'project', 'reference'] as const;
      for (const t of types) {
        const body = `body_${t}`;
        h.embedder.register(body, l2norm(new Float32Array([1, 0, 0, 0])));
        const ok = await callJSON(h.client, 'memory_save', {
          name: `entry_${t}`,
          type: t,
          description: `d ${t}`,
          body,
          scope: 'user',
        });
        expect(ok.isError).toBe(false);
      }

      const search = await callJSON(h.client, 'memory_search', { query: 'q', type: 'feedback' });
      expect(search.isError).toBe(false);
      if (!isRecord(search.parsed)) throw new Error('parsed not object');
      const matches = search.parsed.matches as Array<{ name: string; type: string }>;
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m.type).toBe('feedback');
      }
    } finally {
      await h.close();
    }
  });

  it('memory_search omits the `type` filter when the argument is absent and returns matches across all types present in the corpus', async () => {
    const h = await setupHarness();
    try {
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
      const types = ['user', 'feedback', 'project', 'reference'] as const;
      for (const t of types) {
        const body = `body_${t}`;
        h.embedder.register(body, l2norm(new Float32Array([1, 0, 0, 0])));
        await callJSON(h.client, 'memory_save', {
          name: `entry_${t}`,
          type: t,
          description: `d ${t}`,
          body,
          scope: 'user',
        });
      }

      const search = await callJSON(h.client, 'memory_search', { query: 'q' });
      if (!isRecord(search.parsed)) throw new Error('parsed not object');
      const matches = search.parsed.matches as Array<{ type: string }>;
      const observed = new Set(matches.map((m) => m.type));
      expect(observed).toEqual(new Set(types));
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-6: empty corpus
// --------------------------------------------------------------------------

describe('ac-6: empty corpus returns clean envelope', () => {
  it('memory_search invoked against a freshly-scanned empty memory directory returns exactly `{ matches: [], query: <input>, totalScanned: 0 }` and does not throw', async () => {
    const h = await setupHarness();
    try {
      const result = await callJSON(h.client, 'memory_search', { query: 'whatever' });
      expect(result.isError).toBe(false);
      if (!isRecord(result.parsed)) throw new Error('parsed not object');
      expect(result.parsed).toEqual({ matches: [], query: 'whatever', totalScanned: 0 });
    } finally {
      await h.close();
    }
  });
});
