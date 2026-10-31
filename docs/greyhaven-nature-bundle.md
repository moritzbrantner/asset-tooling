# Greyhaven nature bundle

The dedicated `greyhaven-nature` rolling release supplies the tree, rock and bush families requested by [asset-tooling#270](https://github.com/moritzbrantner/asset-tooling/issues/270) for [mmorpg#49](https://github.com/moritzbrantner/mmorpg/issues/49). It follows Decisions 3.1.1–3.1.2: the approved CC0 Quaternius Stylized Nature MegaKit, in the humanlike-world style. The game owns world placement, collision and gameplay.

| Stable key | Source | Triangles |
| --- | --- | --- |
| `greyhaven.nature.tree.broadleaf` | `glTF/CommonTree_1.gltf` (trunk; crown rebuilt) | 7,217 |
| `greyhaven.nature.tree.conifer` | `glTF/Pine_1.gltf` (trunk; crown rebuilt) | 7,115 |
| `greyhaven.nature.rock.1` | `nature_rock.py`, `stratified` (3.2 × 3.0 m, 2.2 m tall) | 2,000 |
| `greyhaven.nature.rock.2` | `nature_rock.py`, `boulder` (3.0 × 2.5 m, 1.9 m tall) | 2,000 |
| `greyhaven.nature.rock.3` | `nature_rock.py`, `slab` (3.4 × 3.4 m, 2.3 m tall) | 2,000 |
| `greyhaven.nature.bush.1` | `nature_bush.py`, `round` (1.4 × 1.3 m, 1.0 m tall) | 606 |
| `greyhaven.nature.bush.2` | `nature_bush.py`, `spreading` (1.7 × 1.4 m, 0.85 m tall) | 670 |
| `greyhaven.nature.bush.3` | `nature_bush.py`, `upright` (1.1 × 1.0 m, 1.3 m tall) | 564 |

Each entry uses variant `default` (LOD0), metres, right-handed +Y up and a footprint-base-centre origin, and ships an LOD chain as variants `lod1` and `lod2` in the same frame ([Levels of detail](#levels-of-detail)). No placement rules or authoritative colliders are included; the rocks carry a convex-hull collision proxy that a consumer may use ([Rocks](#rocks)).

## Broadleaf crown

The owner kept the broadleaf's trunk but rejected its leaves ([#446](https://github.com/moritzbrantner/asset-tooling/issues/446), mmorpg#49.Q2). [`adapters/blender/broadleaf_crown.py`](../adapters/blender/broadleaf_crown.py) keeps the source bark primitive (4,345 triangles) and replaces the leaf cards:

- leaf clumps sit on the source trunk's branch tips, plus a crowning clump and a heart clump on the leader;
- a decimated metaball union of the clumps, shrunk inward, is an opaque dark core (`Leaves_Core`, 672 triangles), so no sky or bare branches show through;
- 1,100 leaf cards (2,200 triangles, `Leaves_NormalTree`, alpha `MASK`) cover the core, mostly facing outward. Their image is the source leaf cluster turned into a bright greyscale mask, so the colour comes from `COLOR_0`;
- each card's normals bend towards the crown volume, so it shades as soft foliage, not as flat planes;
- each card's `COLOR_0` runs from deep cool green inside and underneath to warm yellow-green on the sunny top, with a per-clump tint and per-card hue and value jitter.

The seed (446) and card count are `BROADLEAF_CROWN` in the build script. Translucency is not authored: core glTF has none, and the game's three.js `GLTFLoader` path renders `MeshStandardMaterial`.

## Conifer crown

The owner chose detail everywhere at the reworked broadleaf's standard (mmorpg#49.Q3, [#450](https://github.com/moritzbrantner/asset-tooling/issues/450)); pass 2 ([#454](https://github.com/moritzbrantner/asset-tooling/issues/454)) made it a solid, dark fir with readable tiers. [`adapters/blender/conifer_crown.py`](../adapters/blender/conifer_crown.py) (`conifer-crown-v2`) measures Pine_1's leaf primitive (crown base and top, radius profile around the trunk axis) and replaces the leaves:

- the trunk is Pine_1's bark primitive with the bare branch stubs around the crown base cut (809 triangles), so a clean trunk shows below the first tier;
- seven drooping tiers climb the trunk, widest at the bottom and closer together towards the leader; each tier's reach follows the source crown's radius at that height, is lobed between its branches, and has a slight tilt and droop wobble so no two tiers are the same disc;
- each tier has an opaque, closed skirt (`Leaves_Core`, 504 triangles in all): a drooping cone, a dark rim band, and a hollow underneath that reaches down to the tier below, so no sky shows through the crown and each tier has a shadow band under it;
- 2,900 fir sprig cards (5,802 triangles, `Leaves_Pine`, alpha `MASK`): lying on each skirt's top pointing downslope, hanging over each rim as a darker fringe, spraying out past the rim at the branch tips, and upright around the leader;
- the sprig image is four fir sprigs cut from the CC0 Poly Haven [`fir_tree_01`](https://polyhaven.com/a/fir_tree_01) twig atlas (colour and alpha, catalogued as `poly-haven.fir-tree-01-twig-{diff,alpha}-2k-jpg`), turned into a greyscale mask at 1024 px, so the colour comes from `COLOR_0`. The alpha is closed (gaps between needles filled), so a sprig stays a solid fan in the `MASK` cut-out and keeps its coverage as the texture mips down;
- every card carries the skirt's smooth normal (lit tier tops, shaded rims), like the broadleaf's cards, and a `COLOR_0` that runs from deep green under and inside each tier to saturated green on the tier tops, lighter towards the outer edges and the top, with per-card hue and value jitter.

The seed (454) and card count (2,900) are `CONIFER_CROWN` in the build script. The palette, tier count (`TIERS`), trunk clearance (`CROWN_FLOOR`), stub cut (`STUB_REACH`), skirt share (`SKIRT_REACH`) and card shares are constants at the top of the recipe. Its far versions are in [Levels of detail](#levels-of-detail).

## Rocks

The rocks are authored at the same detail standard ([#451](https://github.com/moritzbrantner/asset-tooling/issues/451), mmorpg#49.Q3), replacing the Quaternius `Rock_Medium_1..3` blobs. [`adapters/blender/nature_rock.py`](../adapters/blender/nature_rock.py) (`nature-rock-v1`) builds each rock from its shape, seed and size (`NATURE_MEMBERS` in the build script):

- **Shape.** Fracture planes cut a convex block from an ellipsoid, with a flat base (and, for `stratified`, a nearly level top). Planar chips are knocked off its edges and corners. The block is voxel-remeshed (2.2 cm) into a sculpt and displaced: bedding layers along a tilted axis, each one inset or proud of its neighbours with a crack at every joint (`stratified` near-level, `boulder` 35°, `slab` 58°), ridged weathering and a broad wobble. The lowest layer meets the ground without a plinth. The sculpt is fitted to the requested size;
- **Material.** The sculpt carries a box-projected CC0 Poly Haven [`rock_boulder_dry`](https://polyhaven.com/a/rock_boulder_dry) material (colour, height as bump, roughness), graded to a cool grey. Moss and lichen from [`mossy_rock`](https://polyhaven.com/a/mossy_rock), tinted towards the trees' greens, cover the up-facing faces in noise patches (`moss` per shape). The base turns earthy and the cavities darken (ambient occlusion);
- **Game mesh.** A decimated copy of about `ROCK_TRIANGLES` (2,000) triangles is UV-unwrapped, and Cycles bakes the sculpt's colour, tangent-space normal and roughness onto it at 1024 px. Each rock is one mesh with one material (base colour, normal and metallic-roughness maps).

The textures are catalogued as `poly-haven.rock-boulder-dry-{diff,disp,rough}-2k-jpg` and `poly-haven.mossy-rock-diff-2k-jpg`. The per-shape controls (cuts, bedding tilt, layer thickness and inset, crack and chip depth, weathering, moss, rounding, cap) and the colour grade are constants at the top of the recipe.

### Collision proxy

Each rock's descriptor entry carries `collisionProxy` (the build script exports the field name as `NATURE_COLLISION_PROXY`), for consumers such as mmorpg#577:

```json
{ "shape": "convex-hull", "vertices": [[x, y, z], ...], "triangles": [[a, b, c], ...] }
```

- `vertices` are metres in the rock's own glTF frame (+Y up, footprint-base-centre origin, the same frame as the mesh), rounded to 0.1 mm;
- `triangles` index `vertices` and are wound counter-clockwise seen from outside (outward normals);
- the hull is the convex hull of the game mesh's support points in 48 evenly spread directions: at most 48 vertices and 92 triangles (the current rocks: 29–43 vertices, 54–82 triangles). It sits on or just inside the mesh's own convex hull, so it never pokes out of the rock.

Scale and place it with the same transform as the rock. The proxy is presentation metadata: the consumer still owns physics and may use, replace or ignore it.

## Bushes

The bushes are authored at the reworked broadleaf's standard ([#462](https://github.com/moritzbrantner/asset-tooling/issues/462), mmorpg#49.Q3), to replace the game's procedural low-poly blobs. Greyhaven scatters about 800 of them (mmorpg's scenery, at 0.7–1.3 scale), so each one is small. [`adapters/blender/nature_bush.py`](../adapters/blender/nature_bush.py) (`nature-bush-v1`) builds each bush from its shape, seed, size and card count (`NATURE_MEMBERS` in the build script):

- **Clumps.** Seeded leaf clumps fill an ellipsoid of the requested size, narrowing towards the top so the bush domes. A heart clump sits low in the middle, so the bush meets the ground. `round` uses 9 clumps, `spreading` 11 lower ones and `upright` 8 that climb higher (`SHAPES`);
- **Core.** A metaball union of the clumps is cut flat at the ground, decimated to about 145 triangles (`Leaves_Core`) and fitted inside the size less the cards' overhang. It is dark and vertex-coloured, so neither ground nor sky shows through the leaves;
- **Cards.** 210–260 leaf cards (`Leaves_Bush`, alpha `MASK`, 420–520 triangles) lie over the core, mostly facing outward, at three depths. Their image is the broadleaf's: the same CC0 Quaternius leaf cluster (`Leaves_NormalTree_C.png`, catalogued as `quaternius.stylized-nature-megakit-standard.leaves-normaltree-c-png`) turned into the same greyscale mask, so the colour comes from `COLOR_0`;
- **Shading and colour.** Each card's normals bend towards the bush volume (soft foliage shading). Its `COLOR_0` uses the broadleaf's palette: deep and cool near the ground, inside and underneath, warm yellow-green on the sunny top, darker for cards tucked into the core, with a per-clump tint and per-card hue and value jitter.

Each bush is one mesh node with two primitives (core and cards) and no bark. The final fit to the size stays within about 10 % of 1, so the cards keep their shape. The palette, shapes, core size (`CORE_FACES`), card size (`CARD_SIZE`) and ground darkening (`GROUND_DARK`) are constants at the top of the recipe. A bush's LOD0 budget is `BUSH_TRIANGLES` (700).

The bundle has no grass tufts or other ground cover: Greyhaven's 6,700 grass tufts are still the game's procedural ones.

## Levels of detail

The owner chose detail everywhere with low-poly versions for the distance (mmorpg#49.Q3, [#449](https://github.com/moritzbrantner/asset-tooling/issues/449)). Every member ships three levels as variants of its bundle entry. [`adapters/blender/nature_lod.py`](../adapters/blender/nature_lod.py) (`nature-lod-v1`) builds `lod1` and `lod2` from the placed, resized LOD0. They keep its frame, node name and materials, so a consumer swaps the variant in place with the same transform.

| Member | `default` (LOD0) | `lod1` | `lod2` |
| --- | --- | --- | --- |
| broadleaf | 7,217 | 2,708: bark decimated, core kept, 32 % of the leaf cards grown to keep coverage | 785: an opaque clump hull, no cards |
| conifer | 7,115 | 2,690: the same thinning | 720: an opaque tiered envelope, no cards |
| each rock | 2,000 | 700: edge-collapse, 512 px maps | 200: edge-collapse, 256 px maps |
| each bush | 564–670 | 316–348: core kept, 40 % of the leaf cards grown to keep coverage | 120: an opaque clump hull, no cards |

- **Tree `lod1`** (`thin`). The opaque core stays. A seeded 32 % of the cards stays, each grown about its centre by `grow / sqrt(keep)`, so the crown keeps its coverage, outline and colour. Every kept card keeps its bent normals, UVs and `COLOR_0`. The bark is decimated (broadleaf to 30 %, conifer to 40 %).
- **Broadleaf `lod2`** (`hull`). The core is pushed out along its normals to where the cards sit, so the clump lobes stay. It is then fitted band by band to the cards' reach around the trunk.
- **Conifer `lod2`** (`envelope`). This is a closed surface of revolution, 28 bands of 12 sectors. Its radius in each band and sector follows the sprigs' reach, so the tier notches stay in the outline.
- **Far-tree colour.** Each far shell vertex takes the mean colour of its eight nearest cards (`COLOR_0` times the card image's mean grey). That colour is mixed 40 % with the nearest core colour, because LOD0's core shows between the cards. Downward faces are darkened, so the shadow bands under the clumps and tiers stay. A gain is tuned so that the rendered mean colour matches LOD0. The shell uses the `Leaves_Core` material: opaque, vertex-coloured, with no texture.
- **Far-tree bark.** Bark wholly inside the shell is removed and the rest is decimated.
- **Bushes.** `lod1` thins like the trees (40 % of the cards, grown by `0.8 / sqrt(keep)`); the core stays whole, so `lod1` keeps about half of LOD0's triangles. `lod2` is the broadleaf's `hull`, pushed out further (`inflate` 2.2, since a bush's cards sit close to its core) and decimated to 120 triangles, with the same far colour. A bush has no bark, so its level arguments leave `barkRatio` out.
- **Rocks** (`decimate`). The weld and edge-collapse keep the baked UVs, so the levels reuse LOD0's bakes, resized to 512 px and then 256 px (roughness 256 px and 128 px). The tree levels share LOD0's images byte for byte.

The arguments are `NATURE_LOD_RECIPES` in the build script. The levels add about 3.9 MB to the tar (13.2 MB to 17.1 MB, decimal). Most of that is the rocks' 512 px `lod1` maps; the trees' levels add only their geometry.

### LOD metadata

The descriptor has one top-level `lodSelection` block, and each asset entry carries `lods`:

```json
"lodSelection": { "metric": "projected-bounding-sphere-height-fraction", "referenceFovYDegrees": 60, "rule": "..." },
"assets": [{ "key": "greyhaven.nature.tree.broadleaf", "lods": {
  "boundingSphere": { "center": [0, 4.12, 0], "radius": 5.73 },
  "levels": [
    { "variant": "default", "triangles": 7217, "minScreenSize": 0.5,  "referenceMaxDistance": 19.84 },
    { "variant": "lod1",    "triangles": 2708, "minScreenSize": 0.12, "referenceMaxDistance": 82.68 },
    { "variant": "lod2",    "triangles": 785,  "minScreenSize": 0,    "referenceMaxDistance": null }
  ] } }]
```

- **Screen size** is the bounding sphere's projected diameter divided by the viewport height: `s = radius * scale / (distance * tan(fovY / 2))`. Here `distance` runs from the camera to the transformed sphere centre and `scale` is the instance's uniform scale.
- **Choosing a level.** Walk `levels` in order and use the first one whose `minScreenSize <= s`. The last level has `minScreenSize` 0. three.js's `LOD.addLevel(object, distance)` takes distances: use `radius * scale / (minScreenSize * tan(fovY / 2))` for each level after the first, recomputed when the FOV changes.
- **`referenceMaxDistance`** is the distance in metres at which a level ends, for an unscaled instance at a 60° vertical FOV. It is a convenience; the screen size is the contract.
- **Switch points.** Trees use 0.5 and 0.12; rocks use 0.3 and 0.1; bushes use 0.25 and 0.08 (about 7.5 m and 23 m for an unscaled round bush) (`NATURE_LOD_SCREEN_SIZES`). A quality or "model detail" setting (settings#25) may scale every `minScreenSize` by one bias factor. A larger factor switches sooner.
- **Hysteresis.** To avoid flicker at a boundary, a consumer may add hysteresis (for example 10 % of the switch size) or a short dithered cross-fade. The bundle doesn't prescribe either.
- **Triangles** are counted from the shipped primitives of each level.

### Review: popping

Each chain was rendered side by side, and each switch was rendered at its exact switch distance: a 60° vertical FOV at 1280×720, from a raised third-person camera, with level n and level n+1 compared. What remains visible:

- **Rocks.** No visible pop at either switch. The baked normal maps carry the detail lost by the collapse. About 0.3–0.5 % of the frame's pixels change noticeably at the near switch, and about 0.05 % at the far one. Most of that is the shadow edge.
- **Tree `lod0` → `lod1` (about 19–20 m).** A slight pop. The cards are visibly larger, and the crown reads a little coarser and more open at the top. The outline, size and mean colour hold (within 3 %).
- **Tree `lod1` → `lod2` (about 80 m).** The crown loses its leaf speckle and becomes a smooth, shaded mass. The outline and mean colour hold (broadleaf within 3 %, conifer within 8 %, slightly lighter). The conifer's lowest tier also reads as a wider, flatter skirt than LOD0's drooping fringe. At 0.2 (about 50 m) this was an obvious pop, so the switch was moved out to 0.12, where the tree is about 85 px tall at 720p and the change is small but still visible on close inspection. A consumer that wants no visible switch should cross-fade over a band.
- **Bush `lod0` → `lod1` (about 7.5 m).** A slight pop: fewer, larger cards, a little coarser; the outline, size and colour hold.
- **Bush `lod1` → `lod2` (about 23 m, about 60 px tall at 720p).** The leaf speckle goes and the bush becomes a smooth, slightly lighter and slightly smaller lumpy mass. It is visible when looked for. A cross-fade hides it.

## Build and provenance

From a hydrated checkout with Bun, FFmpeg (the existing PNG codec) and Blender 5.2.2 (`adapters/blender/release.json`) for the tree crowns:

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-nature.ts --out .artifacts/greyhaven-nature
bun scripts/pack-asset-bundle.ts --verify .artifacts/greyhaven-nature/greyhaven.nature.tar --ref .artifacts/greyhaven-nature/export.ref.json
```

This builds offline through catalog storage import → production glTF import (the existing `gltf-color-clamp-v1` repair) → for each tree, its `external.blender.script@1` crown recipe (the conifer's also reads the two fir texture sources) and a second production import; for each rock, `nature_rock.py` with the four rock and moss texture sources and a production import; for each bush, `nature_bush.py` with the leaf-cluster source and a production import → footprint placement → texture resize → for each level, `nature_lod.py` on the result, a production import and a texture resize → `gltf-resources-v1` bundle export → tar packing. Source acquisition remains a separate explicit operation. Every source is reverified against its catalog hash before import.

Colour, emissive and normal images have maximum edge 1024; ORM/occlusion images 512. Existing smaller images are not upscaled. PNG keeps compatibility with both consumers and shared images are deduplicated by the bundle exporter. The tar is about 17.1 MB (decimal) since #449. Each rock adds its own 1024 px colour and normal maps and a 512 px roughness map (#451), plus the same maps at a half and a quarter of that size for its levels. This is a measurement, not a size gate.

The archive pin and license evidence are recorded in [the source documentation](greyhaven-starter-sources.md). #270 adds only `Rock_Medium_2.{gltf,bin}` and `Rock_Medium_3.{gltf,bin}` (33,213 bytes total) to the same canonical LFS source collection. Both use the already-stored `Rocks_Diffuse.png`. The starter bundle's membership stays unchanged.

The `greyhaven-nature-descriptor-v1` attachment, named `nature-descriptor` on `greyhaven.nature.tree.broadleaf/default`, records per-member bounds, footprint, family/shape, the LOD chain (`lods`, [LOD metadata](#lod-metadata)), each rock's `collisionProxy` ([Collision proxy](#collision-proxy)) and provenance-bearing source, recipe and resource refs. `lineage.json` exposes the same descriptor beside the build.

## Review and delivery

Inspect the current bundle with the existing Blender composition review:

```sh
blender --background --factory-startup --python examples/greyhaven-kit/render-composition.py -- .artifacts/greyhaven-nature/bundle examples/greyhaven-nature/review.json .artifacts/greyhaven-nature/review.png
```

The composition uses the unscaled metre-sized meshes. Consumer review at gameplay scale accompanies mmorpg#49; a producer import check alone does not establish gameplay visual quality.

CI publishes `greyhaven.nature.tar`, its `.sha256`, `export.ref.json` and `lineage.json` on the single rolling `greyhaven-nature` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). Consumers intentionally adopt a replacement by pinning the release asset URL, tar SHA-256 and content-only export ref, as described in [asset bundles](asset-bundles.md#release-distribution-and-consumer-pinning). Existing published starter releases are unaffected.

`test/blender/kits/greyhaven-nature.test.ts` (the hosted Blender kits job, which hydrates the nature payloads) verifies the real packed bundle, resource closure, texture dimensions, grounded/centred meshes, three distinct authored rocks within the rock budget with baked PBR maps and closed convex-hull proxies inside their bounds, the rebuilt broadleaf and conifer crowns, the authored bushes (cut-out cards over a core, within the bush budget), each member's LOD chain (same frame, triangle shares, smaller rock maps, card-free far crowns and bush hulls, descriptor switch points) and provenance from hydrated sources. It skips visibly without Blender or on LFS pointers.
