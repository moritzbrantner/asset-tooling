# Expressive Zoo animals

This is the recipe for Zoo's finished cartoon animals ([#589](https://github.com/moritzbrantner/asset-tooling/issues/589), consumer [zoo#112](https://github.com/moenarch-games/zoo/issues/112) and [zoo#142](https://github.com/moenarch-games/zoo/issues/142)). The animals are the **zebra**, the **giraffe**, the **tiger**, the **elephant** and the **capybara**. The zebra and giraffe replace Zoo's deprecated generator output, whose zebra has a block body, a bear-like head and a walk that splays its legs sideways ([quadruped-rigid.md](quadruped-rigid.md#what-the-viewer-shows)).

- **Source:** [`adapters/blender/zoo_animals.py`](../adapters/blender/zoo_animals.py), an original scripted Blender recipe in this repository. It has no imported meshes, no third-party assets, no textures and no randomness. Zoo's generator is not ported.
- **Rig:** the shared [`quadruped-rigid`](quadruped-rigid.md) profile. Named transform nodes pivot at their joints and rigid parts hang under them, with no skin.
- **Release:** the existing rolling `zoo-animals` release, as the variant `expressive` of the keys `zoo.animal.zebra`, `zoo.animal.giraffe`, `zoo.animal.tiger`, `zoo.animal.elephant` and `zoo.animal.capybara`. Zoo's own zebra and giraffe stay unchanged as the `default` variant, so a consumer of a `default` member sees the same model.

## Build

```sh
git lfs pull --include="assets/canonical/zoo.zebra-glb/**,assets/canonical/zoo.giraffe-glb/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-animals.ts --out .artifacts/zoo-animals
```

[`scripts/build-zoo-animals.ts`](../scripts/build-zoo-animals.ts) runs the recipe once per expressive animal through `external.blender.script@1`. It then packages every member through the shared profile path (`packageQuadrupedRigidFamily`): profile check, `scene.import.gltf@2`, profile check, `gltf-resources-v1` bundle, profile check. The build takes a few seconds, and a rebuild packs the same tar bytes. Snap Blender needs `TMPDIR` under `$HOME`.

`zoo_animals.build(species, collection)` also runs in a live Blender session, for example through the Blender MCP, to shape the animal. The proportions, pivots and stripe planes are tables and short functions at the top of each species builder; the clips are the `pose_*` (zebra) and `giraffe_*` functions, listed per species in `POSES`.

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
| `rest` | 5.0 | Lying on folded legs: each knee rests on the grass and the lower leg lies back along the ground, spread a little so the legs show beside the body. Eyes closed, slow breathing and an ear flick |

`walk` plays at 1× for a pace of about 0.6 m/s at full size; a consumer that scales the animal down scales the pace with it and may speed the clip up. Measured over every clip, nothing sinks below 1.1 mm under the ground plane and the root does not travel.

**Mapping to Zoo activities:** Zoo's core owns activity. For its current `AnimalActivity` (`apps/web/src/game-types.ts`), play `walk` for `walking` and `rest` for `resting`. Play `feed` once Zoo reports feeding, and `idle` otherwise. A cross-fade of about 0.4 s hides the change between standing and lying. These names are new clips; the existing `idle` and `walk` keep their meaning, so no consumer migration is needed.

## The giraffe

The second animal ([#596](https://github.com/moritzbrantner/asset-tooling/issues/596)) uses the zebra's joints, clip names and checks, with its own proportions and clips.

| Key / variant | Size (L × H × W, m) | Triangles | Parts | Materials |
| --- | --- | --- | --- | --- |
| `zoo.animal.giraffe` / `expressive` | 2.29 × 3.56 × 0.72 | 5,130 | 16 | 1 |

- **Look:** a short, deep body whose back slopes down from the withers to the rump, long cream lower legs with dark hooves, a long tapering neck with a short dark mane, and a big round head with a cream muzzle, two ossicones with dark tips, sideways ears and large eyes with lids. The reticulated coat is cream lines cut across the tan in three directions on the body, neck and upper legs, leaving large polygon patches, with a cream belly.
- **Clips:**

| Clip | Seconds | What it shows |
| --- | --- | --- |
| `idle` | 5.0 | A slow neck sway, a curious head turn and tilt, ear flicks, a blink and a tail swish |
| `walk` | 1.6 | A near-pacing walk: each front leg follows the hind leg on its own side closely (hind left, front left, hind right, front right). The legs swing about the side axis only, the body rolls towards the planted side and the neck pumps with each stride, for about 0.55 m/s at full size. |
| `feed` | 3.0 | Browsing high: the neck reaches up and forwards, the head tilts up and nibbles, eyes half closed |
| `rest` | 6.0 | Lying on folded legs like the zebra (`fold_legs`), the neck upright and the head lowered a little, eyes nearly closed, slow breathing |

The Zoo activity mapping is the zebra's.

## The tiger

The third animal ([#590](https://github.com/moritzbrantner/asset-tooling/issues/590), consumer [zoo#138](https://github.com/moenarch-games/zoo/issues/138)) is new to the release: Zoo has no tiger of its own, so `zoo.animal.tiger` has only the `expressive` variant.

| Key / variant | Size (L × H × W, m) | Triangles | Parts | Materials |
| --- | --- | --- | --- | --- |
| `zoo.animal.tiger` / `expressive` | 2.12 × 1.29 × 0.58 | 4,704 | 16 | 1 |

The length includes the tail.

- **Look:** a long, low, muscular body with a white belly, sturdy legs with big round cream paws, a short thick neck with a white throat, and a big round head: white cheek ruffs, a two-lobed white muzzle with a pink nose and a small smile, white brow patches, two forehead marks, large amber eyes with round pupils and highlights, and round black ears with white insides. Thin black stripes run down from the spine, leaning back by varying amounts and alternating wide and narrow, and stop short of the belly; the legs carry bands and the thick, curling tail black rings and a black tip.
- **Clips:**

| Clip | Seconds | What it shows |
| --- | --- | --- |
| `idle` | 5.0 | A look around, a head tilt, a big yawning stretch with the eyes squeezed shut, blinks, ear flicks and a lazy tail |
| `walk` | 1.1 | A cat's lateral-sequence prowl: legs swing about the side axis only, the shoulders roll, the head stays low and level and the tail sways |
| `feed` | 3.0 | Crouched over food on the ground (`crouch_legs`): elbows back, hind knees forward, front low, the head down and chewing with sideways tugs |
| `rest` | 6.0 | Lying like a sphinx: elbows on the grass and forepaws stretched out in front, hind legs folded (`fold_legs`), head up with the eyes shut, the tail curled forward along the body |

The Zoo activity mapping is the zebra's. Predator care, welfare and habitat rules stay with Zoo (zoo#138).

## The elephant

The fourth animal ([#599](https://github.com/moritzbrantner/asset-tooling/issues/599)) is new to the release too, so `zoo.animal.elephant` has only the `expressive` variant. It adds two joints of its own, which the profile allows: `head > trunk > trunk_tip`, so the trunk can sway, curl and carry food.

| Key / variant | Size (L × H × W, m) | Triangles | Parts | Materials |
| --- | --- | --- | --- | --- |
| `zoo.animal.elephant` / `expressive` | 3.06 × 2.26 × 2.23 | 3,912 | 18 | 1 |

The length includes the trunk and the width the fanned ears.

- **Look:** a big round body, thick column legs on dark round feet with three cream toenails each, a short neck under a big domed head with full cheeks, small ivory tusks, large round eyes with highlights, and big round ears fanned out to the sides with pink fronts. The trunk carries soft wrinkle rings and a darker tip; the tail ends in a dark tuft.
- **Clips:**

| Clip | Seconds | What it shows |
| --- | --- | --- |
| `idle` | 6.0 | Slow ear flaps, the trunk swaying from side to side and its tip curling, a nod, a blink and a tail swish |
| `walk` | 1.5 | A slow lateral-sequence amble: shorter swings for the wide feet, the trunk swinging like a pendulum and the ears flapping with the stride |
| `feed` | 4.0 | The trunk reaches down to the grass, picks some up, curls it to the mouth, and the elephant chews (keyed phases in `ELEPHANT_FEED`) |
| `rest` | 6.0 | Lying on folded legs (`fold_legs`), the trunk laid out on the grass in front with its tip curled, eyes shut, ears flat |

The amble keeps the body about 4 cm higher than standing, because the wide foot pads tip their rims down as they swing. The Zoo activity mapping is the zebra's.

## The capybara

The fifth animal ([#600](https://github.com/moritzbrantner/asset-tooling/issues/600)) is new to the release as well: `zoo.animal.capybara` has only the `expressive` variant.

| Key / variant | Size (L × H × W, m) | Triangles | Parts | Materials |
| --- | --- | --- | --- | --- |
| `zoo.animal.capybara` / `expressive` | 1.52 × 0.78 × 0.54 | 1,780 | 16 | 1 |

- **Look:** a chunky round barrel with a lighter belly on short stout legs with dark little feet, a short neck and a long, blunt, flat-topped head: an octagonal, almost boxy skull and a full square muzzle with a soft brown nose, nostrils on top and a small mouth line. Small dark ears sit on top at the back, and the small eyes set high on the sides under heavy, relaxed lids give it its calm look. The tail is only a nub, as a capybara's is.
- **Clips:**

| Clip | Seconds | What it shows |
| --- | --- | --- |
| `idle` | 6.0 | Slow breathing, a long contented blink, ear twitches, a sniff with a nose wiggle and a slow look around |
| `walk` | 0.9 | A short-legged waddle: big leg swings for the short legs (still about the side axis only) and the round body rolling from side to side |
| `feed` | 3.0 | Grazing with the head down at the grass, munching steadily, an ear flick now and then |
| `rest` | 6.0 | Flopped on its belly with the short legs folded (`fold_legs`), the chin lowered, eyes shut |

The Zoo activity mapping is the zebra's.

## Conventions

These are the conventions of the existing `zoo-animals` members: metres, +Y up, right-handed, the animal faces **+X** and its right side is +Z, and the origin is on the ground plane under the body. The asset is presentation only; Zoo owns placement, scale, activity, gameplay and physics.

## Validation

[`quadruped-rigid`](quadruped-rigid.md#profile-rules) checks the rig, clips and bounds at every packaging stage. #589 adds two narrow rules that the existing members also pass:

- **Ground contact:** each clip is sampled at 30 Hz from the glTF itself (`withClipPose`, `clipLowestPoint` in `src/quadruped-rigid.ts`), and no point may sink more than 1 cm below the ground. The descriptor records each clip's `lowestPoint`.
- **Activity clips:** a clip named `feed` or `rest` stays in place, like `walk`.

`test/blender/zoo-animals/zoo-animals.test.ts` (its own Blender suite, with the two canonical sources hydrated) builds the release twice and checks:

- the old members are unchanged;
- each expressive animal has the joints and clips above, one material, a real palette in `COLOR_0` with its coat colour, no textures, and its own height, length and triangle budget;
- every clip keys the same channels;
- no clip sinks or travels;
- the rest pose lies on the ground;
- in the walk, every leg and knee turns only about the side axis (no lateral splay), and the four legs peak at four different times;
- the rebuild packs a byte-identical tar.

## Review images

`scripts/review-zoo-animals.ts` renders from the packaged bundle, not from the recipe scene. It samples each pose from the released clips with the same sampler, writes static posed GLBs, and [`adapters/blender/zoo_animals_review.py`](../adapters/blender/zoo_animals_review.py) lays them out on 1 m tiles. The animals are scaled to Zoo's on-screen animal height of about 0.55 m, and the camera is Zoo's: yaw −38°, pitch 46°, 36° vertical field of view.

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle .artifacts/zoo-animals/bundle --key zoo.animal.zebra --out .artifacts/zoo-review
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle .artifacts/zoo-animals/bundle --key zoo.animal.giraffe --compare zoo.animal.giraffe/default --out .artifacts/zoo-review-giraffe
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle .artifacts/zoo-animals/bundle --key zoo.animal.tiger --compare zoo.animal.zebra/expressive --out .artifacts/zoo-review-tiger
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle .artifacts/zoo-animals/bundle --key zoo.animal.elephant --compare zoo.animal.zebra/expressive --out .artifacts/zoo-review-elephant
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle .artifacts/zoo-animals/bundle --key zoo.animal.capybara --compare zoo.animal.zebra/expressive --out .artifacts/zoo-review-capybara
```

The zebra images are in [`review/zoo-animals/`](../review/zoo-animals/), and each later animal's in its own folder, `review/zoo-animals/<species>/`. The giraffe stands beside Zoo's current giraffe; the tiger, elephant and capybara, which Zoo has no model of, beside the expressive zebra for scale:

- `park.jpg` and `watch.jpg`: an enclosure with the expressive animal idling, walking, feeding and resting, beside Zoo's current one, at a park distance (22 m) and a close animal-watch distance (6.5 m);
- `orbit-front.jpg` and `orbit-back.jpg`: two more orbit angles;
- `compare.jpg`: the current (or compared) and expressive animal side by side;
- `face.jpg`: the expressive animal's face, close up from three-quarters front;
- `strip-idle.jpg`, `strip-walk.jpg`, `strip-feed.jpg` and `strip-rest.jpg`: the initial and intermediate poses of each clip (four phases, or every second of the walk's 12), from the side, spaced by the animal's length;
- `walk.gif`: the walk loop from the watch camera.

They are evidence for the owner's review. Visual approval stays with the owner and with Zoo's own acceptance in a real habitat ([zoo#112](https://github.com/moenarch-games/zoo/issues/112), [zoo#142](https://github.com/moenarch-games/zoo/issues/142)).

## Not covered here

- **The Pages animation viewer** plays catalog sources only (`viewer/?asset=<catalog id>`). The expressive animals are generated release members, not a catalog source, so the review images come from the bundle as described above. Loading release-bundle members in the viewer is a separate viewer change.
- **Zoo adoption:** loading the `expressive` members, binding Rust activities to the clips, and desktop and phone acceptance belong to zoo#112 and zoo#142.
- **More species:** each further species is its own issue and PR on this recipe, one at a time after the owner reviews the last. Two-legged animals such as the flamingo and penguin use the sibling `biped-rigid` profile ([#605](https://github.com/moritzbrantner/asset-tooling/issues/605), [docs/quadruped-rigid.md](quadruped-rigid.md#the-biped-rigid-sibling)).
- **Licence:** the expressive animals ship under the family's MIT notice (`Copyright (c) 2026 moritzbrantner`), the same owner and terms as Zoo's models. The owner should confirm this on #589.
