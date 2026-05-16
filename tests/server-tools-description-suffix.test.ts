/**
 * Verbatim-suffix test for DAR-965 ac-3.
 *
 * Asserts that the text following the `Agent memory: ` prefix is
 * byte-equal to the pre-refactor mechanical description for each of the
 * eight registered tools. The frozen table here is the source of truth
 * for the un-prefixed text; if the mechanical description legitimately
 * changes in a future ticket, that ticket updates this table.
 */

import { describe, expect, it } from 'vitest';

import { buildToolDefinitions, type ToolName } from '../src/server/tools.js';

const AGENT_MEMORY_PREFIX = 'Agent memory: ';

/**
 * Pre-refactor mechanical descriptions, frozen here so the ac-3 suffix
 * invariant can be asserted byte-for-byte. Sourced from the
 * `TOOL_SCHEMAS` table in `src/server/tools.ts` at the commit immediately
 * prior to the DAR-965 prefix change.
 */
const ORIGINAL_DESCRIPTIONS: Record<ToolName, string> = {
  memory_search:
    'Semantic search over saved memories across both the user and project stores (when the project store is present). Returns the top-k matches by cosine similarity against the embedding index, merged across stores by descending score; each match carries a `scope` tag identifying which store produced it. By default, memories that have been superseded by another entry are excluded from results.',
  memory_save:
    'Save a memory as a markdown file with YAML frontmatter and a derived embedding sidecar. Refuses to overwrite an existing entry; the contract is delete + save. The required `scope` argument selects which store to write to; saving to `project` requires that a project store was detected at boot.',
  memory_list:
    'List saved memories from both stores. Returns frontmatter-only entries (name, type, description, scope) -- no body. Each entry carries a `scope` tag (`user` | `project`) identifying which store it came from. By default, memories that have been superseded by another entry within their own store are excluded from results.',
  memory_delete:
    'Delete a saved memory by name. The `scope` argument is required to disambiguate when the same name exists in both stores; otherwise the lookup automatically resolves to whichever store contains the name. Throws when the name is not present in the targeted scope.',
  memory_link:
    "Append a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. Default `type` is `related-to`; passing `supersedes` routes the edge into the source's `supersedes[]` list instead of `relations[]`. Refuses self-edges, missing targets, and duplicate (to, type) edges. Edges are intra-scope: `from` and `to` must live in the same store.",
  memory_unlink:
    "Remove a typed graph edge from one saved memory to another. The source memory's frontmatter is rewritten atomically. When `type` is omitted, removes ALL edges from -> to regardless of type. No-op (with note) when the requested edge does not exist.",
  memory_graph:
    'Return the local graph neighborhood of a saved memory. Walks the in-memory graph BFS-style from `name` to `depth` hops, gated by `direction` (outbound / inbound / both) and `types` (which edge labels to follow). Cycles are visited-set safe -- each reachable memory appears once in `nodes`. Default `types` covers the four authored relation types plus `supersedes` (omits body `mentions` edges unless requested explicitly). Default `depth` is 1 and default `direction` is `both`.',
  memory_path:
    "Return the shortest directed path between two saved memories using BFS over the in-memory graph. Follows outbound edges from each node. Returns `{ path: [] }` when `from === to` (the empty-edge self-path); `{ path: null, reason: 'unreachable' }` when no path exists; or `{ path: null, reason: 'depth-exceeded' }` when a path exists but its shortest length is greater than `maxDepth`. Default `maxDepth` is 5. Pass `types` to restrict which edge labels the search may traverse (default: all edge types).",
  memory_bootstrap_project_store:
    "Bootstrap a project-scope memory store on the running MCP connection. Use this after `memory_save` with `scope: 'project'` returns a `NO_PROJECT_STORE` error: confirm with the user that they want a project store created, then call this tool with `{ userConfirmed: true }`. The tool re-runs project-root detection (upward walk for `.git/` or `.commonplace/`, stopping at `$HOME` exclusive), creates `<root>/.commonplace/memory` if missing, and re-binds the server's handler map so subsequent project-scope saves succeed on the same connection. Pass an explicit `path` to override detection for a markerless directory; the path must not be `$HOME` or an ancestor of it. The handler rejects calls where `userConfirmed` is not strictly `true` (no truthy coercion).",
};

describe('ac-3: verbatim-suffix preservation', () => {
  it('for each tool, the description text after the `Agent memory: ` prefix is byte-equal to the pre-refactor mechanical description', () => {
    const defs = buildToolDefinitions();
    for (const def of defs) {
      const expectedSuffix = ORIGINAL_DESCRIPTIONS[def.name];
      expect(
        def.description.startsWith(AGENT_MEMORY_PREFIX),
        `tool ${def.name} description must start with prefix`,
      ).toBe(true);
      const observedSuffix = def.description.slice(AGENT_MEMORY_PREFIX.length);
      expect(observedSuffix).toBe(expectedSuffix);
    }
  });
});
