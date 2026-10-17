# Skinned glTF subset

`scene.subset.skinned.gltf@1`, exported by `asset-tooling/operations/processing/gltf-subset`, keeps only the parts of a skinned character that are bound to chosen joints. It serves [#110](https://github.com/moritzbrantner/asset-tooling/issues/110). On 2026-10-17 the owner chose option A there: keep only the Universal Base Characters body faces skinned to the head and neck joints, plus the eyes and eyebrows meshes, then compose them with the Male_Ranger outfit, whose hood covers the seam. This replaces the earlier "no geometry removed" default for that character. The free tier has no matching "Regular" head ([Atlas Decision 6.1.4](decisions/atlas.md)), and the Ranger baseline itself is [Atlas Decision 1.1.3](decisions/atlas.md).

```ts
import {
  GLTF_SUBSET_SKINNED_OPERATION,
  createGltfSubsetSkinnedOperationBuildIdentity,
  executeGltfSubsetSkinnedOperation,
} from "asset-tooling/operations/processing/gltf-subset";

const invocation = {
  inputs: { source: bodyGlb },
  parameters: {
    keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"],
    policy: { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] },
  },
};
const identity = await createGltfSubsetSkinnedOperationBuildIdentity(objectStoreRoot, invocation);
const result = await executeGltfSubsetSkinnedOperation(objectStoreRoot, invocation);
```

## Inputs, parameters and behaviour

- `source` is one self-contained skinned GLB, as `scene.import.gltf@2` produces it. The output is one GLB.
- `keepJoints` (required) is a non-empty list of unique joint node **names**.
- `minWeight` is a number in (0, 1]. It defaults to `0.5`.
- `keepMeshes` is an optional list of mesh names (glTF `mesh.name`, not node names) that are kept whole. It defaults to `[]`.
- `policy.allowedValidatorWarnings` allows the same two explicit exceptions as `scene.import.gltf@2`.
- Unknown parameters fail. The build identity records every default.

For each vertex of a skinned primitive, the operation adds up the weights on joints named in `keepJoints`, over every `JOINTS_n`/`WEIGHTS_n` set. A triangle is kept only if **all three** of its vertices reach `minWeight`. This applies to the skinned meshes not listed in `keepMeshes`.

- Kept primitives are compacted to the vertices their kept triangles use, in ascending source order. Every vertex attribute (and morph-target attribute) keeps its type, component type and normalization, and the kept values are copied byte-exact. This includes `JOINTS_n` and `WEIGHTS_n`. Indices are rebuilt, as `UNSIGNED_SHORT` unless more than 65,535 vertices remain.
- A primitive left with no triangles is removed. A mesh left with no primitives is removed. A mesh node that loses its mesh is removed if it is not a joint and has no children.
- Meshes in `keepMeshes` are kept whole. Non-skinned meshes not in `keepMeshes` are dropped.
- Skins, joint nodes, rests and inverse bind matrices are unchanged. A skin that no node uses any more is removed. Materials, textures and accessors that nothing references are pruned.
- The source is re-validated by the Khronos validator under the same parser and policy boundary as `scene.import.gltf@2`. The output is validated under that policy too. Joint weight sums are checked with `gltf-weight-sum-tolerance-v1`.
- Node transforms are not changed. Units and axes keep the glTF contract (metres, +Y up).

## Failures

The operation fails visibly, and stores nothing, when:

- a `keepJoints` name is not a joint of the source skins (`SUBSET_JOINT_MISSING`), or a `keepMeshes` name is not a source mesh (`SUBSET_MESH_MISSING`);
- no triangle is kept (`SUBSET_EMPTY_RESULT`);
- the source has animations (`SUBSET_ANIMATIONS_UNSUPPORTED`) or no skin (`SUBSET_SKIN_MISSING`);
- a subset primitive is not a triangle list (`SUBSET_PRIMITIVE_MODE_UNSUPPORTED`), has no weights (`SUBSET_WEIGHTS_MISSING`), or its mesh is instanced with different skins (`SUBSET_MESH_MULTIPLE_SKINS`);
- the parameters are invalid, or the source or output fails validation.

## Evidence

The build identity covers the operation, the source AssetRef (bytes rechecked against the pin), the normalized parameters (`keepJoints`, `minWeight`, `keepMeshes`, `policy`), the glTF Transform and validator versions, the weight-sum policy, the dependency-lock hash and the asset-tooling tool identity. The output metadata records the source SHA-256 and the recipe.

The observations report:

- the recipe and policy values;
- a summary of the source;
- for each mesh, whether it is skinned or kept whole, with kept and removed triangle counts. Each subset primitive also gets kept and removed triangles, source and kept vertex counts, and whether it was removed;
- the removed meshes, nodes and skins;
- an output summary and the weight sums;
- the accepted validator warnings of the source and of the output.

## Ranger character recipe

The Universal Base Characters rig is a single 65-joint skin. Its neck and head chain is `spine_03 > neck_01 > Head`. There is no `neck_02`, and `Head` has no child or face joints. The recipe for the Ranger character is:

| Parameter | Value |
| --- | --- |
| `keepJoints` | `neck_01`, `Head` |
| `minWeight` | `0.5` |
| `keepMeshes` | `Face` (the Eyebrows node), `Face.001` (the Eyes node) |

Applied to the hydrated `Superhero_Male_FullBody.gltf`, imported through `scene.import.gltf@2` with its two [declared normal-map substitutions](humanoid-sources.md#declared-substitution), the recipe gives these counts:

- The body mesh `Sphere.005_Retopology.004` keeps 2,844 of 12,566 triangles (1,555 of 7,281 vertices).
- Eyebrows (984) and eyes (768) are kept whole.
- The subset therefore has 4,596 of the body's 14,318 triangles.

Composing Male_Ranger (skeleton) with this subset through [`scene.compose.skinned.gltf@1`](gltf-compose.md) gives one 65-joint GLB with 12 meshes and 31,578 triangles. It validates with only the two allowed warnings. At rest, the face sits inside the hood and no body geometry clips through the outfit.

## Tests

`bun test test/gltf-subset-operations.test.ts` uses small hand-authored skinned fixtures to cover:

- weight sums across two weight sets;
- the `minWeight` threshold;
- `keepMeshes`;
- byte-exact compaction of every attribute;
- pruning of primitives, meshes, nodes, materials and textures;
- the failure cases;
- deterministic replay and the materialized defaults.

The real-source test applies the Ranger recipe to the imported body and composes the result with the imported Male_Ranger outfit. It skips on Git LFS pointers unless `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`, as in the hosted canonical-storage job. Set `ASSET_TOOLING_GLTF_SUBSET_OUT=<file>` to keep the composed GLB and the subset and compose observations.
