import path from "node:path";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
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

/**
 * Where generation-cache entries live: `<root>/.asset-tooling/cache/v1/` by default, or `<directory>/v1/` for a
 * shared cache directory that several builds and CI runs reuse (docs/cache.md#shared-cache-directory).
 */
export interface GenerationCacheOptions {
  directory?: string;
}

interface GenerationCacheLocation {
  base: string;
  prefix: string;
}

function generationCacheLocation(root: string, options: GenerationCacheOptions = {}): GenerationCacheLocation {
  if (options.directory === undefined) return { base: root, prefix: CACHE_VERSION_ROOT };
  if (!path.isAbsolute(options.directory)) throw new Error("generation cache directory must be an absolute path");
  return { base: options.directory, prefix: "v1" };
}

function buildIndexPortablePath(location: GenerationCacheLocation, key: string): string {
  return `${location.prefix}/builds/${key}.json`;
}

function blobPortablePath(location: GenerationCacheLocation, outputSha256: string): string {
  return `${location.prefix}/blobs/${outputSha256}`;
}

/** Write through a unique temporary file and rename, so a concurrent reader never sees a partial entry. */
async function writeAtomically(absolutePath: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, absolutePath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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
  options: GenerationCacheOptions = {},
): Promise<GenerationCacheReadResult> {
  const location = generationCacheLocation(root, options);
  const key = generationCacheKey(identity);
  const indexPortablePath = buildIndexPortablePath(location, key);
  await assertNoSymbolicLinks(location.base, indexPortablePath);

  let rawIndex: string;
  try {
    rawIndex = await readFile(cachePath(location.base, indexPortablePath), "utf8");
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
  const blobPath = blobPortablePath(location, index.outputSha256);
  await assertNoSymbolicLinks(location.base, blobPath);

  let bytes: Buffer;
  try {
    bytes = await readFile(cachePath(location.base, blobPath));
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
  // Mark the entry used, so pruneGenerationCache keeps what the latest build read.
  const now = new Date();
  await utimes(cachePath(location.base, indexPortablePath), now, now);

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
  options: GenerationCacheOptions = {},
): Promise<GenerationCacheWriteResult> {
  const location = generationCacheLocation(root, options);
  const key = generationCacheKey(identity);
  const outputSha256 = sha256Bytes(generated.bytes);
  const blobPath = blobPortablePath(location, outputSha256);
  const indexPath = buildIndexPortablePath(location, key);
  await assertNoSymbolicLinks(location.base, blobPath);
  await assertNoSymbolicLinks(location.base, indexPath);

  const blobAbsolutePath = cachePath(location.base, blobPath);
  let blobMatches = false;
  try {
    blobMatches = sha256Bytes(await readFile(blobAbsolutePath)) === outputSha256;
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  if (!blobMatches) await writeAtomically(blobAbsolutePath, generated.bytes);

  const index: GenerationCacheIndex = {
    schemaVersion: 1,
    key,
    identity,
    outputSha256,
    observations: generated.observations,
  };
  await writeAtomically(cachePath(location.base, indexPath), stablePrettyJson(index));

  return { key, outputSha256 };
}

export interface GenerationCachePruneResult {
  keptBuilds: number;
  removedBuilds: number;
  keptOperations: number;
  removedOperations: number;
  removedBlobs: number;
  remainingBytes: number;
}

/**
 * Drop the shared generation cache `directory`'s build and operation result entries not read or written since `since`
 * (a hit touches its entry), then every blob no remaining entry names, so a cache CI saves between runs holds only what
 * the latest build used. Pruning only ever removes disposable acceleration state.
 */
export async function pruneGenerationCache(directory: string, since: Date): Promise<GenerationCachePruneResult> {
  const location = generationCacheLocation(directory, { directory });
  const buildsDirectory = cachePath(location.base, `${location.prefix}/builds`);
  const blobsDirectory = cachePath(location.base, `${location.prefix}/blobs`);
  const list = async (directoryPath: string) => {
    try {
      return await readdir(directoryPath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  };
  const result: GenerationCachePruneResult = { keptBuilds: 0, removedBuilds: 0, keptOperations: 0, removedOperations: 0, removedBlobs: 0, remainingBytes: 0 };
  const referenced = new Set<string>();
  for (const name of await list(buildsDirectory)) {
    const entryPath = path.join(buildsDirectory, name);
    const entry = await lstat(entryPath);
    let outputSha256: unknown;
    if (entry.isFile() && name.endsWith(".json") && entry.mtimeMs >= since.getTime()) {
      try {
        outputSha256 = (JSON.parse(await readFile(entryPath, "utf8")) as PlainObject).outputSha256;
      } catch {
        outputSha256 = undefined;
      }
    }
    if (typeof outputSha256 === "string" && SHA256_PATTERN.test(outputSha256)) {
      referenced.add(outputSha256);
      result.keptBuilds += 1;
      result.remainingBytes += entry.size;
    } else {
      await rm(entryPath, { force: true });
      result.removedBuilds += 1;
    }
  }
  // Operation result entries (runAssetOperation with a shared directory) name their output objects' blobs.
  const operationsDirectory = cachePath(location.base, `${location.prefix}/operations`);
  for (const name of await list(operationsDirectory)) {
    const entryPath = path.join(operationsDirectory, name);
    const entry = await lstat(entryPath);
    let outputs: string[] | undefined;
    if (entry.isFile() && name.endsWith(".json") && entry.mtimeMs >= since.getTime()) {
      try {
        const result = (JSON.parse(await readFile(entryPath, "utf8")) as PlainObject).result as PlainObject;
        outputs = Object.values(result.outputs as PlainObject).flat()
          .map((asset) => (asset as PlainObject).sha256)
          .filter((sha256): sha256 is string => typeof sha256 === "string" && SHA256_PATTERN.test(sha256));
      } catch {
        outputs = undefined;
      }
    }
    if (outputs) {
      for (const sha256 of outputs) referenced.add(sha256);
      result.keptOperations += 1;
      result.remainingBytes += entry.size;
    } else {
      await rm(entryPath, { force: true });
      result.removedOperations += 1;
    }
  }
  for (const name of await list(blobsDirectory)) {
    const blobPath = path.join(blobsDirectory, name);
    const blob = await lstat(blobPath);
    if (blob.isFile() && referenced.has(name)) {
      result.remainingBytes += blob.size;
    } else {
      await rm(blobPath, { force: true });
      result.removedBlobs += 1;
    }
  }
  return result;
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

function operationResultIndexPortablePath(key: string, location: GenerationCacheLocation): string {
  if (!SHA256_PATTERN.test(key)) {
    throw new Error("operation result cache key must be a lowercase SHA-256 digest");
  }
  return `${location.prefix}/operations/${key}.json`;
}

/**
 * Where operation result entries live: under `root` (`.asset-tooling/cache/v1/operations/`) by default, or in a
 * shared cache directory (`<directory>/v1/operations/`), whose `v1/blobs/` then also holds the output bytes, so a
 * build into a fresh object store can reuse them (docs/cache.md#operation-result-entries).
 */
export interface OperationResultCacheOptions {
  directory?: string;
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
 * is not trusted: the caller verifies every output object before reuse. A hit in a shared
 * directory touches the entry, so `pruneGenerationCache` keeps what the latest build read.
 */
export async function readOperationResultCache(
  root: string,
  key: string,
  buildIdentity: unknown,
  options: OperationResultCacheOptions = {},
): Promise<OperationResultCacheReadResult> {
  const location = generationCacheLocation(root, options);
  const indexPortablePath = operationResultIndexPortablePath(key, location);
  await assertNoSymbolicLinks(location.base, indexPortablePath);

  let rawEntry: string;
  try {
    rawEntry = await readFile(cachePath(location.base, indexPortablePath), "utf8");
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
  const result = parseOperationResultEntry(parsed, key, buildIdentity);
  if (options.directory !== undefined) {
    const now = new Date();
    await utimes(cachePath(location.base, indexPortablePath), now, now);
  }
  return { status: "hit", key, result };
}

/** Record an already verified operation result; the write is atomic per entry. */
export async function writeOperationResultCache(
  root: string,
  key: string,
  buildIdentity: unknown,
  result: unknown,
  options: OperationResultCacheOptions = {},
): Promise<void> {
  const location = generationCacheLocation(root, options);
  const indexPortablePath = operationResultIndexPortablePath(key, location);
  await assertNoSymbolicLinks(location.base, indexPortablePath);
  const entry: OperationResultCacheEntry = {
    schemaVersion: 1,
    key,
    buildIdentity,
    resultSha256: sha256Text(canonicalJson(result)),
    result,
  };
  await writeAtomically(cachePath(location.base, indexPortablePath), stablePrettyJson(entry));
}

/**
 * Remove the entry `writeOperationResultCache` just recorded for `key`, for a run whose
 * cancellation won after the write (Atlas Decision 5.1.5). A missing entry is not an error.
 */
export async function removeOperationResultCache(root: string, key: string, options: OperationResultCacheOptions = {}): Promise<void> {
  const location = generationCacheLocation(root, options);
  const indexPortablePath = operationResultIndexPortablePath(key, location);
  await assertNoSymbolicLinks(location.base, indexPortablePath);
  await rm(cachePath(location.base, indexPortablePath), { force: true });
}

/** The absolute path of a shared cache directory's blob for `sha256` (`<directory>/v1/blobs/<sha256>`). */
export async function sharedCacheBlobPath(directory: string, sha256: string): Promise<string> {
  if (!SHA256_PATTERN.test(sha256)) throw new Error("cache blob name must be a lowercase SHA-256 digest");
  const location = generationCacheLocation(directory, { directory });
  const portablePath = blobPortablePath(location, sha256);
  await assertNoSymbolicLinks(location.base, portablePath);
  return cachePath(location.base, portablePath);
}

/**
 * Put the file at `sourcePath`, whose bytes the caller verified as `sha256`, into a shared cache directory's blobs: a
 * hard link when both are on one file system, otherwise a copy, renamed into place. An existing blob is kept (a reader
 * verifies its hash before use).
 */
export async function storeSharedCacheBlob(directory: string, sha256: string, sourcePath: string): Promise<void> {
  const target = await sharedCacheBlobPath(directory, sha256);
  try {
    await lstat(target);
    return;
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    try {
      await link(sourcePath, temporaryPath);
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EXDEV") && !hasErrorCode(error, "EPERM")) throw error;
      await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    }
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
