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
