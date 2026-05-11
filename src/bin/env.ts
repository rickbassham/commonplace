/**
 * Environment-variable resolution for the embedder model id and the
 * `memory_search` default limit (DAR-913).
 *
 * The memory-directory env vars (`COMMONPLACE_USER_DIR`,
 * `COMMONPLACE_PROJECT_DIR`, deprecated `COMMONPLACE_MEMORY_DIR`) are owned
 * by `./scope.ts` (DAR-924). This module covers the two remaining knobs:
 *
 *   - `COMMONPLACE_MODEL` -- embedding model id passed to transformers.js.
 *     Default `Xenova/bge-base-en-v1.5`. Empty string is treated as unset.
 *   - `COMMONPLACE_DEFAULT_LIMIT` -- default top-k for `memory_search` when
 *     the caller omits `limit`. Default `5`. Empty string is treated as
 *     unset. Invalid values (non-integer, negative, NaN) throw at boot
 *     rather than silently coercing -- the operator should learn about a
 *     misconfiguration immediately, not see weirdly-truncated results.
 *
 * # Out of scope
 *
 *   - Pre-validating `COMMONPLACE_MODEL` against a known-models list. The
 *     embedder catches unknown ids lazily on the first `embed()` call
 *     (DAR-913 ac-5); we deliberately do NOT pre-validate here.
 *   - A config-file fallback. v0.1 is env-vars-only; see DAR-913.
 */

/**
 * Env var name for the embedding model id. Defaults to
 * {@link DEFAULT_MODEL_ID} when unset or empty.
 */
export const ENV_MODEL = 'COMMONPLACE_MODEL';

/**
 * Env var name for the default `memory_search` top-k. Defaults to
 * {@link DEFAULT_LIMIT} when unset or empty. Must be a positive integer
 * when set; invalid values throw at boot.
 */
export const ENV_DEFAULT_LIMIT = 'COMMONPLACE_DEFAULT_LIMIT';

/**
 * Default embedding model id when `COMMONPLACE_MODEL` is unset or empty.
 * Mirrors the `DEFAULT_MODEL_ID` used by the bin pre-DAR-913.
 */
export const DEFAULT_MODEL_ID = 'Xenova/bge-base-en-v1.5';

/**
 * Default `memory_search` top-k when `COMMONPLACE_DEFAULT_LIMIT` is unset
 * or empty. Mirrors `DEFAULT_SEARCH_LIMIT` from the store layer.
 */
export const DEFAULT_LIMIT = 5;

/**
 * Resolve the embedding model id from the environment.
 *
 * Returns `env.COMMONPLACE_MODEL` when it is a non-empty string, otherwise
 * {@link DEFAULT_MODEL_ID}. An empty string is treated as unset so callers
 * who clear the variable (e.g. `COMMONPLACE_MODEL=`) get the default
 * rather than a transformers.js error on `''`.
 *
 * Does NOT validate the model id -- per DAR-913 ac-5 the embedder catches
 * unknown ids lazily on the first `embed()` call, and the resulting error
 * names the offending id.
 */
export function resolveModelId(env: NodeJS.ProcessEnv): string {
  const raw = env[ENV_MODEL];
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return DEFAULT_MODEL_ID;
}

/**
 * Resolve the default `memory_search` top-k from the environment.
 *
 * Returns the parsed positive integer when `COMMONPLACE_DEFAULT_LIMIT` is
 * set, otherwise {@link DEFAULT_LIMIT}. Empty strings are treated as
 * unset.
 *
 * Throws when the variable is set to a value that is not a positive
 * integer (NaN, negatives, fractional values, non-numeric text). The
 * thrown error names the offending env var and value so the operator can
 * recover at boot. We deliberately do NOT silently coerce -- a typo like
 * `COMMONPLACE_DEFAULT_LIMIT=10.5` should fail loudly rather than become
 * `10` after `Math.floor`.
 */
export function resolveDefaultLimit(env: NodeJS.ProcessEnv): number {
  const raw = env[ENV_DEFAULT_LIMIT];
  if (typeof raw !== 'string' || raw.length === 0) {
    return DEFAULT_LIMIT;
  }
  // `Number()` returns NaN for non-numeric strings; `Number.isInteger`
  // rejects NaN and +/-Infinity along with fractional values, so a single
  // integer + sign check covers all the invalid-input shapes we want to
  // surface (non-numeric text, NaN, Infinity, fractional, zero, negative).
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${ENV_DEFAULT_LIMIT} must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}
