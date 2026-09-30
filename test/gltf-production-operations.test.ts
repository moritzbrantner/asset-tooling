import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { NodeIO } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { executeGltfImportOperation } from "../src/gltf-import-operations.js";
import {
  GLTF_PRODUCTION_IMPORT_OPERATION,
  GLTF_ANALYZE_OPERATION,
  createGltfProductionImportOperationBuildIdentity,
  executeGltfProductionImportOperation,
  executeGltfAnalyzeOperation,
} from "../src/gltf-production-operations.js";

function riggedFixture() {
  const buffer = Buffer.alloc(324);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  positions.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  // Four influences per vertex; only joint 1 is active, with normalized weight 1.
  for (let vertex = 0; vertex < 3; vertex += 1) {
    buffer[36 + vertex * 4] = 1;
    buffer.writeFloatLE(1, 48 + vertex * 16);
  }
  // Joint order deliberately differs from node order and hierarchy order.
  for (let joint = 0; joint < 2; joint += 1) {
    for (const diagonal of [0, 5, 10, 15]) buffer.writeFloatLE(1, 96 + joint * 64 + diagonal * 4);
  }
  [0, 1].forEach((value, index) => buffer.writeFloatLE(value, 224 + index * 4));
  [0, 0, 0, 0, 2, 0].forEach((value, index) => buffer.writeFloatLE(value, 232 + index * 4));
  // NORMAL, three unit vectors, then unused padding (valid buffer can contain unused bytes).
  [0, 0, 1, 0, 0, 1, 0, 0, 1].forEach((value, index) => buffer.writeFloatLE(value, 256 + index * 4));
  return {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 3] }],
    nodes: [
      { name: "root", children: [1] },
      { name: "hips", children: [2] },
      { name: "hand" },
      { name: "body", mesh: 0, skin: 0 },
    ],
    meshes: [{ name: "body", primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, NORMAL: 6 } }] }],
    skins: [{ name: "rig", joints: [2, 1], skeleton: 1, inverseBindMatrices: 3 }],
    animations: [{ name: "walk", samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 },
      { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 128 },
      { buffer: 0, byteOffset: 224, byteLength: 8 }, { buffer: 0, byteOffset: 232, byteLength: 24 },
      { buffer: 0, byteOffset: 256, byteLength: 36 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5121, count: 3, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 2, type: "MAT4" },
      { bufferView: 4, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 5, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 6, componentType: 5126, count: 3, type: "VEC3" },
    ],
  };
}

async function workspace(document: unknown = riggedFixture()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-production-"));
  const { asset } = await storeAssetObject(root, { bytes: Buffer.from(JSON.stringify(document)), kind: "mesh", mediaType: "model/gltf+json" });
  return { root, source: asset };
}

test("versioned production import preserves joint order, weights, root/hips and clip values", async () => {
  const { root, source } = await workspace();
  try {
    assert.equal(GLTF_PRODUCTION_IMPORT_OPERATION.version, "2");
    assert.equal(GLTF_ANALYZE_OPERATION.id, "scene.analyze.gltf");
    await assert.rejects(executeGltfImportOperation(root, { inputs: { source } }), /skins or animations/);
    const invocation = { parameters: { policy: { requiredClipNames: ["walk"], maxTriangles: 1, maxJointsPerSkin: 2 } }, inputs: { source } };
    const identity = await createGltfProductionImportOperationBuildIdentity(root, invocation);
    assert.deepEqual(identity.operation, { id: "scene.import.gltf", version: "2" });
    const first = await executeGltfProductionImportOperation(root, invocation);
    assert.deepEqual(await executeGltfProductionImportOperation(root, invocation), first);
    const output = first.outputs.output;
    assert.ok(output && !Array.isArray(output));
    const document = await new NodeIO().readBinary(await resolveAssetObject(root, output));
    const skin = document.getRoot().listSkins()[0]!;
    assert.deepEqual(skin.listJoints().map((joint) => joint.getName()), ["hand", "hips"]);
    assert.equal(skin.getSkeleton()!.getName(), "hips");
    assert.equal(skin.listJoints()[1]!.getParentNode()!.getName(), "root");
    assert.deepEqual(Array.from(skin.getInverseBindMatrices()!.getArray()!), [...Array(2)].flatMap(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    const channel = document.getRoot().listAnimations()[0]!.listChannels()[0]!;
    assert.equal(channel.getTargetNode()!.getName(), "hips");
    assert.equal(channel.getTargetPath(), "translation");
    assert.deepEqual(Array.from(channel.getSampler()!.getInput()!.getArray()!), [0, 1]);
    assert.deepEqual(Array.from(channel.getSampler()!.getOutput()!.getArray()!), [0, 0, 0, 0, 2, 0]);
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    assert.deepEqual(Array.from(primitive.getAttribute("JOINTS_0")!.getArray()!), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    assert.equal(first.observations.skinCount, 1);
    assert.equal(first.observations.animationCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(!process.env.ASSET_TOOLING_BLENDER)("independent Blender pose oracle evaluates motion and rejects changed joint channels", async () => {
  const { root, source } = await workspace();
  try {
    const result = await executeGltfProductionImportOperation(root, { inputs: { source } });
    const output = result.outputs.output;
    assert.ok(output && !Array.isArray(output));
    const sourcePath = path.join(root, "source.gltf");
    const candidatePath = path.join(root, "candidate.glb");
    const reportPath = path.join(root, "poses.json");
    await writeFile(sourcePath, await resolveAssetObject(root, source));
    const candidate = await resolveAssetObject(root, output);
    await writeFile(candidatePath, candidate);
    const { version } = JSON.parse(await readFile(new URL("../adapters/blender/release.json", import.meta.url), "utf8"));
    const compare = () => spawnSync(process.env.ASSET_TOOLING_BLENDER!, [
      "--background", "--factory-startup", "--python-exit-code", "1", "--python",
      path.resolve(import.meta.dir, "../scripts/compare-gltf-poses.py"), "--",
      sourcePath, candidatePath, reportPath, version,
    ], { encoding: "utf8", timeout: 120_000 });
    const proof = compare();
    assert.equal(proof.status, 0, `${proof.error?.message ?? ""}\n${proof.stderr}\n${proof.stdout}`);
    const observations = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(observations.clipCount, 1);
    assert.equal(observations.poseCount, 6);
    assert.equal(observations.vertexComparisons, 18);
    // Independent fixture declares exactly two meters of hips translation. This
    // guards against an oracle that samples only rest pose or muted NLA strips.
    assert.ok(Math.abs(observations.maxSourceSampleMotionMeters - 2) < 1e-5);
    assert.ok(observations.maxWorldVertexErrorMeters <= 1e-5);
    const io = new NodeIO();
    const changed = await io.readBinary(candidate);
    changed.getRoot().listAnimations()[0]!.listChannels()[0]!.getSampler()!.getOutput()!
      .setArray(new Float32Array([0, 0, 0, 0, 1, 0]));
    await writeFile(candidatePath, await io.writeBinary(changed));
    const rejection = compare();
    assert.notEqual(rejection.status, 0);
    assert.match(`${rejection.stderr}\n${rejection.stdout}`, /world-space error/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

test("analysis reports production coverage and clip domains without writing objects", async () => {
  const { root, source } = await workspace();
  try {
    const before = await readdir(root, { recursive: true });
    const result = await executeGltfAnalyzeOperation(root, { inputs: { source } });
    assert.deepEqual(result.outputs, {});
    assert.deepEqual(result.observations.clips, [{ name: "walk", startSeconds: 0, endSeconds: 1, durationSeconds: 1, channels: [{ node: 1, path: "translation", interpolation: "LINEAR", keyframeCount: 2 }] }]);
    assert.deepEqual(result.observations.skins, [{ name: "rig", joints: [2, 1], skeleton: 1, inverseBindMatrixCount: 2 }]);
    assert.equal(result.observations.accepted, true);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production policy returns actionable paths and refuses unacceptable derived outputs", async () => {
  const { root, source } = await workspace();
  try {
    const invocation = { inputs: { source }, parameters: { policy: { requiredClipNames: ["idle"], maxJointsPerSkin: 1 } } };
    const before = await readdir(root, { recursive: true });
    const analysis = await executeGltfAnalyzeOperation(root, invocation);
    assert.equal(analysis.observations.accepted, false);
    assert.deepEqual(analysis.observations.diagnostics, [
      { path: "/skins/0", rule: "maxJointsPerSkin", message: "2 joints exceeds 1" },
      { path: "/animations", rule: "requiredClipNames", message: "missing clip 'idle'" },
    ]);
    await assert.rejects(executeGltfProductionImportOperation(root, invocation), /\/skins\/0.*missing clip 'idle'/);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
    await assert.rejects(executeGltfAnalyzeOperation(root, { inputs: { source }, parameters: { policy: { maxTriangles: -1 } } }), /maxTriangles/);
    await assert.rejects(executeGltfAnalyzeOperation(root, { inputs: { source }, parameters: { policy: { surprise: true } } }), /unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed joints, weights, bind matrices and animation channels fail closed", async () => {
  const cases: ((document: ReturnType<typeof riggedFixture>) => void)[] = [
    (document) => { document.skins[0]!.joints[0] = 99; },
    (document) => { document.accessors[3]!.count = 1; },
    (document) => { document.animations[0]!.channels[0]!.target.node = 99; },
    (document) => {
      const bytes = Buffer.from(document.buffers[0]!.uri.split(",")[1]!, "base64");
      bytes.writeFloatLE(-1, 48);
      document.buffers[0]!.uri = `data:application/octet-stream;base64,${bytes.toString("base64")}`;
    },
    (document) => {
      const bytes = Buffer.from(document.buffers[0]!.uri.split(",")[1]!, "base64");
      bytes.writeFloatLE(0, 228);
      document.buffers[0]!.uri = `data:application/octet-stream;base64,${bytes.toString("base64")}`;
    },
  ];
  for (const change of cases) {
    const document = riggedFixture(); change(document);
    const { root, source } = await workspace(document);
    try { await assert.rejects(executeGltfProductionImportOperation(root, { inputs: { source } })); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("source warnings require a supported explicit policy exception and remain in evidence", async () => {
  const document = riggedFixture();
  document.nodes[0]!.children = [1, 3];
  document.scenes[0]!.nodes = [0];
  const { root, source } = await workspace(document);
  try {
    await assert.rejects(executeGltfProductionImportOperation(root, { inputs: { source } }), /NODE_SKINNED_MESH_NON_ROOT/);
    const invocation = { inputs: { source }, parameters: { policy: { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT"] } } };
    const result = await executeGltfProductionImportOperation(root, invocation);
    assert.ok(Array.isArray(result.observations.validatorWarnings));
    assert.deepEqual(result.observations.validatorWarnings.map((warning) => {
      assert.ok(typeof warning === "object" && warning !== null && !Array.isArray(warning));
      return warning.code;
    }), ["NODE_SKINNED_MESH_NON_ROOT"]);
    await assert.rejects(executeGltfAnalyzeOperation(root, { inputs: { source }, parameters: { policy: { allowedValidatorWarnings: ["UNSUPPORTED_EXTENSION"] } } }), /only supports/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("triangle, normal and normal-map tangent policy checks inspect the actual source", async () => {
  const document = riggedFixture();
  Reflect.deleteProperty(document.meshes[0]!.primitives[0]!.attributes, "NORMAL");
  document.meshes.push({ ...document.meshes[0]!, name: "second-mesh" });
  const { root, source } = await workspace(document);
  try {
    const result = await executeGltfAnalyzeOperation(root, { inputs: { source }, parameters: { policy: { maxTriangles: 1, requireNormals: true } } });
    assert.equal(result.observations.accepted, false);
    assert.deepEqual(result.observations.diagnostics, [
      { path: "/meshes", rule: "maxTriangles", message: "2 triangles exceeds 1" },
      { path: "/meshes/0/primitives/0/attributes/NORMAL", rule: "requireNormals", message: "missing normals" },
      { path: "/meshes/1/primitives/0/attributes/NORMAL", rule: "requireNormals", message: "missing normals" },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }

  const normalMapped = riggedFixture();
  Object.assign(normalMapped, {
    images: [{ uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=" }],
    textures: [{ source: 0 }], materials: [{ normalTexture: { index: 0 } }],
  });
  normalMapped.bufferViews.push({ buffer: 0, byteOffset: 292, byteLength: 24 });
  normalMapped.accessors.push({ bufferView: 7, componentType: 5126, count: 3, type: "VEC2" });
  Object.assign(normalMapped.meshes[0]!.primitives[0]!, { material: 0 });
  Object.assign(normalMapped.meshes[0]!.primitives[0]!.attributes, { TEXCOORD_0: 7 });
  const mapped = await workspace(normalMapped);
  try {
    await assert.rejects(executeGltfAnalyzeOperation(mapped.root, { inputs: { source: mapped.source } }), /MESH_PRIMITIVE_GENERATED_TANGENT_SPACE/);
    const original = Buffer.from(normalMapped.buffers[0]!.uri.split(",")[1]!, "base64");
    const tangents = Buffer.alloc(48);
    [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1].forEach((value, index) => tangents.writeFloatLE(value, index * 4));
    const bytes = Buffer.concat([original, tangents]);
    normalMapped.buffers[0]!.byteLength = bytes.length;
    normalMapped.buffers[0]!.uri = `data:application/octet-stream;base64,${bytes.toString("base64")}`;
    normalMapped.bufferViews.push({ buffer: 0, byteOffset: original.length, byteLength: 48 });
    normalMapped.accessors.push({ bufferView: 8, componentType: 5126, count: 3, type: "VEC4" });
    Object.assign(normalMapped.meshes[0]!.primitives[0]!.attributes, { TANGENT: 8 });
    const { asset } = await storeAssetObject(mapped.root, { bytes: Buffer.from(JSON.stringify(normalMapped)), kind: "mesh", mediaType: "model/gltf+json" });
    const result = await executeGltfAnalyzeOperation(mapped.root, { inputs: { source: asset } });
    assert.equal(result.observations.accepted, true);
    assert.ok(Array.isArray(result.observations.materials));
    assert.deepEqual(result.observations.materials[0] && typeof result.observations.materials[0] === "object" && !Array.isArray(result.observations.materials[0]) && result.observations.materials[0].textures, [
      { slot: "normal", colorSpace: "linear", texture: 0, texCoord: 0, wrapS: 10497, wrapT: 10497, minFilter: null, magFilter: null },
    ]);
  } finally { await rm(mapped.root, { recursive: true, force: true }); }
});
