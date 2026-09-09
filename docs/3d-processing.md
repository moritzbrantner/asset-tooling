# Traceable 3D processing

3D asset processing must be reproducible and inspectable for the same reason generation is: a derived mesh is an artifact, not an opaque editor side effect.

## Boundary

Algorithm ownership stays in the domain repository. For example, `3d-lab` owns its renderer-independent mesh simplification and LOD semantics. `asset-tooling` owns the provenance envelope around an invocation: what ran, with which exact implementation and dependency versions, against which bytes, with which parameters and environment, and which bytes came out.

Do not copy mesh simplification algorithms into this repository. A processor adapter should call the authoritative implementation and emit a receipt.

## Operations

The first 3D processing vocabulary is intentionally small:

- `mesh.simplify`: derive one simplified mesh from one source mesh.
- `mesh.lod_chain`: derive a named/ordered family of levels from the same source mesh.
- `animation.resample`: bake an animation onto an explicit time grid.
- `animation.reduce`: remove redundant animation keys while staying within an explicit error policy.

Runtime playback, interpolation, cross-fading, renderer LOD selection, and physics interpolation are not asset-processing operations. They belong to their runtime owners and should not be smuggled into an asset receipt.

## Required receipt evidence

Every processing receipt records:

1. Schema version and operation.
2. An implementation identifier plus immutable revision when available. Dependency versions that affect output are recorded separately; for example a `3d-lab` simplifier using `meshopt` must record the exact `meshopt` version.
3. The input artifact SHA-256 and media/type identifier.
4. Normalized operation parameters. Defaults must be materialized rather than inferred later, and schema v1 selects a strict parameter shape for each operation.
5. The output artifact SHA-256 and media/type identifier.
6. The environment fingerprint used by the wider asset-tooling contract.
7. A reproducibility result describing whether an exact repeated output was actually verified.

The receipt is about evidence, not claims. A deterministic-looking algorithm is not marked exact merely because it accepts a seed or has no obvious randomness. Exact reproducibility is established by repeating the processing under the recorded environment and comparing output hashes.

An `exact` receipt must contain `repeatOutputSha256`. JSON Schema can require that field but cannot express equality with another arbitrary property, so consumers must additionally verify that `reproducibility.repeatOutputSha256 == output.sha256`. `scripts/validate-reproducibility.py` performs that cross-field check after schema validation. `structural` and `unverified` receipts must instead contain `evidence.reason` explaining why exact replay has not been established.

## Mesh simplification parameters

A simplification invocation materializes the source triangle count, requested triangle count, geometric error limit, and border-lock policy. An LOD chain additionally records every requested source-triangle ratio and explicitly records that levels are generated from the original source rather than recursively from the preceding LOD.

Actual resulting triangle counts and reported simplification error are deterministic processor observations rather than invocation parameters. They should remain in the authoritative processor result and can be added to a later versioned receipt observation envelope without weakening the strict v1 invocation schema.

Skinned meshes require additional evidence. Joint/weight attribute preservation and the deformation-aware error policy must be explicit before a receipt can claim that a skinned mesh was safely simplified. A static-mesh simplifier must not silently accept a skinned asset by dropping those semantics.

## Animation processing parameters

Animation resampling records the source time domain, the explicit target time grid, channel interpolation rules, and transform space. Animation reduction records translation/rotation/scale error tolerances, transform space, and endpoint-preservation policy. Defaults are not implicit.

This is separate from smooth runtime playback. A frame-rate-independent playback clock and clip cross-fade do not create a new asset and therefore do not need an asset-processing receipt unless their output is explicitly baked.

## Consumer rule

Consumers may use a processed artifact without understanding the implementation internals, but they must be able to retain or resolve its receipt. Re-running the same operation should either reproduce the exact artifact hash or produce explicit evidence explaining why reproducibility is only structural or remains unverified.
