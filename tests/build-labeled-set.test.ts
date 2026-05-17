/**
 * Tests for the labeled-set generator under `scripts/build-labeled-set.ts`.
 *
 * The labeled-set generator consumes mined `memory_search` records and
 * classifies each one into a labeled `(query, expected_names, category)`
 * pair, where `category` is one of:
 *
 *   - `confirmed_hit`     -- the agent went on to use the top-ranked
 *     returned name without operator correction.
 *   - `operator_correction` -- the operator's next user-turn explicitly
 *     named a different memory the agent should have used.
 *   - `should_have_hit`   -- the search returned no useful candidates AND
 *     the operator named the memory the agent should have found.
 *
 * Reproducibility: given the same mined input and the same corpus name
 * list, the generator must produce byte-identical output.
 */

import { describe, expect, it } from 'vitest';

import type { MinedSearchCall } from '../scripts/mine-transcripts.js';
import {
  buildLabeledSet,
  type LabeledPair,
  type CorpusName,
} from '../scripts/build-labeled-set.js';

/** Make a complete `MinedSearchCall` from a few interesting fields. */
const mk = (over: Partial<MinedSearchCall>): MinedSearchCall => ({
  transcript: '/fixtures/x.jsonl',
  sessionId: 's1',
  toolUseId: 'toolu_x',
  timestamp: '2026-05-17T00:00:00Z',
  query: 'q',
  scope: null,
  returnedNames: [],
  agentFollowupText: '',
  operatorFollowupText: '',
  ...over,
});

const corpus: CorpusName[] = [
  { name: 'macos_apfs_fsync_test_perf', filename: 'macos_apfs_fsync_test_perf' },
  { name: 'commonplace_app_structure', filename: 'commonplace_app_structure' },
  {
    name: 'Release artifacts must come out of the canonical build pipeline',
    filename: 'feedback_release_artifacts_canonical_only',
  },
  {
    name: 'feedback_dogfood_the_product_you_are_building',
    filename: 'feedback_dogfood_the_product_you_are_building',
  },
];

describe('buildLabeledSet (ac-2)', () => {
  it('every entry has query: string and expected_names: string[] with length >= 1', () => {
    const calls = [
      mk({
        toolUseId: 'a',
        query: 'fsync apfs',
        returnedNames: ['macos_apfs_fsync_test_perf'],
        // Agent followed up citing the top hit by name -- confirmed_hit.
        agentFollowupText: 'I will check macos_apfs_fsync_test_perf next.',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(typeof p.query).toBe('string');
    expect(Array.isArray(p.expected_names)).toBe(true);
    expect(p.expected_names.length).toBeGreaterThanOrEqual(1);
  });

  it('classifies a confirmed_hit when the agent follow-up cites the top returned name', () => {
    const calls = [
      mk({
        toolUseId: 'b',
        query: 'fsync',
        returnedNames: ['macos_apfs_fsync_test_perf', 'commonplace_app_structure'],
        agentFollowupText: 'Looking at macos_apfs_fsync_test_perf...',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('confirmed_hit');
    expect(out[0]!.expected_names).toEqual(['macos_apfs_fsync_test_perf']);
  });

  it('classifies operator_correction when the operator next-turn names a memory NOT in returnedNames', () => {
    const calls = [
      mk({
        toolUseId: 'c',
        query: 'release pipeline',
        returnedNames: ['commonplace_app_structure'],
        operatorFollowupText:
          'You should have used feedback_release_artifacts_canonical_only, not the structure one.',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('operator_correction');
    expect(out[0]!.expected_names).toEqual(['feedback_release_artifacts_canonical_only']);
  });

  it('classifies should_have_hit when no results were returned but operator names a memory', () => {
    const calls = [
      mk({
        toolUseId: 'd',
        query: 'dogfood',
        returnedNames: [],
        operatorFollowupText: 'see feedback_dogfood_the_product_you_are_building',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('should_have_hit');
    expect(out[0]!.expected_names).toEqual(['feedback_dogfood_the_product_you_are_building']);
  });

  it('classifies confirmed_hit when the operator follow-up is empty and the top result resolves to the corpus (silent acceptance)', () => {
    // Empty operator follow-up + top result in corpus + no agent citation
    // is still a confirmed_hit per the issue's "agent used the top result
    // and continued without correction" rule. The operator silence IS the
    // "without correction" signal.
    const calls = [
      mk({
        toolUseId: 'silent',
        query: 'fsync apfs',
        returnedNames: ['macos_apfs_fsync_test_perf'],
        agentFollowupText: 'I will proceed.',
        operatorFollowupText: '',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('confirmed_hit');
    expect(out[0]!.expected_names).toEqual(['macos_apfs_fsync_test_perf']);
  });

  it('drops calls with no extractable signal (no follow-up name match, no operator correction)', () => {
    const calls = [
      mk({
        toolUseId: 'e',
        query: 'irrelevant',
        returnedNames: ['no_match_in_corpus'],
        // Neither follow-up mentions any corpus name -- nothing to label on.
        agentFollowupText: 'Let me think about this for a moment.',
        operatorFollowupText: 'Continue.',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    expect(out).toHaveLength(0);
  });

  it('is reproducible: same input produces byte-identical output across two runs', () => {
    const calls = [
      mk({
        toolUseId: 'b',
        query: 'fsync',
        returnedNames: ['macos_apfs_fsync_test_perf'],
        agentFollowupText: 'using macos_apfs_fsync_test_perf',
      }),
      mk({
        toolUseId: 'a',
        query: 'dogfood',
        returnedNames: [],
        operatorFollowupText: 'feedback_dogfood_the_product_you_are_building',
      }),
    ];
    const a = buildLabeledSet({ calls, corpus });
    const b = buildLabeledSet({ calls, corpus });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('emits a sorted output (by category then query) so test sets diff cleanly', () => {
    const calls = [
      mk({
        toolUseId: 'z',
        query: 'zeta',
        returnedNames: ['macos_apfs_fsync_test_perf'],
        agentFollowupText: 'macos_apfs_fsync_test_perf',
      }),
      mk({
        toolUseId: 'a',
        query: 'alpha',
        returnedNames: ['macos_apfs_fsync_test_perf'],
        agentFollowupText: 'macos_apfs_fsync_test_perf',
      }),
    ];
    const out: LabeledPair[] = buildLabeledSet({ calls, corpus });
    expect(out.map((p) => p.query)).toEqual(['alpha', 'zeta']);
  });

  it('every emitted expected_name is in the supplied corpus (no dangling references)', () => {
    const calls = [
      mk({
        toolUseId: 'a',
        query: 'fsync',
        returnedNames: ['macos_apfs_fsync_test_perf'],
        agentFollowupText: 'macos_apfs_fsync_test_perf',
      }),
      mk({
        toolUseId: 'b',
        query: 'unknown',
        returnedNames: ['ghost_memory_not_in_corpus'],
        agentFollowupText: 'ghost_memory_not_in_corpus',
      }),
    ];
    const out = buildLabeledSet({ calls, corpus });
    const corpusFilenames = new Set(corpus.map((c) => c.filename));
    for (const pair of out) {
      for (const name of pair.expected_names) {
        expect(corpusFilenames.has(name)).toBe(true);
      }
    }
  });
});
