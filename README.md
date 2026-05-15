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

## Installing & invoking commonplace-mcp

The recommended Claude Code (or any MCP-client) config invokes the server
through `npx -y commonplace-mcp` rather than a globally-installed binary.
`npx` resolves the package from the npm registry and reuses the local npm
cache (subject to the registry's `max-age` / `etag` revalidation), so each
new MCP-server spawn naturally floats to the latest published version
without any manual `npm install -g` step:

```jsonc
// .claude/mcp.json (or your client's equivalent)
{
  "mcpServers": {
    "commonplace": {
      "command": "npx",
      "args": ["-y", "commonplace-mcp"],
    },
  },
}
```

To pin a specific version (deterministic across spawns), append
`@<semver>` -- for example, `npx -y commonplace-mcp@0.3.0`:

```jsonc
{
  "mcpServers": {
    "commonplace": {
      "command": "npx",
      "args": ["-y", "commonplace-mcp@0.3.0"],
    },
  },
}
```

### Startup version-check

On every server-process startup, after the MCP connection is
established, commonplace-mcp performs a single non-blocking version
check against the public npm registry
(`https://registry.npmjs.org/commonplace-mcp/latest`). When a newer
version is available, a single advisory line is written to **stderr** of
the form `commonplace-mcp X.Y.Z is running; newer version A.B.C is
available. ...`. MCP clients (Claude Code among them) surface server
stderr to the operator, so the notice appears alongside any other server
logs.

The check is fire-and-forget: a registry timeout, DNS failure, or
malformed response produces no log line and no error -- the server never
fails to start because of it. The hard timeout is 1.5 seconds.

Set `COMMONPLACE_NO_UPDATE_CHECK=1` (or `=true`) in your MCP-client
config to skip the version check entirely -- no network call, no log
line, fully opt-out. Any other value (including empty string) leaves
the check enabled. This sits alongside the other `COMMONPLACE_*` env
vars documented in [Configuration](#configuration) below; the
documentation pattern follows the conventions established for
embedder and search knobs.

### Coexisting with Claude Code auto-memory

Claude Code ships its own auto-memory feature whose system prompt
section competes with commonplace's MCP `instructions` directive; the
result is a structural prompt conflict in which the harness section
tends to win salience. When commonplace is the intended memory
mechanism, we recommend you disable Claude Code's auto-memory so the
two do not race -- though you can leave both enabled and accept the
conflict if you prefer. See [the Claude Code memory
docs](https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory)
for the canonical reference. (Future ergonomics: [DAR-1004](https://linear.app/darkdragonsastro/issue/DAR-1004)
will let `commonplace init` scaffold this for you.)

Three knobs disable it:

- **`autoMemoryEnabled: false`** in `.claude/settings.json`, available
  at project, user, or local scope:

  ```jsonc
  // .claude/settings.json
  {
    "autoMemoryEnabled": false,
  }
  ```

- **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`** as an environment variable
  (per-shell scope).

- **`/memory`** runtime toggle inside an interactive session
  (per-session scope).

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
`COMMONPLACE_EXPANSION_DECAY` env var documented below. The
`direct_hit_score` here is the BOOSTED direct-hit score (see
"Connectedness boost" below), so connectedness propagates through
expansion deterministically: a neighbor of a well-connected hub inherits
a slice of the hub's boost. The merged result list is sorted by
descending score and sliced to the overall `limit` after expansion, so a
highly-scored neighbor can displace a lower-scored direct hit from the
response.

Dedup rules:

- A memory that is already a direct hit is not duplicated as an expanded
  neighbor. The direct-hit shape (no `via`) is preserved.
- When two distinct direct hits share an outbound neighbor, that
  neighbor appears exactly once in the response; its `via` field
  references the direct hit with the higher direct-hit score.

Expansion is intra-scope: a user-scope direct hit only walks the user
graph, and a project-scope direct hit only walks the project graph.
Cross-scope expansion is not supported in v0.2.

### Connectedness boost

`memory_search` ranks results by a slightly augmented cosine score that
rewards memories with many inbound references:

```
final_score = cosine_score + alpha * log(1 + inbound_count)
```

Where:

- `alpha` defaults to `0.02` and is configurable via the
  `COMMONPLACE_CONNECTEDNESS_BOOST` env var documented below. Setting it
  to `0` disables the boost entirely and yields identical results to
  v0.1 ranking.
- `inbound_count` is the number of memories whose authored `relations`
  point at this memory (`builds-on`, `related-to`, `contradicts`, and
  `child-of` edges). Body-derived `mentions` edges and structural
  `supersedes` edges are excluded by default: mentions are noisy (a
  passing reference is not a vote of importance) and supersedes is a
  replacement marker, not an endorsement.

**Rationale.** Foundational memories with many inbound edges are
load-bearing -- a lot of other memories build on them. They should rank
slightly above similar-scored leaves with no inbound references. The
default `alpha` is intentionally small so that cosine still dominates
ranking between dissimilar memories: a low-cosine foundational entry
is NOT promoted above a high-cosine leaf at the default alpha. The
boost only meaningfully moves results when two memories already have
similar cosine scores.

**Note on `score` in the response.** The `score` field on each match
in the `memory_search` response is the final post-boost value
(`cosine + alpha * log(1 + inbound)`), not the raw cosine. While raw
cosine is bounded by `[-1, 1]`, the post-boost `score` returned to
clients can exceed `1.0` when a memory has both high cosine and many
inbound authored-relation edges. The `threshold` argument is still
applied to the raw cosine pre-boost, so its `[-1, 1]` range is
unchanged. Clients should not assume `matches[].score <= 1.0`.

**Interaction with one-hop expansion.** When `expand: 'one-hop'` is set,
the decayed scores assigned to expanded neighbors are derived from each
direct hit's BOOSTED score (not its raw cosine): `expanded_score =
(cosine + alpha * log(1 + inbound)) * decay`. So a neighbor of a
well-connected hub inherits a slice of the hub's connectedness boost
through expansion deterministically.

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

### memory_graph

Return the local neighborhood of a saved memory by walking the in-memory
graph BFS-style from a root. The response is a `{ root, nodes, edges }`
envelope where `nodes` contains the root plus every reachable memory
within `depth` hops, and `edges` lists the typed connections that pulled
each neighbor in. Cycles are visited-set safe -- each reachable memory
appears once.

Input schema:

| Argument    | Type                                                                                    | Required | Description                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | string                                                                                  | required | Memory name to use as the root of the neighborhood walk.                                                                                                                              |
| `depth`     | integer >= 0                                                                            | optional | Maximum number of edges to walk from the root. Defaults to `1`. `0` returns just the root with no edges.                                                                              |
| `types`     | array of `related-to \| builds-on \| contradicts \| child-of \| supersedes \| mentions` | optional | Edge types to follow during traversal. Defaults to the four authored relation types plus `supersedes` (omits `mentions` unless requested).                                            |
| `direction` | `out \| in \| both`                                                                     | optional | Which side of the adjacency to walk. `'out'` follows only outbound edges from the root; `'in'` follows only inbound edges to the root; `'both'` (default) follows both directions.    |
| `scope`     | `user` or `project`                                                                     | optional | Scope of the root memory. Required to disambiguate when the same name exists in both stores; otherwise auto-resolved. Traversal is intra-scope -- edges are not walked across stores. |

Example call:

```jsonc
// memory_graph
{
  "name": "architecture_overview",
  "depth": 2,
  "direction": "out",
}
```

### memory_path

Return the shortest directed path between two saved memories using BFS
over the in-memory graph. Returns `{ path: [] }` when `from === to`;
`{ path: null, reason: 'unreachable' }` when no path exists at all; or
`{ path: null, reason: 'depth-exceeded' }` when a path exists but its
shortest length is greater than `maxDepth`.

Input schema:

| Argument   | Type                                                                                    | Required | Description                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`     | string                                                                                  | required | Starting memory name.                                                                                                                                                                   |
| `to`       | string                                                                                  | required | Destination memory name.                                                                                                                                                                |
| `maxDepth` | integer >= 1                                                                            | optional | Maximum number of edges the BFS will walk before giving up with `reason: 'depth-exceeded'`. Defaults to `5`.                                                                            |
| `types`    | array of `related-to \| builds-on \| contradicts \| child-of \| supersedes \| mentions` | optional | Edge types the BFS is allowed to traverse. When omitted, every edge type (including `mentions`) is eligible.                                                                            |
| `scope`    | `user` or `project`                                                                     | optional | Scope of the `from` memory. Required to disambiguate when the same name exists in both stores; otherwise auto-resolved. Path search is intra-scope -- `to` must live in the same store. |

Example call:

```jsonc
// memory_path
{
  "from": "architecture_overview",
  "to": "feedback_scope",
  "maxDepth": 5,
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

## Layered agent-memory nudge

Commonplace nudges agents toward its `memory_*` tools through three layered, static signals: (a) the MCP `instructions` string surfaced by clients like Claude Code at session start, (b) the `Agent memory: ` prefix on every tool description so clients that ignore `instructions` still see the framing at ListTools time, and (c) a per-project `CLAUDE.md` directive as the operator-side fallback when neither (a) nor (b) wins -- DAR-1004 will ship a `commonplace init` subcommand to scaffold (c) ergonomically.

```md
## Memory: dogfood Commonplace

Save / recall via `mcp__commonplace__memory_save` and `mcp__commonplace__memory_search`.
Prefer these tools over any built-in or harness-provided memory location.
```

## Pinned memories

Building on the [layered agent-memory nudge](#layered-agent-memory-nudge) above, any memory whose frontmatter sets `pinned: true` is rendered into the MCP `instructions` string at server-process startup as `- [scope/type] name -- description`. This gives the agent a curated recall pack in its opening prompt every session, without relying on it to call a tool. The flag is opt-in -- existing memories default to `false` until you re-save them with `pinned: true` (or pass `pinned: true` to `memory_save`). The pack is recomputed at each server start (i.e. on the next client reconnect for stdio servers); pins added or removed mid-session take effect next session.

```yaml
---
name: never_admin_merge
description: Never admin-merge without explicit per-PR auth
type: feedback
scope: user
pinned: true
---
```

## Configuration

All configuration lives in environment variables. The full set:

| Variable                          | Default                   | Effect                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMONPLACE_USER_DIR`            | `~/.commonplace/memory`   | User store directory. Always loaded.                                                                                                                                                                                                                                                                        |
| `COMMONPLACE_PROJECT_DIR`         | (unset)                   | Project store directory. When set, takes priority over `roots/list` and cwd detection. Created recursively on first project-scope save.                                                                                                                                                                     |
| `COMMONPLACE_MEMORY_DIR`          | (unset; deprecated)       | Deprecated alias for `COMMONPLACE_USER_DIR`. Honoured for back-compat with v0.1 dogfood configs; setting it emits a one-line deprecation warning to stderr.                                                                                                                                                 |
| `COMMONPLACE_MODEL`               | `Xenova/bge-base-en-v1.5` | Embedding model id passed to transformers.js. Not pre-validated at boot; an unknown id surfaces an error from the embedder on the first call that needs an embedding.                                                                                                                                       |
| `COMMONPLACE_DEFAULT_LIMIT`       | `5`                       | Default top-k for `memory_search` when the caller omits `limit`. Must be a positive integer; invalid values cause the bin to exit at boot rather than silently coercing.                                                                                                                                    |
| `COMMONPLACE_EXPANSION_DECAY`     | `0.7`                     | Multiplicative score applied to one-hop graph-expanded neighbors of a direct `memory_search` hit. Must be a finite number in `(0, 1]`; invalid values cause the bin to exit at boot rather than silently coercing.                                                                                          |
| `COMMONPLACE_CONNECTEDNESS_BOOST` | `0.02`                    | Alpha for the additive `alpha * log(1 + inbound_count)` connectedness boost applied to `memory_search` ranking. Must be a finite non-negative number; set to `0` to disable the boost and recover v0.1 ranking. Negative or non-numeric values cause the bin to exit at boot rather than silently coercing. |
| `COMMONPLACE_NO_UPDATE_CHECK`     | (unset)                   | When set to `1` or `true`, the startup npm-registry version check is skipped entirely (no network call, no log line). Any other value (including empty string) leaves the check enabled. Opt-out only; the default is to perform the check. See [Startup version-check](#startup-version-check).            |

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
