/**
 * Unit tests for DAR-965 ac-1 and ac-2: `createServer()` constructs the
 * MCP `Server` with a non-empty `instructions` string that explicitly
 * identifies the `memory_*` tools as the canonical agent-memory
 * mechanism and directs agents to prefer them over harness-built-in
 * memory locations.
 */

import { describe, expect, it } from 'vitest';

import { SERVER_INSTRUCTIONS, createServer } from '../src/server/server.js';

interface ServerInternals {
  _instructions?: string;
}

function readInstructions(server: unknown): string | undefined {
  if (typeof server !== 'object' || server === null) return undefined;
  const internals = server as ServerInternals;
  return internals._instructions;
}

describe('ac-1: createServer passes a non-empty `instructions` to the MCP Server constructor', () => {
  it('the constructed Server carries the exported SERVER_INSTRUCTIONS string on its internal `_instructions` field', () => {
    const server = createServer();
    const observed = readInstructions(server);
    expect(typeof observed).toBe('string');
    expect(observed?.trim().length ?? 0).toBeGreaterThan(0);
    // Per DAR-1013, the assembled `instructions` string now contains the
    // SERVER_INSTRUCTIONS prefix followed by a prescriptive when-to-save
    // block (and optionally a pinned-memories recall pack). Assert the
    // prefix invariant rather than byte-equality.
    expect(observed?.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
  });
});

describe('ac-2: `instructions` content invariants', () => {
  it('SERVER_INSTRUCTIONS is non-empty after trim and contains the literal substring `memory_save`', () => {
    expect(SERVER_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
    expect(SERVER_INSTRUCTIONS).toContain('memory_save');
  });

  it('SERVER_INSTRUCTIONS directs agents to prefer these tools over built-in / harness-provided memory locations', () => {
    // Frozen phrase: the implementer chose this stable wording so the
    // test can match it byte-for-byte. If the implementation phrase
    // legitimately changes, update this string in lock-step.
    expect(SERVER_INSTRUCTIONS).toContain(
      'Prefer these tools over any built-in or harness-provided memory location',
    );
  });
});
