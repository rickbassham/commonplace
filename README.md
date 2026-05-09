# commonplace

Local-first commonplace book with embedding-backed semantic search via MCP.

## Memory scopes

Commonplace loads up to two memory stores side by side:

- **User store** -- always loaded. Personal rules, preferences, hard
  feedback. Located under `COMMONPLACE_USER_DIR` (defaults to
  `~/.commonplace/memory`).
- **Project store** -- loaded only when a project root is detected.
  Per-project context (architecture notes, repo-specific
  conventions). Located under `COMMONPLACE_PROJECT_DIR`, or under
  `<project-root>/.commonplace/memory` when the root is detected via
  MCP `roots/list` or the current working directory.

Search merges hits across both stores by descending score; each match
carries a `scope: 'user' | 'project'` tag identifying which store
produced it. Save / list / delete / link / unlink all accept an optional
`scope` argument, with sensible defaults documented per tool below.

### Detection priority

The project store is selected by the first matching step in this list:

1. `COMMONPLACE_PROJECT_DIR` env var (explicit override; always wins).
   The path need not exist yet -- the project directory is created
   recursively on the first `memory_save({ scope: 'project' })`.
2. MCP `roots/list` response after init -- if the connected client
   advertises the `roots` capability and returns at least one `file://`
   root, the first such root resolves to `<root>/.commonplace/memory`.
   Non-`file://` roots are skipped. The bin tolerates clients that do
   not advertise the capability and clients whose `roots/list`
   response rejects.
3. `process.cwd()` -- if `<cwd>/.commonplace/memory` already exists on
   disk, that path is used as the project store.
4. None of the above -- user-only mode. The project store is not
   constructed; saves with `scope: 'project'` are rejected with a
   clear error.

### Environment variables

- `COMMONPLACE_USER_DIR` -- user store directory.
  Default: `~/.commonplace/memory`.
- `COMMONPLACE_PROJECT_DIR` -- project store directory. When set, takes
  priority over `roots/list` and cwd detection.
- `COMMONPLACE_MEMORY_DIR` -- **deprecated** alias for
  `COMMONPLACE_USER_DIR`. Honoured for back-compat with v0.1 dogfood
  configs; setting it emits a one-line deprecation warning to stderr
  and the value is used as the user store directory.
- `COMMONPLACE_MODEL` -- embedding model id passed to transformers.js.
  Default: `Xenova/bge-base-en-v1.5`. The model id is not pre-validated
  at boot; an unknown id surfaces an error from the embedder on the
  first `memory_search` (or any other call that needs an embedding).
  The error message names the offending model id.
- `COMMONPLACE_DEFAULT_LIMIT` -- default top-k for `memory_search` when
  the caller omits `limit`. Default: `5`. Must be a positive integer
  when set; any value that is not a positive integer (non-numeric text,
  zero, negative, fractional, `NaN`, `Infinity`) causes the bin to exit
  at boot with a stderr message naming the offending value rather than
  silently coercing.

## Memory format

A memory is a single markdown file with YAML frontmatter, written to a
flat directory (per-scope; see "Memory scopes" above). The frontmatter
carries the baseline shape (`name`, `type`, `description`) plus optional
graph fields:

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

All four core tools accept an optional `scope: 'user' | 'project'`
argument. Responses include the resolved scope so callers can tell user
and project entries apart.

- `memory_search` -- semantic search; merges hits across both stores by
  descending score and slices to `limit`. Returns top-k matches with
  full bodies, scores, outgoing authored relations, a `scope` tag per
  match, and (when `includeSuperseded: true`) `supersededBy`. Optional
  `scope` argument restricts the search to a single store.
- `memory_save` -- persist a memory and its embedding sidecar. The
  `scope` argument selects the destination store (default `user`).
  Saving to `project` requires that a project store was detected at
  boot; otherwise the call is rejected with an error naming the
  missing project scope. The project store directory is created
  recursively on the first project save (`mkdir -p`).
- `memory_list` -- enumerate memories from both stores without bodies.
  Each entry carries a `scope` tag. Optional `scope` argument
  restricts the listing to a single store.
- `memory_delete` -- remove a memory and its sidecar. When the same
  name exists in both stores the `scope` argument is required to
  disambiguate; otherwise it's optional and auto-resolves to whichever
  store contains the name. Returns the resolved scope alongside
  `deleted`.
- `memory_link` / `memory_unlink` -- typed graph edges. Edges are
  intra-scope (a project memory cannot link to a user memory and vice
  versa). The `scope` argument disambiguates when the same `from`
  name lives in both stores.

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
