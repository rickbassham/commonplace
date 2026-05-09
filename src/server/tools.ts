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

/** The exact tool names this server exposes, in registration order. */
export const TOOL_NAMES = ['memory_search', 'memory_save', 'memory_list', 'memory_delete'] as const;

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
 * Default handler map: every tool wired to {@link notImplemented}. Sibling
 * issues replace specific entries in this map (or pass a fully populated
 * map to {@link createServer}) without changing the registration surface.
 */
export function createDefaultHandlers(): ToolHandlerMap {
  return {
    memory_search: notImplemented,
    memory_save: notImplemented,
    memory_list: notImplemented,
    memory_delete: notImplemented,
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
      'Semantic search over saved memories. Returns the top-k matches by cosine similarity against the embedding index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return.',
          minimum: 1,
        },
      },
      required: ['query'],
    },
  },
  memory_save: {
    description:
      'Save a memory as a markdown file with YAML frontmatter and a derived embedding sidecar.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable title for the memory.' },
        body: { type: 'string', description: 'Markdown body content.' },
        tags: {
          type: 'array',
          description: 'Optional list of tags.',
          items: { type: 'string' },
        },
      },
      required: ['title', 'body'],
    },
  },
  memory_list: {
    description: 'List saved memories, optionally filtered by tag.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional tag to filter by.' },
        limit: {
          type: 'integer',
          description: 'Maximum number of memories to return.',
          minimum: 1,
        },
      },
    },
  },
  memory_delete: {
    description: 'Delete a saved memory by id (the markdown filename without extension).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id (filename stem) to delete.' },
      },
      required: ['id'],
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
