import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { createAssetRef, type AssetOperationResult, type AssetRef } from "../src/operations.js";
import { GLTF_BASE_COLOR_OPERATION, createGltfBaseColorOperationBuildIdentity, executeGltfBaseColorOperation,
  type GltfBaseColorParameters } from "../src/gltf-material-operations.js";

// Independently authored white RGBA PNG and GLB; no production glTF writer fixture oracle.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
const controls: GltfBaseColorParameters = { materialName: "paint", baseColorFactor: [.2, .4, .6, .8], texCoord: 0,
  sampler: { magFilter: "linear", minFilter: "nearest", wrapS: "clamp-to-edge", wrapT: "mirrored-repeat" }, alpha: { mode: "BLEND" } };
function glb(change: Record<string, unknown> = {}) {
  const geometry = Buffer.alloc(152);
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]
    .forEach((value, i) => geometry.writeFloatLE(value, i * 4));
  [0, 1, 2].forEach((value, i) => geometry.writeUInt16LE(value, 96 + i * 2));
  [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1].forEach((value, i) => geometry.writeFloatLE(value, 104 + i * 4));
  const binary = Buffer.concat([geometry, png, Buffer.alloc((4 - png.length % 4) % 4)]);
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "root", translation: [2, 3, 4], children: [1] }, { name: "leaf", mesh: 0, translation: [0, 1, 0] }],
    meshes: [{ primitives: [0, 1].map(material => ({ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 4 }, indices: 3, material })) }],
    materials: [{ name: "paint", pbrMetallicRoughness: { baseColorFactor: [.5, .5, .5, 1], baseColorTexture: { index: 0 },
      metallicFactor: .15, roughnessFactor: .27, metallicRoughnessTexture: { index: 0 } },
      normalTexture: { index: 0, scale: .6 }, occlusionTexture: { index: 0, strength: .3 }, emissiveTexture: { index: 0 },
      emissiveFactor: [.1, .2, .3], alphaMode: "MASK", alphaCutoff: .42, doubleSided: true },
      { name: "keep", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: .3, roughnessFactor: .7 } }],
    images: [{ bufferView: 5, mimeType: "image/png" }], textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
    buffers: [{ byteLength: binary.length }], bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 6 },
      { buffer: 0, byteOffset: 104, byteLength: 48 }, { buffer: 0, byteOffset: 152, byteLength: png.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 4, componentType: 5126, count: 3, type: "VEC4" }], ...change };
  const json = Buffer.from(JSON.stringify(document)), padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, binary]);
}
async function workspace(t: TestContext, bytes = glb()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = (await storeAssetObject(root, { bytes, kind: "scene", mediaType: "model/gltf-binary" })).asset;
  const baseColor = (await storeAssetObject(root, { bytes: png, kind: "image", mediaType: "image/png" })).asset;
  return { root, source, baseColor, invocation: { parameters: controls, inputs: { source, "base-color": baseColor } } };
}
function output(result: AssetOperationResult): AssetRef {
  const ref = result.outputs.output; assert.ok(ref && !Array.isArray(ref)); return ref;
}

test("named base-color assignment preserves independent geometry, hierarchy and unrelated PBR meaning", async t => {
  const { root, source, baseColor, invocation } = await workspace(t);
  const before = await new NodeIO().readBinary(await resolveAssetObject(root, source));
  const build = await createGltfBaseColorOperationBuildIdentity(root, invocation);
  assert.equal(build.operation.id, GLTF_BASE_COLOR_OPERATION.id);
  assert.deepEqual(build.inputs, { source, "base-color": baseColor });
  const result = await executeGltfBaseColorOperation(root, invocation), ref = output(result);
  const after = await new NodeIO().readBinary(await resolveAssetObject(root, ref));
  assert.equal(ref.metadata.sourceSha256, source.sha256); assert.equal(ref.metadata.baseColorSha256, baseColor.sha256);
  const beforeRoot = before.getRoot(), afterRoot = after.getRoot();
  for (const [i, mesh] of beforeRoot.listMeshes().entries()) for (const [j, primitive] of mesh.listPrimitives().entries()) {
    const next = afterRoot.listMeshes()[i]!.listPrimitives()[j]!;
    assert.equal(next.getMode(), primitive.getMode());
    assert.deepEqual(next.getIndices()!.getArray(), primitive.getIndices()!.getArray());
    assert.deepEqual(next.listSemantics().sort(), primitive.listSemantics().sort());
    for (const semantic of primitive.listSemantics()) {
      const accessor = primitive.getAttribute(semantic)!, derived = next.getAttribute(semantic)!;
      assert.equal(derived.getType(), accessor.getType()); assert.equal(derived.getComponentType(), accessor.getComponentType());
      assert.deepEqual(derived.getArray(), accessor.getArray());
    }
  }
  assert.deepEqual(afterRoot.listNodes().map(node => [node.getName(), node.getWorldTranslation()]),
    [["root", [2, 3, 4]], ["leaf", [2, 4, 4]]]);
  assert.equal(afterRoot.listNodes()[0]!.listChildren()[0], afterRoot.listNodes()[1]);
  assert.equal(afterRoot.listTextures().length, 1, "byte-identical embedded PNG is reused");
  const paint = afterRoot.listMaterials()[0]!, keep = afterRoot.listMaterials()[1]!;
  assert.deepEqual(Buffer.from(paint.getBaseColorTexture()!.getImage()!), png); assert.deepEqual(paint.getBaseColorFactor(), controls.baseColorFactor);
  assert.equal(paint.getAlphaMode(), "BLEND"); assert.equal(paint.getAlphaCutoff(), .5);
  const info = paint.getBaseColorTextureInfo()!;
  assert.deepEqual([info.getTexCoord(), info.getMagFilter(), info.getMinFilter(), info.getWrapS(), info.getWrapT()], [0, 9729, 9728, 33071, 33648]);
  assert.deepEqual([paint.getMetallicFactor(), paint.getRoughnessFactor(), paint.getNormalScale(), paint.getOcclusionStrength(), paint.getEmissiveFactor(), paint.getDoubleSided()], [.15, .27, .6, .3, [.1, .2, .3], true]);
  for (const texture of [paint.getMetallicRoughnessTexture(), paint.getNormalTexture(), paint.getOcclusionTexture(), paint.getEmissiveTexture()]) assert.deepEqual(Buffer.from(texture!.getImage()!), png);
  assert.deepEqual([keep.getMetallicFactor(), keep.getRoughnessFactor(), keep.getBaseColorFactor()], [.3, .7, [1, 1, 1, 1]]);
  assert.deepEqual([keep.getBaseColorTextureInfo()!.getMagFilter(), keep.getBaseColorTextureInfo()!.getWrapS()], [9728, 10497]);
  assert.equal(result.observations.affectedPrimitives, 1);
  assert.deepEqual(await resolveAssetObject(root, source), glb());
  const mtime = (await stat(path.join(root, assetObjectPortablePath(ref)))).mtimeMs;
  assert.deepEqual(await executeGltfBaseColorOperation(root, invocation), result);
  assert.equal((await stat(path.join(root, assetObjectPortablePath(ref)))).mtimeMs, mtime);
});

test("material-only changes retain geometry across cold stores and explicit alpha policies", async t => {
  const a = await workspace(t), b = await workspace(t);
  const first = await executeGltfBaseColorOperation(a.root, a.invocation);
  const changed = { ...a.invocation, parameters: { ...controls, baseColorFactor: [1, .25, .1, 1], alpha: { mode: "MASK", cutoff: .35 } } };
  const warm = await executeGltfBaseColorOperation(a.root, changed);
  const cold = await executeGltfBaseColorOperation(b.root, { ...changed, inputs: b.invocation.inputs });
  assert.deepEqual(warm, cold); assert.notEqual(output(warm).sha256, output(first).sha256);
  const before = await new NodeIO().readBinary(await resolveAssetObject(a.root, output(first)));
  const after = await new NodeIO().readBinary(await resolveAssetObject(a.root, output(warm)));
  assert.deepEqual(after.getRoot().listAccessors().map(a => a.getArray()), before.getRoot().listAccessors().map(a => a.getArray()));
  assert.equal(after.getRoot().listMaterials()[0]!.getAlphaCutoff(), .35);
});

test("invalid bindings, controls and tampered inputs fail before derived objects are stored", async t => {
  const { root, source, baseColor, invocation } = await workspace(t);
  const before = (await readdir(root, { recursive: true })).sort();
  // Windows checkout and OS temp may be on different drives; relative() then returns an absolute path.
  const relativeStore = path.relative(path.dirname(root), root);
  assert.equal(path.isAbsolute(relativeStore), false);
  for (const relativeRoot of ["", ".", relativeStore]) {
    await assert.rejects(createGltfBaseColorOperationBuildIdentity(relativeRoot, invocation), /root must be an absolute path/);
    await assert.rejects(executeGltfBaseColorOperation(relativeRoot, invocation), /root must be an absolute path/);
  }
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  for (const change of [{ materialName: "missing" }, { texCoord: 1 }, { texCoord: -1 }, { baseColorFactor: [1, 2, 3, 1] },
    { alpha: { mode: "MASK" } }, { alpha: { mode: "OPAQUE", cutoff: .5 } }, { sampler: { ...controls.sampler, minFilter: "linear-mipmap-linear" } }, { invented: 1 }]) {
    await assert.rejects(executeGltfBaseColorOperation(root, { ...invocation, parameters: { ...controls, ...change } }));
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  }
  const duplicate = await workspace(t, glb({ materials: [{ name: "paint" }, { name: "paint" }] }));
  await assert.rejects(executeGltfBaseColorOperation(duplicate.root, duplicate.invocation), /uniquely/);
  const corrupt = createAssetRef({ ...baseColor, byteLength: 1 });
  await assert.rejects(createGltfBaseColorOperationBuildIdentity(root, { ...invocation, inputs: { source, "base-color": corrupt } }), /mismatch/);
  await writeFile(path.join(root, assetObjectPortablePath(baseColor)), "corrupt");
  await assert.rejects(executeGltfBaseColorOperation(root, invocation), /mismatch/);
});
