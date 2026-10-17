# Greyhaven Outpost inn

This is the build recipe for the first enterable, furnished building of [#272](https://github.com/moritzbrantner/asset-tooling/issues/272), the inn of mmorpg's Greyhaven Outpost (collider 101, consumer [mmorpg#158](https://github.com/moritzbrantner/mmorpg/issues/158)). The issue records the owner decisions: a complete furnished inn, a hinged server-synced `dynamic-door` (mmorpg#158 Q3 = B), and free sources or scripted Blender recipes only (Decisions 1.1.7, 3.1.2 and 6.1.4).

The inn is an original **scripted Blender recipe**, [`adapters/blender/inn.py`](../adapters/blender/inn.py). It follows the [humanlike style spec](style-humanlike.md): factor-only PBR materials (plaster, stone, timber, floorboard, wood, shingle, iron, glass and soot), no textures or UVs, and chamfered timber. It uses no third-party asset.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-inn.ts --out <directory>
```

[`scripts/build-greyhaven-inn.ts`](../scripts/build-greyhaven-inn.ts) runs the recipe once per part through `external.blender.script@1`, then imports each GLB through `scene.import.gltf@2`. It measures the descriptor on the imported GLBs, exports a `gltf-resources-v1` bundle (`asset.bundle@4`) and packs `<directory>/greyhaven.inn.tar`. It needs no network, no LFS payloads and no GPU. Blender installed as a snap can only read and write under `$HOME`, so set `TMPDIR` to a directory there. The script writes `lineage.json` with the recipe hash and every part's AssetRef.

## Conventions

- **Units and axes:** metres, +Y up, right-handed. The front, which has the door, faces +Z.
- **Origin:** the footprint's base centre. Every part shares this frame, so the parts are placed together with one transform.
- **Footprint:** the roof's eaves span exactly 14 × 10 m, and the ridge is at 6 m. That is mmorpg's inn collider 101 (x 8–22 m, z −5–5 m, 6 m high). The walls stand 0.2 m inside it, at x ±6.8 m and z ±4.8 m, with 0.3 m thickness and 3.2 m height. The room is 13 × 9 m, the ceiling is at 3.0 m and the floor's top is at 0.02 m.

## Bundle

Every entry has variant `default`. Each is one `scenes/<key>/default.gltf` with its `.bin`.

| Key | Contents | Triangles |
| --- | --- | --- |
| `greyhaven.inn.shell` | Stone-plinth and plaster walls with timber framing, the doorway (1.2 × 2.2 m, centred on the front wall), six glazed windows, the plank floor and the stone threshold. It also has an empty node `door.hinge`. The descriptor is its `inn-descriptor` attachment. | 3,304 |
| `greyhaven.inn.ceiling` | The ceiling and its beams. | 236 |
| `greyhaven.inn.roof` | The gabled shingle roof with the plaster gables and the ridge beam. | 572 |
| `greyhaven.inn.door` | The plank door leaf with battens, iron straps and ring handles. The hinge axis is the origin's +Y, the closed leaf runs along +X, and there is an empty node `hinge`. | 408 |
| `greyhaven.inn.furniture` | One named node per item: an L-shaped bar counter (`bar-counter.1`, `.2`), the `back-shelf` with bottles, three tables (`table.1`–`.3`), twelve chairs (`chair.<table>.<n>`), three bar stools, four barrels and the `hearth`. | 5,940 |
| `greyhaven.inn.collision` | One axis-aligned box per collider, named `collider.<tag>.<name>`. | 408 |

`roof` and `ceiling` are separate entries, so a consumer can hide both for interior views (`hideForInterior`).

## Descriptor `greyhaven-inn-descriptor-v1`

Canonical JSON. Numbers are rounded to 1e-6 m.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"greyhaven-inn-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-base-center"` |
| `footprint`, `bounds` | Measured on the shell and roof: 14 × 10 × 6 m, from `[-7, 0, -5]` to `[7, 6, 5]`. |
| `placementFootprint` | The collider-101 footprint the inn is built for. |
| `entries` | The bundle key of each part. |
| `hideForInterior` | `["greyhaven.inn.roof", "greyhaven.inn.ceiling"]` |
| `door` | `key` and `mount` (`parent: greyhaven.inn.shell`, `translation`: the `door.hinge` node, `[-0.6, 0, 4.53]`). `hingeAxis` `[0, 1, 0]`, `closedAngle` 0 and `openAngle` π/2, with `swing: "inward"`: rotating +90° about +Y turns the leaf from +X to −Z, into the room. `leafBounds` is in the door's frame; `closed` and `open` are the leaf's AABBs in the inn frame at those angles. |
| `furniture` | The furniture node names. |
| `colliders[]` | Sorted by node: `{ node, tag, name, frame, min, max }`. `tag` is `wall`, `floor`, `door` or `furniture`. `frame` is `inn`, except the door's leaf collider, which is in the `door` frame and moves with the hinge. |

The colliders are six wall boxes, one floor box, one door box and one box per furniture item (34 in all):

- **Walls:** `front.left`, `front.right` and `front.lintel` keep the doorway open; `back`, `left` and `right` are solid. Windows have no collision gaps, because their sills are 1 m high.
- **Floor:** `interior`, from y = 0 to 0.02 m.
- **Door:** `leaf`, in the door's frame. Turn it with the server's door state through `mount` and the hinge.
- **Furniture:** one box per item, at the item's full extent.

These boxes are inputs for mmorpg's authoritative physics colliders. The game still owns traversability, the door's state and interaction rules (mmorpg#158).

## Release

A consumer pins the release tag, the tar sha256 and its own copy of `export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It reads each part with `readAssetBundleGltf(dir, manifest, "greyhaven.inn.<part>", "default")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "greyhaven.inn.shell", "default", "inn-descriptor")`.

Two cold builds on 2026-10-17 from separate object stores (Blender 5.2.2 snap) produced the same tar: sha256 `4f0b2956327e445fc4ac84ded831b9395988d02ea8a87904f53039f71ef0d27e`, 588,800 bytes, with manifest sha256 `a5046743a144b208706aecd83c612125ff7473a6d31dbccc2e84e6c570819e7e` (6,710 bytes). This is a record of those runs, not a byte-exact replay contract.

## Tests

`test/greyhaven-inn.test.ts` runs the whole recipe in the hosted `blender-script` job. It checks:

- the bundle and the tar verify, and there are six entries;
- the footprint is exactly 14 × 10 × 6 m;
- the colliders are named by tag, and every furniture item has one;
- no wall collider reaches into the doorway, the closed leaf fits the doorway and the open leaf stays inside the room;
- every furniture box is inside the room, clear of the door's swing and of a 1.2 m path from the door to the bar, and no two items overlap (apart from the two joined counter pieces).

Without `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

These are owned by mmorpg#158: an owner visual review at the gameplay camera, the in-game colliders and the door's server state, and the browser and native consumer checks.
