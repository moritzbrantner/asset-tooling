# Greyhaven nature bundle

The dedicated `greyhaven-nature` rolling release supplies the tree and rock families requested by [asset-tooling#270](https://github.com/moritzbrantner/asset-tooling/issues/270) for [mmorpg#49](https://github.com/moritzbrantner/mmorpg/issues/49). It follows Decisions 3.1.1–3.1.2: the approved CC0 Quaternius Stylized Nature MegaKit, in the humanlike-world style. The game owns world placement, collision and gameplay.

| Stable key | Canonical archive member | Triangles |
| --- | --- | --- |
| `greyhaven.nature.tree.broadleaf` | `glTF/CommonTree_1.gltf` (trunk; crown rebuilt) | 7,217 |
| `greyhaven.nature.tree.conifer` | `glTF/Pine_1.gltf` (trunk; crown rebuilt) | 7,247 |
| `greyhaven.nature.rock.1` | `glTF/Rock_Medium_1.gltf` | 342 |
| `greyhaven.nature.rock.2` | `glTF/Rock_Medium_2.gltf` | 244 |
| `greyhaven.nature.rock.3` | `glTF/Rock_Medium_3.gltf` | 522 |

Each entry uses variant `default`, metres, right-handed +Y up and a footprint-base-centre origin. The rocks have three independently authored source meshes. No placement rules, procedural generation or authoritative colliders are included.

## Broadleaf crown

The owner kept the broadleaf's trunk but rejected its leaves ([#446](https://github.com/moritzbrantner/asset-tooling/issues/446), mmorpg#49.Q2). [`adapters/blender/broadleaf_crown.py`](../adapters/blender/broadleaf_crown.py) keeps the source bark primitive (4,345 triangles) and replaces the leaf cards:

- leaf clumps sit on the source trunk's branch tips, plus a crowning clump and a heart clump on the leader;
- a decimated metaball union of the clumps, shrunk inward, is an opaque dark core (`Leaves_Core`, 672 triangles), so no sky or bare branches show through;
- 1,100 leaf cards (2,200 triangles, `Leaves_NormalTree`, alpha `MASK`) cover the core, mostly facing outward. Their image is the source leaf cluster turned into a bright greyscale mask, so the colour comes from `COLOR_0`;
- each card's normals bend towards the crown volume, so it shades as soft foliage, not as flat planes;
- each card's `COLOR_0` runs from deep cool green inside and underneath to warm yellow-green on the sunny top, with a per-clump tint and per-card hue and value jitter.

The seed (446) and card count are `BROADLEAF_CROWN` in the build script. Translucency is not authored: core glTF has none, and the game's three.js `GLTFLoader` path renders `MeshStandardMaterial`.

## Conifer crown

The owner chose detail everywhere at the reworked broadleaf's standard (mmorpg#49.Q3, [#450](https://github.com/moritzbrantner/asset-tooling/issues/450)). [`adapters/blender/conifer_crown.py`](../adapters/blender/conifer_crown.py) keeps Pine_1's bark primitive (3,177 triangles), measures its leaf primitive (crown base and top, radius profile around the trunk axis), and replaces the leaves:

- whorls of drooping branches climb the source trunk, closer together towards the leader; branch length follows the source crown's radius at that height, so the silhouette stays Pine_1's;
- each whorl has an opaque, closed skirt (`Leaves_Core`, 672 triangles in all): a shallow cone on top and a dark hollow underneath that steps in to the whorl below, so no sky shows between whorls and each tier casts its own shadow band;
- about 1,700 fir sprig cards (3,398 triangles, `Leaves_Pine`, alpha `MASK`): along each branch, stem towards the trunk, fanned and rolled; lying on each skirt; as a fringe over each skirt's rim; and upright around the leader;
- the sprig image is four fir sprigs cut from the CC0 Poly Haven [`fir_tree_01`](https://polyhaven.com/a/fir_tree_01) twig atlas (colour and alpha, catalogued as `poly-haven.fir-tree-01-twig-{diff,alpha}-2k-jpg`), turned into a bright greyscale mask at 1024 px, so the colour comes from `COLOR_0`;
- each card's `COLOR_0` runs from deep cool green inside the crown, low down and under each tier, to warm yellow-green at the sunlit branch tips and the top, with a per-branch tint and per-card hue and value jitter. Card normals bend up and out of the crown.

The seed (450) and card count (1,700) are `CONIFER_CROWN` in the build script. The palette, skirt share (`SKIRT_REACH`) and rim fringe (`RIM_CARDS`) are constants at the top of the recipe. LOD chains for both trees follow in [#449](https://github.com/moritzbrantner/asset-tooling/issues/449).

## Build and provenance

From a hydrated checkout with Bun, FFmpeg (the existing PNG codec) and Blender 5.2.2 (`adapters/blender/release.json`) for the tree crowns:

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-nature.ts --out .artifacts/greyhaven-nature
bun scripts/pack-asset-bundle.ts --verify .artifacts/greyhaven-nature/greyhaven.nature.tar --ref .artifacts/greyhaven-nature/export.ref.json
```

This builds offline through catalog storage import → production glTF import (the existing `gltf-color-clamp-v1` repair) → for each tree, its `external.blender.script@1` crown recipe (the conifer's also reads the two fir texture sources) and a second production import → footprint placement → texture resize → `gltf-resources-v1` bundle export → tar packing. Source acquisition remains a separate explicit operation. Every source is reverified against its catalog hash before import.

Colour, emissive and normal images have maximum edge 1024; ORM/occlusion images 512. Existing smaller images are not upscaled. PNG keeps compatibility with both consumers and shared images are deduplicated by the bundle exporter. The initial five-entry tar is about 4.3 MB (decimal); this is a measurement, not a size gate.

The archive pin and license evidence are recorded in [the source documentation](greyhaven-starter-sources.md). #270 adds only `Rock_Medium_2.{gltf,bin}` and `Rock_Medium_3.{gltf,bin}` (33,213 bytes total) to the same canonical LFS source collection. Both use the already-stored `Rocks_Diffuse.png`. The starter bundle's membership stays unchanged.

The `greyhaven-nature-descriptor-v1` attachment, named `nature-descriptor` on `greyhaven.nature.tree.broadleaf/default`, records per-member bounds, footprint, family/shape and provenance-bearing source/resource refs. `lineage.json` exposes the same descriptor beside the build. No collision proxies are prescribed.

## Review and delivery

Inspect the current bundle with the existing Blender composition review:

```sh
blender --background --factory-startup --python examples/greyhaven-kit/render-composition.py -- .artifacts/greyhaven-nature/bundle examples/greyhaven-nature/review.json .artifacts/greyhaven-nature/review.png
```

The composition uses the unscaled metre-sized meshes. Consumer review at gameplay scale accompanies mmorpg#49; a producer import check alone does not establish gameplay visual quality.

CI publishes `greyhaven.nature.tar`, its `.sha256`, `export.ref.json` and `lineage.json` on the single rolling `greyhaven-nature` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). Consumers intentionally adopt a replacement by pinning the release asset URL, tar SHA-256 and content-only export ref, as described in [asset bundles](asset-bundles.md#release-distribution-and-consumer-pinning). Existing published starter releases are unaffected.

`test/blender/kits/greyhaven-nature.test.ts` (the hosted Blender kits job, which hydrates the nature payloads) verifies the real packed bundle, resource closure, texture dimensions, grounded/centred meshes, three distinct rock vertex sets, the rebuilt broadleaf and conifer crowns and provenance from hydrated sources. It skips visibly without Blender or on LFS pointers.
