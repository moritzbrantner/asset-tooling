# Agent tasks

How work reaches the coding agents. A task is one GitHub issue that one agent turns into one PR (see `AGENTS.md`, Execution scope). Anyone may draft an issue, including a person or a chat assistant. An issue becomes implementable only once it is `spec:ready`.

The roadmap lives in `ROADMAP.md` and in the open capability issues (the umbrella roadmaps #107 and #130 and their linked `ready-for-agent` issues). Those capability issues are multi-PR scopes, not tasks: the loop driver slices them into PR-sized `agent-task` issues, each naming its parent.

## Roles

| Agent | Does |
| --- | --- |
| Claude Opus | Runs the loop (`/agent-loop`). Turns drafts into ready specs, slices the next PR-sized step out of the roadmap and capability issues, reviews PRs against their spec and merges them. Implements critical-path and cross-cutting work itself (`agent:opus`): new published schema or operation versions, public package exports, catalog/storage boundaries, and anything a consumer repository is blocked on. |
| ChatGPT Sol | Implements narrow, technically deep `agent:sol` tasks via the Codex `implementer-loop` skill. The spec should settle contracts, ownership, schema/operation versions and scope so Sol can spend depth on correctness rather than redesigning adjacent systems. Runs occasionally, separately from `/agent-loop`, through a backlog of up to three tasks that nothing else waits on. |
| Claude Sonnet | Implements `agent:sonnet` tasks: docs, examples, catalog Pages/studio UI, presets built on existing recipes, mechanical follow-ups. |
| GitHub Actions | The full deterministic gate on every PR: `validate.yml` (`bun run check` on Linux/macOS/Windows, the selected-bundle consumer, the pinned-Blender tests, canonical LFS storage, the Python processing contract) and `stability.yml` (stability metadata plus the accepted consumer, processor and workflow-stack matrices). |
| Codex review | Reviews each PR automatically when it is opened or marked ready; `@codex review` re-triggers it. |

## Labels

- `agent-task`: every task issue.
- `spec:draft`: written but not yet checked against the code. Do not implement.
- `spec:ready`: checked and implementable.
- `spec:needs-input`: blocked on a question for the owner, asked in a comment.
- `agent:opus`, `agent:sol`, `agent:sonnet`: the intended implementer.
- `in-progress`: an implementer has started; the PR will reference the issue.

The older `ready-for-agent` label marks a specified capability issue whose first slice is actionable. It is a source of tasks for the loop driver, not a task an implementer picks up directly.

## Picking up a task (implementers)

When asked to "pick up work", take the oldest open issue labeled `spec:ready` plus your `agent:*` label that has no `in-progress` label and whose "Start after" dependencies are merged. Add `in-progress`, branch `agent/<topic>` (or the branch the issue names) and follow the issue and `AGENTS.md`. Open the PR only when the branch is complete, with `Closes #N` (and `Part of #<parent>` for the capability issue). Never implement `spec:draft` or `spec:needs-input` issues. If the spec turns out to be wrong or impossible, comment on the issue, replace `spec:ready` with `spec:needs-input`, remove `in-progress` and stop; do not silently re-scope it.

## Implementer loop

An implementer run (Codex: the `implementer-loop` skill in `.agents/skills/`; Sonnet: dispatched by `/agent-loop`) takes exactly one action, in this priority order, then reports and exits.

1. **Fix your own open PR.** A PR of yours (its issue carries your `agent:*` label) needs work when:
   - a CI check failed;
   - a Codex review finding is neither fixed nor answered;
   - the loop driver posted a "changes needed" comment newer than your last push.

   Fix it on the same branch, push, and reply to each finding. After substantial fixes, comment `@codex review`. After three failed attempts on the same failure, comment what blocks you on the PR and stop touching it.
2. **Otherwise, wait if your PR is still in review.** If a PR of yours is open and only waiting on CI, Codex or the loop driver's merge, do nothing. One task in flight per implementer.
3. **Otherwise, start the next task** per "Picking up a task". Work in a fresh worktree from `origin/main`. Commit in small steps. Run the focused checks plus what the issue lists that CI does not run. Push, then open the PR with `Closes #N`. Wait for CI and the first Codex review, and handle them as in step 1 within the same run.
4. **Otherwise, exit.** Do not invent work: no new issues, no tooling, CI, pin or cleanup tasks.

An implementer never merges, never edits issue bodies, never writes specs and never changes a `spec:*` label except to replace `spec:ready` with `spec:needs-input` when the spec is wrong. That last case always comes with a comment explaining why and removal of `in-progress`.

## Writing an issue

**Title:** `<Track> #<parent><slice>: <what a consumer or the pipeline gains>`, for example `Procedural #134a: saved surface masks drive cosmetic scatter density`.

**Sizing:**
- One PR. Big enough to deliver a whole usable slice of a capability issue (an operation or recipe with its controls, evidence, docs and example), small enough that one agent finishes it in one session.
- Split along the contract/presentation seam: workbench, Pages or docs-only follow-ups start after the operation or recipe they show has merged.
- At most one new version per published schema or operation identity per task. Published schemas and `<operation>@<n>` identities are immutable; new semantics get a new version, never an edit.
- Pick the implementer by the table above: ambiguous, cross-cutting, consumer-blocking or contract-defining work → `agent:opus`; narrow but technically deep work with settled contracts, strong deterministic acceptance and no downstream waiters → `agent:sol`; docs, examples, Pages/studio UI, presets and mechanical follow-ups → `agent:sonnet`.
- For `agent:sol`, keep breadth narrow even when implementation depth is high: pin the important decisions, name explicit out-of-scope boundaries, and do not rely on the implementer to decompose or redesign neighboring systems.

**Body:** use these sections in this order (the "Agent task" issue template has them):

1. **Header line:** parent capability issue and roadmap milestone, implementer, branch name, `Start after #N` if it depends on another task, and the consumer issue it unblocks (for example `moritzbrantner/my-farm#125`) if any.
2. **Goal:** two or three sentences on the observable result for a consumer or the pipeline.
3. **Decisions already made (do not reopen):**
   - controls, parameters, defaults and presets (tables welcome);
   - exact contract changes: operation identities and versions, new or versioned schemas, package export subpaths (and the matching `scripts/check-package-shape.ts` entry), receipt/evidence fields;
   - ownership: which authoritative processor, renderer or pinned external source does the work (`3d-lab`, Blender, Sapling, workflow stack, …) and what stays in asset-tooling;
   - compatibility for existing schemas, receipts, cache entries, catalog/storage entries and accepted consumers in `stability/`;
   - deliberate simplifications.

   Anything left open says so explicitly ("implementer decides X; record it in the PR").
4. **Acceptance:** concrete deterministic tests and examples. Name the checks CI does not run: local model-backed generation (Stable Diffusion, TRELLIS.2, Stable Fast 3D, TripoSR), `bun run weekend:3d:doctor`, visual inspection of rendered or studio output, and new pinned-Blender test files that must be added to the `blender-script` job. Always end with "CI green and every Codex finding addressed".
5. **Expected changes:** `src/`, `schemas/`, `test/`, `examples/`, `docs/` and `package.json` entries likely touched.
6. **Out of scope:** what a thorough implementer might otherwise add. Always includes foundation, tooling, CI, pin and budget work, consumer-repository changes and reimplementing algorithms owned by an authoritative processor.
7. **Parallel work:** open tasks and PRs touching the same files, exports or schemas, and how to stay out of their way.

**Quality bar for `spec:ready`:**
- Consistent with `AGENTS.md` (boundaries, provenance, fail-closed dependencies, exact-replay rules).
- No unresolved design question that would change a published contract or an ownership boundary.
- Acceptance checks can be verified from the PR.
- Matches the current code: operation identities, schema versions, export subpaths, pinned processor revisions and existing recipes are checked on `main`.

## Drafting with a chat assistant

To hash out an issue in a chat (e.g. ChatGPT) and have it filed, paste this into the chat:

> You are helping me specify a task for the `moritzbrantner/asset-tooling` repository. Before proposing anything, read `AGENTS.md`, `docs/AGENT_TASKS.md`, `ROADMAP.md`, the parent capability issue and the docs relevant to the topic (`docs/operations.md` for any operation or schema change). Discuss the task with me first: challenge scope that is too large for one PR, ask about decisions that would change a published contract or an ownership boundary, and propose concrete controls and defaults. When I say "file it", create a GitHub issue in `moritzbrantner/asset-tooling` with the title and body sections exactly as in `docs/AGENT_TASKS.md` "Writing an issue", and the labels `agent-task`, `spec:draft` and the `agent:*` label we agreed on. Never label it `spec:ready`; Claude checks drafts against the code first. If you cannot create issues, output the title and the body as a Markdown code block instead.

If the chat cannot create issues, open a new issue with the "Agent task" template and paste the body. The next `/agent-loop` run checks the draft against the code, completes or corrects it, and flips it to `spec:ready` (or asks its questions under `spec:needs-input`).
