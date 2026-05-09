#!/usr/bin/env node
/**
 * Bin entry: the `commonplace` CLI dispatcher (DAR-918).
 *
 * Currently exposes a single subcommand:
 *
 *   `commonplace migrate <dir> [--dry-run] [--prune-dangling]`
 *
 * Scans an existing memory directory of `.md` files and (re)builds embedding
 * sidecars, cleans up orphaned `.embedding` files, and optionally prunes
 * dangling graph edges. Useful for bootstrapping from existing markdown
 * memory without forcing a server restart, and for one-shot rescue runs
 * when the on-disk index has drifted from the source `.md` files.
 *
 * # Bin convention
 *
 * `package.json` declares two bin entries:
 *
 *   - `commonplace`     -> `dist/index.js` (this file). Hosts the CLI
 *     subcommand surface (`migrate ...`). Stdout is human-readable.
 *   - `commonplace-mcp` -> `dist/bin/commonplace-mcp.js`. The stdio MCP
 *     server. Stdout is reserved for JSON-RPC framing.
 *
 * The two bins are deliberately split so the MCP server's framing channel
 * is never polluted by CLI output. Adding new subcommands (e.g. a future
 * `commonplace graph` per DAR-933) extends THIS file; the MCP bin stays
 * single-purpose.
 *
 * Running with no arguments prints a usage message to stderr and exits
 * non-zero so an operator who runs `commonplace` by mistake learns the
 * correct invocation.
 */

import { Embedder } from './embedder/index.js';
import { migrateMain, parseMigrateArgs } from './cli/migrate.js';
import { resolveModelId } from './bin/env.js';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write(
      'commonplace: missing subcommand. Usage: commonplace migrate <dir> [--dry-run] [--prune-dangling]\n',
    );
    return 2;
  }

  // Peek at the first token so unknown subcommands are reported with a
  // crisp error before we construct an embedder (which on the production
  // path triggers a transformers.js model load on first embed call).
  const peek = parseMigrateArgs(argv);
  if (peek.kind === 'unknown_subcommand') {
    process.stderr.write(`${peek.message}\n`);
    return 2;
  }

  const result = await migrateMain({
    argv,
    // Lazy embedder factory: only constructed when migrateMain decides to
    // run (i.e. argv parses cleanly and the dir exists). The Embedder
    // constructor is cheap; the model load happens on the first embed()
    // call from within scan().
    embedderFactory: () => new Embedder(resolveModelId(process.env)),
    stdout: (chunk: string) => process.stdout.write(chunk),
    stderr: (chunk: string) => process.stderr.write(chunk),
  });
  return result.exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `commonplace: unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
