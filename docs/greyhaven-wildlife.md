# Greyhaven wildlife

The `greyhaven-wildlife` rolling release supplies a stag, a doe, a fox, a rabbit, a wild boar, a crow, a duck, a heron and a songbird for Greyhaven's woods, meadows and river ([#667](https://github.com/moritzbrantner/asset-tooling/issues/667)), and the hostile Timber Wolf, Young Boar and Grain Rat's combat clips ([#715](https://github.com/moritzbrantner/asset-tooling/issues/715), [below](#combat-clips-715)), plus three more hostile creatures with the same combat set: a brown bear, a giant cave spider and a marsh lurker ([#722](https://github.com/moritzbrantner/asset-tooling/issues/722), [below](#bear-spider-and-marsh-lurker-722)), and a forest lynx and a marsh adder with their own stalk-and-pounce and warn-and-strike clips ([#778](https://github.com/moritzbrantner/asset-tooling/issues/778), [below](#forest-lynx-and-marsh-adder-778)), and the combat set for the neutral stag and a new highland ram that fight back when threatened ([#782](https://github.com/moritzbrantner/asset-tooling/issues/782), [below](#stag-and-highland-ram-782)), and a territorial badger, a giant river crayfish and a bog toad with the same combat set ([#783](https://github.com/moritzbrantner/asset-tooling/issues/783), [below](#badger-river-crayfish-and-bog-toad-783)), and a giant cave bat that roosts, flies and dives ([#784](https://github.com/moritzbrantner/asset-tooling/issues/784), [below](#cave-bat-784)). It follows the [farm animals](greyhaven-farm-animals.md) exactly: the same conventions, the same recipe shape and the same plain skinned-glTF clip convention mmorpg already loads. The game owns placement, wandering, flight paths, fleeing, collision and everything else about behaviour.

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
| `greyhaven.wild.lynx` | Original, authored by the recipe (Eurasian lynx) | – | 0.29 × 0.80 × 0.87 | 2,482 | 20 | 4.00 / 1.00 / – / – |
| `greyhaven.wild.marsh-adder` | Original, authored by the recipe (common adder), 1.39 m long | – | 0.40 × 0.19 × 0.42 (coiled) | 2,686 | 17 | 4.00 (`Idle_Coil_Loop`) / 1.00 (`Slither_Loop`) / – / – |
| `greyhaven.wild.highland-ram` | Original, authored by the recipe from the farm goat's (blackface hill ram) | – | 0.65 × 1.00 × 1.30 | 4,112 | 12 | 4.00 / 1.17 / 3.00 / – |
| `greyhaven.wild.badger` | Original, authored by the recipe (European badger) | – | 0.37 × 0.35 × 0.99 | 1,632 | 16 | 3.00 / 1.00 / 2.00 / – |
| `greyhaven.wild.river-crayfish` | Original, authored by the recipe (giant river crayfish) | – | 0.67 × 0.32 × 1.38 | 2,460 | 29 | 2.00 / 1.00 / 2.00 / – |
| `greyhaven.wild.bog-toad` | Original, authored by the recipe (bog toad) | – | 0.54 × 0.35 × 0.82 | 2,256 | 14 | 3.00 / 1.17 / 2.00 / – |
| `greyhaven.wild.cave-bat` | Original, authored by the recipe (giant cave bat), 1.28 m wingspan | – | 1.00 × 0.38 × 0.45 (hovering) | 1,940 | 26 | 1.00 / – / – / 0.42 |

The numbers are from the builds of 2026-11-16 and, for the wolf, rat and combat clips, 2026-11-17 (the bear, spider and marsh lurker too; the lynx and adder 2026-11-19; the highland ram and the stag's combat clips 2026-11-20, as are the badger, crayfish, toad and cave bat); the descriptor carries each build's measurements. The packed tar is about 9.8 MB, mostly sampled animation.

- **Why these sources.** The stag, doe, fox and wolf come from the same Quaternius pack as the farm cow, horse and donkey and the ambient dog, so they share its rig layout and clip names. The wolf is the same `Wolf.glb` bytes mmorpg vendors, and the rat the Easy Enemy `Rat.glb` it vendors (the ambient rodent's source), kept grey and hostile-sized here. Each has an authored `Eating` clip, shipped as `Eat`. The stag's antlers are a separate mesh parented to its head bone in the source; the recipe binds them to that bone as a second skinned mesh, so the stag is still one skin.
- **The rabbit, boar and birds are original.** No catalogued CC0 Quaternius pack has them. Like the farm goat and chicken, they are low-poly rigid parts (ellipsoids and tapered tubes, flat-shaded) on a small armature, every vertex weighted fully to one bone, with plain colour materials and scripted loops. The rabbit's `Walk` is one hop and its `Eat` a head-down nibble; the boar's `Eat` roots with its snout. Every bird shares one eight-bone rig (body, neck, head, tail, two wings, two legs) and one set of clips: `Idle` looks around, `Walk` steps (the songbird hops), `Eat` pecks, and `Fly` unrolls the folded wings flat, sweeps them out and beats them with the legs tucked back.
- **Sizes.** Heights are life-size at the top of the idle pose, antlers and ears included. The songbird is a little larger than a real robin so it stays visible at Greyhaven's 12 m orbit distance, as the ambient rodent is.

## Combat clips (#715)

The wolf, boar and rat fight players, so they also ship a looping in-place `Run` and five one-shot clips. Attacks have an anticipation, a snap and a recovery so they read at the game camera; `contactSeconds` (in the descriptor) is when the bite, tusks or claws land, for the zone's creature melee. Seconds; contact in brackets.

| Clip | Wolf | Boar | Rat |
| --- | --- | --- | --- |
| `Run` (loop) | 0.54, source `Gallop` | 0.67, bounding gallop | 0.50, source `Rat_Run` |
| `Attack_A` | 0.88 [0.375], bite and shake: source `Attack` re-timed, head shaking the prey after the jaws close | 0.83 [0.375], tusk gore: head drops and weight sinks onto the haunches, then it drives off its planted hind feet and rears, forelegs tucked, as the head rips upward; the forefeet land a stride ahead and step back (#736) | 0.75 [0.417], lunge bite: source `Rat_Attack`, longer recovery |
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

## Forest lynx and marsh adder (#778)

The first two new species toward mmorpg's wider set of opponents ([mmorpg#989](https://github.com/moritzbrantner/mmorpg/issues/989), [mmorpg#990](https://github.com/moritzbrantner/mmorpg/issues/990)). Both are `hostile`, but each has its own clip set (the descriptor's `clips.species`) instead of `Eat` and the combat clips above. The only catalogued CC0 cat is the Animal Pack Vol.2 house cat (`Idle` and `Walk` only, a long tail and domestic proportions), and there is no catalogued snake, so both are original like the bear: rigid low-poly parts on a small armature, every clip scripted. Seconds; contact in brackets.

**Forest lynx** (20 joints): tufted black-tipped ears, a pale facial ruff, long legs with broad paws, a black-tipped bobtail and a spotted tawny-grey coat, so at the game camera it reads as a compact, tall-legged, light cat beside the long, dark, long-tailed wolf. Its spine is two bones (`Hips`, `Chest`) that flex in the gallop and the pounce. Each leg is a thigh, a shin and a paw placed every frame by a two-bone solve to its paw, the elbow behind and the stifle ahead, so a planted paw stays exactly where it is while the body moves over it.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Idle` (loop) | 4.00 | Breathes, looks left then right, flicks an ear and the tail |
| `Walk` (loop) | 1.00 | A cat's lateral-sequence walk; `travelSpeed` 0.59 m/s |
| `Run` (loop) | 0.42 | Rotary gallop, the spine gathering and stretching, a suspension after the forepaws leave; `travelSpeed` 2.92 m/s |
| `Crouch_Stalk_Loop` (loop) | 1.50 | Belly low, head level and forward, ears pricked, a slow deliberate stalk; `travelSpeed` 0.21 m/s |
| `Pounce_Windup` | 0.50 | Sinks back onto its haunches with the chest low and eyes fixed ahead, treads its hind paws under itself and wiggles its rump; ends loaded |
| `Pounce_Lunge` | 0.50 [0.333] | Springs off its hind paws at 0.125 s, flies with the forelegs reaching and the jaw open, and strikes down with both forepaws and the bite at the contact, landing its hind paws far back. `rootTravel`: the consumer moves the root 1.37 m in a straight line from 0.125 s to the contact |
| `Pounce_Recover` | 0.83 | Exposed: stays stretched low over the catch with its head down, shaking it, broadside, then gathers its hind paws forward one at a time and rises back into the idle stance |
| `Hit` | 0.33 | Jolts back, head and ears flinch, a snarl; paws planted |
| `Death` | 1.33 | Flinches with a snarl, the hind legs buckle, rolls onto its right side with the lower legs folding in; lies still |

The three pounce clips chain: each ends in the next one's first pose, and `Pounce_Recover` ends in `Idle`'s.

**Marsh adder** (17 joints): a stout 1.39 m viper, olive-grey with the dark dorsal zigzag, dark flank spots and a dark belly, a broad flat head with the crown V, the eye stripe and red eyes, fangs and a forked tongue. Its spine is fourteen equal bones; the body is one smooth tube with each ring weighted between its two nearest bones, so it bends without joints showing. The spine is posed every frame from joint positions, the first bone by a look-at frame and every later one by parallel transport, so the coil or the death roll never flips the pattern.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Idle_Coil_Loop` (loop) | 4.00 | Coiled flat, rings a body's width apart, the neck raised from the inner ring holding the head over the coil; looks aside, flicks its tongue |
| `Slither_Loop` (loop) | 1.00 | Lateral undulation: the body slides along one fixed sine path, so with the root moving at `travelSpeed` 0.46 m/s (a wavelength per loop) every part of it follows the path the head took |
| `Warn_Hiss_Loop` (loop) | 1.33 | The forebody raised 0.2 m in an S, head level, the rest lying in a loose S behind; sways and hisses with the jaw gaping, tongue flicking |
| `Strike` | 0.42 [0.208] | Cocks back for two frames, then the S whips straight: the head shoots about half a metre forward and down with the jaw gaping 70° and bites at the contact. The body behind the eighth joint does not move |
| `Strike_Recover` | 0.83 | Exposed: lies stretched out with its head down for a quarter second, then slowly draws the S back up into the warning posture |
| `Hit` | 0.33 | Kinks sideways, jaw open, the S jolting up |
| `Death` | 1.25 | Writhes, straightens, rolls belly-up along its length and goes limp |

`Warn_Hiss_Loop`, `Strike` and `Strike_Recover` chain the same way. The adder is authored at life size (scale 1); the descriptor gives its `length`, and its rest and move clips (`restClip`, `moveClip`) are `Idle_Coil_Loop` and `Slither_Loop`, which the build uses for the idle bounds and the in-place check.

Measured on the release GLBs with the root motion added back ([`review/greyhaven-creatures-778/check.py`](../review/greyhaven-creatures-778/check.py)): a planted lynx paw slides at most 4 mm in `Walk`, 5 mm in `Crouch_Stalk_Loop` and `Hit`, none in `Run`, `Pounce_Lunge` and `Pounce_Recover`, and 1.6 cm in `Pounce_Windup` while the hind paws tread; the adder's spine strays at most 1.5 cm from its neck's path while slithering; its body never comes closer to itself than 5 cm beyond touching; and nothing sinks more than 1 cm below the ground (the lynx's flinch and death roll, fur pressed into the ground).

## Stag and highland ram (#782)

The stag ([mmorpg#997](https://github.com/moritzbrantner/mmorpg/issues/997)) and the highland ram ([mmorpg#999](https://github.com/moritzbrantner/mmorpg/issues/999)) are neutral (`hostile` false) but fight when threatened, so both carry the combat clips above and the descriptor marks them `combat` (true for every creature with the combat set). Seconds; contact in brackets.

**Stag.** The source `Stag.glb`, its `Idle`, `Walk` and `Eat` and its model unchanged. `Run` is the source `Gallop`; every other combat clip is layered on a source clip. The source rig's hooves are root-level IK bones the legs are only baked to, so the recipe re-solves each leg's two lower bones onto its hoof every frame (`solve_legs`, `STAG_LEGS`): the body and hooves move freely and a planted hoof stays planted. The source clips are sampled over the rest pose, so a bone one leaves unkeyed (the IK hooves in `Idle`) rests there instead of keeping the previous sample. `Attack_A`'s warp blends three source clips (`Idle`, then `Gallop`, then `Idle`).

The attacks, `Alert` and `Hit` were reworked in [#804](https://github.com/moritzbrantner/asset-tooling/issues/804) to the combat animation bar: the hind legs and hips drive, a readable wind-up then a much faster strike with a held contact and follow-through, hooves planted except where they step (lifted), antlers clear of the body, and each recovers into the same alert stance (`stag_stance`: weight a little back, neck raised, antlers presented, tail flagged) rather than idle.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Run` (loop) | 0.50 | Source `Gallop` |
| `Alert` | 1.00 | The head snaps up high in alarm and the tail flags; the right forefoot lifts and stamps hard twice, the weight dropping onto it each time; a snorting head toss; the alert stance |
| `Attack_A` | 1.33 [0.625] | Lowered-antler charge: the weight rocks back and down onto the haunches as the antlers drop at the threat and the right forefoot paws twice; a lowered-head gallop in place; the hind legs drive out behind as the body lunges forward and down and the antlers ram in at the contact on braced forefeet; a hard upward hook as the body rides up over the planted hooves; the forefeet then the hind feet step back under it, a head shake, the alert stance. `rootTravel`: the consumer moves the root 2.0 m from 0.333 s to the contact |
| `Attack_B` | 1.08 [0.542] | Rearing antler swipe: sinks onto the haunches with the head cocked right, rears about the hips with the forelegs tucked, then drops and twists left, raking the lowered antlers down and across the front; the contact as the forefeet land braced ahead; follow-through, the forefeet step back, the alert stance. In place |
| `Hit` | 0.50 | Source `Idle_HitReact_Left` with the whole body jolted back and away, the head and antlers snapping up and aside, the right hind hoof stepping back to catch the weight; the alert stance |
| `Death` | 1.08 | Source `Death`, the head turned as it lands so the antlers lie on the ground beside the neck, clear of the body, body and hooves lifted out of the ground the source sinks them into |

**Highland ram** (12 joints): a blackface hill ram adapted from the farm goat's recipe (its rig layout, part shapes and clip helpers; [farm animals](greyhaven-farm-animals.md)) and rebuilt as a different animal: stout and low, a shaggy cream fleece hanging off the flanks in two ragged rows of locks, a woolly ruff, a black face and legs with a pale muzzle and amber eyes, and heavy ridged horns that curl up and back from the poll, swing out clear of the neck, down behind the ear and forward past the cheek. It is smooth-shaded but for the hooves. Its legs are placed by the boar's two-bone solve to their feet wherever the body moves, so planted hooves stay on the ground. The farm goats are unchanged and do not fight.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Idle` (loop) | 4.00 | Chews the cud, looks slowly round, flicks its tail |
| `Walk` (loop) | 1.17 | Four-beat walk |
| `Eat` (loop) | 3.00 | Head down in the grass, cropping in short tugs |
| `Run` (loop) | 0.58 | Bounding gallop |
| `Alert` | 1.00 | The warning: head lowered to present the horns, weight back, the right forefoot stamps twice and the left once, a snort shakes the head |
| `Attack_A` | 0.92 [0.458] | Rear and butt: rocks back and rears onto its hind legs, forelegs tucked, then throws its whole weight forward and down so the horns smash in, forefeet landing braced a stride ahead; shakes it off and steps back |
| `Attack_B` | 1.25 [0.542] | Short charge: head lowered and a forefoot scrape, a bounding rush in place, the head driven in at the contact with the forelegs braced and the hind legs thrust out, a rebound and an exposed, dazed head-shaking recovery. `rootTravel`: the consumer moves the root 1.6 m from 0.25 s to the contact |
| `Hit` | 0.33 | Jolts back, head flinches up and aside |
| `Death` | 1.33 | Staggers, the forelegs buckle, a heavy roll onto its right side; lies still |

**Organic surface.** Both follow [#779](https://github.com/moritzbrantner/asset-tooling/issues/779)'s direction rather than plain colour: each coat, wool, horn and antler material multiplies its colour by a small tileable greyscale detail texture the recipe generates (`ORGANIC`, 128 × 128 PNG, glTF `baseColorTexture` times `baseColorFactor`), with roughness 0.6–0.95 and metallic 0: short streaked hair, clumped wool locks darker in the creases, the horns' growth rings (UV-mapped round their curl) and grooved antlers. The other meshes are box-projected at the shipped size. The rest of the wildlife has followed since ([below](#organic-surface-779)).

Measured on the release GLBs ([`review/greyhaven-wildlife-782/check.py`](../review/greyhaven-wildlife-782/check.py)): nothing of the ram sinks more than 3.2 cm below the ground in any clip (its hoof rims as the legs tilt, and the fringe mid-roll), nothing of the stag's combat clips more than 3.4 cm (in `Attack_A`'s gallop; the source `Gallop` itself dips 3.8 cm; #804), and both dead animals rest on the ground. Review sheets are in [`review/greyhaven-wildlife-782/`](../review/greyhaven-wildlife-782/), the reworked stag clips' in [`review/greyhaven-wildlife-804/`](../review/greyhaven-wildlife-804/).

## Badger, river crayfish and bog toad (#783)

Three grounded fighters for mmorpg's [badger at Millbrook](https://github.com/moritzbrantner/mmorpg/issues/998), [crayfish at Fenwater](https://github.com/moritzbrantner/mmorpg/issues/996) and [bog toad in the wetlands](https://github.com/moritzbrantner/mmorpg/issues/1000), each with `Idle`, `Walk`, `Eat` and the full combat set. The badger is neutral and fights when threatened (`hostile` false, `combat` true, like the stag); the crayfish and toad are `hostile`. No catalogued CC0 source has any of them, so all three are original like the bear: rigid parts on a small armature, every clip scripted, with the [organic surface](#organic-surface-779) from the start. Projectiles, slows, facing rules and placement are the game's. Seconds; contact in brackets.

**Badger** (16 joints): low and broad, a grizzled grey coat with long guard hair hanging off the flanks, black legs and belly, and a white head with a black stripe from each ear over the eye to the nose. Each leg is solved to its foot (the boar's two-bone solve) with a level paw on its own bone, so the long digging claws never dig in.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Idle` (loop) | 3.00 | Snuffles, the striped head swinging low from side to side |
| `Walk` (loop) | 1.00 | A rolling waddle, head low |
| `Eat` (loop) | 2.00 | Digs: snout at the earth, the forepaws scraping it back in turn |
| `Run` (loop) | 0.50 | A scurrying bound |
| `Alert` | 1.00 | The defensive crouch: drops low on its haunches, head low and forward, growling with the jaw open; bluffs forward twice, stamping both forepaws, and holds its ground |
| `Attack_A` | 0.67 [0.292] | Quick bite: gathers back as the jaw opens, darts in low and snaps shut, then worries with a head shake and backs off |
| `Attack_B` | 0.92 [0.458] | Claw rake: rocks back and rears off its forepaws, the right paw cocked out wide, then drives down so the claws rake in across the front as the body twists behind them; the left paw slams down after, the jaw snapping |
| `Hit` | 0.33 | Jolts back, head flinching, jaw open |
| `Death` | 1.33 | A last snarl, the legs buckle and it rolls heavily onto its right side |

**Giant river crayfish** (29 joints): a broad, dull olive-brown carapace with a cervical groove and median ridge, a segmented tail with side plates and the tail fan, long whip antennae, rust-red chitin claws with pale tips and four pairs of walking legs. The claws differ: the right is a heavy crusher (1.6 times the base size), the left a slimmer cutter with longer fingers (1.1); on each the outer finger (`Finger`) opens. The walking legs are solved to their feet each frame (the spider's solve, shared as `solve_feet`), so planted feet stay planted and each foot swings out to the side as it steps.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Idle` (loop) | 2.00 | Antennae sweeping, the claws opening and closing slowly |
| `Walk` (loop) | 1.00 | Alternating legs, each swung forward and out as it lifts; the body rolls |
| `Eat` (loop) | 2.00 | Each claw in turn tears at the riverbed and lifts a morsel to the mouthparts |
| `Run` (loop) | 0.50 | Fast scuttle, body low, claws tucked |
| `Alert` | 1.00 | The warning: both claws lift high and wide with the fingers gaping, the body rears on its legs and the raised claws tremble |
| `Attack_A` | 1.25 [0.750] | The committed pinch: a slow warning lift of both claws, held trembling for a quarter second (0.42 to 0.62 s), then a lunge in which the crusher drives down and in and slams shut, a yank, and it lets go |
| `Attack_B` | 1.00 [0.500] | Scissor clamp: both claws swing out wide, fingers open, then sweep in together and clamp across the front as the body surges and twists |
| `Hit` | 0.33 | Jolts back, claws flinching up, tail flicking up |
| `Death` | 1.25 | Claws flail, legs curl in, rolls onto its back, claws splayed |

**Bog toad** (14 joints): broad and squat, warty olive-brown hide with dark blotches and raised warts, swollen parotoid glands behind the eyes, copper eyes with dark pupils, a cream belly and a pale yellow throat pouch. The pouch (`Throat`) is the one bone keyed with scale: it pumps as the toad breathes and swells before the spit. The arms are solved to the hands and the hind legs, folded alongside the body, to the ankles, with the hind feet kept flat on the ground.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Idle` (loop) | 3.00 | Sits breathing, the throat pumping, turns its head |
| `Walk` (loop) | 1.17 | A toad's crawl on diagonal pairs, the body swinging side to side |
| `Eat` (loop) | 2.00 | Snaps at a fly on the ground and gulps it, the throat bulging |
| `Run` (loop) | 0.58 | One hop per loop in place: crouch, push off the hind legs, flight, landing on the forelegs |
| `Alert` | 1.00 | The defensive puff: rises stiff-legged, tips forward to present the glands, the throat inflated, swaying |
| `Attack_A` | 1.00 [0.542] | The spit: draws back on its haunches with the head tipped up and the throat swelling in pumps, then snaps forward with the jaw gaping as the glob leaves at the contact and the throat empties |
| `Attack_B` | 1.00 [0.583] | The hop-bite: a crouch, a short hop and the jaw snapping on the landing. `rootTravel`: the consumer moves the root 0.6 m from 0.25 s to the contact |
| `Hit` | 0.33 | Jolts back, head up, jaw open |
| `Death` | 1.25 | Puffs up, convulses, rolls belly-up and goes limp |

Measured on the built GLBs ([`review/greyhaven-wildlife-783/check.py`](../review/greyhaven-wildlife-783/check.py)): nothing sinks more than 3 cm below the ground in any clip (the badger's rake as its jaw comes down and its paws mid-roll, the toad's crawl and death roll), and each dead animal rests on the ground. The crayfish's shell (`chitin`) is roughness 0.75 to 0.8 and the toad's hide 0.6, every material metallic 0. Review sheets are in [`review/greyhaven-wildlife-783/`](../review/greyhaven-wildlife-783/).

## Cave bat (#784)

A giant cave bat for mmorpg's bounded aerial encounter in Greyfang Cave ([mmorpg#995](https://github.com/moritzbrantner/mmorpg/issues/995)): `hostile`, with its own clip set (`clips.species`). No catalogued CC0 source has a bat, so it is original like the bear, authored at life size (scale 1): a small furred body with a broad chest and a dark mantle, a snub face with a nose-leaf, fangs and big ears, and two broad leather wings 1.28 m across, each an arm, a forearm and three digits (26 joints, 1,940 triangles). The membrane is one thin double-sided sheet per panel (between the digits, from the fifth digit back to the ankle, in front of the elbow, and the tail membrane), every vertex weighted between the bones it lies between. Linear skinning cannot carry the wide plagiopatagium through a 140° fold, so four helper bones per wing (`Mem1`–`Mem4`, `BAT_MEMBRANE`) sit inside it and are posed every frame where the posed arm, forearm, fifth digit and ankle put that spot of the sheet: the membrane stretches open in flight and folds flat against the flank at the roost. A fold is a blend toward a folded frame per wing bone (`BAT_FOLDED`): the arm back and down, the forearm forward along the side and the digits laid back along it.

**Origin.** The game moves the bat through the air, so unlike every other animal its origin is its centre (the Body bone), not the ground, and every clip is posed in place around it. The descriptor's `flight` gives what the consumer needs to place it: `origin` `body`, `gripHeight` (0.17 m: in `Perch` it hangs from its toes this far above the origin, so the roost point is the origin plus that), `groundHeight` (0.06 m: once the dead bat lies still the origin is this far above the ground), `landSeconds` (0.583: when the falling dead bat reaches the ground) and `wingspan` (1.28 m, the widest `Fly` frame). The collision box is around the hovering `Idle` (its `restClip`; `moveClip` is `Fly`). Flight paths, the dive line, wall and ceiling clearance and hits are the game's.

| Clip | Seconds | Motion |
| --- | --- | --- |
| `Perch` (loop) | 4.00 | Hangs head down from its toes, wings folded flat and wrapped round the body, tail tucked; lifts its head and looks round, flicks its ears, and once a loop half opens the left wing in a stretch |
| `Launch` | 0.67 | Lets go and drops head first, the wings snapping open as it swings out of the drop with one hard downstroke into level flight; ends in `Fly`'s first pose |
| `Idle` (loop) | 1.00 | Hovers on the spot, body tipped up, the wings sculling forward and back, head level and looking round |
| `Fly` (loop) | 0.42 | A bat's wingbeat: the extended wings sweep down and forward, then flex at the elbow and wrist and rise up and back; the body lifts on each downstroke, the legs trail |
| `Dive_Windup` | 0.50 | The telegraph: one big flaring stroke up into an upright hover facing the target, wings spread wide and forward round it, ears pinned and jaw gaping in a trembling hiss held for a fifth of a second; then it tips nose-down and half-folds the wings back, loaded |
| `Dive_Contact` | 0.50 [0.333] | One hard downstroke drives it off, then the wings sweep back tight and the head stretches out as it stoops; at the contact the wings fling open forward round the target, the body pitches up, the feet rake forward and the jaw snaps shut; one braking downstroke follows. `rootTravel`: the consumer moves the root 2.4 m along its dive line from 0 s to the contact (posed for a descent of about 35°) |
| `Dive_Recover` | 0.83 | Exposed: two heavy, labouring wingbeats, sinking on the first and shaking its head after the bite, before it climbs back into `Fly`'s first pose |
| `Land` | 0.67 | Flares nose-up and brakes with the wings thrown forward, swings its feet up to the roost in a backward half cartwheel and folds its wings round itself; ends in `Perch`'s first pose |
| `Hit` | 0.33 | Jolts back and rolls, the wings buckling up, head flinching, jaw open; back to `Fly`'s first pose |
| `Death` | 1.25 | A jolt and a shriek, the wings crumple and flail as it tumbles over once and falls; it lands belly-down at `landSeconds` with the wings spread askew, bounces, a last twitch of the left wing, and lies still |

`Dive_Windup`, `Dive_Contact` and `Dive_Recover` chain, as do `Perch` → `Launch` → `Fly` → `Land` → `Perch`. The fur is the streaked `hair` detail, and the wings and ears a tenth detail texture, `membrane`: fine elastin wrinkles across the span, a faint vein network and a soft mottle, warm dark brown, roughness 0.78 and metallic 0, so they read as dull leather rather than plastic. Measured on the built GLB: the dead bat lies with its belly and wing tips on the ground (the lowest wing tip 7 mm below the belly), and in `Perch` the toes are its highest point. Review sheets at the game camera, with the consumer's flight path added back, are in [`review/greyhaven-wildlife-784/`](../review/greyhaven-wildlife-784/).

## Organic surface (#779)

The animals used to read as shaped metal at the game camera ([#779](https://github.com/moritzbrantner/asset-tooling/issues/779)). Read from the shipped GLBs, two things caused it:

- **Metallic sources.** The Quaternius wolf, doe, fox and rat (and two stag materials, among them its main coat) passed the sources' metallic 0.4 and roughness 0.415 straight through, which a PBR renderer with image-based lighting draws as dull metal. No wildlife material was empty (the farm pig's and sheep's cause, #781).
- **Flat, faceted solids.** The authored animals were metallic 0 but one flat colour per material on flat-shaded low-poly ellipsoids and tubes, so every facet caught the light like a polished plate.

`ORGANIC` now lists every material of every animal: metallic 0, roughness 0.2 (eyes) to 0.95 (bear and boar coats), and a detail texture on each coat, skin, hide, chitin, scale and feather material. The textures are generated by the recipe (128 × 128 PNG, glTF `baseColorTexture` times `baseColorFactor`, box-projected UVs in metres) and shared by kind, so the bundle carries each once: streaked `hair` (wolf, fox, doe, stag, rat, rabbit, boar, bear, lynx), `wool` and `horn` (ram, tusks, claws), `antler`, mottled `skin` (snouts, mouths, the lurker's belly, bird legs), the lurker's warty `hide`, the spider's banded, bristled `chitin`, the adder's staggered `scales` and the birds' overlapping `feather` rows. Markings stay in their own materials (the lynx's spots, the adder's zigzag, the wolf's and fox's pale undersides). The authored animals but the ram (which sets its own) shade smooth below 75° creases, keeping tube caps sharp. Geometry, rigs, clips, contact timing and collision boxes are unchanged.

Before/after stills at the game camera are in [`review/greyhaven-wildlife-779/`](../review/greyhaven-wildlife-779/).

## Conventions

- Metres, +Y up, right-handed. The head faces **+Z**. The origin is the centre of the idle footprint on the ground (y = 0), but for the cave bat, whose origin is its centre ([`flight`](#cave-bat-784)).
- One root node per GLB, named by the key. It carries the uniform scale and turn.
- **In-place** clips: `Idle`, `Walk` and `Eat` on every animal, `Fly` on the four birds and the [combat clips](#combat-clips-715) on the wolf, boar, rat, bear, spider, marsh lurker, stag, highland ram, badger, river crayfish and bog toad, and the [lynx's and adder's own sets](#forest-lynx-and-marsh-adder-778) and the [bat's](#cave-bat-784) (the walk's measured travel is below 1 mm). Every clip loops except the one-shot `Attack_A`, `Attack_B`, `Hit`, `Death`, `Alert`, `Pounce_Windup`, `Pounce_Lunge`, `Pounce_Recover`, `Strike`, `Strike_Recover`, `Launch`, `Land`, `Dive_Windup`, `Dive_Contact` and `Dive_Recover`. Where a clip travels, the descriptor says how the consumer moves the root: `travelSpeed` (m/s) on a gait, `rootTravel` (metres, from `startSeconds` to `endSeconds`) on the pounce, the stag's and ram's charges, the toad's hop and the bat's dive. `Fly` is posed at standing height; a consumer lifts the root into the air, moves it itself and may speed up the walk to match its pace.

## Build

```sh
git lfs pull --include="assets/canonical/quaternius.ultimate-animated-animals-*/**,assets/canonical/quaternius.easy-enemy-rat-glb/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-wildlife.ts --out .artifacts/greyhaven-wildlife
```

[`scripts/build-greyhaven-wildlife.ts`](../scripts/build-greyhaven-wildlife.ts) imports each pinned payload from canonical storage (offline, hash-verified), runs [`adapters/blender/wildlife.py`](../adapters/blender/wildlife.py) once per animal through `external.blender.script@1` with the farm-animals recipe as its declared Python input `farm` (the authored animals take no source input), checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `greyhaven.wildlife.tar`, `export.ref.json`, `greyhaven.wildlife.descriptor.json` and `lineage.json`. A rebuild packs the same tar bytes; it takes about fifteen seconds.

`wildlife.prepare(animal, source_path)` also runs in a live Blender after `wildlife.use_farm(<farm_animals module dict>)` (`source_path` is `None` for the authored animals). The tables in the recipe (`ANIMALS`, `SOURCE_CLIPS`, `LAYERED`, `CONTACT_FRAMES`, `BIRD_SPECS`, `BIRD_MOTION`, `LYNX_GAITS`, `LYNX_POUNCE`, `ADDER_SLITHER`, `CHARGES`, `CRAYFISH_LEGS`, `CRAYFISH_CLAWS`, `BAT_WING`, `BAT_FOLDED`, `BAT_MEMBRANE`, `ORGANIC`, `CLIP_FRAMES`) hold the heights, the source clips kept, the layered clips' sources and time warps, the attacks' contact frames, the birds' proportions and colours, the lynx's gaits and pounce, the adder's slither, the stag's and ram's charges, the toad's hop and the bat's dive, the crayfish's legs and claws, the bat's wing, its folded wing and its membrane's helper bones, the detail textures and the clip lengths.

## Descriptor `greyhaven-wildlife-descriptor-v1`

Attached as `wildlife-descriptor` to `greyhaven.wild.stag/default` and written beside the tar. It has the farm descriptor's shape: the conventions, the clip names (`names`, the `required` `Idle`, `Walk` and `Eat`, the `birds`' extra `Fly`, the `hostile` creatures' combat clips, the lynx's, adder's and bat's own `species` sets and which are `oneShot`), and per animal its key, whether it is a `bird`, `hostile` and carries the combat clips (`combat`, #782), `idleBounds`, `size`, `triangles`, `joints`, per clip its `seconds`, `loop`, source clip name (`authored` for the original animals, `<clip>+layer` for a layered one, `<clip>+<clip>+layer` for one blended from several) and, on attacks, `contactSeconds`, on travelling clips `travelSpeed` or `rootTravel`, then `walkTravel`, the `restClip` and `moveClip` (`Idle` and `Walk` but for the adder and the bat), the adder's `length`, the bat's `flight` (#784), a `collisionProxy` (a box around the rest pose, glTF axes: `center` and `size`) and provenance.

## Release

CI publishes the rolling `greyhaven-wildlife` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/greyhaven-wildlife.json` holds its budget: 122 materials, 1 MB of textures, 10 MB download (measured 122 materials, 0.83 MB of textures in the ten shared detail textures and 9.72 MB with the cave bat, #784, which adds 7 materials and the `membrane` texture; the badger, river crayfish and bog toad added 19 materials and no texture, #783).

`test/blender/greyhaven-wildlife/` builds the real bundle and checks the keys, one skin with every mesh skinned and the expected clips per animal, one-shot attacks that land inside their clip, a death of at least a second, grounded and centred bounds, the +Z facing, the heights (the adder's length), the collision boxes, the lynx's and adder's root motion, the stag's and ram's charges, the toad's hop and the `combat` flag, the bat's centre origin, `flight` and dive, in-place walks, the triangle counts, provenance and a byte-identical replay. It skips without Blender or with unhydrated sources.

Review renders at the Greyhaven game camera (12 m, 0.42 rad pitch, 50° field of view; the bat's in [`review/greyhaven-wildlife-784/`](../review/greyhaven-wildlife-784/)), a close-up, the birds in flight and the hostile creatures' attack contacts, alert and final death pose (`combat-game-camera.jpg` for the wolf, boar and rat, `combat-game-camera-722.jpg` for the bear, spider and marsh lurker, the same crop for each so their sizes compare) are in [`review/greyhaven-wildlife/`](../review/greyhaven-wildlife/). The lynx and adder have theirs in [`review/greyhaven-creatures-778/`](../review/greyhaven-creatures-778/): each one's wind-up → strike → recovery strip, every clip, the gaits with their travel added back and both beside the wolf at the game camera.
