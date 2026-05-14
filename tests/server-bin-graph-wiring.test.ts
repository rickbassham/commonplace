/**
 * Unit-level assertion: the boot module constructs a `MemoryGraph`,
 * passes it to `MemoryStore({ dir, embedder, graph })`, and passes it
 * to `createDefaultHandlers({ ..., graph })`.
 *
 * We assert structurally on the source text. The end-to-end behavioural
 * proof that the graph is actually wired (i.e. populated by save/scan and
 * available to link/unlink) lives in `server-bin-link.integration.test.ts`.
 *
 * The wiring lives in `src/bin/boot.ts` (the bin itself reduces to a thin
 * shell that delegates to `bootServer`).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const bootSource = readFileSync(join(repoRoot, 'src/bin/boot.ts'), 'utf8');

describe('boot module instantiates MemoryGraph and wires it everywhere', () => {
  it('src/bin/boot.ts constructs a MemoryGraph instance and passes it to new MemoryStore({dir, embedder, graph}) and to createDefaultHandlers({..., graph})', () => {
    // Imports MemoryGraph.
    expect(bootSource).toMatch(
      /import\s+\{[^}]*MemoryGraph[^}]*\}\s+from\s+['"]\.\.\/store\/graph/,
    );

    // Constructs at least one graph instance.
    expect(bootSource).toMatch(/new\s+MemoryGraph\b/);

    // Passes graph to MemoryStore.
    expect(bootSource).toMatch(/new\s+MemoryStore\s*\(\s*\{[^}]*\bgraph\b[^}]*\}/s);

    // Passes graph to createDefaultHandlers.
    expect(bootSource).toMatch(/createDefaultHandlers\s*\(\s*\{[^}]*\bgraph\b[^}]*\}/s);
  });
});
