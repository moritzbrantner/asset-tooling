import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { storeAssetObject } from "../src/asset-store.js";
import { inspectObjMesh, validateObjMeshInspection } from "../src/mesh-analysis.js";
import {
  MESH_ANALYSIS_OPERATIONS,
  createObjMeshInspectOperationBuildIdentity,
  executeObjMeshInspectOperation,
  executeObjMeshValidateOperation,
} from "../src/mesh-analysis-operations.js";
import { generateBoxObj } from "../src/procedural-mesh.js";

async function workspaceWithObj(bytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-mesh-analysis-"));
  const stored = await storeAssetObject(root, {
    bytes,
    kind: "mesh",
    mediaType: "model/obj",
    metadata: { meshFormat: "obj" },
  });
  return { root, source: stored.asset };
}

const QUAD_OBJ = Buffer.from(
  [
    "# representative structural fixture",
    "mtllib basic.mtl",
    "o terrain",
    "v -1 0 -1",
    "v 1 0 -1",
    "v 1 2 1",
    "v -1 2 1",
    "v 5 5 5",
    "vt 0 0",
    "vt 1 0",
    "vt 1 1",
    "vt 0 1",
    "vn 0 1 0",
    "usemtl matte",
    "f 1/1/1 2/2/1 3/3/1 4/4/1",
    "s 1",
    "",
  ].join("\n"),
  "utf8",
);

test("mesh analysis registry exposes inspect and validate without output assets", () => {
  assert.deepEqual(
    MESH_ANALYSIS_OPERATIONS.map((operation) => operation.id),
    ["mesh.obj.inspect", "mesh.obj.validate"],
  );
  for (const operation of MESH_ANALYSIS_OPERATIONS) {
    assert.deepEqual(operation.outputs, []);
    assert.deepEqual(operation.inputs[0].assetKinds, ["mesh"]);
    assert.deepEqual(operation.inputs[0].mediaTypes, ["model/obj"]);
  }
});

test("OBJ inspection measures topology, references, records, and bounds", () => {
  assert.deepEqual(inspectObjMesh(QUAD_OBJ), {
    vertexCount: 5,
    texcoordCount: 4,
    normalCount: 1,
    faceCount: 1,
    triangleCount: 2,
    nonTriangleFaceCount: 1,
    repeatedIndexFaceCount: 0,
    referencedVertexCount: 4,
    unreferencedVertexCount: 1,
    facesUsingNormals: 1,
    facesUsingTexcoords: 1,
    materialLibraryCount: 1,
    materialUseCount: 1,
    objectCount: 1,
    groupCount: 0,
    unsupportedRecordCount: 1,
    bounds: { min: [-1, 0, -1], max: [5, 5, 5], size: [6, 5, 6] },
  });
});

test("OBJ inspection resolves negative indices and triangulates polygon counts deterministically", () => {
  const bytes = Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n", "utf8");
  const inspection = inspectObjMesh(bytes);
  assert.equal(inspection.vertexCount, 3);
  assert.equal(inspection.faceCount, 1);
  assert.equal(inspection.triangleCount, 1);
  assert.equal(inspection.referencedVertexCount, 3);
  assert.equal(inspection.unreferencedVertexCount, 0);
});

test("OBJ inspection fails closed on malformed or undeclared face references", () => {
  assert.throws(
    () => inspectObjMesh(Buffer.from("v 0 0 0\nv 1 0 0\nf 1 2 3\n", "utf8")),
    /undeclared OBJ element/,
  );
  assert.throws(
    () => inspectObjMesh(Buffer.from("v 0 0 nope\n", "utf8")),
    /finite number/,
  );
});

test("mesh policy validation emits deterministic structured violations without mutating the asset", () => {
  const inspection = inspectObjMesh(QUAD_OBJ);
  const result = validateObjMeshInspection(inspection, {
    maxVertices: 4,
    maxTriangles: 1,
    requireTriangles: true,
    requireNormals: true,
    allowUnusedVertices: false,
    rejectUnsupportedRecords: true,
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations, [
    { code: "vertex-budget-exceeded", actual: 5, limit: 4 },
    { code: "triangle-budget-exceeded", actual: 2, limit: 1 },
    { code: "non-triangle-faces-present", count: 1 },
    { code: "unused-vertices-present", count: 1 },
    { code: "unsupported-records-present", count: 1 },
  ]);
});

test("inspection operation is repeatable and binds exact source content", async () => {
  const box = generateBoxObj({ width: 2, height: 4, depth: 6 });
  const { root, source } = await workspaceWithObj(box.bytes);
  const build = await createObjMeshInspectOperationBuildIdentity(root, { parameters: {}, inputs: { source } });
  assert.equal(build.inputs.source.sha256, source.sha256);
  assert.equal(build.implementation.algorithm, "obj-structural-inspection-v1");

  const first = await executeObjMeshInspectOperation(root, { parameters: {}, inputs: { source } });
  const second = await executeObjMeshInspectOperation(root, { parameters: {}, inputs: { source } });
  assert.deepEqual(first.outputs, {});
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.observations.sourceSha256, source.sha256);
  assert.equal(first.observations.vertexCount, 8);
  assert.equal(first.observations.triangleCount, 12);
  assert.deepEqual(first.observations.bounds, { min: [-1, -2, -3], max: [1, 2, 3], size: [2, 4, 6] });
});

test("validation operation reports policy result while malformed OBJ still fails the operation", async () => {
  const box = generateBoxObj({ width: 2, height: 2, depth: 2 });
  const { root, source } = await workspaceWithObj(box.bytes);
  const result = await executeObjMeshValidateOperation(root, {
    parameters: {
      maxVertices: 8,
      maxTriangles: 12,
      requireTriangles: true,
      requireNormals: false,
      allowUnusedVertices: false,
      rejectUnsupportedRecords: true,
    },
    inputs: { source },
  });
  assert.equal(result.observations.valid, true);
  assert.deepEqual(result.observations.violations, []);
  assert.equal(result.observations.policy.maxTriangles, 12);

  const malformed = await workspaceWithObj(Buffer.from("v 0 0 0\nf 1 2 3\n", "utf8"));
  await assert.rejects(
    () => executeObjMeshInspectOperation(malformed.root, { parameters: {}, inputs: { source: malformed.source } }),
    /undeclared OBJ element/,
  );
});
