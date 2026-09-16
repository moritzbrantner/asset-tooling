import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  encodeRgba8Image,
  parseRgba8Image,
  RGBA8_IMAGE_MEDIA_TYPE,
} from "./image-rgba8.js";
import {
  deriveNormalMapRgba8,
  generateTileableHeightMapRgba8,
  generateTileableValueNoiseRgba8,
} from "./procedural-textures.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_DIMENSION = 4096;
const MAX_GRID = 256;
const MAX_STRENGTH = 1024;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

const imageOutput = {
  id: "output",
  label: "Generated image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};
const heightInput = {
  id: "source",
  label: "Height source",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.procedural.texture.tileable-noise",
    version: VERSION,
    label: "Generate tileable noise texture",
    description:
      "Generate seeded periodic bilinear value noise as canonical grayscale or RGB RGBA8 texture bytes.",
    category: "procedural.texture",
    inputs: [],
    outputs: [imageOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["seed", "width", "height", "gridX", "gridY", "mode"],
      properties: {
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        gridX: { type: "integer", minimum: 1, maximum: MAX_GRID },
        gridY: { type: "integer", minimum: 1, maximum: MAX_GRID },
        mode: { type: "string", enum: ["grayscale", "rgb"] },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.procedural.height.tileable-noise",
    version: VERSION,
    label: "Generate tileable height map",
    description:
      "Generate seeded periodic bilinear value noise as an opaque grayscale canonical RGBA8 height field.",
    category: "procedural.height",
    inputs: [],
    outputs: [imageOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["seed", "width", "height", "gridX", "gridY"],
      properties: {
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        gridX: { type: "integer", minimum: 1, maximum: MAX_GRID },
        gridY: { type: "integer", minimum: 1, maximum: MAX_GRID },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.normal.from-height",
    version: VERSION,
    label: "Derive normal map from height",
    description:
      "Derive a deterministic tangent-space XYZ UNORM8 normal map from Q8 Rec.709 luma using central differences.",
    category: "texture.normal",
    inputs: [heightInput],
    outputs: [imageOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["strength", "wrap"],
      properties: {
        strength: { type: "integer", minimum: 1, maximum: MAX_STRENGTH },
        wrap: { type: "boolean" },
      },
    },
  },
]);

export const PROCEDURAL_TILEABLE_TEXTURE_OPERATION = OPERATION_REGISTRY.get(
  "image.procedural.texture.tileable-noise",
  VERSION,
);
export const PROCEDURAL_TILEABLE_HEIGHT_OPERATION = OPERATION_REGISTRY.get(
  "image.procedural.height.tileable-noise",
  VERSION,
);
export const NORMAL_FROM_HEIGHT_OPERATION = OPERATION_REGISTRY.get(
  "image.normal.from-height",
  VERSION,
);
export const PROCEDURAL_TEXTURE_OPERATIONS = OPERATION_REGISTRY.list();

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

function seed(value) {
  if (typeof value !== "string" || !SEED_PATTERN.test(value)) {
    throw new Error("parameters.seed must be a non-negative decimal integer string");
  }
  return value;
}

function normalizedDimensions(parameters) {
  return {
    width: integer(parameters.width, "parameters.width", 1, MAX_DIMENSION),
    height: integer(parameters.height, "parameters.height", 1, MAX_DIMENSION),
  };
}

function normalizedGrid(parameters, dimensions) {
  return {
    gridX: integer(parameters.gridX, "parameters.gridX", 1, Math.min(MAX_GRID, dimensions.width)),
    gridY: integer(parameters.gridY, "parameters.gridY", 1, Math.min(MAX_GRID, dimensions.height)),
  };
}

function normalizeParameters(operation, value) {
  if (operation.id === "image.procedural.texture.tileable-noise") {
    const parameters = exactKeys(
      value,
      ["seed", "width", "height", "gridX", "gridY", "mode"],
      `${operation.id} parameters`,
    );
    const dimensions = normalizedDimensions(parameters);
    const grid = normalizedGrid(parameters, dimensions);
    if (!["grayscale", "rgb"].includes(parameters.mode)) {
      throw new Error("parameters.mode must be 'grayscale' or 'rgb'");
    }
    return {
      seed: seed(parameters.seed),
      ...dimensions,
      ...grid,
      mode: parameters.mode,
    };
  }

  if (operation.id === "image.procedural.height.tileable-noise") {
    const parameters = exactKeys(
      value,
      ["seed", "width", "height", "gridX", "gridY"],
      `${operation.id} parameters`,
    );
    const dimensions = normalizedDimensions(parameters);
    return {
      seed: seed(parameters.seed),
      ...dimensions,
      ...normalizedGrid(parameters, dimensions),
    };
  }

  if (operation.id === "image.normal.from-height") {
    const parameters = exactKeys(
      value,
      ["strength", "wrap"],
      `${operation.id} parameters`,
    );
    if (typeof parameters.wrap !== "boolean") {
      throw new Error("parameters.wrap must be a boolean");
    }
    return {
      strength: integer(parameters.strength, "parameters.strength", 1, MAX_STRENGTH),
      wrap: parameters.wrap,
    };
  }

  throw new Error(`unsupported procedural texture operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural texture operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const algorithms = {
    "image.procedural.texture.tileable-noise": "periodic-integer-bilinear-value-noise-v1",
    "image.procedural.height.tileable-noise": "periodic-integer-bilinear-height-v1",
    "image.normal.from-height": "q8-luma-central-difference-integer-normal-v1",
  };
  return algorithms[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    randomness: operation.id.startsWith("image.procedural.") ? "seeded" : "none",
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
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
  if (operation.id === "image.normal.from-height") {
    parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
  }
  return build;
}

function generate(operation, parameters, source) {
  if (operation.id === "image.procedural.texture.tileable-noise") {
    return generateTileableValueNoiseRgba8(parameters);
  }
  if (operation.id === "image.procedural.height.tileable-noise") {
    return generateTileableHeightMapRgba8(parameters);
  }
  if (operation.id === "image.normal.from-height") {
    return deriveNormalMapRgba8(source, parameters);
  }
  throw new Error(`unsupported procedural texture operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const assetRoot = assertRoot(root);
  const source =
    operation.id === "image.normal.from-height"
      ? parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source))
      : undefined;
  const output = generate(operation, build.parameters, source);
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
      generator: `${operation.id}@${operation.version}`,
      ...(operation.id === "image.procedural.height.tileable-noise"
        ? { field: "height", heightEncoding: "luma8", tileable: true }
        : {}),
      ...(operation.id === "image.procedural.texture.tileable-noise"
        ? { tileable: true }
        : {}),
      ...(operation.id === "image.normal.from-height"
        ? {
            field: "normal",
            normalEncoding: "xyz-unorm8",
            tangentSpace: true,
            sourceSha256: build.inputs.source.sha256,
            wrap: build.parameters.wrap,
          }
        : {}),
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

export async function createTileableTextureOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_TILEABLE_TEXTURE_OPERATION, parameters, inputs);
}

export async function executeTileableTextureOperation(root, invocation = {}) {
  const build = await createTileableTextureOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_TILEABLE_TEXTURE_OPERATION, build);
}

export async function createTileableHeightOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_TILEABLE_HEIGHT_OPERATION, parameters, inputs);
}

export async function executeTileableHeightOperation(root, invocation = {}) {
  const build = await createTileableHeightOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_TILEABLE_HEIGHT_OPERATION, build);
}

export async function createNormalFromHeightOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, NORMAL_FROM_HEIGHT_OPERATION, parameters, inputs);
}

export async function executeNormalFromHeightOperation(root, invocation = {}) {
  const build = await createNormalFromHeightOperationBuildIdentity(root, invocation);
  return execute(root, NORMAL_FROM_HEIGHT_OPERATION, build);
}
