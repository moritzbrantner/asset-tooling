# Greyhaven Outpost building kit

This is the build recipe for the modular building exteriors of mmorpg's Greyhaven Outpost ([#366](https://github.com/moritzbrantner/asset-tooling/issues/366), consumer [mmorpg#420](https://github.com/moritzbrantner/mmorpg/issues/420)). mmorpg#420 replaces two blockout Outpost houses or workshops with real modular buildings, without changing their footprints, colliders or openings.

- **Approach:** two layers, each edited on its own (Atlas Decision 3.1.3):
  - **Geometry:** hand-authored in Blender, [`assets/authored/outpost-kit.blend`](../assets/authored/outpost-kit.blend) (Git LFS). It was seeded on 2026-11-07 from the earlier scripted recipe (the `outpost.py` of the commit before it) and is edited directly from then on.
  - **Textures and wear:** [`adapters/blender/outpost.py`](../adapters/blender/outpost.py) generates the tileable textures with numpy, ages them by `wear`, dresses the authored modules and exports them.

  The Quaternius kits of the [starter bundle](greyhaven-starter-bundle.md) were the inspiration only. Their 4 × 4 m roof does not cover the Outpost's 6 m spans, and their style is the cartoony one. The kit uses no imported meshes and no third-party assets.
- **Style:** it matches the scripted [Greyhaven inn](greyhaven-inn.md): a stone plinth, lime plaster in a dark timber frame with braces, plank doors with iron straps, small glazed windows with open shutters, and a 30° roof like the inn's (about 29°).
- **Release:** one rolling release, `outpost-kit` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-outpost-kit.ts --out <directory>
```

[`scripts/build-outpost-kit.ts`](../scripts/build-outpost-kit.ts) works like the [shrine build](shrine-kit.md#build):

1. One `external.blender.script@1` run per module variant: the default, and for each roof module also slate. Each run appends the module from the `.blend` (the declared input `kit`), dresses it and exports it. One more run (part `wear-masks`) writes the [wear masks](#wear-masks).
2. Each GLB is imported through `scene.import.gltf@2`, with no validator exceptions.
3. Every texture is encoded as KTX2 (see [Textures on the GPU](#textures-on-the-gpu)) with KTX-Software's `ktx` CLI (`ASSET_TOOLING_KTX`, or `ktx` on PATH).
4. The descriptor is written from the observations stored on the authored modules, the recipe's compositions and the measured bounds.
5. The result is exported as a `gltf-resources-v1` bundle (`asset.bundle@4`) and packed to `<directory>/outpost.kit.tar`. The script also writes `lineage.json`, `descriptor.json` and `export.ref.json`.

The build takes about 2 minutes. It needs no network and no GPU; it reads the hydrated `.blend` (`git lfs pull --include="assets/authored/**"`) and fails clearly on an LFS pointer. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

### Editing the geometry

Open `assets/authored/outpost-kit.blend` in Blender 5.2.2. It holds one collection `outpost.<part>` per module, laid out in a row; the export places each module's root at the origin, so the layout does not matter.

- Every module has one root empty `outpost.<part>` with the mesh and its empties (`door.hinge`, `hinge`, `smoke`) as children. Keep the frames and the grid below: the kit's test checks the module widths, wall depth, open doorway and triangle budgets on every build.
- The root's custom property `outpost` is the JSON of the descriptor's observations (`collisionProxies`, `module`, `window`, `doorway`, `mount`, `hinge`, `leafBounds`, `roof`, `span`, `smoke`). Update it when an edit moves an opening, the hinge or a proxy.
- Materials are untextured placeholders named `outpost-<material>` (`plaster`, `stone`, `timber`, `wood`, `shingle`, `glass`, `iron`, `soot`). Assign these by name; the recipe replaces them with its textured materials. Roof modules use `shingle`, which the slate variants swap for `slate`. UVs follow the textures' tiles: 2 m per tile for plaster, 1 m for the others, one shingle course per quarter tile.

To see the result textured and aged while editing, run the recipe in the same session, for example through the Blender MCP:

```python
import bpy, runpy
outpost = runpy.run_path("adapters/blender/outpost.py")
outpost["use_common"](runpy.run_path("adapters/blender/kit_common.py"))
outpost["use_geometry"]("assets/authored/outpost-kit.blend")
outpost["build_composition"]("house", bpy.context.scene.collection, wear=0.5)
```

`build(part, collection, location, roof, yaw, wear)` places one module the same way. Save the `.blend` before building from it: the recipe reads the file, not the open session.

## Modules

| Key | Category | Triangles | Footprint W × D × H (m) | Collision proxies |
| --- | --- | --- | --- | --- |
| `outpost.kit.chimney` | chimney | 232 | 1.20 × 0.90 × 6.40 | `chimney` |
| `outpost.kit.corner` | corner | 88 | 0.42 × 0.42 × 3.62 | `corner` |
| `outpost.kit.door` | door | 156 | 1.17 × 0.15 × 2.18 | `leaf` (`dynamic-door`) |
| `outpost.kit.gable` | wall | 250 | 5.96 × 0.32 × 1.72 | `gable` |
| `outpost.kit.roof` | roof | 350 | 2.00 × 6.73 × 2.22 | `roof` |
| `outpost.kit.roof-half` | roof | 302 | 1.00 × 6.73 × 2.22 | `roof` |
| `outpost.kit.roof-verge` | roof | 366 | 0.30 × 6.85 × 2.23 | `roof` |
| `outpost.kit.wall` | wall | 404 | 2.00 × 0.34 × 3.60 | `wall` |
| `outpost.kit.wall-door` | wall | 770 | 2.00 × 0.54 × 3.68 | `left-jamb`, `right-jamb`, `lintel` |
| `outpost.kit.wall-half` | wall | 296 | 1.00 × 0.34 × 3.60 | `wall` |
| `outpost.kit.wall-window` | wall | 714 | 2.00 × 0.38 × 3.60 | `wall` |

The numbers are from the build of 2026-11-07 (pristine variants; the roof modules are unchanged). The descriptor carries the measured values of each build.

- **Walls:** each wall module has a 0.5 m stone plinth, plaster panels set 4 cm behind the timber face, a sill beam and a top plate. At each end stands half of a 0.18 m post, so two neighbouring modules make one post between them.
  - Every wall module carries a head rail at 2.25–2.41 m, so it reads as one timber around the building, and the window and door heads meet it. Braces are cut to their bay, so their ends sit flush against the posts, rails and sills.
  - `wall` has a centre post and a brace in each lower bay.
  - `wall-half` (1 m) has one brace below the rail.
  - `wall-window` has a 0.9 × 1.1 m glazed window with its sill at 1.15 m. Studs run from the sill beam to the top plate either side of it, a sill rail and the head rail carry it, and knee braces above the rail stay clear of the window and its open plank shutters. It has a mullion and a transom, a proud timber sill and a lintel.
  - `wall-door` has the inn's 1.2 × 2.2 m doorway. Its posts stand on stone pads, a head beam spans it, and a stone threshold sits flush with the ground. The empty node `door.hinge` marks where the door hangs.
- **`door`:** a five-plank leaf with inside battens and a brace, iron strap hinges and a latch. Its origin is the hinge, and the closed leaf runs along +X. It has an empty node `hinge`.
- **`corner`:** the corner post and a stone plinth block. It covers the overlap of the two walls that meet at a corner.
- **`gable`:** the plaster gable triangle for the 6 m span. Rafters follow both roof edges, and every other gable timber ends on them: a collar cut to the rafters, two posts under it over the gable wall's module joints (clear of the window below) and a king post from the collar to the apex, with a louvred vent each side. It stands on a gable wall's top plate.
- **`roof`, `roof-half`:** 2 m and 1 m sections of the 6 m span roof, built from overlapping courses that alternate slightly. Each has board sheathing, an eave fascia, rafter tails every 0.5 m and a board ridge cap.
- **`roof-verge`:** the 0.3 m roof overhang beyond a gable, with barge boards.
- **`chimney`:** an outside stone chimney against a gable wall: a foot, a breast, sloped shoulders and a stack that clears the ridge by about 0.75 m, with a cap. Its empty node `smoke` marks the flue.

## Grid and frames

- **Units and axes:** metres, +Y up, right-handed. The outside of a module faces +Z.
- **Wall modules** (`wall*`, `gable`, `chimney`): the origin is on the ground at the centre of the module's outer face. The wall body lies behind it (z −0.32..0). Timber is flush with the face, and the plinth stands 2 cm proud. Walls are 2 m modules (x −1..1) with 1 m `wall-half` fillers, and they are 3.6 m high, a roomier storey than the inn's 3.2 m.
- **Corners:** the origin is the building's outer corner. The unrotated corner fits the front-right corner (+X, +Z); turn it by −90°, 180° or 90° for the others.
- **Roof modules:** the origin is on the ground under the ridge. The ridge runs along X. The slopes fall to ±Z over a 6 m span, measured between the outer wall faces. The eaves overhang 0.35 m, and the roof's underside meets the outer wall face at the 3.6 m wall top. The ridge cap's top is at 5.52 m. `roof-verge` covers x 0..0.3, so place it at the gable line and turn it by 180° for the other end.
- **Snapping:** a building whose footprint is W × D, with the ridge along W and a 6 m span (D = 6), has wall modules on all four footprint edges. A side wall is turned by ±90° and a back wall by 180°. It has corners at the four footprint corners, a gable on each gable wall, roof sections at 2 m centres along the ridge, and a verge at each end.

## Compositions

The descriptor's `compositions` place every module on mmorpg's two Outpost footprints. Each is in a footprint-base-centre frame whose +Z side has the door. An item is `{ key, variant, translation, yawDegrees }`, where the yaw is about +Y.

| Composition | Footprint | Items | Triangles | Layout |
| --- | --- | --- | --- | --- |
| `house` | 8 × 6 m (colliders 103–106) | 29 | 10,488 | Ridge along X, shingle roof. The front has window, half, door, half, window, so the door is centred as in the blockout. The chimney is on the +X gable. |
| `smithy` | 6 × 7 m (collider 102) | 28 | 9,484 | Ridge along its 7 m depth, slate roof. The door is in the front gable wall, and the chimney is on the back gable. |

Notes for the consumer:

- **Footprints:** the walls stand exactly on the collider footprints. Only the plinth (2 cm), the eaves (0.35 m), the verges (0.3 m), the door's threshold and the chimney stand outside them.
- **Heights:** the ridge is at 5.52 m. That is 0.52 m above the houses' 5 m colliders and 1.02 m above the smithy's 4.5 m collider; the footprints are unchanged.
- **Door:** the door hangs closed in the doorway. The houses are not enterable, so a consumer should keep the door closed and the opening solid. There is then no traversable-looking entrance where none exists (mmorpg#420).

## Look and materials

The kit uses five tileable PBR texture sets of 512 px each: colour (sRGB), normal (OpenGL, +Y up) and ORM (occlusion, roughness, metallic).

- **Plaster:** a warm lime plaster with blotches and trowel waves; one tile covers 2 m.
- **Stone:** coursed rubble with four courses of irregular stones in dark mortar; one tile covers 1 m.
- **Wood:** grain along U; one tile covers 1 m. The timber frame uses it with a darker base-colour factor and the planks without one, so the frame and the planks share one image.
- **Shingle:** weathered grey-brown shingles.
- **Slate:** blue-grey slates.

Each roof course maps exactly one row of the roof texture. Each course starts at its own offset, so the shingles break joint.

Glass, iron and soot are plain-colour materials. Every face has backface culling.

## Wear

The recipe takes `wear` in [0, 1] (0, the default, is the pristine kit), so consumers can remix aged buildings. Wear changes textures only, never geometry, so every variant shares the pristine meshes. It is deterministic, and more wear only adds to what less wear shows:

- **Plaster:** grime and rain streaks, and patches where it has fallen away to a recessed wattle and daub (woven rods under clay) with a broken edge.
- **Timber and planks:** greyed and grimier.
- **Stone and roofs:** moss in the joints and on the courses.
- **Roofs:** some shingles or slates are missing, a dark recess where the boards show through. Every metre of a course and every roof module repeat the same texture, so they stay sparse.

The bundle ships no baked wear variants: each would be one more material, and a consumer that batches draws per material (mmorpg's browser client) would pay a draw call per variant in every pass. It ships the pristine modules and the wear masks instead, so a shader ages any module to any wear with one material per texture. A live Blender session still bakes any `wear` (`build(..., wear=0.5)`).

### Wear masks

The `outpost.kit.wear-masks` entry holds one 1 m quad per texture, whose material `outpost-wear-<texture>` (`plaster`, `wood`, `stone`, `shingle`, `slate`) carries the texture's mask as its base colour. The mask tiles exactly like its texture, so a shader samples it with the module's own UVs. It is data, not colour: linear RGB, KTX2 UASTC. A consumer reads it without the sRGB decode a base colour would get. Timber and planks use the `wood` mask, and slate roofs use the `slate` mask.

| Channel | Meaning |
| --- | --- |
| R | Plaster: the wear from which the pixel shows the wattle and daub beneath; 1 means never. Roofs: the id of the pixel's roof unit, `(k + 0.5) / 64`. Wood and stone: 1. |

Roof ids rather than thresholds: the roof tile repeats every metre and on every module, so any order baked into it would repeat its holes in a grid. A shader instead decides each occurrence of a unit on its own, for example by hashing `floor(id * 64)`, the tile (`floor(uv)`) and the module's placement, and drops it (dark boards, rough, little occlusion) where that hash is below 7 % of the wear. More wear then only adds holes, scattered with no pattern. Read the id with nearest filtering (`texelFetch` at level 0): filtering blends neighbouring ids at the joints.
| G, grime | How much full wear darkens the pixel: `colour *= 1 - wear * G` (stains and rain streaks on plaster, grime elsewhere). |
| B | Plaster: the wattle and daub beneath, from its dark rods (0) to its pale clay (1). Stone and roofs: the wear from which moss settles, earliest in the dark joints. 1 means never. Wood: 1. |

The baked recipe also tints plaster towards a dull ochre (35 % at full wear) and greys timber (55 %); these are constants a shader applies by material, not data. The masks follow the baked wear's fields, so a shader that uses them shows the same patches, units and moss as the baked kit. It need not match the baked kit pixel for pixel.

### Textures on the GPU

Every texture ships as KTX2 (Basis Universal, `KHR_texture_basisu`, required, no PNG fallback), each with a full mip chain and encoded once per image (`ktxArguments`, [`scripts/pack-downloads.ts`](../scripts/pack-downloads.ts)):

| Slot | Encoding |
| --- | --- |
| Base colour | ETC1S (BasisLZ) qlevel 160, sRGB |
| ORM | ETC1S qlevel 160, linear |
| Normal | UASTC quality 2, Zstandard 18, linear |
| Wear mask | UASTC quality 2, Zstandard 18, linear: its channels are independent thresholds that ETC1S's shared endpoints would smear together |

A GPU transcodes Basis to a block format of at most 1 byte per texel (BC7, ASTC or ETC2), a quarter of what RGBA8 needs. In three.js, register `KTX2Loader` with the `GLTFLoader`. A native client without a Basis transcoder cannot read the bundle. The 20 textures are about 2.1 MB, and the tar is about 2.6 MB.

Geometry is not meshopt-compressed (`EXT_meshopt_compression`): mmorpg's native client reads the modules with the `gltf` crate, which does not decode it, and the geometry is only about 0.4 MB.

**Determinism:** there is no randomness. Variation comes from SHA-256 of fixed keys, and the textures come from numpy's legacy `RandomState`.

## Descriptor `outpost-kit-descriptor-v1`

The descriptor is canonical JSON and the `outpost-descriptor` attachment of `outpost.kit.wall`. Its schema is [`schemas/outpost-kit-descriptor-v1.schema.json`](../schemas/outpost-kit-descriptor-v1.schema.json).

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"outpost-kit-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"module-anchor"` (see [Grid and frames](#grid-and-frames)) |
| `grid` | `{ module: 2, halfModule: 1, wallHeight: 3.6, wallThickness: 0.32, plinthHeight: 0.5, span: 6, pitchDegrees: 30, eaveOverhang: 0.35, vergeOverhang: 0.3 }` |
| `assets[]` | Sorted by `key`. Each has `key`, `role`, `category` (`wall`, `door`, `corner`, `roof` or `chimney`), `parentName`, `triangles`, `footprint`, measured `bounds` and `collisionProxies`. |
| `assets[].module` | Wall modules: `{ width, height, depth }`. |
| `assets[].window` | `wall-window`: the glazed opening, its sill height and its box from the glass to the outer face. |
| `assets[].doorway` | `wall-door`: `{ center, width, height, depth, min, max }`, the clear opening. No geometry and no proxy enters it. |
| `assets[].mount` | `wall-door`: `{ key: "outpost.kit.door", node: "door.hinge", translation }`, where the door's origin goes. |
| `assets[].hinge`, `assets[].leafBounds` | `door`: hinge axis +Y, `closedAngle` 0, `openAngle` π/2, inward swing (+90° turns the leaf from +X to −Z). `leafBounds` is in the door's frame. |
| `assets[].roof` | Roof modules: `span`, `pitchDegrees`, `eaveOverhang`, `length`, `wallTop`, `ridgeTop`, `eaveHeight` (and `vergeOverhang` on the verge). |
| `assets[].variants` | Roof modules: `default` (shingle) and `slate`, with the same geometry. |
| `assets[].smoke` | `chimney`: the `smoke` node and its position. |
| `compositions` | `house` and `smithy`: `{ footprint, items[] }` (above). |

`collisionProxies` are axis-aligned boxes `{ name, tag, center, size }` in the module's frame:

- `solid` for walls, corners, gables and the chimney;
- `dynamic-door` for the door leaf;
- `roof` for the roof volume above the wall top.

The doorway's jamb and lintel boxes keep the opening free. The mmorpg keeps its own colliders, and it may use, replace or ignore these proxies.

## Release

The bundle is distributed as the rolling `outpost-kit` GitHub release, whose assets are replaced in place. A consumer pins the release, the tar sha256 and its own copy of `export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It reads each module with `readAssetBundleGltf(dir, manifest, "outpost.kit.<part>", "default" | "slate")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "outpost.kit.wall", "default", "outpost-descriptor")`. CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Tests

`test/blender/kits/outpost-kit.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the bundle verify, with `default` entries for all eleven modules, `slate` entries for the three roof modules and the `wear-masks` entry;
- the descriptor conforms to the schema;
- there are exactly 20 KTX2 resources (15 maps and 5 wear masks) and no PNG, and the wear-mask entry has one `outpost-wear-<texture>` material per texture;
- every module stays within its triangle budget (`OUTPOST_TRIANGLE_BUDGET`);
- the wall modules span their 2 m or 1 m module and stay within the wall thickness;
- no vertex and no proxy reaches into the doorway, and the closed leaf fits it;
- the roof variants share their geometry, and the chimney clears the ridge;
- in both compositions, every item is a bundle entry and the walls fill every footprint edge, facing outwards;
- the door is mounted at its doorway on the +Z side.

Without `BLENDER_TESTS=1` and `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

These belong to the mmorpg side, mmorpg#420:

- choosing the two buildings;
- placing the compositions on their footprints;
- the fallback to the blockout when resources fail;
- the before/after game capture;
- native parity.

Publishing the `outpost-kit` release is also not covered here.
