/**
 * Scope detection for the commonplace MCP server (DAR-924).
 *
 * The server may load up to two `MemoryStore` instances: a user-level store
 * (always loaded) and a project-level store (loaded only if a project root is
 * detectable). This module owns the priority order for project-root
 * detection so the bin entry can stay declarative.
 *
 * # Detection priority (env > roots > cwd > none)
 *
 *   1. `COMMONPLACE_PROJECT_DIR` -- explicit override; always wins. The path
 *      need not exist yet (the project store auto-creates on first save per
 *      DAR-924 ac-3).
 *   2. MCP `roots/list` response -- the first `file://` root in the response
 *      resolves to `<root>/.commonplace/memory`. Non-`file://` roots are
 *      skipped. If the request rejects (client doesn't advertise the
 *      capability, or returns an error), we fall through.
 *   3. `process.cwd()` -- if `<cwd>/.commonplace/memory` exists on disk,
 *      that's the project store.
 *   4. None of the above -- user-only mode (no project store constructed).
 *
 * # User store
 *
 * The user store is unconditionally located. `COMMONPLACE_USER_DIR` overrides
 * `~/.commonplace/memory`. The deprecated `COMMONPLACE_MEMORY_DIR` (DAR-919)
 * is recognised for back-compat: when set AND `COMMONPLACE_USER_DIR` is not,
 * it's used as the user dir and a deprecation warning is emitted to stderr.
 *
 * # Out of scope for this module
 *
 *   - constructing `MemoryStore` instances (the bin does that)
 *   - issuing the `roots/list` JSON-RPC request (the bin does that, since
 *     this module is import-time pure and has no MCP server reference)
 *   - mid-session capability churn (`roots/list_changed`); the issue
 *     specifies detection "after init" only
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Env var name for the user-level memory directory. Defaults to
 * `~/.commonplace/memory` when unset.
 */
export const ENV_USER_DIR = 'COMMONPLACE_USER_DIR';

/**
 * Env var name for the project-level memory directory. When set, takes
 * priority over `roots/list` and cwd detection. The path need not exist on
 * disk (it's auto-created on first project-scoped save per DAR-924 ac-3).
 */
export const ENV_PROJECT_DIR = 'COMMONPLACE_PROJECT_DIR';

/**
 * Deprecated env var from the DAR-919 single-store wiring. When set and
 * {@link ENV_USER_DIR} is not, it's treated as an alias for
 * {@link ENV_USER_DIR} and a stderr warning is emitted.
 */
export const ENV_DEPRECATED_MEMORY_DIR = 'COMMONPLACE_MEMORY_DIR';

/**
 * Conventional name of the per-project memory directory. Looked up under a
 * detected project root (via `roots/list` or cwd).
 */
export const PROJECT_MEMORY_DIRNAME = '.commonplace/memory';

/** Default user memory directory when no env override is set. */
export const defaultUserDir = (): string => join(homedir(), '.commonplace', 'memory');

/**
 * A single root entry as returned by an MCP `roots/list` response. We match
 * the SDK's structural shape (`uri`, optional `name`) so callers can pass the
 * raw `roots[]` array through.
 */
export interface RootEntry {
  uri: string;
  name?: string;
}

/** Inputs to {@link detectScope}. */
export interface ScopeDetectionInput {
  /**
   * Snapshot of relevant environment variables. Pass `process.env` from the
   * bin; tests pass a hand-built object so they don't have to mutate the
   * real env.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Roots returned by an MCP `roots/list` request, or `null` if the request
   * was not made / failed / rejected. `[]` is distinct from `null` and
   * represents "client supports roots but has none."
   */
  roots: ReadonlyArray<RootEntry> | null;
  /**
   * Working directory to consult for the cwd-marker fallback. Pass
   * `process.cwd()` from the bin; tests pass a tmp dir.
   */
  cwd: string;
  /**
   * Filesystem existence probe. Defaults to `node:fs.existsSync`. Tests can
   * override to avoid touching real paths.
   */
  exists?: (path: string) => boolean;
}

/** Result of {@link detectScope}. */
export interface ScopeDetectionResult {
  /**
   * Resolved user-store directory. Always populated -- the user store loads
   * unconditionally.
   */
  userDir: string;
  /**
   * Resolved project-store directory, or `null` for user-only mode.
   */
  projectDir: string | null;
  /**
   * Which detection branch produced {@link projectDir}. `'none'` when no
   * project root was detected. Useful for logging and tests.
   */
  source: 'env' | 'roots' | 'cwd' | 'none';
  /**
   * Whether the deprecated `COMMONPLACE_MEMORY_DIR` alias was honoured for
   * the user dir (i.e. `COMMONPLACE_MEMORY_DIR` set, `COMMONPLACE_USER_DIR`
   * unset). The bin uses this to print the stderr deprecation warning.
   */
  usedDeprecatedMemoryDir: boolean;
}

/**
 * Resolve the user-level memory directory from env vars.
 *
 * Priority: `COMMONPLACE_USER_DIR` > `COMMONPLACE_MEMORY_DIR` (deprecated) >
 * default `~/.commonplace/memory`. When the deprecated var is honoured, the
 * returned `usedDeprecatedMemoryDir` flag is `true` so the caller can log.
 */
export function resolveUserDir(env: NodeJS.ProcessEnv): {
  userDir: string;
  usedDeprecatedMemoryDir: boolean;
} {
  const explicit = env[ENV_USER_DIR];
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { userDir: explicit, usedDeprecatedMemoryDir: false };
  }
  const deprecated = env[ENV_DEPRECATED_MEMORY_DIR];
  if (typeof deprecated === 'string' && deprecated.length > 0) {
    return { userDir: deprecated, usedDeprecatedMemoryDir: true };
  }
  return { userDir: defaultUserDir(), usedDeprecatedMemoryDir: false };
}

/**
 * Convert an MCP roots-list `uri` (e.g. `file:///abs/path`) into a plain
 * filesystem path. Returns `null` for non-`file://` schemes (HTTP, custom
 * URIs) so the caller can skip them.
 */
const fileUriToPath = (uri: string): string | null => {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    // Malformed file URI -- treat as unusable.
    return null;
  }
};

/**
 * Pick the first usable `file://` root URI from a roots-list response and
 * resolve it to the conventional `<root>/.commonplace/memory` path. Returns
 * `null` when the response is empty or contains no `file://` entries.
 */
const projectDirFromRoots = (roots: ReadonlyArray<RootEntry>): string | null => {
  for (const r of roots) {
    const root = fileUriToPath(r.uri);
    if (root === null) continue;
    return join(root, PROJECT_MEMORY_DIRNAME);
  }
  return null;
};

/**
 * Detect the layered store configuration from the priority order:
 * env > roots > cwd > none. See module-level docs for the contract.
 *
 * Pure function: no I/O beyond the optional `exists` probe (used only for
 * the cwd-marker step). The user dir is always populated; the project dir
 * may be `null`.
 */
export function detectScope(input: ScopeDetectionInput): ScopeDetectionResult {
  const exists = input.exists ?? existsSync;
  const userResolved = resolveUserDir(input.env);

  // 1. Env override
  const envProjectDir = input.env[ENV_PROJECT_DIR];
  if (typeof envProjectDir === 'string' && envProjectDir.length > 0) {
    return {
      userDir: userResolved.userDir,
      projectDir: envProjectDir,
      source: 'env',
      usedDeprecatedMemoryDir: userResolved.usedDeprecatedMemoryDir,
    };
  }

  // 2. roots/list
  if (input.roots !== null && input.roots.length > 0) {
    const fromRoots = projectDirFromRoots(input.roots);
    if (fromRoots !== null) {
      return {
        userDir: userResolved.userDir,
        projectDir: fromRoots,
        source: 'roots',
        usedDeprecatedMemoryDir: userResolved.usedDeprecatedMemoryDir,
      };
    }
  }

  // 3. cwd marker
  const cwdMarker = join(input.cwd, PROJECT_MEMORY_DIRNAME);
  if (exists(cwdMarker)) {
    return {
      userDir: userResolved.userDir,
      projectDir: cwdMarker,
      source: 'cwd',
      usedDeprecatedMemoryDir: userResolved.usedDeprecatedMemoryDir,
    };
  }

  // 4. none
  return {
    userDir: userResolved.userDir,
    projectDir: null,
    source: 'none',
    usedDeprecatedMemoryDir: userResolved.usedDeprecatedMemoryDir,
  };
}
