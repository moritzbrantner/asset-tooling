# Traceable 3D processing

3D asset processing must be reproducible and inspectable for the same reason generation is: a derived mesh is an artifact, not an opaque editor side effect.

## Boundary

Algorithm ownership stays in the domain repository. For example, `3d-lab` owns its renderer-independent mesh simplification and LOD semantics. `asset-tooling` owns the provenance envelope around an invocation: what ran, with which exact implementation and dependency versions, against which bytes, with which parameters and environment, what the processor actually observed, and which bytes came out.

Do not copy mesh simplification algorithms into this repository. A processor adapter should call the authoritative implementation and emit a receipt.

## Operations

The first 3D processing vocabulary is intentionally small:

- `mesh.simplify`: derive one simplified mesh from one source mesh.
- `mesh.lod_chain`: derive a named/ordered family of levels from the same source mesh.
- `animation.resample`: bake an animation onto an explicit time grid.
- `animation.reduce`: remove redundant animation keys while staying within an explicit error policy.

Runtime playback, interpolation, cross-fading, renderer LOD selection, and physics interpolation are not asset-processing operations. They belong to their runtime owners and should not be smuggled into an asset receipt.

## Receipt model

Every processing receipt records three different kinds of evidence:

1. **Parameters** — normalized invocation intent. Defaults must be materialized rather than inferred later.
2. **Observations** — deterministic facts returned by the processor, such as actual triangle counts or measured reduction error.
3. **Reproducibility** — whether a repeated invocation under the recorded environment actually reproduced the output bytes.

Keeping those separate matters. A target triangle count is not an observed result, and an observed result is not proof that the same bytes can be reproduced later.

Every receipt also records:

- schema version and operation;
- implementation identifier plus immutable revision when available;
- dependency versions that can affect output;
- input artifact SHA-256 and media type;
- output artifact SHA-256 and media type;
- environment fingerprint.

The receipt is about evidence, not claims. A deterministic-looking algorithm is not marked exact merely because it accepts a seed or has no obvious randomness. Exact reproducibility is established by repeating the processing under the recorded environment and comparing output hashes.

An `exact` receipt must contain `repeatOutputSha256`. JSON Schema can require that field but cannot express equality with another arbitrary property, so consumers must additionally verify that `reproducibility.repeatOutputSha256 == output.sha256`. `scripts/validate-reproducibility.py` performs that cross-field check after schema validation. `structural` and `unverified` receipts must instead contain `evidence.reason` explaining why exact replay has not been established.

## Cross-field validation

JSON Schema validates structure but cannot express many relationships between fields. `scripts/validate-processing-observations.py` therefore checks semantic invariants after schema validation.

For mesh simplification it verifies that:

- observed source triangles equal the requested source triangle count;
- the observed requested triangle budget equals the invocation target;
- index count equals actual triangle count × 3;
- actual triangles do not exceed the source;
- observed relative error does not exceed the configured error ceiling.

For LOD chains it additionally verifies that:

- observed and requested level counts match;
- each observed level corresponds to the requested triangle ratio;
- observed level numbering is stable and ordered;
- derived requested triangle counts are strictly decreasing;
- each level's actual index count and error satisfy the same mesh invariants.

For animation resampling it verifies an ordered target time grid inside the declared source time domain. For animation reduction it verifies that the keyframe count does not increase and that observed translation, rotation, and scale error remain within the configured tolerances.

## Mesh simplification parameters and observations

A simplification invocation materializes the source triangle count, requested triangle count, geometric error limit, and border-lock policy. Its observations record the actual triangle/index counts, source vertex count, reported relative error, and whether the result still references the source vertex buffer.

An LOD chain records every requested source-triangle ratio and explicitly records that levels are generated from the original source rather than recursively from the preceding LOD. Observations record the derived requested count, actual count, relative error, and SHA-256 of each resulting index buffer.

The top-level LOD-chain output is a manifest or bundle artifact whose hash covers the ordered family. Per-level index hashes make it possible to identify exactly which topology changed without pretending each level is an unrelated processing invocation.

Skinned meshes require additional evidence. Joint/weight attribute preservation and the deformation-aware error policy must be explicit before a receipt can claim that a skinned mesh was safely simplified. A static-mesh simplifier must not silently accept a skinned asset by dropping those semantics.

## Animation processing parameters and observations

Animation resampling records the source time domain, explicit target time grid, channel interpolation rules, and transform space. Its observations record source/result keyframe counts, channel count, and resulting duration.

Animation reduction records translation/rotation/scale error tolerances, transform space, and endpoint-preservation policy. Its observations record the source/result keyframe counts and maximum observed error for every bounded transform component.

This is separate from smooth runtime playback. A frame-rate-independent playback clock and clip cross-fade do not create a new asset and therefore do not need an asset-processing receipt unless their output is explicitly baked.

## Consumer rule

Consumers may use a processed artifact without understanding the implementation internals, but they must be able to retain or resolve its receipt. Re-running the same operation should either reproduce the exact artifact hash or produce explicit evidence explaining why reproducibility is only structural or remains unverified.
