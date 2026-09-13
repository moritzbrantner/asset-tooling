import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  generateExtrudedProfileObj,
  generateRevolvedProfileObj,
  normalizeExtrusionProfile,
  normalizeRevolutionProfile,
} from "../src/procedural-mesh.js";
import {
  PROCEDURAL_EXTRUDE_MESH_OPERATION,
  PROCEDURAL_REVOLVE_MESH_OPERATION,
  createProceduralExtrudeMeshOperationBuildIdentity,
  createProceduralRevolveMeshOperationBuildIdentity,
  executeProceduralExtrudeMeshOperation,
  executeProceduralRevolveMeshOperation,
} from "../src/procedural-mesh-operations.js";

const RECTANGLE = [
  { x: -2, z: -1 },
  { x: 2, z: -1 },
  { x: 2, z: 1 },
  { x: -2, z: 1 },
];
const RECTANGLE_REVERSED_AND_ROTATED = [
  { x: 2, z: 1 },
  { x: 2, z: -1 },
  { x: -2, z: -1 },
  { x: -2, z: 1 },
];
const REVOLUTION_PROFILE = [
  { radius: 0, y: -2 },
  { radius: 2, y: -1 },
  { radius: 1, y: 1 },
  { radius: 0, y: 2 },
];

test("extrusion profile normalization canonicalizes winding and starting vertex", () => {
  assert.deepEqual(normalizeExtrusionProfile(RECTANGLE_REVERSED_AND_ROTATED), RECTANGLE);
  assert.deepEqual(normalizeExtrusionProfile(RECTANGLE), RECTANGLE);
});

test("extrusion emits exact centered OBJ bytes with stable cap and side winding", () => {
  const generated = generateExtrudedProfileObj({ profile: RECTANGLE_REVERSED_AND_ROTATED, height: 3 });
  assert.equal(generated.vertexCount, 8);
  assert.equal(generated.triangleCount, 12);
  assert.equal(
    generated.bytes.toString("utf8"),
    [
      "# asset-tooling canonical procedural OBJ v1",
      "v -2 -1.5 -1",
      "v 2 -1.5 -1",
      "v 2 -1.5 1",
      "v -2 -1.5 1",
      "v -2 1.5 -1",
      "v 2 1.5 -1",
      "v 2 1.5 1",
      "v -2 1.5 1",
      "f 1 2 3",
      "f 5 7 6",
      "f 1 3 4",
      "f 5 8 7",
      "f 1 5 2",
      "f 2 5 6",
      "f 2 6 3",
      "f 3 6 7",
      "f 3 7 4",
      "f 4 7 8",
      "f 4 8 1",
      "f 1 8 5",
      "",
    ].join("\n"),
  );
});

test("extrusion rejects non-convex, collinear and duplicate profile definitions", () => {
  assert.throws(
    () => generateExtrudedProfileObj({
      profile: [
        { x: -2, z: -2 }, { x: 2, z: -2 }, { x: 0, z: 0 }, { x: 2, z: 2 }, { x: -2, z: 2 },
      ],
      height: 2,
    }),
    /strictly convex/,
  );
  assert.throws(
    () => normalizeExtrusionProfile([
      { x: -2, z: 0 }, { x: 0, z: 0 }, { x: 2, z: 0 }, { x: 0, z: 2 },
    ]),
    /strictly convex/,
  );
  assert.throws(
    () => normalizeExtrusionProfile([
      { x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: -1 }, { x: -1, z: 1 },
    ]),
    /points must be unique/,
  );
});

test("revolution profile validation requires a closed monotonic axis profile", () => {
  assert.deepEqual(normalizeRevolutionProfile(REVOLUTION_PROFILE), REVOLUTION_PROFILE);
  assert.throws(
    () => normalizeRevolutionProfile([{ radius: 1, y: -1 }, { radius: 2, y: 0 }, { radius: 0, y: 1 }]),
    /start and end on the Y axis/,
  );
  assert.throws(
    () => normalizeRevolutionProfile([{ radius: 0, y: -1 }, { radius: 2, y: 1 }, { radius: 1, y: 0 }, { radius: 0, y: 2 }]),
    /strictly increasing/,
  );
  assert.throws(
    () => normalizeRevolutionProfile([{ radius: 0, y: -2 }, { radius: 0, y: 0 }, { radius: 0, y: 2 }]),
    /interior points must have positive radius/,
  );
});

test("revolution emits exact fixed-table OBJ bytes for a two-ring profile", () => {
  const generated = generateRevolvedProfileObj({ profile: REVOLUTION_PROFILE, radialSegments: 4 });
  assert.equal(generated.vertexCount, 10);
  assert.equal(generated.triangleCount, 16);
  assert.equal(
    generated.bytes.toString("utf8"),
    [
      "# asset-tooling canonical procedural OBJ v1",
      "v 0 -2 0",
      "v 2 -1 0",
      "v 0 -1 2",
      "v -2 -1 0",
      "v 0 -1 -2",
      "v 1 1 0",
      "v 0 1 1",
      "v -1 1 0",
      "v 0 1 -1",
      "v 0 2 0",
      "f 1 2 3",
      "f 1 3 4",
      "f 1 4 5",
      "f 1 5 2",
      "f 2 6 3",
      "f 3 6 7",
      "f 3 7 4",
      "f 4 7 8",
      "f 4 8 5",
      "f 5 8 9",
      "f 5 9 2",
      "f 2 9 6",
      "f 10 7 6",
      "f 10 8 7",
      "f 10 9 8",
      "f 10 6 9",
      "",
    ].join("\n"),
  );
});

test("profile operation descriptors expose bounded structured parameters", () => {
  assert.equal(PROCEDURAL_EXTRUDE_MESH_OPERATION.parameterSchema.properties.profile.maxItems, 64);
  assert.deepEqual(PROCEDURAL_EXTRUDE_MESH_OPERATION.parameterSchema.properties.profile.items.required, ["x", "z"]);
  assert.deepEqual(PROCEDURAL_REVOLVE_MESH_OPERATION.parameterSchema.properties.radialSegments.enum, [4, 8, 16, 32, 64, 128]);
  assert.deepEqual(PROCEDURAL_REVOLVE_MESH_OPERATION.parameterSchema.properties.profile.items.required, ["radius", "y"]);
});

test("extrusion build identity canonicalizes equivalent profiles before hashing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-extrude-build-"));
  const first = await createProceduralExtrudeMeshOperationBuildIdentity(root, {
    parameters: { profile: RECTANGLE, height: 3 },
    inputs: {},
  });
  const second = await createProceduralExtrudeMeshOperationBuildIdentity(root, {
    parameters: { profile: RECTANGLE_REVERSED_AND_ROTATED, height: 3 },
    inputs: {},
  });
  assert.deepEqual(second.parameters, first.parameters);
  assert.equal(first.implementation.algorithm, "canonical-triangular-obj-convex-xz-extrusion-v1");
});

test("revolution build identity binds the fixed-table algorithm", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-revolve-build-"));
  const build = await createProceduralRevolveMeshOperationBuildIdentity(root, {
    parameters: { profile: REVOLUTION_PROFILE, radialSegments: 16 },
    inputs: {},
  });
  assert.equal(build.implementation.algorithm, "canonical-triangular-obj-fixed-micro-revolution-v1");
  assert.equal(build.implementation.randomness, "none");
  assert.deepEqual(build.parameters.profile, REVOLUTION_PROFILE);
});

test("extrusion operation is content-addressed and equivalent profiles are idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-extrude-execute-"));
  const first = await executeProceduralExtrudeMeshOperation(root, {
    parameters: { profile: RECTANGLE, height: 3 },
    inputs: {},
  });
  const second = await executeProceduralExtrudeMeshOperation(root, {
    parameters: { profile: RECTANGLE_REVERSED_AND_ROTATED, height: 3 },
    inputs: {},
  });
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations.parameters, first.observations.parameters);
  assert.equal(first.outputs.output.metadata.vertexCount, 8);
  assert.equal(first.outputs.output.metadata.triangleCount, 12);
  assert.equal(first.outputs.output.metadata.profileConvention, "canonical-ccw-strictly-convex-xz");
  assert.equal(first.outputs.output.metadata.coordinateQuantization, "integer-xz-half-unit-y");
});

test("revolution operation is content-addressed with explicit profile evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-revolve-execute-"));
  const invocation = { parameters: { profile: REVOLUTION_PROFILE, radialSegments: 8 }, inputs: {} };
  const first = await executeProceduralRevolveMeshOperation(root, invocation);
  const second = await executeProceduralRevolveMeshOperation(root, invocation);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.metadata.vertexCount, 18);
  assert.equal(first.outputs.output.metadata.triangleCount, 32);
  assert.equal(first.outputs.output.metadata.profilePointCount, 4);
  assert.equal(first.outputs.output.metadata.profileConvention, "axis-closed-strictly-increasing-radius-y");
  assert.equal(first.outputs.output.metadata.coordinateQuantization, "1e-6-unit-fixed-table-xz+integer-y");
});
