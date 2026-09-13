import { lumaRgba8 } from "./image-color.js";

const MAX_HEIGHTFIELD_DIMENSION = 256;
const MICRO_SCALE = 1_000_000n;
const CIRCLE_SAMPLE_COUNT = 128;
const QUARTER_SINE_MICRO = Object.freeze([
  0, 49068, 98017, 146730, 195090, 242980, 290285, 336890, 382683, 427555, 471397,
  514103, 555570, 595699, 634393, 671559, 707107, 740951, 773010, 803208, 831470,
  857729, 881921, 903989, 923880, 941544, 956940, 970031, 980785, 989177, 995185,
  998795, 1000000,
]);

export const PROCEDURAL_RADIAL_SEGMENTS = Object.freeze([4, 8, 16, 32, 64, 128]);
export const PROCEDURAL_SPHERE_LATITUDE_SEGMENTS = Object.freeze([4, 8, 16, 32, 64]);

function integer(value, location, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function oneOfIntegers(value, location, allowed) {
  integer(value, location, allowed[0], allowed[allowed.length - 1]);
  if (!allowed.includes(value)) {
    throw new Error(`${location} must be one of ${allowed.join(", ")}`);
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

function formatMicroUnits(value) {
  if (typeof value !== "bigint") throw new Error("mesh fixed-point coordinate must be a bigint");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MICRO_SCALE;
  const remainder = absolute % MICRO_SCALE;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole}`;
  const fraction = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function roundDivide(numerator, denominator) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator <= 0n) {
    throw new Error("fixed-point division requires bigint numerator and positive bigint denominator");
  }
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function sineMicro(index) {
  const normalized = ((index % CIRCLE_SAMPLE_COUNT) + CIRCLE_SAMPLE_COUNT) % CIRCLE_SAMPLE_COUNT;
  const quadrant = Math.floor(normalized / 32);
  const offset = normalized % 32;
  if (quadrant === 0) return QUARTER_SINE_MICRO[offset];
  if (quadrant === 1) return QUARTER_SINE_MICRO[32 - offset];
  if (quadrant === 2) return -QUARTER_SINE_MICRO[offset];
  return -QUARTER_SINE_MICRO[32 - offset];
}

function cosineMicro(index) {
  return sineMicro(index + 32);
}

function radialCoordinateMicro(radius, sample) {
  return BigInt(radius) * BigInt(sample);
}

function sphericalCoordinateMicro(radius, firstSample, secondSample) {
  return roundDivide(BigInt(radius) * BigInt(firstSample) * BigInt(secondSample), MICRO_SCALE);
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

export function generateCylinderObj({ radius, height, radialSegments }) {
  integer(radius, "radius", 1, 1_000_000);
  integer(height, "height", 1, 1_000_000);
  oneOfIntegers(radialSegments, "radialSegments", PROCEDURAL_RADIAL_SEGMENTS);
  const step = CIRCLE_SAMPLE_COUNT / radialSegments;
  const y0 = formatHalfUnits(-height);
  const y1 = formatHalfUnits(height);
  const ring = [];
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const sampleIndex = segment * step;
    ring.push([
      formatMicroUnits(radialCoordinateMicro(radius, cosineMicro(sampleIndex))),
      formatMicroUnits(radialCoordinateMicro(radius, sineMicro(sampleIndex))),
    ]);
  }
  const vertices = [
    ...ring.map(([x, z]) => [x, y0, z]),
    ...ring.map(([x, z]) => [x, y1, z]),
    ["0", y0, "0"],
    ["0", y1, "0"],
  ];
  const bottomCenter = radialSegments * 2 + 1;
  const topCenter = bottomCenter + 1;
  const faces = [];
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    const bottom = segment + 1;
    const bottomNext = next + 1;
    const top = radialSegments + segment + 1;
    const topNext = radialSegments + next + 1;
    faces.push([bottom, top, bottomNext], [bottomNext, top, topNext]);
    faces.push([bottomCenter, bottom, bottomNext], [topCenter, topNext, top]);
  }
  return { bytes: encodeObj(vertices, faces), vertexCount: vertices.length, triangleCount: faces.length };
}

export function generateUvSphereObj({ radius, latitudeSegments, longitudeSegments }) {
  integer(radius, "radius", 1, 1_000_000);
  oneOfIntegers(latitudeSegments, "latitudeSegments", PROCEDURAL_SPHERE_LATITUDE_SEGMENTS);
  oneOfIntegers(longitudeSegments, "longitudeSegments", PROCEDURAL_RADIAL_SEGMENTS);
  const latitudeStep = 64 / latitudeSegments;
  const longitudeStep = CIRCLE_SAMPLE_COUNT / longitudeSegments;
  const vertices = [["0", String(radius), "0"]];
  for (let latitude = 1; latitude < latitudeSegments; latitude += 1) {
    const latitudeIndex = latitude * latitudeStep;
    const ringRadius = sineMicro(latitudeIndex);
    const y = formatMicroUnits(radialCoordinateMicro(radius, cosineMicro(latitudeIndex)));
    for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
      const longitudeIndex = longitude * longitudeStep;
      vertices.push([
        formatMicroUnits(sphericalCoordinateMicro(radius, ringRadius, cosineMicro(longitudeIndex))),
        y,
        formatMicroUnits(sphericalCoordinateMicro(radius, ringRadius, sineMicro(longitudeIndex))),
      ]);
    }
  }
  vertices.push(["0", String(-radius), "0"]);

  const ringStart = (latitude) => 2 + (latitude - 1) * longitudeSegments;
  const bottom = vertices.length;
  const faces = [];
  const firstRing = ringStart(1);
  for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
    const current = firstRing + longitude;
    const next = firstRing + ((longitude + 1) % longitudeSegments);
    faces.push([1, next, current]);
  }
  for (let latitude = 1; latitude < latitudeSegments - 1; latitude += 1) {
    const upper = ringStart(latitude);
    const lower = ringStart(latitude + 1);
    for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
      const next = (longitude + 1) % longitudeSegments;
      const upperCurrent = upper + longitude;
      const upperNext = upper + next;
      const lowerCurrent = lower + longitude;
      const lowerNext = lower + next;
      faces.push([upperCurrent, upperNext, lowerCurrent], [upperNext, lowerNext, lowerCurrent]);
    }
  }
  const lastRing = ringStart(latitudeSegments - 1);
  for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
    const current = lastRing + longitude;
    const next = lastRing + ((longitude + 1) % longitudeSegments);
    faces.push([bottom, current, next]);
  }

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
