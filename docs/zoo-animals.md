# Expressive Zoo animals

This is the recipe for Zoo's finished cartoon animals ([#589](https://github.com/moritzbrantner/asset-tooling/issues/589), consumer [zoo#112](https://github.com/moenarch-games/zoo/issues/112) and [zoo#142](https://github.com/moenarch-games/zoo/issues/142)). The first animal is the **zebra**. It replaces Zoo's deprecated generator output, which has a block body, a bear-like head and a walk that splays its legs sideways ([quadruped-rigid.md](quadruped-rigid.md#what-the-viewer-shows)).

- **Source:** [`adapters/blender/zoo_animals.py`](../adapters/blender/zoo_animals.py), an original scripted Blender recipe in this repository. It has no imported meshes, no third-party assets, no textures and no randomness. Zoo's generator is not ported.
- **Rig:** the shared [`quadruped-rigid`](quadruped-rigid.md) profile. Named transform nodes pivot at their joints and rigid parts hang under them, with no skin.
- **Release:** the existing rolling `zoo-animals` release, as the variant `expressive` of the key `zoo.animal.zebra`. Zoo's own zebra and giraffe stay unchanged as the `default` variant, so a consumer of `zoo.animal.zebra/default` sees the same model.

## Build

```sh
git lfs pull --include="assets/canonical/zoo.zebra-glb/**,assets/canonical/zoo.giraffe-glb/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-animals.ts --out .artifacts/zoo-animals
```

[`scripts/build-zoo-animals.ts`](../scripts/build-zoo-animals.ts) runs the recipe once per expressive animal through `external.blender.script@1`. It then packages every member through the shared profile path (`packageQuadrupedRigidFamily`): profile check, `scene.import.gltf@2`, profile check, `gltf-resources-v1` bundle, profile check. The build takes a few seconds, and a rebuild packs the same tar bytes. Snap Blender needs `TMPDIR` under `$HOME`.

`zoo_animals.build(species, collection)` also runs in a live Blender session, for example through the Blender MCP, to shape the animal. The proportions, pivots and stripe planes are tables and short functions at the top of each species builder; the clips are the `pose_*` functions.

## The zebra

| Key / variant | Size (L × H × W, m) | Triangles | Parts | Materials |
| --- | --- | --- | --- | --- |
| `zoo.animal.zebra` / `expressive` | 1.72 × 1.65 × 0.50 | 3,938 | 16 | 1 |

These are the numbers from the build of 2026-11-11; the descriptor carries each build's measurements. The height includes the ears.

- **Look:** a round barrel body, long legs with black hooves, a forward-leaning neck with an upright mane and a dark crest, a big round head with a long muzzle and a dark nose, large cartoon eyes with pupils and highlights, leaf ears with pink insides and black tips, and a whip tail with a black tuft. The stripes are cut into the geometry with planes: across the body, more diagonal over the rump, ending above the white belly, and as bands on the legs, neck, ears and face. Their edges stay crisp at any distance.
- **One draw call per part:** every part shares one opaque material, `zoo-animal`, with roughness 0.7 and no textures. The flat palette colours travel as linear per-corner `COLOR_0`, which glTF multiplies into the base colour, as three.js does on its own.

### Joints

```
animal_root > body > neck > head > ear_left, ear_right, eye_left, eye_right
              body > tail
              body > leg_0 > leg_0_lower   (hind right)
              body > leg_1 > leg_1_lower   (hind left)
              body > leg_2 > leg_2_lower   (front right)
              body > leg_3 > leg_3_lower   (front left)
```

The leg order is the existing members' order. Each leg pivots at its hip, the top of its own mesh, and each `_lower` joint at the knee or hock. The hooves belong to the lower legs, and the eyes and ears are children of the head, so nothing can detach. The eyes close by scaling their own node flat.

### Clips

Every clip loops, stays in place and keys the same channels: the rotation, translation and scale of every joint. A consumer can therefore cross-fade between any two clips without leaving a joint in the other clip's pose.

| Clip | Seconds | What it shows |
| --- | --- | --- |
| `idle` | 4.0 | Breathing, a slow look around, one flick of each ear, a blink and a tail swish |
| `walk` | 1.2 | A four-beat lateral-sequence walk (hind left, front left, hind right, front right). Each leg swings ±17° about the animal's side axis, so the hooves travel forwards and backwards, and the knees fold in the swing phase. The head nods twice per stride. |
| `feed` | 3.0 | Neck and head down to the grass, nibbling, front legs a little forward, ears and tail still moving |
| `rest` | 5.0 | Lying down with the legs folded under the body, eyes closed, slow breathing and an ear flick |

`walk` plays at 1× for a pace of about 0.6 m/s at full size; a consumer that scales the animal down scales the pace with it and may speed the clip up. Measured over every clip, nothing sinks below 1.1 mm under the ground plane and the root does not travel.

**Mapping to Zoo activities:** Zoo's core owns activity. For its current `AnimalActivity` (`apps/web/src/game-types.ts`), play `walk` for `walking` and `rest` for `resting`. Play `feed` once Zoo reports feeding, and `idle` otherwise. A cross-fade of about 0.4 s hides the change between standing and lying. These names are new clips; the existing `idle` and `walk` keep their meaning, so no consumer migration is needed.

## Conventions

These are the conventions of the existing `zoo-animals` members: metres, +Y up, right-handed, the animal faces **+X** and its right side is +Z, and the origin is on the ground plane under the body. The asset is presentation only; Zoo owns placement, scale, activity, gameplay and physics.

## Validation

[`quadruped-rigid`](quadruped-rigid.md#profile-rules) checks the rig, clips and bounds at every packaging stage. #589 adds two narrow rules that the existing members also pass:

- **Ground contact:** each clip is sampled at 30 Hz from the glTF itself (`withClipPose`, `clipLowestPoint` in `src/quadruped-rigid.ts`), and no point may sink more than 1 cm below the ground. The descriptor records each clip's `lowestPoint`.
- **Activity clips:** a clip named `feed` or `rest` stays in place, like `walk`.

`test/blender/zoo-animals/zoo-animals.test.ts` (its own Blender suite, with the two canonical sources hydrated) builds the release twice and checks:

- the old members are unchanged;
- the zebra has the joints and clips above, one material, a real palette in `COLOR_0` and no textures;
- every clip keys the same channels;
- no clip sinks or travels;
- the rest pose lies on the ground;
- in the walk, every leg and knee turns only about the side axis (no lateral splay), and the four legs peak at four different times;
- the rebuild packs a byte-identical tar.

## Review images

`scripts/review-zoo-animals.ts` renders from the packaged bundle, not from the recipe scene. It samples each pose from the released clips with the same sampler, writes static posed GLBs, and [`adapters/blender/zoo_animals_review.py`](../adapters/blender/zoo_animals_review.py) lays them out on 1 m tiles. The animals are scaled to Zoo's on-screen animal height of about 0.55 m, and the camera is Zoo's: yaw −38°, pitch 46°, 36° vertical field of view.

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle .artifacts/zoo-animals/bundle --key zoo.animal.zebra --out .artifacts/zoo-review
```

The images from the 2026-11-11 build are in [`review/zoo-animals/`](../review/zoo-animals/):

- `park.jpg` and `watch.jpg`: an enclosure with the expressive zebra idling, walking, feeding and resting, beside Zoo's current zebra, at a park distance (22 m) and a close animal-watch distance (6.5 m);
- `orbit-front.jpg` and `orbit-back.jpg`: two more orbit angles;
- `compare.jpg`: the current and expressive zebra side by side;
- `strip-idle.jpg`, `strip-walk.jpg`, `strip-feed.jpg` and `strip-rest.jpg`: the initial and intermediate poses of each clip (four phases, or every second of the walk's 12), from the side;
- `walk.gif`: the walk loop from the watch camera.

They are evidence for the owner's review. Visual approval stays with the owner and with Zoo's own acceptance in a real habitat ([zoo#112](https://github.com/moenarch-games/zoo/issues/112), [zoo#142](https://github.com/moenarch-games/zoo/issues/142)).

## Not covered here

- **The Pages animation viewer** plays catalog sources only (`viewer/?asset=<catalog id>`). The expressive zebra is a generated release member, not a catalog source, so the review images come from the bundle as described above. Loading release-bundle members in the viewer is a separate viewer change.
- **Zoo adoption:** loading `zoo.animal.zebra/expressive`, binding Rust activities to the clips, and desktop and phone acceptance belong to zoo#112 and zoo#142.
- **More species:** the tiger ([#590](https://github.com/moritzbrantner/asset-tooling/issues/590)) reuses this recipe's builder, rig and clips as its own species.
- **Licence:** the expressive animals ship under the family's MIT notice (`Copyright (c) 2026 moritzbrantner`), the same owner and terms as Zoo's models. The owner should confirm this on #589.
