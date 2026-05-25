/**
 * Boot sequence for the commonplace MCP server.
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
 *      The project dir is auto-created lazily on first project save -- we
 *      don't pre-create it here so user-only mode doesn't litter the
 *      filesystem.
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
import { homedir as osHomedir } from 'node:os';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { Embedder } from '../embedder/index.js';
import { createServer, installCallToolHandler, SERVER_VERSION } from '../server/server.js';
import { createDefaultHandlers } from '../server/tools.js';
import type { BootstrapEnvironment } from '../server/handlers.js';
import { checkForUpdates } from '../server/update-check.js';
import { MemoryGraph } from '../store/graph.js';
import { MemoryStore, type Embedder as EmbedderShape } from '../store/memory-store.js';
import {
  resolveConnectednessBoost,
  resolveDefaultLimit,
  resolveExpansionDecay,
  resolveHierarchicalParentDecay,
  resolveModelId,
  resolveSiblingCollapseThreshold,
} from './env.js';
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

// `DEFAULT_MODEL_ID` lives in `./env.ts` alongside the `COMMONPLACE_MODEL`
// env var that may override it. The bin still resolves the model id via
// `resolveModelId()` below so test harnesses passing a stub embedder bypass
// the resolver entirely.

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
  // Step 0: resolve the env-driven knobs. `resolveDefaultLimit` throws on
  // invalid `COMMONPLACE_DEFAULT_LIMIT` values; we do this BEFORE
  // mkdir-ing the user dir so a misconfigured operator gets a clear stderr
  // message without the bin first creating directories on disk.
  const defaultLimit = resolveDefaultLimit(options.env);
  const expansionDecay = resolveExpansionDecay(options.env);
  const connectednessBoost = resolveConnectednessBoost(options.env);
  const hierarchicalParentDecay = resolveHierarchicalParentDecay(options.env);
  const siblingCollapseThreshold = resolveSiblingCollapseThreshold(options.env);
  const embedder = options.embedder ?? new Embedder(resolveModelId(options.env));

  // Step 1+2: resolve user dir, mkdir -p so first-run users get a clean
  // start. The deprecation warning is issued post-detection (we already
  // have the flag from the scope module).
  const home = osHomedir();
  const initialScope = detectScope({
    env: options.env,
    roots: null,
    cwd: options.cwd,
    homedir: home,
  });

  if (initialScope.usedDeprecatedMemoryDir) {
    process.stderr.write(
      'commonplace-mcp: COMMONPLACE_MEMORY_DIR is deprecated; use COMMONPLACE_USER_DIR instead. The current value is being honoured as the user store directory.\n',
    );
  }

  await mkdir(initialScope.userDir, { recursive: true });

  // The user store owns its own graph; the project store gets its own
  // graph instance because the graph is per-store
  // (scoping is preserved at the store boundary -- a user memory cannot
  // link to a project memory and vice versa, see handlers.ts).
  const userGraph = new MemoryGraph();
  const userStore = new MemoryStore({
    dir: initialScope.userDir,
    embedder,
    graph: userGraph,
  });
  await userStore.scan();

  // If the initial scope (env / cwd, pre-roots/list) already names a
  // project dir, scan it now so the pinned-memories recall pack can
  // surface project-scope pins in the MCP `instructions` string at
  // connect time. Roots-only project stores are still wired later
  // (post-connect), but their pins surface only on the next session.
  let initialProjectStore: MemoryStore | null = null;
  let initialProjectGraph: MemoryGraph | null = null;
  if (initialScope.projectDir !== null) {
    initialProjectGraph = new MemoryGraph();
    initialProjectStore = new MemoryStore({
      dir: initialScope.projectDir,
      embedder,
      graph: initialProjectGraph,
    });
    await initialProjectStore.scan();
  }

  // The bootstrap-tool environment closes over a deferred server holder so
  // its `rebindHandlers` callback can call `installCallToolHandler` on the
  // server once it exists. The handler is only ever invoked at MCP
  // request-time (well after `serverHolder.server` is set), so the late
  // binding is safe. The callback also rebuilds the bootstrap env on each
  // rebind so a future bootstrap call (rare but possible) still reaches
  // the same wiring.
  const serverHolder: { server: Server | null } = { server: null };
  const buildBootstrapEnv = (): BootstrapEnvironment => ({
    env: options.env,
    cwd: options.cwd,
    homedir: home,
    createProjectStore: async (dir: string) => {
      const graph = new MemoryGraph();
      const store = new MemoryStore({ dir, embedder, graph });
      return { store, graph };
    },
    rebindHandlers: (projectStore, projectGraph) => {
      if (serverHolder.server === null) {
        // Defensive: bootstrap handler is invoked only at MCP request-time,
        // by which point the server is connected. This branch fires only
        // if the wiring order ever changes; surface a clear error so the
        // failure mode is debuggable.
        throw new Error(
          'memory_bootstrap_project_store: rebindHandlers invoked before server was created',
        );
      }
      const rebuilt = createDefaultHandlers({
        userStore,
        projectStore,
        graph: userGraph,
        projectGraph,
        defaultLimit,
        expansionDecay,
        connectednessBoost,
        hierarchicalParentDecay,
        siblingCollapseThreshold,
        bootstrapEnv: buildBootstrapEnv(),
      });
      installCallToolHandler(serverHolder.server, rebuilt);
    },
  });

  // Step 3+4: wire handlers with whatever stores are known now. A
  // roots-only project store, if any, is wired post-connect below.
  // `defaultLimit` is the resolved `COMMONPLACE_DEFAULT_LIMIT` value;
  // the search handler uses it when the caller omits `limit`.
  const handlers = createDefaultHandlers({
    userStore,
    projectStore: initialProjectStore ?? undefined,
    graph: userGraph,
    projectGraph: initialProjectGraph ?? undefined,
    defaultLimit,
    expansionDecay,
    connectednessBoost,
    hierarchicalParentDecay,
    siblingCollapseThreshold,
    bootstrapEnv: buildBootstrapEnv(),
  });
  const server = createServer({
    handlers,
    userStore,
    projectStore: initialProjectStore ?? undefined,
  });
  serverHolder.server = server;

  // Step 5: connect first so the transport is ready to issue requests.
  await server.connect(options.transport);

  // Step 5b: fire the npm-registry version check. Fire-and-forget --
  // the call is intentionally NOT awaited so a slow/offline registry
  // cannot block boot or any MCP request. `checkForUpdates` swallows
  // every error internally; we still attach a defensive `.catch` so an
  // unexpected synchronous-then-async rejection does not surface as an
  // unhandled promise rejection in the Node process.
  void checkForUpdates({
    currentVersion: SERVER_VERSION,
    env: options.env,
  }).catch(() => {});

  // Step 6+7: ask the client for its roots, then re-detect scope using the
  // response. The env-only initial detection above is fine for the user
  // dir (env > roots/list/cwd are all project-only signals), but the
  // project-dir branch wants the roots/list result.
  const roots = await requestRoots(server);
  const finalScope = detectScope({
    env: options.env,
    roots,
    cwd: options.cwd,
    homedir: home,
  });

  // Step 8: if the final scope names a project dir that we didn't already
  // wire pre-connect, construct it now and re-bind the server's handler
  // map so subsequent CallTool requests see both stores. The recall pack
  // already in `instructions` is fixed at this point -- pins from a
  // roots-only project store surface on the next session, per the
  // documented "computed once at process startup" contract.
  let projectStore: MemoryStore | null = initialProjectStore;
  if (finalScope.projectDir !== null && finalScope.projectDir !== initialScope.projectDir) {
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
      projectGraph,
      defaultLimit,
      expansionDecay,
      connectednessBoost,
      hierarchicalParentDecay,
      siblingCollapseThreshold,
      bootstrapEnv: buildBootstrapEnv(),
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
