import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { acquireAssetCatalogSource } from "./catalog-acquisition.js";
import { createAssetCatalog } from "./catalog.js";
import {
  canonicalAssetStoragePath,
  createAssetCatalogStorageManifest,
  verifyAssetCatalogStorageBytes,
} from "./catalog-storage.js";

function documentEntries(document, key, location) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`${location} must be an object`);
  }
  if (document.schemaVersion !== 1 || !Array.isArray(document[key])) {
    throw new Error(`${location} must contain schemaVersion 1 and an '${key}' array`);
  }
  return document[key];
}

function portableAbsolutePath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readOptional(pathname) {
  try {
    return await readFile(pathname);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function prepareAssetCatalogLfsPromotion({
  providersDocument,
  sourcesDocument,
  storageDocument,
  sourceId,
  repositoryRoot,
  fetchImpl = fetch,
}) {
  const providers = documentEntries(providersDocument, "providers", "catalog/providers.json");
  const sources = documentEntries(sourcesDocument, "sources", "catalog/sources.json");
  const storageEntries = documentEntries(storageDocument, "entries", "catalog/storage.json");
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new Error("repositoryRoot must be a non-empty path");
  }

  const catalog = createAssetCatalog({ providers, sources });
  const acquisition = await acquireAssetCatalogSource({
    catalog,
    sourceId,
    destinationRoot: path.join(repositoryRoot, ".artifacts", "catalog-lfs-promotion"),
    fetchImpl,
  });
  const bytes = await readFile(acquisition.filePath);
  const pinnedSource = JSON.parse(await readFile(acquisition.pinPath, "utf8"));
  const sourceIndex = sources.findIndex(({ id }) => id === sourceId);
  if (sourceIndex < 0) throw new Error(`catalog source '${sourceId}' is not registered`);

  const updatedSources = [...sources];
  updatedSources[sourceIndex] = pinnedSource;
  const updatedSourcesDocument = { ...sourcesDocument, sources: updatedSources };
  const updatedCatalog = createAssetCatalog({ providers, sources: updatedSources });
  const relativePath = canonicalAssetStoragePath(pinnedSource);

  const existingStorageEntry = storageEntries.find((entry) => entry.sourceId === sourceId);
  if (existingStorageEntry && existingStorageEntry.path !== relativePath) {
    throw new Error(
      `catalog storage entry '${sourceId}' already uses '${existingStorageEntry.path}' and cannot move implicitly to '${relativePath}'`,
    );
  }

  const storageEntry = {
    schemaVersion: 1,
    sourceId,
    storage: "git-lfs",
    path: relativePath,
  };
  const nextStorageEntries = [
    ...storageEntries.filter((entry) => entry.sourceId !== sourceId),
    storageEntry,
  ];
  const updatedStorageDocument = createAssetCatalogStorageManifest({
    catalog: updatedCatalog,
    entries: nextStorageEntries,
  });
  verifyAssetCatalogStorageBytes(updatedCatalog, storageEntry, bytes);

  return Object.freeze({
    sourceId,
    relativePath,
    sha256: pinnedSource.source.sha256,
    byteLength: pinnedSource.source.byteLength,
    bytes,
    sourcesDocument: updatedSourcesDocument,
    storageDocument: updatedStorageDocument,
  });
}

export async function applyAssetCatalogLfsPromotion(options) {
  const prepared = await prepareAssetCatalogLfsPromotion(options);
  const root = path.resolve(options.repositoryRoot);
  const assetPath = portableAbsolutePath(root, prepared.relativePath);
  const sourcesPath = path.join(root, "catalog", "sources.json");
  const storagePath = path.join(root, "catalog", "storage.json");

  const existingBytes = await readOptional(assetPath);
  if (existingBytes !== null) {
    const catalog = createAssetCatalog({
      providers: documentEntries(options.providersDocument, "providers", "catalog/providers.json"),
      sources: prepared.sourcesDocument.sources,
    });
    verifyAssetCatalogStorageBytes(
      catalog,
      prepared.storageDocument.entries.find(({ sourceId }) => sourceId === prepared.sourceId),
      existingBytes,
    );
  }

  const nextSources = Buffer.from(prettyJson(prepared.sourcesDocument), "utf8");
  const nextStorage = Buffer.from(prettyJson(prepared.storageDocument), "utf8");
  const existingSources = await readOptional(sourcesPath);
  const existingStorage = await readOptional(storagePath);
  const assetChanged = existingBytes === null;
  const sourcesChanged = existingSources === null || !existingSources.equals(nextSources);
  const storageChanged = existingStorage === null || !existingStorage.equals(nextStorage);

  if (assetChanged) {
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, prepared.bytes, { flag: "wx" });
  }
  if (sourcesChanged) await writeFile(sourcesPath, nextSources);
  if (storageChanged) await writeFile(storagePath, nextStorage);

  return Object.freeze({
    status: assetChanged || sourcesChanged || storageChanged ? "changed" : "unchanged",
    sourceId: prepared.sourceId,
    path: prepared.relativePath,
    sha256: prepared.sha256,
    byteLength: prepared.byteLength,
  });
}
