# Changelog

All notable changes to `commonplace-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0](https://github.com/rickbassham/commonplace/compare/v0.1.0...v0.2.0) (2026-05-13)

### Added

* **cli:** add commonplace graph subcommand for memory visualization (DAR-933) ([#40](https://github.com/rickbassham/commonplace/issues/40)) ([6b9b08a](https://github.com/rickbassham/commonplace/commit/6b9b08a5001eb2bc6429d98271e501d40d1348ef))
* connectedness boost in memory_search ranking (DAR-931) ([#38](https://github.com/rickbassham/commonplace/issues/38)) ([60dfff3](https://github.com/rickbassham/commonplace/commit/60dfff3c5138d4dfe3b931ea326530b42bb035b1))
* one-hop graph expansion in memory_search (DAR-930) ([#35](https://github.com/rickbassham/commonplace/issues/35)) ([d2f8073](https://github.com/rickbassham/commonplace/commit/d2f8073417626f9ec8ef2a062bdb4ce1fbcc9a5b))
* **release:** adopt commit-and-tag-version for bump + CHANGELOG + tag (DAR-963) ([#31](https://github.com/rickbassham/commonplace/issues/31)) ([17a4a9b](https://github.com/rickbassham/commonplace/commit/17a4a9bfc0c3fdfde9664b54946687e6653aa425)), closes [#22](https://github.com/rickbassham/commonplace/issues/22)
* **server:** add memory_graph and memory_path MCP tools (DAR-932) ([#39](https://github.com/rickbassham/commonplace/issues/39)) ([ced9ffd](https://github.com/rickbassham/commonplace/commit/ced9ffd56de1c944fc7b89822a6ad02cc38404ee))


### Fixed

* **migrate:** normalise harness frontmatter on import; resilient scan (DAR-966) ([#37](https://github.com/rickbassham/commonplace/issues/37)) ([e617d6b](https://github.com/rickbassham/commonplace/commit/e617d6b7d8332527544a0dd6f077943719b9343b))

## [0.1.0] - 2026-05-10

First public release. A local-first commonplace book that ships as an MCP
server: notes are plain Markdown with YAML frontmatter, embeddings live in
`.embedding` sidecars next to each note, and semantic search runs entirely
offline via `transformers.js` + `bge-base-en-v1.5`.

### Added

- MCP stdio server with the four memory tools (`memory_save`, `memory_list`,
  `memory_delete`, `memory_search`) and the graph tools (`memory_link`,
  `memory_unlink`) registered, dispatched, and covered by integration tests
  (DAR-909, DAR-919, DAR-920, DAR-928).
- Markdown-on-disk note store: typed YAML frontmatter, binary `.embedding`
  sidecars, lazy re-embedding on save, directory scan, and brute-force
  top-k cosine search (DAR-910, DAR-911, DAR-916).
- Local embedding pipeline wrapped around `@huggingface/transformers` with
  the `bge-base-en-v1.5` model (DAR-912 / embedder module).
- Graph features: `relations` and `supersedes` frontmatter fields,
  in-memory graph with dangling-edge detection, `[[name]]` mention
  extraction from body content, and search response enrichment with
  relations plus default-exclude of superseded notes (DAR-925, DAR-926,
  DAR-927, DAR-929).
- Multi-process safety for the store: atomic writes, advisory locks, and
  mtime-driven rescan to keep the in-memory index consistent across
  concurrent server instances (DAR-923).
- Layered user + project memory with automatic scope detection from the
  MCP client's `roots/list` response, so per-project notes stay scoped to
  the workspace while a shared user store backs cross-project recall
  (DAR-924).
- Env-var configuration for the memory directory, embedder model id, and
  search default limit: `COMMONPLACE_USER_DIR`, `COMMONPLACE_PROJECT_DIR`,
  `COMMONPLACE_MEMORY_DIR`, `COMMONPLACE_MODEL`, `COMMONPLACE_DEFAULT_LIMIT`
  (DAR-913).
- `migrate` CLI subcommand for one-shot import of existing memory
  directories, including auto-migration from Claude Code project memory
  on first run (DAR-918, DAR-961).
- README install + tool-reference docs, `commonplace-mcp` global binary,
  and `claude mcp add commonplace commonplace-mcp` onboarding flow
  (DAR-915).
- Tag-triggered npm publish workflow with OIDC Trusted Publishers,
  `--provenance` attestation, `package.json` / git-tag / `SERVER_VERSION`
  drift guards, and dist-tag derivation from the version's pre-release
  suffix (DAR-960).
- PR-gating CI on Node 22 and 24, lint + typecheck + test + build
  required before merge (DAR-914).

### Notes

- `npm i -g commonplace-mcp` followed by
  `claude mcp add commonplace commonplace-mcp` is the supported install
  path. The MCP `initialize` handshake reports `serverInfo.version`
  matching the published `package.json` version.
- Pre-1.0 versioning policy: breaking changes bump minor
  (`0.1.0` -> `0.2.0`); additive/fix changes bump patch
  (`0.1.0` -> `0.1.1`). Manual `package.json` + `SERVER_VERSION` +
  `CHANGELOG.md` bumps for now; automated release tooling
  (release-please / Changesets) is deferred until post-v0.2.

## [0.0.1-canary.2] - 2026-05-10

### Fixed

- Release workflow now runs on Node 24 so npm 11+ is available. The
  v0.0.1-canary.1 publish failed at the registry with a misleading
  `404 Not Found` because npm 10 (shipped with Node 20) silently
  degrades the OIDC trusted-publishing handshake to anonymous, and
  anonymous PUTs come back as 404. Bumping `.nvmrc` to 24 (and the CI
  matrix to `[22, 24]`) is the smallest durable fix; the canary.2
  release validates the workflow end-to-end before `v0.1.0`.

## [0.0.1-canary.1] - 2026-05-10

### Added

- End-to-end smoke test of the tag-triggered release workflow
  (DAR-960). This canary publish exercises the OIDC Trusted Publisher
  authentication path, the `--provenance` build attestation, the
  drift guards (tag/version/SERVER_VERSION), and the GitHub Release
  creation step before the real `v0.1.0` ships.

### Notes

- This is a pre-release on the `canary` dist-tag. `npm install
  commonplace-mcp` continues to track `latest` (which currently
  points at `0.0.1-canary.0` from the manual claim publish; the
  pointer moves to `v0.1.0` once that ships).
