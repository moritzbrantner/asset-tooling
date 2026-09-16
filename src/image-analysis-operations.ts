import path from "node:path";
import { resolveAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { histogramRgba8, inspectRgba8Image } from "./image-analysis.js";
import { RGBA8_IMAGE_MEDIA_TYPE, parseRgba8Image } from "./image-rgba8.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const sourcePort = {
  id: "source",
  label: "Source image",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.metadata.inspect",
    version: VERSION,
    label: "Inspect image metadata",
    description:
      "Measure canonical image dimensions, pixel count, and alpha coverage classes without emitting a new asset.",
    category: "image.analysis",
    inputs: [sourcePort],
    outputs: [],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "image.histogram",
    version: VERSION,
    label: "Measure image histogram",
    description:
      "Measure exact 256-bin red, green, blue, alpha, and Q8 Rec.709 luma histograms without emitting a new asset.",
    category: "image.analysis",
    inputs: [sourcePort],
    outputs: [],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
]);

export const IMAGE_METADATA_INSPECT_OPERATION = OPERATION_REGISTRY.get(
  "image.metadata.inspect",
  VERSION,
);
export const IMAGE_HISTOGRAM_OPERATION = OPERATION_REGISTRY.get("image.histogram", VERSION);
export const IMAGE_ANALYSIS_OPERATIONS = OPERATION_REGISTRY.list();

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image analysis operation root must be an absolute path");
  }
  return root;
}

function emptyParameters(value, operationId) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operationId} parameters must be a plain object`);
  }
  if (Object.keys(value).length !== 0) {
    throw new Error(`${operationId} parameters must be empty`);
  }
  return {};
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.image.rgba8.${operation.id.slice("image.".length)}`,
    version: VERSION,
    algorithm:
      operation.id === "image.metadata.inspect"
        ? "rgba8-structural-metadata-v1"
        : "rgba8-256bin-q8-luma-histogram-v1",
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
  parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
  return build;
}

async function execute(root, operation, build) {
  const source = parseRgba8Image(await resolveAssetObject(root, build.inputs.source));
  const observations =
    operation.id === "image.metadata.inspect"
      ? {
          ...inspectRgba8Image(source),
          sourceByteLength: build.inputs.source.byteLength,
          sourceSha256: build.inputs.source.sha256,
          algorithm: build.implementation.algorithm,
        }
      : {
          ...histogramRgba8(source),
          sourceSha256: build.inputs.source.sha256,
          algorithm: build.implementation.algorithm,
        };
  return normalizeAssetOperationResult(operation, { outputs: {}, observations });
}

export async function createImageMetadataInspectOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(
    root,
    IMAGE_METADATA_INSPECT_OPERATION,
    emptyParameters(parameters, IMAGE_METADATA_INSPECT_OPERATION.id),
    inputs,
  );
}

export async function executeImageMetadataInspectOperation(root, invocation = {}) {
  const build = await createImageMetadataInspectOperationBuildIdentity(root, invocation);
  return execute(assertRoot(root), IMAGE_METADATA_INSPECT_OPERATION, build);
}

export async function createImageHistogramOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(
    root,
    IMAGE_HISTOGRAM_OPERATION,
    emptyParameters(parameters, IMAGE_HISTOGRAM_OPERATION.id),
    inputs,
  );
}

export async function executeImageHistogramOperation(root, invocation = {}) {
  const build = await createImageHistogramOperationBuildIdentity(root, invocation);
  return execute(assertRoot(root), IMAGE_HISTOGRAM_OPERATION, build);
}
