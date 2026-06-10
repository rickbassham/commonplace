/**
 * Load a memory corpus from disk into the {@link BenchmarkCorpusEntry}
 * shape the benchmark consumes. Reads `.md` files + their `.embedding`
 * sidecars; the sidecar bytes provide the body vector. Strictly read-
 * only -- never writes back to disk (AC-5).
 *
 * If a `.md` file has no matching `.embedding` sidecar, the entry is
 * still loaded but `bodyVector` is left as `null`; the benchmark caller
 * is responsible for re-embedding in memory if it wants the cosine-body
 * variant to score that entry.
 *
 * When `expectedModelId` is given, cached sidecar vectors are only
 * reused if the sidecar was produced by that embedder model; a mismatch
 * leaves both channels unset so the caller re-embeds with the benchmark
 * embedder instead of silently mixing vectors from different models.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchmarkCorpusEntry } from './retrieval-variants.js';
import { decodeSidecar } from '../src/store/sidecar.js';
import { readMemory } from '../src/store/memory.js';

/** Read corpus from disk. Read-only -- never mutates the directory. */
export const loadCorpus = (dir: string, expectedModelId?: string): BenchmarkCorpusEntry[] => {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const out: BenchmarkCorpusEntry[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const filename = entry.replace(/\.md$/, '');
    const mdPath = join(dir, entry);
    let memory;
    try {
      memory = readMemory(mdPath);
    } catch {
      continue; // Skip malformed memories rather than aborting the whole load.
    }
    let bodyVector: Float32Array | null = null;
    let descVector: Float32Array | undefined;
    const sidecarPath = mdPath.replace(/\.md$/, '.embedding');
    try {
      const sidecar = decodeSidecar(readFileSync(sidecarPath));
      if (expectedModelId === undefined || sidecar.modelId === expectedModelId) {
        bodyVector = sidecar.bodyVector;
        descVector = sidecar.descriptionVector;
      }
      // else: sidecar was embedded by a different model -- leave both
      // channels unset so the benchmark embedder re-embeds them.
    } catch {
      // Missing, corrupt, or old-format (v0x01) sidecar -- leave both
      // channels unset. The orchestrator will re-embed in memory.
      bodyVector = null;
      descVector = undefined;
    }
    out.push({
      filename,
      name: memory.name,
      description: memory.description,
      body: memory.body,
      bodyVector,
      ...(descVector === undefined ? {} : { descVector }),
    });
  }
  return out;
};
