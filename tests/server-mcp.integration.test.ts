/**
 * Integration tests: end-to-end MCP server over an in-memory transport
 * pair (in-process handshake, mock-client ListTools/CallTool).
 *
 * These run a real MCP `Server` (the same one the bin entry uses) connected
 * to a real MCP `Client` via `InMemoryTransport.createLinkedPair()`. They
 * exercise the full request/response path: initialize handshake, ListTools
 * over JSON-RPC, and CallTool dispatch through the transport.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server/server.js';

const EXPECTED_NAMES = [
  'memory_search',
  'memory_save',
  'memory_list',
  'memory_delete',
  'memory_link',
  'memory_unlink',
  'memory_graph',
  'memory_path',
] as const;

interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Type guard for the `text`-typed entries inside a CallToolResult's
 * `content` array. The MCP SDK exposes content as a discriminated union;
 * we narrow to the text variant by inspecting `type` and `text` directly,
 * with no `as` casts.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextContent(value: unknown): value is TextContent {
  if (!isRecord(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
}

describe('MCP server integration', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("ac-5: in-process MCP client completes the initialize handshake and reports server capabilities including 'tools'", () => {
    // connect() in beforeEach already performed initialize. If it had
    // failed, this `it` would never run. We confirm the negotiated
    // capabilities expose a `tools` entry.
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.tools).toBeDefined();
  });

  it('ac-6: ListTools over the transport returns the eight expected tool definitions with non-empty descriptions and object inputSchemas', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_NAMES].sort());
    for (const tool of result.tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it("ac-6: CallTool for memory_search through the transport returns an MCP error response whose message is 'not implemented'", async () => {
    // The SDK surfaces tool-handler errors either as a thrown McpError or
    // as a CallToolResult with isError=true. Accept either -- both prove
    // the request reached the dispatcher and the stub handler ran.
    let isErrorResult = false;
    let messages: string[] = [];
    try {
      const result = await client.callTool({ name: 'memory_search', arguments: {} });
      isErrorResult = result.isError === true;
      // Extract any text content for inspection.
      const content = Array.isArray(result.content) ? result.content : [];
      messages = content.filter(isTextContent).map((c) => c.text);
    } catch (err) {
      isErrorResult = true;
      messages = [err instanceof Error ? err.message : String(err)];
    }
    expect(isErrorResult).toBe(true);
    const joined = messages.join(' ');
    expect(joined).toContain('not implemented');
  });

  it('ac-3 (e2e): CallTool with an unknown name yields an error referencing the offending name', async () => {
    let observedMessage = '';
    try {
      const result = await client.callTool({ name: 'memory_bogus', arguments: {} });
      const content = Array.isArray(result.content) ? result.content : [];
      observedMessage = content
        .filter(isTextContent)
        .map((c) => c.text)
        .join(' ');
    } catch (err) {
      observedMessage = err instanceof Error ? err.message : String(err);
    }
    expect(observedMessage).toContain('memory_bogus');
  });
});
