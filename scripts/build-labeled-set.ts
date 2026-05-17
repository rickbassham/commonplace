/**
 * Labeled-set generator for the DAR-1034 retrieval benchmark.
 *
 * Consumes mined `memory_search` records (see `scripts/mine-transcripts.ts`)
 * and produces `(query, expected_names, category)` labeled pairs. Categories:
 *
 *   - `confirmed_hit`: the agent's next assistant turn references the top
 *     returned name (the agent went on to use the result without
 *     correction).
 *   - `operator_correction`: the operator's next user turn explicitly
 *     references a memory name in the corpus that was NOT in
 *     `returnedNames` -- a clear "you should have used X instead" signal.
 *   - `should_have_hit`: the search returned no results AND the operator's
 *     next turn references a memory name from the corpus.
 *
 * # Reproducibility
 *
 * Given identical `calls` and `corpus`, the output is byte-identical
 * (sorted by `category` then `query`). This is the contract's
 * "deterministic ordering or documented sort key" requirement.
 *
 * # Corpus matching
 *
 * The corpus is a list of `{ name, filename }` pairs. The `name` is the
 * YAML frontmatter `name:` value as returned by `memory_search`; older
 * memories use prose names like "Release artifacts must come out of the
 * canonical build pipeline", while newer ones use the canonical snake_case
 * form. The `filename` is always the snake_case basename of the `.md`
 * file on disk -- that is what the benchmark joins against the in-memory
 * corpus, so the labeled-set generator emits `filename` (NOT the prose
 * `name`) into `expected_names`. This avoids dangling references when the
 * benchmark looks up memory entries by canonical filename.
 *
 * # Out of scope
 *
 *   - Loading the corpus from disk (the caller passes `corpus` in).
 *   - Loading mined records from disk (the caller passes `calls` in).
 *   - Hand-curation fallback (forbidden by the issue when mining yields
 *     fewer than 30 pairs).
 */

import type { MinedSearchCall } from './mine-transcripts.js';

/** A memory in the corpus, as exposed to the labeled-set generator. */
export interface CorpusName {
  /** Frontmatter `name:` value (may be prose, may be snake_case). */
  name: string;
  /** Canonical filename (snake_case basename of the `.md` file). */
  filename: string;
}

/** A labeled `(query, expected_names, category)` pair. */
export interface LabeledPair {
  query: string;
  expected_names: string[];
  category: LabelCategory;
}

export type LabelCategory = 'confirmed_hit' | 'operator_correction' | 'should_have_hit';

export interface BuildLabeledSetOptions {
  calls: MinedSearchCall[];
  corpus: CorpusName[];
}

/**
 * Build the labeled set. See module docstring for the category rules.
 *
 * Pure function: no filesystem I/O, no network calls. Re-running with
 * identical inputs produces identical output (sorted by category then
 * query).
 */
export const buildLabeledSet = (opts: BuildLabeledSetOptions): LabeledPair[] => {
  const { calls, corpus } = opts;
  const nameLookup = buildNameLookup(corpus);

  const pairs: LabeledPair[] = [];
  for (const call of calls) {
    const labeled = labelOne(call, nameLookup);
    if (labeled !== null) pairs.push(labeled);
  }

  pairs.sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.query !== b.query) return a.query < b.query ? -1 : 1;
    return 0;
  });
  return pairs;
};

// --- helpers ----------------------------------------------------------------

interface NameLookup {
  /** Resolves any known name (prose or filename) to canonical filename. */
  resolve(text: string): string | null;
  /** All known prose-and-filename forms, sorted longest-first for matching. */
  allTokens: ReadonlyArray<{ token: string; filename: string }>;
}

const buildNameLookup = (corpus: CorpusName[]): NameLookup => {
  // We accept either the frontmatter `name:` value OR the canonical filename
  // as a memory reference. Longer tokens are tried first so a prose name
  // like "Release artifacts must come out of the canonical build pipeline"
  // doesn't get masked by a shorter prefix of another memory's name.
  const tokens: Array<{ token: string; filename: string }> = [];
  const exact = new Map<string, string>();
  for (const c of corpus) {
    if (c.name !== '' && !exact.has(c.name)) {
      exact.set(c.name, c.filename);
      tokens.push({ token: c.name, filename: c.filename });
    }
    if (c.filename !== c.name && !exact.has(c.filename)) {
      exact.set(c.filename, c.filename);
      tokens.push({ token: c.filename, filename: c.filename });
    }
  }
  tokens.sort((a, b) => b.token.length - a.token.length);

  return {
    resolve: (text) => exact.get(text) ?? null,
    allTokens: tokens,
  };
};

/**
 * Find every distinct corpus filename whose name OR filename token appears
 * as a substring of `text`. Matching is case-sensitive (memory names use
 * stable casing in the corpus, and operator messages tend to mirror that
 * casing when citing a memory). Returned in first-occurrence order in
 * `text` so multi-mention messages preserve operator emphasis.
 *
 * **Substring-match assumption.** Tokens are matched by bare `indexOf`;
 * collision avoidance relies on {@link buildNameLookup} returning tokens
 * sorted longest-first (and on each token being seen-deduped on its
 * canonical filename). This means a short token that is a prefix or
 * substring of a longer corpus name will be shadowed by the longer name
 * when both appear -- which is what we want today, given the user-scope
 * corpus consists of distinct long prose names (e.g.
 * `macos_apfs_fsync_test_perf`). Adding a short single-word memory name
 * (`fsync`, say) could in principle produce false-positive operator-
 * correction / should-have-hit entries pointing at the shorter memory
 * inside a longer memory's name. If that risk materialises, switch to
 * word-boundary matching (`new RegExp('\\b' + escape(token) + '\\b')`)
 * here rather than relying on the longest-first ordering.
 */
const findMentionedFilenames = (text: string, lookup: NameLookup): string[] => {
  if (text === '') return [];
  const found: Array<{ filename: string; at: number }> = [];
  const seen = new Set<string>();
  for (const { token, filename } of lookup.allTokens) {
    const at = text.indexOf(token);
    if (at === -1) continue;
    if (seen.has(filename)) continue;
    seen.add(filename);
    found.push({ filename, at });
  }
  found.sort((a, b) => a.at - b.at);
  return found.map((f) => f.filename);
};

/**
 * Apply the category rules to one mined call. Returns `null` when no usable
 * signal can be extracted (e.g. follow-up text mentions no corpus name).
 */
const labelOne = (call: MinedSearchCall, lookup: NameLookup): LabeledPair | null => {
  const returnedFilenames = new Set<string>();
  for (const ret of call.returnedNames) {
    // `returnedNames` can be either canonical filenames (snake_case) or
    // prose `name:` values; map both into the canonical filename so we can
    // compare with the operator-mentioned filenames below.
    const filename = lookup.resolve(ret);
    if (filename !== null) returnedFilenames.add(filename);
  }

  // First: did the operator name a memory the search didn't return?
  // That's an explicit correction signal and outranks the implicit
  // "agent continued working" confirmed_hit signal.
  const operatorMentions = findMentionedFilenames(call.operatorFollowupText, lookup);
  const operatorNotReturned = operatorMentions.filter((f) => !returnedFilenames.has(f));

  // 1. operator_correction: operator-mentioned corpus name that was NOT
  //    in returnedNames AND the search returned at least one candidate.
  //    (When returnedNames is empty, the same operator-mention signal
  //    routes to `should_have_hit` below -- it's the same evidence, just
  //    a different category.)
  if (operatorNotReturned.length > 0 && call.returnedNames.length > 0) {
    return {
      query: call.query,
      expected_names: operatorNotReturned,
      category: 'operator_correction',
    };
  }

  // 2. should_have_hit: no useful results, but operator named a memory.
  if (call.returnedNames.length === 0 && operatorMentions.length > 0) {
    return {
      query: call.query,
      expected_names: operatorMentions,
      category: 'should_have_hit',
    };
  }

  // 3. confirmed_hit: the agent continued without correction. Per the
  //    issue's signal definition this is "agent used the top result and
  //    continued without correction". We accept the top returned name as
  //    the expected match when:
  //      a. the top name resolves to a corpus filename (no dangling), and
  //      b. the operator did NOT name a corrective memory (handled above),
  //    EITHER:
  //      (i)  the agent's follow-up text/tool_use payloads cite the top
  //           name verbatim (the strong signal), OR
  //      (ii) the operator follow-up is empty (silent acceptance -- the
  //           operator let the agent continue, which the issue lists as
  //           a confirmed-hit signal).
  if (call.returnedNames.length > 0) {
    const topName = call.returnedNames[0]!;
    const topFilename = lookup.resolve(topName);
    if (topFilename !== null) {
      const cited =
        call.agentFollowupText.includes(topName) || call.agentFollowupText.includes(topFilename);
      const silentlyAccepted = call.operatorFollowupText.trim() === '';
      if (cited || silentlyAccepted) {
        return {
          query: call.query,
          expected_names: [topFilename],
          category: 'confirmed_hit',
        };
      }
    }
  }

  return null;
};
