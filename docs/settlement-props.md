# Greyhaven settlement props

This is the build recipe for the reusable settlement props of one Greyhaven Outpost public space ([#369](https://github.com/moritzbrantner/asset-tooling/issues/369), consumer [mmorpg#421](https://github.com/moritzbrantner/mmorpg/issues/421)). mmorpg#421 asks for at least one prop from each of three families: work and market props, street furniture and architectural dressing.

- **Approach:** an original scripted Blender recipe, [`adapters/blender/settlement_props.py`](../adapters/blender/settlement_props.py), as Atlas Decisions 1.1.7 and 3.1.2 direct for mmorpg's humanlike-world environments. Quaternius props were the inspiration only. The set uses no imported meshes and no third-party assets.
- **Style:** it matches the [Outpost building kit](outpost-kit.md) and the [Greyhaven inn](greyhaven-inn.md): dark braced timber, plain plank wood, iron straps and hoops, coursed stone footings and shingle. The recipe builds its props with the kit's own `Builder`, materials and numpy textures, so the textures are byte-identical to the kit's.
- **Release:** one rolling release, `settlement-props` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-settlement-props.ts --out <directory>
```

[`scripts/build-settlement-props.ts`](../scripts/build-settlement-props.ts) works like the [Outpost build](outpost-kit.md#build):

1. One `external.blender.script@1` run per prop. The kit recipe `outpost.py` is a declared, hash-pinned Python input named `outpost`, and the props recipe loads it with `inputs.load_source("outpost")`.
2. Each GLB is imported through `scene.import.gltf@2`, with no validator exceptions.
3. The descriptor is written from the recipe's observations and the measured bounds.
4. The result is exported as a `gltf-resources-v1` bundle (`asset.bundle@4`) and packed to `<directory>/settlement.props.tar`. The script also writes `lineage.json`, `descriptor.json` and `export.ref.json`.

The build takes about a minute. It needs no network, no LFS payloads and no GPU. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

In a live Blender session, run `outpost.py` and `settlement_props.py` into two namespaces, bind the shared helpers with `outpost_namespace["use_common"](runpy.run_path("adapters/blender/kit_common.py"))`, then call `use_kit(outpost_namespace)`. After that, `build(prop, collection, location, yaw)` and `build_composition("square", collection, location)` work, for example through the Blender MCP.

## Props

| Key | Family | Triangles | Footprint W × D × H (m) | Collision proxies | Notes |
| --- | --- | --- | --- | --- | --- |
| `settlement.props.stall` | market | 968 | 2.60 × 1.83 × 2.60 | `counter`, `awning` | A 2.4 × 1.4 m plank counter with four posts and a striped canvas awning with a pointed valance, sloping to the front. It carries a crate, two sacks and a board. |
| `settlement.props.cart` | market | 1,326 | 1.34 × 2.44 × 0.99 | `cart` | A two-wheeled handcart with 0.92 m spoked wheels and iron tyres, resting level on a prop leg. The shafts point to +Z. It carries a sack and a crate. |
| `settlement.props.crate` | market | 180 | 0.71 × 0.71 × 0.70 | `crate` | A plank crate in a timber frame with braces. `stackTop` is 0.7. |
| `settlement.props.barrel` | market | 390 | 0.61 × 0.61 × 0.90 | `barrel` | A coopered barrel with four iron hoops and a sunk head. `stackTop` is 0.9. |
| `settlement.props.signpost` | street | 304 | 1.37 × 0.44 × 2.96 | `post` | A post on a stone footing with a braced arm towards +X and a hanging painted board facing ±Z. Its empty node `sign` is at the board's centre. |
| `settlement.props.lantern-post` | street | 262 | 0.40 × 0.87 × 3.06 | `post` | A 3 m post on a stone footing with an iron bracket towards +Z and a horn-paned lantern. Its empty node `light` is at the flame, about 2.5 m up. |
| `settlement.props.bench` | street | 260 | 1.60 × 0.42 × 0.46 | `bench` | A two-plank bench on trestle legs with a wedged stretcher. The seat is at 0.46 m. |
| `settlement.props.fence` | dressing | 172 | 2.00 × 0.16 × 1.14 | `fence` | A 2 m post-and-rail segment along X. Like the kit's walls, it has half a post at each end, so neighbouring segments share one post. |
| `settlement.props.planter` | dressing | 420 | 1.20 × 0.50 × 0.83 | `planter` | A timber planter box with soil and three leafy shrubs. |
| `settlement.props.firewood` | dressing | 968 | 1.90 × 0.82 × 1.20 | `woodpile` | Five rows of split billets on sleepers between end stakes, end grain to the front, under a short shingle cover. |

The numbers are from the build of 2026-10-24. The descriptor carries the measured values of each build. The budgets in `SETTLEMENT_TRIANGLE_BUDGET` are for the Greyhaven camera (12 m, 0.42 rad pitch, 50° fov).

## Frame

- **Units and axes:** metres, +Y up, right-handed.
- **Origin:** on the ground at the centre of the prop's footprint (`footprint-base-center`). The front faces +Z.
- **Fence:** the segment spans x −1..1, so segments chain on a 2 m grid.

## Composition

The descriptor's `compositions.square` is a working layout of a small market corner, 12 × 9 m, in a centre-ground frame. The open square is towards +Z. It has 21 items:

- at the back, two stalls with stacked crates, barrels, the handcart and the woodpile, in front of a 12 m fence run;
- at the front, a lantern post, a bench, a planter, a barrel, a crate and the signpost, all facing the walkway.

`walkway` is a 3 m wide box along X through the middle (z −1.5..1.5). The test checks that no item's collision proxy enters it and that every item stays inside the footprint. The layout is a starting point. mmorpg chooses the real space and the placements.

## Look and materials

The props use the kit's wood, stone and shingle texture sets (colour, normal and ORM, 512 px each) and its `timber`, `iron` and `soot` materials. The recipe adds these plain-colour materials:

- `canvas` and `dye`: the awning stripes and the painted sign;
- `sacking`: the sacks;
- `soil` and `leaf`: the planter;
- `endgrain`: the billet ends;
- `horn`: the lantern panes.

Every face has backface culling. In the bundle there are 9 PNGs in all, each stored once. Repeated props in a scene share their GLB resources. The tar is about 2.1 MB.

**Determinism:** there is no randomness. Variation comes from SHA-256 of fixed keys, through the kit's `rnd`.

## Descriptor `settlement-props-descriptor-v1`

The descriptor is canonical JSON and the `settlement-descriptor` attachment of `settlement.props.stall`. Its schema is [`schemas/settlement-props-descriptor-v1.schema.json`](../schemas/settlement-props-descriptor-v1.schema.json).

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"settlement-props-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-base-center"` |
| `assets[]` | Sorted by `key`. Each has `key`, `role`, `family` (`market`, `street` or `dressing`), `parentName`, `triangles`, `footprint`, measured `bounds` and `collisionProxies`. |
| `assets[].stackTop` | `crate`, `barrel`: the height another one stacks on. |
| `assets[].seat` | `bench`: `{ height, length, depth }`. |
| `assets[].module` | `fence`: `{ width: 2, height }`. |
| `assets[].light` | `lantern-post`: `{ node: "light", position }`. |
| `assets[].sign` | `signpost`: `{ node: "sign", board: { min, max } }`. |
| `compositions.square` | `{ footprint, walkway, items[] }`, where an item is `{ key, variant, translation, yawDegrees }` and the yaw is about +Y. |

`collisionProxies` are axis-aligned `solid` boxes `{ name, tag, center, size }` in the prop's frame. They are presentation metadata. The props carry no gameplay: a consumer keeps its own colliders and interactions, and it may use, replace or ignore these proxies (mmorpg#421).

## Release

The bundle is distributed as the rolling `settlement-props` GitHub release, whose assets are replaced in place. A consumer pins the release, the tar sha256 and its own copy of `export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It reads each prop with `readAssetBundleGltf(dir, manifest, "settlement.props.<prop>", "default")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "settlement.props.stall", "default", "settlement-descriptor")`. CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Tests

`test/blender/kits/settlement-props.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the bundle verify, with ten `default` entries;
- the descriptor conforms to the schema;
- there are exactly 9 PNG resources, the kit's wood, stone and shingle;
- every prop stays within its triangle budget (`SETTLEMENT_TRIANGLE_BUDGET`), has its family and stands on the ground;
- the fence fills its 2 m module, the crate's `stackTop` is its top, and the lantern and the sign hang above head height;
- in the square, every item is a bundle entry, all three families are placed, and every proxy stays inside the footprint and out of the walkway.

Without `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

These belong to the mmorpg side, mmorpg#421:

- choosing the public space and placing the props;
- the fallback when resources fail;
- the matched-camera game capture;
- native parity.

Publishing the `settlement-props` release is also not covered here.
