import path from "node:path";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { probeProcessAdapter, runProcessAdapter } from "./process-adapter.js";
import { captureToolIdentity } from "./tool.js";

export const THREE_D_MESH_MEDIA_TYPE = "application/vnd.moritzbrantner.three-d.mesh+json";
export const THREE_D_LOD_CHAIN_MEDIA_TYPE =
  "application/vnd.moritzbrantner.three-d.lod-chain+json";

const OPERATION_ID = "mesh.simplify";
const OPERATION_VERSION = "1";
const PROCESSOR_ID = "three-d-lod";
const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const PROCESSOR_CODEC = "three-d-mesh-json-v1";
const LOD_OPERATION_ID = "mesh.lod_chain";
const LOD_OPERATION_VERSION = "1";
const LOD_PROCESSOR_ID = "three-d-lod-chain";
const LOD_PROCESSOR_CODEC = "three-d-lod-chain-json-v1";
const LOD_BUDGET_ROUNDING = "nearest-ties-away-from-zero";
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
const LOD_PARAMETER_KEYS = new Set([
  "sourceTriangleCount",
  "sourceBased",
  "budgetRounding",
  "levels",
]);
const LOD_LEVEL_PARAMETER_KEYS = new Set([
  "triangleRatio",
  "targetTriangleCount",
  "targetError",
  "lockBorder",
]);
const LOD_OBSERVATION_KEYS = new Set([
  "sourceTriangleCount",
  "sourceVertexCount",
  "sourceBased",
  "sharedSourceVertexBuffer",
  "levels",
]);
const LOD_LEVEL_OBSERVATION_KEYS = new Set([
  "level",
  "triangleRatio",
  "requestedTriangleCount",
  "resultTriangleCount",
  "resultIndexCount",
  "relativeError",
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
  {
    schemaVersion: 1,
    id: LOD_OPERATION_ID,
    version: LOD_OPERATION_VERSION,
    label: "Build mesh LOD chain",
    description:
      "Derive an ordered family of lower-detail index buffers independently from one validated source mesh.",
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
        label: "LOD chain",
        assetKinds: ["lod-chain"],
        mediaTypes: [THREE_D_LOD_CHAIN_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sourceTriangleCount", "sourceBased", "budgetRounding", "levels"],
      properties: {
        sourceTriangleCount: { type: "integer", minimum: 2 },
        sourceBased: { type: "boolean" },
        budgetRounding: { type: "string", enum: [LOD_BUDGET_ROUNDING] },
        levels: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["triangleRatio", "targetTriangleCount", "targetError", "lockBorder"],
            properties: {
              triangleRatio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
              targetTriangleCount: { type: "integer", minimum: 1 },
              targetError: { type: "number", minimum: 0, maximum: 1 },
              lockBorder: { type: "boolean" },
            },
          },
        },
      },
    },
  },
]);

export const MESH_SIMPLIFY_OPERATION = OPERATION_REGISTRY.get(OPERATION_ID, OPERATION_VERSION);
export const MESH_LOD_CHAIN_OPERATION = OPERATION_REGISTRY.get(
  LOD_OPERATION_ID,
  LOD_OPERATION_VERSION,
);

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

function normalizeUnitNumber(value, location, { exclusiveZero = false } = {}) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1 ||
    (exclusiveZero && value === 0)
  ) {
    const range = exclusiveZero ? "greater than 0 and at most 1" : "in 0..1";
    throw new Error(`${location} must be a finite number ${range}`);
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
  const targetError = normalizeUnitNumber(parameters.targetError, "parameters.targetError");
  if (typeof parameters.lockBorder !== "boolean") {
    throw new Error("parameters.lockBorder must be a boolean");
  }

  return {
    sourceTriangleCount,
    targetTriangleCount,
    targetError,
    lockBorder: parameters.lockBorder,
  };
}

function normalizeLodParameters(value) {
  const parameters = assertPlainObject(value, `${LOD_OPERATION_ID} parameters`);
  for (const key of Object.keys(parameters)) {
    if (!LOD_PARAMETER_KEYS.has(key)) {
      throw new Error(`${LOD_OPERATION_ID} does not accept parameter '${key}'`);
    }
  }
  for (const key of LOD_PARAMETER_KEYS) {
    if (!Object.hasOwn(parameters, key)) {
      throw new Error(`${LOD_OPERATION_ID} parameters is missing '${key}'`);
    }
  }

  const sourceTriangleCount = normalizePositiveInteger(
    parameters.sourceTriangleCount,
    "parameters.sourceTriangleCount",
  );
  if (sourceTriangleCount < 2) {
    throw new Error("parameters.sourceTriangleCount must be at least 2 for a LOD chain");
  }
  if (parameters.sourceBased !== true) {
    throw new Error("parameters.sourceBased must be true");
  }
  if (parameters.budgetRounding !== LOD_BUDGET_ROUNDING) {
    throw new Error(`parameters.budgetRounding must be '${LOD_BUDGET_ROUNDING}'`);
  }
  if (!Array.isArray(parameters.levels) || parameters.levels.length === 0) {
    throw new Error("parameters.levels must be a non-empty array");
  }

  let previousRatio = 1;
  let previousTarget = sourceTriangleCount;
  const levels = parameters.levels.map((value_, index) => {
    const level = assertPlainObject(value_, `parameters.levels[${index}]`);
    for (const key of Object.keys(level)) {
      if (!LOD_LEVEL_PARAMETER_KEYS.has(key)) {
        throw new Error(`parameters.levels[${index}] contains unknown field '${key}'`);
      }
    }
    for (const key of LOD_LEVEL_PARAMETER_KEYS) {
      if (!Object.hasOwn(level, key)) {
        throw new Error(`parameters.levels[${index}] is missing '${key}'`);
      }
    }
    const triangleRatio = normalizeUnitNumber(
      level.triangleRatio,
      `parameters.levels[${index}].triangleRatio`,
      { exclusiveZero: true },
    );
    if (triangleRatio >= 1) {
      throw new Error(`parameters.levels[${index}].triangleRatio must be less than 1`);
    }
    const targetTriangleCount = normalizePositiveInteger(
      level.targetTriangleCount,
      `parameters.levels[${index}].targetTriangleCount`,
    );
    if (targetTriangleCount >= sourceTriangleCount) {
      throw new Error(
        `parameters.levels[${index}].targetTriangleCount must be less than sourceTriangleCount`,
      );
    }
    if (triangleRatio >= previousRatio) {
      throw new Error("parameters.levels triangleRatio values must be strictly decreasing");
    }
    if (targetTriangleCount >= previousTarget) {
      throw new Error("parameters.levels targetTriangleCount values must be strictly decreasing");
    }
    const targetError = normalizeUnitNumber(
      level.targetError,
      `parameters.levels[${index}].targetError`,
    );
    if (typeof level.lockBorder !== "boolean") {
      throw new Error(`parameters.levels[${index}].lockBorder must be a boolean`);
    }
    previousRatio = triangleRatio;
    previousTarget = targetTriangleCount;
    return {
      triangleRatio,
      targetTriangleCount,
      targetError,
      lockBorder: level.lockBorder,
    };
  });

  return {
    sourceTriangleCount,
    sourceBased: true,
    budgetRounding: LOD_BUDGET_ROUNDING,
    levels,
  };
}

function normalizeProcessor(value, operationId = OPERATION_ID) {
  const processor = assertPlainObject(value, `${operationId} processor`);
  const allowed = new Set(["repository", "revision", "executable", "scriptPath", "prefixArguments"]);
  for (const key of Object.keys(processor)) {
    if (!allowed.has(key)) throw new Error(`${operationId} processor contains unknown field '${key}'`);
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

function processorStorageEnvironment(processor) {
  if (!/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) return {};
  const environment = {};
  for (const name of ["CARGO_HOME", "RUSTUP_HOME", "HOME", "USERPROFILE"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function normalizeProbeComponent(components, { processorId, codec, operationId }) {
  const matching = components.filter((component) => component.id === processorId);
  if (matching.length !== 1) {
    throw new Error(`processor probe must contain exactly one '${processorId}' component`);
  }
  const component = assertPlainObject(matching[0], `${operationId} processor probe component`);
  assertNonEmptyString(component.version, "processor probe version");
  assertNonEmptyString(component.algorithm, "processor probe algorithm");
  if (component.protocol !== PROCESSOR_PROTOCOL) {
    throw new Error(`processor probe protocol must be '${PROCESSOR_PROTOCOL}'`);
  }
  if (component.codec !== codec) {
    throw new Error(`processor probe codec must be '${codec}'`);
  }
  assertPlainObject(component.dependencies, "processor probe dependencies");
  assertNonEmptyString(component.cargoLock, "processor probe cargoLock");
  return component;
}

async function processorIdentity(
  root,
  processorValue,
  {
    operationId = OPERATION_ID,
    processorId = PROCESSOR_ID,
    codec = PROCESSOR_CODEC,
  } = {},
) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(`${operationId} root must be an absolute path`);
  }
  const processor = normalizeProcessor(processorValue, operationId);
  const environment = processorStorageEnvironment(processor);
  const components = await probeProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    environment,
  });
  const probe = normalizeProbeComponent(components, { processorId, codec, operationId });
  return {
    processor,
    environment,
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

function normalizeLodProcessorObservations(value, parameters) {
  const observations = assertPlainObject(value, `${LOD_OPERATION_ID} observations`);
  for (const key of Object.keys(observations)) {
    if (!LOD_OBSERVATION_KEYS.has(key)) {
      throw new Error(`${LOD_OPERATION_ID} observations contains unknown field '${key}'`);
    }
  }
  for (const key of LOD_OBSERVATION_KEYS) {
    if (!Object.hasOwn(observations, key)) {
      throw new Error(`${LOD_OPERATION_ID} observations is missing '${key}'`);
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
  if (sourceTriangleCount !== parameters.sourceTriangleCount) {
    throw new Error("observations.sourceTriangleCount does not match parameters.sourceTriangleCount");
  }
  if (observations.sourceBased !== true) {
    throw new Error("observations.sourceBased must be true");
  }
  if (observations.sharedSourceVertexBuffer !== true) {
    throw new Error("observations.sharedSourceVertexBuffer must be true for this LOD bundle codec");
  }
  if (!Array.isArray(observations.levels) || observations.levels.length !== parameters.levels.length) {
    throw new Error("observations.levels must match the requested LOD level count");
  }

  let previousResult = sourceTriangleCount;
  const levels = observations.levels.map((value_, index) => {
    const level = assertPlainObject(value_, `observations.levels[${index}]`);
    for (const key of Object.keys(level)) {
      if (!LOD_LEVEL_OBSERVATION_KEYS.has(key)) {
        throw new Error(`observations.levels[${index}] contains unknown field '${key}'`);
      }
    }
    for (const key of LOD_LEVEL_OBSERVATION_KEYS) {
      if (!Object.hasOwn(level, key)) {
        throw new Error(`observations.levels[${index}] is missing '${key}'`);
      }
    }
    const requested = parameters.levels[index];
    if (level.level !== index + 1) {
      throw new Error(`observations.levels[${index}].level must be ${index + 1}`);
    }
    if (level.triangleRatio !== requested.triangleRatio) {
      throw new Error(`observations.levels[${index}].triangleRatio does not match parameters`);
    }
    const requestedTriangleCount = normalizePositiveInteger(
      level.requestedTriangleCount,
      `observations.levels[${index}].requestedTriangleCount`,
    );
    if (requestedTriangleCount !== requested.targetTriangleCount) {
      throw new Error(`observations.levels[${index}].requestedTriangleCount does not match parameters`);
    }
    const resultTriangleCount = normalizePositiveInteger(
      level.resultTriangleCount,
      `observations.levels[${index}].resultTriangleCount`,
    );
    const resultIndexCount = normalizePositiveInteger(
      level.resultIndexCount,
      `observations.levels[${index}].resultIndexCount`,
    );
    if (resultIndexCount !== resultTriangleCount * 3) {
      throw new Error(`observations.levels[${index}].resultIndexCount must equal triangle count * 3`);
    }
    if (resultTriangleCount > previousResult) {
      throw new Error("observed LOD result triangle counts must be non-increasing");
    }
    const relativeError = level.relativeError;
    if (typeof relativeError !== "number" || !Number.isFinite(relativeError) || relativeError < 0) {
      throw new Error(`observations.levels[${index}].relativeError must be finite and non-negative`);
    }
    if (relativeError > requested.targetError) {
      throw new Error(`observations.levels[${index}].relativeError exceeds parameters.targetError`);
    }
    previousResult = resultTriangleCount;
    return {
      level: index + 1,
      triangleRatio: requested.triangleRatio,
      requestedTriangleCount,
      resultTriangleCount,
      resultIndexCount,
      relativeError,
    };
  });

  return {
    sourceTriangleCount,
    sourceVertexCount,
    sourceBased: true,
    sharedSourceVertexBuffer: true,
    levels,
  };
}

function indexBufferSha256(indices, location) {
  const bytes = Buffer.alloc(indices.length * 4);
  indices.forEach((value, index) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`${location}[${index}] must be an unsigned 32-bit integer`);
    }
    bytes.writeUInt32LE(value, index * 4);
  });
  return sha256Bytes(bytes);
}

function validateAndEnrichLodOutput(bytes, observations, parameters) {
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`mesh.lod_chain processor output is not valid JSON: ${error.message}`);
  }
  document = assertPlainObject(document, "mesh.lod_chain processor output");
  const allowed = new Set(["schemaVersion", "sourceVertices", "levels"]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new Error(`mesh.lod_chain processor output contains unknown field '${key}'`);
  }
  if (document.schemaVersion !== 1) {
    throw new Error("mesh.lod_chain processor output schemaVersion must be 1");
  }
  if (!Array.isArray(document.sourceVertices) || document.sourceVertices.length !== observations.sourceVertexCount) {
    throw new Error("mesh.lod_chain processor output sourceVertices does not match observations");
  }
  document.sourceVertices.forEach((vertex, index) => {
    if (
      !Array.isArray(vertex) ||
      vertex.length !== 3 ||
      vertex.some((component) => typeof component !== "number" || !Number.isFinite(component))
    ) {
      throw new Error(`mesh.lod_chain processor output sourceVertices[${index}] must be a finite vec3`);
    }
  });
  if (!Array.isArray(document.levels) || document.levels.length !== parameters.levels.length) {
    throw new Error("mesh.lod_chain processor output levels must match the requested level count");
  }

  const levels = document.levels.map((value, index) => {
    const level = assertPlainObject(value, `mesh.lod_chain processor output levels[${index}]`);
    const keys = new Set(["level", "triangleRatio", "indices"]);
    for (const key of Object.keys(level)) {
      if (!keys.has(key)) {
        throw new Error(`mesh.lod_chain processor output levels[${index}] contains unknown field '${key}'`);
      }
    }
    if (level.level !== index + 1) {
      throw new Error(`mesh.lod_chain processor output levels[${index}].level must be ${index + 1}`);
    }
    if (level.triangleRatio !== parameters.levels[index].triangleRatio) {
      throw new Error(`mesh.lod_chain processor output levels[${index}].triangleRatio does not match parameters`);
    }
    if (!Array.isArray(level.indices) || level.indices.length !== observations.levels[index].resultIndexCount) {
      throw new Error(`mesh.lod_chain processor output levels[${index}].indices does not match observations`);
    }
    for (let position = 0; position < level.indices.length; position += 1) {
      const vertexIndex = level.indices[position];
      if (
        !Number.isSafeInteger(vertexIndex) ||
        vertexIndex < 0 ||
        vertexIndex >= document.sourceVertices.length
      ) {
        throw new Error(`mesh.lod_chain processor output levels[${index}].indices[${position}] is out of bounds`);
      }
    }
    return {
      ...observations.levels[index],
      indexSha256: indexBufferSha256(
        level.indices,
        `mesh.lod_chain processor output levels[${index}].indices`,
      ),
    };
  });

  return {
    ...observations,
    levels,
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

export async function executeMeshSimplifyOperation(root, invocation = {}, processorValue) {
  const processor = normalizeProcessor(processorValue);
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { implementation, environment } = await processorIdentity(root, processor);
  const buildIdentity = createAssetOperationBuildIdentity({
    operation: MESH_SIMPLIFY_OPERATION,
    implementation,
    parameters,
    inputs: invocation.inputs ?? {},
  });
  const source = buildIdentity.inputs.source;

  await resolveAssetObject(root, source);
  const processed = await runProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    environment,
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
      sourceVertexCount: observations.sourceVertexCount,
      sourceVertexBufferPreserved: observations.sharedSourceVertexBuffer,
    },
  });

  return normalizeAssetOperationResult(MESH_SIMPLIFY_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}

export async function createMeshLodChainOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeLodParameters(parameterValue);
  const { implementation } = await processorIdentity(root, processorValue, {
    operationId: LOD_OPERATION_ID,
    processorId: LOD_PROCESSOR_ID,
    codec: LOD_PROCESSOR_CODEC,
  });
  return createAssetOperationBuildIdentity({
    operation: MESH_LOD_CHAIN_OPERATION,
    implementation,
    parameters,
    inputs,
  });
}

export async function executeMeshLodChainOperation(root, invocation = {}, processorValue) {
  const processor = normalizeProcessor(processorValue, LOD_OPERATION_ID);
  const parameters = normalizeLodParameters(invocation.parameters ?? {});
  const { implementation, environment } = await processorIdentity(root, processor, {
    operationId: LOD_OPERATION_ID,
    processorId: LOD_PROCESSOR_ID,
    codec: LOD_PROCESSOR_CODEC,
  });
  const buildIdentity = createAssetOperationBuildIdentity({
    operation: MESH_LOD_CHAIN_OPERATION,
    implementation,
    parameters,
    inputs: invocation.inputs ?? {},
  });
  const source = buildIdentity.inputs.source;

  await resolveAssetObject(root, source);
  const processed = await runProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    environment,
    request: {
      schemaVersion: 1,
      operation: LOD_OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: buildIdentity.parameters,
    },
    outputName: "lod-chain.json",
  });
  const processorObservations = normalizeLodProcessorObservations(
    processed.observations,
    buildIdentity.parameters,
  );
  const observations = validateAndEnrichLodOutput(
    processed.bytes,
    processorObservations,
    buildIdentity.parameters,
  );
  const stored = await storeAssetObject(root, {
    bytes: processed.bytes,
    kind: "lod-chain",
    mediaType: THREE_D_LOD_CHAIN_MEDIA_TYPE,
    metadata: {
      lodSchemaVersion: 1,
      sourceTriangleCount: observations.sourceTriangleCount,
      sourceVertexCount: observations.sourceVertexCount,
      levelCount: observations.levels.length,
      sourceVertexBufferPreserved: observations.sharedSourceVertexBuffer,
    },
  });

  return normalizeAssetOperationResult(MESH_LOD_CHAIN_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}
