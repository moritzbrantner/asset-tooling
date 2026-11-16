# Greyhaven wildlife

The `greyhaven-wildlife` rolling release supplies a stag, a doe, a fox, a rabbit, a wild boar, a crow, a duck, a heron and a songbird for Greyhaven's woods, meadows and river ([#667](https://github.com/moritzbrantner/asset-tooling/issues/667)). It follows the [farm animals](greyhaven-farm-animals.md) exactly: the same conventions, the same recipe shape and the same plain skinned-glTF clip convention mmorpg already loads. The game owns placement, wandering, flight paths, fleeing, collision and everything else about behaviour.

| Key (variant `default`) | Source | Catalog source | Size in metres (W × H × D, idle) | Triangles | Joints | Idle / Walk / Eat / Fly (s) |
| --- | --- | --- | --- | --- | --- | --- |
| `greyhaven.wild.stag` | Quaternius *Ultimate Animated Animals*, `Stag.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-stag-glb` | 0.90 × 2.00 × 1.70 | 3,667 | 38 | 3.33 / 1.17 / 12.08 / – |
| `greyhaven.wild.doe` | Quaternius *Ultimate Animated Animals*, `Deer.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-deer-glb` | 0.49 × 1.45 × 1.49 | 2,096 | 46 | 3.33 / 1.17 / 6.00 / – |
| `greyhaven.wild.fox` | Quaternius *Ultimate Animated Animals*, `Fox.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-fox-glb` | 0.20 × 0.50 × 1.06 | 1,848 | 51 | 3.33 / 1.04 / 2.50 / – |
| `greyhaven.wild.rabbit` | Original, authored by the recipe | – | 0.15 × 0.30 × 0.32 | 618 | 8 | 3.00 / 0.58 / 2.00 / – |
| `greyhaven.wild.boar` | Original, authored by the recipe | – | 0.44 × 0.95 × 1.50 | 740 | 11 | 4.00 / 1.17 / 3.00 / – |
| `greyhaven.wild.crow` | Original, authored by the recipe | – | 0.17 × 0.30 × 0.47 | 536 | 8 | 3.00 / 0.67 / 2.00 / 0.67 |
| `greyhaven.wild.duck` | Original, authored by the recipe (mallard drake) | – | 0.22 × 0.36 × 0.48 | 580 | 8 | 3.00 / 0.75 / 2.33 / 0.42 |
| `greyhaven.wild.heron` | Original, authored by the recipe (grey heron) | – | 0.21 × 0.95 × 0.74 | 548 | 8 | 4.00 / 1.50 / 2.67 / 1.17 |
| `greyhaven.wild.songbird` | Original, authored by the recipe (robin) | – | 0.11 × 0.17 × 0.24 | 600 | 8 | 2.00 / 0.42 / 1.33 / 0.33 |

The numbers are from the build of 2026-11-16; the descriptor carries each build's measurements. The packed tar is about 3.3 MB, mostly sampled animation.

- **Why these sources.** The stag, doe and fox come from the same Quaternius pack as the farm cow, horse and donkey, the ambient dog and mmorpg's Wolf, so they share its rig layout and clip names. Each has an authored `Eating` clip, shipped as `Eat`. The stag's antlers are a separate mesh parented to its head bone in the source; the recipe binds them to that bone as a second skinned mesh, so the stag is still one skin.
- **The rabbit, boar and birds are original.** No catalogued CC0 Quaternius pack has them. Like the farm goat and chicken, they are low-poly rigid parts (ellipsoids and tapered tubes, flat-shaded) on a small armature, every vertex weighted fully to one bone, with plain colour materials and scripted loops. The rabbit's `Walk` is one hop and its `Eat` a head-down nibble; the boar's `Eat` roots with its snout. Every bird shares one eight-bone rig (body, neck, head, tail, two wings, two legs) and one set of clips: `Idle` looks around, `Walk` steps (the songbird hops), `Eat` pecks, and `Fly` unrolls the folded wings flat, sweeps them out and beats them with the legs tucked back.
- **Sizes.** Heights are life-size at the top of the idle pose, antlers and ears included. The songbird is a little larger than a real robin so it stays visible at Greyhaven's 12 m orbit distance, as the ambient rodent is.

## Conventions

- Metres, +Y up, right-handed. The head faces **+Z**. The origin is the centre of the idle footprint on the ground (y = 0).
- One root node per GLB, named by the key. It carries the uniform scale and turn.
- Looping, **in-place** clips: `Idle`, `Walk` and `Eat` on every animal, and `Fly` on the four birds (the walk's measured travel is below 1 mm). `Fly` is posed at standing height; a consumer lifts the root into the air, moves it itself and may speed up the walk to match its pace.

## Build

```sh
git lfs pull --include="assets/canonical/quaternius.ultimate-animated-animals-*/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-wildlife.ts --out .artifacts/greyhaven-wildlife
```

[`scripts/build-greyhaven-wildlife.ts`](../scripts/build-greyhaven-wildlife.ts) imports each pinned payload from canonical storage (offline, hash-verified), runs [`adapters/blender/wildlife.py`](../adapters/blender/wildlife.py) once per animal through `external.blender.script@1` with the farm-animals recipe as its declared Python input `farm` (the authored animals take no source input), checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `greyhaven.wildlife.tar`, `export.ref.json`, `greyhaven.wildlife.descriptor.json` and `lineage.json`. A rebuild packs the same tar bytes; it takes about fifteen seconds.

`wildlife.prepare(animal, source_path)` also runs in a live Blender after `wildlife.use_farm(<farm_animals module dict>)` (`source_path` is `None` for the authored animals). The tables at the top of the recipe (`ANIMALS`, `BIRD_SPECS`, `BIRD_MOTION`, `CLIP_FRAMES`) hold the heights, the birds' proportions and colours, and the clip lengths.

## Descriptor `greyhaven-wildlife-descriptor-v1`

Attached as `wildlife-descriptor` to `greyhaven.wild.stag/default` and written beside the tar. It has the farm descriptor's shape: the conventions, the clip names (`names`, the `required` `Idle`, `Walk` and `Eat`, and the `birds`' extra `Fly`), and per animal its key, whether it is a `bird`, `idleBounds`, `size`, `triangles`, `joints`, clip durations with their source clip names (`authored` for the original animals), `walkTravel` and provenance.

## Release

CI publishes the rolling `greyhaven-wildlife` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/greyhaven-wildlife.json` holds its budget (56 materials, 4 MB; measured 52 materials and 3.3 MB).

`test/blender/greyhaven-wildlife/` builds the real bundle and checks the keys, one skin with every mesh skinned and the expected clips per animal, grounded and centred bounds, the +Z facing, the heights, in-place walks, the triangle counts, provenance and a byte-identical replay. It skips without Blender or with unhydrated sources.

Review renders at the Greyhaven game camera (12 m, 0.42 rad pitch, 50° field of view), a close-up and the birds in flight are in [`review/greyhaven-wildlife/`](../review/greyhaven-wildlife/).
