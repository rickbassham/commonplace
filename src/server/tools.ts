/**
 * MCP tool registry for the commonplace server.
 *
 * This module is the single source of truth for the four tool names
 * (`memory_search`, `memory_save`, `memory_list`, `memory_delete`) and the
 * stub handlers wired to them. Sibling issues (DAR-919, DAR-920, etc.) will
 * replace each stub handler in place without changing the registration
 * surface.
 *
 * The registry is exposed as a typed module export so other modules (and
 * tests) can introspect it directly without going through a running server.
 *
 * Scope (DAR-909): tool registration, ListTools schema delivery, and
 * CallTool name dispatch. Argument validation, real handler logic, and the
 * final inputSchema shape for each tool are owned by the sibling handler
 * issues. The schemas here are structurally valid (object with a properties
 * map) and aligned with the documented argument shapes in those issues, but
 * they are intentionally loose -- handlers will tighten them.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { MEMORY_TYPES, RELATION_TYPES } from '../store/memory.js';
import type { MemoryGraph } from '../store/graph.js';
import type { MemoryStore } from '../store/memory-store.js';
import {
  SCOPES,
  createMemoryDeleteHandler,
  createMemoryLinkHandler,
  createMemoryListHandler,
  createMemorySaveHandler,
  createMemorySearchHandler,
  createMemoryUnlinkHandler,
} from './handlers.js';

/** The exact tool names this server exposes, in registration order. */
export const TOOL_NAMES = [
  'memory_search',
  'memory_save',
  'memory_list',
  'memory_delete',
  'memory_link',
  'memory_unlink',
] as const;

/** Element type of {@link TOOL_NAMES}. */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Arguments object passed to a tool handler. The MCP SDK delivers
 * `Record<string, unknown>` (or omits the field entirely); we accept the
 * same shape so handlers can do their own validation.
 */
export type ToolArguments = Record<string, unknown> | undefined;

/**
 * Tool handler signature. Handlers may throw; the dispatcher surfaces the
 * thrown error to the MCP client.
 *
 * The return type is intentionally loose (`unknown`) for the shell. The
 * sibling issues that implement each handler will narrow the return type
 * at their handler implementation, not in the shell.
 */
export type ToolHandler = (args: ToolArguments) => Promise<unknown>;

/** Map from tool name to handler implementation. */
export type ToolHandlerMap = Record<ToolName, ToolHandler>;

/**
 * Registered tool definition: the public schema fields plus the bound
 * handler. The schema fields match the MCP SDK's `Tool` type so they can be
 * returned from ListTools without remapping.
 */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Tool['inputSchema'];
  readonly handler: ToolHandler;
}

/**
 * Stub handler used for every tool in this issue. Sibling issues will
 * replace each stub with a real handler at the call sites in
 * {@link buildToolDefinitions}.
 *
 * The error message is exactly `'not implemented'` so the contract test in
 * `tests/server-tools.test.ts` (and downstream callers) can match on it.
 */
const notImplemented: ToolHandler = async () => {
  throw new Error('not implemented');
};

/**
 * Options for {@link createDefaultHandlers}. Two shapes are accepted:
 *
 *   - **Legacy (DAR-919)**: `{ store }` -- treated as user-only mode; `store`
 *     becomes the user store and no project store is wired. Saves with
 *     `scope: 'project'` are rejected. Existing tests and callers that pass
 *     this shape continue to work.
 *   - **DAR-924 dual-store**: `{ userStore, projectStore? }` -- the user
 *     store is required; the project store is omitted in user-only mode.
 *
 * When neither `store` nor `userStore` is supplied, every tool falls back
 * to the not-implemented stub (preserving the DAR-909 baseline for callers
 * that haven't wired a store yet).
 */
export interface CreateDefaultHandlersOptions {
  /**
   * Legacy single-store option (DAR-919). Treated as the user store.
   *
   * @deprecated Prefer `userStore` (and optional `projectStore`).
   */
  store?: MemoryStore;
  /**
   * The user-level memory store (DAR-924). Always loaded.
   */
  userStore?: MemoryStore;
  /**
   * The project-level memory store (DAR-924). Loaded only when a project
   * root is detected; absent in user-only mode.
   */
  projectStore?: MemoryStore;
  /**
   * Optional in-memory graph (DAR-926). The graph is owned by the
   * {@link MemoryStore} (passed to `new MemoryStore({ dir, embedder, graph })`)
   * which keeps it in sync via scan/save/delete/linkEdge/unlinkEdge. The
   * link/unlink handlers themselves do not need a graph reference -- they
   * dispatch through the store, which owns the single graph instance.
   *
   * This option is accepted (and the bin passes it) to make the wiring
   * intent explicit at the call site -- "this server has a graph, and it is
   * threaded through both the store and the handler layer" -- per DAR-928
   * ac-5. It is otherwise unused.
   */
  graph?: MemoryGraph;
}

/**
 * Default handler map. When a user store is supplied (via either the legacy
 * `store` field or the DAR-924 `userStore` field), all six tools are wired
 * to real handlers (memory_search via DAR-920 + DAR-924 dual-store merge,
 * CRUD via DAR-919 + DAR-924 scope routing, link/unlink via DAR-928 +
 * DAR-924 scope routing). When neither is supplied, every tool falls back
 * to the not-implemented stub.
 */
export function createDefaultHandlers(options: CreateDefaultHandlersOptions = {}): ToolHandlerMap {
  const userStore = options.userStore ?? options.store;
  const projectStore = options.projectStore;
  // `options.graph` is intentionally unused here -- see
  // CreateDefaultHandlersOptions for the wiring rationale.
  if (userStore === undefined) {
    return {
      memory_search: notImplemented,
      memory_save: notImplemented,
      memory_list: notImplemented,
      memory_delete: notImplemented,
      memory_link: notImplemented,
      memory_unlink: notImplemented,
    };
  }
  const handlerOpts = { userStore, projectStore };
  return {
    memory_search: createMemorySearchHandler(handlerOpts),
    memory_save: createMemorySaveHandler(handlerOpts),
    memory_list: createMemoryListHandler(handlerOpts),
    memory_delete: createMemoryDeleteHandler(handlerOpts),
    memory_link: createMemoryLinkHandler(handlerOpts),
    memory_unlink: createMemoryUnlinkHandler(handlerOpts),
  };
}

/**
 * Per-tool inputSchema definitions. Each is a JSON Schema object with a
 * (possibly empty) `properties` map. The shapes here are aligned with the
 * documented argument structures in the sibling handler issues; the final
 * source of truth for each shape is the issue that implements that handler.
 */
const TOOL_SCHEMAS: Record<ToolName, { description: string; inputSchema: Tool['inputSchema'] }> = {
  memory_search: {
    description:
      'Semantic search over saved memories across both the user and project stores (when the project store is present). Returns the top-k matches by cosine similarity against the embedding index, merged across stores by descending score; each match carries a `scope` tag identifying which store produced it. By default, memories that have been superseded by another entry are excluded from results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        limit: {
          type: 'integer',
          description:
            'Maximum number of results to return after merging across stores. Defaults to 5.',
          minimum: 1,
        },
        type: {
          type: 'string',
          enum: [...MEMORY_TYPES],
          description: 'Optional filter restricting results to memories of this type.',
        },
        threshold: {
          type: 'number',
          description:
            'Optional minimum cosine similarity for an entry to appear in results. Cosine range is [-1, 1].',
        },
        includeSuperseded: {
          type: 'boolean',
          description:
            'When true, include memories that have been superseded by another memory. Defaults to false. Superseded matches carry a `supersededBy` field naming the superseding memory.',
        },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            "Optional filter restricting results to a single store. 'user' searches only the user store; 'project' searches only the project store. Default: search both stores when the project store is present.",
        },
      },
      required: ['query'],
    },
  },
  memory_save: {
    description:
      'Save a memory as a markdown file with YAML frontmatter and a derived embedding sidecar. Refuses to overwrite an existing entry; the contract is delete + save. The `scope` argument selects which store to write to (default `user`); saving to `project` requires that a project store was detected at boot.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Memory name. Must match ^[a-z0-9_]+$ and contain no path separators. Becomes the filename stem.',
        },
        type: {
          type: 'string',
          enum: [...MEMORY_TYPES],
          description: 'One of user | feedback | project | reference.',
        },
        description: {
          type: 'string',
          description: 'Short human description carried in frontmatter.',
        },
        body: { type: 'string', description: 'Markdown body content.' },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            "Which store to write to. 'user' (default) saves under COMMONPLACE_USER_DIR. 'project' saves under the detected project store; rejects with a clear error if no project store is wired.",
        },
      },
      required: ['name', 'type', 'description', 'body'],
    },
  },
  memory_list: {
    description:
      'List saved memories from both stores. Returns frontmatter-only entries (name, type, description, scope) -- no body. Each entry carries a `scope` tag (`user` | `project`) identifying which store it came from. By default, memories that have been superseded by another entry within their own store are excluded from results.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [...MEMORY_TYPES],
          description: 'Optional filter restricting results to memories of this type.',
        },
        includeSuperseded: {
          type: 'boolean',
          description:
            'When true, include memories that have been superseded by another memory. Defaults to false.',
        },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            "Optional filter restricting results to a single store. 'user' lists only the user store; 'project' lists only the project store. Default: list both stores when the project store is present.",
        },
      },
    },
  },
  memory_delete: {
    description:
      'Delete a saved memory by name. The `scope` argument is required to disambiguate when the same name exists in both stores; otherwise the lookup automatically resolves to whichever store contains the name. Throws when the name is not present in the targeted scope.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Memory name (filename stem) to delete.' },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            'Which store to delete from. Required when the name exists in both stores; optional otherwise.',
        },
      },
      required: ['name'],
    },
  },
  memory_link: {
    description:
      "Append a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. Default `type` is `related-to`; passing `supersedes` routes the edge into the source's `supersedes[]` list instead of `relations[]`. Refuses self-edges, missing targets, and duplicate (to, type) edges. Edges are intra-scope: `from` and `to` must live in the same store.",
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source memory name. Edge is appended to this memory.',
        },
        to: {
          type: 'string',
          description: 'Target memory name. Must already exist in the same scope.',
        },
        type: {
          type: 'string',
          enum: [...RELATION_TYPES, 'supersedes'],
          description:
            "Edge type. One of the four `RelationType` values (`related-to`, `builds-on`, `contradicts`, `child-of`) or `supersedes`. Defaults to `related-to`. When `supersedes`, the edge is appended to the source's `supersedes[]` field rather than `relations[]`.",
        },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            'Optional scope of the source memory. Required to disambiguate when the same `from` name exists in both stores; otherwise auto-resolved to whichever store holds `from`.',
        },
      },
      required: ['from', 'to'],
    },
  },
  memory_unlink: {
    description:
      "Remove a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. When `type` is omitted, removes ALL edges from -> to regardless of type. No-op (with note) when the requested edge does not exist.",
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source memory name. Edge is removed from this memory.',
        },
        to: {
          type: 'string',
          description: 'Target memory name.',
        },
        type: {
          type: 'string',
          enum: [...RELATION_TYPES, 'supersedes'],
          description:
            'Optional edge type to remove. When omitted, removes every edge from -> to regardless of type.',
        },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            'Optional scope of the source memory. Required to disambiguate when the same `from` name exists in both stores; otherwise auto-resolved to whichever store holds `from`.',
        },
      },
      required: ['from', 'to'],
    },
  },
};

/**
 * Build the canonical list of tool definitions. Each call returns a fresh
 * array (so callers can mutate or filter without affecting other callers),
 * but the schema fields are shared structurally.
 *
 * @param handlers - Optional handler map. Defaults to the not-implemented
 *   stubs. Sibling issues pass real handlers as they implement them.
 */
export function buildToolDefinitions(
  handlers: ToolHandlerMap = createDefaultHandlers(),
): ToolDefinition[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_SCHEMAS[name].description,
    inputSchema: TOOL_SCHEMAS[name].inputSchema,
    handler: handlers[name],
  }));
}

/**
 * Result shape for {@link listTools}. Mirrors the `tools` field of the
 * MCP SDK's `ListToolsResult` so callers can hand it straight back.
 */
export interface ListToolsResponse {
  readonly tools: Tool[];
}

/**
 * Produce the ListTools response payload. Strips the handler from each
 * definition; the rest of the structure matches the MCP SDK `Tool` type
 * exactly.
 */
export function listTools(
  defs: readonly ToolDefinition[] = buildToolDefinitions(),
): ListToolsResponse {
  const tools: Tool[] = defs.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
  return { tools };
}

/**
 * Error thrown when {@link callTool} is asked to dispatch a name that is
 * not in the registry. Carrying a dedicated class lets callers (and tests)
 * recognise the error category, while the message names the offending tool
 * and references the registered names so users can recover.
 */
export class UnknownToolError extends Error {
  override readonly name = 'UnknownToolError';
  readonly toolName: string;
  readonly knownTools: readonly ToolName[];

  constructor(toolName: string) {
    super(`unknown tool '${toolName}'. Registered tools: ${TOOL_NAMES.join(', ')}.`);
    this.toolName = toolName;
    this.knownTools = TOOL_NAMES;
  }
}

/** Narrow a string to {@link ToolName}. */
function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Dispatch a CallTool request to the appropriate handler.
 *
 * - Throws {@link UnknownToolError} when the name is not registered (covers
 *   both unknown names and the empty string).
 * - Otherwise returns whatever the handler resolves to, or rejects with
 *   whatever the handler throws.
 *
 * This function exists separately from the running server so the dispatch
 * logic can be unit-tested without a transport pair.
 */
export async function callTool(
  request: { name: string; arguments?: ToolArguments },
  handlers: ToolHandlerMap,
): Promise<unknown> {
  if (!isToolName(request.name)) {
    throw new UnknownToolError(request.name);
  }
  const handler = handlers[request.name];
  return handler(request.arguments);
}
