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
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchmarkCorpusEntry } from './retrieval-variants.js';
import { decodeSidecar } from '../src/store/sidecar.js';
import { readMemory } from '../src/store/memory.js';

/** Read corpus from disk. Read-only -- never mutates the directory. */
export const loadCorpus = (dir: string): BenchmarkCorpusEntry[] => {
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
    const sidecarPath = mdPath.replace(/\.md$/, '.embedding');
    try {
      const sidecar = decodeSidecar(readFileSync(sidecarPath));
      bodyVector = sidecar.vector;
    } catch {
      // Missing or corrupt sidecar -- leave bodyVector null. The
      // orchestrator will re-embed in memory.
      bodyVector = null;
    }
    out.push({
      filename,
      name: memory.name,
      description: memory.description,
      body: memory.body,
      bodyVector,
    });
  }
  return out;
};
