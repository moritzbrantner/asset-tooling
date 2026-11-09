# Monuments

Weathered limestone monuments for Greyhaven's graveyards and memorial grounds ([#550](https://github.com/moritzbrantner/asset-tooling/issues/550)), built to the [kit standard](kit-standard.md): an obelisk, a broken column and a fallen drum, an urn, a hooded statue, a memorial wall and two mausoleums, one sealed and one you can walk into. It is a reproducible Blender recipe, [`adapters/blender/monuments.py`](../adapters/blender/monuments.py), in one rolling release, `monuments` (`monuments.kit.tar`). The stone is the [gravestones'](gravestones.md): the same CC0 Poly Haven scans, palette and medium weathering. No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-monuments.ts [--textures full|half] --out <directory>
```

The steps are in [`scripts/baked-rock-kit.ts`](../scripts/baked-rock-kit.ts). It takes about two minutes and needs KTX-Software's `ktx` CLI and the hydrated scans, but no network or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there.

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-face-03-diff-2k-jpg/**,assets/canonical/poly-haven.rock-face-03-disp-2k-jpg/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**"
```

## Pieces

Metres, +Y up, right-handed, fronts towards +Z, origin on the ground at the centre of the footprint. Each key is `monuments.kit.<piece>`.

| Piece | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- |
| `obelisk` | 1.9 × 1.9 × 4.8 | 690 / 240 / 68 | base and shaft boxes |
| `broken-column` | 1.5 × 1.5 × 3.8 | 1,770 / 618 / 176 | pedestal and shaft boxes |
| `column-drum` | 0.9 × 0.9 × 0.8 | 698 / 244 / 68 | one box |
| `urn` | 0.7 × 0.7 × 2.1 | 900 / 314 / 90 | one box |
| `statue` | 1.1 × 1.1 × 2.9 | 3,220 / 1,126 / 322 | pedestal and figure boxes |
| `memorial-wall` | 4.3 × 0.7 × 2.2 | 1,660 / 580 / 166 | one box |
| `mausoleum-sealed` | 5.0 × 6.3 × 4.4 | 3,628 / 1,268 / 362 | floor, body and column boxes |
| `mausoleum-walk-in` | 6.6 × 8.3 × 3.4 | 4,588 / 1,604 / 457 | floor, wall, lintel, sarcophagus and column boxes |
| `mausoleum-walk-in-roof` | 6.0 × 7.2 × 4.9 | 600 / 210 / 60 | none |

- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`, up to four times). The descriptor is the `monuments-descriptor` attachment on the first piece.
- **`floor`** boxes on the mausoleums are their walkable steps, 0.28 m high at most.

## The walk-in mausoleum

The room is 4.2 × 5 m and 3.08 m high, entered through a 1.6 × 2.4 m doorway on +Z, with a sarcophagus, a lettered panel on the back wall and pilasters along the side walls.

`mausoleum-walk-in` is the walls, floor and furnishings. `mausoleum-walk-in-roof` is the ceiling, entablature and gable. **They share one frame, so place both with the same transform.** The separate roof exists so a game can hide it while a character is inside and look down into the room. The descriptor's `interior` on `mausoleum-walk-in` names the roof piece and gives the room's `volume` (`center` and `size`) in the piece's frame.

Hiding the roof, moving the camera and lighting the dark room are the game's. mmorpg already does the first for its inn and Marshal's house ([`crates/mmorpg-presentation/src/buildings.rs`](https://github.com/moritzbrantner/mmorpg/blob/main/crates/mmorpg-presentation/src/buildings.rs)).

**Materials and textures:** one opaque material, `monument`, on a 2048 px KTX2 atlas (colour, normal and a half-size roughness). The kit costs 1 material, 1 draw call per piece, 12 MB of texture memory and a 6.3 MB download.

## Edit

The weathering strengths are the gravestones' (`WEATHER` in [`gravestones.py`](../adapters/blender/gravestones.py)). Shapes, seeds and triangle counts are in the `PIECES` table and the small functions above it. Each block's `moss` scales its moss, which keeps it out of the room and off the statue's arms. The bake reaches 0.1 m out and 0.3 m in total (`BAKE_CAGE`, `BAKE_REACH`), much less than the rock kits, so rays don't start inside neighbouring walls. `test/blender/monuments/monuments.test.ts` checks the bundle, collision, LODs, cost limit, the room and that two builds are byte-identical. Review images are in [`review/monuments/`](../review/monuments/).
