#!/usr/bin/env node
/**
 * Bin entry: launches the commonplace MCP server on stdio with a live
 * `Embedder` and `MemoryStore` wired into the CRUD tool handlers.
 *
 * Usage (after `make build`):
 *   node dist/bin/commonplace-mcp.js
 *
 * Or via the bin entry declared in `package.json`:
 *   pnpm exec commonplace-mcp
 *
 * For Claude Code:
 *   claude mcp add commonplace ./dist/bin/commonplace-mcp.js
 *
 * Environment variables (minimal subset; DAR-913 owns the full matrix):
 *   COMMONPLACE_MEMORY_DIR   override the on-disk memory directory
 *
 * The server reads JSON-RPC framed MCP traffic from stdin and writes
 * responses to stdout. Stdout MUST stay reserved for MCP framing per the
 * protocol; we deliberately log nothing here. Boot failures go to stderr
 * with a non-zero exit so callers (e.g. Claude Code's mcp manager) notice.
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Embedder } from '../embedder/index.js';
import { createServer } from '../server/server.js';
import { createDefaultHandlers } from '../server/tools.js';
import { MemoryStore } from '../store/memory-store.js';

const DEFAULT_MODEL_ID = 'Xenova/bge-base-en-v1.5';

const defaultMemoryDir = (): string => join(homedir(), '.commonplace', 'memory');

async function main(): Promise<void> {
  const memoryDir = process.env.COMMONPLACE_MEMORY_DIR ?? defaultMemoryDir();
  // mkdir -p is a no-op when the dir already exists; first-run users get
  // the dir created for them so save() does not surprise them with ENOENT.
  await mkdir(memoryDir, { recursive: true });

  const embedder = new Embedder(DEFAULT_MODEL_ID);
  const store = new MemoryStore({ dir: memoryDir, embedder });
  // Load any existing memories before accepting traffic. Cold-start cost
  // is the embedder's first-call price (~6s for bge-base) plus one I/O
  // pass over the directory.
  await store.scan();

  const handlers = createDefaultHandlers({ store });
  const server = createServer({ handlers });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive via its stdin reader. When stdin
  // closes (the client disconnects), the transport ends and the process
  // exits naturally.
}

main().catch((err) => {
  process.stderr.write(
    `commonplace-mcp: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
