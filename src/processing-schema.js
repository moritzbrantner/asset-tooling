import path from "node:path";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { sha256Text } from "./hash.js";
import { assertPortableRelativePath, resolveSpecPath } from "./schema.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function assertSha256(value, location) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${location} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
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
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${location}.${key}`);
    return;
  }
  throw new Error(`${location} contains unsupported JSON value type '${typeof value}'`);
}

export function parseProcessingSpec(value) {
  const spec = assertObject(value, "processing spec");
  assertExactKeys(
    spec,
    new Set(["schemaVersion", "assetId", "processor", "input", "parameters", "output", "reproducibility"]),
    "processing spec",
  );
  if (spec.schemaVersion !== 1) throw new Error("processing spec schemaVersion must be 1");

  const processor = assertObject(spec.processor, "processor");
  assertExactKeys(processor, new Set(["id", "version"]), "processor");
  const input = assertObject(spec.input, "input");
  assertExactKeys(input, new Set(["path", "sha256", "mediaType"]), "input");
  const output = assertObject(spec.output, "output");
  assertExactKeys(output, new Set(["path", "mediaType"]), "output");
  const reproducibility = assertObject(spec.reproducibility, "reproducibility");
  assertExactKeys(reproducibility, new Set(["expected"]), "reproducibility");
  if (!["exact", "approximate"].includes(reproducibility.expected)) {
    throw new Error("reproducibility.expected must be 'exact' or 'approximate'");
  }
  const parameters = assertObject(spec.parameters, "parameters");
  assertJsonValue(parameters, "parameters");

  return {
    schemaVersion: 1,
    assetId: assertString(spec.assetId, "assetId"),
    processor: {
      id: assertString(processor.id, "processor.id"),
      version: assertString(processor.version, "processor.version"),
    },
    input: {
      path: assertPortableRelativePath(input.path, "input.path"),
      sha256: assertSha256(input.sha256, "input.sha256"),
      mediaType: assertString(input.mediaType, "input.mediaType"),
    },
    parameters,
    output: {
      path: assertPortableRelativePath(output.path, "output.path"),
      mediaType: assertString(output.mediaType, "output.mediaType"),
    },
    reproducibility: { expected: reproducibility.expected },
  };
}

export async function readProcessingSpec(specPath) {
  const absolutePath = path.resolve(specPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  const spec = parseProcessingSpec(parsed);
  const canonical = canonicalJson(spec);
  return {
    spec,
    absolutePath,
    root: path.dirname(absolutePath),
    canonical,
    sha256: sha256Text(canonical),
  };
}

export function resolveProcessingPath(root, portablePath) {
  return resolveSpecPath(root, portablePath);
}
