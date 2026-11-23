// The Ranger's authored clips (#425): the clip names of each family and the family table the build runs, one Blender
// run per family. Adding a family is one table row plus its Blender recipe; adding a clip is one name.
import { ARCHERY_PRESETS } from "./archery-recipes.js";
import { WEAPON_PRESETS } from "./weapon-recipes.js";
import { rideArguments } from "./mounts.js";

type Json = Record<string, any>;

/**
 * #112, #399 (owner answers 2026-10-18 and 2026-10-29, Atlas 6.1.7): original directional gaits, walk start/stop and
 * turns authored in Blender (adapters/blender/gait_clips.py) from the CC0 UAL1 `Jog_Fwd_Loop`, `Walk_Loop` and
 * `Idle_Loop` and explicit foot trajectories. The walk and jog clips are one matched family (same stance, the same
 * swing phases at foot plant). No Mixamo data. They follow the library clips in bundle order. #804: `Run_Fwd_Loop` and
 * the `Run_Strafe_*_Loop` side-runs are a stride authored at the game's 6.3 m/s run, over the `Sprint_Loop` arms.
 * #823: `Heavy_Run_Fwd_Loop` is the heavy run at the same speed, for a heavy weapon or load: a shorter stride (so a
 * quicker cadence), a longer ground contact and a low, flat flight, the hips lower, the chest leant into it and the arms
 * braced. The heavy running strikes and the loaded run (`Carry_Run_Loop`) stand on its stride.
 */
export const RANGER_GAIT_CLIPS = [
  "Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop", "Walk_Bwd_Loop", "Walk_Strafe_Left_Loop", "Walk_Strafe_Right_Loop",
  "Walk_Start", "Walk_Stop", "Turn_Left", "Turn_Right", "Run_Fwd_Loop", "Run_Strafe_Left_Loop", "Run_Strafe_Right_Loop", "Heavy_Run_Fwd_Loop",
] as const;
/**
 * #399: hit reactions authored in Blender (adapters/blender/hit_clips.py) from the first `Idle_Loop` pose. The
 * `Hit_Upper_*` one-shots key only the rotations of the `spine_01` subtree, so a consumer plays them over the walking
 * or running legs; `Hit_Shove_Spin` is full body. They follow the swim clips in bundle order.
 */
export const RANGER_HIT_CLIPS = ["Hit_Upper_Front", "Hit_Upper_Back", "Hit_Upper_Left", "Hit_Upper_Right", "Hit_Shove_Spin"] as const;
/**
 * #277 (owner answer 2026-10-18: original keyframes in Blender, Mixamo as reference only): bow clips authored on the
 * animated Ranger by adapters/blender/bow_clips.py from explicit archery targets and the figure's archery sockets.
 * They follow the jog clips in bundle order. Each records the string draw for the bow's `nock` joint.
 */
export const RANGER_BOW_CLIPS = ["Bow_Aim_Loop", "Bow_Draw", "Bow_Hold_Loop", "Bow_Release", "Bow_Recovery", "Bow_Cancel"] as const;
/**
 * #419 (mmorpg#517 shots on the move, Rapid Fire, Aimed or Piercing Shot): the bow cycle again for the upper body only
 * (the pelvis and legs left in the idle, the turn in `spine_01`-`03`), the rapid nock-and-loose and the power draw,
 * authored by the same recipe (adapters/blender/bow_clips.py). Each keeps only the `spine_01` subtree and records the
 * string draw like the cycle. They follow the dagger clips in bundle order, so the earlier clips keep their places.
 */
export const RANGER_BOW_UPPER_CLIPS = [
  "Bow_Aim_Upper_Loop", "Bow_Draw_Upper", "Bow_Hold_Upper_Loop", "Bow_Release_Upper", "Bow_Recovery_Upper", "Bow_Cancel_Upper",
  "Bow_Rapid_Release", "Bow_Power_Draw",
] as const;
/**
 * #419 (the Redbrand Crossbowman's Crossbow Bolt): crossbow clips authored in place on the Ranger rig by
 * adapters/blender/crossbow_clips.py from explicit crossbow frames on `hand_r.crossbow`, the fore-stock grip on
 * `hand_l.crossbow`, the crank on `hand_l.weapon` and the bolt on `hand_r.arrow` (two-bone arm IK; Mixamo only as
 * reference). Every one but the footwork keeps only the `spine_01` subtree. They follow the upper-body bow clips in
 * bundle order. #754 adds the marksman's footwork: `Crossbow_Backpedal` (the aim held) and `Crossbow_Reload_Back` (the
 * whole reload) over steps back, full body and in place (travel in `removedTravel`), from the aim back to it.
 */
export const RANGER_CROSSBOW_CLIPS = ["Crossbow_Idle_Loop", "Crossbow_Aim_Loop", "Crossbow_Fire", "Crossbow_Reload", "Crossbow_Backpedal", "Crossbow_Reload_Back"] as const;
/**
 * #420 (the mmorpg Arcanist, Necromancer, Cleric and Druid): shared casting styles and the Warden's war cry, authored
 * in place on the Ranger rig by adapters/blender/cast_clips.py from explicit hand frames on `hand_r.staff`,
 * `hand_r.weapon` (the sword) and the left palm (two-bone arm IK; Mixamo only as reference). The left hand's casting
 * shapes are keyed. All but `Cast_Nova` and `Cast_Summon_Raise` keep only the `spine_01` subtree. They follow the
 * crossbow clips in bundle order. #738 moved the Cleric's mace blows `Mace_Swing_A` and `B` and the staff strikes
 * `Staff_Strike_A` and `B` to the strike family.
 */
export const RANGER_CAST_CLIPS = [
  "Cast_Charge_Loop", "Cast_Release_Push", "Cast_Release_Overhand", "Cast_Channel_Beam_Loop", "Cast_Channel_Drain_Loop",
  "Cast_Channel_Sky_Loop", "Cast_Nova", "Cast_Cone", "Cast_Curse_Point", "Cast_Ground_Sweep", "Cast_Self_Ward", "Cast_Ally",
  "Warcry", "Cast_Summon_Raise", "Cast_Summon_Call", "Cast_Raise_Wall", "Cast_Interrupted",
] as const;
/**
 * #421 (the mmorpg emotes, `UseDoor`, the night knock, corpse loot, NPC talk, vendors, inns and NPC night rest): social
 * and interaction clips authored in place on the Ranger rig by adapters/blender/social_clips.py from explicit palm
 * frames (two-bone arm IK onto the door leaf, the handle and the corpse) and pelvis and ankle targets (two-bone leg IK;
 * Mixamo and the CC0 UAL1 seeds only as reference). The emotes but `Emote_Bow`, the door, talk and handover clips keep
 * only the `spine_01` subtree; the bow, the loot kneel, sitting and sleeping are full body with a `secondaryPose`. Each
 * `*_Enter` ends in its loop's first pose and each exit is its enter backwards. They follow the cast clips in bundle order.
 */
export const RANGER_SOCIAL_CLIPS = [
  "Emote_Wave", "Emote_Point", "Emote_Bow", "Emote_Cheer", "Emote_Laugh", "Door_Push", "Door_Pull", "Door_Knock",
  "Loot_Kneel_Enter", "Loot_Kneel_Loop", "Loot_Kneel_Exit", "Talk_Idle_Loop", "Talk_Gesture_A", "Talk_Gesture_B", "Talk_Gesture_C",
  "Trade_Handover", "Sit_Chair_Enter", "Sit_Chair_Loop", "Sit_Chair_Exit", "Sit_Ground_Loop", "Sleep_Bed_Enter", "Sleep_Bed_Loop",
  "Sleep_Bed_Wake",
] as const;
/**
 * #693 (#422's NPC work loops, mmorpg's residents carrying tools): carry and chore clips authored in place on the Ranger
 * rig by adapters/blender/chore_clips.py from the `hand_r.carry` and `hand_r.staff` frames and explicit palm frames (two-bone arm IK) and,
 * for the full-body clips, pelvis and ankle targets (two-bone leg IK; the CC0 UAL1 `Farm_*` clips only as reference).
 * The carry loops, the counter wipe and the pour keep only the `spine_01` subtree; the sweep, hoe and watering loops
 * are full body with a `secondaryPose`. `Carry_Hang_Walk_Loop` has `Walk_Loop`'s length. They follow the social clips
 * in bundle order.
 */
export const RANGER_CHORE_CLIPS = [
  "Carry_Hang_Idle_Loop", "Carry_Hang_Walk_Loop", "Sweep_Loop", "Bar_Wipe_Loop", "Pour", "Farm_Hoe_Loop", "Farm_Water_Loop",
] as const;
/**
 * #697 (#422's post idles and ambient idles: Greyhaven's guards, Marshal Elden, Brother Aldous and the townsfolk): post
 * idles, devotions and idle breaks authored in place on the Ranger rig by adapters/blender/post_clips.py from the
 * `hand_r.staff` frame (a grounded spear), the `hip_l.stowed` hilt and explicit palm frames (two-bone arm IK) and, for the
 * full-body clips, pelvis and ankle targets (two-bone leg IK; the CC0 UAL1 `Idle_FoldArms_Loop` only as reference). The
 * guard, marshal and blessing clips keep only the `spine_01` subtree; the prayer, the wall lean and the idle breaks are
 * full body with a `secondaryPose`. They follow the chore clips in bundle order.
 */
export const RANGER_POST_CLIPS = [
  "Guard_Attention_Loop", "Guard_Salute", "Guard_LookAround", "Marshal_Inspect_Loop", "Pray_Kneel_Loop", "Bless", "Lean_Wall_Loop",
  "Idle_Variant_Shift", "Idle_Variant_Stretch", "Idle_Variant_Yawn",
] as const;
/**
 * #701 (#422's gathering and emotes, for players and residents): gathering loops, a chest opening and social emotes
 * authored in place on the Ranger rig by adapters/blender/gather_clips.py from the `hand_r.weapon` frame (the wood axe,
 * the pickaxe and the skinning knife, #736) and explicit palm frames (two-bone arm IK) and, for the full-body clips, pelvis
 * and ankle targets (two-bone leg IK; the CC0 UAL1 seeds only as reference). The gathering loops and the chest are full
 * body with a `secondaryPose`; the emotes keep only the `spine_01` subtree. `Emote_Wave` and the one-armed
 * `Emote_Cheer` are the #421 social clips; `Emote_Cheer_Both` is the both-arms cheer. They follow the post clips in
 * bundle order.
 */
export const RANGER_GATHER_CLIPS = [
  "Gather_Chop_Loop", "Gather_Mine_Loop", "Gather_Herb_Loop", "Gather_Skin_Loop", "Chest_Open", "Emote_Yes", "Emote_No", "Emote_Shrug",
  "Emote_Clap", "Emote_Cheer_Both",
] as const;
/**
 * #705 (#422's raids, repairs, pushables, traps and knockdowns): clips authored in place on the Ranger rig by
 * adapters/blender/raid_clips.py from the `hand_r.weapon` frame (the torch, the battle axe and the hammer), the
 * `chest.carry` frame (a two-handed load) and explicit palm frames (two-bone arm IK) and, for the full-body clips,
 * pelvis and ankle targets (two-bone leg IK; the CC0 UAL1 seeds only as reference). The torch, the hack and the carries
 * keep only the `spine_01` subtree; the rest are full body with a `secondaryPose`. `Carry_Walk_Loop` and `Push_Loop`
 * have `Walk_Loop`'s length; `Push_Start` ends in `Push_Loop`, `Knockdown_Fall` in `Lie_Loop`, and `GetUp` starts
 * there. They follow the gather clips in bundle order. #823: `Carry_Run_Loop` is the loaded run's upper body, as
 * `Carry_Walk_Loop` keeps only the `spine_01` subtree, of `Heavy_Run_Fwd_Loop`'s length and played over its legs.
 */
export const RANGER_RAID_CLIPS = [
  "Raid_Torch_Carry_Loop", "Raid_Hack_Structure_Loop", "Carry_Idle_Loop", "Carry_Walk_Loop", "Repair_Hammer_Loop", "Push_Start", "Push_Loop",
  "Lever_Pull", "Trap_Place", "Trap_Disarm_Loop", "Knockdown_Fall", "Lie_Loop", "GetUp", "Carry_Run_Loop",
] as const;
/**
 * #709 (movement-state melee: the game picks the strike from the attacker's movement state): a running and a jumping
 * strike per weapon and the standing strikes that complete the mace, staff and spear chains, authored in place on the
 * Ranger rig by adapters/blender/strike_clips.py from weapon frames on `hand_r.weapon` (sword, mace, dagger) or
 * `hand_r.staff` (staff, spear) with the shield, the off-hand dagger or the shaft in the left hand (two-bone arm IK; the
 * CC0 UAL1 seeds only as reference). The running strikes are full body on `Jog_Fwd_Loop`'s legs and last one of its
 * cycles; the jumping strikes are full body from `Jump_Loop`'s first pose to `Jump_Land`'s deepest crouch; the standing
 * strikes keep only the `spine_01` subtree. Each records its contact, the strike point there, its height band and its
 * reach. They follow the raid clips in bundle order.
 *
 * #737: the three references of docs/combat-animation-standard.md (`RANGER_COMBAT_STANDARD_CLIPS`) are full body: the
 * feet plant, the hips and legs drive the strike, and each records its phases (`windupEnd`, `contactSeconds`,
 * `recoveryStart`) and the spans its feet stand planted (`footPlants`). `Sword_Regular_A` replaces the library clip of
 * that name, so it moves from the library combat clips to this family.
 *
 * #738 (phase 2, sword and spear first): `Sword_Regular_B` and `Sword_Regular_C` replace their library clips too and
 * move here. The sword and spear jumping strikes land in their family's guard (the recipe's `leap`: the feet planted
 * from the touch, a landing as deep as the weapon needs, `to` the guard) and the running strikes go from the family's
 * guard back to it over the run's legs, recording their phases.
 *
 * #738 (mace and two-handed): the mace's overhand and backhand `Mace_Swing_A` and `B` move here from the cast clips and,
 * with `Mace_Swing_C` and `TwoHand_Swing_B` and `C`, are full body from the family's guard back to it. The mace and maul
 * jumping strikes are slams that land in their guard, and the running strikes go from the guard back to it.
 * #738 (unarmed): the jab, cross and hook are full body from the fists' guard, the jump an overhand right that lands in
 * it and the barge goes from the guard back to it.
 * #738 (staff, dagger and bow): the staff jab and sweep `Staff_Strike_A` and `B` move here from the cast clips and, with
 * `Staff_Strike_C` and `Bow_Bash_A` and `B`, are full body from the family's guard back to it (`Bow_Bash_B` was a push
 * kick and is a forehand bow strike now, so its contact is the bow hand). Every running strike goes from its guard back
 * to it and every jumping strike lands in its guard, so no strike is an upper-body layer any more.
 * #738 (the Rogue's daggers, last): `Dagger_Stab_R`, `Dagger_Slash_L` (with the left dagger), `Dagger_Sinister`,
 * `Dagger_Poison` and `Dagger_Gouge` move here from the dagger clips with their names and roles, full body from the
 * dagger guard back to it. Every standing and jumping strike now stands on its family's footing (as its guard does).
 */
export const RANGER_STRIKE_CLIPS = [
  "Sword_Regular_A", "Sword_Regular_B", "Sword_Regular_C", "Sword_Run_Strike", "Sword_Jump_Strike", "Mace_Swing_A", "Mace_Swing_B",
  "Mace_Run_Strike", "Mace_Jump_Strike", "Dagger_Run_Strike", "Dagger_Jump_Strike", "Staff_Strike_A", "Staff_Strike_B", "Staff_Run_Strike",
  "Staff_Jump_Strike", "Spear_Run_Strike", "Spear_Jump_Strike", "Mace_Swing_C", "Staff_Strike_C", "Spear_Thrust_A", "Spear_Thrust_B",
  // #711: the bare-fist, two-handed maul and bow-in-melee sets, each a standing chain plus a running and a jumping
  // strike. The fists strike with the knuckles of the hand that throws them (the barge with the right shoulder), the
  // maul with its head (the left hand on its `grip.offhand`), the bow with a limb from `hand_l.bow`.
  "Unarmed_Jab", "Unarmed_Cross", "Unarmed_Hook", "Unarmed_Run_Strike", "Unarmed_Jump_Strike", "TwoHand_Swing_A", "TwoHand_Swing_B",
  "TwoHand_Swing_C", "TwoHand_Run_Strike", "TwoHand_Jump_Strike", "Bow_Bash_A", "Bow_Bash_B", "Bow_Run_Strike", "Bow_Jump_Strike",
  // #738: the Rogue's dagger attacks, moved here from the dagger clips with their names and roles.
  "Dagger_Stab_R", "Dagger_Slash_L", "Dagger_Sinister", "Dagger_Poison", "Dagger_Gouge",
  // #823: the great axe's and the greatsword's heavy running strikes, beside the hammers' `TwoHand_Run_Strike`.
  "TwoHand_Axe_Run_Strike", "TwoHand_Sword_Run_Strike",
] as const;
/**
 * #823: the heavy running strikes (`TwoHand_Run_Strike` for the maul and the great hammer, `TwoHand_Axe_Run_Strike`,
 * `TwoHand_Sword_Run_Strike`) run two `Heavy_Run_Fwd_Loop` strides on its stride at the game's run speed, the third
 * footfall planting long and deep under the blow; they record the stride (`strike.stride`), the ground speed their
 * planted feet hold still at (`strike.groundSpeedMetersPerSecond`) and their planted spans. They start and end on these
 * carry loops: the great weapon held upright on the heavy run (the hammers and the great axe on `TwoHand_Run_Loop`, the
 * greatsword on `TwoHand_Sword_Run_Loop`), recording the carried item (`carry`), the ground speed and the planted spans.
 * The strike recipe authors them after the reactions.
 */
export const RANGER_HEAVY_CARRY_CLIPS = ["TwoHand_Run_Loop", "TwoHand_Sword_Run_Loop"] as const;
/**
 * #737: the clips that meet the combat-animation standard (docs/combat-animation-standard.md); the Ranger build test
 * requires its checks to pass on each, between the keys too. Phase 2 (#738) adds every other attack as it is redone.
 */
export const RANGER_COMBAT_STANDARD_CLIPS: readonly string[] = [
  "Sword_Regular_A", "TwoHand_Swing_A", "Spear_Thrust_B",
  "Sword_Regular_B", "Sword_Regular_C", "Sword_Jump_Strike", "Spear_Thrust_A", "Spear_Jump_Strike",
  "Mace_Swing_A", "Mace_Swing_B", "Mace_Swing_C", "Mace_Jump_Strike", "TwoHand_Swing_B", "TwoHand_Swing_C", "TwoHand_Jump_Strike",
  "Unarmed_Jab", "Unarmed_Cross", "Unarmed_Hook", "Unarmed_Jump_Strike",
  "Staff_Strike_A", "Staff_Strike_B", "Staff_Strike_C", "Staff_Jump_Strike", "Dagger_Jump_Strike", "Bow_Bash_A", "Bow_Bash_B", "Bow_Jump_Strike",
  "Dagger_Stab_R", "Dagger_Slash_L", "Dagger_Sinister", "Dagger_Poison", "Dagger_Gouge",
  // #823: the heavy running strikes plant their striking stride deep and their feet hold still on the moving ground.
  "TwoHand_Run_Strike", "TwoHand_Axe_Run_Strike", "TwoHand_Sword_Run_Strike",
];
/**
 * mmorpg#804: strikes whose weapon passed through the torso in game, fixed without redoing them to the whole standard.
 * The Ranger build test holds them to the weapon–body clearance check, and to the planted-foot check over the spans
 * listed (`Sword_Cleave` turns on both planted feet).
 * #738: the running strikes, redone to the standard, run on the run's legs and so have no planted feet; they are held
 * to the clearance here. `Mace_Swing_B` and the staff jab and sweep are held to the whole standard now, and (#823)
 * `TwoHand_Run_Strike`, redone on the heavy stride with its feet planted.
 */
export const RANGER_CLEARANCE_CLIPS: Readonly<Record<string, { footPlants?: Record<string, number[][]> }>> = {
  Sword_Cleave: { footPlants: { l: [[0, .9]], r: [[0, .9]] } },
  Sword_Run_Strike: {}, Spear_Run_Strike: {}, Mace_Run_Strike: {}, Staff_Run_Strike: {}, Dagger_Run_Strike: {},
  Bow_Run_Strike: {},
};
/**
 * #711: hit reactions and deaths played on the victim (health-only rules, so purely presentation), full body and in
 * place from the first `Idle_Loop` pose, authored by the same recipe after the strikes. The light hits flinch away from
 * the side named and end in the idle; the heavy hit staggers a step back and recovers; each death falls its own way and
 * ends lying (`lies`: back, front or side), where the consumer holds the last frame.
 */
export const RANGER_REACT_CLIPS = ["Hit_Light_L", "Hit_Light_R", "Hit_Heavy_Front", "Death_Back", "Death_Fwd", "Death_Spin"] as const;
/**
 * #717 (drawing and sheathing are an explicit gameplay mode): a draw and a sheathe per weapon family, the combat idles
 * and the guards the earlier kits lacked, authored in place on the Ranger rig by adapters/blender/ready_clips.py from
 * hand frames solved with two-bone arm IK on the `Idle_Loop` pose. Every draw, sheathe and idle keeps only the
 * `spine_01` subtree; #738 stands each guard full body on its family's footing, the one its strikes start and end on.
 * A draw or sheathe records the hand socket, the stow socket (`hip_l.stowed`, `hip_r.stowed`, `back.stowed`,
 * `back.bow.stowed`) and `swapSeconds`, the frame the hand's socket is on the stow socket, where the game moves the item
 * between them. They follow the strike family in bundle order.
 */
export const RANGER_READY_CLIPS = [
  "Sword_Draw", "Sword_Sheathe", "Mace_Draw", "Mace_Sheathe", "Dagger_Draw", "Dagger_Sheathe", "Staff_Draw", "Staff_Sheathe",
  "Spear_Draw", "Spear_Sheathe", "TwoHand_Draw", "TwoHand_Sheathe", "Bow_Draw_Weapon", "Bow_Stow",
  "Mace_Idle_Loop", "Staff_Idle_Loop", "Spear_Idle_Loop", "TwoHand_Idle_Loop", "Unarmed_Idle_Loop", "Bow_Idle_Loop",
  "Mace_Guard_Loop", "Dagger_Guard_Loop", "Staff_Guard_Loop", "Spear_Guard_Loop", "TwoHand_Guard_Loop", "Unarmed_Guard_Loop", "Bow_Guard_Loop",
] as const;
/**
 * #729 (the defensive half of the combat overhaul): a backward roll, sidesteps and a hop back (full body, in place, the
 * travel in `removedTravel`), a parry per weapon family (`parrySeconds`, the deflection frame), the sword and dagger
 * ripostes, the shield brace, its hit and a real bash, and a push kick for any family. Authored on the Ranger rig by
 * adapters/blender/defend_clips.py; the parries, ripostes and shield clips keep only the `spine_01` subtree. They
 * follow the ready family in bundle order. #754 adds the skirmisher's footwork: `Sword_Sidestep_L`/`_R` and
 * `Sword_Hop_Back`, full body and in place like the dodges, from the sword guard back to it with the blade held in guard.
 */
export const RANGER_DEFEND_CLIPS = [
  "Roll_Bwd", "Sidestep_L", "Sidestep_R", "Dodge_Back", "Sword_Sidestep_L", "Sword_Sidestep_R", "Sword_Hop_Back",
  "Sword_Parry", "Dagger_Parry", "Staff_Parry", "Spear_Parry", "TwoHand_Parry", "Mace_Parry",
  "Sword_Riposte", "Dagger_Riposte", "Shield_Block_Loop", "Shield_Block_Hit", "Shield_Bash", "Kick_Front",
] as const;
/**
 * #767 (#422's control reactions and movement spells): the rooted struggle and its frozen variant (mmorpg#933 Frost
 * Nova, #934 Entangling Roots), the pit fall, the blink, the three-part leap, the dash, the grappling hook's throw and
 * yank, being pulled and slipping on ice (mmorpg#294). Authored in place on the Ranger rig by
 * adapters/blender/move_clips.py from keyed pelvis, foot, chest and palm targets (two-bone arm and leg IK); the two
 * struggles, the throw and the yank keep only the `spine_01` subtree, the rest are full body with a `secondaryPose`.
 * `Blink_Out` ends where `Blink_In` starts, and `Leap_Launch`, `Leap_Air_Loop` and `Leap_Slam` chain the same way. The
 * game owns the travel and the drop. They follow the defend clips in bundle order.
 */
export const RANGER_MOVE_CLIPS = [
  "Rooted_Struggle_Loop", "Rooted_Struggle_Frozen_Loop", "Fall_Pit", "Blink_Out", "Blink_In", "Leap_Launch", "Leap_Air_Loop", "Leap_Slam",
  "Dash_Lunge", "Grapple_Throw", "Pull_Yank", "Pulled_Drag", "Slip_Ice_Loop",
] as const;
/**
 * #767 (#422's NPC work loops): the tanner fleshing a hide over a beam and stretching one on a frame, full body, by the
 * same recipe as the move clips. They follow the move clips in bundle order.
 */
export const RANGER_WORK_CLIPS = ["Tanner_Scrape_Loop", "Tanner_Stretch_Hide"] as const;
/**
 * #769: riding the tacked horse of the `mounts` release (docs/mounts.md): mounting from its near side, dismounting, and
 * riding at a halt, through its four gaits (in step with the horse's loops: the trot posts, the gallop leans forward
 * out of the saddle) and through its turns. Authored in the seat frame by adapters/blender/ride_clips.py: the game
 * parents the root to the horse's `saddle.seat`, the pelvis sits on it and the palms and balls stay on `reins.*` and
 * `stirrup.*` (src/mounts.ts holds the shared numbers). Full body with a `secondaryPose`. They follow the work clips.
 */
export const RANGER_RIDE_CLIPS = [
  "Mount_Horse", "Dismount_Horse", "Ride_Idle_Loop", "Ride_Walk_Loop", "Ride_Trot_Loop", "Ride_Canter_Loop", "Ride_Gallop_Loop", "Ride_Turn_L",
  "Ride_Turn_R",
] as const;
/**
 * #773 (mmorpg#953, the shield-bearing Redbrand whose guard rewards flanking): a full-body shield guard on the Redbrand
 * shield (`equipment.shield.redbrand` on `hand_l.shield`) with a one-hander in the right hand, its slow planted 45
 * degree turns (ending turned, as `Turn_Left`), a blow landing on the shield, a full-body bash that steps in and a
 * guard broken from the side or behind. Authored by adapters/blender/defend_clips.py's stance keys (feet, hips, chest,
 * shoulders, then the shield); each starts and ends in `Shield_Guard_Loop`. `Shield_Guard_Bash` is the bash from this
 * guard; the upper-body `Shield_Bash` of the defend family keeps its name. They follow the ride clips in bundle order.
 */
export const RANGER_GUARD_CLIPS = [
  "Shield_Guard_Loop", "Shield_Guard_Turn_L", "Shield_Guard_Turn_R", "Shield_Block_Impact", "Shield_Guard_Bash", "Guard_Broken_Stagger",
] as const;
/**
 * #773 (mmorpg#952, the interruptible Redbrand signaler): raising the signal horn (`equipment.tool.signal-horn` on
 * `hand_r.weapon`) to the lips, the blast held as a loop, the call broken (the horn struck loose at `dropSeconds`) and
 * the call ended, full body by the same recipe. They follow the guard clips.
 */
export const RANGER_SIGNAL_CLIPS = ["Signal_Call_Start", "Signal_Call_Loop", "Signal_Call_Interrupted", "Signal_Call_End"] as const;
/**
 * #775 (mmorpg#950, the Tinker): kneeling to set and arm the spring trap (`equipment.tinker.trap`), an underhand
 * flask lob and an overhand bomb lob that lights the fuse first (`equipment.tinker.flask`, `equipment.tinker.bomb`),
 * and the ready loop with a flask in hand, all on `hand_r.weapon`. Authored full body by adapters/blender/tinker_clips.py
 * from stance keys (feet, hips, chest, shoulders, then the hands); the throws start and end in `Tinker_Ready_Loop`, the
 * trap in the idle. They follow the signal clips in bundle order.
 */
export const RANGER_TINKER_CLIPS = ["Tinker_Place_Trap", "Tinker_Throw_Flask", "Tinker_Throw_Bomb", "Tinker_Ready_Loop"] as const;
/**
 * #285: static grip poses authored on the rig by adapters/blender/grip_poses.py. Each clip keys only the finger and
 * thumb rotations of one hand; a consumer plays it over the body clip's finger channels while that hand's socket holds
 * an item of `role`. The fingers wrap a handle of `radius` (metres) along the item's grip-frame `axis`; the tome leaves
 * the hand relaxed. They follow the bow clips in bundle order.
 */
const GRIP_HANDLE = (radius: number) => ({ kind: "cylinder", axis: [0, 1, 0], radius });
export const RANGER_GRIPS: readonly { clip: string; socket: string; role: string; surface: Json }[] = [
  { clip: "Grip_Weapon_R", socket: "hand_r.weapon", role: "one-hand-weapon", surface: GRIP_HANDLE(.0145) },
  { clip: "Grip_Weapon_L", socket: "hand_l.weapon", role: "one-hand-weapon", surface: GRIP_HANDLE(.0145) },
  { clip: "Grip_Shield_L", socket: "hand_l.shield", role: "shield", surface: GRIP_HANDLE(.012) },
  { clip: "Grip_Shield_R", socket: "hand_r.shield", role: "shield", surface: GRIP_HANDLE(.012) },
  { clip: "Grip_Book_L", socket: "hand_l.shield", role: "book", surface: { kind: "relaxed" } },
  { clip: "Grip_Book_R", socket: "hand_r.shield", role: "book", surface: { kind: "relaxed" } },
  { clip: "Grip_Staff_R", socket: "hand_r.staff", role: "staff", surface: GRIP_HANDLE(.019) },
  { clip: "Grip_Staff_L", socket: "hand_l.staff", role: "staff", surface: GRIP_HANDLE(.019) },
  { clip: "Grip_Bow_L", socket: "hand_l.bow", role: "bow", surface: GRIP_HANDLE(.022) },
  // #389: the crossbow's stock runs along its grip frame's Z; the hand closes round the stock's wrist.
  { clip: "Grip_Crossbow_R", socket: "hand_r.crossbow", role: "crossbow", surface: { kind: "cylinder", axis: [0, 0, 1], radius: .02 } },
  { clip: "Grip_Crossbow_L", socket: "hand_l.crossbow", role: "crossbow", surface: { kind: "cylinder", axis: [0, 0, 1], radius: .02 } },
  // #418: a throwing knife pinched between the thumb and the bent index; a round flask or bomb (4 cm radius) in the fist.
  // #470: the blade runs along +Y through (x, z), where adapters/blender/weapon.py's PINCH_AXIS puts the knife, and is
  // the knife's default bladeThickness thick; the thumb closes onto it.
  { clip: "Grip_Knife_Pinch_R", socket: "hand_r.weapon", role: "throwing-knife", surface: { kind: "pinch", through: [-.015, -.02], thickness: .004 } },
  { clip: "Grip_Flask_R", socket: "hand_r.weapon", role: "flask", surface: { kind: "sphere", radius: .04 } },
  // #419: the crossbow's crank handle (Crossbow_Reload), a 12 mm handle along the grip frame's Y.
  { clip: "Grip_Crank_L", socket: "hand_l.weapon", role: "crank", surface: GRIP_HANDLE(.012) },
];
/** The finger and thumb joints a grip clip keys (rotation only), for the hand `side`. */
export const rangerGripJoints = (side: "l" | "r") =>
  ["index", "middle", "ring", "pinky", "thumb"].flatMap((finger) => ["01", "02", "03"].map((k) => `${finger}_${k}_${side}`));
/**
 * #393 (mmorpg#499, Atlas 6.6.41): water locomotion authored in place on the Ranger rig by adapters/blender/swim_clips.py
 * from explicit limb trajectories (Mixamo only as reference). The strokes are authored upright (body along +Y, facing
 * +Z); the consumer pitches the body. They follow the grip poses in bundle order.
 */
export const RANGER_SWIM_CLIPS = ["Wade_Fwd_Loop", "Swim_Idle_Loop", "Swim_Fwd_Loop", "Swim_Down_Loop", "Swim_Up_Loop", "Swim_Enter", "Swim_Exit"] as const;
/**
 * #416 (mmorpg#490, mmorpg#500): climbing, mantling, ladder and rope clips authored in place on the Ranger rig by
 * adapters/blender/traversal_clips.py from explicit hand and foot targets (two-bone IK; Mixamo and the CC0 UAL2
 * `ClimbUp_1m_RM` only as reference). They follow the hit reactions in bundle order. Each entry carries its contacts
 * and a skirt and cape pose for the #391 chain joints (docs/humanoid-ranger.md#traversal-clips-416).
 */
export const RANGER_TRAVERSAL_CLIPS = [
  "Climb_Idle_Loop", "Climb_Up_Loop", "Climb_Down_Loop", "Climb_Left_Loop", "Climb_Right_Loop", "Climb_TopOut", "Climb_LetGo",
  "Mantle_Low", "Mantle_Mid", "Mantle_High",
  "Ladder_Idle_Loop", "Ladder_Up_Loop", "Ladder_Down_Loop", "Rope_Idle_Loop", "Rope_Up_Loop", "Rope_Down_Loop",
] as const;
/**
 * #417 (the mmorpg Warden and the Redbrand specials): sword-and-shield clips authored in place on the Ranger rig by
 * adapters/blender/sword_clips.py from explicit sword and shield grip frames on the `hand_r.weapon` and `hand_l.shield`
 * sockets (two-bone arm IK; Mixamo only as reference). The directed slashes, `Sword_Heroic` and the guard lanes keep
 * only the `spine_01` subtree. They follow the traversal clips in bundle order; each slash carries its `aim` cell.
 */
export const RANGER_SWORD_CLIPS = [
  ...(["High", "Mid", "Low"] as const).flatMap((height) => (["L", "C", "R"] as const).map((side) => `Sword_Slash_${height}_${side}` as const)),
  "Sword_Heroic", "Sword_Cleave", "Charge_Run_Loop", "Charge_Impact", "Shield_Guard_High_Loop", "Shield_Guard_Mid_Loop", "Shield_Guard_Low_Loop",
  "Stun_Loop", "Respawn_Rise", "Sword_Whirl", "Sword_Overhead_Smash",
] as const;
/**
 * #418 (the mmorpg Rogue, the Field Marauder and the Redbrand bandage): the twin-dagger idle, throw, flourish and
 * bandage clips (#738 moved the dagger attacks to the strike family), authored in place on the Ranger rig by adapters/blender/dagger_clips.py from explicit grip frames on the
 * `hand_r.weapon` and `hand_l.weapon` sockets and the `belt.throwable` draw (two-bone arm IK; Mixamo only as
 * reference). Every one keeps only the `spine_01` subtree. They follow the sword clips in bundle order; the throws carry
 * `drawSeconds` and `releaseSeconds`.
 */
export const RANGER_DAGGER_CLIPS = [
  "Dagger_Idle_Loop", "Flourish_Haste", "Throw_Knife", "Throw_Lob", "Bandage_Self",
] as const;

/** A socket of the figure's sockets descriptor, as a recipe argument. */
export type RangerSocket = { joint: string; translation: number[]; rotation: number[] };
/** What a family's arguments may read: the figure's sockets. */
export type ClipFamilyContext = { socket: (id: string) => RangerSocket & { id: string } };
/** One authored clip's share of its family's run. */
export type AuthoredClip = {
  /** The joints whose rotations the clip keeps (the rest are dropped); every channel when absent. */
  keep?: readonly string[];
  /** The recipe observations recorded in the lineage. */
  authored: Json;
  /** The library clip the recipe starts from, for `humanoid-clips` `source.basedOn`; none when absent. */
  basedOn?: string;
  /** Extra built-clip fields: the removed travel, the bow draw, the grip or the swim stroke. */
  extra?: {
    removedTravel?: [number, number]; bow?: Json; grip?: { socket: string; role: string }; swim?: { strokeSpeedMetersPerSecond: number };
    /** Traversal clips (#416): the whole travel (glTF x, y, z) the in-place clip stands for. */
    rootTravel?: [number, number, number];
    /** The clip's own `humanoid-clips` fields (#416 traversal, #417 sword aim). */
    fields?: Json;
    /** The strike or release time the recipe authored (#418); the build measures `contact` there. */
    contactSeconds?: number;
  };
};
/**
 * A family of clips authored by one Blender recipe in one run (#425). `arguments` are the recipe's arguments for all
 * of `clips`; `clip` turns the run's observations (`family`, and the clip's own under `family.clips[name]` where the
 * recipe reports them per clip) into the clip's share. Families run in table order, which is the bundle order.
 */
export type ClipFamily = {
  id: string; script: string; clips: readonly string[];
  arguments: (context: ClipFamilyContext) => Json;
  /** Blender exports constant poses as STEP; with two identical keys LINEAR is the same pose, and the extractor takes LINEAR only. */
  linear?: boolean;
  clip: (name: string, family: Json, context: ClipFamilyContext) => AuthoredClip;
};

/** A name-only recipe (gait, swim, hit): `joints` limits the clip, `removedTravel` records its travel, `source` names its base clip. */
function nameOnly(id: string, script: string, clips: readonly string[], extra: (observed: Json) => AuthoredClip["extra"] = () => undefined): ClipFamily {
  return {
    id, script, clips, arguments: () => ({ schemaVersion: 1, clips: [...clips] }),
    clip: (name, family) => {
      const { joints, removedTravel, ...observed } = family.clips[name] as Json;
      const more = extra(observed);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: (observed.source as string | undefined) ?? "Idle_Loop",
        ...(removedTravel || more ? { extra: { ...(removedTravel ? { removedTravel: removedTravel as [number, number] } : {}), ...more } } : {}),
      };
    },
  };
}

const pickKeys = (source: Json, keys: string[]) => Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
const socketAt = (socket: ClipFamilyContext["socket"]) => (id: string) => { const { joint, translation, rotation } = socket(id); return { joint, translation, rotation }; };

/**
 * A bow family (#277 cycle, #419 upper-body set): every clip records the string draw per frame and its archery marks;
 * an upper-body clip keeps its listed joints. With `releaseContact` the contact is the authored release (#419: as for
 * the dagger throws); the #277 cycle keeps its fastest-sample contact, which consumers already time against.
 */
function bowFamily(id: string, clips: readonly string[], { releaseContact = false } = {}): ClipFamily {
  return {
    id, script: "bow_clips.py", clips,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...clips],
        sockets: { bow: at("hand_l.bow"), arrow: at("hand_r.arrow"), quiver: at("back.quiver") },
        braceHeight: ARCHERY_PRESETS["bow.long"].braceHeight, arrowLength: ARCHERY_PRESETS.arrow.length, quiverLength: ARCHERY_PRESETS["quiver.back"].length,
      };
    },
    clip: (name, family) => {
      const { drawMeters, frames, joints, ...marks } = family.clips[name] as Json;
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, fps: family.fps, frames, ...marks }, basedOn: "Idle_Loop",
        extra: {
          bow: { sampleRate: family.fps, drawMeters, ...pickKeys(marks, ["releaseSeconds", "arrowDrawnSeconds", "nockedSeconds"]) },
          ...(releaseContact && marks.releaseSeconds !== undefined ? { contactSeconds: marks.releaseSeconds as number } : {}),
        },
      };
    },
  };
}

/** The authored clip families, in bundle order after the retargeted library clips. */
export const RANGER_CLIP_FAMILIES: readonly ClipFamily[] = [
  // #804: the runs record the ground speed they were authored at and their planted spans.
  nameOnly("gait", "gait_clips.py", RANGER_GAIT_CLIPS, (observed) =>
    observed.footPlants ? { fields: pickKeys(observed, ["groundSpeedMetersPerSecond", "footPlants"]) } : undefined),
  bowFamily("bow", RANGER_BOW_CLIPS),
  {
    id: "grips", script: "grip_poses.py", clips: RANGER_GRIPS.map((grip) => grip.clip), linear: true,
    arguments: ({ socket }) => ({
      schemaVersion: 1,
      grips: RANGER_GRIPS.map((grip) => {
        const { joint, translation, rotation } = socket(grip.socket);
        return { clip: grip.clip, socket: { joint, translation, rotation }, surface: grip.surface };
      }),
    }),
    clip: (name, family, { socket }) => {
      const grip = RANGER_GRIPS.find((candidate) => candidate.clip === name)!;
      return {
        keep: rangerGripJoints(socket(grip.socket).joint === "hand_l" ? "l" : "r"),
        authored: { recipe: family.recipe, fps: family.fps, curlDegrees: family.grips[name] },
        extra: { grip: { socket: grip.socket, role: grip.role } },
      };
    },
  },
  nameOnly("swim", "swim_clips.py", RANGER_SWIM_CLIPS, (observed) =>
    observed.strokeSpeedMetersPerSecond ? { swim: { strokeSpeedMetersPerSecond: observed.strokeSpeedMetersPerSecond as number } } : undefined),
  nameOnly("hit", "hit_clips.py", RANGER_HIT_CLIPS),
  {
    id: "traversal", script: "traversal_clips.py", clips: RANGER_TRAVERSAL_CLIPS,
    arguments: () => ({ schemaVersion: 1, clips: [...RANGER_TRAVERSAL_CLIPS] }),
    clip: (name, family) => {
      // The per-frame data (contacts, chain pose, travel samples) goes to the clip's entry; the lineage keeps the rest.
      const { contacts, secondaryPose, travelSamples, travel, ...observed } = family.clips[name] as Json;
      const fields = pickKeys(observed, ["climbSpeedMetersPerSecond", "rungSpacingMeters", "ledgeHeightMeters", "edgeHeightMeters"]);
      return {
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: "Idle_Loop",
        extra: {
          ...(travel ? { rootTravel: travel as [number, number, number] } : {}),
          fields: { ...fields, contacts, secondaryPose, ...(travelSamples ? { travelSamples: { sampleRate: family.fps, translations: travelSamples } } : {}) },
        },
      };
    },
  },
  {
    id: "sword", script: "sword_clips.py", clips: RANGER_SWORD_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return { schemaVersion: 1, clips: [...RANGER_SWORD_CLIPS], sockets: { weapon: at("hand_r.weapon"), shield: at("hand_l.shield") } };
    },
    clip: (name, family) => {
      // The upper-body clips list their joints; a slash's aim cell and the respawn kneel's chain pose go to the clip's
      // entry.
      const { joints, aim, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const fields = { ...(aim ? { aim } : {}), ...(secondaryPose ? { secondaryPose } : {}) };
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        ...(Object.keys(fields).length ? { extra: { fields } } : {}),
      };
    },
  },
  {
    id: "dagger", script: "dagger_clips.py", clips: RANGER_DAGGER_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...RANGER_DAGGER_CLIPS],
        sockets: { weapon: at("hand_r.weapon"), offhand: at("hand_l.weapon"), belt: at("belt.throwable") },
      };
    },
    clip: (name, family) => {
      // Every clip is upper body; a throw's draw and release go to the clip's entry, and its contact is the release.
      const { joints, source, ...observed } = family.clips[name] as Json;
      const fields = pickKeys(observed, ["drawSeconds", "releaseSeconds"]);
      const contactSeconds = observed.releaseSeconds;
      return {
        keep: joints as string[],
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: { ...(Object.keys(fields).length ? { fields } : {}), ...(contactSeconds === undefined ? {} : { contactSeconds }) },
      };
    },
  },
  bowFamily("bow-upper", RANGER_BOW_UPPER_CLIPS, { releaseContact: true }),
  {
    id: "crossbow", script: "crossbow_clips.py", clips: RANGER_CROSSBOW_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...RANGER_CROSSBOW_CLIPS], quiverLength: ARCHERY_PRESETS["quiver.back"].length,
        sockets: { crossbow: at("hand_r.crossbow"), fore: at("hand_l.crossbow"), crank: at("hand_l.weapon"), bolt: at("hand_r.arrow"), quiver: at("back.quiver") },
      };
    },
    clip: (name, family) => {
      // The shot's release, the reload's marks and the footwork's from, to and direction go to the clip's `crossbow`
      // object. The contact is the release, as for the bow. The footwork (#754) is full body: it keeps every joint and
      // adds its travel and chain pose.
      const { joints, source, secondaryPose, removedTravel, ...observed } = family.clips[name] as Json;
      const crossbow = pickKeys(observed, ["releaseSeconds", "crankSeconds", "spannedSeconds", "leftHandSeconds", "boltDrawnSeconds", "reloadedSeconds", "from", "to", "direction"]);
      const fields = { ...(Object.keys(crossbow).length ? { crossbow } : {}), ...(secondaryPose ? { secondaryPose } : {}) };
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          ...(Object.keys(fields).length ? { fields } : {}),
          ...(removedTravel ? { removedTravel: removedTravel as [number, number] } : {}),
          ...(observed.releaseSeconds === undefined ? {} : { contactSeconds: observed.releaseSeconds as number }),
        },
      };
    },
  },
  {
    id: "cast", script: "cast_clips.py", clips: RANGER_CAST_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      const { length, footLength } = WEAPON_PRESETS["staff.crystal"];
      return {
        schemaVersion: 1, clips: [...RANGER_CAST_CLIPS], staff: { length, footLength },
        sockets: { staff: at("hand_r.staff"), staffLeft: at("hand_l.staff"), tome: at("hand_l.shield"), weapon: at("hand_r.weapon") },
      };
    },
    clip: (name, family) => {
      // The upper-body clips list their joints (the nova and the summon are full body); the release, the channel point
      // and the summon's chain pose go to the clip's entry. The contact is the authored release: a wind-up moves faster.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const cast = pickKeys(observed, ["releaseSeconds", "startsFrom", "channelJoint", "channelPoint", "sweepSeconds", "pulseSeconds", "kneelSeconds"]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          fields: { ...(Object.keys(cast).length ? { cast } : {}), ...(secondaryPose ? { secondaryPose } : {}) },
          ...(observed.releaseSeconds === undefined ? {} : { contactSeconds: observed.releaseSeconds as number }),
        },
      };
    },
  },
  {
    id: "social", script: "social_clips.py", clips: RANGER_SOCIAL_CLIPS,
    arguments: () => ({ schemaVersion: 1, clips: [...RANGER_SOCIAL_CLIPS] }),
    clip: (name, family) => {
      // The upper-body clips list their joints; the timing, chain and door fields go to the clip's `social` object and
      // the chain pose beside it. The contact is the authored moment the hand meets the door or the other hand.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const social = pickKeys(observed, [
        "next", "startsFrom", "gestureSeconds", "pointSeconds", "bowSeconds", "pumpSeconds", "handoverSeconds", "contactSeconds",
        "doorPushSeconds", "doorPullSeconds", "knockSeconds", "handleHeightMeters", "knockHeightMeters", "doorDistanceMeters",
        "contactJoint", "contactPoint", "contactAt", "kneelSeconds", "pickupSeconds", "standSeconds", "seatedSeconds", "sitUpSeconds",
        "lieSeconds", "seatHeightMeters", "seatPelvis", "bedHeightMeters", "lyingPelvis",
      ]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          fields: { ...(Object.keys(social).length ? { social } : {}), ...(secondaryPose ? { secondaryPose } : {}) },
          ...(observed.contactSeconds === undefined ? {} : { contactSeconds: observed.contactSeconds as number }),
        },
      };
    },
  },
  {
    id: "chores", script: "chore_clips.py", clips: RANGER_CHORE_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return { schemaVersion: 1, clips: [...RANGER_CHORE_CLIPS], sockets: { carry: at("hand_r.carry"), staff: at("hand_r.staff") } };
    },
    clip: (name, family) => {
      // The upper-body clips list their joints; the timing, the carry socket and the tool go to the clip's `chore`
      // object and the chain pose beside it. The hoe's contact is the authored strike.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const chore = pickKeys(observed, ["carrySocket", "strokeSeconds", "circleSeconds", "counterHeightMeters", "pourSeconds", "strikeSeconds", "tool"]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          fields: { ...(Object.keys(chore).length ? { chore } : {}), ...(secondaryPose ? { secondaryPose } : {}) },
          ...(observed.contactSeconds === undefined ? {} : { contactSeconds: observed.contactSeconds as number }),
        },
      };
    },
  },
  {
    id: "posts", script: "post_clips.py", clips: RANGER_POST_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return { schemaVersion: 1, clips: [...RANGER_POST_CLIPS], sockets: { staff: at("hand_r.staff"), stowed: at("hip_l.stowed") } };
    },
    clip: (name, family) => {
      // The upper-body clips list their joints; the timing, the spear and the wall go to the clip's `post` object and
      // the chain pose beside it.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const post = pickKeys(observed, ["tool", "restSocket", "saluteSeconds", "lookSeconds", "strokeSeconds", "kneelDropMeters", "wallBehindMeters"]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: { fields: { ...(Object.keys(post).length ? { post } : {}), ...(secondaryPose ? { secondaryPose } : {}) } },
      };
    },
  },
  {
    id: "gather", script: "gather_clips.py", clips: RANGER_GATHER_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return { schemaVersion: 1, clips: [...RANGER_GATHER_CLIPS], sockets: { weapon: at("hand_r.weapon") } };
    },
    clip: (name, family) => {
      // The emotes list their joints; the tool, the timing and the chest's lid go to the clip's `gather` object and the
      // chain pose beside it. The chop's and the mining strike's contact is the authored strike.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const gather = pickKeys(observed, ["tool", "strikeSeconds", "pickSeconds", "strokeSeconds", "kneelDropMeters", "lidSeconds", "lidHingeAt",
        "lidDepthMeters", "lidOpenDegrees", "clapSeconds"]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          fields: { ...(Object.keys(gather).length ? { gather } : {}), ...(secondaryPose ? { secondaryPose } : {}) },
          ...(observed.contactSeconds === undefined ? {} : { contactSeconds: observed.contactSeconds as number }),
        },
      };
    },
  },
  {
    id: "raid", script: "raid_clips.py", clips: RANGER_RAID_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return { schemaVersion: 1, clips: [...RANGER_RAID_CLIPS], sockets: { weapon: at("hand_r.weapon"), carry: at("chest.carry") } };
    },
    clip: (name, family) => {
      // The carries, torch and hack list their joints; the tool, the load, the props and the timing go to the clip's
      // `raid` object and the chain pose beside it. The hack's and the hammer's contact is the authored strike.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const raid = pickKeys(observed, ["tool", "load", "strikeSeconds", "boardAt", "pushHandsAt", "leverSeconds", "leverPivotAt", "leverLengthMeters",
        "leverDegrees", "setSeconds", "probeSeconds", "trapAt", "landSeconds", "from", "to", "stride"]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          fields: { ...(Object.keys(raid).length ? { raid } : {}), ...(secondaryPose ? { secondaryPose } : {}) },
          ...(observed.contactSeconds === undefined ? {} : { contactSeconds: observed.contactSeconds as number }),
        },
      };
    },
  },
  {
    id: "strike", script: "strike_clips.py", clips: [...RANGER_STRIKE_CLIPS, ...RANGER_REACT_CLIPS, ...RANGER_HEAVY_CARRY_CLIPS],
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...RANGER_STRIKE_CLIPS, ...RANGER_REACT_CLIPS, ...RANGER_HEAVY_CARRY_CLIPS],
        sockets: {
          weapon: at("hand_r.weapon"), offhand: at("hand_l.weapon"), shield: at("hand_l.shield"), staff: at("hand_r.staff"), staffLeft: at("hand_l.staff"),
          bow: at("hand_l.bow"),
        },
      };
    },
    clip: (name, family) => {
      // The standing strikes list their joints; the weapon, the contact's strike point, band and reach and the jump's
      // hand-off go to the clip's `strike` object and the chain pose beside it. The contact is the authored strike.
      // #711: a reaction's side, peak and fall go to its `react` object instead; it has no contact.
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      // #823: a great weapon's carry on the heavy run records the item, its stride, the ground speed and planted spans.
      if (observed.carry) {
        const fields = pickKeys(observed, ["groundSpeedMetersPerSecond", "footPlants"]);
        return { authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
          extra: { fields: { carry: { ...observed.carry, stride: observed.stride }, ...fields, secondaryPose } } };
      }
      if (observed.contactSeconds === undefined) {
        const react = pickKeys(observed, ["hitSide", "peakSeconds", "landSeconds", "lies"]);
        return { authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string, extra: { fields: { react, secondaryPose } } };
      }
      const strike = pickKeys(observed, ["weapon", "offhand", "strikeJoint", "contactSeconds", "tipAt", "band", "reachMeters", "landSeconds", "from", "to",
        "windupEnd", "recoveryStart", "footPlants", "stride", "groundSpeedMetersPerSecond"]);
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: { fields: { strike, ...(secondaryPose ? { secondaryPose } : {}) }, contactSeconds: observed.contactSeconds as number },
      };
    },
  },
  {
    id: "ready", script: "ready_clips.py", clips: RANGER_READY_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...RANGER_READY_CLIPS],
        sockets: {
          weapon: at("hand_r.weapon"), offhand: at("hand_l.weapon"), shield: at("hand_l.shield"), staff: at("hand_r.staff"), staffLeft: at("hand_l.staff"),
          bow: at("hand_l.bow"), hipL: at("hip_l.stowed"), hipR: at("hip_r.stowed"), back: at("back.stowed"), backBow: at("back.bow.stowed"),
        },
      };
    },
    clip: (name, family) => {
      // The family, the sockets and the swap go to the clip's `ready` object; a guard (#738) is full body, keeping every joint.
      const { joints, source, ready, ...observed } = family.clips[name] as Json;
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ready, ...observed }, basedOn: source as string,
        extra: { fields: { ready } },
      };
    },
  },
  {
    id: "defend", script: "defend_clips.py", clips: RANGER_DEFEND_CLIPS,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...RANGER_DEFEND_CLIPS],
        sockets: { weapon: at("hand_r.weapon"), offhand: at("hand_l.weapon"), shield: at("hand_l.shield"), staff: at("hand_r.staff"), staffLeft: at("hand_l.staff") },
      };
    },
    clip: (name, family) => {
      // The kind, the item and the parry, contact or impact time go to the clip's `defend` object; the full-body clips
      // add their travel and chain pose. The contact of a riposte, the bash and the kick is the authored one.
      const { joints, source, defend, secondaryPose, removedTravel, contactSeconds, ...observed } = family.clips[name] as Json;
      const fields = { defend: { ...defend, ...(contactSeconds === undefined ? {} : { contactSeconds }) }, ...(secondaryPose ? { secondaryPose } : {}) };
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, defend, ...(contactSeconds === undefined ? {} : { contactSeconds }), ...observed },
        basedOn: source as string,
        extra: {
          fields, ...(removedTravel ? { removedTravel: removedTravel as [number, number] } : {}),
          ...(contactSeconds === undefined ? {} : { contactSeconds: contactSeconds as number }),
        },
      };
    },
  },
  moveFamily("move", RANGER_MOVE_CLIPS),
  moveFamily("work", RANGER_WORK_CLIPS),
  {
    id: "ride", script: "ride_clips.py", clips: RANGER_RIDE_CLIPS,
    arguments: () => ({ schemaVersion: 1, clips: [...RANGER_RIDE_CLIPS], ...rideArguments() }),
    clip: (name, family) => {
      // The horse clip it plays with, the seat and the mount's ground and standing place go to the clip's `ride` object
      // and the chain pose beside it.
      const { source, secondaryPose, ...observed } = family.clips[name] as Json;
      const ride = pickKeys(observed, ["mount", "seat", "horseClip", "from", "to", "riseSeconds", "sitSeconds", "handsAlongReinsMeters", "standAt",
        "standFacing", "groundBelowSeatMeters"]);
      return {
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: { fields: { ride, secondaryPose } },
      };
    },
  },
  stanceFamily("guard", RANGER_GUARD_CLIPS),
  stanceFamily("signal", RANGER_SIGNAL_CLIPS),
  {
    id: "tinker", script: "tinker_clips.py", clips: RANGER_TINKER_CLIPS,
    arguments: ({ socket }) => ({ schemaVersion: 1, clips: [...RANGER_TINKER_CLIPS], sockets: { weapon: socketAt(socket)("hand_r.weapon") } }),
    clip: (name, family) => {
      // The kind, the items and the marks go to the clip's `tinker` object, beside the chain pose. A throw's contact is
      // its release.
      const { source, secondaryPose, ...observed } = family.clips[name] as Json;
      const releaseSeconds = (observed.tinker as Json).releaseSeconds as number | undefined;
      return {
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: { fields: { tinker: observed.tinker, secondaryPose }, ...(releaseSeconds === undefined ? {} : { contactSeconds: releaseSeconds }) },
      };
    },
  },
];

/**
 * A family of adapters/blender/defend_clips.py's stance clips (#773): the clip's `guard` or `signal` object (its kind,
 * items, `from`/`to` and marks) and its chain pose; the bash's contact is the authored one.
 */
function stanceFamily(id: "guard" | "signal", clips: readonly string[]): ClipFamily {
  return {
    id, script: "defend_clips.py", clips,
    arguments: ({ socket }) => {
      const at = socketAt(socket);
      return {
        schemaVersion: 1, clips: [...clips],
        sockets: { weapon: at("hand_r.weapon"), offhand: at("hand_l.weapon"), shield: at("hand_l.shield"), staff: at("hand_r.staff"), staffLeft: at("hand_l.staff") },
      };
    },
    clip: (name, family) => {
      const { source, secondaryPose, contactSeconds, ...observed } = family.clips[name] as Json;
      return {
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...(contactSeconds === undefined ? {} : { contactSeconds }), ...observed },
        basedOn: source as string,
        extra: { fields: { [id]: observed[id], secondaryPose }, ...(contactSeconds === undefined ? {} : { contactSeconds: contactSeconds as number }) },
      };
    },
  };
}

/**
 * A family of adapters/blender/move_clips.py (#767): the upper-body clips list their joints; the timing, the chain
 * names and the tanner's beam and frame go to the clip's `move` object and the chain pose beside it. The slam's contact
 * is the fist meeting the ground, the throw's the release.
 */
function moveFamily(id: string, clips: readonly string[]): ClipFamily {
  return {
    id, script: "move_clips.py", clips,
    arguments: () => ({ schemaVersion: 1, clips: [...clips] }),
    clip: (name, family) => {
      const { joints, source, secondaryPose, ...observed } = family.clips[name] as Json;
      const move = pickKeys(observed, ["from", "to", "heaveSeconds", "shiversPerSecond", "landSeconds", "drop", "dragSeconds", "slides", "vanishSeconds",
        "appearSeconds", "takeoffSeconds", "contactSeconds", "strideSeconds", "releaseSeconds", "yankSeconds", "strokeSeconds", "beamAt", "gripSeconds",
        "hookSeconds", "frameAt"]);
      const contact = (observed.contactSeconds ?? observed.releaseSeconds) as number | undefined;
      return {
        ...(joints ? { keep: joints as string[] } : {}),
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: { fields: { move, ...(secondaryPose ? { secondaryPose } : {}) }, ...(contact === undefined ? {} : { contactSeconds: contact }) },
      };
    },
  };
}
