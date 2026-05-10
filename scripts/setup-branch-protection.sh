#!/usr/bin/env bash
# DAR-914: Apply branch protection to `main` for the commonplace repo.
#
# This script is the reproducible source of truth for the branch
# protection settings -- review changes here, run the script out-of-band
# to apply them. CI does not run this script; a maintainer with admin
# rights does.
#
# Required:
#   - `gh` CLI authenticated as a user with admin on the repo.
#   - The CI workflow `.github/workflows/ci.yml` defines a matrix on
#     `node-version: [22, 24]` and a single job named `ci`. The
#     status-check contexts below ("ci (22)" / "ci (24)") must match
#     the rendered matrix-leg job names. Drift between this script and
#     ci.yml is checked by the DAR-914 contract tests.
#
# Usage:
#   ./scripts/setup-branch-protection.sh [owner/repo]
#
# Defaults to `rickbassham/commonplace`. Override by passing
# `OWNER/REPO` as the first argument.
set -euo pipefail

REPO="${1:-rickbassham/commonplace}"
BRANCH="main"

echo "Applying branch protection to ${REPO}@${BRANCH}..."

# The PUT /repos/{owner}/{repo}/branches/{branch}/protection endpoint
# replaces the whole protection config. JSON body is fed via stdin so
# the payload is reviewable verbatim. `restrictions` must be present
# (null is allowed and means "no push restrictions").
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "ci (22)",
      "ci (24)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
JSON

echo "Branch protection applied."
