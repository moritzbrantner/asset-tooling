# Reproducible media quality fixtures

`asset-tooling` can supply deterministic mutation evidence for retrieval and recognition corpora without owning their relevance semantics.

The boundary is deliberate:

- `asset-tooling` owns source-content identity, codec/runtime identity, deterministic transformations, content-addressed outputs, and step lineage.
- A consumer such as `media-similarity` owns labels such as positive, hard negative, same identity, expected rank, or relevance grade, and owns the resulting retrieval metrics.

## Standard-image codec boundary

`image.decode@1` accepts JPEG, PNG, WebP, BMP, or TIFF image assets and emits the canonical straight-alpha sRGB RGBA8 representation used by the deterministic image toolkit. `image.encode.png@1` converts that canonical representation to PNG.

Both operations use an explicitly observed FFmpeg runtime. Their build identity records the concrete FFmpeg version, and decode additionally records FFprobe identity. Machine-local executable paths are execution details and do not enter build identity. Missing or failing tools fail closed.

The codec boundary exists to connect real-world corpus inputs to deterministic image operations. It does not make FFmpeg part of the asset-tooling core algorithm vocabulary.

## Perturbation recipes

`executeImagePerturbationRecipe(...)` composes existing image operations without creating another workflow engine. A recipe is an ordered list of supported operation ids and parameters. Each step is executed through the normal operation adapter and records:

- operation id/version;
- normalized parameters;
- implementation identity;
- deterministic cache/build key;
- input and output `AssetRef` values;
- operation observations.

The recipe itself has a canonical SHA-256 identity. Repeating a recipe against identical source bytes must resolve to identical final content and lineage identities.

The initial recipe vocabulary deliberately focuses on useful retrieval perturbations: resize, crop, pad, quarter-turn rotation, flip, exposure, contrast, grayscale, blur, and sharpen. Consumers can combine these into harder fixtures such as crop + resize, contrast + blur, or resize + sharpen while preserving exact provenance.

## Corpus integration

A retrieval corpus should acquire and pin original source bytes separately from mutation. License evidence and source hashes belong to the catalog/source contract. Derived fixture bytes are disposable and reproducible; relevance relationships remain consumer data.

A typical consumer flow is:

1. verify or import a hash-pinned source asset;
2. decode it to canonical RGBA8 through `image.decode@1`;
3. run one or more perturbation recipes;
4. encode derived images through `image.encode.png@1`;
5. record the resulting source/output hashes and recipe lineage beside the consumer-owned labels;
6. evaluate retrieval quality from those labels.

This keeps the asset pipeline reusable for other search, vision, regression, and robustness consumers without turning asset-tooling into a benchmark-specific repository.
