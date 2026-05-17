/**
 * Top-level benchmark orchestrator for DAR-1034.
 *
 * The orchestrator is intentionally a pure function whose I/O surface is
 * exclusively the input directory (read-only) and the two output paths
 * (the labeled-set JSON and `docs/retrieval-benchmark.md`). It NEVER
 * writes back into the corpus directory -- the AC-5 invariant.
 *
 * Pipeline:
 *
 *   1. Load the corpus from `corpusDir` (read-only).
 *   2. Build benchmark inputs (pre-compute alternate vectors in memory,
 *      tokenise bodies for BM25).
 *   3. Run every variant from {@link ALL_VARIANTS} over the inputs.
 *   4. Compute Recall@1, Recall@5, and MRR per variant.
 *   5. Write the labeled set to `labeledSetOutputPath` as JSON.
 *   6. Write `docs/retrieval-benchmark.md` to `docsOutputPath` with the
 *      methodology section, corpus stats, results table, and per-variant
 *      interpretation paragraphs.
 *
 * The runner also exposes a CLI entry point at the bottom of the file
 * that wires the user-scope corpus (`~/.commonplace/memory`) and the
 * `~/.claude/projects` transcripts root together; it's the form used to
 * regenerate the doc in-repo.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ALL_VARIANTS,
  buildBenchmarkInputs,
  runVariant,
  type BenchmarkEmbedder,
  type Variant,
  type VariantResult,
} from './retrieval-variants.js';
import { recallAtK, mrr } from './retrieval-metrics.js';
import { loadCorpus } from './load-corpus.js';
import { mineTranscripts, defaultTranscriptsRoot } from './mine-transcripts.js';
import { buildLabeledSet, type LabeledPair, type CorpusName } from './build-labeled-set.js';

export interface RunBenchmarkOptions {
  /** Corpus directory containing `.md` + `.embedding` files (read-only). */
  corpusDir: string;
  /** Labeled pairs to score. The caller is responsible for mining/labeling. */
  pairs: LabeledPair[];
  /** Embedder for re-embedding query and alternate corpus text in memory. */
  embedder: BenchmarkEmbedder;
  /** Output path for the rendered `retrieval-benchmark.md`. */
  docsOutputPath: string;
  /** Output path for the labeled-set JSON. */
  labeledSetOutputPath: string;
  /** Optional BM25 weight in the hybrid variant. Defaults to 0.5. */
  hybridWeight?: number;
}

/** Per-variant metric row. */
export interface VariantMetrics {
  variant: Variant;
  recall_at_1: number;
  recall_at_5: number;
  mrr: number;
  deferred: boolean;
  deferralReason: string | null;
  parameters: Record<string, string | number | boolean>;
}

export interface BenchmarkSummary {
  corpus: { count: number; meanBodyLengthChars: number };
  testSet: { count: number; byCategory: Record<string, number> };
  metrics: VariantMetrics[];
}

export const runBenchmark = async (opts: RunBenchmarkOptions): Promise<BenchmarkSummary> => {
  const corpus = loadCorpus(opts.corpusDir);
  const inputs = await buildBenchmarkInputs({ corpus, pairs: opts.pairs, embedder: opts.embedder });

  const variantResults: VariantResult[] = [];
  for (const variant of ALL_VARIANTS) {
    variantResults.push(
      await runVariant({ variant, inputs, hybridWeight: opts.hybridWeight ?? 0.5 }),
    );
  }

  const metrics: VariantMetrics[] = variantResults.map((r) => ({
    variant: r.variant,
    recall_at_1: r.deferred ? 0 : recallAtK(r.queries, 1),
    recall_at_5: r.deferred ? 0 : recallAtK(r.queries, 5),
    mrr: r.deferred ? 0 : mrr(r.queries),
    deferred: r.deferred,
    deferralReason: r.deferralReason,
    parameters: r.parameters,
  }));

  const summary: BenchmarkSummary = {
    corpus: {
      count: corpus.length,
      meanBodyLengthChars:
        corpus.length === 0 ? 0 : corpus.reduce((acc, c) => acc + c.body.length, 0) / corpus.length,
    },
    testSet: {
      count: opts.pairs.length,
      byCategory: tallyByCategory(opts.pairs),
    },
    metrics,
  };

  // Write the labeled set (AC-2: stable on-disk artifact).
  ensureDir(dirname(opts.labeledSetOutputPath));
  writeFileSync(opts.labeledSetOutputPath, JSON.stringify(opts.pairs, null, 2) + '\n', 'utf8');

  // Write the docs (AC-4).
  ensureDir(dirname(opts.docsOutputPath));
  writeFileSync(opts.docsOutputPath, renderDoc(summary, opts), 'utf8');

  return summary;
};

// --- helpers ----------------------------------------------------------------

const tallyByCategory = (pairs: LabeledPair[]): Record<string, number> => {
  const out: Record<string, number> = {
    confirmed_hit: 0,
    operator_correction: 0,
    should_have_hit: 0,
  };
  for (const p of pairs) {
    out[p.category] = (out[p.category] ?? 0) + 1;
  }
  return out;
};

const ensureDir = (dir: string): void => {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore -- writeFile will surface the real error if any
  }
};

const fmt = (n: number): string => {
  if (Number.isNaN(n)) return 'n/a';
  return n.toFixed(3);
};

const renderDoc = (summary: BenchmarkSummary, opts: RunBenchmarkOptions): string => {
  const out: string[] = [];
  out.push('# Retrieval-quality benchmark for `memory_search`');
  out.push('');
  out.push(
    'This document reports the results of the DAR-1034 retrieval benchmark: a ' +
      'comparison of six retrieval variants against a labeled test set mined ' +
      'from real Claude Code session transcripts. The benchmark does not ' +
      'change the production retrieval path -- acting on the numbers is a ' +
      'separate follow-up issue.',
  );
  out.push('');

  out.push('## Methodology');
  out.push('');
  out.push(
    'The labeled test set is produced by `scripts/mine-transcripts.ts` and ' +
      '`scripts/build-labeled-set.ts`. Mining walks every `.jsonl` transcript ' +
      'under `~/.claude/projects/<project-slug>/` and emits one record per ' +
      '`mcp__commonplace__memory_search` tool call (query, returned names, ' +
      'and surrounding agent / operator follow-up text). Labeling then ' +
      'classifies each record into one of three categories:',
  );
  out.push('');
  out.push(
    '- `confirmed_hit`: the search returned a corpus name as the top result ' +
      'and the agent continued without operator correction. The expected ' +
      'name is the top returned result.',
  );
  out.push(
    "- `operator_correction`: the operator's next turn explicitly named a " +
      "memory in the corpus that was NOT in the search's returned results. " +
      'The expected names are the operator-mentioned filenames.',
  );
  out.push(
    '- `should_have_hit`: the search returned no candidates, but the ' +
      "operator's next turn named a corpus memory that should have been " +
      'found. The expected names are the operator-mentioned filenames.',
  );
  out.push('');
  out.push(
    "Hand-curation is explicitly forbidden by the issue's Notes; the test " +
      'set is the unfiltered output of the mining + labeling pipeline. The ' +
      'achievable pair count is the natural ceiling of the available ' +
      'transcripts -- when it falls below the 30-pair target, this document ' +
      'reports the actual count and explains why (see Test set stats).',
  );
  out.push('');
  out.push('### Metric definitions');
  out.push('');
  out.push(
    '- `Recall@1`: fraction of queries whose any `expected_name` appears in ' +
      'the top-1 ranked candidate. Range `[0, 1]`.',
  );
  out.push('- `Recall@5`: same, but for the top-5. Range `[0, 1]`.');
  out.push(
    '- `MRR` (mean reciprocal rank): mean of `1 / rank-of-first-expected` ' +
      'across queries; queries with no expected name in the ranked list ' +
      'contribute `0`. Range `[0, 1]`.',
  );
  out.push('');

  out.push('## Corpus stats');
  out.push('');
  out.push(`- Memory count: ${summary.corpus.count}`);
  out.push(`- Mean body length: ${summary.corpus.meanBodyLengthChars.toFixed(1)} characters`);
  out.push('');

  out.push('## Test set stats');
  out.push('');
  out.push(`- Pair count: ${summary.testSet.count}`);
  for (const [cat, n] of Object.entries(summary.testSet.byCategory)) {
    out.push(`- ${cat}: ${n}`);
  }
  if (summary.testSet.count < 30) {
    out.push('');
    out.push(
      `The labeled set contains ${summary.testSet.count} pairs, below the ` +
        '30-pair target. This is the natural ceiling of the available ' +
        'transcripts at the time of the benchmark run -- `memory_search` is ' +
        'invoked relatively rarely (a handful of times per session) and the ' +
        'corpus of historical sessions is small. Hand-curation is forbidden ' +
        "by the issue's Notes, so the pair count is reported as-is. Re-" +
        'running the harness against a larger transcript corpus (more ' +
        'sessions, longer time window) will naturally lift the pair count.',
    );
  }
  out.push('');

  out.push('## Results');
  out.push('');
  out.push('| variant | Recall@1 | Recall@5 | MRR | notes |');
  out.push('|---|---|---|---|---|');
  for (const m of summary.metrics) {
    if (m.deferred) {
      out.push(`| ${m.variant} | deferred | deferred | deferred | ${m.deferralReason ?? ''} |`);
    } else {
      const params = paramsToString(m.parameters);
      out.push(
        `| ${m.variant} | ${fmt(m.recall_at_1)} | ${fmt(m.recall_at_5)} | ${fmt(m.mrr)} | ${params} |`,
      );
    }
  }
  out.push('');

  out.push('## Interpretation');
  out.push('');
  out.push(
    'The `cosine-body` row is the current production baseline: it is what ' +
      '`MemoryStore.search` actually does today. All other rows are read ' +
      'relative to it.',
  );
  out.push('');
  const baseline = summary.metrics.find((m) => m.variant === 'cosine-body');
  for (const m of summary.metrics) {
    out.push(`### \`${m.variant}\``);
    out.push('');
    if (m.deferred) {
      out.push(`${VARIANT_DESCRIPTION[m.variant]} Deferred. ${m.deferralReason ?? ''}`);
    } else {
      out.push(interpret(m, baseline));
    }
    out.push('');
  }

  out.push('## Reproducibility');
  out.push('');
  out.push('Re-run the full pipeline with:');
  out.push('');
  out.push('```');
  out.push('pnpm exec tsx scripts/run-retrieval-benchmark.ts');
  out.push('```');
  out.push('');
  out.push(
    'The script reads from `~/.claude/projects` (transcripts) and ' +
      '`~/.commonplace/memory` (user-scope corpus) by default and writes ' +
      'this file plus the labeled set under `docs/`. It does not mutate ' +
      'the `.embedding` sidecars on disk (DAR-1034 AC-5).',
  );
  out.push('');
  out.push(
    `Hybrid weight: \`${opts.hybridWeight ?? 0.5}\` (BM25 weight; cosine ` +
      `weight = \`${1 - (opts.hybridWeight ?? 0.5)}\`).`,
  );
  out.push('');

  return out.join('\n');
};

const paramsToString = (p: Record<string, string | number | boolean>): string => {
  const entries = Object.entries(p);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : String(v)}`).join('; ');
};

/** Per-variant copy describing what the variant does, for the interpretation paragraphs. */
const VARIANT_DESCRIPTION: Record<Variant, string> = {
  'cosine-body': 'cosine similarity over the body embedding -- the production baseline.',
  'cosine-description-plus-body':
    'cosine similarity over an in-memory re-embedding of `description + body`. Tests whether including the description in the embedded text helps retrieval.',
  'cosine-description':
    'cosine similarity over an in-memory re-embedding of the description alone. Tests whether the description on its own is enough signal.',
  bm25: 'lexical BM25 over body tokens. Tests whether exact-word overlap (no embedding model at all) is competitive.',
  'bm25-cosine-hybrid':
    'weighted sum of per-query min-max-normalised BM25 and cosine scores. Tests whether combining lexical and semantic signals dominates either alone.',
  'cross-encoder-rerank':
    'cross-encoder rerank over the top-K cosine candidates. Currently deferred.',
};

const interpret = (m: VariantMetrics, baseline: VariantMetrics | undefined): string => {
  const desc = VARIANT_DESCRIPTION[m.variant];
  if (baseline === undefined || baseline.variant === m.variant) {
    return (
      `${desc} Recall@1 = ${fmt(m.recall_at_1)}, Recall@5 = ${fmt(m.recall_at_5)}, ` +
      `MRR = ${fmt(m.mrr)}. This is the current production retrieval path.`
    );
  }
  const r1Delta = m.recall_at_1 - baseline.recall_at_1;
  const mrrDelta = m.mrr - baseline.mrr;
  const direction = (n: number): string => (n > 0 ? 'higher' : n < 0 ? 'lower' : 'unchanged');
  return (
    `${desc} Recall@1 = ${fmt(m.recall_at_1)} (${direction(r1Delta)} than baseline by ` +
    `${fmt(Math.abs(r1Delta))}), Recall@5 = ${fmt(m.recall_at_5)}, MRR = ` +
    `${fmt(m.mrr)} (${direction(mrrDelta)} by ${fmt(Math.abs(mrrDelta))}). ` +
    `Interpret with the test-set size in mind -- small N means noisy ` +
    `deltas; the headline question is whether this variant clearly ` +
    `dominates the baseline.`
  );
};

// --- CLI --------------------------------------------------------------------

const isCliEntry = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
};

/**
 * Build a corpus name list from `~/.commonplace/memory/` so the labeled-set
 * generator can resolve mentioned memory names (prose form or filename
 * form) into canonical filenames. Reads YAML frontmatter only -- no
 * sidecar I/O, no writes.
 */
const loadCorpusNames = (dir: string): CorpusName[] => {
  const out: CorpusName[] = [];
  for (const ent of readdirSync(dir)) {
    if (!ent.endsWith('.md')) continue;
    const filename = ent.replace(/\.md$/, '');
    let raw = '';
    try {
      raw = readFileSync(join(dir, ent), 'utf8');
    } catch {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    let name = filename;
    if (m !== null) {
      const yaml = m[1] ?? '';
      const nameMatch = /^name:\s*(.+)$/m.exec(yaml);
      if (nameMatch !== null) {
        name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
      }
    }
    out.push({ name, filename });
  }
  return out;
};

const main = async (): Promise<void> => {
  const repoRoot = join(import.meta.url.replace(/^file:\/\//, ''), '..', '..');
  const corpusDir = join(homedir(), '.commonplace', 'memory');
  const transcriptsRoot = process.env.COMMONPLACE_TRANSCRIPTS_ROOT ?? defaultTranscriptsRoot();
  const docsOutputPath = join(repoRoot, 'docs', 'retrieval-benchmark.md');
  const labeledSetOutputPath = join(repoRoot, 'docs', 'retrieval-labeled-set.json');

  // Mine + label.
  const calls = await mineTranscripts({
    root: transcriptsRoot,
    onWarn: (msg) => process.stderr.write(msg + '\n'),
  });
  const corpusNames = loadCorpusNames(corpusDir);
  const pairs = buildLabeledSet({ calls, corpus: corpusNames });

  // Load the production embedder lazily so the test suite (which uses a
  // stub embedder) doesn't pay the transformers.js load cost.
  const { Embedder } = await import('../src/embedder/index.js');
  const embedder = new Embedder('Xenova/bge-base-en-v1.5');

  const summary = await runBenchmark({
    corpusDir,
    pairs,
    embedder,
    docsOutputPath,
    labeledSetOutputPath,
  });

  process.stderr.write(
    `Benchmark complete: corpus=${summary.corpus.count}, pairs=${summary.testSet.count}\n`,
  );
};

if (isCliEntry()) {
  main().catch((err) => {
    process.stderr.write(
      `run-retrieval-benchmark: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
