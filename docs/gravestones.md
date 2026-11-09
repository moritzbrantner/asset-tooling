# Gravestones

Weathered, dressed limestone for Greyhaven's graveyards ([#548](https://github.com/moritzbrantner/asset-tooling/issues/548)), built to the [kit standard](kit-standard.md): headstones in four shapes plus a broken one, a stone cross, a ledger slab, a chest tomb and a footstone. It is a reproducible Blender recipe, [`adapters/blender/gravestones.py`](../adapters/blender/gravestones.py), in one rolling release, `gravestones` (`gravestones.kit.tar`). The stone uses the same CC0 Poly Haven scan as the [limestone rocks](limestone-rocks.md), divided by its mean and multiplied by mmorpg's ground palette, so the two kits match. No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-gravestones.ts [--textures full|half] --out <directory>
```

The steps are in [`scripts/baked-rock-kit.ts`](../scripts/baked-rock-kit.ts), which the baked kits share: one recipe run per piece, `lod1` and `lod2` with [`nature_lod.py`](../adapters/blender/nature_lod.py), and a last run that packs the baked maps into one atlas. It takes about a minute and needs KTX-Software's `ktx` CLI and the hydrated scans, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there.

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-face-03-diff-2k-jpg/**,assets/canonical/poly-haven.rock-face-03-disp-2k-jpg/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**"
```

## Pieces

Metres, +Y up, right-handed, fronts towards +Z, origin on the ground at the centre of the footprint. Each key is `gravestones.kit.<piece>`. Upright stones run about 0.3 m below `y = 0`, for uneven ground (`bury` in the descriptor).

| Piece | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- |
| `headstone-round` | 0.7 × 0.1 × 1.0 | 700 / 244 / 70 | one box |
| `headstone-shoulder` | 0.8 × 0.2 × 1.1 | 760 / 266 / 76 | one box |
| `headstone-pointed` | 0.6 × 0.1 × 1.3 | 620 / 216 / 62 | one box |
| `headstone-leaning` | 0.8 × 0.5 × 1.0 | 720 / 252 / 72 | one box |
| `headstone-broken` | 1.7 × 1.2 × 0.7 | 920 / 322 / 92 | the stump's box |
| `cross` | 0.8 × 0.6 × 1.7 | 660 / 230 / 66 | plinth, shaft and arm boxes |
| `ledger` | 1.1 × 2.1 × 0.2 | 560 / 196 / 56 | one box |
| `chest-tomb` | 1.3 × 2.3 × 0.9 | 1,380 / 481 / 137 | one box |
| `footstone` | 0.4 × 0.1 × 0.3 | 300 / 104 / 30 | none |

- **`headstone-broken`** keeps its fallen top beside the stump. The top is small rubble with no collision, so characters can walk over it.
- **`footstone`** is low enough to step over and declares `collision: "none"`.
- **`cross`** has separate boxes so a character can pass close under the arms.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`, up to four times). The descriptor (the `gravestones-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one opaque material, `gravestone`, on a 2048 px KTX2 atlas (colour, normal and a half-size roughness). The kit costs 1 material, 1 draw call per piece, 12 MB of texture memory and a 4.7 MB download.

## Weathering

Three strengths at the top of the recipe, `WEATHER`, are build settings from 0 to 1, each varying by up to a quarter from block to block so that stones in one yard differ in age:

- **`wear`**: chipped edges, paler stone where edges have worn, hairline cracks and rain streaks.
- **`moss`**: grows on tops, shaded backs and at the foot, and only in stray patches on the fronts.
- **`erosion`**: rounded edges, shallow pits and lettering that fades unevenly.

The kit ships medium weathering (0.55, 0.5, 0.5), which the owner chose from a light, medium and heavy comparison. Each shipped level would cost another atlas and material, so light (0.25, 0.2, 0.2) and heavy (0.9, 0.85, 0.85) stay as settings. Large chips change the mesh; cracks and pits move into the normal map when the dense stone is baked.

The lettering is deliberately unreadable and the ring-and-cross above it is a placeholder: the owner will choose emblems and symbols later. Both come from `lettering` in the recipe.

## Edit

Shapes, block sizes, seeds and triangle counts are in the `PIECES` table at the top of the recipe, and colours and weathering in the constants above it. `test/blender/gravestones/gravestones.test.ts` checks the bundle, collision, LODs, cost limit and that two builds are byte-identical. Review images are in [`review/gravestones/`](../review/gravestones/).
