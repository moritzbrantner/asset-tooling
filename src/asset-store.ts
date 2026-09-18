import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { sha256Bytes } from "./hash.js";
import {
  createAssetRef,
  type AssetRef,
  type CanonicalJsonObject,
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
    await verifyStoredObject(root, asset, portablePath);
    return { status: "unchanged", asset };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.includes(" is missing")) throw error;
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
