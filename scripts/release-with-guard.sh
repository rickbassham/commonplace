#!/usr/bin/env bash
# DAR-989: wrapper that previews the next release, runs the breaking-changes
# guard against the preview, and -- only if the guard passes (or is bypassed)
# -- invokes `commit-and-tag-version` for real.
#
# Used by both `make release-dry` and `make release`:
#   * dry-run mode (`--dry-run`):
#       1. Capture the dry-run preview via `commit-and-tag-version --dry-run`.
#       2. Extract the next version and the would-be CHANGELOG section.
#       3. Run `scripts/guard-breaking-changes.sh` against the preview.
#       4. Always exit with the guard's status (no real release is cut).
#   * real mode (default):
#       1. Same preview + guard steps as above.
#       2. If guard exits 0, invoke `pnpm exec commit-and-tag-version`.
#       3. If guard exits non-zero, do NOT invoke c-and-t-v and propagate
#          the failure -- this is what keeps the working tree untouched.
#
# Environment:
#   ALLOW_PARSED_BREAKING_CHANGES=1   forwarded to the guard for bypass.

set -euo pipefail

MODE="real"
if [[ "${1:-}" == "--dry-run" ]]; then
  MODE="dry"
  shift
fi

GUARD="$(cd "$(dirname "$0")" && pwd)/guard-breaking-changes.sh"
if [[ ! -x "$GUARD" ]]; then
  echo "release-with-guard: guard script missing or not executable: $GUARD" >&2
  exit 2
fi

# Capture the dry-run preview. Stdout contains the next-version line and
# the CHANGELOG diff; we parse both.
#
# Assign both temp paths before registering the EXIT trap. Under `set -u`,
# a trap that references an unassigned variable would fail on cleanup if
# the script were interrupted between the trap and the assignment.
PREVIEW_TMP="$(mktemp)"
CHANGELOG_TMP="$(mktemp)"
trap 'rm -f "$PREVIEW_TMP" "$CHANGELOG_TMP" 2>/dev/null || true' EXIT

if ! pnpm exec commit-and-tag-version --dry-run > "$PREVIEW_TMP" 2>&1; then
  cat "$PREVIEW_TMP" >&2
  echo "release-with-guard: commit-and-tag-version --dry-run failed; aborting" >&2
  exit 1
fi

# Show the preview to the user (matches the legacy `make release-dry` UX).
cat "$PREVIEW_TMP"

# Parse the next version from the c-and-t-v dry-run output. The tool prints
# a line like `bumping version in package.json from 0.2.1 to 0.3.0`.
NEXT_VERSION="$(grep -oE 'bumping version in [^ ]+ from [^ ]+ to [^ ]+' "$PREVIEW_TMP" \
  | head -n1 \
  | awk '{ print $NF }')"

if [[ -z "$NEXT_VERSION" ]]; then
  # Fallback: try `tagging release v...`.
  NEXT_VERSION="$(grep -oE 'tagging release v[^ ]+' "$PREVIEW_TMP" \
    | head -n1 \
    | sed -E 's/^tagging release v//')"
fi

if [[ -z "$NEXT_VERSION" ]]; then
  echo "release-with-guard: could not determine next version from commit-and-tag-version dry-run output" >&2
  exit 2
fi

# Build a synthetic CHANGELOG containing the preview section so the guard
# can slice it with the same `## [X.Y.Z]` rule it uses against the real
# file. The c-and-t-v dry-run emits the new section prefixed with `+ ` in
# its diff output; strip the prefix.
{
  echo "# Changelog (preview for guard)"
  echo
  awk '
    /^---$/ { next }
    /^\+ ?## \[/ { capture = 1 }
    capture && /^- / { exit }
    capture && /^\+/ {
      line = $0
      sub(/^\+ ?/, "", line)
      print line
    }
  ' "$PREVIEW_TMP"
} > "$CHANGELOG_TMP"

# Determine the previous tag for the commit range. If there is no prior
# tag at all (first release ever), fall back to the full history.
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [[ -n "$PREV_TAG" ]]; then
  RANGE="$PREV_TAG..HEAD"
else
  RANGE="HEAD"
fi

# Run the guard. Its stderr is the user-facing diagnostic; let it flow.
if ! "$GUARD" "$NEXT_VERSION" "$CHANGELOG_TMP" "$RANGE"; then
  exit 1
fi

if [[ "$MODE" == "dry" ]]; then
  exit 0
fi

# Guard passed -- invoke the real release.
exec pnpm exec commit-and-tag-version
