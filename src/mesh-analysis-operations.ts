import path from "node:path";
import { resolveAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { inspectObjMesh, validateObjMeshInspection } from "./mesh-analysis.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_BUDGET = 100_000_000;
const sourcePort = {
  id: "source",
  label: "Source OBJ mesh",
  assetKinds: ["mesh"],
  mediaTypes: ["model/obj"],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "mesh.obj.inspect",
    version: VERSION,
    label: "Inspect OBJ mesh",
    description:
      "Measure OBJ topology, bounds, reference coverage, material records, and supported-record coverage without emitting a new asset.",
    category: "mesh.analysis",
    inputs: [sourcePort],
    outputs: [],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "mesh.obj.validate",
    version: VERSION,
    label: "Validate OBJ mesh policy",
    description:
      "Evaluate explicit vertex/triangle, topology, normal, unused-vertex, and unsupported-record policy against a structurally valid OBJ mesh.",
    category: "mesh.analysis",
    inputs: [sourcePort],
    outputs: [],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "maxVertices",
        "maxTriangles",
        "requireTriangles",
        "requireNormals",
        "allowUnusedVertices",
        "rejectUnsupportedRecords",
      ],
      properties: {
        maxVertices: { type: "integer", minimum: 0, maximum: MAX_BUDGET },
        maxTriangles: { type: "integer", minimum: 0, maximum: MAX_BUDGET },
        requireTriangles: { type: "boolean" },
        requireNormals: { type: "boolean" },
        allowUnusedVertices: { type: "boolean" },
        rejectUnsupportedRecords: { type: "boolean" },
      },
    },
  },
]);

export const OBJ_MESH_INSPECT_OPERATION = OPERATION_REGISTRY.get("mesh.obj.inspect", VERSION);
export const OBJ_MESH_VALIDATE_OPERATION = OPERATION_REGISTRY.get("mesh.obj.validate", VERSION);
export const MESH_ANALYSIS_OPERATIONS = OPERATION_REGISTRY.list();

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("mesh analysis operation root must be an absolute path");
  }
  return root;
}

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

function emptyParameters(value, operationId) {
  const parameters = plainObject(value, `${operationId} parameters`);
  if (Object.keys(parameters).length !== 0) throw new Error(`${operationId} parameters must be empty`);
  return {};
}

function integer(value, location) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BUDGET) {
    throw new Error(`${location} must be an integer in 0..${MAX_BUDGET}`);
  }
  return value;
}

function boolean(value, location) {
  if (typeof value !== "boolean") throw new Error(`${location} must be a boolean`);
  return value;
}

function validationPolicy(value) {
  const parameters = plainObject(value, "mesh.obj.validate parameters");
  const keys = new Set([
    "maxVertices",
    "maxTriangles",
    "requireTriangles",
    "requireNormals",
    "allowUnusedVertices",
    "rejectUnsupportedRecords",
  ]);
  for (const key of Object.keys(parameters)) {
    if (!keys.has(key)) throw new Error(`mesh.obj.validate parameters contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(parameters, key)) throw new Error(`mesh.obj.validate parameters is missing '${key}'`);
  }
  return {
    maxVertices: integer(parameters.maxVertices, "parameters.maxVertices"),
    maxTriangles: integer(parameters.maxTriangles, "parameters.maxTriangles"),
    requireTriangles: boolean(parameters.requireTriangles, "parameters.requireTriangles"),
    requireNormals: boolean(parameters.requireNormals, "parameters.requireNormals"),
    allowUnusedVertices: boolean(parameters.allowUnusedVertices, "parameters.allowUnusedVertices"),
    rejectUnsupportedRecords: boolean(parameters.rejectUnsupportedRecords, "parameters.rejectUnsupportedRecords"),
  };
}

function normalizeParameters(operation, value) {
  return operation.id === "mesh.obj.inspect"
    ? emptyParameters(value, operation.id)
    : validationPolicy(value);
}

function algorithm(operation) {
  return operation.id === "mesh.obj.inspect"
    ? "obj-structural-inspection-v1"
    : "obj-structural-policy-validation-v1";
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    format: "obj",
    tool: await captureToolIdentity(),
  };
}

async function readAndInspect(root, source) {
  return inspectObjMesh(await resolveAssetObject(root, source));
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
  await readAndInspect(assetRoot, build.inputs.source);
  return build;
}

async function execute(root, operation, build) {
  const inspection = await readAndInspect(assertRoot(root), build.inputs.source);
  const common = {
    ...inspection,
    sourceSha256: build.inputs.source.sha256,
    sourceByteLength: build.inputs.source.byteLength,
    algorithm: build.implementation.algorithm,
  };
  const observations = operation.id === "mesh.obj.inspect"
    ? common
    : {
        ...common,
        policy: build.parameters,
        ...validateObjMeshInspection(inspection, build.parameters),
      };
  return normalizeAssetOperationResult(operation, { outputs: {}, observations });
}

export async function createObjMeshInspectOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, OBJ_MESH_INSPECT_OPERATION, parameters, inputs);
}

export async function executeObjMeshInspectOperation(root, invocation = {}) {
  const build = await createObjMeshInspectOperationBuildIdentity(root, invocation);
  return execute(root, OBJ_MESH_INSPECT_OPERATION, build);
}

export async function createObjMeshValidateOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, OBJ_MESH_VALIDATE_OPERATION, parameters, inputs);
}

export async function executeObjMeshValidateOperation(root, invocation = {}) {
  const build = await createObjMeshValidateOperationBuildIdentity(root, invocation);
  return execute(root, OBJ_MESH_VALIDATE_OPERATION, build);
}
