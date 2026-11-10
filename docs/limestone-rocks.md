# Limestone rocks

Greyhaven's rock: low, level-bedded outcrops, a long ledge, square-edged fallen blocks and loose scree, built to the [kit standard](kit-standard.md) ([#536](https://github.com/moritzbrantner/asset-tooling/issues/536)). Rock kits come one per geology, the way the [Outpost](outpost-kit.md) and [sandstone](sandstone-kit.md) kits are separate house kits, so an area picks its own. It is a reproducible Blender recipe, [`adapters/blender/limestone_rocks.py`](../adapters/blender/limestone_rocks.py), in one rolling release, `limestone-rocks` (`limestone-rocks.kit.tar`). No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-limestone-rocks.ts [--textures full|half] --out <directory>
```

[`scripts/build-limestone-rocks.ts`](../scripts/build-limestone-rocks.ts) runs the recipe once per piece, imports each GLB through `scene.import.gltf@2`, makes `lod1` and `lod2` with [`nature_lod.py`](../adapters/blender/nature_lod.py), packs the baked maps into one atlas and encodes it to KTX2. It takes about 5 minutes and needs KTX-Software's `ktx` CLI and the hydrated scans, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there.

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-face-03-*/**,assets/canonical/poly-haven.forrest-ground-01-diff-2k-jpg/**,assets/canonical/poly-haven.rocks-ground-02-diff-2k-jpg/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**"
```

The recipe reuses the sculpt, bake and atlas steps of [`cliff_outcrop.py`](../adapters/blender/cliff_outcrop.py), which it reads as a declared input and does not change. Its colours are the terrain's own CC0 Poly Haven scans (`rock_face_03`, `forrest_ground_01`, `rocks_ground_02`, `mossy_rock`), each divided by its mean and multiplied by mmorpg's ground palette, so a rock matches the ground around it.

## Pieces

Metres, +Y up, right-handed, origin on the ground at the centre of the footprint. Each key is `limestone-rocks.kit.<piece>`. The footprint includes the rubble at the foot.

| Piece | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- |
| `outcrop-1` | 11.2 × 7.7 × 4.5 | 5,994 / 2,097 / 593 | `collisionMesh` |
| `outcrop-2` | 8.6 × 5.9 × 3.2 | 5,000 / 1,749 / 498 | `collisionMesh` |
| `ledge` | 12.0 × 5.7 × 1.8 | 3,500 / 1,224 / 343 | `collisionMesh` |
| `block-1` | 5.1 × 4.2 × 2.3 | 2,199 / 768 / 208 | `collisionMesh` |
| `block-2` | 3.1 × 2.9 × 1.5 | 1,499 / 523 / 137 | `collisionMesh` |
| `block-3` | 2.6 × 2.2 × 1.0 | 900 / 312 / 75 | `collisionMesh` |
| `scree-1` | 7.1 × 4.6 × 0.3 | 1,800 / 630 / 127 | none |
| `scree-2` | 4.3 × 2.9 × 0.2 | 1,100 / 384 / 78 | none |

- **Rocks** run below ground by `bury`, so they meet uneven terrain, and blend through gravel to grass at the foot. `collisionMesh` is a closed outward-wound mesh of 120 triangles that leaves the soft apron out, so a character can walk onto it.
- **Scree** is loose stones with nothing between them, so it lies on any terrain with no edge to hide. It's walk-on and declares `collision: "none"`.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view (`LIMESTONE_LOD_DISTANCES`). The descriptor (the `limestone-rocks-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one opaque material, `limestone-rock`, on a 2048 px KTX2 atlas (colour, normal and a half-size roughness). Each piece's cell keeps a gutter. The kit costs 1 material, 12 MB of texture memory and a 7 MB download.

## Edit

Sizes, seeds, triangle counts and how far each rock tapers are in the tables at the top of the recipe. A long thin rock needs its own coarser `cell`, or decimation collapses its body. `test/blender/limestone-rocks/limestone-rocks.test.ts` checks the bundle, volumes, collision, LODs and cost limit. Review images are in [`review/limestone-rocks/`](../review/limestone-rocks/), from the 12 m, 0.42 rad pitch, 50° Greyhaven camera.

## Layered surface trial

[#567](https://github.com/moritzbrantner/asset-tooling/issues/567) asks whether nature and stone kits should keep shipping baked atlases, or geometry and masks over a shared material library that the game blends. `--surface layered` builds the second kind from the same recipe; `--surface baked`, the default, is the published kit and its bytes don't change.

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-limestone-rocks.ts --surface layered --out <directory>
```

- **Pieces:** the baked kit's meshes and LODs. [`limestone_rock_surface.py`](../adapters/blender/limestone_rock_surface.py) rebuilds each game mesh without the bake and keeps the sculpt's masks, which move onto every level by nearest vertex as the `_SURFACE_MASK` vertex attribute: R soil, G moss, B grass, A cavity. The pieces lose their UVs, tangents and baked maps and share one untextured material, `limestone-rock-layered`.
- **Library:** one more bundle entry, `limestone-rocks.kit.surface-library`, with three tileable 1024 px materials graded to mmorpg's palette: `surface.limestone` (colour and a normal map from the height scan), `surface.moss` and `surface.soil`. Every layered kit would share it.
- **Weathering:** light, medium and heavy are thresholds on the moss mask and a cavity strength (`SURFACE_WEATHERING` in [`scripts/baked-rock-kit.ts`](../scripts/baked-rock-kit.ts)), in the descriptor's `surface` block with the blend order. No extra textures.
- **No release.** The trial publishes nothing; the game would need its own blend shader (mmorpg / 3d-lab) before it could use the layered kit.

### Measured

`bun scripts/measure-surface-trial.ts --baked <tar> --layered <tar>` puts both kits on a Greyhaven-like scatter of 258 rocks, renders each surface from the 12 m, 0.42 rad, 50° game camera and two wider ones, and writes [`review/limestone-rocks/surface-trial/`](../review/limestone-rocks/surface-trial/). The Pages site shows those results at `compare/limestone-surface/`, and the live scene when it's built with `ASSET_TOOLING_LIMESTONE_BAKED_TAR` and `ASSET_TOOLING_LIMESTONE_LAYERED_TAR`. The layered kit uses a reference triplanar blend written for that page, not the game's shader. Measured on 2026-11-10 in headless Chromium on the RTX 3060 Ti through ANGLE/Vulkan:

| | Baked | Layered |
| --- | --- | --- |
| Release tar | 7.06 MB | 2.83 MB, of which 1.70 MB is the shared library |
| Texture files | 4.52 MB, 3 textures | 1.70 MB, 4 textures, shared by every layered kit |
| Texture GPU memory | 12.0 MB | 5.33 MB, shared |
| Geometry files | 2.38 MB | 1.01 MB (no UVs or tangents) |
| Materials | 1 | 1; the blend binds the library's textures |
| Draw calls, game camera | 25 | 25 |
| Frame time, game camera | 0.32 ms | 0.24 ms (light, medium and heavy alike) |

Frame time is the median of 5 runs of 240 frames rendered back to back without vsync, rocks and ground only, no shadows: both are far inside the 16.7 ms of 60 FPS, so on this scene the choice is about memory and files, not frame time.

The cost diverges with the number of kits. Ten baked stone kits at 12 MB each take 120 MB of texture memory, and 360 MB with a light, medium and heavy atlas each. Ten layered kits take the 5.3 MB library once, plus their meshes, and weathering costs nothing.

What the layered kit loses is the sculpt's baked normal detail: the strata ledges and cracks read flatter, and the cavity mask, sampled per vertex, tens of centimetres apart, darkens in soft blotches instead of crisp cracks. Weathering thresholds only grow and shrink the moss on upward faces, because that's all the masks encode; at the game camera light and heavy differ modestly.

**Recommendation:** per kit. Scatter-scale natural stone (rocks, scree, cliffs, river stones) goes layered, since that's where the kit count grows with the continent and the look holds at gameplay distance. Hero and modular pieces seen close up (monuments, buildings) stay baked. A layered rock kit that needs its strata back could keep one small per-piece normal map without changing the rest. The owner decides, and [`kit-standard.md`](kit-standard.md) records it.
