/**
 * In-memory vector index backed by markdown + sidecar files on disk (DAR-916).
 *
 * `MemoryStore` combines:
 *
 *   - markdown I/O + `contentSha`  (DAR-911, `./memory.ts`)
 *   - binary sidecar encode/decode (DAR-910, `./sidecar.ts`)
 *   - the embedder                 (DAR-912, `../embedder/`)
 *
 * into a single class with five methods:
 *
 *   - `scan()`              glob `<dir>/*.md`, reuse valid sidecars,
 *                           lazy-re-embed on staleness, populate the
 *                           in-memory entry array.
 *   - `save(memory)`        refuse-on-duplicate, write `.md`, embed body,
 *                           write `.embedding`, append to in-memory array.
 *   - `delete(name)`        rm both files, splice from the array. Throws if
 *                           name is not present.
 *   - `all()`               the in-memory entry array.
 *   - `search(query, opts)` brute-force top-k cosine search over the
 *                           in-memory entry array (DAR-917).
 *
 * # Scope
 *
 * Single-process. Per the issue body and the approved contract envelope, the
 * following are explicitly out of scope for this module and owned elsewhere:
 *
 *   - atomic write-temp+rename, fsync, advisory locks, mtime-based external
 *     rescan -- DAR-923 (multi-process safety).
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
import { MemoryGraph } from './graph.js';
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
  /**
   * Optional in-memory graph index (DAR-926). When supplied, the store
   * keeps it synchronised with disk: `scan()` calls `graph.rebuild(entries)`,
   * `save()` calls `graph.add(entry)`, and `delete()` calls `graph.remove(name)`.
   * When omitted, the store does not maintain a graph -- callers that don't
   * need adjacency lookups pay no cost.
   */
  graph?: MemoryGraph;
}

/** Result of a {@link MemoryStore.scan} run. */
export interface ScanResult {
  /** Number of memory entries now loaded into the in-memory array. */
  loaded: number;
  /** Number of `.md` files for which a sidecar was (re)written this scan. */
  reembedded: number;
}

/** Options for {@link MemoryStore.search}. All fields are optional. */
export interface SearchOptions {
  /**
   * Maximum number of results to return after filtering. Defaults to 5.
   * Filters (`type`, `threshold`) are applied BEFORE this slice, so `limit`
   * counts only post-filter matches.
   */
  limit?: number;
  /** Restrict results to entries with this {@link Memory.type}. */
  type?: Memory['type'];
  /**
   * Minimum cosine score (dot product, since vectors are L2-normalised at
   * write time) for an entry to appear in results. Entries scoring strictly
   * less than `threshold` are dropped.
   */
  threshold?: number;
}

/** A single hit returned by {@link MemoryStore.search}. */
export interface SearchHit {
  /** The matching entry. Same object identity as the entry from {@link MemoryStore.all}. */
  memory: MemoryEntry;
  /** Cosine score (dot product on L2-normalised vectors). */
  score: number;
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
  readonly #graph: MemoryGraph | undefined;
  /** The authoritative in-memory entry array. */
  #entries: MemoryEntry[] = [];

  public constructor(opts: MemoryStoreOptions) {
    this.#dir = opts.dir;
    this.#embedder = opts.embedder;
    this.#graph = opts.graph;
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
        // Read the sidecar bytes OUTSIDE the try/catch so that real I/O errors
        // (EACCES, EIO, EMFILE, ENOMEM, ...) propagate to the caller rather
        // than being silently treated as "corrupt -- re-embed". Only the
        // decode step's intentional throw-on-bad-bytes is swallowed below;
        // that's the documented contract for sidecar corruption (DAR-916 ac-3).
        const bytes = readFileSync(sidecarPath);
        try {
          const decoded = decodeSidecar(bytes);
          if (
            decoded.modelId === this.#embedder.modelId &&
            decoded.dim === this.#embedder.dim &&
            decoded.contentSha === sha
          ) {
            vector = decoded.vector;
          }
        } catch {
          // Corrupt sidecar bytes -- fall through to re-embed.
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
    if (this.#graph !== undefined) {
      this.#graph.rebuild(next);
    }
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
   *
   * # Partial-state on embed failure
   *
   * `save()` writes the `.md` file BEFORE awaiting `embedder.embed()`. If
   * `embed()` rejects (e.g. model load failure, OOM in the inference
   * pipeline), the `.md` is left on disk with no matching sidecar and no
   * entry in the in-memory array. This is by design: the contract delegates
   * atomic write-temp+rename and crash-safety to DAR-923. Recovery is
   * self-healing on the next {@link scan} (the orphan `.md` is treated as a
   * missing-sidecar case and re-embedded), or manual: a subsequent `save()`
   * with the same name will reject with the "memory file already exists"
   * message until the operator either calls `scan()` + `delete(name)` or
   * removes the orphan `.md` directly.
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

    const entry: MemoryEntry = {
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
    };
    this.#entries.push(entry);
    if (this.#graph !== undefined) {
      this.#graph.add(entry);
    }
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
    if (this.#graph !== undefined) {
      this.#graph.remove(name);
    }
  }

  /**
   * Return the current in-memory entry array.
   *
   * The return type is `ReadonlyArray<MemoryEntry>` so the compiler catches
   * accidental mutation attempts (push/splice/sort) on what is the store's
   * authoritative state. Future consumers that need to sort/filter (DAR-917
   * search, DAR-926 graph) should make a shallow copy with `.slice()` or
   * `[...store.all()]` before mutating.
   *
   * Note: this returns a live reference to the internal array (typed as
   * read-only); the entries themselves are the same object identities the
   * store holds. If a caller defeats the type system with a cast, they can
   * still corrupt the store's invariants -- the readonly type is the
   * compile-time guard rail, not a runtime fence.
   */
  public all(): ReadonlyArray<MemoryEntry> {
    return this.#entries;
  }

  /**
   * Brute-force top-k cosine search over the in-memory entry array
   * (DAR-917).
   *
   * Pipeline:
   *
   *   1. If the in-memory entry array is empty, return `[]` immediately
   *      without invoking the embedder. This preserves the fast-path for a
   *      cold store and lets the MCP layer check "do we have any memories
   *      at all?" cheaply.
   *   2. Embed the query string exactly once via the configured Embedder.
   *      The query string is passed through verbatim -- no trimming, no
   *      lowercasing.
   *   3. Score every entry in {@link all} as the dot product of the query
   *      vector with `entry.vector`. Because entries' vectors are
   *      L2-normalised at write time (DAR-916), this dot product equals
   *      cosine similarity in `[-1, 1]`.
   *   4. Apply optional filters (`type`, `threshold`) BEFORE the limit slice,
   *      so `limit` counts only post-filter matches.
   *   5. Sort the surviving hits in descending score order and slice to
   *      `limit` (default 5).
   *
   * Notes:
   *
   *   - Only the query is embedded at search time. Candidate vectors come
   *     from the in-memory entries that {@link scan} or {@link save}
   *     populated.
   *   - The `memory` field on each {@link SearchHit} is the same object
   *     identity as the entry in `all()`. Callers must treat hits as
   *     read-only for the same reason `all()` returns a `ReadonlyArray`.
   *   - Tie-breaking on equal scores is unspecified; the sort is descending
   *     on score and stability across same-score ties is implementation-
   *     defined (per the approved contract envelope).
   *   - Input sanitisation of `opts.limit` (negatives, NaN, non-integers) is
   *     out of scope for the store layer; the implementation behaves per
   *     `Array.prototype.slice` semantics. The MCP tool layer (DAR-920) is
   *     responsible for caller-side validation.
   */
  public async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    if (this.#entries.length === 0) return [];

    const queryVec = await this.#embedder.embed(query);
    const limit = opts.limit ?? 5;

    const hits: SearchHit[] = [];
    for (const entry of this.#entries) {
      if (opts.type !== undefined && entry.type !== opts.type) continue;
      const score = dotProduct(queryVec, entry.vector);
      if (opts.threshold !== undefined && score < opts.threshold) continue;
      hits.push({ memory: entry, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

/**
 * Inner-product of two equal-length Float32Arrays. When both inputs are
 * L2-normalised this equals cosine similarity. Length mismatch is treated as
 * a programming error and surfaces via the index access pattern -- in
 * practice the embedder configured on the store and the entries' vectors
 * always agree on `dim` (DAR-916 sidecar reuse rules enforce this).
 */
const dotProduct = (a: Float32Array, b: Float32Array): number => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};

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
