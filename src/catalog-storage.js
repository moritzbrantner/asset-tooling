import path from "node:path";
import {
  assertAssetCatalogSourceReusable,
  createAssetCatalogSource,
  inspectAssetCatalogSourceBytes,
} from "./catalog.js";

const STORAGE_ROOT = "assets/canonical";
const STORAGE_BACKEND = "git-lfs";

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

function sourceFileName(source) {
  const locator = source.source.path ?? new URL(source.source.url).pathname;
  const portableLocator = locator.replaceAll("\\", "/");
  const filename = path.posix.basename(portableLocator);
  if (!filename || filename === "." || filename === "..") {
    throw new Error(`catalog source '${source.id}' must provide a usable file name`);
  }
  return filename;
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

export function verifyAssetCatalogStorageBytes(catalog, entryValue, bytesValue) {
  const entry = createAssetCatalogStorageEntry(catalog, entryValue);
  if (!Buffer.isBuffer(bytesValue) && !(bytesValue instanceof Uint8Array)) {
    throw new Error("catalog storage bytes must be a Buffer or Uint8Array");
  }
  const source = catalog.getSource(entry.sourceId);
  inspectAssetCatalogSourceBytes(source, Buffer.from(bytesValue));
  return entry;
}
