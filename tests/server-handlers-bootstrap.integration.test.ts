/**
 * Integration tests: end-to-end bootstrap flow over an MCP SDK client +
 * in-memory transport pair.
 *
 * Covers:
 *   - ac-1 (integration): memory_save with scope='project' against a
 *     user-only server yields a CallToolResult with isError=true and a
 *     structuredContent.code field equal to 'NO_PROJECT_STORE'.
 *   - ac-3 (integration): bootstrap creates the project memory dir for
 *     both .git and .commonplace markers and survives a pre-existing dir.
 *   - ac-4 (integration): no-root-detected error path leaves disk and
 *     handler map unchanged.
 *   - ac-5 (integration): explicit path override happy path and $HOME
 *     refusal.
 *   - ac-6: single MCP connection -- (1) memory_save scope='project'
 *     returns NO_PROJECT_STORE, (2) memory_bootstrap_project_store
 *     succeeds, (3) the same memory_save scope='project' call now writes
 *     under the bootstrapped store. No reconnect / restart between calls
 *     (asserted by reusing the same client/transport instance).
 *
 * The unit-only coverage (handler-level argument validation, factory
 * shape, registry mutation) lives in `server-handlers-bootstrap.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer, installCallToolHandler } from '../src/server/server.js';
import { createDefaultHandlers } from '../src/server/tools.js';
import { MemoryGraph } from '../src/store/graph.js';
import { MemoryStore } from '../src/store/memory-store.js';
import type { BootstrapEnvironment } from '../src/server/handlers.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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

interface TextContent {
  type: 'text';
  text: string;
}

const isTextContent = (value: unknown): value is TextContent => {
  if (!isRecord(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
};

let userTmp: string;
let workspaceTmp: string;
let homeTmp: string;

beforeEach(() => {
  // Normalize via realpath -- on macOS tmpdir() returns /var/... while
  // realpath resolves to /private/var/.... The bootstrap handler uses
  // detectScope's realpath-normalized output, so test reference paths
  // must match the same normalization for equality assertions.
  userTmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar1018-int-user-')));
  workspaceTmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar1018-int-ws-')));
  homeTmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar1018-int-home-')));
});

afterEach(() => {
  rmSync(userTmp, { recursive: true, force: true });
  rmSync(workspaceTmp, { recursive: true, force: true });
  rmSync(homeTmp, { recursive: true, force: true });
});

interface Harness {
  client: Client;
  server: Server;
  userStore: MemoryStore;
  close: () => Promise<void>;
}

/**
 * Wire a real server with a user-only handler map and a real bootstrap
 * env that, on success, rebinds the server's handler map via
 * `installCallToolHandler`. The wiring mirrors what `boot.ts` does in
 * production.
 */
const setupHarness = async (opts: { cwd?: string } = {}): Promise<Harness> => {
  const embedder = makeStubEmbedder();
  const userGraph = new MemoryGraph();
  const userStore = new MemoryStore({ dir: userTmp, embedder, graph: userGraph });
  await userStore.scan();

  const serverHolder: { server: Server | null } = { server: null };
  const buildBootstrapEnv = (): BootstrapEnvironment => ({
    env: {},
    cwd: opts.cwd ?? workspaceTmp,
    homedir: homeTmp,
    createProjectStore: async (dir: string) => {
      const graph = new MemoryGraph();
      const store = new MemoryStore({ dir, embedder, graph });
      return { store, graph };
    },
    rebindHandlers: (projectStore, projectGraph) => {
      if (serverHolder.server === null) {
        throw new Error('rebindHandlers invoked before server existed');
      }
      const rebuilt = createDefaultHandlers({
        userStore,
        projectStore,
        graph: userGraph,
        projectGraph,
        bootstrapEnv: buildBootstrapEnv(),
      });
      installCallToolHandler(serverHolder.server, rebuilt);
    },
  });

  const handlers = createDefaultHandlers({
    userStore,
    graph: userGraph,
    bootstrapEnv: buildBootstrapEnv(),
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ handlers, userStore });
  serverHolder.server = server;

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    userStore,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

// --------------------------------------------------------------------------
// ac-1 (integration): NO_PROJECT_STORE marker on the wire
// --------------------------------------------------------------------------

describe('ac-1 (integration): NO_PROJECT_STORE surfaces on the CallToolResult', () => {
  it("end-to-end via the MCP SDK client: calling memory_save with scope='project' against a user-only server yields a CallToolResult whose isError=true and whose structuredContent.code === 'NO_PROJECT_STORE'", async () => {
    const h = await setupHarness();
    try {
      const result = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'x',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(result.isError).toBe(true);
      const sc = result.structuredContent;
      if (!isRecord(sc)) throw new Error('structuredContent missing or not an object');
      expect(sc.code).toBe('NO_PROJECT_STORE');
    } finally {
      await h.close();
    }
  });

  it('the human-readable text content also names memory_bootstrap_project_store so an operator reading the prose still sees the tool name', async () => {
    const h = await setupHarness();
    try {
      const result = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'x',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter(isTextContent)
        .map((c) => c.text)
        .join('');
      expect(text).toContain('memory_bootstrap_project_store');
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-6: end-to-end single-connection retry path
// --------------------------------------------------------------------------

describe('ac-6: end-to-end retry on a single MCP connection', () => {
  it('three-call sequence on a single transport: (1) memory_save scope=project returns NO_PROJECT_STORE, (2) memory_bootstrap_project_store userConfirmed=true succeeds, (3) the same memory_save now writes the .md under <root>/.commonplace/memory and returns success', async () => {
    // Seed a .git marker so detection finds workspaceTmp.
    mkdirSync(join(workspaceTmp, '.git'));
    const h = await setupHarness();
    try {
      // (1) failing save
      const fail = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'first_proj',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(fail.isError).toBe(true);
      const failSc = fail.structuredContent;
      if (!isRecord(failSc)) throw new Error('expected structuredContent on failing save');
      expect(failSc.code).toBe('NO_PROJECT_STORE');

      // (2) bootstrap
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true },
      });
      expect(boot.isError ?? false).toBe(false);

      // (3) retry succeeds
      const ok = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'first_proj',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(ok.isError ?? false).toBe(false);

      // The post-bootstrap save's payload should name the project scope
      // and a path under the new memory dir.
      const okContent = Array.isArray(ok.content) ? ok.content : [];
      const okText = okContent
        .filter(isTextContent)
        .map((c) => c.text)
        .join('');
      const parsed = JSON.parse(okText);
      if (!isRecord(parsed)) throw new Error('expected save result object');
      expect(parsed.scope).toBe('project');
      const parsedPath = parsed.path;
      if (typeof parsedPath !== 'string') throw new Error('expected parsed.path to be string');
      expect(parsedPath).toContain(join(workspaceTmp, '.commonplace', 'memory'));

      // The .md file should exist under the new project dir.
      const files = readdirSync(join(workspaceTmp, '.commonplace', 'memory'));
      expect(files).toContain('first_proj.md');
    } finally {
      await h.close();
    }
  });

  it('the post-bootstrap save returns a result whose scope is project and whose path is under the new project memory dir', async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const h = await setupHarness();
    try {
      await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true },
      });
      const ok = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'proj_mem',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(ok.isError ?? false).toBe(false);
      const okContent = Array.isArray(ok.content) ? ok.content : [];
      const text = okContent
        .filter(isTextContent)
        .map((c) => c.text)
        .join('');
      const parsed = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error('expected save result');
      expect(parsed.scope).toBe('project');
      expect(parsed.path).toBe(join(workspaceTmp, '.commonplace', 'memory', 'proj_mem.md'));
    } finally {
      await h.close();
    }
  });

  it('no reconnect or restart occurs between the failing save, the bootstrap, and the succeeding save -- the same client instance issues all three calls', async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const h = await setupHarness();
    try {
      const clientBefore = h.client;
      const fail = await h.client.callTool({
        name: 'memory_save',
        arguments: { name: 'x', type: 'project', description: 'd', body: 'b', scope: 'project' },
      });
      expect(fail.isError).toBe(true);
      // Same client instance.
      expect(h.client).toBe(clientBefore);
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true },
      });
      expect(boot.isError ?? false).toBe(false);
      expect(h.client).toBe(clientBefore);
      const ok = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'x',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(ok.isError ?? false).toBe(false);
      expect(h.client).toBe(clientBefore);
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-3 (integration): markers + pre-existing dir
// --------------------------------------------------------------------------

describe('ac-3 (integration): bootstrap detects both markers and survives a pre-existing dir', () => {
  it('with a .commonplace marker (instead of .git) at workspaceTmp, the bootstrap still resolves to workspaceTmp and creates the memory subdir', async () => {
    mkdirSync(join(workspaceTmp, '.commonplace'));
    const h = await setupHarness();
    try {
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true },
      });
      expect(boot.isError ?? false).toBe(false);
      expect(existsSync(join(workspaceTmp, '.commonplace', 'memory'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a pre-existing <root>/.commonplace/memory directory is not clobbered by bootstrap', async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const memDir = join(workspaceTmp, '.commonplace', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'sentinel.md'), '# sentinel');
    const h = await setupHarness();
    try {
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true },
      });
      expect(boot.isError ?? false).toBe(false);
      expect(existsSync(join(memDir, 'sentinel.md'))).toBe(true);
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-4 (integration): no-root error
// --------------------------------------------------------------------------

describe('ac-4 (integration): no-root error path leaves disk + handler map unchanged', () => {
  it('with no marker and no env override, the bootstrap call returns isError=true and the next memory_save scope=project still returns NO_PROJECT_STORE (handler map unchanged)', async () => {
    const h = await setupHarness();
    try {
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true },
      });
      expect(boot.isError).toBe(true);
      // Disk: no .commonplace dir should appear under workspaceTmp.
      expect(existsSync(join(workspaceTmp, '.commonplace'))).toBe(false);
      // Handler map: subsequent project save still fails with NO_PROJECT_STORE.
      const stillFails = await h.client.callTool({
        name: 'memory_save',
        arguments: {
          name: 'x',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        },
      });
      expect(stillFails.isError).toBe(true);
      const sc = stillFails.structuredContent;
      if (!isRecord(sc)) throw new Error('expected structuredContent on still-failing save');
      expect(sc.code).toBe('NO_PROJECT_STORE');
    } finally {
      await h.close();
    }
  });
});

// --------------------------------------------------------------------------
// ac-5 (integration): explicit path override
// --------------------------------------------------------------------------

describe('ac-5 (integration): explicit path override -- happy path and $HOME refusal', () => {
  it('with userConfirmed=true and explicit path pointing at a markerless directory, the tool creates <path>/.commonplace/memory', async () => {
    // workspaceTmp has NO markers; use it as the path override.
    const h = await setupHarness({ cwd: '/dev/null' });
    try {
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true, path: workspaceTmp },
      });
      expect(boot.isError ?? false).toBe(false);
      expect(existsSync(join(workspaceTmp, '.commonplace', 'memory'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('with an explicit path equal to $HOME, the tool refuses with the $HOME-exclusive safety check and does not create ~/.commonplace', async () => {
    const h = await setupHarness();
    try {
      const boot = await h.client.callTool({
        name: 'memory_bootstrap_project_store',
        arguments: { userConfirmed: true, path: homeTmp },
      });
      expect(boot.isError).toBe(true);
      const content = Array.isArray(boot.content) ? boot.content : [];
      const text = content
        .filter(isTextContent)
        .map((c) => c.text)
        .join('');
      expect(/HOME|home|safety/i.test(text)).toBe(true);
      expect(existsSync(join(homeTmp, '.commonplace'))).toBe(false);
    } finally {
      await h.close();
    }
  });
});
