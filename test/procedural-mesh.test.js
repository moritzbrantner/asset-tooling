import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import {
  generateBoxObj,
  generateCylinderObj,
  generateHeightfieldObj,
  generateUvSphereObj,
} from "../src/procedural-mesh.js";
import {
  HEIGHTFIELD_MESH_OPERATION,
  PROCEDURAL_CYLINDER_MESH_OPERATION,
  PROCEDURAL_MESH_OPERATIONS,
  PROCEDURAL_UV_SPHERE_MESH_OPERATION,
  createHeightfieldMeshOperationBuildIdentity,
  createProceduralCylinderMeshOperationBuildIdentity,
  createProceduralUvSphereMeshOperationBuildIdentity,
  executeHeightfieldMeshOperation,
  executeProceduralBoxMeshOperation,
  executeProceduralCylinderMeshOperation,
  executeProceduralUvSphereMeshOperation,
} from "../src/procedural-mesh-operations.js";

function pixel(red, green = red, blue = red, alpha = 255) {
  return [red, green, blue, alpha];
}

function image(width, height, ...values) {
  return { width, height, pixels: Buffer.from(values.flat()) };
}

async function workspaceWithHeightImage(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-mesh-"));
  const stored = await storeAssetObject(root, {
    bytes: encodeRgba8Image(source),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: source.width,
      height: source.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      field: "height",
    },
  });
  return { root, source: stored.asset };
}

test("procedural mesh registry exposes deterministic OBJ generation", () => {
  assert.deepEqual(
    PROCEDURAL_MESH_OPERATIONS.map((operation) => operation.id),
    [
      "mesh.heightfield.from-image",
      "mesh.procedural.box",
      "mesh.procedural.cylinder",
      "mesh.procedural.plane",
      "mesh.procedural.uv-sphere",
    ],
  );
  assert.deepEqual(HEIGHTFIELD_MESH_OPERATION.inputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(HEIGHTFIELD_MESH_OPERATION.outputs[0].mediaTypes, ["model/obj"]);
  assert.deepEqual(PROCEDURAL_CYLINDER_MESH_OPERATION.parameterSchema.properties.radialSegments.enum, [4, 8, 16, 32, 64, 128]);
  assert.deepEqual(PROCEDURAL_UV_SPHERE_MESH_OPERATION.parameterSchema.properties.latitudeSegments.enum, [4, 8, 16, 32, 64]);
});

test("box generation emits exact centered half-unit OBJ bytes", () => {
  const generated = generateBoxObj({ width: 1, height: 2, depth: 3 });
  assert.equal(generated.vertexCount, 8);
  assert.equal(generated.triangleCount, 12);
  assert.match(generated.bytes.toString("utf8"), /^# asset-tooling canonical procedural OBJ v1\nv -0\.5 -1 -1\.5\n/);
  assert.match(generated.bytes.toString("utf8"), /\nv 0\.5 1 1\.5\n/);
  assert.match(generated.bytes.toString("utf8"), /\nf 2 7 6\n$/);
});

test("cylinder generation uses exact fixed-table coordinates and stable cap winding", () => {
  const generated = generateCylinderObj({ radius: 2, height: 3, radialSegments: 4 });
  assert.equal(generated.vertexCount, 10);
  assert.equal(generated.triangleCount, 16);
  assert.equal(
    generated.bytes.toString("utf8"),
    [
      "# asset-tooling canonical procedural OBJ v1",
      "v 2 -1.5 0",
      "v 0 -1.5 2",
      "v -2 -1.5 0",
      "v 0 -1.5 -2",
      "v 2 1.5 0",
      "v 0 1.5 2",
      "v -2 1.5 0",
      "v 0 1.5 -2",
      "v 0 -1.5 0",
      "v 0 1.5 0",
      "f 1 5 2",
      "f 2 5 6",
      "f 9 1 2",
      "f 10 6 5",
      "f 2 6 3",
      "f 3 6 7",
      "f 9 2 3",
      "f 10 7 6",
      "f 3 7 4",
      "f 4 7 8",
      "f 9 3 4",
      "f 10 8 7",
      "f 4 8 1",
      "f 1 8 5",
      "f 9 4 1",
      "f 10 5 8",
      "",
    ].join("\n"),
  );
});

test("UV sphere generation is fixed-point deterministic with explicit topology counts", () => {
  const generated = generateUvSphereObj({ radius: 2, latitudeSegments: 4, longitudeSegments: 4 });
  assert.equal(generated.vertexCount, 14);
  assert.equal(generated.triangleCount, 24);
  const obj = generated.bytes.toString("utf8");
  assert.match(obj, /^# asset-tooling canonical procedural OBJ v1\nv 0 2 0\nv 1\.414214 1\.414214 0\n/);
  assert.match(obj, /\nv 2 0 0\n/);
  assert.match(obj, /\nv 0 -2 0\n/);
  assert.match(obj, /\nf 14 13 10\n$/);
});

test("procedural curved primitives reject segment counts outside the fixed lookup grid", () => {
  assert.throws(
    () => generateCylinderObj({ radius: 2, height: 3, radialSegments: 12 }),
    /radialSegments must be one of 4, 8, 16, 32, 64, 128/,
  );
  assert.throws(
    () => generateUvSphereObj({ radius: 2, latitudeSegments: 6, longitudeSegments: 16 }),
    /latitudeSegments must be one of 4, 8, 16, 32, 64/,
  );
});

test("heightfield generation uses Q8 luma, integer height rounding and stable winding", () => {
  const source = image(2, 2, pixel(0), pixel(255), pixel(128), pixel(64));
  const generated = generateHeightfieldObj(source, { cellSize: 2, heightScale: 10 });
  assert.equal(generated.vertexCount, 4);
  assert.equal(generated.triangleCount, 2);
  assert.equal(
    generated.bytes.toString("utf8"),
    [
      "# asset-tooling canonical procedural OBJ v1",
      "v -1 0 -1",
      "v 1 10 -1",
      "v -1 5 1",
      "v 1 3 1",
      "f 1 3 2",
      "f 2 3 4",
      "",
    ].join("\n"),
  );
});

test("curved primitive build identities bind fixed-table algorithms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-curved-"));
  const cylinder = await createProceduralCylinderMeshOperationBuildIdentity(root, {
    parameters: { radius: 3, height: 5, radialSegments: 16 },
    inputs: {},
  });
  const sphere = await createProceduralUvSphereMeshOperationBuildIdentity(root, {
    parameters: { radius: 4, latitudeSegments: 8, longitudeSegments: 16 },
    inputs: {},
  });
  assert.equal(cylinder.implementation.algorithm, "canonical-triangular-obj-cylinder-fixed-micro-circle-v1");
  assert.equal(sphere.implementation.algorithm, "canonical-triangular-obj-uv-sphere-fixed-micro-circle-v1");
  assert.equal(cylinder.implementation.randomness, "none");
  assert.equal(sphere.implementation.randomness, "none");
});

test("heightfield build identity binds source content and algorithm", async () => {
  const { root, source } = await workspaceWithHeightImage(image(2, 2, pixel(0), pixel(255), pixel(64), pixel(128)));
  const build = await createHeightfieldMeshOperationBuildIdentity(root, {
    parameters: { cellSize: 4, heightScale: 20 },
    inputs: { source },
  });
  assert.equal(build.inputs.source.sha256, source.sha256);
  assert.equal(build.implementation.algorithm, "q8-rec709-integer-heightfield-obj-v1");
  assert.equal(build.implementation.randomness, "none");
});

test("procedural mesh operations are content-addressed and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-box-"));
  const invocation = { parameters: { width: 2, height: 4, depth: 6 }, inputs: {} };
  const first = await executeProceduralBoxMeshOperation(root, invocation);
  const second = await executeProceduralBoxMeshOperation(root, invocation);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "mesh");
  assert.equal(first.outputs.output.mediaType, "model/obj");
  assert.equal(first.outputs.output.metadata.vertexCount, 8);
  assert.equal(first.outputs.output.metadata.triangleCount, 12);
  assert.match((await resolveAssetObject(root, first.outputs.output)).toString("utf8"), /^# asset-tooling canonical procedural OBJ v1/);
});

test("cylinder and sphere operations preserve fixed-point topology evidence and idempotence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-curved-execute-"));
  const cylinderInvocation = { parameters: { radius: 3, height: 5, radialSegments: 8 }, inputs: {} };
  const cylinderFirst = await executeProceduralCylinderMeshOperation(root, cylinderInvocation);
  const cylinderSecond = await executeProceduralCylinderMeshOperation(root, cylinderInvocation);
  assert.equal(cylinderSecond.outputs.output.sha256, cylinderFirst.outputs.output.sha256);
  assert.equal(cylinderFirst.outputs.output.metadata.vertexCount, 18);
  assert.equal(cylinderFirst.outputs.output.metadata.triangleCount, 32);
  assert.equal(cylinderFirst.outputs.output.metadata.coordinateQuantization, "1e-6-unit-fixed-table");

  const sphere = await executeProceduralUvSphereMeshOperation(root, {
    parameters: { radius: 4, latitudeSegments: 8, longitudeSegments: 16 },
    inputs: {},
  });
  assert.equal(sphere.outputs.output.metadata.vertexCount, 114);
  assert.equal(sphere.outputs.output.metadata.triangleCount, 224);
  assert.equal(sphere.outputs.output.metadata.coordinateQuantization, "1e-6-unit-fixed-table");
});

test("heightfield operation preserves source lineage and exact topology counts", async () => {
  const { root, source } = await workspaceWithHeightImage(
    image(3, 2, pixel(0), pixel(32), pixel(64), pixel(128), pixel(192), pixel(255)),
  );
  const result = await executeHeightfieldMeshOperation(root, {
    parameters: { cellSize: 2, heightScale: 255 },
    inputs: { source },
  });
  assert.equal(result.outputs.output.metadata.sourceSha256, source.sha256);
  assert.equal(result.outputs.output.metadata.vertexCount, 6);
  assert.equal(result.outputs.output.metadata.triangleCount, 4);
  assert.deepEqual(result.observations.parameters, { cellSize: 2, heightScale: 255 });
});
