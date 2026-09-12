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
