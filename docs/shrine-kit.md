# Sunken shrine and cave kit

This is the build recipe for the MMORPG's Sunken Shrine at the bottom of Stillwater Lake ([#345](https://github.com/moritzbrantner/asset-tooling/issues/345), consumer mmorpg#274 part 2, quest 10 *The Sunken Shrine*). The owner decisions of 2026-10-22 on #345 are:

- **Approach:** authored assets, not code-drawn geometry: a reproducible procedural Blender recipe, [`adapters/blender/shrine.py`](../adapters/blender/shrine.py), with a descriptor (collision proxies) and a `gltf-resources-v1` bundle. It uses no imported meshes and no third-party assets; its textures are generated.
- **Palette:** pale weathered limestone/sandstone, teal-green algae on upward faces, ochre silt towards the base.
- **Style:** an ancient lake temple, distinct from the [crypt kit](crypt-kit.md): rounded arches, a carved fish-and-wave frieze, fluted drum pillars. The carving is cut geometry on the arch and the altar.
- **Air pocket:** a wider chamber, a proper room module. The MMORPG widens its chamber to fit (a cross-repository follow-up in mmorpg).
- **Details:** hanging weed, silt drifts, fallen blocks, a glowing relic altar (a teal emissive inlay plus a descriptor light hint), shell and barnacle clusters, and a faint light shaft at the cave mouth.
- **Release:** one rolling release, `shrine-kit` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-shrine-kit.ts --out <directory>
```

[`scripts/build-shrine-kit.ts`](../scripts/build-shrine-kit.ts) works like the [crypt build](crypt-kit.md#build): one `external.blender.script@1` run per module, each GLB imported through `scene.import.gltf@2` with no validator exceptions, the descriptor written from the recipe's observations and the measured bounds, then a `gltf-resources-v1` bundle (`asset.bundle@4`) packed to `<directory>/shrine.kit.tar`, plus `lineage.json` and `export.ref.json`. The build takes about a minute and needs no network, no LFS payloads and no GPU. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

`shrine.build(part, collection, location)` also runs in a live Blender session, for example through the Blender MCP, to watch the modules or lay out a review scene.

## Modules

The shrine modules sit on a 4 m grid, the MMORPG's terrain grid. The cave modules keep a 4 m wide, 3 m high clear passage along +X, the size of the MMORPG's current cave colliders.

| Key | Category | Triangles | Footprint W × D × H (m) | Collision proxies |
| --- | --- | --- | --- | --- |
| `shrine.kit.air-pocket` | cave | 12,672 | 8.000 × 9.600 × 6.599 | `floor`, `north-wall`, `south-wall`, `roof`, four shoulders |
| `shrine.kit.altar` | prop | 12,576 | 1.800 × 1.300 × 1.042 | `altar` |
| `shrine.kit.arch` | structure | 14,572 | 4.044 × 0.740 × 3.994 | `left-jamb`, `right-jamb`, `crown` |
| `shrine.kit.cave-end` | cave | 7,968 | 5.574 × 5.600 × 5.199 | `floor`, `north-wall`, `south-wall`, `roof`, `end-wall` |
| `shrine.kit.cave-mouth` | cave | 7,880 | 6.600 × 8.604 × 7.800 | `floor`, `north-wall`, `south-wall`, `roof` |
| `shrine.kit.cave-tunnel` | cave | 6,528 | 4.000 × 5.600 × 5.199 | `floor`, `north-wall`, `south-wall`, `roof` |
| `shrine.kit.fallen-blocks` | prop | 772 | 2.245 × 2.218 × 0.799 | `block.0`–`block.2`, `drum` |
| `shrine.kit.floor` | structure | 836 | 3.988 × 3.988 × 0.197 | `floor` |
| `shrine.kit.hanging-weed` | prop | 256 | 0.429 × 0.383 × 1.560 | none |
| `shrine.kit.pillar` | structure | 2,648 | 0.800 × 0.800 × 3.000 | `pillar` |
| `shrine.kit.pillar-broken` | structure | 2,508 | 0.800 × 0.800 × 1.908 | `pillar` |
| `shrine.kit.shells` | prop | 2,032 | 0.909 × 0.810 × 0.393 | none |
| `shrine.kit.silt-drift` | prop | 1,392 | 2.710 × 1.845 × 0.223 | none |
| `shrine.kit.wall` | structure | 704 | 3.988 × 0.618 × 2.994 | `wall.0`–`wall.3`, one per metre |

The numbers are from the build of 2026-10-24; the descriptor carries the measured values of each build.

- **`wall`:** a broken limestone wall, 4 m wide and 0.6 m thick, laid in 0.6 m courses. It stands 3 m at its left (−X) end and falls to about 1.6 m at its right. Its four proxies follow the broken top.
- **`arch`:** a 4 m module, 4 m high. Its round arch is 2.4 m wide, with the springline at 1.8 m and the crown at 3.0 m. Nine voussoirs and a proud keystone form the arch, on projecting imposts. Above it runs a frieze carved as cut geometry on its front (+Z) face: breaking waves in the lower band and swimming fish in the upper band. A cornice of three stones tops it; the right stone is broken short.
- **`pillar`**, **`pillar-broken`:** fluted drum pillars (20 flutes) on a square plinth and a moulded base. The full pillar has three drums, an echinus and an abacus. The broken one ends in a slanting, jagged break in its second drum.
- **`floor`:** a 4 × 4 m flagstone tile of the sunken plaza, whose top is at y = 0, 0.2 m thick.
- **`altar`:** a dais, a body carved front and back with the fish-and-wave frieze, and a top slab with a raised dish. A teal emissive ring rings the dish and a teal emissive wave runs along the top's front edge. The empty node `relic` marks where the Sunken Relic rests.
- **`cave-tunnel`:** 4 m of rock passage (x −2..2), open at both ends.
- **`cave-mouth`:** a tunnel module whose −X end opens through a rock outcrop onto the plaza. Its rim curls back into the lake bed and its floor apron slopes into the plaza silt. A faint, open-ended light shaft falls onto the plaza in front of it, with an empty node `light-shaft` at its top.
- **`cave-end`:** a tunnel module closed at +X by a rough half dome: the altar chamber.
- **`air-pocket`:** a room 8 m long (x −4..4) and 8 m wide (z −4..4) inside its rock. Its walls are 3.5 m high and its vault 5 m. Over its last 1.5 m at each end it narrows to the tunnel's cross-section, so it joins tunnel modules at x = ±4.
- **Props:** `fallen-blocks` (three tumbled blocks and a fallen fluted drum), `hanging-weed` (ribbon weed whose origin is its anchor at the top, hanging along −Y), `silt-drift` (a low rippled mound) and `shells` (clam shells and barnacles on a stone).

## Look and materials

- **Limestone:** a pale, warm limestone with faint sandstone bedding and solution pits (colour, normal and ORM at 1024 px). Blocks are chamfered and some corners are chipped. They stand slightly proud of a dark mortar core.
- **Cave rock:** a darker, coarser rock texture (colour, normal and ORM at 1024 px). The rock surface is displaced by Blender's fixed Perlin noise, sampled on a torus. The noise repeats every 4 m along the cave and closes round the cross-section, so every open end of every cave module has the same cross-section and any sequence of cave modules joins without seams. The texture's U is x / 4 m, so it also runs on across joins.
- **Algae and silt:** vertex colours (`COLOR_0`, which multiplies the base colour). Teal-green algae grows on upward faces in noise patches. Ochre silt gathers towards the base of every module and on low upward faces.
- **Carving:** the frieze is a 1.5 cm grid displaced by a cut pattern: a raised border and fillet, filled waves with a cut curl, fish with a forked tail, a cut eye and a gill line. The cut ground is darkened so that the carving reads at a distance.
- **Plain colours:** mortar, the inlay, weed, shell, barnacle and the light shaft use plain colours. The inlay uses only `emissiveFactor`, because `scene.import.gltf@2` accepts no extensions. Weed and the light shaft are double-sided. The light shaft is alpha-blended at 6 % opacity.
- **Bundle:** six PNGs in all, each stored once; the tar is about 8.2 MB.
- **Determinism:** there is no randomness. Variation comes from SHA-256 of fixed keys and from Blender's fixed noise; the textures come from numpy's legacy `RandomState`.

## Conventions

- **Units and axes:** metres, +Y up, right-handed. A module's front faces +Z; the cave runs along +X.
- **Origin:** the module's base centre on the floor plane. The floor tile's top is at y = 0 and it extends 0.2 m below. `hanging-weed` is the exception: its origin is the anchor at its top.
- **Joining the cave:** place `cave-mouth`, any number of `cave-tunnel` and `air-pocket` modules, and `cave-end` end to end along +X: tunnel-sized modules at 4 m centres, the air pocket over 8 m. The mouth's −X face meets the plaza.
- **Lights:** the descriptor suggests a teal point light at the relic and a spot light down the light shaft. The GLBs contain no lights.

## Descriptor `shrine-kit-descriptor-v1`

The descriptor is canonical JSON, the `shrine-descriptor` attachment of `shrine.kit.wall`, and [`schemas/shrine-kit-descriptor-v1.schema.json`](../schemas/shrine-kit-descriptor-v1.schema.json) is its schema.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"shrine-kit-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"module-base-center"` |
| `grid` | `{ module: 4, wallHeight: 3, wallThickness: 0.6, floorTop: 0, caveWidth: 4, caveHeight: 3 }` |
| `assets[]` | Sorted by `key`. Each has `key`, `role`, `category` (`structure`, `cave` or `prop`), `parentName`, `triangles`, `footprint`, measured `bounds` and `collisionProxies`. |
| `assets[].module` | The wall, the arch, the floor and the cave modules: the module's `width`, `height` and `depth`. |
| `assets[].opening` | The arch: `{ shape: "round-arch", width, springline, crown, depth, min, max }`. |
| `assets[].relic` | The altar: `{ node, position }` of the relic node. |
| `assets[].lights` | The altar and the cave mouth: `{ node, kind, position, direction?, color, suggestedIntensityCandela, suggestedRange }`. |
| `assets[].tunnel` | Cave modules: `{ axis: "+X", length, ends, clear }`. `ends` lists the open ends and `clear` is the passage box that no geometry and no proxy enters. |
| `assets[].airPocket` | The air pocket: the room's clear interior box, where a consumer may author its breathable box. |
| `assets[].anchor` | The hanging weed: `{ at: "top", position, hangs: "-Y" }`. |

`collisionProxies` are axis-aligned boxes `{ name, tag, center, size }` in the module's frame. The tags are `solid` and `floor`. The arch's opening and every cave passage stay free, and weed, silt drifts and shells have no proxy because they only render. The MMORPG keeps its own colliders, and it may use, replace or ignore these proxies.

## Release

The bundle is distributed as the rolling `shrine-kit` GitHub release, whose assets are replaced in place. A consumer pins the release, the tar sha256 and its own copy of `export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It reads each module with `readAssetBundleGltf(dir, manifest, "shrine.kit.<part>", "default")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "shrine.kit.wall", "default", "shrine-descriptor")`. CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Tests

`test/shrine-kit.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the bundle verify, and there are fourteen entries;
- the descriptor conforms to the schema;
- there are exactly six PNG resources;
- the wall and the arch fill their 4 m module, and the floor's top is y = 0;
- no vertex and no proxy reaches into the arch's round-headed opening;
- no vertex and no proxy of a cave module reaches into its passage, and every open end has the tunnel's cross-section;
- the air pocket is a wider room;
- the altar carries the relic node and its light, the mouth its light shaft, and the weed its anchor.

Without `BLENDER_TESTS=1` and `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

- the owner's visual review in the MMORPG's `?scenario=sunken-shrine`;
- publishing the `shrine-kit` release;
- the MMORPG side: widening its air-pocket chamber to the room module and mapping its `ids::SHRINE_*` ranges to these models in `mmorpg-scenery`'s `visual_kind` (mmorpg follow-up).
