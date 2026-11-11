# Red sandstone building kit

A modular building kit for mmorpg in a deliberately different architecture from the [Greyhaven Outpost](outpost-kit.md): masonry instead of plaster and timber. No game location or footprint is fixed yet, so its sizes are free and the compositions below are examples. The owner chose this style from a side-by-side blockout on 2026-11-08.

- **Approach:** two layers, each edited on its own (Atlas Decision 3.1.3):
  - **Geometry:** hand-authored in Blender, [`assets/authored/sandstone-kit.blend`](../assets/authored/sandstone-kit.blend) (Git LFS).
  - **Textures:** [`adapters/blender/sandstone.py`](../adapters/blender/sandstone.py) generates ashlar, plinth, dressed-stone, slate and wood maps with numpy, reusing the Outpost recipe's helpers (its declared input `outpost`), packs them and the iron, glass and soot swatches into one 2048 px atlas, and exports the modules with the single material `sandstone-kit`, so the whole kit is one batch per pass.
- **Style:** coursed red sandstone with level courses and broken joints over a footing of long, darker blocks, buff tooled stone for quoins, arches, sills and copings, round-arched openings with keystones, plank doors with iron straps, and a 42° roof of overlapping slates between stepped gables.
- **Assets:** original, with no third-party assets.
- **Release:** one rolling release, `sandstone-kit` (Atlas Decision 7.1.5), never a numbered one. CI publishes it when a change to its sources merges, including a change to `outpost.py`.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-sandstone-kit.ts [--atlas 2048|1024] --out <directory>
```

The atlas has two modes, listed in `ATLAS_MODES` at the top of the recipe. `2048` (320 pixels per metre, about 16 MB of GPU memory) is the default, and the release ships it. `1024` (160 pixels per metre, about 4 MB) halves the edge. In a live Blender, call `use_atlas("1024")` before building to compare them.

The look of the walls and roof is set by the `ASHLAR`, `PLINTH`, `DRESSED` and `SLATE` tables at the top of the recipe: course heights, block proportions, how far joints break from course to course, colours, joint width and how much one stone or slate differs from the next. The ashlar repeats only every 2 × 4 m and the slate every 2 × 2 m.

The build runs one `external.blender.script@1` per module, imports each GLB through `scene.import.gltf@2`, encodes every texture as KTX2 (`ASSET_TOOLING_KTX`, or `ktx` on `PATH`), measures the descriptor and exports a `gltf-resources-v1` bundle packed to `<directory>/sandstone.kit.tar`. It also writes `lineage.json`, `descriptor.json` and `export.ref.json`. It needs no network or GPU, and reads the hydrated `.blend` (`git lfs pull --include="assets/authored/**"`). `test/blender/kits/sandstone-kit.test.ts` checks the grid, doorway, budgets and compositions.

## Modules

| Key | Category | Triangles | Width × depth × height (m) |
| --- | --- | --- | --- |
| `sandstone.kit.wall` | wall | 24 | 2.00 × 0.58 × 4.00 |
| `sandstone.kit.wall-half` | wall | 24 | 1.00 × 0.58 × 4.00 |
| `sandstone.kit.wall-window` | wall | 241 | 2.00 × 0.63 × 4.00 |
| `sandstone.kit.wall-door` | wall | 188 | 2.00 × 0.62 × 4.00 |
| `sandstone.kit.door` | door | 120 | 1.36 × 0.11 × 2.51 |
| `sandstone.kit.corner` | corner | 204 | 0.75 × 0.75 × 3.98 |
| `sandstone.kit.gable-6` | wall | 214 | 6.52 × 0.60 × 3.20 |
| `sandstone.kit.gable-8` | wall | 286 | 8.52 × 0.60 × 4.10 |
| `sandstone.kit.roof-6`, `roof-6-half` | roof | 40 | 2.00 or 1.00 × 6.44 × 3.16 |
| `sandstone.kit.roof-8`, `roof-8-half` | roof | 48 | 2.00 or 1.00 × 8.44 × 4.06 |
| `sandstone.kit.chimney` | chimney | 26 | 1.26 × 1.10 × 2.02 |

## Grid and frames

- **Units and axes:** metres, +Y up, right-handed. The outside of a module faces +Z.
- **Walls** are 2 m modules with 1 m `wall-half` fillers, 4 m high and 0.5 m thick. The origin is on the ground at the centre of the outer face, with the body behind it (z −0.5..0). A window is 0.9 m wide with its sill at 1.4 m and its head at 2.95 m. A doorway is 1.4 m wide, springs at 1.85 m and peaks at 2.55 m; the empty node `door.hinge` marks where the leaf hangs.
- **`door`:** the origin is the hinge (empty node `hinge`), and the closed leaf runs along +X.
- **`corner`:** the origin is the building's outer corner. The unrotated corner fits the front-right corner (+X, +Z); turn it by −90°, 180° or 90° for the others.
- **`gable-6`, `gable-8`:** stand on a gable wall at its centre, with the same frame as a wall, and step up above the roof.
- **Roof modules:** the origin is on the ground under the ridge, which runs along X. The modules run the full building length: the gables stand above them and hide their ends, so the kit has no verge pieces.
- **`chimney`:** sits on a gable's apex and has an empty node `smoke` at the flue.

Keep doors out of a wall run's end modules: their surround would meet the corner stones. Windows fit there. Module widths are multiples of the 1 m texture tile, so the masonry runs on across module joints.

## Compositions

The descriptor's `compositions` place the modules for six example buildings, each in a footprint-base-centre frame whose +Z side has a door. An item is `{ key, variant, translation, yawDegrees }`, where the yaw is about +Y.

| Composition | Footprint W × D (m) | Door | Triangles |
| --- | --- | --- | --- |
| `cottage` | 8 × 6 | Centre of the long side | 3,159 |
| `merchant` | 10 × 6 | Off-centre in the long side | 3,464 |
| `workshop` | 7 × 6 | Off-centre in the long side, with half a roof module | 2,918 |
| `longhouse` | 14 × 6 | Two in one long side | 4,577 |
| `gable-house` | 6 × 10 | In the gable end, with the ridge running away from it | 3,874 |
| `hall` | 12 × 8 | Centre of the long side, on the wider span | 5,094 |

`composition` in the recipe takes any length and span pair the modules can fill, and any wall can take `wall-door`.

## Editing the geometry

Open `assets/authored/sandstone-kit.blend` in Blender 5.2.2. It holds one collection `sandstone.<part>` per module, with one root empty `sandstone.<part>` and the mesh and its empties as children. The root's custom property `sandstone` is the JSON of the descriptor's observations; update it when an edit moves an opening, hinge or proxy. Materials are placeholders named `sandstone-<material>` (`ashlar`, `plinth`, `dressed`, `slate`, `wood`, `iron`, `glass`, `soot`). UVs are planar, 1 m per tile, and the recipe moves each face into its surface's atlas cell. A face must fit its cell, or the build fails: ashlar 2 × 4 m, slate and dressed stone 2 × 2 m, plinth 2 × 1 m, wood 3 × 2 m. That is why the roof slopes are split at every 2 m of texture.

To see the kit textured while editing, run this in a live Blender (from the repository root):

```python
import bpy, runpy
sandstone = runpy.run_path("adapters/blender/sandstone.py")
sandstone["use_sources"](runpy.run_path("adapters/blender/outpost.py"), runpy.run_path("adapters/blender/kit_common.py"))
sandstone["use_geometry"]("assets/authored/sandstone-kit.blend")
sandstone["build_composition"]("cottage", bpy.context.scene.collection)
```

Save the `.blend` before building from it: the recipe reads the file, not the open session.
