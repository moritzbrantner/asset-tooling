import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "../src/image-rgba8.js";
import {
  IMAGE_FILTER_OPERATIONS,
  IMAGE_GRAYSCALE_OPERATION,
  createImageConvolveOperationBuildIdentity,
  executeImageBlurOperation,
  executeImageGrayscaleOperation,
} from "../src/image-filter-operations.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

async function workspaceWithImage(width, height, pixelBytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-filter-"));
  const stored = await storeAssetObject(root, {
    bytes: encodeRgba8Image({ width, height, pixels: pixelBytes }),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: { width, height, pixelFormat: "rgba8", colorSpace: "srgb", alphaMode: "straight" },
  });
  return { root, source: stored.asset };
}

test("image filter operation registry is deterministic", () => {
  assert.deepEqual(
    IMAGE_FILTER_OPERATIONS.map((operation) => operation.id),
    [
      "image.blur",
      "image.contrast",
      "image.convolve",
      "image.exposure",
      "image.grayscale",
      "image.levels",
      "image.sharpen",
      "image.threshold",
    ],
  );
  assert.equal(IMAGE_GRAYSCALE_OPERATION.category, "image.color");
  assert.deepEqual(IMAGE_GRAYSCALE_OPERATION.inputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
});

test("grayscale operation is content-addressed and idempotent", async () => {
  const { root, source } = await workspaceWithImage(
    2,
    1,
    pixels(pixel(255, 0, 0, 22), pixel(0, 255, 0, 44)),
  );
  const invocation = { parameters: {}, inputs: { source } };
  const first = await executeImageGrayscaleOperation(root, invocation);
  const second = await executeImageGrayscaleOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.deepEqual(first.observations, second.observations);
  assert.deepEqual(first.outputs.output.metadata, {
    width: 2,
    height: 1,
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    sourceSha256: source.sha256,
  });
  const image = parseRgba8Image(await resolveAssetObject(root, first.outputs.output));
  assert.deepEqual(image.pixels, pixels(pixel(54, 54, 54, 22), pixel(182, 182, 182, 44)));
});

test("blur operation uses premultiplied-alpha evidence", async () => {
  const { root, source } = await workspaceWithImage(
    3,
    1,
    pixels(pixel(255, 0, 0, 0), pixel(0, 0, 255, 255), pixel(255, 0, 0, 0)),
  );
  const result = await executeImageBlurOperation(root, {
    parameters: { radius: 1 },
    inputs: { source },
  });
  assert.equal(result.observations.algorithm, "clamp-box-premultiplied-alpha-v1");
  const image = parseRgba8Image(await resolveAssetObject(root, result.outputs.output));
  assert.deepEqual(
    image.pixels,
    pixels(pixel(0, 0, 255, 85), pixel(0, 0, 255, 85), pixel(0, 0, 255, 85)),
  );
});

test("generic convolution rejects contradictory kernel shape before execution", async () => {
  const { root, source } = await workspaceWithImage(1, 1, pixels(pixel(1, 2, 3)));
  await assert.rejects(
    () =>
      createImageConvolveOperationBuildIdentity(root, {
        parameters: {
          width: 3,
          height: 3,
          weights: [1, 1, 1],
          divisor: 3,
          bias: 0,
          alphaMode: "preserve",
        },
        inputs: { source },
      }),
    /width \* height/,
  );
});
