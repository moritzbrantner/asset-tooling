import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMaskRgba8,
  mapPaletteRgba8,
  morphologyRgba8,
  orderedDitherRgba8,
  sobelEdgesRgba8,
  uniformQuantizeRgba8,
} from "../src/image-advanced.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

function image(width, height, ...values) {
  return { width, height, pixels: pixels(...values) };
}

test("Sobel emits zero magnitude for a constant image and preserves alpha", () => {
  const source = image(
    2,
    2,
    pixel(80, 80, 80, 10), pixel(80, 80, 80, 20),
    pixel(80, 80, 80, 30), pixel(80, 80, 80, 40),
  );
  assert.deepEqual(
    sobelEdgesRgba8(source).pixels,
    pixels(pixel(0, 0, 0, 10), pixel(0, 0, 0, 20), pixel(0, 0, 0, 30), pixel(0, 0, 0, 40)),
  );
});

test("Sobel saturates a full black-white step to full-strength edge magnitude", () => {
  const source = image(
    3,
    3,
    pixel(0, 0, 0), pixel(0, 0, 0), pixel(255, 255, 255),
    pixel(0, 0, 0), pixel(0, 0, 0), pixel(255, 255, 255),
    pixel(0, 0, 0), pixel(0, 0, 0), pixel(255, 255, 255),
  );
  const output = sobelEdgesRgba8(source);
  assert.deepEqual(
    Array.from(output.pixels.subarray((1 * 3 + 1) * 4, (1 * 3 + 1) * 4 + 4)),
    pixel(255, 255, 255),
  );
});

test("luma morphology dilates and erodes a bounded neighborhood", () => {
  const source = image(3, 1, pixel(0, 0, 0), pixel(128, 128, 128), pixel(255, 255, 255));
  assert.deepEqual(
    morphologyRgba8(source, { mode: "dilate", channel: "luma", radius: 1 }).pixels,
    pixels(pixel(128, 128, 128), pixel(255, 255, 255), pixel(255, 255, 255)),
  );
  assert.deepEqual(
    morphologyRgba8(source, { mode: "erode", channel: "luma", radius: 1 }).pixels,
    pixels(pixel(0, 0, 0), pixel(0, 0, 0), pixel(128, 128, 128)),
  );
});

test("alpha morphology changes alpha without changing RGB", () => {
  const source = image(3, 1, pixel(10, 20, 30, 0), pixel(40, 50, 60, 128), pixel(70, 80, 90, 255));
  assert.deepEqual(
    morphologyRgba8(source, { mode: "dilate", channel: "alpha", radius: 1 }).pixels,
    pixels(pixel(10, 20, 30, 128), pixel(40, 50, 60, 255), pixel(70, 80, 90, 255)),
  );
});

test("mask application multiplies source alpha by exact mask luma", () => {
  const source = image(1, 1, pixel(12, 34, 56, 200));
  const mask = image(1, 1, pixel(128, 128, 128, 255));
  assert.deepEqual(
    applyMaskRgba8(source, mask, "luma").pixels,
    pixels(pixel(12, 34, 56, 100)),
  );
});

test("uniform quantization maps RGB to the requested bit grid", () => {
  const source = image(4, 1, pixel(0, 0, 0), pixel(64, 64, 64), pixel(128, 128, 128), pixel(255, 255, 255));
  assert.deepEqual(
    uniformQuantizeRgba8(source, 2).pixels,
    pixels(pixel(0, 0, 0), pixel(85, 85, 85), pixel(170, 170, 170), pixel(255, 255, 255)),
  );
});

test("explicit palette mapping uses ordered first-entry tie breaking", () => {
  const source = image(1, 1, pixel(1, 0, 0, 77));
  assert.deepEqual(
    mapPaletteRgba8(source, [[0, 0, 0], [2, 0, 0]]).pixels,
    pixels(pixel(0, 0, 0, 77)),
  );
});

test("ordered one-bit dithering follows the fixed Bayer 4x4 threshold order", () => {
  const values = Array.from({ length: 16 }, () => pixel(128, 128, 128));
  const output = orderedDitherRgba8(image(4, 4, ...values), 1);
  assert.deepEqual(
    output.pixels,
    pixels(
      pixel(255, 255, 255), pixel(0, 0, 0), pixel(255, 255, 255), pixel(0, 0, 0),
      pixel(0, 0, 0), pixel(255, 255, 255), pixel(0, 0, 0), pixel(255, 255, 255),
      pixel(255, 255, 255), pixel(0, 0, 0), pixel(255, 255, 255), pixel(0, 0, 0),
      pixel(0, 0, 0), pixel(255, 255, 255), pixel(0, 0, 0), pixel(255, 255, 255),
    ),
  );
});
