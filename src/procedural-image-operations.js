import path from "node:path";
import { storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { generateLinearGradientRgba8, generateNoiseRgba8 } from "./procedural-image.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_DIMENSION = 4096;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

const outputPort = {
  id: "output",
  label: "Generated image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.procedural.noise",
    version: VERSION,
    label: "Generate seeded image noise",
    description:
      "Generate deterministic coordinate-hashed grayscale or RGB white noise into canonical RGBA8 pixels.",
    category: "procedural.image",
    inputs: [],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["seed", "width", "height", "mode"],
      properties: {
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        mode: { type: "string", enum: ["grayscale", "rgb"] },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.procedural.gradient",
    version: VERSION,
    label: "Generate linear image gradient",
    description:
      "Generate an exact integer RGBA8 linear gradient between explicit endpoint colors.",
    category: "procedural.image",
    inputs: [],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "direction", "startColor", "endColor"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        direction: {
          type: "string",
          enum: ["horizontal", "vertical", "diagonal-down", "diagonal-up"],
        },
        startColor: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "integer", minimum: 0, maximum: 255 },
        },
        endColor: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "integer", minimum: 0, maximum: 255 },
        },
      },
    },
  },
]);

export const PROCEDURAL_IMAGE_NOISE_OPERATION = OPERATION_REGISTRY.get(
  "image.procedural.noise",
  VERSION,
);
export const PROCEDURAL_IMAGE_GRADIENT_OPERATION = OPERATION_REGISTRY.get(
  "image.procedural.gradient",
  VERSION,
);
export const PROCEDURAL_IMAGE_OPERATIONS = OPERATION_REGISTRY.list();

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

function rgba(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${location} must contain exactly four RGBA8 channels`);
  }
  return value.map((entry, index) => integer(entry, `${location}[${index}]`, 0, 255));
}

function normalizeParameters(operation, value) {
  if (operation.id === "image.procedural.noise") {
    const parameters = exactKeys(
      value,
      ["seed", "width", "height", "mode"],
      "image.procedural.noise parameters",
    );
    if (typeof parameters.seed !== "string" || !SEED_PATTERN.test(parameters.seed)) {
      throw new Error("parameters.seed must be a non-negative decimal integer string");
    }
    if (!["grayscale", "rgb"].includes(parameters.mode)) {
      throw new Error("parameters.mode must be 'grayscale' or 'rgb'");
    }
    return {
      seed: parameters.seed,
      width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
      height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
      mode: parameters.mode,
    };
  }

  const parameters = exactKeys(
    value,
    ["width", "height", "direction", "startColor", "endColor"],
    "image.procedural.gradient parameters",
  );
  if (!["horizontal", "vertical", "diagonal-down", "diagonal-up"].includes(parameters.direction)) {
    throw new Error("parameters.direction is unsupported");
  }
  return {
    width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
    height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
    direction: parameters.direction,
    startColor: rgba(parameters.startColor, "parameters.startColor"),
    endColor: rgba(parameters.endColor, "parameters.endColor"),
  };
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural image operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  return operation.id === "image.procedural.noise"
    ? "fnv1a32-coordinate-avalanche-rgba8-v1"
    : "rgba8-endpoint-linear-rational-v1";
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    randomness: operation.id === "image.procedural.noise" ? "seeded" : "none",
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
  if (operation.id === "image.procedural.noise") return generateNoiseRgba8(parameters);
  if (operation.id === "image.procedural.gradient") return generateLinearGradientRgba8(parameters);
  throw new Error(`unsupported procedural image operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const output = generate(operation, build.parameters);
  const stored = await storeAssetObject(assertRoot(root), {
    bytes: encodeRgba8Image(output),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: output.width,
      height: output.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      generator: `${operation.id}@${operation.version}`,
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      width: output.width,
      height: output.height,
      algorithm: build.implementation.algorithm,
      randomness: build.implementation.randomness,
      parameters: build.parameters,
    },
  });
}

export async function createProceduralImageNoiseOperationBuildIdentity({
  parameters = {},
  inputs = {},
} = {}) {
  return createBuildIdentity(PROCEDURAL_IMAGE_NOISE_OPERATION, parameters, inputs);
}

export async function executeProceduralImageNoiseOperation(root, invocation = {}) {
  const build = await createProceduralImageNoiseOperationBuildIdentity(invocation);
  return execute(root, PROCEDURAL_IMAGE_NOISE_OPERATION, build);
}

export async function createProceduralImageGradientOperationBuildIdentity({
  parameters = {},
  inputs = {},
} = {}) {
  return createBuildIdentity(PROCEDURAL_IMAGE_GRADIENT_OPERATION, parameters, inputs);
}

export async function executeProceduralImageGradientOperation(root, invocation = {}) {
  const build = await createProceduralImageGradientOperationBuildIdentity(invocation);
  return execute(root, PROCEDURAL_IMAGE_GRADIENT_OPERATION, build);
}
