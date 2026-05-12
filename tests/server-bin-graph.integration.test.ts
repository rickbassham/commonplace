/**
 * DAR-932 ac-7 spawned-bin integration: end-to-end coverage for
 * `memory_graph` and `memory_path` against the real bin and its real
 * MemoryGraph instance. This proves the boot path wires both per-scope
 * graphs into the new handler factories so the running server can serve
 * traversal queries -- a missing wire-up would surface as
 * UnknownToolError, 'not implemented', or empty traversal results despite
 * memory_link having succeeded.
 *
 * Slow on purpose: pays the real Embedder cold-start price.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(__dirname, '..');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function readBinPath(): string {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (!isObject(raw)) throw new Error('package.json is not an object');
  const bin = raw.bin;
  if (!isObject(bin)) throw new Error('package.json bin is not an object');
  const entry = bin['commonplace-mcp'];
  if (typeof entry !== 'string') throw new Error('bin.commonplace-mcp missing');
  return join(repoRoot, entry);
}

/**
 * The CallToolResult shape returned by the SDK client carries a `content`
 * array of `{ type: 'text', text: string }` blocks. The handlers JSON-encode
 * their responses; the bin's CallTool wrapper writes that JSON into the
 * first text block. This helper decodes it for assertions.
 */
const parseToolResultJson = (result: unknown): unknown => {
  if (!isObject(result)) throw new Error('tool result is not an object');
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`tool result has no content blocks: ${JSON.stringify(result)}`);
  }
  const first = content[0];
  if (!isObject(first) || typeof first.text !== 'string') {
    throw new Error(`tool result content[0] is not a text block: ${JSON.stringify(first)}`);
  }
  return JSON.parse(first.text);
};

describe('DAR-932 bin integration: memory_graph and memory_path end-to-end', () => {
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
    memoryDir = mkdtempSync(join(tmpdir(), 'dar932-bin-int-'));
    transport = new StdioClientTransport({
      command: 'node',
      args: [binPath],
      env: {
        ...process.env,
        COMMONPLACE_MEMORY_DIR: memoryDir,
      } as Record<string, string>,
      stderr: 'inherit',
    });
    client = new Client({ name: 'dar932-bin-int', version: '0.0.0' });
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

  it("save A and B, call memory_link({from:A, to:B}), then call memory_graph({name:A, depth:1}) and assert nodes contains B and edges contains {from:A, to:B, type:'related-to'} (proves the bin's MemoryGraph is wired into the handler)", async () => {
    await client.callTool({
      name: 'memory_save',
      arguments: { name: 'alpha', type: 'reference', description: 'a', body: 'A body' },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: { name: 'beta', type: 'reference', description: 'b', body: 'B body' },
    });
    const linked = await client.callTool({
      name: 'memory_link',
      arguments: { from: 'alpha', to: 'beta' },
    });
    expect(linked.isError).toBeFalsy();

    const result = await client.callTool({
      name: 'memory_graph',
      arguments: { name: 'alpha', depth: 1 },
    });
    expect(result.isError).toBeFalsy();
    const decoded = parseToolResultJson(result) as {
      nodes: { name: string }[];
      edges: { from: string; to: string; type: string }[];
    };
    const nodeNames = decoded.nodes.map((n) => n.name);
    expect(nodeNames).toContain('beta');
    expect(decoded.edges).toContainEqual({ from: 'alpha', to: 'beta', type: 'related-to' });
  }, 120_000);

  it("with A linked to B via memory_link, call memory_path({from:A, to:B}) and assert path is [{from:A, to:B, type:'related-to'}]", async () => {
    await client.callTool({
      name: 'memory_save',
      arguments: { name: 'alpha', type: 'reference', description: 'a', body: 'A body' },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: { name: 'beta', type: 'reference', description: 'b', body: 'B body' },
    });
    await client.callTool({
      name: 'memory_link',
      arguments: { from: 'alpha', to: 'beta' },
    });

    const result = await client.callTool({
      name: 'memory_path',
      arguments: { from: 'alpha', to: 'beta' },
    });
    expect(result.isError).toBeFalsy();
    const decoded = parseToolResultJson(result) as {
      path: { from: string; to: string; type: string }[] | null;
    };
    expect(decoded.path).toEqual([{ from: 'alpha', to: 'beta', type: 'related-to' }]);
  }, 120_000);

  it("call memory_path({from:A, to:<nonexistent_but_saved_memory_C>}) where C exists as a memory but no path connects A to C, assert response is { path: null, reason: 'unreachable' }", async () => {
    await client.callTool({
      name: 'memory_save',
      arguments: { name: 'alpha', type: 'reference', description: 'a', body: 'A body' },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: { name: 'gamma', type: 'reference', description: 'c', body: 'C body' },
    });

    const result = await client.callTool({
      name: 'memory_path',
      arguments: { from: 'alpha', to: 'gamma' },
    });
    expect(result.isError).toBeFalsy();
    const decoded = parseToolResultJson(result) as {
      path: unknown;
      reason?: string;
    };
    expect(decoded.path).toBeNull();
    expect(decoded.reason).toBe('unreachable');
  }, 120_000);
});
