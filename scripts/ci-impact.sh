#!/usr/bin/env bash
set -euo pipefail

emit() {
  printf 'extended=%s\nstability=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}

if [[ "$GITHUB_EVENT_NAME" != 'pull_request' ]]; then
  emit true true
  exit 0
fi

# GitHub caps PR-file enumeration and workflow path filters at 3,000.
# Incomplete file lists must not skip acceptance checks.
if [[ ! "$PR_CHANGED_FILES" =~ ^[0-9]+$ ]] || (( PR_CHANGED_FILES >= 3000 )); then
  emit true true
  exit 0
fi

gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files?per_page=100" \
  --jq '.[] | [.filename, (.previous_filename // "")] | @tsv' > "$RUNNER_TEMP/pr-files.tsv"
if (( $(wc -l < "$RUNNER_TEMP/pr-files.tsv") != PR_CHANGED_FILES )) || (( PR_CHANGED_FILES == 0 )); then
  emit true true
  exit 0
fi

# Renames include the removed path as well as the new path.
awk -F '\t' '{ print $1; if ($2 != "") print $2 }' "$RUNNER_TEMP/pr-files.tsv" > "$RUNNER_TEMP/pr-changed-paths"

extended=true
if ! grep -Eqv '(^docs/|(^|/)[^/]+[.]md$|^src/browser/|^test/browser/|^src/(animation-viewer-eligibility|animation-viewer-page|browser-pages-site|catalog-pages-site|catalog-pages|catalog-preview-hints|generated-gallery-assets|ranger-comparison)[.]ts$|^test/(animation-viewer-eligibility|catalog-pages-site|catalog-pages|generated-gallery-assets|ranger-comparison)[.]test[.]ts$|^scripts/(build-catalog-pages|build-generated-previews|serve-pages)[.]ts$|^[.]github/workflows/pages[.]yml$)' "$RUNNER_TEMP/pr-changed-paths"; then
  extended=false
fi

stability=true
if ! grep -Eqv '(^docs/|(^|/)[^/]+[.]md$|^test/|^src/browser/|^src/(animation-viewer-eligibility|animation-viewer-page|browser-pages-site|catalog-pages-site|catalog-pages|catalog-preview-hints|generated-gallery-assets|ranger-comparison)[.]ts$|^scripts/(build-catalog-pages|build-generated-previews|serve-pages)[.]ts$|^[.]github/workflows/(validate|pages)[.]yml$)' "$RUNNER_TEMP/pr-changed-paths"; then
  stability=false
fi

emit "$extended" "$stability"
