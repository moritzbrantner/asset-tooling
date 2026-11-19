/// <reference path="../src/gltf-validator.d.ts" />
// End-to-end Ranger recipe (docs/humanoid-ranger.md): canonical body/outfit/UAL1/UAL2 members -> import, head
// subset, compose, extract, retarget the library clips through the pinned 3d-lab processor, author the gait, bow,
// grip, swim and hit clips in Blender, embed, generate the equipment, attach the descriptors, then the
// gltf-resources-v1 bundle and release tar. Structural checks only (owner answer 4 on #110: no byte-exact replay,
// no Blender oracle). The full build skips unless the Git LFS payloads are hydrated,
// ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB names a clean 3d-lab checkout at the pinned commit with its cargo
// dependencies fetched and ASSET_TOOLING_BLENDER names Blender.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { clipFamilyProblems, ktx2Size } from "../scripts/pack-downloads.ts";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle } from "../src/asset-bundle.js";
import { validateHumanoidItemDescriptor, validateHumanoidSocketDescriptor } from "../src/humanoid-sockets.js";
import {
  RANGER_APPEARANCE, RANGER_ARCHERY, RANGER_BONE_MAP, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_CLIPS, RANGER_CLIP_DOWNLOADS,
  RANGER_CLIPS_ATTACHMENT, RANGER_CLIP_ROLES, RANGER_FIGURES, RANGER_GAITS, RANGER_HAIR_TINTS, RANGER_MEMBERS,
  RANGER_CLASS_PRESETS, RANGER_HAIR_KIT_OPTIONS, RANGER_ITEM_ATTACHMENT, RANGER_RESIDENT_PRESETS, RANGER_SOCKETS_ATTACHMENT, RANGER_SOCKETS_DESCRIPTOR, RANGER_TEXTURE_POLICY,
  RANGER_UBC_BONE_MAP, RANGER_WEAPONS, RANGER_THROWABLES, RANGER_ITEM_LOD_SELECTION, rangerItemLods, RANGER_OUTFIT_KITS, RANGER_PEASANT_OUTFITS, validateAppearancePresets,
  buildRangerCharacter, rangerItemDescriptor, rangerJobs, rangerPresets,
} from "../scripts/build-ranger-character.ts";
import { RANGER_BOW_CLIPS, RANGER_BOW_UPPER_CLIPS, RANGER_CROSSBOW_CLIPS, RANGER_CAST_CLIPS, RANGER_SOCIAL_CLIPS, RANGER_CHORE_CLIPS, RANGER_POST_CLIPS, RANGER_GATHER_CLIPS, RANGER_RAID_CLIPS, RANGER_STRIKE_CLIPS, RANGER_REACT_CLIPS, RANGER_READY_CLIPS, RANGER_DEFEND_CLIPS, RANGER_CLIP_FAMILIES, RANGER_GAIT_CLIPS, RANGER_GRIPS, RANGER_HIT_CLIPS, RANGER_SWIM_CLIPS, RANGER_DAGGER_CLIPS, RANGER_SWORD_CLIPS, RANGER_TRAVERSAL_CLIPS, RANGER_COMBAT_STANDARD_CLIPS, RANGER_CLEARANCE_CLIPS, rangerGripJoints } from "../src/ranger-clips.js";
import { CLEARANCE_SUBSTEPS, checkCombatClip, combatCheckEntry } from "../src/combat-clip-checks.js";
import { WEAPON_ROLES } from "../src/weapon-recipes.js";
import { FACE_MORPH_NODES, FACE_MORPH_TARGETS } from "../src/face-variants.js";
import { VARIETY_BEARDS, VARIETY_BODY_TARGETS, VARIETY_MORPH_TARGETS } from "../src/male-variety.js";
import { ARMOR_OUTFIT_KITS } from "../src/armor-recipes.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECKOUT = process.env.ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB;

async function skipReason(): Promise<string | false> {
  if (!CHECKOUT) return "set ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB to a clean 3d-lab checkout at the pinned three-d-animation-retarget commit";
  if (!process.env.ASSET_TOOLING_BLENDER) return "set ASSET_TOOLING_BLENDER to Blender 5.2.2 for the weapon entries (snap Blender: TMPDIR under $HOME)";
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8")).sources;
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  for (const member of Object.values(RANGER_MEMBERS)) {
    const id = sources.find((source: any) => source.archiveMember?.archive === member.archive && source.archiveMember?.path === member.path)?.id;
    const entry = storage.entries.find((candidate: any) => candidate.sourceId === id);
    const head = (await readFile(path.join(ROOT, entry.path))).subarray(0, 64).toString("utf8");
    if (head.startsWith("version https://git-lfs.github.com/spec/v1")) return `Git LFS payloads are not hydrated (${entry.path}); run 'git lfs pull'`;
  }
  return false;
}

test("#285: one grip pose per hand socket and held role, keying one hand's fingers", async () => {
  const sockets = JSON.parse(await readFile(path.join(ROOT, RANGER_SOCKETS_DESCRIPTOR), "utf8")).sockets;
  const names = RANGER_CLIPS.map((clip) => clip.name);
  assert.equal(new Set(RANGER_GRIPS.map((grip) => grip.clip)).size, RANGER_GRIPS.length);
  assert.equal(new Set(RANGER_GRIPS.map((grip) => `${grip.socket}/${grip.role}`)).size, RANGER_GRIPS.length);
  for (const grip of RANGER_GRIPS) {
    const socket = sockets.find((candidate: any) => candidate.id === grip.socket);
    assert.ok(socket?.accepts.includes(grip.role) && /^hand_[lr]$/.test(socket.joint), grip.clip);
    assert.ok(grip.clip.startsWith("Grip_") && grip.clip.endsWith(`_${socket.joint.slice(-1).toUpperCase()}`) && !names.includes(grip.clip), grip.clip);
  }
  assert.equal(rangerGripJoints("l").length, 15);
  assert.ok(rangerGripJoints("r").every((joint) => joint.endsWith("_r")));
});

test("the Ranger retargets the library clips in bundle order, then authors its own clips", () => {
  const names = RANGER_CLIPS.map((clip) => clip.name);
  assert.equal(new Set(names).size, names.length, "clip names are unique");
  assert.deepEqual(names.slice(0, 8), ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Sword_Idle", "Sword_Attack", "Death01", "Idle_Shield_Loop"]);
  assert.ok(RANGER_CLIPS.every((clip) => clip.rootMotion === "in-place"));
  assert.ok(RANGER_CLIPS.every((clip) => clip.library === "clips" || clip.library === "clips2"), "only CC0 library clips are retargeted (#399)");
  // #112, #399: the walk and jog directional family, start/stop and turns, all authored (no Mixamo input).
  assert.deepEqual([...RANGER_GAIT_CLIPS], [
    "Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop", "Walk_Bwd_Loop", "Walk_Strafe_Left_Loop", "Walk_Strafe_Right_Loop",
    "Walk_Start", "Walk_Stop", "Turn_Left", "Turn_Right", "Run_Fwd_Loop", "Run_Strafe_Left_Loop", "Run_Strafe_Right_Loop",
  ]);
  assert.ok(RANGER_GAIT_CLIPS.every((name) => !names.includes(name)));
  // #399: the upper-body hits and the shove, with their roles.
  assert.deepEqual([...RANGER_HIT_CLIPS], ["Hit_Upper_Front", "Hit_Upper_Back", "Hit_Upper_Left", "Hit_Upper_Right", "Hit_Shove_Spin"]);
  for (const side of ["Front", "Back", "Left", "Right"]) assert.equal(RANGER_CLIP_ROLES[`Hit_Upper_${side}`]!.role, `hit.upper.${side.toLowerCase()}`);
  // #277: original bow clips, each with a bow role; only the release has a contact.
  assert.deepEqual([...RANGER_BOW_CLIPS], ["Bow_Aim_Loop", "Bow_Draw", "Bow_Hold_Loop", "Bow_Release", "Bow_Recovery", "Bow_Cancel"]);
  assert.ok(RANGER_BOW_CLIPS.every((name) => RANGER_CLIP_ROLES[name]!.role.startsWith("bow.") && !names.includes(name)));
  assert.deepEqual(RANGER_BOW_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Bow_Release"]);
  // #393: the water clips mmorpg#499 plays by name.
  assert.deepEqual([...RANGER_SWIM_CLIPS], ["Wade_Fwd_Loop", "Swim_Idle_Loop", "Swim_Fwd_Loop", "Swim_Down_Loop", "Swim_Up_Loop", "Swim_Enter", "Swim_Exit"]);
  assert.ok(RANGER_SWIM_CLIPS.every((name) => !names.includes(name)));
  // #425: one Blender run per family, in bundle order after the library clips.
  assert.deepEqual(RANGER_CLIP_FAMILIES.map((family) => family.id), ["gait", "bow", "grips", "swim", "hit", "traversal", "sword", "dagger", "bow-upper", "crossbow", "cast", "social", "chores", "posts", "gather", "raid", "strike", "ready", "defend"]);
  // #416: the climb, mantle, ladder and rope clips mmorpg#490 and #500 play by name.
  assert.ok(RANGER_TRAVERSAL_CLIPS.every((name) => !names.includes(name)) && RANGER_TRAVERSAL_CLIPS.length === 16);
  // #417: nine directed slashes and eleven more Warden and Redbrand clips, each with a sword or shield role.
  assert.ok(RANGER_SWORD_CLIPS.every((name) => !names.includes(name) && RANGER_CLIP_ROLES[name]) && RANGER_SWORD_CLIPS.length === 20);
  assert.equal(RANGER_CLIP_ROLES.Sword_Slash_Low_R!.role, "sword.directed");
  assert.equal(RANGER_CLIP_ROLES.Charge_Impact!.contact, "hand_l");
  // #418: the Rogue's upper-body clips, each with a role (#738 moved the five dagger attacks to the strikes); the
  // off-hand slash strikes with the left hand.
  assert.ok(RANGER_DAGGER_CLIPS.every((name) => !names.includes(name) && RANGER_CLIP_ROLES[name]) && RANGER_DAGGER_CLIPS.length === 5);
  assert.equal(RANGER_CLIP_ROLES.Dagger_Slash_L!.contact, "hand_l");
  assert.equal(RANGER_CLIP_ROLES.Throw_Lob!.role, "throw.lob");
  // #419: the upper-body bow cycle mirrors the cycle's roles; the rapid release, the shot and the fire have contacts.
  assert.deepEqual(RANGER_BOW_UPPER_CLIPS.slice(0, 6).map((name) => RANGER_CLIP_ROLES[name]!.role), RANGER_BOW_CLIPS.map((name) => `${RANGER_CLIP_ROLES[name]!.role}.upper`));
  assert.deepEqual([...RANGER_BOW_UPPER_CLIPS, ...RANGER_CROSSBOW_CLIPS].filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Bow_Release_Upper", "Bow_Rapid_Release", "Crossbow_Fire"]);
  assert.ok(RANGER_CROSSBOW_CLIPS.every((name) => !names.includes(name) && RANGER_CLIP_ROLES[name]!.role.startsWith("crossbow.")));
  // #420: the casters' 17 clips (#738 moved the mace blows and the staff strikes to the strikes), each with a role; the releases
  // contact with the casting (left) hand. The roles the spell list keys on keep their names.
  assert.ok(RANGER_CAST_CLIPS.every((name) => !names.includes(name) && RANGER_CLIP_ROLES[name]) && RANGER_CAST_CLIPS.length === 17);
  assert.deepEqual(["Cast_Charge_Loop", "Cast_Channel_Beam_Loop", "Cast_Self_Ward", "Cast_Ally", "Cast_Summon_Raise"].map((name) => RANGER_CLIP_ROLES[name]!.role),
    ["cast.charge", "cast.channel.beam", "cast.self", "cast.ally", "cast.summon.raise"]);
  assert.equal(RANGER_CLIP_ROLES.Cast_Release_Push!.contact, "hand_l");
  // #421: the 23 social clips, each with an emote, interact, talk, sit or sleep role; the door clips and the handover
  // contact with the right hand.
  assert.ok(RANGER_SOCIAL_CLIPS.every((name) => !names.includes(name) && /^(emote|interact|talk|sit|sleep)\./.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_SOCIAL_CLIPS.length === 23);
  assert.deepEqual(RANGER_SOCIAL_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Door_Push", "Door_Pull", "Door_Knock", "Trade_Handover"]);
  // #693: the seven carry and chore clips mmorpg's residents play by name, each with a carry or chore role; the hoe
  // contacts at its strike.
  assert.ok(RANGER_CHORE_CLIPS.every((name) => !names.includes(name) && /^(carry|chore)\./.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_CHORE_CLIPS.length === 7);
  assert.deepEqual(RANGER_CHORE_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Farm_Hoe_Loop"]);
  // #697: the ten post idles, devotions and idle breaks Greyhaven's guards, marshal, priest and townsfolk play by name.
  assert.ok(RANGER_POST_CLIPS.every((name) => !names.includes(name) && /^(post|devotion|idle)\./.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_POST_CLIPS.length === 10);
  // #701: the gathering loops, the chest and the emotes; no name repeats an earlier clip (the #421 Emote_Wave/Emote_Cheer
  // stay), and the chop and mining strikes are hand_r contacts.
  assert.ok(RANGER_GATHER_CLIPS.every((name) => !names.includes(name) && /^(gather|interact|emote)\./.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_GATHER_CLIPS.length === 10);
  assert.equal(new Set(RANGER_CLIP_FAMILIES.flatMap((family) => family.clips)).size, RANGER_CLIP_FAMILIES.flatMap((family) => family.clips).length);
  assert.deepEqual(RANGER_GATHER_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Gather_Chop_Loop", "Gather_Mine_Loop"]);
  // #705: the raids, the load, the repair, pushing, the lever, the traps and the knockdown; the hack and the hammer are
  // hand_r contacts.
  assert.ok(RANGER_RAID_CLIPS.every((name) => !names.includes(name) && /^(raid|carry\.load|repair|push|interact|trap|knockdown)\./.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_RAID_CLIPS.length === 13);
  assert.deepEqual(RANGER_RAID_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Raid_Hack_Structure_Loop", "Repair_Hammer_Loop"]);
  // #709: a running and a jumping strike per weapon and the mace, staff and spear chain additions; every one is a hand_r
  // contact and no name repeats an earlier clip.
  // #711 adds the bare-fist, two-handed and bow sets, whose contact is the striking hand, shoulder or foot.
  // #737: the library light strike `Sword_Regular_A` is authored at the head of the family now, with its role kept.
  // #738: the sword counter and heavy chop `Sword_Regular_B` / `C` move here from the library combat family.
  // #738: so do the mace's overhand and backhand `Mace_Swing_A` / `B`, from the cast family.
  // #738: and the staff jab and sweep `Staff_Strike_A` / `B`; `Bow_Bash_B` is a bow strike now, not a kick. The Rogue's
  // dagger attacks come last, keeping their roles.
  assert.ok(RANGER_STRIKE_CLIPS.every((name) => !names.includes(name) && /^(sword|mace|dagger|staff|spear|unarmed|two-hand|bow)\.(strike|thrust|light-strike|heavy-strike|counter|stab|slash|sinister|poison|gouge)\b/.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_STRIKE_CLIPS.length === 40);
  assert.ok(RANGER_STRIKE_CLIPS.slice(0, 21).every((name) => RANGER_CLIP_ROLES[name]!.contact === "hand_r"));
  assert.deepEqual(RANGER_STRIKE_CLIPS.slice(21).map((name) => RANGER_CLIP_ROLES[name]!.contact),
    ["hand_l", "hand_r", "hand_l", "upperarm_r", "hand_r", "hand_r", "hand_r", "hand_r", "hand_r", "hand_r", "hand_l", "hand_l", "hand_l", "hand_l",
      "hand_r", "hand_l", "hand_r", "hand_r", "hand_r"]);
  const weapons = { sword: "Sword", mace: "Mace", dagger: "Dagger", staff: "Staff", spear: "Spear", unarmed: "Unarmed", "two-hand": "TwoHand", bow: "Bow" };
  assert.ok(Object.entries(weapons).every(([weapon, prefix]) => ["run", "jump"].every((state) => RANGER_CLIP_ROLES[`${prefix}_${state === "run" ? "Run" : "Jump"}_Strike`]?.role === `${weapon}.strike.${state}`)));
  // #711: the hit reactions and deaths have roles but no contact.
  assert.ok(RANGER_REACT_CLIPS.every((name) => !names.includes(name) && /^(hit|death)\./.test(RANGER_CLIP_ROLES[name]!.role) && !RANGER_CLIP_ROLES[name]!.contact));
  // #717: a draw and a sheathe per weapon family, the missing combat idles and the guards (#738 adds the bow's); no name
  // repeats an earlier clip.
  assert.ok(RANGER_READY_CLIPS.every((name) => !names.includes(name) && /^(sword|mace|dagger|staff|spear|two-hand|bow|unarmed)\.(draw|draw-weapon|sheathe|ready|guard)$/.test(RANGER_CLIP_ROLES[name]!.role) && !RANGER_CLIP_ROLES[name]!.contact) && RANGER_READY_CLIPS.length === 26);
  // #729: the defensive clips; the shield bash takes the `shield.bash` role from the library one-shot.
  assert.ok(RANGER_DEFEND_CLIPS.every((name) => !names.includes(name) && /^(dodge|kick|shield|(sword|mace|dagger|staff|spear|two-hand)\.(parry|riposte)|sword\.(sidestep|hop-back))/.test(RANGER_CLIP_ROLES[name]!.role)) && RANGER_DEFEND_CLIPS.length === 19);
  assert.deepEqual(RANGER_DEFEND_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Sword_Riposte", "Dagger_Riposte", "Shield_Bash", "Kick_Front"]);
  assert.equal(RANGER_CLIP_ROLES.Shield_Bash!.role, "shield.bash");
  assert.deepEqual(RANGER_GRIPS.find((grip) => grip.clip === "Grip_Crank_L"), { clip: "Grip_Crank_L", socket: "hand_l.weapon", role: "crank", surface: { kind: "cylinder", axis: [0, 1, 0], radius: .012 } });
  assert.deepEqual(RANGER_CLIP_FAMILIES.flatMap((family) => family.clips),
    [...RANGER_GAIT_CLIPS, ...RANGER_BOW_CLIPS, ...RANGER_GRIPS.map((grip) => grip.clip), ...RANGER_SWIM_CLIPS, ...RANGER_HIT_CLIPS, ...RANGER_TRAVERSAL_CLIPS, ...RANGER_SWORD_CLIPS, ...RANGER_DAGGER_CLIPS, ...RANGER_BOW_UPPER_CLIPS, ...RANGER_CROSSBOW_CLIPS, ...RANGER_CAST_CLIPS, ...RANGER_SOCIAL_CLIPS, ...RANGER_CHORE_CLIPS, ...RANGER_POST_CLIPS, ...RANGER_GATHER_CLIPS, ...RANGER_RAID_CLIPS, ...RANGER_STRIKE_CLIPS, ...RANGER_REACT_CLIPS, ...RANGER_READY_CLIPS, ...RANGER_DEFEND_CLIPS]);
  assert.deepEqual([...RANGER_GAITS], ["Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Crouch_Fwd_Loop", "Jog_Bwd_Loop", "Walk_Bwd_Loop", "Wade_Fwd_Loop"]);
  // Owner picks on #114: heavy = Sword_Regular_C, counter = Sword_Regular_B, light = Sword_Regular_A; Melee_Hook is not used.
  assert.equal(RANGER_CLIP_ROLES.Sword_Regular_C!.role, "sword.heavy-strike");
  assert.equal(RANGER_CLIP_ROLES.Sword_Regular_B!.role, "sword.counter");
  assert.equal(RANGER_CLIP_ROLES.Sword_Regular_A!.role, "sword.light-strike");
  assert.equal(RANGER_CLIP_ROLES.Hit_Shove_Spin!.role, "hit.shove");
  assert.ok(!names.some((name) => name.startsWith("Melee_Hook")));
});

test("#733: the clip downloads split every Ranger clip into one family each, in bundle order, with base first", () => {
  const bundleOrder = [...RANGER_CLIPS.map((clip) => clip.name), ...RANGER_CLIP_FAMILIES.flatMap((family) => family.clips)];
  assert.deepEqual(clipFamilyProblems(bundleOrder, RANGER_CLIP_DOWNLOADS), []);
  assert.deepEqual(RANGER_CLIP_DOWNLOADS.map((download) => download.family),
    ["base", "combat", "bow", "swim", "hit", "traversal", "sword", "dagger", "bow-upper", "crossbow", "cast", "social", "chores", "posts", "gather", "raid", "strike", "ready", "defend"]);
  const base = RANGER_CLIP_DOWNLOADS[0]!.clips;
  assert.ok(["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Jump_Loop", "Death01", "Walk_Bwd_Loop", "Grip_Crank_L"].every((clip) => base.includes(clip)));
});

test("#427: the build pool runs ASSET_TOOLING_JOBS steps at once, else one less than the available parallelism", () => {
  assert.equal(rangerJobs({ ASSET_TOOLING_JOBS: "3" }), 3);
  assert.ok(rangerJobs({}) >= 1);
  for (const bad of ["0", "-2", "1.5", "many"]) assert.throws(() => rangerJobs({ ASSET_TOOLING_JOBS: bad }), /positive integer/);
});

test("every spine joint is retargeted exactly once; UAL2 binds the same target joints", () => {
  const spine = Object.entries(RANGER_BONE_MAP).filter(([, { target }]) => target.startsWith("spine_")).map(([bone, { source, target }]) => [bone, source, target]);
  assert.deepEqual(spine, [["spine", "DEF-spine.001", "spine_01"], ["chest", "DEF-spine.002", "spine_02"], ["upper-chest", "DEF-spine.003", "spine_03"]]);
  for (const side of ["source", "target"] as const) {
    const joints = Object.values(RANGER_BONE_MAP).map((binding) => binding[side]);
    assert.equal(new Set(joints).size, joints.length, `${side} joints are mapped once`);
  }
  assert.deepEqual(Object.keys(RANGER_UBC_BONE_MAP), Object.keys(RANGER_BONE_MAP));
  for (const [bone, { source, target }] of Object.entries(RANGER_UBC_BONE_MAP)) {
    assert.equal(source, target, bone);
    assert.equal(target, RANGER_BONE_MAP[bone]!.target, bone);
  }
});

test("resident presets must name options the appearance descriptor offers", () => {
  const options = (...ids: string[]) => ids.map((id) => ({ id }));
  const descriptor: any = {
    skins: options("skin.dark", "skin.light"), hair: options("hair.buzzed", "hair.simple-parted", "hair.long"), tints: options("tint.black", "tint.brown", "tint.blond", "tint.grey"),
    headwear: options("equipment.hat.straw"), facialHair: { options: options("beard.full", "beard.short", "beard.moustache") },
    face: { features: ["face", "eyes", "nose", "mouth"].map((feature) => ({ id: feature, options: options(...["base", "broad", "narrow", "large", "long", "full", "thin"].map((o) => `${feature}.${o}`)) })) },
    outfits: [
      { id: "outfit.knight", skins: options("skin.dark", "skin.light"), armor: { pieces: [{ node: "knight.bascinet" }] }, faction: {} },
      { id: "outfit.soldier", skins: options("skin.dark", "skin.light"), armor: { pieces: [] }, faction: {} },
      ...["farmer", "innkeeper", "monk"].map((kit) => ({ id: `outfit.${kit}`, skins: options("skin.dark", "skin.light"), armor: { pieces: [] } })),
      // #379: the class outfits; the hooded ones name their hood, the Necromancer adds its grey skin.
      ...["warden", "ranger", "arcanist", "necromancer", "rogue", "cleric", "druid"].map((kit) => ({
        id: `outfit.class.${kit}`, skins: options("skin.dark", "skin.light", ...(kit === "necromancer" ? ["skin.grey"] : [])), armor: { pieces: [] },
        ...(["ranger", "rogue", "necromancer"].includes(kit) ? { hood: `class.${kit}.hood` } : {}),
      })),
    ],
  };
  validateAppearancePresets(descriptor, [...RANGER_RESIDENT_PRESETS, ...RANGER_CLASS_PRESETS]);
  assert.deepEqual(RANGER_CLASS_PRESETS.map((preset) => preset.id), ["warden", "ranger", "arcanist", "necromancer", "rogue", "cleric", "druid"].map((id) => `class.${id}`));
  const [marshal] = RANGER_RESIDENT_PRESETS;
  assert.throws(() => validateAppearancePresets(descriptor, [{ ...marshal!, facialHair: ["beard.braided"] }]), /facial hair/);
  assert.throws(() => validateAppearancePresets(descriptor, [{ ...marshal!, hiddenArmor: ["knight.visor"] }]), /plate/);
  assert.throws(() => validateAppearancePresets(descriptor, [{ ...marshal!, outfit: "outfit.farmer" }]), /plate|faction/);
  assert.throws(() => validateAppearancePresets(descriptor, [{ ...marshal!, hair: undefined }]), /hair, headwear or a hooded outfit/);
  assert.throws(() => validateAppearancePresets(descriptor, [{ ...marshal!, skin: "skin.grey" }]), /skin/);
  const necromancer = RANGER_CLASS_PRESETS.find((preset) => preset.id === "class.necromancer")!;
  assert.throws(() => validateAppearancePresets(descriptor, [{ ...necromancer, hair: "hair.buzzed" }]), /hood/);
  // #517: a figure that wears the hair kit takes its hair and beard options from the kit's ids.
  const { hair: _hair, facialHair: _facialHair, ...withoutHair } = descriptor;
  const kitDescriptor = { ...withoutHair, hairKit: { release: "hair-kit", provides: ["hair", "facialHair"] } };
  validateAppearancePresets(kitDescriptor, [...RANGER_RESIDENT_PRESETS, ...RANGER_CLASS_PRESETS]);
  assert.ok(RANGER_HAIR_KIT_OPTIONS.hair.includes("hair.tied") && RANGER_HAIR_KIT_OPTIONS.beards.includes("beard.walrus"));
  assert.throws(() => validateAppearancePresets(kitDescriptor, [{ ...marshal!, hair: "hair.mohawk" }]), /unknown hair/);
});

test("the female figure's tanner preset names options its descriptor offers (#378)", () => {
  const options = (...ids: string[]) => ids.map((id) => ({ id }));
  const descriptor: any = {
    skins: options("skin.dark", "skin.light"), hair: options("hair.long", "hair.buns"), tints: options("tint.black", "tint.brown", "tint.blond", "tint.grey"),
    face: { features: ["face", "eyes", "nose", "mouth"].map((feature) => ({ id: feature, options: options(...["base", "broad", "narrow", "large", "long", "full", "thin"].map((o) => `${feature}.${o}`)) })) },
    outfits: [{ id: "outfit.tanner", skins: options("skin.dark", "skin.light"), armor: { pieces: [{ node: "tanner.belt" }] } }],
  };
  assert.deepEqual(rangerPresets("female").map((preset) => preset.id), ["resident.tanner"]);
  validateAppearancePresets(descriptor, rangerPresets("female"));
  assert.throws(() => validateAppearancePresets({ ...descriptor, outfits: [] }, rangerPresets("female")), /unknown outfit/);
  assert.deepEqual([...RANGER_OUTFIT_KITS.female], ["tanner", "knight"]);
  assert.ok(!(RANGER_OUTFIT_KITS.male as readonly string[]).includes("tanner"));
  assert.match(RANGER_PEASANT_OUTFITS.female.path, /Female_Peasant\.gltf$/);
});

test("the Ranger declares its equipment, figures, appearance and texture limits", () => {
  assert.deepEqual(RANGER_WEAPONS.map((item) => item.key), ["equipment.sword.arming", "equipment.shield.heater", "equipment.dagger.blackened",
    "equipment.staff.bone", "equipment.staff.gilded", "equipment.staff.gnarled", "equipment.staff.crystal", "equipment.book.tome", "equipment.mace.flanged"]);
  assert.deepEqual(RANGER_ARCHERY.map((item) => item.key), ["equipment.bow.long", "equipment.arrow", "equipment.quiver.back", "equipment.crossbow"]);
  // #467: the throwables mmorpg draws in `hand_r.weapon` and on `belt.throwable`, with #457-format levels.
  assert.deepEqual(RANGER_THROWABLES.map((item) => [item.key, WEAPON_ROLES[item.piece]]),
    [["equipment.throwing-knife", "throwing-knife"], ["equipment.venom-flask", "flask"], ["equipment.blasting-bomb", "flask"]]);
  const lods = rangerItemLods({ min: [-.04, -.04, -.04], max: [.04, .06, .04] }, [{ variant: "default", triangles: 800 }, { variant: "lod1", triangles: 400 },
    { variant: "lod2", triangles: 200 }]);
  assert.deepEqual(lods.boundingSphere.center, [0, .01, 0]);
  assert.deepEqual(lods.levels.map((level) => [level.variant, level.minScreenSize]), [["default", .03], ["lod1", .012], ["lod2", 0]]);
  assert.equal(lods.levels[2]!.referenceMaxDistance, null);
  assert.ok(Math.abs(lods.levels[0]!.referenceMaxDistance! - lods.boundingSphere.radius / (.03 * Math.tan(Math.PI / 6))) < .01);
  const descriptor = rangerItemDescriptor("equipment.venom-flask", "flask", lods);
  assert.deepEqual(descriptor.lodSelection, RANGER_ITEM_LOD_SELECTION);
  assert.deepEqual(validateHumanoidItemDescriptor(JSON.parse(JSON.stringify(descriptor))), descriptor);
  assert.equal(RANGER_FIGURES.female.key, "humanoid.ranger.female");
  assert.match(RANGER_FIGURES.female.body.path, /Superhero_Female_FullBody\.gltf$/);
  assert.match(RANGER_FIGURES.female.outfit.path, /Female_Ranger\.gltf$/);
  assert.equal(RANGER_FIGURES.male.key, RANGER_BUNDLE_KEY);
  assert.deepEqual([...RANGER_APPEARANCE.male.hair], ["Hair_Buzzed", "Hair_SimpleParted", "Hair_Long"]);
  assert.deepEqual([...RANGER_APPEARANCE.female.hair], ["Hair_Long", "Hair_Buns"]);
  assert.equal(RANGER_APPEARANCE.male.hood, "Male_Ranger_Head_Hood");
  assert.equal(RANGER_APPEARANCE.female.hood, "Female_Ranger_Head_Hood");
  assert.deepEqual(Object.keys(RANGER_HAIR_TINTS), ["black", "brown", "blond", "grey"]);
  assert.deepEqual(RANGER_TEXTURE_POLICY, {
    maxEdgeBySlot: { baseColor: 1024, normal: 512, metallicRoughness: 512, occlusion: 512, emissive: 1024 }, default: 1024,
  });
});

test("the Ranger recipe builds a verified bundle: in-place clips, equipment entries, the sockets and clips attachments and game-resolution textures", { skip: await skipReason(), timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "humanoid-ranger-"));
  try {
    const built = await buildRangerCharacter({ processorCheckout: CHECKOUT!, outDir });
    const tar = await readFile(built.tar);
    await verifyAssetBundleTar(tar, { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = manifest.assets.map((entry) => `${entry.key}/${entry.variant}`);
    for (const expected of [`${RANGER_BUNDLE_KEY}/${RANGER_BUNDLE_VARIANT}`, `${RANGER_BUNDLE_KEY}/skin.light`, `${RANGER_BUNDLE_KEY}/outfit.soldier`,
      ...["knight", "farmer", "innkeeper", "monk"].map((kit) => `${RANGER_BUNDLE_KEY}/outfit.${kit}`), ...ARMOR_OUTFIT_KITS.map((kit) => `armor.${kit}/default`),
      ]) {
      assert.ok(entries.includes(expected), expected);
    }
    const entry = manifest.assets.find((candidate) => candidate.key === RANGER_BUNDLE_KEY)!;
    const clipNames = [...RANGER_CLIPS.map((clip) => clip.name), ...RANGER_GAIT_CLIPS, ...RANGER_BOW_CLIPS, ...RANGER_GRIPS.map((grip) => grip.clip), ...RANGER_SWIM_CLIPS, ...RANGER_HIT_CLIPS, ...RANGER_TRAVERSAL_CLIPS, ...RANGER_SWORD_CLIPS, ...RANGER_DAGGER_CLIPS, ...RANGER_BOW_UPPER_CLIPS, ...RANGER_CROSSBOW_CLIPS, ...RANGER_CAST_CLIPS, ...RANGER_SOCIAL_CLIPS, ...RANGER_CHORE_CLIPS, ...RANGER_POST_CLIPS, ...RANGER_GATHER_CLIPS, ...RANGER_RAID_CLIPS, ...RANGER_STRIKE_CLIPS, ...RANGER_REACT_CLIPS, ...RANGER_READY_CLIPS, ...RANGER_DEFEND_CLIPS];
    const libraryClips = new Set(RANGER_CLIPS.map((clip) => clip.name));
    assert.deepEqual(entry.observations.animations, clipNames);

    // The sockets descriptor ships with the character entry, byte-identical to the versioned file.
    assert.deepEqual(entry.attachments.map((attachment) => attachment.name).sort(), [RANGER_CLIPS_ATTACHMENT, "humanoid-appearance", RANGER_SOCKETS_ATTACHMENT].sort());
    const sockets = await readAssetBundleAttachment(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_SOCKETS_ATTACHMENT);
    assert.deepEqual(sockets, await readFile(path.join(ROOT, RANGER_SOCKETS_DESCRIPTOR)));

    // v6: one humanoid-clips entry per clip, in bundle order, with its source and motion metadata.
    const motion = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_CLIPS_ATTACHMENT)).toString("utf8"));
    assert.equal(motion.schema, "humanoid-clips-v1");
    assert.deepEqual([motion.units, motion.up, motion.facing], ["m", "+Y", "+Z"]);
    assert.deepEqual(motion.clips.map((clip: any) => clip.name), clipNames);
    for (const [index, clip] of motion.clips.entries()) {
      const lineage = built.lineage.clips[index]!;
      assert.equal(clip.source.animationSha256, lineage.source.sha256, clip.name);
      assert.equal(clip.source.clip, clip.name);
      assert.equal(clip.loop, clip.name.endsWith("_Loop") || clip.name.startsWith("Grip_"), clip.name);
      assert.equal(clip.rootMotion, "in-place", clip.name);
      assert.ok(clip.durationSeconds > 0, clip.name);
      assert.equal("groundSpeedMetersPerSecond" in clip, RANGER_GAITS.has(clip.name), clip.name);
    }
    const byName = Object.fromEntries(motion.clips.map((clip: any) => [clip.name, clip]));
    for (const grip of RANGER_GRIPS) assert.deepEqual([byName[grip.clip].role, byName[grip.clip].grip], ["grip", { socket: grip.socket, role: grip.role }], grip.clip);
    // #393: the crawl records its reference stroke speed; wading is slower than walking.
    assert.equal(byName.Swim_Fwd_Loop.strokeSpeedMetersPerSecond, 1.8);
    assert.ok(byName.Wade_Fwd_Loop.groundSpeedMetersPerSecond > 0.3 && byName.Wade_Fwd_Loop.groundSpeedMetersPerSecond < byName.Walk_Loop.groundSpeedMetersPerSecond);
    // #416: climb speeds, mantle ledge heights and travel, contacts and a chain pose sample per frame.
    assert.equal(byName.Climb_Up_Loop.climbSpeedMetersPerSecond, 0.9);
    assert.equal(byName.Ladder_Up_Loop.rungSpacingMeters, 0.3);
    for (const [name, height] of [["Mantle_Low", 0.7], ["Mantle_Mid", 1.3], ["Mantle_High", 1.9]] as const) {
      assert.equal(byName[name].ledgeHeightMeters, height, name);
      assert.equal(byName[name].sourceRootDisplacement.y, height, name);
    }
    for (const name of RANGER_TRAVERSAL_CLIPS) {
      const frames = Math.round(byName[name].durationSeconds * 30) + 1;
      assert.ok(byName[name].contacts.length > 0, name);
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, frames, name);
      // #443: past the knee the front and side panels hang plumb.
      for (const joint of ["skirt_f_03", "skirt_l_02", "skirt_r_02"]) assert.equal(byName[name].secondaryPose.joints[joint].length, frames, `${name} ${joint}`);
    }
    // #417: each slash names its aim cell; the strikes record their contact; the guard lanes loop.
    assert.deepEqual(byName.Sword_Slash_High_L.aim, { height: "high", side: "left" });
    assert.deepEqual(byName.Sword_Slash_Mid_C.aim, { height: "mid", side: "centre" });
    assert.equal(byName.Charge_Impact.contact.joint, "hand_l");
    assert.ok(byName.Shield_Guard_Low_Loop.loop && byName.Shield_Guard_Low_Loop.role === "shield.guard-low");
    assert.equal(byName.Sword_Slash_Low_R.source.basedOn.catalogId, "quaternius.universal-animation-library-2-standard.ual2-standard-glb");
    // #418: the throws reach the belt before they let go; the idle loops; the strikes record their contact hand.
    for (const name of ["Throw_Knife", "Throw_Lob"]) assert.ok(byName[name].drawSeconds > 0 && byName[name].releaseSeconds > byName[name].drawSeconds, name);
    assert.ok(byName.Dagger_Idle_Loop.loop && byName.Dagger_Idle_Loop.role === "dagger.idle");
    assert.equal(byName.Dagger_Slash_L.contact.joint, "hand_l");
    assert.ok(Math.abs(byName.Dagger_Slash_L.contact.seconds - .233) < .02 && Math.abs(byName.Throw_Knife.contact.seconds - byName.Throw_Knife.releaseSeconds) < .02);
    // #277: every bow clip records the string draw per frame; full draw is longer than the set string.
    for (const name of RANGER_BOW_CLIPS) {
      const bow = byName[name].bow;
      assert.equal(bow.sampleRate, 30, name);
      assert.equal(bow.drawMeters.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    assert.ok(byName.Bow_Hold_Loop.bow.drawMeters[0] > byName.Bow_Aim_Loop.bow.drawMeters[0] + 0.1);
    assert.equal(byName.Bow_Release.bow.drawMeters[1], 0);
    assert.ok(byName.Bow_Release.bow.releaseSeconds > 0 && byName.Bow_Recovery.bow.nockedSeconds > byName.Bow_Recovery.bow.arrowDrawnSeconds);
    // #419: the upper-body bow clips record the draw too; the rapid release is set again at its end; the power draw
    // goes past full draw; the contacts sit at the releases.
    for (const name of RANGER_BOW_UPPER_CLIPS) assert.equal(byName[name].bow.drawMeters.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    const rapid = byName.Bow_Rapid_Release.bow.drawMeters;
    assert.ok(Math.abs(rapid.at(-1) - rapid[0]) < .01 && byName.Bow_Rapid_Release.bow.releaseSeconds < byName.Bow_Rapid_Release.bow.nockedSeconds);
    assert.ok(byName.Bow_Power_Draw.bow.drawMeters.at(-1) > byName.Bow_Hold_Upper_Loop.bow.drawMeters[0] + .02);
    for (const name of ["Bow_Release_Upper", "Bow_Rapid_Release"]) assert.ok(Math.abs(byName[name].contact.seconds - byName[name].bow.releaseSeconds) < .02, name);
    // #419: the crossbow shot's release and contact, and the reload's marks in order.
    assert.ok(Math.abs(byName.Crossbow_Fire.contact.seconds - byName.Crossbow_Fire.crossbow.releaseSeconds) < .02);
    const reload = byName.Crossbow_Reload.crossbow;
    assert.ok(reload.spannedSeconds < reload.leftHandSeconds[0] && reload.leftHandSeconds[0] < reload.boltDrawnSeconds
      && reload.boltDrawnSeconds < reload.reloadedSeconds && reload.reloadedSeconds < reload.leftHandSeconds[1], JSON.stringify(reload));
    assert.ok(byName.Crossbow_Aim_Loop.loop && byName.Crossbow_Idle_Loop.loop);
    // #754: the marksman's footwork goes from the aim back to it, stands for its travel back and keeps the reload's marks.
    for (const name of ["Crossbow_Backpedal", "Crossbow_Reload_Back"]) {
      assert.deepEqual([byName[name].crossbow.from, byName[name].crossbow.to, byName[name].crossbow.direction], ["crossbow.aim", "crossbow.aim", "back"], name);
      assert.ok(byName[name].sourceRootDisplacement.z < -.5 && byName[name].secondaryPose.joints.skirt_f_01.length === Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    assert.deepEqual(byName.Crossbow_Reload_Back.crossbow.reloadedSeconds, reload.reloadedSeconds);
    // #420: every cast clip with a contact has it at its release; the beam starts at the staff's head, the releases at
    // the palm; the kneel records the skirt and cape pose.
    for (const name of RANGER_CAST_CLIPS.filter((clip) => RANGER_CLIP_ROLES[clip]!.contact)) {
      assert.ok(Math.abs(byName[name].contact.seconds - byName[name].cast.releaseSeconds) < .02, name);
    }
    assert.ok(byName.Cast_Channel_Beam_Loop.loop && byName.Cast_Channel_Beam_Loop.cast.channelJoint === "hand_r" && byName.Cast_Channel_Beam_Loop.cast.channelPoint.length === 3);
    assert.equal(byName.Cast_Release_Push.cast.startsFrom, "Cast_Charge_Loop");
    // #443: the respawn kneel records the chain pose too.
    for (const name of ["Cast_Summon_Raise", "Respawn_Rise"]) {
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    // #421: the door and handover contacts land on their authored moments, the knock on its first knock; the chains
    // name their loops; the full-body clips record the chain pose.
    for (const name of ["Door_Push", "Door_Pull", "Door_Knock", "Trade_Handover"]) {
      assert.ok(Math.abs(byName[name].contact.seconds - byName[name].social.contactSeconds) < .02, name);
    }
    assert.equal(byName.Door_Knock.social.knockSeconds.length, 3);
    assert.equal(byName.Door_Push.social.contactAt.length, 3);
    assert.equal(byName.Loot_Kneel_Enter.social.next, "Loot_Kneel_Loop");
    assert.equal(byName.Sleep_Bed_Wake.social.startsFrom, "Sleep_Bed_Loop");
    assert.ok(byName.Sit_Chair_Loop.loop && byName.Sleep_Bed_Loop.loop && !byName.Emote_Wave.secondaryPose);
    for (const name of ["Emote_Bow", "Loot_Kneel_Loop", "Sit_Chair_Enter", "Sit_Ground_Loop", "Sleep_Bed_Wake"]) {
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    // #693: the walk carry matches the walk; the hoe's contact is its strike; the carry clips name their socket; the
    // full-body chores record the chain pose and the upper-body ones none.
    assert.ok(Math.abs(byName.Carry_Hang_Walk_Loop.durationSeconds - byName.Walk_Loop.durationSeconds) < .02);
    assert.ok(Math.abs(byName.Farm_Hoe_Loop.contact.seconds - byName.Farm_Hoe_Loop.chore.strikeSeconds) < .02);
    assert.ok(RANGER_CHORE_CLIPS.every((name) => byName[name].loop === name.endsWith("_Loop")));
    for (const name of ["Carry_Hang_Idle_Loop", "Carry_Hang_Walk_Loop", "Pour", "Farm_Water_Loop"]) assert.equal(byName[name].chore.carrySocket, "hand_r.carry", name);
    for (const name of ["Sweep_Loop", "Farm_Hoe_Loop", "Farm_Water_Loop"]) {
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    assert.ok(!byName.Bar_Wipe_Loop.secondaryPose && !byName.Pour.secondaryPose);
    // #697: the guards ground the spear on hand_r.staff with its butt on the ground; the full-body clips record the
    // chain pose and the upper-body ones none.
    assert.ok(RANGER_POST_CLIPS.every((name) => byName[name].loop === name.endsWith("_Loop")));
    for (const name of ["Guard_Attention_Loop", "Guard_Salute", "Guard_LookAround"]) {
      assert.equal(byName[name].post.tool.socket, "hand_r.staff", name);
      assert.ok(Math.abs(byName[name].post.tool.buttAt[1]) < .01, name);
    }
    for (const name of ["Pray_Kneel_Loop", "Lean_Wall_Loop", "Idle_Variant_Shift", "Idle_Variant_Stretch", "Idle_Variant_Yawn"]) {
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    assert.ok(!byName.Bless.secondaryPose && !byName.Marshal_Inspect_Loop.secondaryPose);
    // #701: the tools ride hand_r.weapon at their own grips; the full-body clips record the chain pose, the emotes none.
    assert.ok(RANGER_GATHER_CLIPS.every((name) => byName[name].loop === name.endsWith("_Loop")));
    assert.equal(byName.Gather_Chop_Loop.gather.tool.item, "equipment.tool.wood-axe");
    assert.ok(["Gather_Chop_Loop", "Gather_Mine_Loop", "Gather_Skin_Loop"].every((name) => byName[name].gather.tool.socket === "hand_r.weapon" && !byName[name].gather.tool.itemOffset));
    for (const name of ["Gather_Chop_Loop", "Gather_Mine_Loop", "Gather_Herb_Loop", "Gather_Skin_Loop", "Chest_Open"]) {
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    assert.ok(["Emote_Yes", "Emote_No", "Emote_Shrug", "Emote_Clap", "Emote_Cheer_Both"].every((name) => !byName[name].secondaryPose));
    // #705: the tools ride hand_r.weapon at their own grips and the load chest.carry; the walking clips last a Walk_Loop.
    assert.ok(RANGER_RAID_CLIPS.every((name) => byName[name].loop === name.endsWith("_Loop")));
    assert.ok(["Raid_Torch_Carry_Loop", "Raid_Hack_Structure_Loop", "Repair_Hammer_Loop"].every((name) => byName[name].raid.tool.socket === "hand_r.weapon" && !byName[name].raid.tool.itemOffset));
    assert.ok(["Carry_Idle_Loop", "Carry_Walk_Loop"].every((name) => byName[name].raid.load.socket === "chest.carry" && !byName[name].secondaryPose));
    assert.ok(["Carry_Walk_Loop", "Push_Loop"].every((name) => byName[name].durationSeconds === byName.Walk_Loop.durationSeconds));
    for (const name of ["Repair_Hammer_Loop", "Push_Start", "Push_Loop", "Lever_Pull", "Trap_Place", "Trap_Disarm_Loop", "Knockdown_Fall", "Lie_Loop", "GetUp"]) {
      assert.equal(byName[name].secondaryPose.joints.skirt_f_01.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    // #709: every strike records its contact, strike point, band and reach; the running strikes last one Jog_Fwd_Loop
    // and the jumping strikes hand off to Jump_Land; the standing ones keep the upper body.
    for (const name of RANGER_STRIKE_CLIPS) {
      const { strike } = byName[name];
      assert.ok(["low", "mid", "high"].includes(strike.band) && strike.reachMeters > (strike.strikeJoint === "upperarm_r" ? 0 : .4) && strike.tipAt.length === 3, name);
      assert.ok(Math.abs(strike.contactSeconds - byName[name].contact.seconds) < .05 && byName[name].contact.joint === RANGER_CLIP_ROLES[name]!.contact, name);
      assert.ok(strike.contactSeconds > 0 && strike.contactSeconds < byName[name].durationSeconds, name);
      assert.equal(!byName[name].secondaryPose, !RANGER_COMBAT_STANDARD_CLIPS.includes(name) && /^(Mace_Swing|Staff_Strike|Spear_Thrust|TwoHand_Swing)_|^Unarmed_(Jab|Cross|Hook)$|^Bow_Bash_A$/.test(name), name);
    }
    // #737: the reference clips are full body and record their phases in order and their planted feet.
    for (const name of RANGER_COMBAT_STANDARD_CLIPS) {
      const { strike, durationSeconds } = byName[name];
      assert.ok(0 < strike.windupEnd && strike.windupEnd < strike.contactSeconds && strike.contactSeconds < strike.recoveryStart && strike.recoveryStart < durationSeconds, name);
      assert.ok(["l", "r"].every((foot) => strike.footPlants[foot].length > 0), name);
    }
    // #711: the reactions record their side and peak, the deaths when they land and how they lie; all are full body.
    for (const name of RANGER_REACT_CLIPS) {
      const { react } = byName[name];
      assert.ok(["left", "right", "front"].includes(react.hitSide) && react.peakSeconds > 0 && byName[name].secondaryPose && !byName[name].contact, name);
      assert.equal(name.startsWith("Death_"), ["back", "front", "side"].includes(react.lies) && react.landSeconds > react.peakSeconds, name);
    }
    assert.equal(byName.TwoHand_Jump_Strike.strike.band, "low");
    assert.equal(byName.Unarmed_Run_Strike.strike.strikeJoint, "upperarm_r");
    assert.ok(RANGER_STRIKE_CLIPS.filter((name) => name.includes("_Run_")).every((name) => byName[name].durationSeconds === byName.Jog_Fwd_Loop.durationSeconds));
    // #738: every jumping strike lands in its family's guard.
    assert.ok(RANGER_STRIKE_CLIPS.filter((name) => name.includes("_Jump_")).every((name) => byName[name].strike.to.clip === ({ Sword: "Sword_Idle", Spear: "Spear_Guard_Loop", Mace: "Mace_Guard_Loop", TwoHand: "TwoHand_Guard_Loop", Unarmed: "Unarmed_Guard_Loop", Dagger: "Dagger_Guard_Loop", Staff: "Staff_Guard_Loop", Bow: "Bow_Guard_Loop" }[name.split("_")[0]!])));
    assert.equal(byName.Spear_Thrust_B.strike.band, "high");
    assert.equal(byName.Spear_Jump_Strike.strike.band, "low");
    // #717: every draw and sheathe names its stow socket and swaps the item inside the clip with the hand on that socket;
    // the idles and guards loop.
    for (const name of RANGER_READY_CLIPS) {
      const { ready } = byName[name];
      assert.ok(ready && ["draw", "sheathe", "idle", "guard"].includes(ready.kind) && byName[name].loop === name.endsWith("_Loop"), name);
      if (ready.kind === "draw" || ready.kind === "sheathe") {
        assert.ok(["hip_l.stowed", "hip_r.stowed", "back.stowed", "back.bow.stowed"].includes(ready.stowSocket), name);
        assert.ok(ready.swapSeconds > 0 && ready.swapSeconds < byName[name].durationSeconds && ready.swapGapMeters < .06, name);
      }
    }
    assert.equal(byName.Sword_Draw.ready.stowSocket, "hip_l.stowed");
    assert.equal(byName.Bow_Draw_Weapon.ready.socket, "hand_l.bow");
    // #729: a parry deflects inside the clip, a riposte, the bash and the kick land inside it; the dodges stand for their
    // travel; the brace loops.
    for (const name of RANGER_DEFEND_CLIPS) {
      const { defend, durationSeconds } = byName[name];
      assert.ok(defend && byName[name].loop === name.endsWith("_Loop"), name);
      const mark = defend.parrySeconds ?? defend.contactSeconds ?? defend.impactSeconds;
      if (["parry", "riposte", "bash", "kick", "block-hit"].includes(defend.kind)) assert.ok(mark > 0 && mark < durationSeconds, name);
    }
    assert.equal(byName.Shield_Bash.contact.joint, "hand_l");
    assert.equal(byName.Kick_Front.contact.joint, "foot_r");
    assert.ok(byName.Roll_Bwd.sourceRootDisplacement.z < -1 && byName.Sidestep_L.sourceRootDisplacement.x > 0 && byName.Sidestep_R.sourceRootDisplacement.x < 0);
    // #754: the skirmisher's footwork goes from the sword guard back to it and stands for its travel.
    for (const name of ["Sword_Sidestep_L", "Sword_Sidestep_R", "Sword_Hop_Back"]) assert.deepEqual([byName[name].defend.from, byName[name].defend.to, byName[name].defend.family], ["sword.guard", "sword.guard", "sword"], name);
    assert.ok(byName.Sword_Sidestep_L.sourceRootDisplacement.x > 0 && byName.Sword_Sidestep_R.sourceRootDisplacement.x < 0 && byName.Sword_Hop_Back.sourceRootDisplacement.z < 0);
    // Gaits get faster from crouch to sprint; the root-motion variants record the travel in-place removed.
    const speeds = ["Crouch_Fwd_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop"].map((name) => byName[name].groundSpeedMetersPerSecond);
    assert.ok(speeds[0] > 0.3 && speeds.every((speed: number, index: number) => index === 0 || speed > speeds[index - 1]), `gait speeds ${speeds}`);
    assert.ok(byName.Roll_RM.sourceRootDisplacement.z > 4 && Math.abs(byName.Roll.sourceRootDisplacement.z) < 0.2);
    assert.ok(Math.abs(byName.ClimbUp_1m_RM.sourceRootDisplacement.y - 1) < 0.1);
    // v7: combat roles, and a contact time inside the clip for every strike.
    for (const [name, { role, contact }] of Object.entries(RANGER_CLIP_ROLES).filter(([clip]) => clip in byName)) {
      assert.equal(byName[name].role, role, name);
      if (contact) assert.ok(byName[name].contact.joint === contact && byName[name].contact.seconds >= 0 && byName[name].contact.seconds <= byName[name].durationSeconds, name);
      else assert.ok(!("contact" in byName[name]), name);
    }

    const { gltf, resources } = await readAssetBundleGltf(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT);
    const document = await new NodeIO().registerExtensions([KHRTextureBasisu]).readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
    // #737 (docs/combat-animation-standard.md): the reference clips keep the weapon out of the body, their planted feet
    // still and strike much faster than they wind up. Every other strike is checked and reported, to be held to the
    // standard as phase 2 (#738) redoes it.
    const socketList = JSON.parse(sockets.toString("utf8")).sockets;
    for (const name of RANGER_STRIKE_CLIPS) {
      // #738: the clips held to the standard also keep the weapon out of the body between their keys.
      const report = checkCombatClip(document, byName[name], socketList, RANGER_COMBAT_STANDARD_CLIPS.includes(name) ? { substeps: CLEARANCE_SUBSTEPS } : {});
      if (!RANGER_COMBAT_STANDARD_CLIPS.includes(name)) { console.log(`combat standard (not yet held): ${JSON.stringify(report)}`); continue; }
      // #738: a bare fist holds no item, so it has no clearance to check.
      assert.ok((report.clearance?.ok ?? !byName[name].strike.weapon.item) && report.feet?.ok && report.timing?.ok && !report.timing.inferredWindupEnd, JSON.stringify(report));
    }
    // mmorpg#804: the strikes whose weapon passed through the torso keep it out, between their keys too, and Sword_Cleave
    // its planted feet still; a clip may start touching the body (#804: the idle staff), but no frame may go deeper than
    // the first. #738 holds the running strikes, which have no planted feet, to this check.
    for (const [name, { footPlants }] of Object.entries(RANGER_CLEARANCE_CLIPS)) {
      const report = checkCombatClip(document, combatCheckEntry(byName[name], footPlants)!, socketList, { substeps: CLEARANCE_SUBSTEPS });
      assert.ok(report.clearance && (report.clearance.ok || report.clearance.worstMeters <= report.clearance.startMeters + .005) && (!footPlants || report.feet?.ok), JSON.stringify(report));
    }
    // #285: each grip pose keys only its hand's 15 finger and thumb rotations.
    for (const grip of RANGER_GRIPS) {
      const animation = document.getRoot().listAnimations().find((candidate) => candidate.getName() === grip.clip)!;
      const channels = animation.listChannels().map((channel) => `${channel.getTargetNode()!.getName()}.${channel.getTargetPath()}`).sort();
      assert.deepEqual(channels, rangerGripJoints(grip.socket.startsWith("hand_l") ? "l" : "r").map((joint) => `${joint}.rotation`).sort(), grip.clip);
    }
    // v3 and later: 13 textures, each resized within its slot's limit, the 4096 px sources reduced and none upscaled;
    // since #517 the bundle ships them as KTX2, at power-of-two sizes of at most 1024 px.
    const textures = built.lineage.textures![RANGER_BUNDLE_KEY]!;
    assert.equal(document.getRoot().listTextures().length, 13);
    for (const image of textures.images) {
      const limit = Math.max(...image.slots.map((slot: keyof typeof RANGER_TEXTURE_POLICY.maxEdgeBySlot) => RANGER_TEXTURE_POLICY.maxEdgeBySlot[slot]));
      assert.ok(Math.max(image.after.width, image.after.height) <= limit, `${image.names} fits ${limit}`);
      assert.ok(image.after.width <= image.before.width && image.after.height <= image.before.height, `${image.names} is never upscaled`);
      assert.equal(image.after.mimeType, "image/png");
    }
    assert.ok(textures.imageBytes.after * 4 < textures.imageBytes.before, "texture bytes shrink at least fourfold");
    for (const texture of document.getRoot().listTextures()) {
      assert.equal(texture.getMimeType(), "image/ktx2", texture.getName());
      const { width, height } = ktx2Size(texture.getImage()!);
      assert.ok(Math.max(width, height) <= 1024, texture.getName());
    }
    // #348: every full-detail variant the appearance lists carries the face morph targets; levels of detail do not.
    const appearance = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, "humanoid-appearance")).toString("utf8"));
    assert.deepEqual(appearance.face.nodes, FACE_MORPH_NODES.male);
    assert.deepEqual(appearance.face.features.map((feature: any) => feature.options.length), [3, 3, 3, 3]);
    // #380: after the face targets, the head and eyebrows carry the age targets and every mesh but the eyes the build
    // targets.
    const [head, eyes, eyebrows] = FACE_MORPH_NODES.male;
    const expectedTargets = (name: string) => name === head || name === eyebrows ? [...FACE_MORPH_TARGETS, ...VARIETY_MORPH_TARGETS]
      : name === eyes ? FACE_MORPH_TARGETS : VARIETY_BODY_TARGETS;
    const morphNodes = async (key: string, variant: string, expected: (name: string) => readonly string[]) => {
      const read = await readAssetBundleGltf(built.bundleDir, manifest, key, variant);
      const variantDocument = await new NodeIO().registerExtensions([KHRTextureBasisu]).readJSON({ json: JSON.parse(read.gltf.toString("utf8")), resources: Object.fromEntries(read.resources) });
      const meshNodes = variantDocument.getRoot().listNodes().filter((node) => node.getMesh());
      return meshNodes.filter((node) => node.getMesh()!.listPrimitives().some((primitive) => primitive.listTargets().length))
        .map((node) => { assert.deepEqual((node.getMesh()!.getExtras() as any).targetNames, expected(node.getName()), `${key}/${variant} ${node.getName()}`); return node.getName(); }).sort();
    };
    for (const variant of appearance.face.variants) {
      const keyed = await morphNodes(RANGER_BUNDLE_KEY, variant, expectedTargets);
      for (const name of FACE_MORPH_NODES.male) assert.ok(keyed.includes(name), `${variant} ${name}`);
    }
    // #516: the characters ship no levels of detail, so every character variant is a full-detail one.
    assert.equal(appearance.levelsOfDetail, undefined);
    assert.equal(appearance.face.unsupported, undefined);
    assert.deepEqual(entries.filter((entry: string) => entry.startsWith(`${RANGER_BUNDLE_KEY}/`) && /(^|\.|\/)lod[12]$/.test(entry)), []);
    assert.deepEqual(appearance.builds.variants, appearance.face.variants);
    for (const entry of appearance.builds.entries) {
      assert.ok((await morphNodes(entry, RANGER_BUNDLE_VARIANT, () => VARIETY_BODY_TARGETS)).length > 0, entry);
    }
    // #380: the painted head skins, one material per skin, age and stubble shade.
    const skins = await readAssetBundleGltf(built.bundleDir, manifest, "skin.head", RANGER_BUNDLE_VARIANT);
    const skinMaterials = (JSON.parse(skins.gltf.toString("utf8")).materials as any[]).map((material) => material.name).sort();
    assert.deepEqual(skinMaterials, appearance.headSkins.textures.map((texture: any) => texture.material).sort());
    // #376: the resident presets ship in the descriptor. #517: the male figure wears the hair kit's hair and beards,
    // so his bundle has no hair entries and the descriptor names the kit instead.
    assert.deepEqual(appearance.presets.map((preset: any) => preset.id), [...RANGER_RESIDENT_PRESETS, ...RANGER_CLASS_PRESETS].map((preset) => preset.id));
    assert.deepEqual(appearance.hairKit, { release: "hair-kit", provides: ["hair", "facialHair"] });
    assert.equal(appearance.hair, undefined);
    assert.equal(appearance.facialHair, undefined);
    assert.deepEqual(entries.filter((entry: string) => entry.startsWith("hair.") || entry.startsWith("facial-hair.")), []);
    validateAppearancePresets(appearance, [...RANGER_RESIDENT_PRESETS, ...RANGER_CLASS_PRESETS]);
    // #379: each class outfit has its plain and Light skins (the Necromancer also grey) and a class colour.
    for (const kit of ["warden", "ranger", "arcanist", "necromancer", "rogue", "cleric", "druid"]) {
      const outfit = appearance.outfits.find((candidate: any) => candidate.id === `outfit.class.${kit}`);
      assert.deepEqual(outfit.skins.map((skin: any) => skin.id), ["skin.dark", "skin.light", ...(kit === "necromancer" ? ["skin.grey"] : [])]);
      assert.deepEqual(outfit.classTrim.materials, ["class"]);
      for (const skin of outfit.skins) assert.ok(entries.includes(`${RANGER_BUNDLE_KEY}/${skin.variant}`), skin.variant);
    }


    const joints = document.getRoot().listSkins()[0]!.listJoints();
    assert.equal(joints.length, 65);
    validateHumanoidSocketDescriptor(JSON.parse(sockets.toString("utf8")), { joints: joints.map((joint) => joint.getName()) });
    const mappedTargets = new Set(Object.values(RANGER_BONE_MAP).map((binding) => binding.target));
    const root = joints.find((joint) => joint.getName() === "root")!;
    const pelvis = joints.find((joint) => joint.getName() === "pelvis")!;
    const rest = { root: [root.getTranslation(), root.getRotation()], pelvis: [pelvis.getTranslation(), pelvis.getRotation()] } as const;
    const spine = joints.find((joint) => joint.getName() === "spine_01")!;
    const upperBody = new Set<string>();
    for (const pending = [spine]; pending.length;) { const joint = pending.pop()!; upperBody.add(joint.getName()); pending.push(...joint.listChildren()); }
    assert.deepEqual(document.getRoot().listAnimations().map((animation) => animation.getName()), clipNames);
    for (const animation of document.getRoot().listAnimations()) {
      const name = animation.getName();
      for (const channel of animation.listChannels()) {
        // Retargeted library clips animate only mapped joints; authored clips key every joint, except the layered ones.
        if (libraryClips.has(name)) assert.ok(mappedTargets.has(channel.getTargetNode()!.getName()), `${name} animates only mapped joints`);
        // #399: an upper-body hit rotates only the spine_01 subtree, so pelvis and legs stay with the clip underneath.
        if (name.startsWith("Hit_Upper_")) assert.ok(channel.getTargetPath() === "rotation" && upperBody.has(channel.getTargetNode()!.getName()), `${name} keys ${channel.getTargetNode()!.getName()}`);
        assert.equal(channel.getSampler()!.getInterpolation(), "LINEAR");
      }
      // Layered clips (grips, upper-body hits) leave the pelvis to the clip underneath.
      if (name.startsWith("Grip_") || name.startsWith("Hit_Upper_")) continue;
      // #268: the middle spine joint carries the source bend instead of staying at rest.
      assert.ok(animation.listChannels().some((channel) => channel.getTargetNode()!.getName() === "spine_02" && channel.getTargetPath() === "rotation"), `${name} rotates spine_02`);
      const duration = Math.max(...animation.listSamplers().map((sampler) => sampler.getInput()!.getMax([])[0]!));
      assert.ok(duration > 0, `${name} has a positive duration`);
      // In place: the pelvis's horizontal model-space position (root and pelvis keys composed) drifts at most 1 cm.
      const keyed = (node: typeof root, targetPath: "translation" | "rotation") =>
        animation.listChannels().find((channel) => channel.getTargetNode() === node && channel.getTargetPath() === targetPath)?.getSampler()!.getOutput()!.getArray();
      const tracks = { rootT: keyed(root, "translation"), rootR: keyed(root, "rotation"), pelvisT: keyed(pelvis, "translation"), pelvisR: keyed(pelvis, "rotation") };
      const samples = tracks.pelvisT!.length / 3;
      const xs: number[] = [], zs: number[] = [];
      for (let index = 0; index < samples; index += 1) {
        const at = (array: ArrayLike<number> | undefined, size: number, fallback: number[]) => array ? Array.from({ length: size }, (_, k) => array[index * size + k]!) : fallback;
        root.setTranslation(at(tracks.rootT, 3, [...rest.root[0]]) as any).setRotation(at(tracks.rootR, 4, [...rest.root[1]]) as any);
        pelvis.setTranslation(at(tracks.pelvisT, 3, [...rest.pelvis[0]]) as any).setRotation(at(tracks.pelvisR, 4, [...rest.pelvis[1]]) as any);
        const [x, , z] = pelvis.getWorldTranslation();
        xs.push(x); zs.push(z);
      }
      root.setTranslation(rest.root[0]).setRotation(rest.root[1]);
      pelvis.setTranslation(rest.pelvis[0]).setRotation(rest.pelvis[1]);
      const drift = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      assert.ok(drift <= 0.01, `${name} pelvis horizontal drift ${drift.toFixed(4)} m must be at most 1 cm`);
    }
    for (const clip of built.lineage.clips.filter((candidate) => libraryClips.has(candidate.name))) {
      assert.equal(clip.observations.rootMotion, "in-place", clip.name);
      assert.equal(clip.observations.mappedBoneCount, Object.keys(RANGER_BONE_MAP).length, clip.name);
      assert.equal(clip.observations.startSeconds, 0, clip.name);
      assert.ok(clip.observations.endSeconds > 0 && clip.observations.sampleCount > 1, clip.name);
    }

    // #517: the items are the humanoid-equipment kit's (test/blender/kits/humanoid-equipment.test.ts), not the figure's.
    assert.deepEqual(entries.filter((entry: string) => entry.startsWith("equipment.")), []);
    assert.deepEqual(appearance.equipmentKit, { release: "humanoid-equipment" });
    const descriptor = JSON.parse(sockets.toString("utf8"));
    for (const id of ["hand_l.bow", "hand_r.arrow", "back.quiver", "back.bow.stowed"]) assert.ok(descriptor.sockets.some((socket: any) => socket.id === id), id);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
