# Greyhaven pines

Six upland conifers for mmorpg's Bandit Highlands, Greyfang Ridge and Hollowpine Reach ([#569](https://github.com/moritzbrantner/asset-tooling/issues/569)), built to the [kit standard](kit-standard.md). They are one habitat, dry upland pine and spruce forest, in the humanlike-world style of the reworked `greyhaven-nature` fir and the broadleaf [`greyhaven-trees`](greyhaven-trees.md), so the two kits stand together in the woods. It is a reproducible Blender recipe, [`adapters/blender/greyhaven_pines.py`](../adapters/blender/greyhaven_pines.py), in one rolling release, `greyhaven-pines` (`greyhaven-pines.kit.tar`). No game places it yet; placement belongs to the game (mmorpg#683).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-pines.ts [--textures full|half] --out <directory>
```

[`scripts/build-greyhaven-pines.ts`](../scripts/build-greyhaven-pines.ts) runs the recipe once per piece and level (18 runs, no bakes), imports each GLB through `scene.import.gltf@2`, encodes both atlases to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. It needs the hydrated Quaternius bark and Poly Haven fir twig maps (`git lfs pull --include="assets/canonical/quaternius.stylized-nature-megakit-standard.bark-normaltree-png/**,assets/canonical/poly-haven.fir-tree-01-twig-*/**"`) and KTX-Software's `ktx` CLI, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. Two builds give identical tars.

## How it is made

The recipe reuses its siblings instead of copying them; both are declared inputs of every run, so a change to either shows in the spec hash:

- [`greyhaven_trees.py`](../adapters/blender/greyhaven_trees.py) grows every trunk and limb from a seeded branch skeleton, with its bark tubes, root flare, trunk collision tube and bark material. The pines' clump crowns (Scots pines and the sapling) are its metaball core with cards over it, on this kit's needle-tuft cells;
- [`conifer_crown.py`](../adapters/blender/conifer_crown.py), the `greyhaven-nature` fir, makes the spruce crowns: drooping opaque skirts under fir sprig cards, on a cone profile measured from the grown trunk, with more tiers and a darker, bluer palette. Its skirts move onto the bark atlas's flat cell, so the kit keeps two materials;
- [`nature_lod.py`](../adapters/blender/nature_lod.py) makes the far levels.

Neither sibling's file changes, so their own releases are untouched.

## Pieces

Metres, +Y up, right-handed. The origin is the trunk's foot on the ground; the root flare runs 0.3 m below it, so a tree stays rooted on uneven ground. Each key is `greyhaven-pines.kit.<piece>`. The game scales and turns each placement.

| Piece | Widest side × height (m) | Shape | Bark | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- | --- |
| `scots-pine` | 8.7 × 16.7 | a tall, bare trunk; an irregular, flat crown of needle pads in the top third | grey-brown furrowed at the foot, orange-red and flaky above 38 % | 4,670 / 1,570 / 542 |
| `scots-pine-windswept` | 5.5 × 9.8 | leans to +X; the upwind limbs are short, so the crown flags downwind (crags and ridges) | the same, orange above 30 % | 3,134 / 1,159 / 506 |
| `spruce` | 7.4 × 15.0 | a dense, dark cone of 14 drooping tiers almost to the ground | grey-brown furrowed | 6,197 / 2,522 / 492 |
| `spruce-young` | 4.0 × 5.0 | a small, lighter cone of 7 tiers to the ground | grey-brown furrowed | 2,815 / 1,210 / 495 |
| `pine-dead` | 2.4 × 11.2 | a grey snag: broken top, limbs snapped short | dark furrowed foot, silver weathered wood above | 415 / 159 / 30 |
| `pine-sapling` | 1.8 × 2.1 | a young Scots pine: a leader with whorls of tufted shoots | orange-brown flaky | 984 / 318 / 103 |

The counts and sizes are from the current build; the descriptor has the exact values. Every piece is below `greyhaven-nature`'s conifer (7,115 triangles at full detail), because trees have blown the game's frame budget before.

**How they read apart.** A Scots pine reads by its trunk: at the game camera its crown is above the frame, and a bare orange-red stem is what shows. Seen from further away, the flat, lumpy crown sits high on that stem. The spruces are dark, closed cones that reach the ground, darker and bluer than `greyhaven-nature`'s fir. The dead pine is a pale grey pole with stubs.

**Levels of detail.** `lod1` and `lod2` are variants in the same frame, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail), as in `greyhaven-trees`. `lod1` keeps 30 % of the cards (grown so the crown keeps its coverage and outline) and rebuilds the bark from the same skeleton with half the sides and rings and without twigs. `lod2` has no cards: the Scots pines and the sapling get `nature_lod.py`'s coloured clump hull, the spruces its tier envelope (20 bands of 12 sectors); both keep only the trunk and limbs, minus what the shell hides. The dead pine only thins its bark. Each level has at most half the triangles of the one before. Full detail ends at 90 m and `lod1` at 300 m for every piece, at the descriptor's 60° reference field of view: the `greyhaven-trees` and `greyhaven-nature` tree distances, past the kit standard's 60 m and 180 m floors. The descriptor (the `greyhaven-pines-descriptor` attachment on the first piece) has `lodSelection` and each piece's `lods`.

**Materials and textures.** Two materials for the whole kit, the same on every level:

- `Greyhaven_Pines_Bark`, opaque, on a 1024 px KTX2 atlas of four cells in `greyhaven-trees`' layout: furrowed bark (the catalogued CC0 Quaternius Stylized Nature MegaKit `Bark_NormalTree`, made greyscale and normalised), generated flaky Scots pine plates, generated silver dead wood and a flat white cell. The crown cores, spruce skirts and `lod2` shells use the flat cell, so their colour is `COLOR_0` alone. Bark `COLOR_0` sets each piece's tint and darkens the foot;
- `Greyhaven_Pines_Needles`, cut-out (`MASK`), on a 1024 × 512 KTX2 atlas: four fir sprigs cut from the catalogued CC0 Poly Haven [`fir_tree_01`](https://polyhaven.com/a/fir_tree_01) twig atlas (as `conifer_crown.py` cuts them, aspect kept) for the spruces, and four painted pine shoots, long-needled for the Scots pines and short for the sapling. The gaps between needles are closed, so a card stays solid as the texture mips down. The atlas is greyscale and every card's colour comes from `COLOR_0`.

Every cell has a gutter, filled with the cell's own wrapped bark or left transparent, so mips don't bleed from neighbours. The kit costs 2 materials, 2 MB of texture memory and a 2.2 MB download (`budget` in [`releases/greyhaven-pines.json`](../releases/greyhaven-pines.json)).

**Sources.** The issue offered the catalogued Quaternius `Pine_1`. Its stylised trunk has neither a Scots pine's long bare stem nor a spruce's straight leader, and reshaping it could not give six pieces their own silhouettes, so the trunks are grown in the recipe like `greyhaven-trees`' and `Pine_1` is not used. The textures are the catalogued Quaternius bark and Poly Haven fir twig maps; the pine shoots and the flaky and dead-wood bark are generated. No new source is needed.

**Collision.** Each piece's descriptor entry carries `collisionMesh`, `{ "shape": "triangle-mesh", "vertices": [[x, y, z], ...], "triangles": [[a, b, c], ...] }` in the piece's frame: a closed, outward-wound eight-sided tube around the trunk from below the ground up to its first fork, at most 3 m (48 to 80 triangles). Crowns are walk-through.

## Edit

Each piece's skeleton (trunk, branch levels), crown, palette and bark split are in the `PIECES` table at the top of the recipe; the level-of-detail settings are `LOD1`, `LOD2` and `BARE_LODS`, and the pine shoots `TUFTS`. The recipe builds into any collection with `build(piece, level, collection, inputs)`, so it can be shaped in a live Blender scene. [`test/blender/greyhaven-pines/greyhaven-pines.test.ts`](../test/blender/greyhaven-pines/greyhaven-pines.test.ts) checks the bundle, frames, LODs, distances, collision and cost limit; its suite hydrates only the bark and fir twig maps.

Review images are in [`review/greyhaven-pines/`](../review/greyhaven-pines/): `game.jpg` from the 12 m, 0.42 rad pitch, 50° Greyhaven camera with `greyhaven-nature`'s conifer (left, bright green) and `greyhaven-trees`' beech and oak among the pines, `close.jpg` at eye level for the Scots pine's bark change, `overview.jpg` with all six beside the conifer and the beech, and `lods.jpg` with each piece's three levels.
