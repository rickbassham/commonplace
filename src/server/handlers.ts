/**
 * DAR-919 MCP CRUD handlers: `memory_save`, `memory_list`, `memory_delete`.
 *
 * These are thin handlers over {@link MemoryStore} (DAR-916). Each handler
 * validates its arguments at entry, dispatches to the corresponding store
 * method, and returns a JSON-serialisable shape that the MCP server's
 * CallToolRequest dispatcher (in `./server.ts`) wraps in a single text
 * content block.
 *
 * Validation is deliberately manual rather than via a schema library --
 * the contract envelope leaves the choice to the implementer, manual
 * validation has zero new dependencies, and the rejection messages are
 * tailored to name the offending field. Error messages from the store
 * layer (DAR-916 / DAR-923) are passed through unchanged so they keep
 * mentioning the offending name.
 *
 * Scope (DAR-919): the three CRUD handlers above. `memory_search` is
 * still owned by sibling DAR-920 and remains wired to the not-implemented
 * stub from `./tools.ts`. Argument shapes match the inputSchema entries
 * tightened in the same module.
 */

import { join } from 'node:path';

import { MEMORY_TYPES, NAME_PATTERN, type Memory, type MemoryType } from '../store/memory.js';
import type { MemoryStore } from '../store/memory-store.js';
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
 * Validate a memory `name` argument: must be a string, must not contain a
 * path separator, must match `^[a-z0-9_]+$`. Errors mention path separators
 * explicitly when the failure is a path separator, and reference the allowed
 * pattern otherwise -- both for parity with `validateName` in
 * `src/store/memory.ts` and to satisfy contract tests.
 */
const validateMemoryName = (name: string, toolName: string): void => {
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(
      `${toolName}: field \`name\` must not contain a path separator ('/' or '\\\\'); got ${JSON.stringify(name)}`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `${toolName}: field \`name\` must match ^[a-z0-9_]+$ (lowercase letters, digits, underscore); got ${JSON.stringify(name)}`,
    );
  }
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
    // Note: we deliberately do NOT validate the `name` against the
    // ^[a-z0-9_]+$ pattern here. Delete must accept any name the user
    // passes so they can reach an entry whose name slipped past validation
    // by a different code path; the store still rejects unknown names.
    await store.delete(name);
    return { deleted: name };
  };
};
