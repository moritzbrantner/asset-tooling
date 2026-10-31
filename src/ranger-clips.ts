// The Ranger's authored clips (#425): the clip names of each family and the family table the build runs, one Blender
// run per family. Adding a family is one table row plus its Blender recipe; adding a clip is one name.
import { ARCHERY_PRESETS } from "./archery-recipes.js";

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
    /** Traversal clips (#416): the whole travel (glTF x, y, z) the in-place clip stands for, and their own fields. */
    rootTravel?: [number, number, number]; traversal?: Json;
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

/** The authored clip families, in bundle order after the retargeted library clips. */
export const RANGER_CLIP_FAMILIES: readonly ClipFamily[] = [
  nameOnly("gait", "gait_clips.py", RANGER_GAIT_CLIPS),
  {
    id: "bow", script: "bow_clips.py", clips: RANGER_BOW_CLIPS,
    arguments: ({ socket }) => {
      const at = (id: string) => { const { joint, translation, rotation } = socket(id); return { joint, translation, rotation }; };
      return {
        schemaVersion: 1, clips: [...RANGER_BOW_CLIPS],
        sockets: { bow: at("hand_l.bow"), arrow: at("hand_r.arrow"), quiver: at("back.quiver") },
        braceHeight: ARCHERY_PRESETS["bow.long"].braceHeight, arrowLength: ARCHERY_PRESETS.arrow.length, quiverLength: ARCHERY_PRESETS["quiver.back"].length,
      };
    },
    clip: (name, family) => {
      const { drawMeters, frames, ...marks } = family.clips[name] as Json;
      return {
        authored: { recipe: family.recipe, fps: family.fps, frames, ...marks }, basedOn: "Idle_Loop",
        extra: { bow: { sampleRate: family.fps, drawMeters, ...pickKeys(marks, ["releaseSeconds", "arrowDrawnSeconds", "nockedSeconds"]) } },
      };
    },
  },
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
          traversal: { ...fields, contacts, secondaryPose, ...(travelSamples ? { travelSamples: { sampleRate: family.fps, translations: travelSamples } } : {}) },
        },
      };
    },
  },
];
