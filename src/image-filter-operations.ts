import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  contrastRgba8,
  exposureRgba8,
  grayscaleRgba8,
  levelsRgba8,
  thresholdRgba8,
} from "./image-color.js";
import {
  boxBlurRgba8,
  convolveRgba8,
  normalizeConvolutionKernel,
  sharpenRgba8,
} from "./image-convolution.js";
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

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.exposure",
    version: VERSION,
    label: "Adjust image exposure",
    description: "Scale RGB code values by an explicit rational gain while preserving alpha.",
    category: "image.color",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["numerator", "denominator"],
      properties: {
        numerator: { type: "integer", minimum: 0, maximum: 65535 },
        denominator: { type: "integer", minimum: 1, maximum: 65535 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.contrast",
    version: VERSION,
    label: "Adjust image contrast",
    description: "Scale RGB distance from code-value midpoint 128 by an explicit rational factor.",
    category: "image.color",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["numerator", "denominator"],
      properties: {
        numerator: { type: "integer", minimum: 0, maximum: 65535 },
        denominator: { type: "integer", minimum: 1, maximum: 65535 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.levels",
    version: VERSION,
    label: "Remap image levels",
    description: "Map an explicit input black/white interval to an explicit output interval with integer interpolation.",
    category: "image.color",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["blackPoint", "whitePoint", "outputBlack", "outputWhite"],
      properties: {
        blackPoint: { type: "integer", minimum: 0, maximum: 255 },
        whitePoint: { type: "integer", minimum: 0, maximum: 255 },
        outputBlack: { type: "integer", minimum: 0, maximum: 255 },
        outputWhite: { type: "integer", minimum: 0, maximum: 255 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.grayscale",
    version: VERSION,
    label: "Convert image to grayscale",
    description: "Replace RGB with deterministic Q8 Rec.709 luma while preserving alpha.",
    category: "image.color",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "image.threshold",
    version: VERSION,
    label: "Threshold image",
    description: "Threshold deterministic Q8 Rec.709 luma into black or white while preserving alpha.",
    category: "image.color",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["threshold"],
      properties: { threshold: { type: "integer", minimum: 0, maximum: 255 } },
    },
  },
  {
    schemaVersion: 1,
    id: "image.blur",
    version: VERSION,
    label: "Blur image",
    description: "Apply a bounded odd box blur using clamped edges and premultiplied-alpha convolution.",
    category: "image.filter",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["radius"],
      properties: { radius: { type: "integer", minimum: 1, maximum: 3 } },
    },
  },
  {
    schemaVersion: 1,
    id: "image.sharpen",
    version: VERSION,
    label: "Sharpen image",
    description: "Apply a bounded cross sharpen kernel with rational amount and preserved alpha.",
    category: "image.filter",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["numerator", "denominator"],
      properties: {
        numerator: { type: "integer", minimum: 0, maximum: 32 },
        denominator: { type: "integer", minimum: 1, maximum: 32 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.convolve",
    version: VERSION,
    label: "Convolve image",
    description: "Apply a bounded integer kernel with clamped edges and explicit alpha behavior.",
    category: "image.filter",
    inputs: [sourcePort],
    outputs: [outputPort],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "weights", "divisor", "bias", "alphaMode"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: 7 },
        height: { type: "integer", minimum: 1, maximum: 7 },
        weights: {
          type: "array",
          minItems: 1,
          maxItems: 49,
          items: { type: "integer", minimum: -4096, maximum: 4096 },
        },
        divisor: { type: "integer", minimum: 1, maximum: 1000000 },
        bias: { type: "integer", minimum: -255, maximum: 255 },
        alphaMode: { type: "string", enum: ["preserve", "convolve-premultiplied"] },
      },
    },
  },
]);

export const IMAGE_EXPOSURE_OPERATION = OPERATION_REGISTRY.get("image.exposure", VERSION);
export const IMAGE_CONTRAST_OPERATION = OPERATION_REGISTRY.get("image.contrast", VERSION);
export const IMAGE_LEVELS_OPERATION = OPERATION_REGISTRY.get("image.levels", VERSION);
export const IMAGE_GRAYSCALE_OPERATION = OPERATION_REGISTRY.get("image.grayscale", VERSION);
export const IMAGE_THRESHOLD_OPERATION = OPERATION_REGISTRY.get("image.threshold", VERSION);
export const IMAGE_BLUR_OPERATION = OPERATION_REGISTRY.get("image.blur", VERSION);
export const IMAGE_SHARPEN_OPERATION = OPERATION_REGISTRY.get("image.sharpen", VERSION);
export const IMAGE_CONVOLVE_OPERATION = OPERATION_REGISTRY.get("image.convolve", VERSION);
export const IMAGE_FILTER_OPERATIONS = OPERATION_REGISTRY.list();

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
  if (operation.id === "image.exposure" || operation.id === "image.contrast") {
    const parameters = exactKeys(value, ["numerator", "denominator"], `${operation.id} parameters`);
    return {
      numerator: integer(parameters.numerator, "parameters.numerator", 0, 65535),
      denominator: integer(parameters.denominator, "parameters.denominator", 1, 65535),
    };
  }
  if (operation.id === "image.levels") {
    const parameters = exactKeys(
      value,
      ["blackPoint", "whitePoint", "outputBlack", "outputWhite"],
      "image.levels parameters",
    );
    const normalized = Object.fromEntries(
      Object.entries(parameters).map(([key, child]) => [key, integer(child, `parameters.${key}`, 0, 255)]),
    );
    if (normalized.blackPoint >= normalized.whitePoint) {
      throw new Error("parameters.blackPoint must be less than parameters.whitePoint");
    }
    if (normalized.outputBlack > normalized.outputWhite) {
      throw new Error("parameters.outputBlack must not exceed parameters.outputWhite");
    }
    return normalized;
  }
  if (operation.id === "image.grayscale") {
    exactKeys(value, [], "image.grayscale parameters");
    return {};
  }
  if (operation.id === "image.threshold") {
    const parameters = exactKeys(value, ["threshold"], "image.threshold parameters");
    return { threshold: integer(parameters.threshold, "parameters.threshold", 0, 255) };
  }
  if (operation.id === "image.blur") {
    const parameters = exactKeys(value, ["radius"], "image.blur parameters");
    return { radius: integer(parameters.radius, "parameters.radius", 1, 3) };
  }
  if (operation.id === "image.sharpen") {
    const parameters = exactKeys(value, ["numerator", "denominator"], "image.sharpen parameters");
    return {
      numerator: integer(parameters.numerator, "parameters.numerator", 0, 32),
      denominator: integer(parameters.denominator, "parameters.denominator", 1, 32),
    };
  }
  if (operation.id === "image.convolve") {
    const parameters = exactKeys(
      value,
      ["width", "height", "weights", "divisor", "bias", "alphaMode"],
      "image.convolve parameters",
    );
    const kernel = normalizeConvolutionKernel(parameters);
    if (!["preserve", "convolve-premultiplied"].includes(parameters.alphaMode)) {
      throw new Error("parameters.alphaMode is unsupported");
    }
    return { ...kernel, alphaMode: parameters.alphaMode };
  }
  throw new Error(`unsupported image filter operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image filter operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const values = {
    "image.exposure": "rgb-rational-gain-v1",
    "image.contrast": "rgb-midpoint-rational-v1",
    "image.levels": "rgb-piecewise-linear-v1",
    "image.grayscale": "rec709-q8-grayscale-v1",
    "image.threshold": "rec709-q8-threshold-v1",
    "image.blur": "clamp-box-premultiplied-alpha-v1",
    "image.sharpen": "clamp-cross-rational-sharpen-v1",
    "image.convolve": "clamp-integer-convolution-v1",
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

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const identity = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters,
    inputs,
  });
  parseRgba8Image(await resolveAssetObject(assetRoot, identity.inputs.source));
  return identity;
}

function transformFor(operation, source, parameters) {
  if (operation.id === "image.exposure") return exposureRgba8(source, parameters.numerator, parameters.denominator);
  if (operation.id === "image.contrast") return contrastRgba8(source, parameters.numerator, parameters.denominator);
  if (operation.id === "image.levels") return levelsRgba8(source, parameters);
  if (operation.id === "image.grayscale") return grayscaleRgba8(source);
  if (operation.id === "image.threshold") return thresholdRgba8(source, parameters.threshold);
  if (operation.id === "image.blur") return boxBlurRgba8(source, parameters.radius);
  if (operation.id === "image.sharpen") return sharpenRgba8(source, parameters.numerator, parameters.denominator);
  if (operation.id === "image.convolve") {
    const { alphaMode, ...kernel } = parameters;
    return convolveRgba8(source, kernel, { alphaMode });
  }
  throw new Error(`unsupported image filter operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const sourceBytes = await resolveAssetObject(root, build.inputs.source);
  const source = parseRgba8Image(sourceBytes);
  const output = transformFor(operation, source, build.parameters);
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
      sourceSha256: build.inputs.source.sha256,
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

export function createImageFilterOperationBuildIdentityFactory(operation) {
  return async function createImageFilterOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
    return createBuildIdentity(root, operation, normalizeParameters(operation, parameters), inputs);
  };
}

export function executeImageFilterOperationFactory(operation) {
  const createIdentity = createImageFilterOperationBuildIdentityFactory(operation);
  return async function executeImageFilterOperation(root, invocation = {}) {
    const build = await createIdentity(root, invocation);
    return execute(assertRoot(root), operation, build);
  };
}

export const createImageExposureOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_EXPOSURE_OPERATION);
export const createImageContrastOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_CONTRAST_OPERATION);
export const createImageLevelsOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_LEVELS_OPERATION);
export const createImageGrayscaleOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_GRAYSCALE_OPERATION);
export const createImageThresholdOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_THRESHOLD_OPERATION);
export const createImageBlurOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_BLUR_OPERATION);
export const createImageSharpenOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_SHARPEN_OPERATION);
export const createImageConvolveOperationBuildIdentity = createImageFilterOperationBuildIdentityFactory(IMAGE_CONVOLVE_OPERATION);

export const executeImageExposureOperation = executeImageFilterOperationFactory(IMAGE_EXPOSURE_OPERATION);
export const executeImageContrastOperation = executeImageFilterOperationFactory(IMAGE_CONTRAST_OPERATION);
export const executeImageLevelsOperation = executeImageFilterOperationFactory(IMAGE_LEVELS_OPERATION);
export const executeImageGrayscaleOperation = executeImageFilterOperationFactory(IMAGE_GRAYSCALE_OPERATION);
export const executeImageThresholdOperation = executeImageFilterOperationFactory(IMAGE_THRESHOLD_OPERATION);
export const executeImageBlurOperation = executeImageFilterOperationFactory(IMAGE_BLUR_OPERATION);
export const executeImageSharpenOperation = executeImageFilterOperationFactory(IMAGE_SHARPEN_OPERATION);
export const executeImageConvolveOperation = executeImageFilterOperationFactory(IMAGE_CONVOLVE_OPERATION);
