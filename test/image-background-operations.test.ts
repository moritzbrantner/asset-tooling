import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  IMAGE_BORDER_WHITE_ALPHA_OPERATION,
  borderWhiteToAlphaRgba8,
  executeImageBorderWhiteAlphaOperation,
} from "../src/image-background-operations.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "../src/image-rgba8.js";

function rgba(width, height, pixels) {
  return { width, height, pixels: Uint8Array.from(pixels) };
}

test("border-white alpha operation is a deterministic canonical image transform", () => {
  assert.equal(IMAGE_BORDER_WHITE_ALPHA_OPERATION.id, "image.background.border-white-alpha");
  assert.equal(IMAGE_BORDER_WHITE_ALPHA_OPERATION.version, "1");
  assert.deepEqual(IMAGE_BORDER_WHITE_ALPHA_OPERATION.inputs[0].mediaTypes, [
    RGBA8_IMAGE_MEDIA_TYPE,
  ]);
});

test("border-connected white becomes transparent while enclosed white remains opaque", () => {
  const W = [255, 255, 255, 255];
  const B = [20, 20, 20, 255];
  const pixels = [
    ...W, ...W, ...W, ...W, ...W,
    ...W, ...B, ...B, ...B, ...W,
    ...W, ...B, ...W, ...B, ...W,
    ...W, ...B, ...B, ...B, ...W,
    ...W, ...W, ...W, ...W, ...W,
  ];
  const result = borderWhiteToAlphaRgba8(rgba(5, 5, pixels), {
    backgroundFloor: 224,
    transparentAbove: 250,
  });
  const alpha = (x, y) => result.image.pixels[(y * 5 + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(4, 4), 0);
  assert.equal(alpha(2, 2), 255);
  assert.equal(result.observations.connectedBackgroundPixelCount, 16);
});

test("border-connected near-white pixels get a deterministic feathered alpha", () => {
  const result = borderWhiteToAlphaRgba8(
    rgba(3, 1, [
      255, 255, 255, 255,
      240, 245, 250, 255,
      20, 20, 20, 255,
    ]),
    { backgroundFloor: 224, transparentAbove: 250 },
  );
  assert.equal(result.image.pixels[3], 0);
  assert.ok(result.image.pixels[7] > 0 && result.image.pixels[7] < 255);
  assert.equal(result.image.pixels[11], 255);
  assert.equal(result.observations.featheredPixelCount, 1);
});

test("background preparation is content-addressed and preserves source lineage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-white-alpha-"));
  const sourceImage = rgba(2, 2, [
    255, 255, 255, 255,
    40, 20, 10, 255,
    255, 255, 255, 255,
    40, 20, 10, 255,
  ]);
  const source = await storeAssetObject(root, {
    bytes: encodeRgba8Image(sourceImage),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {},
  });
  const result = await executeImageBorderWhiteAlphaOperation(root, {
    parameters: { backgroundFloor: 224, transparentAbove: 250 },
    inputs: { source: source.asset },
  });
  const output = parseRgba8Image(await resolveAssetObject(root, result.outputs.output));
  assert.equal(output.pixels[3], 0);
  assert.equal(output.pixels[7], 255);
  assert.equal(result.outputs.output.metadata.sourceSha256, source.asset.sha256);
  assert.equal(result.observations.algorithm, "border-connected-min-rgb-feather-v1");
});

test("background thresholds fail closed", () => {
  assert.throws(
    () =>
      borderWhiteToAlphaRgba8(rgba(1, 1, [255, 255, 255, 255]), {
        backgroundFloor: 250,
        transparentAbove: 250,
      }),
    /backgroundFloor must be less than/,
  );
});
