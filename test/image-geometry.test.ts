import test from "node:test";
import assert from "node:assert/strict";
import {
  cropRgba8,
  flipRgba8,
  padRgba8,
  resizeRgba8Bilinear,
  resizeRgba8Nearest,
  rotateRgba8QuarterTurns,
} from "../src/image-geometry.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

function image(width, height, ...values) {
  return { width, height, pixels: pixels(...values) };
}

test("nearest resize uses deterministic center mapping", () => {
  const source = image(
    2,
    2,
    pixel(255, 0, 0),
    pixel(0, 255, 0),
    pixel(0, 0, 255),
    pixel(255, 255, 255),
  );
  const resized = resizeRgba8Nearest(source, 4, 4);
  assert.deepEqual(
    resized.pixels,
    pixels(
      pixel(255, 0, 0), pixel(255, 0, 0), pixel(0, 255, 0), pixel(0, 255, 0),
      pixel(255, 0, 0), pixel(255, 0, 0), pixel(0, 255, 0), pixel(0, 255, 0),
      pixel(0, 0, 255), pixel(0, 0, 255), pixel(255, 255, 255), pixel(255, 255, 255),
      pixel(0, 0, 255), pixel(0, 0, 255), pixel(255, 255, 255), pixel(255, 255, 255),
    ),
  );
});

test("bilinear resize uses exact rational center weights", () => {
  const source = image(2, 1, pixel(0, 0, 0), pixel(255, 255, 255));
  const resized = resizeRgba8Bilinear(source, 3, 1);
  assert.deepEqual(
    resized.pixels,
    pixels(pixel(0, 0, 0), pixel(128, 128, 128), pixel(255, 255, 255)),
  );
});

test("bilinear resize interpolates straight-alpha images through premultiplied color", () => {
  const source = image(2, 1, pixel(255, 0, 0, 0), pixel(0, 0, 255, 255));
  const resized = resizeRgba8Bilinear(source, 3, 1);
  assert.deepEqual(
    resized.pixels,
    pixels(pixel(0, 0, 0, 0), pixel(0, 0, 255, 128), pixel(0, 0, 255, 255)),
  );
});

test("crop copies the requested in-bounds rectangle", () => {
  const source = image(
    3,
    2,
    pixel(1, 0, 0), pixel(2, 0, 0), pixel(3, 0, 0),
    pixel(4, 0, 0), pixel(5, 0, 0), pixel(6, 0, 0),
  );
  const cropped = cropRgba8(source, { x: 1, y: 0, width: 2, height: 2 });
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.deepEqual(
    cropped.pixels,
    pixels(pixel(2, 0, 0), pixel(3, 0, 0), pixel(5, 0, 0), pixel(6, 0, 0)),
  );
  assert.throws(
    () => cropRgba8(source, { x: 2, y: 0, width: 2, height: 1 }),
    /stay inside/,
  );
});

test("pad fills exactly outside the copied source rectangle", () => {
  const source = image(1, 1, pixel(10, 20, 30, 40));
  const padded = padRgba8(source, {
    left: 1,
    right: 1,
    top: 1,
    bottom: 0,
    color: [1, 2, 3, 4],
  });
  assert.equal(padded.width, 3);
  assert.equal(padded.height, 2);
  assert.deepEqual(
    padded.pixels,
    pixels(
      pixel(1, 2, 3, 4), pixel(1, 2, 3, 4), pixel(1, 2, 3, 4),
      pixel(1, 2, 3, 4), pixel(10, 20, 30, 40), pixel(1, 2, 3, 4),
    ),
  );
});

test("quarter-turn rotation maps rectangular dimensions and pixels exactly", () => {
  const source = image(
    2,
    3,
    pixel(1, 0, 0), pixel(2, 0, 0),
    pixel(3, 0, 0), pixel(4, 0, 0),
    pixel(5, 0, 0), pixel(6, 0, 0),
  );
  const rotated = rotateRgba8QuarterTurns(source, 1);
  assert.equal(rotated.width, 3);
  assert.equal(rotated.height, 2);
  assert.deepEqual(
    rotated.pixels,
    pixels(
      pixel(5, 0, 0), pixel(3, 0, 0), pixel(1, 0, 0),
      pixel(6, 0, 0), pixel(4, 0, 0), pixel(2, 0, 0),
    ),
  );
});

test("flip supports horizontal, vertical, and both axes", () => {
  const source = image(
    2,
    2,
    pixel(1, 0, 0), pixel(2, 0, 0),
    pixel(3, 0, 0), pixel(4, 0, 0),
  );
  assert.deepEqual(
    flipRgba8(source, "horizontal").pixels,
    pixels(pixel(2, 0, 0), pixel(1, 0, 0), pixel(4, 0, 0), pixel(3, 0, 0)),
  );
  assert.deepEqual(
    flipRgba8(source, "vertical").pixels,
    pixels(pixel(3, 0, 0), pixel(4, 0, 0), pixel(1, 0, 0), pixel(2, 0, 0)),
  );
  assert.deepEqual(
    flipRgba8(source, "both").pixels,
    pixels(pixel(4, 0, 0), pixel(3, 0, 0), pixel(2, 0, 0), pixel(1, 0, 0)),
  );
});
