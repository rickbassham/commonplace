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
import type { MemoryEntry, MemoryStore, SearchHit, SearchOptions } from '../store/memory-store.js';
import type { EdgeType, MemoryGraph } from '../store/graph.js';
import type { ToolArguments, ToolHandler } from './tools.js';

/**
 * The two store scopes the server can address (DAR-924).
 *
 * - `'user'` -- the user-level store (always loaded). Personal rules,
 *   preferences, hard feedback. Located under `COMMONPLACE_USER_DIR` (or
 *   `~/.commonplace/memory`).
 * - `'project'` -- the project-level store (loaded only when a project root
 *   is detected via env / roots / cwd). Located under
 *   `COMMONPLACE_PROJECT_DIR` or `<project-root>/.commonplace/memory`.
 */
export type Scope = 'user' | 'project';

/** The two scope literals as a constant array, useful for enum schemas. */
export const SCOPES: readonly Scope[] = ['user', 'project'] as const;

/**
 * Construction options shared by all handler factories. Two shapes are
 * accepted:
 *
 *   - `{ store }` -- legacy single-store form (DAR-919). Treated as
 *     user-only mode: `store` becomes the user store and no project store
 *     is wired. Existing callers (and tests) that pass this shape continue
 *     to work; saves with `scope: 'project'` will be rejected.
 *
 *   - `{ userStore, projectStore? }` -- DAR-924 dual-store form. The user
 *     store is required; the project store is omitted in user-only mode.
 *
 * Mixing both fields (e.g. `{ store, userStore }`) is not supported -- the
 * `userStore` field wins so the new shape can be adopted incrementally.
 */
export interface HandlerOptions {
  /**
   * Legacy single-store option. Treated as the user store when supplied
   * without a `userStore` field.
   *
   * @deprecated Prefer `userStore` (and optional `projectStore`).
   */
  store?: MemoryStore;
  /** The user-level memory store. Always required when `store` is unset. */
  userStore?: MemoryStore;
  /** The project-level memory store, when one was detected. */
  projectStore?: MemoryStore;
  /**
   * Default top-k applied by `memory_search` when the caller omits
   * `limit`. Resolved by the bin from `COMMONPLACE_DEFAULT_LIMIT`
   * (DAR-913). When omitted, the search handler falls back to
   * {@link DEFAULT_SEARCH_LIMIT}. Other handlers ignore this option.
   */
  defaultLimit?: number;
  /**
   * The user-scope {@link MemoryGraph} used for one-hop expansion in
   * `memory_search` (DAR-930). Threaded through the bin from the user
   * `MemoryStore`'s graph. When omitted, `expand: 'one-hop'` requests still
   * validate but produce no expanded neighbors for the user scope.
   */
  userGraph?: MemoryGraph;
  /**
   * The project-scope {@link MemoryGraph} used for one-hop expansion in
   * `memory_search` (DAR-930). Threaded through the bin from the project
   * `MemoryStore`'s graph when a project store was detected. When omitted,
   * `expand: 'one-hop'` requests still validate but produce no expanded
   * neighbors for the project scope.
   */
  projectGraph?: MemoryGraph;
  /**
   * Decay applied to expanded neighbors' scores in `memory_search`
   * (DAR-930). Resolved by the bin from `COMMONPLACE_EXPANSION_DECAY`.
   * Defaults to `0.7` when omitted.
   */
  expansionDecay?: number;
}

/**
 * Resolve {@link HandlerOptions} into the canonical
 * `{ userStore, projectStore? }` pair the handler bodies expect. Throws
 * when neither `store` nor `userStore` was supplied -- handlers cannot run
 * without at least the user store.
 */
const resolveStores = (
  opts: HandlerOptions,
  toolName: string,
): { userStore: MemoryStore; projectStore: MemoryStore | undefined } => {
  const userStore = opts.userStore ?? opts.store;
  if (userStore === undefined) {
    throw new Error(`${toolName}: handler factory requires a userStore (or legacy 'store') option`);
  }
  return { userStore, projectStore: opts.projectStore };
};

/**
 * Validate the optional `scope` argument. `undefined` is allowed and
 * returns `undefined`; anything else must be one of the two literals in
 * {@link SCOPES}. Errors list the allowed values.
 */
const isScope = (v: unknown): v is Scope =>
  typeof v === 'string' && (SCOPES as readonly string[]).includes(v);

const validateScope = (raw: unknown, toolName: string): Scope | undefined => {
  if (raw === undefined) return undefined;
  if (!isScope(raw)) {
    throw new Error(
      `${toolName}: field \`scope\` must be one of ${SCOPES.join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/** Return shape for {@link createMemorySaveHandler}. */
export interface MemorySaveResult {
  saved: {
    name: string;
    type: MemoryType;
    description: string;
  };
  path: string;
  /** Which store the memory was written to (DAR-924). */
  scope: Scope;
}

/** Return shape for {@link createMemoryListHandler}. */
export interface MemoryListResult {
  memories: Array<{
    name: string;
    type: MemoryType;
    description: string;
    /** Which store this entry came from (DAR-924). */
    scope: Scope;
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
  /** Which store the memory was removed from (DAR-924). */
  scope: Scope;
}

/**
 * The literal values accepted for `memory_search`'s `expand` argument
 * (DAR-930). `'none'` is the default and a true alias for omitting the
 * field; `'one-hop'` opts into outbound-edge expansion.
 */
export const EXPAND_MODES = ['none', 'one-hop'] as const;

/** Union type of {@link EXPAND_MODES}. */
export type ExpandMode = (typeof EXPAND_MODES)[number];

/**
 * The edge types `memory_search` will follow during one-hop expansion
 * (DAR-930). The four authored relation types plus `supersedes` and
 * `mentions`; structurally equivalent to {@link EdgeType} but re-declared
 * here so we don't accidentally widen by adding a never-walked sentinel
 * to the graph's edge enum.
 */
export const EXPAND_TYPES = [
  ...RELATION_TYPES,
  'supersedes',
  'mentions',
] as const satisfies readonly EdgeType[];

/**
 * Default `expandTypes` for `memory_search` one-hop expansion when the
 * caller does not supply one (DAR-930). Limited to the two
 * "build-context" relations on purpose: `builds-on` and `related-to` are
 * the edge types most likely to surface useful neighbors the agent did
 * not ask for. `mentions`, `supersedes`, `contradicts`, and `child-of`
 * each need explicit opt-in (an agent that wants the older entry can
 * pass `expandTypes: ['supersedes']` instead of being surprised by it).
 */
export const DEFAULT_EXPAND_TYPES: readonly EdgeType[] = ['builds-on', 'related-to'] as const;

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
   * Which store produced this match (DAR-924). Always present so callers
   * can disambiguate same-name entries across stores.
   */
  scope: Scope;
  /**
   * When `includeSuperseded: true` AND this memory is superseded by another
   * memory, the name of the superseding memory. Otherwise the field is
   * omitted entirely (key absent, not `undefined`) so JSON callers can rely
   * on `'supersededBy' in match` as the predicate.
   */
  supersededBy?: string;
  /**
   * Present only on entries that were added by one-hop graph expansion
   * (DAR-930), absent on direct cosine hits (key absent, not undefined).
   * `source` is the name of the direct hit whose outbound edge pulled this
   * neighbor into the response; `edge` is the edge type that connected
   * them.
   */
  via?: { source: string; edge: EdgeType };
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
  const { userStore, projectStore } = resolveStores(opts, 'memory_save');
  return async (rawArgs: ToolArguments): Promise<MemorySaveResult> => {
    const args = requireArgsObject(rawArgs, 'memory_save');
    const name = requireString(args, 'name', 'memory_save');
    validateMemoryName(name, 'memory_save');
    const type = validateMemoryType(args.type, 'memory_save');
    const description = requireString(args, 'description', 'memory_save');
    const body = requireString(args, 'body', 'memory_save');
    const scope = validateScope(args.scope, 'memory_save') ?? 'user';

    if (scope === 'project' && projectStore === undefined) {
      throw new Error(
        `memory_save: scope='project' requires a project store, but none was detected -- the server is running in user-only mode (no COMMONPLACE_PROJECT_DIR, no roots/list root, no cwd .commonplace/memory marker)`,
      );
    }

    const target = scope === 'project' ? projectStore! : userStore;
    const memory: Memory = { name, type, description, body };
    await target.save(memory);

    // Path is reconstructed here rather than returned by the store so the
    // store's on-disk layout stays an implementation detail.
    const path = join(target.dir, `${name}.md`);
    return {
      saved: { name, type, description },
      path,
      scope,
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
  const { userStore, projectStore } = resolveStores(opts, 'memory_list');
  return async (rawArgs: ToolArguments): Promise<MemoryListResult> => {
    const args = requireArgsObject(rawArgs, 'memory_list');
    let filter: MemoryType | undefined;
    if (args.type !== undefined) {
      filter = validateMemoryType(args.type, 'memory_list');
    }
    const includeSuperseded =
      validateBoolean(args.includeSuperseded, 'includeSuperseded', 'memory_list') ?? false;
    const scope = validateScope(args.scope, 'memory_list');

    // Build the per-scope candidate lists. Each store's `supersedes` filter
    // is applied within its own corpus -- supersede is a per-store relation
    // (a project memory does not supersede a user memory and vice versa).
    const collected: Array<{ entry: MemoryEntry; scope: Scope }> = [];

    const collectFrom = async (s: MemoryStore, sc: Scope): Promise<void> => {
      const entries = await s.list();
      let candidates = filter === undefined ? entries : entries.filter((e) => e.type === filter);
      if (!includeSuperseded) {
        const supersededMap = buildSupersededMap(entries);
        candidates = candidates.filter((e) => !supersededMap.has(e.name));
      }
      for (const entry of candidates) {
        collected.push({ entry, scope: sc });
      }
    };

    if (scope === undefined || scope === 'user') {
      await collectFrom(userStore, 'user');
    }
    if ((scope === undefined || scope === 'project') && projectStore !== undefined) {
      await collectFrom(projectStore, 'project');
    }

    return {
      memories: collected.map(({ entry, scope: sc }) => ({
        name: entry.name,
        type: entry.type,
        description: entry.description,
        scope: sc,
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
 * Validate the optional `expand` argument for `memory_search` (DAR-930).
 * `undefined` is allowed and returns `undefined` (caller chooses the
 * default); anything else must be one of {@link EXPAND_MODES}. Rejects
 * unknown literals, numbers, null, etc. with a message that names the
 * offending field and lists the allowed values -- so callers experimenting
 * with `'two-hop'` learn the contract immediately.
 */
const isExpandMode = (v: unknown): v is ExpandMode =>
  typeof v === 'string' && (EXPAND_MODES as readonly string[]).includes(v);

const validateExpand = (raw: unknown, toolName: string): ExpandMode | undefined => {
  if (raw === undefined) return undefined;
  if (!isExpandMode(raw)) {
    throw new Error(
      `${toolName}: field \`expand\` must be one of ${EXPAND_MODES.join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Validate the optional `expandTypes` argument for `memory_search`
 * (DAR-930). `undefined` is allowed and returns `undefined`; anything else
 * must be an array whose every element is a recognised {@link EdgeType}.
 * Validation rejects non-array shapes, empty / non-string elements, and
 * unknown edge-type strings (e.g. `'bogus'`) with a message that lists the
 * allowed values.
 */
const validateExpandTypes = (raw: unknown, toolName: string): EdgeType[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${toolName}: field \`expandTypes\` must be an array of edge-type strings (${EXPAND_TYPES.join(
        ', ',
      )}); got ${JSON.stringify(raw)}`,
    );
  }
  const out: EdgeType[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string' || !(EXPAND_TYPES as readonly string[]).includes(entry)) {
      throw new Error(
        `${toolName}: field \`expandTypes[${i}]\` must be one of ${EXPAND_TYPES.join(
          ', ',
        )}; got ${JSON.stringify(entry)}`,
      );
    }
    out.push(entry as EdgeType);
  }
  return out;
};

/**
 * Validate the optional `expandLimit` argument for `memory_search`
 * (DAR-930). Non-negative integer (zero is permitted -- it means "no
 * neighbors per hit" and is honoured rather than coerced to the default).
 * Rejects negatives, non-integers, NaN, +/-Infinity, and non-numbers with
 * a message that names the field.
 */
const validateExpandLimit = (raw: unknown, toolName: string): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `${toolName}: field \`expandLimit\` must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `${toolName}: field \`expandLimit\` must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Default `expandLimit` for `memory_search` one-hop expansion when the
 * caller does not supply one (DAR-930). Capped at 2 so a single hub
 * memory cannot flood the response with its entire neighborhood; callers
 * that want more pass `expandLimit` explicitly.
 */
const DEFAULT_EXPAND_LIMIT = 2;

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
  const { userStore, projectStore } = resolveStores(opts, 'memory_search');
  // Resolve the default top-k once at handler-construction time. When the
  // bin supplies one (resolved from `COMMONPLACE_DEFAULT_LIMIT` per
  // DAR-913), it wins; otherwise we fall back to the store-layer default
  // so this handler still works in test setups that wire the factory
  // directly without an env-var pass.
  const fallbackLimit = opts.defaultLimit ?? DEFAULT_SEARCH_LIMIT;
  // DAR-930: per-scope graph references plus expansion decay. The graphs
  // are optional -- when omitted, `expand: 'one-hop'` requests validate
  // their arguments but produce no expanded neighbors. This keeps the
  // handler usable from test harnesses that wire the factory without a
  // graph (e.g. the DAR-920/DAR-924 tests that predate DAR-928).
  const userGraph = opts.userGraph;
  const projectGraph = opts.projectGraph;
  const expansionDecay = opts.expansionDecay ?? 0.7;
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
    const callerLimit = validateLimit(args.limit, 'memory_search');
    const callerType =
      args.type !== undefined ? validateMemoryType(args.type, 'memory_search') : undefined;
    const threshold = validateThreshold(args.threshold, 'memory_search');
    const includeSuperseded =
      validateBoolean(args.includeSuperseded, 'includeSuperseded', 'memory_search') ?? false;
    const scope = validateScope(args.scope, 'memory_search');

    // DAR-930 expansion knobs. Each is validated unconditionally so a
    // caller that sets only `expandTypes` (without `expand: 'one-hop'`)
    // still gets a clear error on a bogus edge type rather than a silent
    // no-op. The expand mode itself is parsed last so a malformed
    // `expand` literal can short-circuit the rest.
    const expandTypes = validateExpandTypes(args.expandTypes, 'memory_search');
    const expandLimit = validateExpandLimit(args.expandLimit, 'memory_search');
    const expandMode = validateExpand(args.expand, 'memory_search') ?? 'none';

    // Decide which stores to query based on the scope filter. When scope is
    // omitted, query both (when both exist). The per-scope graph is also
    // captured here so expansion in step 2 reads the same scope's graph
    // (cross-scope expansion is out of scope per the contract).
    const targets: Array<{
      store: MemoryStore;
      scope: Scope;
      graph: MemoryGraph | undefined;
    }> = [];
    if (scope === undefined || scope === 'user') {
      targets.push({ store: userStore, scope: 'user', graph: userGraph });
    }
    if ((scope === undefined || scope === 'project') && projectStore !== undefined) {
      targets.push({ store: projectStore, scope: 'project', graph: projectGraph });
    }

    // For each target store, build per-store SearchOptions. We DO NOT pass
    // `limit` to the store when the caller omitted it (DAR-920 contract
    // "omits unset SearchOptions fields"). When the caller did set a limit,
    // we pass it to each store independently -- the merged top-k slice
    // happens after we receive hits from both stores. We intentionally
    // request `limit` per store so the merged set has enough headroom even
    // if all top-`limit` hits come from one store; the merged slice then
    // applies the caller's limit again.
    const allHits: Array<{ hit: SearchHit; scope: Scope }> = [];
    let totalScanned = 0;

    // Per-scope superseded map cache. Built once per target store during the
    // search loop and reused in the projection loop below for `supersededBy`
    // lookups -- avoids rebuilding the same map per result match (f-1).
    const supersededByScope = new Map<Scope, ReadonlyMap<string, string>>();

    // Per-scope entry lookups (name -> MemoryEntry). Built lazily on the
    // first expansion that needs the scope and reused across expansions in
    // that scope so the expansion pass is O(direct hits * expandLimit)
    // rather than O(direct hits * expandLimit * corpus).
    const entriesByScope = new Map<Scope, ReadonlyMap<string, MemoryEntry>>();
    // Per-scope MemoryGraph lookup. Populated alongside `targets` so the
    // expansion pass can find the right graph for each direct-hit scope
    // without re-walking the `targets` array per hit.
    const graphByScope = new Map<Scope, MemoryGraph | undefined>();

    for (const target of targets) {
      graphByScope.set(target.scope, target.graph);

      const searchOpts: SearchOptions = {};
      if (callerLimit !== undefined) {
        searchOpts.limit = callerLimit;
      }
      if (callerType !== undefined) {
        searchOpts.type = callerType;
      }
      if (threshold !== undefined) {
        searchOpts.threshold = threshold;
      }

      // Headroom for the supersede filter (DAR-929 carried forward): when
      // not including superseded entries, enlarge the store-side limit so
      // the supersede pass leaves enough candidates.
      if (!includeSuperseded) {
        const corpusSize = target.store.all().length;
        const desired = callerLimit ?? fallbackLimit;
        const headroom = Math.max(desired, corpusSize);
        if (callerLimit === undefined && corpusSize > fallbackLimit) {
          searchOpts.limit = headroom;
        } else if (callerLimit !== undefined && headroom > callerLimit) {
          searchOpts.limit = headroom;
        }
      }

      const hits = await target.store.search(query, searchOpts);
      const allEntries = target.store.all();
      const supersededMap = buildSupersededMap(allEntries);
      supersededByScope.set(target.scope, supersededMap);

      // Per-store totalScanned contribution. Mirrors the DAR-929 semantics
      // (post-supersede when not including superseded).
      const storeScanned = includeSuperseded
        ? allEntries.length
        : allEntries.length - countSupersededInCorpus(allEntries, supersededMap);
      totalScanned += storeScanned;

      const filteredHits = includeSuperseded
        ? hits
        : hits.filter((hit) => !supersededMap.has(hit.memory.name));

      for (const hit of filteredHits) {
        allHits.push({ hit, scope: target.scope });
      }
    }

    // Merge direct hits: sort by descending score; ties preserve insertion
    // order (which mirrors the per-store iteration order above -- user
    // before project when both are queried). `Array.prototype.sort` is
    // stable in V8 / per spec from ES2019, so this is well-defined.
    allHits.sort((a, b) => b.hit.score - a.hit.score);

    // DAR-930: build the unified candidate list. Direct hits are added
    // first, then expansion (when opted in) appends decayed neighbors
    // gated by `expandTypes`, `expandLimit`, and the per-scope supersede
    // filter. We deduplicate against direct-hit names so a memory that's
    // already a direct hit doesn't get a second slot as a neighbor of
    // some other direct hit; we also dedupe across neighbors so two
    // direct hits pointing at the same neighbor don't double-count it.
    interface Candidate {
      kind: 'direct' | 'expanded';
      name: string;
      scope: Scope;
      score: number;
      // For direct candidates, the underlying SearchHit drives the
      // projection. For expanded candidates, we need the entry separately
      // (the graph doesn't carry it) plus the via metadata.
      hit?: SearchHit;
      entry?: MemoryEntry;
      via?: { source: string; edge: EdgeType };
    }

    const candidates: Candidate[] = allHits.map(({ hit, scope: sc }) => ({
      kind: 'direct',
      name: hit.memory.name,
      scope: sc,
      score: hit.score,
      hit,
    }));

    if (expandMode === 'one-hop') {
      // Resolve effective expansion knobs. Defaults are wired here rather
      // than at validation time so callers can pass `expandLimit: 0`
      // (which is honoured: zero neighbors per hit) without it being
      // overridden by the default.
      const effectiveExpandTypes = expandTypes ?? DEFAULT_EXPAND_TYPES;
      const effectiveExpandLimit = expandLimit ?? DEFAULT_EXPAND_LIMIT;
      const allowedEdgeTypes = new Set<EdgeType>(effectiveExpandTypes);

      // Index direct-hit names per scope so neighbor expansion can skip
      // memories that are already direct hits without an O(n) scan.
      const directNamesByScope = new Map<Scope, Set<string>>();
      for (const c of candidates) {
        let s = directNamesByScope.get(c.scope);
        if (s === undefined) {
          s = new Set<string>();
          directNamesByScope.set(c.scope, s);
        }
        s.add(c.name);
      }

      // Track expanded names per scope so two direct hits pointing at the
      // same neighbor don't add it twice. Deterministic tie-break: the
      // direct hit with the higher score is visited first because
      // `candidates` is sorted by descending score above; so the first
      // insertion wins, and the `via` field reflects that higher-scored
      // source.
      const expandedNamesByScope = new Map<Scope, Set<string>>();

      // Iterate direct hits in sorted order. We snapshot the direct-hits
      // slice up front because the expansion loop appends to `candidates`
      // and we only want to walk direct hits' neighborhoods.
      const directHits = candidates.slice();
      for (const direct of directHits) {
        if (effectiveExpandLimit === 0) break; // honoured: no neighbors per hit.
        const graph = graphByScope.get(direct.scope);
        if (graph === undefined) continue;

        // Lazy-build the per-scope name -> entry map on first use. The
        // store's `all()` is already an array reference; turning it into
        // a map once per scope is the only allocation we need.
        let entryMap = entriesByScope.get(direct.scope);
        if (entryMap === undefined) {
          const corpus =
            direct.scope === 'user'
              ? userStore.all()
              : projectStore !== undefined
                ? projectStore.all()
                : [];
          const m = new Map<string, MemoryEntry>();
          for (const e of corpus) m.set(e.name, e);
          entryMap = m;
          entriesByScope.set(direct.scope, m);
        }

        // Invariant: `supersededByScope` is populated for every queried
        // target scope in the search loop above, and `direct.scope` is always
        // one of those scopes -- so this lookup cannot miss. Throw loudly
        // rather than silently fall back to an empty map if that invariant
        // is ever broken (f-2).
        const supersededMap = supersededByScope.get(direct.scope);
        if (supersededMap === undefined) {
          throw new Error(
            `internal invariant violated: supersededByScope missing scope '${direct.scope}' during one-hop expansion`,
          );
        }
        const directNames = directNamesByScope.get(direct.scope) ?? new Set<string>();
        let expandedNames = expandedNamesByScope.get(direct.scope);
        if (expandedNames === undefined) {
          expandedNames = new Set<string>();
          expandedNamesByScope.set(direct.scope, expandedNames);
        }

        let added = 0;
        const outbound = graph.outbound(direct.name);
        for (const edge of outbound) {
          if (added >= effectiveExpandLimit) break;
          if (!allowedEdgeTypes.has(edge.type)) continue;
          // Skip if this neighbor is already a direct hit (the direct
          // entry wins and stays in direct shape, no `via`).
          if (directNames.has(edge.to)) continue;
          // Skip if already pulled in by an earlier (higher-scored)
          // direct hit; the first source wins for the `via` annotation.
          if (expandedNames.has(edge.to)) continue;
          // Skip dangling: the graph stores edges even when the target
          // isn't loaded; we cannot project an entry for it.
          const neighborEntry = entryMap.get(edge.to);
          if (neighborEntry === undefined) continue;
          // Respect the supersede filter (when the caller hasn't asked
          // for superseded entries, an expanded neighbor that's been
          // superseded by some other memory is dropped just like direct
          // hits would be).
          if (!includeSuperseded && supersededMap.has(neighborEntry.name)) continue;
          // Respect the type filter when the caller scoped the search
          // (DAR-920 ac-5). Expansion shouldn't introduce off-type
          // matches that direct search would have rejected.
          if (callerType !== undefined && neighborEntry.type !== callerType) continue;

          const decayedScore = direct.score * expansionDecay;
          // Respect the threshold filter when the caller set one
          // (DAR-920). The threshold gates the SCORE returned to the
          // caller; an expanded neighbor whose decayed score falls below
          // it shouldn't sneak in.
          if (threshold !== undefined && decayedScore < threshold) continue;

          candidates.push({
            kind: 'expanded',
            name: neighborEntry.name,
            scope: direct.scope,
            score: decayedScore,
            entry: neighborEntry,
            via: { source: direct.name, edge: edge.type },
          });
          expandedNames.add(neighborEntry.name);
          added++;
        }
      }

      // Final sort across the merged (direct + expanded) list. Stable
      // sort preserves insertion order on ties: for two expanded
      // neighbors with the same decayed score, the one pulled in by the
      // earlier (higher-scored, then by-insertion) source ranks first
      // -- which is the deterministic tiebreak the contract specifies.
      candidates.sort((a, b) => b.score - a.score);
    }

    const sliceLimit = callerLimit ?? fallbackLimit;
    const limited = candidates.slice(0, sliceLimit);

    const matches: MemorySearchMatch[] = limited.map((c) => {
      // `kind === 'direct'` always has `hit` set (we constructed it that
      // way above); `kind === 'expanded'` always has `entry` set.
      const memory = c.kind === 'direct' ? c.hit!.memory : c.entry!;
      const projection: MemorySearchMatch = {
        name: memory.name,
        type: memory.type,
        description: memory.description,
        body: memory.body,
        score: roundScore(c.score),
        relations: memory.relations.map((r) => ({ to: r.to, type: r.type })),
        scope: c.scope,
      };
      if (c.kind === 'expanded' && c.via !== undefined) {
        projection.via = { source: c.via.source, edge: c.via.edge };
      }
      if (includeSuperseded) {
        // For supersededBy lookups we use the matching store's superseded
        // map. The map was already built once per target store during the
        // search loop and cached in `supersededByScope` -- consult it here
        // (f-1) rather than rebuilding from the per-scope corpus.
        let supersededMap = supersededByScope.get(c.scope);
        if (supersededMap === undefined) {
          // Defensive: the search loop only populates the map for targets
          // it queried. When `includeSuperseded` is true the map isn't
          // strictly needed for filtering -- but we still want
          // `supersededBy` annotations on matches, so build it lazily here
          // for any scope we somehow missed (should not happen given the
          // current targets construction, but the lazy build keeps the
          // invariant local).
          const corpus = c.scope === 'user' ? userStore.all() : projectStore!.all();
          supersededMap = buildSupersededMap(corpus);
          supersededByScope.set(c.scope, supersededMap);
        }
        const superseder = supersededMap.get(memory.name);
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
  const { userStore, projectStore } = resolveStores(opts, 'memory_delete');
  return async (rawArgs: ToolArguments): Promise<MemoryDeleteResult> => {
    const args = requireArgsObject(rawArgs, 'memory_delete');
    const name = requireString(args, 'name', 'memory_delete');
    const explicitScope = validateScope(args.scope, 'memory_delete');

    // Determine which store(s) hold the name.
    const inUser = userStore.all().some((e) => e.name === name);
    const inProject = projectStore !== undefined && projectStore.all().some((e) => e.name === name);

    let target: MemoryStore;
    let scope: Scope;
    if (explicitScope !== undefined) {
      // Caller disambiguated. Honour the choice, even if the name only
      // exists in the other scope -- the underlying store rejects the
      // missing-name case with a message that names the offending memory.
      if (explicitScope === 'project') {
        if (projectStore === undefined) {
          throw new Error(
            `memory_delete: scope='project' requires a project store, but none was detected -- the server is running in user-only mode`,
          );
        }
        target = projectStore;
        scope = 'project';
      } else {
        target = userStore;
        scope = 'user';
      }
    } else {
      // No explicit scope: only unambiguous when the name lives in exactly
      // one store. DAR-924 ac-6: "delete requires scope to disambiguate
      // when the same name exists in both."
      if (inUser && inProject) {
        throw new Error(
          `memory_delete: memory \`${name}\` exists in both 'user' and 'project' scopes; ambiguous without an explicit scope -- pass { name, scope: 'user' | 'project' } to disambiguate`,
        );
      }
      if (inProject) {
        target = projectStore!;
        scope = 'project';
      } else {
        // Fall through to user store: either it lives there, or it's
        // missing entirely (the user store will surface the missing-name
        // error with the offending name).
        target = userStore;
        scope = 'user';
      }
    }

    // `store.delete` rejects unknown names with a message containing the
    // offending name (DAR-916), which is what the missing-name tests
    // assert against.
    await target.delete(name);
    return { deleted: name, scope };
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
  const { userStore, projectStore } = resolveStores(opts, 'memory_link');
  return async (rawArgs: ToolArguments): Promise<MemoryLinkResult> => {
    const args = requireArgsObject(rawArgs, 'memory_link');
    const from = requireString(args, 'from', 'memory_link');
    validateMemoryName(from, 'memory_link');
    const to = requireString(args, 'to', 'memory_link');
    validateMemoryName(to, 'memory_link');
    const type = validateLinkType(args.type, 'memory_link') ?? 'related-to';
    const scope = validateScope(args.scope, 'memory_link');

    // Edges are intra-scope: a project memory can only link to another
    // project memory, and likewise for user. The caller can pass an
    // explicit scope; otherwise we fall back to whichever store holds
    // `from` (resolving ambiguity by erroring when both do).
    const target = pickStoreForName(from, scope, userStore, projectStore, 'memory_link');

    const result = await target.linkEdge({ from, to, type });
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
  const { userStore, projectStore } = resolveStores(opts, 'memory_unlink');
  return async (rawArgs: ToolArguments): Promise<MemoryUnlinkResult> => {
    const args = requireArgsObject(rawArgs, 'memory_unlink');
    const from = requireString(args, 'from', 'memory_unlink');
    validateMemoryName(from, 'memory_unlink');
    const to = requireString(args, 'to', 'memory_unlink');
    validateMemoryName(to, 'memory_unlink');
    const type = validateLinkType(args.type, 'memory_unlink');
    const scope = validateScope(args.scope, 'memory_unlink');

    const target = pickStoreForName(from, scope, userStore, projectStore, 'memory_unlink');

    const result = await target.unlinkEdge({ from, to, type });
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

/**
 * Pick which store to dispatch a link / unlink operation against.
 *
 * - When `scope` is explicit, route to that store (and surface a clear
 *   error if scope='project' but no project store is wired).
 * - When `scope` is omitted, prefer the unique store that holds `from`. If
 *   `from` lives in both stores, the caller must disambiguate.
 *
 * Existing single-store callers (DAR-928 tests) pass no scope and have no
 * project store -- they fall through to the user store unchanged.
 */
const pickStoreForName = (
  name: string,
  explicitScope: Scope | undefined,
  userStore: MemoryStore,
  projectStore: MemoryStore | undefined,
  toolName: string,
): MemoryStore => {
  if (explicitScope === 'project') {
    if (projectStore === undefined) {
      throw new Error(
        `${toolName}: scope='project' requires a project store, but none was detected -- the server is running in user-only mode`,
      );
    }
    return projectStore;
  }
  if (explicitScope === 'user') {
    return userStore;
  }
  const inUser = userStore.all().some((e) => e.name === name);
  const inProject = projectStore !== undefined && projectStore.all().some((e) => e.name === name);
  if (inUser && inProject) {
    throw new Error(
      `${toolName}: memory \`${name}\` exists in both 'user' and 'project' scopes; ambiguous without an explicit scope -- pass scope: 'user' | 'project' to disambiguate`,
    );
  }
  if (inProject) return projectStore!;
  return userStore;
};
