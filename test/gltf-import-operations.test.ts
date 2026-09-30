import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { createAssetOperationWorkflowNodeTemplate } from "../src/workflow-operations.js";
import {
  GLTF_IMPORT_OPERATION,
  createGltfImportOperationBuildIdentity,
  executeGltfImportOperation,
} from "../src/gltf-import-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

// Independently authored glTF: no use of the production writer to build the oracle.
function fixture() {
  const floats = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1,
  ]);
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "root", translation: [2, 3, 4], children: [1] },
      { name: "leaf", mesh: 0, translation: [0, 1, 0] },
    ],
    meshes: [{ name: "tile", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 3 }, material: 0 }] }],
    buffers: [{ byteLength: floats.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(floats.buffer).toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 },
      { buffer: 0, byteOffset: 96, byteLength: 48 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5126, count: 3, type: "VEC4" },
    ],
    materials: [{ name: "paint", pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 0.8], metallicFactor: 0.1, roughnessFactor: 0.7 }, alphaMode: "BLEND", doubleSided: true }],
  };
}

async function workspace(document: unknown = fixture()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-import-"));
  const { asset } = await storeAssetObject(root, {
    bytes: Buffer.from(JSON.stringify(document)), kind: "scene", mediaType: "model/gltf+json",
  });
  return { root, source: asset };
}

function output(result: AssetOperationResult): AssetRef {
  const asset = result.outputs.output;
  assert.ok(asset && !Array.isArray(asset));
  return asset;
}

test("static glTF import exposes the existing workflow and content-addressed boundaries", async () => {
  const { root, source } = await workspace();
  try {
    assert.equal(createAssetOperationWorkflowNodeTemplate(GLTF_IMPORT_OPERATION).kind, "asset.operation");
    const invocation = { inputs: { source } };
    const identity = await createGltfImportOperationBuildIdentity(root, invocation);
    assert.equal(identity.operation.id, "scene.import.gltf");
    assert.equal(identity.implementation.gltfTransform, "v4.5.1");
    assert.equal(identity.implementation.validator, "2.0.0-dev.3.10");
    const first = await executeGltfImportOperation(root, invocation);
    const second = await executeGltfImportOperation(root, invocation);
    assert.deepEqual(first, second);
    const result = output(first);
    assert.equal(result.mediaType, "model/gltf-binary");
    assert.equal(result.metadata.sourceSha256, source.sha256);
    assert.deepEqual(await resolveAssetObject(root, source), Buffer.from(JSON.stringify(fixture())));
    const doc = await new NodeIO().readBinary(await resolveAssetObject(root, result));
    const nodes = doc.getRoot().listNodes();
    assert.deepEqual(nodes[1]!.getWorldTranslation(), [2, 4, 4]);
    assert.deepEqual(nodes[0]!.listChildren(), [nodes[1]]);
    const primitive = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    assert.deepEqual(Array.from(primitive.getAttribute("POSITION")!.getArray()!), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(Array.from(primitive.getAttribute("TANGENT")!.getArray()!), [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    const material = primitive.getMaterial()!;
    assert.deepEqual(material.getBaseColorFactor(), [0.2, 0.4, 0.6, 0.8]);
    assert.equal(material.getRoughnessFactor(), 0.7);
    assert.equal(material.getMetallicFactor(), 0.1);
    assert.equal(material.getAlphaMode(), "BLEND");
    assert.equal(material.getDoubleSided(), true);
    assert.equal(first.observations.materialCount, 1);
    assert.equal(first.observations.triangleCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("external resources are declared, hash-verified and included in lineage", async () => {
  const document = fixture();
  const bytes = Buffer.from(document.buffers[0]!.uri.split(",")[1]!, "base64");
  document.buffers[0]!.uri = "geometry/tile.bin";
  const { root, source } = await workspace(document);
  try {
    await assert.rejects(executeGltfImportOperation(root, { inputs: { source } }), /missing.*geometry\/tile.bin/);
    const { asset } = await storeAssetObject(root, { bytes, kind: "buffer", mediaType: "application/octet-stream" });
    const invocation = { parameters: { resourceUris: ["geometry/tile.bin"] }, inputs: { source, resources: [asset] } };
    const result = output(await executeGltfImportOperation(root, invocation));
    assert.deepEqual(result.metadata.resourceSha256s, [asset.sha256]);
    const identity = await createGltfImportOperationBuildIdentity(root, invocation);
    assert.deepEqual(identity.parameters.resourceUris, ["geometry/tile.bin"]);
    await writeFile(path.join(root, assetObjectPortablePath(asset)), Buffer.alloc(bytes.length));
    await assert.rejects(executeGltfImportOperation(root, invocation), /hash mismatch/);
    await assert.rejects(createGltfImportOperationBuildIdentity(root, invocation), /hash mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("self-contained GLB import replays without external resource bindings", async () => {
  const { root, source } = await workspace();
  try {
    const first = output(await executeGltfImportOperation(root, { inputs: { source } }));
    const second = await executeGltfImportOperation(root, { inputs: { source: first } });
    assert.equal(output(second).sha256, first.sha256);
    assert.deepEqual(second.observations.resources, [{ kind: "buffer", index: 0, storage: "embedded" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsupported semantics, malformed references and nonfinite payloads fail before output storage", async () => {
  const invalid = [
    { ...fixture(), extensionsUsed: ["KHR_materials_unlit"] },
    { ...fixture(), skins: [{}] },
    { ...fixture(), animations: [{}] },
    { ...fixture(), nodes: [{ mesh: 99 }] },
  ];
  const nonfinite = fixture();
  const bytes = Buffer.from(nonfinite.buffers[0]!.uri.split(",")[1]!, "base64");
  bytes.writeFloatLE(Number.NaN, 0);
  nonfinite.buffers[0]!.uri = `data:application/octet-stream;base64,${bytes.toString("base64")}`;
  invalid.push(nonfinite);
  for (const document of invalid) {
    const { root, source } = await workspace(document);
    try {
      const before = (await readdir(path.join(root, ".asset-tooling/objects/v1"), { recursive: true })).sort();
      await assert.rejects(executeGltfImportOperation(root, { inputs: { source } }));
      assert.deepEqual((await readdir(path.join(root, ".asset-tooling/objects/v1"), { recursive: true })).sort(), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("resource transport rejects path escapes, network URIs, duplicate and unused bindings", async () => {
  for (const uri of ["../tile.bin", "/tile.bin", "https://example.com/tile.bin", "a\\tile.bin", "a/%2e%2e/tile.bin", "__proto__"]) {
    const document = fixture();
    document.buffers[0]!.uri = uri;
    const { root, source } = await workspace(document);
    try { await assert.rejects(executeGltfImportOperation(root, { inputs: { source } }), /URI/); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
  const { root, source } = await workspace();
  try {
    await assert.rejects(executeGltfImportOperation(root, { parameters: { resourceUris: ["tile.bin"] }, inputs: { source, resources: [source] } }), /unused/);
    await assert.rejects(executeGltfImportOperation(root, { parameters: { resourceUris: ["tile.bin", "tile.bin"] }, inputs: { source, resources: [source, source] } }), /duplicate/);
    await assert.rejects(executeGltfImportOperation(root, { parameters: { unit: "centimeter" }, inputs: { source } }), /unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
