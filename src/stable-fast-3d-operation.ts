import path from "node:path";
import {
  assetObjectPortablePath,
  resolveAssetObject,
  storeAssetObject,
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

const GENERATOR_ID = "model.stable-fast-3d";
const GENERATOR_VERSION = "1";
const OPERATION_ID = "mesh.stable-fast-3d.generate";
const OPERATION_VERSION = "1";
const PARAMETER_KEYS = new Set([
  "sourceBundleId",
  "modelBundleId",
  "tokenizerBundleId",
  "preprocessMode",
  "device",
  "textureResolution",
  "remesh",
  "targetVertexCount",
  "deterministicAlgorithms",
]);

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Stable Fast 3D mesh",
    description:
      "Generate a raw textured GLB through the offline Stable Fast 3D backend from a prepared RGBA image and explicit source/model/tokenizer bundles.",
    category: "model.mesh",
    inputs: [
      {
        id: "image",
        label: "Prepared RGBA image",
        assetKinds: ["image"],
        mediaTypes: ["image/png", "image/jpeg"],
      },
      {
        id: "source",
        label: "Stable Fast 3D source bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
      {
        id: "model",
        label: "Stable Fast 3D model bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
      {
        id: "tokenizer",
        label: "DINOv2 image-tokenizer bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Generated textured GLB",
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
        "tokenizerBundleId",
        "preprocessMode",
        "device",
        "textureResolution",
        "remesh",
        "targetVertexCount",
        "deterministicAlgorithms",
      ],
      properties: {
        sourceBundleId: { type: "string", minLength: 1 },
        modelBundleId: { type: "string", minLength: 1 },
        tokenizerBundleId: { type: "string", minLength: 1 },
        preprocessMode: { type: "string", enum: ["prepared-rgba"] },
        device: { type: "string", enum: ["cpu", "cuda"] },
        textureResolution: {
          type: "integer",
          enum: [512, 768, 1024, 1280, 1536, 1792, 2048],
        },
        remesh: { type: "string", enum: ["none", "triangle", "quad"] },
        targetVertexCount: {
          type: "integer",
          minimum: -1,
          maximum: 20000,
        },
        deterministicAlgorithms: { type: "boolean" },
      },
    },
  },
]);

export const STABLE_FAST_3D_MESH_OPERATION = OPERATION_REGISTRY.get(
  OPERATION_ID,
  OPERATION_VERSION,
);

function assertAssetRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("Stable Fast 3D operation root must be an absolute path");
  }
  return root;
}

function assertStableFast3DBackend(backend) {
  if (
    !backend ||
    backend.id !== GENERATOR_ID ||
    backend.version !== GENERATOR_VERSION ||
    backend.kind !== "model" ||
    typeof backend.validate !== "function" ||
    typeof backend.generate !== "function" ||
    typeof backend.environmentComponents !== "function"
  ) {
    throw new Error("Stable Fast 3D operation requires model.stable-fast-3d@1 backend semantics");
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
  assertBundleId(parameters, "sourceBundleId");
  assertBundleId(parameters, "modelBundleId");
  assertBundleId(parameters, "tokenizerBundleId");

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
        sf3dSourceBundle: {
          id: parameters.sourceBundleId,
          path: assetObjectPortablePath(inputs.source),
          sha256: inputs.source.sha256,
        },
        sf3dModelBundle: {
          id: parameters.modelBundleId,
          path: assetObjectPortablePath(inputs.model),
          sha256: inputs.model.sha256,
        },
        dinoBundle: {
          id: parameters.tokenizerBundleId,
          path: assetObjectPortablePath(inputs.tokenizer),
          sha256: inputs.tokenizer.sha256,
        },
      },
      randomness: { mode: "none" },
      parameters: {
        preprocessMode: parameters.preprocessMode,
        device: parameters.device,
        textureResolution: parameters.textureResolution,
        remesh: parameters.remesh,
        targetVertexCount: parameters.targetVertexCount,
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
    operation: STABLE_FAST_3D_MESH_OPERATION,
    implementation: {
      id: backend.id,
      version: backend.version,
      kind: backend.kind,
    },
    parameters,
    inputs,
  });
  const document = legacyDocument(assetRoot, normalizedInvocation.parameters, normalizedInvocation.inputs);
  backend.validate(document);
  const environment = await captureEnvironment(await backend.environmentComponents(document));
  return createAssetOperationBuildIdentity({
    operation: STABLE_FAST_3D_MESH_OPERATION,
    implementation: await implementationIdentity(backend, environment),
    parameters: normalizedInvocation.parameters,
    inputs: normalizedInvocation.inputs,
  });
}

export async function createStableFast3DMeshOperationBuildIdentity(
  root,
  invocation = {},
  backendValue,
) {
  const backend = assertStableFast3DBackend(
    backendValue ?? getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION }),
  );
  return createBuildIdentity(root, backend, invocation);
}

export function createStableFast3DMeshOperationExecutor(backendValue) {
  const backend = assertStableFast3DBackend(
    backendValue ?? getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION }),
  );

  return async function executeStableFast3DMeshOperation(
    root,
    { parameters = {}, inputs = {} } = {},
  ) {
    const buildIdentity = await createBuildIdentity(root, backend, { parameters, inputs });
    for (const input of Object.values(buildIdentity.inputs)) {
      await resolveAssetObject(root, input);
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
        tokenizerSha256: buildIdentity.inputs.tokenizer.sha256,
        textureResolution: buildIdentity.parameters.textureResolution,
        remesh: buildIdentity.parameters.remesh,
        targetVertexCount: buildIdentity.parameters.targetVertexCount,
      },
    });

    return normalizeAssetOperationResult(STABLE_FAST_3D_MESH_OPERATION, {
      outputs: { output: stored.asset },
      observations: generated.observations,
    });
  };
}

export const executeStableFast3DMeshOperation = createStableFast3DMeshOperationExecutor();
