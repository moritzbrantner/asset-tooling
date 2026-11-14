import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
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

test("native animation libraries drop unused required BasisU while preserving rigs and clips", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-clips-basisu-test-"));
  try {
    const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
    const figure = new Document();
    figure.createScene().addChild(figure.createNode("figure"));
    await writeFile(path.join(directory, "ranger.gltf"), JSON.stringify((await io.writeJSON(figure)).json));
    const library = new Document();
    library.createExtension(KHRTextureBasisu).setRequired(true);
    const hips = library.createNode("Hips").setTranslation([0, 1, 0]);
    const spine = library.createNode("Spine");
    hips.addChild(spine);
    library.createScene().addChild(hips);
    library.createSkin("rig").setSkeleton(hips).addJoint(hips).addJoint(spine);
    const buffer = library.createBuffer();
    const times = library.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const translations = library.createAccessor().setType("VEC3").setArray(new Float32Array([0, 1, 0, 0, 2, 0])).setBuffer(buffer);
    for (const name of ["Idle", "Walk"]) {
      const sampler = library.createAnimationSampler().setInput(times).setOutput(translations);
      const channel = library.createAnimationChannel().setTargetNode(hips).setTargetPath("translation").setSampler(sampler);
      library.createAnimation(name).addSampler(sampler).addChannel(channel);
    }
    const source = await io.writeBinary(library);
    assert.deepEqual((await io.binaryToJSON(source)).json.extensionsRequired, ["KHR_texture_basisu"]);
    const clips = path.join(directory, "clips.glb");
    await writeFile(clips, source);
    const index = path.join(directory, "index.json");
    await writeFile(index, JSON.stringify({ schema: "asset-downloads-v1", release: "rolling", entries: [
      { key: "ranger", variant: "default", files: ["ranger.gltf"], textures: [], clips: "clips.glb" },
    ] }));
    const options = { index, entries: ["ranger/default"], outDir: path.join(directory, "native") };
    await prepareNativeDownloads(options);
    const nativeBytes = await readFile(path.join(options.outDir, "clips.native.glb"));
    const nativeIO = new NodeIO();
    const nativeJSON = (await nativeIO.binaryToJSON(nativeBytes)).json;
    assert.ok(!nativeJSON.extensionsUsed?.includes("KHR_texture_basisu"));
    assert.ok(!nativeJSON.extensionsRequired?.includes("KHR_texture_basisu"));
    const output = (await nativeIO.readBinary(nativeBytes)).getRoot();
    assert.deepEqual(output.listNodes().map(node => node.getName()), ["Hips", "Spine"]);
    assert.deepEqual(output.listSkins()[0]?.listJoints().map(node => node.getName()), ["Hips", "Spine"]);
    assert.deepEqual(output.listAnimations().map(animation => animation.getName()), ["Idle", "Walk"]);
    for (const animation of output.listAnimations()) {
      assert.equal(animation.listChannels()[0]?.getTargetNode()?.getName(), "Hips");
      assert.deepEqual(animation.listSamplers()[0]?.getInput()?.getArray(), times.getArray());
      assert.deepEqual(animation.listSamplers()[0]?.getOutput()?.getArray(), translations.getArray());
    }
    assert.deepEqual(await readFile(clips), Buffer.from(source));
    // Animation-only libraries must not silently discard a real texture requirement.
    // Same 4 x 4 UASTC + Zstandard KTX2 fixture used by gltf-resources-basisu.test.ts.
    const ktx2 = Buffer.from("q0tUWCAyMLsNChoKAAAAAAEAAAAEAAAABAAAAAAAAAAAAAAAAQAAAAEAAAACAAAAaAAAACwAAACUAAAAUAAAAAAAAAAAAAAAAAAAAAAAAADkAAAAAAAAABkAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACmAQIAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////ywAAABLVFh3cml0ZXIAa3R4IGNyZWF0ZSB2NC40LjIgLyBsaWJrdHggdjQuNC4yABwAAABLVFh3cml0ZXJTY1BhcmFtcwAtLXpzdGQgMTgAKLUv/SAQgQAAF5lM5j+1igAAAAAAAAAAAA==", "base64");
    library.createTexture("unexpected").setMimeType("image/ktx2").setImage(ktx2);
    await writeFile(clips, await io.writeBinary(library));
    await assert.rejects(prepareNativeDownloads(options), /animation-only library clips.glb must not contain textures/);
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

test("multi-selection release packing reads current pinned files and rebuilds a snapshot per invocation", async () => {
  const { packDownloads } = await import("../scripts/pack-downloads.ts");
  const { storeAssetObject } = await import("../src/asset-store.ts");
  const { exportAssetBundle, GLTF_RESOURCES_BUNDLE_PROFILE } = await import("../src/asset-bundle.ts");
  const directory = await mkdtemp(path.join(os.tmpdir(), "bundle-pack-multi-test-"));
  try {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    document.createScene().addChild(document.createNode("fixture").setMesh(document.createMesh().addPrimitive(document.createPrimitive().setAttribute("POSITION", positions))));
    const bytes = Buffer.from(await new NodeIO().writeBinary(document));
    const source = (await storeAssetObject(directory, { bytes, kind: "scene", mediaType: "model/gltf-binary", metadata: { sourceId: "fixture", license: "CC0-1.0" } })).asset;
    const selections = ["one", "two", "three"].map(key => ({ key, variant: "default" }));
    const bundle = path.join(directory, "bundle");
    await exportAssetBundle(directory, bundle, {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: selections.map(() => source) },
    });
    const packaged = await packDownloads({ bundleDir: bundle, outDir: path.join(directory, "out"), name: "fixture" });
    assert.deepEqual(packaged.index.entries.map(entry => entry.key), ["one", "three", "two"]);
    for (const entry of packaged.index.entries) {
      assert.ok((await readFile(path.join(directory, "out", `${entry.key}.default.gltf`))).length > 0);
    }
    const manifestFile = path.join(bundle, "manifest.json");
    const originalManifest = await readFile(manifestFile);
    const changed = JSON.parse(originalManifest.toString("utf8"));
    changed.assets[1].key = "one";
    await writeFile(manifestFile, JSON.stringify(changed));
    await assert.rejects(packDownloads({ bundleDir: bundle, outDir: path.join(directory, "invalid"), name: "fixture" }), /duplicate|sorted|selection/i);
    await writeFile(manifestFile, originalManifest);
    const original = JSON.parse(originalManifest.toString("utf8"));
    const selectedPath = path.join(bundle, original.assets[0].path);
    await writeFile(selectedPath, "corrupted scene");
    await assert.rejects(packDownloads({ bundleDir: bundle, outDir: path.join(directory, "corrupt"), name: "fixture" }), /hash|length|mismatch|pin/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
