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

const GENERATOR_ID = "model.triposr";
const GENERATOR_VERSION = "1";
const OPERATION_ID = "mesh.triposr.generate";
const OPERATION_VERSION = "1";
const PARAMETER_KEYS = new Set([
  "bundleId",
  "preprocessMode",
  "device",
  "chunkSize",
  "mcResolution",
  "outputFormat",
  "deterministicAlgorithms",
]);

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "TripoSR mesh",
    description:
      "Generate a raw OBJ or GLB mesh through the existing offline TripoSR backend from a prepared image and content-addressed model bundle.",
    category: "model.mesh",
    inputs: [
      {
        id: "image",
        label: "Prepared image",
        assetKinds: ["image"],
        mediaTypes: ["image/png", "image/jpeg"],
      },
      {
        id: "model",
        label: "TripoSR bundle",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Generated mesh",
        assetKinds: ["mesh"],
        mediaTypes: ["model/gltf-binary", "model/obj"],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "bundleId",
        "preprocessMode",
        "device",
        "chunkSize",
        "mcResolution",
        "outputFormat",
        "deterministicAlgorithms",
      ],
      properties: {
        bundleId: { type: "string", minLength: 1 },
        preprocessMode: { type: "string", enum: ["prepared"] },
        device: { type: "string", enum: ["cpu", "cuda"] },
        chunkSize: { type: "integer", minimum: 0, maximum: 65536 },
        mcResolution: { type: "integer", minimum: 32, maximum: 512 },
        outputFormat: { type: "string", enum: ["obj", "glb"] },
        deterministicAlgorithms: { type: "boolean" },
      },
    },
  },
]);

export const TRIPOSR_MESH_OPERATION = OPERATION_REGISTRY.get(OPERATION_ID, OPERATION_VERSION);

function assertAssetRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("TripoSR operation root must be an absolute path");
  }
  return root;
}

function assertTripoSRBackend(backend) {
  if (
    !backend ||
    backend.id !== GENERATOR_ID ||
    backend.version !== GENERATOR_VERSION ||
    backend.kind !== "model" ||
    typeof backend.validate !== "function" ||
    typeof backend.generate !== "function" ||
    typeof backend.environmentComponents !== "function"
  ) {
    throw new Error("TripoSR operation requires model.triposr@1 backend semantics");
  }
  return backend;
}

function legacyDocument(root, parameters, image, model) {
  for (const key of Object.keys(parameters)) {
    if (!PARAMETER_KEYS.has(key)) {
      throw new Error(`${OPERATION_ID} does not accept parameter '${key}'`);
    }
  }
  if (typeof parameters.bundleId !== "string" || parameters.bundleId.length === 0) {
    throw new Error("parameters.bundleId must be a non-empty string");
  }

  return {
    root,
    spec: {
      inputs: {
        image: {
          path: assetObjectPortablePath(image),
          sha256: image.sha256,
        },
      },
      models: {
        triposrBundle: {
          id: parameters.bundleId,
          path: assetObjectPortablePath(model),
          sha256: model.sha256,
        },
      },
      randomness: { mode: "none" },
      parameters: {
        preprocessMode: parameters.preprocessMode,
        device: parameters.device,
        chunkSize: parameters.chunkSize,
        mcResolution: parameters.mcResolution,
        outputFormat: parameters.outputFormat,
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
    operation: TRIPOSR_MESH_OPERATION,
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
    normalizedInvocation.inputs.image,
    normalizedInvocation.inputs.model,
  );
  backend.validate(document);
  const environment = await captureEnvironment(await backend.environmentComponents(document));
  return createAssetOperationBuildIdentity({
    operation: TRIPOSR_MESH_OPERATION,
    implementation: await implementationIdentity(backend, environment),
    parameters: normalizedInvocation.parameters,
    inputs: normalizedInvocation.inputs,
  });
}

export async function createTripoSRMeshOperationBuildIdentity(root, invocation = {}, backendValue) {
  const backend = assertTripoSRBackend(
    backendValue ?? getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION }),
  );
  return createBuildIdentity(root, backend, invocation);
}

export function createTripoSRMeshOperationExecutor(backendValue) {
  const backend = assertTripoSRBackend(
    backendValue ?? getBackend({ id: GENERATOR_ID, version: GENERATOR_VERSION }),
  );

  return async function executeTripoSRMeshOperation(
    root,
    { parameters = {}, inputs = {} } = {},
  ) {
    const buildIdentity = await createBuildIdentity(root, backend, { parameters, inputs });
    const image = buildIdentity.inputs.image;
    const model = buildIdentity.inputs.model;
    await resolveAssetObject(root, image);
    await resolveAssetObject(root, model);

    const document = legacyDocument(root, buildIdentity.parameters, image, model);
    const generated = normalizeGenerationResult(await backend.generate(document), backend.id);
    const mediaType =
      buildIdentity.parameters.outputFormat === "glb" ? "model/gltf-binary" : "model/obj";
    const stored = await storeAssetObject(root, {
      bytes: generated.bytes,
      kind: "mesh",
      mediaType,
      metadata: {
        bundleId: buildIdentity.parameters.bundleId,
        inputImageSha256: image.sha256,
        mcResolution: buildIdentity.parameters.mcResolution,
        modelSha256: model.sha256,
        outputFormat: buildIdentity.parameters.outputFormat,
      },
    });

    return normalizeAssetOperationResult(TRIPOSR_MESH_OPERATION, {
      outputs: { output: stored.asset },
      observations: generated.observations,
    });
  };
}

export const executeTripoSRMeshOperation = createTripoSRMeshOperationExecutor();
