/**
 * MCP tool registry for the commonplace server.
 *
 * This module is the single source of truth for the tool names and the
 * handlers wired to them.
 *
 * The registry is exposed as a typed module export so other modules (and
 * tests) can introspect it directly without going through a running server.
 *
 * Scope: tool registration, ListTools schema delivery, and CallTool name
 * dispatch. Argument validation and real handler logic live in the
 * `./handlers.ts` factory functions; this module wires them up.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { MEMORY_TYPES, RELATION_TYPES } from '../store/memory.js';
import type { MemoryGraph } from '../store/graph.js';
import type { MemoryStore } from '../store/memory-store.js';
import {
  EXPAND_MODES,
  EXPAND_TYPES,
  GRAPH_DIRECTIONS,
  GRAPH_EDGE_TYPES,
  SCOPES,
  createMemoryBootstrapHandler,
  createMemoryDeleteHandler,
  createMemoryGraphHandler,
  createMemoryLinkHandler,
  createMemoryListHandler,
  createMemoryPathHandler,
  createMemorySaveHandler,
  createMemorySearchHandler,
  createMemoryUnlinkHandler,
  type BootstrapEnvironment,
} from './handlers.js';

/** The exact tool names this server exposes, in registration order. */
export const TOOL_NAMES = [
  'memory_search',
  'memory_save',
  'memory_list',
  'memory_delete',
  'memory_link',
  'memory_unlink',
  'memory_graph',
  'memory_path',
  'memory_bootstrap_project_store',
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
 * Stub handler used when no store has been wired (e.g. tests that exercise
 * the registry's shape without a backing store).
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
 *   - **Legacy single-store**: `{ store }` -- treated as user-only mode;
 *     `store` becomes the user store and no project store is wired. Saves
 *     with `scope: 'project'` are rejected. Existing tests and callers that
 *     pass this shape continue to work.
 *   - **Dual-store**: `{ userStore, projectStore? }` -- the user store is
 *     required; the project store is omitted in user-only mode.
 *
 * When neither `store` nor `userStore` is supplied, every tool falls back
 * to the not-implemented stub.
 */
export interface CreateDefaultHandlersOptions {
  /**
   * Legacy single-store option. Treated as the user store.
   *
   * @deprecated Prefer `userStore` (and optional `projectStore`).
   */
  store?: MemoryStore;
  /**
   * The user-level memory store. Always loaded.
   */
  userStore?: MemoryStore;
  /**
   * The project-level memory store. Loaded only when a project root is
   * detected; absent in user-only mode.
   */
  projectStore?: MemoryStore;
  /**
   * Optional in-memory graph for the user store. The graph is owned by
   * the {@link MemoryStore} (passed to
   * `new MemoryStore({ dir, embedder, graph })`) which keeps it in sync
   * via scan/save/delete/linkEdge/unlinkEdge.
   *
   * Used in two places at handler-wiring time:
   *
   *   - As an explicit signal that "this server has a graph" (the bin
   *     passes its `userGraph` here so the wiring intent is visible at the
   *     call site).
   *   - As the user-scope graph reference threaded into the
   *     `memory_search` handler for one-hop expansion. The project-scope
   *     graph is supplied separately via {@link projectGraph}.
   *
   * The link/unlink handlers do not need a graph reference -- they
   * dispatch through the store, which owns the single graph instance.
   */
  graph?: MemoryGraph;
  /**
   * Optional in-memory graph for the project store. Threaded into the
   * `memory_search` handler so one-hop expansion can walk the project
   * store's edges. Cross-scope expansion is intentionally not supported: a
   * user-scope direct hit only walks the user graph, and a project-scope
   * direct hit only walks the project graph.
   */
  projectGraph?: MemoryGraph;
  /**
   * Optional default top-k for `memory_search` when the caller omits
   * `limit`. Resolved by the bin from `COMMONPLACE_DEFAULT_LIMIT`; when
   * omitted, the search handler falls back to
   * {@link import('../store/memory-store.js').DEFAULT_SEARCH_LIMIT}
   * (`5`).
   */
  defaultLimit?: number;
  /**
   * Optional one-hop expansion decay for `memory_search`. Resolved by the
   * bin from `COMMONPLACE_EXPANSION_DECAY`; defaults to `0.7` when omitted.
   * Out-of-range values are validated by the env-var resolver
   * (`resolveExpansionDecay`), not here.
   */
  expansionDecay?: number;
  /**
   * Optional alpha coefficient for the connectedness boost. Resolved by
   * the bin from `COMMONPLACE_CONNECTEDNESS_BOOST`; defaults to `0.02`
   * when omitted. Setting to `0` disables the boost (and yields identical
   * results to the unboosted ranking). Negative / non-finite values are
   * rejected by the env-var resolver (`resolveConnectednessBoost`), not
   * here.
   */
  connectednessBoost?: number;
  /**
   * Optional hierarchical parent-decay for `memory_search` (multiplier
   * applied to a `child-of` parent scaffold's score when
   * `expand: 'hierarchical'` surfaces it). Resolved by the bin from
   * `COMMONPLACE_HIERARCHICAL_PARENT_DECAY`; defaults to `0.9` when
   * omitted. Out-of-range values are validated by the env-var resolver
   * (`resolveHierarchicalParentDecay`), not here.
   */
  hierarchicalParentDecay?: number;
  /**
   * Optional minimum number of direct-hit siblings sharing the same
   * `child-of` parent that triggers sibling collapse during
   * `expand: 'hierarchical'`. Resolved by the bin from
   * `COMMONPLACE_SIBLING_COLLAPSE_THRESHOLD`; defaults to `2` when
   * omitted. Out-of-range values are validated by the env-var resolver
   * (`resolveSiblingCollapseThreshold`), not here.
   */
  siblingCollapseThreshold?: number;
  /**
   * Bootstrap-tool environment. When supplied, the
   * `memory_bootstrap_project_store` tool is wired to a real handler that
   * can detect a project root and re-bind the running server's handler map.
   * When omitted, the tool falls back to the not-implemented stub -- useful
   * for unit tests that exercise the registry's shape without a real
   * server or filesystem.
   */
  bootstrapEnv?: BootstrapEnvironment;
}

/**
 * Default handler map. When a user store is supplied (via either the legacy
 * `store` field or the `userStore` field), every tool is wired to a real
 * handler from `./handlers.ts`. When neither is supplied, every tool falls
 * back to the not-implemented stub.
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
      memory_graph: notImplemented,
      memory_path: notImplemented,
      memory_bootstrap_project_store: notImplemented,
    };
  }
  const handlerOpts = { userStore, projectStore };
  // memory_graph and memory_path need per-scope graph references to walk
  // adjacency; the CRUD/link handlers ignore graphs (they dispatch through
  // the store). Threading them through here keeps the wiring single-shot.
  const graphOpts = {
    ...handlerOpts,
    userGraph: options.graph,
    projectGraph: options.projectGraph,
  };
  // The search handler is the only consumer of `defaultLimit`,
  // `userGraph`, `projectGraph`, and `expansionDecay` today; the CRUD/link
  // handlers ignore them (they take their own validated args). Threading
  // the options through here rather than via a separate factory call
  // keeps the wiring single-shot.
  const searchOpts = {
    ...handlerOpts,
    defaultLimit: options.defaultLimit,
    userGraph: options.graph,
    projectGraph: options.projectGraph,
    expansionDecay: options.expansionDecay,
    connectednessBoost: options.connectednessBoost,
    hierarchicalParentDecay: options.hierarchicalParentDecay,
    siblingCollapseThreshold: options.siblingCollapseThreshold,
  };
  // The bootstrap handler is wired only when the caller supplied a
  // `bootstrapEnv` (the bin does this; unit tests that exercise the
  // registry's shape leave it unset and fall through to the
  // not-implemented stub).
  const bootstrap: ToolHandler =
    options.bootstrapEnv === undefined
      ? notImplemented
      : createMemoryBootstrapHandler(options.bootstrapEnv);
  return {
    memory_search: createMemorySearchHandler(searchOpts),
    memory_save: createMemorySaveHandler(handlerOpts),
    memory_list: createMemoryListHandler(handlerOpts),
    memory_delete: createMemoryDeleteHandler(handlerOpts),
    memory_link: createMemoryLinkHandler(handlerOpts),
    memory_unlink: createMemoryUnlinkHandler(handlerOpts),
    memory_graph: createMemoryGraphHandler(graphOpts),
    memory_path: createMemoryPathHandler(graphOpts),
    memory_bootstrap_project_store: bootstrap,
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
      'Agent memory: Semantic search over saved memories across both the user and project stores (when the project store is present). Returns the top-k matches by cosine similarity against the embedding index, merged across stores by descending score; each match carries a `scope` tag identifying which store produced it. By default, memories that have been superseded by another entry are excluded from results.',
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
        expand: {
          type: 'string',
          enum: [...EXPAND_MODES],
          description:
            "Graph expansion mode. 'none' (default) returns only direct cosine hits. 'one-hop' augments the response with outbound graph neighbors of each direct hit, each carrying a `via: { source, edge }` field naming the direct hit that pulled it in; expanded entries are scored at direct_hit_score * decay (default 0.7, configurable via COMMONPLACE_EXPANSION_DECAY) and deduplicated against direct hits. 'hierarchical' additionally walks outbound `child-of` edges one level to surface parent scaffold memories (parent score = max(triggering_child_score) * parentDecay, default 0.9 via COMMONPLACE_HIERARCHICAL_PARENT_DECAY) and re-ranks a parent above its triggering children when at least COMMONPLACE_SIBLING_COLLAPSE_THRESHOLD (default 2) direct hits share that parent; the children remain in the response at their original cosine scores.",
        },
        expandTypes: {
          type: 'array',
          items: { type: 'string', enum: [...EXPAND_TYPES] },
          description:
            "Edge types to follow during one-hop expansion. Defaults to ['builds-on', 'related-to']. Pass an explicit list to opt into other types ('mentions', 'supersedes', 'contradicts', 'child-of'). Ignored when `expand` is omitted or 'none'.",
        },
        expandLimit: {
          type: 'integer',
          minimum: 0,
          description:
            'Maximum number of neighbors to add per direct hit during one-hop expansion. Defaults to 2. Set to 0 to opt out of neighbor inclusion without disabling expansion validation (useful for callers that want to verify their schema usage without changing the response). Ignored when `expand` is omitted or `none`.',
        },
      },
      required: ['query'],
    },
  },
  memory_save: {
    description:
      'Agent memory: Save a memory as a markdown file with YAML frontmatter and a derived embedding sidecar. Refuses to overwrite an existing entry; the contract is delete + save. The required `scope` argument selects which store to write to; saving to `project` requires that a project store was detected at boot.',
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
            "Which store to write to. 'user' saves under COMMONPLACE_USER_DIR. 'project' saves under the detected project store; rejects with a clear error if no project store is wired.",
        },
        pinned: {
          type: 'boolean',
          description:
            "When true, this memory's name + description are surfaced in the MCP server's startup `instructions` recall pack. Defaults to false on a new memory; on an update with `pinned` omitted, the prior on-disk value is preserved.",
        },
      },
      required: ['name', 'type', 'description', 'body', 'scope'],
    },
  },
  memory_list: {
    description:
      'Agent memory: List saved memories from both stores. Returns frontmatter-only entries (name, type, description, scope) -- no body. Each entry carries a `scope` tag (`user` | `project`) identifying which store it came from. By default, memories that have been superseded by another entry within their own store are excluded from results.',
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
      'Agent memory: Delete a saved memory by name. The `scope` argument is required to disambiguate when the same name exists in both stores; otherwise the lookup automatically resolves to whichever store contains the name. Throws when the name is not present in the targeted scope.',
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
      "Agent memory: Append a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. Default `type` is `related-to`; passing `supersedes` routes the edge into the source's `supersedes[]` list instead of `relations[]`. Refuses self-edges, missing targets, and duplicate (to, type) edges. Edges are intra-scope: `from` and `to` must live in the same store.",
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
      "Agent memory: Remove a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. When `type` is omitted, removes ALL edges from -> to regardless of type. No-op (with note) when the requested edge does not exist.",
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
  memory_graph: {
    description:
      'Agent memory: Return the local graph neighborhood of a saved memory. Walks the in-memory graph BFS-style from `name` to `depth` hops, gated by `direction` (outbound / inbound / both) and `types` (which edge labels to follow). Cycles are visited-set safe -- each reachable memory appears once in `nodes`. Default `types` covers the four authored relation types plus `supersedes` (omits body `mentions` edges unless requested explicitly). Default `depth` is 1 and default `direction` is `both`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name to use as the root of the neighborhood walk.',
        },
        depth: {
          type: 'integer',
          minimum: 0,
          description:
            'Maximum number of edges to walk from the root. Defaults to 1. `0` returns just the root with no edges.',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: [...GRAPH_EDGE_TYPES] },
          description:
            "Edge types to follow during traversal. Defaults to the four authored relation types plus 'supersedes' (omits 'mentions' unless requested). Pass an explicit list to opt into 'mentions' or to narrow the walk to a single edge type.",
        },
        direction: {
          type: 'string',
          enum: [...GRAPH_DIRECTIONS],
          description:
            "Which side of the adjacency to walk. 'out' follows only outbound edges from the root; 'in' follows only inbound edges to the root; 'both' (default) follows both directions.",
        },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            'Optional scope of the root memory. Required to disambiguate when the same name exists in both stores; otherwise auto-resolved to whichever store holds the name. Traversal is intra-scope -- edges are not walked across stores.',
        },
      },
      required: ['name'],
    },
  },
  memory_bootstrap_project_store: {
    description:
      "Agent memory: Bootstrap a project-scope memory store on the running MCP connection. Use this after `memory_save` with `scope: 'project'` returns a `NO_PROJECT_STORE` error: confirm with the user that they want a project store created, then call this tool with `{ userConfirmed: true }`. The tool re-runs project-root detection (upward walk for `.git/` or `.commonplace/`, stopping at `$HOME` exclusive), creates `<root>/.commonplace/memory` if missing, and re-binds the server's handler map so subsequent project-scope saves succeed on the same connection. Pass an explicit `path` to override detection for a markerless directory; the path must not be `$HOME` or an ancestor of it. The handler rejects calls where `userConfirmed` is not strictly `true` (no truthy coercion).",
    inputSchema: {
      type: 'object',
      properties: {
        userConfirmed: {
          type: 'boolean',
          description:
            'Must be exactly `true`. The handler rejects truthy-but-not-strict values (no coercion of `1`, `"true"`, etc.) so an agent cannot bootstrap a project store without surfacing the request to the user. The agent SHOULD only set this after explicit user confirmation.',
        },
        path: {
          type: 'string',
          description:
            'Optional explicit project root directory. When set, detection is skipped and `<path>/.commonplace/memory` is used as the project store directory. The path must still pass the $HOME-exclusive safety check (it must not equal $HOME or any ancestor of $HOME).',
        },
      },
      required: ['userConfirmed'],
    },
  },
  memory_path: {
    description:
      "Agent memory: Return the shortest directed path between two saved memories using BFS over the in-memory graph. Follows outbound edges from each node. Returns `{ path: [] }` when `from === to` (the empty-edge self-path); `{ path: null, reason: 'unreachable' }` when no path exists; or `{ path: null, reason: 'depth-exceeded' }` when a path exists but its shortest length is greater than `maxDepth`. Default `maxDepth` is 5. Pass `types` to restrict which edge labels the search may traverse (default: all edge types).",
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Starting memory name.',
        },
        to: {
          type: 'string',
          description: 'Destination memory name.',
        },
        maxDepth: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum number of edges the BFS will walk before giving up with `reason: depth-exceeded`. Defaults to 5.',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: [...GRAPH_EDGE_TYPES] },
          description:
            'Edge types the BFS is allowed to traverse. When omitted, every edge type (including `mentions`) is eligible.',
        },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description:
            'Optional scope of the `from` memory. Required to disambiguate when the same name exists in both stores; otherwise auto-resolved to whichever store holds `from`. Path search is intra-scope -- `to` must live in the same store as `from`.',
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
