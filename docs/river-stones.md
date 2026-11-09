# River stones

Water-worn stones for Greyhaven's brook ([#538](https://github.com/moritzbrantner/asset-tooling/issues/538)), built to the [kit standard](kit-standard.md): boulders for the water to break around, stepping stones, cobbles for the bed, stones lining the banks and gravel for the inside of bends. It is the second of the rock kits that come one per geology, after [limestone](limestone-rocks.md), and is sized for a brook 1.8–2.6 m wide. It is a reproducible Blender recipe, [`adapters/blender/river_stones.py`](../adapters/blender/river_stones.py), in one rolling release, `river-stones` (`river-stones.kit.tar`). No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-river-stones.ts [--textures full|half] --out <directory>
```

The steps are in [`scripts/baked-rock-kit.ts`](../scripts/baked-rock-kit.ts), which the rock kits share: one recipe run per piece, `lod1` and `lod2` with [`nature_lod.py`](../adapters/blender/nature_lod.py), the baked maps packed into one atlas and encoded to KTX2. It needs KTX-Software's `ktx` CLI and the hydrated scans, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there.

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-boulder-dry-*/**,assets/canonical/poly-haven.forrest-ground-01-diff-2k-jpg/**,assets/canonical/poly-haven.rocks-ground-02-diff-2k-jpg/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**"
```

Its colours are already catalogued CC0 Poly Haven scans, matched to mmorpg's ground palette: `rock_boulder_dry` for the surface, with `rocks_ground_02` and `mossy_rock` for tint and moss. Each stone varies a little, and darkens below the waterline.

## Pieces

Metres, +Y up, right-handed, origin at the centre of the footprint. `y = 0` is the ground, or the stream bed for the bed pieces. Each key is `river-stones.kit.<piece>`.

| Piece | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- |
| `boulder-1` | 1.8 × 1.4 × 0.8 | 900 / 314 / 90 | `collisionMesh` |
| `boulder-2` | 1.3 × 1.1 × 0.6 | 700 / 244 / 70 | `collisionMesh` |
| `boulder-3` | 1.0 × 0.9 × 0.5 | 500 / 174 / 50 | `collisionMesh` |
| `step-1` | 0.9 × 0.7 × 0.3 | 420 / 146 / 42 | `collisionMesh` |
| `step-2` | 0.7 × 0.6 × 0.3 | 380 / 132 / 38 | `collisionMesh` |
| `bed-1` | 2.7 × 1.8 × 0.1 | 1,000 / 345 / 66 | none |
| `bed-2` | 1.6 × 1.4 × 0.1 | 650 / 223 / 43 | none |
| `bank-1` | 4.1 × 1.2 × 0.2 | 1,400 / 490 / 135 | none |
| `bank-2` | 2.7 × 1.0 × 0.1 | 900 / 314 / 86 | none |
| `bar-1` | 3.6 × 1.4 × 0.1 | 1,500 / 506 / 80 | none |
| `bar-2` | 1.8 × 1.1 × 0.1 | 850 / 288 / 44 | none |

- **Solid stones** carry `collisionMesh`, the same stone on a coarse sphere (80 triangles, closed and wound outward). A stepping stone's top is cut nearly flat, so a character can stand on it.
- **Debris** (beds, banks and bars) is walk-on and declares `collision: "none"`. Each piece is loose stones with nothing between them, so it lies on any ground with no edge to hide.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view. The descriptor (the `river-stones-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one opaque material, `river-stone`, on a 1024 px KTX2 atlas (colour, normal and a half-size roughness). The kit costs 1 material, 3 MB of texture memory and a 2.1 MB download.

## Edit

Sizes, stone counts, seeds and triangle counts are in the tables at the top of the recipe. `test/blender/river-stones/river-stones.test.ts` checks the bundle, collision, LODs and cost limit. Review images are in [`review/river-stones/`](../review/river-stones/), from the 12 m, 0.42 rad pitch, 50° Greyhaven camera, with a stand-in water sheet and bed.
