import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import {
  IMAGE_CROP_OPERATION,
  createImageCropOperationBuildIdentity,
  createImageResizeOperationBuildIdentity,
  resizeRgba8Nearest,
} from "../src/image-operations.js";

function pixel(red, green = 0, blue = 0, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

async function workspaceWithImage(width, height, pixelBytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-convergence-"));
  const stored = await storeAssetObject(root, {
    bytes: encodeRgba8Image({ width, height, pixels: pixelBytes }),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: { width, height, pixelFormat: "rgba8", colorSpace: "srgb", alphaMode: "straight" },
  });
  return { root, source: stored.asset };
}

test("nearest resize samples vertical centers from source height on non-square images", () => {
  const source = {
    width: 1,
    height: 4,
    pixels: pixels(pixel(1), pixel(2), pixel(3), pixel(4)),
  };
  const resized = resizeRgba8Nearest(source, 1, 2);
  assert.deepEqual(resized.pixels, pixels(pixel(2), pixel(4)));
});

test("image.crop descriptor and runtime enforce the same coordinate domain", async () => {
  const { root, source } = await workspaceWithImage(1, 1, pixels(pixel(1, 2, 3)));
  assert.equal(IMAGE_CROP_OPERATION.parameterSchema.properties.x.maximum, 8191);
  assert.equal(IMAGE_CROP_OPERATION.parameterSchema.properties.y.maximum, 8191);
  await assert.rejects(
    () => createImageCropOperationBuildIdentity(root, { parameters: { x: 8192, y: 0, width: 1, height: 1 }, inputs: { source } }),
    /parameters\.x must be an integer in 0\.\.8191/,
  );
  await assert.rejects(
    () => createImageCropOperationBuildIdentity(root, { parameters: { x: 0, y: 8192, width: 1, height: 1 }, inputs: { source } }),
    /parameters\.y must be an integer in 0\.\.8191/,
  );
});

test("image.resize build identity distinguishes nearest and bilinear algorithms", async () => {
  const { root, source } = await workspaceWithImage(1, 1, pixels(pixel(10, 20, 30)));
  const nearest = await createImageResizeOperationBuildIdentity(root, {
    parameters: { width: 2, height: 3, filter: "nearest" },
    inputs: { source },
  });
  const bilinear = await createImageResizeOperationBuildIdentity(root, {
    parameters: { width: 2, height: 3, filter: "bilinear" },
    inputs: { source },
  });
  assert.equal(nearest.implementation.algorithm, "nearest-center-integer-v1");
  assert.equal(bilinear.implementation.algorithm, "bilinear-center-fixed-rational-v1");
  assert.notEqual(nearest.implementation.algorithm, bilinear.implementation.algorithm);
});
