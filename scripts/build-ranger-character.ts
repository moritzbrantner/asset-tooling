// Build the current Ranger character bundle end to end from its canonical catalog members
// (docs/humanoid-ranger.md):
//   bun scripts/build-ranger-character.ts --processor-checkout <3d-lab checkout> --out <directory> --mixamo-dir <dir> [--figure male|female]
// The 3d-lab checkout must be source-clean at the commit stability/processors.json pins for
// `three-d-animation-retarget`, with its cargo dependencies fetched (the processor runs --offline).
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed
// to <directory>/humanoid.ranger.male.tar (+ .sha256) with scripts/pack-asset-bundle.ts. There is one
// current recipe and no numbered bundle versions (Atlas Decision 7.1.5); the result replaces the assets of
// the rolling `humanoid-ranger-male` release.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Animation, type Document, type Node } from "@gltf-transform/core";
import { executeAnimationRetargetOperation } from "../src/animation-processing-operations.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfEmbedAnimationOperation, executeGltfExtractAnimationOperation } from "../src/gltf-animation-operations.js";
import { executeGltfComposeSkinnedOperation } from "../src/gltf-compose-operations.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { executeGltfSubsetSkinnedOperation } from "../src/gltf-subset-operations.js";
import { executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import { validateHumanoidSocketDescriptor } from "../src/humanoid-sockets.js";
import { generateAsset } from "../src/index.js";
import { WEAPON_PRESETS, createWeaponAssetSpec, readWeaponRecipeSource, type WeaponPiece } from "../src/weapon-recipes.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { executeImageDecodeOperation, executeImageEncodePngOperation } from "../src/image-codec-operations.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "../src/image-rgba8.js";
import { sha256Bytes } from "../src/hash.js";
import { parseAssetSpec } from "../src/schema.js";
import { LOD_LEVELS, LOD_RATIOS, LOD_SWITCH_DISTANCE_HINTS, generateLodLevel, type LodLevel } from "../src/lod-recipe.js";
import { ARMOR_FACTION, ARMOR_KITS, createArmorAssetSpec, readArmorRecipeSource, type ArmorKit, type ArmorOutput } from "../src/armor-recipes.js";
import { ARCHERY_PRESETS, createArcheryAssetSpec, readArcheryRecipeSource, type ArcheryPiece } from "../src/archery-recipes.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWED = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const POLICY = { allowedValidatorWarnings: ALLOWED };

export const RANGER_BUNDLE_KEY = "humanoid.ranger.male";
export const RANGER_BUNDLE_VARIANT = "default";
export const RANGER_PROCESSOR_ID = "three-d-animation-retarget";
export const RANGER_PROCESSOR_MANIFEST = "examples/asset-tooling-animation-adapter/Cargo.toml";

export const RANGER_MEMBERS = {
  body: { archive: "quaternius.universal-base-characters-standard", path: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" },
  outfit: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" },
  clips: { archive: "quaternius.universal-animation-library-standard", path: "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb" },
  clips2: { archive: "quaternius.universal-animation-library-2-standard", path: "Universal Animation Library 2 [Standard]/Unreal-Godot/UAL2_Standard.glb" },
} as const;
/** #257: per-slot maximum texture edges for browser delivery; images are never upscaled. */
export const RANGER_TEXTURE_POLICY = {
  maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 },
  default: 1024,
} as const;

/**
 * The Ranger figures (#115, owner answer Q1 = A): the male Ranger, and the female Ranger built from the UBC female
 * body and the Female_Ranger outfit with the same clips, equipment and recipe.
 */
export type RangerFigure = "male" | "female";
export const RANGER_FIGURES = {
  male: { key: "humanoid.ranger.male", body: RANGER_MEMBERS.body, outfit: RANGER_MEMBERS.outfit, headMeshes: ["Face", "Face.001"] },
  female: {
    key: "humanoid.ranger.female",
    body: { archive: "quaternius.universal-base-characters-standard", path: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Female_FullBody.gltf" },
    outfit: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Ranger.gltf" },
    headMeshes: ["Eyebrows", "Eyes"],
  },
} as const satisfies Record<RangerFigure, { key: string; body: { archive: string; path: string }; outfit: { archive: string; path: string }; headMeshes: readonly string[] }>;
export const RANGER_FEMALE_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.female.sockets.json";

/**
 * Appearance (#116, owner answers 2026-10-17: Light and Dark skins, hairstyles per figure, both hair textures,
 * black/brown/blond tints, a toggleable hood). Skin variants re-import the body and outfit with the Light base
 * colours bound to their URIs; the outfit's skin texture has no Light original, so it is derived (Q13 = A).
 */
const UBC = "quaternius.universal-base-characters-standard";
const UBC_HAIR_DIR = "Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)";
export const RANGER_APPEARANCE = {
  male: {
    skinLight: { body: { uri: "T_Superhero_Male_Dark.png", member: "Universal Base Characters[Standard]/Base Characters/Textures/T_Superhero_Male_Ligh.png" }, outfitUri: "T_Regular_Male_Dark_BaseColor.png" },
    hood: "Male_Ranger_Head_Hood",
    hair: ["Hair_Buzzed", "Hair_SimpleParted", "Hair_Long"],
    eyebrows: "Eyebrows",
  },
  female: {
    skinLight: { body: { uri: "T_Superhero_Female_Dark_BaseColor.png", member: "Universal Base Characters[Standard]/Base Characters/Textures/T_Superhero_Female_Light_BaseColor.png" }, outfitUri: "T_Regular_Female_Dark_BaseColor.png" },
    hood: "Female_Ranger_Head_Hood",
    hair: ["Hair_Long", "Hair_Buns"],
    eyebrows: "Eyebrows",
  },
} as const;
/** Hair tints (D4, linear RGB), applied as the base colour factor on top of `T_Hair_1`. */
export const RANGER_HAIR_TINTS = { black: [0.02, 0.02, 0.02], brown: [0.18, 0.09, 0.04], blond: [0.62, 0.48, 0.25] } as const;
export const RANGER_APPEARANCE_ATTACHMENT = "humanoid-appearance";
/**
 * Outfits (#117, owner answers 2026-10-17): the archer is the Ranger outfit (`default`); the soldier and the knight
 * wear the Peasant outfit under original armour from adapters/blender/armor.py (male figure first, Q8). Each outfit is a
 * character variant with the same skeleton and clips; its rigid plates are one `armor.<kit>` entry whose nodes ride the
 * `<joint>.armor` sockets, and its skinned garments are composed into the variant.
 */
export const RANGER_PEASANT_OUTFIT = { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Peasant.gltf" } as const;
const hairKey = (style: string) => `hair.${style.replace(/^Hair_/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;

/** The head/face subset of the UBC body (docs/gltf-subset.md, owner option A on #110). */
export const RANGER_HEAD_RECIPE = { keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"], policy: POLICY };

/** Hips joints whose model-space height is each rig's reference height (`source` = UAL1, `source2` = UAL2). */
export const RANGER_HIPS = { source: "DEF-hips", source2: "pelvis", target: "pelvis" } as const;

/** `mixamo` clips (Atlas 6.1.6) come from a local Mixamo FBX named by `mixamo`; raw files never enter git or the catalog. */
export type RangerClip = { name: string; library: "clips" | "clips2" | "mixamo"; rootMotion: "in-place"; mixamo?: string };
/** Idle and walk (#110), retargeted in place: root translation removed, vertical bob kept. */
const BASE_CLIPS: readonly RangerClip[] = [
  { name: "Idle_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Walk_Loop", library: "clips", rootMotion: "in-place" },
];
/** #260, #113: run gaits, sword idle/attack and death from UAL1, the shield guard from UAL2; source names kept. */
const GAIT_COMBAT_CLIPS: readonly RangerClip[] = [
  { name: "Jog_Fwd_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Sprint_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Sword_Idle", library: "clips", rootMotion: "in-place" },
  { name: "Sword_Attack", library: "clips", rootMotion: "in-place" },
  { name: "Death01", library: "clips", rootMotion: "in-place" },
  { name: "Idle_Shield_Loop", library: "clips2", rootMotion: "in-place" },
];
/** #112: jump, crouch, roll, climb and slide clips. */
const TRAVERSAL_CLIPS: readonly RangerClip[] = [
  { name: "Jump_Start", library: "clips", rootMotion: "in-place" },
  { name: "Jump_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Jump_Land", library: "clips", rootMotion: "in-place" },
  { name: "Crouch_Idle_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Crouch_Fwd_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Roll", library: "clips", rootMotion: "in-place" },
  { name: "Roll_RM", library: "clips", rootMotion: "in-place" },
  { name: "ClimbUp_1m_RM", library: "clips2", rootMotion: "in-place" },
  { name: "Slide_Start", library: "clips2", rootMotion: "in-place" },
  { name: "Slide_Loop", library: "clips2", rootMotion: "in-place" },
  { name: "Slide_Exit", library: "clips2", rootMotion: "in-place" },
];
/** #114 (owner picks 2026-10-17): sword strikes, shield, hit reactions and casting. Bow clips are split out (#277). */
const COMBAT_CLIPS: readonly RangerClip[] = [
  { name: "Sword_Regular_A", library: "clips2", rootMotion: "in-place" },
  { name: "Sword_Regular_A_Rec", library: "clips2", rootMotion: "in-place" },
  { name: "Sword_Regular_B", library: "clips2", rootMotion: "in-place" },
  { name: "Sword_Regular_B_Rec", library: "clips2", rootMotion: "in-place" },
  { name: "Sword_Regular_C", library: "clips2", rootMotion: "in-place" },
  { name: "Sword_Regular_Combo", library: "clips2", rootMotion: "in-place" },
  { name: "Sword_Block", library: "clips2", rootMotion: "in-place" },
  { name: "Idle_Shield_Break", library: "clips2", rootMotion: "in-place" },
  { name: "Shield_OneShot", library: "clips2", rootMotion: "in-place" },
  { name: "Hit_Chest", library: "clips", rootMotion: "in-place" },
  { name: "Hit_Head", library: "clips", rootMotion: "in-place" },
  { name: "Hit_Knockback", library: "clips2", rootMotion: "in-place" },
  { name: "Spell_Simple_Enter", library: "clips", rootMotion: "in-place" },
  { name: "Spell_Simple_Idle_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Spell_Simple_Shoot", library: "clips", rootMotion: "in-place" },
  { name: "Spell_Simple_Exit", library: "clips", rootMotion: "in-place" },
];
/**
 * Combat roles in `humanoid-clips` (#114 Q1, owner picks after preview): `contact` names the joint whose
 * fastest moment is recorded as `contactSeconds` (presentation data; it never times gameplay).
 */
export const RANGER_CLIP_ROLES: Readonly<Record<string, { role: string; contact?: string }>> = {
  Sword_Idle: { role: "sword.ready" },
  Sword_Attack: { role: "sword.strike", contact: "hand_r" },
  Death01: { role: "death" },
  Idle_Shield_Loop: { role: "shield.guard-hold" },
  Sword_Regular_A: { role: "sword.light-strike", contact: "hand_r" },
  Sword_Regular_A_Rec: { role: "sword.light-strike.recovery" },
  Sword_Regular_B: { role: "sword.counter", contact: "hand_r" },
  Sword_Regular_B_Rec: { role: "sword.counter.recovery" },
  Sword_Regular_C: { role: "sword.heavy-strike", contact: "hand_r" },
  Sword_Regular_Combo: { role: "sword.light-chain", contact: "hand_r" },
  Sword_Block: { role: "shield.block-impact" },
  Idle_Shield_Break: { role: "shield.block-break" },
  Shield_OneShot: { role: "shield.bash", contact: "hand_l" },
  Hit_Chest: { role: "hit.chest" },
  Hit_Head: { role: "hit.head" },
  Hit_Knockback: { role: "hit.knockback" },
  Spell_Simple_Enter: { role: "cast.enter" },
  Spell_Simple_Idle_Loop: { role: "cast.hold" },
  Spell_Simple_Shoot: { role: "cast.release", contact: "hand_r" },
  Spell_Simple_Exit: { role: "cast.exit" },
  Hit_Shove_Spin: { role: "hit.shove" },
  Bow_Aim_Loop: { role: "bow.aim" },
  Bow_Draw: { role: "bow.draw" },
  Bow_Hold_Loop: { role: "bow.hold" },
  Bow_Release: { role: "bow.release", contact: "hand_r" },
  Bow_Recovery: { role: "bow.recovery" },
  Bow_Cancel: { role: "bow.cancel" },
};
/**
 * #112 (Atlas 6.1.6): walk-speed backward, strafe, start/stop and turn clips and a heavy shove reaction from
 * Mixamo ("Without Skin" FBX, 30 fps, Y Bot), read from `--mixamo-dir`. Travelling clips are retargeted in place;
 * the removed travel and its speed are recorded in `humanoid-clips`.
 */
const MIXAMO_CLIPS: readonly RangerClip[] = [
  { name: "Walk_Bwd_Loop", library: "mixamo", mixamo: "Walking Backwards", rootMotion: "in-place" },
  { name: "Walk_Strafe_Left_Loop", library: "mixamo", mixamo: "Left Strafe Walking", rootMotion: "in-place" },
  { name: "Walk_Strafe_Right_Loop", library: "mixamo", mixamo: "Right Strafe Walking", rootMotion: "in-place" },
  { name: "Walk_Start", library: "mixamo", mixamo: "Start Walking", rootMotion: "in-place" },
  { name: "Walk_Stop", library: "mixamo", mixamo: "Walk To Stop", rootMotion: "in-place" },
  { name: "Turn_Left", library: "mixamo", mixamo: "Left Turn", rootMotion: "in-place" },
  { name: "Turn_Right", library: "mixamo", mixamo: "Right Turn", rootMotion: "in-place" },
  { name: "Hit_Shove_Spin", library: "mixamo", mixamo: "Shoved Reaction With Spin", rootMotion: "in-place" },
];
export const RANGER_MIXAMO_LICENSE = "Mixamo (Adobe): free, royalty-free use in games; raw Mixamo files are not redistributed (Atlas 6.1.6)";
/**
 * #112, owner answer 2026-10-18, Atlas 6.1.7): original jog-speed backward and strafe clips authored in Blender
 * (adapters/blender/jog_clips.py) from the CC0 UAL1 `Jog_Fwd_Loop` and explicit foot trajectories. No Mixamo data.
 */
export const RANGER_AUTHORED_CLIPS = ["Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop"] as const;
/**
 * #277 (owner answer 2026-10-18: original keyframes in Blender, Mixamo as reference only): bow clips authored on the
 * animated Ranger by adapters/blender/bow_clips.py from explicit archery targets and the figure's archery sockets.
 * They follow the jog clips in bundle order. Each records the string draw for the bow's `nock` joint.
 */
export const RANGER_BOW_CLIPS = ["Bow_Aim_Loop", "Bow_Draw", "Bow_Hold_Loop", "Bow_Release", "Bow_Recovery", "Bow_Cancel"] as const;
/** The gait loops whose ground speed the `humanoid-clips` attachment records. */
export const RANGER_GAITS: ReadonlySet<string> = new Set(["Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Crouch_Fwd_Loop", "Jog_Bwd_Loop"]);
/** The library clips the Ranger retargets, in bundle order; RANGER_AUTHORED_CLIPS follow them. */
export const RANGER_CLIPS: readonly RangerClip[] = [...BASE_CLIPS, ...GAIT_COMBAT_CLIPS, ...TRAVERSAL_CLIPS, ...COMBAT_CLIPS, ...MIXAMO_CLIPS];
export const RANGER_CLIPS_ATTACHMENT = "humanoid-clips";
/** Weapon entries: weapon-recipe presets, parented at runtime through the sockets descriptor. */
export const RANGER_WEAPONS: readonly { key: string; piece: WeaponPiece }[] = [
  { key: "equipment.sword.arming", piece: "sword.arming" },
  { key: "equipment.shield.heater", piece: "shield.heater" },
];
/** Archery entries (#113 bow slice): archery-recipe presets, parented at runtime through the sockets descriptor. */
export const RANGER_ARCHERY: readonly { key: string; piece: ArcheryPiece }[] = [
  { key: "equipment.bow.long", piece: "bow.long" },
  { key: "equipment.arrow", piece: "arrow" },
  { key: "equipment.quiver.back", piece: "quiver.back" },
];
export const RANGER_SOCKETS_ATTACHMENT = "humanoid-sockets";
/** The male sockets descriptor (hand, stowed, archery, hair and armour sockets; examples/weapons/derive-sockets.ts). */
export const RANGER_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.male.sockets.json";
export const RANGER_SAMPLE_RATE = 30;

/**
 * HumanoidBone id -> UAL1 Rigify `DEF-*` joint (source) and UBC/Outfits joint (target). All three spine joints are
 * mapped exactly once: `upper-chest` (3d-lab 4e69c0f) sits between `chest` and `neck` (#268).
 */
export const RANGER_BONE_MAP: Record<string, { source: string; target: string }> = {
  root: { source: "root", target: "root" },
  hips: { source: "DEF-hips", target: "pelvis" },
  spine: { source: "DEF-spine.001", target: "spine_01" },
  chest: { source: "DEF-spine.002", target: "spine_02" },
  "upper-chest": { source: "DEF-spine.003", target: "spine_03" },
  neck: { source: "DEF-neck", target: "neck_01" },
  head: { source: "DEF-head", target: "Head" },
  "left-shoulder": { source: "DEF-shoulder.L", target: "clavicle_l" },
  "left-upper-arm": { source: "DEF-upper_arm.L", target: "upperarm_l" },
  "left-lower-arm": { source: "DEF-forearm.L", target: "lowerarm_l" },
  "left-hand": { source: "DEF-hand.L", target: "hand_l" },
  "right-shoulder": { source: "DEF-shoulder.R", target: "clavicle_r" },
  "right-upper-arm": { source: "DEF-upper_arm.R", target: "upperarm_r" },
  "right-lower-arm": { source: "DEF-forearm.R", target: "lowerarm_r" },
  "right-hand": { source: "DEF-hand.R", target: "hand_r" },
  "left-upper-leg": { source: "DEF-thigh.L", target: "thigh_l" },
  "left-lower-leg": { source: "DEF-shin.L", target: "calf_l" },
  "left-foot": { source: "DEF-foot.L", target: "foot_l" },
  "left-toes": { source: "DEF-toe.L", target: "ball_l" },
  "right-upper-leg": { source: "DEF-thigh.R", target: "thigh_r" },
  "right-lower-leg": { source: "DEF-shin.R", target: "calf_r" },
  "right-foot": { source: "DEF-foot.R", target: "foot_r" },
  "right-toes": { source: "DEF-toe.R", target: "ball_r" },
};
/** UAL2 shares the UBC/Outfits joint names, so its map binds the same name on both sides. */
const sameName = (map: Record<string, { source: string; target: string }>) =>
  Object.fromEntries(Object.entries(map).map(([bone, { target }]) => [bone, { source: target, target }]));
export const RANGER_UBC_BONE_MAP: Record<string, { source: string; target: string }> = sameName(RANGER_BONE_MAP);
/** HumanoidBone id -> Mixamo joint (`mixamorig:*`, three spine joints). Mixamo has no separate root joint. */
export const RANGER_MIXAMO_BONE_MAP: Record<string, { source: string; target: string }> = Object.fromEntries(Object.entries({
  hips: "Hips", spine: "Spine", chest: "Spine1", "upper-chest": "Spine2", neck: "Neck", head: "Head",
  "left-shoulder": "LeftShoulder", "left-upper-arm": "LeftArm", "left-lower-arm": "LeftForeArm", "left-hand": "LeftHand",
  "right-shoulder": "RightShoulder", "right-upper-arm": "RightArm", "right-lower-arm": "RightForeArm", "right-hand": "RightHand",
  "left-upper-leg": "LeftUpLeg", "left-lower-leg": "LeftLeg", "left-foot": "LeftFoot", "left-toes": "LeftToeBase",
  "right-upper-leg": "RightUpLeg", "right-lower-leg": "RightLeg", "right-foot": "RightFoot", "right-toes": "RightToeBase",
}).map(([bone, joint]) => [bone, { source: `mixamorig:${joint}`, target: RANGER_BONE_MAP[bone]!.target }]));
function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, file), "utf8"));
}

/** The pinned 3d-lab processor, run from an explicit checkout (verified clean at the pinned commit). */
export async function rangerProcessor(checkout: string) {
  if (!path.isAbsolute(checkout)) throw new Error("--processor-checkout must be an absolute path");
  const pins = await readJson("stability/processors.json");
  const pin = pins.processors.find((entry: Json) => entry.id === RANGER_PROCESSOR_ID);
  if (!pin) throw new Error(`stability/processors.json has no '${RANGER_PROCESSOR_ID}' pin`);
  return {
    repository: pin.repository, revision: pin.commit, executable: "cargo", scriptPath: "run",
    prefixArguments: ["--quiet", "--offline", "--manifest-path", path.join(checkout, ...pin.manifestPath.split("/")), "--bin", "animation_retarget", "--"],
    checkoutRoot: checkout,
  };
}

/** Generate one weapon-recipe preset through the pinned Blender backend (ASSET_TOOLING_BLENDER) and store it. */
async function buildWeapon(root: string, piece: WeaponPiece) {
  const source = await readWeaponRecipeSource();
  const workspace = path.join(root, "weapons", piece);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "weapon.py"), source.bytes);
  const spec = createWeaponAssetSpec({ assetId: `weapon.${piece}`, parameters: WEAPON_PRESETS[piece], scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "weapon.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
}

const round4 = (value: number) => Math.round(value * 1e4) / 1e4 + 0;

/** Applies each channel's keyframe `pick(count)` to its node, runs `read`, then restores the rest TRS. */
function atKey<T>(animation: Animation, pick: (count: number) => number, read: () => T): T {
  const saved = new Map<Node, [number[], number[], number[]]>();
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode()!, targetPath = channel.getTargetPath(), sampler = channel.getSampler()!;
    if (!saved.has(node)) saved.set(node, [[...node.getTranslation()], [...node.getRotation()], [...node.getScale()]]);
    const value: number[] = [];
    sampler.getOutput()!.getElement(pick(sampler.getInput()!.getCount()), value);
    if (targetPath === "translation") node.setTranslation(value as any);
    else if (targetPath === "rotation") node.setRotation(value as any);
    else if (targetPath === "scale") node.setScale(value as any);
  }
  try { return read(); } finally {
    for (const [node, [t, r, s]] of saved) node.setTranslation(t as any).setRotation(r as any).setScale(s as any);
  }
}

/**
 * The `humanoid-clips` descriptor (docs/humanoid-ranger.md#clip-motion): per clip its source, duration,
 * loop flag, the source hips displacement scaled to the Ranger (x/z removed by in-place, y kept) and,
 * for the gaits, the ground speed at which a planted foot moves backwards in the retargeted clip.
 */
type RangerBuiltClip = {
  name: string; library: string; source: AssetRef; retargeted: AssetRef; observations: Json;
  /** The GLB the clip was extracted from, its source rig, hips joint and the `humanoid-clips` source fields. */
  libraryAsset: AssetRef; sourceRig: AssetRef; hips: string; sourceInfo: Json;
  /** Mixamo clips: the horizontal pelvis travel (glTF x, z) the Blender retarget removed. */
  removedTravel?: [number, number];
  /** Authored bow clips (#277): the string draw per frame for the bow's `nock` joint, and the archery marks. */
  bow?: Json;
};

const pick = (source: Json, keys: string[]) => Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));

async function rangerClipMotion(root: string, { character, targetRig, clips, roles = false }: {
  character: AssetRef; targetRig: AssetRef; clips: RangerBuiltClip[]; roles?: boolean;
}) {
  const io = new NodeIO();
  const documents = new Map<string, Document>();
  const read = async (asset: AssetRef) => {
    if (!documents.has(asset.sha256)) documents.set(asset.sha256, await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))));
    return documents.get(asset.sha256)!;
  };
  const target = await read(character);
  const targetNode = (name: string) => target.getRoot().listNodes().find((node) => node.getName() === name)!;
  const feet = [targetNode("foot_l"), targetNode("foot_r")];
  const entries: Json[] = [];
  for (const clip of clips) {
    const source = await read(clip.libraryAsset);
    const animation = source.getRoot().listAnimations().find((candidate) => candidate.getName() === clip.name)!;
    const hips = source.getRoot().listNodes().find((node) => node.getName() === clip.hips)!;
    const start = atKey(animation, () => 0, () => hips.getWorldTranslation());
    const end = atKey(animation, (count) => count - 1, () => hips.getWorldTranslation());
    const scale = (targetRig.metadata.referenceHeight as number) / (clip.sourceRig.metadata.referenceHeight as number);
    const entry: Json = {
      name: clip.name,
      source: { ...clip.sourceInfo, clip: clip.name, animationSha256: clip.source.sha256 },
      durationSeconds: round4(clip.observations.endSeconds - clip.observations.startSeconds),
      loop: clip.name.endsWith("_Loop"),
      interpolation: "LINEAR",
      rootMotion: clip.observations.rootMotion,
      sourceRootDisplacement: { x: round4((end[0] - start[0]) * scale), y: round4((end[1] - start[1]) * scale), z: round4((end[2] - start[2]) * scale) },
    };
    if (clip.removedTravel) {
      entry.sourceRootDisplacement.x = round4(clip.removedTravel[0]);
      entry.sourceRootDisplacement.z = round4(clip.removedTravel[1]);
      // Travelling Mixamo clips are made in place; their removed horizontal travel becomes a reference speed.
      const travel = Math.hypot(entry.sourceRootDisplacement.x, entry.sourceRootDisplacement.z);
      if (travel > 0.05) entry.sourceRootSpeedMetersPerSecond = round4(travel / entry.durationSeconds);
    }
    if (RANGER_GAITS.has(clip.name)) {
      const retargeted = target.getRoot().listAnimations().find((candidate) => candidate.getName() === clip.name)!;
      const times = Array.from(retargeted.listSamplers()[0]!.getInput()!.getArray()!);
      const poses = times.map((_, index) => atKey(retargeted, () => index, () => feet.map((foot) => foot.getWorldTranslation())));
      const speeds: number[] = [];
      for (let index = 0; index + 1 < poses.length; index += 1) {
        const planted = poses[index]![0]![1] <= poses[index]![1]![1] ? 0 : 1;
        // A backward gait's planted foot moves forward (+Z); its speed is reported as a positive magnitude too.
        speeds.push((clip.name === "Jog_Bwd_Loop" ? 1 : -1) * (poses[index + 1]![planted]![2] - poses[index]![planted]![2]) / (times[index + 1]! - times[index]!));
      }
      speeds.sort((a, b) => a - b);
      entry.groundSpeedMetersPerSecond = round4(speeds[Math.floor(speeds.length / 2)]!);
    }
    if (clip.bow) entry.bow = clip.bow;
    const combat = roles ? RANGER_CLIP_ROLES[clip.name] : undefined;
    if (combat) {
      entry.role = combat.role;
      if (combat.contact) {
        // Presentation landmark: the sample where the contact joint moves fastest in model space.
        const retargeted = target.getRoot().listAnimations().find((candidate) => candidate.getName() === clip.name)!;
        const joint = targetNode(combat.contact);
        const times = Array.from(retargeted.listSamplers()[0]!.getInput()!.getArray()!);
        const positions = times.map((_, index) => atKey(retargeted, () => index, () => joint.getWorldTranslation()));
        let best = 0, fastest = -1;
        for (let index = 0; index + 1 < positions.length; index += 1) {
          const speed = Math.hypot(...positions[index + 1]!.map((v, k) => v - positions[index]![k]!)) / (times[index + 1]! - times[index]!);
          if (speed > fastest) { fastest = speed; best = index; }
        }
        entry.contact = { joint: combat.contact, seconds: round4((times[best]! + times[best + 1]!) / 2 - times[0]!), speedMetersPerSecond: round4(fastest) };
      }
    }
    entries.push(entry);
  }
  const descriptor = { schema: "humanoid-clips-v1", units: "m", up: "+Y", facing: "+Z", clips: entries };
  return (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "humanoid-clips", mediaType: "application/json" })).asset;
}

/** Convert one local Mixamo FBX to a carrier GLB with that single clip (adapters/blender/mixamo_clip.py). */
async function convertMixamoClip(root: string, fbx: string, clip: string, targetGlb: AssetRef) {
  const source = await readBlenderRecipeSource("mixamo_clip.py");
  const workspace = path.join(root, "mixamo", clip);
  await mkdir(workspace, { recursive: true });
  const bytes = await readFile(fbx);
  await writeFile(path.join(workspace, "clip.fbx"), bytes);
  const target = await resolveAssetObject(root, targetGlb);
  await writeFile(path.join(workspace, "target.glb"), target);
  await writeFile(path.join(workspace, "mixamo_clip.py"), source.bytes);
  const spec = parseAssetSpec({
    schemaVersion: 1, assetId: `mixamo.${clip}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: {
      script: { path: "mixamo_clip.py", sha256: source.sha256 }, fbx: { path: "clip.fbx", sha256: sha256Bytes(bytes) },
      target: { path: "target.glb", sha256: sha256Bytes(target) },
    }, models: {},
    parameters: { blenderVersion: source.blenderVersion, arguments: {
      schemaVersion: 1, clip, bones: Object.fromEntries(Object.values(RANGER_MIXAMO_BONE_MAP).map(({ source, target }) => [source, target])),
      hips: [RANGER_MIXAMO_BONE_MAP.hips!.source, RANGER_MIXAMO_BONE_MAP.hips!.target],
    } }, output: { path: "clip.glb" }, reproducibility: { expected: "exact" },
  });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "clip.glb")), kind: "animation", mediaType: "model/gltf-binary" })).asset;
  return { glb, fbxSha256: sha256Bytes(bytes), observations: (generated.receipt.observations as Json).script as Json };
}

/** Author one original jog clip on the animated Ranger (adapters/blender/jog_clips.py). */
async function authorJogClip(root: string, clip: string, target: AssetRef) {
  const source = await readBlenderRecipeSource("jog_clips.py");
  const workspace = path.join(root, "authored", clip);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jog_clips.py"), source.bytes);
  const targetBytes = await resolveAssetObject(root, target);
  await writeFile(path.join(workspace, "target.glb"), targetBytes);
  const spec = parseAssetSpec({
    schemaVersion: 1, assetId: `authored.${clip}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "jog_clips.py", sha256: source.sha256 }, target: { path: "target.glb", sha256: sha256Bytes(targetBytes) } }, models: {},
    parameters: { blenderVersion: source.blenderVersion, arguments: { schemaVersion: 1, clip } }, output: { path: "clip.glb" }, reproducibility: { expected: "exact" },
  });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "clip.glb")), kind: "animation", mediaType: "model/gltf-binary" })).asset;
  return { glb, observations: (generated.receipt.observations as Json).script as Json };
}

/** Author one original bow clip on the animated Ranger (adapters/blender/bow_clips.py). */
async function authorBowClip(root: string, clip: string, target: AssetRef, socketsDescriptor: Json) {
  const source = await readBlenderRecipeSource("bow_clips.py");
  const workspace = path.join(root, "authored", clip);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "bow_clips.py"), source.bytes);
  const targetBytes = await resolveAssetObject(root, target);
  await writeFile(path.join(workspace, "target.glb"), targetBytes);
  const socket = (id: string) => {
    const found = (socketsDescriptor.sockets as Json[]).find((candidate) => candidate.id === id);
    if (!found) throw new Error(`${clip}: the sockets descriptor has no ${id}`);
    return { joint: found.joint, translation: found.translation, rotation: found.rotation };
  };
  const spec = parseAssetSpec({
    schemaVersion: 1, assetId: `authored.${clip}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "bow_clips.py", sha256: source.sha256 }, target: { path: "target.glb", sha256: sha256Bytes(targetBytes) } }, models: {},
    parameters: { blenderVersion: source.blenderVersion, arguments: {
      schemaVersion: 1, clip,
      sockets: { bow: socket("hand_l.bow"), arrow: socket("hand_r.arrow"), quiver: socket("back.quiver") },
      braceHeight: ARCHERY_PRESETS["bow.long"].braceHeight, arrowLength: ARCHERY_PRESETS.arrow.length, quiverLength: ARCHERY_PRESETS["quiver.back"].length,
    } }, output: { path: "clip.glb" }, reproducibility: { expected: "exact" },
  });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "clip.glb")), kind: "animation", mediaType: "model/gltf-binary" })).asset;
  return { glb, observations: (generated.receipt.observations as Json).script as Json };
}

/** Re-index an extracted clip's channels from its carrier GLB's joint order to the target rig's joint order. */
async function reindexClip(root: string, extracted: AssetOperationResult, targetRig: AssetRef, clip: string) {
  const fromRig = JSON.parse((await resolveAssetObject(root, single(extracted, "rig"))).toString("utf8")).jointNames as string[];
  const toRig = JSON.parse((await resolveAssetObject(root, targetRig)).toString("utf8")).jointNames as string[];
  const document = JSON.parse((await resolveAssetObject(root, single(extracted, "animation"))).toString("utf8"));
  for (const channel of document.channels) {
    const index = toRig.indexOf(fromRig[channel.node]!);
    if (index < 0) throw new Error(`${clip}: joint '${fromRig[channel.node]}' is not in the Ranger rig`);
    channel.node = index;
  }
  document.channels.sort((a: Json, b: Json) => a.node - b.node || ["translation", "rotation", "scale"].indexOf(a.kind) - ["translation", "rotation", "scale"].indexOf(b.kind));
  return (await storeAssetObject(root, {
    bytes: Buffer.from(`${JSON.stringify(document)}\n`), kind: "animation", mediaType: single(extracted, "animation").mediaType,
    metadata: { operation: "clip-reindex-v1", clip, rigSha256: targetRig.sha256 },
  })).asset;
}

/** Fit one armour kit's plates or cloth to the base character (adapters/blender/armor.py) and import the GLB. */
async function buildArmor(root: string, kit: ArmorKit, output: ArmorOutput, target: AssetRef) {
  const source = await readArmorRecipeSource();
  const workspace = path.join(root, "armor", `${kit}-${output}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "armor.py"), source.bytes);
  const targetBytes = await resolveAssetObject(root, target);
  await writeFile(path.join(workspace, "target.glb"), targetBytes);
  const spec = createArmorAssetSpec({ assetId: `armor.${kit}.${output}`, parameters: { schemaVersion: 1, kit, output },
    scriptSha256: source.sha256, targetSha256: sha256Bytes(targetBytes), blenderVersion: source.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "armor.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return { glb: single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } })),
    observations: (generated.receipt.observations as Json).script as Json };
}

/** Generate one archery-recipe preset through the pinned Blender backend and import it (the bow keeps its skin). */
async function buildArchery(root: string, piece: ArcheryPiece) {
  const source = await readArcheryRecipeSource();
  const workspace = path.join(root, "archery", piece);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "archery.py"), source.bytes);
  const spec = createArcheryAssetSpec({ assetId: `archery.${piece}`, parameters: ARCHERY_PRESETS[piece], scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "archery.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
}

export async function buildRangerCharacter({ processorCheckout, outDir, figure = "male", mixamoDir, log = () => {} }: {
  processorCheckout: string; outDir: string; figure?: RangerFigure; mixamoDir?: string; log?: (line: string) => void;
}) {
  const shape = RANGER_FIGURES[figure];
  const bundleKey = shape.key;
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const processor = await rangerProcessor(path.resolve(processorCheckout));
  const providers = await readJson("catalog/providers.json");
  const sources = await readJson("catalog/sources.json");
  const storage = await readJson("catalog/storage.json");
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const memberId = ({ archive, path: memberPath }: { archive: string; path: string }) => {
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
    if (matches.length !== 1) throw new Error(`'${memberPath}' must be registered exactly once`);
    return matches[0]!.id as string;
  };
  // Adjacent basename, or the one member whose metadata.substitutesFor names the URI (docs/humanoid-sources.md).
  const resourceId = (archive: string, gltfId: string, uri: string) => {
    const substitutes = rawSources.filter((source) => source.metadata?.substitutesFor?.some((entry: Json) => entry.member === gltfId && entry.uri === uri));
    if (substitutes.length === 1) return substitutes[0]!.id as string;
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === uri);
    if (matches.length !== 1) throw new Error(`URI '${uri}' must resolve to exactly one member`);
    return matches[0]!.id as string;
  };
  const member = async (sourceId: string) =>
    (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: REPOSITORY_ROOT, objectStoreRoot: root })).asset as AssetRef;
  const importGltf = async (entry: { archive: string; path: string }, overrides: Record<string, AssetRef> = {}) => {
    const gltfId = memberId(entry);
    const source = await member(gltfId);
    const json = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) resources.push(overrides[uri] ?? await member(resourceId(entry.archive, gltfId, uri)));
    return single(await executeGltfProductionImportOperation(root, { inputs: { source, resources }, parameters: { resourceUris: uris, policy: POLICY } }));
  };

  log("import body and outfit (scene.import.gltf@2)");
  const outfit = await importGltf(shape.outfit);
  const body = await importGltf(shape.body);
  log("subset body to head/face (scene.subset.skinned.gltf@1)");
  const head = single(await executeGltfSubsetSkinnedOperation(root, { inputs: { source: body }, parameters: { ...RANGER_HEAD_RECIPE, keepMeshes: [...shape.headMeshes] } }));
  log("compose on the outfit skeleton (scene.compose.skinned.gltf@1)");
  const composed = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: outfit, parts: [head] }, parameters: { policy: POLICY } }));

  log("extract target rig and source clips (scene.extract.animation.gltf@1)");
  const targetRig = single(await executeGltfExtractAnimationOperation(root, { inputs: { source: composed }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
  const boneMaps = { clips: RANGER_BONE_MAP, clips2: RANGER_UBC_BONE_MAP };
  const libraries = {
    clips: { hips: RANGER_HIPS.source, bindings: boneMaps.clips, member: () => member(memberId(RANGER_MEMBERS.clips)) },
    clips2: { hips: RANGER_HIPS.source2, bindings: boneMaps.clips2, member: () => member(memberId(RANGER_MEMBERS.clips2)) },
  } as const;
  const loaded: Partial<Record<string, AssetRef>> = {};
  const sourceRigs: Partial<Record<string, AssetRef>> = {};
  const catalogIds = { clips: memberId(RANGER_MEMBERS.clips), clips2: memberId(RANGER_MEMBERS.clips2) };
  const clips: RangerBuiltClip[] = [];
  for (const clip of RANGER_CLIPS) {
    let lib: { hips: string; bindings: Record<string, { source: string; target: string }> }, library: AssetRef, sourceInfo: Json;
    if (clip.library === "mixamo") {
      if (!mixamoDir) throw new Error(`clip ${clip.name} needs --mixamo-dir with '${clip.mixamo}.fbx' (Atlas 6.1.6)`);
      lib = { hips: "mixamorig:Hips", bindings: RANGER_MIXAMO_BONE_MAP };
      // Owner answer #112.Q6: Mixamo clips are retargeted in Blender (world-space rotation copy and bake) onto
      // the composed rig, then extracted and re-indexed to the target joint order; animation.retarget@1 is not used.
      log(`retarget ${clip.name} in Blender (adapters/blender/mixamo_clip.py, Mixamo '${clip.mixamo}')`);
      const converted = await convertMixamoClip(root, path.join(mixamoDir, `${clip.mixamo}.fbx`), clip.name, composed);
      const extractedMixamo = await executeGltfExtractAnimationOperation(root, {
        inputs: { source: converted.glb }, parameters: { hipsJoint: RANGER_HIPS.target, clip: clip.name, policy: POLICY },
      });
      const fromRig = JSON.parse((await resolveAssetObject(root, single(extractedMixamo, "rig"))).toString("utf8")).jointNames as string[];
      const toRig = JSON.parse((await resolveAssetObject(root, targetRig)).toString("utf8")).jointNames as string[];
      const document = JSON.parse((await resolveAssetObject(root, single(extractedMixamo, "animation"))).toString("utf8"));
      for (const channel of document.channels) {
        const index = toRig.indexOf(fromRig[channel.node]!);
        if (index < 0) throw new Error(`${clip.name}: joint '${fromRig[channel.node]}' is not in the Ranger rig`);
        channel.node = index;
      }
      document.channels.sort((a: Json, b: Json) => a.node - b.node || ["translation", "rotation", "scale"].indexOf(a.kind) - ["translation", "rotation", "scale"].indexOf(b.kind));
      const retargeted = (await storeAssetObject(root, {
        bytes: Buffer.from(`${JSON.stringify(document)}\n`), kind: "animation", mediaType: (single(extractedMixamo, "animation")).mediaType,
        metadata: { operation: "mixamo-retarget-v1", clip: clip.name, rigSha256: targetRig.sha256 },
      })).asset;
      const times = document.channels.flatMap((channel: Json) => channel.keyframes.map((key: Json) => key.time as number));
      const observations = { rootMotion: "in-place", startSeconds: Math.min(...times), endSeconds: Math.max(...times), retarget: converted.observations };
      clips.push({ name: clip.name, library: clip.library, source: converted.glb, retargeted, observations, libraryAsset: converted.glb,
        sourceRig: single(extractedMixamo, "rig"), hips: RANGER_HIPS.target,
        sourceInfo: { provider: "mixamo", title: clip.mixamo, fbxSha256: converted.fbxSha256, license: RANGER_MIXAMO_LICENSE },
        removedTravel: converted.observations.removedTravel as [number, number] });
      continue;
    } else {
      lib = libraries[clip.library];
      library = loaded[clip.library] ??= await lib.member();
      sourceInfo = { catalogId: catalogIds[clip.library] };
    }
    const extracted = await executeGltfExtractAnimationOperation(root, {
      inputs: { source: library }, parameters: { hipsJoint: lib.hips, clip: clip.name, policy: POLICY },
    });
    const sourceRig = sourceRigs[clip.library === "mixamo" ? `mixamo:${clip.name}` : clip.library] = single(extracted, "rig");
    const source = single(extracted, "animation");
    log(`retarget ${clip.name} (animation.retarget@1, rootMotion ${clip.rootMotion})`);
    const retargeted = await executeAnimationRetargetOperation(root, {
      inputs: { animation: source, "source-rig": sourceRig, "target-rig": targetRig },
      parameters: { bindings: lib.bindings, sampleRate: RANGER_SAMPLE_RATE, rootMotion: clip.rootMotion },
    }, processor);
    clips.push({ name: clip.name, library: clip.library, source, retargeted: single(retargeted), observations: retargeted.observations as Json,
      libraryAsset: library, sourceRig, hips: lib.hips, sourceInfo });
  }

  log("embed clips (scene.embed.animation.gltf@1)");
  let animated = single(await executeGltfEmbedAnimationOperation(root, {
    inputs: { source: composed, animations: clips.map((clip) => clip.retargeted) },
    parameters: { clips: clips.map((clip) => ({ name: clip.name })), policy: POLICY },
  }));
  {
    // Authored from the retargeted Jog_Fwd_Loop on this rig, then embedded with the other clips.
    const socketsDescriptor = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, figure === "female" ? RANGER_FEMALE_SOCKETS_DESCRIPTOR : RANGER_SOCKETS_DESCRIPTOR), "utf8"));
    for (const name of RANGER_AUTHORED_CLIPS) {
      log(`author ${name} in Blender (adapters/blender/jog_clips.py)`);
      const authored = await authorJogClip(root, name, animated);
      const extracted = await executeGltfExtractAnimationOperation(root, {
        inputs: { source: authored.glb }, parameters: { hipsJoint: RANGER_HIPS.target, clip: name, policy: POLICY },
      });
      const retargeted = await reindexClip(root, extracted, targetRig, name);
      const times = JSON.parse((await resolveAssetObject(root, retargeted)).toString("utf8")).channels
        .flatMap((channel: Json) => channel.keyframes.map((key: Json) => key.time as number));
      const observations = { rootMotion: "in-place", startSeconds: Math.min(...times), endSeconds: Math.max(...times), authored: authored.observations };
      const speed = authored.observations.referenceSpeedMetersPerSecond as number | undefined;
      const duration = observations.endSeconds - observations.startSeconds;
      clips.push({ name, library: "authored", source: authored.glb, retargeted, observations, libraryAsset: authored.glb,
        sourceRig: single(extracted, "rig"), hips: RANGER_HIPS.target,
        sourceInfo: { authored: "adapters/blender/jog_clips.py", basedOn: { catalogId: catalogIds.clips, clip: "Jog_Fwd_Loop" } },
        ...(speed ? { removedTravel: [(authored.observations.direction === "left" ? 1 : -1) * speed * duration, 0] as [number, number] } : {}) });
    }
    for (const name of RANGER_BOW_CLIPS) {
      log(`author ${name} in Blender (adapters/blender/bow_clips.py)`);
      const authored = await authorBowClip(root, name, animated, socketsDescriptor);
      const extracted = await executeGltfExtractAnimationOperation(root, {
        inputs: { source: authored.glb }, parameters: { hipsJoint: RANGER_HIPS.target, clip: name, policy: POLICY },
      });
      const retargeted = await reindexClip(root, extracted, targetRig, name);
      const times = JSON.parse((await resolveAssetObject(root, retargeted)).toString("utf8")).channels
        .flatMap((channel: Json) => channel.keyframes.map((key: Json) => key.time as number));
      const { drawMeters, fps, frames, recipe, clip: _clip, ...marks } = authored.observations;
      clips.push({ name, library: "authored", source: authored.glb, retargeted, libraryAsset: authored.glb,
        observations: { rootMotion: "in-place", startSeconds: Math.min(...times), endSeconds: Math.max(...times), authored: { recipe, fps, frames, ...marks } },
        sourceRig: single(extracted, "rig"), hips: RANGER_HIPS.target,
        sourceInfo: { authored: "adapters/blender/bow_clips.py", basedOn: { catalogId: catalogIds.clips, clip: "Idle_Loop" } },
        bow: { sampleRate: fps, drawMeters, ...pick(marks, ["releaseSeconds", "arrowDrawnSeconds", "nockedSeconds"]) } });
    }
    animated = single(await executeGltfEmbedAnimationOperation(root, {
      inputs: { source: composed, animations: clips.map((clip) => clip.retargeted) },
      parameters: { clips: clips.map((clip) => ({ name: clip.name })), policy: POLICY },
    }));
  }

  // The same GLB with game-resolution textures; nothing but image bytes changes.
  const textures: Record<string, Json> = {};
  const resizeTextures = async (key: string, glb: AssetRef) => {
    const json = await new NodeIO().binaryToJSON(await resolveAssetObject(root, glb));
    if (!json.json.images?.length) { textures[key] = { images: 0 }; return glb; }
    log(`resize ${key} textures (scene.textures.resize.gltf@1)`);
    const result = await executeGltfTextureResizeOperation(root, { inputs: { source: glb }, parameters: { ...RANGER_TEXTURE_POLICY, policy: POLICY } });
    const { images, imageBytes } = result.observations as Json;
    textures[key] = { source: glb, output: single(result), imageBytes, images };
    return single(result);
  };
  const character = await resizeTextures(bundleKey, animated);

  // #123 (owner answer A): lod1/lod2 of each character variant, decimated in Blender from the clip-less composition.
  // Clips ship once, in `default` (round 4): every other variant and level has the same joints (by name) at the same
  // rest pose, which the build checks, so a consumer plays the default's clips on it by joint name. Light-skin
  // levels reuse the Dark level's geometry with the Light textures.
  const targetRigDocument = JSON.parse((await resolveAssetObject(root, targetRig)).toString("utf8"));
  /** Fails unless `rig` has exactly the target rig's joints, by name, with the same rest TRS (within 1e-4). */
  const assertSameSkeleton = async (rig: AssetRef, label: string) => {
    const other = JSON.parse((await resolveAssetObject(root, rig)).toString("utf8"));
    const rest = (document: Json) => new Map<string, Json>((document.jointNames as string[]).map((name, index) => [name, document.nodes[index]]));
    const mine = rest(targetRigDocument), theirs = rest(other);
    if (mine.size !== theirs.size || [...mine.keys()].some((name) => !theirs.has(name))) throw new Error(`${label}: its joints differ from the Ranger rig`);
    for (const [name, node] of mine) {
      const a = [...(node.translation ?? [0, 0, 0]), ...(node.rotation ?? [0, 0, 0, 1])], b = [...(theirs.get(name)!.translation ?? [0, 0, 0]), ...(theirs.get(name)!.rotation ?? [0, 0, 0, 1])];
      const sign = a.slice(3).reduce((sum, value, k) => sum + value * b[3 + k]!, 0) < 0 ? -1 : 1;
      if (a.some((value, k) => Math.abs(value - (k >= 3 ? sign : 1) * b[k]!) > 1e-4)) throw new Error(`${label}: joint '${name}' rests differently from the Ranger rig`);
    }
  };
  const lodVariants: { variant: string; asset: AssetRef; triangles: number; ratio: number }[] = [];
  const characterLods = async (composition: AssetRef, variant: string) => {
    const levels: Partial<Record<LodLevel, AssetRef>> = {};
    for (const level of LOD_LEVELS) {
      const ratio = LOD_RATIOS.character[level];
      log(`${level} of ${variant} (lod.py, ratio ${ratio})`);
      const lod = await generateLodLevel(root, composition, ratio, `${variant}.${level}`);
      const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: lod.glb }, parameters: { policy: POLICY } }));
      const rig = single(await executeGltfExtractAnimationOperation(root, { inputs: { source: imported }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
      const name = variant === RANGER_BUNDLE_VARIANT ? level : `${variant}.${level}`;
      await assertSameSkeleton(rig, name);
      levels[level] = await resizeTextures(`${bundleKey}/${name}`, imported);
      lodVariants.push({ variant: name, asset: levels[level]!, triangles: lod.observations.trianglesAfter, ratio });
    }
    return levels as Record<LodLevel, AssetRef>;
  };
  /** The Light-skin level: the Dark level with every texture the Dark and Light characters name differently swapped. */
  const lightLods = async (darkLevels: Record<LodLevel, AssetRef>, dark: AssetRef, light: AssetRef, variant: string) => {
    const io = new NodeIO();
    const images = async (asset: AssetRef) => new Map((await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)))).getRoot()
      .listTextures().map((texture) => [texture.getName(), texture.getImage()!] as const));
    const darkImages = await images(dark), lightImages = await images(light);
    for (const level of LOD_LEVELS) {
      const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, darkLevels[level])));
      for (const texture of document.getRoot().listTextures()) {
        const swap = lightImages.get(texture.getName());
        if (swap && Buffer.compare(Buffer.from(swap), Buffer.from(darkImages.get(texture.getName()) ?? new Uint8Array())) !== 0) texture.setImage(swap);
      }
      const asset = (await storeAssetObject(root, { bytes: Buffer.from(await io.writeBinary(document)), kind: darkLevels[level].kind, mediaType: darkLevels[level].mediaType,
        metadata: { lod: level, skin: "skin.light", from: darkLevels[level].sha256 } })).asset;
      const name = `${variant}.${level}`;
      const darkEntry = lodVariants.find((entry) => entry.asset === darkLevels[level])!;
      lodVariants.push({ variant: name, asset, triangles: darkEntry.triangles, ratio: darkEntry.ratio });
    }
  };
  log("character levels of detail (#123)");
  const defaultLods = await characterLods(composed, RANGER_BUNDLE_VARIANT);

  const selections: Json[] = [{ key: bundleKey, variant: RANGER_BUNDLE_VARIANT }];
  const assets: AssetRef[] = [character];
  const attachments: AssetRef[] = [];
  const weapons: Record<string, AssetRef> = {};
  let sockets: AssetRef | undefined;
  let clipMotion: AssetRef | undefined;
  let appearance: Awaited<ReturnType<typeof buildAppearance>> | undefined;
  // #116: the Light skin character (same geometry and clips, other base colours), hair items and descriptor.
  const buildAppearance = async () => {
    const look = RANGER_APPEARANCE[figure];
    const textureMember = (memberPath: string) => member(memberId({ archive: UBC, path: memberPath }));
    const decode = async (texture: AssetRef) => {
      // Catalog textures are `texture` assets; the codec takes the same PNG bytes as an `image`.
      const image = (await storeAssetObject(root, { bytes: await resolveAssetObject(root, texture), kind: "image", mediaType: "image/png" })).asset;
      return parseRgba8Image(await resolveAssetObject(root, single(await executeImageDecodeOperation(root, { inputs: { source: image }, parameters: {} }))));
    };
    // Q13 = A: the outfit's skin texture gets the body Dark -> Light per-channel mean/deviation transfer.
    const bodyDark = await member(resourceId(UBC, memberId(shape.body), look.skinLight.body.uri));
    const bodyLight = await textureMember(look.skinLight.body.member);
    const regularDark = await member(resourceId(shape.outfit.archive, memberId(shape.outfit), look.skinLight.outfitUri));
    const [dark, light, regular] = [await decode(bodyDark), await decode(bodyLight), await decode(regularDark)];
    const stats = (image: Rgba8Image) => [0, 1, 2].map((channel) => {
      let sum = 0, square = 0, count = 0;
      for (let index = 0; index < image.pixels.length; index += 4) {
        if (image.pixels[index + 3]! === 0) continue;
        const value = image.pixels[index + channel]!;
        sum += value; square += value * value; count += 1;
      }
      const mean = sum / count;
      return { mean, deviation: Math.sqrt(Math.max(square / count - mean * mean, 1e-6)) };
    });
    const from = stats(dark), to = stats(light);
    const pixels = Uint8Array.from(regular.pixels, (value, index) => {
      const channel = index % 4;
      if (channel === 3) return value;
      return Math.max(0, Math.min(255, Math.round((value - from[channel]!.mean) / from[channel]!.deviation * to[channel]!.deviation + to[channel]!.mean)));
    });
    const rgba = (await storeAssetObject(root, { bytes: encodeRgba8Image({ width: regular.width, height: regular.height, pixels }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
    const regularLight = single(await executeImageEncodePngOperation(root, { inputs: { source: rgba }, parameters: { compressionLevel: 9 } }));
    const transfer = { from: bodyDark.sha256, to: bodyLight.sha256, source: regularDark.sha256, output: regularLight.sha256,
      channels: [0, 1, 2].map((c) => ({ darkMean: round4(from[c]!.mean), darkDeviation: round4(from[c]!.deviation), lightMean: round4(to[c]!.mean), lightDeviation: round4(to[c]!.deviation) })) };

    const outfitLight = await importGltf(shape.outfit, { [look.skinLight.outfitUri]: regularLight });
    const bodyLightGlb = await importGltf(shape.body, { [look.skinLight.body.uri]: bodyLight });
    const headLight = single(await executeGltfSubsetSkinnedOperation(root, { inputs: { source: bodyLightGlb }, parameters: { ...RANGER_HEAD_RECIPE, keepMeshes: [...shape.headMeshes] } }));
    const composedLight = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: outfitLight, parts: [headLight] }, parameters: { policy: POLICY } }));
    // Clips ship once, in `default`; the Light character shares its skeleton and plays them by joint name.
    const lightCharacter = await resizeTextures(`${bundleKey}/skin.light`, composedLight);
    await lightLods(defaultLods, character, lightCharacter, "skin.light");

    // Hair: static items on the `head.hair` socket, each with both pack textures as variants (D2).
    const hairTexture = { 1: "T_Hair_1", 2: "T_Hair_2" } as const;
    const hair = [];
    for (const style of look.hair) {
      const entry = { archive: UBC, path: `${UBC_HAIR_DIR}/${style}.gltf` };
      const own = JSON.parse((await resolveAssetObject(root, await member(memberId(entry)))).toString("utf8")).images.map((image: Json) => image.uri as string);
      const ownNumber = own.some((uri: string) => uri.startsWith("T_Hair_2")) ? 2 : 1;
      const variants: Record<string, AssetRef> = {};
      for (const number of [1, 2] as const) {
        const overrides: Record<string, AssetRef> = {};
        if (number !== ownNumber) for (const uri of own) overrides[uri] = await member(resourceId(UBC, memberId(entry), uri.replace(hairTexture[ownNumber], hairTexture[number])));
        variants[`hair-${number}`] = await resizeTextures(`${hairKey(style)}/hair-${number}`, await importGltf(entry, overrides));
      }
      hair.push({ key: hairKey(style), style, variants });
    }
    const hairMaterials = async (asset: AssetRef) => (await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, asset)))).getRoot().listMaterials().map((material) => material.getName());
    // #117: the soldier and knight outfit variants and their rigid armour entries.
    const outfits: Json[] = [{ id: "outfit.archer", variant: RANGER_BUNDLE_VARIANT, label: "Archer" }];
    const kits: { kit: ArmorKit; variants: { variant: string; character: AssetRef }[]; plates: AssetRef; cloth: AssetRef; fitTarget: AssetRef; observations: Json[] }[] = [];
    // The soldier and knight outfits are male-only for now (#117 Q8).
    if (figure === "male") {
      log("outfits: Peasant base and fitted armour (#117)");
      const peasant = await importGltf(RANGER_PEASANT_OUTFIT);
      // #301: the Light skin too; the Peasant outfit's skin texture is the same derived Light texture as the Ranger's.
      const peasantLight = await importGltf(RANGER_PEASANT_OUTFIT, { [look.skinLight.outfitUri]: regularLight });
      const fitTarget = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: peasant, parts: [head] }, parameters: { policy: POLICY } }));
      const peasantMeshes = (await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, peasant)))).getRoot().listMeshes().map((mesh) => mesh.getName());
      const { jointNames } = JSON.parse((await resolveAssetObject(root, targetRig)).toString("utf8"));
      for (const kit of ARMOR_KITS) {
        log(`fit ${kit} armour (external.blender.script@1 armor recipe)`);
        const plates = await buildArmor(root, kit, "plates", fitTarget);
        const cloth = await buildArmor(root, kit, "cloth", fitTarget);
        const pieces: Json[] = [...plates.observations.pieces, ...cloth.observations.pieces];
        const hidden = [...new Set(pieces.flatMap((piece) => piece.hides as string[]))].sort();
        // The hidden-body-region list (Q12): base nodes a garment fully covers are left out of the variant.
        const variants: { variant: string; character: AssetRef }[] = [];
        let darkKit: { lods: Record<LodLevel, AssetRef>; character: AssetRef } | undefined;
        for (const [skin, outfitSource, headPart] of [["skin.dark", peasant, head], ["skin.light", peasantLight, headLight]] as const) {
          const base = hidden.length === 0 ? outfitSource : single(await executeGltfSubsetSkinnedOperation(root, {
            inputs: { source: outfitSource }, parameters: { keepJoints: ["root"], minWeight: 1, keepMeshes: peasantMeshes.filter((name) => !hidden.includes(name)), policy: POLICY },
          }));
          const composedKit = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: base, parts: [headPart, cloth.glb] }, parameters: { policy: POLICY } }));
          const kitRig = single(await executeGltfExtractAnimationOperation(root, { inputs: { source: composedKit }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
          if (JSON.stringify(JSON.parse((await resolveAssetObject(root, kitRig)).toString("utf8")).jointNames) !== JSON.stringify(jointNames)) {
            throw new Error(`the ${kit} outfit's joints differ from the Ranger rig, so the clips cannot be shared`);
          }
          const variant = skin === "skin.dark" ? `outfit.${kit}` : `outfit.${kit}.${skin}`;
          await assertSameSkeleton(kitRig, variant);
          // Clips ship once, in `default`; the outfit plays them by joint name.
          const outfitCharacter = await resizeTextures(`${bundleKey}/${variant}`, composedKit);
          variants.push({ variant, character: outfitCharacter });
          if (skin === "skin.dark") darkKit = { lods: await characterLods(composedKit, variant), character: outfitCharacter };
          else await lightLods(darkKit!.lods, darkKit!.character, outfitCharacter, variant);
        }
        const variant = variants[0]!.variant;
        kits.push({ kit, variants, plates: plates.glb, cloth: cloth.glb, fitTarget, observations: pieces });
        outfits.push({
          id: variant, variant, label: kit === "soldier" ? "Soldier" : "Knight",
          skins: [{ id: "skin.dark", variant: variants[0]!.variant }, { id: "skin.light", variant: variants[1]!.variant }],
          base: { outfit: "Male_Peasant", hidden },
          armor: { entry: `armor.${kit}`, pieces: (plates.observations.pieces as Json[]).map((piece) => ({ node: piece.node, socket: `${String(piece.joint).toLowerCase()}.armor`, hides: piece.hides })) },
          garments: (cloth.observations.pieces as Json[]).map((piece) => ({ id: piece.node, nodes: piece.nodes, hides: piece.hides })),
          faction: { materials: [ARMOR_FACTION.material], defaultBaseColorFactor: [...ARMOR_FACTION.default, 1] },
        });
      }
    }
    const characterDocument = await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, character)));
    const eyebrowMaterials = characterDocument.getRoot().listNodes().filter((node) => node.getName() === look.eyebrows && node.getMesh())
      .flatMap((node) => node.getMesh()!.listPrimitives().map((primitive) => primitive.getMaterial()?.getName() ?? ""));
    const descriptor = {
      schema: "humanoid-appearance-v1", character: bundleKey,
      skins: [
        { id: "skin.dark", variant: RANGER_BUNDLE_VARIANT, label: "Dark" },
        { id: "skin.light", variant: "skin.light", label: "Light", derived: { "outfit-skin": transfer } },
      ],
      parts: [{ id: "outfit.hood", nodes: [look.hood], defaultVisible: true }],
      hair: await Promise.all(hair.map(async ({ key, style }) => ({
        id: key, entry: key, socket: "head.hair", source: style,
        textures: [{ id: "hair-1", variant: "hair-1" }, { id: "hair-2", variant: "hair-2" }],
        tintMaterials: await hairMaterials(hair.find((item) => item.key === key)!.variants["hair-1"]!),
        requires: { "outfit.hood": false },
      }))),
      tints: Object.entries(RANGER_HAIR_TINTS).map(([id, color]) => ({ id: `tint.${id}`, baseColorFactor: [...color, 1], texture: "hair-1" })),
      eyebrows: { nodes: [look.eyebrows], tintMaterials: [...new Set(eyebrowMaterials)].sort(), followsHairTint: true },
      ...(figure === "male" ? { outfits } : {}),
      // #123: the levels of detail of each character variant; switch distances are hints, consumers choose.
      levelsOfDetail: lodVariants.map(({ variant, triangles, ratio }) => {
        const level = variant.endsWith("lod1") ? "lod1" : "lod2";
        const of = variant === level ? RANGER_BUNDLE_VARIANT : variant.slice(0, -(level.length + 1));
        return { of, level, variant, ratio, triangles, switchDistanceHint: LOD_SWITCH_DISTANCE_HINTS[level] };
      }),
    };
    const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "humanoid-appearance", mediaType: "application/json" })).asset;
    return { light: lightCharacter, hair, descriptor: descriptorAsset, transfer, composedLight, kits };
  };
  const descriptorPath = figure === "female" ? RANGER_FEMALE_SOCKETS_DESCRIPTOR : RANGER_SOCKETS_DESCRIPTOR;
  if (descriptorPath) {
    log(`attach ${descriptorPath} as '${RANGER_SOCKETS_ATTACHMENT}'`);
    const descriptor = await readFile(path.join(REPOSITORY_ROOT, descriptorPath));
    const { jointNames } = JSON.parse((await resolveAssetObject(root, targetRig)).toString("utf8"));
    validateHumanoidSocketDescriptor(JSON.parse(descriptor.toString("utf8")), { joints: jointNames });
    sockets = (await storeAssetObject(root, { bytes: descriptor, kind: "humanoid-sockets", mediaType: "application/json" })).asset;
    selections[0]!.attachments = [{ name: RANGER_SOCKETS_ATTACHMENT }];
    attachments.push(sockets);
    {
      log("appearance: Light skin variant, hairstyles and the appearance descriptor (#116)");
      appearance = await buildAppearance();
      selections.push({ key: bundleKey, variant: "skin.light" });
      assets.push(appearance.light);
      for (const hair of appearance.hair) for (const [variant, asset] of Object.entries(hair.variants)) {
        selections.push({ key: hair.key, variant });
        assets.push(asset);
      }
      for (const kit of appearance.kits) {
        for (const { variant, character: outfitCharacter } of kit.variants) {
          selections.push({ key: bundleKey, variant });
          assets.push(outfitCharacter);
        }
        selections.push({ key: `armor.${kit.kit}`, variant: RANGER_BUNDLE_VARIANT });
        assets.push(kit.plates);
      }
      selections[0]!.attachments.push({ name: RANGER_APPEARANCE_ATTACHMENT });
      for (const { variant, asset } of lodVariants) {
        selections.push({ key: bundleKey, variant });
        assets.push(asset);
      }
      attachments.push(appearance.descriptor);
    }
    {
      log(`measure clip motion and attach '${RANGER_CLIPS_ATTACHMENT}'`);
      clipMotion = await rangerClipMotion(root, { character, targetRig, clips, roles: true });
      selections[0]!.attachments.push({ name: RANGER_CLIPS_ATTACHMENT });
      attachments.push(clipMotion);
    }
    for (const { key, piece } of RANGER_WEAPONS) {
      log(`generate ${piece} (external.blender.script@1 weapon recipe, scene.import.gltf@2)`);
      weapons[key] = await buildWeapon(root, piece);
      selections.push({ key, variant: RANGER_BUNDLE_VARIANT });
      assets.push(await resizeTextures(key, weapons[key]!));
    }
    {
      for (const { key, piece } of RANGER_ARCHERY) {
        log(`generate ${piece} (external.blender.script@1 archery recipe, scene.import.gltf@2)`);
        weapons[key] = await buildArchery(root, piece);
        selections.push({ key, variant: RANGER_BUNDLE_VARIANT });
        assets.push(await resizeTextures(key, weapons[key]!));
      }
    }
  }

  log(`export gltf-resources-v1 bundle (asset.bundle@4, ${selections.map((selection) => `${selection.key}/${selection.variant}`).join(", ")})`);
  const bundleDir = path.join(root, "bundle");
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
    inputs: { assets, attachments },
  });
  const tarPath = path.join(root, `${bundleKey}.tar`);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  // The consumer pin is the tar's own content-only export.ref.json (docs/asset-bundles.md).
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: {
      figure,
      processor: { repository: processor.repository, revision: processor.revision },
      outfit, body, head, composed, targetRig, sourceRigs, libraries: loaded, animated,
      clips: clips.map(({ name, library, source, retargeted, observations }) => ({ name, library, source, retargeted, observations })),
      sockets, socketsDescriptor: descriptorPath, weapons,
      character, textures, texturePolicy: RANGER_TEXTURE_POLICY,
      clipMotion,
      appearance: appearance && { light: appearance.light, composedLight: appearance.composedLight, transfer: appearance.transfer, hair: appearance.hair, descriptor: appearance.descriptor, kits: appearance.kits },
    },
  };
}

function parseArguments(args: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--processor-checkout", "--out", "--figure", "--mixamo-dir"].includes(flag!) || !value) return undefined;
    options[flag!.slice(2)] = value;
  }
  if (options.figure !== undefined && !Object.hasOwn(RANGER_FIGURES, options.figure)) return undefined;
  const figure = (options.figure ?? "male") as RangerFigure;
  return options["processor-checkout"] && options.out ? { processorCheckout: options["processor-checkout"], outDir: options.out, figure, mixamoDir: options["mixamo-dir"] && path.resolve(options["mixamo-dir"]) } : undefined;
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error("Usage: bun scripts/build-ranger-character.ts --processor-checkout <absolute 3d-lab checkout> --out <directory> --mixamo-dir <dir> [--figure male|female]");
    process.exit(2);
  }
  try {
    const result = await buildRangerCharacter({ ...options, log: (line) => console.error(`[ranger] ${line}`) });
    await writeFile(path.join(path.resolve(options.outDir), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef, exportRefPath: result.exportRefPath }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
