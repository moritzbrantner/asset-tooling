// Greyhaven wildlife (#667, #715, #722, #778, #779, #782, docs/greyhaven-wildlife.md): the recipe turns five hash-pinned CC0 Quaternius sources and
// twelve authored animals into a verified gltf-resources-v1 bundle of grounded, forward-facing, metre-sized skinned animals
// with in-place Idle, Walk and Eat clips (and Fly on the birds), and replays to the same tar. The build skips unless
// ASSET_TOOLING_BLENDER names Blender 5.2.2 and the canonical sources are hydrated (git lfs pull).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest } from "../../../src/asset-bundle.js";
import {
  WILD_ANIMALS, WILD_CLIPS, WILD_DESCRIPTOR_ATTACHMENT, WILD_DESCRIPTOR_FILE, WILD_DESCRIPTOR_SCHEMA, WILD_RELEASE,
  NEUTRAL_FIGHTERS, buildGreyhavenWildlife, createWildAnimalAssetSpec, fights, wildKey,
} from "../../../scripts/build-greyhaven-wildlife.ts";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const pointers = [];
for (const { sourceId } of WILD_ANIMALS) {
  if (!sourceId) continue;
  const entry = storage.entries.find((item) => item.sourceId === sourceId);
  assert.ok(entry, `${sourceId} has canonical storage`);
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : pointers.length ? "requires hydrated canonical animal sources (git lfs pull)" : false;

/** Greyhaven heights in metres, at the top of each idle pose; the marsh adder is authored at life size and measured by its length. */
const HEIGHTS: Partial<Record<string, number>> = { stag: 2.0, doe: 1.45, fox: 0.5, rabbit: 0.3, boar: 0.95, crow: 0.3, duck: 0.36, heron: 0.95, songbird: 0.17, wolf: 0.9, rat: 0.3, bear: 1.3, spider: 0.45, "marsh-lurker": 0.3, lynx: 0.8, "highland-ram": 1.0 };

test("each wildlife spec runs the packaged recipe with the farm recipe, over its pinned source or none when authored", () => {
  const base = { scriptSha256: "a".repeat(64), farmSha256: "c".repeat(64), blenderVersion: "5.2.2" };
  const sourced = createWildAnimalAssetSpec({ animal: "stag", file: "source.glb", sourceSha256: "b".repeat(64), ...base });
  assert.deepEqual(sourced.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, animal: "stag" } });
  assert.deepEqual(Object.keys(sourced.inputs).sort(), ["farm", "script", "source"]);
  const authored = createWildAnimalAssetSpec({ animal: "heron", file: null, sourceSha256: null, ...base });
  assert.deepEqual(Object.keys(authored.inputs).sort(), ["farm", "script"]);
  assert.deepEqual(WILD_ANIMALS.map((item) => item.animal), ["stag", "doe", "fox", "rabbit", "boar", "crow", "duck", "heron", "songbird", "wolf", "rat", "bear", "spider", "marsh-lurker", "lynx", "marsh-adder", "highland-ram"]);
  assert.deepEqual(WILD_CLIPS.lynx, ["Idle", "Walk", "Run", "Crouch_Stalk_Loop", "Pounce_Windup", "Pounce_Lunge", "Pounce_Recover", "Hit", "Death"]);
  assert.deepEqual(WILD_CLIPS["marsh-adder"], ["Idle_Coil_Loop", "Slither_Loop", "Warn_Hiss_Loop", "Strike", "Strike_Recover", "Hit", "Death"]);
  assert.deepEqual(WILD_CLIPS.wolf, ["Idle", "Walk", "Eat", "Run", "Attack_A", "Attack_B", "Hit", "Death", "Alert"]);
  assert.deepEqual(WILD_CLIPS.duck, ["Idle", "Walk", "Eat", "Fly"]);
  assert.deepEqual(WILD_CLIPS.fox, ["Idle", "Walk", "Eat"]);
  // The neutral stag and highland ram fight back (#782) without being hostile.
  for (const animal of ["stag", "highland-ram"] as const) {
    const entry = WILD_ANIMALS.find((item) => item.animal === animal)!;
    assert.ok(!entry.hostile && fights(entry), `${animal} is neutral but fights`);
    assert.deepEqual(WILD_CLIPS[animal], ["Idle", "Walk", "Eat", "Run", "Attack_A", "Attack_B", "Hit", "Death", "Alert"]);
  }
  assert.equal(WILD_RELEASE, "greyhaven-wildlife", "one rolling release, never numbered");
});

test("the wildlife recipe builds a verified, reproducible bundle of grounded animals with in-place clips", { skip, timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "wildlife-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "wildlife-replay-"));
  try {
    const built = await buildGreyhavenWildlife({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const manifest = (await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" })).manifest as GltfResourcesBundleManifest;
    assert.deepEqual(manifest.assets.map((item) => item.key).sort(), WILD_ANIMALS.map((item) => wildKey(item.animal)).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.wild.stag", "default", WILD_DESCRIPTOR_ATTACHMENT)).toString());
    assert.equal(descriptor.schema, WILD_DESCRIPTOR_SCHEMA);
    assert.deepEqual(descriptor, JSON.parse(await readFile(path.join(outDir, WILD_DESCRIPTOR_FILE), "utf8")), "the attachment is the descriptor file");
    const io = new NodeIO();
    for (const entry of WILD_ANIMALS) {
      const key = wildKey(entry.animal);
      const item = await readAssetBundleGltf(built.bundleDir, manifest, key, "default");
      const document = await io.readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
      const gltf = document.getRoot();
      assert.equal(gltf.listSkins().length, 1, `${entry.animal} is one skinned rig`);
      assert.deepEqual(gltf.listAnimations().map((a) => a.getName()).sort(), [...WILD_CLIPS[entry.animal]].sort(), `${entry.animal} clips`);
      assert.equal(gltf.getDefaultScene()?.listChildren().map((node) => node.getName()).join(), key, `${entry.animal} root node`);
      for (const node of gltf.listNodes().filter((n) => n.getMesh())) assert.ok(node.getSkin(), `${entry.animal} mesh ${node.getName()} is skinned`);
      // Organic surface (#779): every material is nonmetallic and the animal's main surface carries a detail texture.
      for (const material of gltf.listMaterials()) assert.equal(material.getMetallicFactor(), 0, `${entry.animal} ${material.getName()} is nonmetallic`);
      assert.ok(gltf.listMaterials().some((material) => material.getBaseColorTexture()), `${entry.animal} has a textured surface`);

      const asset = descriptor.assets.find((a: any) => a.key === key);
      const { min, max } = asset.idleBounds;
      assert.equal(min[1], 0, `${entry.animal} stands on y = 0`);
      for (const k of [0, 2]) assert.ok(Math.abs(min[k] + max[k]) < 1e-3, `${entry.animal} is centred on its footprint`);
      if (entry.animal === "marsh-adder") {
        // It rests coiled, so its idle footprint is round; its length is what is life-size (#778).
        assert.ok(asset.length >= 1.2 && asset.length <= 1.5, `the adder is ${asset.length} m long`);
      } else {
        assert.ok(asset.size.depth > asset.size.width * 1.4, `${entry.animal} is long along +Z, the facing axis`);
        assert.ok(Math.abs(asset.size.height - HEIGHTS[entry.animal]!) < 1e-3, `${entry.animal} is ${HEIGHTS[entry.animal]} m high`);
      }
      assert.deepEqual(asset.collisionProxy.size, [asset.size.width, asset.size.height, asset.size.depth], `${entry.animal} collision box`);
      assert.ok(asset.walkTravel < 0.02, `${entry.animal} walks in place`);
      assert.ok(asset.triangles < 5000, `${entry.animal} keeps a modest triangle count`);
      for (const clip of WILD_CLIPS[entry.animal]) assert.ok(asset.clips[clip].seconds > 0.3, `${entry.animal} ${clip} is a real loop`);
      assert.equal(asset.combat, fights(entry), `${entry.animal} combat flag`);
      if (fights(entry)) {
        // The combat clips (#715, #722, #782): attacks land inside their clip, and the death lies down for at least a second.
        const attacks = { lynx: ["Pounce_Lunge"], "marsh-adder": ["Strike"] }[entry.animal as string] ?? ["Attack_A", "Attack_B"];
        for (const clip of attacks) {
          const { seconds, contactSeconds, loop } = asset.clips[clip];
          assert.equal(loop, false, `${entry.animal} ${clip} is one-shot`);
          assert.ok(contactSeconds > 0.2 && contactSeconds < seconds - 0.1, `${entry.animal} ${clip} lands at ${contactSeconds}s of ${seconds}s`);
        }
        assert.ok(asset.clips.Death.seconds >= 1, `${entry.animal} Death lasts at least a second`);
        if (asset.clips.Run) assert.equal(asset.clips.Run.loop, true, `${entry.animal} Run loops`);
      }
      if (entry.animal === "lynx") {
        // Its gaits name the root speed that keeps planted paws still, and the pounce how far it flies (#778).
        for (const clip of ["Walk", "Run", "Crouch_Stalk_Loop"]) assert.ok(asset.clips[clip].travelSpeed > 0, `lynx ${clip} travel speed`);
        const { metres, startSeconds, endSeconds } = asset.clips.Pounce_Lunge.rootTravel;
        assert.ok(metres > 1 && startSeconds < endSeconds && endSeconds <= asset.clips.Pounce_Lunge.contactSeconds + 1e-6, "lynx pounce flight");
        assert.ok(asset.clips.Pounce_Windup.seconds >= 0.4 && asset.clips.Pounce_Windup.seconds <= 0.6, "a readable pounce wind-up");
      }
      if (entry.animal === "marsh-adder") assert.ok(asset.clips.Slither_Loop.travelSpeed > 0, "adder slither travel speed");
      if (NEUTRAL_FIGHTERS.includes(entry.animal)) {
        // The stag's and ram's charges gallop in place; the consumer moves the root up to the contact (#782).
        const { metres, startSeconds, endSeconds } = asset.clips.Attack_B.rootTravel;
        assert.ok(metres >= 1.5 && startSeconds < endSeconds && Math.abs(endSeconds - asset.clips.Attack_B.contactSeconds) < 1e-6, `${entry.animal} charge`);
      }
      if (entry.sourceId) {
        assert.equal(asset.provenance.license, "CC0-1.0");
        assert.equal(asset.provenance.catalogSource, entry.sourceId);
        assert.match(asset.provenance.source.sha256, /^[0-9a-f]{64}$/);
      }
    }

    const replay = await buildGreyhavenWildlife({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
