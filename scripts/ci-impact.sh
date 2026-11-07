#!/usr/bin/env bash
# Lists a pull request's changed paths for scripts/ci-plan.ts, which picks the Validate jobs they can affect.
set -euo pipefail

plan() {
  bun "$(dirname "$0")/ci-plan.ts" "$@" >> "$GITHUB_OUTPUT"
}

if [[ "$GITHUB_EVENT_NAME" != 'pull_request' ]]; then
  plan --all
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
