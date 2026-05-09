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

import { MEMORY_TYPES, validateName, type Memory, type MemoryType } from '../store/memory.js';
import type { MemoryStore, SearchOptions } from '../store/memory-store.js';
import type { ToolArguments, ToolHandler } from './tools.js';

/** Construction options shared by all three handler factories. */
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
 * Construct the `memory_list` handler bound to a specific store. The
 * arguments object is optional; when present, the only recognised field is
 * `type`, which (when set) restricts the result to entries of that type.
 *
 * The response strips the body and any graph metadata, matching the
 * documented frontmatter-only shape.
 */
export const createMemoryListHandler = (opts: HandlerOptions): ToolHandler => {
  const { store } = opts;
  return async (rawArgs: ToolArguments): Promise<MemoryListResult> => {
    const args = requireArgsObject(rawArgs, 'memory_list');
    let filter: MemoryType | undefined;
    if (args.type !== undefined) {
      filter = validateMemoryType(args.type, 'memory_list');
    }

    const entries = await store.list();
    const filtered = filter === undefined ? entries : entries.filter((e) => e.type === filter);
    return {
      memories: filtered.map((e) => ({
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
 * the `{ query, limit?, type?, threshold? }` argument shape, dispatches to
 * `store.search()`, and serialises the {@link SearchHit}s into the
 * documented `{ matches, query, totalScanned }` envelope.
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
 *     (ac-6) -- distinct from `matches.length`, which can be lower because
 *     of `type` / `threshold` / `limit`.
 *
 * Limit sanitisation is the MCP tool layer's responsibility per DAR-917; we
 * reject NaN / negative / non-integer `limit` values rather than coercing.
 *
 * Out of scope (per the DAR-920 contract envelope): graph `relations` on
 * matches and default-exclude superseded (DAR-929), one-hop expansion
 * (DAR-930), connectedness boost (DAR-931), env-var resolution for
 * `COMMONPLACE_DEFAULT_LIMIT` (DAR-913), reranking, and snippet generation.
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
    const limit = validateLimit(args.limit, 'memory_search');
    if (limit !== undefined) {
      searchOpts.limit = limit;
    }
    if (args.type !== undefined) {
      searchOpts.type = validateMemoryType(args.type, 'memory_search');
    }
    const threshold = validateThreshold(args.threshold, 'memory_search');
    if (threshold !== undefined) {
      searchOpts.threshold = threshold;
    }

    // Reading store.all() after store.search() returns intentionally
    // captures any rescan store.search performed internally (DAR-923 mtime
    // watch), so totalScanned reflects the post-rescan view the caller
    // would observe via list().
    const hits = await store.search(query, searchOpts);
    const totalScanned = store.all().length;

    const matches: MemorySearchMatch[] = hits.map((hit) => ({
      name: hit.memory.name,
      type: hit.memory.type,
      description: hit.memory.description,
      body: hit.memory.body,
      score: roundScore(hit.score),
    }));

    return { matches, query, totalScanned };
  };
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
