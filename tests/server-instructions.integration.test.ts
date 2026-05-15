/**
 * Integration test for DAR-965 ac-1: a connected MCP client observes the
 * same non-empty `instructions` string across the initialize handshake
 * that `createServer()` passed into the `Server` constructor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SERVER_INSTRUCTIONS, createServer } from '../src/server/server.js';

describe('MCP server instructions (integration)', () => {
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

  it('the client observes the server-provided `instructions` string after initialize, beginning with SERVER_INSTRUCTIONS', () => {
    const observed = client.getInstructions();
    expect(typeof observed).toBe('string');
    expect(observed?.trim().length ?? 0).toBeGreaterThan(0);
    // Per DAR-1013, the assembled `instructions` now contains the
    // SERVER_INSTRUCTIONS prefix followed by a prescriptive when-to-save
    // block. Assert the prefix invariant rather than byte-equality.
    expect(observed?.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
  });
});
