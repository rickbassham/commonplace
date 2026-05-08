/**
 * `[[name]]` body-mention extractor (DAR-927).
 *
 * This module owns the pure tokenizer: given a memory's markdown body, it
 * returns the unique set of mention targets in first-occurrence order. The
 * tokenizer accepts only `<name>` tokens that match the same `^[a-z0-9_]+$`
 * rule used by memory filenames (see `NAME_PATTERN` / `validateName` in
 * `./memory.ts`); anything else is silently ignored.
 *
 * # Wiring
 *
 * The `MemoryStore` (see `./memory-store.ts`) calls {@link extractMentions}
 * once per memory body during `scan()` and `save()` and then forwards each
 * extracted name to `MemoryGraph.addMentionsEdge`. Extraction is gated by
 * the env var `COMMONPLACE_EXTRACT_MENTIONS` (default on; only the literal
 * string `'false'` disables it). The store reads the env var via
 * {@link mentionsExtractionEnabled} so test suites can toggle behavior
 * without re-importing the module.
 *
 * # Out of scope
 *
 *   - Wiki-style backlink rendering / autocomplete (issue's "Out of scope").
 *   - Code-fence / inline-code awareness; the AC defines the tokenizer
 *     purely as a regex over body content, so `[[name]]` inside fenced
 *     code blocks or backtick spans is intentionally treated like any
 *     other mention. Adding markdown-aware exclusion is non-goal #1 in
 *     the contract.
 *   - Surfacing mentions through MCP tool responses (DAR-929 / DAR-932
 *     own that surface).
 *
 * # Performance shape
 *
 * The extractor performs a single linear regex scan over the body and a
 * `Set` membership check per match. Cost is O(body.length) plus
 * O(matches) -- mirroring the O(authored-degree) shape used by DAR-926
 * for authored relations. No perf budget is asserted; see contract
 * non-goal #5.
 */

import { NAME_PATTERN } from './memory.js';

/**
 * Match a `[[<inner>]]` candidate where `<inner>` is one or more characters
 * that are neither brackets nor whitespace, AND the surrounding context is
 * exactly two brackets on each side (no triple-bracket variants).
 *
 * The character class `[^[\]\s]` deliberately excludes whitespace and
 * brackets so:
 *   - `[[]]` (empty inner) does not match (the `+` requires at least one
 *     character).
 *   - `[[ name ]]` (whitespace inside brackets) does not match.
 *   - `[[name]` and `[name]]` (single-bracket variants) do not match.
 *
 * The negative lookbehind `(?<!\[)` and negative lookahead `(?!\])` reject
 * triple-bracket variants like `[[[name]]]` -- without them the inner
 * `[[name]]` slice would match.
 *
 * Matched candidates whose inner text fails {@link NAME_PATTERN}
 * (uppercase, hyphens, dots, unicode, ...) are dropped at the validation
 * step inside {@link extractMentions}, not at the regex layer. Keeping
 * those two layers separate means the regex stays readable and the
 * validation reuses the same `^[a-z0-9_]+$` definition exported from
 * `./memory.ts`.
 */
const MENTION_CANDIDATE = /(?<!\[)\[\[([^[\]\s]+)\]\](?!\])/g;

/**
 * Extract the unique set of `[[name]]` mention targets from a markdown
 * body.
 *
 * Accepts a body string. Returns an array of mention names in
 * first-occurrence order, deduplicated by name. Each returned name matches
 * `^[a-z0-9_]+$` (the same rule as memory file names); candidates whose
 * inner text fails that rule -- uppercase letters, hyphens, dots, spaces,
 * other non-`[a-z0-9_]` characters -- are dropped.
 *
 * The function is pure and synchronous; it never throws and never reads
 * the environment. Env-var gating happens at the call site, not here, so
 * unit tests can exercise the tokenizer in isolation.
 */
export const extractMentions = (body: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  // `MENTION_CANDIDATE` is shared and global; reset its lastIndex
  // defensively before iterating so multiple back-to-back calls can't
  // cross-contaminate.
  MENTION_CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_CANDIDATE.exec(body)) !== null) {
    const inner = m[1];
    // `inner` is guaranteed non-undefined because the capture group is
    // always populated when the regex matches; the defensive guard keeps
    // strict TS happy without changing behaviour.
    if (inner === undefined) continue;
    if (!NAME_PATTERN.test(inner)) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    out.push(inner);
  }
  return out;
};

/**
 * Read the `COMMONPLACE_EXTRACT_MENTIONS` env var and decide whether
 * mention extraction is enabled.
 *
 * Default is `true` (enabled). Only the literal string `'false'` disables
 * extraction. Any other value -- unset, empty string, `'true'`, `'yes'`,
 * arbitrary strings -- enables extraction. This matches the contract's
 * non-goal #4: malformed env var values are intentionally not given
 * special handling.
 *
 * The function reads `process.env` on every call so tests can flip the
 * variable at runtime without module-level caching.
 */
export const mentionsExtractionEnabled = (): boolean =>
  process.env.COMMONPLACE_EXTRACT_MENTIONS !== 'false';
