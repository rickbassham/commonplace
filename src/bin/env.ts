/**
 * Environment-variable resolution for the embedder model id, the
 * `memory_search` default limit, the one-hop expansion decay, and the
 * connectedness boost.
 *
 * The memory-directory env vars (`COMMONPLACE_USER_DIR`,
 * `COMMONPLACE_PROJECT_DIR`, deprecated `COMMONPLACE_MEMORY_DIR`) are owned
 * by `./scope.ts`. This module covers the remaining knobs:
 *
 *   - `COMMONPLACE_MODEL` -- embedding model id passed to transformers.js.
 *     Default `Xenova/bge-base-en-v1.5`. Empty string is treated as unset.
 *   - `COMMONPLACE_DEFAULT_LIMIT` -- default top-k for `memory_search` when
 *     the caller omits `limit`. Default `5`. Empty string is treated as
 *     unset. Invalid values (non-integer, negative, NaN) throw at boot
 *     rather than silently coercing -- the operator should learn about a
 *     misconfiguration immediately, not see weirdly-truncated results.
 *   - `COMMONPLACE_EXPANSION_DECAY` -- multiplicative score applied to
 *     one-hop graph-expanded neighbors of a direct `memory_search` hit.
 *     Default `0.7`. Allowed range is `(0, 1]`; values outside the range
 *     or non-numeric throw at boot.
 *   - `COMMONPLACE_CONNECTEDNESS_BOOST` -- alpha coefficient for the
 *     additive `alpha * log(1 + inbound_count)` connectedness boost
 *     applied to each direct cosine hit's score in `memory_search`.
 *     Default `0.02`. Must be a finite non-negative number; `0` disables
 *     the boost entirely (and yields identical results to the unboosted
 *     ranking). Negative / non-numeric / NaN / Infinity values throw at
 *     boot.
 *
 * # Out of scope
 *
 *   - Pre-validating `COMMONPLACE_MODEL` against a known-models list. The
 *     embedder catches unknown ids lazily on the first `embed()` call; we
 *     deliberately do NOT pre-validate here.
 *   - A config-file fallback. v0.1 is env-vars-only.
 */

import { DEFAULT_CONNECTEDNESS_BOOST, DEFAULT_EXPANSION_DECAY } from '../server/defaults.js';

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
 * Env var name for the one-hop expansion decay. Defaults to
 * {@link DEFAULT_EXPANSION_DECAY} when unset or empty. Must be a number in
 * `(0, 1]` when set; invalid values throw at boot.
 */
export const ENV_EXPANSION_DECAY = 'COMMONPLACE_EXPANSION_DECAY';

/**
 * Env var name for the connectedness boost alpha. Defaults to
 * {@link DEFAULT_CONNECTEDNESS_BOOST} when unset or empty. Must be a finite
 * non-negative number when set; invalid values throw at boot. Setting it to
 * `0` disables the boost.
 */
export const ENV_CONNECTEDNESS_BOOST = 'COMMONPLACE_CONNECTEDNESS_BOOST';

/**
 * Default embedding model id when `COMMONPLACE_MODEL` is unset or empty.
 */
export const DEFAULT_MODEL_ID = 'Xenova/bge-base-en-v1.5';

/**
 * Default `memory_search` top-k when `COMMONPLACE_DEFAULT_LIMIT` is unset
 * or empty. Mirrors `DEFAULT_SEARCH_LIMIT` from the store layer.
 */
export const DEFAULT_LIMIT = 5;

/**
 * Re-export the default values for the expansion decay and the connectedness
 * boost. The canonical definitions live in `../server/defaults.ts` so the
 * handler factory and the env resolvers share a single source of truth;
 * bumping a default in either spot would otherwise silently drift from the
 * other.
 */
export { DEFAULT_EXPANSION_DECAY, DEFAULT_CONNECTEDNESS_BOOST };

/**
 * Resolve the embedding model id from the environment.
 *
 * Returns `env.COMMONPLACE_MODEL` when it is a non-empty string, otherwise
 * {@link DEFAULT_MODEL_ID}. An empty string is treated as unset so callers
 * who clear the variable (e.g. `COMMONPLACE_MODEL=`) get the default
 * rather than a transformers.js error on `''`.
 *
 * Does NOT validate the model id -- the embedder catches unknown ids
 * lazily on the first `embed()` call, and the resulting error names the
 * offending id.
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

/**
 * Resolve the one-hop expansion decay from the environment.
 *
 * Returns the parsed number when `COMMONPLACE_EXPANSION_DECAY` is set,
 * otherwise {@link DEFAULT_EXPANSION_DECAY}. Empty strings are treated as
 * unset.
 *
 * Throws when the variable is set to a value that is not a finite number
 * in the half-open range `(0, 1]`. The thrown error names the offending
 * env var and value so the operator can recover at boot. We deliberately
 * do NOT silently coerce -- a typo like `COMMONPLACE_EXPANSION_DECAY=1.5`
 * (or `-0.5`, or `abc`) should fail loudly rather than silently produce
 * neighbors scored higher than their sources (or, in the negative-input
 * case, negative scores that always sort below direct hits but might
 * still mislead callers).
 */
export function resolveExpansionDecay(env: NodeJS.ProcessEnv): number {
  const raw = env[ENV_EXPANSION_DECAY];
  if (typeof raw !== 'string' || raw.length === 0) {
    return DEFAULT_EXPANSION_DECAY;
  }
  const parsed = Number(raw);
  // Reject NaN (non-numeric), +/-Infinity, <=0, and >1. Decay must keep
  // expanded scores strictly below their source (decay < 1 is the strict
  // intent; we also accept exactly 1 so callers can disable the penalty
  // intentionally without coercing it to "no expansion").
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(
      `${ENV_EXPANSION_DECAY} must be a finite number in (0, 1]; got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * Resolve the connectedness boost alpha from the environment.
 *
 * Returns the parsed number when `COMMONPLACE_CONNECTEDNESS_BOOST` is set,
 * otherwise {@link DEFAULT_CONNECTEDNESS_BOOST}. Empty strings are treated
 * as unset.
 *
 * Throws when the variable is set to a value that is not a finite
 * non-negative number. The thrown error names the offending env var and
 * value so the operator can recover at boot. We deliberately do NOT
 * silently coerce -- a typo like `COMMONPLACE_CONNECTEDNESS_BOOST=abc`
 * (or `-0.5`, or `NaN`, or `Infinity`) should fail loudly rather than
 * silently produce no boost (or negative boosts).
 *
 * Zero is accepted as a valid disable value -- yields identical results
 * to the unboosted ranking.
 */
export function resolveConnectednessBoost(env: NodeJS.ProcessEnv): number {
  const raw = env[ENV_CONNECTEDNESS_BOOST];
  if (typeof raw !== 'string' || raw.length === 0) {
    return DEFAULT_CONNECTEDNESS_BOOST;
  }
  const parsed = Number(raw);
  // Reject NaN (non-numeric), +/-Infinity, and negative values. Zero is
  // valid (the explicit disable case). We accept arbitrarily large
  // positive values rather than capping -- the operator is in charge of
  // alpha, and the boost-magnitude bound test (`alpha * log(1 + N)` for
  // a 10k-memory corpus) catches "alpha was bumped past the cosine
  // range" at the test layer.
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${ENV_CONNECTEDNESS_BOOST} must be a finite non-negative number (0 disables the boost); got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
