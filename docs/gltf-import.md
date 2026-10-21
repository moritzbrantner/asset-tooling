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
| `allowedValidatorWarnings` | `[]` | Only the explicit `NODE_SKINNED_MESH_NON_ROOT` and `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` exceptions are supported |
| `repairs` | `[]` | Only the declared `gltf-color-clamp-v1` repair is supported |

All defaults are materialized in build identity. The named skin warning documents that parent transforms do not affect a skinned mesh; accepting it preserves that source meaning rather than moving nodes. Other warnings and every validation error remain failures, including the validator's missing-tangent warning for a normal-mapped primitive unless its exception is declared. Accepted warnings are retained separately for source and output in import evidence. These exceptions and repairs do not affect v1's strict validation.

### Tangent exception and color clamp repair

These two policies follow the [owner decisions Q1 (a) and Q2 (a) on #118, 2026-10-14](https://github.com/moritzbrantner/asset-tooling/issues/118) for the Greyhaven starter sources.

- **`MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` is accepted only when named.** It marks a normal-mapped primitive without `TANGENT`; consumers' renderers generate MikkTSpace tangents. The import generates no tangents, so it stays exactly replayable. The warning is recorded in `validatorWarnings` and `outputValidatorWarnings`. It can be combined with the skin exception; each covers only its own code.
- **`repairs: ["gltf-color-clamp-v1"]` clamps nearly-in-range vertex colors.** The bound is the exported `GLTF_COLOR_CLAMP_REPAIR = { repair: "gltf-color-clamp-v1", maxExcess: 2e-4 }`, recorded in build identity. Float `COLOR_n` components outside [0, 1] by at most `2e-4` are clamped in the output; in-range components keep their bits. A larger excess fails with `…/attributes/COLOR_n: COLOR_CLAMP_EXCESS_OUT_OF_BOUND` and stores nothing. Normalized integer colors and all other attributes are never changed. Observations list one `repairs` entry per repaired attribute: `{ repair, path, clampedComponentCount, maxExcess }`. Analysis reports the same entries and writes nothing.
  - **How it applies:** only while the repair is declared, the source validator's `ACCESSOR_NON_CLAMPED` at a primitive's `COLOR_n` attribute is superseded by this bound. The source report is then not truncated, so every other issue still fails, as `ACCESSOR_NON_CLAMPED` elsewhere does. `CommonTree_1` has about 9000 such components, far over the validator's usual 100-issue limit. The output is validated strictly and must have no errors.

Analysis returns no outputs and writes no objects. Its observations include node/mesh/material/texture/skin/animation counts, hierarchy and skin references, per-primitive triangle/vertex counts, mesh-local bind-pose bounds, attribute coverage/type/normalization, material factors, texture-slot color space/sampling and byte hashes, clip names/time domains/durations/targets/interpolation/key counts, source-resource inventory, policy and acceptance diagnostics with asset paths. The Khronos validator checks structural and accessor/skin/animation integrity; asset-tooling does not implement a second decoder or animation evaluator. Animated/world-space bounds and physical/gameplay meaning are outside this analysis.

A policy rejection returns `accepted: false` with diagnostics from analysis. Production import applies the same policy and refuses to store a derived output when rejected. Malformed/unsupported inputs fail validation before either operation claims acceptance. Build identity hashes the source and declared resources even for analysis.

Run `bun test test/gltf-production-operations.test.ts` for independent joint-order, root/hips, weights/bind matrices, clip endpoint/value, malformed-input, policy and non-mutation fixtures. For representative source evidence, explicitly acquire the pinned reference with `bun run catalog:acquire khronos.riggedfigure-glb <disposable-directory>`, then run:

```sh
bun scripts/check-gltf-production-contract.ts khronos.riggedfigure-glb <disposable-directory>/khronos.riggedfigure-glb/RiggedFigure.glb
```

The proof checks catalog hash/length/license, repeats import, compares source/output attributes and influence arrays, ordered joints, inverse-bind matrices, every clip channel's times/values/interpolation/target, world transforms, texture bytes and structured analysis. World-matrix component error is bounded at `1e-5` and the measured maximum is recorded. Rigged Figure's source is CC BY 4.0 with catalog attribution, has one 1.25-second unnamed clip, and needs the documented non-root-skin warning exception. It is a conformance reference, not the approved medieval source or an idle/walk library. This registration does not promote payloads into canonical LFS storage.

Append an explicit Blender executable to the proof command to independently decode both verified artifacts and compare deformed world-space vertices and topology through Blender, rather than glTF Transform:

```sh
bun scripts/check-gltf-production-contract.ts khronos.riggedfigure-glb <disposable-directory>/khronos.riggedfigure-glb/RiggedFigure.glb /absolute/path/to/blender
```

This optional offline comparison requires the exact version in `adapters/blender/release.json`. It records the actual Blender build hash, comparison-script SHA-256, vertex/pose counts, maximum source movement and measured maximum world-vertex error against a fixed `1e-5` meter tolerance. It samples each imported clip's endpoints and quarter intervals plus an animation-disabled baseline. Blender owns animation evaluation and skin deformation; its bone display shapes are excluded. Clips use the imported action/slot directly, and unrelated transforms reset between clips. Imported clips must have one action per NLA track and consistent intervals across objects; unsupported layouts fail. This bounded comparison is not a full pose-space scan or a material/render/visual approval test.

With `ASSET_TOOLING_BLENDER` configured, the production-import tests use an independently authored triangle/skin fixture declaring two meters of hips motion. They require that movement in the oracle's observations and prove that changing the generated joint channel fails the world-space comparison. Hosted validation runs this regression alongside the existing pinned Blender tests; ordinary checks skip the renderer-dependent proof when Blender is not configured.

The approved humanoid, rendered comparisons and visual/consumer acceptance remain open under #104/#109. These proofs establish supported format preservation, sampled independent pose fidelity, analysis and replay; they do not establish art approval or arbitrary glTF support.

## Skinned composition

`scene.compose.skinned.gltf@1` (`asset-tooling/operations/processing/gltf-compose`) binds the skinned meshes of several imported GLBs to one shared skeleton, matched by joint name. Each part keeps its own inverse bind matrices. See [gltf-compose.md](gltf-compose.md).

## Placement

`scene.place.gltf@1` (`asset-tooling/operations/processing/gltf-place`) wraps an imported GLB's scene roots in one named parent node with an exact translation, or with the footprint-base-centre anchor. Vertices are not baked. See [gltf-place.md](gltf-place.md).

`scene.textures.resize.gltf@1` (`asset-tooling/operations/processing/gltf-texture-resize`) downscales an imported GLB's embedded images to per-slot maximum edges and re-encodes them as PNG. Nothing but image bytes changes. See [gltf-texture-resize.md](gltf-texture-resize.md).

## Clip extraction and embedding

`asset-tooling/operations/processing/gltf-animation` moves clips between skinned GLBs and the `three-d-animation-json-v1` codec that the 3d-lab animation processors use ([#110](https://github.com/moritzbrantner/asset-tooling/issues/110)). The rig is the joints of `skins[0]`. Any other skin may bind only those joints, as composed parts do.

- `scene.extract.animation.gltf@1` takes a skinned GLB and the parameter `hipsJoint`, plus an optional `clip`. It emits a `rig` (`application/vnd.moritzbrantner.three-d-humanoid-rig+json`). The rig has `jointNames`, the local rest TRS with the parent joint index for each joint, and `referenceHeight`, the hips joint's model-space Y. With `clip`, it also emits an `animation` document on skin-joint indices. Only LINEAR samplers are accepted. Channels on non-joint nodes are skipped and reported in the observations. Missing or ambiguous clips and missing hips joints fail. Both operations reject a joint whose glTF parent is a non-joint helper below another joint (`*_JOINT_HELPER_ANCESTOR`): its TRS would be relative to the omitted helper.
- `scene.embed.animation.gltf@1` takes a skinned GLB, `inputs.animations` and `parameters.clips: [{ name }]`, paired positionally. It writes each document as a LINEAR clip on the skin's joint nodes. A clip name that already exists or is duplicated fails, as does a node index outside the skin. The output is validated under the `scene.import.gltf@2` policy.

Both operations accept the same `policy.allowedValidatorWarnings` exceptions as `scene.import.gltf@2`. Neither one samples or retargets keys: `animation.retarget@1` delegates that to the pinned 3d-lab processor. The Ranger recipe that uses them is in [humanoid-ranger.md](humanoid-ranger.md).

## Malformed-input diagnostics

`test/gltf-malformed-inputs.test.ts` holds small, independently authored fixtures. Each changes one thing in an accepted static or rigged document. The categories are: references, nonfinite values, skin weights and joints, inverse binds, animation targets and times, material resources, required and optional extensions, missing or external resources, and GLB containers. Every case must reject from `scene.import.gltf@1`, `scene.import.gltf@2` and `scene.analyze.gltf@1` as applicable, with a diagnostic that names the Khronos code and JSON pointer (or the policy rule), and must store no derived object.

Three failure modes used to crash the decoder or validator instead of producing a diagnostic. A narrow structural preflight now reports them before validation:
- a `.gltf` buffer without `uri` (`/buffers/N: BUFFER_MISSING_URI`);
- a non-integer `JOINTS_n` accessor (`…/attributes/JOINTS_n: MESH_PRIMITIVE_JOINTS_INVALID_COMPONENT_TYPE`);
- a truncated GLB container ("not a well-formed GLB container").

Any other non-`Error` validator failure is wrapped with its location. This is not a second glTF parser; all other checks remain the Khronos validator's and the production policy's.

Policies for cases the validator alone does not settle ([owner decisions on #104, 2026-10-14](https://github.com/moritzbrantner/asset-tooling/issues/104)) apply to `scene.import.gltf@2` and `scene.analyze.gltf@1`. Both use production implementation version 2, whose build identity records the policy values below.

- **Singular inverse bind matrices are accepted with a warning.** A joint's inverse bind matrix is singular when the absolute determinant of its upper-left 3×3 block is at most `1e-12`, or when the determinant is not finite. Import stores the asset. The observations then carry one `policyWarnings` entry per affected joint: `{ code: "SKIN_INVERSE_BIND_MATRIX_SINGULAR", path: "/skins/S/inverseBindMatrices", skin: S, joint: J, node: N, determinant }`, where `J` is the joint's position in `skin.joints` and `N` its node index. Analysis reports the same entries and still has `accepted: true`. Such skins cannot deform correctly; #194 plans their remediation. Source data is never changed.
- **Joint weight sums use the named tolerance `gltf-weight-sum-tolerance-v1` = `1e-3`.** Every vertex of a skinned primitive must have a decoded `WEIGHTS_n` sum within `1e-3` of 1. Weights are never renormalized.
  - **Evidence for the value:** the six skinned Khronos sample exports at the pinned sample-assets revision `90d7ede` (BrainStem, CesiumMan, Fox, RecursiveSkeletons, RiggedFigure, RiggedSimple, all float weights) drift at most `8.9e-8`. The validator's own `ACCESSOR_WEIGHTS_NON_NORMALIZED` check already fails a single-vertex drift of `1e-6`. Unsigned-short normalized weights carry up to `4 × 0.5/65535 ≈ 3.1e-5` rounding across four influences. The `1e-3` value accepts all of these with margin, but still rejects visibly wrong skins.
  - **How it applies:** the production operations treat the validator's `ACCESSOR_WEIGHTS_NON_NORMALIZED` as superseded by this tolerance. A sum outside it fails with `…/attributes/WEIGHTS_n: WEIGHTS_SUM_OUT_OF_TOLERANCE`, naming the vertex and its sum. Observations report `weightSums: { policy, tolerance, maxAbsoluteDrift }`. All other weight checks (negative, nonfinite, duplicate joints) keep their validator diagnostics.
- **Unused animation samplers and single-keyframe channels are accepted and reported.** Each clip in the analysis lists `unusedSamplers` (sampler indices that no channel references) and `singleKeyframeChannels` (channel indices whose sampler has one keyframe). Neither affects `accepted`.
- **GLB external resources name their URI and pointer.** A GLB that refers to an external buffer or image fails with `/buffers/N/uri` or `/images/N/uri`, the code `GLB_EXTERNAL_RESOURCE` and the unresolved URI. The words "external buffer" or "external image" appear in the message.

### Singular inverse bind remediation plan

Plan for [#194](https://github.com/moritzbrantner/asset-tooling/issues/194). Import behaviour stays as described above. Nothing here changes source data during import.

**Survey (2026-10-21).** No source we hold has a singular inverse bind matrix. Checked: every skinned glTF/GLB under `assets/canonical/` (8 files, 446 joints: the Quaternius base characters, outfits, animation libraries and the skinned chest) plus the 3 skinned GLBs under `dist/` and `test/`. Every joint's 3×3 determinant lies within `3e-6` of 1, so every bind is a pure rotation and translation. The causes listed in #194 (near-zero scale, exporter bugs, degenerate rest poses) are therefore hypothetical for now. The warning has only fired on hand-made test fixtures.

**Candidate fixes**

| Candidate | Result |
| --- | --- |
| Recompute in asset-tooling from the bind pose | Rejected. glTF does not store the bind pose apart from the inverse bind matrices, so a recompute would have to treat the node rest pose as the bind pose. That is a guess, and it would add skinning maths here that belongs to Blender. |
| Repair through Blender (re-import and re-export) | Chosen. Measured on `Male_Ranger.gltf` with `neck_01` corrupted twice: once with a zero block, once scaled to determinant `1e-15`. Blender 5.2.2's default import (`guess_original_bind_pose=True`) inverts the broken matrix and exports wrong but non-singular binds, with errors up to about `1.6e16`. That would hide the fault from the warning. Importing with `guess_original_bind_pose=False` takes the rest pose from the node transforms. The re-export then reproduces the uncorrupted file's inverse binds exactly: the difference is `0` against a round trip of the clean file, and at most `2.2e-6` against the source. |
| Reject at import | Not now. The owner decision on #104 accepts these files with a warning. Rejecting them only makes sense once a repair path exists, and even then it would need a separate owner decision. |

**Chosen approach**

1. Import and analysis keep `SKIN_INVERSE_BIND_MATRIX_SINGULAR` as a warning. The stored source is never changed.
2. The repair is an explicit derived step, never part of import. It runs Blender's glTF import with `guess_original_bind_pose=False`, then Blender's glTF export. The output is a new derived asset with the usual provenance; the source keeps its own identity.
3. The repair only applies when the node rest pose is the bind pose. Check this on the joints that are not singular: each one's inverse bind matrix times its joint world matrix must be close to identity. If that check fails, the rest pose is not the bind pose, and the asset needs re-authoring in Blender instead of a mechanical repair.

**Implementation issues.** None are cut yet, because no real source needs the repair. When the first real source or generated output triggers the warning, open one issue for the derived repair operation in step 2 with the check in step 3, using that asset as its fixture.
