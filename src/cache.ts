import path from "node:path";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { GenerationObservations, ReceiptGenerator } from "./backend-contract.js";
import { canonicalJson, stablePrettyJson } from "./canonical.js";
import { sha256Bytes, sha256Text } from "./hash.js";

const CACHE_ROOT = ".asset-tooling/cache";
const CACHE_VERSION_ROOT = `${CACHE_ROOT}/v1`;
const OBJECT_ROOT = ".asset-tooling/objects";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type PlainObject = Record<string, unknown>;
export type GenerationCacheObservations = GenerationObservations;

export interface GenerationCacheArtifactPath {
  path: string;
}

export interface GenerationCachePathSpec {
  output: GenerationCacheArtifactPath;
  inputs: Record<string, GenerationCacheArtifactPath>;
  models: Record<string, GenerationCacheArtifactPath>;
}

export interface GenerationCacheIdentityInput {
  specSha256: string;
  tool: unknown;
  generator: ReceiptGenerator;
  environmentSha256: string;
}

export interface GenerationCacheIdentity extends GenerationCacheIdentityInput {
  schemaVersion: 1;
}

export interface GenerationCacheIndex {
  schemaVersion: 1;
  key: string;
  identity: unknown;
  outputSha256: string;
  observations: GenerationCacheObservations;
}

export interface GenerationCacheMiss {
  status: "miss";
  key: string;
}

export interface GenerationCacheHit {
  status: "hit";
  key: string;
  bytes: Buffer;
  observations: GenerationCacheObservations;
  outputSha256: string;
}

export type GenerationCacheReadResult = GenerationCacheMiss | GenerationCacheHit;

export interface GeneratedCacheValue {
  bytes: Uint8Array;
  observations: GenerationCacheObservations;
}

export interface GenerationCacheWriteResult {
  key: string;
  outputSha256: string;
}

function isObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function cachePath(root: string, portablePath: string): string {
  return path.join(root, ...portablePath.split("/"));
}

function isReservedPath(portablePath: string, reservedRoot: string): boolean {
  return portablePath === reservedRoot || portablePath.startsWith(`${reservedRoot}/`);
}

function assertPathOutsideToolStorage(portablePath: string, description: string): void {
  if (isReservedPath(portablePath, CACHE_ROOT)) {
    throw new Error(`${description} must not use reserved asset-tooling cache path '${CACHE_ROOT}'`);
  }
  if (isReservedPath(portablePath, OBJECT_ROOT)) {
    throw new Error(`${description} must not use reserved asset-tooling object path '${OBJECT_ROOT}'`);
  }
}

export function assertGenerationCachePaths(
  spec: GenerationCachePathSpec,
  receiptPath?: string,
): void {
  assertPathOutsideToolStorage(spec.output.path, "output path");
  if (receiptPath !== undefined) assertPathOutsideToolStorage(receiptPath, "receipt path");
  for (const [name, input] of Object.entries(spec.inputs)) {
    assertPathOutsideToolStorage(input.path, `input '${name}' path`);
  }
  for (const [name, model] of Object.entries(spec.models)) {
    assertPathOutsideToolStorage(model.path, `model '${name}' path`);
  }
}

async function assertNoSymbolicLinks(root: string, portablePath: string): Promise<void> {
  let prefix = root;
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new Error(`generation cache path '${portablePath}' must not contain symbolic links`);
      }
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

export function generationCacheIdentity({
  specSha256,
  tool,
  generator,
  environmentSha256,
}: GenerationCacheIdentityInput): GenerationCacheIdentity {
  return {
    schemaVersion: 1,
    specSha256,
    tool,
    generator,
    environmentSha256,
  };
}

export function generationCacheKey(identity: GenerationCacheIdentity): string {
  return sha256Text(canonicalJson(identity));
}

function buildIndexPortablePath(key: string): string {
  return `${CACHE_VERSION_ROOT}/builds/${key}.json`;
}

function blobPortablePath(outputSha256: string): string {
  return `${CACHE_VERSION_ROOT}/blobs/${outputSha256}`;
}

function parseIndex(
  value: unknown,
  expectedKey: string,
  expectedIdentity: GenerationCacheIdentity,
): GenerationCacheIndex {
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
  if (typeof value.outputSha256 !== "string" || !SHA256_PATTERN.test(value.outputSha256)) {
    throw new Error("generation cache outputSha256 must be a lowercase SHA-256 digest");
  }
  if (canonicalJson(value.identity) !== canonicalJson(expectedIdentity)) {
    throw new Error("generation cache index identity does not match the current build identity");
  }
  if (!isObject(value.observations)) {
    throw new Error("generation cache observations must be an object");
  }
  return {
    schemaVersion: 1,
    key: expectedKey,
    identity: value.identity,
    outputSha256: value.outputSha256,
    observations: value.observations as GenerationCacheObservations,
  };
}

export async function readGenerationCache(
  root: string,
  identity: GenerationCacheIdentity,
): Promise<GenerationCacheReadResult> {
  const key = generationCacheKey(identity);
  const indexPortablePath = buildIndexPortablePath(key);
  await assertNoSymbolicLinks(root, indexPortablePath);

  let rawIndex: string;
  try {
    rawIndex = await readFile(cachePath(root, indexPortablePath), "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) return { status: "miss", key };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawIndex) as unknown;
  } catch {
    throw new Error(`generation cache index '${key}' is not valid JSON`);
  }
  const index = parseIndex(parsed, key, identity);
  const blobPath = blobPortablePath(index.outputSha256);
  await assertNoSymbolicLinks(root, blobPath);

  let bytes: Buffer;
  try {
    bytes = await readFile(cachePath(root, blobPath));
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
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

export async function writeGenerationCache(
  root: string,
  identity: GenerationCacheIdentity,
  generated: GeneratedCacheValue,
): Promise<GenerationCacheWriteResult> {
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
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  if (!blobMatches) await writeFile(blobAbsolutePath, generated.bytes);

  const index: GenerationCacheIndex = {
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

export interface OperationResultCacheEntry {
  schemaVersion: 1;
  key: string;
  buildIdentity: unknown;
  resultSha256: string;
  result: unknown;
}

export interface OperationResultCacheMiss {
  status: "miss";
  key: string;
}

export interface OperationResultCacheHit {
  status: "hit";
  key: string;
  /** The recorded result. Callers must still normalize it and verify every output object. */
  result: unknown;
}

export type OperationResultCacheReadResult = OperationResultCacheMiss | OperationResultCacheHit;

function operationResultIndexPortablePath(key: string): string {
  if (!SHA256_PATTERN.test(key)) {
    throw new Error("operation result cache key must be a lowercase SHA-256 digest");
  }
  return `${CACHE_VERSION_ROOT}/operations/${key}.json`;
}

function parseOperationResultEntry(value: unknown, expectedKey: string, expectedIdentity: unknown): unknown {
  if (!isObject(value)) throw new Error("operation result cache entry must be an object");
  const allowed = new Set(["schemaVersion", "key", "buildIdentity", "resultSha256", "result"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`operation result cache entry contains unknown field '${key}'`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`operation result cache entry is missing '${key}'`);
  }
  if (value.schemaVersion !== 1) throw new Error("operation result cache entry schemaVersion must be 1");
  if (value.key !== expectedKey) {
    throw new Error("operation result cache entry key does not match its build identity");
  }
  if (canonicalJson(value.buildIdentity) !== canonicalJson(expectedIdentity)) {
    throw new Error("operation result cache entry build identity does not match the current build identity");
  }
  if (typeof value.resultSha256 !== "string" || !SHA256_PATTERN.test(value.resultSha256)) {
    throw new Error("operation result cache entry resultSha256 must be a lowercase SHA-256 digest");
  }
  if (!isObject(value.result)) throw new Error("operation result cache entry result must be an object");
  const actual = sha256Text(canonicalJson(value.result));
  if (actual !== value.resultSha256) {
    throw new Error(
      `operation result cache entry result hash mismatch: expected ${value.resultSha256}, got ${actual}`,
    );
  }
  return value.result;
}

/**
 * Read the recorded result for one operation build identity. A missing entry is a
 * miss; a malformed, mismatched or symlinked entry fails closed. The returned result
 * is not trusted: the caller verifies every output object before reuse.
 */
export async function readOperationResultCache(
  root: string,
  key: string,
  buildIdentity: unknown,
): Promise<OperationResultCacheReadResult> {
  const indexPortablePath = operationResultIndexPortablePath(key);
  await assertNoSymbolicLinks(root, indexPortablePath);

  let rawEntry: string;
  try {
    rawEntry = await readFile(cachePath(root, indexPortablePath), "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) return { status: "miss", key };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEntry) as unknown;
  } catch {
    throw new Error(`operation result cache entry '${key}' is not valid JSON`);
  }
  return { status: "hit", key, result: parseOperationResultEntry(parsed, key, buildIdentity) };
}

/** Record an already verified operation result; the write is atomic per entry. */
export async function writeOperationResultCache(
  root: string,
  key: string,
  buildIdentity: unknown,
  result: unknown,
): Promise<void> {
  const indexPortablePath = operationResultIndexPortablePath(key);
  await assertNoSymbolicLinks(root, indexPortablePath);
  const entry: OperationResultCacheEntry = {
    schemaVersion: 1,
    key,
    buildIdentity,
    resultSha256: sha256Text(canonicalJson(result)),
    result,
  };
  const absolutePath = cachePath(root, indexPortablePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, stablePrettyJson(entry), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, absolutePath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Remove the entry `writeOperationResultCache` just recorded for `key`, for a run whose
 * cancellation won after the write (Atlas Decision 5.1.5). A missing entry is not an error.
 */
export async function removeOperationResultCache(root: string, key: string): Promise<void> {
  const indexPortablePath = operationResultIndexPortablePath(key);
  await assertNoSymbolicLinks(root, indexPortablePath);
  await rm(cachePath(root, indexPortablePath), { force: true });
}
