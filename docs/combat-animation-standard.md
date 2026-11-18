# Combat animation standard

This is the bar every attack clip on the Ranger rig has to meet ([#737](https://github.com/moritzbrantner/asset-tooling/issues/737)). The owner's review of the first combat clips (2026-11-17) found them "functional prototypes, but they don't yet feel like convincing combat animations. The character moves through poses without conveying enough force, momentum, or physical commitment". The standard fixes what that review named, and three reference clips show it:

| Clip | Weapon | What it is the reference for |
| --- | --- | --- |
| `Sword_Regular_A` | arming sword and heater shield | fast one-handed attacks |
| `TwoHand_Swing_A` | maul | weight |
| `Spear_Thrust_B` | leaf spear | lunges |

Phase 2 ([#738](https://github.com/moritzbrantner/asset-tooling/issues/738)) applies the standard to every other attack once the owner has checked the references.

## Principles

**The whole body strikes.** Force runs up a chain: feet, hips, torso, shoulders, arms and then the weapon. Each link starts a moment before the next and the hand arrives last. The legs and hips drive every significant attack, so attacks are full-body clips, not upper-body layers. Fencing studies find the expert lunge's power in the rear leg, which extends hip, knee and then ankle ([Mulloy et al., ISBS](https://ojs.ub.uni-konstanz.de/cpa/article/view/6606)), and HEMA teachers put the cut's power in the legs, hips and core rather than the wrist ([Academie Duello](https://www.academieduello.com/?p=4434)).

**The feet do something.** They plant, shift the weight, lunge, step in or pivot. A planted foot stays locked: it does not slide while the body moves over it. The rear heel may lift about the ball as the rear leg pushes.

**Timing is never even.** The phases are:

1. **Wind-up:** readable. The body loads (the knees bend, the hips coil, the weight goes back) and the weapon draws back. A heavy weapon holds at the top for a few frames.
2. **Strike:** much faster than the wind-up. The hips fire first, the chest follows and the weapon whips through over three or four frames.
3. **Contact:** one distinct frame. The lead foot has just planted, the body is committed and the weapon is at its target.
4. **Follow-through:** the weapon carries on past the target, slowing, and drags the body with it in proportion to its weight.
5. **Recovery:** back to a combat-ready stance, which is the family's guard and never a relaxed idle. Its speed fits the weapon: quick for a sword, a heave for a maul.

The clip records the phase boundaries in its `strike` object: `windupEnd`, `contactSeconds` and `recoveryStart`. A consumer aligns hit detection with `contactSeconds` and can add hitstop there.

**The weapon stays out of the body.** The blade, haft or butt never passes through the torso, head or thighs. Only the hands touch it. A long weapon's far end (a spear's butt, a maul's haft end) needs the most care, because it swings on the far side of the hands.

## Weapon families

| Family | Style |
| --- | --- |
| Sword (one-handed, with shield) | A clean cutting arc that leads with the edge. The lead foot steps in and is planted as the blade lands. The hips turn before the chest and the arm, and the shield stays up. A light strike is short, with no long hold. |
| Dagger | Agile and close. Short steps, quick in and out, both hands working. The power comes from the hips over a short range, not big arcs. |
| Spear | Keeps its distance. The rear foot pushes (heel up, rear leg straightening) and the lead foot steps into a lunge. The front knee catches the weight. The point travels along one straight line while the shaft slides through the lead hand until the hands meet. The recovery pulls back out of range. |
| Staff | Two-handed rotational arcs. Both ends work, the hands drive in opposition and the hips turn through each arc. |
| Hammer and maul | Commits its weight. The knees bend and the hips load while the weapon goes up and back, with a hold at the top. Then the lead foot stamps, the body drops and the head accelerates. The follow-through drags the body low, and the recovery heaves it back up. The sledgehammer advice is the same: the power comes from the hips and a knee bend, not the arms ([engineerfix](https://engineerfix.com/how-to-choose-and-use-a-husky-sledge-hammer/), [stack.com](https://www.stack.com/?p=132174)). |
| Unarmed | The feet and hips throw the punch. The rear heel turns on a cross and the guard hand stays at the chin. |

## How the references are made

[`adapters/blender/strike_clips.py`](../adapters/blender/strike_clips.py) authors them as `kind: "body"` strikes. Each key places the weapon hand's grip (`g`) and the weapon's direction (`b`), the chest (`yaw`, `pitch`) and the body:

- `hy`, `hp`, `hr`: the pelvis's yaw, pitch and roll;
- `px`, `py`, `pz`: the pelvis's offset (in Blender's axes, -Y is forward);
- `lx`/`ly`/`lz` and `rx`/`ry`/`rz`: each foot's ball, moved from where it stands in the idle;
- `lw`/`rw`: each foot's turn about its ball;
- `lh`/`rh`: each heel's lift.

A field that a key leaves out holds its value from the previous key. The body tracks never overshoot a key, so a foot keyed in one place stays exactly there. The legs reach their feet with two-bone IK and the head stays on the target while the hips turn. `windup`, `contact` and `recovery` mark the phases as fractions of the clip, and `plants` lists the spans in which each foot is planted.

| Clip | Length | Layer | Wind-up ends | Contact | Recovery starts | Reach, band |
| --- | --- | --- | --- | --- | --- | --- |
| `Sword_Regular_A` | 0.9 s | full body | 0.267 s | 0.4 s | 0.533 s | 1.22 m, mid |
| `TwoHand_Swing_A` | 1.5 s | full body | 0.5 s | 0.667 s | 0.9 s | 1.07 m, mid |
| `Spear_Thrust_B` | 0.9 s | full body | 0.333 s | 0.467 s | 0.567 s | 2.25 m, high |

**For the game:** these three clips were `spine_01` upper-body layers (the library `Sword_Regular_A` was already full body) and are full body now. Play them on the whole skeleton, not over the locomotion legs. They are in place, but the body travels inside the clip (the spear's pelvis moves 0.35 m forward at contact), so blend out of a run into them and do not move the root during the attack. Each starts and ends in its family's guard: `Sword_Idle` with the shield up, `TwoHand_Guard_Loop` and `Spear_Guard_Loop` (the hands' keys match those guards), with the knees softly bent. The library `Sword_Regular_A_Rec` is no longer needed after `Sword_Regular_A`, which recovers by itself, but it stays in the bundle.

## The checks

[`src/combat-clip-checks.ts`](../src/combat-clip-checks.ts) checks a built clip. It samples each frame of the clip's glTF channels on the figure's joints. A joint that the clip does not key stands in the first `Idle_Loop` pose, which is what an upper-body clip is layered over. The checks are:

- **Weapon–body clearance:** the held item is a capsule along its grip frame's +Y (`COMBAT_ITEM_CAPSULES`, measured on the published equipment), on its hand socket. The body is four capsules (`BODY_CAPSULES`): the torso from the pelvis to the neck (radius 0.12 m), the head (0.1 m), and each thigh from the hip to the knee (0.075 m). The item is sampled every 2 cm, except within 0.1 m of either hand, where it is held. A clip passes when the deepest point is at most 2 cm inside a capsule. The report names the worst frame, the body part and how far up the item the point is.
- **Planted-foot drift:** for each span in `footPlants`, the foot's ball may move at most 2 cm from where the span starts. An in-place gait's `footPlants` (mmorpg#804) are checked against the ground moving back at its `sourceRootDisplacement` over its length.
- **Timing profile:** the strike point's peak speed between `windupEnd` and the contact must be at least three times its mean speed over the wind-up. A clip without `windupEnd` (every clip from before this standard) takes the slowest frame in the last two thirds before the contact instead, and the report says the end was inferred.

A game interpolates between the keys, so a hand that turns most of a revolution from one key to the next can whip its weapon through the body between two clean keys. With `substeps` (`CLEARANCE_SUBSTEPS`, 4) the clearance check also samples between the keys ([mmorpg#804](https://github.com/moenarch-games/mmorpg/issues/804)). A strike that records no `strike` object is checked with its role family's item (`combatCheckEntry`): the library sword strikes with the arming sword, and the cast recipe's `staff.strike.*` and `mace.strike.*` with the quarterstaff on `hand_r.staff` and the flanged mace on `hand_r.weapon`.

The Ranger build test (`test/humanoid-ranger.test.ts`) runs the checks on every strike clip of the built bundle. Every check must pass for the clips in `RANGER_COMBAT_STANDARD_CLIPS` (`src/ranger-clips.ts`). The test logs the others' reports, and a clip joins the list when phase 2 redoes it. [`test/combat-clip-checks.test.ts`](../test/combat-clip-checks.test.ts) covers the checks themselves on a small stand-in rig.

To check a build or a published release by hand:

```sh
bun scripts/check-combat-clips.ts <character .gltf/.glb or clips .glb> <humanoid-clips.json> <humanoid-sockets.json> [clip ...]
```

Without clip names, the script checks every clip with a `strike` object, the library sword strikes and the staff and mace strikes. It prints one line per clip, or JSON with `--json`. `--between` checks every clip's clearance between its keys; the clips of `RANGER_CLEARANCE_CLIPS` always are.

### The in-game clipping fixes (mmorpg#804)

The game found the weapon inside the torso in four clips that phase 2 has not redone. Each is fixed on its own, keeping its timing and contact, and the build test holds it to the clearance check between its keys (`RANGER_CLEARANCE_CLIPS`; no deeper than the first frame, `startMeters`, for the idle staff), and `Sword_Cleave` also to its planted feet. The male figure's published bundle (before) and this change (after), checked between the keys. The female figure's clips were 6.9 to 14.6 cm into the torso and now clear it too (`Sword_Cleave` by 0.9 cm; `Mace_Swing_B` touches the right thigh's capsule by 0.2 cm, within the tolerance):

| Clip | Cause | Before | After |
| --- | --- | --- | --- |
| `Sword_Cleave` | The blade's direction, eased from the wind-up (pointing back) to the contact (front-left), passed through the chest at 0.42 s. A key at 0.41 s now carries it out round the right side. | 13.4 cm into the torso | 1.3 cm clear; feet 0.1 cm; 3.8× |
| `Staff_Strike_A` | The shaft ran from the thrusting hand back through the chest, and swung through it out of and back into the idle. The guard now crosses before the chest, the thrust's grip is within reach and the staff comes forward upright before it tips into the guard. | 11.9 cm into the torso | clear (the idle staff it starts and ends with stays 2.2 cm into the right thigh's capsule, 7 cm on the female figure); 1.8× (was 0.85×) |
| `Staff_Strike_B` | As the jab, and the follow-through swung the staff's head round behind the body. The foot now sweeps low across the front while the head rises past the right shoulder. | 13.6 cm into the torso | clear (idle first frame as above); 1.8× (was 1.5×) |
| `Mace_Swing_B` | The pommel crossed the chest on the way up to the backhand's wind-up. The mace now lifts before the chest first, and holds a moment at the top. | 6.6 cm into the torso | 4.2 cm clear; 3.1× |

Checking the published references between their keys also finds `Sword_Regular_A`'s blade 11.1 cm into the torso at 0.18 s and `TwoHand_Swing_A`'s haft 3.0 cm into the left thigh at 1.02 s, from forearm turns of up to 178° between keys. Phase 2 fixes that in the recipe (below), and the build test now checks every clip of `RANGER_COMBAT_STANDARD_CLIPS` between its keys as well.

### Before and after

The published `humanoid-ranger-male` bundle (before) and this build (after), from `scripts/check-combat-clips.ts`:

| Clip | Clearance (deepest point) | Planted feet | Strike / wind-up speed |
| --- | --- | --- | --- |
| `Sword_Regular_A` before | 6.3 cm clear | none planted | 3.5× (wind-up end inferred) |
| `Sword_Regular_A` after | 1.8 cm clear | 0.0 cm (both feet) | 4.7× (wind-up 5.8 m/s, strike peak 27.2 m/s) |
| `TwoHand_Swing_A` before | 12.0 cm into the torso (haft end, follow-through) | none planted | 9.0× (inferred) |
| `TwoHand_Swing_A` after | 0.4 cm clear | 0.3 cm (lead foot after its stamp) | 8.2× (3.2 to 26.5 m/s) |
| `Spear_Thrust_B` before | 3.2 cm into the right thigh (butt) | none planted | 0.23× (inferred; the guard snaps in from the idle faster than the thrust) |
| `Spear_Thrust_B` after | 0.2 cm clear | 0.4 cm (lead foot after its recovery step) | 8.9× (1.2 to 10.8 m/s) |

The library `Sword_Regular_A` already cleared the body and struck fast. Its failings are ones the checks cannot see. It is a dashing cut made for root motion (0.83 m of travel), so in place it drops into a deep crouch and turns away. It has no planted lead foot, and it ends with the blade raised, not in a guard: its `_Rec` clip finishes it. Over all 47 strike clips (with the library sword strikes), 37 fail at least one check in the published bundle and 35 in this build, the references now passing; most failures are clearance, with the head and torso the usual victims. Phase 2 starts from that list.

## Phase 2 (#738)

Phase 2 carries the standard to the other attacks, the sword and spear families first (moenarch-games/mmorpg#914 needs distinct sword and spear movesets). They join `RANGER_COMBAT_STANDARD_CLIPS`, except the two running strikes, which have no planted feet and are held to the clearance check in `RANGER_CLEARANCE_CLIPS`.

| Clip | Weapon style | What it is now |
| --- | --- | --- |
| `Sword_Regular_B` (0.8 s) | sword counter | A flat backhand that answers the forehand: chambered over the left shoulder as the hips turn left and the shield drops out of the way, then the right heel turns out and the hips drive right ahead of the chest, the blade sweeping flat across at head height. It was a library clip that dived into a low pose. |
| `Sword_Regular_C` (1.2 s) | sword heavy strike | A stepping vertical chop: the weight back and the blade held a beat high over the head, then a long lead step, the body dropping into it and the blade coming straight down the centre line as the foot plants, staying low a moment before it heaves back into the guard. It was a 2 s library flourish with a spin. |
| `Sword_Run_Strike` | sword | The diagonal cut on the run, now from the sword-and-shield guard and back to it, with the shield swinging out to the left against the cut so it never hides it from behind. |
| `Sword_Jump_Strike` (1 s) | sword | A slash: coiled in the air with the blade cocked over the right shoulder, a diagonal cut a frame after touchdown, and a 0.2 m landing before rising into the guard. |
| `Spear_Thrust_A` (0.7 s) | spear jab | A short lunge: a small draw back on the rear leg, then the rear heel lifts and the leg pushes, the lead foot slides out and the point drives along one line at the belly; held at full reach, then back out of range. It was an upper-body arm extension. |
| `Spear_Run_Strike` | spear | A long thrust off the right shoulder on the stride, from the spear guard and back to it. |
| `Spear_Jump_Strike` (1 s) | spear | A plunge: the spear overhand in the air, driven with both arms into a target on the ground 1.3 m ahead as the feet touch, the knees taking 0.27 m with the chest over the shaft, then wrenched out and up into the guard. |

**Jumping strikes land in the guard.** Every family's jump attack used to end in `Jump_Land`'s same deep crouch (the pelvis 0.46 m down). The recipe's `leap` kind keeps the air from `Jump_Loop` and `Jump_Start`, then lets the legs reach down by IK for the idle's footing, which `Jump_Land`'s first pose stands within 4 cm of. From the touch the feet stay planted and the body keys take over, so each weapon lands as deep as it needs (the sword 0.2 m, the spear's plunge 0.27 m) and rises straight into its guard. The clip records `landSeconds`, `to` (the guard clip at 0 s), the phases and both feet planted from the touch.

**Running strikes go from the guard to the guard.** `Jog_Fwd_Loop`'s arms carry a sword up before the face and a spear back over the right shoulder. A strike that left and rejoined those arms swung the weapon through the head (the sword) or turned the spear half round past the torso, and the swing round was faster than the thrust. The reworked running strikes hold their upper body in the family's guard over the run's legs from the first frame to the last, as every other reworked attack does; the game blends its run's upper body into them.

**No more flips between frames.** Two recipe fixes apply to every strike: the forearm's half of the hand's twist is unwrapped against the last frame's, so it no longer flips half a turn when the twist passes 180°, and a blade keeps leading with the edge it led with instead of rolling half a turn when the swing reverses. The flips were what put `Sword_Regular_A` and `TwoHand_Swing_A` into the body between their keys.

The published `humanoid-ranger-male` bundle (before) and this build (after), from `scripts/check-combat-clips.ts --between` on the strike recipe's output over the published clips:

| Clip | Before | After |
| --- | --- | --- |
| `Sword_Regular_A` | 11.1 cm into the torso | 1.7 cm clear; feet 0.0 cm; 4.7× |
| `Sword_Regular_B` | 13.5 cm clear; no feet planted | 9.6 cm clear; feet 0.0 cm; 3.5× |
| `Sword_Regular_C` | 5.9 cm into the left thigh; no feet planted | 3.0 cm clear; feet 0.0 cm; 6.9× |
| `Sword_Run_Strike` | 10.0 cm into the head | 5.3 cm clear; 7.0× |
| `Sword_Jump_Strike` | 12.3 cm into the head; no feet planted | 2.7 cm clear; feet 0.0 cm; 8.5× |
| `Spear_Thrust_A` | 3.4 cm into the right thigh; 0.22× | 0.9 cm clear; feet 1.0 cm; 9.0× |
| `Spear_Run_Strike` | 10.6 cm into the torso; 0.33× | 3.0 cm clear; 11.6× |
| `Spear_Jump_Strike` | 14.5 cm into the torso; 1.4× | 0.9 cm clear; feet 1.0 cm; 12.6× |
| `TwoHand_Swing_A` | 3.0 cm into the left thigh | 0.1 cm clear (unchanged keys) |

Over the recipe's strike clips (29 before, 31 with `Sword_Regular_B` and `C`), 26 failed a check before and 19 after, and no clip that passed fails now. The mace, two-handed, staff, unarmed, dagger and bow attacks and the family stances are still to come.

## Renders

Before and after at the game camera's angle (0.42 rad pitch from 12 m, zoomed onto the figure), from the side, three-quarter front and behind: [`review/combat-standard/`](../review/combat-standard/). Phase 2 adds a sheet per reworked clip, the columns the guard, the wind-up's end, the contact, the follow-through and the end.
