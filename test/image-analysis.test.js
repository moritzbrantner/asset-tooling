import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { storeAssetObject } from "../src/asset-store.js";
import { histogramRgba8, inspectRgba8Image } from "../src/image-analysis.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image } from "../src/image-rgba8.js";
import {
  executeImageHistogramOperation,
  executeImageMetadataInspectOperation,
} from "../src/image-analysis-operations.js";

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

test("metadata inspection classifies alpha coverage exactly", () => {
  const source = {
    width: 3,
    height: 1,
    pixels: pixels(pixel(1, 2, 3, 0), pixel(4, 5, 6, 128), pixel(7, 8, 9, 255)),
  };
  assert.deepEqual(inspectRgba8Image(source), {
    width: 3,
    height: 1,
    pixelCount: 3,
    colorSpace: "srgb",
    alphaMode: "straight",
    opaquePixelCount: 1,
    transparentPixelCount: 1,
    translucentPixelCount: 1,
    minAlpha: 0,
    maxAlpha: 255,
  });
});

test("histogram measures exact channel and luma bins", () => {
  const source = {
    width: 2,
    height: 1,
    pixels: pixels(pixel(255, 0, 0, 0), pixel(0, 255, 0, 255)),
  };
  const histogram = histogramRgba8(source);
  assert.equal(histogram.pixelCount, 2);
  assert.equal(histogram.red[255], 1);
  assert.equal(histogram.red[0], 1);
  assert.equal(histogram.green[255], 1);
  assert.equal(histogram.green[0], 1);
  assert.equal(histogram.alpha[0], 1);
  assert.equal(histogram.alpha[255], 1);
  assert.equal(histogram.luma[54], 1);
  assert.equal(histogram.luma[182], 1);
  for (const bins of [histogram.red, histogram.green, histogram.blue, histogram.alpha, histogram.luma]) {
    assert.equal(bins.length, 256);
    assert.equal(bins.reduce((sum, count) => sum + count, 0), 2);
  }
});

test("analysis operations emit observations without creating graph assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-analysis-"));
  const source = await storeImage(
    root,
    2,
    1,
    pixels(pixel(255, 0, 0, 0), pixel(0, 255, 0, 255)),
  );
  const metadata = await executeImageMetadataInspectOperation(root, { inputs: { source } });
  assert.deepEqual(metadata.outputs, {});
  assert.equal(metadata.observations.pixelCount, 2);
  assert.equal(metadata.observations.sourceSha256, source.sha256);
  assert.equal(metadata.observations.sourceByteLength, source.byteLength);

  const histogram = await executeImageHistogramOperation(root, { inputs: { source } });
  assert.deepEqual(histogram.outputs, {});
  assert.equal(histogram.observations.red[255], 1);
  assert.equal(histogram.observations.green[255], 1);
  assert.equal(histogram.observations.sourceSha256, source.sha256);
});

test("repeated histogram analysis is byte-for-byte observation deterministic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-analysis-"));
  const source = await storeImage(root, 1, 1, pixels(pixel(10, 20, 30, 40)));
  const invocation = { inputs: { source } };
  const first = await executeImageHistogramOperation(root, invocation);
  const second = await executeImageHistogramOperation(root, invocation);
  assert.deepEqual(second, first);
});
