/**
 * Scope detection for the commonplace MCP server.
 *
 * The server may load up to two `MemoryStore` instances: a user-level store
 * (always loaded) and a project-level store (loaded only if a project root is
 * detectable). This module owns the priority order for project-root
 * detection so the bin entry can stay declarative.
 *
 * # Detection priority (env > roots > cwd-walk > none)
 *
 *   1. `COMMONPLACE_PROJECT_DIR` -- explicit override; always wins. The path
 *      need not exist yet; the project store auto-creates on first save.
 *   2. MCP `roots/list` response -- the first `file://` root in the response
 *      resolves to `<root>/.commonplace/memory`. Non-`file://` roots are
 *      skipped. If the request rejects (client doesn't advertise the
 *      capability, or returns an error), we fall through.
 *   3. Upward walk from `process.cwd()` -- at each directory check for a
 *      `.git/` or `.commonplace/` marker; the first match wins and the
 *      project store path is `<dir>/.commonplace/memory`. The walk stops
 *      at `os.homedir()` exclusive (with realpath normalization on both
 *      sides) so `~/.commonplace/` is never matched as a project root and
 *      a dotfile-as-git-repo home setup does not falsely identify `$HOME`
 *      as a project. Ancestors of `$HOME` are likewise ineligible. The
 *      walk also terminates at the filesystem root (parent === current)
 *      without crossing into infinite recursion. The project memory
 *      directory itself is auto-created on first project-scope save when
 *      it does not yet exist.
 *   4. None of the above -- user-only mode (no project store constructed).
 *
 * # User store
 *
 * The user store is unconditionally located. `COMMONPLACE_USER_DIR` overrides
 * `~/.commonplace/memory`. The deprecated `COMMONPLACE_MEMORY_DIR` is
 * recognised for back-compat: when set AND `COMMONPLACE_USER_DIR` is not,
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

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Env var name for the user-level memory directory. Defaults to
 * `~/.commonplace/memory` when unset.
 */
export const ENV_USER_DIR = 'COMMONPLACE_USER_DIR';

/**
 * Env var name for the project-level memory directory. When set, takes
 * priority over `roots/list` and cwd detection. The path need not exist on
 * disk; it's auto-created on first project-scoped save.
 */
export const ENV_PROJECT_DIR = 'COMMONPLACE_PROJECT_DIR';

/**
 * Deprecated env var from the single-store wiring. When set and
 * {@link ENV_USER_DIR} is not, it's treated as an alias for
 * {@link ENV_USER_DIR} and a stderr warning is emitted.
 */
export const ENV_DEPRECATED_MEMORY_DIR = 'COMMONPLACE_MEMORY_DIR';

/**
 * Conventional name of the per-project memory directory. Looked up under a
 * detected project root (via `roots/list` or cwd walk).
 */
export const PROJECT_MEMORY_DIRNAME = '.commonplace/memory';

/**
 * Marker directory names accepted by the upward cwd walk. A directory that
 * contains either of these is treated as a project root.
 */
export const PROJECT_MARKERS = ['.git', '.commonplace'] as const;

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
   * Working directory the cwd-walk starts from. Pass `process.cwd()` from
   * the bin; tests pass a tmp dir.
   */
  cwd: string;
  /**
   * Home directory used to bound the upward walk. The walk stops before
   * entering `homedir` (i.e. `homedir` itself and any ancestor of `homedir`
   * are ineligible as project roots, regardless of markers). Pass
   * `os.homedir()` from the bin; tests pass a fake path.
   */
  homedir: string;
  /**
   * Filesystem existence probe. Defaults to `node:fs.existsSync`. Tests can
   * override to avoid touching real paths.
   */
  exists?: (path: string) => boolean;
  /**
   * Realpath resolver used to normalize `cwd` and `homedir` before the
   * upward walk so symlinked home directories (rare but real on macOS / CI
   * runners) compare equal to their target. Defaults to
   * `node:fs.realpathSync`; on `ENOENT` for either input we fall back to
   * the unnormalized path. Tests can override to avoid touching real paths.
   */
  realpath?: (path: string) => string;
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
 * Best-effort realpath: returns the resolver's output when it succeeds,
 * otherwise the input path unchanged. The walk runs on candidate dirs that
 * may not exist (especially the synthetic homedir in unit tests), so we
 * must not throw on `ENOENT`.
 */
const safeRealpath = (resolver: (p: string) => string, path: string): string => {
  try {
    return resolver(path);
  } catch {
    return path;
  }
};

/**
 * Return true when `candidate` is `homedir` itself or an ancestor of
 * `homedir`. Such directories are ineligible as project roots per ac-2:
 * `$HOME` must never resolve to a project root, even if it (or one of its
 * ancestors) contains a `.git/` or `.commonplace/` marker.
 *
 * The check is path-string based and runs on realpath-normalized inputs so
 * symlinked home directories compare equal to their target.
 */
const isHomedirOrAncestor = (candidate: string, normalizedHome: string): boolean => {
  if (candidate === normalizedHome) return true;
  // Ancestor check: `${candidate}${sep}` is a strict prefix of homedir's
  // path. The trailing separator prevents matching e.g. `/foo` against
  // `/foobar/...`.
  const candidateWithSep = candidate.endsWith(sep) ? candidate : candidate + sep;
  return normalizedHome.startsWith(candidateWithSep);
};

/**
 * Walk upward from `cwd` looking for a `.git/` or `.commonplace/` marker.
 * Stops at `homedir` exclusive (and at ancestors of `homedir`) and at the
 * filesystem root. Returns the conventional `<dir>/.commonplace/memory`
 * path on the first match, or `null` when no eligible marker is found.
 */
const projectDirFromCwdWalk = (
  cwd: string,
  homeDir: string,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
): string | null => {
  const normalizedHome = safeRealpath(realpath, homeDir);
  let current = safeRealpath(realpath, cwd);

  // Guard against an infinite loop when cwd === filesystem root and the
  // termination check `parent === current` is the only thing that ends the
  // walk. The loop body always either returns or advances `current` to
  // its parent until parent === current.
  while (true) {
    if (isHomedirOrAncestor(current, normalizedHome)) {
      // The candidate is $HOME or an ancestor of $HOME -- ineligible. We
      // must stop the walk here without inspecting `current` for markers,
      // because ac-6 demands cwd === $HOME return null even when $HOME
      // contains a marker.
      return null;
    }
    for (const marker of PROJECT_MARKERS) {
      if (exists(join(current, marker))) {
        return join(current, PROJECT_MEMORY_DIRNAME);
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding a marker.
      return null;
    }
    current = parent;
  }
};

/**
 * Detect the layered store configuration from the priority order:
 * env > roots > cwd-walk > none. See module-level docs for the contract.
 *
 * Pure-ish function: I/O is limited to the injectable `exists` and
 * `realpath` probes (used only for the cwd-walk step). The user dir is
 * always populated; the project dir may be `null`.
 */
export function detectScope(input: ScopeDetectionInput): ScopeDetectionResult {
  const exists = input.exists ?? existsSync;
  const realpath = input.realpath ?? realpathSync;
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

  // 3. Upward walk from cwd, accepting .git or .commonplace as markers and
  //    stopping at $HOME (exclusive) or the filesystem root.
  const fromWalk = projectDirFromCwdWalk(input.cwd, input.homedir, exists, realpath);
  if (fromWalk !== null) {
    return {
      userDir: userResolved.userDir,
      projectDir: fromWalk,
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
