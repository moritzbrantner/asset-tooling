import path from "node:path";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { probeProcessAdapter, runProcessAdapter } from "./process-adapter.js";
import { captureToolIdentity } from "./tool.js";

export const THREE_D_MESH_MEDIA_TYPE = "application/vnd.moritzbrantner.three-d.mesh+json";

const OPERATION_ID = "mesh.simplify";
const OPERATION_VERSION = "1";
const PROCESSOR_ID = "three-d-lod";
const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const PROCESSOR_CODEC = "three-d-mesh-json-v1";
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PARAMETER_KEYS = new Set([
  "sourceTriangleCount",
  "targetTriangleCount",
  "targetError",
  "lockBorder",
]);
const OBSERVATION_KEYS = new Set([
  "sourceTriangleCount",
  "sourceVertexCount",
  "requestedTriangleCount",
  "resultTriangleCount",
  "resultIndexCount",
  "relativeError",
  "sharedSourceVertexBuffer",
]);

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Simplify mesh",
    description: "Derive a lower-detail triangle index buffer from a validated source mesh.",
    category: "mesh.processing",
    inputs: [
      {
        id: "source",
        label: "Source mesh",
        assetKinds: ["mesh"],
        mediaTypes: [THREE_D_MESH_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Simplified mesh",
        assetKinds: ["mesh"],
        mediaTypes: [THREE_D_MESH_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sourceTriangleCount", "targetTriangleCount", "targetError", "lockBorder"],
      properties: {
        sourceTriangleCount: { type: "integer", minimum: 1 },
        targetTriangleCount: { type: "integer", minimum: 1 },
        targetError: { type: "number", minimum: 0, maximum: 1 },
        lockBorder: { type: "boolean" },
      },
    },
  },
]);

export const MESH_SIMPLIFY_OPERATION = OPERATION_REGISTRY.get(OPERATION_ID, OPERATION_VERSION);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function normalizePositiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

function normalizeParameters(value) {
  const parameters = assertPlainObject(value, "mesh.simplify parameters");
  for (const key of Object.keys(parameters)) {
    if (!PARAMETER_KEYS.has(key)) {
      throw new Error(`mesh.simplify does not accept parameter '${key}'`);
    }
  }
  for (const key of PARAMETER_KEYS) {
    if (!Object.hasOwn(parameters, key)) {
      throw new Error(`mesh.simplify parameters is missing '${key}'`);
    }
  }

  const sourceTriangleCount = normalizePositiveInteger(
    parameters.sourceTriangleCount,
    "parameters.sourceTriangleCount",
  );
  const targetTriangleCount = normalizePositiveInteger(
    parameters.targetTriangleCount,
    "parameters.targetTriangleCount",
  );
  if (targetTriangleCount > sourceTriangleCount) {
    throw new Error("parameters.targetTriangleCount must not exceed sourceTriangleCount");
  }
  if (
    typeof parameters.targetError !== "number" ||
    !Number.isFinite(parameters.targetError) ||
    parameters.targetError < 0 ||
    parameters.targetError > 1
  ) {
    throw new Error("parameters.targetError must be a finite number in 0..1");
  }
  if (typeof parameters.lockBorder !== "boolean") {
    throw new Error("parameters.lockBorder must be a boolean");
  }

  return {
    sourceTriangleCount,
    targetTriangleCount,
    targetError: parameters.targetError,
    lockBorder: parameters.lockBorder,
  };
}

function normalizeProcessor(value) {
  const processor = assertPlainObject(value, "mesh.simplify processor");
  const allowed = new Set(["repository", "revision", "executable", "scriptPath", "prefixArguments"]);
  for (const key of Object.keys(processor)) {
    if (!allowed.has(key)) throw new Error(`mesh.simplify processor contains unknown field '${key}'`);
  }

  const repository = assertNonEmptyString(processor.repository, "processor.repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("processor.repository must use owner/repository form");
  }
  if (typeof processor.revision !== "string" || !GIT_SHA_PATTERN.test(processor.revision)) {
    throw new Error("processor.revision must be an exact lowercase 40-character Git commit SHA");
  }
  const executable = assertNonEmptyString(processor.executable, "processor.executable");
  const scriptPath = assertNonEmptyString(processor.scriptPath, "processor.scriptPath");
  const prefixArguments = processor.prefixArguments ?? [];
  if (!Array.isArray(prefixArguments)) throw new Error("processor.prefixArguments must be an array");
  prefixArguments.forEach((argument, index) =>
    assertNonEmptyString(argument, `processor.prefixArguments[${index}]`),
  );

  return {
    repository,
    revision: processor.revision,
    executable,
    scriptPath,
    prefixArguments: [...prefixArguments],
  };
}

function normalizeProbeComponent(components) {
  const matching = components.filter((component) => component.id === PROCESSOR_ID);
  if (matching.length !== 1) {
    throw new Error(`processor probe must contain exactly one '${PROCESSOR_ID}' component`);
  }
  const component = assertPlainObject(matching[0], "three-d-lod processor probe component");
  assertNonEmptyString(component.version, "processor probe version");
  assertNonEmptyString(component.algorithm, "processor probe algorithm");
  if (component.protocol !== PROCESSOR_PROTOCOL) {
    throw new Error(`processor probe protocol must be '${PROCESSOR_PROTOCOL}'`);
  }
  if (component.codec !== PROCESSOR_CODEC) {
    throw new Error(`processor probe codec must be '${PROCESSOR_CODEC}'`);
  }
  assertPlainObject(component.dependencies, "processor probe dependencies");
  return component;
}

async function processorIdentity(root, processorValue) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("mesh.simplify root must be an absolute path");
  }
  const processor = normalizeProcessor(processorValue);
  const components = await probeProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
  });
  const probe = normalizeProbeComponent(components);
  return {
    processor,
    implementation: {
      id: probe.id,
      version: probe.version,
      source: {
        repository: processor.repository,
        revision: processor.revision,
      },
      probe,
      assetTooling: await captureToolIdentity(),
    },
  };
}

function normalizeObservations(value, parameters) {
  const observations = assertPlainObject(value, "mesh.simplify observations");
  for (const key of Object.keys(observations)) {
    if (!OBSERVATION_KEYS.has(key)) {
      throw new Error(`mesh.simplify observations contains unknown field '${key}'`);
    }
  }
  for (const key of OBSERVATION_KEYS) {
    if (!Object.hasOwn(observations, key)) {
      throw new Error(`mesh.simplify observations is missing '${key}'`);
    }
  }

  const sourceTriangleCount = normalizePositiveInteger(
    observations.sourceTriangleCount,
    "observations.sourceTriangleCount",
  );
  const sourceVertexCount = normalizePositiveInteger(
    observations.sourceVertexCount,
    "observations.sourceVertexCount",
  );
  const requestedTriangleCount = normalizePositiveInteger(
    observations.requestedTriangleCount,
    "observations.requestedTriangleCount",
  );
  const resultTriangleCount = normalizePositiveInteger(
    observations.resultTriangleCount,
    "observations.resultTriangleCount",
  );
  const resultIndexCount = normalizePositiveInteger(
    observations.resultIndexCount,
    "observations.resultIndexCount",
  );
  if (
    typeof observations.relativeError !== "number" ||
    !Number.isFinite(observations.relativeError) ||
    observations.relativeError < 0
  ) {
    throw new Error("observations.relativeError must be a finite non-negative number");
  }
  if (typeof observations.sharedSourceVertexBuffer !== "boolean") {
    throw new Error("observations.sharedSourceVertexBuffer must be a boolean");
  }

  if (sourceTriangleCount !== parameters.sourceTriangleCount) {
    throw new Error("observations.sourceTriangleCount does not match parameters.sourceTriangleCount");
  }
  if (requestedTriangleCount !== parameters.targetTriangleCount) {
    throw new Error("observations.requestedTriangleCount does not match parameters.targetTriangleCount");
  }
  if (resultIndexCount !== resultTriangleCount * 3) {
    throw new Error("observations.resultIndexCount must equal resultTriangleCount * 3");
  }
  if (resultTriangleCount > sourceTriangleCount) {
    throw new Error("observations.resultTriangleCount must not exceed sourceTriangleCount");
  }
  if (observations.relativeError > parameters.targetError) {
    throw new Error("observations.relativeError exceeds parameters.targetError");
  }

  return {
    sourceTriangleCount,
    sourceVertexCount,
    requestedTriangleCount,
    resultTriangleCount,
    resultIndexCount,
    relativeError: observations.relativeError,
    sharedSourceVertexBuffer: observations.sharedSourceVertexBuffer,
  };
}

export async function createMeshSimplifyOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue);
  const { implementation } = await processorIdentity(root, processorValue);
  return createAssetOperationBuildIdentity({
    operation: MESH_SIMPLIFY_OPERATION,
    implementation,
    parameters,
    inputs,
  });
}

export async function executeMeshSimplifyOperation(
  root,
  invocation = {},
  processorValue,
) {
  const processor = normalizeProcessor(processorValue);
  const buildIdentity = await createMeshSimplifyOperationBuildIdentity(root, invocation, processor);
  const source = buildIdentity.inputs.source;

  await resolveAssetObject(root, source);
  const processed = await runProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    request: {
      schemaVersion: 1,
      operation: OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: buildIdentity.parameters,
    },
    outputName: "mesh.json",
  });
  const observations = normalizeObservations(processed.observations, buildIdentity.parameters);
  const stored = await storeAssetObject(root, {
    bytes: processed.bytes,
    kind: "mesh",
    mediaType: THREE_D_MESH_MEDIA_TYPE,
    metadata: {
      meshSchemaVersion: 1,
      triangleCount: observations.resultTriangleCount,
      vertexCount: observations.sourceVertexCount,
      sourceVertexBufferPreserved: observations.sharedSourceVertexBuffer,
    },
  });

  return normalizeAssetOperationResult(MESH_SIMPLIFY_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}
