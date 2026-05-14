/**
 * Integration test for ac-5 (mentions edges NOT in match.relations
 * on the wire) and a sanity check on supersede filtering through the
 * full MCP transport.
 *
 * Spins up a real `Server` (via `createServer`) wired with a real
 * `MemoryStore` backed by a tmp directory and a programmable stub embedder,
 * and a real `Client` connected via `InMemoryTransport.createLinkedPair()`.
 *
 * The "spawned-bin" naming in the contract refers to verification that the
 * on-the-wire JSON is correct end-to-end -- the bin integration test
 * (`server-bin.integration.test.ts`) covers actual subprocess wiring; this
 * file covers the JSON shape over the in-memory MCP transport, which is
 * the same wire format and exercises all the same serialisation paths
 * without paying the embedder cold-start cost.
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
  tmp = mkdtempSync(join(tmpdir(), 'dar929-int-'));
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
// ac-5 integration: mentions edges do not appear in match.relations on the wire
// --------------------------------------------------------------------------

describe('ac-5 (integration): on-the-wire JSON has no mentions edges in match.relations', () => {
  it("memory_search against a corpus with both authored relations and `[[mention]]` body tokens confirms the on-the-wire JSON response carries no `mentions`-typed entries in any match's `relations` array", async () => {
    const h = await setupHarness();
    try {
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('body_target', l2norm(new Float32Array([0, 1, 0, 0])));
      h.embedder.register('body_mentioned', l2norm(new Float32Array([0, 0, 1, 0])));
      h.embedder.register(
        'authored relations + [[body_mentioned_target]] inline mention',
        l2norm(new Float32Array([1, 0, 0, 0])),
      );

      const targets = [
        { name: 'target', body: 'body_target' },
        { name: 'body_mentioned_target', body: 'body_mentioned' },
      ];
      for (const t of targets) {
        const r = await callJSON(h.client, 'memory_save', {
          name: t.name,
          type: 'reference',
          description: 'd',
          body: t.body,
        });
        expect(r.isError).toBe(false);
      }

      // Save M directly via the store (relations are authored via
      // memory_link, not via memory_save). The supersede / relations
      // behaviour is independent of how M was created.
      await h.store.save({
        name: 'm',
        type: 'reference',
        description: 'd',
        body: 'authored relations + [[body_mentioned_target]] inline mention',
        relations: [{ to: 'target', type: 'related-to' }],
      });

      const search = await callJSON(h.client, 'memory_search', { query: 'q' });
      expect(search.isError).toBe(false);
      if (!isRecord(search.parsed)) throw new Error('parsed not object');
      const matches = search.parsed.matches;
      if (!Array.isArray(matches)) throw new Error('matches not array');

      for (const match of matches) {
        if (!isRecord(match)) throw new Error('match not record');
        const relations = match.relations;
        expect(Array.isArray(relations)).toBe(true);
        if (!Array.isArray(relations)) throw new Error('relations not array');
        for (const rel of relations) {
          if (!isRecord(rel)) throw new Error('rel not record');
          expect(rel.type).not.toBe('mentions');
          expect(rel.type).not.toBe('supersedes');
        }
      }

      // And specifically confirm M's authored relations made it through.
      const m = matches.find((entry) => isRecord(entry) && entry.name === 'm');
      if (!isRecord(m)) throw new Error('m missing');
      expect(m.relations).toEqual([{ to: 'target', type: 'related-to' }]);
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-2 / ac-3 integration: default-exclude superseded over the wire
// --------------------------------------------------------------------------

describe('ac-2/ac-3 (integration): superseded memories filter out by default and come back with includeSuperseded:true', () => {
  it('memory_search default-excludes A when B supersedes A; passing includeSuperseded:true returns A with `supersededBy: B`', async () => {
    const h = await setupHarness();
    try {
      h.embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('body_b', l2norm(new Float32Array([0.9, 0.1, 0, 0])));

      // memory A — saved via MCP tool (no graph fields).
      const aOk = await callJSON(h.client, 'memory_save', {
        name: 'a',
        type: 'reference',
        description: 'da',
        body: 'body_a',
      });
      expect(aOk.isError).toBe(false);
      // memory B — saved via store directly so we can attach supersedes:[a].
      await h.store.save({
        name: 'b',
        type: 'reference',
        description: 'db',
        body: 'body_b',
        supersedes: ['a'],
      });

      // Default search excludes A.
      const def = await callJSON(h.client, 'memory_search', { query: 'q' });
      if (!isRecord(def.parsed)) throw new Error('parsed not object');
      const defMatches = def.parsed.matches as Array<{ name: string }>;
      expect(defMatches.map((m) => m.name)).not.toContain('a');

      // includeSuperseded:true returns A with supersededBy: 'b'.
      const inc = await callJSON(h.client, 'memory_search', {
        query: 'q',
        includeSuperseded: true,
      });
      if (!isRecord(inc.parsed)) throw new Error('parsed not object');
      const incMatches = inc.parsed.matches as Array<Record<string, unknown>>;
      const aMatch = incMatches.find((m) => m.name === 'a');
      expect(aMatch).toBeDefined();
      expect(aMatch!.supersededBy).toBe('b');
      const bMatch = incMatches.find((m) => m.name === 'b');
      expect(bMatch).toBeDefined();
      expect('supersededBy' in bMatch!).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('memory_list default-excludes A when B supersedes A; includeSuperseded:true returns A in the list', async () => {
    const h = await setupHarness();
    try {
      h.embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
      h.embedder.register('body_b', l2norm(new Float32Array([0, 1, 0, 0])));
      await h.store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
      await h.store.save({
        name: 'b',
        type: 'reference',
        description: 'db',
        body: 'body_b',
        supersedes: ['a'],
      });

      const def = await callJSON(h.client, 'memory_list', {});
      if (!isRecord(def.parsed)) throw new Error('parsed not object');
      const defMems = def.parsed.memories as Array<{ name: string }>;
      expect(defMems.map((m) => m.name)).not.toContain('a');

      const inc = await callJSON(h.client, 'memory_list', { includeSuperseded: true });
      if (!isRecord(inc.parsed)) throw new Error('parsed not object');
      const incMems = inc.parsed.memories as Array<{ name: string }>;
      expect(incMems.map((m) => m.name)).toContain('a');
    } finally {
      await h.close();
    }
  });
});
