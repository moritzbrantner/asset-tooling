import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject } from "../src/asset-store.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import {
  generateCircleSdfRgba8,
  generateCircleSvg,
  generateRoundedRectSdfRgba8,
  generateRoundedRectSvg,
} from "../src/procedural-shapes.js";
import {
  PROCEDURAL_SHAPE_OPERATIONS,
  createProceduralCircleSdfOperationBuildIdentity,
  executeProceduralCircleSdfOperation,
  executeProceduralCircleVectorOperation,
  executeProceduralRoundedRectVectorOperation,
} from "../src/procedural-shape-operations.js";

function pixel(value, alpha = 255) {
  return [value, value, value, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

test("procedural shape registry keeps raster SDF and SVG vector domains explicit", () => {
  assert.deepEqual(
    PROCEDURAL_SHAPE_OPERATIONS.map((operation) => operation.id),
    [
      "image.procedural.sdf.circle",
      "image.procedural.sdf.rounded-rect",
      "vector.procedural.circle",
      "vector.procedural.rounded-rect",
    ],
  );
  assert.deepEqual(PROCEDURAL_SHAPE_OPERATIONS[0].outputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(PROCEDURAL_SHAPE_OPERATIONS[2].outputs[0].assetKinds, ["vector-image"]);
  assert.deepEqual(PROCEDURAL_SHAPE_OPERATIONS[2].outputs[0].mediaTypes, ["image/svg+xml"]);
});

test("circle SDF pins exact boundary and signed-distance orientation", () => {
  const result = generateCircleSdfRgba8({
    width: 5,
    height: 1,
    centerX: 2,
    centerY: 0,
    radius: 1,
    spread: 2,
  });
  assert.deepEqual(
    result.pixels,
    pixels(pixel(192), pixel(128), pixel(64), pixel(128), pixel(192)),
  );
});

test("rounded rectangle SDF uses the same 128 boundary convention", () => {
  const result = generateRoundedRectSdfRgba8({
    width: 5,
    height: 5,
    centerX: 2,
    centerY: 2,
    halfWidth: 2,
    halfHeight: 2,
    cornerRadius: 1,
    spread: 2,
  });
  const centerOffset = (2 * 5 + 2) * 4;
  const cornerOffset = 0;
  assert.equal(result.pixels[centerOffset], 1);
  assert.equal(result.pixels[cornerOffset], 128);
  assert.equal(result.pixels[centerOffset + 3], 255);
});

test("vector circle serialization is canonical and byte-stable", () => {
  const result = generateCircleSvg({
    width: 32,
    height: 24,
    centerX: 12,
    centerY: 10,
    radius: 6,
    fill: "#123abc",
  });
  assert.equal(
    result.bytes.toString("utf8"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24" viewBox="0 0 32 24"><circle cx="12" cy="10" r="6" fill="#123abc"/></svg>\n',
  );
});

test("rounded rectangle SVG serializes exact integer geometry", () => {
  const result = generateRoundedRectSvg({
    width: 40,
    height: 30,
    x: 5,
    y: 6,
    rectWidth: 20,
    rectHeight: 12,
    cornerRadius: 4,
    fill: "#abcdef",
  });
  assert.equal(
    result.bytes.toString("utf8"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30"><rect x="5" y="6" width="20" height="12" rx="4" ry="4" fill="#abcdef"/></svg>\n',
  );
});

test("SDF operation identity pins exact algorithm and boundary parameters", async () => {
  const build = await createProceduralCircleSdfOperationBuildIdentity({
    parameters: { width: 5, height: 1, centerX: 2, centerY: 0, radius: 1, spread: 2 },
  });
  assert.deepEqual(build.operation, { id: "image.procedural.sdf.circle", version: "1" });
  assert.equal(build.implementation.algorithm, "integer-euclidean-circle-sdf-v1");
  assert.equal(build.implementation.randomness, "none");
  assert.equal(build.parameters.spread, 2);
});

test("SDF execution is canonical content-addressed and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-shapes-"));
  const invocation = {
    parameters: { width: 5, height: 1, centerX: 2, centerY: 0, radius: 1, spread: 2 },
  };
  const first = await executeProceduralCircleSdfOperation(root, invocation);
  const second = await executeProceduralCircleSdfOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.equal(first.outputs.output.mediaType, RGBA8_IMAGE_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.field, "signed-distance");
  assert.equal(first.outputs.output.metadata.boundaryValue, 128);
  const image = parseRgba8Image(await resolveAssetObject(root, first.outputs.output));
  assert.deepEqual(image.pixels, pixels(pixel(192), pixel(128), pixel(64), pixel(128), pixel(192)));
});

test("vector execution stores canonical SVG as vector-image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-shapes-"));
  const circle = await executeProceduralCircleVectorOperation(root, {
    parameters: { width: 32, height: 24, centerX: 12, centerY: 10, radius: 6, fill: "#123abc" },
  });
  assert.equal(circle.outputs.output.kind, "vector-image");
  assert.equal(circle.outputs.output.mediaType, "image/svg+xml");
  const bytes = await resolveAssetObject(root, circle.outputs.output);
  assert.equal(bytes.toString("utf8"), generateCircleSvg({
    width: 32,
    height: 24,
    centerX: 12,
    centerY: 10,
    radius: 6,
    fill: "#123abc",
  }).bytes.toString("utf8"));

  const rectangle = await executeProceduralRoundedRectVectorOperation(root, {
    parameters: {
      width: 40,
      height: 30,
      x: 5,
      y: 6,
      rectWidth: 20,
      rectHeight: 12,
      cornerRadius: 4,
      fill: "#abcdef",
    },
  });
  assert.equal(rectangle.outputs.output.metadata.vectorFormat, "svg");
});

test("shape parameters fail closed on invalid geometry and serialization", async () => {
  assert.throws(
    () => generateCircleSvg({ width: 10, height: 10, centerX: 2, centerY: 2, radius: 4, fill: "#000000" }),
    /fit inside the canvas/,
  );
  assert.throws(
    () =>
      generateRoundedRectSvg({
        width: 10,
        height: 10,
        x: 0,
        y: 0,
        rectWidth: 8,
        rectHeight: 4,
        cornerRadius: 3,
        fill: "#000000",
      }),
    /cornerRadius/,
  );
  await assert.rejects(
    () =>
      createProceduralCircleSdfOperationBuildIdentity({
        parameters: { width: 5, height: 5, centerX: 5, centerY: 2, radius: 1, spread: 2 },
      }),
    /centerX/,
  );
});
