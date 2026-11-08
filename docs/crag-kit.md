# Crag kit

The crag kit ([#480](https://github.com/moritzbrantner/asset-tooling/issues/480)) dresses Greyhaven's box-shaped crags and cliffs (mmorpg `highlands::CRAGS`: footprints 6–10 m wide, 8–16 m tall, two of them sheer; the Redbrand Hollow's box cliffs), which otherwise draw as plain grey boxes. It is a reproducible procedural Blender recipe, [`adapters/blender/crag.py`](../adapters/blender/crag.py), with a descriptor and a `gltf-resources-v1` bundle in one rolling release, `crag-kit` (`crag.kit.tar`, Atlas Decision 7.1.5), never a numbered one.

Gameplay owns the collision: the box stays the collider, and the modules are presentation over it. Their box `collisionProxies` serve consumers without colliders.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-crag-kit.ts --out <directory>
```

[`scripts/build-crag-kit.ts`](../scripts/build-crag-kit.ts) runs one `external.blender.script@1` job per part and level (13 modules × 3 levels and the macro texture), imports each GLB through `scene.import.gltf@2` with no validator exceptions, brings the textures to the greyhaven-terrain sizes with `scene.textures.resize.gltf@1` and encodes them to KTX2 exactly as the terrain does (`encodeKtx2` and `TERRAIN_KTX2` from [`build-greyhaven-terrain.ts`](../scripts/build-greyhaven-terrain.ts)), writes the descriptor from the recipe's observations and the measured bounds, and packs `<directory>/crag.kit.tar` with `lineage.json`, `descriptor.json` and `export.ref.json`. It needs KTX-Software's `ktx` CLI (`ASSET_TOOLING_KTX`, or `ktx` on PATH) and the hydrated scans:

```sh
git lfs pull --include="assets/canonical/poly-haven.rock-face-03-*/**,assets/canonical/poly-haven.rock-boulder-dry-diff-2k-jpg/**,assets/canonical/poly-haven.mossy-rock-diff-2k-jpg/**"
```

Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there. CI publishes the release when a change to its sources merges (`ROLLING_RELEASES` in [`scripts/publish-release.ts`](../scripts/publish-release.ts)); `gh workflow run publish-releases.yml -f release=crag-kit` republishes it.

`crag.build(part, lod, collection, inputs)` also runs in a live Blender session once `crag.use_common(runpy.run_path("adapters/blender/kit_common.py"))` has bound the shared helpers; `inputs` maps `diff`, `normal`, `arm`, `boulder` and `moss` to the scans' paths.

## Sources

All CC0 [Poly Haven](https://polyhaven.com) scans, already catalogued, stored and content-pinned (no new acquisition):

- [`rock_face_03`](https://polyhaven.com/a/rock_face_03) (`poly-haven.rock-face-03-{diff,nor-gl,arm}-2k-jpg`): the face texture of every module. It is Greyhaven's terrain rock layer (`greyhaven.terrain.rock`), so the crags match the escarpment.
- [`rock_boulder_dry`](https://polyhaven.com/a/rock_boulder_dry) (`poly-haven.rock-boulder-dry-diff-2k-jpg`) and [`mossy_rock`](https://polyhaven.com/a/mossy_rock) (`poly-haven.mossy-rock-diff-2k-jpg`): their mean colours, relative to `rock_face_03`'s, give the vertex-colour drift and moss tints and the macro texture's palette. The moss tint pushes `mossy_rock`'s mean (half grey rock) away from grey by `MOSS_CHROMA`.

## Modules

Metres, +Y up, right-handed. Every face, corner and cap module covers a 3 m cell (`CRAG_PITCH`).

| Key | Kind | Frame |
| --- | --- | --- |
| `crag.kit.face-sheer-1..3` | sheer face slab | the cell's back (z = 0) on the box face, origin at the cell's bottom centre, relief towards +Z |
| `crag.kit.face-climb-1..3` | climbable face slab | as above |
| `crag.kit.corner-sheer-1/2` | sheer edge column, 3 m tall | the vertical box edge on +Y through the origin; the box fills x < 0, z < 0 |
| `crag.kit.corner-climb-1/2` | climbable edge column | as above |
| `crag.kit.cap-1/2` | rim over a top edge, 3 m long | the top edge on +X through the origin; the box fills y < 0, z < 0 |
| `crag.kit.cap-corner` | rounded top corner | the top corner at the origin; the box fills x < 0, y < 0, z < 0 |
| `crag.kit.rock-macro` | macro-variation texture | a 1 m quad on the XZ plane facing +Y, u along +X, v along +Z (as the terrain layers) |

Triangles (LOD0 / lod1 / lod2): faces 3,200 / 512 / 98, corners 2,400 / 384 / 84, caps 2,320 / 384 / 84, cap-corner 682 / 190 / 64. The modules' four KTX2 textures, which the 40 scenes share, take about 4.9 MB of the release tar; the outcrops' atlas brings it to about 20 MB. A 10 × 10 × 16 m crag takes 60 face slabs, 20 corners, 12 caps and 4 cap-corners: about 270,000 triangles if every module were at LOD0, about 43,000 at lod1.

- **Slabs, not tiles.** A face module is a rock slab that overhangs its cell by `OVERLAP` (0.5 m) on every side and sinks 0.15 m into the box along a ragged border. Neighbouring slabs interpenetrate, so their overlaps read as the joints of the rock and no cell edge or grid line shows. Inside its border a slab never drops below 6 cm off the face, so no crack opens onto the grey collider.
- **Sheer.** Smooth fracture planes (two ridges and a valley of tilted planes), a broad swell, shallow fracture steps and fine roughness, with dark vertical water streaks in `COLOR_0` and little moss. Unclimbable: no grip.
- **Climbable.** Strata 0.6–1.7 m thick whose bedding dips a little across the slab. Each stratum stands proud by its own depth, so ledges form where a stratum stands prouder than the one above; blocks along a stratum have their own depth and lean and are divided by slanted joints; one to three wandering cracks run through several strata. Moss collects on the ledges.
- **Corners** are slabs bent round the edge (radius 0.25 m) with 1.2 m arms, a little prouder than the faces, so they read as one rounded edge over the face slabs' ends.
- **Caps** curl 0.9 m down the face and 1.4 m back over the top, about 0.3 m proud at the edge and sinking into the top at the back; the walkable top stays the box's. **Cap-corner** is a lumpy rounded box corner that reaches 0.42 m past each face and 0.32 m above the top.

### Material

One material, `crag-rock`, on every module: `rock_face_03`'s base colour, OpenGL normal and AO/roughness/metal (`arm`, also the occlusion texture) maps at one repeat per 3 m, offset and mirrored per module so neighbours don't repeat. `COLOR_0` multiplies the base colour: cavities and joints darken, recessed rock is shadowed, moss gathers on up-facing rock, sheer faces carry streaks, and a broad drift moves towards `rock_boulder_dry`. Since every module embeds the same textures, the bundle stores the three KTX2 files once.

KTX2 (`KHR_texture_basisu`, required) as the terrain encodes it (#475/#478): UASTC sRGB for base colour and UASTC linear for normals at 1024 px, ETC1S linear for the AO/roughness/metal map at 512 px, all with full mip chains.

### Rock macro variation

`crag.kit.rock-macro` is a tileable 1024 px texture (KTX2 UASTC sRGB, the base colour of a 1 m quad) to break the visible repeat of the rock texture at large world scale. Sample its base colour (sRGB-decoded, so linear) at world position / 32 m (`macro.worldMetres`): xz for the terrain's rock layer, the face-plane axes or triplanar for the crag modules. Multiply the linear base colour by 2 × its RGB: 0.5 leaves the colour unchanged. It mixes broad brightness swells (about ±18 %), patches tinted towards `rock_boulder_dry` and sparse moss-green, in periodic fractal noise.

## Layout

For an axis-aligned box W (x) by D (z) by H (y) with its base centre at the origin (`cragLayout()` in the build script is the reference implementation):

1. Split each vertical face of length L into n = max(1, round(L / 3)) columns and m = max(1, round(H / 3)) rows. For 6–16 m boxes the scales L / 3n and H / 3m stay within 0.75–1.25.
2. Place a face module of the crag's family (sheer or climb) on every cell, scaled (L / 3n, H / 3m, 1), its origin at the cell's bottom centre on the face plane and its +Z out of the box. Never repeat the variant of the cell's left or lower neighbour; mirror about half the cells (x scale −1).
3. Stack m corners of the same family on every vertical edge (scaled H / 3m in y), their +X+Z bisector out of the box.
4. Put a cap on every top cell (scaled L / 3n in x) and a cap-corner on every top corner.

A crag may mix families per face; the corners between a sheer and a climbable face may take either. The slabs overlap by design, so placement needs no extra offsets.

## Descriptor

The `crag-kit-descriptor-v1` attachment hangs on `crag.kit.face-sheer-1/default`:

- top level: `units`, `up`, `handedness`, `pitch` (3), `frames`, `layout` (the rule, the scale range and the variants of each family), `climbing`, `textures`, `macro` (`key`, `worldMetres`, `rule`), `lodSelection` and `assets`;
- each module: `key`, `role`, `family` (`sheer`, `climb` or `cap`), `kind` (`face`, `corner`, `cap`, `cap-corner`), `triangles`, `cell`, `bounds`, `collisionProxies` (boxes `{name, tag, center, size}`; `tag` is `climbable` on climbable faces and corners, `solid` elsewhere), `climb` and `lods`;
- `climb`, in the climbing kit's shape: `grip` (`rock` on climbable faces and corners, `null` on sheer ones and caps), `clips` (`Climb_*` or `null`), `approach` (`+Z`, or `+X+Z` for corners), `standOff` (0.36, the `Climb_*` clips' distance from the grip plane to the pelvis), the face plane (`face: {normal, z, width, height}` for faces, `faces` for corners, `top` and `lip` for caps) whose offset is the mean relief over the cell, `relief` (`plane` 0 and `min`, `mean`, `max` over the cell: how far the rock stands proud of the box face), `gripLine` (faces and corners), `tile` (`axes`, `pitch`, `overlap`) and, for sheer modules and caps, a `note`. Faces and corners carry the empty nodes `climb.bottom` and `climb.top` at the ends of `gripLine`;
- the macro entry: `key`, `role`, `family` and `kind` `macro`, `cell`, `bounds`, `macro` (`worldMetres`, `edge`, `mean`, `min`, `max` of the stored halved multipliers).

## Levels of detail

Every module ships `default` (LOD0), `lod1` and `lod2` as bundle variants in the same frame, built by the same recipe at `lod` 1 and 2: the relief sampled on a 0.1 m, 0.25 m and 0.6 m grid (the cap-corner on 14 × 28, 8 × 14 and 5 × 8 segments). The descriptor carries the greyhaven-nature [#449 LOD metadata](greyhaven-nature-bundle.md#lod-metadata): `lodSelection` plus per module `lods: { boundingSphere, levels: [{ variant, triangles, minScreenSize, referenceMaxDistance }] }`. Switch points are 40 m and 120 m at a 60° vertical FOV (`CRAG_LOD_DISTANCES`). The macro texture has only `default`.

## Outcrops

`crag.kit.outcrop-*` are freestanding rocks for spots no box dresses: buttresses, spires and the talus blocks beside them. They replace the look of low-poly rock drawn straight from its collision, such as mmorpg's basin and brook buttresses (`BASIN_ROCKS`, `WESTERN_ROCKS`). As with the box modules, the consumer keeps its collider.

| Key | Radii x × z (m) | Height (m) | LOD0 triangles | Baked maps |
| --- | --- | --- | --- | --- |
| `crag.kit.outcrop-buttress-1` | 3.9 × 4.7 | 14.0 | 9,000 | 2048 px |
| `crag.kit.outcrop-buttress-2` | 3.1 × 3.9 | 11.0 | 7,500 | 2048 px |
| `crag.kit.outcrop-spire` | 2.6 × 2.8 | 13.2 | 7,000 | 2048 px |
| `crag.kit.outcrop-talus-1` | 1.8 × 2.2 | 5.2 | 3,500 | 1024 px |
| `crag.kit.outcrop-talus-2` | 1.3 × 1.6 | 3.4 | 2,500 | 1024 px |

The baked-map column is each rock's area of the shared atlas.

- **Shape.** [`adapters/blender/cliff_outcrop.py`](../adapters/blender/cliff_outcrop.py) gives each height of a polar grid a radius. Dipping strata carry their own sets of fracture planes, so each has flat faces and sharp arrises and stands proud of or back from its neighbours, with cracks along the bedding and vertical joints. Ridged noise roughens the surface, and angular rubble gathers at the foot.
- **Top and foot.** The foot spreads into a low apron and the fractures fade out towards it. It blends from rock through gravel to grass along noisy edges, the crown is grass over rounded shoulders, and moss and grass catch on the ledges.
- **Colour.** The blend uses the terrain's own scans (`rock_face_03`, `forrest_ground_01`, `rocks_ground_02`, plus `mossy_rock`), each divided by its mean and multiplied by mmorpg's ground palette, as the clients do, so the foot's grass matches the grass around it. The palette is `PALETTE` in the recipe. Each rock has its own bake, because the blend differs across it, but the build packs the five bakes into one atlas (4096 px colour and normal, 2048 px roughness), so every outcrop and level draws with the single material `outcrop-rock`.
- **Game mesh.** A decimated copy is UV-unwrapped and Cycles bakes the sculpt's colour, normal and roughness (half size) onto it. `lod1` and `lod2` come from `nature_lod.py`'s `decimate` at 35% and 10% and share LOD0's maps.

The descriptor's `outcrops` lists each one's `key`, `role`, `triangles`, `bounds`, `bury`, `fit` and `lods`. The origin is on the ground at the footprint centre, +Y up, and the foot runs `bury` (0.9 m) below y = 0 so it meets uneven ground. Scale an outcrop to its site's footprint and height; `fit` holds the unscaled radii, height and lean.

To shape one, run the recipe in a live Blender: `sculpt(name, part, collection)` builds the high-resolution rock, `sculpt_material(name, inputs)` its material. Raise `CELL` for quick looks.

## Review

Shaped and reviewed in the live Blender (`blender`) with the layout rule on 8 × 7 × 12 m climbable, 10 × 6 × 9 m sheer and 6 × 6 × 16 m climbable boxes, from 30 m and at eye level.

Known gaps: the face relief is a height field over the box face, so it has no true overhangs; the climbable strata read as blocky sandstone; slabs of neighbouring cells meet at different LODs without stitching (the overlaps hide it); the macro texture is not applied by the modules' own glTF material, which has a single UV set, so a consumer shader samples it.
