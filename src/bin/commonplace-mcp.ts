#!/usr/bin/env node
/**
 * Bin entry: launches the commonplace MCP server on stdio with layered
 * user + project memory stores wired into the CRUD tool handlers.
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
 * # Environment variables
 *
 *   COMMONPLACE_USER_DIR        user-level memory dir (DAR-924)
 *                               (default: ~/.commonplace/memory)
 *   COMMONPLACE_PROJECT_DIR     project-level memory dir (DAR-924); explicit
 *                               override for env > roots > cwd > none
 *   COMMONPLACE_MEMORY_DIR      deprecated alias for COMMONPLACE_USER_DIR
 *                               (DAR-924); stderr deprecation warning on use
 *   COMMONPLACE_MODEL           embedding model id passed to transformers.js
 *                               (DAR-913); default Xenova/bge-base-en-v1.5
 *   COMMONPLACE_DEFAULT_LIMIT   default top-k for memory_search when the
 *                               caller omits `limit` (DAR-913); default 5,
 *                               must be a positive integer
 *   COMMONPLACE_EXPANSION_DECAY multiplicative score for one-hop graph
 *                               expanded neighbors in memory_search
 *                               (DAR-930); default 0.7, must be in (0, 1]
 *   COMMONPLACE_CONNECTEDNESS_BOOST  alpha for the additive
 *                               `alpha * log(1 + inbound_count)`
 *                               connectedness boost in memory_search
 *                               ranking (DAR-931); default 0.02, must be
 *                               a finite non-negative number (0 disables)
 *
 * # Detection priority for the project store
 *
 *   1. COMMONPLACE_PROJECT_DIR (explicit override; always wins)
 *   2. MCP `roots/list` response after init -- first file:// root resolves
 *      to `<root>/.commonplace/memory`
 *   3. process.cwd() -- if `<cwd>/.commonplace/memory` exists, use it
 *   4. None of the above -- user-only mode (no project store)
 *
 * The bin itself is a thin shell over {@link bootServer}: it constructs a
 * StdioServerTransport, hands it to bootServer, and exits on any boot
 * failure with a stderr message + non-zero exit. All wiring (scope
 * detection, store construction, roots/list, handler binding) lives in
 * `./boot.ts` so the spawned-bin's behaviour can be unit tested without
 * paying the cold-start cost of a real model load.
 *
 * The server reads JSON-RPC framed MCP traffic from stdin and writes
 * responses to stdout. Stdout MUST stay reserved for MCP framing per the
 * protocol; we deliberately log nothing here. Boot failures go to stderr
 * with a non-zero exit so callers (e.g. Claude Code's mcp manager) notice.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { bootServer } from './boot.js';

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await bootServer({
    env: process.env,
    cwd: process.cwd(),
    transport,
  });
  // The transport keeps the process alive via its stdin reader. When stdin
  // closes (the client disconnects), the transport ends and the process
  // exits naturally. The boot result is intentionally unused beyond this
  // point -- the server, stores, and graphs are owned by the boot module
  // and live as long as the process.
}

main().catch((err: unknown) => {
  process.stderr.write(
    `commonplace-mcp: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
