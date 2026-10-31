# Levels of detail

[#123](https://github.com/moritzbrantner/asset-tooling/issues/123) adds source-derived levels of detail. It follows the owner answer A of 2026-10-18 and Atlas Decision 5.1.6 (Blender is the finishing tool).

| Level | Variant | Triangles kept | Switch-distance hint |
| --- | --- | --- | --- |
| LOD0 | `default` (or the variant name) | all (the source) | — |
| LOD1 | `lod1` (or `<variant>.lod1`) | about 50 % | 15 m |
| LOD2 | `lod2` (or `<variant>.lod2`) | about 20 % for props and vegetation, 25 % for characters | 35 m |

The switch distances are hints. Each consumer chooses its own selection and culling.

## Recipe

[`adapters/blender/lod.py`](../adapters/blender/lod.py) runs through the pinned Blender script backend ([`src/lod-recipe.ts`](../src/lod-recipe.ts): `LOD_RATIOS`, `generateLodLevel`):

1. It imports the source GLB and removes any clips.
2. It welds coincident vertices. glTF splits vertices at UV and normal seams, and a collapse across those splits shreds the mesh.
3. It applies an edge-collapse **Decimate** to the declared ratio. The collapse interpolates UVs, normals and skin weights, and triangulates.

Node names, materials, the armature and the scene structure are kept, and the images keep their exact bytes. Each level is re-validated through `scene.import.gltf@2`. The receipt observations record the triangles before and after, per mesh.

## Starter kit

Every Greyhaven starter entry, including the #121 variations, gets `lod1` and `lod2` variants. A level shares its LOD0's texture files in the bundle. The descriptor's `lods` list gives each level's variant, ratio, triangle count and switch-distance hint. `buildGreyhavenStarter({lods: false})` skips the levels where Blender is unavailable. The hosted storage job uses this; local runs and releases build the levels.

## Nature bundle

The `greyhaven-nature` trees and rocks use their own recipe, [`adapters/blender/nature_lod.py`](../adapters/blender/nature_lod.py) ([#449](https://github.com/moritzbrantner/asset-tooling/issues/449)). A plain collapse would shred leaf cards. Instead, the tree `lod1` thins and grows the cards, and the tree `lod2` replaces the crown with an opaque, vertex-coloured shell; the rocks are decimated with smaller baked maps. The same `lod1`/`lod2` variant names apply. Its descriptor gives screen-size switch points (`minScreenSize` of the projected bounding sphere) instead of fixed distance hints. See [Levels of detail](greyhaven-nature-bundle.md#levels-of-detail) in the nature bundle docs.

## Characters

Every Ranger character variant gets levels: `default`, `skin.light`, `outfit.soldier`, `outfit.knight` and their Light variants. Characters use the 25 % LOD2.

- **Skin and clips:** Blender decimates the clip-less composition and keeps the skin weights. The clips ship **once**, in `humanoid.ranger.male/default`. Every other variant and level has the same joints, by name, at the same rest pose. The build checks this for each one. A consumer therefore plays the default's clips on any variant or level by joint name; three.js `AnimationMixer` tracks bind by node name. Blender may reorder a level's skin joints, but name binding makes the order irrelevant, so nothing is re-indexed or embedded again.
- **Light skin:** a Light level is its Dark level with the Light textures swapped in. The geometry is shared and not decimated twice.
- **Descriptor:** the `humanoid-appearance` descriptor lists them under `levelsOfDetail` (`of`, `level`, `variant`, `ratio`, `triangles`, `switchDistanceHint`).
- **Items:** the armour, weapon and hair items keep only LOD0.

## Review

Levels are compared against LOD0 at fixed cameras and distances. For characters this uses the outfit pose sheets (`examples/weapons/socket-sheets.py`) at idle, walk, raised arm, crouch and shield. For the kit it uses `examples/greyhaven-kit/render-composition.py`. Expected limits:

- At LOD2, the barrel's iron bands break up. That is acceptable at the 35 m hint.
- Trees keep their silhouette through both levels.
- Tree impostors are left for when a consumer's draw distance needs them (owner answer).
