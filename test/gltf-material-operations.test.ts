import { materialGlb } from "./fixtures/material-glb.js";
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
async function workspace(t: TestContext, bytes = materialGlb()) {
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
  assert.deepEqual(await resolveAssetObject(root, source), materialGlb());
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
  const duplicate = await workspace(t, materialGlb({ materials: [{ name: "paint" }, { name: "paint" }] }));
  await assert.rejects(executeGltfBaseColorOperation(duplicate.root, duplicate.invocation), /uniquely/);
  const corrupt = createAssetRef({ ...baseColor, byteLength: 1 });
  await assert.rejects(createGltfBaseColorOperationBuildIdentity(root, { ...invocation, inputs: { source, "base-color": corrupt } }), /mismatch/);
  await writeFile(path.join(root, assetObjectPortablePath(baseColor)), "corrupt");
  await assert.rejects(executeGltfBaseColorOperation(root, invocation), /mismatch/);
});
