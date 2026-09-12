import { canonicalJson } from "./canonical.js";
import { sha256Text } from "./hash.js";
import { createAssetOperationCacheKey } from "./operations.js";
import {
  createImageCropOperationBuildIdentity,
  createImageFlipOperationBuildIdentity,
  createImagePadOperationBuildIdentity,
  createImageResizeOperationBuildIdentity,
  createImageRotateOperationBuildIdentity,
  executeImageCropOperation,
  executeImageFlipOperation,
  executeImagePadOperation,
  executeImageResizeOperation,
  executeImageRotateOperation,
} from "./image-operations.js";
import {
  createImageBlurOperationBuildIdentity,
  createImageContrastOperationBuildIdentity,
  createImageExposureOperationBuildIdentity,
  createImageGrayscaleOperationBuildIdentity,
  createImageSharpenOperationBuildIdentity,
  executeImageBlurOperation,
  executeImageContrastOperation,
  executeImageExposureOperation,
  executeImageGrayscaleOperation,
  executeImageSharpenOperation,
} from "./image-filter-operations.js";

const VERSION = 1;

const HANDLERS = new Map([
  [
    "image.resize",
    { version: "1", createBuild: createImageResizeOperationBuildIdentity, execute: executeImageResizeOperation },
  ],
  [
    "image.crop",
    { version: "1", createBuild: createImageCropOperationBuildIdentity, execute: executeImageCropOperation },
  ],
  [
    "image.pad",
    { version: "1", createBuild: createImagePadOperationBuildIdentity, execute: executeImagePadOperation },
  ],
  [
    "image.rotate",
    { version: "1", createBuild: createImageRotateOperationBuildIdentity, execute: executeImageRotateOperation },
  ],
  [
    "image.flip",
    { version: "1", createBuild: createImageFlipOperationBuildIdentity, execute: executeImageFlipOperation },
  ],
  [
    "image.exposure",
    { version: "1", createBuild: createImageExposureOperationBuildIdentity, execute: executeImageExposureOperation },
  ],
  [
    "image.contrast",
    { version: "1", createBuild: createImageContrastOperationBuildIdentity, execute: executeImageContrastOperation },
  ],
  [
    "image.grayscale",
    { version: "1", createBuild: createImageGrayscaleOperationBuildIdentity, execute: executeImageGrayscaleOperation },
  ],
  [
    "image.blur",
    { version: "1", createBuild: createImageBlurOperationBuildIdentity, execute: executeImageBlurOperation },
  ],
  [
    "image.sharpen",
    { version: "1", createBuild: createImageSharpenOperationBuildIdentity, execute: executeImageSharpenOperation },
  ],
]);

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function canonicalClone(value, location) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new Error(`${location} must contain canonical JSON data: ${error.message}`);
  }
}

export function normalizeImagePerturbationRecipe(value) {
  const recipe = plainObject(value, "image perturbation recipe");
  const allowed = new Set(["schemaVersion", "steps"]);
  for (const key of Object.keys(recipe)) {
    if (!allowed.has(key)) throw new Error(`image perturbation recipe contains unknown field '${key}'`);
  }
  if ((recipe.schemaVersion ?? VERSION) !== VERSION) {
    throw new Error(`image perturbation recipe schemaVersion must be ${VERSION}`);
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new Error("image perturbation recipe steps must be a non-empty array");
  }
  if (recipe.steps.length > 16) {
    throw new Error("image perturbation recipe supports at most 16 steps");
  }

  const steps = recipe.steps.map((value_, index) => {
    const step = plainObject(value_, `image perturbation recipe steps[${index}]`);
    const stepKeys = new Set(["operation", "parameters"]);
    for (const key of Object.keys(step)) {
      if (!stepKeys.has(key)) {
        throw new Error(`image perturbation recipe steps[${index}] contains unknown field '${key}'`);
      }
    }
    if (typeof step.operation !== "string" || !HANDLERS.has(step.operation)) {
      throw new Error(`image perturbation recipe steps[${index}] has unsupported operation '${step.operation}'`);
    }
    const parameters = canonicalClone(step.parameters ?? {}, `image perturbation recipe steps[${index}].parameters`);
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      throw new Error(`image perturbation recipe steps[${index}].parameters must be an object`);
    }
    return { operation: step.operation, parameters };
  });

  return { schemaVersion: VERSION, steps };
}

export function imagePerturbationRecipeSha256(value) {
  return sha256Text(canonicalJson(normalizeImagePerturbationRecipe(value)));
}

export async function executeImagePerturbationRecipe(root, { source, recipe }) {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error("image perturbation source must be an AssetRef");
  }
  const normalized = normalizeImagePerturbationRecipe(recipe);
  const recipeSha256 = imagePerturbationRecipeSha256(normalized);
  let current = source;
  const lineage = [];

  for (const step of normalized.steps) {
    const handler = HANDLERS.get(step.operation);
    const invocation = { parameters: step.parameters, inputs: { source: current } };
    const build = await handler.createBuild(root, invocation);
    const result = await handler.execute(root, invocation);
    const output = result.outputs.output;
    lineage.push({
      operation: { id: step.operation, version: handler.version },
      parameters: build.parameters,
      implementation: build.implementation,
      cacheKey: createAssetOperationCacheKey(build),
      input: current,
      output,
      observations: result.observations,
    });
    current = output;
  }

  return {
    schemaVersion: VERSION,
    recipeSha256,
    source,
    output: current,
    steps: lineage,
  };
}
