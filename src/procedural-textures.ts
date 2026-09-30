import { lumaRgba8 } from "./image-color.js";
import { assertRgba8Image } from "./image-geometry.js";

const MAX_DIMENSION = 4096;
const MAX_GRID = 256;
const MAX_STRENGTH = 1024;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;
const TEXTURE_MODES = new Set(["grayscale", "rgb"]);

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function dimension(value, location) {
  return integer(value, location, 1, MAX_DIMENSION);
}

function normalizedSeed(seed) {
  if (typeof seed !== "string" || !SEED_PATTERN.test(seed)) {
    throw new Error("seed must be a non-negative decimal integer string");
  }
  return seed;
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function avalanche32(value) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function coordinateHash32(seedHash, x, y, component) {
  const mixed =
    seedHash ^
    Math.imul(x + 1, 0x9e3779b1) ^
    Math.imul(y + 1, 0x85ebca6b) ^
    Math.imul(component + 1, 0xc2b2ae35);
  return avalanche32(mixed);
}

function roundRatioSigned(numerator, denominator) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
}

function lerpInteger(start, end, numerator, denominator) {
  return start + roundRatioSigned((end - start) * numerator, denominator);
}

function latticeByte(seedHash, cellX, cellY, gridX, gridY, component) {
  const wrappedX = ((cellX % gridX) + gridX) % gridX;
  const wrappedY = ((cellY % gridY) + gridY) % gridY;
  return coordinateHash32(seedHash, wrappedX, wrappedY, component) >>> 24;
}

function valueNoiseByte(seedHash, x, y, width, height, gridX, gridY, component) {
  const phaseX = x * gridX;
  const phaseY = y * gridY;
  const cellX = Math.floor(phaseX / width);
  const cellY = Math.floor(phaseY / height);
  const fractionX = phaseX % width;
  const fractionY = phaseY % height;

  const top = lerpInteger(
    latticeByte(seedHash, cellX, cellY, gridX, gridY, component),
    latticeByte(seedHash, cellX + 1, cellY, gridX, gridY, component),
    fractionX,
    width,
  );
  const bottom = lerpInteger(
    latticeByte(seedHash, cellX, cellY + 1, gridX, gridY, component),
    latticeByte(seedHash, cellX + 1, cellY + 1, gridX, gridY, component),
    fractionX,
    width,
  );
  return lerpInteger(top, bottom, fractionY, height);
}

function normalizeGrid(value, limit, location) {
  return integer(value, location, 1, Math.min(MAX_GRID, limit));
}

export function generateTileableValueNoiseRgba8({
  width,
  height,
  seed,
  gridX,
  gridY,
  mode = "rgb",
}) {
  const imageWidth = dimension(width, "tileable texture width");
  const imageHeight = dimension(height, "tileable texture height");
  const normalizedGridX = normalizeGrid(gridX, imageWidth, "tileable texture gridX");
  const normalizedGridY = normalizeGrid(gridY, imageHeight, "tileable texture gridY");
  const seedHash = fnv1a32(normalizedSeed(seed));
  if (!TEXTURE_MODES.has(mode)) {
    throw new Error("tileable texture mode must be 'grayscale' or 'rgb'");
  }

  const output = Buffer.alloc(imageWidth * imageHeight * 4);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = (y * imageWidth + x) * 4;
      if (mode === "grayscale") {
        const value = valueNoiseByte(
          seedHash,
          x,
          y,
          imageWidth,
          imageHeight,
          normalizedGridX,
          normalizedGridY,
          0,
        );
        output[offset] = value;
        output[offset + 1] = value;
        output[offset + 2] = value;
      } else {
        for (let component = 0; component < 3; component += 1) {
          output[offset + component] = valueNoiseByte(
            seedHash,
            x,
            y,
            imageWidth,
            imageHeight,
            normalizedGridX,
            normalizedGridY,
            component,
          );
        }
      }
      output[offset + 3] = 255;
    }
  }

  return { width: imageWidth, height: imageHeight, pixels: output };
}

export function generateTileableHeightMapRgba8({ width, height, seed, gridX, gridY }) {
  return generateTileableValueNoiseRgba8({
    width,
    height,
    seed,
    gridX,
    gridY,
    mode: "grayscale",
  });
}

function integerSqrt(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("integer square root input must be a non-negative safe integer");
  }
  if (value < 2) return value;
  let low = 1;
  let high = value;
  let result = 1;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    if (midpoint <= Math.floor(value / midpoint)) {
      result = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return result;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function sampleHeight(source, x, y, wrap) {
  let sampleX = x;
  let sampleY = y;
  if (wrap) {
    sampleX = ((sampleX % source.width) + source.width) % source.width;
    sampleY = ((sampleY % source.height) + source.height) % source.height;
  } else {
    sampleX = Math.max(0, Math.min(source.width - 1, sampleX));
    sampleY = Math.max(0, Math.min(source.height - 1, sampleY));
  }
  const offset = (sampleY * source.width + sampleX) * 4;
  return lumaRgba8(
    source.pixels[offset],
    source.pixels[offset + 1],
    source.pixels[offset + 2],
  );
}

function encodeNormalComponent(component, length) {
  return clampByte(128 + roundRatioSigned(component * 127, length));
}

export function deriveNormalMapRgba8(sourceValue, { strength, wrap }) {
  const source = assertRgba8Image(sourceValue, "height source RGBA8 image");
  const normalizedStrength = integer(strength, "normal-map strength", 1, MAX_STRENGTH);
  if (typeof wrap !== "boolean") {
    throw new Error("normal-map wrap must be a boolean");
  }

  const output = Buffer.alloc(source.pixels.length);
  const baseZ = 510;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const left = sampleHeight(source, x - 1, y, wrap);
      const right = sampleHeight(source, x + 1, y, wrap);
      const up = sampleHeight(source, x, y - 1, wrap);
      const down = sampleHeight(source, x, y + 1, wrap);
      const normalX = (left - right) * normalizedStrength;
      const normalY = (up - down) * normalizedStrength;
      const normalZ = baseZ;
      const lengthSquared =
        normalX * normalX + normalY * normalY + normalZ * normalZ;
      const length = integerSqrt(lengthSquared);
      const offset = (y * source.width + x) * 4;
      output[offset] = encodeNormalComponent(normalX, length);
      output[offset + 1] = encodeNormalComponent(normalY, length);
      output[offset + 2] = encodeNormalComponent(normalZ, length);
      output[offset + 3] = 255;
    }
  }

  return { width: source.width, height: source.height, pixels: output };
}
