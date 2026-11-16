// Greyhaven farm animals (#659, docs/greyhaven-farm-animals.md): the recipe turns five hash-pinned CC0 Quaternius
// sources and two authored animals into a verified gltf-resources-v1 bundle of grounded, forward-facing, metre-sized
// skinned animals with in-place Idle, Walk and (where available) Eat clips, and replays to the same tar. The build skips
// unless ASSET_TOOLING_BLENDER names Blender 5.2.2 and the canonical sources are hydrated (git lfs pull).
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
  FARM_ANIMALS, FARM_CLIPS, FARM_DESCRIPTOR_ATTACHMENT, FARM_DESCRIPTOR_FILE, FARM_DESCRIPTOR_SCHEMA, FARM_RELEASE,
  buildGreyhavenFarmAnimals, createFarmAnimalAssetSpec, farmKey,
} from "../../../scripts/build-greyhaven-farm-animals.ts";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const pointers = [];
for (const { sourceId } of FARM_ANIMALS) {
  if (!sourceId) continue;
  const entry = storage.entries.find((item) => item.sourceId === sourceId);
  assert.ok(entry, `${sourceId} has canonical storage`);
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : pointers.length ? "requires hydrated canonical animal sources (git lfs pull)" : false;
/** Greyhaven heights in metres, at the top of each idle pose. */
const HEIGHTS = { cow: 1.55, horse: 1.8, donkey: 1.4, pig: 0.7, sheep: 1.0, goat: 0.95, chicken: 0.45 } as const;

test("each farm animal spec runs the packaged recipe over its pinned source, or none when authored", () => {
  const sourced = createFarmAnimalAssetSpec({ animal: "cow", file: "source.glb", sourceSha256: "b".repeat(64), scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(sourced.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, animal: "cow" } });
  assert.deepEqual(Object.keys(sourced.inputs).sort(), ["script", "source"]);
  const authored = createFarmAnimalAssetSpec({ animal: "goat", file: null, sourceSha256: null, scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(Object.keys(authored.inputs), ["script"]);
  assert.deepEqual(FARM_ANIMALS.map((item) => item.animal), ["cow", "horse", "donkey", "pig", "sheep", "goat", "chicken"]);
  assert.equal(FARM_RELEASE, "greyhaven-farm-animals", "one rolling release, never numbered");
});

test("the farm-animals recipe builds a verified, reproducible bundle of grounded animals with in-place clips", { skip, timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "farm-animals-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "farm-animals-replay-"));
  try {
    const built = await buildGreyhavenFarmAnimals({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const manifest = (await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" })).manifest as GltfResourcesBundleManifest;
    assert.deepEqual(manifest.assets.map((item) => item.key).sort(), FARM_ANIMALS.map((item) => farmKey(item.animal)).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.farm.cow", "default", FARM_DESCRIPTOR_ATTACHMENT)).toString());
    assert.equal(descriptor.schema, FARM_DESCRIPTOR_SCHEMA);
    assert.deepEqual(descriptor, JSON.parse(await readFile(path.join(outDir, FARM_DESCRIPTOR_FILE), "utf8")), "the attachment is the descriptor file");
    const io = new NodeIO();
    for (const entry of FARM_ANIMALS) {
      const key = farmKey(entry.animal);
      const item = await readAssetBundleGltf(built.bundleDir, manifest, key, "default");
      const document = await io.readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
      const gltf = document.getRoot();
      assert.equal(gltf.listSkins().length, 1, `${entry.animal} is one skinned rig`);
      assert.deepEqual(gltf.listAnimations().map((a) => a.getName()).sort(), [...FARM_CLIPS[entry.animal]].sort(), `${entry.animal} clips`);
      assert.equal(gltf.getDefaultScene()?.listChildren().map((node) => node.getName()).join(), key, `${entry.animal} root node`);

      const asset = descriptor.assets.find((a: any) => a.key === key);
      const { min, max } = asset.idleBounds;
      assert.equal(min[1], 0, `${entry.animal} stands on y = 0`);
      for (const k of [0, 2]) assert.ok(Math.abs(min[k] + max[k]) < 1e-3, `${entry.animal} is centred on its footprint`);
      assert.ok(asset.size.depth > asset.size.width * 1.5, `${entry.animal} is long along +Z, the facing axis`);
      assert.ok(Math.abs(asset.size.height - HEIGHTS[entry.animal]) < 1e-3, `${entry.animal} is ${HEIGHTS[entry.animal]} m high`);
      assert.ok(asset.walkTravel < 0.02, `${entry.animal} walks in place`);
      for (const clip of FARM_CLIPS[entry.animal]) assert.ok(asset.clips[clip].seconds > 0.5, `${entry.animal} ${clip} is a real loop`);
      if (entry.sourceId) {
        assert.equal(asset.provenance.license, "CC0-1.0");
        assert.equal(asset.provenance.catalogSource, entry.sourceId);
        assert.match(asset.provenance.source.sha256, /^[0-9a-f]{64}$/);
      }
    }

    const replay = await buildGreyhavenFarmAnimals({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
