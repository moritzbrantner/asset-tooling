import path from "node:path";
import { storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  generateCircleSdfRgba8,
  generateCircleSvg,
  generateRoundedRectSdfRgba8,
  generateRoundedRectSvg,
} from "./procedural-shapes.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_DIMENSION = 4096;
const SVG_COLOR_PATTERN = "^#[0-9a-f]{6}$";

const imageOutput = {
  id: "output",
  label: "Generated SDF image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};
const vectorOutput = {
  id: "output",
  label: "Generated vector image",
  assetKinds: ["vector-image"],
  mediaTypes: ["image/svg+xml"],
};

const dimensionProperties = {
  width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
  height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.procedural.sdf.circle",
    version: VERSION,
    label: "Generate circle SDF",
    description: "Generate a deterministic grayscale circle signed-distance field with 128 as the exact boundary.",
    category: "procedural.image",
    inputs: [],
    outputs: [imageOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "centerX", "centerY", "radius", "spread"],
      properties: {
        ...dimensionProperties,
        centerX: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        centerY: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        radius: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        spread: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.procedural.sdf.rounded-rect",
    version: VERSION,
    label: "Generate rounded rectangle SDF",
    description: "Generate a deterministic grayscale rounded-rectangle signed-distance field with 128 as the exact boundary.",
    category: "procedural.image",
    inputs: [],
    outputs: [imageOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "width",
        "height",
        "centerX",
        "centerY",
        "halfWidth",
        "halfHeight",
        "cornerRadius",
        "spread",
      ],
      properties: {
        ...dimensionProperties,
        centerX: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        centerY: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        halfWidth: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        halfHeight: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        cornerRadius: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        spread: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "vector.procedural.circle",
    version: VERSION,
    label: "Generate SVG circle",
    description: "Generate one canonical filled SVG circle with integer geometry.",
    category: "procedural.vector",
    inputs: [],
    outputs: [vectorOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "centerX", "centerY", "radius", "fill"],
      properties: {
        ...dimensionProperties,
        centerX: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        centerY: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        radius: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        fill: { type: "string", pattern: SVG_COLOR_PATTERN },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "vector.procedural.rounded-rect",
    version: VERSION,
    label: "Generate SVG rounded rectangle",
    description: "Generate one canonical filled SVG rounded rectangle with integer geometry.",
    category: "procedural.vector",
    inputs: [],
    outputs: [vectorOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "x", "y", "rectWidth", "rectHeight", "cornerRadius", "fill"],
      properties: {
        ...dimensionProperties,
        x: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        y: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        rectWidth: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        rectHeight: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        cornerRadius: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        fill: { type: "string", pattern: SVG_COLOR_PATTERN },
      },
    },
  },
]);

export const PROCEDURAL_CIRCLE_SDF_OPERATION = OPERATION_REGISTRY.get("image.procedural.sdf.circle", VERSION);
export const PROCEDURAL_ROUNDED_RECT_SDF_OPERATION = OPERATION_REGISTRY.get("image.procedural.sdf.rounded-rect", VERSION);
export const PROCEDURAL_CIRCLE_VECTOR_OPERATION = OPERATION_REGISTRY.get("vector.procedural.circle", VERSION);
export const PROCEDURAL_ROUNDED_RECT_VECTOR_OPERATION = OPERATION_REGISTRY.get("vector.procedural.rounded-rect", VERSION);
export const PROCEDURAL_SHAPE_OPERATIONS = OPERATION_REGISTRY.list();

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

function fill(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/.test(value)) {
    throw new Error("parameters.fill must be a lowercase #rrggbb color");
  }
  return value;
}

function dimensions(parameters) {
  return {
    width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
    height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
  };
}

function normalizeParameters(operation, value) {
  if (operation.id === "image.procedural.sdf.circle") {
    const parameters = exactKeys(
      value,
      ["width", "height", "centerX", "centerY", "radius", "spread"],
      `${operation.id} parameters`,
    );
    const normalized = dimensions(parameters);
    return {
      ...normalized,
      centerX: integer(parameters.centerX, "parameters.centerX", 0, normalized.width - 1),
      centerY: integer(parameters.centerY, "parameters.centerY", 0, normalized.height - 1),
      radius: integer(parameters.radius, "parameters.radius", 1, MAX_DIMENSION),
      spread: integer(parameters.spread, "parameters.spread", 1, MAX_DIMENSION),
    };
  }
  if (operation.id === "image.procedural.sdf.rounded-rect") {
    const parameters = exactKeys(
      value,
      ["width", "height", "centerX", "centerY", "halfWidth", "halfHeight", "cornerRadius", "spread"],
      `${operation.id} parameters`,
    );
    const normalized = dimensions(parameters);
    const halfWidth = integer(parameters.halfWidth, "parameters.halfWidth", 1, MAX_DIMENSION);
    const halfHeight = integer(parameters.halfHeight, "parameters.halfHeight", 1, MAX_DIMENSION);
    return {
      ...normalized,
      centerX: integer(parameters.centerX, "parameters.centerX", 0, normalized.width - 1),
      centerY: integer(parameters.centerY, "parameters.centerY", 0, normalized.height - 1),
      halfWidth,
      halfHeight,
      cornerRadius: integer(parameters.cornerRadius, "parameters.cornerRadius", 0, Math.min(halfWidth, halfHeight)),
      spread: integer(parameters.spread, "parameters.spread", 1, MAX_DIMENSION),
    };
  }
  if (operation.id === "vector.procedural.circle") {
    const parameters = exactKeys(
      value,
      ["width", "height", "centerX", "centerY", "radius", "fill"],
      `${operation.id} parameters`,
    );
    const normalized = dimensions(parameters);
    return {
      ...normalized,
      centerX: integer(parameters.centerX, "parameters.centerX", 0, normalized.width),
      centerY: integer(parameters.centerY, "parameters.centerY", 0, normalized.height),
      radius: integer(parameters.radius, "parameters.radius", 1, MAX_DIMENSION),
      fill: fill(parameters.fill),
    };
  }
  if (operation.id === "vector.procedural.rounded-rect") {
    const parameters = exactKeys(
      value,
      ["width", "height", "x", "y", "rectWidth", "rectHeight", "cornerRadius", "fill"],
      `${operation.id} parameters`,
    );
    const normalized = dimensions(parameters);
    const rectWidth = integer(parameters.rectWidth, "parameters.rectWidth", 1, MAX_DIMENSION);
    const rectHeight = integer(parameters.rectHeight, "parameters.rectHeight", 1, MAX_DIMENSION);
    return {
      ...normalized,
      x: integer(parameters.x, "parameters.x", 0, normalized.width - 1),
      y: integer(parameters.y, "parameters.y", 0, normalized.height - 1),
      rectWidth,
      rectHeight,
      cornerRadius: integer(parameters.cornerRadius, "parameters.cornerRadius", 0, Math.floor(Math.min(rectWidth, rectHeight) / 2)),
      fill: fill(parameters.fill),
    };
  }
  throw new Error(`unsupported procedural shape operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural shape operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const values = {
    "image.procedural.sdf.circle": "integer-euclidean-circle-sdf-v1",
    "image.procedural.sdf.rounded-rect": "integer-euclidean-rounded-rect-sdf-v1",
    "vector.procedural.circle": "canonical-svg-circle-v1",
    "vector.procedural.rounded-rect": "canonical-svg-rounded-rect-v1",
  };
  return values[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    randomness: "none",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(operation, parameters, inputs) {
  return createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
}

function generate(operation, parameters) {
  if (operation.id === "image.procedural.sdf.circle") return generateCircleSdfRgba8(parameters);
  if (operation.id === "image.procedural.sdf.rounded-rect") return generateRoundedRectSdfRgba8(parameters);
  if (operation.id === "vector.procedural.circle") return generateCircleSvg(parameters);
  if (operation.id === "vector.procedural.rounded-rect") return generateRoundedRectSvg(parameters);
  throw new Error(`unsupported procedural shape operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const generated = generate(operation, build.parameters);
  const isVector = operation.id.startsWith("vector.");
  const bytes = isVector ? generated.bytes : encodeRgba8Image(generated);
  const stored = await storeAssetObject(assertRoot(root), {
    bytes,
    kind: isVector ? "vector-image" : "image",
    mediaType: isVector ? "image/svg+xml" : RGBA8_IMAGE_MEDIA_TYPE,
    metadata: isVector
      ? {
          width: generated.width,
          height: generated.height,
          vectorFormat: "svg",
          generator: `${operation.id}@${operation.version}`,
        }
      : {
          width: generated.width,
          height: generated.height,
          pixelFormat: "rgba8",
          colorSpace: "srgb",
          alphaMode: "straight",
          field: "signed-distance",
          boundaryValue: 128,
          generator: `${operation.id}@${operation.version}`,
        },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      width: generated.width,
      height: generated.height,
      algorithm: build.implementation.algorithm,
      randomness: "none",
      parameters: build.parameters,
    },
  });
}

function buildFactory(operation) {
  return async function createProceduralShapeBuildIdentity({ parameters = {}, inputs = {} } = {}) {
    return createBuildIdentity(operation, parameters, inputs);
  };
}

function executeFactory(operation, createBuildIdentityForOperation) {
  return async function executeProceduralShapeOperation(root, invocation = {}) {
    const build = await createBuildIdentityForOperation(invocation);
    return execute(root, operation, build);
  };
}

export const createProceduralCircleSdfOperationBuildIdentity = buildFactory(PROCEDURAL_CIRCLE_SDF_OPERATION);
export const createProceduralRoundedRectSdfOperationBuildIdentity = buildFactory(PROCEDURAL_ROUNDED_RECT_SDF_OPERATION);
export const createProceduralCircleVectorOperationBuildIdentity = buildFactory(PROCEDURAL_CIRCLE_VECTOR_OPERATION);
export const createProceduralRoundedRectVectorOperationBuildIdentity = buildFactory(PROCEDURAL_ROUNDED_RECT_VECTOR_OPERATION);

export const executeProceduralCircleSdfOperation = executeFactory(
  PROCEDURAL_CIRCLE_SDF_OPERATION,
  createProceduralCircleSdfOperationBuildIdentity,
);
export const executeProceduralRoundedRectSdfOperation = executeFactory(
  PROCEDURAL_ROUNDED_RECT_SDF_OPERATION,
  createProceduralRoundedRectSdfOperationBuildIdentity,
);
export const executeProceduralCircleVectorOperation = executeFactory(
  PROCEDURAL_CIRCLE_VECTOR_OPERATION,
  createProceduralCircleVectorOperationBuildIdentity,
);
export const executeProceduralRoundedRectVectorOperation = executeFactory(
  PROCEDURAL_ROUNDED_RECT_VECTOR_OPERATION,
  createProceduralRoundedRectVectorOperationBuildIdentity,
);
