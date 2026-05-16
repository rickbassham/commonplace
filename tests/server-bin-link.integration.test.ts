/**
 * Bin integration test: spawn the built `commonplace-mcp` bin and
 * exercise memory_link / memory_unlink end-to-end via real MCP stdio
 * framing. This proves:
 *
 *   - ac-5: the bin instantiates a `MemoryGraph`, wires it into both the
 *     store and the handler map, and the running server's graph is
 *     populated by `scan` / `save` (verified by linking between two
 *     memory_save'd entries -- a missing graph or a graph not populated by
 *     save would surface as "target memory does not exist").
 *   - ac-6: round trip save A, save B, link A->B, hand-inspect A.md to
 *     verify the edge appears with valid YAML, then unlink and confirm the
 *     edge is gone and frontmatter is still valid YAML.
 *
 * Slow on purpose -- pays the real Embedder cold-start price.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { readMemory } from '../src/store/memory.js';

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

describe('bin integration: spawned bin with MemoryGraph wired in', () => {
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
    memoryDir = mkdtempSync(join(tmpdir(), 'dar928-bin-int-'));
    transport = new StdioClientTransport({
      command: 'node',
      args: [binPath],
      env: {
        ...process.env,
        COMMONPLACE_MEMORY_DIR: memoryDir,
      } as Record<string, string>,
      stderr: 'inherit',
    });
    client = new Client({ name: 'dar928-bin-int', version: '0.0.0' });
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
    // Per-test transport cleanup is handled in afterEach.
  });

  it("ac-5: after spawning the built bin and calling memory_save twice, the running server's graph reflects the saved entries -- verified by calling memory_link between them and observing success (would fail with 'target memory does not exist' if graph were not populated by scan/save)", async () => {
    const saveA = await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'alpha',
        type: 'reference',
        description: 'a',
        body: 'A body',
        scope: 'user',
      },
    });
    expect(saveA.isError).toBeFalsy();
    const saveB = await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'beta',
        type: 'reference',
        description: 'b',
        body: 'B body',
        scope: 'user',
      },
    });
    expect(saveB.isError).toBeFalsy();

    const link = await client.callTool({
      name: 'memory_link',
      arguments: { from: 'alpha', to: 'beta' },
    });
    expect(link.isError).toBeFalsy();
  }, 120_000);

  it('ac-6: spawned-bin integration: save memory A, save memory B, call memory_link({from:A, to:B}), then read A.md from disk and assert relations[] contains {to:B, type:"related-to"} and frontmatter parses as valid YAML', async () => {
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'alpha',
        type: 'reference',
        description: 'a',
        body: 'A body',
        scope: 'user',
      },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'beta',
        type: 'reference',
        description: 'b',
        body: 'B body',
        scope: 'user',
      },
    });
    const link = await client.callTool({
      name: 'memory_link',
      arguments: { from: 'alpha', to: 'beta' },
    });
    expect(link.isError).toBeFalsy();

    // Read the .md from disk and assert YAML is valid.
    const onDisk = readMemory(join(memoryDir, 'alpha.md'));
    expect(onDisk.relations).toEqual([{ to: 'beta', type: 'related-to' }]);
    expect(onDisk.supersedes).toEqual([]);
  }, 120_000);

  it('ac-6: spawned-bin integration: after link, call memory_unlink({from:A, to:B}), then read A.md from disk and assert relations[] no longer contains the edge and frontmatter still parses as valid YAML', async () => {
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'alpha',
        type: 'reference',
        description: 'a',
        body: 'A body',
        scope: 'user',
      },
    });
    await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'beta',
        type: 'reference',
        description: 'b',
        body: 'B body',
        scope: 'user',
      },
    });
    await client.callTool({
      name: 'memory_link',
      arguments: { from: 'alpha', to: 'beta' },
    });
    const unlink = await client.callTool({
      name: 'memory_unlink',
      arguments: { from: 'alpha', to: 'beta' },
    });
    expect(unlink.isError).toBeFalsy();

    const onDisk = readMemory(join(memoryDir, 'alpha.md'));
    expect(onDisk.relations).toEqual([]);
    expect(onDisk.supersedes).toEqual([]);
  }, 120_000);
});
