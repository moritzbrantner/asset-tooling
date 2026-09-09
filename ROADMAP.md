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

## 2. Seeded local image generation

Add the first useful model adapter around a local, version-pinned image-generation stack. The adapter must record model/checkpoint hashes plus all output-affecting sampler, scheduler, step, guidance, size, prompt, negative-prompt, reference-input, and runtime settings. Hidden model downloads are out of scope for generation itself.

## 3. Deterministic 2D processing

Normalize dimensions, color space, alpha handling, cropping, texture packing, and compression after generation. Each processor has a versioned contract and contributes to the build identity.

## 4. 3D asset contract

Standardize GLB/glTF coordinate system, world scale, transforms, materials, animation names, collision-proxy naming, triangle/material budgets, and LOD rules before adding generative 3D backends.

## 5. Asset catalog

Publish a GitHub Pages catalog focused on previews, variant comparison, provenance, reproducibility evidence, validation failures, and approved versions. Avoid decorative counters.

## 6. Consumer proof

Integrate one zoo-game asset and one medieval/RTS asset. Extract additional shared abstractions only after both consumers demonstrate the need.
