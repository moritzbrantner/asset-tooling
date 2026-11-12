export type CircleSdfParameters = { width:number; height:number; centerX:number; centerY:number; radius:number; spread:number };
export type RoundedRectSdfParameters = Omit<CircleSdfParameters,"radius"> & {halfWidth:number;halfHeight:number;cornerRadius:number};
export type CircleSvgParameters = Omit<CircleSdfParameters,"spread"> & {fill:string};
export type RoundedRectSvgParameters = {width:number;height:number;x:number;y:number;rectWidth:number;rectHeight:number;cornerRadius:number;fill:string};

const MAX_DIMENSION = 4096;
const SVG_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function integer(value: unknown, location: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function dimension(value: unknown, location: string) {
  return integer(value, location, 1, MAX_DIMENSION);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundRatioSigned(numerator: number, denominator: number) {
  if (numerator >= 0) {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return -Math.floor((-numerator + Math.floor(denominator / 2)) / denominator);
}

function integerSqrt(value: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
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

function sdfByte(signedDistance: number, spread: number) {
  return clamp(128 + roundRatioSigned(signedDistance * 127, spread), 0, 255);
}

function makeSdfImage(width: number, height: number, spread: number, distanceAt: (x:number,y:number)=>number) {
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

export function generateCircleSdfRgba8({ width, height, centerX, centerY, radius, spread }: CircleSdfParameters) {
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
}: RoundedRectSdfParameters) {
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

function svgColor(value: unknown, location: string) {
  if (typeof value !== "string" || !SVG_COLOR_PATTERN.test(value)) {
    throw new Error(`${location} must be a lowercase #rrggbb color`);
  }
  return value;
}

function svgDocument(width: number, height: number, element: string) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${element}</svg>\n`,
    "utf8",
  );
}

export function generateCircleSvg({ width, height, centerX, centerY, radius, fill }: CircleSvgParameters) {
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
}: RoundedRectSvgParameters) {
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

export type SvgStrokeJoin = "miter" | "round";
export type StarSvgParameters = {
  width:number; height:number; centerX:number; centerY:number;
  points:number; outerRadius:number; innerRadius:number; rotationDegrees:number;
  fill:string; stroke:string; strokeWidth:number; strokeJoin:SvgStrokeJoin;
};
export type RingSvgParameters = {width:number;height:number;centerX:number;centerY:number;radius:number;strokeWidth:number;stroke:string};

/** Canonical decimal text for SVG coordinates: at most three fractional digits, no trailing zeros, no "-0". */
export function svgNumber(value: number) {
  if (!Number.isFinite(value)) throw new Error("SVG coordinate must be finite");
  const rounded = Math.round(value * 1000) / 1000;
  const text = (Object.is(rounded, -0) ? 0 : rounded).toFixed(3).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

function svgStrokeColor(value: unknown, location: string) {
  return value === "none" ? "none" : svgColor(value, location);
}

/**
 * Alternating outer/inner vertices of a star or burst, starting at the outer vertex pointing up
 * (negative y) and rotated clockwise by `rotationDegrees`. A burst is a star with many points and a
 * small inner radius; a regular polygon is a star whose inner vertices lie on its edges.
 */
export function generateStarSvg({
  width, height, centerX, centerY, points, outerRadius, innerRadius, rotationDegrees, fill, stroke, strokeWidth, strokeJoin,
}: StarSvgParameters) {
  const canvasWidth = dimension(width, "star SVG width");
  const canvasHeight = dimension(height, "star SVG height");
  const cx = integer(centerX, "star SVG centerX", 0, canvasWidth);
  const cy = integer(centerY, "star SVG centerY", 0, canvasHeight);
  const count = integer(points, "star SVG points", 3, 64);
  const outer = integer(outerRadius, "star SVG outerRadius", 1, MAX_DIMENSION);
  const inner = integer(innerRadius, "star SVG innerRadius", 1, outer);
  const rotation = integer(rotationDegrees, "star SVG rotationDegrees", 0, 359);
  const fillColor = svgColor(fill, "star SVG fill");
  const strokeColor = svgStrokeColor(stroke, "star SVG stroke");
  const lineWidth = integer(strokeWidth, "star SVG strokeWidth", 0, MAX_DIMENSION);
  if ((strokeColor === "none") !== (lineWidth === 0)) {
    throw new Error("star SVG stroke must be 'none' exactly when strokeWidth is 0");
  }
  if (strokeJoin !== "miter" && strokeJoin !== "round") throw new Error("star SVG strokeJoin must be 'miter' or 'round'");
  // A miter join can extend far past the vertex; the bounds check uses the round-join extent and miter joins
  // are clipped by stroke-miterlimit="4" (the SVG default made explicit), i.e. at most 2 × strokeWidth.
  const reach = outer + (strokeJoin === "miter" ? 2 * lineWidth : lineWidth / 2);
  if (cx - reach < 0 || cy - reach < 0 || cx + reach > canvasWidth || cy + reach > canvasHeight) {
    throw new Error("star SVG geometry including its stroke must fit inside the canvas");
  }
  const vertices: string[] = [];
  for (let index = 0; index < count * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = ((rotation + (index * 180) / count) * Math.PI) / 180;
    vertices.push(`${svgNumber(cx + radius * Math.sin(angle))},${svgNumber(cy - radius * Math.cos(angle))}`);
  }
  const strokeAttributes = strokeColor === "none"
    ? ""
    : ` stroke="${strokeColor}" stroke-width="${lineWidth}" stroke-linejoin="${strokeJoin}" stroke-miterlimit="4"`;
  return {
    width: canvasWidth,
    height: canvasHeight,
    bytes: svgDocument(canvasWidth, canvasHeight, `<polygon points="${vertices.join(" ")}" fill="${fillColor}"${strokeAttributes}/>`),
  };
}

export function generateRingSvg({ width, height, centerX, centerY, radius, strokeWidth, stroke }: RingSvgParameters) {
  const canvasWidth = dimension(width, "ring SVG width");
  const canvasHeight = dimension(height, "ring SVG height");
  const cx = integer(centerX, "ring SVG centerX", 0, canvasWidth);
  const cy = integer(centerY, "ring SVG centerY", 0, canvasHeight);
  const r = integer(radius, "ring SVG radius", 1, MAX_DIMENSION);
  const lineWidth = integer(strokeWidth, "ring SVG strokeWidth", 1, 2 * r);
  const color = svgColor(stroke, "ring SVG stroke");
  const reach = r + lineWidth / 2;
  if (cx - reach < 0 || cy - reach < 0 || cx + reach > canvasWidth || cy + reach > canvasHeight) {
    throw new Error("ring SVG geometry including its stroke must fit inside the canvas");
  }
  return {
    width: canvasWidth,
    height: canvasHeight,
    bytes: svgDocument(canvasWidth, canvasHeight, `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${lineWidth}"/>`),
  };
}
