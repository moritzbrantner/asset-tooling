import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "../src/image-rgba8.js";
import {
  IMAGE_ADVANCED_OPERATIONS,
  createImageMaskApplyOperationBuildIdentity,
  executeImageOrderedDitherOperation,
  executeImagePaletteMapOperation,
} from "../src/image-advanced-operations.js";

function pixel(red, green, blue, alpha = 255) {
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
      metadata: { width, height, pixelFormat: "rgba8", colorSpace: "srgb", alphaMode: "straight" },
    })
  ).asset;
}

test("advanced image operation registry is deterministic", () => {
  assert.deepEqual(
    IMAGE_ADVANCED_OPERATIONS.map((operation) => operation.id),
    [
      "image.dither.ordered",
      "image.edges.sobel",
      "image.mask.apply",
      "image.morphology",
      "image.palette.map",
      "image.quantize.uniform",
    ],
  );
});

test("mask operation rejects mismatched image dimensions before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-mask-"));
  const source = await storeImage(root, 2, 1, pixels(pixel(1, 2, 3), pixel(4, 5, 6)));
  const mask = await storeImage(root, 1, 1, pixels(pixel(255, 255, 255)));
  await assert.rejects(
    () =>
      createImageMaskApplyOperationBuildIdentity(root, {
        parameters: { channel: "luma" },
        inputs: { source, mask },
      }),
    /dimensions must exactly match/,
  );
});

test("palette mapping operation preserves ordered palette evidence and alpha", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-palette-"));
  const source = await storeImage(root, 1, 1, pixels(pixel(1, 0, 0, 77)));
  const result = await executeImagePaletteMapOperation(root, {
    parameters: { palette: [[0, 0, 0], [2, 0, 0]] },
    inputs: { source },
  });
  assert.deepEqual(result.observations.parameters.palette, [[0, 0, 0], [2, 0, 0]]);
  const output = parseRgba8Image(await resolveAssetObject(root, result.outputs.output));
  assert.deepEqual(output.pixels, pixels(pixel(0, 0, 0, 77)));
});

test("ordered dithering operation is content-addressed across repeated execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-dither-"));
  const source = await storeImage(
    root,
    4,
    1,
    pixels(pixel(128, 128, 128), pixel(128, 128, 128), pixel(128, 128, 128), pixel(128, 128, 128)),
  );
  const invocation = { parameters: { bitsPerChannel: 1 }, inputs: { source } };
  const first = await executeImageOrderedDitherOperation(root, invocation);
  const second = await executeImageOrderedDitherOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.deepEqual(first.observations, second.observations);
  assert.deepEqual(first.outputs.output.metadata.inputs, [{ port: "source", sha256: source.sha256 }]);
});
