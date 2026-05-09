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
 * Options for {@link createDefaultHandlers}.
 */
export interface CreateDefaultHandlersOptions {
  /**
   * MemoryStore instance to wire the DAR-919 CRUD handlers (memory_save,
   * memory_list, memory_delete), the DAR-920 search handler, and the
   * DAR-928 link/unlink handlers against. When omitted, all six tools
   * fall back to the not-implemented stub -- matches the bare scaffold
   * from DAR-909 so callers that construct a server before the store
   * layer is available (e.g. early-boot smoke tests) keep working.
   */
  store?: MemoryStore;
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
 * Default handler map. When a `store` is supplied, all six tools are wired
 * to real handlers (memory_search via DAR-920, CRUD via DAR-919,
 * link/unlink via DAR-928). When `store` is omitted, every tool falls back
 * to the not-implemented stub -- preserving the DAR-909 baseline for
 * callers that haven't wired a store yet (e.g. early-boot smoke tests).
 *
 * The optional `graph` argument exists for explicit ac-5 wiring symmetry;
 * it is owned by the {@link MemoryStore} and not forwarded to the
 * link/unlink handler factories (the store already updates it
 * incrementally on linkEdge/unlinkEdge).
 */
export function createDefaultHandlers(options: CreateDefaultHandlersOptions = {}): ToolHandlerMap {
  const { store } = options;
  // `options.graph` is intentionally unused here -- see CreateDefaultHandlersOptions.
  if (store === undefined) {
    return {
      memory_search: notImplemented,
      memory_save: notImplemented,
      memory_list: notImplemented,
      memory_delete: notImplemented,
      memory_link: notImplemented,
      memory_unlink: notImplemented,
    };
  }
  return {
    memory_search: createMemorySearchHandler({ store }),
    memory_save: createMemorySaveHandler({ store }),
    memory_list: createMemoryListHandler({ store }),
    memory_delete: createMemoryDeleteHandler({ store }),
    memory_link: createMemoryLinkHandler({ store }),
    memory_unlink: createMemoryUnlinkHandler({ store }),
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
      'Semantic search over saved memories. Returns the top-k matches by cosine similarity against the embedding index, with full memory bodies inline so the caller does not need a follow-up read. By default, memories that have been superseded by another entry are excluded from results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return. Defaults to 5.',
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
      },
      required: ['query'],
    },
  },
  memory_save: {
    description:
      'Save a memory as a markdown file with YAML frontmatter and a derived embedding sidecar. Refuses to overwrite an existing entry; the contract is delete + save.',
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
      },
      required: ['name', 'type', 'description', 'body'],
    },
  },
  memory_list: {
    description:
      'List saved memories. Returns frontmatter-only entries (name, type, description) -- no body. By default, memories that have been superseded by another entry are excluded from results.',
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
      },
    },
  },
  memory_delete: {
    description: 'Delete a saved memory by name. Throws when the name is not present.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Memory name (filename stem) to delete.' },
      },
      required: ['name'],
    },
  },
  memory_link: {
    description:
      "Append a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. Default `type` is `related-to`; passing `supersedes` routes the edge into the source's `supersedes[]` list instead of `relations[]`. Refuses self-edges, missing targets, and duplicate (to, type) edges.",
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source memory name. Edge is appended to this memory.',
        },
        to: {
          type: 'string',
          description: 'Target memory name. Must already exist.',
        },
        type: {
          type: 'string',
          enum: [...RELATION_TYPES, 'supersedes'],
          description:
            "Edge type. One of the four `RelationType` values (`related-to`, `builds-on`, `contradicts`, `child-of`) or `supersedes`. Defaults to `related-to`. When `supersedes`, the edge is appended to the source's `supersedes[]` field rather than `relations[]`.",
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
