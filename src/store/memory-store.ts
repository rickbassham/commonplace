/**
 * In-memory vector index backed by markdown + sidecar files on disk
 * (DAR-916), with multi-process safety primitives layered on (DAR-923):
 *
 *   - **atomic writes** -- every `.md` and `.embedding` write goes through
 *     {@link atomicWrite} (write-temp + fsync + rename + dir-fsync) so a
 *     concurrent reader either sees the prior file or the new file, never
 *     a half-written one.
 *   - **per-name advisory locks** -- {@link save} and {@link delete} each
 *     hold a lockfile keyed on `<name>.md` for the duration of their work,
 *     so two processes racing on the same name resolve to one winner.
 *     Stale locks (>5s old) are reclaimed automatically.
 *   - **mtime-based external rescan** -- {@link search} and {@link list}
 *     stat the memory directory and rescan when its mtime advanced since
 *     the last scan, so changes from another process show up on the next
 *     call without explicit coordination.
 *
 * # Out of scope (per DAR-923 contract envelope)
 *
 *   - cross-machine / network-mounted directory sync
 *   - a shared resident daemon coordinating writers
 *   - lockless / lock-free indexing
 *   - recursive / nested directory layouts (single-level glob only)
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import * as lockfile from 'proper-lockfile';

import { atomicWrite } from './atomic-write.js';
import { contentSha, readMemory, serializeMemory, type Memory, type Relation } from './memory.js';
import { MemoryGraph } from './graph.js';
import { extractMentions, mentionsExtractionEnabled } from './mentions.js';
import { decodeSidecar, encodeSidecar } from './sidecar.js';

/**
 * Stale-lock threshold per DAR-923 ac-3: a lockfile older than this is
 * treated as orphaned (the prior holder crashed) and reclaimed on the next
 * acquire attempt. proper-lockfile's `stale` option is in milliseconds.
 */
const STALE_LOCK_MS = 5000;

/**
 * proper-lockfile retry/wait config used when acquiring a per-name lock.
 * The values are deliberately generous so a stale-lock reclaim has time to
 * run, but bounded so a genuinely contended save still surfaces a failure
 * in seconds rather than minutes.
 */
const LOCK_RETRIES = {
  retries: 10,
  factor: 1.5,
  minTimeout: 50,
  maxTimeout: 1000,
};

/**
 * Build the canonical lock target path for a memory `<name>`. We lock on
 * the `.md` path because that's the user-facing artifact (and the file
 * proper-lockfile creates a sibling `.lock` directory next to). All locks
 * for a given name go through this helper so save / delete / external
 * tooling agree on the path.
 */
const lockTargetForName = (dir: string, name: string): string => join(dir, `${name}.md`);

/**
 * Type predicate: does `err` carry a `code: string` field equal to `code`?
 *
 * Used to detect proper-lockfile's `ELOCKED` error code via structural
 * narrowing (`'code' in err`) so the type checker proves the property
 * access is safe -- no `as` cast required.
 */
const hasErrorCode = (err: unknown, code: string): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  if (!('code' in err)) return false;
  return typeof err.code === 'string' && err.code === code;
};

/**
 * Acquire a proper-lockfile advisory lock on the memory `<name>`'s lock
 * target. Returns the release function. Uses `realpath: false` so the lock
 * works even when the target file does not exist yet (fresh save), and
 * `stale: 5000` so an orphaned lock from a crashed prior holder is
 * reclaimed instead of blocking indefinitely (DAR-923 ac-3).
 *
 * Translates proper-lockfile's `ELOCKED` error into a clearer
 * "MemoryStore: lock for memory `<name>` is busy" message that surfaces
 * the memory name -- consumers (sibling DAR-924 tooling, MCP layer
 * DAR-919) need the name to render an actionable error.
 */
const acquireNameLock = async (dir: string, name: string): Promise<() => Promise<void>> => {
  const target = lockTargetForName(dir, name);
  try {
    const release = await lockfile.lock(target, {
      stale: STALE_LOCK_MS,
      realpath: false,
      retries: LOCK_RETRIES,
    });
    return release;
  } catch (err) {
    if (hasErrorCode(err, 'ELOCKED')) {
      throw new Error(
        `MemoryStore: lock for memory \`${name}\` is busy (another process is writing or has a stale lock younger than ${STALE_LOCK_MS}ms)`,
      );
    }
    throw err;
  }
};

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
  /**
   * Last observed `mtimeMs` of the memory directory, captured at the end of
   * each successful {@link scan}. Used by {@link search} and {@link list}
   * to detect external writers (DAR-923 ac-4) -- if the directory's mtime
   * has advanced since this value, a rescan is forced before answering.
   *
   * `null` means "we have not scanned yet"; the next {@link search} or
   * {@link list} call will trigger an initial scan.
   */
  #lastScanMtimeMs: number | null = null;

  public constructor(opts: MemoryStoreOptions) {
    this.#dir = opts.dir;
    this.#embedder = opts.embedder;
    this.#graph = opts.graph;
  }

  /**
   * The on-disk directory this store was constructed against. Exposed so
   * adjacent layers (e.g. the MCP CRUD handlers in DAR-919) can derive
   * canonical file paths for response payloads without reaching into
   * private state. Read-only by convention; callers MUST NOT mutate the
   * directory contents directly -- always go through {@link save},
   * {@link delete}, or {@link scan}.
   */
  public get dir(): string {
    return this.#dir;
  }

  /**
   * If the memory directory's mtime has advanced since the last scan, run
   * a fresh {@link scan}. Cheap (~1ms): we only stat the dir; the scan
   * itself is unconditional only when the mtime check fires.
   *
   * Used by {@link search} and {@link list} (DAR-923 ac-4).
   */
  async #rescanIfMtimeChanged(): Promise<void> {
    if (!existsSync(this.#dir)) {
      // Dir does not exist (yet). Nothing to scan; treat the in-memory
      // state as authoritative. A subsequent save() / scan() will create
      // it as needed.
      return;
    }
    const st = statSync(this.#dir);
    const mtimeMs = st.mtimeMs;
    if (this.#lastScanMtimeMs === null || mtimeMs > this.#lastScanMtimeMs) {
      await this.scan();
    }
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
        // DAR-923 ac-1: route the sidecar (re-)write through the atomic
        // helper so a concurrent reader either sees the prior sidecar or
        // the new one, never a partial file. Same-fs guard + fsync apply.
        await atomicWrite(sidecarPath, buf);
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
      // Extract `[[name]]` mentions from each body when extraction is
      // enabled (DAR-927). The list is passed alongside the entries to
      // `rebuild` so authored and mention-derived edges share a single
      // dangling pass; this matches the contract test "onDangling callback
      // is invoked for mention-derived dangling edges during rebuild".
      const mentions: { from: string; to: string }[] = [];
      for (const entry of next) {
        mentions.push(...this.#mentionsFor(entry));
      }
      this.#graph.rebuild(next, mentions);
    }
    // Capture the directory mtime AFTER all writes have completed so the
    // next mtime check (search() / list()) compares against the post-write
    // state. If the dir does not exist (no .md files ever written), treat
    // the baseline as 0 -- the first save() will advance the mtime, which
    // we'll observe on the following search() / list().
    this.#lastScanMtimeMs = existsSync(this.#dir) ? statSync(this.#dir).mtimeMs : 0;
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

    // DAR-923 ac-3: hold a per-name advisory lock for the entire write
    // (md + embedding). This serialises racing writers on the same name
    // both within and across processes. Stale locks (>5s) are reclaimed
    // automatically -- see acquireNameLock.
    const release = await acquireNameLock(this.#dir, name);
    try {
      // Re-check disk presence under the lock so another process that won
      // the race (and finished before we acquired) is observed here -- the
      // duplicate-name semantics from DAR-916 are preserved across
      // processes via this on-disk check.
      if (existsSync(mdPath)) {
        throw new Error(
          `MemoryStore.save: a memory file already exists at ${mdPath} (name=\`${name}\`); delete it first to replace`,
        );
      }

      // DAR-923 ac-1: route both the .md and .embedding writes through the
      // atomic helper so a crash mid-write leaves the prior file intact.
      // .md is written first so contentSha is computed against the exact
      // memory the caller passed in (which is what serializeMemory
      // persists post-dedupe).
      const mdBytes = Buffer.from(serializeMemory(memory), 'utf8');
      await atomicWrite(mdPath, mdBytes);

      const sha = contentSha(memory);
      const vector = await this.#embedder.embed(memory.body);
      const buf = encodeSidecar({
        modelId: this.#embedder.modelId,
        dim: this.#embedder.dim,
        contentSha: sha,
        vector,
      });
      await atomicWrite(sidecarPath, buf);

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
        // DAR-927: extract `[[name]]` mentions and add one mentions edge
        // per unique target. The helper handles env-var gating and the
        // self-edge bridge -- see {@link #mentionsFor}.
        for (const edge of this.#mentionsFor(entry)) {
          this.#graph.addMentionsEdge(edge);
        }
      }
      // Refresh the mtime baseline so a search() immediately after save()
      // does not see "the dir changed since last scan" and re-scan from
      // disk (which would be both wasteful and could re-read what we just
      // wrote, embedder-dependent).
      if (existsSync(this.#dir)) {
        this.#lastScanMtimeMs = statSync(this.#dir).mtimeMs;
      }
    } finally {
      // Release on every path -- success and any thrown error -- so the
      // next save() / delete() on the same name can proceed (DAR-923
      // ac-3: "lock not leaked on error path").
      try {
        await release();
      } catch {
        // proper-lockfile may throw if the lock was already released
        // (e.g. stale-lock reclaim by another process); swallow so the
        // original error from inside the try-block surfaces.
      }
    }
  }

  /**
   * Extract `[[name]]` body mentions for a single entry as graph edges.
   *
   * Returns one `{ from, to }` per unique mention target in the entry's
   * body, with two filters applied:
   *
   *   - Env-var gating: when `COMMONPLACE_EXTRACT_MENTIONS=false`, returns
   *     an empty array. Read on every call so tests can flip the variable
   *     at runtime.
   *   - Self-edge bridge: `MemoryGraph.addMentionsEdge` throws on
   *     self-edges by contract, but the tokenizer is a permissive regex
   *     and can produce `from === to` for a body containing
   *     `[[<own-name>]]`. This helper drops those silently so neither
   *     `scan()` (which forwards through `rebuild`) nor `save()` (which
   *     calls `addMentionsEdge` directly) needs to repeat the check.
   *
   * Centralising the extraction shape here -- rather than duplicating it
   * across `scan()` and `save()` -- keeps the env-var gate and the
   * self-edge bridge in one place. If the bridge rule ever changes
   * (e.g. include self-mentions, or use a different graph API), there is
   * exactly one site to update.
   */
  #mentionsFor(entry: { name: string; body: string }): { from: string; to: string }[] {
    if (!mentionsExtractionEnabled()) return [];
    const out: { from: string; to: string }[] = [];
    for (const target of extractMentions(entry.body)) {
      if (target === entry.name) continue;
      out.push({ from: entry.name, to: target });
    }
    return out;
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

    // DAR-923 ac-3: take the same per-name lock that save() holds, so a
    // delete cannot interleave with an in-flight save on the same name.
    const release = await acquireNameLock(this.#dir, name);
    try {
      // Splice the in-memory entry out FIRST under the lock so the store's
      // in-memory-authoritative invariant holds even if a subsequent unlink
      // fails (e.g. EACCES, EBUSY). A partial unlink then leaves only stale
      // on-disk files, which the next scan() reconciles -- it never leaves
      // an in-memory entry whose backing .md has already been removed (the
      // failure mode where search() could return a hit whose bytes can no
      // longer be read). See PR #10 review f-1.
      this.#entries.splice(idx, 1);
      if (this.#graph !== undefined) {
        this.#graph.remove(name);
      }
      if (existsSync(mdPath)) unlinkSync(mdPath);
      if (existsSync(sidecarPath)) unlinkSync(sidecarPath);
      if (existsSync(this.#dir)) {
        this.#lastScanMtimeMs = statSync(this.#dir).mtimeMs;
      }
    } finally {
      try {
        await release();
      } catch {
        // see save()'s release-swallow comment
      }
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
   * Rescan-aware analogue of {@link all} for callers that need to observe
   * external writers (DAR-923 ac-4). Stats the memory directory and forces
   * a full {@link scan} when its mtime has advanced since the last scan;
   * otherwise returns the existing in-memory entry array unchanged.
   *
   * Use this from public API surfaces (MCP tools, CLI listings) where a
   * concurrent process may have written or deleted a memory; use {@link all}
   * directly when the caller is willing to read from cache (e.g. inside a
   * tight loop within a single request).
   *
   * Returns `ReadonlyArray<MemoryEntry>` for the same reason {@link all}
   * does -- the returned array is the store's authoritative state.
   */
  public async list(): Promise<ReadonlyArray<MemoryEntry>> {
    await this.#rescanIfMtimeChanged();
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
    // DAR-923 ac-4: rescan if an external process advanced the dir mtime
    // since our last scan. Cheap stat() in the common no-op case.
    await this.#rescanIfMtimeChanged();

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
