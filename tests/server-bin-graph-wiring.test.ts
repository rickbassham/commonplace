/**
 * DAR-928 ac-5 unit-level assertion: the bin entry constructs a
 * `MemoryGraph`, passes it to `MemoryStore({ dir, embedder, graph })`, and
 * passes it to `createDefaultHandlers({ store, graph })`.
 *
 * We assert structurally on the source text. The end-to-end behavioural
 * proof that the graph is actually wired (i.e. populated by save/scan and
 * available to link/unlink) lives in `server-bin-link.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const binSource = readFileSync(join(repoRoot, 'src/bin/commonplace-mcp.ts'), 'utf8');

describe('DAR-928 ac-5: bin instantiates MemoryGraph and wires it everywhere', () => {
  it('src/bin/commonplace-mcp.ts constructs a MemoryGraph instance and passes it to new MemoryStore({dir, embedder, graph}) and to createDefaultHandlers({store, graph})', () => {
    // Imports MemoryGraph.
    expect(binSource).toMatch(/import\s+\{[^}]*MemoryGraph[^}]*\}\s+from\s+['"]\.\.\/store\/graph/);

    // Constructs a graph instance.
    expect(binSource).toMatch(/new\s+MemoryGraph\b/);

    // Passes graph to MemoryStore.
    expect(binSource).toMatch(/new\s+MemoryStore\s*\(\s*\{[^}]*\bgraph\b[^}]*\}/s);

    // Passes graph to createDefaultHandlers.
    expect(binSource).toMatch(/createDefaultHandlers\s*\(\s*\{[^}]*\bgraph\b[^}]*\}/s);
  });
});
