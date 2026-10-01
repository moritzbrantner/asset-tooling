# asset-tooling agent contract

## Purpose

`asset-tooling` owns reproducible asset-generation and processing contracts. It does not own game-specific runtime semantics.

## Boundaries

- Asset intent is declared in versioned specs. Generators consume validated specs instead of ad-hoc prompts or ambient state.
- Generation receipts are evidence. They record the declared spec hash, generator/model identity, input hashes, execution fingerprint, and output hash.
- Exact reproducibility is earned by rebuilding and comparing output bytes; it is never inferred from the presence of a seed alone.
- Verification is non-mutating and cache-independent. Generation may reuse a verified local cache entry, but `verify` must replay the authoritative backend.
- Generation-cache entries are disposable acceleration state, not provenance evidence. Verify declared dependencies before lookup and verify cached blobs by their content hash before reuse.
- The `.asset-tooling/cache` and `.asset-tooling/objects` namespaces are tool-owned disposable state. Durable canonical third-party payloads do not live there.
- `assets/canonical/` is the durable Git LFS-backed payload namespace. Every file there must have exactly one `catalog/storage.json` entry whose source is shared, license-accepted, and content-pinned.
- Catalog/provider/storage manifests, license evidence, hashes, operation descriptors, receipts, and other reviewable metadata stay in normal Git; canonical payload bytes under `assets/canonical/` stay behind Git LFS pointers.
- A Git LFS pointer is not sufficient provenance evidence. Storage verification must hydrate the object and compare its actual SHA-256 and byte length with the catalog source pin.
- Consumers resolve durable payloads through `asset-tooling/catalog/storage`; they must not infer LFS paths or trust pointer metadata directly.
- Importing a durable payload re-verifies hydrated bytes and copies them into the consumer's disposable content-addressed object store as the existing provenance-bearing `AssetRef`. It does not create a second identity or trigger network acquisition.
- Canonical LFS promotion is an explicit reviewed mutation. Acquisition may measure a candidate and prepare a review branch, but it must not silently redefine `main` or bypass exact-head PR validation.
- Generation and receipt creation are explicit mutations and must reconcile existing output instead of rewriting identical files.
- Stable machine-visible paths are portable `/`-separated paths relative to the asset spec directory. Do not make behavior depend on the caller's working directory.
- Generator backends must fail closed when a declared model, input, runtime requirement, or hash does not match.
- Network acquisition is separate from generation. Once declared model/input dependencies are present, deterministic generation and verification must not require hidden downloads.
- Model acquisition may accept a convenient provider branch or tag only as a request: resolve it first to an immutable provider revision, download using that revision, and record provider identity, revision, license evidence, every accepted file hash/length, acquisition implementation identity, and the final bundle hash. Authentication tokens and provider cache metadata are never provenance. Generation consumes only the resulting local hash-pinned artifact and must not invoke acquisition.
- Generated artifacts are disposable by default. Commit an output or receipt only when a consumer/distribution contract intentionally requires it.

## Validation

Run `bun run check` for the ordinary deterministic gate. It validates catalog and storage-manifest structure without hydrating the whole LFS corpus.

Run `bun run catalog:storage:verify` from a Git LFS-hydrated checkout when changing canonical payload storage. Hosted `Validate / canonical-storage` additionally runs `git lfs fsck` and verifies every hydrated payload against its catalog SHA-256 and byte length.

The test suite covers canonical hashing, published-contract immutability, package shape, fail-closed dependency checks, content-addressed cache integrity, idempotent generation, exact rebuild verification, output/cache tampering, catalog acquisition/promotion boundaries, canonical-storage identity and consumer materialization, model-acquisition deterministic packaging/offline verification/tamper rejection, and environment drift reporting.

## Execution scope

These rules govern how work is sliced and when expensive checks run. They never relax the boundaries or validation above.

- **One task = one branch = one PR.** A task is one `agent-task` issue: a PR-sized slice of a capability issue or `ROADMAP.md` step. Deliver its complete declared scope on one branch, including the operation or recipe, schemas, tests, example and docs it requires, in small commits. Do not split a task into new issues or follow-up PRs on your own; if it cannot land as one PR, stop and propose the split on the issue instead of creating it.
- **Stay inside the task.** Do not start foundation, tooling, CI, pin-refresh, maintenance or budget work unless the task cannot be completed without it. Do not change consumer repositories or authoritative processors from here; fix defects in their owners. Note unrelated findings as one line in the PR description; do not open issues for them.
- **No new ratchets unless the task asks for one.** Existing gates (`stability/`, package shape, catalog/storage checks) stay; when a task legitimately moves one, update it in the same PR.
- **One contract version per task.** Settle operation identities, schema versions and package export subpaths before implementing; a task adds at most one new version of each, and never edits a published one.
- **Validate in tiers.** While iterating, run the focused tests and commands that `coding-tooling inspect --target <path> --json` selects for the touched scope. GitHub Actions is the full gate: `Validate` runs `bun run check` on Linux/macOS/Windows, the selected-bundle consumer, the pinned-Blender tests, canonical LFS storage and the Python processing contract; `Stability` reruns accepted consumers, processors and the workflow stack. Before pushing, run locally only what CI does not cover: model-backed generation the change touches, visual inspection of rendered or studio output, and say "not verified" for what your environment cannot run. A red CI check blocks merge; fix it rather than re-proving it locally.
- **Codex reviews the PR.** Codex reviews automatically when a PR is opened or marked ready, so open it (or mark a draft ready) only once the branch is complete. Address or explicitly answer every Codex finding before merge; after substantial fixes, comment `@codex review` for another pass.
- **Decide and continue.** When a task leaves a design choice open, pick the simplest option consistent with this file, record it in the PR description and keep going.
- **Short PR descriptions.** At most about 15 lines: what changed, contract/compatibility changes, one line naming the checks that ran, and anything not verified.

Tasks arrive as GitHub issues in the format, labels and pickup rules of `docs/AGENT_TASKS.md`; implement only `spec:ready` issues labeled for you. Claude Opus runs the loop with the `/agent-loop` skill (`.claude/skills/agent-loop/`); ChatGPT Sol uses the Codex `implementer-loop` skill (`.agents/skills/implementer-loop/`).
