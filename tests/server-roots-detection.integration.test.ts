/**
 * DAR-924 ac-1 integration tests: server requests roots/list after init and
 * gracefully tolerates clients that don't support roots.
 *
 * These tests build the server boot sequence the same way the bin does, but
 * run it against an in-memory transport so we can vary the client's
 * capabilities and inspect the side effects (which dir the project store
 * was constructed against, or whether one exists at all). We deliberately
 * do NOT spawn the bin here -- that's covered by the slower
 * `server-bin-scope.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { bootServer, type BootResult } from '../src/bin/boot.js';

let userTmp: string;
let projectTmp: string;

beforeEach(() => {
  userTmp = mkdtempSync(join(tmpdir(), 'dar924-roots-user-'));
  projectTmp = mkdtempSync(join(tmpdir(), 'dar924-roots-proj-'));
});

afterEach(() => {
  rmSync(userTmp, { recursive: true, force: true });
  rmSync(projectTmp, { recursive: true, force: true });
});

const stubEmbedder = (modelId = 'Xenova/bge-base-en-v1.5', dim = 4) => {
  let count = 0;
  return {
    modelId,
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      // Stub embedder: text is intentionally unused; we just produce a
      // monotonically distinct vector per call.
      void text;
      count += 1;
      const out = new Float32Array(dim);
      out[0] = count;
      return out;
    },
  };
};

interface BootHarness extends BootResult {
  client: Client;
  close: () => Promise<void>;
}

const setupHarness = async (options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clientCapabilities?: Record<string, unknown>;
  rootsHandler?: (() => Promise<{ roots: { uri: string; name?: string }[] }>) | 'reject' | 'none';
}): Promise<BootHarness> => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'dar924-roots-test', version: '0.0.0' },
    {
      capabilities:
        options.clientCapabilities ?? (options.rootsHandler !== 'none' ? { roots: {} } : {}),
    },
  );

  if (options.rootsHandler !== undefined && options.rootsHandler !== 'none') {
    if (options.rootsHandler === 'reject') {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        throw new Error('client rejects roots/list');
      });
    } else {
      client.setRequestHandler(ListRootsRequestSchema, options.rootsHandler);
    }
  }

  // Connect client and server in parallel. The server boot includes the
  // listRoots round-trip so both sides need to be live concurrently.
  const bootPromise = bootServer({
    env: options.env ?? {},
    cwd: options.cwd ?? userTmp,
    embedder: stubEmbedder(),
    transport: serverTransport,
  });

  await client.connect(clientTransport);
  const boot = await bootPromise;

  return {
    ...boot,
    client,
    close: async () => {
      await client.close();
      await boot.server.close();
    },
  };
};

describe('DAR-924 ac-1: server issues roots/list after server.connect', () => {
  it('issues a roots/list JSON-RPC request after server.connect(transport) returns', async () => {
    let receivedRequest = false;
    const h = await setupHarness({
      rootsHandler: async () => {
        receivedRequest = true;
        return { roots: [] };
      },
    });
    try {
      expect(receivedRequest).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('when the connected client advertises the roots capability and returns >=1 file:// root, scope detection consumes the first root', async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), 'dar924-ext-root-'));
    try {
      const h = await setupHarness({
        rootsHandler: async () => ({
          roots: [{ uri: pathToFileURL(externalRoot).toString() }],
        }),
      });
      try {
        expect(h.scope.source).toBe('roots');
        expect(h.scope.projectDir).toBe(join(externalRoot, '.commonplace/memory'));
        expect(h.projectStore).not.toBeNull();
      } finally {
        await h.close();
      }
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('when the connected client does NOT advertise the roots capability, the server boot completes without throwing and falls through to the next detection step (cwd / none)', async () => {
    // Set up a cwd marker so we can verify the fallback.
    mkdirSync(join(userTmp, '.commonplace/memory'), { recursive: true });
    const h = await setupHarness({
      clientCapabilities: {},
      rootsHandler: 'none',
      cwd: userTmp,
    });
    try {
      expect(h.scope.source).toBe('cwd');
    } finally {
      await h.close();
    }
  });

  it('when roots/list rejects (e.g. client returns an error response), boot still completes and falls through to the next detection step', async () => {
    mkdirSync(join(userTmp, '.commonplace/memory'), { recursive: true });
    const h = await setupHarness({
      rootsHandler: 'reject',
      cwd: userTmp,
    });
    try {
      expect(h.scope.source).toBe('cwd');
    } finally {
      await h.close();
    }
  });

  it('when the client returns an empty roots array, scope detection treats it as "no project root" and falls through', async () => {
    mkdirSync(join(userTmp, '.commonplace/memory'), { recursive: true });
    const h = await setupHarness({
      rootsHandler: async () => ({ roots: [] }),
      cwd: userTmp,
    });
    try {
      expect(h.scope.source).toBe('cwd');
    } finally {
      await h.close();
    }
  });
});
