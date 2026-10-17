/// <reference path="../src/gltf-validator.d.ts" />
// End-to-end #110 Ranger recipe (docs/humanoid-ranger.md): canonical body/outfit/UAL1 members ->
// import, head subset, compose, extract, retarget Idle_Loop/Walk_Loop through the pinned 3d-lab
// processor, embed, gltf-resources-v1 bundle and release tar. Structural checks only (owner answer 4:
// no byte-exact replay, no Blender oracle). Skips unless the Git LFS payloads are hydrated and
// ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB names a clean 3d-lab checkout at the pinned commit with its
// cargo dependencies fetched.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleGltf, verifyAssetBundle } from "../src/asset-bundle.js";
import { RANGER_BONE_MAP, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT, RANGER_MEMBERS, buildRangerCharacter } from "../scripts/build-ranger-character.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECKOUT = process.env.ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB;

async function skipReason(): Promise<string | false> {
  if (!CHECKOUT) return "set ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB to a clean 3d-lab checkout at the pinned three-d-animation-retarget commit";
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

test("the Ranger recipe builds a verified bundle with retargeted in-place Idle_Loop and Walk_Loop", { skip: await skipReason(), timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "humanoid-ranger-"));
  try {
    const built = await buildRangerCharacter({ processorCheckout: CHECKOUT!, outDir });
    const tar = await readFile(built.tar);
    await verifyAssetBundleTar(tar, { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entry = manifest.assets[0]!;
    assert.deepEqual([entry.key, entry.variant], [RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT]);
    assert.deepEqual(entry.observations.animations, ["Idle_Loop", "Walk_Loop"]);

    const { gltf, resources } = await readAssetBundleGltf(built.bundleDir, manifest, RANGER_BUNDLE_KEY, RANGER_BUNDLE_VARIANT);
    const document = await new NodeIO().readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
    const joints = document.getRoot().listSkins()[0]!.listJoints();
    assert.equal(joints.length, 65);
    const mappedTargets = new Set(Object.values(RANGER_BONE_MAP).map((binding) => binding.target));
    for (const animation of document.getRoot().listAnimations()) {
      for (const channel of animation.listChannels()) {
        assert.ok(mappedTargets.has(channel.getTargetNode()!.getName()), `${animation.getName()} animates only mapped joints`);
        assert.equal(channel.getSampler()!.getInterpolation(), "LINEAR");
      }
      // In-place: the pelvis keeps a constant horizontal model-space position over the clip.
      const pelvis = animation.listChannels().find((channel) => channel.getTargetNode()!.getName() === "pelvis" && channel.getTargetPath() === "translation")!;
      const values = Array.from(pelvis.getSampler()!.getOutput()!.getArray()!);
      const root = joints.find((joint) => joint.getName() === "root")!;
      // root rotates -90 degrees about X, so pelvis local X/Y are model X/-Z (horizontal) and local Z is model Y.
      assert.deepEqual(root.getRotation().map((value) => Math.round(value * 1e4) / 1e4), [-0.7071, 0, 0, 0.7071]);
      const xs = values.filter((_, index) => index % 3 === 0), ys = values.filter((_, index) => index % 3 === 1);
      assert.ok(Math.max(...xs) - Math.min(...xs) < 1e-4 && Math.max(...ys) - Math.min(...ys) < 1e-4, `${animation.getName()} pelvis stays in place`);
    }
    const walk = built.lineage.clips.find((clip) => clip.name === "Walk_Loop")!;
    assert.equal(walk.observations.rootMotion, "in-place");
    assert.equal(walk.observations.mappedBoneCount, Object.keys(RANGER_BONE_MAP).length);
    assert.equal(walk.observations.startSeconds, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
