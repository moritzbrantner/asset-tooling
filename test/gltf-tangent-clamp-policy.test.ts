/// <reference path="../src/gltf-validator.d.ts" />
import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { GLTF_IMPORT_OPERATION, createGltfImportOperationBuildIdentity, executeGltfImportOperation } from "../src/gltf-import-operations.js";
import * as production from "../src/gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

// Independent acceptance for #118 slice 1 (owner decisions Q1 (a) and Q2 (a), 2026-10-14):
//  - Q1: `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` (normal-mapped primitive without TANGENT) is
//    accepted only through the explicit, named `policy.allowedValidatorWarnings` exception and is
//    recorded for source and output. No tangents are generated; imports stay exactly replayable.
//  - Q2: `policy.repairs: ["gltf-color-clamp-v1"]` clamps COLOR_n float components that are outside
//    [0, 1] by at most 2e-4, records each repaired attribute, and fails with a located
//    `COLOR_CLAMP_EXCESS_OUT_OF_BOUND` diagnostic beyond the bound.
// `scene.import.gltf@1` stays strict. Every fixture is a small hand-authored glTF; none is produced
// by the code under test. Fixture helpers follow test/gltf-import-policies.test.ts.

type Json = Record<string, any>;
type Operation = "import@2" | "analyze@1";
type Repair = { repair: string; path: string; clampedComponentCount: number; maxExcess: number };
type Invocation = { inputs: unknown; parameters?: unknown };

const TANGENT_WARNING = "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE";
const SKIN_WARNING = "NODE_SKINNED_MESH_NON_ROOT";
const CLAMP = "gltf-color-clamp-v1";
const CLAMP_BOUND = 2e-4;
const OPERATIONS: Operation[] = ["import@2", "analyze@1"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");

// Accessed through the namespace so this file type-checks before the export exists.
const productionModule = production as unknown as Record<string, unknown>;
const {
  GLTF_PRODUCTION_IMPORT_OPERATION, GLTF_ANALYZE_OPERATION,
  createGltfAnalyzeOperationBuildIdentity, createGltfProductionImportOperationBuildIdentity,
  executeGltfAnalyzeOperation, executeGltfProductionImportOperation,
} = production;

// ------------------------------------------------------------------ fixture helpers

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

/** Appends `data` to buffer 0 as a new bufferView and accessor; returns the accessor index. */
function appendAccessor(document: Json, data: Buffer, accessor: Json): number {
  const bytes = bufferBytes(document);
  const offset = bytes.length;
  const next = Buffer.concat([bytes, data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  document.buffers[0] = { byteLength: next.length, uri: dataUri(next) };
  document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  document.accessors.push({ ...accessor, bufferView: document.bufferViews.length - 1 });
  return document.accessors.length - 1;
}

/** One textured triangle: POSITION, NORMAL, TEXCOORD_0 and a base-color texture. Validates cleanly. */
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

/** The static triangle with a normal map and no TANGENT attribute (Q1's source shape). */
function normalMappedFixture(): Json {
  const document = staticFixture();
  document.materials[0].normalTexture = { index: 0, scale: 0.75 };
  return document;
}

/** Adds a float COLOR_n accessor (VEC4 by default) to primitive 0 of mesh 0. */
function withColor(document: Json, values: number[], options: { semantic?: string; type?: "VEC3" | "VEC4"; mesh?: number; primitive?: number } = {}): Json {
  const accessor = appendAccessor(document, floats(values), { componentType: 5126, count: values.length / (options.type === "VEC3" ? 3 : 4), type: options.type ?? "VEC4" });
  document.meshes[options.mesh ?? 0].primitives[options.primitive ?? 0].attributes[options.semantic ?? "COLOR_0"] = accessor;
  return document;
}

/** Two components out of range within the bound (1.0001 and -0.00015); all others in range. */
const NEAR_RANGE_COLORS = [1.0001, 0.5, 0.25, 1, 0, 1, -0.00015, 1, 0.999, 0.001, 0.75, 0];

function coloredFixture(values = NEAR_RANGE_COLORS): Json {
  return withColor(staticFixture(), values);
}

/**
 * Two meshes; mesh 1 has two primitives sharing geometry. COLOR accessors: mesh 0 prim 0 COLOR_0,
 * mesh 1 prim 0 COLOR_0, mesh 1 prim 1 COLOR_0 and COLOR_1 — each distinct.
 */
function multiPrimitiveFixture(colors: { m0p0: number[]; m1p0: number[]; m1p1c0: number[]; m1p1c1: number[] }): Json {
  const document = staticFixture();
  document.nodes.push({ name: "second", mesh: 1, translation: [2, 0, 0] });
  document.scenes[0].nodes = [0, 1];
  const attributes = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 };
  document.meshes.push({ primitives: [{ attributes: { ...attributes }, material: 0 }, { attributes: { ...attributes }, material: 0 }] });
  withColor(document, colors.m0p0);
  withColor(document, colors.m1p0, { mesh: 1, primitive: 0 });
  withColor(document, colors.m1p1c0, { mesh: 1, primitive: 1 });
  withColor(document, colors.m1p1c1, { mesh: 1, primitive: 1, semantic: "COLOR_1" });
  return document;
}

/** Rigged triangle whose skinned mesh node is not a scene root, optionally normal-mapped. */
function nonRootSkinnedFixture(normalMapped: boolean): Json {
  const bytes = Buffer.alloc(316);
  floats([0, 0, 0, 1, 0, 0, 0, 1, 0]).copy(bytes, 0);
  for (let vertex = 0; vertex < 3; vertex += 1) {
    bytes[36 + vertex * 4] = 1;
    bytes.writeFloatLE(1, 48 + vertex * 16);
  }
  for (let joint = 0; joint < 2; joint += 1) {
    for (const diagonal of [0, 5, 10, 15]) bytes.writeFloatLE(1, 96 + joint * 64 + diagonal * 4);
  }
  floats([0, 1]).copy(bytes, 224);
  floats([0, 0, 0, 0, 2, 0]).copy(bytes, 232);
  floats([0, 0, 1, 0, 0, 1, 0, 0, 1]).copy(bytes, 256);
  floats([0, 0, 1, 0, 0, 1]).copy(bytes, 292);
  const document: Json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { name: "root", children: [1, 3] },
      { name: "hips", children: [2] },
      { name: "hand" },
      { name: "body", mesh: 0, skin: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, NORMAL: 6, TEXCOORD_0: 7 } }] }],
    skins: [{ name: "rig", joints: [2, 1], skeleton: 1, inverseBindMatrices: 3 }],
    animations: [{ name: "walk", samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }],
    buffers: [{ byteLength: bytes.length, uri: dataUri(bytes) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 },
      { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 128 },
      { buffer: 0, byteOffset: 224, byteLength: 8 }, { buffer: 0, byteOffset: 232, byteLength: 24 },
      { buffer: 0, byteOffset: 256, byteLength: 36 }, { buffer: 0, byteOffset: 292, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5121, count: 3, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 2, type: "MAT4" },
      { bufferView: 4, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 5, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 6, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 7, componentType: 5126, count: 3, type: "VEC2" },
    ],
  };
  if (normalMapped) {
    Object.assign(document, { images: [{ uri: dataUri(PNG, "image/png") }], textures: [{ source: 0 }], materials: [{ normalTexture: { index: 0 } }] });
    document.meshes[0].primitives[0].material = 0;
  }
  return document;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function workspace(document: Json) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-tangent-clamp-"));
  const bytes = Buffer.from(JSON.stringify(document));
  const { asset } = await storeAssetObject(root, { bytes, kind: "mesh", mediaType: "model/gltf+json" });
  return { root, source: asset, bytes };
}

function invocation(source: AssetRef, policy?: Json): Invocation {
  return policy === undefined ? { inputs: { source } } : { inputs: { source }, parameters: { policy } };
}

function run(operation: Operation, root: string, value: Invocation): Promise<AssetOperationResult> {
  return operation === "import@2" ? executeGltfProductionImportOperation(root, value) : executeGltfAnalyzeOperation(root, value);
}

async function listing(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String).sort();
}

/** Every operation rejects with a message matching all `expected` patterns and stores nothing. */
async function failClosed(document: Json, policy: Json | undefined, expected: RegExp[], operations: Operation[] = OPERATIONS) {
  const { root, source } = await workspace(document);
  try {
    for (const operation of operations) {
      const before = await listing(root);
      await assert.rejects(run(operation, root, invocation(source, policy)), (error: unknown) => {
        assert.ok(error instanceof Error, `${operation} must reject with an Error`);
        for (const pattern of expected) assert.match(error.message, pattern, `${operation} diagnostic was: ${error.message}`);
        return true;
      }, `${operation} must reject`);
      assert.deepEqual(await listing(root), before, `${operation} must not store derived objects`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

/**
 * Bound violations must fail closed. Import must reject and store nothing. Analysis must either
 * reject with the same located diagnostic or report `accepted: false` with a diagnostic at the
 * attribute path that names the code (the weight-sum precedent rejects; either form is accepted
 * here because the decision does not fix analysis's failure form).
 */
async function failsBound(document: Json, policy: Json, attributePath: string) {
  const located = new RegExp(`${attributePath.replaceAll("/", "\\/")}\\b[\\s\\S]*COLOR_CLAMP_EXCESS_OUT_OF_BOUND|COLOR_CLAMP_EXCESS_OUT_OF_BOUND[\\s\\S]*${attributePath.replaceAll("/", "\\/")}\\b`);
  await failClosed(document, policy, [located], ["import@2"]);
  const { root, source } = await workspace(document);
  try {
    const before = await listing(root);
    let analyzed: AssetOperationResult | undefined;
    try { analyzed = await run("analyze@1", root, invocation(source, policy)); }
    catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, located, `analyze@1 diagnostic was: ${error.message}`);
    }
    if (analyzed) {
      assert.equal(analyzed.observations.accepted, false, "analyze@1 must not accept an out-of-bound color");
      const diagnostics = analyzed.observations.diagnostics as Json[];
      assert.ok(diagnostics.some((diagnostic) => diagnostic.path === attributePath && /COLOR_CLAMP_EXCESS_OUT_OF_BOUND/.test(JSON.stringify(diagnostic))),
        `analyze@1 diagnostics must locate ${attributePath}: ${JSON.stringify(diagnostics)}`);
    }
    assert.deepEqual(await listing(root), before, "analyze@1 must not store derived objects");
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Runs import@2 and analyze@1 with `policy`; import must store an output, analysis must accept and write nothing. */
async function accepted(document: Json, policy: Json | undefined) {
  const { root, source, bytes } = await workspace(document);
  try {
    const imported = await run("import@2", root, invocation(source, policy));
    const output = imported.outputs.output;
    assert.ok(output && !Array.isArray(output), "import@2 must store an output");
    const before = await listing(root);
    const analyzed = await run("analyze@1", root, invocation(source, policy));
    assert.equal(analyzed.observations.accepted, true, "analysis must report accepted: true");
    assert.deepEqual(analyzed.outputs, {}, "analysis has no outputs");
    assert.deepEqual(await listing(root), before, "analysis must write no objects");
    const outputBytes = await resolveAssetObject(root, output);
    // The stored source object is never modified by a repair.
    assert.ok(Buffer.from(await resolveAssetObject(root, source)).equals(bytes), "stored source bytes must be unchanged");
    assert.equal(source.sha256, sha256(bytes));
    return { imported, analyzed, output: outputBytes };
  } finally { await rm(root, { recursive: true, force: true }); }
}

function warningCodes(result: AssetOperationResult, field: "validatorWarnings" | "outputValidatorWarnings"): string[] {
  const value = (result.observations as Json)[field];
  assert.ok(Array.isArray(value), `observations.${field} must be an array: ${JSON.stringify(value)}`);
  return value.map((warning: Json) => warning.code).sort();
}

function repairs(result: AssetOperationResult): Repair[] {
  const value = (result.observations as Json).repairs;
  assert.ok(Array.isArray(value), `observations.repairs must be an array: ${JSON.stringify(value)}`);
  for (const entry of value) {
    assert.deepEqual(Object.keys(entry).sort(), ["clampedComponentCount", "maxExcess", "path", "repair"], `repair entry fields: ${JSON.stringify(entry)}`);
  }
  return value as Repair[];
}

async function primitiveOf(glb: Uint8Array, mesh = 0, primitive = 0) {
  return (await new NodeIO().readBinary(glb)).getRoot().listMeshes()[mesh]!.listPrimitives()[primitive]!;
}

async function validatorCodes(glb: Uint8Array): Promise<{ errors: number; codes: string[] }> {
  const report = await validateBytes(glb, {
    format: "glb", writeTimestamp: false, maxIssues: 0,
    externalResourceFunction: async (uri) => { throw new Error(`unexpected external resource ${uri}`); },
  });
  return { errors: report.issues.numErrors, codes: report.issues.messages.map((issue) => issue.code) };
}

function clampedExpectation(values: number[]): { values: number[]; count: number; maxExcess: number } {
  let count = 0, maxExcess = 0;
  const clamped = values.map((value) => {
    const f = Math.fround(value);
    const excess = f > 1 ? f - 1 : f < 0 ? -f : 0;
    if (excess > 0) count += 1;
    maxExcess = Math.max(maxExcess, excess);
    return Math.min(1, Math.max(0, f));
  });
  return { values: clamped, count, maxExcess };
}

function assertRepair(entry: Repair | undefined, path: string, values: number[], label: string) {
  const expected = clampedExpectation(values);
  assert.ok(entry, `${label}: missing repair for ${path}`);
  assert.equal(entry.repair, CLAMP, label);
  assert.equal(entry.path, path, label);
  assert.equal(entry.clampedComponentCount, expected.count, `${label}: clampedComponentCount`);
  assert.ok(Math.abs(entry.maxExcess - expected.maxExcess) <= 1e-9, `${label}: maxExcess ${entry.maxExcess}, expected ${expected.maxExcess}`);
  assert.ok(entry.maxExcess > 0 && entry.maxExcess <= CLAMP_BOUND, `${label}: maxExcess within (0, ${CLAMP_BOUND}]`);
}

// ------------------------------------------------- Q1: named tangent-space warning exception

test("descriptors declare the tangent exception and the color clamp repair for @2 and analysis only", () => {
  for (const descriptor of [GLTF_PRODUCTION_IMPORT_OPERATION, GLTF_ANALYZE_OPERATION]) {
    const policy = (descriptor.parameterSchema as Json).properties.policy;
    assert.deepEqual([...policy.properties.allowedValidatorWarnings.items.enum].sort(), [TANGENT_WARNING, SKIN_WARNING].sort(), `${descriptor.id}: allowedValidatorWarnings enum`);
    assert.ok(policy.properties.repairs, `${descriptor.id}: policy.repairs declared`);
    assert.deepEqual(policy.properties.repairs.items.enum, [CLAMP], `${descriptor.id}: repairs enum`);
    assert.equal(policy.properties.repairs.uniqueItems, true, `${descriptor.id}: repairs unique`);
  }
  const v1 = GLTF_IMPORT_OPERATION.parameterSchema as Json;
  assert.deepEqual(Object.keys(v1.properties), ["resourceUris"], "scene.import.gltf@1 parameters are unchanged");
});

test("without the exception a normal-mapped primitive lacking TANGENT still fails @2 and analysis", async () => {
  const located = [/\/meshes\/0\/primitives\/0\/material: MESH_PRIMITIVE_GENERATED_TANGENT_SPACE/];
  await failClosed(normalMappedFixture(), undefined, located);
  await failClosed(normalMappedFixture(), { allowedValidatorWarnings: [] }, located);
  await failClosed(normalMappedFixture(), { allowedValidatorWarnings: [SKIN_WARNING] }, located);
  // A color repair is not a warning exception.
  await failClosed(normalMappedFixture(), { repairs: [CLAMP] }, located);
});

test("the tangent exception imports without generating tangents and records the warning for source and output", async () => {
  const document = normalMappedFixture();
  const policy = { allowedValidatorWarnings: [TANGENT_WARNING] };
  const { imported, analyzed, output } = await accepted(document, policy);
  assert.deepEqual(warningCodes(imported, "validatorWarnings"), [TANGENT_WARNING], "source evidence");
  assert.deepEqual(warningCodes(imported, "outputValidatorWarnings"), [TANGENT_WARNING], "output evidence");
  assert.deepEqual(warningCodes(analyzed, "validatorWarnings"), [TANGENT_WARNING], "analysis evidence");
  const warning = ((imported.observations as Json).validatorWarnings as Json[])[0]!;
  assert.equal(warning.path, "/meshes/0/primitives/0/material", "source warning keeps its pointer");
  assert.deepEqual((imported.observations as Json).policy.allowedValidatorWarnings, [TANGENT_WARNING], "declared exception is in evidence");

  const primitive = await primitiveOf(output);
  assert.equal(primitive.getAttribute("TANGENT"), null, "no TANGENT attribute is generated");
  assert.deepEqual(primitive.listSemantics().sort(), ["NORMAL", "POSITION", "TEXCOORD_0"]);
  const material = primitive.getMaterial()!;
  assert.ok(material.getNormalTexture(), "the normal map is preserved");
  assert.equal(material.getNormalScale(), 0.75);
  const source = bufferBytes(document);
  assert.deepEqual(Array.from(primitive.getAttribute("POSITION")!.getArray()!), Array.from(new Float32Array(Uint8Array.from(source.subarray(0, 36)).buffer)));
  assert.deepEqual(Array.from(primitive.getAttribute("NORMAL")!.getArray()!), Array.from(new Float32Array(Uint8Array.from(source.subarray(36, 72)).buffer)));
  const independent = await validatorCodes(output);
  assert.equal(independent.errors, 0);
  assert.ok(independent.codes.includes(TANGENT_WARNING), "the output still lacks tangents, so the validator still warns");
});

test("the tangent exception is exactly replayable", async () => {
  const policy = { allowedValidatorWarnings: [TANGENT_WARNING] };
  const { root, source } = await workspace(normalMappedFixture());
  try {
    const first = await executeGltfProductionImportOperation(root, invocation(source, policy));
    const second = await executeGltfProductionImportOperation(root, invocation(source, policy));
    assert.deepEqual(second, first, "repeated import is identical");
    const out1 = await resolveAssetObject(root, first.outputs.output as AssetRef);
    const other = await workspace(normalMappedFixture());
    try {
      const third = await executeGltfProductionImportOperation(other.root, invocation(other.source, policy));
      assert.ok(Buffer.from(await resolveAssetObject(other.root, third.outputs.output as AssetRef)).equals(Buffer.from(out1)), "byte-identical in a fresh store");
    } finally { await rm(other.root, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the tangent exception combines with the skinned-mesh exception and does not waive it", async () => {
  const both = [SKIN_WARNING, TANGENT_WARNING];
  for (const order of [both, [...both].reverse()]) {
    const { imported, analyzed, output } = await accepted(nonRootSkinnedFixture(true), { allowedValidatorWarnings: order });
    assert.deepEqual(warningCodes(imported, "validatorWarnings"), [...both].sort(), `source evidence for ${order.join(",")}`);
    assert.ok(warningCodes(imported, "outputValidatorWarnings").includes(TANGENT_WARNING), "output evidence records the tangent warning");
    assert.deepEqual(warningCodes(analyzed, "validatorWarnings"), [...both].sort());
    assert.equal((await primitiveOf(output)).getAttribute("TANGENT"), null);
  }
  // Each exception covers only its own code.
  await failClosed(nonRootSkinnedFixture(true), { allowedValidatorWarnings: [TANGENT_WARNING] }, [/NODE_SKINNED_MESH_NON_ROOT/]);
  await failClosed(nonRootSkinnedFixture(true), { allowedValidatorWarnings: [SKIN_WARNING] }, [/MESH_PRIMITIVE_GENERATED_TANGENT_SPACE/]);
  // The tangent exception alone on a document without that warning is harmless.
  const plain = await accepted(staticFixture(), { allowedValidatorWarnings: [TANGENT_WARNING] });
  assert.deepEqual(warningCodes(plain.imported, "validatorWarnings"), []);
});

test("other validator errors still fail when the tangent exception is declared", async () => {
  const document = normalMappedFixture();
  const bytes = bufferBytes(document);
  bytes.writeFloatLE(Number.NaN, 0);
  document.buffers[0].uri = dataUri(bytes);
  await failClosed(document, { allowedValidatorWarnings: [TANGENT_WARNING] }, [/\/accessors\/0: ACCESSOR_INVALID_FLOAT/]);
  // A color error is not waived by a warning exception either.
  await failClosed(withColor(normalMappedFixture(), NEAR_RANGE_COLORS), { allowedValidatorWarnings: [TANGENT_WARNING] },
    [/\/meshes\/0\/primitives\/0\/attributes\/COLOR_0: ACCESSOR_NON_CLAMPED/]);
});

test("unsupported warning codes and malformed exception lists are still rejected", async () => {
  const { root, source } = await workspace(staticFixture());
  try {
    const cases: unknown[] = [
      ["ACCESSOR_NON_CLAMPED"], ["UNUSED_OBJECT"], ["UNSUPPORTED_EXTENSION"], ["mesh_primitive_generated_tangent_space"],
      [TANGENT_WARNING, "UNUSED_OBJECT"], [TANGENT_WARNING, TANGENT_WARNING], [SKIN_WARNING, TANGENT_WARNING, "UNUSED_OBJECT"],
      TANGENT_WARNING, [1],
    ];
    for (const allowedValidatorWarnings of cases) {
      const value = invocation(source, { allowedValidatorWarnings });
      for (const operation of OPERATIONS) await assert.rejects(run(operation, root, value), `${operation} must reject ${JSON.stringify(allowedValidatorWarnings)}`);
      await assert.rejects(createGltfProductionImportOperationBuildIdentity(root, value), `identity must reject ${JSON.stringify(allowedValidatorWarnings)}`);
      await assert.rejects(createGltfAnalyzeOperationBuildIdentity(root, value));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- scene.import.gltf@1 unchanged

test("scene.import.gltf@1 stays strict: rejects missing tangents, non-clamped colors and any policy", async () => {
  for (const [document, code] of [
    [normalMappedFixture(), /MESH_PRIMITIVE_GENERATED_TANGENT_SPACE/],
    [coloredFixture(), /\/meshes\/0\/primitives\/0\/attributes\/COLOR_0: ACCESSOR_NON_CLAMPED/],
  ] as const) {
    const { root, source } = await workspace(document);
    try {
      const before = await listing(root);
      await assert.rejects(executeGltfImportOperation(root, { inputs: { source } }), code);
      for (const policy of [{ allowedValidatorWarnings: [TANGENT_WARNING] }, { repairs: [CLAMP] }]) {
        await assert.rejects(executeGltfImportOperation(root, { inputs: { source }, parameters: { policy } }), /unknown field 'policy'/);
        await assert.rejects(createGltfImportOperationBuildIdentity(root, { inputs: { source }, parameters: { policy } }), /unknown field 'policy'/);
      }
      assert.deepEqual(await listing(root), before, "v1 stores nothing");
      const identity = await createGltfImportOperationBuildIdentity(root, { inputs: { source } });
      assert.deepEqual(identity.parameters, { resourceUris: [] }, "v1 identity parameters unchanged");
      assert.ok(!JSON.stringify(identity.implementation).includes(CLAMP), "v1 implementation identity has no clamp policy");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

// ------------------------------------------------------------ Q2: bounded color clamp repair

test("GLTF_COLOR_CLAMP_REPAIR is exported with the owner-decided bound", () => {
  assert.deepEqual(productionModule.GLTF_COLOR_CLAMP_REPAIR, { repair: CLAMP, maxExcess: CLAMP_BOUND });
  assert.ok(Object.isFrozen(productionModule.GLTF_COLOR_CLAMP_REPAIR), "the policy constant is frozen like GLTF_WEIGHT_SUM_POLICY");
});

test("repairs default to [] in build identity, declaring the clamp changes identity, and the bound is an implementation policy", async () => {
  const { root, source } = await workspace(coloredFixture());
  try {
    for (const create of [createGltfProductionImportOperationBuildIdentity, createGltfAnalyzeOperationBuildIdentity]) {
      const implicit = await create(root, invocation(source));
      const empty = await create(root, invocation(source, { repairs: [] }));
      const declared = await create(root, invocation(source, { repairs: [CLAMP] }));
      assert.deepEqual((implicit.parameters as Json).policy.repairs, [], "default repairs [] is materialized");
      assert.deepEqual(empty, implicit, "explicit [] equals the default");
      assert.deepEqual((declared.parameters as Json).policy.repairs, [CLAMP]);
      assert.notDeepEqual(declared, implicit, "declaring the repair changes build identity");
      const policies = (implicit.implementation as Json).policies as Json;
      assert.ok(policies && Object.values(policies).some((value) => {
        try { assert.deepEqual(value, { repair: CLAMP, maxExcess: CLAMP_BOUND }); return true; } catch { return false; }
      }), `implementation policies must record ${CLAMP} with maxExcess ${CLAMP_BOUND}: ${JSON.stringify(policies)}`);
      const tangent = await create(root, invocation(source, { allowedValidatorWarnings: [TANGENT_WARNING] }));
      assert.deepEqual((tangent.parameters as Json).policy.allowedValidatorWarnings, [TANGENT_WARNING]);
      assert.notDeepEqual(tangent, implicit, "declaring the tangent exception changes build identity");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown, duplicate and malformed repair declarations are rejected", async () => {
  const { root, source } = await workspace(coloredFixture());
  try {
    const cases: unknown[] = [
      ["gltf-color-clamp-v2"], ["clamp"], ["GLTF-COLOR-CLAMP-V1"], [CLAMP, CLAMP], [CLAMP, "gltf-normalize-weights-v1"],
      CLAMP, [1], [{ repair: CLAMP }], {},
    ];
    for (const value of cases) {
      const call = invocation(source, { repairs: value });
      for (const operation of OPERATIONS) await assert.rejects(run(operation, root, call), `${operation} must reject repairs ${JSON.stringify(value)}`);
      await assert.rejects(createGltfProductionImportOperationBuildIdentity(root, call), `identity must reject repairs ${JSON.stringify(value)}`);
      await assert.rejects(createGltfAnalyzeOperationBuildIdentity(root, call));
    }
    // A bound cannot be supplied by the caller.
    await assert.rejects(executeGltfProductionImportOperation(root, invocation(source, { repairs: [CLAMP], maxExcess: 1 })));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("without the declaration a COLOR_n accessor outside [0, 1] still fails", async () => {
  await failClosed(coloredFixture(), undefined, [/\/meshes\/0\/primitives\/0\/attributes\/COLOR_0: ACCESSOR_NON_CLAMPED/]);
  await failClosed(coloredFixture(), { repairs: [] }, [/\/meshes\/0\/primitives\/0\/attributes\/COLOR_0: ACCESSOR_NON_CLAMPED/]);
  // Below zero alone.
  await failClosed(coloredFixture([0.5, 0.5, 0.5, 1, -0.0001, 0, 0, 1, 1, 1, 1, 1]), undefined, [/ACCESSOR_NON_CLAMPED/]);
});

test("the declared clamp repairs COLOR_0 within the bound, records it, and preserves everything else", async () => {
  const document = coloredFixture();
  const source = bufferBytes(document);
  const policy = { repairs: [CLAMP] };
  const { imported, analyzed, output } = await accepted(document, policy);
  const path = "/meshes/0/primitives/0/attributes/COLOR_0";
  for (const [label, result] of [["import@2", imported], ["analyze@1", analyzed]] as const) {
    const entries = repairs(result);
    assert.equal(entries.length, 1, `${label}: one entry per repaired attribute: ${JSON.stringify(entries)}`);
    assertRepair(entries[0], path, NEAR_RANGE_COLORS, label);
  }
  assert.deepEqual(repairs(analyzed), repairs(imported), "analysis reports the same repairs as import");
  assert.deepEqual((imported.observations as Json).policy.repairs, [CLAMP], "declared repair is in evidence");

  const primitive = await primitiveOf(output);
  const color = primitive.getAttribute("COLOR_0")!;
  assert.equal(color.getComponentType(), 5126, "float colors stay float");
  assert.equal(color.getType(), "VEC4");
  const stored = Array.from(color.getArray()!);
  assert.deepEqual(stored, clampedExpectation(NEAR_RANGE_COLORS).values, "out-of-range components are clamped to [0, 1]; in-range components are unchanged bit for bit");
  assert.deepEqual(stored.filter((_, index) => ![0, 6].includes(index)), NEAR_RANGE_COLORS.map(Math.fround).filter((_, index) => ![0, 6].includes(index)));
  const f32 = (start: number, end: number) => Array.from(new Float32Array(Uint8Array.from(source.subarray(start, end)).buffer));
  assert.deepEqual(Array.from(primitive.getAttribute("POSITION")!.getArray()!), f32(0, 36), "POSITION preserved");
  assert.deepEqual(Array.from(primitive.getAttribute("NORMAL")!.getArray()!), f32(36, 72), "NORMAL preserved");
  assert.deepEqual(Array.from(primitive.getAttribute("TEXCOORD_0")!.getArray()!), f32(72, 96), "TEXCOORD_0 preserved");
  assert.deepEqual(primitive.listSemantics().sort(), ["COLOR_0", "NORMAL", "POSITION", "TEXCOORD_0"]);

  const independent = await validatorCodes(output);
  assert.equal(independent.errors, 0, `output must validate: ${independent.codes.join(", ")}`);
  assert.ok(!independent.codes.includes("ACCESSOR_NON_CLAMPED"), "output has no ACCESSOR_NON_CLAMPED");
  assert.ok(!warningCodes(imported, "outputValidatorWarnings").includes("ACCESSOR_NON_CLAMPED"));
});

test("the clamp repair is deterministic and byte-identical across repeated imports and stores", async () => {
  const policy = { repairs: [CLAMP] };
  const { root, source, bytes } = await workspace(coloredFixture());
  try {
    const first = await executeGltfProductionImportOperation(root, invocation(source, policy));
    const second = await executeGltfProductionImportOperation(root, invocation(source, policy));
    assert.deepEqual(second, first, "repeated import is identical");
    assert.ok(Buffer.from(await resolveAssetObject(root, source)).equals(bytes), "source bytes are not modified in the store");
    const other = await workspace(coloredFixture());
    try {
      const third = await executeGltfProductionImportOperation(other.root, invocation(other.source, policy));
      assert.equal((third.outputs.output as AssetRef).sha256, (first.outputs.output as AssetRef).sha256, "byte-identical output in a fresh store");
      assert.deepEqual(repairs(third), repairs(first));
    } finally { await rm(other.root, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("VEC3 colors and negative excess are clamped within the bound", async () => {
  const values = [-0.00019, 0.5, 1.00019, 0.2, 0.3, 0.4, 1, 0, 0.5];
  const document = withColor(staticFixture(), values, { type: "VEC3" });
  const { imported, analyzed, output } = await accepted(document, { repairs: [CLAMP] });
  for (const result of [imported, analyzed]) {
    const entries = repairs(result);
    assert.equal(entries.length, 1);
    assertRepair(entries[0], "/meshes/0/primitives/0/attributes/COLOR_0", values, "VEC3");
  }
  const color = (await primitiveOf(output)).getAttribute("COLOR_0")!;
  assert.equal(color.getType(), "VEC3");
  assert.deepEqual(Array.from(color.getArray()!), clampedExpectation(values).values);
});

test("one repair entry per repaired attribute with mesh, primitive and set located; untouched attributes get none", async () => {
  const colors = {
    m0p0: [0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 1, 0.7, 0.8, 0.9, 1], // in range: no entry
    m1p0: [1.00005, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1],
    m1p1c0: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], // in range: no entry
    m1p1c1: [-0.0001, 0.5, 0.5, 1.00015, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1.0001],
  };
  const { imported, analyzed, output } = await accepted(multiPrimitiveFixture(colors), { repairs: [CLAMP] });
  for (const [label, result] of [["import@2", imported], ["analyze@1", analyzed]] as const) {
    const entries = repairs(result);
    assert.deepEqual(entries.map((entry) => entry.path).sort(), [
      "/meshes/1/primitives/0/attributes/COLOR_0",
      "/meshes/1/primitives/1/attributes/COLOR_1",
    ], `${label}: repaired attribute paths`);
    assertRepair(entries.find((entry) => entry.path.endsWith("/0/attributes/COLOR_0")), "/meshes/1/primitives/0/attributes/COLOR_0", colors.m1p0, label);
    assertRepair(entries.find((entry) => entry.path.endsWith("COLOR_1")), "/meshes/1/primitives/1/attributes/COLOR_1", colors.m1p1c1, label);
  }
  assert.deepEqual(Array.from((await primitiveOf(output, 0, 0)).getAttribute("COLOR_0")!.getArray()!), colors.m0p0.map(Math.fround));
  assert.deepEqual(Array.from((await primitiveOf(output, 1, 1)).getAttribute("COLOR_0")!.getArray()!), colors.m1p1c0.map(Math.fround));
  assert.deepEqual(Array.from((await primitiveOf(output, 1, 1)).getAttribute("COLOR_1")!.getArray()!), clampedExpectation(colors.m1p1c1).values);
  assert.deepEqual(Array.from((await primitiveOf(output, 1, 0)).getAttribute("COLOR_0")!.getArray()!), clampedExpectation(colors.m1p0).values);
  assert.equal((await validatorCodes(output)).errors, 0);
});

test("declared but unneeded: repairs is [] and the output equals the undeclared import", async () => {
  const inRange = [0, 0.5, 1, 1, 0.25, 0.75, 0, 1, 1, 1, 1, 0];
  const declared = await accepted(coloredFixture(inRange), { repairs: [CLAMP] });
  assert.deepEqual(repairs(declared.imported), []);
  assert.deepEqual(repairs(declared.analyzed), []);
  const plain = await accepted(coloredFixture(inRange), undefined);
  assert.ok(Buffer.from(declared.output).equals(Buffer.from(plain.output)), "a declared repair with nothing to repair changes no output bytes");
  // Normalized unsigned-short colors cannot leave [0, 1]; they are never rewritten.
  const shorts = Buffer.alloc(24);
  [65535, 0, 32768, 65535, 1, 2, 3, 65535, 65535, 65535, 65535, 65535].forEach((value, index) => shorts.writeUInt16LE(value, index * 2));
  const normalized = staticFixture();
  normalized.meshes[0].primitives[0].attributes.COLOR_0 = appendAccessor(normalized, shorts, { componentType: 5123, normalized: true, count: 3, type: "VEC4" });
  const integer = await accepted(normalized, { repairs: [CLAMP] });
  assert.deepEqual(repairs(integer.imported), []);
  const color = (await primitiveOf(integer.output)).getAttribute("COLOR_0")!;
  assert.equal(color.getComponentType(), 5123);
  assert.equal(color.getNormalized(), true);
  assert.deepEqual(Array.from(color.getArray()!), [65535, 0, 32768, 65535, 1, 2, 3, 65535, 65535, 65535, 65535, 65535]);
});

test("components beyond the 2e-4 bound fail with a located COLOR_CLAMP_EXCESS_OUT_OF_BOUND diagnostic and store nothing", async () => {
  const policy = { repairs: [CLAMP] };
  await failsBound(coloredFixture([1.00021, 0.5, 0.5, 1, 0, 0, 0, 1, 1, 1, 1, 1]), policy, "/meshes/0/primitives/0/attributes/COLOR_0");
  await failsBound(coloredFixture([0.5, 0.5, 0.5, 1, -0.00021, 0, 0, 1, 1, 1, 1, 1]), policy, "/meshes/0/primitives/0/attributes/COLOR_0");
  await failsBound(coloredFixture([0.5, 0.5, 0.5, 1, 0, 0, 0, 1, 1, 1, 1, 2]), policy, "/meshes/0/primitives/0/attributes/COLOR_0");
  // Located in mesh 1, primitive 1, set 1, even when other attributes are repairable.
  await failsBound(multiPrimitiveFixture({
    m0p0: [1.0001, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    m1p0: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    m1p1c0: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    m1p1c1: [0, 0, 0, 1, 0, 0, 0, 1.0003, 0, 0, 0, 1],
  }), policy, "/meshes/1/primitives/1/attributes/COLOR_1");
});

test("more than 100 repairable components are clamped despite the validator issue limit", async () => {
  // Regression guard modeled on CommonTree_1 (9034 components above 1): ACCESSOR_NON_CLAMPED
  // entries for repairable colors must not exhaust the validator's report.
  const vertexCount = 150;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colors: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const triangle = Math.floor(vertex / 3), corner = vertex % 3;
    positions.push(triangle + (corner === 1 ? 1 : 0), corner === 2 ? 1 : 0, 0);
    normals.push(0, 0, 1);
    uvs.push(corner === 1 ? 1 : 0, corner === 2 ? 1 : 0);
    colors.push(1.0001678, 1.0001678, 0.5, 1.0001678);
  }
  const document = staticFixture();
  const attributes = document.meshes[0].primitives[0].attributes;
  attributes.POSITION = appendAccessor(document, floats(positions), { componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, 0], max: [vertexCount / 3, 1, 0] });
  attributes.NORMAL = appendAccessor(document, floats(normals), { componentType: 5126, count: vertexCount, type: "VEC3" });
  attributes.TEXCOORD_0 = appendAccessor(document, floats(uvs), { componentType: 5126, count: vertexCount, type: "VEC2" });
  withColor(document, colors);
  // The original three-vertex accessors stay as unused objects (validator info only).
  await failClosed(document, undefined, [/ACCESSOR_NON_CLAMPED/]);
  const { imported, output } = await accepted(document, { repairs: [CLAMP] });
  const entries = repairs(imported);
  assert.equal(entries.length, 1);
  assertRepair(entries[0], "/meshes/0/primitives/0/attributes/COLOR_0", colors, "150 vertices");
  assert.equal(entries[0]!.clampedComponentCount, 450);
  assert.equal((await validatorCodes(output)).errors, 0);
  // A single out-of-bound component among many repairable ones is still located.
  const bad = [...colors];
  bad[4 * 120 + 2] = 1.001;
  const failing = staticFixture();
  Object.assign(failing.meshes[0].primitives[0].attributes, {
    POSITION: appendAccessor(failing, floats(positions), { componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, 0], max: [vertexCount / 3, 1, 0] }),
    NORMAL: appendAccessor(failing, floats(normals), { componentType: 5126, count: vertexCount, type: "VEC3" }),
    TEXCOORD_0: appendAccessor(failing, floats(uvs), { componentType: 5126, count: vertexCount, type: "VEC2" }),
  });
  withColor(failing, bad);
  await failsBound(failing, { repairs: [CLAMP] }, "/meshes/0/primitives/0/attributes/COLOR_0");
});

test("only COLOR_n is repaired: other accessors keep their data and their validator failures", async () => {
  const policy = { repairs: [CLAMP] };
  // TEXCOORD_0 slightly outside [0, 1] is valid glTF and must be preserved exactly, not clamped.
  const uvs = [1.0001, -0.0001, 1.00015, 0.5, -0.00005, 1];
  const textured = staticFixture();
  textured.meshes[0].primitives[0].attributes.TEXCOORD_0 = appendAccessor(textured, floats(uvs), { componentType: 5126, count: 3, type: "VEC2" });
  withColor(textured, NEAR_RANGE_COLORS);
  const { imported, output } = await accepted(textured, policy);
  assert.deepEqual(repairs(imported).map((entry) => entry.path), ["/meshes/0/primitives/0/attributes/COLOR_0"]);
  assert.deepEqual(Array.from((await primitiveOf(output)).getAttribute("TEXCOORD_0")!.getArray()!), uvs.map(Math.fround), "TEXCOORD_0 is not clamped");

  // POSITION beyond its declared max by less than the color bound is not repaired.
  const positioned = coloredFixture();
  const bytes = bufferBytes(positioned);
  bytes.writeFloatLE(1.0001, 0);
  positioned.buffers[0].uri = dataUri(bytes);
  await failClosed(positioned, policy, [/\/accessors\/0\/max\/0: ACCESSOR_MAX_MISMATCH/]);

  // A custom attribute whose name merely contains COLOR is not a COLOR_n set.
  const custom = staticFixture();
  custom.meshes[0].primitives[0].attributes._COLOR_0 = appendAccessor(custom, floats([1.0001, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), { componentType: 5126, count: 3, type: "VEC4" });
  const kept = await accepted(custom, policy);
  assert.deepEqual(repairs(kept.imported), [], "_COLOR_0 is not repaired");
  assert.equal(Array.from((await primitiveOf(kept.output)).getAttribute("_COLOR_0")!.getArray()!)[0], Math.fround(1.0001));
});

test("tree-like source: tangent exception plus clamp repair together import and replay", async () => {
  const document = withColor(normalMappedFixture(), NEAR_RANGE_COLORS);
  const policy = { allowedValidatorWarnings: [TANGENT_WARNING], repairs: [CLAMP] };
  await failClosed(document, { allowedValidatorWarnings: [TANGENT_WARNING] }, [/ACCESSOR_NON_CLAMPED/]);
  await failClosed(document, { repairs: [CLAMP] }, [/MESH_PRIMITIVE_GENERATED_TANGENT_SPACE/]);
  const { imported, analyzed, output } = await accepted(document, policy);
  assert.deepEqual(warningCodes(imported, "validatorWarnings"), [TANGENT_WARNING]);
  assert.deepEqual(warningCodes(imported, "outputValidatorWarnings"), [TANGENT_WARNING]);
  assert.deepEqual(repairs(analyzed), repairs(imported));
  assertRepair(repairs(imported)[0], "/meshes/0/primitives/0/attributes/COLOR_0", NEAR_RANGE_COLORS, "combined");
  const primitive = await primitiveOf(output);
  assert.equal(primitive.getAttribute("TANGENT"), null);
  const independent = await validatorCodes(output);
  assert.equal(independent.errors, 0);
  assert.deepEqual([...new Set(independent.codes.filter((code) => code === TANGENT_WARNING || code === "ACCESSOR_NON_CLAMPED"))], [TANGENT_WARNING]);
});
