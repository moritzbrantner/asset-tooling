import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { storeAssetObject } from "../src/asset-store.js";
import { executeGltfImportOperation } from "../src/gltf-import-operations.js";
import { executeGltfAnalyzeOperation, executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

// Independent malformed-input acceptance fixtures for #104. Every fixture is a
// small hand-authored glTF; none is produced by the processor under test. Each
// case mutates one known-good fixture and must fail closed: the operation rejects
// with an actionable diagnostic (validator code or policy message plus asset
// path) and the object store is left byte-for-byte unchanged. Analysis must not
// claim acceptance of malformed input (docs/gltf-import.md, "Production import
// and analysis").

// Loose JSON view: fixtures are deliberately mutated into invalid shapes.
type Json = Record<string, any>;
type Operation = "import@1" | "import@2" | "analyze@1";
type Resource = { uri: string; bytes: Buffer };

const STATIC_OPERATIONS: Operation[] = ["import@1", "import@2", "analyze@1"];
const RIGGED_OPERATIONS: Operation[] = ["import@2", "analyze@1"];
// 1x1 RGBA PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");

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

/** Textured static triangle: POSITION, NORMAL, TEXCOORD_0 and one sampled baseColor texture. */
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

/** Two-joint skin, one LINEAR translation clip on the hips joint. */
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

/** Moves the data-URI buffer and image of a JSON fixture into one GLB BIN chunk. */
function selfContainedGlb(json: Json): Buffer {
  const geometry = bufferBytes(json);
  const bin = Buffer.concat([geometry, PNG]);
  Reflect.deleteProperty(json.buffers[0], "uri");
  json.buffers[0].byteLength = bin.length;
  json.bufferViews.push({ buffer: 0, byteOffset: geometry.length, byteLength: PNG.length });
  json.images[0] = { bufferView: json.bufferViews.length - 1, mimeType: "image/png" };
  return glb(json, bin);
}

/** Minimal GLB container: JSON chunk plus optional BIN chunk. */
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

async function workspace(source: Buffer, mediaType: string, resources: Resource[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-malformed-"));
  const { asset } = await storeAssetObject(root, { bytes: source, kind: "scene", mediaType });
  const refs: AssetRef[] = [];
  for (const resource of resources) {
    refs.push((await storeAssetObject(root, { bytes: resource.bytes, kind: "buffer", mediaType: "application/octet-stream" })).asset);
  }
  return { root, source: asset, resources: refs };
}

function run(operation: Operation, root: string, invocation: { inputs: unknown; parameters?: unknown }): Promise<AssetOperationResult> {
  if (operation === "import@1") return executeGltfImportOperation(root, invocation);
  if (operation === "import@2") return executeGltfProductionImportOperation(root, invocation);
  return executeGltfAnalyzeOperation(root, invocation);
}

type Options = { mediaType?: string; resources?: Resource[] };

function encode(document: Json | Buffer, options: Options) {
  return Buffer.isBuffer(document)
    ? { bytes: document, mediaType: options.mediaType ?? "model/gltf-binary" }
    : { bytes: Buffer.from(JSON.stringify(document)), mediaType: options.mediaType ?? "model/gltf+json" };
}

/** Every listed operation must reject with `expected` and leave the workspace unchanged. */
async function expectFailClosed(document: Json | Buffer, operations: Operation[], expected: RegExp, options: Options = {}) {
  const { bytes, mediaType } = encode(document, options);
  const resources = options.resources ?? [];
  const { root, source, resources: refs } = await workspace(bytes, mediaType, resources);
  try {
    const invocation = resources.length
      ? { parameters: { resourceUris: resources.map((resource) => resource.uri) }, inputs: { source, resources: refs } }
      : { inputs: { source } };
    for (const operation of operations) {
      const before = (await readdir(root, { recursive: true })).sort();
      await assert.rejects(run(operation, root, invocation), (error: unknown) => {
        assert.ok(error instanceof Error, `${operation} must reject with an Error`);
        assert.match(error.message, expected, `${operation} diagnostic was: ${error.message}`);
        return true;
      }, `${operation} must reject`);
      assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, `${operation} must not store derived objects`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Sanity: the unmutated fixtures are accepted, so each rejection is caused by its single mutation. */
async function expectAccepted(document: Json | Buffer, operations: Operation[], options: Options = {}) {
  const { bytes, mediaType } = encode(document, options);
  const resources = options.resources ?? [];
  const { root, source, resources: refs } = await workspace(bytes, mediaType, resources);
  try {
    const invocation = resources.length
      ? { parameters: { resourceUris: resources.map((resource) => resource.uri) }, inputs: { source, resources: refs } }
      : { inputs: { source } };
    for (const operation of operations) {
      const result = await run(operation, root, invocation);
      if (operation === "analyze@1") assert.equal(result.observations.accepted, true);
      else assert.ok(result.outputs.output);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Runs every case and reports all failing case names together, so one defect does not hide another. */
async function eachCase<T extends readonly [string, ...unknown[]]>(label: string, cases: T[], check: (entry: T) => Promise<void>) {
  const failures: string[] = [];
  for (const entry of cases) {
    try { await check(entry); }
    catch (error) { failures.push(`${label} '${entry[0]}': ${(error as Error).message.split("\n")[0]}`); }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
}

function variant(base: () => Json, change: (document: Json) => void): Json {
  const document = base();
  change(document);
  return document;
}

test("baseline malformed-input fixtures are themselves accepted", async () => {
  await expectAccepted(staticFixture(), STATIC_OPERATIONS);
  await expectAccepted(riggedFixture(), RIGGED_OPERATIONS);
  const external = staticFixture();
  const bytes = bufferBytes(external);
  external.buffers[0].uri = "geometry/tile.bin";
  external.images[0].uri = "textures/paint.png";
  await expectAccepted(external, STATIC_OPERATIONS, { resources: [{ uri: "geometry/tile.bin", bytes }, { uri: "textures/paint.png", bytes: PNG }] });
  await expectAccepted(selfContainedGlb(staticFixture()), STATIC_OPERATIONS);
});

// --- Malformed references beyond the existing v1 `nodes[0].mesh = 99` case ---

test("malformed index references fail closed with the offending JSON pointer", async () => {
  const cases: [string, (document: Json) => void, RegExp][] = [
    ["scene node", (document) => { document.scenes[0].nodes = [99]; }, /\/scenes\/0\/nodes\/0: UNRESOLVED_REFERENCE/],
    ["primitive attribute accessor", (document) => { document.meshes[0].primitives[0].attributes.NORMAL = 99; }, /\/meshes\/0\/primitives\/0\/attributes\/NORMAL: UNRESOLVED_REFERENCE/],
    ["accessor bufferView", (document) => { document.accessors[1].bufferView = 99; }, /\/accessors\/1\/bufferView: UNRESOLVED_REFERENCE/],
    ["bufferView buffer", (document) => { document.bufferViews[1].buffer = 99; }, /\/bufferViews\/1\/buffer: UNRESOLVED_REFERENCE/],
    ["primitive material", (document) => { document.meshes[0].primitives[0].material = 99; }, /\/meshes\/0\/primitives\/0\/material: UNRESOLVED_REFERENCE/],
    ["node child", (document) => { document.nodes[0].children = [99]; }, /\/nodes\/0\/children\/0: UNRESOLVED_REFERENCE/],
    ["node self-cycle", (document) => { document.nodes[0].children = [0]; }, /\/nodes\/0: NODE_LOOP/],
  ];
  await eachCase("malformed reference", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(staticFixture, change), STATIC_OPERATIONS, expected);
  });
  // Skin reference on a node is only reachable through the rigged (v2) profile.
  await expectFailClosed(variant(riggedFixture, (document) => { document.nodes[3].skin = 99; }), RIGGED_OPERATIONS, /\/nodes\/3\/skin: UNRESOLVED_REFERENCE/);
});

// --- Nonfinite values beyond the existing v1 NaN POSITION case ---

test("nonfinite payloads in normals, weights, bind matrices, clip times and values fail closed", async () => {
  const cases: [string, number, RegExp][] = [
    ["NORMAL Infinity", NORMALS, /\/accessors\/6: ACCESSOR_INVALID_FLOAT/],
    ["WEIGHTS_0 NaN", WEIGHTS, /\/accessors\/2: ACCESSOR_INVALID_FLOAT/],
    ["inverse bind NaN", IBM + 12 * 4, /\/accessors\/3: ACCESSOR_INVALID_FLOAT/],
    ["clip time NaN", TIMES + 4, /\/accessors\/4: ACCESSOR_INVALID_FLOAT/],
    ["clip value -Infinity", VALUES + 4, /\/accessors\/5: ACCESSOR_INVALID_FLOAT/],
  ];
  await eachCase("nonfinite", cases, async ([name, offset, expected]) => {
    const value = name.includes("-Infinity") ? -Infinity : name.includes("Infinity") ? Infinity : Number.NaN;
    const document = variant(riggedFixture, (doc) => patchBuffer(doc, (bytes) => bytes.writeFloatLE(value, offset)));
    await expectFailClosed(document, RIGGED_OPERATIONS, expected);
  });
  // JSON cannot encode Infinity; serializers emit null, which must not silently become a default transform.
  await expectFailClosed(variant(staticFixture, (document) => { document.nodes[0].translation = [0, null, 0]; }), STATIC_OPERATIONS, /\/nodes\/0\/translation: ARRAY_TYPE_MISMATCH/);
});

// --- Skin weights and joints (the existing v2 test covers a negative weight, joint node 99 and IBM count) ---

test("skin weight integrity violations fail closed", async () => {
  const cases: [string, (bytes: Buffer) => void, RegExp][] = [
    ["all-zero weights", (bytes) => bytes.writeFloatLE(0, WEIGHTS), /\/meshes\/0\/primitives\/0\/attributes\/WEIGHTS_0: ACCESSOR_WEIGHTS_NON_NORMALIZED/],
    ["weights sum to 0.5", (bytes) => bytes.writeFloatLE(0.5, WEIGHTS), /\/meshes\/0\/primitives\/0\/attributes\/WEIGHTS_0: ACCESSOR_WEIGHTS_NON_NORMALIZED/],
    ["weights sum to 1.5", (bytes) => bytes.writeFloatLE(0.5, WEIGHTS + 4), /\/meshes\/0\/primitives\/0\/attributes\/WEIGHTS_0: ACCESSOR_WEIGHTS_NON_NORMALIZED/],
  ];
  await eachCase("weights", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(riggedFixture, (document) => patchBuffer(document, change)), RIGGED_OPERATIONS, expected);
  });
});

test("skin joint index and attribute-set violations fail closed", async () => {
  const cases: [string, (document: Json) => void, RegExp][] = [
    ["JOINTS_0 index beyond skin.joints", (document) => patchBuffer(document, (bytes) => { bytes[JOINTS] = 2; }), /\/meshes\/0\/primitives\/0\/attributes\/JOINTS_0: ACCESSOR_JOINTS_INDEX_OOB/],
    ["duplicate weighted joint", (document) => patchBuffer(document, (bytes) => {
      bytes[JOINTS + 1] = 1;
      bytes.writeFloatLE(0.5, WEIGHTS);
      bytes.writeFloatLE(0.5, WEIGHTS + 4);
    }), /\/meshes\/0\/primitives\/0\/attributes\/JOINTS_0: ACCESSOR_JOINTS_INDEX_DUPLICATE/],
    ["JOINTS_0 without WEIGHTS_0", (document) => { Reflect.deleteProperty(document.meshes[0].primitives[0].attributes, "WEIGHTS_0"); }, /\/meshes\/0\/primitives\/0\/attributes: MESH_PRIMITIVE_JOINTS_WEIGHTS_MISMATCH/],
    ["skeleton is not a common root of the joints", (document) => { document.skins[0].skeleton = 2; }, /\/skins\/0\/skeleton: SKIN_SKELETON_INVALID/],
    ["joints without a common root", (document) => { document.skins[0].joints = [2, 3]; }, /\/skins\/0\/joints: SKIN_NO_COMMON_ROOT/],
    ["empty skin joints", (document) => { document.skins[0].joints = []; }, /\/skins\/0\/joints: EMPTY_ENTITY/],
    ["skinned node whose mesh has no influences", (document) => {
      const attributes = document.meshes[0].primitives[0].attributes;
      Reflect.deleteProperty(attributes, "JOINTS_0");
      Reflect.deleteProperty(attributes, "WEIGHTS_0");
    }, /\/nodes\/3: NODE_SKIN_WITH_NON_SKINNED_MESH/],
  ];
  await eachCase("joints", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(riggedFixture, change), RIGGED_OPERATIONS, expected);
  });
});

// Baseline defect (2026-10-14): the Khronos validator throws a non-Error Dart
// TypeError for FLOAT joint indices, so the operations reject without any
// actionable message. Expected per #104 ("actionable asset/path diagnostics") and
// docs/gltf-import.md (malformed inputs fail validation): an Error naming JOINTS_0.
test("float JOINTS_0 accessor fails closed with an actionable diagnostic", async () => {
  const document = variant(riggedFixture, (doc) => {
    doc.accessors[1].componentType = 5126;
    doc.bufferViews[1] = { buffer: 0, byteOffset: WEIGHTS, byteLength: 48 };
  });
  await expectFailClosed(document, RIGGED_OPERATIONS, /\/meshes\/0\/primitives\/0\/attributes\/JOINTS_0/);
});

test("malformed inverse bind matrices fail closed", async () => {
  const cases: [string, (document: Json) => void, RegExp][] = [
    ["non-affine last row", (document) => patchBuffer(document, (bytes) => bytes.writeFloatLE(1, IBM + 3 * 4)), /\/skins\/0\/inverseBindMatrices: ACCESSOR_INVALID_IBM/],
    ["VEC4 accessor", (document) => { document.accessors[3].type = "VEC4"; document.accessors[3].count = 8; }, /\/skins\/0\/inverseBindMatrices: SKIN_IBM_INVALID_FORMAT/],
  ];
  await eachCase("inverse binds", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(riggedFixture, change), RIGGED_OPERATIONS, expected);
  });
});

// --- Animation targets and times (the existing v2 test covers target node 99 and equal times) ---

test("malformed animation targets and samplers fail closed", async () => {
  const cases: [string, (document: Json) => void, RegExp][] = [
    ["unknown target path", (document) => { document.animations[0].channels[0].target.path = "color"; }, /\/animations\/0\/channels\/0\/target\/path: VALUE_NOT_IN_LIST/],
    ["weights path without morph targets", (document) => { document.animations[0].channels[0].target.path = "weights"; }, /\/animations\/0\/channels\/0\/target: ANIMATION_CHANNEL_TARGET_NODE_WEIGHTS_NO_MORPHS/],
    ["clip targets the skinned mesh node", (document) => { document.animations[0].channels[0].target.node = 3; }, /\/animations\/0\/channels\/0\/target\/path: ANIMATION_CHANNEL_TARGET_NODE_SKIN/],
    ["empty clip", (document) => { document.animations[0].channels = []; document.animations[0].samplers = []; }, /\/animations\/0\/channels: EMPTY_ENTITY/],
    ["channel sampler reference", (document) => { document.animations[0].channels[0].sampler = 99; }, /\/animations\/0\/channels\/0\/sampler: UNRESOLVED_REFERENCE/],
    ["duplicate channel target", (document) => { document.animations[0].channels.push({ sampler: 0, target: { node: 1, path: "translation" } }); }, /\/animations\/0\/channels\/0\/target: ANIMATION_DUPLICATE_TARGETS/],
    ["rotation path with VEC3 output", (document) => { document.animations[0].channels[0].target.path = "rotation"; }, /\/animations\/0\/channels\/0\/sampler: ANIMATION_SAMPLER_OUTPUT_ACCESSOR_INVALID_FORMAT/],
    ["input/output count mismatch", (document) => { document.accessors[5].count = 1; }, /\/animations\/0\/channels\/0\/sampler: ANIMATION_SAMPLER_OUTPUT_ACCESSOR_INVALID_COUNT/],
    ["CUBICSPLINE without tangents", (document) => { document.animations[0].samplers[0].interpolation = "CUBICSPLINE"; }, /\/animations\/0\/channels\/0\/sampler: ANIMATION_SAMPLER_OUTPUT_ACCESSOR_INVALID_COUNT/],
    ["input without min/max bounds", (document) => { Reflect.deleteProperty(document.accessors[4], "min"); Reflect.deleteProperty(document.accessors[4], "max"); }, /\/animations\/0\/samplers\/0\/input: ANIMATION_SAMPLER_INPUT_ACCESSOR_WITHOUT_BOUNDS/],
  ];
  await eachCase("animation", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(riggedFixture, change), RIGGED_OPERATIONS, expected);
  });
});

test("malformed animation key times fail closed", async () => {
  const cases: [string, (document: Json) => void, RegExp][] = [
    ["decreasing times", (document) => { patchBuffer(document, (bytes) => floats([1, 0]).copy(bytes, TIMES)); document.accessors[4].min = [0]; document.accessors[4].max = [1]; }, /\/animations\/0\/samplers\/0\/input: ACCESSOR_ANIMATION_INPUT_NON_INCREASING/],
    ["negative start time", (document) => { patchBuffer(document, (bytes) => bytes.writeFloatLE(-1, TIMES)); document.accessors[4].min = [-1]; }, /\/animations\/0\/samplers\/0\/input: ACCESSOR_ANIMATION_INPUT_NEGATIVE/],
    ["declared bounds disagree with times", (document) => { document.accessors[4].max = [2]; }, /\/accessors\/4\/max\/0: ACCESSOR_MAX_MISMATCH/],
  ];
  await eachCase("times", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(riggedFixture, change), RIGGED_OPERATIONS, expected);
  });
});

// --- Material resources ---

test("malformed material texture, image and sampler references fail closed", async () => {
  const cases: [string, (document: Json) => void, RegExp][] = [
    ["baseColor texture", (document) => { document.materials[0].pbrMetallicRoughness.baseColorTexture.index = 99; }, /\/materials\/0\/pbrMetallicRoughness\/baseColorTexture\/index: UNRESOLVED_REFERENCE/],
    ["texture image source", (document) => { document.textures[0].source = 99; }, /\/textures\/0\/source: UNRESOLVED_REFERENCE/],
    ["texture sampler", (document) => { document.textures[0].sampler = 99; }, /\/textures\/0\/sampler: UNRESOLVED_REFERENCE/],
    ["texCoord without that UV set", (document) => { document.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord = 1; }, /\/meshes\/0\/primitives\/0\/material: MESH_PRIMITIVE_TOO_FEW_TEXCOORDS/],
    ["textured material without any UV set", (document) => { Reflect.deleteProperty(document.meshes[0].primitives[0].attributes, "TEXCOORD_0"); }, /\/meshes\/0\/primitives\/0\/material: MESH_PRIMITIVE_TOO_FEW_TEXCOORDS/],
    ["image bytes are not an image", (document) => { document.images[0].uri = dataUri(Buffer.from("not a png"), "image/png"); }, /\/images\/0(\/uri)?: (INVALID_URI|IMAGE_UNRECOGNIZED_FORMAT)/],
    ["image declares neither uri nor bufferView", (document) => { Reflect.deleteProperty(document.images[0], "uri"); }, /\/images\/0: ONE_OF_MISMATCH/],
    ["sampler wrap enum", (document) => { document.samplers[0].wrapS = 1; }, /\/samplers\/0\/wrapS: VALUE_NOT_IN_LIST/],
  ];
  await eachCase("material", cases, async ([, change, expected]) => {
    await expectFailClosed(variant(staticFixture, change), STATIC_OPERATIONS, expected);
  });
});

// --- Required vs merely-used extensions (existing v1 case: extensionsUsed KHR_materials_unlit) ---

test("unsupported required extensions fail closed for every operation", async () => {
  const draco = variant(staticFixture, (document) => {
    document.extensionsUsed = ["KHR_draco_mesh_compression"];
    document.extensionsRequired = ["KHR_draco_mesh_compression"];
  });
  await expectFailClosed(draco, STATIC_OPERATIONS, /unsupported extensions at \/extensionsUsed/);
  // A required extension glTF Transform itself understands is still outside this profile.
  const transform = variant(staticFixture, (document) => {
    document.extensionsUsed = ["KHR_texture_transform"];
    document.extensionsRequired = ["KHR_texture_transform"];
    document.materials[0].pbrMetallicRoughness.baseColorTexture.extensions = { KHR_texture_transform: { scale: [2, 2] } };
  });
  await expectFailClosed(transform, STATIC_OPERATIONS, /unsupported extensions/);
  // Required but not declared as used is itself structurally invalid.
  await expectFailClosed(variant(staticFixture, (document) => { document.extensionsRequired = ["KHR_draco_mesh_compression"]; }), STATIC_OPERATIONS, /\/extensionsRequired\/0: UNUSED_EXTENSION_REQUIRED/);
  await expectFailClosed(variant(riggedFixture, (document) => {
    document.extensionsUsed = ["KHR_mesh_quantization"];
    document.extensionsRequired = ["KHR_mesh_quantization"];
  }), RIGGED_OPERATIONS, /unsupported extensions/);
});

test("merely used optional extensions are rejected rather than silently dropped by v2 and analysis", async () => {
  const used = variant(riggedFixture, (document) => {
    document.extensionsUsed = ["KHR_materials_emissive_strength"];
    document.materials = [{ emissiveFactor: [1, 1, 1], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 4 } } }];
    document.meshes[0].primitives[0].material = 0;
  });
  await expectFailClosed(used, RIGGED_OPERATIONS, /unsupported extensions at \/extensionsUsed/);
  // Extension payload on an object without a top-level declaration.
  await expectFailClosed(variant(staticFixture, (document) => {
    document.nodes[0].extensions = { EXT_vendor_private: { flag: true } };
  }), STATIC_OPERATIONS, /\/nodes\/0\/extensions\/EXT_vendor_private: UNDECLARED_EXTENSION/);
});

// --- Missing and external resources (existing: missing v1 buffer binding, hash tamper, URI escapes) ---

test("missing external buffers and images fail closed for v2 and analysis too", async () => {
  const buffer = variant(staticFixture, (document) => { document.buffers[0].uri = "geometry/tile.bin"; });
  await expectFailClosed(buffer, ["import@2", "analyze@1"], /missing glTF resource 'geometry\/tile.bin'/);
  const image = variant(staticFixture, (document) => { document.images[0].uri = "textures/paint.png"; });
  await expectFailClosed(image, STATIC_OPERATIONS, /missing glTF resource 'textures\/paint.png'/);
  // A binding for a different path does not satisfy the missing one, and is reported.
  await expectFailClosed(image, STATIC_OPERATIONS, /missing glTF resource .textures\/paint.png./, { resources: [{ uri: "textures/other.png", bytes: PNG }] });
});

test("external resources whose bytes contradict the source fail closed", async () => {
  const document = variant(staticFixture, (doc) => { doc.buffers[0].uri = "geometry/tile.bin"; });
  const bytes = bufferBytes(staticFixture());
  await expectFailClosed(document, STATIC_OPERATIONS, /\/buffers\/0: BUFFER_BYTE_LENGTH_MISMATCH/, { resources: [{ uri: "geometry/tile.bin", bytes: bytes.subarray(0, 48) }] });
  const image = variant(staticFixture, (doc) => { doc.images[0].uri = "textures/paint.png"; });
  await expectFailClosed(image, STATIC_OPERATIONS, /\/images\/0: IMAGE_UNRECOGNIZED_FORMAT/, { resources: [{ uri: "textures/paint.png", bytes: Buffer.from("not a png") }] });
});

// Baseline defect (2026-10-14): a JSON glTF buffer with neither uri nor GLB
// chunk crashes with "undefined is not an object (evaluating 'a.buffer')".
// Expected: a validation diagnostic naming /buffers/0 (BUFFER_MISSING_GLB_DATA).
test("JSON glTF buffer without any data fails closed with an actionable diagnostic", async () => {
  await expectFailClosed(variant(staticFixture, (document) => { Reflect.deleteProperty(document.buffers[0], "uri"); }), STATIC_OPERATIONS, /\/buffers\/0/);
});

test("malformed buffer data URIs fail closed", async () => {
  await expectFailClosed(variant(staticFixture, (document) => {
    document.buffers[0].uri = dataUri(bufferBytes(document).subarray(0, 40));
  }), STATIC_OPERATIONS, /\/buffers\/0: BUFFER_BYTE_LENGTH_MISMATCH/);
  await expectFailClosed(variant(staticFixture, (document) => {
    document.buffers[0].uri = "data:application/octet-stream;base64,@@not-base64@@";
  }), STATIC_OPERATIONS, /\/buffers\/0\/uri: INVALID_URI/);
});

/** Static fixture without its texture, so a GLB variant has no data-URI image. */
function untexturedFixture(): Json {
  const json = staticFixture();
  Reflect.deleteProperty(json.materials[0].pbrMetallicRoughness, "baseColorTexture");
  for (const key of ["textures", "samplers", "images"]) Reflect.deleteProperty(json, key);
  return json;
}

test("GLB sources must be self-contained even when an external binding is supplied", async () => {
  // docs/gltf-import.md: "GLB inputs must be self-contained".
  const json = untexturedFixture();
  const bytes = bufferBytes(json);
  json.buffers[0].uri = "geometry/tile.bin";
  await expectFailClosed(glb(json), STATIC_OPERATIONS, /external buffers/);
  await expectFailClosed(glb(json), STATIC_OPERATIONS, /external buffers/, { resources: [{ uri: "geometry/tile.bin", bytes }] });
  const imageJson = staticFixture();
  const bin = bufferBytes(imageJson);
  Reflect.deleteProperty(imageJson.buffers[0], "uri");
  imageJson.images[0].uri = "textures/paint.png";
  await expectFailClosed(glb(imageJson, bin), STATIC_OPERATIONS, /external images/, { resources: [{ uri: "textures/paint.png", bytes: PNG }] });
});

test("GLB declared-length damage fails closed", async () => {
  const valid = selfContainedGlb(staticFixture());
  const wrongLength = Buffer.from(valid);
  wrongLength.writeUInt32LE(valid.length + 4, 8);
  await expectFailClosed(wrongLength, STATIC_OPERATIONS, /\/: GLB_LENGTH_MISMATCH/);
});

// Baseline defect (2026-10-14): a GLB whose BIN chunk is cut short is rejected
// with a bare "Length out of range of buffer" from the decoder, which names
// neither the container nor the damaged chunk. Expected per #104 ("actionable
// asset/path diagnostics"): a diagnostic identifying the GLB container/chunk,
// e.g. the validator's GLB_* codes.
test("truncated GLB fails closed with an actionable diagnostic", async () => {
  const valid = selfContainedGlb(staticFixture());
  await expectFailClosed(valid.subarray(0, valid.length - 8), STATIC_OPERATIONS, /GLB/);
});
