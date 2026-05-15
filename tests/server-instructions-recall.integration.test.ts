/**
 * Integration test for ac-8: a connected MCP client receives the
 * pinned-memories recall pack as part of the server-provided
 * `instructions` string after initialize.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { MemoryStore } from '../src/store/memory-store.js';
import { createServer } from '../src/server/server.js';

let tmpUser: string;
let tmpProject: string;

beforeEach(() => {
  tmpUser = mkdtempSync(join(tmpdir(), 'dar1003i-u-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'dar1003i-p-'));
});

afterEach(() => {
  rmSync(tmpUser, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
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

describe('ac-8: pinned recall pack visible via MCP getInstructions()', () => {
  it("integration: a connected MCP client's `getInstructions()` returns a string containing both pinned memories' names and descriptions and excluding the unpinned memory's name", async () => {
    const userStore = new MemoryStore({ dir: tmpUser, embedder: makeStubEmbedder() });
    await userStore.scan();
    await userStore.save({
      name: 'pinned_user_one',
      type: 'feedback',
      description: 'user pinned description',
      body: 'b',
      pinned: true,
    });
    await userStore.save({
      name: 'unpinned_user_two',
      type: 'feedback',
      description: 'unpinned description',
      body: 'b',
    });

    const projectStore = new MemoryStore({ dir: tmpProject, embedder: makeStubEmbedder() });
    await projectStore.scan();
    await projectStore.save({
      name: 'pinned_project_three',
      type: 'project',
      description: 'project pinned description',
      body: 'b',
      pinned: true,
    });

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ userStore, projectStore });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const observed = client.getInstructions();
      expect(typeof observed).toBe('string');
      expect(observed).toContain('pinned_user_one');
      expect(observed).toContain('user pinned description');
      expect(observed).toContain('pinned_project_three');
      expect(observed).toContain('project pinned description');
      expect(observed).not.toContain('unpinned_user_two');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
