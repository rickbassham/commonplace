/**
 * MCP tool handlers for the four memory tools.
 *
 * - DAR-919 wired the CRUD handlers (`memory_save`, `memory_list`,
 *   `memory_delete`).
 * - DAR-920 wires the search handler (`memory_search`).
 *
 * Each handler validates its arguments at entry, dispatches to the
 * corresponding {@link MemoryStore} method, and returns a JSON-serialisable
 * shape that the MCP server's CallToolRequest dispatcher (in `./server.ts`)
 * wraps in a single text content block.
 *
 * Validation is deliberately manual rather than via a schema library --
 * the contract envelope leaves the choice to the implementer, manual
 * validation has zero new dependencies, and the rejection messages are
 * tailored to name the offending field. Error messages from the store
 * layer (DAR-916 / DAR-917 / DAR-923) are passed through unchanged so they
 * keep mentioning the offending name.
 */

import { join } from 'node:path';

import {
  MEMORY_TYPES,
  RELATION_TYPES,
  validateName,
  type Memory,
  type MemoryType,
  type Relation,
  type RelationType,
} from '../store/memory.js';
import { DEFAULT_SEARCH_LIMIT } from '../store/memory-store.js';
import type { MemoryEntry, MemoryStore, SearchOptions } from '../store/memory-store.js';
import type { ToolArguments, ToolHandler } from './tools.js';

/** Construction options shared by all handler factories. */
export interface HandlerOptions {
  /** The MemoryStore instance the handler will dispatch to. */
  store: MemoryStore;
}

/** Return shape for {@link createMemorySaveHandler}. */
export interface MemorySaveResult {
  saved: {
    name: string;
    type: MemoryType;
    description: string;
  };
  path: string;
}

/** Return shape for {@link createMemoryListHandler}. */
export interface MemoryListResult {
  memories: Array<{
    name: string;
    type: MemoryType;
    description: string;
  }>;
}

/**
 * Build a map from superseded-name -> superseding-name. The map records the
 * first superseding entry found per target (rather than every superseder),
 * which matches the contract test "match for A carries `supersededBy: 'B'`
 * (string equal to the superseding memory's name)" -- the field is a single
 * string, not an array. Multiple superseders is an unusual case that the AC
 * does not specify; we surface only the first encountered.
 *
 * The map is built from `store.all()` -- the entries' frontmatter
 * `supersedes[]` field is the source of truth (the in-memory graph indexes
 * the same data). This keeps the search/list handlers self-contained:
 * neither needs to reach into the store's optional graph instance, and the
 * filter still works whether or not a graph is wired in (DAR-928).
 */
const buildSupersededMap = (entries: ReadonlyArray<MemoryEntry>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const entry of entries) {
    for (const target of entry.supersedes) {
      // Multi-superseder edge case: when two memories both list the same
      // target in their `supersedes:` we keep the FIRST entry encountered.
      // "First" means first in `entries` iteration order, which mirrors
      // `store.all()` -- this reflects file-system/scan order and is NOT
      // contractually stable across rescans. The AC does not specify a
      // deterministic tie-breaker; if a stable value becomes important
      // (e.g. when DAR-930+ exposes graph traversal), pick a tie-break
      // here (lexicographically smallest superseder name would be the
      // simplest) rather than relying on iteration order.
      if (!out.has(target)) {
        out.set(target, entry.name);
      }
    }
  }
  return out;
};

/** Return shape for {@link createMemoryDeleteHandler}. */
export interface MemoryDeleteResult {
  deleted: string;
}

/** A single match in the {@link MemorySearchResult} envelope. */
export interface MemorySearchMatch {
  name: string;
  type: MemoryType;
  description: string;
  /**
   * Full memory body verbatim. Per DAR-920 ac-3 we never truncate, summarise,
   * or otherwise transform the body -- the caller gets exactly what was
   * persisted, so a follow-up read is unnecessary.
   */
  body: string;
  /** Cosine similarity from {@link MemoryStore.search}, rounded to 3 decimals. */
  score: number;
  /**
   * Outgoing graph edges authored on this memory's frontmatter `relations:`
   * list (DAR-925/DAR-929). Always present -- empty array when the memory has
   * no authored outgoing edges.
   *
   * Only the four authored {@link import('../store/memory.js').RelationType}
   * values surface here (`related-to`, `builds-on`, `contradicts`,
   * `child-of`). The `supersedes:` frontmatter list does NOT round-trip
   * through `relations` (`supersededBy` already carries that signal). Body
   * `[[name]]` mention edges (DAR-927) are deliberately excluded too --
   * surfacing them is deferred to the v0.2 `memory_graph` tool (DAR-930+).
   */
  relations: Relation[];
  /**
   * When `includeSuperseded: true` AND this memory is superseded by another
   * memory, the name of the superseding memory. Otherwise the field is
   * omitted entirely (key absent, not `undefined`) so JSON callers can rely
   * on `'supersededBy' in match` as the predicate.
   */
  supersededBy?: string;
}

/** Return shape for {@link createMemorySearchHandler}. */
export interface MemorySearchResult {
  matches: MemorySearchMatch[];
  /** Echoes the input query verbatim (no trimming, no lowercasing). */
  query: string;
  /**
   * Number of entries the store considered for this call -- equal to
   * `store.all().length` at call time, regardless of how many were filtered
   * out by `type` / `threshold` / `limit`. Lets callers reason about whether
   * an empty result reflects a tight filter or an empty corpus.
   */
  totalScanned: number;
}

/**
 * Narrow `value` to a plain `Record<string, unknown>` -- excludes `null`
 * and arrays. Used as the entry-point gate for argument-object validation
 * so subsequent property reads are statically known to be safe.
 */
const isArgsObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Coerce a {@link ToolArguments} value into a plain object. Both `undefined`
 * and an object are accepted; anything else (number, string, array, ...)
 * raises so handlers can rely on the result being a `Record`.
 */
const requireArgsObject = (args: ToolArguments, toolName: string): Record<string, unknown> => {
  if (args === undefined) return {};
  if (!isArgsObject(args)) {
    throw new Error(`${toolName}: arguments must be an object; got ${JSON.stringify(args)}`);
  }
  return args;
};

/**
 * Validate a required `string` field. Throws with a message that names the
 * offending field when missing or not a string.
 */
const requireString = (args: Record<string, unknown>, field: string, toolName: string): string => {
  const value = args[field];
  if (value === undefined) {
    throw new Error(`${toolName}: missing required field \`${field}\` (string)`);
  }
  if (typeof value !== 'string') {
    throw new Error(
      `${toolName}: field \`${field}\` must be a string; got ${JSON.stringify(value)}`,
    );
  }
  return value;
};

/**
 * Validate a memory `name` argument by delegating to `validateName` from
 * `src/store/memory.ts`. Centralising the format/separator/pattern checks
 * keeps the handler layer in lockstep with the store: if `NAME_PATTERN`
 * changes (or the empty-string message is tightened), the handler picks
 * that up automatically.
 *
 * The `requireString` helper still owns the "missing required field"
 * message because it has tool-specific phrasing the store-level helper
 * doesn't carry; everything from there onward (non-empty, no path
 * separator, pattern) is validateName's responsibility.
 */
const validateMemoryName = (name: string, toolName: string): void => {
  validateName(name, `${toolName}: field \`name\``);
};

/**
 * Validate a `type` argument against {@link MEMORY_TYPES}. Errors list the
 * allowed values so callers can recover. Returns the narrowed
 * {@link MemoryType}.
 */
const isMemoryType = (v: unknown): v is MemoryType =>
  typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);

const validateMemoryType = (raw: unknown, toolName: string): MemoryType => {
  if (!isMemoryType(raw)) {
    throw new Error(
      `${toolName}: field \`type\` must be one of ${MEMORY_TYPES.join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Construct the `memory_save` handler bound to a specific store. Validates
 * the `{ name, type, description, body }` argument shape and dispatches to
 * `store.save()`. The path returned to the client is the canonical
 * `<dir>/<name>.md` location; we reconstruct it here from the store's
 * directory so the MCP layer can render a clickable hint without reaching
 * into the store's internals.
 */
export const createMemorySaveHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemorySaveResult> => {
    const args = requireArgsObject(rawArgs, 'memory_save');
    const name = requireString(args, 'name', 'memory_save');
    validateMemoryName(name, 'memory_save');
    const type = validateMemoryType(args.type, 'memory_save');
    const description = requireString(args, 'description', 'memory_save');
    const body = requireString(args, 'body', 'memory_save');

    const memory: Memory = { name, type, description, body };
    await store.save(memory);

    // Path is reconstructed here rather than returned by the store so the
    // store's on-disk layout stays an implementation detail.
    const path = join(store.dir, `${name}.md`);
    return {
      saved: { name, type, description },
      path,
    };
  };
};

/**
 * Construct the `memory_list` handler bound to a specific store. Recognised
 * fields on the optional arguments object:
 *
 *   - `type` -- restrict results to entries of this {@link MemoryType}.
 *   - `includeSuperseded` (DAR-929) -- when `true`, include memories that
 *     have been superseded by another memory; default `false`, which omits
 *     them from the response.
 *
 * The response strips the body and any graph metadata, matching the
 * documented frontmatter-only shape; per the DAR-929 contract, `relations`
 * is NOT mirrored on `memory_list` -- only `memory_search` matches gain
 * outgoing relations. The `includeSuperseded` flag is mirrored here so
 * callers can scan the corpus consistently across both tools.
 */
export const createMemoryListHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemoryListResult> => {
    const args = requireArgsObject(rawArgs, 'memory_list');
    let filter: MemoryType | undefined;
    if (args.type !== undefined) {
      filter = validateMemoryType(args.type, 'memory_list');
    }
    const includeSuperseded =
      validateBoolean(args.includeSuperseded, 'includeSuperseded', 'memory_list') ?? false;

    const entries = await store.list();
    let candidates = filter === undefined ? entries : entries.filter((e) => e.type === filter);
    if (!includeSuperseded) {
      // Build the superseded map from the (post-rescan) entry list; only
      // entries that appear as a target in some loaded memory's
      // `supersedes[]` are filtered out. Building from the same array we
      // filter avoids any race between rescan and filter.
      const supersededMap = buildSupersededMap(entries);
      candidates = candidates.filter((e) => !supersededMap.has(e.name));
    }
    return {
      memories: candidates.map((e) => ({
        name: e.name,
        type: e.type,
        description: e.description,
      })),
    };
  };
};

/**
 * Validate a `limit` argument. Per DAR-917 the search store layer delegates
 * limit sanitisation to the MCP layer; we accept positive integers, reject
 * everything else (NaN, negatives, non-integers, non-numbers) with a message
 * naming the field. `undefined` is allowed -- the handler picks
 * {@link DEFAULT_SEARCH_LIMIT}.
 */
const validateLimit = (raw: unknown, toolName: string): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `${toolName}: field \`limit\` must be a positive integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `${toolName}: field \`limit\` must be a positive integer; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Validate an optional boolean field. `undefined` is allowed (returns
 * `undefined`); anything else must be a literal boolean. The error message
 * names the offending field so the caller's UI can highlight it.
 *
 * Used by both `memory_search` and `memory_list` for `includeSuperseded`
 * (DAR-929). We deliberately reject truthy strings like `'true'` and
 * numerics like `1` so callers learn the type contract early -- this keeps
 * the wire shape predictable across MCP clients (some of which would
 * happily pass `'true'` if accepted).
 */
const validateBoolean = (raw: unknown, field: string, toolName: string): boolean | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `${toolName}: field \`${field}\` must be a boolean; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Validate a `threshold` argument. Optional; when present must be a finite
 * number (no further bound -- the store's cosine range is `[-1, 1]` but we
 * don't enforce that here, the store does).
 */
const validateThreshold = (raw: unknown, toolName: string): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `${toolName}: field \`threshold\` must be a finite number; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Round a cosine similarity score to 3 decimal places per the documented
 * response shape. We multiply, round, divide rather than using `toFixed` so
 * the return value stays a `number` (toFixed returns a string and the test
 * matrix asserts JSON-numeric scores).
 *
 * Note: floating-point representation of 0.001 is not exact, so the rounded
 * value is the closest IEEE-754 double to the mathematical 3-decimal value.
 * Callers that need to display the score with exactly three digits should
 * format on display, not depend on the byte representation here.
 */
const roundScore = (score: number): number => Math.round(score * 1000) / 1000;

/**
 * Construct the `memory_search` handler bound to a specific store. Validates
 * the `{ query, limit?, type?, threshold?, includeSuperseded? }` argument
 * shape, dispatches to `store.search()`, applies the DAR-929 supersede
 * filter, and serialises the {@link SearchHit}s into the documented
 * `{ matches, query, totalScanned }` envelope.
 *
 * Why this shape:
 *
 *   - `matches[].body` is the full memory body verbatim per ac-3, so the
 *     caller does not need a follow-up `memory_list` + read to act on a
 *     hit.
 *   - `score` is rounded to 3 decimals (ac-3) -- enough resolution to rank
 *     ties but compact enough for in-context display.
 *   - `query` echoes the input verbatim (ac-6) so the caller can pair the
 *     response with the original prompt without round-tripping their own
 *     state.
 *   - `totalScanned` reflects the entries the store actually considered
 *     post-supersede-filter (DAR-929 ac-2) -- distinct from `matches.length`,
 *     which can be lower because of `type` / `threshold` / `limit`. When
 *     `includeSuperseded: true` is passed, `totalScanned` reflects the full
 *     corpus including superseded entries (the filter is a no-op).
 *
 * Limit sanitisation is the MCP tool layer's responsibility per DAR-917; we
 * reject NaN / negative / non-integer `limit` values rather than coercing.
 *
 * Why we apply the supersede filter AFTER calling `store.search`:
 *
 *   - The store has no notion of "exclude superseded"; it ranks every entry
 *     in `all()` against the query and slices to `limit`.
 *   - If we passed the caller's `limit` straight through to the store, a
 *     top-ranked superseded entry would consume one of the slots and the
 *     final response would be short by one. So we omit the caller's
 *     `limit` from the store call (the store ranks everything), drop
 *     superseded entries here, and then take the caller's `limit` slice.
 *
 * The filter source-of-truth is the entries' frontmatter `supersedes[]`
 * field via {@link buildSupersededMap}; we do not depend on the store's
 * optional graph instance, so the filter works in test setups that do not
 * wire a graph (and matches the graph's `isSuperseded` semantics: an entry
 * is excluded iff some loaded memory has it in its `supersedes[]`).
 *
 * Out of scope (per the DAR-929 contract envelope): one-hop expansion
 * (DAR-930), connectedness boost (DAR-931), env-var resolution for
 * `COMMONPLACE_DEFAULT_LIMIT` (DAR-913), reranking, snippet generation,
 * and surfacing `mentions` edges in match.relations.
 */
export const createMemorySearchHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemorySearchResult> => {
    const args = requireArgsObject(rawArgs, 'memory_search');
    const query = requireString(args, 'query', 'memory_search');

    // Build SearchOptions with only the fields the caller actually
    // supplied. Per DAR-920's contract test "omits unset SearchOptions
    // fields when the corresponding tool argument is absent", we must not
    // inject defaults at this layer -- the store's internal default of 5
    // (DAR-917) takes effect when `limit` is omitted. Once DAR-913 lands
    // env-var resolution for `COMMONPLACE_DEFAULT_LIMIT`, that resolver
    // will own the override; re-reading the env var here would duplicate
    // its scope.
    const searchOpts: SearchOptions = {};
    const callerLimit = validateLimit(args.limit, 'memory_search');
    if (callerLimit !== undefined) {
      searchOpts.limit = callerLimit;
    }
    if (args.type !== undefined) {
      searchOpts.type = validateMemoryType(args.type, 'memory_search');
    }
    const threshold = validateThreshold(args.threshold, 'memory_search');
    if (threshold !== undefined) {
      searchOpts.threshold = threshold;
    }
    const includeSuperseded =
      validateBoolean(args.includeSuperseded, 'includeSuperseded', 'memory_search') ?? false;

    // DAR-929: when filtering out superseded entries the post-filter set
    // could be smaller than the caller's `limit`. The store does not know
    // about supersedes, so it slices to `limit` first; we enlarge the
    // store-side limit so enough candidates survive the filter.
    //
    // The contract for the DAR-920 "omits unset SearchOptions fields"
    // test must continue to hold: when the caller passes no `limit` we do
    // NOT inject one for the include-superseded path. For the filter
    // path, we need *something* large enough to give the supersede pass
    // headroom, so we set a corpus-bound ceiling -- only when
    // `includeSuperseded` is false AND the store's default would be too
    // small to clear the filter.
    if (!includeSuperseded) {
      const corpusSize = store.all().length;
      const desired = callerLimit ?? DEFAULT_SEARCH_LIMIT;
      // Headroom = full corpus, so even if every other entry is superseded
      // we still surface `desired` non-superseded matches (when they exist).
      const headroom = Math.max(desired, corpusSize);
      // Only override the store-side limit when the corpus is bigger than
      // the headroom we'd have used naturally.
      if (callerLimit === undefined && corpusSize > DEFAULT_SEARCH_LIMIT) {
        searchOpts.limit = headroom;
      } else if (callerLimit !== undefined && headroom > callerLimit) {
        searchOpts.limit = headroom;
      }
    }

    // Reading store.all() after store.search() returns intentionally
    // captures any rescan store.search performed internally (DAR-923 mtime
    // watch), so subsequent reads of `all()` reflect the post-rescan view
    // the caller would observe via list().
    const hits = await store.search(query, searchOpts);
    const allEntries = store.all();
    const supersededMap = buildSupersededMap(allEntries);

    // totalScanned is the size of the corpus the store considered AFTER the
    // supersede filter (when not including superseded). When including, we
    // report the full corpus. This mirrors the contract test for ac-2.
    const totalScanned = includeSuperseded
      ? allEntries.length
      : allEntries.length - countSupersededInCorpus(allEntries, supersededMap);

    const filteredHits = includeSuperseded
      ? hits
      : hits.filter((hit) => !supersededMap.has(hit.memory.name));

    const sliceLimit = callerLimit ?? DEFAULT_SEARCH_LIMIT;
    const limited = filteredHits.slice(0, sliceLimit);

    const matches: MemorySearchMatch[] = limited.map((hit) => {
      // Authored relations only: filter to the four RelationType values is
      // implicit since `entry.relations` is `Relation[]` and `Relation.type`
      // is constrained to the four authored types at parse time. The
      // `mentions`/`supersedes` edge types live on the in-memory graph,
      // not on the entry; reading from `entry.relations` therefore
      // structurally excludes them.
      const projection: MemorySearchMatch = {
        name: hit.memory.name,
        type: hit.memory.type,
        description: hit.memory.description,
        body: hit.memory.body,
        score: roundScore(hit.score),
        relations: hit.memory.relations.map((r) => ({ to: r.to, type: r.type })),
      };
      if (includeSuperseded) {
        const superseder = supersededMap.get(hit.memory.name);
        if (superseder !== undefined) {
          projection.supersededBy = superseder;
        }
      }
      return projection;
    });

    return { matches, query, totalScanned };
  };
};

/**
 * Count how many entries in `entries` are superseded according to the map.
 * Exists as a named helper so the call site reads naturally and the cost
 * (one linear pass) is obvious -- the alternative inline `entries.filter`
 * would allocate a discarded array on every search.
 */
const countSupersededInCorpus = (
  entries: ReadonlyArray<MemoryEntry>,
  supersededMap: ReadonlyMap<string, string>,
): number => {
  let n = 0;
  for (const entry of entries) {
    if (supersededMap.has(entry.name)) n++;
  }
  return n;
};

/**
 * Construct the `memory_delete` handler bound to a specific store. Requires
 * a `name` field and dispatches to `store.delete()`. The store throws when
 * the name is not present; we let that error surface so the MCP dispatcher
 * wraps it as an `isError` CallToolResult whose message names the missing
 * memory.
 */
export const createMemoryDeleteHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemoryDeleteResult> => {
    const args = requireArgsObject(rawArgs, 'memory_delete');
    const name = requireString(args, 'name', 'memory_delete');
    // Delete dispatches the raw name; `store.delete` rejects unknown names
    // with a message containing the offending name (DAR-916), which is
    // what the ac-2 missing-name test asserts against.
    await store.delete(name);
    return { deleted: name };
  };
};

/** Return shape for {@link createMemoryLinkHandler}. */
export interface MemoryLinkResult {
  from: string;
  to: string;
  type: RelationType | 'supersedes';
  relations: Relation[];
  supersedes: string[];
}

/** Return shape for {@link createMemoryUnlinkHandler}. */
export interface MemoryUnlinkResult {
  from: string;
  to: string;
  type?: RelationType | 'supersedes';
  relations: Relation[];
  supersedes: string[];
  /** Present only when the requested edge did not exist (no-op case). */
  note?: string;
}

/**
 * Validate the `type` argument shared by `memory_link` and `memory_unlink`.
 * Accepts the four authored {@link RELATION_TYPES} values plus the special
 * `'supersedes'` literal. Returns `undefined` when the argument is omitted
 * (caller decides the per-tool default).
 */
const isLinkType = (v: unknown): v is RelationType | 'supersedes' =>
  typeof v === 'string' &&
  ((RELATION_TYPES as readonly string[]).includes(v) || v === 'supersedes');

const validateLinkType = (
  raw: unknown,
  toolName: string,
): RelationType | 'supersedes' | undefined => {
  if (raw === undefined) return undefined;
  if (!isLinkType(raw)) {
    throw new Error(
      `${toolName}: field \`type\` must be one of ${[...RELATION_TYPES, 'supersedes'].join(
        ', ',
      )}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Construct the `memory_link` handler bound to a specific store. Validates
 * the `{ from, to, type? }` argument shape, defaults `type` to
 * `'related-to'`, and dispatches to {@link MemoryStore.linkEdge}, which:
 *
 *   - rejects self-edges, missing targets, and duplicate `(to, type)`
 *     edges before any disk write
 *   - rewrites the source `.md` through the DAR-923 atomic helper
 *   - updates the in-memory entry and the store's `graph` (when one was
 *     passed at construction time) incrementally (no scan, no rebuild)
 *
 * The graph is owned by the {@link MemoryStore} (passed to its constructor).
 * The handler factory deliberately does NOT take a `graph` option so there
 * is no second source of truth to keep aligned -- whatever graph the store
 * holds is the one that gets updated.
 *
 * `'supersedes'` routes to the `supersedes[]` field rather than
 * `relations[]`, matching the documented tool behaviour.
 */
export const createMemoryLinkHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemoryLinkResult> => {
    const args = requireArgsObject(rawArgs, 'memory_link');
    const from = requireString(args, 'from', 'memory_link');
    validateMemoryName(from, 'memory_link');
    const to = requireString(args, 'to', 'memory_link');
    validateMemoryName(to, 'memory_link');
    const type = validateLinkType(args.type, 'memory_link') ?? 'related-to';

    const result = await store.linkEdge({ from, to, type });
    return {
      from,
      to,
      type,
      relations: result.relations,
      supersedes: result.supersedes,
    };
  };
};

/**
 * Construct the `memory_unlink` handler. Mirrors
 * {@link createMemoryLinkHandler}: validates `{ from, to, type? }`, then
 * dispatches to {@link MemoryStore.unlinkEdge}.
 *
 * When `type` is omitted, the store removes every edge from -> to
 * regardless of type. When the requested edge is not present, the store
 * returns a `note` describing the no-op and we propagate it on the
 * response so the MCP client can surface "nothing to unlink" without
 * having to interpret an error.
 */
export const createMemoryUnlinkHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemoryUnlinkResult> => {
    const args = requireArgsObject(rawArgs, 'memory_unlink');
    const from = requireString(args, 'from', 'memory_unlink');
    validateMemoryName(from, 'memory_unlink');
    const to = requireString(args, 'to', 'memory_unlink');
    validateMemoryName(to, 'memory_unlink');
    const type = validateLinkType(args.type, 'memory_unlink');

    const result = await store.unlinkEdge({ from, to, type });
    const out: MemoryUnlinkResult = {
      from,
      to,
      relations: result.relations,
      supersedes: result.supersedes,
    };
    if (type !== undefined) out.type = type;
    if (result.note !== undefined) out.note = result.note;
    return out;
  };
};
