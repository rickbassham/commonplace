# commonplace

Local-first commonplace book with embedding-backed semantic search via MCP.

## Memory format

A memory is a single markdown file with YAML frontmatter, written to a
flat directory (default `~/.commonplace/memory`). The frontmatter carries
the baseline shape (`name`, `type`, `description`) plus optional graph
fields:

```yaml
---
name: feedback_scope
description: Don't shrink scope unilaterally
type: feedback
relations: # optional, defaults to []
  - to: scope_handshake
    type: builds-on
supersedes: # optional, defaults to []
  - feedback_scope_old
---
<body>
```

`type` is one of `user | feedback | project | reference`.

`relations[].type` is one of `related-to | builds-on | contradicts |
child-of`.

For the binary embedding sidecar layout see [docs/sidecar-format.md](docs/sidecar-format.md).

## Supersede semantics

The `supersedes:` frontmatter field on a memory is a list of names of
prior memories that this memory replaces. Use it when you rewrite or
correct an earlier memory and want the older entry to stop showing up
in search results.

### Default behaviour: superseded memories are hidden

Both `memory_search` and `memory_list` exclude superseded memories from
their results by default. A memory is "superseded" iff some other loaded
memory has its name in its `supersedes:` list.

For example, given two memories on disk:

```yaml
# memory_a.md
---
name: memory_a
description: First take
type: reference
---
Original notes.
```

```yaml
# memory_b.md
---
name: memory_b
description: Revised take
type: reference
supersedes:
  - memory_a
---
Updated notes that replace memory_a.
```

A default `memory_search` call returns `memory_b` but NOT `memory_a`.
The `totalScanned` field on the search response reports `1`, not `2` --
the effective corpus size after the supersede filter runs. `memory_list`
behaves the same way: `memory_a` does not appear.

The original `.md` and `.embedding` files for `memory_a` are NOT deleted.
The supersede flag is purely a filter applied at read time.

### Opt-in: bring superseded memories back

Both tools accept an optional `includeSuperseded: true` flag. When set,
the superseded memory is included in results, and (for `memory_search`)
its match payload carries an extra `supersededBy: <name>` field naming
the superseding memory. Continuing the example above:

```jsonc
// memory_search { query: "...", includeSuperseded: true }
{
  "matches": [
    { "name": "memory_b", "type": "reference", "...": "...", "relations": [] },
    {
      "name": "memory_a",
      "type": "reference",
      "...": "...",
      "relations": [],
      "supersededBy": "memory_b",
    },
  ],
  "query": "...",
  "totalScanned": 2,
}
```

`supersededBy` is omitted (key absent, not `undefined`) on memories that
are NOT superseded -- so callers can use `'supersededBy' in match` as the
predicate.

### Out of scope (v0.1)

- Transitive supersede chains (if C supersedes B and B supersedes A, A
  is excluded only because B has it in its list -- not because C
  transitively replaces it).
- Cycle detection across supersede edges.
- Surfacing `mentions` edges in `memory_search` results. The four
  authored relation types (`related-to`, `builds-on`, `contradicts`,
  `child-of`) are surfaced on each match's `relations` array; body
  `[[name]]` mentions are tracked in the graph but not exposed via the
  search response in v0.1.

## Tools

- `memory_search` -- semantic search; returns top-k matches with full
  bodies, scores, outgoing authored relations, and (when
  `includeSuperseded: true`) `supersededBy`.
- `memory_save` -- persist a memory and its embedding sidecar.
- `memory_list` -- enumerate memories without bodies.
- `memory_delete` -- remove a memory and its sidecar.

## Running

After `make build`:

```sh
node dist/bin/commonplace-mcp.js
```

Or via Claude Code:

```sh
claude mcp add commonplace ./dist/bin/commonplace-mcp.js
```

## Development

- `make test` -- full vitest suite (unit + integration).
- `make typecheck` -- `tsc --noEmit`.
- `make lint` -- ESLint over the repo.
- `make build` -- produces `dist/`.
- `make format` / `make format-check` -- Prettier.

`pnpm` is the only supported package manager.
