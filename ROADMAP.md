# Roadmap

`asset-tooling` is a reproducible asset build system. It owns asset-operation contracts, provenance, validation, hashing, caching, and adapters around authoritative generators/processors. It does not own workflow authoring/execution infrastructure or reimplement domain algorithms merely to centralize them.

The long-term pipeline is:

```text
inputs -> generation -> transformation -> analysis -> composition -> optimization -> export
```

Larger pipelines should be expressed through the shared workflow stack rather than through a second asset-specific DAG implementation.

## Completed foundation

### Reproducibility core

- [x] Versioned asset specification and receipt contracts.
- [x] Canonical spec hashing and SHA-256 artifact identities.
- [x] Execution-environment fingerprints without timestamps, host names, user names, or absolute checkout paths.
- [x] Explicit randomness contracts (`none` or `seeded`).
- [x] Fail-closed declared input/model verification.
- [x] Idempotent mutation results (`changed` / `unchanged`).
- [x] Non-mutating exact rebuild verification.
- [x] Content-addressed generation cache that never substitutes for provenance evidence.

### Generation foundation

Procedural and local model generation share one provenance architecture rather than model-specific pipelines.

- [x] Shared versioned generation-receipt contract for `procedural`, `model`, and `utility` backends.
- [x] Deterministic seeded procedural reference generator.
- [x] Generic adapter result/evidence and replay contract.
- [x] Local Stable Diffusion adapter with a hash-pinned Diffusers pipeline bundle and no hidden downloads.
- [x] Local TripoSR image-to-3D adapter with explicit source input, hash-pinned dependencies, and no hidden downloads.
- [x] Generation-to-processing handoff with content-hash and generation-receipt lineage.

Exact reproducibility is established by replayed output bytes, never inferred from a seed, backend kind, or model family.

### Stabilization and consumer proof

- [x] Published schemas are immutable; new semantics require new schema versions.
- [x] Stable CLI exit semantics and a deliberately small root programmatic API.
- [x] Deterministic package/coding-tooling capabilities.
- [x] Clean-room/fault-injection coverage for corruption, missing dependencies, environment drift, and repeated/idempotent operation.
- [x] Zoo and Medieval consumers exercise the public CLI/spec contract.
- [x] `stability:check` and the accepted-consumer manifest make release readiness mechanical.

## Capability roadmap

### Milestone A — Unified asset operation system — IN PROGRESS

Make every generation, processing, analysis, composition, and export capability describable through one small runtime-neutral operation contract while preserving existing published generation/processing contracts.

First slices:

- [x] Runtime `AssetRef` v1 value with content identity, media/type identity, byte length, and deterministic metadata.
- [x] Runtime `AssetOperationDescriptor` v1 with typed input/output ports and parameter description.
- [x] Operation registry with deterministic lookup/list behavior and duplicate rejection.
- [x] Uniform operation input/result validation.
- [x] Canonical operation build/cache key derived from operation identity, implementation identity, parameters, and validated input asset references.
- [x] Content-addressed intermediate artifact resolution for operation outputs, with idempotent writes and fail-closed content verification.
- [x] Wrap the existing generation backends behind operation adapters without changing their authoritative spec/receipt semantics.
  - [x] Prove the boundary with `builtin.procedural.svg-scatter@1`: explicit seed in operation build identity, authoritative backend reuse, content-addressed output, and byte/observation parity with the legacy generation path.
  - [x] Wrap `model.stable-diffusion.diffusers@1` as `image.stable-diffusion.generate@1` with the exact pipeline bundle as a content-addressed input and execution-environment identity in the build key.
  - [x] Wrap `model.triposr@1` as `mesh.triposr.generate@1` with prepared image and complete TripoSR/source/DINO bundle inputs, preserving raw OBJ/GLB generation semantics.
- [ ] Wrap existing processing operations behind the same operation boundary without moving their algorithms into this repository.
  - [x] Prove `mesh.simplify@1` against the exact accepted `three-d-lod` revision from `moritzbrantner/3d-lab`, using a verified object-store input, the shared process-adapter protocol, receipt-compatible observations, and a content-addressed mesh output.
  - [x] Wrap `mesh.lod_chain@1` against the pinned source-based `three-d-lod-chain` processor with deterministic exact-decimal per-level budget materialization, exact source/bundle validation, and content-addressed index evidence.
  - [ ] Extend the same boundary to `animation.resample` and `animation.reduce` once their authoritative processor adapters are available.
- [x] Prove the generic operation contract with at least one current generator and one current external processor before publishing immutable operation schemas.
- [x] Exercise the descriptor/executor bridge through exact accepted `workflow-editor` and `workflow-runner` revisions before freezing the new operation schemas.
  - [x] Derive editor node templates and structural `AssetRef` port types from the operation descriptor rather than maintaining a second node catalog.
  - [x] Dispatch compiled nodes through one generic `asset.operation` runner executor keyed by the same operation identity.
  - [x] Keep observations and execution evidence outside editable workflow documents and graph outputs.
  - [x] Preserve asset value cardinality as array-valued workflow ports rather than confusing it with workflow connection cardinality.

Acceptance boundary: existing root imports, CLI behavior, published schemas, generation receipts, processing receipts, and exact-replay rules remain compatible. `stability/processors.json` pins accepted external processor evidence separately from consumer evidence, and `stability/workflow-stack.json` pins the workflow contract consumers used to prove the bridge.

### Milestone B — Workflow integration — STARTED

Use the shared workflow system instead of implementing an asset-specific DAG.

- [x] Derive workflow-editor node templates from asset operation descriptors.
- [x] Derive a workflow-runner executor from the same operation registrations.
- [x] Compile asset operation nodes through the execution-neutral workflow contract.
- [x] Keep workflow execution state and operation evidence outside editable asset/workflow documents.
- [ ] Add a small deterministic multi-node reference workflow covering generate -> transform -> compose -> export once compatible transform/composition operations exist.

### Milestone C — Classic deterministic image toolkit

Build the high-value deterministic processing vocabulary before aggressively widening model-backed features.

- Resize/resample, crop/pad, rotate/flip, and colorspace conversion.
- Exposure, contrast, levels, grayscale, threshold, blur, sharpen, and generic convolution.
- Edge detection, morphology, alpha/mask operations, palette reduction, quantization, and dithering.
- Channel extraction/combination plus image metadata and histogram analysis.

Each operation remains independently callable, cacheable, inspectable, and composable.

### Milestone D — Procedural generation

Expand deterministic/seeded generation through authoritative procedural implementations.

- 2D noise, gradients, patterns, Voronoi/cellular fields, SDF/vector shapes, tiling textures, height maps, and normal maps.
- 3D primitives, terrain, heightfield-to-mesh, extrusion, revolution, parametric surfaces, and scatter/distribution.
- Later audio synthesis primitives such as oscillators, envelopes, and deterministic noise.

Seeds remain inputs; replayed output is still the reproducibility proof.

### Milestone E — Asset composition

Keep asset composition in `asset-tooling` and process composition in workflow-editor.

- Image layers, masks, blend modes, transforms, and channel/material packing.
- Sprite/atlas assembly.
- Mesh and scene assembly where the operation produces a new asset.
- Reusable multi-step recipes become composed/nested workflows, not giant special-case asset operations.

### Milestone F — AI asset operations

Treat model-backed capabilities as another operation family rather than a separate architecture.

- Text-to-image, image-to-image, inpainting, outpainting, texture generation.
- Segmentation, background removal, detection, depth/normal estimation, captioning, embeddings, and classification.
- Super-resolution, denoising, deblurring, and other enhancement operations.
- Image/text-to-3D where authoritative local model implementations are available.

Model acquisition remains separate from execution; output-affecting model/config bytes must remain declared and hash-pinned.

### Milestone G — Texture and material pipeline

- Texture-set generation and validation.
- Normal/roughness/metalness/AO derivation where semantics are explicit.
- Channel packing and material-bundle assembly.
- Resolution/format variants and platform-oriented compression adapters.
- Provenance from final material bundle back to every source/generation operation.

### Milestone H — 3D production asset profile

Grow the current traceable 3D processing contracts into a production profile without moving renderer/runtime semantics into asset-tooling.

- Coordinate system, scale, transforms, materials, animation naming, and collision-proxy conventions.
- Mesh simplification and source-based LOD chains.
- Animation resampling/reduction and explicit skinned-mesh evidence.
- Mesh/scene validation and export normalization.

### Milestone I — Asset analysis and validation

Add operations that measure assets without mutating them.

- Dimensions, channels, color-space and alpha diagnostics.
- Mesh topology, bounds, triangle/material budgets, UV and normal diagnostics.
- Audio/video metadata and integrity checks when those domains arrive.
- Policy/budget validation that emits structured evidence suitable for workflow branching and CI.

### Milestone J — Audio and video operations

Add these only after the generic operation and workflow boundaries have proven reusable.

- Deterministic audio transforms, resampling, normalization, slicing, and composition.
- Video frame/clip transforms and metadata analysis.
- Model-backed audio/video operations through the same provenance rules.
- Keep playback/runtime behavior outside the asset build contract unless output is explicitly baked.

### Milestone K — Asset workbench and catalog

Build a domain-shaped UI using workflow-editor rather than a bespoke graph editor.

- Palette grouped by generation, procedural, image, filters, AI, composition, texture, mesh, animation, audio/video, analysis, and export.
- Node parameter controls, typed ports, previews, and validation diagnostics.
- External execution overlay showing node state, provenance, implementation/model identity, content hash, and reproducibility evidence.
- GitHub Pages catalog for previews, variant comparison, provenance, failures, and approved versions. Avoid decorative counters.

### Milestone L — Scaled execution and reusable workflow library

Only after representative local asset workflows work correctly:

- Deterministic parallel stages for independent operations.
- CPU/GPU resource budgets and executor lifecycle/isolation.
- Idempotent checkpoint/resume of safe nodes.
- Batch generation of variants through cached intermediate assets.
- Reusable workflow library for common texture, material, mesh, sprite, and model-assisted recipes.
- Distributed execution remains an engine/worker concern rather than an asset-tooling core concern.

## Continuous consumer, processor, and workflow-contract proof

Keep consumer-specific runtime semantics, processor algorithms, and generic workflow infrastructure outside this repository. `stability/consumers.json` records exact merged consumer evidence; `stability/processors.json` records exact external processor implementations used to prove operation adapters; `stability/workflow-stack.json` records the exact workflow-editor/workflow-runner revisions used to prove the projection and execution bridge. The Stability workflow reruns the current tool head against all three boundaries. Add future entries only when they provide meaningful additional contract coverage rather than simply increasing a count.
