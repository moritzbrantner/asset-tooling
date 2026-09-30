export interface BorderWhiteAlphaImage {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

export interface BorderWhiteAlphaParameters {
  backgroundFloor: number;
  transparentAbove: number;
}

export function normalizeBorderWhiteAlphaParameters(value: unknown): BorderWhiteAlphaParameters {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image background parameters must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "backgroundFloor") ||
    !Object.hasOwn(record, "transparentAbove")
  ) {
    throw new Error(
      "image background parameters must contain only backgroundFloor and transparentAbove",
    );
  }
  const backgroundFloor = record.backgroundFloor;
  const transparentAbove = record.transparentAbove;
  if (
    !Number.isSafeInteger(backgroundFloor) ||
    (backgroundFloor as number) < 0 ||
    (backgroundFloor as number) > 254
  ) {
    throw new Error("parameters.backgroundFloor must be an integer in 0..254");
  }
  if (
    !Number.isSafeInteger(transparentAbove) ||
    (transparentAbove as number) < 1 ||
    (transparentAbove as number) > 255
  ) {
    throw new Error("parameters.transparentAbove must be an integer in 1..255");
  }
  if ((backgroundFloor as number) >= (transparentAbove as number)) {
    throw new Error("parameters.backgroundFloor must be less than parameters.transparentAbove");
  }
  return {
    backgroundFloor: backgroundFloor as number,
    transparentAbove: transparentAbove as number,
  };
}

function minimumRgb(pixels: Uint8Array | Uint8ClampedArray, pixelIndex: number): number {
  const offset = pixelIndex * 4;
  return Math.min(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
}

export function borderWhiteToAlphaRgba8(
  source: BorderWhiteAlphaImage,
  parameters: BorderWhiteAlphaParameters,
) {
  const normalized = normalizeBorderWhiteAlphaParameters(parameters);
  const { width, height, pixels } = source;
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const enqueue = (pixelIndex: number) => {
    if (visited[pixelIndex]) return;
    if (minimumRgb(pixels, pixelIndex) < normalized.backgroundFloor) return;
    visited[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    if (height > 1) enqueue((height - 1) * width + x);
  }
  for (let y = 1; y + 1 < height; y += 1) {
    enqueue(y * width);
    if (width > 1) enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head] ?? 0;
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }

  const output = new Uint8Array(pixels);
  const featherRange = normalized.transparentAbove - normalized.backgroundFloor;
  let transparentPixelCount = 0;
  let featheredPixelCount = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (!visited[pixelIndex]) continue;
    const brightness = minimumRgb(pixels, pixelIndex);
    let mask: number;
    if (brightness >= normalized.transparentAbove) {
      mask = 0;
      transparentPixelCount += 1;
    } else if (brightness <= normalized.backgroundFloor) {
      mask = 255;
    } else {
      const numerator = (normalized.transparentAbove - brightness) * 255;
      mask = Math.floor((numerator + Math.floor(featherRange / 2)) / featherRange);
      featheredPixelCount += 1;
    }
    const alphaOffset = pixelIndex * 4 + 3;
    output[alphaOffset] = Math.floor(((pixels[alphaOffset] ?? 255) * mask + 127) / 255);
  }

  return {
    image: { width, height, pixels: output },
    observations: {
      connectedBackgroundPixelCount: tail,
      transparentPixelCount,
      featheredPixelCount,
    },
  };
}
