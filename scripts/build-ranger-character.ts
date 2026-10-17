// Build the Ranger character bundle end to end from its canonical catalog members
// (docs/humanoid-ranger.md):
//   bun scripts/build-ranger-character.ts --processor-checkout <3d-lab checkout> --out <directory> [--version 1|2|3|4|5|6|7]
// The 3d-lab checkout must be source-clean at the commit stability/processors.json pins for
// `three-d-animation-retarget`, with its cargo dependencies fetched (the processor runs --offline).
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed
// to <directory>/humanoid.ranger.male.tar (+ .sha256) with scripts/pack-asset-bundle.ts.
// Version 2 (#260/#113) adds the run, sword, death and shield-guard clips, the sword
// and shield weapon entries (Blender weapon recipe, ASSET_TOOLING_BLENDER) and the
// humanoid-sockets-v1 descriptor as an attachment of the character entry. Version 1 is the #110 build.
// Version 3 (#257) is v2 with game-resolution PNG textures (scene.textures.resize.gltf@1,
// RANGER_TEXTURE_POLICY); keys, variants, scenes, materials, UVs, clips and sockets are those of v2.
// Version 4 (#113) is v3 with the anatomically derived hand sockets
// (examples/weapons/derive-sockets.ts); v2 and v3 keep shipping the bundle-v2 descriptor.
// Version 5 (#268) is v4 with every clip retargeted through all three spine joints: the
// optional `upper-chest` HumanoidBone (3d-lab 4e69c0f) carries DEF-spine.003 -> spine_03, and `chest`
// now binds the middle joint DEF-spine.002 -> spine_02 (RANGER_V5_BONE_MAP). v1-v4 keep their
// two-bone spine map; the processor leaves an unmapped `upper-chest` exactly as before, so they
// still build their recorded tars at the new pin.
// Version 6 (the default, #112) is v5 with the traversal clips (UAL1 jump, crouch and roll; UAL2 climb
// and slide) and a `humanoid-clips` attachment that records each clip's source, loop flag, duration,
// the source root displacement removed by in-place retargeting, and the ground speed of the gaits.
// Version 7 (the default, #113 bow slice and #114) is v6 with the scripted bow, arrow and quiver entries
// (adapters/blender/archery.py; the bow is skinned to `grip` and `nock`), the archery sockets, and the
// owner-picked sword, shield, hit and cast clips; `humanoid-clips` adds each clip's combat role and,
// for strikes, the contact time.
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
export type RangerVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const RANGER_VERSIONS: readonly RangerVersion[] = [1, 2, 3, 4, 5, 6, 7];
export const RANGER_DEFAULT_VERSION: RangerVersion = 7;
/** v3 (#257): per-slot maximum texture edges for browser delivery; images are never upscaled. */
export const RANGER_TEXTURE_POLICY = {
  maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 },
  default: 1024,
} as const;

/** The head/face subset of the UBC body (docs/gltf-subset.md, owner option A on #110). */
export const RANGER_HEAD_RECIPE = { keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"], policy: POLICY };

/** Hips joints whose model-space height is each rig's reference height (`source` = UAL1, `source2` = UAL2). */
export const RANGER_HIPS = { source: "DEF-hips", source2: "pelvis", target: "pelvis" } as const;

export type RangerClip = { name: string; library: "clips" | "clips2"; rootMotion: "in-place" };
/** The v1 UAL1 clips and how they are retargeted (in-place: root translation removed, vertical bob kept). */
export const RANGER_CLIPS: readonly RangerClip[] = [
  { name: "Idle_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Walk_Loop", library: "clips", rootMotion: "in-place" },
];
/** v2 (#260, #113): run gaits, sword idle/attack and death from UAL1, the shield guard from UAL2; source names kept. */
export const RANGER_V2_CLIPS: readonly RangerClip[] = [
  ...RANGER_CLIPS,
  { name: "Jog_Fwd_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Sprint_Loop", library: "clips", rootMotion: "in-place" },
  { name: "Sword_Idle", library: "clips", rootMotion: "in-place" },
  { name: "Sword_Attack", library: "clips", rootMotion: "in-place" },
  { name: "Death01", library: "clips", rootMotion: "in-place" },
  { name: "Idle_Shield_Loop", library: "clips2", rootMotion: "in-place" },
];
/** v6 (#112): jump, crouch, roll, climb and slide clips. The free Standard libraries have no backward, strafe, start/stop or turn clips. */
export const RANGER_V6_CLIPS: readonly RangerClip[] = [
  ...RANGER_V2_CLIPS,
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
/** v7 (#114, owner picks 2026-10-17): sword strikes, shield, hit reactions and casting. Bow clips are split out. */
export const RANGER_V7_CLIPS: readonly RangerClip[] = [
  ...RANGER_V6_CLIPS,
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
 * v7 combat roles in `humanoid-clips` (#114 Q1, owner picks after preview): `contact` names the joint whose
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
};
/** The forward gait loops whose ground speed the v6 `humanoid-clips` attachment records. */
export const RANGER_GAITS: ReadonlySet<string> = new Set(["Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Crouch_Fwd_Loop"]);
/** The clips a bundle version retargets, in bundle order. */
export function rangerClips(version: RangerVersion): readonly RangerClip[] {
  return version === 1 ? RANGER_CLIPS : version < 6 ? RANGER_V2_CLIPS : version === 6 ? RANGER_V6_CLIPS : RANGER_V7_CLIPS;
}
export const RANGER_CLIPS_ATTACHMENT = "humanoid-clips";
/** v2 equipment entries: weapon-recipe presets, parented at runtime through the sockets descriptor. */
export const RANGER_V2_EQUIPMENT: readonly { key: string; piece: WeaponPiece }[] = [
  { key: "equipment.sword.arming", piece: "sword.arming" },
  { key: "equipment.shield.heater", piece: "shield.heater" },
];
/** v7 archery entries (#113 bow slice): archery-recipe presets, parented at runtime through the sockets descriptor. */
export const RANGER_V7_ARCHERY: readonly { key: string; piece: ArcheryPiece }[] = [
  { key: "equipment.bow.long", piece: "bow.long" },
  { key: "equipment.arrow", piece: "arrow" },
  { key: "equipment.quiver.back", piece: "quiver.back" },
];
export const RANGER_SOCKETS_ATTACHMENT = "humanoid-sockets";
/** The current descriptor (v7: the hand, stowed and archery sockets, derived by examples/weapons/derive-sockets.ts). */
export const RANGER_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.male.sockets.json";
/** The descriptor bundles v4-v6 ship (no archery sockets), kept byte for byte so those versions stay reproducible. */
export const RANGER_V4_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.male.sockets.bundle-v4.json";
/** The descriptor bundles v2 and v3 ship, kept byte for byte so those versions stay reproducible. */
export const RANGER_V2_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.male.sockets.bundle-v2.json";
/** The sockets descriptor a bundle version ships (v1 has none). */
export function rangerSocketsDescriptor(version: RangerVersion): string | undefined {
  return version === 1 ? undefined : version < 4 ? RANGER_V2_SOCKETS_DESCRIPTOR : version < 7 ? RANGER_V4_SOCKETS_DESCRIPTOR : RANGER_SOCKETS_DESCRIPTOR;
}
export const RANGER_SAMPLE_RATE = 30;

/**
 * HumanoidBone id -> UAL1 Rigify `DEF-*` joint (source) and UBC/Outfits joint (target), as v1-v4 bind it:
 * two spine bones, so DEF-spine.002 / spine_02 stay unmapped (#268).
 */
export const RANGER_BONE_MAP: Record<string, { source: string; target: string }> = {
  root: { source: "root", target: "root" },
  hips: { source: "DEF-hips", target: "pelvis" },
  spine: { source: "DEF-spine.001", target: "spine_01" },
  chest: { source: "DEF-spine.003", target: "spine_03" },
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
/** v5 (#268): all three spine joints, each mapped exactly once (`upper-chest` sits between `chest` and `neck`). */
export const RANGER_V5_BONE_MAP: Record<string, { source: string; target: string }> = Object.fromEntries(
  Object.entries(RANGER_BONE_MAP).flatMap(([bone, binding]) =>
    bone === "chest"
      ? [["chest", { source: "DEF-spine.002", target: "spine_02" }], ["upper-chest", { source: "DEF-spine.003", target: "spine_03" }]]
      : [[bone, binding]]),
);
/** UAL2 shares the UBC/Outfits joint names, so its map binds the same name on both sides. */
const sameName = (map: Record<string, { source: string; target: string }>) =>
  Object.fromEntries(Object.entries(map).map(([bone, { target }]) => [bone, { source: target, target }]));
export const RANGER_UBC_BONE_MAP: Record<string, { source: string; target: string }> = sameName(RANGER_BONE_MAP);
export const RANGER_V5_UBC_BONE_MAP: Record<string, { source: string; target: string }> = sameName(RANGER_V5_BONE_MAP);
/** The UAL1 and UAL2 bone maps a bundle version retargets with. */
export function rangerBoneMaps(version: RangerVersion) {
  return version >= 5 ? { clips: RANGER_V5_BONE_MAP, clips2: RANGER_V5_UBC_BONE_MAP } : { clips: RANGER_BONE_MAP, clips2: RANGER_UBC_BONE_MAP };
}

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
 * The v6 `humanoid-clips` descriptor (docs/humanoid-ranger.md#clip-motion): per clip its source, duration,
 * loop flag, the source hips displacement scaled to the Ranger (x/z removed by in-place, y kept) and,
 * for the gaits, the ground speed at which a planted foot moves backwards in the retargeted clip.
 */
async function rangerClipMotion(root: string, { character, targetRig, sourceRigs, libraries, clips, catalogIds, roles = false }: {
  character: AssetRef; targetRig: AssetRef; sourceRigs: Partial<Record<RangerClip["library"], AssetRef>>;
  libraries: Partial<Record<RangerClip["library"], AssetRef>>;
  clips: { name: string; library: string; source: AssetRef; observations: Json }[]; catalogIds: Record<RangerClip["library"], string>;
  roles?: boolean;
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
    const library = clip.library as RangerClip["library"];
    const source = await read(libraries[library]!);
    const animation = source.getRoot().listAnimations().find((candidate) => candidate.getName() === clip.name)!;
    const hipsName = library === "clips" ? RANGER_HIPS.source : RANGER_HIPS.source2;
    const hips = source.getRoot().listNodes().find((node) => node.getName() === hipsName)!;
    const start = atKey(animation, () => 0, () => hips.getWorldTranslation());
    const end = atKey(animation, (count) => count - 1, () => hips.getWorldTranslation());
    const scale = (targetRig.metadata.referenceHeight as number) / (sourceRigs[library]!.metadata.referenceHeight as number);
    const entry: Json = {
      name: clip.name,
      source: { catalogId: catalogIds[library], clip: clip.name, animationSha256: clip.source.sha256 },
      durationSeconds: round4(clip.observations.endSeconds - clip.observations.startSeconds),
      loop: clip.name.endsWith("_Loop"),
      interpolation: "LINEAR",
      rootMotion: clip.observations.rootMotion,
      sourceRootDisplacement: { x: round4((end[0] - start[0]) * scale), y: round4((end[1] - start[1]) * scale), z: round4((end[2] - start[2]) * scale) },
    };
    if (RANGER_GAITS.has(clip.name)) {
      const retargeted = target.getRoot().listAnimations().find((candidate) => candidate.getName() === clip.name)!;
      const times = Array.from(retargeted.listSamplers()[0]!.getInput()!.getArray()!);
      const poses = times.map((_, index) => atKey(retargeted, () => index, () => feet.map((foot) => foot.getWorldTranslation())));
      const speeds: number[] = [];
      for (let index = 0; index + 1 < poses.length; index += 1) {
        const planted = poses[index]![0]![1] <= poses[index]![1]![1] ? 0 : 1;
        speeds.push(-(poses[index + 1]![planted]![2] - poses[index]![planted]![2]) / (times[index + 1]! - times[index]!));
      }
      speeds.sort((a, b) => a - b);
      entry.groundSpeedMetersPerSecond = round4(speeds[Math.floor(speeds.length / 2)]!);
    }
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

export async function buildRangerCharacter({ processorCheckout, outDir, version = RANGER_DEFAULT_VERSION, log = () => {} }: {
  processorCheckout: string; outDir: string; version?: RangerVersion; log?: (line: string) => void;
}) {
  if (!RANGER_VERSIONS.includes(version)) throw new Error("Ranger bundle version must be 1, 2, 3, 4, 5, 6 or 7");
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
  const importGltf = async (entry: { archive: string; path: string }) => {
    const gltfId = memberId(entry);
    const source = await member(gltfId);
    const json = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) resources.push(await member(resourceId(entry.archive, gltfId, uri)));
    return single(await executeGltfProductionImportOperation(root, { inputs: { source, resources }, parameters: { resourceUris: uris, policy: POLICY } }));
  };

  log("import body and outfit (scene.import.gltf@2)");
  const outfit = await importGltf(RANGER_MEMBERS.outfit);
  const body = await importGltf(RANGER_MEMBERS.body);
  log("subset body to head/face (scene.subset.skinned.gltf@1)");
  const head = single(await executeGltfSubsetSkinnedOperation(root, { inputs: { source: body }, parameters: RANGER_HEAD_RECIPE }));
  log("compose on the Male_Ranger skeleton (scene.compose.skinned.gltf@1)");
  const composed = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: outfit, parts: [head] }, parameters: { policy: POLICY } }));

  log("extract target rig and source clips (scene.extract.animation.gltf@1)");
  const targetRig = single(await executeGltfExtractAnimationOperation(root, { inputs: { source: composed }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
  const boneMaps = rangerBoneMaps(version);
  const libraries = {
    clips: { hips: RANGER_HIPS.source, bindings: boneMaps.clips, member: () => member(memberId(RANGER_MEMBERS.clips)) },
    clips2: { hips: RANGER_HIPS.source2, bindings: boneMaps.clips2, member: () => member(memberId(RANGER_MEMBERS.clips2)) },
  } as const;
  const loaded: Partial<Record<RangerClip["library"], AssetRef>> = {};
  const sourceRigs: Partial<Record<RangerClip["library"], AssetRef>> = {};
  const clips: { name: string; library: string; source: AssetRef; retargeted: AssetRef; observations: Json }[] = [];
  for (const clip of rangerClips(version)) {
    const lib = libraries[clip.library];
    const library = loaded[clip.library] ??= await lib.member();
    const extracted = await executeGltfExtractAnimationOperation(root, {
      inputs: { source: library }, parameters: { hipsJoint: lib.hips, clip: clip.name, policy: POLICY },
    });
    const sourceRig = sourceRigs[clip.library] = single(extracted, "rig");
    const source = single(extracted, "animation");
    log(`retarget ${clip.name} (animation.retarget@1, rootMotion ${clip.rootMotion})`);
    const retargeted = await executeAnimationRetargetOperation(root, {
      inputs: { animation: source, "source-rig": sourceRig, "target-rig": targetRig },
      parameters: { bindings: lib.bindings, sampleRate: RANGER_SAMPLE_RATE, rootMotion: clip.rootMotion },
    }, processor);
    clips.push({ name: clip.name, library: clip.library, source, retargeted: single(retargeted), observations: retargeted.observations as Json });
  }

  log("embed clips (scene.embed.animation.gltf@1)");
  const animated = single(await executeGltfEmbedAnimationOperation(root, {
    inputs: { source: composed, animations: clips.map((clip) => clip.retargeted) },
    parameters: { clips: clips.map((clip) => ({ name: clip.name })), policy: POLICY },
  }));

  // v3 and later: the same GLB with game-resolution textures; nothing but image bytes changes.
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
  const character = version >= 3 ? await resizeTextures(RANGER_BUNDLE_KEY, animated) : animated;

  const selections: Json[] = [{ key: RANGER_BUNDLE_KEY, variant: RANGER_BUNDLE_VARIANT }];
  const assets: AssetRef[] = [character];
  const attachments: AssetRef[] = [];
  const weapons: Record<string, AssetRef> = {};
  let sockets: AssetRef | undefined;
  let clipMotion: AssetRef | undefined;
  const descriptorPath = rangerSocketsDescriptor(version);
  if (descriptorPath) {
    log(`attach ${descriptorPath} as '${RANGER_SOCKETS_ATTACHMENT}'`);
    const descriptor = await readFile(path.join(REPOSITORY_ROOT, descriptorPath));
    const { jointNames } = JSON.parse((await resolveAssetObject(root, targetRig)).toString("utf8"));
    validateHumanoidSocketDescriptor(JSON.parse(descriptor.toString("utf8")), { joints: jointNames });
    sockets = (await storeAssetObject(root, { bytes: descriptor, kind: "humanoid-sockets", mediaType: "application/json" })).asset;
    selections[0]!.attachments = [{ name: RANGER_SOCKETS_ATTACHMENT }];
    attachments.push(sockets);
    if (version >= 6) {
      log(`measure clip motion and attach '${RANGER_CLIPS_ATTACHMENT}'`);
      clipMotion = await rangerClipMotion(root, { character, targetRig, sourceRigs, libraries: loaded, clips, catalogIds: { clips: memberId(RANGER_MEMBERS.clips), clips2: memberId(RANGER_MEMBERS.clips2) }, roles: version >= 7 });
      selections[0]!.attachments.push({ name: RANGER_CLIPS_ATTACHMENT });
      attachments.push(clipMotion);
    }
    for (const { key, piece } of RANGER_V2_EQUIPMENT) {
      log(`generate ${piece} (external.blender.script@1 weapon recipe, scene.import.gltf@2)`);
      weapons[key] = await buildWeapon(root, piece);
      selections.push({ key, variant: RANGER_BUNDLE_VARIANT });
      assets.push(version >= 3 ? await resizeTextures(key, weapons[key]!) : weapons[key]!);
    }
    if (version >= 7) {
      for (const { key, piece } of RANGER_V7_ARCHERY) {
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
    inputs: version >= 2 ? { assets, attachments } : { assets },
  });
  const tarPath = path.join(root, `${RANGER_BUNDLE_KEY}.tar`);
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
      version,
      processor: { repository: processor.repository, revision: processor.revision },
      outfit, body, head, composed, targetRig, sourceRigs, libraries: loaded, animated,
      clips: clips.map(({ name, library, source, retargeted, observations }) => ({ name, library, source, retargeted, observations })),
      ...(version >= 2 ? { sockets, socketsDescriptor: descriptorPath, weapons } : {}),
      ...(version >= 3 ? { character, textures, texturePolicy: RANGER_TEXTURE_POLICY } : {}),
      ...(version >= 6 ? { clipMotion } : {}),
    },
  };
}

function parseArguments(args: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--processor-checkout", "--out", "--version"].includes(flag!) || !value) return undefined;
    options[flag!.slice(2)] = value;
  }
  if (options.version !== undefined && !RANGER_VERSIONS.map(String).includes(options.version)) return undefined;
  const version = (options.version === undefined ? RANGER_DEFAULT_VERSION : Number(options.version)) as RangerVersion;
  return options["processor-checkout"] && options.out ? { processorCheckout: options["processor-checkout"], outDir: options.out, version } : undefined;
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error("Usage: bun scripts/build-ranger-character.ts --processor-checkout <absolute 3d-lab checkout> --out <directory> [--version 1|2|3|4|5|6|7]");
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
