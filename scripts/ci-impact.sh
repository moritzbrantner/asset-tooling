#!/usr/bin/env bash
# Lists a pull request's or a push's changed paths for scripts/ci-plan.ts, which picks the Validate jobs they can affect.
# The nightly schedule and a manual dispatch run everything.
set -euo pipefail

plan() {
  bun "$(dirname "$0")/ci-plan.ts" "$@" >> "$GITHUB_OUTPUT"
}

if [[ "$GITHUB_EVENT_NAME" == 'push' ]]; then
  # A push plans from its own diff, like a pull request (#574). A new branch, or a force push whose parent the
  # checkout does not hold, runs everything; so does an empty diff.
  if [[ -z "${BEFORE:-}" || "$BEFORE" =~ ^0+$ ]] || ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
    plan --branch --all
    exit 0
  fi
  # Without rename detection a moved file lists both its old and its new path.
  git diff --no-renames --name-only "$BEFORE" "$GITHUB_SHA" > "$RUNNER_TEMP/push-changed-paths"
  plan --branch --changed "$RUNNER_TEMP/push-changed-paths"
  exit 0
fi

if [[ "$GITHUB_EVENT_NAME" != 'pull_request' ]]; then
  plan --branch --all
  exit 0
fi

# GitHub caps PR-file enumeration and workflow path filters at 3,000.
# Incomplete file lists must not skip acceptance checks.
if [[ ! "$PR_CHANGED_FILES" =~ ^[0-9]+$ ]] || (( PR_CHANGED_FILES >= 3000 )); then
  plan --all
  exit 0
fi

gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files?per_page=100" \
  --jq '.[] | [.filename, (.previous_filename // "")] | @tsv' > "$RUNNER_TEMP/pr-files.tsv"
if (( $(wc -l < "$RUNNER_TEMP/pr-files.tsv") != PR_CHANGED_FILES )) || (( PR_CHANGED_FILES == 0 )); then
  plan --all
  exit 0
fi

# Renames include the removed path as well as the new path.
awk -F '\t' '{ print $1; if ($2 != "") print $2 }' "$RUNNER_TEMP/pr-files.tsv" > "$RUNNER_TEMP/pr-changed-paths"
plan --changed "$RUNNER_TEMP/pr-changed-paths"
