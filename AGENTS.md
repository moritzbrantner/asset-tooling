# asset-tooling agent contract

## Purpose

The owner-controlled product intent is in `docs/decisions/atlas.md`. Read the relevant Decisions and Questions before changing product capabilities; stable IDs and unanswered Questions are not implementation status or GitHub issue substitutes.

`asset-tooling` owns reproducible asset-generation and processing contracts. It does not own game-specific runtime semantics.

## Experimental asset iteration (Decision 7.1.4)

- For disposable generated output, use **current → inspect → adjust → replace**, with optional side-by-side candidates. Do not add output release tags, archive histories, per-file consumer pins or byte-identical historical rebuild requirements solely for each visual revision. Existing published consumer bundles remain unchanged until the consumer intentionally adopts a replacement.
- Open the current output in the existing Pages gallery/review surfaces and in a real consumer at gameplay scale. Do not mistake a passing import/receipt test for good-looking art, and do not claim a fixed published comparison shows a newer local output.
- The exact-replay rules below remain for operations that explicitly promise deterministic bytes, not for every provisional preview. Keep source licensing, safe model/source acquisition, format validity, declared dependencies and public API compatibility; do not use disposable-output policy to bypass those boundaries.
- Before developing a broader internal foundation, check an established Blender/ComfyUI/three.js reference and identify the specific missing quality, control or cost. A scoped internal improvement may come first, but must not hold unrelated consumers hostage.
- Flag cross-repository ownership changes: Blender and ComfyUI author; `asset-tooling` prepares/reviews/exports; `workflow-editor` authors workflows, `workflow-runner` executes, `workflow-engine` orchestrates; games own gameplay/world placement and use established renderers. Do not duplicate those owners.

## Boundaries

- Asset intent is declared in versioned specs. Generators consume validated specs instead of ad-hoc prompts or ambient state.
- For supported generative-media operations, treat ComfyUI as the external reference behind asset operations, not a graph/queue/model runtime to clone. Any internal replacement must have an explicit provider selection, consumer evidence and a reversible rollout. See `docs/comfyui-first.md`.
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
- Exception (owner decision on #211, 2026-10-17): `review/` is the Git LFS review namespace for generated review candidates, such as `review/warden-icons/`. Its PNGs are LFS-tracked and pinned by a plain-JSON candidates manifest with provenance; briefs, workflows and manifests stay plain JSON. Review candidates are never approved or canonical, get no `catalog/storage.json` or `catalog/sources.json` entries and stay outside `assets/canonical/`. Approval is only the exact sha256 named in an `approved-png-v1` bundle export (Decision 4.1.3). The committed approved Warden export is `review/warden-icons/approved/` (LFS PNGs, plain-JSON `manifest.json` and the consumer pin `export.ref.json`), produced by `bun scripts/export-warden-icons.ts` from the owner selection recorded in `review/warden-icons/export-selection.json`; it also stays outside the catalog and `assets/canonical/`. Pages hydrates only this folder (`git lfs pull --include="review/**"`) and fails closed when its bytes do not match the manifest. The one other Pages hydration is the Ranger comparison's humanoid members under `assets/canonical/` (owner answer on #111, 2026-10-17; docs/animation-viewer.md#ranger-comparison), each verified against its catalog pin.

## Local tool setup

Use `python3 scripts/setup-tools.py doctor --profile all --json` for read-only local tooling diagnostics and `python3 scripts/setup-tools.py setup --profile <profile>` for opt-in, idempotent installation. The ComfyUI profile additionally requires `--gpu nvidia|cpu`. Runtime/model acquisition and visual approval are separate from setup; see `docs/local-tool-setup.md`.

## Validation

Run `bun run check` for the ordinary deterministic gate. It validates catalog and storage-manifest structure without hydrating the whole LFS corpus.

Run `bun run catalog:storage:verify` from a Git LFS-hydrated checkout when changing canonical payload storage. Hosted `Validate / canonical-storage` additionally runs `git lfs fsck` and verifies every hydrated payload against its catalog SHA-256 and byte length.

The test suite covers canonical hashing, published-contract immutability, package shape, fail-closed dependency checks, content-addressed cache integrity, idempotent generation, exact rebuild verification, output/cache tampering, catalog acquisition/promotion boundaries, canonical-storage identity and consumer materialization, model-acquisition deterministic packaging/offline verification/tamper rejection, and environment drift reporting.
