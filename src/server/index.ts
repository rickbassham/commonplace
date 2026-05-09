/**
 * Public exports for the commonplace MCP server module. Sibling issues
 * import the registry helpers from `./tools.js` and the server factory
 * from `./server.js`; this barrel exists so consumers (and the bin entry)
 * can import everything from `commonplace/server` without reaching into
 * sub-paths.
 */

export {
  TOOL_NAMES,
  buildToolDefinitions,
  callTool,
  createDefaultHandlers,
  listTools,
  UnknownToolError,
  type ToolArguments,
  type ToolDefinition,
  type ToolHandler,
  type ToolHandlerMap,
  type ToolName,
  type ListToolsResponse,
} from './tools.js';

export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from './server.js';
