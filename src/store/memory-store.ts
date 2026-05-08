/**
 * In-memory vector index backed by markdown + sidecar files on disk (DAR-916).
 *
 * `MemoryStore` combines:
 *
 *   - markdown I/O + `contentSha`  (DAR-911, `./memory.ts`)
 *   - binary sidecar encode/decode (DAR-910, `./sidecar.ts`)
 *   - the embedder                 (DAR-912, `../embedder/`)
 *
 * into a single class with four methods:
 *
 *   - `scan()`        glob `<dir>/*.md`, reuse valid sidecars, lazy-re-embed
 *                     on staleness, populate the in-memory entry array.
 *   - `save(memory)`  refuse-on-duplicate, write `.md`, embed body, write
 *                     `.embedding`, append to in-memory array.
 *   - `delete(name)`  rm both files, splice from the array. Throws if name is
 *                     not present.
 *   - `all()`         the in-memory entry array.
 *
 * # Scope
 *
 * Single-process. Per the issue body and the approved contract envelope, the
 * following are explicitly out of scope for this module and owned elsewhere:
 *
 *   - atomic write-temp+rename, fsync, advisory locks, mtime-based external
 *     rescan -- DAR-923 (multi-process safety).
 *   - top-k cosine search ranking -- DAR-917.
 *   - graph adjacency / dangling-edge detection -- DAR-926.
 *   - MCP tool wiring -- DAR-919, DAR-928.
 *   - layered user+project memory / scope auto-detection -- DAR-924.
 *   - migration CLI -- DAR-918.
 *   - recursive directory scan / nested layouts -- single-level glob only.
 *   - in-process concurrency control across overlapping save() calls.
 *
 * Plain `fs.writeFileSync` / `fs.unlinkSync` is acceptable here.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentSha, readMemory, writeMemory, type Memory, type Relation } from './memory.js';
import { decodeSidecar, encodeSidecar } from './sidecar.js';

/**
 * Structural contract MemoryStore needs from any Embedder. Matches the public
 * surface of `src/embedder/index.ts`'s {@link import('../embedder/index.js').Embedder}
 * but is declared as an interface so callers can stub it in tests without
 * loading transformers.js.
 */
export interface Embedder {
  readonly modelId: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

/** A single in-memory entry: parsed memory fields plus the loaded vector. */
export interface MemoryEntry {
  /** Memory name (also the basename of the `.md` and `.embedding` files). */
  name: string;
  /** Human description from frontmatter. */
  description: string;
  /** One of the four allowed memory types. */
  type: Memory['type'];
  /** Markdown body text. */
  body: string;
  /** Outgoing typed graph edges (from frontmatter `relations:`). */
  relations: Relation[];
  /** Names of memories this one supersedes. */
  supersedes: string[];
  /** L2-normalised CLS-pooled embedding vector. */
  vector: Float32Array;
  /** sha256 hex digest of the canonical content (DAR-911 `contentSha`). */
  contentSha: string;
  /** Model id this vector was computed under (matches the configured embedder). */
  modelId: string;
  /** Vector dimensionality (vector.length). */
  dim: number;
}

/** Options accepted by {@link MemoryStore} construction. */
export interface MemoryStoreOptions {
  /** Directory containing memory `.md` files and their `.embedding` sidecars. */
  dir: string;
  /** Embedder instance whose `modelId` and `dim` define sidecar freshness. */
  embedder: Embedder;
}

/** Result of a {@link MemoryStore.scan} run. */
export interface ScanResult {
  /** Number of memory entries now loaded into the in-memory array. */
  loaded: number;
  /** Number of `.md` files for which a sidecar was (re)written this scan. */
  reembedded: number;
}

/**
 * In-memory vector index backed by `<dir>/*.md` + `<name>.embedding` files.
 *
 * Construct with a directory and an embedder. Construction itself does no
 * filesystem I/O and no embedder calls -- those happen on the first
 * {@link scan} (or {@link save}/{@link delete} as appropriate).
 */
export class MemoryStore {
  readonly #dir: string;
  readonly #embedder: Embedder;
  /** The authoritative in-memory entry array. */
  #entries: MemoryEntry[] = [];

  public constructor(opts: MemoryStoreOptions) {
    this.#dir = opts.dir;
    this.#embedder = opts.embedder;
  }

  /**
   * Glob `<dir>/*.md`, decide for each one whether the matching
   * `<name>.embedding` is reusable, embed (and rewrite the sidecar) when not,
   * and populate the in-memory entry array with the result.
   *
   * Reuse criteria (sidecar is "fresh"):
   *   - the `.embedding` file exists
   *   - it decodes (magic + version + length checks pass)
   *   - `decoded.modelId === embedder.modelId`
   *   - `decoded.dim     === embedder.dim`
   *   - `decoded.contentSha === contentSha(memoryAsRead)`
   *
   * Anything else (missing, corrupt, model-mismatch, dim-mismatch, sha-
   * mismatch) triggers an embed + sidecar rewrite for that entry.
   *
   * Each call rebuilds the in-memory entry array from scratch, so calling
   * scan() repeatedly is safe -- entries that disappeared from disk drop
   * out, and re-added entries reappear.
   */
  public async scan(): Promise<ScanResult> {
    const mdFiles = listMarkdownFiles(this.#dir);
    const next: MemoryEntry[] = [];
    let reembedded = 0;

    for (const filename of mdFiles) {
      const mdPath = join(this.#dir, filename);
      const sidecarPath = mdPath.replace(/\.md$/, '.embedding');

      const memory = readMemory(mdPath);
      const sha = contentSha(memory);

      let vector: Float32Array | null = null;

      if (existsSync(sidecarPath)) {
        try {
          const decoded = decodeSidecar(readFileSync(sidecarPath));
          if (
            decoded.modelId === this.#embedder.modelId &&
            decoded.dim === this.#embedder.dim &&
            decoded.contentSha === sha
          ) {
            vector = decoded.vector;
          }
        } catch {
          // Corrupt sidecar -- fall through to re-embed.
          vector = null;
        }
      }

      if (vector === null) {
        vector = await this.#embedder.embed(memory.body);
        const buf = encodeSidecar({
          modelId: this.#embedder.modelId,
          dim: this.#embedder.dim,
          contentSha: sha,
          vector,
        });
        writeFileSync(sidecarPath, buf);
        reembedded += 1;
      }

      next.push({
        name: memory.name,
        description: memory.description,
        type: memory.type,
        body: memory.body,
        relations: memory.relations,
        supersedes: memory.supersedes,
        vector,
        contentSha: sha,
        modelId: this.#embedder.modelId,
        dim: this.#embedder.dim,
      });
    }

    this.#entries = next;
    return { loaded: next.length, reembedded };
  }

  /**
   * Persist a new memory. Refuses to overwrite an existing entry by name --
   * the contract is "use delete + save". A duplicate name in either the
   * in-memory index or on disk (via an existing `<name>.md`) raises before
   * any side effects.
   *
   * On success: writes `<name>.md`, embeds the body, writes
   * `<name>.embedding`, and appends one {@link MemoryEntry} to the in-memory
   * array.
   */
  public async save(memory: Memory): Promise<void> {
    const { name } = memory;
    if (this.#entries.some((e) => e.name === name)) {
      throw new Error(
        `MemoryStore.save: a memory named \`${name}\` already exists in the in-memory index; delete it first to replace`,
      );
    }

    const mdPath = join(this.#dir, `${name}.md`);
    const sidecarPath = join(this.#dir, `${name}.embedding`);
    if (existsSync(mdPath)) {
      throw new Error(
        `MemoryStore.save: a memory file already exists at ${mdPath} (name=\`${name}\`); delete it first to replace`,
      );
    }

    // Note: we write the .md first so that contentSha is computed against the
    // exact memory the caller passed in (which is what writeMemory persists
    // post-dedupe). This pairing keeps the embedding sidecar's contentSha
    // aligned with the on-disk source-of-truth.
    writeMemory(mdPath, memory);
    const sha = contentSha(memory);
    const vector = await this.#embedder.embed(memory.body);
    const buf = encodeSidecar({
      modelId: this.#embedder.modelId,
      dim: this.#embedder.dim,
      contentSha: sha,
      vector,
    });
    writeFileSync(sidecarPath, buf);

    this.#entries.push({
      name: memory.name,
      description: memory.description,
      type: memory.type,
      body: memory.body,
      relations: memory.relations ?? [],
      supersedes: memory.supersedes ?? [],
      vector,
      contentSha: sha,
      modelId: this.#embedder.modelId,
      dim: this.#embedder.dim,
    });
  }

  /**
   * Remove a memory by name. Throws when no entry with that name is present
   * in the in-memory index. On success: removes both `<name>.md` and
   * `<name>.embedding` from disk and splices the entry out of the array.
   *
   * Note: enforcement is in-memory-first by design. Callers are expected to
   * have called {@link scan} (or {@link save}) so the in-memory array
   * reflects what's on disk. This matches the single-process scope where the
   * in-memory state is authoritative between `scan()` calls (DAR-923 owns
   * any external-writer rescan policy).
   */
  public async delete(name: string): Promise<void> {
    const idx = this.#entries.findIndex((e) => e.name === name);
    if (idx === -1) {
      throw new Error(
        `MemoryStore.delete: no memory named \`${name}\` is present in the in-memory index`,
      );
    }

    const mdPath = join(this.#dir, `${name}.md`);
    const sidecarPath = join(this.#dir, `${name}.embedding`);
    if (existsSync(mdPath)) unlinkSync(mdPath);
    if (existsSync(sidecarPath)) unlinkSync(sidecarPath);
    this.#entries.splice(idx, 1);
  }

  /**
   * Return the current in-memory entry array. Returns the live internal
   * array reference for now -- callers should treat it as read-only. Future
   * consumers (DAR-917 search, DAR-926 graph) may copy as needed.
   */
  public all(): MemoryEntry[] {
    return this.#entries;
  }
}

/**
 * List `*.md` filenames (single-level, no subdirectories, no recursion) in
 * the given directory. Returns an empty array when the directory does not
 * exist yet -- a fresh store should be able to `scan()` an empty/missing
 * directory without raising.
 */
const listMarkdownFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.md')) continue;
    out.push(ent.name);
  }
  // Stable, sorted order makes scan() deterministic for tests and for users.
  out.sort();
  return out;
};
