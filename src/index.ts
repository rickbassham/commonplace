#!/usr/bin/env node
/**
 * Bin entry: the `commonplace` CLI dispatcher (DAR-918, extended by DAR-961).
 *
 * Subcommand surface (single source of truth: `USAGE` in
 * `src/cli/migrate.ts`):
 *
 *   `commonplace migrate`                      (detect known external memory sources)
 *   `commonplace migrate --from <source>`      (import from a known source; --dry-run / --auto supported)
 *   `commonplace migrate <dir>`                (rebuild sidecars for an existing memory dir;
 *                                              --dry-run / --prune-dangling supported)
 *
 * The legacy DAR-918 path (rebuild sidecars for an existing dir) and the
 * DAR-961 detection / import paths share this dispatcher; the bare-bin
 * usage message and the parser usage_error message are rendered from the
 * same exported `USAGE` constant so the two cannot drift.
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
import { migrateMain, parseMigrateArgs, USAGE } from './cli/migrate.js';
import { graphMain } from './cli/graph.js';
import { resolveModelId } from './bin/env.js';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    // Use the same canonical USAGE constant the parser renders on
    // usage_error, so the bare-bin first impression matches the
    // parser-error message verbatim (DAR-961 review f-1, extended by
    // DAR-933 to include the graph subcommand).
    process.stderr.write(`commonplace: missing subcommand.\n${USAGE}\n`);
    return 2;
  }

  // DAR-933: dispatch the `graph` subcommand to its own main entry. The
  // dispatch happens BEFORE `parseMigrateArgs` so `graph` is not reported
  // as an "unknown subcommand" by the migrate parser.
  if (argv[0] === 'graph') {
    const result = await graphMain({
      argv,
      embedderFactory: () => new Embedder(resolveModelId(process.env)),
      stdout: (chunk: string) => process.stdout.write(chunk),
      stderr: (chunk: string) => process.stderr.write(chunk),
      env: process.env,
      cwd: process.cwd(),
    });
    return result.exitCode;
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
    env: process.env,
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
