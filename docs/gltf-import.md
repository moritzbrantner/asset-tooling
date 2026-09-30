# Static glTF import

`scene.import.gltf@1`, exported by `asset-tooling/operations/processing/gltf`, packages supported glTF 2.0 as a self-contained, content-addressed GLB. This delivers the imported static/material slice of #104. Existing renderer-neutral `scene.normalize@1` and `scene.export.glb@1` contracts remain independent.

glTF Transform 4.5.1 owns parsing and serialization. Khronos glTF Validator 2.0.0-dev.3.10 validates source and output. The operation rejects validation errors and warnings, unsupported extensions (including optional extensions that would otherwise be dropped), skins, animations, morph targets and non-triangle primitives. It currently supports at most one binary buffer. GLB inputs must be self-contained; JSON glTF may use embedded data URIs or explicitly supplied external resources.

Core PBR factors, texture bytes and texture-slot/sampler meaning, UVs, normals, tangents, color attributes, node hierarchy and supported transforms pass through the established processor. Units and axes retain glTF's meter/right-handed Y-up convention; this operation does not reinterpret centimeter inputs or bake transforms. Normal maps retain glTF's positive-Y convention; color textures remain sRGB and normal/metallic-roughness/occlusion textures remain linear data. Textures are embedded without recompression. This profile does not claim a complete production analysis or arbitrary extension support.

```ts
import {
  GLTF_IMPORT_OPERATION,
  createGltfImportOperationBuildIdentity,
  executeGltfImportOperation,
} from "asset-tooling/operations/processing/gltf";

const invocation = {
  parameters: { resourceUris: ["geometry/body.bin", "textures/paint.png"] },
  inputs: { source: sourceAssetRef, resources: [geometryAssetRef, paintAssetRef] },
};
const identity = await createGltfImportOperationBuildIdentity(objectStoreRoot, invocation);
const result = await executeGltfImportOperation(objectStoreRoot, invocation);
```

`resourceUris` corresponds positionally to `inputs.resources`. Omit both for embedded sources. Every binding must be used, with unique portable relative paths; URL schemes, path escapes, percent encoding and backslashes are rejected. Source/resource bytes are rechecked by content hash and length even when creating build identity. Execution never fetches resources or reads files named by a source URI. Failed validation stores no derived output and leaves existing objects intact.

Build identity includes operation version, source and resource AssetRefs, normalized bindings, processor and validator versions, dependency-lock hash, and asset-tooling source fingerprint. Output metadata retains source/resource hashes; observations inventory embedded/data-URI/external resources and report geometry/material/texture counts. Repeated execution compares output identities in tests; build identity alone is not proof of exact replay. The operation uses the existing operation/workflow/store surface and replays its processor on every execution.

Run `bun test test/gltf-import-operations.test.ts` for independent small fixtures covering factors, hierarchy/world-space placement, geometry/attribute retention, malformed references/nonfinite data, deterministic output and resource tampering. Run `bun scripts/check-gltf-import-contract.ts` in a hydrated checkout for the pinned catalog Avocado proof. An optional filename accepts explicitly acquired Avocado bytes; the catalog still validates the source hash/length and license before import. The proof compares source/output attributes, indices, world transforms, material factors and texture hashes, then rebuilds to compare output identity. It does not download assets or mutate canonical storage.

## Production import and analysis

`asset-tooling/operations/processing/gltf-production` exports `GLTF_PRODUCTION_IMPORT_OPERATION` (`scene.import.gltf@2`) and `GLTF_ANALYZE_OPERATION` (`scene.analyze.gltf@1`), with corresponding `createGltfProductionImportOperationBuildIdentity`, `executeGltfProductionImportOperation`, `createGltfAnalyzeOperationBuildIdentity` and `executeGltfAnalyzeOperation` functions. V1 continues to reject skins and animations.

V2 retains supported core skins, joint order/references, inverse-bind matrices, influence attributes, node/root hierarchy, named clips, interpolation and all key times/values. The same one-buffer, resource and unsupported-extension/morph/primitive limits apply. glTF Transform normalizes matrix/TRS representation and omits near-default TRS components; byte replay is exact for repeated builds, while source/output computed transform comparisons use an explicit tolerance. Axes and units retain the glTF contract; arbitrary source conventions are not inferred or repaired.

Both production operations accept `parameters.policy`:

| Field | Default | Acceptance rule |
| --- | --- | --- |
| `maxTriangles` | `null` | Optional positive integer bound on aggregate mesh triangles |
| `maxJointsPerSkin` | `null` | Optional positive integer bound per skin |
| `requireNormals` | `false` | Every primitive must have NORMAL |
| `requiredClipNames` | `[]` | Each exact name must identify one clip |
| `allowedValidatorWarnings` | `[]` | Only the explicit `NODE_SKINNED_MESH_NON_ROOT` exception is supported |

All defaults are materialized in build identity. The named warning documents that parent transforms do not affect a skinned mesh; accepting it preserves that source meaning rather than moving nodes. Other warnings and every validation error remain failures, including the validator's missing-tangent warning for a normal-mapped primitive. Accepted warnings are retained separately for source and output in import evidence. This exception does not affect v1's strict validation.

Analysis returns no outputs and writes no objects. Its observations include node/mesh/material/texture/skin/animation counts, hierarchy and skin references, per-primitive triangle/vertex counts, mesh-local bind-pose bounds, attribute coverage/type/normalization, material factors, texture-slot color space/sampling and byte hashes, clip names/time domains/durations/targets/interpolation/key counts, source-resource inventory, policy and acceptance diagnostics with asset paths. The Khronos validator checks structural and accessor/skin/animation integrity; asset-tooling does not implement a second decoder or animation evaluator. Animated/world-space bounds and physical/gameplay meaning are outside this analysis.

A policy rejection returns `accepted: false` with diagnostics from analysis. Production import applies the same policy and refuses to store a derived output when rejected. Malformed/unsupported inputs fail validation before either operation claims acceptance. Build identity hashes the source and declared resources even for analysis.

Run `bun test test/gltf-production-operations.test.ts` for independent joint-order, root/hips, weights/bind matrices, clip endpoint/value, malformed-input, policy and non-mutation fixtures. For representative source evidence, explicitly acquire the pinned reference with `bun run catalog:acquire khronos.riggedfigure-glb <disposable-directory>`, then run:

```sh
bun scripts/check-gltf-production-contract.ts khronos.riggedfigure-glb <disposable-directory>/khronos.riggedfigure-glb/RiggedFigure.glb
```

The proof checks catalog hash/length/license, repeats import, compares source/output attributes and influence arrays, ordered joints, inverse-bind matrices, every clip channel's times/values/interpolation/target, world transforms, texture bytes and structured analysis. World-matrix component error is bounded at `1e-5` and the measured maximum is recorded. Rigged Figure's source is CC BY 4.0 with catalog attribution, has one 1.25-second unnamed clip, and needs the documented non-root-skin warning exception. It is a conformance reference, not the approved medieval source or an idle/walk library. This registration does not promote payloads into canonical LFS storage.

The approved humanoid, independent pose/render comparisons and visual/consumer acceptance remain open under #104/#109. These proofs establish supported format preservation, analysis and replay; they do not establish art approval or arbitrary glTF support.
