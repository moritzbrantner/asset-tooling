import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { linearToSrgbRgba8, srgbToLinearRgba8 } from "./image-colorspace.js";
import {
  LINEAR_RGBA8_IMAGE_MEDIA_TYPE,
  encodeLinearRgba8Image,
  parseLinearRgba8Image,
} from "./image-linear-rgba8.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "./image-rgba8.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.colorspace.srgb-to-linear",
    version: VERSION,
    label: "Convert sRGB image to linear sRGB",
    description:
      "Convert canonical sRGB RGBA8 RGB code values through a checked-in IEC 61966-2-1 transfer lookup table while preserving alpha.",
    category: "image.color",
    inputs: [
      {
        id: "source",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        assetKinds: ["image"],
        mediaTypes: [LINEAR_RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "image.colorspace.linear-to-srgb",
    version: VERSION,
    label: "Convert linear sRGB image to sRGB",
    description:
      "Convert canonical linear-sRGB RGBA8 RGB code values through a checked-in IEC 61966-2-1 transfer lookup table while preserving alpha.",
    category: "image.color",
    inputs: [
      {
        id: "source",
        assetKinds: ["image"],
        mediaTypes: [LINEAR_RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
]);

export const IMAGE_SRGB_TO_LINEAR_OPERATION = OPERATION_REGISTRY.get(
  "image.colorspace.srgb-to-linear",
  VERSION,
);
export const IMAGE_LINEAR_TO_SRGB_OPERATION = OPERATION_REGISTRY.get(
  "image.colorspace.linear-to-srgb",
  VERSION,
);
export const IMAGE_COLORSPACE_OPERATIONS = OPERATION_REGISTRY.list();

function assertEmptyParameters(value, operationId) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operationId} parameters must be a plain object`);
  }
  if (Object.keys(value).length !== 0) {
    throw new Error(`${operationId} parameters must be empty`);
  }
  return {};
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image colorspace operation root must be an absolute path");
  }
  return root;
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.image.rgba8.${operation.id.slice("image.colorspace.".length)}`,
    version: VERSION,
    algorithm: "iec61966-2-1-byte-lut-v1",
    alphaMode: "straight-preserved",
    tableDomain: "8bit-code-value",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters,
    inputs,
  });
  const bytes = await resolveAssetObject(assetRoot, build.inputs.source);
  if (operation.id === "image.colorspace.srgb-to-linear") parseRgba8Image(bytes);
  else parseLinearRgba8Image(bytes);
  return build;
}

async function execute(root, operation, build) {
  const sourceBytes = await resolveAssetObject(root, build.inputs.source);
  let output;
  let outputBytes;
  let colorSpace;
  let mediaType;

  if (operation.id === "image.colorspace.srgb-to-linear") {
    const source = parseRgba8Image(sourceBytes);
    output = srgbToLinearRgba8(source);
    outputBytes = encodeLinearRgba8Image(output);
    colorSpace = "linear-srgb";
    mediaType = LINEAR_RGBA8_IMAGE_MEDIA_TYPE;
  } else {
    const source = parseLinearRgba8Image(sourceBytes);
    output = linearToSrgbRgba8(source);
    outputBytes = encodeRgba8Image(output);
    colorSpace = "srgb";
    mediaType = RGBA8_IMAGE_MEDIA_TYPE;
  }

  const stored = await storeAssetObject(root, {
    bytes: outputBytes,
    kind: "image",
    mediaType,
    metadata: {
      width: output.width,
      height: output.height,
      pixelFormat: "rgba8",
      colorSpace,
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
      sourceColorSpace:
        operation.id === "image.colorspace.srgb-to-linear" ? "srgb" : "linear-srgb",
      resultColorSpace: colorSpace,
    },
  });
}

export async function createImageSrgbToLinearOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(
    root,
    IMAGE_SRGB_TO_LINEAR_OPERATION,
    assertEmptyParameters(parameters, IMAGE_SRGB_TO_LINEAR_OPERATION.id),
    inputs,
  );
}

export async function executeImageSrgbToLinearOperation(root, invocation = {}) {
  const build = await createImageSrgbToLinearOperationBuildIdentity(root, invocation);
  return execute(assertRoot(root), IMAGE_SRGB_TO_LINEAR_OPERATION, build);
}

export async function createImageLinearToSrgbOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(
    root,
    IMAGE_LINEAR_TO_SRGB_OPERATION,
    assertEmptyParameters(parameters, IMAGE_LINEAR_TO_SRGB_OPERATION.id),
    inputs,
  );
}

export async function executeImageLinearToSrgbOperation(root, invocation = {}) {
  const build = await createImageLinearToSrgbOperationBuildIdentity(root, invocation);
  return execute(assertRoot(root), IMAGE_LINEAR_TO_SRGB_OPERATION, build);
}
