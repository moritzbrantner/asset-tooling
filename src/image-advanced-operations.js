import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  applyMaskRgba8,
  mapPaletteRgba8,
  morphologyRgba8,
  normalizePalette,
  orderedDitherRgba8,
  sobelEdgesRgba8,
  uniformQuantizeRgba8,
} from "./image-advanced.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "./image-rgba8.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const sourcePort = {
  id: "source",
  label: "Source image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};
const outputPort = {
  id: "output",
  label: "Image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};
const maskPort = {
  id: "mask",
  label: "Mask image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.edges.sobel",
    version: VERSION,
    label: "Detect Sobel edges",
    description: "Emit deterministic grayscale Sobel L1 edge magnitude while preserving source alpha.",
    category: "image.analysis",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "image.morphology",
    version: VERSION,
    label: "Apply image morphology",
    description: "Dilate or erode luma or alpha with a bounded square neighborhood and clamped edges.",
    category: "image.filter",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "channel", "radius"],
      properties: {
        mode: { type: "string", enum: ["dilate", "erode"] },
        channel: { type: "string", enum: ["luma", "alpha"] },
        radius: { type: "integer", minimum: 1, maximum: 3 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.mask.apply",
    version: VERSION,
    label: "Apply image mask",
    description: "Multiply source alpha by mask luma or alpha with exact dimension matching.",
    category: "image.alpha",
    inputs: [sourcePort, maskPort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: { channel: { type: "string", enum: ["luma", "alpha"] } },
    },
  },
  {
    schemaVersion: 1,
    id: "image.quantize.uniform",
    version: VERSION,
    label: "Uniformly quantize image",
    description: "Quantize each RGB channel to an explicit 1..8-bit uniform grid while preserving alpha.",
    category: "image.quantization",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["bitsPerChannel"],
      properties: { bitsPerChannel: { type: "integer", minimum: 1, maximum: 8 } },
    },
  },
  {
    schemaVersion: 1,
    id: "image.palette.map",
    version: VERSION,
    label: "Map image to palette",
    description: "Map RGB to the nearest explicitly ordered palette color with first-entry tie breaking.",
    category: "image.quantization",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["palette"],
      properties: {
        palette: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: { type: "integer", minimum: 0, maximum: 255 },
          },
        },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.dither.ordered",
    version: VERSION,
    label: "Apply ordered image dithering",
    description: "Quantize RGB with a fixed 4x4 Bayer threshold matrix while preserving alpha.",
    category: "image.quantization",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["bitsPerChannel"],
      properties: { bitsPerChannel: { type: "integer", minimum: 1, maximum: 8 } },
    },
  },
]);

export const IMAGE_SOBEL_EDGES_OPERATION = OPERATION_REGISTRY.get("image.edges.sobel", VERSION);
export const IMAGE_MORPHOLOGY_OPERATION = OPERATION_REGISTRY.get("image.morphology", VERSION);
export const IMAGE_MASK_APPLY_OPERATION = OPERATION_REGISTRY.get("image.mask.apply", VERSION);
export const IMAGE_UNIFORM_QUANTIZE_OPERATION = OPERATION_REGISTRY.get("image.quantize.uniform", VERSION);
export const IMAGE_PALETTE_MAP_OPERATION = OPERATION_REGISTRY.get("image.palette.map", VERSION);
export const IMAGE_ORDERED_DITHER_OPERATION = OPERATION_REGISTRY.get("image.dither.ordered", VERSION);
export const IMAGE_ADVANCED_OPERATIONS = OPERATION_REGISTRY.list();

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, location) {
  const object = plainObject(value, location);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
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

function normalizeParameters(operation, value) {
  if (operation.id === "image.edges.sobel") {
    exactKeys(value, [], "image.edges.sobel parameters");
    return {};
  }
  if (operation.id === "image.morphology") {
    const parameters = exactKeys(value, ["mode", "channel", "radius"], "image.morphology parameters");
    if (!["dilate", "erode"].includes(parameters.mode)) throw new Error("parameters.mode is unsupported");
    if (!["luma", "alpha"].includes(parameters.channel)) throw new Error("parameters.channel is unsupported");
    return {
      mode: parameters.mode,
      channel: parameters.channel,
      radius: integer(parameters.radius, "parameters.radius", 1, 3),
    };
  }
  if (operation.id === "image.mask.apply") {
    const parameters = exactKeys(value, ["channel"], "image.mask.apply parameters");
    if (!["luma", "alpha"].includes(parameters.channel)) throw new Error("parameters.channel is unsupported");
    return { channel: parameters.channel };
  }
  if (operation.id === "image.quantize.uniform" || operation.id === "image.dither.ordered") {
    const parameters = exactKeys(value, ["bitsPerChannel"], `${operation.id} parameters`);
    return { bitsPerChannel: integer(parameters.bitsPerChannel, "parameters.bitsPerChannel", 1, 8) };
  }
  if (operation.id === "image.palette.map") {
    const parameters = exactKeys(value, ["palette"], "image.palette.map parameters");
    return { palette: normalizePalette(parameters.palette) };
  }
  throw new Error(`unsupported advanced image operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("advanced image operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const values = {
    "image.edges.sobel": "sobel-l1-q8-luma-v1",
    "image.morphology": "square-clamp-morphology-v1",
    "image.mask.apply": "straight-alpha-mask-multiply-v1",
    "image.quantize.uniform": "uniform-rgb-quantize-v1",
    "image.palette.map": "ordered-nearest-rgb-palette-v1",
    "image.dither.ordered": "bayer4x4-rgb-ordered-v1",
  };
  return values[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.image.rgba8.${operation.id.slice("image.".length)}`,
    version: VERSION,
    algorithm: algorithm(operation),
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    tool: await captureToolIdentity(),
  };
}

async function parsedInput(root, asset) {
  return parseRgba8Image(await resolveAssetObject(root, asset));
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const identity = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters,
    inputs,
  });
  const source = await parsedInput(assetRoot, identity.inputs.source);
  if (operation.id === "image.mask.apply") {
    const mask = await parsedInput(assetRoot, identity.inputs.mask);
    if (source.width !== mask.width || source.height !== mask.height) {
      throw new Error("mask dimensions must exactly match source dimensions");
    }
  }
  return identity;
}

async function transform(root, operation, build) {
  const source = await parsedInput(root, build.inputs.source);
  if (operation.id === "image.edges.sobel") return sobelEdgesRgba8(source);
  if (operation.id === "image.morphology") return morphologyRgba8(source, build.parameters);
  if (operation.id === "image.mask.apply") {
    const mask = await parsedInput(root, build.inputs.mask);
    return applyMaskRgba8(source, mask, build.parameters.channel);
  }
  if (operation.id === "image.quantize.uniform") return uniformQuantizeRgba8(source, build.parameters.bitsPerChannel);
  if (operation.id === "image.palette.map") return mapPaletteRgba8(source, build.parameters.palette);
  if (operation.id === "image.dither.ordered") return orderedDitherRgba8(source, build.parameters.bitsPerChannel);
  throw new Error(`unsupported advanced image operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const output = await transform(root, operation, build);
  const inputLineage = Object.entries(build.inputs).map(([port, asset]) => ({ port, sha256: asset.sha256 }));
  const stored = await storeAssetObject(root, {
    bytes: encodeRgba8Image(output),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: output.width,
      height: output.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      inputs: inputLineage,
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      width: output.width,
      height: output.height,
      algorithm: build.implementation.algorithm,
      parameters: build.parameters,
    },
  });
}

export function createAdvancedImageOperationBuildIdentityFactory(operation) {
  return async function createAdvancedImageOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
    return createBuildIdentity(root, operation, normalizeParameters(operation, parameters), inputs);
  };
}

export function executeAdvancedImageOperationFactory(operation) {
  const createIdentity = createAdvancedImageOperationBuildIdentityFactory(operation);
  return async function executeAdvancedImageOperation(root, invocation = {}) {
    const build = await createIdentity(root, invocation);
    return execute(assertRoot(root), operation, build);
  };
}

export const createImageSobelEdgesOperationBuildIdentity = createAdvancedImageOperationBuildIdentityFactory(IMAGE_SOBEL_EDGES_OPERATION);
export const createImageMorphologyOperationBuildIdentity = createAdvancedImageOperationBuildIdentityFactory(IMAGE_MORPHOLOGY_OPERATION);
export const createImageMaskApplyOperationBuildIdentity = createAdvancedImageOperationBuildIdentityFactory(IMAGE_MASK_APPLY_OPERATION);
export const createImageUniformQuantizeOperationBuildIdentity = createAdvancedImageOperationBuildIdentityFactory(IMAGE_UNIFORM_QUANTIZE_OPERATION);
export const createImagePaletteMapOperationBuildIdentity = createAdvancedImageOperationBuildIdentityFactory(IMAGE_PALETTE_MAP_OPERATION);
export const createImageOrderedDitherOperationBuildIdentity = createAdvancedImageOperationBuildIdentityFactory(IMAGE_ORDERED_DITHER_OPERATION);

export const executeImageSobelEdgesOperation = executeAdvancedImageOperationFactory(IMAGE_SOBEL_EDGES_OPERATION);
export const executeImageMorphologyOperation = executeAdvancedImageOperationFactory(IMAGE_MORPHOLOGY_OPERATION);
export const executeImageMaskApplyOperation = executeAdvancedImageOperationFactory(IMAGE_MASK_APPLY_OPERATION);
export const executeImageUniformQuantizeOperation = executeAdvancedImageOperationFactory(IMAGE_UNIFORM_QUANTIZE_OPERATION);
export const executeImagePaletteMapOperation = executeAdvancedImageOperationFactory(IMAGE_PALETTE_MAP_OPERATION);
export const executeImageOrderedDitherOperation = executeAdvancedImageOperationFactory(IMAGE_ORDERED_DITHER_OPERATION);
