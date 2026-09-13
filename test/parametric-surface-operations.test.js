import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject } from "../src/asset-store.js";
import {
  PARAMETRIC_SURFACE_OPERATIONS,
  PROCEDURAL_TORUS_OPERATION,
  createProceduralTorusOperationBuildIdentity,
  executeProceduralTorusOperation,
  generateTorusObj,
} from "../src/parametric-surface-operations.js";

test("parametric surface registry exposes deterministic torus generation", () => {
  assert.deepEqual(PARAMETRIC_SURFACE_OPERATIONS.map((operation) => operation.id), ["mesh.procedural.torus"]);
  assert.deepEqual(PROCEDURAL_TORUS_OPERATION.parameterSchema.properties.majorSegments.enum, [4, 8, 16, 32, 64, 128]);
  assert.deepEqual(PROCEDURAL_TORUS_OPERATION.parameterSchema.properties.minorSegments.enum, [4, 8, 16, 32, 64, 128]);
});

test("torus generation pins canonical circle cardinal coordinates and winding", () => {
  const generated = generateTorusObj({ majorRadius: 3, minorRadius: 1, majorSegments: 4, minorSegments: 4 });
  assert.equal(generated.vertexCount, 16);
  assert.equal(generated.triangleCount, 32);
  const obj = generated.bytes.toString("utf8");
  assert.match(obj, /^# asset-tooling canonical procedural OBJ v1\nv 4 0 0\nv 3 1 0\nv 2 0 0\nv 3 -1 0\n/);
  assert.match(obj, /\nv 0 0 4\nv 0 1 3\n/);
  assert.match(obj, /\nv -4 0 0\n/);
  assert.match(obj, /\nf 4 13 1\n$/);
});

test("torus validates non-self-intersecting radii and canonical segment counts", () => {
  assert.throws(
    () => generateTorusObj({ majorRadius: 2, minorRadius: 2, majorSegments: 8, minorSegments: 8 }),
    /minorRadius must be smaller than majorRadius/,
  );
  assert.throws(
    () => generateTorusObj({ majorRadius: 4, minorRadius: 1, majorSegments: 12, minorSegments: 8 }),
    /majorSegments must be one of/,
  );
});

test("torus build identity binds topology to the canonical cylinder-circle algorithm", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-torus-"));
  const build = await createProceduralTorusOperationBuildIdentity(root, {
    parameters: { majorRadius: 5, minorRadius: 2, majorSegments: 16, minorSegments: 8 },
    inputs: {},
  });
  assert.equal(build.implementation.algorithm, "canonical-triangular-obj-torus-cylinder-circle-v1");
  assert.equal(build.implementation.coordinateQuantization, "1e-6-unit-fixed-table");
  assert.deepEqual(build.parameters, { majorRadius: 5, majorSegments: 16, minorRadius: 2, minorSegments: 8 });
});

test("torus operation is content-addressed and idempotent with exact topology evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-torus-execute-"));
  const invocation = {
    parameters: { majorRadius: 5, minorRadius: 2, majorSegments: 8, minorSegments: 4 },
    inputs: {},
  };
  const first = await executeProceduralTorusOperation(root, invocation);
  const second = await executeProceduralTorusOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.deepEqual(first.observations, second.observations);
  assert.equal(first.outputs.output.metadata.vertexCount, 32);
  assert.equal(first.outputs.output.metadata.triangleCount, 64);
  assert.equal(first.outputs.output.metadata.surface, "torus");
  assert.equal(first.outputs.output.metadata.coordinateQuantization, "1e-6-unit-fixed-table");
  assert.equal(first.outputs.output.metadata.circleSampling, "mesh.procedural.cylinder@1");
  assert.match(
    (await resolveAssetObject(root, first.outputs.output)).toString("utf8"),
    /^# asset-tooling canonical procedural OBJ v1/,
  );
});
