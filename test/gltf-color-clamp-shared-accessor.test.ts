import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { executeGltfAnalyzeOperation, executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";

// Regression for the Codex P1 finding on PR #235: the declared color clamp repair must not change a
// float accessor's non-color uses when that accessor is also referenced as COLOR_n.

function floats(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

const SHARED = [0, 0, 0, 1.0001, 0, 0, 0, 1, 0];
const SHARED_FLOAT32 = Array.from(new Float32Array(SHARED));

/** Mesh 0 uses accessor 0 as POSITION; mesh 1 uses the same accessor as COLOR_0 (VEC3). */
function sharedFixture() {
  const bytes = Buffer.concat([floats(SHARED), floats([0, 0, 0, 1, 0, 0, 0, 1, 0])]);
  return {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: "shape", mesh: 0 }, { name: "tinted", mesh: 1 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { POSITION: 1, COLOR_0: 0 } }] },
    ],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [SHARED_FLOAT32[3], 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
    ],
  };
}

test("#235 P1: clamping a shared COLOR_0 accessor leaves its POSITION use unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-clamp-shared-"));
  try {
    const { asset: source } = await storeAssetObject(root, { bytes: Buffer.from(JSON.stringify(sharedFixture())), kind: "mesh", mediaType: "model/gltf+json" });
    const invocation = { inputs: { source }, parameters: { policy: { repairs: ["gltf-color-clamp-v1"] } } };
    const result = await executeGltfProductionImportOperation(root, invocation);
    const repairs = (result.observations as { repairs: { path: string; clampedComponentCount: number }[] }).repairs;
    assert.deepEqual(repairs.map(({ path, clampedComponentCount }) => ({ path, clampedComponentCount })), [
      { path: "/meshes/1/primitives/0/attributes/COLOR_0", clampedComponentCount: 1 },
    ]);
    const output = (result.outputs as { output: Parameters<typeof resolveAssetObject>[1] }).output;
    const document = await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, output)));
    const [shape, tinted] = document.getRoot().listMeshes();
    assert.deepEqual(Array.from(shape!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray()!), SHARED_FLOAT32);
    const color = Array.from(tinted!.listPrimitives()[0]!.getAttribute("COLOR_0")!.getArray()!);
    assert.deepEqual(color, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const analysis = await executeGltfAnalyzeOperation(root, invocation);
    assert.deepEqual((analysis.observations as { repairs: unknown[] }).repairs, repairs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
