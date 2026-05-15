---
name: commonplace_app_structure
description: Source tree layout and key architectural facts for the commonplace MCP server
type: project
---
Commonplace is a local-first memory MCP server. Source is split by responsibility under `src/`.

## Directory layout

- `src/embedder/`: wrapper around `@huggingface/transformers` (a.k.a. transformers.js). Loads the default `Xenova/bge-base-en-v1.5` model (768-dim, configurable via the `COMMONPLACE_MODEL` env var). Exposes a typed `embed(text) -> Float32Array`. Isolates the rest of the codebase from model-loading concerns.
- `src/store/`: markdown + sidecar I/O and the in-memory vector index. Reads `.md` files with typed YAML frontmatter, encodes/decodes the binary `.embedding` sidecars, and serves brute-force top-k cosine-similarity lookups. `MemoryStore` is the main class; `MemoryGraph` handles relations.
- `src/server/`: the MCP stdio server. Wires the store and embedder into MCP tool handlers (`memory_save`, `memory_search`, `memory_list`, `memory_delete`, `memory_link`, `memory_unlink`, `memory_graph`, `memory_path`). Owns the `instructions` field rendered into the initialize response.
- `src/bin/`: entry points and boot path. `commonplace-mcp.ts` is the installed bin. `boot.ts` handles the connect-then-request-roots sequence so project scope can be detected after `initialize`. `scope.ts` owns the user/project store resolution priority.
- `src/index.ts`: top-level entry, re-exports.

## Memory file layout

- User scope: `~/.commonplace/memory/<name>.md` plus `<name>.embedding`. Cross-project, always loaded.
- Project scope: `<project-root>/.commonplace/memory/<name>.md` plus `<name>.embedding`. Loaded only when a project root is detected.

Project root detection priority (`src/bin/scope.ts`):

1. `COMMONPLACE_PROJECT_DIR` env var (explicit override; path need not exist).
2. First `file://` root from the MCP `roots/list` response.
3. `process.cwd()` if `<cwd>/.commonplace/memory` already exists on disk.
4. None of the above: user-only mode; `scope: 'project'` saves are rejected.

## Memory file shape

Each memory file:

- YAML frontmatter: `name`, `type` (one of `user`/`feedback`/`project`/`reference`, enforced as an enum at both the MCP tool layer and the file-parse layer), `description`, optional `scope`, optional `pinned`, optional `relations` / `supersedes`.
- Markdown body: free-form. The body is what gets embedded; the description is metadata used in list output and the recall pack render.

## MCP instructions assembly

At server-process startup, `createServer()` in `src/server/server.ts` builds the `instructions` string from three sections in order:

1. `SERVER_INSTRUCTIONS`: static "use these tools as the canonical agent-memory mechanism" nudge.
2. `WHEN_TO_SAVE_INSTRUCTIONS`: per-type save triggers and one-line examples for each of the four memory types.
3. Dynamic recall pack: every memory with `pinned: true` (and not superseded) across all wired stores, rendered as `[scope/type] name -- description` lines.

Search merges across user and project stores; each result carries a `scope` tag identifying which store produced it.

## Tech stack notes

- TypeScript, ESM (NodeNext), ES2022 target.
- `pnpm` only (no `npm` / `yarn`); pinned via `packageManager` in `package.json`.
- `vitest` for unit + integration tests.
- Node `>=20`.
- Releases via release-please + GitHub Actions workflow_dispatch chain to `release.yml`, which OIDC-publishes to npm (no `NPM_TOKEN`).