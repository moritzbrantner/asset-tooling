import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { combineRgba8Channels, extractRgba8Channel } from "./image-channels.js";
import { RGBA8_IMAGE_MEDIA_TYPE, encodeRgba8Image, parseRgba8Image } from "./image-rgba8.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const rgba8Port = (id, label) => ({
  id,
  label,
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
});

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.channel.extract",
    version: VERSION,
    label: "Extract image channel",
    description:
      "Extract red, green, blue, alpha, or deterministic Q8 Rec.709 luma into an opaque grayscale RGBA8 image.",
    category: "image.channel",
    inputs: [rgba8Port("source", "Source image")],
    outputs: [rgba8Port("output", "Channel image")],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: {
        channel: { type: "string", enum: ["red", "green", "blue", "alpha", "luma"] },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "image.channels.combine",
    version: VERSION,
    label: "Combine image channels",
    description:
      "Combine the luma values of four equal-size channel images into red, green, blue, and alpha channels.",
    category: "image.channel",
    inputs: [
      rgba8Port("red", "Red channel image"),
      rgba8Port("green", "Green channel image"),
      rgba8Port("blue", "Blue channel image"),
      rgba8Port("alpha", "Alpha channel image"),
    ],
    outputs: [rgba8Port("output", "Combined image")],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
]);

export const IMAGE_CHANNEL_EXTRACT_OPERATION = OPERATION_REGISTRY.get(
  "image.channel.extract",
  VERSION,
);
export const IMAGE_CHANNELS_COMBINE_OPERATION = OPERATION_REGISTRY.get(
  "image.channels.combine",
  VERSION,
);
export const IMAGE_CHANNEL_OPERATIONS = OPERATION_REGISTRY.list();

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image channel operation root must be an absolute path");
  }
  return root;
}

function normalizeParameters(operation, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation.id} parameters must be a plain object`);
  }
  if (operation.id === "image.channel.extract") {
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "channel")) {
      throw new Error("image.channel.extract parameters must contain exactly 'channel'");
    }
    if (!["red", "green", "blue", "alpha", "luma"].includes(value.channel)) {
      throw new Error("parameters.channel is unsupported");
    }
    return { channel: value.channel };
  }
  if (Object.keys(value).length !== 0) {
    throw new Error("image.channels.combine parameters must be empty");
  }
  return {};
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.image.rgba8.${operation.id.slice("image.".length)}`,
    version: VERSION,
    algorithm:
      operation.id === "image.channel.extract"
        ? "opaque-grayscale-channel-extract-v1"
        : "luma-channel-combine-v1",
    tool: await captureToolIdentity(),
  };
}

async function parsedInput(root, asset) {
  return parseRgba8Image(await resolveAssetObject(root, asset));
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters,
    inputs,
  });
  if (operation.id === "image.channel.extract") {
    await parsedInput(assetRoot, build.inputs.source);
  } else {
    const images = await Promise.all(
      ["red", "green", "blue", "alpha"].map((id) => parsedInput(assetRoot, build.inputs[id])),
    );
    const [first, ...rest] = images;
    if (rest.some((image) => image.width !== first.width || image.height !== first.height)) {
      throw new Error("channel source dimensions must exactly match");
    }
  }
  return build;
}

async function storeOutput(root, operation, build, output) {
  const inputLineage = Object.entries(build.inputs).map(([port, asset]) => ({
    port,
    sha256: asset.sha256,
  }));
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

export async function createImageChannelExtractOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(
    root,
    IMAGE_CHANNEL_EXTRACT_OPERATION,
    normalizeParameters(IMAGE_CHANNEL_EXTRACT_OPERATION, parameters),
    inputs,
  );
}

export async function executeImageChannelExtractOperation(root, invocation = {}) {
  const build = await createImageChannelExtractOperationBuildIdentity(root, invocation);
  const source = await parsedInput(root, build.inputs.source);
  const output = extractRgba8Channel(source, build.parameters.channel);
  return storeOutput(assertRoot(root), IMAGE_CHANNEL_EXTRACT_OPERATION, build, output);
}

export async function createImageChannelsCombineOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(
    root,
    IMAGE_CHANNELS_COMBINE_OPERATION,
    normalizeParameters(IMAGE_CHANNELS_COMBINE_OPERATION, parameters),
    inputs,
  );
}

export async function executeImageChannelsCombineOperation(root, invocation = {}) {
  const build = await createImageChannelsCombineOperationBuildIdentity(root, invocation);
  const images = Object.fromEntries(
    await Promise.all(
      ["red", "green", "blue", "alpha"].map(async (id) => [
        id,
        await parsedInput(root, build.inputs[id]),
      ]),
    ),
  );
  const output = combineRgba8Channels(images);
  return storeOutput(assertRoot(root), IMAGE_CHANNELS_COMBINE_OPERATION, build, output);
}
