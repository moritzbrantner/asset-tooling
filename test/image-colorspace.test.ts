import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  LINEAR_TO_SRGB_RGBA8_LUT,
  SRGB_TO_LINEAR_RGBA8_LUT,
  linearToSrgbRgba8,
  srgbToLinearRgba8,
} from "../src/image-colorspace.js";
import {
  LINEAR_RGBA8_IMAGE_MEDIA_TYPE,
  parseLinearRgba8Image,
} from "../src/image-linear-rgba8.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "../src/image-rgba8.js";
import {
  executeImageLinearToSrgbOperation,
  executeImageSrgbToLinearOperation,
} from "../src/image-colorspace-operations.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

test("checked-in sRGB transfer tables are complete and pin known transfer values", () => {
  assert.equal(SRGB_TO_LINEAR_RGBA8_LUT.length, 256);
  assert.equal(LINEAR_TO_SRGB_RGBA8_LUT.length, 256);
  assert.equal(SRGB_TO_LINEAR_RGBA8_LUT[0], 0);
  assert.equal(SRGB_TO_LINEAR_RGBA8_LUT[128], 55);
  assert.equal(SRGB_TO_LINEAR_RGBA8_LUT[255], 255);
  assert.equal(LINEAR_TO_SRGB_RGBA8_LUT[0], 0);
  assert.equal(LINEAR_TO_SRGB_RGBA8_LUT[55], 128);
  assert.equal(LINEAR_TO_SRGB_RGBA8_LUT[255], 255);
});

test("colorspace transfer changes RGB through LUTs and preserves alpha", () => {
  const source = { width: 1, height: 1, pixels: pixels(pixel(128, 64, 255, 17)) };
  const linear = srgbToLinearRgba8(source);
  assert.deepEqual(linear.pixels, pixels(pixel(55, 13, 255, 17)));
  const restored = linearToSrgbRgba8(linear);
  assert.deepEqual(restored.pixels, source.pixels);
});

test("colorspace operations emit distinct canonical media types and deterministic hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-colorspace-"));
  const source = (
    await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width: 1, height: 1, pixels: pixels(pixel(128, 64, 255, 17)) }),
      kind: "image",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      metadata: { width: 1, height: 1, colorSpace: "srgb", alphaMode: "straight", pixelFormat: "rgba8" },
    })
  ).asset;
  const first = await executeImageSrgbToLinearOperation(root, { inputs: { source } });
  const second = await executeImageSrgbToLinearOperation(root, { inputs: { source } });
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.equal(first.outputs.output.mediaType, LINEAR_RGBA8_IMAGE_MEDIA_TYPE);
  const linear = parseLinearRgba8Image(await resolveAssetObject(root, first.outputs.output));
  assert.deepEqual(linear.pixels, pixels(pixel(55, 13, 255, 17)));

  const restoredResult = await executeImageLinearToSrgbOperation(root, {
    inputs: { source: first.outputs.output },
  });
  assert.equal(restoredResult.outputs.output.mediaType, RGBA8_IMAGE_MEDIA_TYPE);
  const restored = parseRgba8Image(await resolveAssetObject(root, restoredResult.outputs.output));
  assert.deepEqual(restored.pixels, pixels(pixel(128, 64, 255, 17)));
});
