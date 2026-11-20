# Greyhaven farm animals

The `greyhaven-farm-animals` rolling release supplies a cow, a horse, a donkey, a pig, a sheep, a goat and a chicken for Greyhaven's farms and villages ([#659](https://github.com/moritzbrantner/asset-tooling/issues/659)). It follows the [ambient animals](greyhaven-ambient-animals.md) exactly: the same conventions, the same recipe shape and the same plain skinned-glTF clip convention mmorpg already loads. The game owns placement, wandering, pens, collision and everything else about behaviour.

| Key (variant `default`) | Source | Catalog source | Size in metres (W × H × D, idle) | Triangles | Joints | Idle / Walk / Eat (s) |
| --- | --- | --- | --- | --- | --- | --- |
| `greyhaven.farm.cow` | Quaternius *Ultimate Animated Animals*, `Cow.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-cow-glb` | 0.78 × 1.55 × 2.73 | 2,450 | 42 | 3.33 / 1.17 / 6.00 |
| `greyhaven.farm.horse` | Quaternius *Ultimate Animated Animals*, `Horse.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-horse-glb` | 0.53 × 1.80 × 2.12 | 2,182 | 50 | 3.33 / 1.17 / 6.00 |
| `greyhaven.farm.donkey` | Quaternius *Ultimate Animated Animals*, `Donkey.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-donkey-glb` | 0.41 × 1.40 × 1.67 | 2,000 | 50 | 3.33 / 1.17 / 6.00 |
| `greyhaven.farm.pig` | Quaternius *Farm Animals*, `Blends/Pig.blend` (CC0-1.0) | `quaternius.farm-animals-pig-blend` | 0.50 × 0.70 × 1.49 | 562 | 24 | 6.25 / 2.67 / – |
| `greyhaven.farm.sheep` | Quaternius *Farm Animals*, `Blends/Sheep.blend` (CC0-1.0) | `quaternius.farm-animals-sheep-blend` | 0.51 × 1.00 × 1.36 | 612 | 24 | 6.25 / 2.67 / – |
| `greyhaven.farm.goat` | Original, authored by the recipe | – | 0.33 × 0.95 × 0.98 | 664 | 12 | 4.00 / 1.33 / 3.00 |
| `greyhaven.farm.chicken` | Original, authored by the recipe | – | 0.23 × 0.45 × 0.44 | 524 | 7 | 3.00 / 0.67 / 2.00 |

The numbers are from the build of 2026-11-16; the descriptor carries each build's measurements. The packed tar is about 3.4 MB, mostly sampled animation; the five detail textures add about 0.15 MB (#781).

- **Why these sources.** The cow, horse and donkey come from the same pack as the ambient dog and mmorpg's Wolf, so they share its rig layout and clip names, and each has an authored `Eating` clip, shipped as `Eat`. The pig and sheep come from Quaternius' *Farm Animals* pack, the source of mmorpg's existing Pig; it has no grazing clip, so those two ship `Idle` and `Walk` only. Its colours move to one Principled material each so the glTF keeps them (see below).
- **The goat and the chicken are original.** No catalogued CC0 Quaternius pack has either. The recipe builds them from low-poly rigid parts (ellipsoids and tapered tubes, smooth-shaded below 75° creases) on a small armature, every vertex weighted fully to one bone, with five or fewer colour materials and scripted loops. The goat's `Eat` lowers its neck and head to the grass and nibbles; the chicken's tips forward and pecks.
- **Organic surface ([#781](https://github.com/moritzbrantner/asset-tooling/issues/781)).** Every material is one nonmetallic Principled BSDF with roughness 0.3 (eyes) to 0.95 (wool). The Ultimate Animated Animals sources author metallic 0.4; the Farm Animals pig and sheep used to export empty materials, which glTF draws white and fully metallic. Coat, wool, skin, feather and horn materials multiply their colour by a small tileable greyscale detail texture the recipe generates (`ORGANIC`, 128 × 128 PNG, glTF `baseColorTexture` times `baseColorFactor`, box-projected UVs in metres): short streaked hair, clumped wool, soft mottled skin, overlapping feathers and horn rings, the approach of the wildlife stag and ram ([#796](https://github.com/moritzbrantner/asset-tooling/pull/796)). The pig, goat and chicken shade smooth below 75° creases (`SMOOTHED`); the sheep keeps its blocky fleece. Before/after renders at the game camera are in [`review/greyhaven-farm-animals-781/`](../review/greyhaven-farm-animals-781/).
- **Sources.** The official Quaternius downloads are rate-limited Google Drive folders, so the catalog pins byte copies from public mirrors at fixed revisions: `github.com/trebeljahr/quaternius-showcase` (the GLBs, as for the ambient dog) and `github.com/tilakpatell/tilakverse-assets` `quaternius/farm-animals` (the `.blend` files, with the pack's CC0 `License.txt`).

## Conventions

- Metres, +Y up, right-handed. The head faces **+Z**. The origin is the centre of the idle footprint on the ground (y = 0).
- One root node per GLB, named by the key. It carries the uniform scale and turn.
- Looping, **in-place** clips: `Idle` and `Walk` on every animal, `Eat` on the cow, horse, donkey, goat and chicken (the walk's measured travel is below 1 mm). A consumer moves the root itself and may speed up the walk to match its pace.
- Sizes are heights at the top of the idle pose, horns and ears included.

## Build

```sh
git lfs pull --include="assets/canonical/quaternius.ultimate-animated-animals-*/**,assets/canonical/quaternius.farm-animals-*/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-farm-animals.ts --out .artifacts/greyhaven-farm-animals
```

[`scripts/build-greyhaven-farm-animals.ts`](../scripts/build-greyhaven-farm-animals.ts) imports each pinned payload from canonical storage (offline, hash-verified), runs [`adapters/blender/farm_animals.py`](../adapters/blender/farm_animals.py) once per animal through `external.blender.script@1` (the goat and chicken take no source input), checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `greyhaven.farm-animals.tar`, `export.ref.json`, `greyhaven.farm-animals.descriptor.json` and `lineage.json`. A rebuild packs the same tar bytes.

`farm_animals.prepare(animal, source_path)` also runs in a live Blender (`source_path` is `None` for the goat and chicken).

## Descriptor `greyhaven-farm-animals-descriptor-v1`

Attached as `farm-animals-descriptor` to `greyhaven.farm.cow/default` and written beside the tar. It has the ambient descriptor's shape: the conventions, the clip names (`names`, and the `required` `Idle` and `Walk`), and per animal its key, `idleBounds`, `size`, `triangles`, `joints`, clip durations with their source clip names (`authored` for the goat and chicken), `walkTravel` and provenance. The ambient animals' own descriptor is unchanged.

## Release

CI publishes the rolling `greyhaven-farm-animals` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/greyhaven-farm-animals.json` holds its budget: 24 materials, 0.5 MB of textures, 3.5 MB download (measured 24 materials, 0.42 MB of textures and 3.18 MB with the detail textures, #781; the material allowance is used up).

`test/blender/greyhaven-farm-animals/` builds the real bundle and checks the keys, one skin and the expected clips per animal, grounded and centred bounds, the +Z facing, the heights, in-place walks, provenance and a byte-identical replay. It skips without Blender or with unhydrated sources.
