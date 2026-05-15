/**
 * Boot-wiring assertions for the startup version check (DAR-1006).
 *
 * Mirrors the pattern in `server-bin-graph-wiring.test.ts`: the proof
 * that `bootServer` invokes `checkForUpdates` exactly once after
 * `server.connect()` resolves lives at the source-text level here. The
 * end-to-end behavioural proof (bin starts, MCP tools still work even
 * when the version check is offline) is covered by the existing
 * `server-bin-cold-start.integration.test.ts` plus `update-check.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { bootServer } from '../src/bin/boot.js';
import * as updateCheckModule from '../src/server/update-check.js';

const repoRoot = join(__dirname, '..');
const bootSource = readFileSync(join(repoRoot, 'src/bin/boot.ts'), 'utf8');

describe('boot module wires checkForUpdates after server.connect()', () => {
  it('src/bin/boot.ts imports checkForUpdates from ../server/update-check and invokes it', () => {
    expect(bootSource).toMatch(
      /import\s+\{[^}]*checkForUpdates[^}]*\}\s+from\s+['"]\.\.\/server\/update-check/,
    );
    expect(bootSource).toMatch(/checkForUpdates\s*\(/);
  });

  it('invocation of checkForUpdates appears AFTER the server.connect() call in src/bin/boot.ts', () => {
    const connectIdx = bootSource.indexOf('server.connect(');
    const checkIdx = bootSource.indexOf('checkForUpdates(');
    expect(connectIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(connectIdx);
  });

  it('checkForUpdates is NOT awaited (boot remains non-blocking on the version check)', () => {
    const lines = bootSource.split('\n');
    const callLine = lines.find((line) => line.includes('checkForUpdates('));
    expect(callLine).toBeDefined();
    expect(callLine).not.toMatch(/\bawait\s+checkForUpdates\s*\(/);
  });
});

describe('bootServer invokes checkForUpdates exactly once per boot', () => {
  let userTmp: string;
  beforeEach(() => {
    userTmp = mkdtempSync(join(tmpdir(), 'dar1006-boot-'));
  });
  afterEach(() => {
    rmSync(userTmp, { recursive: true, force: true });
  });

  it('bootServer calls checkForUpdates exactly once and does not await it', async () => {
    const spy = vi.spyOn(updateCheckModule, 'checkForUpdates').mockImplementation(async () => {
      // Hang forever -- if bootServer awaited this, boot would never resolve.
      await new Promise<void>(() => {});
    });

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'dar1006-boot-wiring', version: '0.0.0' },
      { capabilities: {} },
    );
    const bootPromise = bootServer({
      env: {},
      cwd: userTmp,
      embedder: {
        modelId: 'stub',
        dim: 4,
        embed: async () => new Float32Array(4),
      },
      transport: serverTransport,
    });
    await client.connect(clientTransport);
    const boot = await bootPromise; // resolves even though checkForUpdates hangs

    expect(spy).toHaveBeenCalledTimes(1);

    await client.close();
    await boot.server.close();
    spy.mockRestore();
  });
});
