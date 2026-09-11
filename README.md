# asset-tooling

Reproducible, traceable tooling for generating and processing game and application assets.

The repository treats generated and processed assets as build artifacts. Generation intent, generator/model identity, declared dependency bytes, execution environment, outputs, processing observations, and replay evidence are recorded so reproducibility can be tested instead of assumed.

## Stability

The reusable core has completed its first stabilization milestone. Published schema versions are immutable compatibility contracts, CLI exit semantics and the deliberately small root programmatic API are protected by deterministic tests, generation cache reuse is fail-closed and content-addressed, and the package shape is validated without publishing it.

The same public CLI/spec boundary is proven by merged Zoo and Medieval consumers. `bun run stability:check` exercises the local compatibility/package/reproducibility gate, while the hosted `Stability` workflow reruns the current `asset-tooling` head against exact accepted consumer commits, external processor revisions, and the pinned workflow-editor/workflow-runner conformance pair recorded under `stability/`.

The package remains `0.1.0` until a stable release is intentionally cut; stabilization readiness does not publish or tag a release by itself. See `docs/stability.md`.

## Generation

The generation architecture supports the same provenance model across:

- deterministic/seeded procedural generators;
- local model-backed generators such as Stable Diffusion and TripoSR;
- utility backends used to prove contracts.

`builtin.procedural.svg-scatter` is the deterministic procedural reference backend. `model.stable-diffusion.diffusers` consumes a hash-pinned local Diffusers pipeline bundle. `model.triposr` consumes a hash-pinned bundle containing TripoSR source, weights/config, and its local DINO image-tokenizer model.

Model generation is offline and fail-closed: model acquisition is separate from generation, and undeclared cache/network dependencies are not accepted as reproducibility evidence. A seed is an input, not proof of deterministic output.

See `docs/generation.md`, `docs/stable-diffusion.md`, `docs/triposr.md`, and `docs/cache.md`.

## Processing

The versioned 3D processing receipt contracts cover mesh simplification, source-based LOD chains, animation resampling, and animation reduction while keeping the authoritative algorithms in their domain repositories. Cross-field validators check request/result consistency and replay evidence without copying those algorithms into `asset-tooling`.

Generated artifacts feed processing through a content-addressed handoff: the processing receipt input SHA-256 is exactly the generation receipt output SHA-256. The supplemental handoff lineage records which generation receipt supplied those bytes without modifying the published processing receipt v1/v2 schemas.

See `docs/3d-processing.md` and `docs/generation-processing-handoff.md`.

## Canonical asset catalog and durable storage

The focused catalog boundary manages reusable third-party assets without conflating source discovery with trusted bytes. Provider policy, source identity, per-asset license evidence, exact byte pinning, durable storage, and downstream processing remain explicit stages.

Catalog/provider/storage manifests and provenance stay in normal Git. Approved payload bytes live under `assets/canonical/`, which is reserved for Git LFS through `.gitattributes`; this tree is intentionally outside the published npm package. `catalog/storage.json` is the closed-world mapping from a pinned catalog source to its one canonical LFS path.

A Git LFS pointer is not accepted as content evidence. `Validate / canonical-storage` checks out with LFS hydration, runs `git lfs fsck`, verifies that the payload tree exactly matches `catalog/storage.json`, and compares every hydrated payload's SHA-256 and byte length with the corresponding source pin. The ordinary cross-platform `bun run check` validates storage-manifest structure without downloading the full media corpus.

The `asset-tooling/catalog/storage` subpath is the consumer boundary for durable payloads. `readAssetCatalogStorageSource(...)` resolves only manifest-declared sources, rejects missing, drifted, symbolic-link, or pointer-only payloads, and verifies hydrated bytes against the catalog pin. `importAssetCatalogStorageSource(...)` then feeds those exact bytes through the existing canonical import into the consumer's disposable `.asset-tooling/objects` store, preserving the same provenance-bearing `AssetRef` and remaining idempotent on repeated imports. Network acquisition is never part of this consumer path.

The manually dispatched `Catalog Git LFS promotion` workflow acquires a registered shared source, measures or re-verifies its bytes, updates the source pin and storage manifest, places the payload under its deterministic `assets/canonical/<source-id>/...` path, stages it through Git LFS, and pushes a review branch. It never pushes canonical bytes directly to `main`; the resulting branch must still pass normal PR-triggered exact-head validation before integration.

CC0 is preferred; non-CC0 shared sources must retain explicit attribution, and providers such as Mixamo that should not be raw-redistributed remain project-local.

See `docs/catalog.md`.

## Unified asset operations

Milestone A introduces a runtime-neutral operation contract so generation, processing, analysis, composition, and export capabilities can share one small typed workflow vocabulary without replacing their authoritative algorithms or existing receipt contracts.

The focused `asset-tooling/operations` package subpath provides runtime `AssetRef` values, versioned operation descriptors, a deterministic operation registry, typed input/result validation, and canonical build/cache identities. `asset-tooling/operations/store` provides verified content-addressed intermediate objects. The root package API remains deliberately small.

The generator proof lives under `asset-tooling/operations/generation`: `procedural.svg.scatter@1` reuses the existing `builtin.procedural.svg-scatter@1` backend, maps its seed into operation build identity, writes through the object store, and is tested for byte/hash/observation parity with `generateAsset(...)`.

The processor proof lives under `asset-tooling/operations/processing`: `mesh.simplify@1` consumes a verified mesh `AssetRef`, invokes the exact accepted `three-d-lod` implementation from `moritzbrantner/3d-lab` through the shared process-adapter protocol, validates receipt-compatible observations, and stores the derived mesh as another content-addressed `AssetRef`. The processor algorithm and mesh semantics remain owned by `3d-lab`; `stability/processors.json` pins the accepted external revision.

The workflow bridge lives under `asset-tooling/operations/workflow`. It derives workflow-editor node templates from the same operation descriptors and provides one generic `asset.operation` workflow-runner executor. Asset-tooling owns this projection; workflow-editor and workflow-runner remain asset-agnostic. Operation observations are delivered through an external evidence callback instead of becoming workflow graph outputs.

See `docs/operations.md` and `ROADMAP.md`.

## CLI

```text
asset-tooling validate <asset-spec.json>
asset-tooling generate <asset-spec.json> [--receipt <relative-path>]
asset-tooling verify <asset-spec.json> [--receipt <relative-path>]
asset-tooling processing-input <asset-spec.json> --media-type <media-type> [--receipt <relative-path>]
asset-tooling fingerprint
```

Repository maintenance helpers include:

```text
bun run catalog:pin -- <catalog-source-id> <local-file>
bun run catalog:acquire -- <catalog-source-id> [destination-root]
bun run catalog:storage:check
bun run catalog:storage:verify
bun run catalog:lfs:promote -- <catalog-source-id>
```

Exact reproducibility is established by replayed output bytes. Backend kind, absence or presence of a seed, deterministic runtime switches, cache presence, Git LFS pointer identity, or a familiar model family are never accepted as proof on their own.

## Programmatic API

Consumers importing the package root receive only the high-level operations `validateSpec`, `generateAsset`, `verifyAsset`, and `prepareProcessingHandoff`. Versioned schemas are separately available through the `./schemas/*` package export. Backend, cache, hashing, environment, acquisition/promotion maintenance, and receipt-construction internals are deliberately not part of the public package API.

The additive `asset-tooling/operations`, `asset-tooling/operations/store`, `asset-tooling/operations/generation`, `asset-tooling/operations/processing`, `asset-tooling/operations/workflow`, `asset-tooling/catalog`, and `asset-tooling/catalog/storage` subpaths contain focused operation/catalog surfaces; they do not widen the root export.
