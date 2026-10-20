# Greyhaven nature bundle

The dedicated `greyhaven-nature` rolling release supplies the tree and rock families requested by [asset-tooling#270](https://github.com/moritzbrantner/asset-tooling/issues/270) for [mmorpg#49](https://github.com/moritzbrantner/mmorpg/issues/49). It follows Decisions 3.1.1–3.1.2: the approved CC0 Quaternius Stylized Nature MegaKit, in the humanlike-world style. The game owns world placement, collision and gameplay.

| Stable key | Canonical archive member | Triangles |
| --- | --- | --- |
| `greyhaven.nature.tree.broadleaf` | `glTF/CommonTree_1.gltf` | 6,265 |
| `greyhaven.nature.tree.conifer` | `glTF/Pine_1.gltf` | 3,947 |
| `greyhaven.nature.rock.1` | `glTF/Rock_Medium_1.gltf` | 342 |
| `greyhaven.nature.rock.2` | `glTF/Rock_Medium_2.gltf` | 244 |
| `greyhaven.nature.rock.3` | `glTF/Rock_Medium_3.gltf` | 522 |

Each entry uses variant `default`, metres, right-handed +Y up and a footprint-base-centre origin. The rocks have three independently authored source meshes. No placement rules, procedural generation or authoritative colliders are included.

## Build and provenance

From a hydrated checkout with Bun and FFmpeg (the existing PNG codec):

```sh
bun scripts/build-greyhaven-nature.ts --out .artifacts/greyhaven-nature
bun scripts/pack-asset-bundle.ts --verify .artifacts/greyhaven-nature/greyhaven.nature.tar --ref .artifacts/greyhaven-nature/export.ref.json
```

This builds offline through catalog storage import → production glTF import (the existing `gltf-color-clamp-v1` repair) → footprint placement → texture resize → `gltf-resources-v1` bundle export → tar packing. Source acquisition remains a separate explicit operation. Every source is reverified against its catalog hash before import.

Colour, emissive and normal images have maximum edge 1024; ORM/occlusion images 512. Existing smaller images are not upscaled. PNG keeps compatibility with both consumers and shared images are deduplicated by the bundle exporter. The initial five-entry tar is about 4.3 MB (decimal); this is a measurement, not a size gate.

The archive pin and license evidence are recorded in [the source documentation](greyhaven-starter-sources.md). #270 adds only `Rock_Medium_2.{gltf,bin}` and `Rock_Medium_3.{gltf,bin}` (33,213 bytes total) to the same canonical LFS source collection. Both use the already-stored `Rocks_Diffuse.png`. The starter bundle's membership stays unchanged.

The `greyhaven-nature-descriptor-v1` attachment, named `nature-descriptor` on `greyhaven.nature.tree.broadleaf/default`, records per-member bounds, footprint, family/shape and provenance-bearing source/resource refs. `lineage.json` exposes the same descriptor beside the build. No collision proxies are prescribed.

## Review and delivery

Inspect the current bundle with the existing Blender composition review:

```sh
blender --background --factory-startup --python examples/greyhaven-kit/render-composition.py -- .artifacts/greyhaven-nature/bundle examples/greyhaven-nature/review.json .artifacts/greyhaven-nature/review.png
```

The composition uses the unscaled metre-sized meshes. Consumer review at gameplay scale accompanies mmorpg#49; a producer import check alone does not establish gameplay visual quality.

Publish `greyhaven.nature.tar`, its `.sha256`, `export.ref.json` and `lineage.json` on the single rolling `greyhaven-nature` release after the recipe merges. Consumers intentionally adopt a replacement by pinning the release asset URL, tar SHA-256 and content-only export ref, as described in [asset bundles](asset-bundles.md#release-distribution-and-consumer-pinning). Existing published starter releases are unaffected.

`test/greyhaven-nature.test.ts` verifies the real packed bundle, resource closure, texture dimensions, grounded/centred meshes, three distinct rock vertex sets and provenance from hydrated sources. It skips visibly on LFS pointers, and fails closed under `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`.
