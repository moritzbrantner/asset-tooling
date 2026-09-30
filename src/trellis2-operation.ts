import path from "node:path";
import {
  assetObjectPortablePath,
  storeAssetObject,
  verifyAssetObject,
} from "./asset-store.js";
import { normalizeGenerationResult } from "./backend-contract.js";
import { getBackend } from "./backends.js";
import { captureEnvironment } from "./environment.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const GENERATOR_ID = "model.trellis2";
const GENERATOR_VERSION = "1";
const OPERATION_ID = "mesh.trellis2.generate";
const OPERATION_VERSION = "1";
const PARAMETER_KEYS = new Set([
  "sourceBundleId",
  "modelBundleId",
  "legacyDecoderBundleId",
  "imageEncoderBundleId",
  "seed",
  "preprocessMode",
  "device",
  "pipelineType",
  "maxNumTokens",
  "decimationTarget",
  "textureSize",
  "remesh",
  "extensionWebp",
  "deterministicAlgorithms",
]);
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "TRELLIS.2 PBR mesh",
    description:
      "Generate a raw PBR-ready GLB through the offline TRELLIS.2 backend from a prepared RGBA image and explicit source/model/decoder/image-encoder bundles.",
    category: "model.mesh",
    inputs: [
      {
        id: "image",
        label: "Prepared RGBA image",
        assetKinds: ["image"],
        mediaTypes: ["image/png"],
      },
      {
        id: "source",
        label: "TRELLIS.2 source bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
      {
        id: "model",
        label: "TRELLIS.2 model bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
      {
        id: "legacy-decoder",
        label: "TRELLIS sparse-structure decoder bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
      {
        id: "image-encoder",
        label: "DINOv3 image-encoder bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Generated PBR GLB",
        assetKinds: ["mesh"],
        mediaTypes: ["model/gltf-binary"],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "sourceBundleId",
        "modelBundleId",
        "legacyDecoderBundleId",
        "imageEncoderBundleId",
        "seed",
        "preprocessMode",
        "device",
        "pipelineType",
        "maxNumTokens",
        "decimationTarget",
        "textureSize",
        "remesh",
        "extensionWebp",
        "deterministicAlgorithms",
      ],
      properties: {
        sourceBundleId: { type: "string", minLength: 1 },
        modelBundleId: { type: "string", minLength: 1 },
        legacyDecoderBundleId: { type: "string", minLength: 1 },
        imageEncoderBundleId: { type: "string", minLength: 1 },
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        preprocessMode: { type: "string", enum: ["prepared-rgba-premultiplied"] },
        device: { type: "string", enum: ["cuda"] },
        pipelineType: {
          type: "string",
          enum: ["512", "1024", "1024-cascade", "1536-cascade"],
        },
        maxNumTokens: { type: "integer", minimum: 4096, maximum: 131072 },
        decimationTarget: { type: "integer", minimum: 1000, maximum: 1000000 },
        textureSize: { type: "integer", enum: [512, 1024, 2048, 4096] },
        remesh: { type: "boolean" },
        extensionWebp: { type: "boolean" },
        deterministicAlgorithms: { type: "boolean" },
      },
    },
  },
]);

export const TRELLIS2_MESH_OPERATION = OPERATION_REGISTRY.get(OPERATION_ID, OPERATION_VERSION);

function assertAssetRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("TRELLIS.2 operation root must be an absolute path");
  }
  return root;
}

function assertTrellis2Backend(backend) {
  if (
    !backend ||
    backend.id !== GENERATOR_ID ||
    backend.version !== GENERATOR_VERSION ||
    backend.kind !== "model" ||
    typeof backend.validate !== "function" ||
    typeof backend.generate !== "function" ||
    typeof backend.environmentComponents !== "function"
  ) {
    throw new Error("TRELLIS.2 operation requires model.trellis2@1 backend semantics");
  }
  return backend;
}

function assertBundleId(parameters, key) {
  if (typeof parameters[key] !== "string" || parameters[key].length === 0) {
    throw new Error(`parameters.${key} must be a non-empty string`);
  }
}

function legacyDocument(root, parameters, inputs) {
  for (const key of Object.keys(parameters)) {
    if (!PARAMETER_KEYS.has(key)) {
      throw new Error(`${OPERATION_ID} does not accept parameter '${key}'`);
    }
  }
  for (const key of [
    "sourceBundleId",
    "modelBundleId",
    "legacyDecoderBundleId",
    "imageEncoderBundleId",
  ]) {
    assertBundleId(parameters, key);
  }
  if (typeof parameters.seed !== "string" || !SEED_PATTERN.test(parameters.seed)) {
    throw new Error("parameters.seed must be a non-negative decimal integer string");
  }

  return {
    root,
    spec: {
      inputs: {
        image: {
          path: assetObjectPortablePath(inputs.image),
          sha256: inputs.image.sha256,
        },
      },
      models: {
        trellis2SourceBundle: {
          id: parameters.sourceBundleId,
          path: assetObjectPortablePath(inputs.source),
          sha256: inputs.source.sha256,
        },
        trellis2ModelBundle: {
          id: parameters.modelBundleId,
          path: assetObjectPortablePath(inputs.model),
          sha256: inputs.model.sha256,
        },
        trellisLegacyDecoderBundle: {
          id: parameters.legacyDecoderBundleId,
          path: assetObjectPortablePath(inputs["legacy-decoder"]),
          sha256: inputs["legacy-decoder"].sha256,
        },
        dinoV3Bundle: {
          id: parameters.imageEncoderBundleId,
          path: assetObjectPortablePath(inputs["image-encoder"]),
          sha256: inputs["image-encoder"].sha256,
        },
      },
      randomness: {
        mode: "seeded",
        seed: parameters.seed,
      },
      parameters: {
        preprocessMode: parameters.preprocessMode,
        device: parameters.device,
        pipelineType: parameters.pipelineType,
        maxNumTokens: parameters.maxNumTokens,
        decimationTarget: parameters.decimationTarget,
        textureSize: parameters.textureSize,
        remesh: parameters.remesh,
        extensionWebp: parameters.extensionWebp,
        deterministicAlgorithms: parameters.deterministicAlgorithms,
      },
    },
  };
}

async function implementationIdentity(backend, environment) {
  return {
    id: backend.id,
    version: backend.version,
    kind: backend.kind,
    tool: await captureToolIdentity(),
    environment,
  };
}

async function createBuildIdentity(root, backend, { parameters = {}, inputs = {} } = {}) {
  const assetRoot = assertAssetRoot(root);
  const normalizedInvocation = createAssetOperationBuildIdentity({
    operation: TRELLIS2_MESH_OPERATION,
    implementation: {
      id: backend.id,
      version: backend.version,
      kind: backend.kind,
    },
    parameters,
    inputs,
  });
  const document = legacyDocument(
    assetRoot,
    normalizedInvocation.parameters,
    normalizedInvocation.inputs,
  );
  backend.validate(document);
  const environment = await captureEnvironment(await backend.environmentComponents(document));
  return createAssetOperationBuildIdentity({
    operation: TRELLIS2_MESH_OPERATION,
    implementation: await implementationIdentity(backend, environment),
    parameters: normalizedInvocation.parameters,
    inputs: normalizedInvocation.inputs,
  });
}

export async function createTrellis2MeshOperationBuildIdentity(
  root,
  invocation = {},
  backendValue,
) {
  const backend = assertTrellis2Backend(
    backendValue ?? getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION }),
  );
  return createBuildIdentity(root, backend, invocation);
}

export function createTrellis2MeshOperationExecutor(backendValue) {
  const backend = assertTrellis2Backend(
    backendValue ?? getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION }),
  );

  return async function executeTrellis2MeshOperation(
    root,
    { parameters = {}, inputs = {} } = {},
  ) {
    const buildIdentity = await createBuildIdentity(root, backend, { parameters, inputs });
    for (const input of Object.values(buildIdentity.inputs)) {
      await verifyAssetObject(root, input);
    }

    const document = legacyDocument(root, buildIdentity.parameters, buildIdentity.inputs);
    const generated = normalizeGenerationResult(await backend.generate(document), backend.id);
    const stored = await storeAssetObject(root, {
      bytes: generated.bytes,
      kind: "mesh",
      mediaType: "model/gltf-binary",
      metadata: {
        generator: GENERATOR_ID,
        inputImageSha256: buildIdentity.inputs.image.sha256,
        sourceSha256: buildIdentity.inputs.source.sha256,
        modelSha256: buildIdentity.inputs.model.sha256,
        legacyDecoderSha256: buildIdentity.inputs["legacy-decoder"].sha256,
        imageEncoderSha256: buildIdentity.inputs["image-encoder"].sha256,
        pbrChannels: ["base-color", "metallic", "roughness", "opacity"],
        alphaMode: "OPAQUE",
        pipelineType: buildIdentity.parameters.pipelineType,
        decimationTarget: buildIdentity.parameters.decimationTarget,
        textureSize: buildIdentity.parameters.textureSize,
        remesh: buildIdentity.parameters.remesh,
        extensionWebp: buildIdentity.parameters.extensionWebp,
      },
    });

    return normalizeAssetOperationResult(TRELLIS2_MESH_OPERATION, {
      outputs: { output: stored.asset },
      observations: generated.observations,
    });
  };
}

export const executeTrellis2MeshOperation = createTrellis2MeshOperationExecutor();
