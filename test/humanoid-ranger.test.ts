/// <reference path="../src/gltf-validator.d.ts" />
// End-to-end Ranger recipe (docs/humanoid-ranger.md): canonical body/outfit/UAL1/UAL2 members -> import, head
// subset, compose, extract, retarget the library clips through the pinned 3d-lab processor, retarget the Mixamo
// clips in Blender, author the jog clips, embed, generate the equipment, attach the descriptors, then the
// gltf-resources-v1 bundle and release tar. Structural checks only (owner answer 4 on #110: no byte-exact replay,
// no Blender oracle). The full build skips unless the Git LFS payloads are hydrated,
// ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB names a clean 3d-lab checkout at the pinned commit with its cargo
// dependencies fetched, ASSET_TOOLING_BLENDER names Blender and ASSET_TOOLING_MIXAMO_DIR names the local Mixamo FBX files.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImageUtils, NodeIO } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle } from "../src/asset-bundle.js";
import { validateHumanoidSocketDescriptor } from "../src/humanoid-sockets.js";
import {
  RANGER_APPEARANCE, RANGER_ARCHERY, RANGER_AUTHORED_CLIPS, RANGER_BOW_CLIPS, RANGER_BONE_MAP, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_CLIPS,
  RANGER_CLIPS_ATTACHMENT, RANGER_CLIP_ROLES, RANGER_FIGURES, RANGER_GAITS, RANGER_HAIR_TINTS, RANGER_MEMBERS, RANGER_MIXAMO_BONE_MAP,
  RANGER_CLASS_PRESETS, RANGER_FACIAL_HAIR_ENTRY, RANGER_ITEM_ATTACHMENT, RANGER_RESIDENT_PRESETS, RANGER_SOCKETS_ATTACHMENT, RANGER_SOCKETS_DESCRIPTOR, RANGER_TEXTURE_POLICY,
  RANGER_UBC_BONE_MAP, RANGER_WEAPONS, RANGER_OUTFIT_KITS, RANGER_PEASANT_OUTFITS, RANGER_GRIPS, validateAppearancePresets,
  buildRangerCharacter, rangerGripJoints, rangerItemDescriptor, rangerPresets,
} from "../scripts/build-ranger-character.ts";
import { WEAPON_ROLES } from "../src/weapon-recipes.js";
import { FACE_MORPH_NODES, FACE_MORPH_TARGETS } from "../src/face-variants.js";
import { VARIETY_BEARDS, VARIETY_BUILD_TARGETS, VARIETY_MORPH_TARGETS } from "../src/male-variety.js";
import { ARMOR_OUTFIT_KITS } from "../src/armor-recipes.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECKOUT = process.env.ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB;

async function skipReason(): Promise<string | false> {
  if (!CHECKOUT) return "set ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB to a clean 3d-lab checkout at the pinned three-d-animation-retarget commit";
  if (!process.env.ASSET_TOOLING_BLENDER) return "set ASSET_TOOLING_BLENDER to Blender 5.2.2 for the weapon entries (snap Blender: TMPDIR under $HOME)";
  if (!process.env.ASSET_TOOLING_MIXAMO_DIR) return "set ASSET_TOOLING_MIXAMO_DIR to the local Mixamo FBX files (Atlas 6.1.6)";
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

test("the Ranger retargets the library clips in bundle order, then authors the jog clips", () => {
  const names = RANGER_CLIPS.map((clip) => clip.name);
  assert.equal(new Set(names).size, names.length, "clip names are unique");
  assert.deepEqual(names.slice(0, 8), ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Sword_Idle", "Sword_Attack", "Death01", "Idle_Shield_Loop"]);
  assert.ok(RANGER_CLIPS.every((clip) => clip.rootMotion === "in-place"));
  assert.deepEqual(RANGER_CLIPS.filter((clip) => clip.library === "mixamo").map((clip) => [clip.name, clip.mixamo]), [
    ["Walk_Bwd_Loop", "Walking Backwards"], ["Walk_Strafe_Left_Loop", "Left Strafe Walking"], ["Walk_Strafe_Right_Loop", "Right Strafe Walking"],
    ["Walk_Start", "Start Walking"], ["Walk_Stop", "Walk To Stop"], ["Turn_Left", "Left Turn"], ["Turn_Right", "Right Turn"], ["Hit_Shove_Spin", "Shoved Reaction With Spin"],
  ]);
  assert.deepEqual([...RANGER_AUTHORED_CLIPS], ["Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop"]);
  assert.ok(RANGER_AUTHORED_CLIPS.every((name) => !names.includes(name)));
  // #277: original bow clips, each with a bow role; only the release has a contact.
  assert.deepEqual([...RANGER_BOW_CLIPS], ["Bow_Aim_Loop", "Bow_Draw", "Bow_Hold_Loop", "Bow_Release", "Bow_Recovery", "Bow_Cancel"]);
  assert.ok(RANGER_BOW_CLIPS.every((name) => RANGER_CLIP_ROLES[name]!.role.startsWith("bow.") && !names.includes(name)));
  assert.deepEqual(RANGER_BOW_CLIPS.filter((name) => RANGER_CLIP_ROLES[name]!.contact), ["Bow_Release"]);
  assert.deepEqual([...RANGER_GAITS], ["Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Crouch_Fwd_Loop", "Jog_Bwd_Loop"]);
  // Owner picks on #114: heavy = Sword_Regular_C, counter = Sword_Regular_B, light = Sword_Regular_A; Melee_Hook is not used.
  assert.equal(RANGER_CLIP_ROLES.Sword_Regular_C!.role, "sword.heavy-strike");
  assert.equal(RANGER_CLIP_ROLES.Sword_Regular_B!.role, "sword.counter");
  assert.equal(RANGER_CLIP_ROLES.Sword_Regular_A!.role, "sword.light-strike");
  assert.equal(RANGER_CLIP_ROLES.Hit_Shove_Spin!.role, "hit.shove");
  assert.ok(!names.some((name) => name.startsWith("Melee_Hook")));
});

test("every spine joint is retargeted exactly once; UAL2 and Mixamo bind the same target joints", () => {
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
  assert.deepEqual(Object.keys(RANGER_MIXAMO_BONE_MAP).sort(), Object.keys(RANGER_BONE_MAP).filter((bone) => bone !== "root").sort());
  assert.ok(Object.values(RANGER_MIXAMO_BONE_MAP).every(({ source }) => source.startsWith("mixamorig:")));
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
  assert.deepEqual([...RANGER_OUTFIT_KITS.female], ["tanner"]);
  assert.ok(!(RANGER_OUTFIT_KITS.male as readonly string[]).includes("tanner"));
  assert.match(RANGER_PEASANT_OUTFITS.female.path, /Female_Peasant\.gltf$/);
});

test("the Ranger declares its equipment, figures, appearance and texture limits", () => {
  assert.deepEqual(RANGER_WEAPONS.map((item) => item.key), ["equipment.sword.arming", "equipment.shield.heater", "equipment.dagger.blackened",
    "equipment.staff.bone", "equipment.staff.gilded", "equipment.staff.gnarled", "equipment.staff.crystal", "equipment.book.tome", "equipment.mace.flanged"]);
  assert.deepEqual(RANGER_ARCHERY.map((item) => item.key), ["equipment.bow.long", "equipment.arrow", "equipment.quiver.back", "equipment.crossbow"]);
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
    maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 }, default: 1024,
  });
});

test("the Ranger recipe builds a verified bundle: in-place clips, equipment entries, the sockets and clips attachments and game-resolution textures", { skip: await skipReason(), timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "humanoid-ranger-"));
  try {
    const built = await buildRangerCharacter({ processorCheckout: CHECKOUT!, outDir, mixamoDir: process.env.ASSET_TOOLING_MIXAMO_DIR });
    const tar = await readFile(built.tar);
    await verifyAssetBundleTar(tar, { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = manifest.assets.map((entry) => `${entry.key}/${entry.variant}`);
    for (const expected of [`${RANGER_BUNDLE_KEY}/${RANGER_BUNDLE_VARIANT}`, `${RANGER_BUNDLE_KEY}/skin.light`, `${RANGER_BUNDLE_KEY}/outfit.soldier`,
      ...["knight", "farmer", "innkeeper", "monk"].map((kit) => `${RANGER_BUNDLE_KEY}/outfit.${kit}`), ...ARMOR_OUTFIT_KITS.map((kit) => `armor.${kit}/default`),
      `${RANGER_FACIAL_HAIR_ENTRY}/default`, ...[...RANGER_WEAPONS, ...RANGER_ARCHERY].map((item) => `${item.key}/default`)]) {
      assert.ok(entries.includes(expected), expected);
    }
    const entry = manifest.assets.find((candidate) => candidate.key === RANGER_BUNDLE_KEY)!;
    const clipNames = [...RANGER_CLIPS.map((clip) => clip.name), ...RANGER_AUTHORED_CLIPS, ...RANGER_BOW_CLIPS, ...RANGER_GRIPS.map((grip) => grip.clip)];
    const libraryClips = new Set(RANGER_CLIPS.filter((clip) => clip.library !== "mixamo").map((clip) => clip.name));
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
    // #277: every bow clip records the string draw per frame; full draw is longer than the set string.
    for (const name of RANGER_BOW_CLIPS) {
      const bow = byName[name].bow;
      assert.equal(bow.sampleRate, 30, name);
      assert.equal(bow.drawMeters.length, Math.round(byName[name].durationSeconds * 30) + 1, name);
    }
    assert.ok(byName.Bow_Hold_Loop.bow.drawMeters[0] > byName.Bow_Aim_Loop.bow.drawMeters[0] + 0.1);
    assert.equal(byName.Bow_Release.bow.drawMeters[1], 0);
    assert.ok(byName.Bow_Release.bow.releaseSeconds > 0 && byName.Bow_Recovery.bow.nockedSeconds > byName.Bow_Recovery.bow.arrowDrawnSeconds);
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
    const document = await new NodeIO().readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
    // #285: each grip pose keys only its hand's 15 finger and thumb rotations.
    for (const grip of RANGER_GRIPS) {
      const animation = document.getRoot().listAnimations().find((candidate) => candidate.getName() === grip.clip)!;
      const channels = animation.listChannels().map((channel) => `${channel.getTargetNode()!.getName()}.${channel.getTargetPath()}`).sort();
      assert.deepEqual(channels, rangerGripJoints(grip.socket.startsWith("hand_l") ? "l" : "r").map((joint) => `${joint}.rotation`).sort(), grip.clip);
    }
    // v3 and later: 13 PNG textures, each within its slot's limit, the 4096 px sources reduced and none upscaled.
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
      const [width, height] = ImageUtils.getSize(texture.getImage()!, "image/png")!;
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
      : name === eyes ? FACE_MORPH_TARGETS : VARIETY_BUILD_TARGETS;
    const morphNodes = async (key: string, variant: string, expected: (name: string) => readonly string[]) => {
      const read = await readAssetBundleGltf(built.bundleDir, manifest, key, variant);
      const variantDocument = await new NodeIO().readJSON({ json: JSON.parse(read.gltf.toString("utf8")), resources: Object.fromEntries(read.resources) });
      const meshNodes = variantDocument.getRoot().listNodes().filter((node) => node.getMesh());
      return meshNodes.filter((node) => node.getMesh()!.listPrimitives().some((primitive) => primitive.listTargets().length))
        .map((node) => { assert.deepEqual((node.getMesh()!.getExtras() as any).targetNames, expected(node.getName()), `${key}/${variant} ${node.getName()}`); return node.getName(); }).sort();
    };
    for (const variant of appearance.face.variants) {
      const keyed = await morphNodes(RANGER_BUNDLE_KEY, variant, expectedTargets);
      for (const name of FACE_MORPH_NODES.male) assert.ok(keyed.includes(name), `${variant} ${name}`);
    }
    for (const variant of appearance.face.unsupported.variants) assert.deepEqual(await morphNodes(RANGER_BUNDLE_KEY, variant, () => []), [], variant);
    assert.deepEqual(appearance.builds.variants, appearance.face.variants);
    for (const entry of appearance.builds.entries) {
      const variant = entry.startsWith("hair.") ? "hair-1" : RANGER_BUNDLE_VARIANT;
      const facial = entry === "facial-hair.beards";
      assert.ok((await morphNodes(entry, variant, () => facial ? VARIETY_MORPH_TARGETS : VARIETY_BUILD_TARGETS)).length > 0, entry);
    }
    // #380: the painted head skins, one material per skin, age and stubble shade.
    const skins = await readAssetBundleGltf(built.bundleDir, manifest, "skin.head", RANGER_BUNDLE_VARIANT);
    const skinMaterials = (JSON.parse(skins.gltf.toString("utf8")).materials as any[]).map((material) => material.name).sort();
    assert.deepEqual(skinMaterials, appearance.headSkins.textures.map((texture: any) => texture.material).sort());
    // #376: the resident presets and the facial hair they name ship in the descriptor (#380: hand-modelled, six).
    assert.deepEqual(appearance.presets.map((preset: any) => preset.id), [...RANGER_RESIDENT_PRESETS, ...RANGER_CLASS_PRESETS].map((preset) => preset.id));
    assert.deepEqual(appearance.facialHair.options.map((option: any) => option.id).sort(), Object.keys(VARIETY_BEARDS).sort());
    validateAppearancePresets(appearance, [...RANGER_RESIDENT_PRESETS, ...RANGER_CLASS_PRESETS]);
    // #379: each class outfit has its plain and Light skins (the Necromancer also grey), levels of detail and a class colour.
    for (const kit of ["warden", "ranger", "arcanist", "necromancer", "rogue", "cleric", "druid"]) {
      const outfit = appearance.outfits.find((candidate: any) => candidate.id === `outfit.class.${kit}`);
      assert.deepEqual(outfit.skins.map((skin: any) => skin.id), ["skin.dark", "skin.light", ...(kit === "necromancer" ? ["skin.grey"] : [])]);
      assert.deepEqual(outfit.classTrim.materials, ["class"]);
      for (const skin of outfit.skins) for (const level of ["lod1", "lod2"]) assert.ok(entries.includes(`${RANGER_BUNDLE_KEY}/${skin.variant}.${level}`), `${skin.variant}.${level}`);
    }
    for (const { key } of [...RANGER_WEAPONS, ...RANGER_ARCHERY]) assert.deepEqual(built.lineage.textures![key], { images: 0 }, key);

    const joints = document.getRoot().listSkins()[0]!.listJoints();
    assert.equal(joints.length, 65);
    validateHumanoidSocketDescriptor(JSON.parse(sockets.toString("utf8")), { joints: joints.map((joint) => joint.getName()) });
    const mappedTargets = new Set(Object.values(RANGER_BONE_MAP).map((binding) => binding.target));
    const root = joints.find((joint) => joint.getName() === "root")!;
    const pelvis = joints.find((joint) => joint.getName() === "pelvis")!;
    const rest = { root: [root.getTranslation(), root.getRotation()], pelvis: [pelvis.getTranslation(), pelvis.getRotation()] } as const;
    assert.deepEqual(document.getRoot().listAnimations().map((animation) => animation.getName()), clipNames);
    for (const animation of document.getRoot().listAnimations()) {
      const name = animation.getName();
      for (const channel of animation.listChannels()) {
        // Retargeted library clips animate only mapped joints; Blender-made clips (Mixamo, authored) key every joint.
        if (libraryClips.has(name)) assert.ok(mappedTargets.has(channel.getTargetNode()!.getName()), `${name} animates only mapped joints`);
        assert.equal(channel.getSampler()!.getInterpolation(), "LINEAR");
      }
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

    // Weapons are separate, unskinned, unanimated entries; the consumer parents them via the sockets.
    for (const { key, piece } of RANGER_WEAPONS) {
      const weapon = manifest.assets.find((candidate) => candidate.key === key)!;
      assert.equal(weapon.observations.skins, 0, key);
      assert.deepEqual(weapon.observations.animations, [], key);
      assert.ok(weapon.observations.triangles > 0, key);
      // Each item ships its humanoid-item-v1 descriptor (#264): its role and its identity `grip` frame.
      assert.deepEqual(weapon.attachments.map((attachment: any) => attachment.name), [RANGER_ITEM_ATTACHMENT], key);
      const item = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, key, "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
      assert.deepEqual(item, rangerItemDescriptor(key, WEAPON_ROLES[piece]), key);
      const scene = await readAssetBundleGltf(built.bundleDir, manifest, key, "default");
      const json = JSON.parse(scene.gltf.toString("utf8"));
      assert.deepEqual(json.nodes.map((node: any) => node.name).sort(), ["grip", piece].sort(), key);
    }
    // v7 archery: the arrow and quiver are static like the weapons; the bow is skinned to grip and nock.
    for (const { key, piece } of RANGER_ARCHERY) {
      const item = manifest.assets.find((candidate) => candidate.key === key)!;
      assert.deepEqual(item.observations.animations, [], key);
      const json = JSON.parse((await readAssetBundleGltf(built.bundleDir, manifest, key, "default")).gltf.toString("utf8"));
      const names = json.nodes.map((node: any) => node.name);
      if (piece === "bow.long") {
        assert.equal(item.observations.skins, 1, key);
        assert.deepEqual(json.skins[0].joints.map((index: number) => json.nodes[index].name), ["grip", "nock"]);
        assert.ok(names.includes(piece), key);
      } else {
        assert.equal(item.observations.skins, 0, key);
        assert.deepEqual(names.sort(), ["grip", piece].sort(), key);
      }
    }
    const descriptor = JSON.parse(sockets.toString("utf8"));
    for (const id of ["hand_l.bow", "hand_r.arrow", "back.quiver", "back.bow.stowed"]) assert.ok(descriptor.sockets.some((socket: any) => socket.id === id), id);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
