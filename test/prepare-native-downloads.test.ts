import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { prepareNativeDownloads } from "../scripts/prepare-native-downloads.ts";

test("selected local entries become self-contained native GLBs while clips stay shared", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-downloads-test-"));
  try {
    const document = new Document();
    document.createScene().addChild(document.createNode("Hips"));
    const io = new NodeIO();
    const scene = await io.writeJSON(document);
    await writeFile(path.join(directory, "ranger.gltf"), JSON.stringify(scene.json));
    const clips = await io.writeBinary(document);
    await writeFile(path.join(directory, "clips.glb"), clips);
    const index = path.join(directory, "index.json");
    const entry = { key: "ranger", variant: "default", files: ["ranger.gltf"], textures: [], clips: "clips.glb" };
    await writeFile(index, JSON.stringify({ schema: "asset-downloads-v1", release: "rolling", entries: [entry] }));
    const result = await prepareNativeDownloads({ index, entries: ["ranger/default"], outDir: path.join(directory, "native") });
    const output = await io.read(path.join(directory, "native", result.entries[0]!.file));
    assert.equal(output.getRoot().listNodes()[0]?.getName(), "Hips");
    assert.equal(result.entries[0]?.clips, "clips.native.glb");
    assert.equal((await io.read(path.join(directory, "native", "clips.native.glb"))).getRoot().listNodes()[0]?.getName(), "Hips");
    assert.deepEqual(await readFile(path.join(directory, "clips.glb")), Buffer.from(clips));
    await writeFile(index, JSON.stringify({ schema: "asset-downloads-v1", release: "rolling", entries: [{ ...entry, key: "../escaped" }] }));
    await assert.rejects(prepareNativeDownloads({ index, entries: ["../escaped/default"], outDir: directory }), /malformed download index/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packing and native preparation retain static equipment grip transforms", async () => {
  const { packDownloads } = await import("../scripts/pack-downloads.ts");
  const { storeAssetObject } = await import("../src/asset-store.ts");
  const { exportAssetBundle, GLTF_RESOURCES_BUNDLE_PROFILE } = await import("../src/asset-bundle.ts");
  const directory = await mkdtemp(path.join(os.tmpdir(), "equipment-grip-test-"));
  try {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    const primitive = document.createPrimitive().setAttribute("POSITION", positions);
    document.createScene().addChild(document.createNode("sword").setMesh(document.createMesh().addPrimitive(primitive)))
      .addChild(document.createNode("grip").setTranslation([0.1, 0.2, 0.3]));
    const io = new NodeIO();
    const source = (await storeAssetObject(directory, { bytes: Buffer.from(await io.writeBinary(document)), kind: "scene", mediaType: "model/gltf-binary", metadata: { license: "CC0-1.0", sourceId: "fixture.original" } })).asset;
    const bundle = path.join(directory, "bundle");
    await exportAssetBundle(directory, bundle, { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [{ key: "sword", variant: "default" }] }, inputs: { assets: [source] } });
    const packed = path.join(directory, "packed");
    await packDownloads({ bundleDir: bundle, outDir: packed, name: "equipment", clips: "character/default" });
    const native = path.join(directory, "native");
    const result = await prepareNativeDownloads({ index: path.join(packed, "equipment.index.json"), entries: ["sword/default"], outDir: native });
    const model = await io.read(path.join(native, result.entries[0]!.file));
    assert.deepEqual(model.getRoot().listNodes().find((node) => node.getName() === "grip")?.getTranslation(), [0.1, 0.2, 0.3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
