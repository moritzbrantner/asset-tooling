import path from "node:path";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { sha256Bytes } from "./hash.js";
import { createAssetRef } from "./operations.js";

const ASSET_OBJECT_ROOT = ".asset-tooling/objects/v1";

function assertRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("asset object store root must be a non-empty path");
  }
  return root;
}

function normalizeBytes(value, location) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${location} must be a Buffer or Uint8Array`);
  }
  return Buffer.from(value);
}

function objectPath(root, portablePath) {
  return path.join(assertRoot(root), ...portablePath.split("/"));
}

async function assertNoSymbolicLinks(root, portablePath) {
  let prefix = assertRoot(root);
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new Error(`asset object path '${portablePath}' must not contain symbolic links`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function assertAssetBytes(asset, bytes) {
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

async function readStoredObject(root, asset, portablePath) {
  let bytes;
  try {
    bytes = await readFile(objectPath(root, portablePath));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`asset object '${asset.sha256}' is missing`);
    }
    throw error;
  }
  assertAssetBytes(asset, bytes);
  return bytes;
}

export function createAssetRefFromBytes(bytesValue, { kind, mediaType, metadata = {} }) {
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

export function assetObjectPortablePath(value) {
  const asset = createAssetRef(value);
  return `${ASSET_OBJECT_ROOT}/sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`;
}

export async function storeAssetObject(root, { bytes: bytesValue, kind, mediaType, metadata = {} }) {
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
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  try {
    await writeFile(absolutePath, bytes, { flag: "wx" });
    return { status: "changed", asset };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }

  const existing = await readStoredObject(root, asset, portablePath);
  assertAssetBytes(asset, existing);
  return { status: "unchanged", asset };
}

export async function resolveAssetObject(root, value) {
  const asset = createAssetRef(value);
  const portablePath = assetObjectPortablePath(asset);
  await assertNoSymbolicLinks(root, portablePath);
  return readStoredObject(root, asset, portablePath);
}
