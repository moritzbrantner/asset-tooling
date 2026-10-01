---
name: Agent task
about: One PR-sized task for a coding agent (see docs/AGENT_TASKS.md)
title: "<Track> #<parent><slice>: <what a consumer or the pipeline gains>"
labels: ["agent-task", "spec:draft"]
---

Slice of #<parent> (`ROADMAP.md` milestone <X>). Intended implementer: **<Opus|Sol|Sonnet>**. Start after: <#N or "nothing">. Unblocks: <consumer issue, e.g. moritzbrantner/my-farm#125, or "nothing">. One branch (`agent/<topic>`), one PR; follows the `AGENTS.md` **Execution scope** rules.

## Goal

<Two or three sentences: what a consumer or the pipeline can do afterwards.>

## Decisions already made (do not reopen)

- **Controls and defaults:** <parameters, units, presets>
- **Contracts:** <operation identities/versions, new or versioned schemas, package export subpaths, receipt/evidence fields; or "no contract change">
- **Ownership:** <authoritative processor/renderer/pinned source that does the work; what stays in asset-tooling>
- **Compatibility:** <existing schemas, receipts, cache/catalog entries and accepted consumers in `stability/`>
- **Left to the implementer:** <explicitly delegated choices, recorded in the PR>

## Acceptance

- <deterministic tests and examples>
- <checks CI does not run: local model-backed generation, visual inspection, new Blender test files added to the `blender-script` job>
- CI green and every Codex review finding addressed or answered.

## Expected changes

- <src/schemas/test/examples/docs/package.json>

## Out of scope

- <…>
- Foundation, tooling, CI, pin and budget work; consumer-repository changes; reimplementing algorithms owned by an authoritative processor.

## Parallel work

- <open tasks/PRs touching the same files, exports or schemas, or "none">
