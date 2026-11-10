# Greyhaven trees

Eight broadleaf trees of Greyhaven's woods for mmorpg ([#568](https://github.com/moritzbrantner/asset-tooling/issues/568)), built to the [kit standard](kit-standard.md): the Vale woods, Wolfrun Woods, the farmland's field edges and the wetland shores. They are one habitat, temperate European broadleaf forest, in the humanlike-world style of the reworked `greyhaven-nature` broadleaf (its trunk and card-over-core crown). It is a reproducible Blender recipe, [`adapters/blender/greyhaven_trees.py`](../adapters/blender/greyhaven_trees.py), in one rolling release, `greyhaven-trees` (`greyhaven-trees.kit.tar`). No game places it yet; placement belongs to the game (mmorpg#683).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-trees.ts [--textures full|half] --out <directory>
```

[`scripts/build-greyhaven-trees.ts`](../scripts/build-greyhaven-trees.ts) runs the recipe once per piece and level (24 runs, no bakes), imports each GLB through `scene.import.gltf@2`, encodes both atlases to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. It needs the hydrated Quaternius bark (`git lfs pull --include="assets/canonical/quaternius.stylized-nature-megakit-standard.bark-normaltree-png/**"`) and KTX-Software's `ktx` CLI, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. Two builds give identical tars.

## Pieces

Metres, +Y up, right-handed. The origin is the trunk's foot on the ground; the root flare runs 0.3 m below it, so a tree stays rooted on uneven ground. Each key is `greyhaven-trees.kit.<piece>`. The game scales and turns each placement.

| Piece | Widest side × height (m) | Shape | Bark | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- | --- |
| `oak` | 15.6 × 11.4 | short, thick trunk; five limbs spreading wide into a broad, low crown | dark furrowed | 4,483 / 1,592 / 339 |
| `oak-young` | 6.3 × 6.8 | a few crooked limbs, a small round crown | brown furrowed | 2,136 / 846 / 306 |
| `beech` | 15.1 × 15.5 | tall, clean grey bole to 6 m; steep limbs into a high dome | smooth grey, faint rings and eye scars | 4,242 / 1,516 / 359 |
| `beech-young` | 5.7 × 7.5 | a leader with layered side branches, leafy almost to the ground | smooth grey | 1,877 / 694 / 276 |
| `birch` | 5.0 × 12.8 | slender leader, a narrow, light crown with drooping branches | white with dark lenticels and black patches | 2,631 / 912 / 310 |
| `alder` | 6.2 × 10.6 | straight leader to the top, a dark, narrowing crown (wetland shores) | dark grey furrowed | 2,716 / 1,041 / 279 |
| `dead-oak` | 7.9 × 8.1 | a bare snag: thick trunk, limbs snapped off short with jagged ends | bleached grey furrowed | 726 / 222 / 82 |
| `sapling` | 1.8 × 2.5 | a whip with a few side shoots | brown smooth | 462 / 179 / 60 |

The counts and sizes are from the current build; the descriptor has the exact values. Every piece is well below `greyhaven-nature`'s broadleaf (7,217 triangles at full detail), because the game already had to send that tree to its far levels sooner.

**How the species read apart.** Silhouette first: the oak is wider than it is tall on a short trunk, the beech is the tallest with a long bare bole, the birch is a narrow column on a white stem, and the alder is a dark narrowing crown on a straight leader. Bark second: four bark looks on three atlas cells. Leaf colour last: yellow-green birch, fresh beech, olive oak, dark alder.

**Levels of detail.** `lod1` and `lod2` are variants in the same frame, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail), and `lod2` has no cards. `lod1` keeps 30 % of the cards (grown so the crown keeps its coverage and outline) and rebuilds the bark from the same skeleton with half the sides and rings and without twigs. `lod2` replaces cards and core with one opaque clump hull, coloured from the cards ([`nature_lod.py`](../adapters/blender/nature_lod.py)'s hull), and keeps only the trunk and limbs, minus what the hull hides. The dead oak only thins its bark. Each level has at most half the triangles of the one before. Full detail ends at 90 m and `lod1` at 300 m for every piece, measured at the descriptor's 60° reference field of view: `greyhaven-nature`'s tree distances, as the issue asks, and past the kit standard's 60 m and 180 m floors. The descriptor (the `greyhaven-trees-descriptor` attachment on the first piece) has `lodSelection` and each piece's `lods`.

**Materials and textures.** Two materials for the whole kit, the same on every level:

- `Greyhaven_Trees_Bark`, opaque, on a 1024 px KTX2 atlas of four cells: furrowed bark (the catalogued CC0 Quaternius Stylized Nature MegaKit `Bark_NormalTree`, made greyscale and normalised), generated smooth beech bark, generated birch bark, and a flat white cell. The crown cores and the `lod2` hulls use the flat cell, so their colour is `COLOR_0` alone. Bark `COLOR_0` sets each species' tint and darkens the foot;
- `Greyhaven_Trees_Leaves`, cut-out (`MASK`), on a 1024 × 512 KTX2 atlas of eight generated leaf-cluster cells, two each for oak (lobed), beech (oval), birch (small, toothed) and alder (round), painted with [`woodland_bushes.py`](../adapters/blender/woodland_bushes.py)'s leaf painter. The atlas is greyscale and every card's colour comes from `COLOR_0`.

Every cell has a gutter, filled with the cell's own wrapped bark or left transparent, so mips don't bleed from neighbours. Bark faces never cross a texture repeat. The kit costs 2 materials, 2 MB of texture memory and a 2.1 MB download (`budget` in [`releases/greyhaven-trees.json`](../releases/greyhaven-trees.json)).

**Sources.** The catalog holds one Quaternius trunk (`CommonTree_1`, which `greyhaven-nature` already uses). Reshaping it could not give eight species their own silhouettes within the triangle budget, so the trunks are grown in the recipe from scratch. The bark texture is the catalogued Quaternius one; the leaves are generated, as in the woodland bushes. No new source is needed.

**Collision.** Each piece's descriptor entry carries `collisionMesh`, `{ "shape": "triangle-mesh", "vertices": [[x, y, z], ...], "triangles": [[a, b, c], ...] }` in the piece's frame: a closed, outward-wound eight-sided tube around the trunk from below the ground up to its first fork, at most 3 m (48 to 112 triangles). Crowns are walk-through.

## Edit

Each piece's skeleton (trunk, branch levels), crown, palette and bark are in the `PIECES` table at the top of the recipe; the level-of-detail settings are `LOD1`, `LOD2` and `BARE_LODS`. The recipe builds into any collection with `build(piece, level, collection, inputs)`, so it can be shaped in a live Blender scene. [`test/blender/greyhaven-trees/greyhaven-trees.test.ts`](../test/blender/greyhaven-trees/greyhaven-trees.test.ts) checks the bundle, frames, LODs, distances, collision and cost limit; its suite hydrates only the bark.

Review images are in [`review/greyhaven-trees/`](../review/greyhaven-trees/): `game.jpg` from the 12 m, 0.42 rad pitch, 50° Greyhaven camera with `greyhaven-nature`'s broadleaf (back left, red-brown trunk) among the new trees, `close.jpg` at eye level for the bark, `overview.jpg` with all eight beside the broadleaf, and `lods.jpg` with each level (the broadleaf stays at full detail there for scale).
