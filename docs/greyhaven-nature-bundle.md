# Greyhaven nature bundle

The dedicated `greyhaven-nature` rolling release supplies the tree and rock families requested by [asset-tooling#270](https://github.com/moritzbrantner/asset-tooling/issues/270) for [mmorpg#49](https://github.com/moritzbrantner/mmorpg/issues/49). It follows Decisions 3.1.1–3.1.2: the approved CC0 Quaternius Stylized Nature MegaKit, in the humanlike-world style. The game owns world placement, collision and gameplay.

| Stable key | Source | Triangles |
| --- | --- | --- |
| `greyhaven.nature.tree.broadleaf` | `glTF/CommonTree_1.gltf` (trunk; crown rebuilt) | 7,217 |
| `greyhaven.nature.tree.conifer` | `glTF/Pine_1.gltf` (trunk; crown rebuilt) | 7,115 |
| `greyhaven.nature.rock.1` | `nature_rock.py`, `stratified` (3.2 × 3.0 m, 2.2 m tall) | 2,000 |
| `greyhaven.nature.rock.2` | `nature_rock.py`, `boulder` (3.0 × 2.5 m, 1.9 m tall) | 2,000 |
| `greyhaven.nature.rock.3` | `nature_rock.py`, `slab` (3.4 × 3.4 m, 2.3 m tall) | 2,000 |

Each entry uses variant `default`, metres, right-handed +Y up and a footprint-base-centre origin. No placement rules or authoritative colliders are included; the rocks carry a convex-hull collision proxy that a consumer may use ([Rocks](#rocks)).

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

The seed (454) and card count (2,900) are `CONIFER_CROWN` in the build script. The palette, tier count (`TIERS`), trunk clearance (`CROWN_FLOOR`), stub cut (`STUB_REACH`), skirt share (`SKIRT_REACH`) and card shares are constants at the top of the recipe. LOD chains for both trees follow in [#449](https://github.com/moritzbrantner/asset-tooling/issues/449).

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

## Build and provenance

From a hydrated checkout with Bun, FFmpeg (the existing PNG codec) and Blender 5.2.2 (`adapters/blender/release.json`) for the tree crowns:

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-nature.ts --out .artifacts/greyhaven-nature
bun scripts/pack-asset-bundle.ts --verify .artifacts/greyhaven-nature/greyhaven.nature.tar --ref .artifacts/greyhaven-nature/export.ref.json
```

This builds offline through catalog storage import → production glTF import (the existing `gltf-color-clamp-v1` repair) → for each tree, its `external.blender.script@1` crown recipe (the conifer's also reads the two fir texture sources) and a second production import; for each rock, `nature_rock.py` with the four rock and moss texture sources and a production import → footprint placement → texture resize → `gltf-resources-v1` bundle export → tar packing. Source acquisition remains a separate explicit operation. Every source is reverified against its catalog hash before import.

Colour, emissive and normal images have maximum edge 1024; ORM/occlusion images 512. Existing smaller images are not upscaled. PNG keeps compatibility with both consumers and shared images are deduplicated by the bundle exporter. The five-entry tar is about 13.2 MB (decimal) since #451: each rock adds its own 1024 px colour and normal maps and a 512 px roughness map. This is a measurement, not a size gate.

The archive pin and license evidence are recorded in [the source documentation](greyhaven-starter-sources.md). #270 adds only `Rock_Medium_2.{gltf,bin}` and `Rock_Medium_3.{gltf,bin}` (33,213 bytes total) to the same canonical LFS source collection. Both use the already-stored `Rocks_Diffuse.png`. The starter bundle's membership stays unchanged.

The `greyhaven-nature-descriptor-v1` attachment, named `nature-descriptor` on `greyhaven.nature.tree.broadleaf/default`, records per-member bounds, footprint, family/shape, each rock's `collisionProxy` ([Collision proxy](#collision-proxy)) and provenance-bearing source, recipe and resource refs. `lineage.json` exposes the same descriptor beside the build.

## Review and delivery

Inspect the current bundle with the existing Blender composition review:

```sh
blender --background --factory-startup --python examples/greyhaven-kit/render-composition.py -- .artifacts/greyhaven-nature/bundle examples/greyhaven-nature/review.json .artifacts/greyhaven-nature/review.png
```

The composition uses the unscaled metre-sized meshes. Consumer review at gameplay scale accompanies mmorpg#49; a producer import check alone does not establish gameplay visual quality.

CI publishes `greyhaven.nature.tar`, its `.sha256`, `export.ref.json` and `lineage.json` on the single rolling `greyhaven-nature` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). Consumers intentionally adopt a replacement by pinning the release asset URL, tar SHA-256 and content-only export ref, as described in [asset bundles](asset-bundles.md#release-distribution-and-consumer-pinning). Existing published starter releases are unaffected.

`test/blender/kits/greyhaven-nature.test.ts` (the hosted Blender kits job, which hydrates the nature payloads) verifies the real packed bundle, resource closure, texture dimensions, grounded/centred meshes, three distinct authored rocks within the rock budget with baked PBR maps and closed convex-hull proxies inside their bounds, the rebuilt broadleaf and conifer crowns and provenance from hydrated sources. It skips visibly without Blender or on LFS pointers.
