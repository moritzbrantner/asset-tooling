export type RgbaBytes = readonly [number, number, number, number];
export type NoiseParameters = {width:number;height:number;seed:string;mode?:"grayscale"|"rgb"};
export type GradientDirection = "horizontal"|"vertical"|"diagonal-down"|"diagonal-up";
export type GradientParameters = {width:number;height:number;direction:GradientDirection;startColor:RgbaBytes;endColor:RgbaBytes};
export type PatternKind = "checker"|"stripes-horizontal"|"stripes-vertical"|"stripes-diagonal-down"|"stripes-diagonal-up";
export type PatternParameters = {width:number;height:number;pattern:PatternKind;size:number;colors:readonly [RgbaBytes,RgbaBytes]};
export type VoronoiParameters = {width:number;height:number;seed:string;cellSize:number;mode:"cells"|"distance"};

const MAX_DIMENSION = 4096;
const MAX_PATTERN_SIZE = 1024;
const MAX_CELL_SIZE = 512;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;
const NOISE_MODES = new Set(["grayscale", "rgb"]);
const GRADIENT_DIRECTIONS = new Set([
  "horizontal",
  "vertical",
  "diagonal-down",
  "diagonal-up",
]);
const PATTERN_KINDS = new Set([
  "checker",
  "stripes-horizontal",
  "stripes-vertical",
  "stripes-diagonal-down",
  "stripes-diagonal-up",
]);
const VORONOI_MODES = new Set(["cells", "distance"]);

function integer(value: unknown, location: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function dimension(value: unknown, location: string) {
  return integer(value, location, 1, MAX_DIMENSION);
}

function channel(value: unknown, location: string) {
  return integer(value, location, 0, 255);
}

function rgba(value: unknown, location: string): RgbaBytes {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${location} must contain exactly four RGBA8 channels`);
  }
  return [channel(value[0], `${location}[0]`), channel(value[1], `${location}[1]`), channel(value[2], `${location}[2]`), channel(value[3], `${location}[3]`)];
}

function colorPair(value: unknown, location: string): readonly [RgbaBytes,RgbaBytes] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${location} must contain exactly two RGBA8 colors`);
  }
  return [rgba(value[0], `${location}[0]`), rgba(value[1], `${location}[1]`)];
}

function normalizedSeed(seed: unknown) {
  if (typeof seed !== "string" || !SEED_PATTERN.test(seed)) {
    throw new Error("seed must be a non-negative decimal integer string");
  }
  return seed;
}

function fnv1a32(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function avalanche32(value: number) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function coordinateHash32(seedHash: number, x: number, y: number, component: number) {
  const mixed =
    seedHash ^
    Math.imul(x + 1, 0x9e3779b1) ^
    Math.imul(y + 1, 0x85ebca6b) ^
    Math.imul(component + 1, 0xc2b2ae35);
  return avalanche32(mixed);
}

function coordinateNoiseByte(seedHash: number, x: number, y: number, component: number) {
  return coordinateHash32(seedHash, x, y, component) >>> 24;
}

function roundRatioSigned(numerator: number, denominator: number) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
}

function gradientPosition(direction: GradientDirection, x: number, y: number, width: number, height: number) {
  if (direction === "horizontal") return { numerator: x, denominator: width - 1 };
  if (direction === "vertical") return { numerator: y, denominator: height - 1 };
  if (direction === "diagonal-down") {
    return { numerator: x + y, denominator: width + height - 2 };
  }
  if (direction === "diagonal-up") return { numerator: x + (height - 1 - y), denominator: width + height - 2 };
  const unreachable: never = direction; throw new Error(`unsupported gradient direction ${unreachable}`);
}

function patternIndex(pattern: PatternKind, x: number, y: number, size: number) {
  if (pattern === "checker") {
    return (Math.floor(x / size) + Math.floor(y / size)) & 1;
  }
  if (pattern === "stripes-horizontal") return Math.floor(y / size) & 1;
  if (pattern === "stripes-vertical") return Math.floor(x / size) & 1;
  if (pattern === "stripes-diagonal-down") return Math.floor((x + y) / size) & 1;
  if (pattern === "stripes-diagonal-up") return Math.floor((x - y) / size) & 1;
  const unreachable: never = pattern; throw new Error(`unsupported pattern ${unreachable}`);
}

function integerSqrt(value: number) {
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

function featurePoint(seedHash: number, cellX: number, cellY: number, cellSize: number) {
  return {
    x: cellX * cellSize + (coordinateHash32(seedHash, cellX, cellY, 0) % cellSize),
    y: cellY * cellSize + (coordinateHash32(seedHash, cellX, cellY, 1) % cellSize),
  };
}

function nearestFeature(seedHash: number, x: number, y: number, cellSize: number) {
  const originCellX = Math.floor(x / cellSize);
  const originCellY = Math.floor(y / cellSize);
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestCellX = 0;
  let bestCellY = 0;

  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    const cellY = originCellY + offsetY;
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      const cellX = originCellX + offsetX;
      const feature = featurePoint(seedHash, cellX, cellY, cellSize);
      const deltaX = x - feature.x;
      const deltaY = y - feature.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      const isTie = distanceSquared === bestDistanceSquared;
      if (
        distanceSquared < bestDistanceSquared ||
        (isTie && (cellY < bestCellY || (cellY === bestCellY && cellX < bestCellX)))
      ) {
        bestDistanceSquared = distanceSquared;
        bestCellX = cellX;
        bestCellY = cellY;
      }
    }
  }

  return { distanceSquared: bestDistanceSquared, cellX: bestCellX, cellY: bestCellY };
}

export function generateNoiseRgba8({ width, height, seed, mode = "grayscale" }: NoiseParameters) {
  const imageWidth = dimension(width, "noise width");
  const imageHeight = dimension(height, "noise height");
  const seedHash = fnv1a32(normalizedSeed(seed));
  if (!NOISE_MODES.has(mode)) {
    throw new Error("noise mode must be 'grayscale' or 'rgb'");
  }
  const output = Buffer.alloc(imageWidth * imageHeight * 4);

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = (y * imageWidth + x) * 4;
      if (mode === "grayscale") {
        const value = coordinateNoiseByte(seedHash, x, y, 0);
        output[offset] = value;
        output[offset + 1] = value;
        output[offset + 2] = value;
      } else if (mode === "rgb") {
        output[offset] = coordinateNoiseByte(seedHash, x, y, 0);
        output[offset + 1] = coordinateNoiseByte(seedHash, x, y, 1);
        output[offset + 2] = coordinateNoiseByte(seedHash, x, y, 2);
      } else {
        const unreachable: never = mode;
        throw new Error(`unsupported noise mode ${unreachable}`);
      }
      output[offset + 3] = 255;
    }
  }

  return { width: imageWidth, height: imageHeight, pixels: output };
}

export function generateLinearGradientRgba8({
  width,
  height,
  direction,
  startColor,
  endColor,
}: GradientParameters) {
  const imageWidth = dimension(width, "gradient width");
  const imageHeight = dimension(height, "gradient height");
  if (!GRADIENT_DIRECTIONS.has(direction)) {
    throw new Error(
      "gradient direction must be 'horizontal', 'vertical', 'diagonal-down', or 'diagonal-up'",
    );
  }
  const start = rgba(startColor, "gradient startColor");
  const end = rgba(endColor, "gradient endColor");
  const output = Buffer.alloc(imageWidth * imageHeight * 4);

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const { numerator, denominator } = gradientPosition(
        direction,
        x,
        y,
        imageWidth,
        imageHeight,
      );
      const offset = (y * imageWidth + x) * 4;
      for (let component = 0; component < 4; component += 1) {
        output[offset + component] =
          denominator === 0
            ? start[component]!
            : start[component]! +
              roundRatioSigned((end[component]! - start[component]!) * numerator, denominator);
      }
    }
  }

  return { width: imageWidth, height: imageHeight, pixels: output };
}

export function generatePatternRgba8({ width, height, pattern, size, colors }: PatternParameters) {
  const imageWidth = dimension(width, "pattern width");
  const imageHeight = dimension(height, "pattern height");
  if (!PATTERN_KINDS.has(pattern)) {
    throw new Error(
      "pattern must be checker, stripes-horizontal, stripes-vertical, stripes-diagonal-down, or stripes-diagonal-up",
    );
  }
  const patternSize = integer(size, "pattern size", 1, MAX_PATTERN_SIZE);
  const normalizedColors = colorPair(colors, "pattern colors");
  const output = Buffer.alloc(imageWidth * imageHeight * 4);

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const color = normalizedColors[patternIndex(pattern, x, y, patternSize)]!;
      const offset = (y * imageWidth + x) * 4;
      for (let component = 0; component < 4; component += 1) {
        output[offset + component] = color[component]!;
      }
    }
  }

  return { width: imageWidth, height: imageHeight, pixels: output };
}

export function generateVoronoiRgba8({ width, height, seed, cellSize, mode }: VoronoiParameters) {
  const imageWidth = dimension(width, "Voronoi width");
  const imageHeight = dimension(height, "Voronoi height");
  const seedHash = fnv1a32(normalizedSeed(seed));
  const normalizedCellSize = integer(cellSize, "Voronoi cellSize", 1, MAX_CELL_SIZE);
  if (!VORONOI_MODES.has(mode)) {
    throw new Error("Voronoi mode must be 'cells' or 'distance'");
  }
  const output = Buffer.alloc(imageWidth * imageHeight * 4);

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const nearest = nearestFeature(seedHash, x, y, normalizedCellSize);
      const offset = (y * imageWidth + x) * 4;
      if (mode === "distance") {
        const distance = Math.min(integerSqrt(nearest.distanceSquared), normalizedCellSize);
        const value = roundRatioSigned(distance * 255, normalizedCellSize);
        output[offset] = value;
        output[offset + 1] = value;
        output[offset + 2] = value;
      } else if (mode === "cells") {
        output[offset] = coordinateNoiseByte(seedHash, nearest.cellX, nearest.cellY, 2);
        output[offset + 1] = coordinateNoiseByte(seedHash, nearest.cellX, nearest.cellY, 3);
        output[offset + 2] = coordinateNoiseByte(seedHash, nearest.cellX, nearest.cellY, 4);
      } else {
        const unreachable: never = mode;
        throw new Error(`unsupported Voronoi mode ${unreachable}`);
      }
      output[offset + 3] = 255;
    }
  }

  return { width: imageWidth, height: imageHeight, pixels: output };
}
