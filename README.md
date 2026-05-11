# commonplace

Commonplace is a commonplace book for your agent: a local-first store of
markdown notes, each paired with a sidecar embeddings file, served to
Claude Code (or any MCP client) over stdio. There is no database --
notes live as `.md` files on disk, embeddings live next to them as
`.embedding` sidecars, and search is in-memory cosine similarity over
those sidecars.

A commonplace book, historically, is a curated personal collection of
quotes, rules, and observations -- a notebook organised by topic so that
the keeper can return to what they have learned. John Locke wrote a
treatise on the practice (his 1706 essay "A New Method of Making
Common-Place-Books") describing an indexing scheme that let him locate
any earlier entry in seconds. This project applies the same idea to an
agent's working memory: short, named, typed entries that the agent can
write once and recall later by meaning rather than keyword.

## Install

```sh
npm i -g commonplace-mcp
```

```sh
claude mcp add commonplace commonplace-mcp
```

The first command installs the `commonplace-mcp` binary globally. The
second registers it with Claude Code as an MCP server named
`commonplace`. After both commands complete, restart any running Claude
Code sessions and the four memory tools become available.

## Memory types

Memories carry a `type` field selected from the four-element taxonomy
`user | feedback | project | reference`:

- `user` -- personal rules, preferences, and identity facts about the
  human operating the agent.
- `feedback` -- corrections and lessons learned from prior agent
  behaviour; persistent course-corrections.
- `project` -- per-project context like architecture notes, repo
  conventions, and decisions that bind only to one codebase.
- `reference` -- durable, neutral knowledge: API shapes, formulas,
  citations, anything you want to look up by meaning later.

The same four types are accepted by every tool's `type` argument and
filter.

## Tool reference

All four tools accept an optional `scope: 'user' | 'project'` argument
that selects which store to read from or write to. When `scope` is
omitted, reads merge across both stores and writes default to `user`.

### memory_save

Save a memory as a markdown file with YAML frontmatter and a derived
embedding sidecar. Refuses to overwrite an existing entry; the contract
is delete + save.

Input schema:

| Argument      | Type                                       | Required | Description                                                                                                |
| ------------- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `name`        | string                                     | required | Memory name. Must match `^[a-z0-9_]+$`. Becomes the filename stem.                                         |
| `type`        | `user \| feedback \| project \| reference` | required | One of the four memory types described above.                                                              |
| `description` | string                                     | required | Short human description carried in frontmatter.                                                            |
| `body`        | string                                     | required | Markdown body content.                                                                                     |
| `scope`       | `user` or `project`                        | optional | Which store to write to. Defaults to `user`. `project` requires that a project store was detected at boot. |

Example call:

```jsonc
// memory_save
{
  "name": "feedback_scope",
  "type": "feedback",
  "description": "Don't shrink scope unilaterally",
  "body": "When in doubt about scope, surface it before narrowing.",
  "scope": "user",
}
```

### memory_search

Semantic search over saved memories across both the user and project
stores (when both are present). Returns the top-k matches by cosine
similarity, merged across stores by descending score; each match carries
a `scope` tag identifying which store produced it. By default,
superseded memories are excluded.

Input schema:

| Argument            | Type                                       | Required | Description                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`             | string                                     | required | Natural-language search query.                                                                                                                                                                                                                          |
| `limit`             | integer                                    | optional | Maximum number of results after merging across stores. The default is configurable via the `COMMONPLACE_DEFAULT_LIMIT` env var documented below (default `5`).                                                                                          |
| `type`              | `user \| feedback \| project \| reference` | optional | Restrict results to memories of this type.                                                                                                                                                                                                              |
| `threshold`         | number                                     | optional | Minimum cosine similarity for an entry to appear. Cosine range is `[-1, 1]`.                                                                                                                                                                            |
| `includeSuperseded` | boolean                                    | optional | When `true`, include memories that have been superseded. Superseded matches carry a `supersededBy` field. Defaults to `false`.                                                                                                                          |
| `scope`             | `user` or `project`                        | optional | Restrict the search to a single store. Default: search both stores when the project store is present.                                                                                                                                                   |
| `expand`            | `none` or `one-hop`                        | optional | One-hop graph expansion mode. `none` (default) returns only direct cosine hits. `one-hop` walks outbound edges from each direct hit and adds neighbors to the response. Expanded entries carry a `via: { source, edge }` field; direct hits omit `via`. |
| `expandTypes`       | array of edge-type strings                 | optional | Edge types to follow when `expand: 'one-hop'`. Allowed values: `related-to`, `builds-on`, `contradicts`, `child-of`, `supersedes`, `mentions`. Defaults to `['builds-on', 'related-to']`.                                                               |
| `expandLimit`       | integer                                    | optional | Maximum number of neighbors added per direct hit during one-hop expansion. Defaults to `2`. Set to `0` to opt out of neighbor inclusion.                                                                                                                |

Example call:

```jsonc
// memory_search
{
  "query": "scope handshake",
  "limit": 3,
  "type": "feedback",
  "includeSuperseded": false,
}
```

### One-hop expansion semantics

When called with `expand: 'one-hop'`, `memory_search` augments the direct
cosine hits with their outbound graph neighbors. Each expanded entry
carries an additional `via` field:

```jsonc
{
  "name": "neighbor_name",
  // ...usual match fields (type, description, body, score, relations, scope)...
  "via": {
    "source": "direct_hit_name", // the direct hit whose edge pulled this in
    "edge": "builds-on", // the edge type connecting them
  },
}
```

Direct hits omit the `via` key entirely (it is absent, not `undefined`).
Expanded entries are scored at `direct_hit_score * decay` where `decay`
defaults to `0.7` and is configurable via the
`COMMONPLACE_EXPANSION_DECAY` env var documented below. The merged
result list is sorted by descending score and sliced to the overall
`limit` after expansion, so a highly-scored neighbor can displace a
lower-scored direct hit from the response.

Dedup rules:

- A memory that is already a direct hit is not duplicated as an expanded
  neighbor. The direct-hit shape (no `via`) is preserved.
- When two distinct direct hits share an outbound neighbor, that
  neighbor appears exactly once in the response; its `via` field
  references the direct hit with the higher direct-hit score.

Expansion is intra-scope: a user-scope direct hit only walks the user
graph, and a project-scope direct hit only walks the project graph.
Cross-scope expansion is not supported in v0.2.

### memory_list

Enumerate saved memories from both stores without bodies. Returns
frontmatter-only entries (`name`, `type`, `description`, `scope`). By
default, superseded memories are excluded.

Input schema:

| Argument            | Type                                       | Required | Description                                                                                          |
| ------------------- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `type`              | `user \| feedback \| project \| reference` | optional | Restrict results to memories of this type.                                                           |
| `includeSuperseded` | boolean                                    | optional | When `true`, include superseded memories. Defaults to `false`.                                       |
| `scope`             | `user` or `project`                        | optional | Restrict the listing to a single store. Default: list both stores when the project store is present. |

Example call:

```jsonc
// memory_list
{
  "type": "reference",
  "includeSuperseded": false,
}
```

### memory_delete

Remove a saved memory and its sidecar by name. The `scope` argument is
required to disambiguate when the same name exists in both stores;
otherwise the lookup auto-resolves to whichever store contains the name.

Input schema:

| Argument | Type                | Required | Description                                                                                   |
| -------- | ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `name`   | string              | required | Memory name (filename stem) to delete.                                                        |
| `scope`  | `user` or `project` | optional | Which store to delete from. Required when the name exists in both stores; optional otherwise. |

Example call:

```jsonc
// memory_delete
{
  "name": "feedback_scope_old",
  "scope": "user",
}
```

## Memory scopes

Commonplace loads up to two memory stores side by side:

- **User store** -- always loaded. Personal rules, preferences, hard
  feedback. Located under `COMMONPLACE_USER_DIR` (default
  `~/.commonplace/memory`).
- **Project store** -- loaded only when a project root is detected.
  Per-project context (architecture notes, repo-specific conventions).
  Located under `COMMONPLACE_PROJECT_DIR`, or under
  `<project-root>/.commonplace/memory` when the root is detected via
  MCP `roots/list` or the current working directory.

Search merges hits across both stores by descending score; each match
carries a `scope: 'user' | 'project'` tag identifying which store
produced it.

### Detection priority

The project store is selected by the first matching step in this list:

1. `COMMONPLACE_PROJECT_DIR` env var (explicit override; always wins).
   The path need not exist yet -- the project directory is created
   recursively on the first `memory_save({ scope: 'project' })`.
2. MCP `roots/list` response after init -- if the connected client
   advertises the `roots` capability and returns at least one `file://`
   root, the first such root resolves to `<root>/.commonplace/memory`.
3. `process.cwd()` -- if `<cwd>/.commonplace/memory` already exists on
   disk, that path is used as the project store.
4. None of the above -- user-only mode. Saves with `scope: 'project'`
   are rejected with a clear error.

## Configuration

All configuration lives in environment variables. The full set:

| Variable                      | Default                   | Effect                                                                                                                                                                                                             |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMMONPLACE_USER_DIR`        | `~/.commonplace/memory`   | User store directory. Always loaded.                                                                                                                                                                               |
| `COMMONPLACE_PROJECT_DIR`     | (unset)                   | Project store directory. When set, takes priority over `roots/list` and cwd detection. Created recursively on first project-scope save.                                                                            |
| `COMMONPLACE_MEMORY_DIR`      | (unset; deprecated)       | Deprecated alias for `COMMONPLACE_USER_DIR`. Honoured for back-compat with v0.1 dogfood configs; setting it emits a one-line deprecation warning to stderr.                                                        |
| `COMMONPLACE_MODEL`           | `Xenova/bge-base-en-v1.5` | Embedding model id passed to transformers.js. Not pre-validated at boot; an unknown id surfaces an error from the embedder on the first call that needs an embedding.                                              |
| `COMMONPLACE_DEFAULT_LIMIT`   | `5`                       | Default top-k for `memory_search` when the caller omits `limit`. Must be a positive integer; invalid values cause the bin to exit at boot rather than silently coercing.                                           |
| `COMMONPLACE_EXPANSION_DECAY` | `0.7`                     | Multiplicative score applied to one-hop graph-expanded neighbors of a direct `memory_search` hit. Must be a finite number in `(0, 1]`; invalid values cause the bin to exit at boot rather than silently coercing. |

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

For the binary embedding sidecar layout, see
[docs/sidecar-format.md](docs/sidecar-format.md).

## Supersede semantics

The `supersedes:` frontmatter field on a memory is a list of names of
prior memories that this memory replaces. Use it when you rewrite or
correct an earlier memory and want the older entry to stop showing up
in search results.

By default, both `memory_search` and `memory_list` exclude superseded
memories from their results. A memory is "superseded" iff some other
loaded memory has its name in its `supersedes:` list. Both tools accept
an optional `includeSuperseded: true` flag to bring the older entries
back; in that case `memory_search` matches carry an extra
`supersededBy: <name>` field naming the superseding memory.

The original `.md` and `.embedding` files for a superseded memory are
NOT deleted -- the supersede flag is purely a filter applied at read
time.

## Migration

The `commonplace` CLI ships a `migrate` subcommand that detects and
imports memory from external sources into `COMMONPLACE_USER_DIR`.

```sh
commonplace migrate                      # detect known sources, write nothing
commonplace migrate --from claude-code   # import from Claude Code project memory
commonplace migrate --from claude-code --dry-run  # preview the import, write nothing
commonplace migrate --from claude-code --auto     # non-interactive (forward-compat no-op today; see below)
commonplace migrate <dir>                # rebuild sidecars for an existing dir
```

Bare `commonplace migrate` reports candidate sources (currently Claude
Code's per-project auto-memory at `~/.claude/projects/*/memory/*.md`)
and exits without writing. Pass `--from claude-code` to copy each
compatible `.md` into `COMMONPLACE_USER_DIR` and regenerate the
`.embedding` sidecars. The import target is always
`COMMONPLACE_USER_DIR`; project-scope import is intentionally not
supported in v0.1.

### Conflict policy

The conflict policy is **skip and report** by default: if a name in the
source already exists in `COMMONPLACE_USER_DIR`, the source file is
skipped, the existing target file is left byte-identical, and the skip
is reported in the summary. There is no automatic overwrite; delete
the existing entry first if you want to replace it.

`--dry-run` reports what would be imported without writing any `.md`
or `.embedding` files, and preserves any existing colliding target
file byte-for-byte.

`--auto` is a **forward-compat no-op**: today the import path runs
non-interactively whether or not `--auto` is passed, so the flag's
presence and absence are indistinguishable. It is reserved as the
opt-in for scripted runs once interactive prompting (e.g. per-file
confirmation) is added behind a separate flag. Passing `--auto` in a
script today is safe and recommended -- it pins the non-interactive
contract without depending on the future default.

### Migrating from mem0 / Letta / other MCP-exposed memory tools

There is **no commonplace-side integration code** for mem0, Letta, or
any other memory tool that already exposes its memory through an MCP
server. The pattern: register both servers in your AI client, then ask
your agent in natural language to bridge them. For example, with both
`commonplace` and `mem0` registered as MCP servers, an agent can
respond to "search mem0 for memories tagged architecture and save
each one into commonplace as a project memory" by calling the mem0
search tool, then `memory_save` once per result. The same pattern
works for any future MCP-exposed memory tool.

This is strictly better than a one-shot CLI importer: there is zero
integration code to maintain, no API drift risk if the upstream tool
changes its protocol, and the user picks what to migrate via natural
language rather than a bulk flag.

## License

Released under the MIT License. See the [LICENSE](LICENSE) file for the
full text.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow,
local-development commands, and the merge rules (branch from `main`,
PRs only, CI must pass, conversations resolved, squash-merge).
