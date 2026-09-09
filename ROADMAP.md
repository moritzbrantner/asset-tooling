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

Procedural and local model generation share one provenance architecture rather than model-specific pipelines.

- [x] Shared versioned generation-receipt contract for `procedural`, `model`, and `utility` backends.
- [x] Deterministic seeded procedural reference generator.
- [x] Generic adapter result/evidence and replay contract.
- [x] Local Stable Diffusion adapter with a complete hash-pinned Diffusers pipeline bundle, normalized inference settings, runtime evidence, and no hidden downloads.
- [x] Local TripoSR image-to-3D adapter with explicit source image plus a hash-pinned TripoSR source/weights/DINO bundle and no hidden downloads.
- [x] Generation-to-processing handoff that keeps each stage independently traceable by content hash and generation-receipt lineage.

Exact reproducibility is always established by replayed output bytes, never inferred from a seed, backend kind, or model family.

## 3. Stabilization and first consumer release — release-ready

The reusable foundation is frozen before widening the feature surface.

- [x] Protect every published schema byte-for-byte; new semantics require a new schema version.
- [x] Define and test stable CLI exit semantics and a deliberately small root programmatic API.
- [x] Make the package consumable and add deterministic package/coding-tooling capabilities.
- [x] Add content-addressed artifact reuse that never bypasses provenance or fail-closed verification.
- [x] Add clean-room/fault-injection coverage for corruption, missing dependencies, environment drift, and repeated/idempotent operation.
- [x] Integrate one Zoo asset through the public CLI/spec contract.
- [x] Integrate one Medieval/RTS asset through the same public CLI/spec contract.
- [x] Evaluate shared abstractions after both consumers: no additional wrapper or consumer abstraction is justified yet.
- [x] Make release readiness mechanical through `stability:check`, an exact accepted-consumer manifest, a current-head consumer matrix, processing-contract validation, and cross-platform Validate.

A stable package release remains an intentional release action; completing this milestone does not publish or tag one automatically.

## 4. Deterministic 2D processing

Normalize dimensions, color space, alpha handling, cropping, texture packing, and compression after generation. Each processor has a versioned contract and contributes to the build identity.

## 5. 3D asset contract

Standardize GLB/glTF coordinate system, world scale, transforms, materials, animation names, collision-proxy naming, triangle/material budgets, and LOD rules. The existing processing receipt contracts already establish traceable simplification/LOD and animation processing; this section should grow those contracts into a complete production asset profile.

## 6. Asset catalog

Publish a GitHub Pages catalog focused on previews, variant comparison, provenance, reproducibility evidence, validation failures, and approved versions. Avoid decorative counters.

## 7. Consumer proof — continuous

Keep consumer-specific runtime semantics outside this repository. `stability/consumers.json` records the exact merged consumer evidence used for the first stabilization milestone, and the Stability workflow reruns the current tool head against those committed specs on every pull request and main update. Add future consumers to the manifest only when they provide meaningful additional contract coverage rather than simply increasing a count.
