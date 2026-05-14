#!/usr/bin/env bash
# Derive an npm dist-tag from a semver version string.
#
# Usage:   scripts/derive-dist-tag.sh <version>
# Example: scripts/derive-dist-tag.sh 0.1.0          -> latest
#          scripts/derive-dist-tag.sh 0.1.0-beta.1   -> beta
#          scripts/derive-dist-tag.sh 1.0.0-alpha    -> alpha
#
# Rule:
#   - Input must be a `MAJOR.MINOR.PATCH` semver core, optionally followed
#     by `-<pre-release>` and/or `+<build>`. A leading `v` is rejected:
#     the workflow strips the leading `v` from the git tag before invoking
#     this script, so by the time we see the version it must be bare.
#   - If there is no pre-release identifier, print `latest`.
#   - Otherwise, print the alphabetic prefix of the first pre-release
#     segment (the part before the first `.`). Empty alphabetic prefix is
#     a malformed pre-release (e.g. `1.0.0-1`) and exits non-zero.
#
# Errors are written to stderr; success prints exactly the dist-tag
# followed by a newline on stdout.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "derive-dist-tag: missing required <version> argument" >&2
  exit 2
fi

VERSION="$1"

if [[ -z "$VERSION" ]]; then
  echo "derive-dist-tag: empty version string" >&2
  exit 2
fi

# Strict semver-core check: MAJOR.MINOR.PATCH (digits only) followed
# optionally by `-<pre-release>` (alphanumerics + dots + hyphens) and
# optionally `+<build>` (same charset). Rejects leading `v`, partial
# versions like `0.1`, and arbitrary garbage.
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$VERSION" =~ $SEMVER_RE ]]; then
  echo "derive-dist-tag: malformed version: $VERSION" >&2
  exit 2
fi

# Strip any build metadata (after `+`) before extracting pre-release.
CORE_AND_PRE="${VERSION%%+*}"

# Anything after the first `-` is the pre-release section; if absent,
# this is a stable release and the dist-tag is `latest`.
case "$CORE_AND_PRE" in
  *-*)
    PRE="${CORE_AND_PRE#*-}"
    ;;
  *)
    echo "latest"
    exit 0
    ;;
esac

# First segment of the pre-release (before the first `.`).
FIRST_SEG="${PRE%%.*}"

# Alphabetic prefix of the first segment -- this is the dist-tag.
# A purely numeric first segment (e.g. `1.0.0-1`) yields an empty
# prefix and is rejected as malformed.
PREFIX=""
i=0
while (( i < ${#FIRST_SEG} )); do
  ch="${FIRST_SEG:$i:1}"
  if [[ "$ch" =~ ^[A-Za-z]$ ]]; then
    PREFIX+="$ch"
    i=$((i + 1))
  else
    break
  fi
done

if [[ -z "$PREFIX" ]]; then
  echo "derive-dist-tag: pre-release first segment lacks alphabetic prefix: $FIRST_SEG" >&2
  exit 2
fi

echo "$PREFIX"
