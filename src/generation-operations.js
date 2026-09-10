import { storeAssetObject } from "./asset-store.js";
import { normalizeGenerationResult } from "./backend-contract.js";
import { getBackend } from "./backends.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationDescriptor,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const GENERATOR_ID = "builtin.procedural.svg-scatter";
const GENERATOR_VERSION = "1";
const OPERATION_PARAMETER_KEYS = new Set([
  "seed",
  "width",
  "height",
  "count",
  "minRadius",
  "maxRadius",
  "background",
  "palette",
]);
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

export const PROCEDURAL_SVG_SCATTER_OPERATION = Object.freeze(
  createAssetOperationDescriptor({
    schemaVersion: 1,
    id: "procedural.svg.scatter",
    version: "1",
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
  }),
);

function legacyDocument(root, parameters) {
  for (const key of Object.keys(parameters)) {
    if (!OPERATION_PARAMETER_KEYS.has(key)) {
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

async function implementationIdentity(backend) {
  return {
    id: backend.id,
    version: backend.version,
    kind: backend.kind,
    tool: await captureToolIdentity(),
  };
}

export async function createProceduralSvgScatterOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  const backend = getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION });
  return createAssetOperationBuildIdentity({
    operation: PROCEDURAL_SVG_SCATTER_OPERATION,
    implementation: await implementationIdentity(backend),
    parameters,
    inputs,
  });
}

export async function executeProceduralSvgScatterOperation(root, { parameters = {}, inputs = {} } = {}) {
  const backend = getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION });
  const buildIdentity = await createAssetOperationBuildIdentity({
    operation: PROCEDURAL_SVG_SCATTER_OPERATION,
    implementation: await implementationIdentity(backend),
    parameters,
    inputs,
  });
  const document = legacyDocument(root, buildIdentity.parameters);
  backend.validate(document);

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
