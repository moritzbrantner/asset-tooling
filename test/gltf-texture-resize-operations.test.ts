/// <reference path="../src/gltf-validator.d.ts" />
// scene.textures.resize.gltf@1 (#257): game-resolution PNG textures without changing the asset's
// structure. Hand-authored fixtures cover the per-slot limits, never upscaling, a shared image
// resampled once, normal renormalization, linear-light colour averaging, deterministic bytes, the
// unchanged structure and accessors, the scene.import.gltf@2 policy on the output, and bad parameters.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Document, ImageUtils, NodeIO, type Accessor } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import {
  GLTF_TEXTURE_RESIZE_OPERATION, createGltfTextureResizeOperationBuildIdentity, executeGltfTextureResizeOperation,
  gltfTextureTargetSize, resizeGltfTextureRgba8,
} from "../src/gltf-texture-resize-operations.js";
import { executeImageDecodeOperation, executeImageEncodePngOperation } from "../src/image-codec-operations.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image, type Rgba8Image } from "../src/image-rgba8.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
const POLICY = { allowedValidatorWarnings: ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };
const PARAMETERS = { maxEdgeBySlot: { baseColor: 16, normal: 16, metallicRoughness: 32, occlusion: 32, emissive: 16 }, default: 8, policy: POLICY };

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  assert.ok(output && !Array.isArray(output));
  return output;
}

function image(width: number, height: number, texel: (x: number, y: number) => [number, number, number, number]): Rgba8Image {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels.set(texel(x, y), (y * width + x) * 4);
  return { width, height, pixels };
}

async function png(root: string, value: Rgba8Image) {
  const canonical = (await storeAssetObject(root, { bytes: encodeRgba8Image(value), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
  return resolveAssetObject(root, single(await executeImageEncodePngOperation(root, { inputs: { source: canonical }, parameters: { compressionLevel: 9 } })));
}

async function decode(root: string, bytes: Uint8Array) {
  const stored = (await storeAssetObject(root, { bytes, kind: "image", mediaType: "image/png" })).asset;
  return parseRgba8Image(await resolveAssetObject(root, single(await executeImageDecodeOperation(root, { inputs: { source: stored }, parameters: {} }))));
}

// A black/white checker (base colour), a normal map whose columns alternate between +X and -X tilted
// 45 degrees (their mean is +Z at length 0.707), and a small ORM that already fits its limit.
const checker = image(64, 32, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
const tilt = Math.round(Math.SQRT1_2 * 127.5);
const normals = image(64, 64, (x) => (x % 2 ? [128 + tilt, 128, 128 + tilt, 255] : [128 - tilt, 128, 128 + tilt, 255]));
const orm = image(16, 16, (x, y) => [255, (x * 16) & 255, (y * 16) & 255, 255]);

/** Two quads: `a` uses base colour, normal and ORM (metallicRoughness + occlusion); `b` uses its own texture with the same base-colour bytes. */
async function fixtureGlb(root: string): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const [baseBytes, normalBytes, ormBytes] = [await png(root, checker), await png(root, normals), await png(root, orm)];
  const texture = (name: string, bytes: Uint8Array) => document.createTexture(name).setMimeType("image/png").setImage(bytes);
  const base = texture("base", baseBytes), normal = texture("normal", normalBytes), data = texture("orm", ormBytes), copy = texture("base-copy", baseBytes);
  const a = document.createMaterial("a").setBaseColorTexture(base).setNormalTexture(normal).setMetallicRoughnessTexture(data).setOcclusionTexture(data);
  const b = document.createMaterial("b").setBaseColorTexture(copy);
  const scene = document.createScene("Scene");
  for (const [name, material, offset] of [["a", a, 0], ["b", b, 2]] as const) {
    const primitive = document.createPrimitive()
      .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset + 1, 1, 0, offset, 1, 0])).setBuffer(buffer))
      .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer))
      .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])).setBuffer(buffer))
      .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buffer))
      .setMaterial(material);
    scene.addChild(document.createNode(name).setMesh(document.createMesh(name).addPrimitive(primitive)));
  }
  return new NodeIO().writeBinary(document);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-texture-resize-"));
  const source = (await storeAssetObject(root, { bytes: await fixtureGlb(root), kind: "scene", mediaType: "model/gltf-binary" })).asset;
  return { root, source, run: (parameters: Json = PARAMETERS) => executeGltfTextureResizeOperation(root, { inputs: { source }, parameters }) };
}

const accessorBytes = (accessor: Accessor) => {
  const array = accessor.getArray()!;
  return { type: accessor.getType(), componentType: accessor.getComponentType(), bytes: Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString("hex") };
};

/** The document without image payloads: everything the operation must keep. */
async function structure(bytes: Uint8Array) {
  const document = await new NodeIO().readBinary(bytes);
  const json = (await new NodeIO().writeJSON(document)).json;
  const strip = ({ bufferView, byteOffset, ...rest }: Json) => rest;
  return {
    nodes: json.nodes, meshes: json.meshes, materials: json.materials, textures: json.textures, samplers: json.samplers, scenes: json.scenes,
    images: json.images!.map(({ bufferView, ...rest }: Json) => rest), accessors: json.accessors!.map(strip),
    accessorBytes: document.getRoot().listAccessors().map(accessorBytes),
  };
}

test("descriptor, target size and the resampling filter", () => {
  assert.deepEqual([GLTF_TEXTURE_RESIZE_OPERATION.id, GLTF_TEXTURE_RESIZE_OPERATION.version], ["scene.textures.resize.gltf", "1"]);
  assert.deepEqual(gltfTextureTargetSize(4096, 4096, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(gltfTextureTargetSize(2048, 1000, 512), { width: 512, height: 250 });
  assert.deepEqual(gltfTextureTargetSize(256, 256, 1024), { width: 256, height: 256 }, "never upscales");
  assert.throws(() => resizeGltfTextureRgba8(orm, 32, 32, "linear"), /never upscales/);
  // sRGB black/white averages to linear 0.5 (sRGB 188), not to the gamma-space 128.
  assert.deepEqual([...resizeGltfTextureRgba8(checker, 32, 16, "srgb").pixels.subarray(0, 4)], [188, 188, 188, 255]);
  assert.deepEqual([...resizeGltfTextureRgba8(checker, 32, 16, "linear").pixels.subarray(0, 4)], [128, 128, 128, 255]);
  // The +X/-X tilted pair averages to +Z, renormalized to unit length.
  assert.deepEqual([...resizeGltfTextureRgba8(normals, 32, 32, "normal").pixels.subarray(0, 4)], [128, 128, 255, 255]);
});

test("canonical RGBA8 images of 4096 px source textures parse (regex limit regression)", () => {
  const large = { width: 4096, height: 4096, pixels: new Uint8Array(4096 * 4096 * 4).fill(7) };
  assert.equal(parseRgba8Image(encodeRgba8Image(large)).width, 4096);
  assert.throws(() => parseRgba8Image(Buffer.from(encodeRgba8Image({ width: 1, height: 1, pixels: new Uint8Array(4) }).toString("utf8").replace("AAAAAA==", "AAAA-A=="))), /canonical base64/);
});

test("resizes per slot, never upscales, resamples a shared image once and keeps the structure", async () => {
  const { root, source, run } = await fixture();
  try {
    const result = await run();
    const output = single(result);
    const observations = result.observations as Json;
    assert.deepEqual(observations.textures.map((texture: Json) => [texture.name, texture.slots, texture.maxEdge]), [
      ["base", ["baseColor"], 16], ["normal", ["normal"], 16], ["orm", ["metallicRoughness", "occlusion"], 32], ["base-copy", ["baseColor"], 16],
    ]);
    // Three distinct images: the base-colour bytes are shared by two textures and resampled once.
    assert.equal(observations.uniqueImages, 3);
    assert.equal(observations.imageDecodes, 2);
    assert.equal(observations.pngEncodes, 2);
    const [base, normal, data] = observations.images;
    assert.deepEqual(base.textures, [0, 3]);
    assert.deepEqual([base.encoding, base.before.width, base.before.height, base.after.width, base.after.height], ["srgb", 64, 32, 16, 8]);
    assert.deepEqual([normal.encoding, normal.after.width, normal.after.height], ["normal", 16, 16]);
    assert.equal(data.resized, false, "a 16 px ORM under a 32 px limit is never upscaled");
    assert.deepEqual(data.after, data.before);
    assert.equal(observations.imageBytes.before, observations.images.reduce((sum: number, entry: Json) => sum + entry.before.byteLength, 0));

    const bytes = await resolveAssetObject(root, output);
    const document = await new NodeIO().readBinary(bytes);
    const textures = document.getRoot().listTextures();
    assert.deepEqual(textures.map((texture) => ImageUtils.getSize(texture.getImage()!, "image/png")), [[16, 8], [16, 16], [16, 16], [16, 8]]);
    assert.deepEqual(Buffer.from(textures[0]!.getImage()!), Buffer.from(textures[3]!.getImage()!), "both users of the shared image get the same bytes");
    const sourceDocument = await new NodeIO().readBinary(await resolveAssetObject(root, source));
    assert.deepEqual(Buffer.from(textures[2]!.getImage()!), Buffer.from(sourceDocument.getRoot().listTextures()[2]!.getImage()!), "unresized image bytes are untouched");
    assert.deepEqual(await structure(bytes), await structure(await resolveAssetObject(root, source)));

    // sRGB-correct colour and renormalized, unflipped normals after the PNG round trip.
    const colour = await decode(root, textures[0]!.getImage()!);
    assert.ok(colour.pixels.every((value, index) => index % 4 === 3 ? value === 255 : value === 188));
    const decodedNormals = await decode(root, textures[1]!.getImage()!);
    for (let offset = 0; offset < decodedNormals.pixels.length; offset += 4) {
      assert.deepEqual([...decodedNormals.pixels.subarray(offset, offset + 4)], [128, 128, 255, 255]);
    }

    // The output imports under the scene.import.gltf@2 policy.
    const imported = await executeGltfProductionImportOperation(root, { inputs: { source: output }, parameters: { policy: POLICY } });
    assert.ok(single(imported).sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output bytes are deterministic across object stores and the build identity records the policy", async () => {
  const first = await fixture(), second = await fixture();
  try {
    assert.equal(first.source.sha256, second.source.sha256);
    const [a, b] = [single(await first.run()), single(await second.run())];
    assert.equal(a.sha256, b.sha256);
    const identity = await createGltfTextureResizeOperationBuildIdentity(first.root, { inputs: { source: first.source }, parameters: PARAMETERS });
    assert.deepEqual(identity.operation, { id: "scene.textures.resize.gltf", version: "1" });
    assert.deepEqual(identity.parameters, PARAMETERS);
    assert.equal((identity.implementation as Json).filter, "area-average-float32-v1");
    assert.equal((identity.implementation as Json).pngCompressionLevel, 9);
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("rejects unknown slots, bad limits and unknown parameters", async () => {
  const { root, run } = await fixture();
  try {
    await assert.rejects(run({ maxEdgeBySlot: { diffuse: 16 }, default: 8 }), /unknown texture slot 'diffuse'/);
    await assert.rejects(run({ maxEdgeBySlot: { normal: 0 }, default: 8 }), /maxEdgeBySlot.normal must be an integer/);
    await assert.rejects(run({ maxEdgeBySlot: {} }), /default must be an integer/);
    await assert.rejects(run({ ...PARAMETERS, format: "webp" }), /unknown glTF texture resize parameter 'format'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
