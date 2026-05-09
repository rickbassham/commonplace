#!/usr/bin/env node
/**
 * Bin entry: launches the commonplace MCP server on stdio.
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
 * The server reads JSON-RPC framed MCP traffic from stdin and writes
 * responses to stdout. Stdout MUST stay reserved for MCP framing per the
 * protocol; we deliberately log nothing here. Stderr is unused by the
 * shell -- observability lives in a later issue.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server/server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server will keep the process alive via its stdin reader. When stdin
  // closes (the client disconnects), the transport ends and the process
  // exits naturally.
}

main().catch((err) => {
  // Last-resort failure during boot. Write to stderr -- never stdout --
  // and exit non-zero so callers (e.g. Claude Code's mcp manager) notice.
  process.stderr.write(
    `commonplace-mcp: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
