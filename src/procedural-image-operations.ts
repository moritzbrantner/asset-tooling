import path from "node:path";
import { storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  generateLinearGradientRgba8,
  generateNoiseRgba8,
  generatePatternRgba8,
  generateVoronoiRgba8,
} from "./procedural-image.js";
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

const rgbaSchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: { type: "integer", minimum: 0, maximum: 255 },
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
        startColor: rgbaSchema,
        endColor: rgbaSchema,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.procedural.pattern",
    version: VERSION,
    label: "Generate two-color image pattern",
    description:
      "Generate exact checker or stripe patterns from two explicit RGBA8 colors and an integer pattern size.",
    category: "procedural.image",
    inputs: [],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "pattern", "size", "colors"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        pattern: {
          type: "string",
          enum: [
            "checker",
            "stripes-horizontal",
            "stripes-vertical",
            "stripes-diagonal-down",
            "stripes-diagonal-up",
          ],
        },
        size: { type: "integer", minimum: 1, maximum: 1024 },
        colors: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: rgbaSchema,
        },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.procedural.voronoi",
    version: VERSION,
    label: "Generate seeded Voronoi field",
    description:
      "Generate a deterministic jittered-cell Voronoi field as seeded cell colors or clamped nearest-feature distance.",
    category: "procedural.image",
    inputs: [],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["seed", "width", "height", "cellSize", "mode"],
      properties: {
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        cellSize: { type: "integer", minimum: 1, maximum: 512 },
        mode: { type: "string", enum: ["cells", "distance"] },
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
export const PROCEDURAL_IMAGE_PATTERN_OPERATION = OPERATION_REGISTRY.get(
  "image.procedural.pattern",
  VERSION,
);
export const PROCEDURAL_IMAGE_VORONOI_OPERATION = OPERATION_REGISTRY.get(
  "image.procedural.voronoi",
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

function seed(value, location = "parameters.seed") {
  if (typeof value !== "string" || !SEED_PATTERN.test(value)) {
    throw new Error(`${location} must be a non-negative decimal integer string`);
  }
  return value;
}

function rgba(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${location} must contain exactly four RGBA8 channels`);
  }
  return value.map((entry, index) => integer(entry, `${location}[${index}]`, 0, 255));
}

function colors(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("parameters.colors must contain exactly two RGBA8 colors");
  }
  return value.map((entry, index) => rgba(entry, `parameters.colors[${index}]`));
}

function normalizeParameters(operation, value) {
  if (operation.id === "image.procedural.noise") {
    const parameters = exactKeys(
      value,
      ["seed", "width", "height", "mode"],
      "image.procedural.noise parameters",
    );
    if (!["grayscale", "rgb"].includes(parameters.mode)) {
      throw new Error("parameters.mode must be 'grayscale' or 'rgb'");
    }
    return {
      seed: seed(parameters.seed),
      width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
      height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
      mode: parameters.mode,
    };
  }

  if (operation.id === "image.procedural.gradient") {
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

  if (operation.id === "image.procedural.pattern") {
    const parameters = exactKeys(
      value,
      ["width", "height", "pattern", "size", "colors"],
      "image.procedural.pattern parameters",
    );
    if (
      ![
        "checker",
        "stripes-horizontal",
        "stripes-vertical",
        "stripes-diagonal-down",
        "stripes-diagonal-up",
      ].includes(parameters.pattern)
    ) {
      throw new Error("parameters.pattern is unsupported");
    }
    return {
      width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
      height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
      pattern: parameters.pattern,
      size: integer(parameters.size, "parameters.size", 1, 1024),
      colors: colors(parameters.colors),
    };
  }

  if (operation.id === "image.procedural.voronoi") {
    const parameters = exactKeys(
      value,
      ["seed", "width", "height", "cellSize", "mode"],
      "image.procedural.voronoi parameters",
    );
    if (!["cells", "distance"].includes(parameters.mode)) {
      throw new Error("parameters.mode must be 'cells' or 'distance'");
    }
    return {
      seed: seed(parameters.seed),
      width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
      height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
      cellSize: integer(parameters.cellSize, "parameters.cellSize", 1, 512),
      mode: parameters.mode,
    };
  }

  throw new Error(`unsupported procedural image operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural image operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const values = {
    "image.procedural.noise": "fnv1a32-coordinate-avalanche-rgba8-v1",
    "image.procedural.gradient": "rgba8-endpoint-linear-rational-v1",
    "image.procedural.pattern": "two-color-integer-grid-pattern-v1",
    "image.procedural.voronoi": "fnv1a32-jittered-cellular-nearest-v1",
  };
  return values[operation.id];
}

async function implementationIdentity(operation) {
  const seeded = ["image.procedural.noise", "image.procedural.voronoi"].includes(operation.id);
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    randomness: seeded ? "seeded" : "none",
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
  if (operation.id === "image.procedural.pattern") return generatePatternRgba8(parameters);
  if (operation.id === "image.procedural.voronoi") return generateVoronoiRgba8(parameters);
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

export async function createProceduralImagePatternOperationBuildIdentity({
  parameters = {},
  inputs = {},
} = {}) {
  return createBuildIdentity(PROCEDURAL_IMAGE_PATTERN_OPERATION, parameters, inputs);
}

export async function executeProceduralImagePatternOperation(root, invocation = {}) {
  const build = await createProceduralImagePatternOperationBuildIdentity(invocation);
  return execute(root, PROCEDURAL_IMAGE_PATTERN_OPERATION, build);
}

export async function createProceduralImageVoronoiOperationBuildIdentity({
  parameters = {},
  inputs = {},
} = {}) {
  return createBuildIdentity(PROCEDURAL_IMAGE_VORONOI_OPERATION, parameters, inputs);
}

export async function executeProceduralImageVoronoiOperation(root, invocation = {}) {
  const build = await createProceduralImageVoronoiOperationBuildIdentity(invocation);
  return execute(root, PROCEDURAL_IMAGE_VORONOI_OPERATION, build);
}
