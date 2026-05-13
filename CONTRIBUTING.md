# Contributing to commonplace

Thanks for your interest in contributing! This project is small and
opinionated; the rules below keep the history clean and the green
lights honest.

## Workflow

1. **Branch from `main`.** Always create a feature branch off the
   latest `main`. Use a descriptive name (the Linear-issue branch
   format `<user>/<dar-id>-<slug>` is the convention here, but any
   readable name works for external contributors).
2. **No direct pushes to `main`.** Changes must land via a pull
   request. Branch protection is configured to enforce this; even the
   maintainer goes through a PR. Never push directly to `main`.
3. **Open a pull request** against `main`. Keep PRs focused and
   reviewable -- one concern per PR is the goal.
4. **CI must pass before merge.** The `CI` workflow runs on every PR
   and must be green (`make typecheck`, `make lint`, `make build`,
   `make test`, plus a non-blocking `make audit`) on both Node 20 and
   Node 22. The `make audit` step is intentionally non-blocking for
   v0.1; the rest are required.
5. **All PR conversations must be resolved before merge.** If a
   reviewer leaves a comment, address it (fix or push back with
   reasoning) and mark the conversation resolved.
6. **Squash-merge only.** We squash-merge PRs to keep `main`'s history
   linear and easy to bisect. The PR title becomes the squash commit
   subject -- write it like a conventional-commit message.

## Local development

The Makefile is the single source of truth for build and test
commands. CI invokes the same targets:

```bash
make install       # install deps with frozen lockfile
make typecheck     # TypeScript --noEmit
make lint          # ESLint
make build         # tsc -> dist/
make test          # vitest run
make audit         # pnpm audit (non-blocking in CI)
```

Use `pnpm` -- never `npm` or `yarn`. The `packageManager` field in
`package.json` pins the supported pnpm version.

## Quality bar

- TDD when reasonable -- tests-first for new behavior.
- No TODOs without a linked issue.
- No commented-out code in committed changes.
- No skipped tests in committed changes.
- Errors are handled explicitly.

## Releasing

Releases of `commonplace-mcp` to npm are driven entirely by tag pushes
against `main`. There is no auto-publish on merge, no auto-beta, and
no version-bump automation -- every published version is an explicit,
human-reviewed tag push.

### One-time setup

A **Trusted Publisher** must be configured for `commonplace-mcp` on
npmjs.com before the first tag is pushed. This replaces the older
NPM_TOKEN-secret approach: there is no long-lived token to manage,
and the release workflow attaches a provenance attestation to every
publish so consumers can verify the package came from this repo via
`npm audit signatures`.

Setup (out-of-band -- the release workflow cannot do this for you):

1. Sign in to npmjs.com as an account with publish rights to
   `commonplace-mcp`. For the first publish of a brand-new name, sign
   in to any account that you want to own the package.
2. Navigate to **Account → Trusted Publishers → Add Trusted Publisher**
   (or, after the package exists, **Package → Settings → Trusted
   Publishers**).
3. Choose **GitHub Actions** and fill in:
   - Repository owner: `rickbassham`
   - Repository name: `commonplace`
   - Workflow filename: `release.yml`
   - Environment: leave blank (the workflow does not use a GitHub
     Environment gate yet; if one is added later, set its name here).
4. Save. The release workflow will succeed on the next tag push.

Reference: <https://docs.npmjs.com/trusted-publishers>.

If the package does not yet exist on npm (true for the first publish
of a new name), npm will create it on the first successful publish
under the Trusted Publisher config. Make sure the publisher is
configured _before_ pushing the first tag, otherwise the workflow will
fail at the publish step.

### Per-release flow

Releases are produced by `commit-and-tag-version`, which reads the
[conventional commits](https://www.conventionalcommits.org) since the
last `v*` tag, picks the next version, bumps `package.json` and
`SERVER_VERSION` together, writes a new section to `CHANGELOG.md`,
commits, and creates an annotated tag. The release workflow
(`.github/workflows/release.yml`) does the actual `pnpm publish` when
the tag is pushed.

For each release (`X.Y.Z` stable, or `X.Y.Z-<pre>.<n>` pre-release):

1. **Make sure your commits since the last tag are well-formed.**
   `feat:` produces a minor bump and an "Added" CHANGELOG entry; `fix:`
   produces a patch bump and a "Fixed" entry; `refactor:` /
   `perf:` / `revert:` produce visible entries; `chore:` / `docs:` /
   `test:` / `ci:` / `build:` / `style:` are intentionally hidden from
   the CHANGELOG (`.versionrc.json` `types`). A footer of
   `BREAKING CHANGE:` (or a `!` after the type, e.g. `feat!:`) marks
   a major bump.
2. **Preview the bump** from a clean `main` checkout:
   ```sh
   make release-dry
   ```
   This shows what version `commit-and-tag-version` would pick and the
   CHANGELOG entry it would write. Nothing is written.
3. **Cut the release**:
   ```sh
   make release
   ```
   This bumps `package.json` `version`, bumps `SERVER_VERSION` in
   `src/server/server.ts` via `scripts/server-version-updater.cjs`,
   prepends a new section to `CHANGELOG.md`, commits all three changes
   as `chore(release): X.Y.Z`, and creates an annotated tag `vX.Y.Z`.
4. **Inspect the local bump.** Read the diff (`git show HEAD`) and the
   tag (`git tag -v vX.Y.Z` or `git cat-file -p vX.Y.Z`). If anything
   is wrong, undo:
   ```sh
   git reset --hard HEAD~1
   git tag -d vX.Y.Z
   ```
   Then re-run with an explicit `--release-as` or `--prerelease`, e.g.
   `pnpm exec commit-and-tag-version --release-as minor` for a forced
   minor bump or `--prerelease beta` for `X.Y.Z-beta.0`. (Pre-1.0
   convention: breaking changes still bump minor, not major.)
5. **Push**:
   ```sh
   git push --follow-tags
   ```
   The `Release` workflow fires on the tag push. It re-runs the same
   gate as CI (`make install` / `typecheck` / `lint` / `build` /
   `test`), enforces the `package.json` / tag / `SERVER_VERSION`
   drift guards, derives the npm dist-tag from the tag name (stable ->
   `latest`, `v0.1.0-beta.1` -> `beta`, etc.), runs
   `pnpm publish --access public --provenance --tag <derived>` via
   the Trusted Publisher (OIDC), and creates a GitHub Release whose
   body is the matching `## [X.Y.Z]` CHANGELOG section. Pre-release
   tags are marked as pre-releases on the GitHub Release.

If the workflow fails before publish, fix the underlying problem in a
follow-up PR, delete the failed tag (`git push origin :refs/tags/vX.Y.Z`
plus a local `git tag -d vX.Y.Z`), and re-run `make release` once the
fix is merged. If the workflow fails _after_ `pnpm publish` succeeded,
the version is already on npm -- bump to the next patch and release
that.

### BREAKING CHANGES guard

`conventional-commits-parser` (used by `commit-and-tag-version`) matches the
literal phrase `BREAKING CHANGE` followed by whitespace as a breaking-change
note -- it does NOT require the colon the spec calls for. A commit body
containing that phrase as prose is silently classified as a breaking change,
producing a spurious `### ⚠ BREAKING CHANGES` section in the generated
CHANGELOG.

The **breaking-changes guard** at `scripts/guard-breaking-changes.sh` catches
this. It runs automatically:

- as the first step of `make release-dry` and `make release` (via
  `scripts/release-with-guard.sh`, before any file writes), so a misfire
  blocks the local release before commit + tag, and
- in `.github/workflows/release.yml` before `pnpm publish`, so a tag pushed
  from a checkout that skipped local guards still gets blocked at CI.

When a misfire is detected the guard exits non-zero and stderr names:

- the **offending commit** hash + subject (the commit whose body matched
  the parser keyword),
- the **body line** that triggered the parser match, and
- the guidance string pointing at the bypass env var.

To bypass intentionally (rare -- only for a real `BREAKING CHANGE:` footer
when the subject was not marked with the `!` breaking marker), set the
env var:

```sh
ALLOW_PARSED_BREAKING_CHANGES=1 make release
```

The standard remedy for a misfire is to amend the offending commit's body
so the phrase is no longer matched (paraphrase it, or interpolate the
words), then re-run `make release`.

### `commit-and-tag-version` config

The release tool's behaviour is defined entirely by `.versionrc.json`
at the repo root:

- `bumpFiles`: tells the tool to bump both `package.json` (built-in
  `json` updater) and `src/server/server.ts` (custom updater at
  `scripts/server-version-updater.cjs`, which scopes the rewrite to
  the `SERVER_VERSION` declaration). The `tests/version-sync.test.ts`
  invariant catches drift if the two ever fall out of sync.
- `header`: the CHANGELOG preamble; the tool preserves it verbatim
  on every run.
- `types`: maps conventional-commit prefixes to CHANGELOG sections.
  Hidden types do not appear in the CHANGELOG but still count toward
  the bump (e.g. a `feat:` commit alongside several `chore:` commits
  still produces a minor bump and an "Added" section).
- `tagPrefix: "v"`: the tag format the release workflow expects.
- `commitAll: true`: every bumped file is included in the release
  commit, so there are no orphaned dirty changes after `make release`.

## Diagnostic scripts

The `scripts/` directory holds maintainer-only diagnostics that are
deliberately not part of `make test`:

- `scripts/setup-branch-protection.sh` -- reproducible source of truth
  for `main`'s branch-protection settings. Re-run after editing.
- `scripts/derive-dist-tag.sh` -- the npm dist-tag derivation logic
  the release workflow consumes (also unit-tested in
  `tests/derive-dist-tag.test.ts`).
- `scripts/reproduce-cold-start-race.sh` -- destructive
  reproduction of the DAR-955 transformers.js cold-cache race (clears
  the model cache and races two concurrent embedder loads; expects at
  least one to fail). Run only when investigating a regression of the
  same class. Cost: ~440 MB redownload.

## Reporting issues

Open a GitHub issue with a clear repro and the Node + pnpm versions
you were using. Security-sensitive reports: please email the
maintainer rather than filing publicly.
