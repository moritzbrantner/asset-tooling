# Wolf den

A rocky den mouth with flattened bedding and scattered bones for mmorpg's Wolfrun Den ([#754](https://github.com/moritzbrantner/asset-tooling/issues/754), mmorpg #912 and #951), built to the [kit standard](kit-standard.md). Two jamb boulders and a lintel frame a dark hollow, dug into an earthen, mossy bank; in front lies an apron of trodden earth with a nest of pressed litter and a few old bones. It is a reproducible Blender recipe, [`adapters/blender/wolf_den.py`](../adapters/blender/wolf_den.py), in one rolling release, `wolf-den` (`wolf-den.kit.tar`). No game places it yet: placement, the pack's resting spots and everything else about the wolves belong to the game.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-wolf-den.ts [--textures full|half] --out <directory>
```

[`scripts/build-wolf-den.ts`](../scripts/build-wolf-den.ts) uses the rock kits' shared build ([`scripts/baked-rock-kit.ts`](../scripts/baked-rock-kit.ts)): it runs the recipe once per piece, makes `lod1` and `lod2` with [`nature_lod.py`](../adapters/blender/nature_lod.py), packs the baked maps into one atlas and encodes it to KTX2. It takes about a minute and a half, needs KTX-Software's `ktx` and the hydrated CC0 Poly Haven scans, and no network or GPU:

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-boulder-dry-diff-2k-jpg/**,assets/canonical/poly-haven.rock-boulder-dry-disp-2k-jpg/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**,assets/canonical/poly-haven.forrest-ground-01-diff-2k-jpg/**"
```

The rock is the river stones' rounded boulder scan, the moss the terrain's mossy rock, and the earth and bedding the forest floor, each divided by its mean and multiplied by mmorpg's palette as the other rock kits do. Bone is a flat colour with darker stains.

## Pieces

Metres, +Y up, right-handed, the den facing +Z, origin on the ground at the centre of the footprint. Each key is `wolf-den.kit.<piece>`.

| Piece | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- |
| `den-mouth` | 5.8 × 6.1 × 2.2 | 7,039 / 2,462 / 696 | three boxes: `left`, `right`, `bank` |
| `bone-scatter` | 0.7 × 0.9 × 0.1 | 370 / 128 / 36 | none |
| `bedding-patch` | 1.9 × 1.6 × 0.1 | 500 / 174 / 50 | none |

- **`den-mouth`** is the placeable den. The mouth is about 0.9 m wide and 0.85 m high, and its hollow is baked near-black, so it reads as a hole at the game camera. The bank runs 0.75 m below `y = 0` (`bury`), and the apron sinks under the terrain at its ragged rim. The collision boxes are the two jambs and the bank, which closes the mouth: the hollow is dressing, not a walk-in space. The bedding in front, about (0.1, 0, 1.2), stays outside every box, so a resting wolf belongs there.
- **`bone-scatter`** (two long bones, a short one and three ribs) and **`bedding-patch`** (another flattened nest) are walk-on ground dressing for around the den, with `collision: "none"`.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces (`scaledLodDistances`). The descriptor (the `wolf-den-descriptor` attachment on the first piece, also `descriptor.json`) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one opaque material, `wolf-den`, on a 2048 px KTX2 atlas (colour, normal and a half-size roughness). The kit costs 1 material, 1 draw call per piece, 8 MB of texture memory and a 2.1 MB download; `releases/wolf-den.json` holds the budget.

## How it's made

Every piece is a set of blocks: lumpy boulders (the jambs, the lintel, the bank and its shoulders, a capstone and two stones), a ground sheet for the apron and the nests, and bones. Each block is a dense sculpt decimated to its own game mesh. The surface layers are painted per vertex (`wx`: moss, bone, bedding and the hollow's shade; `wy`: earth) and baked with Cycles onto the game mesh. The bones are baked in their own pass with a short cage, so the ground under a bone samples the ground and not the bone above it. The game-mesh helpers and the atlas packing come from [`cliff_outcrop.py`](../adapters/blender/cliff_outcrop.py) and [`limestone_rocks.py`](../adapters/blender/limestone_rocks.py), declared and hash-pinned inputs of the recipe.

## Edit

Shapes, block sizes, seeds and triangle counts are in the `PIECES` table at the top of the recipe, the mouth's extent in `MOUTH_HALF`, `MOUTH_TOP` and `MOUTH_FRONT`, and the colours in `PALETTE`. To shape it in a live Blender, run `build(part, collection, inputs, o, limestone)` from the recipe with the four scan paths as `inputs` and the two helper recipes loaded with `runpy.run_path`, and look at the returned sculpts with Material Preview. `test/blender/wolf-den/wolf-den.test.ts` checks the bundle, the collision boxes (and that the bedding stays free), the LODs, the cost limit and that two builds are byte-identical; it skips without Blender.

## Review

Review renders are in [`review/wolf-den/`](../review/wolf-den/): `game-camera.jpg` (the 12 m, 0.42 rad pitch, 50° Greyhaven camera, with the two dressing pieces beside the den), `close-up.jpg`, `back.jpg` (the bank from behind) and `bones.jpg` (the bone scatter close up).

## Consumers

mmorpg would fetch the release like its other rolling kits, for example `fetch_rolling wolf-den wolf-den.kit scenery/wolf-den.kit` in its `scripts/fetch-bundles.sh`, and place `wolf-den.kit.den-mouth` at the Wolfrun Den's anchor with its collision boxes. Wiring it in is mmorpg's change, not part of this kit.
