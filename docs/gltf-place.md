# glTF placement

`scene.place.gltf@1`, exported by `asset-tooling/operations/processing/gltf-place`, sets where an imported GLB's origin is. It adds one new named parent node with an exact translation; vertices are not baked. This follows the [owner decision Q3 on #118, 2026-10-14](https://github.com/moritzbrantner/asset-tooling/issues/118). The routine default from the same decision puts the origin at the base centre of the footprint and records the door's source hinge pivot as `sourcePivot`.

```ts
import {
  GLTF_PLACE_OPERATION,
  createGltfPlaceOperationBuildIdentity,
  executeGltfPlaceOperation,
} from "asset-tooling/operations/processing/gltf-place";

const invocation = {
  inputs: { source: doorGlb },
  parameters: {
    parentName: "Door_1_Flat_Placed", anchor: "footprint-base-center", sourcePivot: { node: "Door_1_Flat" },
    policy: { allowedValidatorWarnings: ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] },
  },
};
const identity = await createGltfPlaceOperationBuildIdentity(objectStoreRoot, invocation);
const result = await executeGltfPlaceOperation(objectStoreRoot, invocation);
```

## Inputs, parameters and behaviour

- `source` is one self-contained GLB, static or skinned, as `scene.import.gltf@2` produces it. The output is one GLB.
- `parentName` (required) is the new parent node's name. It must not already be a node name of the source (`PLACE_PARENT_NAME_COLLISION`).
- Exactly one of:
  - `translation: [x, y, z]`: three finite numbers, written to the parent node exactly (`-0` becomes `0`);
  - `anchor: "footprint-base-center"`: the translation is `−(centre X, min Y, centre Z)` of the scene's world-space rest bounds, so the footprint's base centre lands on the origin.
- `sourcePivot: { node }` (optional) names one source node, for example the door's hinge. Its world position is recorded before and after placement. A missing or ambiguous name fails (`PLACE_PIVOT_NODE_MISSING`, `PLACE_PIVOT_NODE_AMBIGUOUS`). It does not change the translation.
- `policy.allowedValidatorWarnings` allows the same two explicit exceptions as `scene.import.gltf@2`. A skinned mesh node that was a scene root ends up below the parent, so a skinned source needs `NODE_SKINNED_MESH_NON_ROOT`. glTF ignores a skinned mesh node's own transform; its joints move with the parent.
- Unknown parameters fail. The build identity records every normalized parameter.

The operation creates the parent node, moves every original scene root under it in order and makes the parent the scene's only root. The source must have exactly one scene (`PLACE_SCENE_COUNT_UNSUPPORTED`). Nodes, local transforms, skins, inverse bind matrices, animations, materials and textures are unchanged. Every accessor keeps its type, component type and bytes. The new node is appended to the node list, so existing node indices do not change. Source and output are validated under the `scene.import.gltf@2` parser and policy boundary, and joint weight sums are checked with `gltf-weight-sum-tolerance-v1`.

### Bounds

Bounds are computed in float64 from the `POSITION` accessors of every mesh instance in the scene. A static mesh uses its node's world matrix. A skinned mesh uses its rest pose, `Σ weight · jointWorld · inverseBind`, applied to `POSITION`. That is the bind-pose position when the rest pose is the bind pose, as in the imported sources, and it follows the joints after reparenting. Animated poses are not considered.

## Evidence

The observations report:

- `translation` (the exact applied numbers), `mode` (`anchor` or `translation`) and `anchor`;
- `reparentedRoots`, `verticesBaked: false` and `accessorsChanged: false`;
- `bounds.source` and `bounds.placed`, each with `min`, `max`, `size` and `center`. The placed bounds are measured again on the written GLB, not derived from the translation;
- `footprint`: `width` (X), `depth` (Z) and `height` (Y) of the placed bounds;
- `sourcePivot`, when requested: `node`, `sourceWorldPosition` and `placedWorldPosition`;
- source and output summaries, weight sums and the accepted validator warnings of the source and of the output.

The output metadata records the source SHA-256, `parentName`, the translation and the anchor.

Measured on the hydrated Greyhaven sources (imported with the tangent exception): the wall `Wall_Plaster_Door_Flat` gets the translation `[5.96e-8, 0, 0.1108]` and a 2.0 × 0.406 m footprint, 3.123 m high; the barrel gets `[5.96e-8, -0.00344, -1.49e-8]` and a 0.698 × 0.698 m footprint, 0.898 m high.

## Tests

`bun test test/hydrated/gltf-place-operations.test.ts` uses small hand-authored fixtures to cover:

- a static mesh offset from the origin, with the exact anchor translation and bounds;
- a nested, rotated hierarchy with two roots and a `sourcePivot`;
- a skinned mesh bounded at its bind pose;
- byte-exact accessors in every case;
- an exact explicit translation;
- name collisions, a missing pivot and bad parameters, storing nothing;
- deterministic output and build identity.

The real-source test imports the Greyhaven wall and barrel through `scene.import.gltf@2` and places each with `footprint-base-center`. It checks that min Y is 0 and X/Z are centred within `1e-6`. It skips on Git LFS pointers unless `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`, as in the hosted canonical-storage job.
