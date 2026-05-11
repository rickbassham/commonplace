/**
 * DAR-919 bin integration test: spawn the built `commonplace-mcp` bin and
 * exercise a full memory_save -> memory_list -> memory_delete round-trip
 * via real MCP stdio framing, with a real Embedder loading real model
 * weights against a tmp memory directory.
 *
 * This proves the bin actually wires Embedder + MemoryStore into the
 * server handlers. The DI-style integration test in
 * `server-handlers.integration.test.ts` covers the same handlers with a
 * stub embedder; this test pays the real cold-start price (~6-12s) so
 * we know the wiring at the bin entry point is correct.
 *
 * Slow on purpose. Vitest timeout is generous.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(__dirname, '..');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

interface TextContent {
  type: 'text';
  text: string;
}

const isTextContent = (value: unknown): value is TextContent => {
  if (!isObject(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
};

function readBinPath(): string {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (!isObject(raw)) throw new Error('package.json is not an object');
  const bin = raw.bin;
  if (!isObject(bin)) throw new Error('package.json bin is not an object');
  const entry = bin['commonplace-mcp'];
  if (typeof entry !== 'string') throw new Error('bin.commonplace-mcp missing');
  return join(repoRoot, entry);
}

function firstTextContent(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`expected non-empty content array, got ${JSON.stringify(content)}`);
  }
  const first = content[0];
  if (!isTextContent(first)) {
    throw new Error(`expected text content, got ${JSON.stringify(first)}`);
  }
  return first.text;
}

describe('DAR-919 bin integration: spawned bin with real Embedder + MemoryStore', () => {
  const binPath = readBinPath();
  let memoryDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(() => {
    const res = spawnSync('make', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: '1' },
    });
    if (res.status !== 0) {
      throw new Error(`make build failed: ${res.stderr || res.stdout}`);
    }
    if (!existsSync(binPath)) {
      throw new Error(`bin not found after build: ${binPath}`);
    }
  }, 200_000);

  beforeEach(async () => {
    memoryDir = mkdtempSync(join(tmpdir(), 'dar919-bin-int-'));
    transport = new StdioClientTransport({
      command: 'node',
      args: [binPath],
      env: {
        ...process.env,
        COMMONPLACE_MEMORY_DIR: memoryDir,
      } as Record<string, string>,
      // The bin must inherit stderr so a boot failure is visible in test
      // output; stdin/stdout are owned by the transport for MCP framing.
      stderr: 'inherit',
    });
    client = new Client({ name: 'dar919-bin-int', version: '0.0.0' });
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // best-effort cleanup
    }
    rmSync(memoryDir, { recursive: true, force: true });
  });

  afterAll(() => {
    // No global teardown required; per-test transports are closed in afterEach.
  });

  it('round-trips memory_save -> memory_list -> memory_delete through real Embedder + MemoryStore', async () => {
    // memory_save: write a real memory, embed it via the real model, fsync sidecar.
    const saveResult = await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'integration_marker',
        type: 'reference',
        description: 'DAR-919 bin integration sentinel.',
        body: 'This memory is created by the spawned-bin integration test to verify end-to-end wiring.',
      },
    });
    expect(saveResult.isError).toBeFalsy();

    // The .md and .embedding files MUST be on disk after save returns.
    const filesAfterSave = readdirSync(memoryDir).sort();
    expect(filesAfterSave).toEqual(
      ['integration_marker.embedding', 'integration_marker.md'].sort(),
    );

    // memory_list: the new memory must appear with the right fields.
    const listResult = await client.callTool({
      name: 'memory_list',
      arguments: {},
    });
    expect(listResult.isError).toBeFalsy();
    const listText = firstTextContent(listResult.content);
    const listed: unknown = JSON.parse(listText);
    if (!isObject(listed) || !Array.isArray(listed.memories)) {
      throw new Error(`memory_list payload missing memories[]: ${JSON.stringify(listed)}`);
    }
    const entries = listed.memories as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('integration_marker');
    expect(entries[0]?.type).toBe('reference');

    // memory_delete: removing the entry takes both files off disk.
    const deleteResult = await client.callTool({
      name: 'memory_delete',
      arguments: { name: 'integration_marker' },
    });
    expect(deleteResult.isError).toBeFalsy();

    const filesAfterDelete = readdirSync(memoryDir);
    expect(filesAfterDelete).toEqual([]);

    // Final memory_list confirms emptiness.
    const finalList = await client.callTool({
      name: 'memory_list',
      arguments: {},
    });
    expect(finalList.isError).toBeFalsy();
    const finalListText = firstTextContent(finalList.content);
    const finalListed: unknown = JSON.parse(finalListText);
    if (!isObject(finalListed) || !Array.isArray(finalListed.memories)) {
      throw new Error(`memory_list payload missing memories[]: ${JSON.stringify(finalListed)}`);
    }
    expect(finalListed.memories).toEqual([]);
  }, 120_000);

  it('memory_search is wired to the real DAR-920 handler in the spawned bin: a query against an empty memory dir returns a non-error CallToolResult whose payload is `{ matches: [], query: <input>, totalScanned: 0 }`', async () => {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'anything' },
    });
    expect(result.isError).toBeFalsy();
    const text = firstTextContent(result.content);
    expect(text).not.toMatch(/not implemented/i);
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) {
      throw new Error(`memory_search payload is not an object: ${text}`);
    }
    expect(parsed.matches).toEqual([]);
    expect(parsed.query).toBe('anything');
    expect(parsed.totalScanned).toBe(0);
  });
});

describe('DAR-913 ac-6 bin integration: spawned bin honours COMMONPLACE_DEFAULT_LIMIT', () => {
  const binPath = readBinPath();
  let memoryDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(() => {
    const res = spawnSync('make', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: '1' },
    });
    if (res.status !== 0) {
      throw new Error(`make build failed: ${res.stderr || res.stdout}`);
    }
    if (!existsSync(binPath)) {
      throw new Error(`bin not found after build: ${binPath}`);
    }
  }, 200_000);

  beforeEach(async () => {
    memoryDir = mkdtempSync(join(tmpdir(), 'dar913-bin-int-'));
    transport = new StdioClientTransport({
      command: 'node',
      args: [binPath],
      env: {
        ...process.env,
        COMMONPLACE_USER_DIR: memoryDir,
        COMMONPLACE_DEFAULT_LIMIT: '2',
      } as Record<string, string>,
      stderr: 'inherit',
    });
    client = new Client({ name: 'dar913-bin-int', version: '0.0.0' });
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // best-effort cleanup
    }
    rmSync(memoryDir, { recursive: true, force: true });
  });

  it("spawned commonplace-mcp bin with env.COMMONPLACE_DEFAULT_LIMIT='2' returns at most 2 hits for a memory_search request that omits limit", async () => {
    // Save four memories so the corpus has more than the env-resolved
    // default. If the env var is honoured, memory_search should slice to
    // 2; if it's ignored, we'd see up to 4 (or the built-in 5).
    for (let i = 0; i < 4; i++) {
      const save = await client.callTool({
        name: 'memory_save',
        arguments: {
          name: `dar913_entry_${i}`,
          type: 'reference',
          description: `entry ${i}`,
          body: `body ${i} -- lorem ipsum dolor sit amet.`,
        },
      });
      expect(save.isError).toBeFalsy();
    }

    const search = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'lorem ipsum' },
    });
    expect(search.isError).toBeFalsy();
    const text = firstTextContent(search.content);
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || !Array.isArray(parsed.matches)) {
      throw new Error(`memory_search payload missing matches[]: ${text}`);
    }
    expect(parsed.matches.length).toBeLessThanOrEqual(2);
    // With four entries in the corpus the env-resolved limit (2) is the
    // active slice; we expect exactly 2 hits.
    expect(parsed.matches.length).toBe(2);
  }, 180_000);
});

describe('DAR-930 bin integration: spawned bin exercises one-hop expansion through the real graph', () => {
  const binPath = readBinPath();
  let memoryDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(() => {
    const res = spawnSync('make', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: '1' },
    });
    if (res.status !== 0) {
      throw new Error(`make build failed: ${res.stderr || res.stdout}`);
    }
    if (!existsSync(binPath)) {
      throw new Error(`bin not found after build: ${binPath}`);
    }
  }, 200_000);

  beforeEach(async () => {
    memoryDir = mkdtempSync(join(tmpdir(), 'dar930-bin-int-'));
    transport = new StdioClientTransport({
      command: 'node',
      args: [binPath],
      env: {
        ...process.env,
        COMMONPLACE_USER_DIR: memoryDir,
      } as Record<string, string>,
      stderr: 'inherit',
    });
    client = new Client({ name: 'dar930-bin-int', version: '0.0.0' });
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // best-effort cleanup
    }
    rmSync(memoryDir, { recursive: true, force: true });
  });

  /**
   * Seed a hub graph through the spawned bin's tool surface: hub `H` plus
   * two neighbors `N1`/`N2`, then memory_link N1 and N2 to H with
   * 'builds-on'. The bodies are engineered so a search for the hub's body
   * lands H as the top direct hit; the neighbors' bodies use different
   * topics so a tight threshold can filter them out as direct hits and
   * force them through expansion.
   */
  const seedHub = async (): Promise<void> => {
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'expand_hub',
        type: 'reference',
        description: 'central hub memory about lattice topology',
        body: 'The lattice topology section describes adjacency invariants for a periodic crystal structure.',
      },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'expand_neighbor_one',
        type: 'reference',
        description: 'unrelated topic about marine biology',
        body: 'Cephalopod nervous systems use distributed ganglia rather than a centralised brain.',
      },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'expand_neighbor_two',
        type: 'reference',
        description: 'another unrelated topic about culinary chemistry',
        body: 'The Maillard reaction is responsible for the browning of seared meats and toasted bread.',
      },
    });
    // Wire the graph: N1 and N2 build-on H. Edges live on the SOURCE
    // memory's frontmatter; we author them on the neighbors so a query
    // landing on H expands through H's INBOUND edges? -- actually the
    // expansion contract uses OUTBOUND edges. So we link H -> N1 and
    // H -> N2 (the hub is the source authoring the edges).
    await client.callTool({
      name: 'memory_link',
      arguments: { from: 'expand_hub', to: 'expand_neighbor_one', type: 'builds-on' },
    });
    await client.callTool({
      name: 'memory_link',
      arguments: { from: 'expand_hub', to: 'expand_neighbor_two', type: 'builds-on' },
    });
  };

  it("spawned-bin test saves three memories (hub H + neighbors N1, N2) via memory_save, links N1 and N2 to H via memory_link with type 'builds-on', then issues a memory_search call with `expand: 'one-hop'` whose query is engineered to land on H -- the response matches array contains H plus N1 and N2, each neighbor carrying a `via.source === 'H'`", async () => {
    await seedHub();

    // Query strongly aligned with H's body; threshold gates the two
    // neighbors out of direct hits so they can only reach the response
    // through one-hop expansion.
    const search = await client.callTool({
      name: 'memory_search',
      arguments: {
        query: 'lattice topology adjacency invariants for a periodic crystal',
        expand: 'one-hop',
        threshold: 0.5,
        limit: 5,
      },
    });
    expect(search.isError).toBeFalsy();
    const text = firstTextContent(search.content);
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || !Array.isArray(parsed.matches)) {
      throw new Error(`memory_search payload missing matches[]: ${text}`);
    }
    const matches = parsed.matches as Array<{ name: string; via?: { source: string } }>;
    const names = matches.map((m) => m.name);
    expect(names).toContain('expand_hub');
    expect(names).toContain('expand_neighbor_one');
    expect(names).toContain('expand_neighbor_two');
    const n1 = matches.find((m) => m.name === 'expand_neighbor_one');
    const n2 = matches.find((m) => m.name === 'expand_neighbor_two');
    expect(n1?.via?.source).toBe('expand_hub');
    expect(n2?.via?.source).toBe('expand_hub');
  }, 180_000);

  it("the same spawned-bin scenario with `expand` omitted returns ONLY H in the top matches (no N1/N2), confirming the bin's wired-in MemoryGraph is consulted only on opt-in", async () => {
    await seedHub();

    const search = await client.callTool({
      name: 'memory_search',
      arguments: {
        query: 'lattice topology adjacency invariants for a periodic crystal',
        threshold: 0.5,
        limit: 5,
      },
    });
    expect(search.isError).toBeFalsy();
    const text = firstTextContent(search.content);
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || !Array.isArray(parsed.matches)) {
      throw new Error(`memory_search payload missing matches[]: ${text}`);
    }
    const matches = parsed.matches as Array<{ name: string; via?: { source: string } }>;
    const names = matches.map((m) => m.name);
    expect(names).toContain('expand_hub');
    expect(names).not.toContain('expand_neighbor_one');
    expect(names).not.toContain('expand_neighbor_two');
    // And no entry should carry a `via` field when expand is omitted.
    for (const m of matches) {
      expect(m.via).toBeUndefined();
    }
  }, 180_000);
});
