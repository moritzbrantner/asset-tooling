import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  createGltfAnalyzeOperationBuildIdentity,
  createGltfProductionImportOperationBuildIdentity,
  executeGltfAnalyzeOperation,
  executeGltfProductionImportOperation,
} from "../src/gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

// Independent acceptance tests for the owner-decided glTF import policies of
// #104 (owner comment 2026-10-14; docs/gltf-import.md, "Malformed-input
// diagnostics" -> "Policies for cases the validator alone does not settle").
// Every fixture is a small hand-authored glTF; none is produced by the code
// under test. Fixture builders are copied from test/gltf-malformed-inputs.test.ts.

type Json = Record<string, any>;
type Operation = "import@2" | "analyze@1";
type Resource = { uri: string; bytes: Buffer };
type PolicyWarning = { code: string; path: string; skin: number; joint: number; node: number; determinant: number };

const OPERATIONS: Operation[] = ["import@2", "analyze@1"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
const WEIGHT_POLICY = "gltf-weight-sum-tolerance-v1";
const WEIGHT_TOLERANCE = 1e-3;

function floats(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

function dataUri(bytes: Buffer, mediaType = "application/octet-stream"): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function bufferBytes(document: Json): Buffer {
  return Buffer.from(String(document.buffers[0].uri).split(",")[1]!, "base64");
}

function patchBuffer(document: Json, change: (bytes: Buffer) => void): void {
  const bytes = bufferBytes(document);
  change(bytes);
  document.buffers[0].uri = dataUri(bytes);
}

/** Appends `data` to buffer 0 as a new bufferView and accessor; returns the accessor index. */
function appendAccessor(document: Json, data: Buffer, accessor: Json): number {
  const bytes = bufferBytes(document);
  const offset = bytes.length;
  const next = Buffer.concat([bytes, data]);
  document.buffers[0] = { byteLength: next.length, uri: dataUri(next) };
  document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  document.accessors.push({ ...accessor, bufferView: document.bufferViews.length - 1 });
  return document.accessors.length - 1;
}

function staticFixture(): Json {
  const bytes = Buffer.concat([
    floats([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    floats([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    floats([0, 0, 1, 0, 0, 1]),
  ]);
  return {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "tile", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    materials: [{ name: "paint", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }],
    images: [{ uri: dataUri(PNG, "image/png") }],
    buffers: [{ byteLength: bytes.length, uri: dataUri(bytes) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
    ],
  };
}

// Rigged layout (byte offsets into the single buffer):
//   0 POSITION vec3 x3 | 36 JOINTS_0 u8 vec4 x3 | 48 WEIGHTS_0 f32 vec4 x3
//   96 inverse binds mat4 x2 | 224 clip times x2 | 232 translation vec3 x2 | 256 NORMAL vec3 x3
const WEIGHTS = 48;
const JOINTS = 36;
const IBM = 96;
const TIMES = 224;
const VALUES = 232;
const NORMALS = 256;

/** Two-joint skin (joints [2, 1]: joint 0 is node 2 "hand", joint 1 is node 1 "hips"), one LINEAR clip on the hips. */
function riggedFixture(): Json {
  const bytes = Buffer.alloc(292);
  floats([0, 0, 0, 1, 0, 0, 0, 1, 0]).copy(bytes, 0);
  for (let vertex = 0; vertex < 3; vertex += 1) {
    bytes[JOINTS + vertex * 4] = 1;
    bytes.writeFloatLE(1, WEIGHTS + vertex * 16);
  }
  for (let joint = 0; joint < 2; joint += 1) {
    for (const diagonal of [0, 5, 10, 15]) bytes.writeFloatLE(1, IBM + joint * 64 + diagonal * 4);
  }
  floats([0, 1]).copy(bytes, TIMES);
  floats([0, 0, 0, 0, 2, 0]).copy(bytes, VALUES);
  floats([0, 0, 1, 0, 0, 1, 0, 0, 1]).copy(bytes, NORMALS);
  return {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 3] }],
    nodes: [
      { name: "root", children: [1] },
      { name: "hips", children: [2] },
      { name: "hand" },
      { name: "body", mesh: 0, skin: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, NORMAL: 6 } }] }],
    skins: [{ name: "rig", joints: [2, 1], skeleton: 1, inverseBindMatrices: 3 }],
    animations: [{ name: "walk", samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }],
    buffers: [{ byteLength: bytes.length, uri: dataUri(bytes) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: JOINTS, byteLength: 12 },
      { buffer: 0, byteOffset: WEIGHTS, byteLength: 48 }, { buffer: 0, byteOffset: IBM, byteLength: 128 },
      { buffer: 0, byteOffset: TIMES, byteLength: 8 }, { buffer: 0, byteOffset: VALUES, byteLength: 24 },
      { buffer: 0, byteOffset: NORMALS, byteLength: 36 },
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

function glb(json: Json, bin?: Buffer): Buffer {
  const pad = (bytes: Buffer, fill: number) => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const chunks = [Buffer.alloc(8), jsonChunk];
  chunks[0]!.writeUInt32LE(jsonChunk.length, 0);
  chunks[0]!.writeUInt32LE(0x4e4f534a, 4);
  if (bin) {
    const binChunk = pad(bin, 0);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(binChunk.length, 0);
    header.writeUInt32LE(0x004e4942, 4);
    chunks.push(header, binChunk);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

function variant(base: () => Json, change: (document: Json) => void): Json {
  const document = base();
  change(document);
  return document;
}

async function workspace(document: Json | Buffer, resources: Resource[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-policies-"));
  const bytes = Buffer.isBuffer(document) ? document : Buffer.from(JSON.stringify(document));
  const mediaType = Buffer.isBuffer(document) ? "model/gltf-binary" : "model/gltf+json";
  const { asset } = await storeAssetObject(root, { bytes, kind: "scene", mediaType });
  const refs: AssetRef[] = [];
  for (const resource of resources) {
    refs.push((await storeAssetObject(root, { bytes: resource.bytes, kind: "buffer", mediaType: "application/octet-stream" })).asset);
  }
  const invocation = resources.length
    ? { parameters: { resourceUris: resources.map((resource) => resource.uri) }, inputs: { source: asset, resources: refs } }
    : { inputs: { source: asset } };
  return { root, invocation };
}

function run(operation: Operation, root: string, invocation: { inputs: unknown; parameters?: unknown }): Promise<AssetOperationResult> {
  return operation === "import@2" ? executeGltfProductionImportOperation(root, invocation) : executeGltfAnalyzeOperation(root, invocation);
}

/** Runs import@2 and analyze@1 on one workspace; import must store an output, analysis must accept. */
async function accepted(document: Json): Promise<{ imported: AssetOperationResult; analyzed: AssetOperationResult; output: Buffer }> {
  const { root, invocation } = await workspace(document);
  try {
    const imported = await run("import@2", root, invocation);
    const output = imported.outputs.output;
    assert.ok(output && !Array.isArray(output), "import@2 must store an output");
    const analyzed = await run("analyze@1", root, invocation);
    assert.equal(analyzed.observations.accepted, true, "analysis must report accepted: true");
    return { imported, analyzed, output: await resolveAssetObject(root, output) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Every operation rejects with a message matching all `expected` patterns and stores nothing. */
async function failClosed(document: Json | Buffer, expected: RegExp[], resources: Resource[] = [], forbidden: RegExp[] = []) {
  const { root, invocation } = await workspace(document, resources);
  try {
    for (const operation of OPERATIONS) {
      const before = (await readdir(root, { recursive: true })).sort();
      await assert.rejects(run(operation, root, invocation), (error: unknown) => {
        assert.ok(error instanceof Error, `${operation} must reject with an Error`);
        for (const pattern of expected) assert.match(error.message, pattern, `${operation} diagnostic was: ${error.message}`);
        for (const pattern of forbidden) assert.doesNotMatch(error.message, pattern, `${operation} diagnostic was: ${error.message}`);
        return true;
      }, `${operation} must reject`);
      assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, `${operation} must not store derived objects`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

function policyWarnings(result: AssetOperationResult): PolicyWarning[] {
  const value = (result.observations as Json).policyWarnings;
  return (value ?? []) as PolicyWarning[];
}

/** Overwrites the upper-left 3x3 block (column-major) of inverse bind matrix `joint`, keeping the affine last row. */
function setIbmBlock(document: Json, joint: number, block: [number, number, number, number, number, number, number, number, number]) {
  patchBuffer(document, (bytes) => {
    const base = IBM + joint * 64;
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 3; row += 1) bytes.writeFloatLE(block[column * 3 + row]!, base + (column * 4 + row) * 4);
    }
  });
}

function expectSingularWarning(result: AssetOperationResult, label: string, determinant: (value: number) => boolean) {
  const warnings = policyWarnings(result);
  assert.equal(warnings.length, 1, `${label}: exactly one policyWarnings entry, got ${JSON.stringify(warnings)}`);
  const warning = warnings[0]!;
  assert.deepEqual(Object.keys(warning).sort(), ["code", "determinant", "joint", "node", "path", "skin"], `${label}: documented fields`);
  assert.equal(warning.code, "SKIN_INVERSE_BIND_MATRIX_SINGULAR");
  assert.equal(warning.path, "/skins/0/inverseBindMatrices");
  assert.equal(warning.skin, 0);
  // Joint 0 of skin.joints [2, 1] is node 2: the entry must report position and node separately.
  assert.equal(warning.joint, 0);
  assert.equal(warning.node, 2);
  assert.equal(typeof warning.determinant, "number");
  assert.ok(determinant(warning.determinant), `${label}: unexpected determinant ${warning.determinant}`);
}

// --- 1. Singular inverse bind matrices: accepted with a warning ---

test("singular inverse bind matrix (zero 3x3 block) is stored and reported as one policy warning", async () => {
  const document = variant(riggedFixture, (doc) => setIbmBlock(doc, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const { imported, analyzed, output } = await accepted(document);
  expectSingularWarning(imported, "import@2", (value) => Math.abs(value) === 0);
  expectSingularWarning(analyzed, "analyze@1", (value) => Math.abs(value) === 0);
  // Source data is never changed: the stored matrix keeps the zero block.
  const skin = (await new NodeIO().readBinary(output)).getRoot().listSkins()[0]!;
  const stored = Array.from(skin.getInverseBindMatrices()!.getArray()!);
  assert.deepEqual(stored.slice(0, 16).map((value) => Math.abs(value)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test("inverse bind determinant at or below 1e-12 is singular; just above it is not", async () => {
  // det(diag(1, 1, d)) = d; float32 keeps these values within ~1e-7 relative error.
  const below = variant(riggedFixture, (doc) => setIbmBlock(doc, 0, [1, 0, 0, 0, 1, 0, 0, 0, 5e-13]));
  const { imported, analyzed } = await accepted(below);
  const close = (value: number) => Math.abs(value - Math.fround(5e-13)) <= 1e-18;
  expectSingularWarning(imported, "import@2 det 5e-13", close);
  expectSingularWarning(analyzed, "analyze@1 det 5e-13", close);

  const above = variant(riggedFixture, (doc) => setIbmBlock(doc, 0, [1, 0, 0, 0, 1, 0, 0, 0, 2e-12]));
  const regular = await accepted(above);
  assert.deepEqual(policyWarnings(regular.imported), [], "import@2: det 2e-12 is above the threshold");
  assert.deepEqual(policyWarnings(regular.analyzed), [], "analyze@1: det 2e-12 is above the threshold");
});

test("regular inverse bind matrices produce no policy warning", async () => {
  // A non-identity but well-conditioned block (rotation about z plus scale 2).
  const document = variant(riggedFixture, (doc) => setIbmBlock(doc, 1, [0, 2, 0, -2, 0, 0, 0, 0, 2]));
  const { imported, analyzed } = await accepted(document);
  assert.deepEqual(policyWarnings(imported), []);
  assert.deepEqual(policyWarnings(analyzed), []);
  const baseline = await accepted(riggedFixture());
  assert.deepEqual(policyWarnings(baseline.imported), []);
  assert.deepEqual(policyWarnings(baseline.analyzed), []);
});

// --- 2. Joint weight sums: named tolerance 1e-3, never renormalized ---

function weightSums(result: AssetOperationResult): { policy: string; tolerance: number; maxAbsoluteDrift: number } {
  const value = (result.observations as Json).weightSums;
  assert.ok(value && typeof value === "object", `observations.weightSums missing: ${JSON.stringify(value)}`);
  return value;
}

test("weight-sum drift of 5e-4 is accepted, reported under the named policy and stored without renormalization", async () => {
  const document = variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => bytes.writeFloatLE(0.9995, WEIGHTS + 16)));
  const sourceWeights = Array.from(new Float32Array(Uint8Array.from(bufferBytes(document).subarray(WEIGHTS, WEIGHTS + 48)).buffer));
  const { imported, analyzed, output } = await accepted(document);
  const drift = 1 - Math.fround(0.9995);
  for (const [label, result] of [["import@2", imported], ["analyze@1", analyzed]] as const) {
    const sums = weightSums(result);
    assert.equal(sums.policy, WEIGHT_POLICY, label);
    assert.equal(sums.tolerance, WEIGHT_TOLERANCE, label);
    assert.ok(Math.abs(sums.maxAbsoluteDrift - drift) <= 1e-6, `${label}: maxAbsoluteDrift ${sums.maxAbsoluteDrift}, expected about ${drift}`);
  }
  const primitive = (await new NodeIO().readBinary(output)).getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  const stored = primitive.getAttribute("WEIGHTS_0")!;
  assert.equal(stored.getComponentType(), 5126, "float weights stay float");
  assert.deepEqual(Array.from(stored.getArray()!), sourceWeights, "weights must not be renormalized");
});

test("exactly normalized weights report zero drift under the named policy", async () => {
  const { imported, analyzed } = await accepted(riggedFixture());
  for (const result of [imported, analyzed]) {
    const sums = weightSums(result);
    assert.equal(sums.policy, WEIGHT_POLICY);
    assert.equal(sums.tolerance, WEIGHT_TOLERANCE);
    assert.equal(sums.maxAbsoluteDrift, 0);
  }
});

test("weight-sum drift of 2e-3 fails both operations naming the attribute, rule, vertex and sum", async () => {
  const attribute = /\/meshes\/0\/primitives\/0\/attributes\/WEIGHTS_0: WEIGHTS_SUM_OUT_OF_TOLERANCE/;
  // The production operations treat the validator's check as superseded by the named tolerance.
  const superseded = [/ACCESSOR_WEIGHTS_NON_NORMALIZED/];
  // Below 1: vertex 1 sums to 0.998.
  await failClosed(variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => bytes.writeFloatLE(0.998, WEIGHTS + 16))),
    [attribute, /vertex\D{0,4}1\b/, /0\.998/], [], superseded);
  // Above 1: vertex 2 sums to 1.002 through a second, distinct joint.
  await failClosed(variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => {
    bytes[JOINTS + 2 * 4 + 1] = 0;
    bytes.writeFloatLE(0.002, WEIGHTS + 2 * 16 + 4);
  })), [attribute, /vertex\D{0,4}2\b/, /1\.002/], [], superseded);
  // Far outside the tolerance too (the former ACCESSOR_WEIGHTS_NON_NORMALIZED cases).
  await failClosed(variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => bytes.writeFloatLE(0.5, WEIGHTS))),
    [attribute, /vertex\D{0,4}0\b/, /0\.5/], [], superseded);
});

test("negative and nonfinite weights keep their validator diagnostics", async () => {
  // Negative weight with the sum still exactly 1, so only the sign is wrong.
  await failClosed(variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => {
    bytes[JOINTS + 1] = 0;
    bytes.writeFloatLE(1.5, WEIGHTS);
    bytes.writeFloatLE(-0.5, WEIGHTS + 4);
  })), [/\/meshes\/0\/primitives\/0\/attributes\/WEIGHTS_0: ACCESSOR_WEIGHTS_NEGATIVE/]);
  await failClosed(variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => bytes.writeFloatLE(Number.NaN, WEIGHTS))),
    [/\/accessors\/2: ACCESSOR_INVALID_FLOAT/]);
  await failClosed(variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => bytes.writeFloatLE(Infinity, WEIGHTS))),
    [/\/accessors\/2: ACCESSOR_INVALID_FLOAT/]);
});

// --- 3. Animation evidence: unused samplers and single-keyframe channels ---

test("unused samplers and single-keyframe channels are accepted and listed per clip", async () => {
  const document = variant(riggedFixture, (doc) => {
    const time = appendAccessor(doc, floats([0.5]), { componentType: 5126, count: 1, type: "SCALAR", min: [0.5], max: [0.5] });
    const value = appendAccessor(doc, floats([0, 1, 0]), { componentType: 5126, count: 1, type: "VEC3" });
    const animation = doc.animations[0];
    // Sampler 1: one keyframe, used by channel 1 on the hand. Sampler 2: referenced by no channel.
    animation.samplers.push({ input: time, output: value, interpolation: "STEP" });
    animation.samplers.push({ input: 4, output: 5, interpolation: "LINEAR" });
    animation.channels.push({ sampler: 1, target: { node: 2, path: "translation" } });
  });
  // Import must store the asset; the doc places the per-clip lists in the analysis.
  const { analyzed } = await accepted(document);
  const clips = (analyzed.observations as Json).clips as Json[];
  assert.equal(clips.length, 1);
  assert.deepEqual(clips[0]!.unusedSamplers, [2], "unusedSamplers");
  assert.deepEqual(clips[0]!.singleKeyframeChannels, [1], "singleKeyframeChannels");
  const baseline = (await accepted(riggedFixture())).analyzed;
  const clip = ((baseline.observations as Json).clips as Json[])[0]!;
  assert.deepEqual(clip.unusedSamplers, []);
  assert.deepEqual(clip.singleKeyframeChannels, []);
});

// --- 4. GLB external resources name their pointer, code and URI ---

/** Static fixture without its texture, so a GLB variant has no data-URI image. */
function untexturedFixture(): Json {
  const json = staticFixture();
  Reflect.deleteProperty(json.materials[0].pbrMetallicRoughness, "baseColorTexture");
  for (const key of ["textures", "samplers", "images"]) Reflect.deleteProperty(json, key);
  return json;
}

test("GLB external buffer and image fail with pointer, GLB_EXTERNAL_RESOURCE and the URI", async () => {
  // "pointer: CODE" like the other malformed-input diagnostics (owner decision 4 on #104).
  const json = untexturedFixture();
  const bytes = bufferBytes(json);
  json.buffers[0].uri = "geometry/tile.bin";
  const buffer = [/\/buffers\/0\/uri: GLB_EXTERNAL_RESOURCE/, /geometry\/tile\.bin/, /external buffer/];
  await failClosed(glb(json), buffer);
  await failClosed(glb(json), buffer, [{ uri: "geometry/tile.bin", bytes }]);

  const imageJson = staticFixture();
  const bin = bufferBytes(imageJson);
  Reflect.deleteProperty(imageJson.buffers[0], "uri");
  imageJson.images[0].uri = "textures/paint.png";
  const image = [/\/images\/0\/uri: GLB_EXTERNAL_RESOURCE/, /textures\/paint\.png/, /external image/];
  await failClosed(glb(imageJson, bin), image);
  await failClosed(glb(imageJson, bin), image, [{ uri: "textures/paint.png", bytes: PNG }]);
});

// --- 5. Build identity records implementation version 2 and the weight-sum policy ---

test("@2 and analysis build identities use production implementation version 2 recording the weight-sum policy", async () => {
  const { root, invocation } = await workspace(riggedFixture());
  try {
    for (const identity of [
      await createGltfProductionImportOperationBuildIdentity(root, invocation),
      await createGltfAnalyzeOperationBuildIdentity(root, invocation),
    ]) {
      const implementation = identity.implementation as Json;
      assert.equal(implementation.id, "gltf-transform-production");
      assert.equal(implementation.version, "2", "production implementation version 2");
      const text = JSON.stringify(implementation);
      assert.ok(text.includes(WEIGHT_POLICY), `implementation identity must name ${WEIGHT_POLICY}: ${text}`);
      assert.ok(/(^|[^0-9.])(0\.001|1e-3)([^0-9]|$)/.test(text), `implementation identity must record the tolerance 1e-3: ${text}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unused sampler outside the channels' time range does not widen the clip's timing", async () => {
  // Regression (PR #195 review): only channel-referenced samplers define a clip's domain.
  const document = variant(riggedFixture, (doc) => {
    const time = appendAccessor(doc, floats([100, 200]), { componentType: 5126, count: 2, type: "SCALAR", min: [100], max: [200] });
    const value = appendAccessor(doc, floats([0, 0, 0, 0, 1, 0]), { componentType: 5126, count: 2, type: "VEC3" });
    doc.animations[0].samplers.push({ input: time, output: value, interpolation: "LINEAR" });
  });
  const { imported, analyzed } = await accepted(document);
  for (const [label, result] of [["import@2", imported], ["analyze@1", analyzed]] as const) {
    const clip = ((result.observations as Json).clips as Json[])[0]!;
    assert.equal(clip.startSeconds, 0, `${label}: startSeconds`);
    assert.equal(clip.endSeconds, 1, `${label}: endSeconds`);
    assert.equal(clip.durationSeconds, 1, `${label}: durationSeconds`);
  }
  const clip = ((analyzed.observations as Json).clips as Json[])[0]!;
  assert.deepEqual(clip.unusedSamplers, [1], "the out-of-range sampler is still listed");
});

test("corrupted GLB headers report the header problem, not GLB_EXTERNAL_RESOURCE", async () => {
  // Regression (PR #195 review): the external-resource check must only trust a well-formed GLB
  // header; otherwise the real container problem is masked as GLB_EXTERNAL_RESOURCE.
  const json = untexturedFixture();
  json.buffers[0].uri = "geometry/tile.bin";
  const valid = glb(json);
  const cases: [string, (bytes: Buffer) => void, RegExp][] = [
    ["wrong magic", (bytes) => bytes.writeUInt32LE(0x46546c68, 0), /GLB_INVALID_MAGIC|well-formed GLB container/],
    ["version 1", (bytes) => bytes.writeUInt32LE(1, 4), /GLB_INVALID_VERSION|well-formed GLB container/],
    ["declared length too long", (bytes) => bytes.writeUInt32LE(valid.length + 4, 8), /GLB_LENGTH_MISMATCH|GLB_LENGTH_TOO_SMALL|well-formed GLB container/],
  ];
  const failures: string[] = [];
  for (const [name, change, expected] of cases) {
    const corrupted = Buffer.from(valid);
    change(corrupted);
    try { await failClosed(corrupted, [expected], [], [/GLB_EXTERNAL_RESOURCE/]); }
    catch (error) { failures.push(`${name}: ${(error as Error).message.split("\n")[0]}`); }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  // The well-formed container with the same external URI still names the external resource.
  await failClosed(valid, [/\/buffers\/0\/uri: GLB_EXTERNAL_RESOURCE/, /geometry\/tile\.bin/]);
});

/** Rigged fixture whose skinned primitive has `vertexCount` non-indexed vertices, each with weights from `weightsOf`. */
function manyVertexRig(vertexCount: number, weightsOf: (vertex: number) => { joints: number[]; weights: number[] }): Json {
  const document = riggedFixture();
  const positions: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const triangle = Math.floor(vertex / 3);
    const corner = vertex % 3;
    positions.push(triangle + (corner === 1 ? 1 : 0), corner === 2 ? 1 : 0, 0);
  }
  const joints = Buffer.alloc(vertexCount * 4);
  const weights: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const influence = weightsOf(vertex);
    influence.joints.forEach((joint, slot) => { joints[vertex * 4 + slot] = joint; });
    weights.push(...[0, 1, 2, 3].map((slot) => influence.weights[slot] ?? 0));
  }
  const attributes = document.meshes[0].primitives[0].attributes;
  attributes.POSITION = appendAccessor(document, floats(positions), {
    componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, 0], max: [Math.floor((vertexCount - 1) / 3) + 1, 1, 0],
  });
  attributes.JOINTS_0 = appendAccessor(document, joints, { componentType: 5121, count: vertexCount, type: "VEC4" });
  attributes.WEIGHTS_0 = appendAccessor(document, floats(weights), { componentType: 5126, count: vertexCount, type: "VEC4" });
  attributes.NORMAL = appendAccessor(document, floats(Array.from({ length: vertexCount }, () => [0, 0, 1]).flat()), { componentType: 5126, count: vertexCount, type: "VEC3" });
  return document;
}

test("tolerated weight drift on more than 100 vertices does not exhaust the validator issue limit", async () => {
  // Regression (PR #195 review): superseded ACCESSOR_WEIGHTS_NON_NORMALIZED entries must not fill the
  // validator's 100-issue report and reject the asset before the named tolerance is applied.
  const document = manyVertexRig(150, () => ({ joints: [1], weights: [0.9995] }));
  const { imported, analyzed } = await accepted(document);
  const drift = 1 - Math.fround(0.9995);
  for (const [label, result] of [["import@2", imported], ["analyze@1", analyzed]] as const) {
    const sums = weightSums(result);
    assert.equal(sums.policy, WEIGHT_POLICY, label);
    assert.ok(Math.abs(sums.maxAbsoluteDrift - drift) <= 1e-6, `${label}: maxAbsoluteDrift ${sums.maxAbsoluteDrift}`);
  }
});

test("a genuine weight error is still reported among many tolerated drifts", async () => {
  // One negative weight (sum still 1) at vertex 120, after 120 vertices with tolerated drift.
  const document = manyVertexRig(150, (vertex) => vertex === 120
    ? { joints: [1, 0], weights: [1.5, -0.5] }
    : { joints: [1], weights: [0.9995] });
  await failClosed(document, [/\/meshes\/0\/primitives\/0\/attributes\/WEIGHTS_0: ACCESSOR_WEIGHTS_NEGATIVE/], [], [/ACCESSOR_WEIGHTS_NON_NORMALIZED/]);
});
