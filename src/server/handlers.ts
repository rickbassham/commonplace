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
   * One-hop expansion score decay applied by `memory_search` when the
   * caller passes `expand: 'one-hop'`. Resolved by the bin from
   * `COMMONPLACE_EXPANSION_DECAY`. When omitted, the search handler falls
   * back to {@link DEFAULT_EXPANSION_DECAY}. Other handlers ignore this
   * option.
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
   * Present only on entries surfaced by one-hop graph expansion. Names
   * the direct-hit memory whose outbound edge pulled this entry in and
   * which edge type was followed. Omitted entirely on direct hits so
   * callers can rely on `'via' in match` as the predicate.
   */
  via?: ExpansionVia;
}

/**
 * The `via` annotation on an expansion match. `source` is the direct hit's
 * memory name (within the same scope -- expansion respects store
 * boundaries); `edge` is the outbound edge type that was followed.
 */
export interface ExpansionVia {
  source: string;
  edge: ExpansionEdgeType;
}

/**
 * Edge types eligible for one-hop expansion. The four authored
 * {@link RelationType} values plus `'mentions'` (body tokens) --
 * `'supersedes'` is excluded by design because supersede semantics are
 * already surfaced via `supersededBy` and following supersedes edges in
 * search would conflate "this is the next version" with "this is
 * topically related."
 */
export type ExpansionEdgeType = RelationType | 'mentions';

/**
 * Expansion mode literal values. `'one-hop'` is the default (see
 * {@link DEFAULT_EXPAND_MODE}); callers that want strict semantic-only
 * results pass `'none'`.
 */
export const EXPAND_MODES = ['none', 'one-hop'] as const;
export type ExpandMode = (typeof EXPAND_MODES)[number];

/**
 * Default `expand` mode applied when the caller omits the argument.
 * `'one-hop'` because expansion's value proposition is "surface context
 * the agent did not explicitly ask for but probably wants" -- gating that
 * behind an opt-in flag would mean most callers never benefit. Decay (0.7
 * default) + `expandLimit` (2 default) + dedup keep expansion from
 * crowding direct hits; callers who want strict cosine-only results pass
 * `expand: 'none'`.
 */
export const DEFAULT_EXPAND_MODE: ExpandMode = 'one-hop';

/**
 * Allowed values for `expandTypes[]`. {@link RELATION_TYPES} plus
 * `'mentions'`. See {@link ExpansionEdgeType}.
 */
export const EXPAND_EDGE_TYPES: readonly ExpansionEdgeType[] = [
  ...RELATION_TYPES,
  'mentions',
] as const;

/**
 * Default outbound edge types followed by one-hop expansion when the
 * caller does not pass `expandTypes`. Topically-meaningful authored edges;
 * `'mentions'` is opt-in (body-mention edges are noisier than authored
 * relations and would flood expansion results for memories with a lot of
 * `[[name]]` references).
 */
export const DEFAULT_EXPAND_TYPES: readonly ExpansionEdgeType[] = ['builds-on', 'related-to'];

/**
 * Default cap on neighbours added per direct hit. Two is the sweet spot
 * the issue calls out: enough to surface the obvious "you probably want
 * this too" neighbour without letting a hub memory flood the results.
 */
export const DEFAULT_EXPAND_LIMIT = 2;

/**
 * Default score-decay multiplier when the bin does not pass
 * `expansionDecay`. Mirrors {@link import('../bin/env.js').DEFAULT_EXPANSION_DECAY}.
 * Duplicated here (rather than imported from `bin/env.ts`) because the
 * server layer must not depend on the bin layer; the bin is what wires
 * env-resolved values through.
 */
export const DEFAULT_EXPANSION_DECAY = 0.7;

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
 * Validate the optional `expand` argument. `undefined` returns
 * {@link DEFAULT_EXPAND_MODE} (`'one-hop'` -- expansion is on by default
 * because the whole point of the feature is to surface context the agent
 * did not explicitly ask for; the decay + `expandLimit` + dedup logic
 * keeps it from flooding results). Anything else must be one of the
 * {@link EXPAND_MODES} literals.
 */
const validateExpandMode = (raw: unknown, toolName: string): ExpandMode => {
  if (raw === undefined) return DEFAULT_EXPAND_MODE;
  if (typeof raw !== 'string' || !(EXPAND_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `${toolName}: field \`expand\` must be one of ${EXPAND_MODES.join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw as ExpandMode;
};

/**
 * Validate the optional `expandTypes` argument. `undefined` returns
 * `undefined` (the handler then applies {@link DEFAULT_EXPAND_TYPES}).
 * When present must be a non-empty array of {@link EXPAND_EDGE_TYPES}
 * literals. The empty-array case throws so callers learn early that
 * `expandTypes: []` is a contradictory request (one-hop expansion with
 * zero edge types to follow yields no expansion -- equivalent to
 * `expand: 'none'`, which is the clearer way to express it).
 */
const validateExpandTypes = (raw: unknown, toolName: string): ExpansionEdgeType[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${toolName}: field \`expandTypes\` must be an array of edge types; got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.length === 0) {
    throw new Error(
      `${toolName}: field \`expandTypes\` must be a non-empty array (use \`expand: 'none'\` to disable expansion)`,
    );
  }
  const out: ExpansionEdgeType[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !(EXPAND_EDGE_TYPES as readonly string[]).includes(entry)) {
      throw new Error(
        `${toolName}: field \`expandTypes\` entries must be one of ${EXPAND_EDGE_TYPES.join(', ')}; got ${JSON.stringify(entry)}`,
      );
    }
    out.push(entry as ExpansionEdgeType);
  }
  return out;
};

/**
 * Validate the optional `expandLimit` argument. `undefined` returns
 * `undefined` (the handler then applies {@link DEFAULT_EXPAND_LIMIT}).
 * When present must be a positive integer. Mirrors {@link validateLimit}
 * but names a different field so the error message is field-specific.
 */
const validateExpandLimit = (raw: unknown, toolName: string): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `${toolName}: field \`expandLimit\` must be a positive integer; got ${JSON.stringify(raw)}`,
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
 * One-hop graph expansion: when callers pass `expand: 'one-hop'`,
 * each direct hit's outbound graph edges (filtered by `expandTypes`) are
 * walked via the source store's {@link MemoryGraph}. Neighbour memories are
 * surfaced as additional matches scored as `direct_hit_score * decay`,
 * deduplicated against direct hits (and against each other -- the highest
 * derived score wins when multiple direct hits point at the same
 * neighbour), capped at `expandLimit` adds per source, and merged into the
 * result list. The final list is sorted by descending score and sliced to
 * the overall `limit`. Expanded entries carry a `via: { source, edge }`
 * field naming the direct hit that pulled them in; direct hits do not.
 *
 * Out of scope: connectedness boost, reranking, snippet generation, and
 * surfacing `mentions` edges in `match.relations` (mentions are surfaced
 * ONLY via `via.edge` on expansion entries when the caller opts in to
 * following them).
 */
export const createMemorySearchHandler = (opts: HandlerOptions): ToolHandler => {
  const { userStore, projectStore } = resolveStores(opts, 'memory_search');
  // Resolve the default top-k once at handler-construction time. When the
  // bin supplies one (resolved from `COMMONPLACE_DEFAULT_LIMIT` per
  // DAR-913), it wins; otherwise we fall back to the store-layer default
  // so this handler still works in test setups that wire the factory
  // directly without an env-var pass.
  const fallbackLimit = opts.defaultLimit ?? DEFAULT_SEARCH_LIMIT;
  // Same resolve-once pattern for the expansion decay. When the bin
  // supplies one (from `COMMONPLACE_EXPANSION_DECAY`), it wins; otherwise
  // fall back to the documented default so the handler works in direct
  // test wiring without an env pass.
  const expansionDecay = opts.expansionDecay ?? DEFAULT_EXPANSION_DECAY;
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
    const expand = validateExpandMode(args.expand, 'memory_search');
    const callerExpandTypes = validateExpandTypes(args.expandTypes, 'memory_search');
    const callerExpandLimit = validateExpandLimit(args.expandLimit, 'memory_search');

    // Decide which stores to query based on the scope filter. When scope is
    // omitted, query both (when both exist).
    const targets: Array<{ store: MemoryStore; scope: Scope }> = [];
    if (scope === undefined || scope === 'user') {
      targets.push({ store: userStore, scope: 'user' });
    }
    if ((scope === undefined || scope === 'project') && projectStore !== undefined) {
      targets.push({ store: projectStore, scope: 'project' });
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

    for (const target of targets) {
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

    // Merge: sort by descending score; ties preserve insertion order (which
    // mirrors the per-store iteration order above -- user before project
    // when both are queried). `Array.prototype.sort` is stable in V8 / per
    // spec from ES2019, so this is well-defined.
    allHits.sort((a, b) => b.hit.score - a.hit.score);

    const sliceLimit = callerLimit ?? fallbackLimit;
    const limited = allHits.slice(0, sliceLimit);

    // Helper: look up the superseder for a (scope, name) pair. Builds the
    // per-scope map lazily and caches it (the search loop above already
    // populates `supersededByScope` for every queried target; this branch
    // covers the includeSuperseded-on-an-untouched-scope edge case
    // defensively).
    const supersederFor = (sc: Scope, name: string): string | undefined => {
      let supersededMap = supersededByScope.get(sc);
      if (supersededMap === undefined) {
        const corpus = sc === 'user' ? userStore.all() : projectStore!.all();
        supersededMap = buildSupersededMap(corpus);
        supersededByScope.set(sc, supersededMap);
      }
      return supersededMap.get(name);
    };

    // Carry the unrounded score alongside the projected match so the final
    // sort (after one-hop expansion) is on full-precision scores; rounding
    // happens last so two near-equal scores don't collide post-rounding.
    const directMatches: Array<{ unroundedScore: number; match: MemorySearchMatch }> = limited.map(
      ({ hit, scope: sc }) => {
        const projection: MemorySearchMatch = {
          name: hit.memory.name,
          type: hit.memory.type,
          description: hit.memory.description,
          body: hit.memory.body,
          score: hit.score,
          relations: hit.memory.relations.map((r) => ({ to: r.to, type: r.type })),
          scope: sc,
        };
        if (includeSuperseded) {
          const superseder = supersederFor(sc, hit.memory.name);
          if (superseder !== undefined) {
            projection.supersededBy = superseder;
          }
        }
        return { unroundedScore: hit.score, match: projection };
      },
    );

    let combined = directMatches;

    if (expand === 'one-hop') {
      const effectiveExpandTypes = callerExpandTypes ?? DEFAULT_EXPAND_TYPES;
      const effectiveExpandLimit = callerExpandLimit ?? DEFAULT_EXPAND_LIMIT;
      // Direct-hit keyset for dedup against expansion. Keyed by
      // `${scope}:${name}` so the same name in user and project doesn't
      // collide (scope isolation).
      const directKeys = new Set(limited.map(({ hit, scope: sc }) => `${sc}:${hit.memory.name}`));
      // Expansion candidates, keyed the same way. When multiple direct
      // hits point at the same neighbour, the highest derived score wins
      // (the via.source is updated to that winning hit).
      const expansionByKey = new Map<
        string,
        { unroundedScore: number; match: MemorySearchMatch }
      >();
      // Per-scope name -> entry map for O(1) neighbour lookups. Built
      // lazily on first use so the (common) `expand: 'none'` path doesn't
      // pay the build cost.
      const entryIndexByScope = new Map<Scope, Map<string, MemoryEntry>>();
      const entryIndexFor = (sc: Scope): Map<string, MemoryEntry> => {
        const cached = entryIndexByScope.get(sc);
        if (cached !== undefined) return cached;
        const corpus = sc === 'user' ? userStore.all() : projectStore!.all();
        const built = new Map<string, MemoryEntry>();
        for (const entry of corpus) built.set(entry.name, entry);
        entryIndexByScope.set(sc, built);
        return built;
      };

      for (const { hit: directHit, scope: sc } of limited) {
        const sourceStore = sc === 'user' ? userStore : projectStore!;
        const graph = sourceStore.graph;
        if (graph === undefined) continue;

        const outbound = graph.outbound(directHit.memory.name);
        const eligibleEdges = outbound.filter((edge) =>
          (effectiveExpandTypes as readonly string[]).includes(edge.type),
        );

        let addedFromThisHit = 0;
        for (const edge of eligibleEdges) {
          if (addedFromThisHit >= effectiveExpandLimit) break;

          const key = `${sc}:${edge.to}`;
          // Direct hit dominates: silently skip (does NOT count toward
          // expandLimit -- this hit's expansion budget is for ADDITIONS,
          // not edges-considered).
          if (directKeys.has(key)) continue;

          const neighborEntry = entryIndexFor(sc).get(edge.to);
          // Dangling edge (target not loaded in this scope). The graph
          // surfaces dangling edges intentionally; they cannot
          // be projected as matches because there is no body to return.
          if (neighborEntry === undefined) continue;

          // Supersede filter mirrors the direct-hit pass. We don't want
          // expansion to leak superseded entries past a filter the caller
          // explicitly relies on.
          if (!includeSuperseded && supersederFor(sc, neighborEntry.name) !== undefined) {
            continue;
          }

          const unroundedScore = directHit.score * expansionDecay;
          const existing = expansionByKey.get(key);
          if (existing !== undefined && existing.unroundedScore >= unroundedScore) {
            // Lower-scored path; keep the higher one. Does count toward
            // this hit's budget: this hit DID contribute a candidate, it
            // just lost the tie. Otherwise a popular hub neighbour reached
            // from every direct hit would never let later edges run.
            addedFromThisHit++;
            continue;
          }

          const expansionMatch: MemorySearchMatch = {
            name: neighborEntry.name,
            type: neighborEntry.type,
            description: neighborEntry.description,
            body: neighborEntry.body,
            score: unroundedScore,
            relations: neighborEntry.relations.map((r) => ({ to: r.to, type: r.type })),
            scope: sc,
            via: { source: directHit.memory.name, edge: edge.type as ExpansionEdgeType },
          };
          if (includeSuperseded) {
            const superseder = supersederFor(sc, neighborEntry.name);
            if (superseder !== undefined) {
              expansionMatch.supersededBy = superseder;
            }
          }
          expansionByKey.set(key, { unroundedScore, match: expansionMatch });
          addedFromThisHit++;
        }
      }

      combined = [...directMatches, ...expansionByKey.values()];
      // Re-sort the combined list by descending unrounded score. Stable
      // sort preserves the directMatches-before-expansion insertion order
      // on exact ties, which means an expanded entry only outranks a
      // direct hit when its score is strictly higher (which can happen if
      // the direct hit's underlying score is below `decay * source_score`
      // for a different hit).
      combined.sort((a, b) => b.unroundedScore - a.unroundedScore);
      combined = combined.slice(0, sliceLimit);
    }

    // Round scores last so the combined sort above runs on full precision.
    const matches: MemorySearchMatch[] = combined.map(({ unroundedScore, match }) => ({
      ...match,
      score: roundScore(unroundedScore),
    }));

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
