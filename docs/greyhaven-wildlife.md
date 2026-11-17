# Greyhaven wildlife

The `greyhaven-wildlife` rolling release supplies a stag, a doe, a fox, a rabbit, a wild boar, a crow, a duck, a heron and a songbird for Greyhaven's woods, meadows and river ([#667](https://github.com/moritzbrantner/asset-tooling/issues/667)), and the hostile Timber Wolf, Young Boar and Grain Rat's combat clips ([#715](https://github.com/moritzbrantner/asset-tooling/issues/715), [below](#combat-clips-715)), plus three more hostile creatures with the same combat set: a brown bear, a giant cave spider and a marsh lurker ([#722](https://github.com/moritzbrantner/asset-tooling/issues/722), [below](#bear-spider-and-marsh-lurker-722)). It follows the [farm animals](greyhaven-farm-animals.md) exactly: the same conventions, the same recipe shape and the same plain skinned-glTF clip convention mmorpg already loads. The game owns placement, wandering, flight paths, fleeing, collision and everything else about behaviour.

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
| `greyhaven.wild.wolf` | Quaternius *Ultimate Animated Animals*, `Wolf.glb` (CC0-1.0) | `quaternius.ultimate-animated-animals-wolf-glb` | 0.36 × 0.90 × 1.78 | 1,962 | 51 | 3.33 / 1.04 / 2.50 / – |
| `greyhaven.wild.rat` | Quaternius *Easy Enemy*, `Rat.glb` (CC0-1.0) | `quaternius.easy-enemy-rat-glb` | 0.20 × 0.30 × 0.90 | 4,004 | 31 | 2.38 / 1.33 / 2.00 / – |
| `greyhaven.wild.bear` | Original, authored by the recipe (brown bear) | – | 0.75 × 1.30 × 1.97 | 1,096 | 12 | 4.00 / 1.33 / 3.00 / – |
| `greyhaven.wild.spider` | Original, authored by the recipe (giant cave spider) | – | 0.90 × 0.45 × 1.39 | 1,164 | 20 | 2.00 / 0.50 / 2.00 / – |
| `greyhaven.wild.marsh-lurker` | Original, authored by the recipe (newt-like marsh predator) | – | 0.75 × 0.30 × 1.52 | 1,332 | 14 | 3.00 / 1.00 / 2.00 / – |

The numbers are from the builds of 2026-11-16 and, for the wolf, rat and combat clips, 2026-11-17 (the bear, spider and marsh lurker too); the descriptor carries each build's measurements. The packed tar is about 6.5 MB, mostly sampled animation.

- **Why these sources.** The stag, doe, fox and wolf come from the same Quaternius pack as the farm cow, horse and donkey and the ambient dog, so they share its rig layout and clip names. The wolf is the same `Wolf.glb` bytes mmorpg vendors, and the rat the Easy Enemy `Rat.glb` it vendors (the ambient rodent's source), kept grey and hostile-sized here. Each has an authored `Eating` clip, shipped as `Eat`. The stag's antlers are a separate mesh parented to its head bone in the source; the recipe binds them to that bone as a second skinned mesh, so the stag is still one skin.
- **The rabbit, boar and birds are original.** No catalogued CC0 Quaternius pack has them. Like the farm goat and chicken, they are low-poly rigid parts (ellipsoids and tapered tubes, flat-shaded) on a small armature, every vertex weighted fully to one bone, with plain colour materials and scripted loops. The rabbit's `Walk` is one hop and its `Eat` a head-down nibble; the boar's `Eat` roots with its snout. Every bird shares one eight-bone rig (body, neck, head, tail, two wings, two legs) and one set of clips: `Idle` looks around, `Walk` steps (the songbird hops), `Eat` pecks, and `Fly` unrolls the folded wings flat, sweeps them out and beats them with the legs tucked back.
- **Sizes.** Heights are life-size at the top of the idle pose, antlers and ears included. The songbird is a little larger than a real robin so it stays visible at Greyhaven's 12 m orbit distance, as the ambient rodent is.

## Combat clips (#715)

The wolf, boar and rat fight players, so they also ship a looping in-place `Run` and five one-shot clips. Attacks have an anticipation, a snap and a recovery so they read at the game camera; `contactSeconds` (in the descriptor) is when the bite, tusks or claws land, for the zone's creature melee. Seconds; contact in brackets.

| Clip | Wolf | Boar | Rat |
| --- | --- | --- | --- |
| `Run` (loop) | 0.54, source `Gallop` | 0.67, bounding gallop | 0.50, source `Rat_Run` |
| `Attack_A` | 0.88 [0.375], bite and shake: source `Attack` re-timed, head shaking the prey after the jaws close | 0.83 [0.375], tusk gore: head drops and weight rocks back, then the head rips upward as it surges in | 0.75 [0.417], lunge bite: source `Rat_Attack`, longer recovery |
| `Attack_B` | 1.04 [0.583], leap bite: deeper crouch, the whole body and feet leave the ground, forelegs reach, bite on landing | 1.00 [0.625], charge and toss: forefoot stamps, short charge, full head toss | 1.00 [0.500], claw swipe: rears onto its haunches, rakes down right then left |
| `Hit` | 0.33, source `Idle_HitReact_Left` re-timed, ears flinch | 0.33, jolt back and sideways | 0.33, jolt back |
| `Death` | 1.04, source `Death`: rears, collapses onto its side | 1.33, staggers, forelegs buckle, rolls onto its right side | 1.08, source `Rat_Death`: flips onto its side |
| `Alert` | 0.83, head low, ears flat, two snapping snarls | 0.83, head up with a huff and a tusk shake, forefoot stamp | 0.83, up on its haunches, two hisses |

Every death ends lying still on its side. Clips stay in place: the wolf's leap and the boar's charge move the body over the footprint and come back, and a consumer moves the root itself. The wolf's and rat's source rigs have no jaw bone, so bites and snarls are head, neck and ear motion. The layered clips (`LAYERED` in the recipe) are a source clip re-timed by a piecewise-linear warp, with a scripted additive pose baked onto every frame; the source rigs' feet are separate root-level bones, so a leap or swipe moves them too.

## Bear, spider and marsh lurker (#722)

Three more hostile creatures for fights in the woods, caves and marsh, each with the full combat set above, `contactSeconds` on the attacks and `hostile` in the descriptor. No catalogued CC0 source has a bear, spider or newt-like creature (the Quaternius animal packs here have none, and the free asset libraries were not used), so all three are original and built like the boar: rigid low-poly parts on a small armature with every clip scripted. The bear (12 joints) has a jaw and four two-bone legs; the spider (20 joints) a cephalothorax, an abdomen, two fangs and eight two-bone legs whose feet a two-bone solve keeps planted while the body rears, lunges or leaps; the marsh lurker (14 joints) a jaw, a three-bone tail and four sprawled legs. Each moves differently: the bear is heavy and slow, the spider skitters, the lurker crawls with a side-to-side wave down its spine. Seconds; contact in brackets.

| Clip | Bear | Spider | Marsh lurker |
| --- | --- | --- | --- |
| `Run` (loop) | 0.75, heavy bounding gallop | 0.42, low skitter | 0.58, fast sprawling crawl |
| `Attack_A` | 0.92 [0.458], paw swipe: rocks back, the right forepaw rises and cocks out, then rakes across as the body twists in, roaring | 0.75 [0.375], fang strike: rears with the forelegs high and the fangs spread, then drops and lunges, forelegs hooking in, fangs driving under the head | 0.75 [0.333], snapping bite: head back and up with the jaw gaping, then a lunge and the jaw slams shut, with a head shake |
| `Attack_B` | 1.42 [0.833], rear-up double slam: rears onto its hind legs roaring with the forepaws up, then slams both down together as it lunges | 1.00 [0.583], leap: deep crouch, jumps forward with the forelegs reaching and every foot off the ground, lands stabbing down with forelegs and fangs | 1.08 [0.583], tail lash: coils with the tail cocked right, then whips the body round so the tail cracks across to the front-left |
| `Hit` | 0.33, jolt back, head flinch | 0.33, jolt back, forelegs up | 0.33, jolt back and roll, jaw open |
| `Death` | 1.50, rears, forelegs buckle, crashes onto its right side | 1.17, twitches, curls its legs in, rolls onto its back with the curled legs up | 1.25, thrashes, rolls belly-up, jaw slack |
| `Alert` | 1.00, head up to sniff, then low with two jaw-popping huffs as both forepaws slap the ground | 0.83, threat display: rears with the forelegs high and spread, fangs flared, swaying | 0.83, rises on its forelegs, jaw gaping in a trembling hiss, tail raised and lashing |

Unlike the others, the spider and marsh lurker die on their backs. Feet and bodies stay within a few centimetres of the ground through every clip; the bear's leap-free slam moves the body forward over its hind feet and back.

## Conventions

- Metres, +Y up, right-handed. The head faces **+Z**. The origin is the centre of the idle footprint on the ground (y = 0).
- One root node per GLB, named by the key. It carries the uniform scale and turn.
- **In-place** clips: `Idle`, `Walk` and `Eat` on every animal, `Fly` on the four birds and the [combat clips](#combat-clips-715) on the wolf, boar, rat, bear, spider and marsh lurker (the walk's measured travel is below 1 mm). Every clip loops except the one-shot `Attack_A`, `Attack_B`, `Hit`, `Death` and `Alert`. `Fly` is posed at standing height; a consumer lifts the root into the air, moves it itself and may speed up the walk to match its pace.

## Build

```sh
git lfs pull --include="assets/canonical/quaternius.ultimate-animated-animals-*/**,assets/canonical/quaternius.easy-enemy-rat-glb/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-wildlife.ts --out .artifacts/greyhaven-wildlife
```

[`scripts/build-greyhaven-wildlife.ts`](../scripts/build-greyhaven-wildlife.ts) imports each pinned payload from canonical storage (offline, hash-verified), runs [`adapters/blender/wildlife.py`](../adapters/blender/wildlife.py) once per animal through `external.blender.script@1` with the farm-animals recipe as its declared Python input `farm` (the authored animals take no source input), checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `greyhaven.wildlife.tar`, `export.ref.json`, `greyhaven.wildlife.descriptor.json` and `lineage.json`. A rebuild packs the same tar bytes; it takes about fifteen seconds.

`wildlife.prepare(animal, source_path)` also runs in a live Blender after `wildlife.use_farm(<farm_animals module dict>)` (`source_path` is `None` for the authored animals). The tables in the recipe (`ANIMALS`, `SOURCE_CLIPS`, `LAYERED`, `CONTACT_FRAMES`, `BIRD_SPECS`, `BIRD_MOTION`, `CLIP_FRAMES`) hold the heights, the source clips kept, the layered clips' sources and time warps, the attacks' contact frames, the birds' proportions and colours, and the clip lengths.

## Descriptor `greyhaven-wildlife-descriptor-v1`

Attached as `wildlife-descriptor` to `greyhaven.wild.stag/default` and written beside the tar. It has the farm descriptor's shape: the conventions, the clip names (`names`, the `required` `Idle`, `Walk` and `Eat`, the `birds`' extra `Fly`, the `hostile` creatures' combat clips and which are `oneShot`), and per animal its key, whether it is a `bird` and `hostile`, `idleBounds`, `size`, `triangles`, `joints`, per clip its `seconds`, `loop`, source clip name (`authored` for the original animals, `<clip>+layer` for a layered one) and, on attacks, `contactSeconds`, then `walkTravel` and provenance.

## Release

CI publishes the rolling `greyhaven-wildlife` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/greyhaven-wildlife.json` holds its budget (96 materials, 8 MB; measured 80 materials and 6.5 MB).

`test/blender/greyhaven-wildlife/` builds the real bundle and checks the keys, one skin with every mesh skinned and the expected clips per animal, one-shot attacks that land inside their clip, a death of at least a second, grounded and centred bounds, the +Z facing, the heights, in-place walks, the triangle counts, provenance and a byte-identical replay. It skips without Blender or with unhydrated sources.

Review renders at the Greyhaven game camera (12 m, 0.42 rad pitch, 50° field of view), a close-up, the birds in flight and the hostile creatures' attack contacts, alert and final death pose (`combat-game-camera.jpg` for the wolf, boar and rat, `combat-game-camera-722.jpg` for the bear, spider and marsh lurker, the same crop for each so their sizes compare) are in [`review/greyhaven-wildlife/`](../review/greyhaven-wildlife/).
