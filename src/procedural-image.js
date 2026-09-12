const MAX_DIMENSION = 4096;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;
const NOISE_MODES = new Set(["grayscale", "rgb"]);
const GRADIENT_DIRECTIONS = new Set([
  "horizontal",
  "vertical",
  "diagonal-down",
  "diagonal-up",
]);

function dimension(value, location) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error(`${location} must be an integer in 1..${MAX_DIMENSION}`);
  }
  return value;
}

function channel(value, location) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`${location} must be an integer in 0..255`);
  }
  return value;
}

function rgba(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${location} must contain exactly four RGBA8 channels`);
  }
  return value.map((entry, index) => channel(entry, `${location}[${index}]`));
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

function coordinateNoiseByte(seedHash, x, y, component) {
  const mixed =
    seedHash ^
    Math.imul(x + 1, 0x9e3779b1) ^
    Math.imul(y + 1, 0x85ebca6b) ^
    Math.imul(component + 1, 0xc2b2ae35);
  return avalanche32(mixed) >>> 24;
}

function roundRatioSigned(numerator, denominator) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
}

function gradientPosition(direction, x, y, width, height) {
  if (direction === "horizontal") return { numerator: x, denominator: width - 1 };
  if (direction === "vertical") return { numerator: y, denominator: height - 1 };
  if (direction === "diagonal-down") {
    return { numerator: x + y, denominator: width + height - 2 };
  }
  return { numerator: x + (height - 1 - y), denominator: width + height - 2 };
}

export function generateNoiseRgba8({ width, height, seed, mode = "grayscale" }) {
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
      } else {
        output[offset] = coordinateNoiseByte(seedHash, x, y, 0);
        output[offset + 1] = coordinateNoiseByte(seedHash, x, y, 1);
        output[offset + 2] = coordinateNoiseByte(seedHash, x, y, 2);
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
}) {
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
            ? start[component]
            : start[component] +
              roundRatioSigned((end[component] - start[component]) * numerator, denominator);
      }
    }
  }

  return { width: imageWidth, height: imageHeight, pixels: output };
}
