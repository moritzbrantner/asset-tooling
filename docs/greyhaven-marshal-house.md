# Marshal Elden Greywatch's house

This is the build recipe for the first private home in mmorpg's Greyhaven Outpost ([#413](https://github.com/moritzbrantner/asset-tooling/issues/413), consumer [mmorpg#158](https://github.com/moenarch-games/mmorpg/issues/158)). The owner chose Marshal Elden Greywatch as its resident and the west Outpost house, **collider 103**, as its place (mmorpg#158 Q16 = A). Elden sleeps by the bed from dusk to dawn, and a knock opens the door (Q17–Q20). The game hides the roof and ceiling while the camera is inside.

- **Approach:** an original scripted Blender recipe, [`adapters/blender/marshal_house.py`](../adapters/blender/marshal_house.py). The exterior *is* the [Outpost kit](outpost-kit.md)'s `house` composition, built by the kit's own recipe, so it matches house 105 and the other kit houses. The interior uses the kit's `Builder`, materials and numpy textures. The barrel comes from the [settlement props](settlement-props.md). Both recipes are declared Python inputs (`outpost`, `settlement`). No third-party assets.
- **Style:** the kit's: stone plinth, plaster in a dark timber frame, plank door and shingle roof. The bed's blanket and the shield are Greywatch blue-grey with a red stripe.
- **Release:** one rolling release, `greyhaven-marshal-house` (Atlas Decision 7.1.5), never a numbered one. CI publishes it when a change to its sources merges (README, "Publishing a rolling release"). A change to `outpost.py` or `settlement_props.py` rebuilds it too.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-marshal-house.ts --out <directory>
```

[`scripts/build-greyhaven-marshal-house.ts`](../scripts/build-greyhaven-marshal-house.ts) works like the [inn build](greyhaven-inn.md#build). It runs one `external.blender.script@1` per part, imports each GLB through `scene.import.gltf@2`, measures the descriptor, exports a `gltf-resources-v1` bundle (`asset.bundle@4`) and packs `<directory>/greyhaven.marshal-house.tar`. It writes `export.ref.json`, `descriptor.json` and `lineage.json` beside the tar. It takes under a minute and needs no network, no LFS payloads and no GPU. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

In a live Blender (for example through the Blender MCP), run the three recipes' sources into namespaces, call `use_sources(outpost, settlement)` and then `build(part, collection)` for each part.

## Conventions

- **Units and axes:** metres, +Y up, right-handed. The front, with the door, faces +Z.
- **Origin:** the footprint's base centre. All parts share this frame. Place the origin at collider 103's centre, (-24, 0, 36) m, turned so that +Z faces the way the house's door should face.
- **Footprint:** the walls stand on the 8 × 6 m footprint (outer faces at x = ±4 and z = ±3, 0.32 m thick, 3.2 m high). The eaves overhang 0.35 m, the verges 0.3 m, and the chimney stands outside the +X gable. The ridge is at 5.12 m and the chimney top at 6.0 m, so they rise above collider 103's 5 m.
- **Room:** 7.36 × 5.36 m, x −3.68..3.68 and z −2.68..2.68. The floor's top is at 0.02 m and the ceiling's underside at 2.95 m.

## Bundle

Every entry has variant `default`.

| Key | Contents | Triangles |
| --- | --- | --- |
| `greyhaven.marshal-house.shell` | The kit's walls (front: window, half, door, half, window), corners and outside chimney, joined into one mesh, plus the plank floor. Empty nodes `door.hinge` (where the door hangs) and `smoke` (the chimney's flue). The descriptor is its `house-descriptor` attachment. | 8,040 |
| `greyhaven.marshal-house.ceiling` | The board ceiling and four joists. | 188 |
| `greyhaven.marshal-house.roof` | The kit's roof sections, verges and the two gable triangles: everything above the wall top. | 2,628 |
| `greyhaven.marshal-house.door` | The kit's plank door. Its origin is the hinge (+Y axis), the closed leaf runs along +X, and it has an empty node `hinge`. | 156 |
| `greyhaven.marshal-house.furniture` | One named node per item (below). | 3,224 |
| `greyhaven.marshal-house.collision` | One axis-aligned box per collider, named `collider.<tag>.<name>`. | 216 |

The gables are in the `roof` entry, so hiding `roof` and `ceiling` opens the whole room to the camera. The shell keeps the tall chimney, which stands outside the +X wall.

### Furniture

| Node | Where | What |
| --- | --- | --- |
| `bed` | back-left corner, head to the back wall | A timber bed with a straw mattress, a linen pillow and a blue-grey blanket with a red stripe. |
| `chest` | at the bed's foot | A plank chest with iron straps and a lock. |
| `weapon-rack` | left wall, near the front | The Marshal's prop: a rack with a spear, a poleaxe and a sword, and his heater shield (blue-grey, red pale, iron boss) on the wall above. |
| `hearth` | middle of the +X wall | A stone hearth with a fire, andirons and a hanging pot. Its breast rises to the ceiling, in front of the outside chimney and over the gable window behind it. |
| `log-stack` | beside the hearth, front side | Split logs. |
| `barrel` | back-right corner | The settlement props' barrel. |
| `table` | right of the room's centre | A plank table with a patrol map, a candlestick and a tankard. |
| `bench` | behind the table | |
| `chair` | in front of the table, facing it | |

The front half of the room stays open: the door's swing, the walk in from the door, and the doorway spot.

## Descriptor `greyhaven-marshal-house-descriptor-v1`

Canonical JSON; numbers are rounded to 1e-6 m.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"greyhaven-marshal-house-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-base-center"` |
| `exterior` | `{ kit: "outpost-kit", composition: "house" }` |
| `placementFootprint` | Collider 103: `{ width: 8, depth: 6, height: 5 }`. |
| `bounds` | Measured on the shell and roof. |
| `entries` | The bundle key of each part. |
| `hideForInterior` | `["greyhaven.marshal-house.roof", "greyhaven.marshal-house.ceiling"]` |
| `room` | The interior volume, from the floor's top to the ceiling. |
| `door` | `key`, `mount` (`parent: greyhaven.marshal-house.shell`, `translation`: the `door.hinge` node, `[-0.58, 0.01, 2.88]`), `hingeAxis` `[0, 1, 0]`, `closedAngle` 0, `openAngle` π/2, `swing: "inward"`, `leafBounds` in the door's frame, and the `closed` and `open` leaf AABBs in the house frame. |
| `smoke` | The chimney flue's position, for a smoke effect. |
| `spots` | Where the game can put people; each has a `position` and a `yawDegrees` that turns +Z about +Y (90 faces +X). `doorstep` is outside the door, facing it, for the knock. `doorway` is the 1 m standing spot just inside the door, facing out, with its `min`/`max` box. `bedside` is beside the bed, facing it. `sleep` lies on the mattress, head to −Z. |
| `furniture` | The furniture node names. |
| `triangles` | Per entry. |
| `colliders[]` | Sorted by node: `{ node, tag, name, frame, min, max }`. `tag` is `wall`, `floor`, `door` or `furniture`. `frame` is `house`, except the door's leaf, which is in the `door` frame and moves with the hinge. |

The 18 colliders:

- **Walls:** `front.left`, `front.right` and `front.lintel` keep the 1.2 × 2.2 m doorway open; `back`, `left`, `right` and the outside `chimney` are solid. Windows have no gaps; their sills are 1.2 m high.
- **Floor:** `interior`, y 0..0.02.
- **Door:** `leaf`, in the door's frame. Turn it through `mount` and the hinge with the server's door state.
- **Furniture:** one box per item, at its full extent. The hearth's box reaches the ceiling.

These boxes are inputs for mmorpg's authoritative colliders. The game owns traversability, the door's state, who may enter, the knock and Elden's routine (mmorpg#158).

## Tests

`test/blender/kits/greyhaven-marshal-house.test.ts` runs the whole recipe in the hosted `blender-script` job. It checks that:

- the bundle and the tar verify, with six entries;
- the house stands on its footprint;
- the colliders are named by tag, every furniture item has one, and the bed, chest, table, chair, bench, hearth and weapon rack are there;
- no wall collider reaches into the doorway, the closed leaf fits the doorway, and the open leaf stays inside the room;
- every furniture box is inside the room and clear of the door's swing, the walk in, the doorway spot and the bedside spot, and no two items overlap;
- the sleep spot lies on the bed, and the knock spot is outside the front wall.

Without `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

These belong to mmorpg#158: an owner visual review at the gameplay camera, placing the house on collider 103, the in-game colliders, the door's server state and access rules, the knock, Elden's night routine and the browser and native checks.
