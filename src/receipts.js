import { canonicalJson } from "./canonical.js";
import { sha256Text } from "./hash.js";
import { parseGenerationReceipt as parseGenerationReceiptV1 } from "./schema.js";

const V2_KEYS = new Set([
  "schemaVersion",
  "assetId",
  "spec",
  "tool",
  "generator",
  "randomness",
  "inputs",
  "models",
  "parameters",
  "parametersSha256",
  "observations",
  "environment",
  "output",
  "reproducibility",
]);
const GENERATOR_KINDS = new Set(["procedural", "model", "utility"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} contains unsupported value type '${typeof value}'`);
}

function parseGenerationReceiptV2(value) {
  if (!isObject(value)) throw new Error("receipt must be an object");
  for (const key of Object.keys(value)) {
    if (!V2_KEYS.has(key)) throw new Error(`receipt contains unknown field '${key}'`);
  }
  for (const key of V2_KEYS) {
    if (!(key in value)) throw new Error(`receipt.${key} is required`);
  }
  if (value.schemaVersion !== 2) throw new Error("receipt schemaVersion must be 2");

  if (!isObject(value.generator)) throw new Error("receipt.generator must be an object");
  const generatorKeys = new Set(["id", "version", "kind"]);
  for (const key of Object.keys(value.generator)) {
    if (!generatorKeys.has(key)) throw new Error(`receipt.generator contains unknown field '${key}'`);
  }
  for (const key of generatorKeys) {
    if (!(key in value.generator)) throw new Error(`receipt.generator.${key} is required`);
  }
  if (!GENERATOR_KINDS.has(value.generator.kind)) {
    throw new Error("receipt.generator.kind is invalid");
  }

  if (!isObject(value.parameters)) throw new Error("receipt.parameters must be an object");
  if (!isObject(value.observations)) throw new Error("receipt.observations must be an object");
  assertJsonValue(value.parameters, "receipt.parameters");
  assertJsonValue(value.observations, "receipt.observations");

  const v1Projection = {
    ...value,
    schemaVersion: 1,
    generator: {
      id: value.generator.id,
      version: value.generator.version,
    },
  };
  delete v1Projection.parameters;
  delete v1Projection.observations;
  const base = parseGenerationReceiptV1(v1Projection);

  const actualParametersSha256 = sha256Text(canonicalJson(value.parameters));
  if (actualParametersSha256 !== base.parametersSha256) {
    throw new Error("receipt.parametersSha256 does not match receipt.parameters");
  }

  return {
    ...base,
    schemaVersion: 2,
    generator: {
      ...base.generator,
      kind: value.generator.kind,
    },
    parameters: value.parameters,
    observations: value.observations,
  };
}

export function parseGenerationReceipt(value) {
  if (!isObject(value)) throw new Error("receipt must be an object");
  if (value.schemaVersion === 1) return parseGenerationReceiptV1(value);
  if (value.schemaVersion === 2) return parseGenerationReceiptV2(value);
  throw new Error("receipt schemaVersion must be 1 or 2");
}
