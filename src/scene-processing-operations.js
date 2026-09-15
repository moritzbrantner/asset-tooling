import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { capturePinnedProcessProcessorIdentity } from "./pinned-process-processor.js";
import { runProcessAdapter } from "./process-adapter.js";
import {
  GLB_MEDIA_TYPE,
  THREE_D_SCENE_COORDINATE_SYSTEM,
  THREE_D_SCENE_MEDIA_TYPE,
  THREE_D_SCENE_NORMALIZED_UNIT,
  normalizeSceneExportObservations,
  normalizeSceneNormalizeObservations,
  parseCanonicalGlbBytes,
  parseThreeDSceneBytes,
} from "./three-d-scene-transport.js";

const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const NORMALIZE_OPERATION_ID = "scene.normalize";
const EXPORT_OPERATION_ID = "scene.export.glb";
const OPERATION_VERSION = "1";
const NORMALIZE_PROCESSOR_ID = "three-d-scene-normalize";
const EXPORT_PROCESSOR_ID = "three-d-scene-export-glb";
const NORMALIZE_PROCESSOR_CODEC = "three-d-scene-json-v1";
const EXPORT_PROCESSOR_CODEC = "gltf-binary-v2";

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: NORMALIZE_OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Normalize 3D scene",
    description:
      "Normalize renderer-neutral scene hierarchy, mesh indexing, stable ordering, quaternion representation, and supported source units through the authoritative 3d-lab scene contract.",
    category: "scene.processing",
    inputs: [
      {
        id: "source",
        label: "Source scene",
        assetKinds: ["scene"],
        mediaTypes: [THREE_D_SCENE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Normalized scene",
        assetKinds: ["scene"],
        mediaTypes: [THREE_D_SCENE_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    schemaVersion: 1,
    id: EXPORT_OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Export canonical GLB",
    description:
      "Normalize a renderer-neutral scene and serialize deterministic GLB 2.0 bytes through the authoritative 3d-lab export contract.",
    category: "scene.export",
    inputs: [
      {
        id: "source",
        label: "Source scene",
        assetKinds: ["scene"],
        mediaTypes: [THREE_D_SCENE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Canonical GLB",
        assetKinds: ["scene"],
        mediaTypes: [GLB_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
]);

export const SCENE_NORMALIZE_OPERATION = OPERATION_REGISTRY.get(
  NORMALIZE_OPERATION_ID,
  OPERATION_VERSION,
);
export const SCENE_EXPORT_GLB_OPERATION = OPERATION_REGISTRY.get(
  EXPORT_OPERATION_ID,
  OPERATION_VERSION,
);
export { GLB_MEDIA_TYPE, THREE_D_SCENE_MEDIA_TYPE };

const NORMALIZE_PROCESSOR = Object.freeze({
  operationId: NORMALIZE_OPERATION_ID,
  processorId: NORMALIZE_PROCESSOR_ID,
  protocol: PROCESSOR_PROTOCOL,
  codec: NORMALIZE_PROCESSOR_CODEC,
});
const EXPORT_PROCESSOR = Object.freeze({
  operationId: EXPORT_OPERATION_ID,
  processorId: EXPORT_PROCESSOR_ID,
  protocol: PROCESSOR_PROTOCOL,
  codec: EXPORT_PROCESSOR_CODEC,
});

function normalizeParameters(value, operationId) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operationId} parameters must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${operationId} parameters must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length > 0) {
    throw new Error(`${operationId} parameters contains unknown field '${keys[0]}'`);
  }
  return {};
}

async function createBuildIdentity(
  root,
  operation,
  parameters,
  inputs,
  processorValue,
  processorIdentity,
) {
  const base = createAssetOperationBuildIdentity({
    operation,
    implementation: { id: processorIdentity.processorId, version: "unprobed" },
    parameters,
    inputs,
  });
  const processor = await capturePinnedProcessProcessorIdentity(
    root,
    processorValue,
    processorIdentity,
  );
  return createAssetOperationBuildIdentity({
    operation,
    implementation: processor.implementation,
    parameters: base.parameters,
    inputs: base.inputs,
  });
}

export async function createSceneNormalizeOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  return createBuildIdentity(
    root,
    SCENE_NORMALIZE_OPERATION,
    normalizeParameters(parameterValue, NORMALIZE_OPERATION_ID),
    inputs,
    processorValue,
    NORMALIZE_PROCESSOR,
  );
}

export async function executeSceneNormalizeOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue, NORMALIZE_OPERATION_ID);
  const invocation = createAssetOperationBuildIdentity({
    operation: SCENE_NORMALIZE_OPERATION,
    implementation: { id: NORMALIZE_PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseThreeDSceneBytes(
    sourceBytes,
    `${NORMALIZE_OPERATION_ID} source scene`,
  );
  const identity = await capturePinnedProcessProcessorIdentity(
    root,
    processorValue,
    NORMALIZE_PROCESSOR,
  );
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "scene.json",
    request: {
      schemaVersion: 1,
      operation: NORMALIZE_OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: invocation.parameters,
    },
  });
  const parsedOutput = parseThreeDSceneBytes(
    result.bytes,
    `${NORMALIZE_OPERATION_ID} processor output`,
    { requireCanonical: true },
  );
  const observations = normalizeSceneNormalizeObservations(
    result.observations,
    parsedSource,
    parsedOutput,
  );
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "scene",
    mediaType: THREE_D_SCENE_MEDIA_TYPE,
    metadata: {
      sceneSchemaVersion: 1,
      coordinateSystem: THREE_D_SCENE_COORDINATE_SYSTEM,
      unit: THREE_D_SCENE_NORMALIZED_UNIT,
      meshCount: parsedOutput.meshCount,
      nodeCount: parsedOutput.nodeCount,
      vertexCount: parsedOutput.vertexCount,
      triangleCount: parsedOutput.triangleCount,
      operation: NORMALIZE_OPERATION_ID,
      sourceSha256: source.sha256,
    },
  });
  return normalizeAssetOperationResult(SCENE_NORMALIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}

export async function createSceneExportGlbOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  return createBuildIdentity(
    root,
    SCENE_EXPORT_GLB_OPERATION,
    normalizeParameters(parameterValue, EXPORT_OPERATION_ID),
    inputs,
    processorValue,
    EXPORT_PROCESSOR,
  );
}

export async function executeSceneExportGlbOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue, EXPORT_OPERATION_ID);
  const invocation = createAssetOperationBuildIdentity({
    operation: SCENE_EXPORT_GLB_OPERATION,
    implementation: { id: EXPORT_PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseThreeDSceneBytes(
    sourceBytes,
    `${EXPORT_OPERATION_ID} source scene`,
  );
  const identity = await capturePinnedProcessProcessorIdentity(
    root,
    processorValue,
    EXPORT_PROCESSOR,
  );
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "scene.glb",
    request: {
      schemaVersion: 1,
      operation: EXPORT_OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: invocation.parameters,
    },
  });
  const parsedGlb = parseCanonicalGlbBytes(
    result.bytes,
    `${EXPORT_OPERATION_ID} processor output`,
  );
  const observations = normalizeSceneExportObservations(
    result.observations,
    parsedSource,
    parsedGlb,
    result.bytes.length,
  );
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "scene",
    mediaType: GLB_MEDIA_TYPE,
    metadata: {
      format: "glb-2.0",
      coordinateSystem: THREE_D_SCENE_COORDINATE_SYSTEM,
      unit: THREE_D_SCENE_NORMALIZED_UNIT,
      meshCount: parsedGlb.meshCount,
      nodeCount: parsedGlb.nodeCount,
      vertexCount: parsedGlb.vertexCount,
      triangleCount: parsedGlb.triangleCount,
      operation: EXPORT_OPERATION_ID,
      sourceSha256: source.sha256,
    },
  });
  return normalizeAssetOperationResult(SCENE_EXPORT_GLB_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}
