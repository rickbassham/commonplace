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

Releases are driven by [release-please][rp]. A
`.github/workflows/release-please.yml` workflow runs on every push to
`main` and maintains a rolling `chore(main): release X.Y.Z` PR that
represents "what the next release would look like if shipped now."
Merging that PR cuts the release: release-please commits the version
bump (`package.json`, `SERVER_VERSION` in `src/server/server.ts`, and
`CHANGELOG.md`) and pushes the annotated `vX.Y.Z` tag. The tag push
fires `.github/workflows/release.yml`, which performs the actual
`pnpm publish` and creates the GitHub Release.

There is no auto-publish on every merge to `main`. The human gate is
the release PR review: inspect the proposed bump, the CHANGELOG entry,
and the tag, then merge when ready.

[rp]: https://github.com/googleapis/release-please

For each release (`X.Y.Z` stable, or `X.Y.Z-<pre>.<n>` pre-release):

1. **Write well-formed conventional commits.** Release-please reads the
   [conventional commits](https://www.conventionalcommits.org) since
   the last `v*` tag and uses them to pick the next version. `feat:`
   produces a minor bump and an "Added" CHANGELOG entry; `fix:`
   produces a patch bump and a "Fixed" entry; `refactor:` / `perf:` /
   `revert:` produce visible entries; `chore:` / `docs:` / `test:` /
   `ci:` / `build:` / `style:` are intentionally hidden from the
   CHANGELOG (configured in `release-please-config.json` under
   `changelog-sections`). For breaking changes, append a `!` after the
   type (e.g. `feat!: ...`) so the subject carries the conventional
   breaking marker. (Pre-1.0 convention: breaking changes still bump
   minor, not major. `bump-minor-pre-major: true` in
   `release-please-config.json` encodes this.)
2. **Watch the release PR.** Within minutes of your conventional-commit
   merge landing on `main`, release-please opens (or refreshes) a
   `chore(main): release X.Y.Z` PR. Open it and review:
   - the proposed `package.json` version bump,
   - the `SERVER_VERSION` bump in `src/server/server.ts`,
   - the prepended `## [X.Y.Z]` section in `CHANGELOG.md`,
   - the annotated tag the PR will produce on merge.
3. **Merge the release PR** with `gh pr merge <N> --squash --delete-branch`
   once CI is green. Do NOT use `--admin`. Release-please then pushes
   `vX.Y.Z` automatically; the `Release` workflow takes over from there.
4. **The `Release` workflow** runs the same gates as CI (`make install`
   / `typecheck` / `lint` / `build` / `test`), enforces the
   `package.json` / tag / `SERVER_VERSION` drift guards, derives the
   npm dist-tag from the tag name (stable -> `latest`,
   `v0.1.0-beta.1` -> `beta`, etc.), runs
   `pnpm publish --access public --provenance --tag <derived>` via
   the Trusted Publisher (OIDC), and creates a GitHub Release whose
   body is the matching `## [X.Y.Z]` CHANGELOG section. Pre-release
   tags are marked as pre-releases on the GitHub Release.

> **Never hand-edit `package.json` `version` outside the release-please
> PR.** Release-please pins to `.release-please-manifest.json` as its
> source of truth. Out-of-band bumps confuse the tool and produce
> incorrect next-version proposals. Version edits always flow through
> the rolling release PR.

If the release workflow fails before publish, fix the underlying
problem in a follow-up PR, delete the failed tag
(`git push origin :refs/tags/vX.Y.Z` plus a local `git tag -d vX.Y.Z`),
and merge the next release-please PR once the fix has landed on
`main`. If the workflow fails _after_ `pnpm publish` succeeded, the
version is already on npm -- the next release-please PR will propose a
patch bump.

### release-please config

The release-please behaviour is defined entirely by
`release-please-config.json` and `.release-please-manifest.json` at
the repo root:

- `packages["."]."release-type": "node"` -- bumps `package.json`
  `version` automatically.
- `packages["."]."bump-minor-pre-major": true` -- pre-1.0, breaking
  changes bump the minor digit instead of the major.
- `packages["."]."extra-files"` -- additional files to bump alongside
  `package.json`. The single entry for `src/server/server.ts` uses the
  `generic` updater plus the trailing `// x-release-please-version`
  annotation comment to scope the rewrite to the `SERVER_VERSION`
  declaration. The `tests/version-sync.test.ts` invariant catches
  drift if the two ever fall out of sync.
- `packages["."]."changelog-sections"` -- maps conventional-commit
  prefixes to CHANGELOG sections. Hidden types (`chore`, `test`,
  `docs`, `ci`, `build`, `style`) do not appear in the CHANGELOG but
  still count toward the bump (e.g. a `feat:` commit alongside several
  `chore:` commits still produces a minor bump and an "Added" section).
- `.release-please-manifest.json` -- the source of truth for the
  currently-released version. Initialised to `0.2.1` at the time of
  the c-and-t-v -> release-please migration; release-please updates
  it automatically on every release.

## Diagnostic scripts

The `scripts/` directory holds maintainer-only diagnostics that are
deliberately not part of `make test`:

- `scripts/setup-branch-protection.sh` -- reproducible source of truth
  for `main`'s branch-protection settings. Re-run after editing.
- `scripts/derive-dist-tag.sh` -- the npm dist-tag derivation logic
  the release workflow consumes (also unit-tested in
  `tests/derive-dist-tag.test.ts`).
- `scripts/reproduce-cold-start-race.sh` -- destructive
  reproduction of the transformers.js cold-cache race (clears
  the model cache and races two concurrent embedder loads; expects at
  least one to fail). Run only when investigating a regression of the
  same class. Cost: ~440 MB redownload.

## Reporting issues

Open a GitHub issue with a clear repro and the Node + pnpm versions
you were using. Security-sensitive reports: please email the
maintainer rather than filing publicly.
