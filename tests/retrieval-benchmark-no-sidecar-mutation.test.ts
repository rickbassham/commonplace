/**
 * Integration test for AC-5: the benchmark harness must NOT mutate
 * `.embedding` sidecars on disk.
 *
 * Strategy: build a tiny corpus in a temp directory, snapshot every
 * sidecar's bytes and mtime before the benchmark runs, run the
 * benchmark, then assert the same files have the same bytes and the
 * same mtimes. Also assert no NEW `.embedding` files were created for
 * the description-only or description+body variants.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBenchmark } from '../scripts/run-retrieval-benchmark.js';
import { encodeSidecar } from '../src/store/sidecar.js';
import { contentSha } from '../src/store/memory.js';
import { serializeMemory } from '../src/store/memory.js';

let memoryDir: string;
let workDir: string;

/** A 4-d unit vector seeded from `text` so two different bodies produce different vectors. */
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
  workDir = mkdtempSync(join(tmpdir(), 'dar1034-ac5-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  // Seed two memories with valid `.md` + `.embedding` sidecars.
  for (const name of ['alpha_memo', 'beta_memo']) {
    const memory = {
      name,
      type: 'reference' as const,
      description: `${name} description`,
      body: `${name} body text that is unique to ${name}.`,
    };
    writeFileSync(join(memoryDir, `${name}.md`), serializeMemory(memory));
    const vec = fakeVector(memory.body);
    const sidecar = encodeSidecar({
      modelId: 'test/fake-4d',
      dim: vec.length,
      vector: vec,
      contentSha: contentSha(memory),
    });
    writeFileSync(join(memoryDir, `${name}.embedding`), sidecar);
  }
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Take an inventory of every file in `dir` (relative path -> bytes, mtimeNs). */
const inventory = (dir: string): Map<string, { bytes: Buffer; mtimeNs: bigint }> => {
  const out = new Map<string, { bytes: Buffer; mtimeNs: bigint }>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full, { bigint: true });
    out.set(entry, {
      bytes: readFileSync(full),
      mtimeNs: st.mtimeNs,
    });
  }
  return out;
};

describe('runBenchmark (ac-5)', () => {
  it('does not mutate .embedding sidecar bytes or mtimes', async () => {
    const before = inventory(memoryDir);

    const fakeEmbedder = {
      modelId: 'test/fake-4d',
      dim: 4,
      embed: async (text: string) => fakeVector(text),
    };

    // Run the full benchmark against the temp corpus. Hand-build a one-
    // entry labeled set so the benchmark has something to score.
    await runBenchmark({
      corpusDir: memoryDir,
      pairs: [
        {
          query: 'alpha',
          expected_names: ['alpha_memo'],
          category: 'confirmed_hit',
        },
      ],
      embedder: fakeEmbedder,
      docsOutputPath: join(workDir, 'retrieval-benchmark.md'),
      labeledSetOutputPath: join(workDir, 'labeled-set.json'),
    });

    const after = inventory(memoryDir);

    // Same set of files (no new sidecars created for description /
    // description+body variants).
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    // Same bytes AND same mtimes for every file.
    for (const [name, beforeEntry] of before) {
      const afterEntry = after.get(name);
      expect(afterEntry).toBeDefined();
      expect(afterEntry!.bytes.equals(beforeEntry.bytes)).toBe(true);
      expect(afterEntry!.mtimeNs).toBe(beforeEntry.mtimeNs);
    }
  });

  it('does not create new .embedding sidecars for description or description+body variants', async () => {
    const fakeEmbedder = {
      modelId: 'test/fake-4d',
      dim: 4,
      embed: async (text: string) => fakeVector(text),
    };

    const sidecarFilesBefore = readdirSync(memoryDir)
      .filter((f) => f.endsWith('.embedding'))
      .sort();

    await runBenchmark({
      corpusDir: memoryDir,
      pairs: [
        {
          query: 'alpha',
          expected_names: ['alpha_memo'],
          category: 'confirmed_hit',
        },
      ],
      embedder: fakeEmbedder,
      docsOutputPath: join(workDir, 'retrieval-benchmark.md'),
      labeledSetOutputPath: join(workDir, 'labeled-set.json'),
    });

    const sidecarFilesAfter = readdirSync(memoryDir)
      .filter((f) => f.endsWith('.embedding'))
      .sort();
    expect(sidecarFilesAfter).toEqual(sidecarFilesBefore);
  });
});
