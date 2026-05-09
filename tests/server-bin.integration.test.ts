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
