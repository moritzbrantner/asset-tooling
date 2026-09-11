const MAX_DIMENSION = 8192;

function dimension(value, location) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error(`${location} must be an integer in 1..${MAX_DIMENSION}`);
  }
  return value;
}

function nonNegativeInteger(value, location, maximum = MAX_DIMENSION) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${location} must be an integer in 0..${maximum}`);
  }
  return value;
}

function channel(value, location) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`${location} must be an integer in 0..255`);
  }
  return value;
}

export function assertRgba8Image(image, location = "RGBA8 image") {
  if (typeof image !== "object" || image === null || Array.isArray(image)) {
    throw new Error(`${location} must be an object`);
  }
  const width = dimension(image.width, `${location} width`);
  const height = dimension(image.height, `${location} height`);
  if (!(image.pixels instanceof Uint8Array)) {
    throw new Error(`${location} pixels must be a Uint8Array`);
  }
  const expected = width * height * 4;
  if (image.pixels.byteLength !== expected) {
    throw new Error(`${location} pixels must contain exactly ${expected} bytes`);
  }
  return { width, height, pixels: Buffer.from(image.pixels) };
}

function nearestSourceIndex(destinationIndex, sourceLength, destinationLength) {
  return Math.min(
    sourceLength - 1,
    Math.floor(((2 * destinationIndex + 1) * sourceLength) / (2 * destinationLength)),
  );
}

function floorDiv(numerator, denominator) {
  const quotient = Math.trunc(numerator / denominator);
  const remainder = numerator % denominator;
  return remainder !== 0 && numerator < 0 ? quotient - 1 : quotient;
}

function linearAxis(destinationIndex, sourceLength, destinationLength) {
  const denominator = 2 * destinationLength;
  const numerator = (2 * destinationIndex + 1) * sourceLength - destinationLength;
  const lower = floorDiv(numerator, denominator);
  const fraction = numerator - lower * denominator;
  if (lower < 0) {
    return { lower: 0, upper: 0, fraction: 0, denominator };
  }
  if (lower >= sourceLength - 1) {
    const edge = sourceLength - 1;
    return { lower: edge, upper: edge, fraction: 0, denominator };
  }
  return { lower, upper: lower + 1, fraction, denominator };
}

function weightedSum(values, weights) {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index] * weights[index];
  }
  return total;
}

function roundedRatio(numerator, denominator) {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function resizeRgba8Nearest(sourceValue, width, height) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const targetWidth = dimension(width, "target width");
  const targetHeight = dimension(height, "target height");
  const output = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = nearestSourceIndex(targetY, source.height, targetHeight);
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = nearestSourceIndex(targetX, source.width, targetWidth);
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      source.pixels.copy(output, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }

  return { width: targetWidth, height: targetHeight, pixels: output };
}

export function resizeRgba8Bilinear(sourceValue, width, height) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const targetWidth = dimension(width, "target width");
  const targetHeight = dimension(height, "target height");
  const output = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const y = linearAxis(targetY, source.height, targetHeight);
    const wy0 = y.denominator - y.fraction;
    const wy1 = y.fraction;
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const x = linearAxis(targetX, source.width, targetWidth);
      const wx0 = x.denominator - x.fraction;
      const wx1 = x.fraction;
      const weights = [wx0 * wy0, wx1 * wy0, wx0 * wy1, wx1 * wy1];
      const denominator = x.denominator * y.denominator;
      const offsets = [
        (y.lower * source.width + x.lower) * 4,
        (y.lower * source.width + x.upper) * 4,
        (y.upper * source.width + x.lower) * 4,
        (y.upper * source.width + x.upper) * 4,
      ];
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      const alphas = offsets.map((offset) => source.pixels[offset + 3]);
      const weightedAlpha = weightedSum(alphas, weights);
      output[targetOffset + 3] = roundedRatio(weightedAlpha, denominator);

      for (let component = 0; component < 3; component += 1) {
        let weightedPremultiplied = 0;
        for (let sample = 0; sample < offsets.length; sample += 1) {
          weightedPremultiplied +=
            source.pixels[offsets[sample] + component] * alphas[sample] * weights[sample];
        }
        output[targetOffset + component] =
          weightedAlpha === 0 ? 0 : roundedRatio(weightedPremultiplied, weightedAlpha);
      }
    }
  }

  return { width: targetWidth, height: targetHeight, pixels: output };
}

export function cropRgba8(sourceValue, { x, y, width, height }) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const cropX = nonNegativeInteger(x, "crop x", source.width - 1);
  const cropY = nonNegativeInteger(y, "crop y", source.height - 1);
  const cropWidth = dimension(width, "crop width");
  const cropHeight = dimension(height, "crop height");
  if (cropX + cropWidth > source.width || cropY + cropHeight > source.height) {
    throw new Error("crop rectangle must stay inside the source image");
  }
  const output = Buffer.alloc(cropWidth * cropHeight * 4);
  const rowBytes = cropWidth * 4;
  for (let row = 0; row < cropHeight; row += 1) {
    const sourceStart = ((cropY + row) * source.width + cropX) * 4;
    source.pixels.copy(output, row * rowBytes, sourceStart, sourceStart + rowBytes);
  }
  return { width: cropWidth, height: cropHeight, pixels: output };
}

export function padRgba8(sourceValue, { left, right, top, bottom, color }) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const padLeft = nonNegativeInteger(left, "pad left");
  const padRight = nonNegativeInteger(right, "pad right");
  const padTop = nonNegativeInteger(top, "pad top");
  const padBottom = nonNegativeInteger(bottom, "pad bottom");
  const targetWidth = source.width + padLeft + padRight;
  const targetHeight = source.height + padTop + padBottom;
  dimension(targetWidth, "padded width");
  dimension(targetHeight, "padded height");
  if (!Array.isArray(color) || color.length !== 4) {
    throw new Error("pad color must contain exactly four RGBA8 channels");
  }
  const fill = color.map((value, index) => channel(value, `pad color[${index}]`));
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    output[offset] = fill[0];
    output[offset + 1] = fill[1];
    output[offset + 2] = fill[2];
    output[offset + 3] = fill[3];
  }
  for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset =
        ((sourceY + padTop) * targetWidth + sourceX + padLeft) * 4;
      source.pixels.copy(output, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { width: targetWidth, height: targetHeight, pixels: output };
}

export function rotateRgba8QuarterTurns(sourceValue, quarterTurns) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  if (!Number.isSafeInteger(quarterTurns) || quarterTurns < 0 || quarterTurns > 3) {
    throw new Error("quarterTurns must be an integer in 0..3");
  }
  if (quarterTurns === 0) {
    return { width: source.width, height: source.height, pixels: Buffer.from(source.pixels) };
  }
  const targetWidth = quarterTurns % 2 === 0 ? source.width : source.height;
  const targetHeight = quarterTurns % 2 === 0 ? source.height : source.width;
  const output = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
      let targetX;
      let targetY;
      if (quarterTurns === 1) {
        targetX = source.height - 1 - sourceY;
        targetY = sourceX;
      } else if (quarterTurns === 2) {
        targetX = source.width - 1 - sourceX;
        targetY = source.height - 1 - sourceY;
      } else {
        targetX = sourceY;
        targetY = source.width - 1 - sourceX;
      }
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      source.pixels.copy(output, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }

  return { width: targetWidth, height: targetHeight, pixels: output };
}

export function flipRgba8(sourceValue, axis) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  if (!["horizontal", "vertical", "both"].includes(axis)) {
    throw new Error("flip axis must be 'horizontal', 'vertical', or 'both'");
  }
  const output = Buffer.alloc(source.pixels.length);
  for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
      const targetX = axis === "horizontal" || axis === "both"
        ? source.width - 1 - sourceX
        : sourceX;
      const targetY = axis === "vertical" || axis === "both"
        ? source.height - 1 - sourceY
        : sourceY;
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (targetY * source.width + targetX) * 4;
      source.pixels.copy(output, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { width: source.width, height: source.height, pixels: output };
}
