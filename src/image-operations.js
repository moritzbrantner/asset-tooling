import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  RGBA8_IMAGE_MEDIA_TYPE,
  encodeRgba8Image,
  parseRgba8Image,
} from "./image-rgba8.js";
import { captureToolIdentity } from "./tool.js";

const RESIZE_OPERATION_ID = "image.resize";
const RESIZE_OPERATION_VERSION = "1";
const RESIZE_IMPLEMENTATION_ID = "builtin.image.rgba8.resize";
const RESIZE_IMPLEMENTATION_VERSION = "1";
const RESIZE_ALGORITHM = "nearest-center-integer-v1";
const MAX_DIMENSION = 8192;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: RESIZE_OPERATION_ID,
    version: RESIZE_OPERATION_VERSION,
    label: "Resize RGBA8 image",
    description:
      "Resize a canonical straight-alpha sRGB RGBA8 image through an exact integer nearest-center mapping.",
    category: "image.processing",
    inputs: [
      {
        id: "source",
        label: "Source image",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Resized image",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "filter"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        filter: { type: "string", enum: ["nearest"] },
      },
    },
  },
]);

export const IMAGE_RESIZE_OPERATION = OPERATION_REGISTRY.get(
  RESIZE_OPERATION_ID,
  RESIZE_OPERATION_VERSION,
);

function positiveDimension(value, location) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error(`${location} must be an integer in 1..${MAX_DIMENSION}`);
  }
  return value;
}

function normalizeResizeParameters(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image.resize parameters must be a plain object");
  }
  const allowed = new Set(["width", "height", "filter"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`image.resize parameters contain unknown field '${key}'`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`image.resize parameters are missing '${key}'`);
  }
  if (value.filter !== "nearest") {
    throw new Error("image.resize@1 filter must be 'nearest'");
  }
  return {
    width: positiveDimension(value.width, "parameters.width"),
    height: positiveDimension(value.height, "parameters.height"),
    filter: "nearest",
  };
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image.resize root must be an absolute path");
  }
  return root;
}

async function implementationIdentity() {
  return {
    id: RESIZE_IMPLEMENTATION_ID,
    version: RESIZE_IMPLEMENTATION_VERSION,
    algorithm: RESIZE_ALGORITHM,
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    tool: await captureToolIdentity(),
  };
}

function sourceIndex(destinationIndex, sourceLength, destinationLength) {
  return Math.min(
    sourceLength - 1,
    Math.floor(((2 * destinationIndex + 1) * sourceLength) / (2 * destinationLength)),
  );
}

export function resizeRgba8Nearest(source, width, height) {
  const targetWidth = positiveDimension(width, "target width");
  const targetHeight = positiveDimension(height, "target height");
  const output = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = sourceIndex(targetY, source.width, targetHeight);
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = sourceIndex(targetX, source.width, targetWidth);
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      output[targetOffset] = source.pixels[sourceOffset];
      output[targetOffset + 1] = source.pixels[sourceOffset + 1];
      output[targetOffset + 2] = source.pixels[sourceOffset + 2];
      output[targetOffset + 3] = source.pixels[sourceOffset + 3];
    }
  }

  return {
    width: targetWidth,
    height: targetHeight,
    pixels: output,
  };
}

export async function createImageResizeOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  const assetRoot = assertRoot(root);
  const normalizedParameters = normalizeResizeParameters(parameters);
  const identity = createAssetOperationBuildIdentity({
    operation: IMAGE_RESIZE_OPERATION,
    implementation: await implementationIdentity(),
    parameters: normalizedParameters,
    inputs,
  });
  const sourceBytes = await resolveAssetObject(assetRoot, identity.inputs.source);
  parseRgba8Image(sourceBytes);
  return identity;
}

export async function executeImageResizeOperation(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  const assetRoot = assertRoot(root);
  const buildIdentity = await createImageResizeOperationBuildIdentity(assetRoot, {
    parameters,
    inputs,
  });
  const sourceBytes = await resolveAssetObject(assetRoot, buildIdentity.inputs.source);
  const source = parseRgba8Image(sourceBytes);
  const resized = resizeRgba8Nearest(
    source,
    buildIdentity.parameters.width,
    buildIdentity.parameters.height,
  );
  const outputBytes = encodeRgba8Image(resized);
  const stored = await storeAssetObject(assetRoot, {
    bytes: outputBytes,
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: resized.width,
      height: resized.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      sourceSha256: buildIdentity.inputs.source.sha256,
    },
  });

  return normalizeAssetOperationResult(IMAGE_RESIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      sourceWidth: source.width,
      sourceHeight: source.height,
      resultWidth: resized.width,
      resultHeight: resized.height,
      filter: "nearest",
      algorithm: RESIZE_ALGORITHM,
      sourcePixelCount: source.width * source.height,
      resultPixelCount: resized.width * resized.height,
    },
  });
}
