#!/usr/bin/env node
/**
 * Regenerate the DAR-933 fixture corpus snapshot files
 * (`tests/fixtures/graph/<case>.mermaid` and `.dot`) from the spec JSONs
 * in the same directory. Run once at fixture-add time; in CI the snapshot
 * tests compare against these committed files.
 *
 * Imports the live TypeScript sources via `tsx` -- no `make build` is
 * required before running. (Earlier revisions imported from `dist/`,
 * which silently broke when the build was stale; see DAR-933 review f-3.)
 *
 * Usage: pnpm exec tsx scripts/dar933-generate-fixtures.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryGraph } from '../src/store/graph.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { createMemoryGraphHandler } from '../src/server/handlers.ts';
import { renderMermaid, renderDot } from '../src/cli/graph.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '..', 'tests', 'fixtures', 'graph');

const makeStubEmbedder = () => {
  let count = 0;
  return {
    modelId: 'Xenova/bge-base-en-v1.5',
    dim: 4,
    embed: async (text) => {
      count += 1;
      const out = new Float32Array(4);
      out[0] = count;
      for (let i = 1; i < 4; i++) out[i] = (i + (text.length % 7)) / 10;
      return out;
    },
  };
};

const renderFor = async (spec) => {
  const tmp = mkdtempSync(join(tmpdir(), 'dar933-gen-'));
  try {
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    for (const m of spec.memories) {
      await store.save({
        name: m.name,
        type: m.type ?? 'reference',
        description: m.description ?? m.name,
        body: m.body ?? `${m.name} body`,
        relations: m.relations ?? [],
        supersedes: m.supersedes ?? [],
      });
    }
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const args = { name: spec.root };
    if (spec.depth !== undefined) args.depth = spec.depth;
    if (spec.direction !== undefined) args.direction = spec.direction;
    if (spec.types !== undefined) args.types = spec.types;
    const result = await handler(args);
    return { mermaid: renderMermaid(result), dot: renderDot(result) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

const main = async () => {
  const cases = readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
  for (const c of cases) {
    const spec = JSON.parse(readFileSync(join(fixtureDir, `${c}.json`), 'utf8'));
    const { mermaid, dot } = await renderFor(spec);
    writeFileSync(join(fixtureDir, `${c}.mermaid`), mermaid);
    writeFileSync(join(fixtureDir, `${c}.dot`), dot);
    console.log(`generated ${c}.mermaid, ${c}.dot`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
