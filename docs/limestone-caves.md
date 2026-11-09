# Limestone caves

Modular cave pieces in level-bedded limestone for Greyhaven ([#559](https://github.com/moritzbrantner/asset-tooling/issues/559)), built to the [kit standard](kit-standard.md): a mouth under a low rocky mound, tunnels, a bend, a junction, a ramp that descends, three sizes of room, caps and stalagmite clusters. It is a reproducible Blender recipe, [`adapters/blender/limestone_caves.py`](../adapters/blender/limestone_caves.py), in one rolling release, `limestone-caves` (`limestone-caves.kit.tar`). It matches the [limestone rocks](limestone-rocks.md). No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-limestone-caves.ts [--textures full|half] --out <directory>
```

[`scripts/build-limestone-caves.ts`](../scripts/build-limestone-caves.ts) runs the recipe once per piece, makes `lod1` and `lod2` with [`nature_lod.py`](../adapters/blender/nature_lod.py), adds tangents and encodes the tiles to KTX2. It takes about two minutes and needs KTX-Software's `ktx` CLI and the hydrated scans, but no network or GPU.

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-face-03-diff-2k-jpg/**,assets/canonical/poly-haven.rock-face-03-disp-2k-jpg/**,assets/canonical/poly-haven.rocks-ground-02-diff-2k-jpg/**,assets/canonical/poly-haven.forrest-ground-01-diff-2k-jpg/**"
```

Each module carves a volume, roughens it with level beds and small breaks, polygonises it and reduces it to a game mesh. Colour comes from two tiling materials, with recessed corners and broad mottling in `COLOR_0`.

## Joining modules

Modules sit on the game's 4 m grid. Every opening is the same plain arch, 4 m wide and 3 m high, listed in the descriptor's `openings` as a `position`, the way it is `facing`, and its size. To join two modules, put two openings at the same point, facing opposite ways. Turn modules in quarter turns. The rock's roughness fades out near each opening, and each module runs 0.25 m past its opening with its rim fixed on the arch and the same shading on both sides, so neighbours meet.

Metres, +Y up, right-handed. The origin is the module's centre on its upper floor. Each key is `limestone-caves.kit.<piece>`.

| Piece | Openings | Width × depth × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision triangles |
| --- | --- | --- | --- | --- |
| `tunnel` | 2, 8 m apart | 4.5 × 8.5 × 3.6 | 1,399 / 488 / 138 | 96 |
| `bend` | 2, at 90° | 6.7 × 6.6 × 3.3 | 1,800 / 630 / 179 | 120 |
| `junction` | 3 | 8.5 × 7.2 × 3.9 | 2,399 / 838 / 239 | 149 |
| `ramp` | 2, the far one 4 m lower | 4.8 × 8.5 × 7.3 | 1,800 / 629 / 180 | 110 |
| `dead-end` | 1 | 5.5 × 8.1 × 4.4 | 1,499 / 523 / 149 | 110 |
| `cap` | 1 | 5.3 × 3.9 × 4.1 | 419 / 145 / 41 | 59 |
| `room-small` | 4 | 12.5 × 12.5 × 4.8 | 3,199 / 1,119 / 319 | 199 |
| `room-medium` | 4 | 20.5 × 20.5 × 5.9 | 5,599 / 1,959 / 559 | 320 |
| `room-large` | 4 | 28.5 × 20.5 × 7.0 | 7,999 / 2,799 / 798 | 419 |
| `mouth` | 1 | 18.0 × 12.5 × 5.9 | 5,000 / 1,747 / 499 | 259 |
| `spikes-floor` | none | 1.6 × 2.6 × 2.2 | 490 / 170 / 49 | boxes |
| `spikes-roof` | none | 2.3 × 2.8 × 1.6 | 420 / 146 / 42 | none |

- **Rooms** have four openings. Close the ones you don't use with a `cap`.
- **`ramp`** falls 4 m over 8 m, about 28° over its sloped middle, and its origin is on its upper floor.
- **`spikes-floor`** stands on the floor; **`spikes-roof`** hangs from the ceiling, its origin at the roof. Both run a little into the rock.
- **Collision:** each module's `collisionMesh` is a simplified shell of the cave's inner surface, with faces looking into the cave. It is open at the openings, so it differs from the closed shells of the rock kits. `spikes-floor` carries `collisionProxies` and `spikes-roof` declares `collision: "none"`.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`, up to four times). The descriptor is the `limestone-caves-descriptor` attachment on the first piece.

**Materials and textures:** two opaque materials, `cave-rock` and `cave-floor`, each with a tiling 1024 px colour and normal map in KTX2. The kit standard's default is one opaque material; the rock surface here is too large for one baked atlas, so walls and floors tile instead (#559). The kit costs 2 materials, 2 draw calls per module, 5.6 MB of texture memory and a 6 MB download.

## In a game

- **Terrain:** the mouth's passage runs out under the mound, and a ramp beyond it goes underground, so the terrain needs a hole at the entrance. A game can instead treat the mouth as a transfer to a separate underground area, as mmorpg does for the Redbrand Depths.
- **Camera and lighting** belong to the game. See [mmorpg#714](https://github.com/moenarch-games/mmorpg/issues/714) for the camera. Inside, the caves are dark without placed lights.
- Very faint lines can show where some modules meet, and the rock's texture doesn't continue across a join.

## Edit

The `PIECES` table at the top of the recipe sets each module's bounds, passages, rooms, openings and triangle targets. `HALF` and `TALL` are the arch; change them and every module changes. `BED_HEIGHT` is the limestone beds. `test/blender/limestone-caves/limestone-caves.test.ts` checks the bundle, materials, openings, rims on the arch, collision, LODs, cost limit and that two builds are byte-identical. Review images are in [`review/limestone-caves/`](../review/limestone-caves/).
