import path from "node:path";
import {
  borderWhiteToAlphaRgba8,
  normalizeBorderWhiteAlphaParameters,
} from "./image-border-white-alpha-core.js";
export { borderWhiteToAlphaRgba8 } from "./image-border-white-alpha-core.js";
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

const VERSION = "1";
const OPERATION_ID = "image.background.border-white-alpha";

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: VERSION,
    label: "Remove border-connected white background",
    description:
      "Turn a bright border-connected background into deterministic feathered alpha without removing enclosed bright details.",
    category: "image.alpha",
    inputs: [
      {
        id: "source",
        label: "Source RGBA8 image",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Prepared RGBA8 image",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["backgroundFloor", "transparentAbove"],
      properties: {
        backgroundFloor: { type: "integer", minimum: 0, maximum: 254 },
        transparentAbove: { type: "integer", minimum: 1, maximum: 255 },
      },
    },
  },
]);

export const IMAGE_BORDER_WHITE_ALPHA_OPERATION = OPERATION_REGISTRY.get(
  OPERATION_ID,
  VERSION,
);

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image background operation root must be an absolute path");
  }
  return root;
}

async function implementationIdentity() {
  return {
    id: "builtin.image.rgba8.background.border-white-alpha",
    version: VERSION,
    algorithm: "border-connected-min-rgb-feather-v1",
    connectivity: "4-neighbor",
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    tool: await captureToolIdentity(),
  };
}

export async function createImageBorderWhiteAlphaOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation: IMAGE_BORDER_WHITE_ALPHA_OPERATION,
    implementation: await implementationIdentity(),
    parameters: normalizeBorderWhiteAlphaParameters(parameters),
    inputs,
  });
  parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
  return build;
}

export async function executeImageBorderWhiteAlphaOperation(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  const assetRoot = assertRoot(root);
  const build = await createImageBorderWhiteAlphaOperationBuildIdentity(assetRoot, {
    parameters,
    inputs,
  });
  const source = parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
  const transformed = borderWhiteToAlphaRgba8(source, build.parameters);
  const stored = await storeAssetObject(assetRoot, {
    bytes: encodeRgba8Image(transformed.image),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: transformed.image.width,
      height: transformed.image.height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      sourceSha256: build.inputs.source.sha256,
      backgroundFloor: build.parameters.backgroundFloor,
      transparentAbove: build.parameters.transparentAbove,
    },
  });

  return normalizeAssetOperationResult(IMAGE_BORDER_WHITE_ALPHA_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      ...transformed.observations,
      algorithm: build.implementation.algorithm,
      parameters: build.parameters,
    },
  });
}
