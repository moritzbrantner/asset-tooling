import { assertRgba8Image } from "./image-geometry.js";
import { lumaRgba8 } from "./image-color.js";

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function byte(value, location) {
  return integer(value, location, 0, 255);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampByte(value) {
  return clamp(value, 0, 255);
}

function roundRatio(numerator, denominator) {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function sourcePixelOffset(source, x, y) {
  const sourceX = clamp(x, 0, source.width - 1);
  const sourceY = clamp(y, 0, source.height - 1);
  return (sourceY * source.width + sourceX) * 4;
}

export function sobelEdgesRgba8(sourceValue) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const output = Buffer.alloc(source.pixels.length);
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let gx = 0;
      let gy = 0;
      let sampleIndex = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const offset = sourcePixelOffset(source, x + dx, y + dy);
          const luma = lumaRgba8(
            source.pixels[offset],
            source.pixels[offset + 1],
            source.pixels[offset + 2],
          );
          gx += luma * gxKernel[sampleIndex];
          gy += luma * gyKernel[sampleIndex];
          sampleIndex += 1;
        }
      }
      const magnitude = clampByte(roundRatio(Math.abs(gx) + Math.abs(gy), 8));
      const targetOffset = (y * source.width + x) * 4;
      output[targetOffset] = magnitude;
      output[targetOffset + 1] = magnitude;
      output[targetOffset + 2] = magnitude;
      output[targetOffset + 3] = source.pixels[targetOffset + 3];
    }
  }

  return { width: source.width, height: source.height, pixels: output };
}

export function morphologyRgba8(sourceValue, { mode, channel, radius }) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  if (!["dilate", "erode"].includes(mode)) {
    throw new Error("morphology mode must be 'dilate' or 'erode'");
  }
  if (!["luma", "alpha"].includes(channel)) {
    throw new Error("morphology channel must be 'luma' or 'alpha'");
  }
  const normalizedRadius = integer(radius, "morphology radius", 1, 3);
  const output = Buffer.alloc(source.pixels.length);

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let selected = mode === "dilate" ? 0 : 255;
      for (let dy = -normalizedRadius; dy <= normalizedRadius; dy += 1) {
        for (let dx = -normalizedRadius; dx <= normalizedRadius; dx += 1) {
          const offset = sourcePixelOffset(source, x + dx, y + dy);
          const candidate = channel === "alpha"
            ? source.pixels[offset + 3]
            : lumaRgba8(
                source.pixels[offset],
                source.pixels[offset + 1],
                source.pixels[offset + 2],
              );
          selected = mode === "dilate"
            ? Math.max(selected, candidate)
            : Math.min(selected, candidate);
        }
      }
      const targetOffset = (y * source.width + x) * 4;
      if (channel === "alpha") {
        output[targetOffset] = source.pixels[targetOffset];
        output[targetOffset + 1] = source.pixels[targetOffset + 1];
        output[targetOffset + 2] = source.pixels[targetOffset + 2];
        output[targetOffset + 3] = selected;
      } else {
        output[targetOffset] = selected;
        output[targetOffset + 1] = selected;
        output[targetOffset + 2] = selected;
        output[targetOffset + 3] = source.pixels[targetOffset + 3];
      }
    }
  }

  return { width: source.width, height: source.height, pixels: output };
}

export function applyMaskRgba8(sourceValue, maskValue, channel) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const mask = assertRgba8Image(maskValue, "mask RGBA8 image");
  if (source.width !== mask.width || source.height !== mask.height) {
    throw new Error("mask dimensions must exactly match source dimensions");
  }
  if (!["luma", "alpha"].includes(channel)) {
    throw new Error("mask channel must be 'luma' or 'alpha'");
  }
  const output = Buffer.from(source.pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    const maskValue_ = channel === "alpha"
      ? mask.pixels[offset + 3]
      : lumaRgba8(mask.pixels[offset], mask.pixels[offset + 1], mask.pixels[offset + 2]);
    output[offset + 3] = roundRatio(source.pixels[offset + 3] * maskValue_, 255);
  }
  return { width: source.width, height: source.height, pixels: output };
}

function quantizationSteps(bitsPerChannel) {
  const bits = integer(bitsPerChannel, "bitsPerChannel", 1, 8);
  return (1 << bits) - 1;
}

function quantizedByte(value, steps) {
  const index = roundRatio(value * steps, 255);
  return roundRatio(index * 255, steps);
}

export function uniformQuantizeRgba8(sourceValue, bitsPerChannel) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const steps = quantizationSteps(bitsPerChannel);
  const output = Buffer.from(source.pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    output[offset] = quantizedByte(source.pixels[offset], steps);
    output[offset + 1] = quantizedByte(source.pixels[offset + 1], steps);
    output[offset + 2] = quantizedByte(source.pixels[offset + 2], steps);
  }
  return { width: source.width, height: source.height, pixels: output };
}

export function normalizePalette(paletteValue) {
  if (!Array.isArray(paletteValue) || paletteValue.length < 1 || paletteValue.length > 256) {
    throw new Error("palette must contain 1..256 RGB colors");
  }
  return paletteValue.map((color, colorIndex) => {
    if (!Array.isArray(color) || color.length !== 3) {
      throw new Error(`palette[${colorIndex}] must contain exactly three RGB channels`);
    }
    return color.map((value, channelIndex) => byte(value, `palette[${colorIndex}][${channelIndex}]`));
  });
}

export function mapPaletteRgba8(sourceValue, paletteValue) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const palette = normalizePalette(paletteValue);
  const output = Buffer.from(source.pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < palette.length; index += 1) {
      const color = palette[index];
      const redDistance = source.pixels[offset] - color[0];
      const greenDistance = source.pixels[offset + 1] - color[1];
      const blueDistance = source.pixels[offset + 2] - color[2];
      const distance =
        redDistance * redDistance + greenDistance * greenDistance + blueDistance * blueDistance;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    output[offset] = palette[bestIndex][0];
    output[offset + 1] = palette[bestIndex][1];
    output[offset + 2] = palette[bestIndex][2];
  }
  return { width: source.width, height: source.height, pixels: output };
}

function orderedDitherByte(value, steps, matrixValue) {
  const scaled = value * steps;
  let index = Math.floor(scaled / 255);
  const remainder = scaled - index * 255;
  if (index < steps && remainder * 32 >= (2 * matrixValue + 1) * 255) {
    index += 1;
  }
  return roundRatio(index * 255, steps);
}

export function orderedDitherRgba8(sourceValue, bitsPerChannel) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const steps = quantizationSteps(bitsPerChannel);
  const output = Buffer.from(source.pixels);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const matrixValue = BAYER_4X4[(y % 4) * 4 + (x % 4)];
      output[offset] = orderedDitherByte(source.pixels[offset], steps, matrixValue);
      output[offset + 1] = orderedDitherByte(source.pixels[offset + 1], steps, matrixValue);
      output[offset + 2] = orderedDitherByte(source.pixels[offset + 2], steps, matrixValue);
    }
  }
  return { width: source.width, height: source.height, pixels: output };
}
