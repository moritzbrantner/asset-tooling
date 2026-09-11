import { assertRgba8Image } from "./image-geometry.js";

const MAX_KERNEL_SIZE = 7;
const MAX_WEIGHT = 4096;
const MAX_DIVISOR = 1_000_000;
const MAX_BIAS = 255;
const ALPHA_MODES = new Set(["preserve", "convolve-premultiplied"]);

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampByte(value) {
  return clamp(value, 0, 255);
}

function roundRatioSigned(numerator, denominator) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
}

export function normalizeConvolutionKernel({ width, height, weights, divisor, bias = 0 }) {
  const kernelWidth = integer(width, "kernel width", 1, MAX_KERNEL_SIZE);
  const kernelHeight = integer(height, "kernel height", 1, MAX_KERNEL_SIZE);
  if (kernelWidth % 2 !== 1 || kernelHeight % 2 !== 1) {
    throw new Error("convolution kernel dimensions must be odd");
  }
  if (!Array.isArray(weights) || weights.length !== kernelWidth * kernelHeight) {
    throw new Error("convolution weights must contain exactly width * height entries");
  }
  const normalizedWeights = weights.map((value, index) =>
    integer(value, `kernel weights[${index}]`, -MAX_WEIGHT, MAX_WEIGHT),
  );
  const normalizedDivisor = integer(divisor, "kernel divisor", 1, MAX_DIVISOR);
  const normalizedBias = integer(bias, "kernel bias", -MAX_BIAS, MAX_BIAS);
  return {
    width: kernelWidth,
    height: kernelHeight,
    weights: normalizedWeights,
    divisor: normalizedDivisor,
    bias: normalizedBias,
  };
}

function samplesFor(source, x, y, kernel) {
  const radiusX = Math.floor(kernel.width / 2);
  const radiusY = Math.floor(kernel.height / 2);
  const samples = [];
  for (let kernelY = 0; kernelY < kernel.height; kernelY += 1) {
    const sourceY = clamp(y + kernelY - radiusY, 0, source.height - 1);
    for (let kernelX = 0; kernelX < kernel.width; kernelX += 1) {
      const sourceX = clamp(x + kernelX - radiusX, 0, source.width - 1);
      samples.push({
        offset: (sourceY * source.width + sourceX) * 4,
        weight: kernel.weights[kernelY * kernel.width + kernelX],
      });
    }
  }
  return samples;
}

export function convolveRgba8(sourceValue, kernelValue, { alphaMode = "preserve" } = {}) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const kernel = normalizeConvolutionKernel(kernelValue);
  if (!ALPHA_MODES.has(alphaMode)) {
    throw new Error("convolution alphaMode must be 'preserve' or 'convolve-premultiplied'");
  }
  const output = Buffer.alloc(source.pixels.length);

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const targetOffset = (y * source.width + x) * 4;
      const samples = samplesFor(source, x, y, kernel);

      if (alphaMode === "preserve") {
        for (let component = 0; component < 3; component += 1) {
          let sum = 0;
          for (const sample of samples) {
            sum += source.pixels[sample.offset + component] * sample.weight;
          }
          output[targetOffset + component] = clampByte(
            roundRatioSigned(sum, kernel.divisor) + kernel.bias,
          );
        }
        output[targetOffset + 3] = source.pixels[targetOffset + 3];
        continue;
      }

      let alphaSum = 0;
      for (const sample of samples) {
        alphaSum += source.pixels[sample.offset + 3] * sample.weight;
      }
      const outputAlpha = clampByte(roundRatioSigned(alphaSum, kernel.divisor));
      output[targetOffset + 3] = outputAlpha;

      for (let component = 0; component < 3; component += 1) {
        let premultipliedSum = 0;
        for (const sample of samples) {
          const alpha = source.pixels[sample.offset + 3];
          premultipliedSum +=
            source.pixels[sample.offset + component] * alpha * sample.weight;
        }
        const premultiplied = clamp(
          roundRatioSigned(premultipliedSum, kernel.divisor),
          0,
          255 * 255,
        );
        output[targetOffset + component] =
          outputAlpha === 0
            ? 0
            : clampByte(roundRatioSigned(premultiplied, outputAlpha) + kernel.bias);
      }
    }
  }

  return { width: source.width, height: source.height, pixels: output };
}

export function boxBlurRgba8(sourceValue, radius) {
  const normalizedRadius = integer(radius, "blur radius", 1, 3);
  const size = normalizedRadius * 2 + 1;
  const count = size * size;
  return convolveRgba8(
    sourceValue,
    {
      width: size,
      height: size,
      weights: Array(count).fill(1),
      divisor: count,
      bias: 0,
    },
    { alphaMode: "convolve-premultiplied" },
  );
}

export function sharpenRgba8(sourceValue, numerator, denominator) {
  const amountNumerator = integer(numerator, "sharpen numerator", 0, 32);
  const amountDenominator = integer(denominator, "sharpen denominator", 1, 32);
  return convolveRgba8(
    sourceValue,
    {
      width: 3,
      height: 3,
      weights: [
        0,
        -amountNumerator,
        0,
        -amountNumerator,
        amountDenominator + 4 * amountNumerator,
        -amountNumerator,
        0,
        -amountNumerator,
        0,
      ],
      divisor: amountDenominator,
      bias: 0,
    },
    { alphaMode: "preserve" },
  );
}
