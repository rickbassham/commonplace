# Changelog

All notable changes to `commonplace-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0](https://github.com/rickbassham/commonplace/compare/v0.3.0...v0.4.0) (2026-05-15)


### Added

* **server:** add MCP instructions and Agent memory framing (DAR-965) ([#50](https://github.com/rickbassham/commonplace/issues/50)) ([84ef124](https://github.com/rickbassham/commonplace/commit/84ef124704c6f3ed869f1ea38a7e2e4a6fe1d027))
* **server:** startup version check and npx invocation docs (DAR-1006) ([#52](https://github.com/rickbassham/commonplace/issues/52)) ([e98ee3a](https://github.com/rickbassham/commonplace/commit/e98ee3a73271cc741e62efb5e3eeaefccacc21a4))
* surface pinned memories in MCP instructions at session start (DAR-1003) ([#53](https://github.com/rickbassham/commonplace/issues/53)) ([b1206cb](https://github.com/rickbassham/commonplace/commit/b1206cb79d2a59ca466bcf177684c39a89788e36))

## [0.3.0](https://github.com/rickbassham/commonplace/compare/v0.2.1...v0.3.0) (2026-05-14)


### Added

* **release:** guard against spurious BREAKING CHANGES section (DAR-989) ([#42](https://github.com/rickbassham/commonplace/issues/42)) ([bda917d](https://github.com/rickbassham/commonplace/commit/bda917d02f7cf739fc731a3f895316b118ec2ba5))
* **release:** switch to release-please flow and enforce_admins (DAR-995) ([#44](https://github.com/rickbassham/commonplace/issues/44)) ([909a540](https://github.com/rickbassham/commonplace/commit/909a540763dc9739a89a0a860a90f1e49a76c302))


### Fixed

* **embedder:** clear cached pipeline promise on init failure (DAR-935) ([#43](https://github.com/rickbassham/commonplace/issues/43)) ([097469d](https://github.com/rickbassham/commonplace/commit/097469d4fd1832b366faf35ee939bec8676451db))
* **release:** use bare v* tags in release-please so release.yml fires ([#46](https://github.com/rickbassham/commonplace/issues/46)) ([60d33cc](https://github.com/rickbassham/commonplace/commit/60d33ccb0db24105ade9ea5e32687ad5482ecd1e))

## [0.2.1](https://github.com/rickbassham/commonplace/compare/v0.2.0...v0.2.1) (2026-05-13)

First published 0.2.x. v0.2.0 was tagged but never reached npm: the release workflow's test gate caught two pre-existing bugs in `tests/version-sync.test.ts` that only surfaced when the version actually moved off `0.1.0`.

### Fixed

* **release pipeline:** `tests/version-sync.test.ts` now derives the expected version from `package.json` instead of pinning to a literal, and the CHANGELOG-heading regex accepts both the legacy hand-authored Keep-a-Changelog format and the auto-generated `commit-and-tag-version` format. No user-visible behaviour change vs the v0.2.0 tag — same MCP surface, same tools, same on-disk format.

The v0.2.0 entry below documents the full v0.2 feature set (graph-aware retrieval) that this release ships.

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
