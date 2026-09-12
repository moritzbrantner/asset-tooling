import { lumaRgba8 } from "./image-color.js";

const MAX_HEIGHTFIELD_DIMENSION = 256;

function integer(value, location, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function formatHalfUnits(twiceValue) {
  if (!Number.isSafeInteger(twiceValue)) throw new Error("mesh coordinate must be an exact half-unit integer");
  const negative = twiceValue < 0;
  const absolute = Math.abs(twiceValue);
  const whole = Math.floor(absolute / 2);
  const fraction = absolute % 2 === 0 ? "" : ".5";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

function encodeObj(vertices, faces) {
  const lines = ["# asset-tooling canonical procedural OBJ v1"];
  for (const vertex of vertices) lines.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
  for (const face of faces) lines.push(`f ${face[0]} ${face[1]} ${face[2]}`);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function generateBoxObj({ width, height, depth }) {
  integer(width, "width", 1, 1_000_000);
  integer(height, "height", 1, 1_000_000);
  integer(depth, "depth", 1, 1_000_000);
  const x0 = formatHalfUnits(-width);
  const x1 = formatHalfUnits(width);
  const y0 = formatHalfUnits(-height);
  const y1 = formatHalfUnits(height);
  const z0 = formatHalfUnits(-depth);
  const z1 = formatHalfUnits(depth);
  const vertices = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [1, 3, 2], [1, 4, 3],
    [5, 6, 7], [5, 7, 8],
    [1, 2, 6], [1, 6, 5],
    [4, 8, 7], [4, 7, 3],
    [1, 5, 8], [1, 8, 4],
    [2, 3, 7], [2, 7, 6],
  ];
  return { bytes: encodeObj(vertices, faces), vertexCount: vertices.length, triangleCount: faces.length };
}

export function generatePlaneObj({ width, depth }) {
  integer(width, "width", 1, 1_000_000);
  integer(depth, "depth", 1, 1_000_000);
  const x0 = formatHalfUnits(-width);
  const x1 = formatHalfUnits(width);
  const z0 = formatHalfUnits(-depth);
  const z1 = formatHalfUnits(depth);
  const vertices = [[x0, "0", z0], [x1, "0", z0], [x1, "0", z1], [x0, "0", z1]];
  const faces = [[1, 3, 2], [1, 4, 3]];
  return { bytes: encodeObj(vertices, faces), vertexCount: vertices.length, triangleCount: faces.length };
}

export function generateHeightfieldObj(source, { cellSize, heightScale }) {
  if (typeof source !== "object" || source === null || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)) {
    throw new Error("heightfield source must be a parsed RGBA8 image");
  }
  integer(source.width, "source.width", 2, MAX_HEIGHTFIELD_DIMENSION);
  integer(source.height, "source.height", 2, MAX_HEIGHTFIELD_DIMENSION);
  integer(cellSize, "cellSize", 1, 1_000_000);
  integer(heightScale, "heightScale", 0, 1_000_000);
  if (!Buffer.isBuffer(source.pixels) || source.pixels.length !== source.width * source.height * 4) {
    throw new Error("heightfield source pixel bytes do not match its dimensions");
  }

  const spanX = (source.width - 1) * cellSize;
  const spanZ = (source.height - 1) * cellSize;
  const vertices = [];
  for (let z = 0; z < source.height; z += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (z * source.width + x) * 4;
      const luma = lumaRgba8(source.pixels[offset], source.pixels[offset + 1], source.pixels[offset + 2]);
      const y = Math.floor((luma * heightScale + 127) / 255);
      vertices.push([
        formatHalfUnits(2 * x * cellSize - spanX),
        String(y),
        formatHalfUnits(2 * z * cellSize - spanZ),
      ]);
    }
  }

  const faces = [];
  for (let z = 0; z < source.height - 1; z += 1) {
    for (let x = 0; x < source.width - 1; x += 1) {
      const a = z * source.width + x + 1;
      const b = a + 1;
      const c = a + source.width;
      const d = c + 1;
      faces.push([a, c, b], [b, c, d]);
    }
  }

  return { bytes: encodeObj(vertices, faces), vertexCount: vertices.length, triangleCount: faces.length };
}

export const PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION = MAX_HEIGHTFIELD_DIMENSION;
