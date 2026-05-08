/**
 * Migration CLI helper -- `--prune-dangling` slice (DAR-926).
 *
 * The full migrate CLI (`commonplace migrate <dir>`) is owned by DAR-918:
 * sidecar (re)embedding, orphaned-sidecar cleanup, `--dry-run`, exit-code
 * conventions, and human-readable summary output. This module currently
 * implements ONLY the `--prune-dangling` slice required by DAR-926 ac-6:
 *
 *   - load every `.md` in the directory through `MemoryStore.scan`
 *   - build the in-memory graph and detect dangling edges
 *   - when `pruneDangling` is true, rewrite each affected `.md` with the
 *     dangling entries dropped from `relations[]` and `supersedes[]`
 *   - report per-file pruned-edge counts in the returned summary
 *
 * When DAR-918 lands it will subsume `runMigrate` -- adding the embedded /
 * re-embedded / orphaned counts and the bin entry -- without breaking the
 * `pruneDangling` contract documented here.
 *
 * # Atomicity
 *
 * `--prune-dangling` uses the same plain `writeFileSync` path as the rest
 * of the codebase. Crash-safe atomic write-temp+rename and fsync semantics
 * are owned by DAR-923; "atomic" in the AC text is interpreted at the
 * per-file granularity (whole-file rewrite via `writeMemory`).
 */

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
  /** Total memories loaded by the underlying scan. */
  loaded: number;
  /** Total sidecars (re)written by the underlying scan. */
  reembedded: number;
  /** One entry per .md that had dangling edges pruned. Empty when nothing to prune. */
  pruned: PrunedFile[];
}

/**
 * Programmatic entry point used by tests and the bin shim. The thin
 * argv-parsing wrapper that DAR-918 will add as `bin/commonplace migrate`
 * delegates to this function.
 */
export const runMigrate = async (opts: MigrateOptions): Promise<MigrateResult> => {
  const graph = new MemoryGraph({ onDangling: () => {} });
  const store = new MemoryStore({ dir: opts.dir, embedder: opts.embedder, graph });
  const scan = await store.scan();

  const pruned: PrunedFile[] = [];
  if (opts.pruneDangling) {
    const dangling = graph.detectDangling();
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

        writeMemory(mdPath, {
          name: memory.name,
          description: memory.description,
          type: memory.type,
          body: memory.body,
          relations: filteredRelations,
          supersedes: filteredSupersedes,
        });
        pruned.push({ name, edgesPruned: removed });
      }
    }
  }

  return {
    loaded: scan.loaded,
    reembedded: scan.reembedded,
    pruned,
  };
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
