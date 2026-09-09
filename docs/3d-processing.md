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
4. Normalized operation parameters. Defaults must be materialized rather than inferred later.
5. The output artifact SHA-256 and media/type identifier.
6. The environment fingerprint used by the wider asset-tooling contract.
7. A reproducibility result describing whether an exact repeated output was actually verified.

The receipt is about evidence, not claims. A deterministic-looking algorithm is not marked exact merely because it accepts a seed or has no obvious randomness. Exact reproducibility is established by repeating the processing under the recorded environment and comparing output hashes.

## Mesh simplification parameters

A simplification adapter should materialize at least the source triangle count, requested triangle count or ratio, geometric error limit, border-lock policy, actual resulting triangle count, reported simplification error, and simplifier implementation identifier. An LOD chain must also make clear that each level was generated from the original source rather than recursively from the preceding LOD when that is the authoritative algorithm contract.

Skinned meshes require additional evidence. Joint/weight attribute preservation and the deformation-aware error policy must be explicit before a receipt can claim that a skinned mesh was safely simplified. A static-mesh simplifier must not silently accept a skinned asset by dropping those semantics.

## Animation processing parameters

Animation resampling or key reduction must record the source time domain, sample rate or target times, channel interpolation rules, quaternion convention, error tolerances, and whether the operation is performed on local transforms, world transforms, or deformed geometry.

This is separate from smooth runtime playback. A frame-rate-independent playback clock and clip cross-fade do not create a new asset and therefore do not need an asset-processing receipt unless their output is explicitly baked.

## Consumer rule

Consumers may use a processed artifact without understanding the implementation internals, but they must be able to retain or resolve its receipt. Re-running the same operation should either reproduce the exact artifact hash or produce explicit evidence explaining why reproducibility is only structural or remains unverified.
