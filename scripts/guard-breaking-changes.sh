#!/usr/bin/env bash
# DAR-989: guard against a spurious `### ⚠ BREAKING CHANGES` CHANGELOG section
# sourced from prose in a commit body rather than from a real breaking-change
# commit.
#
# Background: `conventional-commits-parser` (used by `commit-and-tag-version`
# and the wider conventional-changelog ecosystem) matches the literal phrase
# `BREAKING CHANGE` followed by whitespace as a breaking-change note -- it
# does NOT require the colon the spec calls for. Any commit body containing
# that phrase as prose is silently classified as a breaking change.
#
# This guard inspects the generated CHANGELOG section for the target version
# and, if it contains a `### ⚠ BREAKING CHANGES` heading, requires at least
# one commit subject in `<range>` to carry the conventional-commits `!`
# breaking marker. If no `!`-marked subject is present, the guard exits
# non-zero and names the offending commit (the one whose body matched the
# parser keyword) plus the body line that triggered the match.
#
# Usage:
#   scripts/guard-breaking-changes.sh <version> <changelog-path> <git-range>
#
#   <version>         e.g. `0.3.0` (no leading `v`)
#   <changelog-path>  path to the generated CHANGELOG file
#   <git-range>       git revision range, e.g. `v0.2.1..HEAD`
#
# Environment:
#   ALLOW_PARSED_BREAKING_CHANGES=1
#       Bypass the check. The bypass is for the rare legitimate footer-only
#       breaking change (a real `BREAKING CHANGE:` footer without a `!` in
#       the subject -- legal under the spec but non-standard).
#
# Exit codes:
#   0  -- no BREAKING CHANGES section in the version slice, or a `!`-marked
#         subject is present, or the bypass env var is set.
#   1  -- BREAKING CHANGES section present, no `!`-marked subject in range,
#         bypass not set. Stderr names the offending commit and body line.
#   2  -- usage error (missing args, unreadable inputs).

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "guard-breaking-changes: usage: $0 <version> <changelog-path> <git-range>" >&2
  exit 2
fi

VERSION="$1"
CHANGELOG="$2"
RANGE="$3"

if [[ -z "$VERSION" ]]; then
  echo "guard-breaking-changes: empty <version> argument" >&2
  exit 2
fi

if [[ ! -f "$CHANGELOG" ]]; then
  echo "guard-breaking-changes: CHANGELOG not found at: $CHANGELOG" >&2
  exit 2
fi

if [[ -z "$RANGE" ]]; then
  echo "guard-breaking-changes: empty <git-range> argument" >&2
  exit 2
fi

# Slice the CHANGELOG section for $VERSION: the lines between the
# `## [VERSION]` heading and the next `## ` heading. Matches
# `## [VERSION]`, `## [VERSION] - ...`, and `## [VERSION](url)`.
SECTION="$(awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" { capture = 1; next }
  capture && /^## / { exit }
  capture { print }
' "$CHANGELOG")"

# If the version slice contains no `### ⚠ BREAKING CHANGES` heading,
# nothing to check. Match the literal heading (the warning glyph and
# the word BREAKING CHANGES).
if ! printf '%s\n' "$SECTION" | grep -q '^### .*BREAKING CHANGES'; then
  exit 0
fi

# A BREAKING CHANGES heading is present in the slice. Enumerate commits
# in the range and look for a subject carrying the conventional-commits
# `!` marker: `^[a-z]+(\([^)]+\))?!:`.
SUBJECTS_TMP="$(mktemp)"
trap 'rm -f "$SUBJECTS_TMP" "$BODIES_TMP" 2>/dev/null || true' EXIT
BODIES_TMP="$(mktemp)"

# `%H %s` -- one line per commit, hash then subject.
git log --format='%H %s' "$RANGE" > "$SUBJECTS_TMP"

BANG_RE='^[0-9a-f]+ [a-z]+(\([^)]+\))?!:'
if grep -Eq "$BANG_RE" "$SUBJECTS_TMP"; then
  # At least one commit subject carries `!`. The CHANGELOG section is
  # legitimate; the guard passes.
  exit 0
fi

# No `!`-marked subject. If the bypass env var is set to `1`, allow the
# release to proceed but emit a stderr notice so the bypass is visible
# in CI logs.
if [[ "${ALLOW_PARSED_BREAKING_CHANGES:-}" == "1" ]]; then
  echo "guard-breaking-changes: BREAKING CHANGES section present and no \`!\` subject in $RANGE; bypassing because ALLOW_PARSED_BREAKING_CHANGES=1." >&2
  exit 0
fi

# Find the offending commit -- the one whose body contains the literal
# `BREAKING CHANGE` followed by whitespace (the parser's lenient match).
# Emit `%H%n%s%n%b%n---END---` per commit so we can scan body lines.
git log --format='%H%n%s%n%b%n---END---' "$RANGE" > "$BODIES_TMP"

OFFENDING_HASH=""
OFFENDING_SUBJECT=""
OFFENDING_LINE=""

current_hash=""
current_subject=""
state="hash"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == "---END---" ]]; then
    state="hash"
    current_hash=""
    current_subject=""
    continue
  fi
  case "$state" in
    hash)
      current_hash="$line"
      state="subject"
      ;;
    subject)
      current_subject="$line"
      state="body"
      ;;
    body)
      if [[ -z "$OFFENDING_HASH" ]] && [[ "$line" =~ BREAKING[[:space:]]CHANGE[[:space:]] ]]; then
        OFFENDING_HASH="$current_hash"
        OFFENDING_SUBJECT="$current_subject"
        OFFENDING_LINE="$line"
      fi
      ;;
  esac
done < "$BODIES_TMP"

# Pick a short hash for the error message.
SHORT_HASH=""
if [[ -n "$OFFENDING_HASH" ]]; then
  SHORT_HASH="$(git rev-parse --short "$OFFENDING_HASH" 2>/dev/null || echo "$OFFENDING_HASH")"
fi

{
  echo "guard-breaking-changes: v$VERSION has no commit subjects marked with \`!\`, but the generated CHANGELOG contains a BREAKING CHANGES section sourced from a body line. This is almost always a parser misfire on prose."
  if [[ -n "$OFFENDING_HASH" ]]; then
    echo "  offending commit: $SHORT_HASH $OFFENDING_SUBJECT"
    echo "  body line:        $OFFENDING_LINE"
  else
    echo "  offending commit: <unable to locate the matching commit body in $RANGE>"
  fi
  echo "  guidance:         To bypass intentionally (rare), set ALLOW_PARSED_BREAKING_CHANGES=1."
} >&2

exit 1
