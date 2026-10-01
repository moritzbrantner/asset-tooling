import type { Rgba8Image } from "./image-rgba8.js";

import { assertRgba8Image } from "./image-geometry.js";
import { lumaRgba8 } from "./image-color.js";

// Indexed reads below follow validated image lengths and bounded channel/kernel loops.
const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function integer(value: unknown, location: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function byte(value: unknown, location: string) {
  return integer(value, location, 0, 255);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampByte(value: number) {
  return clamp(value, 0, 255);
}

function roundRatio(numerator: number, denominator: number) {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function sourcePixelOffset(source: Rgba8Image, x: number, y: number) {
  const sourceX = clamp(x, 0, source.width - 1);
  const sourceY = clamp(y, 0, source.height - 1);
  return (sourceY * source.width + sourceX) * 4;
}

export function sobelEdgesRgba8(sourceValue: unknown) {
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
            source.pixels[offset]!,
            source.pixels[offset + 1]!,
            source.pixels[offset + 2]!,
          );
          gx += luma * gxKernel[sampleIndex]!;
          gy += luma * gyKernel[sampleIndex]!;
          sampleIndex += 1;
        }
      }
      const magnitude = clampByte(Math.abs(gx) + Math.abs(gy));
      const targetOffset = (y * source.width + x) * 4;
      output[targetOffset] = magnitude;
      output[targetOffset + 1] = magnitude;
      output[targetOffset + 2] = magnitude;
      output[targetOffset + 3] = source.pixels[targetOffset + 3]!;
    }
  }

  return { width: source.width, height: source.height, pixels: output };
}

type MorphologyMode = "dilate" | "erode";
const MORPHOLOGY_RULES = {
  dilate: { initial: 0, combine: Math.max },
  erode: { initial: 255, combine: Math.min },
} satisfies Record<MorphologyMode, { initial: number; combine: (a: number, b: number) => number }>;

function maskChannelValue(source: Rgba8Image, offset: number, channel: "luma" | "alpha"): number {
  switch (channel) {
    case "alpha": return source.pixels[offset + 3]!;
    case "luma": return lumaRgba8(source.pixels[offset]!, source.pixels[offset + 1]!, source.pixels[offset + 2]!);
    default: {
      const unreachable: never = channel;
      throw new Error(`unsupported mask channel '${unreachable}'`);
    }
  }
}

export function morphologyRgba8(sourceValue: unknown, { mode, channel, radius }: {mode:MorphologyMode;channel:"luma"|"alpha";radius:number}) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  if (!["dilate", "erode"].includes(mode)) {
    throw new Error("morphology mode must be 'dilate' or 'erode'");
  }
  if (!["luma", "alpha"].includes(channel)) {
    throw new Error("morphology channel must be 'luma' or 'alpha'");
  }
  const normalizedRadius = integer(radius, "morphology radius", 1, 3);
  const output = Buffer.alloc(source.pixels.length);
  const rule = MORPHOLOGY_RULES[mode];

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let selected = rule.initial;
      for (let dy = -normalizedRadius; dy <= normalizedRadius; dy += 1) {
        for (let dx = -normalizedRadius; dx <= normalizedRadius; dx += 1) {
          const offset = sourcePixelOffset(source, x + dx, y + dy);
          const candidate = maskChannelValue(source, offset, channel);
          selected = rule.combine(selected, candidate);
        }
      }
      const targetOffset = (y * source.width + x) * 4;
      switch (channel) {
        case "alpha":
          output[targetOffset] = source.pixels[targetOffset]!;
          output[targetOffset + 1] = source.pixels[targetOffset + 1]!;
          output[targetOffset + 2] = source.pixels[targetOffset + 2]!;
          output[targetOffset + 3] = selected;
          break;
        case "luma":
          output[targetOffset] = selected;
          output[targetOffset + 1] = selected;
          output[targetOffset + 2] = selected;
          output[targetOffset + 3] = source.pixels[targetOffset + 3]!;
          break;
        default: {
          const unreachable: never = channel;
          throw new Error(`unsupported morphology channel '${unreachable}'`);
        }
      }
    }
  }

  return { width: source.width, height: source.height, pixels: output };
}

export function applyMaskRgba8(sourceValue: unknown, maskValue: unknown, channel: "luma"|"alpha") {
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
    const maskValue_ = maskChannelValue(mask, offset, channel);
    output[offset + 3] = roundRatio(source.pixels[offset + 3]! * maskValue_, 255);
  }
  return { width: source.width, height: source.height, pixels: output };
}

function quantizationSteps(bitsPerChannel: number) {
  const bits = integer(bitsPerChannel, "bitsPerChannel", 1, 8);
  return (1 << bits) - 1;
}

function quantizedByte(value: number, steps: number) {
  const index = roundRatio(value * steps, 255);
  return roundRatio(index * 255, steps);
}

export function uniformQuantizeRgba8(sourceValue: unknown, bitsPerChannel: number) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const steps = quantizationSteps(bitsPerChannel);
  const output = Buffer.from(source.pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    output[offset] = quantizedByte(source.pixels[offset]!, steps);
    output[offset + 1] = quantizedByte(source.pixels[offset + 1]!, steps);
    output[offset + 2] = quantizedByte(source.pixels[offset + 2]!, steps);
  }
  return { width: source.width, height: source.height, pixels: output };
}

export function normalizePalette(paletteValue: unknown) {
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

export function mapPaletteRgba8(sourceValue: unknown, paletteValue: unknown) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const palette = normalizePalette(paletteValue);
  const output = Buffer.from(source.pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < palette.length; index += 1) {
      const color = palette[index]!;
      const redDistance = source.pixels[offset]! - color[0]!;
      const greenDistance = source.pixels[offset + 1]! - color[1]!;
      const blueDistance = source.pixels[offset + 2]! - color[2]!;
      const distance =
        redDistance * redDistance + greenDistance * greenDistance + blueDistance * blueDistance;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    output[offset] = palette[bestIndex]![0]!;
    output[offset + 1] = palette[bestIndex]![1]!;
    output[offset + 2] = palette[bestIndex]![2]!;
  }
  return { width: source.width, height: source.height, pixels: output };
}

function orderedDitherByte(value: number, steps: number, matrixValue: number) {
  const scaled = value * steps;
  let index = Math.floor(scaled / 255);
  const remainder = scaled - index * 255;
  if (index < steps && remainder * 32 >= (2 * matrixValue + 1) * 255) {
    index += 1;
  }
  return roundRatio(index * 255, steps);
}

export function orderedDitherRgba8(sourceValue: unknown, bitsPerChannel: number) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const steps = quantizationSteps(bitsPerChannel);
  const output = Buffer.from(source.pixels);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const matrixValue = BAYER_4X4[(y % 4) * 4 + (x % 4)]!;
      output[offset] = orderedDitherByte(source.pixels[offset]!, steps, matrixValue);
      output[offset + 1] = orderedDitherByte(source.pixels[offset + 1]!, steps, matrixValue);
      output[offset + 2] = orderedDitherByte(source.pixels[offset + 2]!, steps, matrixValue);
    }
  }
  return { width: source.width, height: source.height, pixels: output };
}
