import path from "node:path";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { sha256Text } from "./hash.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value, location) {
  if (!isObject(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${location} contains unknown field '${key}'`);
    }
  }
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.trim() === "") {
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

export function assertPortableRelativePath(value, location) {
  const candidate = assertNonEmptyString(value, location);
  if (candidate.includes("\\")) {
    throw new Error(`${location} must use '/' separators`);
  }
  if (path.posix.isAbsolute(candidate)) {
    throw new Error(`${location} must be relative`);
  }

  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${location} must not contain empty, '.' or '..' segments`);
  }
  return candidate;
}

function parseGenerator(value) {
  const generator = assertObject(value, "generator");
  assertExactKeys(generator, new Set(["id", "version"]), "generator");
  return {
    id: assertNonEmptyString(generator.id, "generator.id"),
    version: assertNonEmptyString(generator.version, "generator.version"),
  };
}

function parseRandomness(value) {
  const randomness = assertObject(value, "randomness");
  if (randomness.mode === "none") {
    assertExactKeys(randomness, new Set(["mode"]), "randomness");
    return { mode: "none" };
  }
  if (randomness.mode === "seeded") {
    assertExactKeys(randomness, new Set(["mode", "seed"]), "randomness");
    if (typeof randomness.seed !== "string" || !DECIMAL_SEED_PATTERN.test(randomness.seed)) {
      throw new Error("randomness.seed must be a non-negative decimal integer encoded as a string");
    }
    return { mode: "seeded", seed: randomness.seed };
  }
  throw new Error("randomness.mode must be 'none' or 'seeded'");
}

function parseArtifactMap(value, location, withId) {
  const map = assertObject(value, location);
  const result = {};
  for (const name of Object.keys(map).sort()) {
    assertNonEmptyString(name, `${location} key`);
    const artifact = assertObject(map[name], `${location}.${name}`);
    const keys = withId ? new Set(["id", "path", "sha256"]) : new Set(["path", "sha256"]);
    assertExactKeys(artifact, keys, `${location}.${name}`);
    result[name] = {
      ...(withId ? { id: assertNonEmptyString(artifact.id, `${location}.${name}.id`) } : {}),
      path: assertPortableRelativePath(artifact.path, `${location}.${name}.path`),
      sha256: assertSha256(artifact.sha256, `${location}.${name}.sha256`),
    };
  }
  return result;
}

function parseOutput(value) {
  const output = assertObject(value, "output");
  assertExactKeys(output, new Set(["path"]), "output");
  return { path: assertPortableRelativePath(output.path, "output.path") };
}

function parseReproducibility(value) {
  const reproducibility = assertObject(value, "reproducibility");
  assertExactKeys(reproducibility, new Set(["expected"]), "reproducibility");
  if (reproducibility.expected !== "exact" && reproducibility.expected !== "approximate") {
    throw new Error("reproducibility.expected must be 'exact' or 'approximate'");
  }
  return { expected: reproducibility.expected };
}

function assertJsonValue(value, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${location} contains a non-finite number`);
    }
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
  throw new Error(`${location} contains unsupported JSON value type '${typeof value}'`);
}

export function parseAssetSpec(value) {
  const spec = assertObject(value, "asset spec");
  assertExactKeys(
    spec,
    new Set([
      "schemaVersion",
      "assetId",
      "generator",
      "randomness",
      "inputs",
      "models",
      "parameters",
      "output",
      "reproducibility",
    ]),
    "asset spec",
  );

  if (spec.schemaVersion !== 1) {
    throw new Error("asset spec schemaVersion must be 1");
  }

  const parameters = assertObject(spec.parameters, "parameters");
  assertJsonValue(parameters, "parameters");

  return {
    schemaVersion: 1,
    assetId: assertNonEmptyString(spec.assetId, "assetId"),
    generator: parseGenerator(spec.generator),
    randomness: parseRandomness(spec.randomness),
    inputs: parseArtifactMap(spec.inputs, "inputs", false),
    models: parseArtifactMap(spec.models, "models", true),
    parameters,
    output: parseOutput(spec.output),
    reproducibility: parseReproducibility(spec.reproducibility),
  };
}

export async function readAssetSpec(specPath) {
  const absolutePath = path.resolve(specPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  const spec = parseAssetSpec(parsed);
  const canonical = canonicalJson(spec);
  return {
    spec,
    absolutePath,
    root: path.dirname(absolutePath),
    canonical,
    sha256: sha256Text(canonical),
  };
}

export function resolveSpecPath(root, portablePath) {
  return path.join(root, ...portablePath.split("/"));
}
