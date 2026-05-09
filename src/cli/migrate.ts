/**
 * Migration CLI (DAR-918) — extends the DAR-926 `--prune-dangling` slice
 * into the full one-shot migrate command exposed by the `commonplace` bin.
 *
 * # Behaviour
 *
 *   `commonplace migrate <dir> [--dry-run] [--prune-dangling]`
 *
 * The CLI scans an existing memory directory of `.md` files and:
 *
 *   1. Embeds any `.md` whose `.embedding` sidecar is missing.
 *   2. Re-embeds any `.md` whose sidecar is stale (contentSha / modelId /
 *      dim mismatch) or corrupt.
 *   3. Removes any `.embedding` file whose matching `<name>.md` is gone
 *      (orphan cleanup).
 *   4. When `--prune-dangling` is set, rewrites each `.md` whose
 *      `relations[]` or `supersedes[]` references a name that does not
 *      resolve to any loaded memory, dropping the dangling entries (the
 *      DAR-926 behaviour, preserved verbatim).
 *
 * The embed pass routes through {@link MemoryStore.scan}: there is exactly
 * one embed code path in the codebase, and the migrate CLI is a wrapper
 * around it that surfaces the per-category counts. Adding `dryRun` plumbed
 * the same field through `scan()` rather than forking a parallel embed
 * loop.
 *
 * Reports a per-category summary on exit:
 *
 * ```
 * commonplace migrate <dir>
 *   loaded:       3 unchanged
 *   embedded:     5 new sidecars
 *   re-embedded:  1 stale sidecar
 *   orphaned:     0 sidecars without matching .md (cleaned up)
 * ```
 *
 * # Bin entry convention (AC-7)
 *
 * The CLI is exposed via the existing `commonplace` bin entry
 * (`package.json` -> `bin.commonplace = dist/index.js`). The bin handles
 * exactly one subcommand today, `migrate <dir>`, and dispatches to
 * {@link runMigrate} via {@link parseMigrateArgs} + {@link migrateMain}.
 * The sibling `commonplace-mcp` bin remains the stdio MCP server entry --
 * we deliberately did NOT overload `commonplace-mcp` with subcommands so
 * the MCP-server bin's stdout stays reserved for JSON-RPC framing.
 *
 * # Atomicity
 *
 * `--prune-dangling` writes each affected `.md` through `writeFileSync`.
 * Crash-safe atomic write-temp+rename / fsync semantics are owned by
 * DAR-923 and apply transitively to the embed pass via
 * {@link MemoryStore.scan}'s use of `atomicWrite`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryGraph, type DanglingEdge } from '../store/graph.js';
import { readMemory, writeMemory, type Relation } from '../store/memory.js';
import { MemoryStore, type Embedder } from '../store/memory-store.js';

/** Inputs to {@link runMigrate}. */
export interface MigrateOptions {
  /** Directory containing memory `.md` files. */
  dir: string;
  /** Embedder used to (re)compute sidecars during the underlying scan. */
  embedder: Embedder;
  /**
   * When true, rewrite each `.md` whose `relations[]` or `supersedes[]`
   * references a name that does not resolve to a loaded memory, removing
   * the dangling entries.
   */
  pruneDangling: boolean;
  /**
   * When true, report what runMigrate WOULD do without writing any
   * sidecars, removing any orphan `.embedding` files, or rewriting any
   * `.md` (the prune pass is also short-circuited so dangling .md files
   * are reported but left byte-identical on disk).
   *
   * Defaults to false.
   */
  dryRun?: boolean;
}

/** Per-file summary of edges removed by `--prune-dangling`. */
export interface PrunedFile {
  /** Memory name (also the basename of the `.md`). */
  name: string;
  /** Total number of dangling entries removed from this file. */
  edgesPruned: number;
}

/** Result of a single migrate run. */
export interface MigrateResult {
  /** Total memories indexed by the underlying scan after this run. */
  loaded: number;
  /**
   * Number of `.md` files for which a NEW sidecar was created (no prior
   * `.embedding` existed).
   */
  embedded: number;
  /**
   * Number of `.md` files whose existing sidecar was stale or corrupt and
   * was rewritten.
   */
  reembedded: number;
  /**
   * Number of `.embedding` files removed because no matching `.md` existed.
   * In dry-run mode this is the count of files that WOULD have been
   * removed.
   */
  orphaned: number;
  /** One entry per .md that had dangling edges pruned. Empty when nothing to prune. */
  pruned: PrunedFile[];
}

/**
 * Programmatic entry point used by tests and the bin shim. The thin
 * argv-parsing wrapper {@link migrateMain} calls this after argument
 * normalisation.
 */
export const runMigrate = async (opts: MigrateOptions): Promise<MigrateResult> => {
  const dryRun = opts.dryRun === true;
  // The store does not need a graph for the embed/orphan pass -- the
  // graph is only required for dangling-edge detection during the prune
  // pass. Skipping it here also avoids a subtle dry-run hazard: the store
  // populates the graph from `scan()`'s `next` array, but in dry-run mode
  // missing-sidecar entries are absent from `next` (no vector to attach),
  // so a graph wired through the store would miss them in the dangling
  // walk. Building the prune graph from `.md` files directly below
  // sidesteps that gap.
  const store = new MemoryStore({ dir: opts.dir, embedder: opts.embedder });
  const scan = await store.scan({ dryRun });

  const pruned: PrunedFile[] = [];
  if (opts.pruneDangling) {
    // Build a fresh graph from the on-disk .md files so dangling-edge
    // detection works in both dry-run and live modes. This re-reads the
    // .md frontmatter (already parsed once by scan); the duplication is
    // intentional to keep the prune pass independent of scan()'s
    // vector-population side effects.
    const pruneGraph = new MemoryGraph({ onDangling: () => {} });
    const pruneEntries = listMemoriesFromDisk(opts.dir);
    pruneGraph.rebuild(pruneEntries);
    const dangling = pruneGraph.detectDangling();
    if (dangling.length > 0) {
      const byFrom = groupByFrom(dangling);
      for (const [name, edges] of byFrom) {
        const mdPath = join(opts.dir, `${name}.md`);
        const memory = readMemory(mdPath);
        const danglingTargets = new Set<string>();
        for (const edge of edges) {
          danglingTargets.add(`${edge.to}|${edge.type}`);
        }
        const filteredRelations: Relation[] = memory.relations.filter(
          (rel) => !danglingTargets.has(`${rel.to}|${rel.type}`),
        );
        const filteredSupersedes: string[] = memory.supersedes.filter(
          (sup) => !danglingTargets.has(`${sup}|supersedes`),
        );
        const removed =
          memory.relations.length -
          filteredRelations.length +
          (memory.supersedes.length - filteredSupersedes.length);
        if (removed === 0) continue;

        if (!dryRun) {
          writeMemory(mdPath, {
            name: memory.name,
            description: memory.description,
            type: memory.type,
            body: memory.body,
            relations: filteredRelations,
            supersedes: filteredSupersedes,
          });
        }
        pruned.push({ name, edgesPruned: removed });
      }
    }
  }

  return {
    loaded: scan.loaded,
    embedded: scan.embedded,
    reembedded: scan.staleReembedded,
    orphaned: scan.orphaned,
    pruned,
  };
};

/**
 * Read every `<dir>/*.md` from disk and return a minimal graph-input
 * shape (name + relations + supersedes). Used by the prune pass so
 * dangling-edge detection works regardless of whether scan() populated
 * its in-memory entry array (which dry-run mode partially skips).
 */
const listMemoriesFromDisk = (
  dir: string,
): { name: string; relations: Relation[]; supersedes: string[] }[] => {
  if (!existsSync(dir)) return [];
  const out: { name: string; relations: Relation[]; supersedes: string[] }[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.md')) continue;
    const memory = readMemory(join(dir, ent.name));
    out.push({
      name: memory.name,
      relations: memory.relations,
      supersedes: memory.supersedes,
    });
  }
  return out;
};

const groupByFrom = (edges: DanglingEdge[]): Map<string, DanglingEdge[]> => {
  const out = new Map<string, DanglingEdge[]>();
  for (const edge of edges) {
    let bucket = out.get(edge.from);
    if (bucket === undefined) {
      bucket = [];
      out.set(edge.from, bucket);
    }
    bucket.push(edge);
  }
  return out;
};

// -------------------------------------------------------------------------
// Argv parsing for the bin
// -------------------------------------------------------------------------

/** Result of {@link parseMigrateArgs}. */
export type ParsedMigrateArgs =
  | {
      kind: 'ok';
      dir: string;
      pruneDangling: boolean;
      dryRun: boolean;
    }
  | {
      kind: 'usage_error';
      message: string;
    }
  | {
      kind: 'unknown_subcommand';
      message: string;
    };

/**
 * Parse the argv tail (everything after `node <bin>`) for the migrate
 * subcommand. Returns a discriminated result so the bin can render an
 * appropriate stderr message and exit code without sprinkling
 * `process.exit` calls through the parser.
 *
 * Recognised forms:
 *   `migrate <dir>`
 *   `migrate <dir> --dry-run`
 *   `migrate <dir> --prune-dangling`
 *   `migrate <dir> --dry-run --prune-dangling`
 *
 * Anything else returns either `usage_error` (right command, wrong args)
 * or `unknown_subcommand` (different first token entirely).
 */
export const parseMigrateArgs = (argv: readonly string[]): ParsedMigrateArgs => {
  if (argv.length === 0) {
    return {
      kind: 'usage_error',
      message:
        'commonplace: missing subcommand. Usage: commonplace migrate <dir> [--dry-run] [--prune-dangling]',
    };
  }
  const [head, ...rest] = argv;
  if (head !== 'migrate') {
    return {
      kind: 'unknown_subcommand',
      message: `commonplace: unknown subcommand \`${head}\`. Usage: commonplace migrate <dir> [--dry-run] [--prune-dangling]`,
    };
  }

  let dir: string | null = null;
  let pruneDangling = false;
  let dryRun = false;
  for (const token of rest) {
    if (token === '--dry-run') {
      dryRun = true;
    } else if (token === '--prune-dangling') {
      pruneDangling = true;
    } else if (token.startsWith('--')) {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: unknown flag \`${token}\`. Supported flags: --dry-run, --prune-dangling`,
      };
    } else if (dir === null) {
      dir = token;
    } else {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: unexpected positional argument \`${token}\` (a single <dir> is required, plus optional --dry-run / --prune-dangling)`,
      };
    }
  }

  if (dir === null) {
    return {
      kind: 'usage_error',
      message:
        'commonplace migrate: missing required <dir> argument. Usage: commonplace migrate <dir> [--dry-run] [--prune-dangling]',
    };
  }

  return { kind: 'ok', dir, pruneDangling, dryRun };
};

/** Inputs to {@link migrateMain}. */
export interface MigrateMainOptions {
  /** Argv tail (skip `node <bin>` -- pass `process.argv.slice(2)`). */
  argv: readonly string[];
  /** Embedder factory. The bin passes a real {@link import('../embedder/index.js').Embedder}; tests pass a stub. */
  embedderFactory: () => Embedder;
  /** Stdout writer (e.g. `process.stdout.write.bind(process.stdout)`). */
  stdout: (chunk: string) => void;
  /** Stderr writer. */
  stderr: (chunk: string) => void;
}

/** Result of {@link migrateMain}. */
export interface MigrateMainResult {
  /** Process exit code: 0 on success, 2 on usage error, 1 on runtime error. */
  exitCode: number;
}

/**
 * End-to-end bin entry: parse argv, validate the directory exists, run
 * the migration, render the human-readable summary. Returns an exit code
 * rather than calling `process.exit` directly so tests can drive the
 * function without spawning a child process.
 */
export const migrateMain = async (opts: MigrateMainOptions): Promise<MigrateMainResult> => {
  const parsed = parseMigrateArgs(opts.argv);
  if (parsed.kind !== 'ok') {
    opts.stderr(`${parsed.message}\n`);
    return { exitCode: 2 };
  }

  if (!existsSync(parsed.dir)) {
    opts.stderr(
      `commonplace migrate: directory \`${parsed.dir}\` does not exist. Pass an existing memory directory.\n`,
    );
    return { exitCode: 1 };
  }
  const st = statSync(parsed.dir);
  if (!st.isDirectory()) {
    opts.stderr(`commonplace migrate: \`${parsed.dir}\` is not a directory.\n`);
    return { exitCode: 1 };
  }

  let result: MigrateResult;
  try {
    result = await runMigrate({
      dir: parsed.dir,
      embedder: opts.embedderFactory(),
      pruneDangling: parsed.pruneDangling,
      dryRun: parsed.dryRun,
    });
  } catch (err) {
    opts.stderr(
      `commonplace migrate: failed to migrate \`${parsed.dir}\`: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return { exitCode: 1 };
  }

  // Human-readable summary. The labels are stable -- ac-2 contract test
  // asserts the exact strings 'loaded', 'embedded', 're-embedded', and
  // 'orphaned' appear in the output.
  const dryRunBanner = parsed.dryRun ? ' (dry-run)' : '';
  // `loaded` here is "memories indexed that did not require any
  // (re)embed work this run" -- i.e., total - embedded - reembedded. This
  // matches the issue body's example summary line "loaded: 3 unchanged".
  const unchanged = result.loaded - result.embedded - result.reembedded;
  // Guard against negative values in dry-run mode (where `loaded` only
  // counts entries with reusable sidecars). Display max(0, ...) so a
  // dry-run on a fully-stale corpus still prints a sensible "loaded: 0".
  const loadedDisplay = unchanged < 0 ? 0 : unchanged;
  const lines: string[] = [
    `commonplace migrate ${parsed.dir}${dryRunBanner}`,
    `  loaded:       ${loadedDisplay} unchanged`,
    `  embedded:     ${result.embedded} new sidecars`,
    `  re-embedded:  ${result.reembedded} stale sidecar${result.reembedded === 1 ? '' : 's'}`,
    `  orphaned:     ${result.orphaned} sidecar${result.orphaned === 1 ? '' : 's'} without matching .md${result.orphaned === 0 ? '' : parsed.dryRun ? ' (would be cleaned up)' : ' (cleaned up)'}`,
  ];
  if (result.pruned.length > 0) {
    const total = result.pruned.reduce((acc, p) => acc + p.edgesPruned, 0);
    lines.push(
      `  pruned:       ${total} dangling edge${total === 1 ? '' : 's'} across ${result.pruned.length} file${result.pruned.length === 1 ? '' : 's'}${parsed.dryRun ? ' (would be removed)' : ''}`,
    );
    for (const p of result.pruned) {
      lines.push(`    ${p.name}: ${p.edgesPruned}`);
    }
  }
  opts.stdout(`${lines.join('\n')}\n`);
  return { exitCode: 0 };
};
