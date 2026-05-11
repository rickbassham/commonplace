/**
 * Boot sequence for the commonplace MCP server (DAR-924).
 *
 * Extracted into a module so the spawned-bin's wiring is unit-testable
 * without paying the bin's stdio + transformers.js cold-start cost. The
 * actual `commonplace-mcp` bin reduces to "construct an embedder, build a
 * StdioServerTransport, hand both to bootServer()" -- everything else
 * (scope detection, store construction, roots/list, handler wiring) lives
 * here.
 *
 * The boot sequence:
 *
 *   1. Resolve the user dir from env (`COMMONPLACE_USER_DIR`, with
 *      `COMMONPLACE_MEMORY_DIR` honoured as a deprecated alias).
 *   2. mkdir -p the user dir so first-run users don't get ENOENT on save.
 *      The project dir is auto-created lazily on first project save
 *      (DAR-924 ac-3) -- we don't pre-create it here so user-only mode
 *      doesn't litter the filesystem.
 *   3. Construct the user `MemoryStore` and run `scan()` to load it.
 *   4. Build a deferred handler map (the project store is unknown until
 *      after `roots/list` returns).
 *   5. Connect the server to the supplied transport.
 *   6. Issue an MCP `roots/list` request to the connected client. Tolerate
 *      every failure mode: client doesn't advertise the capability, the
 *      request rejects, the response is empty -- each falls through to the
 *      next detection step.
 *   7. Run `detectScope` with the env / roots / cwd inputs.
 *   8. If a project root was detected, construct a second `MemoryStore`
 *      sharing the same `Embedder` and load it. Re-bind the server's
 *      handler map so subsequent CallTool requests see the project store.
 */

import { mkdir } from 'node:fs/promises';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { Embedder } from '../embedder/index.js';
import { createServer, installCallToolHandler } from '../server/server.js';
import { createDefaultHandlers } from '../server/tools.js';
import { MemoryGraph } from '../store/graph.js';
import { MemoryStore, type Embedder as EmbedderShape } from '../store/memory-store.js';
import { resolveDefaultLimit, resolveExpansionDecay, resolveModelId } from './env.js';
import { detectScope, type RootEntry, type ScopeDetectionResult } from './scope.js';

/** Inputs to {@link bootServer}. */
export interface BootOptions {
  /**
   * Environment-variable snapshot. Pass `process.env` from the bin; tests
   * pass a hand-built object so they don't have to mutate the real env.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Working directory used for the cwd-marker fallback. Pass
   * `process.cwd()` from the bin; tests pass a tmp dir.
   */
  cwd: string;
  /**
   * Embedder instance shared by both stores. Defaults to a fresh
   * {@link Embedder} when omitted -- the bin uses the default;
   * integration tests pass a stub so they don't load model weights.
   */
  embedder?: EmbedderShape;
  /**
   * Transport to connect the server to. Pass a {@link
   * StdioServerTransport} from the bin; tests pass an in-memory transport
   * pair so they can simulate `roots/list` responses.
   */
  transport: Transport;
}

/** Result of {@link bootServer}. */
export interface BootResult {
  /** The connected MCP server instance. */
  server: Server;
  /** The user store (always present). */
  userStore: MemoryStore;
  /** The project store, when one was detected; `null` in user-only mode. */
  projectStore: MemoryStore | null;
  /** The scope-detection result, useful for logging and tests. */
  scope: ScopeDetectionResult;
}

// `DEFAULT_MODEL_ID` lives in `./env.ts` post-DAR-913 (alongside the
// `COMMONPLACE_MODEL` env var that may override it). The bin still resolves
// the model id via `resolveModelId()` below so test harnesses passing a
// stub embedder bypass the resolver entirely.

/**
 * Issue a `roots/list` request to the connected client and translate the
 * response into either a (possibly empty) array of root entries or `null`.
 *
 * Returns `null` for "we got nothing usable" cases:
 *
 *   - the client did not advertise the roots capability (the SDK throws
 *     synchronously when the server requests a capability the client
 *     doesn't support)
 *   - the request rejected (e.g. client returned an error response)
 *   - the response did not have a `roots` array (defensive -- the SDK
 *     should validate this, but cheap to guard)
 *
 * Returns `[]` (distinct from `null`) when the client supports roots but
 * has none -- callers fall through to the cwd-marker step in either case.
 */
const requestRoots = async (server: Server): Promise<RootEntry[] | null> => {
  // Capability check: the SDK throws if we call listRoots when the client
  // didn't advertise `roots`. Probing the capability is the documented way
  // to avoid that throw.
  const caps = server.getClientCapabilities();
  if (caps?.roots === undefined) {
    return null;
  }
  try {
    const result = await server.listRoots();
    if (!Array.isArray(result.roots)) return null;
    return result.roots.map((r) => {
      const out: RootEntry = { uri: r.uri };
      if (r.name !== undefined) out.name = r.name;
      return out;
    });
  } catch {
    // The client supports roots but the request failed (network, error
    // response, malformed reply). Fall through to the next detection step.
    return null;
  }
};

/**
 * Boot the commonplace MCP server end-to-end. See module-level docs for
 * the step-by-step contract.
 */
export async function bootServer(options: BootOptions): Promise<BootResult> {
  // Step 0: resolve the env-driven knobs (DAR-913). `resolveDefaultLimit`
  // throws on invalid `COMMONPLACE_DEFAULT_LIMIT` values; we do this BEFORE
  // mkdir-ing the user dir so a misconfigured operator gets a clear stderr
  // message without the bin first creating directories on disk.
  const defaultLimit = resolveDefaultLimit(options.env);
  const expansionDecay = resolveExpansionDecay(options.env);
  const embedder = options.embedder ?? new Embedder(resolveModelId(options.env));

  // Step 1+2: resolve user dir, mkdir -p so first-run users get a clean
  // start. The deprecation warning is issued post-detection (we already
  // have the flag from the scope module).
  const initialScope = detectScope({
    env: options.env,
    roots: null,
    cwd: options.cwd,
  });

  if (initialScope.usedDeprecatedMemoryDir) {
    process.stderr.write(
      'commonplace-mcp: COMMONPLACE_MEMORY_DIR is deprecated; use COMMONPLACE_USER_DIR instead. The current value is being honoured as the user store directory.\n',
    );
  }

  await mkdir(initialScope.userDir, { recursive: true });

  // Shared graph (DAR-928). The user store owns its own graph; the project
  // store gets its own graph instance because the graph is per-store
  // (scoping is preserved at the store boundary -- a user memory cannot
  // link to a project memory and vice versa, see handlers.ts).
  const userGraph = new MemoryGraph();
  const userStore = new MemoryStore({
    dir: initialScope.userDir,
    embedder,
    graph: userGraph,
  });
  await userStore.scan();

  // Step 3+4: wire handlers WITHOUT a project store yet. roots/list
  // happens after server.connect, so the project store -- if any -- is
  // only known after the round-trip completes. `defaultLimit` is the
  // resolved `COMMONPLACE_DEFAULT_LIMIT` value (DAR-913); the search
  // handler uses it when the caller omits `limit`.
  const handlers = createDefaultHandlers({
    userStore,
    graph: userGraph,
    defaultLimit,
    expansionDecay,
  });
  const server = createServer({ handlers });

  // Step 5: connect first so the transport is ready to issue requests.
  await server.connect(options.transport);

  // Step 6+7: ask the client for its roots, then re-detect scope using the
  // response. The env-only initial detection above is fine for the user
  // dir (env > roots/list/cwd are all project-only signals), but the
  // project-dir branch wants the roots/list result.
  const roots = await requestRoots(server);
  const finalScope = detectScope({
    env: options.env,
    roots,
    cwd: options.cwd,
  });

  // Step 8: if a project root was detected, construct the project store
  // and re-bind the server's handler map so subsequent CallTool requests
  // see both stores. The project store is NOT mkdir'd up front -- DAR-924
  // ac-3 specifies auto-create on first save, so user-only sessions that
  // happen to share a cwd with a marker dir don't side-effect.
  let projectStore: MemoryStore | null = null;
  if (finalScope.projectDir !== null) {
    const projectGraph = new MemoryGraph();
    projectStore = new MemoryStore({
      dir: finalScope.projectDir,
      embedder,
      graph: projectGraph,
    });
    // scan() handles the missing-dir case gracefully (returns an empty
    // entry array) so we don't need to pre-mkdir.
    await projectStore.scan();

    const handlersWithProject = createDefaultHandlers({
      userStore,
      projectStore,
      graph: userGraph,
      defaultLimit,
      expansionDecay,
    });
    installCallToolHandler(server, handlersWithProject);
  }

  return {
    server,
    userStore,
    projectStore,
    scope: finalScope,
  };
}
