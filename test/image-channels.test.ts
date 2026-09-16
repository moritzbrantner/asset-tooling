import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { combineRgba8Channels, extractRgba8Channel } from "../src/image-channels.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "../src/image-rgba8.js";
import {
  executeImageChannelExtractOperation,
  executeImageChannelsCombineOperation,
} from "../src/image-channel-operations.js";

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

test("channel extraction emits opaque grayscale values", () => {
  const source = { width: 1, height: 1, pixels: pixels(pixel(10, 20, 30, 40)) };
  assert.deepEqual(extractRgba8Channel(source, "red").pixels, pixels(pixel(10, 10, 10, 255)));
  assert.deepEqual(extractRgba8Channel(source, "green").pixels, pixels(pixel(20, 20, 20, 255)));
  assert.deepEqual(extractRgba8Channel(source, "blue").pixels, pixels(pixel(30, 30, 30, 255)));
  assert.deepEqual(extractRgba8Channel(source, "alpha").pixels, pixels(pixel(40, 40, 40, 255)));
});

test("extracting and recombining RGBA channels round-trips exact source bytes", () => {
  const source = {
    width: 2,
    height: 1,
    pixels: pixels(pixel(10, 20, 30, 40), pixel(200, 150, 100, 50)),
  };
  const combined = combineRgba8Channels({
    red: extractRgba8Channel(source, "red"),
    green: extractRgba8Channel(source, "green"),
    blue: extractRgba8Channel(source, "blue"),
    alpha: extractRgba8Channel(source, "alpha"),
  });
  assert.deepEqual(combined.pixels, source.pixels);
});

test("channel operations preserve content-addressed lineage across extract/combine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-channels-"));
  const source = await storeImage(root, 1, 1, pixels(pixel(10, 20, 30, 40)));
  const extracted = {};
  for (const channel of ["red", "green", "blue", "alpha"]) {
    extracted[channel] = (
      await executeImageChannelExtractOperation(root, {
        parameters: { channel },
        inputs: { source },
      })
    ).outputs.output;
  }
  const combined = await executeImageChannelsCombineOperation(root, {
    inputs: extracted,
  });
  const output = parseRgba8Image(await resolveAssetObject(root, combined.outputs.output));
  assert.deepEqual(output.pixels, pixels(pixel(10, 20, 30, 40)));
  assert.deepEqual(
    combined.outputs.output.metadata.inputs.map((entry) => entry.port),
    ["red", "green", "blue", "alpha"],
  );
});

test("channel combine rejects mismatched dimensions before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-channels-"));
  const one = await storeImage(root, 1, 1, pixels(pixel(1, 1, 1)));
  const two = await storeImage(root, 2, 1, pixels(pixel(1, 1, 1), pixel(2, 2, 2)));
  await assert.rejects(
    () =>
      executeImageChannelsCombineOperation(root, {
        inputs: { red: one, green: one, blue: two, alpha: one },
      }),
    /dimensions must exactly match/,
  );
});
