/**
 * Fire-and-forget startup version check against the public npm registry.
 *
 * Called once per server-process spawn from `bootServer` after
 * `server.connect()` resolves. The check is opt-out via the
 * `COMMONPLACE_NO_UPDATE_CHECK` env var, bounded by a hard timeout
 * enforced through an `AbortController`, and silent in every failure
 * mode -- the server must not fail to start or fail any MCP request
 * because of a registry hiccup.
 *
 * When the registry returns a `version` newer than the running
 * `SERVER_VERSION` (compared with semver precedence, not lexicographic),
 * a single line is written to stderr noting both versions and the
 * recommended upgrade path. Equal or older versions, malformed
 * responses, non-200 statuses, network errors, JSON parse failures, and
 * timeouts all produce no output and no thrown error.
 *
 * The function deliberately does NOT cache to disk: each fresh stdio
 * process spawn re-checks under the timeout cap. Cross-process caching
 * is explicitly out of scope (DAR-1006 Out of Scope section).
 */

/** Public npm registry endpoint for the `latest` dist-tag of commonplace-mcp. */
export const REGISTRY_URL = 'https://registry.npmjs.org/commonplace-mcp/latest';

/** Default hard timeout (ms) for the version-check fetch. */
export const DEFAULT_TIMEOUT_MS = 1500;

/** Env var that disables the version check when set to `1` or `true`. */
export const ENV_NO_UPDATE_CHECK = 'COMMONPLACE_NO_UPDATE_CHECK';

/** Options for {@link checkForUpdates}. */
export interface CheckForUpdatesOptions {
  /** Currently running server version (typically `SERVER_VERSION`). */
  currentVersion: string;
  /** Environment-variable snapshot. Pass `process.env` from the bin. */
  env: NodeJS.ProcessEnv;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Tests inject a
   * stub so they do not hit the real registry.
   */
  fetch?: typeof fetch;
  /**
   * Log sink for the single stderr line. Defaults to `console.error`,
   * which writes to stderr. Tests inject a recorder.
   */
  log?: (message: string) => void;
  /**
   * Hard timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * Returns `true` when the env var is set to `1` or `true` (the documented
 * opt-out values). Empty string and unset both fall through to "run the
 * check" -- callers that want to disable the check via an empty value
 * should use `=1` instead.
 */
function isOptedOut(env: NodeJS.ProcessEnv): boolean {
  const raw = env[ENV_NO_UPDATE_CHECK];
  return raw === '1' || raw === 'true';
}

/**
 * Three-part semver comparator. Returns >0 when `a` is newer than `b`,
 * <0 when `a` is older, and 0 when they are equal. Pre-release and build
 * metadata are intentionally stripped before comparison -- the registry's
 * `latest` dist-tag never carries a pre-release suffix, and any
 * pre-release the user pinned themselves is opted-out territory.
 *
 * Returns `null` when either input is not a parseable `MAJOR.MINOR.PATCH`
 * triple -- callers treat that as "skip the comparison" rather than throw.
 */
function compareSemver(a: string, b: string): number | null {
  const parse = (s: string): [number, number, number] | null => {
    // Drop any pre-release / build-metadata suffix before parsing.
    const core = s.split(/[-+]/, 1)[0]!;
    const parts = core.split('.');
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return [nums[0]!, nums[1]!, nums[2]!];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

/**
 * Format the single stderr line written when a newer version is on npm.
 * The wording is final at implementation time -- callers asserting on
 * the line shape should match substrings, not byte-for-byte equality.
 */
function formatUpdateLine(currentVersion: string, registryVersion: string): string {
  return (
    `commonplace-mcp ${currentVersion} is running; ` +
    `newer version ${registryVersion} is available. ` +
    'To upgrade: pin via npx (recommended) or run ' +
    '`npm install -g commonplace-mcp@latest`.'
  );
}

/**
 * Run the version check end-to-end. Always resolves (never throws); the
 * caller invokes this without `await` so a hung or rejecting promise
 * cannot block boot. See module-level docs for the failure-mode contract.
 */
export async function checkForUpdates(options: CheckForUpdatesOptions): Promise<void> {
  if (isOptedOut(options.env)) return;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((msg: string) => console.error(msg));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== 'function') {
    // No fetch available in this runtime; fail silently per the AC.
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) return;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Malformed JSON body -- silent per ac-4.
      return;
    }
    if (!isObject(payload)) return;
    const registryVersion = payload.version;
    if (typeof registryVersion !== 'string' || registryVersion.length === 0) return;
    const cmp = compareSemver(registryVersion, options.currentVersion);
    if (cmp === null || cmp <= 0) return;
    log(formatUpdateLine(options.currentVersion, registryVersion));
  } catch {
    // Network error, abort, or any other thrown error: silent per ac-4 / ac-6.
    return;
  } finally {
    clearTimeout(timer);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
