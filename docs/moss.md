# Moss

Thin, feathered cushion moss for Greyhaven's graveyards and ruins ([#554](https://github.com/moritzbrantner/asset-tooling/issues/554)), built to the [kit standard](kit-standard.md): seven generic pieces to lay over stone and shady ground, with ragged cut-out edges, matched to the moss painted on the [gravestones](gravestones.md) and [monuments](monuments.md). It is a reproducible Blender recipe, [`adapters/blender/moss.py`](../adapters/blender/moss.py), in one rolling release, `moss` (`moss.kit.tar`). No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-moss.ts [--textures full|half] --out <directory>
```

[`scripts/build-moss.ts`](../scripts/build-moss.ts) runs the recipe once per piece and level, adds tangents and `COLOR_0`, and encodes the shared atlas to KTX2. It takes about a minute and needs KTX-Software's `ktx` CLI and the hydrated scan, but no network or GPU.

```sh
git lfs pull --include="assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**"
```

Each piece is a height field. One set of noise fields gives its outline, height and shading, and those same fields paint the piece's cell of the atlas and raise a coarse game mesh, so nothing is baked. The colour is the CC0 Poly Haven `mossy_rock` scan, divided by its mean and multiplied by mmorpg's moss palette, with the scan's dark cracks painted out.

## Pieces

Metres, +Y up, right-handed. Each key is `moss.kit.<piece>`. `attach` in the descriptor says where a piece's origin goes.

| Piece | `attach` | Width × depth × height (m) | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- |
| `top-cap` | `top` | 0.8 × 1.6 × 0.04 | 480 / 138 / 42 |
| `edge-drape` | `edge` | 1.2 × 0.5 × 0.3 | 890 / 248 / 78 |
| `foot-ring` | `foot` | 1.4 × 0.9 × 0.04 | 596 / 182 / 48 |
| `step-strip` | `block-foot` | 1.2 × 0.2 × 0.04 | 214 / 66 / 24 |
| `corner-strip` | `block-foot` | 0.8 × 0.2 × 0.03 | 114 / 36 / 10 |
| `ground-mat` | `ground` | 2.3 × 1.4 × 0.04 | 724 / 210 / 68 |
| `scatter` | `ground` | 1.7 × 1.3 × 0.02 | 786 / 246 / 82 |

- **`top`** and **`ground`**: the origin is at the patch's centre on the surface.
- **`foot`**: the origin is on the ground at the centre of a stone's foot. The stone stands inside `fit.halfWidth` (0.34) and `fit.halfDepth` (0.09), and the moss spreads about 0.34 m out from it.
- **`block-foot`**: the origin is on the step at the foot of a block's +Z face, with the moss spreading along +Z. A strip reaches 3 cm back under the block, so turn it to suit each side.
- **`edge`**: the origin is on the front edge of a top surface. The moss lies back along -Z for `fit.over` metres (0.42) and folds down over the +Z face.

Scale and turn each placement to fit.

- **Collision:** none. Every piece declares `collision: "none"`, so characters walk over it.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`, up to four times). The descriptor (the `moss-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`. Lower levels are coarser meshes on the same atlas, so the ragged outline doesn't change.

**Materials and textures:** one cut-out material, `moss`, on a 1024 px KTX2 atlas (colour with a cut-out alpha, and a normal map). The kit costs 1 material, 1 draw call per piece, 2.8 MB of texture memory and a 1.5 MB download.

## Edit

The tables at the top of the recipe set each piece's size, mesh cell, height, seed and atlas position (`PIECES`), the colours (`HOLLOW`, `CROWN`), how much of the scan's cracks is painted out (`CRACK_FLOOR`) and the surface relief (`NORMAL_STRENGTH`, `GRAIN`). A piece's shape is its `field` entry, read by `outline`. `test/blender/moss/moss.test.ts` checks the bundle, atlas, cut-out, tangents, upward-facing surfaces, LODs, cost limit and that two builds are byte-identical. Review images are in [`review/moss/`](../review/moss/).
