# asset-tooling

Reproducible, traceable tooling for generating and processing game and application assets.

The repository treats generated and processed assets as build artifacts. Generation intent, generator/model identity, declared dependency bytes, execution environment, outputs, processing observations, and replay evidence are recorded so reproducibility can be tested instead of assumed.

## Stability

The reusable core has completed its first stabilization milestone. Published schema versions are immutable compatibility contracts, CLI exit semantics and the deliberately small root programmatic API are protected by deterministic tests, generation cache reuse is fail-closed and content-addressed, and the package shape is validated without publishing it.

The same public CLI/spec boundary is now proven by merged Zoo and Medieval consumers. `bun run stability:check` exercises the local compatibility/package/reproducibility gate, while the hosted `Stability` workflow also runs the current `asset-tooling` head against the exact accepted consumer commits recorded in `stability/consumers.json`.

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

## Unified asset operations

Milestone A introduces a runtime-neutral operation contract so generation, processing, analysis, composition, and export capabilities can eventually share one typed workflow vocabulary without replacing their authoritative algorithms or existing receipt contracts.

The focused `asset-tooling/operations` package subpath provides runtime `AssetRef` values, versioned operation descriptors, a deterministic operation registry, typed input/result validation, and canonical build/cache identities. The root package API remains deliberately small.

Operation descriptors are data rather than executors. This is the intended bridge to `workflow-editor` node templates and `workflow-runner` executors in the next milestone, without implementing another DAG/runtime inside this repository.

See `docs/operations.md` and `ROADMAP.md`.

## CLI

```text
asset-tooling validate <asset-spec.json>
asset-tooling generate <asset-spec.json> [--receipt <relative-path>]
asset-tooling verify <asset-spec.json> [--receipt <relative-path>]
asset-tooling processing-input <asset-spec.json> --media-type <media-type> [--receipt <relative-path>]
asset-tooling fingerprint
```

Exact reproducibility is established by replayed output bytes. Backend kind, absence or presence of a seed, deterministic runtime switches, cache presence, or a familiar model family are never accepted as proof on their own.

## Programmatic API

Consumers importing the package root receive only the high-level operations `validateSpec`, `generateAsset`, `verifyAsset`, and `prepareProcessingHandoff`. Versioned schemas are separately available through the `./schemas/*` package export. Backend, cache, hashing, environment, and receipt-construction internals are deliberately not part of the public package API.

The additive `asset-tooling/operations` subpath contains the Milestone A operation-contract surface; it does not widen the root export.
