# Greyhaven deadwood

Fallen wood for the floor of mmorpg's Greyhaven woods and wetland edges ([#573](https://github.com/moritzbrantner/asset-tooling/issues/573)), built to the [kit standard](kit-standard.md): three logs, two stumps, an upturned root plate and two kinds of loose branches, made to lie under [`greyhaven-trees`](greyhaven-trees.md) and [`greyhaven-pines`](greyhaven-pines.md) in the same humanlike-world style. It is a reproducible Blender recipe, [`adapters/blender/greyhaven_deadwood.py`](../adapters/blender/greyhaven_deadwood.py), in one rolling release, `greyhaven-deadwood` (`greyhaven-deadwood.kit.tar`). No game places it yet; placement belongs to the game (mmorpg#683).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-deadwood.ts [--textures full|half] --out <directory>
```

[`scripts/build-greyhaven-deadwood.ts`](../scripts/build-greyhaven-deadwood.ts) runs the recipe once per piece and level (24 runs, no bakes), imports each GLB through `scene.import.gltf@2`, encodes the atlas to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. It takes about two minutes and needs the hydrated scans and KTX-Software's `ktx` CLI, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. Two builds give identical tars.

```sh
git lfs pull --include="assets/canonical/quaternius.stylized-nature-megakit-standard.bark-normaltree-png/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**,assets/canonical/poly-haven.forrest-ground-01-diff-2k-jpg/**"
```

**Reused, not copied.** The recipe's declared, hash-pinned inputs are its siblings' recipes and three catalogued CC0 scans:

- `greyhaven_trees.py`: the furrowed bark cell made from the Quaternius `Bark_NormalTree` image (the oak's bark), its tileable noise and colour helpers;
- `greyhaven_pines.py`: the flaky Scots pine cell and the silver deadwood cell;
- `moss.py`: the moss grading (the Poly Haven `mossy_rock` scan divided by its mean and multiplied by mmorpg's moss palette, its dark cracks painted out) and its hollow-to-crown colours, so the moss matches the [`moss`](moss.md) kit;
- the CC0 Quaternius bark, Poly Haven `mossy_rock` and Poly Haven `forrest_ground_01` colour maps, from `catalog/storage.json`.

The sibling kits' outputs don't change: this kit only calls their functions.

## Pieces

Metres, +Y up, right-handed. Each key is `greyhaven-deadwood.kit.<piece>`. The game turns each placement about +Y and scales it about 0.85 to 1.2.

| Piece | Width × depth × height (m) | What it is | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- | --- |
| `log-oak` | 4.8 × 0.9 × 0.8 | a bowed, lumpy oak trunk, snapped at both ends, with three bark stubs | 794 / 176 / 60 | `collisionMesh`, 80 triangles |
| `log-pine` | 6.1 × 0.8 × 0.6 | a long, straight, tapering pine trunk with six stubs; its last third has lost its bark to silver deadwood | 852 / 182 / 70 | `collisionMesh`, 80 |
| `log-hollow` | 3.6 × 1.4 × 0.9 | a thick oak section rotted hollow, open at both ends | 1,110 / 288 / 100 | `collisionMesh`, 80 (solid: nothing walks inside) |
| `stump-oak` | 2.1 × 2.0 × 0.8 | a broad stump on a lobed root flare with five roots into the ground, its top torn into splinters | 390 / 152 / 42 | `collisionMesh`, 48 |
| `stump-pine` | 1.4 × 1.3 × 1.0 | a narrower, taller pine stump with two tall splinters | 334 / 127 / 42 | `collisionMesh`, 48 |
| `root-plate` | 1.7 × 3.1 × 2.1 | a fallen tree's upturned roots: a lumpy disc of earth standing on edge, roots running over both faces and snapped beyond its rim, the old forest floor's moss along its top, and the torn trunk stub | 1,161 / 265 / 94 | `collisionMesh`, 60 (plate and stub) |
| `branch-pile` | 3.1 × 2.6 × 0.5 | about twenty crossing branches heaped highest in the middle, with forked twigs | 1,638 / 252 / 48 | none (walk-through) |
| `branches-scatter` | 3.0 × 2.1 × 0.07 | eleven thinner branches flat on the ground | 858 / 132 / 24 | none (walk-through) |

The counts and sizes are from the current build; the descriptor (the `greyhaven-deadwood-descriptor` attachment on the first piece) has the exact values. Heights include stubs and splinters.

**Origins.** Logs lie along X with the origin at the centre of their footprint on the ground; each ring sinks about 12 % of its radius into the ground. Stumps stand on the origin with the root flare 0.25 m below it. The root plate stands across X with its foot on the origin, 0.25 m buried, and its trunk stub leaving towards +X: lay a log beyond the stub to finish the fallen tree, and give it a hollow on the -X side where the terrain allows. Branch piles and scatters centre on the origin.

**Collision.** Logs, stumps and the root plate carry `collisionMesh`: a closed, outward-wound mesh of at most 240 triangles (8-sided tubes through the log or stump, the plate as an 8-sided slab plus its stub) that stays at or just inside the wood and never above it, so a character can step or climb onto a log or stump. Roots, stubs and splinters are left out. The branch pile and scatter declare `collision: "none"`.

**Levels of detail.** `lod1` and `lod2` are variants in the same frame from the same seed, in the crag and nature kits' format. `lod1` halves the sides and rings and drops stubs and twigs (stumps keep thinner roots, the root plate half its roots); `lod2` thins them again, drops every root and keeps only the thickest branches. Each level has at most half the triangles of the one before. Switch points are distances, 60 m and 180 m for a piece up to 1 m across, scaled by `scaledLodDistances` with the widest side up to four times, so the logs keep full detail to 240 m (the hollow log 217 m) and the smallest stump to 85 m. The descriptor has `lodSelection` and each piece's `lods`.

## Look

**Materials and textures.** One opaque material, `Greyhaven_Deadwood`, on one 2048 × 1024 KTX2 atlas of eight 512 px cells, each with a 16 px gutter of its own wrapped content: oak log, pine log, silver deadwood, end grain (a broken face's rings, radial checks and a darker rotten heart), oak stump, pine stump, punky rotten wood (hollow insides and roots) and the root plate's earth. Unlike the tree kits, the colour is in the atlas, because moss and bark share a cell; `COLOR_0` is greyscale and only darkens: towards the ground (0.42 at the ground, full by 0.55 m), underneath, and to 0.8 at most, the trees' bark brightness at log height. Branches are darker still. The kit costs 1 material, 1 draw call per piece, 2.7 MB of texture memory and a 0.9 MB download (`budget` in [`releases/greyhaven-deadwood.json`](../releases/greyhaven-deadwood.json)).

**Bark that matches the trees.** The oak log and stump are `greyhaven-trees`' furrowed cell in its oak tint. The pine log is `greyhaven-pines`' flaky cell, softened and browned as a fallen trunk's bark weathers; the pine stump is the Scots pine's furrowed lower trunk in its tint. Stripped wood and branches use the pines' silver deadwood cell.

**Moss.** A log's tube is mapped so its top is the middle of the cell, and the moss grows along that middle. Its edge is ragged and wandering: a broad noise field lets the band widen, narrow and break, two finer ones fray it, and the rim feathers into speckles, as the `moss` kit's edges do. Wood just outside the moss is darker and greener, where it stays damp. Stump moss creeps down from the broken top, mostly on one side; the earth cell carries the old forest floor's moss along the plate's top, and end grain a little moss creeping in from part of its rim.

## Edit

The tables at the top of the recipe set the colours (`OAK_BARK`, `PINE_BARK`, `DEADWOOD`, `HEARTWOOD`, `SAPWOOD`, `ROTTEN`, `SOIL`), the moss on each bark cell (`MOSS`, `STUMP_MOSS`), the ground darkening (`GROUND_DARK`, `UNDERSIDE`, `TONE`), each piece's size, taper, bend, sides, stubs, roots and seed (`PIECES`) and the levels (`LODS`). The recipe builds into any collection with `build(piece, level, collection, inputs)`, so it can be shaped in a live Blender scene. [`test/blender/greyhaven-deadwood/greyhaven-deadwood.test.ts`](../test/blender/greyhaven-deadwood/greyhaven-deadwood.test.ts) checks the bundle, the single opaque atlas, triangle limits, LOD halving and distances, closed outward-wound collision on solid pieces, none on the branches, and the cost limit; its suite hydrates only the three scans.

Review images are in [`review/greyhaven-deadwood/`](../review/greyhaven-deadwood/), rendered in the live Blender on the forest-floor kit's review woodland (its plain stand-in ground, `greyhaven-trees` and `greyhaven-pines` trees and `greyhaven-forest-floor` ferns, bluebells, anemones and litter) with this recipe's output: `game.jpg` from the 12 m, 0.42 rad pitch, 50° Greyhaven camera; `close.jpg` at eye level over the oak log; `overview.jpg` with the eight pieces at full detail (branches on the left, logs on the right); `collision.jpg` the same with each collision mesh drawn as red wire; and `lods.jpg` with each piece's three levels (full detail in front, `lod2` at the back).

## What a consumer needs

- Load `greyhaven-deadwood.kit.tar` through the bundle importer, one material shared by every piece and level.
- Read the descriptor for each piece's `lods` and pick levels by distance; feed `collisionMesh` to the content build for the six solid pieces, and nothing for the two walk-through ones.
- Place it: logs and stumps under broadleaf and pine canopy and along wetland edges, a root plate with a log beyond its stub, branch piles at trunk feet and clearings, scatter anywhere under trees. Sink pieces a few centimetres on slopes.
