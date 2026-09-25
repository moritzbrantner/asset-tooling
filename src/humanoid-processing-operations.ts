import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { resolveExternalProcessorIdentity } from "./external-processor.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { runProcessAdapter } from "./process-adapter.js";

export const THREE_D_HUMANOID_MEDIA_TYPE =
  "application/vnd.moritzbrantner.three-d.humanoid+json";

const OPERATION_ID = "rig.humanoid.validate";
const OPERATION_VERSION = "1";
const PROCESSOR_ID = "three-d-humanoid-validate";
const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const PROCESSOR_CODEC = "three-d-humanoid-json-v1";

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Validate production humanoid rig",
    description:
      "Validate humanoid hierarchy, rest pose, semantic bone mapping, Root/Hips separation, and standard attachment sockets through the authoritative three-d-animation contract.",
    category: "rig.processing",
    inputs: [
      {
        id: "source",
        label: "Source humanoid rig",
        assetKinds: ["humanoid-rig"],
        mediaTypes: [THREE_D_HUMANOID_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Validated humanoid rig",
        assetKinds: ["humanoid-rig"],
        mediaTypes: [THREE_D_HUMANOID_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
]);

export const HUMANOID_VALIDATE_OPERATION = OPERATION_REGISTRY.get(
  OPERATION_ID,
  OPERATION_VERSION,
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

function assertExactKeys(value, keys, location) {
  const object = assertPlainObject(value, location);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function finiteF32(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${location} must be a finite number`);
  }
  const normalized = Math.fround(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${location} must be representable as a finite f32`);
  }
  return Object.is(normalized, -0) ? 0 : normalized;
}

function nonNegativeSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} must be a non-negative safe integer`);
  }
  return value;
}

function stringId(value, location) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${location} must be a lower-kebab-case identifier`);
  }
  return value;
}

function fixedVector(value, width, location) {
  if (!Array.isArray(value) || value.length !== width) {
    throw new Error(`${location} must contain exactly ${width} finite f32 values`);
  }
  return value.map((component, index) => finiteF32(component, `${location}[${index}]`));
}

function matrix(value, location) {
  return fixedVector(value, 16, location);
}

function transform(value, location) {
  const object = assertExactKeys(
    value,
    new Set(["translation", "rotation", "scale"]),
    location,
  );
  return {
    translation: fixedVector(object.translation, 3, `${location}.translation`),
    rotation: fixedVector(object.rotation, 4, `${location}.rotation`),
    scale: fixedVector(object.scale, 3, `${location}.scale`),
  };
}

function parseHumanoidDocument(bytes, location) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${location} is not valid JSON: ${error.message}`);
  }
  const document = assertExactKeys(
    value,
    new Set([
      "schemaVersion",
      "referenceHeight",
      "joints",
      "restPose",
      "bindings",
      "sockets",
    ]),
    location,
  );
  if (document.schemaVersion !== 1) throw new Error(`${location} schemaVersion must be 1`);
  const referenceHeight = finiteF32(document.referenceHeight, `${location}.referenceHeight`);
  if (referenceHeight <= 0) throw new Error(`${location}.referenceHeight must be positive`);
  if (!Array.isArray(document.joints) || document.joints.length === 0) {
    throw new Error(`${location}.joints must be a non-empty array`);
  }
  if (!Array.isArray(document.restPose) || document.restPose.length === 0) {
    throw new Error(`${location}.restPose must be a non-empty array`);
  }
  if (!Array.isArray(document.bindings) || document.bindings.length === 0) {
    throw new Error(`${location}.bindings must be a non-empty array`);
  }
  if (!Array.isArray(document.sockets) || document.sockets.length === 0) {
    throw new Error(`${location}.sockets must be a non-empty array`);
  }

  const joints = document.joints.map((entry, index) => {
    const joint = assertExactKeys(
      entry,
      new Set(["parent", "inverseBind"]),
      `${location}.joints[${index}]`,
    );
    const parent =
      joint.parent === null
        ? null
        : nonNegativeSafeInteger(joint.parent, `${location}.joints[${index}].parent`);
    return {
      parent,
      inverseBind: matrix(joint.inverseBind, `${location}.joints[${index}].inverseBind`),
    };
  });
  const restPose = document.restPose.map((entry, index) =>
    transform(entry, `${location}.restPose[${index}]`),
  );
  const bindings = document.bindings.map((entry, index) => {
    const binding = assertExactKeys(
      entry,
      new Set(["bone", "node"]),
      `${location}.bindings[${index}]`,
    );
    return {
      bone: stringId(binding.bone, `${location}.bindings[${index}].bone`),
      node: nonNegativeSafeInteger(binding.node, `${location}.bindings[${index}].node`),
    };
  });
  const sockets = document.sockets.map((entry, index) => {
    const socket = assertExactKeys(
      entry,
      new Set(["socket", "bone", "local"]),
      `${location}.sockets[${index}]`,
    );
    return {
      socket: stringId(socket.socket, `${location}.sockets[${index}].socket`),
      bone: stringId(socket.bone, `${location}.sockets[${index}].bone`),
      local: transform(socket.local, `${location}.sockets[${index}].local`),
    };
  });

  return {
    schemaVersion: 1,
    referenceHeight,
    joints,
    restPose,
    bindings,
    sockets,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateOutput(source, output) {
  if (!sameJson(source, output)) {
    throw new Error(`${OPERATION_ID} output changed humanoid source data`);
  }
}

function normalizeParameters(value) {
  const parameters = assertPlainObject(value, `${OPERATION_ID} parameters`);
  if (Object.keys(parameters).length > 0) {
    throw new Error(`${OPERATION_ID} parameters must be empty for version 1`);
  }
  return {};
}

function assertTrue(value, location) {
  if (value !== true) throw new Error(`${location} must be true`);
  return true;
}

function positiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

function normalizeObservations(value, source) {
  const observations = assertExactKeys(
    value,
    new Set([
      "jointCount",
      "mappedBoneCount",
      "helperJointCount",
      "socketCount",
      "rootNode",
      "hipsNode",
      "optionalToeCount",
      "referenceHeight",
      "semanticHierarchyValid",
      "rootHipsSeparated",
      "standardSocketsPresent",
    ]),
    `${OPERATION_ID} observations`,
  );
  const jointCount = positiveSafeInteger(observations.jointCount, "observations.jointCount");
  const mappedBoneCount = positiveSafeInteger(
    observations.mappedBoneCount,
    "observations.mappedBoneCount",
  );
  const helperJointCount = nonNegativeSafeInteger(
    observations.helperJointCount,
    "observations.helperJointCount",
  );
  const socketCount = positiveSafeInteger(observations.socketCount, "observations.socketCount");
  const rootNode = nonNegativeSafeInteger(observations.rootNode, "observations.rootNode");
  const hipsNode = nonNegativeSafeInteger(observations.hipsNode, "observations.hipsNode");
  const optionalToeCount = nonNegativeSafeInteger(
    observations.optionalToeCount,
    "observations.optionalToeCount",
  );
  if (optionalToeCount > 2) throw new Error("observations.optionalToeCount must not exceed 2");
  const referenceHeight = finiteF32(observations.referenceHeight, "observations.referenceHeight");

  if (jointCount !== source.joints.length) {
    throw new Error("observations.jointCount does not match the humanoid source");
  }
  if (mappedBoneCount !== source.bindings.length) {
    throw new Error("observations.mappedBoneCount does not match the humanoid source");
  }
  if (helperJointCount !== jointCount - mappedBoneCount) {
    throw new Error("observations.helperJointCount does not match joint/mapping counts");
  }
  if (socketCount !== source.sockets.length) {
    throw new Error("observations.socketCount does not match the humanoid source");
  }
  if (rootNode >= jointCount || hipsNode >= jointCount) {
    throw new Error("observations root/hips nodes must reference source joints");
  }
  if (referenceHeight !== source.referenceHeight) {
    throw new Error("observations.referenceHeight does not match the humanoid source");
  }

  return {
    jointCount,
    mappedBoneCount,
    helperJointCount,
    socketCount,
    rootNode,
    hipsNode,
    optionalToeCount,
    referenceHeight,
    semanticHierarchyValid: assertTrue(
      observations.semanticHierarchyValid,
      "observations.semanticHierarchyValid",
    ),
    rootHipsSeparated: assertTrue(
      observations.rootHipsSeparated,
      "observations.rootHipsSeparated",
    ),
    standardSocketsPresent: assertTrue(
      observations.standardSocketsPresent,
      "observations.standardSocketsPresent",
    ),
  };
}

async function processorIdentity(root, processorValue) {
  return resolveExternalProcessorIdentity(root, processorValue, {
    operationId: OPERATION_ID,
    processorId: PROCESSOR_ID,
    protocol: PROCESSOR_PROTOCOL,
    codec: PROCESSOR_CODEC,
  });
}

export async function createHumanoidValidateOperationBuildIdentity(
  root,
  invocation,
  processorValue,
) {
  const parameters = normalizeParameters(invocation.parameters);
  const inputs = { source: invocation.inputs.source };
  const identity = await processorIdentity(root, processorValue);
  return createAssetOperationBuildIdentity({
    operation: HUMANOID_VALIDATE_OPERATION,
    implementation: identity.implementation,
    parameters,
    inputs,
  });
}

export async function executeHumanoidValidateOperation(root, invocation, processorValue) {
  const parameters = normalizeParameters(invocation.parameters);
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseHumanoidDocument(sourceBytes, `${OPERATION_ID} source humanoid`);
  const identity = await processorIdentity(root, processorValue);
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "humanoid.json",
    request: {
      schemaVersion: 1,
      operation: OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters,
    },
  });
  const parsedOutput = parseHumanoidDocument(
    result.bytes,
    `${OPERATION_ID} processor output`,
  );
  validateOutput(parsedSource, parsedOutput);
  const observations = normalizeObservations(result.observations, parsedSource);
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "humanoid-rig",
    mediaType: THREE_D_HUMANOID_MEDIA_TYPE,
    metadata: {
      humanoidSchemaVersion: 1,
      jointCount: observations.jointCount,
      mappedBoneCount: observations.mappedBoneCount,
      socketCount: observations.socketCount,
      optionalToeCount: observations.optionalToeCount,
      referenceHeight: observations.referenceHeight,
    },
  });
  return normalizeAssetOperationResult(HUMANOID_VALIDATE_OPERATION, {
    outputs: { output: stored.asset },
    observations,
    evidence: {
      implementation: identity.implementation,
      changed: stored.changed,
    },
  });
}
