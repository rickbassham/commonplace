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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MemoryGraph, type DanglingEdge } from '../store/graph.js';
import {
  MEMORY_TYPES,
  readMemory,
  serializeMemory,
  writeMemory,
  type Memory,
  type MemoryType,
  type Relation,
} from '../store/memory.js';
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
  /**
   * Number of `.md` files whose existing sidecar was already valid and was
   * reused without invoking the embedder or writing to disk. Mirrors
   * {@link import('../store/memory-store.js').ScanResult.fresh} so the CLI
   * summary line "loaded: N unchanged" can be reported directly without
   * subtracting from {@link loaded} (whose semantics differ between live
   * and dry-run modes -- see DAR-918 review f-1).
   */
  fresh: number;
  /** One entry per .md that had dangling edges pruned. Empty when nothing to prune. */
  pruned: PrunedFile[];
  /**
   * DAR-966: `.md` files whose frontmatter could not be parsed (missing or
   * malformed `---` delimiters, invalid YAML, missing required field, ...).
   * Surfaced verbatim from {@link import('../store/memory-store.js').ScanResult.skipped}.
   * The legacy `migrate <dir>` form uses this to report bad files in its
   * summary so a re-run after a partial import surfaces remaining issues
   * instead of crashing on the first.
   */
  skipped: Array<{ path: string; reason: string }>;
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
    fresh: scan.fresh,
    pruned,
    skipped: scan.skipped,
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
    // DAR-966: skip unparseable files instead of crashing. The scan pass
    // already reported them via ScanResult.skipped; the prune pass simply
    // ignores them (no edges to dangling-check on a file we can't read).
    try {
      const memory = readMemory(join(dir, ent.name));
      out.push({
        name: memory.name,
        relations: memory.relations,
        supersedes: memory.supersedes,
      });
    } catch {
      continue;
    }
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
// Auto-import from external memory sources (DAR-961)
// -------------------------------------------------------------------------

/**
 * The set of known external memory sources that ship a built-in importer
 * (DAR-961). Importers for sources whose data already lives behind an
 * MCP server (mem0, Letta, ...) are deliberately omitted -- the
 * documented MCP-to-MCP pattern (see README) handles those without any
 * commonplace-side integration code.
 */
export const KNOWN_IMPORT_SOURCES = ['claude-code'] as const;

/** Union of supported `--from` values. */
export type KnownImportSource = (typeof KNOWN_IMPORT_SOURCES)[number];

/** A single candidate file detected at a known source. */
export interface DetectedFile {
  /** Memory name (basename of the `.md` minus the extension). */
  name: string;
  /** Absolute path to the source `.md`. */
  path: string;
}

/** A single detected source -- one project-memory dir, one file count. */
export interface DetectedSource {
  /** The known-source identifier (currently always `claude-code`). */
  source: KnownImportSource;
  /** Absolute path to the source dir (e.g. `<home>/.claude/projects/<slug>/memory`). */
  dir: string;
  /** Files found in this dir (after the `*.md` glob). */
  files: DetectedFile[];
  /** Convenience: `files.length`. */
  fileCount: number;
}

/**
 * A non-fatal warning emitted during detection -- e.g. the
 * `~/.claude/projects/` dir exists but cannot be enumerated due to a
 * permission error. Detection still returns a (possibly empty) sources
 * array; the warning gives the caller something to render so the failure
 * mode is debuggable rather than silent (DAR-961 review f-4).
 */
export interface DetectionWarning {
  /** Absolute path that could not be read. */
  path: string;
  /** Human-readable error message (the caught exception's `.message`). */
  message: string;
}

/** Result of {@link detectImportSources}. */
export interface DetectionResult {
  /** Detected import sources -- one entry per project-memory dir with files. */
  sources: DetectedSource[];
  /**
   * Non-fatal issues encountered during detection. Empty on the happy
   * path. Populated when a directory exists but cannot be enumerated.
   */
  warnings: DetectionWarning[];
}

/** Inputs to {@link detectImportSources}. */
export interface DetectOptions {
  /** Home directory used to resolve `~/.claude/projects/*\/memory/`. Tests pass a tmp dir. */
  home?: string;
}

/**
 * Discover candidate import sources without writing anything.
 *
 * Today the only known source is Claude Code's per-project auto-memory at
 * `~/.claude/projects/*\/memory/*.md`. We glob the slug rather than parse
 * it, so any slug shape (Claude Code's leading-dash convention, or
 * anything else) resolves the same way.
 *
 * Returns one entry per `~/.claude/projects/<slug>/memory/` directory
 * that exists and contains at least one `.md` file. Empty array means
 * "no candidates" -- the CLI should report 0 detected sources rather
 * than complain.
 *
 * For the warnings-aware variant (which captures readdir failures so
 * permission issues don't silently look like an empty home), see
 * {@link detectImportSourcesDetailed}.
 */
export const detectImportSources = (opts: DetectOptions = {}): DetectedSource[] =>
  detectImportSourcesDetailed(opts).sources;

/**
 * Same as {@link detectImportSources} but additionally returns any
 * non-fatal warnings encountered during the walk (e.g. `~/.claude/projects/`
 * exists but cannot be enumerated). Detection is still best-effort -- a
 * warning never causes a throw -- but surfacing the message lets the CLI
 * render a debuggable signal instead of an indistinguishable
 * "no external memory sources detected" (DAR-961 review f-4).
 */
export const detectImportSourcesDetailed = (opts: DetectOptions = {}): DetectionResult => {
  const home = opts.home ?? homedir();
  const projectsRoot = join(home, '.claude', 'projects');
  const warnings: DetectionWarning[] = [];
  if (!existsSync(projectsRoot)) return { sources: [], warnings };
  let projectEntries: { name: string; isDir: boolean }[];
  try {
    projectEntries = readdirSync(projectsRoot, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    }));
  } catch (err) {
    // Directory exists but cannot be read (permissions, race, etc.).
    // Treat as "no candidates" rather than throwing -- detection is
    // best-effort -- but capture the error so the CLI can render a
    // warning instead of a silent zero.
    warnings.push({
      path: projectsRoot,
      message: err instanceof Error ? err.message : String(err),
    });
    return { sources: [], warnings };
  }
  const out: DetectedSource[] = [];
  for (const ent of projectEntries) {
    if (!ent.isDir) continue;
    const memDir = join(projectsRoot, ent.name, 'memory');
    if (!existsSync(memDir)) continue;
    let files: { name: string }[];
    try {
      files = readdirSync(memDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        // DAR-966: exclude the harness's per-project `MEMORY.md` index
        // file (case-insensitive). It is markdown with no frontmatter --
        // a system file, not a memory -- and copying it into the user
        // store pollutes the index and crashes the post-copy scan.
        .filter((d) => d.name.toLowerCase() !== 'memory.md')
        .map((d) => ({ name: d.name }));
    } catch (err) {
      warnings.push({
        path: memDir,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (files.length === 0) continue;
    const detected: DetectedFile[] = files.map((f) => ({
      name: f.name.replace(/\.md$/, ''),
      path: join(memDir, f.name),
    }));
    out.push({
      source: 'claude-code',
      dir: memDir,
      files: detected,
      fileCount: detected.length,
    });
  }
  return { sources: out, warnings };
};

/** A single imported entry in the result of {@link runImportFromClaudeCode}. */
export interface ImportedEntry {
  /** Memory name (basename). */
  name: string;
  /** Absolute path to the source file. */
  source: string;
  /** Absolute path of the destination file in `<user-dir>`. */
  target: string;
}

/** A single skipped entry in the result of {@link runImportFromClaudeCode}. */
export interface SkippedEntry {
  /** Memory name (basename). */
  name: string;
  /** Source path. */
  source: string;
  /** Human-readable reason (e.g. `already exists in <user-dir>`). */
  reason: string;
}

/** Per-source roll-up returned by {@link runImportFromClaudeCode}. */
export interface ImportSourceSummary {
  source: KnownImportSource;
  dir: string;
  imported: number;
  skipped: number;
}

/** Result of {@link runImportFromClaudeCode}. */
export interface ImportResult {
  /** All entries copied (or, in dry-run, that would have been copied). */
  imported: ImportedEntry[];
  /** All entries skipped due to a name collision. */
  skipped: SkippedEntry[];
  /** Per-source counts so the CLI can render a useful summary. */
  bySource: ImportSourceSummary[];
  /** Whether dry-run was active. */
  dryRun: boolean;
  /** Result of the post-copy scan/embed pass (null in dry-run). */
  scan: MigrateResult | null;
}

/** Inputs to {@link runImportFromClaudeCode}. */
export interface ImportOptions {
  /** Home directory used to find Claude Code project-memory dirs. */
  home?: string;
  /** Target directory -- always the resolved `COMMONPLACE_USER_DIR`. */
  userDir: string;
  /** Embedder used by the post-copy scan/embed pass. */
  embedder: Embedder;
  /** When true, report what would happen without writing anything. */
  dryRun?: boolean;
}

/**
 * DAR-966: parse a harness-emitted memory file in commonplace-canonical
 * form, tolerating the harness's permissive YAML quoting.
 *
 * The harness writes a flat key/value frontmatter (no nested
 * mappings, no flow sequences in description) and does NOT auto-quote
 * values containing colon-space -- so an input like
 * `description: Project-level constraint: weather-hub firmware ...`
 * trips the strict YAML reader used by readMemory. This helper
 * splits frontmatter line-by-line and treats each pair as
 * a raw string assignment, sidestepping the strict-YAML round-trip
 * mismatch.
 *
 * Returns a Memory-shaped object suitable for re-emission via
 * serializeMemory. Throws when:
 *   - the file lacks --- delimiters
 *   - a required field (name, description, type) is missing
 *   - type is not one of the four allowed MEMORY_TYPES
 *
 * The error message mentions the offending field so the import path
 * can surface a structured per-file skip reason.
 *
 * Out of scope (by design): graph fields. The harness does not emit
 * relations or supersedes. If a harness file ever did, this helper
 * would silently drop them. That mirrors the issue body's "only
 * frontmatter normalisation" framing.
 */
const parseHarnessFrontmatter = (path: string): Memory => {
  const raw = readFileSync(path, 'utf8');
  // Accept either LF or CRLF around the delimiters. Mirror the regex
  // used by splitFrontmatter in src/store/memory.ts so behaviour is
  // consistent with the strict reader on well-formed files.
  const openMatch = /^---[ \t]*\r?\n/.exec(raw);
  if (openMatch === null) {
    throw new Error('memory file is missing opening `---` frontmatter delimiter');
  }
  const afterOpen = openMatch[0].length;
  const rest = raw.slice(afterOpen);
  const closeMatch = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (closeMatch === null) {
    throw new Error('memory file is missing closing `---` frontmatter delimiter');
  }
  const closeStart = closeMatch.index + (closeMatch[1] ?? '').length;
  const closeEnd = closeMatch.index + closeMatch[0].length;
  const frontmatter = rest.slice(0, closeStart);
  const body = rest.slice(closeEnd);

  // Flat key/value line-by-line parse. The first colon delimits the
  // key; everything after the colon (and any single leading space) is
  // the raw value. Lines that don't match are skipped silently -- we
  // only care about the required fields.
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    if (line === '') continue;
    // Tab-indented lines (the "totally non-YAML" case in ac-3) are
    // rejected by yaml-spec parsers; we reject them here too so the
    // skip reason mentions YAML/frontmatter rather than silently
    // dropping the line.
    if (line.startsWith('\t')) {
      throw new Error('memory file frontmatter contains tab-indented lines (not valid YAML)');
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    // Strip a single optional leading space; keep the rest verbatim.
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    // Trim trailing whitespace only -- preserve internal spaces (a
    // description like "foo: bar" must round-trip exactly).
    value = value.replace(/[ \t]+$/, '');
    // Strip surrounding quotes for already-canonical values
    // (description: "..."). yaml.stringify auto-quotes ambiguous
    // values; we want the unquoted string back so re-serialisation
    // produces the canonical form.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }

  const name = fields.get('name');
  const description = fields.get('description');
  const type = fields.get('type');

  if (typeof name !== 'string' || name === '') {
    throw new Error('memory frontmatter is missing required field `name` (string)');
  }
  if (typeof description !== 'string' || description === '') {
    throw new Error('memory frontmatter is missing required field `description` (string)');
  }
  if (typeof type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `memory frontmatter \`type\` must be one of ${MEMORY_TYPES.join(', ')}; got ${JSON.stringify(type)}`,
    );
  }

  return { name, description, type: type as MemoryType, body };
};

/**
 * Import compatible markdown files from Claude Code's per-project
 * auto-memory directories into the commonplace user store.
 *
 * Steps:
 *   1. Detect candidate `~/.claude/projects/*\/memory/*.md` files.
 *   2. For each candidate, if the target `<user-dir>/<name>.md` already
 *      exists, skip it (default-safe, no overwrite). Otherwise copy the
 *      source bytes verbatim into the target -- preserving frontmatter
 *      and body untouched.
 *   3. After all copies, run the existing scan/embed pass on the user
 *      dir so each newly-imported `.md` gets its `.embedding` sidecar.
 *
 * In dry-run, steps 2 and 3 are skipped: the result still reports what
 * would have been imported and which collisions would have been
 * skipped, but no bytes are written.
 *
 * Always succeeds when input is well-formed -- skips are not failures
 * (per ac-3 contract). Real errors (e.g. read failure on a source file)
 * propagate to the caller.
 */
export const runImportFromClaudeCode = async (opts: ImportOptions): Promise<ImportResult> => {
  const dryRun = opts.dryRun === true;
  const sources = detectImportSources({ home: opts.home });

  // Ensure the user dir exists for live runs so the copy step does not
  // ENOENT on first-time users. In dry-run we leave the filesystem
  // untouched.
  if (!dryRun) {
    await mkdir(opts.userDir, { recursive: true });
  }

  const imported: ImportedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const bySource: ImportSourceSummary[] = [];

  // Track the source dir each name was imported from in this run so a
  // later collision on the same name (from a sibling project's memory
  // dir) is reported with a distinct, accurate reason rather than the
  // misleading "already exists in <userDir>" -- which implies a
  // pre-existing user-dir entry, not a within-run collision between two
  // sibling Claude Code projects (DAR-961 review f-2).
  const importedFromThisRun = new Map<string, string>();

  for (const src of sources) {
    let perSourceImported = 0;
    let perSourceSkipped = 0;
    for (const file of src.files) {
      const target = join(opts.userDir, `${file.name}.md`);
      // Cross-project collision: the same basename was already imported
      // earlier in this run from another known-source dir. The first
      // version "won" (per ac-3 skip semantics extended consistently
      // here); we report the second skip so the user can see both
      // sources had a same-named memory and the second was dropped.
      const earlierDir = importedFromThisRun.get(file.name);
      if (earlierDir !== undefined) {
        skipped.push({
          name: file.name,
          source: file.path,
          reason: `same-name source already imported from ${earlierDir}`,
        });
        perSourceSkipped += 1;
        continue;
      }
      if (existsSync(target)) {
        skipped.push({
          name: file.name,
          source: file.path,
          reason: `already exists in ${opts.userDir}`,
        });
        perSourceSkipped += 1;
        continue;
      }
      // DAR-966: read the source through the permissive harness-
      // frontmatter parser (which tolerates unquoted values containing
      // colon-space) and re-emit via `serializeMemory` so the imported
      // file lands in commonplace-canonical YAML regardless of the
      // harness's quoting habits. Files that cannot be parsed (missing
      // required field, totally non-YAML frontmatter, ...) are pushed
      // onto `skipped[]` with a structured reason and a per-file
      // diagnostic continues to the next file rather than crashing the
      // whole import.
      let canonical: string;
      try {
        const parsed = parseHarnessFrontmatter(file.path);
        canonical = serializeMemory(parsed);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ name: file.name, source: file.path, reason });
        perSourceSkipped += 1;
        continue;
      }
      if (!dryRun) {
        // Write the canonicalised bytes. The scan pass below re-reads
        // the file and computes the sidecar against the normalised
        // bytes, so the sha matches what's now on disk.
        writeFileSync(target, canonical, 'utf8');
      }
      imported.push({ name: file.name, source: file.path, target });
      perSourceImported += 1;
      importedFromThisRun.set(file.name, src.dir);
    }
    bySource.push({
      source: src.source,
      dir: src.dir,
      imported: perSourceImported,
      skipped: perSourceSkipped,
    });
  }

  // Run the existing scan/embed pass on the user dir. This generates
  // `.embedding` sidecars for the freshly-copied `.md` files (and any
  // pre-existing user-dir files that were missing sidecars). Skipped in
  // dry-run -- the imported entries weren't actually copied, so a scan
  // would either be a no-op or would mutate pre-existing state.
  let scan: MigrateResult | null = null;
  if (!dryRun && imported.length > 0) {
    scan = await runMigrate({
      dir: opts.userDir,
      embedder: opts.embedder,
      pruneDangling: false,
    });
  }

  return { imported, skipped, bySource, dryRun, scan };
};

// -------------------------------------------------------------------------
// Argv parsing for the bin
// -------------------------------------------------------------------------

/** Result of {@link parseMigrateArgs}. */
export type ParsedMigrateArgs =
  | {
      kind: 'ok';
      mode: 'scan';
      dir: string;
      pruneDangling: boolean;
      dryRun: boolean;
    }
  | {
      kind: 'ok';
      mode: 'detect';
    }
  | {
      kind: 'ok';
      mode: 'import';
      from: KnownImportSource;
      dryRun: boolean;
      auto: boolean;
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
 * Canonical usage string for the `commonplace migrate` surface. Exported so
 * the bare-bin entry (`src/index.ts`) can render the same multi-line message
 * a parser usage_error renders -- one source of truth for "how do I invoke
 * commonplace" rather than two strings that drift over time (DAR-961
 * review f-1).
 *
 * `--auto` is documented inline as a forward-compat no-op so a user who
 * sees it in `--help` knows it does not change today's behaviour and won't
 * be surprised when interactive prompting later sits behind a different
 * flag (DAR-961 review f-3).
 */
export const USAGE =
  'Usage: commonplace migrate                       (detect known external memory sources)\n' +
  '       commonplace migrate --from <source>       (import from a known source; --dry-run / --auto supported)\n' +
  '                                                 (--auto is a forward-compat no-op today; reserved for future interactive prompting)\n' +
  '       commonplace migrate <dir>                 (rebuild sidecars for an existing memory dir; --dry-run / --prune-dangling supported)';

const isKnownImportSource = (v: string): v is KnownImportSource =>
  (KNOWN_IMPORT_SOURCES as readonly string[]).includes(v);

/**
 * Parse the argv tail (everything after `node <bin>`) for the migrate
 * subcommand. Returns a discriminated result so the bin can render an
 * appropriate stderr message and exit code without sprinkling
 * `process.exit` calls through the parser.
 *
 * Recognised forms:
 *   `migrate`                                     -- detection-only (DAR-961)
 *   `migrate --from <source>`                     -- import from a known source (DAR-961)
 *   `migrate --from <source> --dry-run`           -- ditto, report without writing
 *   `migrate --from <source> --auto`              -- non-interactive (currently a no-op vs. default)
 *   `migrate <dir>`                               -- rebuild sidecars for <dir> (DAR-918)
 *   `migrate <dir> --dry-run`                     -- DAR-918
 *   `migrate <dir> --prune-dangling`              -- DAR-918
 *   `migrate <dir> --dry-run --prune-dangling`    -- DAR-918
 *
 * Anything else returns either `usage_error` (right command, wrong args)
 * or `unknown_subcommand` (different first token entirely).
 */
export const parseMigrateArgs = (argv: readonly string[]): ParsedMigrateArgs => {
  if (argv.length === 0) {
    return {
      kind: 'usage_error',
      message: `commonplace: missing subcommand.\n${USAGE}`,
    };
  }
  const [head, ...rest] = argv;
  if (head !== 'migrate') {
    return {
      kind: 'unknown_subcommand',
      message: `commonplace: unknown subcommand \`${head}\`.\n${USAGE}`,
    };
  }

  let dir: string | null = null;
  let pruneDangling = false;
  let dryRun = false;
  let from: KnownImportSource | null = null;
  let auto = false;
  // Use a manual iterator so the `--from` branch can advance past its
  // value argument without indexing `rest` with a number (which under
  // `noUncheckedIndexedAccess` would yield `string | undefined` and
  // require type narrowing on every iteration).
  const it = rest[Symbol.iterator]();
  for (let step = it.next(); !step.done; step = it.next()) {
    const token = step.value;
    if (token === '--dry-run') {
      dryRun = true;
    } else if (token === '--prune-dangling') {
      pruneDangling = true;
    } else if (token === '--auto') {
      auto = true;
    } else if (token === '--from') {
      const nextStep = it.next();
      if (nextStep.done) {
        return {
          kind: 'usage_error',
          message: `commonplace migrate: \`--from\` requires a source name (one of: ${KNOWN_IMPORT_SOURCES.join(', ')}).`,
        };
      }
      const nextValue = nextStep.value;
      if (!isKnownImportSource(nextValue)) {
        return {
          kind: 'usage_error',
          message: `commonplace migrate: unknown --from source \`${nextValue}\`. Supported: ${KNOWN_IMPORT_SOURCES.join(', ')}.`,
        };
      }
      from = nextValue;
    } else if (token.startsWith('--')) {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: unknown flag \`${token}\`. Supported flags: --dry-run, --prune-dangling, --from <source>, --auto`,
      };
    } else if (dir === null) {
      dir = token;
    } else {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: unexpected positional argument \`${token}\`.\n${USAGE}`,
      };
    }
  }

  // Mode resolution: --from selects import mode; bare `migrate` selects
  // detection mode; a positional <dir> selects scan mode (DAR-918).
  if (from !== null) {
    if (dir !== null) {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: \`--from <source>\` does not accept a positional <dir> (target is always COMMONPLACE_USER_DIR).`,
      };
    }
    if (pruneDangling) {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: \`--prune-dangling\` is not supported with \`--from <source>\` (it applies to the legacy \`migrate <dir>\` form).`,
      };
    }
    return { kind: 'ok', mode: 'import', from, dryRun, auto };
  }

  if (dir === null) {
    if (pruneDangling || dryRun || auto) {
      return {
        kind: 'usage_error',
        message: `commonplace migrate: detection mode (no args) does not accept flags. Use \`migrate --from <source>\` or \`migrate <dir>\` instead.`,
      };
    }
    return { kind: 'ok', mode: 'detect' };
  }

  return { kind: 'ok', mode: 'scan', dir, pruneDangling, dryRun };
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
  /**
   * Process environment, used to resolve `COMMONPLACE_USER_DIR` for
   * import mode. The bin passes `process.env`; tests pass an isolated
   * snapshot.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Home directory used to find Claude Code project-memory dirs in the
   * detect / import modes. Defaults to `os.homedir()`. Tests pass a tmp
   * dir to avoid touching the real `~/.claude/`.
   */
  home?: string;
}

/** Result of {@link migrateMain}. */
export interface MigrateMainResult {
  /** Process exit code: 0 on success, 2 on usage error, 1 on runtime error. */
  exitCode: number;
}

/**
 * Resolve the user dir from env, mirroring `src/bin/scope.ts`.
 *
 * The migrate CLI uses this only in import mode -- detect mode does not
 * touch the user dir at all, and scan mode operates on the explicit
 * `<dir>` positional. Inlined here rather than imported from `scope.ts`
 * so the migrate CLI does not pull in MCP-server boot dependencies.
 */
const resolveUserDir = (env: NodeJS.ProcessEnv): string => {
  const userDir = env.COMMONPLACE_USER_DIR;
  if (typeof userDir === 'string' && userDir.length > 0) return userDir;
  const legacy = env.COMMONPLACE_MEMORY_DIR;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  return join(homedir(), '.commonplace', 'memory');
};

/**
 * End-to-end bin entry: parse argv, dispatch to the correct mode, render
 * the human-readable summary. Returns an exit code rather than calling
 * `process.exit` directly so tests can drive the function without
 * spawning a child process.
 */
export const migrateMain = async (opts: MigrateMainOptions): Promise<MigrateMainResult> => {
  const parsed = parseMigrateArgs(opts.argv);
  if (parsed.kind !== 'ok') {
    opts.stderr(`${parsed.message}\n`);
    return { exitCode: 2 };
  }

  if (parsed.mode === 'detect') {
    return migrateDetect(parsed, opts);
  }
  if (parsed.mode === 'import') {
    return migrateImport(parsed, opts);
  }
  return migrateScan(parsed, opts);
};

/** Detection mode (DAR-961): report what we would import, write nothing. */
const migrateDetect = (
  _parsed: { kind: 'ok'; mode: 'detect' },
  opts: MigrateMainOptions,
): MigrateMainResult => {
  const home = opts.home;
  // Use the warnings-aware variant so a permission failure on
  // `~/.claude/projects/` produces a debuggable signal on stderr instead
  // of being indistinguishable from a genuinely empty home (DAR-961
  // review f-4).
  const { sources, warnings } = detectImportSourcesDetailed(home === undefined ? {} : { home });

  // Warnings go to stderr so the stdout summary stays parseable. Each
  // warning carries the path and the OS error message verbatim.
  if (warnings.length > 0) {
    opts.stderr(
      `commonplace migrate: detection completed with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:\n`,
    );
    for (const w of warnings) {
      opts.stderr(`  warning: could not read ${w.path}: ${w.message}\n`);
    }
  }

  if (sources.length === 0) {
    opts.stdout(
      'commonplace migrate: no external memory sources detected.\n' +
        '  Looked for: ~/.claude/projects/*/memory/*.md (Claude Code project memory)\n' +
        '  No action needed.\n',
    );
    return { exitCode: 0 };
  }

  const total = sources.reduce((acc, s) => acc + s.fileCount, 0);
  const lines: string[] = [
    `commonplace migrate: detected ${sources.length} candidate source${sources.length === 1 ? '' : 's'} (${total} file${total === 1 ? '' : 's'} total).`,
  ];
  for (const src of sources) {
    lines.push(
      `  [${src.source}] ${src.dir} -> ${src.fileCount} file${src.fileCount === 1 ? '' : 's'}`,
    );
  }
  lines.push('');
  lines.push(
    'Run `commonplace migrate --from claude-code` to import. Add `--dry-run` to preview without writing, or `--auto` for scripted runs.',
  );
  opts.stdout(`${lines.join('\n')}\n`);
  return { exitCode: 0 };
};

/** Import mode (DAR-961): copy compatible files into COMMONPLACE_USER_DIR + scan/embed. */
const migrateImport = async (
  parsed: { kind: 'ok'; mode: 'import'; from: KnownImportSource; dryRun: boolean; auto: boolean },
  opts: MigrateMainOptions,
): Promise<MigrateMainResult> => {
  // `--auto` is currently a no-op compared to the default flow because
  // we don't gate on an interactive prompt today; it remains in the
  // argv surface so scripts can write `--auto` and not have to change
  // when interactive prompting is added later (per the issue body's
  // own framing). Reading the flag silences the unused-binding warning
  // and keeps the field on the discriminated result.
  void parsed.auto;
  const env = opts.env ?? process.env;
  const userDir = resolveUserDir(env);

  let result: ImportResult;
  try {
    const home = opts.home;
    result = await runImportFromClaudeCode({
      ...(home === undefined ? {} : { home }),
      userDir,
      embedder: opts.embedderFactory(),
      dryRun: parsed.dryRun,
    });
  } catch (err) {
    opts.stderr(
      `commonplace migrate --from ${parsed.from}: failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return { exitCode: 1 };
  }

  const dryRunBanner = parsed.dryRun ? ' (dry-run)' : '';
  const importedCount = result.imported.length;
  const skippedCount = result.skipped.length;
  const lines: string[] = [
    `commonplace migrate --from ${parsed.from}${dryRunBanner}`,
    `  target:       ${userDir}`,
    `  imported:     ${importedCount} file${importedCount === 1 ? '' : 's'}${parsed.dryRun ? ' (would be imported)' : ''}`,
    `  skipped:      ${skippedCount} file${skippedCount === 1 ? '' : 's'}${skippedCount === 0 ? '' : ' (already exists in target)'}`,
  ];
  if (result.bySource.length > 0) {
    lines.push('  per-source:');
    for (const s of result.bySource) {
      lines.push(`    [${s.source}] ${s.dir}: imported=${s.imported}, skipped=${s.skipped}`);
    }
  }
  if (skippedCount > 0) {
    // DAR-966: list each skipped file with its name, source dir, and
    // reason so an operator can see both same-name collisions and
    // unrecoverable-frontmatter skips in the same section. The reason
    // string is short and human-readable (e.g. "already exists in ..."
    // or "memory file frontmatter is not valid YAML: ...").
    lines.push('  skipped:');
    for (const sk of result.skipped) {
      const srcDir = sk.source.slice(0, sk.source.lastIndexOf('/'));
      lines.push(`    skipped: ${sk.name} (source: ${srcDir}) -- ${sk.reason}`);
    }
  }
  if (result.scan !== null) {
    lines.push(
      `  embeddings:   ${result.scan.embedded} new sidecar${result.scan.embedded === 1 ? '' : 's'} written by post-copy scan`,
    );
  }
  opts.stdout(`${lines.join('\n')}\n`);
  return { exitCode: 0 };
};

/** Legacy scan mode (DAR-918): rebuild sidecars for an existing dir. */
const migrateScan = async (
  parsed: { kind: 'ok'; mode: 'scan'; dir: string; pruneDangling: boolean; dryRun: boolean },
  opts: MigrateMainOptions,
): Promise<MigrateMainResult> => {
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
  const lines: string[] = [
    `commonplace migrate ${parsed.dir}${dryRunBanner}`,
    `  loaded:       ${result.fresh} unchanged`,
    `  embedded:     ${result.embedded} new sidecars`,
    `  re-embedded:  ${result.reembedded} stale sidecar${result.reembedded === 1 ? '' : 's'}`,
    `  orphaned:     ${result.orphaned} sidecar${result.orphaned === 1 ? '' : 's'} without matching .md${result.orphaned === 0 ? '' : parsed.dryRun ? ' (would be cleaned up)' : ' (cleaned up)'}`,
  ];
  if (result.skipped.length > 0) {
    // DAR-966: a `migrate <dir>` re-run after a partial import surfaces
    // each malformed `.md` here so the operator can hand-fix it instead
    // of guessing why a previous scan crashed.
    lines.push(
      `  skipped:      ${result.skipped.length} file${result.skipped.length === 1 ? '' : 's'} (frontmatter unreadable)`,
    );
    for (const sk of result.skipped) {
      lines.push(`    skipped: ${sk.path} -- ${sk.reason}`);
    }
  }
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
