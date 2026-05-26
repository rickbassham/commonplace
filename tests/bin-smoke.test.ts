/**
 * MCP-boot smoke test: spawn the bin ENTRYPOINT
 * (`src/bin/commonplace-mcp.ts`) via `node --import <tsx-loader>` -- NOT the
 * compiled (built) output -- over real MCP stdio framing, with a real
 * Embedder and a fresh tmp memory dir.
 *
 * This is the single subprocess spawner in the suite. It preserves the
 * unique value the old spawned-built-bin tests carried -- proof that the
 * entrypoint boots, registers every tool over real stdio MCP framing, and
 * wires Embedder + MemoryStore end-to-end -- while never depending on a
 * build step or any compiled artefact. The behaviour of each individual
 * handler (search expansion, connectedness boost, scope routing, graph,
 * link, etc.) is covered in-process against the handler/store; this test
 * only proves the entrypoint glue.
 *
 * The model cache is pre-warmed by `tests/global-setup.ts`, so the real
 * embedder load is fast. Per-test timeouts are generous because the boot
 * still re-reads the cached model artefacts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TOOL_NAMES } from '../src/server/tools.js';

const repoRoot = join(__dirname, '..');
const binEntry = join(repoRoot, 'src/bin/commonplace-mcp.ts');

// Resolve the `tsx` ESM loader from THIS repo's dependency tree. The child
// process is spawned with cwd set to a per-test tmp dir (for project-store
// isolation), so a bare `--import tsx` specifier would fail to resolve from
// that cwd. Passing the absolute loader path as a file:// URL lets
// `node --import` find it regardless of cwd, and keeps the test pinned to
// the project's own tsx devDependency rather than any global install.
const tsxLoaderUrl = pathToFileURL(
  createRequire(join(repoRoot, 'package.json')).resolve('tsx'),
).href;

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

describe('bin smoke: spawned src entrypoint over real stdio MCP', () => {
  let memoryDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeEach(async () => {
    memoryDir = mkdtempSync(join(tmpdir(), 'bin-smoke-'));
    transport = new StdioClientTransport({
      // `node --import <tsx-loader> <src-path>` runs the TypeScript
      // entrypoint directly, so the test never depends on a build step or
      // any compiled artefact.
      command: 'node',
      args: ['--import', tsxLoaderUrl, binEntry],
      env: {
        ...process.env,
        COMMONPLACE_USER_DIR: memoryDir,
        // The npm-registry update check would make a network call on boot;
        // disable it so the smoke test stays hermetic.
        COMMONPLACE_NO_UPDATE_CHECK: '1',
      } as Record<string, string>,
      // Inherit stderr so a boot failure (e.g. an import error in the src
      // entrypoint) is visible in test output; stdin/stdout are owned by
      // the transport for MCP framing.
      stderr: 'inherit',
      // cwd is the per-test tmpdir so the bin's cwd-based project-store
      // detection does not pick up the repo's own committed
      // `.commonplace/memory/` project memories.
      cwd: memoryDir,
    });
    client = new Client({ name: 'bin-smoke', version: '0.0.0' });
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

  it('listTools returns the full expected tool set (entrypoint boots and registers handlers over real stdio MCP framing)', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  }, 60_000);

  it('round-trips memory_save -> memory_list -> memory_delete through the real Embedder + MemoryStore wired by the entrypoint', async () => {
    // memory_save: write a real memory, embed it via the real model, fsync
    // sidecar.
    const saveResult = await client.callTool({
      name: 'memory_save',
      arguments: {
        name: 'smoke_marker',
        type: 'reference',
        description: 'bin smoke sentinel.',
        body: 'This memory is created by the bin-smoke test to verify end-to-end wiring.',
        scope: 'user',
      },
    });
    expect(saveResult.isError).toBeFalsy();

    // The .md and .embedding files MUST be on disk after save returns.
    const filesAfterSave = readdirSync(memoryDir).sort();
    expect(filesAfterSave).toEqual(['smoke_marker.embedding', 'smoke_marker.md'].sort());

    // memory_list: the new memory must appear with the right fields.
    const listResult = await client.callTool({ name: 'memory_list', arguments: {} });
    expect(listResult.isError).toBeFalsy();
    const listText = firstTextContent(listResult.content);
    const listed: unknown = JSON.parse(listText);
    if (!isObject(listed) || !Array.isArray(listed.memories)) {
      throw new Error(`memory_list payload missing memories[]: ${JSON.stringify(listed)}`);
    }
    const entries = listed.memories as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('smoke_marker');
    expect(entries[0]?.type).toBe('reference');

    // memory_delete: removing the entry takes both files off disk.
    const deleteResult = await client.callTool({
      name: 'memory_delete',
      arguments: { name: 'smoke_marker' },
    });
    expect(deleteResult.isError).toBeFalsy();
    expect(existsSync(join(memoryDir, 'smoke_marker.md'))).toBe(false);
    expect(existsSync(join(memoryDir, 'smoke_marker.embedding'))).toBe(false);
    expect(readdirSync(memoryDir)).toEqual([]);

    // Final memory_list confirms emptiness.
    const finalList = await client.callTool({ name: 'memory_list', arguments: {} });
    expect(finalList.isError).toBeFalsy();
    const finalListed: unknown = JSON.parse(firstTextContent(finalList.content));
    if (!isObject(finalListed) || !Array.isArray(finalListed.memories)) {
      throw new Error(`memory_list payload missing memories[]: ${JSON.stringify(finalListed)}`);
    }
    expect(finalListed.memories).toEqual([]);
  }, 120_000);
});
