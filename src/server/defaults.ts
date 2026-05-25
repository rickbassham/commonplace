/**
 * Server-layer default values for handler-tunable knobs.
 *
 * These constants live in the server layer (not the bin layer) so the
 * handler factory can reference them without reaching across into
 * `../bin/env.ts` -- the bin module pulls in `node:process` and exists
 * for env-var resolution, which is not a concern of the handler factory
 * itself.
 *
 * The bin's env-var resolvers (`resolveExpansionDecay`,
 * `resolveConnectednessBoost`) re-export these via `../bin/env.ts` so
 * there is a single source of truth: change the value here and both the
 * boot path (env unset / empty -> default) and the test path (handler
 * factory wired without env) pick up the new value.
 */

/**
 * Default one-hop expansion decay applied to expanded neighbors' scores
 * when neither the caller nor the env supplies one. An expanded
 * neighbor's score is `direct_hit_score * decay`.
 */
export const DEFAULT_EXPANSION_DECAY = 0.7;

/**
 * Default connectedness boost alpha applied to each direct cosine hit's
 * score in `memory_search` when neither the caller nor the env supplies
 * one. Final score is `cosine_score + alpha * log(1 + inbound_count)`.
 *
 * The default `0.02` is intentionally small: the maximum boost it
 * produces on a typical corpus is `0.02 * log(1 + N)` which stays well
 * below the cosine score range so cosine still dominates ranking between
 * memories with very different similarity. Tie-breaking between
 * similar-cosine memories is where the boost actually moves results.
 */
export const DEFAULT_CONNECTEDNESS_BOOST = 0.02;

/**
 * Default decay applied to a hierarchical parent scaffold's score in
 * `memory_search` when `expand: 'hierarchical'` is used and neither the
 * caller nor the env supplies an override. The included parent's score is
 * `max(triggering_child_score) * parentDecay`. The default `0.9` keeps the
 * parent close to (but strictly below) its strongest triggering child so
 * the parent typically appears just under its child in raw-score order --
 * sibling collapse is the mechanism that re-ranks the parent above the
 * triggering children when enough siblings hit.
 */
export const DEFAULT_HIERARCHICAL_PARENT_DECAY = 0.9;

/**
 * Default minimum number of direct-hit siblings sharing the same
 * `child-of` parent that triggers sibling collapse in `memory_search`'s
 * hierarchical expansion. When the count meets or exceeds this threshold,
 * the parent is re-ranked above its triggering children in the merged
 * result list. The default `2` mirrors the issue's AC-3 default.
 */
export const DEFAULT_SIBLING_COLLAPSE_THRESHOLD = 2;
