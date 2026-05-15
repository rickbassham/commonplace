/**
 * MCP server factory for the commonplace stdio server.
 *
 * Wires the tool registry from {@link ./tools} into a {@link Server} that
 * speaks MCP over a pluggable transport. The bin entry constructs one of
 * these and connects it to a {@link StdioServerTransport}; the integration
 * tests connect it to an {@link InMemoryTransport}.
 *
 * Scope: tool registration, ListTools schema delivery, and CallTool name
 * dispatch via {@link callTool}. No store wiring, no configuration, no
 * signal handling.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { MemoryStore } from '../store/memory-store.js';
import {
  buildToolDefinitions,
  callTool,
  createDefaultHandlers,
  listTools as listToolsResponse,
  type ToolHandlerMap,
} from './tools.js';
import type { Scope } from './handlers.js';

/** Server name advertised in the initialize handshake. */
export const SERVER_NAME = 'commonplace';

/**
 * Server version advertised in the initialize handshake. Kept in sync
 * with `package.json` `version` by release-please via the trailing
 * `x-release-please-version` annotation comment; the version-sync
 * invariant tests (`tests/version-sync.test.ts`) fail loudly if drift
 * ever sneaks in.
 */
export const SERVER_VERSION = '0.4.0'; // x-release-please-version

/**
 * Server instructions advertised in the initialize handshake. Clients
 * that surface server-provided instructions in their system prompt
 * (notably Claude Code, which renders them under
 * `## MCP Server Instructions`) will see this string and apply the
 * agent-memory framing without any per-project configuration.
 *
 * The wording is deliberately short (well under the ~500-char soft
 * ceiling for system-prompt sections) and leads with the failure mode
 * being prevented so the nudge is actionable.
 *
 * The literal phrase `Prefer these tools over any built-in or
 * harness-provided memory location` is asserted byte-for-byte by
 * `tests/server-instructions.test.ts`; update both in lock-step.
 */
export const SERVER_INSTRUCTIONS =
  'This MCP server is the canonical agent-memory mechanism for this session. ' +
  'Use the `memory_*` tools (`memory_save`, `memory_search`, `memory_list`, ' +
  '`memory_delete`, `memory_link`, `memory_unlink`, `memory_graph`, ' +
  '`memory_path`) to record and recall lessons, feedback, project facts, ' +
  'and reference notes. ' +
  'Prefer these tools over any built-in or harness-provided memory location ' +
  '(for example, default auto-memory files written by the agent harness): ' +
  'this server is where memories should live so they are searchable, ' +
  'scoped, and linkable across sessions.';

export interface CreateServerOptions {
  /**
   * Optional handler map. Defaults to the not-implemented stubs in
   * {@link createDefaultHandlers}. Tests and sibling issues that implement
   * a real handler pass a populated map here.
   */
  handlers?: ToolHandlerMap;
  /**
   * Optional user-scope store. When supplied, every loaded entry with
   * `pinned: true` (and not superseded within the store) is rendered into
   * the MCP `instructions` recall pack at construction time.
   *
   * Must be scanned before being passed -- `createServer()` reads from
   * the in-memory entry list (`store.all()`) and does not trigger a scan.
   */
  userStore?: MemoryStore;
  /**
   * Optional project-scope store. Same contract as {@link userStore};
   * project entries are tagged `[project/<type>]` in the rendered pack.
   * Omitted in user-only mode.
   */
  projectStore?: MemoryStore;
}

/** Heading rendered above the pinned-memories recall pack. */
export const PINNED_HEADING = '## Pinned memories';

/**
 * Render a single pinned-memory entry as one line of the recall pack.
 * Shape: `- [scope/type] name -- description`.
 */
function renderPinnedLine(
  scope: Scope,
  entry: {
    name: string;
    type: string;
    description: string;
  },
): string {
  return `- [${scope}/${entry.type}] ${entry.name} -- ${entry.description}`;
}

/**
 * Build the pinned-memories recall pack appended to {@link SERVER_INSTRUCTIONS}
 * at server-process startup. Returns the empty string when no pinned,
 * non-superseded memories exist across the supplied stores -- callers must
 * concatenate the prefix unconditionally so a zero-pin session sees the
 * static nudge byte-for-byte.
 *
 * Supersede semantics mirror `memory_list` / `memory_search`: a pinned
 * memory whose name appears in another loaded memory's `supersedes[]`
 * within the same store is excluded from the pack.
 */
function buildRecallPack(
  userStore: MemoryStore | undefined,
  projectStore: MemoryStore | undefined,
): string {
  const lines: string[] = [];
  const collect = (store: MemoryStore | undefined, scope: Scope): void => {
    if (store === undefined) return;
    const entries = store.all();
    const superseded = new Set<string>();
    for (const e of entries) {
      for (const target of e.supersedes) {
        superseded.add(target);
      }
    }
    for (const entry of entries) {
      if (entry.pinned !== true) continue;
      if (superseded.has(entry.name)) continue;
      lines.push(renderPinnedLine(scope, entry));
    }
  };
  collect(userStore, 'user');
  collect(projectStore, 'project');
  if (lines.length === 0) return '';
  return `\n\n${PINNED_HEADING}\n${lines.join('\n')}`;
}

/**
 * Construct an MCP `Server` with the four memory tools registered and the
 * ListTools / CallTool request handlers wired to the dispatcher in
 * {@link callTool}.
 *
 * The returned server is not connected to any transport -- callers must
 * `await server.connect(transport)` themselves. This keeps the factory
 * transport-agnostic.
 */
export function createServer(options: CreateServerOptions = {}): Server {
  const handlers = options.handlers ?? createDefaultHandlers();
  const definitions = buildToolDefinitions(handlers);
  const listToolsPayload = listToolsResponse(definitions);

  // Build the dynamic recall pack from any wired stores' pinned memories.
  // When no pins exist (or no stores are wired) the pack is the empty
  // string and the instructions stay byte-equal to the static prefix.
  const recallPack = buildRecallPack(options.userStore, options.projectStore);
  const instructions = SERVER_INSTRUCTIONS + recallPack;

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        // Advertise the `tools` capability so clients know to issue
        // ListTools / CallTool requests.
        tools: {},
      },
      // Clients that surface server-provided instructions in their
      // system prompt see this paragraph and apply the agent-memory
      // framing without any per-project configuration. The static
      // SERVER_INSTRUCTIONS prefix is followed by an optional
      // dynamically-rendered recall pack listing every non-superseded
      // pinned memory across all wired stores.
      instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => {
    // The structural shape of `listToolsPayload.tools` matches the SDK's
    // `Tool` type (see `tests/server-tools.test.ts` -- ToolSchema.parse
    // succeeds on each entry). Returning the cached payload keeps each
    // ListTools response stable.
    return { tools: listToolsPayload.tools };
  });

  installCallToolHandler(server, handlers);

  return server;
}

/**
 * Install (or re-install) the CallTool request handler on a connected
 * server with the given handler map. The MCP SDK's `setRequestHandler`
 * replaces any prior handler for the same method, so this is also the
 * mechanism by which {@link bootServer} swaps in the dual-store handler
 * map after the post-connect `roots/list` round-trip completes.
 *
 * Exposed separately from {@link createServer} so the boot sequence can
 * rebuild the handler map once the project store is known without
 * recreating the server (which would mean re-doing the protocol
 * handshake).
 */
export function installCallToolHandler(server: Server, handlers: ToolHandlerMap): void {
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      const value = await callTool(
        { name: request.params.name, arguments: request.params.arguments },
        handlers,
      );
      // Stub handlers throw; this branch runs once sibling issues wire
      // real handlers that return a value. Keeping it implemented now
      // means the shell does not need to change when handlers land.
      return {
        content: [{ type: 'text', text: stringifyResult(value) }],
      };
    } catch (err) {
      // Surface tool-handler errors as a CallToolResult with isError=true.
      // This is the recommended way to report tool errors to the client per
      // the MCP spec -- a thrown McpError would translate to a JSON-RPC
      // error and bypass the result envelope. Both UnknownToolError (from
      // the dispatcher) and `not implemented` (from stub handlers) flow
      // through here.
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      };
    }
  });
}

/** Stringify a handler return value for the CallToolResult text payload. */
function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
