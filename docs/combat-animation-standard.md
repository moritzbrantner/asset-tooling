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
- **Planted-foot drift:** for each span in `footPlants`, the foot's ball may move at most 2 cm from where the span starts.
- **Timing profile:** the strike point's peak speed between `windupEnd` and the contact must be at least three times its mean speed over the wind-up. A clip without `windupEnd` (every clip from before this standard) takes the slowest frame in the last two thirds before the contact instead, and the report says the end was inferred.

The Ranger build test (`test/humanoid-ranger.test.ts`) runs the checks on every strike clip of the built bundle. Every check must pass for the clips in `RANGER_COMBAT_STANDARD_CLIPS` (`src/ranger-clips.ts`). The test logs the others' reports, and a clip joins the list when phase 2 redoes it. [`test/combat-clip-checks.test.ts`](../test/combat-clip-checks.test.ts) covers the checks themselves on a small stand-in rig.

To check a build or a published release by hand:

```sh
bun scripts/check-combat-clips.ts <character .gltf/.glb or clips .glb> <humanoid-clips.json> <humanoid-sockets.json> [clip ...]
```

Without clip names, the script checks every clip with a `strike` object and the library sword strikes. It prints one line per clip, or JSON with `--json`.

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

## Renders

Before and after at the game camera's angle (0.42 rad pitch from 12 m, zoomed onto the figure), from the side, three-quarter front and behind: [`review/combat-standard/`](../review/combat-standard/).
