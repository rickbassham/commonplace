/**
 * Shared test harness for `bootServer` callers.
 *
 * DAR-1035 background: an earlier `bootHarness` implementation in
 * `tests/server-bin.test.ts` passed `env: {}` straight through to
 * `bootServer`. With no `COMMONPLACE_USER_DIR` (and no
 * `COMMONPLACE_MEMORY_DIR` back-compat alias), scope resolution fell
 * through to `defaultUserDir()` = `join(homedir(), '.commonplace',
 * 'memory')` -- the developer's real corpus. The store then re-embedded
 * every sidecar with whatever stub embedder the test supplied, silently
 * zeroing every vector.
 *
 * This helper closes the leak by default: callers get a tmp `userDir`
 * under their per-test `cwd` unless they opt out. The two opt-outs are:
 *
 *   - pass `env.COMMONPLACE_USER_DIR` (or the deprecated alias) yourself
 *     -- the helper does not override an explicit value.
 *   - pass `userDir: null` to deliberately refuse to inject a default --
 *     the helper then throws if neither env var is set.
 *
 * Production `bootServer` defaulting to `~/.commonplace/memory` is the
 * correct behavior for the actual bin; this helper exists only to keep
 * test runs from reaching that default.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema, type Root } from '@modelcontextprotocol/sdk/types.js';

import { bootServer, type BootResult } from '../../src/bin/boot.js';

/** Env-var names duplicated here so tests can import them from one place. */
export const ENV_USER_DIR = 'COMMONPLACE_USER_DIR';
export const ENV_DEPRECATED_MEMORY_DIR = 'COMMONPLACE_MEMORY_DIR';

/** Subdirectory under `cwd` where the auto-injected user dir lives. */
const DEFAULT_USER_DIRNAME = '.commonplace/memory-bootHarness';

export interface BootHarnessOptions {
  /**
   * Environment-variable snapshot handed to `bootServer`. Tests pass a
   * hand-built object so they don't have to mutate the real env. If this
   * object does NOT set `COMMONPLACE_USER_DIR` or `COMMONPLACE_MEMORY_DIR`,
   * the harness injects a tmp `COMMONPLACE_USER_DIR` (see `userDir` below).
   */
  env: NodeJS.ProcessEnv;
  /**
   * Working directory used both as `bootServer`'s `cwd` and as the parent
   * of the auto-injected user dir. Tests should pass a per-test tmp dir
   * (typically the result of `mkdtempSync`).
   */
  cwd: string;
  /**
   * Embedder shape passed straight through to `bootServer`. Tests typically
   * pass a tiny stub so they don't load model weights; the bin uses a real
   * `Embedder` by default.
   */
  embedder?: {
    modelId: string;
    dim: number;
    embed: (text: string) => Promise<Float32Array>;
  };
  /**
   * Explicit override for the auto-injected user dir.
   *
   *   - undefined (default): the harness uses
   *     `join(cwd, '.commonplace/memory-bootHarness')`.
   *   - a string: the harness uses this path verbatim.
   *   - `null`: the harness refuses to inject anything. If `env` also
   *     omits both env vars, the harness throws BEFORE calling
   *     `bootServer` so the leak path is blocked at the source.
   *
   * An explicit `env.COMMONPLACE_USER_DIR` (or the deprecated alias)
   * always wins regardless of this flag -- the harness never overrides
   * an env value the caller deliberately set.
   */
  userDir?: string | null;
  /**
   * Optional roots/list handler installed on the client side. Useful for
   * tests that want to assert post-roots-detection behaviour.
   */
  rootsHandler?: () => Promise<{ roots: Root[] }>;
  /**
   * Client capabilities advertised on the linked-pair handshake. Defaults
   * to advertising `{ roots: {} }` when `rootsHandler` is supplied, else
   * `{}`.
   */
  clientCapabilities?: Record<string, unknown>;
}

export interface BootHarnessResult {
  boot: BootResult;
  client: Client;
  close: () => Promise<void>;
}

/**
 * Boot `bootServer` against an in-memory transport pair with the user dir
 * pinned to a per-test tmp path by default. See `BootHarnessOptions` for
 * the override semantics.
 */
export async function bootHarness(options: BootHarnessOptions): Promise<BootHarnessResult> {
  const env: NodeJS.ProcessEnv = { ...options.env };

  const hasUserDirEnv = typeof env[ENV_USER_DIR] === 'string' && env[ENV_USER_DIR]!.length > 0;
  const hasDeprecatedEnv =
    typeof env[ENV_DEPRECATED_MEMORY_DIR] === 'string' &&
    env[ENV_DEPRECATED_MEMORY_DIR]!.length > 0;

  if (!hasUserDirEnv && !hasDeprecatedEnv) {
    if (options.userDir === null) {
      // Explicit opt-out AND env empty -- refuse to boot. This is the
      // DAR-1035 guardrail: without it, bootServer would fall through to
      // `~/.commonplace/memory` and corrupt the developer's real corpus.
      throw new Error(
        'bootHarness: refusing to boot because env omits both COMMONPLACE_USER_DIR and COMMONPLACE_MEMORY_DIR, and userDir was explicitly opted out. Pass `userDir: "<tmp path>"` or set env.COMMONPLACE_USER_DIR.',
      );
    }
    const injected =
      typeof options.userDir === 'string'
        ? options.userDir
        : join(options.cwd, DEFAULT_USER_DIRNAME);
    // `bootServer` mkdir-p's the user dir itself, but it does NOT mkdir-p
    // the parent of an arbitrary path. The default path nests one level
    // under cwd so `mkdir -p` inside bootServer is enough; we still
    // pre-create the parent here for the explicit `userDir` case to make
    // the contract obvious.
    mkdirSync(injected, { recursive: true });
    env[ENV_USER_DIR] = injected;
  }

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'dar1035-bootharness', version: '0.0.0' },
    {
      capabilities:
        options.clientCapabilities ?? (options.rootsHandler !== undefined ? { roots: {} } : {}),
    },
  );

  if (options.rootsHandler !== undefined) {
    client.setRequestHandler(ListRootsRequestSchema, options.rootsHandler);
  }

  const bootOptions: Parameters<typeof bootServer>[0] = {
    env,
    cwd: options.cwd,
    transport: serverTransport,
  };
  if (options.embedder !== undefined) {
    bootOptions.embedder = options.embedder;
  }
  const bootPromise = bootServer(bootOptions);
  await client.connect(clientTransport);
  const boot = await bootPromise;

  return {
    boot,
    client,
    close: async () => {
      await client.close();
      await boot.server.close();
    },
  };
}
