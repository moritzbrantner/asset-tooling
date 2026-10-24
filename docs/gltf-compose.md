# Skinned glTF composition

`scene.compose.skinned.gltf@1`, exported by `asset-tooling/operations/processing/gltf-compose`, composes several skinned characters that share one skeleton into a single self-contained GLB. It serves [#110](https://github.com/moritzbrantner/asset-tooling/issues/110): the owner's answer of 2026-10-17 asks for one GLB with the body and the Male_Ranger outfit bound to the shared skeleton, with no geometry removed. For the Ranger character the owner then chose (option A on #110) to compose only the body's head and face: [`scene.subset.skinned.gltf@1`](gltf-subset.md) keeps the body faces skinned to the neck and head joints, plus the eyes and eyebrows, before this composition.

```ts
import {
  GLTF_COMPOSE_SKINNED_OPERATION,
  createGltfComposeSkinnedOperationBuildIdentity,
  executeGltfComposeSkinnedOperation,
} from "asset-tooling/operations/processing/gltf-compose";

const invocation = {
  inputs: { skeleton: outfitGlb, parts: [bodyGlb] },
  parameters: { policy: { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] } },
};
const identity = await createGltfComposeSkinnedOperationBuildIdentity(objectStoreRoot, invocation);
const result = await executeGltfComposeSkinnedOperation(objectStoreRoot, invocation);
```

## Inputs and behaviour

- `skeleton` is one GLB whose skeleton is authoritative, for example the outfit. Its scene, joint nodes, rests and skinned meshes are kept as they are.
- `parts` holds 1 to 16 GLBs, for example the body. Every skinned mesh of each part is added to the skeleton's scene as a root node. Each part skin is re-created over the skeleton's joint nodes, matched by joint **name** and kept in the part's own joint order.
- Every part skin keeps its **own** inverse bind matrices, and its `JOINTS_n`/`WEIGHTS_n` stay unchanged. Differing rest proportions are therefore expressed through skinning, not by moving vertices. For example, a wider body bound to a narrower outfit skeleton deforms to that skeleton's rest.
- Morph targets of a part primitive, the mesh default weights and its `extras.targetNames` are copied with it, and sparse accessors stay sparse (the Ranger facial variants, #348).
- Meshes, materials, textures and sampler settings are copied unchanged. Textures with identical image bytes and media type are stored once. A part's own joint and armature nodes are not added.
- Inputs are self-contained GLBs, as `scene.import.gltf@2` produces them. Each input is re-validated by the Khronos validator under the same parser and policy boundary as `scene.import.gltf@2`. The output is validated under that policy too. Joint weight sums are checked with `gltf-weight-sum-tolerance-v1`.
- Node transforms are not changed (`transformsChanged: false`). Units and axes keep the glTF contract (metres, +Y up). The bundle conventions from #110 (facing +Z, origin between the feet) are the inputs' own and are not re-derived here.

The only parameter is `policy.allowedValidatorWarnings`, with the same two explicit exceptions as `scene.import.gltf@2`. Unknown parameters fail.

## Failures

The operation fails visibly, and stores nothing, when:

- a part skin names a joint that is not a joint of the skeleton input (`COMPOSE_JOINT_MISSING`);
- joint names repeat within a skin, or two skeleton joint nodes share a name (`COMPOSE_JOINT_NAME_DUPLICATE`), or a joint is unnamed (`COMPOSE_JOINT_UNNAMED`);
- any input has animations (`COMPOSE_ANIMATIONS_UNSUPPORTED`). Clips are added in a later step.
- a part has a mesh without a skin, or a mesh that no skinned node instances (`COMPOSE_NON_SKINNED_MESH`). This keeps the first version simple.
- an input has no skin (`COMPOSE_SKIN_MISSING`), or fails validation.

## Evidence

Build identity covers the operation, both input AssetRefs (bytes rechecked against their pins), the normalized policy, glTF Transform and validator versions, the weight-sum and rest-tolerance policies, the dependency-lock hash and the asset-tooling tool identity. Output metadata records the skeleton and part SHA-256s.

Observations report:

- for the skeleton: joint, skin, mesh and triangle counts;
- for each part: joint count, meshes added, skins created, materials and textures added, textures deduplicated, triangle count, and `restDifferences`. These count the joints whose local rest TRS differs from the skeleton's by more than `1e-4`, with the maximum translation, rotation (radians) and scale deltas;
- the output summary, weight sums, and the accepted validator warnings of each input and of the output.

Composing the hydrated Male_Ranger outfit (skeleton) with the Superhero body gives one 65-joint skeleton, 12 meshes, 2 skins and 41,300 triangles. Of the body's joints, 40 have different rests: at most 0.024 m in translation and 0.233 rad in rotation.

## Tests

`bun test test/gltf-compose-operations.test.ts` uses small hand-authored skinned fixtures to cover: rebinding by name, byte-exact inverse bind matrices, texture dedupe, the failure cases and deterministic replay. Its real-source test imports `Male_Ranger.gltf` and `Superhero_Male_FullBody.gltf` through `scene.import.gltf@2`, with the body's two declared normal-map substitutions ([humanoid sources](humanoid-sources.md#declared-substitution)), then composes them. It skips on Git LFS pointers unless `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`, as in the hosted canonical-storage job. Set `ASSET_TOOLING_GLTF_COMPOSE_OUT=<file>` to keep the composed GLB and its observations for inspection.
