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

function normalizeParameters(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image background parameters must be a plain object");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "backgroundFloor") ||
    !Object.hasOwn(value, "transparentAbove")
  ) {
    throw new Error(
      "image background parameters must contain only backgroundFloor and transparentAbove",
    );
  }
  const { backgroundFloor, transparentAbove } = value;
  if (
    !Number.isSafeInteger(backgroundFloor) ||
    backgroundFloor < 0 ||
    backgroundFloor > 254
  ) {
    throw new Error("parameters.backgroundFloor must be an integer in 0..254");
  }
  if (
    !Number.isSafeInteger(transparentAbove) ||
    transparentAbove < 1 ||
    transparentAbove > 255
  ) {
    throw new Error("parameters.transparentAbove must be an integer in 1..255");
  }
  if (backgroundFloor >= transparentAbove) {
    throw new Error("parameters.backgroundFloor must be less than parameters.transparentAbove");
  }
  return { backgroundFloor, transparentAbove };
}

function minimumRgb(pixels, pixelIndex) {
  const offset = pixelIndex * 4;
  return Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
}

export function borderWhiteToAlphaRgba8(source, parameters) {
  const normalized = normalizeParameters(parameters);
  const { width, height, pixels } = source;
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const enqueue = (pixelIndex) => {
    if (visited[pixelIndex]) return;
    if (minimumRgb(pixels, pixelIndex) < normalized.backgroundFloor) return;
    visited[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    if (height > 1) enqueue((height - 1) * width + x);
  }
  for (let y = 1; y + 1 < height; y += 1) {
    enqueue(y * width);
    if (width > 1) enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }

  const output = new Uint8Array(pixels);
  const featherRange = normalized.transparentAbove - normalized.backgroundFloor;
  let transparentPixelCount = 0;
  let featheredPixelCount = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (!visited[pixelIndex]) continue;
    const brightness = minimumRgb(pixels, pixelIndex);
    let mask;
    if (brightness >= normalized.transparentAbove) {
      mask = 0;
      transparentPixelCount += 1;
    } else if (brightness <= normalized.backgroundFloor) {
      mask = 255;
    } else {
      const numerator = (normalized.transparentAbove - brightness) * 255;
      mask = Math.floor((numerator + Math.floor(featherRange / 2)) / featherRange);
      featheredPixelCount += 1;
    }
    const alphaOffset = pixelIndex * 4 + 3;
    output[alphaOffset] = Math.floor((pixels[alphaOffset] * mask + 127) / 255);
  }

  return {
    image: {
      width,
      height,
      pixels: output,
    },
    observations: {
      connectedBackgroundPixelCount: tail,
      transparentPixelCount,
      featheredPixelCount,
    },
  };
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
    parameters: normalizeParameters(parameters),
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
