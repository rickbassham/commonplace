/**
 * MCP server factory for the commonplace stdio server.
 *
 * Wires the tool registry from {@link ./tools} into a {@link Server} that
 * speaks MCP over a pluggable transport. The bin entry constructs one of
 * these and connects it to a {@link StdioServerTransport}; the integration
 * tests connect it to an {@link InMemoryTransport}.
 *
 * Scope (DAR-909): tool registration, ListTools schema delivery, and
 * CallTool name dispatch via {@link callTool}. No store wiring, no
 * configuration, no signal handling.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  buildToolDefinitions,
  callTool,
  createDefaultHandlers,
  listTools as listToolsResponse,
  type ToolHandlerMap,
} from './tools.js';

/** Server name advertised in the initialize handshake. */
export const SERVER_NAME = 'commonplace';

/**
 * Server version advertised in the initialize handshake. We keep this in
 * sync with the package version manually for now -- there is no need to
 * resolve `package.json` at runtime.
 */
export const SERVER_VERSION = '0.2.1';

export interface CreateServerOptions {
  /**
   * Optional handler map. Defaults to the not-implemented stubs in
   * {@link createDefaultHandlers}. Tests and sibling issues that implement
   * a real handler pass a populated map here.
   */
  handlers?: ToolHandlerMap;
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

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        // Advertise the `tools` capability so clients know to issue
        // ListTools / CallTool requests.
        tools: {},
      },
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
 * map after the post-connect `roots/list` round-trip completes (DAR-924).
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
