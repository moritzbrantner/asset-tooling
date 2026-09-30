import path from "node:path";
import { storeAssetObject } from "./asset-store.js";
import { stablePrettyJson } from "./canonical.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { THREE_D_ANIMATION_MEDIA_TYPE } from "./animation-processing-operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_NODE_INDEX = 1_000_000;
const SQRT_HALF_F32 = Math.fround(Math.SQRT1_2);
const YAW_DEGREES = Object.freeze([-180, -90, 90, 180]);

const animationOutput = {
  id: "output",
  label: "Generated animation",
  assetKinds: ["animation"],
  mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE],
};
const vec3Schema = {
  type: "array",
  minItems: 3,
  maxItems: 3,
  items: { type: "number" },
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "animation.procedural.translation",
    version: VERSION,
    label: "Generate translation animation",
    description:
      "Generate one deterministic local-space translation channel with explicit start and end values using the three-d-animation JSON transport contract.",
    category: "procedural.animation",
    inputs: [],
    outputs: [animationOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["node", "durationSeconds", "from", "to"],
      properties: {
        node: { type: "integer", minimum: 0, maximum: MAX_NODE_INDEX },
        durationSeconds: { type: "number", exclusiveMinimum: 0 },
        from: vec3Schema,
        to: vec3Schema,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "animation.procedural.uniform-scale",
    version: VERSION,
    label: "Generate uniform scale animation",
    description:
      "Generate one deterministic local-space uniform-scale channel with explicit positive start and end scales using the three-d-animation JSON transport contract.",
    category: "procedural.animation",
    inputs: [],
    outputs: [animationOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["node", "durationSeconds", "fromScale", "toScale"],
      properties: {
        node: { type: "integer", minimum: 0, maximum: MAX_NODE_INDEX },
        durationSeconds: { type: "number", exclusiveMinimum: 0 },
        fromScale: { type: "number", exclusiveMinimum: 0 },
        toScale: { type: "number", exclusiveMinimum: 0 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "animation.procedural.yaw",
    version: VERSION,
    label: "Generate yaw animation",
    description:
      "Generate one deterministic local-space Y-axis quaternion rotation from identity to an explicit quarter- or half-turn using the three-d-animation JSON transport contract.",
    category: "procedural.animation",
    inputs: [],
    outputs: [animationOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["node", "durationSeconds", "yawDegrees"],
      properties: {
        node: { type: "integer", minimum: 0, maximum: MAX_NODE_INDEX },
        durationSeconds: { type: "number", exclusiveMinimum: 0 },
        yawDegrees: { type: "integer", enum: [...YAW_DEGREES] },
      },
    },
  },
]);

export const PROCEDURAL_TRANSLATION_ANIMATION_OPERATION = OPERATION_REGISTRY.get(
  "animation.procedural.translation",
  VERSION,
);
export const PROCEDURAL_UNIFORM_SCALE_ANIMATION_OPERATION = OPERATION_REGISTRY.get(
  "animation.procedural.uniform-scale",
  VERSION,
);
export const PROCEDURAL_YAW_ANIMATION_OPERATION = OPERATION_REGISTRY.get(
  "animation.procedural.yaw",
  VERSION,
);
export const PROCEDURAL_ANIMATION_OPERATIONS = OPERATION_REGISTRY.list();

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, location) {
  const object = plainObject(value, location);
  const expected = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
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
  if (!Number.isFinite(normalized)) throw new Error(`${location} must be representable as a finite f32`);
  return Object.is(normalized, -0) ? 0 : normalized;
}

function positiveF32(value, location) {
  const normalized = finiteF32(value, location);
  if (normalized <= 0) throw new Error(`${location} must be positive after f32 normalization`);
  return normalized;
}

function nodeIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_NODE_INDEX) {
    throw new Error(`parameters.node must be an integer in 0..${MAX_NODE_INDEX}`);
  }
  return value;
}

function vec3(value, location, { positive = false } = {}) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${location} must contain exactly three numbers`);
  }
  return value.map((component, index) =>
    positive
      ? positiveF32(component, `${location}[${index}]`)
      : finiteF32(component, `${location}[${index}]`),
  );
}

function normalizeParameters(operation, value) {
  if (operation.id === "animation.procedural.translation") {
    const parameters = exactKeys(
      value,
      ["node", "durationSeconds", "from", "to"],
      `${operation.id} parameters`,
    );
    return {
      node: nodeIndex(parameters.node),
      durationSeconds: positiveF32(parameters.durationSeconds, "parameters.durationSeconds"),
      from: vec3(parameters.from, "parameters.from"),
      to: vec3(parameters.to, "parameters.to"),
    };
  }
  if (operation.id === "animation.procedural.uniform-scale") {
    const parameters = exactKeys(
      value,
      ["node", "durationSeconds", "fromScale", "toScale"],
      `${operation.id} parameters`,
    );
    return {
      node: nodeIndex(parameters.node),
      durationSeconds: positiveF32(parameters.durationSeconds, "parameters.durationSeconds"),
      fromScale: positiveF32(parameters.fromScale, "parameters.fromScale"),
      toScale: positiveF32(parameters.toScale, "parameters.toScale"),
    };
  }
  if (operation.id === "animation.procedural.yaw") {
    const parameters = exactKeys(
      value,
      ["node", "durationSeconds", "yawDegrees"],
      `${operation.id} parameters`,
    );
    if (!YAW_DEGREES.includes(parameters.yawDegrees)) {
      throw new Error(`parameters.yawDegrees must be one of ${YAW_DEGREES.join(", ")}`);
    }
    return {
      node: nodeIndex(parameters.node),
      durationSeconds: positiveF32(parameters.durationSeconds, "parameters.durationSeconds"),
      yawDegrees: parameters.yawDegrees,
    };
  }
  throw new Error(`unsupported procedural animation operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural animation operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const algorithms = {
    "animation.procedural.translation": "three-d-animation-two-key-local-translation-f32-v1",
    "animation.procedural.uniform-scale": "three-d-animation-two-key-local-uniform-scale-f32-v1",
    "animation.procedural.yaw": "three-d-animation-two-key-local-yaw-fixed-quaternion-f32-v1",
  };
  return algorithms[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    randomness: "none",
    codec: "three-d-animation-json-v1",
    transformSpace: "local",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  assertRoot(root);
  return createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
}

function yawQuaternion(yawDegrees) {
  if (yawDegrees === -180) return [0, -1, 0, 0];
  if (yawDegrees === -90) return [0, -SQRT_HALF_F32, 0, SQRT_HALF_F32];
  if (yawDegrees === 90) return [0, SQRT_HALF_F32, 0, SQRT_HALF_F32];
  if (yawDegrees === 180) return [0, 1, 0, 0];
  throw new Error(`unsupported yaw '${yawDegrees}'`);
}

function documentFor(operation, parameters) {
  const end = parameters.durationSeconds;
  if (operation.id === "animation.procedural.translation") {
    return {
      schemaVersion: 1,
      channels: [
        {
          kind: "translation",
          node: parameters.node,
          keyframes: [
            { time: 0, value: parameters.from },
            { time: end, value: parameters.to },
          ],
        },
      ],
    };
  }
  if (operation.id === "animation.procedural.uniform-scale") {
    const from = [parameters.fromScale, parameters.fromScale, parameters.fromScale];
    const to = [parameters.toScale, parameters.toScale, parameters.toScale];
    return {
      schemaVersion: 1,
      channels: [
        {
          kind: "scale",
          node: parameters.node,
          keyframes: [
            { time: 0, value: from },
            { time: end, value: to },
          ],
        },
      ],
    };
  }
  if (operation.id === "animation.procedural.yaw") {
    return {
      schemaVersion: 1,
      channels: [
        {
          kind: "rotation",
          node: parameters.node,
          keyframes: [
            { time: 0, value: [0, 0, 0, 1] },
            { time: end, value: yawQuaternion(parameters.yawDegrees) },
          ],
        },
      ],
    };
  }
  throw new Error(`unsupported procedural animation operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const assetRoot = assertRoot(root);
  const document = documentFor(operation, build.parameters);
  const bytes = Buffer.from(stablePrettyJson(document), "utf8");
  const stored = await storeAssetObject(assetRoot, {
    bytes,
    kind: "animation",
    mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
    metadata: {
      animationSchemaVersion: 1,
      channelCount: 1,
      keyframeCount: 2,
      durationSeconds: build.parameters.durationSeconds,
      transformSpace: "local",
      generator: `${operation.id}@${operation.version}`,
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      channelCount: 1,
      keyframeCount: 2,
      durationSeconds: build.parameters.durationSeconds,
      algorithm: build.implementation.algorithm,
      randomness: "none",
      parameters: build.parameters,
    },
  });
}

export async function createProceduralTranslationAnimationOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_TRANSLATION_ANIMATION_OPERATION, parameters, inputs);
}

export async function executeProceduralTranslationAnimationOperation(root, invocation = {}) {
  const build = await createProceduralTranslationAnimationOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_TRANSLATION_ANIMATION_OPERATION, build);
}

export async function createProceduralUniformScaleAnimationOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_UNIFORM_SCALE_ANIMATION_OPERATION, parameters, inputs);
}

export async function executeProceduralUniformScaleAnimationOperation(root, invocation = {}) {
  const build = await createProceduralUniformScaleAnimationOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_UNIFORM_SCALE_ANIMATION_OPERATION, build);
}

export async function createProceduralYawAnimationOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_YAW_ANIMATION_OPERATION, parameters, inputs);
}

export async function executeProceduralYawAnimationOperation(root, invocation = {}) {
  const build = await createProceduralYawAnimationOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_YAW_ANIMATION_OPERATION, build);
}
