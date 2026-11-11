# Greyhaven marsh plants

Walk-through wetland scatter for mmorpg's Marsh-Lake Wetlands, Eastwater Fen and Stillwater Lake's shore ([#571](https://github.com/moritzbrantner/asset-tooling/issues/571)), built to the [kit standard](kit-standard.md). It is a humanlike-world temperate European wetland: reed beds that read as dense stands at distance with brown seed heads, a thinning reed edge, cattails, sedge, soft rush, white water lilies and marsh marigold. It is a reproducible Blender recipe, [`adapters/blender/greyhaven_marsh.py`](../adapters/blender/greyhaven_marsh.py), in one rolling release, `greyhaven-marsh-plants` (`greyhaven-marsh-plants.kit.tar`). No game places it yet; placement and density belong to the game (mmorpg#683). The pieces are meant to replace the procedural reeds mmorpg rings its water volumes with.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-marsh-plants.ts [--textures full|half] --out <directory>
```

[`scripts/build-greyhaven-marsh-plants.ts`](../scripts/build-greyhaven-marsh-plants.ts) runs the recipe once per piece and level (21 runs, no bakes, about four minutes), imports each GLB through `scene.import.gltf@2`, encodes the atlas to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. The recipe reuses the [meadow](greyhaven-meadow.md) recipe's seeded spine, placement, image and colour helpers: `greyhaven_meadow.py` is a declared, hash-pinned input (`meadow`), so the meadow's own output is unchanged. It needs the hydrated Quaternius grass and flower textures (`git lfs pull --include="assets/canonical/quaternius.stylized-nature-megakit-standard.grass-png/**,assets/canonical/quaternius.stylized-nature-megakit-standard.flowers-png/**"`) and KTX-Software's `ktx` CLI, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. Two builds give identical tars.

## Pieces

Metres, +Y up, right-handed. The origin is the patch's centre on the ground; card feet run 3 cm below it, so a patch stays rooted on uneven ground or a shallow bed. **`water-lilies` is the exception: its origin is the water line.** Its pads lie flat 1 cm above the origin (with a few tenths of a millimetre between overlapping pads) and its flowers up to 6 cm above, so a consumer places it at the water surface's height and the pads don't z-fight the water plane. Each key is `greyhaven-marsh-plants.kit.<piece>`. Every patch wanders along X with a ragged outline: its tufts grow along a seeded, wandering spine whose width wanders too, with a few strays outside it, so no patch is a round blob or a square.

| Piece | What it is | Width × depth × height (m) | Covers (m²) | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- | --- |
| `reeds-stand` | common reed (Phragmites): dense stems, drooping leaves, purple-brown plumes; a few shorter, drier tufts | 4.2 × 2.2 × 2.68 | 4.85 | 296 / 64 / 2 |
| `reeds-edge` | the same reeds thinning towards open water (+Z): tall and dense on the land side, then shorter, then single stems out in the water | 4.0 × 2.2 × 2.52 | 4.08 | 276 / 52 / 2 |
| `cattails` | bulrush (Typha): strap leaves with brown cattail heads on taller stems | 2.0 × 1.2 × 1.79 | 1.18 | 116 / 22 / 2 |
| `sedge-tussock` | a tussock sedge: arching, keeled blades with dark spikes from a tight foot, small tufts beside it | 1.3 × 0.9 × 0.89 | 0.62 | 104 / 22 / 2 |
| `rushes` | soft rush (Juncus): fine, straight, dark stems with brown flower tufts on one side | 1.9 × 1.0 × 1.05 | 0.87 | 72 / 24 / 2 |
| `water-lilies` | a loose raft of flat white-water-lily pads, a few olive older ones, and three open flowers | 2.0 × 1.6 × 0.06 | 0.94 | 52 / 20 / 10 |
| `marsh-marigold` | three low clumps of kidney leaves with forking stems of yellow flowers, for the wet margin | 1.3 × 0.4 × 0.41 | 0.30 | 110 / 40 / 2 |

The counts and sizes are from the current build; the descriptor (the `greyhaven-marsh-plants-descriptor` attachment on the first piece) has the exact values, each piece's `origin`, `coverM2` (the ground its cards stand on), `trianglesPerCoveredM2` (55 to 373) and `plumeCards`, `pads` and `flowers`.

**Cards.** A reed tuft is two or three crossed vertical cards about 0.6–0.85 m wide and 1.9–2.6 m tall, each bent once (two segments); the cattail, sedge and reed-edge cards bend once too, rush and marigold-stem cards are single quads. Lily pads and flowers (two stacked, turned layers make the open cup) lie flat; marigold leaves are small squares tilted 15–45° from facing up round each clump, and its flowers sit on forking stem cards. Card normals lean towards +Z, so a patch shades like the ground it stands on rather than as flat planes.

**Levels of detail.** `lod1` and `lod2` are variants in the same frame, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail). `lod1` keeps exactly a seeded 40 % of the tufts, tussock cards, pads, leaves and flowers of each group, grown so the patch keeps its coverage and outline, with every card single-segment. `lod2` is one card along the patch's long side (for `reeds-edge` on its dense, landward side); for `water-lilies` it is five grown pads. Each level has at most half the triangles of the one before. The switch points are the kit standard's 60 m and 180 m for a piece up to 1 m across, grown with the widest side (`scaledLodDistances`): full detail ends at 76–240 m and `lod1` at 228–720 m at the descriptor's 60° reference field of view (the reed pieces, about 4 m wide, take the fourfold maximum).

**Collision.** None. Every piece declares `collision: "none"`, so characters walk (and wade) through.

**Materials and textures.** One material for the whole kit, `Greyhaven_Marsh`: cut-out (`MASK`), double-sided, a 1024 px KTX2 atlas times `COLOR_0`. The atlas has two dense reed cells and a sparse one, a cattail cell with heads and a cattail-leaf cell, a rush cell, two sedge cells, two lily pads, two kidney leaves, a marigold stem and the two flowers. Leaves, stems and pads are greyscale, so their colour is `COLOR_0` (foot, middle and tip colours, with per-tuft jitter) and the game can tint them; the reed plumes, cattail and rush heads and the two flowers carry their own colour, still multiplied by `COLOR_0`. Every cell has a gutter filled with its mean colour, so mips don't bleed or fringe. The kit costs 1 material, 1.4 MB of texture memory and a 0.6 MB download (`budget` in [`releases/greyhaven-marsh-plants.json`](../releases/greyhaven-marsh-plants.json)).

**Sources.** Both catalogued CC0 Quaternius Stylized Nature MegaKit textures, as the meadow uses them:

- `Grass.png`: its light-to-dark green strip shades every painted leaf, stem and pad from foot to tip, as grey;
- `Flowers.png`: its yellow flower becomes the marsh marigold and its peach one the white water lily, cut out and regraded (grey divided by its mean, times the game's palette).

Reed plumes, cattail and rush heads, pads and leaves are painted in the recipe. No new source was needed.

## Cost at the game's density

Reeds are tall, so their cards cover far more screen than grass; here are the numbers for planning (the game decides density and draw distance):

- The review reed bed (`game.jpg`) has 42 `reeds-stand` and 8 `reeds-edge` over about 142 m² (0.35 patches per m², overlapping into one bed), about **100 triangles per m²** at full detail. That reads as a closed bed from the game camera; a looser 0.2 patches per m² (about 60 triangles per m²) still reads as a stand.
- Triangles are cheap here: a 15 m deep reed belt along 240 m of visible shore is about 0.36 million. Overdraw is the real cost. A stand is 74 cards of about 1.7 m² each, so a bed at 0.35 patches per m² stacks some 40 m² of cut-out card over each m² of ground, and a camera looking across a bed shades many layers. Cut-out discards also defeat early depth rejection on most GPUs. The game should draw reed beds as shoreline bands rather than wide fields, cap reed draw distance well short of the 240 m where full detail ends (around 100–120 m), and switch to `lod1` sooner if the beds cost too much; a depth pre-pass for the cut-out material helps too.
- The low pieces cost about the same as the meadow: 55–170 triangles per covered m², except the small marigold clumps (373 per covered m², 110 triangles a piece).

## Consumer notes

mmorpg already rings its water volumes with procedural reeds. To replace them, a consumer needs:

- **Shoreline placement**: run `reeds-edge` along each shoreline with its +Z side facing open water, `reeds-stand` behind it (overlapping, in the shallows and up the bank), `cattails` in gaps and at the ends of beds, `rushes`, `sedge-tussock` and `marsh-marigold` on the wet bank, and `water-lilies` on calm, open water at the water surface's height. The game knows its water volumes' outlines and surface heights; the kit doesn't.
- **Depth**: reed and cattail feet sink 3 cm and may stand in shallow water; the water surface hides the stems below it.
- **Tint** per area or season through the material colour or per-instance colour, since most of the atlas is greyscale times `COLOR_0`.
- **Draw distance and density** as above, within the area's frame budget (high graphics at 60 FPS on an RTX 3060 Ti with about ten kits in an area).

## Edit

The tables at the top of the recipe set everything: each piece's patch length and width, tuft count, strays, tuft kinds and extras (`PIECES`), the painted reed cells (`REEDS`), the sedge cells (`SEDGES`), the atlas layout (`CELLS`), the painted plume and head colours (`PLUME`, `CATTAIL_HEAD`, `RUSH_HEAD`), the regraded Quaternius flowers (`SOURCE_HEADS`), the `COLOR_0` palettes (`GREENS`, `PADS`), and the levels (`LOD1`, `LOD2`). The recipe builds into any collection with `build(piece, level, collection, inputs)` after `use_meadow(runpy.run_path("greyhaven_meadow.py"))`, so it can be shaped in a live Blender scene. [`test/blender/greyhaven-marsh-plants/greyhaven-marsh-plants.test.ts`](../test/blender/greyhaven-marsh-plants/greyhaven-marsh-plants.test.ts) checks the bundle, single cut-out material, `COLOR_0`, frames, the lilies' water-line origin, outlines, triangle ceiling, LODs, distances, absent collision and cost limit; its suite hydrates only the two Quaternius textures.

Review images are in [`review/greyhaven-marsh-plants/`](../review/greyhaven-marsh-plants/), rendered in the live Blender with a stand-in water plane and bank: `game.jpg` from the 12 m, 0.42 rad pitch, 50° Greyhaven camera, a reed bed in the shallows with its thinning edge towards open water, cattails, water lilies, marsh marigold on the margin and rushes and sedge on the bank, beside two of `greyhaven-trees`' alders; `close.jpg` at eye level at the reed edge; `close-shore.jpg` at eye level over the lilies towards the cattails and marigolds; `overview.jpg` with the seven pieces (`reeds-stand`, `reeds-edge`, `cattails`, `rushes`, `sedge-tussock`, `marsh-marigold`, `water-lilies`, left to right); and `lods.jpg` with each piece's three levels (levels left to right; `reeds-stand` in front, `water-lilies` at the back).
