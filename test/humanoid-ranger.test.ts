/// <reference path="../src/gltf-validator.d.ts" />
// End-to-end Ranger recipe (docs/humanoid-ranger.md): canonical body/outfit/UAL1/UAL2 members ->
// import, head subset, compose, extract, retarget the v2 clips (#110 Idle/Walk, #260 run/attack/death,
// #113 sword idle/attack and shield guard) through the pinned 3d-lab processor, embed, generate the
// sword and shield through the weapon recipe, attach the humanoid-sockets-v1 descriptor, then the
// gltf-resources-v1 bundle and release tar. v3 (#257) adds game-resolution PNG textures
// (scene.textures.resize.gltf@1) to that v2 content; the default v4 (#113) is v3 with the anatomically
// derived hand sockets. Structural checks only (owner answer 4 on #110: no
// byte-exact replay, no Blender oracle). The full build skips unless the Git LFS payloads are
// hydrated, ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB names a clean 3d-lab checkout at the pinned
// commit with its cargo dependencies fetched, and ASSET_TOOLING_BLENDER names Blender for the weapons.
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
  RANGER_BONE_MAP, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_CLIPS, RANGER_MEMBERS, RANGER_SOCKETS_ATTACHMENT,
  RANGER_DEFAULT_VERSION, RANGER_SOCKETS_DESCRIPTOR, RANGER_TEXTURE_POLICY, RANGER_V2_SOCKETS_DESCRIPTOR, rangerSocketsDescriptor, RANGER_UBC_BONE_MAP, RANGER_V2_CLIPS, RANGER_V2_EQUIPMENT,
  buildRangerCharacter,
} from "../scripts/build-ranger-character.ts";

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

test("the v2 recipe keeps the v1 clips, adds the #260/#113 clips by source name and binds UAL2 by same-name joints", () => {
  assert.deepEqual(RANGER_CLIPS.map((clip) => clip.name), ["Idle_Loop", "Walk_Loop"]);
  assert.deepEqual(RANGER_V2_CLIPS.map((clip) => [clip.name, clip.library]), [
    ["Idle_Loop", "clips"], ["Walk_Loop", "clips"], ["Jog_Fwd_Loop", "clips"], ["Sprint_Loop", "clips"],
    ["Sword_Idle", "clips"], ["Sword_Attack", "clips"], ["Death01", "clips"], ["Idle_Shield_Loop", "clips2"],
  ]);
  assert.ok(RANGER_V2_CLIPS.every((clip) => clip.rootMotion === "in-place"));
  assert.deepEqual(Object.keys(RANGER_UBC_BONE_MAP), Object.keys(RANGER_BONE_MAP));
  for (const [bone, { source, target }] of Object.entries(RANGER_UBC_BONE_MAP)) {
    assert.equal(source, target, bone);
    assert.equal(target, RANGER_BONE_MAP[bone]!.target, bone);
  }
  assert.deepEqual(RANGER_V2_EQUIPMENT.map((item) => item.key), ["equipment.sword.arming", "equipment.shield.heater"]);
});

test("v4 (#113) is the default; v2 and v3 keep the bundle-v2 sockets, and the texture limits are per slot", () => {
  assert.equal(RANGER_DEFAULT_VERSION, 4);
  assert.deepEqual(([1, 2, 3, 4] as const).map(rangerSocketsDescriptor), [undefined, RANGER_V2_SOCKETS_DESCRIPTOR, RANGER_V2_SOCKETS_DESCRIPTOR, RANGER_SOCKETS_DESCRIPTOR]);
  assert.notEqual(RANGER_SOCKETS_DESCRIPTOR, RANGER_V2_SOCKETS_DESCRIPTOR);
  assert.deepEqual(RANGER_TEXTURE_POLICY, {
    maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 }, default: 1024,
  });
});

test("the Ranger v4 recipe builds a verified bundle: in-place clips, equipment entries, the sockets attachment and game-resolution textures", { skip: await skipReason(), timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "humanoid-ranger-"));
  try {
    const built = await buildRangerCharacter({ processorCheckout: CHECKOUT!, outDir });
    const tar = await readFile(built.tar);
    await verifyAssetBundleTar(tar, { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(),
      [`${RANGER_BUNDLE_KEY}/${RANGER_BUNDLE_VARIANT}`, ...RANGER_V2_EQUIPMENT.map((item) => `${item.key}/default`)].sort());
    const entry = manifest.assets.find((candidate) => candidate.key === RANGER_BUNDLE_KEY)!;
    const clipNames = RANGER_V2_CLIPS.map((clip) => clip.name);
    assert.deepEqual(entry.observations.animations, clipNames);

    // The sockets descriptor ships with the character entry, byte-identical to the versioned file.
    assert.deepEqual(entry.attachments.map((attachment) => [attachment.name, attachment.mediaType]), [[RANGER_SOCKETS_ATTACHMENT, "application/json"]]);
    const sockets = await readAssetBundleAttachment(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_SOCKETS_ATTACHMENT);
    assert.deepEqual(sockets, await readFile(path.join(ROOT, RANGER_SOCKETS_DESCRIPTOR)));

    const { gltf, resources } = await readAssetBundleGltf(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT);
    const document = await new NodeIO().readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
    // v3 and v4: 13 PNG textures, each within its slot's limit, the 4096 px sources reduced and none upscaled.
    assert.equal(built.lineage.version, 4);
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
    for (const { key } of RANGER_V2_EQUIPMENT) assert.deepEqual(built.lineage.textures![key], { images: 0 }, key);

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
        assert.ok(mappedTargets.has(channel.getTargetNode()!.getName()), `${name} animates only mapped joints`);
        assert.equal(channel.getSampler()!.getInterpolation(), "LINEAR");
      }
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
    for (const clip of built.lineage.clips) {
      assert.equal(clip.observations.rootMotion, "in-place", clip.name);
      assert.equal(clip.observations.mappedBoneCount, Object.keys(RANGER_BONE_MAP).length, clip.name);
      assert.equal(clip.observations.startSeconds, 0, clip.name);
      assert.ok(clip.observations.endSeconds > 0 && clip.observations.sampleCount > 1, clip.name);
    }

    // Weapons are separate, unskinned, unanimated entries; the consumer parents them via the sockets.
    for (const { key, piece } of RANGER_V2_EQUIPMENT) {
      const weapon = manifest.assets.find((candidate) => candidate.key === key)!;
      assert.equal(weapon.observations.skins, 0, key);
      assert.deepEqual(weapon.observations.animations, [], key);
      assert.ok(weapon.observations.triangles > 0, key);
      assert.deepEqual(weapon.attachments, [], key);
      const scene = await readAssetBundleGltf(built.bundleDir, manifest, key, "default");
      const json = JSON.parse(scene.gltf.toString("utf8"));
      assert.deepEqual(json.nodes.map((node: any) => node.name).sort(), ["grip", piece].sort(), key);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
