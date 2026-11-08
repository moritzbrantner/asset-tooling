# Levels of detail

[#123](https://github.com/moritzbrantner/asset-tooling/issues/123) adds source-derived levels of detail. It follows the owner answer A of 2026-10-18 and Atlas Decision 5.1.6 (Blender is the finishing tool).

| Level | Variant | Triangles kept | Switch-distance hint |
| --- | --- | --- | --- |
| LOD0 | `default` (or the variant name) | all (the source) | — |
| LOD1 | `lod1` (or `<variant>.lod1`) | about 50 % | 15 m |
| LOD2 | `lod2` (or `<variant>.lod2`) | about 20 % | 35 m |

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

The Ranger character variants (`default`, `skin.light` and the outfit and skin variants) ship **no** levels of detail. The owner dropped them on 2026-11-08 ([#516](https://github.com/moritzbrantner/asset-tooling/issues/516)), superseding answer A of #123 for characters: no consumer loaded them, and they were about a third of the Ranger build's Blender runs. The `humanoid-appearance` descriptor has no `levelsOfDetail` section and no `unsupported` lists.

- **Items:** the armour, weapon and hair items keep only LOD0, except the #467 throwables (`equipment.throwing-knife`, `equipment.venom-flask`, `equipment.blasting-bomb`), which ship recipe-built `lod1` and `lod2` variants listed in their `humanoid-item` descriptors ([weapon recipes](weapon-recipes.md#throwable-levels-of-detail)).

## Review

Levels are compared against LOD0 at fixed cameras and distances. For the kit this uses `examples/greyhaven-kit/render-composition.py`. Expected limits:

- At LOD2, the barrel's iron bands break up. That is acceptable at the 35 m hint.
- Trees keep their silhouette through both levels.
- Tree impostors are left for when a consumer's draw distance needs them (owner answer).
