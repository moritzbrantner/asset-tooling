import path from "node:path";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson, stablePrettyJson } from "./canonical.js";
import { sha256Bytes, sha256Text } from "./hash.js";

const CACHE_ROOT = ".asset-tooling/cache";
const CACHE_VERSION_ROOT = `${CACHE_ROOT}/v1`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cachePath(root, portablePath) {
  return path.join(root, ...portablePath.split("/"));
}

function isReservedCachePath(portablePath) {
  return portablePath === CACHE_ROOT || portablePath.startsWith(`${CACHE_ROOT}/`);
}

function assertPathOutsideCache(portablePath, description) {
  if (isReservedCachePath(portablePath)) {
    throw new Error(`${description} must not use reserved asset-tooling cache path '${CACHE_ROOT}'`);
  }
}

export function assertGenerationCachePaths(spec, receiptPath) {
  assertPathOutsideCache(spec.output.path, "output path");
  if (receiptPath !== undefined) assertPathOutsideCache(receiptPath, "receipt path");
  for (const [name, input] of Object.entries(spec.inputs)) {
    assertPathOutsideCache(input.path, `input '${name}' path`);
  }
  for (const [name, model] of Object.entries(spec.models)) {
    assertPathOutsideCache(model.path, `model '${name}' path`);
  }
}

async function assertNoSymbolicLinks(root, portablePath) {
  let prefix = root;
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new Error(`generation cache path '${portablePath}' must not contain symbolic links`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export function generationCacheIdentity({ specSha256, tool, generator, environmentSha256 }) {
  return {
    schemaVersion: 1,
    specSha256,
    tool,
    generator,
    environmentSha256,
  };
}

export function generationCacheKey(identity) {
  return sha256Text(canonicalJson(identity));
}

function buildIndexPortablePath(key) {
  return `${CACHE_VERSION_ROOT}/builds/${key}.json`;
}

function blobPortablePath(outputSha256) {
  return `${CACHE_VERSION_ROOT}/blobs/${outputSha256}`;
}

function parseIndex(value, expectedKey, expectedIdentity) {
  if (!isObject(value)) throw new Error("generation cache index must be an object");
  const allowed = new Set(["schemaVersion", "key", "identity", "outputSha256", "observations"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`generation cache index contains unknown field '${key}'`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`generation cache index is missing '${key}'`);
  }
  if (value.schemaVersion !== 1) throw new Error("generation cache index schemaVersion must be 1");
  if (value.key !== expectedKey) throw new Error("generation cache index key does not match its build identity");
  if (!SHA256_PATTERN.test(value.outputSha256)) {
    throw new Error("generation cache outputSha256 must be a lowercase SHA-256 digest");
  }
  if (canonicalJson(value.identity) !== canonicalJson(expectedIdentity)) {
    throw new Error("generation cache index identity does not match the current build identity");
  }
  if (!isObject(value.observations)) {
    throw new Error("generation cache observations must be an object");
  }
  return value;
}

export async function readGenerationCache(root, identity) {
  const key = generationCacheKey(identity);
  const indexPortablePath = buildIndexPortablePath(key);
  await assertNoSymbolicLinks(root, indexPortablePath);

  let rawIndex;
  try {
    rawIndex = await readFile(cachePath(root, indexPortablePath), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "miss", key };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawIndex);
  } catch (error) {
    throw new Error(`generation cache index '${key}' is not valid JSON`);
  }
  const index = parseIndex(parsed, key, identity);
  const blobPath = blobPortablePath(index.outputSha256);
  await assertNoSymbolicLinks(root, blobPath);

  let bytes;
  try {
    bytes = await readFile(cachePath(root, blobPath));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`generation cache blob '${index.outputSha256}' is missing`);
    }
    throw error;
  }
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== index.outputSha256) {
    throw new Error(
      `generation cache blob hash mismatch: expected ${index.outputSha256}, got ${actualSha256}`,
    );
  }

  return {
    status: "hit",
    key,
    bytes,
    observations: index.observations,
    outputSha256: index.outputSha256,
  };
}

export async function writeGenerationCache(root, identity, generated) {
  const key = generationCacheKey(identity);
  const outputSha256 = sha256Bytes(generated.bytes);
  const blobPath = blobPortablePath(outputSha256);
  const indexPath = buildIndexPortablePath(key);
  await assertNoSymbolicLinks(root, blobPath);
  await assertNoSymbolicLinks(root, indexPath);

  const blobAbsolutePath = cachePath(root, blobPath);
  await mkdir(path.dirname(blobAbsolutePath), { recursive: true });
  let blobMatches = false;
  try {
    blobMatches = sha256Bytes(await readFile(blobAbsolutePath)) === outputSha256;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (!blobMatches) await writeFile(blobAbsolutePath, generated.bytes);

  const index = {
    schemaVersion: 1,
    key,
    identity,
    outputSha256,
    observations: generated.observations,
  };
  const indexAbsolutePath = cachePath(root, indexPath);
  await mkdir(path.dirname(indexAbsolutePath), { recursive: true });
  await writeFile(indexAbsolutePath, stablePrettyJson(index), "utf8");

  return { key, outputSha256 };
}
