import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { exportAssetBundle, GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.ts";
import { storeAssetObject } from "../src/asset-store.ts";

/** A 4 x 4 UASTC + Zstandard KTX2 written by KTX-Software 4.4.2's `ktx create`. */
const KTX2 = Buffer.from("q0tUWCAyMLsNChoKAAAAAAEAAAAEAAAABAAAAAAAAAAAAAAAAQAAAAEAAAACAAAAaAAAACwAAACUAAAAUAAAAAAAAAAAAAAAAAAAAAAAAADkAAAAAAAAABkAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACmAQIAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////ywAAABLVFh3cml0ZXIAa3R4IGNyZWF0ZSB2NC40LjIgLyBsaWJrdHggdjQuNC4yABwAAABLVFh3cml0ZXJTY1BhcmFtcwAtLXpzdGQgMTgAKLUv/SAQgQAAF5lM5j+1igAAAAAAAAAAAA==", "base64");

async function quad(image: Uint8Array) {
  const document = new Document();
  document.createExtension(KHRTextureBasisu).setRequired(true);
  const buffer = document.createBuffer();
  const accessor = (type: "VEC2" | "VEC3", array: Float32Array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const material = document.createMaterial("ground").setBaseColorTexture(document.createTexture("base").setImage(image).setMimeType("image/ktx2"));
  const primitive = document.createPrimitive().setMaterial(material)
    .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])))
    .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array([0, 0, 1, 0, 0, 1])));
  document.createScene().addChild(document.createNode("ground").setMesh(document.createMesh().addPrimitive(primitive)));
  return Buffer.from(await new NodeIO().registerExtensions([KHRTextureBasisu]).writeBinary(document));
}

test("gltf-resources-v1 ships KHR_texture_basisu textures as .ktx2 resources and rejects a non-KTX2 payload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "basisu-bundle-test-"));
  try {
    const store = async (bytes: Buffer) => (await storeAssetObject(directory, { bytes, kind: "scene", mediaType: "model/gltf-binary" })).asset;
    const parameters = { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [{ key: "ground", variant: "default" }] } as const;
    const bundle = path.join(directory, "bundle");
    await exportAssetBundle(directory, bundle, { parameters, inputs: { assets: [await store(await quad(KTX2))] } });
    const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8"));
    const entry = manifest.assets[0]!;
    const ktx2 = entry.resources.find((resource: { mediaType: string }) => resource.mediaType === "image/ktx2");
    assert.ok(ktx2?.path.endsWith(".ktx2"));
    assert.deepEqual(await readFile(path.join(bundle, ktx2!.path)), KTX2);
    const gltf = JSON.parse(await readFile(path.join(bundle, entry.path), "utf8"));
    assert.deepEqual(gltf.extensionsRequired, ["KHR_texture_basisu"]);
    assert.equal(gltf.textures[0].extensions.KHR_texture_basisu.source, 0);

    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await assert.rejects(exportAssetBundle(directory, path.join(directory, "bad"), { parameters, inputs: { assets: [await store(await quad(png))] } }),
      /declared image\/ktx2 but is not a KTX2 file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
