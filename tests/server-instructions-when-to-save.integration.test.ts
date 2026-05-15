/**
 * Integration tests for DAR-1013 ac-4: a connected MCP client receives
 * the prescriptive "when to save what" block as part of the
 * server-provided `instructions` string after initialize, and the
 * three-section ordering (SERVER_INSTRUCTIONS prefix -> when-to-save
 * block -> `## Pinned memories` heading) is preserved when a fixture
 * store has at least one pinned memory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { MemoryStore } from '../src/store/memory-store.js';
import {
  PINNED_HEADING,
  SERVER_INSTRUCTIONS,
  WHEN_TO_SAVE_INSTRUCTIONS,
  createServer,
} from '../src/server/server.js';

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

let tmpUser: string;

beforeEach(() => {
  tmpUser = mkdtempSync(join(tmpdir(), 'dar1013i-u-'));
});

afterEach(() => {
  rmSync(tmpUser, { recursive: true, force: true });
});

describe('DAR-1013 ac-4: when-to-save block visible via MCP getInstructions()', () => {
  it('an MCP Client connected via InMemoryTransport to a createServer() observes a `getInstructions()` string containing each of `user`, `feedback`, `project`, `reference` and `save when`', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const observed = client.getInstructions();
      expect(typeof observed).toBe('string');
      expect(observed).toContain('user');
      expect(observed).toContain('feedback');
      expect(observed).toContain('project');
      expect(observed).toContain('reference');
      expect(observed).toMatch(/save when/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the integration-observed `getInstructions()` string preserves the three-section ordering (SERVER_INSTRUCTIONS prefix -> when-to-save block -> `## Pinned memories` heading) when a fixture store has at least one pinned memory', async () => {
    const userStore = new MemoryStore({ dir: tmpUser, embedder: makeStubEmbedder() });
    await userStore.scan();
    await userStore.save({
      name: 'pinned_one',
      type: 'feedback',
      description: 'a pinned description',
      body: 'b',
      pinned: true,
    });

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ userStore });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const observed = client.getInstructions() ?? '';
      const prefixIdx = observed.indexOf(SERVER_INSTRUCTIONS);
      const whenIdx = observed.indexOf(WHEN_TO_SAVE_INSTRUCTIONS);
      const pinIdx = observed.indexOf(PINNED_HEADING);
      expect(prefixIdx).toBe(0);
      expect(whenIdx).toBeGreaterThan(0);
      expect(pinIdx).toBeGreaterThan(whenIdx);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
