import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest } from "../src/asset-bundle.js";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { sha256Bytes } from "../src/hash.js";
import { buildGreyhavenNature, NATURE_DESCRIPTOR_ATTACHMENT, NATURE_DESCRIPTOR_SCHEMA, NATURE_MEMBERS } from "../scripts/build-greyhaven-nature.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const nature = storage.entries.filter((entry) => entry.sourceId.startsWith("quaternius.stylized-nature-megakit-standard."));
const pointers = [];
for (const entry of nature) {
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
if (process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1") assert.deepEqual(pointers, []);

test("nature bundle supplies independently shaped, grounded families with game-resolution textures and provenance", {
  skip: pointers.length ? "requires hydrated canonical nature payloads (git lfs pull)" : false,
  timeout: 120_000,
}, async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "greyhaven-nature-"));
  try {
    const built = await buildGreyhavenNature(out);
    const verified = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" });
    const manifest = verified.manifest as GltfResourcesBundleManifest;
    await verifyAssetBundleTar(await readFile(built.tar), { ref: built.exportRef });
    assert.deepEqual(manifest.assets.map((item) => item.key).sort(), NATURE_MEMBERS.map((item) => item.key).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.nature.tree.broadleaf", "default", NATURE_DESCRIPTOR_ATTACHMENT)).toString());
    assert.equal(descriptor.schema, NATURE_DESCRIPTOR_SCHEMA);
    assert.equal(descriptor.units, "metre");
    const rockShapes = new Set<string>();
    const io = new NodeIO();
    for (const entry of NATURE_MEMBERS) {
      const item = await readAssetBundleGltf(built.bundleDir, manifest, entry.key, "default");
      const document = await io.readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
      const scene = document.getRoot().getDefaultScene();
      assert.ok(scene);
      const bounds = getBounds(scene);
      assert.ok(Math.abs(bounds.min[1]) < 1e-5, `${entry.key}: base on ground`);
      for (const axis of [0, 2] as const) assert.ok(Math.abs(bounds.max[axis] + bounds.min[axis]) < 1e-5, `${entry.key}: centred footprint`);
      assert.ok(document.getRoot().listTextures().length > 0);
      for (const image of document.getRoot().listTextures()) {
        const size = image.getSize();
        assert.ok(size && Math.max(...size) <= 1024, `${entry.key}: game texture resolution`);
      }
      if (entry.family === "rock") {
        const mesh = document.getRoot().listMeshes()[0];
        const vertices = mesh?.listPrimitives()[0]?.getAttribute("POSITION")?.getArray();
        assert.ok(vertices);
        rockShapes.add(sha256Bytes(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength)));
      }
      const metadata = built.descriptor.assets.find((item) => item.key === entry.key);
      assert.equal(metadata?.provenance.license, "CC0-1.0");
      assert.match(metadata?.provenance.source.sha256 ?? "", /^[0-9a-f]{64}$/);
    }
    assert.equal(rockShapes.size, 3, "rock variants have distinct vertex geometry");
  } finally { await rm(out, { recursive: true, force: true }); }
});
