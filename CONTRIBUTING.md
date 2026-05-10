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

## Reporting issues

Open a GitHub issue with a clear repro and the Node + pnpm versions
you were using. Security-sensitive reports: please email the
maintainer rather than filing publicly.
