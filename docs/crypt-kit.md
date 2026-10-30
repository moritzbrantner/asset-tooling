# Undead crypt kit

This is the build recipe for the environment kit of ARPG's first adventure, an undead crypt ([#269](https://github.com/moritzbrantner/asset-tooling/issues/269), consumer arpg#72 / arpg#171, ARPG Atlas 1.1.1). The owner decisions of 2026-10-22 on #269 are:

- **Approach:** a reproducible procedural Blender recipe, [`adapters/blender/crypt.py`](../adapters/blender/crypt.py). It uses bevelled stone blocks and simple generated materials, with no imported meshes and no third-party assets.
- **Grid:** 2 m modules. Walls are 2 m segments, 3.0 m high and 0.5 m thick. Floor tiles are 2 × 2 m. There are two doorways: a 1.0 × 2.2 m opening in a 2 m module and a 2.0 × 2.6 m opening in a 4 m module.
- **Scope:** a wall, the two doorways, a crypt door with a hinge, a floor tile, a pillar, a sarcophagus, a candle cluster and a bone pile. It also has a descriptor in the style of `greyhaven-starter-descriptor-v1` and a `gltf-resources-v1` bundle with game-resolution textures.
- **Look:** cold grey-blue weathered stone with mossy, green-tinted grime and warm candle accents. The style is humanlike and stylised-realistic, matching Greyhaven ([style-humanlike.md](style-humanlike.md)).
- **Release:** one rolling release, `crypt-kit` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-crypt-kit.ts --out <directory>
```

[`scripts/build-crypt-kit.ts`](../scripts/build-crypt-kit.ts) works like the [inn build](greyhaven-inn.md):

- It runs the recipe once per module through `external.blender.script@1`, then imports each GLB through `scene.import.gltf@2` with no validator exceptions.
- It writes the descriptor from the recipe's observations and the bounds measured on the imported GLBs.
- It exports a `gltf-resources-v1` bundle (`asset.bundle@4`) and packs `<directory>/crypt.kit.tar`, plus `lineage.json` and `export.ref.json`.

It needs no network, no LFS payloads and no GPU. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

`crypt.build(part, collection, location)` also runs in a live Blender session, for example through the Blender MCP, to watch the modules or lay out a review room.

## Look and materials

- **Stone:** every wall is laid in six courses, with joints at 0.55, 1.1, 1.65, 2.2, 2.6 and 3.0 m, so neighbouring modules line up. The blocks are chamfered, a few of their corners are chipped, and they stand slightly proud of a dark mortar core. Doorways have alternating long and short quoins and one lintel stone.
- **Textures:** the recipe generates tileable textures with numpy: stone colour, normal and ORM at 1024 px, and wood at 512 px. Every stone module embeds identical PNG bytes, so the bundle stores each texture once. It has six PNGs in all, and the tar is about 3.6 MB.
- **Grime and moss:** they come from vertex colours (`COLOR_0`, which multiplies the base colour). They are strongest low on the walls and on upward faces, mixed by Blender's noise.
- **Plain colours:** iron, bone, wax, wick and the emissive flame use plain colours without textures. The flame uses only `emissiveFactor`, because `scene.import.gltf@2` does not accept `KHR_materials_emissive_strength`.
- **Determinism:** there is no randomness. Variation comes from SHA-256 of fixed keys, and the textures come from numpy's legacy `RandomState`.

## Bundle

Every entry has variant `default`, as `scenes/<key>/default.gltf` with its `.bin` and shared PNGs. The descriptor is the `crypt-descriptor` attachment of `crypt.kit.wall`.

| Key | Category | Triangles | Footprint W × D × H (m) | Collision proxies |
| --- | --- | --- | --- | --- |
| `crypt.kit.bones` | prop | 2,122 | 0.759 × 0.747 × 0.243 | none |
| `crypt.kit.candles` | prop | 1,164 | 0.392 × 0.392 × 0.397 | none |
| `crypt.kit.door` | structure | 1,064 | 1.017 × 0.120 × 2.178 | `door` (`dynamic-door`) |
| `crypt.kit.doorway-narrow` | structure | 880 | 1.988 × 0.540 × 2.994 | `left-jamb`, `right-jamb`, `lintel` |
| `crypt.kit.doorway-wide` | structure | 1,276 | 3.988 × 0.540 × 2.994 | `left-jamb`, `right-jamb`, `lintel` |
| `crypt.kit.floor` | structure | 220 | 1.988 × 1.988 × 0.199 | `floor` |
| `crypt.kit.pillar` | structure | 356 | 0.800 × 0.800 × 3.000 | `pillar` |
| `crypt.kit.sarcophagus` | prop | 448 | 2.353 × 1.113 × 1.180 | `sarcophagus` |
| `crypt.kit.wall` | structure | 660 | 1.988 × 0.516 × 2.994 | `wall` |

Wall-module footprints are 12 mm short of the grid because of the half mortar gap at each end. Placed at 2 m centres, the modules meet with a full joint.

## Conventions

- **Units and axes:** metres, +Y up, right-handed. A module's front faces +Z.
- **Origin:** the module's base centre on the floor plane. The floor tile's top is at y = 0 and it extends 0.2 m below.
- **Door:** the leaf is 0.98 × 2.18 × 0.07 m. Its hinge axis is the origin's +Y, and the closed leaf runs along +X. The GLB has an empty node `hinge`. The door mounts in `crypt.kit.doorway-narrow` at (−0.49, 0.01, 0). Rotating +90° about +Y opens it towards −Z, behind the wall's front. Only the hinge knuckles reach about 4 cm into the jamb.
- **Candles:** an empty node `flame.<n>` marks each of the six flames. The descriptor suggests a warm point light at each one; the GLB contains no lights.
- **Sarcophagus:** the lid is its own node, `lid`, resting slightly askew. A consumer may slide or open it.

## Descriptor `crypt-kit-descriptor-v1`

The descriptor is canonical JSON, and [`schemas/crypt-kit-descriptor-v1.schema.json`](../schemas/crypt-kit-descriptor-v1.schema.json) is its schema.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"crypt-kit-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"module-base-center"` |
| `grid` | `{ module: 2, wallHeight: 3, wallThickness: 0.5, floorTop: 0 }` |
| `assets[]` | Sorted by `key`. Each has `key`, `role`, `category` (`structure` or `prop`), `parentName`, `triangles`, `footprint`, measured `bounds` and `collisionProxies`. |
| `assets[].module` | Walls, doorways and the floor: the grid module's `width`, `height` and `depth`. |
| `assets[].doorway` | Doorways: `{ center, width, height, depth, min, max }` of the opening. |
| `assets[].hinge` | Door: `{ node, position, axis, closedAlong, opensTowards, openAngle }`. |
| `assets[].mount` | Door: `{ parent, translation }` in the narrow doorway's frame. The narrow doorway names the `door` it takes. |
| `assets[].lights` | Candles: `{ node, position, color, suggestedIntensityCandela, suggestedRange }` per flame. |
| `assets[].lid` | Sarcophagus: the lid node and its resting placement. |

`collisionProxies` are axis-aligned boxes `{ name, tag, center, size }` in the module's frame:

- **Tags:** `solid` for walls, jambs, lintels, the pillar and the sarcophagus; `floor` for the floor tile; `dynamic-door` for the door, in the door's frame, so it turns with the hinge.
- **Doorways:** the opening stays free.
- **Candles and bones:** no proxy, because they only render.

ARPG tiles the wall modules along its own colliders, and it may use, replace or ignore these proxies.

## Release

The bundle is distributed as the rolling `crypt-kit` GitHub release, whose assets are replaced in place. A consumer pins three things ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)):

1. the release;
2. the tar sha256;
3. its own copy of `export.ref.json`.

It reads each module with `readAssetBundleGltf(dir, manifest, "crypt.kit.<part>", "default")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "crypt.kit.wall", "default", "crypt-descriptor")`. Publishing the release is a separate, explicit step.

## Tests

`test/blender/kits/crypt-kit.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the bundle verify, and there are nine entries;
- the descriptor conforms to the schema;
- there are exactly six PNG resources;
- the wall modules fill their 2 m or 4 m grid, 3 m high;
- no proxy and no vertex of a doorway reaches into the opening;
- the mounted, closed door fits the narrow doorway;
- the candles carry six lights.

Without `BLENDER_TESTS=1` and `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

These are not covered here:

- the owner's visual review at ARPG's gameplay camera;
- publishing the `crypt-kit` release;
- level layout, ceilings and lighting in ARPG (arpg#72 / arpg#171).
