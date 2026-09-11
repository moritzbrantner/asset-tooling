import path from "node:path";
import { canonicalJson } from "./canonical.js";
import {
  assetOperationKey,
  createAssetOperationDescriptor,
  normalizeAssetOperationResult,
} from "./operations.js";

export const ASSET_OPERATION_WORKFLOW_KIND = "asset.operation";

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function canonicalClone(value, location) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new Error(`${location} must contain only deterministic JSON values: ${error.message}`);
  }
}

function assertParameters(value) {
  const parameters = canonicalClone(value ?? {}, "asset workflow operation parameters");
  if (!isPlainObject(parameters)) {
    throw new Error("asset workflow operation parameters must be a plain object");
  }
  return parameters;
}

function literalUnion(values) {
  if (values.length === 0) return { kind: "string" };
  if (values.length === 1) return { kind: "literal", value: values[0] };
  return {
    kind: "union",
    types: values.map((value) => ({ kind: "literal", value })),
  };
}

function mediaTypeWorkflowType(mediaTypes) {
  if (mediaTypes.length === 0 || mediaTypes.some((mediaType) => mediaType.endsWith("/*"))) {
    return { kind: "string" };
  }
  return literalUnion(mediaTypes);
}

function assetRefWorkflowType(port) {
  const assetRefType = {
    kind: "object",
    properties: {
      schemaVersion: { type: { kind: "literal", value: 1 } },
      kind: { type: literalUnion(port.assetKinds) },
      mediaType: { type: mediaTypeWorkflowType(port.mediaTypes) },
      sha256: { type: { kind: "string" } },
      byteLength: { type: { kind: "number" } },
      metadata: { type: { kind: "object" } },
    },
  };

  return port.cardinality === "single"
    ? assetRefType
    : { kind: "array", element: assetRefType };
}

function workflowCategory(category) {
  const segments = category.split(".").map((segment) =>
    segment
      .split("-")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" "),
  );
  return ["Assets", ...segments].join(" / ");
}

function workflowPort(port) {
  return {
    id: port.id,
    ...(port.label === undefined ? {} : { label: port.label }),
    type: assetRefWorkflowType(port),
    ...(port.required ? {} : { optional: true }),
  };
}

export function createAssetOperationWorkflowNodeTemplate(
  operationValue,
  { parameters: parameterValue = {} } = {},
) {
  const operation = createAssetOperationDescriptor(operationValue);
  const parameters = assertParameters(parameterValue);
  const key = assetOperationKey(operation);

  return {
    id: `asset-operation:${key}`,
    label: operation.label ?? operation.id,
    ...(operation.description === undefined ? {} : { description: operation.description }),
    kind: ASSET_OPERATION_WORKFLOW_KIND,
    category: workflowCategory(operation.category),
    ...(operation.inputs.length === 0
      ? {}
      : { inputs: operation.inputs.map((port) => workflowPort(port)) }),
    ...(operation.outputs.length === 0
      ? {}
      : { outputs: operation.outputs.map((port) => workflowPort(port)) }),
    data: {
      assetOperation: {
        id: operation.id,
        version: operation.version,
        parameters,
      },
    },
  };
}

export function createAssetOperationWorkflowNodeTemplates(operationValues) {
  if (!Array.isArray(operationValues)) {
    throw new Error("asset workflow operation descriptors must be an array");
  }
  return operationValues
    .map((operation) => createAssetOperationWorkflowNodeTemplate(operation))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRegistration(value, index) {
  const registration = assertPlainObject(value, `asset workflow registration[${index}]`);
  assertExactKeys(registration, new Set(["operation", "execute"]), `asset workflow registration[${index}]`);
  const operation = createAssetOperationDescriptor(registration.operation);
  if (typeof registration.execute !== "function") {
    throw new Error(`asset workflow registration[${index}].execute must be a function`);
  }
  return {
    key: assetOperationKey(operation),
    operation,
    execute: registration.execute,
  };
}

function createRegistrationMap(values) {
  if (!Array.isArray(values)) throw new Error("asset workflow registrations must be an array");
  const registrations = new Map();
  values.forEach((value, index) => {
    const registration = normalizeRegistration(value, index);
    if (registrations.has(registration.key)) {
      throw new Error(`asset workflow operation '${registration.key}' is already registered`);
    }
    registrations.set(registration.key, registration);
  });
  return registrations;
}

function operationSelection(node) {
  if (node?.kind !== ASSET_OPERATION_WORKFLOW_KIND) {
    throw new Error(`asset workflow executor only accepts node kind '${ASSET_OPERATION_WORKFLOW_KIND}'`);
  }
  const data = assertPlainObject(node.data, "asset workflow node data");
  const selected = assertPlainObject(data.assetOperation, "asset workflow node data.assetOperation");
  assertExactKeys(
    selected,
    new Set(["id", "version", "parameters"]),
    "asset workflow node data.assetOperation",
  );
  if (typeof selected.id !== "string" || typeof selected.version !== "string") {
    throw new Error("asset workflow operation id and version must be strings");
  }
  return {
    key: assetOperationKey(selected.id, selected.version),
    parameters: assertParameters(selected.parameters),
  };
}

export function createAssetOperationWorkflowExecutor({
  root,
  registrations: registrationValues,
  onOperationResult,
}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("asset workflow root must be an absolute path");
  }
  if (onOperationResult !== undefined && typeof onOperationResult !== "function") {
    throw new Error("asset workflow onOperationResult must be a function when provided");
  }
  const registrations = createRegistrationMap(registrationValues);

  return async function executeAssetWorkflowNode(context) {
    const selection = operationSelection(context.node);
    const registration = registrations.get(selection.key);
    if (!registration) {
      throw new Error(`asset workflow operation '${selection.key}' is not registered`);
    }

    const rawResult = await registration.execute(
      root,
      {
        parameters: selection.parameters,
        inputs: context.inputs ?? {},
      },
      context,
    );
    const result = normalizeAssetOperationResult(registration.operation, rawResult);

    if (onOperationResult) {
      await onOperationResult({
        runId: context.runId,
        nodeId: context.node.id,
        operation: {
          id: registration.operation.id,
          version: registration.operation.version,
        },
        result,
      });
    }

    return { outputs: result.outputs };
  };
}
