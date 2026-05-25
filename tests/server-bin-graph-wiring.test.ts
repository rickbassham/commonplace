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

/**
 * Regression guard for the DAR-1144 verification gap: every
 * `createDefaultHandlers` call in `src/bin/boot.ts` must thread the
 * env-resolved hierarchical-expansion knobs (`hierarchicalParentDecay`
 * and `siblingCollapseThreshold`). When the initial implementation
 * only wired the bootstrap-rebind call site, the request-path handler
 * silently fell back to defaults and `COMMONPLACE_HIERARCHICAL_PARENT_DECAY`
 * / `COMMONPLACE_SIBLING_COLLAPSE_THRESHOLD` had no effect on normal
 * `memory_search` requests. This test asserts that none of the three
 * call sites can re-introduce the same hole.
 */
describe('boot module threads hierarchical env knobs through every createDefaultHandlers call', () => {
  // Find all `createDefaultHandlers({...})` blocks. We match the literal
  // call followed by an object literal, balanced over a single level of
  // braces (boot.ts does not nest object literals inside these calls).
  const callRe = /createDefaultHandlers\s*\(\s*\{[\s\S]*?\}\s*\)/g;
  const calls = bootSource.match(callRe) ?? [];

  it('boot.ts contains at least three createDefaultHandlers call sites (initial wiring, post-roots rewire, bootstrap rebind)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it.each(['hierarchicalParentDecay', 'siblingCollapseThreshold'])(
    'every createDefaultHandlers call site passes %s',
    (field) => {
      const missing = calls.filter((call) => !new RegExp(`\\b${field}\\b`).test(call));
      expect(missing, `Call sites missing ${field}:\n${missing.join('\n---\n')}`).toEqual([]);
    },
  );
});
