/**
 * MCP tool handlers for the memory tools.
 *
 * Each handler validates its arguments at entry, dispatches to the
 * corresponding {@link MemoryStore} method, and returns a JSON-serialisable
 * shape that the MCP server's CallToolRequest dispatcher (in `./server.ts`)
 * wraps in a single text content block.
 *
 * Validation is deliberately manual rather than via a schema library:
 * manual validation has zero new dependencies, and the rejection messages
 * are tailored to name the offending field. Error messages from the store
 * layer are passed through unchanged so they keep mentioning the offending
 * name.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
import { DEFAULT_CONNECTEDNESS_BOOST, DEFAULT_EXPANSION_DECAY } from './defaults.js';
import { detectScope, isHomedirOrAncestor } from '../bin/scope.js';
import type { ToolArguments, ToolHandler } from './tools.js';

/**
 * Error subclass that carries a stable, machine-readable token at the
 * `code` field. The server's CallTool dispatcher (see `./server.ts`)
 * recognises this class and surfaces the code on the `structuredContent`
 * field of the {@link CallToolResult} so an agent can match on the
 * failure mode without regex on the prose message.
 *
 * The literal `code` value is the contract surface; once published, it
 * must not be renamed without bumping a major version. The human-readable
 * `message` is allowed to evolve.
 */
export class CodedError extends Error {
  override readonly name = 'CodedError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Stable token surfaced on `structuredContent.code` when `memory_save`
 * (or any other store-dispatching handler) is asked to write to the
 * project store but no project store is wired. Agents match on this
 * literal to decide whether to invoke `memory_bootstrap_project_store`.
 */
export const ERROR_CODE_NO_PROJECT_STORE = 'NO_PROJECT_STORE';

/**
 * The two store scopes the server can address.
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
 *   - `{ store }` -- legacy single-store form. Treated as user-only mode:
 *     `store` becomes the user store and no project store is wired.
 *     Existing callers (and tests) that pass this shape continue to work;
 *     saves with `scope: 'project'` will be rejected.
 *
 *   - `{ userStore, projectStore? }` -- dual-store form. The user store is
 *     required; the project store is omitted in user-only mode.
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
   * `limit`. Resolved by the bin from `COMMONPLACE_DEFAULT_LIMIT`. When
   * omitted, the search handler falls back to
   * {@link DEFAULT_SEARCH_LIMIT}. Other handlers ignore this option.
   */
  defaultLimit?: number;
  /**
   * The user-scope {@link MemoryGraph} used for one-hop expansion in
   * `memory_search`. Threaded through the bin from the user
   * `MemoryStore`'s graph. When omitted, `expand: 'one-hop'` requests still
   * validate but produce no expanded neighbors for the user scope.
   */
  userGraph?: MemoryGraph;
  /**
   * The project-scope {@link MemoryGraph} used for one-hop expansion in
   * `memory_search`. Threaded through the bin from the project
   * `MemoryStore`'s graph when a project store was detected. When omitted,
   * `expand: 'one-hop'` requests still validate but produce no expanded
   * neighbors for the project scope.
   */
  projectGraph?: MemoryGraph;
  /**
   * Decay applied to expanded neighbors' scores in `memory_search`.
   * Resolved by the bin from `COMMONPLACE_EXPANSION_DECAY`. Defaults to
   * `0.7` when omitted.
   */
  expansionDecay?: number;
  /**
   * Alpha coefficient for the connectedness boost. Each direct cosine
   * hit's score is augmented by `alpha * log(1 + inbound_count)` before
   * the descending-score sort. `inbound_count` reads the per-scope
   * {@link MemoryGraph}'s inbound edges, filtered to exclude `mentions`
   * and `supersedes` edge types. Defaults to `0.02` when omitted; setting
   * to `0` disables the boost (and yields identical results to the
   * unboosted ranking).
   *
   * The boost composes with one-hop expansion: expanded neighbors'
   * decayed scores are computed from the BOOSTED direct-hit score (not
   * from raw cosine), so connectedness propagates through expansion
   * deterministically.
   */
  connectednessBoost?: number;
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
 * Validate the optional `scope` argument on read-side handlers. `undefined`
 * is allowed and returns `undefined`; anything else must be one of the two
 * literals in {@link SCOPES}. Errors list the allowed values. Write-side
 * handlers (`memory_save`) require an explicit scope and use
 * {@link requireScope} instead.
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

/**
 * Validate a required `scope` argument. Missing or `undefined` rejects with a
 * "required" error; any non-Scope value rejects with the same allowed-values
 * message as {@link validateScope}.
 */
const requireScope = (raw: unknown, toolName: string): Scope => {
  if (raw === undefined) {
    throw new Error(`${toolName}: field \`scope\` is required; pass one of ${SCOPES.join(', ')}`);
  }
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
  /** Which store the memory was written to. */
  scope: Scope;
}

/** Return shape for {@link createMemoryListHandler}. */
export interface MemoryListResult {
  memories: Array<{
    name: string;
    type: MemoryType;
    description: string;
    /** Which store this entry came from. */
    scope: Scope;
    /**
     * Mirrors the frontmatter `pinned` flag. `true` for entries the user has
     * pinned for surfacing in the startup recall pack; `false` (the default
     * for files that omit the key) otherwise.
     */
    pinned: boolean;
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
 * filter still works whether or not a graph is wired in.
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
      // (e.g. when graph traversal is exposed directly), pick a tie-break
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
  /** Which store the memory was removed from. */
  scope: Scope;
}

/**
 * The literal values accepted for `memory_search`'s `expand` argument.
 * `'none'` is the default and a true alias for omitting the field;
 * `'one-hop'` opts into outbound-edge expansion.
 */
export const EXPAND_MODES = ['none', 'one-hop'] as const;

/** Union type of {@link EXPAND_MODES}. */
export type ExpandMode = (typeof EXPAND_MODES)[number];

/**
 * The edge types `memory_search` will follow during one-hop expansion.
 * The four authored relation types plus `supersedes` and `mentions`;
 * structurally equivalent to {@link EdgeType} but re-declared here so we
 * don't accidentally widen by adding a never-walked sentinel to the
 * graph's edge enum.
 */
export const EXPAND_TYPES = [
  ...RELATION_TYPES,
  'supersedes',
  'mentions',
] as const satisfies readonly EdgeType[];

/**
 * Default `expandTypes` for `memory_search` one-hop expansion when the
 * caller does not supply one. Limited to the two "build-context"
 * relations on purpose: `builds-on` and `related-to` are
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
   * Full memory body verbatim. We never truncate, summarise, or otherwise
   * transform the body -- the caller gets exactly what was persisted, so a
   * follow-up read is unnecessary.
   */
  body: string;
  /** Cosine similarity from {@link MemoryStore.search}, rounded to 3 decimals. */
  score: number;
  /**
   * Outgoing graph edges authored on this memory's frontmatter `relations:`
   * list. Always present -- empty array when the memory has no authored
   * outgoing edges.
   *
   * Only the four authored {@link import('../store/memory.js').RelationType}
   * values surface here (`related-to`, `builds-on`, `contradicts`,
   * `child-of`). The `supersedes:` frontmatter list does NOT round-trip
   * through `relations` (`supersededBy` already carries that signal). Body
   * `[[name]]` mention edges are deliberately excluded too -- surfacing
   * them is the job of the dedicated `memory_graph` tool.
   */
  relations: Relation[];
  /**
   * Which store produced this match. Always present so callers can
   * disambiguate same-name entries across stores.
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
   * Present only on entries that were added by one-hop graph expansion;
   * absent on direct cosine hits (key absent, not undefined). `source` is
   * the name of the direct hit whose outbound edge pulled this neighbor
   * into the response; `edge` is the edge type that connected them.
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
    const scope = requireScope(args.scope, 'memory_save');
    const pinnedArg = validateBoolean(args.pinned, 'pinned', 'memory_save');

    if (scope === 'project' && projectStore === undefined) {
      throw new CodedError(
        ERROR_CODE_NO_PROJECT_STORE,
        `memory_save: scope='project' requires a project store, but none was detected -- the server is running in user-only mode (no COMMONPLACE_PROJECT_DIR, no roots/list root, no cwd .commonplace/memory marker). To bootstrap a project store on this connection, ask the user to confirm and then call the \`memory_bootstrap_project_store\` tool with \`{ userConfirmed: true }\`. The error code \`${ERROR_CODE_NO_PROJECT_STORE}\` is also exposed on this result's structuredContent.code field.`,
      );
    }

    const target = scope === 'project' ? projectStore! : userStore;
    // Preserve-on-update for `pinned`: when the caller omits the field on an
    // existing memory, the prior on-disk value carries forward. When the
    // memory is new, the default is `false`.
    let pinned: boolean;
    if (pinnedArg !== undefined) {
      pinned = pinnedArg;
    } else {
      const prior = target.all().find((e) => e.name === name);
      pinned = prior?.pinned === true;
    }
    const memory: Memory = { name, type, description, body, pinned };
    await target.upsert(memory);

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
 *   - `includeSuperseded` -- when `true`, include memories that have been
 *     superseded by another memory; default `false`, which omits them from
 *     the response.
 *
 * The response strips the body and any graph metadata, matching the
 * documented frontmatter-only shape. `relations` is NOT mirrored on
 * `memory_list` -- only `memory_search` matches gain outgoing relations.
 * The `includeSuperseded` flag is mirrored here so callers can scan the
 * corpus consistently across both tools.
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
        pinned: entry.pinned,
      })),
    };
  };
};

/**
 * Validate a `limit` argument. The search store layer delegates limit
 * sanitisation to the MCP layer; we accept positive integers, reject
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
 * Used by both `memory_search` and `memory_list` for `includeSuperseded`.
 * We deliberately reject truthy strings like `'true'` and
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
 * Validate the optional `expand` argument for `memory_search`.
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
 * Validate the optional `expandTypes` argument for `memory_search`.
 * `undefined` is allowed and returns `undefined`; anything else
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
 * Validate the optional `expandLimit` argument for `memory_search`.
 * Non-negative integer (zero is permitted -- it means "no
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
 * caller does not supply one. Capped at 2 so a single hub
 * memory cannot flood the response with its entire neighborhood; callers
 * that want more pass `expandLimit` explicitly.
 */
const DEFAULT_EXPAND_LIMIT = 2;

/**
 * Edge types that the connectedness boost IGNORES when counting
 * a memory's inbound edges. `mentions` is body-tokenizer-derived and
 * noisy (a passing reference is not necessarily a vote of importance);
 * `supersedes` is structural (the successor doesn't endorse the
 * predecessor, it replaces it). The four authored RelationType values
 * (`builds-on`, `related-to`, `contradicts`, `child-of`) are counted.
 */
const BOOST_EXCLUDED_EDGE_TYPES = new Set<EdgeType>(['mentions', 'supersedes']);

/**
 * Compute `inbound_count` for the connectedness boost: number of inbound
 * edges to `name` whose type is NOT in {@link BOOST_EXCLUDED_EDGE_TYPES}.
 * Returns `0` when the graph is undefined (the "optional graph" contract:
 * the handler keeps working in test setups without a graph).
 */
const countBoostInbound = (graph: MemoryGraph | undefined, name: string): number => {
  if (graph === undefined) return 0;
  const inbound = graph.inbound(name);
  let n = 0;
  for (const edge of inbound) {
    if (!BOOST_EXCLUDED_EDGE_TYPES.has(edge.type)) n++;
  }
  return n;
};

/**
 * Apply the connectedness boost to a raw cosine score. Returns
 * `score + alpha * log(1 + inboundCount)`. When `alpha === 0` this is a
 * no-op and returns the input score unchanged. Exported as a pure
 * function rather than inlined so the unit tests can pin the formula at
 * its single call site.
 */
const applyBoost = (score: number, alpha: number, inboundCount: number): number => {
  if (alpha === 0) return score;
  return score + alpha * Math.log(1 + inboundCount);
};

/**
 * Construct the `memory_search` handler bound to a specific store. Validates
 * the `{ query, limit?, type?, threshold?, includeSuperseded? }` argument
 * shape, dispatches to `store.search()`, applies the supersede filter,
 * and serialises the {@link SearchHit}s into the documented
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
 *     post-supersede-filter -- distinct from `matches.length`, which can be
 *     lower because of `type` / `threshold` / `limit`. When
 *     `includeSuperseded: true` is passed, `totalScanned` reflects the full
 *     corpus including superseded entries (the filter is a no-op).
 *
 * Limit sanitisation is the MCP tool layer's responsibility; we reject
 * NaN / negative / non-integer `limit` values rather than coercing.
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
 * Out of scope: reranking, snippet generation, and surfacing `mentions`
 * edges in `match.relations`.
 */
export const createMemorySearchHandler = (opts: HandlerOptions): ToolHandler => {
  const { userStore, projectStore } = resolveStores(opts, 'memory_search');
  // Resolve the default top-k once at handler-construction time. When the
  // bin supplies one (resolved from `COMMONPLACE_DEFAULT_LIMIT`), it
  // wins; otherwise we fall back to the store-layer default so this
  // handler still works in test setups that wire the factory directly
  // without an env-var pass.
  const fallbackLimit = opts.defaultLimit ?? DEFAULT_SEARCH_LIMIT;
  // Per-scope graph references plus expansion decay. The graphs are
  // optional -- when omitted, `expand: 'one-hop'` requests validate their
  // arguments but produce no expanded neighbors. This keeps the handler
  // usable from test harnesses that wire the factory without a graph.
  const userGraph = opts.userGraph;
  const projectGraph = opts.projectGraph;
  const expansionDecay = opts.expansionDecay ?? DEFAULT_EXPANSION_DECAY;
  // Alpha for the additive connectedness boost. Default lives in
  // `./defaults.ts` so the bin and the handler factory read from a single
  // source of truth; the bin resolves `COMMONPLACE_CONNECTEDNESS_BOOST`
  // (re-exporting the same default) and passes the result here. When
  // alpha is 0 the boost short-circuits (see {@link applyBoost}).
  const connectednessBoost = opts.connectednessBoost ?? DEFAULT_CONNECTEDNESS_BOOST;
  return async (rawArgs: ToolArguments): Promise<MemorySearchResult> => {
    const args = requireArgsObject(rawArgs, 'memory_search');
    const query = requireString(args, 'query', 'memory_search');

    // Build SearchOptions with only the fields the caller actually
    // supplied. The contract is "omits unset SearchOptions fields when the
    // corresponding tool argument is absent" -- we must not inject defaults
    // at this layer. The store's internal default of 5 takes effect when
    // `limit` is omitted; the env-var resolver for
    // `COMMONPLACE_DEFAULT_LIMIT` owns the override, so re-reading the env
    // var here would duplicate its scope.
    const callerLimit = validateLimit(args.limit, 'memory_search');
    const callerType =
      args.type !== undefined ? validateMemoryType(args.type, 'memory_search') : undefined;
    const threshold = validateThreshold(args.threshold, 'memory_search');
    const includeSuperseded =
      validateBoolean(args.includeSuperseded, 'includeSuperseded', 'memory_search') ?? false;
    const scope = validateScope(args.scope, 'memory_search');

    // Expansion knobs. Each is validated unconditionally so a
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
    // `limit` to the store when the caller omitted it (the contract is
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

      // Headroom for the supersede filter: when not including superseded
      // entries, enlarge the store-side limit so the supersede pass leaves
      // enough candidates.
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

      // Per-store totalScanned contribution. Mirrors the supersede-filter
      // semantics (post-supersede when not including superseded).
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

    // Apply the additive connectedness boost to each direct hit's score
    // BEFORE the descending-score sort. The boost is
    // `alpha * log(1 + inbound_count)` where `inbound_count` reads the
    // per-scope MemoryGraph's inbound edges, filtered to exclude
    // `mentions` and `supersedes` edge types (these are noisy /
    // structural and shouldn't influence ranking). When alpha is 0 (the
    // disable case) or the per-scope graph is undefined, the boost is
    // 0 and the score is unchanged -- preserves the "optional graph"
    // contract and the "alpha=0 -> pre-boost ranking" contract.
    //
    // Sort is on the BOOSTED score: ties on raw cosine but unequal
    // inbound counts should be broken by the boost, and a low-cosine
    // hub should NOT be promoted above a high-cosine leaf at any
    // reasonable alpha (see ac-4 ranking-stability sweep). Sort is
    // stable so identical boosted scores preserve per-store insertion
    // order (user before project).
    interface BoostedHit {
      hit: SearchHit;
      scope: Scope;
      score: number;
    }
    const boostedHits: BoostedHit[] = allHits.map(({ hit, scope: sc }) => {
      const graph = graphByScope.get(sc);
      const inboundCount = countBoostInbound(graph, hit.memory.name);
      const boosted = applyBoost(hit.score, connectednessBoost, inboundCount);
      return { hit, scope: sc, score: boosted };
    });
    boostedHits.sort((a, b) => b.score - a.score);

    // Build the unified candidate list. Direct hits are added
    // first, then expansion (when opted in) appends decayed neighbors
    // gated by `expandTypes`, `expandLimit`, and the per-scope supersede
    // filter. We deduplicate against direct-hit names so a memory that's
    // already a direct hit doesn't get a second slot as a neighbor of
    // some other direct hit; we also dedupe across neighbors so two
    // direct hits pointing at the same neighbor don't double-count it.
    //
    // The `score` on each direct candidate is the BOOSTED score, so
    // expansion's `direct.score * expansionDecay` propagates the boost
    // through to expanded neighbors -- expanded entries decay the boosted
    // direct-hit score, not raw cosine.
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

    const candidates: Candidate[] = boostedHits.map(({ hit, scope: sc, score }) => ({
      kind: 'direct',
      name: hit.memory.name,
      scope: sc,
      score,
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
          // Respect the type filter when the caller scoped the search.
          // Expansion shouldn't introduce off-type matches that direct
          // search would have rejected.
          if (callerType !== undefined && neighborEntry.type !== callerType) continue;

          const decayedScore = direct.score * expansionDecay;
          // Respect the threshold filter when the caller set one. The
          // threshold gates the SCORE returned to the caller; an expanded
          // neighbor whose decayed score falls below it shouldn't sneak
          // in.
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
      // one store. Delete requires an explicit scope to disambiguate when
      // the same name exists in both.
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
    // offending name, which is what the missing-name tests assert against.
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
 *   - rewrites the source `.md` through the atomic write helper
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
 * Existing single-store callers pass no scope and have no project store
 * -- they fall through to the user store unchanged.
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

// ===========================================================================
// memory_graph and memory_path
// ===========================================================================

/**
 * Edge types `memory_graph` and `memory_path` can traverse. The union
 * covers the four authored {@link RelationType} values plus `'supersedes'`
 * and `'mentions'`. The runtime constant is shared with the tool registry
 * so the inputSchema enum stays in lockstep with the validator.
 */
export const GRAPH_EDGE_TYPES = [
  ...RELATION_TYPES,
  'supersedes',
  'mentions',
] as const satisfies readonly EdgeType[];

/**
 * The three directions accepted by `memory_graph`.
 *
 * - `'out'` -- only outbound edges from the root are walked.
 * - `'in'` -- only inbound edges to the root are walked.
 * - `'both'` (default) -- both directions are walked.
 */
export const GRAPH_DIRECTIONS = ['out', 'in', 'both'] as const;
/** Union type of {@link GRAPH_DIRECTIONS}. */
export type GraphDirection = (typeof GRAPH_DIRECTIONS)[number];

/**
 * Default `types` filter for `memory_graph` traversal when the caller does
 * not supply one. Per the issue: "defaults to all authored types (omits
 * mentions unless requested)". The four authored {@link RelationType}
 * values plus `'supersedes'` are included; `'mentions'` is opt-in via an
 * explicit `types` argument.
 */
export const DEFAULT_GRAPH_TYPES: readonly EdgeType[] = [
  ...RELATION_TYPES,
  'supersedes',
] as const satisfies readonly EdgeType[];

/** Default depth for `memory_graph` when the caller omits `depth`. */
const DEFAULT_GRAPH_DEPTH = 1;

/** Default `maxDepth` for `memory_path` when the caller omits `maxDepth`. */
const DEFAULT_PATH_MAX_DEPTH = 5;

/** A node entry in {@link MemoryGraphResult}. */
export interface MemoryGraphNode {
  name: string;
  type: MemoryType;
  description: string;
}

/** An edge entry in {@link MemoryGraphResult} and {@link MemoryPathResult}. */
export interface MemoryGraphEdge {
  from: string;
  to: string;
  type: EdgeType;
}

/** Return shape for {@link createMemoryGraphHandler}. */
export interface MemoryGraphResult {
  root: MemoryGraphNode;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

/**
 * Return shape for {@link createMemoryPathHandler}. Either the path was
 * found (possibly empty when `from === to`) and `path` is the ordered edge
 * sequence; or no path exists within constraints and `path` is `null` plus
 * a `reason` discriminating "no path at all" from "no path within
 * `maxDepth`".
 */
export type MemoryPathResult =
  | { path: MemoryGraphEdge[] }
  | { path: null; reason: 'unreachable' | 'depth-exceeded' };

const isGraphDirection = (v: unknown): v is GraphDirection =>
  typeof v === 'string' && (GRAPH_DIRECTIONS as readonly string[]).includes(v);

const validateGraphDirection = (raw: unknown, toolName: string): GraphDirection | undefined => {
  if (raw === undefined) return undefined;
  if (!isGraphDirection(raw)) {
    throw new Error(
      `${toolName}: field \`direction\` must be one of ${GRAPH_DIRECTIONS.join(
        ', ',
      )}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

const validateGraphTypes = (raw: unknown, toolName: string): EdgeType[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${toolName}: field \`types\` must be an array of edge-type strings (${GRAPH_EDGE_TYPES.join(
        ', ',
      )}); got ${JSON.stringify(raw)}`,
    );
  }
  const out: EdgeType[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string' || !(GRAPH_EDGE_TYPES as readonly string[]).includes(entry)) {
      throw new Error(
        `${toolName}: field \`types[${i}]\` must be one of ${GRAPH_EDGE_TYPES.join(
          ', ',
        )}; got ${JSON.stringify(entry)}`,
      );
    }
    out.push(entry as EdgeType);
  }
  return out;
};

const validateNonNegativeInteger = (
  raw: unknown,
  field: string,
  toolName: string,
): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `${toolName}: field \`${field}\` must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `${toolName}: field \`${field}\` must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

const validatePositiveInteger = (
  raw: unknown,
  field: string,
  toolName: string,
): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `${toolName}: field \`${field}\` must be a positive integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `${toolName}: field \`${field}\` must be a positive integer; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * Pick the per-scope user or project store + graph that owns `name`. Mirrors
 * {@link pickStoreForName} but also returns the matching graph reference and
 * scope so the traversal handler can walk the right adjacency.
 *
 * Resolution order matches the existing CRUD handlers:
 *
 *   - explicit `scope: 'project'` requires a project store
 *   - explicit `scope: 'user'` routes to the user store
 *   - implicit: name in both stores is ambiguous; otherwise route to
 *     whichever store holds it (defaulting to user when missing)
 *
 * The traversal handler additionally requires the picked store to actually
 * contain `name` (a missing-name lookup is a clear error, not a silent
 * empty traversal). Callers receive the store and graph -- callers that
 * need only the graph (`memory_path`'s second-pass node lookup) use the
 * returned store separately to resolve entries by name.
 */
const pickStoreAndGraphForName = (
  name: string,
  explicitScope: Scope | undefined,
  userStore: MemoryStore,
  projectStore: MemoryStore | undefined,
  userGraph: MemoryGraph | undefined,
  projectGraph: MemoryGraph | undefined,
  toolName: string,
): { store: MemoryStore; graph: MemoryGraph | undefined; scope: Scope } => {
  const store = pickStoreForName(name, explicitScope, userStore, projectStore, toolName);
  const scope: Scope = store === userStore ? 'user' : 'project';
  const graph = scope === 'user' ? userGraph : projectGraph;
  return { store, graph, scope };
};

/**
 * Construct the `memory_graph` handler. Walks the per-scope {@link MemoryGraph}
 * via BFS from the root, gated by `depth`, `types`, and `direction`. Returns
 * the root plus every reachable node and the edges that connected them.
 *
 * Cycles are handled with a visited set keyed by memory name -- a memory is
 * enqueued at most once. Self-edges cannot exist (the graph rejects them at
 * `add` / `addEdge` time) so we do not special-case them.
 *
 * Dangling edges are skipped silently: when an edge's `to` does not resolve
 * to a loaded memory in the store, neither the edge nor a synthetic node is
 * surfaced. The graph keeps the dangling edge for `detectDangling()`; this
 * tool intentionally does not.
 */
export const createMemoryGraphHandler = (opts: HandlerOptions): ToolHandler => {
  const { userStore, projectStore } = resolveStores(opts, 'memory_graph');
  const userGraph = opts.userGraph;
  const projectGraph = opts.projectGraph;
  return async (rawArgs: ToolArguments): Promise<MemoryGraphResult> => {
    const args = requireArgsObject(rawArgs, 'memory_graph');
    const name = requireString(args, 'name', 'memory_graph');
    validateMemoryName(name, 'memory_graph');
    const depth =
      validateNonNegativeInteger(args.depth, 'depth', 'memory_graph') ?? DEFAULT_GRAPH_DEPTH;
    const types = validateGraphTypes(args.types, 'memory_graph');
    const direction = validateGraphDirection(args.direction, 'memory_graph') ?? 'both';
    const scope = validateScope(args.scope, 'memory_graph');

    const picked = pickStoreAndGraphForName(
      name,
      scope,
      userStore,
      projectStore,
      userGraph,
      projectGraph,
      'memory_graph',
    );

    // Build a single name -> entry lookup up front -- the root lookup and
    // per-neighbor projection both reuse it, so the store is scanned once
    // per call rather than once for the root and once for the BFS.
    const entryByName = new Map<string, MemoryEntry>();
    for (const e of picked.store.all()) entryByName.set(e.name, e);

    const rootEntry = entryByName.get(name);
    if (rootEntry === undefined) {
      throw new Error(
        `memory_graph: memory \`${name}\` does not exist in the ${picked.scope} store`,
      );
    }

    const root: MemoryGraphNode = {
      name: rootEntry.name,
      type: rootEntry.type,
      description: rootEntry.description,
    };

    const nodes: MemoryGraphNode[] = [root];
    const edges: MemoryGraphEdge[] = [];

    if (picked.graph === undefined) {
      return { root, nodes, edges };
    }

    const allowedTypes = new Set<EdgeType>(types ?? DEFAULT_GRAPH_TYPES);

    // BFS layer by layer. `visited` covers the root so we don't re-emit it
    // as a node if a cycle leads back to it.
    const visited = new Set<string>([name]);
    const edgeKeySeen = new Set<string>();
    let frontier: string[] = [name];

    for (let layer = 0; layer < depth && frontier.length > 0; layer++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const outgoing: { edge: { from: string; to: string; type: EdgeType }; neighbor: string }[] =
          [];
        if (direction === 'out' || direction === 'both') {
          for (const e of picked.graph.outbound(current)) {
            outgoing.push({ edge: e, neighbor: e.to });
          }
        }
        if (direction === 'in' || direction === 'both') {
          for (const e of picked.graph.inbound(current)) {
            outgoing.push({ edge: e, neighbor: e.from });
          }
        }
        for (const { edge, neighbor } of outgoing) {
          if (!allowedTypes.has(edge.type)) continue;
          const neighborEntry = entryByName.get(neighbor);
          if (neighborEntry === undefined) continue; // skip dangling

          // Deduplicate edges (an undirected pair `both` may surface the
          // same edge once from each side; same edge between layers is
          // also possible in cyclic graphs). Key includes from+to+type so
          // distinct typed edges between the same pair are preserved.
          // `JSON.stringify` provides an unambiguous structured key so
          // adjacent string fields cannot collide via concatenation (e.g.
          // ('a', 'bX', t) vs ('ab', 'X', t)). Today's `validateMemoryName`
          // forbids the characters that would induce a collision, but the
          // structured key removes the latent dependency.
          const edgeKey = JSON.stringify([edge.from, edge.to, edge.type]);
          if (!edgeKeySeen.has(edgeKey)) {
            edgeKeySeen.add(edgeKey);
            edges.push({ from: edge.from, to: edge.to, type: edge.type });
          }

          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nodes.push({
              name: neighborEntry.name,
              type: neighborEntry.type,
              description: neighborEntry.description,
            });
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return { root, nodes, edges };
  };
};

/**
 * Construct the `memory_path` handler. BFS from `from` to `to` over the
 * per-scope {@link MemoryGraph}; returns the shortest path or
 * `{ path: null, reason }` distinguishing unreachable from exceeded depth.
 *
 * Direction: outbound only. The issue's response shape lists `from`/`to` on
 * each edge with the same semantics as `memory_graph` outbound walks --
 * we only follow outbound edges of the current node so the returned path
 * is a valid directed sequence.
 *
 * Cycles are handled with a visited set on the parent map -- a node enters
 * the BFS frontier at most once, so an A->B->A->... loop terminates.
 *
 * `from === to` returns `{ path: [] }` verbatim (issue: "empty if
 * from === to").
 */
export const createMemoryPathHandler = (opts: HandlerOptions): ToolHandler => {
  const { userStore, projectStore } = resolveStores(opts, 'memory_path');
  const userGraph = opts.userGraph;
  const projectGraph = opts.projectGraph;
  return async (rawArgs: ToolArguments): Promise<MemoryPathResult> => {
    const args = requireArgsObject(rawArgs, 'memory_path');
    const from = requireString(args, 'from', 'memory_path');
    validateMemoryName(from, 'memory_path');
    const to = requireString(args, 'to', 'memory_path');
    validateMemoryName(to, 'memory_path');
    const maxDepth =
      validatePositiveInteger(args.maxDepth, 'maxDepth', 'memory_path') ?? DEFAULT_PATH_MAX_DEPTH;
    const types = validateGraphTypes(args.types, 'memory_path');
    const scope = validateScope(args.scope, 'memory_path');

    // Self-path short-circuit: when from === to the issue specifies an
    // empty edge sequence (NOT null). We still validate that the memory
    // exists so callers learn about typos rather than getting a misleading
    // empty success.
    const picked = pickStoreAndGraphForName(
      from,
      scope,
      userStore,
      projectStore,
      userGraph,
      projectGraph,
      'memory_path',
    );

    const fromEntry = picked.store.all().find((e) => e.name === from);
    if (fromEntry === undefined) {
      throw new Error(
        `memory_path: memory \`${from}\` does not exist in the ${picked.scope} store`,
      );
    }

    if (from === to) {
      return { path: [] };
    }

    // Verify `to` exists in the same scope -- edges are intra-scope per the
    // store contract. If the target lives in a different store, no path
    // can connect them through this graph.
    const toEntry = picked.store.all().find((e) => e.name === to);
    if (toEntry === undefined) {
      // The destination doesn't exist (or is in a different scope).
      // Surface as 'unreachable' rather than a hard error -- callers
      // commonly hit this when exploring a stale name and the documented
      // response shape supports it.
      return { path: null, reason: 'unreachable' };
    }

    if (picked.graph === undefined) {
      return { path: null, reason: 'unreachable' };
    }

    // When `types` is omitted, follow every edge type -- BFS will pick the
    // shortest path regardless of label. When `types` is set, only those
    // edge labels are walked.
    const allowedTypes = types === undefined ? null : new Set<EdgeType>(types);

    // BFS. For each visited node we record the edge that reached it
    // (`parent`) so we can reconstruct the path on success. Depth is
    // tracked per node so we can terminate cleanly on `depth-exceeded`.
    interface ParentRef {
      from: string;
      edgeType: EdgeType;
      depth: number;
    }
    const parent = new Map<string, ParentRef>();
    parent.set(from, { from: '', edgeType: 'related-to', depth: 0 }); // sentinel
    const queue: string[] = [from];
    let found = false;
    let depthLimitHit = false;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDepth = parent.get(current)!.depth;
      if (currentDepth >= maxDepth) {
        // Don't expand past the depth bound. Track that we hit the bound
        // so we can return 'depth-exceeded' rather than 'unreachable'.
        depthLimitHit = true;
        continue;
      }
      for (const edge of picked.graph.outbound(current)) {
        if (allowedTypes !== null && !allowedTypes.has(edge.type)) continue;
        if (parent.has(edge.to)) continue;
        parent.set(edge.to, {
          from: current,
          edgeType: edge.type,
          depth: currentDepth + 1,
        });
        if (edge.to === to) {
          found = true;
          break;
        }
        queue.push(edge.to);
      }
      if (found) break;
    }

    if (!found) {
      // Distinguish unreachable from depth-exceeded. If we hit the depth
      // cap at any node during the BFS, AND the target was not already
      // unreachable for other reasons, report 'depth-exceeded'. Otherwise
      // 'unreachable'.
      //
      // The reachability check here re-runs BFS without the depth bound
      // but still respects the type filter -- it tells us whether a path
      // exists at all. We keep it scoped: only run when we hit the depth
      // limit (so the common unreachable case is one BFS, not two).
      if (depthLimitHit) {
        const reachable = isReachable(picked.graph, from, to, allowedTypes);
        if (reachable) {
          return { path: null, reason: 'depth-exceeded' };
        }
      }
      return { path: null, reason: 'unreachable' };
    }

    // Reconstruct the path by walking the parent chain backward from `to`.
    const path: MemoryGraphEdge[] = [];
    let cursor = to;
    while (cursor !== from) {
      const p = parent.get(cursor)!;
      path.push({ from: p.from, to: cursor, type: p.edgeType });
      cursor = p.from;
    }
    path.reverse();
    return { path };
  };
};

/**
 * Unbounded-depth reachability check used when the bounded BFS hits the
 * depth limit without finding the target. Returns `true` iff some path
 * exists from `from` to `to` under the supplied type filter (or any type
 * when `allowedTypes` is `null`). Cycle-safe via a visited set.
 *
 * This is a separate pass rather than tracking reachability inside the
 * main BFS because the main BFS terminates early at `maxDepth` -- a node
 * one hop beyond the cap is never enqueued, so we cannot conclude
 * "unreachable" from it alone. Running this only when the depth cap was
 * actually hit keeps the common case (no depth cap encountered) at a
 * single BFS.
 */
const isReachable = (
  graph: MemoryGraph,
  from: string,
  to: string,
  allowedTypes: Set<EdgeType> | null,
): boolean => {
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.outbound(current)) {
      if (allowedTypes !== null && !allowedTypes.has(edge.type)) continue;
      if (edge.to === to) return true;
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push(edge.to);
    }
  }
  return false;
};

// --------------------------------------------------------------------------
// memory_bootstrap_project_store handler
//
// Wires the agent-driven bootstrap-on-approval flow: when `memory_save` with
// `scope: 'project'` fails with `NO_PROJECT_STORE`, the agent (after explicit
// user confirmation) calls this tool to re-detect a project root, create the
// `<root>/.commonplace/memory` directory, construct a project `MemoryStore`,
// and re-bind the running server's CallTool handler map so subsequent
// project-scope saves succeed on the same MCP connection.
// --------------------------------------------------------------------------

/**
 * Factory for building a fresh project {@link MemoryStore} (and its
 * accompanying {@link MemoryGraph}). Threaded through the bootstrap
 * environment by the bin so the handler does not need to know the
 * constructor shape of either class (avoiding a direct import that would
 * be hard to stub in unit tests).
 */
export interface ProjectStoreFactory {
  (dir: string): Promise<{ store: MemoryStore; graph: MemoryGraph }>;
}

/**
 * Callback the bootstrap handler invokes once a fresh project store has
 * been constructed and scanned. The bin supplies an implementation that
 * rebuilds the {@link ToolHandlerMap} via `createDefaultHandlers` and calls
 * `installCallToolHandler(server, handlers)` so subsequent CallTool requests
 * see the new project store. Keeping this as a callback avoids a circular
 * import between `handlers.ts` and `server.ts` (which already imports from
 * `handlers.ts` for `CodedError`).
 */
export interface RebindHandlersCallback {
  (projectStore: MemoryStore, projectGraph: MemoryGraph): void;
}

/**
 * Environment supplied to {@link createMemoryBootstrapHandler}. Carries:
 *
 *   - The detection inputs (`env`, `cwd`, `homedir`) the handler hands to
 *     {@link detectScope} so the project-root walk matches the boot path
 *     exactly (no duplicate walk implementation).
 *   - The {@link ProjectStoreFactory} the handler uses to build a fresh
 *     project store once a root is resolved.
 *   - The {@link RebindHandlersCallback} the handler invokes to swap the
 *     server's CallTool handler map post-bootstrap.
 *   - An optional `mkdir` probe so tests can intercept directory creation
 *     without touching real disk.
 */
export interface BootstrapEnvironment {
  /**
   * Environment-variable snapshot threaded into {@link detectScope}. The
   * bin passes `process.env`; tests pass a hand-built object.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Working directory the cwd-walk starts from. The bin passes
   * `process.cwd()`; tests pass a tmp dir.
   */
  cwd: string;
  /**
   * Home directory used to bound the upward walk and to enforce the
   * $HOME-exclusive safety check on the explicit `path` override. The
   * bin passes `os.homedir()`; tests pass a fake path.
   */
  homedir: string;
  /**
   * Factory that constructs a fresh project store and its graph for the
   * resolved directory. The bin wires this so the store shares the
   * existing {@link EmbedderShape} instance (the project store reuses the
   * user store's embedder by contract).
   */
  createProjectStore: ProjectStoreFactory;
  /**
   * Called once the project store is constructed and scanned. The bin
   * uses this to rebuild the CallTool handler map and call
   * `installCallToolHandler` on the running server. Tests can supply a
   * spy.
   */
  rebindHandlers: RebindHandlersCallback;
  /**
   * `mkdir -p` probe used to create the project memory directory before
   * the store is constructed. Defaults to `node:fs/promises.mkdir(..., {
   * recursive: true })`. Tests can override to intercept disk writes.
   */
  mkdir?: (path: string) => Promise<void>;
}

/** Return shape for a successful bootstrap. */
export interface MemoryBootstrapResult {
  /** The detected (or user-supplied) project root path. */
  projectRoot: string;
  /** The created project memory directory (`<projectRoot>/.commonplace/memory`). */
  projectMemoryDir: string;
  /** Which branch produced the project root: `'env'`, `'cwd'`, `'path'`. */
  source: 'env' | 'cwd' | 'path';
}

/**
 * Construct the `memory_bootstrap_project_store` handler. The handler is
 * deliberately strict about its inputs:
 *
 *   - `userConfirmed` must be `=== true`. Truthy-but-not-strict-true values
 *     (`'true'`, `1`, `{}`, etc.) are rejected so an agent cannot
 *     bootstrap a project store without surfacing the request to the user.
 *   - `path`, when supplied, must be a string. It bypasses the walk but
 *     still has to pass the $HOME-exclusive safety check (the path must
 *     not equal `$HOME` or be an ancestor of `$HOME`).
 *
 * On success the handler creates `<root>/.commonplace/memory` (no-op if it
 * already exists), constructs the project store via the supplied factory,
 * scans it, and calls the rebind callback to re-bind the server's
 * CallTool handler map.
 *
 * Failures (no detection result; $HOME safety refusal; store construction
 * throw) propagate as plain `Error`s through the CallTool dispatcher's
 * standard `isError=true` envelope. The bootstrap path does NOT mint a
 * fresh {@link CodedError} -- there is only one stable error code surface
 * on this server today (`NO_PROJECT_STORE`, defined for `memory_save`),
 * and bootstrap failures are operator-actionable from the human-readable
 * message alone.
 */
export const createMemoryBootstrapHandler = (env: BootstrapEnvironment): ToolHandler => {
  const mkdirProbe = env.mkdir ?? ((p: string) => mkdir(p, { recursive: true }).then(() => {}));
  return async (rawArgs: ToolArguments): Promise<MemoryBootstrapResult> => {
    const args = requireArgsObject(rawArgs, 'memory_bootstrap_project_store');
    // Strict-true gate. We deliberately do NOT use `validateBoolean` here
    // (which accepts both `true` and `false`) -- the AC requires
    // rejection of any value that is not the literal boolean `true`.
    if (!Object.prototype.hasOwnProperty.call(args, 'userConfirmed')) {
      throw new Error(
        'memory_bootstrap_project_store: field `userConfirmed` is required and must be strictly `true`',
      );
    }
    if (args.userConfirmed !== true) {
      throw new Error(
        `memory_bootstrap_project_store: field \`userConfirmed\` must be strictly \`true\` (no truthy coercion); got ${JSON.stringify(args.userConfirmed)}`,
      );
    }

    // Optional explicit path override. When set, detection is skipped but
    // the $HOME-exclusive safety check still applies.
    let pathOverride: string | undefined;
    if (args.path !== undefined) {
      if (typeof args.path !== 'string') {
        throw new Error(
          `memory_bootstrap_project_store: field \`path\` must be a string when supplied; got ${JSON.stringify(args.path)}`,
        );
      }
      if (args.path.length === 0) {
        throw new Error(
          'memory_bootstrap_project_store: field `path` must be a non-empty string when supplied',
        );
      }
      pathOverride = args.path;
    }

    let projectRoot: string;
    let source: 'env' | 'cwd' | 'path';
    if (pathOverride !== undefined) {
      // Path override branch: enforce $HOME-exclusive safety, bypass walk.
      if (isHomedirOrAncestor(pathOverride, env.homedir)) {
        throw new Error(
          `memory_bootstrap_project_store: refusing to bootstrap at ${JSON.stringify(pathOverride)} -- the $HOME-exclusive safety check rejects $HOME and any ancestor of $HOME (which would either clobber the user store at ~/.commonplace/memory or wire a project store at a parent directory)`,
        );
      }
      projectRoot = pathOverride;
      source = 'path';
    } else {
      // Detection branch: reuse the same scope.ts entry point boot.ts uses.
      // Pass `roots: null` because roots/list has already happened during
      // the initial boot; this bootstrap path only re-runs the env + cwd
      // walk steps. The walk's own $HOME-exclusive guard makes the safety
      // check redundant for the cwd branch, but env-supplied paths are
      // not subject to it (matching the env override semantics) so the
      // bin is expected to set COMMONPLACE_PROJECT_DIR with care.
      const detected = detectScope({
        env: env.env,
        roots: null,
        cwd: env.cwd,
        homedir: env.homedir,
      });
      if (detected.projectDir === null) {
        throw new Error(
          'memory_bootstrap_project_store: no project root detected. The upward walk from cwd found no `.git/` or `.commonplace/` marker before reaching $HOME, and no `COMMONPLACE_PROJECT_DIR` env-var override was set. To remediate: (a) set `COMMONPLACE_PROJECT_DIR` to an explicit project directory and retry, (b) `git init` the workspace (or create a `.commonplace/` marker directory) so the walk finds a marker, or (c) pass an explicit `path` argument to this tool naming the directory to use as the project root.',
        );
      }
      // `detected.projectDir` is `<root>/.commonplace/memory` for the
      // cwd-walk branch. Recover the root with separator-agnostic dirname
      // composition. For env overrides the value is used verbatim (the
      // env-var path may not follow the conventional suffix layout), so we
      // report the memory dir itself as the root.
      const memoryDir = detected.projectDir;
      if (detected.source === 'env') {
        projectRoot = memoryDir;
        source = 'env';
      } else {
        projectRoot = dirname(dirname(memoryDir));
        source = 'cwd';
      }
    }

    // Create `<root>/.commonplace/memory` if missing. For the path-override
    // and cwd branches we synthesize the conventional layout; for env
    // overrides whose value is already a full memory-dir path, we use it
    // verbatim. The `mkdir -p` is idempotent so a pre-existing directory
    // is a no-op.
    let projectMemoryDir: string;
    if (source === 'env') {
      // env override branch: the env var names the memory dir directly.
      projectMemoryDir = projectRoot;
    } else {
      projectMemoryDir = join(projectRoot, '.commonplace', 'memory');
    }
    await mkdirProbe(projectMemoryDir);

    // Construct the project store + graph, scan it (no-op when the dir is
    // empty), and rebind the handler map.
    const { store, graph } = await env.createProjectStore(projectMemoryDir);
    await store.scan();
    env.rebindHandlers(store, graph);

    return {
      projectRoot,
      projectMemoryDir,
      source,
    };
  };
};
