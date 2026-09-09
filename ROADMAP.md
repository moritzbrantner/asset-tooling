# Roadmap

## 1. Reproducibility core

- Versioned asset specification and receipt contracts.
- Canonical spec hashing and SHA-256 artifact identities.
- Execution-environment fingerprints without timestamps, host names, user names, or absolute checkout paths.
- Explicit randomness contracts (`none` or `seeded`).
- Fail-closed declared input/model verification.
- Idempotent mutation results (`changed` / `unchanged`).
- Non-mutating exact rebuild verification.
- A deterministic built-in copy backend used only to prove the architecture.

## 2. Generation backends — implemented foundation

Procedural and local model generation now share one provenance architecture rather than model-specific pipelines.

- [x] Shared versioned generation-receipt contract for `procedural`, `model`, and `utility` backends.
- [x] Deterministic seeded procedural reference generator.
- [x] Generic adapter result/evidence and replay contract.
- [x] Local Stable Diffusion adapter with a complete hash-pinned Diffusers pipeline bundle, normalized inference settings, runtime evidence, and no hidden downloads.
- [x] Local TripoSR image-to-3D adapter with explicit source image plus a hash-pinned TripoSR source/weights/DINO bundle and no hidden downloads.
- [x] Generation-to-processing handoff that keeps each stage independently traceable by content hash and generation-receipt lineage.

Exact reproducibility is always established by replayed output bytes, never inferred from a seed, backend kind, or model family.

## 3. Stabilization and first consumer release — in progress

Freeze the reusable foundation before widening the feature surface.

- [x] Protect every published schema byte-for-byte; new semantics require a new schema version.
- [x] Define and test stable CLI exit semantics and a deliberately small root programmatic API.
- [x] Make the package consumable and add a deterministic `package:check` coding-tooling capability.
- [ ] Add content-addressed artifact reuse that never bypasses provenance or fail-closed verification.
- [ ] Add clean-room/fault-injection coverage for corruption, missing dependencies, environment drift, and repeated/idempotent operation.
- [ ] Integrate one zoo-game asset through the public package contract.
- [ ] Integrate one medieval/RTS asset through the same public package contract.
- [ ] Extract only abstractions demonstrated by both consumers.
- [ ] Require exact-head package, processing-contract, coding-tooling, and cross-platform CI evidence for the first stable release.

## 4. Deterministic 2D processing

Normalize dimensions, color space, alpha handling, cropping, texture packing, and compression after generation. Each processor has a versioned contract and contributes to the build identity.

## 5. 3D asset contract

Standardize GLB/glTF coordinate system, world scale, transforms, materials, animation names, collision-proxy naming, triangle/material budgets, and LOD rules. The existing processing receipt contracts already establish traceable simplification/LOD and animation processing; this section should grow those contracts into a complete production asset profile.

## 6. Asset catalog

Publish a GitHub Pages catalog focused on previews, variant comparison, provenance, reproducibility evidence, validation failures, and approved versions. Avoid decorative counters.

## 7. Consumer proof

Keep consumer-specific runtime semantics outside this repository. The first stabilization milestone requires one zoo-game asset and one medieval/RTS asset to prove the package boundary before additional shared abstractions are introduced.
