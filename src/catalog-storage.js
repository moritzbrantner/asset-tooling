import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import {
  assertAssetCatalogSourceReusable,
  createAssetCatalogSource,
  importAssetCatalogSource,
  inspectAssetCatalogSourceBytes,
} from "./catalog.js";

const STORAGE_ROOT = "assets/canonical";
const STORAGE_BACKEND = "git-lfs";
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertCatalog(catalog) {
  if (
    !catalog ||
    typeof catalog.getSource !== "function" ||
    typeof catalog.getProvider !== "function"
  ) {
    throw new Error("catalog must be created by createAssetCatalog");
  }
}

function assertPortablePath(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty portable path`);
  }
  if (value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error(`${location} must be a relative '/'-separated path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${location} must not contain empty, '.' or '..' segments`);
  }
  return value;
}

function assertRoot(root, location) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error(`${location} must be a non-empty path`);
  }
  return path.resolve(root);
}

function sourceFileName(source) {
  const locator = source.source.path ?? new URL(source.source.url).pathname;
  const portableLocator = locator.replaceAll("\\", "/");
  const filename = path.posix.basename(portableLocator);
  if (!filename || filename === "." || filename === "..") {
    throw new Error(`catalog source '${source.id}' must provide a usable file name`);
  }
  return filename;
}

function normalizeStorageDocument(catalog, value) {
  const document = assertObject(value, "catalog storage manifest");
  assertExactKeys(document, new Set(["schemaVersion", "entries"]), "catalog storage manifest");
  if (document.schemaVersion !== 1) throw new Error("catalog storage manifest schemaVersion must be 1");
  if (!Array.isArray(document.entries)) throw new Error("catalog storage manifest entries must be an array");
  return createAssetCatalogStorageManifest({ catalog, entries: document.entries });
}

function storageAbsolutePath(root, portablePath) {
  return path.join(assertRoot(root, "catalog storage root"), ...portablePath.split("/"));
}

async function assertNoSymbolicLinks(root, portablePath) {
  let prefix = assertRoot(root, "catalog storage root");
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new Error(`catalog storage path '${portablePath}' must not contain symbolic links`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isGitLfsPointer(bytes) {
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 128)).toString("utf8");
  return prefix.startsWith(LFS_POINTER_PREFIX);
}

export function canonicalAssetStoragePath(value) {
  const source = createAssetCatalogSource(value);
  return `${STORAGE_ROOT}/${source.id}/${sourceFileName(source)}`;
}

export function createAssetCatalogStorageEntry(catalog, value) {
  assertCatalog(catalog);
  const entry = assertObject(value, "catalog storage entry");
  assertExactKeys(
    entry,
    new Set(["schemaVersion", "sourceId", "storage", "path"]),
    "catalog storage entry",
  );
  if ((entry.schemaVersion ?? 1) !== 1) {
    throw new Error("catalog storage entry schemaVersion must be 1");
  }
  if (typeof entry.sourceId !== "string" || entry.sourceId.length === 0) {
    throw new Error("catalog storage entry sourceId must be a non-empty string");
  }
  if (entry.storage !== STORAGE_BACKEND) {
    throw new Error(`catalog storage entry storage must be '${STORAGE_BACKEND}'`);
  }

  const source = assertAssetCatalogSourceReusable(catalog, entry.sourceId);
  const expectedPath = canonicalAssetStoragePath(source);
  const portablePath = assertPortablePath(entry.path, "catalog storage entry path");
  if (portablePath !== expectedPath) {
    throw new Error(
      `catalog storage entry '${entry.sourceId}' path must be '${expectedPath}', got '${portablePath}'`,
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    sourceId: source.id,
    storage: STORAGE_BACKEND,
    path: portablePath,
  });
}

export function createAssetCatalogStorageManifest({ catalog, entries }) {
  assertCatalog(catalog);
  if (!Array.isArray(entries)) throw new Error("catalog storage entries must be an array");

  const normalized = entries.map((entry) => createAssetCatalogStorageEntry(catalog, entry));
  const sourceIds = normalized.map(({ sourceId }) => sourceId);
  const paths = normalized.map(({ path: entryPath }) => entryPath);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("catalog storage entries must not duplicate source ids");
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("catalog storage entries must not duplicate paths");
  }

  normalized.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return Object.freeze({
    schemaVersion: 1,
    entries: Object.freeze(normalized),
  });
}

export function resolveAssetCatalogStorageEntry(catalog, storageDocument, sourceId) {
  assertCatalog(catalog);
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new Error("catalog storage sourceId must be a non-empty string");
  }
  const manifest = normalizeStorageDocument(catalog, storageDocument);
  const entry = manifest.entries.find(({ sourceId: candidate }) => candidate === sourceId);
  if (!entry) throw new Error(`catalog source '${sourceId}' is not present in durable storage`);
  return entry;
}

export function verifyAssetCatalogStorageBytes(catalog, entryValue, bytesValue) {
  const entry = createAssetCatalogStorageEntry(catalog, entryValue);
  if (!Buffer.isBuffer(bytesValue) && !(bytesValue instanceof Uint8Array)) {
    throw new Error("catalog storage bytes must be a Buffer or Uint8Array");
  }
  const source = catalog.getSource(entry.sourceId);
  inspectAssetCatalogSourceBytes(source, Buffer.from(bytesValue));
  return entry;
}

export async function readAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot }) {
  const entry = resolveAssetCatalogStorageEntry(catalog, storage, sourceId);
  await assertNoSymbolicLinks(storageRoot, entry.path);

  let bytes;
  try {
    bytes = await readFile(storageAbsolutePath(storageRoot, entry.path));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`catalog source '${sourceId}' is missing from durable storage at '${entry.path}'`);
    }
    throw error;
  }

  if (isGitLfsPointer(bytes)) {
    throw new Error(`catalog source '${sourceId}' is not hydrated; Git LFS pointer found at '${entry.path}'`);
  }
  verifyAssetCatalogStorageBytes(catalog, entry, bytes);
  return Object.freeze({
    entry,
    source: catalog.getSource(sourceId),
    bytes,
  });
}

export async function importAssetCatalogStorageSource({
  catalog,
  storage,
  sourceId,
  storageRoot,
  objectStoreRoot,
}) {
  assertRoot(objectStoreRoot, "asset object store root");
  const stored = await readAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot });
  return importAssetCatalogSource(objectStoreRoot, catalog, sourceId, stored.bytes);
}
