/**
 * Child-process worker used by the DAR-923 multi-process stress + crash tests
 * (ac-5, ac-6, ac-7). The worker constructs a MemoryStore with a stub
 * embedder (so child processes do not load transformers.js) and performs
 * one of three modes driven by argv:
 *
 *   save-many <dir> <prefix> <count> -- save <count> distinct memories
 *     named `<prefix>_<i>` (i = 0..count-1). Used by ac-5 to validate the
 *     4x50 concurrent stress run. Exits 0 on full success.
 *   save-name <dir> <name>           -- save a single memory by name. Used
 *     by ac-6 to verify exactly one of two racers wins. Exits 0 on success
 *     or 1 with a diagnostic message if the save fails (the test reads
 *     stderr to confirm the loser got an "already exists" / lock-busy
 *     error).
 *   slow-save <dir> <name> <delay_ms> -- save a single memory but block
 *     inside the embed() stub for <delay_ms> milliseconds. Used by ac-7 to
 *     create a deterministic mid-write window for SIGKILL.
 *
 * No transformers.js, no MCP, no console noise on success. The worker is
 * intentionally tiny so each child boot is sub-second.
 */

import { MemoryStore } from '../../src/store/memory-store.js';
import type { Memory } from '../../src/store/memory.js';

const makeStubEmbedder = (
  delayMs = 0,
): {
  modelId: string;
  dim: number;
  embed: (text: string) => Promise<Float32Array>;
} => {
  const dim = 4;
  return {
    modelId: 'stub/test-model',
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const out = new Float32Array(dim);
      // Cheap deterministic vector: byte sum modulated, rest zero. Good
      // enough for parity assertions in ac-5.
      let s = 0;
      for (let i = 0; i < text.length; i++) s = (s + text.charCodeAt(i)) % 1000;
      out[0] = s / 1000;
      out[1] = text.length / 1000;
      return out;
    },
  };
};

const makeMemory = (name: string): Memory => ({
  name,
  description: `desc-${name}`,
  type: 'reference',
  body: `body content for ${name}`,
});

const main = async (): Promise<void> => {
  const [, , mode, ...rest] = process.argv;

  if (mode === 'save-many') {
    const [dir, prefix, countStr] = rest;
    if (!dir || !prefix || !countStr) {
      throw new Error('save-many requires <dir> <prefix> <count>');
    }
    const count = Number(countStr);
    const store = new MemoryStore({ dir, embedder: makeStubEmbedder() });
    // Saves are serial within a single child to avoid lock contention
    // against ourselves; the test orchestrates parallelism across children.
    for (let i = 0; i < count; i++) {
      await store.save(makeMemory(`${prefix}_${i}`));
    }
    return;
  }

  if (mode === 'save-name') {
    const [dir, name] = rest;
    if (!dir || !name) throw new Error('save-name requires <dir> <name>');
    const store = new MemoryStore({ dir, embedder: makeStubEmbedder() });
    await store.save(makeMemory(name));
    return;
  }

  if (mode === 'slow-save') {
    const [dir, name, delayStr] = rest;
    if (!dir || !name || !delayStr) {
      throw new Error('slow-save requires <dir> <name> <delay_ms>');
    }
    const store = new MemoryStore({
      dir,
      embedder: makeStubEmbedder(Number(delayStr)),
    });
    // Print "ready" to stdout so the test can wait for the child to be
    // poised mid-embed before SIGKILL'ing.
    process.stdout.write('ready\n');
    await store.save(makeMemory(name));
    return;
  }

  throw new Error(`unknown mode: ${String(mode)}`);
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`worker error: ${msg}\n`);
  process.exit(1);
});
