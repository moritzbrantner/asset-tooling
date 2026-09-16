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
  deriveNormalMapRgba8,
  generateTileableHeightMapRgba8,
  generateTileableValueNoiseRgba8,
} from "../src/procedural-textures.js";
import {
  PROCEDURAL_TEXTURE_OPERATIONS,
  createNormalFromHeightOperationBuildIdentity,
  createTileableHeightOperationBuildIdentity,
  executeNormalFromHeightOperation,
  executeTileableHeightOperation,
  executeTileableTextureOperation,
} from "../src/procedural-texture-operations.js";

function pixel(red, green = red, blue = red, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

async function storeImage(root, width, height, pixelBytes) {
  return (
    await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width, height, pixels: pixelBytes }),
      kind: "image",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      metadata: {
        width,
        height,
        pixelFormat: "rgba8",
        colorSpace: "srgb",
        alphaMode: "straight",
      },
    })
  ).asset;
}

test("procedural texture registry keeps generation and height-derived normal operations explicit", () => {
  assert.deepEqual(
    PROCEDURAL_TEXTURE_OPERATIONS.map((operation) => operation.id),
    [
      "image.normal.from-height",
      "image.procedural.height.tileable-noise",
      "image.procedural.texture.tileable-noise",
    ],
  );
  assert.deepEqual(PROCEDURAL_TEXTURE_OPERATIONS[0].inputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(PROCEDURAL_TEXTURE_OPERATIONS[1].inputs, []);
  assert.deepEqual(PROCEDURAL_TEXTURE_OPERATIONS[2].outputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
});

test("tileable grayscale value noise pins periodic integer interpolation bytes", () => {
  const output = generateTileableValueNoiseRgba8({
    width: 4,
    height: 2,
    seed: "42",
    gridX: 2,
    gridY: 1,
    mode: "grayscale",
  });
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(50), pixel(64), pixel(78), pixel(64),
      pixel(50), pixel(64), pixel(78), pixel(64),
    ),
  );
});

test("tileable RGB noise derives channels independently and seed affects output", () => {
  const first = generateTileableValueNoiseRgba8({
    width: 4,
    height: 2,
    seed: "42",
    gridX: 2,
    gridY: 1,
    mode: "rgb",
  });
  assert.deepEqual(
    first.pixels.subarray(0, 16),
    pixels(
      pixel(50, 35, 146),
      pixel(64, 144, 181),
      pixel(78, 252, 215),
      pixel(64, 143, 180),
    ),
  );
  const second = generateTileableValueNoiseRgba8({
    width: 4,
    height: 2,
    seed: "43",
    gridX: 2,
    gridY: 1,
    mode: "rgb",
  });
  assert.notDeepEqual(second.pixels, first.pixels);
});

test("tileable height maps are opaque grayscale canonical fields", () => {
  const output = generateTileableHeightMapRgba8({
    width: 4,
    height: 2,
    seed: "42",
    gridX: 2,
    gridY: 1,
  });
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(50), pixel(64), pixel(78), pixel(64),
      pixel(50), pixel(64), pixel(78), pixel(64),
    ),
  );
});

test("normal derivation maps a flat field to tangent-space +Z", () => {
  const source = {
    width: 3,
    height: 1,
    pixels: pixels(pixel(128), pixel(128), pixel(128)),
  };
  const output = deriveNormalMapRgba8(source, { strength: 5, wrap: true });
  assert.deepEqual(
    output.pixels,
    pixels(pixel(128, 128, 255), pixel(128, 128, 255), pixel(128, 128, 255)),
  );
});

test("wrapped normal derivation pins central-difference orientation", () => {
  const source = {
    width: 4,
    height: 1,
    pixels: pixels(pixel(0), pixel(64), pixel(128), pixel(192)),
  };
  const output = deriveNormalMapRgba8(source, { strength: 1, wrap: true });
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(159, 128, 251),
      pixel(97, 128, 251),
      pixel(97, 128, 251),
      pixel(159, 128, 251),
    ),
  );
});

test("tileable height build identity pins seed and periodic algorithm", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-textures-"));
  const build = await createTileableHeightOperationBuildIdentity(root, {
    parameters: { seed: "42", width: 4, height: 2, gridX: 2, gridY: 1 },
  });
  assert.deepEqual(build.operation, { id: "image.procedural.height.tileable-noise", version: "1" });
  assert.equal(build.parameters.seed, "42");
  assert.equal(build.implementation.randomness, "seeded");
  assert.equal(build.implementation.algorithm, "periodic-integer-bilinear-height-v1");
});

test("tileable texture and height execution are content-addressed and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-textures-"));
  const heightInvocation = {
    parameters: { seed: "42", width: 4, height: 2, gridX: 2, gridY: 1 },
  };
  const firstHeight = await executeTileableHeightOperation(root, heightInvocation);
  const secondHeight = await executeTileableHeightOperation(root, heightInvocation);
  assert.equal(firstHeight.outputs.output.sha256, secondHeight.outputs.output.sha256);
  assert.equal(firstHeight.outputs.output.metadata.heightEncoding, "luma8");
  assert.equal(firstHeight.outputs.output.metadata.tileable, true);

  const texture = await executeTileableTextureOperation(root, {
    parameters: {
      seed: "42",
      width: 4,
      height: 2,
      gridX: 2,
      gridY: 1,
      mode: "rgb",
    },
  });
  assert.equal(texture.outputs.output.metadata.tileable, true);
  assert.notEqual(texture.outputs.output.sha256, firstHeight.outputs.output.sha256);
});

test("normal operation validates source at build time and records lineage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-textures-"));
  const source = await storeImage(
    root,
    4,
    1,
    pixels(pixel(0), pixel(64), pixel(128), pixel(192)),
  );
  const build = await createNormalFromHeightOperationBuildIdentity(root, {
    parameters: { strength: 1, wrap: true },
    inputs: { source },
  });
  assert.equal(build.implementation.algorithm, "q8-luma-central-difference-integer-normal-v1");

  const result = await executeNormalFromHeightOperation(root, {
    parameters: { strength: 1, wrap: true },
    inputs: { source },
  });
  assert.equal(result.outputs.output.metadata.sourceSha256, source.sha256);
  assert.equal(result.outputs.output.metadata.normalEncoding, "xyz-unorm8");
  assert.equal(result.outputs.output.metadata.wrap, true);
  const output = parseRgba8Image(await resolveAssetObject(root, result.outputs.output));
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(159, 128, 251),
      pixel(97, 128, 251),
      pixel(97, 128, 251),
      pixel(159, 128, 251),
    ),
  );
});

test("procedural texture parameters and missing height sources fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-textures-"));
  await assert.rejects(
    () =>
      createTileableHeightOperationBuildIdentity(root, {
        parameters: { seed: "42", width: 4, height: 2, gridX: 5, gridY: 1 },
      }),
    /gridX/,
  );
  await assert.rejects(
    () =>
      createNormalFromHeightOperationBuildIdentity(root, {
        parameters: { strength: 1, wrap: true },
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
