# Traceable 3D processing

3D asset processing must be reproducible and inspectable for the same reason generation is: a derived mesh is an artifact, not an opaque editor side effect.

## Boundary

Algorithm ownership stays in the domain repository. For example, `3d-lab` owns renderer-independent mesh simplification, LOD, and animation semantics. `asset-tooling` owns the provenance envelope around an invocation: what ran, with which exact implementation and dependency versions, against which bytes, with which parameters and environment, what the processor actually observed, and which bytes came out.

Do not copy mesh or animation algorithms into this repository. A processor adapter should call the authoritative implementation and emit a receipt.

## Schema evolution

`processing-receipt-v1.schema.json` is immutable. It remains the contract introduced by the first processing-receipt slice and does not require result observations.

`processing-receipt-v2.schema.json` adds mandatory, operation-specific `observations`. Existing v1 receipts remain valid against v1; producers that want the stronger request/result evidence opt into `schemaVersion: 2`. Never strengthen a published schema in place.

## Operations

The initial 3D processing vocabulary is intentionally small:

- `mesh.simplify`: derive one simplified mesh from one source mesh.
- `mesh.lod_chain`: derive an ordered family of levels from the same source mesh.
- `animation.resample`: bake animation channels onto an explicit time grid.
- `animation.reduce`: remove redundant animation keys while staying within explicit error tolerances.

Runtime playback, interpolation, cross-fading, renderer LOD selection, and physics interpolation are not asset-processing operations. They belong to their runtime owners and should not be smuggled into an asset receipt.

## V2 receipt model

A v2 processing receipt separates three kinds of evidence:

1. **Parameters** — normalized invocation intent. Defaults are materialized rather than inferred later.
2. **Observations** — deterministic facts returned by the processor, such as actual triangle counts or measured reduction error.
3. **Reproducibility** — whether a repeated invocation under the recorded environment actually reproduced the output bytes.

Keeping these separate matters. A target triangle count is not an observed result, and an observed result is not proof that the same bytes can be reproduced later.

Every receipt also records the operation, implementation/revision, output-affecting dependency versions, input/output artifact hashes and media types, and environment fingerprint.

The receipt is evidence, not a claim. Exact reproducibility is established by replay under the recorded environment and output-hash comparison. An `exact` receipt must contain `repeatOutputSha256`, and the supplemental validator requires it to equal `output.sha256`. `structural` and `unverified` receipts instead require explanatory evidence.

## Strict JSON

The receipt validators reject the non-standard Python JSON constants `NaN`, `Infinity`, and `-Infinity`. Cross-field validation also rejects non-finite numbers when called with an already-decoded in-memory object. Error metrics therefore cannot pass merely because comparisons against NaN evaluate false.

Numeric cross-field checks use integer/decimal arithmetic rather than coercing arbitrary JSON numbers to binary floats. Schema-valid large integers therefore remain validatable evidence instead of becoming an overflow path in the validator.

## Cross-field validation

JSON Schema validates structure but cannot express many relationships between fields. `scripts/validate-processing-observations.py` therefore checks semantic invariants after v2 schema validation.

### Mesh simplification

The validator verifies that:

- observed source triangles equal the requested source triangle count;
- the observed applied triangle budget equals `parameters.targetTriangleCount`;
- index count equals actual triangle count × 3;
- actual triangles do not exceed the source;
- observed relative error does not exceed the configured error ceiling.

### LOD chains

Each v2 LOD level materializes both `triangleRatio` and `targetTriangleCount`. The chain declares `budgetRounding: "nearest-ties-away-from-zero"`.

For positive triangle counts, the target is derived as:

`round_half_up(sourceTriangleCount × triangleRatio)`

and then clamped to `1..sourceTriangleCount-1`. The validator derives that count using exact integer/decimal arithmetic, checks the materialized parameter against it, checks the processor-observed applied count against the parameter, and requires strictly decreasing requested budgets. This prevents a receipt from pairing plausible ratios with unrelated counts.

Observed `resultTriangleCount` values must also be non-increasing in declared LOD order. Equal adjacent result sizes are allowed because the authoritative processor may legitimately hit the same achievable geometry floor for successive lower budgets; an increase is contradictory evidence because a later lower-detail level cannot contain more geometry than the preceding level.

LOD observations additionally record actual triangle/index counts, relative error, source-buffer sharing, and an SHA-256 for every resulting index buffer. The top-level LOD output can be a manifest or bundle whose hash covers the ordered family.

### Animation resampling

Target times must be strictly increasing and remain inside the declared source time domain. `resultKeyframeCount` is defined as the aggregate count across channels, so it must equal:

`len(targetTimesSeconds) × channelCount`

This proves that the processor actually baked every declared channel at every requested sample time rather than merely returning a schema-shaped result.

`observations.durationSeconds` is normalized evidence for the elapsed span of the requested grid, independent of the grid's absolute time origin. It must therefore equal `last(targetTimesSeconds) - first(targetTimesSeconds)`. A one-sample grid has duration `0`. This does not move animation semantics into `asset-tooling`: the domain processor still owns sampling and interpolation, while the receipt verifies that its reported duration is consistent with the invocation that was recorded.

### Animation reduction

Reduction must not increase the aggregate keyframe count, and observed translation, rotation, and scale errors must remain within their configured tolerances.

When `preserveEndpoints` is true, v2 additionally requires `observations.endpointsPreserved: true`. For a source with multiple keys, an endpoint-preserving result must retain at least two keys. This records endpoint preservation directly instead of trying to infer it only from a count.

## Mesh simplification parameters and observations

A simplification invocation materializes the source triangle count, requested triangle count, geometric error limit, and border-lock policy. Its observations record actual triangle/index counts, source vertex count, reported relative error, and whether the result still references the source vertex buffer.

A static simplifier preserving the source vertex buffer keeps normals, UVs, colors, and other per-vertex data structurally aligned, but that is not the same as weighting those attributes in the simplification error metric.

Skinned meshes require additional evidence. Joint/weight preservation and the deformation-aware error policy must be explicit before a receipt can claim that a skinned mesh was safely simplified.

## Animation processing parameters and observations

Animation resampling records the source time domain, explicit target time grid, channel interpolation rules, and transform space. Its observations record source/result keyframe counts, channel count, and the origin-independent elapsed duration of the requested grid.

Animation reduction records translation/rotation/scale tolerances, transform space, and endpoint-preservation policy. Its observations record source/result keyframe counts, maximum observed error for every bounded transform component, and explicit endpoint-preservation evidence.

This is separate from smooth runtime playback. A frame-rate-independent playback clock or runtime cross-fade does not create a new asset and therefore does not need a processing receipt unless its output is explicitly baked.

## Consumer rule

Consumers may use a processed artifact without understanding the implementation internals, but they must be able to retain or resolve its receipt. Re-running the same operation should either reproduce the exact artifact hash or produce explicit evidence explaining why reproducibility is only structural or remains unverified.
