/**
 * DAR-909 unit tests: tool registry + handler stubs (ac-1, ac-2, ac-3).
 *
 * These cover the in-process surface only -- registration, ListTools schema
 * shape, CallTool name dispatch, and the unknown-name error. The end-to-end
 * client/server tests over an in-memory transport live in
 * `server-mcp.integration.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_NAMES,
  buildToolDefinitions,
  callTool,
  listTools,
  type ToolDefinition,
  type ToolHandlerMap,
} from '../src/server/tools.js';

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

describe('ac-1: tool registration', () => {
  it('registers exactly eight tools whose names are memory_search, memory_save, memory_list, memory_delete, memory_link, memory_unlink, memory_graph, memory_path (set equality, no extras, no duplicates)', () => {
    const defs = buildToolDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8); // no duplicates
    expect(new Set(names)).toEqual(new Set(EXPECTED_NAMES));
  });

  it('exposes the tool registry via a typed module export so sibling issues can import it without going through the running server', () => {
    // Both the constant and the builder must be importable and typed.
    expect(TOOL_NAMES).toEqual(EXPECTED_NAMES);
    const defs: readonly ToolDefinition[] = buildToolDefinitions();
    expect(defs).toHaveLength(8);
    // Each entry has the structural fields sibling issues will rely on.
    for (const def of defs) {
      expect(typeof def.name).toBe('string');
      expect(typeof def.description).toBe('string');
      expect(def.inputSchema.type).toBe('object');
      expect(typeof def.handler).toBe('function');
    }
  });
});

describe('ac-2: ListTools schema shape and stub rejection', () => {
  it('ListTools response contains eight entries; each entry has a non-empty name, description, and inputSchema with type === "object"', () => {
    const result = listTools();
    expect(result.tools).toHaveLength(8);
    for (const tool of result.tools) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('each tool inputSchema is a JSON Schema object with a properties map (may be empty) and validates against the MCP SDK Tool type without type assertions', () => {
    const result = listTools();
    for (const tool of result.tools) {
      // ToolSchema is the MCP SDK's authoritative shape. parse() returns a
      // value that matches the Tool type. No `as` needed -- if the
      // structure is wrong, parse() throws.
      const parsed = ToolSchema.parse(tool);
      expect(parsed.name).toBe(tool.name);
      expect(parsed.inputSchema.type).toBe('object');
      // properties map may be empty but must exist as an object.
      expect(typeof parsed.inputSchema.properties).toBe('object');
      expect(parsed.inputSchema.properties).not.toBeNull();
    }
  });

  for (const name of EXPECTED_NAMES) {
    it(`invoking the stub handler for ${name} rejects with an Error whose message is exactly 'not implemented'`, async () => {
      const def = buildToolDefinitions().find((d) => d.name === name);
      if (!def) throw new Error(`expected tool ${name} to be registered`);
      await expect(def.handler({})).rejects.toThrow(
        expect.objectContaining({ message: 'not implemented' }),
      );
    });
  }
});

describe('ac-3: CallTool dispatch by name', () => {
  it("CallTool with name 'memory_search' invokes the memory_search handler and not any other handler (verified via spy)", async () => {
    const spies = makeSpiedHandlers();
    await callTool({ name: 'memory_search', arguments: {} }, spies.handlers).catch(() => {
      /* stubs throw -- we only care which one ran */
    });
    expect(spies.spies.memory_search).toHaveBeenCalledTimes(1);
    expect(spies.spies.memory_save).not.toHaveBeenCalled();
    expect(spies.spies.memory_list).not.toHaveBeenCalled();
    expect(spies.spies.memory_delete).not.toHaveBeenCalled();
  });

  it("CallTool with name 'memory_save' invokes the memory_save handler and not any other handler (verified via spy)", async () => {
    const spies = makeSpiedHandlers();
    await callTool({ name: 'memory_save', arguments: {} }, spies.handlers).catch(() => {
      /* stubs throw */
    });
    expect(spies.spies.memory_save).toHaveBeenCalledTimes(1);
    expect(spies.spies.memory_search).not.toHaveBeenCalled();
    expect(spies.spies.memory_list).not.toHaveBeenCalled();
    expect(spies.spies.memory_delete).not.toHaveBeenCalled();
  });

  it("CallTool with an unknown name (e.g. 'memory_bogus') rejects with an error whose message names the offending tool and lists or refers to the registered tool names", async () => {
    const spies = makeSpiedHandlers();
    await expect(callTool({ name: 'memory_bogus', arguments: {} }, spies.handlers)).rejects.toThrow(
      /memory_bogus/,
    );
    // Error message must reference the known tool names so callers can
    // recover. We check at least one registered name appears.
    try {
      await callTool({ name: 'memory_bogus', arguments: {} }, spies.handlers);
      throw new Error('expected callTool to reject');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('memory_bogus');
      // At least one of the registered names should be referenced.
      const referencesKnown = EXPECTED_NAMES.some((n) => msg.includes(n));
      expect(referencesKnown, `error message should reference known tool names: ${msg}`).toBe(true);
    }
  });

  it('CallTool with an empty-string name rejects with the same unknown-tool error class as the unknown-name case', async () => {
    const spies = makeSpiedHandlers();
    let unknownErr: unknown;
    try {
      await callTool({ name: 'memory_bogus', arguments: {} }, spies.handlers);
    } catch (err) {
      unknownErr = err;
    }
    let emptyErr: unknown;
    try {
      await callTool({ name: '', arguments: {} }, spies.handlers);
    } catch (err) {
      emptyErr = err;
    }
    if (!(unknownErr instanceof Error))
      throw new Error('expected unknown-name call to reject with Error');
    if (!(emptyErr instanceof Error))
      throw new Error('expected empty-name call to reject with Error');
    // Same constructor -- both rejections must be UnknownToolError.
    expect(emptyErr.constructor).toBe(unknownErr.constructor);
  });
});

function makeSpiedHandlers(): {
  handlers: ToolHandlerMap;
  spies: Record<(typeof EXPECTED_NAMES)[number], ReturnType<typeof vi.fn>>;
} {
  const make = () =>
    vi.fn(async () => {
      throw new Error('not implemented');
    });
  const spies = {
    memory_search: make(),
    memory_save: make(),
    memory_list: make(),
    memory_delete: make(),
    memory_link: make(),
    memory_unlink: make(),
    memory_graph: make(),
    memory_path: make(),
  };
  const handlers: ToolHandlerMap = { ...spies };
  return { handlers, spies };
}
