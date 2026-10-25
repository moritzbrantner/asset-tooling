# Greyhaven ambient animals

The `greyhaven-ambient-animals` rolling release supplies a cat, a dog and a small rodent for Greyhaven's non-interactive ambience ([#364](https://github.com/moritzbrantner/asset-tooling/issues/364), consumer [mmorpg#419](https://github.com/moritzbrantner/mmorpg/issues/419)). Each animal is an existing CC0 Quaternius model with its own authored `Idle` and `Walk` clips; nothing is modelled or animated from scratch. The game owns placement, wandering, collision and everything else about behaviour.

| Key (variant `default`) | Source (CC0-1.0) | Catalog source | Size in metres (W × H × D, idle) | Triangles | Joints | Idle / Walk (s) |
| --- | --- | --- | --- | --- | --- | --- |
| `greyhaven.ambient.cat` | Quaternius *Animal Pack Vol.2*, `Blends/Cat.blend` ([OpenGameArt](https://opengameart.org/content/animated-animales-low-poly)) | `quaternius.animal-pack-vol2.cat-blend` | 0.14 × 0.45 × 0.58 | 807 | 24 | 1.67 / 1.67 |
| `greyhaven.ambient.dog` | Quaternius *Ultimate Animated Animals*, `ShibaInu.glb` ([pack](https://quaternius.com/packs/ultimateanimatedanimals.html)) | `quaternius.ultimate-animated-animals-shibainu-glb` | 0.23 × 0.65 × 0.89 | 1,950 | 46 | 3.33 / 1.04 |
| `greyhaven.ambient.rodent` | Quaternius *Easy Enemy*, `Rat.glb` ([pack](https://quaternius.com/packs/easyenemy.html)), re-tinted brown | `quaternius.easy-enemy-rat-glb` | 0.11 × 0.17 × 0.50 | 4,004 | 31 | 2.38 / 1.33 |

The numbers are from the build of 2026-10-24; the descriptor carries each build's measurements. The packed tar is about 1.2 MB.

- **Why these sources.** The dog comes from the same pack as mmorpg's adopted Wolf, so it shares its rig layout and clip names. The cat is the only CC0 animated Quaternius cat; its pack shades with Diffuse BSDF nodes, which the recipe carries to matte Principled materials so the glTF keeps its dark grey fur and white paws. The rodent is the Easy Enemy rat that mmorpg already vendors, made smaller and brown so it does not read as the hostile grey Rat.
- **Not the #128 proof.** This adopts the plain skinned-glTF clip convention mmorpg already loads for its Wolf, Rat and Pig. It adds no non-humanoid profile, rig validation or species catalog, and does not preempt [#128](https://github.com/moritzbrantner/asset-tooling/issues/128)'s Zoo-first proof.

## Conventions

- Metres, +Y up, right-handed. The head faces **+Z**. The origin is the centre of the idle footprint on the ground (y = 0).
- One root node per GLB, named by the key. It carries the uniform scale and turn; the source armature, skinned mesh and materials are otherwise unchanged.
- Exactly two looping, **in-place** clips, `Idle` and `Walk` (the walk's measured travel is below 1 mm). A consumer moves the root itself and may speed up the walk to match its pace.
- Sizes: the dog stands 0.65 m and the cat 0.45 m at the top of their idle poses (tail included). The rodent is 0.5 m from nose to tail tip, a little larger than life so it stays visible at Greyhaven's default 12 m orbit distance.

## Build

```sh
git lfs pull --include="assets/canonical/quaternius.animal-pack-vol2.cat-blend/**,assets/canonical/quaternius.ultimate-animated-animals-shibainu-glb/**,assets/canonical/quaternius.easy-enemy-rat-glb/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-ambient-animals.ts --out .artifacts/greyhaven-ambient-animals
```

[`scripts/build-greyhaven-ambient-animals.ts`](../scripts/build-greyhaven-ambient-animals.ts) imports each pinned payload from canonical storage (offline, hash-verified), runs [`adapters/blender/ambient_animals.py`](../adapters/blender/ambient_animals.py) once per animal through `external.blender.script@1`, checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `greyhaven.ambient-animals.tar` (+ `.sha256`), `export.ref.json`, `greyhaven.ambient-animals.descriptor.json` and `lineage.json`. A rebuild packs the same tar bytes; it takes about ten seconds. Snap Blender needs `TMPDIR` under `$HOME`.

`ambient_animals.prepare(animal, source_path)` also runs in a live Blender, which is how the sizes were reviewed at the game camera (12 m, 0.42 rad pitch, 50° field of view).

## Descriptor `greyhaven-ambient-animals-descriptor-v1`

Attached as `ambient-animals-descriptor` to `greyhaven.ambient.cat/default` and written beside the tar. It holds the conventions above, the clip names, and per animal its key, `idleBounds`, `size`, `triangles`, `joints`, clip durations with their source clip names, `walkTravel`, and provenance: pack, member, catalog source, licence, the source `AssetRef` and the recipe hash.

## Release

CI publishes the tar, its `.sha256`, `export.ref.json`, the descriptor and `lineage.json` on the single rolling `greyhaven-ambient-animals` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). mmorpg reads the live release unpinned and refreshes its local copy when `export.ref.json` changes.

`test/greyhaven-ambient-animals.test.ts` builds the real bundle and checks the keys, one skin and exactly `Idle`/`Walk` per animal, grounded and centred bounds, the +Z facing, the sizes, in-place walks, the cat's dark fur, the rodent's brown fur, provenance and a byte-identical replay. It skips without Blender or with unhydrated sources; the hosted `blender-script` job hydrates the three sources and runs it.
