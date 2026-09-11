import {
  assetObjectPortablePath,
  resolveAssetObject,
  storeAssetObject,
} from "./asset-store.js";
import { normalizeGenerationResult } from "./backend-contract.js";
import { getBackend } from "./backends.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const PROCEDURAL_GENERATOR_ID = "builtin.procedural.svg-scatter";
const PROCEDURAL_GENERATOR_VERSION = "1";
const PROCEDURAL_OPERATION_ID = "procedural.svg.scatter";
const PROCEDURAL_OPERATION_VERSION = "1";
const PROCEDURAL_PARAMETER_KEYS = new Set([
  "seed",
  "width",
  "height",
  "count",
  "minRadius",
  "maxRadius",
  "background",
  "palette",
]);
const STABLE_DIFFUSION_GENERATOR_ID = "model.stable-diffusion.diffusers";
const STABLE_DIFFUSION_GENERATOR_VERSION = "1";
const STABLE_DIFFUSION_OPERATION_ID = "image.stable-diffusion.generate";
const STABLE_DIFFUSION_OPERATION_VERSION = "1";
const STABLE_DIFFUSION_PARAMETER_KEYS = new Set([
  "pipelineId",
  "seed",
  "prompt",
  "negativePrompt",
  "width",
  "height",
  "steps",
  "guidanceScale",
  "scheduler",
  "dtype",
  "device",
  "deterministicAlgorithms",
]);
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: PROCEDURAL_OPERATION_ID,
    version: PROCEDURAL_OPERATION_VERSION,
    label: "SVG scatter",
    description: "Generate a seeded SVG containing deterministically scattered circles.",
    category: "procedural.vector",
    inputs: [],
    outputs: [
      {
        id: "output",
        label: "SVG",
        assetKinds: ["vector-image"],
        mediaTypes: ["image/svg+xml"],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "seed",
        "width",
        "height",
        "count",
        "minRadius",
        "maxRadius",
        "background",
        "palette",
      ],
      properties: {
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        width: { type: "integer", minimum: 1, maximum: 4096 },
        height: { type: "integer", minimum: 1, maximum: 4096 },
        count: { type: "integer", minimum: 1, maximum: 10000 },
        minRadius: { type: "integer", minimum: 1, maximum: 2048 },
        maxRadius: { type: "integer", minimum: 1, maximum: 2048 },
        background: { type: "string", pattern: "^#[0-9a-f]{6}$" },
        palette: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { type: "string", pattern: "^#[0-9a-f]{6}$" },
        },
      },
    },
  },
  {
    schemaVersion: 1,
    id: STABLE_DIFFUSION_OPERATION_ID,
    version: STABLE_DIFFUSION_OPERATION_VERSION,
    label: "Stable Diffusion image",
    description:
      "Generate a PNG through the existing offline Stable Diffusion Diffusers backend and a content-addressed pipeline bundle.",
    category: "model.image",
    inputs: [
      {
        id: "model",
        label: "Pipeline bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "PNG",
        assetKinds: ["image"],
        mediaTypes: ["image/png"],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "pipelineId",
        "seed",
        "prompt",
        "negativePrompt",
        "width",
        "height",
        "steps",
        "guidanceScale",
        "scheduler",
        "dtype",
        "device",
        "deterministicAlgorithms",
      ],
      properties: {
        pipelineId: { type: "string", minLength: 1 },
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        prompt: { type: "string", minLength: 1 },
        negativePrompt: { type: "string" },
        width: { type: "integer", minimum: 64, maximum: 2048 },
        height: { type: "integer", minimum: 64, maximum: 2048 },
        steps: { type: "integer", minimum: 1, maximum: 200 },
        guidanceScale: { type: "number", minimum: 0, maximum: 30 },
        scheduler: { type: "string", enum: ["default", "ddim", "euler", "euler-a"] },
        dtype: { type: "string", enum: ["float32", "float16", "bfloat16"] },
        device: { type: "string", enum: ["cpu", "cuda", "mps"] },
        deterministicAlgorithms: { type: "boolean" },
      },
    },
  },
]);

export const PROCEDURAL_SVG_SCATTER_OPERATION = OPERATION_REGISTRY.get(
  PROCEDURAL_OPERATION_ID,
  PROCEDURAL_OPERATION_VERSION,
);
export const STABLE_DIFFUSION_IMAGE_OPERATION = OPERATION_REGISTRY.get(
  STABLE_DIFFUSION_OPERATION_ID,
  STABLE_DIFFUSION_OPERATION_VERSION,
);

function proceduralLegacyDocument(root, parameters) {
  for (const key of Object.keys(parameters)) {
    if (!PROCEDURAL_PARAMETER_KEYS.has(key)) {
      throw new Error(`${PROCEDURAL_SVG_SCATTER_OPERATION.id} does not accept parameter '${key}'`);
    }
  }
  if (typeof parameters.seed !== "string" || !SEED_PATTERN.test(parameters.seed)) {
    throw new Error("parameters.seed must be a non-negative decimal integer string");
  }

  return {
    root,
    spec: {
      inputs: {},
      models: {},
      randomness: {
        mode: "seeded",
        seed: parameters.seed,
      },
      parameters: {
        width: parameters.width,
        height: parameters.height,
        count: parameters.count,
        minRadius: parameters.minRadius,
        maxRadius: parameters.maxRadius,
        background: parameters.background,
        palette: parameters.palette,
      },
    },
  };
}

function stableDiffusionLegacyDocument(root, parameters, model) {
  for (const key of Object.keys(parameters)) {
    if (!STABLE_DIFFUSION_PARAMETER_KEYS.has(key)) {
      throw new Error(`${STABLE_DIFFUSION_IMAGE_OPERATION.id} does not accept parameter '${key}'`);
    }
  }
  if (typeof parameters.pipelineId !== "string" || parameters.pipelineId.length === 0) {
    throw new Error("parameters.pipelineId must be a non-empty string");
  }
  if (typeof parameters.seed !== "string" || !SEED_PATTERN.test(parameters.seed)) {
    throw new Error("parameters.seed must be a non-negative decimal integer string");
  }

  return {
    root,
    spec: {
      inputs: {},
      models: {
        pipelineBundle: {
          id: parameters.pipelineId,
          path: assetObjectPortablePath(model),
          sha256: model.sha256,
        },
      },
      randomness: {
        mode: "seeded",
        seed: parameters.seed,
      },
      parameters: {
        prompt: parameters.prompt,
        negativePrompt: parameters.negativePrompt,
        width: parameters.width,
        height: parameters.height,
        steps: parameters.steps,
        guidanceScale: parameters.guidanceScale,
        scheduler: parameters.scheduler,
        dtype: parameters.dtype,
        device: parameters.device,
        deterministicAlgorithms: parameters.deterministicAlgorithms,
      },
    },
  };
}

async function implementationIdentity(backend) {
  return {
    id: backend.id,
    version: backend.version,
    kind: backend.kind,
    tool: await captureToolIdentity(),
  };
}

function assertStableDiffusionBackend(backend) {
  if (
    !backend ||
    backend.id !== STABLE_DIFFUSION_GENERATOR_ID ||
    backend.version !== STABLE_DIFFUSION_GENERATOR_VERSION ||
    backend.kind !== "model" ||
    typeof backend.validate !== "function" ||
    typeof backend.generate !== "function"
  ) {
    throw new Error("Stable Diffusion operation requires model.stable-diffusion.diffusers@1 backend semantics");
  }
  return backend;
}

async function createStableDiffusionBuildIdentity(backend, { parameters = {}, inputs = {} } = {}) {
  const buildIdentity = createAssetOperationBuildIdentity({
    operation: STABLE_DIFFUSION_IMAGE_OPERATION,
    implementation: await implementationIdentity(backend),
    parameters,
    inputs,
  });
  backend.validate(
    stableDiffusionLegacyDocument(".", buildIdentity.parameters, buildIdentity.inputs.model),
  );
  return buildIdentity;
}

export async function createProceduralSvgScatterOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  const backend = getBackend({ id: PROCEDURAL_GENERATOR_ID, version: PROCEDURAL_GENERATOR_VERSION });
  const buildIdentity = createAssetOperationBuildIdentity({
    operation: PROCEDURAL_SVG_SCATTER_OPERATION,
    implementation: await implementationIdentity(backend),
    parameters,
    inputs,
  });
  backend.validate(proceduralLegacyDocument(".", buildIdentity.parameters));
  return buildIdentity;
}

export async function executeProceduralSvgScatterOperation(root, { parameters = {}, inputs = {} } = {}) {
  const backend = getBackend({ id: PROCEDURAL_GENERATOR_ID, version: PROCEDURAL_GENERATOR_VERSION });
  const buildIdentity = await createProceduralSvgScatterOperationBuildIdentity({ parameters, inputs });
  const document = proceduralLegacyDocument(root, buildIdentity.parameters);
  const generated = normalizeGenerationResult(await backend.generate(document), backend.id);
  const stored = await storeAssetObject(root, {
    bytes: generated.bytes,
    kind: "vector-image",
    mediaType: "image/svg+xml",
    metadata: {
      width: buildIdentity.parameters.width,
      height: buildIdentity.parameters.height,
    },
  });

  return normalizeAssetOperationResult(PROCEDURAL_SVG_SCATTER_OPERATION, {
    outputs: {
      output: stored.asset,
    },
    observations: generated.observations,
  });
}

export async function createStableDiffusionImageOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  const backend = getBackend({
    id: STABLE_DIFFUSION_GENERATOR_ID,
    version: STABLE_DIFFUSION_GENERATOR_VERSION,
  });
  return createStableDiffusionBuildIdentity(backend, { parameters, inputs });
}

export function createStableDiffusionImageOperationExecutor(backendValue) {
  const backend = assertStableDiffusionBackend(
    backendValue ??
      getBackend({
        id: STABLE_DIFFUSION_GENERATOR_ID,
        version: STABLE_DIFFUSION_GENERATOR_VERSION,
      }),
  );

  return async function executeStableDiffusionImageOperation(
    root,
    { parameters = {}, inputs = {} } = {},
  ) {
    const buildIdentity = await createStableDiffusionBuildIdentity(backend, { parameters, inputs });
    const model = buildIdentity.inputs.model;
    await resolveAssetObject(root, model);
    const document = stableDiffusionLegacyDocument(root, buildIdentity.parameters, model);
    const generated = normalizeGenerationResult(await backend.generate(document), backend.id);
    const stored = await storeAssetObject(root, {
      bytes: generated.bytes,
      kind: "image",
      mediaType: "image/png",
      metadata: {
        width: buildIdentity.parameters.width,
        height: buildIdentity.parameters.height,
        pipelineId: buildIdentity.parameters.pipelineId,
        modelSha256: model.sha256,
      },
    });

    return normalizeAssetOperationResult(STABLE_DIFFUSION_IMAGE_OPERATION, {
      outputs: {
        output: stored.asset,
      },
      observations: generated.observations,
    });
  };
}

export const executeStableDiffusionImageOperation = createStableDiffusionImageOperationExecutor();
