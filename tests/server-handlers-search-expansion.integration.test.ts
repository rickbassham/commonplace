/**
 * DAR-930 integration tests: end-to-end one-hop expansion over the MCP
 * transport.
 *
 * Spins up a real `Server` wired with a real `MemoryStore` + `MemoryGraph`
 * over `InMemoryTransport.createLinkedPair()`, seeds a small corpus,
 * authors edges via the `memory_link` tool, and verifies that
 * `memory_search` with `expand: 'one-hop'` returns expansion entries with
 * the `via` annotation on the wire.
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
import { MemoryGraph } from '../src/store/graph.js';

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
      // Deterministic fallback so unregistered descriptions/bodies still
      // produce a valid embedding (distinct from each other).
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
  graph: MemoryGraph;
  embedder: ReturnType<typeof makeProgrammableEmbedder>;
  close: () => Promise<void>;
}

let tmp: string;

const setupHarness = async (): Promise<Harness> => {
  const embedder = makeProgrammableEmbedder();
  const graph = new MemoryGraph();
  const store = new MemoryStore({ dir: tmp, embedder, graph });
  await store.scan();
  const handlers = createDefaultHandlers({ userStore: store, graph });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ handlers });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    store,
    graph,
    embedder,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar930-int-'));
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
// end-to-end one-hop expansion through the MCP transport
// --------------------------------------------------------------------------

describe('one-hop expansion: spawned bin / MCP transport round-trip', () => {
  it('memory_search invoked with expand: "one-hop" over the MCP transport returns expansion entries on the wire with the via annotation populated', async () => {
    const h = await setupHarness();
    try {
      // Pin vectors so direct-hit ranking is deterministic. Hub's body
      // matches the query exactly (cos=1); the neighbours' bodies are
      // orthogonal (cos=0) so a threshold of 0.99 narrows the direct-hit
      // set to {hub}. Without that narrowing, the neighbours would also
      // appear as direct hits and the dedup rule would strip their `via`
      // annotations -- defeating what this test is verifying.
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('body_hub', l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('body_a', l2norm(new Float32Array([0, 1, 0, 0])));
      h.embedder.register('body_b', l2norm(new Float32Array([0, 0, 1, 0])));

      // Seed three memories: a hub and two distinct neighbours.
      for (const [name, body] of [
        ['hub', 'body_hub'],
        ['neighbour_a', 'body_a'],
        ['neighbour_b', 'body_b'],
      ] as const) {
        const save = await callJSON(h.client, 'memory_save', {
          name,
          type: 'reference',
          description: `description for ${name}`,
          body,
        });
        expect(save.isError).toBe(false);
      }

      // Link hub -> neighbour_a (builds-on) and hub -> neighbour_b (related-to).
      const linkA = await callJSON(h.client, 'memory_link', {
        from: 'hub',
        to: 'neighbour_a',
        type: 'builds-on',
      });
      expect(linkA.isError).toBe(false);
      const linkB = await callJSON(h.client, 'memory_link', {
        from: 'hub',
        to: 'neighbour_b',
        type: 'related-to',
      });
      expect(linkB.isError).toBe(false);

      // Without expansion: only the hub passes the cosine threshold.
      const baseline = await callJSON(h.client, 'memory_search', {
        query: 'q',
        limit: 10,
        threshold: 0.99,
      });
      expect(baseline.isError).toBe(false);
      if (!isRecord(baseline.parsed)) throw new Error('baseline parse');
      const baselineMatches = baseline.parsed.matches as Array<Record<string, unknown>>;
      expect(baselineMatches).toHaveLength(1);
      expect(baselineMatches[0]?.name).toBe('hub');
      expect('via' in baselineMatches[0]!).toBe(false);

      // With expansion: hub + 2 neighbours, both carrying via.
      const expanded = await callJSON(h.client, 'memory_search', {
        query: 'q',
        limit: 10,
        threshold: 0.99,
        expand: 'one-hop',
      });
      expect(expanded.isError).toBe(false);
      if (!isRecord(expanded.parsed)) throw new Error('expanded parse');
      const matches = expanded.parsed.matches as Array<Record<string, unknown>>;
      const names = matches.map((m) => m.name).sort();
      expect(names).toContain('hub');
      expect(names).toContain('neighbour_a');
      expect(names).toContain('neighbour_b');

      const hub = matches.find((m) => m.name === 'hub');
      expect(hub).toBeDefined();
      expect(hub && 'via' in hub).toBe(false);

      const nA = matches.find((m) => m.name === 'neighbour_a');
      expect(nA?.via).toEqual({ source: 'hub', edge: 'builds-on' });

      const nB = matches.find((m) => m.name === 'neighbour_b');
      expect(nB?.via).toEqual({ source: 'hub', edge: 'related-to' });

      // Expansion entries score strictly below their source hub.
      expect((nA?.score as number) < (hub?.score as number)).toBe(true);
      expect((nB?.score as number) < (hub?.score as number)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('memory_search inputSchema advertised by ListTools includes the expand, expandTypes, and expandLimit fields with their documented enums and defaults', async () => {
    const h = await setupHarness();
    try {
      const result = await h.client.listTools();
      const tool = result.tools.find((t) => t.name === 'memory_search');
      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(props.expand?.enum).toEqual(['none', 'one-hop']);
      const expandTypesItems = props.expandTypes?.items as Record<string, unknown>;
      expect(expandTypesItems?.enum).toEqual([
        'related-to',
        'builds-on',
        'contradicts',
        'child-of',
        'mentions',
      ]);
      expect(props.expandLimit?.type).toBe('integer');
      expect(props.expandLimit?.minimum).toBe(1);
    } finally {
      await h.close();
    }
  });
});
