# asset-tooling

Reproducible, traceable tooling for generating and processing game and application assets.

The repository treats generated and processed assets as build artifacts. Generation intent, generator/model identity, declared dependency bytes, execution environment, outputs, processing observations, and replay evidence are recorded so reproducibility can be tested instead of assumed.

## Generation

The generation architecture now supports the same provenance model across:

- deterministic/seeded procedural generators;
- local model-backed generators such as Stable Diffusion and TripoSR;
- utility backends used to prove contracts.

`builtin.procedural.svg-scatter` is the deterministic procedural reference backend. `model.stable-diffusion.diffusers` consumes a hash-pinned local Diffusers pipeline bundle. `model.triposr` consumes a hash-pinned bundle containing TripoSR source, weights/config, and its local DINO image-tokenizer model.

Model generation is offline and fail-closed: model acquisition is separate from generation, and undeclared cache/network dependencies are not accepted as reproducibility evidence. A seed is an input, not proof of deterministic output.

See `docs/generation.md`, `docs/stable-diffusion.md`, and `docs/triposr.md`.

## Processing

The versioned 3D processing receipt contracts cover mesh simplification, source-based LOD chains, animation resampling, and animation reduction while keeping the authoritative algorithms in their domain repositories. Cross-field validators check request/result consistency and replay evidence without copying those algorithms into `asset-tooling`.

Generated artifacts feed processing through a content-addressed handoff: the processing receipt input SHA-256 is exactly the generation receipt output SHA-256. The supplemental handoff lineage records which generation receipt supplied those bytes without modifying the published processing receipt v1/v2 schemas.

See `docs/3d-processing.md` and `docs/generation-processing-handoff.md`.

## CLI

```text
asset-tooling validate <asset-spec.json>
asset-tooling generate <asset-spec.json> [--receipt <relative-path>]
asset-tooling verify <asset-spec.json> [--receipt <relative-path>]
asset-tooling processing-input <asset-spec.json> --media-type <media-type> [--receipt <relative-path>]
asset-tooling fingerprint
```

Exact reproducibility is established by replayed output bytes. Backend kind, absence or presence of a seed, deterministic runtime switches, or a familiar model family are never accepted as proof on their own.
