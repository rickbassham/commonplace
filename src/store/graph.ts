/**
 * In-memory adjacency list + dangling-edge detection (DAR-926).
 *
 * `MemoryGraph` indexes the typed graph fields exposed by DAR-925
 * (`relations[]` and `supersedes[]`) plus a representable `mentions` edge
 * type that DAR-927 will plug into. It is consumed by `MemoryStore`
 * (DAR-916), which:
 *
 *   - calls `rebuild(entries)` once per `scan()`
 *   - calls `add(entry)` once per `save(entry)`
 *   - calls `remove(name)` once per `delete(name)`
 *
 * The graph holds only the (from, to, type) shape -- it does NOT cache the
 * `MemoryEntry` body, vector, or sidecar metadata. That keeps the graph
 * cheap to update and free of stale-entry concerns.
 *
 * # Complexity
 *
 *   - `outbound(name)` and `inbound(name)` are O(1) -- both back onto
 *     `Map<string, Edge[]>` and return the existing array (or `[]` when
 *     the name is unknown).
 *   - `add(memory)` is O(|memory.relations| + |memory.supersedes|) in the
 *     authored degree of the new memory; it does not scan existing entries.
 *   - `remove(name)` is O(|outbound(name)| + |inbound(name)|): it walks the
 *     two adjacency lists for `name` and splices it out of the matching
 *     inbound/outbound buckets. It does NOT visit unrelated memories.
 *
 * # Dangling edges
 *
 * An edge is "dangling" when its `to` does not resolve to a loaded memory
 * name. The graph still stores the edge (so `outbound`/`inbound` return it
 * for diagnostic purposes). `detectDangling()` returns the full set, and
 * `rebuild()` invokes the configured `onDangling` callback once per
 * dangling edge during the rebuild. The default callback emits a
 * `console.warn`. Dangling edges are non-fatal by design -- the graph is
 * advisory metadata, not a referential-integrity guarantee.
 *
 * # Self-edges
 *
 * DAR-925 already rejects self-edges at parse time. The graph asserts the
 * same invariant defensively: callers that bypass `readMemory` (e.g. tests,
 * future incremental APIs) can't introduce a self-edge silently.
 *
 * # Out of scope
 *
 *   - Cycle detection or rejection. Cycles are allowed and only tracked.
 *   - Centrality / PageRank (DAR-931).
 *   - Traversal / path queries (DAR-932).
 *   - The `[[name]]` mention extractor (DAR-927). This module exposes
 *     `addMentionsEdge` so DAR-927 can plug in without schema changes.
 */

import type { Relation, RelationType } from './memory.js';

/**
 * Edge type union. `RelationType` is the four authored types
 * (`related-to`, `builds-on`, `contradicts`, `child-of`); `'supersedes'`
 * comes from the `supersedes[]` frontmatter field; `'mentions'` is reserved
 * for DAR-927's body-tokenizer output.
 */
export type EdgeType = RelationType | 'supersedes' | 'mentions';

/** A single directed edge stored in the graph. */
export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
}

/**
 * A dangling edge: identical shape to {@link Edge}, but `type` is widened
 * to `string` per the issue's `DanglingEdge` API. Returned as a plain
 * `Edge` shape today; the wider type lets future callers store
 * extension-defined edge types without re-typing the signature.
 */
export interface DanglingEdge {
  from: string;
  to: string;
  type: string;
}

/**
 * Minimum shape the graph needs from a memory: its name plus the two
 * authored graph fields. `MemoryEntry` (DAR-916) and `Memory` (DAR-925)
 * both satisfy this -- the graph never reads body, vector, or sha.
 */
export interface GraphMemory {
  name: string;
  relations: ReadonlyArray<Relation>;
  supersedes: ReadonlyArray<string>;
}

/** Construction options. All fields optional. */
export interface MemoryGraphOptions {
  /**
   * Called once per dangling edge during {@link MemoryGraph.rebuild}. The
   * default emits a `console.warn`. Callers who want silence can pass
   * `() => {}`.
   */
  onDangling?: (edge: DanglingEdge) => void;
}

const defaultOnDangling = (edge: DanglingEdge): void => {
  console.warn(
    `MemoryGraph: dangling edge ${edge.from} -> ${edge.to} (type=${edge.type}); target not found among loaded memories`,
  );
};

/**
 * In-memory adjacency list keyed by both endpoints. See file header for
 * the contract.
 */
export class MemoryGraph {
  /** outbound[from] -> Edge[]. Edges authored BY `from`. */
  readonly #outbound = new Map<string, Edge[]>();
  /** inbound[to]  -> Edge[]. Edges authored TO `to`. */
  readonly #inbound = new Map<string, Edge[]>();
  /** Set of all names that have been added to the graph. */
  readonly #names = new Set<string>();
  /**
   * For each name, the set of names that supersede it. Lets `isSuperseded`
   * answer in O(1) without scanning every memory's supersedes list.
   */
  readonly #supersededBy = new Map<string, Set<string>>();
  readonly #onDangling: (edge: DanglingEdge) => void;

  public constructor(opts: MemoryGraphOptions = {}) {
    this.#onDangling = opts.onDangling ?? defaultOnDangling;
  }

  /**
   * Discard all existing state and rebuild the adjacency from `memories`.
   * Invokes the configured `onDangling` callback once per edge whose `to`
   * does not resolve to a loaded memory.
   */
  public rebuild(memories: ReadonlyArray<GraphMemory>): void {
    this.#outbound.clear();
    this.#inbound.clear();
    this.#names.clear();
    this.#supersededBy.clear();

    for (const m of memories) {
      this.#assertNoSelfEdges(m);
      this.#names.add(m.name);
    }
    for (const m of memories) {
      this.#insertEdges(m);
    }
    for (const edge of this.detectDangling()) {
      this.#onDangling(edge);
    }
  }

  /**
   * Insert `memory` into the graph incrementally without rebuilding from
   * scratch. Used by `MemoryStore.save`. The dangling callback is NOT fired
   * here: callers that need to know about dangling edges added by `add()`
   * can call {@link detectDangling} after the save.
   */
  public add(memory: GraphMemory): void {
    this.#assertNoSelfEdges(memory);
    if (this.#names.has(memory.name)) {
      throw new Error(
        `MemoryGraph.add: memory \`${memory.name}\` is already present; remove it first to replace`,
      );
    }
    this.#names.add(memory.name);
    this.#insertEdges(memory);
  }

  /**
   * Remove `name` from the graph incrementally. Drops its outbound edges
   * and removes it as a target from any inbound buckets pointing at it.
   * Also clears any superseded-by entries owned by this name.
   *
   * Silent no-op when `name` is not present (matches the in-memory-first
   * `MemoryStore.delete` contract: callers may have already removed it).
   */
  public remove(name: string): void {
    if (!this.#names.has(name)) return;

    // Drop edges authored BY `name`. For each, remove the matching entry
    // from the inbound[edge.to] bucket; if that bucket becomes empty,
    // delete it so the index map stays clean (incremental updates must
    // leave no residue).
    const out = this.#outbound.get(name);
    if (out !== undefined) {
      for (const edge of out) {
        removeEdgeFromMap(this.#inbound, edge.to, edge);
        if (edge.type === 'supersedes') {
          const supers = this.#supersededBy.get(edge.to);
          if (supers !== undefined) {
            supers.delete(name);
            if (supers.size === 0) this.#supersededBy.delete(edge.to);
          }
        }
      }
      this.#outbound.delete(name);
    }

    // Drop edges authored TO `name`. For each, remove the matching entry
    // from the outbound[edge.from] bucket.
    const inb = this.#inbound.get(name);
    if (inb !== undefined) {
      for (const edge of inb) {
        removeEdgeFromMap(this.#outbound, edge.from, edge);
        if (edge.type === 'supersedes') {
          const supers = this.#supersededBy.get(name);
          if (supers !== undefined) {
            supers.delete(edge.from);
            if (supers.size === 0) this.#supersededBy.delete(name);
          }
        }
      }
      this.#inbound.delete(name);
    }

    this.#supersededBy.delete(name);
    this.#names.delete(name);
  }

  /** O(1) outbound neighbour lookup. Returns `[]` for unknown names. */
  public outbound(name: string): Edge[] {
    const bucket = this.#outbound.get(name);
    return bucket === undefined ? [] : bucket.slice();
  }

  /** O(1) inbound neighbour lookup. Returns `[]` for unknown names. */
  public inbound(name: string): Edge[] {
    const bucket = this.#inbound.get(name);
    return bucket === undefined ? [] : bucket.slice();
  }

  /**
   * True when any other memory has `name` in its `supersedes[]`. Memories
   * that supersede others but are not themselves superseded return false.
   */
  public isSuperseded(name: string): boolean {
    const supers = this.#supersededBy.get(name);
    return supers !== undefined && supers.size > 0;
  }

  /**
   * Return every edge whose `to` does not resolve to a loaded memory.
   * Used both at rebuild time (callback) and by the migrate CLI's
   * `--prune-dangling` flag.
   */
  public detectDangling(): DanglingEdge[] {
    const out: DanglingEdge[] = [];
    for (const bucket of this.#outbound.values()) {
      for (const edge of bucket) {
        if (!this.#names.has(edge.to)) {
          out.push({ from: edge.from, to: edge.to, type: edge.type });
        }
      }
    }
    return out;
  }

  /**
   * Add a `mentions` edge from one loaded memory to another. The edge is
   * stored alongside authored edges and shows up in `outbound`/`inbound`
   * results. DAR-927 will own the body-tokenizer that decides which
   * mentions to add; this method is the integration point.
   */
  public addMentionsEdge(args: { from: string; to: string }): void {
    if (args.from === args.to) {
      throw new Error(
        `MemoryGraph.addMentionsEdge: self-edge ${args.from} -> ${args.to} is not allowed`,
      );
    }
    const edge: Edge = { from: args.from, to: args.to, type: 'mentions' };
    appendEdge(this.#outbound, args.from, edge);
    appendEdge(this.#inbound, args.to, edge);
  }

  /**
   * True when an outbound bucket for `name` exists in the precomputed map.
   * Exposed for the O(1) structural assertion in tests; not part of the
   * public consumer API.
   */
  public hasOutboundIndex(name: string): boolean {
    return this.#outbound.has(name);
  }

  /** Counterpart of {@link hasOutboundIndex} for the inbound map. */
  public hasInboundIndex(name: string): boolean {
    return this.#inbound.has(name);
  }

  /**
   * Deep copy of the internal state suitable for deep-equality comparison
   * in tests (ac-4: "after add+remove the state is byte-equal to before").
   * Not intended for hot-path callers.
   */
  public snapshot(): {
    outbound: Record<string, Edge[]>;
    inbound: Record<string, Edge[]>;
    names: string[];
    supersededBy: Record<string, string[]>;
  } {
    const out: Record<string, Edge[]> = {};
    for (const [k, v] of this.#outbound) out[k] = v.map((e) => ({ ...e }));
    const inb: Record<string, Edge[]> = {};
    for (const [k, v] of this.#inbound) inb[k] = v.map((e) => ({ ...e }));
    const sup: Record<string, string[]> = {};
    for (const [k, v] of this.#supersededBy) sup[k] = [...v].sort();
    return {
      outbound: out,
      inbound: inb,
      names: [...this.#names].sort(),
      supersededBy: sup,
    };
  }

  // ----------------------------- internals -----------------------------

  #assertNoSelfEdges(memory: GraphMemory): void {
    for (const rel of memory.relations) {
      if (rel.to === memory.name) {
        throw new Error(
          `MemoryGraph: memory \`${memory.name}\` has a self-edge in relations (\`to\` equals \`name\`)`,
        );
      }
    }
    for (const sup of memory.supersedes) {
      if (sup === memory.name) {
        throw new Error(
          `MemoryGraph: memory \`${memory.name}\` has a self-edge in supersedes (entry equals \`name\`)`,
        );
      }
    }
  }

  #insertEdges(memory: GraphMemory): void {
    for (const rel of memory.relations) {
      const edge: Edge = { from: memory.name, to: rel.to, type: rel.type };
      appendEdge(this.#outbound, memory.name, edge);
      appendEdge(this.#inbound, rel.to, edge);
    }
    for (const sup of memory.supersedes) {
      const edge: Edge = { from: memory.name, to: sup, type: 'supersedes' };
      appendEdge(this.#outbound, memory.name, edge);
      appendEdge(this.#inbound, sup, edge);
      let supers = this.#supersededBy.get(sup);
      if (supers === undefined) {
        supers = new Set<string>();
        this.#supersededBy.set(sup, supers);
      }
      supers.add(memory.name);
    }
  }
}

const appendEdge = (map: Map<string, Edge[]>, key: string, edge: Edge): void => {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = [];
    map.set(key, bucket);
  }
  bucket.push(edge);
};

const removeEdgeFromMap = (map: Map<string, Edge[]>, key: string, edge: Edge): void => {
  const bucket = map.get(key);
  if (bucket === undefined) return;
  for (let i = 0; i < bucket.length; i++) {
    const candidate = bucket[i]!;
    if (candidate.from === edge.from && candidate.to === edge.to && candidate.type === edge.type) {
      bucket.splice(i, 1);
      break;
    }
  }
  if (bucket.length === 0) {
    map.delete(key);
  }
};
