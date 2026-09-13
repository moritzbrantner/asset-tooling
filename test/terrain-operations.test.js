import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  encodeRgba8Image,
  parseRgba8Image,
  RGBA8_IMAGE_MEDIA_TYPE,
} from "../src/image-rgba8.js";
import {
  HEIGHT_RADIAL_FALLOFF_OPERATION,
  HEIGHT_TERRACE_OPERATION,
  TERRAIN_HEIGHT_OPERATIONS,
  applyRadialHeightFalloffRgba8,
  createHeightRadialFalloffOperationBuildIdentity,
  createHeightTerraceOperationBuildIdentity,
  executeHeightRadialFalloffOperation,
  executeHeightTerraceOperation,
  terraceHeightRgba8,
} from "../src/terrain-operations.js";

function pixel(value) {
  return [value, value, value, 255];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

async function storeHeight(root, width, height, values) {
  return (
    await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width, height, pixels: values }),
      kind: "image",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      metadata: {
        width,
        height,
        pixelFormat: "rgba8",
        colorSpace: "srgb",
        alphaMode: "straight",
        field: "height",
        heightEncoding: "luma8",
      },
    })
  ).asset;
}

test("terrain registry exposes explicit deterministic height transforms", () => {
  assert.deepEqual(
    TERRAIN_HEIGHT_OPERATIONS.map((operation) => operation.id),
    ["image.height.radial-falloff", "image.height.terrace"],
  );
  assert.equal(HEIGHT_TERRACE_OPERATION.parameterSchema.properties.levels.maximum, 256);
  assert.equal(HEIGHT_RADIAL_FALLOFF_OPERATION.parameterSchema.properties.innerRadiusQ8.maximum, 254);
  assert.deepEqual(HEIGHT_TERRACE_OPERATION.inputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
});

test("terrace quantization preserves endpoints and pins uniform integer levels", () => {
  const output = terraceHeightRgba8(
    { width: 4, height: 1, pixels: pixels(pixel(0), pixel(50), pixel(128), pixel(255)) },
    { levels: 4 },
  );
  assert.deepEqual(
    output.pixels,
    pixels(pixel(0), pixel(85), pixel(170), pixel(255)),
  );
});

test("radial falloff preserves inner terrain and subtracts deterministically toward edges", () => {
  const source = {
    width: 5,
    height: 5,
    pixels: Buffer.from(Array.from({ length: 25 }, () => pixel(200)).flat()),
  };
  const output = applyRadialHeightFalloffRgba8(source, { innerRadiusQ8: 128, strength: 100 });
  const values = [];
  for (let index = 0; index < 25; index += 1) values.push(output.pixels[index * 4]);
  assert.deepEqual(values, [
    100, 100, 100, 100, 100,
    100, 159, 200, 159, 100,
    100, 200, 200, 200, 100,
    100, 159, 200, 159, 100,
    100, 100, 100, 100, 100,
  ]);
  for (let index = 0; index < 25; index += 1) assert.equal(output.pixels[index * 4 + 3], 255);
});

test("terrain build identities bind source content and exact algorithms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-terrain-"));
  const source = await storeHeight(root, 4, 1, pixels(pixel(0), pixel(64), pixel(128), pixel(255)));
  const terrace = await createHeightTerraceOperationBuildIdentity(root, {
    parameters: { levels: 8 },
    inputs: { source },
  });
  const falloff = await createHeightRadialFalloffOperationBuildIdentity(root, {
    parameters: { innerRadiusQ8: 96, strength: 80 },
    inputs: { source },
  });
  assert.equal(terrace.inputs.source.sha256, source.sha256);
  assert.equal(terrace.implementation.algorithm, "q8-uniform-endpoint-preserving-terrace-v1");
  assert.equal(falloff.implementation.algorithm, "q8-elliptical-radial-subtractive-falloff-v1");
  assert.equal(terrace.implementation.randomness, "none");
  assert.equal(falloff.implementation.randomness, "none");
});

test("terrain operations are content-addressed, preserve lineage, and remain idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-terrain-execute-"));
  const source = await storeHeight(
    root,
    5,
    1,
    pixels(pixel(0), pixel(64), pixel(128), pixel(192), pixel(255)),
  );
  const invocation = { parameters: { levels: 4 }, inputs: { source } };
  const first = await executeHeightTerraceOperation(root, invocation);
  const second = await executeHeightTerraceOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.deepEqual(first.observations, second.observations);
  assert.equal(first.outputs.output.metadata.sourceSha256, source.sha256);
  assert.equal(first.outputs.output.metadata.terrainTransform, "terrace");
  assert.equal(first.outputs.output.metadata.heightEncoding, "luma8");

  const falloff = await executeHeightRadialFalloffOperation(root, {
    parameters: { innerRadiusQ8: 128, strength: 100 },
    inputs: { source },
  });
  assert.equal(falloff.outputs.output.metadata.sourceSha256, source.sha256);
  assert.equal(falloff.outputs.output.metadata.terrainTransform, "radial-falloff");
  const parsed = parseRgba8Image(await resolveAssetObject(root, falloff.outputs.output));
  assert.equal(parsed.width, 5);
  assert.equal(parsed.height, 1);
});

test("terrain operations fail closed on malformed parameters and missing source bytes", async () => {
  assert.throws(
    () => terraceHeightRgba8({ width: 1, height: 1, pixels: pixels(pixel(128)) }, { levels: 1 }),
    /levels/,
  );
  assert.throws(
    () => applyRadialHeightFalloffRgba8(
      { width: 1, height: 1, pixels: pixels(pixel(128)) },
      { innerRadiusQ8: 255, strength: 10 },
    ),
    /innerRadiusQ8/,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-terrain-missing-"));
  await assert.rejects(
    () => createHeightTerraceOperationBuildIdentity(root, {
      parameters: { levels: 4 },
      inputs: {
        source: {
          schemaVersion: 1,
          kind: "image",
          mediaType: RGBA8_IMAGE_MEDIA_TYPE,
          byteLength: 1,
          sha256: "0".repeat(64),
          metadata: {},
        },
      },
    }),
    /object|missing|sha256|content/i,
  );
});
