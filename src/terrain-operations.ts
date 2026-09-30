import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { lumaRgba8 } from "./image-color.js";
import { assertRgba8Image } from "./image-geometry.js";
import {
  encodeRgba8Image,
  parseRgba8Image,
  RGBA8_IMAGE_MEDIA_TYPE,
} from "./image-rgba8.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_LEVELS = 256;
const MAX_Q8 = 255;

const heightInput = {
  id: "source",
  label: "Height source",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};
const heightOutput = {
  id: "output",
  label: "Shaped height field",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.height.radial-falloff",
    version: VERSION,
    label: "Apply radial height falloff",
    description:
      "Subtract an exact integer elliptical radial falloff from a canonical height field, preserving an inner Q8 radius before fading toward the image boundary.",
    category: "procedural.height",
    inputs: [heightInput],
    outputs: [heightOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["innerRadiusQ8", "strength"],
      properties: {
        innerRadiusQ8: { type: "integer", minimum: 0, maximum: 254 },
        strength: { type: "integer", minimum: 1, maximum: 255 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.height.terrace",
    version: VERSION,
    label: "Terrace height field",
    description:
      "Quantize canonical height luma into exact uniformly spaced integer terraces while preserving 0 and 255 endpoints.",
    category: "procedural.height",
    inputs: [heightInput],
    outputs: [heightOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["levels"],
      properties: {
        levels: { type: "integer", minimum: 2, maximum: MAX_LEVELS },
      },
    },
  },
]);

export const HEIGHT_RADIAL_FALLOFF_OPERATION = OPERATION_REGISTRY.get(
  "image.height.radial-falloff",
  VERSION,
);
export const HEIGHT_TERRACE_OPERATION = OPERATION_REGISTRY.get("image.height.terrace", VERSION);
export const TERRAIN_HEIGHT_OPERATIONS = OPERATION_REGISTRY.list();

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, location) {
  const object = plainObject(value, location);
  const expected = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function roundRatio(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("terrain integer ratio requires a non-negative safe numerator and positive denominator");
  }
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function roundRatioSigned(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("terrain signed ratio requires a safe numerator and positive denominator");
  }
  return numerator >= 0
    ? roundRatio(numerator, denominator)
    : -roundRatio(-numerator, denominator);
}

function integerSqrt(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("terrain integer square root input must be a non-negative safe integer");
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

function heightPixels(source, transform) {
  const output = Buffer.alloc(source.width * source.height * 4);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const height = lumaRgba8(
        source.pixels[offset],
        source.pixels[offset + 1],
        source.pixels[offset + 2],
      );
      const shaped = transform(height, x, y);
      output[offset] = shaped;
      output[offset + 1] = shaped;
      output[offset + 2] = shaped;
      output[offset + 3] = 255;
    }
  }
  return { width: source.width, height: source.height, pixels: output };
}

export function terraceHeightRgba8(sourceValue, { levels }) {
  const source = assertRgba8Image(sourceValue, "terrace height source RGBA8 image");
  const terraceLevels = integer(levels, "terrace levels", 2, MAX_LEVELS);
  const intervals = terraceLevels - 1;
  return heightPixels(source, (height) => {
    const terrace = roundRatio(height * intervals, MAX_Q8);
    return roundRatio(terrace * MAX_Q8, intervals);
  });
}

function normalizedRadialDistanceQ8(width, height, x, y) {
  const centerX2 = width - 1;
  const centerY2 = height - 1;
  const dx2 = 2 * x - centerX2;
  const dy2 = 2 * y - centerY2;
  const halfSpanX2 = Math.max(1, centerX2);
  const halfSpanY2 = Math.max(1, centerY2);
  const q15 = 32767;
  const nx = roundRatioSigned(dx2 * q15, halfSpanX2);
  const ny = roundRatioSigned(dy2 * q15, halfSpanY2);
  const distance = Math.min(q15, integerSqrt(nx * nx + ny * ny));
  return roundRatio(distance * MAX_Q8, q15);
}

export function applyRadialHeightFalloffRgba8(sourceValue, { innerRadiusQ8, strength }) {
  const source = assertRgba8Image(sourceValue, "radial falloff height source RGBA8 image");
  const inner = integer(innerRadiusQ8, "radial falloff innerRadiusQ8", 0, 254);
  const amount = integer(strength, "radial falloff strength", 1, MAX_Q8);
  const fadeSpan = MAX_Q8 - inner;
  return heightPixels(source, (height, x, y) => {
    const distance = normalizedRadialDistanceQ8(source.width, source.height, x, y);
    if (distance <= inner) return height;
    const penalty = roundRatio(amount * (distance - inner), fadeSpan);
    return Math.max(0, height - penalty);
  });
}

function normalizeParameters(operation, value) {
  if (operation.id === "image.height.terrace") {
    const parameters = exactKeys(value, ["levels"], `${operation.id} parameters`);
    return { levels: integer(parameters.levels, "parameters.levels", 2, MAX_LEVELS) };
  }
  if (operation.id === "image.height.radial-falloff") {
    const parameters = exactKeys(
      value,
      ["innerRadiusQ8", "strength"],
      `${operation.id} parameters`,
    );
    return {
      innerRadiusQ8: integer(parameters.innerRadiusQ8, "parameters.innerRadiusQ8", 0, 254),
      strength: integer(parameters.strength, "parameters.strength", 1, MAX_Q8),
    };
  }
  throw new Error(`unsupported terrain height operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("terrain height operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const algorithms = {
    "image.height.radial-falloff": "q8-elliptical-radial-subtractive-falloff-v1",
    "image.height.terrace": "q8-uniform-endpoint-preserving-terrace-v1",
  };
  return algorithms[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    randomness: "none",
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    heightEncoding: "luma8",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
  parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
  return build;
}

function transform(operation, source, parameters) {
  if (operation.id === "image.height.terrace") return terraceHeightRgba8(source, parameters);
  if (operation.id === "image.height.radial-falloff") {
    return applyRadialHeightFalloffRgba8(source, parameters);
  }
  throw new Error(`unsupported terrain height operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const assetRoot = assertRoot(root);
  const source = parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
  const output = transform(operation, source, build.parameters);
  const stored = await storeAssetObject(assetRoot, {
    bytes: encodeRgba8Image(output),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: output.width,
      height: output.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      field: "height",
      heightEncoding: "luma8",
      sourceSha256: build.inputs.source.sha256,
      generator: `${operation.id}@${operation.version}`,
      terrainTransform: operation.id.slice("image.height.".length),
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      width: output.width,
      height: output.height,
      algorithm: build.implementation.algorithm,
      randomness: "none",
      parameters: build.parameters,
    },
  });
}

export async function createHeightTerraceOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, HEIGHT_TERRACE_OPERATION, parameters, inputs);
}

export async function executeHeightTerraceOperation(root, invocation = {}) {
  const build = await createHeightTerraceOperationBuildIdentity(root, invocation);
  return execute(root, HEIGHT_TERRACE_OPERATION, build);
}

export async function createHeightRadialFalloffOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, HEIGHT_RADIAL_FALLOFF_OPERATION, parameters, inputs);
}

export async function executeHeightRadialFalloffOperation(root, invocation = {}) {
  const build = await createHeightRadialFalloffOperationBuildIdentity(root, invocation);
  return execute(root, HEIGHT_RADIAL_FALLOFF_OPERATION, build);
}
