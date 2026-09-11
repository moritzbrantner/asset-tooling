import { assertRgba8Image } from "./image-geometry.js";

function byte(value, location) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`${location} must be an integer in 0..255`);
  }
  return value;
}

function positiveInteger(value, location, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${location} must be an integer in 1..${maximum}`);
  }
  return value;
}

function signedInteger(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function roundRatioSigned(numerator, denominator) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
}

export function lumaRgba8(red, green, blue) {
  return Math.floor((54 * red + 183 * green + 19 * blue + 128) / 256);
}

function mapRgb(sourceValue, mapper) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const output = Buffer.alloc(source.pixels.length);
  for (let offset = 0; offset < source.pixels.length; offset += 4) {
    const mapped = mapper(
      source.pixels[offset],
      source.pixels[offset + 1],
      source.pixels[offset + 2],
    );
    output[offset] = clampByte(mapped[0]);
    output[offset + 1] = clampByte(mapped[1]);
    output[offset + 2] = clampByte(mapped[2]);
    output[offset + 3] = source.pixels[offset + 3];
  }
  return { width: source.width, height: source.height, pixels: output };
}

export function exposureRgba8(sourceValue, numerator, denominator) {
  const gainNumerator = signedInteger(numerator, "exposure numerator", 0, 65535);
  const gainDenominator = positiveInteger(denominator, "exposure denominator", 65535);
  return mapRgb(sourceValue, (red, green, blue) =>
    [red, green, blue].map((value) =>
      clampByte(roundRatioSigned(value * gainNumerator, gainDenominator)),
    ),
  );
}

export function contrastRgba8(sourceValue, numerator, denominator) {
  const contrastNumerator = signedInteger(numerator, "contrast numerator", 0, 65535);
  const contrastDenominator = positiveInteger(denominator, "contrast denominator", 65535);
  return mapRgb(sourceValue, (red, green, blue) =>
    [red, green, blue].map((value) =>
      clampByte(128 + roundRatioSigned((value - 128) * contrastNumerator, contrastDenominator)),
    ),
  );
}

export function levelsRgba8(
  sourceValue,
  { blackPoint, whitePoint, outputBlack = 0, outputWhite = 255 },
) {
  const black = byte(blackPoint, "levels blackPoint");
  const white = byte(whitePoint, "levels whitePoint");
  const low = byte(outputBlack, "levels outputBlack");
  const high = byte(outputWhite, "levels outputWhite");
  if (black >= white) throw new Error("levels blackPoint must be less than whitePoint");
  if (low > high) throw new Error("levels outputBlack must not exceed outputWhite");
  const sourceRange = white - black;
  const outputRange = high - low;
  return mapRgb(sourceValue, (red, green, blue) =>
    [red, green, blue].map((value) => {
      if (value <= black) return low;
      if (value >= white) return high;
      return low + roundRatioSigned((value - black) * outputRange, sourceRange);
    }),
  );
}

export function grayscaleRgba8(sourceValue) {
  return mapRgb(sourceValue, (red, green, blue) => {
    const luma = lumaRgba8(red, green, blue);
    return [luma, luma, luma];
  });
}

export function thresholdRgba8(sourceValue, threshold) {
  const cutoff = byte(threshold, "threshold");
  return mapRgb(sourceValue, (red, green, blue) => {
    const value = lumaRgba8(red, green, blue) >= cutoff ? 255 : 0;
    return [value, value, value];
  });
}
