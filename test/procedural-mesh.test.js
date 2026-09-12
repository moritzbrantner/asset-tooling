import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { generateBoxObj, generateHeightfieldObj } from "../src/procedural-mesh.js";
import {
  HEIGHTFIELD_MESH_OPERATION,
  PROCEDURAL_MESH_OPERATIONS,
  createHeightfieldMeshOperationBuildIdentity,
  executeHeightfieldMeshOperation,
  executeProceduralBoxMeshOperation,
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
    ["mesh.heightfield.from-image", "mesh.procedural.box", "mesh.procedural.plane"],
  );
  assert.deepEqual(HEIGHTFIELD_MESH_OPERATION.inputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(HEIGHTFIELD_MESH_OPERATION.outputs[0].mediaTypes, ["model/obj"]);
});

test("box generation emits exact centered half-unit OBJ bytes", () => {
  const generated = generateBoxObj({ width: 1, height: 2, depth: 3 });
  assert.equal(generated.vertexCount, 8);
  assert.equal(generated.triangleCount, 12);
  assert.match(generated.bytes.toString("utf8"), /^# asset-tooling canonical procedural OBJ v1\nv -0\.5 -1 -1\.5\n/);
  assert.match(generated.bytes.toString("utf8"), /\nv 0\.5 1 1\.5\n/);
  assert.match(generated.bytes.toString("utf8"), /\nf 2 7 6\n$/);
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
