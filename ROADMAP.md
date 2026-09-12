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
- [x] Verified Hugging Face model acquisition that resolves requested refs to immutable commit SHAs, validates declared license metadata, hashes every model file, emits a deterministic offline-verifiable bundle/receipt, and remains outside generation.
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

### Milestone A — Unified asset operation system — COMPLETE

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
- [x] Wrap existing processing operations behind the same operation boundary without moving their algorithms into this repository.
  - [x] Prove `mesh.simplify@1` against the exact accepted `three-d-lod` revision from `moritzbrantner/3d-lab`, using a verified object-store input, the shared process-adapter protocol, receipt-compatible observations, and a content-addressed mesh output.
  - [x] Wrap `mesh.lod_chain@1` against the pinned source-based `three-d-lod-chain` processor with deterministic exact-decimal per-level budget materialization, exact source/bundle validation, and content-addressed index evidence.
  - [x] Wrap `animation.resample@1` and `animation.reduce@1` against the exact merged `three-d-animation` processor revision, preserving local-space interpolation/reduction authority in `3d-lab` while validating content-addressed inputs, output structure, endpoint evidence, and requested error caps here.
- [x] Prove the generic operation contract with at least one current generator and one current external processor before publishing immutable operation schemas.
- [x] Exercise the descriptor/executor bridge through exact accepted `workflow-editor` and `workflow-runner` revisions before freezing the new operation schemas.
  - [x] Derive editor node templates and structural `AssetRef` port types from the operation descriptor rather than maintaining a second node catalog.
  - [x] Dispatch compiled nodes through one generic `asset.operation` runner executor keyed by the same operation identity.
  - [x] Keep observations and execution evidence outside editable workflow documents and graph outputs.
  - [x] Preserve asset value cardinality as array-valued workflow ports rather than confusing it with workflow connection cardinality.

Acceptance boundary: existing root imports, CLI behavior, published schemas, generation receipts, processing receipts, and exact-replay rules remain compatible. `stability/processors.json` pins accepted external processor evidence separately from consumer evidence, and `stability/workflow-stack.json` pins the workflow contract consumers used to prove the bridge.

### Milestone B — Workflow integration — COMPLETE

Use the shared workflow system instead of implementing an asset-specific DAG.

- [x] Derive workflow-editor node templates from asset operation descriptors.
- [x] Derive a workflow-runner executor from the same operation registrations.
- [x] Compile asset operation nodes through the execution-neutral workflow contract.
- [x] Keep workflow execution state and operation evidence outside editable asset/workflow documents.
- [x] Add a small deterministic multi-node reference workflow covering generate -> transform -> compose -> export: two procedural audio sources feed a gain transform and typed `json.array`, then `audio.mix`, with a typed terminal export of the final content-addressed Audio `AssetRef`; repeated execution must produce the same final SHA-256.

### Milestone C — Classic deterministic image toolkit — COMPLETE

Build the high-value deterministic processing vocabulary before aggressively widening model-backed features.

- [x] Resize/resample, crop/pad, rotate/flip, and explicit sRGB ↔ linear-sRGB conversion over canonical straight-alpha RGBA8 image domains.
- [x] Exposure, contrast, levels, grayscale, threshold, alpha-correct blur, sharpen, and bounded generic integer convolution.
- [x] Sobel edge detection, luma/alpha morphology, alpha-mask application, palette mapping, uniform quantization, and ordered Bayer dithering.
- [x] Channel extraction/combination plus non-mutating image metadata and exact 256-bin channel/luma histogram analysis.
- [x] Deterministic standard image codec/quality fixtures and reusable perturbation recipes where exact implementation identity is part of evidence.

Each operation remains independently callable, cacheable, inspectable, and composable. Output-producing operations emit content-addressed image assets; analysis operations emit deterministic observations without inventing synthetic assets.

### Milestone D — Procedural generation — IN PROGRESS

Expand deterministic/seeded generation through authoritative procedural implementations.

- [x] Seeded coordinate-hashed 2D white noise plus exact integer horizontal, vertical, and diagonal RGBA8 gradients.
- [x] Exact two-color checker/stripe patterns plus seeded jittered-cell Voronoi cell-color and nearest-feature-distance fields.
- [x] Integer circle/rounded-rectangle signed-distance fields plus canonical SVG circle/rounded-rectangle vector shapes.
- [x] Seeded periodic value-noise textures and grayscale height maps plus deterministic wrapped/clamped normal-map derivation.
- [x] Deterministic centered OBJ box/plane primitives and RGBA8 heightfield-to-mesh generation with explicit integer/half-unit geometry.
- [ ] Additional 3D primitives, terrain shaping, extrusion, revolution, parametric surfaces, and seeded scatter/distribution.
- [x] Initial deterministic audio synthesis for silence, square, saw, and explicitly seeded noise.
- [ ] Broader procedural audio primitives such as additional oscillators and envelopes where exact sample semantics are useful.

Seeds remain explicit operation inputs for seeded generators; replayed output bytes remain the reproducibility proof.

### Milestone E — Asset composition

Keep asset composition in `asset-tooling` and process composition in workflow-editor.

- [ ] Image layers, masks, blend modes, and transforms beyond the current narrow image operations.
- [x] Channel/material packing foundation through deterministic ORM packing and content-addressed PBR material bundles.
- [ ] Sprite/atlas assembly.
- [ ] Mesh and scene assembly where the operation produces a new asset.
- [ ] Reusable multi-step recipes as composed/nested workflows rather than giant special-case asset operations.

### Milestone F — AI asset operations

Treat model-backed capabilities as another operation family rather than a separate architecture.

- Text-to-image, image-to-image, inpainting, outpainting, texture generation.
- Segmentation, background removal, detection, depth/normal estimation, captioning, embeddings, and classification.
- Super-resolution, denoising, deblurring, and other enhancement operations.
- Image/text-to-3D where authoritative local model implementations are available.

Model acquisition remains separate from execution; output-affecting model/config bytes must remain declared and hash-pinned.

### Milestone G — Texture and material pipeline — IN PROGRESS

- [ ] Texture-set generation and validation as a first-class aggregate contract.
- [x] Deterministic normal-map derivation from explicit height sources.
- [ ] Roughness/metalness/AO derivation where source semantics justify deterministic derivation rather than fabrication.
- [x] ORM channel packing with explicit linear channel semantics.
- [x] Content-addressed PBR material-bundle assembly with exact texture lineage and explicit normal-Y convention.
- [ ] Resolution/format variants and platform-oriented compression adapters such as KTX2 when the authoritative compressor boundary is clear.
- [x] Provenance from the current material bundle back to every referenced source asset.

### Milestone H — 3D production asset profile — IN PROGRESS

Grow the current traceable 3D processing contracts into a production profile without moving renderer/runtime semantics into asset-tooling.

- [ ] Coordinate system, scale, transforms, material naming, animation naming, and collision-proxy conventions as a complete profile.
- [x] Mesh simplification and source-based LOD chains through pinned authoritative processors.
- [x] Animation resampling/reduction with explicit endpoint/error evidence through pinned authoritative processors.
- [ ] Explicit skinned-mesh production-profile evidence.
- [ ] Mesh/scene normalization and export normalization.

### Milestone I — Asset analysis and validation — IN PROGRESS

Add operations that measure assets without mutating them.

- [x] Image dimensions, channels, color-space/alpha diagnostics, and exact channel/luma histograms.
- [x] OBJ mesh topology, bounds, triangle counts, material/object/group records, UV/normal coverage, and unused/repeated-index diagnostics.
- [x] Explicit OBJ policy validation for vertex/triangle budgets, triangle-only policy, required normals, unused vertices, and unsupported records, with structured violations suitable for workflow branching and CI.
- [ ] Equivalent structured analysis for normalized glTF/GLB and other production mesh/scene formats.
- [ ] Audio/video metadata and integrity analysis beyond the current canonical audio validation.

### Milestone J — Audio and video operations — IN PROGRESS

The generic operation/workflow boundary is already reused by a substantial canonical audio stack; remaining work is primarily broader generation and video coverage.

- [x] Canonical PCM16 WAV contract and deterministic normalization.
- [x] Deterministic audio trim, resample, mono/stereo mapping, gain, fade, and offline ordered multi-track mixing.
- [x] Deterministic procedural audio synthesis for the initial silence/square/saw/seeded-noise vocabulary.
- [x] Provider-neutral model-backed audio generation operation with explicit model identity and exact-vs-approximate reproducibility classification.
- [ ] Pin and prove representative real model-backed audio adapters rather than widening the generic contract further.
- [ ] Video frame/clip transforms and metadata analysis through the same operation/provenance rules.
- [ ] Continue to keep playback/runtime behavior outside the asset build contract unless output is explicitly baked.

### Milestone K — Asset workbench and catalog — IN PROGRESS

Build domain-shaped discovery/editing surfaces around the same operation/catalog contracts rather than a bespoke second graph engine.

- [x] Deterministic GitHub Pages catalog projection with search/filtering and candidate/pinned/canonical provenance state.
- [x] Pages provenance details for provider, license/required attribution, exact revision/path/hash/byte length, durable storage path, purpose, and tags.
- [x] Hash-pinned ordinary image/audio browser previews that remain explicitly non-authoritative evidence.
- [ ] Rich preview/variant comparison for additional media such as canonical GLB/material assets without making the UI the source of truth.
- [ ] Workflow-editor palette grouped by generation, procedural, image, filters, AI, composition, texture, mesh, animation, audio/video, analysis, and export.
- [ ] Node parameter controls, typed ports, previews, and validation diagnostics.
- [ ] External execution overlay showing node state, provenance, implementation/model identity, content hash, and reproducibility evidence.

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
