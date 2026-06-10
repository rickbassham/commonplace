/**
 * Tests for `scripts/load-corpus.ts`'s sidecar-vector reuse guard: cached
 * channel vectors are only reused when the sidecar was produced by the
 * same embedder model the benchmark is configured with. A mismatched
 * modelId leaves both channels unset so `buildBenchmarkInputs` re-embeds
 * with the benchmark embedder instead of silently mixing models.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCorpus } from '../scripts/load-corpus.js';
import { encodeSidecar } from '../src/store/sidecar.js';
import { contentSha, serializeMemory } from '../src/store/memory.js';

let memoryDir: string;
let workDir: string;

const descVec = new Float32Array([1, 0, 0, 0]);
const bodyVec = new Float32Array([0, 1, 0, 0]);

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dar1210-load-corpus-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  const memory = {
    name: 'alpha_memo',
    type: 'reference' as const,
    description: 'alpha description',
    body: 'alpha body text.',
  };
  writeFileSync(join(memoryDir, 'alpha_memo.md'), serializeMemory(memory));
  writeFileSync(
    join(memoryDir, 'alpha_memo.embedding'),
    encodeSidecar({
      modelId: 'test/fake-4d',
      dim: 4,
      descriptionVector: descVec,
      bodyVector: bodyVec,
      contentSha: contentSha(memory),
    }),
  );
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('loadCorpus sidecar modelId guard', () => {
  it('reuses both channel vectors when expectedModelId matches the sidecar', () => {
    const corpus = loadCorpus(memoryDir, 'test/fake-4d');
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.bodyVector).toEqual(bodyVec);
    expect(corpus[0]!.descVector).toEqual(descVec);
  });

  it('discards both channel vectors when expectedModelId differs from the sidecar', () => {
    const corpus = loadCorpus(memoryDir, 'other/model');
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.bodyVector).toBeNull();
    expect(corpus[0]!.descVector).toBeUndefined();
  });

  it('reuses cached vectors when no expectedModelId is given (legacy behavior)', () => {
    const corpus = loadCorpus(memoryDir);
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.bodyVector).toEqual(bodyVec);
    expect(corpus[0]!.descVector).toEqual(descVec);
  });
});
