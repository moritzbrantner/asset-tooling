# Greyhaven forest floor

Walk-through woodland scatter for the floor under mmorpg's Vale woods, Wolfrun Woods and Hollowpine Reach ([#572](https://github.com/moritzbrantner/asset-tooling/issues/572)), built to the [kit standard](kit-standard.md). It is a humanlike-world temperate broadleaf forest floor: low ferns and big fern crowns, a bracken stand with browning fronds, bluebell and wood-anemone drifts, a small cluster of mushrooms and patches of fallen leaves. It is shade-loving and darker than the [meadow](greyhaven-meadow.md), so the two habitats don't mix. It is a reproducible Blender recipe, [`adapters/blender/greyhaven_forest_floor.py`](../adapters/blender/greyhaven_forest_floor.py), in one rolling release, `greyhaven-forest-floor` (`greyhaven-forest-floor.kit.tar`). No game places it yet; placement and density belong to the game (mmorpg#683). The pieces are meant to replace the procedural ferns mmorpg draws under its trees.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-forest-floor.ts [--textures full|half] --out <directory>
```

[`scripts/build-greyhaven-forest-floor.ts`](../scripts/build-greyhaven-forest-floor.ts) runs the recipe once per piece and level (21 runs, no bakes, about a minute), imports each GLB through `scene.import.gltf@2`, encodes the atlas to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. The recipe reuses the [meadow](greyhaven-meadow.md) recipe's seeded spine, placement, image and colour helpers and the [marsh](greyhaven-marsh-plants.md) recipe's stroke painters, flower regrader, card builder and material: `greyhaven_meadow.py` and `greyhaven_marsh.py` are declared, hash-pinned inputs (`meadow`, `marsh`), loaded as fresh module copies, so their own outputs are unchanged. It needs the hydrated Quaternius grass, flower and broadleaf-leaf textures (`git lfs pull --include="assets/canonical/quaternius.stylized-nature-megakit-standard.grass-png/**,assets/canonical/quaternius.stylized-nature-megakit-standard.flowers-png/**,assets/canonical/quaternius.stylized-nature-megakit-standard.leaves-normaltree-c-png/**"`) and KTX-Software's `ktx` CLI, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. Two builds give identical tars.

## Pieces

Metres, +Y up, right-handed. The origin is the patch's centre on the ground; card feet and mushroom stems run 1–3 cm below it, so a patch stays rooted on uneven ground. **`leaf-litter` lies flat 1 cm above its origin** (overlapping quads a millimetre apart, the top one 1.9 cm up), like the marsh's water lilies above the water line, so it doesn't z-fight the terrain; on a slope, tilt it with the ground or sink the origin a few centimetres. Each key is `greyhaven-forest-floor.kit.<piece>`. Every patch wanders along X with a ragged outline: it grows along a seeded, wandering spine whose width wanders too, with a few strays outside it, so no patch is a round blob or a square; the leaf litter's own edge is the scattered leaves themselves.

| Piece | What it is | Width × depth × height (m) | Covers (m²) | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- | --- |
| `fern` | four low crowns of arching, scalloped fronds (male-fern style) strung along the patch, and a few young single fronds | 2.3 × 1.1 × 0.38 | 1.17 | 246 / 60 / 2 |
| `fern-large` | two big shuttlecock crowns of knee-to-waist-high fronds (male and lady fern) and a small one | 2.9 × 1.7 × 0.82 | 2.13 | 204 / 52 / 2 |
| `bracken` | a spreading stand: stalks 0.45–1.15 m tall, each holding out one broad triangular frond that arches over; a third turning olive-brown and a few dead and rusty | 4.6 × 2.2 × 1.25 | 4.62 | 232 / 66 / 2 |
| `bluebells` | a drift of strap-leaf clumps with arching stems of nodding blue-violet bells hanging from one side | 2.1 × 1.0 × 0.42 | 0.79 | 182 / 74 / 2 |
| `wood-anemone` | a low carpet of three-parted, toothed leaf whorls, most with one white flower | 1.7 × 1.1 × 0.18 | 0.46 | 244 / 88 / 2 |
| `mushrooms` | a small cluster of six brown and pale-flecked caps on cream stems, along a buried root line | 0.41 × 0.16 × 0.10 | 0.08 | 216 / 32 / 2 |
| `leaf-litter` | eleven flat, ragged quads of fallen leaves and twigs (and two smaller strays) overlapping into one patch | 2.6 × 1.7 × 0.02 | 1.66 | 26 / 10 / 2 |

The counts and sizes are from the current build; the descriptor (the `greyhaven-forest-floor-descriptor` attachment on the first piece) has the exact values, each piece's `origin`, `coverM2` (the ground it covers), `trianglesPerCoveredM2` (16 to 527; 2,880 for the tiny mushroom cluster) and `fronds`, `flowers`, `caps` and `litterQuads`.

**Cards.** A fern frond is a strip whose width lies level across it: it leaves the crown 60–80° up and arches over in three segments, so a crown reads as a fern from the game camera above as well as from the side. A bracken frond is the same strip, held out nearly level from the top of a thin stalk card and drooping at its tip. Bluebells are two crossed strap-leaf cards a clump with two or three single-quad flower-stem cards; wood anemones are small tilted leaf squares and a flower square on a thin stalk card. Mushrooms are real geometry: a domed cap of seven sides with a shoulder ring, a gill fan under it and a four-sided tapered stem. Leaf litter quads lie flat. Card normals lean towards +Z, so a patch shades like the ground it stands on rather than as flat planes.

**Levels of detail.** `lod1` and `lod2` are variants in the same frame, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail). `lod1` keeps exactly a seeded 40 % of the fronds, plants, clumps and litter quads of each group, grown so the patch keeps its coverage and outline, with fronds bent once; for `mushrooms` it keeps the two biggest caps as five-sided cones. `lod2` is one card along the patch's long side (a triangular frond silhouette for the ferns and bracken, a blue- or white-tipped strap card for the drifts, a painted card of three mushrooms), and one flat, grown quad for the leaf litter. Each level has at most half the triangles of the one before. The switch points are the kit standard's 60 m and 180 m for a piece up to 1 m across, grown with the widest side (`scaledLodDistances`): full detail ends at 60–240 m and `lod1` at 180–720 m at the descriptor's 60° reference field of view (bracken, about 4.6 m wide, takes the fourfold maximum).

**Collision.** None. Every piece declares `collision: "none"`, so characters walk through.

**Materials and textures.** One material for the whole kit, `Greyhaven_Forest_Floor`: cut-out (`MASK`), double-sided, a 1024 px KTX2 atlas times `COLOR_0`. The atlas has three fern fronds (two scalloped, one finely divided), three bracken fronds, a stalk, the bluebell strap leaves, two bluebell stems, two anemone leaf whorls, the anemone flower, two mushroom caps, the gills, a far mushroom card and four leaf-litter cells. Fronds, stalks, strap leaves, anemone leaves and the mushroom caps and stems are greyscale, so their colour is `COLOR_0` (foot, middle and tip colours with per-crown jitter: dark, shade greens for the ferns and bluebell leaves, green, turning and dead palettes for the bracken, browns for the caps) and the game can tint them. The bluebells, the anemone flower, the leaf litter and the far mushroom card carry their own colour, still multiplied by `COLOR_0`. Every cell has a gutter filled with its mean colour, so mips don't bleed or fringe. The kit costs 1 material, 1.4 MB of texture memory and a 0.5 MB download (`budget` in [`releases/greyhaven-forest-floor.json`](../releases/greyhaven-forest-floor.json)).

**Sources.** Three catalogued CC0 Quaternius Stylized Nature MegaKit textures:

- `Grass.png`: its light-to-dark green strip shades every painted frond, stalk and leaf from foot to tip, as grey;
- `Flowers.png`: its peach flower becomes the wood anemone, cut out and regraded to white with a yellow centre;
- `Leaves_NormalTree_C.png`, the broadleaf trees' own leaf texture: its ten leaves are cut out one by one, turned, shrunk to 5–12 cm and regraded to muted autumn browns and olives for the leaf litter, so the litter matches the trees above it.

Fronds, bracken, bluebells, anemone leaves, mushroom caps and gills are painted in the recipe. No new source was needed.

## Cost at the game's density

The forest floor is cheaper per square metre than the meadow; here are the numbers for planning (the game decides density and draw distance):

- The review woodland (`game.jpg`, `game-pines.jpg`) has 280 patches over about 700 m² (0.4 patches per m²: 120 leaf-litter, 44 `fern`, 16 `fern-large`, 34 `bracken`, 34 `bluebells`, 26 `wood-anemone`, 6 `mushrooms`), about **55 triangles per m²** at full detail. Inside a bluebell drift (0.55 patches per m²) it is about 100 triangles per m², in a bracken stand at 0.35 patches per m² about 80.
- At 55 triangles per m², a woodland floor filling the view to 60 m is about 0.13 million triangles, and to the 104–240 m where full detail ends about 0.6 million.
- Overdraw is the real cost, as for the meadow and the reeds. A bracken patch is 26 near-level fronds of about 0.6 m² each, so a stand at 0.35 patches per m² stacks some 5 m² of cut-out card over each m² of ground; a `fern-large` patch has about 15 m² of frond. Fronds lie mostly level, so from the game camera a stand is 2–3 layers deep rather than the reed bed's dozens. The leaf litter is one to three flat layers of cut-out quads: cheap, but where the terrain can paint litter into its own splat map that is cheaper still. Cut-out discards defeat early depth rejection on most GPUs, so the game should end floor scatter draw distance well before `lod1`'s far switch (around 60–80 m, as for the meadow) and draw bracken as stands at clearings and edges rather than everywhere.

## Consumer notes

mmorpg draws procedural ferns under its trees today. To replace them, a consumer needs:

- **Placement under canopy**: `fern` and `fern-large` round trunks and in damp hollows, `bracken` as stands in clearings, at woodland edges and under pines (Hollowpine Reach), `bluebells` and `wood-anemone` as drifts under broadleaf canopy (not under pines), `mushrooms` at trunk feet and on rotting wood, and `leaf-litter` anywhere under broadleaves. The game knows its tree positions and canopy; the kit doesn't. Keep the meadow kit out of shade and this kit out of open meadow, so the habitats stay apart.
- **Litter height**: place `leaf-litter` at ground height; it already floats 1 cm. On steep or bumpy terrain tilt it with the ground normal or sink it slightly, so its corners don't hover.
- **Tint** per area or season through the material colour or per-instance colour, since most of the atlas is greyscale times `COLOR_0` (for example a browner bracken palette in autumn).
- **Draw distance and density** as above, within the area's frame budget (high graphics at 60 FPS on an RTX 3060 Ti with about ten kits in an area).
- Retire the procedural fern generator once the kit's ferns are placed.

## Edit

The tables at the top of the recipe set everything: each piece's patch size, crown, plant, clump, cap and quad counts and sizes (`PIECES`), the painted fronds (`FRONDS`), the bluebell strap leaves (`STRAP`), the atlas layout (`CELLS`), the painted bluebell, far-mushroom and litter colours (`BLUEBELL`, `MUSHROOM_CARD`, `LITTER`), the cut-out source leaves (`SOURCE_LEAVES`) and anemone (`SOURCE_HEADS`), the `COLOR_0` palettes (`GREENS`), and the levels (`LOD1`, `LOD2`). The recipe builds into any collection with `build(piece, level, collection, inputs)` after `use_sources(meadow, marsh)` with the two helper modules loaded (for example with `runpy.run_path`), so it can be shaped in a live Blender scene. [`test/blender/greyhaven-forest-floor/greyhaven-forest-floor.test.ts`](../test/blender/greyhaven-forest-floor/greyhaven-forest-floor.test.ts) checks the bundle, single cut-out material, `COLOR_0`, frames, the litter's float, outlines, heights, triangle ceiling, LODs, distances, absent collision and cost limit; its suite hydrates only the three Quaternius textures.

Review images are in [`review/greyhaven-forest-floor/`](../review/greyhaven-forest-floor/), rendered in the live Blender on a plain stand-in ground with the recipe's own output: `game.jpg` from the 12 m, 0.42 rad pitch, 50° Greyhaven camera, a woodland floor of ferns, bluebells, wood anemones and leaf litter under `greyhaven-trees`' oak and beech beside a strip of `greyhaven-meadow` on its lighter ground, so the habitat contrast shows; `game-pines.jpg` from the same camera towards the pine edge (`greyhaven-pines`' Scots pines) with bracken stands; `close.jpg` at eye level in a bluebell drift; `close-floor.jpg` at eye level over mushrooms, wood anemones and ferns; `overview.jpg` with the seven pieces (`mushrooms`, `bluebells`, `wood-anemone`, `leaf-litter` in front, `fern`, `fern-large`, `bracken` behind); and `lods-tall.jpg` and `lods-low.jpg` with each piece's three levels (full detail in front, `lod2` at the back).
