// The Ranger's authored clips (#425): the clip names of each family and the family table the build runs, one Blender
// run per family. Adding a family is one table row plus its Blender recipe; adding a clip is one name.
import { ARCHERY_PRESETS } from "./archery-recipes.js";
import { WEAPON_PRESETS } from "./weapon-recipes.js";

type Json = Record<string, any>;

/**
 * #112, #399 (owner answers 2026-10-18 and 2026-10-29, Atlas 6.1.7): original directional gaits, walk start/stop and
 * turns authored in Blender (adapters/blender/gait_clips.py) from the CC0 UAL1 `Jog_Fwd_Loop`, `Walk_Loop` and
 * `Idle_Loop` and explicit foot trajectories. The walk and jog clips are one matched family (same stance, the same
 * swing phases at foot plant). No Mixamo data. They follow the library clips in bundle order.
 */
export const RANGER_GAIT_CLIPS = [
  "Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop", "Walk_Bwd_Loop", "Walk_Strafe_Left_Loop", "Walk_Strafe_Right_Loop",
  "Walk_Start", "Walk_Stop", "Turn_Left", "Turn_Right",
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
 * reference). Every one keeps only the `spine_01` subtree. They follow the upper-body bow clips in bundle order.
 */
export const RANGER_CROSSBOW_CLIPS = ["Crossbow_Idle_Loop", "Crossbow_Aim_Loop", "Crossbow_Fire", "Crossbow_Reload"] as const;
/**
 * #420 (the mmorpg Arcanist, Necromancer, Cleric and Druid): shared casting styles, the staff and mace strikes and the
 * Warden's war cry, authored in place on the Ranger rig by adapters/blender/cast_clips.py from explicit hand frames on
 * `hand_r.staff`, `hand_l.staff` (the left hand on the shaft), `hand_r.weapon` (mace or sword) and the left palm (two-bone
 * arm IK; Mixamo only as reference). The left hand's casting shapes are keyed. All but `Cast_Nova` and
 * `Cast_Summon_Raise` keep only the `spine_01` subtree. They follow the crossbow clips in bundle order.
 */
export const RANGER_CAST_CLIPS = [
  "Cast_Charge_Loop", "Cast_Release_Push", "Cast_Release_Overhand", "Cast_Channel_Beam_Loop", "Cast_Channel_Drain_Loop",
  "Cast_Channel_Sky_Loop", "Cast_Nova", "Cast_Cone", "Cast_Curse_Point", "Cast_Ground_Sweep", "Cast_Self_Ward", "Cast_Ally",
  "Warcry", "Cast_Summon_Raise", "Cast_Summon_Call", "Staff_Strike_A", "Staff_Strike_B", "Mace_Swing_A", "Mace_Swing_B",
  "Cast_Raise_Wall", "Cast_Interrupted",
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
 * #418 (the mmorpg Rogue, the Field Marauder and the Redbrand bandage): twin-dagger, throw, flourish and bandage clips
 * authored in place on the Ranger rig by adapters/blender/dagger_clips.py from explicit grip frames on the
 * `hand_r.weapon` and `hand_l.weapon` sockets and the `belt.throwable` draw (two-bone arm IK; Mixamo only as
 * reference). Every one keeps only the `spine_01` subtree. They follow the sword clips in bundle order; the throws carry
 * `drawSeconds` and `releaseSeconds`.
 */
export const RANGER_DAGGER_CLIPS = [
  "Dagger_Idle_Loop", "Dagger_Stab_R", "Dagger_Slash_L", "Dagger_Sinister", "Dagger_Poison", "Dagger_Gouge",
  "Flourish_Haste", "Throw_Knife", "Throw_Lob", "Bandage_Self",
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
  nameOnly("gait", "gait_clips.py", RANGER_GAIT_CLIPS),
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
      // Every clip is upper body; a throw's draw and release go to the clip's entry. The contact is the authored strike
      // (or, for a throw, the release), since a dagger hand turns fastest in the wind-up.
      const { joints, source, ...observed } = family.clips[name] as Json;
      const fields = pickKeys(observed, ["drawSeconds", "releaseSeconds"]);
      const contactSeconds = observed.releaseSeconds ?? (observed.contactFraction === undefined ? undefined : observed.contactFraction * observed.durationSeconds);
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
      // Every clip is upper body; the shot's release and the reload's marks go to the clip's `crossbow` object. The
      // contact is the release, as for the bow.
      const { joints, source, ...observed } = family.clips[name] as Json;
      const crossbow = pickKeys(observed, ["releaseSeconds", "crankSeconds", "spannedSeconds", "leftHandSeconds", "boltDrawnSeconds", "reloadedSeconds"]);
      return {
        keep: joints as string[],
        authored: { recipe: family.recipe, clip: name, fps: family.fps, ...observed }, basedOn: source as string,
        extra: {
          ...(Object.keys(crossbow).length ? { fields: { crossbow } } : {}),
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
];
