# Project Rules

Project-specific rules for this codebase. Universal coding rules (git practices,
quality standards, task sizing, language rules, etc.) are in `~/.claude/CLAUDE.md`
and apply automatically.

## Tech Stack

- **TypeScript** (strict mode, ES2022 target)
- **ESM** module output (NodeNext) — no CommonJS
- **pnpm** as the only package manager (no `npm`, no `yarn`)
- **vitest** for unit and integration tests
- **transformers.js** (`@huggingface/transformers`) for local embedding inference
- **MCP SDK** (`@modelcontextprotocol/sdk`) for the stdio MCP server surface

Node `>=20` is required (see `.nvmrc` and `package.json` engines).

## Architecture

The `src/` tree is split by responsibility:

- **`src/embedder/`** — thin wrapper around `transformers.js`. Loads the
  embedding model, exposes a typed `embed(text) -> Float32Array` (or batched
  variant), and isolates the rest of the codebase from model-loading concerns.
- **`src/store/`** — markdown + sidecar I/O and the in-memory index. Reads
  `.md` files with typed YAML frontmatter, encodes/decodes the binary
  `.embedding` sidecars, and serves nearest-neighbor lookups against the
  in-memory vector index.
- **`src/server/`** — the MCP stdio server. Wires the store and embedder into
  MCP tool/resource handlers so external clients (e.g. Claude Code) can query
  and write notes.
- **`src/index.ts`** — entry point. In DAR-908 it is just
  `console.log('commonplace')`; later issues wire it to the MCP server.

## Project Conventions

- **Makefile-driven** — Always invoke build/test/lint/etc. through `make`
  targets (`make test`, `make build`, `make lint`, …). The Makefile is the
  contract; underlying scripts can change without touching workflows.
- **pnpm only** — never use `npm` or `yarn`. The `packageManager` field pins
  a pnpm version and CI uses `pnpm install --frozen-lockfile`.
- **Markdown is the source of truth** — note content lives in `.md` files
  with YAML frontmatter. Anything else (embeddings, indexes, caches) is
  derived and reproducible from the markdown.
- **Sidecars are derived** — `.embedding` files (and any future sidecars)
  must be regenerable from the corresponding `.md`. They are never the
  source of truth and may be deleted/rebuilt at will.

## Environment

Required environment variables and defaults are owned by **DAR-913**
(env-var configuration). When that issue lands, this section will list each
variable with its default and effect; for now refer to DAR-913 for the
authoritative list.

## Overrides

No project-specific overrides to the universal rules in `~/.claude/CLAUDE.md`
yet.
