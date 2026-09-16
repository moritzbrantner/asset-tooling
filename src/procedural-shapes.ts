const MAX_DIMENSION = 4096;
const SVG_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function dimension(value, location) {
  return integer(value, location, 1, MAX_DIMENSION);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundRatioSigned(numerator, denominator) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
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

function sdfByte(signedDistance, spread) {
  return clamp(128 + roundRatioSigned(signedDistance * 127, spread), 0, 255);
}

function makeSdfImage(width, height, spread, distanceAt) {
  const imageWidth = dimension(width, "SDF width");
  const imageHeight = dimension(height, "SDF height");
  const normalizedSpread = integer(spread, "SDF spread", 1, MAX_DIMENSION);
  const pixels = Buffer.alloc(imageWidth * imageHeight * 4);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const value = sdfByte(distanceAt(x, y), normalizedSpread);
      const offset = (y * imageWidth + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return { width: imageWidth, height: imageHeight, pixels };
}

export function generateCircleSdfRgba8({ width, height, centerX, centerY, radius, spread }) {
  const imageWidth = dimension(width, "circle SDF width");
  const imageHeight = dimension(height, "circle SDF height");
  const cx = integer(centerX, "circle centerX", 0, imageWidth - 1);
  const cy = integer(centerY, "circle centerY", 0, imageHeight - 1);
  const normalizedRadius = integer(radius, "circle radius", 1, MAX_DIMENSION);
  return makeSdfImage(imageWidth, imageHeight, spread, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return integerSqrt(dx * dx + dy * dy) - normalizedRadius;
  });
}

export function generateRoundedRectSdfRgba8({
  width,
  height,
  centerX,
  centerY,
  halfWidth,
  halfHeight,
  cornerRadius,
  spread,
}) {
  const imageWidth = dimension(width, "rounded rectangle SDF width");
  const imageHeight = dimension(height, "rounded rectangle SDF height");
  const cx = integer(centerX, "rounded rectangle centerX", 0, imageWidth - 1);
  const cy = integer(centerY, "rounded rectangle centerY", 0, imageHeight - 1);
  const hw = integer(halfWidth, "rounded rectangle halfWidth", 1, MAX_DIMENSION);
  const hh = integer(halfHeight, "rounded rectangle halfHeight", 1, MAX_DIMENSION);
  const radius = integer(cornerRadius, "rounded rectangle cornerRadius", 0, Math.min(hw, hh));
  return makeSdfImage(imageWidth, imageHeight, spread, (x, y) => {
    const qx = Math.abs(x - cx) - (hw - radius);
    const qy = Math.abs(y - cy) - (hh - radius);
    const outsideX = Math.max(qx, 0);
    const outsideY = Math.max(qy, 0);
    const outside = integerSqrt(outsideX * outsideX + outsideY * outsideY);
    const inside = Math.min(Math.max(qx, qy), 0);
    return outside + inside - radius;
  });
}

function svgColor(value, location) {
  if (typeof value !== "string" || !SVG_COLOR_PATTERN.test(value)) {
    throw new Error(`${location} must be a lowercase #rrggbb color`);
  }
  return value;
}

function svgDocument(width, height, element) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${element}</svg>\n`,
    "utf8",
  );
}

export function generateCircleSvg({ width, height, centerX, centerY, radius, fill }) {
  const canvasWidth = dimension(width, "circle SVG width");
  const canvasHeight = dimension(height, "circle SVG height");
  const cx = integer(centerX, "circle SVG centerX", 0, canvasWidth);
  const cy = integer(centerY, "circle SVG centerY", 0, canvasHeight);
  const r = integer(radius, "circle SVG radius", 1, MAX_DIMENSION);
  if (cx - r < 0 || cy - r < 0 || cx + r > canvasWidth || cy + r > canvasHeight) {
    throw new Error("circle SVG geometry must fit inside the canvas");
  }
  const color = svgColor(fill, "circle SVG fill");
  return {
    width: canvasWidth,
    height: canvasHeight,
    bytes: svgDocument(canvasWidth, canvasHeight, `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`),
  };
}

export function generateRoundedRectSvg({
  width,
  height,
  x,
  y,
  rectWidth,
  rectHeight,
  cornerRadius,
  fill,
}) {
  const canvasWidth = dimension(width, "rounded rectangle SVG width");
  const canvasHeight = dimension(height, "rounded rectangle SVG height");
  const originX = integer(x, "rounded rectangle SVG x", 0, canvasWidth - 1);
  const originY = integer(y, "rounded rectangle SVG y", 0, canvasHeight - 1);
  const shapeWidth = integer(rectWidth, "rounded rectangle SVG rectWidth", 1, MAX_DIMENSION);
  const shapeHeight = integer(rectHeight, "rounded rectangle SVG rectHeight", 1, MAX_DIMENSION);
  if (originX + shapeWidth > canvasWidth || originY + shapeHeight > canvasHeight) {
    throw new Error("rounded rectangle SVG geometry must fit inside the canvas");
  }
  const radius = integer(
    cornerRadius,
    "rounded rectangle SVG cornerRadius",
    0,
    Math.floor(Math.min(shapeWidth, shapeHeight) / 2),
  );
  const color = svgColor(fill, "rounded rectangle SVG fill");
  return {
    width: canvasWidth,
    height: canvasHeight,
    bytes: svgDocument(
      canvasWidth,
      canvasHeight,
      `<rect x="${originX}" y="${originY}" width="${shapeWidth}" height="${shapeHeight}" rx="${radius}" ry="${radius}" fill="${color}"/>`,
    ),
  };
}
