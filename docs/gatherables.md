# Greyhaven gatherables

The materials of Greyhaven's first gather-to-smith crafting loop ([#762](https://github.com/moritzbrantner/asset-tooling/issues/762), consumer [mmorpg#917](https://github.com/moritzbrantner/mmorpg/issues/917)), built to the [kit standard](kit-standard.md): a ridge ore vein in its full and depleted states, and three material drops, iron ore, a boar hide and a boar tusk, each with an inventory icon. It is a reproducible Blender recipe, [`adapters/blender/gatherables.py`](../adapters/blender/gatherables.py), in one rolling release, `gatherables` (`gatherables.kit.tar`). It is an original procedural kit with no third-party sources. No game places it yet, and it carries no gameplay: gathering, refill timers, loot and recipes belong to the game.

The smith's crafting bench the loop ends at is the settlement prop [`settlement.props.smith-bench`](settlement-props.md), beside the existing `forge`. The crafted boar-hunting spear reuses `equipment.spear.hollowpine-hunter` from the [humanoid equipment kit](humanoid-equipment.md), so the loop needs no new weapon model.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-gatherables.ts [--textures full|half] --out <directory>
```

[`scripts/build-gatherables.ts`](../scripts/build-gatherables.ts) runs the recipe once per piece and level, adds tangents and `COLOR_0`, and encodes the shared atlas to KTX2. The items' level-0 runs also render their icons in Cycles on the CPU. The build takes about a minute and a half, and needs KTX-Software's `ktx` CLI but no network, GPU or LFS payloads.

## Pieces

Metres, +Y up, right-handed, origin on the ground at the centre of the footprint. Each key is `gatherables.kit.<piece>`.

| Piece | Kind | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- | --- |
| `ore-vein` | node, `state: "full"` | 2.2 × 1.6 × 0.9 | 1,480 / 420 / 80 | convex `collisionMesh`, 72 triangles |
| `ore-vein-depleted` | node, `state: "depleted"` | 2.2 × 1.6 × 0.9 | 1,380 / 320 / 80 | convex `collisionMesh`, 64 triangles |
| `iron-ore` | item | 0.21 × 0.13 × 0.11 | 240 / 60 / 20 | none |
| `boar-hide` | item | 0.44 × 0.6 × 0.05 | 640 / 160 / 40 | none |
| `boar-tusk` | item | 0.12 × 0.17 × 0.04 | 158 / 58 / 22 | none |

- **The ore vein** is an outcrop of Greyfang Ridge rock in the crag and limestone kits' grey (mmorpg's rock palette, `0x8b877e`). A seam slants across it from front to back. On `ore-vein` the seam stands proud, rust-stained, with dark iron lenses and ore nodules bulging from it. On `ore-vein-depleted` the same seam is chipped out to pale fresh stone, with broken chips at the foot. Both states share the outcrop and its frame (`node: "ore-vein"` in the descriptor), so a consumer swaps the mesh in place when the vein is mined and back when it refills. The foot runs `bury` (0.22 m) below `y = 0` for uneven ground. Its collision is a closed, outward-wound convex triangle mesh of the outcrop, as the [limestone rocks](limestone-rocks.md) carry.
- **The items** lie on the ground as drops: a pile of three iron ore lumps, a skinned hide with four leg flaps and a neck lying hair side up, its pale flesh side showing at the rim, and a curved tusk from a brown-stained root to an ivory point. They are small (about 0.1 to 0.6 m), true to the material; a consumer may scale a drop up or add a pickup marker so it reads from the game camera. They have no collision.
- **Icons:** the `gatherables-icons` attachment (`gatherables-icons-v1`) carries one 256 px transparent RGBA PNG per item, base64-encoded with its SHA-256, keyed by the item's role, in a three-quarter view from above. A glTF bundle's attachments are JSON or GLB, so the icons travel inside JSON. The descriptor's `icon` names each item's entry.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`): 130 / 390 m on the outcrop. The descriptor (the `gatherables-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one opaque material, `gatherables`, on a 1024 px KTX2 atlas (colour, normal and ORM, with metal in the iron). The kit costs 1 material, 1 draw call per piece, 4 MB of texture memory and a 1.3 MB download.

## Edit

The tables at the top of the recipe set the atlas layout (`CELLS`), the rock palette, the outcrop's size and subdivisions per level (`OUTCROP`), the seam's plane, width and depth (`SEAM`) and the icon size. Each texture is a short `paint_*` function, and each piece a function in the `pieces` section. To see a change, run the recipe in a live Blender in its own scene: exec `kit_common.py` and `gatherables.py` into two namespaces, call `use_common(common_namespace)`, then `build(piece, collection, level, location)`. Don't call `generate` there, since it clears the scene.

## Review

Game-camera review images are in [`review/gatherables/`](../review/gatherables/), including the smith's bench beside the forge.
