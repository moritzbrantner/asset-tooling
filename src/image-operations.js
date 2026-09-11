import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  cropRgba8,
  flipRgba8,
  padRgba8,
  resizeRgba8Bilinear,
  resizeRgba8Nearest,
  rotateRgba8QuarterTurns,
} from "./image-geometry.js";
import {
  RGBA8_IMAGE_MEDIA_TYPE,
  encodeRgba8Image,
  parseRgba8Image,
} from "./image-rgba8.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_DIMENSION = 8192;

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
    id: "image.resize",
    version: VERSION,
    label: "Resize RGBA8 image",
    description:
      "Resize a canonical straight-alpha sRGB RGBA8 image with deterministic nearest-center or fixed-rational bilinear sampling.",
    category: "image.geometry",
    inputs: [sourcePort],
    outputs: [{ ...outputPort, label: "Resized image" }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "filter"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        filter: { type: "string", enum: ["nearest", "bilinear"] },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.crop",
    version: VERSION,
    label: "Crop RGBA8 image",
    description: "Extract an in-bounds rectangular region without resampling.",
    category: "image.geometry",
    inputs: [sourcePort],
    outputs: [{ ...outputPort, label: "Cropped image" }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height"],
      properties: {
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.pad",
    version: VERSION,
    label: "Pad RGBA8 image",
    description: "Add deterministic constant-color padding around an image.",
    category: "image.geometry",
    inputs: [sourcePort],
    outputs: [{ ...outputPort, label: "Padded image" }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["left", "right", "top", "bottom", "color"],
      properties: {
        left: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        right: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        top: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        bottom: { type: "integer", minimum: 0, maximum: MAX_DIMENSION },
        color: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "integer", minimum: 0, maximum: 255 },
        },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.rotate",
    version: VERSION,
    label: "Rotate RGBA8 image",
    description: "Rotate an image clockwise by an exact multiple of 90 degrees.",
    category: "image.geometry",
    inputs: [sourcePort],
    outputs: [{ ...outputPort, label: "Rotated image" }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["quarterTurns"],
      properties: { quarterTurns: { type: "integer", minimum: 0, maximum: 3 } },
    },
  },
  {
    schemaVersion: 1,
    id: "image.flip",
    version: VERSION,
    label: "Flip RGBA8 image",
    description: "Flip an image horizontally, vertically, or across both axes.",
    category: "image.geometry",
    inputs: [sourcePort],
    outputs: [{ ...outputPort, label: "Flipped image" }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["axis"],
      properties: { axis: { type: "string", enum: ["horizontal", "vertical", "both"] } },
    },
  },
]);

export const IMAGE_RESIZE_OPERATION = OPERATION_REGISTRY.get("image.resize", VERSION);
export const IMAGE_CROP_OPERATION = OPERATION_REGISTRY.get("image.crop", VERSION);
export const IMAGE_PAD_OPERATION = OPERATION_REGISTRY.get("image.pad", VERSION);
export const IMAGE_ROTATE_OPERATION = OPERATION_REGISTRY.get("image.rotate", VERSION);
export const IMAGE_FLIP_OPERATION = OPERATION_REGISTRY.get("image.flip", VERSION);
export const IMAGE_OPERATIONS = OPERATION_REGISTRY.list();

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

function exactKeys(value, required, location) {
  const object = plainObject(value, location);
  const keys = new Set(required);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function integer(value, location, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function dimension(value, location) {
  return integer(value, location, 1, MAX_DIMENSION);
}

function channel(value, location) {
  return integer(value, location, 0, 255);
}

function normalizeResizeParameters(value) {
  const parameters = exactKeys(value, ["width", "height", "filter"], "image.resize parameters");
  if (!["nearest", "bilinear"].includes(parameters.filter)) {
    throw new Error("image.resize@1 filter must be 'nearest' or 'bilinear'");
  }
  return {
    width: dimension(parameters.width, "parameters.width"),
    height: dimension(parameters.height, "parameters.height"),
    filter: parameters.filter,
  };
}

function normalizeCropParameters(value) {
  const parameters = exactKeys(value, ["x", "y", "width", "height"], "image.crop parameters");
  return {
    x: integer(parameters.x, "parameters.x", 0, MAX_DIMENSION - 1),
    y: integer(parameters.y, "parameters.y", 0, MAX_DIMENSION - 1),
    width: dimension(parameters.width, "parameters.width"),
    height: dimension(parameters.height, "parameters.height"),
  };
}

function normalizePadParameters(value) {
  const parameters = exactKeys(
    value,
    ["left", "right", "top", "bottom", "color"],
    "image.pad parameters",
  );
  if (!Array.isArray(parameters.color) || parameters.color.length !== 4) {
    throw new Error("parameters.color must contain exactly four RGBA8 channels");
  }
  return {
    left: integer(parameters.left, "parameters.left", 0, MAX_DIMENSION),
    right: integer(parameters.right, "parameters.right", 0, MAX_DIMENSION),
    top: integer(parameters.top, "parameters.top", 0, MAX_DIMENSION),
    bottom: integer(parameters.bottom, "parameters.bottom", 0, MAX_DIMENSION),
    color: parameters.color.map((value_, index) => channel(value_, `parameters.color[${index}]`)),
  };
}

function normalizeRotateParameters(value) {
  const parameters = exactKeys(value, ["quarterTurns"], "image.rotate parameters");
  return { quarterTurns: integer(parameters.quarterTurns, "parameters.quarterTurns", 0, 3) };
}

function normalizeFlipParameters(value) {
  const parameters = exactKeys(value, ["axis"], "image.flip parameters");
  if (!["horizontal", "vertical", "both"].includes(parameters.axis)) {
    throw new Error("parameters.axis must be 'horizontal', 'vertical', or 'both'");
  }
  return { axis: parameters.axis };
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image operation root must be an absolute path");
  }
  return root;
}

function algorithmFor(operation, parameters) {
  if (operation.id === "image.resize") {
    return parameters.filter === "nearest"
      ? "nearest-center-integer-v1"
      : "bilinear-center-fixed-rational-v1";
  }
  if (operation.id === "image.crop") return "rectangular-row-copy-v1";
  if (operation.id === "image.pad") return "constant-fill-copy-v1";
  if (operation.id === "image.rotate") return "quarter-turn-copy-v1";
  if (operation.id === "image.flip") return "axis-flip-copy-v1";
  throw new Error(`unsupported image operation '${operation.id}'`);
}

async function implementationIdentity(operation, parameters) {
  return {
    id: `builtin.image.rgba8.${operation.id.slice("image.".length)}`,
    version: VERSION,
    algorithm: algorithmFor(operation, parameters),
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
    implementation: await implementationIdentity(operation, parameters),
    parameters,
    inputs,
  });
  const sourceBytes = await resolveAssetObject(assetRoot, identity.inputs.source);
  parseRgba8Image(sourceBytes);
  return identity;
}

async function executeUnaryImageOperation(root, operation, buildIdentity, transform) {
  const assetRoot = assertRoot(root);
  const sourceBytes = await resolveAssetObject(assetRoot, buildIdentity.inputs.source);
  const source = parseRgba8Image(sourceBytes);
  const output = transform(source, buildIdentity.parameters);
  const outputBytes = encodeRgba8Image(output);
  const stored = await storeAssetObject(assetRoot, {
    bytes: outputBytes,
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: output.width,
      height: output.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      sourceSha256: buildIdentity.inputs.source.sha256,
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      sourceWidth: source.width,
      sourceHeight: source.height,
      resultWidth: output.width,
      resultHeight: output.height,
      algorithm: buildIdentity.implementation.algorithm,
      parameters: buildIdentity.parameters,
    },
  });
}

export { resizeRgba8Nearest, resizeRgba8Bilinear, cropRgba8, padRgba8, rotateRgba8QuarterTurns, flipRgba8 };

export async function createImageResizeOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
  return createBuildIdentity(root, IMAGE_RESIZE_OPERATION, normalizeResizeParameters(parameters), inputs);
}

export async function executeImageResizeOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createImageResizeOperationBuildIdentity(root, { parameters, inputs });
  const transform = build.parameters.filter === "nearest" ? resizeRgba8Nearest : resizeRgba8Bilinear;
  return executeUnaryImageOperation(root, IMAGE_RESIZE_OPERATION, build, (source) =>
    transform(source, build.parameters.width, build.parameters.height),
  );
}

export async function createImageCropOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
  return createBuildIdentity(root, IMAGE_CROP_OPERATION, normalizeCropParameters(parameters), inputs);
}

export async function executeImageCropOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createImageCropOperationBuildIdentity(root, { parameters, inputs });
  return executeUnaryImageOperation(root, IMAGE_CROP_OPERATION, build, (source) =>
    cropRgba8(source, build.parameters),
  );
}

export async function createImagePadOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
  return createBuildIdentity(root, IMAGE_PAD_OPERATION, normalizePadParameters(parameters), inputs);
}

export async function executeImagePadOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createImagePadOperationBuildIdentity(root, { parameters, inputs });
  return executeUnaryImageOperation(root, IMAGE_PAD_OPERATION, build, (source) =>
    padRgba8(source, build.parameters),
  );
}

export async function createImageRotateOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
  return createBuildIdentity(root, IMAGE_ROTATE_OPERATION, normalizeRotateParameters(parameters), inputs);
}

export async function executeImageRotateOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createImageRotateOperationBuildIdentity(root, { parameters, inputs });
  return executeUnaryImageOperation(root, IMAGE_ROTATE_OPERATION, build, (source) =>
    rotateRgba8QuarterTurns(source, build.parameters.quarterTurns),
  );
}

export async function createImageFlipOperationBuildIdentity(root, { parameters = {}, inputs = {} } = {}) {
  return createBuildIdentity(root, IMAGE_FLIP_OPERATION, normalizeFlipParameters(parameters), inputs);
}

export async function executeImageFlipOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createImageFlipOperationBuildIdentity(root, { parameters, inputs });
  return executeUnaryImageOperation(root, IMAGE_FLIP_OPERATION, build, (source) =>
    flipRgba8(source, build.parameters.axis),
  );
}
