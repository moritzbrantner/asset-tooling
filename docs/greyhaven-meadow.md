# Greyhaven meadow

Walk-through grass and wildflower scatter for mmorpg's Vale meadows, farmland verges and downs ([#570](https://github.com/moritzbrantner/asset-tooling/issues/570)), built to the [kit standard](kit-standard.md). It is the "grass" base kit: a humanlike-world temperate meadow of mixed tall and short grass with sparse buttercups, ox-eye daisies, clover and red campion, never an even lawn. It is a reproducible Blender recipe, [`adapters/blender/greyhaven_meadow.py`](../adapters/blender/greyhaven_meadow.py), in one rolling release, `greyhaven-meadow` (`greyhaven-meadow.kit.tar`). No game places it yet; placement and density belong to the game (mmorpg#683).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-meadow.ts [--textures full|half] --out <directory>
```

[`scripts/build-greyhaven-meadow.ts`](../scripts/build-greyhaven-meadow.ts) runs the recipe once per piece and level (24 runs, no bakes, about two minutes), imports each GLB through `scene.import.gltf@2`, encodes the atlas to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. It needs the hydrated Quaternius grass and flower textures (`git lfs pull --include="assets/canonical/quaternius.stylized-nature-megakit-standard.grass-png/**,assets/canonical/quaternius.stylized-nature-megakit-standard.flowers-png/**"`) and KTX-Software's `ktx` CLI, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. Two builds give identical tars.

## Pieces

Metres, +Y up, right-handed. The origin is the patch's centre on the ground; card feet run 3 cm below it, so a patch stays rooted on uneven ground. Each key is `greyhaven-meadow.kit.<piece>`. Every patch wanders along X with a ragged outline: its tufts grow along a seeded, wandering spine whose width wanders too, with a few strays outside it, so no patch is a round blob or a square.

| Piece | Habitat | Width × depth × height (m) | Covers (m²) | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- | --- |
| `grass-short` | meadow and verge turf: short tufts, a few taller seed heads | 2.1 × 1.0 × 0.41 | 1.17 | 168 / 62 / 2 |
| `grass-tall` | uncut meadow: timothy and cocksfoot with seed heads over short grass | 1.9 × 1.1 × 0.88 | 0.77 | 228 / 52 / 2 |
| `grass-clump` | a tussock, arching blades from a tight foot, with a few small tufts beside it | 1.1 × 0.9 × 0.59 | 0.43 | 116 / 24 / 2 |
| `grass-dry` | the downs: sun-bleached, sparse, fine bent with seed sprays | 2.0 × 1.2 × 0.54 | 1.11 | 140 / 54 / 2 |
| `flowers-yellow` | buttercups in two or three drifts in short grass | 1.9 × 1.1 × 0.42 | 1.08 | 178 / 70 / 2 |
| `flowers-white` | ox-eye daisies and white clover | 1.9 × 1.1 × 0.51 | 1.13 | 172 / 68 / 2 |
| `flowers-red` | red campion (two or three heads a stem) and red clover | 2.0 × 1.0 × 0.57 | 1.11 | 196 / 74 / 2 |
| `flowers-mixed` | a few of each among short and tall grass | 2.1 × 1.2 × 0.60 | 1.14 | 188 / 62 / 2 |

The counts and sizes are from the current build; the descriptor (the `greyhaven-meadow-descriptor` attachment on the first piece) has the exact values, each piece's `coverM2` (the ground its cards stand on) and `trianglesPerCoveredM2` (126 to 296).

**Cards.** A tuft is two or three crossed vertical cards; `grass-tall` and the tussock's cards bend once (two segments), every other card is a single quad. A flower is a stem card with one to three small heads, each a square tilted 10–70° from facing up so it reads from the game camera. Card normals lean towards +Z, so a patch shades like the ground it stands on rather than as flat planes.

**Levels of detail.** `lod1` and `lod2` are variants in the same frame, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail). `lod1` keeps exactly a seeded 40 % of the tufts, tussock cards and flowers of each kind, grown so the patch keeps its coverage and outline, with every card single-segment. `lod2` is one card along the patch's long side, coloured as its mean (tinted towards the flowers on flower pieces). Each level has at most half the triangles of the one before. The switch points are the kit standard's 60 m and 180 m for a piece up to 1 m across, grown with the widest side (`scaledLodDistances`): full detail ends at 65–125 m and `lod1` at 194–376 m at the descriptor's 60° reference field of view.

**Collision.** None. Every piece declares `collision: "none"`, so characters walk through.

**Materials and textures.** One material for the whole kit, `Greyhaven_Meadow`: cut-out (`MASK`), double-sided, a 1024 px KTX2 atlas times `COLOR_0`. The atlas has painted grass cells (short, tall with timothy spikes or cocksfoot panicles, dry with seed sprays, tussock), two stem cells (a stem with narrow leaves, a clover stalk with trefoil leaves) and four flower heads. Grass, stems and clover heads are greyscale, so their colour is `COLOR_0` (dark at the foot, lighter at the tip, with per-tuft jitter) and the game can tint them; only the buttercup, campion and daisy heads carry their own colour. Every cell has a gutter filled with its mean colour, so mips don't bleed or fringe. The kit costs 1 material, 1.4 MB of texture memory and a 0.6 MB download (`budget` in [`releases/greyhaven-meadow.json`](../releases/greyhaven-meadow.json)).

**Sources.** Both catalogued CC0 Quaternius Stylized Nature MegaKit textures:

- `Grass.png`: its light-to-dark green strip gives every painted blade its tip-to-base shading, as grey;
- `Flowers.png`: its yellow flower becomes the buttercup and its red one the red campion, cut out and regraded (grey divided by its mean, times the game's palette). The ox-eye daisy and the clover head are painted in the recipe.

The catalogued `Grass_Common_Short` and `Bush_Common_Flowers` models are not used: they are thick stylised blade meshes, not cut-out cards, and would cost more triangles for less coverage.

## Cost at the game's density

Grass is where the frame budget goes, so here are the numbers for planning (the game decides density and draw distance):

- The review meadow (`game.jpg`) has 0.96 patches per m² (with bare gaps), about **175 triangles per m²** at full detail. A sparser 0.6 patches per m² is about 110 triangles per m² and already reads as patchy meadow.
- At 175 triangles per m², a meadow filling the view to 60 m is about 0.4 million triangles, and to the 112–125 m where full detail ends about 1.9 million. Cut-out overdraw costs more than the triangles, so the game should end grass draw distance well before `lod1`'s far switch, around 60–80 m, where a patch is a few pixels tall.

## Edit

The tables at the top of the recipe set everything: each piece's patch length and width, tuft count, strays, tuft kinds and flowers (`PIECES`), the painted grass cells (`BLADES`), the atlas layout (`CELLS`), the regraded Quaternius heads (`SOURCE_HEADS`), the flower sizes, heights and tilts (`HEADS`), the `COLOR_0` palettes (`GREENS`), and the levels (`LOD1`, `LOD2`). The recipe builds into any collection with `build(piece, level, collection, inputs)`, so it can be shaped in a live Blender scene. [`test/blender/greyhaven-meadow/greyhaven-meadow.test.ts`](../test/blender/greyhaven-meadow/greyhaven-meadow.test.ts) checks the bundle, single cut-out material, `COLOR_0`, frames, outlines, triangle ceiling, LODs, distances, absent collision and cost limit; its suite hydrates only the two Quaternius textures.

Review images are in [`review/greyhaven-meadow/`](../review/greyhaven-meadow/): `game.jpg` from the 12 m, 0.42 rad pitch, 50° Greyhaven camera, a meadow at 0.96 patches per m² beside `greyhaven-trees`' oak, young oak and beech; `close.jpg` at eye level; `overview.jpg` with the eight pieces (grass in front, flowers behind); and `lods.jpg` with `grass-tall`, `grass-short`, `flowers-mixed` and `grass-clump` at their three levels (back to front; levels left to right).
