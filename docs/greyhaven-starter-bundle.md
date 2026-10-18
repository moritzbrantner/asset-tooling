# Greyhaven starter bundle

This is the build recipe for the first Greyhaven environment bundle of [#118](https://github.com/moritzbrantner/asset-tooling/issues/118): the Quaternius wall with a doorway, its door and door frame, a barrel and `CommonTree_1` ([Atlas Decision 3.1.1](decisions/atlas.md)). The source members are listed in [greyhaven-starter-sources.md](greyhaven-starter-sources.md). The recipe follows the owner decisions of 2026-10-14 on #118:

- **Q1:** missing tangents are allowed through the named `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` exception. Consumers' renderers generate MikkTSpace tangents.
- **Q2:** the tree's vertex colours get the declared `gltf-color-clamp-v1` repair (bound 2e-4).
- **Q3:** every asset is placed with `scene.place.gltf@1` ([gltf-place.md](gltf-place.md)). Vertices are not baked.
- **Q4:** the result is a `gltf-resources-v1` bundle ([asset-bundles.md](asset-bundles.md#gltf-resources-profile)). Images are external files stored once by hash, and the doorway/collision descriptor is an attachment.
- **Q5:** the bundle is distributed as a GitHub release. Under Atlas Decision 7.1.5 that is the rolling `greyhaven-starter` release, whose assets are replaced in place. The first numbered `greyhaven-starter-v1` stays published for consumers that pin it.
- **Routine defaults:** the origin is at the footprint's base centre, the door's hinge is recorded as `sourcePivot`, no occlusion map is bound from the ORM textures, and the starter's collision proxies are separate boxes with an open doorway.

## Build

```sh
git lfs pull   # the starter members under assets/canonical/
bun scripts/build-greyhaven-starter.ts --out <directory>
```

[`scripts/build-greyhaven-starter.ts`](../scripts/build-greyhaven-starter.ts) is the maintained recipe. It needs no network, Blender or GPU. `<directory>` becomes the object-store root and holds every intermediate AssetRef. The script prints the bundle directory, the tar path, the tar sha256, the export ref and the descriptor. It writes `lineage.json` with every member, imported and placed AssetRef, the clamp repairs and the placement evidence, plus `export.ref.json`.

| Step | Operation | Inputs and parameters |
| --- | --- | --- |
| 1 | `scene.import.gltf@2` | Each member glTF with its buffer and textures as `resources` and their URIs as `resourceUris`. The policy is `allowedValidatorWarnings: ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"]`; the tree adds `repairs: ["gltf-color-clamp-v1"]`. |
| 2 | `scene.place.gltf@1` | `anchor: "footprint-base-center"`, `parentName: "greyhaven.<role>"` (`wall`, `door`, `door-frame`, `barrel`, `tree`). The door adds `sourcePivot: { node: "Door_1_Flat" }`. |
| 3 | descriptor | The `greyhaven-starter-descriptor-v1` JSON (below), measured on the placed GLBs and stored as an `application/json` AssetRef. |
| 4 | `asset.bundle@4` | `gltf-resources-v1` with the keys `greyhaven.starter.wall`, `.door`, `.door-frame`, `.barrel` and `.tree`, all with variant `default`. The descriptor is the `starter-descriptor` attachment of the **wall** entry. |
| 5 | `scripts/pack-asset-bundle.ts` | Packs `<directory>/bundle` into `<directory>/greyhaven.starter.tar` and its `.sha256`. |

The wall, the door and the door frame share the three WoodTrim textures. The bundle stores each of them once under `resources/`, and all three scenes reference the same file.

## Conventions

- **Units and axes:** metres, +Y up, right-handed. The kit's front faces +Z, and no rotation is applied.
- **Origin:** each asset's parent node `greyhaven.<role>` carries the placement translation, so the footprint's base centre is at the origin and every asset's lowest vertex is at y = 0.
- **Frames:** every value in the descriptor is in its asset's own placed frame. `mount` places an asset relative to the wall's placed frame.
- **Door hinge:** the door leaf spans x −0.046 to 1.072 m from its source node origin, so the hinge is that origin. `sourcePivot` records the node's world position in the source (`[0, 0, 0]`) and after placement (equal to the placement translation).

## Descriptor `greyhaven-starter-descriptor-v1`

The descriptor is canonical JSON. Numbers are rounded to 1e-6 m, except placement translations, which are the exact values written to the parent node.

| Field | Meaning |
| --- | --- |
| `schema` | `"greyhaven-starter-descriptor-v1"` |
| `units`, `up`, `facing`, `handedness`, `origin` | `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-base-center"` |
| `assets[]` | Sorted by `key`. Each has `key`, `role`, `parentName`, `placement: { anchor, translation }`, `footprint: { width (X), depth (Z), height (Y) }`, placed `bounds: { min, max }` and `collisionProxies`. |
| `assets[].sourcePivot` | Door only: `{ node, sourceWorldPosition, placedWorldPosition }`. |
| `assets[].mount` | Door and door frame: `{ parent: "greyhaven.starter.wall", translation }`, the translation of the placed asset in the wall's placed frame. The door is closed in the doorway: its footprint is centred on the doorway in X and Z, and its base is on the doorway's bottom. The frame returns to its source offset from the wall, because the kit's pieces share one source grid. |
| `assets[].doorway` | Wall only: `{ center, width, height, depth, min, max }`, measured as described below. |

### Doorway measurement

The doorway is measured on the placed wall's triangles, not taken from the pre-flight numbers. Rays run parallel to Z, the wall's thickness axis. They start at a seed on the wall's centre line at half the door's height, which must be open. From the seed, rays march outwards in 5 mm steps until they hit geometry, and each boundary is bisected to 1e-5 m. The width is the narrowest clear span over 21 rows, and the height is the lowest top over 21 columns, with two refinement passes. The depth is the Z extent of the geometry hit just outside both jambs, including the trim boards.

From the recorded build, the doorway is 1.295596 m wide and 2.151056 m high, from y = 0. It is centred at x = 0 and its depth is 0.263884 m (z −0.089 to 0.175). The #118 pre-flight measured 1.2956 × 2.1511 m. The closed door (1.118 × 2.100 × 0.121 m) leaves 0.089 m of clearance on each side and 0.051 m at the top.

### Collision proxies

`collisionProxies` are axis-aligned boxes `{ name, tag, center, size }` in the asset's placed frame:

| Asset | Proxies |
| --- | --- |
| wall | `left-jamb`, `right-jamb` (from the wall's side to the doorway, full height) and `lintel` (above the doorway), all `solid`, with the doorway's Z extent. The doorway stays open. |
| door | One `dynamic-door` box: the door's placed bounds. Apply it through `mount` and the hinge. |
| door frame | None. The frame sits inside the wall's jamb and lintel boxes. |
| barrel | One `solid` box: the barrel's placed bounds. |
| tree | One `solid` `trunk` box. Its X/Z extent is that of the bark vertices between 0.5 and 1.0 m, above the root flare, and it runs from the ground to the lowest leaf vertex. |

These proxies are presentation and inspection metadata. Game physics, traversability and collider policy stay with the consumers (mmorpg#39, arpg#72), which may use, replace or ignore them.

## Starter kit (#119)

[#119](https://github.com/moritzbrantner/asset-tooling/issues/119) grows the five-asset slice into a 20-entry kit from the same three CC0 MegaKits (Atlas Decision 3.1.1):

- modular structure pieces;
- matching vegetation;
- everyday props.

Every member goes through the same import → place → descriptor path. `category` in the descriptor groups them into `structure`, `vegetation` and `prop`. Members that only render, such as the frame, bush, grass and lantern, get no collision proxy. The pine's trunk proxy is measured like the tree's, and every other member gets its placed bounds.

| Key | Category | Triangles | Footprint W × D × H (m) | Collision proxies |
| --- | --- | --- | --- | --- |
| `greyhaven.starter.barrel` | prop | 824 | 0.698 × 0.698 × 0.898 | `barrel` |
| `greyhaven.starter.bench` | prop | 404 | 2.777 × 0.534 × 0.533 | `bench` |
| `greyhaven.starter.bush` | vegetation | 1,368 | 1.915 × 1.965 × 1.582 | none |
| `greyhaven.starter.cart` | prop | 3,936 | 3.021 × 1.060 × 2.632 | `cart` |
| `greyhaven.starter.chest` | prop | 2,546 | 1.276 × 0.755 × 0.715 | `chest` |
| `greyhaven.starter.corner` | structure | 12 | 0.210 × 0.240 × 3.000 | `corner` |
| `greyhaven.starter.crate` | prop | 1,576 | 0.842 × 0.908 × 0.931 | `crate` |
| `greyhaven.starter.door` | structure | 314 | 1.118 × 0.121 × 2.100 | `door` |
| `greyhaven.starter.door-frame` | structure | 56 | 1.574 × 0.388 × 2.312 | none |
| `greyhaven.starter.fence` | structure | 40 | 2.064 × 0.120 × 0.838 | `fence` |
| `greyhaven.starter.fence-extension` | structure | 32 | 2.045 × 0.110 × 0.838 | `fence-extension` |
| `greyhaven.starter.gable` | structure | 252 | 4.400 × 1.129 × 3.069 | `gable` |
| `greyhaven.starter.grass` | vegetation | 155 | 0.639 × 0.737 × 1.334 | none |
| `greyhaven.starter.lantern` | prop | 2,822 | 0.357 × 1.302 × 1.337 | none |
| `greyhaven.starter.pine` | vegetation | 3,947 | 4.945 × 4.538 × 7.317 | `trunk` |
| `greyhaven.starter.rock` | vegetation | 342 | 3.225 × 2.989 × 2.260 | `rock` |
| `greyhaven.starter.roof` | structure | 1,996 | 5.513 × 5.561 × 4.249 | `roof` |
| `greyhaven.starter.tree` | vegetation | 6,265 | 4.311 × 4.578 × 7.265 | `trunk` |
| `greyhaven.starter.wall` | structure | 92 | 2.000 × 0.406 × 3.123 | `left-jamb`, `right-jamb`, `lintel` |
| `greyhaven.starter.wall-plain` | structure | 86 | 2.000 × 0.406 × 3.125 | `wall-plain` |

**Connections.** The structure pieces share the kit's grid.

- **Walls:** `wall` and `wall-plain` are 2.000 m modules, about 3.12 m high, placed at module centres 2 m apart. A wall turned 90° about +Y forms a side.
- **Corners:** `corner` posts sit on the module ends.
- **Roof:** `roof` (the 4 × 4 tile roof) covers a 4 × 4 m footprint from the wall top, with its ridge along Z.
- **Gables:** a `gable` closes each open roof end at the front and back.
- **Fences:** `fence` and `fence-extension` are 2 m sections.

The composition files below give working placements.

**Moving parts.**

- **Door:** hinges at its recorded `sourcePivot`.
- **Chest:** rigged. Its lid is the `Chest_Top` joint, recorded as the chest's `sourcePivot`, and a consumer rotates that joint to open it. The chest is imported with the `NODE_SKINNED_MESH_NON_ROOT` exception, because the kit's skinned meshes sit under its armature.

**Scale.** The pieces keep the kit's own units. Grass and the medium rock are large next to a 1.8 m character (1.33 m and 3.2 m), the same as in the source kits. A consumer may scale vegetation instances.

**Compositions.** [`examples/greyhaven-kit/`](../examples/greyhaven-kit/) holds two review compositions built from the same kit:

- `greyhaven-yard.json`: a 4 × 4 m house from wall modules, corners, roof and gables, with the door, a wall lantern, an open chest, props, a fence and vegetation, at a near third-person camera.
- `arpg-camp.json`: a cart-and-supply camp under a high action-RPG camera.

`render-composition.py` renders either with Blender from a built bundle:

```sh
blender --background --factory-startup --python examples/greyhaven-kit/render-composition.py -- <bundle> examples/greyhaven-kit/greyhaven-yard.json yard.png [--figure=<character.gltf>]
```

`--figure` adds a character for scale, for example the Ranger. The compositions are review data only. Placement, opening state and collision policy in a game stay with mmorpg and arpg.

## Variations (#121)

[#121](https://github.com/moritzbrantner/asset-tooling/issues/121) adds controlled variations of four kit families, so the kit gains usable sizes and constructions without new source assets. `GREYHAVEN_VARIATIONS` declares each one as recipe data, and `sliceResizeDocument` ([`src/gltf-slice-resize.ts`](../src/gltf-slice-resize.ts)) builds it from the placed source member:

- **Margins and middle:** each axis is cut into a fixed margin at both ends and a stretchable middle. Vertices in a margin move with their end, so rims, trims, posts and fittings keep their size. The middle is scaled to reach the requested outer size.
- **Placement:** X and Z stay centred and Y keeps its base, so a variation stands where its source stands.
- **Normals:** stretched normals are corrected with the inverse scale.
- **Construction choice:** `dropMaterials` removes a part by material, for example the crate's metal fittings.
- **Shared resources:** UVs, materials and textures are unchanged. A variation therefore shares its source's trim-sheet textures in the bundle; they are stored once.
- **Validation:** each variation goes back through `scene.import.gltf@2` and gets a descriptor entry with `variationOf`, `label`, its measured footprint and a bounds collision proxy.

| Family | Variation key | Change |
| --- | --- | --- |
| crate | `crate-long` | 1.5 m wide |
| crate | `crate-low` | 0.5 m high |
| crate | `crate-plain` | without the metal fittings (`MI_Trim_Metal`) |
| barrel | `keg` | 0.56 m in every axis |
| barrel | `barrel-tall` | 1.25 m high |
| barrel | `tub` | 1.0 m wide and deep, 0.55 m high |
| wall | `wall-plain-1m`, `wall-plain-3m`, `wall-plain-4m` | 1, 3 and 4 m modules (end posts kept, middle stretched) |
| fence | `fence-1m`, `fence-3m` | 1 and 3 m sections between the two posts |
| fence | `fence-tall` | 1.3 m high |

Keys are `greyhaven.starter.<variation>`. A new variation is one more `GREYHAVEN_VARIATIONS` row; no consumer code changes. Limits:

- Stretching scales the middle's texture with it, so plaster and planks get longer. Small changes read fine at gameplay distance, and the 4 m wall shows it most.
- Only static members can be resized. Rigged members such as the chest are rejected.

`examples/greyhaven-kit/variations.json` lines every variation up next to its source for review (`render-composition.py`).

## Bundle and consumer pinning

Each entry is `scenes/<key>/default.gltf` with one `.bin` and its PNGs as hash-addressed resources. The first five entries (#118) are:

| Key | Triangles | Resources | Footprint W × D × H (m) |
| --- | --- | --- | --- |
| `greyhaven.starter.wall` | 92 | 10 (+ `starter-descriptor`) | 2.000 × 0.406 × 3.123 |
| `greyhaven.starter.door` | 314 | 4 | 1.118 × 0.121 × 2.100 |
| `greyhaven.starter.door-frame` | 56 | 4 | 1.574 × 0.388 × 2.312 |
| `greyhaven.starter.barrel` | 824 | 7 | 0.698 × 0.698 × 0.898 |
| `greyhaven.starter.tree` | 6,265 | 4 | 4.311 × 4.578 × 7.265 |

Across the whole kit there are 48 distinct resources, because the trim-sheet textures are shared, and the tar is about 69 MB. A consumer pins the three things described in [Release distribution and consumer pinning](asset-bundles.md#release-distribution-and-consumer-pinning):

1. the release (`greyhaven-starter`, rolling);
2. the tar sha256;
3. its own copy of `export.ref.json`.

It then runs `bun scripts/pack-asset-bundle.ts --verify greyhaven.starter.tar --ref <pinned export.ref.json>` (or `verifyAssetBundle` after extracting). It loads each asset with `readAssetBundleGltf(dir, manifest, key, "default")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "greyhaven.starter.wall", "default", "starter-descriptor")`. Publishing the release (`gh release create`) is a separate, explicit step.

Two cold builds on 2026-10-17 from separate object stores produced the same tar: sha256 `bffcce9ae2d0f5f4af02c82489d7e54e4191e04eb9efb9555f8e2680fb25d3f5`, 48,865,280 bytes, with manifest sha256 `d1b2eb1346020f82dde48791b3b4a3ca7dcb22edccfb62c10f81d0a7abdbe2f7` (13,606 bytes). This is a record of that run, not a byte-exact replay contract.

## Tests

`test/greyhaven-starter-bundle.test.ts` runs the whole recipe into a temporary directory. It checks:

- the bundle with `verifyAssetBundle` and the tar with `verifyAssetBundleTar`;
- that each WoodTrim texture is one resource shared by the wall, the door and the frame, and is in the tar once;
- that the doorway is within 2 cm of the pre-flight measurement and contains the mounted door, which has positive clearance;
- that no wall proxy reaches into the doorway;
- the door's `sourcePivot`;
- that every bundled asset has its `greyhaven.<role>` parent and a lowest vertex at y = 0.

It skips on Git LFS pointers unless `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`, which the hosted `canonical-storage` job sets.

## Not covered here

These remain open on #118 and its consumers:

- publishing the GitHub Release;
- the game-camera scene review and the #111 source/processed comparison;
- the consumer handoff to mmorpg#39 and arpg#72.
