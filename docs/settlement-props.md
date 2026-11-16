# Greyhaven settlement props

This is the build recipe for the reusable settlement props of one Greyhaven Outpost public space ([#369](https://github.com/moritzbrantner/asset-tooling/issues/369), consumer [mmorpg#421](https://github.com/moritzbrantner/mmorpg/issues/421)). mmorpg#421 asks for at least one prop from each of three families: work and market props, street furniture and architectural dressing. The footbridge ([#651](https://github.com/moritzbrantner/asset-tooling/issues/651)) joins the street family for the region's stream crossings.
The cottage furniture (bed, table, chair, chest and hearth) joins the dressing family to furnish the cottage interiors of [mmorpg#843](https://github.com/moenarch-games/mmorpg/issues/843). Its `sleep`, `top` and `fire` observations stay in the recipe result; the descriptor schema keeps its published extras.

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
| `settlement.props.footbridge` | street | 2,136 | 2.30 × 9.07 × 3.17 | `deck`, `ramp-back`, `ramp-front`, `rail-left`, `rail-right` | A 9 m plank footbridge along Z (#651): a level 6.6 m deck 0.55 m up on two stringers and two braced trestles, 1.2 m sloped ends down to the ground and post-and-rail sides. Its ends rest on the ground; the trestle posts reach 1.6 m below it, into a stream bed. |
| `settlement.props.bed` | dressing | 432 | 1.00 × 2.00 × 0.95 | `bed`, `headboard` | A plank bed along Z, its headboard at −Z: a straw mattress under a dyed blanket and a pillow ([mmorpg#843](https://github.com/moenarch-games/mmorpg/issues/843)). |
| `settlement.props.table` | dressing | 386 | 1.40 × 0.80 × 1.01 | `table` | A trestle table, its top 0.76 m up, with a jug and two bowls. |
| `settlement.props.chair` | dressing | 128 | 0.45 × 0.45 × 0.95 | `chair` | A slat-backed chair, its back towards −Z. The seat is at 0.45 m. |
| `settlement.props.chest` | dressing | 168 | 0.92 × 0.53 × 0.55 | `chest` | An iron-bound chest with a slightly domed lid and a hasp to +Z. |
| `settlement.props.hearth` | dressing | 372 | 1.80 × 0.85 × 2.60 | `hearth`, `flue` | A stone fireplace for a wall at −Z: a raised firebox with logs and embers under a mantel and a hood narrowing to a 2.6 m flue. |
| `settlement.props.barrel-group` | market | 766 | 1.27 × 1.25 × 0.90 | `barrels-back`, `barrel-lying` | Two standing barrels at the back and a third lying along X on wedges in front ([#657](https://github.com/moritzbrantner/asset-tooling/issues/657)). |
| `settlement.props.crate-stack` | market | 720 | 1.96 × 0.84 × 1.32 | `crates`, `crate-top` | Two 0.7 m crates side by side, a 0.62 m crate turned across them and a small crate beside, for a wall at −Z. |
| `settlement.props.grain-sacks` | market | 564 | 1.42 × 0.99 × 0.63 | `sacks` | Five tied sacks standing in two rows and one lying across the front. |
| `settlement.props.wheelbarrow` | market | 330 | 0.70 × 1.71 × 0.85 | `wheelbarrow` | A plank wheelbarrow, its wheel to +Z and handles to −Z, resting on two legs with a sack in the tray. |
| `settlement.props.well` | street | 550 | 2.20 × 1.59 × 2.64 | `curb`, `post-left`, `post-right` | A 1.5 m round stone well curb with dark water inside, two posts with a windlass and crank (+X), a rope to a hanging bucket and a shingle gable roof, ridge along X. |
| `settlement.props.fingerpost` | street | 222 | 1.54 × 1.07 × 2.61 | `post` | A 2.5 m fingerpost on a stone footing with three pointed, lettered arms at different heights and bearings. |
| `settlement.props.hay-bale` | dressing | 100 | 1.00 × 0.48 × 0.50 | `bale` | A rectangular bale tied with two twine bands, a few wisps on top. `stackTop` is 0.45. |
| `settlement.props.haystack` | dressing | 230 | 2.65 × 2.61 × 2.75 | `haystack` | A rounded field haystack 2.3 m high around a pole, with a skirt of fallen hay. |
| `settlement.props.chopping-block` | dressing | 228 | 1.63 × 0.94 × 0.94 | `block`, `logs` | A stump with an axe bitten into it, split pieces at its foot and three logs to its left (−X). |
| `settlement.props.washing-line` | dressing | 298 | 3.70 × 1.05 × 2.05 | `post-left`, `post-right` | A 3.6 m line along X between two T-posts, sagging under a sheet, a shirt and two cloths, with a basket in front. Only the posts collide. |
| `settlement.props.flower-tub` | dressing | 492 | 0.74 × 0.74 × 0.69 | `tub` | A hooped half-barrel of soil with leafy clumps and red, white and yellow flowers. |
| `settlement.props.vegetable-bed` | dressing | 342 | 1.80 × 1.00 × 0.43 | `bed` | A raised plank bed with two rows of cabbages and a row of carrot tops at the front. |
| `settlement.props.kennel` | dressing | 216 | 1.13 × 1.55 × 1.06 | `kennel` | A plank dog kennel with a shingle gable, its doorway to +Z, and a water bowl in front. |

The village dressing from `barrel-group` down ([#657](https://github.com/moritzbrantner/asset-tooling/issues/657)) is for Greyhaven's villages, Barrowdown and Fenford. The existing `cart`, `firewood` and `planter` complement it.

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
- `horn`: the lantern panes;
- `straw`: the hay bale and haystack.

Every face has backface culling. In the bundle there are 9 KTX2 textures in all, each stored once. Repeated props in a scene share their GLB resources. The tar is about 1.4 MB.

**Determinism:** there is no randomness. Variation comes from SHA-256 of fixed keys, through the kit's `rnd`.

### Textures on the GPU

Every texture ships as KTX2 (Basis Universal, `KHR_texture_basisu`, required, no PNG or JPEG fallback), with a full mip chain and encoded once per image by the shared kit pass (`ktx2Asset`, [`src/kit-bundle.ts`](../src/kit-bundle.ts), with KTX-Software's `ktx` CLI): base colour ETC1S sRGB, ORM and other data ETC1S linear, normals UASTC. A GPU transcodes Basis to a block format of at most 1 byte per texel, a quarter of RGBA8. Consumers need a Basis transcoder (in three.js, `KTX2Loader` registered with the `GLTFLoader`); a client without one cannot read the bundle. The 9 textures are about 0.8 MB; the tar went from 2.1 MB (9 PNGs) to 1.4 MB.

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

- the tar and the bundle verify, with one `default` entry per prop;
- the descriptor conforms to the schema;
- there are exactly 9 resources, all KTX2: the kit's wood, stone and shingle;
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
