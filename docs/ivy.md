# Ivy

Dark, sparse English ivy for Greyhaven's graveyards and ruins ([#552](https://github.com/moritzbrantner/asset-tooling/issues/552)), built to the [kit standard](kit-standard.md): seven generic pieces to lay over stone, with the stone and vines showing through. It is one habitat on purpose. It is a reproducible Blender recipe, [`adapters/blender/ivy.py`](../adapters/blender/ivy.py), in one rolling release, `ivy` (`ivy.kit.tar`). Every leaf is original and generated, with no third-party sources. No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-ivy.ts [--textures full|half] --out <directory>
```

[`scripts/build-ivy.ts`](../scripts/build-ivy.ts) runs the recipe once per piece and level and encodes the shared atlas to KTX2. It takes about a minute and needs KTX-Software's `ktx` CLI, but no network, GPU or LFS payloads.

## Pieces

Metres, +Y up, right-handed. Each key is `ivy.kit.<piece>`. Sizes include the leaf cards' overhang. `attach` in the descriptor says where a piece's origin goes.

| Piece | `attach` | Width × depth × height (m) | Triangles (LOD0 / lod1 / lod2) |
| --- | --- | --- | --- |
| `wall-patch` | `wall` | 2.3 × 0.4 × 2.0 | 512 / 24 / 10 |
| `curtain` | `wall-top` | 1.7 × 1.2 × 2.0 | 632 / 58 / 16 |
| `ground-creeper` | `ground` | 3.5 × 2.4 × 0.1 | 562 / 62 / 16 |
| `pedestal-patch` | `wall` | 0.9 × 0.2 × 1.2 | 94 / 14 / 4 |
| `column-wrap` | `column` | 1.2 × 0.9 × 2.7 | 324 / 28 / 6 |
| `corner-wrap` | `corner` | 1.6 × 2.4 × 2.9 | 1,758 / 154 / 44 |
| `runner` | `wall` | 0.7 × 0.2 × 1.1 | 52 / 6 / 2 |

- **`wall`**: the origin is on the wall's face at the bottom centre, with the leaves towards +Z.
- **`wall-top`**: the origin is at the top of the wall's front face. The piece hangs down it, and `fit.over` metres (0.33) cross the top behind.
- **`ground`**: the origin is at the patch's centre, and the vines start at its -Z edge, so put that edge against a wall.
- **`column`**: the origin is on the column's axis at its foot, facing +Z. It is sized for `fit.radius` (0.42 m); scale it for other columns.
- **`corner`**: the origin is on the corner's foot. `fit.front` metres (1.32) run across a +Z face and the rest back along a +X face.

Scale and turn each placement to fit. On uneven stone a card can float a little or clip into the surface.

- **Collision:** none. These are walk-through foliage, so every piece declares `collision: "none"`.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`, up to four times). The descriptor (the `ivy-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`. Lower levels are the same growth with fewer, larger cards, and no stems, which are invisible at that range.

**Materials and textures:** one cut-out material, `ivy-leaves`, on a 1024 px KTX2 atlas, and one small opaque untextured material, `ivy-stem`. The atlas is grey, and `COLOR_0` sets each card's colour from shade to sun. The kit costs 2 materials, 2 draw calls per piece at full detail, 1.4 MB of texture memory and a 0.7 MB download.

## Edit

The tables at the top of the recipe set the leaf size and count per cluster (`LEAF_LENGTH`, `LEAVES_PER_CELL`), the colours (`SHADE`, `SUN`), each level's cards and stems (`LEVELS`) and each piece's size, root count and seed (`PIECES`). Density comes from `CARD_EVERY` and the outline test in `build`. `test/blender/kits/ivy.test.ts` checks the bundle, atlas, outward-facing cards, LODs, cost limit and that two builds are byte-identical. Review images are in [`review/ivy/`](../review/ivy/).
