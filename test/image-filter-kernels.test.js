import test from "node:test";
import assert from "node:assert/strict";
import {
  contrastRgba8,
  exposureRgba8,
  grayscaleRgba8,
  levelsRgba8,
  lumaRgba8,
  thresholdRgba8,
} from "../src/image-color.js";
import {
  boxBlurRgba8,
  convolveRgba8,
  normalizeConvolutionKernel,
  sharpenRgba8,
} from "../src/image-convolution.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

function image(width, height, ...values) {
  return { width, height, pixels: pixels(...values) };
}

test("Q8 Rec.709 luma is deterministic", () => {
  assert.equal(lumaRgba8(255, 0, 0), 54);
  assert.equal(lumaRgba8(0, 255, 0), 182);
  assert.equal(lumaRgba8(0, 0, 255), 19);
  assert.equal(lumaRgba8(255, 255, 255), 255);
});

test("exposure and contrast use rational integer transforms and preserve alpha", () => {
  const source = image(1, 1, pixel(64, 128, 200, 17));
  assert.deepEqual(
    exposureRgba8(source, 2, 1).pixels,
    pixels(pixel(128, 255, 255, 17)),
  );
  assert.deepEqual(
    contrastRgba8(source, 2, 1).pixels,
    pixels(pixel(0, 128, 255, 17)),
  );
});

test("levels remaps explicit endpoints with integer interpolation", () => {
  const source = image(3, 1, pixel(32, 32, 32), pixel(128, 128, 128), pixel(224, 224, 224));
  const output = levelsRgba8(source, {
    blackPoint: 32,
    whitePoint: 224,
    outputBlack: 10,
    outputWhite: 250,
  });
  assert.deepEqual(
    output.pixels,
    pixels(pixel(10, 10, 10), pixel(130, 130, 130), pixel(250, 250, 250)),
  );
});

test("grayscale and threshold share the same luma rule", () => {
  const source = image(2, 1, pixel(255, 0, 0, 12), pixel(0, 255, 0, 34));
  assert.deepEqual(
    grayscaleRgba8(source).pixels,
    pixels(pixel(54, 54, 54, 12), pixel(182, 182, 182, 34)),
  );
  assert.deepEqual(
    thresholdRgba8(source, 128).pixels,
    pixels(pixel(0, 0, 0, 12), pixel(255, 255, 255, 34)),
  );
});

test("generic convolution validates bounded odd kernels and preserves alpha on request", () => {
  assert.throws(
    () => normalizeConvolutionKernel({ width: 2, height: 1, weights: [1, 1], divisor: 2 }),
    /odd/,
  );
  const source = image(1, 1, pixel(10, 20, 30, 40));
  const identity = convolveRgba8(
    source,
    { width: 1, height: 1, weights: [1], divisor: 1, bias: 0 },
    { alphaMode: "preserve" },
  );
  assert.deepEqual(identity.pixels, source.pixels);
});

test("box blur convolves premultiplied color and alpha", () => {
  const source = image(
    3,
    1,
    pixel(255, 0, 0, 0),
    pixel(0, 0, 255, 255),
    pixel(255, 0, 0, 0),
  );
  const output = boxBlurRgba8(source, 1);
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(0, 0, 255, 85),
      pixel(0, 0, 255, 85),
      pixel(0, 0, 255, 85),
    ),
  );
});

test("sharpen leaves a constant image unchanged and preserves alpha", () => {
  const source = image(
    3,
    1,
    pixel(40, 50, 60, 10),
    pixel(40, 50, 60, 20),
    pixel(40, 50, 60, 30),
  );
  assert.deepEqual(sharpenRgba8(source, 1, 1).pixels, source.pixels);
});
