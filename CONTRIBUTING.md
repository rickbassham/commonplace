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

For each release (`X.Y.Z` for stable, `X.Y.Z-<pre>.<n>` for a
pre-release like `beta.1` / `rc.0` / `alpha` / `next.5`):

1. **Open a version-bump PR** with all three of these in a single
   commit so they cannot drift:
   - **Write a new CHANGELOG.md section** for `X.Y.Z` describing the
     user-visible changes since the last release. Use the
     `## [X.Y.Z] - YYYY-MM-DD` heading style; the release workflow
     extracts this section verbatim into the GitHub Release body.
   - **Bump `package.json` `version`** to the target version (no
     leading `v`).
   - **Bump `SERVER_VERSION`** in `src/server/server.ts` to the same
     value. The release workflow's drift guard fails the publish if
     these disagree -- catch the mistake locally rather than at the
     gate.
2. **Get the PR reviewed and merge it to `main`.** The version-bump PR
   is merged _before_ the tag is pushed. Do not push the tag against a
   branch -- tags must point at the merge commit on `main`.
3. **Push the `v<version>` tag.** From a clean checkout of `main` at
   the merge commit:
   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   The `Release` workflow triggers on the tag push.
4. **Watch the workflow run** under the repo's GitHub Actions tab.
   The job runs the same gate as CI (`make install` / `typecheck` /
   `lint` / `build` / `test`), enforces the version drift guards,
   derives the npm dist-tag from the tag name (stable -> `latest`,
   `v0.1.0-beta.1` -> `beta`, etc.), runs `pnpm publish --access
public --tag <derived>`, and finally creates a GitHub Release with
   the matching CHANGELOG section. Pre-release tags are marked as such
   on the GitHub Release.

If the workflow fails before publish, fix the underlying problem in a
follow-up PR, delete the failed tag (`git push origin :refs/tags/vX.Y.Z`
plus a local `git tag -d vX.Y.Z`), and start the per-release flow over
once the fix is merged. If the workflow fails _after_ `pnpm publish`
succeeded, the version is already published to npm -- bump to the
next patch and release that.

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
