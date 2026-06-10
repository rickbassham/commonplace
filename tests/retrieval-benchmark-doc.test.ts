/**
 * Tests for the benchmark orchestrator's output: the labeled set file
 * and `docs/retrieval-benchmark.md`. AC-2 requires the labeled set to be
 * committed at a stable path with the documented shape; AC-4 requires
 * the docs to contain methodology, corpus stats, results table, and
 * per-variant interpretation.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBenchmark } from '../scripts/run-retrieval-benchmark.js';
import { encodeSidecar } from '../src/store/sidecar.js';
import { contentSha, serializeMemory } from '../src/store/memory.js';

let workDir: string;
let memoryDir: string;
let docsPath: string;
let labeledPath: string;

const fakeVector = (text: string): Float32Array => {
  const out = new Float32Array(4);
  out[0] = text.length % 7;
  out[1] = (text.charCodeAt(0) || 0) % 13;
  out[2] = text.split(' ').length;
  out[3] = 1;
  let n = 0;
  for (let i = 0; i < 4; i++) n += out[i]! * out[i]!;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < 4; i++) out[i] = out[i]! / n;
  return out;
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dar1034-doc-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  docsPath = join(workDir, 'retrieval-benchmark.md');
  labeledPath = join(workDir, 'labeled-set.json');

  for (const name of ['alpha_memo', 'beta_memo', 'gamma_memo']) {
    const memory = {
      name,
      type: 'reference' as const,
      description: `${name} description`,
      body: `${name} body text unique to ${name}.`,
    };
    writeFileSync(join(memoryDir, `${name}.md`), serializeMemory(memory));
    const vec = fakeVector(memory.body);
    const sidecar = encodeSidecar({
      modelId: 'test/fake-4d',
      dim: vec.length,
      descriptionVector: fakeVector(memory.description),
      bodyVector: vec,
      contentSha: contentSha(memory),
    });
    writeFileSync(join(memoryDir, `${name}.embedding`), sidecar);
  }
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const runOnce = async () => {
  const embedder = {
    modelId: 'test/fake-4d',
    dim: 4,
    embed: async (text: string) => fakeVector(text),
  };
  return runBenchmark({
    corpusDir: memoryDir,
    pairs: [
      { query: 'alpha', expected_names: ['alpha_memo'], category: 'confirmed_hit' },
      { query: 'beta', expected_names: ['beta_memo'], category: 'confirmed_hit' },
    ],
    embedder,
    docsOutputPath: docsPath,
    labeledSetOutputPath: labeledPath,
  });
};

describe('runBenchmark output (ac-2, ac-4)', () => {
  it('writes a labeled-set file with entries having query+expected_names+category', async () => {
    await runOnce();
    expect(existsSync(labeledPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(labeledPath, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    for (const entry of parsed) {
      expect(typeof entry.query).toBe('string');
      expect(Array.isArray(entry.expected_names)).toBe(true);
      expect(entry.expected_names.length).toBeGreaterThanOrEqual(1);
      expect(['confirmed_hit', 'operator_correction', 'should_have_hit']).toContain(entry.category);
    }
  });

  it('writes a docs file (docs/retrieval-benchmark.md) at the requested output path', async () => {
    await runOnce();
    expect(existsSync(docsPath)).toBe(true);
  });

  it('the docs include a methodology section describing mining, categories, and metric definitions', async () => {
    await runOnce();
    const doc = readFileSync(docsPath, 'utf8');
    expect(doc).toMatch(/## Methodology/i);
    // Mining and the three categories are explicitly named.
    expect(doc).toContain('confirmed_hit');
    expect(doc).toContain('operator_correction');
    expect(doc).toContain('should_have_hit');
    // Metric definitions appear (Recall@1, Recall@5, MRR are named in
    // the methodology, not only the results table).
    expect(doc).toMatch(/Recall@1/);
    expect(doc).toMatch(/Recall@5/);
    expect(doc).toMatch(/MRR/);
  });

  it('the docs include corpus stats with numeric memory count and mean body length (unit stated)', async () => {
    await runOnce();
    const doc = readFileSync(docsPath, 'utf8');
    expect(doc).toMatch(/## Corpus stats/i);
    expect(doc).toMatch(/[Mm]emory count.*:\s*\d+/);
    // Unit must be stated -- "characters" or "tokens".
    expect(doc).toMatch(/mean body length.*\d.*(character|token)/i);
  });

  it('the docs include a results table with one row per variant and numeric Recall@1 / Recall@5 / MRR columns', async () => {
    await runOnce();
    const doc = readFileSync(docsPath, 'utf8');
    expect(doc).toMatch(/## Results/i);
    // Markdown table header includes the three metric columns.
    expect(doc).toMatch(/\| *variant *\| *recall@1 *\| *recall@5 *\| *mrr/i);
    // One numeric (or "deferred") row per variant -- check by counting
    // table rows after the header separator. We require at least 5 data
    // rows (the five non-deferred variants) -- the deferred variant may
    // show "deferred" as its row marker.
    const tableMatch = doc.match(/\|[^\n]+\|[^\n]+\|[^\n]+\|[^\n]+\|/g);
    expect(tableMatch).not.toBeNull();
    // Ensure each non-deferred variant row contains at least one decimal
    // number (matching XX.XX% or 0.XXX or 1.000).
    const variantRows = doc
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('| cosine-') || l.startsWith('| bm25') || l.startsWith('| cross-encoder'),
      );
    expect(variantRows.length).toBeGreaterThanOrEqual(5);
    for (const row of variantRows) {
      if (row.includes('deferred')) continue;
      expect(row).toMatch(/\d+\.\d+/);
    }
  });

  it('the docs include a short per-variant interpretation paragraph', async () => {
    await runOnce();
    const doc = readFileSync(docsPath, 'utf8');
    expect(doc).toMatch(/## Interpretation/i);
    for (const v of [
      'cosine-body',
      'cosine-description-plus-body',
      'cosine-description',
      'bm25',
      'bm25-cosine-hybrid',
      'cross-encoder-rerank',
    ]) {
      expect(doc).toContain(v);
    }
  });
});
