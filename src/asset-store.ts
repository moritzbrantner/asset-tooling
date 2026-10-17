import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { readOperationResultCache, writeOperationResultCache } from "./cache.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationCacheKey,
  createAssetRef,
  normalizeAssetOperationResult,
  type AssetOperationBuildIdentity,
  type AssetOperationBuildIdentityInput,
  type AssetOperationDescriptor,
  type AssetOperationInvocation,
  type AssetOperationResult,
  type AssetPortMap,
  type AssetRef,
  type CanonicalJsonObject,
  type ReadonlyAssetOperationDescriptor,
} from "./operations.js";

const ASSET_OBJECT_ROOT = ".asset-tooling/objects/v1";

export interface AssetRefFromBytesOptions {
  kind: string;
  mediaType: string;
  metadata?: CanonicalJsonObject;
}

export interface StoreAssetObjectOptions extends AssetRefFromBytesOptions {
  bytes: Uint8Array;
}

export interface StoreAssetObjectFileOptions extends AssetRefFromBytesOptions {
  sourcePath: string;
}

export interface StoreAssetObjectResult {
  status: "changed" | "unchanged";
  asset: AssetRef;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("asset object store root must be a non-empty path");
  }
  return root;
}

function normalizeBytes(value: unknown, location: string): Buffer {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${location} must be a Buffer or Uint8Array`);
  }
  return Buffer.from(value);
}

async function hashFile(filePath: string): Promise<{ sha256: string; byteLength: number }> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`asset file '${filePath}' must be a regular file`);
  }
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    digest.update(bytes);
  }
  if (byteLength !== fileStat.size) {
    throw new Error(
      `asset file '${filePath}' changed while hashing: expected ${fileStat.size} bytes, read ${byteLength}`,
    );
  }
  return { sha256: digest.digest("hex"), byteLength };
}

async function assertRegularSourceFile(filePath: string): Promise<void> {
  const sourceStat = await lstat(filePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`asset source file '${filePath}' must not be a symbolic link`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`asset source file '${filePath}' must be a regular file`);
  }
}

function objectPath(root: string, portablePath: string): string {
  return path.join(assertRoot(root), ...portablePath.split("/"));
}

async function assertNoSymbolicLinks(root: string, portablePath: string): Promise<void> {
  let prefix = assertRoot(root);
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new Error(`asset object path '${portablePath}' must not contain symbolic links`);
      }
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function assertAssetBytes(asset: AssetRef, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.byteLength) {
    throw new Error(
      `asset object '${asset.sha256}' byte length mismatch: expected ${asset.byteLength}, got ${bytes.byteLength}`,
    );
  }
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== asset.sha256) {
    throw new Error(
      `asset object '${asset.sha256}' hash mismatch: expected ${asset.sha256}, got ${actualSha256}`,
    );
  }
}

async function verifyStoredObject(
  root: string,
  asset: AssetRef,
  portablePath: string,
): Promise<void> {
  const absolutePath = objectPath(root, portablePath);
  let actual: { sha256: string; byteLength: number };
  try {
    actual = await hashFile(absolutePath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`asset object '${asset.sha256}' is missing`);
    }
    throw error;
  }
  if (actual.byteLength !== asset.byteLength) {
    throw new Error(
      `asset object '${asset.sha256}' byte length mismatch: expected ${asset.byteLength}, got ${actual.byteLength}`,
    );
  }
  if (actual.sha256 !== asset.sha256) {
    throw new Error(
      `asset object '${asset.sha256}' hash mismatch: expected ${asset.sha256}, got ${actual.sha256}`,
    );
  }
}

async function readStoredObject(
  root: string,
  asset: AssetRef,
  portablePath: string,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(objectPath(root, portablePath));
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`asset object '${asset.sha256}' is missing`);
    }
    throw error;
  }
  assertAssetBytes(asset, bytes);
  return bytes;
}

export function createAssetRefFromBytes(
  bytesValue: Uint8Array,
  { kind, mediaType, metadata = {} }: AssetRefFromBytesOptions,
): AssetRef {
  const bytes = normalizeBytes(bytesValue, "asset bytes");
  return createAssetRef({
    schemaVersion: 1,
    kind,
    mediaType,
    sha256: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
    metadata,
  });
}

export function assetObjectPortablePath(value: unknown): string {
  const asset = createAssetRef(value);
  return `${ASSET_OBJECT_ROOT}/sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`;
}

export async function storeAssetObject(
  root: string,
  { bytes: bytesValue, kind, mediaType, metadata = {} }: StoreAssetObjectOptions,
): Promise<StoreAssetObjectResult> {
  const bytes = normalizeBytes(bytesValue, "asset bytes");
  const asset = createAssetRefFromBytes(bytes, { kind, mediaType, metadata });
  const portablePath = assetObjectPortablePath(asset);
  await assertNoSymbolicLinks(root, portablePath);

  const absolutePath = objectPath(root, portablePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  try {
    const existing = await readFile(absolutePath);
    assertAssetBytes(asset, existing);
    return { status: "unchanged", asset };
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  try {
    await writeFile(absolutePath, bytes, { flag: "wx" });
    return { status: "changed", asset };
  } catch (error: unknown) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }

  const existing = await readStoredObject(root, asset, portablePath);
  assertAssetBytes(asset, existing);
  return { status: "unchanged", asset };
}

export async function storeAssetObjectFile(
  root: string,
  { sourcePath, kind, mediaType, metadata = {} }: StoreAssetObjectFileOptions,
): Promise<StoreAssetObjectResult> {
  await assertRegularSourceFile(sourcePath);
  const identity = await hashFile(sourcePath);
  const asset = createAssetRef({
    schemaVersion: 1,
    kind,
    mediaType,
    sha256: identity.sha256,
    byteLength: identity.byteLength,
    metadata,
  });
  const portablePath = assetObjectPortablePath(asset);
  await assertNoSymbolicLinks(root, portablePath);
  const absolutePath = objectPath(root, portablePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  try {
    await stat(absolutePath);
    await verifyStoredObject(root, asset, portablePath);
    return { status: "unchanged", asset };
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  try {
    await copyFile(sourcePath, absolutePath, constants.COPYFILE_EXCL);
    await verifyStoredObject(root, asset, portablePath);
    return { status: "changed", asset };
  } catch (error: unknown) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }

  await verifyStoredObject(root, asset, portablePath);
  return { status: "unchanged", asset };
}

export async function verifyAssetObject(root: string, value: unknown): Promise<AssetRef> {
  const asset = createAssetRef(value);
  const portablePath = assetObjectPortablePath(asset);
  await assertNoSymbolicLinks(root, portablePath);
  await verifyStoredObject(root, asset, portablePath);
  return asset;
}

export async function resolveAssetObject(root: string, value: unknown): Promise<Buffer> {
  const asset = createAssetRef(value);
  const portablePath = assetObjectPortablePath(asset);
  await assertNoSymbolicLinks(root, portablePath);
  return readStoredObject(root, asset, portablePath);
}

/**
 * Output-affecting implementation identity, exactly what
 * `createAssetOperationBuildIdentity` takes as `implementation`: a required `id`
 * and `version` plus any tool, algorithm, model, runtime or reproducibility identity.
 */
export type AssetOperationImplementationIdentity =
  | { readonly id: string; readonly version: string; readonly [key: string]: unknown }
  | CanonicalJsonObject;

/** The invocation the runner hands to an executor: canonical parameters and verified inputs. */
export interface AssetOperationExecutorInvocation {
  parameters: CanonicalJsonObject;
  inputs: AssetPortMap;
}

/**
 * What `runAssetOperation` tells an executor about the run: the build identity and cache key the
 * result will be recorded under. An executor that re-derives its implementation identity (for
 * example by probing a runtime environment) can compare and fail closed instead of recording a
 * result under a key that no longer describes it.
 */
export interface AssetOperationRunContext {
  buildIdentity: AssetOperationBuildIdentity;
  cacheKey: string;
}

/** Execution context `runAssetOperation` passes to `execute` when the caller gave a signal. */
export interface AssetOperationExecutionContext {
  /** Aborts when the caller cancels the run; executors that support cancellation observe it. */
  signal?: AbortSignal;
}

export interface RunAssetOperationOptions {
  /**
   * Cancels the run (Atlas Decision 5.1.5). An already-aborted signal rejects before `execute`;
   * a signal aborted by the time `execute` settles rejects with an `AbortError` and caches nothing.
   */
  signal?: AbortSignal;
}

export interface AssetOperationRunRegistration {
  descriptor: AssetOperationDescriptor | ReadonlyAssetOperationDescriptor;
  implementation: AssetOperationImplementationIdentity;
  /**
   * Optional pre-lookup check of declared dependencies that are not input ports (for example a
   * hash-pinned local model file). `runAssetOperation` calls it after verifying the inputs and
   * before the cache lookup, on hits and misses alike; a rejection fails the run without
   * reusing or recording a result. Without it, the run behaves exactly as before.
   */
  verifyDependencies?(root: string, invocation: AssetOperationExecutorInvocation): Promise<void>;
  /**
   * `context` is the caller's execution context: `runAssetOperation` passes `{ signal }` (the
   * signal is undefined when the caller gave none), the workflow executor passes the runner
   * context, which carries the runner's `signal`. `run` carries the prepared identity. Executors
   * may ignore both.
   */
  execute(
    root: string,
    invocation: AssetOperationExecutorInvocation,
    context?: AssetOperationExecutionContext | unknown,
    run?: AssetOperationRunContext,
  ): Promise<AssetOperationResult>;
}

export interface AssetOperationRun {
  status: "hit" | "miss";
  cacheKey: string;
  buildIdentity: AssetOperationBuildIdentity;
  result: AssetOperationResult;
}

function portRefs(ports: AssetPortMap): AssetRef[] {
  return Object.values(ports).flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function unusableCacheEntry(cacheKey: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `operation result cache entry '${cacheKey}' is unusable (delete .asset-tooling/cache to re-execute): ${reason}`,
  );
}

/**
 * Run one asset operation and reuse its recorded result when the operation build
 * identity is unchanged.
 *
 * Every input object, and any declared dependency through `verifyDependencies`, is verified
 * before the lookup. A hit verifies every recorded
 * output object and does not call `execute`. A miss executes, verifies the stored
 * outputs, and records the result under `.asset-tooling/cache`. A corrupt entry or
 * output object rejects instead of being reused. The entry is acceleration state,
 * not provenance evidence.
 */
function throwIfRunCancelled(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}

export async function runAssetOperation(
  root: string,
  registration: AssetOperationRunRegistration,
  { parameters = {}, inputs = {} }: AssetOperationInvocation = {},
  { signal }: RunAssetOperationOptions = {},
): Promise<AssetOperationRun> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error("runAssetOperation signal must be an AbortSignal when provided");
  }
  throwIfRunCancelled(signal, "cancelled before the asset operation started; nothing was executed or cached");
  const assetRoot = assertRoot(root);
  const identityInput: AssetOperationBuildIdentityInput = {
    operation: registration.descriptor,
    implementation: registration.implementation,
    parameters,
    inputs,
  };
  const buildIdentity = createAssetOperationBuildIdentity(identityInput);
  const cacheKey = createAssetOperationCacheKey(identityInput);

  for (const asset of portRefs(buildIdentity.inputs)) await verifyAssetObject(assetRoot, asset);
  if (registration.verifyDependencies !== undefined) {
    await registration.verifyDependencies(assetRoot, {
      parameters: structuredClone(buildIdentity.parameters),
      inputs: structuredClone(buildIdentity.inputs),
    });
  }

  const cached = await readOperationResultCache(assetRoot, cacheKey, buildIdentity).catch((error: unknown) => {
    throw unusableCacheEntry(cacheKey, error);
  });
  if (cached.status === "hit") {
    let result: AssetOperationResult;
    try {
      result = normalizeAssetOperationResult(registration.descriptor, cached.result);
      for (const asset of portRefs(result.outputs)) await verifyAssetObject(assetRoot, asset);
    } catch (error: unknown) {
      throw unusableCacheEntry(cacheKey, error);
    }
    return { status: "hit", cacheKey, buildIdentity, result };
  }

  const executed = await registration.execute(
    assetRoot,
    {
      parameters: structuredClone(buildIdentity.parameters),
      inputs: structuredClone(buildIdentity.inputs),
    },
    { signal },
    { buildIdentity: structuredClone(buildIdentity), cacheKey },
  );
  // The cancel wins a completion race: a result that arrives after the abort is never cached.
  throwIfRunCancelled(signal, "cancelled while the asset operation ran; its result was not cached");
  const result = normalizeAssetOperationResult(registration.descriptor, executed);
  for (const asset of portRefs(result.outputs)) await verifyAssetObject(assetRoot, asset);
  await writeOperationResultCache(assetRoot, cacheKey, buildIdentity, result);
  return { status: "miss", cacheKey, buildIdentity, result };
}
