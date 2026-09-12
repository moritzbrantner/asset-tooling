import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject } from "../src/asset-store.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { generateLinearGradientRgba8, generateNoiseRgba8 } from "../src/procedural-image.js";
import {
  PROCEDURAL_IMAGE_OPERATIONS,
  createProceduralImageNoiseOperationBuildIdentity,
  executeProceduralImageGradientOperation,
  executeProceduralImageNoiseOperation,
} from "../src/procedural-image-operations.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

test("procedural image operation registry is deterministic and typed", () => {
  assert.deepEqual(
    PROCEDURAL_IMAGE_OPERATIONS.map((operation) => operation.id),
    ["image.procedural.gradient", "image.procedural.noise"],
  );
  for (const operation of PROCEDURAL_IMAGE_OPERATIONS) {
    assert.deepEqual(operation.inputs, []);
    assert.deepEqual(operation.outputs[0].assetKinds, ["image"]);
    assert.deepEqual(operation.outputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  }
});

test("seeded grayscale coordinate noise pins exact bytes", () => {
  const output = generateNoiseRgba8({ width: 2, height: 2, seed: "42", mode: "grayscale" });
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(50, 50, 50),
      pixel(78, 78, 78),
      pixel(143, 143, 143),
      pixel(27, 27, 27),
    ),
  );
});

test("RGB noise derives channels independently and seed changes output", () => {
  const first = generateNoiseRgba8({ width: 2, height: 1, seed: "42", mode: "rgb" });
  assert.deepEqual(first.pixels, pixels(pixel(50, 35, 146), pixel(78, 252, 215)));
  const second = generateNoiseRgba8({ width: 2, height: 1, seed: "43", mode: "rgb" });
  assert.notDeepEqual(second.pixels, first.pixels);
});

test("linear gradients include exact endpoint colors with integer interpolation", () => {
  const output = generateLinearGradientRgba8({
    width: 3,
    height: 1,
    direction: "horizontal",
    startColor: [0, 10, 20, 30],
    endColor: [255, 110, 220, 230],
  });
  assert.deepEqual(
    output.pixels,
    pixels(pixel(0, 10, 20, 30), pixel(128, 60, 120, 130), pixel(255, 110, 220, 230)),
  );
});

test("diagonal gradient orientation is explicit and deterministic", () => {
  const down = generateLinearGradientRgba8({
    width: 2,
    height: 2,
    direction: "diagonal-down",
    startColor: [0, 0, 0, 255],
    endColor: [200, 200, 200, 255],
  });
  assert.deepEqual(
    down.pixels,
    pixels(pixel(0, 0, 0), pixel(100, 100, 100), pixel(100, 100, 100), pixel(200, 200, 200)),
  );

  const up = generateLinearGradientRgba8({
    width: 2,
    height: 2,
    direction: "diagonal-up",
    startColor: [0, 0, 0, 255],
    endColor: [200, 200, 200, 255],
  });
  assert.deepEqual(
    up.pixels,
    pixels(pixel(100, 100, 100), pixel(200, 200, 200), pixel(0, 0, 0), pixel(100, 100, 100)),
  );
});

test("procedural noise build identity binds explicit seed and algorithm", async () => {
  const build = await createProceduralImageNoiseOperationBuildIdentity({
    parameters: { seed: "42", width: 2, height: 2, mode: "grayscale" },
  });
  assert.deepEqual(build.operation, { id: "image.procedural.noise", version: "1" });
  assert.equal(build.parameters.seed, "42");
  assert.equal(build.implementation.randomness, "seeded");
  assert.equal(build.implementation.algorithm, "fnv1a32-coordinate-avalanche-rgba8-v1");
});

test("procedural image execution is content-addressed and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-image-"));
  const invocation = {
    parameters: { seed: "42", width: 2, height: 2, mode: "grayscale" },
  };
  const first = await executeProceduralImageNoiseOperation(root, invocation);
  const second = await executeProceduralImageNoiseOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.deepEqual(first.observations, second.observations);
  assert.equal(first.outputs.output.mediaType, RGBA8_IMAGE_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.generator, "image.procedural.noise@1");
  const image = parseRgba8Image(await resolveAssetObject(root, first.outputs.output));
  assert.deepEqual(
    image.pixels,
    pixels(
      pixel(50, 50, 50),
      pixel(78, 78, 78),
      pixel(143, 143, 143),
      pixel(27, 27, 27),
    ),
  );
});

test("gradient execution produces canonical RGBA8 output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-image-"));
  const result = await executeProceduralImageGradientOperation(root, {
    parameters: {
      width: 2,
      height: 1,
      direction: "horizontal",
      startColor: [10, 20, 30, 40],
      endColor: [50, 60, 70, 80],
    },
  });
  const image = parseRgba8Image(await resolveAssetObject(root, result.outputs.output));
  assert.deepEqual(image.pixels, pixels(pixel(10, 20, 30, 40), pixel(50, 60, 70, 80)));
  assert.equal(result.observations.randomness, "none");
});

test("procedural image parameters fail closed", async () => {
  await assert.rejects(
    () =>
      createProceduralImageNoiseOperationBuildIdentity({
        parameters: { seed: "0042", width: 1, height: 1, mode: "grayscale" },
      }),
    /non-negative decimal integer string/,
  );
  assert.throws(
    () =>
      generateLinearGradientRgba8({
        width: 1,
        height: 1,
        direction: "radial",
        startColor: [0, 0, 0, 255],
        endColor: [255, 255, 255, 255],
      }),
    /gradient direction/,
  );
});
