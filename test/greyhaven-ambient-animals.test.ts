// Greyhaven ambient cat, dog and rodent (#364, docs/greyhaven-ambient-animals.md): the recipe turns three hash-pinned
// CC0 Quaternius sources into a verified gltf-resources-v1 bundle of grounded, forward-facing, metre-sized skinned
// animals with in-place Idle and Walk clips, and replays to the same tar. The build skips unless ASSET_TOOLING_BLENDER
// names Blender 5.2.2 and the canonical sources are hydrated (git lfs pull).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest } from "../src/asset-bundle.js";
import {
  AMBIENT_ANIMALS, AMBIENT_CLIPS, AMBIENT_DESCRIPTOR_ATTACHMENT, AMBIENT_DESCRIPTOR_FILE, AMBIENT_DESCRIPTOR_SCHEMA, AMBIENT_RELEASE,
  buildGreyhavenAmbientAnimals, createAmbientAnimalAssetSpec,
} from "../scripts/build-greyhaven-ambient-animals.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const pointers = [];
for (const { sourceId } of AMBIENT_ANIMALS) {
  const entry = storage.entries.find((item) => item.sourceId === sourceId);
  assert.ok(entry, `${sourceId} has canonical storage`);
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : pointers.length ? "requires hydrated canonical animal sources (git lfs pull)" : false;
/** Greyhaven sizes in metres: the dog and cat by idle height, the rodent by nose-to-tail length. */
const SIZES = { cat: ["height", 0.45], dog: ["height", 0.65], rodent: ["depth", 0.5] } as const;

test("each ambient animal spec runs the packaged recipe over its one pinned source", () => {
  const spec = createAmbientAnimalAssetSpec({ animal: "cat", file: "source.blend", sourceSha256: "b".repeat(64), scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, animal: "cat" } });
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["script", "source"]);
  assert.deepEqual(AMBIENT_ANIMALS.map((item) => item.animal), ["cat", "dog", "rodent"]);
  assert.equal(AMBIENT_RELEASE, "greyhaven-ambient-animals", "one rolling release, never numbered");
});

test("the ambient-animals recipe builds a verified, reproducible bundle of grounded idle/walk animals", { skip, timeout: 600_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "ambient-animals-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "ambient-animals-replay-"));
  try {
    const built = await buildGreyhavenAmbientAnimals({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const manifest = (await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" })).manifest as GltfResourcesBundleManifest;
    assert.deepEqual(manifest.assets.map((item) => item.key).sort(), AMBIENT_ANIMALS.map((item) => item.key).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.ambient.cat", "default", AMBIENT_DESCRIPTOR_ATTACHMENT)).toString());
    assert.equal(descriptor.schema, AMBIENT_DESCRIPTOR_SCHEMA);
    assert.deepEqual(descriptor, JSON.parse(await readFile(path.join(outDir, AMBIENT_DESCRIPTOR_FILE), "utf8")), "the attachment is the descriptor file");
    const io = new NodeIO();
    for (const entry of AMBIENT_ANIMALS) {
      const item = await readAssetBundleGltf(built.bundleDir, manifest, entry.key, "default");
      const document = await io.readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
      const gltf = document.getRoot();
      assert.equal(gltf.listSkins().length, 1, `${entry.animal} is one skinned rig`);
      assert.deepEqual(gltf.listAnimations().map((a) => a.getName()).sort(), [...AMBIENT_CLIPS], `${entry.animal} has exactly Idle and Walk`);
      assert.equal(gltf.getDefaultScene()?.listChildren().map((node) => node.getName()).join(), entry.key, `${entry.animal} root node`);

      const asset = descriptor.assets.find((a: any) => a.key === entry.key);
      const { min, max } = asset.idleBounds;
      assert.equal(min[1], 0, `${entry.animal} stands on y = 0`);
      for (const k of [0, 2]) assert.ok(Math.abs(min[k] + max[k]) < 1e-3, `${entry.animal} is centred on its footprint`);
      assert.ok(asset.size.depth > asset.size.width * 2, `${entry.animal} is long along +Z, the facing axis`);
      const [axis, metres] = SIZES[entry.animal];
      assert.ok(Math.abs(asset.size[axis] - metres) < 1e-3, `${entry.animal} ${axis} is ${metres} m`);
      assert.ok(asset.walkTravel < 0.02, `${entry.animal} walks in place`);
      for (const clip of AMBIENT_CLIPS) assert.ok(asset.clips[clip].seconds > 0.5, `${entry.animal} ${clip} is a real loop`);
      assert.equal(asset.provenance.license, "CC0-1.0");
      assert.equal(asset.provenance.catalogSource, entry.sourceId);
      assert.match(asset.provenance.source.sha256, /^[0-9a-f]{64}$/);

      const colours = gltf.listMaterials().map((m) => m.getBaseColorFactor());
      if (entry.animal === "cat") assert.ok(colours.some(([r, g, b]) => Math.max(r!, g!, b!) < 0.15), "the cat keeps its dark fur");
      if (entry.animal === "rodent") {
        const fur = gltf.listMaterials().find((m) => m.getName() === "Grey")!.getBaseColorFactor();
        assert.ok(fur[0]! > fur[1]! && fur[1]! > fur[2]! && fur[0]! - fur[2]! > 0.1, "the rodent is brown, unlike the hostile grey Rat");
      }
    }
    assert.ok(descriptor.assets.find((a: any) => a.animal === "rodent").size.height < descriptor.assets.find((a: any) => a.animal === "cat").size.height);

    const replay = await buildGreyhavenAmbientAnimals({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
